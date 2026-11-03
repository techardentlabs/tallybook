import { CoreError, one, type Db, type Stmt } from './db.ts';
import type { Books } from './books.ts';
import { clean, isIsoDate } from './util.ts';
import { EINVOICE_SCHEMA } from './einvoice.ts';
import { GSTRECON_SCHEMA } from './gstrecon.ts';

export type TaxKind = 'TDS' | 'TCS';

export const DEDUCTEE_TYPES = [
  'Artificial Juridical Person',
  'Association of Persons',
  'Body of Individuals',
  'Company - Non Resident',
  'Company - Resident',
  'Co-Operative Society - Non Resident',
  'Co-Operative Society - Resident',
  'Government',
  'Individual/HUF - Non Resident',
  'Individual/HUF - Resident',
  'Local Authority',
  'Partnership Firm',
] as const;
export type DeducteeType = (typeof DEDUCTEE_TYPES)[number];

export const isCompanyType = (t: string) => t.startsWith('Company');
export const residentOf = (t: string) => (t.endsWith('Non Resident') ? 'NonResident' : 'Resident');

export const RESIDENT_TYPES = ['Resident', 'NonResident'] as const;

export const TDS_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS tds_company (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    tds_enabled INTEGER NOT NULL DEFAULT 0,
    tcs_enabled INTEGER NOT NULL DEFAULT 0,
    einvoice_enabled INTEGER NOT NULL DEFAULT 0,
    ewb_enabled INTEGER NOT NULL DEFAULT 0,
    tan TEXT NOT NULL DEFAULT '',
    tan_circle TEXT NOT NULL DEFAULT '',
    deductor_type TEXT NOT NULL DEFAULT 'Company (Resident)',
    deductor_branch TEXT NOT NULL DEFAULT '',
    person_name TEXT NOT NULL DEFAULT '',
    person_designation TEXT NOT NULL DEFAULT '',
    person_father TEXT NOT NULL DEFAULT '',
    allow_rate_without_pan INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS tds_nature (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    kind TEXT NOT NULL DEFAULT 'TDS' CHECK (kind IN ('TDS','TCS')),
    section TEXT NOT NULL DEFAULT '',
    payment_code TEXT NOT NULL DEFAULT '',
    remittance_code TEXT NOT NULL DEFAULT '',
    rate_ind_pan_bp INTEGER NOT NULL DEFAULT 0,
    rate_ind_nopan_bp INTEGER NOT NULL DEFAULT 0,
    rate_oth_pan_bp INTEGER NOT NULL DEFAULT 0,
    rate_oth_nopan_bp INTEGER NOT NULL DEFAULT 0,
    threshold INTEGER NOT NULL DEFAULT 0,
    single_threshold INTEGER NOT NULL DEFAULT 0,
    surcharge_bp INTEGER NOT NULL DEFAULT 0,
    cess_bp INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS tds_duty_ledger (
    ledger_id INTEGER PRIMARY KEY REFERENCES ledgers(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'TDS',
    nature_id INTEGER REFERENCES tds_nature(id)
  )`,
  `CREATE TABLE IF NOT EXISTS tds_party (
    ledger_id INTEGER PRIMARY KEY REFERENCES ledgers(id) ON DELETE CASCADE,
    deductee_type TEXT NOT NULL DEFAULT 'Company - Resident',
    resident TEXT NOT NULL DEFAULT 'Resident',
    nature_id INTEGER REFERENCES tds_nature(id),
    deduct_lower INTEGER NOT NULL DEFAULT 0,
    lower_rate_bp INTEGER NOT NULL DEFAULT 0,
    lower_certificate TEXT NOT NULL DEFAULT '',
    lower_limit INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS tds_deductions (
    id INTEGER PRIMARY KEY,
    voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
    party_id INTEGER NOT NULL REFERENCES ledgers(id),
    nature_id INTEGER NOT NULL REFERENCES tds_nature(id),
    duty_ledger_id INTEGER REFERENCES ledgers(id),
    kind TEXT NOT NULL DEFAULT 'TDS',
    date TEXT NOT NULL,
    deductee_type TEXT NOT NULL,
    resident TEXT NOT NULL DEFAULT 'Resident',
    pan TEXT NOT NULL DEFAULT '',
    gross INTEGER NOT NULL,
    base INTEGER NOT NULL,
    rate_bp INTEGER NOT NULL,
    tax INTEGER NOT NULL,
    surcharge INTEGER NOT NULL DEFAULT 0,
    cess INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL,
    UNIQUE (voucher_id, nature_id)
  )`,
  `CREATE TABLE IF NOT EXISTS tds_challans (
    id INTEGER PRIMARY KEY,
    voucher_id INTEGER REFERENCES vouchers(id) ON DELETE SET NULL,
    kind TEXT NOT NULL DEFAULT 'TDS',
    date TEXT NOT NULL,
    section TEXT NOT NULL DEFAULT '',
    deductee_type TEXT NOT NULL DEFAULT '',
    resident TEXT NOT NULL DEFAULT 'Resident',
    bank_name TEXT NOT NULL DEFAULT '',
    branch TEXT NOT NULL DEFAULT '',
    cheque_no TEXT NOT NULL DEFAULT '',
    cheque_date TEXT NOT NULL DEFAULT '',
    bsr_code TEXT NOT NULL DEFAULT '',
    challan_no TEXT NOT NULL DEFAULT '',
    challan_date TEXT NOT NULL DEFAULT '',
    quarter_from TEXT NOT NULL DEFAULT '',
    quarter_to TEXT NOT NULL DEFAULT '',
    amount INTEGER NOT NULL,
    reconciled INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS tds_challan_lines (
    id INTEGER PRIMARY KEY,
    challan_id INTEGER NOT NULL REFERENCES tds_challans(id) ON DELETE CASCADE,
    deduction_id INTEGER NOT NULL REFERENCES tds_deductions(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL
  )`,
];

export const STATUTORY_SCHEMA: string[] = [...TDS_SCHEMA, ...EINVOICE_SCHEMA, ...GSTRECON_SCHEMA];

export interface TdsCompany {
  tds_enabled: number;
  tcs_enabled: number;
  einvoice_enabled: number;
  ewb_enabled: number;
  tan: string;
  tan_circle: string;
  deductor_type: string;
  deductor_branch: string;
  person_name: string;
  person_designation: string;
  person_father: string;
  allow_rate_without_pan: number;
}

export interface Nature {
  id: number;
  name: string;
  kind: TaxKind;
  section: string;
  payment_code: string;
  remittance_code: string;
  rate_ind_pan_bp: number;
  rate_ind_nopan_bp: number;
  rate_oth_pan_bp: number;
  rate_oth_nopan_bp: number;
  threshold: number;
  single_threshold: number;
  surcharge_bp: number;
  cess_bp: number;
}

export interface TdsParty {
  ledger_id: number;
  deductee_type: string;
  resident: string;
  nature_id: number | null;
  deduct_lower: number;
  lower_rate_bp: number;
  lower_certificate: string;
  lower_limit: number;
}

const L = 100;
type Seed = [string, TaxKind, string, string, number, number, number, number, number, number];
const SEED: Seed[] = [
  ['Commission Or Brokerage', 'TDS', '194H', '94H', 200, 2000, 200, 2000, 20000 * L, 0],
  ['Fees for Professional Services', 'TDS', '194J', '94J', 1000, 2000, 1000, 2000, 50000 * L, 0],
  ['Fees for Technical Services', 'TDS', '194J', '94J', 200, 2000, 200, 2000, 50000 * L, 0],
  ['Payments to Contractors', 'TDS', '194C', '94C', 100, 2000, 200, 2000, 100000 * L, 30000 * L],
  ['Rent of Land, Building Or Furniture', 'TDS', '194I', '94I', 1000, 2000, 1000, 2000, 600000 * L, 0],
  ['Rent of Plant & Machinery', 'TDS', '194I', '94I', 200, 2000, 200, 2000, 600000 * L, 0],
  ['Income in the Form of Interest From Indian Company', 'TDS', '194A', '94A', 1000, 2000, 1000, 2000, 10000 * L, 0],
  ['Purchase of Goods', 'TDS', '194Q', '94Q', 10, 500, 10, 500, 5000000 * L, 0],
  ['Sale of Scrap', 'TCS', '206C(1)', '', 100, 500, 100, 500, 0, 0],
  ['Sale of Timber Obtained Under a Forest Lease', 'TCS', '206C(1)', '', 250, 500, 250, 500, 0, 0],
  ['Sale of Motor Vehicle Exceeding Ten Lakh Rupees', 'TCS', '206C(1F)', '', 100, 500, 100, 500, 1000000 * L, 0],
];

async function nextId(db: Db, table: string): Promise<number> {
  return ((await one<{ m: number }>(db, `SELECT COALESCE(MAX(id), 0) AS m FROM ${table}`))!.m) + 1;
}

export async function ensureStatutory(db: Db): Promise<void> {
  await db.batch(STATUTORY_SCHEMA.map((sql) => ({ sql })));
  await db.batch([{ sql: 'INSERT OR IGNORE INTO tds_company (id) VALUES (1)' }]);
  const n = (await one<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM tds_nature'))!.c;
  if (n) return;
  await db.batch(
    SEED.map((s, i) => ({
      sql: `INSERT INTO tds_nature (id, name, kind, section, payment_code, rate_ind_pan_bp, rate_ind_nopan_bp, rate_oth_pan_bp, rate_oth_nopan_bp, threshold, single_threshold)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [i + 1, ...s],
    }))
  );
}

export async function tdsCompany(db: Db): Promise<TdsCompany> {
  await db.batch([{ sql: 'INSERT OR IGNORE INTO tds_company (id) VALUES (1)' }]);
  return (await one<TdsCompany>(db, 'SELECT * FROM tds_company WHERE id = 1'))!;
}

const COMPANY_TEXT = ['tan', 'tan_circle', 'deductor_type', 'deductor_branch', 'person_name', 'person_designation', 'person_father'] as const;
const COMPANY_FLAGS = ['tds_enabled', 'tcs_enabled', 'einvoice_enabled', 'ewb_enabled', 'allow_rate_without_pan'] as const;

export async function saveTdsCompany(db: Db, input: Partial<TdsCompany>): Promise<TdsCompany> {
  const cur = await tdsCompany(db);
  const sets: string[] = [];
  const params: (string | number)[] = [];
  for (const f of COMPANY_TEXT) {
    if (input[f] === undefined) continue;
    let v = clean(input[f], 100);
    if (f === 'tan') {
      v = v.toUpperCase();
      if (v && !/^[A-Z]{4}\d{5}[A-Z]$/.test(v)) throw new CoreError('invalid', 'TAN is invalid');
    }
    sets.push(`${f} = ?`);
    params.push(v);
  }
  for (const f of COMPANY_FLAGS) {
    if (input[f] === undefined) continue;
    sets.push(`${f} = ?`);
    params.push(input[f] ? 1 : 0);
  }
  if (sets.length) await db.batch([{ sql: `UPDATE tds_company SET ${sets.join(', ')} WHERE id = 1`, params }]);
  void cur;
  return tdsCompany(db);
}

export async function natures(db: Db, kind?: TaxKind): Promise<Nature[]> {
  return kind
    ? db.select<Nature>('SELECT * FROM tds_nature WHERE kind = ? ORDER BY name COLLATE NOCASE', [kind])
    : db.select<Nature>('SELECT * FROM tds_nature ORDER BY name COLLATE NOCASE');
}

export async function nature(db: Db, id: number): Promise<Nature | null> {
  return (await one<Nature>(db, 'SELECT * FROM tds_nature WHERE id = ?', [id])) ?? null;
}

const NATURE_INTS = ['rate_ind_pan_bp', 'rate_ind_nopan_bp', 'rate_oth_pan_bp', 'rate_oth_nopan_bp', 'threshold', 'single_threshold', 'surcharge_bp', 'cess_bp'] as const;

export async function saveNature(db: Db, input: Partial<Nature> & { name: string }, id?: number): Promise<Nature> {
  const name = clean(input.name, 100);
  if (!name) throw new CoreError('invalid', 'Name is required');
  const dup = await one<{ id: number }>(db, 'SELECT id FROM tds_nature WHERE name = ? COLLATE NOCASE', [name]);
  if (dup && dup.id !== id) throw new CoreError('conflict', `"${name}" already exists`);
  const ints = NATURE_INTS.map((f) => {
    const v = Math.trunc(Number(input[f]) || 0);
    if (v < 0) throw new CoreError('invalid', 'Values cannot be negative');
    return v;
  });
  const kind: TaxKind = input.kind === 'TCS' ? 'TCS' : 'TDS';
  const text = [kind, clean(input.section, 20), clean(input.payment_code, 20), clean(input.remittance_code, 20)];
  if (id) {
    if (!(await nature(db, id))) throw new CoreError('not_found', 'Nature of payment not found');
    await db.batch([
      {
        sql: `UPDATE tds_nature SET name = ?, kind = ?, section = ?, payment_code = ?, remittance_code = ?, ${NATURE_INTS.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`,
        params: [name, ...text, ...ints, id],
      },
    ]);
    return (await nature(db, id))!;
  }
  const nid = await nextId(db, 'tds_nature');
  await db.batch([
    {
      sql: `INSERT INTO tds_nature (id, name, kind, section, payment_code, remittance_code, ${NATURE_INTS.join(', ')}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [nid, name, ...text, ...ints],
    },
  ]);
  return (await nature(db, nid))!;
}

export async function deleteNature(db: Db, id: number): Promise<void> {
  const used = await one(db, 'SELECT 1 FROM tds_deductions WHERE nature_id = ? LIMIT 1', [id]);
  if (used) throw new CoreError('conflict', 'Nature of payment is used in transactions');
  await db.batch([
    { sql: 'UPDATE tds_duty_ledger SET nature_id = NULL WHERE nature_id = ?', params: [id] },
    { sql: 'UPDATE tds_party SET nature_id = NULL WHERE nature_id = ?', params: [id] },
    { sql: 'DELETE FROM tds_nature WHERE id = ?', params: [id] },
  ]);
}

export async function tdsParty(db: Db, ledgerId: number): Promise<TdsParty> {
  return (
    (await one<TdsParty>(db, 'SELECT * FROM tds_party WHERE ledger_id = ?', [ledgerId])) ?? {
      ledger_id: ledgerId,
      deductee_type: 'Company - Resident',
      resident: 'Resident',
      nature_id: null,
      deduct_lower: 0,
      lower_rate_bp: 0,
      lower_certificate: '',
      lower_limit: 0,
    }
  );
}

export async function saveTdsParty(db: Db, ledgerId: number, input: Partial<TdsParty>): Promise<TdsParty> {
  const cur = await tdsParty(db, ledgerId);
  const m = { ...cur, ...input };
  if (!(DEDUCTEE_TYPES as readonly string[]).includes(m.deductee_type)) throw new CoreError('invalid', 'Deductee type is invalid');
  m.resident = residentOf(m.deductee_type);
  if (m.nature_id && !(await nature(db, m.nature_id))) throw new CoreError('not_found', 'Nature of payment not found');
  await db.batch([
    {
      sql: `INSERT OR REPLACE INTO tds_party (ledger_id, deductee_type, resident, nature_id, deduct_lower, lower_rate_bp, lower_certificate, lower_limit)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [ledgerId, m.deductee_type, m.resident, m.nature_id ?? null, m.deduct_lower ? 1 : 0, Math.max(0, Math.trunc(m.lower_rate_bp)), clean(m.lower_certificate, 50), Math.max(0, Math.trunc(m.lower_limit))],
    },
  ]);
  return tdsParty(db, ledgerId);
}

export async function setDutyLedger(db: Db, ledgerId: number, kind: TaxKind, natureId: number | null): Promise<void> {
  if (natureId && !(await nature(db, natureId))) throw new CoreError('not_found', 'Nature of payment not found');
  await db.batch([{ sql: 'INSERT OR REPLACE INTO tds_duty_ledger (ledger_id, kind, nature_id) VALUES (?, ?, ?)', params: [ledgerId, kind, natureId] }]);
}

export async function dutyLedgerFor(db: Db, natureId: number): Promise<number | null> {
  const r = await one<{ ledger_id: number }>(db, 'SELECT ledger_id FROM tds_duty_ledger WHERE nature_id = ? ORDER BY ledger_id LIMIT 1', [natureId]);
  return r?.ledger_id ?? null;
}

export async function ensureDutyLedger(books: Books, natureId: number): Promise<number> {
  const existing = await dutyLedgerFor(books.db, natureId);
  if (existing) return existing;
  const n = await nature(books.db, natureId);
  if (!n) throw new CoreError('not_found', 'Nature of payment not found');
  const duties = (await books.groups()).find((g) => g.name === 'Duties & Taxes')!;
  const base = `${n.kind} on ${n.name}`.slice(0, 80);
  const name = (await books.ledgers()).some((l) => l.name.toLowerCase() === base.toLowerCase()) ? `${base} (${n.section})` : base;
  const l = await books.createLedger({ name, group_id: duties.id, duty_type: n.kind });
  await setDutyLedger(books.db, l.id, n.kind, natureId);
  return l.id;
}

export function isIndividual(deducteeType: string): boolean {
  return deducteeType.startsWith('Individual/HUF');
}

export function rateFor(n: Nature, deducteeType: string, hasPan: boolean): number {
  if (isIndividual(deducteeType)) return hasPan ? n.rate_ind_pan_bp : n.rate_ind_nopan_bp;
  return hasPan ? n.rate_oth_pan_bp : n.rate_oth_nopan_bp;
}

export interface TdsPlan {
  nature_id: number;
  kind: TaxKind;
  gross: number;
  base: number;
  rate_bp: number;
  tax: number;
  surcharge: number;
  cess: number;
  total: number;
  below_threshold: boolean;
  duty_ledger_id: number | null;
  deductee_type: string;
  resident: string;
  pan: string;
}

export function fyStartOf(date: string): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  return `${m >= 4 ? y : y - 1}-04-01`;
}

