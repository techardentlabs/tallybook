import { one, type Stmt } from './db.ts';
import type { Books } from './books.ts';
import { child, childs, descendants, parseXml, textOf, XmlWriter, type XNode } from './xml.ts';
import { clean, isIsoDate, newGuid } from './util.ts';
import { decimalToPaise, paiseToDecimal, tallyDate, type ImportError } from './tally-xml.ts';
import { STOCK_VOUCHER_TYPES } from './schema.ts';
import {
  createGodown, createStockCategory, createStockGroup, createStockItem, createUnit, godowns, parseQty, stockCategories, stockGroups, stockItems, units, updateStockItem, QTY_SCALE,
} from './inventory.ts';
import {
  allocationStmts, costCategories, costCentres, createCostCategory, createCostCentre, ensureCosting, updateCostCentre, validateAllocations, voucherAllocations, type AllocationInput,
} from './costing.ts';

export const EXCHANGE_SCHEMA: string[] = [];

export interface Xml2Report {
  dryRun: boolean;
  created: { units: number; godowns: number; stock_groups: number; stock_categories: number; stock_items: number; cost_categories: number; cost_centres: number; voucher_types: number; vouchers: number };
  updated: { stock_items: number; cost_centres: number; voucher_types: number; vouchers: number };
  skipped: { masters: number; vouchers: number };
  deleted: { vouchers: number };
  warnings: string[];
  errors: ImportError[];
  totals: { voucher_amount: number; stock_value: number; stock_lines: number };
}

export interface Xml2Options {
  dryRun?: boolean;
  behaviour?: 'ignore' | 'modify';
}

function newReport(dryRun: boolean): Xml2Report {
  return {
    dryRun,
    created: { units: 0, godowns: 0, stock_groups: 0, stock_categories: 0, stock_items: 0, cost_categories: 0, cost_centres: 0, voucher_types: 0, vouchers: 0 },
    updated: { stock_items: 0, cost_centres: 0, voucher_types: 0, vouchers: 0 },
    skipped: { masters: 0, vouchers: 0 },
    deleted: { vouchers: 0 },
    warnings: [],
    errors: [],
    totals: { voucher_amount: 0, stock_value: 0, stock_lines: 0 },
  };
}

const toTallyDate = (iso: string) => iso.replaceAll('-', '');
const yes = (v: string) => /^yes$/i.test(v.trim());
const isPrimary = (s: string) => !s || /^primary$/i.test(s.trim()) || /^not applicable$/i.test(s.trim());

function nameOf(n: XNode): string {
  if (n.attrs.NAME) return n.attrs.NAME.trim();
  const list = child(n, 'LANGUAGENAME.LIST');
  const nl = list ? child(list, 'NAME.LIST') : child(n, 'NAME.LIST');
  const first = nl ? textOf(child(nl, 'NAME')) : '';
  return first || textOf(n, 'NAME');
}

function aliasOf(n: XNode): string {
  const list = child(n, 'LANGUAGENAME.LIST');
  const nl = list ? child(list, 'NAME.LIST') : child(n, 'NAME.LIST');
  return nl ? childs(nl, 'NAME').map((x) => x.text.trim()).filter(Boolean)[1] ?? '' : '';
}

function envelopeOpen(w: XmlWriter, id: string, company: string) {
  w.open('ENVELOPE');
  w.open('HEADER');
  w.leaf('VERSION', 1);
  w.leaf('TALLYREQUEST', 'Import');
  w.leaf('TYPE', 'Data');
  w.leaf('ID', id);
  w.close('HEADER');
  w.open('BODY');
  w.open('DESC');
  w.open('STATICVARIABLES');
  w.leaf('SVCURRENTCOMPANY', company);
  w.close('STATICVARIABLES');
  w.close('DESC');
  w.open('DATA');
  w.open('TALLYMESSAGE', { 'xmlns:UDF': 'TallyUDF' });
}

function envelopeClose(w: XmlWriter) {
  w.close('TALLYMESSAGE');
  w.close('DATA');
  w.close('BODY');
  w.close('ENVELOPE');
}

function nameList(w: XmlWriter, name: string, alias: string) {
  w.open('LANGUAGENAME.LIST');
  w.open('NAME.LIST', { TYPE: 'String' });
  w.leaf('NAME', name);
  if (alias) w.leaf('NAME', alias);
  w.close('NAME.LIST');
  w.close('LANGUAGENAME.LIST');
}

const NUMBERING_LABEL = { auto: 'Automatic', auto_override: 'Automatic (Manual Override)', manual: 'Manual', none: 'None' } as const;
const NUMBERING_PARSE: Record<string, 'auto' | 'auto_override' | 'manual' | 'none'> = {
  automatic: 'auto',
  auto: 'auto',
  'multi-user auto': 'auto',
  'automatic (manual override)': 'auto_override',
  'auto (manual override)': 'auto_override',
  manual: 'manual',
  none: 'none',
};

const COSTING_EXPORT: Record<string, string> = { 'Avg Cost': 'Avg. Cost', 'Std Cost': 'Std. Cost', FIFO: 'FIFO', LIFO: 'LIFO', 'Last Purchase Cost': 'Last Purchase Cost' };

function costingFromXml(raw: string): string {
  const t = raw.toLowerCase();
  if (t.startsWith('avg')) return 'Avg Cost';
  if (t.startsWith('fifo')) return 'FIFO';
  if (t.startsWith('lifo')) return 'LIFO';
  if (t.startsWith('last')) return 'Last Purchase Cost';
  if (t.startsWith('std')) return 'Std Cost';
  return '';
}

