import { stockSummary } from './inventory.ts';
import { CoreError, one, type Db } from './db.ts';
import type { Group } from './books.ts';

export interface Totals {
  opening: number;
  debit: number;
  credit: number;
  closing: number;
}

interface LedgerStat extends Totals {
  id: number;
  name: string;
  group_id: number;
}

interface Tree {
  groups: Group[];
  byId: Map<number, Group>;
  children: Map<number, Group[]>;
}

const zero = (): Totals => ({ opening: 0, debit: 0, credit: 0, closing: 0 });

function add(t: Totals, r: Totals) {
  t.opening += r.opening;
  t.debit += r.debit;
  t.credit += r.credit;
  t.closing += r.closing;
}

async function loadTree(db: Db): Promise<Tree> {
  const groups = await db.select<Group>('SELECT * FROM groups ORDER BY id');
  const byId = new Map(groups.map((g) => [g.id, g]));
  const children = new Map<number, Group[]>();
  for (const g of groups) {
    const k = g.parent_id ?? 0;
    if (!children.has(k)) children.set(k, []);
    children.get(k)!.push(g);
  }
  return { groups, byId, children };
}

function rootNature(tree: Tree, groupId: number): Group['nature'] {
  let g = tree.byId.get(groupId)!;
  while (g.parent_id) g = tree.byId.get(g.parent_id)!;
  return g.nature;
}

async function ledgerStats(db: Db, tree: Tree, from: string, to: string): Promise<LedgerStat[]> {
  const rows = await db.select<{ id: number; name: string; group_id: number; opening: number; pre: number; dr: number; cr: number }>(
    `SELECT l.id, l.name, l.group_id, l.opening,
       COALESCE(SUM(CASE WHEN v.date < ? THEN e.amount END), 0) AS pre,
       COALESCE(SUM(CASE WHEN v.date >= ? AND v.date <= ? AND e.amount > 0 THEN e.amount END), 0) AS dr,
       COALESCE(SUM(CASE WHEN v.date >= ? AND v.date <= ? AND e.amount < 0 THEN -e.amount END), 0) AS cr
     FROM ledgers l
     LEFT JOIN entries e ON e.ledger_id = l.id
     LEFT JOIN vouchers v ON v.id = e.voucher_id
     GROUP BY l.id
     ORDER BY l.name COLLATE NOCASE`,
    [from, from, to, from, to]
  );
  return rows.map((r) => {
    const nature = rootNature(tree, r.group_id);
    const nominal = nature === 'Income' || nature === 'Expense';
    const opening = nominal ? 0 : r.opening + r.pre;
    return { id: r.id, name: r.name, group_id: r.group_id, opening, debit: r.dr, credit: r.cr, closing: opening + r.dr - r.cr };
  });
}

async function groupTotals(db: Db, from: string, to: string) {
  const tree = await loadTree(db);
  const stats = await ledgerStats(db, tree, from, to);
  const totals = new Map<number, Totals>(tree.groups.map((g) => [g.id, zero()]));
  for (const s of stats) {
    let g: Group | undefined = tree.byId.get(s.group_id);
    while (g) {
      add(totals.get(g.id)!, s);
      g = g.parent_id ? tree.byId.get(g.parent_id) : undefined;
    }
  }
  return { tree, stats, totals };
}

export interface SummaryRow extends Totals {
  kind: 'group' | 'ledger';
  id: number;
  name: string;
}

export interface GroupSummary {
  from: string;
  to: string;
  title: string;
  group_id: number | null;
  parent_id: number | null;
  rows: SummaryRow[];
  total: Totals;
}

