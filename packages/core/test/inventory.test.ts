import test from 'node:test';
import assert from 'node:assert/strict';
import { Books, createItemInvoice, createStockItem, createUnit, fmtQty, godowns, lineAmount, parseQty, stockItemVouchers, stockSummary, units, deleteStockItem } from '../src/index.ts';
import { nodeDb } from '../src/node-adapter.ts';

async function setup() {
  const books = new Books(nodeDb());
  await books.init();
  await books.createCompany({ name: 'Stock Co', fy_start: '2026-04-01', state: 'Maharashtra', gst_enabled: 1 });
  const groups = await books.groups();
  const g = (n: string) => groups.find((x) => x.name === n)!.id;
  const ty = (await books.voucherTypes()).reduce((m, t) => m.set(t.name, t.id), new Map<string, number>());
  const mk = async (name: string, group: string, extra: object = {}) => (await books.createLedger({ name, group_id: g(group), ...extra })).id;
  return {
    books,
    ty,
    sales: await mk('Sales', 'Sales Accounts'),
    purch: await mk('Purchases', 'Purchase Accounts'),
    cust: await mk('Customer', 'Sundry Debtors', { state: 'Maharashtra' }),
    supp: await mk('Supplier', 'Sundry Creditors', { state: 'Maharashtra' }),
  };
}

test('quantity and amount helpers', () => {
  assert.equal(parseQty('2.5'), 2500);
  assert.equal(parseQty('abc'), null);
  assert.equal(fmtQty(12000), '12');
  assert.equal(fmtQty(2500), '2.500');
  assert.equal(lineAmount(3000, 150_00), 450_00);
  assert.equal(lineAmount(2000, 100_00, 1000), 180_00);
});

test('defaults, items and duplicates', async () => {
  const { books } = await setup();
  assert.equal((await units(books.db))[0].symbol, 'Nos');
  assert.equal((await godowns(books.db))[0].name, 'Main Location');
  const kg = await createUnit(books.db, { symbol: 'Kg', decimals: 3 });
  const item = await createStockItem(books.db, { name: 'Rice', unit_id: kg.id, rate_bp: 500, hsn_sac: '1006', opening_qty: 10_000, opening_value: 400_00 });
  assert.equal(item.opening_rate, 40_00);
  await assert.rejects(() => createStockItem(books.db, { name: 'rice' }), /already exists/);
});

test('item invoices move stock and weighted average cost', async () => {
  const { books, ty, sales, purch, cust, supp } = await setup();
  const item = await createStockItem(books.db, { name: 'Widget', rate_bp: 1800, opening_qty: 10_000, opening_value: 1000_00 });
  await createItemInvoice(books, { kind: 'Purchase', type_id: ty.get('Purchase')!, date: '2026-04-05', party_id: supp, lines: [{ item_id: item.id, ledger_id: purch, qty: 10_000, rate: 120_00 }] });
  const sale = await createItemInvoice(books, { kind: 'Sales', type_id: ty.get('Sales')!, date: '2026-04-10', party_id: cust, lines: [{ item_id: item.id, ledger_id: sales, qty: 5_000, rate: 200_00 }] });
  assert.equal(sale.stock.length, 1);
  assert.equal(sale.stock[0].qty, -5_000);
  assert.equal(sale.entries.reduce((s, e) => s + e.amount, 0), 0);
  assert.equal(sale.entries.find((e) => e.ledger === 'Customer')!.amount, 1180_00);

  const sum = await stockSummary(books.db, '2026-04-01', '2027-03-31');
  const r = sum.rows[0];
  assert.equal(r.opening_qty, 10_000);
  assert.equal(r.in_qty, 10_000);
  assert.equal(r.out_qty, 5_000);
  assert.equal(r.closing_qty, 15_000);
  assert.equal(r.out_value, 5_000 * 110_00 / 1000);
  assert.equal(r.closing_value, 1000_00 + 1200_00 - 550_00);
  assert.equal(sum.closing_value, r.closing_value);

  const led = await stockItemVouchers(books.db, item.id, '2026-04-01', '2027-03-31');
  assert.equal(led.rows.length, 2);
  assert.equal(led.closing_qty, 15_000);
  await assert.rejects(() => deleteStockItem(books.db, item.id), /transactions/);
});

