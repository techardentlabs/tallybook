import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ageingInwardDetails,
  ageingLabel,
  billsPending,
  fmtAmount,
  fmtDate,
  fmtQty,
  getAgeingPeriods,
  godownMonthly,
  godownSummary,
  godownTransfers,
  godownVouchers,
  godowns,
  itemMovementAnalysis,
  itemVoucherAnalysis,
  ledgerMovementAnalysis,
  orderOutstandingSummary,
  orderOutstandings,
  reorderStatus,
  setAgeingPeriods,
  setOrderPreclosed,
  stockAgeing,
  stockCategories,
  stockGroups,
  stockHierarchySummary,
  stockItem,
  stockItems,
  stockMovementAnalysis,
  stockQuery,
  stockTransferAnalysis,
  topBuyersSellers,
  type AgeingLine,
  type AgeingStyle,
  type FlowReport,
  type FlowRow,
  type OrderRow,
  type StockHierarchyRow,
} from '@tallybook/core';
import { Form, type FieldDef, type FormHandle } from '../ui/Form.tsx';
import { useScreen, type Btn, type KeyHandler } from '../registry.ts';
import { useStore } from '../store.tsx';
import { useNav } from '../nav.tsx';
import { useDialogs } from '../ui/Dialogs.tsx';
import { SelectList, type ListItem } from './SelectList.tsx';
import { Frame, th, rowCls, useLoad, usePeriodKey, useSel } from './Reports.tsx';
import { useFilter, useReportOptions, type OptionDef } from './reportConfig.tsx';
import { VoucherScreen } from './Voucher.tsx';
import { StockItemReport } from './Inventory.tsx';

export const num = 'px-2 text-right tabular-nums';
export const tot = 'border-y-[3px] border-double border-tb-ink px-2 text-right tabular-nums';
const totL = 'border-y-[3px] border-double border-tb-ink px-2';
const spaced = 'tracking-[0.3em]';
const Q = (v: number | null, u = '') => (v ? fmtQty(v, 0, u) : '');
const R = (v: number, u = '') => (v ? `${fmtAmount(v)}${u ? `/${u}` : ''}` : '');
const periodText = (f: string, t: string) => `${fmtDate(f)} to ${fmtDate(t)}`;

function useReport(name: string, title: string, defs: OptionDef[], keys: Record<string, KeyHandler>, buttons: Btn[], count: number, opts: { noPeriod?: boolean } = {}) {
  const p = usePeriodKey();
  const cfg = useReportOptions(name, title, defs);
  const flt = useFilter();
  const s = useSel(count);
  useScreen({
    title,
    noPeriod: opts.noPeriod,
    keys: { ...s.keys, ...p.key, ...cfg.key, ...flt.key, ...keys },
    buttons: [p.button, ...buttons, cfg.button, flt.button],
  });
  return { p, cfg, flt, ...s };
}

export function Gate({
  id,
  title,
  heading,
  load,
  children,
}: {
  id?: number | null;
  title: string;
  heading: string;
  load: () => Promise<ListItem[]>;
  children: (id: number, change: () => void) => ReactNode;
}) {
  const nav = useNav();
  const items = useLoad(load, []);
  const [cur, setCur] = useState<number | null>(id ?? null);
  if (cur === null) return items ? <SelectList title={title} heading={heading} items={items} onSelect={(i) => setCur(Number(i.id))} /> : null;
  const change = () => items && nav.push(<SelectList title={title} heading={heading} items={items} popOnSelect onSelect={(i) => setCur(Number(i.id))} />);
  return <div key={cur}>{children(cur, change)}</div>;
}

export const loadStockItems = async (db: Parameters<typeof stockItems>[0]): Promise<ListItem[]> => (await stockItems(db)).map((i) => ({ id: i.id, label: i.name }));
const loadGroups = async (db: Parameters<typeof stockItems>[0], primary = true): Promise<ListItem[]> => [...(primary ? [{ id: 0, label: 'Primary' }] : []), ...(await stockGroups(db)).map((g) => ({ id: g.id, label: g.name }))];
const loadCategories = async (db: Parameters<typeof stockItems>[0]): Promise<ListItem[]> => [{ id: 0, label: 'Primary' }, ...(await stockCategories(db)).map((g) => ({ id: g.id, label: g.name }))];

const openVoucher = (nav: ReturnType<typeof useNav>, id: number) => nav.push(<VoucherScreen voucherId={id} />);

const QUERY_DEFS: OptionDef[] = [{ key: 'last5', label: 'Show only last 5 transactions (default 10)', default: false }];

export function StockQueryReport({ itemId }: { itemId?: number }) {
  const { books } = useStore();
  return (
    <Gate id={itemId} title="Stock Query" heading="List of Stock Items" load={() => loadStockItems(books.db)}>
      {(id, change) => <StockQueryView itemId={id} change={change} />}
    </Gate>
  );
}

