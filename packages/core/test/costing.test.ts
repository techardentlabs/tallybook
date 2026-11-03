import test from 'node:test';
import assert from 'node:assert/strict';
import { Books } from '../src/index.ts';
import {
  billInterest,
  budgetVariance,
  costCategorySummary,
  costCentreBreakup,
  costCentreBudgetVariance,
  costCentreMonthly,
  costCentreSummary,
  costCentreVouchers,
  createBudget,
  createCostCategory,
  createCostCentre,
  deleteCostCentre,
  ensureCosting,
  entryAllocations,
  groupInterest,
  ledgerInterest,
  saveEntryAllocations,
  saveInterestParams,
  updateCostCentre,
  type InterestParamsInput,
} from '../src/costing.ts';
import { nodeDb } from '../src/node-adapter.ts';

async function setup() {
  const books = new Books(nodeDb());
  await books.init();
  await books.createCompany({ name: 'Cost Co', fy_start: '2026-04-01', state: 'Maharashtra', gst_enabled: 0 });
  await ensureCosting(books.db);
  const groups = await books.groups();
  const g = (n: string) => groups.find((x) => x.name === n)!.id;
  const ty = (await books.voucherTypes()).reduce((m, t) => m.set(t.name, t.id), new Map<string, number>());
  const mk = async (name: string, group: string, extra: object = {}) => (await books.createLedger({ name, group_id: g(group), ...extra })).id;
  return {
    books,
    ty,
    g,
    cash: (await books.ledgers()).find((l) => l.name === 'Cash')!.id,
    travel: await mk('Travel', 'Indirect Expenses'),
    comm: await mk('Commission', 'Indirect Incomes'),
  };
}

const simple = (over: Partial<InterestParamsInput> = {}, rate = 1000, style: 'calendar_month' | 'calendar_year' | '365_day_year' = 'calendar_year'): InterestParamsInput => ({
  active: true,
  based_on: 'voucher_date',
  by_transaction: false,
  override_params: false,
  include_added: false,
  include_deducted: false,
  advanced: false,
  override_advanced: false,
  slabs: [{ rate_bp: rate, style, balances: 'all' }],
  ...over,
});

test('cost categories and centres, hierarchy and guards', async () => {
  const { books } = await setup();
  const db = books.db;
  const emp = await createCostCategory(db, { name: 'Employees' });
  const sales = await createCostCentre(db, { name: 'Sales Department', category_id: emp.id });
  const ramesh = await createCostCentre(db, { name: 'Ramesh', category_id: emp.id, parent_id: sales.id });
  assert.equal(ramesh.parent, 'Sales Department');
  assert.equal(sales.category, 'Employees');
  await assert.rejects(() => createCostCentre(db, { name: 'ramesh' }), /already exists/);
  await assert.rejects(() => updateCostCentre(db, sales.id, { name: 'Sales Department', category_id: emp.id, parent_id: ramesh.id }), /under itself/);
  await assert.rejects(() => deleteCostCentre(db, sales.id), /sub Cost Centres/);
  await assert.rejects(() => createCostCategory(db, { name: 'employees' }), /already exists/);
});

