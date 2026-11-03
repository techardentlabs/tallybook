import test from 'node:test';
import assert from 'node:assert/strict';
import { Books, gstinChecksum, planGstInvoice } from '../src/index.ts';
import { nodeDb } from '../src/node-adapter.ts';
import {
  dueDate, ensureDutyLedger, ensureStatutory, form26Q, natures, payTds, planTds, recordDeduction, reconcileChallan, saveNature, saveTdsCompany,
  saveTdsParty, tdsChallans, tdsOutstandingByNature, tdsOutstandings,
} from '../src/tds.ts';
import { gstr2bReconciliation, hsnSummary, importGstr2b, taxAnalysis } from '../src/gstrecon.ts';

const withCheck = (first14: string) => first14 + gstinChecksum(first14);

async function setup() {
  const books = new Books(nodeDb());
  await books.init();
  await books.createCompany({ name: 'MH Traders', fy_start: '2026-04-01', state: 'Maharashtra', gst_enabled: 1, gstin: withCheck('27AAPFU0939F1Z') });
  await ensureStatutory(books.db);
  const groups = await books.groups();
  const g = (n: string) => groups.find((x) => x.name === n)!.id;
  const types = await books.voucherTypes();
  const ty = (n: string) => types.find((x) => x.name === n)!.id;
  const mk = async (name: string, group: string, extra: object = {}) => (await books.createLedger({ name, group_id: g(group), ...extra })).id;
  return { books, ty, mk };
}

test('nature master seeds and validates', async () => {
  const { books } = await setup();
  const list = await natures(books.db, 'TDS');
  assert.ok(list.some((n) => n.section === '194J'));
  const n = await saveNature(books.db, { name: 'Custom', section: '194X', rate_ind_pan_bp: 100, rate_oth_pan_bp: 200 });
  assert.equal(n.rate_oth_pan_bp, 200);
  await assert.rejects(saveNature(books.db, { name: 'custom' }), /already exists/);
  const co = await saveTdsCompany(books.db, { tds_enabled: 1, tan: 'mumm12345a' });
  assert.equal(co.tan, 'MUMM12345A');
  await assert.rejects(saveTdsCompany(books.db, { tan: 'bad' }), /TAN/);
});

test('rates, PAN, thresholds, surcharge', async () => {
  const { books, mk } = await setup();
  const prof = (await natures(books.db)).find((n) => n.name === 'Fees for Professional Services')!;
  const ind = await mk('Dr Shah', 'Sundry Creditors', { pan: 'ABCDE1234F' });
  await saveTdsParty(books.db, ind, { deductee_type: 'Individual/HUF - Resident' });
  const small = await planTds(books.db, { party_id: ind, nature_id: prof.id, amount: 40000_00, date: '2026-05-10' });
  assert.equal(small.below_threshold, true);
  assert.equal(small.tax, 0);
  const big = await planTds(books.db, { party_id: ind, nature_id: prof.id, amount: 100000_00, date: '2026-05-10' });
  assert.equal(big.rate_bp, 1000);
  assert.equal(big.tax, 10000_00);

  const nopan = await mk('No Pan Co', 'Sundry Creditors');
  const p2 = await planTds(books.db, { party_id: nopan, nature_id: prof.id, amount: 100000_00, date: '2026-05-10' });
  assert.equal(p2.rate_bp, 2000);
  assert.equal(p2.tax, 20000_00);

  const nr = await saveNature(books.db, { name: 'NR Fees', section: '195', rate_ind_pan_bp: 2000, rate_oth_pan_bp: 2000, rate_ind_nopan_bp: 2000, rate_oth_nopan_bp: 2000, surcharge_bp: 200, cess_bp: 400 });
  const foreign = await mk('Foreign Co', 'Sundry Creditors', { pan: 'AAAAA1111A' });
  await saveTdsParty(books.db, foreign, { deductee_type: 'Company - Non Resident' });
  const p3 = await planTds(books.db, { party_id: foreign, nature_id: nr.id, amount: 100000_00, date: '2026-05-10' });
  assert.equal(p3.tax, 20000_00);
  assert.equal(p3.surcharge, 400_00);
  assert.equal(p3.cess, 816_00);
});

test('cumulative threshold crossing deducts on aggregate', async () => {
  const { books, ty, mk } = await setup();
  const rent = (await natures(books.db)).find((n) => n.name === 'Rent of Land, Building Or Furniture')!;
  const landlord = await mk('Landlord', 'Sundry Creditors', { pan: 'ABCDE1234F' });
  const exp = await mk('Rent', 'Indirect Expenses');
  const duty = await ensureDutyLedger(books, rent.id);
  let total = 0;
  for (const [i, amt] of [400000_00, 300000_00].entries()) {
    const date = `2026-0${5 + i}-05`;
    const plan = await planTds(books.db, { party_id: landlord, nature_id: rent.id, amount: amt, date });
    const v = await books.createVoucher({
      type_id: ty('Journal'), date,
      entries: [{ ledger_id: exp, amount: amt }, { ledger_id: landlord, amount: -(amt - plan.tax) }, ...(plan.tax ? [{ ledger_id: duty, amount: -plan.tax }] : [])],
    });
    await recordDeduction(books.db, v.id, landlord, date, plan);
    total += plan.tax;
    if (i === 0) assert.equal(plan.below_threshold, true);
    else assert.equal(plan.tax, 70000_00);
  }
  assert.equal(total, 70000_00);
});

