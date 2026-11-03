import { useMemo, useRef, useState } from 'react';
import {
  EWB_CANCEL_REASONS,
  EWB_SUB_TYPES,
  IRN_CANCEL_REASONS,
  TRANSPORT_MODES,
  VEHICLE_TYPES,
  buildEInvoiceJson,
  buildEwayJson,
  buildEwbCancelJson,
  buildIrnCancelJson,
  cancelEwb,
  cancelIrn,
  eInvoiceSummary,
  eWayBillRows,
  fmtAmount,
  fmtDate,
  getEInvoice,
  getEway,
  gstr2bReconciliation,
  hsnSummary,
  importGstr2b,
  markExported,
  recordEwb,
  recordIrn,
  saveEInvoice,
  saveEway,
  taxAnalysis,
  type EInvRow,
  type GstSide,
  type Gstr2bRow,
} from '@tallybook/core';
import { Form, type FieldDef, type FormHandle } from '../ui/Form.tsx';
import type { Opt } from '../ui/PickerInput.tsx';
import { useScreen } from '../registry.ts';
import { useStore } from '../store.tsx';
import { useNav } from '../nav.tsx';
import { Frame, th, rowCls, useLoad, usePeriodKey, useSel } from './Reports.tsx';
import { useFilter, useReportOptions } from './reportConfig.tsx';
import { VoucherScreen } from './Voucher.tsx';
import { saveTextFile, pickJsonFile } from '../files.ts';
import { useStatutoryReady } from './Tds.tsx';

const num = 'px-2 text-right tabular-nums';
const tot = 'border-y-[3px] border-double border-tb-ink px-2 text-right tabular-nums';
const grand = 'border-y-[3px] border-double border-tb-ink px-2';
const opts = (o: object): Opt[] => Object.keys(o).map((k) => ({ id: k, label: k }));
const today = () => new Date().toISOString().slice(0, 10);

