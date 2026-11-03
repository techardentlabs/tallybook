import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Books,
  addGroupCompany,
  alterGroupCompany,
  balanceSheet,
  buildEarlierPart,
  buildLaterPart,
  consolidateCompanies,
  createStockItem,
  emptyCompanyIndex,
  addCompanyEntry,
  ensureBanking,
  ensureStockExtras,
  exportMastersJson,
  exportVouchersJson,
  exportMastersXmlFor,
  exportVouchersXmlFor,
  groupSummary,
  importMastersXml2,
  importTallyXml,
  importVouchersXml2,
  isGroupEntry,
  openingBatches,
  parseCompanyIndex,
  parseTallyJson,
  readOnlyGroupDb,
  saveOpeningBatches,
  serializeCompanyIndex,
  splitInfo,
  stockSummary,
  tallyJsonToXml,
  verifyCompanyData,
  GROUP_READ_ONLY,
  type Db,
} from '../src/index.ts';
import { nodeDb } from '../src/node-adapter.ts';

async function company(name: string, opts: { stock?: boolean } = {}) {
  const books = new Books(nodeDb());
  await books.init();
  await ensureStockExtras(books.db);
  await ensureBanking(books.db);
  await books.createCompany({ name, fy_start: '2026-04-01' });
  const groups = await books.groups();
  const g = (n: string) => groups.find((x) => x.name === n)!.id;
  const ty = new Map((await books.voucherTypes()).map((t) => [t.name, t.id]));
  const mk = async (n: string, group: string, extra: object = {}) => (await books.createLedger({ name: n, group_id: g(group), ...extra })).id;
  const cash = (await books.ledgers()).find((l) => l.name === 'Cash')!.id;
  await books.updateLedger(cash, { opening: 100000_00 });
  const capital = await mk('Capital', 'Capital Account', { opening: -100000_00 - (opts.stock ? 1000_00 : 0) });
  const cust = await mk('Customer A', 'Sundry Debtors', { bill_by_bill: 1 });
  const sales = await mk('Sales', 'Sales Accounts');
  const purch = await mk('Purchase', 'Purchase Accounts');
  const bank = await mk('HDFC Bank', 'Bank Accounts');
  const rent = await mk('Rent', 'Indirect Expenses');
  const item = opts.stock ? (await createStockItem(books.db, { name: 'Widget', opening_qty: 10_000, opening_value: 1000_00, maintain_batches: 1 })).id : 0;
  return { books, ty, cash, capital, cust, sales, purch, bank, rent, item };
}

