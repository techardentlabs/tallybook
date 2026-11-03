import { KeyButton } from '../ui/KeyButton.tsx';
import { useRef, useState } from 'react';
import { useScreen, type KeyHandler } from '../registry.ts';
import { useStore } from '../store.tsx';
import { useNav } from '../nav.tsx';
import { Form, type FieldDef, type FormHandle } from '../ui/Form.tsx';
import { MenuCard, useMenu, type MenuItem } from '../ui/Menu.tsx';
import { docFromScreen, docText, letterKey, MultiAccountScreen, PreviewScreen, DEFAULT_SHARE_CONFIG, type ShareDoc } from './Share.tsx';

const PRINTER_KEY = 'tallybook.print.settings';

interface PrinterSettings {
  printer: string;
  signature: string;
  copies: number;
}

function loadSettings(): PrinterSettings {
  try {
    const raw = localStorage.getItem(PRINTER_KEY);
    if (raw) return { printer: 'System Print Dialog', signature: 'Not Applicable', copies: 1, ...(JSON.parse(raw) as Partial<PrinterSettings>) };
  } catch {
    return { printer: 'System Print Dialog', signature: 'Not Applicable', copies: 1 };
  }
  return { printer: 'System Print Dialog', signature: 'Not Applicable', copies: 1 };
}

function storeSettings(s: PrinterSettings) {
  try {
    localStorage.setItem(PRINTER_KEY, JSON.stringify(s));
  } catch {
    return;
  }
}

export function PrinterSettingsScreen({ onSaved }: { onSaved: () => void }) {
  const form = useRef<FormHandle>(null);
  const cur = loadSettings();
  const fields: FieldDef[] = [
    { key: 'printer', label: 'Printer', kind: 'picker', title: 'List of Printers', options: [{ id: 'System Print Dialog', label: 'System Print Dialog', sub: 'Ready' }, { id: 'Microsoft Print to PDF', label: 'Save as PDF', sub: 'Ready' }], initial: { id: cur.printer, label: cur.printer }, required: true },
    { key: 'signature', label: 'Digital Signature', kind: 'picker', title: 'Digital Signature', options: [{ id: 'Not Applicable', label: 'Not Applicable' }], initial: { id: cur.signature, label: cur.signature } },
    { key: 'copies', label: 'Number of Copies', kind: 'text', initial: String(cur.copies), validate: (v) => (/^\d+$/.test(v.copies) && Number(v.copies) >= 1 && Number(v.copies) <= 99 ? null : 'Number of copies must be between 1 and 99') },
  ];
  const save = () => {
    const v = form.current?.submit();
    if (!v) return;
    storeSettings({ printer: v.printer ?? cur.printer, signature: v.signature ?? cur.signature, copies: Number(v.copies) });
    onSaved();
  };
  useScreen({ title: 'Printer Settings', noPeriod: true, keys: { 'Ctrl+A': () => save() }, buttons: [{ key: 'Ctrl+A', label: 'Accept', run: save }] });
  return (
    <div className="max-w-3xl border border-tb-line bg-tb-paper p-4">
      <h3 className="mb-4 text-center text-[15px] font-semibold"><span className="border-b border-tb-line px-1">Printer Settings</span></h3>
      <Form ref={form} fields={fields} onDone={save} labelWidth={260} />
      <p className="mt-4 text-xs text-tb-muted">Printing uses the system print dialog, where the actual printer, paper size and PDF output are chosen.</p>
    </div>
  );
}

export function PrintScreen({ doc }: { doc: ShareDoc }) {
  const nav = useNav();
  const { toast } = useStore();
  const [settings, setSettings] = useState(loadSettings);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const print = () => {
    const copies = settingsRef.current.copies;
    nav.pop();
    setTimeout(() => {
      for (let i = 0; i < copies; i++) window.print();
    }, 80);
  };
  const preview = () => nav.push(<PreviewScreen title={doc.title} text={docText(doc, { ...DEFAULT_SHARE_CONFIG, showGstin: true }, 100000).text} />);
  const configure = () => nav.push(<PrinterSettingsScreen onSaved={() => { setSettings(loadSettings()); nav.pop(); toast('Printer settings saved', 'ok'); }} />);

  useScreen({
    title: 'Print',
    noPeriod: true,
    keys: { C: letterKey(configure), I: letterKey(preview), P: letterKey(print), Enter: () => print() },
    buttons: [{ key: 'C', label: 'Configure', run: configure }, { key: 'I', label: 'Preview', run: preview }, { key: 'P', label: 'Print', run: print }],
  });

  const row = (l: string, v: string, indent = false) => (
    <div key={l} className="flex">
      <span className={`w-[240px] ${indent ? 'pl-4' : ''}`}>{l}</span>
      <span className="font-bold">: {v}</span>
    </div>
  );
  return (
    <div className="max-w-[560px] border border-tb-line bg-tb-paper p-4">
      <h3 className="mb-3 border-b border-tb-line pb-1 text-[15px] font-semibold">Print</h3>
      {doc.kind === 'report' && row('Period', doc.period)}
      {row('Report Type', doc.title)}
      <div className="h-4" />
      {row('Printer', settings.printer)}
      {row('Number of Copies', String(settings.copies))}
      <div className="mt-6 flex justify-center gap-5">
        <KeyButton k="C" label="Configure" run={configure} />
        <KeyButton k="I" label="Preview" run={preview} />
        <KeyButton k="P" label="Print" run={print} primary />
      </div>
    </div>
  );
}

export function PrintMenu({ doc }: { doc: ShareDoc | null }) {
  const { toast } = useStore();
  const nav = useNav();
  const items: MenuItem[] = [
    { label: 'Current', hotkey: 'U', hint: 'Ctrl+P', run: () => (doc ? nav.replace(<PrintScreen doc={doc} />) : toast('Open a report or voucher to print it', 'err')) },
    { label: 'Others', hotkey: 'O', run: () => nav.replace(<MultiAccountScreen verb="Printing" />) },
    { label: '' },
    { label: 'Configuration', hotkey: 'N', run: () => nav.replace(<PrinterSettingsScreen onSaved={() => nav.pop()} />) },
  ];
  const { sel, setSel, keys } = useMenu(items);
  useScreen({ title: 'Print', noPeriod: true, keys, buttons: [] });
  return <MenuCard title="Print" items={items} sel={sel} setSel={setSel} width={332} />;
}

export function usePrintKeys(fmt: (iso: string) => string): Record<string, KeyHandler> {
  const { company, period, toast } = useStore();
  const nav = useNav();
  return {
    'Alt+P': () => nav.push(<PrintMenu doc={docFromScreen(company, period, fmt)} />),
    'Ctrl+P': () => {
      const d = docFromScreen(company, period, fmt);
      if (d) nav.push(<PrintScreen doc={d} />);
      else toast('Open a report or voucher to print it', 'err');
    },
  };
}
