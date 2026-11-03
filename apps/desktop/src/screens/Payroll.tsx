import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import {
  ATTENDANCE_KINDS,
  BASIS_OPTIONS,
  CALC_PERIODS,
  CALC_TYPES,
  COMPUTE_BASES,
  GRATUITY_CALC,
  INCOME_TYPES,
  IT_CALC,
  TAX_REGIMES,
  employeeTax,
  employeeTerms,
  fyOf,
  resetTaxRules,
  saveEmployeeTax,
  saveEmployeeTerms,
  saveTaxRules,
  taxRules,
  PAY_HEAD_TYPES,
  PER_OPTIONS,
  ROUNDING_METHODS,
  attendanceType,
  attendanceTypes,
  createAttendanceType,
  createEmployee,
  createEmployeeCategory,
  createEmployeeGroup,
  createPayHead,
  deleteAttendanceType,
  deleteEmployee,
  deleteEmployeeCategory,
  deleteEmployeeGroup,
  deletePayHead,
  employee,
  employeeCategories,
  employeeGroup,
  employeeGroups,
  employees,
  fmtAmount,
  fmtDate,
  parseAmount,
  parseDate,
  payHead,
  payHeadSide,
  payHeads,
  salaryDetails,
  setSalaryDetails,
  statutoryDefaults,
  units,
  updateAttendanceType,
  updateEmployee,
  updateEmployeeCategory,
  updateEmployeeGroup,
  updatePayHead,
  type AttendanceType,
  type Employee,
  type EmployeeCategory,
  type EmployeeGroup,
  type PayHead,
  type PayHeadInput,
  type SalaryOwner,
  type TaxRegime,
  type TaxRules,
  type Unit,
} from '@tallybook/core';
import { Form, type FieldDef, type FormHandle } from '../ui/Form.tsx';
import { PickerInput, type Opt } from '../ui/PickerInput.tsx';
import { useScreen } from '../registry.ts';
import { useStore } from '../store.tsx';
import { useNav } from '../nav.tsx';
import { useDialogs } from '../ui/Dialogs.tsx';
import { SelectList } from './SelectList.tsx';

function useList<T>(fn: () => Promise<T[]>): T[] {
  const { version } = useStore();
  const [rows, setRows] = useState<T[]>([]);
  useEffect(() => void fn().then(setRows), [version]);
  return rows;
}

function useRecord<T>(id: number | undefined, fn: (id: number) => Promise<T | null>): T | null | undefined {
  const [cur, setCur] = useState<T | null | undefined>(id ? undefined : null);
  useEffect(() => {
    if (id) void fn(id).then(setCur);
  }, [id]);
  return cur;
}

const enumOpts = (list: readonly string[]): Opt[] => list.map((s) => ({ id: s, label: s }));
const enumPick = (list: readonly string[], v: string | undefined, fallback = 0): Opt => enumOpts(list).find((o) => o.id === v) ?? enumOpts(list)[fallback];

