import test from 'node:test';
import assert from 'node:assert/strict';
import { Books } from '../src/books.ts';
import { nodeDb } from '../src/node-adapter.ts';
import {
  baseToForeign, createCurrency, currencies, deleteCurrency, ensureCurrency, entryForex, exchangeDifferenceEntries, fmtForeign, fmtRate, foreignToBase, forexGainLoss,
  parseForeign, parseRate, postExchangeDifference, rateOfExchange, ratesOn, saveEntryForex, setRate, setRatesOn, updateCurrency, replaceRates, currencyRates,
} from '../src/currency.ts';
import {
  createVoucherClass, deleteVoucherClass, ensureVClass, expandVoucherClass, parsePercent, fmtPercent, setVoucherTypeOptions, updateVoucherClass, voucherClasses, voucherTypeOptions,
} from '../src/vclass.ts';

async function setup() {
  const db = nodeDb();
  const books = new Books(db);
  await books.init();
  await books.createCompany({ name: 'National Handicrafts', fy_start: '2025-04-01' });
  await ensureCurrency(db);
  await ensureVClass(db);
  const groups = await books.groups();
  const g = (n: string) => groups.find((x) => x.name === n)!.id;
  const ty = (await books.voucherTypes()).reduce((m, t) => m.set(t.name, t.id), new Map<string, number>());
  const mk = async (name: string, group: string) => (await books.createLedger({ name, group_id: g(group) })).id;
  return {
    db,
    books,
    ty,
    cust: await mk('Tina Handlooms', 'Sundry Debtors'),
    sales: await mk('Sales A/c', 'Sales Accounts'),
    bank: await mk('Bank', 'Bank Accounts'),
    forex: await mk('Forex Gain Or Loss', 'Indirect Expenses'),
    freight: await mk('Freight', 'Indirect Expenses'),
  };
}

const usd = { symbol: '$', formal_name: 'US Dollar', iso_code: 'usd', decimals: 2, suffix: false, space: false, decimal_word: 'Cent', words_decimals: 2 };

test('rate and amount arithmetic', () => {
  assert.equal(parseRate('89.64'), 896400);
  assert.equal(parseRate('abc'), null);
  assert.equal(parseRate('0'), null);
  assert.equal(fmtRate(896400), '89.64');
  assert.equal(fmtRate(1210000), '121');
  assert.equal(foreignToBase(30000, 890600, 2), 2671800);
  assert.equal(baseToForeign(2671800, 890600, 2), 30000);
  assert.equal(parseForeign('300.5', 2), 30050);
  assert.equal(parseForeign('1.234', 2), null);
  assert.equal(foreignToBase(-30000, 900000, 2), -2700000);
  assert.equal(fmtForeign({ symbol: '$', decimals: 2, suffix: 0, space: 0 }, 421017_18), '$4,21,017.18');
  assert.equal(fmtForeign({ symbol: 'US$', decimals: 2, suffix: 1, space: 1 }, 1000), '10.00 US$');
});

test('currency master validation and lifecycle', async () => {
  const { db } = await setup();
  const c = await createCurrency(db, usd);
  assert.equal(c.iso_code, 'USD');
  await assert.rejects(() => createCurrency(db, { ...usd, formal_name: 'Other' }), /already exists/);
  await assert.rejects(() => createCurrency(db, { ...usd, symbol: '£', formal_name: 'Pound', words_decimals: 3 }), /cannot exceed/);
  await assert.rejects(() => createCurrency(db, { ...usd, symbol: '₹', formal_name: 'Rupee' }), /base currency/);
  const u = await updateCurrency(db, c.id, { ...usd, suffix: true, space: true });
  assert.equal(u.suffix, 1);
  assert.equal((await currencies(db)).length, 1);
  await deleteCurrency(db, c.id);
  assert.equal((await currencies(db)).length, 0);
});

