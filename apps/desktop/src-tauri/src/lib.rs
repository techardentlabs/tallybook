use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{params, params_from_iter, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Manager, State};

const WRONG_PASSWORD: &str = "Incorrect TallyVault password";
const LOCKED: &str = "The company data is locked. Enter the TallyVault password first.";
const SQLITE_HEADER: &[u8; 16] = b"SQLite format 3\0";
const NO_COMPANY: &str = "No company is open";
const LEGACY_FILE: &str = "tallybook.db";
const INDEX_FILE: &str = "companies.json";
const COMPANY_DIR: &str = "companies";

struct Inner {
    path: Option<PathBuf>,
    conn: Option<Connection>,
    encrypted: bool,
}

struct Db {
    root: PathBuf,
    inner: Mutex<Inner>,
}

#[derive(Serialize)]
struct CompanyIndexFile {
    text: Option<String>,
    legacy: bool,
    files: Vec<String>,
    root: String,
}

#[derive(Deserialize)]
struct Stmt {
    sql: String,
    params: Vec<Value>,
}

#[derive(Serialize)]
struct VaultStatus {
    encrypted: bool,
    open: bool,
}

fn valid_company_file(file: &str) -> bool {
    if file == LEGACY_FILE {
        return true;
    }
    let Some(rest) = file.strip_prefix("companies/") else {
        return false;
    };
    let Some(num) = rest.strip_suffix(".db") else {
        return false;
    };
    !num.is_empty() && num.len() <= 12 && num.bytes().all(|b| b.is_ascii_digit())
}

fn company_path(root: &Path, file: &str) -> Result<PathBuf, String> {
    if !valid_company_file(file) {
        return Err("The company data file name is not valid".into());
    }
    let mut p = root.to_path_buf();
    for part in file.split('/') {
        p.push(part);
    }
    Ok(p)
}

fn company_files(root: &Path) -> Vec<String> {
    let Ok(rd) = fs::read_dir(root.join(COMPANY_DIR)) else {
        return Vec::new();
    };
    let mut out: Vec<String> = rd
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().to_str().map(|n| format!("{COMPANY_DIR}/{n}")))
        .filter(|f| valid_company_file(f))
        .collect();
    out.sort();
    out
}

fn to_sql(v: &Value) -> Result<SqlValue, String> {
    Ok(match v {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(*b as i64),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                SqlValue::Integer(i)
            } else if let Some(f) = n.as_f64() {
                SqlValue::Real(f)
            } else {
                return Err("unsupported number".into());
            }
        }
        Value::String(s) => SqlValue::Text(s.clone()),
        _ => return Err("unsupported parameter type".into()),
    })
}

fn bind(params: &[Value]) -> Result<Vec<SqlValue>, String> {
    params.iter().map(to_sql).collect()
}

fn file_is_encrypted(path: &Path) -> Result<bool, String> {
    let mut f = match fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e.to_string()),
    };
    let mut head = [0u8; 16];
    let mut n = 0;
    while n < head.len() {
        match f.read(&mut head[n..]) {
            Ok(0) => break,
            Ok(k) => n += k,
            Err(e) => return Err(e.to_string()),
        }
    }
    if n == 0 {
        return Ok(false);
    }
    Ok(n < head.len() || &head != SQLITE_HEADER)
}

fn open_conn(path: &Path, key: Option<&str>) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    if let Some(k) = key {
        if k.is_empty() {
            return Err(WRONG_PASSWORD.into());
        }
        conn.pragma_update(None, "key", k).map_err(|_| WRONG_PASSWORD.to_string())?;
    }
    conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get::<_, i64>(0))
        .map_err(|e| if key.is_some() { WRONG_PASSWORD.to_string() } else { e.to_string() })?;
    conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")
        .map_err(|e| e.to_string())?;
    Ok(conn)
}

