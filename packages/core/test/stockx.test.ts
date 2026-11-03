import test from 'node:test';
import assert from 'node:assert/strict';
import { Books, createItemInvoice, createGodown, createStockItem, createStockGroup, createUnit, ensureStockVoucherTypes } from '../src/index.ts';
import {
  ensureStockExtras,
  godownSummary,
  godownMonthly,
  godownVouchers,
  godownTransfers,
  stockQuery,
  topBuyersSellers,
  itemMovementAnalysis,
  itemVoucherAnalysis,
  stockMovementAnalysis,
  ledgerMovementAnalysis,
  stockTransferAnalysis,
  stockHierarchySummary,
  stockAgeing,
  ageingInwardDetails,
  setAgeingPeriods,
  getAgeingPeriods,
  reorderStatus,
  orderOutstandings,
  orderOutstandingSummary,
  trackAgainst,
  trackingCandidates,
  setOrderPreclosed,
  setOrderDueDate,
  billsPending,
  saveBatchAllocations,
  saveOpeningBatches,
  batchSummary,
  batchList,
  batchMasters,
  createPriceLevel,
  renamePriceLevel,
  deletePriceLevel,
  setItemPriceList,
  priceList,
  revisePriceList,
  getItemPrice,
  setPartyPriceLevel,
  partyPriceLevel,
} from '../src/stockx.ts';
import { nodeDb } from '../src/node-adapter.ts';

async function setup() {
  const books = new Books(nodeDb());
  await books.init();
  await books.createCompany({ name: 'Stock Co', fy_start: '2026-04-01', state: 'Maharashtra', gst_enabled: 1 });
  await ensureStockVoucherTypes(books.db);
  await ensureStockExtras(books.db);
  const groups = await books.groups();
  const g = (n: string) => groups.find((x) => x.name === n)!.id;
  const ty = (await books.voucherTypes()).reduce((m, t) => m.set(t.name, t.id), new Map<string, number>());
  const mk = async (name: string, group: string) => (await books.createLedger({ name, group_id: g(group), state: 'Maharashtra' })).id;
  const sales = await mk('Sales', 'Sales Accounts');
  const purch = await mk('Purchases', 'Purchase Accounts');
  const cust = await mk('Customer', 'Sundry Debtors');
  const supp = await mk('Supplier', 'Sundry Creditors');
  const grp = await createStockGroup(books.db, { name: 'Widgets' });
  const loc2 = await createGodown(books.db, { name: 'Shop' });
  const nos = (await books.db.select<{ id: number }>('SELECT id FROM units LIMIT 1'))[0].id;
  const item = await createStockItem(books.db, { name: 'Widget', group_id: grp.id, unit_id: nos, opening_qty: 10_000, opening_value: 1000_00, reorder_qty: 30_000, min_order_qty: 50_000, standard_price: 150_00 });
  return { books, ty, sales, purch, cust, supp, item, grp, loc2, nos };
}

const stockVoucher = (books: Books, typeId: number, date: string, party: number | null, lines: { item_id: number; godown_id?: number; qty: number; rate: number }[]) =>
  books.createVoucher({
    type_id: typeId,
    date,
    party_id: party,
    entries: [],
    stock: lines.map((l) => ({ ...l, godown_id: l.godown_id ?? 1, amount: Math.round((Math.abs(l.qty) * l.rate) / 1000) })),
  });

