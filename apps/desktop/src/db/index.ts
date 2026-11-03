import type { Db } from '@tallybook/core';

export const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export async function openDb(): Promise<Db> {
  if (isTauri()) {
    const { openTauriDb } = await import('./tauri.ts');
    return openTauriDb();
  }
  const { openWebDb } = await import('./web.ts');
  return openWebDb();
}
