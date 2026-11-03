import test from 'node:test';
import assert from 'node:assert/strict';
import { Books, createStockItem, createGodown, createStockGroup, ensureStockVoucherTypes, stockSummary } from '../src/index.ts';
import {
  allBoms,
  bom,
  boms,
  copyBomLines,
  costEstimation,
  createBom,
  createMfgJournal,
  deleteBom,
  ensureMfg,
  explodeBom,
  isMfgJournal,
  isMfgVoucherType,
  issueCost,
  itemsWithBom,
  jobCosting,
  materialRequirement,
  mfgJournal,
  mfgVoucherTypeId,
  mfgVoucherTypes,
  planMfgJournal,
  setUseAsMfgJournal,
  updateBom,
  updateMfgJournal,
} from '../src/mfg.ts';
import { nodeDb } from '../src/node-adapter.ts';

async function setup() {
  const books = new Books(nodeDb());
  await books.init();
  await books.createCompany({ name: 'Mfg Co', fy_start: '2026-04-01', state: 'Maharashtra', inventory_enabled: 1 });
  await ensureStockVoucherTypes(books.db);
  await ensureMfg(books.db);
  const groups = await books.groups();
  const g = (n: string) => groups.find((x) => x.name === n)!.id;
  const labour = (await books.createLedger({ name: 'Labour Charges', group_id: g('Direct Expenses') })).id;
  const power = (await books.createLedger({ name: 'Power', group_id: g('Direct Expenses') })).id;
  const fg = await createStockGroup(books.db, { name: 'Furniture' });
  const store = await createGodown(books.db, { name: 'Raw Material Store' });
  const finished = await createGodown(books.db, { name: 'Finished Goods' });
  const planks = await createStockItem(books.db, { name: 'Wooden Planks', opening_qty: 100_000, opening_value: 100_000_00, costing_method: 'Avg Cost' });
  const glue = await createStockItem(books.db, { name: 'Glue', opening_qty: 10_000, opening_value: 1000_00, costing_method: 'FIFO' });
  const chair = await createStockItem(books.db, { name: 'Wooden Chair', group_id: fg.id });
  const scrap = await createStockItem(books.db, { name: 'Scrap Wood' });
  const dust = await createStockItem(books.db, { name: 'Saw Dust' });
  const ty = (await books.voucherTypes()).reduce((m, t) => m.set(t.name, t.id), new Map<string, number>());
  await books.createVoucher({ type_id: ty.get('Stock Journal')!, date: '2026-04-05', entries: [], stock: [{ item_id: glue.id, godown_id: 1, qty: 10_000, rate: 120_00, amount: 1200_00 }] });
  return { books, ty, labour, power, fg, store, finished, planks, glue, chair, scrap, dust };
}

test('ensureMfg creates the Manufacturing Journal type under Stock Journal and is idempotent', async () => {
  const { books } = await setup();
  await ensureMfg(books.db);
  const types = (await books.voucherTypes()).filter((t) => t.name === 'Manufacturing Journal');
  assert.equal(types.length, 1);
  assert.equal(types[0].parent, 'Stock Journal');
  const id = await mfgVoucherTypeId(books.db);
  assert.equal(id, types[0].id);
  assert.ok(await isMfgVoucherType(books.db, id));
  const sj = (await books.voucherTypes()).find((t) => t.name === 'Stock Journal')!;
  assert.equal(await isMfgVoucherType(books.db, sj.id), false);
  const req = await books.createVoucherType({ name: 'Purchase Requisition', parent: 'Stock Journal' });
  await setUseAsMfgJournal(books.db, req.id, true);
  assert.deepEqual((await mfgVoucherTypes(books.db)).map((t) => t.name), ['Manufacturing Journal', 'Purchase Requisition']);
  await setUseAsMfgJournal(books.db, req.id, false);
  assert.equal((await mfgVoucherTypes(books.db)).length, 1);
  const sales = (await books.voucherTypes()).find((t) => t.name === 'Sales')!;
  await assert.rejects(setUseAsMfgJournal(books.db, sales.id, true), /Stock Journal/);
});

