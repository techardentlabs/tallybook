import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { Db, SqlValue, Stmt } from './db.ts';

export function nodeDb(path = ':memory:'): Db & { close(): void } {
  const sqlite = new DatabaseSync(path);
  sqlite.exec('PRAGMA foreign_keys = ON;');
  return {
    async select<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
      return sqlite.prepare(sql).all(...(params as SQLInputValue[])) as T[];
    },
    async batch(stmts: Stmt[]): Promise<void> {
      sqlite.exec('BEGIN');
      try {
        for (const s of stmts) sqlite.prepare(s.sql).run(...((s.params ?? []) as SQLInputValue[]));
        sqlite.exec('COMMIT');
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    },
    close() {
      sqlite.close();
    },
  };
}