test('allocations validate per category and drive the reports', async () => {
  const { books, ty, cash, travel, comm } = await setup();
  const db = books.db;
  const emp = await createCostCategory(db, { name: 'Employees' });
  const sch = await createCostCategory(db, { name: 'Sales Schemes' });
  const sales = await createCostCentre(db, { name: 'Sales Department', category_id: emp.id });
  const ramesh = await createCostCentre(db, { name: 'Ramesh', category_id: emp.id, parent_id: sales.id });
  const suresh = await createCostCentre(db, { name: 'Suresh', category_id: emp.id, parent_id: sales.id });
  const diwali = await createCostCentre(db, { name: 'Diwali Sales', category_id: sch.id });

  const pay = await books.createVoucher({
    type_id: ty.get('Payment')!,
    date: '2026-04-01',
    entries: [
      { ledger_id: travel, amount: 35_000_00 },
      { ledger_id: cash, amount: -35_000_00 },
    ],
  });
  const rec = await books.createVoucher({
    type_id: ty.get('Receipt')!,
    date: '2026-05-03',
    entries: [
      { ledger_id: cash, amount: 15_000_00 },
      { ledger_id: comm, amount: -15_000_00 },
    ],
  });
  const travelEntry = pay.entries.find((e) => e.ledger_id === travel)!.id;
  const commEntry = rec.entries.find((e) => e.ledger_id === comm)!.id;

  await assert.rejects(() => saveEntryAllocations(db, travelEntry, [{ cost_centre_id: ramesh.id, amount: 10_000_00 }]), /Cost Break-up Total does not match/);
  await assert.rejects(() => saveEntryAllocations(db, travelEntry, [{ cost_centre_id: ramesh.id, amount: -35_000_00 }]), /same side/);
  await saveEntryAllocations(db, travelEntry, [
    { cost_centre_id: ramesh.id, amount: 10_500_00 },
    { cost_centre_id: suresh.id, amount: 24_500_00 },
    { cost_centre_id: diwali.id, amount: 35_000_00 },
  ]);
  await saveEntryAllocations(db, commEntry, [{ cost_centre_id: ramesh.id, amount: -15_000_00 }]);
  const got = (await entryAllocations(db, [travelEntry, commEntry])).get(travelEntry)!;
  assert.equal(got.length, 3);
  assert.equal(got[0].category, 'Employees');

  const sum = await costCentreSummary(db, '2026-04-01', '2027-03-31');
  const top = sum.rows.find((r) => r.name === 'Sales Department' && r.kind === 'group')!;
  assert.equal(top.debit, 35_000_00);
  assert.equal(top.credit, 15_000_00);
  assert.equal(top.closing, 20_000_00);
  assert.deepEqual(sum.rows.filter((r) => r.depth === 1).map((r) => r.name), ['Ramesh', 'Suresh']);
  assert.equal(sum.total.debit, 70_000_00);

  const cat = await costCategorySummary(db, '2026-04-01', '2027-03-31');
  assert.deepEqual(cat.rows.filter((r) => r.kind === 'category').map((r) => r.name), ['Employees', 'Sales Schemes']);
  assert.equal(cat.rows.find((r) => r.kind === 'category' && r.name === 'Employees')!.debit, 35_000_00);

  const monthly = await costCentreMonthly(db, ramesh.id, '2026-04-01', '2027-03-31');
  assert.equal(monthly.rows.length, 12);
  assert.equal(monthly.rows[0].label, 'April');
  assert.equal(monthly.rows[0].debit, 10_500_00);
  assert.equal(monthly.rows[1].credit, 15_000_00);
  assert.equal(monthly.total.closing, -4_500_00);

  const vch = await costCentreVouchers(db, ramesh.id, '2026-04-01', '2026-04-30');
  assert.equal(vch.lines.length, 1);
  assert.equal(vch.lines[0].ledger, 'Travel');
  assert.equal(vch.closing, 10_500_00);

  const br = await costCentreBreakup(db, [sales.id, diwali.id], '2026-04-01', '2027-03-31');
  const exp = br.rows.find((r) => r.name === 'Indirect Expenses')!;
  assert.equal(exp.cols[0].debit, 35_000_00);
  assert.equal(exp.cols[1].debit, 35_000_00);
  assert.equal(br.rows.find((r) => r.name === 'Indirect Incomes')!.cols[0].credit, 15_000_00);
  const inner = await costCentreBreakup(db, [sales.id], '2026-04-01', '2027-03-31', exp.id);
  assert.equal(inner.rows[0].name, 'Travel');

  await saveEntryAllocations(db, travelEntry, []);
  assert.equal((await entryAllocations(db, [travelEntry])).size, 0);
});

