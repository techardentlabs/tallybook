import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  costCategories,
  costCategory,
  costCategorySummary,
  costCentre,
  costCentreBreakup,
  costCentreMonthly,
  costCentres,
  costCentreSummary,
  costCentreVouchers,
  createCostCategory,
  createCostCentre,
  deleteCostCategory,
  deleteCostCentre,
  fmtAmount,
  fmtDate,
  fmtDrCr,
  updateCostCategory,
  updateCostCentre,
  type CostCategory,
  type CostCentre,
  type CostRow,
} from '@tallybook/core';
import { useScreen } from '../registry.ts';
import { useStore } from '../store.tsx';
import { useNav } from '../nav.tsx';
import { useDialogs } from '../ui/Dialogs.tsx';
import { Form, type FieldDef, type FormHandle } from '../ui/Form.tsx';
import type { Opt } from '../ui/PickerInput.tsx';
import { SelectList } from './SelectList.tsx';
import { Frame, rowCls, th, useLoad, usePeriodKey, useSel } from './Reports.tsx';
import { useFilter, useReportOptions } from './reportConfig.tsx';
import { VoucherScreen } from './Voucher.tsx';

export function useList<T>(fn: () => Promise<T[]>): T[] {
  const { version } = useStore();
  const [rows, setRows] = useState<T[]>([]);
  useEffect(() => void fn().then(setRows), [version]);
  return rows;
}

