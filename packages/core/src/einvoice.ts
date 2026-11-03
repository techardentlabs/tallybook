import { CoreError, one, type Db } from './db.ts';
import type { Books, Company, VoucherRow } from './books.ts';
import { gstSplit, invoiceTaxes, stateCode, stateCodeOfGstin, stateName, isValidGstin, type InvoiceTax } from './gst.ts';
import { clean, isIsoDate } from './util.ts';

export const EINVOICE_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS einvoice_docs (
    voucher_id INTEGER PRIMARY KEY REFERENCES vouchers(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','exported','generated','cancelled','excluded','rejected')),
    supply_type TEXT NOT NULL DEFAULT 'B2B',
    irn TEXT NOT NULL DEFAULT '',
    ack_no TEXT NOT NULL DEFAULT '',
    ack_date TEXT NOT NULL DEFAULT '',
    signed_qr TEXT NOT NULL DEFAULT '',
    signed_invoice TEXT NOT NULL DEFAULT '',
    cancel_reason TEXT NOT NULL DEFAULT '',
    cancel_remarks TEXT NOT NULL DEFAULT '',
    cancel_date TEXT NOT NULL DEFAULT '',
    reject_reason TEXT NOT NULL DEFAULT '',
    exported_on TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS eway_docs (
    voucher_id INTEGER PRIMARY KEY REFERENCES vouchers(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','exported','generated','cancelled')),
    supply_sub_type TEXT NOT NULL DEFAULT 'Supply',
    transporter_id TEXT NOT NULL DEFAULT '',
    transporter_name TEXT NOT NULL DEFAULT '',
    trans_doc_no TEXT NOT NULL DEFAULT '',
    trans_doc_date TEXT NOT NULL DEFAULT '',
    mode TEXT NOT NULL DEFAULT 'Road',
    vehicle_no TEXT NOT NULL DEFAULT '',
    vehicle_type TEXT NOT NULL DEFAULT 'Regular',
    distance_km INTEGER NOT NULL DEFAULT 0,
    ewb_no TEXT NOT NULL DEFAULT '',
    ewb_date TEXT NOT NULL DEFAULT '',
    valid_upto TEXT NOT NULL DEFAULT '',
    cancel_reason TEXT NOT NULL DEFAULT '',
    cancel_remarks TEXT NOT NULL DEFAULT '',
    cancel_date TEXT NOT NULL DEFAULT '',
    exported_on TEXT NOT NULL DEFAULT ''
  )`,
];

export type EInvoiceStatus = 'pending' | 'exported' | 'generated' | 'cancelled' | 'excluded' | 'rejected';
export type EwayStatus = 'pending' | 'exported' | 'generated' | 'cancelled';

export const SUPPLY_TYPES = ['B2B', 'SEZWP', 'SEZWOP', 'EXPWP', 'EXPWOP', 'DEXP'] as const;
export const EWB_SUB_TYPES: Record<string, number> = { Supply: 1, Import: 2, Export: 3, 'Job Work': 4, 'For Own Use': 5, 'Job work Returns': 6, 'Sales Return': 7, Others: 8, 'SKD/CKD': 9, 'Line Sales': 10, 'Recipient Not Known': 11, 'Exhibition or Fairs': 12 };
export const TRANSPORT_MODES: Record<string, string> = { Road: '1', Rail: '2', Air: '3', Ship: '4' };
export const VEHICLE_TYPES: Record<string, string> = { Regular: 'R', 'Over Dimensional Cargo': 'O' };
export const IRN_CANCEL_REASONS: Record<string, string> = { Duplicate: '1', 'Data Entry Mistake': '2', 'Order Cancelled': '3', Others: '4' };
export const EWB_CANCEL_REASONS: Record<string, number> = { Duplicate: 1, 'Order Cancelled': 2, 'Data Entry Mistake': 3, Others: 4 };

export interface EInvoiceDoc {
  voucher_id: number;
  status: EInvoiceStatus;
  supply_type: string;
  irn: string;
  ack_no: string;
  ack_date: string;
  signed_qr: string;
  signed_invoice: string;
  cancel_reason: string;
  cancel_remarks: string;
  cancel_date: string;
  reject_reason: string;
  exported_on: string;
}

export interface EwayDoc {
  voucher_id: number;
  status: EwayStatus;
  supply_sub_type: string;
  transporter_id: string;
  transporter_name: string;
  trans_doc_no: string;
  trans_doc_date: string;
  mode: string;
  vehicle_no: string;
  vehicle_type: string;
  distance_km: number;
  ewb_no: string;
  ewb_date: string;
  valid_upto: string;
  cancel_reason: string;
  cancel_remarks: string;
  cancel_date: string;
  exported_on: string;
}

export const DOC_TYPE: Record<string, 'INV' | 'CRN' | 'DBN'> = { Sales: 'INV', 'Credit Note': 'CRN', 'Debit Note': 'DBN' };

const UQC = ['BAG', 'BAL', 'BDL', 'BKL', 'BOU', 'BOX', 'BTL', 'BUN', 'CAN', 'CBM', 'CCM', 'CMS', 'CTN', 'DOZ', 'DRM', 'GGK', 'GMS', 'GRS', 'GYD', 'KGS', 'KLR', 'KME', 'LTR', 'MLT', 'MTR', 'MTS', 'NOS', 'PAC', 'PCS', 'PRS', 'QTL', 'ROL', 'SET', 'SQF', 'SQM', 'SQY', 'TBS', 'TGM', 'THD', 'TON', 'TUB', 'UGS', 'UNT', 'YDS', 'OTH'];

export function uqc(unit: string): string {
  const u = unit.trim().toUpperCase();
  if (UQC.includes(u)) return u;
  const alias: Record<string, string> = { NO: 'NOS', NUMBERS: 'NOS', KG: 'KGS', KILOGRAMS: 'KGS', LITRE: 'LTR', LITRES: 'LTR', L: 'LTR', METER: 'MTR', METRE: 'MTR', M: 'MTR', PIECE: 'PCS', PIECES: 'PCS', BOXES: 'BOX', TONNE: 'TON', TONNES: 'TON' };
  return alias[u] ?? 'OTH';
}

export function nicDate(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}

const rs = (paise: number) => Math.round(paise) / 100;

const EINV_DEFAULT = (voucher_id: number): EInvoiceDoc => ({
  voucher_id, status: 'pending', supply_type: 'B2B', irn: '', ack_no: '', ack_date: '', signed_qr: '', signed_invoice: '',
  cancel_reason: '', cancel_remarks: '', cancel_date: '', reject_reason: '', exported_on: '',
});

const EWB_DEFAULT = (voucher_id: number): EwayDoc => ({
  voucher_id, status: 'pending', supply_sub_type: 'Supply', transporter_id: '', transporter_name: '', trans_doc_no: '', trans_doc_date: '',
  mode: 'Road', vehicle_no: '', vehicle_type: 'Regular', distance_km: 0, ewb_no: '', ewb_date: '', valid_upto: '',
  cancel_reason: '', cancel_remarks: '', cancel_date: '', exported_on: '',
});

export async function getEInvoice(db: Db, voucherId: number): Promise<EInvoiceDoc> {
  return (await one<EInvoiceDoc>(db, 'SELECT * FROM einvoice_docs WHERE voucher_id = ?', [voucherId])) ?? EINV_DEFAULT(voucherId);
}

export async function getEway(db: Db, voucherId: number): Promise<EwayDoc> {
  return (await one<EwayDoc>(db, 'SELECT * FROM eway_docs WHERE voucher_id = ?', [voucherId])) ?? EWB_DEFAULT(voucherId);
}

async function requireVoucher(db: Db, id: number): Promise<void> {
  if (!(await one(db, 'SELECT 1 FROM vouchers WHERE id = ?', [id]))) throw new CoreError('not_found', 'Voucher not found');
}

async function upsert(db: Db, table: string, row: object): Promise<void> {
  const keys = Object.keys(row);
  await db.batch([
    {
      sql: `INSERT OR REPLACE INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
      params: Object.values(row) as (string | number)[],
    },
  ]);
}

