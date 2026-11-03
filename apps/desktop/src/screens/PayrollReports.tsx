import { useEffect, useMemo, useState } from 'react';
import { attendanceSheet, employeeVouchers, employees, fmtAmount, fmtDate, fmtQty, gratuityReport, incomeTaxComputation, paySlip, payrollStatement, type Employee, type TreeRow } from '@tallybook/core';
import { useScreen } from '../registry.ts';
import { useStore } from '../store.tsx';
import { useNav } from '../nav.tsx';
import { SelectList } from './SelectList.tsx';
import { Frame, th, rowCls, useLoad, usePeriodKey, useSel } from './Reports.tsx';
import { useFilter, useReportOptions } from './reportConfig.tsx';
import { PayrollVoucherScreen } from './PayrollVoucher.tsx';

const cell = 'px-2 text-right tabular-nums';
const rule = 'border-y-[3px] border-double border-tb-ink';

export function PickEmployee({ title = 'Employee', onPick, popOnSelect = true }: { title?: string; onPick: (e: Employee) => void; popOnSelect?: boolean }) {
  const { books, version } = useStore();
  const [rows, setRows] = useState<Employee[]>([]);
  useEffect(() => void employees(books.db).then(setRows), [books, version]);
  return <SelectList title={title} heading="List of Employees" popOnSelect={popOnSelect} items={rows.map((e) => ({ id: e.id, label: e.name }))} onSelect={(i) => onPick(rows.find((e) => e.id === i.id)!)} />;
}

export function PaySlipPicker() {
  const nav = useNav();
  return <PickEmployee title="Pay Slip" popOnSelect={false} onPick={(e) => nav.push(<PaySlipReport employeeId={e.id} />)} />;
}

export function EmployeeVouchersPicker() {
  const nav = useNav();
  return <PickEmployee title="Employee Vouchers" popOnSelect={false} onPick={(e) => nav.push(<EmployeeVouchersReport employeeId={e.id} />)} />;
}

const SLIP_DEFS = [
  { key: 'attendance', label: 'Show Attendance/Production details', default: true },
  { key: 'gross', label: 'Show Gross Salary', default: true },
  { key: 'details', label: 'Show Employee details', default: true },
  { key: 'joining', label: '  Show Joining Date', default: true },
  { key: 'zero', label: 'Remove zero-valued transactions', default: true },
];

