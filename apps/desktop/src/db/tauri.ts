import { invoke } from '@tauri-apps/api/core';
import type { Db, SqlValue, Stmt } from '@tallybook/core';

export function openTauriDb(): Db {
  return {
    select<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
      return invoke<T[]>('db_select', { sql, params });
    },
    async batch(stmts: Stmt[]): Promise<void> {
      await invoke('db_batch', { stmts: stmts.map((s) => ({ sql: s.sql, params: s.params ?? [] })) });
    },
  };
}
