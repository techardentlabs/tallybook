import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createPriceLevel,
  deletePriceLevel,
  fmtAmount,
  fmtDate,
  fmtQty,
  parseAmount,
  parseQty,
  priceLevels,
  priceList,
  renamePriceLevel,
  revisePriceList,
  setItemPriceList,
  stockCategories,
  stockGroups,
  type PriceLevel,
  type PriceListRow,
  type PriceSlab,
  type ReviseMode,
} from '@tallybook/core';
import { Form, type FieldDef, type FormHandle } from '../ui/Form.tsx';
import type { Opt } from '../ui/PickerInput.tsx';
import { useScreen } from '../registry.ts';
import { useStore } from '../store.tsx';
import { useNav } from '../nav.tsx';
import { useDialogs } from '../ui/Dialogs.tsx';
import { SelectList } from './SelectList.tsx';
import { Frame, th, useLoad } from './Reports.tsx';

export function usePriceLevelOptions(): Opt[] {
  const { books, version } = useStore();
  const [levels, setLevels] = useState<PriceLevel[]>([]);
  useEffect(() => void priceLevels(books.db).then(setLevels), [books, version]);
  return useMemo(() => [{ id: 0, label: 'Not Applicable' }, ...levels.map((l) => ({ id: l.id, label: l.name }))], [levels]);
}

