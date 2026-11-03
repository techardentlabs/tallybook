import { CoreError, one, type Db, type SqlValue, type Stmt } from './db.ts';

export const qid = (name: string) => `"${name.replace(/"/g, '""')}"`;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

export interface SchemaObject {
  type: string;
  name: string;
  tbl_name: string;
  sql: string;
}

export interface FkRef {
  table: string;
  from: string;
  parent: string;
  to: string;
  soft?: boolean;
}

export interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  pk: number;
  dflt_value: string | null;
}

export async function schemaObjects(db: Db): Promise<SchemaObject[]> {
  return db.select<SchemaObject>(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, rowid"
  );
}

export async function tableList(db: Db): Promise<string[]> {
  return (await db.select<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid")).map((r) => r.name);
}

export async function columnsOf(db: Db, table: string): Promise<ColumnInfo[]> {
  return db.select<ColumnInfo>(`SELECT name, type, "notnull" AS "notnull", pk, dflt_value FROM pragma_table_info(${lit(table)})`);
}

const SOFT_REFS: Record<string, string> = {
  voucher_id: 'vouchers',
  order_voucher_id: 'vouchers',
  entry_id: 'entries',
  movement_id: 'stock_movements',
  ledger_id: 'ledgers',
  party_id: 'ledgers',
  item_id: 'stock_items',
  godown_id: 'godowns',
};

export async function foreignKeys(db: Db, tables?: string[]): Promise<FkRef[]> {
  const names = tables ?? (await tableList(db));
  const out: FkRef[] = [];
  for (const t of names) {
    const hard = await db.select<{ parent: string; col: string; pcol: string | null }>(`SELECT "table" AS parent, "from" AS col, "to" AS pcol FROM pragma_foreign_key_list(${lit(t)})`);
    for (const r of hard) out.push({ table: t, from: r.col, parent: r.parent, to: r.pcol || 'id' });
    const covered = new Set(hard.map((r) => r.col));
    for (const c of await columnsOf(db, t)) {
      const parent = SOFT_REFS[c.name];
      if (!parent || covered.has(c.name) || c.pk === 1 && t === parent || !names.includes(parent) || parent === t) continue;
      out.push({ table: t, from: c.name, parent, to: 'id', soft: true });
    }
  }
  return out;
}

export function dependencyOrder(tables: string[], refs: FkRef[]): string[] {
  const deps = new Map(tables.map((t) => [t, new Set(refs.filter((r) => r.table === t && r.parent !== t && tables.includes(r.parent) && !r.soft).map((r) => r.parent))]));
  const out: string[] = [];
  const done = new Set<string>();
  let progress = true;
  while (out.length < tables.length && progress) {
    progress = false;
    for (const t of tables) {
      if (done.has(t)) continue;
      if ([...deps.get(t)!].every((d) => done.has(d))) {
        out.push(t);
        done.add(t);
        progress = true;
      }
    }
  }
  for (const t of tables) if (!done.has(t)) out.push(t);
  return out;
}

export function ifNotExists(sql: string): string {
  return sql
    .replace(/^\s*CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/i, 'CREATE TABLE IF NOT EXISTS ')
    .replace(/^\s*CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF\s+NOT\s+EXISTS)/i, (_m, u: string | undefined) => `CREATE ${u ?? ''}INDEX IF NOT EXISTS `)
    .replace(/^\s*CREATE\s+(TEMP\s+|TEMPORARY\s+)?(VIEW|TRIGGER)\s+(?!IF\s+NOT\s+EXISTS)/i, (_m, t: string | undefined, k: string) => `CREATE ${t ?? ''}${k} IF NOT EXISTS `);
}

export function insertStmts(table: string, cols: string[], rows: SqlValue[][], verb = 'INSERT'): Stmt[] {
  if (!rows.length || !cols.length) return [];
  const per = Math.max(1, Math.floor(900 / cols.length));
  const out: Stmt[] = [];
  const head = `${verb} INTO ${qid(table)} (${cols.map(qid).join(', ')}) VALUES `;
  const tuple = `(${cols.map(() => '?').join(', ')})`;
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per);
    out.push({ sql: head + chunk.map(() => tuple).join(', '), params: chunk.flat() });
  }
  return out;
}

export async function runChunked(db: Db, stmts: Stmt[], size = 40): Promise<void> {
  for (let i = 0; i < stmts.length; i += size) {
    await db.batch([{ sql: 'PRAGMA defer_foreign_keys = ON' }, ...stmts.slice(i, i + size)]);
  }
}

export async function isEmptyDb(db: Db): Promise<boolean> {
  const has = await one<{ x: number }>(db, "SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'company'");
  if (!has) return true;
  return !(await one(db, 'SELECT 1 AS x FROM company LIMIT 1'));
}

export async function cloneDatabase(src: Db, dest: Db, opts: { skipRows?: (table: string) => boolean } = {}): Promise<{ tables: number; rows: number }> {
  if (!(await isEmptyDb(dest))) throw new CoreError('conflict', 'The destination company already has data');
  const objs = await schemaObjects(src);
  const tables = objs.filter((o) => o.type === 'table').map((o) => o.name);
  const existing = new Set(await tableList(dest));
  const ddl: Stmt[] = objs.filter((o) => o.type !== 'table' || !existing.has(o.name)).map((o) => ({ sql: ifNotExists(o.sql) }));
  if (ddl.length) await dest.batch(ddl);
  const version = (await one<{ user_version: number }>(src, 'PRAGMA user_version'))?.user_version ?? 0;
  if (version) await dest.batch([{ sql: `PRAGMA user_version = ${Math.trunc(Number(version)) || 0}` }]);
  const refs = await foreignKeys(src, tables);
  let rows = 0;
  for (const t of dependencyOrder(tables, refs)) {
    if (opts.skipRows?.(t)) continue;
    const destCols = new Set((await columnsOf(dest, t)).map((c) => c.name));
    const cols = (await columnsOf(src, t)).map((c) => c.name).filter((c) => destCols.has(c));
    if (!cols.length) continue;
    const data = await src.select<Record<string, SqlValue>>(`SELECT ${cols.map(qid).join(', ')} FROM ${qid(t)} ORDER BY rowid`);
    rows += data.length;
    await runChunked(dest, insertStmts(t, cols, data.map((r) => cols.map((c) => r[c] ?? null))));
  }
  return { tables: tables.length, rows };
}

export async function cascadeDeleteStmts(db: Db, table: string, where: string, refs?: FkRef[]): Promise<Stmt[]> {
  const all = refs ?? (await foreignKeys(db));
  const out: Stmt[] = [];
  const walk = (t: string, w: string, path: string[]) => {
    for (const r of all) {
      if (r.parent !== t || r.table === t || path.includes(r.table)) continue;
      walk(r.table, `${qid(r.from)} IN (SELECT ${qid(r.to)} FROM ${qid(t)} WHERE ${w})`, [...path, r.table]);
    }
    out.push({ sql: `DELETE FROM ${qid(t)} WHERE ${w}` });
  };
  walk(table, where, [table]);
  return out;
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function sqlDate(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new CoreError('invalid', 'Invalid date');
  return lit(iso);
}