test('altering and deleting a voucher keeps stock in step', async () => {
  const { books, ty, sales, cust } = await setup();
  const item = await createStockItem(books.db, { name: 'Pen', opening_qty: 100_000, opening_value: 500_00 });
  const v = await createItemInvoice(books, { kind: 'Sales', type_id: ty.get('Sales')!, date: '2026-05-01', party_id: cust, lines: [{ item_id: item.id, ledger_id: sales, qty: 20_000, rate: 10_00 }] });
  assert.equal((await stockSummary(books.db, '2026-04-01', '2027-03-31')).rows[0].closing_qty, 80_000);
  await books.cancelVoucher(v.id);
  assert.equal((await stockSummary(books.db, '2026-04-01', '2027-03-31')).rows[0].closing_qty, 100_000);
  const w = await createItemInvoice(books, { kind: 'Sales', type_id: ty.get('Sales')!, date: '2026-05-02', party_id: cust, lines: [{ item_id: item.id, ledger_id: sales, qty: 30_000, rate: 10_00 }] });
  await books.deleteVoucher(w.id);
  assert.equal((await stockSummary(books.db, '2026-04-01', '2027-03-31')).rows[0].closing_qty, 100_000);
});

test('closing stock enters the trading account and balance sheet', async () => {
  const { books, ty, sales, purch, cust, supp } = await setup();
  const { profitAndLoss, balanceSheet } = await import('../src/index.ts');
  const item = await createStockItem(books.db, { name: 'Bolt', rate_bp: 0 });
  await createItemInvoice(books, { kind: 'Purchase', type_id: ty.get('Purchase')!, date: '2026-04-02', party_id: supp, lines: [{ item_id: item.id, ledger_id: purch, qty: 100_000, rate: 10_00 }] });
  await createItemInvoice(books, { kind: 'Sales', type_id: ty.get('Sales')!, date: '2026-04-03', party_id: cust, lines: [{ item_id: item.id, ledger_id: sales, qty: 40_000, rate: 15_00 }] });
  const pl = await profitAndLoss(books.db, '2026-04-01', '2027-03-31');
  assert.equal(pl.gross, 200_00);
  const bs = await balanceSheet(books.db, '2026-04-01', '2027-03-31');
  assert.equal(bs.assets.find((r) => r.label === 'Closing Stock')!.amount, 600_00);
  assert.equal(bs.totalAssets, bs.totalLiabilities);
});

test('registers, cash book, ratios and statistics', async () => {
  const { books, ty, sales, cust } = await setup();
  const { voucherRegister, cashBankBook, ratioAnalysis, statistics } = await import('../src/index.ts');
  const item = await createStockItem(books.db, { name: 'Gear', opening_qty: 10_000, opening_value: 500_00 });
  await createItemInvoice(books, { kind: 'Sales', type_id: ty.get('Sales')!, date: '2026-05-10', party_id: cust, lines: [{ item_id: item.id, ledger_id: sales, qty: 2_000, rate: 100_00 }] });
  const reg = await voucherRegister(books.db, 'Sales', '2026-04-01', '2027-03-31');
  assert.equal(reg.months.length, 12);
  assert.equal(reg.months[1].count, 1);
  assert.equal(reg.total.count, 1);
  const cb = await cashBankBook(books.db, '2026-04-01', '2027-03-31');
  assert.equal(cb.rows[0].name, 'Cash');
  const ratios = await ratioAnalysis(books.db, '2026-04-01', '2027-03-31');
  assert.equal(ratios.find((r) => r.label === 'Gross Profit %')!.value, 100 * (200_00 - 100_00) / 200_00);
  const st = await statistics(books.db, '2026-04-01', '2027-03-31');
  assert.equal(st.vouchers.find((v) => v.label === 'Sales')!.count, 1);
  assert.equal(st.total, 1);
});

test('cash flow reconciles to the change in cash and bank; funds flow balances', async () => {
  const { books, ty, sales, purch, cust, supp } = await setup();
  const { cashFlow, fundsFlow } = await import('../src/index.ts');
  const g = (await books.groups()).find((x) => x.name === 'Bank Accounts')!.id;
  const bank = (await books.createLedger({ name: 'HDFC', group_id: g, opening: 5000_00 })).id;
  const item = await createStockItem(books.db, { name: 'Nut', opening_qty: 10_000, opening_value: 100_00 });
  await createItemInvoice(books, { kind: 'Purchase', type_id: ty.get('Purchase')!, date: '2026-04-02', party_id: supp, lines: [{ item_id: item.id, ledger_id: purch, qty: 20_000, rate: 10_00 }] });
  await createItemInvoice(books, { kind: 'Sales', type_id: ty.get('Sales')!, date: '2026-04-05', party_id: cust, lines: [{ item_id: item.id, ledger_id: sales, qty: 12_000, rate: 30_00 }] });
  await books.createVoucher({ type_id: ty.get('Receipt')!, date: '2026-04-10', entries: [{ ledger_id: bank, amount: 200_00 }, { ledger_id: cust, amount: -200_00 }] });
  await books.createVoucher({ type_id: ty.get('Payment')!, date: '2026-04-12', entries: [{ ledger_id: supp, amount: 50_00 }, { ledger_id: bank, amount: -50_00 }] });
  const cf = await cashFlow(books.db, '2026-04-01', '2027-03-31');
  assert.equal(cf.closing_cash - cf.opening_cash, 150_00);
  assert.equal(cf.net_change, cf.closing_cash - cf.opening_cash);
  const ff = await fundsFlow(books.db, '2026-04-01', '2027-03-31');
  assert.equal(ff.total_sources, ff.total_applications);
});

