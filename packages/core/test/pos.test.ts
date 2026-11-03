import test from 'node:test';
import assert from 'node:assert/strict';
import { Books, createStockItem, planItemInvoice } from '../src/index.ts';
import { nodeDb } from '../src/node-adapter.ts';
import {
  applyInvoiceClass,
  createVoucherClass,
  ensureVClass,
  invoiceAdditional,
  parsePercent,
  roundTo,
  setVoucherClassUse,
  setVoucherTypeOptions,
  splitDefault,
  updateVoucherClass,
  voucherClass,
  voucherClassUse,
} from '../src/vclass.ts';
import { ensurePos, posLastDate, posPayments, posRegister, savePosPayments, settlePos } from '../src/pos.ts';

async function setup() {
  const books = new Books(nodeDb());
  await books.init();
  await books.createCompany({ name: 'Shop', fy_start: '2026-04-01', state: 'Maharashtra', gst_enabled: 1, inventory_enabled: 1 });
  await ensureVClass(books.db);
  await ensurePos(books.db);
  const groups = await books.groups();
  const g = (n: string) => groups.find((x) => x.name === n)!.id;
  const mk = async (name: string, group: string, extra: object = {}) => (await books.createLedger({ name, group_id: g(group), ...extra })).id;
  const types = await books.voucherTypes();
  const sales = types.find((t) => t.name === 'Sales')!;
  const ledgers = await books.ledgers();
  const cash = ledgers.find((l) => l.name === 'Cash')?.id ?? (await mk('Cash', 'Cash-in-Hand'));
  return {
    books,
    sales,
    cash,
    local: await mk('Local Sales', 'Sales Accounts'),
    service: await mk('Service Income', 'Sales Accounts'),
    freight: await mk('Freight', 'Indirect Incomes'),
    discount: await mk('Discount', 'Indirect Expenses'),
    round: await mk('Round Off', 'Indirect Expenses'),
    bank: await mk('HDFC', 'Bank Accounts'),
    gift: await mk('Gift Vouchers', 'Sundry Debtors'),
    cust: await mk('Customer', 'Sundry Debtors', { state: 'Maharashtra' }),
  };
}

test('rounding helper', () => {
  assert.equal(roundTo(123_45, 'normal', 100), 123_00);
  assert.equal(roundTo(123_50, 'normal', 100), 124_00);
  assert.equal(roundTo(123_01, 'upward', 100), 124_00);
  assert.equal(roundTo(123_99, 'downward', 100), 123_00);
  assert.equal(roundTo(123_45, 'none', 100), 123_45);
  assert.equal(roundTo(123_45, 'normal', 0), 123_45);
});

test('invoice class: default allocations split each item and additional entries are computed', async () => {
  const s = await setup();
  await assert.rejects(
    () => createVoucherClass(s.books.db, { type_id: s.sales.id, name: 'Bad', lines: [{ section: 'default', ledger_id: s.local, side: 'Cr', calc: 'percent', value: parsePercent('90')! }] }),
    /100%/
  );
  const cls = await createVoucherClass(s.books.db, {
    type_id: s.sales.id,
    name: 'Retail',
    lines: [
      { section: 'default', ledger_id: s.local, side: 'Cr', calc: 'percent', value: parsePercent('80')! },
      { section: 'default', ledger_id: s.service, side: 'Cr', calc: 'percent', value: parsePercent('20')! },
      { section: 'additional', ledger_id: s.freight, side: 'Cr', calc: 'qty', value: 5_00 },
      { section: 'additional', ledger_id: s.discount, side: 'Dr', calc: 'percent', value: parsePercent('10')! },
      { section: 'additional', ledger_id: s.freight, side: 'Cr', calc: 'user', remove_if_zero: true },
      { section: 'additional', ledger_id: s.round, side: 'Dr', calc: 'round', rounding: 'normal', round_limit: 100 },
    ],
  });
  assert.equal(cls.lines.length, 6);
  assert.equal(cls.lines[5].rounding, 'normal');
  assert.deepEqual(splitDefault(cls, 1000_00).map((x) => x.amount), [800_00, 200_00]);

  const item = await createStockItem(s.books.db, { name: 'Pen', rate_bp: 1800, opening_qty: 100_000, opening_value: 1000_00 });
  const plan = await planItemInvoice(s.books, 'Sales', s.cust, [{ item_id: item.id, ledger_id: s.local, qty: 3_000, rate: 33_33 }]);
  const sales = 99_99;
  const tax = plan.total - plan.taxable;
  const applied = applyInvoiceClass(cls, 'Sales', plan.entries, 1, { qty: 3_000 });
  assert.equal(applied.entries.reduce((t, e) => t + e.amount, 0), 0);
  assert.equal(applied.entries.find((e) => e.ledger_id === s.local)!.amount, -Math.round(sales * 0.8));
  assert.equal(applied.entries.find((e) => e.ledger_id === s.service)!.amount, -(sales - Math.round(sales * 0.8)));
  const add = applied.additional;
  assert.equal(add[0].amount, 15_00);
  assert.equal(add[1].amount, -10_00);
  assert.equal(add[2].amount, 0);
  const pre = sales + tax + 15_00 - 10_00;
  assert.equal(add[3].amount, Math.round(pre / 100) * 100 - pre);
  assert.equal(applied.total, Math.round(pre / 100) * 100);
  assert.equal(applied.entries[0].amount, applied.total);
  assert.ok(!applied.entries.some((e) => e.amount === 0));

  const withUser = invoiceAdditional(cls, 'Sales', { sales, tax, qty: 3_000, user: { [cls.lines[4].id]: 7_00 } });
  assert.equal(withUser[2].amount, 7_00);

  const v = await s.books.createVoucher({ type_id: s.sales.id, date: '2026-04-10', party_id: s.cust, stock: plan.stock, entries: applied.entries });
  await setVoucherClassUse(s.books.db, v.id, cls.id);
  assert.equal((await voucherClassUse(s.books.db, v.id))!.name, 'Retail');
  await s.books.deleteVoucher(v.id);
  assert.equal(await voucherClassUse(s.books.db, v.id), null);
});