export function MasterShell({
  title,
  fields,
  onSave,
  onDelete,
  saved,
}: {
  title: string;
  fields: FieldDef[];
  onSave: (v: Record<string, unknown>) => Promise<void>;
  onDelete?: () => Promise<void>;
  saved: string;
}) {
  const { bump, toast } = useStore();
  const nav = useNav();
  const dialogs = useDialogs();
  const form = useRef<FormHandle>(null);
  const save = async () => {
    const v = form.current?.submit();
    if (!v) return;
    try {
      await onSave(v);
      bump();
      toast(`${saved} saved`, 'ok');
      nav.pop();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  const remove = async () => {
    if (!onDelete || !(await dialogs.confirm('Delete ?', { title: 'Delete', def: false }))) return;
    try {
      await onDelete();
      bump();
      toast('Deleted', 'ok');
      nav.pop();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  useScreen({
    title,
    noPeriod: true,
    keys: { 'Ctrl+A': () => void save(), 'Alt+D': onDelete ? () => void remove() : () => false },
    buttons: [{ key: 'Ctrl+A', label: 'Accept', run: () => void save() }, ...(onDelete ? [{ key: 'Alt+D', label: 'Delete', run: () => void remove() }] : [])],
  });
  return (
    <div className="max-w-xl">
      <Form ref={form} fields={fields} onDone={() => void save()} />
    </div>
  );
}

export function CostCategoryForm({ id, presetName }: { id?: number; presetName?: string }) {
  const { books } = useStore();
  const [cur, setCur] = useState<CostCategory | null | undefined>(id ? undefined : null);
  useEffect(() => {
    if (id) void costCategory(books.db, id).then(setCur);
  }, [books, id]);
  if (cur === undefined) return null;
  const fields: FieldDef[] = [
    { key: 'name', label: 'Name', kind: 'text', required: true, initial: cur?.name ?? presetName },
    { key: 'alias', label: '(alias)', kind: 'text', initial: cur?.alias },
    { key: 'rev', label: 'Allocate Revenue Items', kind: 'toggle', initial: cur ? !!cur.alloc_revenue : true },
    { key: 'nonrev', label: 'Allocate Non-revenue items', kind: 'toggle', initial: cur ? !!cur.alloc_non_revenue : false },
  ];
  return (
    <MasterShell
      title={cur ? 'Cost Category Alteration' : 'Cost Category Creation'}
      saved="Cost Category"
      fields={fields}
      onSave={async (v) => {
        const input = { name: String(v.name), alias: String(v.alias), alloc_revenue: !!v.rev, alloc_non_revenue: !!v.nonrev };
        if (cur) await updateCostCategory(books.db, cur.id, input);
        else await createCostCategory(books.db, input);
      }}
      onDelete={cur && cur.id !== 1 ? async () => deleteCostCategory(books.db, cur.id) : undefined}
    />
  );
}

export function CostCentreForm({ id, presetName }: { id?: number; presetName?: string }) {
  const { books } = useStore();
  const [cur, setCur] = useState<CostCentre | null | undefined>(id ? undefined : null);
  const all = useList<CostCentre>(() => costCentres(books.db));
  const cats = useList<CostCategory>(() => costCategories(books.db));
  useEffect(() => {
    if (id) void costCentre(books.db, id).then(setCur);
  }, [books, id]);
  if (cur === undefined || !cats.length) return null;
  const under: Opt[] = [{ id: 0, label: 'Primary' }, ...all.filter((c) => c.id !== cur?.id).map((c) => ({ id: c.id, label: c.name }))];
  const catOpts: Opt[] = cats.map((k) => ({ id: k.id, label: k.name }));
  const fields: FieldDef[] = [
    { key: 'name', label: 'Name', kind: 'text', required: true, initial: cur?.name ?? presetName },
    { key: 'alias', label: '(alias)', kind: 'text', initial: cur?.alias },
    { key: 'under', label: 'Under', kind: 'picker', title: 'Cost Centres', options: under, initial: under.find((o) => o.id === (cur?.parent_id ?? 0)), required: true },
    { key: 'category', label: 'Cost Category', kind: 'picker', title: 'Cost Categories', options: catOpts, initial: catOpts.find((o) => o.id === (cur?.category_id ?? 1)), required: true, visible: () => cats.length > 1 },
    { key: 'opening', label: 'Show opening balance for revenue items in reports', kind: 'toggle', initial: !!cur?.show_opening },
  ];
  return (
    <MasterShell
      title={cur ? 'Cost Centre Alteration' : 'Cost Centre Creation'}
      saved="Cost Centre"
      fields={fields}
      onSave={async (v) => {
        const input = { name: String(v.name), alias: String(v.alias), parent_id: Number(v.under) || null, category_id: Number(v.category) || 1, show_opening: !!v.opening };
        if (cur) await updateCostCentre(books.db, cur.id, input);
        else await createCostCentre(books.db, input);
      }}
      onDelete={cur ? async () => deleteCostCentre(books.db, cur.id) : undefined}
    />
  );
}

export function PickCostCentre({ title = 'Cost Centre', onPick, popOnSelect = true }: { title?: string; onPick: (c: CostCentre) => void; popOnSelect?: boolean }) {
  const { books } = useStore();
  const nav = useNav();
  const items = useList<CostCentre>(() => costCentres(books.db));
  return (
    <SelectList
      title={title}
      heading="List of Cost Centres"
      popOnSelect={popOnSelect}
      items={items.map((c) => ({ id: c.id, label: c.name, sub: c.parent ?? undefined }))}
      onSelect={(i) => onPick(items.find((c) => c.id === i.id)!)}
      onCreate={() => nav.push(<CostCentreForm />)}
    />
  );
}

export function PickCostCategory({ title = 'Cost Category', onPick, popOnSelect = true }: { title?: string; onPick: (c: CostCategory) => void; popOnSelect?: boolean }) {
  const { books } = useStore();
  const nav = useNav();
  const items = useList<CostCategory>(() => costCategories(books.db));
  return (
    <SelectList
      title={title}
      heading="List of Cost Categories"
      popOnSelect={popOnSelect}
      items={items.map((c) => ({ id: c.id, label: c.name }))}
      onSelect={(i) => onPick(items.find((c) => c.id === i.id)!)}
      onCreate={() => nav.push(<CostCategoryForm />)}
    />
  );
}

export function AlterCostCentres() {
  const nav = useNav();
  return <PickCostCentre title="Cost Centre Alteration" popOnSelect={false} onPick={(c) => nav.push(<CostCentreForm id={c.id} />)} />;
}

export function AlterCostCategories() {
  const nav = useNav();
  return <PickCostCategory title="Cost Category Alteration" popOnSelect={false} onPick={(c) => nav.push(<CostCategoryForm id={c.id} />)} />;
}

const num = 'px-2 text-right tabular-nums';
const tot = 'border-y-[3px] border-double border-tb-ink px-2 text-right tabular-nums';
const totLabel = 'border-y-[3px] border-double border-tb-ink px-2';

const SUM_DEFS = [
  { key: 'hideZero', label: 'Hide Cost Centres with no transactions', default: false },
  { key: 'closing', label: 'Show closing balances', default: true },
];

function SummaryScreen({
  title,
  subtitle,
  rows,
  total,
  onOpen,
  cfgKey,
}: {
  title: string;
  subtitle?: string;
  rows: CostRow[] | null;
  total: { debit: number; credit: number; closing: number } | null;
  onOpen: (r: CostRow) => void;
  cfgKey: string;
}) {
  const p = usePeriodKey();
  const cfg = useReportOptions(cfgKey, title, SUM_DEFS);
  const flt = useFilter();
  const shown = useMemo(() => (rows ?? []).filter((r) => (!cfg.values.hideZero || r.debit || r.credit || r.closing) && flt.match(r.name)), [rows, cfg.values.hideZero, flt]);
  const { sel, setSel, keys } = useSel(shown.length);
  const open = (i: number) => shown[i] && onOpen(shown[i]);
  useScreen({
    title,
    keys: { ...keys, ...p.key, ...cfg.key, ...flt.key, Enter: () => open(sel) },
    buttons: [p.button, cfg.button, flt.button],
  });
  const showClosing = cfg.values.closing;
  return (
    <Frame title={title} subtitle={subtitle}>
      {flt.bar}
      <table className="w-full">
        <thead>
          <tr className="text-left">
            <th className={th} rowSpan={2}>
              Particulars
            </th>
            <th className={`${th} text-center`} colSpan={2}>
              Transactions
            </th>
            {showClosing && (
              <th className={`${th} text-right`} rowSpan={2}>
                Closing Balance
              </th>
            )}
          </tr>
          <tr>
            <th className={`${th} text-right font-normal`}>Debit</th>
            <th className={`${th} text-right font-normal`}>Credit</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r, i) => (
            <tr key={`${r.kind}-${r.id}-${i}`} className={rowCls(i === sel, r.kind === 'category' || (r.kind === 'group' && r.depth === 0) ? 'font-bold' : r.kind === 'centre' && r.depth > 0 ? 'italic' : '')} onMouseEnter={() => setSel(i)} onClick={() => open(i)}>
              <td className="px-2" style={{ paddingLeft: 8 + r.depth * 18 }}>
                {r.name}
              </td>
              <td className={num}>{fmtAmount(r.debit)}</td>
              <td className={num}>{fmtAmount(r.credit)}</td>
              {showClosing && <td className={num}>{fmtDrCr(r.closing)}</td>}
            </tr>
          ))}
          {total && (
            <tr className="font-bold">
              <td className={totLabel}>Grand Total</td>
              <td className={tot}>{fmtAmount(total.debit, false)}</td>
              <td className={tot}>{fmtAmount(total.credit, false)}</td>
              {showClosing && <td className={tot}>{fmtDrCr(total.closing)}</td>}
            </tr>
          )}
        </tbody>
      </table>
      {rows && shown.length === 0 && <div className="py-3 text-tb-muted">{flt.active ? 'No rows match the filter.' : 'No cost allocations in this period.'}</div>}
    </Frame>
  );
}

export function CostCentreSummaryReport({ categoryId = null }: { categoryId?: number | null }) {
  const { books, period } = useStore();
  const nav = useNav();
  const data = useLoad(() => costCentreSummary(books.db, period.from, period.to, categoryId), [period, categoryId]);
  return (
    <SummaryScreen
      title="Cost Centre Summary"
      cfgKey="cost-centre-summary"
      rows={data?.rows ?? null}
      total={data?.total ?? null}
      onOpen={(r) => nav.push(<CostCentreMonthlyReport centreId={r.id} includeChildren={r.kind !== 'own'} />)}
    />
  );
}

export function CostCategorySummaryReport() {
  const { books, period } = useStore();
  const nav = useNav();
  const data = useLoad(() => costCategorySummary(books.db, period.from, period.to), [period]);
  return (
    <SummaryScreen
      title="Cost Category Summary"
      cfgKey="cost-category-summary"
      rows={data?.rows ?? null}
      total={data?.total ?? null}
      onOpen={(r) => nav.push(r.kind === 'category' ? <CostCentreSummaryReport categoryId={r.id} /> : <CostCentreMonthlyReport centreId={r.id} includeChildren={r.kind !== 'own'} />)}
    />
  );
}

export function CostCentreMonthlyReport({ centreId, includeChildren = true }: { centreId: number; includeChildren?: boolean }) {
  const { books, period } = useStore();
  const nav = useNav();
  const p = usePeriodKey();
  const cfg = useReportOptions('cost-centre-monthly', 'Cost Centre Monthly Summary', SUM_DEFS);
  const flt = useFilter();
  const data = useLoad(() => costCentreMonthly(books.db, centreId, period.from, period.to, includeChildren), [period, centreId, includeChildren]);
  const rows = useMemo(() => (data?.rows ?? []).filter((r) => (!cfg.values.hideZero || r.debit || r.credit) && flt.match(r.label)), [data, cfg.values.hideZero, flt]);
  const { sel, setSel, keys } = useSel(rows.length);
  const open = (i: number) => rows[i] && nav.push(<CostCentreVouchersReport centreId={centreId} from={rows[i].from} to={rows[i].to} includeChildren={includeChildren} />);
  useScreen({
    title: 'Cost Centre Monthly Summary',
    keys: { ...keys, ...p.key, ...cfg.key, ...flt.key, Enter: () => open(sel) },
    buttons: [p.button, cfg.button, flt.button],
  });
  return (
    <Frame title="Cost Centre Monthly Summary" subtitle={data ? `${data.centre.name}, ${fmtDate(period.from)} to ${fmtDate(period.to)}` : ''}>
      {flt.bar}
      <table className="w-full">
        <thead>
          <tr className="text-left">
            <th className={th} rowSpan={2}>
              Particulars
            </th>
            <th className={`${th} text-center`} colSpan={2}>
              Transactions
            </th>
            {cfg.values.closing && (
              <th className={`${th} text-right`} rowSpan={2}>
                Closing Balance
              </th>
            )}
          </tr>
          <tr>
            <th className={`${th} text-right font-normal`}>Debit</th>
            <th className={`${th} text-right font-normal`}>Credit</th>
          </tr>
        </thead>
        <tbody>
          <tr className="italic">
            <td className="px-2">Opening Balance</td>
            <td className={num} />
            <td className={num} />
            {cfg.values.closing && <td className={num}>{data ? fmtDrCr(data.opening) : ''}</td>}
          </tr>
          {rows.map((r, i) => (
            <tr key={r.month} className={rowCls(i === sel, 'font-bold')} onMouseEnter={() => setSel(i)} onClick={() => open(i)}>
              <td className="px-2">{r.label}</td>
              <td className={num}>{fmtAmount(r.debit)}</td>
              <td className={num}>{fmtAmount(r.credit)}</td>
              {cfg.values.closing && <td className={num}>{r.debit || r.credit ? fmtDrCr(r.closing) : ''}</td>}
            </tr>
          ))}
          {data && (
            <tr className="font-bold">
              <td className={totLabel}>Grand Total</td>
              <td className={tot}>{fmtAmount(data.total.debit, false)}</td>
              <td className={tot}>{fmtAmount(data.total.credit, false)}</td>
              {cfg.values.closing && <td className={tot}>{fmtDrCr(data.total.closing)}</td>}
            </tr>
          )}
        </tbody>
      </table>
    </Frame>
  );
}

export function CostCentreVouchersReport({ centreId, from, to, includeChildren = true }: { centreId: number; from: string; to: string; includeChildren?: boolean }) {
  const { books } = useStore();
  const nav = useNav();
  const p = usePeriodKey();
  const flt = useFilter();
  const data = useLoad(() => costCentreVouchers(books.db, centreId, from, to, includeChildren), [centreId, from, to, includeChildren]);
  const lines = useMemo(() => (data?.lines ?? []).filter((l) => flt.match(l.ledger, l.type, l.number)), [data, flt]);
  const { sel, setSel, keys } = useSel(lines.length);
  const open = (i: number) => lines[i] && nav.push(<VoucherScreen voucherId={lines[i].voucher_id} />);
  useScreen({
    title: 'Cost Centre Vouchers',
    keys: { ...keys, ...flt.key, Enter: () => open(sel) },
    buttons: [p.button, flt.button],
    noPeriod: true,
  });
  return (
    <Frame title="Cost Centre Vouchers" subtitle={data ? `${data.centre.name}, ${fmtDate(from)} to ${fmtDate(to)}` : ''}>
      {flt.bar}
      <table className="w-full">
        <thead>
          <tr className="text-left">
            <th className={th}>Date</th>
            <th className={th}>Particulars</th>
            <th className={th}>Vch Type</th>
            <th className={`${th} text-right`}>Vch No.</th>
            <th className={`${th} text-right`}>Debit</th>
            <th className={`${th} text-right`}>Credit</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={`${l.entry_id}-${i}`} className={rowCls(i === sel)} onMouseEnter={() => setSel(i)} onClick={() => open(i)}>
              <td className="px-2">{fmtDate(l.date)}</td>
              <td className="px-2 font-bold">{l.ledger}</td>
              <td className="px-2 font-bold">{l.type}</td>
              <td className={num}>{l.number}</td>
              <td className={num}>{fmtAmount(l.debit)}</td>
              <td className={num}>{fmtAmount(l.credit)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data && (
        <div className="mt-3 ml-auto w-[420px] text-right">
          <FootLine label="Opening Balance :" dr={data.opening > 0 ? data.opening : 0} cr={data.opening < 0 ? -data.opening : 0} />
          <FootLine label="Current Total :" dr={data.debit} cr={data.credit} />
          <FootLine label="Closing Balance :" dr={data.closing > 0 ? data.closing : 0} cr={data.closing < 0 ? -data.closing : 0} bold />
        </div>
      )}
    </Frame>
  );
}

function FootLine({ label, dr, cr, bold }: { label: string; dr: number; cr: number; bold?: boolean }): ReactNode {
  return (
    <div className={`flex justify-end gap-3 ${bold ? 'border-t-[3px] border-double border-tb-ink font-bold' : ''}`}>
      <span className="flex-1">{label}</span>
      <span className="w-28 tabular-nums">{fmtAmount(dr)}</span>
      <span className="w-28 tabular-nums">{fmtAmount(cr)}</span>
    </div>
  );
}

export function CostCentreBreakupReport({ centreIds, groupId = null }: { centreIds: number[]; groupId?: number | null }) {
  const { books, period } = useStore();
  const nav = useNav();
  const p = usePeriodKey();
  const cfg = useReportOptions('cost-centre-breakup', 'Cost Centre Breakup', [
    { key: 'hideZero', label: 'Hide groups and ledgers with no transactions', default: true },
    { key: 'closing', label: 'Show closing balances', default: true },
  ]);
  const flt = useFilter();
  const [ids, setIds] = useState(centreIds);
  const data = useLoad(() => costCentreBreakup(books.db, ids, period.from, period.to, groupId), [period, ids, groupId]);
  const rows = useMemo(() => (data?.rows ?? []).filter((r) => flt.match(r.name)), [data, flt]);
  const { sel, setSel, keys } = useSel(rows.length);
  const open = (i: number) => {
    const r = rows[i];
    if (!r) return;
    if (r.kind === 'group') nav.push(<CostCentreBreakupReport centreIds={ids} groupId={r.id} />);
    else nav.push(<CostCentreVouchersReport centreId={ids[0]} from={period.from} to={period.to} />);
  };
  const addColumn = () => nav.push(<PickCostCentre title="Cost Centre" onPick={(c) => setIds((x) => (x.includes(c.id) ? x : [...x, c.id]))} />);
  useScreen({
    title: groupId && data ? data.title : 'Cost Centre Breakup',
    keys: { ...keys, ...p.key, ...cfg.key, ...flt.key, Enter: () => open(sel), 'Alt+C': addColumn },
    buttons: [p.button, { key: 'Alt+C', label: 'New Column', run: addColumn }, cfg.button, flt.button],
  });
  const closing = cfg.values.closing;
  const span = closing ? 3 : 2;
  return (
    <Frame title={data?.title ?? 'Cost Centre Breakup'}>
      {flt.bar}
      <table className="w-full">
        <thead>
          <tr className="text-left">
            <th className={th} rowSpan={3}>
              Particulars
            </th>
            {(data?.centres ?? []).map((c) => (
              <th key={c.id} className={`${th} text-center italic font-normal`} colSpan={span}>
                Cost Centre: {c.name}
              </th>
            ))}
          </tr>
          <tr>
            {(data?.centres ?? []).map((c) => [
              <th key={`${c.id}t`} className={`${th} text-center`} colSpan={2}>
                Transactions
              </th>,
              closing ? (
                <th key={`${c.id}c`} className={`${th} text-right`} rowSpan={2}>
                  Closing Balance
                </th>
              ) : null,
            ])}
          </tr>
          <tr>
            {(data?.centres ?? []).map((c) => [
              <th key={`${c.id}d`} className={`${th} text-right font-normal`}>
                Debit
              </th>,
              <th key={`${c.id}r`} className={`${th} text-right font-normal`}>
                Credit
              </th>,
            ])}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.kind}-${r.id}`} className={rowCls(i === sel, r.kind === 'group' ? 'font-bold' : '')} onMouseEnter={() => setSel(i)} onClick={() => open(i)}>
              <td className="px-2">{r.name}</td>
              {r.cols.map((c, k) => [
                <td key={`${k}d`} className={num}>
                  {fmtAmount(c.debit)}
                </td>,
                <td key={`${k}r`} className={num}>
                  {fmtAmount(c.credit)}
                </td>,
                closing ? (
                  <td key={`${k}c`} className={num}>
                    {fmtDrCr(c.closing)}
                  </td>
                ) : null,
              ])}
            </tr>
          ))}
          {data && (
            <tr className="font-bold">
              <td className={totLabel}>Grand Total</td>
              {data.total.map((c, k) => [
                <td key={`${k}d`} className={tot}>
                  {fmtAmount(c.debit, false)}
                </td>,
                <td key={`${k}r`} className={tot}>
                  {fmtAmount(c.credit, false)}
                </td>,
                closing ? (
                  <td key={`${k}c`} className={tot}>
                    {fmtDrCr(c.closing)}
                  </td>
                ) : null,
              ])}
            </tr>
          )}
        </tbody>
      </table>
    </Frame>
  );
}

export function CostCentreBreakupEntry() {
  const nav = useNav();
  return <PickCostCentre title="Cost Centre Breakup" popOnSelect onPick={(c) => nav.push(<CostCentreBreakupReport centreIds={[c.id]} />)} />;
}