test('budgets and variance', async () => {
  const { books, g, ty, cash, travel } = await setup();
  const db = books.db;
  await books.createVoucher({
    type_id: ty.get('Payment')!,
    date: '2026-04-05',
    entries: [
      { ledger_id: travel, amount: 6_000_00 },
      { ledger_id: cash, amount: -6_000_00 },
    ],
  });
  const dept = await createCostCentre(db, { name: 'Finance' });
  const b = await createBudget(db, {
    name: 'April Budget',
    from_date: '2026-04-01',
    to_date: '2026-04-30',
    set_ledgers: true,
    lines: [
      { kind: 'group', ref_id: g('Indirect Expenses'), amount: 1_000_00 },
      { kind: 'ledger', ref_id: travel, amount: 1_000_00 },
      { kind: 'cost_centre', ref_id: dept.id, exp_amount: 845_000_00, inc_amount: 475_000_00 },
    ],
  });
  assert.equal(b.name, 'April Budget');
  const tb = await budgetVariance(db, b.id, '2026-04-01', '2026-04-30');
  const ie = tb.rows.find((r) => r.name === 'Indirect Expenses')!;
  assert.equal(ie.budget, 1_000_00);
  assert.equal(ie.actual, 6_000_00);
  assert.equal(ie.variance, -5_000_00);
  const lw = await budgetVariance(db, b.id, '2026-04-01', '2026-04-30', null, true);
  assert.equal(lw.rows[0].name, 'Travel');
  assert.equal(lw.rows[0].variance, -5_000_00);
  const cc = await costCentreBudgetVariance(db, b.id, '2026-04-01', '2026-04-30');
  assert.equal(cc.rows[0].closing_budget, 370_000_00);
  assert.equal(cc.rows[0].exp_actual, 0);
  const child = await createBudget(db, { name: 'Child', parent_id: b.id, from_date: '2026-04-01', to_date: '2026-04-30', lines: [{ kind: 'ledger', ref_id: travel, amount: 2_000_00 }] });
  const cv = await budgetVariance(db, child.id, '2026-04-01', '2026-04-30', null, true);
  assert.equal(cv.rows[0].budget, 2_000_00);
  await assert.rejects(() => createBudget(db, { name: 'Bad', from_date: '2026-05-01', to_date: '2026-04-01' }), /after To date/);
});

test('ledger interest follows the Tally calendar-month example', async () => {
  const { books, g, ty } = await setup();
  const db = books.db;
  const od = (await books.createLedger({ name: 'SBI OD A/c', group_id: g('Bank OD A/c'), opening: -10_000_00 })).id;
  const other = (await books.createLedger({ name: 'Other', group_id: g('Indirect Expenses') })).id;
  await saveInterestParams(
    db,
    od,
    simple(
      {
        advanced: true,
        include_added: true,
        slabs: [
          { rate_bp: 1000, style: 'calendar_month', balances: 'all', applicable_from: '2026-04-01' },
          { rate_bp: 1500, style: 'calendar_month', balances: 'all', applicable_from: '2026-10-01' },
        ],
      }
    )
  );
  await books.createVoucher({
    type_id: ty.get('Journal')!,
    date: '2027-01-04',
    entries: [
      { ledger_id: other, amount: 5_000_00 },
      { ledger_id: od, amount: -5_000_00 },
    ],
  });
  const r = await ledgerInterest(db, od, '2026-04-01', '2027-01-15');
  assert.equal(r.segments.length, 3);
  assert.deepEqual(r.segments.map((s) => s.days), [183, 95, 12]);
  assert.deepEqual(r.segments.map((s) => s.interest), [-6_000_00, -4_645_16, -870_97]);
  assert.equal(r.interest, -(6_000_00 + 4_645_16 + 870_97));
  const grp = await groupInterest(db, null, '2026-04-01', '2027-01-15');
  assert.equal(grp.rows[0].name, 'Loans (Liability)');
  assert.equal(grp.rows[0].interest, r.interest);
  const inner = await groupInterest(db, g('Bank OD A/c'), '2026-04-01', '2027-01-15');
  assert.equal(inner.rows[0].kind, 'ledger');
  assert.equal(inner.rows[0].balance, -15_000_00);
});