function qtyText(milli: number, unit: string): string {
  const v = Math.abs(milli) / QTY_SCALE;
  return `${Number.isInteger(v) ? v : v.toFixed(3)} ${unit}`;
}

function parseQtyText(raw: string): number | null {
  const m = /-?[\d,]*\.?\d+/.exec(raw.replace(/\s+/g, ' '));
  return m ? parseQty(m[0].replace('-', '')) : null;
}

function rateText(paise: number, unit: string): string {
  return `${paiseToDecimal(paise)}/${unit}`;
}

function parseRateText(raw: string): number {
  return decimalToPaise(raw.split('/')[0] ?? '');
}

export async function exportMastersXml2(books: Books): Promise<string> {
  const company = await books.requireCompany();
  const db = books.db;
  await ensureCosting(db);
  const us = await units(db);
  const gs = await stockGroups(db);
  const cats = await stockCategories(db);
  const gd = await godowns(db);
  const items = await stockItems(db);
  const ccats = await costCategories(db);
  const centres = await costCentres(db);
  const types = (await books.voucherTypes()).filter((t) => !t.is_system);
  const gname = new Map(gs.map((g) => [g.id, g.name]));
  const cname = new Map(cats.map((g) => [g.id, g.name]));
  const dname = new Map(gd.map((g) => [g.id, g.name]));
  const w = new XmlWriter();
  envelopeOpen(w, 'All Masters', company.name);
  for (const u of us) {
    w.open('UNIT', { NAME: u.symbol, ACTION: 'Create' });
    w.leaf('NAME', u.symbol);
    w.leaf('ISSIMPLEUNIT', 'Yes');
    if (u.formal_name) w.leaf('ORIGINALNAME', u.formal_name);
    w.leaf('DECIMALPLACES', u.decimals);
    w.close('UNIT');
  }
  for (const g of gd) {
    w.open('GODOWN', { NAME: g.name, ACTION: 'Create' });
    w.leaf('PARENT', g.parent_id ? dname.get(g.parent_id) ?? '' : '');
    nameList(w, g.name, '');
    w.close('GODOWN');
  }
  for (const g of gs) {
    w.open('STOCKGROUP', { NAME: g.name, ACTION: 'Create' });
    w.leaf('PARENT', g.parent_id ? gname.get(g.parent_id) ?? '' : '');
    nameList(w, g.name, g.alias);
    w.close('STOCKGROUP');
  }
  for (const c of cats) {
    w.open('STOCKCATEGORY', { NAME: c.name, ACTION: 'Create' });
    w.leaf('PARENT', c.parent_id ? cname.get(c.parent_id) ?? '' : '');
    nameList(w, c.name, '');
    w.close('STOCKCATEGORY');
  }
  for (const i of items) {
    w.open('STOCKITEM', { NAME: i.name, ACTION: 'Create' });
    w.leaf('GUID', i.guid);
    w.leaf('PARENT', i.group_id ? gname.get(i.group_id) ?? '' : '');
    w.leaf('CATEGORY', i.category_id ? cname.get(i.category_id) ?? '' : '');
    w.leaf('BASEUNITS', i.unit);
    if (i.costing_method) w.leaf('COSTINGMETHOD', COSTING_EXPORT[i.costing_method] ?? i.costing_method);
    w.leaf('ISBATCHWISEON', i.maintain_batches ? 'Yes' : 'No');
    if (i.opening_qty) {
      w.leaf('OPENINGBALANCE', qtyText(i.opening_qty, i.unit));
      w.leaf('OPENINGVALUE', paiseToDecimal(-i.opening_value));
      w.leaf('OPENINGRATE', rateText(i.opening_rate, i.unit));
    }
    if (i.hsn_sac || i.rate_bp) {
      w.open('GSTDETAILS.LIST');
      w.leaf('TAXABILITY', i.taxability || 'Taxable');
      if (i.hsn_sac) w.leaf('HSNCODE', i.hsn_sac);
      if (i.rate_bp) {
        w.open('STATEWISEDETAILS.LIST');
        w.leaf('STATENAME', 'Any');
        const half = paiseToDecimal(Math.round(i.rate_bp / 2)).replace(/0$/, '').replace(/\.$/, '');
        const full = paiseToDecimal(i.rate_bp).replace(/0$/, '').replace(/\.$/, '');
        for (const [head, rate] of [['CGST', half], ['SGST/UTGST', half], ['IGST', full]]) {
          w.open('RATEDETAILS.LIST');
          w.leaf('GSTRATEDUTYHEAD', head);
          w.leaf('GSTRATE', rate);
          w.close('RATEDETAILS.LIST');
        }
        w.close('STATEWISEDETAILS.LIST');
      }
      w.close('GSTDETAILS.LIST');
    }
    if (i.part_no) w.leaf('PARTNUMBER', i.part_no);
    if (i.description) w.leaf('DESCRIPTION', i.description);
    nameList(w, i.name, i.alias);
    w.close('STOCKITEM');
  }
  for (const c of ccats) {
    if (c.name === 'Primary Cost Category') continue;
    w.open('COSTCATEGORY', { NAME: c.name, ACTION: 'Create' });
    w.leaf('GUID', c.guid);
    w.leaf('ALLOCATEREVENUE', c.alloc_revenue ? 'Yes' : 'No');
    w.leaf('ALLOCATENONREVENUE', c.alloc_non_revenue ? 'Yes' : 'No');
    nameList(w, c.name, c.alias);
    w.close('COSTCATEGORY');
  }
  for (const c of centres) {
    w.open('COSTCENTRE', { NAME: c.name, ACTION: 'Create' });
    w.leaf('GUID', c.guid);
    w.leaf('PARENT', c.parent ?? '');
    w.leaf('CATEGORY', c.category);
    nameList(w, c.name, c.alias);
    w.close('COSTCENTRE');
  }
  for (const t of types) {
    w.open('VOUCHERTYPE', { NAME: t.name, ACTION: 'Create' });
    w.leaf('GUID', t.guid);
    w.leaf('PARENT', t.parent);
    w.leaf('NUMBERINGMETHOD', NUMBERING_LABEL[t.numbering]);
    w.leaf('PREVENTDUPLICATES', t.prevent_duplicates ? 'Yes' : 'No');
    w.leaf('ISACTIVE', t.is_active ? 'Yes' : 'No');
    w.close('VOUCHERTYPE');
  }
  envelopeClose(w);
  return w.toString();
}