test('POS class keeps payment ledgers and type option is Sales only', async () => {
  const s = await setup();
  const types = await s.books.voucherTypes();
  await assert.rejects(() => setVoucherTypeOptions(s.books.db, types.find((t) => t.name === 'Purchase')!.id, { pos_invoicing: 1 }), /Sales/);
  const opts = await setVoucherTypeOptions(s.books.db, s.sales.id, { pos_invoicing: 1, pos_message1: 'Thank You', pos_message2: 'Visit Again' });
  assert.equal(opts.pos_invoicing, 1);
  assert.equal(opts.pos_message1, 'Thank You');
  const cls = await createVoucherClass(s.books.db, {
    type_id: s.sales.id,
    name: 'POS',
    pos_class: true,
    print_title: 'Cash Memo',
    gift_ledger_id: s.gift,
    card_ledger_id: s.bank,
    cash_ledger_id: s.cash,
    lines: [{ section: 'default', ledger_id: s.local, side: 'Cr', calc: 'percent', value: 100_00 }],
  });
  assert.equal(cls.pos_class, 1);
  assert.equal(cls.card_ledger_id, s.bank);
  assert.equal(cls.cheque_ledger_id, null);
  const off = await updateVoucherClass(s.books.db, cls.id, { type_id: s.sales.id, name: 'POS', pos_class: false, card_ledger_id: s.bank, lines: [] });
  assert.equal(off.card_ledger_id, null);
  assert.equal(off.print_title, '');
  assert.equal((await voucherClass(s.books.db, cls.id))!.lines.length, 0);
});