test('detailed group summary expands every level and totals match the condensed view', async () => {
  const { books, ty, sales, cust } = await setup();
  const { groupSummary, groupSummaryDetailed } = await import('../src/index.ts');
  await books.createVoucher({ type_id: ty.get('Journal')!, date: '2026-04-03', entries: [{ ledger_id: cust, amount: 700_00 }, { ledger_id: sales, amount: -700_00 }] });
  const flat = await groupSummary(books.db, '2026-04-01', '2027-03-31', null);
  const det = await groupSummaryDetailed(books.db, '2026-04-01', '2027-03-31', null);
  assert.equal(det.total.debit, flat.total.debit);
  assert.ok(det.rows.some((r) => r.kind === 'ledger' && r.name === 'Customer' && r.depth >= 2));
  assert.ok(det.rows.some((r) => r.kind === 'group' && r.name === 'Bank Accounts' && r.depth === 1));
});

test('audit log records changes; backup restores into a fresh database', async () => {
  const { books, ty, sales, cust } = await setup();
  const { auditLog, createBackup, restoreBackup } = await import('../src/index.ts');
  const v = await books.createVoucher({ type_id: ty.get('Journal')!, date: '2026-04-03', entries: [{ ledger_id: cust, amount: 90_00 }, { ledger_id: sales, amount: -90_00 }] });
  await books.cancelVoucher(v.id);
  const log = await auditLog(books.db);
  assert.ok(log.some((r) => r.action === 'Create' && r.object === 'Voucher' && r.name === 'Journal No. 1'));
  assert.ok(log.some((r) => r.action === 'Cancel' && r.name === 'Journal No. 1'));
  assert.ok(log.some((r) => r.action === 'Create' && r.object === 'Ledger' && r.name === 'Customer'));
  const backup = JSON.parse(JSON.stringify(await createBackup(books.db)));
  const fresh = new Books((await import('../src/node-adapter.ts')).nodeDb());
  await fresh.init();
  const out = await restoreBackup(fresh.db, backup);
  assert.ok(out.rows > 20);
  assert.equal((await fresh.requireCompany()).name, 'Stock Co');
  assert.equal((await fresh.ledgers()).some((l) => l.name === 'Customer'), true);
  assert.equal((await fresh.voucher(v.id))!.cancelled, 1);
  await assert.rejects(() => restoreBackup(fresh.db, { nope: 1 }), /not a TallyBook backup/);
});

test('extended ledger fields save and old databases are migrated', async () => {
  const { books } = await setup();
  const g = (await books.groups()).find((x) => x.name === 'Sundry Debtors')!.id;
  const l = await books.createLedger({ name: 'Rich Party', group_id: g, mobile: '9876543210', website: 'x.in', tan: 'DELA12345B', credit_limit: 500000_00, check_credit_days: 1, tds_deductible: 1, bank_branch: 'Fort', ledger_type: 'Not Applicable', notes: 'VIP' });
  assert.equal(l.mobile, '9876543210');
  assert.equal(l.credit_limit, 500000_00);
  assert.equal(l.tds_deductible, 1);
  const u = await books.updateLedger(l.id, { notes: 'Gold', tcs_applicable: 1 });
  assert.equal(u.notes, 'Gold');
  assert.equal(u.mobile, '9876543210');
  assert.equal(u.tcs_applicable, 1);
  const { nodeDb } = await import('../src/node-adapter.ts');
  const db = nodeDb();
  await db.batch([{ sql: 'CREATE TABLE ledgers (id INTEGER PRIMARY KEY, guid TEXT, name TEXT, group_id INTEGER)' }]);
  const old = new Books(db);
  await assert.doesNotReject(async () => {
    await db.batch([{ sql: 'DROP TABLE ledgers' }]);
    await old.init();
  });
  const cols = (await db.select<{ name: string }>("SELECT name FROM pragma_table_info('ledgers')")).map((c) => c.name);
  assert.ok(cols.includes('credit_limit') && cols.includes('notes'));
});