interface Pending {
  n: XNode;
  name: string;
  parent: string;
}

function pendingOf(root: XNode, tag: string): Pending[] {
  return descendants(root, tag)
    .map((n) => ({ n, name: nameOf(n), parent: textOf(n, 'PARENT') }))
    .filter((p) => p.name);
}

async function inOrder(items: Pending[], have: Map<string, number>, create: (p: Pending, parentId: number | null) => Promise<number>, rep: Xml2Report, kind: string, onExisting?: (p: Pending, id: number) => Promise<void>) {
  let queue = items;
  let progress = true;
  while (queue.length && progress) {
    progress = false;
    const next: Pending[] = [];
    for (const p of queue) {
      const key = p.name.toLowerCase();
      const parentId = isPrimary(p.parent) ? null : have.get(p.parent.toLowerCase()) ?? undefined;
      if (parentId === undefined) {
        next.push(p);
        continue;
      }
      progress = true;
      if (have.has(key)) {
        if (onExisting) await onExisting(p, have.get(key)!);
        else rep.skipped.masters += 1;
        continue;
      }
      try {
        have.set(key, await create(p, parentId));
      } catch (e) {
        rep.errors.push({ kind, name: p.name, message: (e as Error).message });
      }
    }
    queue = next;
  }
  for (const p of queue) rep.errors.push({ kind, name: p.name, message: `Referenced master is missing: parent "${p.parent}"` });
}

