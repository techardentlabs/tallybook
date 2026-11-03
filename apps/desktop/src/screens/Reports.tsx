import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  balanceSheet,
  dayBook,
  fmtAmount,
  fmtDate,
  fmtDrCr,
  groupSummary,
  groupSummaryDetailed,
  ledgerVouchers,
  outstandings,
  profitAndLoss,
  type BalanceSheet as BS,
  type DayBookRow,
  type GroupSummary,
  type LedgerReport as LR,
  type Outstandings as OS,
  type PlRow,
  type ProfitLoss as PL,
} from '@tallybook/core';
import { useScreen, useTop, type Btn, type KeyHandler } from '../registry.ts';
import { useStore } from '../store.tsx';
import { useNav } from '../nav.tsx';
import { useDialogs } from '../ui/Dialogs.tsx';
import { VoucherScreen } from './Voucher.tsx';
import { PayrollVoucherScreen } from './PayrollVoucher.tsx';
import { isPayrollVoucher } from '@tallybook/core';
import { saveTextFile } from '../files.ts';
import { useFilter, useReportOptions } from './reportConfig.tsx';

export function useSel(count: number) {
  const [sel, setSel] = useState(0);
  const ref = useRef({ count, sel });
  ref.current = { count, sel };
  useEffect(() => setSel((s) => Math.min(s, Math.max(0, count - 1))), [count]);
  useEffect(() => {
    document.querySelector('main tr.bg-tb-sel')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);
  const keys: Record<string, KeyHandler> = {
    ArrowDown: () => setSel((s) => Math.min(s + 1, ref.current.count - 1)),
    ArrowUp: () => setSel((s) => Math.max(s - 1, 0)),
    PageDown: () => setSel((s) => Math.min(s + 10, ref.current.count - 1)),
    PageUp: () => setSel((s) => Math.max(s - 10, 0)),
    Home: () => setSel(0),
    End: () => setSel(ref.current.count - 1),
  };
  return { sel, setSel, keys };
}

export function usePeriodKey(): { key: Record<string, KeyHandler>; button: Btn } {
  const { period, setPeriod } = useStore();
  const dialogs = useDialogs();
  const run = useCallback(async () => {
    const r = await dialogs.askPeriod(period.from, period.to);
    if (r) setPeriod(r.from, r.to);
  }, [dialogs, period, setPeriod]);
  return { key: { 'Alt+F2': () => void run(), F2: () => void run() }, button: { key: 'Alt+F2', label: 'Period', run: () => void run() } };
}

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function Frame({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  const { period, company } = useStore();
  const top = useTop();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    root.querySelectorAll('th, td').forEach((c) => {
      const t = c.textContent?.trim();
      if (t === 'Particulars' || t === 'Grand Total') c.classList.add('tb-spaced');
    });
    const range = `${fmtDate(period.from)} to ${fmtDate(period.to)}`;
    root.querySelectorAll('table').forEach((table) => {
      const thead = table.tHead;
      const first = thead?.rows[0]?.cells[0];
      if (thead && first && first.textContent?.trim() === 'Particulars' && !thead.querySelector('.tb-co')) {
        const cols = Array.from(thead.rows[0].cells).reduce((n, c) => n + c.colSpan, 0);
        if (cols - first.colSpan >= 1) {
          const tr = document.createElement('tr');
          tr.className = 'tb-co-row';
          const left = document.createElement('th');
          left.colSpan = first.colSpan;
          const right = document.createElement('th');
          right.className = 'tb-co';
          right.colSpan = cols - first.colSpan;
          right.innerHTML = `<div class="tb-co-name">${esc(company?.name ?? '')}</div><div>${esc(range)}</div>`;
          tr.append(left, right);
          thead.insertBefore(tr, thead.rows[0]);
          root.classList.add('tb-decorated');
        }
      }
      const body = table.tBodies[0];
      const grand = body ? Array.from(body.rows).find((r) => r.cells[0]?.textContent?.trim() === 'Grand Total') : undefined;
      body?.querySelectorAll('.tb-fill').forEach((f) => {
        if (f.nextElementSibling !== grand) f.remove();
      });
      if (grand && body) {
        grand.classList.add('tb-grand');
        table.style.height = '100%';
        if (!(grand.previousElementSibling as HTMLElement | null)?.classList.contains('tb-fill')) {
          const fill = document.createElement('tr');
          fill.className = 'tb-fill';
          const td = document.createElement('td');
          td.colSpan = Array.from(grand.cells).reduce((n, c) => n + c.colSpan, 0);
          fill.append(td);
          body.insertBefore(fill, grand);
        }
      }
    });
  });
  return (
    <div ref={ref} className="-m-4 min-h-[calc(100vh-130px)] bg-white px-2 pt-1">
      <div className="flex items-start justify-between">
        <div className="text-[15px]">{title && title !== top?.title ? <b>{title}</b> : null}</div>
        <div className="tb-sub text-[13px]">{subtitle ?? `${fmtDate(period.from)} to ${fmtDate(period.to)}`}</div>
      </div>
      <div className="mt-2" style={{ height: 'calc(100vh - 185px)' }}>
        {children}
      </div>
    </div>
  );
}

