import { useEffect, useMemo, useRef, useState } from 'react';
import {
  billInterest,
  fmtAmount,
  fmtDate,
  fmtDrCr,
  groupInterest,
  INTEREST_BALANCES,
  INTEREST_STYLES,
  interestParams,
  ledgerInterest,
  saveInterestParams,
  type InterestApplicability,
  type InterestBalances,
  type InterestParamsInput,
  type InterestStyle,
  type Ledger,
} from '@tallybook/core';
import { useScreen } from '../registry.ts';
import { useStore } from '../store.tsx';
import { useNav } from '../nav.tsx';
import { Form, type FieldDef, type FormHandle } from '../ui/Form.tsx';
import type { Opt } from '../ui/PickerInput.tsx';
import { SelectList } from './SelectList.tsx';
import { PickGroup } from './Pickers.tsx';
import { EntryGrid, gridRow, type GridCol, type GridRow } from './EntryGrid.tsx';
import { Frame, rowCls, th, useLoad, usePeriodKey, useSel } from './Reports.tsx';
import { useFilter, useReportOptions } from './reportConfig.tsx';

const styleOpts: Opt[] = INTEREST_STYLES.map((s) => ({ id: s.id, label: s.label }));
const balOpts: Opt[] = INTEREST_BALANCES.map((s) => ({ id: s.id, label: s.label }));
const basedOpts: Opt[] = [
  { id: 'voucher_date', label: 'Voucher Date' },
  { id: 'reco_date', label: 'Bank/Reco Date' },
];
const applicOpts: Opt[] = [
  { id: 'always', label: 'Always' },
  { id: 'past_due', label: 'Past Due Date' },
];
const calcOpts: Opt[] = [
  { id: 'due_date', label: 'Due Date of Invoice/Ref' },
  { id: 'bill_date', label: 'Date of Invoice/Ref' },
];
const roundOpts: Opt[] = [
  { id: 'not_applicable', label: 'Not Applicable' },
  { id: 'normal', label: 'Normal' },
  { id: 'upward', label: 'Upward' },
  { id: 'downward', label: 'Downward' },
];

const pick = (opts: Opt[], id: string | undefined) => opts.find((o) => o.id === id) ?? opts[0];
const pct = (bp: number) => String(bp / 100);
const toBp = (t: string) => {
  const n = Number(String(t).replace(/,/g, '').trim());
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
};

const BLANK: InterestParamsInput = {
  active: true,
  based_on: 'voucher_date',
  by_transaction: false,
  override_params: false,
  include_added: false,
  include_deducted: false,
  advanced: false,
  override_advanced: false,
  slabs: [{ rate_bp: 0, style: 'calendar_year', balances: 'all', applicability: 'always', after_days: 0, calc_from: 'due_date', rounding: 'not_applicable', applicable_from: '' }],
};

