import { CoreError, one, type Db } from './db.ts';
import { clean } from './util.ts';
import { QTY_SCALE } from './inventory.ts';
import { ageOn } from './incometax.ts';
import { computeSalary, ensurePayroll, employees, isStatutoryPfCeiling, monthBounds, payHeadSide, payHeads, pfCeilingOn, pfWageCap, type Employee, type PayHead } from './payroll.ts';

export const PFESI_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS pr_employee_statutory (
    employee_id INTEGER PRIMARY KEY REFERENCES pr_employees(id),
    eps_number TEXT NOT NULL DEFAULT '',
    pf_joining TEXT NOT NULL DEFAULT '',
    eps_applicable INTEGER NOT NULL DEFAULT 1,
    esi_dispensary TEXT NOT NULL DEFAULT ''
  )`,
];

export const EPF_EE_BP = 1200;
export const EPS_BP = 833;
export const EPF_ADMIN_BP = 50;
export const EPF_ADMIN_MIN = 500_00;
export const EPF_ADMIN_MIN_NO_MEMBER = 75_00;
export const EDLI_BP = 50;
export const EDLI_ADMIN_BP = 0;
export const EPS_AGE_LIMIT = 58;
export const ESI_EE_BP = 75;
export const ESI_ER_BP = 325;
export const ESI_WAGE_LIMIT = 21000_00;

export const ESI_REASON_CODES: { code: number; label: string; lwd: boolean }[] = [
  { code: 0, label: 'Without Reason', lwd: false },
  { code: 1, label: 'On Leave', lwd: false },
  { code: 2, label: 'Left Service', lwd: true },
  { code: 3, label: 'Retired', lwd: true },
  { code: 4, label: 'Out of Coverage', lwd: true },
  { code: 5, label: 'Expired', lwd: true },
  { code: 6, label: 'Non Implemented area', lwd: true },
  { code: 7, label: 'Compliance by Immediate Employer', lwd: false },
  { code: 8, label: 'Suspension of work', lwd: false },
  { code: 9, label: 'Strike/Lockout', lwd: false },
  { code: 10, label: 'Retrenchment', lwd: true },
  { code: 11, label: 'No Work', lwd: false },
  { code: 12, label: 'Doesnt Belong To This Employer', lwd: false },
  { code: 13, label: 'Duplicate IP', lwd: false },
];

export interface EmployeeStatutory {
  employee_id: number;
  eps_number: string;
  pf_joining: string;
  eps_applicable: number;
  esi_dispensary: string;
}

async function ensurePfEsi(db: Db): Promise<void> {
  await ensurePayroll(db);
  await db.batch(PFESI_SCHEMA.map((sql) => ({ sql })));
}

export async function employeeStatutory(db: Db, employeeId: number): Promise<EmployeeStatutory> {
  await ensurePfEsi(db);
  return (
    (await one<EmployeeStatutory>(db, 'SELECT * FROM pr_employee_statutory WHERE employee_id = ?', [employeeId])) ?? {
      employee_id: employeeId,
      eps_number: '',
      pf_joining: '',
      eps_applicable: 1,
      esi_dispensary: '',
    }
  );
}

export async function saveEmployeeStatutory(db: Db, employeeId: number, input: Partial<Omit<EmployeeStatutory, 'employee_id'>>): Promise<EmployeeStatutory> {
  if (!(await one(db, 'SELECT 1 FROM pr_employees WHERE id = ?', [employeeId]))) throw new CoreError('not_found', 'Employee not found');
  const m = { ...(await employeeStatutory(db, employeeId)), ...input };
  if (m.pf_joining && !/^\d{4}-\d{2}-\d{2}$/.test(m.pf_joining)) throw new CoreError('invalid', 'Date of joining (PF) is invalid');
  await db.batch([
    {
      sql: 'INSERT OR REPLACE INTO pr_employee_statutory (employee_id, eps_number, pf_joining, eps_applicable, esi_dispensary) VALUES (?, ?, ?, ?, ?)',
      params: [employeeId, clean(m.eps_number, 30), m.pf_joining, m.eps_applicable ? 1 : 0, clean(m.esi_dispensary, 100)],
    },
  ]);
  return employeeStatutory(db, employeeId);
}

const rupees = (paise: number) => Math.round(paise / 100);
const ceilRupee = (paise: number) => Math.ceil(paise / 100) * 100;

interface MonthData {
  from: string;
  to: string;
  days: number;
  heads: Map<number, PayHead>;
  emps: Map<number, Employee>;
  stat: Map<number, EmployeeStatutory>;
  leaving: Map<number, string>;
  lines: Map<number, Map<number, number>>;
  lwp: Map<number, number>;
}

async function monthData(db: Db, date: string): Promise<MonthData> {
  await ensurePfEsi(db);
  const b = monthBounds(date);
  const heads = new Map((await payHeads(db)).map((h) => [h.id, h]));
  const emps = new Map((await employees(db)).map((e) => [e.id, e]));
  const stat = new Map((await db.select<EmployeeStatutory>('SELECT * FROM pr_employee_statutory')).map((s) => [s.employee_id, s]));
  const leaving = new Map((await db.select<{ employee_id: number; date_of_leaving: string }>("SELECT employee_id, date_of_leaving FROM pr_employee_terms WHERE date_of_leaving <> ''")).map((r) => [r.employee_id, r.date_of_leaving]));
  const lines = new Map<number, Map<number, number>>();
  for (const r of await db.select<{ employee_id: number; pay_head_id: number; amount: number }>(
    `SELECT l.employee_id, l.pay_head_id, SUM(l.amount) AS amount FROM pr_voucher_lines l JOIN vouchers v ON v.id = l.voucher_id
     WHERE v.date BETWEEN ? AND ? AND v.cancelled = 0 GROUP BY l.employee_id, l.pay_head_id`,
    [b.from, b.to]
  )) {
    const m = lines.get(r.employee_id) ?? new Map<number, number>();
    m.set(r.pay_head_id, r.amount);
    lines.set(r.employee_id, m);
  }
  const lwp = new Map<number, number>();
  for (const r of await db.select<{ employee_id: number; v: number }>(
    `SELECT a.employee_id, SUM(a.value) AS v FROM pr_attendance a JOIN pr_attendance_types t ON t.id = a.type_id
     WHERE t.kind = 'Attendance / Leave without Pay' AND a.date BETWEEN ? AND ? GROUP BY a.employee_id`,
    [b.from, b.to]
  ))
    lwp.set(r.employee_id, r.v);
  return { ...b, heads, emps, stat, leaving, lines, lwp };
}

function headBase(md: MonthData, ph: PayHead, amounts: Map<number, number>): number {
  if (ph.compute_basis === 'On Specified Formula') return ph.formula.reduce((s, f) => s + f.sign * (amounts.get(f.pay_head_id) ?? 0), 0);
  const want = ph.compute_basis === 'On Current Earnings Total' ? 'earn' : 'ded';
  let base = 0;
  for (const [id, amt] of amounts) {
    const h = md.heads.get(id);
    if (h && h.id !== ph.id && payHeadSide(h.ph_type) === want && h.affect_net && h.calc_type !== 'As Computed Value') base += amt;
  }
  return base;
}

function grossOf(md: MonthData, amounts: Map<number, number>): number {
  let g = 0;
  for (const [id, amt] of amounts) {
    const h = md.heads.get(id);
    if (h && payHeadSide(h.ph_type) === 'earn' && h.affect_net) g += amt;
  }
  return g;
}

function employment(md: MonthData, e: Employee): { days: number; leftOn: string } {
  const leftOn = md.leaving.get(e.id) ?? '';
  const start = e.date_of_joining && e.date_of_joining > md.from ? e.date_of_joining : md.from;
  const end = leftOn && leftOn < md.to ? leftOn : md.to;
  return { days: end >= start ? dayCount(start, end) : 0, leftOn: leftOn && leftOn <= md.to ? leftOn : '' };
}

const dayCount = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000) + 1;

const prevDay = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);

export interface PfRow {
  employee_id: number;
  name: string;
  emp_number: string;
  uan: string;
  pf_number: string;
  worked_days: number;
  gross: number;
  epf_wages: number;
  eps_wages: number;
  edli_wages: number;
  ee: number;
  eps: number;
  er: number;
  ncp_days: number;
  refund: number;
  above_age: boolean;
}

export interface PfAccounts {
  ac1: number;
  ac2: number;
  ac10: number;
  ac21: number;
  ac22: number;
  total: number;
}

export interface PfStatement {
  from: string;
  to: string;
  ceiling: number;
  rows: PfRow[];
  totals: Pick<PfRow, (typeof PF_NUM)[number]>;
  accounts: PfAccounts;
  months: ({ month: string } & PfAccounts)[];
}

async function pfMonth(db: Db, date: string): Promise<PfRow[]> {
  const md = await monthData(db, date);
  const pfHeads = [...md.heads.values()].filter((h) => h.statutory === 'PF' && payHeadSide(h.ph_type) === 'ded');
  const out: PfRow[] = [];
  for (const [eid, amounts] of md.lines) {
    const e = md.emps.get(eid);
    if (!e) continue;
    const used = pfHeads.filter((h) => (amounts.get(h.id) ?? 0) > 0);
    if (!used.length) continue;
    const st = md.stat.get(eid);
    const eePaise = used.reduce((s, h) => s + (amounts.get(h.id) ?? 0), 0);
    let wages = 0;
    let raw = 0;
    for (const h of used) {
      let base = Math.max(0, headBase(md, h, amounts));
      raw = Math.max(raw, base);
      if (isStatutoryPfCeiling(h)) base = pfWageCap(base, md.from, md.to);
      else if (h.ceiling && base > h.ceiling) base = h.ceiling;
      wages = Math.max(wages, base);
    }
    if (!wages) wages = raw = Math.round((eePaise * 10000) / (used[0].rate_bp || EPF_EE_BP));
    const capped = Math.min(wages, pfWageCap(raw, md.from, md.to));
    const aboveAge = !!e.date_of_birth && ageOn(e.date_of_birth, md.from) >= EPS_AGE_LIMIT;
    const epsOn = !aboveAge && (st ? !!st.eps_applicable : true);
    const epfW = rupees(wages);
    const epsW = epsOn ? rupees(capped) : 0;
    const ee = rupees(eePaise);
    const eps = Math.round((epsW * EPS_BP) / 10000);
    const span = employment(md, e);
    const ncp = epfW ? Math.min(md.days, Math.ceil((md.lwp.get(eid) ?? 0) / QTY_SCALE)) : md.days;
    out.push({
      employee_id: eid,
      name: e.name,
      emp_number: e.emp_number,
      uan: e.uan,
      pf_number: e.pf_number,
      worked_days: Math.max(0, span.days - ncp),
      gross: rupees(grossOf(md, amounts)),
      epf_wages: epfW,
      eps_wages: epsW,
      edli_wages: rupees(capped),
      ee,
      eps,
      er: Math.max(0, ee - eps),
      ncp_days: ncp,
      refund: 0,
      above_age: aboveAge,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function monthStarts(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}-01`);
    m += 1;
    if (m > 12) (m = 1), (y += 1);
  }
  return out;
}