test('POS settlement across payment modes and the POS register', async () => {
  const s = await setup();
  await setVoucherTypeOptions(s.books.db, s.sales.id, { pos_invoicing: 1 });
  const item = await createStockItem(s.books.db, { name: 'Soap', rate_bp: 0, opening_qty: 50_000, opening_value: 500_00 });
  const plan = await planItemInvoice(s.books, 'Sales', s.cash, [{ item_id: item.id, ledger_id: s.local, qty: 2_000, rate: 180_00 }]);
  assert.equal(plan.total, 360_00);

  const single = settlePos(plan.entries, s.cash, [{ mode: 'cash', ledger_id: s.cash, tendered: 500_00 }]);
  assert.equal(single.balance, 140_00);
  assert.equal(single.entries[0].ledger_id, s.cash);
  assert.equal(single.entries[0].amount, 360_00);
  assert.equal(single.entries.length, 2);

  assert.throws(() => settlePos(plan.entries, s.cash, [{ mode: 'card', ledger_id: s.bank, amount: 400_00 }]), /exceeds/);

  const multi = settlePos(plan.entries, s.cash, [
    { mode: 'gift', ledger_id: s.gift, amount: 50_00 },
    { mode: 'card', ledger_id: s.bank, amount: 100_00, ref_no: '4111' },
    { mode: 'cheque', ledger_id: s.bank, amount: 10_00, bank_name: 'SBI', ref_no: '000123' },
    { mode: 'cash', ledger_id: s.cash, tendered: 300_00 },
  ]);
  assert.equal(multi.balance, 100_00);
  assert.equal(multi.due, 0);
  assert.equal(multi.entries.reduce((t, e) => t + e.amount, 0), 0);
  assert.equal(multi.entries.find((e) => e.ledger_id === s.cash)!.amount, 200_00);
  assert.equal(multi.entries.find((e) => e.ledger_id === s.bank)!.amount, 110_00);

  const partyPlan = await planItemInvoice(s.books, 'Sales', s.cust, [{ item_id: item.id, ledger_id: s.local, qty: 1_000, rate: 100_00 }]);
  const part = settlePos(partyPlan.entries, s.cust, [{ mode: 'card', ledger_id: s.bank, amount: 60_00 }]);
  assert.equal(part.due, 40_00);
  assert.equal(part.entries.find((e) => e.ledger_id === s.cust)!.amount, 40_00);

  const v = await s.books.createVoucher({ type_id: s.sales.id, date: '2026-05-02', party_id: s.cash, stock: plan.stock, entries: multi.entries });
  await savePosPayments(s.books.db, v.id, multi.payments);
  const back = await posPayments(s.books.db, v.id);
  assert.equal(back.length, 4);
  assert.equal(back[1].ref_no, '4111');
  assert.equal(await posLastDate(s.books.db), '2026-05-02');
  const reg = await posRegister(s.books.db, '2026-05-01', '2026-05-31');
  assert.equal(reg.rows.length, 1);
  const r = reg.rows[0];
  assert.equal(r.amount, 360_00);
  assert.equal(r.gift, 50_00);
  assert.equal(r.card, 100_00);
  assert.equal(r.cheque, 10_00);
  assert.equal(r.cash, 200_00);
  assert.equal(r.tendered, 300_00);
  assert.equal(r.balance, 100_00);
  assert.equal(r.on_account, 0);
  assert.equal(reg.items.length, 1);
  assert.equal(reg.items[0].qty, 2_000);
  assert.equal(reg.total.amount, 360_00);
});

test('ensureVClass upgrades an older class schema in place', async () => {
  const books = new Books(nodeDb());
  await books.init();
  await books.createCompany({ name: 'Old', fy_start: '2026-04-01', state: 'Maharashtra' });
  const sales = (await books.voucherTypes()).find((t) => t.name === 'Journal')!;
  const led = (await books.ledgers())[0];
  await books.db.batch([
    { sql: `CREATE TABLE voucher_classes (id INTEGER PRIMARY KEY, type_id INTEGER NOT NULL REFERENCES voucher_types(id) ON DELETE CASCADE, name TEXT NOT NULL COLLATE NOCASE, forex_adjust INTEGER NOT NULL DEFAULT 0, UNIQUE (type_id, name))` },
    { sql: `CREATE TABLE voucher_class_lines (id INTEGER PRIMARY KEY, class_id INTEGER NOT NULL REFERENCES voucher_classes(id) ON DELETE CASCADE, section TEXT NOT NULL CHECK (section IN ('default','additional','forex')), seq INTEGER NOT NULL, ledger_id INTEGER NOT NULL REFERENCES ledgers(id), side TEXT NOT NULL DEFAULT 'Dr' CHECK (side IN ('Dr','Cr')), calc TEXT NOT NULL DEFAULT 'percent' CHECK (calc IN ('percent','fixed','user')), value INTEGER NOT NULL DEFAULT 0, remove_if_zero INTEGER NOT NULL DEFAULT 0)` },
    { sql: 'INSERT INTO voucher_classes (id, type_id, name) VALUES (1, ?, ?)', params: [sales.id, 'Legacy'] },
    { sql: `INSERT INTO voucher_class_lines (id, class_id, section, seq, ledger_id, side, calc, value) VALUES (1, 1, 'additional', 0, ?, 'Cr', 'fixed', 500)`, params: [led.id] },
  ]);
  await ensureVClass(books.db);
  await ensureVClass(books.db);
  const c = (await voucherClass(books.db, 1))!;
  assert.equal(c.name, 'Legacy');
  assert.equal(c.pos_class, 0);
  assert.equal(c.lines[0].value, 500);
  assert.equal(c.lines[0].rounding, 'none');
  await updateVoucherClass(books.db, 1, { type_id: sales.id, name: 'Legacy', lines: [{ section: 'additional', ledger_id: led.id, calc: 'subtotal', value: 100 }] });
  assert.equal((await voucherClass(books.db, 1))!.lines[0].calc, 'subtotal');
});