function Master({
  title,
  fields,
  onSave,
  onDelete,
  after,
  labelWidth,
}: {
  title: string;
  fields: FieldDef[];
  onSave: (v: Record<string, unknown>) => Promise<number | void>;
  onDelete?: () => Promise<void>;
  after?: (id: number, v: Record<string, unknown>) => void;
  labelWidth?: number;
}) {
  const { bump, toast } = useStore();
  const nav = useNav();
  const dialogs = useDialogs();
  const form = useRef<FormHandle>(null);
  const save = async () => {
    const v = form.current?.submit();
    if (!v) return;
    try {
      const id = await onSave(v);
      bump();
      toast(`${title.replace(/ (Creation|Alteration)$/, '')} saved`, 'ok');
      nav.pop();
      if (after && id) after(id, v);
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  const remove = async () => {
    if (!onDelete || !(await dialogs.confirm('Delete ?', { title: 'Delete', def: false }))) return;
    try {
      await onDelete();
      bump();
      toast('Deleted', 'ok');
      nav.pop();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  useScreen({
    title,
    noPeriod: true,
    keys: { 'Ctrl+A': () => void save(), 'Alt+D': onDelete ? () => void remove() : () => false },
    buttons: [{ key: 'Ctrl+A', label: 'Accept', run: () => void save() }, ...(onDelete ? [{ key: 'Alt+D', label: 'Delete', run: () => void remove() }] : [])],
  });
  return (
    <div className="max-w-3xl">
      <Form ref={form} fields={fields} labelWidth={labelWidth} onDone={() => void save()} />
    </div>
  );
}

function parentOpts(rows: { id: number; name: string }[], exclude?: number): Opt[] {
  return [{ id: 0, label: 'Primary' }, ...rows.filter((r) => r.id !== exclude).map((r) => ({ id: r.id, label: r.name }))];
}

export function EmployeeGroupForm({ id, presetName }: { id?: number; presetName?: string }) {
  const { books } = useStore();
  const nav = useNav();
  const rows = useList<EmployeeGroup>(() => employeeGroups(books.db));
  const cur = useRecord(id, (i) => employeeGroup(books.db, i));
  if (cur === undefined) return null;
  const opts = parentOpts(rows, id);
  return (
    <Master
      title={id ? 'Employee Group Alteration' : 'Employee Group Creation'}
      labelWidth={200}
      fields={[
        { key: 'name', label: 'Name', kind: 'text', required: true, initial: cur?.name ?? presetName },
        { key: 'alias', label: '(alias)', kind: 'text', initial: cur?.alias },
        { key: 'parent', label: 'Under', kind: 'picker', title: 'Employee Groups', options: opts, initial: opts.find((o) => o.id === (cur?.parent_id ?? 0)), required: true },
        { key: 'salary', label: 'Define salary details', kind: 'toggle', initial: !!cur?.define_salary },
      ]}
      onSave={async (v) => {
        const input = { name: String(v.name), alias: String(v.alias), parent_id: Number(v.parent) || null, define_salary: !!v.salary };
        const g = id ? await updateEmployeeGroup(books.db, id, input) : await createEmployeeGroup(books.db, input);
        return v.salary ? g.id : undefined;
      }}
      after={(gid) => nav.push(<SalaryDetailsScreen owner={{ group_id: gid }} />)}
      onDelete={id ? () => deleteEmployeeGroup(books.db, id) : undefined}
    />
  );
}

export function EmployeeCategoryForm({ id, presetName }: { id?: number; presetName?: string }) {
  const { books } = useStore();
  const rows = useList<EmployeeCategory>(() => employeeCategories(books.db));
  const cur = rows.find((r) => r.id === id);
  if (id && !cur) return null;
  return (
    <Master
      title={id ? 'Employee Category Alteration' : 'Employee Category Creation'}
      labelWidth={260}
      fields={[
        { key: 'name', label: 'Name', kind: 'text', required: true, initial: cur?.name ?? presetName },
        { key: 'alias', label: '(alias)', kind: 'text', initial: cur?.alias },
        { key: 'rev', label: 'Allocate revenue items', kind: 'toggle', initial: cur ? !!cur.allocate_revenue : true },
        { key: 'nonrev', label: 'Allocate non-revenue items', kind: 'toggle', initial: !!cur?.allocate_non_revenue },
      ]}
      onSave={async (v) => {
        const input = { name: String(v.name), alias: String(v.alias), allocate_revenue: !!v.rev, allocate_non_revenue: !!v.nonrev };
        if (id) await updateEmployeeCategory(books.db, id, input);
        else await createEmployeeCategory(books.db, input);
      }}
      onDelete={id ? () => deleteEmployeeCategory(books.db, id) : undefined}
    />
  );
}

const GENDERS: Opt[] = ['Male', 'Female', 'Others'].map((g) => ({ id: g, label: g }));

const regimeOpts: Opt[] = TAX_REGIMES.map((r) => ({ id: r.id, label: r.label }));

export function EmployeeForm({ id, presetName }: { id?: number; presetName?: string }) {
  const { books, company, period } = useStore();
  const nav = useNav();
  const groups = useList<EmployeeGroup>(() => employeeGroups(books.db));
  const cur = useRecord(id, (i) => employee(books.db, i));
  const fy = fyOf(period.from || company?.fy_start || new Date().toISOString().slice(0, 10)).from;
  const [extra, setExtra] = useState<{ regime: TaxRegime; fixed: boolean; leaving: string } | null>(null);
  useEffect(() => {
    if (!id) return setExtra({ regime: 'new', fixed: false, leaving: '' });
    void Promise.all([employeeTax(books.db, id, fy), employeeTerms(books.db, id)]).then(([t, x]) => setExtra({ regime: t.regime, fixed: !!x.fixed_term, leaving: x.date_of_leaving }));
  }, [id, fy]);
  if (cur === undefined || !extra) return null;
  const opts = parentOpts(groups);
  const f = (key: string, label: string, kind: FieldDef['kind'] = 'text', extra: Partial<FieldDef> = {}): FieldDef => ({
    key,
    label,
    kind,
    initial: cur ? (cur as unknown as Record<string, unknown>)[extra.key ?? key] : undefined,
    ...extra,
  });
  const bank = (v: Record<string, unknown>) => !!v.bank_details;
  const fields: FieldDef[] = [
    { key: 'name', label: 'Name', kind: 'text', required: true, initial: cur?.name ?? presetName },
    { key: 'alias', label: '(alias)', kind: 'text', initial: cur?.alias },
    { key: 'group', label: 'Under', kind: 'picker', title: 'Employee Groups', options: opts, initial: opts.find((o) => o.id === (cur?.group_id ?? 0)), required: true },
    { key: 'joining', label: 'Date of joining', kind: 'date', initial: cur?.date_of_joining || company?.fy_start },
    { key: 'salary', label: 'Define salary details', kind: 'toggle', initial: !!cur?.define_salary },
    f('emp_number', 'Employee Number', 'text', { heading: 'General Information' }),
    f('designation', 'Designation'),
    f('function', 'Function'),
    f('location', 'Location'),
    { key: 'gender', label: 'Gender', kind: 'picker', title: 'Genders', options: GENDERS, initial: GENDERS.find((g) => g.id === cur?.gender) },
    { key: 'dob', label: 'Date of birth', kind: 'text', initial: cur?.date_of_birth ? fmtDate(cur.date_of_birth) : '' },
    f('blood_group', 'Blood group'),
    f('parent_name', "Father's/mother's name"),
    f('spouse_name', "Spouse's name"),
    f('address', 'Address'),
    f('phone', 'Phone no.'),
    f('email', 'E-Mail'),
    { key: 'bank_details', label: 'Provide bank details', kind: 'toggle', initial: !!cur?.bank_details },
    f('bank_name', 'Bank name', 'text', { visible: bank }),
    f('bank_account', 'Account number', 'text', { visible: bank }),
    f('bank_ifsc', 'IFSC code', 'text', { visible: bank }),
    f('bank_branch', 'Branch', 'text', { visible: bank }),
    f('pan', 'Income Tax Number (PAN)', 'upper', { heading: 'Statutory Details' }),
    f('aadhaar', 'Aadhaar number'),
    f('uan', 'Universal Account Number (UAN)'),
    f('pf_number', 'PF account number'),
    f('pran', 'PR Account Number (PRAN)'),
    f('esi_number', 'ESI number'),
    { key: 'regime', label: 'Applicable tax regime', kind: 'picker', title: 'Tax Regimes', options: regimeOpts, initial: regimeOpts.find((o) => o.id === extra.regime), required: true, note: `For the financial year from ${fmtDate(fy)}` },
    { key: 'fixed_term', label: 'Fixed term employee', kind: 'toggle', initial: extra.fixed },
    { key: 'leaving', label: 'Date of leaving', kind: 'text', initial: extra.leaving ? fmtDate(extra.leaving) : '' },
  ];
  return (
    <Master
      title={id ? 'Employee Alteration' : 'Employee Creation'}
      fields={fields}
      labelWidth={260}
      onSave={async (v) => {
        const dob = String(v.dob || '');
        const dobIso = dob ? parseDate(dob, company?.fy_start) : '';
        if (dob && !dobIso) throw new Error('Date of birth: invalid date');
        const input = {
          name: String(v.name),
          alias: String(v.alias),
          group_id: Number(v.group) || null,
          date_of_joining: String(v.joining),
          define_salary: !!v.salary,
          date_of_birth: dobIso ?? '',
          bank_details: !!v.bank_details,
          gender: String(v.gender ?? ''),
          ...Object.fromEntries(['emp_number', 'designation', 'function', 'location', 'blood_group', 'parent_name', 'spouse_name', 'address', 'phone', 'email', 'bank_name', 'bank_account', 'bank_ifsc', 'bank_branch', 'pan', 'aadhaar', 'uan', 'pf_number', 'pran', 'esi_number'].map((k) => [k, String(v[k] ?? '')])),
        };
        const leaving = String(v.leaving || '');
        const leavingIso = leaving ? parseDate(leaving, company?.fy_start) : '';
        if (leaving && !leavingIso) throw new Error('Date of leaving: invalid date');
        const e = id ? await updateEmployee(books.db, id, input) : await createEmployee(books.db, input);
        await saveEmployeeTax(books.db, e.id, fy, { regime: (String(v.regime || 'new') as TaxRegime) });
        await saveEmployeeTerms(books.db, e.id, { fixed_term: !!v.fixed_term, date_of_leaving: leavingIso ?? '' });
        return v.salary ? e.id : undefined;
      }}
      after={(eid) => nav.push(<SalaryDetailsScreen owner={{ employee_id: eid }} />)}
      onDelete={id ? () => deleteEmployee(books.db, id) : undefined}
    />
  );
}

export function AttendanceTypeForm({ id, presetName }: { id?: number; presetName?: string }) {
  const { books } = useStore();
  const rows = useList<AttendanceType>(() => attendanceTypes(books.db));
  const allUnits = useList<Unit>(() => units(books.db));
  const cur = useRecord(id, (i) => attendanceType(books.db, i));
  if (cur === undefined || !allUnits.length) return null;
  const parents = parentOpts(rows, id);
  const unitOpts: Opt[] = allUnits.map((u) => ({ id: u.symbol, label: u.symbol, sub: u.formal_name }));
  const production = (v: Record<string, unknown>) => v.kind === 'Production';
  return (
    <Master
      title={id ? 'Attendance/Production Type Alteration' : 'Attendance/Production Type Creation'}
      labelWidth={200}
      fields={[
        { key: 'name', label: 'Name', kind: 'text', required: true, initial: cur?.name ?? presetName },
        { key: 'alias', label: '(alias)', kind: 'text', initial: cur?.alias },
        { key: 'parent', label: 'Under', kind: 'picker', title: 'Attendance/Production Types', options: parents, initial: parents.find((o) => o.id === (cur?.parent_id ?? 0)), required: true },
        { key: 'kind', label: 'Attendance type', kind: 'picker', title: 'Attendance Types', options: enumOpts(ATTENDANCE_KINDS), initial: enumPick(ATTENDANCE_KINDS, cur?.kind), required: true },
        { key: 'period', label: '  Period type', kind: 'picker', title: 'Period Types', options: enumOpts(['Days', 'Hours']), initial: enumPick(['Days', 'Hours'], cur?.period_type), required: true, visible: (v) => !production(v) },
        { key: 'unit', label: 'Unit', kind: 'picker', title: 'Units', options: unitOpts, initial: unitOpts.find((u) => u.id === cur?.unit) ?? unitOpts[0], required: true, visible: production },
      ]}
      onSave={async (v) => {
        const input = { name: String(v.name), alias: String(v.alias), parent_id: Number(v.parent) || null, kind: String(v.kind), period_type: String(v.period || 'Days'), unit: String(v.unit || '') };
        if (id) await updateAttendanceType(books.db, id, input);
        else await createAttendanceType(books.db, input);
      }}
      onDelete={id ? () => deleteAttendanceType(books.db, id) : undefined}
    />
  );
}

const optId = (v: unknown) => (v === null || v === undefined || v === '' ? undefined : (v as number | string));

export function PayHeadForm({ id, presetName }: { id?: number; presetName?: string }) {
  const { books, company } = useStore();
  const heads = useList<PayHead>(() => payHeads(books.db));
  const types = useList<AttendanceType>(() => attendanceTypes(books.db));
  const groups = useList<{ id: number; name: string }>(() => books.groups());
  const cur = useRecord(id, (i) => payHead(books.db, i));
  if (cur === undefined) return null;
  const typeOpts = (kinds: (t: AttendanceType) => boolean): Opt[] => types.filter(kinds).map((t) => ({ id: t.id, label: t.name }));
  const attOpts = typeOpts((t) => t.kind !== 'Production');
  const prodOpts = typeOpts((t) => t.kind === 'Production');
  const calOpts = typeOpts((t) => t.kind === 'User Defined Calendar Type');
  const groupOpts: Opt[] = groups.map((g) => ({ id: g.id, label: g.name }));
  const formulaOpts: Opt[] = heads
    .filter((h) => h.id !== id)
    .flatMap((h) => [
      { id: `1:${h.id}`, label: `+ ${h.name}` },
      { id: `-1:${h.id}`, label: `- ${h.name}` },
    ]);
  const term = (i: number): Opt | undefined => {
    const t = cur?.formula[i];
    return t ? formulaOpts.find((o) => o.id === `${t.sign}:${t.pay_head_id}`) : undefined;
  };
  const side = (v: Record<string, unknown>) => payHeadSide(String(v.ph_type));
  const earn = (v: Record<string, unknown>) => !!v.ph_type && side(v) === 'earn';
  const statDed = (v: Record<string, unknown>) => v.ph_type === "Employees' Statutory Deductions";
  const isGratuity = (v: Record<string, unknown>) => v.ph_type === 'Gratuity';
  const calc = (v: Record<string, unknown>) => (isGratuity(v) ? GRATUITY_CALC : statDed(v) ? String(v.calc_type_sd) : String(v.calc_type));
  const sdCalcTypes = [...CALC_TYPES, IT_CALC];
  const formula = (v: Record<string, unknown>) => calc(v) === 'As Computed Value' && v.compute_basis === 'On Specified Formula';
  const fields: FieldDef[] = [
    { key: 'name', label: 'Name', kind: 'text', required: true, initial: cur?.name ?? presetName },
    { key: 'alias', label: '(alias)', kind: 'text', initial: cur?.alias, heading: undefined },
    { key: 'ph_type', label: 'Pay head type', kind: 'picker', title: 'Pay Head Types', options: enumOpts(PAY_HEAD_TYPES), initial: cur ? enumPick(PAY_HEAD_TYPES, cur.ph_type) : undefined, required: true, heading: 'Pay Head Information' },
    { key: 'income_type', label: '  Income type', kind: 'picker', title: 'Income Types', options: enumOpts(INCOME_TYPES), initial: enumPick(INCOME_TYPES, cur?.income_type), required: true, visible: (v) => v.ph_type === 'Earnings for Employees' || v.ph_type === 'Bonus' },
    { key: 'group', label: 'Under', kind: 'picker', title: 'Groups', options: groupOpts, initial: groupOpts.find((g) => g.id === cur?.group_id), note: cur ? undefined : 'Blank for the default group' },
    { key: 'affect', label: 'Affect net salary', kind: 'toggle', initial: cur ? !!cur.affect_net : true, visible: earn },
    { key: 'display_name', label: '  Name to be displayed in payslip', kind: 'text', initial: cur?.display_name, visible: (v) => !!v.ph_type && side(v) !== 'emp' },
    { key: 'gratuity', label: 'Use for calculation of gratuity', kind: 'toggle', initial: !!cur?.gratuity, visible: earn },
    { key: 'calc_type', label: 'Calculation type', kind: 'picker', title: 'Calculation Types', options: enumOpts(CALC_TYPES), initial: enumPick(CALC_TYPES, cur?.calc_type, 1), required: true, visible: (v) => !statDed(v) && !isGratuity(v) },
    { key: 'calc_type_sd', label: 'Calculation type', kind: 'picker', title: 'Calculation Types', options: enumOpts(sdCalcTypes), initial: enumPick(sdCalcTypes, cur?.calc_type, 1), required: true, visible: statDed },
    { key: 'att', label: '  Attendance/leave with pay', kind: 'picker', title: 'Attendance/Production Types', options: attOpts, initial: attOpts.find((o) => o.id === cur?.attendance_type_id), required: true, visible: (v) => calc(v) === 'On Attendance' },
    { key: 'prod', label: '  Production type', kind: 'picker', title: 'Attendance/Production Types', options: prodOpts, initial: prodOpts.find((o) => o.id === cur?.attendance_type_id), required: true, visible: (v) => calc(v) === 'On Production' },
    { key: 'period', label: '  Calculation period', kind: 'picker', title: 'Calculation Periods', options: enumOpts(CALC_PERIODS), initial: enumPick(CALC_PERIODS, cur?.calc_period, 2), required: true, visible: (v) => calc(v) === 'On Attendance' },
    { key: 'basis', label: '    Basis of calculation (per day)', kind: 'picker', title: 'Basis of Calculation', options: enumOpts(BASIS_OPTIONS), initial: enumPick(BASIS_OPTIONS, cur?.basis), required: true, visible: (v) => calc(v) === 'On Attendance' },
    { key: 'basis_unit', label: '    Calendar type', kind: 'picker', title: 'Attendance/Production Types', options: calOpts, initial: calOpts.find((o) => o.id === cur?.basis_unit_id), required: true, visible: (v) => calc(v) === 'On Attendance' && v.basis === 'User Defined Calendar Type' },
    { key: 'compute_basis', label: '  Compute on', kind: 'picker', title: 'Compute On', options: enumOpts(COMPUTE_BASES), initial: enumPick(COMPUTE_BASES, cur?.compute_basis), required: true, visible: (v) => calc(v) === 'As Computed Value' },
    ...[0, 1, 2].map(
      (i): FieldDef => ({ key: `f${i}`, label: i === 0 ? '    Specified formula' : '', kind: 'picker', title: 'Pay Heads', options: formulaOpts, initial: term(i), visible: formula })
    ),
    { key: 'rate', label: '  Percentage', kind: 'text', initial: cur?.rate_bp ? String(cur.rate_bp / 100) : '', visible: (v) => calc(v) === 'As Computed Value' },
    { key: 'ceiling', label: '  Maximum value of base', kind: 'amount', initial: cur?.ceiling || undefined, visible: (v) => calc(v) === 'As Computed Value' },
    { key: 'max_base', label: '  Not applicable above', kind: 'amount', initial: cur?.max_base || undefined, visible: (v) => calc(v) === 'As Computed Value' },
    { key: 'statutory', label: '  Statutory pay head', kind: 'picker', title: 'Statutory Pay Heads', options: [{ id: '', label: 'Not Applicable' }, { id: 'PF', label: 'Provident Fund' }, { id: 'ESI', label: 'Employees State Insurance' }, { id: 'PT', label: 'Professional Tax' }], initial: { id: cur?.statutory ?? '', label: { '': 'Not Applicable', PF: 'Provident Fund', ESI: 'Employees State Insurance', PT: 'Professional Tax' }[cur?.statutory ?? ''] ?? 'Not Applicable' }, visible: (v) => calc(v) === 'As Computed Value' },
    { key: 'rounding', label: 'Rounding Method', kind: 'picker', title: 'Rounding Methods', options: enumOpts(ROUNDING_METHODS), initial: enumPick(ROUNDING_METHODS, cur?.rounding), required: true, heading: 'Rounding Off Information' },
    { key: 'limit', label: '  Rounding Limit', kind: 'amount', initial: cur && cur.rounding !== 'Not Applicable' ? cur.rounding_limit : undefined, visible: (v) => v.rounding !== 'Not Applicable' },
  ];
  void company;
  return (
    <Master
      title={id ? 'Pay Head Alteration' : 'Pay Head Creation'}
      fields={fields}
      labelWidth={300}
      onSave={async (v) => {
        const picked = String(v.statutory || '');
        const kind = calc(v) === IT_CALC ? 'IT' : picked === 'IT' ? '' : picked;
        const pct = String(v.rate || '').trim();
        if (pct && !/^\d+(\.\d{1,2})?$/.test(pct)) throw new Error('Percentage: enter a valid number');
        const def = kind ? statutoryDefaults(kind) : {};
        const selected = [v.f0, v.f1, v.f2]
          .filter(Boolean)
          .map((x) => String(x).split(':'))
          .map(([s, pid]) => ({ pay_head_id: Number(pid), sign: (Number(s) === -1 ? -1 : 1) as 1 | -1 }));
        const computed = calc(v) === 'As Computed Value';
        const input: PayHeadInput = {
          name: String(v.name),
          alias: String(v.alias),
          ph_type: String(v.ph_type),
          income_type: String(v.income_type || 'Fixed'),
          group_id: Number(v.group) || undefined,
          affect_net: v.affect === undefined ? true : !!v.affect,
          display_name: String(v.display_name || ''),
          gratuity: !!v.gratuity,
          calc_type: calc(v),
          attendance_type_id: Number(optId(v.att) ?? optId(v.prod)) || undefined,
          calc_period: String(v.period || 'Months'),
          basis: String(v.basis || BASIS_OPTIONS[0]),
          basis_unit_id: Number(v.basis_unit) || undefined,
          compute_basis: String(v.compute_basis || COMPUTE_BASES[0]),
          formula: selected,
          rate_bp: pct ? Math.round(parseFloat(pct) * 100) : computed ? def.rate_bp ?? 0 : 0,
          ceiling: Number(v.ceiling) || (computed ? def.ceiling ?? 0 : 0),
          max_base: Number(v.max_base) || (computed ? def.max_base ?? 0 : 0),
          slabs: computed && !pct ? def.slabs ?? cur?.slabs ?? [] : cur?.slabs ?? [],
          statutory: kind,
          rounding: calc(v) === IT_CALC && cur?.calc_type !== IT_CALC && v.rounding === 'Not Applicable' ? 'Upward Rounding' : String(v.rounding),
          rounding_limit: Number(v.limit) || 100,
        };
        if (id) await updatePayHead(books, id, input);
        else await createPayHead(books, input);
      }}
      onDelete={id ? () => deletePayHead(books, id) : undefined}
    />
  );
}

interface SalaryRowState {
  ph: PayHead | null;
  text: string;
  rate: string;
  per: string;
}

const blankRow = (): SalaryRowState => ({ ph: null, text: '', rate: '', per: 'Months' });
const rated = (ph: PayHead | null) => !!ph && ph.calc_type !== 'As Computed Value' && ph.calc_type !== IT_CALC && ph.calc_type !== GRATUITY_CALC;

function computedOn(ph: PayHead, all: PayHead[]): string {
  if (ph.calc_type !== 'As Computed Value') return '';
  if (ph.compute_basis === 'On Current Earnings Total') return 'Current Earnings Total';
  if (ph.compute_basis === 'On Current Deductions Total') return 'Current Deductions Total';
  return ph.formula.map((t, i) => `${i ? (t.sign > 0 ? ' + ' : ' - ') : t.sign > 0 ? '' : '-'}${all.find((p) => p.id === t.pay_head_id)?.name ?? ''}`).join('');
}

export function SalaryDetailsScreen({ owner }: { owner: SalaryOwner }) {
  const { books, company, bump, toast } = useStore();
  const nav = useNav();
  const dialogs = useDialogs();
  const heads = useList<PayHead>(() => payHeads(books.db));
  const [subject, setSubject] = useState<{ name: string; under: string; primary: boolean } | null>(null);
  const [eff, setEff] = useState('');
  const [rows, setRows] = useState<SalaryRowState[]>([blankRow()]);
  const [ready, setReady] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const effRef = useRef(eff);
  effRef.current = eff;

  useEffect(() => {
    void (async () => {
      const groups = await employeeGroups(books.db);
      if ('employee_id' in owner) {
        const e = await employee(books.db, owner.employee_id);
        const g = groups.find((x) => x.id === e?.group_id);
        setSubject({ name: e?.name ?? '', under: g?.name ?? 'Primary', primary: !g });
      } else {
        const g = groups.find((x) => x.id === owner.group_id);
        const p = groups.find((x) => x.id === g?.parent_id);
        setSubject({ name: g?.name ?? '', under: p?.name ?? 'Primary', primary: !p });
      }
    })();
  }, [books, owner]);

  useEffect(() => {
    if (!heads.length || ready) return;
    void salaryDetails(books.db, owner).then((all) => {
      const last = all.length ? all[all.length - 1].effective_from : company?.fy_start ?? '';
      const mine = all.filter((r) => r.effective_from === last);
      setEff(fmtDate(last));
      setRows([
        ...mine.map((r) => {
          const ph = heads.find((h) => h.id === r.pay_head_id) ?? null;
          return { ph, text: ph?.name ?? '', rate: r.rate ? fmtAmount(r.rate, false) : '', per: r.per };
        }),
        blankRow(),
      ]);
      setReady(true);
    });
  }, [heads, books, owner, company, ready]);

  const focus = (sel: string) =>
    setTimeout(() => {
      const el = box.current?.querySelector(`[data-cell="${sel}"]`) as HTMLInputElement | null;
      el?.focus();
      el?.select?.();
    }, 0);
  const patch = (i: number, p: Partial<SalaryRowState>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));

  const save = async () => {
    const iso = parseDate(effRef.current, company?.fy_start);
    if (!iso) return toast('Effective From: invalid date', 'err');
    const lines = rowsRef.current.filter((r) => r.ph);
    try {
      const out = lines.map((r) => {
        const rate = rated(r.ph) ? parseAmount(r.rate) : 0;
        if (rate === null) throw new Error(`Rate for ${r.ph!.name}: enter a valid amount`);
        return { pay_head_id: r.ph!.id, rate, per: r.per };
      });
      await setSalaryDetails(books.db, owner, iso, out);
      bump();
      toast('Salary details saved', 'ok');
      nav.pop();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  const finish = async () => {
    if (await dialogs.confirm('Accept ?', { title: 'Accept', yes: 'Yes', no: 'No', corner: true })) void save();
  };
  useScreen({
    title: 'Salary Details Alteration',
    noPeriod: true,
    keys: { 'Ctrl+A': () => void save(), 'Alt+R': () => setRows((rs) => (rs.length > 1 ? rs.slice(0, -1) : rs)) },
    buttons: [
      { key: 'Alt+R', label: 'Remove Line', run: () => setRows((rs) => (rs.length > 1 ? rs.slice(0, -1) : rs)) },
      { key: 'Ctrl+A', label: 'Accept', run: () => void save() },
    ],
  });

  const opts: Opt[] = heads.map((h) => ({ id: h.id, label: h.name }));
  const cols = 'grid grid-cols-[120px_minmax(180px,1fr)_130px_90px_240px_190px_minmax(160px,1fr)]';
  return (
    <div ref={box} className="-m-4 min-h-[calc(100vh-90px)] bg-tb-paper px-3 pt-2">
      <div className="flex items-center"><span className="w-24">Name</span><span className="mr-2">:</span><b>{subject?.name}</b></div>
      <div className="flex items-center"><span className="w-24">Under</span><span className="mr-2">:</span><b>{subject?.under}</b></div>
      {subject?.primary ? null : <div className="ml-28 text-[13px] italic">(&#9830; Primary)</div>}
      <div className="mb-1 mt-3 text-center underline">Salary Details</div>
      <div className={`${cols} border-y border-tb-ink text-center font-bold`}>
        <span className="py-1">Effective From</span>
        <span className="py-1">Pay Head</span>
        <span className="py-1">Rate</span>
        <span className="py-1">Per</span>
        <span className="py-1">Pay Head Type</span>
        <span className="py-1">Calculation Type</span>
        <span className="py-1">Computed On</span>
      </div>
      <div className={`${cols} pt-1`}>
        <input
          className="tb-input mr-2 font-bold"
          data-cell="eff"
          value={eff}
          onChange={(e) => setEff(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation();
              const iso = parseDate(eff, company?.fy_start);
              if (!iso) return toast('Effective From: invalid date', 'err');
              setEff(fmtDate(iso));
              focus('p0');
            }
          }}
        />
        <div className="col-span-6">
          {rows.map((r, i) => (
            <div key={i} className="grid grid-cols-[minmax(180px,1fr)_130px_90px_240px_190px_minmax(160px,1fr)] items-center">
              <PickerInput
                className="tb-input w-full font-bold"
                value={r.text}
                title="Pay Heads"
                options={opts}
                inputRef={(el) => el?.setAttribute('data-cell', `p${i}`)}
                onChange={(t) => patch(i, { text: t, ph: null })}
                onPick={(o) => {
                  const ph = heads.find((h) => h.id === o.id)!;
                  patch(i, { ph, text: ph.name, per: ph.calc_type === 'On Attendance' ? ph.calc_period : 'Months' });
                  if (i === rowsRef.current.length - 1) setRows((rs) => [...rs, blankRow()]);
                  focus(rated(ph) ? `r${i}` : `p${i + 1}`);
                }}
                onEmptyEnter={() => void finish()}
                onNoMatch={() => toast('Pay Head: no match', 'err')}
                onBackspaceEmpty={() => focus(i === 0 ? 'eff' : `r${i - 1}`)}
              />
              {rated(r.ph) ? (
                <input
                  className="tb-input tb-num w-full"
                  data-cell={`r${i}`}
                  value={r.rate}
                  onChange={(e) => patch(i, { rate: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      e.stopPropagation();
                      const p = parseAmount(r.rate);
                      if (p === null) return toast('Enter a valid rate', 'err');
                      patch(i, { rate: p ? fmtAmount(p, false) : '' });
                      focus(r.ph!.calc_type === 'On Attendance' ? `u${i}` : `p${i + 1}`);
                    } else if (e.key === 'Backspace' && r.rate === '') {
                      e.preventDefault();
                      e.stopPropagation();
                      focus(`p${i}`);
                    }
                  }}
                />
              ) : (
                <span />
              )}
              {r.ph?.calc_type === 'On Attendance' ? (
                <PickerInput
                  className="tb-input w-full"
                  value={r.per}
                  title="Per"
                  options={enumOpts(PER_OPTIONS)}
                  inputRef={(el) => el?.setAttribute('data-cell', `u${i}`)}
                  onChange={(t) => patch(i, { per: t })}
                  onPick={(o) => {
                    patch(i, { per: String(o.id) });
                    focus(`p${i + 1}`);
                  }}
                  onNoMatch={() => toast('Per: no match', 'err')}
                  onBackspaceEmpty={() => focus(`r${i}`)}
                />
              ) : (
                <span className="px-1">{r.ph?.calc_type === 'Flat Rate' || r.ph?.calc_type === 'As User Defined Value' ? 'Months' : ''}</span>
              )}
              <span className="px-2 italic">{r.ph?.ph_type}</span>
              <span className="px-2 italic">{r.ph?.calc_type}</span>
              <span className="px-2 italic">{r.ph ? computedOn(r.ph, heads) : ''}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function AlterList<T extends { id: number }>({ title, heading, load, label, sub, form, create }: { title: string; heading: string; load: () => Promise<T[]>; label: (t: T) => string; sub?: (t: T) => string | undefined; form: (id: number) => ReactElement; create?: () => ReactElement }) {
  const nav = useNav();
  const rows = useList<T>(load);
  return (
    <SelectList
      title={title}
      heading={heading}
      items={rows.map((r) => ({ id: r.id, label: label(r), sub: sub?.(r) }))}
      onSelect={(i) => nav.push(form(Number(i.id)))}
      onCreate={create ? () => nav.push(create()) : undefined}
    />
  );
}

export function EmployeeAlterList() {
  const { books } = useStore();
  return <AlterList<Employee> title="Employees" heading="List of Employees" load={() => employees(books.db)} label={(e) => e.name} form={(id) => <EmployeeForm id={id} />} create={() => <EmployeeForm />} />;
}
export function EmployeeGroupAlterList() {
  const { books } = useStore();
  return <AlterList<EmployeeGroup> title="Employee Groups" heading="List of Employee Groups" load={() => employeeGroups(books.db)} label={(e) => e.name} form={(id) => <EmployeeGroupForm id={id} />} create={() => <EmployeeGroupForm />} />;
}
export function EmployeeCategoryAlterList() {
  const { books } = useStore();
  return <AlterList<EmployeeCategory> title="Employee Categories" heading="List of Employee Categories" load={() => employeeCategories(books.db)} label={(e) => e.name} form={(id) => <EmployeeCategoryForm id={id} />} create={() => <EmployeeCategoryForm />} />;
}
export function AttendanceTypeAlterList() {
  const { books } = useStore();
  return <AlterList<AttendanceType> title="Attendance/Production Types" heading="List of Attendance/Production Types" load={() => attendanceTypes(books.db)} label={(e) => e.name} sub={(e) => e.kind} form={(id) => <AttendanceTypeForm id={id} />} create={() => <AttendanceTypeForm />} />;
}
export function PayHeadAlterList() {
  const { books } = useStore();
  return <AlterList<PayHead> title="Pay Heads" heading="List of Pay Heads" load={() => payHeads(books.db)} label={(e) => e.name} sub={(e) => e.ph_type} form={(id) => <PayHeadForm id={id} />} create={() => <PayHeadForm />} />;
}

export function SalaryDetailsList() {
  const { books, version } = useStore();
  const nav = useNav();
  const [items, setItems] = useState<{ id: string; label: string; sub: string; owner: SalaryOwner }[]>([]);
  useEffect(() => {
    void Promise.all([employeeGroups(books.db), employees(books.db)]).then(([g, e]) =>
      setItems([
        ...g.map((x) => ({ id: `g${x.id}`, label: x.name, sub: 'Employee Group', owner: { group_id: x.id } as SalaryOwner })),
        ...e.map((x) => ({ id: `e${x.id}`, label: x.name, sub: 'Employee', owner: { employee_id: x.id } as SalaryOwner })),
      ])
    );
  }, [books, version]);
  const index = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  return <SelectList title="Salary Details" heading="List of Employees" items={items} onSelect={(i) => nav.push(<SalaryDetailsScreen owner={index.get(String(i.id))!.owner} />)} />;
}

const rupees = (v: unknown) => Number(v) || 0;

export function IncomeTaxDeclarationForm({ employeeId }: { employeeId: number }) {
  const { books, company, period } = useStore();
  const fy = fyOf(period.from || company?.fy_start || new Date().toISOString().slice(0, 10)).from;
  const [data, setData] = useState<{ name: string; t: Awaited<ReturnType<typeof employeeTax>> } | null>(null);
  useEffect(() => {
    void Promise.all([employee(books.db, employeeId), employeeTax(books.db, employeeId, fy)]).then(([e, t]) => setData({ name: e?.name ?? '', t }));
  }, [employeeId, fy]);
  if (!data) return null;
  const t = data.t;
  const old = (v: Record<string, unknown>) => v.regime === 'old';
  return (
    <Master
      title={`Income Tax Declarations : ${data.name}`}
      labelWidth={340}
      fields={[
        { key: 'regime', label: 'Applicable tax regime', kind: 'picker', title: 'Tax Regimes', options: regimeOpts, initial: regimeOpts.find((o) => o.id === t.regime), required: true, note: `Financial year from ${fmtDate(fy)}` },
        { key: 'previous_salary', label: 'Salary from previous employer', kind: 'amount', initial: t.previous_salary || undefined, heading: 'Previous Employer Details' },
        { key: 'previous_tds', label: 'Tax deducted by previous employer', kind: 'amount', initial: t.previous_tds || undefined },
        { key: 'other_income', label: 'Other income (other sources)', kind: 'amount', initial: t.other_income || undefined, heading: 'Other Income' },
        { key: 'home_loan_interest', label: 'Interest on housing loan (self-occupied)', kind: 'amount', initial: t.home_loan_interest || undefined, visible: old },
        { key: 'hra_exemption', label: 'House Rent Allowance exemption', kind: 'amount', initial: t.hra_exemption || undefined, visible: old, heading: 'Exemptions and Deductions (Regular Tax Regime)' },
        { key: 'sec80c', label: 'Investments (80C), excluding PF deducted', kind: 'amount', initial: t.sec80c || undefined, visible: old },
        { key: 'sec80ccd1b', label: 'Additional NPS contribution (80CCD(1B))', kind: 'amount', initial: t.sec80ccd1b || undefined, visible: old },
        { key: 'sec80d', label: 'Health insurance premium (80D)', kind: 'amount', initial: t.sec80d || undefined, visible: old },
        { key: 'other_deductions', label: 'Other Chapter VI-A deductions', kind: 'amount', initial: t.other_deductions || undefined, visible: old },
      ]}
      onSave={async (v) => {
        await saveEmployeeTax(books.db, employeeId, fy, {
          regime: (String(v.regime || 'new') as TaxRegime),
          previous_salary: rupees(v.previous_salary),
          previous_tds: rupees(v.previous_tds),
          other_income: rupees(v.other_income),
          home_loan_interest: rupees(v.home_loan_interest),
          hra_exemption: rupees(v.hra_exemption),
          sec80c: rupees(v.sec80c),
          sec80ccd1b: rupees(v.sec80ccd1b),
          sec80d: rupees(v.sec80d),
          other_deductions: rupees(v.other_deductions),
        });
      }}
    />
  );
}

export function IncomeTaxDeclarationList() {
  const { books } = useStore();
  return <AlterList<Employee> title="Income Tax Declarations" heading="List of Employees" load={() => employees(books.db)} label={(e) => e.name} form={(id) => <IncomeTaxDeclarationForm employeeId={id} />} />;
}

const SLAB_ROWS = 8;
const pctText = (bp: number) => String(bp / 100);
const toBp = (s: unknown) => Math.round((parseFloat(String(s ?? '').replace('%', '').trim()) || 0) * 100);

export function IncomeTaxSlabsForm({ regime }: { regime: TaxRegime }) {
  const { books, company, period, bump, toast } = useStore();
  const nav = useNav();
  const fy = fyOf(period.from || company?.fy_start || new Date().toISOString().slice(0, 10)).from;
  const [rules, setRules] = useState<TaxRules | null>(null);
  useEffect(() => void taxRules(books.db, fy, regime).then(setRules), [fy, regime]);
  if (!rules) return null;
  const slabFields = (key: 'slabs' | 'senior_slabs' | 'super_senior_slabs', heading: string): FieldDef[] =>
    Array.from({ length: SLAB_ROWS }, (_, i) => i).flatMap((i): FieldDef[] => [
      { key: `${key}_from_${i}`, label: `  Income above`, kind: 'amount', initial: rules[key][i]?.from || undefined, heading: i === 0 ? heading : undefined },
      { key: `${key}_rate_${i}`, label: `    Rate %`, kind: 'text', initial: rules[key][i] ? pctText(rules[key][i].rate_bp) : '' },
    ]);
  const readSlabs = (v: Record<string, unknown>, key: string) =>
    Array.from({ length: SLAB_ROWS }, (_, i) => ({ from: Number(v[`${key}_from_${i}`]) || 0, rate_bp: toBp(v[`${key}_rate_${i}`]), set: i === 0 || !!v[`${key}_from_${i}`] }))
      .filter((s) => s.set)
      .map(({ from, rate_bp }) => ({ from, rate_bp }));
  const reset = async () => {
    await resetTaxRules(books.db, fy, regime);
    bump();
    toast('Slabs restored to statutory defaults', 'ok');
    nav.pop();
  };
  return (
    <>
      <Master
        title={`Income Tax Slabs - ${TAX_REGIMES.find((r) => r.id === regime)?.label}`}
        labelWidth={300}
        fields={[
          { key: 'standard_deduction', label: 'Standard deduction', kind: 'amount', initial: rules.standard_deduction, heading: `Financial year from ${fmtDate(fy)} (Income-tax Act, ${rules.act})` },
          { key: 'rebate_limit', label: 'Rebate if total income does not exceed', kind: 'amount', initial: rules.rebate_limit },
          { key: 'rebate_max', label: 'Maximum rebate', kind: 'amount', initial: rules.rebate_max },
          { key: 'rebate_marginal', label: 'Marginal relief on rebate', kind: 'toggle', initial: rules.rebate_marginal },
          { key: 'cess', label: 'Health and Education Cess %', kind: 'text', initial: pctText(rules.cess_bp) },
          ...slabFields('slabs', 'Slabs'),
          ...(regime === 'old' ? [...slabFields('senior_slabs', 'Slabs for age 60 to 79'), ...slabFields('super_senior_slabs', 'Slabs for age 80 and above')] : []),
        ]}
        onSave={async (v) => {
          await saveTaxRules(books.db, {
            ...rules,
            standard_deduction: rupees(v.standard_deduction),
            rebate_limit: rupees(v.rebate_limit),
            rebate_max: rupees(v.rebate_max),
            rebate_marginal: !!v.rebate_marginal,
            cess_bp: toBp(v.cess),
            slabs: readSlabs(v, 'slabs'),
            senior_slabs: regime === 'old' ? readSlabs(v, 'senior_slabs') : [],
            super_senior_slabs: regime === 'old' ? readSlabs(v, 'super_senior_slabs') : [],
          });
        }}
      />
      <button className="mt-3 underline" onClick={() => void reset()}>Restore statutory slabs</button>
    </>
  );
}

export function IncomeTaxSlabsList() {
  const nav = useNav();
  return (
    <SelectList
      title="Income Tax Slabs"
      heading="List of Tax Regimes"
      items={TAX_REGIMES.map((r) => ({ id: r.id, label: r.label }))}
      onSelect={(i) => nav.push(<IncomeTaxSlabsForm regime={i.id as TaxRegime} />)}
    />
  );
}
