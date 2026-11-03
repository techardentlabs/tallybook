import { CoreError, one, type Db, type SqlValue, type Stmt } from './db.ts';
import { fmtDate, fyEnd, isIsoDate } from './util.ts';
import { groupSummary } from './reports.ts';
import { stockSummary } from './inventory.ts';
import { batchBalances } from './stockx.ts';
import { addDays, cascadeDeleteStmts, cloneDatabase, foreignKeys, insertStmts, runChunked, sqlDate } from './dbtools.ts';

export const SPLIT_MODES = ['From Split Date', 'Before Split Date', 'Into Two Companies'] as const;
export type SplitMode = (typeof SPLIT_MODES)[number];

export const BRS_CARRY_DAYS = 180;

export interface SplitInfo {
  name: string;
  books_from: string;
  fy_start: string;
  first_voucher: string | null;
  last_voucher: string | null;
  vouchers: number;
  suggested: string;
}

export interface VerifyIssue {
  kind: string;
  particulars: string;
  message: string;
}

export interface SplitCheck {
  first_closing: number;
  second_opening: number;
  difference: number;
  ledgers_checked: number;
  mismatches: string[];
  profit_transferred: number;
  stock_carried: number;
  bills_carried: number;
  brs_carried: number;
  batches_carried: number;
}

export interface SplitPartResult {
  part: 'before' | 'from';
  name: string;
  fy_start: string;
  books_from: string;
  vouchers: number;
  removed: number;
}

interface Company {
  name: string;
  fy_start: string;
  books_from: string;
}

async function company(db: Db): Promise<Company> {
  const c = await one<Company>(db, 'SELECT name, fy_start, books_from FROM company WHERE id = 1');
  if (!c) throw new CoreError('not_found', 'The company has no data');
  return c;
}

async function hasTable(db: Db, name: string): Promise<boolean> {
  return !!(await one(db, "SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", [name]));
}

export function nextFyStart(fyStart: string): string {
  return addDays(fyEnd(fyStart), 1);
}

export async function splitInfo(db: Db): Promise<SplitInfo> {
  const c = await company(db);
  const r = await one<{ a: string | null; b: string | null; n: number }>(db, 'SELECT MIN(date) AS a, MAX(date) AS b, COUNT(*) AS n FROM vouchers');
  let suggested = nextFyStart(c.fy_start);
  if (r?.b && r.b >= suggested) {
    while (nextFyStart(suggested) <= r.b) suggested = nextFyStart(suggested);
  }
  return { name: c.name, books_from: c.books_from, fy_start: c.fy_start, first_voucher: r?.a ?? null, last_voucher: r?.b ?? null, vouchers: r?.n ?? 0, suggested };
}

export function splitCompanyName(name: string, part: 'before' | 'from', splitFrom: string): string {
  return part === 'from' ? `${name} (from ${fmtDate(splitFrom)})` : `${name} (upto ${fmtDate(addDays(splitFrom, -1))})`;
}

export async function verifyCompanyData(db: Db): Promise<VerifyIssue[]> {
  const issues: VerifyIssue[] = [];
  const integrity = await db.select<{ integrity_check: string }>('PRAGMA integrity_check');
  for (const r of integrity) if (r.integrity_check !== 'ok') issues.push({ kind: 'Data', particulars: 'Company data file', message: r.integrity_check });
  const fk = await db.select<{ table: string; rowid: number; parent: string }>('PRAGMA foreign_key_check');
  for (const r of fk.slice(0, 200)) issues.push({ kind: 'Link', particulars: `${r.table} #${r.rowid}`, message: `Refers to a missing ${r.parent} record` });
  const unbalanced = await db.select<{ id: number; type: string; number: string; date: string; diff: number }>(
    `SELECT v.id, t.name AS type, v.number, v.date, SUM(e.amount) AS diff FROM vouchers v JOIN voucher_types t ON t.id = v.type_id JOIN entries e ON e.voucher_id = v.id
     GROUP BY v.id HAVING SUM(e.amount) != 0`
  );
  for (const v of unbalanced) issues.push({ kind: 'Voucher', particulars: `${v.type} No. ${v.number} (${fmtDate(v.date)})`, message: 'Debit and credit totals do not match' });
  const bills = await db.select<{ type: string; number: string; ledger: string }>(
    `SELECT t.name AS type, v.number, l.name AS ledger FROM entries e JOIN vouchers v ON v.id = e.voucher_id JOIN voucher_types t ON t.id = v.type_id JOIN ledgers l ON l.id = e.ledger_id
     WHERE EXISTS (SELECT 1 FROM bills b WHERE b.entry_id = e.id) AND e.amount != (SELECT SUM(b.amount) FROM bills b WHERE b.entry_id = e.id)`
  );
  for (const b of bills) issues.push({ kind: 'Bill-wise', particulars: `${b.type} No. ${b.number}`, message: `Bill allocations of ${b.ledger} do not match the entry amount` });
  const c = await one<{ books_from: string; fy_start: string }>(db, 'SELECT books_from, fy_start FROM company WHERE id = 1');
  if (c) {
    const early = await one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM vouchers WHERE date < ?', [c.books_from]);
    if (early?.n) issues.push({ kind: 'Voucher', particulars: `${early.n} voucher(s)`, message: `Dated before the books beginning date ${fmtDate(c.books_from)}` });
  }
  return issues;
}

