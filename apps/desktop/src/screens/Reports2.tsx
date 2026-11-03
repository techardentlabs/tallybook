import { useMemo } from 'react';
import { cashBankBook, cashFlow, fundsFlow, fmtAmount, fmtDate, ratioAnalysis, statistics, voucherRegister, type RatioRow } from '@tallybook/core';
import { useScreen } from '../registry.ts';
import { useStore } from '../store.tsx';
import { useNav } from '../nav.tsx';
import { Frame, DayBookReport, LedgerReport, rowCls, th, useLoad, usePeriodKey, useSel } from './Reports.tsx';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}`;
const cell = 'px-2 text-right tabular-nums';
const total = 'border-y-[3px] border-double border-tb-ink px-2';

export function RegisterReport({ parent }: { parent: string }) {
  const { books, period } = useStore();
  const nav = useNav();
  const p = usePeriodKey();
  const data = useLoad(async () => ({ reg: await voucherRegister(books.db, parent, period.from, period.to), types: await books.voucherTypes() }), [parent, period]);
  const months = useMemo(() => data?.reg.months ?? [], [data]);
  const { sel, setSel, keys } = useSel(months.length);
  const open = (i: number) => {
    const m = months[i];
    const t = data?.types.find((x) => x.name === parent);
    if (!m || !t) return;
    const [y, mo] = m.month.split('-').map(Number);
    const from = `${m.month}-01`;
    const to = `${m.month}-${String(new Date(y, mo, 0).getDate()).padStart(2, '0')}`;
    nav.push(<DayBookReport typeId={t.id} range={{ from: from < period.from ? period.from : from, to: to > period.to ? period.to : to }} title={`${parent} Register`} />);
  };
  useScreen({ title: `${parent} Register`, keys: { ...keys, ...p.key, Enter: () => open(sel) }, buttons: [p.button] });
  if (!data) return null;
  return (
    <Frame title={`${parent} Register`}>
      <table className="w-full">
        <thead>
          <tr>
            <th className={`${th} text-left`}>Particulars</th>
            <th className={`${th} text-right`}>Vouchers</th>
            <th className={`${th} text-right`}>Debit</th>
            <th className={`${th} text-right`}>Credit</th>
            <th className={`${th} text-right`}>Closing Balance</th>
          </tr>
        </thead>
        <tbody>
          {months.map((m, i) => (
            <tr key={m.month} className={rowCls(i === sel)} onMouseEnter={() => setSel(i)} onClick={() => open(i)}>
              <td className="px-2">{monthLabel(m.month)}</td>
              <td className={cell}>{m.count || ''}</td>
              <td className={cell}>{m.debit ? fmtAmount(m.debit, false) : ''}</td>
              <td className={cell}>{m.credit ? fmtAmount(m.credit, false) : ''}</td>
              <td className={cell}>{m.count ? fmtAmount(m.closing, false) : ''}</td>
            </tr>
          ))}
          <tr className="font-bold">
            <td className={total}>Grand Total</td>
            <td className={`${cell} ${total}`}>{data.reg.total.count}</td>
            <td className={`${cell} ${total}`}>{fmtAmount(data.reg.total.debit, false)}</td>
            <td className={`${cell} ${total}`}>{fmtAmount(data.reg.total.credit, false)}</td>
            <td className={total} />
          </tr>
        </tbody>
      </table>
    </Frame>
  );
}

export function CashBankBookReport() {
  const { books, period } = useStore();
  const nav = useNav();
  const p = usePeriodKey();
  const data = useLoad(() => cashBankBook(books.db, period.from, period.to), [period]);
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const { sel, setSel, keys } = useSel(rows.length);
  useScreen({ title: 'Cash/Bank Book', keys: { ...keys, ...p.key, Enter: () => rows[sel] && nav.push(<LedgerReport ledgerId={rows[sel].id} />) }, buttons: [p.button] });
  if (!data) return null;
  const dr = (n: number) => (n > 0 ? `${fmtAmount(n, false)} Dr` : n < 0 ? `${fmtAmount(-n, false)} Cr` : '');
  let last = '';
  return (
    <Frame title="Cash/Bank Book">
      <table className="w-full">
        <thead>
          <tr>
            <th className={`${th} text-left`}>Particulars</th>
            <th className={`${th} text-right`}>Opening Balance</th>
            <th className={`${th} text-right`}>Debit</th>
            <th className={`${th} text-right`}>Credit</th>
            <th className={`${th} text-right`}>Closing Balance</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const head = r.group !== last ? <tr key={`h${r.group}`}><td className="px-2 pt-2 font-bold" colSpan={5}>{r.group}</td></tr> : null;
            last = r.group;
            return [
              head,
              <tr key={r.id} className={rowCls(i === sel, 'font-bold')} onMouseEnter={() => setSel(i)} onClick={() => nav.push(<LedgerReport ledgerId={r.id} />)}>
                <td className="pl-6 pr-2">{r.name}</td>
                <td className={cell}>{dr(r.opening)}</td>
                <td className={cell}>{r.debit ? fmtAmount(r.debit, false) : ''}</td>
                <td className={cell}>{r.credit ? fmtAmount(r.credit, false) : ''}</td>
                <td className={cell}>{dr(r.closing)}</td>
              </tr>,
            ];
          })}
          <tr className="font-bold">
            <td className={total}>Grand Total</td>
            <td className={`${cell} ${total}`}>{dr(data.total.opening)}</td>
            <td className={`${cell} ${total}`}>{fmtAmount(data.total.debit, false)}</td>
            <td className={`${cell} ${total}`}>{fmtAmount(data.total.credit, false)}</td>
            <td className={`${cell} ${total}`}>{dr(data.total.closing)}</td>
          </tr>
        </tbody>
      </table>
      {rows.length === 0 && <div className="py-3 text-tb-muted">No cash or bank ledgers.</div>}
    </Frame>
  );
}

const show = (r: RatioRow) => (r.value === null ? 'n/a' : r.unit === 'x' ? r.value.toFixed(2) : r.unit === '%' ? `${r.value.toFixed(2)} %` : `${Math.round(r.value)} days`);

export function RatioAnalysisReport() {
  const { books, period } = useStore();
  const p = usePeriodKey();
  const data = useLoad(() => ratioAnalysis(books.db, period.from, period.to), [period]);
  useScreen({ title: 'Ratio Analysis', keys: { ...p.key }, buttons: [p.button] });
  if (!data) return null;
  let last = '';
  return (
    <Frame title="Ratio Analysis">
      <table className="mx-auto w-[520px]">
        <tbody>
          {data.map((r) => {
            const head = r.group !== last ? <tr key={`h${r.group}`}><td className="border-b border-tb-line pt-3 font-bold" colSpan={2}>{r.group}</td></tr> : null;
            last = r.group;
            return [
              head,
              <tr key={r.label}>
                <td className="px-2">{r.label}</td>
                <td className={`${cell} font-bold`}>{show(r)}</td>
              </tr>,
            ];
          })}
        </tbody>
      </table>
    </Frame>
  );
}

export function StatisticsReport() {
  const { books, period } = useStore();
  const p = usePeriodKey();
  const data = useLoad(() => statistics(books.db, period.from, period.to), [period]);
  useScreen({ title: 'Statistics', keys: { ...p.key }, buttons: [p.button] });
  if (!data) return null;
  return (
    <Frame title="Statistics" subtitle={`${fmtDate(period.from)} to ${fmtDate(period.to)}`}>
      <table className="mx-auto w-[420px]">
        <thead>
          <tr>
            <th className={`${th} text-left`}>Particulars</th>
            <th className={`${th} text-right`}>Count</th>
          </tr>
        </thead>
        <tbody>
          {data.masters.map((m) => (
            <tr key={m.label}>
              <td className="px-2">{m.label}</td>
              <td className={cell}>{m.count}</td>
            </tr>
          ))}
          <tr><td className="px-2 pt-3 font-bold" colSpan={2}>Vouchers</td></tr>
          {data.vouchers.map((v) => (
            <tr key={v.label}>
              <td className="pl-6 pr-2">{v.label}</td>
              <td className={cell}>{v.count || ''}</td>
            </tr>
          ))}
          <tr className="font-bold">
            <td className={total}>Total Vouchers</td>
            <td className={`${cell} ${total}`}>{data.total}</td>
          </tr>
          <tr>
            <td className="px-2">Cancelled Vouchers</td>
            <td className={cell}>{data.cancelled || ''}</td>
          </tr>
        </tbody>
      </table>
    </Frame>
  );
}

export function CashFlowReport() {
  const { books, period } = useStore();
  const p = usePeriodKey();
  const data = useLoad(() => cashFlow(books.db, period.from, period.to), [period]);
  useScreen({ title: 'Cash Flow', keys: { ...p.key }, buttons: [p.button] });
  if (!data) return null;
  const sect = (title: string, rows: { label: string; amount: number }[], net: number) => (
    <>
      <tr><td className="px-2 pt-3 font-bold" colSpan={2}>{title}</td></tr>
      {rows.map((r) => (
        <tr key={title + r.label}>
          <td className="pl-6 pr-2">{r.label}</td>
          <td className={cell}>{r.amount < 0 ? `(${fmtAmount(-r.amount, false)})` : fmtAmount(r.amount, false)}</td>
        </tr>
      ))}
      <tr className="font-bold">
        <td className="px-2">Net cash from {title.toLowerCase()}</td>
        <td className={cell}>{fmtAmount(net, false)}</td>
      </tr>
    </>
  );
  return (
    <Frame title="Cash Flow">
      <table className="mx-auto w-[640px]">
        <tbody>
          <tr><td className="px-2">Opening cash and bank balance</td><td className={cell}>{fmtAmount(data.opening_cash, false)}</td></tr>
          <tr><td className="px-2">Net profit for the period</td><td className={cell}>{fmtAmount(data.net_profit, false)}</td></tr>
          {sect('Operating activities', data.operating, data.net_operating)}
          {sect('Investing activities', data.investing, data.net_investing)}
          {sect('Financing activities', data.financing, data.net_financing)}
          <tr className="font-bold">
            <td className={total}>Net increase / (decrease) in cash</td>
            <td className={`${cell} ${total}`}>{fmtAmount(data.net_change, false)}</td>
          </tr>
          <tr className="font-bold"><td className="px-2">Closing cash and bank balance</td><td className={cell}>{fmtAmount(data.closing_cash, false)}</td></tr>
        </tbody>
      </table>
    </Frame>
  );
}

export function FundsFlowReport() {
  const { books, period } = useStore();
  const p = usePeriodKey();
  const data = useLoad(() => fundsFlow(books.db, period.from, period.to), [period]);
  useScreen({ title: 'Funds Flow', keys: { ...p.key }, buttons: [p.button] });
  if (!data) return null;
  const rows = Math.max(data.sources.length, data.applications.length);
  return (
    <Frame title="Funds Flow">
      <table className="w-full">
        <thead>
          <tr>
            <th className={`${th} text-left`}>Sources</th>
            <th className={`${th} text-right`}>Amount</th>
            <th className={`${th} text-left`}>Applications</th>
            <th className={`${th} text-right`}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, i) => (
            <tr key={i}>
              <td className="px-2">{data.sources[i]?.label}</td>
              <td className={cell}>{data.sources[i] ? fmtAmount(data.sources[i].amount, false) : ''}</td>
              <td className="px-2">{data.applications[i]?.label}</td>
              <td className={cell}>{data.applications[i] ? fmtAmount(data.applications[i].amount, false) : ''}</td>
            </tr>
          ))}
          <tr className="font-bold">
            <td className={total}>Total</td>
            <td className={`${cell} ${total}`}>{fmtAmount(data.total_sources, false)}</td>
            <td className={total}>Total</td>
            <td className={`${cell} ${total}`}>{fmtAmount(data.total_applications, false)}</td>
          </tr>
        </tbody>
      </table>
    </Frame>
  );
}