export async function saveEInvoice(db: Db, voucherId: number, input: Partial<EInvoiceDoc>): Promise<EInvoiceDoc> {
  await requireVoucher(db, voucherId);
  const cur = await getEInvoice(db, voucherId);
  const m = { ...cur, ...input, voucher_id: voucherId };
  if (!(SUPPLY_TYPES as readonly string[]).includes(m.supply_type)) throw new CoreError('invalid', 'Supply type is invalid');
  await upsert(db, 'einvoice_docs', m);
  return getEInvoice(db, voucherId);
}

export async function saveEway(db: Db, voucherId: number, input: Partial<EwayDoc>): Promise<EwayDoc> {
  await requireVoucher(db, voucherId);
  const cur = await getEway(db, voucherId);
  const m = { ...cur, ...input, voucher_id: voucherId };
  m.transporter_id = clean(m.transporter_id, 15).toUpperCase();
  if (m.transporter_id && !/^[0-9A-Z]{15}$/.test(m.transporter_id)) throw new CoreError('invalid', 'Transporter ID must be a 15 character GSTIN');
  m.vehicle_no = clean(m.vehicle_no, 15).toUpperCase().replace(/[\s-]/g, '');
  if (m.vehicle_no && !/^[A-Z0-9]{7,15}$/.test(m.vehicle_no)) throw new CoreError('invalid', 'Vehicle number is invalid');
  if (!(m.supply_sub_type in EWB_SUB_TYPES)) throw new CoreError('invalid', 'Supply sub type is invalid');
  if (!(m.mode in TRANSPORT_MODES)) throw new CoreError('invalid', 'Mode of transport is invalid');
  if (!(m.vehicle_type in VEHICLE_TYPES)) throw new CoreError('invalid', 'Vehicle type is invalid');
  m.distance_km = Math.trunc(Number(m.distance_km) || 0);
  if (m.distance_km < 0 || m.distance_km > 4000) throw new CoreError('invalid', 'Distance must be between 0 and 4000 km');
  if (m.trans_doc_date && !isIsoDate(m.trans_doc_date)) throw new CoreError('invalid', 'Transporter document date is invalid');
  m.transporter_name = clean(m.transporter_name, 100);
  m.trans_doc_no = clean(m.trans_doc_no, 15);
  await upsert(db, 'eway_docs', m);
  return getEway(db, voucherId);
}

