import test from 'node:test';
import assert from 'node:assert/strict';
import { Books } from '../src/index.ts';
import { nodeDb } from '../src/node-adapter.ts';
import {
  dueDate, ensureDutyLedger, ensureStatutory, etdsStatement, interestIfPaidOn, interestMonths, interestOn, lateFee, natures, payTds, planTds, reconcileChallan,
  recordDeduction, returnSectionCode, saveStatementFiling, saveTdsCompany, saveTdsParty, statementDueDate, tdsChallans, tdsInterest, tdsInterestAndFee, tdsOutstandings,
} from '../src/tds.ts';
import {
  createEmployee, createPayHead, createPayrollVoucher, ecrFile, ecrLine, esiMonthlyUpload, esiStatement, form3A, pfStatement, saveEmployeeStatutory, saveEmployeeTerms,
  setSalaryDetails, statutoryDefaults, ESI_MC_HEADERS,
} from '../src/payroll.ts';

async function company(fy: string) {
  const books = new Books(nodeDb());
  await books.init();
  await books.createCompany({ name: 'Stat Co', fy_start: fy, state: 'Maharashtra' });
  await books.db.batch([{ sql: "UPDATE company SET address = 'Unit 4, Lake Road, Andheri East, Mumbai', pincode = '400069', email = 'tax@statco.in', phone = '9820012345', pan = 'AABCS1234D' WHERE id = 1" }]);
  await ensureStatutory(books.db);
  const groups = await books.groups();
  const g = (n: string) => groups.find((x) => x.name === n)!.id;
  const types = await books.voucherTypes();
  const ty = (n: string) => types.find((x) => x.name === n)!.id;
  const mk = async (name: string, group: string, extra: object = {}) => (await books.createLedger({ name, group_id: g(group), ...extra })).id;
  return { books, db: books.db, ty, mk };
}

async function deduct(c: Awaited<ReturnType<typeof company>>, natureName: string, party: number, amount: number, date: string) {
  const n = (await natures(c.db)).find((x) => x.name === natureName)!;
  const duty = await ensureDutyLedger(c.books, n.id);
  const exp = await c.mk(`Exp ${date} ${party}`, 'Indirect Expenses');
  const plan = await planTds(c.db, { party_id: party, nature_id: n.id, amount, date });
  const v = await c.books.createVoucher({ type_id: c.ty('Journal'), date, entries: [{ ledger_id: exp, amount }, { ledger_id: party, amount: -(amount - plan.total) }, { ledger_id: duty, amount: -plan.total }] });
  await recordDeduction(c.db, v.id, party, date, plan);
  return plan;
}

const deductor = {
  tan: 'MUMS12345A', deductor_type: 'Company', person_name: 'Ravi Kumar', person_designation: 'Director', person_pan: 'ABCPK1234L', person_mobile: '9876543210',
  person_email: 'ravi@statco.in',
};

test('interest month count, Rs 100 truncation, statement due dates and late fee', () => {
  assert.equal(interestMonths('2021-02-16', '2021-07-01'), 6);
  assert.equal(interestMonths('2026-05-31', '2026-06-01'), 2);
  assert.equal(interestOn(1_66_27_770_00, 150, 6), 14_96_493_00);
  assert.equal(interestOn(2000_00, 150, 2), 60_00);
  assert.equal(statementDueDate('2025-04-01', 'TDS'), '2025-07-31');
  assert.equal(statementDueDate('2025-10-01', 'TCS'), '2026-01-15');
  assert.equal(statementDueDate('2026-01-01', 'TDS'), '2026-05-31');
  assert.equal(statementDueDate('2026-07-01', 'TCS'), '2026-10-31');
  assert.equal(dueDate('2026-03-10', 'TCS'), '2026-04-07');
  assert.deepEqual(lateFee('2026-07-31', '2026-08-10', 5000_00), { days: 10, fee: 2000_00 });
  assert.deepEqual(lateFee('2026-07-31', '2026-12-31', 5000_00), { days: 153, fee: 5000_00 });
  assert.deepEqual(lateFee('2026-07-31', '2026-07-31', 5000_00), { days: 0, fee: 0 });
});

