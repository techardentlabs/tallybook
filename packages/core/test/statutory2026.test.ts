import test from 'node:test';
import assert from 'node:assert/strict';
import { Books } from '../src/index.ts';
import { nodeDb } from '../src/node-adapter.ts';
import {
  IT_ACT_2025_FROM, actOn, ensureDutyLedger, ensureStatutory, form26Q, natureOn, natureVersions, natures, planTds, recordDeduction, saveNature,
  saveNatureVersion, saveTdsParty, tdsOutstandings,
} from '../src/tds.ts';
import {
  computeGratuity, computeSalary, createEmployee, createPayHead, createPayrollVoucher, defaultTaxRules, employeeTax, gratuityReport, incomeTaxComputation,
  saveEmployeeTax, saveEmployeeTerms, saveTaxRules, serviceSpan, setSalaryDetails, statutoryDefaults, taxOnIncome, taxRules, GRATUITY_CALC, IT_CALC,
} from '../src/payroll.ts';

async function company(fy = '2025-04-01') {
  const books = new Books(nodeDb());
  await books.init();
  await books.createCompany({ name: 'Stat Co', fy_start: fy, state: 'Karnataka' });
  const groups = await books.groups();
  const g = (n: string) => groups.find((x) => x.name === n)!.id;
  const types = await books.voucherTypes();
  const ty = (n: string) => types.find((x) => x.name === n)!.id;
  const mk = async (name: string, group: string, extra: object = {}) => (await books.createLedger({ name, group_id: g(group), ...extra })).id;
  return { books, db: books.db, ty, mk };
}

test('nature of payment picks 1961 or 2025 section by voucher date', async () => {
  const { books, db, ty, mk } = await company();
  await ensureStatutory(db);
  assert.equal(IT_ACT_2025_FROM, '2026-04-01');
  assert.equal(actOn('2026-03-31'), '1961');
  assert.equal(actOn('2026-04-01'), '2025');
  const list = await natures(db);
  const con = list.find((n) => n.name === 'Payments to Contractors')!;
  const scrap = list.find((n) => n.name === 'Sale of Scrap')!;
  assert.equal(con.section, '194C');
  assert.equal((await natureVersions(db)).length, 11);

  const before = await natureOn(db, con.id, '2026-03-31');
  const after = await natureOn(db, con.id, '2026-04-01');
  assert.equal(before!.section, '194C');
  assert.equal(before!.act, '1961');
  assert.equal(after!.section, '393(1) Sl. No. 6(i)');
  assert.equal(after!.act, '2025');
  assert.equal(after!.section_1961, '194C');
  assert.equal(after!.rate_ind_pan_bp, 100);
  assert.equal(after!.single_threshold, 30000_00);

  assert.equal((await natureOn(db, scrap.id, '2026-03-31'))!.rate_oth_pan_bp, 100);
  assert.equal((await natureOn(db, scrap.id, '2026-04-01'))!.rate_oth_pan_bp, 200);
  assert.equal((await natureOn(db, scrap.id, '2026-04-01'))!.section, '394(1) Sl. No. 4');

  const party = await mk('Builder', 'Sundry Creditors', { pan: 'ABCPE1234F' });
  await saveTdsParty(db, party, { deductee_type: 'Individual/HUF - Resident' });
  const exp = await mk('Works', 'Indirect Expenses');
  const duty = await ensureDutyLedger(books, con.id);
  for (const date of ['2026-03-20', '2026-04-10']) {
    if (date === '2026-04-10') await db.batch([{ sql: "UPDATE company SET fy_start = '2026-04-01'" }]);
    const plan = await planTds(db, { party_id: party, nature_id: con.id, amount: 50000_00, date });
    assert.equal(plan.tax, 500_00);
    assert.equal(plan.section, date < '2026-04-01' ? '194C' : '393(1) Sl. No. 6(i)');
    assert.equal(plan.act, date < '2026-04-01' ? '1961' : '2025');
    const v = await books.createVoucher({ type_id: ty('Journal'), date, entries: [{ ledger_id: exp, amount: 50000_00 }, { ledger_id: party, amount: -49500_00 }, { ledger_id: duty, amount: -500_00 }] });
    await recordDeduction(db, v.id, party, date, plan);
  }
  const q4 = await form26Q(db, '2026-01-01', '2026-03-31');
  assert.equal(q4.form, '26Q');
  assert.equal(q4.deductions[0].section, '194C');
  const q1 = await form26Q(db, '2026-04-01', '2026-06-30');
  assert.equal(q1.form, '140');
  assert.equal(q1.act, '2025');
  assert.equal(q1.deductions[0].section, '393(1) Sl. No. 6(i)');
  const out = await tdsOutstandings(db, '2026-01-01', '2026-06-30');
  assert.deepEqual(out.map((o) => o.section), ['194C', '393(1) Sl. No. 6(i)']);

  const custom = await saveNature(db, { name: 'Custom Fees', section: '194X', rate_oth_pan_bp: 500 });
  await saveNatureVersion(db, custom.id, { effective_from: '2026-04-01', section: '393(1) Sl. No. 9', rate_oth_pan_bp: 700 });
  assert.equal((await natureOn(db, custom.id, '2026-05-01'))!.rate_oth_pan_bp, 700);
  assert.equal((await natureOn(db, custom.id, '2026-03-01'))!.section, '194X');
  await assert.rejects(saveNatureVersion(db, custom.id, { effective_from: 'bad' }), /date/);
});

