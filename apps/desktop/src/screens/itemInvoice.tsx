import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  applyInvoiceClass,
  fmtAmount,
  fmtPercent,
  fmtQty,
  godowns as loadGodowns,
  gstSplit,
  hasDefaultAllocations,
  invoiceAdditional,
  lineAmount,
  parseAmount,
  parseQty,
  getItemPrice,
  pendingDocs,
  planItemInvoice,
  posPayments,
  savePosPayments,
  setVoucherClassUse,
  settlePos,
  stateCode,
  stateCodeOfGstin,
  stateName,
  stockItems as loadItems,
  taxLedgerName,
  POS_MODES,
  POS_MODE_GROUPS,
  POS_MODE_LABELS,
  type BatchAllocInput,
  type Godown,
  type InvoiceClassLine,
  type PendingDoc,
  type Ledger,
  type PosMode,
  type PosPayment,
  type StockItem,
} from '@tallybook/core';
import { PickerInput, type Opt } from '../ui/PickerInput.tsx';
import { BatchAllocationDialog } from './Batches.tsx';
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
  against?: number;
  tracked?: boolean;
  disc?: number;
  manualRate?: boolean;
  batches?: BatchAllocInput[];
}

interface Pay {
  ledger: Ledger | null;
  text: string;
  amount: string;
  ref: string;
  bank: string;
}

const blank = (g?: Godown): Line => ({ item: null, text: '', godown: g ?? null, godownText: g?.name ?? '', qty: '', rate: '' });
const blankPay = (): Pay => ({ ledger: null, text: '', amount: '', ref: '', bank: '' });
const blankPays = (): Record<PosMode, Pay> => ({ gift: blankPay(), card: blankPay(), cheque: blankPay(), cash: blankPay() });
const num = 'tb-num';
const CLASS_LEDGER: Record<PosMode, 'gift_ledger_id' | 'card_ledger_id' | 'cheque_ledger_id' | 'cash_ledger_id'> = { gift: 'gift_ledger_id', card: 'card_ledger_id', cheque: 'cheque_ledger_id', cash: 'cash_ledger_id' };

export function classLineRate(a: InvoiceClassLine): string {
  if (a.calc === 'percent' || a.calc === 'subtotal') return `${fmtPercent(a.value)} %`;
  if (a.calc === 'qty') return fmtAmount(a.value, false);
  return '';
}

export function signedAmount(n: number): string {
  return n < 0 ? `(-)${fmtAmount(-n, false)}` : fmtAmount(n, false);
}