export async function recordIrn(db: Db, voucherId: number, r: { irn: string; ack_no: string; ack_date: string; signed_qr?: string; signed_invoice?: string; ewb_no?: string; ewb_date?: string; valid_upto?: string }): Promise<EInvoiceDoc> {
  if (!/^[0-9a-fA-F]{64}$/.test(r.irn)) throw new CoreError('invalid', 'IRN must be 64 hexadecimal characters');
  if (!clean(r.ack_no)) throw new CoreError('invalid', 'Acknowledgement number is required');
  const cur = await getEInvoice(db, voucherId);
  if (cur.status === 'cancelled') throw new CoreError('conflict', 'IRN is already cancelled');
  const doc = await saveEInvoice(db, voucherId, {
    status: 'generated', irn: r.irn.toLowerCase(), ack_no: clean(r.ack_no, 20), ack_date: clean(r.ack_date, 30),
    signed_qr: r.signed_qr ?? '', signed_invoice: r.signed_invoice ?? '', reject_reason: '',
  });
  if (r.ewb_no) await recordEwb(db, voucherId, { ewb_no: r.ewb_no, ewb_date: r.ewb_date ?? r.ack_date, valid_upto: r.valid_upto ?? '' });
  return doc;
}

export async function rejectIrn(db: Db, voucherId: number, reason: string): Promise<EInvoiceDoc> {
  return saveEInvoice(db, voucherId, { status: 'rejected', reject_reason: clean(reason, 500) });
}

export async function excludeEInvoice(db: Db, voucherId: number, excluded: boolean): Promise<EInvoiceDoc> {
  const cur = await getEInvoice(db, voucherId);
  if (cur.status === 'generated' || cur.status === 'cancelled') throw new CoreError('conflict', 'Cannot exclude a voucher with an IRN');
  return saveEInvoice(db, voucherId, { status: excluded ? 'excluded' : 'pending' });
}

