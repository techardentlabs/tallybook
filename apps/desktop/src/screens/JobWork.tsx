import { Fragment, useMemo, useState } from 'react';
import {
  fmtAmount,
  fmtDate,
  fmtQty,
  jobOrders,
  materialMovementRegister,
  thirdPartyStock,
  varianceAnalysis,
  type JobOrder,
  type JobWorkKind,
} from '@tallybook/core';
import { useScreen } from '../registry.ts';
import { useStore } from '../store.tsx';
import { useNav } from '../nav.tsx';
import { Frame, th, rowCls, useLoad, usePeriodKey, useSel } from './Reports.tsx';
import { useFilter, useReportOptions, type OptionDef } from './reportConfig.tsx';
import { VoucherScreen } from './Voucher.tsx';

const num = 'px-2 text-right tabular-nums';
const total = 'border-y-[3px] border-double border-tb-ink px-2';

function useKindKey(initial: JobWorkKind) {
  const [kind, setKind] = useState<JobWorkKind>(initial);
  const flip = () => setKind((k) => (k === 'Out' ? 'In' : 'Out'));
  return { kind, key: { F8: flip }, button: { key: 'F8', label: kind === 'Out' ? 'Job Work In' : 'Job Work Out', run: flip } };
}

const partyWiseKey = (on: boolean, set: (v: boolean) => void) => ({ key: { F5: () => set(!on) }, button: { key: 'F5', label: on ? 'Order-wise' : 'Party-wise', run: () => set(!on) } });

export function JobWorkOrdersSummaryReport({ kind: start = 'Out' }: { kind?: JobWorkKind }) {
  const { books, period } = useStore();
  const nav = useNav();
  const p = usePeriodKey();
  const k = useKindKey(start);
  const [partyWise, setPartyWise] = useState(false);
  const pw = partyWiseKey(partyWise, setPartyWise);
  const flt = useFilter();
  const data = useLoad(() => jobOrders(books.db, k.kind, { from: period.from, to: period.to }), [k.kind, period]);
  const rows = useMemo(() => {
    const out: { key: string; head?: string; o: JobOrder; item: string; unit: string; ordered: number; done: number; balance: number }[] = [];
    const list = [...(data ?? [])].sort((a, b) => (partyWise ? a.party.localeCompare(b.party) : 0) || a.date.localeCompare(b.date));
    let last = '';
    for (const o of list) {
      for (const l of o.lines) {
        if (!flt.match(o.number, o.party, l.item)) continue;
        const head = partyWise ? o.party : `${o.number}  ·  ${fmtDate(o.date)}  ·  ${o.party}`;
        out.push({ key: `${o.voucher_id}-${l.item_id}`, head: head !== last ? head : undefined, o, item: l.item, unit: l.unit, ordered: l.ordered, done: l.done, balance: l.balance });
        last = head;
      }
    }
    return out;
  }, [data, partyWise, flt]);
  const s = useSel(rows.length);
  const open = (i: number) => rows[i] && nav.push(<VoucherScreen voucherId={rows[i].o.voucher_id} />);
  const title = 'Job Work Orders Summary';
  useScreen({ title, keys: { ...s.keys, ...p.key, ...k.key, ...pw.key, ...flt.key, Enter: () => open(s.sel) }, buttons: [p.button, pw.button, k.button, flt.button] });
  if (!data) return null;
  return (
    <Frame title={title} subtitle={`Job Work ${k.kind}`}>
      {flt.bar}
      <table className="w-full">
        <thead>
          <tr>
            <th className={`${th} text-left`}>Particulars</th>
            <th className={`${th} text-right`}>Ordered Quantity</th>
            <th className={`${th} text-right`}>{k.kind === 'Out' ? 'Received Quantity' : 'Delivered Quantity'}</th>
            <th className={`${th} text-right`}>Balance Quantity</th>
            <th className={`${th} text-left`}>Due on</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <Fragment key={r.key}>
              {r.head && (
                <tr key={`h-${r.key}`} className="font-bold">
                  <td className="px-2" colSpan={5}>{r.head}</td>
                </tr>
              )}
              <tr key={r.key} className={rowCls(i === s.sel)} onMouseEnter={() => s.setSel(i)} onClick={() => open(i)}>
                <td className="px-2 pl-6">{r.item}</td>
                <td className={num}>{fmtQty(r.ordered, 0, r.unit)}</td>
                <td className={num}>{r.done ? fmtQty(r.done, 0, r.unit) : ''}</td>
                <td className={num}>{r.balance ? fmtQty(r.balance, 0, r.unit) : ''}</td>
                <td className="px-2">{r.o.meta.due_on ? fmtDate(r.o.meta.due_on) : ''}</td>
              </tr>
            </Fragment>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <div className="py-3 text-tb-muted">No job work orders in this period.</div>}
    </Frame>
  );
}

