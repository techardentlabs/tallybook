import test from 'node:test';
import assert from 'node:assert/strict';
import { Books, ageingBucket, ageingLabels, balanceSheet, createItemInvoice, createStockItem, outstandingAgeing, outstandings, profitAndLoss } from '../src/index.ts';
import { nodeDb } from '../src/node-adapter.ts';

async function setup() {
  const books = new Books(nodeDb());
  await books.init();
  await books.createCompany({ name: 'Report Co', fy_start: '2026-04-01', state: 'Maharashtra', gst_enabled: 1 });
  const groups = await books.groups();
  const g = (n: string) => groups.find((x) => x.name === n)!.id;
  const ty = (await books.voucherTypes()).reduce((m, t) => m.set(t.name, t.id), new Map<string, number>());
  const mk = async (name: string, group: string, extra: object = {}) => (await books.createLedger({ name, group_id: g(group), ...extra })).id;
  const cash = (await books.ledgers()).find((l) => l.name === 'Cash')!.id;
  return { books, g, ty, mk, cash };
}

const FY = ['2026-04-01', '2027-03-31'] as const;

test('profit and loss carries group children and a single statement', async () => {
  const { books, ty, mk, cash } = await setup();
  const sales = await mk('Sales', 'Sales Accounts');
  const rent = await mk('Rent', 'Indirect Expenses');
  const freight = await mk('Freight', 'Direct Expenses');
  const interest = await mk('Interest', 'Indirect Incomes');
  await books.createVoucher({ type_id: ty.get('Receipt')!, date: '2026-05-01', entries: [{ ledger_id: cash, amount: 1000_00 }, { ledger_id: sales, amount: -1000_00 }] });
  await books.createVoucher({ type_id: ty.get('Payment')!, date: '2026-05-02', entries: [{ ledger_id: rent, amount: 150_00 }, { ledger_id: cash, amount: -150_00 }] });
  await books.createVoucher({ type_id: ty.get('Payment')!, date: '2026-05-03', entries: [{ ledger_id: freight, amount: 50_00 }, { ledger_id: cash, amount: -50_00 }] });
  await books.createVoucher({ type_id: ty.get('Receipt')!, date: '2026-05-04', entries: [{ ledger_id: cash, amount: 20_00 }, { ledger_id: interest, amount: -20_00 }] });

  const pl = await profitAndLoss(books.db, ...FY);
  assert.equal(pl.gross, 950_00);
  assert.equal(pl.net, 820_00);
  assert.equal(pl.sales, 1000_00);
  assert.equal(pl.single.totalLeft, pl.single.totalRight);
  assert.equal(pl.single.totalLeft, 1020_00);
  assert.deepEqual(pl.single.left.map((r) => r.label), ['Purchase Accounts', 'Direct Expenses', 'Indirect Expenses', 'Nett Profit']);
  assert.deepEqual(pl.single.right.map((r) => r.label), ['Sales Accounts', 'Direct Incomes', 'Indirect Incomes']);
  const ie = pl.parts.indirectExpenses;
  assert.equal(ie.kind, 'group');
  assert.deepEqual(ie.children, [{ id: rent, kind: 'ledger', label: 'Rent', amount: 150_00 }]);
  assert.equal(pl.parts.sales.children![0].amount, 1000_00);
  assert.equal(pl.parts.indirectIncomes.children![0].amount, 20_00);
  assert.equal(pl.trading.totalLeft, pl.trading.totalRight);
  assert.equal(pl.pl.totalLeft, pl.pl.totalRight);
});

test('balance sheet children, stock items and working capital', async () => {
  const { books, ty, mk } = await setup();
  const sales = await mk('Sales', 'Sales Accounts');
  const purch = await mk('Purchases', 'Purchase Accounts');
  const cust = await mk('Customer', 'Sundry Debtors', { state: 'Maharashtra' });
  const supp = await mk('Supplier', 'Sundry Creditors', { state: 'Maharashtra' });
  await mk('Owner', 'Capital Account', { opening: -5000_00 });
  await mk('Bank', 'Bank Accounts', { opening: 5000_00 });
  const item = await createStockItem(books.db, { name: 'Bolt', rate_bp: 0 });
  await createItemInvoice(books, { kind: 'Purchase', type_id: ty.get('Purchase')!, date: '2026-04-02', party_id: supp, lines: [{ item_id: item.id, ledger_id: purch, qty: 100_000, rate: 10_00 }] });
  await createItemInvoice(books, { kind: 'Sales', type_id: ty.get('Sales')!, date: '2026-04-03', party_id: cust, lines: [{ item_id: item.id, ledger_id: sales, qty: 40_000, rate: 15_00 }] });

  const bs = await balanceSheet(books.db, ...FY);
  assert.equal(bs.totalAssets, bs.totalLiabilities);
  assert.equal(bs.net, 200_00);
  const ca = bs.assets.find((r) => r.label === 'Current Assets')!;
  assert.equal(ca.kind, 'group');
  const debtors = ca.children!.find((c) => c.label === 'Sundry Debtors')!;
  assert.equal(debtors.kind, 'group');
  assert.equal(debtors.amount, 600_00);
  assert.equal(ca.children!.find((c) => c.label === 'Bank Accounts')!.amount, 5000_00);
  assert.equal(ca.children!.reduce((s, c) => s + c.amount, 0), ca.amount);
  const cl = bs.liabilities.find((r) => r.label === 'Current Liabilities')!;
  assert.equal(cl.amount, 1000_00);
  const stock = bs.assets.find((r) => r.label === 'Closing Stock')!;
  assert.deepEqual(stock.children, [{ kind: 'stock', label: 'Bolt', amount: 600_00 }]);
  const plRow = bs.liabilities.find((r) => r.label === 'Profit & Loss A/c')!;
  assert.deepEqual(plRow.children, [{ label: 'Current Period', amount: 200_00 }]);
  assert.equal(bs.working_capital.current_assets, ca.amount + 600_00);
  assert.equal(bs.working_capital.current_liabilities, 1000_00);
  assert.equal(bs.working_capital.amount, ca.amount + 600_00 - 1000_00);
});

