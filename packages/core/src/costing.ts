import { CoreError, one, type Db, type Stmt } from './db.ts';
import { newGuid } from './util.ts';
import { groupSummary } from './reports.ts';

export const PRIMARY_COST_CATEGORY = 'Primary Cost Category';

export const COSTING_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS cost_categories (
    id INTEGER PRIMARY KEY,
    guid TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    alias TEXT NOT NULL DEFAULT '',
    alloc_revenue INTEGER NOT NULL DEFAULT 1,
    alloc_non_revenue INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS cost_centres (
    id INTEGER PRIMARY KEY,
    guid TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    alias TEXT NOT NULL DEFAULT '',
    category_id INTEGER NOT NULL REFERENCES cost_categories(id),
    parent_id INTEGER REFERENCES cost_centres(id),
    show_opening INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS cost_allocations (
    id INTEGER PRIMARY KEY,
    entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    cost_centre_id INTEGER NOT NULL REFERENCES cost_centres(id),
    amount INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_cost_alloc_entry ON cost_allocations(entry_id)',
  'CREATE INDEX IF NOT EXISTS idx_cost_alloc_centre ON cost_allocations(cost_centre_id)',
  `CREATE TABLE IF NOT EXISTS budgets (
    id INTEGER PRIMARY KEY,
    guid TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    parent_id INTEGER REFERENCES budgets(id),
    from_date TEXT NOT NULL,
    to_date TEXT NOT NULL,
    set_groups INTEGER NOT NULL DEFAULT 0,
    set_ledgers INTEGER NOT NULL DEFAULT 0,
    set_cost_centres INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS budget_lines (
    id INTEGER PRIMARY KEY,
    budget_id INTEGER NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('group','ledger','cost_centre')),
    ref_id INTEGER NOT NULL,
    basis TEXT NOT NULL DEFAULT 'nett' CHECK (basis IN ('nett','closing')),
    amount INTEGER NOT NULL DEFAULT 0,
    exp_amount INTEGER NOT NULL DEFAULT 0,
    inc_amount INTEGER NOT NULL DEFAULT 0,
    closing_amount INTEGER NOT NULL DEFAULT 0
  )`,
  'CREATE INDEX IF NOT EXISTS idx_budget_lines_budget ON budget_lines(budget_id)',
  `CREATE TABLE IF NOT EXISTS interest_params (
    ledger_id INTEGER PRIMARY KEY REFERENCES ledgers(id) ON DELETE CASCADE,
    active INTEGER NOT NULL DEFAULT 1,
    based_on TEXT NOT NULL DEFAULT 'voucher_date',
    by_transaction INTEGER NOT NULL DEFAULT 0,
    override_params INTEGER NOT NULL DEFAULT 0,
    include_added INTEGER NOT NULL DEFAULT 0,
    include_deducted INTEGER NOT NULL DEFAULT 0,
    advanced INTEGER NOT NULL DEFAULT 0,
    override_advanced INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS interest_slabs (
    id INTEGER PRIMARY KEY,
    ledger_id INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    applicable_from TEXT NOT NULL DEFAULT '',
    rate_bp INTEGER NOT NULL,
    style TEXT NOT NULL DEFAULT 'calendar_year',
    balances TEXT NOT NULL DEFAULT 'all',
    applicability TEXT NOT NULL DEFAULT 'always',
    after_days INTEGER NOT NULL DEFAULT 0,
    calc_from TEXT NOT NULL DEFAULT 'due_date',
    rounding TEXT NOT NULL DEFAULT 'not_applicable'
  )`,
  'CREATE INDEX IF NOT EXISTS idx_interest_slabs_ledger ON interest_slabs(ledger_id)',
];

const clean = (s: unknown, max = 100) => String(s ?? '').trim().slice(0, max);

async function nextId(db: Db, table: string): Promise<number> {
  return ((await one<{ m: number }>(db, `SELECT COALESCE(MAX(id), 0) AS m FROM ${table}`))!.m) + 1;
}

export async function ensureCosting(db: Db): Promise<void> {
  await db.batch(COSTING_SCHEMA.map((sql) => ({ sql })));
  await db.batch([
    {
      sql: 'INSERT OR IGNORE INTO cost_categories (id, guid, name, alloc_revenue, alloc_non_revenue) VALUES (1, ?, ?, 1, 1)',
      params: [newGuid(), PRIMARY_COST_CATEGORY],
    },
  ]);
}

export interface CostCategory {
  id: number;
  guid: string;
  name: string;
  alias: string;
  alloc_revenue: number;
  alloc_non_revenue: number;
}

export interface CostCategoryInput {
  name: string;
  alias?: string;
  alloc_revenue?: boolean;
  alloc_non_revenue?: boolean;
}

export async function costCategories(db: Db): Promise<CostCategory[]> {
  return db.select<CostCategory>('SELECT * FROM cost_categories ORDER BY id');
}

export async function costCategory(db: Db, id: number): Promise<CostCategory | null> {
  return (await one<CostCategory>(db, 'SELECT * FROM cost_categories WHERE id = ?', [id])) ?? null;
}

async function ensureCategoryName(db: Db, name: string, exceptId = 0) {
  if (!name) throw new CoreError('invalid', 'Name is required');
  const dup = await one(db, 'SELECT 1 FROM cost_categories WHERE name = ? AND id != ?', [name, exceptId]);
  if (dup) throw new CoreError('conflict', `Cost Category ${name} already exists`);
}

export async function createCostCategory(db: Db, input: CostCategoryInput): Promise<CostCategory> {
  const name = clean(input.name);
  await ensureCategoryName(db, name);
  const id = await nextId(db, 'cost_categories');
  await db.batch([
    {
      sql: 'INSERT INTO cost_categories (id, guid, name, alias, alloc_revenue, alloc_non_revenue) VALUES (?, ?, ?, ?, ?, ?)',
      params: [id, newGuid(), name, clean(input.alias), input.alloc_revenue === false ? 0 : 1, input.alloc_non_revenue ? 1 : 0],
    },
  ]);
  return (await costCategory(db, id))!;
}

export async function updateCostCategory(db: Db, id: number, input: CostCategoryInput): Promise<CostCategory> {
  const cur = await costCategory(db, id);
  if (!cur) throw new CoreError('not_found', 'Cost Category not found');
  const name = id === 1 ? cur.name : clean(input.name);
  await ensureCategoryName(db, name, id);
  await db.batch([
    {
      sql: 'UPDATE cost_categories SET name = ?, alias = ?, alloc_revenue = ?, alloc_non_revenue = ? WHERE id = ?',
      params: [name, clean(input.alias), input.alloc_revenue ? 1 : 0, input.alloc_non_revenue ? 1 : 0, id],
    },
  ]);
  return (await costCategory(db, id))!;
}

export async function deleteCostCategory(db: Db, id: number): Promise<void> {
  if (id === 1) throw new CoreError('invalid', 'Primary Cost Category cannot be deleted');
  if (!(await costCategory(db, id))) throw new CoreError('not_found', 'Cost Category not found');
  const used = await one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM cost_centres WHERE category_id = ?', [id]);
  if (used && used.n > 0) throw new CoreError('conflict', 'Cost Category is in use by Cost Centres and cannot be deleted');
  await db.batch([{ sql: 'DELETE FROM cost_categories WHERE id = ?', params: [id] }]);
}

export interface CostCentre {
  id: number;
  guid: string;
  name: string;
  alias: string;
  category_id: number;
  category: string;
  parent_id: number | null;
  parent: string | null;
  show_opening: number;
}

export interface CostCentreInput {
  name: string;
  alias?: string;
  category_id?: number;
  parent_id?: number | null;
  show_opening?: boolean;
}

const CENTRE_SELECT = `SELECT c.id, c.guid, c.name, c.alias, c.category_id, k.name AS category, c.parent_id, p.name AS parent, c.show_opening
  FROM cost_centres c JOIN cost_categories k ON k.id = c.category_id LEFT JOIN cost_centres p ON p.id = c.parent_id`;

export async function costCentres(db: Db): Promise<CostCentre[]> {
  return db.select<CostCentre>(`${CENTRE_SELECT} ORDER BY c.name COLLATE NOCASE`);
}

export async function costCentre(db: Db, id: number): Promise<CostCentre | null> {
  return (await one<CostCentre>(db, `${CENTRE_SELECT} WHERE c.id = ?`, [id])) ?? null;
}

async function validateCentre(db: Db, input: CostCentreInput, exceptId: number) {
  const name = clean(input.name);
  if (!name) throw new CoreError('invalid', 'Name is required');
  const dup = await one(db, 'SELECT 1 FROM cost_centres WHERE name = ? AND id != ?', [name, exceptId]);
  if (dup) throw new CoreError('conflict', `Cost Centre ${name} already exists`);
  const category = input.category_id ?? 1;
  if (!(await costCategory(db, category))) throw new CoreError('not_found', 'Cost Category not found');
  const parent = input.parent_id || null;
  if (parent) {
    if (!(await costCentre(db, parent))) throw new CoreError('not_found', 'Parent Cost Centre not found');
    let cur: number | null = parent;
    while (cur) {
      if (cur === exceptId) throw new CoreError('invalid', 'A Cost Centre cannot be placed under itself');
      cur = (await one<{ p: number | null }>(db, 'SELECT parent_id AS p FROM cost_centres WHERE id = ?', [cur]))?.p ?? null;
    }
  }
  return { name, category, parent };
}

export async function createCostCentre(db: Db, input: CostCentreInput): Promise<CostCentre> {
  const v = await validateCentre(db, input, 0);
  const id = await nextId(db, 'cost_centres');
  await db.batch([
    {
      sql: 'INSERT INTO cost_centres (id, guid, name, alias, category_id, parent_id, show_opening) VALUES (?, ?, ?, ?, ?, ?, ?)',
      params: [id, newGuid(), v.name, clean(input.alias), v.category, v.parent, input.show_opening ? 1 : 0],
    },
  ]);
  return (await costCentre(db, id))!;
}

export async function updateCostCentre(db: Db, id: number, input: CostCentreInput): Promise<CostCentre> {
  if (!(await costCentre(db, id))) throw new CoreError('not_found', 'Cost Centre not found');
  const v = await validateCentre(db, input, id);
  await db.batch([
    {
      sql: 'UPDATE cost_centres SET name = ?, alias = ?, category_id = ?, parent_id = ?, show_opening = ? WHERE id = ?',
      params: [v.name, clean(input.alias), v.category, v.parent, input.show_opening ? 1 : 0, id],
    },
  ]);
  return (await costCentre(db, id))!;
}

export async function deleteCostCentre(db: Db, id: number): Promise<void> {
  if (!(await costCentre(db, id))) throw new CoreError('not_found', 'Cost Centre not found');
  const used = await one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM cost_allocations WHERE cost_centre_id = ?', [id]);
  if (used && used.n > 0) throw new CoreError('conflict', 'Cost Centre has allocations and cannot be deleted');
  const kids = await one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM cost_centres WHERE parent_id = ?', [id]);
  if (kids && kids.n > 0) throw new CoreError('conflict', 'Cost Centre has sub Cost Centres and cannot be deleted');
  await db.batch([
    { sql: "DELETE FROM budget_lines WHERE kind = 'cost_centre' AND ref_id = ?", params: [id] },
    { sql: 'DELETE FROM cost_centres WHERE id = ?', params: [id] },
  ]);
}

async function descendantIds(db: Db, id: number, includeChildren = true): Promise<number[]> {
  if (!includeChildren) return [id];
  const rows = await db.select<{ id: number; parent_id: number | null }>('SELECT id, parent_id FROM cost_centres');
  const out = [id];
  for (let i = 0; i < out.length; i++) for (const r of rows) if (r.parent_id === out[i] && !out.includes(r.id)) out.push(r.id);
  return out;
}

export interface AllocationInput {
  cost_centre_id: number;
  amount: number;
}

export interface AllocationRow extends AllocationInput {
  id: number;
  entry_id: number;
  cost_centre: string;
  category_id: number;
  category: string;
}

export async function validateAllocations(db: Db, entryAmount: number, lines: AllocationInput[]): Promise<void> {
  const live = lines.filter((l) => l.amount !== 0);
  if (!live.length) return;
  const sign = entryAmount < 0 ? -1 : 1;
  const byCategory = new Map<number, number>();
  for (const l of live) {
    const c = await costCentre(db, l.cost_centre_id);
    if (!c) throw new CoreError('not_found', 'Cost Centre not found');
    if (l.amount * sign < 0) throw new CoreError('invalid', 'Cost allocation must be on the same side as the ledger amount');
    byCategory.set(c.category_id, (byCategory.get(c.category_id) ?? 0) + l.amount);
  }
  for (const [cat, sum] of byCategory) {
    if (sum !== entryAmount) {
      const name = (await costCategory(db, cat))?.name ?? '';
      throw new CoreError('invalid', `Cost Break-up Total does not match for ledger (under Category ${name})`);
    }
  }
}

export function allocationStmts(entryId: number, lines: AllocationInput[]): Stmt[] {
  const stmts: Stmt[] = [{ sql: 'DELETE FROM cost_allocations WHERE entry_id = ?', params: [entryId] }];
  for (const l of lines) {
    if (!l.amount) continue;
    stmts.push({
      sql: 'INSERT INTO cost_allocations (id, entry_id, cost_centre_id, amount) VALUES ((SELECT COALESCE(MAX(id), 0) + 1 FROM cost_allocations), ?, ?, ?)',
      params: [entryId, l.cost_centre_id, l.amount],
    });
  }
  return stmts;
}

export async function saveEntryAllocations(db: Db, entryId: number, lines: AllocationInput[]): Promise<void> {
  const e = await one<{ amount: number }>(db, 'SELECT amount FROM entries WHERE id = ?', [entryId]);
  if (!e) throw new CoreError('not_found', 'Entry not found');
  await validateAllocations(db, e.amount, lines);
  await db.batch(allocationStmts(entryId, lines));
}

export async function entryAllocations(db: Db, entryIds: number[]): Promise<Map<number, AllocationRow[]>> {
  const out = new Map<number, AllocationRow[]>();
  if (!entryIds.length) return out;
  const rows = await db.select<AllocationRow>(
    `SELECT a.id, a.entry_id, a.cost_centre_id, a.amount, c.name AS cost_centre, c.category_id, k.name AS category
     FROM cost_allocations a JOIN cost_centres c ON c.id = a.cost_centre_id JOIN cost_categories k ON k.id = c.category_id
     WHERE a.entry_id IN (${entryIds.map(() => '?').join(',')}) ORDER BY a.id`,
    entryIds
  );
  for (const r of rows) out.set(r.entry_id, [...(out.get(r.entry_id) ?? []), r]);
  return out;
}

export async function voucherAllocations(db: Db, voucherId: number): Promise<Map<number, AllocationRow[]>> {
  const ids = (await db.select<{ id: number }>('SELECT id FROM entries WHERE voucher_id = ? ORDER BY seq', [voucherId])).map((r) => r.id);
  return entryAllocations(db, ids);
}

export interface CostRow {
  kind: 'category' | 'group' | 'own' | 'centre';
  id: number;
  name: string;
  depth: number;
  opening: number;
  debit: number;
  credit: number;
  closing: number;
}

interface Sums {
  opening: number;
  debit: number;
  credit: number;
}

async function centreSums(db: Db, from: string, to: string): Promise<Map<number, Sums>> {
  const rows = await db.select<{ id: number; pre: number; dr: number; cr: number }>(
    `SELECT a.cost_centre_id AS id,
       COALESCE(SUM(CASE WHEN v.date < ? THEN a.amount ELSE 0 END), 0) AS pre,
       COALESCE(SUM(CASE WHEN v.date >= ? AND v.date <= ? AND a.amount > 0 THEN a.amount ELSE 0 END), 0) AS dr,
       COALESCE(SUM(CASE WHEN v.date >= ? AND v.date <= ? AND a.amount < 0 THEN -a.amount ELSE 0 END), 0) AS cr
     FROM cost_allocations a JOIN entries e ON e.id = a.entry_id JOIN vouchers v ON v.id = e.voucher_id
     WHERE v.cancelled = 0 AND v.date <= ? GROUP BY a.cost_centre_id`,
    [from, from, to, from, to, to]
  );
  const shows = new Set((await db.select<{ id: number }>('SELECT id FROM cost_centres WHERE show_opening = 1')).map((r) => r.id));
  const m = new Map<number, Sums>();
  for (const r of rows) m.set(r.id, { opening: shows.has(r.id) ? r.pre : 0, debit: r.dr, credit: r.cr });
  return m;
}

function treeRows(centres: CostCentre[], sums: Map<number, Sums>, depth: number, roots: CostCentre[], out: CostRow[]) {
  const kids = (id: number) => centres.filter((c) => c.parent_id === id);
  const total = (id: number): Sums => {
    const own = sums.get(id) ?? { opening: 0, debit: 0, credit: 0 };
    return kids(id).reduce((t, k) => {
      const s = total(k.id);
      return { opening: t.opening + s.opening, debit: t.debit + s.debit, credit: t.credit + s.credit };
    }, { ...own });
  };
  const emit = (c: CostCentre, d: number) => {
    const t = total(c.id);
    const children = kids(c.id);
    out.push({ kind: children.length ? 'group' : 'centre', id: c.id, name: c.name, depth: d, ...t, closing: t.opening + t.debit - t.credit });
    if (children.length) {
      const own = sums.get(c.id);
      if (own && (own.debit || own.credit || own.opening)) out.push({ kind: 'own', id: c.id, name: c.name, depth: d + 1, ...own, closing: own.opening + own.debit - own.credit });
      for (const k of children) emit(k, d + 1);
    }
  };
  for (const r of roots) emit(r, depth);
}

export interface CostSummary {
  from: string;
  to: string;
  rows: CostRow[];
  total: { debit: number; credit: number; closing: number };
}

export async function costCentreSummary(db: Db, from: string, to: string, categoryId: number | null = null): Promise<CostSummary> {
  const centres = await costCentres(db);
  const sums = await centreSums(db, from, to);
  const ids = new Set(centres.map((c) => c.id));
  const roots = centres.filter((c) => (!c.parent_id || !ids.has(c.parent_id)) && (categoryId === null || c.category_id === categoryId));
  const rows: CostRow[] = [];
  treeRows(centres, sums, 0, roots, rows);
  const top = rows.filter((r) => r.depth === 0);
  const total = top.reduce((t, r) => ({ debit: t.debit + r.debit, credit: t.credit + r.credit, closing: t.closing + r.closing }), { debit: 0, credit: 0, closing: 0 });
  return { from, to, rows, total };
}

export async function costCategorySummary(db: Db, from: string, to: string): Promise<CostSummary> {
  const cats = await costCategories(db);
  const centres = await costCentres(db);
  const sums = await centreSums(db, from, to);
  const rows: CostRow[] = [];
  const total = { debit: 0, credit: 0, closing: 0 };
  for (const cat of cats) {
    const mine = centres.filter((c) => c.category_id === cat.id);
    if (!mine.length) continue;
    const inCat = new Set(mine.map((c) => c.id));
    const roots = mine.filter((c) => !c.parent_id || !inCat.has(c.parent_id));
    const body: CostRow[] = [];
    treeRows(mine, sums, 1, roots, body);
    const top = body.filter((r) => r.depth === 1);
    const t = top.reduce((x, r) => ({ opening: x.opening + r.opening, debit: x.debit + r.debit, credit: x.credit + r.credit, closing: x.closing + r.closing }), { opening: 0, debit: 0, credit: 0, closing: 0 });
    rows.push({ kind: 'category', id: cat.id, name: cat.name, depth: 0, ...t });
    rows.push(...body);
    total.debit += t.debit;
    total.credit += t.credit;
    total.closing += t.closing;
  }
  return { from, to, rows, total };
}

export interface MonthRow {
  month: string;
  label: string;
  from: string;
  to: string;
  debit: number;
  credit: number;
  closing: number;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function monthEnd(y: number, m: number): string {
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

export interface CostMonthly {
  centre: CostCentre;
  opening: number;
  rows: MonthRow[];
  total: { debit: number; credit: number; closing: number };
}

export async function costCentreMonthly(db: Db, centreId: number, from: string, to: string, includeChildren = true): Promise<CostMonthly> {
  const centre = await costCentre(db, centreId);
  if (!centre) throw new CoreError('not_found', 'Cost Centre not found');
  const ids = await descendantIds(db, centreId, includeChildren);
  const ph = ids.map(() => '?').join(',');
  const lines = await db.select<{ date: string; amount: number }>(
    `SELECT v.date, a.amount FROM cost_allocations a JOIN entries e ON e.id = a.entry_id JOIN vouchers v ON v.id = e.voucher_id
     WHERE v.cancelled = 0 AND v.date <= ? AND a.cost_centre_id IN (${ph})`,
    [to, ...ids]
  );
  const opening = centre.show_opening ? lines.filter((l) => l.date < from).reduce((s, l) => s + l.amount, 0) : 0;
  const rows: MonthRow[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  let running = opening;
  const total = { debit: 0, credit: 0, closing: 0 };
  for (;;) {
    const start = `${y}-${String(m).padStart(2, '0')}-01`;
    if (start > to) break;
    const end = monthEnd(y, m);
    const inM = lines.filter((l) => l.date >= (start < from ? from : start) && l.date <= end);
    const debit = inM.filter((l) => l.amount > 0).reduce((s, l) => s + l.amount, 0);
    const credit = inM.filter((l) => l.amount < 0).reduce((s, l) => s - l.amount, 0);
    running += debit - credit;
    rows.push({ month: start.slice(0, 7), label: MONTH_NAMES[m - 1], from: start < from ? from : start, to: end > to ? to : end, debit, credit, closing: running });
    total.debit += debit;
    total.credit += credit;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  total.closing = opening + total.debit - total.credit;
  return { centre, opening, rows, total };
}

export interface CostVoucherLine {
  entry_id: number;
  voucher_id: number;
  date: string;
  ledger_id: number;
  ledger: string;
  type: string;
  number: string;
  debit: number;
  credit: number;
}

export interface CostVouchers {
  centre: CostCentre;
  from: string;
  to: string;
  lines: CostVoucherLine[];
  opening: number;
  debit: number;
  credit: number;
  closing: number;
}

export async function costCentreVouchers(db: Db, centreId: number, from: string, to: string, includeChildren = true): Promise<CostVouchers> {
  const centre = await costCentre(db, centreId);
  if (!centre) throw new CoreError('not_found', 'Cost Centre not found');
  const ids = await descendantIds(db, centreId, includeChildren);
  const ph = ids.map(() => '?').join(',');
  const rows = await db.select<{ entry_id: number; voucher_id: number; date: string; ledger_id: number; ledger: string; type: string; number: string; amount: number }>(
    `SELECT e.id AS entry_id, v.id AS voucher_id, v.date, l.id AS ledger_id, l.name AS ledger, t.name AS type, v.number, a.amount
     FROM cost_allocations a JOIN entries e ON e.id = a.entry_id JOIN vouchers v ON v.id = e.voucher_id
     JOIN ledgers l ON l.id = e.ledger_id JOIN voucher_types t ON t.id = v.type_id
     WHERE v.cancelled = 0 AND v.date >= ? AND v.date <= ? AND a.cost_centre_id IN (${ph})
     ORDER BY v.date, v.seq, v.id, a.id`,
    [from, to, ...ids]
  );
  const lines: CostVoucherLine[] = rows.map((r) => ({
    entry_id: r.entry_id,
    voucher_id: r.voucher_id,
    date: r.date,
    ledger_id: r.ledger_id,
    ledger: r.ledger,
    type: r.type,
    number: r.number,
    debit: r.amount > 0 ? r.amount : 0,
    credit: r.amount < 0 ? -r.amount : 0,
  }));
  let opening = 0;
  if (centre.show_opening) {
    const pre = await one<{ s: number | null }>(
      db,
      `SELECT SUM(a.amount) AS s FROM cost_allocations a JOIN entries e ON e.id = a.entry_id JOIN vouchers v ON v.id = e.voucher_id
       WHERE v.cancelled = 0 AND v.date < ? AND a.cost_centre_id IN (${ph})`,
      [from, ...ids]
    );
    opening = pre?.s ?? 0;
  }
  const debit = lines.reduce((s, l) => s + l.debit, 0);
  const credit = lines.reduce((s, l) => s + l.credit, 0);
  return { centre, from, to, lines, opening, debit, credit, closing: opening + debit - credit };
}

export interface BreakupCol {
  debit: number;
  credit: number;
  closing: number;
}

export interface BreakupRow {
  kind: 'group' | 'ledger';
  id: number;
  name: string;
  cols: BreakupCol[];
}

export interface CostBreakup {
  title: string;
  group_id: number | null;
  parent_id: number | null;
  centres: CostCentre[];
  rows: BreakupRow[];
  total: BreakupCol[];
}

export async function costCentreBreakup(db: Db, centreIds: number[], from: string, to: string, groupId: number | null = null): Promise<CostBreakup> {
  const centres: CostCentre[] = [];
  for (const id of centreIds) {
    const c = await costCentre(db, id);
    if (!c) throw new CoreError('not_found', 'Cost Centre not found');
    centres.push(c);
  }
  const groups = await db.select<{ id: number; name: string; parent_id: number | null }>('SELECT id, name, parent_id FROM groups ORDER BY id');
  const ledgers = await db.select<{ id: number; name: string; group_id: number }>('SELECT id, name, group_id FROM ledgers ORDER BY name COLLATE NOCASE');
  const parentOf = new Map(groups.map((g) => [g.id, g.parent_id]));
  const perCentre: Map<number, BreakupCol>[] = [];
  for (const c of centres) {
    const ids = await descendantIds(db, c.id, true);
    const rows = await db.select<{ ledger_id: number; dr: number; cr: number }>(
      `SELECT e.ledger_id,
         COALESCE(SUM(CASE WHEN a.amount > 0 THEN a.amount ELSE 0 END), 0) AS dr,
         COALESCE(SUM(CASE WHEN a.amount < 0 THEN -a.amount ELSE 0 END), 0) AS cr
       FROM cost_allocations a JOIN entries e ON e.id = a.entry_id JOIN vouchers v ON v.id = e.voucher_id
       WHERE v.cancelled = 0 AND v.date >= ? AND v.date <= ? AND a.cost_centre_id IN (${ids.map(() => '?').join(',')})
       GROUP BY e.ledger_id`,
      [from, to, ...ids]
    );
    perCentre.push(new Map(rows.map((r) => [r.ledger_id, { debit: r.dr, credit: r.cr, closing: r.dr - r.cr }])));
  }
  const ledgerGroup = new Map(ledgers.map((l) => [l.id, l.group_id]));
  const under = (gid: number, anc: number): boolean => {
    let cur: number | null | undefined = gid;
    while (cur) {
      if (cur === anc) return true;
      cur = parentOf.get(cur);
    }
    return false;
  };
  const colFor = (i: number, pred: (ledgerId: number) => boolean): BreakupCol => {
    let debit = 0;
    let credit = 0;
    for (const [lid, v] of perCentre[i]) {
      if (pred(lid)) {
        debit += v.debit;
        credit += v.credit;
      }
    }
    return { debit, credit, closing: debit - credit };
  };
  const any = (cols: BreakupCol[]) => cols.some((c) => c.debit || c.credit);
  const rows: BreakupRow[] = [];
  const cur = groupId ? groups.find((g) => g.id === groupId) : null;
  if (groupId && !cur) throw new CoreError('not_found', 'Group not found');
  for (const g of groups.filter((x) => (groupId ? x.parent_id === groupId : !x.parent_id))) {
    const cols = centres.map((_, i) => colFor(i, (lid) => under(ledgerGroup.get(lid)!, g.id)));
    if (any(cols)) rows.push({ kind: 'group', id: g.id, name: g.name, cols });
  }
  if (groupId) {
    for (const l of ledgers.filter((x) => x.group_id === groupId)) {
      const cols = centres.map((_, i) => colFor(i, (lid) => lid === l.id));
      if (any(cols)) rows.push({ kind: 'ledger', id: l.id, name: l.name, cols });
    }
  }
  const total = centres.map((_, i) => rows.reduce((t, r) => ({ debit: t.debit + r.cols[i].debit, credit: t.credit + r.cols[i].credit, closing: t.closing + r.cols[i].closing }), { debit: 0, credit: 0, closing: 0 }));
  return { title: cur?.name ?? 'Cost Centre Breakup', group_id: groupId, parent_id: cur?.parent_id ?? null, centres, rows, total };
}

export type BudgetBasis = 'nett' | 'closing';

export interface BudgetLineInput {
  kind: 'group' | 'ledger' | 'cost_centre';
  ref_id: number;
  basis?: BudgetBasis;
  amount?: number;
  exp_amount?: number;
  inc_amount?: number;
  closing_amount?: number;
}

export interface BudgetLine {
  id: number;
  budget_id: number;
  kind: 'group' | 'ledger' | 'cost_centre';
  ref_id: number;
  name: string;
  basis: BudgetBasis;
  amount: number;
  exp_amount: number;
  inc_amount: number;
  closing_amount: number;
}

export interface Budget {
  id: number;
  guid: string;
  name: string;
  parent_id: number | null;
  parent: string | null;
  from_date: string;
  to_date: string;
  set_groups: number;
  set_ledgers: number;
  set_cost_centres: number;
}

export interface BudgetInput {
  name: string;
  parent_id?: number | null;
  from_date: string;
  to_date: string;
  set_groups?: boolean;
  set_ledgers?: boolean;
  set_cost_centres?: boolean;
  lines?: BudgetLineInput[];
}

export async function budgets(db: Db): Promise<Budget[]> {
  return db.select<Budget>('SELECT b.*, p.name AS parent FROM budgets b LEFT JOIN budgets p ON p.id = b.parent_id ORDER BY b.name COLLATE NOCASE');
}

export async function budget(db: Db, id: number): Promise<(Budget & { lines: BudgetLine[] }) | null> {
  const b = await one<Budget>(db, 'SELECT b.*, p.name AS parent FROM budgets b LEFT JOIN budgets p ON p.id = b.parent_id WHERE b.id = ?', [id]);
  if (!b) return null;
  const lines = await db.select<BudgetLine>(
    `SELECT bl.*, COALESCE(g.name, l.name, c.name, '') AS name FROM budget_lines bl
     LEFT JOIN groups g ON bl.kind = 'group' AND g.id = bl.ref_id
     LEFT JOIN ledgers l ON bl.kind = 'ledger' AND l.id = bl.ref_id
     LEFT JOIN cost_centres c ON bl.kind = 'cost_centre' AND c.id = bl.ref_id
     WHERE bl.budget_id = ? ORDER BY bl.id`,
    [id]
  );
  return { ...b, lines };
}

async function lineStmts(db: Db, budgetId: number, lines: BudgetLineInput[]): Promise<Stmt[]> {
  const natures = new Map<string, string>();
  for (const g of await db.select<{ id: number; nature: string }>('SELECT id, nature FROM groups')) natures.set(`group:${g.id}`, g.nature);
  for (const l of await db.select<{ id: number; nature: string }>('SELECT l.id, g.nature FROM ledgers l JOIN groups g ON g.id = l.group_id')) natures.set(`ledger:${l.id}`, l.nature);
  const seen = new Set<string>();
  const stmts: Stmt[] = [{ sql: 'DELETE FROM budget_lines WHERE budget_id = ?', params: [budgetId] }];
  for (const ln of lines) {
    const key = `${ln.kind}:${ln.ref_id}`;
    if (seen.has(key)) throw new CoreError('invalid', 'Duplicate budget line');
    seen.add(key);
    let amount = 0;
    if (ln.kind === 'cost_centre') {
      if (!(await costCentre(db, ln.ref_id))) throw new CoreError('not_found', 'Cost Centre not found');
    } else {
      const nature = natures.get(key);
      if (!nature) throw new CoreError('not_found', ln.kind === 'group' ? 'Group not found' : 'Ledger not found');
      const mag = Math.abs(ln.amount ?? 0);
      amount = nature === 'Assets' || nature === 'Expense' ? mag : -mag;
    }
    const exp = Math.abs(ln.exp_amount ?? 0);
    const inc = Math.abs(ln.inc_amount ?? 0);
    stmts.push({
      sql: `INSERT INTO budget_lines (id, budget_id, kind, ref_id, basis, amount, exp_amount, inc_amount, closing_amount)
            VALUES ((SELECT COALESCE(MAX(id), 0) + 1 FROM budget_lines), ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [budgetId, ln.kind, ln.ref_id, ln.basis === 'closing' ? 'closing' : 'nett', amount, exp, inc, ln.closing_amount ?? exp - inc],
    });
  }
  return stmts;
}

async function validateBudget(db: Db, input: BudgetInput, exceptId: number) {
  const name = clean(input.name);
  if (!name) throw new CoreError('invalid', 'Name is required');
  if (input.from_date > input.to_date) throw new CoreError('invalid', 'Period of Budget: From date is after To date');
  const dup = await one(db, 'SELECT 1 FROM budgets WHERE name = ? AND id != ?', [name, exceptId]);
  if (dup) throw new CoreError('conflict', `Budget ${name} already exists`);
  const parent = input.parent_id || null;
  if (parent) {
    let cur: number | null = parent;
    while (cur) {
      if (cur === exceptId) throw new CoreError('invalid', 'A Budget cannot be placed under itself');
      const row: { p: number | null } | undefined = await one<{ p: number | null }>(db, 'SELECT parent_id AS p FROM budgets WHERE id = ?', [cur]);
      if (!row) throw new CoreError('not_found', 'Parent Budget not found');
      cur = row.p;
    }
  }
  return { name, parent };
}

export async function createBudget(db: Db, input: BudgetInput): Promise<Budget> {
  const v = await validateBudget(db, input, 0);
  const id = await nextId(db, 'budgets');
  const stmts: Stmt[] = [
    {
      sql: 'INSERT INTO budgets (id, guid, name, parent_id, from_date, to_date, set_groups, set_ledgers, set_cost_centres) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      params: [id, newGuid(), v.name, v.parent, input.from_date, input.to_date, input.set_groups ? 1 : 0, input.set_ledgers ? 1 : 0, input.set_cost_centres ? 1 : 0],
    },
    ...(await lineStmts(db, id, input.lines ?? [])),
  ];
  await db.batch(stmts);
  return (await budget(db, id))!;
}

export async function updateBudget(db: Db, id: number, input: BudgetInput): Promise<Budget> {
  if (!(await budget(db, id))) throw new CoreError('not_found', 'Budget not found');
  const v = await validateBudget(db, input, id);
  const stmts: Stmt[] = [
    {
      sql: 'UPDATE budgets SET name = ?, parent_id = ?, from_date = ?, to_date = ?, set_groups = ?, set_ledgers = ?, set_cost_centres = ? WHERE id = ?',
      params: [v.name, v.parent, input.from_date, input.to_date, input.set_groups ? 1 : 0, input.set_ledgers ? 1 : 0, input.set_cost_centres ? 1 : 0, id],
    },
    ...(await lineStmts(db, id, input.lines ?? [])),
  ];
  await db.batch(stmts);
  return (await budget(db, id))!;
}

export async function deleteBudget(db: Db, id: number): Promise<void> {
  if (!(await budget(db, id))) throw new CoreError('not_found', 'Budget not found');
  await db.batch([
    { sql: 'UPDATE budgets SET parent_id = NULL WHERE parent_id = ?', params: [id] },
    { sql: 'DELETE FROM budgets WHERE id = ?', params: [id] },
  ]);
}

function headOf(b: Budget & { lines: BudgetLine[] }): Budget {
  return { id: b.id, guid: b.guid, name: b.name, parent_id: b.parent_id, parent: b.parent, from_date: b.from_date, to_date: b.to_date, set_groups: b.set_groups, set_ledgers: b.set_ledgers, set_cost_centres: b.set_cost_centres };
}

async function effectiveLines(db: Db, budgetId: number): Promise<BudgetLine[]> {
  const chain: number[] = [];
  let cur: number | null = budgetId;
  while (cur && !chain.includes(cur)) {
    chain.push(cur);
    cur = (await one<{ p: number | null }>(db, 'SELECT parent_id AS p FROM budgets WHERE id = ?', [cur]))?.p ?? null;
  }
  const merged = new Map<string, BudgetLine>();
  for (const id of chain.reverse()) {
    const b = await budget(db, id);
    for (const l of b?.lines ?? []) merged.set(`${l.kind}:${l.ref_id}`, l);
  }
  return [...merged.values()];
}

export interface VarianceRow {
  kind: 'group' | 'ledger';
  id: number;
  name: string;
  budget: number;
  actual: number;
  variance: number;
}

export interface BudgetVariance {
  budget: Budget;
  from: string;
  to: string;
  title: string;
  group_id: number | null;
  parent_id: number | null;
  rows: VarianceRow[];
  total: { budget: number; actual: number; variance: number };
}

export async function budgetVariance(db: Db, budgetId: number, from: string, to: string, groupId: number | null = null, ledgerWise = false): Promise<BudgetVariance> {
  const b = await budget(db, budgetId);
  if (!b) throw new CoreError('not_found', 'Budget not found');
  const lines = (await effectiveLines(db, budgetId)).filter((l) => l.kind !== 'cost_centre');
  const groups = await db.select<{ id: number; name: string; parent_id: number | null }>('SELECT id, name, parent_id FROM groups');
  const ledgers = await db.select<{ id: number; name: string; group_id: number }>('SELECT id, name, group_id FROM ledgers');
  const lineOf = (kind: string, id: number) => lines.find((l) => l.kind === kind && l.ref_id === id);
  const budgetOfGroup = (gid: number): number => {
    const own = lineOf('group', gid);
    if (own) return own.amount;
    let sum = 0;
    for (const g of groups) if (g.parent_id === gid) sum += budgetOfGroup(g.id);
    for (const l of ledgers) if (l.group_id === gid) sum += lineOf('ledger', l.id)?.amount ?? 0;
    return sum;
  };
  const rows: VarianceRow[] = [];
  const push = (kind: 'group' | 'ledger', id: number, name: string, bud: number, actual: number) => rows.push({ kind, id, name, budget: bud, actual, variance: bud - actual });
  const actualOf = (basis: BudgetBasis | undefined, r: { debit: number; credit: number; closing: number }) => (basis === 'closing' ? r.closing : r.debit - r.credit);
  let title = 'Trial Balance';
  let parentId: number | null = null;
  if (ledgerWise) {
    title = 'Ledger-wise';
    const done = new Set<number>();
    for (const l of lines.filter((x) => x.kind === 'ledger')) {
      const led = ledgers.find((x) => x.id === l.ref_id);
      if (!led || done.has(led.group_id)) continue;
      done.add(led.group_id);
    }
    for (const gid of done) {
      const gs = await groupSummary(db, from, to, gid);
      for (const r of gs.rows.filter((x) => x.kind === 'ledger')) {
        const ln = lineOf('ledger', r.id);
        if (ln) push('ledger', r.id, r.name, ln.amount, actualOf(ln.basis, r));
      }
    }
  } else {
    const gs = await groupSummary(db, from, to, groupId);
    title = gs.title;
    parentId = gs.parent_id;
    for (const r of gs.rows) {
      if (r.kind === 'group') {
        const ln = lineOf('group', r.id);
        push('group', r.id, r.name, budgetOfGroup(r.id), actualOf(ln?.basis, r));
      } else {
        const ln = lineOf('ledger', r.id);
        push('ledger', r.id, r.name, ln?.amount ?? 0, actualOf(ln?.basis, r));
      }
    }
  }
  const total = rows.reduce((t, r) => ({ budget: t.budget + r.budget, actual: t.actual + r.actual, variance: t.variance + r.variance }), { budget: 0, actual: 0, variance: 0 });
  return { budget: headOf(b), from, to, title, group_id: groupId, parent_id: parentId, rows, total };
}

export interface CentreVarianceRow {
  id: number;
  name: string;
  exp_budget: number;
  exp_actual: number;
  inc_budget: number;
  inc_actual: number;
  closing_budget: number;
  closing_actual: number;
  variance: number;
}

export async function costCentreBudgetVariance(db: Db, budgetId: number, from: string, to: string): Promise<{ budget: Budget; rows: CentreVarianceRow[] }> {
  const b = await budget(db, budgetId);
  if (!b) throw new CoreError('not_found', 'Budget not found');
  const lines = (await effectiveLines(db, budgetId)).filter((l) => l.kind === 'cost_centre');
  const centres = await costCentres(db);
  const sums = await centreSums(db, from, to);
  const total = (id: number): Sums => {
    const own = sums.get(id) ?? { opening: 0, debit: 0, credit: 0 };
    return centres.filter((c) => c.parent_id === id).reduce((t, k) => {
      const s = total(k.id);
      return { opening: t.opening + s.opening, debit: t.debit + s.debit, credit: t.credit + s.credit };
    }, { ...own });
  };
  const rows = lines.map((l) => {
    const t = total(l.ref_id);
    const closing = t.opening + t.debit - t.credit;
    return {
      id: l.ref_id,
      name: l.name,
      exp_budget: l.exp_amount,
      exp_actual: t.debit,
      inc_budget: l.inc_amount,
      inc_actual: t.credit,
      closing_budget: l.closing_amount,
      closing_actual: closing,
      variance: l.closing_amount - closing,
    };
  });
  return { budget: headOf(b), rows };
}

export type InterestStyle = 'calendar_year' | '365_day_year' | 'calendar_month';
export type InterestBalances = 'all' | 'debit' | 'credit';
export type InterestApplicability = 'always' | 'past_due';
export type InterestCalcFrom = 'due_date' | 'bill_date';
export type InterestRounding = 'not_applicable' | 'normal' | 'upward' | 'downward';

export const INTEREST_STYLES: { id: InterestStyle; label: string }[] = [
  { id: '365_day_year', label: '365-day Year' },
  { id: 'calendar_year', label: 'Calendar Year' },
  { id: 'calendar_month', label: 'Calendar Month' },
];

export const INTEREST_BALANCES: { id: InterestBalances; label: string }[] = [
  { id: 'all', label: 'All Balances' },
  { id: 'debit', label: 'Debit Balances Only' },
  { id: 'credit', label: 'Credit Balances Only' },
];

export interface InterestSlab {
  applicable_from: string;
  rate_bp: number;
  style: InterestStyle;
  balances: InterestBalances;
  applicability: InterestApplicability;
  after_days: number;
  calc_from: InterestCalcFrom;
  rounding: InterestRounding;
}

export interface InterestParams {
  ledger_id: number;
  active: boolean;
  based_on: 'voucher_date' | 'reco_date';
  by_transaction: boolean;
  override_params: boolean;
  include_added: boolean;
  include_deducted: boolean;
  advanced: boolean;
  override_advanced: boolean;
  slabs: InterestSlab[];
}

export async function interestParams(db: Db, ledgerId: number): Promise<InterestParams | null> {
  const p = await one<Record<string, number | string>>(db, 'SELECT * FROM interest_params WHERE ledger_id = ?', [ledgerId]);
  if (!p) return null;
  const slabs = await db.select<InterestSlab>(
    'SELECT applicable_from, rate_bp, style, balances, applicability, after_days, calc_from, rounding FROM interest_slabs WHERE ledger_id = ? ORDER BY seq',
    [ledgerId]
  );
  return {
    ledger_id: ledgerId,
    active: !!p.active,
    based_on: p.based_on as 'voucher_date' | 'reco_date',
    by_transaction: !!p.by_transaction,
    override_params: !!p.override_params,
    include_added: !!p.include_added,
    include_deducted: !!p.include_deducted,
    advanced: !!p.advanced,
    override_advanced: !!p.override_advanced,
    slabs,
  };
}

export type InterestParamsInput = Omit<InterestParams, 'ledger_id' | 'slabs'> & { slabs: Partial<InterestSlab>[] };

export async function saveInterestParams(db: Db, ledgerId: number, input: InterestParamsInput): Promise<void> {
  if (!(await one(db, 'SELECT 1 FROM ledgers WHERE id = ?', [ledgerId]))) throw new CoreError('not_found', 'Ledger not found');
  if (input.active && !input.slabs.length) throw new CoreError('invalid', 'Enter the Rate of interest');
  const stmts: Stmt[] = [
    { sql: 'DELETE FROM interest_slabs WHERE ledger_id = ?', params: [ledgerId] },
    { sql: 'DELETE FROM interest_params WHERE ledger_id = ?', params: [ledgerId] },
    {
      sql: `INSERT INTO interest_params (ledger_id, active, based_on, by_transaction, override_params, include_added, include_deducted, advanced, override_advanced)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [ledgerId, input.active ? 1 : 0, input.based_on, input.by_transaction ? 1 : 0, input.override_params ? 1 : 0, input.include_added ? 1 : 0, input.include_deducted ? 1 : 0, input.advanced ? 1 : 0, input.override_advanced ? 1 : 0],
    },
  ];
  input.slabs.forEach((s, i) => {
    if (!s.rate_bp || s.rate_bp < 0) throw new CoreError('invalid', 'Rate of interest must be greater than zero');
    stmts.push({
      sql: `INSERT INTO interest_slabs (id, ledger_id, seq, applicable_from, rate_bp, style, balances, applicability, after_days, calc_from, rounding)
            VALUES ((SELECT COALESCE(MAX(id), 0) + 1 FROM interest_slabs), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [ledgerId, i, s.applicable_from ?? '', s.rate_bp, s.style ?? 'calendar_year', s.balances ?? 'all', s.applicability ?? 'always', s.after_days ?? 0, s.calc_from ?? 'due_date', s.rounding ?? 'not_applicable'],
    });
  });
  await db.batch(stmts);
}

export async function deleteInterestParams(db: Db, ledgerId: number): Promise<void> {
  await db.batch([
    { sql: 'DELETE FROM interest_slabs WHERE ledger_id = ?', params: [ledgerId] },
    { sql: 'DELETE FROM interest_params WHERE ledger_id = ?', params: [ledgerId] },
  ]);
}

const DAY_MS = 86_400_000;
const toMs = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const fromMs = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => fromMs(toMs(iso) + n * DAY_MS);

function dayFraction(style: InterestStyle, iso: string): number {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  if (style === '365_day_year') return 1 / 365;
  if (style === 'calendar_month') return 1 / new Date(Date.UTC(y, m, 0)).getUTCDate();
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return 1 / (leap ? 366 : 365);
}

function eligible(balances: InterestBalances, bal: number): boolean {
  if (!bal) return false;
  return balances === 'all' || (balances === 'debit' ? bal > 0 : bal < 0);
}

export interface InterestSegment {
  from: string;
  to: string;
  days: number;
  balance: number;
  rate_bp: number;
  style: InterestStyle;
  interest: number;
}

interface Delta {
  date: string;
  amount: number;
}

function effectiveDeltas(opening: number, items: Delta[], p: { include_added: boolean; include_deducted: boolean }): Delta[] {
  const sorted = [...items].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let running = opening;
  const out: Delta[] = [];
  for (const d of sorted) {
    const dir = running !== 0 ? Math.sign(running) : Math.sign(d.amount);
    const added = Math.sign(d.amount) === dir;
    const include = added ? p.include_added : p.include_deducted;
    out.push({ date: include ? d.date : addDays(d.date, 1), amount: d.amount });
    running += d.amount;
  }
  return out;
}

function walkDays(opening: number, deltas: Delta[], from: string, to: string, pickSlab: (day: string) => InterestSlab | null): InterestSegment[] {
  let bal = opening;
  const future: Delta[] = [];
  for (const d of deltas) {
    if (d.date <= from) bal += d.amount;
    else future.push(d);
  }
  const segs: InterestSegment[] = [];
  let cur: (InterestSegment & { raw: number }) | null = null;
  const flush = () => {
    if (cur) {
      const { raw, ...s } = cur;
      segs.push({ ...s, interest: Math.round(raw) });
      cur = null;
    }
  };
  const last = toMs(to);
  for (let ms = toMs(from); ms <= last; ms += DAY_MS) {
    const day = fromMs(ms);
    if (day > from) for (const d of future) if (d.date === day) bal += d.amount;
    const slab = pickSlab(day);
    if (!slab || !eligible(slab.balances, bal)) {
      flush();
      continue;
    }
    const part = Math.abs(bal) * (slab.rate_bp / 10000) * dayFraction(slab.style, day) * Math.sign(bal);
    if (cur && cur.balance === bal && cur.rate_bp === slab.rate_bp && cur.style === slab.style && cur.to === addDays(day, -1)) {
      cur.to = day;
      cur.days += 1;
      cur.raw += part;
    } else {
      flush();
      cur = { from: day, to: day, days: 1, balance: bal, rate_bp: slab.rate_bp, style: slab.style, interest: 0, raw: part };
    }
  }
  flush();
  return segs;
}

export interface LedgerInterest {
  ledger_id: number;
  ledger: string;
  from: string;
  to: string;
  balance: number;
  segments: InterestSegment[];
  interest: number;
}

async function ledgerFlow(db: Db, ledgerId: number): Promise<{ name: string; opening: number; items: Delta[] }> {
  const l = await one<{ name: string; opening: number }>(db, 'SELECT name, opening FROM ledgers WHERE id = ?', [ledgerId]);
  if (!l) throw new CoreError('not_found', 'Ledger not found');
  const items = await db.select<Delta>(
    'SELECT v.date, e.amount FROM entries e JOIN vouchers v ON v.id = e.voucher_id WHERE e.ledger_id = ? AND v.cancelled = 0 ORDER BY v.date, v.seq, e.id',
    [ledgerId]
  );
  return { name: l.name, opening: l.opening, items };
}

export async function ledgerInterest(db: Db, ledgerId: number, from: string, to: string): Promise<LedgerInterest> {
  const flow = await ledgerFlow(db, ledgerId);
  const p = await interestParams(db, ledgerId);
  const balance = flow.opening + flow.items.filter((i) => i.date <= to).reduce((s, i) => s + i.amount, 0);
  if (!p || !p.active) return { ledger_id: ledgerId, ledger: flow.name, from, to, balance, segments: [], interest: 0 };
  const slabs = [...p.slabs].sort((a, b) => (a.applicable_from < b.applicable_from ? -1 : a.applicable_from > b.applicable_from ? 1 : 0));
  const pick = (day: string): InterestSlab | null => {
    let found: InterestSlab | null = null;
    for (const s of slabs) if (!s.applicable_from || s.applicable_from <= day) found = s;
    return found;
  };
  const deltas = effectiveDeltas(flow.opening, flow.items, p);
  const segments = walkDays(flow.opening, deltas, from, to, pick);
  return { ledger_id: ledgerId, ledger: flow.name, from, to, balance, segments, interest: segments.reduce((s, x) => s + x.interest, 0) };
}

export interface BillInterest {
  name: string;
  bill_date: string;
  due_date: string;
  pending: number;
  segments: InterestSegment[];
  interest: number;
}

export interface LedgerBillInterest {
  ledger_id: number;
  ledger: string;
  from: string;
  to: string;
  bills: BillInterest[];
  interest: number;
}

export async function billInterest(db: Db, ledgerId: number, from: string, to: string): Promise<LedgerBillInterest> {
  const led = await one<{ name: string }>(db, 'SELECT name FROM ledgers WHERE id = ?', [ledgerId]);
  if (!led) throw new CoreError('not_found', 'Ledger not found');
  const p = await interestParams(db, ledgerId);
  const out: LedgerBillInterest = { ledger_id: ledgerId, ledger: led.name, from, to, bills: [], interest: 0 };
  if (!p || !p.active || !p.slabs.length) return out;
  const rows = await db.select<{ kind: string; name: string; amount: number; bill_date: string; due_date: string; vdate: string | null }>(
    `SELECT b.kind, b.name, b.amount, b.bill_date, b.due_date, v.date AS vdate
     FROM bills b LEFT JOIN entries e ON e.id = b.entry_id LEFT JOIN vouchers v ON v.id = e.voucher_id
     WHERE b.ledger_id = ? AND b.kind != 'onacc' AND (v.date IS NULL OR (v.date <= ? AND v.cancelled = 0)) ORDER BY b.id`,
    [ledgerId, to]
  );
  const names = [...new Set(rows.map((r) => r.name))];
  for (const name of names) {
    const mine = rows.filter((r) => r.name === name);
    const head = mine.find((r) => r.kind === 'new' || r.kind === 'opening') ?? mine[0];
    const billDate = head.bill_date || head.vdate || from;
    const dueDate = head.due_date || billDate;
    const items: Delta[] = mine.map((r) => ({ date: r.kind === 'opening' ? billDate : r.vdate || billDate, amount: r.amount }));
    const pending = items.reduce((s, i) => s + i.amount, 0);
    const deltas = effectiveDeltas(0, items, p);
    const slabs = p.slabs.map((s) => ({ ...s, start: addDays(s.calc_from === 'bill_date' ? billDate : dueDate, s.applicability === 'past_due' ? s.after_days : 0) }));
    const pick = (day: string): InterestSlab | null => {
      let found: (typeof slabs)[number] | null = null;
      for (const s of slabs) if (s.start <= day && (!found || s.start >= found.start)) found = s;
      return found;
    };
    const segments = walkDays(0, deltas, from, to, pick);
    if (!segments.length && pending === 0) continue;
    const interest = segments.reduce((s, x) => s + x.interest, 0);
    out.bills.push({ name, bill_date: billDate, due_date: dueDate, pending, segments, interest });
  }
  out.interest = out.bills.reduce((s, b) => s + b.interest, 0);
  return out;
}

export interface InterestGroupRow {
  kind: 'group' | 'ledger';
  id: number;
  name: string;
  balance: number;
  interest: number;
}

export interface GroupInterest {
  title: string;
  group_id: number | null;
  parent_id: number | null;
  from: string;
  to: string;
  rows: InterestGroupRow[];
  total: { balance: number; interest: number };
}

export async function ledgerInterestTotal(db: Db, ledgerId: number, from: string, to: string): Promise<{ balance: number; interest: number }> {
  const p = await interestParams(db, ledgerId);
  if (!p || !p.active) return { balance: 0, interest: 0 };
  const flat = await ledgerInterest(db, ledgerId, from, to);
  const billWise = await one<{ b: number }>(db, 'SELECT bill_by_bill AS b FROM ledgers WHERE id = ?', [ledgerId]);
  if (p.by_transaction && billWise?.b) {
    const bills = await billInterest(db, ledgerId, from, to);
    return { balance: flat.balance, interest: bills.interest };
  }
  return { balance: flat.balance, interest: flat.interest };
}

export async function groupInterest(db: Db, groupId: number | null, from: string, to: string): Promise<GroupInterest> {
  const groups = await db.select<{ id: number; name: string; parent_id: number | null }>('SELECT id, name, parent_id FROM groups ORDER BY id');
  const cur = groupId ? groups.find((g) => g.id === groupId) : null;
  if (groupId && !cur) throw new CoreError('not_found', 'Group not found');
  const active = await db.select<{ id: number; name: string; group_id: number }>(
    'SELECT l.id, l.name, l.group_id FROM ledgers l JOIN interest_params p ON p.ledger_id = l.id WHERE p.active = 1 ORDER BY l.name COLLATE NOCASE'
  );
  const parentOf = new Map(groups.map((g) => [g.id, g.parent_id]));
  const under = (gid: number, anc: number): boolean => {
    let c: number | null | undefined = gid;
    while (c) {
      if (c === anc) return true;
      c = parentOf.get(c);
    }
    return false;
  };
  const totals = new Map<number, { balance: number; interest: number }>();
  for (const l of active) totals.set(l.id, await ledgerInterestTotal(db, l.id, from, to));
  const rows: InterestGroupRow[] = [];
  for (const g of groups.filter((x) => (groupId ? x.parent_id === groupId : !x.parent_id))) {
    const inside = active.filter((l) => under(l.group_id, g.id));
    if (!inside.length) continue;
    rows.push({ kind: 'group', id: g.id, name: g.name, balance: inside.reduce((s, l) => s + totals.get(l.id)!.balance, 0), interest: inside.reduce((s, l) => s + totals.get(l.id)!.interest, 0) });
  }
  if (groupId) {
    for (const l of active.filter((x) => x.group_id === groupId)) rows.push({ kind: 'ledger', id: l.id, name: l.name, ...totals.get(l.id)! });
  }
  return {
    title: cur?.name ?? 'Group Interest Calculations',
    group_id: groupId,
    parent_id: cur?.parent_id ?? null,
    from,
    to,
    rows,
    total: { balance: rows.reduce((s, r) => s + r.balance, 0), interest: rows.reduce((s, r) => s + r.interest, 0) },
  };
}