async function rootNatures(db: Db): Promise<Map<number, string>> {
  const groups = await db.select<{ id: number; parent_id: number | null; nature: string }>('SELECT id, parent_id, nature FROM groups');
  const by = new Map(groups.map((g) => [g.id, g]));
  const out = new Map<number, string>();
  for (const g of groups) {
    let cur = g;
    let guard = 0;
    while (cur.parent_id && by.has(cur.parent_id) && guard++ < 100) cur = by.get(cur.parent_id)!;
    out.set(g.id, cur.nature);
  }
  return out;
}

async function groupDescendants(db: Db, names: string[]): Promise<Set<number>> {
  const groups = await db.select<{ id: number; name: string; parent_id: number | null }>('SELECT id, name, parent_id FROM groups');
  const out = new Set(groups.filter((g) => names.includes(g.name)).map((g) => g.id));
  let grew = true;
  while (grew) {
    grew = false;
    for (const g of groups) if (g.parent_id !== null && out.has(g.parent_id) && !out.has(g.id)) (out.add(g.id), (grew = true));
  }
  return out;
}

interface Carry {
  ledgers: { id: number; opening: number; closing: number; nominal: boolean; bill_by_bill: number }[];
  plId: number;
  bills: Map<number, { name: string; amount: number; bill_date: string; due_date: string }[]>;
  stock: { item_id: number; qty: number; value: number }[];
  openingStock: number;
  closingStock: number;
  batches: { item_id: number; godown_id: number; batch: string; mfg_date: string; expiry_date: string; qty: number }[];
  brs: { ledger_id: number; date: string; particulars: string; inst_no: string; inst_date: string; amount: number; bank_date: string; status: string }[];
  tbClosing: number;
}

export interface LedgerClosings {
  ledgers: { id: number; opening: number; closing: number; nominal: boolean; bill_by_bill: number }[];
  plId: number;
  bills: Map<number, { name: string; amount: number; bill_date: string; due_date: string }[]>;
  nominal: number;
}

export async function ledgerClosings(db: Db, splitFrom: string): Promise<LedgerClosings> {
  const upto = addDays(splitFrom, -1);
  const natures = await rootNatures(db);
  const raw = await db.select<{ id: number; group_id: number; opening: number; bill_by_bill: number; moved: number }>(
    `SELECT l.id, l.group_id, l.opening, l.bill_by_bill,
       COALESCE((SELECT SUM(e.amount) FROM entries e JOIN vouchers v ON v.id = e.voucher_id WHERE e.ledger_id = l.id AND v.date < ?), 0) AS moved
     FROM ledgers l ORDER BY l.id`,
    [splitFrom]
  );
  const ledgers = raw.map((r) => {
    const nature = natures.get(r.group_id) ?? 'Assets';
    return { id: r.id, opening: r.opening, closing: r.opening + r.moved, nominal: nature === 'Income' || nature === 'Expense', bill_by_bill: r.bill_by_bill };
  });
  const pl = await one<{ id: number }>(db, "SELECT id FROM ledgers WHERE name = 'Profit & Loss A/c' COLLATE NOCASE ORDER BY is_system DESC, id LIMIT 1");
  if (!pl) throw new CoreError('invalid', 'The Profit & Loss A/c ledger is missing. Verify the company data before splitting.');

  const billRows = await db.select<{ ledger_id: number; kind: string; name: string; amount: number; bill_date: string; due_date: string; vdate: string | null }>(
    `SELECT b.ledger_id, b.kind, b.name, b.amount, b.bill_date, b.due_date, v.date AS vdate
     FROM bills b LEFT JOIN entries e ON e.id = b.entry_id LEFT JOIN vouchers v ON v.id = e.voucher_id
     WHERE b.kind != 'onacc' AND (b.entry_id IS NULL OR v.date < ?) ORDER BY b.id`,
    [splitFrom]
  );
  const bills = new Map<number, { name: string; amount: number; bill_date: string; due_date: string }[]>();
  for (const l of ledgers.filter((x) => x.bill_by_bill && !x.nominal)) {
    const net = new Map<string, { name: string; amount: number; bill_date: string; due_date: string }>();
    for (const b of billRows.filter((r) => r.ledger_id === l.id)) {
      const k = b.name.toLowerCase();
      const cur = net.get(k) ?? { name: b.name, amount: 0, bill_date: '', due_date: '' };
      cur.amount += b.amount;
      if (b.kind === 'new' || b.kind === 'opening' || !cur.bill_date) {
        cur.bill_date = b.bill_date || b.vdate || cur.bill_date;
        if (b.due_date) cur.due_date = b.due_date;
      }
      net.set(k, cur);
    }
    const open = [...net.values()].filter((b) => b.amount !== 0);
    const billed = open.reduce((s, b) => s + b.amount, 0);
    const onAccount = l.closing - billed;
    if (!open.length) continue;
    if (onAccount !== 0) open.push({ name: 'On Account', amount: onAccount, bill_date: upto, due_date: '' });
    bills.set(l.id, open);
  }
  return { ledgers, plId: pl.id, bills, nominal: ledgers.filter((l) => l.nominal).reduce((s, l) => s + l.closing, 0) };
}