const PF_NUM = ['worked_days', 'gross', 'epf_wages', 'eps_wages', 'edli_wages', 'ee', 'eps', 'er', 'ncp_days', 'refund'] as const;

function monthAccounts(rows: PfRow[]): PfAccounts {
  if (!rows.length) return { ac1: 0, ac2: 0, ac10: 0, ac21: 0, ac22: 0, total: 0 };
  const sum = (k: (typeof PF_NUM)[number]) => rows.reduce((s, r) => s + r[k], 0);
  const ac1 = sum('ee') + sum('er');
  const ac2 = Math.max(EPF_ADMIN_MIN / 100, Math.round((sum('epf_wages') * EPF_ADMIN_BP) / 10000));
  const ac10 = sum('eps');
  const ac21 = Math.round((sum('edli_wages') * EDLI_BP) / 10000);
  const ac22 = Math.round((sum('edli_wages') * EDLI_ADMIN_BP) / 10000);
  return { ac1, ac2, ac10, ac21, ac22, total: ac1 + ac2 + ac10 + ac21 + ac22 };
}

export async function pfStatement(db: Db, from: string, to: string): Promise<PfStatement> {
  const by = new Map<number, PfRow>();
  const months: PfStatement['months'] = [];
  for (const ms of monthStarts(from, to)) {
    const rows = await pfMonth(db, ms);
    if (rows.length) months.push({ month: ms, ...monthAccounts(rows) });
    for (const r of rows) {
      const cur = by.get(r.employee_id);
      if (!cur) by.set(r.employee_id, { ...r });
      else {
        for (const k of PF_NUM) cur[k] += r[k];
        cur.above_age = cur.above_age || r.above_age;
      }
    }
  }
  const rows = [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
  const totals = Object.fromEntries(PF_NUM.map((k) => [k, rows.reduce((s, r) => s + r[k], 0)])) as PfStatement['totals'];
  const acc = (k: keyof PfAccounts) => months.reduce((s, m) => s + m[k], 0);
  return {
    from,
    to,
    ceiling: pfCeilingOn(to),
    rows,
    totals,
    accounts: { ac1: acc('ac1'), ac2: acc('ac2'), ac10: acc('ac10'), ac21: acc('ac21'), ac22: acc('ac22'), total: acc('total') },
    months,
  };
}

export const ECR_SEPARATOR = '#~#';

export function ecrLine(r: Pick<PfRow, 'uan' | 'name' | 'gross' | 'epf_wages' | 'eps_wages' | 'edli_wages' | 'ee' | 'eps' | 'er' | 'ncp_days' | 'refund'>): string {
  const name = r.name.toUpperCase().replace(/[^A-Z .]/g, ' ').replace(/\s+/g, ' ').trim();
  return [r.uan.trim(), name, r.gross, r.epf_wages, r.eps_wages, r.edli_wages, r.ee, r.eps, r.er, r.ncp_days, r.refund].join(ECR_SEPARATOR);
}

export interface EcrFile {
  text: string;
  rows: PfRow[];
  errors: string[];
}

export async function ecrFile(db: Db, monthDate: string): Promise<EcrFile> {
  const b = monthBounds(monthDate);
  const rows = await pfMonth(db, b.from);
  const errors: string[] = [];
  for (const r of rows) {
    if (!/^\d{12}$/.test(r.uan.trim())) errors.push(`${r.name}: UAN must be 12 digits`);
    if (r.epf_wages > r.gross) errors.push(`${r.name}: EPF wages exceed gross wages`);
    if (r.eps_wages > r.epf_wages) errors.push(`${r.name}: EPS wages exceed EPF wages`);
  }
  return { text: rows.map(ecrLine).join('\r\n') + (rows.length ? '\r\n' : ''), rows, errors };
}

export interface EsiRow {
  employee_id: number;
  name: string;
  emp_number: string;
  ip_number: string;
  days: number;
  fixed_wages: number;
  wages: number;
  ee: number;
  er: number;
  total: number;
  reason_code: number | null;
  last_working_day: string;
}

export interface EsiStatement {
  from: string;
  to: string;
  rows: EsiRow[];
  totals: { days: number; fixed_wages: number; wages: number; ee: number; er: number; total: number };
}

async function esiMonth(db: Db, date: string): Promise<EsiRow[]> {
  const md = await monthData(db, date);
  const eeHeads = [...md.heads.values()].filter((h) => h.statutory === 'ESI' && payHeadSide(h.ph_type) === 'ded');
  const erHeads = [...md.heads.values()].filter((h) => h.statutory === 'ESI' && payHeadSide(h.ph_type) === 'emp');
  const out: EsiRow[] = [];
  for (const [eid, e] of md.emps) {
    const amounts = md.lines.get(eid) ?? new Map<number, number>();
    const ee = eeHeads.reduce((s, h) => s + (amounts.get(h.id) ?? 0), 0);
    const erPosted = erHeads.reduce((s, h) => s + (amounts.get(h.id) ?? 0), 0);
    const covered = ee > 0 || erPosted > 0;
    const span = employment(md, e);
    const inService = !!e.esi_number && (!e.date_of_joining || e.date_of_joining <= md.to) && (span.days > 0 || !!span.leftOn);
    if (!covered && !inService) continue;
    const leftBefore = md.leaving.get(eid);
    if (!covered && leftBefore && leftBefore < md.from) continue;
    const used = eeHeads.filter((h) => (amounts.get(h.id) ?? 0) > 0);
    let wages = used.length ? Math.max(...used.map((h) => Math.max(0, headBase(md, h, amounts)))) : 0;
    if (!wages && ee) wages = Math.round((ee * 10000) / (used[0]?.rate_bp || ESI_EE_BP));
    if (!wages && covered) wages = grossOf(md, amounts);
    if (!covered) wages = 0;
    const days = covered ? Math.max(0, Math.ceil(span.days - (md.lwp.get(eid) ?? 0) / QTY_SCALE)) : 0;
    const er = erPosted || (wages ? ceilRupee((wages * ESI_ER_BP) / 10000) : 0);
    let reason: number | null = null;
    let lwd = '';
    if (!days) {
      if (span.leftOn) (reason = 2), (lwd = span.leftOn);
      else if (grossOf(md, amounts) > 0) (reason = 4), (lwd = prevDay(md.from));
      else reason = 1;
    }
    let fixed = 0;
    if (covered) for (const l of await computeSalary(db, eid, md.to, { skipTax: true })) if (l.side === 'earn' && l.affect_net) fixed += l.gross;
    out.push({ employee_id: eid, name: e.name, emp_number: e.emp_number, ip_number: e.esi_number, days, fixed_wages: fixed, wages, ee, er, total: ee + er, reason_code: reason, last_working_day: lwd });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function esiStatement(db: Db, from: string, to: string): Promise<EsiStatement> {
  const by = new Map<number, EsiRow>();
  for (const ms of monthStarts(from, to)) {
    for (const r of await esiMonth(db, ms)) {
      const cur = by.get(r.employee_id);
      if (!cur) by.set(r.employee_id, { ...r });
      else {
        for (const k of ['days', 'fixed_wages', 'wages', 'ee', 'er', 'total'] as const) cur[k] += r[k];
        cur.reason_code = r.reason_code;
        cur.last_working_day = r.last_working_day || cur.last_working_day;
      }
    }
  }
  const rows = [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
  const sum = (k: 'days' | 'fixed_wages' | 'wages' | 'ee' | 'er' | 'total') => rows.reduce((s, r) => s + r[k], 0);
  return { from, to, rows, totals: { days: sum('days'), fixed_wages: sum('fixed_wages'), wages: sum('wages'), ee: sum('ee'), er: sum('er'), total: sum('total') } };
}

export const ESI_MC_HEADERS = [
  'IP Number \n(10 Digits)',
  'IP Name\n( Only alphabets and space )',
  'No of Days for which wages paid/payable during the month',
  'Total Monthly Wages',
  ' Reason Code for Zero workings days(numeric only; provide 0 for all other reasons- Click on the link for reference)',
  ' Last Working Day\n( Format DD/MM/YYYY  or DD-MM-YYYY)',
];

const ddmmyyyy = (iso: string) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');

export interface EsiUpload {
  rows: string[][];
  errors: string[];
}

export async function esiMonthlyUpload(db: Db, monthDate: string): Promise<EsiUpload> {
  const b = monthBounds(monthDate);
  const st = await esiStatement(db, b.from, b.to);
  const errors: string[] = [];
  const rows: string[][] = [ESI_MC_HEADERS];
  for (const r of st.rows) {
    if (!/^\d{10}$/.test(r.ip_number.trim())) errors.push(`${r.name}: IP number must be 10 digits`);
    const name = r.name.replace(/[^A-Za-z ]/g, ' ').replace(/\s+/g, ' ').trim();
    const zero = r.days === 0;
    const code = zero ? r.reason_code ?? 0 : null;
    const lwd = zero && ESI_REASON_CODES.find((c) => c.code === code)?.lwd ? ddmmyyyy(r.last_working_day) : '';
    rows.push([r.ip_number.trim(), name, String(r.days), String(rupees(r.wages)), code === null ? '' : String(code), lwd]);
  }
  return { rows, errors };
}

export interface ContributionMonth {
  month: string;
  wages: number;
  ee: number;
  er: number;
  eps: number;
  refund: number;
  ncp_days: number;
}

export interface Form3A {
  employee_id: number;
  name: string;
  uan: string;
  pf_number: string;
  months: ContributionMonth[];
  totals: Omit<ContributionMonth, 'month'>;
}

export async function form3A(db: Db, from: string, to: string): Promise<Form3A[]> {
  const by = new Map<number, Form3A>();
  for (const ms of monthStarts(from, to)) {
    for (const r of await pfMonth(db, ms)) {
      const cur = by.get(r.employee_id) ?? { employee_id: r.employee_id, name: r.name, uan: r.uan, pf_number: r.pf_number, months: [], totals: { wages: 0, ee: 0, er: 0, eps: 0, refund: 0, ncp_days: 0 } };
      const m: ContributionMonth = { month: ms, wages: r.epf_wages, ee: r.ee, er: r.er, eps: r.eps, refund: r.refund, ncp_days: r.ncp_days };
      cur.months.push(m);
      for (const k of ['wages', 'ee', 'er', 'eps', 'refund', 'ncp_days'] as const) cur.totals[k] += m[k];
      by.set(r.employee_id, cur);
    }
  }
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
}