test('bill of materials create, list, alter, copy and delete', async () => {
  const { books, planks, glue, chair, scrap, store } = await setup();
  const std = await createBom(books.db, chair.id, {
    name: 'Standard',
    unit_qty: 1_000,
    lines: [
      { item_id: planks.id, godown_id: store.id, qty: 2_000 },
      { item_id: glue.id, godown_id: store.id, kind: 'Component', qty: 1_000 },
      { item_id: scrap.id, kind: 'Scrap', qty: 500, pct_bp: 20 },
    ],
  });
  assert.equal(std.name, 'Standard');
  assert.equal(std.item, 'Wooden Chair');
  assert.equal(std.lines.length, 3);
  assert.equal(std.lines[0].godown, 'Raw Material Store');
  assert.equal(std.lines[2].kind, 'Scrap');
  assert.equal(std.lines[2].pct_bp, 20);
  assert.equal(std.lines[0].pct_bp, 0);

  await assert.rejects(createBom(books.db, chair.id, { name: 'standard', unit_qty: 1_000, lines: [{ item_id: planks.id, qty: 1_000 }] }), /already exists/);
  await assert.rejects(createBom(books.db, chair.id, { name: 'Self', unit_qty: 1_000, lines: [{ item_id: chair.id, qty: 1_000 }] }), /component of itself/);
  await assert.rejects(createBom(books.db, chair.id, { name: 'Empty', unit_qty: 1_000, lines: [{ item_id: scrap.id, kind: 'Scrap', qty: 1_000 }] }), /at least one component/);
  await assert.rejects(createBom(books.db, chair.id, { name: 'Zero', unit_qty: 0, lines: [{ item_id: planks.id, qty: 1_000 }] }), /Unit of manufacture/);
  await assert.rejects(
    createBom(books.db, chair.id, { name: 'Over', unit_qty: 1_000, lines: [{ item_id: planks.id, qty: 1_000 }, { item_id: scrap.id, kind: 'Scrap', qty: 1_000, pct_bp: 10_001 }] }),
    /exceed 100%/
  );

  const copy = await createBom(books.db, chair.id, { name: 'Double Glue', unit_qty: 2_000, lines: copyBomLines(std) });
  const alt = await updateBom(books.db, copy.id, { name: 'Double Glue', unit_qty: 2_000, lines: copyBomLines(copy).map((l) => (l.item_id === glue.id ? { ...l, qty: 4_000 } : l)) });
  assert.equal(alt.lines.find((l) => l.item_id === glue.id)!.qty, 4_000);
  assert.equal(alt.unit_qty, 2_000);

  const list = await boms(books.db, chair.id);
  assert.deepEqual(list.map((b) => b.name), ['Standard', 'Double Glue']);
  assert.deepEqual((await itemsWithBom(books.db)).map((r) => [r.name, r.boms]), [['Wooden Chair', 2]]);
  assert.equal((await allBoms(books.db)).length, 2);

  const ex = await explodeBom(books.db, alt.id, 5_000);
  assert.deepEqual(ex.components.map((c) => [c.item, c.qty]), [['Wooden Planks', 5_000], ['Glue', 10_000]]);
  assert.deepEqual(ex.byproducts.map((c) => [c.item, c.kind, c.qty, c.pct_bp]), [['Scrap Wood', 'Scrap', 1_250, 20]]);

  await deleteBom(books.db, alt.id);
  assert.equal(await bom(books.db, alt.id), null);
  assert.equal((await boms(books.db, chair.id)).length, 1);
});

