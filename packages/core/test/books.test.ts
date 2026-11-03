import test from 'node:test';
import assert from 'node:assert/strict';
import { Books, CoreError, balanceSheet, dayBook, groupSummary, ledgerVouchers, outstandings, profitAndLoss } from '../src/index.ts';
import { nodeDb } from '../src/node-adapter.ts';

async function setup() {
  const books = new Books(nodeDb());
  await books.init();
  await books.createCompany({ name: 'Test Traders', fy_start: '2026-04-01' });
  const groups = await books.groups();
  const g = (n: string) => groups.find((x) => x.name === n)!.id;
  const types = await books.voucherTypes();
  const ty = (n: string) => types.find((x) => x.name === n)!.id;
  const mk = async (name: string, group: string, opening = 0, extra: object = {}) =>
    (await books.createLedger({ name, group_id: g(group), opening, ...extra })).id;
  return { books, g, ty, mk };
}

const rejects = (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e: unknown) => e instanceof CoreError && e.code === code);

test('seed matches Tally: 28 groups, 15 primary, 8 voucher types', async () => {
  const { books } = await setup();
  const groups = await books.groups();
  assert.equal(groups.length, 28);
  assert.equal(groups.filter((x) => !x.parent_id).length, 15);
  assert.equal((await books.voucherTypes()).length, 8);
  assert.ok((await books.ledgers()).some((l) => l.name === 'Cash'));
});

test('master validation', async () => {
  const { books, g } = await setup();
  await rejects(books.createGroup({ name: 'Cash' }), 'conflict');
  await rejects(books.createLedger({ name: 'cash', group_id: g('Bank Accounts') }), 'conflict');
  await rejects(books.deleteGroup(g('Sales Accounts')), 'invalid');
  const sub = await books.createGroup({ name: 'Retail Sales', parent_id: g('Sales Accounts') });
  assert.equal(sub.nature, 'Income');
  assert.equal(sub.affects_gross, 1);
  await books.createLedger({ name: 'Shop A', group_id: sub.id });
  await rejects(books.deleteGroup(sub.id), 'conflict');
});

