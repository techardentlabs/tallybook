import { CoreError } from './db.ts';

export const COMPANY_INDEX_VERSION = 1;
export const FIRST_COMPANY_NUMBER = 100000;
export const OPEN_CREATE = '#create';
export const OPEN_NONE = '#none';

export interface CompanyEntry {
  id: string;
  name: string;
  file: string;
  last_opened: string | null;
  fy_start?: string;
  fy_end?: string;
}

export interface CompanyIndex {
  version: typeof COMPANY_INDEX_VERSION;
  companies: CompanyEntry[];
  open_next: string | null;
}

export type CompanyBootTarget = { kind: 'open'; id: string } | { kind: 'create' } | { kind: 'select' };

export type CompanyFileStyle = 'path' | 'key';

const ID_RE = /^\d{1,12}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

export function emptyCompanyIndex(): CompanyIndex {
  return { version: COMPANY_INDEX_VERSION, companies: [], open_next: null };
}

export function companyFileFor(id: string, style: CompanyFileStyle): string {
  if (!ID_RE.test(id)) throw new CoreError('invalid', 'Company number is not valid');
  return style === 'path' ? `companies/${id}.db` : `company-${id}`;
}

export function isCompanyFile(file: string, style: CompanyFileStyle, legacy: string): boolean {
  if (file === legacy) return true;
  return style === 'path' ? /^companies\/\d{1,12}\.db$/.test(file) : /^company-\d{1,12}$/.test(file);
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function entryFrom(raw: unknown): CompanyEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  const file = str(r.file);
  if (!id || !ID_RE.test(id) || !file) return null;
  const e: CompanyEntry = { id, name: (str(r.name) ?? '').trim(), file, last_opened: str(r.last_opened) || null };
  const from = str(r.fy_start);
  const to = str(r.fy_end);
  if (from && ISO_RE.test(from)) e.fy_start = from;
  if (to && ISO_RE.test(to)) e.fy_end = to;
  return e;
}

export function parseCompanyIndex(raw: unknown): CompanyIndex | null {
  let v = raw;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== 'object' || !Array.isArray((v as { companies?: unknown }).companies)) return null;
  const out = emptyCompanyIndex();
  const ids = new Set<string>();
  const files = new Set<string>();
  for (const item of (v as { companies: unknown[] }).companies) {
    const e = entryFrom(item);
    if (!e || ids.has(e.id) || files.has(e.file)) continue;
    ids.add(e.id);
    files.add(e.file);
    out.companies.push(e);
  }
  const next = str((v as { open_next?: unknown }).open_next);
  out.open_next = next && (next === OPEN_CREATE || next === OPEN_NONE || ids.has(next)) ? next : null;
  return out;
}

export function serializeCompanyIndex(index: CompanyIndex): string {
  return JSON.stringify(index, null, 2);
}

export function companyIdFromFile(file: string): string | null {
  const m = /(?:^|[/-])(\d{1,12})(?:\.db)?$/.exec(file);
  return m ? m[1] : null;
}

export function migrateCompanyIndex(raw: unknown, legacyFile: string | null, discovered: string[] = []): { index: CompanyIndex; changed: boolean } {
  const parsed = raw === null || raw === undefined ? null : parseCompanyIndex(raw);
  if (parsed) return { index: parsed, changed: false };
  let index = emptyCompanyIndex();
  if (legacyFile) index = addCompanyEntry(index, { id: String(FIRST_COMPANY_NUMBER), name: '', file: legacyFile, last_opened: null });
  const files = [...new Set(discovered)].filter((f) => f !== legacyFile && companyIdFromFile(f)).sort();
  const clashing: string[] = [];
  for (const file of files) {
    const id = companyIdFromFile(file)!;
    if (findCompanyEntry(index, id)) clashing.push(file);
    else index = addCompanyEntry(index, { id, name: '', file, last_opened: null });
  }
  for (const file of clashing) index = addCompanyEntry(index, { id: nextCompanyId(index), name: '', file, last_opened: null });
  return { index, changed: raw !== null && raw !== undefined ? true : index.companies.length > 0 };
}

