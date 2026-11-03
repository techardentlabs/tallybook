import { CoreError, one, type Db, type Stmt } from './db.ts';
import { clean, newGuid } from './util.ts';
import type { Books, VoucherRow } from './books.ts';
import { QTY_SCALE } from './inventory.ts';

export const PAYROLL_VOUCHER_TYPE = 'Payroll';

export const PAYROLL_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS pr_emp_groups (
    id INTEGER PRIMARY KEY,
    guid TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    alias TEXT NOT NULL DEFAULT '',
    parent_id INTEGER REFERENCES pr_emp_groups(id),
    define_salary INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS pr_emp_categories (
    id INTEGER PRIMARY KEY,
    guid TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    alias TEXT NOT NULL DEFAULT '',
    allocate_revenue INTEGER NOT NULL DEFAULT 1,
    allocate_non_revenue INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS pr_employees (
    id INTEGER PRIMARY KEY,
    guid TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    alias TEXT NOT NULL DEFAULT '',
    group_id INTEGER REFERENCES pr_emp_groups(id),
    date_of_joining TEXT NOT NULL DEFAULT '',
    define_salary INTEGER NOT NULL DEFAULT 0,
    emp_number TEXT NOT NULL DEFAULT '',
    designation TEXT NOT NULL DEFAULT '',
    function TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    gender TEXT NOT NULL DEFAULT '',
    date_of_birth TEXT NOT NULL DEFAULT '',
    blood_group TEXT NOT NULL DEFAULT '',
    parent_name TEXT NOT NULL DEFAULT '',
    spouse_name TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    pan TEXT NOT NULL DEFAULT '',
    aadhaar TEXT NOT NULL DEFAULT '',
    uan TEXT NOT NULL DEFAULT '',
    pf_number TEXT NOT NULL DEFAULT '',
    pran TEXT NOT NULL DEFAULT '',
    esi_number TEXT NOT NULL DEFAULT '',
    bank_details INTEGER NOT NULL DEFAULT 0,
    bank_name TEXT NOT NULL DEFAULT '',
    bank_account TEXT NOT NULL DEFAULT '',
    bank_ifsc TEXT NOT NULL DEFAULT '',
    bank_branch TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS pr_attendance_types (
    id INTEGER PRIMARY KEY,
    guid TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    alias TEXT NOT NULL DEFAULT '',
    parent_id INTEGER REFERENCES pr_attendance_types(id),
    kind TEXT NOT NULL,
    period_type TEXT NOT NULL DEFAULT 'Days',
    unit TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS pr_pay_heads (
    id INTEGER PRIMARY KEY,
    guid TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    alias TEXT NOT NULL DEFAULT '',
    ph_type TEXT NOT NULL,
    income_type TEXT NOT NULL DEFAULT 'Fixed',
    group_id INTEGER NOT NULL,
    ledger_id INTEGER NOT NULL,
    payable_ledger_id INTEGER,
    affect_net INTEGER NOT NULL DEFAULT 1,
    display_name TEXT NOT NULL DEFAULT '',
    gratuity INTEGER NOT NULL DEFAULT 0,
    calc_type TEXT NOT NULL DEFAULT 'As User Defined Value',
    attendance_type_id INTEGER REFERENCES pr_attendance_types(id),
    calc_period TEXT NOT NULL DEFAULT 'Months',
    basis TEXT NOT NULL DEFAULT 'As per Calendar Period',
    basis_unit_id INTEGER REFERENCES pr_attendance_types(id),
    compute_basis TEXT NOT NULL DEFAULT 'Specified Formula',
    formula TEXT NOT NULL DEFAULT '[]',
    rate_bp INTEGER NOT NULL DEFAULT 0,
    ceiling INTEGER NOT NULL DEFAULT 0,
    max_base INTEGER NOT NULL DEFAULT 0,
    slabs TEXT NOT NULL DEFAULT '[]',
    statutory TEXT NOT NULL DEFAULT '',
    rounding TEXT NOT NULL DEFAULT 'Not Applicable',
    rounding_limit INTEGER NOT NULL DEFAULT 100
  )`,
  `CREATE TABLE IF NOT EXISTS pr_salary (
    id INTEGER PRIMARY KEY,
    employee_id INTEGER REFERENCES pr_employees(id),
    group_id INTEGER REFERENCES pr_emp_groups(id),
    effective_from TEXT NOT NULL,
    pay_head_id INTEGER NOT NULL REFERENCES pr_pay_heads(id),
    rate INTEGER NOT NULL DEFAULT 0,
    per TEXT NOT NULL DEFAULT 'Months',
    seq INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS pr_attendance (
    id INTEGER PRIMARY KEY,
    employee_id INTEGER NOT NULL REFERENCES pr_employees(id),
    type_id INTEGER NOT NULL REFERENCES pr_attendance_types(id),
    date TEXT NOT NULL,
    value INTEGER NOT NULL,
    UNIQUE (employee_id, type_id, date)
  )`,
  `CREATE TABLE IF NOT EXISTS pr_vouchers (
    voucher_id INTEGER PRIMARY KEY,
    account_ledger_id INTEGER NOT NULL,
    period_from TEXT NOT NULL,
    period_to TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS pr_voucher_lines (
    id INTEGER PRIMARY KEY,
    voucher_id INTEGER NOT NULL,
    employee_id INTEGER NOT NULL REFERENCES pr_employees(id),
    pay_head_id INTEGER NOT NULL REFERENCES pr_pay_heads(id),
    side TEXT NOT NULL,
    amount INTEGER NOT NULL,
    seq INTEGER NOT NULL
  )`,
];

export const PAY_HEAD_TYPES = [
  'Earnings for Employees',
  'Deductions from Employees',
  "Employees' Statutory Deductions",
  "Employees' Other Charges",
  "Employer's Statutory Contributions",
  "Employer's Other Charges",
  'Gratuity',
  'Bonus',
  'Loans and Advances',
  'Reimbursements to Employees',
] as const;
export const CALC_TYPES = ['As Computed Value', 'As User Defined Value', 'Flat Rate', 'On Attendance', 'On Production'] as const;
export const INCOME_TYPES = ['Fixed', 'Variable'] as const;
export const CALC_PERIODS = ['Days', 'Weeks', 'Months'] as const;
export const BASIS_OPTIONS = ['As per Calendar Period', 'User Defined Calendar Type'] as const;
export const COMPUTE_BASES = ['On Specified Formula', 'On Current Earnings Total', 'On Current Deductions Total'] as const;
export const ROUNDING_METHODS = ['Not Applicable', 'Normal Rounding', 'Downward Rounding', 'Upward Rounding'] as const;
export const ATTENDANCE_KINDS = ['Attendance / Leave with Pay', 'Attendance / Leave without Pay', 'Production', 'User Defined Calendar Type'] as const;
export const PER_OPTIONS = ['Days', 'Weeks', 'Months', 'Hours'] as const;
export const STATUTORY_KINDS = ['', 'PF', 'ESI', 'PT'] as const;

export type PayHeadSide = 'earn' | 'ded' | 'emp';

export function payHeadSide(type: string): PayHeadSide {
  if (type === 'Earnings for Employees' || type === 'Bonus' || type === 'Reimbursements to Employees') return 'earn';
  if (type === "Employer's Statutory Contributions" || type === "Employer's Other Charges" || type === 'Gratuity') return 'emp';
  return 'ded';
}

export interface EmployeeGroup {
  id: number;
  guid: string;
  name: string;
  alias: string;
  parent_id: number | null;
  define_salary: number;
}
export interface EmployeeCategory {
  id: number;
  guid: string;
  name: string;
  alias: string;
  allocate_revenue: number;
  allocate_non_revenue: number;
}
export interface Employee {
  id: number;
  guid: string;
  name: string;
  alias: string;
  group_id: number | null;
  date_of_joining: string;
  define_salary: number;
  emp_number: string;
  designation: string;
  function: string;
  location: string;
  gender: string;
  date_of_birth: string;
  blood_group: string;
  parent_name: string;
  spouse_name: string;
  address: string;
  phone: string;
  email: string;
  pan: string;
  aadhaar: string;
  uan: string;
  pf_number: string;
  pran: string;
  esi_number: string;
  bank_details: number;
  bank_name: string;
  bank_account: string;
  bank_ifsc: string;
  bank_branch: string;
}
export interface AttendanceType {
  id: number;
  guid: string;
  name: string;
  alias: string;
  parent_id: number | null;
  kind: string;
  period_type: string;
  unit: string;
}
export interface FormulaTerm {
  pay_head_id: number;
  sign: 1 | -1;
}
export interface Slab {
  from: number;
  to: number;
  amount: number;
}
export interface PayHead {
  id: number;
  guid: string;
  name: string;
  alias: string;
  ph_type: string;
  income_type: string;
  group_id: number;
  ledger_id: number;
  payable_ledger_id: number | null;
  affect_net: number;
  display_name: string;
  gratuity: number;
  calc_type: string;
  attendance_type_id: number | null;
  calc_period: string;
  basis: string;
  basis_unit_id: number | null;
  compute_basis: string;
  formula: FormulaTerm[];
  rate_bp: number;
  ceiling: number;
  max_base: number;
  slabs: Slab[];
  statutory: string;
  rounding: string;
  rounding_limit: number;
}
export interface SalaryLine {
  pay_head_id: number;
  rate: number;
  per: string;
}
export interface SalaryRow extends SalaryLine {
  id: number;
  effective_from: string;
  seq: number;
}
export type SalaryOwner = { employee_id: number } | { group_id: number };

async function nextId(db: Db, table: string): Promise<number> {
  return ((await one<{ m: number }>(db, `SELECT COALESCE(MAX(id), 0) AS m FROM ${table}`))!.m) + 1;
}

const bool = (v: unknown) => (v ? 1 : 0);
const inList = (v: string, list: readonly string[], label: string) => {
  if (!list.includes(v)) throw new CoreError('invalid', `${label} is not valid`);
  return v;
};

export async function ensurePayroll(db: Db): Promise<void> {
  await db.batch(PAYROLL_SCHEMA.map((sql) => ({ sql })));
  const have = await one(db, 'SELECT 1 FROM voucher_types WHERE name = ? COLLATE NOCASE', [PAYROLL_VOUCHER_TYPE]);
  if (!have) {
    const id = await nextId(db, 'voucher_types');
    await db.batch([{ sql: 'INSERT INTO voucher_types (id, guid, name, parent, is_system) VALUES (?, ?, ?, ?, 0)', params: [id, newGuid(), PAYROLL_VOUCHER_TYPE, 'Journal'] }]);
  }
}

export async function payrollVoucherTypeId(db: Db): Promise<number> {
  await ensurePayroll(db);
  return (await one<{ id: number }>(db, 'SELECT id FROM voucher_types WHERE name = ? COLLATE NOCASE', [PAYROLL_VOUCHER_TYPE]))!.id;
}

async function checkParentChain(db: Db, table: string, id: number, parent: number | null) {
  let cur = parent;
  while (cur) {
    if (cur === id) throw new CoreError('invalid', 'A group cannot be placed under itself');
    cur = (await one<{ parent_id: number | null }>(db, `SELECT parent_id FROM ${table} WHERE id = ?`, [cur]))?.parent_id ?? null;
  }
}

export async function employeeGroups(db: Db): Promise<EmployeeGroup[]> {
  await ensurePayroll(db);
  return db.select<EmployeeGroup>('SELECT * FROM pr_emp_groups ORDER BY name COLLATE NOCASE');
}

export async function employeeGroup(db: Db, id: number): Promise<EmployeeGroup | null> {
  await ensurePayroll(db);
  return (await one<EmployeeGroup>(db, 'SELECT * FROM pr_emp_groups WHERE id = ?', [id])) ?? null;
}

export async function createEmployeeGroup(db: Db, input: { name: string; alias?: string; parent_id?: number | null; define_salary?: boolean }): Promise<EmployeeGroup> {
  await ensurePayroll(db);
  const name = clean(input.name, 100);
  if (!name) throw new CoreError('invalid', 'Employee group name is required');
  if (await one(db, 'SELECT 1 FROM pr_emp_groups WHERE name = ? COLLATE NOCASE', [name])) throw new CoreError('conflict', `Employee group "${name}" already exists`);
  if (input.parent_id && !(await employeeGroup(db, input.parent_id))) throw new CoreError('invalid', 'Unknown parent group');
  const id = await nextId(db, 'pr_emp_groups');
  await db.batch([{ sql: 'INSERT INTO pr_emp_groups (id, guid, name, alias, parent_id, define_salary) VALUES (?, ?, ?, ?, ?, ?)', params: [id, newGuid(), name, clean(input.alias, 100), input.parent_id || null, bool(input.define_salary)] }]);
  return (await employeeGroup(db, id))!;
}

export async function updateEmployeeGroup(db: Db, id: number, input: { name: string; alias?: string; parent_id?: number | null; define_salary?: boolean }): Promise<EmployeeGroup> {
  const cur = await employeeGroup(db, id);
  if (!cur) throw new CoreError('not_found', 'Employee group not found');
  const name = clean(input.name, 100);
  if (!name) throw new CoreError('invalid', 'Employee group name is required');
  if (await one(db, 'SELECT 1 FROM pr_emp_groups WHERE name = ? COLLATE NOCASE AND id != ?', [name, id])) throw new CoreError('conflict', `Employee group "${name}" already exists`);
  await checkParentChain(db, 'pr_emp_groups', id, input.parent_id || null);
  await db.batch([{ sql: 'UPDATE pr_emp_groups SET name = ?, alias = ?, parent_id = ?, define_salary = ? WHERE id = ?', params: [name, clean(input.alias, 100), input.parent_id || null, bool(input.define_salary), id] }]);
  return (await employeeGroup(db, id))!;
}

export async function deleteEmployeeGroup(db: Db, id: number): Promise<void> {
  if (!(await employeeGroup(db, id))) throw new CoreError('not_found', 'Employee group not found');
  if (await one(db, 'SELECT 1 FROM pr_emp_groups WHERE parent_id = ?', [id])) throw new CoreError('conflict', 'Employee group has sub-groups');
  if (await one(db, 'SELECT 1 FROM pr_employees WHERE group_id = ?', [id])) throw new CoreError('conflict', 'Employee group has employees');
  await db.batch([
    { sql: 'DELETE FROM pr_salary WHERE group_id = ?', params: [id] },
    { sql: 'DELETE FROM pr_emp_groups WHERE id = ?', params: [id] },
  ]);
}

export async function employeeCategories(db: Db): Promise<EmployeeCategory[]> {
  await ensurePayroll(db);
  return db.select<EmployeeCategory>('SELECT * FROM pr_emp_categories ORDER BY name COLLATE NOCASE');
}

export async function createEmployeeCategory(db: Db, input: { name: string; alias?: string; allocate_revenue?: boolean; allocate_non_revenue?: boolean }): Promise<EmployeeCategory> {
  await ensurePayroll(db);
  const name = clean(input.name, 100);
  if (!name) throw new CoreError('invalid', 'Employee category name is required');
  if (await one(db, 'SELECT 1 FROM pr_emp_categories WHERE name = ? COLLATE NOCASE', [name])) throw new CoreError('conflict', `Employee category "${name}" already exists`);
  const id = await nextId(db, 'pr_emp_categories');
  await db.batch([
    {
      sql: 'INSERT INTO pr_emp_categories (id, guid, name, alias, allocate_revenue, allocate_non_revenue) VALUES (?, ?, ?, ?, ?, ?)',
      params: [id, newGuid(), name, clean(input.alias, 100), input.allocate_revenue === false ? 0 : 1, bool(input.allocate_non_revenue)],
    },
  ]);
  return (await one<EmployeeCategory>(db, 'SELECT * FROM pr_emp_categories WHERE id = ?', [id]))!;
}

export async function updateEmployeeCategory(db: Db, id: number, input: { name: string; alias?: string; allocate_revenue?: boolean; allocate_non_revenue?: boolean }): Promise<EmployeeCategory> {
  await ensurePayroll(db);
  if (!(await one(db, 'SELECT 1 FROM pr_emp_categories WHERE id = ?', [id]))) throw new CoreError('not_found', 'Employee category not found');
  const name = clean(input.name, 100);
  if (!name) throw new CoreError('invalid', 'Employee category name is required');
  if (await one(db, 'SELECT 1 FROM pr_emp_categories WHERE name = ? COLLATE NOCASE AND id != ?', [name, id])) throw new CoreError('conflict', `Employee category "${name}" already exists`);
  await db.batch([
    {
      sql: 'UPDATE pr_emp_categories SET name = ?, alias = ?, allocate_revenue = ?, allocate_non_revenue = ? WHERE id = ?',
      params: [name, clean(input.alias, 100), input.allocate_revenue === false ? 0 : 1, bool(input.allocate_non_revenue), id],
    },
  ]);
  return (await one<EmployeeCategory>(db, 'SELECT * FROM pr_emp_categories WHERE id = ?', [id]))!;
}

export async function deleteEmployeeCategory(db: Db, id: number): Promise<void> {
  await ensurePayroll(db);
  await db.batch([{ sql: 'DELETE FROM pr_emp_categories WHERE id = ?', params: [id] }]);
}

const EMP_TEXT = ['alias', 'emp_number', 'designation', 'function', 'location', 'gender', 'blood_group', 'parent_name', 'spouse_name', 'address', 'phone', 'email', 'pan', 'aadhaar', 'uan', 'pf_number', 'pran', 'esi_number', 'bank_name', 'bank_account', 'bank_ifsc', 'bank_branch'] as const;
export type EmployeeInput = Partial<Omit<Employee, 'id' | 'guid' | 'bank_details' | 'define_salary'>> & { name: string; bank_details?: boolean | number; define_salary?: boolean | number };

function employeeValues(input: EmployeeInput): (string | number | null)[] {
  const name = clean(input.name, 100);
  if (!name) throw new CoreError('invalid', 'Employee name is required');
  const joining = input.date_of_joining ?? '';
  if (joining && !/^\d{4}-\d{2}-\d{2}$/.test(joining)) throw new CoreError('invalid', 'Date of joining is invalid');
  const dob = input.date_of_birth ?? '';
  if (dob && !/^\d{4}-\d{2}-\d{2}$/.test(dob)) throw new CoreError('invalid', 'Date of birth is invalid');
  return [name, input.group_id || null, joining, bool(input.define_salary), dob, bool(input.bank_details), ...EMP_TEXT.map((k) => clean(input[k], k === 'address' ? 300 : 100))];
}

const EMP_COLS = ['name', 'group_id', 'date_of_joining', 'define_salary', 'date_of_birth', 'bank_details', ...EMP_TEXT];

export async function employees(db: Db): Promise<Employee[]> {
  await ensurePayroll(db);
  return db.select<Employee>('SELECT * FROM pr_employees ORDER BY name COLLATE NOCASE');
}

export async function employee(db: Db, id: number): Promise<Employee | null> {
  await ensurePayroll(db);
  return (await one<Employee>(db, 'SELECT * FROM pr_employees WHERE id = ?', [id])) ?? null;
}

export async function createEmployee(db: Db, input: EmployeeInput): Promise<Employee> {
  await ensurePayroll(db);
  const vals = employeeValues(input);
  if (await one(db, 'SELECT 1 FROM pr_employees WHERE name = ? COLLATE NOCASE', [vals[0]])) throw new CoreError('conflict', `Employee "${vals[0]}" already exists`);
  if (input.group_id && !(await employeeGroup(db, input.group_id))) throw new CoreError('invalid', 'Unknown employee group');
  const id = await nextId(db, 'pr_employees');
  await db.batch([{ sql: `INSERT INTO pr_employees (id, guid, ${EMP_COLS.join(', ')}) VALUES (?, ?, ${EMP_COLS.map(() => '?').join(', ')})`, params: [id, newGuid(), ...vals] }]);
  return (await employee(db, id))!;
}

export async function updateEmployee(db: Db, id: number, input: EmployeeInput): Promise<Employee> {
  if (!(await employee(db, id))) throw new CoreError('not_found', 'Employee not found');
  const vals = employeeValues(input);
  if (await one(db, 'SELECT 1 FROM pr_employees WHERE name = ? COLLATE NOCASE AND id != ?', [vals[0], id])) throw new CoreError('conflict', `Employee "${vals[0]}" already exists`);
  await db.batch([{ sql: `UPDATE pr_employees SET ${EMP_COLS.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, params: [...vals, id] }]);
  return (await employee(db, id))!;
}

export async function deleteEmployee(db: Db, id: number): Promise<void> {
  if (!(await employee(db, id))) throw new CoreError('not_found', 'Employee not found');
  if (await one(db, 'SELECT 1 FROM pr_voucher_lines WHERE employee_id = ?', [id])) throw new CoreError('conflict', 'Employee has payroll vouchers');
  await db.batch([
    { sql: 'DELETE FROM pr_salary WHERE employee_id = ?', params: [id] },
    { sql: 'DELETE FROM pr_attendance WHERE employee_id = ?', params: [id] },
    { sql: 'DELETE FROM pr_employees WHERE id = ?', params: [id] },
  ]);
}

export async function attendanceTypes(db: Db): Promise<AttendanceType[]> {
  await ensurePayroll(db);
  return db.select<AttendanceType>('SELECT * FROM pr_attendance_types ORDER BY name COLLATE NOCASE');
}

export async function attendanceType(db: Db, id: number): Promise<AttendanceType | null> {
  await ensurePayroll(db);
  return (await one<AttendanceType>(db, 'SELECT * FROM pr_attendance_types WHERE id = ?', [id])) ?? null;
}

export type AttendanceTypeInput = { name: string; alias?: string; parent_id?: number | null; kind: string; period_type?: string; unit?: string };

function attendanceValues(input: AttendanceTypeInput) {
  const name = clean(input.name, 100);
  if (!name) throw new CoreError('invalid', 'Attendance/Production type name is required');
  const kind = inList(input.kind, ATTENDANCE_KINDS, 'Attendance type');
  const production = kind === 'Production';
  const unit = production ? clean(input.unit, 20) : '';
  if (production && !unit) throw new CoreError('invalid', 'Unit is required for a production type');
  const period = production ? '' : inList(input.period_type ?? 'Days', ['Days', 'Hours'], 'Period type');
  return { name, kind, unit, period };
}

export async function createAttendanceType(db: Db, input: AttendanceTypeInput): Promise<AttendanceType> {
  await ensurePayroll(db);
  const v = attendanceValues(input);
  if (await one(db, 'SELECT 1 FROM pr_attendance_types WHERE name = ? COLLATE NOCASE', [v.name])) throw new CoreError('conflict', `"${v.name}" already exists`);
  const id = await nextId(db, 'pr_attendance_types');
  await db.batch([
    { sql: 'INSERT INTO pr_attendance_types (id, guid, name, alias, parent_id, kind, period_type, unit) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', params: [id, newGuid(), v.name, clean(input.alias, 100), input.parent_id || null, v.kind, v.period, v.unit] },
  ]);
  return (await attendanceType(db, id))!;
}

export async function updateAttendanceType(db: Db, id: number, input: AttendanceTypeInput): Promise<AttendanceType> {
  if (!(await attendanceType(db, id))) throw new CoreError('not_found', 'Attendance/Production type not found');
  const v = attendanceValues(input);
  if (await one(db, 'SELECT 1 FROM pr_attendance_types WHERE name = ? COLLATE NOCASE AND id != ?', [v.name, id])) throw new CoreError('conflict', `"${v.name}" already exists`);
  await checkParentChain(db, 'pr_attendance_types', id, input.parent_id || null);
  await db.batch([
    { sql: 'UPDATE pr_attendance_types SET name = ?, alias = ?, parent_id = ?, kind = ?, period_type = ?, unit = ? WHERE id = ?', params: [v.name, clean(input.alias, 100), input.parent_id || null, v.kind, v.period, v.unit, id] },
  ]);
  return (await attendanceType(db, id))!;
}

export async function deleteAttendanceType(db: Db, id: number): Promise<void> {
  if (!(await attendanceType(db, id))) throw new CoreError('not_found', 'Attendance/Production type not found');
  if (await one(db, 'SELECT 1 FROM pr_pay_heads WHERE attendance_type_id = ? OR basis_unit_id = ?', [id, id])) throw new CoreError('conflict', 'Type is used in a pay head');
  await db.batch([
    { sql: 'DELETE FROM pr_attendance WHERE type_id = ?', params: [id] },
    { sql: 'DELETE FROM pr_attendance_types WHERE id = ?', params: [id] },
  ]);
}

export function attendanceUnit(t: Pick<AttendanceType, 'kind' | 'period_type' | 'unit'>): string {
  return t.kind === 'Production' ? t.unit : t.period_type || 'Days';
}

export function statutoryDefaults(kind: string): Partial<PayHeadInput> {
  if (kind === 'PF') return { ph_type: "Employees' Statutory Deductions", calc_type: 'As Computed Value', compute_basis: 'On Specified Formula', rate_bp: 1200, ceiling: 15000_00, statutory: 'PF' };
  if (kind === 'ESI') return { ph_type: "Employees' Statutory Deductions", calc_type: 'As Computed Value', compute_basis: 'On Current Earnings Total', rate_bp: 75, max_base: 21000_00, statutory: 'ESI' };
  if (kind === 'PT')
    return {
      ph_type: "Employees' Statutory Deductions",
      calc_type: 'As Computed Value',
      compute_basis: 'On Current Earnings Total',
      slabs: [
        { from: 0, to: 7500_00, amount: 0 },
        { from: 7500_01, to: 10000_00, amount: 175_00 },
        { from: 10000_01, to: 0, amount: 200_00 },
      ],
      statutory: 'PT',
    };
  return {};
}

export type PayHeadInput = Partial<Omit<PayHead, 'id' | 'guid' | 'ledger_id' | 'payable_ledger_id' | 'affect_net' | 'gratuity'>> & {
  name: string;
  ph_type: string;
  affect_net?: boolean;
  gratuity?: boolean;
};

interface PayHeadRow extends Omit<PayHead, 'formula' | 'slabs'> {
  formula: string;
  slabs: string;
}

const toPayHead = (r: PayHeadRow): PayHead => ({ ...r, formula: JSON.parse(r.formula || '[]'), slabs: JSON.parse(r.slabs || '[]') });

export async function payHeads(db: Db): Promise<PayHead[]> {
  await ensurePayroll(db);
  return (await db.select<PayHeadRow>('SELECT * FROM pr_pay_heads ORDER BY id')).map(toPayHead);
}

export async function payHead(db: Db, id: number): Promise<PayHead | null> {
  await ensurePayroll(db);
  const r = await one<PayHeadRow>(db, 'SELECT * FROM pr_pay_heads WHERE id = ?', [id]);
  return r ? toPayHead(r) : null;
}

async function groupIdByName(db: Db, name: string): Promise<number> {
  const g = await one<{ id: number }>(db, 'SELECT id FROM groups WHERE name = ? COLLATE NOCASE', [name]);
  if (!g) throw new CoreError('invalid', `Group "${name}" not found`);
  return g.id;
}

export async function defaultPayHeadGroupId(db: Db, phType: string): Promise<number> {
  const side = payHeadSide(phType);
  if (phType === 'Loans and Advances') return groupIdByName(db, 'Loans & Advances (Asset)');
  return groupIdByName(db, side === 'ded' ? 'Current Liabilities' : 'Indirect Expenses');
}

function payHeadValues(input: PayHeadInput) {
  const ph_type = inList(input.ph_type, PAY_HEAD_TYPES, 'Pay head type');
  const side = payHeadSide(ph_type);
  const calc_type = inList(input.calc_type ?? 'As User Defined Value', CALC_TYPES, 'Calculation type');
  const calc_period = inList(input.calc_period ?? 'Months', CALC_PERIODS, 'Calculation period');
  const basis = inList(input.basis ?? BASIS_OPTIONS[0], BASIS_OPTIONS, 'Basis of calculation');
  const compute_basis = inList(input.compute_basis ?? COMPUTE_BASES[0], COMPUTE_BASES, 'Compute basis');
  const rounding = inList(input.rounding ?? 'Not Applicable', ROUNDING_METHODS, 'Rounding method');
  const statutory = inList(input.statutory ?? '', STATUTORY_KINDS, 'Statutory kind');
  if ((calc_type === 'On Attendance' || calc_type === 'On Production') && !input.attendance_type_id) throw new CoreError('invalid', 'Select the attendance/production type');
  if (basis === 'User Defined Calendar Type' && calc_type === 'On Attendance' && !input.basis_unit_id) throw new CoreError('invalid', 'Select the calendar type');
  if (calc_type === 'As Computed Value' && compute_basis === 'On Specified Formula' && !(input.formula?.length)) throw new CoreError('invalid', 'Specify the pay heads to compute on');
  if (calc_type === 'As Computed Value' && !input.rate_bp && !input.slabs?.length) throw new CoreError('invalid', 'Enter a percentage or slab values');
  const affect = side === 'earn' ? input.affect_net !== false : side === 'ded' ? true : false;
  const name = clean(input.name, 100);
  if (!name) throw new CoreError('invalid', 'Pay head name is required');
  return { name, ph_type, side, calc_type, calc_period, basis, compute_basis, rounding, statutory, affect };
}

const PH_COLS = 'alias, ph_type, income_type, group_id, affect_net, display_name, gratuity, calc_type, attendance_type_id, calc_period, basis, basis_unit_id, compute_basis, formula, rate_bp, ceiling, max_base, slabs, statutory, rounding, rounding_limit';

function phParams(input: PayHeadInput, v: ReturnType<typeof payHeadValues>, groupId: number) {
  const computed = v.calc_type === 'As Computed Value';
  return [
    clean(input.alias, 100),
    v.ph_type,
    v.side === 'earn' ? inList(input.income_type ?? 'Fixed', INCOME_TYPES, 'Income type') : 'Fixed',
    groupId,
    bool(v.affect),
    clean(input.display_name, 100) || v.name,
    bool(input.gratuity),
    v.calc_type,
    v.calc_type === 'On Attendance' || v.calc_type === 'On Production' ? input.attendance_type_id! : null,
    v.calc_type === 'On Attendance' ? v.calc_period : 'Months',
    v.calc_type === 'On Attendance' ? v.basis : BASIS_OPTIONS[0],
    v.calc_type === 'On Attendance' && v.basis === 'User Defined Calendar Type' ? input.basis_unit_id! : null,
    v.compute_basis,
    JSON.stringify(computed && v.compute_basis === 'On Specified Formula' ? input.formula ?? [] : []),
    computed ? Math.max(0, Math.round(input.rate_bp ?? 0)) : 0,
    computed ? Math.max(0, Math.round(input.ceiling ?? 0)) : 0,
    computed ? Math.max(0, Math.round(input.max_base ?? 0)) : 0,
    JSON.stringify(computed ? input.slabs ?? [] : []),
    v.statutory,
    v.rounding,
    v.rounding === 'Not Applicable' ? 100 : Math.max(1, Math.round(input.rounding_limit ?? 100)),
  ] as (string | number | null)[];
}

export async function createPayHead(books: Books, input: PayHeadInput): Promise<PayHead> {
  const db = books.db;
  await ensurePayroll(db);
  const v = payHeadValues(input);
  if (await one(db, 'SELECT 1 FROM pr_pay_heads WHERE name = ? COLLATE NOCASE', [v.name])) throw new CoreError('conflict', `Pay head "${v.name}" already exists`);
  const groupId = input.group_id || (await defaultPayHeadGroupId(db, v.ph_type));
  const ledger = await books.createLedger({ name: v.name, group_id: groupId, alias: clean(input.alias, 100) });
  let payable: number | null = null;
  if (v.side === 'emp' || (v.side === 'earn' && !v.affect)) {
    const p = await books.createLedger({ name: `${v.name} Payable`, group_id: await groupIdByName(db, 'Current Liabilities') });
    payable = p.id;
  }
  const id = await nextId(db, 'pr_pay_heads');
  await db.batch([
    {
      sql: `INSERT INTO pr_pay_heads (id, guid, name, ledger_id, payable_ledger_id, ${PH_COLS}) VALUES (?, ?, ?, ?, ?, ${PH_COLS.split(',').map(() => '?').join(', ')})`,
      params: [id, newGuid(), v.name, ledger.id, payable, ...phParams(input, v, groupId)],
    },
  ]);
  return (await payHead(db, id))!;
}

export async function updatePayHead(books: Books, id: number, input: PayHeadInput): Promise<PayHead> {
  const db = books.db;
  const cur = await payHead(db, id);
  if (!cur) throw new CoreError('not_found', 'Pay head not found');
  const v = payHeadValues(input);
  if (await one(db, 'SELECT 1 FROM pr_pay_heads WHERE name = ? COLLATE NOCASE AND id != ?', [v.name, id])) throw new CoreError('conflict', `Pay head "${v.name}" already exists`);
  if (v.ph_type !== cur.ph_type && (await one(db, 'SELECT 1 FROM pr_voucher_lines WHERE pay_head_id = ?', [id]))) throw new CoreError('conflict', 'Pay head type cannot change after use in vouchers');
  const groupId = input.group_id || cur.group_id;
  await books.updateLedger(cur.ledger_id, { name: v.name, group_id: groupId, alias: clean(input.alias, 100) });
  await db.batch([
    {
      sql: `UPDATE pr_pay_heads SET name = ?, ${PH_COLS.split(', ').map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
      params: [v.name, ...phParams(input, v, groupId), id],
    },
  ]);
  return (await payHead(db, id))!;
}

export async function deletePayHead(books: Books, id: number): Promise<void> {
  const db = books.db;
  const cur = await payHead(db, id);
  if (!cur) throw new CoreError('not_found', 'Pay head not found');
  if (await one(db, 'SELECT 1 FROM pr_voucher_lines WHERE pay_head_id = ?', [id])) throw new CoreError('conflict', 'Pay head is used in payroll vouchers');
  const refs = (await payHeads(db)).some((p) => p.id !== id && p.formula.some((f) => f.pay_head_id === id));
  if (refs) throw new CoreError('conflict', 'Pay head is used in another pay head formula');
  await db.batch([
    { sql: 'DELETE FROM pr_salary WHERE pay_head_id = ?', params: [id] },
    { sql: 'DELETE FROM pr_pay_heads WHERE id = ?', params: [id] },
  ]);
  await books.deleteLedger(cur.ledger_id);
  if (cur.payable_ledger_id) await books.deleteLedger(cur.payable_ledger_id);
}

function ownerWhere(owner: SalaryOwner): { sql: string; id: number } {
  return 'employee_id' in owner ? { sql: 'employee_id = ?', id: owner.employee_id } : { sql: 'group_id = ?', id: owner.group_id };
}

export async function salaryDetails(db: Db, owner: SalaryOwner): Promise<SalaryRow[]> {
  await ensurePayroll(db);
  const w = ownerWhere(owner);
  return db.select<SalaryRow>(`SELECT id, effective_from, pay_head_id, rate, per, seq FROM pr_salary WHERE ${w.sql} ORDER BY effective_from, seq`, [w.id]);
}

export async function setSalaryDetails(db: Db, owner: SalaryOwner, effectiveFrom: string, lines: SalaryLine[]): Promise<SalaryRow[]> {
  await ensurePayroll(db);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) throw new CoreError('invalid', 'Effective date is invalid');
  const w = ownerWhere(owner);
  const seen = new Set<number>();
  for (const l of lines) {
    if (!(await payHead(db, l.pay_head_id))) throw new CoreError('invalid', 'Unknown pay head');
    if (seen.has(l.pay_head_id)) throw new CoreError('invalid', 'A pay head is listed twice');
    seen.add(l.pay_head_id);
    if (!Number.isInteger(l.rate) || l.rate < 0) throw new CoreError('invalid', 'Rate must be a non-negative amount');
    inList(l.per ?? 'Months', PER_OPTIONS, 'Per');
  }
  let id = await nextId(db, 'pr_salary');
  const stmts: Stmt[] = [{ sql: `DELETE FROM pr_salary WHERE ${w.sql} AND effective_from = ?`, params: [w.id, effectiveFrom] }];
  lines.forEach((l, i) =>
    stmts.push({
      sql: 'INSERT INTO pr_salary (id, employee_id, group_id, effective_from, pay_head_id, rate, per, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      params: [id++, 'employee_id' in owner ? owner.employee_id : null, 'group_id' in owner ? owner.group_id : null, effectiveFrom, l.pay_head_id, l.rate, l.per ?? 'Months', i],
    })
  );
  await db.batch(stmts);
  return salaryDetails(db, owner);
}

async function effectiveStructure(db: Db, employeeId: number, date: string): Promise<SalaryLine[]> {
  const emp = await employee(db, employeeId);
  if (!emp) throw new CoreError('not_found', 'Employee not found');
  const owners: SalaryOwner[] = [{ employee_id: employeeId }];
  let g = emp.group_id;
  while (g) {
    owners.push({ group_id: g });
    g = (await employeeGroup(db, g))?.parent_id ?? null;
  }
  for (const o of owners) {
    const rows = (await salaryDetails(db, o)).filter((r) => r.effective_from <= date);
    if (!rows.length) continue;
    const latest = new Map<number, SalaryRow>();
    for (const r of rows) {
      const p = latest.get(r.pay_head_id);
      if (!p || r.effective_from >= p.effective_from) latest.set(r.pay_head_id, r);
    }
    return [...latest.values()].sort((a, b) => a.seq - b.seq).map((r) => ({ pay_head_id: r.pay_head_id, rate: r.rate, per: r.per }));
  }
  return [];
}

export function monthBounds(date: string): { from: string; to: string; days: number } {
  const [y, m] = date.split('-').map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const p = (n: number) => String(n).padStart(2, '0');
  return { from: `${y}-${p(m)}-01`, to: `${y}-${p(m)}-${p(days)}`, days };
}

export async function setAttendance(db: Db, input: { employee_id: number; type_id: number; date: string; value: number }): Promise<void> {
  await ensurePayroll(db);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new CoreError('invalid', 'Date is invalid');
  if (!Number.isInteger(input.value) || input.value < 0) throw new CoreError('invalid', 'Value must be a non-negative number');
  if (!(await employee(db, input.employee_id))) throw new CoreError('invalid', 'Unknown employee');
  if (!(await attendanceType(db, input.type_id))) throw new CoreError('invalid', 'Unknown attendance/production type');
  const id = await nextId(db, 'pr_attendance');
  const stmts: Stmt[] = [{ sql: 'DELETE FROM pr_attendance WHERE employee_id = ? AND type_id = ? AND date = ?', params: [input.employee_id, input.type_id, input.date] }];
  if (input.value > 0) stmts.push({ sql: 'INSERT INTO pr_attendance (id, employee_id, type_id, date, value) VALUES (?, ?, ?, ?, ?)', params: [id, input.employee_id, input.type_id, input.date, input.value] });
  await db.batch(stmts);
}

export async function attendanceEntries(db: Db, date: string): Promise<{ employee_id: number; type_id: number; value: number }[]> {
  await ensurePayroll(db);
  return db.select('SELECT employee_id, type_id, value FROM pr_attendance WHERE date = ?', [date]);
}

export interface PayrollLine {
  pay_head_id: number;
  name: string;
  display_name: string;
  ph_type: string;
  side: PayHeadSide;
  affect_net: boolean;
  amount: number;
  gross: number;
  ledger_id: number;
  payable_ledger_id: number | null;
}

function roundTo(v: number, method: string, limit: number): number {
  if (method === 'Not Applicable' || limit <= 0) return v;
  const q = v / limit;
  const r = method === 'Upward Rounding' ? Math.ceil(q) : method === 'Downward Rounding' ? Math.floor(q) : Math.round(q);
  return r * limit;
}

export async function computeSalary(db: Db, employeeId: number, date: string): Promise<PayrollLine[]> {
  const structure = await effectiveStructure(db, employeeId, date);
  if (!structure.length) return [];
  const heads = new Map((await payHeads(db)).map((p) => [p.id, p]));
  const b = monthBounds(date);
  const att = new Map<number, number>();
  for (const r of await db.select<{ type_id: number; v: number }>('SELECT type_id, SUM(value) AS v FROM pr_attendance WHERE employee_id = ? AND date BETWEEN ? AND ? GROUP BY type_id', [employeeId, b.from, b.to])) att.set(r.type_id, r.v);
  const rates = new Map(structure.map((s) => [s.pay_head_id, s]));
  const memo = [new Map<number, number>(), new Map<number, number>()];
  const busy = [new Set<number>(), new Set<number>()];

  const valueOf = (id: number, full: boolean): number => {
    const k = full ? 1 : 0;
    if (memo[k].has(id)) return memo[k].get(id)!;
    const ph = heads.get(id);
    const s = rates.get(id);
    if (!ph || !s || busy[k].has(id)) return 0;
    busy[k].add(id);
    let v = 0;
    if (ph.calc_type === 'Flat Rate' || ph.calc_type === 'As User Defined Value') v = s.rate;
    else if (ph.calc_type === 'On Attendance') {
      const basisMilli = ph.basis === 'User Defined Calendar Type' && ph.basis_unit_id ? att.get(ph.basis_unit_id) ?? 0 : b.days * QTY_SCALE;
      const got = full ? basisMilli : att.get(ph.attendance_type_id!) ?? 0;
      if (s.per === 'Months' || ph.calc_period === 'Months') v = basisMilli ? Math.round((s.rate * got) / basisMilli) : 0;
      else v = Math.round((s.rate * got) / QTY_SCALE);
    } else if (ph.calc_type === 'On Production') v = Math.round((s.rate * (att.get(ph.attendance_type_id!) ?? 0)) / QTY_SCALE);
    else {
      let base = 0;
      if (ph.compute_basis === 'On Specified Formula') for (const f of ph.formula) base += f.sign * valueOf(f.pay_head_id, full);
      else {
        const want: PayHeadSide = ph.compute_basis === 'On Current Earnings Total' ? 'earn' : 'ded';
        for (const o of structure) {
          const oh = heads.get(o.pay_head_id);
          if (oh && o.pay_head_id !== id && payHeadSide(oh.ph_type) === want && oh.affect_net && oh.calc_type !== 'As Computed Value') base += valueOf(o.pay_head_id, full);
        }
      }
      if (ph.max_base && base > ph.max_base) v = 0;
      else {
        if (ph.ceiling && base > ph.ceiling) base = ph.ceiling;
        if (ph.slabs.length) v = ph.slabs.find((sl) => base >= sl.from && (sl.to === 0 || base <= sl.to))?.amount ?? 0;
        else v = Math.round((base * ph.rate_bp) / 10000);
      }
    }
    busy[k].delete(id);
    v = Math.max(0, roundTo(v, ph.rounding, ph.rounding_limit));
    memo[k].set(id, v);
    return v;
  };

  const out: PayrollLine[] = [];
  for (const s of structure) {
    const ph = heads.get(s.pay_head_id);
    if (!ph) continue;
    out.push({
      pay_head_id: ph.id,
      name: ph.name,
      display_name: ph.display_name || ph.name,
      ph_type: ph.ph_type,
      side: payHeadSide(ph.ph_type),
      affect_net: !!ph.affect_net,
      amount: valueOf(ph.id, false),
      gross: valueOf(ph.id, true),
      ledger_id: ph.ledger_id,
      payable_ledger_id: ph.payable_ledger_id,
    });
  }
  return out;
}

export interface PayrollVoucherInput {
  date: string;
  number?: string;
  narration?: string;
  account_ledger_id: number;
  employees: { employee_id: number; lines?: { pay_head_id: number; amount: number }[] }[];
}

export interface PayrollVoucherLine {
  employee_id: number;
  employee: string;
  pay_head_id: number;
  pay_head: string;
  side: PayHeadSide;
  amount: number;
}

export interface PayrollVoucher {
  voucher: VoucherRow;
  account_ledger_id: number;
  period_from: string;
  period_to: string;
  lines: PayrollVoucherLine[];
}

export async function autofillPayroll(db: Db, date: string, opts: { employee_ids?: number[]; group_id?: number | null } = {}): Promise<PayrollVoucherInput['employees']> {
  let ids = opts.employee_ids;
  if (!ids) {
    const all = await employees(db);
    if (opts.group_id) {
      const groups = await employeeGroups(db);
      const within = new Set<number>([opts.group_id]);
      for (let grew = true; grew; ) {
        grew = false;
        for (const g of groups) if (g.parent_id && within.has(g.parent_id) && !within.has(g.id)) (within.add(g.id), (grew = true));
      }
      ids = all.filter((e) => e.group_id && within.has(e.group_id)).map((e) => e.id);
    } else ids = all.map((e) => e.id);
  }
  const out: PayrollVoucherInput['employees'] = [];
  for (const id of ids) {
    const lines = (await computeSalary(db, id, date)).filter((l) => l.amount > 0).map((l) => ({ pay_head_id: l.pay_head_id, amount: l.amount }));
    if (lines.length) out.push({ employee_id: id, lines });
  }
  return out;
}

async function buildPosting(db: Db, input: PayrollVoucherInput) {
  if (!input.employees?.length) throw new CoreError('invalid', 'Select at least one employee');
  if (!(await one(db, 'SELECT 1 FROM ledgers WHERE id = ?', [input.account_ledger_id]))) throw new CoreError('invalid', 'Select the payroll ledger account');
  const heads = new Map((await payHeads(db)).map((p) => [p.id, p]));
  const totals = new Map<number, number>();
  const add = (ledger: number, amt: number) => totals.set(ledger, (totals.get(ledger) ?? 0) + amt);
  const lines: { employee_id: number; pay_head_id: number; side: PayHeadSide; amount: number }[] = [];
  const seen = new Set<number>();
  let net = 0;
  for (const e of input.employees) {
    if (seen.has(e.employee_id)) throw new CoreError('invalid', 'An employee is listed twice');
    seen.add(e.employee_id);
    if (!(await employee(db, e.employee_id))) throw new CoreError('invalid', 'Unknown employee');
    const src = e.lines ?? (await computeSalary(db, e.employee_id, input.date)).map((l) => ({ pay_head_id: l.pay_head_id, amount: l.amount }));
    for (const l of src) {
      if (!l.amount) continue;
      const ph = heads.get(l.pay_head_id);
      if (!ph) throw new CoreError('invalid', 'Unknown pay head');
      if (!Number.isInteger(l.amount) || l.amount < 0) throw new CoreError('invalid', `Amount for ${ph.name} must be a positive amount`);
      const side = payHeadSide(ph.ph_type);
      lines.push({ employee_id: e.employee_id, pay_head_id: ph.id, side, amount: l.amount });
      if (side === 'earn' && ph.affect_net) (add(ph.ledger_id, l.amount), (net += l.amount));
      else if (side === 'ded') (add(ph.ledger_id, -l.amount), (net -= l.amount));
      else (add(ph.ledger_id, l.amount), add(ph.payable_ledger_id!, -l.amount));
    }
  }
  if (!lines.length) throw new CoreError('invalid', 'Enter at least one pay head amount');
  if (net !== 0) add(input.account_ledger_id, -net);
  const entries = [...totals.entries()].filter(([, a]) => a !== 0).map(([ledger_id, amount]) => ({ ledger_id, amount }));
  return { entries, lines };
}

async function saveLines(db: Db, voucherId: number, input: PayrollVoucherInput, lines: { employee_id: number; pay_head_id: number; side: string; amount: number }[]) {
  const b = monthBounds(input.date);
  let id = await nextId(db, 'pr_voucher_lines');
  await db.batch([
    { sql: 'DELETE FROM pr_voucher_lines WHERE voucher_id = ?', params: [voucherId] },
    { sql: 'DELETE FROM pr_vouchers WHERE voucher_id = ?', params: [voucherId] },
    { sql: 'INSERT INTO pr_vouchers (voucher_id, account_ledger_id, period_from, period_to) VALUES (?, ?, ?, ?)', params: [voucherId, input.account_ledger_id, b.from, b.to] },
    ...lines.map((l, i) => ({
      sql: 'INSERT INTO pr_voucher_lines (id, voucher_id, employee_id, pay_head_id, side, amount, seq) VALUES (?, ?, ?, ?, ?, ?, ?)',
      params: [id++, voucherId, l.employee_id, l.pay_head_id, l.side, l.amount, i] as (string | number)[],
    })),
  ]);
}

export async function createPayrollVoucher(books: Books, input: PayrollVoucherInput): Promise<PayrollVoucher> {
  const db = books.db;
  const type_id = await payrollVoucherTypeId(db);
  const post = await buildPosting(db, input);
  const v = await books.createVoucher({ type_id, number: input.number, date: input.date, narration: input.narration, entries: post.entries });
  try {
    await saveLines(db, v.id, input, post.lines);
  } catch (e) {
    await books.deleteVoucher(v.id);
    throw e;
  }
  return (await payrollVoucher(books, v.id))!;
}

export async function updatePayrollVoucher(books: Books, id: number, input: PayrollVoucherInput): Promise<PayrollVoucher> {
  const db = books.db;
  if (!(await one(db, 'SELECT 1 FROM pr_vouchers WHERE voucher_id = ?', [id]))) throw new CoreError('not_found', 'Payroll voucher not found');
  const post = await buildPosting(db, input);
  await books.updateVoucher(id, { type_id: await payrollVoucherTypeId(db), number: input.number, date: input.date, narration: input.narration, entries: post.entries });
  await saveLines(db, id, input, post.lines);
  return (await payrollVoucher(books, id))!;
}

export async function deletePayrollVoucher(books: Books, id: number): Promise<void> {
  const db = books.db;
  await books.deleteVoucher(id);
  await db.batch([
    { sql: 'DELETE FROM pr_voucher_lines WHERE voucher_id = ?', params: [id] },
    { sql: 'DELETE FROM pr_vouchers WHERE voucher_id = ?', params: [id] },
  ]);
}

export async function payrollVoucher(books: Books, id: number): Promise<PayrollVoucher | null> {
  const db = books.db;
  await ensurePayroll(db);
  const meta = await one<{ account_ledger_id: number; period_from: string; period_to: string }>(db, 'SELECT account_ledger_id, period_from, period_to FROM pr_vouchers WHERE voucher_id = ?', [id]);
  const voucher = await books.voucher(id);
  if (!meta || !voucher) return null;
  const lines = await db.select<PayrollVoucherLine>(
    `SELECT l.employee_id, e.name AS employee, l.pay_head_id, p.name AS pay_head, l.side, l.amount
     FROM pr_voucher_lines l JOIN pr_employees e ON e.id = l.employee_id JOIN pr_pay_heads p ON p.id = l.pay_head_id
     WHERE l.voucher_id = ? ORDER BY l.seq`,
    [id]
  );
  return { voucher, ...meta, lines };
}

export async function payrollVoucherList(db: Db, from: string, to: string): Promise<{ voucher_id: number; date: string; number: string; total: number }[]> {
  await ensurePayroll(db);
  return db.select(
    `SELECT v.id AS voucher_id, v.date, v.number, COALESCE((SELECT SUM(CASE WHEN l.side = 'earn' THEN l.amount ELSE 0 END) FROM pr_voucher_lines l WHERE l.voucher_id = v.id), 0) AS total
     FROM vouchers v JOIN pr_vouchers p ON p.voucher_id = v.id WHERE v.date BETWEEN ? AND ? ORDER BY v.date, v.seq`,
    [from, to]
  );
}

export interface EmployeeVoucherRow {
  voucher_id: number;
  date: string;
  type: string;
  number: string;
  lines: { pay_head_id: number; name: string; amount: number }[];
  debit: number;
  credit: number;
}

export async function employeeVouchers(db: Db, employeeId: number, from: string, to: string, payHeadId?: number): Promise<{ rows: EmployeeVoucherRow[]; debit: number; credit: number }> {
  await ensurePayroll(db);
  const raw = await db.select<{ voucher_id: number; date: string; type: string; number: string; pay_head_id: number; name: string; side: string; amount: number }>(
    `SELECT v.id AS voucher_id, v.date, t.name AS type, v.number, l.pay_head_id, p.name, l.side, l.amount
     FROM pr_voucher_lines l JOIN vouchers v ON v.id = l.voucher_id JOIN voucher_types t ON t.id = v.type_id JOIN pr_pay_heads p ON p.id = l.pay_head_id
     WHERE l.employee_id = ? AND v.date BETWEEN ? AND ? AND v.cancelled = 0 ${payHeadId ? 'AND l.pay_head_id = ?' : ''}
     ORDER BY v.date, v.seq, l.seq`,
    payHeadId ? [employeeId, from, to, payHeadId] : [employeeId, from, to]
  );
  const map = new Map<number, EmployeeVoucherRow>();
  for (const r of raw) {
    let row = map.get(r.voucher_id);
    if (!row) map.set(r.voucher_id, (row = { voucher_id: r.voucher_id, date: r.date, type: r.type, number: r.number, lines: [], debit: 0, credit: 0 }));
    const signed = r.side === 'ded' ? -r.amount : r.amount;
    row.lines.push({ pay_head_id: r.pay_head_id, name: r.name, amount: signed });
    if (signed > 0) row.debit += signed;
    else row.credit -= signed;
  }
  const rows = [...map.values()];
  return { rows, debit: rows.reduce((s, r) => s + r.debit, 0), credit: rows.reduce((s, r) => s + r.credit, 0) };
}

export interface TreeRow {
  kind: 'category' | 'group' | 'employee';
  id: number;
  name: string;
  level: number;
  values: Record<number, number>;
}

async function buildTree(db: Db, byEmployee: Map<number, Record<number, number>>, opts: { onlyWithData: boolean }): Promise<TreeRow[]> {
  const groups = await employeeGroups(db);
  const emps = await employees(db);
  const sum = (a: Record<number, number>, b: Record<number, number>) => {
    for (const k of Object.keys(b)) a[Number(k)] = (a[Number(k)] ?? 0) + b[Number(k)];
  };
  const build = (parent: number | null, level: number): { rows: TreeRow[]; total: Record<number, number> } => {
    const rows: TreeRow[] = [];
    const total: Record<number, number> = {};
    for (const g of groups.filter((x) => (x.parent_id ?? null) === parent)) {
      const inner = build(g.id, level + 1);
      if (opts.onlyWithData && !inner.rows.length) continue;
      rows.push({ kind: 'group', id: g.id, name: g.name, level, values: inner.total }, ...inner.rows);
      sum(total, inner.total);
    }
    for (const e of emps.filter((x) => (x.group_id ?? null) === parent)) {
      const v = byEmployee.get(e.id) ?? {};
      if (opts.onlyWithData && !Object.values(v).some((n) => n)) continue;
      rows.push({ kind: 'employee', id: e.id, name: e.name, level, values: { ...v } });
      sum(total, v);
    }
    return { rows, total };
  };
  const root = build(null, 1);
  return [{ kind: 'category', id: 0, name: 'Primary Cost Category', level: 0, values: root.total }, ...root.rows];
}

export interface PayrollStatement {
  columns: { id: number; name: string }[];
  rows: TreeRow[];
}

export async function payrollStatement(db: Db, from: string, to: string, columnIds?: number[]): Promise<PayrollStatement> {
  await ensurePayroll(db);
  const raw = await db.select<{ employee_id: number; pay_head_id: number; amount: number }>(
    `SELECT l.employee_id, l.pay_head_id, SUM(l.amount) AS amount FROM pr_voucher_lines l JOIN vouchers v ON v.id = l.voucher_id
     WHERE v.date BETWEEN ? AND ? AND v.cancelled = 0 GROUP BY l.employee_id, l.pay_head_id`,
    [from, to]
  );
  const heads = await payHeads(db);
  const used = new Set(raw.map((r) => r.pay_head_id));
  const columns = heads.filter((h) => (columnIds ? columnIds.includes(h.id) : used.has(h.id))).map((h) => ({ id: h.id, name: h.name }));
  const keep = new Set(columns.map((c) => c.id));
  const by = new Map<number, Record<number, number>>();
  for (const r of raw) {
    if (!keep.has(r.pay_head_id)) continue;
    const m = by.get(r.employee_id) ?? {};
    m[r.pay_head_id] = r.amount;
    by.set(r.employee_id, m);
  }
  return { columns, rows: await buildTree(db, by, { onlyWithData: false }) };
}

export interface AttendanceSheet {
  columns: { id: number; name: string; unit: string }[];
  rows: TreeRow[];
}

export async function attendanceSheet(db: Db, from: string, to: string): Promise<AttendanceSheet> {
  await ensurePayroll(db);
  const types = await attendanceTypes(db);
  const raw = await db.select<{ employee_id: number; type_id: number; v: number }>('SELECT employee_id, type_id, SUM(value) AS v FROM pr_attendance WHERE date BETWEEN ? AND ? GROUP BY employee_id, type_id', [from, to]);
  const by = new Map<number, Record<number, number>>();
  for (const r of raw) {
    const m = by.get(r.employee_id) ?? {};
    m[r.type_id] = r.v;
    by.set(r.employee_id, m);
  }
  return { columns: types.map((t) => ({ id: t.id, name: t.name, unit: attendanceUnit(t) })), rows: await buildTree(db, by, { onlyWithData: false }) };
}

export interface PaySlip {
  employee: Employee;
  title: string;
  from: string;
  to: string;
  attendance: { name: string; value: number; unit: string }[];
  earnings: { name: string; amount: number; gross: number }[];
  deductions: { name: string; amount: number; gross: number }[];
  total_earnings: number;
  gross_earnings: number;
  total_deductions: number;
  gross_deductions: number;
  net: number;
  gross_net: number;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export async function paySlip(db: Db, employeeId: number, from: string, to: string): Promise<PaySlip | null> {
  const emp = await employee(db, employeeId);
  if (!emp) return null;
  const raw = await db.select<{ pay_head_id: number; name: string; display_name: string; side: string; amount: number; affect_net: number; seq: number }>(
    `SELECT l.pay_head_id, p.name, p.display_name, l.side, SUM(l.amount) AS amount, p.affect_net, MIN(p.id) AS seq
     FROM pr_voucher_lines l JOIN vouchers v ON v.id = l.voucher_id JOIN pr_pay_heads p ON p.id = l.pay_head_id
     WHERE l.employee_id = ? AND v.date BETWEEN ? AND ? AND v.cancelled = 0 AND l.side IN ('earn', 'ded') AND p.affect_net = 1
     GROUP BY l.pay_head_id ORDER BY seq`,
    [employeeId, from, to]
  );
  const gross = new Map((await computeSalary(db, employeeId, to)).map((l) => [l.pay_head_id, l.gross]));
  const att = await db.select<{ name: string; kind: string; period_type: string; unit: string; v: number }>(
    `SELECT t.name, t.kind, t.period_type, t.unit, SUM(a.value) AS v FROM pr_attendance a JOIN pr_attendance_types t ON t.id = a.type_id
     WHERE a.employee_id = ? AND a.date BETWEEN ? AND ? GROUP BY t.id ORDER BY t.name COLLATE NOCASE`,
    [employeeId, from, to]
  );
  const mk = (side: string) => raw.filter((r) => r.side === side).map((r) => ({ name: r.display_name || r.name, amount: r.amount, gross: gross.get(r.pay_head_id) ?? r.amount }));
  const earnings = mk('earn');
  const deductions = mk('ded');
  const sumOf = (a: { amount: number; gross: number }[], k: 'amount' | 'gross') => a.reduce((s, x) => s + x[k], 0);
  const [y, m] = from.split('-').map(Number);
  return {
    employee: emp,
    title: `Pay Slip for ${MONTH_NAMES[m - 1]}-${y}`,
    from,
    to,
    attendance: att.map((a) => ({ name: a.name, value: a.v, unit: attendanceUnit(a) })),
    earnings,
    deductions,
    total_earnings: sumOf(earnings, 'amount'),
    gross_earnings: sumOf(earnings, 'gross'),
    total_deductions: sumOf(deductions, 'amount'),
    gross_deductions: sumOf(deductions, 'gross'),
    net: sumOf(earnings, 'amount') - sumOf(deductions, 'amount'),
    gross_net: sumOf(earnings, 'gross') - sumOf(deductions, 'gross'),
  };
}

export async function isPayrollVoucher(db: Db, voucherId: number): Promise<boolean> {
  await ensurePayroll(db);
  return !!(await one(db, 'SELECT 1 FROM pr_vouchers WHERE voucher_id = ?', [voucherId]));
}
