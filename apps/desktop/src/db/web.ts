import initSqlJs, { type Database, type SqlValue as SqlJsValue } from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import type { Db, SqlValue, Stmt } from '@tallybook/core';

const STORE = 'files';

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('tallybook', 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function load(key: string): Promise<Uint8Array | null> {
  try {
    const d = await idb();
    return await new Promise((resolve, reject) => {
      const r = d.transaction(STORE).objectStore(STORE).get(key);
      r.onsuccess = () => resolve((r.result as Uint8Array | undefined) ?? null);
      r.onerror = () => reject(r.error);
    });
  } catch {
    return null;
  }
}

async function save(key: string, bytes: Uint8Array): Promise<void> {
  try {
    const d = await idb();
    await new Promise<void>((resolve, reject) => {
      const t = d.transaction(STORE, 'readwrite');
      t.objectStore(STORE).put(bytes, key);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  } catch {
    return;
  }
}

export async function openWebDb(key = 'default'): Promise<Db & { export(): Uint8Array; reset(): Promise<void> }> {
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  const existing = await load(key);
  const sqlite: Database = existing ? new SQL.Database(existing) : new SQL.Database();
  sqlite.exec('PRAGMA foreign_keys = ON;');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const persist = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void save(key, sqlite.export()), 250);
  };
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
      persist();
    },
    export: () => sqlite.export(),
    async reset() {
      clearTimeout(timer);
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
