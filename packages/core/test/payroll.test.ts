import test from 'node:test';
import assert from 'node:assert/strict';
import { Books } from '../src/index.ts';
import {
  attendanceSheet,
  autofillPayroll,
  createAttendanceType,
  createEmployee,
  createEmployeeCategory,
  createEmployeeGroup,
  createPayHead,
  createPayrollVoucher,
  deleteEmployee,
  deleteEmployeeGroup,
  deletePayrollVoucher,
  employeeVouchers,
  paySlip,
  payrollStatement,
  payrollVoucher,
  setAttendance,
  setSalaryDetails,
  statutoryDefaults,
  updatePayrollVoucher,
  computeSalary,
  attendanceTypes,
  payHeads,
  PAYROLL_SCHEMA,
} from '../src/payroll.ts';
import { nodeDb } from '../src/node-adapter.ts';

async function setup() {
  const books = new Books(nodeDb());
  await books.init();
  await books.createCompany({ name: 'Pay Co', fy_start: '2026-04-01', state: 'Karnataka' });
  const db = books.db;
  const groups = await books.groups();
  const salary = (await books.createLedger({ name: 'Salary Payable', group_id: groups.find((g) => g.name === 'Current Liabilities')!.id })).id;
  const present = await createAttendanceType(db, { name: 'Present', kind: 'Attendance / Leave with Pay' });
  const absent = await createAttendanceType(db, { name: 'Absent', kind: 'Attendance / Leave without Pay' });
  const pieces = await createAttendanceType(db, { name: 'Piece Production', kind: 'Production', unit: 'nos' });
  const basic = await createPayHead(books, { name: 'Basic Pay', ph_type: 'Earnings for Employees', calc_type: 'On Attendance', attendance_type_id: present.id });
  const hra = await createPayHead(books, { name: 'House Rent Allowance', ph_type: 'Earnings for Employees', calc_type: 'As Computed Value', compute_basis: 'On Specified Formula', formula: [{ pay_head_id: basic.id, sign: 1 }], rate_bp: 4000 });
  const bonus = await createPayHead(books, { name: 'Bonus', ph_type: 'Bonus', calc_type: 'Flat Rate' });
  const piece = await createPayHead(books, { name: 'Piece Rate', ph_type: 'Earnings for Employees', calc_type: 'On Production', attendance_type_id: pieces.id });
  const pf = await createPayHead(books, { name: 'Employees EPF Deduction @12%', ...statutoryDefaults('PF'), ph_type: "Employees' Statutory Deductions", formula: [{ pay_head_id: basic.id, sign: 1 }] });
  const pt = await createPayHead(books, { name: 'Professional Tax', ...statutoryDefaults('PT'), ph_type: "Employees' Statutory Deductions" });
  const edli = await createPayHead(books, { name: 'Employers EDLI Contribution', ph_type: "Employer's Statutory Contributions", calc_type: 'As Computed Value', compute_basis: 'On Specified Formula', formula: [{ pay_head_id: basic.id, sign: 1 }], rate_bp: 50, ceiling: 15000_00 });
  const sales = await createEmployeeGroup(db, { name: 'Sales', define_salary: false });
  const akhil = await createEmployee(db, { name: 'Akhil', group_id: sales.id, date_of_joining: '2026-04-01', designation: 'Manager', bank_details: true, bank_account: '251589908', bank_branch: 'Koramangala' });
  const shekhar = await createEmployee(db, { name: 'Shekhar R', group_id: sales.id });
  return { books, db, salary, present, absent, pieces, basic, hra, bonus, piece, pf, pt, edli, sales, akhil, shekhar };
}

test('schema is create-if-not-exists and voucher type exists', async () => {
  const { books } = await setup();
  assert.ok(PAYROLL_SCHEMA.every((s) => s.startsWith('CREATE TABLE IF NOT EXISTS')));
  const t = (await books.voucherTypes()).find((x) => x.name === 'Payroll')!;
  assert.equal(t.parent, 'Journal');
  assert.equal((await attendanceTypes(books.db)).length, 3);
  assert.ok((await payHeads(books.db)).length >= 7);
});

