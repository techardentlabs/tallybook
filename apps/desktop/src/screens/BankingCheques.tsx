import { useEffect, useMemo, useRef, useState } from 'react';
import {
  alterPostDatedBank,
  bankConfig,
  cancelCheque,
  chequeBooks,
  chequeList,
  chequePrintData,
  chequePrintingList,
  chequeRangeRegister,
  chequeRegister,
  fmtAmount,
  fmtDate,
  fmtDrCr,
  inBook,
  issueBlankCheque,
  markPrinted,
  nextChequeNo,
  padCheque,
  postDatedList,
  postDatedSummary,
  restoreCheque,
  saveBankConfig,
  saveChequeBooks,
  todayIso,
  updatePdcNote,
  type ChequeBook,
  type ChequeItem,
  type ChequePrint,
  type ChequeRegisterRow,
  type ChequeStatus,
  type PostDatedRow,
  type PrintConfig,
} from '@tallybook/core';
import { Form, type FieldDef, type FormHandle } from '../ui/Form.tsx';
import { useScreen, type Btn } from '../registry.ts';
import { useStore } from '../store.tsx';
import { useNav } from '../nav.tsx';
import { useDialogs } from '../ui/Dialogs.tsx';
import { SelectList } from './SelectList.tsx';
import { Frame, th, rowCls, usePeriodKey, useSel } from './Reports.tsx';
import { useFilter } from './reportConfig.tsx';
import { BankReconciliationScreen, BankSelector, BasisScreen, bankingReady, pickBank, useBankLoad, useBanks, useMulti } from './Banking.tsx';

const num = 'px-2 text-right tabular-nums';
const tot = 'border-y-[3px] border-double border-tb-ink px-2 text-right tabular-nums';

function LedgerLine({ name, sub }: { name: string; sub?: string }) {
  return (
    <div className="mb-2">
      <div>
        Ledger <span className="mx-1">:</span>
        <b>{name}</b>
      </div>
      {sub && <div className="italic">{sub}</div>}
    </div>
  );
}

const STATUS_COLS = ['available', 'unreconciled', 'reconciled', 'blank', 'cancelled', 'out_of_period', 'total'] as const;
const STATUS_OF: Record<string, ChequeStatus | 'Out of Period' | undefined> = {
  available: 'Available',
  unreconciled: 'Unreconciled',
  reconciled: 'Reconciled',
  blank: 'Blank Cheque',
  cancelled: 'Cancelled Cheque',
  out_of_period: 'Out of Period',
  total: undefined,
};

function useRegisterBasis() {
  const nav = useNav();
  const [v, setV] = useState({ notInRange: false, ignoreCompleted: false });
  const run = () =>
    nav.push(
      <BasisScreen
        fields={[
          { key: 'notInRange', label: 'Include Not in Range cheques', kind: 'toggle', initial: v.notInRange },
          { key: 'ignoreCompleted', label: 'Ignore completed Cheque Ranges', kind: 'toggle', initial: v.ignoreCompleted },
        ]}
        onAccept={(x) => setV({ notInRange: !!x.notInRange, ignoreCompleted: !!x.ignoreCompleted })}
      />
    );
  return { v, key: { 'Ctrl+B': run }, button: { key: 'Ctrl+B', label: 'Basis of Values', run } as Btn };
}

function RegisterTable({ title, line, rows, sel, setSel, col, onCell, period }: {
  title: string;
  line: React.ReactNode;
  rows: ChequeRegisterRow[];
  sel: number;
  setSel: (i: number) => void;
  col: number;
  onCell: (i: number, c: number) => void;
  period: string;
}) {
  const sum = (k: (typeof STATUS_COLS)[number]) => rows.reduce((s, r) => s + r[k], 0);
  return (
    <Frame title={title} subtitle="">
      {line}
      <table className="w-full">
        <thead>
          <tr>
            <th className={`${th} text-center`} rowSpan={2}>Particulars</th>
            <th className={`${th} text-center`} rowSpan={2}>Available Cheques</th>
            <th className={`${th} text-center`} colSpan={4}>{period}</th>
            <th className={`${th} text-center`} rowSpan={2}>Out of Period</th>
            <th className={`${th} text-center`} rowSpan={2}>Total Cheques</th>
          </tr>
          <tr>
            {['Unreconciled', 'Reconciled', 'Blank', 'Cancelled'].map((h) => (
              <th key={h} className={`${th} text-center font-normal`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.key} className={rowCls(false)} onMouseEnter={() => setSel(i)}>
              <td className={`px-2 ${i === sel && col < 0 ? 'bg-tb-sel text-tb-sel-ink' : ''} ${r.not_in_range ? 'italic' : ''}`} onClick={() => onCell(i, -1)}>
                {r.label}
                {r.sub && <span className="ml-8">{r.sub}</span>}
              </td>
              {STATUS_COLS.map((k, c) => (
                <td key={k} className={`${num} ${i === sel && col === c ? 'bg-tb-sel text-tb-sel-ink' : i === sel ? 'bg-tb-menu' : ''}`} onClick={() => onCell(i, c)}>
                  {r[k] || ''}
                </td>
              ))}
            </tr>
          ))}
          <tr className="font-bold">
            <td className="border-y-[3px] border-double border-tb-ink px-2 tracking-[0.2em]">Grand Total</td>
            {STATUS_COLS.map((k) => (
              <td key={k} className={tot}>{sum(k) || ''}</td>
            ))}
          </tr>
        </tbody>
      </table>
    </Frame>
  );
}