export async function groupSummary(db: Db, from: string, to: string, groupId: number | null): Promise<GroupSummary> {
  const { tree, stats, totals } = await groupTotals(db, from, to);
  if (groupId && !tree.byId.has(groupId)) throw new CoreError('not_found', 'Group not found');
  const rows: SummaryRow[] = [];
  for (const g of tree.children.get(groupId ?? 0) ?? []) {
    rows.push({ kind: 'group', id: g.id, name: g.name, ...totals.get(g.id)! });
  }
  if (groupId) {
    for (const s of stats.filter((x) => x.group_id === groupId)) {
      rows.push({ kind: 'ledger', id: s.id, name: s.name, opening: s.opening, debit: s.debit, credit: s.credit, closing: s.closing });
    }
  }
  const total = zero();
  for (const r of rows) add(total, r);
  const g = groupId ? tree.byId.get(groupId)! : null;
  return { from, to, title: g ? g.name : 'Trial Balance', group_id: groupId, parent_id: g ? g.parent_id : null, rows, total };
}

export interface PlRow {
  id?: number;
  label: string;
  amount: number;
  bold?: boolean;
}

export interface Side {
  left: PlRow[];
  right: PlRow[];
  totalLeft: number;
  totalRight: number;
}

export interface ProfitLoss {
  from: string;
  to: string;
  gross: number;
  net: number;
  trading: Side;
  pl: Side;
}

const sum = (rows: PlRow[]) => rows.reduce((s, r) => s + r.amount, 0);

export async function profitAndLoss(db: Db, from: string, to: string): Promise<ProfitLoss> {
  const { tree, totals } = await groupTotals(db, from, to);
  const find = (name: string) => tree.groups.find((g) => g.name === name)!;
  const exp = (name: string): PlRow => {
    const g = find(name);
    const t = totals.get(g.id)!;
    return { id: g.id, label: name, amount: t.debit - t.credit };
  };
  const inc = (name: string): PlRow => {
    const g = find(name);
    const t = totals.get(g.id)!;
    return { id: g.id, label: name, amount: t.credit - t.debit };
  };
  const purchases = exp('Purchase Accounts');
  const directExp = exp('Direct Expenses');
  const sales = inc('Sales Accounts');
  const directInc = inc('Direct Incomes');
  const indirectExp = exp('Indirect Expenses');
  const indirectInc = inc('Indirect Incomes');

  const hasItems = !!(await db.select('SELECT 1 FROM stock_items LIMIT 1')).length;
  const stock = hasItems ? await stockSummary(db, from, to) : null;
  const openingStock = stock?.opening_value ?? 0;
  const closingStock = stock?.closing_value ?? 0;
  const gross = sales.amount + directInc.amount - purchases.amount - directExp.amount + closingStock - openingStock;
  const tl: PlRow[] = stock ? [{ label: 'Opening Stock', amount: openingStock }, purchases, directExp] : [purchases, directExp];
  const tr: PlRow[] = stock ? [sales, directInc, { label: 'Closing Stock', amount: closingStock }] : [sales, directInc];
  if (gross >= 0) tl.push({ label: 'Gross Profit c/o', amount: gross, bold: true });
  else tr.push({ label: 'Gross Loss c/o', amount: -gross, bold: true });

  const net = gross + indirectInc.amount - indirectExp.amount;
  const pl: PlRow[] = [];
  const pr: PlRow[] = [];
  if (gross < 0) pl.push({ label: 'Gross Loss b/f', amount: -gross, bold: true });
  else pr.push({ label: 'Gross Profit b/f', amount: gross, bold: true });
  pl.push(indirectExp);
  pr.push(indirectInc);
  if (net >= 0) pl.push({ label: 'Nett Profit', amount: net, bold: true });
  else pr.push({ label: 'Nett Loss', amount: -net, bold: true });

  return {
    from,
    to,
    gross,
    net,
    trading: { left: tl, right: tr, totalLeft: sum(tl), totalRight: sum(tr) },
    pl: { left: pl, right: pr, totalLeft: sum(pl), totalRight: sum(pr) },
  };
}

export interface BalanceSheet {
  from: string;
  to: string;
  liabilities: PlRow[];
  assets: PlRow[];
  totalLiabilities: number;
  totalAssets: number;
}

