import { CoreError, one, type Db } from './db.ts';
import type { Books } from './books.ts';
import { gstSplit, invoiceTaxes, stateCode, stateCodeOfGstin } from './gst.ts';
import { clean } from './util.ts';

export const GSTRECON_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS gstr2b_docs (
    id INTEGER PRIMARY KEY,
    period TEXT NOT NULL,
    ctin TEXT NOT NULL,
    trade_name TEXT NOT NULL DEFAULT '',
    doc_type TEXT NOT NULL DEFAULT 'INV',
    number TEXT NOT NULL,
    date TEXT NOT NULL DEFAULT '',
    value INTEGER NOT NULL DEFAULT 0,
    taxable INTEGER NOT NULL DEFAULT 0,
    igst INTEGER NOT NULL DEFAULT 0,
    cgst INTEGER NOT NULL DEFAULT 0,
    sgst INTEGER NOT NULL DEFAULT 0,
    cess INTEGER NOT NULL DEFAULT 0,
    itc_available TEXT NOT NULL DEFAULT 'Y',
    reverse_charge TEXT NOT NULL DEFAULT 'N',
    pos TEXT NOT NULL DEFAULT ''
  )`,
];

export interface PortalDoc {
  period: string;
  ctin: string;
  trade_name: string;
  doc_type: 'INV' | 'CDN';
  number: string;
  date: string;
  value: number;
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  itc_available: string;
  reverse_charge: string;
  pos: string;
}

const paise = (n: unknown) => Math.round((Number(n) || 0) * 100);

function isoFromPortal(d: unknown): string {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(d ?? ''));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}

interface PortalItem {
  txval?: number;
  igst?: number;
  cgst?: number;
  sgst?: number;
  cess?: number;
}

function sums(doc: PortalItem & { items?: PortalItem[] }) {
  const src = doc.items?.length ? doc.items : [doc];
  const t = { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
  for (const i of src) {
    t.taxable += paise(i.txval);
    t.igst += paise(i.igst);
    t.cgst += paise(i.cgst);
    t.sgst += paise(i.sgst);
    t.cess += paise(i.cess);
  }
  return t;
}

export function parseGstr2b(json: unknown, periodFallback = ''): PortalDoc[] {
  if (!json || typeof json !== 'object') throw new CoreError('invalid', 'GSTR-2B file is not valid JSON');
  const root = json as Record<string, any>;
  const data = root.data ?? root;
  const docdata = data.docdata ?? data;
  const rtnprd = String(data.rtnprd ?? '');
  const period = /^\d{6}$/.test(rtnprd) ? `${rtnprd.slice(2)}-${rtnprd.slice(0, 2)}` : periodFallback;
  const out: PortalDoc[] = [];
  const b2b: any[] = Array.isArray(docdata.b2b) ? docdata.b2b : [];
  for (const sup of b2b) {
    for (const inv of sup.inv ?? []) {
      out.push({
        period, ctin: String(sup.ctin ?? '').toUpperCase(), trade_name: clean(sup.trdnm, 100), doc_type: 'INV',
        number: clean(inv.inum, 50), date: isoFromPortal(inv.dt), value: paise(inv.val), ...sums(inv),
        itc_available: inv.itcavl === 'N' ? 'N' : 'Y', reverse_charge: inv.rev === 'Y' ? 'Y' : 'N', pos: String(inv.pos ?? ''),
      });
    }
  }
  const cdnr: any[] = Array.isArray(docdata.cdnr) ? docdata.cdnr : [];
  for (const sup of cdnr) {
    for (const nt of sup.nt ?? []) {
      const s = sums(nt);
      const sign = nt.typ === 'D' ? 1 : -1;
      out.push({
        period, ctin: String(sup.ctin ?? '').toUpperCase(), trade_name: clean(sup.trdnm, 100), doc_type: 'CDN',
        number: clean(nt.ntnum, 50), date: isoFromPortal(nt.dt), value: sign * paise(nt.val),
        taxable: sign * s.taxable, igst: sign * s.igst, cgst: sign * s.cgst, sgst: sign * s.sgst, cess: sign * s.cess,
        itc_available: nt.itcavl === 'N' ? 'N' : 'Y', reverse_charge: nt.rev === 'Y' ? 'Y' : 'N', pos: String(nt.pos ?? ''),
      });
    }
  }
  if (!out.length) throw new CoreError('invalid', 'No supplier invoices found in the file');
  return out;
}

export async function importGstr2b(db: Db, json: unknown, period: string): Promise<{ period: string; imported: number }> {
  if (!/^\d{4}-\d{2}$/.test(period) && period) throw new CoreError('invalid', 'Period must be YYYY-MM');
  const docs = parseGstr2b(json, period);
  const p = docs[0].period || period;
  if (!/^\d{4}-\d{2}$/.test(p)) throw new CoreError('invalid', 'Return period could not be determined');
  let id = ((await one<{ m: number }>(db, 'SELECT COALESCE(MAX(id), 0) AS m FROM gstr2b_docs'))!.m) + 1;
  await db.batch([
    { sql: 'DELETE FROM gstr2b_docs WHERE period = ?', params: [p] },
    ...docs.map((d) => ({
      sql: `INSERT INTO gstr2b_docs (id, period, ctin, trade_name, doc_type, number, date, value, taxable, igst, cgst, sgst, cess, itc_available, reverse_charge, pos)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [id++, p, d.ctin, d.trade_name, d.doc_type, d.number, d.date, d.value, d.taxable, d.igst, d.cgst, d.sgst, d.cess, d.itc_available, d.reverse_charge, d.pos],
    })),
  ]);
  return { period: p, imported: docs.length };
}

