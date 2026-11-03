import { CoreError, one, type Db } from './db.ts';
import { QTY_SCALE, lineAmount, stockItem, stockItems, stockSummary, stockGroups, stockCategories, godowns, type StockItem } from './inventory.ts';

export const STOCKX_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS stockx_batches (
    id INTEGER PRIMARY KEY,
    movement_id INTEGER REFERENCES stock_movements(id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL REFERENCES stock_items(id),
    godown_id INTEGER REFERENCES godowns(id),
    batch TEXT NOT NULL,
    mfg_date TEXT NOT NULL DEFAULT '',
    expiry_date TEXT NOT NULL DEFAULT '',
    qty INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_stockx_batches_move ON stockx_batches(movement_id)',
  'CREATE INDEX IF NOT EXISTS idx_stockx_batches_item ON stockx_batches(item_id)',
  `CREATE TABLE IF NOT EXISTS stockx_price_levels (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
  )`,
  `CREATE TABLE IF NOT EXISTS stockx_price_list (
    id INTEGER PRIMARY KEY,
    level_id INTEGER NOT NULL REFERENCES stockx_price_levels(id),
    item_id INTEGER NOT NULL REFERENCES stock_items(id),
    applicable_from TEXT NOT NULL,
    from_qty INTEGER NOT NULL DEFAULT 0,
    less_than_qty INTEGER NOT NULL DEFAULT 0,
    rate INTEGER NOT NULL DEFAULT 0,
    disc_bp INTEGER NOT NULL DEFAULT 0
  )`,
  'CREATE INDEX IF NOT EXISTS idx_stockx_price_item ON stockx_price_list(item_id, level_id)',
  `CREATE TABLE IF NOT EXISTS stockx_party_level (
    ledger_id INTEGER PRIMARY KEY REFERENCES ledgers(id),
    level_id INTEGER NOT NULL REFERENCES stockx_price_levels(id)
  )`,
  `CREATE TABLE IF NOT EXISTS stockx_track (
    id INTEGER PRIMARY KEY,
    movement_id INTEGER NOT NULL REFERENCES stock_movements(id) ON DELETE CASCADE,
    against_id INTEGER NOT NULL REFERENCES stock_movements(id) ON DELETE CASCADE,
    qty INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_stockx_track_against ON stockx_track(against_id)',
  `CREATE TABLE IF NOT EXISTS stockx_order_meta (
    movement_id INTEGER PRIMARY KEY REFERENCES stock_movements(id) ON DELETE CASCADE,
    due_date TEXT NOT NULL DEFAULT '',
    preclosed INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS stockx_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
];

export async function ensureStockExtras(db: Db): Promise<void> {
  await db.batch(STOCKX_SCHEMA.map((sql) => ({ sql })));
}

async function nextId(db: Db, table: string): Promise<number> {
  return ((await one<{ m: number }>(db, `SELECT COALESCE(MAX(id), 0) AS m FROM ${table}`))!.m) + 1;
}

const clean = (s: unknown, max = 100) => String(s ?? '').trim().slice(0, max);
const ORDER_PARENTS = "('Sales Order', 'Purchase Order')";
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}

function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const ey = Number(to.slice(0, 4));
  const em = Number(to.slice(5, 7));
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

function descendants<T extends { id: number; parent_id: number | null }>(all: T[], id: number | null): Set<number> {
  if (id === null) return new Set(all.map((x) => x.id));
  const out = new Set<number>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const g of all) if (g.parent_id !== null && out.has(g.parent_id) && !out.has(g.id)) (out.add(g.id), (grew = true));
  }
  return out;
}

interface Mv {
  id: number;
  voucher_id: number;
  item_id: number;
  godown_id: number;
  ledger_id: number | null;
  qty: number;
  rate: number;
  amount: number;
  discount_bp: number;
  date: string;
  type: string;
  parent: string;
  number: string;
  party_id: number | null;
  party: string;
}

async function loadMoves(db: Db, to: string, orders = false, itemId?: number): Promise<Mv[]> {
  return db.select<Mv>(
    `SELECT m.id, m.voucher_id, m.item_id, COALESCE(m.godown_id, 1) AS godown_id, m.ledger_id, m.qty, m.rate, m.amount, m.discount_bp,
            v.date, t.name AS type, t.parent AS parent, v.number, v.party_id, COALESCE(p.name, '') AS party
     FROM stock_movements m JOIN vouchers v ON v.id = m.voucher_id JOIN voucher_types t ON t.id = v.type_id LEFT JOIN ledgers p ON p.id = v.party_id
     WHERE v.cancelled = 0 AND v.date <= ?${orders ? '' : ' AND m.tracked = 0'} AND t.parent ${orders ? '' : 'NOT'} IN ${ORDER_PARENTS}${itemId ? ' AND m.item_id = ' + Number(itemId) : ''}
     ORDER BY v.date, v.id, m.seq, m.id`,
    [to]
  );
}

interface Ev {
  mv: Mv;
  delta: number;
  value: number;
  qty_after: number;
  value_after: number;
}

interface Walk {
  items: Map<number, StockItem>;
  events: Map<string, Ev[]>;
  opening: Map<string, { qty: number; value: number }>;
}

async function walkStock(db: Db, to: string, itemId?: number): Promise<Walk> {
  const items = new Map((await stockItems(db)).filter((i) => !itemId || i.id === itemId).map((i) => [i.id, i]));
  const moves = await loadMoves(db, to, false, itemId);
  const events = new Map<string, Ev[]>();
  const opening = new Map<string, { qty: number; value: number }>();
  const state = new Map<string, { qty: number; value: number; rate: number }>();
  const st = (key: string) => {
    let s = state.get(key);
    if (!s) {
      s = { qty: 0, value: 0, rate: 0 };
      state.set(key, s);
    }
    return s;
  };
  for (const it of items.values()) {
    if (!it.opening_qty && !it.opening_value) continue;
    const key = `${it.id}:1`;
    const s = st(key);
    s.qty = it.opening_qty;
    s.value = it.opening_value;
    s.rate = it.opening_qty ? it.opening_value / it.opening_qty : 0;
    opening.set(key, { qty: it.opening_qty, value: it.opening_value });
  }
  for (const mv of moves) {
    if (!items.has(mv.item_id)) continue;
    const key = `${mv.item_id}:${mv.godown_id}`;
    const s = st(key);
    let q = mv.qty;
    let amt = mv.amount;
    if (mv.parent === 'Physical Stock') {
      q = mv.qty - s.qty;
      amt = q > 0 ? Math.round(q * (s.qty > 0 ? s.value / s.qty : s.rate)) : 0;
      if (q === 0) continue;
    }
    let value: number;
    if (q > 0) {
      value = amt;
      s.qty += q;
      s.value += amt;
      if (amt > 0) s.rate = amt / q;
    } else {
      const out = -q;
      let cost: number;
      if (s.qty > 0) {
        const take = Math.min(out, s.qty);
        cost = Math.round((s.value * take) / s.qty) + (out > s.qty ? Math.round((out - s.qty) * s.rate) : 0);
      } else cost = Math.round(out * s.rate);
      value = -cost;
      s.qty -= out;
      s.value -= cost;
    }
    const list = events.get(key) ?? events.set(key, []).get(key)!;
    list.push({ mv, delta: q, value, qty_after: s.qty, value_after: s.value });
  }
  return { items, events, opening };
}

function stateAt(w: Walk, key: string, date: string, inclusive: boolean): { qty: number; value: number } {
  let cur = w.opening.get(key) ?? { qty: 0, value: 0 };
  for (const e of w.events.get(key) ?? []) {
    if (inclusive ? e.mv.date > date : e.mv.date >= date) break;
    cur = { qty: e.qty_after, value: e.value_after };
  }
  return cur;
}

const fyStart = async (db: Db) => (await one<{ fy_start: string }>(db, 'SELECT fy_start FROM company LIMIT 1'))?.fy_start ?? '1970-01-01';

export interface GodownItemRow {
  item_id: number;
  name: string;
  unit: string;
  unit_id: number;
  qty: number;
  rate: number;
  value: number;
}
export interface GodownRow {
  godown_id: number;
  name: string;
  qty: number | null;
  rate: number;
  value: number;
  items: GodownItemRow[];
}

export async function godownSummary(db: Db, to: string, godownId?: number): Promise<{ rows: GodownRow[]; value: number }> {
  const w = await walkStock(db, to);
  const gs = await godowns(db);
  const rows: GodownRow[] = [];
  for (const g of gs) {
    if (godownId && g.id !== godownId) continue;
    const items: GodownItemRow[] = [];
    for (const it of w.items.values()) {
      const key = `${it.id}:${g.id}`;
      if (!w.events.has(key) && !w.opening.has(key)) continue;
      const s = stateAt(w, key, to, true);
      if (!s.qty && !s.value) continue;
      items.push({ item_id: it.id, name: it.name, unit: it.unit, unit_id: it.unit_id, qty: s.qty, rate: s.qty ? Math.round((s.value * QTY_SCALE) / s.qty) : 0, value: s.value });
    }
    if (!items.length && godownId !== g.id) continue;
    items.sort((a, b) => a.name.localeCompare(b.name));
    const sameUnit = items.length > 0 && items.every((i) => i.unit_id === items[0].unit_id);
    const qty = sameUnit ? items.reduce((s, i) => s + i.qty, 0) : null;
    const value = items.reduce((s, i) => s + i.value, 0);
    rows.push({ godown_id: g.id, name: g.name, qty, rate: qty ? Math.round((value * QTY_SCALE) / qty) : 0, value, items });
  }
  return { rows, value: rows.reduce((s, r) => s + r.value, 0) };
}

export interface GodownMonthRow {
  month: string;
  label: string;
  in_qty: number;
  in_value: number;
  out_qty: number;
  out_value: number;
  closing_qty: number;
  closing_value: number;
}