test('rates of exchange by date, last voucher rate wins', async () => {
  const { db, books, ty, cust, sales } = await setup();
  const c = await createCurrency(db, usd);
  await setRate(db, c.id, 'standard', '2025-04-01', 896400);
  await setRate(db, c.id, 'selling', '2025-04-01', 890600);
  await setRate(db, c.id, 'buying', '2025-04-01', 897500);
  await setRate(db, c.id, 'standard', '2025-06-01', 900000);
  assert.deepEqual(await rateOfExchange(db, c.id, '2025-05-01'), { rate_e4: 896400, source: 'standard' });
  assert.deepEqual(await rateOfExchange(db, c.id, '2025-06-10'), { rate_e4: 900000, source: 'standard' });
  assert.deepEqual(await rateOfExchange(db, c.id, '2025-05-01', 'selling'), { rate_e4: 890600, source: 'specified' });
  assert.equal(await rateOfExchange(db, c.id, '2025-03-01'), null);
  const v = await books.createVoucher({ type_id: ty.get('Sales')!, date: '2025-04-02', entries: [{ ledger_id: cust, amount: 2700000 }, { ledger_id: sales, amount: -2700000 }] });
  await saveEntryForex(db, v.entries[0].id, { currency_id: c.id, foreign_amount: 30000, rate_e4: 900000, rate_kind: 'selling' });
  assert.deepEqual(await rateOfExchange(db, c.id, '2025-05-01', 'selling'), { rate_e4: 900000, source: 'voucher' });
  assert.equal((await rateOfExchange(db, c.id, '2025-04-01', 'selling'))!.source, 'specified');
  const rows = await ratesOn(db, '2025-05-01');
  assert.equal(rows[0].standard, 896400);
  assert.equal(rows[0].selling.last, 900000);
  assert.equal(rows[0].buying.specified, 897500);
  await setRatesOn(db, '2025-07-01', [{ currency_id: c.id, standard: 910000, buying: null }]);
  assert.equal((await rateOfExchange(db, c.id, '2025-07-02'))!.rate_e4, 910000);
  await replaceRates(db, c.id, [{ kind: 'standard', date: '2025-01-01', rate_e4: 850000 }]);
  assert.equal((await currencyRates(db, c.id)).length, 1);
  await assert.rejects(() => deleteCurrency(db, c.id), /used in transactions/);
});

test('entry forex validates against the entry amount', async () => {
  const { db, books, ty, cust, sales } = await setup();
  const c = await createCurrency(db, usd);
  const v = await books.createVoucher({ type_id: ty.get('Sales')!, date: '2025-04-02', entries: [{ ledger_id: cust, amount: 2671800 }, { ledger_id: sales, amount: -2671800 }] });
  await assert.rejects(() => saveEntryForex(db, v.entries[0].id, { currency_id: c.id, foreign_amount: 30000, rate_e4: 900000 }), /does not match/);
  await assert.rejects(() => saveEntryForex(db, v.entries[0].id, { currency_id: c.id, foreign_amount: -30000, rate_e4: 890600 }), /does not match|same Dr/);
  const f = await saveEntryForex(db, v.entries[0].id, { currency_id: c.id, foreign_amount: 30000, rate_e4: 890600, rate_kind: 'selling' });
  assert.equal(f.base_amount, 2671800);
  assert.equal((await entryForex(db, v.entries[0].id))!.symbol, '$');
});

test('realised and unrealised forex gain/loss with FIFO settlement', async () => {
  const { db, books, ty, cust, sales, bank, forex } = await setup();
  const c = await createCurrency(db, usd);
  await setRate(db, c.id, 'standard', '2025-04-01', 910000);
  await setRate(db, c.id, 'standard', '2025-06-30', 920000);
  const sale = await books.createVoucher({ type_id: ty.get('Sales')!, date: '2025-04-05', entries: [{ ledger_id: cust, amount: 9000000 }, { ledger_id: sales, amount: -9000000 }] });
  await saveEntryForex(db, sale.entries[0].id, { currency_id: c.id, foreign_amount: 100000, rate_e4: 900000, rate_kind: 'selling' });
  const rcpt = await books.createVoucher({ type_id: ty.get('Receipt')!, date: '2025-05-10', entries: [{ ledger_id: bank, amount: 4550000 }, { ledger_id: cust, amount: -4550000 }] });
  await saveEntryForex(db, rcpt.entries[1].id, { currency_id: c.id, foreign_amount: -50000, rate_e4: 910000 });
  const r = await forexGainLoss(db, '2025-04-01', '2026-03-31');
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].foreign_balance, 50000);
  assert.equal(r.rows[0].realised, 50000);
  assert.equal(r.rows[0].base_balance, 4500000);
  assert.equal(r.rows[0].revalued, 4600000);
  assert.equal(r.rows[0].unrealised, 100000);
  assert.equal(r.total, 150000);
  const early = await forexGainLoss(db, '2025-04-01', '2025-04-30');
  assert.equal(early.realised, 0);
  assert.equal(early.rows[0].foreign_balance, 100000);
  assert.equal(early.rows[0].unrealised, 100000);
  const after = await forexGainLoss(db, '2025-05-11', '2026-03-31');
  assert.equal(after.realised, 0);

  const entries = exchangeDifferenceEntries([{ ledger_id: cust, difference: 500000 }], forex);
  assert.deepEqual(entries.map((e) => e.amount), [500000, -500000]);
  const j = await postExchangeDifference(books, { type_id: ty.get('Journal')!, date: '2025-05-10', forex_ledger_id: forex, items: [{ ledger_id: cust, difference: r.rows[0].realised }] });
  assert.equal(j.entries.reduce((s, e) => s + e.amount, 0), 0);
  await assert.rejects(() => postExchangeDifference(books, { type_id: ty.get('Journal')!, date: '2025-05-10', forex_ledger_id: forex, items: [] }), /no exchange rate difference/);
});