export type Gstr2bStatus = 'Reconciled' | 'Mismatched' | 'Potential Match' | 'Available Only in Books' | 'Available Only in Portal';

export interface Gstr2bSide {
  number: string;
  date: string;
  taxable: number;
  tax: number;
  value: number;
}

export interface Gstr2bRow {
  status: Gstr2bStatus;
  ctin: string;
  party: string;
  books: Gstr2bSide | null;
  portal: Gstr2bSide | null;
  voucher_id: number | null;
  itc_available: string;
}

export const normDoc = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^0+/, '');

const TOL = 100;

export async function gstr2bReconciliation(books: Books, from: string, to: string): Promise<{ rows: Gstr2bRow[]; counts: Record<Gstr2bStatus, number>; totals: { books: Gstr2bSide; portal: Gstr2bSide } }> {
  const company = await books.requireCompany();
  const refs = new Map(
    (await books.db.select<{ id: number; reference: string }>('SELECT id, reference FROM vouchers')).map((r) => [r.id, r.reference])
  );
  const bookDocs = (await invoiceTaxes(books.db, from, to, company))
    .filter((i) => i.parent === 'Purchase' && i.gstin)
    .map((i) => ({
      voucher_id: i.voucher_id,
      ctin: i.gstin.toUpperCase(),
      party: i.party,
      side: { number: refs.get(i.voucher_id) || i.number, date: i.date, taxable: i.taxable, tax: i.igst + i.cgst + i.sgst + i.cess, value: i.total } as Gstr2bSide,
    }));
  const fromP = from.slice(0, 7);
  const toP = to.slice(0, 7);
  const portal = (
    await books.db.select<PortalDoc & { id: number }>('SELECT * FROM gstr2b_docs WHERE period >= ? AND period <= ? ORDER BY id', [fromP, toP])
  ).map((d) => ({ ...d, side: { number: d.number, date: d.date, taxable: d.taxable, tax: d.igst + d.cgst + d.sgst + d.cess, value: d.value } as Gstr2bSide }));

  const rows: Gstr2bRow[] = [];
  const usedPortal = new Set<number>();
  const unmatchedBooks: typeof bookDocs = [];
  for (const b of bookDocs) {
    const key = normDoc(b.side.number);
    const p = portal.find((x) => !usedPortal.has(x.id) && x.ctin === b.ctin && normDoc(x.number) === key);
    if (!p) {
      unmatchedBooks.push(b);
      continue;
    }
    usedPortal.add(p.id);
    const ok = Math.abs(p.side.taxable - b.side.taxable) <= TOL && Math.abs(p.side.tax - b.side.tax) <= TOL;
    rows.push({ status: ok ? 'Reconciled' : 'Mismatched', ctin: b.ctin, party: b.party, books: b.side, portal: p.side, voucher_id: b.voucher_id, itc_available: p.itc_available });
  }
  for (const b of unmatchedBooks) {
    const p = portal.find((x) => !usedPortal.has(x.id) && x.ctin === b.ctin && Math.abs(x.side.taxable - b.side.taxable) <= TOL && Math.abs(x.side.tax - b.side.tax) <= TOL);
    if (p) {
      usedPortal.add(p.id);
      rows.push({ status: 'Potential Match', ctin: b.ctin, party: b.party, books: b.side, portal: p.side, voucher_id: b.voucher_id, itc_available: p.itc_available });
    } else {
      rows.push({ status: 'Available Only in Books', ctin: b.ctin, party: b.party, books: b.side, portal: null, voucher_id: b.voucher_id, itc_available: '' });
    }
  }
  for (const p of portal) {
    if (usedPortal.has(p.id)) continue;
    rows.push({ status: 'Available Only in Portal', ctin: p.ctin, party: p.trade_name, books: null, portal: p.side, voucher_id: null, itc_available: p.itc_available });
  }
  const counts: Record<Gstr2bStatus, number> = { Reconciled: 0, Mismatched: 0, 'Potential Match': 0, 'Available Only in Books': 0, 'Available Only in Portal': 0 };
  for (const r of rows) counts[r.status] += 1;
  const zero = (): Gstr2bSide => ({ number: '', date: '', taxable: 0, tax: 0, value: 0 });
  const totals = { books: zero(), portal: zero() };
  for (const r of rows) {
    for (const k of ['books', 'portal'] as const) {
      const s = r[k];
      if (!s) continue;
      totals[k].taxable += s.taxable;
      totals[k].tax += s.tax;
      totals[k].value += s.value;
    }
  }
  rows.sort((a, b) => a.party.localeCompare(b.party) || (a.books?.date ?? a.portal?.date ?? '').localeCompare(b.books?.date ?? b.portal?.date ?? ''));
  return { rows, counts, totals };
}

