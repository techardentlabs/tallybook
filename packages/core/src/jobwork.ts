import { CoreError, one, type Db } from './db.ts';
import { JOB_WORK_TYPES } from './schema.ts';
import { stockSummary } from './inventory.ts';
import { boms, explodeBom } from './mfg.ts';

export { JOB_WORK_TYPES };
export type JobWorkKind = 'Out' | 'In';
export type MaterialParent = 'Material Out' | 'Material In';

export const JW_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS jw_voucher_types (
    type_id INTEGER PRIMARY KEY,
    use_for_job_work INTEGER NOT NULL DEFAULT 0,
    use_for_job_work_in INTEGER NOT NULL DEFAULT 0,
    allow_consumption INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS jw_order_meta (
    voucher_id INTEGER PRIMARY KEY,
    duration TEXT NOT NULL DEFAULT '',
    nature TEXT NOT NULL DEFAULT '',
    due_on TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS jw_material (
    voucher_id INTEGER PRIMARY KEY,
    order_voucher_id INTEGER,
    party_godown_id INTEGER,
    challan_no TEXT NOT NULL DEFAULT ''
  )`,
  'CREATE INDEX IF NOT EXISTS idx_jw_material_order ON jw_material(order_voucher_id)',
];

export async function ensureJobWork(db: Db): Promise<void> {
  await db.batch(JW_SCHEMA.map((sql) => ({ sql, params: [] })));
  await db.batch([
    { sql: 'DELETE FROM jw_order_meta WHERE voucher_id NOT IN (SELECT id FROM vouchers)', params: [] },
    { sql: 'DELETE FROM jw_material WHERE voucher_id NOT IN (SELECT id FROM vouchers)', params: [] },
  ]);
}

export interface JobWorkTypeOptions {
  type_id: number;
  use_for_job_work: number;
  use_for_job_work_in: number;
  allow_consumption: number;
}

export async function jobWorkTypeOptions(db: Db, typeId: number): Promise<JobWorkTypeOptions> {
  await ensureJobWork(db);
  return (await one<JobWorkTypeOptions>(db, 'SELECT * FROM jw_voucher_types WHERE type_id = ?', [typeId])) ?? { type_id: typeId, use_for_job_work: 1, use_for_job_work_in: 0, allow_consumption: 0 };
}

export async function saveJobWorkTypeOptions(db: Db, typeId: number, o: Partial<JobWorkTypeOptions>): Promise<void> {
  await ensureJobWork(db);
  const cur = await jobWorkTypeOptions(db, typeId);
  const v = { ...cur, ...o };
  await db.batch([
    {
      sql: 'INSERT OR REPLACE INTO jw_voucher_types (type_id, use_for_job_work, use_for_job_work_in, allow_consumption) VALUES (?, ?, ?, ?)',
      params: [typeId, v.use_for_job_work ? 1 : 0, v.use_for_job_work_in ? 1 : 0, v.allow_consumption ? 1 : 0],
    },
  ]);
}

export function roleOf(o: Pick<JobWorkTypeOptions, 'use_for_job_work_in'>): 'principal' | 'jobworker' {
  return o.use_for_job_work_in ? 'jobworker' : 'principal';
}

export interface OrderMeta {
  duration: string;
  nature: string;
  due_on: string;
}

export async function orderMeta(db: Db, voucherId: number): Promise<OrderMeta> {
  await ensureJobWork(db);
  return (await one<OrderMeta>(db, 'SELECT duration, nature, due_on FROM jw_order_meta WHERE voucher_id = ?', [voucherId])) ?? { duration: '', nature: '', due_on: '' };
}

export async function saveOrderMeta(db: Db, voucherId: number, m: Partial<OrderMeta>): Promise<void> {
  await ensureJobWork(db);
  await db.batch([
    {
      sql: 'INSERT OR REPLACE INTO jw_order_meta (voucher_id, duration, nature, due_on) VALUES (?, ?, ?, ?)',
      params: [voucherId, (m.duration ?? '').slice(0, 60), (m.nature ?? '').slice(0, 200), m.due_on ?? ''],
    },
  ]);
}

export interface MaterialLink {
  order_voucher_id: number | null;
  party_godown_id: number | null;
  challan_no: string;
}

export async function materialLink(db: Db, voucherId: number): Promise<MaterialLink> {
  await ensureJobWork(db);
  return (await one<MaterialLink>(db, 'SELECT order_voucher_id, party_godown_id, challan_no FROM jw_material WHERE voucher_id = ?', [voucherId])) ?? { order_voucher_id: null, party_godown_id: null, challan_no: '' };
}

export async function saveMaterialLink(db: Db, voucherId: number, l: Partial<MaterialLink>): Promise<void> {
  await ensureJobWork(db);
  await db.batch([
    {
      sql: 'INSERT OR REPLACE INTO jw_material (voucher_id, order_voucher_id, party_godown_id, challan_no) VALUES (?, ?, ?, ?)',
      params: [voucherId, l.order_voucher_id ?? null, l.party_godown_id ?? null, (l.challan_no ?? '').slice(0, 60)],
    },
  ]);
}

const orderParent = (k: JobWorkKind) => (k === 'Out' ? 'Job Work Out Order' : 'Job Work In Order');
const componentVoucher = (k: JobWorkKind): MaterialParent => (k === 'Out' ? 'Material Out' : 'Material In');
const finishedVoucher = (k: JobWorkKind): MaterialParent => (k === 'Out' ? 'Material In' : 'Material Out');

export function kindOfOrder(parent: string): JobWorkKind | null {
  return parent === 'Job Work Out Order' ? 'Out' : parent === 'Job Work In Order' ? 'In' : null;
}

export interface JobOrderLine {
  item_id: number;
  item: string;
  unit: string;
  godown_id: number;
  rate: number;
  ordered: number;
  done: number;
  balance: number;
}

export interface ComponentLine {
  item_id: number;
  item: string;
  unit: string;
  godown_id: number | null;
  required: number;
  issued: number;
  balance: number;
}

export interface JobOrder {
  voucher_id: number;
  number: string;
  date: string;
  party_id: number | null;
  party: string;
  kind: JobWorkKind;
  meta: OrderMeta;
  lines: JobOrderLine[];
  components: ComponentLine[];
}

async function linkedQty(db: Db, orderId: number, parent: MaterialParent): Promise<Map<number, number>> {
  const sign = parent === 'Material Out' ? '<' : '>';
  const rows = await db.select<{ item_id: number; q: number }>(
    `SELECT m.item_id, SUM(ABS(m.qty)) AS q FROM stock_movements m JOIN vouchers v ON v.id = m.voucher_id JOIN voucher_types t ON t.id = v.type_id
     JOIN jw_material j ON j.voucher_id = v.id
     WHERE j.order_voucher_id = ? AND v.cancelled = 0 AND t.parent = ? AND m.qty ${sign} 0
       AND COALESCE(m.godown_id, 1) != COALESCE(j.party_godown_id, -1)
     GROUP BY m.item_id`,
    [orderId, parent]
  );
  return new Map(rows.map((r) => [r.item_id, r.q]));
}

async function defaultBomComponents(db: Db, itemId: number, qty: number) {
  const list = await boms(db, itemId);
  if (!list.length) return [];
  return (await explodeBom(db, list[0].id, qty)).components;
}

export async function jobOrder(db: Db, voucherId: number): Promise<JobOrder | null> {
  await ensureJobWork(db);
  const v = await one<{ id: number; number: string; date: string; party_id: number | null; party: string | null; parent: string }>(
    db,
    `SELECT v.id, v.number, v.date, v.party_id, p.name AS party, t.parent FROM vouchers v JOIN voucher_types t ON t.id = v.type_id LEFT JOIN ledgers p ON p.id = v.party_id WHERE v.id = ? AND v.cancelled = 0`,
    [voucherId]
  );
  const kind = v ? kindOfOrder(v.parent) : null;
  if (!v || !kind) return null;
  const moves = await db.select<{ item_id: number; item: string; unit: string; godown_id: number; qty: number; rate: number }>(
    `SELECT m.item_id, i.name AS item, u.symbol AS unit, COALESCE(m.godown_id, 1) AS godown_id, m.qty, m.rate
     FROM stock_movements m JOIN stock_items i ON i.id = m.item_id JOIN units u ON u.id = i.unit_id WHERE m.voucher_id = ? ORDER BY m.seq, m.id`,
    [voucherId]
  );
  const done = await linkedQty(db, voucherId, finishedVoucher(kind));
  const issued = await linkedQty(db, voucherId, componentVoucher(kind));
  const left = new Map(done);
  const lines: JobOrderLine[] = moves.map((m) => {
    const ordered = Math.abs(m.qty);
    const got = Math.min(ordered, left.get(m.item_id) ?? 0);
    left.set(m.item_id, (left.get(m.item_id) ?? 0) - got);
    return { item_id: m.item_id, item: m.item, unit: m.unit, godown_id: m.godown_id, rate: m.rate, ordered, done: got, balance: ordered - got };
  });
  const req = new Map<number, ComponentLine>();
  for (const l of lines) {
    for (const c of await defaultBomComponents(db, l.item_id, l.ordered)) {
      const cur = req.get(c.item_id) ?? { item_id: c.item_id, item: c.item, unit: c.unit, godown_id: c.godown_id, required: 0, issued: 0, balance: 0 };
      cur.required += c.qty;
      req.set(c.item_id, cur);
    }
  }
  const components = [...req.values()].map((c) => {
    const got = issued.get(c.item_id) ?? 0;
    return { ...c, issued: got, balance: c.required - got };
  });
  return { voucher_id: v.id, number: v.number, date: v.date, party_id: v.party_id, party: v.party ?? '', kind, meta: await orderMeta(db, v.id), lines, components };
}

export async function jobOrders(db: Db, kind: JobWorkKind, opts: { partyId?: number | null; from?: string; to?: string } = {}): Promise<JobOrder[]> {
  await ensureJobWork(db);
  const ids = await db.select<{ id: number }>(
    `SELECT v.id FROM vouchers v JOIN voucher_types t ON t.id = v.type_id
     WHERE t.parent = ? AND v.cancelled = 0 AND (? IS NULL OR v.party_id = ?) AND v.date >= ? AND v.date <= ? ORDER BY v.date, v.id`,
    [orderParent(kind), opts.partyId ?? null, opts.partyId ?? null, opts.from ?? '0000-01-01', opts.to ?? '9999-12-31']
  );
  const out: JobOrder[] = [];
  for (const r of ids) {
    const o = await jobOrder(db, r.id);
    if (o) out.push(o);
  }
  return out;
}

export interface PendingMaterial {
  item_id: number;
  item: string;
  godown_id: number | null;
  qty: number;
  rate: number;
}

export async function pendingForMaterial(db: Db, orderVoucherId: number, parent: MaterialParent): Promise<PendingMaterial[]> {
  const o = await jobOrder(db, orderVoucherId);
  if (!o) return [];
  if (parent === componentVoucher(o.kind)) {
    if (!o.components.length) return o.lines.filter((l) => l.balance > 0).map((l) => ({ item_id: l.item_id, item: l.item, godown_id: l.godown_id, qty: l.balance, rate: l.rate }));
    return o.components.filter((c) => c.balance > 0).map((c) => ({ item_id: c.item_id, item: c.item, godown_id: c.godown_id, qty: c.balance, rate: 0 }));
  }
  return o.lines.filter((l) => l.balance > 0).map((l) => ({ item_id: l.item_id, item: l.item, godown_id: l.godown_id, qty: l.balance, rate: l.rate }));
}

export async function pendingJobOrders(db: Db, parent: MaterialParent, partyId: number, asAt: string): Promise<JobOrder[]> {
  const out: JobOrder[] = [];
  for (const kind of ['Out', 'In'] as JobWorkKind[]) {
    for (const o of await jobOrders(db, kind, { partyId, to: asAt })) {
      if ((await pendingForMaterial(db, o.voucher_id, parent)).length) out.push(o);
    }
  }
  return out;
}

export async function consumptionFor(db: Db, itemId: number, qty: number): Promise<{ item_id: number; qty: number }[]> {
  return (await defaultBomComponents(db, itemId, qty)).map((c) => ({ item_id: c.item_id, qty: c.qty }));
}

export interface MovementRegisterRow {
  voucher_id: number;
  order_number: string;
  number: string;
  date: string;
  parent: MaterialParent;
  party: string;
  item: string;
  unit: string;
  qty: number;
  nature: string;
  challan_no: string;
}

export async function materialMovementRegister(db: Db, kind: JobWorkKind, from: string, to: string): Promise<MovementRegisterRow[]> {
  await ensureJobWork(db);
  const rows = await db.select<Omit<MovementRegisterRow, 'nature'> & { order_id: number | null; party_godown_id: number | null; godown_id: number; mqty: number }>(
    `SELECT v.id AS voucher_id, COALESCE(o.number, '') AS order_number, v.number, v.date, t.parent, COALESCE(p.name, '') AS party, i.name AS item, u.symbol AS unit,
            m.qty AS mqty, COALESCE(m.godown_id, 1) AS godown_id, j.order_voucher_id AS order_id, j.party_godown_id, j.challan_no
     FROM vouchers v JOIN voucher_types t ON t.id = v.type_id JOIN stock_movements m ON m.voucher_id = v.id JOIN stock_items i ON i.id = m.item_id JOIN units u ON u.id = i.unit_id
     LEFT JOIN jw_material j ON j.voucher_id = v.id LEFT JOIN vouchers o ON o.id = j.order_voucher_id LEFT JOIN voucher_types ot ON ot.id = o.type_id LEFT JOIN ledgers p ON p.id = v.party_id
     WHERE t.parent IN ('Material Out', 'Material In') AND v.cancelled = 0 AND v.date >= ? AND v.date <= ? AND (ot.parent IS NULL OR ot.parent = ?)
     ORDER BY v.date, v.id, m.seq`,
    [from, to, orderParent(kind)]
  );
  const natures = new Map<number, string>();
  const out: MovementRegisterRow[] = [];
  for (const r of rows) {
    if (r.party_godown_id && r.godown_id === r.party_godown_id) continue;
    if ((r.parent === 'Material Out' && r.mqty > 0) || (r.parent === 'Material In' && r.mqty < 0)) continue;
    if (r.order_id && !natures.has(r.order_id)) natures.set(r.order_id, (await orderMeta(db, r.order_id)).nature);
    out.push({ voucher_id: r.voucher_id, order_number: r.order_number, number: r.number, date: r.date, parent: r.parent, party: r.party, item: r.item, unit: r.unit, qty: Math.abs(r.mqty), nature: r.order_id ? natures.get(r.order_id) ?? '' : '', challan_no: r.challan_no ?? '' });
  }
  return out;
}

export interface ThirdPartyStockRow {
  godown_id: number;
  godown: string;
  item_id: number;
  item: string;
  unit: string;
  qty: number;
  rate: number;
  value: number;
}

export async function thirdPartyStock(db: Db, kind: 1 | 2, asAt: string): Promise<{ rows: ThirdPartyStockRow[]; total_value: number }> {
  const rows = await db.select<{ godown_id: number; godown: string; item_id: number; item: string; unit: string; qty: number }>(
    `SELECT g.id AS godown_id, g.name AS godown, i.id AS item_id, i.name AS item, u.symbol AS unit, SUM(m.qty) AS qty
     FROM stock_movements m JOIN vouchers v ON v.id = m.voucher_id JOIN voucher_types t ON t.id = v.type_id JOIN godowns g ON g.id = COALESCE(m.godown_id, 1)
     JOIN stock_items i ON i.id = m.item_id JOIN units u ON u.id = i.unit_id
     WHERE g.third_party = ? AND v.cancelled = 0 AND m.tracked = 0 AND v.date <= ? AND t.parent NOT IN ('Sales Order', 'Purchase Order', 'Job Work Out Order', 'Job Work In Order')
     GROUP BY g.id, i.id HAVING SUM(m.qty) != 0 ORDER BY g.name, i.name`,
    [kind, asAt]
  );
  const rates = new Map<number, number>();
  if (kind === 1 && rows.length) {
    const s = await stockSummary(db, asAt, asAt);
    for (const r of s.rows) rates.set(r.item_id, r.closing_rate);
  }
  const out = rows.map((r) => {
    const rate = rates.get(r.item_id) ?? 0;
    return { ...r, rate, value: Math.round((r.qty * rate) / 1000) };
  });
  return { rows: out, total_value: out.reduce((s, r) => s + r.value, 0) };
}

export interface JobWorkVarianceRow {
  voucher_id: number;
  number: string;
  date: string;
  party: string;
  item: string;
  unit: string;
  expected: number;
  actual: number;
  variance: number;
}

export async function varianceAnalysis(db: Db, mode: 'issue' | 'receipt', kind: JobWorkKind, from: string, to: string): Promise<JobWorkVarianceRow[]> {
  const out: JobWorkVarianceRow[] = [];
  for (const o of await jobOrders(db, kind, { from, to })) {
    const useComponents = (mode === 'issue') === (kind === 'Out');
    if (useComponents && o.components.length) {
      for (const c of o.components) out.push({ voucher_id: o.voucher_id, number: o.number, date: o.date, party: o.party, item: c.item, unit: c.unit, expected: c.required, actual: c.issued, variance: c.required - c.issued });
    } else {
      for (const l of o.lines) out.push({ voucher_id: o.voucher_id, number: o.number, date: o.date, party: o.party, item: l.item, unit: l.unit, expected: l.ordered, actual: l.done, variance: l.ordered - l.done });
    }
  }
  return out;
}

export async function assertJobWorkEnabled(db: Db): Promise<void> {
  const c = await one<{ j: number }>(db, 'SELECT job_work_enabled AS j FROM company WHERE id = 1');
  if (!c?.j) throw new CoreError('invalid', 'Enable job order processing in F11 (Features)');
}