test('manufacturing journal moves stock only and values finished goods from Avg and FIFO components', async () => {
  const s = await setup();
  const { books, planks, glue, chair, scrap, labour, store, finished } = s;
  const std = await createBom(books.db, chair.id, {
    name: 'Standard',
    unit_qty: 1_000,
    lines: [
      { item_id: planks.id, godown_id: store.id, qty: 2_000 },
      { item_id: glue.id, godown_id: store.id, qty: 1_000 },
      { item_id: scrap.id, godown_id: store.id, kind: 'Scrap', qty: 500, pct_bp: 20 },
    ],
  });
  const before = await stockSummary(books.db, '2026-04-01', '2027-03-31');

  const plan = await planMfgJournal(books.db, { date: '2026-04-12', item_id: chair.id, bom_id: std.id, godown_id: finished.id, qty: 15_000, addl: [{ ledger_id: labour, pct_bp: 500 }] });
  assert.deepEqual(plan.components.map((c) => [c.item, c.qty, c.rate, c.amount]), [
    ['Wooden Planks', 30_000, 1000_00, 30_000_00],
    ['Glue', 15_000, 106_67, 1600_00],
  ]);
  assert.equal(plan.components_cost, 31_600_00);
  assert.equal(plan.addl_cost, 1580_00);
  assert.equal(plan.effective_cost, 33_180_00);
  assert.equal(plan.byproducts[0].amount, 6636);
  assert.equal(plan.primary_cost, 33_180_00 - 6636);
  assert.equal(plan.primary_pct_bp, 9980);
  assert.equal(plan.primary_rate, Math.round(((33_180_00 - 6636) * 1000) / 15_000));

  const j = await createMfgJournal(books, { date: '2026-04-12', item_id: chair.id, bom_id: std.id, godown_id: finished.id, qty: 15_000, addl: [{ ledger_id: labour, pct_bp: 500 }], narration: 'Batch 1' });
  assert.equal(j.voucher.type, 'Manufacturing Journal');
  assert.equal(j.voucher.parent, 'Stock Journal');
  assert.equal(j.voucher.entries.length, 0);
  assert.equal(j.voucher.narration, 'Batch 1');
  assert.deepEqual(j.voucher.stock.map((m) => [m.item, m.qty, m.godown_id]), [
    ['Wooden Planks', -30_000, store.id],
    ['Glue', -15_000, store.id],
    ['Wooden Chair', 15_000, finished.id],
    ['Scrap Wood', 7_500, store.id],
  ]);
  assert.ok(await isMfgJournal(books.db, j.voucher.id));
  assert.equal(j.bom, 'Standard');
  assert.equal(j.addl[0].ledger, 'Labour Charges');
  assert.equal(j.addl[0].pct_bp, 500);
  assert.equal(j.primary_pct_bp, 9980);
  assert.equal(j.byproducts[0].kind, 'Scrap');

  const after = await stockSummary(books.db, '2026-04-01', '2027-03-31');
  const row = (id: number) => after.rows.find((r) => r.item_id === id)!;
  assert.equal(row(chair.id).closing_qty, 15_000);
  assert.equal(row(chair.id).closing_value, 33_180_00 - 6636);
  assert.equal(row(planks.id).closing_qty, 70_000);
  assert.equal(row(planks.id).closing_value, 70_000_00);
  assert.equal(row(glue.id).closing_qty, 5_000);
  assert.equal(row(glue.id).closing_value, 600_00);
  assert.equal(row(glue.id).out_value, 1600_00);
  assert.equal(row(scrap.id).closing_value, 6636);
  assert.equal(after.closing_value, before.closing_value + 1580_00);

  const tb = await books.db.select<{ n: number }>('SELECT COUNT(*) AS n FROM entries');
  assert.equal(tb[0].n, 0);
});

test('issue cost follows FIFO layers and voucher order on the same date', async () => {
  const { books, glue } = await setup();
  assert.deepEqual(await issueCost(books.db, glue.id, 12_000, '2026-04-30'), { amount: 1240_00, rate: Math.round((1240_00 * 1000) / 12_000) });
  assert.deepEqual(await issueCost(books.db, glue.id, 5_000, '2026-04-01'), { amount: 500_00, rate: 100_00 });
});