export async function balanceSheet(db: Db, from: string, to: string): Promise<BalanceSheet> {
  const { tree, totals } = await groupTotals(db, from, to);
  const pl = await profitAndLoss(db, from, to);
  const liabilities: PlRow[] = [];
  const assets: PlRow[] = [];
  for (const g of tree.children.get(0) ?? []) {
    const t = totals.get(g.id)!;
    if (g.nature === 'Liabilities') liabilities.push({ id: g.id, label: g.name, amount: -t.closing });
    else if (g.nature === 'Assets') assets.push({ id: g.id, label: g.name, amount: t.closing });
  }
  if ((await db.select('SELECT 1 FROM stock_items LIMIT 1')).length) {
    const closing = (await stockSummary(db, from, to)).closing_value;
    assets.push({ label: 'Closing Stock', amount: closing });
  }
  if (pl.net >= 0) liabilities.push({ label: 'Profit & Loss A/c', amount: pl.net, bold: true });
  else assets.push({ label: 'Profit & Loss A/c', amount: -pl.net, bold: true });
  const diff = sum(assets) - sum(liabilities);
  if (diff > 0) liabilities.push({ label: 'Difference in Opening Balances', amount: diff, bold: true });
  else if (diff < 0) assets.push({ label: 'Difference in Opening Balances', amount: -diff, bold: true });
  return { from, to, liabilities, assets, totalLiabilities: sum(liabilities), totalAssets: sum(assets) };
}

export interface DayBookRow {
  id: number;
  date: string;
  number: string;
  type: string;
  cancelled: number;
  particulars: string;
  debit: number;
  credit: number;
}

export async function dayBook(db: Db, from: string, to: string, typeId?: number | null): Promise<DayBookRow[]> {
  const params: (string | number)[] = [from, to];
  let clause = '';
  if (typeId) {
    clause = ' AND v.type_id = ?';
    params.push(typeId);
  }
  const vouchers = await db.select<{ id: number; date: string; number: string; type: string; cancelled: number; total: number }>(
    `SELECT v.id, v.date, v.number, v.cancelled, t.name AS type,
       COALESCE((SELECT SUM(amount) FROM entries WHERE voucher_id = v.id AND amount > 0), 0) AS total
     FROM vouchers v JOIN voucher_types t ON t.id = v.type_id
     WHERE v.date >= ? AND v.date <= ?${clause}
     ORDER BY v.date, v.id`,
    params
  );
  const first = await db.select<{ voucher_id: number; ledger: string }>(
    `SELECT e.voucher_id, l.name AS ledger FROM entries e JOIN ledgers l ON l.id = e.ledger_id
     WHERE e.id IN (SELECT MIN(id) FROM entries e2 WHERE e2.amount > 0 GROUP BY e2.voucher_id)
       AND e.voucher_id IN (SELECT id FROM vouchers WHERE date >= ? AND date <= ?)`,
    [from, to]
  );
  const byV = new Map(first.map((f) => [f.voucher_id, f.ledger]));
  return vouchers.map((v) => ({
    id: v.id,
    date: v.date,
    number: v.number,
    type: v.type,
    cancelled: v.cancelled,
    particulars: v.cancelled ? '(cancelled)' : byV.get(v.id) ?? '',
    debit: v.total,
    credit: v.total,
  }));
}

export interface LedgerLine {
  voucher_id: number;
  date: string;
  number: string;
  type: string;
  particulars: string;
  debit: number;
  credit: number;
  balance: number;
}

export interface LedgerReport {
  from: string;
  to: string;
  ledger: { id: number; name: string; group_name: string; group_id: number };
  opening: number;
  debit: number;
  credit: number;
  closing: number;
  lines: LedgerLine[];
}