export async function cancelIrn(db: Db, voucherId: number, reason: string, remarks: string, date: string): Promise<EInvoiceDoc> {
  const cur = await getEInvoice(db, voucherId);
  if (cur.status !== 'generated' || !cur.irn) throw new CoreError('conflict', 'No IRN to cancel');
  if (!(reason in IRN_CANCEL_REASONS)) throw new CoreError('invalid', 'Cancellation reason is invalid');
  if (!isIsoDate(date)) throw new CoreError('invalid', 'Cancellation date is invalid');
  const v = await one<{ date: string }>(db, 'SELECT date FROM vouchers WHERE id = ?', [voucherId]);
  const ack = cur.ack_date.slice(0, 10);
  if (ack && (Date.parse(date) - Date.parse(ack)) / 3600000 > 24) throw new CoreError('invalid', 'An IRN can be cancelled only within 24 hours of generation');
  void v;
  return saveEInvoice(db, voucherId, { status: 'cancelled', cancel_reason: reason, cancel_remarks: clean(remarks, 100), cancel_date: date });
}

export async function recordEwb(db: Db, voucherId: number, r: { ewb_no: string; ewb_date: string; valid_upto?: string }): Promise<EwayDoc> {
  if (!/^\d{12}$/.test(r.ewb_no)) throw new CoreError('invalid', 'E-way bill number must be 12 digits');
  return saveEway(db, voucherId, { status: 'generated', ewb_no: r.ewb_no, ewb_date: clean(r.ewb_date, 30), valid_upto: clean(r.valid_upto ?? '', 30) });
}

export async function cancelEwb(db: Db, voucherId: number, reason: string, remarks: string, date: string): Promise<EwayDoc> {
  const cur = await getEway(db, voucherId);
  if (cur.status !== 'generated' || !cur.ewb_no) throw new CoreError('conflict', 'No e-way bill to cancel');
  if (!(reason in EWB_CANCEL_REASONS)) throw new CoreError('invalid', 'Cancellation reason is invalid');
  if (!isIsoDate(date)) throw new CoreError('invalid', 'Cancellation date is invalid');
  return saveEway(db, voucherId, { status: 'cancelled', cancel_reason: reason, cancel_remarks: clean(remarks, 100), cancel_date: date });
}

interface Ctx {
  company: Company;
  v: VoucherRow;
  inv: InvoiceTax;
  intra: boolean;
  buyer: { name: string; mailing_name: string; address: string; state: string; pincode: string; gstin: string; phone: string; email: string };
  items: { name: string; hsn: string; unit: string; qty: number; rate: number; amount: number; rate_bp: number; is_service: boolean }[];
  total: number;
}

async function context(books: Books, voucherId: number): Promise<Ctx> {
  const v = await books.voucher(voucherId);
  if (!v) throw new CoreError('not_found', 'Voucher not found');
  if (!DOC_TYPE[v.parent]) throw new CoreError('invalid', 'Only sales, credit note and debit note vouchers support e-invoice and e-way bill');
  if (v.cancelled) throw new CoreError('invalid', 'Voucher is cancelled');
  if (!v.party_id) throw new CoreError('invalid', 'Party ledger is required');
  const company = await books.requireCompany();
  const inv = (await invoiceTaxes(books.db, v.date, v.date, company)).find((i) => i.voucher_id === voucherId);
  if (!inv) throw new CoreError('invalid', 'Voucher has no taxable supply');
  const buyer = (await one<Ctx['buyer']>(books.db, 'SELECT name, mailing_name, address, state, pincode, gstin, phone, email FROM ledgers WHERE id = ?', [v.party_id]))!;
  const sellerState = stateCodeOfGstin(company.gstin) || stateCode(company.state);
  const intra = !!sellerState && inv.pos === sellerState;
  const items: Ctx['items'] = [];
  if (v.stock.length) {
    const info = await books.db.select<{ id: number; hsn_sac: string; rate_bp: number; symbol: string }>(
      'SELECT i.id, i.hsn_sac, i.rate_bp, u.symbol FROM stock_items i JOIN units u ON u.id = i.unit_id'
    );
    for (const s of v.stock) {
      const it = info.find((x) => x.id === s.item_id);
      items.push({ name: s.item, hsn: it?.hsn_sac ?? '', unit: it?.symbol ?? 'NOS', qty: s.qty / 1000, rate: s.rate, amount: s.amount, rate_bp: it?.rate_bp || inv.rate_bp, is_service: (it?.hsn_sac ?? '').startsWith('99') });
    }
  } else {
    const lines = await books.db.select<{ name: string; hsn_sac: string; amount: number }>(
      `SELECT l.name, l.hsn_sac, e.amount FROM entries e JOIN ledgers l ON l.id = e.ledger_id JOIN groups g ON g.id = l.group_id
       WHERE e.voucher_id = ? AND l.duty_type <> 'GST' AND e.ledger_id <> ? ORDER BY e.seq`,
      [voucherId, v.party_id]
    );
    for (const l of lines) items.push({ name: l.name, hsn: l.hsn_sac, unit: 'NOS', qty: 1, rate: Math.abs(l.amount), amount: Math.abs(l.amount), rate_bp: inv.rate_bp, is_service: l.hsn_sac.startsWith('99') });
  }
  const party = v.entries.find((e) => e.ledger_id === v.party_id);
  return { company, v, inv, intra, buyer, items, total: Math.abs(party?.amount ?? inv.total) };
}

