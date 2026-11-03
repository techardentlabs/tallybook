import {
  CoreError, GROUP_READ_ONLY, companyEntryLabel, consolidateCompanies, ensureBanking, ensureCurrency, ensurePayroll, ensureSecurity, ensureStatutory, ensureStockExtras, ensureVClass, findCompanyEntry,
  readOnlyGroupDb, type CompanyEntry, type ConsolidationReport, type Db,
} from '@tallybook/core';
import { storageOf, type Attached, type Registry, type Storage, type Vault } from './index.ts';

let last: { entry: CompanyEntry; report: ConsolidationReport } | null = null;

export function groupConsolidation(): { entry: CompanyEntry; report: ConsolidationReport } | null {
  return last;
}

const groupVault: Vault = {
  encrypted: () => false,
  verify: async () => false,
  change: async () => {
    throw new CoreError('invalid', GROUP_READ_ONLY);
  },
};

async function members(reg: Registry, entry: CompanyEntry): Promise<CompanyEntry[]> {
  const index = await reg.load();
  const list = (entry.members ?? []).map((id) => findCompanyEntry(index, id));
  const missing = (entry.members ?? []).filter((_, i) => !list[i]);
  if (missing.length) throw new CoreError('not_found', `Member companies not found: ${missing.join(', ')}. Alter the Group Company to correct its members.`);
  return list as CompanyEntry[];
}

export async function loadGroup(reg: Registry, entry: CompanyEntry, password?: string): Promise<{ db: Db; report: ConsolidationReport }> {
  const list = await members(reg, entry);
  const attached: Attached[] = [];
  try {
    for (const m of list) {
      const enc = await reg.isEncrypted(m);
      if (enc && !password) throw new CoreError('invalid', `${companyEntryLabel(m)} is protected by TallyVault. Enter its TallyVault password.`);
      attached.push(await reg.attach(m, { readonly: true, password: enc ? password : undefined }));
    }
    const target = await reg.memory();
    const report = await consolidateCompanies(
      target,
      entry.name || companyEntryLabel(entry),
      list.map((m, i) => ({ id: m.id, name: companyEntryLabel(m), db: attached[i].db }))
    );
    for (const ensure of [ensureSecurity, ensureCurrency, ensureStockExtras, ensureVClass, ensureStatutory, ensureBanking, ensurePayroll]) await ensure(target);
    return { db: readOnlyGroupDb(target), report };
  } finally {
    for (const a of attached) await a.close().catch(() => undefined);
  }
}

export async function groupStorage(reg: Registry, entry: CompanyEntry): Promise<Storage> {
  const list = await members(reg, entry);
  const encrypted = (await Promise.all(list.map((m) => reg.isEncrypted(m)))).some(Boolean);
  return storageOf({
    encrypted,
    async open(password?: string) {
      const { db, report } = await loadGroup(reg, entry, password);
      last = { entry, report };
      return { db, vault: groupVault };
    },
  });
}
