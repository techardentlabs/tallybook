import test from 'node:test';
import assert from 'node:assert/strict';
import { Books, gstSplit, gstr1, gstr1Json, gstr3b, gstinChecksum, isValidGstin, planGstInvoice, stateCode, taxLedgerName } from '../src/index.ts';
import { nodeDb } from '../src/node-adapter.ts';

const withCheck = (first14: string) => first14 + gstinChecksum(first14);

test('GSTIN validation', () => {
  assert.equal(isValidGstin('27AAPFU0939F1ZV'), true);
  assert.equal(isValidGstin('27AAPFU0939F1ZX'), false);
  assert.equal(isValidGstin('99AAPFU0939F1ZV'), false);
  assert.equal(isValidGstin('short'), false);
  assert.equal(isValidGstin(withCheck('29ABCDE1234F1Z')), true);
  assert.equal(stateCode('Maharashtra'), '27');
  assert.equal(stateCode('29'), '29');
});

test('tax split and ledger naming', () => {
  assert.deepEqual(gstSplit(10000_00, 1800, true), { cgst: 900_00, sgst: 900_00, igst: 0 });
  assert.deepEqual(gstSplit(10000_00, 1800, false), { cgst: 0, sgst: 0, igst: 1800_00 });
  assert.deepEqual(gstSplit(333, 500, true), { cgst: 8, sgst: 8, igst: 0 });
  assert.equal(taxLedgerName('Output', 'Central Tax', 900), 'Output CGST 9%');
  assert.equal(taxLedgerName('Input', 'Integrated Tax', 250), 'Input IGST 2.5%');
});

async function setup() {
  const books = new Books(nodeDb());
  await books.init();
  const mhGstin = withCheck('27AAPFU0939F1Z');
  await books.createCompany({ name: 'MH Traders', fy_start: '2026-04-01', state: 'Maharashtra', gst_enabled: 1, gstin: mhGstin });
  const groups = await books.groups();
  const g = (n: string) => groups.find((x) => x.name === n)!.id;
  const ty = (await books.voucherTypes()).reduce((m, t) => m.set(t.name, t.id), new Map<string, number>());
  const mk = async (name: string, group: string, extra: object = {}) => (await books.createLedger({ name, group_id: g(group), ...extra })).id;
  const sales18 = await mk('Sales 18%', 'Sales Accounts', { hsn_sac: '8471', rate_bp: 1800 });
  const sales5 = await mk('Sales 5%', 'Sales Accounts', { hsn_sac: '1006', rate_bp: 500 });
  const purch = await mk('Purchases', 'Purchase Accounts');
  const local = await mk('Local Retail Co', 'Sundry Debtors', { gstin: withCheck('27ABCDE1234F1Z'), state: 'Maharashtra' });
  const outstate = await mk('Karnataka Buyer', 'Sundry Debtors', { gstin: withCheck('29ABCDE1234F1Z'), state: 'Karnataka' });
  const walkin = await mk('Walk-in', 'Sundry Debtors', { state: 'Maharashtra' });
  const supplier = await mk('Supplier Ltd', 'Sundry Creditors', { gstin: withCheck('27ZZZZZ9999Z1Z'), state: 'Maharashtra' });
  return { books, ty, sales18, sales5, purch, local, outstate, walkin, supplier };
}

