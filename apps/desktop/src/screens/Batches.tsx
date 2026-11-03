import { useEffect, useMemo, useRef, useState } from 'react';
import {
  batchList,
  batchMasters,
  batchSummary,
  fmtAmount,
  fmtDate,
  fmtQty,
  openingBatches,
  parseDate,
  parseQty,
  saveOpeningBatches,
  stockItem,
  stockItems,
  type BatchAllocInput,
  type StockItem,
} from '@tallybook/core';
import { PickerInput, type Opt } from '../ui/PickerInput.tsx';
import { useScreen } from '../registry.ts';
import { useStore } from '../store.tsx';
import { useNav } from '../nav.tsx';
import { SelectList, type ListItem } from './SelectList.tsx';
import { Frame, th, rowCls, useLoad, usePeriodKey, useSel } from './Reports.tsx';
import { useFilter, useReportOptions, type OptionDef } from './reportConfig.tsx';

interface Row {
  batch: string;
  mfg: string;
  exp: string;
  qty: string;
}

const emptyRow = (): Row => ({ batch: '', mfg: '', exp: '', qty: '' });

export interface BatchAllocationProps {
  item: StockItem;
  godownId: number;
  qty: number;
  outward: boolean;
  asOf: string;
  initial?: BatchAllocInput[];
  title?: string;
  onDone: (allocs: BatchAllocInput[]) => void;
  onCancel: () => void;
}

