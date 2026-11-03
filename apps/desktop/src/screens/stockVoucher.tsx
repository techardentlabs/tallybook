import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { fmtAmount, fmtQty, godowns as loadGodowns, lineAmount, parseAmount, parseQty, pendingDocs, stockItems as loadItems, type Godown, type Ledger, type PendingDoc, type StockItem } from '@tallybook/core';
import { PickerInput, type Opt } from '../ui/PickerInput.tsx';
import { useStore } from '../store.tsx';
import { PARTY_ROOTS, isUnder } from '../lib.ts';
import type { BodyHandle, BodyProps } from './voucherParts.tsx';

interface Line {
  item: StockItem | null;
  text: string;
  godown: Godown | null;
  godownText: string;
  side: 'Out' | 'In';
  qty: string;
  rate: string;
  against?: number;
}

const WITH_PARTY = ['Delivery Note', 'Receipt Note', 'Sales Order', 'Purchase Order', 'Rejection In', 'Rejection Out'];
const OUTWARD = ['Delivery Note', 'Rejection Out'];
const blank = (g?: Godown, side: 'Out' | 'In' = 'Out'): Line => ({ item: null, text: '', godown: g ?? null, godownText: g?.name ?? '', side, qty: '', rate: '' });

export const StockBody = forwardRef<BodyHandle, BodyProps>(function StockBody(props, handle) {
  const { type, ledgers, groups, onFinish, onDirty, initial } = props;
  const { company, toast, version } = useStore();
  const { books } = useStore();
  const parent = type.parent;
  const journal = parent === 'Stock Journal';
  const physical = parent === 'Physical Stock';
  const withParty = WITH_PARTY.includes(parent);

  const [items, setItems] = useState<StockItem[]>([]);
  const [houses, setHouses] = useState<Godown[]>([]);
  useEffect(() => {
    void Promise.all([loadItems(books.db), loadGodowns(books.db)]).then(([i, g]) => {
      setItems(i);
      setHouses(g);
    });
  }, [books, version]);

  const partyLedgers = useMemo(() => ledgers.filter((l) => isUnder(groups, l, PARTY_ROOTS) || l.name === 'Cash'), [ledgers, groups]);
  const partyOpts: Opt[] = partyLedgers.map((l) => ({ id: l.id, label: l.name }));
  const itemOpts: Opt[] = items.map((i) => ({ id: i.id, label: i.name }));
  const houseOpts: Opt[] = houses.map((g) => ({ id: g.id, label: g.name }));
  const multiHouse = houses.length > 1;

  const initParty = initial?.party_id ? partyLedgers.find((l) => l.id === initial.party_id) : undefined;
  const [partyText, setPartyText] = useState(initParty?.name ?? '');
  const [party, setParty] = useState<Ledger | null>(initParty ?? null);
  const [orders, setOrders] = useState<PendingDoc[]>([]);
  const [orderText, setOrderText] = useState('Not Applicable');
  const orderKind = parent === 'Delivery Note' ? 'Sales' : parent === 'Receipt Note' ? 'Purchase' : null;
  const [lines, setLines] = useState<Line[]>([blank(undefined, 'Out')]);
  const box = useRef<HTMLDivElement>(null);
  const dirty = useRef(false);
  const linesRef = useRef(lines);
  linesRef.current = lines;

  useEffect(() => {
    if (!initial?.items?.length || !items.length) return;
    setLines(
      initial.items.map((it) => {
        const item = items.find((x) => x.id === it.item_id) ?? null;
        const g = houses.find((x) => x.id === it.godown_id) ?? houses[0] ?? null;
        return { item, text: item?.name ?? '', godown: g, godownText: g?.name ?? '', side: it.qty < 0 ? 'Out' : 'In', qty: fmtQty(Math.abs(it.qty), 0), rate: fmtAmount(it.rate) };
      })
    );
  }, [initial, items, houses]);
  useEffect(() => {
    if (houses.length) setLines((ls) => ls.map((l) => (l.godown ? l : { ...l, godown: houses[0], godownText: houses[0].name })));
  }, [houses]);

  const touch = () => {
    if (!dirty.current) {
      dirty.current = true;
      onDirty();
    }
  };
  const focus = useCallback((sel: string) => {
    setTimeout(() => {
      const el = box.current?.querySelector(`[data-cell="${sel}"]`) as HTMLInputElement | null;
      el?.focus();
      el?.select?.();
    }, 0);
  }, []);
  const update = (i: number, patch: Partial<Line>) => {
    touch();
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  };
  const firstCell = withParty ? 'party' : 'i0-0';

  const signFor = (l: Line) => (journal ? (l.side === 'Out' ? -1 : 1) : OUTWARD.includes(parent) ? -1 : 1);

  useImperativeHandle(
    handle,
    () => ({
      async build() {
        if (withParty && !party) {
          toast('Select the party', 'err');
          return null;
        }
        const rows = linesRef.current.filter((l) => l.item && parseQty(l.qty));
        if (!rows.length) {
          toast('Add at least one item', 'err');
          return null;
        }
        const stock = rows.map((l) => {
          const q = parseQty(l.qty)!;
          const rate = parseAmount(l.rate) ?? 0;
          return { item_id: l.item!.id, godown_id: l.godown?.id ?? 1, qty: physical ? q : signFor(l) * q, rate, amount: lineAmount(q, rate) };
        });
        const track = rows.flatMap((l, index) => (l.against ? [{ index, against: l.against, qty: parseQty(l.qty)! }] : []));
        return { entries: [], party_id: party?.id ?? null, stock, track };
      },
      reset() {
        dirty.current = false;
        setParty(null);
        setPartyText('');
        setLines([blank(houses[0], 'Out')]);
        focus(firstCell);
      },
      focusFirst: () => focus(firstCell),
      removeLine() {
        setLines((ls) => (ls.length > 1 ? ls.slice(0, -1) : ls));
      },
      isDirty: () => dirty.current,
    }),
    [firstCell, focus, houses, parent, party, physical, toast, withParty, journal]
  );
  useEffect(() => {
    if (!initial?.items?.length) focus(firstCell);
  }, [focus, firstCell, initial]);

  const finish = () => {
    if (withParty && !party) return toast('Select the party', 'err');
    onFinish();
  };
  const cols = `grid ${journal ? 'grid-cols-[70px_1fr' : 'grid-cols-[1fr'}${multiHouse ? '_170px' : ''}_120px_120px_150px]`;
  const head = 'border-y border-tb-line py-px font-bold';
  void company;

  return (
    <div ref={box} className="flex min-h-[420px] flex-col">
      {withParty && (
        <div className="mt-3 flex items-center">
          <span className="w-44">Party A/c name</span>
          <span className="mr-2">:</span>
          <div className="w-[360px]">
            <PickerInput
              className="tb-input w-full font-bold"
              value={partyText}
              title="Ledger Accounts"
              options={partyOpts}
              inputRef={(el) => el?.setAttribute('data-cell', 'party')}
              onChange={(t) => {
                touch();
                setPartyText(t);
                setParty(null);
              }}
              onPick={(o) => {
                const l = ledgers.find((x) => x.id === o.id)!;
                setParty(l);
                setPartyText(l.name);
                if (orderKind && !initial?.items?.length) {
                  void pendingDocs(books.db, orderKind, 'note', l.id, props.date).then((d) => {
                    setOrders(d);
                    setOrderText('Not Applicable');
                    focus(d.length ? 'order' : 'i0-0');
                  });
                } else focus('i0-0');
              }}
              onNoMatch={() => toast('Select the party from the list', 'err')}
              onCreate={(text) => window.dispatchEvent(new CustomEvent('tb:create-ledger', { detail: { text, rowIndex: -1 } }))}
            />
          </div>
        </div>
      )}
      {orderKind && orders.length > 0 && (
        <div className="flex items-center">
          <span className="w-44">Order No.</span>
          <span className="mr-2">:</span>
          <div className="w-[360px]">
            <PickerInput
              className="tb-input w-full font-bold"
              value={orderText}
              title="Orders"
              options={[{ id: 0, label: 'Not Applicable' }, ...orders.map((d) => ({ id: d.voucher_id, label: d.number, sub: `${d.parent} · ${d.date.split('-').reverse().join('-')}` }))]}
              inputRef={(el) => el?.setAttribute('data-cell', 'order')}
              onChange={(t) => setOrderText(t)}
              onPick={(o) => {
                setOrderText(o.label);
                const d = orders.find((x) => x.voucher_id === o.id);
                if (d) {
                  touch();
                  setLines([
                    ...d.lines.map((pl) => {
                      const it = items.find((x) => x.id === pl.item_id) ?? null;
                      const g = houses.find((x) => x.id === pl.godown_id) ?? houses[0] ?? null;
                      return { item: it, text: it?.name ?? '', godown: g, godownText: g?.name ?? '', side: 'Out' as const, qty: fmtQty(pl.balance, 0), rate: fmtAmount(pl.rate), against: pl.movement_id };
                    }),
                    blank(houses[0], 'Out'),
                  ]);
                }
                focus('i0-0');
              }}
              onNoMatch={() => toast('Choose an order or Not Applicable', 'err')}
              onBackspaceEmpty={() => focus('party')}
            />
          </div>
        </div>
      )}
      <div className={`mt-3 ${cols} ${head}`}>
        {journal && <span className="pl-1">Source / Dest.</span>}
        <span className="pl-1">Name of Item</span>
        {multiHouse && <span>Godown</span>}
        <span className="pr-1 text-right">{physical ? 'Counted qty' : 'Quantity'}</span>
        <span className="pr-1 text-right">Rate</span>
        <span className="pr-1 text-right">Amount</span>
      </div>
      <div className="flex-1 pt-2">
        {lines.map((l, i) => {
          const q = parseQty(l.qty);
          const r = parseAmount(l.rate);
          const amt = q && r !== null ? lineAmount(q, r) : 0;
          const nextAfterRate = () => {
            if (i === linesRef.current.length - 1) setLines((ls) => [...ls, blank(houses[0], journal && linesRef.current[i].side === 'Out' ? 'In' : 'Out')]);
            focus(journal ? `i${i + 1}-s` : `i${i + 1}-0`);
          };
          return (
            <div key={i} className={`${cols} items-center`}>
              {journal && (
                <input
                  className="tb-input w-full font-bold"
                  data-cell={`i${i}-s`}
                  readOnly
                  value={l.side}
                  onKeyDown={(e) => {
                    const k = e.key.toLowerCase();
                    if (k === 'o' || k === 'i' || k === ' ' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                      e.preventDefault();
                      update(i, { side: k === 'o' ? 'Out' : k === 'i' ? 'In' : l.side === 'Out' ? 'In' : 'Out' });
                    } else if (e.key === 'Enter') {
                      e.preventDefault();
                      e.stopPropagation();
                      focus(`i${i}-0`);
                    }
                  }}
                />
              )}
              <PickerInput
                className="tb-input w-full font-bold"
                value={l.text}
                title="Stock Items"
                options={itemOpts}
                inputRef={(el) => el?.setAttribute('data-cell', `i${i}-0`)}
                onChange={(t) => update(i, { text: t, item: null })}
                onPick={(o) => {
                  const it = items.find((x) => x.id === o.id)!;
                  update(i, { item: it, text: it.name, rate: l.rate || (it.standard_price || it.opening_rate ? fmtAmount(it.standard_price || it.opening_rate, false) : '') });
                  focus(multiHouse ? `i${i}-g` : `i${i}-1`);
                }}
                onEmptyEnter={() => (i >= 1 ? finish() : toast('Select an item', 'err'))}
                onNoMatch={() => toast('Select an item from the list', 'err')}
                onBackspaceEmpty={() => (i === 0 ? (withParty ? focus('party') : undefined) : focus(`i${i - 1}-2`))}
              />
              {multiHouse && (
                <PickerInput
                  className="tb-input w-full"
                  value={l.godownText}
                  title="Godowns"
                  options={houseOpts}
                  inputRef={(el) => el?.setAttribute('data-cell', `i${i}-g`)}
                  onChange={(t) => update(i, { godownText: t, godown: null })}
                  onPick={(o) => {
                    update(i, { godown: houses.find((g) => g.id === o.id)!, godownText: o.label });
                    focus(`i${i}-1`);
                  }}
                  onNoMatch={() => toast('Select a godown', 'err')}
                  onBackspaceEmpty={() => focus(`i${i}-0`)}
                />
              )}
              <input
                className="tb-input tb-num w-full font-bold"
                data-cell={`i${i}-1`}
                value={l.qty}
                onChange={(e) => update(i, { qty: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!parseQty(l.qty)) return toast('Enter a valid quantity', 'err');
                    focus(`i${i}-2`);
                  } else if (e.key === 'Backspace' && l.qty === '') {
                    e.preventDefault();
                    e.stopPropagation();
                    focus(multiHouse ? `i${i}-g` : `i${i}-0`);
                  }
                }}
              />
              <input
                className="tb-input tb-num w-full font-bold"
                data-cell={`i${i}-2`}
                value={l.rate}
                onChange={(e) => update(i, { rate: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    e.stopPropagation();
                    const p = parseAmount(l.rate);
                    if (p === null) return toast('Enter a valid rate', 'err');
                    update(i, { rate: fmtAmount(p) });
                    nextAfterRate();
                  } else if (e.key === 'Backspace' && l.rate === '') {
                    e.preventDefault();
                    e.stopPropagation();
                    focus(`i${i}-1`);
                  }
                }}
              />
              <span className="tb-num pr-1 font-bold">{amt ? fmtAmount(amt, false) : ''}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
});