test('late TDS payment interest flows to outstandings, payment voucher and challan', async () => {
  const c = await company('2026-04-01');
  const party = await c.mk('Agent Co', 'Sundry Creditors', { pan: 'AAACA1234B' });
  await saveTdsParty(c.db, party, { deductee_type: 'Company - Resident' });
  const bank = await c.mk('HDFC Bank', 'Bank Accounts');
  const plan = await deduct(c, 'Commission Or Brokerage', party, 100000_00, '2026-05-20');
  assert.equal(plan.total, 2000_00);
  const out = await tdsOutstandings(c.db, '2026-04-01', '2027-03-31', 'TDS', '2026-08-10');
  assert.equal(out[0].due_on, '2026-06-07');
  assert.equal(out[0].interest, interestOn(2000_00, 150, 4));
  assert.equal(await interestIfPaidOn(c.db, [out[0].deduction_id], '2026-06-07'), 0);
  assert.equal(await interestIfPaidOn(c.db, [out[0].deduction_id], '2026-07-02'), 90_00);

  const pay = await payTds(c.books, { date: '2026-07-02', bank_id: bank, deduction_ids: [out[0].deduction_id], interest: 90_00, late_fee: 0, bsr_code: '0510308', challan_no: '00123', challan_date: '2026-07-02' });
  const v = await c.books.voucher(pay.voucher_id);
  const sum = v!.entries.reduce((s, e) => s + e.amount, 0);
  assert.equal(sum, 0);
  assert.ok(v!.entries.some((e) => e.amount === -2090_00));
  assert.ok((await c.books.ledgers()).some((l) => l.name === 'Interest on TDS'));
  const ch = await tdsChallans(c.db, '2026-04-01', '2027-03-31', false, 'TDS');
  assert.equal(ch[0].interest, 90_00);
  assert.equal(ch[0].amount, 2000_00);

  const rows = await tdsInterest(c.db, '2026-04-01', '2026-06-30', 'TDS', '2026-11-03');
  assert.equal(rows[0].interest, 90_00);
  assert.equal(rows[0].parts[0].months, 3);
  assert.equal(rows[0].interest_section, '398(3)(a)(ii)');

  const lf = await tdsInterestAndFee(c.db, '2026-04-01', '2026-06-30', 'TDS', '2026-08-05');
  assert.equal(lf.quarters[0].interest_paid, 90_00);
  assert.equal(lf.quarters[0].statement_due, '2026-07-31');
  assert.equal(lf.quarters[0].late_days, 5);
  assert.equal(lf.quarters[0].late_fee, 1000_00);
  await saveStatementFiling(c.db, { kind: 'TDS', quarter_from: '2026-04-01', filed_on: '2026-08-20', token_no: '123456789012345' });
  const lf2 = await tdsInterestAndFee(c.db, '2026-04-01', '2026-06-30', 'TDS', '2026-11-03');
  assert.equal(lf2.quarters[0].filed_on, '2026-08-20');
  assert.equal(lf2.quarters[0].late_fee, 2000_00);
  await assert.rejects(saveStatementFiling(c.db, { kind: 'TDS', quarter_from: '2026-04-01', filed_on: '2026-08-20', token_no: '12' }), /15 digits/);

  const fee = await payTds(c.books, { date: '2026-08-19', bank_id: bank, deduction_ids: [], kind: 'TDS', quarter_from: '2026-04-01', late_fee: 2000_00 });
  assert.equal(fee.challan_ids.length, 1);
  assert.equal((await tdsInterestAndFee(c.db, '2026-04-01', '2026-06-30', 'TDS')).quarters[0].fee_paid, 2000_00);
});

