import { CoreError, one, type Db, type Stmt } from './db.ts';
import { groupIndian, clean } from './util.ts';
import type { Books, EntryInput, VoucherRow } from './books.ts';

export const CURRENCY_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS currencies (
    id INTEGER PRIMARY KEY,
    symbol TEXT NOT NULL UNIQUE COLLATE NOCASE,
    formal_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    iso_code TEXT NOT NULL DEFAULT '',
    decimals INTEGER NOT NULL DEFAULT 2,
    in_millions INTEGER NOT NULL DEFAULT 0,
    suffix INTEGER NOT NULL DEFAULT 0,
    space INTEGER NOT NULL DEFAULT 0,
    decimal_word TEXT NOT NULL DEFAULT '',
    words_decimals INTEGER NOT NULL DEFAULT 2
  )`,
  `CREATE TABLE IF NOT EXISTS currency_rates (
    id INTEGER PRIMARY KEY,
    currency_id INTEGER NOT NULL REFERENCES currencies(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('standard','selling','buying')),
    date TEXT NOT NULL,
    rate_e4 INTEGER NOT NULL CHECK (rate_e4 > 0),
    UNIQUE (currency_id, kind, date)
  )`,
  `CREATE TABLE IF NOT EXISTS entry_forex (
    id INTEGER PRIMARY KEY,
    entry_id INTEGER NOT NULL UNIQUE REFERENCES entries(id) ON DELETE CASCADE,
    currency_id INTEGER NOT NULL REFERENCES currencies(id),
    foreign_amount INTEGER NOT NULL,
    rate_e4 INTEGER NOT NULL CHECK (rate_e4 > 0),
    rate_kind TEXT NOT NULL DEFAULT 'standard' CHECK (rate_kind IN ('standard','selling','buying'))
  )`,
  'CREATE INDEX IF NOT EXISTS idx_entry_forex_currency ON entry_forex(currency_id)',
  'CREATE INDEX IF NOT EXISTS idx_currency_rates_lookup ON currency_rates(currency_id, kind, date)',
];

export async function ensureCurrency(db: Db): Promise<void> {
  await db.batch(CURRENCY_SCHEMA.map((sql) => ({ sql })));
}

export type RateKind = 'standard' | 'selling' | 'buying';
export const RATE_KINDS: RateKind[] = ['standard', 'selling', 'buying'];
export const RATE_SCALE = 10000;

export interface Currency {
  id: number;
  symbol: string;
  formal_name: string;
  iso_code: string;
  decimals: number;
  in_millions: number;
  suffix: number;
  space: number;
  decimal_word: string;
  words_decimals: number;
}

export interface CurrencyInput {
  symbol: string;
  formal_name: string;
  iso_code?: string;
  decimals?: number;
  in_millions?: boolean | number;
  suffix?: boolean | number;
  space?: boolean | number;
  decimal_word?: string;
  words_decimals?: number;
}

export interface RateRow {
  id: number;
  currency_id: number;
  kind: RateKind;
  date: string;
  rate_e4: number;
}

const pow10 = (n: number): bigint => 10n ** BigInt(n);

function divRound(num: bigint, den: bigint): bigint {
  const neg = num < 0n !== den < 0n;
  const a = num < 0n ? -num : num;
  const b = den < 0n ? -den : den;
  const q = (2n * a + b) / (2n * b);
  return neg ? -q : q;
}

export function foreignToBase(foreignMinor: number, rateE4: number, decimals: number): number {
  return Number(divRound(BigInt(foreignMinor) * BigInt(rateE4), pow10(decimals) * 100n));
}

export function baseToForeign(paise: number, rateE4: number, decimals: number): number {
  if (!rateE4) return 0;
  return Number(divRound(BigInt(paise) * pow10(decimals) * 100n, BigInt(rateE4)));
}

export function parseRate(text: string): number | null {
  const t = String(text).replace(/[,\s]/g, '');
  if (!/^\d*\.?\d{0,4}$/.test(t) || t === '' || t === '.') return null;
  const [w, f = ''] = t.split('.');
  const v = parseInt(w || '0', 10) * RATE_SCALE + parseInt(f.padEnd(4, '0') || '0', 10);
  return v > 0 ? v : null;
}

export function fmtRate(rateE4: number): string {
  if (!rateE4) return '';
  const w = Math.floor(rateE4 / RATE_SCALE);
  const f = String(rateE4 % RATE_SCALE).padStart(4, '0').replace(/0+$/, '');
  return f ? `${w}.${f}` : String(w);
}

export function parseForeign(text: string, decimals: number): number | null {
  const t = String(text).replace(/[,\s]/g, '');
  if (t === '') return 0;
  const re = new RegExp(`^-?\\d*\\.?\\d{0,${decimals}}$`);
  if (!re.test(t) || t === '.' || t === '-') return null;
  const neg = t.startsWith('-');
  const [w, f = ''] = t.replace('-', '').split('.');
  const v = parseInt(w || '0', 10) * 10 ** decimals + (decimals ? parseInt(f.padEnd(decimals, '0') || '0', 10) : 0);
  return neg ? -v : v;
}

export function fmtForeignNumber(minor: number, decimals: number): string {
  const abs = Math.abs(minor);
  const unit = 10 ** decimals;
  const whole = Math.floor(abs / unit);
  const frac = decimals ? `.${String(abs % unit).padStart(decimals, '0')}` : '';
  return `${minor < 0 ? '-' : ''}${groupIndian(String(whole))}${frac}`;
}

export function fmtForeign(c: Pick<Currency, 'symbol' | 'decimals' | 'suffix' | 'space'>, minor: number): string {
  const n = fmtForeignNumber(minor, c.decimals);
  const sp = c.space ? ' ' : '';
  return c.suffix ? `${n}${sp}${c.symbol}` : `${c.symbol}${sp}${n}`;
}

export function fmtRateOfExchange(baseSymbol: string, c: Pick<Currency, 'symbol'>, rateE4: number): string {
  return `${baseSymbol} ${fmtRate(rateE4)}/${c.symbol}`;
}

export async function currencies(db: Db): Promise<Currency[]> {
  return db.select<Currency>('SELECT * FROM currencies ORDER BY id');
}

export async function currency(db: Db, id: number): Promise<Currency | null> {
  return (await one<Currency>(db, 'SELECT * FROM currencies WHERE id = ?', [id])) ?? null;
}

export async function baseCurrency(db: Db): Promise<{ symbol: string; name: string; decimals: number }> {
  const r = await one<{ currency_symbol: string; currency_name: string; decimals: number }>(db, 'SELECT currency_symbol, currency_name, decimals FROM company WHERE id = 1');
  return { symbol: r?.currency_symbol ?? '₹', name: r?.currency_name ?? 'INR', decimals: r?.decimals ?? 2 };
}

async function normalise(db: Db, input: CurrencyInput, selfId: number | null): Promise<Omit<Currency, 'id'>> {
  const symbol = clean(input.symbol, 8);
  const formal = clean(input.formal_name, 60);
  if (!symbol) throw new CoreError('invalid', 'Currency symbol is required');
  if (!formal) throw new CoreError('invalid', 'Formal name is required');
  const iso = clean(input.iso_code, 3).toUpperCase();
  if (iso && !/^[A-Z]{3}$/.test(iso)) throw new CoreError('invalid', 'ISO Currency Code must be three letters');
  const decimals = input.decimals ?? 2;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 6) throw new CoreError('invalid', 'Number of decimal places must be between 0 and 6');
  const words = input.words_decimals ?? decimals;
  if (!Number.isInteger(words) || words < 0 || words > decimals) throw new CoreError('invalid', 'No. of decimal places for amount in words cannot exceed the number of decimal places');
  const base = await baseCurrency(db);
  if (symbol.toLowerCase() === base.symbol.toLowerCase()) throw new CoreError('conflict', `Symbol '${symbol}' is already used by the base currency`);
  const dupSym = await one<{ id: number }>(db, 'SELECT id FROM currencies WHERE symbol = ? AND id <> ?', [symbol, selfId ?? 0]);
  if (dupSym) throw new CoreError('conflict', `Currency symbol '${symbol}' already exists`);
  const dupName = await one<{ id: number }>(db, 'SELECT id FROM currencies WHERE formal_name = ? AND id <> ?', [formal, selfId ?? 0]);
  if (dupName) throw new CoreError('conflict', `Formal name '${formal}' already exists`);
  return {
    symbol,
    formal_name: formal,
    iso_code: iso,
    decimals,
    in_millions: input.in_millions ? 1 : 0,
    suffix: input.suffix ? 1 : 0,
    space: input.space ? 1 : 0,
    decimal_word: clean(input.decimal_word, 30),
    words_decimals: words,
  };
}

export async function createCurrency(db: Db, input: CurrencyInput): Promise<Currency> {
  const c = await normalise(db, input, null);
  const id = ((await one<{ m: number }>(db, 'SELECT COALESCE(MAX(id), 0) AS m FROM currencies'))!.m) + 1;
  await db.batch([
    {
      sql: 'INSERT INTO currencies (id, symbol, formal_name, iso_code, decimals, in_millions, suffix, space, decimal_word, words_decimals) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      params: [id, c.symbol, c.formal_name, c.iso_code, c.decimals, c.in_millions, c.suffix, c.space, c.decimal_word, c.words_decimals],
    },
  ]);
  return (await currency(db, id))!;
}

export async function updateCurrency(db: Db, id: number, input: CurrencyInput): Promise<Currency> {
  const cur = await currency(db, id);
  if (!cur) throw new CoreError('not_found', 'Currency not found');
  const used = await one(db, 'SELECT 1 FROM entry_forex WHERE currency_id = ?', [id]);
  const c = await normalise(db, input, id);
  if (used && c.decimals !== cur.decimals) throw new CoreError('conflict', 'Number of decimal places cannot be changed once the currency is used in transactions');
  await db.batch([
    {
      sql: 'UPDATE currencies SET symbol=?, formal_name=?, iso_code=?, decimals=?, in_millions=?, suffix=?, space=?, decimal_word=?, words_decimals=? WHERE id=?',
      params: [c.symbol, c.formal_name, c.iso_code, c.decimals, c.in_millions, c.suffix, c.space, c.decimal_word, c.words_decimals, id],
    },
  ]);
  return (await currency(db, id))!;
}

export async function deleteCurrency(db: Db, id: number): Promise<void> {
  if (!(await currency(db, id))) throw new CoreError('not_found', 'Currency not found');
  if (await one(db, 'SELECT 1 FROM entry_forex WHERE currency_id = ?', [id])) throw new CoreError('conflict', 'Currency is used in transactions and cannot be deleted');
  await db.batch([
    { sql: 'DELETE FROM currency_rates WHERE currency_id = ?', params: [id] },
    { sql: 'DELETE FROM currencies WHERE id = ?', params: [id] },
  ]);
}

export async function currencyRates(db: Db, currencyId: number, kind?: RateKind): Promise<RateRow[]> {
  return kind
    ? db.select<RateRow>('SELECT * FROM currency_rates WHERE currency_id = ? AND kind = ? ORDER BY date', [currencyId, kind])
    : db.select<RateRow>('SELECT * FROM currency_rates WHERE currency_id = ? ORDER BY kind, date', [currencyId]);
}

export async function setRate(db: Db, currencyId: number, kind: RateKind, date: string, rateE4: number | null): Promise<void> {
  if (!(await currency(db, currencyId))) throw new CoreError('not_found', 'Currency not found');
  if (!RATE_KINDS.includes(kind)) throw new CoreError('invalid', 'Unknown rate type');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new CoreError('invalid', 'Invalid date');
  const stmts: Stmt[] = [{ sql: 'DELETE FROM currency_rates WHERE currency_id = ? AND kind = ? AND date = ?', params: [currencyId, kind, date] }];
  if (rateE4 != null) {
    if (!Number.isInteger(rateE4) || rateE4 <= 0) throw new CoreError('invalid', 'Rate of exchange must be greater than zero');
    const id = ((await one<{ m: number }>(db, 'SELECT COALESCE(MAX(id), 0) AS m FROM currency_rates'))!.m) + 1;
    stmts.push({ sql: 'INSERT INTO currency_rates (id, currency_id, kind, date, rate_e4) VALUES (?, ?, ?, ?, ?)', params: [id, currencyId, kind, date, rateE4] });
  }
  await db.batch(stmts);
}

export async function replaceRates(db: Db, currencyId: number, rows: { kind: RateKind; date: string; rate_e4: number }[]): Promise<void> {
  if (!(await currency(db, currencyId))) throw new CoreError('not_found', 'Currency not found');
  const seen = new Set<string>();
  for (const r of rows) {
    if (!RATE_KINDS.includes(r.kind)) throw new CoreError('invalid', 'Unknown rate type');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) throw new CoreError('invalid', 'Invalid date');
    if (!Number.isInteger(r.rate_e4) || r.rate_e4 <= 0) throw new CoreError('invalid', 'Rate of exchange must be greater than zero');
    const k = `${r.kind}|${r.date}`;
    if (seen.has(k)) throw new CoreError('conflict', `Duplicate ${r.kind} rate for the same date`);
    seen.add(k);
  }
  let id = ((await one<{ m: number }>(db, 'SELECT COALESCE(MAX(id), 0) AS m FROM currency_rates'))!.m) + 1;
  await db.batch([
    { sql: 'DELETE FROM currency_rates WHERE currency_id = ?', params: [currencyId] },
    ...rows.map((r) => ({
      sql: 'INSERT INTO currency_rates (id, currency_id, kind, date, rate_e4) VALUES (?, ?, ?, ?, ?)',
      params: [id++, currencyId, r.kind, r.date, r.rate_e4],
    })),
  ]);
}

export async function specifiedRate(db: Db, currencyId: number, kind: RateKind, date: string): Promise<number | null> {
  const r = await one<{ rate_e4: number }>(db, 'SELECT rate_e4 FROM currency_rates WHERE currency_id = ? AND kind = ? AND date <= ? ORDER BY date DESC LIMIT 1', [currencyId, kind, date]);
  return r?.rate_e4 ?? null;
}

export async function lastVoucherRate(db: Db, currencyId: number, kind: RateKind, date: string): Promise<number | null> {
  const r = await one<{ rate_e4: number }>(
    db,
    `SELECT f.rate_e4 FROM entry_forex f JOIN entries e ON e.id = f.entry_id JOIN vouchers v ON v.id = e.voucher_id
     WHERE f.currency_id = ? AND f.rate_kind = ? AND v.date <= ? AND v.cancelled = 0 ORDER BY v.date DESC, f.id DESC LIMIT 1`,
    [currencyId, kind, date]
  );
  return r?.rate_e4 ?? null;
}

export interface AppliedRate {
  rate_e4: number;
  source: 'voucher' | 'specified' | 'standard';
}

export async function rateOfExchange(db: Db, currencyId: number, date: string, kind: RateKind = 'standard'): Promise<AppliedRate | null> {
  if (kind !== 'standard') {
    const v = await lastVoucherRate(db, currencyId, kind, date);
    if (v) return { rate_e4: v, source: 'voucher' };
    const s = await specifiedRate(db, currencyId, kind, date);
    if (s) return { rate_e4: s, source: 'specified' };
  }
  const std = await specifiedRate(db, currencyId, 'standard', date);
  return std ? { rate_e4: std, source: 'standard' } : null;
}

export interface MultiRateRow {
  currency: Currency;
  standard: number | null;
  selling: { last: number | null; specified: number | null };
  buying: { last: number | null; specified: number | null };
}

export async function ratesOn(db: Db, date: string): Promise<MultiRateRow[]> {
  const out: MultiRateRow[] = [];
  for (const c of await currencies(db)) {
    out.push({
      currency: c,
      standard: await specifiedRate(db, c.id, 'standard', date),
      selling: { last: await lastVoucherRate(db, c.id, 'selling', date), specified: await specifiedRate(db, c.id, 'selling', date) },
      buying: { last: await lastVoucherRate(db, c.id, 'buying', date), specified: await specifiedRate(db, c.id, 'buying', date) },
    });
  }
  return out;
}

export async function setRatesOn(db: Db, date: string, rows: { currency_id: number; standard?: number | null; selling?: number | null; buying?: number | null }[]): Promise<void> {
  for (const r of rows) {
    for (const k of RATE_KINDS) {
      const v = r[k];
      if (v === undefined) continue;
      await setRate(db, r.currency_id, k, date, v);
    }
  }
}

export interface EntryForexInput {
  currency_id: number;
  foreign_amount: number;
  rate_e4: number;
  rate_kind?: RateKind;
}

export interface EntryForex extends EntryForexInput {
  id: number;
  entry_id: number;
  rate_kind: RateKind;
  symbol: string;
  decimals: number;
  base_amount: number;
}

export async function forexEntryAmount(db: Db, input: EntryForexInput): Promise<number> {
  const c = await currency(db, input.currency_id);
  if (!c) throw new CoreError('not_found', 'Currency not found');
  if (!Number.isInteger(input.rate_e4) || input.rate_e4 <= 0) throw new CoreError('invalid', 'Rate of exchange must be greater than zero');
  return foreignToBase(input.foreign_amount, input.rate_e4, c.decimals);
}

export async function saveEntryForex(db: Db, entryId: number, input: EntryForexInput): Promise<EntryForex> {
  const e = await one<{ amount: number }>(db, 'SELECT amount FROM entries WHERE id = ?', [entryId]);
  if (!e) throw new CoreError('not_found', 'Entry not found');
  const base = await forexEntryAmount(db, input);
  if (base !== e.amount) throw new CoreError('invalid', 'Forex amount at the given rate does not match the entry amount');
  if (!Number.isInteger(input.foreign_amount) || input.foreign_amount === 0) throw new CoreError('invalid', 'Foreign amount is required');
  if ((input.foreign_amount > 0) !== (e.amount > 0)) throw new CoreError('invalid', 'Foreign amount must have the same Dr/Cr side as the entry');
  const id = ((await one<{ m: number }>(db, 'SELECT COALESCE(MAX(id), 0) AS m FROM entry_forex'))!.m) + 1;
  await db.batch([
    { sql: 'DELETE FROM entry_forex WHERE entry_id = ?', params: [entryId] },
    {
      sql: 'INSERT INTO entry_forex (id, entry_id, currency_id, foreign_amount, rate_e4, rate_kind) VALUES (?, ?, ?, ?, ?, ?)',
      params: [id, entryId, input.currency_id, input.foreign_amount, input.rate_e4, input.rate_kind ?? 'standard'],
    },
  ]);
  return (await entryForex(db, entryId))!;
}

export async function deleteEntryForex(db: Db, entryId: number): Promise<void> {
  await db.batch([{ sql: 'DELETE FROM entry_forex WHERE entry_id = ?', params: [entryId] }]);
}

const FOREX_SELECT = `SELECT f.id, f.entry_id, f.currency_id, f.foreign_amount, f.rate_e4, f.rate_kind, c.symbol, c.decimals, e.amount AS base_amount
  FROM entry_forex f JOIN currencies c ON c.id = f.currency_id JOIN entries e ON e.id = f.entry_id`;

export async function entryForex(db: Db, entryId: number): Promise<EntryForex | null> {
  return (await one<EntryForex>(db, `${FOREX_SELECT} WHERE f.entry_id = ?`, [entryId])) ?? null;
}

export async function voucherForex(db: Db, voucherId: number): Promise<EntryForex[]> {
  return db.select<EntryForex>(`${FOREX_SELECT} WHERE e.voucher_id = ? ORDER BY e.seq`, [voucherId]);
}

export async function saveVoucherForex(db: Db, voucher: VoucherRow, items: { entry_index: number; forex: EntryForexInput | null }[]): Promise<void> {
  for (const it of items) {
    const e = voucher.entries[it.entry_index];
    if (!e) throw new CoreError('invalid', 'Entry not found');
    if (it.forex) await saveEntryForex(db, e.id, it.forex);
    else await deleteEntryForex(db, e.id);
  }
}

export async function closingRate(db: Db, currencyId: number, date: string): Promise<number | null> {
  for (const k of ['standard', 'selling', 'buying'] as RateKind[]) {
    const r = await specifiedRate(db, currencyId, k, date);
    if (r) return r;
  }
  for (const k of ['selling', 'buying', 'standard'] as RateKind[]) {
    const r = await lastVoucherRate(db, currencyId, k, date);
    if (r) return r;
  }
  return null;
}

export interface ForexGainLossRow {
  ledger_id: number;
  ledger: string;
  currency_id: number;
  symbol: string;
  decimals: number;
  foreign_balance: number;
  base_balance: number;
  closing_rate_e4: number | null;
  revalued: number;
  realised: number;
  unrealised: number;
}

export interface ForexGainLoss {
  rows: ForexGainLossRow[];
  realised: number;
  unrealised: number;
  total: number;
}

interface Lot {
  fa: number;
  rate: number;
}

export async function forexGainLoss(db: Db, from: string, to: string): Promise<ForexGainLoss> {
  const items = await db.select<{ ledger_id: number; ledger: string; currency_id: number; symbol: string; decimals: number; fa: number; rate: number; date: string }>(
    `SELECT e.ledger_id, l.name AS ledger, f.currency_id, c.symbol, c.decimals, f.foreign_amount AS fa, f.rate_e4 AS rate, v.date
     FROM entry_forex f JOIN entries e ON e.id = f.entry_id JOIN vouchers v ON v.id = e.voucher_id
     JOIN ledgers l ON l.id = e.ledger_id JOIN currencies c ON c.id = f.currency_id
     WHERE v.cancelled = 0 AND v.date <= ? ORDER BY e.ledger_id, f.currency_id, v.date, v.id, e.seq`,
    [to]
  );
  const groups = new Map<string, typeof items>();
  for (const it of items) {
    const k = `${it.ledger_id}|${it.currency_id}`;
    const g = groups.get(k);
    if (g) g.push(it);
    else groups.set(k, [it]);
  }
  const rows: ForexGainLossRow[] = [];
  for (const g of groups.values()) {
    const head = g[0];
    const lots: Lot[] = [];
    let realised = 0;
    for (const it of g) {
      let rem = it.fa;
      while (rem !== 0 && lots.length && lots[0].fa > 0 !== rem > 0) {
        const lot = lots[0];
        const m = Math.min(Math.abs(lot.fa), Math.abs(rem));
        const s = lot.fa > 0 ? 1 : -1;
        if (it.date >= from) realised += s * (foreignToBase(m, it.rate, head.decimals) - foreignToBase(m, lot.rate, head.decimals));
        lot.fa -= s * m;
        rem += s * m;
        if (lot.fa === 0) lots.shift();
      }
      if (rem !== 0) lots.push({ fa: rem, rate: it.rate });
    }
    const rc = await closingRate(db, head.currency_id, to);
    let fb = 0;
    let bb = 0;
    let rv = 0;
    for (const l of lots) {
      fb += l.fa;
      bb += foreignToBase(l.fa, l.rate, head.decimals);
      rv += foreignToBase(l.fa, rc ?? l.rate, head.decimals);
    }
    rows.push({
      ledger_id: head.ledger_id,
      ledger: head.ledger,
      currency_id: head.currency_id,
      symbol: head.symbol,
      decimals: head.decimals,
      foreign_balance: fb,
      base_balance: bb,
      closing_rate_e4: rc,
      revalued: rv,
      realised,
      unrealised: rv - bb,
    });
  }
  const keep = rows.filter((r) => r.realised !== 0 || r.foreign_balance !== 0);
  const realised = keep.reduce((s, r) => s + r.realised, 0);
  const unrealised = keep.reduce((s, r) => s + r.unrealised, 0);
  return { rows: keep, realised, unrealised, total: realised + unrealised };
}

export interface ExchangeDifferenceItem {
  ledger_id: number;
  difference: number;
}

export function exchangeDifferenceEntries(items: ExchangeDifferenceItem[], forexLedgerId: number): EntryInput[] {
  const entries: EntryInput[] = [];
  let net = 0;
  for (const it of items) {
    if (!it.difference) continue;
    entries.push({ ledger_id: it.ledger_id, amount: it.difference });
    net += it.difference;
  }
  if (net) entries.push({ ledger_id: forexLedgerId, amount: -net });
  return entries;
}

export async function postExchangeDifference(
  books: Books,
  input: { type_id: number; date: string; forex_ledger_id: number; items: ExchangeDifferenceItem[]; narration?: string; number?: string }
): Promise<VoucherRow> {
  const entries = exchangeDifferenceEntries(input.items, input.forex_ledger_id);
  if (!entries.length) throw new CoreError('invalid', 'There is no exchange rate difference to adjust');
  return books.createVoucher({ type_id: input.type_id, date: input.date, number: input.number, narration: input.narration ?? 'Forex gain/loss adjustment', entries });
}

export function convertAmount(paise: number, rateE4: number, decimals: number): number {
  return baseToForeign(paise, rateE4, decimals);
}