export function InterestParametersDialog({
  bank,
  billWise,
  initial,
  onDone,
}: {
  bank: boolean;
  billWise: boolean;
  initial: InterestParamsInput | null;
  onDone: (p: InterestParamsInput | null) => void;
}) {
  const { toast } = useStore();
  const form = useRef<FormHandle>(null);
  const start = initial ?? BLANK;
  const [advanced, setAdvanced] = useState(start.advanced);
  const [grid, setGrid] = useState<InterestParamsInput | null>(null);

  const collect = (): InterestParamsInput | null => {
    const v = form.current?.submit();
    if (!v) return null;
    const rate = toBp(v.rate ?? '');
    if (!advanced && !rate) {
      toast('Rate: enter the rate of interest', 'err');
      return null;
    }
    const keep = start.slabs[0];
    return {
      active: true,
      based_on: bank ? (v.based_on as 'voucher_date' | 'reco_date') : 'voucher_date',
      by_transaction: !bank && billWise && !!v.by_txn,
      override_params: !bank && billWise && !!v.by_txn && !!v.override,
      include_added: !!v.added,
      include_deducted: !!v.deducted,
      advanced,
      override_advanced: advanced && !!v.by_txn && !!v.override && !!v.override_adv,
      slabs: advanced ? start.slabs.filter((s) => s.rate_bp) : [{ ...keep, rate_bp: rate, style: v.style as InterestStyle, balances: v.balances as InterestBalances, applicable_from: '', applicability: 'always', after_days: 0 }],
    };
  };

  const accept = () => {
    const p = collect();
    if (!p) return;
    if (advanced) setGrid(p);
    else onDone(p);
  };
  const toggleAdvanced = () => setAdvanced((a) => !a);

  useScreen({
    title: 'Interest Parameters',
    kind: 'modal',
    noPeriod: true,
    keys: { Escape: () => onDone(null), 'Ctrl+A': accept, F12: toggleAdvanced },
    buttons: [
      { key: 'Ctrl+A', label: 'Accept', run: accept },
      { key: 'F12', label: advanced ? 'Use simple interest parameters' : 'Use advance interest parameters', run: toggleAdvanced },
    ],
  });

  const s0 = start.slabs[0];
  const fields: FieldDef[] = [
    { key: 'based_on', label: 'Calculate Interest Based on', kind: 'picker', title: 'Interest Based on', options: basedOpts, initial: pick(basedOpts, start.based_on), required: true, visible: () => bank },
    { key: 'by_txn', label: 'Calculate Interest Transaction-by-Transaction', kind: 'toggle', initial: start.by_transaction, visible: () => !bank && billWise },
    { key: 'override', label: 'Override Parameters for each Transaction', kind: 'toggle', initial: start.override_params, visible: (v) => !bank && billWise && !!v.by_txn },
    { key: 'override_adv', label: 'Override advanced parameters', kind: 'toggle', initial: start.override_advanced, visible: (v) => advanced && !bank && billWise && !!v.by_txn && !!v.override },
    { key: 'added', label: 'For amounts added', kind: 'toggle', initial: start.include_added, heading: 'Include transaction date for interest calculation' },
    { key: 'deducted', label: 'For amounts deducted', kind: 'toggle', initial: start.include_deducted },
    { key: 'rate', label: 'Rate (%)', kind: 'text', initial: s0.rate_bp ? pct(s0.rate_bp) : '', required: !advanced, visible: () => !advanced },
    { key: 'style', label: 'Interest Style', kind: 'picker', title: 'Interest Styles', options: styleOpts, initial: pick(styleOpts, s0.style), required: true, visible: () => !advanced },
    { key: 'balances', label: 'Interest Balances', kind: 'picker', title: 'Interest Balances', options: balOpts, initial: pick(balOpts, s0.balances), required: true, visible: () => !advanced },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-tb-top/35">
      <div className="w-[560px] border border-tb-ink bg-tb-paper px-4 pb-3 pt-2 shadow-[5px_5px_0_rgba(15,90,116,.3)]">
        <div className="mb-3 text-center font-bold underline">Interest Parameters</div>
        <Form ref={form} fields={fields} onDone={accept} labelWidth={320} />
        <div className="mt-3 text-xs text-tb-muted">Ctrl+A: accept   Esc: cancel   F12: {advanced ? 'simple' : 'advance'} interest parameters</div>
      </div>
      {grid && (
        <SlabGrid
          bank={bank}
          params={grid}
          onDone={(slabs) => {
            if (slabs) onDone({ ...grid, slabs });
            else setGrid(null);
          }}
        />
      )}
    </div>
  );
}