export function ChequeRegisterScreen() {
  const { period } = useStore();
  const nav = useNav();
  const p = usePeriodKey();
  const flt = useFilter();
  const basis = useRegisterBasis();
  const data = useBankLoad((db) => chequeRegister(db, period.from, period.to), [period]);
  const rows = useMemo(() => (data ?? []).filter((r) => flt.match(r.label)), [data, flt]);
  const { sel, setSel, keys } = useSel(rows.length);
  const [col, setCol] = useState(-1);
  const banks = useBanks();
  const row = rows[sel];
  const open = (i: number, c: number) => {
    const r = rows[i];
    if (!r) return;
    if (c < 0) return nav.push(<ChequeRangeRegisterScreen ledgerId={r.ledger_id} />);
    const status = STATUS_OF[STATUS_COLS[c]];
    nav.push(<ChequeListScreen ledgerId={r.ledger_id} status={status} />);
  };
  const statusPick = () =>
    nav.push(
      <SelectList
        title="Select Status"
        heading="Select Cheque Status"
        items={['Available', 'Blank Cheque', 'Cancelled Cheque', 'Reconciled', 'Unreconciled'].map((s) => ({ id: s, label: s }))}
        popOnSelect
        onSelect={(it) => pickBank(nav, banks, (b) => nav.push(<ChequeListScreen ledgerId={b.id} status={it.id as ChequeStatus} />))}
      />
    );
  const alter = () => row && nav.push(<ChequeBookScreen ledgerId={row.ledger_id} />);
  const reconcile = () => row && nav.push(<BankReconciliationScreen ledgerId={row.ledger_id} />);
  const pdc = () => pickBank(nav, banks, (b) => nav.push(<PostDatedTransactionsScreen ledgerId={b.id} from={period.from} to={period.to} />));
  useScreen({
    title: 'Cheque Register',
    keys: {
      ...keys,
      ...p.key,
      ...flt.key,
      ...basis.key,
      'Alt+Q': flt.key['Ctrl+F'],
      ArrowLeft: () => setCol((c) => Math.max(-1, c - 1)),
      ArrowRight: () => setCol((c) => Math.min(STATUS_COLS.length - 1, c + 1)),
      Enter: () => open(sel, col),
      F8: statusPick,
      'Alt+B': alter,
      'Alt+R': reconcile,
      'Ctrl+J': pdc,
    },
    buttons: [p.button, { key: 'F8', label: 'Cheque Status', run: statusPick }, basis.button, { key: 'Ctrl+J', label: 'Exception Reports', run: pdc }, { key: 'Alt+Q', label: 'Quick Search', run: flt.button.run }, { key: 'Alt+B', label: 'Alter Chq Book', run: alter }, { key: 'Alt+R', label: 'Reconcile', run: reconcile }],
  });
  return (
    <>
      {flt.bar}
      <RegisterTable title="Cheque Register" line={<div className="mb-2">Bank wise Register</div>} rows={rows} sel={sel} setSel={setSel} col={col} onCell={(i, c) => { setSel(i); setCol(c); open(i, c); }} period={`${fmtDate(period.from)} to ${fmtDate(period.to)}`} />
      {data && rows.length === 0 && <div className="py-3 text-tb-muted">No cheque books or cheque transactions found.</div>}
    </>
  );
}

export function ChequeRangeRegisterScreen({ ledgerId }: { ledgerId: number }) {
  const { period } = useStore();
  const nav = useNav();
  const p = usePeriodKey();
  const basis = useRegisterBasis();
  const banks = useBanks();
  const name = banks.find((b) => b.id === ledgerId)?.name ?? '';
  const data = useBankLoad((db) => chequeRangeRegister(db, ledgerId, period.from, period.to), [ledgerId, period]);
  const rows = useMemo(
    () => (data ?? []).filter((r) => (basis.v.notInRange || !r.not_in_range) && (!basis.v.ignoreCompleted || r.available > 0 || r.not_in_range)),
    [data, basis.v]
  );
  const { sel, setSel, keys } = useSel(rows.length);
  const [col, setCol] = useState(-1);
  const open = (i: number, c: number) => {
    const r = rows[i];
    if (!r) return;
    nav.push(<ChequeListScreen ledgerId={ledgerId} status={c < 0 ? undefined : STATUS_OF[STATUS_COLS[c]]} bookId={r.book_id} notInRange={r.not_in_range} />);
  };
  const alter = () => nav.push(<ChequeBookScreen ledgerId={ledgerId} />);
  const reconcile = () => nav.push(<BankReconciliationScreen ledgerId={ledgerId} />);
  useScreen({
    title: 'Cheque Range Register',
    keys: {
      ...keys,
      ...p.key,
      ...basis.key,
      ArrowLeft: () => setCol((c) => Math.max(-1, c - 1)),
      ArrowRight: () => setCol((c) => Math.min(STATUS_COLS.length - 1, c + 1)),
      Enter: () => open(sel, col),
      'Alt+B': alter,
      'Alt+R': reconcile,
    },
    buttons: [p.button, basis.button, { key: 'Alt+B', label: 'Alter Chq Book', run: alter }, { key: 'Alt+R', label: 'Reconcile', run: reconcile }],
  });
  return (
    <RegisterTable
      title="Cheque Range Register"
      line={<LedgerLine name={name} sub="List of Cheque Ranges" />}
      rows={rows}
      sel={sel}
      setSel={setSel}
      col={col}
      onCell={(i, c) => { setSel(i); setCol(c); open(i, c); }}
      period={`${fmtDate(period.from)} to ${fmtDate(period.to)}`}
    />
  );
}

