import {
  OPEN_CREATE,
  OPEN_NONE,
  addCompanyEntry,
  addGroupCompany,
  alterGroupCompany,
  companyFileFor,
  isGroupEntry,
  nextCompanyId,
  removeCompanyEntry,
  findCompanyEntry,
  markCompanyOpened,
  requestCompanyOpen,
  updateCompanyEntry,
  type CompanyEntry,
  type CompanyIndex,
} from '@tallybook/core';
import { flushStorage, type Attached, type Registry } from './index.ts';

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

export function isGroupCompanyOpen(): boolean {
  return isGroupEntry(session?.entry);
}

export function createGroupCompany(name: string, members: string[]): Promise<CompanyEntry> {
  return exclusive(async () => {
    const s = need();
    const index = await s.registry.load();
    const id = nextCompanyId(index);
    const next = addGroupCompany(index, { id, name, file: companyFileFor(id, s.registry.style), members });
    await s.registry.save(next);
    return findCompanyEntry(next, id)!;
  });
}

export function alterGroup(id: string, patch: { name?: string; members?: string[] }): Promise<CompanyEntry> {
  return exclusive(async () => {
    const s = need();
    const next = alterGroupCompany(await s.registry.load(), id, patch);
    await s.registry.save(next);
    if (s.entry?.id === id) s.entry = findCompanyEntry(next, id) ?? s.entry;
    return findCompanyEntry(next, id)!;
  });
}

export function deleteGroup(id: string): Promise<void> {
  return exclusive(async () => {
    const s = need();
    const index = await s.registry.load();
    if (!isGroupEntry(findCompanyEntry(index, id))) throw new Error('Only a Group Company can be deleted here');
    await s.registry.save(removeCompanyEntry(index, id));
  });
}

export function companyIsEncrypted(entry: CompanyEntry): Promise<boolean> {
  return need().registry.isEncrypted(entry);
}

export function attachCompany(entry: CompanyEntry, opts: { readonly: boolean; password?: string }): Promise<Attached> {
  return need().registry.attach(entry, opts);
}

export function newCompanyData(password?: string): Promise<{ entry: CompanyEntry; data: Attached }> {
  return exclusive(async () => {
    const s = need();
    const index = await s.registry.load();
    const id = nextCompanyId(index);
    const entry: CompanyEntry = { id, name: '', file: companyFileFor(id, s.registry.style), last_opened: null };
    const data = await s.registry.create(entry, password);
    await s.registry.save(addCompanyEntry(index, { ...entry, name: `Company ${id}` }));
    return { entry, data };
  });
}

export function registerCompany(id: string, company: { name: string; fy_start?: string; fy_end?: string }): Promise<CompanyEntry> {
  return exclusive(async () => {
    const s = need();
    const next = updateCompanyEntry(await s.registry.load(), id, company);
    await s.registry.save(next);
    return findCompanyEntry(next, id)!;
  });
}

export function discardCompany(id: string): Promise<void> {
  return exclusive(async () => {
    const s = need();
    await s.registry.save(removeCompanyEntry(await s.registry.load(), id));
  });
}
