import { CoreError, one, type Db } from './db.ts';
import { clean } from './util.ts';
import type { EntryInput } from './books.ts';

export const POS_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS pos_payments (
    id INTEGER PRIMARY KEY,
    voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL DEFAULT 0,
    mode TEXT NOT NULL CHECK (mode IN ('gift','card','cheque','cash')),
    ledger_id INTEGER NOT NULL REFERENCES ledgers(id),
    amount INTEGER NOT NULL DEFAULT 0,
    ref_no TEXT NOT NULL DEFAULT '',
    bank_name TEXT NOT NULL DEFAULT '',
    tendered INTEGER NOT NULL DEFAULT 0,
    balance INTEGER NOT NULL DEFAULT 0
  )`,
  'CREATE INDEX IF NOT EXISTS pos_payments_voucher ON pos_payments (voucher_id)',
];

export async function ensurePos(db: Db): Promise<void> {
  await db.batch(POS_SCHEMA.map((sql) => ({ sql })));
}

export type PosMode = 'gift' | 'card' | 'cheque' | 'cash';

export const POS_MODES: PosMode[] = ['gift', 'card', 'cheque', 'cash'];

export const POS_MODE_LABELS: Record<PosMode, string> = {
  gift: 'Gift Voucher',
  card: 'Credit / Debit Card',
  cheque: 'Cheque / DD',
  cash: 'Cash',
};

export const POS_MODE_GROUPS: Record<PosMode, string[]> = {
  gift: ['Sundry Debtors', 'Sundry Creditors'],
  card: ['Bank Accounts', 'Bank OD A/c'],
  cheque: ['Bank Accounts', 'Bank OD A/c'],
  cash: ['Cash-in-Hand'],
};

export interface PosPaymentInput {
  mode: PosMode;
  ledger_id: number;
  amount?: number;
  ref_no?: string;
  bank_name?: string;
  tendered?: number;
}

export interface PosPayment {
  mode: PosMode;
  ledger_id: number;
  amount: number;
  ref_no: string;
  bank_name: string;
  tendered: number;
  balance: number;
}

export interface PosSettlement {
  entries: EntryInput[];
  payments: PosPayment[];
  total: number;
  paid: number;
  due: number;
  balance: number;
}

export function settlePos(entries: EntryInput[], partyId: number, payments: PosPaymentInput[]): PosSettlement {
  const [party, ...rest] = entries;
  if (!party || party.ledger_id !== partyId || party.amount <= 0) throw new CoreError('invalid', 'POS invoice must debit the party');
  const total = party.amount;
  const out: PosPayment[] = [];
  let others = 0;
  for (const p of payments) {
    if (p.mode === 'cash') continue;
    const amt = p.amount ?? 0;
    if (!Number.isInteger(amt) || amt < 0) throw new CoreError('invalid', `${POS_MODE_LABELS[p.mode]}: invalid amount`);
    if (!amt) continue;
    if (!p.ledger_id) throw new CoreError('invalid', `${POS_MODE_LABELS[p.mode]}: select the ledger`);
    others += amt;
    out.push({ mode: p.mode, ledger_id: p.ledger_id, amount: amt, ref_no: clean(p.ref_no ?? '', 60), bank_name: clean(p.bank_name ?? '', 60), tendered: 0, balance: 0 });
  }
  if (others > total) throw new CoreError('invalid', 'Payment amount exceeds the invoice value');
  const remaining = total - others;
  let balance = 0;
  const cash = payments.find((p) => p.mode === 'cash');
  if (cash) {
    const tendered = cash.tendered ?? cash.amount ?? 0;
    if (!Number.isInteger(tendered) || tendered < 0) throw new CoreError('invalid', 'Cash Tendered: invalid amount');
    if (tendered > 0) {
      if (!cash.ledger_id) throw new CoreError('invalid', 'Cash: select the ledger');
      const amt = Math.min(tendered, remaining);
      balance = Math.max(0, tendered - remaining);
      if (amt > 0 || balance > 0) out.push({ mode: 'cash', ledger_id: cash.ledger_id, amount: amt, ref_no: '', bank_name: '', tendered, balance });
    }
  }
  const paid = out.reduce((s, p) => s + p.amount, 0);
  const due = total - paid;
  const debit = new Map<number, number>();
  const order: number[] = [];
  const add = (id: number, amt: number) => {
    if (!amt) return;
    if (!debit.has(id)) order.push(id);
    debit.set(id, (debit.get(id) ?? 0) + amt);
  };
  add(partyId, due);
  for (const p of out) add(p.ledger_id, p.amount);
  const head: EntryInput[] = order.map((id) => (id === partyId && debit.get(id) === total ? { ...party } : { ledger_id: id, amount: debit.get(id)! }));
  return { entries: [...head, ...rest], payments: out, total, paid, due, balance };
}

export async function savePosPayments(db: Db, voucherId: number, payments: PosPayment[]): Promise<void> {
  await ensurePos(db);
  await db.batch([
    { sql: 'DELETE FROM pos_payments WHERE voucher_id = ?', params: [voucherId] },
    ...payments.map((p, i) => ({
      sql: 'INSERT INTO pos_payments (voucher_id, seq, mode, ledger_id, amount, ref_no, bank_name, tendered, balance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      params: [voucherId, i, p.mode, p.ledger_id, p.amount, p.ref_no, p.bank_name, p.tendered, p.balance],
    })),
  ]);
}

export async function posPayments(db: Db, voucherId: number): Promise<(PosPayment & { ledger: string })[]> {
  await ensurePos(db);
  return db.select<PosPayment & { ledger: string }>(
    'SELECT p.mode, p.ledger_id, l.name AS ledger, p.amount, p.ref_no, p.bank_name, p.tendered, p.balance FROM pos_payments p JOIN ledgers l ON l.id = p.ledger_id WHERE p.voucher_id = ? ORDER BY p.seq',
    [voucherId]
  );
}

export interface PosRegisterRow {
  id: number;
  date: string;
  number: string;
  type: string;
  party: string;
  cancelled: number;
  amount: number;
  gift: number;
  card: number;
  cheque: number;
  cash: number;
  tendered: number;
  balance: number;
  on_account: number;
}

export interface PosRegisterItem {
  voucher_id: number;
  item: string;
  unit: string;
  qty: number;
  rate: number;
  amount: number;
}

export interface PosRegister {
  rows: PosRegisterRow[];
  items: PosRegisterItem[];
  total: Omit<PosRegisterRow, 'id' | 'date' | 'number' | 'type' | 'party' | 'cancelled'>;
}

const POS_TYPES = `SELECT o.type_id FROM voucher_type_options o JOIN voucher_types t ON t.id = o.type_id WHERE o.pos_invoicing = 1 AND t.parent = 'Sales'`;

export async function posLastDate(db: Db): Promise<string | null> {
  const r = await one<{ d: string | null }>(db, `SELECT MAX(date) AS d FROM vouchers WHERE type_id IN (${POS_TYPES})`);
  return r?.d ?? null;
}

export async function hasPosTypes(db: Db): Promise<boolean> {
  return !!(await one(db, POS_TYPES));
}

export async function posRegister(db: Db, from: string, to: string): Promise<PosRegister> {
  await ensurePos(db);
  const rows = await db.select<PosRegisterRow>(
    `SELECT v.id, v.date, v.number, t.name AS type, COALESCE(p.name, '') AS party, v.cancelled,
       COALESCE((SELECT SUM(e.amount) FROM entries e WHERE e.voucher_id = v.id AND e.amount > 0), 0) AS amount,
       COALESCE((SELECT SUM(amount) FROM pos_payments x WHERE x.voucher_id = v.id AND x.mode = 'gift'), 0) AS gift,
       COALESCE((SELECT SUM(amount) FROM pos_payments x WHERE x.voucher_id = v.id AND x.mode = 'card'), 0) AS card,
       COALESCE((SELECT SUM(amount) FROM pos_payments x WHERE x.voucher_id = v.id AND x.mode = 'cheque'), 0) AS cheque,
       COALESCE((SELECT SUM(amount) FROM pos_payments x WHERE x.voucher_id = v.id AND x.mode = 'cash'), 0) AS cash,
       COALESCE((SELECT SUM(tendered) FROM pos_payments x WHERE x.voucher_id = v.id), 0) AS tendered,
       COALESCE((SELECT SUM(balance) FROM pos_payments x WHERE x.voucher_id = v.id), 0) AS balance,
       0 AS on_account
     FROM vouchers v JOIN voucher_types t ON t.id = v.type_id LEFT JOIN ledgers p ON p.id = v.party_id
     WHERE v.type_id IN (${POS_TYPES}) AND v.date >= ? AND v.date <= ?
     ORDER BY v.date, v.seq, v.id`,
    [from, to]
  );
  for (const r of rows) r.on_account = r.amount - r.gift - r.card - r.cheque - r.cash;
  const ids = rows.map((r) => r.id);
  const items = ids.length
    ? await db.select<PosRegisterItem>(
        `SELECT m.voucher_id, i.name AS item, COALESCE(u.symbol, '') AS unit, -m.qty AS qty, m.rate, m.amount
         FROM stock_movements m JOIN stock_items i ON i.id = m.item_id LEFT JOIN units u ON u.id = i.unit_id
         WHERE m.voucher_id IN (${ids.map(() => '?').join(', ')}) ORDER BY m.voucher_id, m.seq, m.id`,
        ids
      )
    : [];
  const live = rows.filter((r) => !r.cancelled);
  const sum = (k: keyof PosRegister['total']) => live.reduce((s, r) => s + r[k], 0);
  return {
    rows,
    items,
    total: { amount: sum('amount'), gift: sum('gift'), card: sum('card'), cheque: sum('cheque'), cash: sum('cash'), tendered: sum('tendered'), balance: sum('balance'), on_account: sum('on_account') },
  };
}