const roundRupee = (paise: number) => Math.round(paise / 100) * 100;

export interface PlanInput {
  party_id: number;
  nature_id: number;
  amount: number;
  date: string;
  exclude_voucher_id?: number;
}

export async function planTds(db: Db, input: PlanInput): Promise<TdsPlan> {
  if (!Number.isInteger(input.amount) || input.amount <= 0) throw new CoreError('invalid', 'Amount must be positive');
  if (!isIsoDate(input.date)) throw new CoreError('invalid', 'Date is invalid');
  const n = await nature(db, input.nature_id);
  if (!n) throw new CoreError('not_found', 'Nature of payment not found');
  const party = await one<{ pan: string }>(db, 'SELECT pan FROM ledgers WHERE id = ?', [input.party_id]);
  if (!party) throw new CoreError('not_found', 'Party ledger not found');
  const p = await tdsParty(db, input.party_id);
  const pan = party.pan.trim().toUpperCase();
  const hasPan = /^[A-Z]{5}\d{4}[A-Z]$/.test(pan);
  let rate = rateFor(n, p.deductee_type, hasPan);
  if (p.deduct_lower && hasPan && p.lower_rate_bp >= 0 && p.lower_certificate) rate = p.lower_rate_bp;

  const prior = await one<{ g: number; t: number }>(
    db,
    `SELECT COALESCE(SUM(gross), 0) AS g, COALESCE(SUM(tax), 0) AS t FROM tds_deductions
     WHERE party_id = ? AND nature_id = ? AND date >= ? AND date <= ? AND voucher_id <> ?`,
    [input.party_id, input.nature_id, fyStartOf(input.date), input.date, input.exclude_voucher_id ?? 0]
  );
  const before = prior?.g ?? 0;
  const total = before + input.amount;
  let base = input.amount;
  let below = false;
  const dutyLedger = await dutyLedgerFor(db, n.id);
  const finish = (b: number, tax: number, sur: number, cess: number, bel: boolean): TdsPlan => ({
    nature_id: n.id, kind: n.kind, gross: input.amount, base: b, rate_bp: rate, tax, surcharge: sur, cess,
    total: tax + sur + cess, below_threshold: bel, duty_ledger_id: dutyLedger, deductee_type: p.deductee_type, resident: p.resident, pan,
  });
  if (n.single_threshold) below = input.amount <= n.single_threshold && total <= n.threshold;
  else if (n.threshold) below = total <= n.threshold;
  if (below) return finish(0, 0, 0, 0, true);
  if (n.threshold && before <= n.threshold && total > n.threshold) base = total;
  let tax = roundRupee((base * rate) / 10000);
  if (base === total && before > 0) tax = Math.max(0, tax - (prior?.t ?? 0));
  const resident = p.resident === 'NonResident';
  const sur = resident ? roundRupee((tax * n.surcharge_bp) / 10000) : 0;
  const cess = resident ? roundRupee(((tax + sur) * n.cess_bp) / 10000) : 0;
  return finish(base, tax, sur, cess, false);
}

