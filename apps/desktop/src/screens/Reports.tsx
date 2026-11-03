import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  balanceSheet,
  dayBook,
  fmtAmount,
  fmtDate,
  fmtDrCr,
  groupSummary,
  groupSummaryDetailed,
  ledgerVouchers,
  outstandingAgeing,
  outstandings,
  profitAndLoss,
  type BalanceSheet as BS,
  type DayBookRow,
  type GroupSummary,
  type LedgerAgeing,
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

const CO_H = 40;

export function CoBlock({ sub, className = '' }: { sub: string; className?: string }) {
  const { company } = useStore();
  return (
    <div className={`tb-co ${className}`}>
      <div className="tb-co-name">{company?.name ?? ''}</div>
      <div>{sub}</div>
    </div>
  );
}

export function Frame({ title, subtitle, coSub, plain, children }: { title: string; subtitle?: string; coSub?: string; plain?: boolean; children: ReactNode }) {
  const { period } = useStore();
  const top = useTop();
  const ref = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [co, setCo] = useState<{ top: number; left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    const wrap = box.current;
    if (!root || !wrap) return;
    root.querySelectorAll('th, td').forEach((c) => {
      const t = c.textContent?.trim();
      if (t === 'Particulars' || t === 'Grand Total') c.classList.add('tb-spaced');
    });
    root.querySelectorAll('table').forEach((table) => {
      const body = table.tBodies[0];
      const grand = body ? Array.from(body.rows).find((r) => r.cells[0]?.textContent?.trim() === 'Grand Total') : undefined;
      if (grand) {
        grand.classList.add('tb-grand');
        table.classList.add('tb-fit');
        table.style.height = '100%';
      }
    });
    let next: { top: number; left: number; width: number } | null = null;
    const table = plain ? null : wrap.querySelector('table');
    const row = table?.tHead?.rows[0];
    const first = row?.cells[0];
    if (table && row && first && first.textContent?.trim() === 'Particulars' && row.cells.length > 1) {
      table.style.marginTop = `${CO_H}px`;
      const w = wrap.getBoundingClientRect();
      const t = table.getBoundingClientRect();
      const f = first.getBoundingClientRect();
      next = { top: Math.round(t.top - w.top - CO_H + wrap.scrollTop), left: Math.round(f.right - w.left), width: Math.round(t.right - f.right) };
    } else if (table) {
      table.style.marginTop = '';
    }
    setCo((c) => (c === next || (c && next && c.top === next.top && c.left === next.left && c.width === next.width) ? c : next));
  });
  return (
    <div ref={ref} className="-m-4 min-h-[calc(100vh-130px)] bg-white px-2 pt-1">
      <div className="flex items-start justify-between">
        <div className="text-[15px]">{title && title !== top?.title ? <b>{title}</b> : null}</div>
        {!co && !plain && <div className="tb-sub text-[13px]">{subtitle ?? `${fmtDate(period.from)} to ${fmtDate(period.to)}`}</div>}
      </div>
      <div ref={box} className="relative mt-2" style={{ height: 'calc(100vh - 185px)' }}>
        {co && (
          <div className="absolute" style={{ top: co.top, left: co.left, width: co.width, height: CO_H }}>
            <CoBlock sub={coSub ?? `${fmtDate(period.from)} to ${fmtDate(period.to)}`} className="tb-co-frame h-full" />
          </div>
        )}
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
    if (!r || (r.kind === 'ledger' && r.id === 0)) return;
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

type Row = PlRow & { open?: boolean };

interface Line {
  key: string;
  label: string;
  depth: number;
  kind?: 'heading' | 'gap' | 'total';
  inner?: number;
  outer?: number;
  pct?: number | null;
  bold?: boolean;
  italic?: boolean;
  serif?: boolean;
  target?: PlRow;
  under?: boolean;
  over?: boolean;
}

interface LineOpts {
  detailed: boolean;
  hideZero: boolean;
  match: (...parts: string[]) => boolean;
  base: number | null;
}

const amt = (n: number) => (n < 0 ? `(-)${fmtAmount(-n, false)}` : fmtAmount(n));
const fmtPct = (x: number) => `${(x * 100).toFixed(2)} %`;
const sumRows = (rows: PlRow[]) => rows.reduce((s, r) => s + r.amount, 0);

function toLines(prefix: string, rows: Row[], o: LineOpts): Line[] {
  const out: Line[] = [];
  rows.forEach((r, i) => {
    const kids = (r.children ?? []).filter((c) => r.open || !o.hideZero || c.amount !== 0);
    if (o.hideZero && r.amount === 0 && !r.bold && !kids.length) return;
    const self = o.match(r.label);
    const shown = self ? kids : kids.filter((c) => o.match(c.label));
    if (!self && !shown.length) return;
    out.push({ key: `${prefix}${i}`, label: r.label, depth: 0, outer: r.amount, bold: true, italic: !!r.bold, target: r, pct: o.base ? r.amount / o.base : null });
    if (o.detailed || r.open) {
      shown.forEach((c, j) => out.push({ key: `${prefix}${i}.${j}`, label: c.label, depth: 1, inner: c.amount, italic: c.kind !== 'group', target: c, under: j === shown.length - 1 }));
    }
  });
  return out;
}

const gapLine = (key: string): Line => ({ key, label: '', depth: 0, kind: 'gap' });

function pad(a: Line[], b: Line[], prefix: string) {
  const n = Math.max(a.length, b.length);
  const fill = (l: Line[], s: string) => [...l, ...Array.from({ length: n - l.length }, (_, i) => gapLine(`${prefix}${s}${i}`))];
  return [fill(a, 'a'), fill(b, 'b')] as const;
}

function useLineSel(lines: Line[]) {
  const keys = useMemo(() => lines.filter((l) => l.target?.id).map((l) => l.key), [lines]);
  const [cur, setCur] = useState<string | null>(null);
  const idx = cur ? keys.indexOf(cur) : -1;
  const selected = idx >= 0 ? cur : keys[0] ?? null;
  useEffect(() => {
    document.querySelector('main tr.bg-tb-sel')?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  const step = (d: number) => setCur(keys[Math.max(0, Math.min(keys.length - 1, (idx < 0 ? 0 : idx) + d))] ?? null);
  const keyMap: Record<string, KeyHandler> = {
    ArrowDown: () => step(1),
    ArrowUp: () => step(-1),
    PageDown: () => step(10),
    PageUp: () => step(-10),
    Home: () => setCur(keys[0] ?? null),
    End: () => setCur(keys[keys.length - 1] ?? null),
  };
  const line = lines.find((l) => l.key === selected) ?? null;
  return { selected, setSelected: setCur, keys: keyMap, line };
}

function useDrill() {
  const nav = useNav();
  return (r: PlRow | null | undefined) => {
    if (!r?.id) return;
    nav.push(r.kind === 'ledger' ? <LedgerReport ledgerId={r.id} /> : <GroupSummaryReport groupId={r.id} />);
  };
}

function LineRow({ l, pct, selected, onHover, onOpen }: { l: Line; pct: boolean; selected: boolean; onHover: () => void; onOpen: () => void }) {
  const cols = pct ? 4 : 3;
  if (l.kind === 'gap') return <tr><td colSpan={cols} className="px-2">&nbsp;</td></tr>;
  if (l.kind === 'heading') {
    return (
      <tr>
        <td colSpan={cols} className="px-2 pb-1 pt-3">
          <span className={`border-b border-tb-ink font-bold ${l.serif ? 'font-serif text-[16px]' : 'tb-spaced italic'}`}>{l.label}</span>
        </td>
      </tr>
    );
  }
  const click = !!l.target?.id;
  const num = 'whitespace-nowrap px-2 text-right tabular-nums';
  const total = l.kind === 'total';
  return (
    <tr
      className={`${selected ? 'bg-tb-sel text-tb-sel-ink' : ''} ${click ? 'cursor-pointer' : ''} ${l.bold || total ? 'font-bold' : ''} ${l.italic ? 'italic' : ''}`}
      onMouseEnter={click ? onHover : undefined}
      onClick={click ? onOpen : undefined}
    >
      <td className="px-2" style={{ paddingLeft: 8 + l.depth * 20 + (total ? 12 : 0) }}>{total ? <span className="tb-spaced">Total</span> : l.label}</td>
      <td className={`${num} ${l.under ? 'border-b border-tb-ink' : ''}`}>{l.inner === undefined ? '' : amt(l.inner)}</td>
      <td className={`${num} ${l.over || total ? 'border-t border-tb-ink' : ''} ${total ? 'border-b-[3px] border-double' : ''}`}>{l.outer === undefined ? '' : amt(l.outer)}</td>
      {pct && <td className={`${num} text-[13px] font-normal italic`}>{l.pct == null || l.depth ? '' : fmtPct(l.pct)}</td>}
    </tr>
  );
}

function Statement({ title, sub, lines, total, pct, selected, onSelect, onOpen }: {
  title: string; sub: string; lines: Line[]; total?: number; pct: boolean; selected: string | null; onSelect: (k: string) => void; onOpen: (r: PlRow | undefined) => void;
}) {
  const pinned = total !== undefined;
  return (
    <table className={`w-full ${pinned ? 'tb-fit h-full' : ''}`}>
      <colgroup>
        <col />
        <col style={{ width: 140 }} />
        <col style={{ width: 140 }} />
        {pct && <col style={{ width: 80 }} />}
      </colgroup>
      <thead>
        <tr>
          <th className="border-b border-tb-ink px-2 py-1 text-left align-bottom">{title && <span className="tb-spaced">{title}</span>}</th>
          <th colSpan={pct ? 3 : 2} className="border-b border-tb-ink p-0 align-bottom">
            <CoBlock sub={sub} />
          </th>
        </tr>
        <tr><th colSpan={pct ? 4 : 3} className="h-3" /></tr>
      </thead>
      <tbody>
        {lines.map((l) => (
          <LineRow key={l.key} l={l} pct={pct} selected={l.key === selected} onHover={() => onSelect(l.key)} onOpen={() => onOpen(l.target)} />
        ))}
        {pinned && (
          <tr className="tb-grand font-bold">
            <td className="px-2"><span className="tb-spaced">Total</span></td>
            <td />
            <td className="whitespace-nowrap px-2 text-right tabular-nums">{amt(total)}</td>
            {pct && <td />}
          </tr>
        )}
      </tbody>
    </table>
  );
}

function TwoSided({ left, right, sub, leftTitle, rightTitle, totalLeft, totalRight, pct, selected, onSelect, onOpen }: {
  left: Line[]; right: Line[]; sub: string; leftTitle: string; rightTitle: string; totalLeft: number; totalRight: number; pct: boolean;
  selected: string | null; onSelect: (k: string) => void; onOpen: (r: PlRow | undefined) => void;
}) {
  return (
    <div className="grid h-full grid-cols-2">
      <div className="h-full border-r border-tb-ink">
        <Statement title={leftTitle} sub={sub} lines={left} total={totalLeft} pct={pct} selected={selected} onSelect={onSelect} onOpen={onOpen} />
      </div>
      <div className="h-full">
        <Statement title={rightTitle} sub={sub} lines={right} total={totalRight} pct={pct} selected={selected} onSelect={onSelect} onOpen={onOpen} />
      </div>
    </div>
  );
}

const PL_DEFS = [
  { key: 'vertical', label: 'Show Vertical Profit & Loss', default: false },
  { key: 'gross', label: 'Show with Gross Profit', default: false },
  { key: 'pct', label: 'Show Percentages', default: false },
  { key: 'hideZero', label: 'Exclude Accounts with zero Closing Balance', default: true },
];

function plVertical(d: PL, o: LineOpts): Line[] {
  const P = d.parts;
  const pctOf = (n: number) => (o.base ? n / o.base : null);
  const out: Line[] = [{ key: 'h1', kind: 'heading', label: 'Trading Account:', depth: 0 }, ...toLines('s', [P.sales, P.directIncomes], o)];
  const cost = (P.openingStock?.amount ?? 0) + P.purchases.amount + P.directExpenses.amount - (P.closingStock?.amount ?? 0);
  const parts: [string, PlRow | null][] = [['Opening Stock', P.openingStock], ['Add: Purchase Accounts', P.purchases], ['Add: Direct Expenses', P.directExpenses], ['Less: Closing Stock', P.closingStock]];
  const shown = parts.filter((x): x is [string, PlRow] => !!x[1] && (!o.hideZero || x[1].amount !== 0));
  out.push({ key: 'cost', label: 'Cost of Sales :', depth: 0, outer: cost, bold: true, pct: pctOf(cost) });
  shown.forEach(([label, r], j) => out.push({ key: `c${j}`, label, depth: 1, inner: r.amount, target: r, under: j === shown.length - 1 }));
  out.push({ key: 'gp', label: d.gross >= 0 ? 'Gross Profit :' : 'Gross Loss :', depth: 0, outer: Math.abs(d.gross), bold: true, over: true, pct: pctOf(d.gross) });
  out.push({ key: 'h2', kind: 'heading', label: 'Income Statement:', depth: 0 });
  out.push(...toLines('ii', [P.indirectIncomes], o));
  out.push({ key: 'sub', label: '', depth: 0, outer: d.gross + P.indirectIncomes.amount, over: true });
  out.push(...toLines('ie', [P.indirectExpenses], o));
  out.push({ key: 'np', label: d.net >= 0 ? 'Nett Profit :' : 'Nett Loss :', depth: 0, outer: Math.abs(d.net), bold: true, over: true, pct: pctOf(d.net) });
  return out;
}

export function ProfitLossReport() {
  const { books, period } = useStore();
  const p = usePeriodKey();
  const cfg = useReportOptions('profit-loss', 'Profit & Loss A/c', PL_DEFS);
  const flt = useFilter();
  const drill = useDrill();
  const [detailed, setDetailed] = useState(false);
  const data = useLoad<PL>(() => profitAndLoss(books.db, period.from, period.to), [period]);
  const v = cfg.values;
  const view = useMemo(() => {
    if (!data) return null;
    const o: LineOpts = { detailed, hideZero: v.hideZero, match: flt.match, base: v.pct && data.sales ? data.sales : null };
    if (v.vertical) return { vertical: plVertical(data, o), left: [], right: [], totalLeft: 0, totalRight: 0 };
    if (!v.gross) return { vertical: null, left: toLines('l', data.single.left, o), right: toLines('r', data.single.right, o), totalLeft: data.single.totalLeft, totalRight: data.single.totalRight };
    const [tl, tr] = pad(toLines('tl', data.trading.left, o), toLines('tr', data.trading.right, o), 'tp');
    const sub = (key: string, n: number): Line => ({ key, label: '', depth: 0, outer: n, over: true });
    const [pl, pr] = pad(toLines('pl', data.pl.left, o), toLines('pr', data.pl.right, o), 'pp');
    return {
      vertical: null,
      left: [...tl, sub('tls', data.trading.totalLeft), gapLine('g1'), ...pl],
      right: [...tr, sub('trs', data.trading.totalRight), gapLine('g2'), ...pr],
      totalLeft: data.pl.totalLeft,
      totalRight: data.pl.totalRight,
    };
  }, [data, detailed, v.hideZero, v.pct, v.vertical, v.gross, flt.match]);
  const all = useMemo(() => (view ? view.vertical ?? [...view.left, ...view.right] : []), [view]);
  const s = useLineSel(all);
  const toggle = () => setDetailed((d) => !d);
  useScreen({
    title: 'Profit & Loss A/c',
    keys: { ...s.keys, ...p.key, ...cfg.key, ...flt.key, Enter: () => drill(s.line?.target), 'Alt+F1': toggle },
    buttons: [p.button, { key: 'Alt+F1', label: detailed ? 'Condensed' : 'Detailed', run: toggle }, cfg.button, flt.button],
  });
  if (!view) return null;
  const range = `${fmtDate(period.from)} to ${fmtDate(period.to)}`;
  return (
    <Frame title="Profit & Loss A/c" plain>
      {flt.bar}
      {view.vertical ? (
        <Statement title="Particulars" sub={range} lines={view.vertical} pct={v.pct} selected={s.selected} onSelect={s.setSelected} onOpen={drill} />
      ) : (
        <TwoSided leftTitle="Particulars" rightTitle="Particulars" sub={range} left={view.left} right={view.right} totalLeft={view.totalLeft} totalRight={view.totalRight} pct={v.pct} selected={s.selected} onSelect={s.setSelected} onOpen={drill} />
      )}
    </Frame>
  );
}

const BS_DEFS = [
  { key: 'vertical', label: 'Show Vertical Balance Sheet', default: false },
  { key: 'pct', label: 'Show Percentages', default: false },
  { key: 'wc', label: 'Show Working Capital figures', default: false },
  { key: 'lossLiab', label: 'Show Loss also under Liabilities', default: false },
  { key: 'hideZero', label: 'Exclude Accounts with zero Closing Balance', default: true },
];

function arrangeBs(d: BS, wc: boolean, lossLiab: boolean) {
  let liabilities: Row[] = [...d.liabilities];
  let assets: Row[] = [...d.assets];
  if (wc) {
    const cl = liabilities.find((r) => r.kind === 'group' && r.label === 'Current Liabilities');
    const ca = assets.find((r) => r.kind === 'group' && r.label === 'Current Assets');
    const cs = assets.find((r) => r.kind === 'stock' && r.label === 'Closing Stock');
    if (ca && cl) {
      const at = assets.indexOf(ca);
      liabilities = liabilities.filter((r) => r !== cl);
      assets = assets.filter((r) => r !== ca && r !== cs);
      const children: PlRow[] = [{ ...ca, children: undefined }, ...(cs ? [{ ...cs, children: undefined }] : []), { id: cl.id, kind: 'group', label: 'Less: Current Liabilities', amount: -cl.amount }];
      assets.splice(Math.min(at, assets.length), 0, { label: 'Working Capital', amount: d.working_capital.amount, open: true, children });
    }
  }
  if (lossLiab) {
    const loss = assets.find((r) => !r.id && r.label === 'Profit & Loss A/c');
    if (loss) {
      assets = assets.filter((r) => r !== loss);
      const neg: Row = { ...loss, amount: -loss.amount, children: loss.children?.map((c) => ({ ...c, amount: -c.amount })) };
      const at = liabilities.findIndex((r) => r.label === 'Difference in Opening Balances');
      liabilities.splice(at < 0 ? liabilities.length : at, 0, neg);
    }
  }
  return { liabilities, assets, totalLiabilities: sumRows(liabilities), totalAssets: sumRows(assets) };
}

export function BalanceSheetReport() {
  const { books, period } = useStore();
  const p = usePeriodKey();
  const cfg = useReportOptions('balance-sheet', 'Balance Sheet', BS_DEFS);
  const flt = useFilter();
  const drill = useDrill();
  const [detailed, setDetailed] = useState(false);
  const data = useLoad<BS>(() => balanceSheet(books.db, period.from, period.to), [period]);
  const v = cfg.values;
  const view = useMemo(() => {
    if (!data) return null;
    const b = arrangeBs(data, v.wc, v.lossLiab);
    const o = (base: number): LineOpts => ({ detailed, hideZero: v.hideZero, match: flt.match, base: v.pct && base ? base : null });
    const left = toLines('L', b.liabilities, o(b.totalLiabilities));
    const right = toLines('A', b.assets, o(b.totalAssets));
    const vertical: Line[] | null = v.vertical
      ? [
          { key: 'hs', kind: 'heading', label: 'Sources of Funds:', depth: 0, serif: true },
          ...left,
          { key: 'ts', kind: 'total', label: 'Total', depth: 0, outer: b.totalLiabilities },
          { key: 'ha', kind: 'heading', label: 'Application of Funds:', depth: 0, serif: true },
          ...right,
          { key: 'ta', kind: 'total', label: 'Total', depth: 0, outer: b.totalAssets },
        ]
      : null;
    return { left, right, vertical, totalLeft: b.totalLiabilities, totalRight: b.totalAssets };
  }, [data, detailed, v.wc, v.lossLiab, v.hideZero, v.pct, v.vertical, flt.match]);
  const all = useMemo(() => (view ? view.vertical ?? [...view.left, ...view.right] : []), [view]);
  const s = useLineSel(all);
  const toggle = () => setDetailed((d) => !d);
  useScreen({
    title: 'Balance Sheet',
    keys: { ...s.keys, ...p.key, ...cfg.key, ...flt.key, Enter: () => drill(s.line?.target), 'Alt+F1': toggle },
    buttons: [p.button, { key: 'Alt+F1', label: detailed ? 'Condensed' : 'Detailed', run: toggle }, cfg.button, flt.button],
  });
  if (!view) return null;
  const asAt = `as at ${fmtDate(period.to)}`;
  return (
    <Frame title="Balance Sheet" plain>
      {flt.bar}
      {view.vertical ? (
        <Statement title="" sub={asAt} lines={view.vertical} pct={v.pct} selected={s.selected} onSelect={s.setSelected} onOpen={drill} />
      ) : (
        <TwoSided leftTitle="Liabilities" rightTitle="Assets" sub={asAt} left={view.left} right={view.right} totalLeft={view.totalLeft} totalRight={view.totalRight} pct={v.pct} selected={s.selected} onSelect={s.setSelected} onOpen={drill} />
      )}
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

const OS_DEFS = [
  { key: 'ageing', label: 'Show ageing', default: false },
  { key: 'byDue', label: 'Ageing by Due Date (Bill Date when no due date)', default: true },
];

export function OutstandingsReport({ side }: { side: 'receivable' | 'payable' }) {
  const { books, period } = useStore();
  const nav = useNav();
  const p = usePeriodKey();
  const cfg = useReportOptions(`outstandings-${side}`, side === 'receivable' ? 'Bills Receivable' : 'Bills Payable', OS_DEFS);
  const data = useLoad<OS>(() => outstandings(books.db, side, period.to, period.from), [period, side]);
  const flat = useMemo(() => (data ? data.ledgers : []), [data]);
  const ageing = useMemo(() => (data && cfg.values.ageing ? outstandingAgeing(data, cfg.values.byDue ? 'due' : 'bill') : null), [data, cfg.values.ageing, cfg.values.byDue]);
  const { sel, setSel, keys } = useSel(flat.length);
  useScreen({
    title: side === 'receivable' ? 'Ledger Outstandings: Receivables' : 'Ledger Outstandings: Payables',
    keys: { ...keys, ...p.key, ...cfg.key, Enter: () => flat[sel] && nav.push(<LedgerReport ledgerId={flat[sel].ledger_id} />) },
    buttons: [p.button, cfg.button],
  });
  if (!data) return null;
  const grand = 'border-y-[3px] border-double border-tb-ink px-2 text-right tabular-nums';
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
            {ageing?.labels.map((l) => <th key={l} className={`${th} text-right`}>{l}</th>)}
          </tr>
        </thead>
        <tbody>
          {flat.map((l, i) => (
            <FragmentRows key={l.ledger_id} selected={i === sel} onHover={() => setSel(i)} onOpen={() => nav.push(<LedgerReport ledgerId={l.ledger_id} />)} ledger={l} ageing={ageing?.ledgers[i] ?? null} cols={ageing?.labels.length ?? 0} />
          ))}
          <tr className="font-bold">
            <td colSpan={4} className="border-y-[3px] border-double border-tb-ink px-2">Grand Total</td>
            <td className={grand}>{fmtAmount(data.total, false)}</td>
            {ageing?.total.map((t, k) => <td key={k} className={grand}>{fmtAmount(t)}</td>)}
          </tr>
        </tbody>
      </table>
      {flat.length === 0 && <div className="py-3 text-tb-muted">No outstanding bills.</div>}
    </Frame>
  );
}

function FragmentRows({ ledger, ageing, cols, selected, onHover, onOpen }: { ledger: OS['ledgers'][number]; ageing: LedgerAgeing | null; cols: number; selected: boolean; onHover: () => void; onOpen: () => void }) {
  const num = 'px-2 text-right tabular-nums';
  const blanks = Array.from({ length: cols }, (_, k) => <td key={k} />);
  return (
    <>
      <tr className={rowCls(selected, 'font-bold')} onMouseEnter={onHover} onClick={onOpen}>
        <td className="px-2" colSpan={4}>{ledger.ledger}</td>
        <td className={num}>{fmtAmount(ledger.total, false)}</td>
        {ageing?.buckets.map((b, k) => <td key={k} className={num}>{fmtAmount(b)}</td>)}
      </tr>
      {ledger.bills.map((b, j) => (
        <tr key={b.name}>
          <td className="pl-8 pr-2">{b.name}</td>
          <td className="px-2">{b.bill_date ? fmtDate(b.bill_date) : ''}</td>
          <td className="px-2">{b.due_date ? fmtDate(b.due_date) : ''}</td>
          <td className={`px-2 text-right ${b.overdue_days ? 'text-tb-danger' : ''}`}>{b.overdue_days || ''}</td>
          <td className={num}>{fmtAmount(b.pending)}</td>
          {ageing && Array.from({ length: cols }, (_, k) => <td key={k} className={num}>{ageing.bills[j] === k ? fmtAmount(b.pending) : ''}</td>)}
        </tr>
      ))}
      {ledger.on_account !== 0 && (
        <tr>
          <td className="pl-8 pr-2 text-tb-muted" colSpan={4}>On Account</td>
          <td className={num}>{fmtAmount(ledger.on_account)}</td>
          {blanks}
        </tr>
      )}
    </>
  );
}