test('godown summary, monthly, vouchers and transfers', async () => {
  const { books, ty, item, loc2 } = await setup();
  await stockVoucher(books, ty.get('Stock Journal')!, '2026-05-10', null, [
    { item_id: item.id, godown_id: 1, qty: -4_000, rate: 100_00 },
    { item_id: item.id, godown_id: loc2.id, qty: 4_000, rate: 100_00 },
  ]);
  const gs = await godownSummary(books.db, '2026-06-30');
  const main = gs.rows.find((r) => r.name === 'Main Location')!;
  const shop = gs.rows.find((r) => r.name === 'Shop')!;
  assert.equal(main.qty, 6_000);
  assert.equal(shop.qty, 4_000);
  assert.equal(main.items[0].name, 'Widget');
  assert.equal(gs.value, 1000_00);

  const m = await godownMonthly(books.db, loc2.id, item.id, '2026-04-01', '2027-03-31');
  assert.equal(m.rows.length, 12);
  assert.equal(m.rows[1].label, 'May');
  assert.equal(m.rows[1].in_qty, 4_000);
  assert.equal(m.total.closing_qty, 4_000);

  const v = await godownVouchers(books.db, 1, item.id, '2026-04-01', '2027-03-31');
  assert.equal(v.opening_qty, 10_000);
  assert.equal(v.rows[0].out_qty, 4_000);
  assert.equal(v.totals.closing_qty, 6_000);

  const tr = await godownTransfers(books.db, '2026-04-01', '2027-03-31');
  assert.equal(tr.length, 1);
  assert.equal(tr[0].from_godown, 'Main Location');
  assert.equal(tr[0].to_godown, 'Shop');
  assert.equal(tr[0].qty, 4_000);
});

test('stock query, top buyers and movement analysis', async () => {
  const { books, ty, sales, purch, cust, supp, item } = await setup();
  await createItemInvoice(books, { kind: 'Purchase', type_id: ty.get('Purchase')!, date: '2026-04-05', party_id: supp, lines: [{ item_id: item.id, ledger_id: purch, qty: 10_000, rate: 120_00 }] });
  await createItemInvoice(books, { kind: 'Sales', type_id: ty.get('Sales')!, date: '2026-04-10', party_id: cust, lines: [{ item_id: item.id, ledger_id: sales, qty: 5_000, rate: 200_00, discount_bp: 1000 }] });
  await stockVoucher(books, ty.get('Stock Journal')!, '2026-04-12', null, [{ item_id: item.id, qty: 2_000, rate: 100_00 }]);

  const q = await stockQuery(books.db, item.id, '2026-12-31');
  assert.equal(q.closing_qty, 17_000);
  assert.equal(q.group, 'Widgets');
  assert.equal(q.purchases.length, 1);
  assert.equal(q.purchases[0].party, 'Supplier');
  assert.equal(q.sales[0].qty, 5_000);
  assert.equal(q.sales[0].discount_bp, 1000);
  assert.equal(q.last_sale!.party, 'Customer');
  assert.equal(q.godown_batches[0].godown, 'Main Location');
  assert.equal(q.godown_batches[0].qty, 17_000);
  assert.equal(q.reorder!.reorder_level, 30_000);

  const top = await topBuyersSellers(books.db, item.id, '2026-04-01', '2027-03-31');
  assert.equal(top.purchase[0].party, 'Supplier');
  assert.equal(top.sales[0].qty, 5_000);

  const mv = await itemMovementAnalysis(books.db, item.id, '2026-04-01', '2027-03-31');
  assert.deepEqual(mv.inward.map((s) => s.title), ['Suppliers:', 'Transfers Inward (Production):']);
  assert.equal(mv.outward[0].title, 'Buyers:');
  assert.equal(mv.outward[0].lines[0].name, 'Customer');
  assert.equal(mv.outward[0].lines[0].basic_rate, 200_00);
  assert.equal(mv.outward[0].lines[0].eff_rate, 180_00);
  assert.equal(mv.in_total.qty, 12_000);

  const vo = await itemVoucherAnalysis(books.db, item.id, '2026-04-01', '2027-03-31', { direction: 'out', party_id: cust });
  assert.equal(vo.rows.length, 1);
  assert.equal(vo.qty, 5_000);

  const grp = await stockMovementAnalysis(books.db, 'group', null, '2026-04-01', '2027-03-31');
  assert.equal(grp.rows[0].kind, 'group');
  assert.equal(grp.rows[0].name, 'Widgets');
  assert.equal(grp.total.out_qty, 5_000);
  const flat = await stockMovementAnalysis(books.db, 'group', null, '2026-04-01', '2027-03-31', true);
  assert.equal(flat.rows[0].kind, 'item');
  assert.equal(flat.rows[0].out_value, 900_00);

  const led = await ledgerMovementAnalysis(books.db, 'ledger', cust, '2026-04-01', '2027-03-31');
  assert.equal(led.rows[0].out_qty, 5_000);
  const sundry = (await books.groups()).find((g) => g.name === 'Sundry Debtors')!.id;
  const lg = await ledgerMovementAnalysis(books.db, 'group', sundry, '2026-04-01', '2027-03-31');
  assert.equal(lg.total.out_qty, 5_000);

  const sj = await stockTransferAnalysis(books.db, ty.get('Stock Journal')!, '2026-04-01', '2027-03-31');
  assert.equal(sj.total.in_qty, 2_000);

  const hs = await stockHierarchySummary(books.db, 'group', null, '2026-04-01', '2027-03-31');
  assert.equal(hs.rows[0].kind, 'group');
  assert.equal(hs.rows[0].closing_qty, 17_000);
  const hs2 = await stockHierarchySummary(books.db, 'group', item.group_id, '2026-04-01', '2027-03-31');
  assert.equal(hs2.rows[0].kind, 'item');
  assert.equal(hs2.total.closing_qty, 17_000);
});