test('outstandings, payment, challan and 26Q', async () => {
  const { books, ty, mk } = await setup();
  const com = (await natures(books.db)).find((n) => n.section === '194H')!;
  const agent = await mk('Agent Co', 'Sundry Creditors', { pan: 'ABCDE1234F' });
  const exp = await mk('Commission', 'Indirect Expenses');
  const bank = await mk('HDFC', 'Bank Accounts');
  const duty = await ensureDutyLedger(books, com.id);
  const plan = await planTds(books.db, { party_id: agent, nature_id: com.id, amount: 100000_00, date: '2026-05-20' });
  assert.equal(plan.tax, 2000_00);
  const v = await books.createVoucher({
    type_id: ty('Journal'), date: '2026-05-20',
    entries: [{ ledger_id: exp, amount: 100000_00 }, { ledger_id: agent, amount: -98000_00 }, { ledger_id: duty, amount: -2000_00 }],
  });
  await recordDeduction(books.db, v.id, agent, '2026-05-20', plan);
  assert.equal(dueDate('2026-05-20'), '2026-06-07');
  assert.equal(dueDate('2027-03-10'), '2027-04-30');

  const out = await tdsOutstandings(books.db, '2026-04-01', '2027-03-31');
  assert.equal(out.length, 1);
  assert.equal(out[0].pending, 2000_00);
  assert.ok(out[0].overdue_days > 0);
  const byNature = await tdsOutstandingByNature(books.db, '2026-04-01', '2027-03-31');
  assert.equal(byNature[0].company, 2000_00);

  const pay = await payTds(books, { date: '2026-06-05', bank_id: bank, deduction_ids: [out[0].deduction_id], bsr_code: '', challan_no: '' });
  assert.equal(pay.challan_ids.length, 1);
  assert.equal((await tdsOutstandings(books.db, '2026-04-01', '2027-03-31')).length, 0);
  await assert.rejects(payTds(books, { date: '2026-06-05', bank_id: bank, deduction_ids: [out[0].deduction_id] }), /already paid/);

  const challans = await tdsChallans(books.db, '2026-04-01', '2027-03-31', true);
  assert.equal(challans.length, 1);
  await reconcileChallan(books.db, challans[0].id, { bsr_code: '3735721', challan_no: 'VHO21', challan_date: '2026-06-05' });
  assert.equal((await tdsChallans(books.db, '2026-04-01', '2027-03-31', true)).length, 0);

  const q = await form26Q(books.db, '2026-04-01', '2026-06-30');
  assert.equal(q.quarter, 1);
  assert.equal(q.deductions[0].challan_no, 'VHO21');
  assert.equal(q.totals.deposited, 2000_00);
  assert.equal(q.challans[0].amount, 2000_00);
});

test('tax analysis, HSN summary and GSTR-2B reconciliation', async () => {
  const { books, ty, mk } = await setup();
  const sales18 = await mk('Sales 18%', 'Sales Accounts', { hsn_sac: '8471', rate_bp: 1800 });
  const purch = await mk('Purchases', 'Purchase Accounts');
  const buyer = await mk('Local Buyer', 'Sundry Debtors', { gstin: withCheck('27ABCDE1234F1Z'), state: 'Maharashtra' });
  const supGstin = withCheck('27ZZZZZ9999Z1Z');
  const supplier = await mk('Supplier Ltd', 'Sundry Creditors', { gstin: supGstin, state: 'Maharashtra' });
  const s = await planGstInvoice(books, 'Sales', buyer, [{ ledger_id: sales18, taxable: 10000_00, rate_bp: 1800 }]);
  await books.createVoucher({ type_id: ty('Sales'), date: '2026-05-02', party_id: buyer, entries: s.entries });
  const p1 = await planGstInvoice(books, 'Purchase', supplier, [{ ledger_id: purch, taxable: 5000_00, rate_bp: 1800 }]);
  await books.createVoucher({ type_id: ty('Purchase'), date: '2026-05-03', party_id: supplier, reference: 'INV/001', entries: p1.entries });
  const p2 = await planGstInvoice(books, 'Purchase', supplier, [{ ledger_id: purch, taxable: 2000_00, rate_bp: 1800 }]);
  await books.createVoucher({ type_id: ty('Purchase'), date: '2026-05-04', party_id: supplier, reference: 'INV/002', entries: p2.entries });

  const ta = await taxAnalysis(books, '2026-05-01', '2026-05-31');
  assert.equal(ta[0].rate_bp, 1800);
  assert.equal(ta[0].taxable, 10000_00);
  assert.equal(ta[0].cgst, 900_00);
  const hs = await hsnSummary(books, '2026-05-01', '2026-05-31');
  assert.equal(hs[0].hsn, '8471');
  assert.equal(hs[0].value, 11800_00);

  const json = {
    data: {
      rtnprd: '052026',
      docdata: {
        b2b: [
          { ctin: supGstin, trdnm: 'Supplier Ltd', inv: [{ inum: 'inv-001', dt: '03-05-2026', val: 5900, itcavl: 'Y', items: [{ txval: 5000, cgst: 450, sgst: 450, igst: 0, cess: 0 }] }, { inum: 'INV/009', dt: '04-05-2026', val: 2360, txval: 2000, cgst: 180, sgst: 180 }] },
          { ctin: withCheck('29ABCDE1234F1Z'), trdnm: 'Other', inv: [{ inum: 'X1', dt: '04-05-2026', val: 118, txval: 100, igst: 18 }] },
        ],
      },
    },
  };
  assert.deepEqual(await importGstr2b(books.db, json, '2026-05'), { period: '2026-05', imported: 3 });
  const r = await gstr2bReconciliation(books, '2026-05-01', '2026-05-31');
  assert.equal(r.counts.Reconciled, 1);
  assert.equal(r.counts['Potential Match'], 1);
  assert.equal(r.counts['Available Only in Portal'], 1);
  assert.equal(r.counts['Available Only in Books'], 0);
});