async function seedSplitCompany() {
  const c = await company('Alpha Traders', { stock: true });
  const { books, ty } = c;
  await saveOpeningBatches(books.db, c.item, [{ batch: 'B0', qty: 10_000 }]);
  await books.createVoucher({
    type_id: ty.get('Purchase')!, date: '2026-05-10',
    entries: [{ ledger_id: c.purch, amount: 5000_00 }, { ledger_id: c.cash, amount: -5000_00 }],
    stock: [{ item_id: c.item, godown_id: 1, ledger_id: c.purch, qty: 50_000, rate: 100_00, amount: 5000_00 }],
  });
  const sale = await books.createVoucher({
    type_id: ty.get('Sales')!, date: '2026-06-15',
    entries: [{ ledger_id: c.cust, amount: 3000_00, bills: [{ kind: 'new', name: 'INV-1', amount: 3000_00, due_date: '2026-07-15' }] }, { ledger_id: c.sales, amount: -3000_00 }],
    stock: [{ item_id: c.item, godown_id: 1, ledger_id: c.sales, qty: -20_000, rate: 150_00, amount: 3000_00 }],
  });
  const purchase = (await books.db.select<{ id: number }>("SELECT m.id FROM stock_movements m JOIN vouchers v ON v.id = m.voucher_id WHERE v.date = '2026-05-10'"))[0].id;
  await books.db.batch([{ sql: "INSERT INTO stockx_batches (movement_id, item_id, godown_id, batch, qty) VALUES (?, ?, 1, 'B1', 50000)", params: [purchase, c.item] }]);
  const saleMove = (await books.db.select<{ id: number }>('SELECT id FROM stock_movements WHERE voucher_id = ?', [sale.id]))[0].id;
  await books.db.batch([{ sql: "INSERT INTO stockx_batches (movement_id, item_id, godown_id, batch, qty) VALUES (?, ?, 1, 'B0', -10000), (?, ?, 1, 'B1', -10000)", params: [saleMove, c.item, saleMove, c.item] }]);
  const rcpt = await books.createVoucher({
    type_id: ty.get('Receipt')!, date: '2026-07-01',
    entries: [{ ledger_id: c.bank, amount: 1000_00 }, { ledger_id: c.cust, amount: -1000_00, bills: [{ kind: 'agst', name: 'INV-1', amount: -1000_00 }] }],
  });
  const pay = await books.createVoucher({ type_id: ty.get('Payment')!, date: '2026-08-01', entries: [{ ledger_id: c.rent, amount: 500_00 }, { ledger_id: c.bank, amount: -500_00 }] });
  await books.db.batch([
    { sql: "INSERT INTO bank_allocs (voucher_id, ledger_id, inst_no, bank_date) VALUES (?, ?, '1001', '2026-07-03')", params: [rcpt.id, c.bank] },
    { sql: "INSERT INTO bank_allocs (voucher_id, ledger_id, inst_no, bank_date) VALUES (?, ?, '1002', '')", params: [pay.id, c.bank] },
    { sql: 'INSERT INTO bank_config (ledger_id) VALUES (?)', params: [c.bank] },
  ]);
  await books.createVoucher({
    type_id: ty.get('Receipt')!, date: '2026-11-05',
    entries: [{ ledger_id: c.bank, amount: 2000_00 }, { ledger_id: c.cust, amount: -2000_00, bills: [{ kind: 'agst', name: 'INV-1', amount: -2000_00 }] }],
  });
  await books.createVoucher({
    type_id: ty.get('Sales')!, date: '2026-12-01',
    entries: [{ ledger_id: c.cash, amount: 900_00 }, { ledger_id: c.sales, amount: -900_00 }],
    stock: [{ item_id: c.item, godown_id: 1, ledger_id: c.sales, qty: -5_000, rate: 180_00, amount: 900_00 }],
  });
  return c;
}

test('verify data reports no issues for consistent books', async () => {
  const c = await seedSplitCompany();
  assert.deepEqual(await verifyCompanyData(c.books.db), []);
  const info = await splitInfo(c.books.db);
  assert.equal(info.vouchers, 6);
  assert.equal(info.suggested, '2027-04-01');
});

test('split from date carries closing balances, bills, stock, batches and unreconciled bank entries', async () => {
  const c = await seedSplitCompany();
  const src = c.books.db;
  const before = await src.select<{ n: number }>('SELECT COUNT(*) AS n FROM vouchers');
  const fullTb = await groupSummary(src, '2026-04-01', '2027-03-31', null);
  const fullBs = await balanceSheet(src, '2026-04-01', '2027-03-31');
  const dest = nodeDb();
  const { part, check } = await buildLaterPart(src, dest, '2026-10-01');
  assert.equal(part.name, 'Alpha Traders (from 1-Oct-2026)');
  assert.equal(part.vouchers, 2);
  assert.equal(part.removed, 4);
  assert.equal(check.difference, 0);
  assert.deepEqual(check.mismatches, []);
  assert.equal(check.first_closing, check.second_opening);
  assert.equal((await src.select<{ n: number }>('SELECT COUNT(*) AS n FROM vouchers'))[0].n, before[0].n);

  const later = new Books(dest);
  const co = (await later.company())!;
  assert.equal(co.fy_start, '2026-10-01');
  assert.equal(co.books_from, '2026-10-01');
  const led = new Map((await later.ledgers()).map((l) => [l.name, l]));
  assert.equal(led.get('Customer A')!.opening, 2000_00);
  assert.equal(led.get('Cash')!.opening, 95000_00);
  assert.equal(led.get('HDFC Bank')!.opening, 500_00);
  assert.equal(led.get('Sales')!.opening, 0);
  assert.equal(led.get('Rent')!.opening, 0);
  const pl = led.get('Profit & Loss A/c')!;
  const plA = await later.ledger(pl.id);
  assert.equal(plA!.opening, -500_00);
  assert.equal(check.profit_transferred, 500_00);
  assert.equal(check.stock_carried, 4000_00);
  const cust = (await later.ledger(led.get('Customer A')!.id))!;
  assert.deepEqual(cust.opening_bills.map((b) => [b.name, b.amount, b.due_date]), [['INV-1', 2000_00, '2026-07-15']]);

  const stock = await stockSummary(dest, '2026-10-01', '2026-10-01');
  assert.equal(stock.rows[0].opening_qty, 40_000);
  const batches = await openingBatches(dest, stock.rows[0].item_id);
  assert.deepEqual(batches.map((b) => [b.batch, b.qty]), [['B1', 40_000]]);

  const brs = await dest.select<{ amount: number; bank_date: string }>('SELECT amount, bank_date FROM bank_opening_brs ORDER BY date');
  assert.deepEqual(brs.map((b) => b.amount), [-500_00]);

  const laterTb = await groupSummary(dest, '2026-10-01', '2027-09-30', null);
  assert.equal(laterTb.total.closing, fullTb.total.closing);
  const laterBs = await balanceSheet(dest, '2026-10-01', '2027-09-30');
  assert.equal(laterBs.totalAssets, fullBs.totalAssets);
  assert.equal(laterBs.totalLiabilities, fullBs.totalLiabilities);
  assert.deepEqual(await verifyCompanyData(dest), []);
});