export function ChequeListScreen({ ledgerId, status, bookId, notInRange }: { ledgerId: number; status?: ChequeStatus | 'Out of Period'; bookId?: number | null; notInRange?: boolean }) {
  const { period, books, bump, toast } = useStore();
  const nav = useNav();
  const dialogs = useDialogs();
  const p = usePeriodKey();
  const flt = useFilter();
  const banks = useBanks();
  const name = banks.find((b) => b.id === ledgerId)?.name ?? '';
  const data = useBankLoad((db) => chequeList(db, ledgerId, period.from, period.to, { status, book_id: bookId, not_in_range: notInRange }), [ledgerId, period, status, bookId, notInRange]);
  const rows = useMemo(() => (data ?? []).filter((r) => flt.match(r.inst_no, r.particulars)), [data, flt]);
  const { sel, setSel, keys } = useSel(rows.length);
  const multi = useMulti(rows, (r) => r.inst_no);
  const cur = rows[sel];
  const blank = async () => {
    const chosen = multi.chosen(cur).filter((c) => c.status === 'Available');
    if (!chosen.length) return toast('Select available cheques to issue as blank', 'err');
    try {
      for (const c of chosen) await issueBlankCheque(books.db, ledgerId, c.inst_no, todayIso());
      multi.clear();
      bump();
      toast(`${chosen.length} blank cheque${chosen.length > 1 ? 's' : ''} issued`, 'ok');
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  const cancel = async () => {
    const chosen = multi.chosen(cur).filter((c) => c.status === 'Available' || c.status === 'Unreconciled' || c.status === 'Blank Cheque');
    if (!chosen.length) return toast('Select cheques that can be cancelled', 'err');
    if (!(await dialogs.confirm(`Cancel ${chosen.length} cheque${chosen.length > 1 ? 's' : ''}?`, { title: 'Cancel Cheque', def: false }))) return;
    try {
      for (const c of chosen) await cancelCheque(books.db, ledgerId, c.inst_no, todayIso());
      multi.clear();
      bump();
      toast('Cheque cancelled', 'ok');
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  const restore = async () => {
    const chosen = multi.chosen(cur).filter((c) => c.status === 'Cancelled Cheque' || c.status === 'Blank Cheque');
    if (!chosen.length) return;
    for (const c of chosen) await restoreCheque(books.db, ledgerId, c.inst_no);
    multi.clear();
    bump();
    toast('Cheque restored', 'ok');
  };
  const open = (r?: ChequeItem) => {
    if (r?.voucher_id) nav.push(<VoucherOpener voucherId={r.voucher_id} />);
  };
  const reconcile = () => nav.push(<BankReconciliationScreen ledgerId={ledgerId} />);
  useScreen({
    title: `Cheque Register${status ? ` - ${status}` : ''}`,
    keys: { ...keys, ...p.key, ...flt.key, 'Alt+Q': flt.key['Ctrl+F'], Space: () => cur && multi.toggle(cur), Enter: () => open(cur), 'Alt+I': () => void blank(), 'Alt+X': () => void cancel(), 'Alt+U': () => void restore(), 'Alt+R': reconcile },
    buttons: [p.button, { key: 'Alt+Q', label: 'Quick Search', run: flt.button.run }, { key: 'Alt+I', label: 'Issue Blank Cheque', run: () => void blank() }, { key: 'Alt+X', label: 'Cancel Cheque', run: () => void cancel() }, { key: 'Alt+U', label: 'Restore Cheque', run: () => void restore() }, { key: 'Alt+R', label: 'Reconcile', run: reconcile }],
  });
  return (
    <Frame title={`Cheque Register${status ? ` - ${status}` : ''}`}>
      {flt.bar}
      <LedgerLine name={name} />
      <table className="w-full">
        <thead>
          <tr className="text-left">
            <th className={th}>Date</th>
            <th className={th}>Particulars</th>
            <th className={th}>Instrument No.</th>
            <th className={th}>Instrument Date</th>
            <th className={th}>Status</th>
            <th className={`${th} text-right`}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.inst_no} className={rowCls(i === sel, multi.has(r) ? 'font-bold' : '')} onMouseEnter={() => setSel(i)} onClick={() => multi.toggle(r)} onDoubleClick={() => open(r)}>
              <td className="px-2">{fmtDate(r.date)}</td>
              <td className="px-2 font-bold">{r.particulars}</td>
              <td className="px-2">{r.inst_no}</td>
              <td className="px-2">{fmtDate(r.inst_date)}</td>
              <td className="px-2">{r.status}</td>
              <td className={num}>{fmtAmount(r.amount)}</td>
            </tr>
          ))}
          <tr className="font-bold">
            <td className="border-t border-tb-ink px-2 tracking-[0.2em]" colSpan={5}>Selected Total</td>
            <td className="border-t border-tb-ink px-2 text-right tabular-nums">{fmtAmount(rows.filter((r) => multi.has(r)).reduce((s, r) => s + r.amount, 0))}</td>
          </tr>
          <tr className="font-bold">
            <td className="border-y-[3px] border-double border-tb-ink px-2 tracking-[0.2em]" colSpan={5}>Grand Total</td>
            <td className={tot}>{fmtAmount(rows.reduce((s, r) => s + r.amount, 0), false)}</td>
          </tr>
        </tbody>
      </table>
      {data && rows.length === 0 && <div className="py-3 text-tb-muted">No cheques found.</div>}
    </Frame>
  );
}

function VoucherOpener({ voucherId }: { voucherId: number }) {
  const nav = useNav();
  useEffect(() => {
    void import('./Voucher.tsx').then(({ VoucherScreen }) => nav.replace(<VoucherScreen voucherId={voucherId} />));
  }, [nav, voucherId]);
  return null;
}

