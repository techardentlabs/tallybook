import { KeyButton } from '../ui/KeyButton.tsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_TEMPLATE, IMPORT_BEHAVIOURS, IMPORT_FILE_FORMATS, MAPPING_TEMPLATES, MASTER_TYPES, SAMPLE_FILES, createBackup, guessMasterKind, importMastersFromRows, importMastersXml2, importTallyXml,
  importVouchersFromRows, importVouchersXml2, isVoucherSheet, pickSheet, readSpreadsheet, sampleWorkbook,
  type ExcelImportReport, type ImportBehaviour, type MasterKind, type Sheet, type Xml2Report, type ImportReport,
} from '@tallybook/core';
import { useScreen } from '../registry.ts';
import { useStore } from '../store.tsx';
import { useNav } from '../nav.tsx';
import { isTauri } from '../db/index.ts';
import { saveTextFile } from '../files.ts';
import { Form, type FieldDef, type FormHandle } from '../ui/Form.tsx';
import { MenuCard, useMenu } from '../ui/Menu.tsx';
import { Frame, th } from './Reports.tsx';

export type ImportTarget = 'masters' | 'transactions';

export interface PickedFile {
  name: string;
  folder: string;
  bytes: Uint8Array;
}

export async function pickBinaryFile(label: string, extensions: string[]): Promise<PickedFile | null> {
  if (isTauri()) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const { readFile } = await import('@tauri-apps/plugin-fs');
    const path = await open({ multiple: false, filters: [{ name: label, extensions }] });
    if (!path || Array.isArray(path)) return null;
    const bytes = await readFile(path);
    const parts = path.split(/[\\/]/);
    return { name: parts.pop() ?? path, folder: parts.join('\\') || '/', bytes };
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = extensions.map((e) => `.${e}`).join(',');
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      resolve({ name: f.name, folder: 'Local drive', bytes: new Uint8Array(await f.arrayBuffer()) });
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

export async function saveBinaryFile(suggested: string, bytes: Uint8Array, mime: string): Promise<string | null> {
  if (isTauri()) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { writeFile } = await import('@tauri-apps/plugin-fs');
    const path = await save({ defaultPath: suggested });
    if (!path) return null;
    await writeFile(path, bytes);
    return path;
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = suggested;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return suggested;
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const decodeUtf = (b: Uint8Array) => new TextDecoder().decode(b);

interface Summary {
  heading: string;
  counts: [string, string | number][];
  items: { row: number | string; name: string; action: string; detail: string }[];
  errors: { master: boolean; name: string; message: string; where: string }[];
  warnings: string[];
}

function fromExcel(r: ExcelImportReport, isVoucher: boolean): Summary {
  return {
    heading: r.kind,
    counts: [
      ['Rows read', r.rowsRead],
      [`${r.kind} to create`, r.created],
      ...(r.updated || !isVoucher ? ([[`${r.kind} to alter`, r.updated]] as [string, number][]) : []),
      ['Ignored (already present)', r.ignored],
      ...r.stats.filter((s) => !['Ledgers', 'Vouchers', 'Groups', 'Stock Items', 'Units', 'Godowns', 'Cost Centres', 'Stock Groups', 'Stock Categories'].includes(s.label)).map((s) => [s.label, s.count] as [string, number]),
      ['Exceptions', r.errors.length],
    ],
    items: r.items.map((i) => ({ row: i.row, name: i.name, action: i.action, detail: i.detail })),
    errors: r.errors.map((e) => ({ master: !isVoucher, name: e.name, message: e.message, where: `Row ${e.row}` })),
    warnings: r.warnings,
  };
}

function fromXml(a: ImportReport | null, b: Xml2Report): Summary {
  const created = (a?.created.groups ?? 0) + (a?.created.ledgers ?? 0) + (a?.created.vouchers ?? 0) + Object.values(b.created).reduce((s, n) => s + n, 0);
  const updated = (a?.updated.ledgers ?? 0) + (a?.updated.vouchers ?? 0) + Object.values(b.updated).reduce((s, n) => s + n, 0);
  const errors = [...(a?.errors ?? []), ...b.errors];
  return {
    heading: 'Tally XML',
    counts: [
      ['Groups', a?.created.groups ?? 0],
      ['Ledgers', a?.created.ledgers ?? 0],
      ['Stock Items', b.created.stock_items],
      ['Units', b.created.units],
      ['Godowns', b.created.godowns],
      ['Cost Centres', b.created.cost_centres],
      ['Voucher Types', (a?.created.voucher_types ?? 0) + b.created.voucher_types],
      ['Vouchers', (a?.created.vouchers ?? 0) + b.created.vouchers],
      ['Stock lines', b.totals.stock_lines],
      ['Total to create', created],
      ['Total to alter', updated],
      ['Exceptions', errors.length],
    ],
    items: [],
    errors: errors.map((e) => ({ master: e.kind !== 'voucher', name: e.name, message: e.message, where: e.kind })),
    warnings: [...(a?.warnings ?? []), ...b.warnings],
  };
}

function Box({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="max-w-[640px] border border-tb-line bg-tb-paper p-4">
      <h3 className="mb-1 border-b border-tb-line pb-1 text-[15px] font-semibold">{title}</h3>
      {children}
    </div>
  );
}

function SummaryView({ s, title, note }: { s: Summary; title: string; note: string }) {
  return (
    <div className="max-w-[860px] border border-tb-line bg-tb-paper p-4">
      <h3 className="mb-2 border-b border-tb-line pb-1 text-[15px] font-semibold">{title}</h3>
      <div className="mb-3 grid grid-cols-[320px_1fr] gap-y-0.5">
        {s.counts.map(([l, v]) => (
          <div key={l} className="contents">
            <span>{l}</span>
            <span className={`font-bold ${l === 'Exceptions' && Number(v) > 0 ? 'text-tb-danger' : ''}`}>: {v}</span>
          </div>
        ))}
      </div>
      {s.items.length > 0 && (
        <table className="mb-3 w-full text-[14px]">
          <thead>
            <tr className="text-left">
              <th className={th}>Row</th>
              <th className={th}>Particulars</th>
              <th className={th}>Action</th>
              <th className={th}>Details</th>
            </tr>
          </thead>
          <tbody>
            {s.items.slice(0, 200).map((i, k) => (
              <tr key={k} className={i.action === 'Error' ? 'text-tb-danger' : ''}>
                <td className="px-2">{i.row}</td>
                <td className="px-2 font-bold">{i.name}</td>
                <td className="px-2">{i.action}</td>
                <td className="px-2">{i.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {s.items.length > 200 && <div className="mb-2 text-xs text-tb-muted">Showing the first 200 of {s.items.length} rows</div>}
      {s.warnings.slice(0, 20).map((w, i) => (
        <div key={i} className="text-xs text-tb-muted">{w}</div>
      ))}
      <div className="mt-3 text-sm">{note}</div>
    </div>
  );
}

export function ImportExceptions({ summary }: { summary: Summary }) {
  useScreen({ title: 'Import Exceptions', buttons: [] });
  const groups = (master: boolean) => {
    const by = new Map<string, Summary['errors']>();
    for (const e of summary.errors.filter((x) => x.master === master)) by.set(e.message.replace(/"[^"]*"/g, '"…"'), [...(by.get(e.message.replace(/"[^"]*"/g, '"…"')) ?? []), e]);
    return [...by.entries()];
  };
  const section = (title: string, master: boolean) => {
    const g = groups(master);
    if (!g.length) return null;
    return (
      <div className="mb-4">
        <div className="tb-spaced mb-1">{title}</div>
        <table className="w-full">
          <thead>
            <tr className="text-left">
              <th className={th}>Exception</th>
              <th className={th}>Particulars</th>
              <th className={th}>Location</th>
            </tr>
          </thead>
          <tbody>
            {g.map(([msg, list]) =>
              list.map((e, i) => (
                <tr key={msg + i}>
                  <td className="px-2">{i === 0 ? `${msg} (${list.length})` : ''}</td>
                  <td className="px-2 font-bold">{e.name}</td>
                  <td className="px-2">{e.where}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    );
  };
  return (
    <Frame title="Import Exceptions" subtitle={`${summary.errors.length} exception(s)`}>
      {section('Master-Related Exceptions', true)}
      {section('Voucher-Related Exceptions', false)}
    </Frame>
  );
}

type Phase =
  | { name: 'form' }
  | { name: 'working'; label: string }
  | { name: 'summary'; summary: Summary; apply: () => Promise<Summary> }
  | { name: 'done'; summary: Summary };

export function ImportDataScreen({ target }: { target: ImportTarget }) {
  const { books, bump, toast, company } = useStore();
  const nav = useNav();
  const form = useRef<FormHandle>(null);
  const [file, setFile] = useState<PickedFile | null>(null);
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [phase, setPhase] = useState<Phase>({ name: 'form' });
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const title = target === 'masters' ? 'Import Masters' : 'Import Transactions';
  const ext = file?.name.split('.').pop()?.toLowerCase() ?? '';

  const choose = async () => {
    try {
      const f = await pickBinaryFile('Data files', ['xlsx', 'csv', 'xml', 'json']);
      if (!f) return;
      const e = f.name.split('.').pop()?.toLowerCase();
      setSheets(e === 'xml' || e === 'json' ? [] : await readSpreadsheet(f.name, f.bytes));
      setFile(f);
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };

  useEffect(() => {
    void choose();
  }, []);

  const fields = useMemo<FieldDef[]>(() => {
    const excel = (v: Record<string, unknown>) => v.format === IMPORT_FILE_FORMATS[0];
    const firstSheet = sheets[0];
    const guessed = firstSheet ? guessMasterKind(firstSheet.name, firstSheet.rows) : null;
    const f: FieldDef[] = [
      { key: 'format', label: 'File Format', kind: 'picker', title: 'List of File Formats', options: IMPORT_FILE_FORMATS.map((x) => ({ id: x, label: x })), initial: { id: ext === 'xml' ? IMPORT_FILE_FORMATS[2] : ext === 'json' ? IMPORT_FILE_FORMATS[1] : IMPORT_FILE_FORMATS[0], label: ext === 'xml' ? IMPORT_FILE_FORMATS[2] : ext === 'json' ? IMPORT_FILE_FORMATS[1] : IMPORT_FILE_FORMATS[0] }, required: true },
      { key: 'path', label: 'File Path', kind: 'text', initial: file?.folder ?? '' },
      { key: 'file', label: 'File to Import', kind: 'text', initial: file?.name ?? '', required: true },
      { key: 'sheet', label: 'Worksheet Name', kind: 'picker', title: 'List of Worksheets', options: sheets.map((s) => ({ id: s.name, label: s.name })), initial: firstSheet ? { id: firstSheet.name, label: firstSheet.name } : undefined, visible: excel, required: true },
      { key: 'template', label: 'Mapping Template', kind: 'picker', title: 'List of Mapping Templates', options: [{ id: DEFAULT_TEMPLATE, label: DEFAULT_TEMPLATE }, ...MAPPING_TEMPLATES.map((t) => ({ id: t.name, label: t.name, sub: t.type }))], initial: { id: DEFAULT_TEMPLATE, label: DEFAULT_TEMPLATE }, visible: excel, required: true },
    ];
    if (target === 'masters') {
      const kindLabel = MASTER_TYPES.find((t) => t.kind === guessed)?.label;
      f.push(
        { key: 'kind', label: '    Type of Master', kind: 'picker', title: 'List of Masters', options: MASTER_TYPES.map((t) => ({ id: t.kind, label: t.label })), initial: kindLabel ? { id: guessed!, label: kindLabel } : undefined, visible: excel, required: true },
        { key: 'behaviour', label: 'Behaviour of Import if master already exists', kind: 'picker', title: 'Behaviour of Import', options: IMPORT_BEHAVIOURS.map((b) => ({ id: b, label: b })), initial: { id: 'Ignore Duplicates', label: 'Ignore Duplicates' }, required: true }
      );
    }
    f.push(
      { key: 'preview', label: 'Preview Import Summary', kind: 'toggle', initial: true },
      { key: 'backup', label: 'Backup Company Data before Import', kind: 'toggle', initial: true },
      { key: 'backupPath', label: '      Backup Destination Path', kind: 'text', initial: 'Chosen when saving', visible: (v) => v.backup }
    );
    return f;
  }, [file, sheets, target, ext]);

  const buildJob = (v: Record<string, unknown>): { dry: () => Promise<Summary>; apply: () => Promise<Summary> } | string => {
    if (!file) return 'Select the file to import first (Ctrl+O)';
    const format = v.format as string;
    if (format === IMPORT_FILE_FORMATS[1]) return 'JSON (Data Exchange) import is not supported yet';
    if (format === IMPORT_FILE_FORMATS[2]) {
      const text = decodeUtf(file.bytes);
      if (target === 'masters') {
        const behaviour = (v.behaviour as ImportBehaviour) === 'Ignore Duplicates' ? 'ignore' : 'modify';
        return {
          dry: async () => fromXml(await importTallyXml(books, text, { dryRun: true }), await importMastersXml2(books, text, { dryRun: true, behaviour })),
          apply: async () => fromXml(await importTallyXml(books, text), await importMastersXml2(books, text, { behaviour })),
        };
      }
      return {
        dry: async () => fromXml(null, await importVouchersXml2(books, text, { dryRun: true })),
        apply: async () => fromXml(null, await importVouchersXml2(books, text)),
      };
    }
    const sheet = pickSheet(sheets, v.sheet as string);
    if (!sheet) return 'Select the worksheet to import';
    if (target === 'masters') {
      const kind = ((v.kind as MasterKind | null) ?? guessMasterKind(sheet.name, sheet.rows)) as MasterKind | null;
      if (!kind) return 'Select the Type of Master';
      const behaviour = v.behaviour as ImportBehaviour;
      return {
        dry: async () => fromExcel(await importMastersFromRows(books, sheet.rows, kind, { dryRun: true, behaviour }), false),
        apply: async () => fromExcel(await importMastersFromRows(books, sheet.rows, kind, { behaviour }), false),
      };
    }
    if (!isVoucherSheet(sheet.rows)) return 'This worksheet does not look like a voucher sheet: Voucher Date, Voucher Type Name, Ledger Name and Ledger Amount Dr/Cr columns are needed';
    return {
      dry: async () => fromExcel(await importVouchersFromRows(books, sheet.rows, { dryRun: true }), true),
      apply: async () => fromExcel(await importVouchersFromRows(books, sheet.rows), true),
    };
  };

  const finish = (s: Summary) => {
    bump();
    setPhase({ name: 'done', summary: s });
  };

  const accept = async () => {
    if (phaseRef.current.name !== 'form') return;
    if (!file) return void choose();
    const v = form.current?.submit();
    if (!v) return;
    const job = buildJob(v);
    if (typeof job === 'string') return toast(job, 'err');
    setPhase({ name: 'working', label: v.preview ? 'Reading file…' : 'Importing…' });
    try {
      if (v.backup) {
        const stamp = new Date().toISOString().slice(0, 10);
        await saveTextFile(`${company?.name ?? 'company'} ${stamp}.tbbackup.json`, JSON.stringify(await createBackup(books.db)), 'application/json');
      }
      if (v.preview) {
        const summary = await job.dry();
        setPhase({ name: 'summary', summary, apply: job.apply });
      } else finish(await job.apply());
    } catch (e) {
      setPhase({ name: 'form' });
      toast((e as Error).message, 'err');
    }
  };

  const runImport = async () => {
    const p = phaseRef.current;
    if (p.name !== 'summary') return;
    setPhase({ name: 'working', label: 'Importing…' });
    try {
      finish(await p.apply());
    } catch (e) {
      setPhase({ name: 'form' });
      toast((e as Error).message, 'err');
    }
  };

  useEffect(() => {
    if (phase.name !== 'done') return;
    const s = phase.summary;
    const t = setTimeout(() => {
      const on = (e: KeyboardEvent) => {
        if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
        e.preventDefault();
        e.stopPropagation();
        document.removeEventListener('keydown', on, true);
        if (s.errors.length) nav.replace(<ImportExceptions summary={s} />);
        else nav.pop();
      };
      document.addEventListener('keydown', on, true);
      cleanup = () => document.removeEventListener('keydown', on, true);
    }, 0);
    let cleanup = () => {};
    return () => {
      clearTimeout(t);
      cleanup();
    };
  }, [phase, nav]);

  useScreen({
    title,
    noPeriod: true,
    keys: {
      'Ctrl+O': () => void choose(),
      'Ctrl+A': () => (phaseRef.current.name === 'form' ? void accept() : false),
      I: () => (phaseRef.current.name === 'summary' ? void runImport() : false),
      Enter: () => (phaseRef.current.name === 'summary' ? void runImport() : false),
    },
    buttons:
      phase.name === 'summary'
        ? [{ key: 'I', label: 'Import', run: () => void runImport() }]
        : phase.name === 'form'
          ? [{ key: 'Ctrl+O', label: 'Select File', run: () => void choose() }, { key: 'Ctrl+A', label: 'Accept', run: () => void accept() }]
          : [],
  });

  if (phase.name === 'working') return <div className="p-6">{phase.label}</div>;
  if (phase.name === 'summary') return <SummaryView s={phase.summary} title="Import Summary" note="Press I to Import, Esc to cancel. Nothing has been changed yet." />;
  if (phase.name === 'done') {
    const s = phase.summary;
    return (
      <div className="flex justify-center pt-16">
        <div className="w-[309px] border border-tb-line bg-tb-paper text-center">
          <h3 className="m-0 border-b border-tb-line py-2 text-[17px] font-bold">Information</h3>
          <p className="my-9 px-3">{s.errors.length ? `Import completed with ${s.errors.length} exception(s).` : 'Import completed successfully.'}</p>
          <p className="mb-3 italic">Press any key to continue</p>
        </div>
      </div>
    );
  }
  return (
    <Box title={title}>
      <div className="mt-3">
        <Form key={`${file?.name ?? ''}:${sheets.length}`} ref={form} fields={fields} onDone={() => void accept()} labelWidth={380} />
      </div>
      <p className="mt-4 text-xs text-tb-muted">
        {file ? 'Enter moves to the next field; Ctrl+A imports. Ctrl+O selects another file.' : 'Press Ctrl+O to select the Excel (.xlsx), CSV or XML file to import.'}
      </p>
    </Box>
  );
}

export function ImportMenu() {
  const nav = useNav();
  const items = [
    { label: 'Masters', hotkey: 'M', run: () => nav.push(<ImportDataScreen target="masters" />) },
    { label: 'Transactions', hotkey: 'T', run: () => nav.push(<ImportDataScreen target="transactions" />) },
    { label: '' },
    { label: 'Manage', hint: '>', hotkey: 'A', run: () => nav.push(<ImportManageMenu />) },
  ];
  const { sel, setSel, keys } = useMenu(items);
  useScreen({ title: 'Import', noPeriod: true, keys, buttons: [] });
  return <MenuCard title="Import" items={items} sel={sel} setSel={setSel} width={332} />;
}

export function ImportManageMenu() {
  const nav = useNav();
  const items = [
    { label: 'Mapping Templates', hotkey: 'M', run: () => nav.push(<MappingTemplatesScreen />) },
    { label: 'Sample Excel File', hotkey: 'S', run: () => nav.push(<SampleExcelMenu />) },
  ];
  const { sel, setSel, keys } = useMenu(items);
  useScreen({ title: 'Manage', noPeriod: true, keys, buttons: [] });
  return <MenuCard title="Manage" items={items} sel={sel} setSel={setSel} width={332} />;
}

export function SampleExcelMenu() {
  const nav = useNav();
  const items = [
    { label: 'Masters', hotkey: 'M', run: () => nav.push(<SampleFileScreen target="masters" />) },
    { label: 'Transactions', hotkey: 'T', run: () => nav.push(<SampleFileScreen target="transactions" />) },
  ];
  const { sel, setSel, keys } = useMenu(items);
  useScreen({ title: 'Sample Excel File', noPeriod: true, keys, buttons: [] });
  return <MenuCard title="Sample Excel File" items={items} sel={sel} setSel={setSel} width={332} />;
}

export function SampleFileScreen({ target }: { target: ImportTarget }) {
  const { toast } = useStore();
  const nav = useNav();
  const options = SAMPLE_FILES.filter((f) => f.target === target);
  const [cur, setCur] = useState(options[0]);
  const curRef = useRef(cur);
  curRef.current = cur;
  const title = `Export Sample Excel File for ${target === 'masters' ? 'Masters' : 'Transactions'}`;

  const exportFile = async () => {
    const f = curRef.current;
    const saved = await saveBinaryFile(f.file, sampleWorkbook(f), XLSX_MIME);
    if (saved) toast(`Exported to ${saved}`, 'ok');
  };
  const configure = () => nav.push(<SampleConfig options={options} onPick={(f) => { setCur(f); nav.pop(); }} />);

  useScreen({
    title,
    noPeriod: true,
    keys: { C: () => void configure(), E: () => void exportFile(), Enter: () => void exportFile() },
    buttons: [{ key: 'C', label: 'Configure', run: configure }, { key: 'E', label: 'Export', run: () => void exportFile() }],
  });

  return (
    <div className="max-w-[450px] border border-tb-line bg-tb-paper p-4">
      <h3 className="mb-3 border-b border-tb-line pb-1 text-[15px] font-semibold">{title}</h3>
      <div className="grid grid-cols-[170px_1fr] gap-y-0.5">
        <span>Export sample file for</span>
        <span>: {cur.label}</span>
        <span>Export to</span>
        <span>: Local drive</span>
        <span>Folder Path</span>
        <span>: Downloads</span>
        <span>File Name</span>
        <span>: {cur.file}</span>
      </div>
      <div className="mt-6 flex justify-center gap-6">
        <KeyButton k="C" label="Configure" run={configure} />
        <KeyButton k="E" label="Export" run={() => void exportFile()} primary />
      </div>
    </div>
  );
}

function SampleConfig({ options, onPick }: { options: typeof SAMPLE_FILES; onPick: (f: (typeof SAMPLE_FILES)[number]) => void }) {
  const items = options.map((f) => ({ label: f.label, run: () => onPick(f) }));
  const { sel, setSel, keys } = useMenu(items);
  useScreen({ title: 'Export Configuration', noPeriod: true, keys, buttons: [] });
  return <MenuCard title="Export sample file for" items={items} sel={sel} setSel={setSel} width={332} />;
}

export function MappingTemplatesScreen() {
  useScreen({ title: 'List of Mapping Templates', noPeriod: true, buttons: [] });
  return (
    <Box title="List of Mapping Templates">
      <div className="mt-2 grid grid-cols-[260px_1fr] gap-y-0.5">
        <span className="font-bold">&#9670; {DEFAULT_TEMPLATE}</span>
        <span />
        <span className="font-bold">All Companies</span>
        <span />
        {MAPPING_TEMPLATES.map((t) => (
          <div key={t.name} className="contents">
            <span className="pl-3">{t.name}</span>
            <span className="italic">{t.type}</span>
          </div>
        ))}
      </div>
      <p className="mt-4 max-w-xl text-xs text-tb-muted">
        The Default Template matches worksheet columns to fields by their header names, as in Tally's sample Excel files (export them from Alt+O &gt; Manage &gt; Sample Excel File). Creating or altering your own templates is not available yet.
      </p>
    </Box>
  );
}
