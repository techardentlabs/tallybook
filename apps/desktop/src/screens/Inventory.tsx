import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createGodown,
  createStockGroup,
  COSTING_METHODS,
  createStockCategory,
  createStockItem,
  stockCategories,
  type StockCategory,
  createUnit,
  deleteStockItem,
  fmtAmount,
  fmtDate,
  fmtQty,
  godowns,
  parseQty,
  stockGroups,
  stockItem,
  stockItemVouchers,
  stockItems,
  stockSummary,
  units,
  updateStockItem,
  type Godown,
  type StockGroup,
  type StockItem,
  type Unit,
} from '@tallybook/core';
import { Form, type FieldDef, type FormHandle } from '../ui/Form.tsx';
import type { Opt } from '../ui/PickerInput.tsx';
import { useScreen } from '../registry.ts';
import { useStore } from '../store.tsx';
import { useNav } from '../nav.tsx';
import { BomListScreen } from './Manufacturing.tsx';
import { useDialogs } from '../ui/Dialogs.tsx';
import { SelectList } from './SelectList.tsx';
import { Frame, th, rowCls, useLoad, usePeriodKey, useSel } from './Reports.tsx';
import { GST_RATES_BP, rateLabel } from '../lib.ts';

function useList<T>(fn: () => Promise<T[]>): T[] {
  const { version } = useStore();
  const [rows, setRows] = useState<T[]>([]);
  useEffect(() => void fn().then(setRows), [version]);
  return rows;
}