test('books balance end to end', async () => {
  const { books, g, ty, mk } = await setup();
  await mk('Capital', 'Capital Account', -100000_00);
  const bank = await mk('HDFC', 'Bank Accounts', 100000_00);
  const sales = await mk('Sales', 'Sales Accounts');
  const purchase = await mk('Purchases', 'Purchase Accounts');
  const rent = await mk('Rent', 'Indirect Expenses');
  const cust = await mk('Customer A', 'Sundry Debtors');
  const cash = (await books.ledgers()).find((l) => l.name === 'Cash')!.id;

  const post = (type: string, date: string, entries: { ledger_id: number; amount: number }[]) =>
    books.createVoucher({ type_id: ty(type), date, entries });

  await rejects(post('Sales', '2026-05-01', [{ ledger_id: cust, amount: 500 }, { ledger_id: sales, amount: -400 }]), 'invalid');
  await rejects(post('Sales', '2025-01-01', [{ ledger_id: cust, amount: 500 }, { ledger_id: sales, amount: -500 }]), 'invalid');
  await rejects(post('Contra', '2026-05-01', [{ ledger_id: cust, amount: 500 }, { ledger_id: bank, amount: -500 }]), 'invalid');

  await post('Purchase', '2026-05-01', [{ ledger_id: purchase, amount: 30000_00 }, { ledger_id: bank, amount: -30000_00 }]);
  const s1 = await post('Sales', '2026-05-10', [{ ledger_id: cust, amount: 50000_00 }, { ledger_id: sales, amount: -50000_00 }]);
  assert.equal(s1.number, '1');
  await post('Receipt', '2026-05-20', [{ ledger_id: cash, amount: 20000_00 }, { ledger_id: cust, amount: -20000_00 }]);
  await post('Payment', '2026-06-01', [{ ledger_id: rent, amount: 5000_00 }, { ledger_id: cash, amount: -5000_00 }]);
  await post('Contra', '2026-06-02', [{ ledger_id: cash, amount: 1000_00 }, { ledger_id: bank, amount: -1000_00 }]);

  const pl = await profitAndLoss(books.db, '2026-04-01', '2027-03-31');
  assert.equal(pl.gross, 20000_00);
  assert.equal(pl.net, 15000_00);
  assert.equal(pl.trading.totalLeft, pl.trading.totalRight);
  assert.equal(pl.pl.totalLeft, pl.pl.totalRight);

  const bs = await balanceSheet(books.db, '2026-04-01', '2027-03-31');
  assert.equal(bs.totalAssets, bs.totalLiabilities);
  assert.ok(![...bs.assets, ...bs.liabilities].some((r) => r.label.startsWith('Difference')));

  const tb = await groupSummary(books.db, '2026-04-01', '2027-03-31', null);
  assert.equal(tb.total.closing, 0);
  assert.equal(tb.total.debit, tb.total.credit);

  const led = await ledgerVouchers(books.db, cust, '2026-04-01', '2027-03-31');
  assert.equal(led.closing, 30000_00);
  assert.equal(led.lines.length, 2);
  assert.equal(led.lines[1].balance, 30000_00);
  assert.equal(led.lines[0].particulars, 'Sales');

  await rejects(books.deleteLedger(cust), 'conflict');

  await books.updateVoucher(s1.id, { type_id: ty('Sales'), date: '2026-05-10', narration: 'edited', entries: [{ ledger_id: cust, amount: 60000_00 }, { ledger_id: sales, amount: -60000_00 }] });
  assert.equal((await profitAndLoss(books.db, '2026-04-01', '2027-03-31')).net, 25000_00);

  await books.deleteVoucher(s1.id);
  assert.equal((await profitAndLoss(books.db, '2026-04-01', '2027-03-31')).net, -35000_00);

  const day = await dayBook(books.db, '2026-04-01', '2027-03-31');
  assert.equal(day.length, 4);
  assert.equal(day[0].particulars, 'Purchases');
});

test('period filter splits opening and movement', async () => {
  const { books, ty, mk } = await setup();
  const bank = await mk('HDFC', 'Bank Accounts', 1000_00);
  await mk('Capital', 'Capital Account', -1000_00);
  const sales = await mk('Sales', 'Sales Accounts');
  await books.createVoucher({ type_id: ty('Receipt'), date: '2026-04-10', entries: [{ ledger_id: bank, amount: 500_00 }, { ledger_id: sales, amount: -500_00 }] });
  await books.createVoucher({ type_id: ty('Receipt'), date: '2026-06-10', entries: [{ ledger_id: bank, amount: 700_00 }, { ledger_id: sales, amount: -700_00 }] });
  const r = await ledgerVouchers(books.db, bank, '2026-05-01', '2026-06-30');
  assert.equal(r.opening, 1500_00);
  assert.equal(r.debit, 700_00);
  assert.equal(r.closing, 2200_00);
});

test('numbering: auto, manual and prefix', async () => {
  const { books, ty, mk } = await setup();
  const a = await mk('A', 'Sundry Debtors');
  const b = await mk('B', 'Sales Accounts');
  const e = [{ ledger_id: a, amount: 100 }, { ledger_id: b, amount: -100 }];
  const t = await books.createVoucherType({ name: 'Tax Invoice', parent: 'Sales', prefix: 'INV/', numbering: 'auto' });
  const v1 = await books.createVoucher({ type_id: t.id, date: '2026-05-01', entries: e });
  const v2 = await books.createVoucher({ type_id: t.id, date: '2026-05-02', entries: e });
  assert.deepEqual([v1.number, v2.number], ['INV/1', 'INV/2']);
  await books.updateVoucherType(ty('Journal'), { numbering: 'manual' });
  await rejects(books.createVoucher({ type_id: ty('Journal'), date: '2026-05-01', entries: e }), 'invalid');
  await books.createVoucher({ type_id: ty('Journal'), date: '2026-05-01', number: 'J-9', entries: e });
  await rejects(books.createVoucher({ type_id: ty('Journal'), date: '2026-05-02', number: 'J-9', entries: e }), 'conflict');
});