async function collectCarry(db: Db, splitFrom: string): Promise<Carry> {
  const c = await company(db);
  const upto = addDays(splitFrom, -1);
  const { ledgers, plId, bills } = await ledgerClosings(db, splitFrom);

  let stock: Carry['stock'] = [];
  let openingStock = 0;
  let closingStock = 0;
  let batches: Carry['batches'] = [];
  if (await one(db, 'SELECT 1 AS x FROM stock_items LIMIT 1')) {
    const st = await stockSummary(db, c.books_from, upto);
    stock = st.rows.map((r) => ({ item_id: r.item_id, qty: r.closing_qty, value: r.closing_value }));
    openingStock = st.opening_value;
    closingStock = st.closing_value;
    if (await hasTable(db, 'stockx_batches')) {
      batches = (await batchBalances(db, null, upto))
        .filter((b) => b.qty > 0)
        .map((b) => ({ item_id: b.item_id, godown_id: b.godown_id, batch: b.batch, mfg_date: b.mfg_date, expiry_date: b.expiry_date, qty: b.qty }));
    }
  }

  const brs: Carry['brs'] = [];
  if (await hasTable(db, 'bank_allocs')) {
    const bankGroups = await groupDescendants(db, ['Bank Accounts', 'Bank OD A/c']);
    const tracked = new Set(
      (await db.select<{ id: number }>(
        `SELECT ledger_id AS id FROM bank_allocs WHERE bank_date != '' UNION SELECT ledger_id FROM bank_config UNION SELECT ledger_id FROM bank_opening_brs`
      )).map((r) => r.id)
    );
    const cutoff = addDays(splitFrom, -BRS_CARRY_DAYS);
    const banks = (await db.select<{ id: number; group_id: number }>('SELECT id, group_id FROM ledgers')).filter((l) => bankGroups.has(l.group_id) && tracked.has(l.id));
    for (const b of banks) {
      const rows = await db.select<{ date: string; amount: number; type: string; number: string; other: string | null; inst_no: string | null; inst_date: string | null; bank_date: string | null; status: string | null }>(
        `SELECT v.date, e.amount, t.name AS type, v.number,
           (SELECT l2.name FROM entries e2 JOIN ledgers l2 ON l2.id = e2.ledger_id WHERE e2.voucher_id = v.id AND e2.ledger_id != e.ledger_id ORDER BY e2.seq LIMIT 1) AS other,
           a.inst_no, a.inst_date, a.bank_date, a.status
         FROM entries e JOIN vouchers v ON v.id = e.voucher_id JOIN voucher_types t ON t.id = v.type_id
         LEFT JOIN bank_allocs a ON a.voucher_id = v.id AND a.ledger_id = e.ledger_id
         WHERE e.ledger_id = ? AND v.date < ? AND v.date > ? AND (a.bank_date IS NULL OR a.bank_date = '' OR a.bank_date >= ?)
         ORDER BY v.date, v.id`,
        [b.id, splitFrom, cutoff, splitFrom]
      );
      for (const r of rows) {
        brs.push({
          ledger_id: b.id,
          date: r.date,
          particulars: (r.other ?? `${r.type} No. ${r.number}`).slice(0, 100),
          inst_no: r.inst_no ?? '',
          inst_date: r.inst_date ?? '',
          amount: r.amount,
          bank_date: r.bank_date && r.bank_date >= splitFrom ? r.bank_date : '',
          status: r.bank_date && r.bank_date >= splitFrom ? r.status ?? 'System Inferred' : 'System Inferred',
        });
      }
      const old = await db.select<{ date: string; particulars: string; inst_no: string; inst_date: string; amount: number; bank_date: string; status: string }>(
        "SELECT date, particulars, inst_no, inst_date, amount, bank_date, status FROM bank_opening_brs WHERE ledger_id = ? AND date > ? AND (bank_date = '' OR bank_date >= ?) ORDER BY date, id",
        [b.id, cutoff, splitFrom]
      );
      for (const r of old) brs.push({ ledger_id: b.id, ...r });
    }
  }

  const tb = await groupSummary(db, c.books_from, upto, null);
  return { ledgers, plId, bills, stock, openingStock, closingStock, batches, brs, tbClosing: tb.total.closing };
}

