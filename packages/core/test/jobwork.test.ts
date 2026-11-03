import test from 'node:test';
import assert from 'node:assert/strict';
import { Books, createGodown, createStockItem, ensureStockVoucherTypes, stockSummary, units } from '../src/index.ts';
import { createBom, ensureMfg } from '../src/mfg.ts';
import {
  consumptionFor,
  ensureJobWork,
  jobOrder,
  jobOrders,
  materialMovementRegister,
  pendingForMaterial,
  pendingJobOrders,
  saveMaterialLink,
  saveOrderMeta,
  thirdPartyStock,
  varianceAnalysis,
} from '../src/jobwork.ts';
import { nodeDb } from '../src/node-adapter.ts';

async function setup() {
  const books = new Books(nodeDb());
  await books.init();
  await books.createCompany({ name: 'JW Co', fy_start: '2026-04-01' });
  const c = (await books.company())!;
  await books.updateCompany({ ...c, inventory_enabled: 1, job_work_enabled: 1 } as never);
  await ensureStockVoucherTypes(books.db);
  await ensureMfg(books.db);
  await ensureJobWork(books.db);
  const ty = (await books.voucherTypes()).reduce((m, t) => m.set(t.name, t.id), new Map<string, number>());
  const groups = await books.groups();
  const tailor = (await books.createLedger({ name: 'Tailor', group_id: groups.find((g) => g.name === 'Sundry Creditors')!.id })).id;
  const nos = (await units(books.db))[0].id;
  const cloth = await createStockItem(books.db, { name: 'Cloth', unit_id: nos, opening_qty: 100_000, opening_value: 10_000_00 });
  const shirt = await createStockItem(books.db, { name: 'Shirt', unit_id: nos });
  await createBom(books.db, shirt.id, { name: 'Std', unit_qty: 1_000, lines: [{ item_id: cloth.id, qty: 2_000 }] });
  const atTailor = await createGodown(books.db, { name: 'At Tailor', third_party: 1 });
  const theirs = await createGodown(books.db, { name: 'Customer Stock', third_party: 2 });
  return { books, ty, tailor, cloth, shirt, atTailor, theirs };
}

const voucher = (books: Books, typeId: number, date: string, party: number | null, lines: { item_id: number; godown_id: number; qty: number; rate?: number }[]) =>
  books.createVoucher({ type_id: typeId, date, party_id: party, entries: [], stock: lines.map((l) => ({ ...l, rate: l.rate ?? 0, amount: Math.round((Math.abs(l.qty) * (l.rate ?? 0)) / 1000) })) });

test('job work out: order, material out, stock with job worker, material in with consumption', async () => {
  const { books, ty, tailor, cloth, shirt, atTailor } = await setup();
  assert.ok(ty.get('Job Work Out Order') && ty.get('Material Out') && ty.get('Material In'));
  const order = await voucher(books, ty.get('Job Work Out Order')!, '2026-05-01', tailor, [{ item_id: shirt.id, godown_id: 1, qty: 10_000, rate: 50_00 }]);
  await saveOrderMeta(books.db, order.id, { duration: '7 Days', nature: 'Stitching' });
  const before = await stockSummary(books.db, '2026-04-01', '2026-05-01');
  assert.equal(before.rows.find((r) => r.item_id === shirt.id)?.closing_qty ?? 0, 0);

  let o = (await jobOrder(books.db, order.id))!;
  assert.equal(o.components[0].required, 20_000);
  assert.deepEqual((await pendingForMaterial(books.db, order.id, 'Material Out')).map((p) => [p.item_id, p.qty]), [[cloth.id, 20_000]]);
  assert.equal((await pendingJobOrders(books.db, 'Material Out', tailor, '2026-05-31')).length, 1);

  const out = await voucher(books, ty.get('Material Out')!, '2026-05-02', tailor, [
    { item_id: cloth.id, godown_id: 1, qty: -20_000, rate: 100_00 },
    { item_id: cloth.id, godown_id: atTailor.id, qty: 20_000, rate: 100_00 },
  ]);
  await saveMaterialLink(books.db, out.id, { order_voucher_id: order.id, party_godown_id: atTailor.id, challan_no: 'DC-1' });
  o = (await jobOrder(books.db, order.id))!;
  assert.equal(o.components[0].issued, 20_000);
  assert.equal(o.components[0].balance, 0);
  const mid = await stockSummary(books.db, '2026-04-01', '2026-05-02');
  assert.equal(mid.rows.find((r) => r.item_id === cloth.id)!.closing_qty, 100_000);
  const withJw = await thirdPartyStock(books.db, 1, '2026-05-02');
  assert.equal(withJw.rows[0].qty, 20_000);
  assert.equal(withJw.rows[0].godown, 'At Tailor');
  assert.equal(withJw.total_value, 2_000_00);

  const cons = await consumptionFor(books.db, shirt.id, 10_000);
  assert.deepEqual(cons, [{ item_id: cloth.id, qty: 20_000 }]);
  const inn = await voucher(books, ty.get('Material In')!, '2026-05-09', tailor, [
    { item_id: shirt.id, godown_id: 1, qty: 10_000, rate: 50_00 },
    { item_id: cloth.id, godown_id: atTailor.id, qty: -20_000, rate: 100_00 },
  ]);
  await saveMaterialLink(books.db, inn.id, { order_voucher_id: order.id, party_godown_id: atTailor.id });
  o = (await jobOrder(books.db, order.id))!;
  assert.equal(o.lines[0].done, 10_000);
  assert.equal(o.lines[0].balance, 0);
  assert.equal((await pendingJobOrders(books.db, 'Material In', tailor, '2026-05-31')).length, 0);
  const after = await stockSummary(books.db, '2026-04-01', '2026-05-31');
  assert.equal(after.rows.find((r) => r.item_id === cloth.id)!.closing_qty, 80_000);
  assert.equal(after.rows.find((r) => r.item_id === shirt.id)!.closing_qty, 10_000);
  assert.equal((await thirdPartyStock(books.db, 1, '2026-05-31')).rows.length, 0);

  const reg = await materialMovementRegister(books.db, 'Out', '2026-04-01', '2026-05-31');
  assert.deepEqual(reg.map((r) => [r.parent, r.item, r.qty, r.nature]), [
    ['Material Out', 'Cloth', 20_000, 'Stitching'],
    ['Material In', 'Shirt', 10_000, 'Stitching'],
  ]);
  const iv = await varianceAnalysis(books.db, 'issue', 'Out', '2026-04-01', '2026-05-31');
  assert.equal(iv[0].variance, 0);
  assert.equal((await jobOrders(books.db, 'Out')).length, 1);
});

test('job worker: third party stock stays out of own stock value', async () => {
  const { books, ty, tailor, cloth, theirs } = await setup();
  const ord = await voucher(books, ty.get('Job Work In Order')!, '2026-06-01', tailor, [{ item_id: cloth.id, godown_id: theirs.id, qty: 5_000, rate: 10_00 }]);
  const rec = await voucher(books, ty.get('Material In')!, '2026-06-02', tailor, [{ item_id: cloth.id, godown_id: theirs.id, qty: 5_000 }]);
  await saveMaterialLink(books.db, rec.id, { order_voucher_id: ord.id });
  const s = await stockSummary(books.db, '2026-04-01', '2026-06-30');
  assert.equal(s.rows.find((r) => r.item_id === cloth.id)!.closing_qty, 100_000);
  const from = await thirdPartyStock(books.db, 2, '2026-06-30');
  assert.equal(from.rows[0].qty, 5_000);
  assert.equal(from.total_value, 0);
});