export interface MissingInfo {
  voucher_id: number;
  fields: string[];
}

export async function missingInfo(books: Books, voucherId: number): Promise<string[]> {
  const out: string[] = [];
  const c = await context(books, voucherId);
  if (!isValidGstin(c.company.gstin)) out.push('Supplier GSTIN');
  if (!c.company.address.trim()) out.push('Supplier address');
  if (!/^\d{6}$/.test(c.company.pincode)) out.push('Supplier pincode');
  if (!isValidGstin(c.buyer.gstin)) out.push('Buyer GSTIN');
  if (!c.buyer.address.trim()) out.push('Buyer address');
  if (!/^\d{6}$/.test(c.buyer.pincode)) out.push('Buyer pincode');
  if (!(stateCodeOfGstin(c.buyer.gstin) || stateCode(c.buyer.state))) out.push('Buyer state');
  if (c.items.some((i) => !/^\d{4,8}$/.test(i.hsn))) out.push('HSN/SAC');
  return out;
}

export async function buildEInvoiceJson(books: Books, voucherIds: number[]): Promise<object[]> {
  const out: object[] = [];
  for (const id of voucherIds) {
    const c = await context(books, id);
    const doc = await getEInvoice(books.db, id);
    const ew = await getEway(books.db, id);
    const buyerState = stateCodeOfGstin(c.buyer.gstin) || stateCode(c.buyer.state);
    const sellerState = stateCodeOfGstin(c.company.gstin) || stateCode(c.company.state);
    let ass = 0, cg = 0, sg = 0, ig = 0, tot = 0;
    const list = c.items.map((it, i) => {
      const split = gstSplit(it.amount, it.rate_bp, c.intra);
      const itemTot = it.amount + split.cgst + split.sgst + split.igst;
      ass += it.amount; cg += split.cgst; sg += split.sgst; ig += split.igst; tot += itemTot;
      return {
        SlNo: String(i + 1),
        PrdDesc: it.name,
        IsServc: it.is_service ? 'Y' : 'N',
        HsnCd: it.hsn,
        Qty: it.qty,
        Unit: uqc(it.unit),
        UnitPrice: rs(it.rate),
        TotAmt: rs(it.amount),
        Discount: 0,
        AssAmt: rs(it.amount),
        GstRt: it.rate_bp / 100,
        IgstAmt: rs(split.igst),
        CgstAmt: rs(split.cgst),
        SgstAmt: rs(split.sgst),
        TotItemVal: rs(itemTot),
      };
    });
    const addr = (a: string) => {
      const parts = a.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      return { Addr1: (parts[0] ?? '').slice(0, 100), Addr2: parts.slice(1).join(', ').slice(0, 100) || null };
    };
    out.push({
      Version: '1.1',
      TranDtls: { TaxSch: 'GST', SupTyp: doc.supply_type, RegRev: c.v.reverse_charge ? 'Y' : 'N', EcmGstin: null, IgstOnIntra: 'N' },
      DocDtls: { Typ: DOC_TYPE[c.v.parent], No: c.v.number, Dt: nicDate(c.v.date) },
      SellerDtls: {
        Gstin: c.company.gstin,
        LglNm: c.company.mailing_name || c.company.name,
        TrdNm: c.company.name,
        ...addr(c.company.address),
        Loc: stateName(sellerState) || c.company.state,
        Pin: Number(c.company.pincode) || 0,
        Stcd: sellerState,
        Ph: c.company.phone || null,
        Em: c.company.email || null,
      },
      BuyerDtls: {
        Gstin: c.buyer.gstin,
        LglNm: c.buyer.mailing_name || c.buyer.name,
        TrdNm: c.buyer.name,
        Pos: c.inv.pos || buyerState,
        ...addr(c.buyer.address),
        Loc: stateName(buyerState) || c.buyer.state,
        Pin: Number(c.buyer.pincode) || 0,
        Stcd: buyerState,
        Ph: c.buyer.phone || null,
        Em: c.buyer.email || null,
      },
      ItemList: list,
      ValDtls: {
        AssVal: rs(ass), CgstVal: rs(cg), SgstVal: rs(sg), IgstVal: rs(ig), CesVal: 0, StCesVal: 0, Discount: 0, OthChrg: 0,
        RndOffAmt: rs(c.total - tot), TotInvVal: rs(c.total),
      },
      ...(ew.transporter_id || ew.vehicle_no
        ? {
            EwbDtls: {
              Transid: ew.transporter_id || null,
              Transname: ew.transporter_name || null,
              Distance: ew.distance_km,
              Transdocno: ew.trans_doc_no || null,
              TransdocDt: ew.trans_doc_date ? nicDate(ew.trans_doc_date) : null,
              Vehno: ew.vehicle_no || null,
              Vehtype: VEHICLE_TYPES[ew.vehicle_type],
              TransMode: TRANSPORT_MODES[ew.mode],
            },
          }
        : {}),
    });
  }
  return out;
}

