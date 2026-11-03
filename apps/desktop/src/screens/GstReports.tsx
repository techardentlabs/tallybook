import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { fmtAmount, fmtDate, gstr1, gstr1Json, gstr3b, type Gstr1, type Gstr3b } from '@tallybook/core';
import { useScreen } from '../registry.ts';
import { useStore } from '../store.tsx';
import { useDialogs } from '../ui/Dialogs.tsx';
import { saveTextFile } from '../files.ts';

function useGst<T>(fn: (books: ReturnType<typeof useStore>['books'], from: string, to: string) => Promise<T>) {
  const { books, period, version, toast } = useStore();
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    let live = true;
    fn(books, period.from, period.to).then((d) => live && setData(d)).catch((e) => toast((e as Error).message, 'err'));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [books, period, version]);
  return data;
}

function usePeriod() {
  const { period, setPeriod } = useStore();
  const dialogs = useDialogs();
  return useCallback(async () => {
    const r = await dialogs.askPeriod(period.from, period.to);
    if (r) setPeriod(r.from, r.to);
  }, [dialogs, period, setPeriod]);
}

function Frame({ title, children }: { title: string; children: ReactNode }) {
  const { company, period } = useStore();
  return (
    <div className="border border-tb-line bg-tb-paper px-4 py-3">
      <div className="mb-3 text-center">
        <div className="text-[15px] font-bold">{company?.name}</div>
        <div className="font-semibold">{title}</div>
        <div className="text-xs text-tb-muted">
          {company?.gstin ? `GSTIN/UIN: ${company.gstin}   ` : ''}
          {fmtDate(period.from)} to {fmtDate(period.to)}
        </div>
      </div>
      {children}
    </div>
  );
}

const thBase = 'border-y border-tb-ink px-2 py-1 font-semibold';
const th = `${thBase} text-right`;
const thl = `${thBase} text-left`;
const td = 'px-2 text-right tabular-nums';
const m = (n: number) => fmtAmount(n);