export async function ledgerVouchers(db: Db, ledgerId: number, from: string, to: string): Promise<LedgerReport> {
  const ledger = await one<{ id: number; name: string; group_name: string; group_id: number }>(
    db,
    'SELECT l.id, l.name, l.group_id, g.name AS group_name FROM ledgers l JOIN groups g ON g.id = l.group_id WHERE l.id = ?',
    [ledgerId]
  );
  if (!ledger) throw new CoreError('not_found', 'Ledger not found');
  const tree = await loadTree(db);
  const stat = (await ledgerStats(db, tree, from, to)).find((s) => s.id === ledgerId)!;
  const rows = await db.select<{ voucher_id: number; date: string; number: string; type: string; amount: number; particulars: string | null }>(
    `SELECT v.id AS voucher_id, v.date, v.number, t.name AS type, e.amount,
       (SELECT l2.name FROM entries e2 JOIN ledgers l2 ON l2.id = e2.ledger_id
         WHERE e2.voucher_id = v.id AND e2.id != e.id
         ORDER BY ABS(e2.amount) DESC, e2.seq LIMIT 1) AS particulars
     FROM entries e
     JOIN vouchers v ON v.id = e.voucher_id
     JOIN voucher_types t ON t.id = v.type_id
     WHERE e.ledger_id = ? AND v.date >= ? AND v.date <= ?
     ORDER BY v.date, v.id, e.seq`,
    [ledgerId, from, to]
  );
  let running = stat.opening;
  const lines = rows.map((r) => {
    running += r.amount;
    return {
      voucher_id: r.voucher_id,
      date: r.date,
      number: r.number,
      type: r.type,
      particulars: r.particulars ?? '',
      debit: r.amount > 0 ? r.amount : 0,
      credit: r.amount < 0 ? -r.amount : 0,
      balance: running,
    };
  });
  return { from, to, ledger, opening: stat.opening, debit: stat.debit, credit: stat.credit, closing: stat.closing, lines };
}

export interface OutstandingBill {
  name: string;
  bill_date: string;
  due_date: string;
  pending: number;
  overdue_days: number;
}

export interface OutstandingLedger {
  ledger_id: number;
  ledger: string;
  bills: OutstandingBill[];
  on_account: number;
  total: number;
}