test('versions are seeded once for books created before the 2025 Act', async () => {
  const { db } = await company();
  await ensureStatutory(db);
  await db.batch([{ sql: 'DELETE FROM tds_nature_versions' }, { sql: 'DELETE FROM tds_meta' }]);
  await ensureStatutory(db);
  assert.equal((await natureVersions(db)).length, 11);
  await db.batch([{ sql: 'DELETE FROM tds_nature_versions' }]);
  await ensureStatutory(db);
  assert.equal((await natureVersions(db)).length, 0);
});

test('slab tax with rebate, marginal relief, surcharge and cess', () => {
  const nr = defaultTaxRules('2026-04-01', 'new');
  const or = defaultTaxRules('2026-04-01', 'old');
  assert.equal(nr.act, '2025');
  assert.equal(nr.standard_deduction, 75000_00);
  assert.equal(or.standard_deduction, 50000_00);
  assert.equal(taxOnIncome(12_00_000_00, nr).total, 0);
  const m = taxOnIncome(12_10_000_00, nr);
  assert.equal(m.slab_tax, 61500_00);
  assert.equal(m.rebate, 51500_00);
  assert.equal(m.total, 10400_00);
  assert.equal(taxOnIncome(17_25_000_00, nr).total, 150800_00);
  const s = taxOnIncome(50_10_000_00, nr);
  assert.equal(s.slab_tax, 10_83_000_00);
  assert.equal(s.surcharge, 7000_00);
  assert.equal(s.total, 11_33_600_00);
  assert.equal(taxOnIncome(5_00_000_00, or).total, 0);
  assert.equal(taxOnIncome(15_75_000_00, or).total, 296400_00);
  assert.equal(taxOnIncome(5_00_000_00, or, 81).slab_tax, 0);
  assert.equal(taxOnIncome(6_00_000_00, or, 65).slab_tax, 30000_00);
});

async function payroll() {
  const c = await company('2026-04-01');
  const liab = (await c.books.groups()).find((g) => g.name === 'Current Liabilities')!.id;
  const salary = (await c.books.createLedger({ name: 'Salary Payable', group_id: liab })).id;
  const basic = await createPayHead(c.books, { name: 'Basic Pay', ph_type: 'Earnings for Employees', calc_type: 'Flat Rate', gratuity: true });
  const it = await createPayHead(c.books, { name: 'Income Tax', ...statutoryDefaults('IT'), ph_type: "Employees' Statutory Deductions" });
  const grat = await createPayHead(c.books, { name: 'Gratuity', ph_type: 'Gratuity' });
  return { ...c, salary, basic, it, grat };
}