export type GstSide = 'outward' | 'inward';

export interface HsnRow {
  hsn: string;
  uqc: string;
  qty: number;
  value: number;
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  rate_bp: number;
}

export async function hsnSummary(books: Books, from: string, to: string, side: GstSide = 'outward'): Promise<HsnRow[]> {
  const company = await books.requireCompany();
  const companyState = stateCodeOfGstin(company.gstin) || stateCode(company.state);
  const parents = side === 'outward' ? ['Sales', 'Credit Note'] : ['Purchase'];
  const invs = (await invoiceTaxes(books.db, from, to, company)).filter((i) => parents.includes(i.parent));
  const qtyRows = await books.db.select<{ voucher_id: number; hsn: string; symbol: string; qty: number }>(
    `SELECT m.voucher_id, i.hsn_sac AS hsn, u.symbol, SUM(m.qty) AS qty
     FROM stock_movements m JOIN stock_items i ON i.id = m.item_id JOIN units u ON u.id = i.unit_id JOIN vouchers v ON v.id = m.voucher_id
     WHERE v.date >= ? AND v.date <= ? GROUP BY m.voucher_id, i.hsn_sac, u.symbol`,
    [from, to]
  ).catch(() => []);
  const qtyBy = new Map<string, { symbol: string; qty: number }>();
  for (const q of qtyRows) qtyBy.set(`${q.voucher_id}|${q.hsn}`, { symbol: q.symbol, qty: q.qty });
  const map = new Map<string, HsnRow>();
  for (const i of invs) {
    const sign = i.parent === 'Credit Note' ? -1 : 1;
    const intra = !!companyState && i.pos === companyState;
    for (const h of i.hsn) {
      const key = `${h.hsn}|${h.rate_bp}`;
      const split = gstSplit(h.taxable, h.rate_bp, intra);
      const cur = map.get(key) ?? { hsn: h.hsn, uqc: '', qty: 0, value: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, rate_bp: h.rate_bp };
      const q = qtyBy.get(`${i.voucher_id}|${h.hsn}`);
      if (q) {
        cur.qty += sign * q.qty;
        cur.uqc = cur.uqc || q.symbol;
      }
      cur.taxable += sign * h.taxable;
      cur.igst += sign * split.igst;
      cur.cgst += sign * split.cgst;
      cur.sgst += sign * split.sgst;
      cur.value += sign * (h.taxable + split.igst + split.cgst + split.sgst);
      map.set(key, cur);
    }
  }
  return [...map.values()].sort((a, b) => a.hsn.localeCompare(b.hsn) || a.rate_bp - b.rate_bp);
}

export interface TaxAnalysisRow {
  rate_bp: number;
  count: number;
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  tax: number;
  total: number;
}

export async function taxAnalysis(books: Books, from: string, to: string, side: GstSide = 'outward'): Promise<TaxAnalysisRow[]> {
  const company = await books.requireCompany();
  const parents = side === 'outward' ? ['Sales', 'Credit Note'] : ['Purchase'];
  const map = new Map<number, TaxAnalysisRow>();
  for (const i of (await invoiceTaxes(books.db, from, to, company)).filter((x) => parents.includes(x.parent))) {
    const sign = i.parent === 'Credit Note' ? -1 : 1;
    const cur = map.get(i.rate_bp) ?? { rate_bp: i.rate_bp, count: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, tax: 0, total: 0 };
    cur.count += 1;
    cur.taxable += sign * i.taxable;
    cur.igst += sign * i.igst;
    cur.cgst += sign * i.cgst;
    cur.sgst += sign * i.sgst;
    cur.cess += sign * i.cess;
    cur.tax += sign * (i.igst + i.cgst + i.sgst + i.cess);
    cur.total += sign * i.total;
    map.set(i.rate_bp, cur);
  }
  return [...map.values()].sort((a, b) => a.rate_bp - b.rate_bp);
}
