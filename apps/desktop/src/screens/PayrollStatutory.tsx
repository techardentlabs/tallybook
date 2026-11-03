import { useMemo } from 'react';
import { buildXlsx, ecrFile, esiMonthlyUpload, esiStatement, fmtAmount, fmtDate, form3A, monthBounds, pfStatement, ESI_REASON_CODES, EPF_EE_BP, EPS_BP } from '@tallybook/core';
import { useScreen } from '../registry.ts';
import { useStore } from '../store.tsx';
import { useDialogs } from '../ui/Dialogs.tsx';
import { saveTextFile } from '../files.ts';
import { saveBinaryFile } from './ImportExcel.tsx';
import { Frame, th, rowCls, useLoad, usePeriodKey, useSel } from './Reports.tsx';
import { useFilter, useReportOptions } from './reportConfig.tsx';

const cell = 'px-2 text-right tabular-nums';
const rule = 'border-y-[3px] border-double border-tb-ink';
const rs = (rupees: number) => fmtAmount(rupees * 100, false);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]}-${iso.slice(0, 4)}`;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function useMonthExport() {
  const { period } = useStore();
  const month = monthBounds(period.to);
  const single = period.from === month.from;
  return { month, single };
}

const PF_DEFS = [{ key: 'ecr', label: 'Show ECR details (UAN, gross, EPS/EDLI wages, NCP days)', default: false }];
const ESI_DEFS = [{ key: 'mc', label: 'Show reason code and last working day', default: false }];

export function PfMonthlyStatementReport() {
  const { books, period, toast } = useStore();
  const dialogs = useDialogs();
  const p = usePeriodKey();
  const flt = useFilter();
  const cfg = useReportOptions('pf-monthly', 'PF Monthly Statement', PF_DEFS);
  const o = cfg.values;
  const { month, single } = useMonthExport();
  const data = useLoad(() => pfStatement(books.db, period.from, period.to), [period]);
  const rows = useMemo(() => (data?.rows ?? []).filter((r) => flt.match(r.name, r.uan, r.pf_number)), [data, flt]);
  const { sel, setSel, keys } = useSel(rows.length);
  const exportEcr = async () => {
    const f = await ecrFile(books.db, month.from);
    if (!f.rows.length) return toast(`No PF contributions for ${monthLabel(month.from)}`, 'err');
    const head = single ? '' : `The ECR is prepared for the wage month ${monthLabel(month.from)} only. `;
    if ((f.errors.length || head) && !(await dialogs.confirm(<div>{head}{f.errors.map((e) => <div key={e}>{e}</div>)}<div className="mt-2">Export the ECR file ?</div></div>, { title: 'Export ECR', def: !f.errors.length }))) return;
    if (await saveTextFile(`ECR_${month.from.slice(0, 7).replace('-', '')}.txt`, f.text, 'text/plain')) toast('ECR file exported', 'ok');
  };
  useScreen({
    title: 'PF Monthly Statement',
    keys: { ...keys, ...p.key, ...cfg.key, ...flt.key, 'Alt+E': () => void exportEcr() },
    buttons: [p.button, cfg.button, flt.button, { key: 'Alt+E', label: 'Export ECR', run: () => void exportEcr() }],
  });
  if (!data) return null;
  const t = data.totals;
  const acc: [string, number][] = [
    ['A/c No. 1 (EPF: Employee + Employer share)', data.accounts.ac1],
    ['A/c No. 2 (Administrative charges)', data.accounts.ac2],
    ['A/c No. 10 (Pension fund)', data.accounts.ac10],
    ['A/c No. 21 (EDLI contribution)', data.accounts.ac21],
    ['A/c No. 22 (EDLI administrative charges)', data.accounts.ac22],
  ];
  return (
    <Frame title="PF Monthly Statement" subtitle={`${fmtDate(period.from)} to ${fmtDate(period.to)}   Wage ceiling ${rs(data.ceiling / 100)}`}>
      {flt.bar}
      <table className="w-full">
        <thead>
          <tr>
            <th rowSpan={2} className={`${th} text-left`}>Emp No</th>
            <th rowSpan={2} className={`${th} text-left`}>PF Number</th>
            {o.ecr && <th rowSpan={2} className={`${th} text-left`}>UAN</th>}
            <th rowSpan={2} className={`${th} text-left`}>Employee Name</th>
            <th rowSpan={2} className={`${th} text-right`}>Worked Days</th>
            {o.ecr && <th rowSpan={2} className={`${th} text-right`}>Gross Wages</th>}
            <th rowSpan={2} className={`${th} text-right`}>Earned Wages</th>
            {o.ecr && <th rowSpan={2} className={`${th} text-right`}>EPS Wages</th>}
            {o.ecr && <th rowSpan={2} className={`${th} text-right`}>EDLI Wages</th>}
            <th colSpan={3} className={`${th} text-center`}>Employee's Contribution</th>
            <th colSpan={3} className={`${th} text-center`}>Employer's Contribution</th>
            {o.ecr && <th rowSpan={2} className={`${th} text-right`}>NCP Days</th>}
          </tr>
          <tr>
            <th className={`${th} text-right`}>PF {EPF_EE_BP / 100}%</th>
            <th className={`${th} text-right`}>VPF</th>
            <th className={`${th} text-right`}>Total</th>
            <th className={`${th} text-right`}>EPS {EPS_BP / 100}%</th>
            <th className={`${th} text-right`}>EPF {(EPF_EE_BP - EPS_BP) / 100}%</th>
            <th className={`${th} text-right`}>Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.employee_id} className={rowCls(i === sel)} onMouseEnter={() => setSel(i)}>
              <td className="px-2">{r.emp_number}</td>
              <td className="px-2">{r.pf_number}</td>
              {o.ecr && <td className="px-2">{r.uan}</td>}
              <td className="px-2">{r.name}{r.above_age ? ' *' : ''}</td>
              <td className={cell}>{r.worked_days}</td>
              {o.ecr && <td className={cell}>{rs(r.gross)}</td>}
              <td className={cell}>{rs(r.epf_wages)}</td>
              {o.ecr && <td className={cell}>{rs(r.eps_wages)}</td>}
              {o.ecr && <td className={cell}>{rs(r.edli_wages)}</td>}
              <td className={cell}>{rs(r.ee)}</td>
              <td className={cell} />
              <td className={cell}>{rs(r.ee)}</td>
              <td className={cell}>{rs(r.eps)}</td>
              <td className={cell}>{rs(r.er)}</td>
              <td className={cell}>{rs(r.eps + r.er)}</td>
              {o.ecr && <td className={cell}>{r.ncp_days || ''}</td>}
            </tr>
          ))}
          <tr className="font-bold">
            <td colSpan={o.ecr ? 4 : 3} className={`${rule} px-2`}>Grand Total</td>
            <td className={`${cell} ${rule}`}>{t.worked_days}</td>
            {o.ecr && <td className={`${cell} ${rule}`}>{rs(t.gross)}</td>}
            <td className={`${cell} ${rule}`}>{rs(t.epf_wages)}</td>
            {o.ecr && <td className={`${cell} ${rule}`}>{rs(t.eps_wages)}</td>}
            {o.ecr && <td className={`${cell} ${rule}`}>{rs(t.edli_wages)}</td>}
            <td className={`${cell} ${rule}`}>{rs(t.ee)}</td>
            <td className={`${cell} ${rule}`} />
            <td className={`${cell} ${rule}`}>{rs(t.ee)}</td>
            <td className={`${cell} ${rule}`}>{rs(t.eps)}</td>
            <td className={`${cell} ${rule}`}>{rs(t.er)}</td>
            <td className={`${cell} ${rule}`}>{rs(t.eps + t.er)}</td>
            {o.ecr && <td className={`${cell} ${rule}`}>{t.ncp_days || ''}</td>}
          </tr>
        </tbody>
      </table>
      <table className="mt-5 w-1/2">
        <thead>
          <tr>
            <th className={`${th} text-left`}>Challan Account</th>
            <th className={`${th} text-right`}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {acc.map(([k, v]) => (
            <tr key={k}>
              <td className="px-2">{k}</td>
              <td className={cell}>{rs(v)}</td>
            </tr>
          ))}
          <tr className="font-bold">
            <td className={`${rule} px-2`}>Total</td>
            <td className={`${cell} ${rule}`}>{rs(data.accounts.total)}</td>
          </tr>
        </tbody>
      </table>
      <div className="mt-2 text-xs text-tb-muted">
        EPS share is 8.33% of EPS wages (limited to the wage ceiling, apportioned by days when the ceiling changes within the month); employer EPF share is the employee share less the EPS share.
        {rows.some((r) => r.above_age) ? ' * Member aged 58 or above: no EPS contribution.' : ''}
      </div>
      {rows.length === 0 && <div className="py-3 text-tb-muted">No PF contributions in this period.</div>}
    </Frame>
  );
}

export function EsiMonthlyStatementReport() {
  const { books, period, toast } = useStore();
  const dialogs = useDialogs();
  const p = usePeriodKey();
  const flt = useFilter();
  const cfg = useReportOptions('esi-monthly', 'ESI Monthly Statement', ESI_DEFS);
  const o = cfg.values;
  const { month, single } = useMonthExport();
  const data = useLoad(() => esiStatement(books.db, period.from, period.to), [period]);
  const rows = useMemo(() => (data?.rows ?? []).filter((r) => flt.match(r.name, r.ip_number)), [data, flt]);
  const { sel, setSel, keys } = useSel(rows.length);
  const exportMc = async () => {
    const f = await esiMonthlyUpload(books.db, month.from);
    if (f.rows.length < 2) return toast(`No ESI contributions for ${monthLabel(month.from)}`, 'err');
    const head = single ? '' : `The upload file is prepared for ${monthLabel(month.from)} only. `;
    if ((f.errors.length || head) && !(await dialogs.confirm(<div>{head}{f.errors.map((e) => <div key={e}>{e}</div>)}<div className="mt-2">Export the monthly contribution file ?</div></div>, { title: 'Export ESI', def: !f.errors.length }))) return;
    if (await saveBinaryFile(`ESI_MC_${month.from.slice(0, 7).replace('-', '')}.xlsx`, buildXlsx([{ name: 'Sheet1', rows: f.rows }]), XLSX_MIME)) toast('ESI monthly contribution file exported', 'ok');
  };
  useScreen({
    title: 'ESI Monthly Statement',
    keys: { ...keys, ...p.key, ...cfg.key, ...flt.key, 'Alt+E': () => void exportMc() },
    buttons: [p.button, cfg.button, flt.button, { key: 'Alt+E', label: 'Export MC File', run: () => void exportMc() }],
  });
  if (!data) return null;
  const reason = (c: number | null) => (c === null ? '' : `${c} - ${ESI_REASON_CODES.find((x) => x.code === c)?.label ?? ''}`);
  return (
    <Frame title="ESI Monthly Statement">
      {flt.bar}
      <table className="w-full">
        <thead>
          <tr>
            <th className={`${th} text-left`}>Employee No</th>
            <th className={`${th} text-left`}>Employee Name</th>
            <th className={`${th} text-left`}>ESI No</th>
            <th className={`${th} text-right`}>Worked Days</th>
            <th className={`${th} text-right`}>Fixed Wages</th>
            <th className={`${th} text-right`}>Earned Wages</th>
            <th className={`${th} text-right`}>Employee's Contribution</th>
            <th className={`${th} text-right`}>Employer's Contribution</th>
            <th className={`${th} text-right`}>Total</th>
            {o.mc && <th className={`${th} text-left`}>Reason</th>}
            {o.mc && <th className={`${th} text-left`}>Last Working Day</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.employee_id} className={rowCls(i === sel)} onMouseEnter={() => setSel(i)}>
              <td className="px-2">{r.emp_number}</td>
              <td className="px-2">{r.name}</td>
              <td className="px-2">{r.ip_number}</td>
              <td className={cell}>{r.days}</td>
              <td className={cell}>{fmtAmount(r.fixed_wages)}</td>
              <td className={cell}>{fmtAmount(r.wages)}</td>
              <td className={cell}>{fmtAmount(r.ee)}</td>
              <td className={cell}>{fmtAmount(r.er)}</td>
              <td className={cell}>{fmtAmount(r.total)}</td>
              {o.mc && <td className="px-2">{reason(r.reason_code)}</td>}
              {o.mc && <td className="px-2">{r.last_working_day ? fmtDate(r.last_working_day) : ''}</td>}
            </tr>
          ))}
          <tr className="font-bold">
            <td colSpan={3} className={`${rule} px-2`}>Grand Total</td>
            <td className={`${cell} ${rule}`}>{data.totals.days}</td>
            <td className={`${cell} ${rule}`}>{fmtAmount(data.totals.fixed_wages, false)}</td>
            <td className={`${cell} ${rule}`}>{fmtAmount(data.totals.wages, false)}</td>
            <td className={`${cell} ${rule}`}>{fmtAmount(data.totals.ee, false)}</td>
            <td className={`${cell} ${rule}`}>{fmtAmount(data.totals.er, false)}</td>
            <td className={`${cell} ${rule}`}>{fmtAmount(data.totals.total, false)}</td>
            {o.mc && <td colSpan={2} className={rule} />}
          </tr>
        </tbody>
      </table>
      {rows.length === 0 && <div className="py-3 text-tb-muted">No ESI contributions in this period.</div>}
    </Frame>
  );
}

export function Form3AReport() {
  const { books, period } = useStore();
  const p = usePeriodKey();
  const flt = useFilter();
  const data = useLoad(() => form3A(books.db, period.from, period.to), [period]);
  const cards = useMemo(() => (data ?? []).filter((c) => flt.match(c.name, c.uan, c.pf_number)), [data, flt]);
  useScreen({ title: 'Form 3A', keys: { ...p.key, ...flt.key }, buttons: [p.button, flt.button] });
  if (!data) return null;
  return (
    <Frame title="Form 3A (Revised) - Member's Annual Contribution Card" plain>
      {flt.bar}
      {cards.map((c) => (
        <div key={c.employee_id} className="mb-6">
          <div className="flex gap-8 font-semibold">
            <span>{c.name}</span>
            <span>UAN : {c.uan}</span>
            <span>Account No. : {c.pf_number}</span>
          </div>
          <table className="mt-1 w-full">
            <thead>
              <tr>
                <th className={`${th} text-left`}>Month</th>
                <th className={`${th} text-right`}>Amount of Wages</th>
                <th className={`${th} text-right`}>E.P.F. @ {EPF_EE_BP / 100}%</th>
                <th className={`${th} text-right`}>Higher Voluntary Contribution</th>
                <th className={`${th} text-right`}>E.P.F. Difference between {EPF_EE_BP / 100}% &amp; {EPS_BP / 100}% (A/c 1)</th>
                <th className={`${th} text-right`}>Pension Fund Contribution {EPS_BP / 100}% (A/c 10)</th>
                <th className={`${th} text-right`}>Refund of Advance</th>
                <th className={`${th} text-right`}>No. of Days of Non-contributing Service</th>
                <th className={`${th} text-left`}>Remarks</th>
              </tr>
            </thead>
            <tbody>
              {c.months.map((m) => (
                <tr key={m.month}>
                  <td className="px-2">{monthLabel(m.month)}</td>
                  <td className={cell}>{rs(m.wages)}</td>
                  <td className={cell}>{rs(m.ee)}</td>
                  <td className={cell} />
                  <td className={cell}>{rs(m.er)}</td>
                  <td className={cell}>{rs(m.eps)}</td>
                  <td className={cell}>{rs(m.refund)}</td>
                  <td className={cell}>{m.ncp_days || ''}</td>
                  <td className="px-2" />
                </tr>
              ))}
              <tr className="font-bold">
                <td className={`${rule} px-2`}>Total</td>
                <td className={`${cell} ${rule}`}>{rs(c.totals.wages)}</td>
                <td className={`${cell} ${rule}`}>{rs(c.totals.ee)}</td>
                <td className={`${cell} ${rule}`} />
                <td className={`${cell} ${rule}`}>{rs(c.totals.er)}</td>
                <td className={`${cell} ${rule}`}>{rs(c.totals.eps)}</td>
                <td className={`${cell} ${rule}`}>{rs(c.totals.refund)}</td>
                <td className={`${cell} ${rule}`}>{c.totals.ncp_days || ''}</td>
                <td className={rule} />
              </tr>
            </tbody>
          </table>
        </div>
      ))}
      {cards.length === 0 && <div className="py-3 text-tb-muted">No PF contributions in this period.</div>}
    </Frame>
  );
}

export function Form6AReport() {
  const { books, period } = useStore();
  const p = usePeriodKey();
  const flt = useFilter();
  const data = useLoad(() => pfStatement(books.db, period.from, period.to), [period]);
  const rows = useMemo(() => (data?.rows ?? []).filter((r) => flt.match(r.name, r.uan, r.pf_number)), [data, flt]);
  const { sel, setSel, keys } = useSel(rows.length);
  useScreen({ title: 'Form 6A', keys: { ...keys, ...p.key, ...flt.key }, buttons: [p.button, flt.button] });
  if (!data) return null;
  const t = data.totals;
  return (
    <Frame title="Form 6A (Revised) - Annual Statement of Contribution">
      {flt.bar}
      <table className="w-full">
        <thead>
          <tr>
            <th className={`${th} text-left`}>Account Number</th>
            <th className={`${th} text-left`}>Name of Member</th>
            <th className={`${th} text-right`}>Wages, Retaining Allowance &amp; DA</th>
            <th className={`${th} text-right`}>Worker's Contribution E.P.F.</th>
            <th className={`${th} text-right`}>Employer's E.P.F. Difference between {EPF_EE_BP / 100}% &amp; {EPS_BP / 100}%</th>
            <th className={`${th} text-right`}>Employer's Pension Fund {EPS_BP / 100}%</th>
            <th className={`${th} text-right`}>Refund of Advance</th>
            <th className={`${th} text-right`}>Rate of Higher Voluntary Contribution</th>
            <th className={`${th} text-left`}>Remarks</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.employee_id} className={rowCls(i === sel)} onMouseEnter={() => setSel(i)}>
              <td className="px-2">{r.pf_number}</td>
              <td className="px-2">{r.name.toUpperCase()}</td>
              <td className={cell}>{rs(r.epf_wages)}</td>
              <td className={cell}>{rs(r.ee)}</td>
              <td className={cell}>{rs(r.er)}</td>
              <td className={cell}>{rs(r.eps)}</td>
              <td className={cell}>{rs(r.refund)}</td>
              <td className={cell} />
              <td className="px-2" />
            </tr>
          ))}
          <tr className="font-bold">
            <td colSpan={2} className={`${rule} px-2`}>Grand Total</td>
            <td className={`${cell} ${rule}`}>{rs(t.epf_wages)}</td>
            <td className={`${cell} ${rule}`}>{rs(t.ee)}</td>
            <td className={`${cell} ${rule}`}>{rs(t.er)}</td>
            <td className={`${cell} ${rule}`}>{rs(t.eps)}</td>
            <td className={`${cell} ${rule}`}>{rs(t.refund)}</td>
            <td colSpan={2} className={rule} />
          </tr>
        </tbody>
      </table>
      <div className="mb-1 mt-5 font-semibold">Reconciliation of Remittances</div>
      <table className="w-full">
        <thead>
          <tr>
            <th className={`${th} text-left`}>Month</th>
            <th className={`${th} text-right`}>E.P.F. incl. Refund of Advances (A/c 1)</th>
            <th className={`${th} text-right`}>Pension Fund (A/c 10)</th>
            <th className={`${th} text-right`}>E.D.L.I. Contribution (A/c 21)</th>
            <th className={`${th} text-right`}>Admin. Charges (A/c 2)</th>
            <th className={`${th} text-right`}>E.D.L.I. Admin. Charges (A/c 22)</th>
            <th className={`${th} text-right`}>Total</th>
          </tr>
        </thead>
        <tbody>
          {data.months.map((m) => (
            <tr key={m.month}>
              <td className="px-2">{monthLabel(m.month)}</td>
              <td className={cell}>{rs(m.ac1)}</td>
              <td className={cell}>{rs(m.ac10)}</td>
              <td className={cell}>{rs(m.ac21)}</td>
              <td className={cell}>{rs(m.ac2)}</td>
              <td className={cell}>{rs(m.ac22)}</td>
              <td className={cell}>{rs(m.total)}</td>
            </tr>
          ))}
          <tr className="font-bold">
            <td className={`${rule} px-2`}>Total</td>
            <td className={`${cell} ${rule}`}>{rs(data.accounts.ac1)}</td>
            <td className={`${cell} ${rule}`}>{rs(data.accounts.ac10)}</td>
            <td className={`${cell} ${rule}`}>{rs(data.accounts.ac21)}</td>
            <td className={`${cell} ${rule}`}>{rs(data.accounts.ac2)}</td>
            <td className={`${cell} ${rule}`}>{rs(data.accounts.ac22)}</td>
            <td className={`${cell} ${rule}`}>{rs(data.accounts.total)}</td>
          </tr>
        </tbody>
      </table>
      {rows.length === 0 && <div className="py-3 text-tb-muted">No PF contributions in this period.</div>}
    </Frame>
  );
}
