import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  fmtAmount,
  fmtDrCr,
  gstSplit,
  ledgerVouchers,
  parseAmount,
  stateCode,
  stateCodeOfGstin,
  stateName,
  taxLedgerName,
  type BillInput,
  type EntryInput,
  type StockLineInput,
  type Group,
  type Ledger,
  type VoucherType,
} from '@tallybook/core';
import { PickerInput, type Opt } from '../ui/PickerInput.tsx';
import { useStore } from '../store.tsx';
import { BANK_CASH, GST_RATES_BP, INPUT_SUPPLY, OUTPUT_SUPPLY, PARTY_ROOTS, isUnder, rateLabel } from '../lib.ts';

export interface BuiltVoucher {
  entries: EntryInput[];
  party_id?: number | null;
  place_of_supply?: string;
  reverse_charge?: boolean;
  stock?: StockLineInput[];
  track?: { index: number; against: number; qty: number }[];
}

export interface BodyHandle {
  build: () => Promise<BuiltVoucher | null>;
  reset: () => void;
  focusFirst: () => void;
  removeLine: () => void;
  isDirty: () => boolean;
}

export interface BodyProps {
  type: VoucherType;
  ledgers: Ledger[];
  groups: Group[];
  date: string;
  askBills: (ledger: Ledger, amount: number) => Promise<BillInput[] | null>;
  onFinish: () => void;
  onDirty: () => void;
  initial?: InitialData;
}

export interface InitialData {
  rows?: { side: 'Dr' | 'Cr'; ledgerId: number; amount: number; bills: BillInput[] }[];
  party_id?: number | null;
  place_of_supply?: string;
  reverse_charge?: boolean;
  lines?: { ledgerId: number; taxable: number; rate_bp: number }[];
  items?: { item_id: number; godown_id: number | null; ledgerId: number | null; qty: number; rate: number; tracked?: number }[];
}

interface Row {
  side: 'Dr' | 'Cr';
  opt: Opt | null;
  text: string;
  amount: string;
  bills: BillInput[];
}

const FIRST_SIDE: Record<string, 'Dr' | 'Cr'> = { Payment: 'Cr', Receipt: 'Dr', Contra: 'Cr', Journal: 'Dr', Sales: 'Dr', Purchase: 'Cr', 'Credit Note': 'Cr', 'Debit Note': 'Dr' };

function emptyRows(parent: string): Row[] {
  const first = FIRST_SIDE[parent] ?? 'Dr';
  const other = first === 'Dr' ? 'Cr' : 'Dr';
  return [
    { side: first, opt: null, text: '', amount: '', bills: [] },
    { side: other, opt: null, text: '', amount: '', bills: [] },
  ];
}

