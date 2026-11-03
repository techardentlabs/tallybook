import { Fragment, useEffect, useMemo, useState } from 'react';
import { fmtAmount, fmtDate, fmtQty, hasPosTypes, posLastDate, posRegister, type PosRegisterRow } from '@tallybook/core';
import { useScreen } from '../registry.ts';
import { useStore } from '../store.tsx';
import { useNav } from '../nav.tsx';
import { useDialogs } from '../ui/Dialogs.tsx';
import { Frame, rowCls, th, useLoad, useSel } from './Reports.tsx';
import { VoucherScreen } from './Voucher.tsx';

const cell = 'px-2 text-right tabular-nums';
const grand = 'border-y-[3px] border-double border-tb-ink px-2';
const amt = (n: number) => (n ? fmtAmount(n, false) : '');

const COLS: { key: keyof PosRegisterRow; label: string }[] = [
  { key: 'gift', label: 'Gift Voucher' },
  { key: 'card', label: 'Credit / Debit Card' },
  { key: 'cheque', label: 'Cheque / DD' },
  { key: 'cash', label: 'Cash' },
  { key: 'on_account', label: 'On Account' },
  { key: 'amount', label: 'Total Amount' },
];

export function PosRegisterReport() {
  const { books, period, toast } = useStore();
  const nav = useNav();
  const dialogs = useDialogs();
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [detailed, setDetailed] = useState(false);

  useEffect(() => {
    void (async () => {
      if (!(await hasPosTypes(books.db))) {
        toast('POS Register is available when a Sales voucher type is set to Use for POS invoicing', 'err');
        return setRange({ from: period.from, to: period.to });
      }
      const last = await posLastDate(books.db);
      setRange(last ? { from: last, to: last } : { from: period.from, to: period.to });
    })();
  }, [books, period.from, period.to, toast]);

  const data = useLoad(() => (range ? posRegister(books.db, range.from, range.to) : Promise.resolve(null)), [range?.from, range?.to]);
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const { sel, setSel, keys } = useSel(rows.length);
  const open = (i: number) => {
    const r = rows[i];
    if (!r) return;
    if (r.cancelled) return toast('Cancelled vouchers cannot be altered', 'err');
    nav.push(<VoucherScreen voucherId={r.id} />);
  };
  const askPeriod = async () => {
    if (!range) return;
    const r = await dialogs.askPeriod(range.from, range.to);
    if (r) setRange({ from: r.from, to: r.to });
  };

  useScreen({
    title: 'POS Register',
    keys: {
      ...keys,
      Enter: () => open(sel),
      'Alt+F2': () => void askPeriod(),
      F2: () => void askPeriod(),
      'Alt+F1': () => setDetailed((d) => !d),
    },
    buttons: [
      { key: 'Alt+F2', label: 'Period', run: () => void askPeriod() },
      { key: 'Alt+F1', label: detailed ? 'Condensed' : 'Detailed', run: () => setDetailed((d) => !d) },
    ],
  });

  if (!range || !data) return null;
  const itemsOf = (id: number) => data.items.filter((x) => x.voucher_id === id);
  const subtitle = range.from === range.to ? `For ${fmtDate(range.from)}` : `${fmtDate(range.from)} to ${fmtDate(range.to)}`;

  return (
    <Frame title="POS Register" subtitle={subtitle}>
      <table className="w-full">
        <thead>
          <tr className="text-left">
            <th className={th}>Date</th>
            <th className={th}>Particulars</th>
            <th className={th}>Vch Type</th>
            <th className={`${th} text-right`}>Vch No.</th>
            {COLS.map((c) => (
              <th key={c.key} className={`${th} text-right`}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <Fragment key={r.id}>
              <tr className={rowCls(i === sel, r.cancelled ? 'text-tb-muted line-through' : '')} onMouseEnter={() => setSel(i)} onClick={() => open(i)}>
                <td className="px-2">{fmtDate(r.date)}</td>
                <td className="px-2 font-semibold">{r.cancelled ? `${r.party} (Cancelled)` : r.party}</td>
                <td className="px-2">{r.type}</td>
                <td className="px-2 text-right">{r.number}</td>
                {COLS.map((c) => (
                  <td key={c.key} className={cell}>{amt(Number(r[c.key]))}</td>
                ))}
              </tr>
              {detailed &&
                itemsOf(r.id).map((it, k) => (
                  <tr key={`${r.id}-${k}`} className="text-[13px] italic">
                    <td />
                    <td className="pl-8 pr-2">{it.item}</td>
                    <td className="px-2">{`${fmtQty(it.qty, 0)} ${it.unit}`.trim()}</td>
                    <td className="px-2 text-right">{fmtAmount(it.rate, false)}</td>
                    <td colSpan={COLS.length - 1} />
                    <td className={cell}>{fmtAmount(it.amount, false)}</td>
                  </tr>
                ))}
              {detailed && r.tendered > 0 && (
                <tr className="text-[13px] italic text-[#7a7a7a]">
                  <td />
                  <td className="pl-8 pr-2" colSpan={3}>Cash Tendered {fmtAmount(r.tendered, false)} · Balance {fmtAmount(r.balance, false)}</td>
                  <td colSpan={COLS.length} />
                </tr>
              )}
            </Fragment>
          ))}
          <tr className="font-bold">
            <td colSpan={4} className={grand}>Grand Total</td>
            {COLS.map((c) => (
              <td key={c.key} className={`${grand} text-right tabular-nums`}>{fmtAmount(Number(data.total[c.key as keyof typeof data.total] ?? 0), false)}</td>
            ))}
          </tr>
        </tbody>
      </table>
      {rows.length === 0 && <div className="py-3 text-tb-muted">No POS invoices for this period.</div>}
    </Frame>
  );
}