test('ageing with batches and periods', async () => {
  const { books, ty, purch, supp, item, nos } = await setup();
  const b = await createStockItem(books.db, { name: 'Milk', unit_id: nos, maintain_batches: 1, track_expiry: 1 });
  const inv = await createItemInvoice(books, { kind: 'Purchase', type_id: ty.get('Purchase')!, date: '2026-04-05', party_id: supp, lines: [{ item_id: b.id, ledger_id: purch, qty: 10_000, rate: 50_00 }] });
  await saveBatchAllocations(books.db, inv.stock[0].id, [
    { batch: 'B1', mfg_date: '2026-04-01', expiry_date: '2026-06-01', qty: 4_000 },
    { batch: 'B2', mfg_date: '2026-04-02', expiry_date: '2027-01-01', qty: 6_000 },
  ]);
  await assert.rejects(() => saveBatchAllocations(books.db, inv.stock[0].id, [{ batch: 'X', qty: 1_000 }]), /add up/);
  await createItemInvoice(books, { kind: 'Purchase', type_id: ty.get('Purchase')!, date: '2026-07-20', party_id: supp, lines: [{ item_id: item.id, ledger_id: purch, qty: 5_000, rate: 100_00 }] });

  const rep = await stockAgeing(books.db, null, '2026-08-01');
  const widget = rep.rows.find((r) => r.name === 'Widget')!;
  assert.equal(widget.total, 15_000);
  assert.equal(widget.buckets[0], 5_000);
  assert.equal(widget.buckets[2], 10_000);
  const milk = rep.rows.find((r) => r.name === 'Milk')!;
  assert.equal(milk.children.length, 2);
  assert.equal(milk.buckets[2], 10_000);
  assert.equal(rep.total.total, 25_000);

  const exp = await stockAgeing(books.db, null, '2026-08-01', { style: 'expiry', onlyExpired: true });
  assert.equal(exp.rows.length, 1);
  assert.equal(exp.rows[0].children[0].batch, 'B1');
  assert.equal(exp.rows[0].total, 4_000);

  const det = await ageingInwardDetails(books.db, widget.item_id, '2026-08-01', 0);
  assert.equal(det.length, 1);
  assert.equal(det[0].party, 'Supplier');

  await createItemInvoice(books, { kind: 'Sales', type_id: ty.get('Sales')!, date: '2026-07-25', party_id: supp, lines: [{ item_id: item.id, ledger_id: purch, qty: 12_000, rate: 100_00 }] });
  const fifo = await stockAgeing(books.db, null, '2026-08-01');
  const w2 = fifo.rows.find((r) => r.name === 'Widget')!;
  assert.equal(w2.total, 3_000);
  assert.equal(w2.buckets[0], 3_000);

  await setAgeingPeriods(books.db, [
    { from: 0, to: 30 },
    { from: 30, to: 0 },
  ]);
  assert.equal((await getAgeingPeriods(books.db)).length, 2);
  await assert.rejects(() => setAgeingPeriods(books.db, [{ from: 0, to: 0 }, { from: 5, to: 9 }]), /last period/);
});