export async function buildEwayJson(books: Books, voucherIds: number[]): Promise<{ version: string; billLists: object[] }> {
  const billLists: object[] = [];
  for (const id of voucherIds) {
    const c = await context(books, id);
    const ew = await getEway(books.db, id);
    const buyerState = stateCodeOfGstin(c.buyer.gstin) || stateCode(c.buyer.state);
    const sellerState = stateCodeOfGstin(c.company.gstin) || stateCode(c.company.state);
    let cg = 0, sg = 0, ig = 0;
    const itemList = c.items.map((it) => {
      const split = gstSplit(it.amount, it.rate_bp, c.intra);
      cg += split.cgst; sg += split.sgst; ig += split.igst;
      return {
        productName: it.name,
        productDesc: it.name,
        hsnCode: Number(it.hsn) || 0,
        quantity: it.qty,
        qtyUnit: uqc(it.unit),
        taxableAmount: rs(it.amount),
        sgstRate: c.intra ? it.rate_bp / 200 : 0,
        cgstRate: c.intra ? it.rate_bp / 200 : 0,
        igstRate: c.intra ? 0 : it.rate_bp / 100,
        cessRate: 0,
      };
    });
    const taxable = c.items.reduce((s, i) => s + i.amount, 0);
    billLists.push({
      userGstin: c.company.gstin,
      supplyType: c.v.parent === 'Sales' ? 'O' : 'I',
      subSupplyType: EWB_SUB_TYPES[ew.supply_sub_type],
      subSupplyDesc: '',
      docType: DOC_TYPE[c.v.parent] === 'INV' ? 'INV' : 'CHL',
      docNo: c.v.number,
      docDate: nicDate(c.v.date),
      fromGstin: c.company.gstin,
      fromTrdName: c.company.name,
      fromAddr1: c.company.address.split(/\r?\n/)[0] ?? '',
      fromAddr2: c.company.address.split(/\r?\n/).slice(1).join(', '),
      fromPlace: stateName(sellerState),
      fromPincode: Number(c.company.pincode) || 0,
      actFromStateCode: Number(sellerState) || 0,
      fromStateCode: Number(sellerState) || 0,
      toGstin: c.buyer.gstin,
      toTrdName: c.buyer.name,
      toAddr1: c.buyer.address.split(/\r?\n/)[0] ?? '',
      toAddr2: c.buyer.address.split(/\r?\n/).slice(1).join(', '),
      toPlace: stateName(buyerState),
      toPincode: Number(c.buyer.pincode) || 0,
      actToStateCode: Number(buyerState) || 0,
      toStateCode: Number(buyerState) || 0,
      transactionType: 1,
      otherValue: 0,
      totalValue: rs(taxable),
      cgstValue: rs(cg),
      sgstValue: rs(sg),
      igstValue: rs(ig),
      cessValue: 0,
      cessNonAdvolValue: 0,
      totInvValue: rs(c.total),
      transporterId: ew.transporter_id,
      transporterName: ew.transporter_name,
      transDocNo: ew.trans_doc_no,
      transMode: TRANSPORT_MODES[ew.mode],
      transDistance: String(ew.distance_km),
      transDocDate: ew.trans_doc_date ? nicDate(ew.trans_doc_date) : '',
      vehicleNo: ew.vehicle_no,
      vehicleType: VEHICLE_TYPES[ew.vehicle_type],
      itemList,
    });
  }
  return { version: '1.0.0621', billLists };
}