async function deleteVouchers(db: Db, where: string): Promise<number> {
  const n = (await one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM vouchers WHERE ${where}`))?.n ?? 0;
  if (!n) return 0;
  const refs = await foreignKeys(db);
  await runChunked(db, await cascadeDeleteStmts(db, 'vouchers', where, refs), 200);
  return n;
}

async function applyCarry(db: Db, carry: Carry, splitFrom: string): Promise<Omit<SplitCheck, 'first_closing' | 'second_opening' | 'difference' | 'ledgers_checked' | 'mismatches'>> {
  const nominal = carry.ledgers.filter((l) => l.nominal).reduce((s, l) => s + l.closing, 0);
  const transfer = nominal - carry.closingStock + carry.openingStock;
  const stmts: Stmt[] = [];
  for (const l of carry.ledgers) {
    let opening = l.nominal ? 0 : l.closing;
    if (l.id === carry.plId) opening = l.closing + transfer;
    if (opening !== l.opening) stmts.push({ sql: 'UPDATE ledgers SET opening = ? WHERE id = ?', params: [opening, l.id] });
  }
  stmts.push({ sql: "DELETE FROM bills WHERE entry_id IS NULL AND kind = 'opening'" });
  let bills = 0;
  const billRows: SqlValue[][] = [];
  for (const [ledger, list] of carry.bills) {
    const l = carry.ledgers.find((x) => x.id === ledger)!;
    const opening = l.id === carry.plId ? l.closing + transfer : l.closing;
    if (list.reduce((s, b) => s + b.amount, 0) !== opening) continue;
    for (const b of list) {
      billRows.push([ledger, 'opening', b.name, b.amount, b.bill_date, b.due_date]);
      bills += 1;
    }
  }
  stmts.push(...insertStmts('bills', ['ledger_id', 'kind', 'name', 'amount', 'bill_date', 'due_date'], billRows));
  for (const s of carry.stock) {
    const rate = s.qty ? Math.round((s.value * 1000) / s.qty) : 0;
    stmts.push({ sql: 'UPDATE stock_items SET opening_qty = ?, opening_value = ?, opening_rate = ? WHERE id = ?', params: [s.qty, s.value, rate, s.item_id] });
  }
  let batches = 0;
  if (await hasTable(db, 'stockx_batches')) {
    stmts.push({ sql: 'DELETE FROM stockx_batches WHERE movement_id IS NULL' });
    const base = ((await one<{ m: number }>(db, 'SELECT COALESCE(MAX(id), 0) AS m FROM stockx_batches'))?.m ?? 0) + 1;
    stmts.push(...insertStmts('stockx_batches', ['id', 'movement_id', 'item_id', 'godown_id', 'batch', 'mfg_date', 'expiry_date', 'qty'], carry.batches.map((b, i) => [base + i, null, b.item_id, b.godown_id, b.batch, b.mfg_date, b.expiry_date, b.qty])));
    batches = carry.batches.length;
  }
  let brs = 0;
  if (await hasTable(db, 'bank_opening_brs')) {
    stmts.push({ sql: 'DELETE FROM bank_opening_brs' });
    const rows = carry.brs.map((b, i) => [i + 1, b.ledger_id, b.date, b.particulars, b.inst_no, b.inst_date, b.amount, b.bank_date, b.status, null] as SqlValue[]);
    stmts.push(...insertStmts('bank_opening_brs', ['id', 'ledger_id', 'date', 'particulars', 'inst_no', 'inst_date', 'amount', 'bank_date', 'status', 'line_id'], rows));
    brs = rows.length;
    for (const id of new Set(carry.brs.map((b) => b.ledger_id))) {
      stmts.push({ sql: 'INSERT OR IGNORE INTO bank_config (ledger_id) VALUES (?)', params: [id] }, { sql: 'UPDATE bank_config SET recon_from = ? WHERE ledger_id = ?', params: [splitFrom, id] });
    }
  }
  stmts.push({ sql: 'UPDATE company SET fy_start = ?, books_from = ? WHERE id = 1', params: [splitFrom, splitFrom] });
  await runChunked(db, stmts, 200);
  return { profit_transferred: 0 - transfer, stock_carried: carry.closingStock, bills_carried: bills, brs_carried: brs, batches_carried: batches };
}

async function check(db: Db, carry: Carry, splitFrom: string): Promise<Pick<SplitCheck, 'first_closing' | 'second_opening' | 'difference' | 'ledgers_checked' | 'mismatches'>> {
  const tb = await groupSummary(db, splitFrom, splitFrom, null);
  const now = new Map((await db.select<{ id: number; name: string; opening: number }>('SELECT id, name, opening FROM ledgers')).map((l) => [l.id, l]));
  const mismatches: string[] = [];
  let checked = 0;
  for (const l of carry.ledgers) {
    if (l.nominal || l.id === carry.plId) continue;
    checked += 1;
    const n = now.get(l.id);
    if (!n || n.opening !== l.closing) mismatches.push(n?.name ?? `Ledger #${l.id}`);
  }
  return { first_closing: carry.tbClosing, second_opening: tb.total.opening, difference: tb.total.opening - carry.tbClosing, ledgers_checked: checked, mismatches };
}

