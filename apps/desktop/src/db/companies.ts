import {
  OPEN_CREATE,
  OPEN_NONE,
  addCompanyEntry,
  findCompanyEntry,
  markCompanyOpened,
  requestCompanyOpen,
  updateCompanyEntry,
  type CompanyEntry,
  type CompanyIndex,
} from '@tallybook/core';
import { flushStorage, type Registry } from './index.ts';

interface Session {
  registry: Registry;
  entry: CompanyEntry | null;
}

let session: Session | null = null;
let lock: Promise<unknown> = Promise.resolve();

function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const job = lock.catch(() => undefined).then(fn);
  lock = job;
  return job;
}

export function beginCompanySession(registry: Registry, entry: CompanyEntry | null) {
  session = { registry, entry };
}

function need(): Session {
  if (!session) throw new Error('The company list is not available');
  return session;
}

export function currentCompanyEntry(): CompanyEntry | null {
  return session?.entry ?? null;
}

export function companyLocation(): string {
  return session?.registry.location ?? '';
}

export function loadCompanyIndex(): Promise<CompanyIndex> {
  return exclusive(() => need().registry.load());
}

export function noteCompanyOpened(company: { name: string; fy_start?: string; fy_end?: string } | null): Promise<void> {
  return exclusive(async () => {
    const s = need();
    if (!s.entry || !company?.name) return;
    let index = await s.registry.load();
    if (!findCompanyEntry(index, s.entry.id)) index = addCompanyEntry(index, { ...s.entry, name: company.name });
    index = updateCompanyEntry(index, s.entry.id, { name: company.name, fy_start: company.fy_start, fy_end: company.fy_end });
    index = markCompanyOpened(index, s.entry.id);
    await s.registry.save(index);
    s.entry = findCompanyEntry(index, s.entry.id) ?? s.entry;
  });
}

export function openCompanyAfterReload(target: string): Promise<void> {
  return exclusive(async () => {
    const s = need();
    await flushStorage();
    await s.registry.save(requestCompanyOpen(await s.registry.load(), target));
    window.location.reload();
  });
}

export const switchCompany = (id: string) => openCompanyAfterReload(id);
export const shutCompany = () => openCompanyAfterReload(OPEN_NONE);
export const createAnotherCompany = () => openCompanyAfterReload(OPEN_CREATE);