export function buildIrnCancelJson(doc: EInvoiceDoc): object {
  if (!doc.irn) throw new CoreError('invalid', 'No IRN to cancel');
  return { Irn: doc.irn, CnlRsn: IRN_CANCEL_REASONS[doc.cancel_reason] ?? '4', CnlRem: doc.cancel_remarks };
}

export function buildEwbCancelJson(doc: EwayDoc): object {
  if (!doc.ewb_no) throw new CoreError('invalid', 'No e-way bill to cancel');
  return { ewbNo: Number(doc.ewb_no), cancelRsnCode: EWB_CANCEL_REASONS[doc.cancel_reason] ?? 4, cancelRmrk: doc.cancel_remarks };
}

export async function markExported(db: Db, kind: 'einvoice' | 'eway', voucherIds: number[], on: string): Promise<void> {
  for (const id of voucherIds) {
    if (kind === 'einvoice') {
      const cur = await getEInvoice(db, id);
      if (cur.status === 'pending' || cur.status === 'rejected') await saveEInvoice(db, id, { status: 'exported', exported_on: on });
    } else {
      const cur = await getEway(db, id);
      if (cur.status === 'pending') await saveEway(db, id, { status: 'exported', exported_on: on });
    }
  }
}

export interface EInvRow {
  voucher_id: number;
  date: string;
  party: string;
  gstin: string;
  vch_type: string;
  number: string;
  amount: number;
  status: EInvoiceStatus;
  category: string;
  missing: string[];
  irn: string;
}

export async function eInvoiceRows(books: Books, from: string, to: string): Promise<EInvRow[]> {
  const company = await books.requireCompany();
  const rows = await books.db.select<{ id: number; date: string; number: string; type: string; parent: string; party: string; gstin: string }>(
    `SELECT v.id, v.date, v.number, t.name AS type, t.parent, COALESCE(p.name, '') AS party, COALESCE(p.gstin, '') AS gstin
     FROM vouchers v JOIN voucher_types t ON t.id = v.type_id LEFT JOIN ledgers p ON p.id = v.party_id
     WHERE v.date >= ? AND v.date <= ? AND v.cancelled = 0 AND t.parent IN ('Sales','Credit Note','Debit Note')
     ORDER BY v.date, v.id`,
    [from, to]
  );
  const taxes = new Map((await invoiceTaxes(books.db, from, to, company)).map((i) => [i.voucher_id, i]));
  const out: EInvRow[] = [];
  for (const r of rows) {
    if (!r.gstin) continue;
    const doc = await getEInvoice(books.db, r.id);
    const inv = taxes.get(r.id);
    let missing: string[] = [];
    if (doc.status === 'pending' || doc.status === 'rejected') missing = await missingInfo(books, r.id).catch(() => ['Voucher details']);
    let category = 'Pending for IRN generation';
    if (doc.status === 'generated') category = 'IRN Generated';
    else if (doc.status === 'cancelled') category = 'IRN Cancelled';
    else if (doc.status === 'excluded') category = 'User-Excluded Transactions';
    else if (doc.status === 'exported') category = 'Exported for IRN generation';
    else if (doc.status === 'rejected') category = 'Rejected by e-Invoice System';
    else if (missing.length) category = 'Information required for e-Invoice not provided';
    out.push({
      voucher_id: r.id, date: r.date, party: r.party, gstin: r.gstin, vch_type: r.type, number: r.number,
      amount: (r.parent === 'Credit Note' ? -1 : 1) * (inv?.total ?? 0), status: doc.status, category, missing, irn: doc.irn,
    });
  }
  return out;
}