function SlabGrid({ bank, params, onDone }: { bank: boolean; params: InterestParamsInput; onDone: (s: InterestParamsInput['slabs'] | null) => void }) {
  const rows = params.slabs.map((s) =>
    gridRow(
      {
        from: s.applicable_from ? fmtDate(s.applicable_from) : '',
        rate: s.rate_bp ? pct(s.rate_bp) : '',
        style: pick(styleOpts, s.style).label,
        balances: pick(balOpts, s.balances).label,
        applic: pick(applicOpts, s.applicability).label,
        days: s.after_days ? String(s.after_days) : '',
        calc: pick(calcOpts, s.calc_from).label,
        round: pick(roundOpts, s.rounding).label,
      },
      { style: s.style ?? 'calendar_year', balances: s.balances ?? 'all', applic: s.applicability ?? 'always', calc: s.calc_from ?? 'due_date', round: s.rounding ?? 'not_applicable' }
    )
  );
  const cols: GridCol[] = [
    ...(bank ? ([{ key: 'from', label: 'Applicable From', kind: 'date', width: 120 }] as GridCol[]) : []),
    { key: 'rate', label: 'Rate %', kind: 'text', align: 'right', width: 70 },
    { key: 'style', label: 'Interest Style', kind: 'picker', title: 'Interest Styles', options: styleOpts, width: 140 },
    { key: 'balances', label: 'Interest Balances', kind: 'picker', title: 'Interest Balances', options: balOpts, width: 170 },
    ...(bank
      ? []
      : ([
          { key: 'applic', label: 'Applicability', kind: 'picker', title: 'Applicability', options: applicOpts, width: 130 },
          { key: 'days', label: 'Days', kind: 'text', align: 'right', width: 50, visible: (r: GridRow) => r.id.applic === 'past_due' },
          { key: 'calc', label: 'Calculate From', kind: 'picker', title: 'Calculate From', options: calcOpts, width: 190 },
        ] as GridCol[])),
    { key: 'round', label: 'Rounding', kind: 'picker', title: 'Rounding', options: roundOpts, width: 130 },
  ];
  const fresh = (rs: GridRow[]) => {
    const l = rs[rs.length - 1];
    return gridRow({ style: l?.text.style ?? styleOpts[1].label, balances: l?.text.balances ?? balOpts[0].label, applic: applicOpts[0].label, calc: calcOpts[0].label, round: roundOpts[0].label }, { style: l?.id.style ?? 'calendar_year', balances: l?.id.balances ?? 'all', applic: 'always', calc: 'due_date', round: 'not_applicable' });
  };
  return (
    <EntryGrid
      title="Interest Parameters"
      width={bank ? 760 : 1000}
      cols={cols}
      initial={rows}
      fresh={fresh}
      validate={(rs) => (rs.some((r) => !toBp(r.text.rate ?? '')) ? 'Rate: enter the rate of interest' : rs.length ? null : 'Enter the rate of interest')}
      onAccept={(rs) =>
        onDone(
          rs.map((r) => ({
            applicable_from: bank && r.text.from ? (parseDateText(r.text.from) ?? '') : '',
            rate_bp: toBp(r.text.rate ?? ''),
            style: (r.id.style ?? 'calendar_year') as InterestStyle,
            balances: (r.id.balances ?? 'all') as InterestBalances,
            applicability: (bank ? 'always' : (r.id.applic ?? 'always')) as InterestApplicability,
            after_days: !bank && r.id.applic === 'past_due' ? parseInt(r.text.days ?? '0', 10) || 0 : 0,
            calc_from: (r.id.calc ?? 'due_date') as 'due_date' | 'bill_date',
            rounding: (r.id.round ?? 'not_applicable') as 'not_applicable' | 'normal' | 'upward' | 'downward',
          }))
        )
      }
      onCancel={() => onDone(null)}
    />
  );
}

function parseDateText(t: string): string | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(t.trim());
  if (!m) return null;
  const mon = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[2].toLowerCase());
  if (mon < 0) return null;
  return `${m[3]}-${String(mon + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

export function InterestParametersScreen({ ledgerId }: { ledgerId: number }) {
  const { books, bump, toast } = useStore();
  const nav = useNav();
  const [state, setState] = useState<{ ledger: Ledger; params: InterestParamsInput | null } | null>(null);
  useEffect(() => {
    void (async () => {
      const ledger = (await books.ledgers()).find((l) => l.id === ledgerId);
      const p = await interestParams(books.db, ledgerId);
      if (ledger) setState({ ledger, params: p ? { ...p } : null });
    })();
  }, [books, ledgerId]);
  if (!state) return null;
  const bank = ['Bank Accounts', 'Bank OD A/c'].includes(state.ledger.group_name);
  return (
    <InterestParametersDialog
      bank={bank}
      billWise={!!state.ledger.bill_by_bill}
      initial={state.params}
      onDone={async (p) => {
        if (!p) return nav.pop();
        try {
          await saveInterestParams(books.db, ledgerId, p);
          bump();
          toast('Interest Parameters saved', 'ok');
          nav.pop();
        } catch (e) {
          toast((e as Error).message, 'err');
        }
      }}
    />
  );
}

const num = 'px-2 text-right tabular-nums';
const tot = 'border-y-[3px] border-double border-tb-ink px-2 text-right tabular-nums';

export function GroupInterestEntry() {
  const nav = useNav();
  return <PickGroup title="Group Interest Calculations" onPick={(g) => nav.push(<GroupInterestReport groupId={g.id} />)} />;
}

export function GroupInterestReport({ groupId = null }: { groupId?: number | null }) {
  const { books, period } = useStore();
  const nav = useNav();
  const p = usePeriodKey();
  const cfg = useReportOptions('group-interest', 'Group Interest Calculations', [{ key: 'hideZero', label: 'Hide groups and ledgers with no interest', default: false }]);
  const flt = useFilter();
  const data = useLoad(() => groupInterest(books.db, groupId, period.from, period.to), [period, groupId]);
  const rows = useMemo(() => (data?.rows ?? []).filter((r) => (!cfg.values.hideZero || r.interest) && flt.match(r.name)), [data, cfg.values.hideZero, flt]);
  const { sel, setSel, keys } = useSel(rows.length);
  const open = (i: number) => {
    const r = rows[i];
    if (!r) return;
    nav.push(r.kind === 'group' ? <GroupInterestReport groupId={r.id} /> : <LedgerInterestReport ledgerId={r.id} />);
  };
  useScreen({
    title: 'Group Interest Calculations',
    keys: { ...keys, ...p.key, ...cfg.key, ...flt.key, Enter: () => open(sel) },
    buttons: [p.button, cfg.button, flt.button],
  });
  return (
    <Frame title="Group Interest Calculations" subtitle={`${groupId && data ? `${data.title}, ` : ''}${fmtDate(period.from)} to ${fmtDate(period.to)}`}>
      {flt.bar}
      <table className="w-full">
        <thead>
          <tr className="text-left">
            <th className={th} rowSpan={2}>
              Particulars
            </th>
            <th className={`${th} text-center`} colSpan={2}>
              Interest Calculation
            </th>
          </tr>
          <tr>
            <th className={`${th} text-right font-normal`}>Closing Balance</th>
            <th className={`${th} text-right font-normal`}>Interest</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.kind}-${r.id}`} className={rowCls(i === sel, r.kind === 'group' ? 'font-bold' : '')} onMouseEnter={() => setSel(i)} onClick={() => open(i)}>
              <td className="px-2">{r.name}</td>
              <td className={num}>{fmtDrCr(r.balance)}</td>
              <td className={num}>{fmtDrCr(r.interest)}</td>
            </tr>
          ))}
          {data && (
            <tr className="font-bold">
              <td className="border-y-[3px] border-double border-tb-ink px-2">Grand Total</td>
              <td className={tot}>{fmtDrCr(data.total.balance)}</td>
              <td className={tot}>{fmtDrCr(data.total.interest)}</td>
            </tr>
          )}
        </tbody>
      </table>
      {data && rows.length === 0 && <div className="py-3 text-tb-muted">{flt.active ? 'No rows match the filter.' : 'No ledgers with interest calculation under this group.'}</div>}
    </Frame>
  );
}