export function ChequeBookScreen({ ledgerId }: { ledgerId: number }) {
  const { books, bump, toast } = useStore();
  const nav = useNav();
  const banks = useBanks();
  const name = banks.find((b) => b.id === ledgerId)?.name ?? '';
  const data = useBankLoad((db) => chequeBooks(db, ledgerId), [ledgerId]);
  type R = { from: string; to: string; count: string; name: string };
  const [rows, setRows] = useState<R[]>([]);
  const loaded = useRef(false);
  const refs = useRef<Record<string, HTMLInputElement | null>>({});
  useEffect(() => {
    if (!data || loaded.current) return;
    loaded.current = true;
    setRows([...data.map((b: ChequeBook) => ({ from: padCheque(b.from_no, b.width), to: padCheque(b.to_no, b.width), count: String(b.to_no - b.from_no + 1), name: b.name })), { from: '', to: '', count: '', name: '' }]);
  }, [data]);
  const cols = ['from', 'to', 'count', 'name'] as const;
  const set = (i: number, k: (typeof cols)[number], v: string) =>
    setRows((rs) => {
      const next = rs.map((r, j) => {
        if (j !== i) return r;
        const n = { ...r, [k]: v };
        const f = Number(n.from);
        if (k === 'to' && /^\d+$/.test(n.from) && /^\d+$/.test(v) && Number(v) >= f) n.count = String(Number(v) - f + 1);
        if ((k === 'count' || k === 'from') && /^\d+$/.test(n.from) && /^\d+$/.test(n.count) && Number(n.count) > 0 && k === 'count') n.to = String(f + Number(n.count) - 1).padStart(n.from.length, '0');
        return n;
      });
      const last = next[next.length - 1];
      return last.from ? [...next, { from: '', to: '', count: '', name: '' }] : next;
    });
  const move = (i: number, c: number) => {
    const nc = c + 1;
    const [ni, nk] = nc >= cols.length ? [i + 1, 0] : [i, nc];
    setTimeout(() => refs.current[`${ni}-${cols[nk]}`]?.focus(), 0);
  };
  const save = async () => {
    try {
      await bankingReady(books.db);
      await saveChequeBooks(books.db, ledgerId, rows.map((r) => ({ from_no: r.from, to_no: r.to, count: Number(r.count) || undefined, name: r.name })));
      bump();
      toast('Cheque books saved', 'ok');
      nav.pop();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  useScreen({ title: 'Cheque Book Management', noPeriod: true, keys: { 'Ctrl+A': () => void save() }, buttons: [{ key: 'Ctrl+A', label: 'Accept', run: () => void save() }] });
  const heads = ['From Number', 'To Number', 'Number of Cheques', 'Name of Cheque Book'];
  return (
    <div className="mx-auto max-w-3xl border border-tb-line bg-tb-paper px-4 py-3">
      <div className="mb-2 text-center">
        Cheque Range for: <b>{name}</b>
      </div>
      <table className="w-full">
        <thead>
          <tr>
            {heads.map((h) => (
              <th key={h} className={`${th} text-center`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map((k, c) => (
                <td key={k} className="px-1">
                  <input
                    ref={(el) => {
                      refs.current[`${i}-${k}`] = el;
                    }}
                    className="tb-input w-full focus:bg-[#ffe3b0]"
                    value={r[k]}
                    onChange={(e) => set(i, k, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.ctrlKey && !e.altKey) {
                        e.preventDefault();
                        e.stopPropagation();
                        if (k === 'name' && !r.from && i === rows.length - 1) return void save();
                        move(i, c);
                      }
                    }}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const CHEQUE_FORMATS = ['CTS Format', 'CTS Format 2', 'CTS Format 3', 'CTS Format 4', 'CTS Format 5', 'CTS Format 6', 'CTS Format 7', 'User Defined'];

export function BankConfigurationScreen({ ledgerId }: { ledgerId: number }) {
  const { books, bump, toast } = useStore();
  const nav = useNav();
  const form = useRef<FormHandle>(null);
  const banks = useBanks();
  const name = banks.find((b) => b.id === ledgerId)?.name ?? '';
  const cfg = useBankLoad((db) => bankConfig(db, ledgerId), [ledgerId]);
  const fmtOpts = CHEQUE_FORMATS.map((f) => ({ id: f, label: f }));
  const save = async () => {
    const v = form.current?.submit();
    if (!v) return;
    try {
      await saveBankConfig(books.db, ledgerId, { cheque_printing: !!v.printing, cheque_format: v.format ? String(v.format) : cfg?.cheque_format });
      bump();
      toast('Bank configuration saved', 'ok');
      nav.pop();
      if (v.range) nav.push(<ChequeBookScreen ledgerId={ledgerId} />);
      else if (v.printing && v.setup) nav.push(<ChequePrintingConfigScreen ledgerId={ledgerId} />);
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  useScreen({ title: 'Bank Configuration', noPeriod: true, keys: { 'Ctrl+A': () => void save() }, buttons: [{ key: 'Ctrl+A', label: 'Accept', run: () => void save() }] });
  if (!cfg) return null;
  const fields: FieldDef[] = [
    { key: 'range', label: 'Set/Alter range for Cheque Books', kind: 'toggle', initial: false },
    { key: 'printing', label: 'Enable Cheque Printing', kind: 'toggle', initial: cfg.cheque_printing },
    { key: 'format', label: 'Cheque Format', kind: 'picker', title: 'Cheque Formats', options: fmtOpts, initial: fmtOpts.find((f) => f.id === cfg.cheque_format), visible: (v) => !!v.printing },
    { key: 'setup', label: 'Set/Alter Cheque Printing configuration', kind: 'toggle', initial: false, visible: (v) => !!v.printing },
  ];
  return (
    <div className="max-w-2xl">
      <div className="mb-3 font-bold underline">Bank Configuration for: {name}</div>
      <Form ref={form} fields={fields} labelWidth={320} onDone={() => void save()} />
    </div>
  );
}

const PRINT_FIELDS: { key: keyof PrintConfig; label: string; heading?: string; kind?: 'text' | 'toggle' }[] = [
  { key: 'width', label: 'Width of Cheque', heading: 'Cheque Dimension' },
  { key: 'height', label: 'Height of Cheque' },
  { key: 'cross_left', label: 'Starting Location from Left Edge', heading: 'Cross Cheque' },
  { key: 'cross_top', label: 'Starting Location from Top Edge' },
  { key: 'date_top', label: 'Distance of Line from Top Edge', heading: 'Cheque Date' },
  { key: 'date_left', label: 'Starting Location from Left Edge' },
  { key: 'date_style', label: 'Style of Date', kind: 'text' },
  { key: 'date_separator', label: 'Separator used in date', kind: 'text' },
  { key: 'date_spacing', label: 'Distance between Characters' },
  { key: 'payee_top', label: 'Distance of Line from Top Edge', heading: "Party's / Payee Name" },
  { key: 'payee_left', label: 'Starting Location from Left Edge' },
  { key: 'payee_width', label: 'Width area' },
  { key: 'words_top', label: '(A) Distance of 2nd Line from Top Edge', heading: 'Amount in Words' },
  { key: 'words_gap', label: '(B) Height (gap) between 2nd and 1st Line' },
  { key: 'words_left1', label: 'Starting Location of 1st Line from Left Edge' },
  { key: 'words_left2', label: 'Starting Location of 2nd Line from Left Edge' },
  { key: 'words_width', label: 'Width area' },
  { key: 'figures_top', label: 'Distance from Top Edge', heading: 'Amount in Figures' },
  { key: 'figures_left', label: 'Starting Location from Left Edge' },
  { key: 'figures_width', label: 'Width area' },
  { key: 'print_company', label: 'Print Company Name on Cheque', heading: 'Company Signatory Details', kind: 'toggle' },
  { key: 'company_name', label: 'Company Name on Cheque', kind: 'text' },
  { key: 'show_inst_date', label: 'Show Instrument Date', kind: 'toggle' },
];

export function ChequePrintingConfigScreen({ ledgerId }: { ledgerId: number }) {
  const { books, bump, toast, company } = useStore();
  const nav = useNav();
  const form = useRef<FormHandle>(null);
  const banks = useBanks();
  const name = banks.find((b) => b.id === ledgerId)?.name ?? '';
  const cfg = useBankLoad((db) => bankConfig(db, ledgerId), [ledgerId]);
  const read = (): Partial<PrintConfig> | null => {
    const v = form.current?.submit();
    if (!v) return null;
    const out: Record<string, unknown> = {};
    for (const f of PRINT_FIELDS) {
      const raw = v[f.key];
      if (f.kind === 'toggle') out[f.key] = !!raw;
      else if (f.kind === 'text') out[f.key] = String(raw ?? '');
      else {
        const n = Number(String(raw).trim());
        if (!Number.isFinite(n) || n < 0) {
          toast(`${f.label}: enter a valid number`, 'err');
          return null;
        }
        out[f.key] = n;
      }
    }
    return out as Partial<PrintConfig>;
  };
  const save = async () => {
    const p = read();
    if (!p) return;
    try {
      await saveBankConfig(books.db, ledgerId, { print: p });
      bump();
      toast('Cheque printing configuration saved', 'ok');
      nav.pop();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  const preview = () => {
    const p = read();
    if (!p || !cfg) return;
    const sample: ChequePrint = { alloc_id: 0, date: todayIso(), payee: 'Sample Payee', amount: 1_25_000_00, words: 'One Lakh Twenty Five Thousand Only', inst_no: '000000', company_name: company?.name ?? '', config: { ...cfg.print, ...p } };
    nav.push(<ChequeSheet data={[sample]} sample />);
  };
  useScreen({ title: 'Cheque Printing Configuration', noPeriod: true, keys: { 'Ctrl+A': () => void save(), 'Alt+P': preview }, buttons: [{ key: 'Alt+P', label: 'Preview', run: preview }, { key: 'Ctrl+A', label: 'Accept', run: () => void save() }] });
  if (!cfg) return null;
  const fields: FieldDef[] = PRINT_FIELDS.map((f) => ({
    key: f.key,
    label: f.label,
    kind: f.kind === 'toggle' ? 'toggle' : 'text',
    heading: f.heading,
    initial: f.kind === 'toggle' ? !!cfg.print[f.key] : String(cfg.print[f.key] ?? ''),
  }));
  return (
    <div className="max-w-2xl">
      <div className="text-center font-bold underline">Cheque Printing Configuration for : {name}</div>
      <div className="mb-2 text-center italic">(All Dimensions in mm only)</div>
      <Form ref={form} fields={fields} labelWidth={340} onDone={() => void save()} />
      <div className="mt-3 text-center italic">(To Preview the settings press Alt+P)</div>
    </div>
  );
}

const MM = 3.7795;

function dateDigits(iso: string, style: string, sep: string): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  const src = { d: d.split(''), m: m.split(''), y: y.split('') };
  const idx = { d: 0, m: 0, y: 0 };
  const out: string[] = [];
  for (const ch of style.replace(/\s+/g, '').toLowerCase()) {
    if (ch === 'd' || ch === 'm' || ch === 'y') out.push(src[ch][idx[ch]++] ?? '');
  }
  return out.join(sep);
}

function ChequeSheet({ data, sample = false }: { data: ChequePrint[]; sample?: boolean }) {
  const { books, bump, toast } = useStore();
  const nav = useNav();
  const print = async () => {
    window.print();
    if (!sample) {
      await markPrinted(books.db, data.map((d) => d.alloc_id));
      bump();
      toast(`${data.length} cheque${data.length > 1 ? 's' : ''} printed`, 'ok');
    }
    nav.pop();
  };
  useScreen({ title: sample ? 'Sample Cheque Printing' : 'Cheque Printing Print', noPeriod: true, keys: { P: () => void print() }, buttons: [{ key: 'P', label: 'Print', run: () => void print() }] });
  return (
    <div>
      {data.map((d) => {
        const c = d.config;
        const abs = (top: number, left: number, w?: number): React.CSSProperties => ({ position: 'absolute', top: `${top}mm`, left: `${left}mm`, ...(w ? { width: `${w}mm` } : {}) });
        const line1 = d.words.length > 55 ? d.words.slice(0, d.words.lastIndexOf(' ', 55)) : d.words;
        const line2 = d.words.slice(line1.length).trim();
        return (
          <div key={d.alloc_id} className="relative mb-6 border border-tb-line bg-tb-paper" style={{ width: `${c.width}mm`, height: `${c.height}mm`, fontSize: 14, minWidth: c.width * MM }}>
            <div style={{ ...abs(c.cross_top, c.cross_left), transform: 'rotate(-8deg)' }} className="border-y border-tb-ink px-4 text-xs">A/c Payee</div>
            <div style={{ ...abs(c.date_top, c.date_left), letterSpacing: `${c.date_spacing}mm` }}>{dateDigits(d.date, c.date_style, c.date_separator)}</div>
            <div style={abs(c.payee_top, c.payee_left, c.payee_width)}>{d.payee}</div>
            <div style={abs(c.words_top - c.words_gap, c.words_left1, c.words_width)}>{line1}</div>
            <div style={abs(c.words_top, c.words_left2, c.words_width)}>{line2}</div>
            <div style={{ ...abs(c.figures_top, c.figures_left, c.figures_width), textAlign: 'right' }}>{fmtAmount(d.amount, false)}</div>
            {d.company_name && <div style={abs(c.height - 30, c.width - 70, 60)} className="text-right text-xs">For {d.company_name}</div>}
          </div>
        );
      })}
    </div>
  );
}

export function ChequePrintingEntry() {
  return <BankSelector all next={(id) => <ChequePrintingScreen ledgerId={id} />} />;
}

export function ChequePrintingScreen({ ledgerId }: { ledgerId: number | null }) {
  const { period, books, toast } = useStore();
  const nav = useNav();
  const p = usePeriodKey();
  const banks = useBanks();
  const [incPrinted, setIncPrinted] = useState(false);
  const bank = banks.find((b) => b.id === ledgerId);
  const data = useBankLoad(
    async (db) => ({ rows: await chequePrintingList(db, ledgerId, period.from, period.to, incPrinted), cfg: ledgerId ? await bankConfig(db, ledgerId) : null }),
    [ledgerId, period, incPrinted]
  );
  const rows = data?.rows ?? [];
  const { sel, setSel, keys } = useSel(rows.length);
  const multi = useMulti(rows, (r) => String(r.alloc_id));
  const cur = rows[sel];
  const printNow = async () => {
    const chosen = multi.chosen(cur);
    if (!chosen.length) return;
    if (ledgerId && data?.cfg && !data.cfg.cheque_printing) return toast('Bank not configured for Cheque Printing', 'err');
    try {
      const sheets = await Promise.all(chosen.map((c) => chequePrintData(books.db, c.alloc_id)));
      nav.push(<ChequeSheet data={sheets} />);
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  const alterBank = () => {
    if (ledgerId) nav.push(<BankConfigurationScreen ledgerId={ledgerId} />);
  };
  const open = (r?: (typeof rows)[number]) => r && nav.push(<VoucherOpener voucherId={r.voucher_id} />);
  const toggleInc = () => setIncPrinted((v) => !v);
  useScreen({
    title: 'Cheque Printing',
    keys: { ...keys, ...p.key, Space: () => cur && multi.toggle(cur), Enter: () => open(cur), F8: toggleInc, 'Ctrl+P': () => void printNow(), 'Alt+B': alterBank },
    buttons: [p.button, { key: 'F8', label: 'Inc Printed', run: toggleInc }, { key: 'Alt+B', label: 'Alter Ledger', run: alterBank, disabled: !ledgerId }, { key: 'Ctrl+P', label: 'Print', run: () => void printNow() }],
  });
  const notConfigured = ledgerId !== null && data?.cfg && !data.cfg.cheque_printing;
  return (
    <Frame title="Cheque Printing" subtitle={`${fmtDate(period.from)} to ${fmtDate(period.to)}`}>
      <div className="mb-1">
        Ledger <span className="mx-1">:</span>
        <b>{bank?.name ?? 'All Items'}</b>
      </div>
      <div className="mb-2 text-center italic">{notConfigured ? 'Bank not configured for Cheque Printing' : `(Cheque Printing - ${incPrinted ? 'All Cheques' : 'Pending Cheques'})`}</div>
      <table className="w-full">
        <thead>
          <tr className="text-left">
            <th className={th}>Date</th>
            <th className={th}>Particulars</th>
            <th className={`${th} text-right`}>Instrument No.</th>
            <th className={`${th} text-right`}>Instrument Date</th>
            <th className={`${th} text-center`}>Printed ?</th>
            <th className={`${th} text-right`}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.alloc_id} className={rowCls(i === sel, multi.has(r) ? 'italic' : '')} onMouseEnter={() => setSel(i)} onClick={() => multi.toggle(r)} onDoubleClick={() => open(r)}>
              <td className="px-2">{fmtDate(r.date)}</td>
              <td className="px-2 font-bold">{r.particulars}</td>
              <td className={num}>{r.inst_no}</td>
              <td className={num}>{fmtDate(r.inst_date)}</td>
              <td className="px-2 text-center font-bold">{r.printed ? 'Yes' : 'No'}</td>
              <td className={`${num} font-bold`}>{fmtAmount(r.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data && rows.length === 0 && <div className="py-3 text-tb-muted">No cheques pending for printing.</div>}
    </Frame>
  );
}

export interface BankAllocValues {
  inst_no: string;
  inst_date: string;
  favouring: string;
  pdc_issue_date: string;
  pdc_note: string;
}

export function BankAllocationScreen({ ledgerId, amount, date, postDated = false, initial, onDone }: {
  ledgerId: number;
  amount: number;
  date: string;
  postDated?: boolean;
  initial?: Partial<BankAllocValues>;
  onDone: (v: BankAllocValues) => void;
}) {
  const nav = useNav();
  const form = useRef<FormHandle>(null);
  const banks = useBanks();
  const name = banks.find((b) => b.id === ledgerId)?.name ?? '';
  const info = useBankLoad(async (db) => ({ books: await chequeBooks(db, ledgerId), next: await nextChequeNo(db, ledgerId) }), [ledgerId]);
  const accept = () => {
    const v = form.current?.submit();
    if (!v) return;
    onDone({ inst_no: String(v.inst_no ?? ''), inst_date: (v.inst_date as string) ?? '', favouring: String(v.favouring ?? ''), pdc_issue_date: (v.pdc_issue_date as string) ?? '', pdc_note: String(v.pdc_note ?? '') });
    nav.pop();
  };
  useScreen({ title: 'Bank Allocations', noPeriod: true, keys: { 'Ctrl+A': accept }, buttons: [{ key: 'Ctrl+A', label: 'Accept', run: accept }] });
  if (!info) return null;
  const instNo = initial?.inst_no ?? info.next?.inst_no ?? '';
  const book = info.books.find((b: ChequeBook) => inBook(b, instNo)) ?? info.next?.book ?? info.books[0];
  const fields: FieldDef[] = [
    { key: 'inst_no', label: 'Inst No.', kind: 'text', initial: instNo },
    { key: 'inst_date', label: 'Inst Date', kind: 'date', initial: initial?.inst_date || date },
    { key: 'favouring', label: 'Favouring Name', kind: 'text', initial: initial?.favouring },
    ...(postDated
      ? ([
          { key: 'pdc_issue_date', label: 'PDC issue date', kind: 'date', initial: initial?.pdc_issue_date || date },
          { key: 'pdc_note', label: 'PDC note', kind: 'text', initial: initial?.pdc_note },
        ] as FieldDef[])
      : []),
  ];
  return (
    <div className="mx-auto max-w-3xl border border-tb-line bg-tb-paper px-4 py-3">
      <div className="text-center">Bank Allocations for: <b>{name}</b></div>
      <div className="mb-3 text-center">For: <b>{fmtAmount(Math.abs(amount), false)}</b></div>
      <div className="flex justify-between border-y border-tb-ink px-1 font-bold">
        <span>Transaction Type</span>
        <span>Amount</span>
      </div>
      <div className="my-2 flex justify-between bg-[#ffe3b0] px-1">
        <span>Cheque</span>
        <span className="tabular-nums">{fmtAmount(Math.abs(amount), false)}</span>
      </div>
      <div className="mb-1 flex italic">
        <span style={{ width: 180 }}>Cheque range</span>
        <span className="mr-2">:</span>
        <b className="not-italic">{book ? `${padCheque(book.from_no, book.width)}-${padCheque(book.to_no, book.width)}` : ''}</b>
      </div>
      <Form ref={form} fields={fields} labelWidth={192} onDone={accept} />
    </div>
  );
}

export function PostDatedSummaryEntry() {
  return <BankSelector next={(id) => <PostDatedSummaryScreen ledgerId={id!} />} />;
}

export function PostDatedSummaryScreen({ ledgerId }: { ledgerId: number }) {
  const { company, period } = useStore();
  const nav = useNav();
  const p = usePeriodKey();
  const banks = useBanks();
  const name = banks.find((b) => b.id === ledgerId)?.name ?? '';
  const from = company?.fy_start ?? period.from;
  const to = period.to;
  const data = useBankLoad((db) => postDatedSummary(db, ledgerId, from, to), [ledgerId, from, to]);
  const rows = data?.rows ?? [];
  const { sel, setSel, keys } = useSel(rows.length);
  const open = (i: number) => {
    const r = rows[i];
    if (r) nav.push(<PostDatedTransactionsScreen ledgerId={ledgerId} from={r.from} to={r.to} />);
  };
  const monthName = (k: string) => {
    const [y, m] = k.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  };
  useScreen({ title: 'Post-Dated Transactions Monthly Summary', keys: { ...keys, ...p.key, Enter: () => open(sel) }, buttons: [p.button] });
  return (
    <Frame title="Post-Dated Transactions Monthly Summary" subtitle="">
      <div className="mb-2 text-center">
        <div className="italic">{name}</div>
        <div className="font-bold">{company?.name}</div>
        <div>{fmtDate(from)} to {fmtDate(to)}</div>
      </div>
      <table className="w-full">
        <thead>
          <tr>
            <th className={`${th} text-left tracking-[0.2em]`} rowSpan={2}>Particulars</th>
            <th className={`${th} text-center`} colSpan={2}>Received</th>
            <th className={`${th} text-center`} colSpan={2}>Issued</th>
          </tr>
          <tr>
            {['Amount', 'Count', 'Amount', 'Count'].map((h, i) => (
              <th key={i} className={`${th} text-right font-normal`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.key} className={rowCls(i === sel)} onMouseEnter={() => setSel(i)} onClick={() => open(i)}>
              <td className="px-2">{monthName(r.key)}</td>
              <td className={`${num} italic`}>{fmtAmount(r.received.amount)}</td>
              <td className={`${num} italic`}>{r.received.count || ''}</td>
              <td className={`${num} italic`}>{fmtAmount(r.issued.amount)}</td>
              <td className={`${num} italic`}>{r.issued.count || ''}</td>
            </tr>
          ))}
          {data && (
            <tr className="font-bold italic">
              <td className="border-y-[3px] border-double border-tb-ink px-2 tracking-[0.2em] not-italic">Grand Total</td>
              <td className={tot}>{fmtAmount(data.total.received.amount, false)}</td>
              <td className={tot}>{data.total.received.count}</td>
              <td className={tot}>{fmtAmount(data.total.issued.amount, false)}</td>
              <td className={tot}>{data.total.issued.count}</td>
            </tr>
          )}
        </tbody>
      </table>
    </Frame>
  );
}

export function PostDatedTransactionsScreen({ ledgerId, from, to }: { ledgerId: number; from: string; to: string }) {
  const { books, bump, toast } = useStore();
  const nav = useNav();
  const p = usePeriodKey();
  const flt = useFilter();
  const banks = useBanks();
  const [type, setType] = useState<'Received' | 'Issued' | undefined>(undefined);
  const [showAll, setShowAll] = useState(false);
  const name = banks.find((b) => b.id === ledgerId)?.name ?? '';
  const data = useBankLoad((db) => postDatedList(db, ledgerId, from, to, type, showAll), [ledgerId, from, to, type, showAll]);
  const rows = useMemo(() => (data ?? []).filter((r) => flt.match(r.particulars, r.inst_no, r.favouring, r.note)), [data, flt]);
  const { sel, setSel, keys } = useSel(rows.length);
  const multi = useMulti(rows, (r) => String(r.alloc_id));
  const cur: PostDatedRow | undefined = rows[sel];
  const view = () =>
    nav.push(
      <SelectList
        title="Change View"
        heading="List of Views"
        items={[{ id: '', label: 'Post-dated Transactions' }, { id: 'Issued', label: 'Post-dated Issued' }, { id: 'Received', label: 'Post-dated Received' }]}
        popOnSelect
        onSelect={(it) => setType(it.id ? (it.id as 'Issued' | 'Received') : undefined)}
      />
    );
  const alterBank = () => {
    const chosen = multi.chosen(cur);
    if (!chosen.length) return;
    pickBank(nav, banks, async (b) => {
      try {
        for (const c of chosen) await alterPostDatedBank(books.db, c.alloc_id, b.id);
        multi.clear();
        bump();
        toast('Bank changed', 'ok');
      } catch (e) {
        toast((e as Error).message, 'err');
      }
    });
  };
  const note = () => cur && nav.push(<PdcNoteScreen allocId={cur.alloc_id} initial={cur.note} />);
  const open = () => cur && nav.push(<VoucherOpener voucherId={cur.voucher_id} />);
  useScreen({
    title: 'Post-Dated Transactions',
    keys: { ...keys, ...p.key, ...flt.key, 'Alt+Q': flt.key['Ctrl+F'], Space: () => cur && multi.toggle(cur), Enter: open, F8: () => setShowAll((s) => !s), 'Ctrl+H': view, 'Alt+B': alterBank, 'Alt+R': note },
    buttons: [p.button, { key: 'F8', label: showAll ? 'Show Pending' : 'Show All', run: () => setShowAll((s) => !s) }, { key: 'Ctrl+H', label: 'Change View', run: view }, { key: 'Alt+Q', label: 'Quick Search', run: flt.button.run }, { key: 'Alt+B', label: 'Alter Bank', run: alterBank }, { key: 'Alt+R', label: 'Enter Note', run: note }],
  });
  const selTotal = rows.filter((r) => multi.has(r)).reduce((s, r) => s + r.amount, 0);
  return (
    <Frame title="Post-Dated Transactions" subtitle={`${fmtDate(from)} to ${fmtDate(to)}`}>
      {flt.bar}
      <LedgerLine name={name} />
      <table className="w-full">
        <thead>
          <tr className="text-left">
            <th className={th}>Date</th>
            <th className={th}>Type</th>
            <th className={th}>Particulars</th>
            <th className={th}>Instrument no.</th>
            <th className={th}>Instrument date</th>
            <th className={th}>Status</th>
            <th className={`${th} text-right`}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.alloc_id} className={rowCls(i === sel, multi.has(r) ? 'italic' : '')} onMouseEnter={() => setSel(i)} onClick={() => multi.toggle(r)} onDoubleClick={open}>
              <td className="px-2">{fmtDate(r.date)}</td>
              <td className="px-2">{r.type}</td>
              <td className="px-2 font-bold">{r.particulars}</td>
              <td className="px-2">{r.inst_no}</td>
              <td className="px-2">{fmtDate(r.inst_date)}</td>
              <td className="px-2">{r.status}</td>
              <td className={`${num} font-bold`}>{fmtDrCr(r.amount)}</td>
            </tr>
          ))}
          <tr className="font-bold">
            <td className="border-t border-tb-ink px-2 tracking-[0.2em]" colSpan={6}>Selected Total</td>
            <td className="border-t border-tb-ink px-2 text-right tabular-nums">{fmtDrCr(selTotal)}</td>
          </tr>
          <tr className="font-bold">
            <td className="px-2 tracking-[0.2em]" colSpan={6}>Grand Total</td>
            <td className="px-2 text-right tabular-nums">{fmtDrCr(rows.reduce((s, r) => s + r.amount, 0))}</td>
          </tr>
        </tbody>
      </table>
      {data && rows.length === 0 && <div className="py-3 text-tb-muted">No post-dated transactions.</div>}
    </Frame>
  );
}

function PdcNoteScreen({ allocId, initial }: { allocId: number; initial: string }) {
  const { books, bump, toast } = useStore();
  const nav = useNav();
  const form = useRef<FormHandle>(null);
  const save = async () => {
    const v = form.current?.submit();
    if (!v) return;
    try {
      await updatePdcNote(books.db, allocId, String(v.note ?? ''));
      bump();
      toast('PDC note saved', 'ok');
      nav.pop();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  useScreen({ title: 'PDC Note', noPeriod: true, keys: { 'Ctrl+A': () => void save() }, buttons: [{ key: 'Ctrl+A', label: 'Accept', run: () => void save() }] });
  return (
    <div className="max-w-xl">
      <Form ref={form} fields={[{ key: 'note', label: 'PDC note', kind: 'text', initial }]} labelWidth={160} onDone={() => void save()} />
    </div>
  );
}