test('income tax pay head under both regimes and monthly spreading', async () => {
  const { books, db, salary, basic, it } = await payroll();
  assert.equal(it.calc_type, IT_CALC);
  assert.equal(it.statutory, 'IT');
  await assert.rejects(createPayHead(books, { name: 'Bad Tax', ph_type: 'Earnings for Employees', calc_type: IT_CALC }), /Employees' Statutory Deductions/);
  const asha = await createEmployee(db, { name: 'Asha', date_of_joining: '2026-04-01', date_of_birth: '1990-06-01' });
  await setSalaryDetails(db, { employee_id: asha.id }, '2026-04-01', [{ pay_head_id: basic.id, rate: 150000_00, per: 'Months' }, { pay_head_id: it.id, rate: 0, per: 'Months' }]);

  assert.equal((await employeeTax(db, asha.id, '2026-04-01')).regime, 'new');
  const c1 = await incomeTaxComputation(db, asha.id, '2026-04-30');
  assert.equal(c1.act, '2025');
  assert.equal(c1.gross_salary, 18_00_000_00);
  assert.equal(c1.standard_deduction, 75000_00);
  assert.equal(c1.total_income, 17_25_000_00);
  assert.equal(c1.tax.total, 150800_00);
  assert.equal(c1.remaining_months, 12);
  assert.equal(c1.monthly_tds, 12567_00);
  assert.equal((await computeSalary(db, asha.id, '2026-04-30')).find((l) => l.pay_head_id === it.id)!.amount, 12567_00);

  for (const d of ['2026-04-30', '2026-05-31', '2026-06-30']) await createPayrollVoucher(books, { date: d, account_ledger_id: salary, employees: [{ employee_id: asha.id }] });
  const c3 = await incomeTaxComputation(db, asha.id, '2026-06-30');
  assert.equal(c3.deducted, 25134_00);
  assert.equal(c3.monthly_tds, 12567_00);
  assert.deepEqual(c3.months.slice(0, 3).map((m) => m.basis), ['Actual', 'Actual', 'Projected']);

  await setSalaryDetails(db, { employee_id: asha.id }, '2026-07-01', [{ pay_head_id: basic.id, rate: 200000_00, per: 'Months' }, { pay_head_id: it.id, rate: 0, per: 'Months' }]);
  const c4 = await incomeTaxComputation(db, asha.id, '2026-07-31');
  assert.equal(c4.gross_salary, 22_50_000_00);
  assert.equal(c4.tax.total, 253500_00);
  assert.equal(c4.deducted, 37701_00);
  assert.equal(c4.remaining_months, 9);
  assert.equal(c4.monthly_tds, 23978_00);

  await saveEmployeeTax(db, asha.id, '2026-04-01', { regime: 'old', sec80c: 150000_00, sec80d: 25000_00 });
  const old = await incomeTaxComputation(db, asha.id, '2026-04-30');
  assert.equal(old.regime, 'old');
  assert.equal(old.standard_deduction, 50000_00);
  assert.equal(old.total_deductions, 175000_00);
  assert.equal(old.gross_salary, 22_50_000_00);
  assert.equal(old.total_income, 20_25_000_00);
  assert.equal(old.tax.total, 4_36_800_00);
  await assert.rejects(saveEmployeeTax(db, asha.id, '2026-05-01', {}), /1 April/);

  const rules = await taxRules(db, '2026-04-01', 'new');
  await saveTaxRules(db, { ...rules, standard_deduction: 100000_00 });
  await saveEmployeeTax(db, asha.id, '2026-04-01', { regime: 'new' });
  assert.equal((await incomeTaxComputation(db, asha.id, '2026-04-30')).standard_deduction, 100000_00);
  await assert.rejects(saveTaxRules(db, { ...rules, slabs: [{ from: 100, rate_bp: 0 }] }), /zero/);
});

test('gratuity eligibility, amount, six-month rule and ceiling', () => {
  const g = computeGratuity({ wages: 26000_00, joining: '2020-04-01', as_on: '2026-03-31' });
  assert.equal(g.years, 6);
  assert.equal(g.eligible, true);
  assert.equal(g.amount, 90000_00);
  const short = computeGratuity({ wages: 26000_00, joining: '2020-04-01', as_on: '2024-03-31' });
  assert.equal(short.eligible, false);
  assert.equal(short.amount, 0);
  assert.equal(short.accrued, 60000_00);
  assert.deepEqual(serviceSpan('2020-04-01', '2025-09-30'), { years: 5, months: 6, days: 0, total_months: 66 });
  assert.equal(computeGratuity({ wages: 26000_00, joining: '2020-04-01', as_on: '2025-09-30' }).years, 5);
  assert.equal(computeGratuity({ wages: 26000_00, joining: '2020-04-01', as_on: '2025-10-15' }).years, 6);
  const big = computeGratuity({ wages: 500000_00, joining: '2000-04-01', as_on: '2020-03-31' });
  assert.equal(big.capped, true);
  assert.equal(big.amount, 20_00_000_00);
  assert.equal(computeGratuity({ wages: 26000_00, joining: '2024-04-01', as_on: '2026-04-30', fixed_term: true }).eligible, true);
  assert.equal(computeGratuity({ wages: 26000_00, joining: '2024-04-01', as_on: '2026-04-30' }).eligible, false);
  assert.equal(computeGratuity({ wages: 26000_00, joining: '2024-04-01', as_on: '2026-04-30', reason: 'death' }).eligible, true);
});

test('gratuity pay head provisions monthly and the provision report', async () => {
  const { books, db, salary, basic, grat } = await payroll();
  assert.equal(grat.calc_type, GRATUITY_CALC);
  const ravi = await createEmployee(db, { name: 'Ravi', date_of_joining: '2026-04-01' });
  await setSalaryDetails(db, { employee_id: ravi.id }, '2026-04-01', [{ pay_head_id: basic.id, rate: 26000_00, per: 'Months' }, { pay_head_id: grat.id, rate: 0, per: 'Months' }]);
  const apr = (await computeSalary(db, ravi.id, '2026-04-30')).find((l) => l.pay_head_id === grat.id)!;
  assert.equal(apr.amount, 1250_00);
  assert.equal(apr.side, 'emp');
  await createPayrollVoucher(books, { date: '2026-04-30', account_ledger_id: salary, employees: [{ employee_id: ravi.id }] });
  assert.equal((await computeSalary(db, ravi.id, '2026-05-31')).find((l) => l.pay_head_id === grat.id)!.amount, 1250_00);
  const rep = (await gratuityReport(db, '2026-05-31')).find((r) => r.employee_id === ravi.id)!;
  assert.equal(rep.wages, 26000_00);
  assert.equal(rep.result!.accrued, 2500_00);
  assert.equal(rep.result!.eligible, false);
  assert.equal(rep.provided, 1250_00);
  assert.equal(rep.difference, 1250_00);
  await saveEmployeeTerms(db, ravi.id, { date_of_leaving: '2026-04-30' });
  assert.equal((await gratuityReport(db, '2026-05-31')).find((r) => r.employee_id === ravi.id)!.result!.accrued, 1250_00);
});

test('EPF wage ceiling moves to 25,000 from 17 September 2026 with a split September', async () => {
  const { pfCeilingOn, pfWageCap, isStatutoryPfCeiling } = await import('../src/payroll.ts');
  assert.equal(pfCeilingOn('2026-09-16'), 15000_00);
  assert.equal(pfCeilingOn('2026-09-17'), 25000_00);
  assert.equal(pfWageCap(40000_00, '2026-08-01', '2026-08-31'), 15000_00);
  assert.equal(pfWageCap(40000_00, '2026-10-01', '2026-10-31'), 25000_00);
  assert.equal(pfWageCap(20000_00, '2026-10-01', '2026-10-31'), 20000_00);
  assert.equal(pfWageCap(20000_00, '2026-09-01', '2026-09-30'), Math.round((15000_00 * 16 + 20000_00 * 14) / 30));
  assert.equal(pfWageCap(12000_00, '2026-09-01', '2026-09-30'), 12000_00);
  assert.ok(isStatutoryPfCeiling({ statutory: 'PF', ceiling: 15000_00 }));
  assert.ok(!isStatutoryPfCeiling({ statutory: 'PF', ceiling: 18000_00 }));
});