export interface Outstandings {
  side: 'receivable' | 'payable';
  as_of: string;
  ledgers: OutstandingLedger[];
  total: number;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export async function outstandings(db: Db, side: 'receivable' | 'payable', asOf: string, from: string): Promise<Outstandings> {
  const root = side === 'receivable' ? 'Sundry Debtors' : 'Sundry Creditors';
  const tree = await loadTree(db);
  const rootGroup = tree.groups.find((g) => g.name === root)!;
  const inside = new Set<number>();
  const walk = (id: number) => {
    inside.add(id);
    for (const c of tree.children.get(id) ?? []) walk(c.id);
  };
  walk(rootGroup.id);
  const billWise = new Set((await db.select<{ id: number }>('SELECT id FROM ledgers WHERE bill_by_bill = 1')).map((r) => r.id));
  const stats = (await ledgerStats(db, tree, from, asOf)).filter((s) => inside.has(s.group_id) && billWise.has(s.id));
  const bills = await db.select<{ ledger_id: number; kind: string; name: string; amount: number; bill_date: string; due_date: string; vdate: string | null }>(
    `SELECT b.ledger_id, b.kind, b.name, b.amount, b.bill_date, b.due_date, v.date AS vdate
     FROM bills b LEFT JOIN entries e ON e.id = b.entry_id LEFT JOIN vouchers v ON v.id = e.voucher_id
     WHERE b.kind != 'onacc' AND (v.date IS NULL OR v.date <= ?)
     ORDER BY b.id`,
    [asOf]
  );
  const ledgers: OutstandingLedger[] = [];
  let total = 0;
  for (const s of stats) {
    const mine = bills.filter((b) => b.ledger_id === s.id);
    const net = new Map<string, OutstandingBill>();
    for (const b of mine) {
      const cur = net.get(b.name) ?? { name: b.name, bill_date: '', due_date: '', pending: 0, overdue_days: 0 };
      cur.pending += b.amount;
      if (b.kind === 'new' || b.kind === 'opening') {
        cur.bill_date = b.bill_date || b.vdate || '';
        cur.due_date = b.due_date || '';
      }
      net.set(b.name, cur);
    }
    const open = [...net.values()].filter((b) => b.pending !== 0);
    for (const b of open) b.overdue_days = b.due_date && b.due_date < asOf ? daysBetween(b.due_date, asOf) : 0;
    const billed = open.reduce((x, b) => x + b.pending, 0);
    const onAccount = s.closing - billed;
    if (!open.length && onAccount === 0) continue;
    const sign = side === 'receivable' ? 1 : -1;
    ledgers.push({
      ledger_id: s.id,
      ledger: s.name,
      bills: open.map((b) => ({ ...b, pending: b.pending * sign })),
      on_account: onAccount * sign,
      total: s.closing * sign,
    });
    total += s.closing * sign;
  }
  return { side, as_of: asOf, ledgers, total };
}

export interface RegisterMonth {
  month: string;
  count: number;
  debit: number;
  credit: number;
  closing: number;
}

export async function voucherRegister(db: Db, parent: string, from: string, to: string): Promise<{ months: RegisterMonth[]; total: { count: number; debit: number; credit: number } }> {
  const tree = await loadTree(db);
  const focus = parent === 'Sales' || parent === 'Credit Note' ? 'Sales Accounts' : parent === 'Purchase' || parent === 'Debit Note' ? 'Purchase Accounts' : '';
  const under = (gid: number) => {
    let g = tree.byId.get(gid);
    while (g) {
      if (g.name === focus) return true;
      g = g.parent_id ? tree.byId.get(g.parent_id) : undefined;
    }
    return false;
  };
  const rows = await db.select<{ month: string; vid: number; gid: number; amount: number }>(
    `SELECT substr(v.date, 1, 7) AS month, v.id AS vid, l.group_id AS gid, e.amount
     FROM vouchers v JOIN voucher_types t ON t.id = v.type_id JOIN entries e ON e.voucher_id = v.id JOIN ledgers l ON l.id = e.ledger_id
     WHERE t.parent = ? AND v.cancelled = 0 AND v.date >= ? AND v.date <= ?`,
    [parent, from, to]
  );
  const acc = new Map<string, { ids: Set<number>; dr: number; cr: number }>();
  for (const r of rows) {
    const m = acc.get(r.month) ?? acc.set(r.month, { ids: new Set(), dr: 0, cr: 0 }).get(r.month)!;
    m.ids.add(r.vid);
    if (focus) {
      if (!under(r.gid)) continue;
      if (r.amount > 0) m.dr += r.amount;
      else m.cr += -r.amount;
    } else if (r.amount > 0) m.dr += r.amount;
  }
  const months: RegisterMonth[] = [];
  let closing = 0;
  const start = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  for (let d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1)); d <= end; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    const key = d.toISOString().slice(0, 7);
    const m = acc.get(key);
    closing += (m?.dr ?? 0) - (m?.cr ?? 0);
    months.push({ month: key, count: m?.ids.size ?? 0, debit: m?.dr ?? 0, credit: m?.cr ?? 0, closing });
  }
  return {
    months,
    total: { count: months.reduce((s, m) => s + m.count, 0), debit: months.reduce((s, m) => s + m.debit, 0), credit: months.reduce((s, m) => s + m.credit, 0) },
  };
}

export interface CashBankRow extends Totals {
  id: number;
  name: string;
  group: string;
}