test('GST invoices, GSTR-1 and GSTR-3B', async () => {
  const s = await setup();
  const { books } = s;

  const intra = await planGstInvoice(books, 'Sales', s.local, [{ ledger_id: s.sales18, taxable: 10000_00, rate_bp: 1800 }]);
  assert.equal(intra.intra_state, true);
  assert.equal(intra.total, 11800_00);
  await books.createVoucher({ type_id: s.ty.get('Sales')!, date: '2026-05-10', party_id: s.local, place_of_supply: intra.place_of_supply, entries: intra.entries });

  const inter = await planGstInvoice(books, 'Sales', s.outstate, [{ ledger_id: s.sales18, taxable: 20000_00, rate_bp: 1800 }, { ledger_id: s.sales5, taxable: 10000_00, rate_bp: 500 }]);
  assert.equal(inter.intra_state, false);
  assert.equal(inter.tax, 3600_00 + 500_00);
  await books.createVoucher({ type_id: s.ty.get('Sales')!, date: '2026-05-12', party_id: s.outstate, place_of_supply: inter.place_of_supply, entries: inter.entries });

  const retail = await planGstInvoice(books, 'Sales', s.walkin, [{ ledger_id: s.sales5, taxable: 2000_00, rate_bp: 500 }]);
  await books.createVoucher({ type_id: s.ty.get('Sales')!, date: '2026-05-15', party_id: s.walkin, place_of_supply: retail.place_of_supply, entries: retail.entries });

  const buy = await planGstInvoice(books, 'Purchase', s.supplier, [{ ledger_id: s.purch, taxable: 8000_00, rate_bp: 1800 }]);
  await books.createVoucher({ type_id: s.ty.get('Purchase')!, date: '2026-05-20', party_id: s.supplier, place_of_supply: buy.place_of_supply, entries: buy.entries });

  const ret = await planGstInvoice(books, 'Credit Note', s.local, [{ ledger_id: s.sales18, taxable: 1000_00, rate_bp: 1800 }]);
  await books.createVoucher({ type_id: s.ty.get('Credit Note')!, date: '2026-05-25', party_id: s.local, place_of_supply: ret.place_of_supply, entries: ret.entries });

  const r1 = await gstr1(books, '2026-05-01', '2026-05-31');
  assert.equal(r1.b2b.length, 2);
  assert.equal(r1.b2cl.length, 0);
  assert.equal(r1.b2cs.length, 1);
  assert.equal(r1.b2cs[0].rate_bp, 500);
  assert.equal(r1.b2cs[0].cgst, 50_00);
  assert.equal(r1.cdnr.length, 1);
  const hsn = r1.hsn.find((h) => h.hsn === '8471')!;
  assert.equal(hsn.taxable, 30000_00);
  assert.equal(hsn.igst, 3600_00);
  assert.equal(hsn.cgst + hsn.sgst, 1800_00);
  const rice = r1.hsn.find((h) => h.hsn === '1006' && h.rate_bp === 500)!;
  assert.equal(rice.igst, 500_00);
  assert.equal(r1.totals.taxable, 10000_00 + 30000_00 + 2000_00 - 1000_00);

  const json = gstr1Json(r1) as { fp: string; b2b: { ctin: string }[] };
  assert.equal(json.fp, '052026');
  assert.equal(json.b2b.length, 2);

  const r3 = await gstr3b(books, '2026-05-01', '2026-05-31');
  assert.equal(r3.outward_taxable.taxable, 41000_00);
  assert.equal(r3.outward_taxable.igst, 4100_00);
  assert.equal(r3.outward_taxable.cgst, 900_00 + 50_00 - 90_00);
  assert.equal(r3.itc.cgst, 720_00);
  assert.equal(r3.itc.sgst, 720_00);
  assert.equal(r3.cash_payable.igst, 4100_00);
  assert.equal(r3.cash_payable.cgst, 140_00);
  assert.equal(r3.cash_payable.sgst, 140_00);
  assert.equal(r3.carry_forward_itc.cgst, 0);
  assert.equal(r3.carry_forward_itc.sgst, 0);
});

test('ITC set-off follows the IGST, CGST, SGST order', async () => {
  const s = await setup();
  const { books } = s;
  const buyInter = await planGstInvoice(books, 'Purchase', s.supplier, [{ ledger_id: s.purch, taxable: 10000_00, rate_bp: 1800 }], { placeOfSupply: 'Karnataka' });
  assert.equal(buyInter.intra_state, false);
  await books.createVoucher({ type_id: s.ty.get('Purchase')!, date: '2026-06-01', party_id: s.supplier, entries: buyInter.entries });
  const sale = await planGstInvoice(books, 'Sales', s.local, [{ ledger_id: s.sales18, taxable: 5000_00, rate_bp: 1800 }]);
  await books.createVoucher({ type_id: s.ty.get('Sales')!, date: '2026-06-05', party_id: s.local, entries: sale.entries });
  const r = await gstr3b(books, '2026-06-01', '2026-06-30');
  assert.equal(r.itc.igst, 1800_00);
  assert.equal(r.liability.cgst, 450_00);
  assert.equal(r.set_off.igst_used.cgst, 450_00);
  assert.equal(r.set_off.igst_used.sgst, 450_00);
  assert.equal(r.cash_payable.cgst + r.cash_payable.sgst + r.cash_payable.igst, 0);
  assert.equal(r.carry_forward_itc.igst, 1800_00 - 900_00);
});

test('B2C large limit is ₹1 lakh from 1 August 2024 and ₹2.5 lakh before', async () => {
  const { b2clThreshold } = await import('../src/index.ts');
  assert.equal(b2clThreshold('2024-07-31'), 250000_00);
  assert.equal(b2clThreshold('2024-08-01'), 100000_00);
  assert.equal(b2clThreshold('2026-11-03'), 100000_00);
});