test('co-product by percentage, by-product at a rate, edited rate, additional cost amount and alteration', async () => {
  const { books, planks, glue, chair, scrap, dust, labour, power } = await setup();
  const plan = await planMfgJournal(books.db, {
    date: '2026-04-20',
    item_id: chair.id,
    qty: 10_000,
    components: [{ item_id: planks.id, qty: 20_000 }, { item_id: glue.id, qty: 5_000, rate: 110_00 }],
    byproducts: [{ item_id: scrap.id, kind: 'Co-Product', qty: 2_000, pct_bp: 1000 }, { item_id: dust.id, kind: 'By-Product', qty: 3_000, rate: 10_00 }],
    addl: [{ ledger_id: labour, amount: 1000_00 }, { ledger_id: power, pct_bp: 250 }],
  });
  assert.equal(plan.components[1].amount, 550_00);
  assert.equal(plan.components[1].rate_fixed, true);
  assert.equal(plan.components_cost, 20_550_00);
  assert.equal(plan.addl_cost, 1000_00 + 513_75);
  assert.equal(plan.effective_cost, 22_063_75);
  assert.equal(plan.byproducts[0].amount, 2206_38);
  assert.equal(plan.byproducts[1].amount, 30_00);
  assert.equal(plan.primary_cost, 22_063_75 - 2206_38 - 30_00);

  await assert.rejects(
    planMfgJournal(books.db, { date: '2026-04-20', item_id: chair.id, qty: 1_000, components: [{ item_id: planks.id, qty: 1_000 }], byproducts: [{ item_id: scrap.id, kind: 'Scrap', qty: 1_000, rate: 5000_00 }] }),
    /exceeds the effective cost/
  );
  await assert.rejects(planMfgJournal(books.db, { date: '2026-04-20', item_id: chair.id, qty: 1_000, components: [] }), /at least one component/);
  await assert.rejects(planMfgJournal(books.db, { date: '2026-04-20', item_id: chair.id, qty: 1_000, components: [{ item_id: chair.id, qty: 1_000 }] }), /own manufacture/);

  const j = await createMfgJournal(books, { date: '2026-04-20', item_id: chair.id, qty: 10_000, components: [{ item_id: planks.id, qty: 20_000 }, { item_id: glue.id, qty: 5_000 }], byproducts: [{ item_id: dust.id, kind: 'By-Product', qty: 3_000, rate: 10_00 }] });
  assert.equal(j.components_cost, 20_000_00 + 500_00);
  assert.equal(j.primary_cost, 20_500_00 - 30_00);
  const altered = await updateMfgJournal(books, j.voucher.id, { date: '2026-04-20', item_id: chair.id, qty: 10_000, components: [{ item_id: planks.id, qty: 20_000 }, { item_id: glue.id, qty: 5_000 }], byproducts: [] });
  assert.equal(altered.voucher.number, j.voucher.number);
  assert.equal(altered.components[1].amount, 500_00);
  assert.equal(altered.primary_cost, 20_500_00);
  assert.equal(altered.byproducts.length, 0);
  const sum = await stockSummary(books.db, '2026-04-01', '2027-03-31');
  assert.equal(sum.rows.find((r) => r.item_id === chair.id)!.closing_value, 20_500_00);
  assert.equal(sum.rows.find((r) => r.item_id === dust.id)!.closing_qty, 0);

  await books.deleteVoucher(j.voucher.id);
  assert.equal(await isMfgJournal(books.db, j.voucher.id), false);
  assert.equal(await mfgJournal(books, j.voucher.id), null);
});

