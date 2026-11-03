import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  fmtAmount,
  fmtDate,
  fmtQty,
  godowns as loadGodowns,
  parseAmount,
  parseDate,
  parseQty,
  stockGroups,
  stockItem,
  stockItems as loadItems,
  todayIso,
  weekday,
  type Godown,
  type Ledger,
  type StockItem,
} from '@tallybook/core';
import {
  BOM_ITEM_TYPES,
  boms as loadBoms,
  bom as loadBom,
  copyBomLines,
  costEstimation,
  createBom,
  createMfgJournal,
  deleteBom,
  ensureMfg,
  explodeBom,
  itemsWithBom,
  jobCosting,
  materialRequirement,
  mfgJournal,
  mfgVoucherTypeId,
  planMfgJournal,
  updateBom,
  updateMfgJournal,
  type Bom,
  type BomItemType,
  type ByProductType,
  type MfgJournalInput,
  type MfgPlan,
} from '@tallybook/core';
import { PickerInput, type Opt } from '../ui/PickerInput.tsx';
import { Form, type FieldDef, type FormHandle } from '../ui/Form.tsx';
import { useScreen, type Btn, type KeyHandler } from '../registry.ts';
import { useStore } from '../store.tsx';
import { useNav } from '../nav.tsx';
import { useDialogs } from '../ui/Dialogs.tsx';
import { SelectList, type ListItem } from './SelectList.tsx';
import { Frame, th, rowCls, useLoad, usePeriodKey, useSel } from './Reports.tsx';
import { useReportOptions, type OptionDef } from './reportConfig.tsx';
import { PickStockItem } from './Inventory.tsx';
import { VoucherScreen } from './Voucher.tsx';

const MFG_BG = '#faf7fe';
const num = 'px-2 text-right tabular-nums';
const tot = 'border-y-[3px] border-double border-tb-ink px-2 text-right tabular-nums';
const totL = 'border-y-[3px] border-double border-tb-ink px-2';
const Q = (v: number, u = '') => (v ? fmtQty(v, 0, u) : '');
const R = (v: number, u = '') => (v ? `${fmtAmount(v)}${u ? `/${u}` : ''}` : '');
const A = (v: number) => (v ? (v < 0 ? `(-)${fmtAmount(-v)}` : fmtAmount(v)) : '');
const P = (bp: number) => `${fmtAmount(bp, false).replace(/\.00$/, '')} %`;
const qtyText = (milli: number) => (milli ? fmtQty(milli, 0) : '');

function useFocus(box: React.RefObject<HTMLDivElement | null>) {
  return useCallback(
    (sel: string) => {
      setTimeout(() => {
        const el = box.current?.querySelector(`[data-cell="${sel}"]`) as HTMLInputElement | null;
        el?.focus();
        el?.select?.();
      }, 0);
    },
    [box]
  );
}

const cellRef = (id: string) => (el: HTMLInputElement | null) => el?.setAttribute('data-cell', id);

function enterKey(run: () => void, back?: () => void) {
  return (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      run();
    } else if (back && e.key === 'Backspace' && e.currentTarget.value === '') {
      e.preventDefault();
      e.stopPropagation();
      back();
    }
  };
}

export function BomGateway() {
  const nav = useNav();
  return <PickStockItem title="Stock Item Components (BOM)" onPick={(i) => nav.push(<BomListScreen itemId={i.id} />)} />;
}