test('split before date keeps the earlier vouchers and reconciles with the later part', async () => {
  const c = await seedSplitCompany();
  const earlierDb = nodeDb();
  const laterDb = nodeDb();
  const earlier = await buildEarlierPart(c.books.db, earlierDb, '2026-10-01');
  const later = await buildLaterPart(c.books.db, laterDb, '2026-10-01');
  assert.equal(earlier.part.vouchers, 4);
  assert.equal(earlier.part.name, 'Alpha Traders (upto 30-Sep-2026)');
  assert.equal(earlier.closing, later.check.second_opening);
  await assert.rejects(buildLaterPart(c.books.db, nodeDb(), '2026-04-01'), /after the books beginning date/);
  await assert.rejects(buildLaterPart(c.books.db, laterDb, '2026-10-01'), /already has data/);
});

async function groupMember(name: string, saleAmount: number) {
  const c = await company(name);
  await c.books.createVoucher({ type_id: c.ty.get('Sales')!, date: '2026-06-01', entries: [{ ledger_id: c.cash, amount: saleAmount }, { ledger_id: c.sales, amount: -saleAmount }] });
  await c.books.createVoucher({ type_id: c.ty.get('Payment')!, date: '2026-06-02', entries: [{ ledger_id: c.rent, amount: 100_00 }, { ledger_id: c.cash, amount: -100_00 }] });
  return c;
}

test('group company consolidates member companies read-only', async () => {
  const a = await groupMember('North Co', 1000_00);
  const b = await groupMember('South Co', 2500_00);
  const target = nodeDb();
  const rep = await consolidateCompanies(target, 'Group Co', [
    { id: '100000', name: 'North Co', db: a.books.db },
    { id: '100001', name: 'South Co', db: b.books.db },
  ]);
  assert.equal(rep.vouchers, 4);
  const books = new Books(readOnlyGroupDb(target));
  assert.equal((await books.company())!.name, 'Group Co');
  const led = new Map((await books.ledgers()).map((l) => [l.name, l]));
  assert.equal(led.get('Cash')!.opening, 200000_00);
  assert.equal(led.get('Capital')!.opening, -200000_00);
  const tb = await groupSummary(books.db, '2026-04-01', '2027-03-31', null);
  const ta = await groupSummary(a.books.db, '2026-04-01', '2027-03-31', null);
  const tbb = await groupSummary(b.books.db, '2026-04-01', '2027-03-31', null);
  for (const row of tb.rows) {
    const x = ta.rows.find((r) => r.name === row.name)!;
    const y = tbb.rows.find((r) => r.name === row.name)!;
    assert.equal(row.closing, x.closing + y.closing, row.name);
  }
  const bs = await balanceSheet(books.db, '2026-04-01', '2027-03-31');
  assert.equal(bs.net, 3300_00);
  await assert.rejects(
    books.createVoucher({ type_id: a.ty.get('Payment')!, date: '2026-06-03', entries: [{ ledger_id: led.get('Rent')!.id, amount: 1 }, { ledger_id: led.get('Cash')!.id, amount: -1 }] }),
    (e: Error) => e.message === GROUP_READ_ONLY
  );
  assert.equal((await a.books.db.select<{ n: number }>('SELECT COUNT(*) AS n FROM vouchers'))[0].n, 2);
});