fn key_matches(path: &Path, key: &str) -> bool {
    if key.is_empty() {
        return false;
    }
    let Ok(conn) = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX) else {
        return false;
    };
    if conn.pragma_update(None, "key", key).is_err() {
        return false;
    }
    conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get::<_, i64>(0)).is_ok()
}

fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}

fn remove_sidecars(path: &Path) {
    for suffix in ["-wal", "-shm", "-journal"] {
        let _ = fs::remove_file(sidecar(path, suffix));
    }
}

fn export_to(conn: &Connection, dest: &Path, key: &str) -> Result<(), String> {
    let dest_s = dest.to_str().ok_or_else(|| "The data folder path is not supported".to_string())?;
    conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(())).map_err(|e| e.to_string())?;
    conn.execute_batch("PRAGMA foreign_keys = OFF;").map_err(|e| e.to_string())?;
    let result = (|| -> rusqlite::Result<()> {
        conn.execute("ATTACH DATABASE ?1 AS vault_export KEY ?2", params![dest_s, key])?;
        let exported = conn.query_row("SELECT sqlcipher_export('vault_export')", [], |_| Ok(()));
        let version = conn.query_row("PRAGMA main.user_version", [], |r| r.get::<_, i64>(0));
        let stamped = match (&exported, version) {
            (Ok(()), Ok(v)) => conn.execute_batch(&format!("PRAGMA vault_export.user_version = {v};")),
            _ => Ok(()),
        };
        let detached = conn.execute("DETACH DATABASE vault_export", []);
        exported?;
        stamped?;
        detached?;
        Ok(())
    })();
    let _ = conn.execute_batch("PRAGMA foreign_keys = ON;");
    result.map_err(|e| e.to_string())
}

#[tauri::command]
fn db_select(state: State<Db>, sql: String, params: Vec<Value>) -> Result<Vec<Map<String, Value>>, String> {
    let guard = state.inner.lock().map_err(|e| e.to_string())?;
    let conn = guard.conn.as_ref().ok_or_else(|| LOCKED.to_string())?;
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let args = bind(&params)?;
    let mut rows = stmt.query(params_from_iter(args.iter())).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let mut map = Map::new();
        for (i, name) in names.iter().enumerate() {
            let v = match row.get_ref(i).map_err(|e| e.to_string())? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(n) => Value::Number(n.into()),
                ValueRef::Real(f) => Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null),
                ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
                ValueRef::Blob(_) => Value::Null,
            };
            map.insert(name.clone(), v);
        }
        out.push(map);
    }
    Ok(out)
}