export function BomListScreen({ itemId }: { itemId: number }) {
  const { books, version, bump, toast } = useStore();
  const nav = useNav();
  const dialogs = useDialogs();
  const item = useLoad(() => stockItem(books.db, itemId), [itemId]);
  const [list, setList] = useState<Bom[]>([]);
  const [text, setText] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => void ensureMfg(books.db).then(() => loadBoms(books.db, itemId)).then(setList), [books, itemId, version]);
  useEffect(() => input.current?.focus(), [list]);
  const ref = useRef({ list, sel, text });
  ref.current = { list, sel, text };

  const open = () => {
    const { list: l, sel: s, text: t } = ref.current;
    const name = t.trim();
    if (name) {
      const hit = l.find((b) => b.name.toLowerCase() === name.toLowerCase());
      setText('');
      nav.push(<BomComponentsScreen itemId={itemId} bomId={hit?.id} name={hit ? undefined : name} />);
    } else if (l[s]) nav.push(<BomComponentsScreen itemId={itemId} bomId={l[s].id} />);
    else toast('Type the name of the BOM', 'err');
  };
  const remove = async () => {
    const b = ref.current.list[ref.current.sel];
    if (!b || !(await dialogs.confirm(`Delete BOM "${b.name}" ?`, { title: 'Delete', def: false }))) return;
    try {
      await deleteBom(books.db, b.id);
      bump();
      toast('BOM deleted', 'ok');
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  useScreen({
    title: 'Stock Item Multi Components (M BOM)',
    noPeriod: true,
    keys: {
      ArrowDown: () => setSel((s) => Math.min(s + 1, Math.max(0, ref.current.list.length - 1))),
      ArrowUp: () => setSel((s) => Math.max(s - 1, 0)),
      Enter: open,
      'Ctrl+A': () => nav.pop(),
      'Alt+D': () => void remove(),
    },
    buttons: [
      { key: 'Alt+D', label: 'Delete BOM', run: () => void remove() },
      { key: 'Ctrl+A', label: 'Accept', run: () => nav.pop() },
    ],
  });
  return (
    <div className="mx-auto mt-6 w-[340px] border border-tb-line bg-white px-3 pb-4 pt-2 text-[14px]">
      <div className="text-center">
        BOM List of : <b>{item?.name ?? ''}</b>
      </div>
      <div className="mt-1 border-y border-tb-line text-center font-bold">Name of BOM</div>
      <ul className="mt-2 min-h-[200px]">
        {list.map((b, i) => (
          <li
            key={b.id}
            className={`cursor-pointer px-1 font-bold ${i === sel && !text ? 'bg-tb-sel' : ''}`}
            onMouseEnter={() => setSel(i)}
            onClick={() => {
              ref.current.sel = i;
              open();
            }}
          >
            {b.name}
          </li>
        ))}
        <li className="mt-1">
          <input
            ref={input}
            className="tb-input w-full font-bold"
            value={text}
            placeholder={list.length ? '' : 'Standard'}
            onChange={(e) => setText(e.target.value)}
          />
        </li>
      </ul>
    </div>
  );
}

interface BomRow {
  item: StockItem | null;
  text: string;
  godown: Godown | null;
  godownText: string;
  kind: BomItemType;
  qty: string;
  pct: string;
}

const blankBomRow = (g?: Godown | null): BomRow => ({ item: null, text: '', godown: g ?? null, godownText: g?.name ?? '', kind: 'Component', qty: '', pct: '' });

export function BomComponentsScreen({ itemId, bomId, name: presetName }: { itemId: number; bomId?: number; name?: string }) {
  const { books, bump, toast } = useStore();
  const nav = useNav();
  const dialogs = useDialogs();
  const [item, setItem] = useState<StockItem | null>(null);
  const [items, setItems] = useState<StockItem[]>([]);
  const [houses, setHouses] = useState<Godown[]>([]);
  const [cur, setCur] = useState<Bom | null | undefined>(bomId ? undefined : null);
  const [name, setName] = useState(presetName ?? '');
  const [unitQty, setUnitQty] = useState('1');
  const [rows, setRows] = useState<BomRow[]>([blankBomRow()]);
  const dirty = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  const focus = useFocus(box);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  useEffect(() => {
    void Promise.all([stockItem(books.db, itemId), loadItems(books.db), loadGodowns(books.db), ensureMfg(books.db).then(() => (bomId ? loadBom(books.db, bomId) : null))]).then(([it, list, gs, b]) => {
      setItem(it);
      setItems(list);
      setHouses(gs);
      if (b) {
        setCur(b);
        setName(b.name);
        setUnitQty(qtyText(b.unit_qty));
        setRows([
          ...b.lines.map((l) => {
            const g = gs.find((x) => x.id === l.godown_id) ?? null;
            return { item: list.find((x) => x.id === l.item_id) ?? null, text: l.item, godown: g, godownText: g?.name ?? '', kind: l.kind, qty: qtyText(l.qty), pct: l.pct_bp ? fmtAmount(l.pct_bp, false) : '' };
          }),
          blankBomRow(gs[0]),
        ]);
      } else setRows([blankBomRow(gs[0])]);
      setTimeout(() => focus(presetName || !bomId ? 'unit' : 'i0-0'), 0);
    });
  }, [books, itemId, bomId, presetName, focus]);

  const multiHouse = houses.length > 1;
  const itemOpts: Opt[] = useMemo(() => items.filter((i) => i.id !== itemId).map((i) => ({ id: i.id, label: i.name })), [items, itemId]);
  const houseOpts: Opt[] = houses.map((g) => ({ id: g.id, label: g.name }));
  const kindOpts: Opt[] = [...BOM_ITEM_TYPES].sort().map((k) => ({ id: k, label: k }));

  const touch = () => {
    dirty.current = true;
  };
  const update = (i: number, patch: Partial<BomRow>) => {
    touch();
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };
  const nextRow = (i: number) => {
    if (i === rowsRef.current.length - 1) setRows((rs) => [...rs, blankBomRow(houses[0])]);
    focus(`i${i + 1}-0`);
  };

  const save = async () => {
    const unit = parseQty(unitQty);
    if (!unit) return toast('Unit of manufacture: enter a valid quantity', 'err');
    const lines = [];
    for (const r of rowsRef.current) {
      if (!r.item) continue;
      const q = parseQty(r.qty);
      if (!q) return toast(`Quantity for ${r.item.name}: enter a valid quantity`, 'err');
      lines.push({ item_id: r.item.id, godown_id: r.godown?.id ?? null, kind: r.kind, qty: q, pct_bp: r.kind === 'Component' ? 0 : (parseAmount(r.pct) ?? 0) });
    }
    try {
      if (cur) await updateBom(books.db, cur.id, { name, unit_qty: unit, lines });
      else await createBom(books.db, itemId, { name, unit_qty: unit, lines });
      dirty.current = false;
      bump();
      toast(`BOM "${name.trim()}" saved`, 'ok');
      nav.pop();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  const accept = async () => {
    if (await dialogs.confirm('Accept ?', { title: 'Accept', corner: true })) void save();
  };
  const leave = async () => {
    if (dirty.current && !(await dialogs.confirm('Quit ?', { title: 'Quit', def: false }))) return;
    nav.pop();
  };
  const remove = async () => {
    if (!cur || !(await dialogs.confirm('Delete ?', { title: 'Delete', def: false }))) return;
    await deleteBom(books.db, cur.id);
    bump();
    toast('BOM deleted', 'ok');
    nav.pop();
  };
  const copy = () =>
    nav.push(
      <CopyBomPicker
        exceptBom={cur?.id}
        onPick={(b) => {
          touch();
          const lines = copyBomLines(b);
          setRows([
            ...lines.map((l) => {
              const it = items.find((x) => x.id === l.item_id) ?? null;
              const g = houses.find((x) => x.id === l.godown_id) ?? null;
              return { item: it, text: it?.name ?? '', godown: g, godownText: g?.name ?? '', kind: l.kind ?? 'Component', qty: qtyText(l.qty), pct: l.pct_bp ? fmtAmount(l.pct_bp, false) : '' };
            }),
            blankBomRow(houses[0]),
          ]);
          focus('unit');
        }}
      />
    );

  useScreen({
    title: 'Stock Item Components (BOM)',
    noPeriod: true,
    keys: {
      'Ctrl+A': () => void save(),
      Escape: () => void leave(),
      'Alt+R': () => setRows((rs) => (rs.length > 1 ? rs.slice(0, -2).concat(blankBomRow(houses[0])) : rs)),
      'Ctrl+C': copy,
      'Alt+D': () => (cur ? void remove() : false),
    },
    buttons: [
      { key: 'Ctrl+C', label: 'Copy BoM', run: copy },
      { key: 'Alt+R', label: 'Remove Line', run: () => setRows((rs) => (rs.length > 1 ? rs.slice(0, -2).concat(blankBomRow(houses[0])) : rs)) },
      ...(cur ? [{ key: 'Alt+D', label: 'Delete', run: () => void remove() }] : []),
      { key: 'Ctrl+A', label: 'Accept', run: () => void save() },
    ],
  });
  if (cur === undefined || !item) return null;

  const cols = `grid ${multiHouse ? 'grid-cols-[1fr_170px_130px_120px_90px]' : 'grid-cols-[1fr_130px_120px_90px]'} items-center`;
  const label = 'inline-block w-44';
  return (
    <div ref={box} className="-m-4 min-h-[calc(100vh-90px)] bg-white px-2 pb-2 pt-2">
      <div className="mx-auto w-[460px] space-y-px">
        <div className="flex items-center">
          <span className={label}>BoM Name</span>
          <span className="mr-2">:</span>
          <input className="tb-input flex-1 font-bold" ref={cellRef('name')} value={name} onChange={(e) => (touch(), setName(e.target.value))} onKeyDown={enterKey(() => (name.trim() ? focus('unit') : toast('Name of BOM is required', 'err')))} />
        </div>
        <div className="flex items-center">
          <span className={label}>Components of</span>
          <span className="mr-2">:</span>
          <b>{item.name}</b>
        </div>
        <div className="flex items-center">
          <span className={label}>Unit of manufacture</span>
          <span className="mr-2">:</span>
          <input
            className="tb-input tb-num w-24 font-bold"
            ref={cellRef('unit')}
            value={unitQty}
            onChange={(e) => (touch(), setUnitQty(e.target.value))}
            onKeyDown={enterKey(
              () => (parseQty(unitQty) ? focus('i0-0') : toast('Unit of manufacture: enter a valid quantity', 'err')),
              () => focus('name')
            )}
          />
          <b className="ml-1">{item.unit}</b>
        </div>
      </div>
      <div className={`mt-3 ${cols} border-y border-tb-line py-px font-bold`}>
        <span className="pl-1">Item</span>
        {multiHouse && <span>Godown</span>}
        <span>Type of Item</span>
        <span className="pr-1 text-right">Quantity</span>
        <span className="pr-1 text-right">Rate (%)</span>
      </div>
      <div className="pt-2">
        {rows.map((r, i) => {
          const afterKind = () => focus(`i${i}-q`);
          return (
            <div key={i} className={cols}>
              <PickerInput
                className="tb-input w-full font-bold"
                value={r.text}
                title="Stock Items"
                options={itemOpts}
                inputRef={cellRef(`i${i}-0`)}
                onChange={(t) => update(i, { text: t, item: null })}
                onPick={(o) => {
                  update(i, { item: items.find((x) => x.id === o.id)!, text: o.label });
                  focus(multiHouse ? `i${i}-g` : `i${i}-k`);
                }}
                onEmptyEnter={() => void accept()}
                onNoMatch={() => toast('Select an item from the list', 'err')}
                onBackspaceEmpty={() => (i === 0 ? focus('unit') : focus(`i${i - 1}-q`))}
              />
              {multiHouse && (
                <PickerInput
                  className="tb-input w-full"
                  value={r.godownText}
                  title="Godowns"
                  options={houseOpts}
                  inputRef={cellRef(`i${i}-g`)}
                  onChange={(t) => update(i, { godownText: t, godown: null })}
                  onPick={(o) => {
                    update(i, { godown: houses.find((g) => g.id === o.id)!, godownText: o.label });
                    focus(`i${i}-k`);
                  }}
                  onNoMatch={() => toast('Select a godown', 'err')}
                  onBackspaceEmpty={() => focus(`i${i}-0`)}
                />
              )}
              <PickerInput
                className="tb-input w-full"
                value={r.kind}
                title="Component Type"
                options={kindOpts}
                inputRef={cellRef(`i${i}-k`)}
                onChange={(t) => update(i, { kind: (BOM_ITEM_TYPES.find((k) => k.toLowerCase() === t.toLowerCase()) ?? r.kind) as BomItemType })}
                onPick={(o) => {
                  update(i, { kind: o.id as BomItemType, pct: o.id === 'Component' ? '' : r.pct });
                  afterKind();
                }}
                onNoMatch={() => toast('Select the type of item', 'err')}
              />
              <input
                className="tb-input tb-num w-full font-bold"
                data-cell={`i${i}-q`}
                value={r.qty}
                onChange={(e) => update(i, { qty: e.target.value })}
                onKeyDown={enterKey(
                  () => {
                    if (!parseQty(r.qty)) return toast('Enter a valid quantity', 'err');
                    if (r.kind === 'Component') nextRow(i);
                    else focus(`i${i}-p`);
                  },
                  () => focus(`i${i}-k`)
                )}
              />
              {r.kind === 'Component' ? (
                <span />
              ) : (
                <input
                  className="tb-input tb-num w-full"
                  data-cell={`i${i}-p`}
                  value={r.pct}
                  onChange={(e) => update(i, { pct: e.target.value })}
                  onKeyDown={enterKey(
                    () => {
                      const p = parseAmount(r.pct || '0');
                      if (p === null || p < 0 || p > 10000) return toast('Enter a percentage between 0 and 100', 'err');
                      update(i, { pct: p ? fmtAmount(p, false) : '' });
                      nextRow(i);
                    },
                    () => focus(`i${i}-q`)
                  )}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CopyBomPicker({ onPick, exceptBom }: { onPick: (b: Bom) => void; exceptBom?: number }) {
  const { books } = useStore();
  const nav = useNav();
  const list = useLoad(() => itemsWithBom(books.db), []);
  if (!list) return null;
  return (
    <SelectList
      title="Copy BoM Details"
      heading="List of Stock Items"
      popOnSelect
      items={list.map((r) => ({ id: r.item_id, label: r.name }))}
      empty="No stock item has a BOM"
      onSelect={(it) =>
        void loadBoms(books.db, Number(it.id)).then((bs) => {
          const opts = bs.filter((b) => b.id !== exceptBom);
          if (opts.length === 1) return onPick(opts[0]);
          nav.push(<SelectList title={`Component of BOM : ${it.label}`} heading="List of BOM" popOnSelect items={opts.map((b) => ({ id: b.id, label: b.name }))} onSelect={(b) => onPick(opts.find((x) => x.id === b.id)!)} />);
        })
      }
    />
  );
}

export function ChangeVoucherMode({ current = 'Use for Manufacturing Journal', onPick }: { current?: string; onPick: (mode: 'Use for Manufacturing Journal' | 'Use for Stock Journal') => void }) {
  const items: ListItem[] = [
    { id: 'Use for Manufacturing Journal', label: 'Use for Manufacturing Journal' },
    { id: 'Use for Stock Journal', label: 'Use for Stock Journal' },
  ];
  return <SelectList title="Change Voucher Mode" heading="List of Modes/Usages" popOnSelect items={[...items.filter((i) => i.id !== current), ...items.filter((i) => i.id === current)]} onSelect={(i) => onPick(i.id as 'Use for Manufacturing Journal' | 'Use for Stock Journal')} />;
}

interface CLine {
  item: StockItem | null;
  text: string;
  godown: Godown | null;
  godownText: string;
  qty: string;
  rate: string;
  fixed: boolean;
}
interface BLine extends CLine {
  kind: ByProductType;
  pct: string;
}
interface ALine {
  ledger: Ledger | null;
  text: string;
  pct: string;
  amount: string;
}

const blankC = (g?: Godown | null): CLine => ({ item: null, text: '', godown: g ?? null, godownText: g?.name ?? '', qty: '', rate: '', fixed: false });
const blankB = (g?: Godown | null): BLine => ({ ...blankC(g), kind: 'By-Product', pct: '' });
const blankA = (): ALine => ({ ledger: null, text: '', pct: '', amount: '' });

let lastMfgDate = '';

export function ManufacturingJournalScreen({ voucherId, typeId }: { voucherId?: number; typeId?: number }) {
  const { books, company, period, version, bump, toast } = useStore();
  const nav = useNav();
  const dialogs = useDialogs();
  const editing = !!voucherId;
  const [type, setType] = useState<{ id: number; name: string } | null>(null);
  const [number, setNumber] = useState('');
  const start = lastMfgDate || (todayIso() >= (company?.fy_start ?? '') && todayIso() <= (company?.fy_end ?? '') ? todayIso() : period.to);
  const [dateText, setDateText] = useState(fmtDate(start));
  const dateIso = parseDate(dateText, company?.fy_start, start) ?? start;
  const [reference, setReference] = useState('');
  const [narration, setNarration] = useState('');
  const [items, setItems] = useState<StockItem[]>([]);
  const [houses, setHouses] = useState<Godown[]>([]);
  const [ledgers, setLedgers] = useState<Ledger[]>([]);
  const [product, setProduct] = useState<StockItem | null>(null);
  const [productText, setProductText] = useState('');
  const [bomList, setBomList] = useState<Bom[]>([]);
  const [bom, setBom] = useState<Bom | null>(null);
  const [bomText, setBomText] = useState('');
  const [godown, setGodown] = useState<Godown | null>(null);
  const [godownText, setGodownText] = useState('');
  const [qty, setQty] = useState('');
  const [comps, setComps] = useState<CLine[]>([blankC()]);
  const [bys, setBys] = useState<BLine[]>([blankB()]);
  const [addl, setAddl] = useState<ALine[]>([blankA()]);
  const [plan, setPlan] = useState<MfgPlan | null>(null);
  const [planError, setPlanError] = useState('');
  const [loaded, setLoaded] = useState(!voucherId);
  const dirty = useRef(false);
  const saving = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);
  const narrRef = useRef<HTMLInputElement>(null);
  const focus = useFocus(box);
  const state = useRef({ comps, bys, addl });
  state.current = { comps, bys, addl };

  useEffect(() => {
    void Promise.all([loadItems(books.db), loadGodowns(books.db), books.ledgers(), typeId ? Promise.resolve(typeId) : mfgVoucherTypeId(books.db), books.voucherTypes()]).then(([i, g, l, tid, types]) => {
      setItems(i);
      setHouses(g);
      setLedgers(l);
      const t = types.find((x) => x.id === tid);
      if (t) setType({ id: t.id, name: t.name });
    });
  }, [books, version, typeId]);

  const loadNumber = useCallback(() => {
    if (type && !editing) void books.nextNumber(type.id).then((n) => setNumber(n.number));
  }, [books, type, editing]);
  useEffect(loadNumber, [loadNumber, version]);

  useEffect(() => {
    if (!voucherId || !items.length || !houses.length || loaded) return;
    void mfgJournal(books, voucherId).then(async (j) => {
      if (!j) return toast('Voucher not found', 'err');
      const hs = (id: number | null) => houses.find((g) => g.id === id) ?? null;
      const it = (id: number) => items.find((x) => x.id === id) ?? null;
      setType({ id: j.voucher.type_id, name: j.voucher.type });
      setNumber(j.voucher.number);
      setDateText(fmtDate(j.voucher.date));
      setReference(j.voucher.reference);
      setNarration(j.voucher.narration);
      setProduct(it(j.item_id));
      setProductText(j.item);
      const bl = await loadBoms(books.db, j.item_id);
      setBomList(bl);
      const b = bl.find((x) => x.id === j.bom_id) ?? null;
      setBom(b);
      setBomText(b?.name ?? 'Not Applicable');
      setGodown(hs(j.godown_id));
      setGodownText(hs(j.godown_id)?.name ?? '');
      setQty(qtyText(j.qty));
      setComps([...j.components.map((c) => ({ item: it(c.item_id), text: c.item, godown: hs(c.godown_id), godownText: hs(c.godown_id)?.name ?? '', qty: qtyText(c.qty), rate: c.rate_fixed ? fmtAmount(c.rate, false) : '', fixed: c.rate_fixed })), blankC(houses[0])]);
      setBys([
        ...j.byproducts.map((c) => ({ item: it(c.item_id), text: c.item, godown: hs(c.godown_id), godownText: hs(c.godown_id)?.name ?? '', qty: qtyText(c.qty), rate: c.rate_fixed ? fmtAmount(c.rate, false) : '', fixed: c.rate_fixed, kind: c.kind, pct: c.pct_bp ? fmtAmount(c.pct_bp, false) : '' })),
        blankB(houses[0]),
      ]);
      setAddl([...j.addl.map((a) => ({ ledger: ledgers.find((l) => l.id === a.ledger_id) ?? null, text: a.ledger, pct: a.pct_bp ? fmtAmount(a.pct_bp, false) : '', amount: a.pct_bp ? '' : fmtAmount(a.amount, false) })), blankA()]);
      setLoaded(true);
      focus('product');
    });
  }, [voucherId, items, houses, ledgers, loaded, books, toast, focus]);

  useEffect(() => {
    if (!houses.length) return;
    setComps((ls) => ls.map((l) => (l.godown || l.item ? l : { ...l, godown: houses[0], godownText: houses[0].name })));
    setBys((ls) => ls.map((l) => (l.godown || l.item ? l : { ...l, godown: houses[0], godownText: houses[0].name })));
    if (!editing) {
      setGodown((g) => g ?? houses[0]);
      setGodownText((t) => t || houses[0].name);
    }
  }, [houses, editing]);

  useEffect(() => {
    if (!editing && type?.id) focus('product');
  }, [editing, focus, type?.id]);

  const multiHouse = houses.length > 1;
  const itemOpts: Opt[] = useMemo(() => items.map((i) => ({ id: i.id, label: i.name })), [items]);
  const houseOpts: Opt[] = useMemo(() => houses.map((g) => ({ id: g.id, label: g.name })), [houses]);
  const ledgerOpts: Opt[] = useMemo(() => ledgers.map((l) => ({ id: l.id, label: l.name, sub: l.group_name })), [ledgers]);
  const bomOpts: Opt[] = useMemo(() => [{ id: 0, label: 'Not Applicable' }, ...bomList.map((b) => ({ id: b.id, label: b.name }))], [bomList]);
  const kindOpts: Opt[] = (['By-Product', 'Co-Product', 'Scrap'] as const).map((k) => ({ id: k, label: k }));

  const touch = () => {
    dirty.current = true;
  };

  const buildInput = useCallback((): MfgJournalInput | null => {
    const q = parseQty(qty);
    if (!product || !q) return null;
    const { comps: cs, bys: bs, addl: as } = state.current;
    return {
      type_id: type?.id,
      date: dateIso,
      reference,
      narration,
      item_id: product.id,
      bom_id: bom?.id ?? null,
      godown_id: godown?.id ?? null,
      qty: q,
      components: cs.filter((l) => l.item && parseQty(l.qty)).map((l) => ({ item_id: l.item!.id, godown_id: l.godown?.id ?? null, qty: parseQty(l.qty)!, rate: l.fixed ? (parseAmount(l.rate) ?? 0) : undefined })),
      byproducts: bs
        .filter((l) => l.item && parseQty(l.qty))
        .map((l) => ({ item_id: l.item!.id, godown_id: l.godown?.id ?? null, qty: parseQty(l.qty)!, kind: l.kind, pct_bp: parseAmount(l.pct || '0') ?? 0, rate: l.fixed ? (parseAmount(l.rate) ?? 0) : undefined })),
      addl: as.filter((a) => a.ledger).map((a) => ({ ledger_id: a.ledger!.id, pct_bp: parseAmount(a.pct || '0') ?? 0, amount: parseAmount(a.amount || '0') ?? 0 })),
    };
  }, [qty, product, type, dateIso, reference, narration, bom, godown]);

  const buildRef = useRef(buildInput);
  buildRef.current = buildInput;
  const planInput = buildInput();
  const planKey = JSON.stringify([planInput ? { ...planInput, narration: '', reference: '' } : null, comps.map((c) => [c.item?.id, c.qty, c.fixed && c.rate]), bys.map((c) => [c.item?.id, c.qty, c.kind, c.pct, c.fixed && c.rate]), addl.map((a) => [a.ledger?.id, a.pct, a.amount])]);
  useEffect(() => {
    const input = buildRef.current();
    if (!input || !input.components?.length) {
      setPlan(null);
      setPlanError('');
      return;
    }
    let live = true;
    planMfgJournal(books.db, input, { voucherId })
      .then((p) => {
        if (!live) return;
        setPlan(p);
        setPlanError('');
      })
      .catch((e) => {
        if (!live) return;
        setPlan(null);
        setPlanError((e as Error).message);
      });
    return () => {
      live = false;
    };
  }, [planKey, books, voucherId]);

  const fill = async (b: Bom | null, q: number) => {
    if (!b) {
      setComps((cs) => (cs.some((c) => c.item) ? cs : [blankC(houses[0])]));
      focus('c0-0');
      return;
    }
    const ex = await explodeBom(books.db, b.id, q);
    const hs = (id: number | null) => houses.find((g) => g.id === id) ?? houses[0] ?? null;
    setComps([...ex.components.map((l) => ({ item: items.find((x) => x.id === l.item_id) ?? null, text: l.item, godown: hs(l.godown_id), godownText: hs(l.godown_id)?.name ?? '', qty: qtyText(l.qty), rate: '', fixed: false })), blankC(houses[0])]);
    setBys([
      ...ex.byproducts.map((l) => ({ item: items.find((x) => x.id === l.item_id) ?? null, text: l.item, godown: hs(l.godown_id), godownText: hs(l.godown_id)?.name ?? '', qty: qtyText(l.qty), rate: '', fixed: false, kind: l.kind as ByProductType, pct: l.pct_bp ? fmtAmount(l.pct_bp, false) : '' })),
      blankB(houses[0]),
    ]);
    focus('c0-q');
  };

  const pickProduct = async (it: StockItem) => {
    touch();
    setProduct(it);
    setProductText(it.name);
    const bl = await loadBoms(books.db, it.id);
    setBomList(bl);
    const b = bl[0] ?? null;
    setBom(b);
    setBomText(b?.name ?? 'Not Applicable');
    focus(bl.length ? 'bom' : multiHouse ? 'mgodown' : 'qty');
  };

  const commitQty = () => {
    const q = parseQty(qty);
    if (!q) return toast('Enter the quantity to be manufactured', 'err');
    setQty(qtyText(q));
    if (bom && (!editing || dirty.current)) void fill(bom, q);
    else focus('c0-0');
  };

  const save = async () => {
    if (saving.current) return;
    const input = buildInput();
    if (!product) return toast('Select the name of product', 'err');
    if (!input) return toast('Enter the quantity to be manufactured', 'err');
    if (!parseDate(dateText, company?.fy_start, dateIso)) return toast('Invalid date', 'err');
    saving.current = true;
    try {
      if (editing && voucherId) {
        await updateMfgJournal(books, voucherId, input);
        bump();
        toast(`${type?.name ?? 'Manufacturing Journal'} voucher altered`, 'ok');
        nav.pop();
      } else {
        const j = await createMfgJournal(books, input);
        lastMfgDate = dateIso;
        bump();
        toast(`${j.voucher.type} voucher No. ${j.voucher.number} saved`, 'ok');
        dirty.current = false;
        setProduct(null);
        setProductText('');
        setBomList([]);
        setBom(null);
        setBomText('');
        setQty('');
        setReference('');
        setNarration('');
        setComps([blankC(houses[0])]);
        setBys([blankB(houses[0])]);
        setAddl([blankA()]);
        loadNumber();
        focus('product');
      }
    } catch (e) {
      toast((e as Error).message, 'err');
    } finally {
      saving.current = false;
    }
  };
  const accept = async () => {
    if (await dialogs.confirm('Accept ?', { title: 'Accept', yes: 'Yes', no: 'No', corner: true })) void save();
  };
  const leave = async () => {
    if (dirty.current && !(await dialogs.confirm('Quit ?', { title: 'Quit', def: false }))) return;
    nav.pop();
  };
  const remove = async () => {
    if (!voucherId || !(await dialogs.confirm('Delete ?', { title: 'Delete', def: false }))) return;
    await books.deleteVoucher(voucherId);
    bump();
    toast('Voucher deleted', 'ok');
    nav.pop();
  };
  const cancelVch = async () => {
    if (!voucherId || !(await dialogs.confirm('Cancel Voucher ?', { title: 'Cancel voucher', def: false }))) return;
    await books.cancelVoucher(voucherId);
    bump();
    toast('Voucher cancelled', 'ok');
    nav.pop();
  };
  const changeMode = () => {
    if (editing) return false;
    nav.push(<ChangeVoucherMode onPick={(m) => (m === 'Use for Stock Journal' ? nav.replace(<VoucherScreen typeName="Stock Journal" />) : undefined)} />);
  };
  const removeLine = () => {
    const el = document.activeElement?.getAttribute('data-cell') ?? '';
    const drop = <T,>(ls: T[], blank: T) => (ls.length > 1 ? [...ls.slice(0, -2), blank] : ls);
    if (el.startsWith('b')) setBys((ls) => drop(ls, blankB(houses[0])));
    else if (el.startsWith('a')) setAddl((ls) => drop(ls, blankA()));
    else setComps((ls) => drop(ls, blankC(houses[0])));
  };

  useScreen({
    title: editing ? 'Voucher Alteration' : 'Inventory Voucher Creation',
    kind: 'voucher',
    keys: {
      'Ctrl+A': () => void save(),
      Escape: () => void leave(),
      F2: () => {
        dateRef.current?.focus();
        dateRef.current?.select();
      },
      'Ctrl+H': changeMode,
      'Alt+R': removeLine,
      'Alt+D': () => (editing ? void remove() : false),
      'Alt+X': () => (editing ? void cancelVch() : false),
    },
    buttons: [
      { key: 'F2', label: 'Date', run: () => dateRef.current?.focus() },
      ...(!editing ? [{ key: 'Ctrl+H', label: 'Change Mode', run: () => void changeMode() }] : []),
      { key: 'Alt+R', label: 'Remove Line', run: removeLine },
      ...(editing
        ? [
            { key: 'Alt+X', label: 'Cancel Vch', run: () => void cancelVch() },
            { key: 'Alt+D', label: 'Delete', run: () => void remove() },
          ]
        : []),
      { key: 'Ctrl+A', label: 'Accept', run: () => void save() },
    ],
  });

  const updC = (i: number, p: Partial<CLine>) => (touch(), setComps((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l))));
  const updB = (i: number, p: Partial<BLine>) => (touch(), setBys((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l))));
  const updA = (i: number, p: Partial<ALine>) => (touch(), setAddl((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l))));

  const planIndex = <T extends { item: StockItem | null; qty: string }>(ls: T[]) => {
    const map = new Map<number, number>();
    let k = 0;
    ls.forEach((l, i) => {
      if (l.item && parseQty(l.qty)) map.set(i, k++);
    });
    return map;
  };
  const cIdx = planIndex(comps);
  const bIdx = planIndex(bys);
  const aIdx = new Map<number, number>();
  addl.forEach((a, i) => a.ledger && aIdx.set(i, aIdx.size));

  const toBys = () => {
    if (!bys.length) setBys([blankB(houses[0])]);
    focus('b0-0');
  };
  const toAddl = () => focus('a0-0');

  const unitOf = (it: StockItem | null) => it?.unit ?? '';
  const head = 'border-b border-tb-line font-bold';
  const lcols = 'grid grid-cols-[1fr_110px_130px_130px] items-center';
  const rcols = 'grid grid-cols-[1fr_90px_100px_110px] items-center';

  if (!loaded || !type) return null;
  return (
    <div ref={box} className="-m-4 flex min-h-[calc(100vh-90px)] flex-col px-2 pb-2" style={{ backgroundColor: MFG_BG }}>
      <div className="flex items-start justify-between pt-1">
        <div>
          <div className="flex items-center gap-2">
            <span className="min-w-[120px] bg-tb-top px-2 py-px text-center font-bold text-white">{type.name}</span>
            <span className="flex items-center gap-1">
              No.<b>{number}</b>
            </span>
          </div>
          <div className="mt-px flex items-center">
            <span className="w-28">Reference No</span>
            <span className="mr-2">:</span>
            <input className="tb-input w-40" value={reference} onChange={(e) => (touch(), setReference(e.target.value))} />
          </div>
        </div>
        <div className="text-right">
          <input
            ref={dateRef}
            className="tb-input w-28 text-right font-bold"
            value={dateText}
            onChange={(e) => (touch(), setDateText(e.target.value))}
            onKeyDown={enterKey(() => {
              const iso = parseDate(dateText, company?.fy_start, dateIso);
              if (!iso) return toast('Invalid date', 'err');
              setDateText(fmtDate(iso));
              focus('product');
            })}
            onBlur={() => {
              const iso = parseDate(dateText, company?.fy_start, dateIso);
              if (iso) setDateText(fmtDate(iso));
            }}
          />
          <div className="pr-1">{weekday(dateIso)}</div>
        </div>
      </div>

      <div className="mt-2 text-center font-bold underline">Manufacture of Materials</div>
      <div className="mt-3 flex flex-wrap items-center justify-center gap-x-6">
        <span className="flex items-center gap-2">
          <i>Name of product:</i>
          <span className="w-[230px]">
            <PickerInput
              className="tb-input w-full font-bold"
              value={productText}
              title="Stock Items"
              options={itemOpts}
              inputRef={cellRef('product')}
              onChange={(t) => {
                touch();
                setProductText(t);
                setProduct(null);
              }}
              onPick={(o) => void pickProduct(items.find((x) => x.id === o.id)!)}
              onNoMatch={() => toast('Select the name of product', 'err')}
            />
          </span>
        </span>
        <span className="flex items-center gap-2">
          Name of BOM:
          <span className="w-[190px]">
            <PickerInput
              className="tb-input w-full font-bold"
              value={bomText}
              title="BOM"
              options={bomOpts}
              inputRef={cellRef('bom')}
              disabled={!product}
              onChange={(t) => (touch(), setBomText(t))}
              onPick={(o) => {
                touch();
                const b = bomList.find((x) => x.id === o.id) ?? null;
                setBom(b);
                setBomText(o.label);
                focus(multiHouse ? 'mgodown' : 'qty');
              }}
              onNoMatch={() => toast('Select a BOM from the list', 'err')}
              onBackspaceEmpty={() => focus('product')}
            />
          </span>
        </span>
        {multiHouse && (
          <span className="flex items-center gap-2">
            <i>Godown:</i>
            <span className="w-[170px]">
              <PickerInput
                className="tb-input w-full font-bold"
                value={godownText}
                title="Godowns"
                options={houseOpts}
                inputRef={cellRef('mgodown')}
                onChange={(t) => (touch(), setGodownText(t), setGodown(null))}
                onPick={(o) => {
                  setGodown(houses.find((g) => g.id === o.id)!);
                  setGodownText(o.label);
                  focus('qty');
                }}
                onNoMatch={() => toast('Select a godown', 'err')}
                onBackspaceEmpty={() => focus(bomList.length ? 'bom' : 'product')}
              />
            </span>
          </span>
        )}
        <span className="flex items-center gap-2">
          <i>Qty :</i>
          <input
            className="tb-input tb-num w-24 font-bold"
            ref={cellRef('qty')}
            value={qty}
            disabled={!product}
            onChange={(e) => (touch(), setQty(e.target.value))}
            onKeyDown={enterKey(commitQty, () => focus(multiHouse ? 'mgodown' : bomList.length ? 'bom' : 'product'))}
          />
          <b>{unitOf(product)}</b>
        </span>
      </div>
      <div className="mt-1 text-center">
        <b>%- &nbsp;of Cost allocation</b>
        <b className="ml-8">{plan ? P(plan.primary_pct_bp) : product ? '100 %' : ''}</b>
      </div>

      <div className="mt-3 grid flex-1 grid-cols-2 border-t border-tb-line">
        <div className="flex flex-col border-r border-tb-line">
          <div className="border-b border-tb-line text-center font-bold">Components (Consumption)</div>
          <div className={head}>
            <div className="grid grid-cols-[1fr_1fr] px-1">
              <span>Name of Item</span>
              <span>{multiHouse ? 'Godown' : ''}</span>
            </div>
            <div className={lcols}>
              <span />
              <span className="pr-1 text-right">Quantity</span>
              <span className="pr-1 text-right">Rate</span>
              <span className="pr-1 text-right">Amount</span>
            </div>
          </div>
          <div className="flex-1 pt-2">
            {comps.map((l, i) => {
              const p = cIdx.has(i) ? plan?.components[cIdx.get(i)!] : undefined;
              return (
                <div key={i} className="mb-1">
                  <div className="grid grid-cols-[1fr_1fr] items-center">
                    <PickerInput
                      className="tb-input w-full font-bold"
                      value={l.text}
                      title="Stock Items"
                      options={itemOpts}
                      inputRef={cellRef(`c${i}-0`)}
                      onChange={(t) => updC(i, { text: t, item: null })}
                      onPick={(o) => {
                        updC(i, { item: items.find((x) => x.id === o.id)!, text: o.label });
                        focus(multiHouse ? `c${i}-g` : `c${i}-q`);
                      }}
                      onEmptyEnter={() => (comps.some((c) => c.item) ? toBys() : toast('Add at least one component', 'err'))}
                      onNoMatch={() => toast('Select an item from the list', 'err')}
                      onBackspaceEmpty={() => (i === 0 ? focus('qty') : focus(`c${i - 1}-r`))}
                    />
                    {multiHouse ? (
                      <PickerInput
                        className="tb-input w-full"
                        value={l.godownText}
                        title="Godowns"
                        options={houseOpts}
                        inputRef={cellRef(`c${i}-g`)}
                        onChange={(t) => updC(i, { godownText: t, godown: null })}
                        onPick={(o) => {
                          updC(i, { godown: houses.find((g) => g.id === o.id)!, godownText: o.label });
                          focus(`c${i}-q`);
                        }}
                        onNoMatch={() => toast('Select a godown', 'err')}
                        onBackspaceEmpty={() => focus(`c${i}-0`)}
                      />
                    ) : (
                      <span />
                    )}
                  </div>
                  {l.item && (
                    <div className={lcols}>
                      <span />
                      <span className="flex items-center justify-end">
                        <input
                          className="tb-input tb-num w-full"
                          data-cell={`c${i}-q`}
                          value={l.qty}
                          onChange={(e) => updC(i, { qty: e.target.value })}
                          onKeyDown={enterKey(
                            () => {
                              const q = parseQty(l.qty);
                              if (!q) return toast('Enter a valid quantity', 'err');
                              updC(i, { qty: qtyText(q) });
                              focus(`c${i}-r`);
                            },
                            () => focus(multiHouse ? `c${i}-g` : `c${i}-0`)
                          )}
                        />
                        <span className="pl-1 text-[12px]">{l.item.unit}</span>
                      </span>
                      <input
                        className="tb-input tb-num w-full italic"
                        data-cell={`c${i}-r`}
                        value={l.fixed ? l.rate : p ? fmtAmount(p.rate, false) : ''}
                        onChange={(e) => updC(i, { rate: e.target.value, fixed: e.target.value.trim() !== '' })}
                        onKeyDown={enterKey(() => {
                          if (l.fixed && parseAmount(l.rate) === null) return toast('Enter a valid rate', 'err');
                          if (i === comps.length - 1) setComps((ls) => [...ls, blankC(houses[0])]);
                          focus(`c${i + 1}-0`);
                        })}
                      />
                      <span className="tb-num pr-1">{p ? fmtAmount(p.amount, false) : ''}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className={`${lcols} border-t border-tb-line font-bold`}>
            <span />
            <span className="tb-num pr-1">{plan?.components_qty ? fmtQty(plan.components_qty, 0, plan.components[0]?.unit ?? '') : ''}</span>
            <span />
            <span className="tb-num pr-1">{plan ? fmtAmount(plan.components_cost, false) : ''}</span>
          </div>
        </div>

        <div className="flex flex-col">
          <div className="border-b border-tb-line text-center font-bold">Co-Product/By-Product/Scrap</div>
          <div className={head}>
            <div className="grid grid-cols-[1fr_100px_120px_90px] px-1">
              <span>Name of Item</span>
              <span>Type</span>
              <span>{multiHouse ? 'Godown' : ''}</span>
              <span className="text-right">% of Cost</span>
            </div>
            <div className={rcols}>
              <span />
              <span className="pr-1 text-right font-normal">allocation</span>
              <span />
              <span />
            </div>
            <div className={rcols}>
              <span />
              <span className="pr-1 text-right">Quantity</span>
              <span className="pr-1 text-right">Rate</span>
              <span className="pr-1 text-right">Amount</span>
            </div>
          </div>
          <div className="pt-2">
            {bys.map((l, i) => {
              const p = bIdx.has(i) ? plan?.byproducts[bIdx.get(i)!] : undefined;
              const hasPct = (parseAmount(l.pct || '0') ?? 0) > 0;
              return (
                <div key={i} className="mb-1">
                  <div className="grid grid-cols-[1fr_100px_120px_90px] items-center">
                    <PickerInput
                      className="tb-input w-full font-bold"
                      value={l.text}
                      title="Stock Items"
                      options={itemOpts}
                      inputRef={cellRef(`b${i}-0`)}
                      onChange={(t) => updB(i, { text: t, item: null })}
                      onPick={(o) => {
                        updB(i, { item: items.find((x) => x.id === o.id)!, text: o.label });
                        focus(`b${i}-k`);
                      }}
                      onEmptyEnter={toAddl}
                      onNoMatch={() => toast('Select an item from the list', 'err')}
                      onBackspaceEmpty={() => focus(i === 0 ? 'c0-0' : `b${i - 1}-r`)}
                    />
                    {l.item ? (
                      <PickerInput
                        className="tb-input w-full"
                        value={l.kind}
                        title="Component Type"
                        options={kindOpts}
                        inputRef={cellRef(`b${i}-k`)}
                        onChange={() => undefined}
                        onPick={(o) => {
                          updB(i, { kind: o.id as ByProductType });
                          focus(multiHouse ? `b${i}-g` : `b${i}-p`);
                        }}
                        onBackspaceEmpty={() => focus(`b${i}-0`)}
                      />
                    ) : (
                      <span />
                    )}
                    {l.item && multiHouse ? (
                      <PickerInput
                        className="tb-input w-full"
                        value={l.godownText}
                        title="Godowns"
                        options={houseOpts}
                        inputRef={cellRef(`b${i}-g`)}
                        onChange={(t) => updB(i, { godownText: t, godown: null })}
                        onPick={(o) => {
                          updB(i, { godown: houses.find((g) => g.id === o.id)!, godownText: o.label });
                          focus(`b${i}-p`);
                        }}
                        onNoMatch={() => toast('Select a godown', 'err')}
                        onBackspaceEmpty={() => focus(`b${i}-k`)}
                      />
                    ) : (
                      <span />
                    )}
                    {l.item ? (
                      <span className="flex items-center">
                        <input
                          className="tb-input tb-num w-full"
                          data-cell={`b${i}-p`}
                          value={l.pct}
                          onChange={(e) => updB(i, { pct: e.target.value, fixed: e.target.value.trim() ? false : l.fixed })}
                          onKeyDown={enterKey(() => {
                            const v = parseAmount(l.pct || '0');
                            if (v === null || v < 0 || v > 10000) return toast('Enter a percentage between 0 and 100', 'err');
                            updB(i, { pct: v ? fmtAmount(v, false) : '' });
                            focus(`b${i}-q`);
                          })}
                        />
                        <span className="pl-1">%</span>
                      </span>
                    ) : (
                      <span />
                    )}
                  </div>
                  {l.item && (
                    <div className={rcols}>
                      <span />
                      <span className="flex items-center justify-end">
                        <input
                          className="tb-input tb-num w-full"
                          data-cell={`b${i}-q`}
                          value={l.qty}
                          onChange={(e) => updB(i, { qty: e.target.value })}
                          onKeyDown={enterKey(
                            () => {
                              const q = parseQty(l.qty);
                              if (!q) return toast('Enter a valid quantity', 'err');
                              updB(i, { qty: qtyText(q) });
                              if (hasPct) {
                                if (i === bys.length - 1) setBys((ls) => [...ls, blankB(houses[0])]);
                                focus(`b${i + 1}-0`);
                              } else focus(`b${i}-r`);
                            },
                            () => focus(`b${i}-p`)
                          )}
                        />
                        <span className="pl-1 text-[12px]">{l.item.unit}</span>
                      </span>
                      <input
                        className="tb-input tb-num w-full italic"
                        data-cell={`b${i}-r`}
                        value={l.fixed ? l.rate : p ? fmtAmount(p.rate, false) : ''}
                        readOnly={hasPct}
                        onChange={(e) => updB(i, { rate: e.target.value, fixed: e.target.value.trim() !== '' })}
                        onKeyDown={enterKey(() => {
                          if (l.fixed && parseAmount(l.rate) === null) return toast('Enter a valid rate', 'err');
                          if (i === bys.length - 1) setBys((ls) => [...ls, blankB(houses[0])]);
                          focus(`b${i + 1}-0`);
                        })}
                      />
                      <span className="tb-num pr-1">{p ? fmtAmount(p.amount, false) : ''}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="mt-auto">
            <div className="flex justify-between font-bold">
              <span>Cost of components:</span>
              <span className="tb-num pr-1">{plan ? fmtAmount(plan.components_cost, false) : ''}</span>
            </div>
            <div className="grid grid-cols-[1fr_90px_110px_130px] pl-6 font-bold italic">
              <span>Type of Additional Cost</span>
              <span className="text-right">Percentage</span>
              <span className="text-right">Amount</span>
              <span />
            </div>
            {addl.map((a, i) => {
              const p = aIdx.has(i) ? plan?.addl[aIdx.get(i)!] : undefined;
              return (
                <div key={i} className="grid grid-cols-[1fr_90px_110px_130px] items-center pl-6 italic">
                  <PickerInput
                    className="tb-input w-full"
                    value={a.text}
                    title="Ledger Accounts"
                    options={ledgerOpts}
                    inputRef={cellRef(`a${i}-0`)}
                    onChange={(t) => updA(i, { text: t, ledger: null })}
                    onPick={(o) => {
                      updA(i, { ledger: ledgers.find((x) => x.id === o.id)!, text: o.label });
                      focus(`a${i}-p`);
                    }}
                    onEmptyEnter={() => narrRef.current?.focus()}
                    onNoMatch={() => toast('Select a ledger', 'err')}
                    onBackspaceEmpty={() => focus(i === 0 ? 'b0-0' : `a${i - 1}-p`)}
                  />
                  <input
                    className="tb-input tb-num w-full"
                    data-cell={`a${i}-p`}
                    value={a.pct}
                    disabled={!a.ledger}
                    onChange={(e) => updA(i, { pct: e.target.value })}
                    onKeyDown={enterKey(
                      () => {
                        const v = parseAmount(a.pct || '0');
                        if (v === null || v < 0) return toast('Enter a valid percentage', 'err');
                        updA(i, { pct: v ? fmtAmount(v, false) : '' });
                        if (v) {
                          if (i === addl.length - 1) setAddl((ls) => [...ls, blankA()]);
                          focus(`a${i + 1}-0`);
                        } else focus(`a${i}-m`);
                      },
                      () => focus(`a${i}-0`)
                    )}
                  />
                  <input
                    className="tb-input tb-num w-full"
                    data-cell={`a${i}-m`}
                    value={a.pct ? '' : a.amount}
                    disabled={!a.ledger || !!a.pct}
                    onChange={(e) => updA(i, { amount: e.target.value })}
                    onKeyDown={enterKey(
                      () => {
                        const v = parseAmount(a.amount || '0');
                        if (v === null || v < 0) return toast('Enter a valid amount', 'err');
                        updA(i, { amount: v ? fmtAmount(v, false) : '' });
                        if (i === addl.length - 1) setAddl((ls) => [...ls, blankA()]);
                        focus(`a${i + 1}-0`);
                      },
                      () => focus(`a${i}-p`)
                    )}
                  />
                  <span className="tb-num pr-1">{p ? fmtAmount(p.amount, false) : ''}</span>
                </div>
              );
            })}
            <div className="mt-3 grid grid-cols-[200px_16px_1fr_160px]">
              <span>Total Addl. Cost</span>
              <span>:</span>
              <span />
              <span className="tb-num pr-1">{plan?.addl_cost ? fmtAmount(plan.addl_cost, false) : ''}</span>
              <span>Effective Cost</span>
              <span>:</span>
              <span />
              <span className="tb-num border-t border-tb-ink pr-1">{plan ? fmtAmount(plan.effective_cost, false) : ''}</span>
              <span>Allocation to Primary Item</span>
              <span>:</span>
              <span />
              <span className="tb-num border-t border-tb-ink pr-1">{plan ? fmtAmount(plan.primary_cost, false) : ''}</span>
              <span>Effective rate of Primary Item</span>
              <span>:</span>
              <span />
              <span className="tb-num pr-1">{plan ? R(plan.primary_rate, plan.unit) : ''}</span>
            </div>
            {planError && <div className="mt-1 text-tb-danger">{planError}</div>}
          </div>
        </div>
      </div>

      <div className="mt-2 flex items-center gap-2 border-t border-tb-line pt-1">
        <label>Narration:</label>
        <input
          ref={narrRef}
          className="tb-input flex-1"
          value={narration}
          onChange={(e) => (touch(), setNarration(e.target.value))}
          onKeyDown={async (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation();
              void accept();
            } else if (e.key === 'Backspace' && narration === '') {
              e.preventDefault();
              focus('a0-0');
            }
          }}
        />
      </div>
    </div>
  );
}

function useMfgReport({ name, title, defs, count, keys = {}, buttons = [], noPeriod }: { name: string; title: string; defs: OptionDef[]; count: number; keys?: Record<string, KeyHandler>; buttons?: Btn[]; noPeriod?: boolean }) {
  const p = usePeriodKey();
  const cfg = useReportOptions(name, title, defs);
  const s = useSel(count);
  useScreen({ title, noPeriod, keys: { ...s.keys, ...p.key, ...cfg.key, ...keys }, buttons: [p.button, ...buttons, cfg.button] });
  return { ...s, cfg };
}

const EST_DEFS: OptionDef[] = [
  { key: 'allBoms', label: 'Show all BOMs (BoM Type: All Items)', default: false },
  { key: 'detailed', label: 'Format of Report: Detailed (show components)', default: true },
  { key: 'qty', label: 'Show Quantity', default: true },
  { key: 'cost', label: 'Show Cost', default: true },
  { key: 'amount', label: 'Show Amount', default: true },
];

interface EstLine {
  key: string;
  level: 0 | 1 | 2;
  label: string;
  qty: string;
  cost: string;
  amount: string;
  strong: boolean;
  open?: () => void;
}

export function CostEstimationReport({ groupId: initialGroup = null }: { groupId?: number | null }) {
  const { books, period } = useStore();
  const nav = useNav();
  const [groupId, setGroupId] = useState<number | null>(initialGroup);
  const groups = useLoad(() => stockGroups(books.db), []);
  const groupName = groupId ? (groups?.find((g) => g.id === groupId)?.name ?? '') : 'Primary';
  const pickGroup = () => {
    if (groups)
      nav.push(<SelectList title="Name of Group" heading="List of Stock Groups" popOnSelect items={[{ id: 0, label: 'Primary' }, ...groups.map((g) => ({ id: g.id, label: g.name }))]} onSelect={(i) => setGroupId(Number(i.id) || null)} />);
  };
  const [lines, setLines] = useState<EstLine[]>([]);
  const selRef = useRef(0);
  const { sel, setSel, cfg } = useMfgReport({
    name: 'mfg.estimate',
    title: 'Item Estimates',
    defs: EST_DEFS,
    count: lines.length,
    keys: { F4: pickGroup, Enter: () => lines[selRef.current]?.open?.() },
    buttons: [{ key: 'F4', label: 'Stock Group', run: pickGroup }],
  });
  selRef.current = sel;
  const opts = cfg.values;
  const data = useLoad(() => costEstimation(books.db, period.to, { groupId, allBoms: opts.allBoms }), [period.to, groupId, opts.allBoms]);
  useEffect(() => {
    if (!data) return;
    const out: EstLine[] = [];
    let lastItem = 0;
    for (const r of data.rows) {
      const open = () => nav.push(<BomComponentsScreen itemId={r.item_id} bomId={r.bom_id} />);
      const head = { qty: Q(r.qty, r.unit), cost: R(r.cost, r.unit), amount: A(r.amount), open };
      if (opts.allBoms) {
        if (r.item_id !== lastItem) out.push({ key: `i${r.item_id}`, level: 0, label: r.name, qty: '', cost: '', amount: '', strong: true });
        out.push({ key: `b${r.bom_id}`, level: 1, label: r.bom, strong: true, ...head });
      } else out.push({ key: `b${r.bom_id}`, level: 0, label: r.name, strong: true, ...head });
      lastItem = r.item_id;
      if (opts.detailed)
        for (const [k, l] of r.lines.entries())
          out.push({
            key: `b${r.bom_id}-${k}`,
            level: opts.allBoms ? 2 : 1,
            label: l.kind === 'Component' ? l.name : `${l.name} (${l.kind})`,
            qty: Q(l.qty, l.unit),
            cost: R(l.rate, l.unit),
            amount: l.kind === 'Component' ? A(l.amount) : A(-l.amount),
            strong: l.has_bom,
            open,
          });
    }
    setLines(out);
  }, [data, opts.allBoms, opts.detailed, nav]);
  if (!data) return null;
  const show = (k: string) => opts[k] !== false;
  return (
    <Frame title="Item Estimates" subtitle={`as at ${fmtDate(period.to)}`} coSub={`as at ${fmtDate(period.to)}`}>
      <div className="mb-1 text-[14px]">
        <div>
          Items Under : <b>{'♦'} {groupName}</b>
        </div>
        <div>
          BoM Type : <b>{opts.allBoms ? `♦ All Items` : 'Default'}</b>
        </div>
      </div>
      <table className="w-full">
        <thead>
          <tr>
            <th className={`${th} text-left`}>Particulars</th>
            {show('qty') && <th className={`${th} w-32 text-right`}>Qty</th>}
            {show('cost') && <th className={`${th} w-36 text-right`}>Cost</th>}
            {show('amount') && <th className={`${th} w-36 text-right`}>Amount</th>}
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={l.key} className={rowCls(i === sel, l.level === 0 ? 'font-bold' : '')} onMouseEnter={() => setSel(i)} onClick={() => l.open?.()}>
              <td className="px-2" style={{ paddingLeft: 8 + l.level * 16 }}>
                <span className={`${l.level > 0 ? 'italic' : ''} ${l.strong ? 'font-bold' : ''}`}>{l.label}</span>
              </td>
              {show('qty') && <td className={`${num} ${l.level > 0 && !l.strong ? 'italic' : ''}`}>{l.qty}</td>}
              {show('cost') && <td className={`${num} italic`}>{l.cost}</td>}
              {show('amount') && <td className={`${num} ${l.strong ? 'font-bold' : ''}`}>{l.amount}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      {lines.length === 0 && <div className="py-3 text-tb-muted">No stock item under this group has a bill of materials. Set components in Stock Item Alteration &gt; Set Components (BOM).</div>}
    </Frame>
  );
}

function ItemGate({ itemId, title, load, children }: { itemId?: number | null; title: string; load: () => Promise<ListItem[]>; children: (id: number, change: () => void) => ReactNode }) {
  const nav = useNav();
  const list = useLoad(load, []);
  const [cur, setCur] = useState<number | null>(itemId ?? null);
  if (cur === null) return list ? <SelectList title={title} heading="List of Stock Items" items={list} empty="No stock item has a bill of materials" onSelect={(i) => setCur(Number(i.id))} /> : null;
  const change = () => list && nav.push(<SelectList title={title} heading="List of Stock Items" popOnSelect items={list} onSelect={(i) => setCur(Number(i.id))} />);
  return <div key={cur}>{children(cur, change)}</div>;
}

export function JobCostingReport({ itemId }: { itemId?: number }) {
  const { books } = useStore();
  return (
    <ItemGate itemId={itemId} title="Job Costing" load={async () => (await loadItems(books.db)).map((i) => ({ id: i.id, label: i.name }))}>
      {(id, change) => <JobCostingView itemId={id} change={change} />}
    </ItemGate>
  );
}

const JOB_DEFS: OptionDef[] = [{ key: 'vouchers', label: 'Show voucher-wise details', default: true }];

function JobCostingView({ itemId, change }: { itemId: number; change: () => void }) {
  const { books, period } = useStore();
  const nav = useNav();
  const data = useLoad(() => jobCosting(books.db, itemId, period.from, period.to), [itemId, period]);
  const rows = data?.vouchers ?? [];
  const ref = useRef(rows);
  ref.current = rows;
  const selRef = useRef(0);
  const { sel, setSel, cfg } = useMfgReport({
    name: 'mfg.job',
    title: 'Job Costing',
    defs: JOB_DEFS,
    count: rows.length,
    keys: { F4: change, Enter: () => ref.current[selRef.current] && nav.push(<ManufacturingJournalScreen voucherId={ref.current[selRef.current].voucher_id} />) },
    buttons: [{ key: 'F4', label: 'Stock Item', run: change }],
  });
  selRef.current = sel;
  if (!data) return null;
  const t = data.totals;
  const sec = 'px-2 pt-2 font-bold';
  return (
    <Frame title={`Job Costing : ${data.name}`}>
      <table className="w-full">
        <thead>
          <tr>
            <th className={`${th} text-left`}>Particulars</th>
            <th className={`${th} w-36 text-right`}>Quantity</th>
            <th className={`${th} w-36 text-right`}>Rate</th>
            <th className={`${th} w-40 text-right`}>Value</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className={sec} colSpan={4}>
              Consumption
            </td>
          </tr>
          {data.consumed.map((c) => (
            <tr key={`c${c.item_id}`}>
              <td className="px-2 pl-6 italic">{c.name}</td>
              <td className={num}>{Q(c.qty, c.unit)}</td>
              <td className={`${num} italic`}>{R(c.rate, c.unit)}</td>
              <td className={num}>{A(c.value)}</td>
            </tr>
          ))}
          {data.addl.length > 0 && (
            <tr>
              <td className="px-2 pl-4 font-bold italic" colSpan={4}>
                Additional Cost
              </td>
            </tr>
          )}
          {data.addl.map((a) => (
            <tr key={`a${a.ledger_id}`}>
              <td className="px-2 pl-6 italic">{a.ledger}</td>
              <td />
              <td />
              <td className={num}>{A(a.amount)}</td>
            </tr>
          ))}
          <tr className="font-bold">
            <td className="px-2">Total Cost</td>
            <td />
            <td />
            <td className={`${num} border-t border-tb-ink`}>{fmtAmount(t.components_cost + t.addl_cost, false)}</td>
          </tr>
          <tr>
            <td className={sec} colSpan={4}>
              Production
            </td>
          </tr>
          {data.produced.map((c) => (
            <tr key={`p${c.item_id}-${c.kind}`} className={c.kind === 'Primary' ? 'font-bold' : ''}>
              <td className="px-2 pl-6 italic">{c.kind === 'Primary' ? c.name : `${c.name} (${c.kind})`}</td>
              <td className={num}>{Q(c.qty, c.unit)}</td>
              <td className={`${num} italic`}>{R(c.rate, c.unit)}</td>
              <td className={num}>{A(c.value)}</td>
            </tr>
          ))}
          <tr className="font-bold">
            <td className={totL}>Grand Total</td>
            <td className={tot}>{Q(t.qty, data.unit)}</td>
            <td className={tot}>{R(t.rate, data.unit)}</td>
            <td className={tot}>{fmtAmount(t.primary_cost + t.byproduct_cost, false)}</td>
          </tr>
        </tbody>
      </table>
      {cfg.values.vouchers && (
        <table className="mt-4 w-full">
          <thead>
            <tr>
              <th className={`${th} text-left`}>Date</th>
              <th className={`${th} text-left`}>Vch Type</th>
              <th className={`${th} text-left`}>Vch No.</th>
              <th className={`${th} text-left`}>BOM</th>
              <th className={`${th} text-right`}>Quantity</th>
              <th className={`${th} text-right`}>Cost of Components</th>
              <th className={`${th} text-right`}>Addl. Cost</th>
              <th className={`${th} text-right`}>Co/By-Product/Scrap</th>
              <th className={`${th} text-right`}>Allocation to Primary Item</th>
              <th className={`${th} text-right`}>Effective Rate</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.voucher_id} className={rowCls(i === sel)} onMouseEnter={() => setSel(i)} onClick={() => nav.push(<ManufacturingJournalScreen voucherId={r.voucher_id} />)}>
                <td className="px-2">{fmtDate(r.date)}</td>
                <td className="px-2">{r.type}</td>
                <td className="px-2">{r.number}</td>
                <td className="px-2">{r.bom}</td>
                <td className={num}>{Q(r.qty, data.unit)}</td>
                <td className={num}>{A(r.components_cost)}</td>
                <td className={num}>{A(r.addl_cost)}</td>
                <td className={num}>{A(r.byproduct_cost)}</td>
                <td className={num}>{A(r.primary_cost)}</td>
                <td className={`${num} italic`}>{R(r.rate, data.unit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows.length === 0 && <div className="py-3 text-tb-muted">No Manufacturing Journal for {data.name} in this period.</div>}
    </Frame>
  );
}

export function MaterialRequirementReport({ itemId }: { itemId?: number }) {
  const { books } = useStore();
  return (
    <ItemGate itemId={itemId} title="Material Requirement" load={async () => (await itemsWithBom(books.db)).map((r) => ({ id: r.item_id, label: r.name }))}>
      {(id, change) => <MaterialRequirementView itemId={id} change={change} />}
    </ItemGate>
  );
}

function RequirementForm({ itemId, initial, onDone }: { itemId: number; initial?: { bomId: number; qty: number }; onDone: (v: { bomId: number; qty: number }) => void }) {
  const { books, toast } = useStore();
  const nav = useNav();
  const form = useRef<FormHandle>(null);
  const list = useLoad(() => loadBoms(books.db, itemId), [itemId]);
  const item = useLoad(() => stockItem(books.db, itemId), [itemId]);
  const submit = (v: Record<string, unknown>) => {
    const q = parseQty(String(v.qty ?? ''));
    if (!q) return toast('Quantity: enter a valid number', 'err');
    nav.pop();
    onDone({ bomId: Number(v.bom), qty: q });
  };
  const accept = () => {
    const v = form.current?.submit();
    if (v) submit(v);
  };
  useScreen({ title: 'Material Requirement', noPeriod: true, keys: { 'Ctrl+A': accept }, buttons: [{ key: 'Ctrl+A', label: 'Accept', run: accept }] });
  if (!list || !item) return null;
  const opts: Opt[] = list.map((b) => ({ id: b.id, label: b.name }));
  const fields: FieldDef[] = [
    { key: 'bom', label: 'Name of BOM', kind: 'picker', title: `BOM List of : ${item.name}`, options: opts, initial: opts.find((o) => o.id === initial?.bomId) ?? opts[0], required: true },
    { key: 'qty', label: `Quantity to manufacture (${item.unit})`, kind: 'text', required: true, initial: initial ? qtyText(initial.qty) : qtyText(list[0]?.unit_qty ?? 0) },
  ];
  return (
    <div className="mx-auto mt-8 max-w-xl">
      <div className="mb-2 text-center font-bold">
        Name of product : <span>{item.name}</span>
      </div>
      <Form ref={form} fields={fields} labelWidth={260} onDone={submit} />
    </div>
  );
}

function MaterialRequirementView({ itemId, change }: { itemId: number; change: () => void }) {
  const { books, period } = useStore();
  const nav = useNav();
  const [plan, setPlan] = useState<{ bomId: number; qty: number } | null>(null);
  const ask = () => nav.push(<RequirementForm itemId={itemId} initial={plan ?? undefined} onDone={setPlan} />);
  const data = useLoad(() => (plan ? materialRequirement(books.db, { item_id: itemId, bom_id: plan.bomId, qty: plan.qty, as_at: period.to }) : Promise.resolve(null)), [itemId, plan, period.to]);
  const rows = data?.rows ?? [];
  const { sel, setSel } = useMfgReport({
    name: 'mfg.mrp',
    title: 'Material Requirement',
    defs: [],
    count: rows.length,
    keys: { F4: change, F6: ask },
    buttons: [
      { key: 'F4', label: 'Stock Item', run: change },
      { key: 'F6', label: 'Planned Qty', run: ask },
    ],
  });
  const asked = useRef(false);
  useEffect(() => {
    if (!asked.current) {
      asked.current = true;
      ask();
    }
  });
  if (!plan) return <div className="py-3 text-tb-muted">Press F6 to enter the planned quantity to manufacture.</div>;
  if (!data) return null;
  return (
    <Frame title={`Material Requirement : ${data.name}`} subtitle={`as at ${fmtDate(period.to)}`} coSub={`as at ${fmtDate(period.to)}`}>
      <div className="mb-1 text-[14px]">
        <div>
          Planned Quantity : <b>{fmtQty(data.qty, 0, data.unit)}</b>
        </div>
        <div>
          BoM : <b>{data.bom}</b>
        </div>
      </div>
      <table className="w-full">
        <thead>
          <tr>
            <th className={`${th} text-left`}>Particulars</th>
            <th className={`${th} text-left`}>Godown</th>
            <th className={`${th} text-right`}>Required</th>
            <th className={`${th} text-right`}>Stock in Hand</th>
            <th className={`${th} text-right`}>Godown Stock</th>
            <th className={`${th} text-right`}>Shortfall</th>
            <th className={`${th} text-right`}>Rate</th>
            <th className={`${th} text-right`}>Value of Shortfall</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.item_id}-${r.godown_id}`} className={rowCls(i === sel, r.shortfall ? 'font-bold' : '')} onMouseEnter={() => setSel(i)}>
              <td className="px-2">{r.name}</td>
              <td className="px-2">{r.godown}</td>
              <td className={num}>{Q(r.required, r.unit)}</td>
              <td className={num}>{r.in_stock < 0 ? `(-)${fmtQty(-r.in_stock, 0, r.unit)}` : Q(r.in_stock, r.unit)}</td>
              <td className={num}>{r.godown_stock < 0 ? `(-)${fmtQty(-r.godown_stock, 0, r.unit)}` : Q(r.godown_stock, r.unit)}</td>
              <td className={num}>{Q(r.shortfall, r.unit)}</td>
              <td className={`${num} italic`}>{R(r.rate, r.unit)}</td>
              <td className={num}>{A(r.shortfall_value)}</td>
            </tr>
          ))}
          <tr className="font-bold">
            <td className={totL}>Grand Total</td>
            <td className={totL} colSpan={6} />
            <td className={tot}>{fmtAmount(data.shortfall_value, false)}</td>
          </tr>
        </tbody>
      </table>
      <div className="mt-2">
        Quantity that can be manufactured with stock in hand : <b>{fmtQty(data.max_producible, 0, data.unit) || '0'}</b>
      </div>
    </Frame>
  );
}
