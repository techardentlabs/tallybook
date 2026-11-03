import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  autoReconcile,
  bankLedgers,
  bankingActivities,
  bankConfig,
  ensureBanking,
  fmtAmount,
  fmtDate,
  importedBankData,
  importStatementCsv,
  linkLine,
  openingBrs,
  parseDate,
  potentialMatches,
  reconciledTxns,
  reconSummary,
  saveOpeningBrs,
  setBankDates,
  setLineStatus,
  setReconStatus,
  statementLines,
  unlinkLines,
  unreconciledLines,
  unreconciledTxns,
  RECON_STATUSES,
  type BankLedger,
  type BankTxn,
  type Db,
  type StatementLine,
} from '@tallybook/core';
import { Form, type FieldDef, type FormHandle } from '../ui/Form.tsx';
import type { MenuItem } from '../ui/Menu.tsx';
import { useScreen, type Btn, type KeyHandler } from '../registry.ts';
import { useStore } from '../store.tsx';
import { useNav } from '../nav.tsx';
import { pickTextFile } from './bankingFiles.ts';
import { SelectList } from './SelectList.tsx';
import { Frame, th, rowCls, useLoad, usePeriodKey, useSel } from './Reports.tsx';
import { useFilter, useReportOptions } from './reportConfig.tsx';
import { ChequeRegisterScreen, ChequePrintingEntry, PostDatedSummaryEntry } from './BankingCheques.tsx';

const readyMap = new WeakMap<Db, Promise<void>>();

export function bankingReady(db: Db): Promise<void> {
  let p = readyMap.get(db);
  if (!p) {
    p = ensureBanking(db);
    readyMap.set(db, p);
  }
  return p;
}

export function useBankLoad<T>(fn: (db: Db) => Promise<T>, deps: unknown[]): T | null {
  const { books } = useStore();
  return useLoad(async () => {
    await bankingReady(books.db);
    return fn(books.db);
  }, deps);
}

export function useBanks(): BankLedger[] {
  return useBankLoad((db) => bankLedgers(db), []) ?? [];
}

export function BankSelector({ title = 'Select Bank', all, next }: { title?: string; all?: boolean; next: (ledgerId: number | null, name: string) => ReactNode }) {
  const nav = useNav();
  const banks = useBanks();
  const items = [...(all ? [{ id: 0, label: 'All Items' }] : []), ...banks.map((b) => ({ id: b.id, label: b.name, sub: b.account_no }))];
  return <SelectList title={title} heading="List of Banks" items={items} empty="No bank ledgers" onSelect={(it) => nav.replace(next(Number(it.id) || null, it.label))} />;
}

export function pickBank(nav: ReturnType<typeof useNav>, banks: BankLedger[], onSelect: (b: BankLedger) => void, all = false) {
  const items = [...(all ? [{ id: 0, label: 'All Items' }] : []), ...banks.map((b) => ({ id: b.id, label: b.name, sub: b.account_no }))];
  nav.push(<SelectList title="Select Bank" heading="List of Banks" items={items} popOnSelect empty="No bank ledgers" onSelect={(it) => onSelect(banks.find((b) => b.id === it.id) ?? ({ id: 0, name: 'All Items', account_no: '', opening: 0 } as BankLedger))} />);
}

export function BasisScreen({ title = 'Basis of Values', fields, onAccept }: { title?: string; fields: FieldDef[]; onAccept: (v: Record<string, unknown>) => void }) {
  const nav = useNav();
  const form = useRef<FormHandle>(null);
  const accept = () => {
    const v = form.current?.submit();
    if (!v) return;
    onAccept(v);
    nav.pop();
  };
  useScreen({ title, noPeriod: true, keys: { 'Ctrl+A': accept }, buttons: [{ key: 'Ctrl+A', label: 'Accept', run: accept }] });
  return (
    <div className="max-w-xl">
      <div className="mb-3 font-bold underline">{title}</div>
      <Form ref={form} fields={fields} labelWidth={280} onDone={accept} />
    </div>
  );
}

