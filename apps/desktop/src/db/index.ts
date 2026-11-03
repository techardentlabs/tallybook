import { CoreError, type CompanyEntry, type CompanyFileStyle, type CompanyIndex, type Db } from '@tallybook/core';

export const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export interface Vault {
  encrypted(): boolean;
  verify(password: string): Promise<boolean>;
  change(current: string, next: string): Promise<void>;
}

export interface Opened {
  db: Db;
  vault: Vault;
  flush?: () => Promise<void>;
}

export interface Storage {
  encrypted: boolean;
  open(password?: string): Promise<Db>;
}

export interface Backend {
  encrypted: boolean;
  open(password?: string): Promise<Opened>;
}

export interface Registry {
  location: string;
  style: CompanyFileStyle;
  load(): Promise<CompanyIndex>;
  save(index: CompanyIndex): Promise<void>;
  open(entry: CompanyEntry): Promise<Storage>;
}

let active: Vault | null = null;
let flusher: (() => Promise<void>) | null = null;

export function vault(): Vault {
  if (!active) throw new CoreError('invalid', 'The company data is not open');
  return active;
}

export async function flushStorage(): Promise<void> {
  await flusher?.();
}

export function storageOf(b: Backend): Storage {
  return {
    encrypted: b.encrypted,
    async open(password?: string) {
      const o = await b.open(password);
      active = o.vault;
      flusher = o.flush ?? null;
      return o.db;
    },
  };
}

export async function openRegistry(): Promise<Registry> {
  if (isTauri()) {
    const { openTauriRegistry } = await import('./tauri.ts');
    return openTauriRegistry();
  }
  const { openWebRegistry } = await import('./web.ts');
  return openWebRegistry();
}
