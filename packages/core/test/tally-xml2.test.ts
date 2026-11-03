import test from 'node:test';
import assert from 'node:assert/strict';
import { Books, costCentres, createCostCategory, createCostCentre, createGodown, createStockCategory, createStockGroup, createStockItem, createUnit, ensureCosting, ensureStockVoucherTypes, exportMastersXml, godowns, importTallyXml, saveEntryAllocations, stockItems, stockGroups, units, voucherAllocations } from '../src/index.ts';
import { nodeDb } from '../src/node-adapter.ts';
import { EXCHANGE_SCHEMA, exportMastersXml2, exportVouchersXml2, importMastersXml2, importVouchersXml2 } from '../src/tally-xml2.ts';

async function fresh(name: string) {
  const books = new Books(nodeDb());
  await books.init();
  await books.createCompany({ name, fy_start: '2026-04-01', state: 'Maharashtra' });
  await ensureCosting(books.db);
  return books;
}

async function source() {
  const books = await fresh('Source Co');
  await ensureStockVoucherTypes(books.db);
  const groups = await books.groups();
  const gid = (n: string) => groups.find((x) => x.name === n)!.id;
  await createUnit(books.db, { symbol: 'Kg', formal_name: 'Kilograms', decimals: 3 });
  const dg = await createGodown(books.db, { name: 'Delhi Godown' });
  await createGodown(books.db, { name: 'Delhi Annex', parent_id: dg.id });
  const sg = await createStockGroup(books.db, { name: 'Stationery', alias: 'Stn' });
  await createStockGroup(books.db, { name: 'Writing', parent_id: sg.id });
  const cat = await createStockCategory(books.db, { name: 'Retail' });
  await createStockItem(books.db, { name: 'Pen', alias: 'PN', group_id: sg.id, category_id: cat.id, unit_id: 1, opening_qty: 100000, opening_value: 3000000, hsn_sac: '9608', rate_bp: 1800, costing_method: 'FIFO', maintain_batches: 1 });
  await createStockItem(books.db, { name: 'Rice', unit_id: (await units(books.db)).find((u) => u.symbol === 'Kg')!.id });
  const cc = await createCostCategory(books.db, { name: 'Region', alloc_revenue: true, alloc_non_revenue: false });
  const north = await createCostCentre(books.db, { name: 'North', category_id: cc.id });
  await createCostCentre(books.db, { name: 'North-Delhi', category_id: cc.id, parent_id: north.id });
  const primaryCentre = await createCostCentre(books.db, { name: 'Rahul' });
  await books.createVoucherType({ name: 'Cash Sales', parent: 'Sales', numbering: 'manual', prevent_duplicates: 0 });
  const mk = async (name: string, group: string, extra: object = {}) => (await books.createLedger({ name, group_id: gid(group), ...extra })).id;
  const cust = await mk('Customer', 'Sundry Debtors', { bill_by_bill: 1 });
  const sales = await mk('Sales', 'Sales Accounts');
  const purch = await mk('Purchases', 'Purchase Accounts');
  const supp = await mk('Supplier', 'Sundry Creditors');
  const tax = await mk('Output GST', 'Duties & Taxes');
  const types = new Map((await books.voucherTypes()).map((t) => [t.name, t.id]));
  const delhi = (await godowns(books.db)).find((g) => g.name === 'Delhi Godown')!.id;
  const pen = (await stockItems(books.db)).find((i) => i.name === 'Pen')!.id;
  const sale = await books.createVoucher({
    type_id: types.get('Sales')!,
    date: '2026-04-10',
    reference: 'INV-1',
    narration: 'First sale',
    party_id: cust,
    entries: [
      { ledger_id: cust, amount: 1180_00, bills: [{ kind: 'new', name: 'INV-1', amount: 1180_00 }] },
      { ledger_id: sales, amount: -1000_00 },
      { ledger_id: tax, amount: -180_00 },
    ],
    stock: [{ item_id: pen, godown_id: delhi, ledger_id: sales, qty: -5000, rate: 200_00, amount: 1000_00 }],
  });
  await saveEntryAllocations(books.db, sale.entries[1].id, [{ cost_centre_id: primaryCentre.id, amount: -1000_00 }]);
  await books.createVoucher({
    type_id: types.get('Purchase')!,
    date: '2026-04-11',
    party_id: supp,
    entries: [
      { ledger_id: purch, amount: 600_00 },
      { ledger_id: supp, amount: -600_00 },
    ],
    stock: [{ item_id: pen, godown_id: 1, ledger_id: purch, qty: 3000, rate: 200_00, amount: 600_00 }],
  });
  await books.createVoucher({ type_id: types.get('Stock Journal')!, date: '2026-04-12', entries: [], stock: [{ item_id: pen, godown_id: delhi, qty: 1000, rate: 200_00, amount: 200_00 }] });
  return books;
}

