import { useEffect, useMemo, useRef, useState } from 'react';
import {
  budget,
  budgetVariance,
  budgets,
  costCentreBudgetVariance,
  costCentres,
  createBudget,
  deleteBudget,
  fmtAmount,
  fmtDate,
  fmtDrCr,
  parseAmount,
  updateBudget,
  type Budget,
  type BudgetLine,
  type BudgetLineInput,
  type CostCentre,
  type Group,
  type Ledger,
} from '@tallybook/core';
import { useScreen } from '../registry.ts';
import { useStore } from '../store.tsx';
import { useNav } from '../nav.tsx';
import { useDialogs } from '../ui/Dialogs.tsx';
import { Form, type FieldDef, type FormHandle } from '../ui/Form.tsx';
import type { Opt } from '../ui/PickerInput.tsx';
import { SelectList } from './SelectList.tsx';
import { EntryGrid, gridRow, type GridCol, type GridRow } from './EntryGrid.tsx';
import { Frame, rowCls, th, useLoad, usePeriodKey, useSel } from './Reports.tsx';
import { useFilter, useReportOptions } from './reportConfig.tsx';
import { useList } from './Costing.tsx';

const BASIS: Opt[] = [
  { id: 'nett', label: 'On Nett Transactions' },
  { id: 'closing', label: 'On Closing Balance' },
];

type Stage = 'group' | 'ledger' | 'cost_centre';

interface Draft {
  name: string;
  parent_id: number | null;
  from_date: string;
  to_date: string;
  set_groups: boolean;
  set_ledgers: boolean;
  set_cost_centres: boolean;
}

const stageTitle = (s: Stage) => (s === 'group' ? 'Group Budget' : s === 'ledger' ? 'Ledger Budget' : 'Cost Centre Budget');