export function Gstr1Report() {
  const { toast } = useStore();
  const askPeriod = usePeriod();
  const data = useGst<Gstr1>((b, f, t) => gstr1(b, f, t));
  const exportJson = async () => {
    if (!data) return;
    const ok = await saveTextFile(`GSTR1_${data.period.to.slice(0, 7)}.json`, JSON.stringify(gstr1Json(data), null, 2), 'application/json');
    if (ok) toast('GSTR-1 JSON exported', 'ok');
  };
  useScreen({
    title: 'GSTR-1',
    keys: { 'Alt+F2': () => void askPeriod(), F2: () => void askPeriod(), 'Alt+E': () => void exportJson() },
    buttons: [
      { key: 'Alt+F2', label: 'Period', run: () => void askPeriod() },
      { key: 'Alt+E', label: 'Export (JSON)', run: () => void exportJson() },
    ],
  });
  if (!data) return null;
  const sum = (rows: { taxable: number; igst: number; cgst: number; sgst: number; cess: number }[]) => rows.reduce((a, r) => ({ taxable: a.taxable + r.taxable, igst: a.igst + r.igst, cgst: a.cgst + r.cgst, sgst: a.sgst + r.sgst, cess: a.cess + r.cess }), { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 });
  const sections: { name: string; count: number; s: ReturnType<typeof sum> }[] = [
    { name: '4A, 4B, 4C, 6B, 6C - B2B Invoices', count: data.b2b.length, s: sum(data.b2b) },
    { name: '5 - B2C (Large) Invoices', count: data.b2cl.length, s: sum(data.b2cl) },
    { name: '7 - B2C (Small) Supplies', count: data.b2cs.length, s: sum(data.b2cs) },
    { name: '9B - Credit/Debit Notes (Registered)', count: data.cdnr.length, s: sum(data.cdnr) },
    { name: '9B - Credit/Debit Notes (Unregistered)', count: data.cdnur.length, s: sum(data.cdnur) },
  ];
  return (
    <Frame title="GSTR-1 Summary">
      <table className="w-full">
        <thead>
          <tr>
            <th className={thl}>Particulars</th>
            <th className={th}>Vouchers</th>
            <th className={th}>Taxable value</th>
            <th className={th}>Integrated tax</th>
            <th className={th}>Central tax</th>
            <th className={th}>State tax</th>
          </tr>
        </thead>
        <tbody>
          {sections.map((r) => (
            <tr key={r.name}>
              <td className="px-2">{r.name}</td>
              <td className={td}>{r.count}</td>
              <td className={td}>{m(r.s.taxable)}</td>
              <td className={td}>{m(r.s.igst)}</td>
              <td className={td}>{m(r.s.cgst)}</td>
              <td className={td}>{m(r.s.sgst)}</td>
            </tr>
          ))}
          <tr>
            <td className="px-2">8 - Nil rated / Exempted supplies</td>
            <td className={td} />
            <td className={td}>{m(data.nil_exempt.registered + data.nil_exempt.unregistered)}</td>
            <td className={td} colSpan={3} />
          </tr>
          <tr className="font-bold">
            <td className="border-y-[3px] border-double border-tb-ink px-2">Net outward supplies</td>
            <td className="border-y-[3px] border-double border-tb-ink px-2 text-right">{data.totals.invoices}</td>
            <td className="border-y-[3px] border-double border-tb-ink px-2 text-right tabular-nums">{m(data.totals.taxable)}</td>
            <td className="border-y-[3px] border-double border-tb-ink px-2 text-right tabular-nums">{m(data.totals.igst)}</td>
            <td className="border-y-[3px] border-double border-tb-ink px-2 text-right tabular-nums">{m(data.totals.cgst)}</td>
            <td className="border-y-[3px] border-double border-tb-ink px-2 text-right tabular-nums">{m(data.totals.sgst)}</td>
          </tr>
        </tbody>
      </table>

      <div className="mb-1 mt-5 font-semibold">12 - HSN/SAC Summary</div>
      <table className="w-full">
        <thead>
          <tr>
            <th className={thl}>HSN/SAC</th>
            <th className={th}>Rate</th>
            <th className={th}>Taxable value</th>
            <th className={th}>Integrated tax</th>
            <th className={th}>Central tax</th>
            <th className={th}>State tax</th>
          </tr>
        </thead>
        <tbody>
          {data.hsn.map((h) => (
            <tr key={`${h.hsn}-${h.rate_bp}`}>
              <td className="px-2">{h.hsn || '(not set)'}</td>
              <td className={td}>{h.rate_bp / 100}%</td>
              <td className={td}>{m(h.taxable)}</td>
              <td className={td}>{m(h.igst)}</td>
              <td className={td}>{m(h.cgst)}</td>
              <td className={td}>{m(h.sgst)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.hsn.some((h) => !h.hsn) && <p className="mt-1 text-xs text-tb-danger">Some supplies have no HSN/SAC. Set it on the sales ledger (Alter ledger).</p>}

      <div className="mb-1 mt-5 font-semibold">13 - Documents issued</div>
      <table className="w-full">
        <thead>
          <tr>
            <th className={thl}>Nature of document</th>
            <th className={th}>From</th>
            <th className={th}>To</th>
            <th className={th}>Total</th>
            <th className={th}>Cancelled</th>
          </tr>
        </thead>
        <tbody>
          {data.documents.map((d) => (
            <tr key={d.type}>
              <td className="px-2">{d.type}</td>
              <td className={td}>{d.from}</td>
              <td className={td}>{d.to}</td>
              <td className={td}>{d.total}</td>
              <td className={td}>{d.cancelled}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Frame>
  );
}

export function Gstr3bReport() {
  const askPeriod = usePeriod();
  const data = useGst<Gstr3b>((b, f, t) => gstr3b(b, f, t));
  useScreen({
    title: 'GSTR-3B',
    keys: { 'Alt+F2': () => void askPeriod(), F2: () => void askPeriod() },
    buttons: [{ key: 'Alt+F2', label: 'Period', run: () => void askPeriod() }],
  });
  if (!data) return null;
  const row = (label: string, v: { igst: number; cgst: number; sgst: number; cess: number }, taxable?: number, bold = false) => (
    <tr className={bold ? 'font-bold' : ''}>
      <td className="px-2">{label}</td>
      <td className={td}>{taxable === undefined ? '' : m(taxable)}</td>
      <td className={td}>{m(v.igst)}</td>
      <td className={td}>{m(v.cgst)}</td>
      <td className={td}>{m(v.sgst)}</td>
      <td className={td}>{m(v.cess)}</td>
    </tr>
  );
  const head = (
    <thead>
      <tr>
        <th className={thl}>Nature</th>
        <th className={th}>Taxable value</th>
        <th className={th}>Integrated</th>
        <th className={th}>Central</th>
        <th className={th}>State/UT</th>
        <th className={th}>Cess</th>
      </tr>
    </thead>
  );
  const z = { igst: 0, cgst: 0, sgst: 0, cess: 0 };
  return (
    <Frame title="GSTR-3B">
      <div className="mb-1 font-semibold">3.1 - Outward supplies and inward supplies liable to reverse charge</div>
      <table className="w-full">
        {head}
        <tbody>
          {row('(a) Outward taxable supplies (other than zero rated, nil rated and exempted)', data.outward_taxable, data.outward_taxable.taxable)}
          {row('(c) Other outward supplies (nil rated, exempted)', z, data.outward_nil_exempt)}
          {row('(d) Inward supplies (liable to reverse charge)', data.inward_reverse_charge, data.inward_reverse_charge.taxable)}
        </tbody>
      </table>
      <div className="mb-1 mt-5 font-semibold">4 - Eligible ITC (all other ITC)</div>
      <table className="w-full">
        {head}
        <tbody>{row('Input tax credit available', data.itc)}</tbody>
      </table>
      <div className="mb-1 mt-5 font-semibold">6.1 - Payment of tax</div>
      <table className="w-full">
        {head}
        <tbody>
          {row('Tax payable', data.liability)}
          {row('Paid through ITC: Integrated tax', data.set_off.igst_used)}
          {row('Paid through ITC: Central tax', data.set_off.cgst_used)}
          {row('Paid through ITC: State/UT tax', data.set_off.sgst_used)}
          {row('Tax paid in cash', data.cash_payable, undefined, true)}
          {row('ITC carried forward', data.carry_forward_itc)}
        </tbody>
      </table>
      <p className="mt-3 text-xs text-tb-muted">ITC is set off in the order prescribed: Integrated tax credit first against Integrated, then Central, then State; Central and State credit against their own head, then Integrated.</p>
    </Frame>
  );
}