export async function importMastersXml2(books: Books, xml: string, opts: Xml2Options = {}): Promise<Xml2Report> {
  const dry = !!opts.dryRun;
  const modify = opts.behaviour === 'modify';
  const rep = newReport(dry);
  const root = parseXml(xml);
  const db = books.db;
  await books.requireCompany();
  await ensureCosting(db);
  let fake = -1;
  const err = (kind: string, name: string, message: string) => rep.errors.push({ kind, name, message });

  const unitMap = new Map<string, number>();
  for (const u of await units(db)) {
    unitMap.set(u.symbol.toLowerCase(), u.id);
    if (u.formal_name) unitMap.set(u.formal_name.toLowerCase(), u.id);
  }
  for (const n of descendants(root, 'UNIT')) {
    const symbol = nameOf(n);
    if (!symbol) continue;
    if (unitMap.has(symbol.toLowerCase())) {
      rep.skipped.masters += 1;
      continue;
    }
    if (n.children.length && textOf(n, 'ISSIMPLEUNIT') && !yes(textOf(n, 'ISSIMPLEUNIT'))) {
      err('unit', symbol, 'Compound units are not supported');
      continue;
    }
    try {
      const id = dry ? fake-- : (await createUnit(db, { symbol, formal_name: textOf(n, 'ORIGINALNAME'), decimals: parseInt(textOf(n, 'DECIMALPLACES'), 10) || 0 })).id;
      unitMap.set(symbol.toLowerCase(), id);
      rep.created.units += 1;
    } catch (e) {
      err('unit', symbol, (e as Error).message);
    }
  }

  const godownMap = new Map((await godowns(db)).map((g) => [g.name.toLowerCase(), g.id]));
  await inOrder(
    pendingOf(root, 'GODOWN'),
    godownMap,
    async (p, parentId) => {
      rep.created.godowns += 1;
      return dry ? fake-- : (await createGodown(db, { name: p.name, parent_id: parentId })).id;
    },
    rep,
    'godown'
  );

  const sgMap = new Map((await stockGroups(db)).map((g) => [g.name.toLowerCase(), g.id]));
  await inOrder(
    pendingOf(root, 'STOCKGROUP'),
    sgMap,
    async (p, parentId) => {
      rep.created.stock_groups += 1;
      return dry ? fake-- : (await createStockGroup(db, { name: p.name, parent_id: parentId, alias: aliasOf(p.n) })).id;
    },
    rep,
    'stock group'
  );

  const scMap = new Map((await stockCategories(db)).map((g) => [g.name.toLowerCase(), g.id]));
  await inOrder(
    pendingOf(root, 'STOCKCATEGORY'),
    scMap,
    async (p, parentId) => {
      rep.created.stock_categories += 1;
      return dry ? fake-- : (await createStockCategory(db, { name: p.name, parent_id: parentId })).id;
    },
    rep,
    'stock category'
  );

  const itemMap = new Map<string, { id: number }>((await stockItems(db)).map((i) => [i.name.toLowerCase(), i]));
  let batchWarned = false;
  for (const n of descendants(root, 'STOCKITEM')) {
    const name = nameOf(n);
    if (!name) continue;
    const existing = itemMap.get(name.toLowerCase());
    if (existing && !modify) {
      rep.skipped.masters += 1;
      continue;
    }
    const unitName = textOf(n, 'BASEUNITS');
    const unitId = unitName ? unitMap.get(unitName.toLowerCase()) : 1;
    if (!unitId) {
      err('stock item', name, `Referenced master is missing: unit "${unitName}"`);
      continue;
    }
    const parent = textOf(n, 'PARENT');
    const groupId = isPrimary(parent) ? null : sgMap.get(parent.toLowerCase());
    if (groupId === undefined) {
      err('stock item', name, `Referenced master is missing: stock group "${parent}"`);
      continue;
    }
    const cat = textOf(n, 'CATEGORY');
    const catId = isPrimary(cat) ? null : scMap.get(cat.toLowerCase());
    if (catId === undefined) {
      err('stock item', name, `Referenced master is missing: stock category "${cat}"`);
      continue;
    }
    const qtyRaw = textOf(n, 'OPENINGBALANCE');
    const qty = qtyRaw ? parseQtyText(qtyRaw) : 0;
    if (qty === null) {
      err('stock item', name, `Invalid opening balance "${qtyRaw}"`);
      continue;
    }
    const valueRaw = textOf(n, 'OPENINGVALUE');
    const value = valueRaw ? Math.abs(decimalToPaise(valueRaw)) : 0;
    const hsn = descendants(n, 'HSNCODE')[0]?.text.trim() ?? '';
    const rates = descendants(n, 'RATEDETAILS.LIST')
      .map((r) => ({ head: textOf(r, 'GSTRATEDUTYHEAD'), rate: parseFloat(textOf(r, 'GSTRATE')) }))
      .filter((r) => r.rate > 0);
    const igst = rates.find((r) => /^igst/i.test(r.head))?.rate ?? (rates.length ? rates.reduce((s, r) => s + (/^(cgst|sgst)/i.test(r.head) ? r.rate : 0), 0) || rates[0].rate : 0);
    const taxability = descendants(n, 'TAXABILITY')[0]?.text.trim() ?? '';
    const batchOn = yes(textOf(n, 'ISBATCHWISEON'));
    if (!batchWarned && descendants(n, 'BATCHNAME').length) {
      batchWarned = true;
      rep.warnings.push('Batch names on stock items are not stored');
    }
    const input = {
      name,
      alias: aliasOf(n),
      group_id: groupId,
      category_id: catId,
      unit_id: unitId,
      hsn_sac: hsn,
      rate_bp: Math.round(igst * 100),
      taxability: taxability || 'Taxable',
      opening_qty: qty,
      opening_value: qty ? value : 0,
      costing_method: costingFromXml(textOf(n, 'COSTINGMETHOD')) || 'Avg Cost',
      maintain_batches: batchOn ? 1 : 0,
      part_no: textOf(n, 'PARTNUMBER'),
      description: textOf(n, 'DESCRIPTION'),
    };
    try {
      if (existing) {
        if (!dry) await updateStockItem(db, existing.id, input);
        rep.updated.stock_items += 1;
      } else {
        if (!dry) itemMap.set(name.toLowerCase(), await createStockItem(db, input));
        else itemMap.set(name.toLowerCase(), { id: fake-- });
        rep.created.stock_items += 1;
      }
      rep.totals.stock_value += value;
    } catch (e) {
      err('stock item', name, (e as Error).message);
    }
  }

  const ccatMap = new Map((await costCategories(db)).map((c) => [c.name.toLowerCase(), c.id]));
  for (const n of descendants(root, 'COSTCATEGORY')) {
    const name = nameOf(n);
    if (!name) continue;
    if (ccatMap.has(name.toLowerCase())) {
      rep.skipped.masters += 1;
      continue;
    }
    try {
      ccatMap.set(name.toLowerCase(), dry ? fake-- : (await createCostCategory(db, { name, alias: aliasOf(n), alloc_revenue: !/^no$/i.test(textOf(n, 'ALLOCATEREVENUE')), alloc_non_revenue: yes(textOf(n, 'ALLOCATENONREVENUE')) })).id);
      rep.created.cost_categories += 1;
    } catch (e) {
      err('cost category', name, (e as Error).message);
    }
  }

  const centreMap = new Map((await costCentres(db)).map((c) => [c.name.toLowerCase(), c.id]));
  await inOrder(
    pendingOf(root, 'COSTCENTRE'),
    centreMap,
    async (p, parentId) => {
      const cat = textOf(p.n, 'CATEGORY');
      const catId = isPrimary(cat) ? 1 : ccatMap.get(cat.toLowerCase());
      if (!catId) throw new Error(`Referenced master is missing: cost category "${cat}"`);
      rep.created.cost_centres += 1;
      return dry ? fake-- : (await createCostCentre(db, { name: p.name, alias: aliasOf(p.n), category_id: catId, parent_id: parentId })).id;
    },
    rep,
    'cost centre',
    async (p, id) => {
      if (!modify) {
        rep.skipped.masters += 1;
        return;
      }
      const cat = textOf(p.n, 'CATEGORY');
      const catId = isPrimary(cat) ? 1 : ccatMap.get(cat.toLowerCase());
      const parentId = isPrimary(p.parent) ? null : centreMap.get(p.parent.toLowerCase()) ?? null;
      if (!catId) {
        err('cost centre', p.name, `Referenced master is missing: cost category "${cat}"`);
        return;
      }
      try {
        if (!dry) await updateCostCentre(db, id, { name: p.name, alias: aliasOf(p.n), category_id: catId, parent_id: parentId });
        rep.updated.cost_centres += 1;
      } catch (e) {
        err('cost centre', p.name, (e as Error).message);
      }
    }
  );

  const types = new Map((await books.voucherTypes()).map((t) => [t.name.toLowerCase(), t]));
  const systemParents = new Set((await books.voucherTypes()).filter((t) => t.is_system).map((t) => t.name));
  for (const n of descendants(root, 'VOUCHERTYPE')) {
    const name = nameOf(n);
    if (!name) continue;
    const method = textOf(n, 'NUMBERINGMETHOD') || textOf(n, 'NUMBERINGSTYLE');
    const numbering = NUMBERING_PARSE[method.toLowerCase()];
    const existing = types.get(name.toLowerCase());
    try {
      if (existing) {
        if (!modify || existing.is_system) {
          rep.skipped.masters += 1;
          continue;
        }
        if (!dry) {
          await books.updateVoucherType(existing.id, {
            numbering: numbering ?? existing.numbering,
            prevent_duplicates: textOf(n, 'PREVENTDUPLICATES') ? (yes(textOf(n, 'PREVENTDUPLICATES')) ? 1 : 0) : existing.prevent_duplicates,
            is_active: textOf(n, 'ISACTIVE') ? (yes(textOf(n, 'ISACTIVE')) ? 1 : 0) : existing.is_active,
          });
        }
        rep.updated.voucher_types += 1;
        continue;
      }
      const parent = textOf(n, 'PARENT');
      if (!systemParents.has(parent)) {
        err('voucher type', name, `Parent type "${parent}" is not supported`);
        continue;
      }
      if (!dry) {
        const t = await books.createVoucherType({ name, parent, numbering: numbering ?? 'auto', prevent_duplicates: textOf(n, 'PREVENTDUPLICATES') ? (yes(textOf(n, 'PREVENTDUPLICATES')) ? 1 : 0) : 1 });
        types.set(name.toLowerCase(), t);
      } else types.set(name.toLowerCase(), { id: fake--, name, parent } as never);
      rep.created.voucher_types += 1;
    } catch (e) {
      err('voucher type', name, (e as Error).message);
    }
  }

  const currencies = descendants(root, 'CURRENCY').length;
  if (currencies) rep.warnings.push(`${currencies} currency master(s) ignored: multi-currency is not supported`);
  return rep;
}