#[tauri::command]
fn db_batch(state: State<Db>, stmts: Vec<Stmt>) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    let conn = guard.conn.as_mut().ok_or_else(|| LOCKED.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for s in &stmts {
        let args = bind(&s.params)?;
        tx.execute(&s.sql, params_from_iter(args.iter())).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

#[tauri::command]
fn db_vault_status(state: State<Db>) -> Result<VaultStatus, String> {
    let guard = state.inner.lock().map_err(|e| e.to_string())?;
    Ok(VaultStatus { encrypted: guard.encrypted, open: guard.conn.is_some() })
}

#[tauri::command]
fn db_unlock(state: State<Db>, password: String) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    if guard.conn.is_some() {
        let path = guard.path.clone().ok_or_else(|| NO_COMPANY.to_string())?;
        return if !guard.encrypted || key_matches(&path, &password) { Ok(()) } else { Err(WRONG_PASSWORD.into()) };
    }
    let path = guard.path.clone().ok_or_else(|| NO_COMPANY.to_string())?;
    let conn = if guard.encrypted { open_conn(&path, Some(&password))? } else { open_conn(&path, None)? };
    guard.conn = Some(conn);
    Ok(())
}

#[tauri::command]
fn db_vault_verify(state: State<Db>, password: String) -> Result<bool, String> {
    let guard = state.inner.lock().map_err(|e| e.to_string())?;
    if !guard.encrypted {
        return Ok(false);
    }
    let path = guard.path.clone().ok_or_else(|| NO_COMPANY.to_string())?;
    Ok(key_matches(&path, &password))
}

#[tauri::command]
fn db_vault_set(state: State<Db>, current: String, password: String) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    if guard.conn.is_none() {
        return Err(LOCKED.into());
    }
    let path = guard.path.clone().ok_or_else(|| NO_COMPANY.to_string())?;
    let was_encrypted = guard.encrypted;
    if was_encrypted && !key_matches(&path, &current) {
        return Err(WRONG_PASSWORD.into());
    }
    if !was_encrypted && password.is_empty() {
        return Ok(());
    }
    let tmp = sidecar(&path, ".vault-tmp");
    let _ = fs::remove_file(&tmp);
    remove_sidecars(&tmp);
    if let Err(e) = export_to(guard.conn.as_ref().unwrap(), &tmp, &password) {
        let _ = fs::remove_file(&tmp);
        remove_sidecars(&tmp);
        return Err(e);
    }
    let reopen_old = |g: &mut Inner| -> Result<(), String> {
        g.conn = Some(open_conn(&path, if was_encrypted { Some(current.as_str()) } else { None })?);
        Ok(())
    };
    let old = guard.conn.take().unwrap();
    if let Err((conn, e)) = old.close() {
        guard.conn = Some(conn);
        let _ = fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    if let Err(e) = fs::rename(&tmp, &path) {
        let _ = fs::remove_file(&tmp);
        reopen_old(&mut guard)?;
        return Err(e.to_string());
    }
    remove_sidecars(&path);
    let next = if password.is_empty() { None } else { Some(password.as_str()) };
    guard.encrypted = next.is_some();
    guard.conn = Some(open_conn(&path, next)?);
    Ok(())
}

#[tauri::command]
fn company_index_load(state: State<Db>) -> Result<CompanyIndexFile, String> {
    let path = state.root.join(INDEX_FILE);
    let text = match fs::read_to_string(&path) {
        Ok(t) => Some(t),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    let legacy = state.root.join(LEGACY_FILE).is_file();
    Ok(CompanyIndexFile { text, legacy, files: company_files(&state.root), root: state.root.to_string_lossy().into_owned() })
}

#[tauri::command]
fn company_index_save(state: State<Db>, text: String) -> Result<(), String> {
    serde_json::from_str::<Value>(&text).map_err(|e| e.to_string())?;
    let path = state.root.join(INDEX_FILE);
    let tmp = state.root.join(format!("{INDEX_FILE}.tmp"));
    {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        std::io::Write::write_all(&mut f, text.as_bytes()).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

#[tauri::command]
fn company_open(state: State<Db>, file: String) -> Result<VaultStatus, String> {
    let path = company_path(&state.root, &file)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    if let Some(old) = guard.conn.take() {
        if let Err((conn, e)) = old.close() {
            guard.conn = Some(conn);
            return Err(e.to_string());
        }
    }
    guard.path = None;
    guard.encrypted = false;
    let tmp = sidecar(&path, ".vault-tmp");
    let _ = fs::remove_file(&tmp);
    remove_sidecars(&tmp);
    let encrypted = file_is_encrypted(&path)?;
    let conn = if encrypted { None } else { Some(open_conn(&path, None)?) };
    let open = conn.is_some();
    guard.path = Some(path);
    guard.encrypted = encrypted;
    guard.conn = conn;
    Ok(VaultStatus { encrypted, open })
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
            fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            app.manage(Db { root: dir, inner: Mutex::new(Inner { path: None, conn: None, encrypted: false }) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db_select,
            db_batch,
            db_vault_status,
            db_unlock,
            db_vault_verify,
            db_vault_set,
            company_index_load,
            company_index_save,
            company_open
        ])
        .run(tauri::generate_context!())
        .expect("error while running TallyBook");
}
