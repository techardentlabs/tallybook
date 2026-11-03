import { KeyButton } from '../ui/KeyButton.tsx';
import { useRef, useState } from 'react';
import {
  EXPORT_FILE_FORMATS, MASTER_EXPORT_TYPES, VOUCHER_EXPORT_TYPES, exportMastersJson, exportMastersXmlFor, exportVouchersJson, exportVouchersXmlFor, fmtAmount, fmtDate, groupSummary, importTallyXml,
  type ImportReport, type MasterExportType, type VoucherExportType,
} from '@tallybook/core';
import { useNav } from '../nav.tsx';
import { Form, type FieldDef, type FormHandle } from '../ui/Form.tsx';
import { useScreen } from '../registry.ts';
import { useStore } from '../store.tsx';
import { MenuCard, useMenu } from '../ui/Menu.tsx';
import { pickXmlFile, saveTextFile } from '../files.ts';

type Phase =
  | { name: 'idle' }
  | { name: 'working'; label: string }
  | { name: 'preview'; file: string; text: string; report: ImportReport }
  | { name: 'done'; file: string; report: ImportReport; tbDiff: number; vouchers: number; ledgers: number };

function Row({ label, value, warn }: { label: string; value: string | number; warn?: boolean }) {
  return (
    <div className="flex justify-between gap-8">
      <span className="text-tb-muted">{label}</span>
      <span className={warn ? 'font-bold text-tb-danger' : ''}>{value}</span>
    </div>
  );
}