export const AccountingBody = forwardRef<BodyHandle, BodyProps>(function AccountingBody(props, handle) {
  const { type, ledgers, groups, askBills, onFinish, onDirty, initial } = props;
  const { books, company, toast } = useStore();
  const [rows, setRows] = useState<Row[]>(() => {
    if (initial?.rows?.length) {
      return initial.rows.map((r) => {
        const l = ledgers.find((x) => x.id === r.ledgerId)!;
        return { side: r.side, opt: { id: l.id, label: l.name, sub: l.group_name }, text: l.name, amount: fmtAmount(Math.abs(r.amount)), bills: r.bills };
      });
    }
    return emptyRows(type.parent);
  });
  const box = useRef<HTMLDivElement>(null);
  const dirty = useRef(false);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const [balances, setBalances] = useState<Record<number, number>>({});

  const touch = () => {
    if (!dirty.current) {
      dirty.current = true;
      onDirty();
    }
  };

  const focus = useCallback((r: number, c: number) => {
    setTimeout(() => {
      const el = box.current?.querySelector(`[data-cell="${r}-${c}"]`) as HTMLInputElement | null;
      el?.focus();
      el?.select?.();
    }, 0);
  }, []);

  const options = (rowIndex: number): Opt[] => {
    const restrict = type.parent === 'Contra' || ((type.parent === 'Payment' || type.parent === 'Receipt') && rowIndex === 0);
    return ledgers
      .filter((l) => !restrict || BANK_CASH.includes(l.group_name))
      .map((l) => ({ id: l.id, label: l.name, sub: l.group_name }));
  };

  const isSingle = ['Payment', 'Receipt', 'Contra'].includes(type.parent);
  const totals = useMemo(() => {
    let dr = 0;
    let cr = 0;
    const others = isSingle ? rows.slice(1).reduce((t, r) => t + (r.opt ? parseAmount(r.amount) ?? 0 : 0), 0) : 0;
    for (const [idx, r] of rows.entries()) {
      const a = isSingle && idx === 0 ? others : parseAmount(r.amount) ?? 0;
      if (!r.opt) continue;
      if (r.side === 'Dr') dr += a;
      else cr += a;
    }
    return { dr, cr, diff: dr - cr };
  }, [rows, isSingle]);

  const loadBalance = (id: number) => {
    if (!company) return;
    void ledgerVouchers(books.db, id, company.fy_start, company.fy_end).then((r) => setBalances((b) => ({ ...b, [id]: r.closing })));
  };

  const update = (i: number, patch: Partial<Row>) => {
    touch();
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };

  const addRow = (afterIndex: number) => {
    const diff = totals.diff;
    const side: 'Dr' | 'Cr' = ['Payment', 'Receipt', 'Contra'].includes(type.parent) ? rowsRef.current[afterIndex].side : diff > 0 ? 'Cr' : diff < 0 ? 'Dr' : rowsRef.current[afterIndex].side === 'Dr' ? 'Cr' : 'Dr';
    setRows((rs) => [...rs, { side, opt: null, text: '', amount: '', bills: [] }]);
    focus(afterIndex + 1, 1);
  };

  const effective = (): Row[] => {
    const rs = rowsRef.current;
    if (!['Payment', 'Receipt', 'Contra'].includes(type.parent)) return rs;
    const others = rs.slice(1).reduce((t, r) => t + (r.opt ? parseAmount(r.amount) ?? 0 : 0), 0);
    return rs.map((r, i) => (i === 0 ? { ...r, amount: fmtAmount(others, false) } : r));
  };

  const finish = () => {
    const rs = effective();
    const filled = rs.filter((r) => r.opt && (parseAmount(r.amount) ?? 0) > 0);
    if (filled.length < 2) return toast('A voucher needs at least two ledger entries', 'err');
    const dr = filled.filter((r) => r.side === 'Dr').reduce((s, r) => s + (parseAmount(r.amount) ?? 0), 0);
    const cr = filled.filter((r) => r.side === 'Cr').reduce((s, r) => s + (parseAmount(r.amount) ?? 0), 0);
    if (dr !== cr) return toast(`Debit and credit totals differ by ${fmtAmount(Math.abs(dr - cr))}`, 'err');
    onFinish();
  };

  useImperativeHandle(
    handle,
    () => ({
      async build() {
        const rs = effective().filter((r) => r.opt && (parseAmount(r.amount) ?? 0) > 0);
        if (rs.length < 2) {
          toast('A voucher needs at least two ledger entries', 'err');
          return null;
        }
        const entries = rs.map((r) => {
          const a = parseAmount(r.amount) ?? 0;
          return { ledger_id: Number(r.opt!.id), amount: r.side === 'Dr' ? a : -a, bills: r.bills.length ? r.bills : undefined };
        });
        const sum = entries.reduce((s, e) => s + e.amount, 0);
        if (sum !== 0) {
          toast(`Debit and credit totals differ by ${fmtAmount(Math.abs(sum))}`, 'err');
          return null;
        }
        return { entries };
      },
      reset() {
        dirty.current = false;
        setRows(emptyRows(type.parent));
        focus(0, 1);
      },
      focusFirst() {
        focus(0, 1);
      },
      removeLine() {
        setRows((rs) => {
          if (rs.length <= 2) return rs;
          const el = document.activeElement as HTMLElement | null;
          const idx = Number(el?.getAttribute('data-cell')?.split('-')[0] ?? rs.length - 1);
          return rs.filter((_, i) => i !== idx);
        });
      },
      isDirty: () => dirty.current,
    }),
    [focus, toast, type.parent]
  );

  useEffect(() => {
    if (!initial?.rows?.length) focus(0, 1);
  }, [focus, initial]);

  const single = ['Payment', 'Receipt', 'Contra'].includes(type.parent);
  const sumOthers = rows.slice(1).reduce((t, r) => t + (r.opt ? parseAmount(r.amount) ?? 0 : 0), 0);
  const amountOf = (r: Row, i: number) => (single && i === 0 ? fmtAmount(sumOthers, false) : r.amount);
  const bal = (r: Row) => (r.opt && balances[Number(r.opt.id)] !== undefined ? fmtDrCr(balances[Number(r.opt.id)]) || '0.00' : '');
  const cols = single ? 'grid-cols-[1fr_150px]' : 'grid-cols-[1fr_150px_150px]';
  const ruled = 'border-y border-tb-line py-px font-bold';

  const sideCell = (r: Row, i: number) => (
    <input
      className="tb-input w-7 cursor-default"
      data-cell={`${i}-0`}
      value={r.side}
      readOnly
      onKeyDown={(e) => {
        const k = e.key.toLowerCase();
        if (k === 'd' || k === 'c' || k === ' ' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          update(i, { side: k === 'd' ? 'Dr' : k === 'c' ? 'Cr' : r.side === 'Dr' ? 'Cr' : 'Dr' });
        } else if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          focus(i, 1);
        }
      }}
    />
  );

  const picker = (r: Row, i: number) => (
    <PickerInput
      className="tb-input w-full font-bold"
      value={r.text}
      title="Ledger Accounts"
      options={options(i)}
      inputRef={(el) => el?.setAttribute('data-cell', `${i}-1`)}
      onChange={(t) => update(i, { text: t, opt: null })}
      onPick={(o) => {
        const remaining = Math.abs(totals.diff - (r.opt ? (r.side === 'Dr' ? 1 : -1) * (parseAmount(r.amount) ?? 0) : 0));
        update(i, { opt: o, text: o.label, amount: single ? r.amount : r.amount || (i > 0 && remaining ? fmtAmount(remaining) : '') });
        loadBalance(Number(o.id));
        focus(single && i === 0 ? 1 : i, single && i === 0 ? 1 : 2);
      }}
      onEmptyEnter={() => (i >= 1 ? finish() : toast('Select a ledger', 'err'))}
      onNoMatch={() => toast('Select a ledger from the list (Alt+C to create)', 'err')}
      onBackspaceEmpty={() => (single ? (i > 0 ? focus(i - 1, i === 1 ? 1 : 2) : undefined) : focus(i, 0))}
      onCreate={(text) => window.dispatchEvent(new CustomEvent('tb:create-ledger', { detail: { text, rowIndex: i } }))}
    />
  );

  const amountInput = (r: Row, i: number, ledger: Ledger | undefined) => (
    <input
      className="tb-input tb-num w-full font-bold"
      data-cell={`${i}-2`}
      value={r.amount}
      onChange={(e) => update(i, { amount: e.target.value })}
      onKeyDown={async (e) => {
        if (e.key === 'Backspace' && r.amount === '') {
          e.preventDefault();
          e.stopPropagation();
          focus(i, 1);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          const a = parseAmount(r.amount);
          if (!a) return toast('Enter an amount', 'err');
          if (!ledger) return toast('Select a ledger first', 'err');
          update(i, { amount: fmtAmount(a) });
          if (ledger.bill_by_bill && company?.bill_wise) {
            const bills = await askBills(ledger, r.side === 'Dr' ? a : -a);
            if (!bills) return focus(i, 2);
            update(i, { bills });
          }
          if (i === rowsRef.current.length - 1) addRow(i);
          else focus(i + 1, 1);
        }
      }}
    />
  );

  return (
    <div ref={box} className="flex min-h-[420px] flex-col">
      {single && (
        <div className="mb-1 mt-3">
          <div className="flex items-center">
            <span className="w-28">{type.parent === 'Contra' ? 'Account' : 'Account'}</span>
            <span className="mr-2">:</span>
            <div className="w-[360px]">{rows[0] && picker(rows[0], 0)}</div>
          </div>
          {rows[0]?.opt && (
            <div className="flex italic text-[#7a7a7a]">
              <span className="w-28">Current balance</span>
              <span className="mr-2">:</span>
              <span className="pl-[3px] font-bold">{bal(rows[0])}</span>
            </div>
          )}
        </div>
      )}
      <div className={`mt-2 grid ${cols} ${ruled}`}>
        <span className="pl-8">Particulars</span>
        {single ? (
          <span className="pr-1 text-right">Amount</span>
        ) : (
          <>
            <span className="pr-1 text-right">Debit</span>
            <span className="pr-1 text-right">Credit</span>
          </>
        )}
      </div>
      <div className="flex-1 pt-3">
        {rows.map((r, i) => {
          if (single && i === 0) return null;
          const ledger = r.opt ? ledgers.find((l) => l.id === r.opt!.id) : undefined;
          return (
            <div key={i} className="mb-1">
              <div className={`grid ${cols} items-center`}>
                <div className="flex items-center gap-1">
                  {single ? <span className="w-7" /> : sideCell(r, i)}
                  <div className="flex-1">{picker(r, i)}</div>
                </div>
                {single || r.side === 'Dr' ? <div>{amountInput(r, i, ledger)}</div> : <div />}
                {!single && (r.side === 'Cr' ? <div>{amountInput(r, i, ledger)}</div> : <div />)}
              </div>
              {bal(r) && (
                <div className="pl-14 text-[13px] italic text-[#7a7a7a]">
                  Cur Bal: <b>{bal(r)}</b>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className={`grid ${cols} items-center`}>
        <span />
        {single ? (
          <span className="tb-num border-y border-tb-ink pr-1 font-bold">{fmtAmount(sumOthers, false)}</span>
        ) : (
          <>
            <span className="tb-num border-y border-tb-ink pr-1 font-bold">{fmtAmount(totals.dr, false)}</span>
            <span className="tb-num border-y border-tb-ink pr-1 font-bold">{fmtAmount(totals.cr, false)}</span>
          </>
        )}
      </div>
      {!single && totals.diff !== 0 && <div className="text-right text-xs text-tb-danger">Difference: {fmtAmount(Math.abs(totals.diff), false)} {totals.diff > 0 ? 'Dr' : 'Cr'}</div>}
    </div>
  );
});

interface Line {
  opt: Opt | null;
  text: string;
  taxable: string;
  rate_bp: number;
  rateText: string;
}

const outputType = (parent: string) => parent === 'Sales' || parent === 'Credit Note';

export const InvoiceBody = forwardRef<BodyHandle, BodyProps>(function InvoiceBody(props, handle) {
  const { type, ledgers, groups, askBills, onFinish, onDirty, initial } = props;
  const { books, company, toast } = useStore();
  const output = outputType(type.parent);
  const partyLedgers = useMemo(() => ledgers.filter((l) => isUnder(groups, l, PARTY_ROOTS) || l.name === 'Cash'), [ledgers, groups]);
  const supplyLedgers = useMemo(() => ledgers.filter((l) => isUnder(groups, l, output ? OUTPUT_SUPPLY : INPUT_SUPPLY)), [ledgers, groups, output]);
  const partyOpts: Opt[] = partyLedgers.map((l) => ({ id: l.id, label: l.name, sub: l.group_name }));
  const supplyOpts: Opt[] = supplyLedgers.map((l) => ({ id: l.id, label: l.name, sub: l.hsn_sac || l.group_name }));
  const rateOpts: Opt[] = GST_RATES_BP.map((r) => ({ id: r, label: rateLabel(r) }));
  const stateOpts: Opt[] = useMemo(() => Array.from({ length: 0 }, () => ({ id: '', label: '' })), []);
  void stateOpts;

  const initialParty = initial?.party_id ? partyLedgers.find((l) => l.id === initial.party_id) : undefined;
  const [partyText, setPartyText] = useState(initialParty?.name ?? '');
  const [party, setParty] = useState<Ledger | null>(initialParty ?? null);
  const [pos, setPos] = useState(initial?.place_of_supply ?? '');
  const [rcm, setRcm] = useState(!!initial?.reverse_charge);
  const [lines, setLines] = useState<Line[]>(() => {
    if (initial?.lines?.length) {
      return initial.lines.map((ln) => {
        const l = ledgers.find((x) => x.id === ln.ledgerId)!;
        return { opt: { id: l.id, label: l.name, sub: l.hsn_sac || l.group_name }, text: l.name, taxable: fmtAmount(ln.taxable), rate_bp: ln.rate_bp, rateText: rateLabel(ln.rate_bp) };
      });
    }
    return [{ opt: null, text: '', taxable: '', rate_bp: 0, rateText: '' }];
  });
  const box = useRef<HTMLDivElement>(null);
  const dirty = useRef(false);
  const linesRef = useRef(lines);
  linesRef.current = lines;

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

  const companyState = company ? stateCodeOfGstin(company.gstin) || stateCode(company.state) : '';
  const partyState = party ? stateCodeOfGstin(party.gstin) || stateCode(party.state) : '';
  const posCode = stateCode(pos) || partyState || companyState;
  const intra = !!companyState && posCode === companyState;

  const preview = useMemo(() => {
    const byName = new Map<string, number>();
    let taxable = 0;
    for (const ln of lines) {
      const t = parseAmount(ln.taxable) ?? 0;
      if (!ln.opt || !t) continue;
      taxable += t;
      const s = gstSplit(t, ln.rate_bp, intra);
      const add = (head: 'Central Tax' | 'State Tax' | 'Integrated Tax', amt: number, bp: number) => {
        if (!amt) return;
        const n = taxLedgerName(output ? 'Output' : 'Input', head, bp);
        byName.set(n, (byName.get(n) ?? 0) + amt);
      };
      add('Central Tax', s.cgst, ln.rate_bp / 2);
      add('State Tax', s.sgst, ln.rate_bp / 2);
      add('Integrated Tax', s.igst, ln.rate_bp);
    }
    const tax = [...byName.values()].reduce((s, v) => s + v, 0);
    return { taxable, tax, total: taxable + tax, items: [...byName] };
  }, [lines, intra, output]);

  const updateLine = (i: number, patch: Partial<Line>) => {
    touch();
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  };

  const finish = () => {
    if (!party) return toast('Select the party', 'err');
    if (!preview.taxable) return toast('Add at least one supply line', 'err');
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
        const supply = linesRef.current.filter((l) => l.opt && (parseAmount(l.taxable) ?? 0) > 0);
        if (!supply.length) {
          toast('Add at least one supply line', 'err');
          return null;
        }
        const { planGstInvoice } = await import('@tallybook/core');
        try {
          const plan = await planGstInvoice(
            books,
            type.parent as 'Sales' | 'Purchase' | 'Credit Note' | 'Debit Note',
            party.id,
            supply.map((l) => ({ ledger_id: Number(l.opt!.id), taxable: parseAmount(l.taxable) ?? 0, rate_bp: l.rate_bp })),
            { placeOfSupply: posCode }
          );
          return { entries: plan.entries, party_id: party.id, place_of_supply: plan.place_of_supply, reverse_charge: rcm };
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
        setRcm(false);
        setLines([{ opt: null, text: '', taxable: '', rate_bp: 0, rateText: '' }]);
        focus('party');
      },
      focusFirst() {
        focus('party');
      },
      removeLine() {
        setLines((ls) => (ls.length > 1 ? ls.slice(0, -1) : ls));
      },
      isDirty: () => dirty.current,
    }),
    [books, focus, posCode, party, rcm, toast, type.parent]
  );

  useEffect(() => {
    if (!initial?.lines?.length) focus('party');
  }, [focus, initial]);
  void askBills;

  return (
    <div ref={box} className="space-y-3">
      <div className="border border-tb-line bg-tb-paper p-3">
        <div className="mb-1 flex items-center">
          <label className="w-48 text-tb-muted">Party A/c name</label>
          <div className="flex-1">
            <PickerInput
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
                setPos((stateCodeOfGstin(l.gstin) || stateCode(l.state)) ? stateName(stateCodeOfGstin(l.gstin) || stateCode(l.state)) : '');
                focus('pos');
              }}
              onNoMatch={() => toast('Select the party from the list', 'err')}
              onCreate={(text) => window.dispatchEvent(new CustomEvent('tb:create-ledger', { detail: { text, rowIndex: -1 } }))}
            />
          </div>
        </div>
        <div className="mb-1 flex items-center">
          <label className="w-48 text-tb-muted">Place of supply</label>
          <input
            className="tb-input flex-1"
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
                focus(!output ? 'rcm' : 'l0-0');
              } else if (e.key === 'Backspace' && pos === '') {
                e.preventDefault();
                focus('party');
              }
            }}
          />
          <span className="ml-3 w-40 text-xs text-tb-muted">{posCode ? (intra ? 'Intra-state: CGST + SGST' : 'Inter-state: IGST') : 'Set party state'}</span>
        </div>
        {!output && (
          <div className="flex items-center">
            <label className="w-48 text-tb-muted">Reverse charge applicable</label>
            <input
              className="tb-input w-20"
              data-cell="rcm"
              readOnly
              value={rcm ? 'Yes' : 'No'}
              onKeyDown={(e) => {
                const k = e.key.toLowerCase();
                if (k === 'y' || k === 'n' || k === ' ') {
                  e.preventDefault();
                  setRcm(k === 'y' ? true : k === 'n' ? false : !rcm);
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  e.stopPropagation();
                  focus('l0-0');
                }
              }}
            />
          </div>
        )}
      </div>

      <table className="w-full border border-tb-line bg-tb-paper">
        <thead>
          <tr className="border-b border-tb-ink text-left text-xs">
            <th className="px-2 py-1">{output ? 'Sales ledger' : 'Purchase ledger'}</th>
            <th className="w-20 px-2 py-1">Rate</th>
            <th className="w-44 px-3 py-1 text-right">Taxable value</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((ln, i) => (
            <tr key={i}>
              <td className="px-2 py-0.5">
                <PickerInput
                  value={ln.text}
                  title="Ledger Accounts"
                  options={supplyOpts}
                  inputRef={(el) => el?.setAttribute('data-cell', `l${i}-0`)}
                  onChange={(t) => updateLine(i, { text: t, opt: null })}
                  onPick={(o) => {
                    const l = ledgers.find((x) => x.id === o.id)!;
                    updateLine(i, { opt: o, text: o.label, rate_bp: l.rate_bp, rateText: rateLabel(l.rate_bp) });
                    focus(`l${i}-1`);
                  }}
                  onEmptyEnter={() => (i >= 1 ? finish() : toast('Select a ledger', 'err'))}
                  onNoMatch={() => toast('Select a ledger from the list', 'err')}
                  onBackspaceEmpty={() => (i === 0 ? focus(!output ? 'rcm' : 'pos') : focus(`l${i - 1}-2`))}
                  onCreate={(text) => window.dispatchEvent(new CustomEvent('tb:create-ledger', { detail: { text, rowIndex: -2 - i } }))}
                />
              </td>
              <td className="px-2 py-0.5">
                <PickerInput
                  value={ln.rateText}
                  title="GST Rates"
                  options={rateOpts}
                  inputRef={(el) => el?.setAttribute('data-cell', `l${i}-1`)}
                  onChange={(t) => updateLine(i, { rateText: t })}
                  onPick={(o) => {
                    updateLine(i, { rate_bp: Number(o.id), rateText: o.label });
                    focus(`l${i}-2`);
                  }}
                  onNoMatch={() => toast('Choose a GST rate', 'err')}
                  onBackspaceEmpty={() => focus(`l${i}-0`)}
                />
              </td>
              <td className="px-2 py-0.5">
                <input
                  className="tb-input tb-num w-full"
                  data-cell={`l${i}-2`}
                  value={ln.taxable}
                  onChange={(e) => updateLine(i, { taxable: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Backspace' && ln.taxable === '') {
                      e.preventDefault();
                      e.stopPropagation();
                      focus(`l${i}-1`);
                    } else if (e.key === 'Enter') {
                      e.preventDefault();
                      e.stopPropagation();
                      const a = parseAmount(ln.taxable);
                      if (!a) return toast('Enter the taxable value', 'err');
                      updateLine(i, { taxable: fmtAmount(a) });
                      if (i === linesRef.current.length - 1) {
                        setLines((ls) => [...ls, { opt: null, text: '', taxable: '', rate_bp: 0, rateText: '' }]);
                      }
                      focus(`l${i + 1}-0`);
                    }
                  }}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="flex justify-end">
        <div className="min-w-[320px] border border-tb-line bg-tb-paper p-3 text-sm tabular-nums">
          <div className="flex justify-between"><span>Taxable value</span><span>{fmtAmount(preview.taxable, false)}</span></div>
          {preview.items.map(([n, a]) => (
            <div key={n} className="flex justify-between text-tb-muted"><span>{n}</span><span>{fmtAmount(a, false)}</span></div>
          ))}
          <div className="mt-1 flex justify-between border-t border-tb-ink pt-1 font-bold"><span>Invoice total</span><span>{fmtAmount(preview.total, false)}</span></div>
        </div>
      </div>
    </div>
  );
});