test('reorder status accounts for orders', async () => {
  const { books, ty, cust, supp, item } = await setup();
  await stockVoucher(books, ty.get('Purchase Order')!, '2026-04-02', supp, [{ item_id: item.id, qty: 8_000, rate: 100_00 }]);
  await stockVoucher(books, ty.get('Sales Order')!, '2026-04-03', cust, [{ item_id: item.id, qty: -3_000, rate: 150_00 }]);
  const r = (await reorderStatus(books.db, null, '2026-06-30')).rows[0];
  assert.equal(r.closing_qty, 10_000);
  assert.equal(r.purchase_orders_pending, 8_000);
  assert.equal(r.sale_orders_due, 3_000);
  assert.equal(r.nett_available, 15_000);
  assert.equal(r.shortfall, 15_000);
  assert.equal(r.order_to_be_placed, 50_000);
  assert.equal((await reorderStatus(books.db, null, '2026-06-30', true)).rows.length, 1);
});

test('order outstandings, tracking, preclose and bills pending', async () => {
  const { books, ty, sales, cust, item, grp } = await setup();
  const so = await stockVoucher(books, ty.get('Sales Order')!, '2026-04-02', cust, [{ item_id: item.id, qty: -5_000, rate: 110_00 }]);
  await setOrderDueDate(books.db, so.stock[0].id, '2026-04-20');
  const dn = await stockVoucher(books, ty.get('Delivery Note')!, '2026-04-10', cust, [{ item_id: item.id, qty: -2_000, rate: 110_00 }]);
  await trackAgainst(books.db, dn.stock[0].id, so.stock[0].id, 2_000);

  let rows = await orderOutstandings(books.db, 'Sales', '2026-05-01');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ordered, 5_000);
  assert.equal(rows[0].balance, 3_000);
  assert.equal(rows[0].value, 330_00);
  assert.equal(rows[0].overdue_days, 11);
  assert.equal((await orderOutstandings(books.db, 'Sales', '2026-04-10', { dueOnly: true })).length, 0);
  assert.equal((await orderOutstandings(books.db, 'Purchase', '2026-05-01')).length, 0);

  const sum = await orderOutstandingSummary(books.db, 'Sales', '2026-05-01', { stockGroupId: null });
  assert.equal(sum.rows[0].kind, 'group');
  assert.equal(sum.rows[0].value, 330_00);
  const items = await orderOutstandingSummary(books.db, 'Sales', '2026-05-01', { stockGroupId: grp.id });
  assert.equal(items.rows[0].kind, 'item');
  assert.equal(items.rows[0].rate, 110_00);
  const byLedger = await orderOutstandingSummary(books.db, 'Sales', '2026-05-01', { ledgerId: cust });
  assert.equal(byLedger.rows[0].qty, 3_000);

  const cand = await trackingCandidates(books.db, 'Sales Order', cust, item.id, '2026-05-01');
  assert.equal(cand[0].balance, 3_000);

  const bp = await billsPending(books.db, 'Sales', '2026-04-01', '2027-03-31');
  assert.equal(bp.pending.length, 1);
  assert.equal(bp.pending[0].pending, 2_000);
  const inv = await createItemInvoice(books, { kind: 'Sales', type_id: ty.get('Sales')!, date: '2026-04-15', party_id: cust, lines: [{ item_id: item.id, ledger_id: sales, qty: 2_000, rate: 110_00 }] });
  await trackAgainst(books.db, inv.stock[0].id, dn.stock[0].id, 2_000);
  const bp2 = await billsPending(books.db, 'Sales', '2026-04-01', '2027-03-31');
  assert.equal(bp2.pending.length, 0);
  assert.equal(bp2.cleared.length, 1);

  await setOrderPreclosed(books.db, [so.stock[0].id], true);
  assert.equal((await orderOutstandings(books.db, 'Sales', '2026-05-01')).length, 0);
  assert.equal((await orderOutstandings(books.db, 'Sales', '2026-05-01', { preclosedOnly: true })).length, 1);
  await assert.rejects(() => trackAgainst(books.db, dn.stock[0].id, so.stock[0].id, 0), /positive/);
});