test('Form 140 e-TDS file for tax year 2026-27 follows the Protean layout', async () => {
  const c = await company('2026-04-01');
  await saveTdsCompany(c.db, deductor);
  const party = await c.mk('Dr Mehta', 'Sundry Creditors', { pan: 'ABCPM1234K' });
  await saveTdsParty(c.db, party, { deductee_type: 'Individual/HUF - Resident' });
  const con = await c.mk('Build Co', 'Sundry Creditors', { pan: 'AAFCB1234C' });
  await saveTdsParty(c.db, con, { deductee_type: 'Company - Resident' });
  const bank = await c.mk('SBI', 'Bank Accounts');
  await deduct(c, 'Fees for Professional Services', party, 60000_00, '2026-04-15');
  await deduct(c, 'Payments to Contractors', con, 40000_00, '2026-05-10');
  const ids = (await tdsOutstandings(c.db, '2026-04-01', '2026-06-30')).map((o) => o.deduction_id);
  await payTds(c.books, { date: '2026-06-05', bank_id: bank, deduction_ids: ids, bsr_code: '0510308', challan_no: '7', challan_date: '2026-06-05' });
  const st = await etdsStatement(c.db, 'TDS', '2026-04-01', { created: '2026-07-15' });
  assert.equal(st.form, '140');
  assert.deepEqual(st.errors, []);
  assert.ok(st.text.endsWith('\r\n'));
  const lines = st.text.trimEnd().split('\r\n').map((l) => l.split('^'));
  const counts = lines.map((l) => `${l[1]}:${l.length}`);
  assert.deepEqual(counts.filter((x) => x.startsWith('FH') || x.startsWith('BH')), ['FH:18', 'BH:72']);
  assert.ok(counts.filter((x) => x.startsWith('CD')).every((x) => x === 'CD:30'));
  assert.ok(counts.filter((x) => x.startsWith('DD')).every((x) => x === 'DD:45'));
  const bh = lines[1];
  assert.equal(bh[4], '140');
  assert.equal(bh[15], '202728');
  assert.equal(bh[16], '202627');
  assert.equal(bh[17], 'Q1');
  assert.equal(bh[19], 'INDIA');
  assert.equal(bh[25], '19');
  assert.equal(bh[31], 'K');
  assert.equal(bh[51], 'N');
  assert.equal(bh[58], 'ABCPK1234L');
  const cds = lines.filter((l) => l[1] === 'CD');
  const dds = lines.filter((l) => l[1] === 'DD');
  assert.equal(cds.length, 2);
  assert.equal(bh[46], '6800.00');
  assert.deepEqual(dds.map((d) => d[14]).sort(), ['1024', '1027']);
  const prof = dds.find((d) => d[14] === '1027')!;
  assert.equal(prof[7], 'ABCPM1234K');
  assert.equal(prof[8], 'DR MEHTA');
  assert.equal(prof[18], '15042026');
  assert.equal(prof[19], '60000.00');
  assert.equal(prof[23], '6000.00');
  assert.equal(prof[27], '10.0000');
  const cd = cds.find((x) => x[3] === prof[4])!;
  assert.equal(cd[12], 'C');
  assert.equal(cd[14], '0510308');
  assert.equal(cd[16], '00007');
  assert.equal(cd[18], '05062026');
  assert.equal(cd[22], '200');
  assert.equal(lines.map((l) => l[0]).join(','), lines.map((_, i) => String(i + 1)).join(','));
});