export interface EInvSummaryLine {
  key: string;
  label: string;
  level: 0 | 1;
  count: number;
}

export const EINV_CATEGORIES: { key: string; label: string; level: 0 | 1; parent?: string }[] = [
  { key: 'Uncertain', label: 'Uncertain Transactions (Corrections needed)', level: 0 },
  { key: 'Missing/Invalid Information', label: 'Missing/Invalid Information', level: 0 },
  { key: 'Information required for e-Invoice not provided', label: 'Information required for e-Invoice not provided', level: 1 },
  { key: 'Rejected by e-Invoice System', label: 'Rejected by e-Invoice System', level: 0 },
  { key: 'Pending for Exchange', label: 'Pending for Exchange with e-Invoice System', level: 0 },
  { key: 'Pending for IRN generation', label: 'For IRN generation', level: 1 },
  { key: 'Exported', label: 'Exported', level: 0 },
  { key: 'Exported for IRN generation', label: 'For IRN generation', level: 1 },
  { key: 'IRN Generated', label: 'IRN Generated', level: 0 },
  { key: 'IRN Cancelled', label: 'IRN Cancelled', level: 0 },
  { key: 'User-Excluded Transactions', label: 'User-Excluded Transactions', level: 0 },
];

export async function eInvoiceSummary(books: Books, from: string, to: string): Promise<{ rows: EInvRow[]; lines: EInvSummaryLine[] }> {
  const rows = await eInvoiceRows(books, from, to);
  const n = (cat: string) => rows.filter((r) => r.category === cat).length;
  const missing = n('Information required for e-Invoice not provided');
  const pending = n('Pending for IRN generation');
  const exported = n('Exported for IRN generation');
  const rejected = n('Rejected by e-Invoice System');
  const lines: EInvSummaryLine[] = EINV_CATEGORIES.map((c) => {
    let count = n(c.key);
    if (c.key === 'Uncertain') count = missing + rejected;
    if (c.key === 'Missing/Invalid Information') count = missing;
    if (c.key === 'Pending for Exchange') count = pending;
    if (c.key === 'Exported') count = exported;
    return { key: c.key, label: c.label, level: c.level, count };
  });
  return { rows, lines };
}

export interface EwbRow {
  voucher_id: number;
  date: string;
  party: string;
  gstin: string;
  vch_type: string;
  number: string;
  amount: number;
  status: EwayStatus;
  ewb_no: string;
  valid_upto: string;
}

export const EWB_THRESHOLD = 50000_00;

export async function eWayBillRows(books: Books, from: string, to: string, includeBelowLimit = false): Promise<EwbRow[]> {
  const company = await books.requireCompany();
  const rows = await books.db.select<{ id: number; date: string; number: string; type: string; party: string; gstin: string }>(
    `SELECT v.id, v.date, v.number, t.name AS type, COALESCE(p.name, '') AS party, COALESCE(p.gstin, '') AS gstin
     FROM vouchers v JOIN voucher_types t ON t.id = v.type_id LEFT JOIN ledgers p ON p.id = v.party_id
     WHERE v.date >= ? AND v.date <= ? AND v.cancelled = 0 AND t.parent = 'Sales' ORDER BY v.date, v.id`,
    [from, to]
  );
  const taxes = new Map((await invoiceTaxes(books.db, from, to, company)).map((i) => [i.voucher_id, i]));
  const out: EwbRow[] = [];
  for (const r of rows) {
    const doc = await getEway(books.db, r.id);
    const total = taxes.get(r.id)?.total ?? 0;
    if (doc.status === 'pending' && !includeBelowLimit && total <= EWB_THRESHOLD) continue;
    out.push({ voucher_id: r.id, date: r.date, party: r.party, gstin: r.gstin, vch_type: r.type, number: r.number, amount: total, status: doc.status, ewb_no: doc.ewb_no, valid_upto: doc.valid_upto });
  }
  return out;
}
