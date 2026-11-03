import test from 'node:test';
import assert from 'node:assert/strict';
import { Books, exportMastersXml, exportVouchersXml, groupSummary, importTallyXml, outstandings, parseXml, profitAndLoss } from '../src/index.ts';
import { nodeDb } from '../src/node-adapter.ts';

async function fresh(fy = '2026-04-01') {
  const books = new Books(nodeDb());
  await books.init();
  await books.createCompany({ name: 'Target Co', fy_start: fy });
  return books;
}

test('parser handles entities, CDATA, comments and stray control entities', () => {
  const n = parseXml('<?xml version="1.0"?><A x="1 &amp; 2"><!-- c --><B>Tom &amp; Jerry&#4;</B><C><![CDATA[<raw>]]></C><D/></A>');
  assert.equal(n.attrs.x, '1 & 2');
  assert.equal(n.children[0].text, 'Tom & Jerry');
  assert.equal(n.children[1].text, '<raw>');
  assert.equal(n.children.length, 3);
  assert.throws(() => parseXml('<A><B></A>'));
});

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>All Masters</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>Src Co</SVCURRENTCOMPANY></STATICVARIABLES></DESC><DATA>
<TALLYMESSAGE xmlns:UDF="TallyUDF">
<GROUP NAME="Retail Customers" ACTION="Create"><PARENT>Sundry Debtors</PARENT><GUID>g-1</GUID></GROUP>
<LEDGER NAME="Ram &amp; Sons" ACTION="Create"><GUID>l-1</GUID><PARENT>Retail Customers</PARENT>
 <OPENINGBALANCE>-10000.00</OPENINGBALANCE><ISBILLWISEON>Yes</ISBILLWISEON><BILLCREDITPERIOD>30 Days</BILLCREDITPERIOD>
 <PARTYGSTIN>27ABCDE1234F1Z5</PARTYGSTIN>
 <LEDMAILINGDETAILS.LIST><ADDRESS.LIST><ADDRESS>12 Main Road</ADDRESS><ADDRESS>Pune</ADDRESS></ADDRESS.LIST><STATE>Maharashtra</STATE><PINCODE>411001</PINCODE></LEDMAILINGDETAILS.LIST>
 <BILLALLOCATIONS.LIST><NAME>OLD-1</NAME><BILLDATE>20260301</BILLDATE><AMOUNT>-10000.00</AMOUNT></BILLALLOCATIONS.LIST>
</LEDGER>
<LEDGER NAME="HDFC Bank"><PARENT>Bank Accounts</PARENT><OPENINGBALANCE>-50000.00</OPENINGBALANCE></LEDGER>
<LEDGER NAME="Capital"><PARENT>Capital Account</PARENT><OPENINGBALANCE>60000.00</OPENINGBALANCE></LEDGER>
<LEDGER NAME="Item Sales"><PARENT>Sales Accounts</PARENT></LEDGER>
<LEDGER NAME="Output CGST"><PARENT>Duties &amp; Taxes</PARENT></LEDGER>
<VOUCHER VCHTYPE="Sales" ACTION="Create"><DATE>20260510</DATE><GUID>v-1</GUID><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><VOUCHERNUMBER>1</VOUCHERNUMBER>
 <PARTYLEDGERNAME>Ram &amp; Sons</PARTYLEDGERNAME><NARRATION>Goods&#4; sold</NARRATION>
 <ALLLEDGERENTRIES.LIST><LEDGERNAME>Ram &amp; Sons</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-11800.00</AMOUNT>
  <BILLALLOCATIONS.LIST><NAME>INV-1</NAME><BILLTYPE>New Ref</BILLTYPE><AMOUNT>-11800.00</AMOUNT></BILLALLOCATIONS.LIST></ALLLEDGERENTRIES.LIST>
 <ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Widget</STOCKITEMNAME><ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>Item Sales</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>10000.00</AMOUNT></ACCOUNTINGALLOCATIONS.LIST></ALLINVENTORYENTRIES.LIST>
 <ALLLEDGERENTRIES.LIST><LEDGERNAME>Output CGST</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>1800.00</AMOUNT></ALLLEDGERENTRIES.LIST>
</VOUCHER>
<VOUCHER VCHTYPE="Receipt" ACTION="Create"><DATE>20260520</DATE><GUID>v-2</GUID><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><VOUCHERNUMBER>1</VOUCHERNUMBER>
 <ALLLEDGERENTRIES.LIST><LEDGERNAME>HDFC Bank</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-5000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
 <ALLLEDGERENTRIES.LIST><LEDGERNAME>Ram &amp; Sons</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>5000.00</AMOUNT>
  <BILLALLOCATIONS.LIST><NAME>INV-1</NAME><BILLTYPE>Agst Ref</BILLTYPE><AMOUNT>5000.00</AMOUNT></BILLALLOCATIONS.LIST></ALLLEDGERENTRIES.LIST>