export async function godownMonthly(
  db: Db,
  godownId: number,
  itemId: number | null,
  from: string,
  to: string
): Promise<{ opening_qty: number; opening_value: number; rows: GodownMonthRow[]; total: Omit<GodownMonthRow, 'month' | 'label'> }> {
  const w = await walkStock(db, to, itemId ?? undefined);
  const keys = [...new Set([...w.events.keys(), ...w.opening.keys()])].filter((k) => k.endsWith(`:${godownId}`));
  let oq = 0;
  let ov = 0;
  for (const k of keys) {
    const s = stateAt(w, k, from, false);
    oq += s.qty;
    ov += s.value;
  }
  const rows: GodownMonthRow[] = monthsBetween(from, to).map((m) => ({ month: m, label: MONTH_NAMES[Number(m.slice(5, 7)) - 1], in_qty: 0, in_value: 0, out_qty: 0, out_value: 0, closing_qty: 0, closing_value: 0 }));
  const byMonth = new Map(rows.map((r) => [r.month, r]));
  for (const k of keys)
    for (const e of w.events.get(k) ?? []) {
      if (e.mv.date < from) continue;
      const r = byMonth.get(e.mv.date.slice(0, 7));
      if (!r) continue;
      if (e.delta > 0) {
        r.in_qty += e.delta;
        r.in_value += e.value;
      } else {
        r.out_qty += -e.delta;
        r.out_value += -e.value;
      }
    }
  let cq = oq;
  let cv = ov;
  for (const r of rows) {
    cq += r.in_qty - r.out_qty;
    cv += r.in_value - r.out_value;
    r.closing_qty = cq;
    r.closing_value = cv;
  }
  const total = {
    in_qty: rows.reduce((s, r) => s + r.in_qty, 0),
    in_value: rows.reduce((s, r) => s + r.in_value, 0),
    out_qty: rows.reduce((s, r) => s + r.out_qty, 0),
    out_value: rows.reduce((s, r) => s + r.out_value, 0),
    closing_qty: cq,
    closing_value: cv,
  };
  return { opening_qty: oq, opening_value: ov, rows, total };
}

export interface GodownVoucherRow {
  voucher_id: number;
  date: string;
  particulars: string;
  type: string;
  number: string;
  in_qty: number;
  in_value: number;
  out_qty: number;
  out_value: number;
  closing_qty: number;
  closing_value: number;
}

export async function godownVouchers(db: Db, godownId: number, itemId: number, from: string, to: string) {
  const w = await walkStock(db, to, itemId);
  const key = `${itemId}:${godownId}`;
  const open = stateAt(w, key, from, false);
  const rows: GodownVoucherRow[] = [];
  for (const e of w.events.get(key) ?? []) {
    if (e.mv.date < from) continue;
    rows.push({
      voucher_id: e.mv.voucher_id,
      date: e.mv.date,
      particulars: e.mv.party || e.mv.type,
      type: e.mv.type,
      number: e.mv.number,
      in_qty: e.delta > 0 ? e.delta : 0,
      in_value: e.delta > 0 ? e.value : 0,
      out_qty: e.delta < 0 ? -e.delta : 0,
      out_value: e.delta < 0 ? -e.value : 0,
      closing_qty: e.qty_after,
      closing_value: e.value_after,
    });
  }
  const totals = {
    in_qty: rows.reduce((s, r) => s + r.in_qty, 0),
    in_value: rows.reduce((s, r) => s + r.in_value, 0),
    out_qty: rows.reduce((s, r) => s + r.out_qty, 0),
    out_value: rows.reduce((s, r) => s + r.out_value, 0),
    closing_qty: open.qty + rows.reduce((s, r) => s + r.in_qty - r.out_qty, 0),
    closing_value: open.value + rows.reduce((s, r) => s + r.in_value - r.out_value, 0),
  };
  return { opening_qty: open.qty, opening_value: open.value, rows, totals };
}

export interface GodownTransferRow {
  voucher_id: number;
  date: string;
  type: string;
  number: string;
  item_id: number;
  item: string;
  unit: string;
  from_godown: string;
  to_godown: string;
  qty: number;
  value: number;
}

export async function godownTransfers(db: Db, from: string, to: string): Promise<GodownTransferRow[]> {
  const gs = new Map((await godowns(db)).map((g) => [g.id, g.name]));
  const items = new Map((await stockItems(db)).map((i) => [i.id, i]));
  const moves = (await loadMoves(db, to)).filter((m) => m.date >= from && m.parent === 'Stock Journal');
  const byKey = new Map<string, Mv[]>();
  for (const m of moves) (byKey.get(`${m.voucher_id}:${m.item_id}`) ?? byKey.set(`${m.voucher_id}:${m.item_id}`, []).get(`${m.voucher_id}:${m.item_id}`)!).push(m);
  const out: GodownTransferRow[] = [];
  for (const list of byKey.values()) {
    const outs = list.filter((m) => m.qty < 0).map((m) => ({ m, left: -m.qty }));
    const ins = list.filter((m) => m.qty > 0).map((m) => ({ m, left: m.qty }));
    for (const o of outs)
      for (const i of ins) {
        if (o.left <= 0) break;
        if (i.left <= 0 || i.m.godown_id === o.m.godown_id) continue;
        const q = Math.min(o.left, i.left);
        o.left -= q;
        i.left -= q;
        const it = items.get(o.m.item_id);
        out.push({
          voucher_id: o.m.voucher_id,
          date: o.m.date,
          type: o.m.type,
          number: o.m.number,
          item_id: o.m.item_id,
          item: it?.name ?? '',
          unit: it?.unit ?? '',
          from_godown: gs.get(o.m.godown_id) ?? '',
          to_godown: gs.get(i.m.godown_id) ?? '',
          qty: q,
          value: Math.round((i.m.amount * q) / (i.m.qty || 1)),
        });
      }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number, undefined, { numeric: true }));
}

export interface StockQueryResult {
  item: StockItem;
  group: string;
  category: string;
  closing_qty: number;
  closing_value: number;
  cost_rate: number;
  last_purchase: { date: string; party: string; qty: number; rate: number } | null;
  last_sale: { date: string; party: string; qty: number; rate: number } | null;
  purchases: StockQueryTxn[];
  sales: StockQueryTxn[];
  godown_batches: { godown_id: number; godown: string; batch: string; qty: number }[];
  same_category: { item_id: number; name: string; unit: string; qty: number; cost: number; price: number }[];
  reorder: ReorderRow | null;
}
export interface StockQueryTxn {
  voucher_id: number;
  date: string;
  party: string;
  qty: number;
  rate: number;
  discount_bp: number;
  amount: number;
}

export async function stockQuery(db: Db, itemId: number, to: string, last = 10): Promise<StockQueryResult> {
  const item = await stockItem(db, itemId);
  if (!item) throw new CoreError('not_found', 'Stock item not found');
  const [summary, gs, cats, moves, batches] = await Promise.all([
    stockSummary(db, '0000-01-01', to),
    stockGroups(db),
    stockCategories(db),
    loadMoves(db, to, false, itemId),
    batchBalances(db, itemId, to),
  ]);
  const row = summary.rows.find((r) => r.item_id === itemId)!;
  const txn = (parent: string, sign: 1 | -1): StockQueryTxn[] =>
    moves
      .filter((m) => m.parent === parent && Math.sign(m.qty) === sign)
      .map((m) => ({ voucher_id: m.voucher_id, date: m.date, party: m.party, qty: Math.abs(m.qty), rate: m.rate, discount_bp: m.discount_bp, amount: Math.abs(m.amount) }))
      .reverse()
      .slice(0, last);
  const purchases = txn('Purchase', 1);
  const sales = txn('Sales', -1);
  const w = await walkStock(db, to, itemId);
  const gb = new Map<string, number>();
  const gnames = new Map((await godowns(db)).map((g) => [g.id, g.name]));
  for (const key of new Set([...w.events.keys(), ...w.opening.keys()])) {
    const s = stateAt(w, key, to, true);
    if (s.qty) gb.set(key, s.qty);
  }
  const godown_batches: StockQueryResult['godown_batches'] = [];
  for (const [key, qty] of gb) {
    const gid = Number(key.split(':')[1]);
    const bs = batches.filter((b) => b.godown_id === gid);
    if (bs.length) for (const b of bs) godown_batches.push({ godown_id: gid, godown: gnames.get(gid) ?? '', batch: b.batch, qty: b.qty });
    else godown_batches.push({ godown_id: gid, godown: gnames.get(gid) ?? '', batch: 'Primary Batch', qty });
  }
  const allItems = await stockItems(db);
  const same_category = item.category_id
    ? summary.rows
        .filter((r) => r.item_id !== itemId)
        .flatMap((r) => {
          const it = allItems.find((i) => i.id === r.item_id)!;
          return it.category_id === item.category_id ? [{ item_id: r.item_id, name: r.name, unit: r.unit, qty: r.closing_qty, cost: r.closing_rate, price: it.standard_price }] : [];
        })
    : [];
  const reorder = (await reorderStatus(db, null, to)).rows.find((r) => r.item_id === itemId) ?? null;
  const first = (l: StockQueryTxn[]) => (l[0] ? { date: l[0].date, party: l[0].party, qty: l[0].qty, rate: l[0].rate } : null);
  return {
    item,
    group: gs.find((g) => g.id === item.group_id)?.name ?? 'Primary',
    category: cats.find((c) => c.id === item.category_id)?.name ?? 'Not Applicable',
    closing_qty: row.closing_qty,
    closing_value: row.closing_value,
    cost_rate: row.closing_rate,
    last_purchase: first(purchases),
    last_sale: first(sales),
    purchases,
    sales,
    godown_batches,
    same_category,
    reorder,
  };
}

export interface BuyerSellerRow {
  party_id: number | null;
  party: string;
  qty: number;
  value: number;
}

export async function topBuyersSellers(db: Db, itemId: number, from: string, to: string): Promise<{ purchase: BuyerSellerRow[]; sales: BuyerSellerRow[] }> {
  const moves = (await loadMoves(db, to, false, itemId)).filter((m) => m.date >= from);
  const agg = (parent: string, sign: number) => {
    const map = new Map<string, BuyerSellerRow>();
    for (const m of moves) {
      if (m.parent !== parent || Math.sign(m.qty) !== sign) continue;
      const r = map.get(m.party) ?? { party_id: m.party_id, party: m.party, qty: 0, value: 0 };
      r.qty += Math.abs(m.qty);
      r.value += Math.abs(m.amount);
      map.set(m.party, r);
    }
    return [...map.values()].sort((a, b) => b.value - a.value);
  };
  return { purchase: agg('Purchase', 1), sales: agg('Sales', -1) };
}