export function LedgerInterestEntry() {
  const { books, version } = useStore();
  const nav = useNav();
  const [items, setItems] = useState<Ledger[]>([]);
  useEffect(() => {
    void (async () => {
      const on = new Set((await books.db.select<{ ledger_id: number }>('SELECT ledger_id FROM interest_params WHERE active = 1')).map((r) => r.ledger_id));
      setItems((await books.ledgers()).filter((l) => on.has(l.id)));
    })();
  }, [books, version]);
  return (
    <SelectList
      title="Ledger Interest Calculation"
      heading="List of Ledgers"
      popOnSelect
      items={items.map((l) => ({ id: l.id, label: l.name, sub: l.group_name }))}
      onSelect={(i) => nav.push(<LedgerInterestReport ledgerId={i.id as number} />)}
    />
  );
}

export function LedgerInterestReport({ ledgerId }: { ledgerId: number }) {
  const { books, period } = useStore();
  const nav = useNav();
  const p = usePeriodKey();
  const flt = useFilter();
  const data = useLoad(() => ledgerInterest(books.db, ledgerId, period.from, period.to), [period, ledgerId]);
  const rows = useMemo(() => (data?.segments ?? []).filter((s) => flt.match(fmtDate(s.from), fmtDate(s.to), s.rate_bp / 100)), [data, flt]);
  const { sel, setSel, keys } = useSel(rows.length);
  const bills = () => nav.push(<LedgerBillInterestReport ledgerId={ledgerId} />);
  useScreen({
    title: 'Ledger Interest Calculation',
    keys: { ...keys, ...p.key, ...flt.key, 'Ctrl+H': bills },
    buttons: [p.button, { key: 'Ctrl+H', label: 'Change View', run: bills }, flt.button],
  });
  return (
    <Frame title="Ledger Interest Calculation" subtitle={`${data?.ledger ?? ''}, ${fmtDate(period.from)} to ${fmtDate(period.to)}`}>
      {flt.bar}
      <table className="w-full">
        <thead>
          <tr className="text-left">
            <th className={`${th} text-right`}>Balance</th>
            <th className={th}>From</th>
            <th className={th}>To</th>
            <th className={`${th} text-right`}>Total Days</th>
            <th className={`${th} text-right`}>Rate %</th>
            <th className={`${th} text-right`}>Interest</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s, i) => (
            <tr key={`${s.from}-${i}`} className={rowCls(i === sel)} onMouseEnter={() => setSel(i)}>
              <td className={`${num} font-bold`}>{fmtDrCr(s.balance)}</td>
              <td className="px-2">{fmtDate(s.from)}</td>
              <td className="px-2">{fmtDate(s.to)}</td>
              <td className={`${num} font-bold`}>{s.days} days</td>
              <td className={num}>{s.rate_bp / 100} %</td>
              <td className={`${num} font-bold`}>{fmtDrCr(s.interest)}</td>
            </tr>
          ))}
          {data && (
            <tr className="font-bold">
              <td className="border-y-[3px] border-double border-tb-ink px-2" colSpan={5}>
                Total
              </td>
              <td className={tot}>{fmtDrCr(data.interest)}</td>
            </tr>
          )}
        </tbody>
      </table>
      {data && rows.length === 0 && <div className="py-3 text-tb-muted">{flt.active ? 'No rows match the filter.' : 'No interest to show. Activate interest calculation for this ledger.'}</div>}
    </Frame>
  );
}