function SimpleMaster({
  title,
  fields,
  onSave,
  onDelete,
}: {
  title: string;
  fields: FieldDef[];
  onSave: (v: Record<string, unknown>) => Promise<void>;
  onDelete?: () => Promise<void>;
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
      toast(`${title.replace(/ (Creation|Alteration)$/, '')} saved`, 'ok');
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

export function UnitForm() {
  const { books } = useStore();
  return (
    <SimpleMaster
      title="Unit Creation"
      fields={[
        { key: 'symbol', label: 'Symbol', kind: 'text', required: true },
        { key: 'formal', label: 'Formal name', kind: 'text' },
        { key: 'dec', label: 'Number of decimal places', kind: 'text', initial: '0' },
      ]}
      onSave={async (v) => void (await createUnit(books.db, { symbol: String(v.symbol), formal_name: String(v.formal), decimals: Number(v.dec) || 0 }))}
    />
  );
}

export function StockGroupForm() {
  const { books } = useStore();
  const groups = useList<StockGroup>(() => stockGroups(books.db));
  const opts: Opt[] = [{ id: 0, label: 'Primary' }, ...groups.map((g) => ({ id: g.id, label: g.name }))];
  return (
    <SimpleMaster
      title="Stock Group Creation"
      fields={[
        { key: 'name', label: 'Name', kind: 'text', required: true },
        { key: 'alias', label: '(alias)', kind: 'text' },
        { key: 'parent', label: 'Under', kind: 'picker', title: 'Stock Groups', options: opts, initial: opts[0], required: true },
      ]}
      onSave={async (v) => void (await createStockGroup(books.db, { name: String(v.name), alias: String(v.alias), parent_id: Number(v.parent) || null }))}
    />
  );
}

export function StockCategoryForm() {
  const { books } = useStore();
  const list = useList<StockCategory>(() => stockCategories(books.db));
  const opts: Opt[] = [{ id: 0, label: 'Primary' }, ...list.map((c) => ({ id: c.id, label: c.name }))];
  return (
    <SimpleMaster
      title="Stock Category Creation"
      fields={[
        { key: 'name', label: 'Name', kind: 'text', required: true },
        { key: 'parent', label: 'Under', kind: 'picker', title: 'Stock Categories', options: opts, initial: opts[0], required: true },
      ]}
      onSave={async (v) => void (await createStockCategory(books.db, { name: String(v.name), parent_id: Number(v.parent) || null }))}
    />
  );
}

export function GodownForm() {
  const { books } = useStore();
  const list = useList<Godown>(() => godowns(books.db));
  const opts: Opt[] = [{ id: 0, label: 'Primary' }, ...list.map((g) => ({ id: g.id, label: g.name }))];
  return (
    <SimpleMaster
      title="Godown Creation"
      fields={[
        { key: 'name', label: 'Name', kind: 'text', required: true },
        { key: 'parent', label: 'Under', kind: 'picker', title: 'Godowns', options: opts, initial: opts[0], required: true },
      ]}
      onSave={async (v) => void (await createGodown(books.db, { name: String(v.name), parent_id: Number(v.parent) || null }))}
    />
  );
}

export function StockItemForm({ id, presetName }: { id?: number; presetName?: string }) {
  const { books, company } = useStore();
  const nav = useNav();
  const allUnits = useList<Unit>(() => units(books.db));
  const groups = useList<StockGroup>(() => stockGroups(books.db));
  const cats = useList<StockCategory>(() => stockCategories(books.db));
  const [cur, setCur] = useState<StockItem | null | undefined>(id ? undefined : null);
  useEffect(() => {
    if (id) void stockItem(books.db, id).then(setCur);
  }, [books, id]);
  if (cur === undefined || !allUnits.length) return null;
  const unitOpts: Opt[] = allUnits.map((u) => ({ id: u.id, label: u.symbol, sub: u.formal_name }));
  const groupOpts: Opt[] = [{ id: 0, label: 'Primary' }, ...groups.map((g) => ({ id: g.id, label: g.name }))];
  const catOpts: Opt[] = [{ id: 0, label: 'Not Applicable' }, ...cats.map((c) => ({ id: c.id, label: c.name }))];
  const altOpts: Opt[] = [{ id: 0, label: 'Not Applicable' }, ...allUnits.map((u) => ({ id: u.id, label: u.symbol, sub: u.formal_name }))];
  const pk = (title: string, key: string, list: string[], val: string | undefined, label: string, extra: Partial<FieldDef> = {}): FieldDef => ({ key, label, kind: 'picker', title, options: list.map((n) => ({ id: n, label: n })), initial: val ? { id: val, label: val } : undefined, ...extra });
  const rateOpts: Opt[] = GST_RATES_BP.map((r) => ({ id: r, label: rateLabel(r) }));
  const fields: FieldDef[] = [
    { key: 'name', label: 'Name', kind: 'text', required: true, initial: cur?.name ?? presetName },
    { key: 'alias', label: '(alias)', kind: 'text', initial: cur?.alias },
    { key: 'part_no', label: 'Part no.', kind: 'text', initial: cur?.part_no },
    { key: 'group', label: 'Under', kind: 'picker', title: 'Stock Groups', options: groupOpts, initial: groupOpts.find((g) => g.id === (cur?.group_id ?? 0)), required: true },
    { key: 'category', label: 'Category', kind: 'picker', title: 'Stock Categories', options: catOpts, initial: catOpts.find((c) => c.id === (cur?.category_id ?? 0)), required: true },
    { key: 'unit', label: 'Units', kind: 'picker', title: 'Units', options: unitOpts, initial: unitOpts.find((u) => u.id === (cur?.unit_id ?? 1)), required: true },
    { key: 'alt_unit', label: 'Alternate units', kind: 'picker', title: 'Units', options: altOpts, initial: altOpts.find((u) => u.id === (cur?.alt_unit_id ?? 0)), required: true },
    { key: 'alt_conv', label: 'Conversion (1 alternate unit = base units)', kind: 'text', initial: cur?.alt_conversion ? fmtQty(cur.alt_conversion) : '', visible: (v) => !!v.alt_unit },
    pk('Costing Methods', 'costing_method', [...COSTING_METHODS], cur?.costing_method || 'Avg Cost', 'Costing method', { required: true }),
    pk('Market Valuation Methods', 'market_method', ['Not Applicable', 'Average Price', 'Last Sale Price', 'Last Purchase Price'], cur?.market_method || 'Not Applicable', 'Market valuation method', { required: true }),
    { key: 'set_bom', label: id ? 'Alter Components (BOM)' : 'Set Components (BOM)', kind: 'toggle', initial: false },
    { key: 'maintain_batches', label: 'Maintain in batches', kind: 'toggle', initial: !!cur?.maintain_batches },
    { key: 'track_expiry', label: 'Track date of manufacturing / expiry', kind: 'toggle', initial: !!cur?.track_expiry, visible: (v) => !!v.maintain_batches },
    { key: 'enable_cost_tracking', label: 'Enable cost tracking', kind: 'toggle', initial: !!cur?.enable_cost_tracking },
    { key: 'reorder', label: 'Reorder level', kind: 'text', initial: cur?.reorder_qty ? fmtQty(cur.reorder_qty) : '' },
    { key: 'min_order', label: 'Minimum order quantity', kind: 'text', initial: cur?.min_order_qty ? fmtQty(cur.min_order_qty) : '' },
    { key: 'std_cost', label: 'Standard cost', kind: 'amount', initial: cur?.standard_cost || undefined },
    { key: 'description', label: 'Description', kind: 'text', initial: cur?.description },
    { key: 'notes', label: 'Notes', kind: 'text', initial: cur?.notes },
    ...(company?.gst_enabled
      ? ([
          { key: 'hsn', label: 'HSN/SAC', kind: 'text', initial: cur?.hsn_sac, heading: 'Statutory details' },
          { key: 'rate', label: 'GST rate', kind: 'picker', title: 'GST Rates', options: rateOpts, initial: rateOpts.find((r) => r.id === (cur?.rate_bp ?? 0)), required: true },
        ] as FieldDef[])
      : []),
    { key: 'qty', label: 'Quantity', kind: 'text', initial: cur?.opening_qty ? fmtQty(cur.opening_qty) : '', heading: 'Opening balance' },
    { key: 'rate_each', label: 'Rate', kind: 'amount', initial: cur?.opening_rate || undefined },
    { key: 'value', label: 'Value', kind: 'amount', initial: cur?.opening_value || undefined },
    { key: 'price', label: 'Standard selling price', kind: 'amount', initial: cur?.standard_price || undefined, heading: 'Pricing' },
  ];
  return (
    <SimpleMaster
      title={id ? 'Stock Item Alteration' : 'Stock Item Creation'}
      fields={fields}
      onSave={async (v) => {
        const qty = parseQty(String(v.qty || '0'));
        if (qty === null) throw new Error('Quantity: enter a valid number');
        const rate = Number(v.rate_each) || 0;
        const value = Number(v.value) || Math.round((qty * rate) / 1000);
        const input = {
          name: String(v.name),
          alias: String(v.alias),
          group_id: Number(v.group) || null,
          unit_id: Number(v.unit),
          category_id: Number(v.category) || null,
          alt_unit_id: Number(v.alt_unit) || 0,
          alt_conversion: parseQty(String(v.alt_conv || '0')) ?? 0,
          costing_method: String(v.costing_method || 'Avg Cost'),
          market_method: String(v.market_method || ''),
          maintain_batches: v.maintain_batches ? 1 : 0,
          track_expiry: v.track_expiry ? 1 : 0,
          enable_cost_tracking: v.enable_cost_tracking ? 1 : 0,
          reorder_qty: parseQty(String(v.reorder || '0')) ?? 0,
          min_order_qty: parseQty(String(v.min_order || '0')) ?? 0,
          standard_cost: Number(v.std_cost) || 0,
          part_no: String(v.part_no ?? ''),
          description: String(v.description ?? ''),
          notes: String(v.notes ?? ''),
          hsn_sac: String(v.hsn ?? ''),
          rate_bp: Number(v.rate ?? 0),
          opening_qty: qty,
          opening_rate: rate,
          opening_value: value,
          standard_price: Number(v.price) || 0,
        };
        const savedId = id ? (await updateStockItem(books.db, id, input), id) : (await createStockItem(books.db, input)).id;
        if (v.set_bom) setTimeout(() => nav.push(<BomListScreen itemId={savedId} />), 0);
      }}
      onDelete={id ? () => deleteStockItem(books.db, id) : undefined}
    />
  );
}

export function PickStockItem({ title, onPick }: { title: string; onPick: (i: StockItem) => void }) {
  const { books } = useStore();
  const nav = useNav();
  const items = useList<StockItem>(() => stockItems(books.db));
  return (
    <SelectList
      title={title}
      heading="List of Stock Items"
      popOnSelect
      items={items.map((i) => ({ id: i.id, label: i.name }))}
      onSelect={(i) => onPick(items.find((x) => x.id === i.id)!)}
      onCreate={() => nav.push(<StockItemForm />)}
    />
  );
}

export function StockSummaryReport() {
  const { books, period } = useStore();
  const nav = useNav();
  const p = usePeriodKey();
  const data = useLoad(() => stockSummary(books.db, period.from, period.to), [period]);
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const { sel, setSel, keys } = useSel(rows.length);
  useScreen({
    title: 'Stock Summary',
    keys: { ...keys, ...p.key, Enter: () => rows[sel] && nav.push(<StockItemReport itemId={rows[sel].item_id} />) },
    buttons: [p.button],
  });
  if (!data) return null;
  const cell = 'px-2 text-right tabular-nums';
  return (
    <Frame title="Stock Summary" subtitle={`${fmtDate(period.from)} to ${fmtDate(period.to)}`}>
      <table className="w-full">
        <thead>
          <tr>
            <th className={`${th} text-left`} rowSpan={2}>Particulars</th>
            <th className={`${th} text-center`} colSpan={3}>Closing Balance</th>
          </tr>
          <tr>
            <th className={`${th} text-right`}>Quantity</th>
            <th className={`${th} text-right`}>Rate</th>
            <th className={`${th} text-right`}>Value</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.item_id} className={rowCls(i === sel, 'font-bold')} onMouseEnter={() => setSel(i)} onClick={() => nav.push(<StockItemReport itemId={r.item_id} />)}>
              <td className="px-2">{r.name}</td>
              <td className={cell}>{r.closing_qty ? fmtQty(r.closing_qty, 0, r.unit) : ''}</td>
              <td className={cell}>{r.closing_rate ? fmtAmount(r.closing_rate, false) : ''}</td>
              <td className={cell}>{r.closing_value ? fmtAmount(r.closing_value, false) : ''}</td>
            </tr>
          ))}
          <tr className="font-bold">
            <td className="border-y-[3px] border-double border-tb-ink px-2">Grand Total</td>
            <td className="border-y-[3px] border-double border-tb-ink" colSpan={2} />
            <td className={`${cell} border-y-[3px] border-double border-tb-ink`}>{fmtAmount(data.closing_value, false)}</td>
          </tr>
        </tbody>
      </table>
      {rows.length === 0 && <div className="py-3 text-tb-muted">No stock items. Create one from Gateway of Tally &gt; Create &gt; Stock Item.</div>}
    </Frame>
  );
}