export function nextCompanyId(index: CompanyIndex): string {
  const max = index.companies.reduce((m, c) => Math.max(m, Number(c.id)), FIRST_COMPANY_NUMBER - 1);
  return String(max + 1);
}

export function findCompanyEntry(index: CompanyIndex, id: string): CompanyEntry | undefined {
  return index.companies.find((c) => c.id === id);
}

export function addCompanyEntry(index: CompanyIndex, entry: CompanyEntry): CompanyIndex {
  if (!ID_RE.test(entry.id)) throw new CoreError('invalid', 'Company number is not valid');
  if (!entry.file) throw new CoreError('invalid', 'Company data file is required');
  if (index.companies.some((c) => c.id === entry.id)) throw new CoreError('conflict', `Company number ${entry.id} already exists`);
  if (index.companies.some((c) => c.file === entry.file)) throw new CoreError('conflict', 'Company data file is already in use');
  return { ...index, companies: [...index.companies, { ...entry, name: entry.name.trim() }] };
}

export function updateCompanyEntry(index: CompanyIndex, id: string, patch: { name?: string; fy_start?: string; fy_end?: string }): CompanyIndex {
  if (!findCompanyEntry(index, id)) throw new CoreError('not_found', 'Company not in list');
  return {
    ...index,
    companies: index.companies.map((c) => {
      if (c.id !== id) return c;
      const next = { ...c };
      if (patch.name !== undefined && patch.name.trim()) next.name = patch.name.trim();
      if (patch.fy_start && ISO_RE.test(patch.fy_start)) next.fy_start = patch.fy_start;
      if (patch.fy_end && ISO_RE.test(patch.fy_end)) next.fy_end = patch.fy_end;
      return next;
    }),
  };
}

export function markCompanyOpened(index: CompanyIndex, id: string, now: string = new Date().toISOString()): CompanyIndex {
  if (!findCompanyEntry(index, id)) throw new CoreError('not_found', 'Company not in list');
  return { ...index, companies: index.companies.map((c) => (c.id === id ? { ...c, last_opened: now } : c)) };
}

export function removeCompanyEntry(index: CompanyIndex, id: string): CompanyIndex {
  return { ...index, companies: index.companies.filter((c) => c.id !== id), open_next: index.open_next === id ? null : index.open_next };
}

export function requestCompanyOpen(index: CompanyIndex, target: string): CompanyIndex {
  if (target !== OPEN_CREATE && target !== OPEN_NONE && !findCompanyEntry(index, target)) throw new CoreError('not_found', 'Company not in list');
  return { ...index, open_next: target };
}

export function takeCompanyOpenRequest(index: CompanyIndex): { index: CompanyIndex; request: string | null } {
  return { index: { ...index, open_next: null }, request: index.open_next };
}

export function companyBootTarget(index: CompanyIndex, request: string | null = null): CompanyBootTarget {
  if (request === OPEN_CREATE) return { kind: 'create' };
  if (request && request !== OPEN_NONE && findCompanyEntry(index, request)) return { kind: 'open', id: request };
  if (index.companies.length === 0) return { kind: 'create' };
  if (request === OPEN_NONE) return { kind: 'select' };
  if (index.companies.length === 1) return { kind: 'open', id: index.companies[0].id };
  return { kind: 'select' };
}

export function companyEntryLabel(entry: CompanyEntry): string {
  return entry.name || `Company ${entry.id}`;
}

export function sortedCompanyEntries(index: CompanyIndex): CompanyEntry[] {
  return [...index.companies].sort((a, b) => companyEntryLabel(a).localeCompare(companyEntryLabel(b)) || Number(a.id) - Number(b.id));
}

export function recentCompanyEntry(index: CompanyIndex): CompanyEntry | undefined {
  return [...index.companies].filter((c) => c.last_opened).sort((a, b) => (b.last_opened ?? '').localeCompare(a.last_opened ?? ''))[0];
}