test('masters validate and protect', async () => {
  const { db, sales, akhil } = await setup();
  await assert.rejects(() => createEmployeeGroup(db, { name: 'sales' }), /already exists/);
  await assert.rejects(() => createEmployee(db, { name: 'AKHIL' }), /already exists/);
  await assert.rejects(() => deleteEmployeeGroup(db, sales.id), /has employees/);
  await assert.rejects(() => createAttendanceType(db, { name: 'Overtime', kind: 'Production' }), /Unit is required/);
  const cat = await createEmployeeCategory(db, { name: 'Permanent' });
  assert.equal(cat.allocate_revenue, 1);
  await deleteEmployee(db, akhil.id);
});

test('salary computation on attendance, computed, statutory, production', async () => {
  const t = await setup();
  const { db, books } = t;
  await setSalaryDetails(db, { group_id: t.sales.id }, '2026-04-01', [
    { pay_head_id: t.basic.id, rate: 50000_00, per: 'Months' },
    { pay_head_id: t.hra.id, rate: 0, per: 'Months' },
    { pay_head_id: t.bonus.id, rate: 1000_00, per: 'Months' },
    { pay_head_id: t.pf.id, rate: 0, per: 'Months' },
    { pay_head_id: t.pt.id, rate: 0, per: 'Months' },
    { pay_head_id: t.edli.id, rate: 0, per: 'Months' },
  ]);
  await setAttendance(db, { employee_id: t.akhil.id, type_id: t.present.id, date: '2026-04-30', value: 15_000 });
  const lines = await computeSalary(db, t.akhil.id, '2026-04-30');
  const get = (n: string) => lines.find((l) => l.name === n)!;
  assert.equal(get('Basic Pay').amount, 25000_00);
  assert.equal(get('Basic Pay').gross, 50000_00);
  assert.equal(get('House Rent Allowance').amount, 10000_00);
  assert.equal(get('Employees EPF Deduction @12%').amount, 1800_00);
  assert.equal(get('Professional Tax').amount, 200_00);
  assert.equal(get('Employers EDLI Contribution').amount, 75_00);
  assert.equal(get('Bonus').amount, 1000_00);

  await setSalaryDetails(db, { employee_id: t.shekhar.id }, '2026-04-01', [{ pay_head_id: t.piece.id, rate: 12_50, per: 'Days' }]);
  await setAttendance(db, { employee_id: t.shekhar.id, type_id: t.pieces.id, date: '2026-04-30', value: 105_000 });
  assert.equal((await computeSalary(db, t.shekhar.id, '2026-04-30'))[0].amount, 1312_50);
  assert.equal((await computeSalary(db, t.shekhar.id, '2026-04-30'))[0].gross, 1312_50);
  void books;
});

