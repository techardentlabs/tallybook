import test from 'node:test';
import assert from 'node:assert/strict';
import { Books, gstinChecksum, planGstInvoice } from '../src/index.ts';
import { nodeDb } from '../src/node-adapter.ts';
import {
  buildEInvoiceJson, buildEwayJson, buildEwbCancelJson, buildIrnCancelJson, cancelEwb, cancelIrn, eInvoiceSummary, eWayBillRows, getEInvoice, getEway,
  markExported, missingInfo, recordEwb, recordIrn, saveEway,
} from '../src/einvoice.ts';
import { ensureStatutory } from '../src/tds.ts';

const withCheck = (first14: string) => first14 + gstinChecksum(first14);
const IRN = 'a'.repeat(64);

async function setup() {
  const books = new Books(nodeDb());
  await books.init();
  const sellerGstin = withCheck('27AAPFU0939F1Z');
  await books.createCompany({ name: 'MH Traders', fy_start: '2026-04-01', state: 'Maharashtra', gst_enabled: 1, gstin: sellerGstin, address: '1 MG Road\nPune', pincode: '411001' });
  await ensureStatutory(books.db);
  const groups = await books.groups();
  const g = (n: string) => groups.find((x) => x.name === n)!.id;
  const types = await books.voucherTypes();
  const sales = types.find((t) => t.name === 'Sales')!.id;
  const mk = async (name: string, group: string, extra: object = {}) => (await books.createLedger({ name, group_id: g(group), ...extra })).id;
  const income = await mk('Sales 18%', 'Sales Accounts', { hsn_sac: '8471', rate_bp: 1800 });
  const buyer = await mk('Karnataka Buyer', 'Sundry Debtors', { gstin: withCheck('29ABCDE1234F1Z'), state: 'Karnataka', address: '5 Brigade Rd\nBengaluru', pincode: '560001' });
  const bare = await mk('Bare Buyer', 'Sundry Debtors', { gstin: withCheck('27ABCDE1234F1Z'), state: 'Maharashtra' });
  const inv = async (party: number, amount: number, date: string) => {
    const plan = await planGstInvoice(books, 'Sales', party, [{ ledger_id: income, taxable: amount, rate_bp: 1800 }]);
    return books.createVoucher({ type_id: sales, date, party_id: party, entries: plan.entries });
  };
  return { books, inv, buyer, bare, sellerGstin };
}

test('NIC e-invoice JSON v1.1 payload', async () => {
  const { books, inv, buyer, sellerGstin } = await setup();
  const v = await inv(buyer, 100000_00, '2026-05-02');
  await saveEway(books.db, v.id, { transporter_id: '29AAAAA0000A1Z5', transporter_name: 'Fast Cargo', distance_km: 850, vehicle_no: 'ka-01-ab-1234' });
  const [doc] = (await buildEInvoiceJson(books, [v.id])) as any[];
  assert.equal(doc.Version, '1.1');
  assert.deepEqual(doc.TranDtls, { TaxSch: 'GST', SupTyp: 'B2B', RegRev: 'N', EcmGstin: null, IgstOnIntra: 'N' });
  assert.equal(doc.DocDtls.Typ, 'INV');
  assert.equal(doc.DocDtls.Dt, '02/05/2026');
  assert.equal(doc.SellerDtls.Gstin, sellerGstin);
  assert.equal(doc.SellerDtls.Stcd, '27');
  assert.equal(doc.SellerDtls.Pin, 411001);
  assert.equal(doc.BuyerDtls.Stcd, '29');
  assert.equal(doc.BuyerDtls.Pos, '29');
  assert.equal(doc.ItemList[0].HsnCd, '8471');
  assert.equal(doc.ItemList[0].GstRt, 18);
  assert.equal(doc.ItemList[0].IgstAmt, 18000);
  assert.equal(doc.ItemList[0].CgstAmt, 0);
  assert.equal(doc.ValDtls.AssVal, 100000);
  assert.equal(doc.ValDtls.IgstVal, 18000);
  assert.equal(doc.ValDtls.TotInvVal, 118000);
  assert.equal(doc.EwbDtls.Vehno, 'KA01AB1234');
  assert.equal(doc.EwbDtls.Distance, 850);
  assert.equal(doc.EwbDtls.TransMode, '1');
});