export async function exportVouchersXml2(books: Books, from: string, to: string): Promise<string> {
  const company = await books.requireCompany();
  const db = books.db;
  await ensureCosting(db);
  const ids = await db.select<{ id: number }>('SELECT id FROM vouchers WHERE date >= ? AND date <= ? ORDER BY date, id', [from, to]);
  const names = new Map((await books.ledgers()).map((l) => [l.id, l.name]));
  const itemRows = new Map((await stockItems(db)).map((i) => [i.id, i]));
  const godownNames = new Map((await godowns(db)).map((g) => [g.id, g.name]));
  const w = new XmlWriter();
  envelopeOpen(w, 'Vouchers', company.name);
  const BILL_LABEL = { new: 'New Ref', agst: 'Agst Ref', adv: 'Advance', onacc: 'On Account', opening: 'New Ref' } as const;
  const writeCost = (list: { category: string; cost_centre: string; amount: number }[], deemed: boolean) => {
    const cats = [...new Set(list.map((a) => a.category))];
    for (const cat of cats) {
      w.open('CATEGORYALLOCATIONS.LIST');
      w.leaf('CATEGORY', cat);
      w.leaf('ISDEEMEDPOSITIVE', deemed ? 'Yes' : 'No');
      for (const a of list.filter((x) => x.category === cat)) {
        w.open('COSTCENTREALLOCATIONS.LIST');
        w.leaf('NAME', a.cost_centre);
        w.leaf('AMOUNT', paiseToDecimal(-a.amount));
        w.close('COSTCENTREALLOCATIONS.LIST');
      }
      w.close('CATEGORYALLOCATIONS.LIST');
    }
  };
  for (const r of ids) {
    const v = (await books.voucher(r.id))!;
    const allocs = await voucherAllocations(db, v.id);
    const stockOnly = (STOCK_VOUCHER_TYPES as readonly string[]).includes(v.parent);
    const covered = new Map<number, number>();
    for (const s of v.stock) if (s.ledger_id) covered.set(s.ledger_id, (covered.get(s.ledger_id) ?? 0) + (s.qty > 0 ? s.amount : -s.amount));
    const costUsed = new Set<number>();
    const attr: Record<string, string> = { REMOTEID: v.guid, VCHTYPE: v.parent, ACTION: 'Create' };
    if (v.stock.length && v.parent !== 'Stock Journal') attr.OBJVIEW = 'Invoice Voucher View';
    else if (!v.stock.length) attr.OBJVIEW = 'Accounting Voucher View';
    w.open('VOUCHER', attr);
    w.leaf('DATE', toTallyDate(v.date));
    w.leaf('GUID', v.guid);
    w.leaf('VOUCHERTYPENAME', v.type);
    w.leaf('VOUCHERNUMBER', v.number);
    if (v.reference) w.leaf('REFERENCE', v.reference);
    if (v.party_id && names.has(v.party_id)) w.leaf('PARTYLEDGERNAME', names.get(v.party_id)!);
    if (v.place_of_supply) w.leaf('PLACEOFSUPPLY', v.place_of_supply);
    if (v.narration) w.leaf('NARRATION', v.narration);
    if (v.stock.length && v.entries.length) w.leaf('ISINVOICE', 'Yes');
    for (const s of v.stock) {
      const item = itemRows.get(s.item_id);
      const unit = item?.unit ?? 'Nos';
      const inward = s.qty > 0;
      const signed = inward ? -s.amount : s.amount;
      w.open('ALLINVENTORYENTRIES.LIST');
      w.leaf('STOCKITEMNAME', s.item);
      w.leaf('ISDEEMEDPOSITIVE', inward ? 'Yes' : 'No');
      w.leaf('RATE', rateText(s.rate, unit));
      if (s.discount_bp) w.leaf('DISCOUNT', paiseToDecimal(s.discount_bp));
      w.leaf('AMOUNT', paiseToDecimal(signed));
      w.leaf('ACTUALQTY', qtyText(s.qty, unit));
      w.leaf('BILLEDQTY', qtyText(s.qty, unit));
      w.open('BATCHALLOCATIONS.LIST');
      w.leaf('GODOWNNAME', godownNames.get(s.godown_id ?? 1) ?? 'Main Location');
      w.leaf('BATCHNAME', 'Primary Batch');
      w.leaf('AMOUNT', paiseToDecimal(signed));
      w.leaf('ACTUALQTY', qtyText(s.qty, unit));
      w.leaf('BILLEDQTY', qtyText(s.qty, unit));
      w.close('BATCHALLOCATIONS.LIST');
      if (s.ledger_id && names.has(s.ledger_id)) {
        w.open('ACCOUNTINGALLOCATIONS.LIST');
        w.leaf('LEDGERNAME', names.get(s.ledger_id)!);
        w.leaf('ISDEEMEDPOSITIVE', inward ? 'Yes' : 'No');
        w.leaf('AMOUNT', paiseToDecimal(signed));
        const entry = v.entries.find((e) => e.ledger_id === s.ledger_id);
        const own = entry ? allocs.get(entry.id) : undefined;
        if (entry && own?.length && covered.get(s.ledger_id) === entry.amount && !costUsed.has(entry.id)) {
          costUsed.add(entry.id);
          writeCost(own, inward);
        }
        w.close('ACCOUNTINGALLOCATIONS.LIST');
      }
      w.close('ALLINVENTORYENTRIES.LIST');
    }
    if (!stockOnly) {
      for (const e of v.entries) {
        const rest = e.amount - (covered.get(e.ledger_id) ?? 0);
        if (rest === 0 && covered.has(e.ledger_id)) continue;
        w.open('ALLLEDGERENTRIES.LIST');
        w.leaf('LEDGERNAME', e.ledger);
        w.leaf('ISDEEMEDPOSITIVE', rest > 0 ? 'Yes' : 'No');
        w.leaf('AMOUNT', paiseToDecimal(-rest));
        if (rest === e.amount) {
          for (const b of e.bills) {
            w.open('BILLALLOCATIONS.LIST');
            w.leaf('NAME', b.name);
            w.leaf('BILLTYPE', BILL_LABEL[b.kind]);
            w.leaf('AMOUNT', paiseToDecimal(-b.amount));
            w.close('BILLALLOCATIONS.LIST');
          }
        }
        const own = allocs.get(e.id);
        if (own?.length && !costUsed.has(e.id)) writeCost(own, rest > 0);
        w.close('ALLLEDGERENTRIES.LIST');
      }
    }
    w.close('VOUCHER');
  }
  envelopeClose(w);
  return w.toString();
}

