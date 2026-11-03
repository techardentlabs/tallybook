import { useEffect, useMemo, useRef, useState } from 'react';
import {
  SPLIT_MODES,
  buildEarlierPart,
  buildLaterPart,
  companyEntryLabel,
  fmtAmount,
  fmtDate,
  fyEnd,
  isGroupEntry,
  nextFyStart,
  sortedCompanyEntries,
  splitInfo,
  validateSplitDate,
  verifyCompanyData,
  type CompanyEntry,
  type CompanyIndex,
  type Db,
  type SplitCheck,
  type SplitMode,
  type SplitPartResult,
  type VerifyIssue,
} from '@tallybook/core';
import { useScreen } from '../registry.ts';
import { useStore } from '../store.tsx';
import { useNav } from '../nav.tsx';
import { useDialogs } from '../ui/Dialogs.tsx';
import { MenuCard, useMenu } from '../ui/Menu.tsx';
import { Form, type FieldDef, type FormHandle } from '../ui/Form.tsx';
import { vault } from '../db/index.ts';
import { attachCompany, companyIsEncrypted, currentCompanyEntry, discardCompany, loadCompanyIndex, newCompanyData, registerCompany } from '../db/companies.ts';
import { flushStorage } from '../db/index.ts';
import { Frame, th } from './Reports.tsx';
import { VaultPasswordPanel } from './Login.tsx';
import { SelectCompanyScreen } from './Security.tsx';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

interface Source {
  db: Db;
  encrypted: boolean;
  password?: string;
  close: () => Promise<void>;
}

function useCompanyIndex(): CompanyIndex | null {
  const { toast } = useStore();
  const [index, setIndex] = useState<CompanyIndex | null>(null);
  useEffect(() => {
    let live = true;
    loadCompanyIndex()
      .then((i) => live && setIndex(i))
      .catch((e) => toast(errText(e), 'err'));
    return () => {
      live = false;
    };
  }, [toast]);
  return index;
}

function useSourceOpener() {
  const { books } = useStore();
  const [ask, setAsk] = useState<{ entry: CompanyEntry; resolve: (pw: string | null) => void } | null>(null);
  const open = async (entry: CompanyEntry): Promise<Source | null> => {
    const current = currentCompanyEntry()?.id === entry.id;
    const encrypted = current ? vault().encrypted() : await companyIsEncrypted(entry);
    let password: string | undefined;
    if (encrypted) {
      const pw = await new Promise<string | null>((resolve) => setAsk({ entry, resolve }));
      setAsk(null);
      if (pw === null) return null;
      password = pw;
    }
    if (current) {
      await flushStorage();
      return { db: books.db, encrypted, password, close: async () => undefined };
    }
    const a = await attachCompany(entry, { readonly: true, password });
    return { db: a.db, encrypted, password, close: a.close };
  };
  const panel = ask ? (
    <VaultPasswordPanel
      title="TallyVault"
      message={<>Enter the TallyVault password of <b>{companyEntryLabel(ask.entry)}</b></>}
      submit={async (pw) => {
        if (currentCompanyEntry()?.id === ask.entry.id && !(await vault().verify(pw))) throw new Error('Incorrect TallyVault password');
        ask.resolve(pw);
      }}
      onCancel={() => ask.resolve(null)}
    />
  ) : null;
  return { open, panel };
}

export function SplitMenu() {
  const nav = useNav();
  const items = [
    { label: 'Verify Data', hotkey: 'V', run: () => nav.push(<VerifyDataScreen />) },
    { label: 'Split Data', hotkey: 'S', run: () => nav.push(<SplitDataScreen />) },
  ];
  const { sel, setSel, keys } = useMenu(items);
  useScreen({ title: 'Split', noPeriod: true, keys, buttons: [] });
  return <MenuCard title="Split" items={items} sel={sel} setSel={setSel} />;
}

export function VerifyDataScreen() {
  const index = useCompanyIndex();
  const nav = useNav();
  const { toast } = useStore();
  const opener = useSourceOpener();
  if (!index) return null;
  const list: CompanyIndex = { ...index, companies: index.companies.filter((c) => !isGroupEntry(c)) };
  return (
    <>
      <SelectCompanyScreen
        title="Verify Data"
        index={list}
        onOpen={(c) =>
          void (async () => {
            const src = await opener.open(c);
            if (!src) return;
            try {
              const issues = await verifyCompanyData(src.db);
              nav.replace(<VerifyResult company={companyEntryLabel(c)} issues={issues} />);
            } finally {
              await src.close();
            }
          })().catch((e) => toast(errText(e), 'err'))
        }
      />
      {opener.panel}
    </>
  );
}

