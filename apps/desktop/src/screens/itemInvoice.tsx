import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  fmtAmount,
  fmtQty,
  godowns as loadGodowns,
  gstSplit,
  lineAmount,
  parseAmount,
  parseQty,
  planItemInvoice,
  stateCode,
  stateCodeOfGstin,
  stateName,
  stockItems as loadItems,
  taxLedgerName,
  type Godown,
  type Ledger,
  type StockItem,
} from '@tallybook/core';
import { PickerInput, type Opt } from '../ui/PickerInput.tsx';
import { useStore } from '../store.tsx';
import { OUTPUT_SUPPLY, INPUT_SUPPLY, PARTY_ROOTS, isUnder } from '../lib.ts';
import type { BodyHandle, BodyProps } from './voucherParts.tsx';

interface Line {
  item: StockItem | null;
  text: string;
  godown: Godown | null;
  godownText: string;
  qty: string;
  rate: string;
}

const blank = (g?: Godown): Line => ({ item: null, text: '', godown: g ?? null, godownText: g?.name ?? '', qty: '', rate: '' });
const num = 'tb-num';

export const ItemInvoiceBody = forwardRef<BodyHandle, BodyProps>(function ItemInvoiceBody(props, handle) {
  const { type, ledgers, groups, onFinish, onDirty, initial } = props;
  const { books, company, toast, version } = useStore();
  const output = type.parent === 'Sales' || type.parent === 'Credit Note';
  const kind = type.parent as 'Sales' | 'Purchase' | 'Credit Note' | 'Debit Note';

  const [items, setItems] = useState<StockItem[]>([]);
  const [houses, setHouses] = useState<Godown[]>([]);
  useEffect(() => {
    void Promise.all([loadItems(books.db), loadGodowns(books.db)]).then(([i, g]) => {
      setItems(i);
      setHouses(g);
    });
  }, [books, version]);

  const partyLedgers = useMemo(() => ledgers.filter((l) => isUnder(groups, l, PARTY_ROOTS) || l.name === 'Cash'), [ledgers, groups]);
  const supplyLedgers = useMemo(() => ledgers.filter((l) => isUnder(groups, l, output ? OUTPUT_SUPPLY : INPUT_SUPPLY)), [ledgers, groups, output]);
  const partyOpts: Opt[] = partyLedgers.map((l) => ({ id: l.id, label: l.name }));
  const supplyOpts: Opt[] = supplyLedgers.map((l) => ({ id: l.id, label: l.name }));
  const itemOpts: Opt[] = items.map((i) => ({ id: i.id, label: i.name }));
  const houseOpts: Opt[] = houses.map((g) => ({ id: g.id, label: g.name }));
  const multiHouse = houses.length > 1;

  const initParty = initial?.party_id ? partyLedgers.find((l) => l.id === initial.party_id) : undefined;
  const [partyText, setPartyText] = useState(initParty?.name ?? '');
  const [party, setParty] = useState<Ledger | null>(initParty ?? null);
  const [pos, setPos] = useState(initial?.place_of_supply ?? '');
  const firstSupply = initial?.items?.[0]?.ledgerId ? supplyLedgers.find((l) => l.id === initial.items![0].ledgerId) : undefined;
  const [slText, setSlText] = useState(firstSupply?.name ?? '');
  const [sl, setSl] = useState<Ledger | null>(firstSupply ?? null);
  const [lines, setLines] = useState<Line[]>([blank()]);
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
        return { item, text: item?.name ?? '', godown: g, godownText: g?.name ?? '', qty: fmtQty(Math.abs(it.qty), 0), rate: fmtAmount(it.rate) };
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

  const companyState = company ? stateCodeOfGstin(company.gstin) || stateCode(company.state) : '';
  const partyState = party ? stateCodeOfGstin(party.gstin) || stateCode(party.state) : '';
  const posCode = stateCode(pos) || partyState || companyState;
  const intra = !!companyState && posCode === companyState;

  const preview = useMemo(() => {
    const byName = new Map<string, number>();
    let taxable = 0;
    for (const l of lines) {
      const q = parseQty(l.qty);
      const r = parseAmount(l.rate);
      if (!l.item || !q || r === null) continue;
      const t = lineAmount(q, r);
      taxable += t;
      const s = gstSplit(t, l.item.rate_bp, intra);
      const add = (head: 'Central Tax' | 'State Tax' | 'Integrated Tax', amt: number, bp: number) => {
        if (!amt) return;
        const n = taxLedgerName(output ? 'Output' : 'Input', head, bp);
        byName.set(n, (byName.get(n) ?? 0) + amt);
      };
      add('Central Tax', s.cgst, l.item.rate_bp / 2);
      add('State Tax', s.sgst, l.item.rate_bp / 2);
      add('Integrated Tax', s.igst, l.item.rate_bp);
    }
    const tax = [...byName.values()].reduce((a, b) => a + b, 0);
    return { taxable, total: taxable + tax, taxes: [...byName] };
  }, [lines, intra, output]);

  const finish = () => {
    if (!party) return toast('Select the party', 'err');
    if (!preview.taxable) return toast('Add at least one item', 'err');
    onFinish();
  };

  useImperativeHandle(
    handle,
    () => ({
      async build() {
        if (!party) {
          toast('Select the party', 'err');
          return null;
        }
        if (!sl) {
          toast(`Select the ${output ? 'sales' : 'purchase'} ledger`, 'err');
          return null;
        }
        const rows = linesRef.current.filter((l) => l.item && parseQty(l.qty));
        if (!rows.length) {
          toast('Add at least one item', 'err');
          return null;
        }
        try {
          const plan = await planItemInvoice(
            books,
            kind,
            party.id,
            rows.map((l) => ({ item_id: l.item!.id, godown_id: l.godown?.id ?? 1, ledger_id: sl.id, qty: parseQty(l.qty)!, rate: parseAmount(l.rate) ?? 0 })),
            { placeOfSupply: posCode }
          );
          return { entries: plan.entries, party_id: party.id, place_of_supply: plan.place_of_supply, stock: plan.stock };
        } catch (e) {
          toast((e as Error).message, 'err');
          return null;
        }
      },
      reset() {
        dirty.current = false;
        setParty(null);
        setPartyText('');
        setPos('');
        setLines([blank(houses[0])]);
        focus('party');
      },
      focusFirst: () => focus('party'),
      removeLine() {
        setLines((ls) => (ls.length > 1 ? ls.slice(0, -1) : ls));
      },
      isDirty: () => dirty.current,
    }),
    [books, focus, houses, kind, output, party, posCode, sl, toast]
  );

  useEffect(() => {
    if (!initial?.items?.length) focus('party');
  }, [focus, initial]);

  const label = 'w-44';
  const cols = multiHouse ? 'grid-cols-[1fr_170px_110px_120px_150px]' : 'grid-cols-[1fr_110px_120px_150px]';
  const head = 'border-y border-tb-line py-px font-bold';

  return (
    <div ref={box} className="flex min-h-[420px] flex-col">
      <div className="mt-3 space-y-px">
        <div className="flex items-center">
          <span className={label}>Party A/c name</span>
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
                const code = stateCodeOfGstin(l.gstin) || stateCode(l.state);
                setPos(code ? stateName(code) : '');
                focus('pos');
              }}
              onNoMatch={() => toast('Select the party from the list', 'err')}
              onCreate={(text) => window.dispatchEvent(new CustomEvent('tb:create-ledger', { detail: { text, rowIndex: -1 } }))}
            />
          </div>
        </div>
        <div className="flex items-center">
          <span className={label}>Place of supply</span>
          <span className="mr-2">:</span>
          <input
            className="tb-input w-[360px] font-bold"
            data-cell="pos"
            value={pos}
            onChange={(e) => {
              touch();
              setPos(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                if (pos && !stateCode(pos)) return toast('Enter a valid state name or code', 'err');
                focus('sl');
              } else if (e.key === 'Backspace' && pos === '') {
                e.preventDefault();
                focus('party');
              }
            }}
          />
          <span className="ml-3 text-xs italic text-[#7a7a7a]">{posCode ? (intra ? 'Intra-state: CGST + SGST' : 'Inter-state: IGST') : ''}</span>
        </div>
        <div className="flex items-center">
          <span className={label}>{output ? 'Sales ledger' : 'Purchase ledger'}</span>
          <span className="mr-2">:</span>
          <div className="w-[360px]">
            <PickerInput
              className="tb-input w-full font-bold"
              value={slText}
              title="Ledger Accounts"
              options={supplyOpts}
              inputRef={(el) => el?.setAttribute('data-cell', 'sl')}
              onChange={(t) => {
                touch();
                setSlText(t);
                setSl(null);
              }}
              onPick={(o) => {
                const l = ledgers.find((x) => x.id === o.id)!;
                setSl(l);
                setSlText(l.name);
                focus('i0-0');
              }}
              onNoMatch={() => toast('Select a ledger from the list', 'err')}
              onBackspaceEmpty={() => focus('pos')}
            />
          </div>
        </div>
      </div>

      <div className={`mt-3 grid ${cols} ${head}`}>
        <span className="pl-1">Name of Item</span>
        {multiHouse && <span>Godown</span>}
        <span className="pr-1 text-right">Quantity</span>
        <span className="pr-1 text-right">Rate</span>
        <span className="pr-1 text-right">Amount</span>
      </div>
      <div className="flex-1 pt-2">
        {lines.map((l, i) => {
          const q = parseQty(l.qty);
          const r = parseAmount(l.rate);
          const amt = q && r !== null ? lineAmount(q, r) : 0;
          return (
            <div key={i} className={`grid ${cols} items-center`}>
              <PickerInput
                className="tb-input w-full font-bold"
                value={l.text}
                title="Stock Items"
                options={itemOpts}
                inputRef={(el) => el?.setAttribute('data-cell', `i${i}-0`)}
                onChange={(t) => update(i, { text: t, item: null })}
                onPick={(o) => {
                  const it = items.find((x) => x.id === o.id)!;
                  update(i, { item: it, text: it.name, rate: l.rate || (it.standard_price ? fmtAmount(it.standard_price, false) : '') });
                  focus(multiHouse ? `i${i}-g` : `i${i}-1`);
                }}
                onEmptyEnter={() => (i >= 1 ? finish() : toast('Select an item', 'err'))}
                onNoMatch={() => toast('Select an item from the list', 'err')}
                onBackspaceEmpty={() => (i === 0 ? focus('sl') : focus(`i${i - 1}-2`))}
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
                className={`tb-input ${num} w-full font-bold`}
                data-cell={`i${i}-1`}
                value={l.qty}
                onChange={(e) => update(i, { qty: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!parseQty(l.qty)) return toast('Enter a valid quantity', 'err');
                    update(i, { qty: fmtQty(parseQty(l.qty)!, l.item ? 0 : 0) });
                    focus(`i${i}-2`);
                  } else if (e.key === 'Backspace' && l.qty === '') {
                    e.preventDefault();
                    e.stopPropagation();
                    focus(multiHouse ? `i${i}-g` : `i${i}-0`);
                  }
                }}
              />
              <input
                className={`tb-input ${num} w-full font-bold`}
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
                    if (i === linesRef.current.length - 1) setLines((ls) => [...ls, blank(houses[0])]);
                    focus(`i${i + 1}-0`);
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

      <div className="ml-auto w-[340px] text-right">
        <div className="flex justify-between"><span>Taxable value</span><span>{fmtAmount(preview.taxable, false)}</span></div>
        {preview.taxes.map(([n, a]) => (
          <div key={n} className="flex justify-between"><span className="italic text-[#7a7a7a]">{n}</span><span>{fmtAmount(a, false)}</span></div>
        ))}
        <div className="mt-1 flex justify-between border-y border-tb-ink font-bold"><span>Total</span><span>{fmtAmount(preview.total, false)}</span></div>
      </div>
    </div>
  );
});