</VOUCHER>
<VOUCHER VCHTYPE="Journal" ACTION="Create"><DATE>20260601</DATE><GUID>v-bad</GUID><VOUCHERNUMBER>1</VOUCHERNUMBER>
 <ALLLEDGERENTRIES.LIST><LEDGERNAME>Capital</LEDGERNAME><AMOUNT>-100.00</AMOUNT></ALLLEDGERENTRIES.LIST>
 <ALLLEDGERENTRIES.LIST><LEDGERNAME>Ghost</LEDGERNAME><AMOUNT>100.00</AMOUNT></ALLLEDGERENTRIES.LIST>
</VOUCHER>
</TALLYMESSAGE></DATA></BODY></ENVELOPE>`;

test('imports a Tally-style file with dry run, errors and idempotency', async () => {
  const books = await fresh();

  const dry = await importTallyXml(books, SAMPLE, { dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(await books.count('vouchers'), 0);
  assert.equal(dry.created.vouchers, 2);
  assert.equal(dry.errors.length, 1);
  assert.match(dry.errors[0].message, /Ghost/);

  const real = await importTallyXml(books, SAMPLE);
  assert.equal(real.created.groups, 1);
  assert.equal(real.created.ledgers, 5);
  assert.equal(real.created.vouchers, 2);
  assert.ok(real.warnings.some((w) => /Item/.test(w)));

  const ram = (await books.ledgers()).find((l) => l.name === 'Ram & Sons')!;
  const full = (await books.ledger(ram.id))!;
  assert.equal(full.opening, 10000_00);
  assert.equal(full.group_name, 'Retail Customers');
  assert.equal(full.address, '12 Main Road\nPune');
  assert.equal(full.credit_days, 30);
  assert.equal(full.gstin, '27ABCDE1234F1Z5');
  assert.equal(full.opening_bills[0].name, 'OLD-1');

  const v = (await books.voucher(1))!;
  assert.equal(v.narration, 'Goods sold');
  assert.equal(v.entries.length, 3);

  const tb = await groupSummary(books.db, '2026-04-01', '2027-03-31', null);
  assert.equal(tb.total.closing, 0);
  const out = await outstandings(books.db, 'receivable', '2026-07-01', '2026-04-01');
  assert.equal(out.ledgers[0].total, 16800_00);
  assert.equal(out.ledgers[0].bills.find((b) => b.name === 'INV-1')!.pending, 6800_00);

  const again = await importTallyXml(books, SAMPLE);
  assert.equal(again.created.vouchers, 0);
  assert.equal(again.skipped.vouchers, 2);
  assert.equal(await books.count('vouchers'), 2);
  assert.equal(again.created.ledgers, 0);
});

test('export then import into a fresh company reproduces the books', async () => {
  const src = await fresh();
  await importTallyXml(src, SAMPLE);
  const masters = await exportMastersXml(src);
  const vouchers = await exportVouchersXml(src, '2026-04-01', '2027-03-31');
  assert.match(masters, /<OPENINGBALANCE>-10000\.00<\/OPENINGBALANCE>/);
  assert.match(vouchers, /<DATE>20260510<\/DATE>/);

  const dst = await fresh();
  const m = await importTallyXml(dst, masters);
  assert.equal(m.errors.length, 0);
  const v = await importTallyXml(dst, vouchers);
  assert.equal(v.errors.length, 0, JSON.stringify(v.errors));
  assert.equal(v.created.vouchers, 2);

  const a = await profitAndLoss(src.db, '2026-04-01', '2027-03-31');
  const b = await profitAndLoss(dst.db, '2026-04-01', '2027-03-31');
  assert.deepEqual(a.net, b.net);
  const ta = await groupSummary(src.db, '2026-04-01', '2027-03-31', null);
  const tb = await groupSummary(dst.db, '2026-04-01', '2027-03-31', null);
  const stripRows = (t: typeof ta) => t.rows.map(({ id: _id, ...rest }) => rest);
  assert.deepEqual(stripRows(ta), stripRows(tb));
  const oa = await outstandings(src.db, 'receivable', '2026-07-01', '2026-04-01');
  const ob = await outstandings(dst.db, 'receivable', '2026-07-01', '2026-04-01');
  const strip = (o: typeof oa) => ({ ...o, ledgers: o.ledgers.map(({ ledger_id: _id, ...rest }) => rest) });
  assert.deepEqual(strip(oa), strip(ob));
});

test('vouchers outside the books period are reported, not imported', async () => {
  const books = await fresh('2025-04-01');
  const r = await importTallyXml(books, SAMPLE);
  assert.equal(r.created.vouchers, 0);
  assert.ok(r.errors.some((e) => /outside the books period/.test(e.message)));
});