test('delivery and receipt notes, stock journal, physical stock and orders', async () => {
  const { books } = await setup();
  const { ensureStockVoucherTypes } = await import('../src/index.ts');
  await ensureStockVoucherTypes(books.db);
  await ensureStockVoucherTypes(books.db);
  const types = await books.voucherTypes();
  const t = (n: string) => types.find((x) => x.name === n)!.id;
  assert.equal(types.filter((x) => x.name === 'Delivery Note').length, 1);
  const a = await createStockItem(books.db, { name: 'Alpha', opening_qty: 50_000, opening_value: 500_00 });
  const b = await createStockItem(books.db, { name: 'Beta' });
  const mv = (item: number, qty: number, rate = 10_00) => ({ item_id: item, qty, rate, amount: Math.abs(Math.round((qty * rate) / 1000)) });
  const sum = async () => (await stockSummary(books.db, '2026-04-01', '2027-03-31')).rows;
  await books.createVoucher({ type_id: t('Delivery Note'), date: '2026-04-02', entries: [], stock: [mv(a.id, -10_000)] });
  assert.equal((await sum()).find((r) => r.name === 'Alpha')!.closing_qty, 40_000);
  await books.createVoucher({ type_id: t('Receipt Note'), date: '2026-04-03', entries: [], stock: [mv(a.id, 5_000)] });
  await books.createVoucher({ type_id: t('Stock Journal'), date: '2026-04-04', entries: [], stock: [mv(a.id, -20_000), mv(b.id, 20_000)] });
  let r = await sum();
  assert.equal(r.find((x) => x.name === 'Alpha')!.closing_qty, 25_000);
  assert.equal(r.find((x) => x.name === 'Beta')!.closing_qty, 20_000);
  await books.createVoucher({ type_id: t('Sales Order'), date: '2026-04-05', entries: [], stock: [mv(a.id, 99_000)] });
  assert.equal((await sum()).find((x) => x.name === 'Alpha')!.closing_qty, 25_000);
  await books.createVoucher({ type_id: t('Physical Stock'), date: '2026-04-06', entries: [], stock: [{ item_id: a.id, qty: 22_000, rate: 10_00, amount: 0 }] });
  r = await sum();
  assert.equal(r.find((x) => x.name === 'Alpha')!.closing_qty, 22_000);
  const led = await stockItemVouchers(books.db, a.id, '2026-04-01', '2027-03-31');
  assert.equal(led.closing_qty, 22_000);
  assert.equal(led.rows.find((x) => x.type === 'Physical Stock')!.qty, -3_000);
  await assert.rejects(() => books.createVoucher({ type_id: t('Delivery Note'), date: '2026-04-07', entries: [], stock: [] }), /at least one stock item/);
});

test('costing methods value issues differently', async () => {
  const { books, ty, sales, purch, cust, supp } = await setup();
  const run = async (method: string) => {
    const it = await createStockItem(books.db, { name: `I-${method}`, costing_method: method, standard_cost: 12_00 });
    const day = (d: number) => `2026-05-${String(d).padStart(2, '0')}`;
    await createItemInvoice(books, { kind: 'Purchase', type_id: ty.get('Purchase')!, date: day(1), party_id: supp, lines: [{ item_id: it.id, ledger_id: purch, qty: 10_000, rate: 10_00 }] });
    await createItemInvoice(books, { kind: 'Purchase', type_id: ty.get('Purchase')!, date: day(2), party_id: supp, lines: [{ item_id: it.id, ledger_id: purch, qty: 10_000, rate: 20_00 }] });
    await createItemInvoice(books, { kind: 'Sales', type_id: ty.get('Sales')!, date: day(3), party_id: cust, lines: [{ item_id: it.id, ledger_id: sales, qty: 5_000, rate: 50_00 }] });
    return (await stockSummary(books.db, '2026-04-01', '2027-03-31')).rows.find((r) => r.name === `I-${method}`)!;
  };
  assert.equal((await run('Avg Cost')).out_value, 5 * 15_00);
  assert.equal((await run('FIFO')).out_value, 5 * 10_00);
  assert.equal((await run('LIFO')).out_value, 5 * 20_00);
  assert.equal((await run('Last Purchase Cost')).out_value, 5 * 20_00);
  const std = await run('Std Cost');
  assert.equal(std.out_value, 5 * 12_00);
  assert.equal(std.closing_value, 15 * 12_00);
});

test('group behaviour options persist', async () => {
  const { books } = await setup();
  const cur = (await books.groups()).find((x) => x.name === 'Current Assets')!;
  const g = await books.createGroup({ name: 'Petty', parent_id: cur.id, net_balance_reporting: 1, used_for_calc: 1, alloc_method: 'Appropriate by Value' });
  assert.equal(g.net_balance_reporting, 1);
  assert.equal(g.alloc_method, 'Appropriate by Value');
  const u = await books.updateGroup(g.id, { used_for_calc: 0 });
  assert.equal(u.used_for_calc, 0);
  assert.equal(u.net_balance_reporting, 1);
});