export function LedgerBillInterestReport({ ledgerId }: { ledgerId: number }) {
  const { books, period } = useStore();
  const p = usePeriodKey();
  const flt = useFilter();
  const [detailed, setDetailed] = useState(false);
  const data = useLoad(() => billInterest(books.db, ledgerId, period.from, period.to), [period, ledgerId]);
  const rows = useMemo(() => (data?.bills ?? []).filter((b) => flt.match(b.name, fmtDate(b.bill_date))), [data, flt]);
  const { sel, setSel, keys } = useSel(rows.length);
  const toggle = () => setDetailed((d) => !d);
  useScreen({
    title: 'Ledger Interest Calculation',
    keys: { ...keys, ...p.key, ...flt.key, 'Alt+F5': toggle },
    buttons: [p.button, { key: 'Alt+F5', label: detailed ? 'Condensed' : 'Detailed', run: toggle }, flt.button],
  });
  return (
    <Frame title="Ledger Interest Calculation" subtitle={`${data?.ledger ?? ''}, ${fmtDate(period.from)} to ${fmtDate(period.to)}`}>
      {flt.bar}
      <table className="w-full">
        <thead>
          <tr className="text-left">
            <th className={th}>Date</th>
            <th className={th}>Ref. No.</th>
            <th className={`${th} text-right`}>Pending Amount</th>
            <th className={th}>Due on</th>
            <th className={`${th} text-right`}>Total Days</th>
            <th className={`${th} text-right`}>Rate %</th>
            <th className={`${th} text-right`}>Interest</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b, i) => {
            const days = b.segments.reduce((s, x) => s + x.days, 0);
            const last = b.segments[b.segments.length - 1];
            return [
              <tr key={b.name} className={rowCls(i === sel, 'font-bold')} onMouseEnter={() => setSel(i)}>
                <td className="px-2">{fmtDate(b.bill_date)}</td>
                <td className="px-2">{b.name}</td>
                <td className={num}>{fmtDrCr(b.pending)}</td>
                <td className="px-2 font-normal">{fmtDate(b.due_date)}</td>
                <td className={num}>{days ? `${days} days` : ''}</td>
                <td className={`${num} font-normal`}>{last ? `${last.rate_bp / 100} %` : ''}</td>
                <td className={num}>{fmtDrCr(b.interest)}</td>
              </tr>,
              ...(detailed
                ? b.segments.map((s, k) => (
                    <tr key={`${b.name}-${k}`} className="italic">
                      <td className="px-2 pl-6" colSpan={2}>
                        {fmtDate(s.from)} to {fmtDate(s.to)}
                      </td>
                      <td className={num}>{fmtDrCr(s.balance)}</td>
                      <td />
                      <td className={num}>{s.days} days</td>
                      <td className={num}>{s.rate_bp / 100} %</td>
                      <td className={num}>{fmtAmount(Math.abs(s.interest))}</td>
                    </tr>
                  ))
                : []),
            ];
          })}
          {data && (
            <tr className="font-bold">
              <td className="border-y-[3px] border-double border-tb-ink px-2" colSpan={2}>
                Total
              </td>
              <td className={tot}>{fmtDrCr(rows.reduce((s, b) => s + b.pending, 0))}</td>
              <td className={tot} colSpan={3} />
              <td className={tot}>{fmtDrCr(rows.reduce((s, b) => s + b.interest, 0))}</td>
            </tr>
          )}
        </tbody>
      </table>
      {data && rows.length === 0 && <div className="py-3 text-tb-muted">{flt.active ? 'No rows match the filter.' : 'No bills with interest for this ledger.'}</div>}
    </Frame>
  );
}
