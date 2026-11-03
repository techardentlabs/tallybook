import { KeyButton } from '../ui/KeyButton.tsx';
import { useRef, useState } from 'react';
import { exportMastersXml, exportVouchersXml, fmtAmount, groupSummary, importTallyXml, type ImportReport } from '@tallybook/core';
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
  const { books, company, period, toast } = useStore();
  const [busy, setBusy] = useState(false);
  const run = async (kind: 'masters' | 'vouchers') => {
    if (busy) return;
    setBusy(true);
    try {
      const xml = kind === 'masters' ? await exportMastersXml(books) : await exportVouchersXml(books, period.from, period.to);
      const name = `${(company?.name ?? 'company').replace(/[^\w.-]+/g, '_')}_${kind}.xml`;
      const saved = await saveTextFile(name, xml);
      if (saved) toast(`Exported to ${saved}`, 'ok');
    } catch (e) {
      toast((e as Error).message, 'err');
    } finally {
      setBusy(false);
    }
  };
  const items = [
    { label: 'Masters (groups, ledgers, voucher types)', run: () => void run('masters') },
    { label: 'Vouchers for the current period', run: () => void run('vouchers') },
  ];
  const { sel, setSel, keys } = useMenu(items);
  useScreen({ title: 'Export Data', keys, buttons: [] });
  return (
    <div className="space-y-3">
      <MenuCard title="Export (Tally XML)" items={items} sel={sel} setSel={setSel} width={420} />
      <p className="max-w-xl text-xs text-tb-muted">The files use Tally's XML structure, so they can be imported back into Tally. Vouchers are exported for the current period ({period.from} to {period.to}); change it with Alt+F2 on any report.</p>
    </div>
  );
}