export async function cashBankBook(db: Db, from: string, to: string): Promise<{ rows: CashBankRow[]; total: Totals }> {
  const { tree, stats } = await groupTotals(db, from, to);
  const names = ['Cash-in-Hand', 'Bank Accounts', 'Bank OD A/c'];
  const rows: CashBankRow[] = [];
  for (const n of names) {
    const g = tree.groups.find((x) => x.name === n);
    if (!g) continue;
    for (const s of stats.filter((x) => x.group_id === g.id)) rows.push({ id: s.id, name: s.name, group: n, opening: s.opening, debit: s.debit, credit: s.credit, closing: s.closing });
  }
  const total = zero();
  for (const r of rows) add(total, r);
  return { rows, total };
}

export interface RatioRow {
  label: string;
  value: number | null;
  unit: 'x' | '%' | 'days';
  group: string;
}

export async function ratioAnalysis(db: Db, from: string, to: string): Promise<RatioRow[]> {
  const { tree, totals } = await groupTotals(db, from, to);
  const t = (name: string) => totals.get(tree.groups.find((g) => g.name === name)!.id)!;
  const pl = await profitAndLoss(db, from, to);
  const hasItems = !!(await db.select('SELECT 1 FROM stock_items LIMIT 1')).length;
  const closingStock = hasItems ? (await stockSummary(db, from, to)).closing_value : 0;
  const stockHand = closingStock + t('Stock-in-Hand').closing;
  const ca = t('Current Assets').closing + closingStock;
  const cl = -t('Current Liabilities').closing;
  const sales = t('Sales Accounts').credit - t('Sales Accounts').debit;
  const purchases = t('Purchase Accounts').debit - t('Purchase Accounts').credit;
  const capital = -t('Capital Account').closing + (pl.net > 0 ? pl.net : 0);
  const loans = -t('Loans (Liability)').closing;
  const debtors = t('Sundry Debtors').closing;
  const creditors = -t('Sundry Creditors').closing;
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  const div = (a: number, b: number) => (b ? a / b : null);
  const pct = (a: number, b: number) => (b ? (a / b) * 100 : null);
  const indirect = t('Indirect Expenses').debit - t('Indirect Expenses').credit;
  const direct = t('Direct Expenses').debit - t('Direct Expenses').credit;
  return [
    { group: 'Principal Groups', label: 'Current Ratio', value: div(ca, cl), unit: 'x' },
    { group: 'Principal Groups', label: 'Quick Ratio', value: div(ca - stockHand, cl), unit: 'x' },
    { group: 'Principal Groups', label: 'Debt/Equity', value: div(loans, capital), unit: 'x' },
    { group: 'Principal Ratios', label: 'Gross Profit %', value: pct(pl.gross, sales), unit: '%' },
    { group: 'Principal Ratios', label: 'Net Profit %', value: pct(pl.net, sales), unit: '%' },
    { group: 'Principal Ratios', label: 'Operating Cost %', value: pct(direct + indirect + purchases, sales), unit: '%' },
    { group: 'Principal Ratios', label: 'Return on Investment %', value: pct(pl.net, capital), unit: '%' },
    { group: 'Principal Ratios', label: 'Return on Working Capital %', value: pct(pl.net, ca - cl), unit: '%' },
    { group: 'Turnover Ratios', label: 'Inventory Turnover', value: div(sales, stockHand), unit: 'x' },
    { group: 'Turnover Ratios', label: 'Receivables Turnover (in days)', value: sales ? (debtors / sales) * days : null, unit: 'days' },
    { group: 'Turnover Ratios', label: 'Payables Turnover (in days)', value: purchases ? (creditors / purchases) * days : null, unit: 'days' },
  ];
}

export interface StatRow {
  label: string;
  count: number;
}