export const ItemInvoiceBody = forwardRef<BodyHandle, BodyProps>(function ItemInvoiceBody(props, handle) {
  const { type, ledgers, groups, onFinish, onDirty, initial } = props;
  const { books, company, toast, version } = useStore();
  const output = type.parent === 'Sales' || type.parent === 'Credit Note';
  const kind = type.parent as 'Sales' | 'Purchase' | 'Credit Note' | 'Debit Note';
  const cls = props.vclass ?? null;
  const pos = !!props.pos && kind === 'Sales';
  const useDefault = hasDefaultAllocations(cls);
  const posClass = pos && !!cls?.pos_class;

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
  const cashLedger = useMemo(() => ledgers.find((l) => l.name === 'Cash') ?? ledgers.find((l) => isUnder(groups, l, ['Cash-in-Hand'])) ?? null, [ledgers, groups]);
  const partyOpts: Opt[] = partyLedgers.map((l) => ({ id: l.id, label: l.name }));
  const supplyOpts: Opt[] = supplyLedgers.map((l) => ({ id: l.id, label: l.name }));
  const itemOpts: Opt[] = items.map((i) => ({ id: i.id, label: i.name }));
  const houseOpts: Opt[] = houses.map((g) => ({ id: g.id, label: g.name }));
  const multiHouse = houses.length > 1;

  const initParty = initial?.party_id ? partyLedgers.find((l) => l.id === initial.party_id) : pos ? cashLedger ?? undefined : undefined;
  const [partyText, setPartyText] = useState(initParty?.name ?? '');
  const [party, setParty] = useState<Ledger | null>(initParty ?? null);
  const [pos2, setPos] = useState(initial?.place_of_supply ?? '');
  const [docs, setDocs] = useState<PendingDoc[]>([]);
  const [trackText, setTrackText] = useState('Not Applicable');
  const canTrack = type.parent === 'Sales' || type.parent === 'Purchase';
  const firstSupply = initial?.items?.[0]?.ledgerId ? supplyLedgers.find((l) => l.id === initial.items![0].ledgerId) : undefined;
  const [slText, setSlText] = useState(firstSupply?.name ?? '');
  const [sl, setSl] = useState<Ledger | null>(firstSupply ?? null);
  const [lines, setLines] = useState<Line[]>([blank()]);
  const [batchFor, setBatchFor] = useState<number | null>(null);
  const [userVals, setUserVals] = useState<Record<number, string>>({});
  const [multi, setMulti] = useState(false);
  const [pays, setPays] = useState<Record<PosMode, Pay>>(blankPays);
  const outward = kind === 'Sales' || kind === 'Debit Note';
  const needsBatch = (l: Line) => !!company?.batches_enabled && !!l.item?.maintain_batches && !l.tracked;
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
        return { item, text: item?.name ?? '', godown: g, godownText: g?.name ?? '', qty: fmtQty(Math.abs(it.qty), 0), rate: fmtAmount(it.rate), tracked: !!it.tracked, batches: it.batches };
      })
    );
  }, [initial, items, houses]);

  useEffect(() => {
    if (!cls || !initial?.entries?.length) return;
    const vals: Record<number, string> = {};
    for (const l of cls.lines) {
      if (l.section !== 'additional' || l.calc !== 'user') continue;
      const e = initial.entries.find((x) => x.ledger_id === l.ledger_id);
      if (e) vals[l.id] = fmtAmount(Math.abs(e.amount));
    }
    setUserVals(vals);
  }, [cls, initial]);

  useEffect(() => {
    if (!pos || !props.voucherId) return;
    void posPayments(books.db, props.voucherId).then((ps) => {
      if (!ps.length) return;
      const next = blankPays();
      for (const p of ps) {
        const l = ledgers.find((x) => x.id === p.ledger_id) ?? null;
        next[p.mode] = { ledger: l, text: l?.name ?? '', amount: fmtAmount(p.mode === 'cash' ? p.tendered || p.amount : p.amount), ref: p.ref_no, bank: p.bank_name };
      }
      setPays(next);
      setMulti(ps.some((p) => p.mode !== 'cash'));
    });
  }, [pos, props.voucherId, books, ledgers]);

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
  const setPay = (m: PosMode, patch: Partial<Pay>) => {
    touch();
    setPays((p) => ({ ...p, [m]: { ...p[m], ...patch } }));
  };

  const companyState = company ? stateCodeOfGstin(company.gstin) || stateCode(company.state) : '';
  const partyState = party ? stateCodeOfGstin(party.gstin) || stateCode(party.state) : '';
  const posCode = stateCode(pos2) || partyState || companyState;
  const intra = !!companyState && posCode === companyState;

  const userNums = useMemo(() => Object.fromEntries(Object.entries(userVals).map(([k, v]) => [Number(k), parseAmount(v) ?? 0])), [userVals]);

  const preview = useMemo(() => {
    const byName = new Map<string, number>();
    let taxable = 0;
    let qty = 0;
    for (const l of lines) {
      const q = parseQty(l.qty);
      const r = parseAmount(l.rate);
      if (!l.item || !q || r === null) continue;
      const t = lineAmount(q, r, l.disc ?? 0);
      taxable += t;
      qty += q;
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
    const extra = cls ? invoiceAdditional(cls, kind, { sales: taxable, tax, qty, user: userNums }) : [];
    const shown = extra.filter((a) => !(a.remove_if_zero && a.amount === 0 && !a.editable));
    const total = taxable + tax + extra.reduce((a, b) => a + b.amount, 0);
    return { taxable, qty, total, taxes: [...byName], extra: shown };
  }, [lines, intra, output, cls, kind, userNums]);

  const classLedger = (m: PosMode) => {
    const id = cls?.[CLASS_LEDGER[m]];
    return id ? ledgers.find((l) => l.id === id) ?? null : null;
  };
  const modes: PosMode[] = !pos ? [] : posClass ? POS_MODES.filter((m) => classLedger(m)) : multi ? POS_MODES : ['cash'];
  const fixedLedger = (m: PosMode): Ledger | null => (posClass ? classLedger(m) : !multi && m === 'cash' ? cashLedger : null);
  const payLedger = (m: PosMode) => fixedLedger(m) ?? pays[m].ledger;
  const payOpts = (m: PosMode): Opt[] => ledgers.filter((l) => isUnder(groups, l, POS_MODE_GROUPS[m])).map((l) => ({ id: l.id, label: l.name }));

  const payState = useMemo(() => {
    const others = modes.filter((m) => m !== 'cash').reduce((s, m) => s + (parseAmount(pays[m].amount) ?? 0), 0);
    const remaining = preview.total - others;
    const tendered = modes.includes('cash') ? parseAmount(pays.cash.amount) ?? 0 : 0;
    const cash = Math.min(tendered, Math.max(0, remaining));
    return { others, remaining, tendered, balance: Math.max(0, tendered - remaining), due: Math.max(0, remaining - cash) };
  }, [modes, pays, preview.total]);

  const userCells = preview.extra.flatMap((a) => (a.editable ? [`u${a.line_id}`] : []));
  const payCells = modes.flatMap((m) => [...(fixedLedger(m) ? [] : [`p-${m}-l`]), ...(m === 'cheque' ? ['p-cheque-b'] : []), ...(m === 'card' || m === 'cheque' ? [`p-${m}-r`] : []), `p-${m}-a`]);
  const tail = [...userCells, ...payCells];
  const nextFrom = (cell: string) => {
    const i = tail.indexOf(cell);
    if (i >= 0 && i < tail.length - 1) return focus(tail[i + 1]);
    if (pos && payState.others > preview.total) return toast('Payment amount exceeds the invoice value', 'err');
    onFinish();
  };
  const prevFrom = (cell: string) => {
    const i = tail.indexOf(cell);
    if (i > 0) return focus(tail[i - 1]);
    focus(`i${linesRef.current.length - 1}-0`);
  };

  const finish = () => {
    if (!party) return toast('Select the party', 'err');
    if (!preview.taxable) return toast('Add at least one item', 'err');
    if (tail.length) return focus(tail[0]);
    onFinish();
  };

  const supplyLedgerId = () => (useDefault ? cls!.lines.find((l) => l.section === 'default')!.ledger_id : sl?.id ?? null);

  useImperativeHandle(
    handle,
    () => ({
      async build() {
        if (!party) {
          toast('Select the party', 'err');
          return null;
        }
        const ledgerId = supplyLedgerId();
        if (!ledgerId) {
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
            rows.map((l) => ({ item_id: l.item!.id, godown_id: l.godown?.id ?? 1, ledger_id: ledgerId, qty: parseQty(l.qty)!, rate: parseAmount(l.rate) ?? 0, discount_bp: l.disc ?? 0, tracked: !!l.tracked })),
            { placeOfSupply: posCode }
          );
          let entries = plan.entries;
          if (cls) entries = applyInvoiceClass(cls, kind, entries, rows.length, { qty: rows.reduce((s, l) => s + (parseQty(l.qty) ?? 0), 0), user: userNums }).entries;
          let settled: PosPayment[] = [];
          if (pos) {
            const st = settlePos(
              entries,
              party.id,
              modes.map((m) => ({
                mode: m,
                ledger_id: payLedger(m)?.id ?? 0,
                amount: m === 'cash' ? undefined : parseAmount(pays[m].amount) ?? 0,
                tendered: m === 'cash' ? parseAmount(pays.cash.amount) ?? 0 : undefined,
                ref_no: pays[m].ref,
                bank_name: pays[m].bank,
              }))
            );
            entries = st.entries;
            settled = st.payments;
          }
          const track = rows.flatMap((l, index) => (l.against ? [{ index, against: l.against, qty: parseQty(l.qty)! }] : []));
          const missing = rows.findIndex((l) => needsBatch(l) && !l.batches?.length);
          if (missing >= 0) {
            toast(`Allocate batches for ${rows[missing].item!.name}`, 'err');
            return null;
          }
          const batches = rows.flatMap((l, index) => (needsBatch(l) && l.batches?.length && l.batches.reduce((a, b) => a + b.qty, 0) === parseQty(l.qty) ? [{ index, allocs: l.batches }] : []));
          const classId = cls?.id ?? null;
          const after = async (voucherId: number) => {
            await setVoucherClassUse(books.db, voucherId, classId).catch(() => undefined);
            if (pos) await savePosPayments(books.db, voucherId, settled);
          };
          return { entries, party_id: party.id, place_of_supply: plan.place_of_supply, stock: plan.stock, track, batches, after };
        } catch (e) {
          toast((e as Error).message, 'err');
          return null;
        }
      },
      reset() {
        dirty.current = false;
        setParty(pos ? cashLedger : null);
        setPartyText(pos ? cashLedger?.name ?? '' : '');
        setPos('');
        setLines([blank(houses[0])]);
        setUserVals({});
        setPays(blankPays());
        setMulti(false);
        focus('party');
      },
      focusFirst: () => focus('party'),
      removeLine() {
        setLines((ls) => (ls.length > 1 ? ls.slice(0, -1) : ls));
      },
      isDirty: () => dirty.current,
      multiMode() {
        if (!pos) return false;
        if (posClass) {
          toast('Payment modes are set in the voucher class', 'err');
          return;
        }
        setMulti((m) => !m);
        touch();
      },
    }),
    [books, company, focus, houses, kind, output, party, posCode, sl, toast, cls, userNums, pos, posClass, modes, pays, cashLedger]
  );

  useEffect(() => {
    if (!initial?.items?.length) focus('party');
  }, [focus, initial, pos]);

  const pickItem = (i: number, it: StockItem) => {
    const l = linesRef.current[i];
    update(i, { item: it, text: it.name, rate: l.rate || (it.standard_price ? fmtAmount(it.standard_price, false) : ''), qty: l.qty || (pos ? '1' : '') });
    focus(multiHouse ? `i${i}-g` : `i${i}-1`);
  };

  const label = 'w-44';
  const cols = multiHouse ? 'grid-cols-[1fr_170px_110px_120px_150px]' : 'grid-cols-[1fr_110px_120px_150px]';
  const head = 'border-y border-tb-line py-px font-bold';

  const cellKeys = (cell: string, value: string) => (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      nextFrom(cell);
    } else if (e.key === 'Backspace' && value === '') {
      e.preventDefault();
      e.stopPropagation();
      prevFrom(cell);
    }
  };
  const amountKeys = (cell: string, value: string, set: (v: string) => void) => (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (value.trim()) {
        const a = parseAmount(value);
        if (a === null) return toast('Enter a valid amount', 'err');
        set(fmtAmount(a));
      }
      nextFrom(cell);
    } else if (e.key === 'Backspace' && value === '') {
      e.preventDefault();
      e.stopPropagation();
      prevFrom(cell);
    }
  };

  const payRow = (m: PosMode) => {
    const p = pays[m];
    const fixed = fixedLedger(m);
    const single = !multi && !posClass;
    return (
      <div key={m} className="flex items-center gap-2">
        <span className="w-40">{single ? 'Cash Tendered' : POS_MODE_LABELS[m]}</span>
        <span>:</span>
        {!single && (
          <div className="w-[220px]">
            {fixed ? (
              <span className="px-1 font-bold">{fixed.name}</span>
            ) : (
              <PickerInput
                className="tb-input w-full font-bold"
                value={p.text}
                title="Ledger Accounts"
                options={payOpts(m)}
                inputRef={(el) => el?.setAttribute('data-cell', `p-${m}-l`)}
                onChange={(t) => setPay(m, { text: t, ledger: null })}
                onPick={(o) => {
                  const l = ledgers.find((x) => x.id === o.id)!;
                  setPay(m, { ledger: l, text: l.name });
                  nextFrom(`p-${m}-l`);
                }}
                onEmptyEnter={() => nextFrom(`p-${m}-a`)}
                onNoMatch={() => toast('Select a ledger from the list', 'err')}
                onBackspaceEmpty={() => prevFrom(`p-${m}-l`)}
              />
            )}
          </div>
        )}
        {m === 'cheque' && (
          <>
            <span className="ml-2">Bank Name</span>
            <input className="tb-input w-32" data-cell="p-cheque-b" value={p.bank} onChange={(e) => setPay(m, { bank: e.target.value })} onKeyDown={cellKeys('p-cheque-b', p.bank)} />
          </>
        )}
        {(m === 'card' || m === 'cheque') && (
          <>
            <span className="ml-2">{m === 'card' ? 'Card No.' : 'Cheque No.'}</span>
            <input className="tb-input w-32" data-cell={`p-${m}-r`} value={p.ref} onChange={(e) => setPay(m, { ref: e.target.value })} onKeyDown={cellKeys(`p-${m}-r`, p.ref)} />
          </>
        )}
        {m === 'cash' && !single && <span className="ml-2">Cash Tendered</span>}
        <input
          className={`tb-input ${num} ml-auto w-36 font-bold`}
          data-cell={`p-${m}-a`}
          value={p.amount}
          onChange={(e) => setPay(m, { amount: e.target.value })}
          onKeyDown={amountKeys(`p-${m}-a`, p.amount, (v) => setPay(m, { amount: v }))}
        />
      </div>
    );
  };

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
                if (canTrack && !initial?.items?.length && !pos) {
                  void pendingDocs(books.db, type.parent as 'Sales' | 'Purchase', 'invoice', l.id, props.date).then((d) => {
                    setDocs(d);
                    setTrackText('Not Applicable');
                    focus(d.length ? 'track' : 'pos');
                  });
                } else focus('pos');
              }}
              onNoMatch={() => toast('Select the party from the list', 'err')}
              onCreate={(text) => window.dispatchEvent(new CustomEvent('tb:create-ledger', { detail: { text, rowIndex: -1 } }))}
            />
          </div>
        </div>
        {canTrack && docs.length > 0 && (
          <div className="flex items-center">
            <span className={label}>Tracking No.</span>
            <span className="mr-2">:</span>
            <div className="w-[360px]">
              <PickerInput
                className="tb-input w-full font-bold"
                value={trackText}
                title="Tracking Numbers"
                options={[{ id: 0, label: 'Not Applicable' }, ...docs.map((d) => ({ id: d.voucher_id, label: d.number, sub: `${d.parent} · ${d.date.split('-').reverse().join('-')}` }))]}
                inputRef={(el) => el?.setAttribute('data-cell', 'track')}
                onChange={(t) => setTrackText(t)}
                onPick={(o) => {
                  setTrackText(o.label);
                  const d = docs.find((x) => x.voucher_id === o.id);
                  if (d) {
                    touch();
                    setLines([
                      ...d.lines.map((pl) => {
                        const it = items.find((x) => x.id === pl.item_id) ?? null;
                        const g = houses.find((x) => x.id === pl.godown_id) ?? houses[0] ?? null;
                        return { item: it, text: it?.name ?? '', godown: g, godownText: g?.name ?? '', qty: fmtQty(pl.balance, 0), rate: fmtAmount(pl.rate), against: pl.movement_id, tracked: d.tracks_stock };
                      }),
                      blank(houses[0]),
                    ]);
                  }
                  focus('pos');
                }}
                onNoMatch={() => toast('Choose a tracking number or Not Applicable', 'err')}
                onBackspaceEmpty={() => focus('party')}
              />
            </div>
          </div>
        )}
        <div className="flex items-center">
          <span className={label}>Place of supply</span>
          <span className="mr-2">:</span>
          <input
            className="tb-input w-[360px] font-bold"
            data-cell="pos"
            value={pos2}
            onChange={(e) => {
              touch();
              setPos(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                if (pos2 && !stateCode(pos2)) return toast('Enter a valid state name or code', 'err');
                focus(useDefault ? 'i0-0' : 'sl');
              } else if (e.key === 'Backspace' && pos2 === '') {
                e.preventDefault();
                focus('party');
              }
            }}
          />
          <span className="ml-3 text-xs italic text-[#7a7a7a]">{posCode ? (intra ? 'Intra-state: CGST + SGST' : 'Inter-state: IGST') : ''}</span>
        </div>
        {!useDefault && (
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
        )}
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
          const amt = q && r !== null ? lineAmount(q, r, l.disc ?? 0) : 0;
          return (
            <div key={i} className={`grid ${cols} items-center`}>
              <PickerInput
                className="tb-input w-full font-bold"
                value={l.text}
                title="Stock Items"
                options={itemOpts}
                inputRef={(el) => el?.setAttribute('data-cell', `i${i}-0`)}
                onChange={(t) => update(i, { text: t, item: null })}
                onPick={(o) => pickItem(i, items.find((x) => x.id === o.id)!)}
                onEmptyEnter={() => (i >= 1 ? finish() : toast('Select an item', 'err'))}
                onNoMatch={(t) => {
                  const code = t.trim().toLowerCase();
                  const hit = code ? items.find((x) => x.alias && x.alias.toLowerCase() === code) : undefined;
                  if (hit) return pickItem(i, hit);
                  toast('Select an item from the list', 'err');
                }}
                onBackspaceEmpty={() => (i === 0 ? focus(useDefault ? 'pos' : 'sl') : focus(`i${i - 1}-2`))}
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
                    const q = parseQty(l.qty);
                    if (!q) return toast('Enter a valid quantity', 'err');
                    const same = l.batches?.reduce((a, b) => a + b.qty, 0) === q;
                    update(i, { qty: fmtQty(q, 0), ...(same ? {} : { batches: undefined }) });
                    const after = () => (needsBatch(l) ? setBatchFor(i) : focus(`i${i}-2`));
                    if (l.item && party && !l.manualRate && !l.against) {
                      void getItemPrice(books.db, { item_id: l.item.id, date: props.date, qty: q, party_id: party.id }).then((p) => {
                        if (p.source !== 'none') update(i, { rate: fmtAmount(p.rate), disc: p.disc_bp || 0 });
                        after();
                      });
                    } else after();
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
                onChange={(e) => update(i, { rate: e.target.value, manualRate: true })}
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
        {preview.extra.length > 0 && <div className="mt-2" />}
        {preview.extra.map((a) => {
          const cell = `u${a.line_id}`;
          const v = userVals[a.line_id] ?? '';
          return (
            <div key={a.line_id} className={`grid ${cols} items-center`}>
              <span className="pl-10 font-bold italic">{a.ledger}</span>
              {multiHouse && <span />}
              <span />
              <span className="pr-1 text-right">{classLineRate(a)}</span>
              {a.editable ? (
                <input
                  className={`tb-input ${num} w-full font-bold`}
                  data-cell={cell}
                  value={v}
                  onChange={(e) => {
                    touch();
                    setUserVals((u) => ({ ...u, [a.line_id]: e.target.value }));
                  }}
                  onKeyDown={amountKeys(cell, v, (x) => setUserVals((u) => ({ ...u, [a.line_id]: x })))}
                />
              ) : (
                <span className="tb-num pr-1 font-bold">{a.amount ? signedAmount(a.amount) : ''}</span>
              )}
            </div>
          );
        })}
      </div>

      {batchFor !== null && lines[batchFor]?.item && (
        <BatchAllocationDialog
          item={lines[batchFor].item!}
          godownId={lines[batchFor].godown?.id ?? 1}
          qty={parseQty(lines[batchFor].qty) ?? 0}
          outward={outward}
          asOf={props.date}
          initial={lines[batchFor].batches}
          onCancel={() => {
            const i = batchFor;
            setBatchFor(null);
            focus(`i${i}-1`);
          }}
          onDone={(allocs) => {
            const i = batchFor;
            update(i, { batches: allocs });
            setBatchFor(null);
            focus(`i${i}-2`);
          }}
        />
      )}
      <div className="flex items-end gap-6">
        {pos ? (
          <div className="flex-1 space-y-px border-t border-tb-line pt-1">
            {modes.map(payRow)}
            <div className="flex items-center gap-2">
              <span className="w-40">Balance</span>
              <span>:</span>
              <span className="tb-num ml-auto w-36 pr-1 font-bold">{payState.tendered ? fmtAmount(payState.balance, false) : ''}</span>
            </div>
            {payState.due > 0 && payState.due !== preview.total && (
              <div className="flex items-center gap-2 italic text-[#7a7a7a]">
                <span className="w-40">Balance on {party?.name ?? 'party'}</span>
                <span>:</span>
                <span className="tb-num ml-auto w-36 pr-1">{fmtAmount(payState.due, false)}</span>
              </div>
            )}
          </div>
        ) : (
          <div className="flex-1" />
        )}
        <div className="w-[340px] text-right">
          <div className="flex justify-between"><span>Taxable value</span><span>{fmtAmount(preview.taxable, false)}</span></div>
          {preview.taxes.map(([n, a]) => (
            <div key={n} className="flex justify-between"><span className="italic text-[#7a7a7a]">{n}</span><span>{fmtAmount(a, false)}</span></div>
          ))}
          <div className="mt-1 flex justify-between border-y border-tb-ink font-bold"><span>Total</span><span>{fmtAmount(preview.total, false)}</span></div>
        </div>
      </div>
    </div>
  );
});