test('Form 26Q e-TDS file for FY 2025-26 uses the 26Q regular layout', async () => {
  const c = await company('2025-04-01');
  await saveTdsCompany(c.db, deductor);
  const party = await c.mk('Tech Labs', 'Sundry Creditors', { pan: 'AAFCT1234C' });
  await saveTdsParty(c.db, party, { deductee_type: 'Company - Resident' });
  const nopan = await c.mk('Ramesh', 'Sundry Creditors');
  await saveTdsParty(c.db, nopan, { deductee_type: 'Individual/HUF - Resident' });
  const bank = await c.mk('SBI', 'Bank Accounts');
  await deduct(c, 'Fees for Technical Services', party, 100000_00, '2026-01-20');
  await deduct(c, 'Fees for Professional Services', nopan, 60000_00, '2026-02-10');
  const ids = (await tdsOutstandings(c.db, '2026-01-01', '2026-03-31')).map((o) => o.deduction_id);
  await payTds(c.books, { date: '2026-03-05', bank_id: bank, deduction_ids: ids, bsr_code: '0510308', challan_no: '00031', challan_date: '2026-03-05', interest: 0 });
  await reconcileChallan(c.db, (await tdsChallans(c.db, '2026-01-01', '2026-03-31'))[0].id, { bsr_code: '0510308', challan_no: '00031', challan_date: '2026-03-05' });
  const st = await etdsStatement(c.db, 'TDS', '2026-02-01', { created: '2026-05-10' });
  assert.equal(st.form, '26Q');
  assert.deepEqual(st.errors, []);
  const lines = st.text.trimEnd().split('\r\n').map((l) => l.split('^'));
  assert.deepEqual([...new Set(lines.map((l) => `${l[1]}:${l.length}`))].sort(), ['BH:72', 'CD:41', 'DD:54', 'FH:18']);
  const fh = lines[0];
  assert.equal(fh.join('^'), '1^FH^NS1^R^10052026^1^D^MUMS12345A^1^TallyBook^^^^^^^^');
  const bh = lines[1];
  assert.equal(bh[15], '202627');
  assert.equal(bh[16], '202526');
  assert.equal(bh[17], 'Q4');
  assert.equal(bh[20], 'UNIT 4');
  assert.equal(bh[30], 'N');
  assert.equal(bh[42], '9876543210');
  assert.equal(bh[50], 'N');
  const dds = lines.filter((l) => l[1] === 'DD');
  const tech = dds.find((d) => d[12] === 'TECH LABS')!;
  assert.equal(tech[7], '1');
  assert.equal(tech[32], '4JA');
  assert.equal(tech[25], '02.0000');
  const ram = dds.find((d) => d[12] === 'RAMESH')!;
  assert.equal(ram[9], 'PANNOTAVBL');
  assert.equal(ram[7], '2');
  assert.equal(ram[29], 'C');
  assert.equal(ram[32], '4JB');
  assert.equal(ram[16], '12000.00');
  const cd = lines.find((l) => l[1] === 'CD' && l[3] === tech[3])!;
  assert.equal(lines.filter((l) => l[1] === 'CD').reduce((s, l) => s + Number(l[26]), 0), 14000);
  assert.equal(cd[11], '00031');
  assert.equal(cd[15], '0510308');
  assert.equal(cd[26], '2000.00');
  assert.equal(cd[21], '2000.00');
  assert.equal(cd[36], 'N');
  assert.equal(cd[38], '0.00');
  assert.equal(cd[39], '200');
});

test('e-TDS exceptions and TCS 27EQ / 143 statements', async () => {
  const c = await company('2025-04-01');
  const buyer = await c.mk('Scrap Buyer', 'Sundry Debtors', { pan: 'ABCPB1234D' });
  await saveTdsParty(c.db, buyer, { deductee_type: 'Individual/HUF - Resident' });
  const bank = await c.mk('SBI', 'Bank Accounts');
  const scrap = (await natures(c.db)).find((n) => n.name === 'Sale of Scrap')!;
  const duty = await ensureDutyLedger(c.books, scrap.id);
  const sales = await c.mk('Scrap Sales', 'Sales Accounts');
  for (const date of ['2026-03-10', '2026-04-10']) {
    if (date === '2026-04-10') await c.db.batch([{ sql: "UPDATE company SET fy_start = '2026-04-01'" }]);
    const plan = await planTds(c.db, { party_id: buyer, nature_id: scrap.id, amount: 50000_00, date });
    const v = await c.books.createVoucher({ type_id: c.ty('Journal'), date, entries: [{ ledger_id: buyer, amount: 50000_00 + plan.total }, { ledger_id: sales, amount: -50000_00 }, { ledger_id: duty, amount: -plan.total }] });
    await recordDeduction(c.db, v.id, buyer, date, plan);
  }
  const bad = await etdsStatement(c.db, 'TCS', '2026-01-01');
  assert.ok(bad.errors.some((e) => /TAN/.test(e)));
  assert.ok(bad.errors.some((e) => /No deposited TCS/.test(e)));
  assert.ok(bad.warnings.some((w) => /not yet deposited/.test(w)));
  await saveTdsCompany(c.db, deductor);
  const out = await tdsOutstandings(c.db, '2026-01-01', '2026-06-30', 'TCS');
  assert.equal(out.find((o) => o.date === '2026-03-10')!.due_on, '2026-04-07');
  await payTds(c.books, { date: '2026-04-07', bank_id: bank, deduction_ids: out.map((o) => o.deduction_id), bsr_code: '0510308', challan_no: '00009' });
  const q4 = await etdsStatement(c.db, 'TCS', '2026-03-01');
  assert.equal(q4.form, '27EQ');
  assert.deepEqual(q4.errors, []);
  const l4 = q4.text.trimEnd().split('\r\n').map((l) => l.split('^'));
  assert.equal(l4[0][2], 'TC1');
  const dd4 = l4.find((l) => l[1] === 'DD')!;
  assert.equal(dd4.length, 54);
  assert.equal(dd4[32], 'E');
  assert.equal(dd4[7], '2');
  assert.equal(dd4[20], '50000.00');
  assert.equal(dd4[48], 'N');
  const q1 = await etdsStatement(c.db, 'TCS', '2026-04-01');
  assert.equal(q1.form, '143');
  const dd1 = q1.text.trimEnd().split('\r\n').map((l) => l.split('^')).find((l) => l[1] === 'DD')!;
  assert.equal(dd1.length, 45);
  assert.equal(dd1[14], '1073');
  assert.equal(dd1[10], 'N');
  assert.equal(dd1[11], '2');
  assert.equal(returnSectionCode('26Q', { nature: 'Rent of Plant & Machinery', section_1961: '194I', payment_code_1961: '94I', payment_code_2025: '', rate_bp: 200, deductee_type: '' }), '4IA');
  assert.equal(returnSectionCode('140', { nature: 'Rent of Land, Building Or Furniture', section_1961: '194I', payment_code_1961: '94I', payment_code_2025: '', rate_bp: 1000, deductee_type: '' }), '1009');
});

