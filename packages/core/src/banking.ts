import { CoreError, one, type Db, type SqlValue, type Stmt } from './db.ts';
import { todayIso } from './util.ts';

export const BANKING_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS bank_config (
    ledger_id INTEGER PRIMARY KEY REFERENCES ledgers(id) ON DELETE CASCADE,
    cheque_printing INTEGER NOT NULL DEFAULT 0,
    cheque_format TEXT NOT NULL DEFAULT '',
    print_cfg TEXT NOT NULL DEFAULT '{}',
    recon_from TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS cheque_books (
    id INTEGER PRIMARY KEY,
    ledger_id INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
    from_no INTEGER NOT NULL,
    to_no INTEGER NOT NULL,
    width INTEGER NOT NULL DEFAULT 6,
    name TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS bank_lines (
    id INTEGER PRIMARY KEY,
    ledger_id INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    narration TEXT NOT NULL DEFAULT '',
    inst_no TEXT NOT NULL DEFAULT '',
    deposit INTEGER NOT NULL DEFAULT 0,
    withdrawal INTEGER NOT NULL DEFAULT 0,
    balance INTEGER,
    status TEXT NOT NULL DEFAULT 'System Inferred',
    link_ref TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS bank_allocs (
    id INTEGER PRIMARY KEY,
    voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
    ledger_id INTEGER NOT NULL REFERENCES ledgers(id),
    inst_no TEXT NOT NULL DEFAULT '',
    inst_date TEXT NOT NULL DEFAULT '',
    favouring TEXT NOT NULL DEFAULT '',
    bank_date TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'System Inferred',
    printed INTEGER NOT NULL DEFAULT 0,
    post_dated INTEGER NOT NULL DEFAULT 0,
    pdc_issue_date TEXT NOT NULL DEFAULT '',
    pdc_note TEXT NOT NULL DEFAULT '',
    line_id INTEGER,
    UNIQUE (voucher_id, ledger_id)
  )`,
  `CREATE TABLE IF NOT EXISTS bank_cheques (
    id INTEGER PRIMARY KEY,
    ledger_id INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
    inst_no TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('blank','cancelled')),
    date TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    UNIQUE (ledger_id, inst_no)
  )`,
  `CREATE TABLE IF NOT EXISTS bank_opening_brs (
    id INTEGER PRIMARY KEY,
    ledger_id INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    particulars TEXT NOT NULL DEFAULT '',
    inst_no TEXT NOT NULL DEFAULT '',
    inst_date TEXT NOT NULL DEFAULT '',
    amount INTEGER NOT NULL,
    bank_date TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'System Inferred',
    line_id INTEGER
  )`,
];

export const RECON_STATUSES = ['System Inferred', 'Reconciled', 'On Hold', 'Processed'] as const;
export const CHEQUE_STATUSES = ['Available', 'Blank Cheque', 'Cancelled Cheque', 'Reconciled', 'Unreconciled'] as const;
export type ChequeStatus = (typeof CHEQUE_STATUSES)[number];

export async function ensureBanking(db: Db): Promise<void> {
  await db.batch(BANKING_SCHEMA.map((sql) => ({ sql })));
}

async function nextId(db: Db, table: string): Promise<number> {
  return ((await one<{ m: number }>(db, `SELECT COALESCE(MAX(id), 0) AS m FROM ${table}`))!.m) + 1;
}

const clean = (s: unknown, max = 200) => String(s ?? '').trim().slice(0, max);
const norm = (s: string) => s.trim().replace(/^0+(?=\d)/, '');

export interface BankLedger {
  id: number;
  name: string;
  account_no: string;
  opening: number;
}

export async function bankLedgers(db: Db): Promise<BankLedger[]> {
  return db.select<BankLedger>(
    `WITH RECURSIVE g(id) AS (
       SELECT id FROM groups WHERE name IN ('Bank Accounts', 'Bank OD A/c')
       UNION SELECT groups.id FROM groups JOIN g ON groups.parent_id = g.id
     )
     SELECT l.id, l.name, l.bank_account AS account_no, l.opening FROM ledgers l WHERE l.group_id IN (SELECT id FROM g) ORDER BY l.name`
  );
}

async function requireBank(db: Db, ledgerId: number): Promise<BankLedger> {
  const b = (await bankLedgers(db)).find((x) => x.id === ledgerId);
  if (!b) throw new CoreError('not_found', 'Bank ledger not found');
  return b;
}

export async function lastEntryDate(db: Db): Promise<string> {
  const r = await one<{ d: string | null }>(
    db,
    `SELECT MAX(v.date) AS d FROM vouchers v WHERE v.cancelled = 0 AND NOT EXISTS (SELECT 1 FROM bank_allocs a WHERE a.voucher_id = v.id AND a.post_dated = 1)`
  );
  return r?.d ?? todayIso();
}

export interface PrintConfig {
  width: number;
  height: number;
  cross_left: number;
  cross_top: number;
  date_top: number;
  date_left: number;
  date_style: string;
  date_separator: string;
  date_spacing: number;
  payee_top: number;
  payee_left: number;
  payee_width: number;
  words_top: number;
  words_gap: number;
  words_left1: number;
  words_left2: number;
  words_width: number;
  figures_top: number;
  figures_left: number;
  figures_width: number;
  print_company: boolean;
  company_name: string;
  show_inst_date: boolean;
}

export const DEFAULT_PRINT_CONFIG: PrintConfig = {
  width: 203,
  height: 93,
  cross_left: 50,
  cross_top: 12,
  date_top: 12,
  date_left: 151,
  date_style: 'd d m m y y y y',
  date_separator: '',
  date_spacing: 2.5,
  payee_top: 23.5,
  payee_left: 17,
  payee_width: 145,
  words_top: 44,
  words_gap: 8,
  words_left1: 31,
  words_left2: 14,
  words_width: 115,
  figures_top: 40,
  figures_left: 160,
  figures_width: 34,
  print_company: false,
  company_name: '',
  show_inst_date: true,
};

export interface BankConfig {
  ledger_id: number;
  cheque_printing: boolean;
  cheque_format: string;
  print: PrintConfig;
  recon_from: string;
}

export async function bankConfig(db: Db, ledgerId: number): Promise<BankConfig> {
  const r = await one<{ cheque_printing: number; cheque_format: string; print_cfg: string; recon_from: string }>(db, 'SELECT * FROM bank_config WHERE ledger_id = ?', [ledgerId]);
  let saved: Partial<PrintConfig> = {};
  try {
    saved = JSON.parse(r?.print_cfg ?? '{}');
  } catch {
    saved = {};
  }
  return { ledger_id: ledgerId, cheque_printing: !!r?.cheque_printing, cheque_format: r?.cheque_format ?? '', print: { ...DEFAULT_PRINT_CONFIG, ...saved }, recon_from: r?.recon_from ?? '' };
}

export async function saveBankConfig(db: Db, ledgerId: number, input: { cheque_printing?: boolean; cheque_format?: string; print?: Partial<PrintConfig>; recon_from?: string }): Promise<BankConfig> {
  await requireBank(db, ledgerId);
  const cur = await bankConfig(db, ledgerId);
  if (input.recon_from !== undefined && input.recon_from && !/^\d{4}-\d{2}-\d{2}$/.test(input.recon_from)) throw new CoreError('invalid', 'Reconciliation beginning date is invalid');
  const next = {
    cheque_printing: input.cheque_printing ?? cur.cheque_printing,
    cheque_format: input.cheque_format ?? cur.cheque_format,
    print: { ...cur.print, ...(input.print ?? {}) },
    recon_from: input.recon_from ?? cur.recon_from,
  };
  await db.batch([
    { sql: 'INSERT OR IGNORE INTO bank_config (ledger_id) VALUES (?)', params: [ledgerId] },
    {
      sql: 'UPDATE bank_config SET cheque_printing = ?, cheque_format = ?, print_cfg = ?, recon_from = ? WHERE ledger_id = ?',
      params: [next.cheque_printing ? 1 : 0, clean(next.cheque_format, 100), JSON.stringify(next.print), next.recon_from, ledgerId],
    },
  ]);
  return bankConfig(db, ledgerId);
}

export interface ChequeBook {
  id: number;
  ledger_id: number;
  from_no: number;
  to_no: number;
  width: number;
  name: string;
}

export const padCheque = (n: number, width: number) => String(n).padStart(width, '0');

export async function chequeBooks(db: Db, ledgerId: number): Promise<ChequeBook[]> {
  return db.select<ChequeBook>('SELECT * FROM cheque_books WHERE ledger_id = ? ORDER BY from_no', [ledgerId]);
}

export interface ChequeBookInput {
  from_no: string;
  to_no?: string;
  count?: number;
  name?: string;
}

export async function saveChequeBooks(db: Db, ledgerId: number, books: ChequeBookInput[]): Promise<ChequeBook[]> {
  await requireBank(db, ledgerId);
  const parsed: { from: number; to: number; width: number; name: string }[] = [];
  for (const b of books) {
    const fromText = clean(b.from_no, 20);
    if (!fromText && !b.to_no && !b.count) continue;
    if (!/^\d+$/.test(fromText)) throw new CoreError('invalid', 'From Number must be numeric');
    const from = Number(fromText);
    let to: number;
    if (b.to_no && /^\d+$/.test(b.to_no.trim())) to = Number(b.to_no.trim());
    else if (b.count && b.count > 0) to = from + Math.floor(b.count) - 1;
    else throw new CoreError('invalid', 'Enter To Number or Number of Cheques');
    if (to < from) throw new CoreError('invalid', 'To Number cannot be less than From Number');
    parsed.push({ from, to, width: fromText.length, name: clean(b.name, 100) });
  }
  const sorted = [...parsed].sort((a, b) => a.from - b.from);
  for (let i = 1; i < sorted.length; i++) if (sorted[i].from <= sorted[i - 1].to) throw new CoreError('conflict', 'Cheque ranges overlap');
  let id = await nextId(db, 'cheque_books');
  const stmts: Stmt[] = [{ sql: 'DELETE FROM cheque_books WHERE ledger_id = ?', params: [ledgerId] }];
  for (const p of sorted) stmts.push({ sql: 'INSERT INTO cheque_books (id, ledger_id, from_no, to_no, width, name) VALUES (?, ?, ?, ?, ?, ?)', params: [id++, ledgerId, p.from, p.to, p.width, p.name] });
  await db.batch(stmts);
  return chequeBooks(db, ledgerId);
}

export function inBook(book: ChequeBook, instNo: string): boolean {
  return /^\d+$/.test(instNo.trim()) && Number(instNo) >= book.from_no && Number(instNo) <= book.to_no;
}

async function usedInstNos(db: Db, ledgerId: number): Promise<Set<string>> {
  const a = await db.select<{ inst_no: string }>(
    `SELECT a.inst_no FROM bank_allocs a JOIN vouchers v ON v.id = a.voucher_id WHERE a.ledger_id = ? AND a.inst_no <> '' AND v.cancelled = 0`,
    [ledgerId]
  );
  const c = await db.select<{ inst_no: string }>('SELECT inst_no FROM bank_cheques WHERE ledger_id = ?', [ledgerId]);
  return new Set([...a, ...c].map((r) => norm(r.inst_no)));
}

export async function nextChequeNo(db: Db, ledgerId: number): Promise<{ inst_no: string; book: ChequeBook } | null> {
  const books = await chequeBooks(db, ledgerId);
  if (!books.length) return null;
  const used = await usedInstNos(db, ledgerId);
  for (const b of books) for (let n = b.from_no; n <= b.to_no; n++) if (!used.has(norm(padCheque(n, b.width)))) return { inst_no: padCheque(n, b.width), book: b };
  return null;
}

export interface BankAlloc {
  id: number;
  voucher_id: number;
  ledger_id: number;
  inst_no: string;
  inst_date: string;
  favouring: string;
  bank_date: string;
  status: string;
  printed: number;
  post_dated: number;
  pdc_issue_date: string;
  pdc_note: string;
  line_id: number | null;
}

export async function bankAlloc(db: Db, voucherId: number, ledgerId: number): Promise<BankAlloc | null> {
  return (await one<BankAlloc>(db, 'SELECT * FROM bank_allocs WHERE voucher_id = ? AND ledger_id = ?', [voucherId, ledgerId])) ?? null;
}

export interface BankAllocInput {
  voucher_id: number;
  ledger_id: number;
  inst_no?: string;
  inst_date?: string;
  favouring?: string;
  post_dated?: boolean;
  pdc_issue_date?: string;
  pdc_note?: string;
}

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

export async function saveBankAlloc(db: Db, input: BankAllocInput): Promise<BankAlloc> {
  await requireBank(db, input.ledger_id);
  const v = await one<{ id: number }>(db, 'SELECT id FROM vouchers WHERE id = ?', [input.voucher_id]);
  if (!v) throw new CoreError('not_found', 'Voucher not found');
  const instNo = clean(input.inst_no, 30);
  const instDate = clean(input.inst_date, 10);
  if (instDate && !isDate(instDate)) throw new CoreError('invalid', 'Instrument date is invalid');
  const pdcDate = clean(input.pdc_issue_date, 10);
  if (pdcDate && !isDate(pdcDate)) throw new CoreError('invalid', 'PDC issue date is invalid');
  if (instNo) {
    const dup = await one<{ id: number }>(
      db,
      `SELECT a.id FROM bank_allocs a JOIN vouchers v ON v.id = a.voucher_id WHERE a.ledger_id = ? AND a.voucher_id <> ? AND v.cancelled = 0 AND a.inst_no <> '' AND LTRIM(a.inst_no, '0') = LTRIM(?, '0')`,
      [input.ledger_id, input.voucher_id, instNo]
    );
    if (dup) throw new CoreError('conflict', `Instrument number ${instNo} is already used`);
  }
  const cur = await bankAlloc(db, input.voucher_id, input.ledger_id);
  const stmts: Stmt[] = [];
  if (instNo) stmts.push({ sql: "DELETE FROM bank_cheques WHERE ledger_id = ? AND kind = 'blank' AND LTRIM(inst_no, '0') = LTRIM(?, '0')", params: [input.ledger_id, instNo] });
  if (cur) {
    stmts.push({
      sql: 'UPDATE bank_allocs SET inst_no = ?, inst_date = ?, favouring = ?, post_dated = ?, pdc_issue_date = ?, pdc_note = ?, printed = CASE WHEN inst_no = ? THEN printed ELSE 0 END WHERE id = ?',
      params: [instNo, instDate, clean(input.favouring, 100), input.post_dated ? 1 : 0, pdcDate, clean(input.pdc_note, 200), instNo, cur.id],
    });
  } else {
    const id = await nextId(db, 'bank_allocs');
    stmts.push({
      sql: 'INSERT INTO bank_allocs (id, voucher_id, ledger_id, inst_no, inst_date, favouring, post_dated, pdc_issue_date, pdc_note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      params: [id, input.voucher_id, input.ledger_id, instNo, instDate, clean(input.favouring, 100), input.post_dated ? 1 : 0, pdcDate, clean(input.pdc_note, 200)],
    });
  }
  await db.batch(stmts);
  return (await bankAlloc(db, input.voucher_id, input.ledger_id))!;
}

export async function setPostDated(db: Db, voucherId: number, ledgerId: number, on: boolean): Promise<void> {
  const cur = await bankAlloc(db, voucherId, ledgerId);
  if (cur) await db.batch([{ sql: 'UPDATE bank_allocs SET post_dated = ? WHERE id = ?', params: [on ? 1 : 0, cur.id] }]);
  else if (on) await saveBankAlloc(db, { voucher_id: voucherId, ledger_id: ledgerId, post_dated: true });
}

export async function issueBlankCheque(db: Db, ledgerId: number, instNo: string, date = '', note = ''): Promise<void> {
  await requireBank(db, ledgerId);
  const no = clean(instNo, 30);
  if (!no) throw new CoreError('invalid', 'Instrument number is required');
  if (date && !isDate(date)) throw new CoreError('invalid', 'Date is invalid');
  if ((await usedInstNos(db, ledgerId)).has(norm(no))) throw new CoreError('conflict', `Cheque ${no} is already used`);
  await db.batch([{ sql: "INSERT INTO bank_cheques (id, ledger_id, inst_no, kind, date, note) VALUES (?, ?, ?, 'blank', ?, ?)", params: [await nextId(db, 'bank_cheques'), ledgerId, no, date, clean(note, 200)] }]);
}

export async function cancelCheque(db: Db, ledgerId: number, instNo: string, date = ''): Promise<void> {
  await requireBank(db, ledgerId);
  const no = clean(instNo, 30);
  if (!no) throw new CoreError('invalid', 'Instrument number is required');
  const stmts: Stmt[] = [
    { sql: "UPDATE bank_allocs SET inst_no = '', inst_date = '', printed = 0 WHERE ledger_id = ? AND LTRIM(inst_no, '0') = LTRIM(?, '0')", params: [ledgerId, no] },
    { sql: 'DELETE FROM bank_cheques WHERE ledger_id = ? AND LTRIM(inst_no, \'0\') = LTRIM(?, \'0\')', params: [ledgerId, no] },
    { sql: "INSERT INTO bank_cheques (id, ledger_id, inst_no, kind, date) VALUES (?, ?, ?, 'cancelled', ?)", params: [await nextId(db, 'bank_cheques'), ledgerId, no, date] },
  ];
  await db.batch(stmts);
}

export async function restoreCheque(db: Db, ledgerId: number, instNo: string): Promise<void> {
  await db.batch([{ sql: "DELETE FROM bank_cheques WHERE ledger_id = ? AND LTRIM(inst_no, '0') = LTRIM(?, '0')", params: [ledgerId, instNo] }]);
}

export interface BankTxn {
  ref: string;
  voucher_id: number | null;
  date: string;
  particulars: string;
  vch_type: string;
  vch_no: string;
  inst_no: string;
  inst_date: string;
  bank_date: string;
  status: string;
  deposit: number;
  withdrawal: number;
  link: 'linked' | 'manual' | '';
  line_id: number | null;
  post_dated: boolean;
}

async function booksTxns(db: Db, ledgerId: number, includePostDated: boolean): Promise<BankTxn[]> {
  const last = await lastEntryDate(db);
  const rows = await db.select<{
    voucher_id: number; date: string; number: string; vt: string; amount: number; particulars: string | null;
    inst_no: string | null; inst_date: string | null; bank_date: string | null; status: string | null; line_id: number | null; post_dated: number | null;
  }>(
    `SELECT v.id AS voucher_id, v.date, v.number, vt.name AS vt, SUM(e.amount) AS amount,
       (SELECT l2.name FROM entries e2 JOIN ledgers l2 ON l2.id = e2.ledger_id WHERE e2.voucher_id = v.id AND e2.ledger_id <> ? ORDER BY ABS(e2.amount) DESC, e2.seq LIMIT 1) AS particulars,
       a.inst_no, a.inst_date, a.bank_date, a.status, a.line_id, a.post_dated
     FROM entries e JOIN vouchers v ON v.id = e.voucher_id JOIN voucher_types vt ON vt.id = v.type_id
     LEFT JOIN bank_allocs a ON a.voucher_id = v.id AND a.ledger_id = e.ledger_id
     WHERE e.ledger_id = ? AND v.cancelled = 0
     GROUP BY v.id ORDER BY v.date, v.id`,
    [ledgerId, ledgerId]
  );
  return rows
    .filter((r) => includePostDated || !(r.post_dated && r.date > last))
    .map((r) => ({
      ref: `v:${r.voucher_id}`,
      voucher_id: r.voucher_id,
      date: r.date,
      particulars: r.particulars ?? '',
      vch_type: r.vt,
      vch_no: r.number,
      inst_no: r.inst_no ?? '',
      inst_date: r.inst_date || r.date,
      bank_date: r.bank_date ?? '',
      status: r.status ?? 'System Inferred',
      deposit: r.amount > 0 ? r.amount : 0,
      withdrawal: r.amount < 0 ? -r.amount : 0,
      link: r.line_id ? 'linked' : r.bank_date ? 'manual' : '',
      line_id: r.line_id,
      post_dated: !!r.post_dated,
    }));
}

async function openingTxns(db: Db, ledgerId: number): Promise<BankTxn[]> {
  const rows = await db.select<{ id: number; date: string; particulars: string; inst_no: string; inst_date: string; amount: number; bank_date: string; status: string; line_id: number | null }>(
    'SELECT * FROM bank_opening_brs WHERE ledger_id = ? ORDER BY date, id',
    [ledgerId]
  );
  return rows.map((r) => ({
    ref: `o:${r.id}`,
    voucher_id: null,
    date: r.date,
    particulars: r.particulars,
    vch_type: 'Opening BRS',
    vch_no: '',
    inst_no: r.inst_no,
    inst_date: r.inst_date || r.date,
    bank_date: r.bank_date,
    status: r.status,
    deposit: r.amount > 0 ? r.amount : 0,
    withdrawal: r.amount < 0 ? -r.amount : 0,
    link: r.line_id ? 'linked' : r.bank_date ? 'manual' : '',
    line_id: r.line_id,
    post_dated: false,
  }));
}

export interface ReconOptions {
  includePostDated?: boolean;
  kind?: 'both' | 'deposits' | 'withdrawals';
  status?: string;
}

async function allTxns(db: Db, ledgerId: number, includePostDated = false): Promise<{ txns: BankTxn[]; recon_from: string }> {
  const cfg = await bankConfig(db, ledgerId);
  const all = [...(await openingTxns(db, ledgerId)), ...(await booksTxns(db, ledgerId, includePostDated))];
  const txns = cfg.recon_from ? all.filter((t) => t.vch_type === 'Opening BRS' || t.date >= cfg.recon_from) : all;
  return { txns, recon_from: cfg.recon_from };
}

function kindOk(t: BankTxn, k: ReconOptions['kind']) {
  return k === 'deposits' ? t.deposit > 0 : k === 'withdrawals' ? t.withdrawal > 0 : true;
}

export async function unreconciledTxns(db: Db, ledgerId: number, to: string, opts: ReconOptions = {}): Promise<BankTxn[]> {
  const { txns } = await allTxns(db, ledgerId, !!opts.includePostDated);
  return txns.filter((t) => t.date <= to && (!t.bank_date || t.bank_date > to) && kindOk(t, opts.kind) && (!opts.status || t.status === opts.status));
}

export async function reconciledTxns(db: Db, ledgerId: number, from: string, to: string, opts: ReconOptions = {}): Promise<BankTxn[]> {
  const { txns } = await allTxns(db, ledgerId, !!opts.includePostDated);
  return txns.filter((t) => t.bank_date && t.bank_date >= from && t.bank_date <= to && kindOk(t, opts.kind) && (!opts.status || t.status === opts.status));
}

export interface StatementLine {
  id: number;
  ledger_id: number;
  date: string;
  narration: string;
  inst_no: string;
  deposit: number;
  withdrawal: number;
  balance: number | null;
  status: string;
  link_ref: string;
}

export async function statementLines(db: Db, ledgerId: number, from = '', to = '9999-12-31'): Promise<StatementLine[]> {
  return db.select<StatementLine>('SELECT * FROM bank_lines WHERE ledger_id = ? AND date >= ? AND date <= ? ORDER BY date, id', [ledgerId, from, to]);
}

export async function unreconciledLines(db: Db, ledgerId: number, to: string): Promise<StatementLine[]> {
  return db.select<StatementLine>("SELECT * FROM bank_lines WHERE ledger_id = ? AND link_ref = '' AND date <= ? ORDER BY date, id", [ledgerId, to]);
}

export interface Bucket {
  count: number;
  amount: number;
}

export interface ReconSummary {
  ledger_id: number;
  as_at: string;
  recon_from: string;
  books_balance: number;
  unreconciled_count: number;
  unreconciled_amount: number;
  books_withdrawals: Bucket;
  books_deposits: Bucket;
  bank_deposits: Bucket;
  bank_withdrawals: Bucket;
  subsequent: { withdrawals: Bucket; deposits: Bucket };
  expected_balance: number;
  bank_balance: number;
  bank_balance_date: string;
  difference: number;
}

const bucket = (rows: { amt: number }[]): Bucket => ({ count: rows.length, amount: rows.reduce((s, r) => s + r.amt, 0) });

export async function booksBalance(db: Db, ledgerId: number, asAt: string, includePostDated = false): Promise<number> {
  const b = await requireBank(db, ledgerId);
  const t = await booksTxns(db, ledgerId, includePostDated);
  return b.opening + t.filter((x) => x.date <= asAt).reduce((s, x) => s + x.deposit - x.withdrawal, 0);
}

export async function reconSummary(db: Db, ledgerId: number, asAt: string, opts: { includePostDated?: boolean } = {}): Promise<ReconSummary> {
  await requireBank(db, ledgerId);
  const { txns, recon_from } = await allTxns(db, ledgerId, !!opts.includePostDated);
  const inBooks = txns.filter((t) => t.date <= asAt && !t.bank_date);
  const later = txns.filter((t) => t.date <= asAt && t.bank_date > asAt);
  const lines = await unreconciledLines(db, ledgerId, asAt);
  const booksWd = bucket(inBooks.filter((t) => t.withdrawal > 0).map((t) => ({ amt: t.withdrawal })));
  const booksDep = bucket(inBooks.filter((t) => t.deposit > 0).map((t) => ({ amt: t.deposit })));
  const bankDep = bucket(lines.filter((l) => l.deposit > 0).map((l) => ({ amt: l.deposit })));
  const bankWd = bucket(lines.filter((l) => l.withdrawal > 0).map((l) => ({ amt: l.withdrawal })));
  const subWd = bucket(later.filter((t) => t.withdrawal > 0).map((t) => ({ amt: t.withdrawal })));
  const subDep = bucket(later.filter((t) => t.deposit > 0).map((t) => ({ amt: t.deposit })));
  const books = await booksBalance(db, ledgerId, asAt, !!opts.includePostDated);
  const expected = books + booksWd.amount - booksDep.amount + subWd.amount - subDep.amount + bankDep.amount - bankWd.amount;
  const last = await one<{ balance: number | null; date: string }>(db, 'SELECT balance, date FROM bank_lines WHERE ledger_id = ? AND date <= ? AND balance IS NOT NULL ORDER BY date DESC, id DESC LIMIT 1', [ledgerId, asAt]);
  const bankBalance = last?.balance ?? 0;
  return {
    ledger_id: ledgerId,
    as_at: asAt,
    recon_from,
    books_balance: books,
    unreconciled_count: booksWd.count + booksDep.count + bankDep.count + bankWd.count,
    unreconciled_amount: booksWd.amount - booksDep.amount + bankDep.amount - bankWd.amount,
    books_withdrawals: booksWd,
    books_deposits: booksDep,
    bank_deposits: bankDep,
    bank_withdrawals: bankWd,
    subsequent: { withdrawals: subWd, deposits: subDep },
    expected_balance: expected,
    bank_balance: bankBalance,
    bank_balance_date: last?.date ?? '',
    difference: expected - bankBalance,
  };
}

export interface ActivityRow {
  ledger_id: number;
  name: string;
  account_no: string;
  only_books: Bucket;
  only_bank: Bucket;
  books_balance: number;
  bank_balance: number;
  last_entry: string;
}

export async function bankingActivities(db: Db, asAt: string, opts: { includePostDated?: boolean } = {}): Promise<ActivityRow[]> {
  const out: ActivityRow[] = [];
  for (const b of await bankLedgers(db)) {
    const s = await reconSummary(db, b.id, asAt, opts);
    out.push({
      ledger_id: b.id,
      name: b.name,
      account_no: b.account_no,
      only_books: { count: s.books_withdrawals.count + s.books_deposits.count, amount: s.books_withdrawals.amount + s.books_deposits.amount },
      only_bank: { count: s.bank_deposits.count + s.bank_withdrawals.count, amount: s.bank_deposits.amount + s.bank_withdrawals.amount },
      books_balance: s.books_balance,
      bank_balance: s.bank_balance,
      last_entry: s.bank_balance_date,
    });
  }
  return out;
}

export async function saveOpeningBrs(db: Db, ledgerId: number, items: { date: string; particulars: string; inst_no?: string; inst_date?: string; deposit?: number; withdrawal?: number }[], reconFrom: string): Promise<void> {
  await requireBank(db, ledgerId);
  if (!isDate(reconFrom)) throw new CoreError('invalid', 'Reconciliation beginning date is invalid');
  let id = await nextId(db, 'bank_opening_brs');
  const stmts: Stmt[] = [{ sql: 'DELETE FROM bank_opening_brs WHERE ledger_id = ? AND bank_date = \'\' AND line_id IS NULL', params: [ledgerId] }];
  for (const it of items) {
    const amt = (it.deposit ?? 0) - (it.withdrawal ?? 0);
    if (!amt) continue;
    if (!isDate(it.date)) throw new CoreError('invalid', 'Date is invalid');
    if (it.date >= reconFrom) throw new CoreError('invalid', 'Opening BRS date must be before the reconciliation beginning date');
    stmts.push({
      sql: 'INSERT INTO bank_opening_brs (id, ledger_id, date, particulars, inst_no, inst_date, amount) VALUES (?, ?, ?, ?, ?, ?, ?)',
      params: [id++, ledgerId, it.date, clean(it.particulars, 100), clean(it.inst_no, 30), it.inst_date ?? '', amt],
    });
  }
  stmts.push({ sql: 'INSERT OR IGNORE INTO bank_config (ledger_id) VALUES (?)', params: [ledgerId] }, { sql: 'UPDATE bank_config SET recon_from = ? WHERE ledger_id = ?', params: [reconFrom, ledgerId] });
  await db.batch(stmts);
}

export async function openingBrs(db: Db, ledgerId: number): Promise<BankTxn[]> {
  return openingTxns(db, ledgerId);
}

function refParts(ref: string): { kind: 'v' | 'o'; id: number } {
  const m = /^([vo]):(\d+)$/.exec(ref);
  if (!m) throw new CoreError('invalid', 'Invalid transaction reference');
  return { kind: m[1] as 'v' | 'o', id: Number(m[2]) };
}

function reconStmt(ref: string, ledgerId: number, set: string, params: SqlValue[]): Stmt {
  const p = refParts(ref);
  return p.kind === 'v'
    ? { sql: `UPDATE bank_allocs SET ${set} WHERE voucher_id = ? AND ledger_id = ?`, params: [...params, p.id, ledgerId] }
    : { sql: `UPDATE bank_opening_brs SET ${set} WHERE id = ? AND ledger_id = ?`, params: [...params, p.id, ledgerId] };
}

async function ensureAllocs(db: Db, ledgerId: number, refs: string[]): Promise<void> {
  const need = refs.map(refParts).filter((p) => p.kind === 'v');
  let id = await nextId(db, 'bank_allocs');
  const stmts: Stmt[] = [];
  for (const p of need) {
    const ex = await one<{ id: number }>(db, 'SELECT id FROM bank_allocs WHERE voucher_id = ? AND ledger_id = ?', [p.id, ledgerId]);
    if (!ex) stmts.push({ sql: 'INSERT INTO bank_allocs (id, voucher_id, ledger_id) VALUES (?, ?, ?)', params: [id++, p.id, ledgerId] });
  }
  if (stmts.length) await db.batch(stmts);
}

export async function setBankDates(db: Db, ledgerId: number, items: { ref: string; bank_date: string | null }[]): Promise<number> {
  await requireBank(db, ledgerId);
  for (const it of items) if (it.bank_date && !isDate(it.bank_date)) throw new CoreError('invalid', 'Bank date is invalid');
  await ensureAllocs(db, ledgerId, items.map((i) => i.ref));
  const stmts: Stmt[] = [];
  for (const it of items) {
    stmts.push(
      reconStmt(it.ref, ledgerId, 'bank_date = ?, status = ?', [it.bank_date ?? '', it.bank_date ? 'Reconciled' : 'System Inferred']),
      reconStmt(it.ref, ledgerId, 'line_id = NULL', [])
    );
  }
  await db.batch(stmts);
  return items.length;
}

export async function setReconStatus(db: Db, ledgerId: number, refs: string[], status: string): Promise<void> {
  if (!(RECON_STATUSES as readonly string[]).includes(status)) throw new CoreError('invalid', 'Transaction status is invalid');
  await requireBank(db, ledgerId);
  await ensureAllocs(db, ledgerId, refs);
  const stmts: Stmt[] = [];
  for (const r of refs) {
    stmts.push(reconStmt(r, ledgerId, 'status = ?', [status]));
    if (status === 'System Inferred') stmts.push(reconStmt(r, ledgerId, "bank_date = '', line_id = NULL", []));
  }
  await db.batch(stmts);
}

export async function setLineStatus(db: Db, lineIds: number[], status: string): Promise<void> {
  if (!(RECON_STATUSES as readonly string[]).includes(status)) throw new CoreError('invalid', 'Transaction status is invalid');
  await db.batch(lineIds.map((id) => ({ sql: 'UPDATE bank_lines SET status = ? WHERE id = ?', params: [status, id] })));
}

export async function linkLine(db: Db, ledgerId: number, lineId: number, ref: string): Promise<void> {
  const line = await one<StatementLine>(db, 'SELECT * FROM bank_lines WHERE id = ? AND ledger_id = ?', [lineId, ledgerId]);
  if (!line) throw new CoreError('not_found', 'Bank entry not found');
  if (line.link_ref) throw new CoreError('conflict', 'Bank entry is already reconciled');
  const t = (await allTxns(db, ledgerId, true)).txns.find((x) => x.ref === ref);
  if (!t) throw new CoreError('not_found', 'Transaction not found');
  if (t.bank_date) throw new CoreError('conflict', 'Transaction is already reconciled');
  if (t.deposit - t.withdrawal !== line.deposit - line.withdrawal) throw new CoreError('invalid', 'Amounts do not match');
  await ensureAllocs(db, ledgerId, [ref]);
  await db.batch([
    reconStmt(ref, ledgerId, "bank_date = ?, status = 'Reconciled', line_id = ?", [line.date, lineId]),
    { sql: "UPDATE bank_lines SET link_ref = ?, status = 'Reconciled' WHERE id = ?", params: [ref, lineId] },
  ]);
}

export async function unlinkLines(db: Db, ledgerId: number, lineIds: number[]): Promise<number> {
  const stmts: Stmt[] = [];
  for (const id of lineIds) {
    const l = await one<StatementLine>(db, 'SELECT * FROM bank_lines WHERE id = ? AND ledger_id = ?', [id, ledgerId]);
    if (!l?.link_ref) continue;
    stmts.push(reconStmt(l.link_ref, ledgerId, "bank_date = '', status = 'System Inferred', line_id = NULL", []));
    stmts.push({ sql: "UPDATE bank_lines SET link_ref = '', status = 'System Inferred' WHERE id = ?", params: [id] });
  }
  if (stmts.length) await db.batch(stmts);
  return stmts.length / 2;
}

const lineAmt = (l: StatementLine) => l.deposit - l.withdrawal;
const txnAmt = (t: BankTxn) => t.deposit - t.withdrawal;
const dayDiff = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000;

export async function potentialMatches(db: Db, ledgerId: number, lineId: number, asAt = '9999-12-31'): Promise<BankTxn[]> {
  const line = await one<StatementLine>(db, 'SELECT * FROM bank_lines WHERE id = ? AND ledger_id = ?', [lineId, ledgerId]);
  if (!line) throw new CoreError('not_found', 'Bank entry not found');
  const cands = (await unreconciledTxns(db, ledgerId, asAt, { includePostDated: true })).filter((t) => txnAmt(t) === lineAmt(line));
  const score = (t: BankTxn) => (line.inst_no && norm(t.inst_no) === norm(line.inst_no) ? -1000 : 0) + dayDiff(t.date, line.date);
  return cands.sort((a, b) => score(a) - score(b));
}

export async function autoReconcile(db: Db, ledgerId: number, asAt = '9999-12-31'): Promise<{ matched: number; unmatched: number }> {
  await requireBank(db, ledgerId);
  const lines = await unreconciledLines(db, ledgerId, asAt);
  const pool = await unreconciledTxns(db, ledgerId, asAt, { includePostDated: true });
  const taken = new Set<string>();
  let matched = 0;
  for (const line of lines) {
    const exact = pool.find((t) => !taken.has(t.ref) && txnAmt(t) === lineAmt(line) && ((line.inst_no && t.inst_no && norm(t.inst_no) === norm(line.inst_no)) || (!line.inst_no && t.date === line.date)));
    if (!exact) continue;
    taken.add(exact.ref);
    await linkLine(db, ledgerId, line.id, exact.ref);
    matched++;
  }
  return { matched, unmatched: lines.length - matched };
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function parseBankDate(text: string): string | null {
  const s = text.trim();
  let y: number, m: number, d: number;
  let r = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(s);
  if (r) [y, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else if ((r = /^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2}|\d{4})$/.exec(s))) [d, m, y] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else if ((r = /^(\d{1,2})[-/. ]([A-Za-z]{3})[A-Za-z]*[-/. ,]+(\d{2}|\d{4})$/.exec(s))) {
    const mi = MON.indexOf(r[2].toLowerCase());
    if (mi < 0) return null;
    [d, m, y] = [Number(r[1]), mi + 1, Number(r[3])];
  } else return null;
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function parseMoney(text: string): number | null {
  const s = text.replace(/[,\s₹]|INR|Rs\.?/gi, '').replace(/(Dr|Cr)\.?$/i, '');
  if (!s) return 0;
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

export interface ImportResult {
  imported: number;
  skipped: number;
  rejected: { row: number; reason: string }[];
}

export async function importStatementCsv(db: Db, ledgerId: number, csv: string): Promise<ImportResult> {
  await requireBank(db, ledgerId);
  const rows = parseCsv(csv);
  let h = -1;
  let col = { date: -1, narr: -1, ref: -1, dr: -1, cr: -1, bal: -1 };
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const cells = rows[i].map((c) => c.trim().toLowerCase());
    const c = {
      date: cells.findIndex((x) => /^(txn|transaction|tran|posting)?\.?\s*date$|^date$/.test(x)),
      narr: cells.findIndex((x) => /narration|description|particulars|remarks|details/.test(x)),
      ref: cells.findIndex((x) => /chq|cheque|ref|instrument/.test(x)),
      dr: cells.findIndex((x) => /withdraw|debit|^dr\b/.test(x)),
      cr: cells.findIndex((x) => /deposit|credit|^cr\b/.test(x)),
      bal: cells.findIndex((x) => /balance/.test(x)),
    };
    if (c.date >= 0 && c.dr >= 0 && c.cr >= 0) {
      h = i;
      col = c;
      break;
    }
  }
  if (h < 0) throw new CoreError('invalid', 'Could not find the Date, Withdrawal and Deposit columns in the statement');
  const existing = await db.select<{ k: string }>(
    "SELECT date || '|' || narration || '|' || deposit || '|' || withdrawal || '|' || COALESCE(balance, '') AS k FROM bank_lines WHERE ledger_id = ?",
    [ledgerId]
  );
  const seen = new Map<string, number>();
  for (const e of existing) seen.set(e.k, (seen.get(e.k) ?? 0) + 1);
  const batchSeen = new Map<string, number>();
  let id = await nextId(db, 'bank_lines');
  const stmts: Stmt[] = [];
  const res: ImportResult = { imported: 0, skipped: 0, rejected: [] };
  for (let i = h + 1; i < rows.length; i++) {
    const r = rows[i];
    const dateText = (r[col.date] ?? '').trim();
    if (!dateText) continue;
    const date = parseBankDate(dateText);
    const wd = parseMoney(r[col.dr] ?? '');
    const dep = parseMoney(r[col.cr] ?? '');
    const bal = col.bal >= 0 && (r[col.bal] ?? '').trim() ? parseMoney(r[col.bal]) : null;
    if (!date) {
      res.rejected.push({ row: i + 1, reason: `Invalid date ${dateText}` });
      continue;
    }
    if (wd === null || dep === null || (col.bal >= 0 && (r[col.bal] ?? '').trim() && bal === null)) {
      res.rejected.push({ row: i + 1, reason: 'Invalid amount' });
      continue;
    }
    if (!wd && !dep) {
      res.rejected.push({ row: i + 1, reason: 'No amount' });
      continue;
    }
    const narration = clean(col.narr >= 0 ? r[col.narr] : '', 300);
    const key = `${date}|${narration}|${Math.abs(dep)}|${Math.abs(wd)}|${bal ?? ''}`;
    const n = (batchSeen.get(key) ?? 0) + 1;
    batchSeen.set(key, n);
    if (n <= (seen.get(key) ?? 0)) {
      res.skipped++;
      continue;
    }
    stmts.push({
      sql: 'INSERT INTO bank_lines (id, ledger_id, date, narration, inst_no, deposit, withdrawal, balance) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      params: [id++, ledgerId, date, narration, clean(col.ref >= 0 ? r[col.ref] : '', 30), Math.abs(dep), Math.abs(wd), bal],
    });
    res.imported++;
  }
  if (stmts.length) await db.batch(stmts);
  return res;
}

export interface ImportedRow {
  key: string;
  label: string;
  from: string;
  to: string;
  dep_count: number;
  dep_amount: number;
  wd_count: number;
  wd_amount: number;
  closing: number | null;
  reconciled: Bucket & { dep: number; wd: number };
  unreconciled: Bucket & { dep: number; wd: number };
}

export async function importedBankData(db: Db, ledgerId: number, from: string, to: string, view: 'daily' | 'monthly' | 'quarterly' = 'daily'): Promise<{ rows: ImportedRow[]; total: ImportedRow }> {
  const lines = await statementLines(db, ledgerId, '', to);
  const inRange = lines.filter((l) => l.date >= from);
  const keyOf = (d: string) => {
    if (view === 'daily') return d;
    const [y, m] = d.split('-').map(Number);
    if (view === 'monthly') return `${y}-${String(m).padStart(2, '0')}`;
    const q = Math.floor((m - 1) / 3);
    return `${y}-Q${q}`;
  };
  const groups = new Map<string, StatementLine[]>();
  for (const l of inRange) {
    const k = keyOf(l.date);
    groups.set(k, [...(groups.get(k) ?? []), l]);
  }
  const mk = (key: string, ls: StatementLine[]): ImportedRow => {
    const dates = ls.map((l) => l.date).sort();
    const lastBal = [...lines].filter((l) => l.date <= dates[dates.length - 1] && l.balance !== null).pop();
    const dep = ls.filter((l) => l.deposit > 0);
    const wd = ls.filter((l) => l.withdrawal > 0);
    const rec = ls.filter((l) => l.link_ref);
    const unrec = ls.filter((l) => !l.link_ref);
    const sum = (a: StatementLine[], f: (l: StatementLine) => number) => a.reduce((s, l) => s + f(l), 0);
    return {
      key,
      label: key,
      from: dates[0],
      to: dates[dates.length - 1],
      dep_count: dep.length,
      dep_amount: sum(dep, (l) => l.deposit),
      wd_count: wd.length,
      wd_amount: sum(wd, (l) => l.withdrawal),
      closing: lastBal?.balance ?? null,
      reconciled: { count: rec.length, amount: sum(rec, lineAmt), dep: sum(rec, (l) => l.deposit), wd: sum(rec, (l) => l.withdrawal) },
      unreconciled: { count: unrec.length, amount: sum(unrec, lineAmt), dep: sum(unrec, (l) => l.deposit), wd: sum(unrec, (l) => l.withdrawal) },
    };
  };
  let rows: ImportedRow[];
  if (view === 'daily') {
    const days: string[] = [];
    for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86400000) days.push(new Date(t).toISOString().slice(0, 10));
    rows = days.map((d) => {
      const ls = groups.get(d) ?? [];
      if (ls.length) return mk(d, ls);
      const lastBal = [...lines].filter((l) => l.date <= d && l.balance !== null).pop();
      const z = { count: 0, amount: 0, dep: 0, wd: 0 };
      return { key: d, label: d, from: d, to: d, dep_count: 0, dep_amount: 0, wd_count: 0, wd_amount: 0, closing: lastBal?.balance ?? null, reconciled: z, unreconciled: z };
    });
    rows.reverse();
  } else rows = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, ls]) => mk(k, ls));
  const total = mk('total', inRange.length ? inRange : []);
  if (!inRange.length) return { rows, total: { ...total, from, to, dep_count: 0, dep_amount: 0, wd_count: 0, wd_amount: 0 } };
  return { rows, total };
}

export interface ChequeCounts {
  available: number;
  unreconciled: number;
  reconciled: number;
  blank: number;
  cancelled: number;
  out_of_period: number;
  total: number;
}

export interface ChequeRegisterRow extends ChequeCounts {
  key: string;
  ledger_id: number;
  book_id: number | null;
  not_in_range: boolean;
  label: string;
  sub: string;
}

export interface ChequeItem {
  inst_no: string;
  status: ChequeStatus | 'Out of Period';
  date: string;
  inst_date: string;
  particulars: string;
  amount: number;
  voucher_id: number | null;
  ledger_id: number;
  book_id: number | null;
  printed: boolean;
}

async function chequeItems(db: Db, ledgerId: number, from: string, to: string): Promise<ChequeItem[]> {
  const books = await chequeBooks(db, ledgerId);
  const allocs = await db.select<{
    voucher_id: number; date: string; inst_no: string; inst_date: string; bank_date: string; amount: number; particulars: string | null; printed: number;
  }>(
    `SELECT a.voucher_id, v.date, a.inst_no, a.inst_date, a.bank_date, a.printed,
       COALESCE((SELECT SUM(e.amount) FROM entries e WHERE e.voucher_id = v.id AND e.ledger_id = a.ledger_id), 0) AS amount,
       (SELECT l2.name FROM entries e2 JOIN ledgers l2 ON l2.id = e2.ledger_id WHERE e2.voucher_id = v.id AND e2.ledger_id <> a.ledger_id ORDER BY ABS(e2.amount) DESC, e2.seq LIMIT 1) AS particulars
     FROM bank_allocs a JOIN vouchers v ON v.id = a.voucher_id
     WHERE a.ledger_id = ? AND a.inst_no <> '' AND v.cancelled = 0 ORDER BY v.date, v.id`,
    [ledgerId]
  );
  const out: ChequeItem[] = [];
  const bookOf = (no: string) => books.find((b) => inBook(b, no))?.id ?? null;
  for (const a of allocs) {
    const inPeriod = a.date >= from && a.date <= to;
    out.push({
      inst_no: a.inst_no,
      status: !inPeriod ? 'Out of Period' : a.bank_date ? 'Reconciled' : 'Unreconciled',
      date: a.date,
      inst_date: a.inst_date || a.date,
      particulars: a.particulars ?? '',
      amount: Math.abs(a.amount),
      voucher_id: a.voucher_id,
      ledger_id: ledgerId,
      book_id: bookOf(a.inst_no),
      printed: !!a.printed,
    });
  }
  const specials = await db.select<{ inst_no: string; kind: string; date: string; note: string }>('SELECT inst_no, kind, date, note FROM bank_cheques WHERE ledger_id = ? ORDER BY inst_no', [ledgerId]);
  for (const s of specials) {
    out.push({
      inst_no: s.inst_no,
      status: s.date && (s.date < from || s.date > to) ? 'Out of Period' : s.kind === 'blank' ? 'Blank Cheque' : 'Cancelled Cheque',
      date: s.date,
      inst_date: s.date,
      particulars: s.note,
      amount: 0,
      voucher_id: null,
      ledger_id: ledgerId,
      book_id: bookOf(s.inst_no),
      printed: false,
    });
  }
  const used = new Set(out.map((o) => norm(o.inst_no)));
  for (const b of books) for (let n = b.from_no; n <= b.to_no; n++) {
    const no = padCheque(n, b.width);
    if (!used.has(norm(no))) out.push({ inst_no: no, status: 'Available', date: '', inst_date: '', particulars: '', amount: 0, voucher_id: null, ledger_id: ledgerId, book_id: b.id, printed: false });
  }
  return out;
}

function countOf(items: ChequeItem[]): ChequeCounts {
  const c: ChequeCounts = { available: 0, unreconciled: 0, reconciled: 0, blank: 0, cancelled: 0, out_of_period: 0, total: items.length };
  for (const i of items) {
    if (i.status === 'Available') c.available++;
    else if (i.status === 'Unreconciled') c.unreconciled++;
    else if (i.status === 'Reconciled') c.reconciled++;
    else if (i.status === 'Blank Cheque') c.blank++;
    else if (i.status === 'Cancelled Cheque') c.cancelled++;
    else c.out_of_period++;
  }
  return c;
}

export async function chequeRegister(db: Db, from: string, to: string): Promise<ChequeRegisterRow[]> {
  const rows: ChequeRegisterRow[] = [];
  for (const b of await bankLedgers(db)) {
    const items = await chequeItems(db, b.id, from, to);
    if (!items.length) continue;
    rows.push({ key: `l${b.id}`, ledger_id: b.id, book_id: null, not_in_range: false, label: b.name, sub: '', ...countOf(items) });
  }
  return rows;
}

export async function chequeRangeRegister(db: Db, ledgerId: number, from: string, to: string): Promise<ChequeRegisterRow[]> {
  const items = await chequeItems(db, ledgerId, from, to);
  const books = await chequeBooks(db, ledgerId);
  const rows: ChequeRegisterRow[] = books.map((b) => ({
    key: `b${b.id}`,
    ledger_id: ledgerId,
    book_id: b.id,
    not_in_range: false,
    label: `${padCheque(b.from_no, b.width)}-${padCheque(b.to_no, b.width)}`,
    sub: b.name ? `(${b.name})` : '',
    ...countOf(items.filter((i) => i.book_id === b.id)),
  }));
  const out = items.filter((i) => i.book_id === null);
  if (out.length) rows.push({ key: 'nr', ledger_id: ledgerId, book_id: null, not_in_range: true, label: 'Not in Range', sub: '', ...countOf(out) });
  return rows;
}

export async function chequeList(db: Db, ledgerId: number, from: string, to: string, f: { status?: ChequeStatus | 'Out of Period'; book_id?: number | null; not_in_range?: boolean } = {}): Promise<ChequeItem[]> {
  const items = await chequeItems(db, ledgerId, from, to);
  const sel = items.filter((i) => (!f.status || i.status === f.status) && (f.book_id === undefined || f.book_id === null || i.book_id === f.book_id) && (!f.not_in_range || i.book_id === null));
  return sel.sort((a, b) => Number(norm(a.inst_no)) - Number(norm(b.inst_no)) || a.inst_no.localeCompare(b.inst_no));
}

export async function chequeAvailableNo(db: Db, ledgerId: number): Promise<string | null> {
  return (await nextChequeNo(db, ledgerId))?.inst_no ?? null;
}

export interface PrintRow {
  alloc_id: number;
  voucher_id: number;
  date: string;
  particulars: string;
  inst_no: string;
  inst_date: string;
  printed: boolean;
  amount: number;
  favouring: string;
}

export async function chequePrintingList(db: Db, ledgerId: number | null, from: string, to: string, includePrinted = false): Promise<PrintRow[]> {
  const rows = await db.select<{
    alloc_id: number; voucher_id: number; date: string; inst_no: string; inst_date: string; printed: number; favouring: string; amount: number; particulars: string | null;
  }>(
    `SELECT a.id AS alloc_id, a.voucher_id, v.date, a.inst_no, a.inst_date, a.printed, a.favouring,
       COALESCE((SELECT SUM(e.amount) FROM entries e WHERE e.voucher_id = v.id AND e.ledger_id = a.ledger_id), 0) AS amount,
       (SELECT l2.name FROM entries e2 JOIN ledgers l2 ON l2.id = e2.ledger_id WHERE e2.voucher_id = v.id AND e2.ledger_id <> a.ledger_id ORDER BY ABS(e2.amount) DESC, e2.seq LIMIT 1) AS particulars
     FROM bank_allocs a JOIN vouchers v ON v.id = a.voucher_id
     WHERE (? IS NULL OR a.ledger_id = ?) AND a.inst_no <> '' AND v.cancelled = 0 AND v.date >= ? AND v.date <= ? AND (? = 1 OR a.printed = 0)
     ORDER BY v.date, a.inst_no`,
    [ledgerId, ledgerId, from, to, includePrinted ? 1 : 0]
  );
  return rows
    .filter((r) => r.amount < 0)
    .map((r) => ({ alloc_id: r.alloc_id, voucher_id: r.voucher_id, date: r.date, particulars: r.particulars ?? '', inst_no: r.inst_no, inst_date: r.inst_date || r.date, printed: !!r.printed, amount: -r.amount, favouring: r.favouring }));
}

export async function markPrinted(db: Db, allocIds: number[], printed = true): Promise<void> {
  await db.batch(allocIds.map((id) => ({ sql: 'UPDATE bank_allocs SET printed = ? WHERE id = ?', params: [printed ? 1 : 0, id] })));
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function below1000(n: number): string {
  const parts: string[] = [];
  if (n >= 100) {
    parts.push(`${ONES[Math.floor(n / 100)]} Hundred`);
    n %= 100;
  }
  if (n >= 20) parts.push(n % 10 ? `${TENS[Math.floor(n / 10)]} ${ONES[n % 10]}` : TENS[Math.floor(n / 10)]);
  else if (n > 0) parts.push(ONES[n]);
  return parts.join(' ');
}

export function amountInWords(paise: number, lakhs = true): string {
  const rupees = Math.floor(Math.abs(paise) / 100);
  const ps = Math.abs(paise) % 100;
  if (!rupees && !ps) return 'Zero Only';
  const units: [number, string][] = lakhs
    ? [[10000000, 'Crore'], [100000, 'Lakh'], [1000, 'Thousand']]
    : [[1000000000, 'Billion'], [1000000, 'Million'], [1000, 'Thousand']];
  let n = rupees;
  const parts: string[] = [];
  for (const [size, name] of units) {
    if (n >= size) {
      const q = Math.floor(n / size);
      parts.push(`${below1000(q)} ${name}`);
      n %= size;
    }
  }
  if (n > 0) parts.push(below1000(n));
  let s = parts.join(' ');
  if (ps) s += `${s ? ' and ' : ''}${below1000(ps)} Paise`;
  return `${s} Only`;
}

export interface ChequePrint {
  alloc_id: number;
  date: string;
  payee: string;
  amount: number;
  words: string;
  inst_no: string;
  company_name: string;
  config: PrintConfig;
}

export async function chequePrintData(db: Db, allocId: number): Promise<ChequePrint> {
  const a = await one<BankAlloc>(db, 'SELECT * FROM bank_allocs WHERE id = ?', [allocId]);
  if (!a) throw new CoreError('not_found', 'Cheque not found');
  const cfg = await bankConfig(db, a.ledger_id);
  const row = (await chequePrintingList(db, a.ledger_id, '0000-01-01', '9999-12-31', true)).find((r) => r.alloc_id === allocId);
  if (!row) throw new CoreError('not_found', 'Cheque not found');
  const co = await one<{ name: string }>(db, 'SELECT name FROM company WHERE id = 1');
  return {
    alloc_id: allocId,
    date: cfg.print.show_inst_date ? row.inst_date : '',
    payee: row.favouring || row.particulars,
    amount: row.amount,
    words: amountInWords(row.amount),
    inst_no: row.inst_no,
    company_name: cfg.print.print_company ? cfg.print.company_name || co?.name || '' : '',
    config: cfg.print,
  };
}

export interface PostDatedRow {
  alloc_id: number;
  voucher_id: number;
  date: string;
  type: 'Received' | 'Issued';
  bank: string;
  ledger_id: number;
  particulars: string;
  inst_no: string;
  inst_date: string;
  status: 'Pending' | 'Regularized';
  amount: number;
  favouring: string;
  issue_date: string;
  note: string;
}

export async function postDatedList(db: Db, ledgerId: number | null, from: string, to: string, type?: 'Received' | 'Issued', showAll = false): Promise<PostDatedRow[]> {
  const last = await lastEntryDate(db);
  const rows = await db.select<{
    alloc_id: number; voucher_id: number; date: string; ledger_id: number; bank: string; inst_no: string; inst_date: string; favouring: string; pdc_issue_date: string; pdc_note: string; amount: number; particulars: string | null;
  }>(
    `SELECT a.id AS alloc_id, a.voucher_id, v.date, a.ledger_id, bl.name AS bank, a.inst_no, a.inst_date, a.favouring, a.pdc_issue_date, a.pdc_note,
       COALESCE((SELECT SUM(e.amount) FROM entries e WHERE e.voucher_id = v.id AND e.ledger_id = a.ledger_id), 0) AS amount,
       (SELECT l2.name FROM entries e2 JOIN ledgers l2 ON l2.id = e2.ledger_id WHERE e2.voucher_id = v.id AND e2.ledger_id <> a.ledger_id ORDER BY ABS(e2.amount) DESC, e2.seq LIMIT 1) AS particulars
     FROM bank_allocs a JOIN vouchers v ON v.id = a.voucher_id JOIN ledgers bl ON bl.id = a.ledger_id
     WHERE a.post_dated = 1 AND v.cancelled = 0 AND (? IS NULL OR a.ledger_id = ?) AND v.date >= ? AND v.date <= ? ORDER BY v.date, a.id`,
    [ledgerId, ledgerId, from, to]
  );
  return rows
    .map<PostDatedRow>((r) => ({
      alloc_id: r.alloc_id,
      voucher_id: r.voucher_id,
      date: r.date,
      type: r.amount >= 0 ? 'Received' : 'Issued',
      bank: r.bank,
      ledger_id: r.ledger_id,
      particulars: r.particulars ?? '',
      inst_no: r.inst_no,
      inst_date: r.inst_date || r.date,
      status: r.date > last ? 'Pending' : 'Regularized',
      amount: r.amount,
      favouring: r.favouring,
      issue_date: r.pdc_issue_date,
      note: r.pdc_note,
    }))
    .filter((r) => (!type || r.type === type) && (showAll || r.status === 'Pending'));
}

export interface PostDatedMonth {
  key: string;
  from: string;
  to: string;
  received: Bucket;
  issued: Bucket;
}

export async function postDatedSummary(db: Db, ledgerId: number | null, fyFrom: string, fyTo: string): Promise<{ rows: PostDatedMonth[]; total: { received: Bucket; issued: Bucket } }> {
  const list = await postDatedList(db, ledgerId, fyFrom, fyTo, undefined, true);
  const rows: PostDatedMonth[] = [];
  const [y0, m0] = fyFrom.split('-').map(Number);
  const [y1, m1] = fyTo.split('-').map(Number);
  for (let y = y0, m = m0; y < y1 || (y === y1 && m <= m1); m === 12 ? ((m = 1), y++) : m++) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    const inM = list.filter((r) => r.date.startsWith(key));
    const sum = (t: 'Received' | 'Issued'): Bucket => {
      const x = inM.filter((r) => r.type === t);
      return { count: x.length, amount: x.reduce((s, r) => s + Math.abs(r.amount), 0) };
    };
    const end = new Date(Date.UTC(y, m, 0)).getUTCDate();
    rows.push({ key, from: `${key}-01`, to: `${key}-${String(end).padStart(2, '0')}`, received: sum('Received'), issued: sum('Issued') });
  }
  const tot = (t: 'received' | 'issued'): Bucket => ({ count: rows.reduce((s, r) => s + r[t].count, 0), amount: rows.reduce((s, r) => s + r[t].amount, 0) });
  return { rows, total: { received: tot('received'), issued: tot('issued') } };
}

export async function alterPostDatedBank(db: Db, allocId: number, newLedgerId: number): Promise<void> {
  await requireBank(db, newLedgerId);
  const a = await one<BankAlloc>(db, 'SELECT * FROM bank_allocs WHERE id = ?', [allocId]);
  if (!a) throw new CoreError('not_found', 'Transaction not found');
  const bankEntries = await db.select<{ id: number }>('SELECT id FROM entries WHERE voucher_id = ? AND ledger_id = ?', [a.voucher_id, a.ledger_id]);
  const stmts: Stmt[] = bankEntries.map((e) => ({ sql: 'UPDATE entries SET ledger_id = ? WHERE id = ?', params: [newLedgerId, e.id] }));
  stmts.push({ sql: 'UPDATE bank_allocs SET ledger_id = ? WHERE id = ?', params: [newLedgerId, allocId] });
  await db.batch(stmts);
}

export async function updatePdcNote(db: Db, allocId: number, note: string): Promise<void> {
  await db.batch([{ sql: 'UPDATE bank_allocs SET pdc_note = ? WHERE id = ?', params: [clean(note, 200), allocId] }]);
}