function FormScreen({ title, fields, onSave, labelWidth = 300 }: {
  title: string;
  fields: FieldDef[];
  onSave: (v: Record<string, any>) => Promise<string | void>;
  labelWidth?: number;
}) {
  const { bump, toast } = useStore();
  const nav = useNav();
  const form = useRef<FormHandle>(null);
  const save = async () => {
    const v = form.current?.submit();
    if (!v) return;
    try {
      const msg = await onSave(v);
      bump();
      toast(msg || 'Saved', 'ok');
      nav.pop();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  useScreen({ title, noPeriod: true, keys: { 'Ctrl+A': () => void save() }, buttons: [{ key: 'Ctrl+A', label: 'Accept', run: () => void save() }] });
  return (
    <div className="max-w-xl">
      <Form ref={form} fields={fields} labelWidth={labelWidth} onDone={() => void save()} />
    </div>
  );
}

export function EWayBillDetailsForm({ voucherId }: { voucherId: number }) {
  const { books } = useStore();
  const ready = useStatutoryReady();
  const cur = useLoad(async () => (ready ? getEway(books.db, voucherId) : null), [ready, voucherId]);
  if (!cur) return null;
  const pick = (o: object, v: string) => opts(o).find((x) => x.id === v);
  return (
    <FormScreen
      title="e-Way Bill Details"
      fields={[
        { key: 'sub', label: 'Supply sub type', kind: 'picker', title: 'Supply Sub Types', options: opts(EWB_SUB_TYPES), initial: pick(EWB_SUB_TYPES, cur.supply_sub_type), required: true },
        { key: 'tid', label: 'Transporter ID', kind: 'upper', initial: cur.transporter_id, maxLength: 15 },
        { key: 'tname', label: 'Transporter name', kind: 'text', initial: cur.transporter_name },
        { key: 'mode', label: 'Mode', kind: 'picker', title: 'Mode of Transport', options: opts(TRANSPORT_MODES), initial: pick(TRANSPORT_MODES, cur.mode), required: true },
        { key: 'docno', label: 'Doc/LR No.', kind: 'text', initial: cur.trans_doc_no, maxLength: 15 },
        { key: 'docdt', label: 'Doc/LR Date', kind: 'date', initial: cur.trans_doc_date || undefined },
        { key: 'veh', label: 'Vehicle number', kind: 'upper', initial: cur.vehicle_no },
        { key: 'vtype', label: 'Vehicle type', kind: 'picker', title: 'Vehicle Types', options: opts(VEHICLE_TYPES), initial: pick(VEHICLE_TYPES, cur.vehicle_type), required: true },
        { key: 'dist', label: 'Approximate distance (in km)', kind: 'text', initial: String(cur.distance_km || '') },
      ]}
      onSave={async (v) => {
        await saveEway(books.db, voucherId, {
          supply_sub_type: String(v.sub), transporter_id: String(v.tid), transporter_name: String(v.tname), mode: String(v.mode),
          trans_doc_no: String(v.docno), trans_doc_date: v.docdt || '', vehicle_no: String(v.veh), vehicle_type: String(v.vtype),
          distance_km: Number(v.dist) || 0,
        });
        return 'e-Way bill details saved';
      }}
    />
  );
}

export function IrnDetailsForm({ voucherId }: { voucherId: number }) {
  const { books } = useStore();
  const cur = useLoad(() => getEInvoice(books.db, voucherId), [voucherId]);
  if (!cur) return null;
  return (
    <FormScreen
      title="e-Invoice Details"
      fields={[
        { key: 'irn', label: 'IRN', kind: 'text', initial: cur.irn, maxLength: 64 },
        { key: 'ack', label: 'Acknowledgement number', kind: 'text', initial: cur.ack_no },
        { key: 'ackdt', label: 'Acknowledgement date', kind: 'text', initial: cur.ack_date, note: 'YYYY-MM-DD HH:MM:SS' },
        { key: 'qr', label: 'Signed QR code', kind: 'text', initial: cur.signed_qr },
      ]}
      onSave={async (v) => {
        await recordIrn(books.db, voucherId, { irn: String(v.irn), ack_no: String(v.ack), ack_date: String(v.ackdt), signed_qr: String(v.qr) });
        return 'IRN details saved';
      }}
    />
  );
}

export function CancelIrnForm({ voucherId }: { voucherId: number }) {
  const { books } = useStore();
  return (
    <FormScreen
      title="Cancel IRN"
      fields={[
        { key: 'reason', label: 'Reason', kind: 'picker', title: 'Cancellation Reasons', options: opts(IRN_CANCEL_REASONS), required: true },
        { key: 'remarks', label: 'Remarks', kind: 'text' },
        { key: 'date', label: 'Date of cancellation', kind: 'date', initial: today(), required: true },
      ]}
      onSave={async (v) => {
        await cancelIrn(books.db, voucherId, String(v.reason), String(v.remarks), String(v.date));
        return 'IRN marked as cancelled';
      }}
    />
  );
}

export function CancelEwbForm({ voucherId }: { voucherId: number }) {
  const { books } = useStore();
  return (
    <FormScreen
      title="Cancel e-Way Bill"
      fields={[
        { key: 'reason', label: 'Reason', kind: 'picker', title: 'Cancellation Reasons', options: opts(EWB_CANCEL_REASONS), required: true },
        { key: 'remarks', label: 'Remarks', kind: 'text' },
        { key: 'date', label: 'Date of cancellation', kind: 'date', initial: today(), required: true },
      ]}
      onSave={async (v) => {
        await cancelEwb(books.db, voucherId, String(v.reason), String(v.remarks), String(v.date));
        return 'e-Way bill marked as cancelled';
      }}
    />
  );
}

export function EInvoiceReport() {
  const { books, period, company } = useStore();
  const nav = useNav();
  const p = usePeriodKey();
  const ready = useStatutoryReady();
  const data = useLoad(async () => (ready ? eInvoiceSummary(books, period.from, period.to) : null), [period, ready]);
  const lines = data?.lines ?? [];
  const { sel, setSel, keys } = useSel(lines.length);
  const open = (i: number) => {
    const l = lines[i];
    if (!l || !data) return;
    const cat = l.key === 'Pending for Exchange' ? ['Pending for IRN generation'] : l.key === 'Exported' ? ['Exported for IRN generation'] : l.key === 'Uncertain' ? ['Information required for e-Invoice not provided', 'Rejected by e-Invoice System'] : l.key === 'Missing/Invalid Information' ? ['Information required for e-Invoice not provided'] : [l.key];
    nav.push(<EInvoiceVouchers title={l.label} categories={cat} />);
  };
  useScreen({ title: 'e-Invoice', keys: { ...keys, ...p.key, Enter: () => open(sel) }, buttons: [p.button] });
  return (
    <Frame title="e-Invoice" subtitle={`GST Registration : ${company?.gstin ?? ''}   ${fmtDate(period.from)} to ${fmtDate(period.to)}`}>
      <table className="w-full">
        <thead>
          <tr className="text-left">
            <th className={th}>Particulars</th>
            <th className={`${th} text-right`}>Voucher Count</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={`${l.key}-${i}`} className={rowCls(i === sel, l.level === 0 ? 'font-bold' : '')} onMouseEnter={() => setSel(i)} onClick={() => open(i)}>
              <td className="px-2" style={{ paddingLeft: 8 + l.level * 18 }}>{l.label}</td>
              <td className={num}>{l.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Frame>
  );
}

export function EInvoiceVouchers({ title, categories }: { title: string; categories: string[] }) {
  const { books, period, bump, toast } = useStore();
  const nav = useNav();
  const p = usePeriodKey();
  const flt = useFilter();
  const data = useLoad(async () => (await eInvoiceSummary(books, period.from, period.to)).rows.filter((r) => categories.includes(r.category)), [period, categories.join('|')]);
  const rows = useMemo(() => (data ?? []).filter((r) => flt.match(r.party, r.gstin, r.number)), [data, flt]);
  const { sel, setSel, keys } = useSel(rows.length);
  const open = (r?: EInvRow) => {
    if (!r) return;
    if (r.status === 'generated') nav.push(<IrnDetailsForm voucherId={r.voucher_id} />);
    else nav.push(<VoucherScreen voucherId={r.voucher_id} />);
  };
  const exportJson = async () => {
    const ids = rows.filter((r) => r.status === 'pending' || r.status === 'rejected').filter((r) => !r.missing.length).map((r) => r.voucher_id);
    if (!ids.length) return toast('No vouchers are ready for IRN generation', 'err');
    try {
      const json = await buildEInvoiceJson(books, ids);
      if (await saveTextFile(`e-Invoice_${period.from}_${period.to}.json`, JSON.stringify(json, null, 2), 'application/json')) {
        await markExported(books.db, 'einvoice', ids, today());
        bump();
        toast('e-Invoice JSON exported', 'ok');
      }
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  const importResponse = async () => {
    const f = await pickJsonFile();
    if (!f) return;
    try {
      const parsed = JSON.parse(f.text);
      const list: any[] = Array.isArray(parsed) ? parsed : [parsed];
      let done = 0;
      for (const item of list) {
        const no = String(item.DocNo ?? item.docNo ?? item.DocDtls?.No ?? '');
        const r = rows.find((x) => x.number === no);
        if (!r || !item.Irn) continue;
        await recordIrn(books.db, r.voucher_id, { irn: String(item.Irn), ack_no: String(item.AckNo ?? ''), ack_date: String(item.AckDt ?? ''), signed_qr: String(item.SignedQRCode ?? ''), signed_invoice: String(item.SignedInvoice ?? '') });
        done += 1;
      }
      bump();
      toast(`IRN updated for ${done} voucher${done === 1 ? '' : 's'}`, done ? 'ok' : 'err');
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  const cancel = () => {
    const r = rows[sel];
    if (r && r.status === 'generated') nav.push(<CancelIrnForm voucherId={r.voucher_id} />);
    else toast('Select a voucher with an IRN', 'err');
  };
  const record = () => rows[sel] && nav.push(<IrnDetailsForm voucherId={rows[sel].voucher_id} />);
  const exclude = async () => {
    const r = rows[sel];
    if (!r) return;
    try {
      await saveEInvoice(books.db, r.voucher_id, { status: r.status === 'excluded' ? 'pending' : 'excluded' });
      bump();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  const details = () => rows[sel] && nav.push(<EWayBillDetailsForm voucherId={rows[sel].voucher_id} />);
  useScreen({
    title: 'e-Invoice - Voucher Register',
    keys: { ...keys, ...p.key, ...flt.key, Enter: () => open(rows[sel]), 'Alt+X': () => void exportJson(), 'Alt+I': () => void importResponse(), 'Alt+R': record, 'Alt+N': cancel, 'Alt+O': () => void exclude(), 'Alt+T': details },
    buttons: [
      p.button,
      flt.button,
      { key: 'Alt+X', label: 'Offline Export', run: () => void exportJson() },
      { key: 'Alt+I', label: 'Import Response', run: () => void importResponse() },
      { key: 'Alt+R', label: 'Update IRN', run: record },
      { key: 'Alt+N', label: 'Cancel IRN', run: cancel },
      { key: 'Alt+O', label: 'Exclude', run: () => void exclude() },
      { key: 'Alt+T', label: 'Transport Details', run: details },
    ],
  });
  return (
    <Frame title={`Vouchers of : ${title}`}>
      {flt.bar}
      <table className="w-full">
        <thead>
          <tr className="text-left">
            <th className={th}>Date</th>
            <th className={th}>Particulars</th>
            <th className={th}>GSTIN/UIN</th>
            <th className={th}>Vch Type</th>
            <th className={th}>Vch No.</th>
            <th className={th}>IRN</th>
            <th className={`${th} text-right`}>Invoice Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.voucher_id} className={rowCls(i === sel)} onMouseEnter={() => setSel(i)} onClick={() => open(r)} title={r.missing.join(', ')}>
              <td className="px-2">{fmtDate(r.date)}</td>
              <td className="px-2">{r.party}</td>
              <td className="px-2">{r.gstin}</td>
              <td className="px-2">{r.vch_type}</td>
              <td className="px-2">{r.number}</td>
              <td className="px-2">{r.irn ? `${r.irn.slice(0, 12)}...` : r.missing.length ? `Missing: ${r.missing.join(', ')}` : ''}</td>
              <td className={num}>{fmtAmount(r.amount)}</td>
            </tr>
          ))}
          <tr className="font-bold">
            <td colSpan={6} className={grand}>Grand Total</td>
            <td className={tot}>{fmtAmount(rows.reduce((s, r) => s + r.amount, 0), false)}</td>
          </tr>
        </tbody>
      </table>
      {data && rows.length === 0 && <div className="py-3 text-tb-muted">No vouchers.</div>}
    </Frame>
  );
}

const EWB_DEFS = [{ key: 'all', label: 'Show invoices below the e-Way Bill limit', default: false }];

export function EWayBillReport() {
  const { books, period, bump, toast } = useStore();
  const nav = useNav();
  const p = usePeriodKey();
  const cfg = useReportOptions('eway-bill', 'e-Way Bill', EWB_DEFS);
  const flt = useFilter();
  const ready = useStatutoryReady();
  const data = useLoad(async () => (ready ? eWayBillRows(books, period.from, period.to, cfg.values.all) : null), [period, cfg.values.all, ready]);
  const rows = useMemo(() => (data ?? []).filter((r) => flt.match(r.party, r.gstin, r.number, r.ewb_no)), [data, flt]);
  const { sel, setSel, keys } = useSel(rows.length);
  const details = () => rows[sel] && nav.push(<EWayBillDetailsForm voucherId={rows[sel].voucher_id} />);
  const exportJson = async () => {
    const ids = rows.filter((r) => r.status === 'pending' || r.status === 'exported').map((r) => r.voucher_id);
    if (!ids.length) return toast('No pending e-way bills', 'err');
    try {
      const json = await buildEwayJson(books, ids);
      if (await saveTextFile(`e-Way Bill_${period.from}_${period.to}.json`, JSON.stringify(json, null, 2), 'application/json')) {
        await markExported(books.db, 'eway', ids, today());
        bump();
        toast('e-Way bill JSON exported', 'ok');
      }
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  const exportCancel = async () => {
    const r = rows[sel];
    if (!r) return;
    const doc = await getEway(books.db, r.voucher_id);
    try {
      await saveTextFile(`e-Way Bill Cancel_${doc.ewb_no}.json`, JSON.stringify(buildEwbCancelJson(doc), null, 2), 'application/json');
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  const exportIrnCancel = async () => {
    const r = rows[sel];
    if (!r) return;
    try {
      await saveTextFile(`IRN Cancel_${r.number}.json`, JSON.stringify(buildIrnCancelJson(await getEInvoice(books.db, r.voucher_id)), null, 2), 'application/json');
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  const cancel = () => (rows[sel]?.status === 'generated' ? nav.push(<CancelEwbForm voucherId={rows[sel].voucher_id} />) : toast('Select a voucher with an e-way bill', 'err'));
  const record = async () => {
    const f = await pickJsonFile();
    if (!f) return;
    try {
      const parsed = JSON.parse(f.text);
      const list: any[] = Array.isArray(parsed) ? parsed : parsed.billLists ?? [parsed];
      let done = 0;
      for (const item of list) {
        const r = rows.find((x) => x.number === String(item.docNo ?? item.DocNo ?? ''));
        const no = String(item.ewayBillNo ?? item.ewbNo ?? item.EwbNo ?? '');
        if (!r || !no) continue;
        await recordEwb(books.db, r.voucher_id, { ewb_no: no, ewb_date: String(item.ewayBillDate ?? item.EwbDt ?? ''), valid_upto: String(item.validUpto ?? item.EwbValidTill ?? '') });
        done += 1;
      }
      bump();
      toast(`e-Way bill updated for ${done} voucher${done === 1 ? '' : 's'}`, done ? 'ok' : 'err');
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  useScreen({
    title: 'e-Way Bill',
    keys: { ...keys, ...p.key, ...cfg.key, ...flt.key, Enter: details, 'Alt+X': () => void exportJson(), 'Alt+I': () => void record(), 'Alt+N': cancel, 'Alt+J': () => void exportCancel(), 'Alt+K': () => void exportIrnCancel() },
    buttons: [
      p.button,
      cfg.button,
      flt.button,
      { key: 'Alt+X', label: 'Offline Export', run: () => void exportJson() },
      { key: 'Alt+I', label: 'Import Response', run: () => void record() },
      { key: 'Alt+N', label: 'Cancel e-Way Bill', run: cancel },
      { key: 'Alt+J', label: 'Export Cancellation', run: () => void exportCancel() },
    ],
  });
  const pending = rows.filter((r) => r.status === 'pending').length;
  return (
    <Frame title="e-Way Bill" subtitle={`Pending (For e-Way Bill Generation - ${pending})   ${fmtDate(period.from)} to ${fmtDate(period.to)}`}>
      {flt.bar}
      <table className="w-full">
        <thead>
          <tr className="text-left">
            <th className={th}>Date</th>
            <th className={th}>Particulars</th>
            <th className={th}>GSTIN/UIN</th>
            <th className={th}>Vch Type</th>
            <th className={th}>Vch No.</th>
            <th className={th}>Status</th>
            <th className={th}>e-Way Bill No.</th>
            <th className={`${th} text-right`}>Invoice Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.voucher_id} className={rowCls(i === sel)} onMouseEnter={() => setSel(i)} onClick={details}>
              <td className="px-2">{fmtDate(r.date)}</td>
              <td className="px-2">{r.party}</td>
              <td className="px-2">{r.gstin}</td>
              <td className="px-2">{r.vch_type}</td>
              <td className="px-2">{r.number}</td>
              <td className="px-2">{r.status === 'pending' ? 'Pending' : r.status === 'exported' ? 'Exported' : r.status === 'generated' ? 'Generated' : 'Cancelled'}</td>
              <td className="px-2">{r.ewb_no}</td>
              <td className={num}>{fmtAmount(r.amount)}</td>
            </tr>
          ))}
          <tr className="font-bold">
            <td colSpan={7} className={grand}>Grand Total</td>
            <td className={tot}>{fmtAmount(rows.reduce((s, r) => s + r.amount, 0), false)}</td>
          </tr>
        </tbody>
      </table>
      {data && rows.length === 0 && <div className="py-3 text-tb-muted">No vouchers.</div>}
    </Frame>
  );
}

const statusKey: Record<string, string> = {
  Reconciled: 'Reconciled',
  Mismatched: 'Mismatched',
  'Potential Match': 'Potential Matches',
  'Available Only in Books': 'Available Only in Books',
  'Available Only in Portal': 'Available Only in Portal',
};

export function Gstr2bReconciliationReport() {
  const { books, period, bump, toast } = useStore();
  const nav = useNav();
  const p = usePeriodKey();
  const flt = useFilter();
  const ready = useStatutoryReady();
  const [status, setStatus] = useState<string>('');
  const data = useLoad(async () => (ready ? gstr2bReconciliation(books, period.from, period.to) : null), [period, ready]);
  const rows = useMemo(() => (data?.rows ?? []).filter((r) => (!status || r.status === status) && flt.match(r.party, r.ctin, r.books?.number, r.portal?.number)), [data, flt, status]);
  const { sel, setSel, keys } = useSel(rows.length);
  const open = (r?: Gstr2bRow) => r?.voucher_id && nav.push(<VoucherScreen voucherId={r.voucher_id} />);
  const importFile = async () => {
    const f = await pickJsonFile();
    if (!f) return;
    try {
      const res = await importGstr2b(books.db, JSON.parse(f.text), period.to.slice(0, 7));
      bump();
      toast(`${res.imported} documents imported for ${res.period}`, 'ok');
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  const cycle = () => {
    const order = ['', 'Reconciled', 'Mismatched', 'Potential Match', 'Available Only in Books', 'Available Only in Portal'];
    setStatus((s) => order[(order.indexOf(s) + 1) % order.length]);
  };
  useScreen({
    title: 'GSTR-2B Reconciliation',
    keys: { ...keys, ...p.key, ...flt.key, Enter: () => void open(rows[sel]), 'Alt+I': () => void importFile(), 'Ctrl+B': cycle },
    buttons: [p.button, { key: 'Ctrl+B', label: 'Basis of Values', run: cycle }, flt.button, { key: 'Alt+I', label: 'Import GSTR-2B', run: () => void importFile() }],
  });
  const t = data?.totals;
  return (
    <Frame title="GSTR-2B Reconciliation" subtitle={`Status : ${status ? statusKey[status] : 'All'}   ${fmtDate(period.from)} to ${fmtDate(period.to)}`}>
      {data && (
        <table className="mb-3 w-full">
          <tbody>
            {(Object.keys(data.counts) as (keyof typeof data.counts)[]).map((k) => (
              <tr key={k} className={k === 'Reconciled' ? 'font-bold' : ''}>
                <td className="px-2">{statusKey[k]}</td>
                <td className={num}>{data.counts[k]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {flt.bar}
      <table className="w-full">
        <thead>
          <tr className="text-left">
            <th className={th} rowSpan={2}>Particulars</th>
            <th className={th} rowSpan={2}>GSTIN/UIN</th>
            <th className={th} colSpan={2}>Books</th>
            <th className={`${th} text-right`} colSpan={2}>Portal</th>
            <th className={th} rowSpan={2}>Status</th>
          </tr>
          <tr className="text-left">
            <th className={th}>Doc No.</th>
            <th className={`${th} text-right`}>Tax Amount</th>
            <th className={th}>Doc No.</th>
            <th className={`${th} text-right`}>Tax Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={rowCls(i === sel)} onMouseEnter={() => setSel(i)} onClick={() => open(r)}>
              <td className="px-2">{r.party}</td>
              <td className="px-2">{r.ctin}</td>
              <td className="px-2">{r.books?.number ?? ''}</td>
              <td className={num}>{r.books ? fmtAmount(r.books.tax) : ''}</td>
              <td className="px-2">{r.portal?.number ?? ''}</td>
              <td className={num}>{r.portal ? fmtAmount(r.portal.tax) : ''}</td>
              <td className="px-2">{r.status}</td>
            </tr>
          ))}
          <tr className="font-bold">
            <td colSpan={3} className={grand}>Total</td>
            <td className={tot}>{fmtAmount(t?.books.tax ?? 0, false)}</td>
            <td className={grand} />
            <td className={tot}>{fmtAmount(t?.portal.tax ?? 0, false)}</td>
            <td className={grand} />
          </tr>
        </tbody>
      </table>
      {data && rows.length === 0 && <div className="py-3 text-tb-muted">{data.rows.length === 0 ? 'No purchase vouchers or imported GSTR-2B data in this period. Press Alt+I to import a GSTR-2B JSON file.' : 'No rows match.'}</div>}
    </Frame>
  );
}

const HSN_DEFS = [{ key: 'inward', label: 'Show inward supplies', default: false }];

export function HsnSummaryReport() {
  const { books, period } = useStore();
  const p = usePeriodKey();
  const cfg = useReportOptions('hsn-summary', 'HSN/SAC Summary', HSN_DEFS);
  const flt = useFilter();
  const side: GstSide = cfg.values.inward ? 'inward' : 'outward';
  const data = useLoad(() => hsnSummary(books, period.from, period.to, side), [period, side]);
  const rows = useMemo(() => (data ?? []).filter((r) => flt.match(r.hsn)), [data, flt]);
  const { sel, setSel, keys } = useSel(rows.length);
  useScreen({ title: 'HSN/SAC Summary', keys: { ...keys, ...p.key, ...cfg.key, ...flt.key }, buttons: [p.button, cfg.button, flt.button] });
  const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((s, r) => s + f(r), 0);
  return (
    <Frame title={`HSN/SAC Summary - ${side === 'outward' ? 'Outward' : 'Inward'} Supplies`}>
      {flt.bar}
      <table className="w-full">
        <thead>
          <tr className="text-left">
            <th className={th}>HSN/SAC</th>
            <th className={th}>UQC</th>
            <th className={`${th} text-right`}>Rate</th>
            <th className={`${th} text-right`}>Total Quantity</th>
            <th className={`${th} text-right`}>Total Value</th>
            <th className={`${th} text-right`}>Taxable Value</th>
            <th className={`${th} text-right`}>Integrated Tax</th>
            <th className={`${th} text-right`}>Central Tax</th>
            <th className={`${th} text-right`}>State Tax</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.hsn}-${r.rate_bp}`} className={rowCls(i === sel)} onMouseEnter={() => setSel(i)}>
              <td className="px-2">{r.hsn || '(not set)'}</td>
              <td className="px-2">{r.uqc}</td>
              <td className={num}>{r.rate_bp / 100} %</td>
              <td className={num}>{r.qty ? r.qty / 1000 : ''}</td>
              <td className={num}>{fmtAmount(r.value)}</td>
              <td className={num}>{fmtAmount(r.taxable)}</td>
              <td className={num}>{fmtAmount(r.igst)}</td>
              <td className={num}>{fmtAmount(r.cgst)}</td>
              <td className={num}>{fmtAmount(r.sgst)}</td>
            </tr>
          ))}
          <tr className="font-bold">
            <td colSpan={4} className={grand}>Grand Total</td>
            <td className={tot}>{fmtAmount(sum((r) => r.value), false)}</td>
            <td className={tot}>{fmtAmount(sum((r) => r.taxable), false)}</td>
            <td className={tot}>{fmtAmount(sum((r) => r.igst), false)}</td>
            <td className={tot}>{fmtAmount(sum((r) => r.cgst), false)}</td>
            <td className={tot}>{fmtAmount(sum((r) => r.sgst), false)}</td>
          </tr>
        </tbody>
      </table>
      {data && rows.length === 0 && <div className="py-3 text-tb-muted">No supplies in this period.</div>}
    </Frame>
  );
}

const TA_DEFS = [{ key: 'inward', label: 'Show inward supplies', default: false }];

export function TaxAnalysisReport() {
  const { books, period } = useStore();
  const p = usePeriodKey();
  const cfg = useReportOptions('tax-analysis', 'Tax Analysis', TA_DEFS);
  const side: GstSide = cfg.values.inward ? 'inward' : 'outward';
  const data = useLoad(() => taxAnalysis(books, period.from, period.to, side), [period, side]);
  const rows = data ?? [];
  const { sel, setSel, keys } = useSel(rows.length);
  useScreen({ title: 'Tax Analysis', keys: { ...keys, ...p.key, ...cfg.key }, buttons: [p.button, cfg.button] });
  const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((s, r) => s + f(r), 0);
  return (
    <Frame title={`Tax Analysis - ${side === 'outward' ? 'Outward' : 'Inward'} Supplies`}>
      <table className="w-full">
        <thead>
          <tr className="text-left">
            <th className={th}>Tax Rate</th>
            <th className={`${th} text-right`}>Voucher Count</th>
            <th className={`${th} text-right`}>Taxable Value</th>
            <th className={`${th} text-right`}>Integrated Tax</th>
            <th className={`${th} text-right`}>Central Tax</th>
            <th className={`${th} text-right`}>State Tax</th>
            <th className={`${th} text-right`}>Cess</th>
            <th className={`${th} text-right`}>Tax Amount</th>
            <th className={`${th} text-right`}>Invoice Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.rate_bp} className={rowCls(i === sel)} onMouseEnter={() => setSel(i)}>
              <td className="px-2">{r.rate_bp / 100} %</td>
              <td className={num}>{r.count}</td>
              <td className={num}>{fmtAmount(r.taxable)}</td>
              <td className={num}>{fmtAmount(r.igst)}</td>
              <td className={num}>{fmtAmount(r.cgst)}</td>
              <td className={num}>{fmtAmount(r.sgst)}</td>
              <td className={num}>{fmtAmount(r.cess)}</td>
              <td className={num}>{fmtAmount(r.tax)}</td>
              <td className={num}>{fmtAmount(r.total)}</td>
            </tr>
          ))}
          <tr className="font-bold">
            <td className={grand}>Grand Total</td>
            <td className={tot}>{sum((r) => r.count)}</td>
            <td className={tot}>{fmtAmount(sum((r) => r.taxable), false)}</td>
            <td className={tot}>{fmtAmount(sum((r) => r.igst), false)}</td>
            <td className={tot}>{fmtAmount(sum((r) => r.cgst), false)}</td>
            <td className={tot}>{fmtAmount(sum((r) => r.sgst), false)}</td>
            <td className={tot}>{fmtAmount(sum((r) => r.cess), false)}</td>
            <td className={tot}>{fmtAmount(sum((r) => r.tax), false)}</td>
            <td className={tot}>{fmtAmount(sum((r) => r.total), false)}</td>
          </tr>
        </tbody>
      </table>
      {data && rows.length === 0 && <div className="py-3 text-tb-muted">No supplies in this period.</div>}
    </Frame>
  );
}