export function useMulti<T>(rows: T[], keyOf: (r: T) => string) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const toggle = (r: T) =>
    setPicked((s) => {
      const n = new Set(s);
      const k = keyOf(r);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const clear = () => setPicked(new Set());
  const chosen = (cursor: T | undefined) => (picked.size ? rows.filter((r) => picked.has(keyOf(r))) : cursor ? [cursor] : []);
  return { picked, toggle, clear, chosen, has: (r: T) => picked.has(keyOf(r)) };
}

const num = 'px-2 text-right tabular-nums';
const tot = 'border-y-[3px] border-double border-tb-ink px-2 text-right tabular-nums';
const blue = 'text-tb-muted';

function LedgerLine({ name, extra }: { name: string; extra?: ReactNode }) {
  return (
    <div className="mb-2 flex items-baseline justify-between">
      <span>
        Ledger <span className="mx-1">:</span>
        <b>{name}</b>
        {extra}
      </span>
    </div>
  );
}

function useBankName(ledgerId: number): string {
  const banks = useBanks();
  return banks.find((b) => b.id === ledgerId)?.name ?? '';
}

function useSwitchBank(make: (id: number) => ReactNode) {
  const nav = useNav();
  const banks = useBanks();
  const run = () => pickBank(nav, banks, (b) => nav.replace(make(b.id)));
  return { key: { F4: run } as Record<string, KeyHandler>, button: { key: 'F4', label: 'Bank Ledger', run } as Btn };
}

function usePostDatedBasis() {
  const nav = useNav();
  const [on, setOn] = useState(false);
  const run = () =>
    nav.push(<BasisScreen fields={[{ key: 'pd', label: 'Include Post-dated Vouchers', kind: 'toggle', initial: on }]} onAccept={(v) => setOn(!!v.pd)} />);
  return { on, key: { 'Ctrl+B': run } as Record<string, KeyHandler>, button: { key: 'Ctrl+B', label: 'Basis of Values', run } as Btn };
}

const ACT_DEFS = [
  { key: 'books', label: 'Show Balance as per Company Books', default: false },
  { key: 'bank', label: 'Show Balance as per Bank Statement', default: false },
  { key: 'hideZero', label: 'Exclude Bank Ledgers with zero Balance', default: false },
  { key: 'manual', label: 'Use Manual Reconciliation as the default mode', default: false },
];

export function BankingActivitiesScreen() {
  const { period, company } = useStore();
  const nav = useNav();
  const p = usePeriodKey();
  const cfg = useReportOptions('banking-activities', 'Banking Activities', ACT_DEFS);
  const flt = useFilter();
  const pd = usePostDatedBasis();
  const [amountView, setAmountView] = useState(false);
  const [only, setOnly] = useState<number | null>(null);
  const banks = useBanks();
  const data = useBankLoad((db) => bankingActivities(db, period.to, { includePostDated: pd.on }), [period.to, pd.on]);
  const rows = useMemo(
    () => (data ?? []).filter((r) => (only === null || r.ledger_id === only) && flt.match(r.name) && (!cfg.values.hideZero || r.books_balance || r.only_books.count || r.only_bank.count)),
    [data, only, flt, cfg.values.hideZero]
  );
  const { sel, setSel, keys } = useSel(rows.length);
  const open = (i: number) => {
    const r = rows[i];
    if (!r) return;
    nav.push(cfg.values.manual ? <ManualReconScreen ledgerId={r.ledger_id} /> : <BankReconSummaryScreen ledgerId={r.ledger_id} />);
  };
  const pickOne = () => pickBank(nav, banks, (b) => setOnly(b.id || null), true);
  const openingBrsKey = () => {
    const r = rows[sel];
    if (r) nav.push(<OpeningBrsScreen ledgerId={r.ledger_id} />);
  };
  const cell = (b: { count: number; amount: number }) => (amountView ? fmtAmount(b.amount) : b.count || '');
  const sum = (f: (r: NonNullable<typeof data>[number]) => number) => rows.reduce((s, r) => s + f(r), 0);
  useScreen({
    title: 'Banking Activities',
    keys: { ...keys, ...p.key, ...cfg.key, ...flt.key, ...pd.key, F4: pickOne, F5: () => setAmountView((v) => !v), 'Alt+H': openingBrsKey, Enter: () => open(sel) },
    buttons: [p.button, { key: 'F4', label: 'Bank Ledger', run: pickOne }, { key: 'F5', label: amountView ? 'Count View' : 'Amount View', run: () => setAmountView((v) => !v) }, pd.button, flt.button, { key: 'Alt+H', label: 'Opening BRS', run: openingBrsKey }, cfg.button],
  });
  const v = cfg.values;
  return (
    <Frame title="Banking Activities" subtitle={`as at ${fmtDate(period.to)}`}>
      {flt.bar}
      <table className="w-full">
        <thead>
          <tr>
            <th className={`${th} text-left tracking-[0.2em]`} rowSpan={2}>Particulars</th>
            {v.books && <th className={`${th} text-right`} rowSpan={2}>Balance as per Company Books</th>}
            {v.bank && <th className={`${th} text-right`} rowSpan={2}>Balance as per Bank Statement</th>}
            <th className={`${th} text-center`} colSpan={2}>
              Bank Reconciliation
              <div className="text-xs font-normal">From {fmtDate(company?.fy_start ?? period.from)}</div>
            </th>
          </tr>
          <tr>
            <th className={`${th} text-right`}>Available Only in Books</th>
            <th className={`${th} text-right`}>Available Only in Bank</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.ledger_id} className={rowCls(i === sel)} onMouseEnter={() => setSel(i)} onClick={() => open(i)}>
              <td className="px-2">{r.name}{r.account_no ? ` - ${r.account_no}` : ''}</td>
              {v.books && <td className={num}>{fmtAmount(r.books_balance)}</td>}
              {v.bank && <td className={num}>{fmtAmount(r.bank_balance)}</td>}
              <td className={num}>{cell(r.only_books)}</td>
              <td className={num}>{cell(r.only_bank)}</td>
            </tr>
          ))}
          {data && (
            <tr className="font-bold">
              <td className="border-y-[3px] border-double border-tb-ink px-2 tracking-[0.2em]">Grand Total</td>
              {v.books && <td className={tot}>{fmtAmount(sum((r) => r.books_balance))}</td>}
              {v.bank && <td className={tot}>{fmtAmount(sum((r) => r.bank_balance))}</td>}
              <td className={tot}>{amountView ? fmtAmount(sum((r) => r.only_books.amount)) : sum((r) => r.only_books.count)}</td>
              <td className={tot}>{amountView ? fmtAmount(sum((r) => r.only_bank.amount)) : sum((r) => r.only_bank.count)}</td>
            </tr>
          )}
        </tbody>
      </table>
      {data && rows.length === 0 && <div className="py-3 text-tb-muted">No bank ledgers.</div>}
    </Frame>
  );
}

const SUM_DEFS = [
  { key: 'bankBalance', label: 'Show Balance as per Bank Statement', default: true },
  { key: 'previous', label: 'Show Unreconciled Transactions from Previous Period', default: true },
];

export function BankReconSummaryScreen({ ledgerId }: { ledgerId: number }) {
  const { period, company } = useStore();
  const nav = useNav();
  const p = usePeriodKey();
  const cfg = useReportOptions('bank-recon-summary', 'Bank Reconciliation Summary', SUM_DEFS);
  const pd = usePostDatedBasis();
  const sw = useSwitchBank((id) => <BankReconSummaryScreen ledgerId={id} />);
  const name = useBankName(ledgerId);
  const data = useBankLoad((db) => reconSummary(db, ledgerId, period.to, { includePostDated: pd.on }), [ledgerId, period.to, pd.on]);
  const toRecon = () => nav.push(<BankReconciliationScreen ledgerId={ledgerId} />);
  const viewReconciled = () => nav.push(<ReconciledMonthlyScreen ledgerId={ledgerId} />);
  const manual = () => nav.push(<ManualReconScreen ledgerId={ledgerId} />);
  const changeView = () =>
    nav.push(
      <SelectList
        title="Change View"
        heading="List of Views"
        items={[{ id: 'dw', label: 'Deposits & Withdrawals - Unreconciled' }, { id: 'vr', label: 'View Reconciled' }, { id: 'ob', label: 'Opening BRS' }]}
        popOnSelect
        onSelect={(it) => (it.id === 'vr' ? viewReconciled() : it.id === 'ob' ? nav.push(<OpeningBrsScreen ledgerId={ledgerId} />) : toRecon())}
      />
    );
  useScreen({
    title: 'Bank Reconciliation Summary',
    keys: { ...p.key, ...cfg.key, ...pd.key, ...sw.key, Enter: toRecon, F5: viewReconciled, 'Ctrl+H': changeView, 'Alt+R': manual },
    buttons: [p.button, sw.button, { key: 'F5', label: 'View Reconciled', run: viewReconciled }, pd.button, { key: 'Ctrl+H', label: 'Change View', run: changeView }, { key: 'Alt+R', label: 'Manual Recon', run: manual }, cfg.button],
  });
  const d = data;
  const from = d?.recon_from || company?.fy_start || period.from;
  const row = (label: string, indent: number, count: number | string, amt: number, bold = false, sel = false, top = false) => (
    <tr className={`${bold ? 'font-bold' : ''} ${sel ? 'cursor-pointer bg-tb-sel text-tb-sel-ink' : ''} ${top ? 'border-t border-tb-ink' : ''}`} onClick={sel ? toRecon : undefined}>
      <td className="px-2" style={{ paddingLeft: 8 + indent * 16 }}>{label}</td>
      <td className={num}>{count}</td>
      <td className={num}>{fmtAmount(amt, false)}</td>
    </tr>
  );
  return (
    <Frame title="Bank Reconciliation Summary" subtitle={`as at ${fmtDate(period.to)}`}>
      <LedgerLine name={name} />
      <table className="w-full">
        <thead>
          <tr>
            <th className={`${th} text-left tracking-[0.2em]`}>Particulars</th>
            <th className={`${th} text-right`}>Count</th>
            <th className={`${th} text-right`}>Balance</th>
          </tr>
        </thead>
        {d && (
          <tbody>
            <tr><td colSpan={3}>&nbsp;</td></tr>
            {row('Balance as per Company Books', 0, '', d.books_balance, true)}
            {row(`Unreconciled Transactions from ${fmtDate(from)} till date`, 1, d.unreconciled_count, d.unreconciled_amount, true, true)}
            {row('Available Only in Books', 2, '', 0, true)}
            {row('Add: Withdrawals', 3, d.books_withdrawals.count, d.books_withdrawals.amount)}
            {row('Less: Deposits', 3, d.books_deposits.count, d.books_deposits.amount)}
            {row('Available Only in Bank', 2, '', 0, true)}
            {row('Add: Deposits', 3, d.bank_deposits.count, d.bank_deposits.amount)}
            {row('Less: Withdrawals', 3, d.bank_withdrawals.count, d.bank_withdrawals.amount)}
            {(d.subsequent.withdrawals.count > 0 || d.subsequent.deposits.count > 0) && (
              <>
                {row('Reconciled in Subsequent Period', 2, '', 0, true)}
                {row('Add: Withdrawals', 3, d.subsequent.withdrawals.count, d.subsequent.withdrawals.amount)}
                {row('Less: Deposits', 3, d.subsequent.deposits.count, d.subsequent.deposits.amount)}
              </>
            )}
            {row('Expected Bank Balance', 0, '', d.expected_balance, true, false, true)}
            {cfg.values.bankBalance && row(d.bank_balance_date && d.bank_balance_date < period.to ? `Balance as per Bank Statement as of ${fmtDate(d.bank_balance_date)}` : 'Balance as per Bank Statement', 0, '', d.bank_balance, true)}
            {cfg.values.bankBalance && row('Difference', 0, '', d.difference, true, false, true)}
          </tbody>
        )}
      </table>
    </Frame>
  );
}

