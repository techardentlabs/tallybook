import initSqlJs, { type Database, type SqlValue as SqlJsValue } from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import {
  CoreError,
  VAULT_ITERATIONS,
  WRONG_VAULT_PASSWORD,
  deriveVaultKey,
  isCompanyFile,
  openWithKey,
  migrateCompanyIndex,
  randomBytes,
  sealWithKey,
  serializeCompanyIndex,
  type CompanyIndex,
  type Db,
  type SqlValue,
  type Stmt,
} from '@tallybook/core';
import { storageOf, type Attached, type Backend, type Registry, type Vault } from './index.ts';

const STORE = 'files';
const INDEX_KEY = 'companies';
const LEGACY_KEY = 'default';
const AAD = new TextEncoder().encode('tallybook-vault/1');
const CHECK = new TextEncoder().encode('tallybook-vault-check');

interface SealedRecord {
  format: 'tallybook-vault';
  version: 1;
  iterations: number;
  salt: Uint8Array;
  iv: Uint8Array;
  data: Uint8Array;
}

interface Cipher {
  key: CryptoKey;
  salt: Uint8Array;
  iterations: number;
  check: { iv: Uint8Array; data: Uint8Array };
}

type Stored = Uint8Array | SealedRecord;

function isSealed(v: unknown): v is SealedRecord {
  return !!v && typeof v === 'object' && !(v instanceof Uint8Array) && (v as { format?: unknown }).format === 'tallybook-vault';
}

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('tallybook', 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function load(key: string): Promise<Stored | null> {
  try {
    const d = await idb();
    return await new Promise((resolve, reject) => {
      const r = d.transaction(STORE).objectStore(STORE).get(key);
      r.onsuccess = () => resolve((r.result as Stored | undefined) ?? null);
      r.onerror = () => reject(r.error);
    });
  } catch {
    return null;
  }
}

async function put(key: string, value: Stored): Promise<void> {
  const d = await idb();
  await new Promise<void>((resolve, reject) => {
    const t = d.transaction(STORE, 'readwrite');
    t.objectStore(STORE).put(value, key);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

async function getRaw(key: string): Promise<unknown> {
  const d = await idb();
  return new Promise((resolve, reject) => {
    const r = d.transaction(STORE).objectStore(STORE).get(key);
    r.onsuccess = () => resolve(r.result ?? null);
    r.onerror = () => reject(r.error);
  });
}

async function allKeys(): Promise<string[]> {
  const d = await idb();
  return new Promise((resolve, reject) => {
    const r = d.transaction(STORE).objectStore(STORE).getAllKeys();
    r.onsuccess = () => resolve(r.result.filter((k): k is string => typeof k === 'string'));
    r.onerror = () => reject(r.error);
  });
}

async function putRaw(key: string, value: unknown): Promise<void> {
  const d = await idb();
  await new Promise<void>((resolve, reject) => {
    const t = d.transaction(STORE, 'readwrite');
    t.objectStore(STORE).put(value, key);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function openWebRegistry(): Promise<Registry> {
  const save = (index: CompanyIndex) => putRaw(INDEX_KEY, serializeCompanyIndex(index));
  return {
    location: 'Browser storage',
    style: 'key',
    async load() {
      const raw = await getRaw(INDEX_KEY);
      const keys = await allKeys();
      const legacy = keys.includes(LEGACY_KEY) ? LEGACY_KEY : null;
      const { index, changed } = migrateCompanyIndex(raw, legacy, keys.filter((k) => /^company-\d{1,12}$/.test(k)));
      if (changed) await save(index);
      return index;
    },
    save,
    async open(entry) {
      if (!isCompanyFile(entry.file, 'key', LEGACY_KEY)) throw new CoreError('invalid', 'The company data file name is not valid');
      return storageOf(await openWebStorage(entry.file));
    },
    async isEncrypted(entry) {
      if (!isCompanyFile(entry.file, 'key', LEGACY_KEY)) return false;
      return isSealed(await load(entry.file));
    },
    attach: (entry, opts) => attachWeb(entry.file, opts),
    async create(entry, password) {
      if (!isCompanyFile(entry.file, 'key', LEGACY_KEY)) throw new CoreError('invalid', 'The company data file name is not valid');
      if (await load(entry.file)) throw new CoreError('conflict', 'A company with this number already exists');
      const cipher = password ? await makeCipher(password, randomBytes(16), VAULT_ITERATIONS) : null;
      const d = await openWebDb(entry.file, null, cipher);
      return { db: d.db, encrypted: !!cipher, close: () => d.flush() };
    },
    memory: () => openMemoryDb(),
  };
}

async function sqlJs() {
  return initSqlJs({ locateFile: () => wasmUrl });
}

function sqlDb(sqlite: Database, after?: () => void): Db {
  return {
    async select<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
      const stmt = sqlite.prepare(sql);
      try {
        stmt.bind(params as SqlJsValue[]);
        const rows: T[] = [];
        while (stmt.step()) rows.push(stmt.getAsObject() as T);
        return rows;
      } finally {
        stmt.free();
      }
    },
    async batch(stmts: Stmt[]): Promise<void> {
      sqlite.exec('BEGIN');
      try {
        for (const s of stmts) sqlite.run(s.sql, (s.params ?? []) as SqlJsValue[]);
        sqlite.exec('COMMIT');
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
      after?.();
    },
  };
}

export async function openMemoryDb(): Promise<Db> {
  const SQL = await sqlJs();
  return sqlDb(new SQL.Database());
}

async function attachWeb(file: string, opts: { readonly: boolean; password?: string }): Promise<Attached> {
  if (!isCompanyFile(file, 'key', LEGACY_KEY)) throw new CoreError('invalid', 'The company data file name is not valid');
  const raw = await load(file);
  if (!raw) throw new CoreError('not_found', 'The company data was not found');
  let bytes: Uint8Array;
  let cipher: Cipher | null = null;
  if (isSealed(raw)) {
    if (!opts.password) throw new CoreError('invalid', WRONG_VAULT_PASSWORD);
    const key = await deriveVaultKey(opts.password, raw.salt, raw.iterations);
    bytes = await openWithKey(key, raw.iv, raw.data, AAD);
    cipher = { key, salt: raw.salt, iterations: raw.iterations, check: await sealWithKey(key, CHECK, AAD) };
  } else bytes = raw;
  if (!opts.readonly) {
    const d = await openWebDb(file, bytes, cipher);
    return { db: d.db, encrypted: !!cipher, close: () => d.flush() };
  }
  const SQL = await sqlJs();
  const sqlite = new SQL.Database(bytes);
  const db = sqlDb(sqlite);
  return {
    db: {
      select: (sql, params) => db.select(sql, params),
      batch: async () => {
        throw new CoreError('invalid', 'The company is open read-only');
      },
    },
    encrypted: !!cipher,
    close: async () => sqlite.close(),
  };
}

async function makeCipher(password: string, salt: Uint8Array, iterations: number): Promise<Cipher> {
  const key = await deriveVaultKey(password, salt, iterations);
  return { key, salt, iterations, check: await sealWithKey(key, CHECK, AAD) };
}

async function seal(c: Cipher, bytes: Uint8Array): Promise<SealedRecord> {
  const { iv, data } = await sealWithKey(c.key, bytes, AAD);
  return { format: 'tallybook-vault', version: 1, iterations: c.iterations, salt: c.salt, iv, data };
}

export async function openWebStorage(name = 'default'): Promise<Backend> {
  const raw = await load(name);
  return {
    encrypted: isSealed(raw),
    async open(password?: string) {
      if (isSealed(raw)) {
        if (!password) throw new CoreError('invalid', WRONG_VAULT_PASSWORD);
        const key = await deriveVaultKey(password, raw.salt, raw.iterations);
        const bytes = await openWithKey(key, raw.iv, raw.data, AAD);
        const cipher: Cipher = { key, salt: raw.salt, iterations: raw.iterations, check: await sealWithKey(key, CHECK, AAD) };
        return openWebDb(name, bytes, cipher);
      }
      return openWebDb(name, raw instanceof Uint8Array ? raw : null, null);
    },
  };
}

export async function openWebDb(
  key = 'default',
  existing: Uint8Array | null = null,
  initial: Cipher | null = null
): Promise<Db & { export(): Uint8Array; reset(): Promise<void>; flush(): Promise<void>; vault: Vault; db: Db }> {
  const SQL = await sqlJs();
  const sqlite: Database = existing ? new SQL.Database(existing) : new SQL.Database();
  sqlite.exec('PRAGMA foreign_keys = ON;');
  let cipher = initial;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<void> = Promise.resolve();
  let dirty = false;
  const snapshot = () => {
    const bytes = sqlite.export();
    sqlite.exec('PRAGMA foreign_keys = ON;');
    return bytes;
  };
  const write = (): Promise<void> => {
    const c = cipher;
    const job = chain.catch(() => undefined).then(async () => {
      dirty = false;
      const bytes = snapshot();
      await put(key, c ? await seal(c, bytes) : bytes);
    });
    chain = job;
    return job;
  };
  const persist = () => {
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(() => void write().catch(() => undefined), 250);
  };
  const verify = async (password: string): Promise<boolean> => {
    if (!cipher || !password) return false;
    try {
      const k = await deriveVaultKey(password, cipher.salt, cipher.iterations);
      await openWithKey(k, cipher.check.iv, cipher.check.data, AAD);
      return true;
    } catch {
      return false;
    }
  };
  const vault: Vault = {
    encrypted: () => cipher !== null,
    verify,
    async change(current: string, next: string) {
      if (cipher && !(await verify(current))) throw new CoreError('invalid', WRONG_VAULT_PASSWORD);
      if (!cipher && !next) return;
      const prev = cipher;
      const nextCipher = next ? await makeCipher(next, randomBytes(16), VAULT_ITERATIONS) : null;
      clearTimeout(timer);
      cipher = nextCipher;
      try {
        await write();
      } catch (e) {
        cipher = prev;
        throw new CoreError('invalid', `Could not save the company data: ${(e as Error)?.message ?? e}`);
      }
    },
  };
  const db: Db = sqlDb(sqlite, persist);
  return {
    ...db,
    db,
    vault,
    export: () => snapshot(),
    async flush() {
      clearTimeout(timer);
      if (dirty) await write();
      else await chain;
    },
    async reset() {
      clearTimeout(timer);
      await chain.catch(() => undefined);
      sqlite.close();
      const d = await idb();
      await new Promise<void>((resolve) => {
        const t = d.transaction(STORE, 'readwrite');
        t.objectStore(STORE).delete(key);
        t.oncomplete = () => resolve();
      });
    },
  };
}