export function StockItemReport({ itemId }: { itemId: number }) {
  const { books, period } = useStore();
  const p = usePeriodKey();
  const item = useLoad(() => stockItem(books.db, itemId), [itemId]);
  const data = useLoad(() => stockItemVouchers(books.db, itemId, period.from, period.to), [itemId, period]);
  useScreen({ title: 'Stock Item Vouchers', keys: { ...p.key }, buttons: [p.button] });
  if (!item || !data) return null;
  const cell = 'px-2 text-right tabular-nums';
  return (
    <Frame title={item.name} subtitle={`Stock Item Vouchers: ${fmtDate(period.from)} to ${fmtDate(period.to)}`}>
      <table className="w-full">
        <thead>
          <tr>
            <th className={`${th} text-left`}>Date</th>
            <th className={`${th} text-left`}>Particulars</th>
            <th className={`${th} text-left`}>Vch Type</th>
            <th className={`${th} text-left`}>Vch No.</th>
            <th className={`${th} text-right`}>Inwards</th>
            <th className={`${th} text-right`}>Outwards</th>
            <th className={`${th} text-right`}>Rate</th>
          </tr>
        </thead>
        <tbody>
          <tr className="italic">
            <td className="px-2" colSpan={4}>Opening Balance</td>
            <td className={cell}>{fmtQty(data.opening_qty, 0, item.unit)}</td>
            <td />
            <td />
          </tr>
          {data.rows.map((r, i) => (
            <tr key={i}>
              <td className="px-2">{fmtDate(r.date)}</td>
              <td className="px-2 font-bold">{r.party}</td>
              <td className="px-2">{r.type}</td>
              <td className="px-2">{r.number}</td>
              <td className={cell}>{r.qty > 0 ? fmtQty(r.qty, 0, item.unit) : ''}</td>
              <td className={cell}>{r.qty < 0 ? fmtQty(-r.qty, 0, item.unit) : ''}</td>
              <td className={cell}>{fmtAmount(r.rate, false)}</td>
            </tr>
          ))}
          <tr className="font-bold">
            <td className="border-y-[3px] border-double border-tb-ink px-2" colSpan={4}>Closing Balance</td>
            <td className={`${cell} border-y-[3px] border-double border-tb-ink`}>{fmtQty(data.closing_qty, 0, item.unit)}</td>
            <td className="border-y-[3px] border-double border-tb-ink" colSpan={2} />
          </tr>
        </tbody>
      </table>
    </Frame>
  );
}