export function PaySlipReport({ employeeId }: { employeeId: number }) {
  const { books, period } = useStore();
  const nav = useNav();
  const p = usePeriodKey();
  const cfg = useReportOptions('payslip', 'Pay Slip', SLIP_DEFS);
  const [id, setId] = useState(employeeId);
  const data = useLoad(() => paySlip(books.db, id, period.from, period.to), [id, period]);
  const change = () => nav.push(<PickEmployee onPick={(e) => setId(e.id)} />);
  useScreen({ title: 'Pay Slip', keys: { ...p.key, ...cfg.key, F4: change }, buttons: [p.button, { key: 'F4', label: 'Employee', run: change }, cfg.button] });
  if (!data) return null;
  const o = cfg.values;
  const e = data.employee;
  const left: [string, string][] = [
    ['Employee Number', e.emp_number],
    ['Function', e.function],
    ['Designation', e.designation],
    ['Location', e.location],
    ['Bank Details', [e.bank_account, e.bank_branch].filter(Boolean).join(', ')],
    ...(o.joining ? ([['Date of joining', e.date_of_joining ? fmtDate(e.date_of_joining) : '']] as [string, string][]) : []),
  ];
  const right: [string, string][] = [
    ['Income Tax Number (PAN)', e.pan],
    ['Universal Account Number (UAN)', e.uan],
    ['PF account number', e.pf_number],
    ['ESI Number', e.esi_number],
    ['PR Account Number (PRAN)', e.pran],
  ];
  const keep = <T extends { amount: number }>(a: T[]) => (o.zero ? a.filter((x) => x.amount) : a);
  const earnings = keep(data.earnings);
  const deductions = keep(data.deductions);
  const att = o.zero ? data.attendance.filter((a) => a.value) : data.attendance;
  const n = Math.max(earnings.length, deductions.length, 6);
  const rows = Array.from({ length: n }, (_, i) => i);
  const kv = (list: [string, string][]) =>
    list.map(([k, v]) => (
      <div key={k} className="flex">
        <span className="w-64">{k}</span>
        <span className="mr-2">:</span>
        <span>{v}</span>
      </div>
    ));
  return (
    <Frame title="Pay Slip" subtitle={`${fmtDate(period.from)} to ${fmtDate(period.to)}`}>
      <div className="text-center">
        <div className="font-semibold underline">{data.title}</div>
        <div className="mt-2 font-bold">{e.name}</div>
      </div>
      {o.details && (
        <div className="mt-4 grid grid-cols-2 gap-6">
          <div>{kv(left)}</div>
          <div>{kv(right)}</div>
        </div>
      )}
      {o.attendance && (
        <table className="mt-4 w-1/2 border border-tb-line">
          <thead>
            <tr>
              <th className={`${th} text-left`}>Attendance Details</th>
              <th className={`${th} text-right`}>Value</th>
            </tr>
          </thead>
          <tbody>
            {att.length === 0 && (
              <tr>
                <td className="px-2">&nbsp;</td>
                <td />
              </tr>
            )}
            {att.map((a) => (
              <tr key={a.name}>
                <td className="px-2">{a.name}</td>
                <td className={cell}>{`${fmtQty(a.value)} ${a.unit}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="mt-4 grid grid-cols-2 border border-tb-line">
        {[
          { head: 'Earnings', list: earnings, total: data.total_earnings, gross: data.gross_earnings, label: 'Total Earnings' },
          { head: 'Deductions', list: deductions, total: data.total_deductions, gross: data.gross_deductions, label: 'Total Deductions' },
        ].map((side) => (
          <table key={side.head} className="w-full border-collapse">
            <thead>
              <tr>
                <th className={`${th} text-left`}>{side.head}</th>
                <th className={`${th} text-right`}>Amount</th>
                {o.gross && <th className={`${th} text-right`}>Gross Salary</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i}>
                  <td className="px-2">{side.list[i]?.name ?? ' '}</td>
                  <td className={cell}>{side.list[i] ? fmtAmount(side.list[i].amount, false) : ''}</td>
                  {o.gross && <td className={cell}>{side.list[i] ? fmtAmount(side.list[i].gross, false) : ''}</td>}
                </tr>
              ))}
              <tr className="font-bold">
                <td className="border-t border-tb-ink px-2">{side.label}</td>
                <td className={`${cell} border-t border-tb-ink`}>{fmtAmount(side.total, false)}</td>
                {o.gross && <td className={`${cell} border-t border-tb-ink`}>{fmtAmount(side.gross, false)}</td>}
              </tr>
              {side.head === 'Deductions' ? (
                <tr className="font-bold">
                  <td className="px-2">Net Amount</td>
                  <td className={cell}>{`₹ ${fmtAmount(data.net, false)}`}</td>
                  {o.gross && <td className={cell}>{`₹ ${fmtAmount(data.gross_net, false)}`}</td>}
                </tr>
              ) : (
                <tr>
                  <td colSpan={3}>&nbsp;</td>
                </tr>
              )}
            </tbody>
          </table>
        ))}
      </div>
    </Frame>
  );
}

const TREE_DEFS = [
  { key: 'tree', label: 'Show Employees by Categories & Groups', default: true },
  { key: 'totals', label: '  Show Category / Group Total', default: true },
  { key: 'zero', label: 'Remove zero-valued transactions', default: true },
];

function useTreeRows(rows: TreeRow[] | undefined, o: Record<string, boolean>, match: (...p: string[]) => boolean) {
  return useMemo(() => {
    if (!rows) return [];
    const nonZero = (r: TreeRow) => Object.values(r.values).some((v) => v);
    let out = rows;
    if (!o.tree) out = [rows[0], ...rows.filter((r) => r.kind === 'employee').map((r) => ({ ...r, level: 1 }))];
    if (o.zero) out = out.filter((r) => r.kind === 'category' || nonZero(r));
    return out.filter((r) => r.kind === 'category' || match(r.name));
  }, [rows, o.tree, o.zero, match]);
}

export function PayrollStatementReport() {
  const { books, period } = useStore();
  const nav = useNav();
  const p = usePeriodKey();
  const cfg = useReportOptions('payroll-statement', 'Payroll Statement', TREE_DEFS);
  const flt = useFilter();
  const data = useLoad(() => payrollStatement(books.db, period.from, period.to), [period]);
  const rows = useTreeRows(data?.rows, cfg.values, flt.match);
  const { sel, setSel, keys } = useSel(rows.length);
  const open = (i: number) => {
    const r = rows[i];
    if (r?.kind === 'employee') nav.push(<EmployeeVouchersReport employeeId={r.id} />);
  };
  useScreen({ title: 'Payroll Statement', keys: { ...keys, ...p.key, ...cfg.key, ...flt.key, Enter: () => open(sel) }, buttons: [p.button, cfg.button, flt.button] });
  if (!data) return null;
  const cols = data.columns;
  return (
    <Frame title="Payroll Statement">
      {flt.bar}
      <div className="mb-1 font-bold">For all employees</div>
      <table className="w-full">
        <thead>
          <tr>
            <th className={`${th} text-left`}>Particulars</th>
            {cols.map((c) => (
              <th key={c.id} className={`${th} text-right italic`}>{c.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.kind}${r.id}`} className={rowCls(i === sel, r.kind === 'employee' ? '' : 'font-bold')} onMouseEnter={() => setSel(i)} onClick={() => open(i)}>
              <td style={{ paddingLeft: 8 + r.level * 16 }}>{r.name}</td>
              {cols.map((c) => (
                <td key={c.id} className={cell}>{r.kind === 'group' && !cfg.values.totals ? '' : fmtAmount(r.values[c.id] ?? 0)}</td>
              ))}
            </tr>
          ))}
          <tr className="font-bold">
            <td className={`${rule} px-2`}>Grand Total</td>
            {cols.map((c) => (
              <td key={c.id} className={`${cell} ${rule}`}>{fmtAmount(data.rows[0]?.values[c.id] ?? 0)}</td>
            ))}
          </tr>
        </tbody>
      </table>
      {data.rows.length <= 1 && <div className="py-3 text-tb-muted">No payroll vouchers in this period.</div>}
    </Frame>
  );
}

const ATT_DEFS = [...TREE_DEFS, { key: 'tail', label: 'Show tail unit of Production Types', default: true }];

export function AttendanceSheetReport() {
  const { books, period } = useStore();
  const p = usePeriodKey();
  const cfg = useReportOptions('attendance-sheet', 'Attendance Sheet', ATT_DEFS);
  const flt = useFilter();
  const data = useLoad(() => attendanceSheet(books.db, period.from, period.to), [period]);
  const rows = useTreeRows(data?.rows, cfg.values, flt.match);
  const { sel, setSel, keys } = useSel(rows.length);
  useScreen({ title: 'Attendance Sheet', keys: { ...keys, ...p.key, ...cfg.key, ...flt.key }, buttons: [p.button, cfg.button, flt.button] });
  if (!data) return null;
  const show = (v: number | undefined, unit: string) => (v ? `${fmtQty(v)}${cfg.values.tail ? ` ${unit}` : ''}` : '');
  return (
    <Frame title="Attendance Sheet">
      {flt.bar}
      <div className="mb-1 font-bold">For all employees</div>
      <table className="w-full">
        <thead>
          <tr>
            <th className={`${th} text-left`}>Particulars</th>
            {data.columns.map((c) => (
              <th key={c.id} className={`${th} text-right font-normal`}>{c.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.kind}${r.id}`} className={rowCls(i === sel, r.kind === 'employee' ? '' : 'font-bold')} onMouseEnter={() => setSel(i)}>
              <td style={{ paddingLeft: 8 + r.level * 16 }}>{r.name}</td>
              {data.columns.map((c) => (
                <td key={c.id} className={cell}>{r.kind === 'group' && !cfg.values.totals ? '' : show(r.values[c.id], c.unit)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {data.rows.length <= 1 && <div className="py-3 text-tb-muted">No attendance recorded in this period.</div>}
    </Frame>
  );
}

export function EmployeeVouchersReport({ employeeId, payHeadId }: { employeeId: number; payHeadId?: number }) {
  const { books, period } = useStore();
  const nav = useNav();
  const p = usePeriodKey();
  const [id, setId] = useState(employeeId);
  const emps = useLoad(() => employees(books.db), []);
  const data = useLoad(() => employeeVouchers(books.db, id, period.from, period.to, payHeadId), [id, period]);
  const rows = data?.rows ?? [];
  const { sel, setSel, keys } = useSel(rows.length);
  const open = (i: number) => rows[i] && nav.push(<PayrollVoucherScreen voucherId={rows[i].voucher_id} />);
  const change = () => nav.push(<PickEmployee onPick={(e) => setId(e.id)} />);
  useScreen({ title: 'Employee Vouchers', keys: { ...keys, ...p.key, Enter: () => open(sel), F4: change }, buttons: [p.button, { key: 'F4', label: 'Employees', run: change }] });
  if (!data || !emps) return null;
  const name = emps.find((e) => e.id === id)?.name ?? '';
  const net = data.debit - data.credit;
  return (
    <Frame title="Employee Vouchers">
      <div className="mb-1">
        Employee : <b>{name}</b>
      </div>
      <table className="w-full">
        <thead>
          <tr>
            <th className={`${th} text-left`}>Date</th>
            <th className={`${th} text-left`}>Particulars</th>
            <th className={`${th} text-left`}>Vch Type</th>
            <th className={`${th} text-left`}>Vch No.</th>
            <th className={`${th} text-right`}>Debit</th>
            <th className={`${th} text-right`}>Credit</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.voucher_id} className={`${rowCls(i === sel)} align-top`} onMouseEnter={() => setSel(i)} onClick={() => open(i)}>
              <td className="px-2">{fmtDate(r.date)}</td>
              <td className="px-2">
                <div className="font-bold">(as per details)</div>
                {r.lines.map((l) => (
                  <div key={l.pay_head_id} className="flex justify-between pl-6 text-[14px]">
                    <span className="font-semibold">{l.name}</span>
                    <span className="tabular-nums">{`${fmtAmount(Math.abs(l.amount))} ${l.amount > 0 ? 'Dr' : 'Cr'}`}</span>
                  </div>
                ))}
              </td>
              <td className="px-2 font-bold">{r.type}</td>
              <td className="px-2">{r.number}</td>
              <td className={cell}>{fmtAmount(r.debit)}</td>
              <td className={cell}>{fmtAmount(r.credit)}</td>
            </tr>
          ))}
          <tr>
            <td className="px-2 text-right" colSpan={4}>Current Total :</td>
            <td className={`${cell} border-t border-tb-ink`}>{fmtAmount(data.debit)}</td>
            <td className={`${cell} border-t border-tb-ink`}>{fmtAmount(data.credit)}</td>
          </tr>
          <tr className="font-bold">
            <td className={`${rule} px-2 text-right`} colSpan={4}>Closing Balance :</td>
            <td className={`${cell} ${rule}`}>{net > 0 ? fmtAmount(net) : ''}</td>
            <td className={`${cell} ${rule}`}>{net < 0 ? fmtAmount(-net) : ''}</td>
          </tr>
        </tbody>
      </table>
    </Frame>
  );
}

export function IncomeTaxComputationPicker() {
  const nav = useNav();
  return <PickEmployee title="Income Tax Computation" popOnSelect={false} onPick={(e) => nav.push(<IncomeTaxComputationReport employeeId={e.id} />)} />;
}

const monthLabel = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]}-${y}`;
};

const COMP_DEFS = [{ key: 'months', label: 'Show month-wise salary projection', default: true }];

export function IncomeTaxComputationReport({ employeeId }: { employeeId: number }) {
  const { books, period } = useStore();
  const nav = useNav();
  const p = usePeriodKey();
  const cfg = useReportOptions('income-tax-computation', 'Income Tax Computation', COMP_DEFS);
  const [id, setId] = useState(employeeId);
  const data = useLoad(() => incomeTaxComputation(books.db, id, period.to), [id, period]);
  const change = () => nav.push(<PickEmployee onPick={(e) => setId(e.id)} />);
  useScreen({ title: 'Income Tax Computation', keys: { ...p.key, ...cfg.key, F4: change }, buttons: [p.button, { key: 'F4', label: 'Employee', run: change }, cfg.button] });
  if (!data) return null;
  const e = data.employee;
  const old = data.regime === 'old';
  const fyLabel = `${fmtDate(data.fy_start)} to ${fmtDate(data.fy_end)}`;
  const kv = (list: [string, string][]) =>
    list.map(([k, v]) => (
      <div key={k} className="flex">
        <span className="w-56">{k}</span>
        <span className="mr-2">:</span>
        <span className="font-bold">{v}</span>
      </div>
    ));
  type Row = { no?: string; label: string; inner?: number; amount?: number; italic?: boolean; bold?: boolean };
  let n = 0;
  const no = () => `${++n}.`;
  const rows: Row[] = [
    { no: no(), label: 'Gross Salary', amount: data.gross_salary, bold: true },
    { label: 'Salary as per provisions contained in section 17(1)', inner: data.salary, italic: true },
    ...(data.previous_salary ? [{ label: 'Salary from previous employer', inner: data.previous_salary, italic: true }] : []),
    ...(old ? [{ no: no(), label: 'Less: Allowance to the extent exempt', amount: data.hra_exemption, bold: true }, { label: 'House Rent Allowance', inner: data.hra_exemption, italic: true }] : []),
    { no: no(), label: 'Balance', amount: data.balance, bold: true },
    { no: no(), label: `Deductions U/s ${data.act === '2025' ? '19' : '16'}`, amount: data.standard_deduction + data.professional_tax, bold: true },
    { label: 'Standard Deduction', inner: data.standard_deduction, italic: true },
    ...(old ? [{ label: 'Tax on Employment (Professional Tax)', inner: data.professional_tax, italic: true }] : []),
    { no: no(), label: 'Total Income from Salary', amount: data.income_from_salary, bold: true },
    { no: no(), label: 'Add: Other Income declared by Employee', amount: data.other_income - data.home_loan_interest, bold: true },
    { label: 'Other Income (Other Sources)', inner: data.other_income, italic: true },
    ...(old ? [{ label: 'Less: Interest on Housing Loan', inner: -data.home_loan_interest, italic: true }] : []),
    { no: no(), label: 'Gross Total Income', amount: data.gross_total_income, bold: true },
    ...(old ? [{ no: no(), label: 'Deductions under Chapter VI-A', amount: data.total_deductions, bold: true }, ...data.deductions.map((d) => ({ label: d.label, inner: d.allowed, italic: true }))] : []),
    { no: no(), label: 'Total Income (rounded off)', amount: data.total_income, bold: true },
    { no: no(), label: 'Tax on Total Income', amount: data.tax.slab_tax, bold: true },
    { no: no(), label: `Less: Rebate U/s ${data.act === '2025' ? '156' : '87A'}`, amount: data.tax.rebate, bold: true },
    { no: no(), label: 'Surcharge', amount: data.tax.surcharge, bold: true },
    { no: no(), label: 'Health and Education Cess', amount: data.tax.cess, bold: true },
    { no: no(), label: 'Tax Payable (rounded off)', amount: data.tax.total, bold: true },
    { no: no(), label: 'Less: Tax deducted by previous employer', amount: data.previous_tds, bold: true },
    { no: no(), label: `Less: Tax deducted till ${monthLabel(data.computed_for)}`, amount: data.deducted, bold: true },
    { label: 'Balance Tax Payable / Deductible', amount: data.balance_tax, bold: true },
  ];
  return (
    <Frame title="Income Tax Computation" subtitle={`Financial Year: ${fyLabel}`}>
      <div className="mb-2">Income Tax Computation for : <b>{e.name}</b></div>
      <div className="grid grid-cols-3 gap-4 border-y border-tb-line py-2">
        <div>{kv([['Employee No.', e.emp_number], ['Gender', e.gender], ['Date of joining', e.date_of_joining ? fmtDate(e.date_of_joining) : ''], ['Date of Birth', e.date_of_birth ? fmtDate(e.date_of_birth) : '']])}</div>
        <div>{kv([['PAN Number', e.pan || 'PANNOTAVBL'], ['Computed for the month', monthLabel(data.computed_for)], ['Tax Year', `${data.fy_start.slice(0, 4)}-${data.fy_end.slice(2, 4)}`], ['Act', data.act === '2025' ? 'Income-tax Act, 2025' : 'Income-tax Act, 1961']])}</div>
        <div>{kv([['Total Income Tax', fmtAmount(data.tax.total, false)], ['Less: Deducted', fmtAmount(data.deducted + data.previous_tds, false)], ['Balance Deductible', fmtAmount(data.balance_tax, false)], [`Tax Per Month (${data.remaining_months} months)`, fmtAmount(data.monthly_tds, false)]])}</div>
      </div>
      <div className="py-1">Tax Regime : <b>{data.regime_label}</b></div>
      <table className="w-full">
        <thead>
          <tr>
            <th className={`${th} w-16 text-left`}>S.No</th>
            <th className={`${th} text-left`}>Particulars</th>
            <th className={`${th} text-right`}>Amount</th>
            <th className={`${th} text-right`}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={r.bold ? 'font-bold' : ''}>
              <td className="px-2 text-right">{r.no ?? ''}</td>
              <td className={`px-2 ${r.italic ? 'pl-10 italic' : ''}`}>{r.label}</td>
              <td className={cell}>{r.inner !== undefined ? fmtAmount(r.inner) : ''}</td>
              <td className={cell}>{r.amount !== undefined ? fmtAmount(r.amount, false) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {cfg.values.months && (
        <table className="mt-5 w-full">
          <thead>
            <tr>
              <th className={`${th} text-left`}>Month</th>
              <th className={`${th} text-left`}>Basis</th>
              <th className={`${th} text-right`}>Taxable Salary</th>
              <th className={`${th} text-right`}>Employee PF</th>
              <th className={`${th} text-right`}>Professional Tax</th>
              <th className={`${th} text-right`}>Tax Deducted</th>
            </tr>
          </thead>
          <tbody>
            {data.months.map((m) => (
              <tr key={m.month}>
                <td className="px-2">{monthLabel(m.month)}</td>
                <td className="px-2 italic">{m.basis}</td>
                <td className={cell}>{fmtAmount(m.salary)}</td>
                <td className={cell}>{fmtAmount(m.pf)}</td>
                <td className={cell}>{fmtAmount(m.pt)}</td>
                <td className={cell}>{fmtAmount(m.tds)}</td>
              </tr>
            ))}
            <tr className="font-bold">
              <td colSpan={2} className={`${rule} px-2`}>Total</td>
              {(['salary', 'pf', 'pt', 'tds'] as const).map((k) => (
                <td key={k} className={`${cell} ${rule}`}>{fmtAmount(data.months.reduce((s, m) => s + m[k], 0), false)}</td>
              ))}
            </tr>
          </tbody>
        </table>
      )}
    </Frame>
  );
}

const GRAT_DEFS = [
  { key: 'eligible', label: 'Show only eligible employees', default: false },
  { key: 'zero', label: 'Remove employees without gratuity wages', default: true },
];

const spanText = (s: { years: number; months: number; days: number }) => `${s.years} Y ${s.months} M ${s.days} D`;

export function GratuityReport() {
  const { books, period } = useStore();
  const nav = useNav();
  const p = usePeriodKey();
  const cfg = useReportOptions('gratuity-report', 'Gratuity Report', GRAT_DEFS);
  const flt = useFilter();
  const data = useLoad(() => gratuityReport(books.db, period.to), [period]);
  const rows = useMemo(
    () => (data ?? []).filter((r) => (!cfg.values.zero || r.wages) && (!cfg.values.eligible || r.result?.eligible) && flt.match(r.employee)),
    [data, cfg.values, flt]
  );
  const { sel, setSel, keys } = useSel(rows.length);
  const open = (i: number) => rows[i] && nav.push(<EmployeeVouchersReport employeeId={rows[i].employee_id} />);
  useScreen({ title: 'Gratuity Report', keys: { ...keys, ...p.key, ...cfg.key, ...flt.key, Enter: () => open(sel) }, buttons: [p.button, cfg.button, flt.button] });
  if (!data) return null;
  const total = (f: (r: (typeof rows)[number]) => number) => fmtAmount(rows.reduce((s, r) => s + f(r), 0), false);
  return (
    <Frame title="Gratuity Report" subtitle={`As on ${fmtDate(period.to)}`}>
      {flt.bar}
      <table className="w-full">
        <thead>
          <tr>
            <th className={`${th} text-left`}>Employee</th>
            <th className={`${th} text-left`}>Date of Joining</th>
            <th className={`${th} text-left`}>Period of Service</th>
            <th className={`${th} text-right`}>Last Drawn Wages</th>
            <th className={`${th} text-right`}>Gratuity Years</th>
            <th className={`${th} text-left`}>Eligible</th>
            <th className={`${th} text-right`}>Gratuity Payable</th>
            <th className={`${th} text-right`}>Accrued Liability</th>
            <th className={`${th} text-right`}>Provided</th>
            <th className={`${th} text-right`}>Provision Due</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.employee_id} className={rowCls(i === sel)} onMouseEnter={() => setSel(i)} onClick={() => open(i)}>
              <td className="px-2">{r.employee}{r.fixed_term ? ' (Fixed term)' : ''}{r.date_of_leaving ? ` (Left ${fmtDate(r.date_of_leaving)})` : ''}</td>
              <td className="px-2">{r.date_of_joining ? fmtDate(r.date_of_joining) : ''}</td>
              <td className="px-2">{r.result ? spanText(r.span) : ''}</td>
              <td className={cell}>{fmtAmount(r.wages)}</td>
              <td className={cell}>{r.result?.years ?? ''}</td>
              <td className="px-2">{r.result ? (r.result.eligible ? 'Yes' : 'No') : ''}</td>
              <td className={cell}>{fmtAmount(r.result?.amount ?? 0)}{r.result?.capped ? ' *' : ''}</td>
              <td className={cell}>{fmtAmount(r.result?.accrued ?? 0)}</td>
              <td className={cell}>{fmtAmount(r.provided)}</td>
              <td className={cell}>{fmtAmount(r.difference)}</td>
            </tr>
          ))}
          <tr className="font-bold">
            <td colSpan={6} className={`${rule} px-2`}>Grand Total</td>
            <td className={`${cell} ${rule}`}>{total((r) => r.result?.amount ?? 0)}</td>
            <td className={`${cell} ${rule}`}>{total((r) => r.result?.accrued ?? 0)}</td>
            <td className={`${cell} ${rule}`}>{total((r) => r.provided)}</td>
            <td className={`${cell} ${rule}`}>{total((r) => r.difference)}</td>
          </tr>
        </tbody>
      </table>
      <div className="mt-2 text-xs text-tb-muted">
        Gratuity = 15/26 x last drawn wages (pay heads marked for gratuity) x completed years (part above six months counts as a year), payable after 5 years of continuous service (1 year for fixed term employees), limited to the notified ceiling{rows.some((r) => r.result?.capped) ? ' (* ceiling applied)' : ''}. Accrued liability is pro-rata for completed months of service.
      </div>
      {rows.length === 0 && <div className="py-3 text-tb-muted">No employees with gratuity wages.</div>}
    </Frame>
  );
}
