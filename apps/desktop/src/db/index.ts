import { CoreError, type Db } from '@tallybook/core';

export const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export interface Vault {
  encrypted(): boolean;
  verify(password: string): Promise<boolean>;
  change(current: string, next: string): Promise<void>;
}

export interface Opened {
  db: Db;
  vault: Vault;
}

export interface Storage {
  encrypted: boolean;
  open(password?: string): Promise<Db>;
}

export interface Backend {
  encrypted: boolean;
  open(password?: string): Promise<Opened>;
}

let active: Vault | null = null;

export function vault(): Vault {
  if (!active) throw new CoreError('invalid', 'The company data is not open');
  return active;
}

async function backend(): Promise<Backend> {
  if (isTauri()) {
    const { openTauriStorage } = await import('./tauri.ts');
    return openTauriStorage();
  }
  const { openWebStorage } = await import('./web.ts');
  return openWebStorage();
}

export async function openStorage(): Promise<Storage> {
  const b = await backend();
  return {
    encrypted: b.encrypted,
    async open(password?: string) {
      const o = await b.open(password);
      active = o.vault;
      return o.db;
    },
  };
}

export async function openDb(password?: string): Promise<Db> {
  return (await openStorage()).open(password);
}