export function validateSplitDate(info: { books_from: string }, splitFrom: string): void {
  if (!isIsoDate(splitFrom)) throw new CoreError('invalid', 'Enter a valid Split from date');
  if (splitFrom <= info.books_from) throw new CoreError('invalid', `Split from date must be after the books beginning date (${fmtDate(info.books_from)})`);
}

export async function buildLaterPart(src: Db, dest: Db, splitFrom: string, name?: string): Promise<{ part: SplitPartResult; check: SplitCheck }> {
  const info = await company(src);
  validateSplitDate(info, splitFrom);
  await cloneDatabase(src, dest);
  const carry = await collectCarry(dest, splitFrom);
  const removed = await deleteVouchers(dest, `date < ${sqlDate(splitFrom)}`);
  const applied = await applyCarry(dest, carry, splitFrom);
  const finalName = (name ?? splitCompanyName(info.name, 'from', splitFrom)).trim();
  await dest.batch([{ sql: 'UPDATE company SET name = ?, mailing_name = CASE WHEN mailing_name = ? OR mailing_name = \'\' THEN ? ELSE mailing_name END WHERE id = 1', params: [finalName, info.name, finalName] }]);
  const verified = await check(dest, carry, splitFrom);
  const vouchers = (await one<{ n: number }>(dest, 'SELECT COUNT(*) AS n FROM vouchers'))?.n ?? 0;
  return {
    part: { part: 'from', name: finalName, fy_start: splitFrom, books_from: splitFrom, vouchers, removed },
    check: { ...verified, ...applied },
  };
}

export async function buildEarlierPart(src: Db, dest: Db, splitFrom: string, name?: string): Promise<{ part: SplitPartResult; closing: number }> {
  const info = await company(src);
  validateSplitDate(info, splitFrom);
  await cloneDatabase(src, dest);
  const removed = await deleteVouchers(dest, `date >= ${sqlDate(splitFrom)}`);
  const finalName = (name ?? splitCompanyName(info.name, 'before', splitFrom)).trim();
  await dest.batch([{ sql: 'UPDATE company SET name = ?, mailing_name = CASE WHEN mailing_name = ? OR mailing_name = \'\' THEN ? ELSE mailing_name END WHERE id = 1', params: [finalName, info.name, finalName] }]);
  const tb = await groupSummary(dest, info.books_from, addDays(splitFrom, -1), null);
  const vouchers = (await one<{ n: number }>(dest, 'SELECT COUNT(*) AS n FROM vouchers'))?.n ?? 0;
  return { part: { part: 'before', name: finalName, fy_start: info.fy_start, books_from: info.books_from, vouchers, removed }, closing: tb.total.closing };
}