function VerifyResult({ company, issues }: { company: string; issues: VerifyIssue[] }) {
  useScreen({ title: 'List of Errors', noPeriod: true, buttons: [] });
  return (
    <Frame title="List of Errors" subtitle={company} plain>
      {issues.length === 0 ? (
        <div className="py-6 text-center">Data verification completed. No errors found.</div>
      ) : (
        <table className="w-full">
          <thead>
            <tr className="text-left">
              <th className={th}>Type</th>
              <th className={th}>Particulars</th>
              <th className={th}>Error</th>
            </tr>
          </thead>
          <tbody>
            {issues.map((i, k) => (
              <tr key={k}>
                <td className="px-2">{i.kind}</td>
                <td className="px-2 font-bold">{i.particulars}</td>
                <td className="px-2">{i.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Frame>
  );
}

interface Done {
  source: string;
  date: string;
  parts: SplitPartResult[];
  check: SplitCheck | null;
  earlierClosing: number | null;
}

export function SplitDataScreen() {
  const index = useCompanyIndex();
  const { books, company, toast } = useStore();
  const nav = useNav();
  const dialogs = useDialogs();
  const opener = useSourceOpener();
  const form = useRef<FormHandle>(null);
  const [suggested, setSuggested] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const cur = currentCompanyEntry();

  useEffect(() => {
    if (!company || isGroupEntry(cur)) return setSuggested(company ? nextFyStart(company.fy_start) : '');
    void splitInfo(books.db).then((i) => setSuggested(i.suggested)).catch(() => setSuggested(nextFyStart(company.fy_start)));
  }, [books, company]);

  const choices = useMemo(() => (index ? sortedCompanyEntries(index).filter((c) => !isGroupEntry(c)) : []), [index]);
  const fields = useMemo<FieldDef[]>(() => {
    const first = choices.find((c) => c.id === cur?.id) ?? choices[0];
    return [
      { key: 'company', label: 'Company', kind: 'picker', title: 'List of Companies', required: true, options: choices.map((c) => ({ id: c.id, label: companyEntryLabel(c), sub: `(${c.id})` })), initial: first ? { id: first.id, label: companyEntryLabel(first) } : undefined },
      { key: 'from', label: 'Split from', kind: 'date', required: true, initial: suggested ?? '' },
      { key: 'mode', label: 'Split Company', kind: 'picker', title: 'Split Company', required: true, options: SPLIT_MODES.map((m) => ({ id: m, label: m })), initial: { id: SPLIT_MODES[0], label: SPLIT_MODES[0] } },
    ];
  }, [choices, suggested, cur?.id]);

  const makePart = async <T extends { part: SplitPartResult }>(src: Source, build: (dest: Db) => Promise<T>): Promise<T> => {
    const { entry, data } = await newCompanyData(src.encrypted ? src.password : undefined);
    try {
      const r = await build(data.db);
      await data.close();
      await registerCompany(entry.id, { name: r.part.name, fy_start: r.part.fy_start, fy_end: fyEnd(r.part.fy_start) });
      return r;
    } catch (e) {
      await data.close().catch(() => undefined);
      await discardCompany(entry.id).catch(() => undefined);
      throw e;
    }
  };

  const accept = async () => {
    if (busyRef.current) return;
    const v = form.current?.submit();
    if (!v) return;
    const entry = choices.find((c) => c.id === v.company);
    if (!entry) return toast('Select the company to split', 'err');
    const date = v.from as string | null;
    const mode = v.mode as SplitMode;
    if (!date) return toast('Enter the Split from date', 'err');
    if (!(await dialogs.confirm('Data will be split into new companies. The original company remains unchanged. Accept ?', { title: 'Split Company Data' }))) return;
    let src: Source | null = null;
    try {
      src = await opener.open(entry);
      if (!src) return;
      const info = await splitInfo(src.db);
      validateSplitDate(info, date);
      setBusy('Verifying data...');
      const issues = await verifyCompanyData(src.db);
      if (issues.length) {
        setBusy(null);
        nav.push(<VerifyResult company={companyEntryLabel(entry)} issues={issues} />);
        return toast('Verify Data found errors. Correct them before splitting.', 'err');
      }
      const parts: SplitPartResult[] = [];
      let check: SplitCheck | null = null;
      let earlierClosing: number | null = null;
      if (mode !== 'From Split Date') {
        setBusy(`Creating company upto ${fmtDate(addDays(date, -1))}...`);
        const r = await makePart(src, (dest) => buildEarlierPart(src!.db, dest, date));
        parts.push(r.part);
        earlierClosing = r.closing;
      }
      if (mode !== 'Before Split Date') {
        setBusy(`Creating company from ${fmtDate(date)}...`);
        const r = await makePart(src, (dest) => buildLaterPart(src!.db, dest, date));
        parts.push(r.part);
        check = r.check;
      }
      setBusy(null);
      nav.replace(<SplitResult done={{ source: info.name, date, parts, check, earlierClosing }} />);
    } catch (e) {
      setBusy(null);
      toast(errText(e), 'err');
    } finally {
      await src?.close().catch(() => undefined);
    }
  };

  useScreen({
    title: 'Split Company Data',
    noPeriod: true,
    keys: { 'Ctrl+A': () => void accept() },
    buttons: [{ key: 'Ctrl+A', label: 'Accept', run: () => void accept() }],
  });

  if (!index || suggested === null) return null;
  return (
    <div className="max-w-[640px] border border-tb-line bg-tb-paper p-4">
      <h3 className="mb-3 border-b border-tb-line pb-1 text-[15px] font-semibold">Split Company Data</h3>
      <Form key={`${suggested}:${choices.length}`} ref={form} fields={fields} onDone={() => void accept()} labelWidth={200} />
      <ul className="mt-4 list-disc pl-5 text-xs text-tb-muted">
        <li>From Split Date: a new company from the split date, with closing balances, pending bills, stock and unreconciled bank entries carried as opening.</li>
        <li>Before Split Date: a new company with the vouchers up to the day before the split date.</li>
        <li>Into Two Companies: both. The original company is not changed.</li>
        <li>Sales and purchase orders and cost centre balances are not carried forward.</li>
      </ul>
      {busy && <div className="mt-3 font-bold">{busy}</div>}
      {opener.panel}
    </div>
  );
}

function Line({ label, value, warn }: { label: string; value: string | number; warn?: boolean }) {
  return (
    <div className="contents">
      <span>{label}</span>
      <span className={`font-bold ${warn ? 'text-tb-danger' : ''}`}>: {value}</span>
    </div>
  );
}

function SplitResult({ done }: { done: Done }) {
  useScreen({ title: 'Split Company Data', noPeriod: true, buttons: [] });
  const c = done.check;
  const amt = (p: number) => (p === 0 ? 'Nil' : `${fmtAmount(Math.abs(p))} ${p > 0 ? 'Dr' : 'Cr'}`);
  return (
    <Frame title="Split Company Data" subtitle={`${done.source}, split from ${fmtDate(done.date)}`} plain>
      <table className="mb-4 w-full">
        <thead>
          <tr className="text-left">
            <th className={th}>Name of Company</th>
            <th className={th}>Books beginning from</th>
            <th className={th}>Vouchers</th>
          </tr>
        </thead>
        <tbody>
          {done.parts.map((p) => (
            <tr key={p.part}>
              <td className="px-2 font-bold">{p.name}</td>
              <td className="px-2">{fmtDate(p.books_from)}</td>
              <td className="px-2">{p.vouchers}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {c && (
        <div className="grid max-w-[640px] grid-cols-[360px_1fr] gap-y-0.5">
          <Line label={`Trial Balance total as on ${fmtDate(addDays(done.date, -1))}`} value={amt(c.first_closing)} />
          <Line label={`Opening Trial Balance on ${fmtDate(done.date)}`} value={amt(c.second_opening)} />
          <Line label="Difference" value={c.difference === 0 ? 'Nil (balances reconcile)' : amt(c.difference)} warn={c.difference !== 0} />
          {done.earlierClosing !== null && <Line label="Closing Trial Balance of the earlier company" value={amt(done.earlierClosing)} warn={done.earlierClosing !== c.second_opening} />}
          <Line label="Ledgers carried forward" value={c.ledgers_checked} />
          <Line label="Ledgers not matching" value={c.mismatches.length ? c.mismatches.join(', ') : 'None'} warn={c.mismatches.length > 0} />
          <Line label={c.profit_transferred >= 0 ? 'Profit transferred to Profit & Loss A/c' : 'Loss transferred to Profit & Loss A/c'} value={fmtAmount(Math.abs(c.profit_transferred), false)} />
          <Line label="Closing stock carried as opening" value={fmtAmount(c.stock_carried, false)} />
          <Line label="Pending bills carried" value={c.bills_carried} />
          <Line label="Batches carried" value={c.batches_carried} />
          <Line label="Unreconciled bank entries (Opening BRS)" value={c.brs_carried} />
        </div>
      )}
      <p className="mt-4 text-sm">The new companies are in the list of companies (F3). {done.source} is unchanged.</p>
    </Frame>
  );
}
