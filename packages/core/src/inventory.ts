import { CoreError, one, type Db } from './db.ts';
import { newGuid } from './util.ts';
import type { Books, StockLineInput, VoucherRow } from './books.ts';
import { planGstInvoice, type GstInvoicePlan } from './gst.ts';
import { STOCK_ITEM_INT, STOCK_ITEM_TEXT, STOCK_VOUCHER_TYPES } from './schema.ts';

export interface Unit {
  id: number;
  symbol: string;
  formal_name: string;
  decimals: number;
}
export interface StockGroup {
  id: number;
  name: string;
  alias: string;
  parent_id: number | null;
}
export interface StockCategory {
  id: number;
  name: string;
  parent_id: number | null;
}
export interface Godown {
  id: number;
  name: string;
  parent_id: number | null;
}
export interface StockItem {
  id: number;
  guid: string;
  name: string;
  alias: string;
  group_id: number | null;
  category_id: number | null;
  unit_id: number;
  unit: string;
  hsn_sac: string;
  rate_bp: number;
  taxability: string;
  opening_qty: number;
  opening_rate: number;
  opening_value: number;
  reorder_qty: number;
  standard_cost: number;
  standard_price: number;
  part_no: string;
  costing_method: string;
  market_method: string;
  description: string;
  notes: string;
  maintain_batches: number;
  track_expiry: number;
  min_order_qty: number;
  alt_unit_id: number;
  alt_conversion: number;
  enable_cost_tracking: number;
}

export const COSTING_METHODS = ['Avg Cost', 'FIFO', 'LIFO', 'Last Purchase Cost', 'Std Cost'] as const;
export const QTY_SCALE = 1000;

export function parseQty(text: string): number | null {
  const t = text.replace(/,/g, '').trim();
  if (!/^\d+(\.\d{1,3})?$/.test(t)) return null;
  return Math.round(parseFloat(t) * QTY_SCALE);
}

