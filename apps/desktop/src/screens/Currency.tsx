import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fmtDate, fmtAmount, fmtDrCr, parseDate, todayIso, type Ledger } from '@tallybook/core';
import {
  baseCurrency,
  createCurrency,
  currencies,
  currency,
  currencyRates,
  deleteCurrency,
  exchangeDifferenceEntries,
  fmtForeign,
  fmtForeignNumber,
  fmtRate,
  foreignToBase,
  forexGainLoss,
  lastVoucherRate,
  parseForeign,
  parseRate,
  postExchangeDifference,
  rateOfExchange,
  ratesOn,
  replaceRates,
  setRatesOn,
  updateCurrency,
  type Currency,
  type EntryForexInput,
  type ForexGainLossRow,
  type RateKind,
} from '@tallybook/core';
import { forexClassLedgers, voucherClasses } from '@tallybook/core';
import { useScreen } from '../registry.ts';
import { useStore } from '../store.tsx';
import { useNav } from '../nav.tsx';
import { useDialogs } from '../ui/Dialogs.tsx';
import { Form, type FieldDef, type FormHandle } from '../ui/Form.tsx';
import { PickerInput, type Opt } from '../ui/PickerInput.tsx';
import { SelectList } from './SelectList.tsx';
import { Frame, LedgerReport, rowCls, th, useLoad, usePeriodKey, useSel } from './Reports.tsx';
import { useFilter, useReportOptions } from './reportConfig.tsx';

function useAsync<T>(fn: () => Promise<T>, init: T): T {
  const { books, version } = useStore();
  const [v, setV] = useState<T>(init);
  useEffect(() => {
    let live = true;
    void fn().then((d) => live && setV(d));
    return () => {
      live = false;
    };
  }, [books, version]);
  return v;
}

export function useCurrencies(): Currency[] {
  const { books } = useStore();
  return useAsync(() => currencies(books.db), [] as Currency[]);
}

export function useBaseSymbol(): string {
  const { books } = useStore();
  return useAsync(async () => (await baseCurrency(books.db)).symbol, '₹');
}

export function forexSummary(base: string, c: Currency, foreignMinor: number, rateE4: number, baseAmount: number, qtyText?: string): string {
  const left = qtyText ? `${qtyText} ` : '';
  return `${left}${fmtForeign(c, Math.abs(foreignMinor))} @ ${base} ${fmtRate(rateE4)}/${c.symbol} = ${base} ${fmtAmount(Math.abs(baseAmount), false)}`;
}

interface RateLine {
  date: string;
  rate: string;
}

type RateLines = Record<RateKind, RateLine[]>;

const KINDS: RateKind[] = ['standard', 'selling', 'buying'];
const KIND_LABEL: Record<RateKind, string> = { standard: 'Standard', selling: 'Selling', buying: 'Buying' };

function RateCell({ value, base, symbol, onChange, onEnter, cell }: { value: string; base: string; symbol: string; onChange: (v: string) => void; onEnter: () => void; cell: string }) {
  const [focus, setFocus] = useState(false);
  const shown = !focus && value && parseRate(value) ? `${base} ${fmtRate(parseRate(value)!)}/${symbol}` : value;
  return (
    <input
      data-cell={cell}
      className="tb-input tb-num w-full"
      value={shown}
      autoComplete="off"
      spellCheck={false}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.ctrlKey && !e.altKey && !e.metaKey) {
          e.preventDefault();
          e.stopPropagation();
          onEnter();
        }
      }}
    />
  );
}