test('bill-by-bill outstandings and ageing', async () => {
  const { books, ty, mk } = await setup();
  const cust = await mk('Customer A', 'Sundry Debtors', 10000_00, {
    bill_by_bill: 1,
    opening_bills: [{ kind: 'opening', name: 'OLD-1', amount: 10000_00, bill_date: '2026-03-01', due_date: '2026-04-15' }],
  });
  const sales = await mk('Sales', 'Sales Accounts');
  const cash = (await books.ledgers()).find((l) => l.name === 'Cash')!.id;

  await rejects(
    books.createLedger({ name: 'Bad', group_id: (await books.groups()).find((x) => x.name === 'Sundry Debtors')!.id, opening: 100, opening_bills: [{ kind: 'opening', name: 'X', amount: 50 }] }),
    'invalid'
  );

  await books.createVoucher({
    type_id: ty('Sales'),
    date: '2026-05-10',
    entries: [
      { ledger_id: cust, amount: 5000_00, bills: [{ kind: 'new', name: 'INV-1', amount: 5000_00, due_date: '2026-06-10' }] },
      { ledger_id: sales, amount: -5000_00 },
    ],
  });
  await books.createVoucher({
    type_id: ty('Receipt'),
    date: '2026-05-20',
    entries: [
      { ledger_id: cash, amount: 3000_00 },
      { ledger_id: cust, amount: -3000_00, bills: [{ kind: 'agst', name: 'INV-1', amount: -3000_00 }] },
    ],
  });
  await books.createVoucher({
    type_id: ty('Receipt'),
    date: '2026-05-25',
    entries: [
      { ledger_id: cash, amount: 500_00 },
      { ledger_id: cust, amount: -500_00 },
    ],
  });

  const out = await outstandings(books.db, 'receivable', '2026-07-01', '2026-04-01');
  assert.equal(out.ledgers.length, 1);
  const l = out.ledgers[0];
  assert.equal(l.total, 11500_00);
  const inv = l.bills.find((b) => b.name === 'INV-1')!;
  assert.equal(inv.pending, 2000_00);
  assert.equal(inv.overdue_days, 21);
  const old = l.bills.find((b) => b.name === 'OLD-1')!;
  assert.equal(old.pending, 10000_00);
  assert.equal(old.overdue_days, 77);
  assert.equal(l.on_account, -500_00);
  await rejects(
    books.createVoucher({ type_id: ty('Receipt'), date: '2026-05-26', entries: [{ ledger_id: cash, amount: 100 }, { ledger_id: cust, amount: -100, bills: [{ kind: 'agst', name: 'INV-1', amount: -50 }] }] }),
    'invalid'
  );
});

test('cancel keeps the number but removes the effect', async () => {
  const { books, ty, mk } = await setup();
  const a = await mk('A', 'Sundry Debtors');
  const b = await mk('B', 'Sales Accounts');
  const v = await books.createVoucher({ type_id: ty('Sales'), date: '2026-05-01', entries: [{ ledger_id: a, amount: 100 }, { ledger_id: b, amount: -100 }] });
  await books.cancelVoucher(v.id);
  const c = await books.voucher(v.id);
  assert.equal(c!.cancelled, 1);
  assert.equal(c!.entries.length, 0);
  assert.equal((await profitAndLoss(books.db, '2026-04-01', '2027-03-31')).net, 0);
  const next = await books.createVoucher({ type_id: ty('Sales'), date: '2026-05-02', entries: [{ ledger_id: a, amount: 100 }, { ledger_id: b, amount: -100 }] });
  assert.equal(next.number, '2');
  const day = await dayBook(books.db, '2026-04-01', '2027-03-31');
  assert.equal(day[0].particulars, '(cancelled)');
});