const COMPONENT_DEFS: OptionDef[] = [
  { key: 'outstanding', label: 'Show Outstanding Job Orders', default: true },
  { key: 'cleared', label: 'Show Cleared Job Orders', default: false },
];

export function ComponentsOrderSummaryReport({ kind: start = 'Out' }: { kind?: JobWorkKind }) {
  const { books, period } = useStore();
  const nav = useNav();
  const p = usePeriodKey();
  const k = useKindKey(start);
  const [partyWise, setPartyWise] = useState(false);
  const pw = partyWiseKey(partyWise, setPartyWise);
  const cfg = useReportOptions('jw-components', 'Components Order Summary', COMPONENT_DEFS);
  const data = useLoad(() => jobOrders(books.db, k.kind, { from: period.from, to: period.to }), [k.kind, period]);
  const rows = useMemo(() => {
    const out: { key: string; head?: string; voucher_id: number; item: string; unit: string; required: number; issued: number; balance: number }[] = [];
    const list = [...(data ?? [])].sort((a, b) => (partyWise ? a.party.localeCompare(b.party) : 0) || a.date.localeCompare(b.date));
    let last = '';
    for (const o of list) {
      const open = o.components.some((c) => c.balance > 0);
      if ((open && !cfg.values.outstanding) || (!open && !cfg.values.cleared)) continue;
      for (const c of o.components) {
        const head = partyWise ? o.party : `${o.number}  ·  ${fmtDate(o.date)}  ·  ${o.party}`;
        out.push({ key: `${o.voucher_id}-${c.item_id}`, head: head !== last ? head : undefined, voucher_id: o.voucher_id, item: c.item, unit: c.unit, required: c.required, issued: c.issued, balance: c.balance });
        last = head;
      }
    }
    return out;
  }, [data, partyWise, cfg.values.outstanding, cfg.values.cleared]);
  const s = useSel(rows.length);
  const open = (i: number) => rows[i] && nav.push(<VoucherScreen voucherId={rows[i].voucher_id} />);
  const title = 'Components Order Summary';
  useScreen({ title, keys: { ...s.keys, ...p.key, ...k.key, ...pw.key, ...cfg.key, Enter: () => open(s.sel) }, buttons: [p.button, pw.button, k.button, cfg.button] });
  if (!data) return null;
  return (
    <Frame title={title} subtitle={`Job Work ${k.kind}`}>
      <table className="w-full">
        <thead>
          <tr>
            <th className={`${th} text-left`}>Particulars</th>
            <th className={`${th} text-right`}>Required Quantity</th>
            <th className={`${th} text-right`}>{k.kind === 'Out' ? 'Issued Quantity' : 'Received Quantity'}</th>
            <th className={`${th} text-right`}>Balance Quantity</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <Fragment key={r.key}>
              {r.head && (
                <tr key={`h-${r.key}`} className="font-bold">
                  <td className="px-2" colSpan={4}>{r.head}</td>
                </tr>
              )}
              <tr key={r.key} className={rowCls(i === s.sel)} onMouseEnter={() => s.setSel(i)} onClick={() => open(i)}>
                <td className="px-2 pl-6">{r.item}</td>
                <td className={num}>{fmtQty(r.required, 0, r.unit)}</td>
                <td className={num}>{r.issued ? fmtQty(r.issued, 0, r.unit) : ''}</td>
                <td className={num}>{r.balance ? fmtQty(r.balance, 0, r.unit) : ''}</td>
              </tr>
            </Fragment>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <div className="py-3 text-tb-muted">No components to show. Components come from the bill of materials of the ordered items.</div>}
    </Frame>
  );
}