test('ageing buckets and labels', () => {
  assert.deepEqual(ageingLabels([30, 60, 90]), ['0 to 30 days', '30 to 60 days', '60 to 90 days', '> 90 days']);
  assert.equal(ageingBucket(0, [30, 60, 90]), 0);
  assert.equal(ageingBucket(30, [30, 60, 90]), 0);
  assert.equal(ageingBucket(31, [30, 60, 90]), 1);
  assert.equal(ageingBucket(90, [30, 60, 90]), 2);
  assert.equal(ageingBucket(91, [30, 60, 90]), 3);
});

test('outstanding ageing by due date and by bill date', async () => {
  const { books, ty, mk } = await setup();
  const sales = await mk('Sales', 'Sales Accounts');
  const cust = await mk('Customer A', 'Sundry Debtors', {
    bill_by_bill: 1,
    opening: 10000_00,
    opening_bills: [{ kind: 'opening', name: 'OLD-1', amount: 10000_00, bill_date: '2026-03-01', due_date: '2026-04-15' }],
  });
  await books.createVoucher({
    type_id: ty.get('Sales')!,
    date: '2026-05-10',
    entries: [
      { ledger_id: cust, amount: 5000_00, bills: [{ kind: 'new', name: 'INV-1', amount: 5000_00, due_date: '2026-06-10' }] },
      { ledger_id: sales, amount: -5000_00 },
    ],
  });
  await books.createVoucher({
    type_id: ty.get('Sales')!,
    date: '2026-06-20',
    entries: [
      { ledger_id: cust, amount: 700_00, bills: [{ kind: 'new', name: 'INV-2', amount: 700_00 }] },
      { ledger_id: sales, amount: -700_00 },
    ],
  });

  const out = await outstandings(books.db, 'receivable', '2026-07-01', '2026-04-01');
  const due = outstandingAgeing(out);
  assert.equal(due.by, 'due');
  assert.deepEqual(due.labels, ['0 to 30 days', '30 to 60 days', '60 to 90 days', '> 90 days']);
  const l = out.ledgers[0];
  const a = due.ledgers[0];
  const age = (name: string) => a.ages[l.bills.findIndex((b) => b.name === name)];
  assert.equal(age('OLD-1'), 77);
  assert.equal(age('INV-1'), 21);
  assert.equal(age('INV-2'), 11);
  assert.deepEqual(a.buckets, [5700_00, 0, 10000_00, 0]);
  assert.deepEqual(due.total, [5700_00, 0, 10000_00, 0]);

  const byBill = outstandingAgeing(out, 'bill');
  const b = byBill.ledgers[0];
  assert.equal(b.ages[l.bills.findIndex((x) => x.name === 'OLD-1')], 122);
  assert.equal(b.ages[l.bills.findIndex((x) => x.name === 'INV-1')], 52);
  assert.deepEqual(b.buckets, [700_00, 5000_00, 0, 10000_00]);

  const custom = outstandingAgeing(out, 'due', [15, 45]);
  assert.deepEqual(custom.labels, ['0 to 15 days', '15 to 45 days', '> 45 days']);
  assert.deepEqual(custom.total, [700_00, 5000_00, 10000_00]);

  const early = await outstandings(books.db, 'receivable', '2026-05-15', '2026-04-01');
  const e = outstandingAgeing(early);
  const ix = (name: string) => early.ledgers[0].bills.findIndex((x) => x.name === name);
  assert.equal(e.ledgers[0].ages[ix('INV-1')], 0);
  assert.equal(e.ledgers[0].ages[ix('OLD-1')], 30);
  assert.deepEqual(e.total, [15000_00, 0, 0, 0]);
});