async function payrollCo() {
  const c = await company('2026-04-01');
  const liab = (await c.books.groups()).find((g) => g.name === 'Current Liabilities')!.id;
  const salary = (await c.books.createLedger({ name: 'Salary Payable', group_id: liab })).id;
  const basic = await createPayHead(c.books, { name: 'Basic Pay', ph_type: 'Earnings for Employees', calc_type: 'Flat Rate' });
  const pf = await createPayHead(c.books, { name: 'EPF @12%', ...statutoryDefaults('PF'), ph_type: "Employees' Statutory Deductions", formula: [{ pay_head_id: basic.id, sign: 1 }] });
  const esi = await createPayHead(c.books, { name: 'ESI @0.75%', ...statutoryDefaults('ESI'), ph_type: "Employees' Statutory Deductions" });
  return { ...c, salary, basic, pf, esi };
}

test('EPF ECR honours the dated wage ceiling, the September 2026 split and the age limit', async () => {
  const c = await payrollCo();
  const asha = await createEmployee(c.db, { name: 'Asha Rao', date_of_joining: '2026-04-01', date_of_birth: '1990-01-01', uan: '100200300400', pf_number: 'MH/BAN/1/1' });
  const old = await createEmployee(c.db, { name: 'Old Timer', date_of_joining: '2020-04-01', date_of_birth: '1966-01-01', uan: '100200300401' });
  for (const e of [asha, old]) await setSalaryDetails(c.db, { employee_id: e.id }, '2026-04-01', [{ pay_head_id: c.basic.id, rate: 30000_00, per: 'Months' }, { pay_head_id: c.pf.id, rate: 0, per: 'Months' }]);
  for (const d of ['2026-08-31', '2026-09-30', '2026-10-31']) await createPayrollVoucher(c.books, { date: d, account_ledger_id: c.salary, employees: [{ employee_id: asha.id }, { employee_id: old.id }] });

  const aug = await ecrFile(c.db, '2026-08-01');
  assert.equal(aug.rows.find((r) => r.name === 'Asha Rao')!.ee, 1800);
  assert.equal(aug.text.split('\r\n')[0], '100200300400#~#ASHA RAO#~#30000#~#15000#~#15000#~#15000#~#1800#~#1250#~#550#~#0#~#0');

  const sep = await ecrFile(c.db, '2026-09-15');
  const s = sep.rows.find((r) => r.name === 'Asha Rao')!;
  assert.equal(s.epf_wages, 19667);
  assert.equal(s.eps_wages, 19667);
  assert.equal(s.ee, 2360);
  assert.equal(s.eps, 1638);
  assert.equal(s.er, 722);

  const oct = await ecrFile(c.db, '2026-10-01');
  const o = oct.rows.find((r) => r.name === 'Asha Rao')!;
  assert.deepEqual([o.epf_wages, o.eps_wages, o.edli_wages, o.ee, o.eps, o.er], [25000, 25000, 25000, 3000, 2083, 917]);
  const t = oct.rows.find((r) => r.name === 'Old Timer')!;
  assert.equal(t.eps_wages, 0);
  assert.equal(t.eps, 0);
  assert.equal(t.er, 3000);
  assert.ok(t.above_age);
  assert.ok(oct.errors.length === 0);

  await saveEmployeeStatutory(c.db, asha.id, { eps_applicable: 0 });
  assert.equal((await ecrFile(c.db, '2026-10-01')).rows.find((r) => r.name === 'Asha Rao')!.eps, 0);
  await saveEmployeeStatutory(c.db, asha.id, { eps_applicable: 1 });

  const st = await pfStatement(c.db, '2026-10-01', '2026-10-31');
  assert.equal(st.ceiling, 25000_00);
  assert.equal(st.accounts.ac1, 9917);
  assert.equal(st.accounts.ac10, 2083);
  assert.equal(st.accounts.ac2, 500);
  assert.equal(st.accounts.ac21, 250);
  const q = await pfStatement(c.db, '2026-08-01', '2026-10-31');
  assert.equal(q.months.length, 3);
  assert.equal(q.rows.find((r) => r.name === 'Asha Rao')!.ee, 1800 + 2360 + 3000);
  const cards = await form3A(c.db, '2026-04-01', '2027-03-31');
  assert.equal(cards.find((x) => x.name === 'Asha Rao')!.months.length, 3);
  assert.equal(ecrLine({ uan: ' 1 ', name: "D'Souza, A.", gross: 1, epf_wages: 1, eps_wages: 1, edli_wages: 1, ee: 0, eps: 0, er: 0, ncp_days: 0, refund: 0 }), '1#~#D SOUZA A.#~#1#~#1#~#1#~#1#~#0#~#0#~#0#~#0#~#0');
});