function RateTables({ currencyId, symbol, base, lines, setLines, onDone }: { currencyId: number | null; symbol: string; base: string; lines: RateLines; setLines: (l: RateLines) => void; onDone: () => void }) {
  const { books, company } = useStore();
  const box = useRef<HTMLDivElement>(null);
  const [last, setLast] = useState<Record<string, number | null>>({});
  const fy = company?.fy_start;
  const key = JSON.stringify([lines.selling.map((l) => l.date), lines.buying.map((l) => l.date)]);
  useEffect(() => {
    if (!currencyId) return;
    let live = true;
    void (async () => {
      const out: Record<string, number | null> = {};
      for (const k of ['selling', 'buying'] as RateKind[])
        for (let i = 0; i < lines[k].length; i++) {
          const iso = parseDate(lines[k][i].date, fy);
          out[`${k}${i}`] = iso ? await lastVoucherRate(books.db, currencyId, k, iso) : null;
        }
      if (live) setLast(out);
    })();
    return () => {
      live = false;
    };
  }, [key, currencyId]);

  const focus = (id: string) =>
    setTimeout(() => {
      const el = box.current?.querySelector(`[data-cell="${id}"]`) as HTMLInputElement | null;
      el?.focus();
      el?.select?.();
    }, 0);
  const set = (k: RateKind, i: number, patch: Partial<RateLine>) => {
    const arr = lines[k].map((l, j) => (j === i ? { ...l, ...patch } : l));
    setLines({ ...lines, [k]: arr });
  };
  const nextPanel = (k: RateKind) => {
    const n = KINDS[KINDS.indexOf(k) + 1];
    if (n) focus(`${n}-0-d`);
    else onDone();
  };
  const onDate = (k: RateKind, i: number) => {
    const t = lines[k][i].date.trim();
    if (!t) return nextPanel(k);
    const iso = parseDate(t, fy);
    if (!iso) return;
    set(k, i, { date: fmtDate(iso) });
    focus(`${k}-${i}-r`);
  };
  const onRate = (k: RateKind, i: number) => {
    const arr = lines[k];
    if (arr[i].rate.trim() && !parseRate(arr[i].rate)) return;
    if (i === arr.length - 1) setLines({ ...lines, [k]: [...arr, { date: '', rate: '' }] });
    focus(`${k}-${i + 1}-d`);
  };
  const cols = (k: RateKind) => (
    <div key={k} className="flex-1 border-l border-tb-line first:border-l-0">
      <div className="py-0.5 text-center">{KIND_LABEL[k]}</div>
      <div className="flex border-t border-tb-line px-1 py-0.5 font-semibold">
        <div className="w-24 text-center">Date</div>
        {k !== 'standard' && <div className="w-24 text-right text-xs leading-tight">Last Voucher Rate</div>}
        <div className="flex-1 text-right">Specified Rate</div>
      </div>
      <div className="mt-1 min-h-[220px]">
        {lines[k].map((l, i) => (
          <div key={i} className="flex items-center px-1">
            <div className="w-24">
              <input
                data-cell={`${k}-${i}-d`}
                className="tb-input w-full text-center"
                value={l.date}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => set(k, i, { date: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.ctrlKey && !e.altKey && !e.metaKey) {
                    e.preventDefault();
                    e.stopPropagation();
                    onDate(k, i);
                  }
                }}
              />
            </div>
            {k !== 'standard' && <div className="w-24 text-right tabular-nums">{last[`${k}${i}`] ? `${base} ${fmtRate(last[`${k}${i}`]!)}/${symbol}` : ''}</div>}
            <div className="flex-1">
              <RateCell cell={`${k}-${i}-r`} value={l.rate} base={base} symbol={symbol} onChange={(v) => set(k, i, { rate: v })} onEnter={() => onRate(k, i)} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
  return (
    <div ref={box} className="mt-2">
      <div className="border-y border-tb-line py-0.5 text-center">Rates of Exchange</div>
      <div className="flex">{KINDS.map(cols)}</div>
    </div>
  );
}

export function useRateLines(currencyId: number | null): [RateLines, (l: RateLines) => void] {
  const { books } = useStore();
  const [lines, setLines] = useState<RateLines>({ standard: [{ date: '', rate: '' }], selling: [{ date: '', rate: '' }], buying: [{ date: '', rate: '' }] });
  useEffect(() => {
    if (!currencyId) return;
    void currencyRates(books.db, currencyId).then((rs) => {
      const pick = (k: RateKind): RateLine[] => [...rs.filter((r) => r.kind === k).map((r) => ({ date: fmtDate(r.date), rate: fmtRate(r.rate_e4) })), { date: '', rate: '' }];
      setLines({ standard: pick('standard'), selling: pick('selling'), buying: pick('buying') });
    });
  }, [books, currencyId]);
  return [lines, setLines];
}

export function CurrencyForm({ id, onSaved }: { id?: number; onSaved?: (c: Currency) => void }) {
  const { books, bump, toast, company } = useStore();
  const nav = useNav();
  const dialogs = useDialogs();
  const form = useRef<FormHandle>(null);
  const base = useBaseSymbol();
  const [cur, setCur] = useState<Currency | null | undefined>(id ? undefined : null);
  const [lines, setLines] = useRateLines(id ?? null);
  const [dec, setDec] = useState<number>(2);
  useEffect(() => {
    if (id)
      void currency(books.db, id).then((c) => {
        setCur(c);
        if (c) setDec(c.decimals);
      });
  }, [books, id]);

  const save = useCallback(async () => {
    const v = form.current?.submit();
    if (!v) return;
    const decimals = parseInt(v.decimals, 10);
    const words = parseInt(v.words, 10);
    if (!Number.isInteger(decimals) || !Number.isInteger(words)) return toast('Enter the number of decimal places', 'err');
    const rows: { kind: RateKind; date: string; rate_e4: number }[] = [];
    if (cur) {
      for (const k of KINDS)
        for (const l of lines[k]) {
          if (!l.date.trim() && !l.rate.trim()) continue;
          const iso = parseDate(l.date, company?.fy_start);
          const r = parseRate(l.rate);
          if (!iso || !r) return toast(`${KIND_LABEL[k]} rate: enter a valid date and rate`, 'err');
          rows.push({ kind: k, date: iso, rate_e4: r });
        }
    }
    const input = { symbol: v.symbol, formal_name: v.formal, iso_code: v.iso, decimals, in_millions: v.millions, suffix: v.suffix, space: v.space, decimal_word: v.word, words_decimals: words };
    try {
      const saved = cur ? await updateCurrency(books.db, cur.id, input) : await createCurrency(books.db, input);
      if (cur) await replaceRates(books.db, cur.id, rows);
      bump();
      toast('Currency saved', 'ok');
      onSaved?.(saved);
      nav.pop();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  }, [books, bump, cur, lines, nav, onSaved, toast, company]);

  const accept = useCallback(async () => {
    if (await dialogs.confirm('Accept ?', { title: 'Accept', yes: 'Yes', no: 'No', corner: true })) void save();
  }, [dialogs, save]);

  const remove = async () => {
    if (!cur || !(await dialogs.confirm('Delete ?', { title: 'Delete', def: false }))) return;
    try {
      await deleteCurrency(books.db, cur.id);
      bump();
      toast('Deleted', 'ok');
      nav.pop();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };

  useScreen({
    title: cur ? 'Currency Alteration' : 'Currency Creation',
    noPeriod: true,
    keys: { 'Ctrl+A': () => void accept(), 'Alt+D': cur ? () => void remove() : () => false },
    buttons: [{ key: 'Ctrl+A', label: 'Accept', run: () => void accept() }, ...(cur ? [{ key: 'Alt+D', label: 'Delete', run: () => void remove() }] : [])],
  });

  if (cur === undefined) return null;
  const fields: FieldDef[] = [
    { key: 'symbol', label: 'Symbol', kind: 'text', required: true, initial: cur?.symbol, maxLength: 8 },
    { key: 'formal', label: 'Formal name', kind: 'text', required: true, initial: cur?.formal_name, maxLength: 60, heading: ' ' },
    { key: 'iso', label: 'ISO Currency Code', kind: 'upper', initial: cur?.iso_code, maxLength: 3 },
    { key: 'decimals', label: 'Number of decimal places', kind: 'text', initial: String(cur?.decimals ?? 2), maxLength: 1, heading: ' ' },
    { key: 'millions', label: 'Show amount in millions', kind: 'toggle', initial: !!cur?.in_millions },
    { key: 'suffix', label: 'Suffix symbol to amount', kind: 'toggle', initial: !!cur?.suffix, heading: ' ' },
    { key: 'space', label: 'Add space between amount and symbol', kind: 'toggle', initial: !!cur?.space },
    { key: 'word', label: 'Word representing amount after decimal', kind: 'text', initial: cur?.decimal_word, maxLength: 30, heading: ' ' },
    { key: 'words', label: 'No. of decimal places for amount in words', kind: 'text', initial: String(cur?.words_decimals ?? 2), maxLength: 1, validate: (v) => (parseInt(v.words, 10) > parseInt(v.decimals, 10) ? 'No. of decimal places for amount in words cannot exceed the number of decimal places' : null) },
  ];
  void dec;
  void setDec;
  return (
    <div className={cur ? 'w-full' : 'max-w-xl'}>
      <Form ref={form} fields={fields} labelWidth={cur ? 300 : 300} onDone={() => (cur ? document.querySelector<HTMLInputElement>('[data-cell="standard-0-d"]')?.focus() : void accept())} />
      {cur && <RateTables currencyId={cur.id} symbol={form.current?.read().symbol || cur.symbol} base={base} lines={lines} setLines={setLines} onDone={() => void accept()} />}
    </div>
  );
}

export function CurrencyList() {
  const { books, bump, toast } = useStore();
  const nav = useNav();
  const dialogs = useDialogs();
  const flt = useFilter();
  const list = useCurrencies();
  const rows = useMemo(() => list.filter((c) => flt.match(c.symbol, c.formal_name, c.iso_code)), [list, flt]);
  const { sel, setSel, keys } = useSel(rows.length);
  const open = (i: number) => {
    if (rows[i]) nav.push(<CurrencyForm id={rows[i].id} />);
  };
  const create = () => nav.push(<CurrencyForm />);
  const multi = () => nav.push(<MultiMasters />);
  const del = async () => {
    const c = rows[sel];
    if (!c || !(await dialogs.confirm('Delete ?', { title: 'Delete', def: false }))) return;
    try {
      await deleteCurrency(books.db, c.id);
      bump();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  useScreen({
    title: 'List of Currencies',
    keys: { ...keys, ...flt.key, Enter: () => open(sel), 'Alt+C': create, 'Alt+D': () => void del(), 'Alt+H': multi },
    buttons: [flt.button, { key: 'Alt+C', label: 'Create', run: create }, { key: 'Alt+H', label: 'Multi-Masters', run: multi }, { key: 'Alt+D', label: 'Delete', run: () => void del() }],
  });
  return (
    <Frame title="List of Currencies" subtitle="Chart of Accounts">
      {flt.bar}
      <table className="w-full">
        <thead>
          <tr className="text-left">
            <th className={th}>Symbol</th>
            <th className={th}>Formal Name</th>
            <th className={th}>ISO Code</th>
            <th className={`${th} text-right`}>Decimals</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c, i) => (
            <tr key={c.id} className={rowCls(i === sel)} onMouseEnter={() => setSel(i)} onClick={() => open(i)}>
              <td className="px-2 font-semibold">{c.symbol}</td>
              <td className="px-2">{c.formal_name}</td>
              <td className="px-2">{c.iso_code}</td>
              <td className="px-2 text-right">{c.decimals}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <div className="py-3 text-tb-muted">No currencies. Press Alt+C to create one.</div>}
    </Frame>
  );
}

export function MultiMasters() {
  const nav = useNav();
  return <SelectList title="Multi-Masters" heading="Multi-Masters" items={[{ id: 'roe', label: 'Rate of Exchange' }]} onSelect={() => nav.replace(<MultiCurrencyAlteration />)} />;
}

export function AlterCurrencies() {
  const nav = useNav();
  const list = useCurrencies();
  const { books } = useStore();
  const [only, setOnly] = useState<boolean | null>(null);
  useEffect(() => {
    void currencies(books.db).then((l) => setOnly(l.length === 0));
  }, [books]);
  if (only === null) return null;
  return (
    <SelectList
      title="Currency Alteration"
      heading="List of Currencies"
      items={list.map((c) => ({ id: c.id, label: c.symbol, sub: c.formal_name }))}
      onSelect={(i) => nav.push(<CurrencyForm id={Number(i.id)} />)}
      onCreate={() => nav.push(<CurrencyForm />)}
    />
  );
}

export function MultiCurrencyAlteration({ date: initial }: { date?: string }) {
  const { books, bump, toast, company } = useStore();
  const nav = useNav();
  const dialogs = useDialogs();
  const base = useBaseSymbol();
  const box = useRef<HTMLDivElement>(null);
  const [date, setDate] = useState(initial ?? todayIso());
  const [dateText, setDateText] = useState(fmtDate(initial ?? todayIso()));
  const [rows, setRows] = useState<Awaited<ReturnType<typeof ratesOn>>>([]);
  const [text, setText] = useState<Record<string, string>>({});
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let live = true;
    void ratesOn(books.db, date).then((r) => {
      if (!live) return;
      setRows(r);
      const t: Record<string, string> = {};
      for (const x of r) {
        t[`${x.currency.id}-standard`] = x.standard ? fmtRate(x.standard) : '';
        t[`${x.currency.id}-selling`] = x.selling.specified ? fmtRate(x.selling.specified) : '';
        t[`${x.currency.id}-buying`] = x.buying.specified ? fmtRate(x.buying.specified) : '';
      }
      setText(t);
    });
    return () => {
      live = false;
    };
  }, [books, date]);

  const focus = (id: string) =>
    setTimeout(() => {
      const el = box.current?.querySelector(`[data-cell="${id}"]`) as HTMLInputElement | null;
      el?.focus();
      el?.select?.();
    }, 0);
  useEffect(() => {
    focus('date');
  }, []);

  const save = async () => {
    const out: { currency_id: number; standard?: number | null; selling?: number | null; buying?: number | null }[] = [];
    for (const x of rows) {
      const row: { currency_id: number; standard?: number | null; selling?: number | null; buying?: number | null } = { currency_id: x.currency.id };
      for (const k of KINDS) {
        const t = (text[`${x.currency.id}-${k}`] ?? '').trim();
        if (!t) {
          row[k] = null;
          continue;
        }
        const r = parseRate(t);
        if (!r) return toast(`${x.currency.symbol} ${KIND_LABEL[k]} rate: enter a valid rate`, 'err');
        row[k] = r;
      }
      out.push(row);
    }
    try {
      await setRatesOn(books.db, date, out);
      bump();
      toast('Rates of exchange saved', 'ok');
      nav.pop();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  const accept = async () => {
    if (await dialogs.confirm('Accept ?', { title: 'Accept', yes: 'Yes', no: 'No', corner: true })) void save();
  };
  useScreen({ title: 'Multi-Currency Alteration', noPeriod: true, keys: { 'Ctrl+A': () => void accept() }, buttons: [{ key: 'Ctrl+A', label: 'Accept', run: () => void accept() }] });

  const cell = (id: string, k: RateKind, sym: string, order: string[]) => (
    <RateCell
      cell={`${id}-${k}`}
      value={text[`${id}-${k}`] ?? ''}
      base={base}
      symbol={sym}
      onChange={(v) => setText((t) => ({ ...t, [`${id}-${k}`]: v }))}
      onEnter={() => {
        const i = order.indexOf(`${id}-${k}`);
        if (i + 1 < order.length) focus(order[i + 1]);
        else void accept();
      }}
    />
  );
  const order = rows.flatMap((x) => KINDS.map((k) => `${x.currency.id}-${k}`));
  void ready;
  void setReady;
  const num = 'w-28';
  return (
    <div ref={box} className="border border-tb-line bg-tb-paper px-4 py-3">
      <div className="mb-3 flex items-center">
        <span className="w-56">Date for rate of exchange</span>
        <span className="mr-2">:</span>
        <input
          data-cell="date"
          className="tb-input w-28 font-bold"
          value={dateText}
          onChange={(e) => setDateText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.ctrlKey && !e.altKey && !e.metaKey) {
              e.preventDefault();
              e.stopPropagation();
              const iso = parseDate(dateText, company?.fy_start, date);
              if (!iso) return toast('Date for rate of exchange: invalid date', 'err');
              setDate(iso);
              setDateText(fmtDate(iso));
              if (order.length) focus(order[0]);
            }
          }}
        />
      </div>
      <table className="w-full border-y border-tb-line">
        <thead>
          <tr>
            <th className="w-12 px-1 text-left font-normal">S.No.</th>
            <th className="px-1 text-left font-normal">Currency</th>
            <th className={`${num} px-1 text-right font-normal`} rowSpan={2}>Std Rate</th>
            <th colSpan={2} className="border-l border-tb-line px-1 text-center font-normal">Selling Rate</th>
            <th colSpan={2} className="border-l border-tb-line px-1 text-center font-normal">Buying Rate</th>
          </tr>
          <tr className="text-xs">
            <th />
            <th />
            <th className="border-l border-tb-line px-1 text-right font-normal">Last Voucher Rate</th>
            <th className="px-1 text-right font-semibold">Specified Rate</th>
            <th className="border-l border-tb-line px-1 text-right font-normal">Last Voucher Rate</th>
            <th className="px-1 text-right font-semibold">Specified Rate</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((x, i) => {
            const id = x.currency.id;
            const sym = x.currency.symbol;
            const lv = (n: number | null) => (n ? `${base} ${fmtRate(n)}/${sym}` : '');
            return (
              <tr key={id}>
                <td className="px-1">{i + 1}.</td>
                <td className="px-1 font-semibold">
                  {sym} ({x.currency.formal_name})
                </td>
                <td className={`${num} px-1`}>{cell(String(id), 'standard', sym, order)}</td>
                <td className="border-l border-tb-line px-1 text-right tabular-nums">{lv(x.selling.last)}</td>
                <td className={`${num} px-1`}>{cell(String(id), 'selling', sym, order)}</td>
                <td className="border-l border-tb-line px-1 text-right tabular-nums">{lv(x.buying.last)}</td>
                <td className={`${num} px-1`}>{cell(String(id), 'buying', sym, order)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="min-h-[260px]" />
    </div>
  );
}

export interface ForexEntryResult extends EntryForexInput {
  base_amount: number;
}

export function ForexEntryDialog({
  date,
  side,
  kind = 'standard',
  initial,
  currencyId,
  baseAmount,
  onAccept,
  onCancel,
}: {
  date: string;
  side: 'Dr' | 'Cr';
  kind?: RateKind;
  initial?: { currency_id: number; foreign_amount: number; rate_e4: number };
  currencyId?: number;
  baseAmount?: number;
  onAccept: (r: ForexEntryResult) => void;
  onCancel: () => void;
}) {
  const { books, toast } = useStore();
  const base = useBaseSymbol();
  const list = useCurrencies();
  const [cur, setCur] = useState<Currency | null>(null);
  const [curText, setCurText] = useState('');
  const [amt, setAmt] = useState('');
  const [rate, setRate] = useState('');
  const refs = useRef<Record<string, HTMLInputElement | null>>({});
  const start = initial?.currency_id ?? currencyId;
  const sign = side === 'Dr' ? 1 : -1;

  const pickCurrency = useCallback(
    async (c: Currency, keepRate?: number) => {
      setCur(c);
      setCurText(c.symbol);
      const r = keepRate ?? (await rateOfExchange(books.db, c.id, date, kind))?.rate_e4;
      setRate(r ? fmtRate(r) : '');
      setTimeout(() => refs.current.amt?.focus(), 0);
    },
    [books, date, kind]
  );
  useEffect(() => {
    if (!start || cur || !list.length) return;
    const c = list.find((x) => x.id === start);
    if (!c) return;
    if (initial) {
      setAmt(fmtForeignNumber(Math.abs(initial.foreign_amount), c.decimals));
      void pickCurrency(c, initial.rate_e4);
    } else void pickCurrency(c);
  }, [start, list, cur, initial, pickCurrency]);
  useEffect(() => {
    if (!start) setTimeout(() => refs.current.cur?.focus(), 0);
  }, [start]);

  const fa = cur ? parseForeign(amt, cur.decimals) : null;
  const r = parseRate(rate);
  const baseVal = cur && fa != null && r ? foreignToBase(fa, r, cur.decimals) : 0;

  const accept = () => {
    if (!cur) return toast('Currency: choose from the list', 'err');
    if (!fa) return toast('Enter the amount in forex', 'err');
    if (!r) return toast('Rate of Exchange: enter a valid rate', 'err');
    onAccept({ currency_id: cur.id, foreign_amount: sign * fa, rate_e4: r, rate_kind: kind, base_amount: sign * baseVal });
  };
  useScreen({ title: 'Forex Rate of Exchange', kind: 'modal', noPeriod: true, swallow: true, keys: { Escape: () => onCancel(), 'Ctrl+A': accept }, buttons: [{ key: 'Ctrl+A', label: 'Accept', run: accept }] });
  void baseAmount;

  const enter = (next: string | null) => (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      if (next) refs.current[next]?.focus();
      else accept();
    }
  };
  const opts: Opt[] = list.map((c) => ({ id: c.id, label: c.symbol, sub: c.formal_name }));
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-500/35">
      <div className="min-w-[560px] border border-tb-ink bg-white shadow-lg">
        <div className="bg-tb-title px-3 py-0.5 text-center font-bold text-white">Forex Rate of Exchange</div>
        <div className="px-4 py-3">
          <div className="mb-2 flex items-center">
            <span className="w-40">Currency</span>
            <span className="mr-2">:</span>
            <div className="w-48">
              <PickerInput
                inputRef={(el) => (refs.current.cur = el)}
                value={curText}
                title="Currencies"
                options={opts}
                onChange={(t) => {
                  setCurText(t);
                  setCur(null);
                }}
                onPick={(o) => {
                  const c = list.find((x) => x.id === o.id);
                  if (c) void pickCurrency(c);
                }}
                onNoMatch={() => toast('Currency: no match', 'err')}
              />
            </div>
          </div>
          <div className="mt-3 grid grid-cols-[1fr_auto_1fr] items-end gap-3 text-center">
            <div className="font-semibold">Rate in Forex</div>
            <div className="font-semibold">Rate of Exchange</div>
            <div className="font-semibold">Rate in {base}</div>
            <div className="flex items-center justify-center">
              <span className="mr-1 font-bold">{cur?.symbol}</span>
              <input
                ref={(el) => {
                  refs.current.amt = el;
                }}
                className="tb-input tb-num w-32"
                value={amt}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setAmt(e.target.value)}
                onKeyDown={enter('rate')}
                onBlur={() => cur && fa != null && fa !== 0 && setAmt(fmtForeignNumber(Math.abs(fa), cur.decimals))}
              />
            </div>
            <div className="flex items-center justify-center">
              <span className="mx-1">@</span>
              <span className="mr-1">{base}</span>
              <input
                ref={(el) => {
                  refs.current.rate = el;
                }}
                className="tb-input tb-num w-28"
                value={rate}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setRate(e.target.value)}
                onKeyDown={enter(null)}
              />
              <span className="ml-1">/{cur?.symbol}</span>
            </div>
            <div className="font-bold tabular-nums">
              {base} {fmtAmount(baseVal, false)}
            </div>
          </div>
          <div className="mt-3 text-xs text-tb-muted">
            {side === 'Dr' ? 'Dr' : 'Cr'} entry. Enter: next   Ctrl+A: accept   Esc: cancel
          </div>
        </div>
      </div>
    </div>
  );
}

const FX_DEFS = [
  { key: 'foreign', label: 'Show foreign currency balance', default: true },
  { key: 'realised', label: 'Show realised gain/loss', default: true },
  { key: 'unrealised', label: 'Show unrealised gain/loss', default: true },
];

const gl = (n: number) => (n === 0 ? '' : n > 0 ? `${fmtAmount(n)} Gain` : `${fmtAmount(-n)} Loss`);

export function ForexGainLossReport() {
  const { books, period } = useStore();
  const nav = useNav();
  const p = usePeriodKey();
  const cfg = useReportOptions('forex-gain-loss', 'Forex Gain/Loss', FX_DEFS);
  const flt = useFilter();
  const data = useLoad(() => forexGainLoss(books.db, period.from, period.to), [period]);
  const rows = useMemo(() => (data?.rows ?? []).filter((r) => flt.match(r.ledger, r.symbol)), [data, flt]);
  const { sel, setSel, keys } = useSel(rows.length);
  const open = (i: number) => {
    if (rows[i]) nav.push(<LedgerReport ledgerId={rows[i].ledger_id} />);
  };
  const adjust = () => {
    if (data) nav.push(<ExchangeRateDifference rows={data.rows} />);
  };
  useScreen({
    title: 'Forex Gain/Loss',
    keys: { ...keys, ...p.key, ...cfg.key, ...flt.key, Enter: () => open(sel), 'Alt+J': adjust },
    buttons: [p.button, cfg.button, flt.button, { key: 'Alt+J', label: 'Adjust Forex', run: adjust }],
  });
  const row = (r: ForexGainLossRow) => ({ ...r, fb: `${fmtForeignNumber(Math.abs(r.foreign_balance), r.decimals)} ${r.symbol}${r.foreign_balance < 0 ? ' Cr' : r.foreign_balance > 0 ? ' Dr' : ''}` });
  return (
    <Frame title="Forex Gain/Loss">
      {flt.bar}
      <table className="w-full">
        <thead>
          <tr className="text-left">
            <th className={th}>Particulars</th>
            {cfg.values.foreign && <th className={`${th} text-right`}>Foreign Balance</th>}
            <th className={`${th} text-right`}>Closing Rate</th>
            <th className={`${th} text-right`}>Booked Value</th>
            <th className={`${th} text-right`}>Revalued</th>
            {cfg.values.realised && <th className={`${th} text-right`}>Realised</th>}
            {cfg.values.unrealised && <th className={`${th} text-right`}>Unrealised</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r0, i) => {
            const r = row(r0);
            return (
              <tr key={`${r.ledger_id}-${r.currency_id}`} className={rowCls(i === sel)} onMouseEnter={() => setSel(i)} onClick={() => open(i)}>
                <td className="px-2 font-semibold">{r.ledger}</td>
                {cfg.values.foreign && <td className="px-2 text-right tabular-nums">{r.fb}</td>}
                <td className="px-2 text-right tabular-nums">{r.closing_rate_e4 ? `${fmtRate(r.closing_rate_e4)}/${r.symbol}` : ''}</td>
                <td className="px-2 text-right tabular-nums">{fmtDrCr(r.base_balance)}</td>
                <td className="px-2 text-right tabular-nums">{fmtDrCr(r.revalued)}</td>
                {cfg.values.realised && <td className="px-2 text-right tabular-nums">{gl(r.realised)}</td>}
                {cfg.values.unrealised && <td className="px-2 text-right tabular-nums">{gl(r.unrealised)}</td>}
              </tr>
            );
          })}
          {data && (
            <tr className="font-bold">
              <td colSpan={3 + (cfg.values.foreign ? 1 : 0)} className="border-y-[3px] border-double border-tb-ink px-2">
                Grand Total
              </td>
              <td className="border-y-[3px] border-double border-tb-ink px-2" />
              {cfg.values.realised && <td className="border-y-[3px] border-double border-tb-ink px-2 text-right tabular-nums">{gl(data.realised)}</td>}
              {cfg.values.unrealised && <td className="border-y-[3px] border-double border-tb-ink px-2 text-right tabular-nums">{gl(data.unrealised)}</td>}
            </tr>
          )}
        </tbody>
      </table>
      {data && rows.length === 0 && <div className="py-3 text-tb-muted">No forex transactions in this period.</div>}
    </Frame>
  );
}

export function ExchangeRateDifference({ rows }: { rows: ForexGainLossRow[] }) {
  const { books, bump, toast, period } = useStore();
  const nav = useNav();
  const dialogs = useDialogs();
  const form = useRef<FormHandle>(null);
  const [ledgers, setLedgers] = useState<Ledger[]>([]);
  const [fxIds, setFxIds] = useState<number[]>([]);
  useEffect(() => {
    void books.ledgers().then(setLedgers);
    void books.voucherTypes().then(async (ts) => {
      const j = ts.find((t) => t.name === 'Journal');
      if (j) setFxIds(forexClassLedgers(await voucherClasses(books.db, j.id)).map((l) => l.id));
    });
  }, [books]);
  const items = rows.filter((r) => r.realised !== 0).map((r) => ({ ledger_id: r.ledger_id, difference: r.realised }));
  const total = items.reduce((s, i) => s + i.difference, 0);

  const save = async () => {
    const v = form.current?.submit();
    if (!v) return;
    const j = (await books.voucherTypes()).find((t) => t.name === 'Journal');
    if (!j) return toast('Journal voucher type not found', 'err');
    try {
      await postExchangeDifference(books, { type_id: j.id, date: v.date, forex_ledger_id: Number(v.ledger), items, narration: 'Forex gain/loss adjustment' });
      bump();
      toast('Journal voucher saved', 'ok');
      nav.pop();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  const accept = async () => {
    if (await dialogs.confirm('Accept ?', { title: 'Accept', yes: 'Yes', no: 'No', corner: true })) void save();
  };
  useScreen({ title: 'Accounting Voucher Creation', noPeriod: true, keys: { 'Ctrl+A': () => void accept() }, buttons: [{ key: 'Ctrl+A', label: 'Accept', run: () => void accept() }] });
  const pool = fxIds.length ? ledgers.filter((l) => fxIds.includes(l.id)) : ledgers;
  const fields: FieldDef[] = [
    { key: 'date', label: 'Date', kind: 'date', initial: period.to, required: true },
    { key: 'ledger', label: 'Forex Gain/Loss Ledger', kind: 'picker', title: 'List of Ledger Accounts', options: pool.map((l) => ({ id: l.id, label: l.name, sub: l.group_name })), required: true },
  ];
  const preview = exchangeDifferenceEntries(items, 0);
  return (
    <div className="max-w-2xl">
      <div className="mb-2 font-semibold">Journal: Forex gain/loss adjustment (realised, {fmtDate(period.from)} to {fmtDate(period.to)})</div>
      <Form ref={form} fields={fields} labelWidth={220} onDone={() => void accept()} />
      <table className="mt-3 w-full">
        <thead>
          <tr className="text-left">
            <th className={th}>Particulars</th>
            <th className={`${th} text-right`}>Debit</th>
            <th className={`${th} text-right`}>Credit</th>
          </tr>
        </thead>
        <tbody>
          {preview
            .filter((e) => e.ledger_id !== 0)
            .map((e, i) => (
              <tr key={i}>
                <td className="px-2">{rows.find((r) => r.ledger_id === e.ledger_id)?.ledger}</td>
                <td className="px-2 text-right tabular-nums">{e.amount > 0 ? fmtAmount(e.amount) : ''}</td>
                <td className="px-2 text-right tabular-nums">{e.amount < 0 ? fmtAmount(-e.amount) : ''}</td>
              </tr>
            ))}
          <tr className="font-bold">
            <td className="border-t border-tb-ink px-2">Forex Gain/Loss ledger</td>
            <td className="border-t border-tb-ink px-2 text-right tabular-nums">{total < 0 ? fmtAmount(-total) : ''}</td>
            <td className="border-t border-tb-ink px-2 text-right tabular-nums">{total > 0 ? fmtAmount(total) : ''}</td>
          </tr>
        </tbody>
      </table>
      {items.length === 0 && <div className="py-3 text-tb-muted">No realised forex difference to adjust.</div>}
    </div>
  );
}