test('cost estimation, job costing and material requirement', async () => {
  const { books, planks, glue, chair, scrap, labour, store, finished, fg } = await setup();
  const std = await createBom(books.db, chair.id, {
    name: 'Standard',
    unit_qty: 1_000,
    lines: [
      { item_id: planks.id, godown_id: store.id, qty: 2_000 },
      { item_id: glue.id, godown_id: 1, qty: 1_000 },
      { item_id: scrap.id, kind: 'Scrap', qty: 500, pct_bp: 20 },
    ],
  });
  await createBom(books.db, chair.id, { name: 'Heavy', unit_qty: 1_000, lines: [{ item_id: planks.id, qty: 3_000 }] });

  const est = await costEstimation(books.db, '2026-04-30');
  assert.equal(est.rows.length, 1);
  const r = est.rows[0];
  assert.equal(r.bom, 'Standard');
  assert.equal(r.qty, 1_000);
  assert.deepEqual(r.lines.map((l) => [l.name, l.kind, l.qty, l.rate, l.amount]), [
    ['Wooden Planks', 'Component', 2_000, 1000_00, 2000_00],
    ['Glue', 'Component', 1_000, 100_00, 100_00],
    ['Scrap Wood', 'Scrap', 500, 840, 420],
  ]);
  assert.equal(r.components_cost, 2100_00);
  assert.equal(r.amount, 2100_00 - 420);
  assert.equal(r.cost, 2100_00 - 420);
  const all = await costEstimation(books.db, '2026-04-30', { allBoms: true });
  assert.deepEqual(all.rows.map((x) => [x.bom, x.amount]), [['Standard', 2095_80], ['Heavy', 3000_00]]);
  assert.equal((await costEstimation(books.db, '2026-04-30', { groupId: fg.id })).rows.length, 1);
  const other = await createStockGroup(books.db, { name: 'Other' });
  assert.equal((await costEstimation(books.db, '2026-04-30', { groupId: other.id })).rows.length, 0);

  await createMfgJournal(books, { date: '2026-04-12', item_id: chair.id, bom_id: std.id, godown_id: finished.id, qty: 15_000, addl: [{ ledger_id: labour, pct_bp: 500 }] });
  await createMfgJournal(books, { date: '2026-05-02', item_id: chair.id, bom_id: std.id, godown_id: finished.id, qty: 5_000 });
  const outside = await createMfgJournal(books, { date: '2026-06-02', item_id: chair.id, bom_id: std.id, qty: 1_000 });
  const cancelled = await createMfgJournal(books, { date: '2026-05-03', item_id: chair.id, bom_id: std.id, qty: 1_000 });
  await books.cancelVoucher(cancelled.voucher.id);

  const job = await jobCosting(books.db, chair.id, '2026-04-01', '2026-05-31');
  assert.equal(job.vouchers.length, 2);
  assert.equal(job.totals.qty, 20_000);
  assert.equal(job.totals.addl_cost, 1580_00);
  assert.equal(job.consumed.find((c) => c.name === 'Wooden Planks')!.qty, 40_000);
  assert.equal(job.consumed.find((c) => c.name === 'Wooden Planks')!.value, 40_000_00);
  assert.equal(job.consumed.find((c) => c.name === 'Glue')!.qty, 20_000);
  assert.equal(job.consumed.find((c) => c.name === 'Glue')!.value, 2200_00);
  assert.equal(job.produced[0].kind, 'Primary');
  assert.equal(job.produced[0].qty, 20_000);
  assert.equal(job.produced[1].kind, 'Scrap');
  assert.equal(job.produced[1].qty, 10_000);
  assert.equal(job.totals.components_cost, job.consumed.reduce((s, c) => s + c.value, 0));
  assert.equal(job.totals.primary_cost + job.totals.byproduct_cost, job.totals.components_cost + job.totals.addl_cost);
  assert.equal(job.produced[0].value, job.totals.primary_cost);
  assert.deepEqual(job.addl.map((a) => ({ ...a })), [{ ledger_id: labour, ledger: 'Labour Charges', amount: 1580_00 }]);
  assert.ok(!job.vouchers.some((v) => v.voucher_id === outside.voucher.id));

  const req = await materialRequirement(books.db, { item_id: chair.id, qty: 30_000, as_at: '2026-05-31' });
  assert.equal(req.bom, 'Standard');
  const planksRow = req.rows.find((x) => x.name === 'Wooden Planks')!;
  assert.equal(planksRow.required, 60_000);
  assert.equal(planksRow.in_stock, 60_000);
  assert.equal(planksRow.godown_stock, -40_000);
  assert.equal(planksRow.shortfall, 0);
  const glueRow = req.rows.find((x) => x.name === 'Glue')!;
  assert.equal(glueRow.required, 30_000);
  assert.equal(glueRow.in_stock, 0);
  assert.equal(glueRow.godown_stock, 0);
  assert.equal(glueRow.shortfall, 30_000);
  assert.equal(glueRow.rate, 120_00);
  assert.equal(glueRow.shortfall_value, 3600_00);
  assert.equal(req.max_producible, 0);
  assert.equal(req.rows.length, 2);

  const early = await materialRequirement(books.db, { item_id: chair.id, bom_id: std.id, qty: 30_000, as_at: '2026-04-30' });
  assert.equal(early.rows.find((x) => x.name === 'Wooden Planks')!.in_stock, 70_000);
  assert.equal(early.rows.find((x) => x.name === 'Glue')!.in_stock, 5_000);
  assert.equal(early.max_producible, 5_000);
  await assert.rejects(materialRequirement(books.db, { item_id: planks.id, qty: 1_000, as_at: '2026-04-30' }), /no bill of materials/);
});