export async function statistics(db: Db, from: string, to: string): Promise<{ vouchers: StatRow[]; masters: StatRow[]; total: number; cancelled: number }> {
  const vouchers = await db.select<StatRow>(
    `SELECT t.name AS label, COUNT(v.id) AS count FROM voucher_types t
     LEFT JOIN vouchers v ON v.type_id = t.id AND v.cancelled = 0 AND v.date >= ? AND v.date <= ?
     GROUP BY t.id ORDER BY t.id`,
    [from, to]
  );
  const c = async (sql: string) => (await one<{ n: number }>(db, sql))!.n;
  const masters: StatRow[] = [
    { label: 'Groups', count: await c('SELECT COUNT(*) AS n FROM groups') },
    { label: 'Ledgers', count: await c('SELECT COUNT(*) AS n FROM ledgers') },
    { label: 'Voucher Types', count: await c('SELECT COUNT(*) AS n FROM voucher_types') },
    { label: 'Stock Items', count: await c('SELECT COUNT(*) AS n FROM stock_items') },
  ];
  const cancelled = (await one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM vouchers WHERE cancelled = 1 AND date >= ? AND date <= ?', [from, to]))!.n;
  return { vouchers, masters, total: vouchers.reduce((s, v) => s + v.count, 0), cancelled };
}

export interface FlowLine {
  label: string;
  amount: number;
}

export interface CashFlowStatement {
  from: string;
  to: string;
  opening_cash: number;
  closing_cash: number;
  net_profit: number;
  operating: FlowLine[];
  investing: FlowLine[];
  financing: FlowLine[];
  net_operating: number;
  net_investing: number;
  net_financing: number;
  net_change: number;
}

async function balanceMovement(db: Db, from: string, to: string) {
  const { tree, totals } = await groupTotals(db, from, to);
  const pl = await profitAndLoss(db, from, to);
  const hasItems = !!(await db.select('SELECT 1 FROM stock_items LIMIT 1')).length;
  const stock = hasItems ? await stockSummary(db, from, to) : null;
  const delta = (name: string) => {
    const g = tree.groups.find((x) => x.name === name);
    if (!g) return 0;
    const t = totals.get(g.id)!;
    return t.closing - t.opening;
  };
  const cash = (name: string) => {
    const g = tree.groups.find((x) => x.name === name);
    return g ? totals.get(g.id)! : zero();
  };
  return { tree, totals, pl, stock, delta, cash };
}

export async function cashFlow(db: Db, from: string, to: string): Promise<CashFlowStatement> {
  const { pl, stock, delta, cash } = await balanceMovement(db, from, to);
  const effect = (label: string, name: string): FlowLine => ({ label, amount: -delta(name) });
  const operating: FlowLine[] = [
    effect('Sundry Debtors', 'Sundry Debtors'),
    effect('Deposits (Asset)', 'Deposits (Asset)'),
    effect('Loans & Advances (Asset)', 'Loans & Advances (Asset)'),
    effect('Stock-in-Hand', 'Stock-in-Hand'),
    effect('Sundry Creditors', 'Sundry Creditors'),
    effect('Duties & Taxes', 'Duties & Taxes'),
    effect('Provisions', 'Provisions'),
  ];
  if (stock) operating.push({ label: 'Closing Stock', amount: -(stock.closing_value - stock.opening_value) });
  const investing: FlowLine[] = [effect('Fixed Assets', 'Fixed Assets'), effect('Investments', 'Investments'), effect('Misc. Expenses (ASSET)', 'Misc. Expenses (ASSET)')];
  const financing: FlowLine[] = [
    effect('Capital Account', 'Capital Account'),
    effect('Secured Loans', 'Secured Loans'),
    effect('Unsecured Loans', 'Unsecured Loans'),
    effect('Bank OD A/c', 'Bank OD A/c'),
    effect('Branch / Divisions', 'Branch / Divisions'),
    effect('Suspense A/c', 'Suspense A/c'),
  ];
  const keep = (l: FlowLine[]) => l.filter((x) => x.amount !== 0);
  const bank = cash('Bank Accounts');
  const inHand = cash('Cash-in-Hand');
  const net_operating = pl.net + operating.reduce((s, l) => s + l.amount, 0);
  const net_investing = investing.reduce((s, l) => s + l.amount, 0);
  const net_financing = financing.reduce((s, l) => s + l.amount, 0);
  return {
    from,
    to,
    opening_cash: bank.opening + inHand.opening,
    closing_cash: bank.closing + inHand.closing,
    net_profit: pl.net,
    operating: keep(operating),
    investing: keep(investing),
    financing: keep(financing),
    net_operating,
    net_investing,
    net_financing,
    net_change: net_operating + net_investing + net_financing,
  };
}

export interface FundsFlowStatement {
  from: string;
  to: string;
  sources: FlowLine[];
  applications: FlowLine[];
  total_sources: number;
  total_applications: number;
  working_capital_change: number;
}

export async function fundsFlow(db: Db, from: string, to: string): Promise<FundsFlowStatement> {
  const { pl, stock, delta } = await balanceMovement(db, from, to);
  const sources: FlowLine[] = [];
  const applications: FlowLine[] = [];
  const place = (label: string, dr: number) => {
    if (dr < 0) sources.push({ label: `Increase in ${label}`, amount: -dr });
    else if (dr > 0) applications.push({ label: `Decrease in ${label}`, amount: dr });
  };
  if (pl.net >= 0) sources.push({ label: 'Net Profit', amount: pl.net });
  else applications.push({ label: 'Net Loss', amount: -pl.net });
  for (const n of ['Capital Account', 'Secured Loans', 'Unsecured Loans', 'Branch / Divisions', 'Suspense A/c']) place(n, delta(n));
  const asset = (label: string, dr: number) => {
    if (dr < 0) sources.push({ label: `Decrease in ${label}`, amount: -dr });
    else if (dr > 0) applications.push({ label: `Increase in ${label}`, amount: dr });
  };
  for (const n of ['Fixed Assets', 'Investments', 'Misc. Expenses (ASSET)']) asset(n, delta(n));
  const wc = delta('Current Assets') + (stock ? stock.closing_value - stock.opening_value : 0) + delta('Current Liabilities');
  if (wc > 0) applications.push({ label: 'Increase in Working Capital', amount: wc });
  else if (wc < 0) sources.push({ label: 'Decrease in Working Capital', amount: -wc });
  const sum = (l: FlowLine[]) => l.reduce((s, x) => s + x.amount, 0);
  return { from, to, sources, applications, total_sources: sum(sources), total_applications: sum(applications), working_capital_change: wc };
}

export interface DetailRow extends SummaryRow {
  depth: number;
}

export async function groupSummaryDetailed(db: Db, from: string, to: string, groupId: number | null): Promise<{ title: string; rows: DetailRow[]; total: Totals }> {
  const { tree, stats, totals } = await groupTotals(db, from, to);
  if (groupId && !tree.byId.has(groupId)) throw new CoreError('not_found', 'Group not found');
  const rows: DetailRow[] = [];
  const walk = (gid: number, depth: number) => {
    for (const g of tree.children.get(gid) ?? []) {
      rows.push({ kind: 'group', id: g.id, name: g.name, depth, ...totals.get(g.id)! });
      walk(g.id, depth + 1);
      for (const s of stats.filter((x) => x.group_id === g.id)) rows.push({ kind: 'ledger', id: s.id, name: s.name, depth: depth + 1, opening: s.opening, debit: s.debit, credit: s.credit, closing: s.closing });
    }
  };
  walk(groupId ?? 0, 0);
  if (groupId) for (const s of stats.filter((x) => x.group_id === groupId)) rows.push({ kind: 'ledger', id: s.id, name: s.name, depth: 0, opening: s.opening, debit: s.debit, credit: s.credit, closing: s.closing });
  const total = zero();
  for (const r of rows.filter((x) => x.depth === 0)) add(total, r);
  return { title: groupId ? tree.byId.get(groupId)!.name : 'Trial Balance', rows, total };
}