export function BudgetForm({ id }: { id?: number }) {
  const { books, bump, toast } = useStore();
  const nav = useNav();
  const dialogs = useDialogs();
  const form = useRef<FormHandle>(null);
  const [cur, setCur] = useState<(Budget & { lines: BudgetLine[] }) | null | undefined>(id ? undefined : null);
  const all = useList<Budget>(() => budgets(books.db));
  const groups = useList<Group>(() => books.groups());
  const ledgers = useList<Ledger>(() => books.ledgers());
  const centres = useList<CostCentre>(() => costCentres(books.db));
  const [draft, setDraft] = useState<Draft | null>(null);
  const [stages, setStages] = useState<Stage[]>([]);
  const [step, setStep] = useState(0);
  const [lines, setLines] = useState<BudgetLineInput[]>([]);
  useEffect(() => {
    if (id) void budget(books.db, id).then(setCur);
  }, [books, id]);

  const save = async (d: Draft, ls: BudgetLineInput[]) => {
    try {
      if (cur) await updateBudget(books.db, cur.id, { ...d, lines: ls });
      else await createBudget(books.db, { ...d, lines: ls });
      bump();
      toast('Budget saved', 'ok');
      nav.pop();
    } catch (e) {
      toast((e as Error).message, 'err');
      setDraft(null);
      setStages([]);
    }
  };

  const accept = () => {
    const v = form.current?.submit();
    if (!v) return;
    const d: Draft = { name: String(v.name), parent_id: Number(v.under) || null, from_date: v.from, to_date: v.to, set_groups: !!v.groups, set_ledgers: !!v.ledgers, set_cost_centres: !!v.centres };
    if (!d.from_date || !d.to_date) return toast('Period of Budget: enter From and To dates', 'err');
    const st: Stage[] = [...(d.set_groups ? (['group'] as Stage[]) : []), ...(d.set_ledgers ? (['ledger'] as Stage[]) : []), ...(d.set_cost_centres ? (['cost_centre'] as Stage[]) : [])];
    setDraft(d);
    setLines([]);
    setStep(0);
    if (!st.length) void save(d, []);
    else setStages(st);
  };

  const remove = async () => {
    if (!cur || !(await dialogs.confirm('Delete ?', { title: 'Delete', def: false }))) return;
    try {
      await deleteBudget(books.db, cur.id);
      bump();
      toast('Deleted', 'ok');
      nav.pop();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };

  useScreen({
    title: cur ? 'Budget Alteration' : 'Budget Creation',
    noPeriod: true,
    keys: { 'Ctrl+A': accept, 'Alt+D': cur ? () => void remove() : () => false },
    buttons: [{ key: 'Ctrl+A', label: 'Accept', run: accept }, ...(cur ? [{ key: 'Alt+D', label: 'Delete', run: () => void remove() }] : [])],
  });

  if (cur === undefined) return null;
  const under: Opt[] = [{ id: 0, label: 'Primary' }, ...all.filter((b) => b.id !== cur?.id).map((b) => ({ id: b.id, label: b.name }))];
  const fields: FieldDef[] = [
    { key: 'name', label: 'Name', kind: 'text', required: true, initial: cur?.name },
    { key: 'under', label: 'Under', kind: 'picker', title: 'Budgets', options: under, initial: under.find((o) => o.id === (cur?.parent_id ?? 0)), required: true },
    { key: 'from', label: 'From:', kind: 'date', initial: cur?.from_date, heading: 'Period of Budget' },
    { key: 'to', label: 'To:', kind: 'date', initial: cur?.to_date },
    { key: 'groups', label: 'Groups', kind: 'toggle', initial: cur ? !!cur.set_groups : false, heading: 'Set / Alter Budgets of' },
    { key: 'ledgers', label: 'Ledgers', kind: 'toggle', initial: cur ? !!cur.set_ledgers : false },
    { key: 'centres', label: 'Cost Centres', kind: 'toggle', initial: cur ? !!cur.set_cost_centres : false },
  ];

  const stage = draft && stages.length && step < stages.length ? stages[step] : null;
  const existing = (kind: Stage) => (cur?.lines ?? []).filter((l) => l.kind === kind);
  const advance = (more: BudgetLineInput[]) => {
    const next = [...lines, ...more];
    setLines(next);
    if (step + 1 >= stages.length) void save(draft!, next);
    else setStep(step + 1);
  };

  return (
    <div className="max-w-xl">
      <Form ref={form} fields={fields} onDone={accept} labelWidth={200} />
      {stage && draft && stage !== 'cost_centre' && (
        <LineGrid kind={stage} draft={draft} groups={groups} ledgers={ledgers} initial={existing(stage)} onDone={(ls) => (ls ? advance(ls) : (setDraft(null), setStages([])))} />
      )}
      {stage === 'cost_centre' && draft && <CentreGrid draft={draft} centres={centres} initial={existing('cost_centre')} onDone={(ls) => (ls ? advance(ls) : (setDraft(null), setStages([])))} />}
    </div>
  );
}

function periodHeading(d: Draft, what: string) {
  return (
    <>
      <div className="font-semibold">
        {what} Under &apos;{d.name}&apos;
      </div>
      <div className="text-xs">
        (From {fmtDate(d.from_date)} to {fmtDate(d.to_date)})
      </div>
    </>
  );
}

function LineGrid({ kind, draft, groups, ledgers, initial, onDone }: { kind: 'group' | 'ledger'; draft: Draft; groups: Group[]; ledgers: Ledger[]; initial: BudgetLine[]; onDone: (l: BudgetLineInput[] | null) => void }) {
  const opts: Opt[] = kind === 'group' ? groups.map((g) => ({ id: g.id, label: g.name })) : ledgers.map((l) => ({ id: l.id, label: l.name, sub: l.group_name }));
  const rows = initial.map((l) => gridRow({ name: l.name, basis: BASIS.find((b) => b.id === l.basis)!.label, amount: fmtAmount(Math.abs(l.amount)) }, { name: l.ref_id, basis: l.basis }));
  const cols: GridCol[] = [
    { key: 'name', label: 'Account Name', kind: 'picker', title: kind === 'group' ? 'Groups' : 'Ledgers', options: opts },
    { key: 'basis', label: 'Type of Budget', kind: 'picker', title: 'Types of Budget', options: BASIS, width: 190 },
    { key: 'amount', label: 'Amount', kind: 'amount', align: 'right', width: 140 },
  ];
  const fresh = (rs: GridRow[]) => {
    const last = rs[rs.length - 1];
    return gridRow({ basis: last?.text.basis ?? BASIS[0].label }, { basis: last?.id.basis ?? 'nett' });
  };
  return (
    <EntryGrid
      title={stageTitle(kind)}
      heading={periodHeading(draft, kind === 'group' ? 'Group Budgets' : 'Ledger Budgets')}
      cols={cols}
      initial={rows}
      fresh={fresh}
      width={680}
      validate={(rs) => {
        for (const r of rs) {
          if (!r.id.name) return 'Account Name: choose from the list';
          if (!r.id.basis) return 'Type of Budget: choose from the list';
          if ((parseAmount(r.text.amount ?? '') ?? 0) === 0) return 'Enter the budget amount';
        }
        return null;
      }}
      onAccept={(rs) =>
        onDone(rs.map((r) => ({ kind, ref_id: Number(r.id.name), basis: r.id.basis === 'closing' ? 'closing' : 'nett', amount: parseAmount(r.text.amount ?? '') ?? 0 })))
      }
      onCancel={() => onDone(null)}
    />
  );
}

function CentreGrid({ draft, centres, initial, onDone }: { draft: Draft; centres: CostCentre[]; initial: BudgetLine[]; onDone: (l: BudgetLineInput[] | null) => void }) {
  const opts: Opt[] = centres.map((c) => ({ id: c.id, label: c.name }));
  const closingText = (e: number, i: number) => (e || i ? fmtDrCr(e - i) || '0.00' : '');
  const rows = initial.map((l) => gridRow({ name: l.name, exp: fmtAmount(l.exp_amount), inc: fmtAmount(l.inc_amount), closing: closingText(l.exp_amount, l.inc_amount) }, { name: l.ref_id }));
  const cols: GridCol[] = [
    { key: 'name', label: 'Cost Centre', kind: 'picker', title: 'Cost Centres', options: opts },
    { key: 'exp', label: 'Expenses', kind: 'amount', align: 'right', width: 130 },
    { key: 'inc', label: 'Income', kind: 'amount', align: 'right', width: 130 },
    { key: 'closing', label: 'Closing Balance', kind: 'text', align: 'right', width: 150, readOnly: true },
  ];
  const derive = (rs: GridRow[], i: number, key: string): GridRow[] => {
    if (key !== 'exp' && key !== 'inc') return rs;
    const r = rs[i];
    const e = parseAmount(r.text.exp ?? '') ?? 0;
    const n = parseAmount(r.text.inc ?? '') ?? 0;
    return rs.map((x, j) => (j === i ? { ...x, text: { ...x.text, closing: closingText(e, n) } } : x));
  };
  return (
    <EntryGrid
      title="Cost Centre Budget"
      heading={periodHeading(draft, 'Cost Centre Budgets')}
      cols={cols}
      initial={rows}
      derive={derive}
      width={720}
      validate={(rs) => (rs.some((r) => !r.id.name) ? 'Cost Centre: choose from the list' : null)}
      onAccept={(rs) =>
        onDone(
          rs.map((r) => {
            const e = parseAmount(r.text.exp ?? '') ?? 0;
            const n = parseAmount(r.text.inc ?? '') ?? 0;
            return { kind: 'cost_centre', ref_id: Number(r.id.name), exp_amount: e, inc_amount: n, closing_amount: e - n };
          })
        )
      }
      onCancel={() => onDone(null)}
    />
  );
}

export function PickBudget({ title = 'Budget', onPick, popOnSelect = true }: { title?: string; onPick: (b: Budget) => void; popOnSelect?: boolean }) {
  const { books } = useStore();
  const nav = useNav();
  const items = useList<Budget>(() => budgets(books.db));
  return (
    <SelectList
      title={title}
      heading="List of Budgets"
      popOnSelect={popOnSelect}
      items={items.map((b) => ({ id: b.id, label: b.name }))}
      onSelect={(i) => onPick(items.find((b) => b.id === i.id)!)}
      onCreate={() => nav.push(<BudgetForm />)}
    />
  );
}

export function AlterBudgets() {
  const nav = useNav();
  return <PickBudget title="Budget Alteration" popOnSelect={false} onPick={(b) => nav.push(<BudgetForm id={b.id} />)} />;
}

export function BudgetVarianceEntry() {
  const nav = useNav();
  return <PickBudget title="Budget Variance" onPick={(b) => nav.push(<BudgetVarianceReport budgetId={b.id} />)} />;
}

const num = 'px-2 text-right tabular-nums';
const tot = 'border-y-[3px] border-double border-tb-ink px-2 text-right tabular-nums';

const dr = (v: number) => (v > 0 ? fmtAmount(v) : '');
const cr = (v: number) => (v < 0 ? fmtAmount(-v) : '');
const varDr = (v: number, side: number) => (side >= 0 && v ? `${v < 0 ? '(-)' : ''}${fmtAmount(Math.abs(v))}` : '');
const varCr = (v: number, side: number) => (side < 0 && v ? `${v < 0 ? '(-)' : ''}${fmtAmount(Math.abs(v))}` : '');

export function BudgetVarianceReport({ budgetId, groupId = null, ledgerWise = false }: { budgetId: number; groupId?: number | null; ledgerWise?: boolean }) {
  const { books, period } = useStore();
  const nav = useNav();
  const p = usePeriodKey();
  const cfg = useReportOptions('budget-variance', 'Budget Variance', [{ key: 'hideZero', label: 'Hide groups and ledgers with no budget or actuals', default: true }]);
  const flt = useFilter();
  const [lw, setLw] = useState(ledgerWise);
  const data = useLoad(() => budgetVariance(books.db, budgetId, period.from, period.to, groupId, lw), [period, budgetId, groupId, lw]);
  const rows = useMemo(() => (data?.rows ?? []).filter((r) => (!cfg.values.hideZero || r.budget || r.actual) && flt.match(r.name)), [data, cfg.values.hideZero, flt]);
  const { sel, setSel, keys } = useSel(rows.length);
  const open = (i: number) => {
    const r = rows[i];
    if (r?.kind === 'group') nav.push(<BudgetVarianceReport budgetId={budgetId} groupId={r.id} />);
  };
  const toggle = () => setLw((x) => !x);
  useScreen({
    title: 'Budget Variance',
    keys: { ...keys, ...p.key, ...cfg.key, ...flt.key, Enter: () => open(sel), F5: toggle },
    buttons: [p.button, { key: 'F5', label: lw ? 'Group-wise' : 'Ledger-wise', run: toggle }, cfg.button, flt.button],
  });
  const name = data?.budget.name ?? '';
  const side = (r: { budget: number; actual: number }) => (r.actual !== 0 ? r.actual : r.budget);
  const group = (label: string, italic = false) => (
    <th className={`${th} text-center ${italic ? 'italic font-normal' : ''}`} colSpan={2}>
      {label}
    </th>
  );
  return (
    <Frame title={data?.title === 'Trial Balance' || lw ? 'Trial Balance' : (data?.title ?? '')} subtitle={`${name}, ${fmtDate(period.from)} to ${fmtDate(period.to)}`}>
      {flt.bar}
      <table className="w-full">
        <thead>
          <tr className="text-left">
            <th className={th} rowSpan={3}>
              Particulars
            </th>
            {group(name, true)}
            {group('Actuals', true)}
            {group(`${name} Variance`, true)}
          </tr>
          <tr>
            {group('Closing Balance')}
            {group('Closing Balance')}
            {group('Closing Balance')}
          </tr>
          <tr>
            {[0, 1, 2].map((k) => [
              <th key={`${k}d`} className={`${th} text-right font-normal`}>
                Debit
              </th>,
              <th key={`${k}c`} className={`${th} text-right font-normal`}>
                Credit
              </th>,
            ])}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.kind}-${r.id}`} className={rowCls(i === sel, r.kind === 'group' ? 'font-bold' : '')} onMouseEnter={() => setSel(i)} onClick={() => open(i)}>
              <td className="px-2">{r.name}</td>
              <td className={num}>{dr(r.budget)}</td>
              <td className={num}>{cr(r.budget)}</td>
              <td className={num}>{dr(r.actual)}</td>
              <td className={num}>{cr(r.actual)}</td>
              <td className={num}>{varDr(r.variance, side(r))}</td>
              <td className={num}>{varCr(r.variance, side(r))}</td>
            </tr>
          ))}
          {data && (
            <tr className="font-bold">
              <td className="border-y-[3px] border-double border-tb-ink px-2">Grand Total</td>
              <td className={tot}>{dr(data.total.budget)}</td>
              <td className={tot}>{cr(data.total.budget)}</td>
              <td className={tot}>{dr(data.total.actual)}</td>
              <td className={tot}>{cr(data.total.actual)}</td>
              <td className={tot}>{varDr(data.total.variance, data.total.actual)}</td>
              <td className={tot}>{varCr(data.total.variance, data.total.actual)}</td>
            </tr>
          )}
        </tbody>
      </table>
      {data && rows.length === 0 && <div className="py-3 text-tb-muted">{flt.active ? 'No rows match the filter.' : 'No budget has been set for this group.'}</div>}
    </Frame>
  );
}

export function CostCentreBudgetVarianceReport({ budgetId }: { budgetId: number }) {
  const { books, period } = useStore();
  const p = usePeriodKey();
  const flt = useFilter();
  const data = useLoad(() => costCentreBudgetVariance(books.db, budgetId, period.from, period.to), [period, budgetId]);
  const rows = useMemo(() => (data?.rows ?? []).filter((r) => flt.match(r.name)), [data, flt]);
  const { sel, setSel, keys } = useSel(rows.length);
  useScreen({ title: 'Cost Centre Budget Variance', keys: { ...keys, ...p.key, ...flt.key }, buttons: [p.button, flt.button] });
  const grp = (label: string) => (
    <th className={`${th} text-center`} colSpan={2}>
      {label}
    </th>
  );
  const pair = (a: number, b: number) => [
    <td key="a" className={num}>
      {fmtAmount(a)}
    </td>,
    <td key="b" className={num}>
      {fmtAmount(b)}
    </td>,
  ];
  return (
    <Frame title="Cost Centre Budget Variance" subtitle={`${data?.budget.name ?? ''}, ${fmtDate(period.from)} to ${fmtDate(period.to)}`}>
      {flt.bar}
      <table className="w-full">
        <thead>
          <tr className="text-left">
            <th className={th} rowSpan={2}>
              Cost Centre
            </th>
            {grp('Expenses')}
            {grp('Income')}
            {grp('Closing Balance')}
            <th className={`${th} text-right`} rowSpan={2}>
              Variance
            </th>
          </tr>
          <tr>
            {[0, 1, 2].map((k) => [
              <th key={`${k}b`} className={`${th} text-right font-normal`}>
                Budget
              </th>,
              <th key={`${k}a`} className={`${th} text-right font-normal`}>
                Actual
              </th>,
            ])}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id} className={rowCls(i === sel)} onMouseEnter={() => setSel(i)}>
              <td className="px-2 font-bold">{r.name}</td>
              {pair(r.exp_budget, r.exp_actual)}
              {pair(r.inc_budget, r.inc_actual)}
              <td className={num}>{fmtDrCr(r.closing_budget)}</td>
              <td className={num}>{fmtDrCr(r.closing_actual)}</td>
              <td className={num}>{r.variance ? `${r.variance < 0 ? '(-)' : ''}${fmtAmount(Math.abs(r.variance))}` : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data && rows.length === 0 && <div className="py-3 text-tb-muted">No Cost Centre budgets set.</div>}
    </Frame>
  );
}