export async function recordDeduction(db: Db, voucherId: number, partyId: number, date: string, plan: TdsPlan): Promise<number> {
  const id = await nextId(db, 'tds_deductions');
  await db.batch([
    { sql: 'DELETE FROM tds_deductions WHERE voucher_id = ? AND nature_id = ?', params: [voucherId, plan.nature_id] },
    {
      sql: `INSERT INTO tds_deductions (id, voucher_id, party_id, nature_id, duty_ledger_id, kind, date, deductee_type, resident, pan, gross, base, rate_bp, tax, surcharge, cess, total)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [id, voucherId, partyId, plan.nature_id, plan.duty_ledger_id, plan.kind, date, plan.deductee_type, plan.resident, plan.pan, plan.gross, plan.base, plan.rate_bp, plan.tax, plan.surcharge, plan.cess, plan.total],
    },
  ]);
  return id;
}

export interface TdsOutstanding {
  deduction_id: number;
  voucher_id: number;
  date: string;
  number: string;
  type: string;
  party_id: number;
  party: string;
  nature_id: number;
  nature: string;
  section: string;
  deductee_type: string;
  amount: number;
  paid: number;
  pending: number;
  due_on: string;
  overdue_days: number;
}

export function dueDate(date: string): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  if (m === 3) return `${y}-04-30`;
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-07`;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

export async function tdsOutstandings(db: Db, from: string, to: string, kind: TaxKind = 'TDS', asOn?: string): Promise<TdsOutstanding[]> {
  const rows = await db.select<Omit<TdsOutstanding, 'pending' | 'due_on' | 'overdue_days'>>(
    `SELECT d.id AS deduction_id, d.voucher_id, d.date, v.number, t.name AS type, d.party_id, p.name AS party, d.nature_id, n.name AS nature, n.section,
            d.deductee_type, d.total AS amount,
            COALESCE((SELECT SUM(cl.amount) FROM tds_challan_lines cl WHERE cl.deduction_id = d.id), 0) AS paid
     FROM tds_deductions d
     JOIN vouchers v ON v.id = d.voucher_id AND v.cancelled = 0
     JOIN voucher_types t ON t.id = v.type_id
     JOIN ledgers p ON p.id = d.party_id
     JOIN tds_nature n ON n.id = d.nature_id
     WHERE d.kind = ? AND d.date >= ? AND d.date <= ?
     ORDER BY d.date, d.id`,
    [kind, from, to]
  );
  const today = asOn ?? to;
  return rows
    .map((r) => {
      const due = dueDate(r.date);
      return { ...r, pending: r.amount - r.paid, due_on: due, overdue_days: Math.max(0, daysBetween(due, today)) };
    })
    .filter((r) => r.pending > 0);
}

export interface NatureOutstanding {
  nature_id: number;
  nature: string;
  company: number;
  non_company: number;
  total: number;
}

export async function tdsOutstandingByNature(db: Db, from: string, to: string, kind: TaxKind = 'TDS'): Promise<NatureOutstanding[]> {
  const map = new Map<number, NatureOutstanding>();
  for (const r of await tdsOutstandings(db, from, to, kind)) {
    const cur = map.get(r.nature_id) ?? { nature_id: r.nature_id, nature: r.nature, company: 0, non_company: 0, total: 0 };
    if (isCompanyType(r.deductee_type)) cur.company += r.pending;
    else cur.non_company += r.pending;
    cur.total += r.pending;
    map.set(r.nature_id, cur);
  }
  return [...map.values()].sort((a, b) => a.nature.localeCompare(b.nature));
}

export interface PartyOutstanding {
  party_id: number;
  party: string;
  pan: string;
  deductee_type: string;
  pending: number;
  count: number;
}

export async function tdsOutstandingByParty(db: Db, from: string, to: string, kind: TaxKind = 'TDS'): Promise<PartyOutstanding[]> {
  const map = new Map<number, PartyOutstanding>();
  const pans = new Map((await db.select<{ id: number; pan: string }>('SELECT id, pan FROM ledgers')).map((l) => [l.id, l.pan]));
  for (const r of await tdsOutstandings(db, from, to, kind)) {
    const cur = map.get(r.party_id) ?? { party_id: r.party_id, party: r.party, pan: pans.get(r.party_id) ?? '', deductee_type: r.deductee_type, pending: 0, count: 0 };
    cur.pending += r.pending;
    cur.count += 1;
    map.set(r.party_id, cur);
  }
  return [...map.values()].sort((a, b) => a.party.localeCompare(b.party));
}

export interface TdsPaymentInput {
  date: string;
  bank_id: number;
  deduction_ids: number[];
  bsr_code?: string;
  challan_no?: string;
  challan_date?: string;
  cheque_no?: string;
  cheque_date?: string;
  bank_name?: string;
  branch?: string;
  narration?: string;
}

export function quarterOf(date: string): { from: string; to: string; q: number } {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  if (m >= 4 && m <= 6) return { q: 1, from: `${y}-04-01`, to: `${y}-06-30` };
  if (m >= 7 && m <= 9) return { q: 2, from: `${y}-07-01`, to: `${y}-09-30` };
  if (m >= 10) return { q: 3, from: `${y}-10-01`, to: `${y}-12-31` };
  return { q: 4, from: `${y}-01-01`, to: `${y}-03-31` };
}

export async function payTds(books: Books, input: TdsPaymentInput): Promise<{ voucher_id: number; challan_ids: number[] }> {
  const db = books.db;
  if (!isIsoDate(input.date)) throw new CoreError('invalid', 'Date is invalid');
  if (!input.deduction_ids.length) throw new CoreError('invalid', 'Select at least one deduction');
  const type = (await books.voucherTypes()).find((t) => t.parent === 'Payment');
  if (!type) throw new CoreError('not_found', 'Payment voucher type not found');
  const ph = input.deduction_ids.map(() => '?').join(',');
  const ds = await db.select<{ id: number; duty_ledger_id: number | null; nature_id: number; total: number; date: string; section: string; deductee_type: string; resident: string; kind: string; paid: number }>(
    `SELECT d.id, d.duty_ledger_id, d.nature_id, d.total, d.date, n.section, d.deductee_type, d.resident, d.kind,
            COALESCE((SELECT SUM(cl.amount) FROM tds_challan_lines cl WHERE cl.deduction_id = d.id), 0) AS paid
     FROM tds_deductions d JOIN tds_nature n ON n.id = d.nature_id WHERE d.id IN (${ph})`,
    input.deduction_ids
  );
  if (ds.length !== input.deduction_ids.length) throw new CoreError('not_found', 'Deduction not found');
  const groups = new Map<string, typeof ds>();
  for (const d of ds) {
    if (d.total - d.paid <= 0) throw new CoreError('conflict', 'Deduction is already paid');
    if (!d.duty_ledger_id) throw new CoreError('invalid', 'Duty ledger is missing for the nature of payment');
    const key = `${d.duty_ledger_id}|${d.section}|${isCompanyType(d.deductee_type) ? 'C' : 'N'}|${d.resident}|${d.kind}|${quarterOf(d.date).from}`;
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  const byLedger = new Map<number, number>();
  for (const d of ds) byLedger.set(d.duty_ledger_id!, (byLedger.get(d.duty_ledger_id!) ?? 0) + (d.total - d.paid));
  const total = [...byLedger.values()].reduce((s, v) => s + v, 0);
  const v = await books.createVoucher({
    type_id: type.id,
    date: input.date,
    reference: clean(input.challan_no, 50),
    narration: clean(input.narration ?? '', 500),
    entries: [...[...byLedger].map(([ledger_id, amt]) => ({ ledger_id, amount: amt })), { ledger_id: input.bank_id, amount: -total }],
  });
  let cid = await nextId(db, 'tds_challans');
  let lid = await nextId(db, 'tds_challan_lines');
  const stmts: Stmt[] = [];
  const ids: number[] = [];
  for (const list of groups.values()) {
    const f = list[0];
    const q = quarterOf(f.date);
    const amt = list.reduce((s, d) => s + (d.total - d.paid), 0);
    stmts.push({
      sql: `INSERT INTO tds_challans (id, voucher_id, kind, date, section, deductee_type, resident, bank_name, branch, cheque_no, cheque_date, bsr_code, challan_no, challan_date, quarter_from, quarter_to, amount)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [cid, v.id, f.kind, input.date, f.section, isCompanyType(f.deductee_type) ? 'Company' : 'Non Company', f.resident, clean(input.bank_name, 100), clean(input.branch, 100), clean(input.cheque_no, 30), input.cheque_date ?? '', clean(input.bsr_code, 10), clean(input.challan_no, 20), input.challan_date ?? input.date, q.from, q.to, amt],
    });
    for (const d of list) stmts.push({ sql: 'INSERT INTO tds_challan_lines (id, challan_id, deduction_id, amount) VALUES (?, ?, ?, ?)', params: [lid++, cid, d.id, d.total - d.paid] });
    ids.push(cid++);
  }
  await db.batch(stmts);
  return { voucher_id: v.id, challan_ids: ids };
}

export interface ChallanRow {
  id: number;
  date: string;
  particulars: string;
  quarter_from: string;
  quarter_to: string;
  section: string;
  deductee_type: string;
  resident: string;
  cheque_no: string;
  cheque_date: string;
  bsr_code: string;
  challan_no: string;
  challan_date: string;
  vch_no: string;
  amount: number;
  bank_name: string;
  branch: string;
  reconciled: number;
}

export async function tdsChallans(db: Db, from: string, to: string, onlyPending = false): Promise<ChallanRow[]> {
  return db.select<ChallanRow>(
    `SELECT c.id, c.date, COALESCE((SELECT l.name FROM tds_challan_lines cl JOIN tds_deductions d ON d.id = cl.deduction_id JOIN ledgers l ON l.id = d.duty_ledger_id WHERE cl.challan_id = c.id LIMIT 1), c.kind) AS particulars,
            c.quarter_from, c.quarter_to, c.section, c.deductee_type, c.resident, c.cheque_no, c.cheque_date, c.bsr_code, c.challan_no, c.challan_date,
            COALESCE(v.number, '') AS vch_no, c.amount, c.bank_name, c.branch, c.reconciled
     FROM tds_challans c LEFT JOIN vouchers v ON v.id = c.voucher_id
     WHERE c.date >= ? AND c.date <= ? ${onlyPending ? 'AND c.reconciled = 0' : ''}
     ORDER BY c.date, c.id`,
    [from, to]
  );
}

export async function reconcileChallan(db: Db, id: number, details: { bsr_code: string; challan_no: string; challan_date: string }): Promise<void> {
  if (!/^\d{7}$/.test(details.bsr_code)) throw new CoreError('invalid', 'BSR code must be 7 digits');
  if (!clean(details.challan_no)) throw new CoreError('invalid', 'Challan number is required');
  if (!isIsoDate(details.challan_date)) throw new CoreError('invalid', 'Challan date is invalid');
  await db.batch([
    { sql: 'UPDATE tds_challans SET bsr_code = ?, challan_no = ?, challan_date = ?, reconciled = 1 WHERE id = ?', params: [details.bsr_code, clean(details.challan_no, 20), details.challan_date, id] },
  ]);
}

export interface Form26QDeduction {
  date: string;
  party: string;
  pan: string;
  section: string;
  deductee_type: string;
  gross: number;
  base: number;
  rate_bp: number;
  tax: number;
  surcharge: number;
  cess: number;
  total: number;
  deposited: number;
  challan_no: string;
  bsr_code: string;
}

export interface Form26Q {
  quarter: number;
  from: string;
  to: string;
  tan: string;
  deductions: Form26QDeduction[];
  challans: ChallanRow[];
  totals: { gross: number; tax: number; total: number; deposited: number };
}

export async function form26Q(db: Db, from: string, to: string, kind: TaxKind = 'TDS'): Promise<Form26Q> {
  const co = await tdsCompany(db);
  const deductions = await db.select<Form26QDeduction>(
    `SELECT d.date, p.name AS party, d.pan, n.section, d.deductee_type, d.gross, d.base, d.rate_bp, d.tax, d.surcharge, d.cess, d.total,
            COALESCE((SELECT SUM(cl.amount) FROM tds_challan_lines cl WHERE cl.deduction_id = d.id), 0) AS deposited,
            COALESCE((SELECT GROUP_CONCAT(c.challan_no) FROM tds_challan_lines cl JOIN tds_challans c ON c.id = cl.challan_id WHERE cl.deduction_id = d.id), '') AS challan_no,
            COALESCE((SELECT GROUP_CONCAT(c.bsr_code) FROM tds_challan_lines cl JOIN tds_challans c ON c.id = cl.challan_id WHERE cl.deduction_id = d.id), '') AS bsr_code
     FROM tds_deductions d
     JOIN vouchers v ON v.id = d.voucher_id AND v.cancelled = 0
     JOIN ledgers p ON p.id = d.party_id
     JOIN tds_nature n ON n.id = d.nature_id
     WHERE d.kind = ? AND d.date >= ? AND d.date <= ? AND d.tax > 0
     ORDER BY n.section, d.date, d.id`,
    [kind, from, to]
  );
  const challans = await tdsChallans(db, from, to);
  return {
    quarter: quarterOf(from).q,
    from,
    to,
    tan: co.tan,
    deductions,
    challans,
    totals: {
      gross: deductions.reduce((s, d) => s + d.gross, 0),
      tax: deductions.reduce((s, d) => s + d.tax, 0),
      total: deductions.reduce((s, d) => s + d.total, 0),
      deposited: deductions.reduce((s, d) => s + d.deposited, 0),
    },
  };
}