export function BatchAllocationDialog({ item, godownId, qty, outward, asOf, initial, title, onDone, onCancel }: BatchAllocationProps) {
  const { books, company, toast } = useStore();
  const fy = company?.fy_start;
  const [rows, setRows] = useState<Row[]>(() =>
    initial?.length ? initial.map((a) => ({ batch: a.batch, mfg: a.mfg_date ? fmtDate(a.mfg_date) : '', exp: a.expiry_date ? fmtDate(a.expiry_date) : '', qty: fmtQty(a.qty) })) : [{ ...emptyRow(), qty: fmtQty(qty) }]
  );
  const options = useLoad(async () => {
    if (outward) return (await batchList(books.db, item.id, godownId, asOf)).map((b) => ({ id: b.batch, label: b.batch, sub: `${fmtQty(b.qty, 0, item.unit)}${b.expiry_date ? `  Exp ${fmtDate(b.expiry_date)}` : ''}`, mfg: b.mfg_date, exp: b.expiry_date }));
    return (await batchMasters(books.db, item.id)).map((b) => ({ id: b.batch, label: b.batch, sub: b.expiry_date ? `Exp ${fmtDate(b.expiry_date)}` : '', mfg: b.mfg_date, exp: b.expiry_date }));
  }, [item.id, godownId, outward, asOf]);
  const refs = useRef<Record<string, HTMLInputElement | null>>({});
  const showDates = !!item.track_expiry;
  const cols = showDates ? ['batch', 'mfg', 'exp', 'qty'] : ['batch', 'qty'];
  const focus = (r: number, c: string) => setTimeout(() => refs.current[`${r}:${c}`]?.focus(), 0);
  const total = rows.reduce((s, r) => s + (parseQty(r.qty) ?? 0), 0);
  const accept = () => {
    try {
      const out: BatchAllocInput[] = [];
      for (const r of rows) {
        const q = parseQty(r.qty || '0') ?? 0;
        if (!q && !r.batch.trim()) continue;
        if (!r.batch.trim()) throw new Error('Enter the batch name');
        if (!q) throw new Error(`Enter the quantity for batch ${r.batch}`);
        const mfg = r.mfg.trim() ? parseDate(r.mfg, fy) : '';
        const exp = r.exp.trim() ? parseDate(r.exp, fy) : '';
        if ((r.mfg.trim() && !mfg) || (r.exp.trim() && !exp)) throw new Error(`Invalid date for batch ${r.batch}`);
        out.push({ batch: r.batch.trim(), mfg_date: mfg || '', expiry_date: exp || '', qty: q });
      }
      const sum = out.reduce((s, a) => s + a.qty, 0);
      if (sum !== qty) throw new Error(`Batch quantities (${fmtQty(sum)}) must add up to ${fmtQty(qty)}`);
      onDone(out);
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  useScreen({
    title: title ?? 'Batch Allocations',
    noPeriod: true,
    swallow: true,
    keys: { 'Ctrl+A': accept, Escape: onCancel },
    buttons: [{ key: 'Ctrl+A', label: 'Accept', run: accept }],
  });
  const patch = (i: number, p: Partial<Row>) => setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...p } : r)));
  const next = (i: number, c: string) => {
    const ci = cols.indexOf(c);
    if (ci < cols.length - 1) return focus(i, cols[ci + 1]);
    if (i === rows.length - 1) {
      const left = qty - total;
      if (left <= 0) return accept();
      setRows((rs) => [...rs, { ...emptyRow(), qty: fmtQty(left) }]);
    }
    focus(i + 1, cols[0]);
  };
  const keyOf = (i: number, c: string) => (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.ctrlKey) {
      e.preventDefault();
      e.stopPropagation();
      next(i, c);
    } else if (e.key === 'Backspace' && (e.currentTarget.value === '') && cols.indexOf(c) === 0 && rows.length > 1) {
      e.preventDefault();
      setRows((rs) => rs.filter((_, k) => k !== i));
    }
  };
  const opts: Opt[] = (options ?? []).map((o) => ({ id: o.id, label: o.label, sub: o.sub }));
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/10 pt-24">
      <div className="min-w-[640px] border border-tb-line bg-tb-paper shadow-lg">
        <div className="bg-tb-top px-2 py-1 text-white">{title ?? 'Batch Allocations'}</div>
        <div className="px-3 py-2">
          <div className="mb-1">
            Name of Item : <b>{item.name}</b>
            <span className="ml-6">Quantity : <b>{fmtQty(qty, 0, item.unit)}</b></span>
          </div>
          <table className="w-full">
            <thead>
              <tr className="text-left">
                <th className={th}>Batch Name</th>
                {showDates && <th className={th}>Mfg Dt.</th>}
                {showDates && <th className={th}>Expiry Date</th>}
                <th className={`${th} text-right`}>Quantity</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td className="px-1">
                    <PickerInput
                      value={r.batch}
                      onChange={(t) => patch(i, { batch: t })}
                      options={opts}
                      title={outward ? 'Batches' : 'Batch Masters'}
                      inputRef={(el) => {
                        refs.current[`${i}:batch`] = el;
                      }}
                      onPick={(o) => {
                        const m = options?.find((x) => x.id === o.id);
                        patch(i, { batch: o.label, mfg: m?.mfg ? fmtDate(m.mfg) : r.mfg, exp: m?.exp ? fmtDate(m.exp) : r.exp });
                        next(i, 'batch');
                      }}
                      onNoMatch={(t) => {
                        if (outward) return toast('Select a batch from the list', 'err');
                        if (t.trim()) {
                          patch(i, { batch: t.trim() });
                          next(i, 'batch');
                        }
                      }}
                      onCreate={outward ? undefined : (t) => t && (patch(i, { batch: t }), next(i, 'batch'))}
                    />
                  </td>
                  {showDates && (
                    <td className="px-1">
                      <input ref={(el) => void (refs.current[`${i}:mfg`] = el)} className="tb-input w-28" value={r.mfg} onChange={(e) => patch(i, { mfg: e.target.value })} onKeyDown={keyOf(i, 'mfg')} />
                    </td>
                  )}
                  {showDates && (
                    <td className="px-1">
                      <input ref={(el) => void (refs.current[`${i}:exp`] = el)} className="tb-input w-28" value={r.exp} onChange={(e) => patch(i, { exp: e.target.value })} onKeyDown={keyOf(i, 'exp')} />
                    </td>
                  )}
                  <td className="px-1">
                    <input ref={(el) => void (refs.current[`${i}:qty`] = el)} className="tb-input w-28 text-right" value={r.qty} onChange={(e) => patch(i, { qty: e.target.value })} onKeyDown={keyOf(i, 'qty')} />
                  </td>
                </tr>
              ))}
              <tr className="font-bold">
                <td className="px-2" colSpan={showDates ? 3 : 1} />
                <td className="border-t border-tb-ink px-2 text-right tabular-nums">{fmtQty(total, 0, item.unit)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export function OpeningBatchesScreen({ itemId, godownId = 1 }: { itemId: number; godownId?: number }) {
  const { books, bump, toast } = useStore();
  const nav = useNav();
  const item = useLoad(() => stockItem(books.db, itemId), [itemId]);
  const existing = useLoad(() => openingBatches(books.db, itemId), [itemId]);
  if (!item || !existing) return null;
  return (
    <BatchAllocationDialog
      item={item}
      godownId={godownId}
      qty={item.opening_qty}
      outward={false}
      asOf="9999-12-31"
      title="Stock Item Allocations"
      initial={existing.map((a) => ({ batch: a.batch, mfg_date: a.mfg_date, expiry_date: a.expiry_date, qty: a.qty }))}
      onCancel={() => nav.pop()}
      onDone={async (allocs) => {
        try {
          await saveOpeningBatches(books.db, itemId, allocs, godownId);
          bump();
          toast('Batch allocations saved', 'ok');
          nav.pop();
        } catch (e) {
          toast((e as Error).message, 'err');
        }
      }}
    />
  );
}

const BATCH_DEFS: OptionDef[] = [
  { key: 'expiredOnly', label: 'Show only Expired Batches', default: false },
  { key: 'mfg', label: 'Show Mfg Dt.', default: true },
  { key: 'godown', label: 'Show Godown', default: false },
];

export function BatchSummaryReport({ itemId }: { itemId?: number }) {
  const { books } = useStore();
  const nav = useNav();
  const [cur, setCur] = useState<number | null>(itemId ?? null);
  const items = useLoad(async (): Promise<ListItem[]> => [{ id: 0, label: 'All Items' }, ...(await stockItems(books.db)).filter((i) => i.maintain_batches).map((i) => ({ id: i.id, label: i.name }))], []);
  if (cur === null) return items ? <SelectList title="Batch Summary" heading="List of Stock Items" items={items} onSelect={(i) => setCur(Number(i.id))} /> : null;
  const change = () => items && nav.push(<SelectList title="Batch Summary" heading="List of Stock Items" items={items} popOnSelect onSelect={(i) => setCur(Number(i.id))} />);
  return <BatchSummaryView itemId={cur || null} change={change} />;
}

function BatchSummaryView({ itemId, change }: { itemId: number | null; change: () => void }) {
  const { books, period } = useStore();
  const p = usePeriodKey();
  const cfg = useReportOptions('batch-summary', 'Batch Summary', BATCH_DEFS);
  const flt = useFilter();
  const d = useLoad(() => batchSummary(books.db, itemId, period.to, { expiredOnly: cfg.values.expiredOnly }), [itemId, period, cfg.values.expiredOnly]);
  const rows = useMemo(() => d?.rows ?? [], [d]);
  const vis = rows.filter((r) => flt.match(r.item, r.batch, r.godown));
  const s = useSel(vis.length);
  const itemName = useLoad(async () => (itemId ? (await stockItem(books.db, itemId))?.name ?? '' : 'All Items'), [itemId]);
  useEffect(() => void 0, []);
  useScreen({
    title: 'Batch Summary',
    keys: { ...s.keys, ...p.key, ...cfg.key, ...flt.key, F4: change },
    buttons: [p.button, { key: 'F4', label: 'Stock Item', run: change }, cfg.button, flt.button],
  });
  if (!d) return null;
  const v = cfg.values;
  const num = 'px-2 text-right tabular-nums';
  const tot = 'border-y-[3px] border-double border-tb-ink px-2 text-right tabular-nums';
  let last = -1;
  return (
    <Frame title="Batch Summary" subtitle={`${itemName ?? ''}  as at ${fmtDate(period.to)}`}>
      {flt.bar}
      <table className="w-full">
        <thead>
          <tr>
            <th className={`${th} text-left`} rowSpan={2}>Particulars</th>
            {v.mfg && <th className={`${th} text-left`} rowSpan={2}>Mfg Dt.</th>}
            <th className={`${th} text-left`} rowSpan={2}>Expiry Date</th>
            {v.godown && <th className={`${th} text-left`} rowSpan={2}>Godown</th>}
            <th className={`${th} text-center`} colSpan={3}>Closing Balance</th>
          </tr>
          <tr>
            <th className={`${th} text-right`}>Quantity</th>
            <th className={`${th} text-right italic`}>Rate</th>
            <th className={`${th} text-right`}>Value</th>
          </tr>
        </thead>
        <tbody>
          {vis.map((r, i) => {
            const head = r.item_id !== last && !itemId;
            last = r.item_id;
            return (
              <>
                {head && (
                  <tr key={`h${r.item_id}`} className="font-bold">
                    <td className="px-2" colSpan={7}>{r.item}</td>
                  </tr>
                )}
                <tr key={`${r.item_id}-${r.godown_id}-${r.batch}`} className={rowCls(i === s.sel)} onMouseEnter={() => s.setSel(i)}>
                  <td className="px-2" style={{ paddingLeft: itemId ? 8 : 24 }}>{r.batch}</td>
                  {v.mfg && <td className="px-2">{r.mfg_date ? fmtDate(r.mfg_date) : ''}</td>}
                  <td className="px-2">{r.expiry_date ? fmtDate(r.expiry_date) : ''}</td>
                  {v.godown && <td className="px-2">{r.godown}</td>}
                  <td className={num}>{fmtQty(r.qty, 0, r.unit)}</td>
                  <td className={`${num} italic`}>{fmtAmount(r.rate)}</td>
                  <td className={num}>{fmtAmount(r.value)}</td>
                </tr>
              </>
            );
          })}
          <tr className="font-bold">
            <td className="border-y-[3px] border-double border-tb-ink px-2">Grand Total</td>
            <td className="border-y-[3px] border-double border-tb-ink" colSpan={(v.mfg ? 1 : 0) + 1 + (v.godown ? 1 : 0) + 2} />
            <td className={tot}>{fmtAmount(d.total_value, false)}</td>
          </tr>
        </tbody>
      </table>
      {vis.length === 0 && <div className="py-3 text-tb-muted">No batches. Enable Maintain in batches on the stock item and allocate batches in vouchers.</div>}
    </Frame>
  );
}