test('batches: opening, summary, selection list', async () => {
  const { books, ty, sales, purch, cust, supp, nos } = await setup();
  const it = await createStockItem(books.db, { name: 'Paint', unit_id: nos, maintain_batches: 1, opening_qty: 10_000, opening_value: 100_000_00 });
  await saveOpeningBatches(books.db, it.id, [
    { batch: 'P1', mfg_date: '2026-01-01', expiry_date: '2027-01-01', qty: 6_000 },
    { batch: 'P2', mfg_date: '2026-02-01', expiry_date: '2026-12-01', qty: 4_000 },
  ]);
  await assert.rejects(() => saveOpeningBatches(books.db, it.id, [{ batch: 'P1', qty: 1_000 }]), /opening/);
  await assert.rejects(() => saveOpeningBatches(books.db, it.id, [{ batch: 'P1', mfg_date: '2026-05-01', expiry_date: '2026-01-01', qty: 10_000 }]), /before/);
  const buy = await createItemInvoice(books, { kind: 'Purchase', type_id: ty.get('Purchase')!, date: '2026-05-01', party_id: supp, lines: [{ item_id: it.id, ledger_id: purch, qty: 5_000, rate: 10_000_00 }] });
  await saveBatchAllocations(books.db, buy.stock[0].id, [{ batch: 'P3', mfg_date: '2026-04-20', expiry_date: '2028-04-20', qty: 5_000 }]);
  const sell = await createItemInvoice(books, { kind: 'Sales', type_id: ty.get('Sales')!, date: '2026-06-01', party_id: cust, lines: [{ item_id: it.id, ledger_id: sales, qty: 3_000, rate: 12_000_00 }] });
  await saveBatchAllocations(books.db, sell.stock[0].id, [{ batch: 'P2', qty: 3_000 }]);

  const s = await batchSummary(books.db, it.id, '2026-12-31');
  const by = new Map(s.rows.map((r) => [r.batch, r]));
  assert.equal(by.get('P1')!.qty, 6_000);
  assert.equal(by.get('P2')!.qty, 1_000);
  assert.equal(by.get('P3')!.qty, 5_000);
  assert.equal(by.get('P3')!.value, 5_000 * 10_000_00 / 1000);
  assert.equal(by.get('P2')!.expiry_date, '2026-12-01');
  assert.equal((await batchSummary(books.db, it.id, '2026-11-01', { expiredOnly: true })).rows.length, 0);
  assert.equal((await batchSummary(books.db, it.id, '2027-02-01', { expiredOnly: true })).rows.length, 2);

  const list = await batchList(books.db, it.id, 1, '2026-12-31');
  assert.deepEqual(list.map((b) => b.batch), ['P2', 'P1', 'P3']);
  assert.equal((await batchList(books.db, it.id, 1, '2026-05-15')).find((b) => b.batch === 'P2')!.qty, 4_000);
  assert.equal((await batchMasters(books.db, it.id)).length, 3);
});