export function MaterialMovementRegisterReport({ kind: start = 'Out' }: { kind?: JobWorkKind }) {
  const { books, period } = useStore();
  const nav = useNav();
  const p = usePeriodKey();
  const k = useKindKey(start);
  const data = useLoad(() => materialMovementRegister(books.db, k.kind, period.from, period.to), [k.kind, period]);
  const rows = data ?? [];
  const s = useSel(rows.length);
  const open = (i: number) => rows[i] && nav.push(<VoucherScreen voucherId={rows[i].voucher_id} />);
  const title = 'Material Movement Register';
  useScreen({ title, keys: { ...s.keys, ...p.key, ...k.key, Enter: () => open(s.sel) }, buttons: [p.button, k.button] });
  if (!data) return null;
  const out = k.kind === 'Out';
  const headings = out
    ? ['Order Number', 'Delivery Challan Number', 'Date of Dispatch', 'Description of Goods dispatched', 'Quantity Dispatched to Job Worker', 'Name of Job Worker', 'Nature of Processing Required', 'Goods Received from Job Worker', 'Quantity Received from Job Worker']
    : ['Order Number', 'Customers Delivery Challan', 'Date of Receipt', 'Description of Goods Received', 'Quantity Received', 'Name of Principal', 'Nature of Process Required', 'Processed Goods Returned', 'Quantity Issued'];
  const sentParent = out ? 'Material Out' : 'Material In';
  return (
    <Frame title={title} subtitle={`Job Work ${k.kind}`}>
      <table className="w-full text-[14px]">
        <thead>
          <tr>
            {headings.map((h, i) => (
              <th key={h} className={`${th} ${i === 4 || i === 8 ? 'text-right' : 'text-left'}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const sent = r.parent === sentParent;
            return (
              <tr key={`${r.voucher_id}-${i}`} className={rowCls(i === s.sel)} onMouseEnter={() => s.setSel(i)} onClick={() => open(i)}>
                <td className="px-2">{r.order_number}</td>
                <td className="px-2">{r.challan_no || r.number}</td>
                <td className="px-2">{fmtDate(r.date)}</td>
                <td className="px-2">{sent ? r.item : ''}</td>
                <td className={num}>{sent ? fmtQty(r.qty, 0, r.unit) : ''}</td>
                <td className="px-2">{r.party}</td>
                <td className="px-2">{r.nature}</td>
                <td className="px-2">{sent ? '' : r.item}</td>
                <td className={num}>{sent ? '' : fmtQty(r.qty, 0, r.unit)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && <div className="py-3 text-tb-muted">No material movements in this period.</div>}
    </Frame>
  );
}

export function ThirdPartyStockReport({ kind }: { kind: 1 | 2 }) {
  const { books, period } = useStore();
  const p = usePeriodKey();
  const data = useLoad(() => thirdPartyStock(books.db, kind, period.to), [kind, period]);
  const rows = data?.rows ?? [];
  const s = useSel(rows.length);
  const title = kind === 1 ? 'Stock with Job Worker' : 'Stock from Party';
  useScreen({ title, keys: { ...s.keys, ...p.key }, buttons: [p.button] });
  if (!data) return null;
  let last = -1;
  return (
    <Frame title={title} subtitle={`as at ${fmtDate(period.to)}`}>
      <table className="w-full">
        <thead>
          <tr>
            <th className={`${th} text-left`}>Particulars</th>
            <th className={`${th} text-right`}>Quantity</th>
            {kind === 1 && <th className={`${th} text-right italic`}>Rate</th>}
            {kind === 1 && <th className={`${th} text-right`}>Value</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const head = r.godown_id !== last;
            last = r.godown_id;
            return (
              <Fragment key={`${r.godown_id}-${r.item_id}`}>
                {head && (
                  <tr key={`g${r.godown_id}`} className="font-bold">
                    <td className="px-2" colSpan={4}>{r.godown}</td>
                  </tr>
                )}
                <tr key={`${r.godown_id}-${r.item_id}`} className={rowCls(i === s.sel)} onMouseEnter={() => s.setSel(i)}>
                  <td className="px-2 pl-6">{r.item}</td>
                  <td className={num}>{fmtQty(r.qty, 0, r.unit)}</td>
                  {kind === 1 && <td className={`${num} italic`}>{fmtAmount(r.rate)}</td>}
                  {kind === 1 && <td className={num}>{fmtAmount(r.value)}</td>}
                </tr>
              </Fragment>
            );
          })}
          {kind === 1 && (
            <tr className="font-bold">
              <td className={total}>Grand Total</td>
              <td className={total} colSpan={2} />
              <td className={`${total} text-right tabular-nums`}>{fmtAmount(data.total_value, false)}</td>
            </tr>
          )}
        </tbody>
      </table>
      {rows.length === 0 && <div className="py-3 text-tb-muted">{kind === 1 ? 'No stock lying with job workers. Mark the job worker godown as "Our Stock with Third Party".' : 'No party stock. Mark the godown as "Third Party Stock with Us".'}</div>}
    </Frame>
  );
}

export function VarianceAnalysisReport({ mode, kind: start = 'Out' }: { mode: 'issue' | 'receipt'; kind?: JobWorkKind }) {
  const { books, period } = useStore();
  const nav = useNav();
  const p = usePeriodKey();
  const k = useKindKey(start);
  const data = useLoad(() => varianceAnalysis(books.db, mode, k.kind, period.from, period.to), [mode, k.kind, period]);
  const rows = data ?? [];
  const s = useSel(rows.length);
  const open = (i: number) => rows[i] && nav.push(<VoucherScreen voucherId={rows[i].voucher_id} />);
  const title = mode === 'issue' ? 'Issue Variance Analysis' : 'Receipt Variance Analysis';
  useScreen({ title, keys: { ...s.keys, ...p.key, ...k.key, Enter: () => open(s.sel) }, buttons: [p.button, k.button] });
  if (!data) return null;
  let last = -1;
  return (
    <Frame title={title} subtitle={`Job Work ${k.kind}`}>
      <table className="w-full">
        <thead>
          <tr>
            <th className={`${th} text-left`}>Particulars</th>
            <th className={`${th} text-right`}>{mode === 'issue' ? 'Quantity to be Issued' : 'Quantity to be Received'}</th>
            <th className={`${th} text-right`}>{mode === 'issue' ? 'Actual Issued' : 'Actual Received'}</th>
            <th className={`${th} text-right`}>Variance Quantity</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const head = r.voucher_id !== last;
            last = r.voucher_id;
            return (
              <Fragment key={`${r.voucher_id}-${i}`}>
                {head && (
                  <tr key={`h${r.voucher_id}-${i}`} className="font-bold">
                    <td className="px-2" colSpan={4}>{`${r.number}  ·  ${fmtDate(r.date)}  ·  ${r.party}`}</td>
                  </tr>
                )}
                <tr key={`${r.voucher_id}-${i}`} className={rowCls(i === s.sel)} onMouseEnter={() => s.setSel(i)} onClick={() => open(i)}>
                  <td className="px-2 pl-6">{r.item}</td>
                  <td className={num}>{fmtQty(r.expected, 0, r.unit)}</td>
                  <td className={num}>{r.actual ? fmtQty(r.actual, 0, r.unit) : ''}</td>
                  <td className={num}>{r.variance ? `${r.variance < 0 ? '(-)' : ''}${fmtQty(Math.abs(r.variance), 0, r.unit)}` : '0'}</td>
                </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && <div className="py-3 text-tb-muted">No job work orders in this period.</div>}
    </Frame>
  );
}