test('group company entries in the company list', () => {
  let idx = emptyCompanyIndex();
  idx = addCompanyEntry(idx, { id: '100000', name: 'North Co', file: 'companies/100000.db', last_opened: null });
  idx = addCompanyEntry(idx, { id: '100001', name: 'South Co', file: 'companies/100001.db', last_opened: null });
  assert.throws(() => addGroupCompany(idx, { id: '100002', name: 'Group', file: 'companies/100002.db', members: ['100000'] }), /at least 2/);
  idx = addGroupCompany(idx, { id: '100002', name: 'Group', file: 'companies/100002.db', members: ['100000', '100001'] });
  const back = parseCompanyIndex(serializeCompanyIndex(idx))!;
  const g = back.companies.find((c) => c.id === '100002')!;
  assert.ok(isGroupEntry(g));
  assert.deepEqual(g.members, ['100000', '100001']);
  assert.throws(() => addGroupCompany(back, { id: '100003', name: 'G2', file: 'companies/100003.db', members: ['100000', '100002'] }), /Group Company and cannot be a member/);
  const renamed = alterGroupCompany(back, '100002', { name: 'Group Two' });
  assert.equal(renamed.companies.find((c) => c.id === '100002')!.name, 'Group Two');
});

async function freshTarget(): Promise<Books> {
  const books = new Books(nodeDb());
  await books.init();
  await ensureStockExtras(books.db);
  await books.createCompany({ name: 'Copy Co', fy_start: '2026-04-01' });
  return books;
}

async function importJson(books: Books, text: string, kind: 'masters' | 'vouchers') {
  const { xml } = tallyJsonToXml(text);
  if (kind === 'masters') {
    const a = await importTallyXml(books, xml);
    const b = await importMastersXml2(books, xml);
    return [...a.errors, ...b.errors];
  }
  return (await importVouchersXml2(books, xml)).errors;
}

test('JSON export uses the TallyPrime JSONEx structure and round-trips', async () => {
  const c = await seedSplitCompany();
  const masters = await exportMastersJson(c.books);
  const parsed = JSON.parse(masters);
  assert.deepEqual(parsed.static_variables[0], { name: 'svMstImportFormat', value: 'jsonex' });
  const ledger = parsed.tallymessage.find((m: { metadata: { type: string; name: string } }) => m.metadata.type === 'Ledger' && m.metadata.name === 'Customer A');
  assert.equal(ledger.parent, 'Sundry Debtors');
  assert.equal(ledger.isbillwiseon, true);
  const item = parsed.tallymessage.find((m: { metadata: { type: string } }) => m.metadata.type === 'Stock Item');
  assert.equal(item.metadata.name, 'Widget');
  const vouchers = await exportVouchersJson(c.books, '2026-04-01', '2027-03-31');
  const pv = JSON.parse(vouchers);
  assert.equal(pv.static_variables[0].name, 'svVchImportFormat');
  const sale = pv.tallymessage.find((m: { vouchertypename: string; date: string }) => m.vouchertypename === 'Sales' && m.date === '20260615');
  assert.equal(sale.metadata.type, 'Voucher');
  assert.ok(Array.isArray(sale.allinventoryentries) || Array.isArray(sale.allledgerentries));

  const target = await freshTarget();
  assert.deepEqual(await importJson(target, masters, 'masters'), []);
  assert.deepEqual(await importJson(target, vouchers, 'vouchers'), []);
  const a = await groupSummary(c.books.db, '2026-04-01', '2027-03-31', null);
  const b = await groupSummary(target.db, '2026-04-01', '2027-03-31', null);
  for (const row of a.rows) assert.equal(b.rows.find((r) => r.name === row.name)?.closing ?? 0, row.closing, row.name);
});