test('creditor payment at a higher rate is a loss', async () => {
  const { db, books, ty, supp, bank } = await (async () => {
    const s = await setup();
    const groups = await s.books.groups();
    const supp = (await s.books.createLedger({ name: 'Supplier', group_id: groups.find((x) => x.name === 'Sundry Creditors')!.id })).id;
    return { ...s, supp };
  })();
  const c = await createCurrency(db, usd);
  const p = await books.createVoucher({ type_id: ty.get('Journal')!, date: '2025-04-05', entries: [{ ledger_id: bank, amount: 9000000 }, { ledger_id: supp, amount: -9000000 }] });
  await saveEntryForex(db, p.entries[1].id, { currency_id: c.id, foreign_amount: -100000, rate_e4: 900000 });
  const q = await books.createVoucher({ type_id: ty.get('Journal')!, date: '2025-05-05', entries: [{ ledger_id: supp, amount: 9100000 }, { ledger_id: bank, amount: -9100000 }] });
  await saveEntryForex(db, q.entries[0].id, { currency_id: c.id, foreign_amount: 100000, rate_e4: 910000 });
  const r = await forexGainLoss(db, '2025-04-01', '2026-03-31');
  assert.equal(r.realised, -100000);
  assert.equal(r.rows[0].foreign_balance, 0);
});

test('voucher classes expand into prefilled entries', async () => {
  const { db, ty, freight, forex, bank } = await setup();
  const cls = await createVoucherClass(db, {
    type_id: ty.get('Sales')!,
    name: 'Export Sales',
    lines: [
      { section: 'default', ledger_id: freight, side: 'Cr', calc: 'percent', value: 10000 },
      { section: 'additional', ledger_id: bank, side: 'Dr', calc: 'percent', value: 1250, remove_if_zero: true },
      { section: 'additional', ledger_id: forex, side: 'Dr', calc: 'fixed', value: 5000 },
      { section: 'additional', ledger_id: freight, side: 'Cr', calc: 'user', remove_if_zero: true },
    ],
  });
  const out = await expandVoucherClass(db, cls.id, 100000);
  assert.deepEqual(out.map((e) => e.amount), [-100000, 12500, 5000]);
  assert.equal(out[2].ledger, 'Forex Gain Or Loss');
  assert.equal((await expandVoucherClass(db, cls.id, 0)).length, 2);
  await assert.rejects(() => createVoucherClass(db, { type_id: ty.get('Sales')!, name: 'export sales', lines: [] }), /already exists/);
  const upd = await updateVoucherClass(db, cls.id, { type_id: ty.get('Sales')!, name: 'Export Sales', forex_adjust: true, lines: [{ section: 'forex', ledger_id: forex }] });
  assert.equal(upd.forex_adjust, 1);
  assert.equal(upd.lines.length, 1);
  assert.equal((await voucherClasses(db, ty.get('Sales')!)).length, 1);
  await deleteVoucherClass(db, cls.id);
  assert.equal((await voucherClasses(db)).length, 0);
  assert.equal(parsePercent('12.5%'), 1250);
  assert.equal(fmtPercent(1250), '12.5');
  assert.equal(fmtPercent(10000), '100');
});

test('voucher type options', async () => {
  const { db, ty } = await setup();
  const d = await voucherTypeOptions(db, ty.get('Payment')!);
  assert.equal(d.allow_narration, 1);
  assert.equal(d.use_effective_dates, 0);
  const o = await setVoucherTypeOptions(db, ty.get('Payment')!, { use_effective_dates: 1, print_after_saving: 1, allow_narration: 0, default_title: 'Pay' });
  assert.equal(o.use_effective_dates, 1);
  assert.equal(o.allow_narration, 0);
  assert.equal(o.default_title, 'Pay');
  assert.equal((await voucherTypeOptions(db, ty.get('Payment')!)).print_after_saving, 1);
  await assert.rejects(() => setVoucherTypeOptions(db, 9999, {}), /not found/);
});