const BILL_KIND: Record<string, 'new' | 'agst' | 'adv' | 'onacc'> = { 'new ref': 'new', 'agst ref': 'agst', advance: 'adv', 'on account': 'onacc' };
const INVENTORY_TAGS = ['ALLINVENTORYENTRIES.LIST', 'INVENTORYENTRIES.LIST', 'INVENTORYENTRIESIN.LIST', 'INVENTORYENTRIESOUT.LIST'];

interface EntryDraft {
  ledger_id: number;
  name: string;
  amount: number;
  bills: { kind: string; name: string; amount: number }[];
  cost: AllocationInput[];
}

export async function importVouchersXml2(books: Books, xml: string, opts: Xml2Options = {}): Promise<Xml2Report> {
  const dry = !!opts.dryRun;
  const rep = newReport(dry);
  const db = books.db;
  const company = await books.requireCompany();
  await ensureCosting(db);
  const root = parseXml(xml);
  const err = (name: string, message: string) => rep.errors.push({ kind: 'voucher', name, message });
  const ledgers = new Map((await books.ledgers()).map((l) => [l.name.toLowerCase(), l]));
  const itemMap = new Map((await stockItems(db)).map((i) => [i.name.toLowerCase(), i]));
  const godownMap = new Map((await godowns(db)).map((g) => [g.name.toLowerCase(), g.id]));
  const centreMap = new Map((await costCentres(db)).map((c) => [c.name.toLowerCase(), c.id]));
  const allTypes = await books.voucherTypes();
  const types = new Map(allTypes.map((t) => [t.name.toLowerCase(), { id: t.id, parent: t.parent }]));
  const parents = new Set<string>([...allTypes.filter((t) => t.is_system).map((t) => t.name), ...STOCK_VOUCHER_TYPES]);
  const existing = await db.select<{ id: number; guid: string; type_id: number; number: string }>('SELECT id, guid, type_id, number FROM vouchers');
  const byGuid = new Map(existing.map((v) => [v.guid, v]));
  const used = new Set(existing.map((v) => `${v.type_id}|${v.number}`));
  const seqs = new Map((await db.select<{ type_id: number; m: number }>('SELECT type_id, MAX(seq) AS m FROM vouchers GROUP BY type_id')).map((r) => [r.type_id, r.m]));
  const maxOf = async (t: string) => (await one<{ m: number }>(db, `SELECT COALESCE(MAX(id), 0) AS m FROM ${t}`))!.m;
  let vid = await maxOf('vouchers');
  let eid = await maxOf('entries');
  let mid = await maxOf('stock_movements');
  let tid = await maxOf('voucher_types');
  const stmts: Stmt[] = [];
  const dropStmts = (id: number): Stmt[] => [
    { sql: 'DELETE FROM cost_allocations WHERE entry_id IN (SELECT id FROM entries WHERE voucher_id = ?)', params: [id] },
    { sql: 'DELETE FROM bills WHERE entry_id IN (SELECT id FROM entries WHERE voucher_id = ?)', params: [id] },
    { sql: 'DELETE FROM stock_movements WHERE voucher_id = ?', params: [id] },
    { sql: 'DELETE FROM entries WHERE voucher_id = ?', params: [id] },
    { sql: 'DELETE FROM vouchers WHERE id = ?', params: [id] },
  ];

  for (const v of descendants(root, 'VOUCHER')) {
    const guid = textOf(v, 'GUID') || v.attrs.REMOTEID || '';
    const action = (v.attrs.ACTION || '').toLowerCase();
    const typeName = textOf(v, 'VOUCHERTYPENAME') || v.attrs.VCHTYPE || '';
    const label = `${typeName} ${textOf(v, 'VOUCHERNUMBER')}`.trim();
    const old = guid ? byGuid.get(guid) : undefined;
    if (action === 'delete') {
      if (old) {
        stmts.push(...dropStmts(old.id));
        rep.deleted.vouchers += 1;
      }
      continue;
    }
    if (old && action !== 'alter') {
      rep.skipped.vouchers += 1;
      continue;
    }
    const date = tallyDate(textOf(v, 'DATE'));
    if (!date || !isIsoDate(date)) {
      err(label, 'Missing or invalid date');
      continue;
    }
    if (date < company.books_from || date > company.fy_end) {
      err(label, `Date ${date} is outside the books period ${company.books_from} to ${company.fy_end}`);
      continue;
    }
    let type = types.get(typeName.toLowerCase());
    if (!type) {
      const parent = v.attrs.VCHTYPE;
      if (parent && parents.has(parent)) {
        tid += 1;
        type = { id: tid, parent };
        types.set(typeName.toLowerCase(), type);
        stmts.push({ sql: 'INSERT INTO voucher_types (id, guid, name, parent, is_system) VALUES (?, ?, ?, ?, ?)', params: [tid, newGuid(), typeName, parent, typeName === parent ? 1 : 0] });
        rep.created.voucher_types += 1;
      } else {
        err(label, `Voucher type "${typeName}" is not supported`);
        continue;
      }
    }
    const stockOnly = (STOCK_VOUCHER_TYPES as readonly string[]).includes(type.parent);
    const entries: EntryDraft[] = [];
    const lines: { item_id: number; godown_id: number; ledger_id: number | null; qty: number; rate: number; amount: number; discount_bp: number; ledger: string }[] = [];
    let ok = true;
    const fail = (m: string) => {
      err(label, m);
      ok = false;
    };
    const costOf = (e: XNode): AllocationInput[] => {
      const out: AllocationInput[] = [];
      for (const c of descendants(e, 'COSTCENTREALLOCATIONS.LIST')) {
        const nm = textOf(c, 'NAME');
        const id = centreMap.get(nm.toLowerCase());
        if (!id) {
          rep.warnings.push(`Voucher ${label}: cost centre "${nm}" not found, allocation skipped`);
          continue;
        }
        const amt = -decimalToPaise(textOf(c, 'AMOUNT'));
        if (amt) out.push({ cost_centre_id: id, amount: amt });
      }
      return out;
    };
    const addEntry = (name: string, amount: number, bills: EntryDraft['bills'], cost: AllocationInput[], mergeInto: boolean) => {
      const led = ledgers.get(name.toLowerCase());
      if (!led) return fail(`Ledger "${name}" was not found`);
      const same = mergeInto ? entries.find((x) => x.ledger_id === led.id) : undefined;
      if (same) {
        same.amount += amount;
        same.bills.push(...bills);
        same.cost.push(...cost);
      } else entries.push({ ledger_id: led.id, name: led.name, amount, bills, cost });
    };
    for (const e of [...childs(v, 'ALLLEDGERENTRIES.LIST'), ...childs(v, 'LEDGERENTRIES.LIST')]) {
      const ln = textOf(e, 'LEDGERNAME');
      const amt = -decimalToPaise(textOf(e, 'AMOUNT'));
      if (!ln || amt === 0) continue;
      const bills = childs(e, 'BILLALLOCATIONS.LIST').map((b) => ({ kind: BILL_KIND[textOf(b, 'BILLTYPE').toLowerCase()] ?? 'onacc', name: textOf(b, 'NAME'), amount: -decimalToPaise(textOf(b, 'AMOUNT')) }));
      addEntry(ln, amt, bills, costOf(e), false);
      if (!ok) break;
    }
    if (ok) {
      for (const tag of INVENTORY_TAGS) {
        for (const inv of childs(v, tag)) {
          const itemName = textOf(inv, 'STOCKITEMNAME');
          if (!itemName) continue;
          const item = itemMap.get(itemName.toLowerCase());
          if (!item) {
            fail(`Referenced master is missing: stock item "${itemName}"`);
            break;
          }
          const amountSigned = decimalToPaise(textOf(inv, 'AMOUNT'));
          const deemedRaw = textOf(inv, 'ISDEEMEDPOSITIVE');
          const inward = deemedRaw ? yes(deemedRaw) : amountSigned < 0 || tag === 'INVENTORYENTRIESIN.LIST';
          const rate = parseRateText(textOf(inv, 'RATE'));
          const discount = Math.round((parseFloat(textOf(inv, 'DISCOUNT')) || 0) * 100);
          const alloc = descendants(inv, 'ACCOUNTINGALLOCATIONS.LIST')[0];
          const ledgerName = alloc ? textOf(alloc, 'LEDGERNAME') : '';
          const ledgerId = ledgerName ? ledgers.get(ledgerName.toLowerCase())?.id ?? null : null;
          const batches = childs(inv, 'BATCHALLOCATIONS.LIST');
          const parts = batches.length
            ? batches.map((b) => ({ godown: textOf(b, 'GODOWNNAME') || textOf(b, 'DESTINATIONGODOWNNAME'), qty: parseQtyText(textOf(b, 'ACTUALQTY') || textOf(b, 'BILLEDQTY')), amount: Math.abs(decimalToPaise(textOf(b, 'AMOUNT'))) }))
            : [{ godown: '', qty: parseQtyText(textOf(inv, 'ACTUALQTY') || textOf(inv, 'BILLEDQTY')), amount: Math.abs(amountSigned) }];
          if (batches.some((b) => /[^\s]/.test(textOf(b, 'BATCHNAME')) && !/^primary batch$/i.test(textOf(b, 'BATCHNAME')))) rep.warnings.push(`Voucher ${label}: batch names are not stored`);
          for (const p of parts) {
            if (!p.qty) {
              fail(`Invalid quantity for stock item "${itemName}"`);
              break;
            }
            let gid = 1;
            if (p.godown) {
              const found = godownMap.get(p.godown.toLowerCase());
              if (!found) {
                fail(`Referenced master is missing: godown "${p.godown}"`);
                break;
              }
              gid = found;
            }
            const amount = p.amount || Math.abs(amountSigned);
            lines.push({ item_id: item.id, godown_id: gid, ledger_id: ledgerId, qty: inward ? p.qty : -p.qty, rate: rate || Math.round((amount * QTY_SCALE) / p.qty), amount, discount_bp: discount, ledger: ledgerName });
          }
          if (!ok) break;
          for (const a of childs(inv, 'ACCOUNTINGALLOCATIONS.LIST')) {
            const ln = textOf(a, 'LEDGERNAME');
            const amt = -decimalToPaise(textOf(a, 'AMOUNT'));
            if (ln && amt) addEntry(ln, amt, [], costOf(a), true);
            if (!ok) break;
          }
          if (!ok) break;
        }
        if (!ok) break;
      }
    }
    if (!ok) continue;
    if (stockOnly) {
      if (!lines.length) {
        err(label, 'No stock items');
        continue;
      }
      entries.length = 0;
    } else {
      if (entries.length < 2) {
        err(label, 'Fewer than two ledger entries');
        continue;
      }
      const sum = entries.reduce((s, e) => s + e.amount, 0);
      if (sum !== 0) {
        err(label, `Debit and credit differ by ${paiseToDecimal(Math.abs(sum))}`);
        continue;
      }
    }
    for (const e of entries) {
      if (e.bills.length && e.bills.reduce((s, b) => s + b.amount, 0) !== e.amount) {
        rep.warnings.push(`Voucher ${label}: bill allocations for "${e.name}" did not match the amount and were skipped`);
        e.bills = [];
      }
      if (e.cost.length) {
        try {
          await validateAllocations(db, e.amount, e.cost);
        } catch (x) {
          rep.warnings.push(`Voucher ${label}: cost allocation for "${e.name}" skipped (${(x as Error).message})`);
          e.cost = [];
        }
      }
    }
    let number = textOf(v, 'VOUCHERNUMBER');
    let seq = seqs.get(type.id) ?? 0;
    if (/^\d+$/.test(number)) seq = Math.max(seq, Number(number));
    else seq += 1;
    if (!number) number = String(seq);
    seqs.set(type.id, seq);
    const key = `${type.id}|${number}`;
    if (used.has(key) && !(old && old.type_id === type.id && old.number === number)) {
      err(label, `Voucher number ${number} already exists for ${typeName}`);
      continue;
    }
    used.add(key);
    if (old) {
      stmts.push(...dropStmts(old.id));
      rep.updated.vouchers += 1;
    } else rep.created.vouchers += 1;
    vid += 1;
    const party = textOf(v, 'PARTYLEDGERNAME');
    stmts.push({
      sql: `INSERT INTO vouchers (id, guid, type_id, number, seq, date, reference, narration, party_id, place_of_supply)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [vid, guid || newGuid(), type.id, number, seq, date, clean(textOf(v, 'REFERENCE')), clean(textOf(v, 'NARRATION'), 500), party ? ledgers.get(party.toLowerCase())?.id ?? null : null, clean(textOf(v, 'PLACEOFSUPPLY'))],
    });
    entries.forEach((e, i) => {
      eid += 1;
      stmts.push({ sql: 'INSERT INTO entries (id, voucher_id, ledger_id, amount, seq) VALUES (?, ?, ?, ?, ?)', params: [eid, vid, e.ledger_id, e.amount, i] });
      for (const b of e.bills) stmts.push({ sql: 'INSERT INTO bills (entry_id, ledger_id, kind, name, amount) VALUES (?, ?, ?, ?, ?)', params: [eid, e.ledger_id, b.kind, clean(b.name), b.amount] });
      if (e.cost.length) stmts.push(...allocationStmts(eid, e.cost).slice(1));
      if (e.amount > 0) rep.totals.voucher_amount += e.amount;
    });
    lines.forEach((l, i) => {
      mid += 1;
      stmts.push({
        sql: 'INSERT INTO stock_movements (id, voucher_id, item_id, godown_id, ledger_id, qty, rate, amount, discount_bp, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        params: [mid, vid, l.item_id, l.godown_id, l.ledger_id, l.qty, l.rate, l.amount, l.discount_bp, i],
      });
      rep.totals.stock_lines += 1;
    });
  }
  if (!dry && stmts.length) await db.batch(stmts);
  return rep;
}