export function fmtQty(milli: number, decimals = 0, unit = ''): string {
  const v = milli / QTY_SCALE;
  const d = Math.max(decimals, Number.isInteger(v) ? 0 : 3);
  const s = new Intl.NumberFormat('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
  return unit ? `${s} ${unit}` : s;
}

export function lineAmount(qtyMilli: number, ratePaise: number, discountBp = 0): number {
  const gross = Math.round((qtyMilli * ratePaise) / QTY_SCALE);
  return gross - Math.round((gross * discountBp) / 10000);
}

const clean = (s: unknown, max = 100) => String(s ?? '').trim().slice(0, max);

async function nextId(db: Db, table: string): Promise<number> {
  return ((await one<{ m: number }>(db, `SELECT COALESCE(MAX(id), 0) AS m FROM ${table}`))!.m) + 1;
}

export async function ensureInventory(db: Db): Promise<void> {
  await db.batch([
    { sql: 'INSERT OR IGNORE INTO units (id, guid, symbol, formal_name, decimals) VALUES (1, ?, ?, ?, 0)', params: [newGuid(), 'Nos', 'Numbers'] },
    { sql: 'INSERT OR IGNORE INTO godowns (id, guid, name) VALUES (1, ?, ?)', params: [newGuid(), 'Main Location'] },
  ]);
}

const seeding = new WeakMap<Db, Promise<boolean>>();

export function ensureStockVoucherTypes(db: Db): Promise<boolean> {
  const prev = seeding.get(db) ?? Promise.resolve(false);
  const next = prev.catch(() => false).then(() => seedStockVoucherTypes(db));
  seeding.set(db, next);
  return next;
}

async function seedStockVoucherTypes(db: Db): Promise<boolean> {
  const have = new Set((await db.select<{ name: string }>('SELECT name FROM voucher_types')).map((r) => r.name.toLowerCase()));
  let id = ((await one<{ m: number }>(db, 'SELECT COALESCE(MAX(id), 0) AS m FROM voucher_types'))!.m) + 1;
  const stmts = STOCK_VOUCHER_TYPES.filter((n) => !have.has(n.toLowerCase())).map((n) => ({
    sql: 'INSERT INTO voucher_types (id, guid, name, parent, is_system) VALUES (?, ?, ?, ?, 1)',
    params: [id++, newGuid(), n, n] as (string | number)[],
  }));
  if (stmts.length) await db.batch(stmts);
  return stmts.length > 0;
}

export async function units(db: Db): Promise<Unit[]> {
  await ensureInventory(db);
  return db.select<Unit>('SELECT id, symbol, formal_name, decimals FROM units ORDER BY symbol');
}

export async function createUnit(db: Db, input: { symbol: string; formal_name?: string; decimals?: number }): Promise<Unit> {
  await ensureInventory(db);
  const symbol = clean(input.symbol, 20);
  if (!symbol) throw new CoreError('invalid', 'Unit symbol is required');
  if (await one(db, 'SELECT 1 FROM units WHERE symbol = ?', [symbol])) throw new CoreError('conflict', `Unit "${symbol}" already exists`);
  const decimals = Math.min(3, Math.max(0, input.decimals ?? 0));
  const id = await nextId(db, 'units');
  await db.batch([{ sql: 'INSERT INTO units (id, guid, symbol, formal_name, decimals) VALUES (?, ?, ?, ?, ?)', params: [id, newGuid(), symbol, clean(input.formal_name, 60), decimals] }]);
  return (await one<Unit>(db, 'SELECT id, symbol, formal_name, decimals FROM units WHERE id = ?', [id]))!;
}

export async function stockGroups(db: Db): Promise<StockGroup[]> {
  return db.select<StockGroup>('SELECT id, name, alias, parent_id FROM stock_groups ORDER BY name');
}

export async function createStockGroup(db: Db, input: { name: string; alias?: string; parent_id?: number | null }): Promise<StockGroup> {
  const name = clean(input.name);
  if (!name) throw new CoreError('invalid', 'Name is required');
  if (await one(db, 'SELECT 1 FROM stock_groups WHERE name = ?', [name])) throw new CoreError('conflict', `"${name}" already exists`);
  const id = await nextId(db, 'stock_groups');
  await db.batch([{ sql: 'INSERT INTO stock_groups (id, guid, name, alias, parent_id) VALUES (?, ?, ?, ?, ?)', params: [id, newGuid(), name, clean(input.alias), input.parent_id ?? null] }]);
  return (await one<StockGroup>(db, 'SELECT id, name, alias, parent_id FROM stock_groups WHERE id = ?', [id]))!;
}

export async function stockCategories(db: Db): Promise<StockCategory[]> {
  return db.select<StockCategory>('SELECT id, name, parent_id FROM stock_categories ORDER BY name');
}

export async function createStockCategory(db: Db, input: { name: string; parent_id?: number | null }): Promise<StockCategory> {
  const name = clean(input.name);
  if (!name) throw new CoreError('invalid', 'Name is required');
  if (await one(db, 'SELECT 1 FROM stock_categories WHERE name = ?', [name])) throw new CoreError('conflict', `"${name}" already exists`);
  const id = await nextId(db, 'stock_categories');
  await db.batch([{ sql: 'INSERT INTO stock_categories (id, guid, name, parent_id) VALUES (?, ?, ?, ?)', params: [id, newGuid(), name, input.parent_id ?? null] }]);
  return (await one<StockCategory>(db, 'SELECT id, name, parent_id FROM stock_categories WHERE id = ?', [id]))!;
}

export async function godowns(db: Db): Promise<Godown[]> {
  await ensureInventory(db);
  return db.select<Godown>('SELECT id, name, parent_id FROM godowns ORDER BY id');
}

export async function createGodown(db: Db, input: { name: string; parent_id?: number | null }): Promise<Godown> {
  await ensureInventory(db);
  const name = clean(input.name);
  if (!name) throw new CoreError('invalid', 'Name is required');
  if (await one(db, 'SELECT 1 FROM godowns WHERE name = ?', [name])) throw new CoreError('conflict', `"${name}" already exists`);
  const id = await nextId(db, 'godowns');
  await db.batch([{ sql: 'INSERT INTO godowns (id, guid, name, parent_id) VALUES (?, ?, ?, ?)', params: [id, newGuid(), name, input.parent_id ?? null] }]);
  return (await one<Godown>(db, 'SELECT id, name, parent_id FROM godowns WHERE id = ?', [id]))!;
}

const ITEM_SELECT = `SELECT i.*, u.symbol AS unit FROM stock_items i JOIN units u ON u.id = i.unit_id`;

export async function stockItems(db: Db): Promise<StockItem[]> {
  await ensureInventory(db);
  return db.select<StockItem>(`${ITEM_SELECT} ORDER BY i.name`);
}

export async function stockItem(db: Db, id: number): Promise<StockItem | null> {
  return (await one<StockItem>(db, `${ITEM_SELECT} WHERE i.id = ?`, [id])) ?? null;
}

export type StockItemInput = Partial<Omit<StockItem, 'id' | 'guid' | 'unit'>> & { name: string };

function itemValues(input: StockItemInput, unitId: number) {
  const qty = input.opening_qty ?? 0;
  const rate = input.opening_rate ?? 0;
  const value = input.opening_value ?? lineAmount(qty, rate);
  if (qty < 0 || rate < 0 || value < 0) throw new CoreError('invalid', 'Opening balance cannot be negative');
  return {
    name: clean(input.name),
    alias: clean(input.alias),
    group_id: input.group_id ?? null,
    category_id: input.category_id ?? null,
    unit_id: unitId,
    hsn_sac: clean(input.hsn_sac, 10),
    rate_bp: input.rate_bp ?? 0,
    taxability: clean(input.taxability) || 'Taxable',
    opening_qty: qty,
    opening_rate: qty ? Math.round((value * QTY_SCALE) / qty) : rate,
    opening_value: value,
    reorder_qty: input.reorder_qty ?? 0,
    standard_cost: input.standard_cost ?? 0,
    standard_price: input.standard_price ?? 0,
    text: STOCK_ITEM_TEXT.map((f) => clean((input as Record<string, unknown>)[f], f === 'description' || f === 'notes' ? 300 : 60) || (f === 'costing_method' ? 'Avg Cost' : '')),
    ints: STOCK_ITEM_INT.map((f) => Math.max(0, Math.trunc(Number((input as Record<string, unknown>)[f]) || 0))),
  };
}

export async function createStockItem(db: Db, input: StockItemInput): Promise<StockItem> {
  await ensureInventory(db);
  const name = clean(input.name);
  if (!name) throw new CoreError('invalid', 'Stock item name is required');
  if (await one(db, 'SELECT 1 FROM stock_items WHERE name = ?', [name])) throw new CoreError('conflict', `"${name}" already exists`);
  const v = itemValues(input, input.unit_id ?? 1);
  const id = await nextId(db, 'stock_items');
  await db.batch([
    {
      sql: `INSERT INTO stock_items (id, guid, name, alias, group_id, category_id, unit_id, hsn_sac, rate_bp, taxability, opening_qty, opening_rate, opening_value, reorder_qty, standard_cost, standard_price, ${[...STOCK_ITEM_TEXT, ...STOCK_ITEM_INT].join(', ')})
            VALUES (${Array(16 + STOCK_ITEM_TEXT.length + STOCK_ITEM_INT.length).fill('?').join(', ')})`,
      params: [id, newGuid(), v.name, v.alias, v.group_id, v.category_id, v.unit_id, v.hsn_sac, v.rate_bp, v.taxability, v.opening_qty, v.opening_rate, v.opening_value, v.reorder_qty, v.standard_cost, v.standard_price, ...v.text, ...v.ints],
    },
  ]);
  return (await stockItem(db, id))!;
}

export async function updateStockItem(db: Db, id: number, input: StockItemInput): Promise<StockItem> {
  const cur = await stockItem(db, id);
  if (!cur) throw new CoreError('not_found', 'Stock item not found');
  const name = clean(input.name);
  if (!name) throw new CoreError('invalid', 'Stock item name is required');
  if (await one(db, 'SELECT 1 FROM stock_items WHERE name = ? AND id != ?', [name, id])) throw new CoreError('conflict', `"${name}" already exists`);
  const v = itemValues({ ...cur, ...input }, input.unit_id ?? cur.unit_id);
  await db.batch([
    {
      sql: `UPDATE stock_items SET name = ?, alias = ?, group_id = ?, category_id = ?, unit_id = ?, hsn_sac = ?, rate_bp = ?, taxability = ?, opening_qty = ?, opening_rate = ?, opening_value = ?, reorder_qty = ?, standard_cost = ?, standard_price = ?, ${[...STOCK_ITEM_TEXT, ...STOCK_ITEM_INT].map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
      params: [v.name, v.alias, v.group_id, v.category_id, v.unit_id, v.hsn_sac, v.rate_bp, v.taxability, v.opening_qty, v.opening_rate, v.opening_value, v.reorder_qty, v.standard_cost, v.standard_price, ...v.text, ...v.ints, id],
    },
  ]);
  return (await stockItem(db, id))!;
}

export async function deleteStockItem(db: Db, id: number): Promise<void> {
  if (await one(db, 'SELECT 1 FROM stock_movements WHERE item_id = ?', [id])) throw new CoreError('conflict', 'This stock item has transactions and cannot be deleted');
  await db.batch([{ sql: 'DELETE FROM stock_items WHERE id = ?', params: [id] }]);
}

export type InvoiceKind = 'Sales' | 'Purchase' | 'Credit Note' | 'Debit Note';

export interface ItemLine {
  item_id: number;
  godown_id?: number | null;
  ledger_id: number;
  qty: number;
  rate: number;
  discount_bp?: number;
  rate_bp?: number;
  tracked?: boolean;
}

export interface ItemInvoicePlan extends GstInvoicePlan {
  stock: StockLineInput[];
}

export const isOutward = (kind: InvoiceKind) => kind === 'Sales' || kind === 'Debit Note';

export async function planItemInvoice(
  books: Books,
  kind: InvoiceKind,
  partyId: number,
  lines: ItemLine[],
  opts: { placeOfSupply?: string } = {}
): Promise<ItemInvoicePlan> {
  if (!lines.length) throw new CoreError('invalid', 'Add at least one item');
  const out = isOutward(kind);
  const supply = [];
  const stock: StockLineInput[] = [];
  for (const l of lines) {
    const item = await stockItem(books.db, l.item_id);
    if (!item) throw new CoreError('not_found', 'Stock item not found');
    if (!(l.qty > 0)) throw new CoreError('invalid', `Quantity for ${item.name} must be positive`);
    if (!(l.rate >= 0)) throw new CoreError('invalid', `Rate for ${item.name} cannot be negative`);
    const amount = lineAmount(l.qty, l.rate, l.discount_bp ?? 0);
    if (amount <= 0) throw new CoreError('invalid', `Amount for ${item.name} must be positive`);
    supply.push({ ledger_id: l.ledger_id, taxable: amount, rate_bp: l.rate_bp ?? item.rate_bp });
    stock.push({ item_id: l.item_id, godown_id: l.godown_id ?? 1, ledger_id: l.ledger_id, qty: out ? -l.qty : l.qty, rate: l.rate, amount, discount_bp: l.discount_bp ?? 0, tracked: l.tracked ? 1 : 0 });
  }
  const plan = await planGstInvoice(books, kind, partyId, supply, opts);
  return { ...plan, stock };
}

export interface StockRow {
  item_id: number;
  name: string;
  unit: string;
  group_id: number | null;
  opening_qty: number;
  opening_value: number;
  in_qty: number;
  in_value: number;
  out_qty: number;
  out_value: number;
  closing_qty: number;
  closing_value: number;
  closing_rate: number;
}

interface Move {
  item_id: number;
  date: string;
  qty: number;
  amount: number;
  parent: string;
}

export async function stockSummary(db: Db, from: string, to: string): Promise<{ rows: StockRow[]; closing_value: number; opening_value: number }> {
  const items = await stockItems(db);
  const moves = await db.select<Move>(
    `SELECT m.item_id, v.date, m.qty, m.amount, t.parent FROM stock_movements m JOIN vouchers v ON v.id = m.voucher_id JOIN voucher_types t ON t.id = v.type_id
     WHERE v.cancelled = 0 AND m.tracked = 0 AND v.date <= ? AND t.parent NOT IN ('Sales Order', 'Purchase Order') ORDER BY v.date, v.id, m.seq`,
    [to]
  );
  const byItem = new Map<number, Move[]>();
  for (const m of moves) (byItem.get(m.item_id) ?? byItem.set(m.item_id, []).get(m.item_id)!).push(m);

  const rows: StockRow[] = items.map((it) => {
    const method = it.costing_method || 'Avg Cost';
    const layers: { qty: number; value: number }[] = it.opening_qty ? [{ qty: it.opening_qty, value: it.opening_value }] : [];
    let lastRate = it.opening_qty ? it.opening_value / it.opening_qty : 0;
    const stdRate = it.standard_cost / QTY_SCALE;
    const totalQty = () => layers.reduce((s, l) => s + l.qty, 0);
    const totalVal = () =>
      method === 'Last Purchase Cost' ? Math.round(totalQty() * lastRate) : method === 'Std Cost' ? Math.round(totalQty() * stdRate) : layers.reduce((s, l) => s + l.value, 0);
    const inward = (q: number, amt: number) => {
      layers.push({ qty: q, value: amt });
      if (q > 0 && amt > 0) lastRate = amt / q;
    };
    const outward = (q: number): number => {
      let left = q;
      let cost = 0;
      if (method === 'Avg Cost') {
        const tq = totalQty();
        const tv = totalVal();
        cost = tq > 0 ? Math.round((tv * Math.min(q, tq)) / tq) : 0;
        layers.length = 0;
        layers.push({ qty: tq - q, value: tv - cost });
        return cost + (q > tq ? Math.round((q - Math.max(tq, 0)) * lastRate) : 0);
      }
      const order = method === 'LIFO' ? [...layers.keys()].reverse() : [...layers.keys()];
      for (const i of order) {
        if (left <= 0) break;
        const l = layers[i];
        if (l.qty <= 0) continue;
        const use = Math.min(left, l.qty);
        const part = Math.round((l.value * use) / l.qty);
        l.value -= part;
        l.qty -= use;
        cost += part;
        left -= use;
      }
      if (method === 'Last Purchase Cost') cost = Math.round(q * lastRate);
      else if (method === 'Std Cost') cost = Math.round(q * stdRate);
      else if (left > 0) {
        cost += Math.round(left * lastRate);
        layers.push({ qty: -left, value: -Math.round(left * lastRate) });
      }
      if (left > 0 && (method === 'Last Purchase Cost' || method === 'Std Cost')) layers.push({ qty: -left, value: 0 });
      return cost;
    };
    let oq = 0;
    let ov = 0;
    let opened = false;
    const r = { in_qty: 0, in_value: 0, out_qty: 0, out_value: 0 };
    const snap = () => {
      if (!opened) {
        oq = totalQty();
        ov = totalVal();
        opened = true;
      }
    };
    for (const raw of byItem.get(it.id) ?? []) {
      if (raw.date >= from) snap();
      let q = raw.qty;
      let amt = raw.amount;
      if (raw.parent === 'Physical Stock') {
        const have = totalQty();
        q = raw.qty - have;
        amt = q > 0 ? Math.round(q * (have > 0 ? totalVal() / have : lastRate)) : 0;
        if (q === 0) continue;
      }
      if (q > 0) {
        inward(q, amt);
        if (raw.date >= from) {
          r.in_qty += q;
          r.in_value += amt;
        }
      } else {
        const cost = outward(-q);
        if (raw.date >= from) {
          r.out_qty += -q;
          r.out_value += cost;
        }
      }
    }
    snap();
    const cq = totalQty();
    const cv = totalVal();
    return {
      item_id: it.id,
      name: it.name,
      unit: it.unit,
      group_id: it.group_id,
      opening_qty: oq,
      opening_value: ov,
      ...r,
      closing_qty: cq,
      closing_value: cv,
      closing_rate: cq ? Math.round((cv * QTY_SCALE) / cq) : 0,
    };
  });
  return {
    rows,
    closing_value: rows.reduce((s, r) => s + r.closing_value, 0),
    opening_value: rows.reduce((s, r) => s + r.opening_value, 0),
  };
}

export interface StockMovementRow {
  voucher_id: number;
  date: string;
  type: string;
  number: string;
  party: string;
  qty: number;
  rate: number;
  amount: number;
}

export async function stockItemVouchers(db: Db, itemId: number, from: string, to: string): Promise<{ opening_qty: number; rows: StockMovementRow[]; closing_qty: number }> {
  const it = await stockItem(db, itemId);
  if (!it) throw new CoreError('not_found', 'Stock item not found');
  const all = await db.select<StockMovementRow & { parent: string }>(
    `SELECT v.id AS voucher_id, v.date, t.name AS type, t.parent AS parent, v.number, COALESCE(p.name, '') AS party, m.qty, m.rate, m.amount
     FROM stock_movements m JOIN vouchers v ON v.id = m.voucher_id JOIN voucher_types t ON t.id = v.type_id LEFT JOIN ledgers p ON p.id = v.party_id
     WHERE m.item_id = ? AND v.cancelled = 0 AND m.tracked = 0 AND v.date <= ? AND t.parent NOT IN ('Sales Order', 'Purchase Order') ORDER BY v.date, v.id, m.seq`,
    [itemId, to]
  );
  let running = it.opening_qty;
  let opening = it.opening_qty;
  const rows: StockMovementRow[] = [];
  for (const r of all) {
    const delta = r.parent === 'Physical Stock' ? r.qty - running : r.qty;
    if (r.date < from) opening = running + delta;
    else rows.push({ ...r, qty: delta });
    running += delta;
  }
  return { opening_qty: opening, rows, closing_qty: running };
}

export async function createItemInvoice(
  books: Books,
  input: { kind: InvoiceKind; type_id: number; date: string; party_id: number; lines: ItemLine[]; reference?: string; narration?: string; place_of_supply?: string; number?: string }
): Promise<VoucherRow> {
  const plan = await planItemInvoice(books, input.kind, input.party_id, input.lines, { placeOfSupply: input.place_of_supply });
  return books.createVoucher({
    type_id: input.type_id,
    number: input.number,
    date: input.date,
    reference: input.reference,
    narration: input.narration,
    party_id: input.party_id,
    place_of_supply: plan.place_of_supply,
    entries: plan.entries,
    stock: plan.stock,
  });
}