test('price levels, price lists, revision and retrieval', async () => {
  const { books, cust, item, grp } = await setup();
  const retail = await createPriceLevel(books.db, 'Retailer');
  const whole = await createPriceLevel(books.db, 'Wholesaler');
  await assert.rejects(() => createPriceLevel(books.db, 'retailer'), /already exists/);
  await renamePriceLevel(books.db, whole.id, 'Dealer');
  await setItemPriceList(books.db, {
    level_id: retail.id,
    item_id: item.id,
    applicable_from: '2026-06-01',
    slabs: [
      { from_qty: 0, less_than_qty: 10_000, rate: 200_00, disc_bp: 100 },
      { from_qty: 10_000, less_than_qty: 20_000, rate: 190_00, disc_bp: 100 },
      { from_qty: 20_000, less_than_qty: 0, rate: 180_00, disc_bp: 200 },
    ],
  });
  await assert.rejects(() => setItemPriceList(books.db, { level_id: retail.id, item_id: item.id, applicable_from: '2026-06-01', slabs: [{ from_qty: 0, less_than_qty: 10_000, rate: 1, disc_bp: 0 }, { from_qty: 5_000, less_than_qty: 0, rate: 1, disc_bp: 0 }] }), /overlap/);

  const p = (qty: number, date = '2026-06-15') => getItemPrice(books.db, { item_id: item.id, level_id: retail.id, date, qty });
  assert.deepEqual(await p(5_000), { rate: 200_00, disc_bp: 100, source: 'price_list', level_id: retail.id });
  assert.equal((await p(10_000)).rate, 190_00);
  assert.equal((await p(25_000)).rate, 180_00);
  assert.equal((await p(25_000)).disc_bp, 200);
  assert.equal((await p(5_000, '2026-05-01')).source, 'standard');
  assert.equal((await p(5_000, '2026-05-01')).rate, 150_00);

  await setPartyPriceLevel(books.db, cust, retail.id);
  assert.equal((await partyPriceLevel(books.db, cust))!.name, 'Retailer');
  assert.equal((await getItemPrice(books.db, { item_id: item.id, party_id: cust, date: '2026-07-01', qty: 1_000 })).rate, 200_00);

  const preview = await revisePriceList(books.db, { level_id: retail.id, applicable_from: '2026-08-01', stock_group_id: grp.id, price_mode: 'dec_amount', price_value: 10_00, disc_mode: 'none', disc_value: 0 }, true);
  assert.equal(preview[0].slabs[0].rate, 190_00);
  assert.equal((await p(5_000, '2026-09-01')).rate, 200_00);
  await revisePriceList(books.db, { level_id: retail.id, applicable_from: '2026-08-01', stock_group_id: grp.id, price_mode: 'dec_pct', price_value: 1000, disc_mode: 'inc_pct', disc_value: 100 });
  assert.equal((await p(5_000, '2026-09-01')).rate, 180_00);
  assert.equal((await p(5_000, '2026-09-01')).disc_bp, 200);
  assert.equal((await p(5_000, '2026-07-01')).rate, 200_00);

  const list = await priceList(books.db, retail.id, '2026-09-01', { stockGroupId: grp.id });
  assert.equal(list[0].slabs.length, 3);
  assert.equal(list[0].history[0].rate, 200_00);
  assert.equal(list[0].cost_rate, 100_00);

  await assert.rejects(() => deletePriceLevel(books.db, retail.id), /cannot be deleted/);
  await deletePriceLevel(books.db, whole.id);
});

test('batches split one line value by quantity', async () => {
  const { books, ty, purch, supp, nos } = await setup();
  const it = await createStockItem(books.db, { name: 'Tabs', unit_id: nos, maintain_batches: 1 });
  const buy = await createItemInvoice(books, { kind: 'Purchase', type_id: ty.get('Purchase')!, date: '2026-05-01', party_id: supp, lines: [{ item_id: it.id, ledger_id: purch, qty: 10_000, rate: 25_00 }] });
  await saveBatchAllocations(books.db, buy.stock[0].id, [{ batch: 'B1', qty: 6_000 }, { batch: 'B2', qty: 4_000 }]);
  const s = await batchSummary(books.db, it.id, '2026-12-31');
  const by = new Map(s.rows.map((r) => [r.batch, r]));
  assert.equal(by.get('B1')!.value, 150_00);
  assert.equal(by.get('B2')!.value, 100_00);
  assert.equal(by.get('B1')!.rate, 25_00);
  assert.equal(s.total_value, 250_00);
});
