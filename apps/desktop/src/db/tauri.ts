import { invoke } from '@tauri-apps/api/core';
import type { Db, SqlValue, Stmt } from '@tallybook/core';
import type { Backend, Vault } from './index.ts';

async function call<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw new Error(typeof e === 'string' ? e : (e as Error)?.message ?? String(e));
  }
}

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

export async function openTauriStorage(): Promise<Backend> {
  const status = await call<{ encrypted: boolean; open: boolean }>('db_vault_status');
  let encrypted = status.encrypted;
  const vault: Vault = {
    encrypted: () => encrypted,
    verify: (password) => (encrypted && password ? call<boolean>('db_vault_verify', { password }) : Promise.resolve(false)),
    async change(current, next) {
      await call('db_vault_set', { current, password: next });
      encrypted = next !== '';
    },
  };
  return {
    encrypted,
    async open(password?: string) {
      await call('db_unlock', { password: password ?? '' });
      return { db: openTauriDb(), vault };
    },
  };
}