export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): T | null {
  const [data, setData] = useState<T | null>(null);
  const { version, toast } = useStore();
  useEffect(() => {
    let live = true;
    fn().then((d) => live && setData(d)).catch((e) => toast((e as Error).message, 'err'));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, version]);
  return data;
}

export const th = 'border-y border-tb-ink px-2 py-1 font-semibold';
export const rowCls = (on: boolean, extra = '') => `${on ? 'bg-tb-sel text-tb-sel-ink' : ''} ${extra} cursor-pointer`;

function csvEscape(s: string) {
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

const GS_DEFS = [
  { key: 'opening', label: 'Show opening balances', default: true },
  { key: 'txn', label: 'Show transactions (Debit / Credit)', default: true },
  { key: 'closing', label: 'Show closing balances', default: true },
  { key: 'hideZero', label: 'Hide ledgers and groups with zero balances', default: false },
  { key: 'detailed', label: 'Show detailed format (expand all groups)', default: false },
];

export function GroupSummaryReport({ groupId = null }: { groupId?: number | null }) {
  const { books, period, toast } = useStore();
  const nav = useNav();
  const p = usePeriodKey();
  const cfg = useReportOptions('group-summary', 'Group Summary', GS_DEFS);
  const flt = useFilter();
  const [detailed, setDetailed] = useState(cfg.values.detailed);
  useEffect(() => setDetailed(cfg.values.detailed), [cfg.values.detailed]);
  const data = useLoad(async () => {
    if (detailed) return await groupSummaryDetailed(books.db, period.from, period.to, groupId);
    const g = await groupSummary(books.db, period.from, period.to, groupId);
    return { title: g.title, total: g.total, rows: g.rows.map((r) => ({ ...r, depth: 0 })) };
  }, [period, groupId, detailed]);
  const rows = useMemo(
    () => (data?.rows ?? []).filter((r) => (!cfg.values.hideZero || r.opening || r.debit || r.credit || r.closing) && flt.match(r.name)),
    [data, cfg.values.hideZero, flt]
  );
  const { sel, setSel, keys } = useSel(rows.length);
  const open = (i: number) => {
    const r = rows[i];
    if (!r) return;
    nav.push(r.kind === 'group' ? <GroupSummaryReport groupId={r.id} /> : <LedgerReport ledgerId={r.id} />);
  };
  const exportCsv = async () => {
    if (!data) return;
    const lines = [['Particulars', 'Opening', 'Debit', 'Credit', 'Closing'], ...rows.map((r) => [r.name, fmtAmount(r.opening), fmtAmount(r.debit), fmtAmount(r.credit), fmtDrCr(r.closing)])];
    const ok = await saveTextFile(`${data.title}.csv`, lines.map((l) => l.map(csvEscape).join(',')).join('\n'), 'text/csv');
    if (ok) toast('Exported', 'ok');
  };
  useScreen({
    title: data?.title ?? 'Report',
    keys: { ...keys, ...p.key, ...cfg.key, ...flt.key, Enter: () => open(sel), 'Alt+E': () => void exportCsv(), 'Alt+F1': () => setDetailed((d) => !d) },
    buttons: [p.button, { key: 'Alt+F1', label: detailed ? 'Condensed' : 'Detailed', run: () => setDetailed((d) => !d) }, cfg.button, flt.button, { key: 'Alt+E', label: 'Export (CSV)', run: () => void exportCsv() }],
  });
  const v = cfg.values;
  const num = 'px-2 text-right tabular-nums';
  const tot = 'border-y-[3px] border-double border-tb-ink px-2 text-right tabular-nums';
  return (
    <Frame title={data?.title ?? ''}>
      {flt.bar}
      <table className="w-full">
        <thead>
          <tr className="text-left">
            <th className={th}>Particulars</th>
            {v.opening && <th className={`${th} text-right`}>Opening</th>}
            {v.txn && <th className={`${th} text-right`}>Debit</th>}
            {v.txn && <th className={`${th} text-right`}>Credit</th>}
            {v.closing && <th className={`${th} text-right`}>Closing</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.kind}-${r.id}`} className={rowCls(i === sel, r.kind === 'group' ? 'font-bold' : '')} onMouseEnter={() => setSel(i)} onClick={() => open(i)}>
              <td className="px-2" style={{ paddingLeft: 8 + r.depth * 18 }}>{r.name}</td>
              {v.opening && <td className={num}>{fmtDrCr(r.opening)}</td>}
              {v.txn && <td className={num}>{fmtAmount(r.debit)}</td>}
              {v.txn && <td className={num}>{fmtAmount(r.credit)}</td>}
              {v.closing && <td className={num}>{fmtDrCr(r.closing)}</td>}
            </tr>
          ))}
          {data && (
            <tr className="font-bold">
              <td className="border-y-[3px] border-double border-tb-ink px-2">Grand Total</td>
              {v.opening && <td className={tot}>{fmtDrCr(data.total.opening)}</td>}
              {v.txn && <td className={tot}>{fmtAmount(data.total.debit, false)}</td>}
              {v.txn && <td className={tot}>{fmtAmount(data.total.credit, false)}</td>}
              {v.closing && <td className={tot}>{fmtDrCr(data.total.closing)}</td>}
            </tr>
          )}
        </tbody>
      </table>
      {data && rows.length === 0 && <div className="py-3 text-tb-muted">{flt.active ? 'No rows match the filter.' : 'Nothing under this group.'}</div>}
    </Frame>
  );
}

function TwoSided({ leftTitle, rightTitle, left, right, totalLeft, totalRight, onOpen, selected, setSelected }: {
  leftTitle: string; rightTitle: string; left: PlRow[]; right: PlRow[]; totalLeft: number; totalRight: number;
  onOpen: (r: PlRow) => void; selected: PlRow | null; setSelected: (r: PlRow | null) => void;
}) {
  const side = (title: string, rows: PlRow[], total: number) => (
    <div>
      <div className="border-y border-tb-ink px-2 py-1 font-semibold">{title}</div>
      {rows.map((r, i) => (
        <div
          key={i}
          className={`flex justify-between px-2 ${r.bold ? 'font-bold' : ''} ${r.id ? 'cursor-pointer' : ''} ${selected === r ? 'bg-tb-sel text-tb-sel-ink' : ''}`}
          onMouseEnter={() => r.id && setSelected(r)}
          onClick={() => r.id && onOpen(r)}
        >
          <span>{r.label}</span>
          <span className="tabular-nums">{fmtAmount(r.amount, false)}</span>
        </div>
      ))}
      <div className="mt-2 flex justify-between border-y-[3px] border-double border-tb-ink px-2 font-bold">
        <span>Total</span>
        <span className="tabular-nums">{fmtAmount(total, false)}</span>
      </div>
    </div>
  );
  return (
    <div className="grid grid-cols-2 gap-x-4">
      {side(leftTitle, left, totalLeft)}
      {side(rightTitle, right, totalRight)}
    </div>
  );
}

function useTwoSidedSel(all: PlRow[]) {
  const clickable = useMemo(() => all.filter((r) => r.id), [all]);
  const [selected, setSelected] = useState<PlRow | null>(null);
  const idx = selected ? clickable.indexOf(selected) : -1;
  const current = idx >= 0 ? selected : clickable[0] ?? null;
  const step = (d: number) => {
    const i = Math.max(0, Math.min(clickable.length - 1, (idx < 0 ? 0 : idx) + d));
    setSelected(clickable[i] ?? null);
  };
  return { selected: current, setSelected, step };
}

export function ProfitLossReport() {
  const { books, period } = useStore();
  const nav = useNav();
  const p = usePeriodKey();
  const data = useLoad<PL>(() => profitAndLoss(books.db, period.from, period.to), [period]);
  const all = useMemo(() => (data ? [...data.trading.left, ...data.trading.right, ...data.pl.left, ...data.pl.right] : []), [data]);
  const s = useTwoSidedSel(all);
  const open = (r: PlRow | null) => {
    if (r?.id) nav.push(<GroupSummaryReport groupId={r.id} />);
  };
  useScreen({
    title: 'Profit & Loss A/c',
    keys: { ...p.key, ArrowDown: () => s.step(1), ArrowUp: () => s.step(-1), Enter: () => open(s.selected) },
    buttons: [p.button],
  });
  if (!data) return null;
  return (
    <Frame title="Profit & Loss A/c">
      <TwoSided leftTitle="Particulars" rightTitle="Particulars" left={data.trading.left} right={data.trading.right} totalLeft={data.trading.totalLeft} totalRight={data.trading.totalRight} onOpen={open} selected={s.selected} setSelected={s.setSelected} />
      <div className="my-3 border-t border-tb-line" />
      <TwoSided leftTitle="Particulars" rightTitle="Particulars" left={data.pl.left} right={data.pl.right} totalLeft={data.pl.totalLeft} totalRight={data.pl.totalRight} onOpen={open} selected={s.selected} setSelected={s.setSelected} />
    </Frame>
  );
}

export function BalanceSheetReport() {
  const { books, period } = useStore();
  const nav = useNav();
  const p = usePeriodKey();
  const data = useLoad<BS>(() => balanceSheet(books.db, period.from, period.to), [period]);
  const all = useMemo(() => (data ? [...data.liabilities, ...data.assets] : []), [data]);
  const s = useTwoSidedSel(all);
  const open = (r: PlRow | null) => {
    if (r?.id) nav.push(<GroupSummaryReport groupId={r.id} />);
  };
  useScreen({
    title: 'Balance Sheet',
    keys: { ...p.key, ArrowDown: () => s.step(1), ArrowUp: () => s.step(-1), Enter: () => open(s.selected) },
    buttons: [p.button],
  });
  if (!data) return null;
  return (
    <Frame title="Balance Sheet" subtitle={`as at ${fmtDate(period.to)}`}>
      <TwoSided leftTitle="Liabilities" rightTitle="Assets" left={data.liabilities} right={data.assets} totalLeft={data.totalLiabilities} totalRight={data.totalAssets} onOpen={open} selected={s.selected} setSelected={s.setSelected} />
    </Frame>
  );
}

const DB_DEFS = [
  { key: 'cancelled', label: 'Show cancelled vouchers', default: true },
  { key: 'type', label: 'Show voucher type', default: true },
  { key: 'number', label: 'Show voucher number', default: true },
];

export function DayBookReport({ typeId, range, title = 'Day Book' }: { typeId?: number; range?: { from: string; to: string }; title?: string } = {}) {
  const { books, period, toast } = useStore();
  const nav = useNav();
  const p = usePeriodKey();
  const cfg = useReportOptions('day-book', 'Day Book', DB_DEFS);
  const flt = useFilter();
  const data = useLoad<DayBookRow[]>(() => dayBook(books.db, range?.from ?? period.from, range?.to ?? period.to, typeId), [period, typeId, range?.from, range?.to]);
  const rows = useMemo(() => (data ?? []).filter((r) => (cfg.values.cancelled || !r.cancelled) && flt.match(r.particulars, r.type, r.number, fmtDate(r.date))), [data, cfg.values.cancelled, flt]);
  const { sel, setSel, keys } = useSel(rows.length);
  const open = (i: number) => {
    const r = rows[i];
    if (!r) return;
    if (r.cancelled) return toast('Cancelled vouchers cannot be altered', 'err');
    void isPayrollVoucher(books.db, r.id).then((p) => nav.push(p ? <PayrollVoucherScreen voucherId={r.id} /> : <VoucherScreen voucherId={r.id} />));
  };
  useScreen({
    title,
    keys: { ...keys, ...p.key, ...cfg.key, ...flt.key, Enter: () => open(sel), 'Alt+A': () => nav.push(<VoucherScreen typeName="Payment" />) },
    buttons: [p.button, cfg.button, flt.button, { key: 'Alt+A', label: 'Add Vch', run: () => nav.push(<VoucherScreen typeName="Payment" />) }],
  });
  const total = rows.filter((r) => !r.cancelled).reduce((s, r) => s + r.debit, 0);
  return (
    <Frame title={title}>
      {flt.bar}
      <table className="w-full">
        <thead>
          <tr className="text-left">
            <th className={th}>Date</th>
            <th className={th}>Particulars</th>
            {cfg.values.type && <th className={th}>Vch Type</th>}
            {cfg.values.number && <th className={`${th} text-right`}>Vch No.</th>}
            <th className={`${th} text-right`}>Debit</th>
            <th className={`${th} text-right`}>Credit</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id} className={rowCls(i === sel, r.cancelled ? 'text-tb-muted line-through' : '')} onMouseEnter={() => setSel(i)} onClick={() => open(i)}>
              <td className="px-2">{fmtDate(r.date)}</td>
              <td className="px-2 font-semibold">{r.particulars}</td>
              {cfg.values.type && <td className="px-2">{r.type}</td>}
              {cfg.values.number && <td className="px-2 text-right">{r.number}</td>}
              <td className="px-2 text-right tabular-nums">{fmtAmount(r.debit)}</td>
              <td className="px-2 text-right tabular-nums">{fmtAmount(r.credit)}</td>
            </tr>
          ))}
          {data && (
            <tr className="font-bold">
              <td colSpan={2 + (cfg.values.type ? 1 : 0) + (cfg.values.number ? 1 : 0)} className="border-y-[3px] border-double border-tb-ink px-2">Grand Total</td>
              <td className="border-y-[3px] border-double border-tb-ink px-2 text-right tabular-nums">{fmtAmount(total, false)}</td>
              <td className="border-y-[3px] border-double border-tb-ink px-2 text-right tabular-nums">{fmtAmount(total, false)}</td>
            </tr>
          )}
        </tbody>
      </table>
      {data && rows.length === 0 && <div className="py-3 text-tb-muted">No vouchers in this period. Press F4–F9 to create one.</div>}
    </Frame>
  );
}

const LV_DEFS = [
  { key: 'balance', label: 'Show running balance', default: true },
  { key: 'type', label: 'Show voucher type', default: true },
  { key: 'number', label: 'Show voucher number', default: true },
];

export function LedgerReport({ ledgerId }: { ledgerId: number }) {
  const { books, period } = useStore();
  const nav = useNav();
  const p = usePeriodKey();
  const data = useLoad<LR>(() => ledgerVouchers(books.db, ledgerId, period.from, period.to), [period, ledgerId]);
  const cfg = useReportOptions('ledger', 'Ledger Vouchers', LV_DEFS);
  const flt = useFilter();
  const lines = useMemo(() => (data?.lines ?? []).filter((l) => flt.match(l.particulars, l.type, l.number, fmtDate(l.date))), [data, flt]);
  const { sel, setSel, keys } = useSel(lines.length);
  const open = (i: number) => lines[i] && void isPayrollVoucher(books.db, lines[i].voucher_id).then((p) => nav.push(p ? <PayrollVoucherScreen voucherId={lines[i].voucher_id} /> : <VoucherScreen voucherId={lines[i].voucher_id} />));
  useScreen({
    title: 'Ledger Vouchers',
    keys: { ...keys, ...p.key, ...cfg.key, ...flt.key, Enter: () => open(sel) },
    buttons: [p.button, cfg.button, flt.button],
  });
  if (!data) return null;
  return (
    <Frame title={`Ledger: ${data.ledger.name}`}>
      {flt.bar}
      <table className="w-full">
        <thead>
          <tr className="text-left">
            <th className={th}>Date</th>
            <th className={th}>Particulars</th>
            {cfg.values.type && <th className={th}>Vch Type</th>}
            {cfg.values.number && <th className={`${th} text-right`}>Vch No.</th>}
            <th className={`${th} text-right`}>Debit</th>
            <th className={`${th} text-right`}>Credit</th>
            {cfg.values.balance && <th className={`${th} text-right`}>Balance</th>}
          </tr>
        </thead>
        <tbody>
          <tr className="font-semibold">
            <td className="px-2" colSpan={4}>Opening Balance</td>
            <td className="px-2 text-right tabular-nums" colSpan={3}>{fmtDrCr(data.opening) || '0.00'}</td>
          </tr>
          {lines.map((l, i) => (
            <tr key={`${l.voucher_id}-${i}`} className={rowCls(i === sel)} onMouseEnter={() => setSel(i)} onClick={() => open(i)}>
              <td className="px-2">{fmtDate(l.date)}</td>
              <td className="px-2 font-semibold">{l.particulars}</td>
              {cfg.values.type && <td className="px-2">{l.type}</td>}
              {cfg.values.number && <td className="px-2 text-right">{l.number}</td>}
              <td className="px-2 text-right tabular-nums">{fmtAmount(l.debit)}</td>
              <td className="px-2 text-right tabular-nums">{fmtAmount(l.credit)}</td>
              {cfg.values.balance && <td className="px-2 text-right tabular-nums">{fmtDrCr(l.balance)}</td>}
            </tr>
          ))}
          <tr className="font-bold">
            <td colSpan={4} className="border-t border-tb-ink px-2">Current Total</td>
            <td className="border-t border-tb-ink px-2 text-right tabular-nums">{fmtAmount(data.debit, false)}</td>
            <td className="border-t border-tb-ink px-2 text-right tabular-nums">{fmtAmount(data.credit, false)}</td>
            <td className="border-t border-tb-ink px-2" />
          </tr>
          <tr className="font-bold">
            <td colSpan={4} className="border-b-[3px] border-double border-tb-ink px-2">Closing Balance</td>
            <td colSpan={3} className="border-b-[3px] border-double border-tb-ink px-2 text-right tabular-nums">{fmtDrCr(data.closing) || '0.00'}</td>
          </tr>
        </tbody>
      </table>
    </Frame>
  );
}

export function OutstandingsReport({ side }: { side: 'receivable' | 'payable' }) {
  const { books, period } = useStore();
  const nav = useNav();
  const p = usePeriodKey();
  const data = useLoad<OS>(() => outstandings(books.db, side, period.to, period.from), [period, side]);
  const flat = useMemo(() => (data ? data.ledgers : []), [data]);
  const { sel, setSel, keys } = useSel(flat.length);
  useScreen({
    title: side === 'receivable' ? 'Ledger Outstandings: Receivables' : 'Ledger Outstandings: Payables',
    keys: { ...keys, ...p.key, Enter: () => flat[sel] && nav.push(<LedgerReport ledgerId={flat[sel].ledger_id} />) },
    buttons: [p.button],
  });
  if (!data) return null;
  return (
    <Frame title={side === 'receivable' ? 'Bills Receivable' : 'Bills Payable'} subtitle={`as on ${fmtDate(period.to)}`}>
      <table className="w-full">
        <thead>
          <tr className="text-left">
            <th className={th}>Party / Ref. No.</th>
            <th className={th}>Bill date</th>
            <th className={th}>Due on</th>
            <th className={`${th} text-right`}>Overdue (days)</th>
            <th className={`${th} text-right`}>Pending amount</th>
          </tr>
        </thead>
        <tbody>
          {flat.map((l, i) => (
            <FragmentRows key={l.ledger_id} selected={i === sel} onHover={() => setSel(i)} onOpen={() => nav.push(<LedgerReport ledgerId={l.ledger_id} />)} ledger={l} />
          ))}
          <tr className="font-bold">
            <td colSpan={4} className="border-y-[3px] border-double border-tb-ink px-2">Grand Total</td>
            <td className="border-y-[3px] border-double border-tb-ink px-2 text-right tabular-nums">{fmtAmount(data.total, false)}</td>
          </tr>
        </tbody>
      </table>
      {flat.length === 0 && <div className="py-3 text-tb-muted">No outstanding bills.</div>}
    </Frame>
  );
}

function FragmentRows({ ledger, selected, onHover, onOpen }: { ledger: OS['ledgers'][number]; selected: boolean; onHover: () => void; onOpen: () => void }) {
  return (
    <>
      <tr className={rowCls(selected, 'font-bold')} onMouseEnter={onHover} onClick={onOpen}>
        <td className="px-2" colSpan={4}>{ledger.ledger}</td>
        <td className="px-2 text-right tabular-nums">{fmtAmount(ledger.total, false)}</td>
      </tr>
      {ledger.bills.map((b) => (
        <tr key={b.name}>
          <td className="pl-8 pr-2">{b.name}</td>
          <td className="px-2">{b.bill_date ? fmtDate(b.bill_date) : ''}</td>
          <td className="px-2">{b.due_date ? fmtDate(b.due_date) : ''}</td>
          <td className={`px-2 text-right ${b.overdue_days ? 'text-tb-danger' : ''}`}>{b.overdue_days || ''}</td>
          <td className="px-2 text-right tabular-nums">{fmtAmount(b.pending)}</td>
        </tr>
      ))}
      {ledger.on_account !== 0 && (
        <tr>
          <td className="pl-8 pr-2 text-tb-muted" colSpan={4}>On Account</td>
          <td className="px-2 text-right tabular-nums">{fmtAmount(ledger.on_account)}</td>
        </tr>
      )}
    </>
  );
}