function StockQueryView({ itemId, change }: { itemId: number; change: () => void }) {
  const { books, period } = useStore();
  const nav = useNav();
  const [vertical, setVertical] = useState(false);
  const [reorders, setReorders] = useState(false);
  const [nett, setNett] = useState(false);
  const cfgFirst = useReportOptions('stock-query', 'Stock Query', QUERY_DEFS);
  const last = cfgFirst.values.last5 ? 5 : 10;
  const d = useLoad(() => stockQuery(books.db, itemId, period.to, last), [itemId, period, last]);
  const [side, setSide] = useState<'p' | 's'>('p');
  const [i, setI] = useState(0);
  const p = usePeriodKey();
  const flt = useFilter();
  const ref = useRef({ side, i, d });
  ref.current = { side, i, d };
  const open = () => {
    const l = ref.current.side === 'p' ? ref.current.d?.purchases : ref.current.d?.sales;
    const t = l?.[ref.current.i];
    if (t) openVoucher(nav, t.voucher_id);
  };
  const top = () => nav.push(<TopBuyersSellersReport itemId={itemId} />);
  useScreen({
    title: 'Stock Query',
    keys: {
      ...p.key,
      ...cfgFirst.key,
      ...flt.key,
      F4: change,
      F7: () => setReorders((r) => !r),
      'Ctrl+H': () => setVertical((v) => !v),
      'Ctrl+B': () => setNett((n) => !n),
      'Ctrl+F7': top,
      ArrowDown: () => setI((x) => Math.min(x + 1, Math.max(0, (ref.current.side === 'p' ? ref.current.d?.purchases.length : ref.current.d?.sales.length) ?? 1) - 1)),
      ArrowUp: () => setI((x) => Math.max(0, x - 1)),
      ArrowLeft: () => (setSide('p'), setI(0)),
      ArrowRight: () => (setSide('s'), setI(0)),
      Enter: open,
    },
    buttons: [
      p.button,
      { key: 'F4', label: 'Stock Item', run: change },
      { key: 'F7', label: reorders ? 'Hide Reorders' : 'Show Reorders', run: () => setReorders((r) => !r) },
      { key: 'Ctrl+B', label: 'Basis of Values', run: () => setNett((n) => !n) },
      { key: 'Ctrl+H', label: 'Change View', run: () => setVertical((v) => !v) },
      { key: 'Ctrl+F7', label: 'Top Buyers/Sellers', run: top },
      cfgFirst.button,
      flt.button,
    ],
  });
  if (!d) return null;
  const it = d.item;
  const u = it.unit;
  const info = (k: string, v: ReactNode) => (
    <div className="flex">
      <span className="w-40">{k}</span>
      <span className="pr-2">:</span>
      <b>{v}</b>
    </div>
  );
  const txn = (rows: typeof d.purchases, mine: boolean) => (
    <table className="w-full">
      <thead>
        <tr className="text-left">
          <th className={th}>Date</th>
          <th className={th}>Party Name</th>
          <th className={`${th} text-right`}>Quantity</th>
          <th className={`${th} text-right`}>Rate</th>
          <th className={`${th} text-right`}>Disc %</th>
          <th className={`${th} text-right`}>Amount</th>
        </tr>
      </thead>
      <tbody>
        {rows
          .filter((r) => flt.match(r.party))
          .map((r, k) => {
            const rate = nett && r.qty ? Math.round((r.amount * 1000) / r.qty) : r.rate;
            return (
              <tr key={k} className={rowCls(mine && k === i, '')} onClick={() => (setSide(rows === d.purchases ? 'p' : 's'), setI(k))}>
                <td className="px-2">{fmtDate(r.date)}</td>
                <td className="px-2 font-bold">{r.party}</td>
                <td className={`${num} font-bold`}>{fmtQty(r.qty, 0, u)}</td>
                <td className={num}>{fmtAmount(rate)}</td>
                <td className={num}>{r.discount_bp ? `${(r.discount_bp / 100).toFixed(2)}` : ''}</td>
                <td className={`${num} font-bold`}>{fmtAmount(r.amount)}</td>
              </tr>
            );
          })}
      </tbody>
    </table>
  );
  const lastLine = (l: typeof d.last_purchase, label: string) => (
    <div className="flex gap-4 px-2 py-1">
      <span>{label}</span>
      <b>{l ? fmtDate(l.date) : ''}</b>
      <span>{l?.party}</span>
      {l && (
        <span className="ml-auto">
          <b>{fmtQty(l.qty, 0, u)}</b> @ <b>{fmtAmount(l.rate)}/{u}</b>
        </span>
      )}
    </div>
  );
  const panel = (title: string, body: ReactNode) => (
    <div className="border border-tb-line">
      <div className="border-b border-tb-line text-center font-bold">{title}</div>
      {body}
    </div>
  );
  const total = d.godown_batches.reduce((s, g) => s + g.qty, 0);
  const r = d.reorder;
  return (
    <Frame title="Stock Query" subtitle={periodText(period.from, period.to)}>
      {flt.bar}
      <div className="mb-2 grid grid-cols-2 gap-x-8">
        <div>
          {info('Name', it.name)}
          {info('Group', d.group)}
          {info('Closing Balance', fmtQty(d.closing_qty, 0, u))}
          {info('Cost price', d.cost_rate ? `${fmtAmount(d.cost_rate)}/${u}` : '')}
          {info('Costing method', it.costing_method || 'Avg Cost')}
          {info('Standard cost', it.standard_cost ? `${fmtAmount(it.standard_cost)}/${u}` : '')}
        </div>
        <div>
          {info('Part No.', it.part_no)}
          {info('Category', d.category)}
          {info('Closing value', fmtAmount(d.closing_value))}
          {info('Standard selling price', it.standard_price ? `${fmtAmount(it.standard_price)}/${u}` : '')}
          {info('Market valuation method', it.market_method || 'Not Applicable')}
        </div>
      </div>
      {reorders && r && (
        <div className="mb-2 grid grid-cols-4 gap-x-8 border border-tb-line px-2 py-1">
          {info('Reorder level', Q(r.reorder_level, u))}
          {info('Nett available', fmtQty(r.nett_available, 0, u))}
          {info('Short fall', Q(r.shortfall, u))}
          {info('Order to be placed', Q(r.order_to_be_placed, u))}
        </div>
      )}
      <div className={vertical ? 'grid grid-cols-1 gap-2' : 'grid grid-cols-2 gap-2'}>
        {panel('Purchases', <>{lastLine(d.last_purchase, 'Last purchased on')}{txn(d.purchases, side === 'p')}</>)}
        {panel('Sales', <>{lastLine(d.last_sale, 'Last sold on')}{txn(d.sales, side === 's')}</>)}
        {panel(
          'Godown /Batch Details',
          <table className="w-full">
            <thead>
              <tr className="text-left">
                <th className={th}>Godown</th>
                <th className={th}>Batch</th>
                <th className={`${th} text-right`}>Quantity</th>
              </tr>
            </thead>
            <tbody>
              {d.godown_batches.map((g, k) => (
                <tr key={k}>
                  <td className="px-2">{g.godown}</td>
                  <td className="px-2">{g.batch}</td>
                  <td className={num}>{fmtQty(g.qty, 0, u)}</td>
                </tr>
              ))}
              <tr className="font-bold">
                <td className="px-2 italic font-normal" colSpan={2}>Total</td>
                <td className={`${num} border-t border-tb-ink`}>{fmtQty(total, 0, u)}</td>
              </tr>
            </tbody>
          </table>
        )}
        {panel(
          'Items of Same Category',
          <table className="w-full">
            <thead>
              <tr className="text-left">
                <th className={th}>Item Name</th>
                <th className={`${th} text-right`}>Quantity</th>
                <th className={`${th} text-right`}>Cost</th>
                <th className={`${th} text-right`}>Sale Price</th>
              </tr>
            </thead>
            <tbody>
              {d.same_category.map((c) => (
                <tr key={c.item_id}>
                  <td className="px-2">{c.name}</td>
                  <td className={num}>{fmtQty(c.qty, 0, c.unit)}</td>
                  <td className={num}>{fmtAmount(c.cost)}</td>
                  <td className={num}>{fmtAmount(c.price)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Frame>
  );
}

export function TopBuyersSellersReport({ itemId }: { itemId: number }) {
  const { books, period } = useStore();
  const p = usePeriodKey();
  const item = useLoad(() => stockItem(books.db, itemId), [itemId]);
  const d = useLoad(() => topBuyersSellers(books.db, itemId, period.from, period.to), [itemId, period]);
  const [sel, setSel] = useState(0);
  const flt = useFilter();
  const cfg = useReportOptions('top-buyers', 'Top Buyers / Sellers', QUERY_DEFS);
  useScreen({
    title: 'Top Buyers / Sellers',
    keys: { ...p.key, ...flt.key, ...cfg.key, ArrowDown: () => setSel((s) => s + 1), ArrowUp: () => setSel((s) => Math.max(0, s - 1)) },
    buttons: [p.button, cfg.button, flt.button],
  });
  if (!d || !item) return null;
  const side = (title: string, rows: typeof d.purchase) => (
    <div className="border border-tb-line">
      <div className="border-b border-tb-line text-center font-bold">{title}</div>
      <table className="w-full">
        <thead>
          <tr>
            <th className={`${th} text-left`}>Particulars</th>
            <th className={`${th} text-right`}>Quantity</th>
            <th className={`${th} text-right`}>Value</th>
          </tr>
        </thead>
        <tbody>
          {rows
            .filter((r) => flt.match(r.party))
            .map((r, i) => (
              <tr key={i} className={rowCls(i === sel, 'font-bold')}>
                <td className="px-2">{r.party}</td>
                <td className={num}>{fmtQty(r.qty, 0, item.unit)}</td>
                <td className={num}>{fmtAmount(r.value)}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
  return (
    <Frame title="Top Buyers / Sellers" subtitle={`For Stock Item: ${item.name} (Based on Value)  ${periodText(period.from, period.to)}`}>
      {flt.bar}
      <div className="grid grid-cols-2 gap-2">
        {side('Purchase', d.purchase)}
        {side('Sales', d.sales)}
      </div>
    </Frame>
  );
}

const GODOWN_DEFS: OptionDef[] = [{ key: 'hideZero', label: 'Hide godowns with zero closing balance', default: false }];

export function GodownSummaryReport({ godownId }: { godownId?: number }) {
  const { books, period } = useStore();
  const nav = useNav();
  const [gid, setGid] = useState<number | undefined>(godownId);
  const [detailed, setDetailed] = useState(true);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const d = useLoad(() => godownSummary(books.db, period.to, gid), [period, gid]);
  const rows = useMemo(() => d?.rows ?? [], [d]);
  type Flat = { godown: number; item?: number; name: string; qty: number | null; rate: number; value: number; unit: string };
  const [mode, setMode] = useState<'closing' | 'monthly'>('closing');
  const flat = useMemo(() => {
    const out: Flat[] = [];
    for (const g of rows) {
      out.push({ godown: g.godown_id, name: g.name, qty: g.qty, rate: g.rate, value: g.value, unit: g.items[0]?.unit ?? '' });
      if (detailed || open.has(g.godown_id) || gid) for (const i of g.items) out.push({ godown: g.godown_id, item: i.item_id, name: i.name, qty: i.qty, rate: i.rate, value: i.value, unit: i.unit });
    }
    return out;
  }, [rows, detailed, open, gid]);
  const ctl = useReport('godown-summary', 'Godown Summary', GODOWN_DEFS, {}, [], flat.length);
  const shown = ctl.cfg.values.hideZero ? flat.filter((r) => r.value || r.qty) : flat;
  const visible = shown.filter((r) => ctl.flt.match(r.name));
  const cur = visible[ctl.sel];
  const pickGodown = async () => {
    const gs = await godowns(books.db);
    nav.push(<SelectList title="Godown Summary" heading="List of Godowns" items={gs.map((g) => ({ id: g.id, label: g.name }))} popOnSelect onSelect={(i) => setGid(Number(i.id))} />);
  };
  const drill = () => {
    if (!cur) return;
    if (cur.item) nav.push(<GodownMonthlyReport godownId={cur.godown} itemId={cur.item} />);
    else if (mode === 'monthly') nav.push(<GodownMonthlyReport godownId={cur.godown} itemId={null} />);
    else if (gid) return;
    else nav.push(<GodownSummaryReport godownId={cur.godown} />);
  };
  useScreen({
    title: 'Godown Summary',
    keys: {
      ...ctl.keys,
      ...ctl.p.key,
      ...ctl.cfg.key,
      ...ctl.flt.key,
      F4: () => void pickGodown(),
      'Alt+F5': () => setDetailed((x) => !x),
      'Shift+Enter': () => cur && !cur.item && setOpen((s) => (s.has(cur.godown) ? new Set([...s].filter((x) => x !== cur.godown)) : new Set(s).add(cur.godown))),
      'Ctrl+H': () => setMode((m) => (m === 'closing' ? 'monthly' : 'closing')),
      Enter: drill,
    },
    buttons: [
      ctl.p.button,
      { key: 'F4', label: 'Godown', run: () => void pickGodown() },
      { key: 'Ctrl+H', label: mode === 'closing' ? 'Change View (Monthly Summary)' : 'Change View (Closing Balance)', run: () => setMode((m) => (m === 'closing' ? 'monthly' : 'closing')) },
      { key: 'Alt+F5', label: detailed ? 'Condensed' : 'Detailed', run: () => setDetailed((x) => !x) },
      ctl.cfg.button,
      ctl.flt.button,
    ],
  });
  if (!d) return null;
  return (
    <Frame title="Godown Summary" subtitle={periodText(period.from, period.to)}>
      {ctl.flt.bar}
      <table className="w-full">
        <thead>
          <tr>
            <th className={`${th} ${spaced} text-left`} rowSpan={2}>Particulars</th>
            <th className={`${th} text-center`} colSpan={3}>Closing Balance</th>
          </tr>
          <tr>
            <th className={`${th} text-right`}>Quantity</th>
            <th className={`${th} text-right italic`}>Rate</th>
            <th className={`${th} text-right`}>Value</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((r, i) => (
            <tr key={`${r.godown}-${r.item ?? 0}`} className={rowCls(i === ctl.sel, r.item ? '' : 'font-bold')} onMouseEnter={() => ctl.setSel(i)} onClick={drill}>
              <td className="px-2" style={{ paddingLeft: r.item ? 24 : 8 }}>{r.name}</td>
              <td className={num}>{Q(r.qty, r.unit)}</td>
              <td className={`${num} italic`}>{R(r.rate)}</td>
              <td className={num}>{fmtAmount(r.value)}</td>
            </tr>
          ))}
          <tr className="font-bold">
            <td className={totL}>Grand Total</td>
            <td className={tot} colSpan={2} />
            <td className={tot}>{fmtAmount(d.value, false)}</td>
          </tr>
        </tbody>
      </table>
      {visible.length === 0 && <div className="py-3 text-tb-muted">No stock in any godown.</div>}
    </Frame>
  );
}

const MONTHLY_DEFS: OptionDef[] = [{ key: 'chart', label: 'Show outward quantity chart', default: true }];

export function GodownMonthlyReport({ godownId, itemId }: { godownId: number; itemId: number | null }) {
  const { books, period } = useStore();
  const nav = useNav();
  const [item, setItem] = useState<number | null>(itemId);
  const d = useLoad(async () => ({ m: await godownMonthly(books.db, godownId, item, period.from, period.to), g: (await godowns(books.db)).find((x) => x.id === godownId), it: item ? await stockItem(books.db, item) : null }), [godownId, item, period]);
  const rows = d?.m.rows ?? [];
  const pickItem = async () => {
    const items = await loadStockItems(books.db);
    nav.push(<SelectList title="Godown Monthly Summary" heading="List of Stock Items" items={items} popOnSelect onSelect={(i) => setItem(Number(i.id))} />);
  };
  const month = (m: string) => {
    const from = `${m}-01`;
    const to = `${m}-${String(new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0).getDate()).padStart(2, '0')}`;
    return { from: from < period.from ? period.from : from, to: to > period.to ? period.to : to };
  };
  const ctl = useReport('godown-monthly', 'Godown Monthly Summary', MONTHLY_DEFS, {}, [{ key: 'F4', label: 'Stock Item', run: () => void pickItem() }], rows.length);
  const vis = rows.filter((r) => ctl.flt.match(r.label));
  const drill = () => {
    const r = vis[ctl.sel];
    if (r && item) nav.push(<GodownVouchersReport godownId={godownId} itemId={item} from={month(r.month).from} to={month(r.month).to} />);
  };
  useScreen({
    title: 'Godown Monthly Summary',
    keys: { ...ctl.keys, ...ctl.p.key, ...ctl.cfg.key, ...ctl.flt.key, F4: () => void pickItem(), Enter: drill },
    buttons: [ctl.p.button, { key: 'F4', label: 'Stock Item', run: () => void pickItem() }, ctl.cfg.button, ctl.flt.button],
  });
  if (!d) return null;
  const u = d.it?.unit ?? '';
  const max = Math.max(1, ...rows.map((r) => r.out_qty));
  return (
    <Frame title="Godown Monthly Summary" subtitle={`Godown: ${d.g?.name ?? ''}${d.it ? `  ${d.it.name}` : ''}  ${periodText(period.from, period.to)}`}>
      {ctl.flt.bar}
      <table className="w-full">
        <thead>
          <tr>
            <th className={`${th} ${spaced} text-left`} rowSpan={2}>Particulars</th>
            <th className={`${th} text-center`} colSpan={2}>Inwards</th>
            <th className={`${th} text-center`} colSpan={2}>Outwards</th>
            <th className={`${th} text-center`} colSpan={2}>Closing Balance</th>
          </tr>
          <tr>
            {[0, 1, 2].flatMap((k) => [<th key={`q${k}`} className={`${th} text-right`}>Quantity</th>, <th key={`v${k}`} className={`${th} text-right`}>Value</th>])}
          </tr>
        </thead>
        <tbody>
          <tr className="italic">
            <td className="px-2">Opening Balance</td>
            <td colSpan={4} />
            <td className={`${num} font-bold`}>{Q(d.m.opening_qty, u)}</td>
            <td className={`${num} font-bold`}>{fmtAmount(d.m.opening_value)}</td>
          </tr>
          {vis.map((r, i) => (
            <tr key={r.month} className={rowCls(i === ctl.sel)} onMouseEnter={() => ctl.setSel(i)} onClick={drill}>
              <td className="px-2">{r.label}</td>
              <td className={num}>{Q(r.in_qty, u)}</td>
              <td className={num}>{fmtAmount(r.in_value)}</td>
              <td className={num}>{Q(r.out_qty, u)}</td>
              <td className={num}>{fmtAmount(r.out_value)}</td>
              <td className={num}>{Q(r.closing_qty, u)}</td>
              <td className={num}>{fmtAmount(r.closing_value)}</td>
            </tr>
          ))}
          <tr className="font-bold">
            <td className={`${totL} ${spaced}`}>Grand Total</td>
            <td className={tot}>{Q(d.m.total.in_qty, u)}</td>
            <td className={tot}>{fmtAmount(d.m.total.in_value)}</td>
            <td className={tot}>{Q(d.m.total.out_qty, u)}</td>
            <td className={tot}>{fmtAmount(d.m.total.out_value)}</td>
            <td className={tot}>{Q(d.m.total.closing_qty, u)}</td>
            <td className={tot}>{fmtAmount(d.m.total.closing_value)}</td>
          </tr>
        </tbody>
      </table>
      {ctl.cfg.values.chart && (
        <div className="mt-2 flex h-28 items-end gap-2 border-l border-b border-tb-ink px-2">
          {rows.map((r) => (
            <div key={r.month} className="flex flex-1 flex-col items-center justify-end">
              <div className="w-6 border border-tb-ink bg-[#0000ff]" style={{ height: `${(r.out_qty / max) * 80}px` }} />
              <span className="text-xs">{r.label.slice(0, 3)}</span>
            </div>
          ))}
        </div>
      )}
    </Frame>
  );
}

const VOUCHERS_DEFS: OptionDef[] = [{ key: 'narr', label: 'Show Voucher type with number', default: true }];

export function GodownVouchersReport({ godownId, itemId, from, to }: { godownId: number; itemId: number; from?: string; to?: string }) {
  const { books, period } = useStore();
  const nav = useNav();
  const f = from ?? period.from;
  const t = to ?? period.to;
  const d = useLoad(async () => ({ v: await godownVouchers(books.db, godownId, itemId, f, t), it: await stockItem(books.db, itemId), g: (await godowns(books.db)).find((x) => x.id === godownId) }), [godownId, itemId, f, t]);
  const ctl = useReport('godown-vouchers', 'Godown Vouchers', VOUCHERS_DEFS, {}, [], d?.v.rows.length ?? 0, {});
  const rows = (d?.v.rows ?? []).filter((r) => ctl.flt.match(r.particulars, r.type, r.number));
  const open = () => rows[ctl.sel] && openVoucher(nav, rows[ctl.sel].voucher_id);
  useScreen({ title: 'Godown Vouchers', keys: { ...ctl.keys, ...ctl.p.key, ...ctl.cfg.key, ...ctl.flt.key, Enter: open }, buttons: [ctl.p.button, ctl.cfg.button, ctl.flt.button] });
  if (!d || !d.it) return null;
  const u = d.it.unit;
  return (
    <Frame title="Godown Vouchers" subtitle={`Stock Item: ${d.it.name}  Godown: ${d.g?.name ?? ''}  ${periodText(f, t)}`}>
      {ctl.flt.bar}
      <table className="w-full">
        <thead>
          <tr>
            <th className={`${th} text-left`} rowSpan={2}>Date</th>
            <th className={`${th} text-left`} rowSpan={2}>Particulars</th>
            <th className={`${th} text-left`} rowSpan={2}>Vch Type</th>
            <th className={`${th} text-left`} rowSpan={2}>Vch No.</th>
            <th className={`${th} text-center`} colSpan={2}>Inwards</th>
            <th className={`${th} text-center`} colSpan={2}>Outwards</th>
            <th className={`${th} text-center`} colSpan={2}>Closing</th>
          </tr>
          <tr>
            {[0, 1, 2].flatMap((k) => [<th key={`q${k}`} className={`${th} text-right`}>Quantity</th>, <th key={`v${k}`} className={`${th} text-right`}>Value</th>])}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="px-2">{fmtDate(f)}</td>
            <td className="px-2 font-bold" colSpan={3}>Opening Balance</td>
            <td colSpan={4} />
            <td className={`${num} font-bold`}>{Q(d.v.opening_qty, u)}</td>
            <td className={`${num} font-bold`}>{fmtAmount(d.v.opening_value)}</td>
          </tr>
          {rows.map((r, i) => (
            <tr key={i} className={rowCls(i === ctl.sel)} onMouseEnter={() => ctl.setSel(i)} onClick={open}>
              <td className="px-2">{fmtDate(r.date)}</td>
              <td className="px-2 font-bold">{r.particulars}</td>
              <td className="px-2">{r.type}</td>
              <td className="px-2">{r.number}</td>
              <td className={num}>{Q(r.in_qty, u)}</td>
              <td className={num}>{fmtAmount(r.in_value)}</td>
              <td className={num}>{Q(r.out_qty, u)}</td>
              <td className={num}>{fmtAmount(r.out_value)}</td>
              <td className={num}>{Q(r.closing_qty, u)}</td>
              <td className={num}>{fmtAmount(r.closing_value)}</td>
            </tr>
          ))}
          <tr className="font-bold">
            <td className={totL} colSpan={4}>Totals as per 'Default' valuation :</td>
            <td className={tot}>{fmtQty(d.v.totals.in_qty, 0, u)}</td>
            <td className={tot}>{fmtAmount(d.v.totals.in_value)}</td>
            <td className={tot}>{fmtQty(d.v.totals.out_qty, 0, u)}</td>
            <td className={tot}>{fmtAmount(d.v.totals.out_value)}</td>
            <td className={tot}>{fmtQty(d.v.totals.closing_qty, 0, u)}</td>
            <td className={tot}>{fmtAmount(d.v.totals.closing_value)}</td>
          </tr>
        </tbody>
      </table>
    </Frame>
  );
}

const MOVE_DEFS: OptionDef[] = [{ key: 'basic', label: 'Show Basic Rate', default: true }];

export function ItemMovementReport({ itemId }: { itemId?: number }) {
  const { books } = useStore();
  return (
    <Gate id={itemId} title="Item Movement Analysis" heading="List of Stock Items" load={() => loadStockItems(books.db)}>
      {(id, change) => <ItemMovementView itemId={id} change={change} />}
    </Gate>
  );
}

function ItemMovementView({ itemId, change }: { itemId: number; change: () => void }) {
  const { books, period } = useStore();
  const nav = useNav();
  const item = useLoad(() => stockItem(books.db, itemId), [itemId]);
  const d = useLoad(() => itemMovementAnalysis(books.db, itemId, period.from, period.to), [itemId, period]);
  type Flat = { head?: string; sub?: string; line?: { key: string; name: string; dir: 'in' | 'out'; qty: number; basic_rate: number; eff_rate: number; value: number }; total?: { qty: number; eff_rate: number; value: number } };
  const flat = useMemo(() => {
    const out: Flat[] = [];
    if (!d) return out;
    for (const [dir, secs, tt, head] of [['in', d.inward, d.in_total, 'Movement Inward:'], ['out', d.outward, d.out_total, 'Movement Outward:']] as const) {
      out.push({ head });
      for (const s of secs) {
        out.push({ sub: s.title });
        for (const l of s.lines) out.push({ line: { ...l, dir } });
      }
      out.push({ total: tt });
    }
    return out;
  }, [d]);
  const lineIdx = flat.map((f, i) => (f.line ? i : -1)).filter((i) => i >= 0);
  const ctl = useReport('item-movement', 'Item Movement Analysis', MOVE_DEFS, {}, [{ key: 'F4', label: 'Stock Item', run: change }], lineIdx.length);
  const cur = flat[lineIdx[ctl.sel]]?.line;
  const open = () => {
    if (!cur) return;
    const isTransfer = cur.name === cur.key;
    nav.push(<ItemVoucherAnalysisReport itemId={itemId} direction={cur.dir} partyId={isTransfer ? undefined : Number(cur.key)} type={isTransfer ? cur.name : undefined} title={cur.name} />);
  };
  useScreen({ title: 'Item Movement Analysis', keys: { ...ctl.keys, ...ctl.p.key, ...ctl.cfg.key, ...ctl.flt.key, F4: change, Enter: open }, buttons: [ctl.p.button, { key: 'F4', label: 'Stock Item', run: change }, ctl.cfg.button, ctl.flt.button] });
  if (!d || !item) return null;
  const u = item.unit;
  const basic = ctl.cfg.values.basic;
  let li = -1;
  return (
    <Frame title="Item Movement Analysis" subtitle={`${item.name}  ${periodText(period.from, period.to)}`}>
      {ctl.flt.bar}
      <table className="w-full">
        <thead>
          <tr>
            <th className={`${th} ${spaced} text-left`} rowSpan={2}>Particulars</th>
            <th className={`${th} text-center`} colSpan={basic ? 4 : 3}>Movement Values</th>
          </tr>
          <tr>
            <th className={`${th} text-right`}>Quantity</th>
            {basic && <th className={`${th} text-right italic`}>Basic Rate</th>}
            <th className={`${th} text-right italic`}>Effective Rate</th>
            <th className={`${th} text-right`}>Value</th>
          </tr>
        </thead>
        <tbody>
          {flat.map((f, k) => {
            if (f.head) return <tr key={k}><td className="px-2 pt-3 font-bold underline" colSpan={5}>{f.head}</td></tr>;
            if (f.sub) return <tr key={k}><td className="px-6 italic" colSpan={5}>{f.sub}</td></tr>;
            if (f.total)
              return (
                <tr key={k} className="font-bold">
                  <td />
                  <td className={`${num} border-t border-tb-ink`}>{fmtQty(f.total.qty, 0, u)}</td>
                  {basic && <td className="border-t border-tb-ink" />}
                  <td className={`${num} border-t border-tb-ink`}>{R(f.total.eff_rate)}</td>
                  <td className={`${num} border-t border-tb-ink`}>{fmtAmount(f.total.value)}</td>
                </tr>
              );
            const l = f.line!;
            li += 1;
            if (!ctl.flt.match(l.name)) return null;
            const mine = li;
            return (
              <tr key={k} className={rowCls(mine === ctl.sel)} onMouseEnter={() => ctl.setSel(mine)} onClick={open}>
                <td className="px-10">{l.name}</td>
                <td className={num}>{fmtQty(l.qty, 0, u)}</td>
                {basic && <td className={`${num} italic`}>{R(l.basic_rate)}</td>}
                <td className={`${num} italic`}>{R(l.eff_rate)}</td>
                <td className={num}>{fmtAmount(l.value)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Frame>
  );
}

export function ItemVoucherAnalysisReport({ itemId, direction, partyId, type, title }: { itemId: number; direction: 'in' | 'out'; partyId?: number; type?: string; title?: string }) {
  const { books, period } = useStore();
  const nav = useNav();
  const item = useLoad(() => stockItem(books.db, itemId), [itemId]);
  const d = useLoad(() => itemVoucherAnalysis(books.db, itemId, period.from, period.to, { direction, party_id: partyId, type }), [itemId, period, direction, partyId, type]);
  const ctl = useReport('item-voucher-analysis', 'Item Voucher Analysis', MOVE_DEFS, {}, [], d?.rows.length ?? 0);
  const rows = (d?.rows ?? []).filter((r) => ctl.flt.match(r.party, r.number, r.type));
  const open = () => rows[ctl.sel] && openVoucher(nav, rows[ctl.sel].voucher_id);
  useScreen({ title: 'Item Voucher Analysis', keys: { ...ctl.keys, ...ctl.p.key, ...ctl.cfg.key, ...ctl.flt.key, Enter: open }, buttons: [ctl.p.button, ctl.cfg.button, ctl.flt.button] });
  if (!d || !item) return null;
  const u = item.unit;
  return (
    <Frame title="Item Voucher Analysis" subtitle={`Stock Item: ${item.name}  ${direction === 'in' ? 'Inwards' : 'Outwards'}${title ? ` Under Ledger: ${title}` : ''}  ${periodText(period.from, period.to)}`}>
      {ctl.flt.bar}
      <table className="w-full">
        <thead>
          <tr>
            <th className={`${th} text-left`}>Date</th>
            <th className={`${th} text-left`}>Particulars</th>
            <th className={`${th} text-right`}>Actual Qty</th>
            <th className={`${th} text-right`}>Billed Qty</th>
            <th className={`${th} text-right`}>Basic Rate</th>
            <th className={`${th} text-right`}>Basic Value</th>
            <th className={`${th} text-right italic`}>Addl. Cost</th>
            <th className={`${th} text-right`}>Total Value</th>
            <th className={`${th} text-right`}>Eff. Rate</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td />
            <td className="px-2 font-bold italic underline">{direction === 'in' ? 'Purchases' : 'Sales'}</td>
          </tr>
          {rows.map((r, i) => (
            <tr key={i} className={rowCls(i === ctl.sel)} onMouseEnter={() => ctl.setSel(i)} onClick={open}>
              <td className="px-2">{fmtDate(r.date)}</td>
              <td className="px-2 font-bold">{r.party || r.type}</td>
              <td className={num}>{fmtQty(r.qty, 0, u)}</td>
              <td className={num}>{fmtQty(r.qty, 0, u)}</td>
              <td className={num}>{fmtAmount(r.basic_rate)}/{u}</td>
              <td className={num}>{fmtAmount(r.basic_value)}</td>
              <td className={num}>{r.value > r.basic_value ? fmtAmount(r.value - r.basic_value) : ''}</td>
              <td className={num}>{fmtAmount(r.value)}</td>
              <td className={num}>{fmtAmount(r.eff_rate)}</td>
            </tr>
          ))}
          <tr className="font-bold">
            <td className="px-2 pl-16">T o t a l</td>
            <td />
            <td className={`${num} border-t border-tb-ink`}>{fmtQty(d.qty, 0, u)}</td>
            <td className={`${num} border-t border-tb-ink`}>{fmtQty(d.qty, 0, u)}</td>
            <td className="border-t border-tb-ink" />
            <td className={`${num} border-t border-tb-ink`}>{fmtAmount(d.basic_value)}</td>
            <td className="border-t border-tb-ink" />
            <td className={`${num} border-t border-tb-ink`}>{fmtAmount(d.value)}</td>
            <td className="border-t border-tb-ink" />
          </tr>
        </tbody>
      </table>
    </Frame>
  );
}

function FlowView({ title, subject, heads, data, onOpen, extraKeys, buttons, defsKey, hideRate }: { title: string; subject: string; heads: [string, string]; data: FlowReport | null; onOpen: (r: FlowRow) => void; extraKeys: Record<string, KeyHandler>; buttons: Btn[]; defsKey: string; hideRate?: boolean }) {
  const { period } = useStore();
  const rows = data?.rows ?? [];
  const ctl = useReport(defsKey, title, MOVE_DEFS, {}, buttons, rows.length);
  const vis = rows.filter((r) => ctl.flt.match(r.name));
  const cur = vis[ctl.sel];
  useScreen({ title, keys: { ...ctl.keys, ...ctl.p.key, ...ctl.cfg.key, ...ctl.flt.key, ...extraKeys, Enter: () => cur && onOpen(cur) }, buttons: [ctl.p.button, ...buttons, ctl.cfg.button, ctl.flt.button] });
  if (!data) return null;
  const side = (qty: number, rate: number, val: number, unit: string, bold = false) => (
    <>
      <td className={`${num} ${bold ? 'font-bold' : ''}`}>{Q(qty, unit)}</td>
      <td className={`${num} italic ${bold ? 'font-bold' : ''}`}>{hideRate ? '' : R(rate)}</td>
      <td className={`${num} ${bold ? 'font-bold' : ''}`}>{fmtAmount(val)}</td>
    </>
  );
  return (
    <Frame title={title} subtitle={`${subject}  ${periodText(period.from, period.to)}`}>
      {ctl.flt.bar}
      <table className="w-full">
        <thead>
          <tr>
            <th className={`${th} ${spaced} text-left`} rowSpan={2}>Particulars</th>
            <th className={`${th} text-center`} colSpan={3}>{heads[0]}</th>
            <th className={`${th} text-center`} colSpan={3}>{heads[1]}</th>
          </tr>
          <tr>
            {[0, 1].flatMap((k) => [<th key={`q${k}`} className={`${th} text-right`}>Quantity</th>, <th key={`r${k}`} className={`${th} text-right italic`}>Eff. Rate</th>, <th key={`v${k}`} className={`${th} text-right`}>Value</th>])}
          </tr>
        </thead>
        <tbody>
          {vis.map((r, i) => (
            <tr key={`${r.kind}${r.id}`} className={rowCls(i === ctl.sel, r.kind === 'item' ? '' : 'font-bold')} onMouseEnter={() => ctl.setSel(i)} onClick={() => onOpen(r)}>
              <td className="px-2">{r.name}</td>
              {side(r.in_qty, r.in_rate, r.in_value, r.unit)}
              {side(r.out_qty, r.out_rate, r.out_value, r.unit)}
            </tr>
          ))}
          <tr className="font-bold">
            <td className={`${totL} ${spaced}`}>Grand Total</td>
            <td className={tot}>{data.total.in_qty ? fmtQty(data.total.in_qty) : ''}</td>
            <td className={tot}>{hideRate ? '' : R(data.total.in_rate)}</td>
            <td className={tot}>{fmtAmount(data.total.in_value)}</td>
            <td className={tot}>{data.total.out_qty ? fmtQty(data.total.out_qty) : ''}</td>
            <td className={tot}>{hideRate ? '' : R(data.total.out_rate)}</td>
            <td className={tot}>{fmtAmount(data.total.out_value)}</td>
          </tr>
        </tbody>
      </table>
    </Frame>
  );
}

export function StockGroupMovementReport({ by = 'group', id }: { by?: 'group' | 'category'; id?: number | null }) {
  const { books } = useStore();
  return (
    <Gate id={id === undefined ? undefined : id ?? 0} title={by === 'group' ? 'Stock Group Analysis' : 'Stock Category Analysis'} heading={by === 'group' ? 'List of Stock Groups' : 'List of Stock Categories'} load={() => (by === 'group' ? loadGroups(books.db) : loadCategories(books.db))}>
      {(gid, change) => <StockGroupMovementView by={by} id={gid || null} change={change} />}
    </Gate>
  );
}

function StockGroupMovementView({ by, id, change }: { by: 'group' | 'category'; id: number | null; change: () => void }) {
  const { books, period } = useStore();
  const nav = useNav();
  const [itemWise, setItemWise] = useState(false);
  const d = useLoad(() => stockMovementAnalysis(books.db, by, id, period.from, period.to, itemWise), [by, id, period, itemWise]);
  const buttons: Btn[] = [{ key: 'F4', label: by === 'group' ? 'Stock Group' : 'Stock Category', run: change }, ...(by === 'group' ? [{ key: 'F5', label: itemWise ? 'Group-wise' : 'Stock Item-wise', run: () => setItemWise((x) => !x) }] : [])];
  const subject = d?.title ?? '';
  return (
    <FlowView
      title={by === 'group' ? 'Stock Group Analysis' : 'Stock Category Analysis'}
      subject={subject}
      heads={['Inward', 'Outward']}
      data={d}
      defsKey={`stock-${by}-analysis`}
      buttons={buttons}
      extraKeys={{ F4: change, F5: () => void (by === 'group' && setItemWise((x) => !x)) }}
      onOpen={(r) => (r.kind === 'item' ? nav.push(<ItemMovementReport itemId={r.id} />) : nav.push(<StockGroupMovementReport by={by} id={r.id} />))}
    />
  );
}

export function GroupAnalysisReport({ groupId }: { groupId?: number }) {
  const { books } = useStore();
  return (
    <Gate id={groupId} title="Group Analysis" heading="List of Groups" load={async () => (await books.groups()).map((g) => ({ id: g.id, label: g.name }))}>
      {(gid, change) => <LedgerFlowView by="group" id={gid} change={change} />}
    </Gate>
  );
}

export function LedgerAnalysisReport({ ledgerId }: { ledgerId?: number }) {
  const { books } = useStore();
  return (
    <Gate id={ledgerId} title="Ledger Analysis" heading="List of Ledgers" load={async () => (await books.ledgers()).map((g) => ({ id: g.id, label: g.name }))}>
      {(gid, change) => <LedgerFlowView by="ledger" id={gid} change={change} />}
    </Gate>
  );
}

function LedgerFlowView({ by, id, change }: { by: 'group' | 'ledger'; id: number; change: () => void }) {
  const { books, period } = useStore();
  const nav = useNav();
  const d = useLoad(() => ledgerMovementAnalysis(books.db, by, id, period.from, period.to), [by, id, period]);
  return (
    <FlowView
      title={by === 'group' ? 'Group Analysis' : 'Ledger Analysis'}
      subject={d?.title ?? ''}
      heads={['Purchases', 'Sales']}
      data={d}
      defsKey={`${by}-analysis`}
      buttons={[{ key: 'F4', label: by === 'group' ? 'Group' : 'Ledger', run: change }]}
      extraKeys={{ F4: change }}
      onOpen={(r) => nav.push(<ItemMovementReport itemId={r.id} />)}
    />
  );
}

export function StockTransferAnalysisReport({ typeId }: { typeId?: number }) {
  const { books } = useStore();
  return (
    <Gate
      id={typeId}
      title="Transfer Analysis"
      heading="List of Voucher Types"
      load={async () => (await books.voucherTypes()).filter((t) => ['Stock Journal', 'Physical Stock', 'Delivery Note', 'Receipt Note', 'Rejection In', 'Rejection Out'].includes(t.parent)).map((t) => ({ id: t.id, label: t.name }))}
    >
      {(tid, change) => <TransferView typeId={tid} change={change} />}
    </Gate>
  );
}

function TransferView({ typeId, change }: { typeId: number; change: () => void }) {
  const { books, period } = useStore();
  const nav = useNav();
  const d = useLoad(() => stockTransferAnalysis(books.db, typeId, period.from, period.to), [typeId, period]);
  return (
    <FlowView
      title="Transfer Analysis"
      subject={d?.title ?? ''}
      heads={['Goods In (Production)', 'Goods Out (Consumption)']}
      data={d}
      defsKey="transfer-analysis"
      buttons={[{ key: 'F4', label: 'Voucher Type', run: change }]}
      extraKeys={{ F4: change }}
      onOpen={(r) => nav.push(<ItemMovementReport itemId={r.id} />)}
    />
  );
}

const SUMMARY_DEFS: OptionDef[] = [
  { key: 'opening', label: 'Show opening balances', default: false },
  { key: 'inwards', label: 'Show goods inwards', default: false },
  { key: 'outwards', label: 'Show goods outwards', default: false },
  { key: 'closing', label: 'Show closing balances', default: true },
  { key: 'hideZero', label: 'Hide items and groups with zero closing balance', default: false },
];

export function StockHierarchySummaryReport({ by, id }: { by: 'group' | 'category'; id?: number | null }) {
  const { books } = useStore();
  return (
    <Gate id={id === undefined ? undefined : id ?? 0} title={by === 'group' ? 'Stock Group Summary' : 'Stock Category Summary'} heading={by === 'group' ? 'List of Stock Groups' : 'List of Stock Categories'} load={() => (by === 'group' ? loadGroups(books.db) : loadCategories(books.db))}>
      {(gid, change) => <HierarchyView by={by} id={gid || null} change={change} />}
    </Gate>
  );
}

function HierarchyView({ by, id, change }: { by: 'group' | 'category'; id: number | null; change: () => void }) {
  const { books, period } = useStore();
  const nav = useNav();
  const title = by === 'group' ? 'Stock Group Summary' : 'Stock Category Summary';
  const d = useLoad(() => stockHierarchySummary(books.db, by, id, period.from, period.to), [by, id, period]);
  const [rows0, setRows0] = useState<StockHierarchyRow[]>([]);
  useEffect(() => setRows0(d?.rows ?? []), [d]);
  const ctl = useReport(`stock-${by}-summary`, title, SUMMARY_DEFS, {}, [{ key: 'F4', label: by === 'group' ? 'Stock Group' : 'Stock Category', run: change }], rows0.length);
  const v = ctl.cfg.values;
  const rows = rows0.filter((r) => ctl.flt.match(r.name) && (!v.hideZero || r.closing_qty || r.closing_value));
  const open = () => {
    const r = rows[ctl.sel];
    if (!r) return;
    nav.push(r.kind === 'item' ? <StockItemReport itemId={r.id} /> : <HierarchyGate by={by} id={r.id} />);
  };
  useScreen({ title, keys: { ...ctl.keys, ...ctl.p.key, ...ctl.cfg.key, ...ctl.flt.key, F4: change, Enter: open }, buttons: [ctl.p.button, { key: 'F4', label: by === 'group' ? 'Stock Group' : 'Stock Category', run: change }, ctl.cfg.button, ctl.flt.button] });
  if (!d) return null;
  const cols = (r: StockHierarchyRow, bold: boolean, cell: string) => (
    <>
      {v.opening && <><td className={cell}>{Q(r.opening_qty, r.unit)}</td><td className={cell}>{fmtAmount(r.opening_value)}</td></>}
      {v.inwards && <><td className={cell}>{Q(r.in_qty, r.unit)}</td><td className={cell}>{fmtAmount(r.in_value)}</td></>}
      {v.outwards && <><td className={cell}>{Q(r.out_qty, r.unit)}</td><td className={cell}>{fmtAmount(r.out_value)}</td></>}
      {v.closing && <><td className={cell}>{Q(r.closing_qty, r.unit)}</td><td className={`${cell} ${bold ? '' : 'italic'}`}>{R(r.closing_rate)}</td><td className={cell}>{fmtAmount(r.closing_value, false)}</td></>}
    </>
  );
  const span = (on: boolean, n: number) => (on ? n : 0);
  return (
    <Frame title={title} subtitle={`${d.title}  ${periodText(period.from, period.to)}`}>
      {ctl.flt.bar}
      <table className="w-full">
        <thead>
          <tr>
            <th className={`${th} ${spaced} text-left`} rowSpan={2}>Particulars</th>
            {v.opening && <th className={`${th} text-center`} colSpan={2}>Opening Balance</th>}
            {v.inwards && <th className={`${th} text-center`} colSpan={2}>Inwards</th>}
            {v.outwards && <th className={`${th} text-center`} colSpan={2}>Outwards</th>}
            {v.closing && <th className={`${th} text-center`} colSpan={3}>Closing Balance</th>}
          </tr>
          <tr>
            {span(v.opening, 1) > 0 && [<th key="a" className={`${th} text-right`}>Quantity</th>, <th key="b" className={`${th} text-right`}>Value</th>]}
            {span(v.inwards, 1) > 0 && [<th key="c" className={`${th} text-right`}>Quantity</th>, <th key="d" className={`${th} text-right`}>Value</th>]}
            {span(v.outwards, 1) > 0 && [<th key="e" className={`${th} text-right`}>Quantity</th>, <th key="f" className={`${th} text-right`}>Value</th>]}
            {v.closing && [<th key="g" className={`${th} text-right`}>Quantity</th>, <th key="h" className={`${th} text-right italic`}>Rate</th>, <th key="i" className={`${th} text-right`}>Value</th>]}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.kind}${r.id}`} className={rowCls(i === ctl.sel, r.kind === 'item' ? '' : 'font-bold')} onMouseEnter={() => ctl.setSel(i)} onClick={open}>
              <td className="px-2">{r.name}</td>
              {cols(r, r.kind !== 'item', num)}
            </tr>
          ))}
          <tr className="font-bold">
            <td className={totL}>Grand Total</td>
            {cols({ ...d.total, closing_rate: 0 }, true, tot)}
          </tr>
        </tbody>
      </table>
    </Frame>
  );
}

function HierarchyGate({ by, id }: { by: 'group' | 'category'; id: number }) {
  const nav = useNav();
  return <HierarchyView by={by} id={id} change={() => nav.pop()} />;
}

const AGEING_DEFS: OptionDef[] = [
  { key: 'batches', label: 'Show batch-wise lines', default: true },
];
const STYLES: { id: AgeingStyle; label: string }[] = [
  { id: 'purchase', label: 'By Date of Purchase' },
  { id: 'expiry', label: 'By Expiry Date' },
  { id: 'mfg', label: 'By Mfg. Date' },
  { id: 'toExpire', label: 'To be Expired' },
];

function AgeingPeriodsForm() {
  const { books, bump, toast } = useStore();
  const nav = useNav();
  const form = useRef<FormHandle>(null);
  const cur = useLoad(() => getAgeingPeriods(books.db), []);
  const save = async () => {
    const v = form.current?.submit();
    if (!v || !cur) return;
    try {
      const periods = cur.map((_, i) => ({ from: Number(v[`f${i}`]) || 0, to: Number(v[`t${i}`]) || 0 }));
      await setAgeingPeriods(books.db, periods);
      bump();
      nav.pop();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  useScreen({ title: 'Stock Ageing Alteration', noPeriod: true, keys: { 'Ctrl+A': () => void save() }, buttons: [{ key: 'Ctrl+A', label: 'Accept', run: () => void save() }] });
  if (!cur) return null;
  const fields: FieldDef[] = cur.flatMap((p, i) => [
    { key: `f${i}`, label: 'From', kind: 'text' as const, initial: String(p.from) },
    { key: `t${i}`, label: 'To', kind: 'text' as const, initial: String(p.to) },
  ]);
  return (
    <div className="max-w-md">
      <Form ref={form} fields={fields} onDone={() => void save()} labelWidth={120} />
    </div>
  );
}

function AgeingStyleForm({ style, expired, onDone }: { style: AgeingStyle; expired: boolean; onDone: (s: AgeingStyle, e: boolean) => void }) {
  const nav = useNav();
  const form = useRef<FormHandle>(null);
  const save = () => {
    const v = form.current?.submit();
    if (!v) return;
    nav.pop();
    onDone((v.style as AgeingStyle) ?? style, !!v.expired);
  };
  useScreen({ title: 'Ageing Style', noPeriod: true, keys: { 'Ctrl+A': save }, buttons: [{ key: 'Ctrl+A', label: 'Accept', run: save }] });
  const opts = STYLES.map((s) => ({ id: s.id, label: s.label }));
  const fields: FieldDef[] = [
    { key: 'style', label: 'Ageing Style', kind: 'picker', title: 'Ageing Styles', options: opts, initial: opts.find((o) => o.id === style), required: true },
    { key: 'expired', label: 'Show only Expired Batches', kind: 'toggle', initial: expired },
  ];
  return (
    <div className="max-w-xl">
      <Form ref={form} fields={fields} onDone={save} labelWidth={240} />
    </div>
  );
}

export function StockAgeingReport({ groupId }: { groupId?: number | null }) {
  const { books } = useStore();
  return (
    <Gate id={groupId === undefined ? undefined : groupId ?? 0} title="Stock Ageing Analysis" heading="List of Groups" load={() => loadGroups(books.db)}>
      {(gid, change) => <AgeingView groupId={gid || null} change={change} />}
    </Gate>
  );
}

function AgeingView({ groupId, change }: { groupId: number | null; change: () => void }) {
  const { books, period, version } = useStore();
  const nav = useNav();
  const [style, setStyle] = useState<AgeingStyle>('purchase');
  const [expired, setExpired] = useState(false);
  const [showVal, setShowVal] = useState(false);
  const d = useLoad(() => stockAgeing(books.db, groupId, period.to, { style, onlyExpired: expired }), [groupId, period, style, expired, version]);
  const gname = useLoad(async () => (groupId ? (await stockGroups(books.db)).find((g) => g.id === groupId)?.name ?? '' : 'Primary'), [groupId]);
  const [col, setCol] = useState(0);
  const cfg0 = useReportOptions('stock-ageing', 'Stock Ageing Analysis', AGEING_DEFS);
  const flat = useMemo(() => {
    const out: (AgeingLine & { child: boolean })[] = [];
    for (const r of d?.rows ?? []) {
      out.push({ ...r, child: false });
      if (cfg0.values.batches) for (const c of r.children) out.push({ ...c, child: true });
    }
    return out;
  }, [d, cfg0.values.batches]);
  const nb = d?.periods.length ?? 0;
  const s = useSel(flat.length);
  const p = usePeriodKey();
  const flt = useFilter();
  const cur = flat[s.sel];
  const open = () => {
    if (!cur) return;
    nav.push(<AgeingInwardReport itemId={cur.item_id} bucket={col === 0 ? -1 : col - 1} style={style} asOf={period.to} />);
  };
  useScreen({
    title: 'Stock Ageing Analysis',
    keys: {
      ...s.keys,
      ...p.key,
      ...cfg0.key,
      ...flt.key,
      F4: change,
      F6: () => nav.push(<AgeingPeriodsForm />),
      F7: () => setShowVal((v) => !v),
      F9: () => nav.push(<AgeingStyleForm style={style} expired={expired} onDone={(a, b) => (setStyle(a), setExpired(b))} />),
      ArrowLeft: () => setCol((c) => Math.max(0, c - 1)),
      ArrowRight: () => setCol((c) => Math.min(nb + 1, c + 1)),
      Enter: open,
    },
    buttons: [
      p.button,
      { key: 'F4', label: 'Stock Group', run: change },
      { key: 'F7', label: showVal ? 'Hide Value' : 'Show Value', run: () => setShowVal((v) => !v) },
      { key: 'F6', label: 'Ageing Periods', run: () => nav.push(<AgeingPeriodsForm />) },
      { key: 'F9', label: 'Ageing Style', run: () => nav.push(<AgeingStyleForm style={style} expired={expired} onDone={(a, b) => (setStyle(a), setExpired(b))} />) },
      cfg0.button,
      flt.button,
    ],
  });
  if (!d) return null;
  const styleLabel = STYLES.find((x) => x.id === style)!.label;
  const cell = (q: number, v: number, unit: string, active: boolean, neg = false) => (
    <td className={`${num} ${active ? 'bg-tb-sel' : ''}`}>
      {q ? (neg ? `(-)${fmtQty(q, 0, unit)}` : fmtQty(q, 0, unit)) : ''}
      {showVal && v ? <div className="text-xs">{fmtAmount(v)}</div> : null}
    </td>
  );
  return (
    <Frame title="Stock Ageing Analysis" subtitle={`as at ${fmtDate(period.to)}`}>
      {flt.bar}
      <div className="mb-1 flex justify-between">
        <div>
          <div>Items Under : <b>{gname}</b></div>
          <div>{expired ? 'Expired Batches' : 'All Batches'} (Aged {styleLabel.replace('By ', 'by ')})</div>
        </div>
        <div className="text-right">
          <b>as at {fmtDate(period.to)}</b>
          <div className="italic">Valued based on actual purchase</div>
        </div>
      </div>
      <table className="w-full">
        <thead>
          <tr>
            <th className={`${th} text-left`} rowSpan={2}>Particulars</th>
            <th className={`${th} text-left`} rowSpan={2}>Expiry Date</th>
            <th className={`${th} text-right font-normal`}>Total</th>
            {d.periods.map((pp, i) => (
              <th key={i} className={`${th} text-right font-normal`}>{ageingLabel(pp, i, d.periods.length)}</th>
            ))}
            <th className={`${th} text-right font-normal`}>Negative Stock</th>
          </tr>
          <tr>
            {Array.from({ length: nb + 2 }, (_, i) => (
              <th key={i} className={`${th} text-right font-normal`}>Quantity</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {flat
            .filter((r) => flt.match(r.name))
            .map((r, i) => (
              <tr key={r.key} className={`${i === s.sel ? 'bg-[#ffe9b8]' : ''} ${r.child ? '' : 'font-bold'} cursor-pointer`} onMouseEnter={() => s.setSel(i)} onClick={open}>
                <td className="px-2" style={{ paddingLeft: r.child ? 24 : 8 }}>{r.name}</td>
                <td className="px-2">{r.expiry_date ? fmtDate(r.expiry_date) : ''}</td>
                {cell(r.total, r.total_value, r.unit, i === s.sel && col === 0)}
                {r.buckets.map((q, k) => cell(q, r.bucket_values[k], r.unit, i === s.sel && col === k + 1))}
                {cell(r.negative, 0, r.unit, i === s.sel && col === nb + 1, true)}
              </tr>
            ))}
          <tr className="font-bold">
            <td className={totL}>Grand Total</td>
            <td className={totL} />
            <td className={tot}>{Q(d.total.total)}</td>
            {d.total.buckets.map((q, k) => (
              <td key={k} className={tot}>{Q(q)}</td>
            ))}
            <td className={tot}>{d.total.negative ? `(-)${fmtQty(d.total.negative)}` : ''}</td>
          </tr>
        </tbody>
      </table>
    </Frame>
  );
}

function AgeingInwardReport({ itemId, bucket, style, asOf }: { itemId: number; bucket: number; style: AgeingStyle; asOf: string }) {
  const { books } = useStore();
  const nav = useNav();
  const item = useLoad(() => stockItem(books.db, itemId), [itemId]);
  const rows = useLoad(() => ageingInwardDetails(books.db, itemId, asOf, bucket, { style }), [itemId, bucket, style, asOf]);
  const ctl = useReport('ageing-inwards', 'Item Inwards Details', MOVE_DEFS, {}, [], rows?.length ?? 0, { noPeriod: true });
  const vis = (rows ?? []).filter((r) => ctl.flt.match(r.party, r.number, r.batch));
  const open = () => void (vis[ctl.sel]?.voucher_id && openVoucher(nav, vis[ctl.sel].voucher_id));
  useScreen({ title: 'Item Inwards Details', noPeriod: true, keys: { ...ctl.keys, ...ctl.cfg.key, ...ctl.flt.key, Enter: open }, buttons: [ctl.cfg.button, ctl.flt.button] });
  if (!item || !rows) return null;
  return (
    <Frame title="Item Inwards Details" subtitle={`${item.name}  as at ${fmtDate(asOf)}`}>
      {ctl.flt.bar}
      <table className="w-full">
        <thead>
          <tr className="text-left">
            <th className={th}>Date</th>
            <th className={th}>Particulars</th>
            <th className={th}>Vch Type</th>
            <th className={th}>Vch No.</th>
            <th className={th}>Batch</th>
            <th className={`${th} text-right`}>Quantity</th>
            <th className={`${th} text-right`}>Rate</th>
          </tr>
        </thead>
        <tbody>
          {vis.map((r, i) => (
            <tr key={i} className={rowCls(i === ctl.sel)} onMouseEnter={() => ctl.setSel(i)} onClick={open}>
              <td className="px-2">{fmtDate(r.date)}</td>
              <td className="px-2 font-bold">{r.party || r.type}</td>
              <td className="px-2">{r.type}</td>
              <td className="px-2">{r.number}</td>
              <td className="px-2">{r.batch}</td>
              <td className={num}>{fmtQty(r.qty, 0, item.unit)}</td>
              <td className={num}>{fmtAmount(r.rate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Frame>
  );
}

const REORDER_DEFS: OptionDef[] = [{ key: 'reorderOnly', label: 'Show only items below reorder level', default: false }];

export function ReorderStatusReport({ groupId }: { groupId?: number | null }) {
  const { books } = useStore();
  return (
    <Gate id={groupId === undefined ? undefined : groupId ?? 0} title="Stock Group Reorder Status" heading="List of Stock Groups" load={() => loadGroups(books.db)}>
      {(gid, change) => <ReorderView groupId={gid || null} change={change} />}
    </Gate>
  );
}

function ReorderView({ groupId, change }: { groupId: number | null; change: () => void }) {
  const { books, period } = useStore();
  const [only, setOnly] = useState(false);
  const d = useLoad(() => reorderStatus(books.db, groupId, period.to, only), [groupId, period, only]);
  const gname = useLoad(async () => (groupId ? (await stockGroups(books.db)).find((g) => g.id === groupId)?.name ?? '' : 'Primary'), [groupId]);
  const ctl = useReport('reorder-status', 'Stock Group Reorder Status', REORDER_DEFS, { F4: change, F8: () => setOnly((o) => !o) }, [{ key: 'F4', label: 'Stock Group', run: change }, { key: 'F8', label: only ? 'All Items' : 'Reorder Only', run: () => setOnly((o) => !o) }], d?.rows.length ?? 0);
  if (!d) return null;
  const rows = d.rows.filter((r) => ctl.flt.match(r.name) && (!ctl.cfg.values.reorderOnly || r.shortfall > 0));
  return (
    <Frame title="Stock Group Reorder Status" subtitle={`as at ${fmtDate(period.to)}`}>
      {ctl.flt.bar}
      <div className="mb-1">
        Items Under : <b>{gname}</b> <span>({only ? 'reorder only' : 'all items'})</span>
      </div>
      <table className="w-full">
        <thead>
          <tr>
            <th className={`${th} text-left font-normal`}>Name of Item</th>
            <th className={`${th} text-right font-normal`}>Closing Stock</th>
            <th className={`${th} text-right font-normal`}>Purc Orders Pending</th>
            <th className={`${th} text-right font-normal`}>Sale Orders Due</th>
            <th className={`${th} text-right font-normal`}>Nett Available</th>
            <th className={`${th} text-right font-normal`}>Re-order Level</th>
            <th className={`${th} text-right font-normal`}>Short fall</th>
            <th className={`${th} text-right font-normal`}>Min Reorder Qty</th>
            <th className={`${th} text-right font-normal`}>Order to be Placed</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.item_id} className={rowCls(i === ctl.sel)} onMouseEnter={() => ctl.setSel(i)}>
              <td className="px-2">{r.name}</td>
              <td className={num}>{fmtQty(r.closing_qty, 0, r.unit)}</td>
              <td className={num}>{Q(r.purchase_orders_pending, r.unit)}</td>
              <td className={num}>{Q(r.sale_orders_due, r.unit)}</td>
              <td className={`${num} font-bold`}>{fmtQty(r.nett_available, 0, r.unit)}</td>
              <td className={num}>{Q(r.reorder_level, r.unit)}</td>
              <td className={num}>{Q(r.shortfall, r.unit)}</td>
              <td className={num}>{Q(r.min_order_qty, r.unit)}</td>
              <td className={num}>{Q(r.order_to_be_placed, r.unit)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Frame>
  );
}

const ORDER_DEFS: OptionDef[] = [{ key: 'zero', label: 'Show Stock Items with zero Quantity or Balance', default: false }];

export type OrderMode = 'stockGroup' | 'group' | 'ledger';

export function OrderOutstandingsReport({ kind, mode, subjectId }: { kind: 'Sales' | 'Purchase'; mode: OrderMode; subjectId?: number | null }) {
  const { books } = useStore();
  const title = `${kind} Order ${mode === 'stockGroup' ? 'Stock Group' : mode === 'group' ? 'Group' : 'Ledger'} Outstandings`;
  const load = async (): Promise<ListItem[]> => {
    if (mode === 'stockGroup') return loadGroups(books.db);
    if (mode === 'group') return (await books.groups()).map((g) => ({ id: g.id, label: g.name }));
    return (await books.ledgers()).map((l) => ({ id: l.id, label: l.name }));
  };
  return (
    <Gate id={subjectId === undefined ? undefined : subjectId ?? 0} title={title} heading={mode === 'stockGroup' ? 'List of Stock Groups' : mode === 'group' ? 'List of Groups' : 'List of Ledgers'} load={load}>
      {(sid, change) => <OrderSummaryView kind={kind} mode={mode} sid={sid} title={title} change={change} />}
    </Gate>
  );
}

function OrderSummaryView({ kind, mode, sid, title, change }: { kind: 'Sales' | 'Purchase'; mode: OrderMode; sid: number; title: string; change: () => void }) {
  const { books, period } = useStore();
  const nav = useNav();
  const [itemWise, setItemWise] = useState(false);
  const cfg = useReportOptions(`order-summary-${kind}`, title, ORDER_DEFS);
  const scope = useMemo(() => (mode === 'stockGroup' ? { stockGroupId: sid || null } : mode === 'group' ? { ledgerGroupId: sid } : { ledgerId: sid }), [mode, sid]);
  const d = useLoad(() => orderOutstandingSummary(books.db, kind, period.to, scope, { itemWise, showZero: cfg.values.zero }), [kind, period, scope, itemWise, cfg.values.zero]);
  const subject = useLoad(async () => {
    if (mode === 'stockGroup') return sid ? (await stockGroups(books.db)).find((g) => g.id === sid)?.name ?? '' : 'Primary';
    if (mode === 'group') return (await books.groups()).find((g) => g.id === sid)?.name ?? '';
    return (await books.ledgers()).find((l) => l.id === sid)?.name ?? '';
  }, [mode, sid]);
  const rows0 = d?.rows ?? [];
  const p = usePeriodKey();
  const flt = useFilter();
  const s = useSel(rows0.length);
  const rows = rows0.filter((r) => flt.match(r.name));
  const cur = rows[s.sel];
  const open = () => {
    if (!cur) return;
    if (cur.kind === 'group') nav.push(<OrderOutstandingsReport kind={kind} mode="stockGroup" subjectId={cur.id} />);
    else nav.push(<OrderDetailsReport kind={kind} itemId={cur.id} dueOnly={false} />);
  };
  useScreen({
    title,
    keys: { ...s.keys, ...p.key, ...cfg.key, ...flt.key, F4: change, F5: () => setItemWise((x) => !x), Enter: open },
    buttons: [p.button, { key: 'F4', label: mode === 'stockGroup' ? 'Stock Group' : mode === 'group' ? 'Group' : 'Ledger', run: change }, ...(mode === 'stockGroup' ? [{ key: 'F5', label: itemWise ? 'Stock Group-wise' : 'Stock Item-wise', run: () => setItemWise((x) => !x) }] : []), cfg.button, flt.button],
  });
  if (!d) return null;
  return (
    <Frame title={title} subtitle={`${subject ?? ''}  ${periodText(period.from, period.to)}  ${kind} Orders Outstanding`}>
      {flt.bar}
      <table className="w-full">
        <thead>
          <tr>
            <th className={`${th} ${spaced} text-left`} rowSpan={2}>Particulars</th>
            <th className={`${th} text-center`} colSpan={3}>Pending Orders</th>
          </tr>
          <tr>
            <th className={`${th} text-right font-normal`}>Quantity</th>
            <th className={`${th} text-right font-normal italic`}>Rate</th>
            <th className={`${th} text-right font-normal`}>Value</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.kind}${r.id}`} className={rowCls(i === s.sel, r.kind === 'group' ? 'font-bold' : '')} onMouseEnter={() => s.setSel(i)} onClick={open}>
              <td className="px-2">{r.name}</td>
              <td className={num}>{Q(r.qty, r.unit)}</td>
              <td className={`${num} italic`}>{R(r.rate)}</td>
              <td className={num}>{fmtAmount(r.value)}</td>
            </tr>
          ))}
          <tr className="font-bold">
            <td className={`${totL} ${spaced}`}>Grand Total</td>
            <td className={tot} colSpan={2} />
            <td className={tot}>{fmtAmount(d.total, false)}</td>
          </tr>
        </tbody>
      </table>
    </Frame>
  );
}

const DETAIL_DEFS: OptionDef[] = [{ key: 'location', label: 'Show Location details', default: false }];

export function OrderDetailsReport({ kind, itemId, dueOnly = true }: { kind: 'Sales' | 'Purchase'; itemId?: number; dueOnly?: boolean }) {
  const { books, period } = useStore();
  const nav = useNav();
  const dialogs = useDialogs();
  const { bump, toast } = useStore();
  const [item, setItem] = useState<number | undefined>(itemId);
  const [all, setAll] = useState(false);
  const [pre, setPre] = useState(false);
  const rows0 = useLoad(() => orderOutstandings(books.db, kind, period.to, { dueOnly: dueOnly && !all, all: all && !pre, preclosedOnly: pre, itemId: item }), [kind, period, dueOnly, all, pre, item]);
  const ctl = useReport(`order-details-${kind}`, 'Order Details', DETAIL_DEFS, {}, [], rows0?.length ?? 0);
  const rows = (rows0 ?? []).filter((r) => ctl.flt.match(r.party, r.item, r.number));
  const cur: OrderRow | undefined = rows[ctl.sel];
  const pickItem = async () => nav.push(<SelectList title="Order Details" heading="List of Stock Items" items={await loadStockItems(books.db)} popOnSelect onSelect={(i) => setItem(Number(i.id))} />);
  const preclose = async () => {
    if (!cur || !(await dialogs.confirm(`Preclose ${kind.toLowerCase()} order ${cur.number} for ${cur.item}?`, { title: 'Preclose Orders', def: false }))) return;
    await setOrderPreclosed(books.db, [cur.movement_id], true);
    bump();
    toast('Order preclosed', 'ok');
  };
  const open = () => cur && openVoucher(nav, cur.voucher_id);
  const btns: Btn[] = [
    { key: 'F4', label: 'Stock Item', run: () => void pickItem() },
    { key: 'F8', label: all ? 'Due Orders' : 'All Orders', run: () => setAll((a) => !a) },
    { key: 'Ctrl+B', label: 'Basis of Values', run: () => setPre((a) => !a) },
    { key: 'Alt+W', label: 'Preclose Orders', run: () => void preclose() },
  ];
  useScreen({
    title: 'Order Details',
    keys: { ...ctl.keys, ...ctl.p.key, ...ctl.cfg.key, ...ctl.flt.key, F4: () => void pickItem(), F8: () => setAll((a) => !a), 'Ctrl+B': () => setPre((a) => !a), 'Alt+W': () => void preclose(), Enter: open },
    buttons: [ctl.p.button, ...btns, ctl.cfg.button, ctl.flt.button],
  });
  if (!rows0) return null;
  const loc = ctl.cfg.values.location;
  const sum = rows.reduce((s, r) => ({ ordered: s.ordered + r.ordered, balance: s.balance + r.balance, value: s.value + r.value }), { ordered: 0, balance: 0, value: 0 });
  const label = `${kind} Orders${pre ? ' (Preclosed)' : all ? '' : dueOnly ? '(Due Only)' : ''}`;
  return (
    <Frame title="Order Details" subtitle={`${label}  ${periodText(period.from, period.to)}`}>
      {ctl.flt.bar}
      <table className="w-full">
        <thead>
          <tr>
            <th className={`${th} text-left font-normal`}>Date</th>
            <th className={`${th} text-left`}>Order Number</th>
            <th className={`${th} text-left font-normal`}>Name of Item</th>
            <th className={`${th} text-right font-normal`}>Ordered Quantity</th>
            <th className={`${th} text-right`}>Balance Quantity</th>
            <th className={`${th} text-right font-normal`}>Rate <i>(Disc)</i></th>
            <th className={`${th} text-right`}>Value</th>
            <th className={`${th} text-right font-normal`}>Due on <i>(overdue)</i></th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="px-2 pt-2 font-bold underline" colSpan={8}>{kind} Orders Outstanding:</td>
          </tr>
          {rows.map((r, i) => (
            <tr key={r.movement_id} className={rowCls(i === ctl.sel)} onMouseEnter={() => ctl.setSel(i)} onClick={open}>
              <td className="px-2 align-top">{fmtDate(r.date)}</td>
              <td className="px-2 align-top font-bold">{r.number}</td>
              <td className="px-2">
                <div className="font-bold">{r.item}</div>
                {loc && r.godown && <div className="italic">{r.godown}</div>}
                <div className="text-sm"><i>{kind === 'Sales' ? 'From:' : 'To:'}</i> {r.party}</div>
              </td>
              <td className={`${num} align-top`}>{fmtQty(r.ordered, 0, r.unit)}</td>
              <td className={`${num} align-top font-bold`}>{fmtQty(r.balance, 0, r.unit)}</td>
              <td className={`${num} align-top`}>{fmtAmount(r.rate)}{r.discount_bp ? <div className="italic">{(r.discount_bp / 100).toFixed(2)} %</div> : null}</td>
              <td className={`${num} align-top font-bold`}>{fmtAmount(r.value)}</td>
              <td className={`${num} align-top italic`}>{fmtDate(r.due_date)}<div className="font-bold">( {r.overdue_days} days)</div></td>
            </tr>
          ))}
          <tr className="font-bold">
            <td />
            <td />
            <td />
            <td className={`${num} border-t border-tb-ink`}>{Q(sum.ordered)}</td>
            <td className={`${num} border-t border-tb-ink`}>{Q(sum.balance)}</td>
            <td className="border-t border-tb-ink" />
            <td className={`${num} border-t border-tb-ink`}>{fmtAmount(sum.value)}</td>
            <td className="border-t border-tb-ink" />
          </tr>
        </tbody>
      </table>
    </Frame>
  );
}

const BILL_DEFS: OptionDef[] = [
  { key: 'cleared', label: 'Show Cleared Bills', default: false },
  { key: 'location', label: 'Show Location details', default: false },
];

export function BillsPendingReport({ kind }: { kind: 'Sales' | 'Purchase' }) {
  const { books, period } = useStore();
  const nav = useNav();
  const d = useLoad(() => billsPending(books.db, kind, period.from, period.to), [kind, period]);
  const cfg0 = useReportOptions(`bills-pending-${kind}`, `${kind} Bills Pending`, BILL_DEFS);
  const showCleared = cfg0.values.cleared;
  const all = useMemo(() => [...(d?.pending ?? []), ...(showCleared ? d?.cleared ?? [] : [])], [d, showCleared]);
  const s = useSel(all.length);
  const p = usePeriodKey();
  const flt = useFilter();
  const rows = all.filter((r) => flt.match(r.party, r.item, r.number));
  const cur = rows[s.sel];
  const open = () => cur && openVoucher(nav, cur.voucher_id);
  useScreen({ title: `${kind} Bills Pending`, keys: { ...s.keys, ...p.key, ...cfg0.key, ...flt.key, Enter: open }, buttons: [p.button, cfg0.button, flt.button] });
  if (!d) return null;
  const loc = cfg0.values.location;
  const section = (head: string, list: typeof all, offset: number) => {
    const sum = list.reduce((a, r) => ({ initial: a.initial + r.initial, pending: a.pending + r.pending, value: a.value + r.value }), { initial: 0, pending: 0, value: 0 });
    return (
      <>
        <tr>
          <td className="px-2 pt-3 font-bold underline" colSpan={7}>{head}</td>
        </tr>
        {list
          .filter((r) => flt.match(r.party, r.item, r.number))
          .map((r, i) => (
            <tr key={r.movement_id} className={rowCls(offset + i === s.sel)} onMouseEnter={() => s.setSel(offset + i)} onClick={open}>
              <td className="px-2 align-top">{fmtDate(r.date)}</td>
              <td className="px-2 align-top font-bold">{r.number}</td>
              <td className="px-2">
                <div className="font-bold">{r.item}</div>
                {loc && r.godown && <div className="italic">{r.godown}</div>}
                <div className="text-sm"><i>{kind === 'Sales' ? 'To:' : 'From:'}</i> {r.party}</div>
              </td>
              <td className={`${num} align-top`}>{fmtQty(r.initial, 0)}</td>
              <td className={`${num} align-top font-bold`}>{Q(r.pending)}</td>
              <td className={`${num} align-top`}>{fmtAmount(r.rate)}</td>
              <td className={`${num} align-top font-bold`}>{fmtAmount(r.value)}</td>
            </tr>
          ))}
        <tr className="font-bold">
          <td colSpan={3} />
          <td className={`${num} border-t border-tb-ink`}>{Q(sum.initial)}</td>
          <td className={`${num} border-t border-tb-ink`}>{Q(sum.pending)}</td>
          <td className="border-t border-tb-ink" />
          <td className={`${num} border-t border-tb-ink`}>{fmtAmount(sum.value)}</td>
        </tr>
      </>
    );
  };
  return (
    <Frame title={`${kind} Bills Pending`} subtitle={periodText(period.from, period.to)}>
      {flt.bar}
      <table className="w-full">
        <thead>
          <tr>
            <th className={`${th} text-left font-normal`}>Date</th>
            <th className={`${th} text-left`}>Tracking Number</th>
            <th className={`${th} text-left font-normal`}>Name of Item</th>
            <th className={`${th} text-right font-normal`}>Initial Quantity</th>
            <th className={`${th} text-right`}>Pending Quantity</th>
            <th className={`${th} text-right font-normal`}>Rate <i>(Disc)</i></th>
            <th className={`${th} text-right`}>Value</th>
          </tr>
        </thead>
        <tbody>
          {section(kind === 'Sales' ? 'Goods Delivered but Bills not Made :' : 'Goods Received but Bills not Made :', d.pending, 0)}
          {showCleared && section(kind === 'Sales' ? 'Sales Bills Cleared :' : 'Purchase Bills Cleared :', d.cleared, d.pending.length)}
        </tbody>
      </table>
    </Frame>
  );
}

const TRANSFER_DEFS: OptionDef[] = [{ key: 'value', label: 'Show Value', default: true }];

export function GodownTransfersReport() {
  const { books, period } = useStore();
  const nav = useNav();
  const d = useLoad(() => godownTransfers(books.db, period.from, period.to), [period]);
  const ctl = useReport('godown-transfers', 'Godown Transfers', TRANSFER_DEFS, {}, [], d?.length ?? 0);
  const rows = (d ?? []).filter((r) => ctl.flt.match(r.item, r.from_godown, r.to_godown, r.number));
  const open = () => rows[ctl.sel] && openVoucher(nav, rows[ctl.sel].voucher_id);
  useScreen({ title: 'Godown Transfers', keys: { ...ctl.keys, ...ctl.p.key, ...ctl.cfg.key, ...ctl.flt.key, Enter: open }, buttons: [ctl.p.button, ctl.cfg.button, ctl.flt.button] });
  if (!d) return null;
  const showV = ctl.cfg.values.value;
  return (
    <Frame title="Godown Transfers" subtitle={periodText(period.from, period.to)}>
      {ctl.flt.bar}
      <table className="w-full">
        <thead>
          <tr className="text-left">
            <th className={th}>Date</th>
            <th className={th}>Particulars</th>
            <th className={th}>From Godown</th>
            <th className={th}>To Godown</th>
            <th className={th}>Vch Type</th>
            <th className={th}>Vch No.</th>
            <th className={`${th} text-right`}>Quantity</th>
            {showV && <th className={`${th} text-right`}>Value</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={rowCls(i === ctl.sel)} onMouseEnter={() => ctl.setSel(i)} onClick={open}>
              <td className="px-2">{fmtDate(r.date)}</td>
              <td className="px-2 font-bold">{r.item}</td>
              <td className="px-2">{r.from_godown}</td>
              <td className="px-2">{r.to_godown}</td>
              <td className="px-2">{r.type}</td>
              <td className="px-2">{r.number}</td>
              <td className={num}>{fmtQty(r.qty, 0, r.unit)}</td>
              {showV && <td className={num}>{fmtAmount(r.value)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <div className="py-3 text-tb-muted">No godown transfers in this period.</div>}
    </Frame>
  );
}