test('e-way bill bulk JSON', async () => {
  const { books, inv, buyer } = await setup();
  const v = await inv(buyer, 100000_00, '2026-05-02');
  await saveEway(books.db, v.id, { transporter_id: '29AAAAA0000A1Z5', distance_km: 850, vehicle_no: 'KA01AB1234' });
  const j = (await buildEwayJson(books, [v.id])) as any;
  const b = j.billLists[0];
  assert.equal(j.version, '1.0.0621');
  assert.equal(b.supplyType, 'O');
  assert.equal(b.subSupplyType, 1);
  assert.equal(b.docDate, '02/05/2026');
  assert.equal(b.igstValue, 18000);
  assert.equal(b.totInvValue, 118000);
  assert.equal(b.transDistance, '850');
  assert.equal(b.itemList[0].igstRate, 18);
  assert.equal(b.itemList[0].hsnCode, 8471);
  await assert.rejects(saveEway(books.db, v.id, { distance_km: 5000 }), /Distance/);
  await assert.rejects(saveEway(books.db, v.id, { transporter_id: 'short' }), /Transporter/);
});

test('IRN lifecycle, cancellation and reports', async () => {
  const { books, inv, buyer, bare } = await setup();
  const a = await inv(buyer, 100000_00, '2026-05-02');
  const b = await inv(bare, 1000_00, '2026-05-03');
  assert.deepEqual(await missingInfo(books, b.id), ['Buyer address', 'Buyer pincode']);
  let s = await eInvoiceSummary(books, '2026-05-01', '2026-05-31');
  assert.equal(s.lines.find((l) => l.key === 'Pending for Exchange')!.count, 1);
  assert.equal(s.lines.find((l) => l.key === 'Information required for e-Invoice not provided')!.count, 1);

  await markExported(books.db, 'einvoice', [a.id], '2026-05-02');
  assert.equal((await getEInvoice(books.db, a.id)).status, 'exported');
  await assert.rejects(recordIrn(books.db, a.id, { irn: 'xyz', ack_no: '1', ack_date: '2026-05-02 10:00:00' }), /64/);
  const done = await recordIrn(books.db, a.id, { irn: IRN, ack_no: '112010000012345', ack_date: '2026-05-02 10:00:00', signed_qr: 'QR' });
  assert.equal(done.status, 'generated');
  s = await eInvoiceSummary(books, '2026-05-01', '2026-05-31');
  assert.equal(s.lines.find((l) => l.key === 'IRN Generated')!.count, 1);

  await assert.rejects(cancelIrn(books.db, a.id, 'Nope', '', '2026-05-02'), /reason/);
  await assert.rejects(cancelIrn(books.db, a.id, 'Duplicate', '', '2026-05-05'), /24 hours/);
  const c = await cancelIrn(books.db, a.id, 'Data Entry Mistake', 'Wrong qty', '2026-05-02');
  assert.equal(c.status, 'cancelled');
  assert.deepEqual(buildIrnCancelJson(c), { Irn: IRN, CnlRsn: '2', CnlRem: 'Wrong qty' });

  const rows = await eWayBillRows(books, '2026-05-01', '2026-05-31');
  assert.equal(rows.length, 1);
  await recordEwb(books.db, a.id, { ewb_no: '331001234567', ewb_date: '2026-05-02', valid_upto: '2026-05-05' });
  assert.equal((await getEway(books.db, a.id)).status, 'generated');
  const e = await cancelEwb(books.db, a.id, 'Order Cancelled', 'Buyer cancelled', '2026-05-02');
  assert.deepEqual(buildEwbCancelJson(e), { ewbNo: 331001234567, cancelRsnCode: 2, cancelRmrk: 'Buyer cancelled' });
});