function ReportView({ r, title }: { r: ImportReport; title: string }) {
  return (
    <div className="max-w-3xl border border-tb-line bg-tb-paper p-4">
      <h3 className="mb-3 text-[15px] font-semibold">{title}</h3>
      <div className="grid grid-cols-2 gap-x-10 gap-y-0.5">
        <Row label="Groups to create" value={r.created.groups} />
        <Row label="Ledgers to create" value={r.created.ledgers} />
        <Row label="Ledgers to update" value={r.updated.ledgers} />
        <Row label="Voucher types to create" value={r.created.voucher_types} />
        <Row label="Vouchers to create" value={r.created.vouchers} />
        <Row label="Vouchers to update" value={r.updated.vouchers} />
        <Row label="Vouchers already present (skipped)" value={r.skipped.vouchers} />
        <Row label="Vouchers deleted" value={r.deleted.vouchers} />
        <Row label="Total voucher amount" value={fmtAmount(r.totals.voucher_amount, false)} />
        <Row label="Errors" value={r.errors.length} warn={r.errors.length > 0} />
      </div>
      {r.warnings.length > 0 && (
        <div className="mt-3">
          <div className="text-xs font-bold uppercase tracking-wider text-tb-muted">Warnings</div>
          <ul className="mt-1 max-h-32 overflow-auto text-xs">
            {r.warnings.slice(0, 50).map((w, i) => <li key={i}>• {w}</li>)}
          </ul>
        </div>
      )}
      {r.errors.length > 0 && (
        <div className="mt-3">
          <div className="text-xs font-bold uppercase tracking-wider text-tb-danger">Errors (these items will not be imported)</div>
          <ul className="mt-1 max-h-40 overflow-auto text-xs">
            {r.errors.slice(0, 100).map((e, i) => (
              <li key={i}>• {e.kind} “{e.name}”: {e.message}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function ImportScreen() {
  const { books, bump, toast } = useStore();
  const [phase, setPhase] = useState<Phase>({ name: 'idle' });
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const choose = async () => {
    try {
      const f = await pickXmlFile();
      if (!f) return;
      setPhase({ name: 'working', label: `Checking ${f.name}…` });
      const report = await importTallyXml(books, f.text, { dryRun: true });
      setPhase({ name: 'preview', file: f.name, text: f.text, report });
    } catch (e) {
      setPhase({ name: 'idle' });
      toast((e as Error).message, 'err');
    }
  };

  const apply = async () => {
    const p = phaseRef.current;
    if (p.name !== 'preview') return;
    setPhase({ name: 'working', label: 'Importing…' });
    try {
      const report = await importTallyXml(books, p.text);
      const tb = await groupSummary(books.db, '0000-01-01', '9999-12-31', null);
      bump();
      setPhase({ name: 'done', file: p.file, report, tbDiff: tb.total.closing, vouchers: await books.count('vouchers'), ledgers: await books.count('ledgers') });
      toast('Import complete', 'ok');
    } catch (e) {
      setPhase({ name: 'idle' });
      toast((e as Error).message, 'err');
    }
  };

  useScreen({
    title: 'Import Data',
    noPeriod: true,
    keys: {
      Enter: () => (phaseRef.current.name === 'idle' ? void choose() : phaseRef.current.name === 'preview' ? void apply() : false),
      Y: () => (phaseRef.current.name === 'preview' ? void apply() : false),
    },
    buttons: [{ key: 'Enter', label: phase.name === 'preview' ? 'Import now' : 'Select file', run: () => (phase.name === 'preview' ? void apply() : void choose()) }],
  });

  if (phase.name === 'idle') {
    return (
      <div className="max-w-2xl border border-tb-line bg-tb-paper p-4">
        <h3 className="mb-2 text-[15px] font-semibold">Import from Tally</h3>
        <p className="mb-3 text-sm">Export your company from Tally as XML (masters and vouchers), then press Enter to choose the file. You will see exactly what will be imported before anything is written.</p>
        <ul className="mb-3 list-disc pl-5 text-xs text-tb-muted">
          <li>Groups, ledgers (with opening balances and bill-wise details), voucher types and accounting vouchers are imported.</li>
          <li>Importing the same file twice never creates duplicates.</li>
          <li>Item (inventory) lines are not imported yet; their accounting amounts are.</li>
        </ul>
        <KeyButton k="Enter" label="Select XML file" run={() => void choose()} primary />
      </div>
    );
  }
  if (phase.name === 'working') return <div className="p-6">{phase.label}</div>;
  if (phase.name === 'preview') {
    return (
      <div>
        <ReportView r={phase.report} title={`Preview: ${phase.file} (nothing has been changed yet)`} />
        <p className="mt-3 text-sm">Press <b>Enter</b> or <b>Y</b> to import, <b>Esc</b> to cancel.</p>
      </div>
    );
  }
  return (
    <div>
      <ReportView r={phase.report} title={`Imported: ${phase.file}`} />
      <div className="mt-3 max-w-3xl border border-tb-line bg-tb-paper p-4">
        <h3 className="mb-2 font-semibold">Reconciliation</h3>
        <Row label="Ledgers now in company" value={phase.ledgers} />
        <Row label="Vouchers now in company" value={phase.vouchers} />
        <Row label="Trial balance difference" value={phase.tbDiff === 0 ? 'Nil (books balance)' : fmtAmount(phase.tbDiff, false)} warn={phase.tbDiff !== 0} />
        {phase.tbDiff !== 0 && <p className="mt-2 text-xs text-tb-danger">The opening balances in the source do not balance. Compare with the source company's Trial Balance.</p>}
      </div>
    </div>
  );
}

export function ExportScreen() {
  const nav = useNav();
  const items = [
    { label: 'Masters', hotkey: 'M', run: () => nav.push(<ExportDataScreen target="masters" />) },
    { label: 'Transactions', hotkey: 'T', run: () => nav.push(<ExportDataScreen target="transactions" />) },
  ];
  const { sel, setSel, keys } = useMenu(items);
  useScreen({ title: 'Export', noPeriod: true, keys, buttons: [] });
  return <MenuCard title="Export" items={items} sel={sel} setSel={setSel} width={332} />;
}

export function ExportDataScreen({ target }: { target: 'masters' | 'transactions' }) {
  const { books, company, period, toast } = useStore();
  const form = useRef<FormHandle>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const masters = target === 'masters';
  const title = masters ? 'Export Masters' : 'Export Transactions';
  const fields: FieldDef[] = masters
    ? [
        { key: 'type', label: 'Type of Master', kind: 'picker', title: 'Type of Master', options: MASTER_EXPORT_TYPES.map((t) => ({ id: t, label: t })), initial: { id: MASTER_EXPORT_TYPES[0], label: MASTER_EXPORT_TYPES[0] }, required: true },
        { key: 'closing', label: 'Export closing balance as opening balance', kind: 'toggle', initial: false },
        { key: 'asOn', label: '    Closing balance as on', kind: 'date', initial: period.to, visible: (v) => v.closing },
      ]
    : [
        { key: 'type', label: 'Type of Voucher entries', kind: 'picker', title: 'Type of Voucher entries', options: VOUCHER_EXPORT_TYPES.map((t) => ({ id: t, label: t })), initial: { id: VOUCHER_EXPORT_TYPES[0], label: VOUCHER_EXPORT_TYPES[0] }, required: true },
        { key: 'dependent', label: 'Include dependent masters', kind: 'toggle', initial: false },
        { key: 'from', label: 'Period from', kind: 'date', initial: period.from, required: true },
        { key: 'to', label: 'Period to', kind: 'date', initial: period.to, required: true },
      ];
  fields.push(
    { key: 'format', label: 'File Format', kind: 'picker', title: 'List of File Formats', options: EXPORT_FILE_FORMATS.map((f) => ({ id: f, label: f })), initial: { id: EXPORT_FILE_FORMATS[1], label: EXPORT_FILE_FORMATS[1] }, required: true, heading: 'Export Settings' },
    { key: 'folder', label: 'Folder Path', kind: 'text', initial: 'Chosen when saving' },
    { key: 'file', label: 'File Name', kind: 'text', initial: masters ? 'Master' : 'Transactions', required: true }
  );

  const run = async () => {
    if (busyRef.current) return;
    const v = form.current?.submit();
    if (!v) return;
    const json = v.format === EXPORT_FILE_FORMATS[1];
    setBusy(true);
    try {
      let text: string;
      if (masters) {
        const opts = { type: v.type as MasterExportType, closingAsOpening: v.closing && v.asOn ? { asOn: v.asOn as string } : null };
        text = json ? await exportMastersJson(books, opts) : await exportMastersXmlFor(books, opts);
      } else {
        if (!v.from || !v.to || v.from > v.to) throw new Error('Enter a valid period');
        const opts = { type: v.type as VoucherExportType, dependentMasters: !!v.dependent };
        text = json ? await exportVouchersJson(books, v.from, v.to, opts) : await exportVouchersXmlFor(books, v.from, v.to, opts);
      }
      const base = String(v.file || (masters ? 'Master' : 'Transactions')).replace(/\.(xml|json)$/i, '').replace(/[\\/:*?"<>|]+/g, '_');
      const saved = await saveTextFile(`${base}.${json ? 'json' : 'xml'}`, text, json ? 'application/json' : 'text/xml');
      if (saved) toast(`${title.replace('Export ', '')} of ${company?.name ?? 'the company'} exported to ${saved}`, 'ok');
    } catch (e) {
      toast((e as Error).message, 'err');
    } finally {
      setBusy(false);
    }
  };

  useScreen({
    title,
    noPeriod: true,
    keys: { 'Ctrl+A': () => void run(), 'Alt+E': () => void run() },
    buttons: [{ key: 'Ctrl+A', label: 'Export', run: () => void run() }],
  });

  return (
    <div className="max-w-[640px] border border-tb-line bg-tb-paper p-4">
      <h3 className="mb-3 border-b border-tb-line pb-1 text-[15px] font-semibold">{title}</h3>
      <Form ref={form} fields={fields} onDone={() => void run()} labelWidth={330} />
      <p className="mt-4 text-xs text-tb-muted">
        {masters ? 'Groups, ledgers, voucher types, units, godowns, stock groups, categories, stock items and cost centres' : `Vouchers from ${fmtDate(period.from)} to ${fmtDate(period.to)} by default`} are exported in Tally's structure, so TallyPrime can import the file (Alt+O). Ctrl+A exports.
      </p>
      {busy && <div className="mt-2 font-bold">Exporting...</div>}
    </div>
  );
}