test('JSON import accepts the TallyPrime sample payloads', async () => {
  const books = await freshTarget();
  const ledger = JSON.stringify({
    static_variables: [{ name: 'svMstImportFormat', value: 'jsonex' }, { name: 'svCurrentCompany', value: 'Bhrama Enterprises' }],
    tallymessage: [{ metadata: { type: 'Ledger', action: 'create', name: 'Bank Of Baroda' }, name: 'Bank Of Baroda', parent: 'Bank Accounts' }],
  });
  assert.equal(parseTallyJson(ledger).company, 'Bhrama Enterprises');
  assert.deepEqual(await importJson(books, ledger, 'masters'), []);
  const typed = JSON.stringify({
    status: '1',
    data: {
      collection: [
        { metadata: { type: 'Ledger', name: 'Abc Party', reservedname: '' }, parent: { type: 'String', value: 'Sundry Debtors' }, languagename: [{ name: [{ metadata: true, type: 'String' }, 'Abc Party'], languageid: { type: 'Number', value: ' 1033' } }] },
      ],
    },
  });
  assert.deepEqual(await importJson(books, typed, 'masters'), []);
  const voucher = JSON.stringify({
    static_variables: [{ name: 'svVchImportFormat', value: 'jsonex' }],
    tallymessage: [
      {
        metadata: { type: 'Voucher', vchtype: 'Receipt', action: 'Create', objview: 'Accounting Voucher View' },
        date: '20260701', vouchertypename: 'Receipt', vouchernumber: '7',
        allledgerentries: [
          { ledgername: 'Bank Of Baroda', isdeemedpositive: true, amount: '-1500.00' },
          { ledgername: 'Abc Party', isdeemedpositive: false, amount: '1500.00' },
        ],
      },
    ],
  });
  assert.deepEqual(await importJson(books, voucher, 'vouchers'), []);
  const led = new Map((await books.ledgers()).map((l) => [l.name, l]));
  assert.equal(led.get('Bank Of Baroda')!.group_name, 'Bank Accounts');
  assert.equal(led.get('Abc Party')!.group_name, 'Sundry Debtors');
  const tb = await groupSummary(books.db, '2026-04-01', '2027-03-31', led.get('Bank Of Baroda')!.group_id);
  assert.equal(tb.rows.find((r) => r.name === 'Bank Of Baroda')!.closing, 1500_00);
  assert.throws(() => parseTallyJson('{"x":1}'), /no masters or vouchers/);
});

test('XML export through the same pipeline, dependent masters and closing balance as opening', async () => {
  const c = await seedSplitCompany();
  const target = await freshTarget();
  const xml = await exportVouchersXmlFor(c.books, '2026-04-01', '2026-09-30', { dependentMasters: true, type: 'Accounting Vouchers' });
  assert.match(xml, /<LEDGER NAME="Customer A" ACTION="Create">/);
  const a = await importTallyXml(target, xml);
  const b = await importMastersXml2(target, xml);
  assert.deepEqual([...a.errors, ...b.errors], []);
  const v = await importVouchersXml2(target, xml);
  assert.deepEqual(v.errors, []);
  assert.equal(v.created.vouchers + a.created.vouchers, 4);
  const mx = await exportMastersXmlFor(c.books, { type: 'Inventory Masters' });
  assert.match(mx, /<STOCKITEM NAME="Widget"/);
  assert.doesNotMatch(mx, /<LEDGER /);
  const carried = JSON.parse(await exportMastersJson(c.books, { closingAsOpening: { asOn: '2026-09-30' } }));
  const cust = carried.tallymessage.find((m: { metadata: { type: string; name: string } }) => m.metadata.type === 'Ledger' && m.metadata.name === 'Customer A');
  assert.equal(cust.openingbalance, '-2000.00');
  assert.deepEqual(cust.billallocations.map((x: { name: string; amount: string }) => [x.name, x.amount]), [['INV-1', '-2000.00']]);
  const pl = carried.tallymessage.find((m: { metadata: { type: string; name: string } }) => m.metadata.name === 'Profit & Loss A/c');
  assert.equal(pl?.openingbalance ?? '500.00', '500.00');
});

export type { Db };