test('calendar year style and include-transaction-date flags', async () => {
  const { books, g, ty } = await setup();
  const db = books.db;
  const loan = (await books.createLedger({ name: 'Loan Given', group_id: g('Loans & Advances (Asset)') })).id;
  const cash = (await books.createLedger({ name: 'Petty', group_id: g('Cash-in-Hand') })).id;
  await books.createVoucher({
    type_id: ty.get('Payment')!,
    date: '2026-04-01',
    entries: [
      { ledger_id: loan, amount: 36_500_00 },
      { ledger_id: cash, amount: -36_500_00 },
    ],
  });
  await saveInterestParams(db, loan, simple({}, 1000, '365_day_year'));
  const next = await ledgerInterest(db, loan, '2026-04-01', '2026-04-10');
  assert.equal(next.segments[0].from, '2026-04-02');
  assert.equal(next.segments[0].days, 9);
  assert.equal(next.interest, 36_500_00 * 0.1 * 9 / 365);
  await saveInterestParams(db, loan, simple({ include_added: true }, 1000, '365_day_year'));
  const incl = await ledgerInterest(db, loan, '2026-04-01', '2026-04-10');
  assert.equal(incl.segments[0].days, 10);
  assert.equal(incl.interest, 36_500_00 * 0.1 * 10 / 365);
  await saveInterestParams(db, loan, simple({ include_added: true, slabs: [{ rate_bp: 1000, style: '365_day_year', balances: 'credit' }] }));
  assert.equal((await ledgerInterest(db, loan, '2026-04-01', '2026-04-10')).interest, 0);
});

test('bill-wise interest with grace period slabs and partial settlement', async () => {
  const { books, g, ty } = await setup();
  const db = books.db;
  const sales = (await books.createLedger({ name: 'Sales', group_id: g('Sales Accounts') })).id;
  const cash = (await books.createLedger({ name: 'Till', group_id: g('Cash-in-Hand') })).id;
  const party = (await books.createLedger({ name: 'Mr Bikash', group_id: g('Sundry Debtors'), bill_by_bill: 1 })).id;
  await books.createVoucher({
    type_id: ty.get('Sales')!,
    date: '2026-04-01',
    entries: [
      { ledger_id: party, amount: 50_000_00, bills: [{ kind: 'new', name: 'INV-1', amount: 50_000_00, bill_date: '2026-04-01', due_date: '2026-04-11' }] },
      { ledger_id: sales, amount: -50_000_00 },
    ],
  });
  await saveInterestParams(
    db,
    party,
    simple({
      by_transaction: true,
      advanced: true,
      slabs: [
        { rate_bp: 1000, style: '365_day_year', balances: 'all', applicability: 'past_due', after_days: 5, calc_from: 'due_date' },
        { rate_bp: 1500, style: '365_day_year', balances: 'all', applicability: 'past_due', after_days: 10, calc_from: 'due_date' },
      ],
    })
  );
  const r = await billInterest(db, party, '2026-04-01', '2026-05-01');
  assert.equal(r.bills.length, 1);
  const b = r.bills[0];
  assert.equal(b.due_date, '2026-04-11');
  assert.equal(b.segments.length, 2);
  assert.deepEqual(b.segments.map((s) => [s.from, s.to, s.days, s.rate_bp]), [
    ['2026-04-16', '2026-04-20', 5, 1000],
    ['2026-04-21', '2026-05-01', 11, 1500],
  ]);
  assert.equal(b.interest, Math.round(50_000_00 * 0.1 * 5 / 365) + Math.round(50_000_00 * 0.15 * 11 / 365));
  const grp = await groupInterest(db, g('Sundry Debtors'), '2026-04-01', '2026-05-01');
  assert.equal(grp.rows[0].interest, b.interest);

  await books.createVoucher({
    type_id: ty.get('Receipt')!,
    date: '2026-04-26',
    entries: [
      { ledger_id: cash, amount: 20_000_00 },
      { ledger_id: party, amount: -20_000_00, bills: [{ kind: 'agst', name: 'INV-1', amount: -20_000_00 }] },
    ],
  });
  const after = (await billInterest(db, party, '2026-04-01', '2026-05-01')).bills[0];
  assert.equal(after.pending, 30_000_00);
  assert.ok(after.interest < b.interest);
});
