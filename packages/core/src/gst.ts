import { CoreError, type Db } from './db.ts';
import type { Books, EntryInput, Ledger } from './books.ts';

export const STATES: { code: string; name: string }[] = [
  ['01', 'Jammu & Kashmir'], ['02', 'Himachal Pradesh'], ['03', 'Punjab'], ['04', 'Chandigarh'], ['05', 'Uttarakhand'],
  ['06', 'Haryana'], ['07', 'Delhi'], ['08', 'Rajasthan'], ['09', 'Uttar Pradesh'], ['10', 'Bihar'], ['11', 'Sikkim'],
  ['12', 'Arunachal Pradesh'], ['13', 'Nagaland'], ['14', 'Manipur'], ['15', 'Mizoram'], ['16', 'Tripura'],
  ['17', 'Meghalaya'], ['18', 'Assam'], ['19', 'West Bengal'], ['20', 'Jharkhand'], ['21', 'Odisha'],
  ['22', 'Chhattisgarh'], ['23', 'Madhya Pradesh'], ['24', 'Gujarat'], ['26', 'Dadra & Nagar Haveli and Daman & Diu'],
  ['27', 'Maharashtra'], ['29', 'Karnataka'], ['30', 'Goa'], ['31', 'Lakshadweep'], ['32', 'Kerala'],
  ['33', 'Tamil Nadu'], ['34', 'Puducherry'], ['35', 'Andaman & Nicobar Islands'], ['36', 'Telangana'],
  ['37', 'Andhra Pradesh'], ['38', 'Ladakh'], ['97', 'Other Territory'], ['99', 'Other Country'],
].map(([code, name]) => ({ code, name }));

export const GST_SLABS_BP = [0, 25, 300, 500, 1200, 1800, 2800];

export function stateCode(nameOrCode: string): string {
  const t = nameOrCode.trim().toLowerCase();
  if (!t) return '';
  const s = STATES.find((x) => x.code === t || x.name.toLowerCase() === t);
  return s ? s.code : '';
}

export function stateName(code: string): string {
  return STATES.find((s) => s.code === code)?.name ?? '';
}

const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function gstinChecksum(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = CHARS.indexOf(first14[i]);
    if (v < 0) return '';
    const prod = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(prod / 36) + (prod % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36];
}

export function isValidGstin(gstin: string): boolean {
  const g = gstin.trim().toUpperCase();
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g)) return false;
  if (!STATES.some((s) => s.code === g.slice(0, 2))) return false;
  return gstinChecksum(g.slice(0, 14)) === g[14];
}

export function stateCodeOfGstin(gstin: string): string {
  return /^\d{2}/.test(gstin) ? gstin.slice(0, 2) : '';
}

export interface TaxSplit {
  cgst: number;
  sgst: number;
  igst: number;
}

export function gstSplit(taxable: number, rateBp: number, intraState: boolean): TaxSplit {
  if (intraState) {
    const half = Math.round((taxable * rateBp) / 20000);
    return { cgst: half, sgst: half, igst: 0 };
  }
  return { cgst: 0, sgst: 0, igst: Math.round((taxable * rateBp) / 10000) };
}

export type TaxHead = 'Central Tax' | 'State Tax' | 'Integrated Tax' | 'Cess';
type Direction = 'Output' | 'Input';

const HEAD_SHORT: Record<TaxHead, string> = { 'Central Tax': 'CGST', 'State Tax': 'SGST', 'Integrated Tax': 'IGST', Cess: 'Cess' };
const HEAD_OF: Record<string, TaxHead> = { CGST: 'Central Tax', SGST: 'State Tax', IGST: 'Integrated Tax' };

export function taxLedgerName(dir: Direction, head: TaxHead, rateBp: number): string {
  const pct = rateBp / 100;
  return `${dir} ${HEAD_SHORT[head]} ${Number.isInteger(pct) ? pct : pct.toFixed(2).replace(/0+$/, '')}%`;
}