export interface MovementLine {
  key: string;
  name: string;
  qty: number;
  basic_rate: number;
  eff_rate: number;
  value: number;
}
export interface MovementSection {
  title: string;
  lines: MovementLine[];
  qty: number;
  eff_rate: number;
  value: number;
}

function section(title: string, acc: Map<string, { name: string; qty: number; gross: number; value: number }>): MovementSection {
  const lines = [...acc.entries()].map(([key, a]) => ({
    key,
    name: a.name,
    qty: a.qty,
    basic_rate: a.qty ? Math.round((a.gross * QTY_SCALE) / a.qty) : 0,
    eff_rate: a.qty ? Math.round((a.value * QTY_SCALE) / a.qty) : 0,
    value: a.value,
  }));
  const qty = lines.reduce((s, l) => s + l.qty, 0);
  const value = lines.reduce((s, l) => s + l.value, 0);
  return { title, lines, qty, eff_rate: qty ? Math.round((value * QTY_SCALE) / qty) : 0, value };
}

export async function itemMovementAnalysis(db: Db, itemId: number, from: string, to: string): Promise<{ inward: MovementSection[]; outward: MovementSection[]; in_total: MovementSection; out_total: MovementSection }> {
  const moves = (await loadMoves(db, to, false, itemId)).filter((m) => m.date >= from && m.parent !== 'Physical Stock');
  const buckets = new Map<string, Map<string, { name: string; qty: number; gross: number; value: number }>>();
  const add = (title: string, key: string, name: string, m: Mv) => {
    const b = buckets.get(title) ?? buckets.set(title, new Map()).get(title)!;
    const a = b.get(key) ?? b.set(key, { name, qty: 0, gross: 0, value: 0 }).get(key)!;
    const q = Math.abs(m.qty);
    a.qty += q;
    a.gross += Math.round((q * m.rate) / QTY_SCALE);
    a.value += Math.abs(m.amount);
  };
  for (const m of moves) {
    const inward = m.qty > 0;
    if (m.parent === 'Stock Journal') add(inward ? 'in|Transfers Inward (Production):' : 'out|Transfers Outward (Consumption):', m.type, m.type, m);
    else add(inward ? 'in|Suppliers:' : 'out|Buyers:', String(m.party_id ?? m.type), m.party || m.type, m);
  }
  const pick = (dir: string) => [...buckets.entries()].filter(([t]) => t.startsWith(`${dir}|`)).map(([t, acc]) => section(t.slice(dir.length + 1), acc));
  const inward = pick('in');
  const outward = pick('out');
  const total = (secs: MovementSection[]) => {
    const qty = secs.reduce((s, x) => s + x.qty, 0);
    const value = secs.reduce((s, x) => s + x.value, 0);
    return { title: 'Total', lines: [], qty, eff_rate: qty ? Math.round((value * QTY_SCALE) / qty) : 0, value };
  };
  return { inward, outward, in_total: total(inward), out_total: total(outward) };
}

export interface ItemVoucherRow {
  voucher_id: number;
  date: string;
  party: string;
  type: string;
  number: string;
  qty: number;
  basic_rate: number;
  basic_value: number;
  eff_rate: number;
  value: number;
}

export async function itemVoucherAnalysis(
  db: Db,
  itemId: number,
  from: string,
  to: string,
  filter: { direction: 'in' | 'out'; party_id?: number | null; type?: string }
): Promise<{ rows: ItemVoucherRow[]; qty: number; basic_value: number; value: number }> {
  const rows = (await loadMoves(db, to, false, itemId))
    .filter((m) => m.date >= from && m.parent !== 'Physical Stock' && (filter.direction === 'in' ? m.qty > 0 : m.qty < 0))
    .filter((m) => (filter.party_id === undefined || filter.party_id === null ? true : m.party_id === filter.party_id) && (!filter.type || m.type === filter.type))
    .map((m) => {
      const q = Math.abs(m.qty);
      const bv = Math.round((q * m.rate) / QTY_SCALE);
      return { voucher_id: m.voucher_id, date: m.date, party: m.party, type: m.type, number: m.number, qty: q, basic_rate: m.rate, basic_value: bv, eff_rate: q ? Math.round((Math.abs(m.amount) * QTY_SCALE) / q) : 0, value: Math.abs(m.amount) };
    });
  return { rows, qty: rows.reduce((s, r) => s + r.qty, 0), basic_value: rows.reduce((s, r) => s + r.basic_value, 0), value: rows.reduce((s, r) => s + r.value, 0) };
}

export interface FlowRow {
  kind: 'group' | 'item' | 'ledger';
  id: number;
  name: string;
  unit: string;
  in_qty: number;
  in_rate: number;
  in_value: number;
  out_qty: number;
  out_rate: number;
  out_value: number;
}
export interface FlowReport {
  title: string;
  rows: FlowRow[];
  total: { in_qty: number; in_rate: number; in_value: number; out_qty: number; out_rate: number; out_value: number };
}

const rateOf = (value: number, qty: number) => (qty ? Math.round((value * QTY_SCALE) / qty) : 0);

function finishFlow(title: string, rows: FlowRow[]): FlowReport {
  const t = { in_qty: 0, in_rate: 0, in_value: 0, out_qty: 0, out_rate: 0, out_value: 0 };
  for (const r of rows) {
    t.in_qty += r.in_qty;
    t.in_value += r.in_value;
    t.out_qty += r.out_qty;
    t.out_value += r.out_value;
  }
  t.in_rate = rateOf(t.in_value, t.in_qty);
  t.out_rate = rateOf(t.out_value, t.out_qty);
  return { title, rows, total: t };
}

const emptyFlow = (kind: FlowRow['kind'], id: number, name: string, unit = ''): FlowRow => ({ kind, id, name, unit, in_qty: 0, in_rate: 0, in_value: 0, out_qty: 0, out_rate: 0, out_value: 0 });

function addFlow(r: FlowRow, m: Mv) {
  if (m.qty > 0) {
    r.in_qty += m.qty;
    r.in_value += m.amount;
  } else {
    r.out_qty += -m.qty;
    r.out_value += Math.abs(m.amount);
  }
  r.in_rate = rateOf(r.in_value, r.in_qty);
  r.out_rate = rateOf(r.out_value, r.out_qty);
}