test('ESI monthly contribution upload rows, reason codes and last working day', async () => {
  const c = await payrollCo();
  const ravi = await createEmployee(c.db, { name: 'Ravi', date_of_joining: '2026-04-01', esi_number: '3101234567' });
  const sita = await createEmployee(c.db, { name: 'Sita', date_of_joining: '2026-04-01', esi_number: '3101234568' });
  for (const e of [ravi, sita]) await setSalaryDetails(c.db, { employee_id: e.id }, '2026-04-01', [{ pay_head_id: c.basic.id, rate: 18000_00, per: 'Months' }, { pay_head_id: c.esi.id, rate: 0, per: 'Months' }]);
  await createPayrollVoucher(c.books, { date: '2026-10-31', account_ledger_id: c.salary, employees: [{ employee_id: ravi.id }] });
  await saveEmployeeTerms(c.db, sita.id, { date_of_leaving: '2026-09-30' });
  const st = await esiStatement(c.db, '2026-10-01', '2026-10-31');
  const r = st.rows.find((x) => x.name === 'Ravi')!;
  assert.equal(r.days, 31);
  assert.equal(r.wages, 18000_00);
  assert.equal(r.ee, 135_00);
  assert.equal(r.er, 585_00);
  assert.equal(r.fixed_wages, 18000_00);
  assert.ok(!st.rows.some((x) => x.name === 'Sita'));
  const up = await esiMonthlyUpload(c.db, '2026-10-01');
  assert.deepEqual(up.rows[0], ESI_MC_HEADERS);
  assert.deepEqual(up.rows[1], ['3101234567', 'Ravi', '31', '18000', '', '']);
  assert.deepEqual(up.errors, []);

  const sep = await esiMonthlyUpload(c.db, '2026-09-01');
  assert.deepEqual(sep.rows.find((x) => x[1] === 'Sita'), ['3101234568', 'Sita', '0', '0', '2', '30/09/2026']);
});