async function target(src: Books) {
  const books = await fresh('Target Co');
  const rep = await importTallyXml(books, await exportMastersXml(src));
  assert.equal(rep.errors.length, 0);
  return books;
}

test('schema export is empty and exported masters carry the documented tags', async () => {
  assert.deepEqual(EXCHANGE_SCHEMA, []);
  const src = await source();
  const xml = await exportMastersXml2(src);
  for (const tag of ['<UNIT ', '<GODOWN ', '<STOCKGROUP ', '<STOCKCATEGORY ', '<STOCKITEM ', '<COSTCATEGORY ', '<COSTCENTRE ', '<VOUCHERTYPE ', '<BASEUNITS>', '<OPENINGBALANCE>100 Nos', '<OPENINGVALUE>-30000.00', '<OPENINGRATE>300.00/Nos', '<ALLOCATEREVENUE>Yes']) {
    assert.ok(xml.includes(tag), tag);
  }
});

test('masters round trip into a fresh company, dry run writes nothing', async () => {
  const src = await source();
  const xml = await exportMastersXml2(src);
  const dst = await fresh('Dst Co');
  const dry = await importMastersXml2(dst, xml, { dryRun: true });
  assert.equal(dry.errors.length, 0);
  assert.equal(dry.created.stock_items, 2);
  assert.equal((await stockItems(dst.db)).length, 0);
  const rep = await importMastersXml2(dst, xml);
  assert.deepEqual(rep.errors, []);
  assert.equal(rep.created.units, 1);
  assert.equal(rep.created.godowns, 2);
  assert.equal(rep.created.stock_groups, 2);
  assert.equal(rep.created.stock_categories, 1);
  assert.equal(rep.created.cost_categories, 1);
  assert.equal(rep.created.cost_centres, 3);
  assert.equal(rep.created.voucher_types, 1);
  const pen = (await stockItems(dst.db)).find((i) => i.name === 'Pen')!;
  assert.equal(pen.opening_qty, 100000);
  assert.equal(pen.opening_value, 3000000);
  assert.equal(pen.hsn_sac, '9608');
  assert.equal(pen.rate_bp, 1800);
  assert.equal(pen.costing_method, 'FIFO');
  assert.equal(pen.maintain_batches, 1);
  assert.equal(pen.alias, 'PN');
  assert.equal((await stockGroups(dst.db)).find((g) => g.name === 'Writing')!.parent_id, (await stockGroups(dst.db)).find((g) => g.name === 'Stationery')!.id);
  const centres = await costCentres(dst.db);
  assert.equal(centres.find((c) => c.name === 'North-Delhi')!.parent, 'North');
  assert.equal(centres.find((c) => c.name === 'North')!.category, 'Region');
  const kg = (await units(dst.db)).find((u) => u.symbol === 'Kg')!;
  assert.equal(kg.decimals, 3);
  assert.equal(kg.formal_name, 'Kilograms');
  const again = await importMastersXml2(dst, xml);
  assert.equal(again.created.stock_items + again.created.godowns + again.created.cost_centres, 0);
  assert.ok(again.skipped.masters > 0);
});

test('missing unit and parent are reported as errors', async () => {
  const dst = await fresh('Err Co');
  const xml = `<ENVELOPE><BODY><DATA><TALLYMESSAGE>
    <STOCKITEM NAME="Bolt"><PARENT>Ghost Group</PARENT><BASEUNITS>Nos</BASEUNITS></STOCKITEM>
    <STOCKITEM NAME="Nut"><BASEUNITS>Zzz</BASEUNITS></STOCKITEM>
    <GODOWN NAME="Kid"><PARENT>Nowhere</PARENT></GODOWN>
    <CURRENCY NAME="USD"><MAILINGNAME>USD</MAILINGNAME></CURRENCY>
  </TALLYMESSAGE></DATA></BODY></ENVELOPE>`;
  const rep = await importMastersXml2(dst, xml);
  assert.equal(rep.errors.length, 3);
  assert.ok(rep.errors.every((e) => /Referenced master is missing/.test(e.message)));
  assert.equal(rep.warnings.length, 1);
});