export async function ensureTaxLedger(books: Books, dir: Direction, head: TaxHead, rateBp: number): Promise<Ledger> {
  const name = taxLedgerName(dir, head, rateBp);
  const existing = (await books.ledgers()).find((l) => l.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing;
  const duties = (await books.groups()).find((g) => g.name === 'Duties & Taxes')!;
  return books.createLedger({ name, group_id: duties.id, duty_type: 'GST', tax_head: head, rate_bp: rateBp });
}

export interface SupplyLine {
  ledger_id: number;
  taxable: number;
  rate_bp: number;
}

export interface GstInvoicePlan {
  intra_state: boolean;
  place_of_supply: string;
  entries: EntryInput[];
  taxable: number;
  tax: number;
  total: number;
}

export async function planGstInvoice(
  books: Books,
  kind: 'Sales' | 'Purchase' | 'Credit Note' | 'Debit Note',
  partyId: number,
  lines: SupplyLine[],
  opts: { placeOfSupply?: string } = {}
): Promise<GstInvoicePlan> {
  const company = await books.requireCompany();
  const party = await books.ledger(partyId);
  if (!party) throw new CoreError('not_found', 'Party ledger not found');
  if (!lines.length) throw new CoreError('invalid', 'Add at least one supply line');
  const companyState = stateCodeOfGstin(company.gstin) || stateCode(company.state);
  const partyState = stateCodeOfGstin(party.gstin) || stateCode(party.state);
  const pos = stateCode(opts.placeOfSupply ?? '') || partyState || companyState;
  if (!pos) throw new CoreError('invalid', 'Place of supply could not be determined; set the party state');
  const intra = !!companyState && pos === companyState;

  const outward = kind === 'Sales' || kind === 'Debit Note';
  const dir: Direction = kind === 'Sales' || kind === 'Credit Note' ? 'Output' : 'Input';
  const partyIsDebit = kind === 'Sales' || kind === 'Debit Note';
  const sign = partyIsDebit ? 1 : -1;

  const taxByLedger = new Map<number, number>();
  const supplyEntries: EntryInput[] = [];
  let taxable = 0;
  for (const line of lines) {
    if (!Number.isInteger(line.taxable) || line.taxable <= 0) throw new CoreError('invalid', 'Taxable value must be positive');
    if (!GST_SLABS_BP.includes(line.rate_bp)) throw new CoreError('invalid', `Unsupported GST rate ${line.rate_bp / 100}%`);
    taxable += line.taxable;
    supplyEntries.push({ ledger_id: line.ledger_id, amount: -sign * line.taxable });
    const split = gstSplit(line.taxable, line.rate_bp, intra);
    const add = async (head: TaxHead, amt: number, bp: number) => {
      if (!amt) return;
      const l = await ensureTaxLedger(books, dir, head, bp);
      taxByLedger.set(l.id, (taxByLedger.get(l.id) ?? 0) + amt);
    };
    await add('Central Tax', split.cgst, line.rate_bp / 2);
    await add('State Tax', split.sgst, line.rate_bp / 2);
    await add('Integrated Tax', split.igst, line.rate_bp);
  }
  const taxEntries: EntryInput[] = [...taxByLedger].map(([ledger_id, amt]) => ({ ledger_id, amount: -sign * amt }));
  const tax = [...taxByLedger.values()].reduce((s, v) => s + v, 0);
  const total = taxable + tax;
  void outward;
  const entries: EntryInput[] = [{ ledger_id: partyId, amount: sign * total }, ...supplyEntries, ...taxEntries];
  return { intra_state: intra, place_of_supply: pos, entries, taxable, tax, total };
}

interface Row {
  voucher_id: number;
  date: string;
  number: string;
  parent: string;
  reverse_charge: number;
  pos: string;
  party_id: number | null;
  ledger_id: number;
  amount: number;
  duty_type: string;
  tax_head: string;
  lrate: number;
  hsn: string;
  taxability: string;
  nature: string;
  group_name: string;
  gstin: string;
  party_name: string;
  party_state: string;
}

async function gstRows(db: Db, from: string, to: string): Promise<Row[]> {
  return db.select<Row>(
    `SELECT v.id AS voucher_id, v.date, v.number, t.parent, v.reverse_charge, v.place_of_supply AS pos, v.party_id,
       e.ledger_id, e.amount, l.duty_type, l.tax_head, l.rate_bp AS lrate, l.hsn_sac AS hsn, l.taxability,
       g.nature, g.name AS group_name,
       COALESCE(p.gstin, '') AS gstin, COALESCE(p.name, '') AS party_name, COALESCE(p.state, '') AS party_state
     FROM vouchers v
     JOIN voucher_types t ON t.id = v.type_id
     JOIN entries e ON e.voucher_id = v.id
     JOIN ledgers l ON l.id = e.ledger_id
     JOIN groups g ON g.id = l.group_id
     LEFT JOIN ledgers p ON p.id = v.party_id
     WHERE v.date >= ? AND v.date <= ? AND v.cancelled = 0 AND t.parent IN ('Sales','Purchase','Credit Note','Debit Note')
     ORDER BY v.date, v.id, e.seq`,
    [from, to]
  );
}

export interface InvoiceTax {
  voucher_id: number;
  date: string;
  number: string;
  parent: string;
  gstin: string;
  party: string;
  pos: string;
  reverse_charge: boolean;
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  total: number;
  rate_bp: number;
  hsn: { hsn: string; taxable: number; rate_bp: number }[];
  nil_exempt: number;
}

function nearestSlab(ratio: number): number {
  let best = 0;
  for (const s of GST_SLABS_BP) if (Math.abs(s - ratio) < Math.abs(best - ratio)) best = s;
  return best;
}

export async function invoiceTaxes(db: Db, from: string, to: string, company: { gstin: string; state: string }): Promise<InvoiceTax[]> {
  const rows = await gstRows(db, from, to);
  const byV = new Map<number, Row[]>();
  for (const r of rows) {
    if (!byV.has(r.voucher_id)) byV.set(r.voucher_id, []);
    byV.get(r.voucher_id)!.push(r);
  }
  const out: InvoiceTax[] = [];
  for (const rs of byV.values()) {
    const first = rs[0];
    const isOutput = first.parent === 'Sales' || first.parent === 'Credit Note';
    const inv: InvoiceTax = {
      voucher_id: first.voucher_id,
      date: first.date,
      number: first.number,
      parent: first.parent,
      gstin: first.gstin,
      party: first.party_name,
      pos: first.pos || stateCodeOfGstin(first.gstin) || stateCode(first.party_state) || stateCodeOfGstin(company.gstin) || stateCode(company.state),
      reverse_charge: !!first.reverse_charge,
      taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, total: 0, rate_bp: 0, hsn: [], nil_exempt: 0,
    };
    const supply: Row[] = [];
    for (const r of rs) {
      if (r.duty_type === 'GST') {
        const amt = Math.abs(r.amount);
        if (r.tax_head === 'Central Tax') inv.cgst += amt;
        else if (r.tax_head === 'State Tax') inv.sgst += amt;
        else if (r.tax_head === 'Integrated Tax') inv.igst += amt;
        else inv.cess += amt;
      } else if (isOutput ? r.nature === 'Income' : r.nature === 'Expense' || r.group_name === 'Fixed Assets') {
        supply.push(r);
      }
    }
    if (!supply.length) continue;
    const taxableOf = (r: Row) => Math.abs(r.amount);
    inv.taxable = supply.reduce((s, r) => s + taxableOf(r), 0);
    const tax = inv.igst + inv.cgst + inv.sgst;
    const ratio = inv.taxable ? (tax * 10000) / inv.taxable : 0;
    const fallback = nearestSlab(ratio);
    inv.rate_bp = fallback;
    const hsn = new Map<string, { hsn: string; taxable: number; rate_bp: number }>();
    for (const r of supply) {
      if (/nil|exempt/i.test(r.taxability) || (tax === 0 && r.lrate === 0)) inv.nil_exempt += taxableOf(r);
      const rate = r.lrate || fallback;
      const key = `${r.hsn}|${rate}`;
      const cur = hsn.get(key) ?? { hsn: r.hsn, taxable: 0, rate_bp: rate };
      cur.taxable += taxableOf(r);
      hsn.set(key, cur);
    }
    inv.hsn = [...hsn.values()];
    inv.total = inv.taxable + tax + inv.cess;
    out.push(inv);
  }
  return out;
}

export interface Gstr1 {
  period: { from: string; to: string };
  gstin: string;
  b2b: InvoiceTax[];
  b2cl: InvoiceTax[];
  b2cs: { pos: string; intra: boolean; rate_bp: number; taxable: number; igst: number; cgst: number; sgst: number; cess: number }[];
  cdnr: InvoiceTax[];
  cdnur: InvoiceTax[];
  nil_exempt: { registered: number; unregistered: number };
  hsn: { hsn: string; rate_bp: number; taxable: number; igst: number; cgst: number; sgst: number; cess: number }[];
  documents: { type: string; from: string; to: string; total: number; cancelled: number }[];
  totals: { taxable: number; igst: number; cgst: number; sgst: number; cess: number; invoices: number };
}

const B2CL_THRESHOLD = 250000_00;

export async function gstr1(books: Books, from: string, to: string): Promise<Gstr1> {
  const company = await books.requireCompany();
  const all = (await invoiceTaxes(books.db, from, to, company)).filter((i) => i.parent === 'Sales' || i.parent === 'Credit Note');
  const companyState = stateCodeOfGstin(company.gstin) || stateCode(company.state);
  const sales = all.filter((i) => i.parent === 'Sales');
  const notes = all.filter((i) => i.parent === 'Credit Note');
  const registered = (i: InvoiceTax) => !!i.gstin;
  const interState = (i: InvoiceTax) => !!companyState && i.pos !== companyState;

  const b2b = sales.filter(registered);
  const b2cl = sales.filter((i) => !registered(i) && interState(i) && i.total > B2CL_THRESHOLD);
  const b2csSrc = sales.filter((i) => !registered(i) && !b2cl.includes(i));
  const cdnr = notes.filter(registered);
  const cdnur = notes.filter((i) => !registered(i));

  const map = new Map<string, Gstr1['b2cs'][number]>();
  const add = (i: InvoiceTax, sign: number) => {
    const key = `${i.pos}|${i.rate_bp}`;
    const cur = map.get(key) ?? { pos: i.pos, intra: !interState(i), rate_bp: i.rate_bp, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
    cur.taxable += sign * i.taxable;
    cur.igst += sign * i.igst;
    cur.cgst += sign * i.cgst;
    cur.sgst += sign * i.sgst;
    cur.cess += sign * i.cess;
    map.set(key, cur);
  };
  for (const i of b2csSrc) add(i, 1);
  for (const i of cdnur.filter((x) => x.total <= B2CL_THRESHOLD || !interState(x))) add(i, -1);

  const hsnMap = new Map<string, Gstr1['hsn'][number]>();
  for (const i of sales) {
    const intra = !interState(i);
    for (const h of i.hsn) {
      const key = `${h.hsn}|${h.rate_bp}`;
      const split = gstSplit(h.taxable, h.rate_bp, intra);
      const cur = hsnMap.get(key) ?? { hsn: h.hsn, rate_bp: h.rate_bp, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
      cur.taxable += h.taxable;
      cur.igst += split.igst;
      cur.cgst += split.cgst;
      cur.sgst += split.sgst;
      hsnMap.set(key, cur);
    }
  }

  const docs = await books.db.select<{ parent: string; first: string; last: string; total: number; cancelled: number }>(
    `SELECT t.parent AS parent, MIN(v.seq) AS first, MAX(v.seq) AS last, COUNT(*) AS total, SUM(v.cancelled) AS cancelled
     FROM vouchers v JOIN voucher_types t ON t.id = v.type_id
     WHERE v.date >= ? AND v.date <= ? AND t.parent IN ('Sales','Credit Note','Debit Note')
     GROUP BY t.parent`,
    [from, to]
  );

  const sumOf = (list: InvoiceTax[], k: 'taxable' | 'igst' | 'cgst' | 'sgst' | 'cess') => list.reduce((s, i) => s + i[k], 0);
  const sign = (list: InvoiceTax[], k: 'taxable' | 'igst' | 'cgst' | 'sgst' | 'cess') => sumOf(list.filter((i) => i.parent === 'Sales'), k) - sumOf(list.filter((i) => i.parent === 'Credit Note'), k);

  return {
    period: { from, to },
    gstin: company.gstin,
    b2b,
    b2cl,
    b2cs: [...map.values()].filter((r) => r.taxable !== 0 || r.igst || r.cgst || r.sgst),
    cdnr,
    cdnur,
    nil_exempt: {
      registered: sales.filter(registered).reduce((s, i) => s + i.nil_exempt, 0),
      unregistered: sales.filter((i) => !registered(i)).reduce((s, i) => s + i.nil_exempt, 0),
    },
    hsn: [...hsnMap.values()].sort((a, b) => a.hsn.localeCompare(b.hsn) || a.rate_bp - b.rate_bp),
    documents: docs.map((d) => ({ type: d.parent, from: String(d.first), to: String(d.last), total: d.total, cancelled: d.cancelled })),
    totals: {
      taxable: sign(all, 'taxable'),
      igst: sign(all, 'igst'),
      cgst: sign(all, 'cgst'),
      sgst: sign(all, 'sgst'),
      cess: sign(all, 'cess'),
      invoices: sales.length,
    },
  };
}

const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;
const rupees = (p: number) => Math.round(p) / 100;

export function gstr1Json(r: Gstr1): object {
  const fp = `${r.period.to.slice(5, 7)}${r.period.to.slice(0, 4)}`;
  const item = (i: InvoiceTax) => ({
    num: 1,
    itm_det: { rt: i.rate_bp / 100, txval: rupees(i.taxable), iamt: rupees(i.igst), camt: rupees(i.cgst), samt: rupees(i.sgst), csamt: rupees(i.cess) },
  });
  const byCtin = new Map<string, InvoiceTax[]>();
  for (const i of r.b2b) byCtin.set(i.gstin, [...(byCtin.get(i.gstin) ?? []), i]);
  return {
    gstin: r.gstin,
    fp,
    b2b: [...byCtin].map(([ctin, invs]) => ({
      ctin,
      inv: invs.map((i) => ({ inum: i.number, idt: ddmmyyyy(i.date), val: rupees(i.total), pos: i.pos, rchrg: i.reverse_charge ? 'Y' : 'N', inv_typ: 'R', itms: [item(i)] })),
    })),
    b2cl: r.b2cl.map((i) => ({ pos: i.pos, inv: [{ inum: i.number, idt: ddmmyyyy(i.date), val: rupees(i.total), itms: [item(i)] }] })),
    b2cs: r.b2cs.map((c) => ({ sply_ty: c.intra ? 'INTRA' : 'INTER', rt: c.rate_bp / 100, typ: 'OE', pos: c.pos, txval: rupees(c.taxable), iamt: rupees(c.igst), camt: rupees(c.cgst), samt: rupees(c.sgst), csamt: rupees(c.cess) })),
    hsn: {
      data: r.hsn.map((h, n) => ({ num: n + 1, hsn_sc: h.hsn, rt: h.rate_bp / 100, txval: rupees(h.taxable), iamt: rupees(h.igst), camt: rupees(h.cgst), samt: rupees(h.sgst), csamt: rupees(h.cess) })),
    },
    doc_issue: {
      doc_det: r.documents.map((d, n) => ({ doc_num: n + 1, doc_typ: d.type, docs: [{ num: 1, from: d.from, to: d.to, totnum: d.total, cancel: d.cancelled, net_issue: d.total - d.cancelled }] })),
    },
  };
}

export interface Tax4 {
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
}

export interface Gstr3b {
  period: { from: string; to: string };
  gstin: string;
  outward_taxable: Tax4 & { taxable: number };
  outward_nil_exempt: number;
  inward_reverse_charge: Tax4 & { taxable: number };
  itc: Tax4;
  liability: Tax4;
  set_off: { igst_used: Tax4; cgst_used: Tax4; sgst_used: Tax4 };
  cash_payable: Tax4;
  carry_forward_itc: Tax4;
}

const z4 = (): Tax4 => ({ igst: 0, cgst: 0, sgst: 0, cess: 0 });

export async function gstr3b(books: Books, from: string, to: string): Promise<Gstr3b> {
  const company = await books.requireCompany();
  const all = await invoiceTaxes(books.db, from, to, company);
  const out = { ...z4(), taxable: 0 };
  const rcm = { ...z4(), taxable: 0 };
  const itc = z4();
  let nil = 0;
  for (const i of all) {
    const s = i.parent === 'Sales' ? 1 : i.parent === 'Credit Note' ? -1 : 0;
    if (s) {
      out.taxable += s * i.taxable;
      out.igst += s * i.igst;
      out.cgst += s * i.cgst;
      out.sgst += s * i.sgst;
      out.cess += s * i.cess;
      nil += s * i.nil_exempt;
      continue;
    }
    const p = i.parent === 'Purchase' ? 1 : -1;
    if (i.reverse_charge) {
      rcm.taxable += p * i.taxable;
      rcm.igst += p * i.igst;
      rcm.cgst += p * i.cgst;
      rcm.sgst += p * i.sgst;
      rcm.cess += p * i.cess;
    } else {
      itc.igst += p * i.igst;
      itc.cgst += p * i.cgst;
      itc.sgst += p * i.sgst;
      itc.cess += p * i.cess;
    }
  }
  const liability: Tax4 = { igst: out.igst + rcm.igst, cgst: out.cgst + rcm.cgst, sgst: out.sgst + rcm.sgst, cess: out.cess + rcm.cess };
  const avail = { ...itc };
  const used = { igst_used: z4(), cgst_used: z4(), sgst_used: z4() };
  const owe = { ...liability };
  const take = (from: 'igst' | 'cgst' | 'sgst', target: 'igst' | 'cgst' | 'sgst') => {
    const n = Math.max(0, Math.min(avail[from], owe[target]));
    avail[from] -= n;
    owe[target] -= n;
    used[`${from}_used` as 'igst_used'][target] += n;
  };
  take('igst', 'igst');
  take('igst', 'cgst');
  take('igst', 'sgst');
  take('cgst', 'cgst');
  take('cgst', 'igst');
  take('sgst', 'sgst');
  take('sgst', 'igst');
  const cessUse = Math.max(0, Math.min(avail.cess, owe.cess));
  avail.cess -= cessUse;
  owe.cess -= cessUse;
  return {
    period: { from, to },
    gstin: company.gstin,
    outward_taxable: out,
    outward_nil_exempt: nil,
    inward_reverse_charge: rcm,
    itc,
    liability,
    set_off: used,
    cash_payable: owe,
    carry_forward_itc: avail,
  };
}