const REC_DEFS = [{ key: 'vchNo', label: 'Show Voucher Number', default: false }];

type Item = { kind: 'book'; t: BankTxn } | { kind: 'bank'; l: StatementLine };

export function BankReconciliationScreen({ ledgerId }: { ledgerId: number }) {
  const { period, books, bump, toast } = useStore();
  const nav = useNav();
  const p = usePeriodKey();
  const cfg = useReportOptions('bank-reconciliation', 'Bank Reconciliation', REC_DEFS);
  const flt = useFilter();
  const pd = usePostDatedBasis();
  const sw = useSwitchBank((id) => <BankReconciliationScreen ledgerId={id} />);
  const name = useBankName(ledgerId);
  const data = useBankLoad(
    async (db) => ({ txns: await unreconciledTxns(db, ledgerId, period.to, { includePostDated: pd.on }), lines: await unreconciledLines(db, ledgerId, period.to) }),
    [ledgerId, period.to, pd.on]
  );
  const items = useMemo<Item[]>(
    () => [
      ...(data?.txns ?? []).filter((t) => flt.match(t.particulars, t.inst_no, t.vch_type)).map((t) => ({ kind: 'book', t }) as Item),
      ...(data?.lines ?? []).filter((l) => flt.match(l.narration, l.inst_no)).map((l) => ({ kind: 'bank', l }) as Item),
    ],
    [data, flt]
  );
  const keyOf = (it: Item) => (it.kind === 'book' ? it.t.ref : `b:${it.l.id}`);
  const { sel, setSel, keys } = useSel(items.length);
  const multi = useMulti(items, keyOf);
  const books_ = items.filter((i): i is Extract<Item, { kind: 'book' }> => i.kind === 'book');
  const bank_ = items.filter((i): i is Extract<Item, { kind: 'bank' }> => i.kind === 'bank');
  const cur = items[sel];

  const doLink = async (lineId: number, ref: string) => {
    try {
      await linkLine(books.db, ledgerId, lineId, ref);
      multi.clear();
      bump();
      toast('Transaction reconciled', 'ok');
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  const reconcile = async () => {
    if (!cur) return;
    if (cur.kind === 'book') {
      const net = cur.t.deposit - cur.t.withdrawal;
      const cands = (data?.lines ?? []).filter((l) => l.deposit - l.withdrawal === net);
      if (!cands.length) return toast('No matching bank entry found', 'err');
      const exact = cands.filter((l) => l.inst_no && l.inst_no === cur.t.inst_no);
      if (exact.length === 1) return void doLink(exact[0].id, cur.t.ref);
      nav.push(
        <SelectList
          title="Reconcile"
          heading="List of Bank Entries"
          items={cands.map((l) => ({ id: l.id, label: `${fmtDate(l.date)}  ${l.narration}`, sub: fmtAmount(l.deposit || l.withdrawal) }))}
          popOnSelect
          onSelect={(it) => void doLink(Number(it.id), cur.t.ref)}
        />
      );
    } else {
      const matches = await potentialMatches(books.db, ledgerId, cur.l.id, period.to);
      if (!matches.length) return toast('No matching transaction found in books', 'err');
      const exact = matches.filter((t) => cur.l.inst_no && t.inst_no === cur.l.inst_no);
      if (exact.length === 1) return void doLink(cur.l.id, exact[0].ref);
      nav.push(
        <SelectList
          title="Reconcile"
          heading="List of Transactions"
          items={matches.map((t) => ({ id: t.ref, label: `${fmtDate(t.date)}  ${t.particulars}`, sub: fmtAmount(t.deposit || t.withdrawal) }))}
          popOnSelect
          onSelect={(it) => void doLink((cur as Extract<Item, { kind: 'bank' }>).l.id, String(it.id))}
        />
      );
    }
  };
  const setStatus = () => {
    const chosen = multi.chosen(cur);
    if (!chosen.length) return;
    nav.push(
      <SelectList
        title="Set Status"
        heading="List of Statuses"
        items={RECON_STATUSES.filter((s) => s !== 'Reconciled').map((s) => ({ id: s, label: s }))}
        popOnSelect
        onSelect={async (it) => {
          try {
            const refs = chosen.filter((c) => c.kind === 'book').map((c) => (c as Extract<Item, { kind: 'book' }>).t.ref);
            const ids = chosen.filter((c) => c.kind === 'bank').map((c) => (c as Extract<Item, { kind: 'bank' }>).l.id);
            if (refs.length) await setReconStatus(books.db, ledgerId, refs, String(it.id));
            if (ids.length) await setLineStatus(books.db, ids, String(it.id));
            multi.clear();
            bump();
            toast('Status updated', 'ok');
          } catch (e) {
            toast((e as Error).message, 'err');
          }
        }}
      />
    );
  };
  const manual = () => nav.push(<ManualReconScreen ledgerId={ledgerId} />);
  const potential = () => void reconcile();
  useScreen({
    title: 'Bank Reconciliation',
    keys: { ...keys, ...p.key, ...cfg.key, ...flt.key, ...pd.key, ...sw.key, Space: () => cur && multi.toggle(cur), F8: () => void reconcile(), 'Alt+S': potential, F9: setStatus, 'Alt+R': manual },
    buttons: [
      p.button,
      sw.button,
      { key: 'F7', label: 'Create Vch/Multi-Vch', disabled: true },
      { key: 'F8', label: 'Reconcile', run: () => void reconcile() },
      { key: 'F9', label: 'Set Status', run: setStatus },
      pd.button,
      flt.button,
      { key: 'Alt+R', label: 'Manual Recon', run: manual },
      { key: 'Alt+S', label: 'Potential Matches', run: potential },
      cfg.button,
    ],
  });
  const dep = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
  const selDep = dep(items.filter((i) => multi.has(i)).map((i) => (i.kind === 'book' ? i.t.deposit : i.l.deposit)));
  const selWd = dep(items.filter((i) => multi.has(i)).map((i) => (i.kind === 'book' ? i.t.withdrawal : i.l.withdrawal)));
  const vch = cfg.values.vchNo;
  const rowOf = (it: Item, i: number) => {
    const isBook = it.kind === 'book';
    const date = isBook ? it.t.date : it.l.date;
    const part = isBook ? it.t.particulars : it.l.narration;
    const inst = isBook ? it.t.inst_no : it.l.inst_no;
    const idate = isBook ? it.t.inst_date : it.l.date;
    return (
      <tr key={keyOf(it)} className={rowCls(i === sel, `${isBook ? '' : blue} ${multi.has(it) ? 'font-bold' : ''}`)} onMouseEnter={() => setSel(i)} onClick={() => multi.toggle(it)} onDoubleClick={() => void reconcile()}>
        <td className="px-2">{fmtDate(date)}</td>
        <td className={`px-2 ${isBook ? 'font-bold' : ''}`}>{part}</td>
        {vch && <td className="px-2">{isBook ? it.t.vch_no : ''}</td>}
        <td className="px-2">{isBook ? it.t.vch_type : ''}</td>
        <td className="px-2">{inst}</td>
        <td className="px-2">{fmtDate(idate)}</td>
        <td className={num}>{fmtAmount(isBook ? it.t.deposit : it.l.deposit)}</td>
        <td className={num}>{fmtAmount(isBook ? it.t.withdrawal : it.l.withdrawal)}</td>
      </tr>
    );
  };
  const head = (label: string, n: number, d: number, w: number) => (
    <tr className="bg-tb-sel font-bold text-tb-sel-ink">
      <td className="px-2" colSpan={vch ? 6 : 5}>{label} ({n})</td>
      <td className={num}>{fmtAmount(d)}</td>
      <td className={num}>{fmtAmount(w)}</td>
    </tr>
  );
  return (
    <Frame title="Bank Reconciliation" subtitle={`${fmtDate(period.from)} to ${fmtDate(period.to)}`}>
      {flt.bar}
      <LedgerLine name={name} />
      <table className="w-full">
        <thead>
          <tr className="text-left">
            <th className={th}>Date</th>
            <th className={th}>Particulars</th>
            {vch && <th className={th}>Vch No.</th>}
            <th className={th}>Vch Type</th>
            <th className={th}>Inst No.</th>
            <th className={th}>Inst Date</th>
            <th className={`${th} text-right`}>Deposit</th>
            <th className={`${th} text-right`}>Withdrawal</th>
          </tr>
        </thead>
        <tbody>
          {data && head('Available Only in Books', books_.length, dep(books_.map((b) => b.t.deposit)), dep(books_.map((b) => b.t.withdrawal)))}
          {items.map((it, i) => (it.kind === 'book' ? rowOf(it, i) : null))}
          {data && head('Available Only in Bank', bank_.length, dep(bank_.map((b) => b.l.deposit)), dep(bank_.map((b) => b.l.withdrawal)))}
          {items.map((it, i) => (it.kind === 'bank' ? rowOf(it, i) : null))}
          <tr className="font-bold">
            <td className="border-t border-tb-ink px-2 tracking-[0.2em]" colSpan={vch ? 6 : 5}>Selected Total</td>
            <td className="border-t border-tb-ink px-2 text-right tabular-nums">{fmtAmount(selDep)}</td>
            <td className="border-t border-tb-ink px-2 text-right tabular-nums">{fmtAmount(selWd)}</td>
          </tr>
        </tbody>
      </table>
      {data && items.length === 0 && <div className="py-3 text-tb-muted">All transactions are reconciled.</div>}
    </Frame>
  );
}

const TYPE_VIEWS = [
  { id: 'both', label: 'Deposits & Withdrawals' },
  { id: 'deposits', label: 'Deposits' },
  { id: 'withdrawals', label: 'Withdrawals' },
];

export function ManualReconScreen({ ledgerId }: { ledgerId: number }) {
  const { period, company, books, bump, toast } = useStore();
  const nav = useNav();
  const p = usePeriodKey();
  const cfg = useReportOptions('bank-recon-manual', 'Bank Reconciliation (Manual)', REC_DEFS);
  const pd = usePostDatedBasis();
  const sw = useSwitchBank((id) => <ManualReconScreen ledgerId={id} />);
  const name = useBankName(ledgerId);
  const [kind, setKind] = useState<'both' | 'deposits' | 'withdrawals'>('both');
  const [status, setStatus] = useState('');
  const [showReconciled, setShowReconciled] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  const data = useBankLoad(
    async (db) => ({
      rows: showReconciled
        ? await reconciledTxns(db, ledgerId, period.from, period.to, { includePostDated: pd.on, kind, status: status || undefined })
        : await unreconciledTxns(db, ledgerId, period.to, { includePostDated: pd.on, kind, status: status || undefined }),
      sum: await reconSummary(db, ledgerId, period.to, { includePostDated: pd.on }),
    }),
    [ledgerId, period, pd.on, kind, status, showReconciled]
  );
  const rows = data?.rows ?? [];
  const { sel, setSel, keys } = useSel(rows.length);
  useEffect(() => {
    inputs.current[sel]?.focus();
  }, [sel, rows.length]);
  const parsed = (r: BankTxn): string | null => parseDate(edits[r.ref] ?? '', company?.fy_start, r.inst_date);
  const accept = async () => {
    const items: { ref: string; bank_date: string | null }[] = [];
    for (const r of rows) {
      const t = edits[r.ref];
      if (t === undefined) continue;
      if (!t.trim()) {
        if (r.bank_date) items.push({ ref: r.ref, bank_date: null });
        continue;
      }
      const iso = parsed(r);
      if (!iso) return toast(`Bank Date: invalid date for ${r.particulars}`, 'err');
      if (iso !== r.bank_date) items.push({ ref: r.ref, bank_date: iso });
    }
    if (!items.length) return nav.pop();
    try {
      await setBankDates(books.db, ledgerId, items);
      bump();
      toast(`${items.length} transaction${items.length > 1 ? 's' : ''} updated`, 'ok');
      setEdits({});
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  const updateBankDate = () => {
    const r = rows[sel];
    if (r) setEdits((s) => ({ ...s, [r.ref]: fmtDate(r.inst_date) }));
  };
  const basis = () =>
    nav.push(
      <SelectList title="Type of Transactions" heading="List of Views" items={TYPE_VIEWS} popOnSelect onSelect={(it) => setKind(it.id as typeof kind)} />
    );
  const statusPick = () =>
    nav.push(
      <SelectList
        title="Show transactions with Payment Status as"
        heading="List of Statuses"
        items={[{ id: '', label: 'All Statuses' }, ...RECON_STATUSES.map((s) => ({ id: s, label: s }))]}
        popOnSelect
        onSelect={(it) => setStatus(String(it.id))}
      />
    );
  const changeView = () => setShowReconciled((v) => !v);
  const next = (d: 1 | -1) => setSel((s) => Math.max(0, Math.min(rows.length - 1, s + d)));
  useScreen({
    title: 'Bank Reconciliation (Manual)',
    keys: {
      ...keys,
      ...p.key,
      ...cfg.key,
      ...sw.key,
      ArrowDown: () => next(1),
      ArrowUp: () => next(-1),
      Enter: () => next(1),
      'Ctrl+A': () => void accept(),
      F9: updateBankDate,
      'Ctrl+B': basis,
      'Ctrl+S': statusPick,
      'Ctrl+H': changeView,
      'Alt+H': () => nav.push(<OpeningBrsScreen ledgerId={ledgerId} />),
    },
    buttons: [
      p.button,
      sw.button,
      { key: 'F9', label: 'Update Bank Date', run: updateBankDate },
      { key: 'Ctrl+B', label: 'Basis of Values', run: basis },
      { key: 'Ctrl+S', label: 'Payment Status', run: statusPick },
      { key: 'Ctrl+H', label: showReconciled ? 'View Unreconciled' : 'View Reconciled', run: changeView },
      { key: 'Alt+H', label: 'Opening BRS', run: () => nav.push(<OpeningBrsScreen ledgerId={ledgerId} />) },
      { key: 'Ctrl+A', label: 'Accept', run: () => void accept() },
      cfg.button,
    ],
  });
  const vch = cfg.values.vchNo;
  const s = data?.sum;
  const sumDep = (f: (r: BankTxn) => number) => rows.reduce((a, r) => a + f(r), 0);
  const foot = (label: string, d: number | null, w: number | null, bold = false) => (
    <tr className={bold ? 'font-bold' : ''}>
      <td className="px-2 text-right" colSpan={vch ? 6 : 5}>{label} :</td>
      <td className={num}>{d === null ? '' : fmtAmount(d, false)}</td>
      <td className={num}>{w === null ? '' : fmtAmount(w, false)}</td>
      <td className="px-2" />
    </tr>
  );
  return (
    <Frame title="Bank Reconciliation (Manual)" subtitle={`${fmtDate(period.from)} to ${fmtDate(period.to)}`}>
      <LedgerLine name={name} />
      <table className="w-full">
        <thead>
          <tr className="text-left">
            <th className={th}>Date</th>
            <th className={th}>Particulars</th>
            {vch && <th className={th}>Vch No.</th>}
            <th className={th}>Vch Type</th>
            <th className={th}>Instrument No.</th>
            <th className={th}>Instrument Date</th>
            <th className={`${th} italic`}>Bank Date</th>
            <th className={`${th} text-right`}>Deposit</th>
            <th className={`${th} text-right`}>Withdrawal</th>
          </tr>
        </thead>
        <tbody>
          <tr className="font-bold"><td className="px-2" colSpan={vch ? 9 : 8}>{showReconciled ? 'Reconciled' : 'Available Only in Books'}</td></tr>
          {rows.map((r, i) => {
            const text = edits[r.ref] ?? (r.bank_date ? fmtDate(r.bank_date) : '');
            return (
              <tr key={r.ref} className={rowCls(i === sel)} onMouseEnter={() => setSel(i)}>
                <td className="px-2">{fmtDate(r.date)}</td>
                <td className="px-2 font-bold">{r.particulars}</td>
                {vch && <td className="px-2">{r.vch_no}</td>}
                <td className="px-2">{r.vch_type}</td>
                <td className="px-2">{r.inst_no}</td>
                <td className="px-2">{fmtDate(r.inst_date)}</td>
                <td className="px-1">
                  <input
                    ref={(el) => {
                      inputs.current[i] = el;
                    }}
                    className={`tb-input w-28 ${i === sel ? 'bg-[#ffe3b0]' : ''}`}
                    value={text}
                    onFocus={() => setSel(i)}
                    onChange={(e) => setEdits((st) => ({ ...st, [r.ref]: e.target.value }))}
                    onBlur={() => {
                      const t = edits[r.ref];
                      if (t && t.trim()) {
                        const iso = parsed(r);
                        if (iso) setEdits((st) => ({ ...st, [r.ref]: fmtDate(iso) }));
                      }
                    }}
                  />
                </td>
                <td className={num}>{fmtAmount(r.deposit)}</td>
                <td className={num}>{fmtAmount(r.withdrawal)}</td>
              </tr>
            );
          })}
        </tbody>
        {s && (
          <tfoot>
            <tr><td colSpan={vch ? 9 : 8} className="border-t border-tb-ink" /></tr>
            {foot('Balance as per Company Books', s.books_balance, null)}
            {foot('Available Only in Books', s.books_deposits.amount, s.books_withdrawals.amount)}
            {foot('Available Only in Bank', s.bank_deposits.amount, s.bank_withdrawals.amount)}
            {foot(`Expected Bank Balance as of ${fmtDate(period.to)}`, s.expected_balance, null, true)}
            {foot('Balance as per Bank Statement', s.bank_balance, null, true)}
            {foot('Difference', s.difference, null)}
            <tr><td className="px-2 text-right text-xs text-tb-muted" colSpan={vch ? 9 : 8}>Listed: {fmtAmount(sumDep((r) => r.deposit))} deposits, {fmtAmount(sumDep((r) => r.withdrawal))} withdrawals</td></tr>
          </tfoot>
        )}
      </table>
    </Frame>
  );
}

export function ReconciledMonthlyScreen({ ledgerId }: { ledgerId: number }) {
  const { period } = useStore();
  const nav = useNav();
  const p = usePeriodKey();
  const name = useBankName(ledgerId);
  const data = useBankLoad((db) => reconciledTxns(db, ledgerId, period.from, period.to), [ledgerId, period]);
  const months = useMemo(() => {
    const m = new Map<string, BankTxn[]>();
    for (const t of data ?? []) m.set(t.bank_date.slice(0, 7), [...(m.get(t.bank_date.slice(0, 7)) ?? []), t]);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [data]);
  const { sel, setSel, keys } = useSel(months.length);
  const open = (i: number) => {
    const m = months[i];
    if (!m) return;
    const [y, mo] = m[0].split('-').map(Number);
    const to = `${m[0]}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, '0')}`;
    nav.push(<ReconciledListScreen ledgerId={ledgerId} from={`${m[0]}-01`} to={to} />);
  };
  useScreen({ title: 'Reconciled Transactions - Monthly Summary', keys: { ...keys, ...p.key, Enter: () => open(sel) }, buttons: [p.button] });
  const monthName = (k: string) => {
    const [y, mo] = k.split('-').map(Number);
    return `${new Date(Date.UTC(y, mo - 1, 1)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })} ${y}`;
  };
  return (
    <Frame title="Reconciled Transactions - Monthly Summary">
      <LedgerLine name={name} />
      <table className="w-full">
        <thead>
          <tr>
            <th className={`${th} text-left tracking-[0.2em]`}>Particulars</th>
            <th className={`${th} text-right`}>Count</th>
            <th className={`${th} text-right`}>Deposit</th>
            <th className={`${th} text-right`}>Withdrawal</th>
          </tr>
        </thead>
        <tbody>
          {months.map(([k, ts], i) => (
            <tr key={k} className={rowCls(i === sel)} onMouseEnter={() => setSel(i)} onClick={() => open(i)}>
              <td className="px-2">{monthName(k)}</td>
              <td className={num}>{ts.length}</td>
              <td className={num}>{fmtAmount(ts.reduce((s, t) => s + t.deposit, 0))}</td>
              <td className={num}>{fmtAmount(ts.reduce((s, t) => s + t.withdrawal, 0))}</td>
            </tr>
          ))}
          {data && (
            <tr className="font-bold">
              <td className="border-y-[3px] border-double border-tb-ink px-2 tracking-[0.2em]">Grand Total</td>
              <td className={tot}>{data.length}</td>
              <td className={tot}>{fmtAmount(data.reduce((s, t) => s + t.deposit, 0), false)}</td>
              <td className={tot}>{fmtAmount(data.reduce((s, t) => s + t.withdrawal, 0), false)}</td>
            </tr>
          )}
        </tbody>
      </table>
      {data && months.length === 0 && <div className="py-3 text-tb-muted">No reconciled transactions in this period.</div>}
    </Frame>
  );
}

export function ReconciledListScreen({ ledgerId, from, to }: { ledgerId: number; from: string; to: string }) {
  const { books, bump, toast } = useStore();
  const nav = useNav();
  const name = useBankName(ledgerId);
  const data = useBankLoad(async (db) => ({ txns: await reconciledTxns(db, ledgerId, from, to), lines: await statementLines(db, ledgerId) }), [ledgerId, from, to]);
  const rows = data?.txns ?? [];
  const lineOf = (t: BankTxn) => data?.lines.find((l) => l.id === t.line_id);
  const { sel, setSel, keys } = useSel(rows.length);
  const multi = useMulti(rows, (r) => r.ref);
  const cur = rows[sel];
  const unlink = async () => {
    const chosen = multi.chosen(cur).filter((r) => r.line_id);
    if (!chosen.length) return toast('Select transactions reconciled via linking', 'err');
    try {
      await unlinkLines(books.db, ledgerId, chosen.map((r) => r.line_id!));
      multi.clear();
      bump();
      toast('Transactions unlinked', 'ok');
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  const modify = async () => {
    if (!cur?.line_id) return toast('Only linked transactions can be modified', 'err');
    const lineId = cur.line_id;
    const matches = (await potentialMatches(books.db, ledgerId, lineId, '9999-12-31')).filter((t) => t.ref !== cur.ref);
    if (!matches.length) return toast('No other matching transaction found', 'err');
    nav.push(
      <SelectList
        title="Modify Match"
        heading="List of Transactions"
        items={matches.map((t) => ({ id: t.ref, label: `${fmtDate(t.date)}  ${t.particulars}`, sub: fmtAmount(t.deposit || t.withdrawal) }))}
        popOnSelect
        onSelect={async (it) => {
          try {
            await unlinkLines(books.db, ledgerId, [lineId]);
            await linkLine(books.db, ledgerId, lineId, String(it.id));
            bump();
            toast('Match modified', 'ok');
          } catch (e) {
            toast((e as Error).message, 'err');
          }
        }}
      />
    );
  };
  const setStatus = () => {
    const chosen = multi.chosen(cur);
    if (!chosen.length) return;
    nav.push(
      <SelectList
        title="Set Status"
        heading="List of Statuses"
        items={RECON_STATUSES.map((s) => ({ id: s, label: s }))}
        popOnSelect
        onSelect={async (it) => {
          try {
            await setReconStatus(books.db, ledgerId, chosen.map((c) => c.ref), String(it.id));
            multi.clear();
            bump();
            toast('Status updated', 'ok');
          } catch (e) {
            toast((e as Error).message, 'err');
          }
        }}
      />
    );
  };
  useScreen({
    title: 'Bank Reconciliation - Reconciled',
    keys: { ...keys, Space: () => cur && multi.toggle(cur), F8: () => void modify(), 'Alt+F8': () => void unlink(), F9: setStatus },
    buttons: [{ key: 'F8', label: 'Modify Match', run: () => void modify() }, { key: 'Alt+F8', label: 'Unlink', run: () => void unlink() }, { key: 'F9', label: 'Set Status', run: setStatus }],
  });
  const groups: [string, BankTxn[]][] = [
    ['Reconciled via Linking', rows.filter((r) => r.link === 'linked')],
    ['Manually Reconciled', rows.filter((r) => r.link === 'manual')],
  ];
  return (
    <Frame title="Bank Reconciliation - Reconciled" subtitle={`${fmtDate(from)} to ${fmtDate(to)}`}>
      <LedgerLine name={name} />
      <table className="w-full">
        <thead>
          <tr className="text-left">
            <th className={th}>Date</th>
            <th className={th}>Particulars</th>
            <th className={th}>Inst No.</th>
            <th className={th}>Inst Date</th>
            <th className={th}>Bank Date</th>
            <th className={`${th} text-right`}>Deposit</th>
            <th className={`${th} text-right`}>Withdrawal</th>
          </tr>
        </thead>
        <tbody>
          {groups.map(([label, list]) =>
            list.length ? (
              <FragmentRows key={label} label={label}>
                {list.map((r) => {
                  const i = rows.indexOf(r);
                  const l = lineOf(r);
                  return (
                    <FragmentRows key={r.ref}>
                      <tr className={rowCls(i === sel, multi.has(r) ? 'font-bold' : '')} onMouseEnter={() => setSel(i)} onClick={() => multi.toggle(r)}>
                        <td className="px-2">{fmtDate(r.date)}</td>
                        <td className="px-2 font-bold">{r.particulars}</td>
                        <td className="px-2">{r.inst_no}</td>
                        <td className="px-2">{fmtDate(r.inst_date)}</td>
                        <td className="px-2">{fmtDate(r.bank_date)}</td>
                        <td className={num}>{fmtAmount(r.deposit)}</td>
                        <td className={num}>{fmtAmount(r.withdrawal)}</td>
                      </tr>
                      {l && (
                        <tr className={blue}>
                          <td className="px-2">{fmtDate(l.date)}</td>
                          <td className="px-2" colSpan={2}>{l.narration}</td>
                          <td className="px-2" />
                          <td className="px-2" />
                          <td className={num}>{fmtAmount(l.deposit)}</td>
                          <td className={num}>{fmtAmount(l.withdrawal)}</td>
                        </tr>
                      )}
                    </FragmentRows>
                  );
                })}
              </FragmentRows>
            ) : null
          )}
          <tr className="font-bold">
            <td className="border-t border-tb-ink px-2 tracking-[0.2em]" colSpan={5}>Selected Total</td>
            <td className="border-t border-tb-ink px-2 text-right tabular-nums">{fmtAmount(rows.filter((r) => multi.has(r)).reduce((s, r) => s + r.deposit, 0))}</td>
            <td className="border-t border-tb-ink px-2 text-right tabular-nums">{fmtAmount(rows.filter((r) => multi.has(r)).reduce((s, r) => s + r.withdrawal, 0))}</td>
          </tr>
        </tbody>
      </table>
    </Frame>
  );
}

function FragmentRows({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <>
      {label && (
        <tr className="bg-tb-sel font-bold text-tb-sel-ink">
          <td className="px-2" colSpan={7}>{label}</td>
        </tr>
      )}
      {children}
    </>
  );
}

type View = 'daily' | 'monthly' | 'quarterly';

export function ImportedBankDataScreen({ ledgerId }: { ledgerId: number }) {
  const { period, bump } = useStore();
  const nav = useNav();
  const p = usePeriodKey();
  const sw = useSwitchBank((id) => <ImportedBankDataScreen ledgerId={id} />);
  const banks = useBanks();
  const bank = banks.find((b) => b.id === ledgerId);
  const [view, setView] = useState<View>('daily');
  const [recon, setRecon] = useState(false);
  const data = useBankLoad((db) => importedBankData(db, ledgerId, period.from, period.to, view), [ledgerId, period, view, bump]);
  const rows = data?.rows ?? [];
  const { sel, setSel, keys } = useSel(rows.length);
  const open = (i: number) => {
    const r = rows[i];
    if (r) nav.push(<StatementLinesScreen ledgerId={ledgerId} from={r.from} to={r.to} />);
  };
  const doImport = () => nav.push(<ImportStatementScreen ledgerId={ledgerId} />);
  useScreen({
    title: 'Imported Bank Data',
    keys: { ...keys, ...p.key, ...sw.key, Enter: () => open(sel), F5: () => setRecon((r) => !r), F6: () => setView('monthly'), 'Alt+F6': () => setView('quarterly'), 'Alt+F1': () => setView('daily'), 'Alt+O': doImport },
    buttons: [p.button, sw.button, { key: 'F5', label: recon ? 'Statement View' : 'Recon View', run: () => setRecon((r) => !r) }, { key: 'F6', label: 'Monthly', run: () => setView('monthly') }, { key: 'Alt+F6', label: 'Quarterly', run: () => setView('quarterly') }, { key: 'Alt+O', label: 'Import Statement', run: doImport }],
  });
  const label = (r: { key: string; from: string }) => (view === 'daily' ? fmtDate(r.key) : view === 'monthly' ? fmtDate(r.from).replace(/^\d+-/, '') : `Q${r.key.slice(-1)} ${r.key.slice(0, 4)}`);
  return (
    <Frame title="Imported Bank Data">
      <div className="mb-2">
        Ledger <span className="mx-1">:</span>
        <b>{bank?.name}</b>
        {bank?.account_no && (
          <div>
            Account No. <span className="mx-1">:</span>
            <b>{bank.account_no}</b>
          </div>
        )}
      </div>
      <table className="w-full">
        <thead>
          <tr>
            <th className={`${th} text-left tracking-[0.2em]`} rowSpan={2}>Statement Date</th>
            <th className={`${th} text-center`} colSpan={2}>{recon ? 'Reconciled' : 'Deposit'}</th>
            <th className={`${th} text-center`} colSpan={2}>{recon ? 'Unreconciled' : 'Withdrawal'}</th>
            {!recon && <th className={`${th} text-right`} rowSpan={2}>Closing Balance as per Bank Statement</th>}
          </tr>
          <tr>
            <th className={`${th} text-right`}>Count</th>
            <th className={`${th} text-right`}>Amount</th>
            <th className={`${th} text-right`}>Count</th>
            <th className={`${th} text-right`}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.key} className={rowCls(i === sel)} onMouseEnter={() => setSel(i)} onClick={() => open(i)}>
              <td className="px-2">{label(r)}</td>
              <td className={num}>{recon ? r.reconciled.count || '' : r.dep_count || ''}</td>
              <td className={num}>{fmtAmount(recon ? r.reconciled.amount : r.dep_amount)}</td>
              <td className={num}>{recon ? r.unreconciled.count || '' : r.wd_count || ''}</td>
              <td className={num}>{fmtAmount(recon ? r.unreconciled.amount : r.wd_amount)}</td>
              {!recon && <td className={num}>{r.closing === null ? '' : fmtAmount(r.closing, false)}</td>}
            </tr>
          ))}
          {data && (
            <tr className="font-bold">
              <td className="border-y-[3px] border-double border-tb-ink px-2 tracking-[0.2em]">Grand Total</td>
              <td className={tot}>{recon ? data.total.reconciled.count : data.total.dep_count}</td>
              <td className={tot}>{fmtAmount(recon ? data.total.reconciled.amount : data.total.dep_amount, false)}</td>
              <td className={tot}>{recon ? data.total.unreconciled.count : data.total.wd_count}</td>
              <td className={tot}>{fmtAmount(recon ? data.total.unreconciled.amount : data.total.wd_amount, false)}</td>
              {!recon && <td className={tot} />}
            </tr>
          )}
        </tbody>
      </table>
      {data && data.total.dep_count + data.total.wd_count === 0 && <div className="py-3 text-tb-muted">No bank statement entries in this period.</div>}
    </Frame>
  );
}

export function StatementLinesScreen({ ledgerId, from, to }: { ledgerId: number; from: string; to: string }) {
  const name = useBankName(ledgerId);
  const data = useBankLoad((db) => statementLines(db, ledgerId, from, to), [ledgerId, from, to]);
  const rows = data ?? [];
  const { sel, setSel, keys } = useSel(rows.length);
  useScreen({ title: 'Imported Bank Data', keys, buttons: [] });
  return (
    <Frame title="Imported Bank Data" subtitle={from === to ? fmtDate(from) : `${fmtDate(from)} to ${fmtDate(to)}`}>
      <LedgerLine name={name} />
      <table className="w-full">
        <thead>
          <tr className="text-left">
            <th className={th}>Date</th>
            <th className={th}>Narration</th>
            <th className={th}>Inst No.</th>
            <th className={`${th} text-right`}>Deposit</th>
            <th className={`${th} text-right`}>Withdrawal</th>
            <th className={`${th} text-right`}>Balance</th>
            <th className={th}>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((l, i) => (
            <tr key={l.id} className={rowCls(i === sel)} onMouseEnter={() => setSel(i)}>
              <td className="px-2">{fmtDate(l.date)}</td>
              <td className="px-2">{l.narration}</td>
              <td className="px-2">{l.inst_no}</td>
              <td className={num}>{fmtAmount(l.deposit)}</td>
              <td className={num}>{fmtAmount(l.withdrawal)}</td>
              <td className={num}>{l.balance === null ? '' : fmtAmount(l.balance, false)}</td>
              <td className="px-2">{l.link_ref ? 'Reconciled' : l.status === 'System Inferred' ? 'Unreconciled' : l.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Frame>
  );
}

export function ImportStatementScreen({ ledgerId }: { ledgerId?: number }) {
  const { books, bump, toast } = useStore();
  const nav = useNav();
  const banks = useBanks();
  const form = useRef<FormHandle>(null);
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const opts = banks.map((b) => ({ id: b.id, label: b.name, sub: b.account_no }));
  const choose = async () => {
    const f = await pickTextFile('Bank statement', ['csv']);
    if (f) setFile(f);
  };
  const run = async () => {
    const v = form.current?.submit();
    if (!v) return;
    if (!file) return toast('Choose a statement file first (F4)', 'err');
    try {
      await bankingReady(books.db);
      const id = Number(v.bank);
      const res = await importStatementCsv(books.db, id, file.text);
      const auto = await autoReconcile(books.db, id);
      bump();
      toast(`${res.imported} imported, ${res.skipped} already present, ${res.rejected.length} rejected, ${auto.matched} reconciled`, res.rejected.length ? 'err' : 'ok');
      nav.pop();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  useScreen({
    title: 'Import Bank Statement',
    noPeriod: true,
    keys: { 'Ctrl+A': () => void run(), F4: () => void choose() },
    buttons: [{ key: 'F4', label: 'Choose File', run: () => void choose() }, { key: 'Ctrl+A', label: 'Accept', run: () => void run() }],
  });
  const fields: FieldDef[] = useMemo(
    () => [{ key: 'bank', label: 'Bank Ledger', kind: 'picker', title: 'Banks', options: opts, initial: opts.find((o) => o.id === ledgerId), required: true }],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [banks.length, ledgerId]
  );
  return (
    <div className="max-w-xl">
      <div className="mb-3 font-bold underline">Import Bank Statement (CSV)</div>
      <Form key={banks.length} ref={form} fields={fields} labelWidth={200} onDone={() => void run()} />
      <div className="mt-2 flex">
        <span style={{ width: 200 }}>Statement File</span>
        <span className="mr-2">:</span>
        <b>{file?.name ?? ''}</b>
      </div>
      <div className="mt-3 text-xs text-tb-muted">
        Columns recognised: Date, Narration / Description / Particulars, Chq / Ref No., Withdrawal / Debit, Deposit / Credit, Balance. Exact matches are reconciled automatically after import.
      </div>
    </div>
  );
}

export function OpeningBrsScreen({ ledgerId }: { ledgerId: number }) {
  const { books, company, bump, toast } = useStore();
  const name = useBankName(ledgerId);
  const data = useBankLoad(async (db) => ({ cfg: await bankConfig(db, ledgerId), items: await openingBrs(db, ledgerId) }), [ledgerId]);
  const [rows, setRows] = useState<{ date: string; particulars: string; inst_no: string; amount: string; side: 'Dr' | 'Cr' }[]>([]);
  const [from, setFrom] = useState('');
  const loaded = useRef(false);
  useEffect(() => {
    if (!data || loaded.current) return;
    loaded.current = true;
    setFrom(data.cfg.recon_from ? fmtDate(data.cfg.recon_from) : '');
    setRows(data.items.filter((t) => !t.bank_date).map((t) => ({ date: fmtDate(t.date), particulars: t.particulars, inst_no: t.inst_no, amount: fmtAmount(t.deposit || t.withdrawal), side: t.deposit ? 'Dr' : 'Cr' })));
  }, [data]);
  const save = async () => {
    const beginning = parseDate(from, company?.fy_start);
    if (!beginning) return toast('Reconciliation Beginning Date: invalid date', 'err');
    try {
      const items = rows
        .filter((r) => r.date.trim() && r.amount.trim())
        .map((r) => {
          const iso = parseDate(r.date, company?.fy_start);
          if (!iso) throw new Error(`Date: invalid date ${r.date}`);
          const amt = Math.round(Number(r.amount.replace(/,/g, '')) * 100);
          if (!Number.isFinite(amt) || amt <= 0) throw new Error('Amount: enter a valid amount');
          return { date: iso, particulars: r.particulars, inst_no: r.inst_no, deposit: r.side === 'Dr' ? amt : 0, withdrawal: r.side === 'Cr' ? amt : 0 };
        });
      await saveOpeningBrs(books.db, ledgerId, items, beginning);
      bump();
      toast('Opening BRS saved', 'ok');
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  const add = () => setRows((r) => [...r, { date: '', particulars: '', inst_no: '', amount: '', side: 'Cr' }]);
  useScreen({
    title: 'Opening BRS',
    noPeriod: true,
    keys: { 'Ctrl+A': () => void save(), 'Alt+A': add },
    buttons: [{ key: 'Alt+A', label: 'Add Line', run: add }, { key: 'Ctrl+A', label: 'Accept', run: () => void save() }],
  });
  const cell = (i: number, k: keyof (typeof rows)[number], w: string) => (
    <input
      className={`tb-input ${w}`}
      value={rows[i][k]}
      onChange={(e) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: e.target.value } : r)))}
      onKeyDown={(e) => {
        if (k === 'side' && (e.key === ' ' || e.key.toLowerCase() === 'd' || e.key.toLowerCase() === 'c')) {
          e.preventDefault();
          setRows((rs) => rs.map((r, j) => (j === i ? { ...r, side: e.key.toLowerCase() === 'd' ? 'Dr' : e.key.toLowerCase() === 'c' ? 'Cr' : r.side === 'Dr' ? 'Cr' : 'Dr' } : r)));
        }
      }}
    />
  );
  return (
    <Frame title="List of Unreconciled Transactions before the Reconciliation Beginning Date" subtitle="">
      <div className="mb-2 flex items-center gap-2">
        <span>Reconciliation Beginning Date</span>
        <span>:</span>
        <input className="tb-input w-28 bg-[#ffe3b0]" value={from} onChange={(e) => setFrom(e.target.value)} />
      </div>
      <LedgerLine name={name} />
      <table className="w-full">
        <thead>
          <tr className="text-left">
            <th className={th}>Date</th>
            <th className={th}>Particulars</th>
            <th className={th}>Inst No.</th>
            <th className={th}>Dr / Cr</th>
            <th className={`${th} text-right`}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((_, i) => (
            <tr key={i}>
              <td className="px-1">{cell(i, 'date', 'w-28')}</td>
              <td className="px-1">{cell(i, 'particulars', 'w-72')}</td>
              <td className="px-1">{cell(i, 'inst_no', 'w-32')}</td>
              <td className="px-1">{cell(i, 'side', 'w-12')}</td>
              <td className="px-1 text-right">{cell(i, 'amount', 'w-32 tb-num')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <div className="py-2 text-tb-muted">Press Alt+A to add an unreconciled transaction.</div>}
    </Frame>
  );
}

export function bankingMenu(push: (n: ReactNode) => void): MenuItem[] {
  return [
    { label: 'Banking Activities', run: () => push(<BankingActivitiesScreen />) },
    { label: 'Bank Reconciliation', run: () => push(<BankSelector next={(id) => <BankReconSummaryScreen ledgerId={id!} />} />) },
    { label: 'Imported Bank Data', run: () => push(<BankSelector next={(id) => <ImportedBankDataScreen ledgerId={id!} />} />) },
    { label: 'Import Bank Statement', run: () => push(<ImportStatementScreen />) },
    { label: 'Cheque Register', run: () => push(<ChequeRegisterScreen />) },
    { label: 'Cheque Printing', run: () => push(<ChequePrintingEntry />) },
    { label: 'Post-Dated Summary', run: () => push(<PostDatedSummaryEntry />) },
  ];
}