test('vouchers with inventory, batch, accounting and cost allocations round trip', async () => {
  const src = await source();
  const dst = await target(src);
  await importMastersXml2(dst, await exportMastersXml2(src));
  const xml = await exportVouchersXml2(src, '2026-04-01', '2027-03-31');
  for (const tag of ['<ALLINVENTORYENTRIES.LIST>', '<BATCHALLOCATIONS.LIST>', '<ACCOUNTINGALLOCATIONS.LIST>', '<STOCKITEMNAME>Pen', '<ACTUALQTY>5 Nos', '<RATE>200.00/Nos', '<COSTCENTREALLOCATIONS.LIST>', '<GODOWNNAME>Delhi Godown', '<ISINVOICE>Yes']) {
    assert.ok(xml.includes(tag), tag);
  }
  const dry = await importVouchersXml2(dst, xml, { dryRun: true });
  assert.deepEqual(dry.errors, []);
  assert.equal(dry.created.vouchers, 3);
  assert.equal(await dst.count('vouchers'), 0);
  const rep = await importVouchersXml2(dst, xml);
  assert.deepEqual(rep.errors, []);
  assert.equal(rep.created.vouchers, 3);
  assert.equal(rep.totals.stock_lines, 3);
  const ids = (await dst.db.select<{ id: number }>('SELECT id FROM vouchers ORDER BY date, id')).map((r) => r.id);
  const sale = (await dst.voucher(ids[0]))!;
  assert.equal(sale.type, 'Sales');
  assert.equal(sale.reference, 'INV-1');
  assert.deepEqual(sale.entries.map((e) => [e.ledger, e.amount]).sort(), [['Customer', 118000], ['Output GST', -18000], ['Sales', -100000]]);
  assert.equal(sale.entries.find((e) => e.ledger === 'Customer')!.bills[0].name, 'INV-1');
  assert.equal(sale.stock.length, 1);
  assert.equal(sale.stock[0].qty, -5000);
  assert.equal(sale.stock[0].amount, 100000);
  assert.equal(sale.stock[0].rate, 20000);
  assert.equal(sale.stock[0].ledger_id, sale.entries.find((e) => e.ledger === 'Sales')!.ledger_id);
  const delhi = (await godowns(dst.db)).find((g) => g.name === 'Delhi Godown')!.id;
  assert.equal(sale.stock[0].godown_id, delhi);
  const alloc = await voucherAllocations(dst.db, sale.id);
  const flat = [...alloc.values()].flat();
  assert.equal(flat.length, 1);
  assert.equal(flat[0].cost_centre, 'Rahul');
  assert.equal(flat[0].amount, -100000);
  const purchase = (await dst.voucher(ids[1]))!;
  assert.equal(purchase.stock[0].qty, 3000);
  const journal = (await dst.voucher(ids[2]))!;
  assert.equal(journal.entries.length, 0);
  assert.equal(journal.stock[0].qty, 1000);
  const again = await importVouchersXml2(dst, xml);
  assert.equal(again.created.vouchers, 0);
  assert.equal(again.skipped.vouchers, 3);
});

test('voucher import reports unknown stock items and unbalanced vouchers', async () => {
  const src = await source();
  const dst = await target(src);
  const xml = `<ENVELOPE><BODY><DATA><TALLYMESSAGE>
    <VOUCHER VCHTYPE="Sales"><DATE>20260410</DATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><VOUCHERNUMBER>1</VOUCHERNUMBER>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Customer</LEDGERNAME><AMOUNT>-100.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Ghost</STOCKITEMNAME><ACTUALQTY>1 Nos</ACTUALQTY><AMOUNT>100.00</AMOUNT></ALLINVENTORYENTRIES.LIST>
    </VOUCHER>
    <VOUCHER VCHTYPE="Sales"><DATE>20260410</DATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><VOUCHERNUMBER>2</VOUCHERNUMBER>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Customer</LEDGERNAME><AMOUNT>-100.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Sales</LEDGERNAME><AMOUNT>90.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    </VOUCHER>
  </TALLYMESSAGE></DATA></BODY></ENVELOPE>`;
  const rep = await importVouchersXml2(dst, xml);
  assert.equal(rep.errors.length, 2);
  assert.match(rep.errors[0].message, /stock item/);
  assert.match(rep.errors[1].message, /differ/);
  assert.equal(rep.created.vouchers, 0);
});