export function PriceLevelForm({ id }: { id?: number }) {
  const { books, bump, toast } = useStore();
  const nav = useNav();
  const dialogs = useDialogs();
  const form = useRef<FormHandle>(null);
  const cur = useLoad(async () => (id ? (await priceLevels(books.db)).find((l) => l.id === id) ?? null : null), [id]);
  const save = async () => {
    const v = form.current?.submit();
    if (!v) return;
    try {
      if (id) await renamePriceLevel(books.db, id, String(v.name));
      else await createPriceLevel(books.db, String(v.name));
      bump();
      toast('Price level saved', 'ok');
      nav.pop();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  const remove = async () => {
    if (!id || !(await dialogs.confirm('Delete ?', { title: 'Delete', def: false }))) return;
    try {
      await deletePriceLevel(books.db, id);
      bump();
      toast('Deleted', 'ok');
      nav.pop();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  useScreen({
    title: id ? 'Price Level Alteration' : 'Price Level Creation',
    noPeriod: true,
    keys: { 'Ctrl+A': () => void save(), 'Alt+D': id ? () => void remove() : () => false },
    buttons: [{ key: 'Ctrl+A', label: 'Accept', run: () => void save() }, ...(id ? [{ key: 'Alt+D', label: 'Delete', run: () => void remove() }] : [])],
  });
  if (id && cur === null) return null;
  return (
    <div className="max-w-xl">
      <Form ref={form} fields={[{ key: 'name', label: 'Name', kind: 'text', required: true, initial: cur?.name }]} onDone={() => void save()} />
    </div>
  );
}

export function PriceLevelsList({ alter = false }: { alter?: boolean }) {
  const { books, version } = useStore();
  const nav = useNav();
  const [levels, setLevels] = useState<PriceLevel[]>([]);
  useEffect(() => void priceLevels(books.db).then(setLevels), [books, version]);
  return (
    <SelectList
      title={alter ? 'Price Levels' : 'Price Level Creation'}
      heading="List of Price Levels"
      items={levels.map((l) => ({ id: l.id, label: l.name }))}
      onSelect={(i) => nav.push(<PriceLevelForm id={Number(i.id)} />)}
      onCreate={() => nav.push(<PriceLevelForm />)}
    />
  );
}

type Slab = { from: string; lt: string; rate: string; disc: string };
const blank = (): Slab => ({ from: '', lt: '', rate: '', disc: '' });
const COLS = ['from', 'lt', 'rate', 'disc'] as const;

const toSlab = (s: PriceSlab): Slab => ({
  from: s.from_qty ? fmtQty(s.from_qty) : '',
  lt: s.less_than_qty ? fmtQty(s.less_than_qty) : '',
  rate: s.rate ? fmtAmount(s.rate) : '',
  disc: s.disc_bp ? String(s.disc_bp / 100) : '',
});

function fromText(t: Slab): PriceSlab | null {
  const rate = parseAmount(t.rate) ?? 0;
  const disc = t.disc.trim() ? Math.round(Number(t.disc) * 100) : 0;
  if (!rate && !disc) return null;
  return { from_qty: parseQty(t.from || '0') ?? 0, less_than_qty: parseQty(t.lt || '0') ?? 0, rate, disc_bp: disc };
}

interface Header {
  scope: 'group' | 'category';
  scopeId: number | null;
  levelId: number;
  date: string;
}

export function PriceListScreen({ scope = 'group', revise = false }: { scope?: 'group' | 'category'; revise?: boolean }) {
  const { books, company } = useStore();
  const nav = useNav();
  const form = useRef<FormHandle>(null);
  const levelOpts = usePriceLevelOptions();
  const scopeOpts = useLoad(async () => [{ id: 0, label: 'All Items' } as Opt, ...(scope === 'group' ? await stockGroups(books.db) : await stockCategories(books.db)).map((g) => ({ id: g.id, label: g.name }))], [scope]);
  const [head, setHead] = useState<Header | null>(null);
  const [draft, setDraft] = useState<Map<number, PriceSlab[]> | undefined>();
  const today = new Date().toISOString().slice(0, 10);
  const next = () => {
    const v = form.current?.submit();
    if (!v) return;
    if (!v.level) return;
    if (revise) {
      nav.push(<ReviseForm scope={scope} scopeId={Number(v.group) || null} levelId={Number(v.level)} date={String(v.date)} onDraft={(m) => (setDraft(m), setHead({ scope, scopeId: Number(v.group) || null, levelId: Number(v.level), date: String(v.date) }))} />);
      return;
    }
    setHead({ scope, scopeId: Number(v.group) || null, levelId: Number(v.level), date: String(v.date) });
  };
  useScreen({ title: 'Price List', noPeriod: true, keys: { 'Ctrl+A': next }, buttons: [{ key: 'Ctrl+A', label: 'Accept', run: next }] });
  if (head) return <PriceGrid head={head} draft={draft} />;
  if (!scopeOpts) return null;
  const levelsReal = levelOpts.filter((l) => l.id !== 0);
  const fields: FieldDef[] = [
    { key: 'group', label: scope === 'group' ? 'Under Group' : 'Under Category', kind: 'picker', title: scope === 'group' ? 'Stock Groups' : 'Stock Categories', options: scopeOpts, initial: scopeOpts[0], required: true },
    { key: 'level', label: 'Price Level', kind: 'picker', title: 'Price Levels', options: levelsReal, initial: levelsReal[0], required: true },
    { key: 'date', label: 'Applicable From', kind: 'date', initial: today < (company?.fy_start ?? '') ? company!.fy_start : today, required: true },
  ];
  return (
    <div className="max-w-xl">
      <Form ref={form} fields={fields} onDone={next} />
      {levelsReal.length === 0 && <div className="mt-3 text-tb-muted">No price levels. Create one from Create Master &gt; Price Levels.</div>}
    </div>
  );
}

const REVISE_PRICE: Opt[] = [
  { id: 'none', label: 'Not Applicable' },
  { id: 'dec_amount', label: 'Decrease By Amount' },
  { id: 'dec_pct', label: 'Decrease By Percentage' },
  { id: 'inc_amount', label: 'Increase By Amount' },
  { id: 'inc_pct', label: 'Increase By Percentage' },
];
const REVISE_DISC: Opt[] = [
  { id: 'none', label: 'Not Applicable' },
  { id: 'dec_pct', label: 'Decrease By Percentage' },
  { id: 'inc_pct', label: 'Increase By Percentage' },
];

function ReviseForm({ scope, scopeId, levelId, date, onDraft }: { scope: 'group' | 'category'; scopeId: number | null; levelId: number; date: string; onDraft: (m: Map<number, PriceSlab[]>) => void }) {
  const { books, toast } = useStore();
  const nav = useNav();
  const form = useRef<FormHandle>(null);
  const save = async () => {
    const v = form.current?.submit();
    if (!v) return;
    const pm = String(v.price_mode ?? 'none') as ReviseMode;
    const dm = String(v.disc_mode ?? 'none') as 'none' | 'dec_pct' | 'inc_pct';
    const pv = pm === 'dec_pct' || pm === 'inc_pct' ? Math.round(Number(v.price_value || 0) * 100) : Number(v.price_value) || 0;
    try {
      const out = await revisePriceList(books.db, { level_id: levelId, applicable_from: date, stock_group_id: scope === 'group' ? scopeId : null, price_mode: pm, price_value: pv, disc_mode: dm, disc_value: Math.round(Number(v.disc_value || 0) * 100) }, true);
      nav.pop();
      onDraft(new Map(out.map((o) => [o.item_id, o.slabs])));
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  useScreen({ title: 'Revise Price', noPeriod: true, keys: { 'Ctrl+A': () => void save() }, buttons: [{ key: 'Ctrl+A', label: 'Accept', run: () => void save() }] });
  const fields: FieldDef[] = [
    { key: 'price_mode', label: 'Revise Price', kind: 'picker', title: 'Revise Price Types', options: REVISE_PRICE, initial: REVISE_PRICE[0], required: true },
    { key: 'price_value', label: 'Amount / Percentage', kind: 'text', visible: (x) => !!x.price_mode && x.price_mode !== 'none' },
    { key: 'disc_mode', label: 'Revise Discount', kind: 'picker', title: 'Revise Discount Types', options: REVISE_DISC, initial: REVISE_DISC[0], required: true },
    { key: 'disc_value', label: 'Percentage', kind: 'text', visible: (x) => !!x.disc_mode && x.disc_mode !== 'none' },
  ];
  return (
    <div className="max-w-xl">
      <Form ref={form} fields={fields} onDone={() => void save()} />
    </div>
  );
}

function PriceGrid({ head, draft }: { head: Header; draft?: Map<number, PriceSlab[]> }) {
  const { books, bump, toast } = useStore();
  const nav = useNav();
  const dialogs = useDialogs();
  const date = head.date;
  const levels = useLoad(() => priceLevels(books.db), []);
  const rows = useLoad(() => priceList(books.db, head.levelId, date, head.scope === 'group' ? { stockGroupId: head.scopeId } : { categoryId: head.scopeId }), [head, date]);
  const [slabs, setSlabs] = useState<Record<number, Slab[]>>({});
  const refs = useRef<Record<string, HTMLInputElement | null>>({});
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!rows) return;
    const m: Record<number, Slab[]> = {};
    for (const r of rows) {
      const cur: PriceSlab[] = draft?.get(r.item_id) ?? (r.slabs_from === date ? r.slabs : []);
      m[r.item_id] = cur.length ? cur.map(toSlab) : [blank()];
    }
    setSlabs(m);
    setReady(true);
  }, [rows, draft, date]);
  const hist = (r: PriceListRow): PriceSlab[] => (r.slabs_from === date ? r.history : r.slabs);
  const focus = (key: string) => setTimeout(() => refs.current[key]?.focus(), 0);
  const setCell = (item: number, i: number, col: (typeof COLS)[number], v: string) => setSlabs((s) => ({ ...s, [item]: s[item].map((x, k) => (k === i ? { ...x, [col]: v } : x)) }));
  const order = rows ?? [];
  const advance = (item: number, i: number, c: number) => {
    const list = slabs[item];
    if (c < COLS.length - 1) return focus(`${item}:${i}:${c + 1}`);
    const filled = !!(list[i].rate.trim() || list[i].disc.trim());
    if (i < list.length - 1) return focus(`${item}:${i + 1}:0`);
    if (filled) {
      setSlabs((s) => ({ ...s, [item]: [...s[item], blank()] }));
      return focus(`${item}:${i + 1}:0`);
    }
    const idx = order.findIndex((r) => r.item_id === item);
    const nx = order[idx + 1];
    if (nx) focus(`${nx.item_id}:0:0`);
  };
  const save = async () => {
    if (!(await dialogs.confirm('Accept ?', { title: 'Accept', corner: true }))) return;
    try {
      for (const r of order) {
        const list = (slabs[r.item_id] ?? []).map(fromText).filter((x): x is PriceSlab => !!x);
        const before = r.slabs_from === date ? r.slabs.length : 0;
        if (list.length || before) await setItemPriceList(books.db, { level_id: head.levelId, item_id: r.item_id, applicable_from: date, slabs: list });
      }
      bump();
      toast('Price list saved', 'ok');
      nav.pop();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  const doRevise = () => nav.replace(<PriceListScreen scope={head.scope} revise />);
  useScreen({
    title: 'Price List',
    noPeriod: true,
    keys: { 'Ctrl+A': () => void save(), 'Alt+R': doRevise },
    buttons: [{ key: 'Ctrl+A', label: 'Accept', run: () => void save() }, { key: 'Alt+R', label: 'Revise Price', run: doRevise }],
  });
  if (!rows || !ready) return null;
  const level = levels?.find((l) => l.id === head.levelId)?.name ?? '';
  const cell = 'tb-input w-full text-right';
  return (
    <Frame title="Price List" subtitle={`Price Level: ${level}   Applicable From: ${fmtDate(date)}`}>
      <table className="w-full">
        <thead>
          <tr>
            <th className={`${th} text-left`} rowSpan={2}>S.No.</th>
            <th className={`${th} text-left`} rowSpan={2}>Particulars</th>
            <th className={`${th} text-center`} colSpan={2}>Quantities</th>
            <th className={`${th} text-right`} rowSpan={2}>Rate</th>
            <th className={`${th} text-right`} rowSpan={2}>Disc. % <i>(if any)</i></th>
            <th className={`${th} text-center`} colSpan={2}>Historical Details</th>
            <th className={`${th} text-right`} rowSpan={2}>Cost Price</th>
          </tr>
          <tr>
            <th className={`${th} text-right font-normal italic`}>From:</th>
            <th className={`${th} text-right font-normal italic`}>Less than</th>
            <th className={`${th} text-right font-normal`}>Rate</th>
            <th className={`${th} text-right font-normal`}>Disc. %</th>
          </tr>
        </thead>
        <tbody>
          {order.map((r, n) => {
            const list = slabs[r.item_id] ?? [blank()];
            const h = hist(r);
            return list.map((s, i) => (
              <tr key={`${r.item_id}-${i}`} className={i === 0 ? 'border-t border-tb-line' : ''}>
                <td className="px-2 align-top">{i === 0 ? `${n + 1}.` : ''}</td>
                <td className="px-2 align-top font-bold">{i === 0 ? `${r.name}` : ''}</td>
                {COLS.map((c, ci) => (
                  <td key={c} className="px-1" style={{ width: ci < 2 ? 90 : 110 }}>
                    <input
                      ref={(el) => {
                        refs.current[`${r.item_id}:${i}:${ci}`] = el;
                      }}
                      className={cell}
                      value={s[c]}
                      onChange={(e) => setCell(r.item_id, i, c, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          e.stopPropagation();
                          advance(r.item_id, i, ci);
                        }
                      }}
                    />
                  </td>
                ))}
                <td className="px-2 text-right tabular-nums">{h[i] ? fmtAmount(h[i].rate) : ''}</td>
                <td className="px-2 text-right tabular-nums">{h[i]?.disc_bp ? `${h[i].disc_bp / 100} %` : ''}</td>
                <td className="px-2 text-right font-bold tabular-nums">{i === 0 && r.cost_rate ? `${fmtAmount(r.cost_rate)}/${r.unit}` : ''}</td>
              </tr>
            ));
          })}
        </tbody>
      </table>
      {order.length === 0 && <div className="py-3 text-tb-muted">No stock items under this selection.</div>}
    </Frame>
  );
}
