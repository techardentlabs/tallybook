import { CoreError, one, type Db, type Stmt } from './db.ts';
import { newGuid } from './util.ts';
import type { Books, VoucherRow } from './books.ts';
import { QTY_SCALE, ensureStockVoucherTypes, godowns, stockGroups, stockItem, stockItems, type StockItem } from './inventory.ts';
import { godownSummary } from './stockx.ts';

export const MFG_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS mfg_boms (
    id INTEGER PRIMARY KEY,
    guid TEXT NOT NULL UNIQUE,
    item_id INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
    name TEXT NOT NULL COLLATE NOCASE,
    unit_qty INTEGER NOT NULL,
    UNIQUE (item_id, name)
  )`,
  `CREATE TABLE IF NOT EXISTS mfg_bom_lines (
    id INTEGER PRIMARY KEY,
    bom_id INTEGER NOT NULL REFERENCES mfg_boms(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    item_id INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
    godown_id INTEGER,
    kind TEXT NOT NULL CHECK (kind IN ('Component','Co-Product','By-Product','Scrap')),
    qty INTEGER NOT NULL,
    pct_bp INTEGER NOT NULL DEFAULT 0
  )`,
  'CREATE INDEX IF NOT EXISTS idx_mfg_bom_lines_bom ON mfg_bom_lines(bom_id)',
  `CREATE TABLE IF NOT EXISTS mfg_voucher_types (
    type_id INTEGER PRIMARY KEY REFERENCES voucher_types(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS mfg_journals (
    voucher_id INTEGER PRIMARY KEY REFERENCES vouchers(id) ON DELETE CASCADE,
    voucher_guid TEXT NOT NULL DEFAULT '',
    item_id INTEGER NOT NULL REFERENCES stock_items(id),
    bom_id INTEGER,
    godown_id INTEGER,
    qty INTEGER NOT NULL,
    components_cost INTEGER NOT NULL DEFAULT 0,
    addl_cost INTEGER NOT NULL DEFAULT 0,
    byproduct_cost INTEGER NOT NULL DEFAULT 0,
    primary_cost INTEGER NOT NULL DEFAULT 0
  )`,
  'CREATE INDEX IF NOT EXISTS idx_mfg_journals_item ON mfg_journals(item_id)',
  `CREATE TABLE IF NOT EXISTS mfg_journal_lines (
    voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('Primary','Component','Co-Product','By-Product','Scrap')),
    pct_bp INTEGER NOT NULL DEFAULT 0,
    rate_fixed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (voucher_id, seq)
  )`,
  `CREATE TABLE IF NOT EXISTS mfg_addl_costs (
    id INTEGER PRIMARY KEY,
    voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    ledger_id INTEGER NOT NULL REFERENCES ledgers(id),
    pct_bp INTEGER NOT NULL DEFAULT 0,
    amount INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_mfg_addl_voucher ON mfg_addl_costs(voucher_id)',
];

export const MFG_VOUCHER_TYPE = 'Manufacturing Journal';
export const BOM_ITEM_TYPES = ['Component', 'Co-Product', 'By-Product', 'Scrap'] as const;
export type BomItemType = (typeof BOM_ITEM_TYPES)[number];
export type ByProductType = Exclude<BomItemType, 'Component'>;

const LIVE = 'mfg_journals j JOIN vouchers lv ON lv.id = j.voucher_id AND lv.guid = j.voucher_guid';
const clean = (s: unknown, max = 100) => String(s ?? '').trim().slice(0, max);

async function nextId(db: Db, table: string): Promise<number> {
  return ((await one<{ m: number }>(db, `SELECT COALESCE(MAX(id), 0) AS m FROM ${table}`))!.m) + 1;
}

export async function ensureMfg(db: Db): Promise<void> {
  await db.batch([
    ...MFG_SCHEMA.map((sql) => ({ sql })),
    { sql: `DELETE FROM mfg_journals WHERE NOT EXISTS (SELECT 1 FROM vouchers v WHERE v.id = mfg_journals.voucher_id AND v.guid = mfg_journals.voucher_guid)` },
    { sql: 'DELETE FROM mfg_journal_lines WHERE voucher_id NOT IN (SELECT voucher_id FROM mfg_journals)' },
    { sql: 'DELETE FROM mfg_addl_costs WHERE voucher_id NOT IN (SELECT voucher_id FROM mfg_journals)' },
  ]);
  if (!(await one(db, 'SELECT 1 FROM company WHERE id = 1'))) return;
  await ensureStockVoucherTypes(db);
  const t = await one<{ id: number }>(db, 'SELECT id FROM voucher_types WHERE name = ? COLLATE NOCASE', [MFG_VOUCHER_TYPE]);
  if (!t) {
    const id = await nextId(db, 'voucher_types');
    await db.batch([
      { sql: 'INSERT INTO voucher_types (id, guid, name, parent, abbrev, is_system) VALUES (?, ?, ?, ?, ?, 0)', params: [id, newGuid(), MFG_VOUCHER_TYPE, 'Stock Journal', 'Mfg Jrnl'] },
      { sql: 'INSERT OR IGNORE INTO mfg_voucher_types (type_id) VALUES (?)', params: [id] },
    ]);
  }
}

export async function mfgVoucherTypeId(db: Db): Promise<number> {
  await ensureMfg(db);
  const t = await one<{ id: number }>(db, 'SELECT id FROM voucher_types WHERE name = ? COLLATE NOCASE', [MFG_VOUCHER_TYPE]);
  if (!t) throw new CoreError('not_found', 'Create the company before recording a Manufacturing Journal');
  return t.id;
}

export async function mfgVoucherTypes(db: Db): Promise<{ id: number; name: string }[]> {
  return db.select<{ id: number; name: string }>(
    `SELECT t.id, t.name FROM voucher_types t JOIN mfg_voucher_types m ON m.type_id = t.id WHERE t.parent = 'Stock Journal' AND t.is_active = 1 ORDER BY t.id`
  );
}

export async function isMfgVoucherType(db: Db, typeId: number): Promise<boolean> {
  return !!(await one(db, 'SELECT 1 FROM mfg_voucher_types WHERE type_id = ?', [typeId]));
}

export async function setUseAsMfgJournal(db: Db, typeId: number, on: boolean): Promise<void> {
  const t = await one<{ parent: string }>(db, 'SELECT parent FROM voucher_types WHERE id = ?', [typeId]);
  if (!t) throw new CoreError('not_found', 'Voucher type not found');
  if (t.parent !== 'Stock Journal') throw new CoreError('invalid', 'Only Stock Journal voucher types can be used as a Manufacturing Journal');
  await db.batch([on ? { sql: 'INSERT OR IGNORE INTO mfg_voucher_types (type_id) VALUES (?)', params: [typeId] } : { sql: 'DELETE FROM mfg_voucher_types WHERE type_id = ?', params: [typeId] }]);
}

export async function isMfgJournal(db: Db, voucherId: number): Promise<boolean> {
  return !!(await one(db, `SELECT 1 FROM ${LIVE} WHERE j.voucher_id = ?`, [voucherId]));
}

export interface BomLine {
  id: number;
  seq: number;
  item_id: number;
  item: string;
  unit: string;
  godown_id: number | null;
  godown: string;
  kind: BomItemType;
  qty: number;
  pct_bp: number;
}

export interface Bom {
  id: number;
  item_id: number;
  item: string;
  unit: string;
  name: string;
  unit_qty: number;
  lines: BomLine[];
}

export interface BomLineInput {
  item_id: number;
  godown_id?: number | null;
  kind?: BomItemType;
  qty: number;
  pct_bp?: number;
}

export interface BomInput {
  name: string;
  unit_qty: number;
  lines: BomLineInput[];
}

const BOM_LINE_SELECT = `SELECT l.id, l.seq, l.item_id, i.name AS item, u.symbol AS unit, l.godown_id, COALESCE(g.name, '') AS godown, l.kind, l.qty, l.pct_bp
  FROM mfg_bom_lines l JOIN stock_items i ON i.id = l.item_id JOIN units u ON u.id = i.unit_id LEFT JOIN godowns g ON g.id = l.godown_id`;

async function loadBoms(db: Db, where: string, params: (string | number)[]): Promise<Bom[]> {
  const heads = await db.select<Omit<Bom, 'lines'>>(
    `SELECT b.id, b.item_id, i.name AS item, u.symbol AS unit, b.name, b.unit_qty FROM mfg_boms b JOIN stock_items i ON i.id = b.item_id JOIN units u ON u.id = i.unit_id WHERE ${where} ORDER BY b.item_id, b.id`,
    params
  );
  if (!heads.length) return [];
  const lines = await db.select<BomLine & { bom_id: number }>(`${BOM_LINE_SELECT.replace('SELECT l.id', 'SELECT l.bom_id, l.id')} WHERE l.bom_id IN (${heads.map(() => '?').join(', ')}) ORDER BY l.bom_id, l.seq`, heads.map((h) => h.id));
  return heads.map((h) => ({ ...h, lines: lines.filter((l) => l.bom_id === h.id).map(({ bom_id: _b, ...l }) => l) }));
}

export async function boms(db: Db, itemId: number): Promise<Bom[]> {
  return loadBoms(db, 'b.item_id = ?', [itemId]);
}

export async function allBoms(db: Db): Promise<Bom[]> {
  return loadBoms(db, '1 = 1', []);
}

export async function bom(db: Db, id: number): Promise<Bom | null> {
  return (await loadBoms(db, 'b.id = ?', [id]))[0] ?? null;
}

export async function itemsWithBom(db: Db): Promise<{ item_id: number; name: string; unit: string; boms: number }[]> {
  return db.select(
    `SELECT i.id AS item_id, i.name, u.symbol AS unit, COUNT(b.id) AS boms FROM stock_items i JOIN units u ON u.id = i.unit_id JOIN mfg_boms b ON b.item_id = i.id GROUP BY i.id ORDER BY i.name`
  );
}

async function bomStmts(db: Db, bomId: number, itemId: number, input: BomInput): Promise<Stmt[]> {
  if (!Number.isInteger(input.unit_qty) || input.unit_qty <= 0) throw new CoreError('invalid', 'Unit of manufacture must be more than zero');
  const lines = input.lines.filter((l) => l.item_id);
  if (!lines.some((l) => (l.kind ?? 'Component') === 'Component')) throw new CoreError('invalid', 'Add at least one component');
  const houses = new Set((await godowns(db)).map((g) => g.id));
  let pct = 0;
  let next = await nextId(db, 'mfg_bom_lines');
  const out: Stmt[] = [];
  for (const [i, l] of lines.entries()) {
    const it = await stockItem(db, l.item_id);
    if (!it) throw new CoreError('invalid', 'Unknown stock item in the bill of materials');
    if (l.item_id === itemId) throw new CoreError('invalid', `${it.name} cannot be a component of itself`);
    const kind = l.kind ?? 'Component';
    if (!BOM_ITEM_TYPES.includes(kind)) throw new CoreError('invalid', `Unknown type of item "${kind}"`);
    if (!Number.isInteger(l.qty) || l.qty <= 0) throw new CoreError('invalid', `Quantity for ${it.name} must be more than zero`);
    if (l.godown_id != null && !houses.has(l.godown_id)) throw new CoreError('invalid', 'Unknown godown in the bill of materials');
    const bp = kind === 'Component' ? 0 : Math.max(0, Math.trunc(l.pct_bp ?? 0));
    pct += bp;
    out.push({
      sql: 'INSERT INTO mfg_bom_lines (id, bom_id, seq, item_id, godown_id, kind, qty, pct_bp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      params: [next++, bomId, i, l.item_id, l.godown_id ?? null, kind, l.qty, bp],
    });
  }
  if (pct > 10000) throw new CoreError('invalid', 'Cost allocation to co-products, by-products and scrap cannot exceed 100%');
  return out;
}

export async function createBom(db: Db, itemId: number, input: BomInput): Promise<Bom> {
  await ensureMfg(db);
  if (!(await stockItem(db, itemId))) throw new CoreError('not_found', 'Stock item not found');
  const name = clean(input.name);
  if (!name) throw new CoreError('invalid', 'Name of BOM is required');
  if (await one(db, 'SELECT 1 FROM mfg_boms WHERE item_id = ? AND name = ? COLLATE NOCASE', [itemId, name])) throw new CoreError('conflict', `BOM "${name}" already exists for this item`);
  const id = await nextId(db, 'mfg_boms');
  const lines = await bomStmts(db, id, itemId, input);
  await db.batch([{ sql: 'INSERT INTO mfg_boms (id, guid, item_id, name, unit_qty) VALUES (?, ?, ?, ?, ?)', params: [id, newGuid(), itemId, name, input.unit_qty] }, ...lines]);
  return (await bom(db, id))!;
}

export async function updateBom(db: Db, id: number, input: BomInput): Promise<Bom> {
  const cur = await bom(db, id);
  if (!cur) throw new CoreError('not_found', 'Bill of materials not found');
  const name = clean(input.name);
  if (!name) throw new CoreError('invalid', 'Name of BOM is required');
  if (await one(db, 'SELECT 1 FROM mfg_boms WHERE item_id = ? AND name = ? COLLATE NOCASE AND id != ?', [cur.item_id, name, id])) throw new CoreError('conflict', `BOM "${name}" already exists for this item`);
  const lines = await bomStmts(db, id, cur.item_id, input);
  await db.batch([
    { sql: 'UPDATE mfg_boms SET name = ?, unit_qty = ? WHERE id = ?', params: [name, input.unit_qty, id] },
    { sql: 'DELETE FROM mfg_bom_lines WHERE bom_id = ?', params: [id] },
    ...lines,
  ]);
  return (await bom(db, id))!;
}

export async function deleteBom(db: Db, id: number): Promise<void> {
  if (!(await one(db, 'SELECT 1 FROM mfg_boms WHERE id = ?', [id]))) throw new CoreError('not_found', 'Bill of materials not found');
  await db.batch([
    { sql: 'UPDATE mfg_journals SET bom_id = NULL WHERE bom_id = ?', params: [id] },
    { sql: 'DELETE FROM mfg_bom_lines WHERE bom_id = ?', params: [id] },
    { sql: 'DELETE FROM mfg_boms WHERE id = ?', params: [id] },
  ]);
}

export function copyBomLines(src: Bom): BomLineInput[] {
  return src.lines.map((l) => ({ item_id: l.item_id, godown_id: l.godown_id, kind: l.kind, qty: l.qty, pct_bp: l.pct_bp }));
}

export interface ExplodedLine {
  item_id: number;
  item: string;
  unit: string;
  godown_id: number | null;
  kind: BomItemType;
  qty: number;
  pct_bp: number;
}

export function scaleQty(lineQty: number, qty: number, unitQty: number): number {
  return Math.round((lineQty * qty) / unitQty);
}

export async function explodeBom(db: Db, bomId: number, qty: number): Promise<{ components: ExplodedLine[]; byproducts: ExplodedLine[] }> {
  const b = await bom(db, bomId);
  if (!b) throw new CoreError('not_found', 'Bill of materials not found');
  const lines = b.lines.map((l) => ({ item_id: l.item_id, item: l.item, unit: l.unit, godown_id: l.godown_id, kind: l.kind, qty: scaleQty(l.qty, qty, b.unit_qty), pct_bp: l.pct_bp }));
  return { components: lines.filter((l) => l.kind === 'Component'), byproducts: lines.filter((l) => l.kind !== 'Component') };
}

class Pool {
  readonly method: string;
  layers: { qty: number; value: number }[];
  lastRate: number;
  readonly stdRate: number;

  constructor(it: Pick<StockItem, 'costing_method' | 'opening_qty' | 'opening_value' | 'standard_cost'>) {
    this.method = it.costing_method || 'Avg Cost';
    this.layers = it.opening_qty ? [{ qty: it.opening_qty, value: it.opening_value }] : [];
    this.lastRate = it.opening_qty ? it.opening_value / it.opening_qty : 0;
    this.stdRate = it.standard_cost / QTY_SCALE;
  }

  clone(): Pool {
    const p = Object.create(Pool.prototype) as Pool;
    Object.assign(p, this, { layers: this.layers.map((l) => ({ ...l })) });
    return p;
  }

  qty(): number {
    return this.layers.reduce((s, l) => s + l.qty, 0);
  }

  value(): number {
    const m = this.method;
    if (m === 'Last Purchase Cost') return Math.round(this.qty() * this.lastRate);
    if (m === 'Std Cost') return Math.round(this.qty() * this.stdRate);
    return this.layers.reduce((s, l) => s + l.value, 0);
  }

  inward(q: number, amt: number): void {
    this.layers.push({ qty: q, value: amt });
    if (q > 0 && amt > 0) this.lastRate = amt / q;
  }

  outward(q: number): number {
    const m = this.method;
    if (m === 'Avg Cost') {
      const tq = this.qty();
      const tv = this.value();
      const cost = tq > 0 ? Math.round((tv * Math.min(q, tq)) / tq) : 0;
      this.layers = [{ qty: tq - q, value: tv - cost }];
      return cost + (q > tq ? Math.round((q - Math.max(tq, 0)) * this.lastRate) : 0);
    }
    let left = q;
    let cost = 0;
    const order = m === 'LIFO' ? [...this.layers.keys()].reverse() : [...this.layers.keys()];
    for (const i of order) {
      if (left <= 0) break;
      const l = this.layers[i];
      if (l.qty <= 0) continue;
      const use = Math.min(left, l.qty);
      const part = Math.round((l.value * use) / l.qty);
      l.value -= part;
      l.qty -= use;
      cost += part;
      left -= use;
    }
    if (m === 'Last Purchase Cost') cost = Math.round(q * this.lastRate);
    else if (m === 'Std Cost') cost = Math.round(q * this.stdRate);
    else if (left > 0) {
      cost += Math.round(left * this.lastRate);
      this.layers.push({ qty: -left, value: -Math.round(left * this.lastRate) });
    }
    if (left > 0 && (m === 'Last Purchase Cost' || m === 'Std Cost')) this.layers.push({ qty: -left, value: 0 });
    return cost;
  }

  apply(qty: number, amount: number, parent: string): void {
    let q = qty;
    let amt = amount;
    if (parent === 'Physical Stock') {
      const have = this.qty();
      q = qty - have;
      amt = q > 0 ? Math.round(q * (have > 0 ? this.value() / have : this.lastRate)) : 0;
      if (q === 0) return;
    }
    if (q > 0) this.inward(q, amt);
    else this.outward(-q);
  }
}

async function replay(db: Db, date: string, exceptVoucher?: number): Promise<{ pools: Map<number, Pool>; items: Map<number, StockItem> }> {
  const list = await stockItems(db);
  const items = new Map(list.map((i) => [i.id, i]));
  const pools = new Map(list.map((i) => [i.id, new Pool(i)]));
  const cut = exceptVoucher ?? Number.MAX_SAFE_INTEGER;
  const moves = await db.select<{ item_id: number; qty: number; amount: number; parent: string }>(
    `SELECT m.item_id, m.qty, m.amount, t.parent FROM stock_movements m JOIN vouchers v ON v.id = m.voucher_id JOIN voucher_types t ON t.id = v.type_id
     WHERE v.cancelled = 0 AND m.tracked = 0 AND t.parent NOT IN ('Sales Order', 'Purchase Order') AND v.id != ? AND (v.date < ? OR (v.date = ? AND v.id < ?))
     ORDER BY v.date, v.id, m.seq`,
    [cut, date, date, cut]
  );
  for (const m of moves) pools.get(m.item_id)?.apply(m.qty, m.amount, m.parent);
  return { pools, items };
}

export async function issueCost(db: Db, itemId: number, qty: number, date: string): Promise<{ amount: number; rate: number }> {
  const { pools } = await replay(db, date);
  const p = pools.get(itemId);
  if (!p) throw new CoreError('not_found', 'Stock item not found');
  const amount = p.clone().outward(qty);
  return { amount, rate: qty ? Math.round((amount * QTY_SCALE) / qty) : 0 };
}

export interface MfgLineInput {
  item_id: number;
  godown_id?: number | null;
  qty: number;
  rate?: number | null;
}

export interface MfgByLineInput extends MfgLineInput {
  kind: ByProductType;
  pct_bp?: number;
}

export interface MfgAddlInput {
  ledger_id: number;
  pct_bp?: number;
  amount?: number;
}

export interface MfgJournalInput {
  type_id?: number;
  number?: string;
  date: string;
  reference?: string;
  narration?: string;
  item_id: number;
  bom_id?: number | null;
  godown_id?: number | null;
  qty: number;
  components?: MfgLineInput[];
  byproducts?: MfgByLineInput[];
  addl?: MfgAddlInput[];
}

export interface MfgPlanLine {
  item_id: number;
  item: string;
  unit: string;
  godown_id: number | null;
  qty: number;
  rate: number;
  amount: number;
  rate_fixed: boolean;
}

export interface MfgPlanByLine extends MfgPlanLine {
  kind: ByProductType;
  pct_bp: number;
}

export interface MfgPlanAddl {
  ledger_id: number;
  ledger: string;
  pct_bp: number;
  amount: number;
}

export interface MfgPlan {
  item_id: number;
  item: string;
  unit: string;
  bom_id: number | null;
  bom: string;
  godown_id: number | null;
  qty: number;
  components: MfgPlanLine[];
  byproducts: MfgPlanByLine[];
  addl: MfgPlanAddl[];
  components_cost: number;
  components_qty: number | null;
  addl_cost: number;
  effective_cost: number;
  byproduct_cost: number;
  primary_cost: number;
  primary_pct_bp: number;
  primary_rate: number;
}

const unitRate = (amount: number, qty: number) => (qty ? Math.round((amount * QTY_SCALE) / qty) : 0);

export async function planMfgJournal(db: Db, input: MfgJournalInput, opts: { voucherId?: number } = {}): Promise<MfgPlan> {
  const main = await stockItem(db, input.item_id);
  if (!main) throw new CoreError('invalid', 'Select the name of product');
  if (!Number.isInteger(input.qty) || input.qty <= 0) throw new CoreError('invalid', 'Quantity of the product must be more than zero');
  let bomRow: Bom | null = null;
  if (input.bom_id) {
    bomRow = await bom(db, input.bom_id);
    if (!bomRow || bomRow.item_id !== main.id) throw new CoreError('invalid', 'The BOM does not belong to this product');
  }
  const exploded = bomRow ? await explodeBom(db, bomRow.id, input.qty) : { components: [], byproducts: [] };
  const comps: MfgLineInput[] = input.components ?? exploded.components.map((l) => ({ item_id: l.item_id, godown_id: l.godown_id, qty: l.qty }));
  const bys: MfgByLineInput[] = input.byproducts ?? exploded.byproducts.map((l) => ({ item_id: l.item_id, godown_id: l.godown_id, qty: l.qty, kind: l.kind as ByProductType, pct_bp: l.pct_bp }));
  if (!comps.length) throw new CoreError('invalid', 'Add at least one component');
  const houses = new Set((await godowns(db)).map((g) => g.id));
  const checkHouse = (g: number | null | undefined) => {
    if (g != null && !houses.has(g)) throw new CoreError('invalid', 'Unknown godown');
  };
  checkHouse(input.godown_id);
  const { pools, items } = await replay(db, input.date, opts.voucherId);

  const components: MfgPlanLine[] = [];
  for (const c of comps) {
    const it = items.get(c.item_id);
    if (!it) throw new CoreError('invalid', 'Unknown stock item in components');
    if (it.id === main.id) throw new CoreError('invalid', `${it.name} cannot be consumed in its own manufacture`);
    if (!Number.isInteger(c.qty) || c.qty <= 0) throw new CoreError('invalid', `Quantity for ${it.name} must be more than zero`);
    checkHouse(c.godown_id);
    const cost = pools.get(it.id)!.outward(c.qty);
    const fixed = c.rate != null;
    if (fixed && !(c.rate! >= 0)) throw new CoreError('invalid', `Rate for ${it.name} cannot be negative`);
    const amount = fixed ? Math.round((c.qty * c.rate!) / QTY_SCALE) : cost;
    components.push({ item_id: it.id, item: it.name, unit: it.unit, godown_id: c.godown_id ?? null, qty: c.qty, rate: fixed ? c.rate! : unitRate(cost, c.qty), amount, rate_fixed: fixed });
  }
  const componentsCost = components.reduce((s, c) => s + c.amount, 0);
  const sameUnit = components.every((c) => c.unit === components[0].unit);

  const ledgers = new Map((await db.select<{ id: number; name: string }>('SELECT id, name FROM ledgers')).map((l) => [l.id, l.name]));
  const addl: MfgPlanAddl[] = (input.addl ?? []).map((a) => {
    const name = ledgers.get(a.ledger_id);
    if (!name) throw new CoreError('invalid', 'Unknown ledger in additional cost');
    const bp = Math.max(0, Math.trunc(a.pct_bp ?? 0));
    const amount = bp ? Math.round((componentsCost * bp) / 10000) : Math.trunc(a.amount ?? 0);
    if (amount < 0) throw new CoreError('invalid', `Additional cost for ${name} cannot be negative`);
    return { ledger_id: a.ledger_id, ledger: name, pct_bp: bp, amount };
  });
  const addlCost = addl.reduce((s, a) => s + a.amount, 0);
  const effective = componentsCost + addlCost;

  const byproducts: MfgPlanByLine[] = bys.map((b) => {
    const it = items.get(b.item_id);
    if (!it) throw new CoreError('invalid', 'Unknown stock item in co-products/by-products/scrap');
    if (!['Co-Product', 'By-Product', 'Scrap'].includes(b.kind)) throw new CoreError('invalid', `Unknown type of item "${b.kind}"`);
    if (!Number.isInteger(b.qty) || b.qty <= 0) throw new CoreError('invalid', `Quantity for ${it.name} must be more than zero`);
    checkHouse(b.godown_id);
    const bp = Math.max(0, Math.trunc(b.pct_bp ?? 0));
    const fixed = !bp && b.rate != null;
    const amount = bp ? Math.round((effective * bp) / 10000) : fixed ? Math.round((b.qty * b.rate!) / QTY_SCALE) : 0;
    return { item_id: it.id, item: it.name, unit: it.unit, godown_id: b.godown_id ?? null, qty: b.qty, kind: b.kind, pct_bp: bp, rate: unitRate(amount, b.qty), amount, rate_fixed: fixed };
  });
  const byCost = byproducts.reduce((s, b) => s + b.amount, 0);
  const primary = effective - byCost;
  if (primary < 0) throw new CoreError('invalid', 'Cost allocated to co-products, by-products and scrap exceeds the effective cost');
  return {
    item_id: main.id,
    item: main.name,
    unit: main.unit,
    bom_id: bomRow?.id ?? null,
    bom: bomRow?.name ?? '',
    godown_id: input.godown_id ?? null,
    qty: input.qty,
    components,
    byproducts,
    addl,
    components_cost: componentsCost,
    components_qty: sameUnit ? components.reduce((s, c) => s + c.qty, 0) : null,
    addl_cost: addlCost,
    effective_cost: effective,
    byproduct_cost: byCost,
    primary_cost: primary,
    primary_pct_bp: effective ? Math.round((primary * 10000) / effective) : 10000 - byproducts.reduce((s, b) => s + b.pct_bp, 0),
    primary_rate: unitRate(primary, input.qty),
  };
}

function planStock(plan: MfgPlan) {
  const stock = [
    ...plan.components.map((c) => ({ item_id: c.item_id, godown_id: c.godown_id ?? 1, qty: -c.qty, rate: c.rate, amount: c.amount })),
    { item_id: plan.item_id, godown_id: plan.godown_id ?? 1, qty: plan.qty, rate: plan.primary_rate, amount: plan.primary_cost },
    ...plan.byproducts.map((b) => ({ item_id: b.item_id, godown_id: b.godown_id ?? 1, qty: b.qty, rate: b.rate, amount: b.amount })),
  ];
  const roles = [
    ...plan.components.map((c) => ({ role: 'Component', pct_bp: 0, fixed: c.rate_fixed })),
    { role: 'Primary', pct_bp: plan.primary_pct_bp, fixed: false },
    ...plan.byproducts.map((b) => ({ role: b.kind as string, pct_bp: b.pct_bp, fixed: b.rate_fixed })),
  ];
  return { stock, roles };
}

async function mfgStmts(db: Db, voucherId: number, voucherGuid: string, plan: MfgPlan, roles: { role: string; pct_bp: number; fixed: boolean }[]): Promise<Stmt[]> {
  let next = await nextId(db, 'mfg_addl_costs');
  return [
    { sql: 'DELETE FROM mfg_journals WHERE voucher_id = ?', params: [voucherId] },
    { sql: 'DELETE FROM mfg_journal_lines WHERE voucher_id = ?', params: [voucherId] },
    { sql: 'DELETE FROM mfg_addl_costs WHERE voucher_id = ?', params: [voucherId] },
    {
      sql: 'INSERT INTO mfg_journals (voucher_id, voucher_guid, item_id, bom_id, godown_id, qty, components_cost, addl_cost, byproduct_cost, primary_cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      params: [voucherId, voucherGuid, plan.item_id, plan.bom_id, plan.godown_id, plan.qty, plan.components_cost, plan.addl_cost, plan.byproduct_cost, plan.primary_cost],
    },
    ...roles.map((r, i) => ({ sql: 'INSERT INTO mfg_journal_lines (voucher_id, seq, role, pct_bp, rate_fixed) VALUES (?, ?, ?, ?, ?)', params: [voucherId, i, r.role, r.pct_bp, r.fixed ? 1 : 0] })),
    ...plan.addl.map((a, i) => ({ sql: 'INSERT INTO mfg_addl_costs (id, voucher_id, seq, ledger_id, pct_bp, amount) VALUES (?, ?, ?, ?, ?, ?)', params: [next++, voucherId, i, a.ledger_id, a.pct_bp, a.amount] })),
  ];
}

async function checkType(db: Db, typeId: number): Promise<void> {
  const t = await one<{ parent: string }>(db, 'SELECT parent FROM voucher_types WHERE id = ?', [typeId]);
  if (!t) throw new CoreError('invalid', 'Unknown voucher type');
  if (t.parent !== 'Stock Journal') throw new CoreError('invalid', 'A Manufacturing Journal must use a Stock Journal voucher type');
}

export async function createMfgJournal(books: Books, input: MfgJournalInput): Promise<MfgJournal> {
  await ensureMfg(books.db);
  const typeId = input.type_id ?? (await mfgVoucherTypeId(books.db));
  await checkType(books.db, typeId);
  const plan = await planMfgJournal(books.db, input);
  const { stock, roles } = planStock(plan);
  const v = await books.createVoucher({ type_id: typeId, number: input.number, date: input.date, reference: input.reference, narration: input.narration, entries: [], stock });
  try {
    await books.db.batch(await mfgStmts(books.db, v.id, v.guid, plan, roles));
  } catch (e) {
    await books.deleteVoucher(v.id);
    throw e;
  }
  return (await mfgJournal(books, v.id))!;
}

export async function updateMfgJournal(books: Books, voucherId: number, input: MfgJournalInput): Promise<MfgJournal> {
  const cur = await books.voucher(voucherId);
  if (!cur) throw new CoreError('not_found', 'Voucher not found');
  await checkType(books.db, cur.type_id);
  const plan = await planMfgJournal(books.db, input, { voucherId });
  const { stock, roles } = planStock(plan);
  await books.updateVoucher(voucherId, { type_id: cur.type_id, number: input.number ?? cur.number, date: input.date, reference: input.reference, narration: input.narration, entries: [], stock });
  await books.db.batch(await mfgStmts(books.db, voucherId, cur.guid, plan, roles));
  return (await mfgJournal(books, voucherId))!;
}

export interface MfgJournal extends MfgPlan {
  voucher: VoucherRow;
}

export async function mfgJournal(books: Books, voucherId: number): Promise<MfgJournal | null> {
  const head = await one<{ item_id: number; bom_id: number | null; godown_id: number | null; qty: number; components_cost: number; addl_cost: number; byproduct_cost: number; primary_cost: number }>(
    books.db,
    `SELECT j.* FROM ${LIVE} WHERE j.voucher_id = ?`,
    [voucherId]
  );
  const v = await books.voucher(voucherId);
  if (!head || !v) return null;
  const roles = new Map(
    (await books.db.select<{ seq: number; role: string; pct_bp: number; rate_fixed: number }>('SELECT seq, role, pct_bp, rate_fixed FROM mfg_journal_lines WHERE voucher_id = ?', [voucherId])).map((r) => [r.seq, r])
  );
  const items = new Map((await stockItems(books.db)).map((i) => [i.id, i]));
  const main = items.get(head.item_id)!;
  const b = head.bom_id ? await bom(books.db, head.bom_id) : null;
  const components: MfgPlanLine[] = [];
  const byproducts: MfgPlanByLine[] = [];
  let primaryPct = 10000;
  v.stock.forEach((m, i) => {
    const r = roles.get(i);
    const it = items.get(m.item_id)!;
    const base = { item_id: m.item_id, item: it.name, unit: it.unit, godown_id: m.godown_id ?? null, qty: Math.abs(m.qty), rate: m.rate, amount: m.amount, rate_fixed: !!r?.rate_fixed };
    if (!r || r.role === 'Primary') primaryPct = r?.pct_bp ?? primaryPct;
    else if (r.role === 'Component') components.push(base);
    else byproducts.push({ ...base, kind: r.role as ByProductType, pct_bp: r.pct_bp });
  });
  const addl = await books.db.select<MfgPlanAddl>(
    'SELECT a.ledger_id, l.name AS ledger, a.pct_bp, a.amount FROM mfg_addl_costs a JOIN ledgers l ON l.id = a.ledger_id WHERE a.voucher_id = ? ORDER BY a.seq',
    [voucherId]
  );
  const sameUnit = components.every((c) => c.unit === components[0]?.unit);
  return {
    voucher: v,
    item_id: head.item_id,
    item: main.name,
    unit: main.unit,
    bom_id: b?.id ?? null,
    bom: b?.name ?? '',
    godown_id: head.godown_id,
    qty: head.qty,
    components,
    byproducts,
    addl,
    components_cost: head.components_cost,
    components_qty: sameUnit ? components.reduce((s, c) => s + c.qty, 0) : null,
    addl_cost: head.addl_cost,
    effective_cost: head.components_cost + head.addl_cost,
    byproduct_cost: head.byproduct_cost,
    primary_cost: head.primary_cost,
    primary_pct_bp: primaryPct,
    primary_rate: unitRate(head.primary_cost, head.qty),
  };
}

export interface EstimateLine {
  item_id: number;
  name: string;
  unit: string;
  kind: BomItemType;
  qty: number;
  rate: number;
  amount: number;
  pct_bp: number;
  has_bom: boolean;
}

export interface EstimateRow {
  item_id: number;
  name: string;
  unit: string;
  group_id: number | null;
  bom_id: number;
  bom: string;
  qty: number;
  cost: number;
  amount: number;
  components_cost: number;
  byproduct_cost: number;
  lines: EstimateLine[];
}

async function groupScope(db: Db, groupId: number | null | undefined): Promise<Set<number | null> | null> {
  if (!groupId) return null;
  const groups = await stockGroups(db);
  const scope = new Set<number | null>([groupId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const g of groups) if (g.parent_id != null && scope.has(g.parent_id) && !scope.has(g.id)) (scope.add(g.id), (grew = true));
  }
  return scope;
}

export async function costEstimation(db: Db, asAt: string, opts: { groupId?: number | null; itemId?: number; allBoms?: boolean } = {}): Promise<{ rows: EstimateRow[]; total: number }> {
  await ensureMfg(db);
  const { pools, items } = await replay(db, asAt);
  const scope = await groupScope(db, opts.groupId);
  const list = (await allBoms(db)).filter((b) => (!opts.itemId || b.item_id === opts.itemId) && (!scope || scope.has(items.get(b.item_id)?.group_id ?? null)));
  const withBom = new Set(list.map((b) => b.item_id));
  for (const b of await allBoms(db)) withBom.add(b.item_id);
  const seen = new Set<number>();
  const rows: EstimateRow[] = [];
  for (const b of list) {
    if (!opts.allBoms && seen.has(b.item_id)) continue;
    seen.add(b.item_id);
    const it = items.get(b.item_id)!;
    const lines: EstimateLine[] = b.lines.map((l) => {
      const amount = l.kind === 'Component' ? pools.get(l.item_id)!.clone().outward(l.qty) : 0;
      return { item_id: l.item_id, name: l.item, unit: l.unit, kind: l.kind, qty: l.qty, rate: unitRate(amount, l.qty), amount, pct_bp: l.pct_bp, has_bom: withBom.has(l.item_id) };
    });
    const comps = lines.filter((l) => l.kind === 'Component').reduce((s, l) => s + l.amount, 0);
    for (const l of lines) {
      if (l.kind === 'Component') continue;
      l.amount = Math.round((comps * l.pct_bp) / 10000);
      l.rate = unitRate(l.amount, l.qty);
    }
    const byCost = lines.filter((l) => l.kind !== 'Component').reduce((s, l) => s + l.amount, 0);
    const amount = comps - byCost;
    rows.push({ item_id: it.id, name: it.name, unit: it.unit, group_id: it.group_id, bom_id: b.id, bom: b.name, qty: b.unit_qty, cost: unitRate(amount, b.unit_qty), amount, components_cost: comps, byproduct_cost: byCost, lines });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name) || a.bom_id - b.bom_id);
  return { rows, total: rows.reduce((s, r) => s + r.amount, 0) };
}

export interface JobCostVoucher {
  voucher_id: number;
  date: string;
  type: string;
  number: string;
  bom: string;
  qty: number;
  components_cost: number;
  addl_cost: number;
  byproduct_cost: number;
  primary_cost: number;
  rate: number;
}

export interface JobCostLine {
  item_id: number;
  name: string;
  unit: string;
  kind: string;
  qty: number;
  value: number;
  rate: number;
}

export interface JobCosting {
  item_id: number;
  name: string;
  unit: string;
  vouchers: JobCostVoucher[];
  consumed: JobCostLine[];
  produced: JobCostLine[];
  addl: { ledger_id: number; ledger: string; amount: number }[];
  totals: { qty: number; components_cost: number; addl_cost: number; byproduct_cost: number; primary_cost: number; rate: number };
}

export async function jobCosting(db: Db, itemId: number, from: string, to: string): Promise<JobCosting> {
  await ensureMfg(db);
  const it = await stockItem(db, itemId);
  if (!it) throw new CoreError('not_found', 'Stock item not found');
  const vouchers = await db.select<Omit<JobCostVoucher, 'rate'>>(
    `SELECT j.voucher_id, v.date, t.name AS type, v.number, COALESCE(b.name, '') AS bom, j.qty, j.components_cost, j.addl_cost, j.byproduct_cost, j.primary_cost
     FROM mfg_journals j JOIN vouchers v ON v.id = j.voucher_id AND v.guid = j.voucher_guid JOIN voucher_types t ON t.id = v.type_id LEFT JOIN mfg_boms b ON b.id = j.bom_id
     WHERE j.item_id = ? AND v.cancelled = 0 AND v.date BETWEEN ? AND ? ORDER BY v.date, v.id`,
    [itemId, from, to]
  );
  const ids = vouchers.map((v) => v.voucher_id);
  const marks = ids.map(() => '?').join(', ');
  const lines = ids.length
    ? await db.select<{ item_id: number; name: string; unit: string; role: string; qty: number; amount: number }>(
        `SELECT m.item_id, i.name, u.symbol AS unit, COALESCE(r.role, 'Primary') AS role, m.qty, m.amount FROM stock_movements m
         JOIN stock_items i ON i.id = m.item_id JOIN units u ON u.id = i.unit_id
         LEFT JOIN mfg_journal_lines r ON r.voucher_id = m.voucher_id AND r.seq = m.seq
         WHERE m.voucher_id IN (${marks}) ORDER BY m.voucher_id, m.seq`,
        ids
      )
    : [];
  const fold = (rows: typeof lines) => {
    const map = new Map<string, JobCostLine>();
    for (const l of rows) {
      const key = `${l.item_id}:${l.role}`;
      const cur = map.get(key) ?? { item_id: l.item_id, name: l.name, unit: l.unit, kind: l.role, qty: 0, value: 0, rate: 0 };
      cur.qty += Math.abs(l.qty);
      cur.value += l.amount;
      map.set(key, cur);
    }
    return [...map.values()].map((r) => ({ ...r, rate: unitRate(r.value, r.qty) }));
  };
  const consumed = fold(lines.filter((l) => l.role === 'Component')).sort((a, b) => a.name.localeCompare(b.name));
  const roleOrder = ['Primary', 'Co-Product', 'By-Product', 'Scrap'];
  const produced = fold(lines.filter((l) => l.role !== 'Component')).sort((a, b) => roleOrder.indexOf(a.kind) - roleOrder.indexOf(b.kind) || a.name.localeCompare(b.name));
  const addl = ids.length
    ? await db.select<{ ledger_id: number; ledger: string; amount: number }>(
        `SELECT a.ledger_id, l.name AS ledger, SUM(a.amount) AS amount FROM mfg_addl_costs a JOIN ledgers l ON l.id = a.ledger_id WHERE a.voucher_id IN (${marks}) GROUP BY a.ledger_id ORDER BY l.name`,
        ids
      )
    : [];
  const sum = (k: keyof Omit<JobCostVoucher, 'rate'>) => vouchers.reduce((s, v) => s + (v[k] as number), 0);
  const totals = { qty: sum('qty'), components_cost: sum('components_cost'), addl_cost: sum('addl_cost'), byproduct_cost: sum('byproduct_cost'), primary_cost: sum('primary_cost'), rate: 0 };
  totals.rate = unitRate(totals.primary_cost, totals.qty);
  return {
    item_id: it.id,
    name: it.name,
    unit: it.unit,
    vouchers: vouchers.map((v) => ({ ...v, rate: unitRate(v.primary_cost, v.qty) })),
    consumed,
    produced,
    addl,
    totals,
  };
}

export interface RequirementRow {
  item_id: number;
  name: string;
  unit: string;
  godown_id: number | null;
  godown: string;
  per_unit: number;
  required: number;
  in_stock: number;
  godown_stock: number;
  shortfall: number;
  rate: number;
  shortfall_value: number;
}

export interface MaterialRequirement {
  item_id: number;
  name: string;
  unit: string;
  bom_id: number;
  bom: string;
  qty: number;
  rows: RequirementRow[];
  max_producible: number;
  shortfall_value: number;
}

export async function materialRequirement(db: Db, input: { item_id: number; bom_id?: number | null; qty: number; as_at: string }): Promise<MaterialRequirement> {
  await ensureMfg(db);
  const it = await stockItem(db, input.item_id);
  if (!it) throw new CoreError('not_found', 'Stock item not found');
  if (!Number.isInteger(input.qty) || input.qty <= 0) throw new CoreError('invalid', 'Planned quantity must be more than zero');
  const list = await boms(db, it.id);
  const b = input.bom_id ? list.find((x) => x.id === input.bom_id) : list[0];
  if (!b) throw new CoreError('invalid', `${it.name} has no bill of materials`);
  const { pools } = await replay(db, input.as_at);
  const gs = await godownSummary(db, input.as_at);
  const byHouse = new Map<string, number>();
  for (const g of gs.rows) for (const r of g.items) byHouse.set(`${r.item_id}:${g.godown_id}`, r.qty);
  const merged = new Map<string, RequirementRow>();
  for (const l of b.lines) {
    if (l.kind !== 'Component') continue;
    const key = `${l.item_id}:${l.godown_id ?? ''}`;
    const cur = merged.get(key);
    if (cur) {
      cur.per_unit += l.qty;
      continue;
    }
    const p = pools.get(l.item_id)!;
    merged.set(key, {
      item_id: l.item_id,
      name: l.item,
      unit: l.unit,
      godown_id: l.godown_id,
      godown: l.godown,
      per_unit: l.qty,
      required: 0,
      in_stock: p.qty(),
      godown_stock: l.godown_id ? (byHouse.get(`${l.item_id}:${l.godown_id}`) ?? 0) : p.qty(),
      shortfall: 0,
      rate: 0,
      shortfall_value: 0,
    });
  }
  let maxMake = Number.POSITIVE_INFINITY;
  const rows = [...merged.values()].map((r) => {
    const required = scaleQty(r.per_unit, input.qty, b.unit_qty);
    const shortfall = Math.max(0, required - Math.max(0, r.in_stock));
    const p = pools.get(r.item_id)!;
    const rate = p.qty() > 0 ? unitRate(p.value(), p.qty()) : Math.round(p.lastRate * QTY_SCALE);
    const perOne = r.per_unit / b.unit_qty;
    if (perOne > 0) maxMake = Math.min(maxMake, Math.floor((Math.max(0, r.in_stock) / perOne / QTY_SCALE) + 1e-9) * QTY_SCALE);
    return { ...r, required, shortfall, rate, shortfall_value: Math.round((shortfall * rate) / QTY_SCALE) };
  });
  return {
    item_id: it.id,
    name: it.name,
    unit: it.unit,
    bom_id: b.id,
    bom: b.name,
    qty: input.qty,
    rows,
    max_producible: Number.isFinite(maxMake) ? maxMake : 0,
    shortfall_value: rows.reduce((s, r) => s + r.shortfall_value, 0),
  };
}