export async function stockMovementAnalysis(
  db: Db,
  by: 'group' | 'category',
  id: number | null,
  from: string,
  to: string,
  itemWise = false
): Promise<FlowReport> {
  const items = await stockItems(db);
  const tree = by === 'group' ? await stockGroups(db) : await stockCategories(db);
  const ids = descendants(tree, id);
  const inScope = items.filter((i) => (by === 'group' ? (i.group_id === null ? id === null : ids.has(i.group_id)) : i.category_id === null ? id === null : ids.has(i.category_id)));
  const itemById = new Map(inScope.map((i) => [i.id, i]));
  const moves = (await loadMoves(db, to)).filter((m) => m.date >= from && m.parent !== 'Physical Stock' && itemById.has(m.item_id));
  const title = id === null ? 'Primary' : tree.find((t) => t.id === id)?.name ?? '';
  const itemRows = new Map<number, FlowRow>();
  for (const m of moves) {
    const it = itemById.get(m.item_id)!;
    const r = itemRows.get(it.id) ?? itemRows.set(it.id, emptyFlow('item', it.id, it.name, it.unit)).get(it.id)!;
    addFlow(r, m);
  }
  if (itemWise) return finishFlow(title, [...itemRows.values()].sort((a, b) => a.name.localeCompare(b.name)));
  const directKey = (i: StockItem) => (by === 'group' ? i.group_id : i.category_id);
  const children = tree.filter((t) => (id === null ? t.parent_id === null : t.parent_id === id));
  const rows: FlowRow[] = [];
  for (const c of children) {
    const sub = descendants(tree, c.id);
    const r = emptyFlow('group', c.id, c.name);
    for (const ir of itemRows.values()) {
      const k = directKey(itemById.get(ir.id)!);
      if (k !== null && sub.has(k)) {
        r.in_qty += ir.in_qty;
        r.in_value += ir.in_value;
        r.out_qty += ir.out_qty;
        r.out_value += ir.out_value;
      }
    }
    r.in_rate = rateOf(r.in_value, r.in_qty);
    r.out_rate = rateOf(r.out_value, r.out_qty);
    r.in_qty = 0;
    r.out_qty = 0;
    rows.push(r);
  }
  for (const ir of [...itemRows.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const k = directKey(itemById.get(ir.id)!);
    if ((id === null && k === null) || (id !== null && k === id)) rows.push(ir);
  }
  const rep = finishFlow(title, rows);
  rep.total.in_value = rows.reduce((s, r) => s + r.in_value, 0);
  rep.total.out_value = rows.reduce((s, r) => s + r.out_value, 0);
  rep.total.in_qty = [...itemRows.values()].reduce((s, r) => s + r.in_qty, 0);
  rep.total.out_qty = [...itemRows.values()].reduce((s, r) => s + r.out_qty, 0);
  rep.total.in_rate = rateOf(rep.total.in_value, rep.total.in_qty);
  rep.total.out_rate = rateOf(rep.total.out_value, rep.total.out_qty);
  return rep;
}

export async function ledgerMovementAnalysis(db: Db, by: 'group' | 'ledger', id: number, from: string, to: string): Promise<FlowReport> {
  const gtree = await db.select<{ id: number; parent_id: number | null; name: string }>('SELECT id, parent_id, name FROM groups');
  const ledgerIds = new Set<number>();
  let title = '';
  if (by === 'ledger') {
    ledgerIds.add(id);
    title = (await one<{ name: string }>(db, 'SELECT name FROM ledgers WHERE id = ?', [id]))?.name ?? '';
  } else {
    const gset = descendants(gtree, id);
    for (const l of await db.select<{ id: number; group_id: number }>('SELECT id, group_id FROM ledgers')) if (gset.has(l.group_id)) ledgerIds.add(l.id);
    title = gtree.find((g) => g.id === id)?.name ?? '';
  }
  const items = new Map((await stockItems(db)).map((i) => [i.id, i]));
  const moves = (await loadMoves(db, to)).filter((m) => m.date >= from && m.party_id !== null && ledgerIds.has(m.party_id) && (m.parent === 'Purchase' || m.parent === 'Sales' || m.parent === 'Debit Note' || m.parent === 'Credit Note' || m.parent === 'Receipt Note' || m.parent === 'Delivery Note'));
  const rows = new Map<number, FlowRow>();
  for (const m of moves) {
    const it = items.get(m.item_id)!;
    const r = rows.get(it.id) ?? rows.set(it.id, emptyFlow('item', it.id, it.name, it.unit)).get(it.id)!;
    addFlow(r, m);
  }
  return finishFlow(title, [...rows.values()].sort((a, b) => a.name.localeCompare(b.name)));
}

export async function stockTransferAnalysis(db: Db, typeId: number, from: string, to: string): Promise<FlowReport> {
  const t = await one<{ name: string }>(db, 'SELECT name FROM voucher_types WHERE id = ?', [typeId]);
  if (!t) throw new CoreError('not_found', 'Voucher type not found');
  const items = new Map((await stockItems(db)).map((i) => [i.id, i]));
  const moves = (await loadMoves(db, to)).filter((m) => m.date >= from && m.type === t.name);
  const rows = new Map<number, FlowRow>();
  for (const m of moves) {
    const it = items.get(m.item_id)!;
    const r = rows.get(it.id) ?? rows.set(it.id, emptyFlow('item', it.id, it.name, it.unit)).get(it.id)!;
    addFlow(r, m);
  }
  return finishFlow(t.name, [...rows.values()].sort((a, b) => a.name.localeCompare(b.name)));
}

export interface StockHierarchyRow {
  kind: 'group' | 'category' | 'item';
  id: number;
  name: string;
  unit: string;
  opening_qty: number | null;
  opening_value: number;
  in_qty: number | null;
  in_value: number;
  out_qty: number | null;
  out_value: number;
  closing_qty: number | null;
  closing_rate: number;
  closing_value: number;
}

export async function stockHierarchySummary(db: Db, by: 'group' | 'category', id: number | null, from: string, to: string): Promise<{ title: string; rows: StockHierarchyRow[]; total: StockHierarchyRow }> {
  const items = await stockItems(db);
  const tree = by === 'group' ? await stockGroups(db) : await stockCategories(db);
  const sum = await stockSummary(db, from, to);
  const byItem = new Map(sum.rows.map((r) => [r.item_id, r]));
  const key = (i: StockItem) => (by === 'group' ? i.group_id : i.category_id);
  const agg = (kind: StockHierarchyRow['kind'], rid: number, name: string, scope: StockItem[]): StockHierarchyRow => {
    const rs = scope.map((i) => byItem.get(i.id)!).filter(Boolean);
    const same = scope.length > 0 && scope.every((i) => i.unit_id === scope[0].unit_id);
    const q = (f: (r: (typeof rs)[number]) => number) => (same ? rs.reduce((s, r) => s + f(r), 0) : null);
    const cq = q((r) => r.closing_qty);
    const cv = rs.reduce((s, r) => s + r.closing_value, 0);
    return {
      kind,
      id: rid,
      name,
      unit: same ? scope[0].unit : '',
      opening_qty: q((r) => r.opening_qty),
      opening_value: rs.reduce((s, r) => s + r.opening_value, 0),
      in_qty: q((r) => r.in_qty),
      in_value: rs.reduce((s, r) => s + r.in_value, 0),
      out_qty: q((r) => r.out_qty),
      out_value: rs.reduce((s, r) => s + r.out_value, 0),
      closing_qty: cq,
      closing_rate: cq ? rateOf(cv, cq) : 0,
      closing_value: cv,
    };
  };
  const scopeIds = descendants(tree, id);
  const scoped = items.filter((i) => (key(i) === null ? id === null : scopeIds.has(key(i)!)));
  const rows: StockHierarchyRow[] = [];
  for (const c of tree.filter((t) => (id === null ? t.parent_id === null : t.parent_id === id)).sort((a, b) => a.name.localeCompare(b.name))) {
    const sub = descendants(tree, c.id);
    const members = items.filter((i) => key(i) !== null && sub.has(key(i)!));
    if (members.length) rows.push(agg(by, c.id, c.name, members));
  }
  for (const i of scoped.filter((i) => (id === null ? key(i) === null : key(i) === id)).sort((a, b) => a.name.localeCompare(b.name))) rows.push(agg('item', i.id, i.name, [i]));
  const title = id === null ? 'Primary' : tree.find((t) => t.id === id)?.name ?? '';
  return { title, rows, total: agg(by, 0, 'Grand Total', scoped) };
}

export interface AgeingPeriod {
  from: number;
  to: number;
}
export const DEFAULT_AGEING: AgeingPeriod[] = [
  { from: 0, to: 45 },
  { from: 45, to: 90 },
  { from: 90, to: 180 },
  { from: 180, to: 0 },
];

export async function getAgeingPeriods(db: Db): Promise<AgeingPeriod[]> {
  const row = await one<{ value: string }>(db, "SELECT value FROM stockx_config WHERE key = 'ageing_periods'");
  if (!row) return DEFAULT_AGEING;
  try {
    const v = JSON.parse(row.value) as AgeingPeriod[];
    return Array.isArray(v) && v.length ? v : DEFAULT_AGEING;
  } catch {
    return DEFAULT_AGEING;
  }
}

export async function setAgeingPeriods(db: Db, periods: AgeingPeriod[]): Promise<void> {
  if (!periods.length || periods.length > 4) throw new CoreError('invalid', 'Provide between 1 and 4 ageing periods');
  let prev = 0;
  periods.forEach((p, i) => {
    const last = i === periods.length - 1;
    if (p.from < 0 || p.from < prev) throw new CoreError('invalid', 'Ageing periods must be in ascending order');
    if (p.to !== 0 && p.to <= p.from) throw new CoreError('invalid', 'To days must exceed From days');
    if (!last && p.to === 0) throw new CoreError('invalid', 'Only the last period can be open-ended');
    prev = p.to;
  });
  await db.batch([{ sql: "INSERT INTO stockx_config (key, value) VALUES ('ageing_periods', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params: [JSON.stringify(periods)] }]);
}

export function ageingLabel(p: AgeingPeriod, i: number, count: number): string {
  if (i === 0 && p.from === 0) return `(< ${p.to} days )`;
  if (i === count - 1 && p.to === 0) return `(> ${p.from} days )`;
  return `${p.from} to ${p.to} days`;
}

export type AgeingStyle = 'purchase' | 'expiry' | 'mfg' | 'toExpire';

interface Layer {
  date: string;
  qty: number;
  rate: number;
  batch: string;
  mfg: string;
  expiry: string;
  voucher_id: number;
  party: string;
  type: string;
  number: string;
  item_id: number;
}

async function ageingLayers(db: Db, itemId: number, asOf: string): Promise<{ layers: Layer[]; negative: number }> {
  const item = (await stockItem(db, itemId))!;
  const moves = await loadMoves(db, asOf, false, itemId);
  const allocs = await db.select<{ movement_id: number | null; batch: string; mfg_date: string; expiry_date: string; qty: number }>('SELECT movement_id, batch, mfg_date, expiry_date, qty FROM stockx_batches WHERE item_id = ?', [itemId]);
  const byMove = new Map<number, typeof allocs>();
  const opening = allocs.filter((a) => a.movement_id === null);
  for (const a of allocs) if (a.movement_id !== null) (byMove.get(a.movement_id) ?? byMove.set(a.movement_id, []).get(a.movement_id)!).push(a);
  const fy = await fyStart(db);
  const layers: Layer[] = [];
  const base = { voucher_id: 0, party: '', type: 'Opening Balance', number: '', item_id: itemId };
  if (item.opening_qty > 0) {
    const rate = Math.round((item.opening_value * QTY_SCALE) / item.opening_qty);
    if (opening.length) for (const a of opening) layers.push({ ...base, date: fy, qty: Math.abs(a.qty), rate, batch: a.batch, mfg: a.mfg_date, expiry: a.expiry_date });
    else layers.push({ ...base, date: fy, qty: item.opening_qty, rate, batch: 'Primary Batch', mfg: '', expiry: '' });
  }
  let negative = 0;
  let running = item.opening_qty;
  const consume = (qty: number, batch?: string) => {
    let left = qty;
    const order = layers.filter((l) => l.qty > 0 && (!batch || l.batch === batch));
    for (const l of order) {
      if (left <= 0) break;
      const use = Math.min(left, l.qty);
      l.qty -= use;
      left -= use;
    }
    if (left > 0 && batch) return left;
    if (left > 0) negative += left;
    return 0;
  };
  for (const m of moves) {
    let delta = m.qty;
    if (m.parent === 'Physical Stock') {
      delta = m.qty - running;
      if (!delta) continue;
    }
    running += delta;
    const meta = { voucher_id: m.voucher_id, party: m.party, type: m.type, number: m.number, item_id: itemId };
    const al = byMove.get(m.id) ?? [];
    if (delta > 0) {
      if (negative > 0) {
        const cover = Math.min(negative, delta);
        negative -= cover;
        delta -= cover;
      }
      if (delta <= 0) continue;
      if (al.length && m.parent !== 'Physical Stock')
        for (const a of al) layers.push({ ...meta, date: m.date, qty: Math.abs(a.qty), rate: m.rate, batch: a.batch, mfg: a.mfg_date, expiry: a.expiry_date });
      else layers.push({ ...meta, date: m.date, qty: delta, rate: m.rate, batch: 'Primary Batch', mfg: '', expiry: '' });
    } else if (al.length && m.parent !== 'Physical Stock') {
      for (const a of al) {
        const rest = consume(Math.abs(a.qty), a.batch);
        if (rest > 0) consume(rest);
      }
    } else consume(-delta);
  }
  return { layers: layers.filter((l) => l.qty > 0), negative };
}

function layerDays(l: Layer, asOf: string, style: AgeingStyle): number | null {
  if (style === 'purchase') return daysBetween(l.date, asOf);
  if (style === 'mfg') return daysBetween(l.mfg || l.date, asOf);
  if (!l.expiry) return null;
  return daysBetween(asOf, l.expiry);
}

function bucketOf(days: number, periods: AgeingPeriod[]): number {
  const d = Math.max(0, days);
  for (let i = 0; i < periods.length; i++) {
    const p = periods[i];
    if (d >= p.from && (p.to === 0 || d < p.to)) return i;
  }
  return periods.length - 1;
}

export interface AgeingLine {
  key: string;
  item_id: number;
  name: string;
  batch: string;
  expiry_date: string;
  unit: string;
  total: number;
  total_value: number;
  buckets: number[];
  bucket_values: number[];
  negative: number;
  children: AgeingLine[];
}

export interface AgeingOptions {
  style?: AgeingStyle;
  periods?: AgeingPeriod[];
  onlyExpired?: boolean;
}

export async function stockAgeing(db: Db, groupId: number | null, asOf: string, opts: AgeingOptions = {}): Promise<{ periods: AgeingPeriod[]; rows: AgeingLine[]; total: AgeingLine }> {
  const periods = opts.periods ?? (await getAgeingPeriods(db));
  const style = opts.style ?? 'purchase';
  const gs = await stockGroups(db);
  const gset = descendants(gs, groupId);
  const items = (await stockItems(db)).filter((i) => (i.group_id === null ? groupId === null : gset.has(i.group_id)));
  const mk = (key: string, item_id: number, name: string, unit: string, batch = '', expiry = ''): AgeingLine => ({
    key,
    item_id,
    name,
    batch,
    expiry_date: expiry,
    unit,
    total: 0,
    total_value: 0,
    buckets: periods.map(() => 0),
    bucket_values: periods.map(() => 0),
    negative: 0,
    children: [],
  });
  const rows: AgeingLine[] = [];
  for (const it of items) {
    const { layers, negative } = await ageingLayers(db, it.id, asOf);
    const line = mk(`i${it.id}`, it.id, it.name, it.unit);
    line.negative = negative;
    const batched = layers.some((l) => l.batch !== 'Primary Batch');
    for (const l of layers) {
      const d = layerDays(l, asOf, style);
      if (d === null) continue;
      if ((style === 'toExpire' || opts.onlyExpired) && !l.expiry) continue;
      if (opts.onlyExpired && d >= 0) continue;
      if (style === 'toExpire' && !opts.onlyExpired && d < 0) continue;
      const b = bucketOf(d, periods);
      const val = Math.round((l.qty * l.rate) / QTY_SCALE);
      line.total += l.qty;
      line.total_value += val;
      line.buckets[b] += l.qty;
      line.bucket_values[b] += val;
      if (batched) {
        const ck = `${line.key}b${l.batch}`;
        let c = line.children.find((x) => x.key === ck);
        if (!c) {
          c = mk(ck, it.id, l.batch, it.unit, l.batch, l.expiry);
          line.children.push(c);
        }
        c.total += l.qty;
        c.total_value += val;
        c.buckets[b] += l.qty;
        c.bucket_values[b] += val;
      }
    }
    if (line.total || line.negative) rows.push(line);
  }
  const total = mk('total', 0, 'Grand Total', '');
  for (const r of rows) {
    total.total += r.total;
    total.total_value += r.total_value;
    total.negative += r.negative;
    r.buckets.forEach((q, i) => {
      total.buckets[i] += q;
      total.bucket_values[i] += r.bucket_values[i];
    });
  }
  return { periods, rows, total };
}

export interface AgeingInwardRow {
  voucher_id: number;
  date: string;
  party: string;
  type: string;
  number: string;
  batch: string;
  qty: number;
  rate: number;
}

export async function ageingInwardDetails(db: Db, itemId: number, asOf: string, bucket: number, opts: AgeingOptions = {}): Promise<AgeingInwardRow[]> {
  const periods = opts.periods ?? (await getAgeingPeriods(db));
  const style = opts.style ?? 'purchase';
  const { layers } = await ageingLayers(db, itemId, asOf);
  return layers
    .filter((l) => {
      const d = layerDays(l, asOf, style);
      return d !== null && (bucket < 0 || bucketOf(d, periods) === bucket);
    })
    .map((l) => ({ voucher_id: l.voucher_id, date: l.date, party: l.party, type: l.type, number: l.number, batch: l.batch, qty: l.qty, rate: l.rate }));
}

export interface ReorderRow {
  item_id: number;
  name: string;
  unit: string;
  closing_qty: number;
  purchase_orders_pending: number;
  sale_orders_due: number;
  nett_available: number;
  reorder_level: number;
  shortfall: number;
  min_order_qty: number;
  order_to_be_placed: number;
}

export async function reorderStatus(db: Db, groupId: number | null, asAt: string, reorderOnly = false): Promise<{ rows: ReorderRow[] }> {
  const gs = await stockGroups(db);
  const gset = descendants(gs, groupId);
  const items = (await stockItems(db)).filter((i) => (i.group_id === null ? groupId === null : gset.has(i.group_id)));
  const sum = await stockSummary(db, '0000-01-01', asAt);
  const closing = new Map(sum.rows.map((r) => [r.item_id, r.closing_qty]));
  const po = await orderLines(db, 'Purchase', asAt);
  const so = await orderLines(db, 'Sales', asAt);
  const pending = (list: OrderRow[], due: boolean) => {
    const m = new Map<number, number>();
    for (const r of list) if (r.balance > 0 && !r.preclosed && (!due || r.due_date <= asAt)) m.set(r.item_id, (m.get(r.item_id) ?? 0) + r.balance);
    return m;
  };
  const pm = pending(po, false);
  const sm = pending(so, true);
  const rows = items.map((i) => {
    const c = closing.get(i.id) ?? 0;
    const p = pm.get(i.id) ?? 0;
    const s = sm.get(i.id) ?? 0;
    const nett = c + p - s;
    const short = i.reorder_qty > 0 ? Math.max(0, i.reorder_qty - nett) : 0;
    return {
      item_id: i.id,
      name: i.name,
      unit: i.unit,
      closing_qty: c,
      purchase_orders_pending: p,
      sale_orders_due: s,
      nett_available: nett,
      reorder_level: i.reorder_qty,
      shortfall: short,
      min_order_qty: i.min_order_qty,
      order_to_be_placed: short > 0 ? Math.max(short, i.min_order_qty) : 0,
    };
  });
  return { rows: reorderOnly ? rows.filter((r) => r.reorder_level > 0 && r.shortfall > 0) : rows };
}

export interface OrderRow {
  movement_id: number;
  voucher_id: number;
  date: string;
  number: string;
  party_id: number | null;
  party: string;
  party_group_id: number | null;
  item_id: number;
  item: string;
  unit: string;
  stock_group_id: number | null;
  godown: string;
  ordered: number;
  delivered: number;
  balance: number;
  rate: number;
  discount_bp: number;
  value: number;
  due_date: string;
  overdue_days: number;
  preclosed: boolean;
}

export async function orderLines(db: Db, kind: 'Sales' | 'Purchase', asAt: string): Promise<OrderRow[]> {
  const rows = await db.select<{
    id: number;
    voucher_id: number;
    date: string;
    number: string;
    party_id: number | null;
    party: string;
    party_group_id: number | null;
    item_id: number;
    item: string;
    unit: string;
    stock_group_id: number | null;
    godown: string;
    qty: number;
    rate: number;
    discount_bp: number;
    delivered: number;
    due_date: string | null;
    preclosed: number | null;
  }>(
    `SELECT m.id, m.voucher_id, v.date, v.number, v.party_id, COALESCE(p.name, '') AS party, p.group_id AS party_group_id, m.item_id, i.name AS item, u.symbol AS unit, i.group_id AS stock_group_id,
            COALESCE(g.name, '') AS godown, m.qty, m.rate, m.discount_bp,
            COALESCE((SELECT SUM(k.qty) FROM stockx_track k WHERE k.against_id = m.id), 0) AS delivered, o.due_date, o.preclosed
     FROM stock_movements m JOIN vouchers v ON v.id = m.voucher_id JOIN voucher_types t ON t.id = v.type_id JOIN stock_items i ON i.id = m.item_id JOIN units u ON u.id = i.unit_id
     LEFT JOIN ledgers p ON p.id = v.party_id LEFT JOIN godowns g ON g.id = m.godown_id LEFT JOIN stockx_order_meta o ON o.movement_id = m.id
     WHERE v.cancelled = 0 AND v.date <= ? AND t.parent = ? ORDER BY v.date, v.id, m.seq`,
    [asAt, `${kind} Order`]
  );
  return rows.map((r) => {
    const ordered = Math.abs(r.qty);
    const balance = Math.max(0, ordered - r.delivered);
    const due = r.due_date || r.date;
    return {
      movement_id: r.id,
      voucher_id: r.voucher_id,
      date: r.date,
      number: r.number,
      party_id: r.party_id,
      party: r.party,
      party_group_id: r.party_group_id,
      item_id: r.item_id,
      item: r.item,
      unit: r.unit,
      stock_group_id: r.stock_group_id,
      godown: r.godown,
      ordered,
      delivered: r.delivered,
      balance,
      rate: r.rate,
      discount_bp: r.discount_bp,
      value: lineAmount(balance, r.rate, r.discount_bp),
      due_date: due,
      overdue_days: Math.max(0, daysBetween(due, asAt)),
      preclosed: !!r.preclosed,
    };
  });
}

export interface OrderOptions {
  dueOnly?: boolean;
  preclosedOnly?: boolean;
  all?: boolean;
  itemId?: number;
  stockGroupId?: number | null;
  ledgerGroupId?: number;
  ledgerId?: number;
}

export async function orderOutstandings(db: Db, kind: 'Sales' | 'Purchase', asAt: string, opts: OrderOptions = {}): Promise<OrderRow[]> {
  let rows = await orderLines(db, kind, asAt);
  if (opts.preclosedOnly) rows = rows.filter((r) => r.preclosed);
  else if (!opts.all) rows = rows.filter((r) => r.balance > 0 && !r.preclosed);
  if (opts.dueOnly) rows = rows.filter((r) => r.due_date <= asAt);
  if (opts.itemId) rows = rows.filter((r) => r.item_id === opts.itemId);
  if (opts.ledgerId) rows = rows.filter((r) => r.party_id === opts.ledgerId);
  if (opts.ledgerGroupId) {
    const gtree = await db.select<{ id: number; parent_id: number | null }>('SELECT id, parent_id FROM groups');
    const gset = descendants(gtree, opts.ledgerGroupId);
    rows = rows.filter((r) => r.party_group_id !== null && gset.has(r.party_group_id));
  }
  if (opts.stockGroupId !== undefined && opts.stockGroupId !== null) {
    const gset = descendants(await stockGroups(db), opts.stockGroupId);
    rows = rows.filter((r) => r.stock_group_id !== null && gset.has(r.stock_group_id));
  }
  return rows;
}

export interface OrderSummaryRow {
  kind: 'group' | 'item';
  id: number;
  name: string;
  unit: string;
  qty: number | null;
  rate: number;
  value: number;
}

export async function orderOutstandingSummary(
  db: Db,
  kind: 'Sales' | 'Purchase',
  asAt: string,
  scope: { stockGroupId?: number | null; ledgerGroupId?: number; ledgerId?: number },
  opts: { dueOnly?: boolean; itemWise?: boolean; showZero?: boolean } = {}
): Promise<{ rows: OrderSummaryRow[]; total: number }> {
  const rows = await orderOutstandings(db, kind, asAt, { dueOnly: opts.dueOnly, ledgerGroupId: scope.ledgerGroupId, ledgerId: scope.ledgerId, stockGroupId: scope.stockGroupId ?? undefined });
  const byItem = new Map<number, { name: string; unit: string; group: number | null; qty: number; value: number }>();
  for (const r of rows) {
    const a = byItem.get(r.item_id) ?? byItem.set(r.item_id, { name: r.item, unit: r.unit, group: r.stock_group_id, qty: 0, value: 0 }).get(r.item_id)!;
    a.qty += r.balance;
    a.value += r.value;
  }
  if (opts.showZero) for (const i of await stockItems(db)) if (!byItem.has(i.id)) byItem.set(i.id, { name: i.name, unit: i.unit, group: i.group_id, qty: 0, value: 0 });
  const out: OrderSummaryRow[] = [];
  const itemRow = (id: number, a: { name: string; unit: string; qty: number; value: number }): OrderSummaryRow => ({ kind: 'item', id, name: a.name, unit: a.unit, qty: a.qty, rate: rateOf(a.value, a.qty), value: a.value });
  const sg = scope.stockGroupId;
  if (sg !== undefined && !opts.itemWise) {
    const tree = await stockGroups(db);
    const parent = sg === null ? null : sg;
    for (const c of tree.filter((t) => t.parent_id === parent)) {
      const sub = descendants(tree, c.id);
      const members = [...byItem.values()].filter((a) => a.group !== null && sub.has(a.group));
      if (!members.length) continue;
      out.push({ kind: 'group', id: c.id, name: c.name, unit: '', qty: null, rate: 0, value: members.reduce((s, a) => s + a.value, 0) });
    }
    for (const [id, a] of byItem) if (a.group === parent) out.push(itemRow(id, a));
  } else for (const [id, a] of [...byItem].sort((x, y) => x[1].name.localeCompare(y[1].name))) out.push(itemRow(id, a));
  return { rows: out, total: out.reduce((s, r) => s + r.value, 0) };
}

export function ageOrders(rows: OrderRow[], asAt: string, method: 'bill' | 'due', periods: AgeingPeriod[]): { periods: AgeingPeriod[]; buckets: { value: number; qty: number }[] } {
  const buckets = periods.map(() => ({ value: 0, qty: 0 }));
  for (const r of rows) {
    const d = daysBetween(method === 'bill' ? r.date : r.due_date, asAt);
    const b = bucketOf(d, periods);
    buckets[b].value += r.value;
    buckets[b].qty += r.balance;
  }
  return { periods, buckets };
}

export async function setOrderDueDate(db: Db, movementId: number, due: string): Promise<void> {
  await db.batch([{ sql: 'INSERT INTO stockx_order_meta (movement_id, due_date, preclosed) VALUES (?, ?, 0) ON CONFLICT(movement_id) DO UPDATE SET due_date = excluded.due_date', params: [movementId, due] }]);
}

export async function setOrderPreclosed(db: Db, movementIds: number[], preclosed: boolean): Promise<void> {
  await db.batch(movementIds.map((id) => ({ sql: 'INSERT INTO stockx_order_meta (movement_id, due_date, preclosed) VALUES (?, ?, ?) ON CONFLICT(movement_id) DO UPDATE SET preclosed = excluded.preclosed', params: [id, '', preclosed ? 1 : 0] })));
}

export async function trackAgainst(db: Db, movementId: number, againstId: number, qty: number): Promise<void> {
  if (!(qty > 0)) throw new CoreError('invalid', 'Tracked quantity must be positive');
  if (!(await one(db, 'SELECT 1 FROM stock_movements WHERE id = ?', [movementId])) || !(await one(db, 'SELECT 1 FROM stock_movements WHERE id = ?', [againstId]))) throw new CoreError('not_found', 'Stock line not found');
  await db.batch([{ sql: 'INSERT INTO stockx_track (id, movement_id, against_id, qty) VALUES (?, ?, ?, ?)', params: [await nextId(db, 'stockx_track'), movementId, againstId, qty] }]);
}

export async function clearTracking(db: Db, movementId: number): Promise<void> {
  await db.batch([{ sql: 'DELETE FROM stockx_track WHERE movement_id = ?', params: [movementId] }]);
}

export interface TrackCandidate {
  movement_id: number;
  voucher_id: number;
  number: string;
  date: string;
  balance: number;
  rate: number;
  discount_bp: number;
}

export async function trackingCandidates(db: Db, parent: 'Sales Order' | 'Purchase Order' | 'Delivery Note' | 'Receipt Note', partyId: number, itemId: number, asAt: string): Promise<TrackCandidate[]> {
  const rows = await db.select<{ id: number; voucher_id: number; number: string; date: string; qty: number; rate: number; discount_bp: number; done: number; pre: number | null }>(
    `SELECT m.id, m.voucher_id, v.number, v.date, m.qty, m.rate, m.discount_bp, COALESCE((SELECT SUM(k.qty) FROM stockx_track k WHERE k.against_id = m.id), 0) AS done, o.preclosed AS pre
     FROM stock_movements m JOIN vouchers v ON v.id = m.voucher_id JOIN voucher_types t ON t.id = v.type_id LEFT JOIN stockx_order_meta o ON o.movement_id = m.id
     WHERE v.cancelled = 0 AND v.date <= ? AND t.parent = ? AND v.party_id = ? AND m.item_id = ? ORDER BY v.date, v.id`,
    [asAt, parent, partyId, itemId]
  );
  return rows
    .map((r) => ({ movement_id: r.id, voucher_id: r.voucher_id, number: r.number, date: r.date, balance: Math.abs(r.qty) - r.done, rate: r.rate, discount_bp: r.discount_bp, pre: r.pre }))
    .filter((r) => r.balance > 0 && !r.pre)
    .map((r) => ({ movement_id: r.movement_id, voucher_id: r.voucher_id, number: r.number, date: r.date, balance: r.balance, rate: r.rate, discount_bp: r.discount_bp }));
}

export interface BillRow {
  movement_id: number;
  voucher_id: number;
  date: string;
  number: string;
  party: string;
  item: string;
  godown: string;
  initial: number;
  pending: number;
  rate: number;
  discount_bp: number;
  value: number;
}

export async function billsPending(db: Db, kind: 'Sales' | 'Purchase', from: string, to: string): Promise<{ pending: BillRow[]; cleared: BillRow[] }> {
  const parent = kind === 'Sales' ? 'Delivery Note' : 'Receipt Note';
  const rows = await db.select<{ id: number; voucher_id: number; date: string; number: string; party: string; item: string; godown: string; qty: number; rate: number; discount_bp: number; done: number }>(
    `SELECT m.id, m.voucher_id, v.date, v.number, COALESCE(p.name, '') AS party, i.name AS item, COALESCE(g.name, '') AS godown, m.qty, m.rate, m.discount_bp,
            COALESCE((SELECT SUM(k.qty) FROM stockx_track k WHERE k.against_id = m.id), 0) AS done
     FROM stock_movements m JOIN vouchers v ON v.id = m.voucher_id JOIN voucher_types t ON t.id = v.type_id JOIN stock_items i ON i.id = m.item_id
     LEFT JOIN ledgers p ON p.id = v.party_id LEFT JOIN godowns g ON g.id = m.godown_id
     WHERE v.cancelled = 0 AND v.date >= ? AND v.date <= ? AND t.parent = ? ORDER BY v.date, v.id, m.seq`,
    [from, to, parent]
  );
  const pending: BillRow[] = [];
  const cleared: BillRow[] = [];
  for (const r of rows) {
    const initial = Math.abs(r.qty);
    const left = Math.max(0, initial - r.done);
    const row: BillRow = {
      movement_id: r.id,
      voucher_id: r.voucher_id,
      date: r.date,
      number: r.number,
      party: r.party,
      item: r.item,
      godown: r.godown,
      initial,
      pending: left,
      rate: r.rate,
      discount_bp: r.discount_bp,
      value: lineAmount(left > 0 ? left : initial, r.rate, r.discount_bp),
    };
    (left > 0 ? pending : cleared).push(row);
  }
  return { pending, cleared };
}

export interface BatchAllocInput {
  batch: string;
  mfg_date?: string;
  expiry_date?: string;
  qty: number;
}
export interface BatchAlloc {
  id: number;
  movement_id: number | null;
  item_id: number;
  godown_id: number | null;
  batch: string;
  mfg_date: string;
  expiry_date: string;
  qty: number;
}

function cleanAllocs(allocs: BatchAllocInput[]): BatchAllocInput[] {
  return allocs
    .filter((a) => a.qty > 0)
    .map((a) => {
      const batch = clean(a.batch, 60) || 'Primary Batch';
      const mfg = clean(a.mfg_date, 10);
      const exp = clean(a.expiry_date, 10);
      if (mfg && exp && exp < mfg) throw new CoreError('invalid', `Expiry date of batch ${batch} is before its manufacturing date`);
      return { batch, mfg_date: mfg, expiry_date: exp, qty: a.qty };
    });
}

export async function saveBatchAllocations(db: Db, movementId: number, allocs: BatchAllocInput[]): Promise<void> {
  const mv = await one<{ item_id: number; godown_id: number | null; qty: number }>(db, 'SELECT item_id, godown_id, qty FROM stock_movements WHERE id = ?', [movementId]);
  if (!mv) throw new CoreError('not_found', 'Stock line not found');
  const list = cleanAllocs(allocs);
  const total = list.reduce((s, a) => s + a.qty, 0);
  if (list.length && total !== Math.abs(mv.qty)) throw new CoreError('invalid', 'Batch quantities must add up to the line quantity');
  const sign = mv.qty < 0 ? -1 : 1;
  let id = await nextId(db, 'stockx_batches');
  await db.batch([
    { sql: 'DELETE FROM stockx_batches WHERE movement_id = ?', params: [movementId] },
    ...list.map((a) => ({
      sql: 'INSERT INTO stockx_batches (id, movement_id, item_id, godown_id, batch, mfg_date, expiry_date, qty) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      params: [id++, movementId, mv.item_id, mv.godown_id ?? 1, a.batch, a.mfg_date ?? '', a.expiry_date ?? '', sign * a.qty],
    })),
  ]);
}

export async function saveOpeningBatches(db: Db, itemId: number, allocs: BatchAllocInput[], godownId = 1): Promise<void> {
  const item = await stockItem(db, itemId);
  if (!item) throw new CoreError('not_found', 'Stock item not found');
  const list = cleanAllocs(allocs);
  if (list.length && list.reduce((s, a) => s + a.qty, 0) !== item.opening_qty) throw new CoreError('invalid', 'Batch quantities must add up to the opening quantity');
  let id = await nextId(db, 'stockx_batches');
  await db.batch([
    { sql: 'DELETE FROM stockx_batches WHERE item_id = ? AND movement_id IS NULL', params: [itemId] },
    ...list.map((a) => ({
      sql: 'INSERT INTO stockx_batches (id, movement_id, item_id, godown_id, batch, mfg_date, expiry_date, qty) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)',
      params: [id++, itemId, godownId, a.batch, a.mfg_date ?? '', a.expiry_date ?? '', a.qty],
    })),
  ]);
}

export async function batchAllocations(db: Db, movementId: number): Promise<BatchAlloc[]> {
  return db.select<BatchAlloc>('SELECT * FROM stockx_batches WHERE movement_id = ? ORDER BY id', [movementId]);
}

export async function openingBatches(db: Db, itemId: number): Promise<BatchAlloc[]> {
  return db.select<BatchAlloc>('SELECT * FROM stockx_batches WHERE item_id = ? AND movement_id IS NULL ORDER BY id', [itemId]);
}

export interface BatchBalance {
  item_id: number;
  item: string;
  unit: string;
  godown_id: number;
  godown: string;
  batch: string;
  mfg_date: string;
  expiry_date: string;
  qty: number;
  rate: number;
  value: number;
}

export async function batchBalances(db: Db, itemId: number | null, asOf: string, godownId?: number): Promise<BatchBalance[]> {
  const rows = await db.select<{ item_id: number; item: string; unit: string; godown_id: number; godown: string; batch: string; mfg_date: string; expiry_date: string; qty: number; amount: number; rate: number }>(
    `SELECT b.item_id, i.name AS item, u.symbol AS unit, COALESCE(b.godown_id, 1) AS godown_id, COALESCE(g.name, '') AS godown, b.batch, b.mfg_date, b.expiry_date, b.qty,
            CASE WHEN b.movement_id IS NULL THEN 0 ELSE m.amount END AS amount, CASE WHEN b.movement_id IS NULL THEN i.opening_rate ELSE m.rate END AS rate
     FROM stockx_batches b JOIN stock_items i ON i.id = b.item_id JOIN units u ON u.id = i.unit_id LEFT JOIN godowns g ON g.id = b.godown_id
     LEFT JOIN stock_movements m ON m.id = b.movement_id LEFT JOIN vouchers v ON v.id = m.voucher_id LEFT JOIN voucher_types t ON t.id = v.type_id
     WHERE (b.movement_id IS NULL OR (v.cancelled = 0 AND v.date <= ? AND t.parent NOT IN ${ORDER_PARENTS}))${itemId ? ' AND b.item_id = ' + Number(itemId) : ''}${godownId ? ' AND COALESCE(b.godown_id, 1) = ' + Number(godownId) : ''}
     ORDER BY i.name, b.batch, b.id`,
    [asOf]
  );
  const map = new Map<string, BatchBalance & { in_qty: number; in_value: number }>();
  for (const r of rows) {
    const k = `${r.item_id}|${r.godown_id}|${r.batch}`;
    const a = map.get(k) ?? map.set(k, { item_id: r.item_id, item: r.item, unit: r.unit, godown_id: r.godown_id, godown: r.godown, batch: r.batch, mfg_date: r.mfg_date, expiry_date: r.expiry_date, qty: 0, rate: 0, value: 0, in_qty: 0, in_value: 0 }).get(k)!;
    a.qty += r.qty;
    if (r.qty > 0) {
      a.in_qty += r.qty;
      a.in_value += r.amount || Math.round((r.qty * r.rate) / QTY_SCALE);
    }
    if (!a.mfg_date) a.mfg_date = r.mfg_date;
    if (!a.expiry_date) a.expiry_date = r.expiry_date;
  }
  return [...map.values()]
    .filter((a) => a.qty !== 0)
    .map(({ in_qty, in_value, ...a }) => {
      const rate = rateOf(in_value, in_qty);
      return { ...a, rate, value: Math.round((a.qty * rate) / QTY_SCALE) };
    });
}

export async function batchList(db: Db, itemId: number, godownId: number | null, asOf: string): Promise<BatchBalance[]> {
  const rows = await batchBalances(db, itemId, asOf, godownId ?? undefined);
  return rows.filter((r) => r.qty > 0).sort((a, b) => (a.expiry_date || '9999').localeCompare(b.expiry_date || '9999') || a.batch.localeCompare(b.batch));
}

export interface BatchMaster {
  item_id: number;
  batch: string;
  mfg_date: string;
  expiry_date: string;
}

export async function batchMasters(db: Db, itemId: number): Promise<BatchMaster[]> {
  return db.select<BatchMaster>(
    "SELECT item_id, batch, MAX(mfg_date) AS mfg_date, MAX(expiry_date) AS expiry_date FROM stockx_batches WHERE item_id = ? GROUP BY item_id, batch ORDER BY batch",
    [itemId]
  );
}

export async function batchSummary(db: Db, itemId: number | null, asOf: string, opts: { expiredOnly?: boolean; godownId?: number } = {}): Promise<{ rows: BatchBalance[]; total_value: number }> {
  let rows = await batchBalances(db, itemId, asOf, opts.godownId);
  if (opts.expiredOnly) rows = rows.filter((r) => r.expiry_date && r.expiry_date < asOf);
  return { rows, total_value: rows.reduce((s, r) => s + r.value, 0) };
}

export interface PriceLevel {
  id: number;
  name: string;
}

export async function priceLevels(db: Db): Promise<PriceLevel[]> {
  return db.select<PriceLevel>('SELECT id, name FROM stockx_price_levels ORDER BY id');
}

export async function createPriceLevel(db: Db, name: string): Promise<PriceLevel> {
  const n = clean(name, 60);
  if (!n) throw new CoreError('invalid', 'Price level name is required');
  if (await one(db, 'SELECT 1 FROM stockx_price_levels WHERE name = ?', [n])) throw new CoreError('conflict', `Price level ${n} already exists`);
  const id = await nextId(db, 'stockx_price_levels');
  await db.batch([{ sql: 'INSERT INTO stockx_price_levels (id, name) VALUES (?, ?)', params: [id, n] }]);
  return { id, name: n };
}

export async function renamePriceLevel(db: Db, id: number, name: string): Promise<void> {
  const n = clean(name, 60);
  if (!n) throw new CoreError('invalid', 'Price level name is required');
  if (await one(db, 'SELECT 1 FROM stockx_price_levels WHERE name = ? AND id <> ?', [n, id])) throw new CoreError('conflict', `Price level ${n} already exists`);
  await db.batch([{ sql: 'UPDATE stockx_price_levels SET name = ? WHERE id = ?', params: [n, id] }]);
}

export async function deletePriceLevel(db: Db, id: number): Promise<void> {
  if ((await one<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM stockx_price_list WHERE level_id = ?', [id]))!.c) throw new CoreError('conflict', 'Price level has price lists and cannot be deleted');
  await db.batch([
    { sql: 'DELETE FROM stockx_party_level WHERE level_id = ?', params: [id] },
    { sql: 'DELETE FROM stockx_price_levels WHERE id = ?', params: [id] },
  ]);
}

export async function partyPriceLevel(db: Db, ledgerId: number): Promise<PriceLevel | null> {
  return (await one<PriceLevel>(db, 'SELECT l.id, l.name FROM stockx_party_level p JOIN stockx_price_levels l ON l.id = p.level_id WHERE p.ledger_id = ?', [ledgerId])) ?? null;
}

export async function setPartyPriceLevel(db: Db, ledgerId: number, levelId: number | null): Promise<void> {
  await db.batch(
    levelId
      ? [{ sql: 'INSERT INTO stockx_party_level (ledger_id, level_id) VALUES (?, ?) ON CONFLICT(ledger_id) DO UPDATE SET level_id = excluded.level_id', params: [ledgerId, levelId] }]
      : [{ sql: 'DELETE FROM stockx_party_level WHERE ledger_id = ?', params: [ledgerId] }]
  );
}

export interface PriceSlab {
  from_qty: number;
  less_than_qty: number;
  rate: number;
  disc_bp: number;
}
export interface PriceVersion {
  applicable_from: string;
  slabs: PriceSlab[];
}

function validateSlabs(slabs: PriceSlab[]): PriceSlab[] {
  const list = slabs.filter((s) => s.rate > 0 || s.disc_bp > 0).map((s) => ({ from_qty: s.from_qty || 0, less_than_qty: s.less_than_qty || 0, rate: s.rate || 0, disc_bp: s.disc_bp || 0 }));
  list.sort((a, b) => a.from_qty - b.from_qty);
  list.forEach((s, i) => {
    if (s.rate < 0 || s.disc_bp < 0 || s.disc_bp > 10000) throw new CoreError('invalid', 'Rate or discount is invalid');
    if (s.less_than_qty !== 0 && s.less_than_qty <= s.from_qty) throw new CoreError('invalid', 'Less than quantity must exceed From quantity');
    if (i > 0 && (list[i - 1].less_than_qty === 0 || list[i - 1].less_than_qty > s.from_qty)) throw new CoreError('invalid', 'Quantity slabs overlap');
  });
  return list;
}

export async function setItemPriceList(db: Db, input: { level_id: number; item_id: number; applicable_from: string; slabs: PriceSlab[] }): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.applicable_from)) throw new CoreError('invalid', 'Applicable from date is required');
  if (!(await one(db, 'SELECT 1 FROM stockx_price_levels WHERE id = ?', [input.level_id]))) throw new CoreError('not_found', 'Price level not found');
  if (!(await stockItem(db, input.item_id))) throw new CoreError('not_found', 'Stock item not found');
  const slabs = validateSlabs(input.slabs);
  let id = await nextId(db, 'stockx_price_list');
  await db.batch([
    { sql: 'DELETE FROM stockx_price_list WHERE level_id = ? AND item_id = ? AND applicable_from = ?', params: [input.level_id, input.item_id, input.applicable_from] },
    ...slabs.map((s) => ({
      sql: 'INSERT INTO stockx_price_list (id, level_id, item_id, applicable_from, from_qty, less_than_qty, rate, disc_bp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      params: [id++, input.level_id, input.item_id, input.applicable_from, s.from_qty, s.less_than_qty, s.rate, s.disc_bp],
    })),
  ]);
}

export async function itemPriceVersions(db: Db, levelId: number, itemId: number): Promise<PriceVersion[]> {
  const rows = await db.select<PriceSlab & { applicable_from: string }>(
    'SELECT applicable_from, from_qty, less_than_qty, rate, disc_bp FROM stockx_price_list WHERE level_id = ? AND item_id = ? ORDER BY applicable_from DESC, from_qty',
    [levelId, itemId]
  );
  const out: PriceVersion[] = [];
  for (const r of rows) {
    let v = out.find((x) => x.applicable_from === r.applicable_from);
    if (!v) out.push((v = { applicable_from: r.applicable_from, slabs: [] }));
    v.slabs.push({ from_qty: r.from_qty, less_than_qty: r.less_than_qty, rate: r.rate, disc_bp: r.disc_bp });
  }
  return out;
}

export interface PriceListRow {
  item_id: number;
  name: string;
  unit: string;
  slabs: PriceSlab[];
  slabs_from: string;
  history: PriceSlab[];
  cost_rate: number;
}

export async function priceList(db: Db, levelId: number, appliedOn: string, scope: { stockGroupId?: number | null; categoryId?: number | null } = {}): Promise<PriceListRow[]> {
  const gs = await stockGroups(db);
  const cs = await stockCategories(db);
  const gset = scope.stockGroupId ? descendants(gs, scope.stockGroupId) : null;
  const cset = scope.categoryId ? descendants(cs, scope.categoryId) : null;
  const items = (await stockItems(db)).filter((i) => (!gset || (i.group_id !== null && gset.has(i.group_id))) && (!cset || (i.category_id !== null && cset.has(i.category_id))));
  const sum = await stockSummary(db, '0000-01-01', appliedOn);
  const cost = new Map(sum.rows.map((r) => [r.item_id, r.closing_rate]));
  const rows: PriceListRow[] = [];
  for (const it of items) {
    const versions = await itemPriceVersions(db, levelId, it.id);
    const cur = versions.find((v) => v.applicable_from <= appliedOn);
    const idx = cur ? versions.indexOf(cur) : -1;
    rows.push({ item_id: it.id, name: it.name, unit: it.unit, slabs: cur?.slabs ?? [], slabs_from: cur?.applicable_from ?? '', history: idx >= 0 ? versions[idx + 1]?.slabs ?? [] : [], cost_rate: cost.get(it.id) ?? 0 });
  }
  return rows;
}

export type ReviseMode = 'none' | 'dec_amount' | 'dec_pct' | 'inc_amount' | 'inc_pct';

export interface ReviseInput {
  level_id: number;
  applicable_from: string;
  stock_group_id?: number | null;
  price_mode: ReviseMode;
  price_value: number;
  disc_mode: 'none' | 'dec_pct' | 'inc_pct';
  disc_value: number;
}

export async function revisePriceList(db: Db, input: ReviseInput, dryRun = false): Promise<{ item_id: number; name: string; slabs: PriceSlab[] }[]> {
  const rows = await priceList(db, input.level_id, input.applicable_from, { stockGroupId: input.stock_group_id });
  const out: { item_id: number; name: string; slabs: PriceSlab[] }[] = [];
  for (const r of rows) {
    if (!r.slabs.length) continue;
    const slabs = r.slabs.map((s) => {
      let rate = s.rate;
      if (input.price_mode === 'dec_amount') rate -= input.price_value;
      else if (input.price_mode === 'inc_amount') rate += input.price_value;
      else if (input.price_mode === 'dec_pct') rate -= Math.round((rate * input.price_value) / 10000);
      else if (input.price_mode === 'inc_pct') rate += Math.round((rate * input.price_value) / 10000);
      let disc = s.disc_bp;
      if (input.disc_mode === 'dec_pct') disc -= input.disc_value;
      else if (input.disc_mode === 'inc_pct') disc += input.disc_value;
      return { ...s, rate: Math.max(0, rate), disc_bp: Math.min(10000, Math.max(0, disc)) };
    });
    out.push({ item_id: r.item_id, name: r.name, slabs });
    if (!dryRun) await setItemPriceList(db, { level_id: input.level_id, item_id: r.item_id, applicable_from: input.applicable_from, slabs });
  }
  return out;
}

export interface ItemPrice {
  rate: number;
  disc_bp: number;
  source: 'price_list' | 'standard' | 'none';
  level_id: number | null;
}

export async function getItemPrice(db: Db, input: { item_id: number; date: string; qty: number; level_id?: number | null; party_id?: number | null }): Promise<ItemPrice> {
  let levelId = input.level_id ?? null;
  if (!levelId && input.party_id) levelId = (await partyPriceLevel(db, input.party_id))?.id ?? null;
  if (levelId) {
    const versions = await itemPriceVersions(db, levelId, input.item_id);
    const cur = versions.find((v) => v.applicable_from <= input.date);
    const slab = cur?.slabs.find((s) => input.qty >= s.from_qty && (s.less_than_qty === 0 || input.qty < s.less_than_qty));
    if (slab) return { rate: slab.rate, disc_bp: slab.disc_bp, source: 'price_list', level_id: levelId };
  }
  const item = await stockItem(db, input.item_id);
  if (item && item.standard_price > 0) return { rate: item.standard_price, disc_bp: 0, source: 'standard', level_id: levelId };
  return { rate: 0, disc_bp: 0, source: 'none', level_id: levelId };
}

export interface PendingLine {
  movement_id: number;
  item_id: number;
  godown_id: number | null;
  balance: number;
  rate: number;
  discount_bp: number;
}

export interface PendingDoc {
  voucher_id: number;
  number: string;
  date: string;
  parent: string;
  tracks_stock: boolean;
  lines: PendingLine[];
}

export async function pendingDocs(db: Db, kind: 'Sales' | 'Purchase', target: 'invoice' | 'note', partyId: number, asAt: string): Promise<PendingDoc[]> {
  const order = `${kind} Order`;
  const note = kind === 'Sales' ? 'Delivery Note' : 'Receipt Note';
  const parents = target === 'invoice' ? [note, order] : [order];
  const rows = await db.select<{ id: number; voucher_id: number; number: string; date: string; parent: string; item_id: number; godown_id: number | null; qty: number; rate: number; discount_bp: number; done: number; pre: number | null }>(
    `SELECT m.id, m.voucher_id, v.number, v.date, t.parent, m.item_id, m.godown_id, m.qty, m.rate, m.discount_bp,
            COALESCE((SELECT SUM(k.qty) FROM stockx_track k WHERE k.against_id = m.id), 0) AS done, o.preclosed AS pre
     FROM stock_movements m JOIN vouchers v ON v.id = m.voucher_id JOIN voucher_types t ON t.id = v.type_id LEFT JOIN stockx_order_meta o ON o.movement_id = m.id
     WHERE v.cancelled = 0 AND v.date <= ? AND v.party_id = ? AND t.parent IN (${parents.map(() => '?').join(', ')})
     ORDER BY v.date, v.id, m.seq`,
    [asAt, partyId, ...parents]
  );
  const docs = new Map<number, PendingDoc>();
  for (const r of rows) {
    const balance = Math.abs(r.qty) - r.done;
    if (balance <= 0 || r.pre) continue;
    const d = docs.get(r.voucher_id) ?? docs.set(r.voucher_id, { voucher_id: r.voucher_id, number: r.number, date: r.date, parent: r.parent, tracks_stock: r.parent === note, lines: [] }).get(r.voucher_id)!;
    d.lines.push({ movement_id: r.id, item_id: r.item_id, godown_id: r.godown_id, balance, rate: r.rate, discount_bp: r.discount_bp });
  }
  return [...docs.values()];
}