test('payroll voucher posts a balanced accounting voucher and reports', async () => {
  const t = await setup();
  const { db, books } = t;
  await setSalaryDetails(db, { group_id: t.sales.id }, '2026-04-01', [
    { pay_head_id: t.basic.id, rate: 30000_00, per: 'Months' },
    { pay_head_id: t.hra.id, rate: 0, per: 'Months' },
    { pay_head_id: t.pf.id, rate: 0, per: 'Months' },
    { pay_head_id: t.pt.id, rate: 0, per: 'Months' },
    { pay_head_id: t.edli.id, rate: 0, per: 'Months' },
  ]);
  await setAttendance(db, { employee_id: t.akhil.id, type_id: t.present.id, date: '2026-04-30', value: 30_000 });
  await setAttendance(db, { employee_id: t.akhil.id, type_id: t.absent.id, date: '2026-04-30', value: 0 });
  await setAttendance(db, { employee_id: t.shekhar.id, type_id: t.present.id, date: '2026-04-30', value: 15_000 });
  const emps = await autofillPayroll(db, '2026-04-30', { group_id: t.sales.id });
  assert.equal(emps.length, 2);
  const pv = await createPayrollVoucher(books, { date: '2026-04-30', account_ledger_id: t.salary, narration: 'April', employees: emps });
  assert.equal(pv.voucher.type, 'Payroll');
  assert.equal(pv.voucher.entries.reduce((s, e) => s + e.amount, 0), 0);
  const sal = pv.voucher.entries.find((e) => e.ledger_id === t.salary)!;
  const net = 30000_00 + 12000_00 - 1800_00 - 200_00 + (15000_00 + 6000_00 - 1800_00 - 200_00);
  assert.equal(sal.amount, -net);
  const edli = pv.voucher.entries.find((e) => e.ledger === 'Employers EDLI Contribution Payable')!;
  assert.equal(edli.amount, -(75_00 + 75_00));

  const ev = await employeeVouchers(db, t.akhil.id, '2026-04-01', '2026-04-30');
  assert.equal(ev.rows.length, 1);
  assert.equal(ev.credit, 2000_00);
  const only = await employeeVouchers(db, t.akhil.id, '2026-04-01', '2026-04-30', t.pf.id);
  assert.equal(only.credit, 1800_00);

  const st = await payrollStatement(db, '2026-04-01', '2026-04-30', [t.basic.id]);
  assert.equal(st.rows[0].name, 'Primary Cost Category');
  assert.equal(st.rows[0].values[t.basic.id], 45000_00);
  assert.equal(st.rows.find((r) => r.name === 'Sales')!.values[t.basic.id], 45000_00);

  const sheet = await attendanceSheet(db, '2026-04-01', '2026-04-30');
  assert.equal(sheet.rows[0].values[t.present.id], 45_000);
  assert.deepEqual(sheet.columns.map((c) => c.name), ['Absent', 'Piece Production', 'Present']);
  assert.equal(sheet.columns[1].unit, 'nos');

  const slip = (await paySlip(db, t.akhil.id, '2026-04-01', '2026-04-30'))!;
  assert.equal(slip.title, 'Pay Slip for April-2026');
  assert.equal(slip.total_earnings, 42000_00);
  assert.equal(slip.total_deductions, 2000_00);
  assert.equal(slip.net, 40000_00);
  assert.equal(slip.attendance[0].unit, 'Days');
  assert.equal(slip.earnings[0].gross, 30000_00);

  const upd = await updatePayrollVoucher(books, pv.voucher.id, { date: '2026-04-30', account_ledger_id: t.salary, employees: [{ employee_id: t.akhil.id, lines: [{ pay_head_id: t.basic.id, amount: 10000_00 }] }] });
  assert.equal(upd.lines.length, 1);
  assert.equal((await payrollVoucher(books, pv.voucher.id))!.voucher.entries.length, 2);
  await assert.rejects(() => deleteEmployee(db, t.akhil.id), /has payroll vouchers/);
  await deletePayrollVoucher(books, pv.voucher.id);
  assert.equal(await payrollVoucher(books, pv.voucher.id), null);
  await deleteEmployee(db, t.akhil.id);
});

test('payroll voucher validation', async () => {
  const t = await setup();
  await assert.rejects(() => createPayrollVoucher(t.books, { date: '2026-04-30', account_ledger_id: t.salary, employees: [] }), /at least one employee/);
  await assert.rejects(() => createPayrollVoucher(t.books, { date: '2026-04-30', account_ledger_id: t.salary, employees: [{ employee_id: t.akhil.id }] }), /at least one pay head/);
  await assert.rejects(() => createPayHead(t.books, { name: 'X', ph_type: 'Earnings for Employees', calc_type: 'On Attendance' }), /attendance/);
  await assert.rejects(() => createPayHead(t.books, { name: 'basic pay', ph_type: 'Earnings for Employees' }), /already exists/);
});
