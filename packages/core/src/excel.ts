import { CoreError } from './db.ts';
import type { Books, BillInput, StockLineInput, Group } from './books.ts';
import { parseXml, type XNode } from './xml.ts';
import { clean, isIsoDate } from './util.ts';
import { decimalToPaise } from './tally-xml.ts';
import { STOCK_VOUCHER_TYPES } from './schema.ts';
import {
  createGodown, createStockCategory, createStockGroup, createStockItem, createUnit, godowns, lineAmount, parseQty, stockCategories, stockGroups, stockItems, units, updateStockItem,
} from './inventory.ts';
import { costCategories, costCentres, createCostCentre, ensureCosting, saveEntryAllocations, updateCostCentre } from './costing.ts';

export interface Sheet {
  name: string;
  rows: string[][];
}

export const IMPORT_FILE_FORMATS = ['Excel (Spreadsheet)', 'JSON (Data Exchange)', 'XML (Data Interchange)'] as const;
export const IMPORT_BEHAVIOURS = ['Combine Opening Balance', 'Ignore Duplicates', 'Modify with New Data'] as const;
export type ImportBehaviour = (typeof IMPORT_BEHAVIOURS)[number];

export type MasterKind = 'group' | 'ledger' | 'stock_group' | 'stock_category' | 'stock_item' | 'unit' | 'godown' | 'cost_centre';

export const MASTER_TYPES: { kind: MasterKind; label: string }[] = [
  { kind: 'group', label: 'Group' },
  { kind: 'ledger', label: 'Ledger' },
  { kind: 'stock_group', label: 'Stock Group' },
  { kind: 'stock_category', label: 'Stock Category' },
  { kind: 'stock_item', label: 'Stock Item' },
  { kind: 'unit', label: 'Unit' },
  { kind: 'godown', label: 'Godown' },
  { kind: 'cost_centre', label: 'Cost Centre' },
];

export const DEFAULT_TEMPLATE = 'Default Template';

export const MAPPING_TEMPLATES: { name: string; type: string; scope: 'All Companies' }[] = [
  { name: 'Group', type: 'Group', scope: 'All Companies' },
  { name: 'Groups', type: 'Group', scope: 'All Companies' },
  { name: 'Ledger', type: 'Ledger', scope: 'All Companies' },
  { name: 'Stock Items', type: 'Stock Item', scope: 'All Companies' },
];

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function unzip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new CoreError('invalid', 'This file is not a valid Excel workbook');
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new CoreError('invalid', 'Corrupt workbook directory');
    const method = v.getUint16(p + 10, true);
    const csize = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const dataStart = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const raw = bytes.subarray(dataStart, dataStart + csize);
    if (method === 0) out.set(name, raw);
    else if (method === 8) out.set(name, await inflateRaw(raw));
    else throw new CoreError('invalid', 'Unsupported compression in workbook');
  }
  return out;
}

const local = (n: XNode) => n.name.replace(/^.*:/, '');
const kids = (n: XNode, name: string) => n.children.filter((c) => local(c) === name);
const kid = (n: XNode, name: string) => n.children.find((c) => local(c) === name);

function findAll(n: XNode, name: string, out: XNode[] = []): XNode[] {
  for (const c of n.children) {
    if (local(c) === name) out.push(c);
    findAll(c, name, out);
  }
  return out;
}

function richText(si: XNode): string {
  let s = '';
  for (const c of si.children) {
    if (local(c) === 't') s += c.text;
    else if (local(c) === 'r') for (const t of kids(c, 't')) s += t.text;
  }
  return s;
}

function colIndex(ref: string): number {
  const m = /^([A-Za-z]+)/.exec(ref);
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1].toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

const BUILTIN_DATE_FMTS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

function isDateFormat(code: string): boolean {
  const t = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
  return /[dy]/i.test(t) && !/^general$/i.test(t);
}

export function excelSerialToIso(serial: number): string {
  const days = Math.floor(serial);
  const ms = Date.UTC(1899, 11, 30) + days * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

function dateStyles(styles: XNode | null): Set<number> {
  const out = new Set<number>();
  if (!styles) return out;
  const custom = new Map<number, string>();
  const fmts = kid(styles, 'numFmts');
  if (fmts) for (const f of kids(fmts, 'numFmt')) custom.set(Number(f.attrs.numFmtId), f.attrs.formatCode ?? '');
  const xfs = kid(styles, 'cellXfs');
  if (xfs) {
    kids(xfs, 'xf').forEach((xf, i) => {
      const id = Number(xf.attrs.numFmtId ?? 0);
      if (BUILTIN_DATE_FMTS.has(id) || (custom.has(id) && isDateFormat(custom.get(id)!))) out.add(i);
    });
  }
  return out;
}

function sheetRows(doc: XNode, shared: string[], dates: Set<number>): string[][] {
  const rows: string[][] = [];
  const data = findAll(doc, 'sheetData')[0];
  if (!data) return rows;
  let rowNo = 0;
  for (const r of kids(data, 'row')) {
    rowNo = r.attrs.r ? Number(r.attrs.r) - 1 : rowNo;
    const cells: string[] = [];
    let next = 0;
    for (const c of kids(r, 'c')) {
      const idx = c.attrs.r ? colIndex(c.attrs.r) : next;
      next = idx + 1;
      const t = c.attrs.t ?? 'n';
      const vNode = kid(c, 'v');
      let val = '';
      if (t === 's') val = vNode ? (shared[Number(vNode.text)] ?? '') : '';
      else if (t === 'inlineStr') {
        const is = kid(c, 'is');
        val = is ? richText(is) : '';
      } else if (t === 'b') val = vNode?.text.trim() === '1' ? 'TRUE' : 'FALSE';
      else if (t === 'str' || t === 'e') val = vNode?.text ?? '';
      else if (vNode) {
        const raw = vNode.text.trim();
        val = dates.has(Number(c.attrs.s ?? -1)) && /^-?\d+(\.\d+)?$/.test(raw) ? excelSerialToIso(Number(raw)) : raw;
      }
      while (cells.length < idx) cells.push('');
      cells[idx] = val;
    }
    while (rows.length < rowNo) rows.push([]);
    rows[rowNo] = cells;
    rowNo += 1;
  }
  return rows.map((r) => Array.from(r, (x) => x ?? ''));
}

export async function parseXlsx(bytes: Uint8Array): Promise<Sheet[]> {
  const files = await unzip(bytes);
  const dec = new TextDecoder();
  const text = (n: string) => (files.has(n) ? dec.decode(files.get(n)!) : null);
  const wbText = text('xl/workbook.xml');
  if (!wbText) throw new CoreError('invalid', 'This file is not an Excel workbook');
  const wb = parseXml(wbText);
  const relsText = text('xl/_rels/workbook.xml.rels');
  const rels = new Map<string, string>();
  if (relsText) for (const r of findAll(parseXml(relsText), 'Relationship')) rels.set(r.attrs.Id, r.attrs.Target);
  const sstText = text('xl/sharedStrings.xml');
  const shared = sstText ? kids(parseXml(sstText), 'si').map(richText) : [];
  const stText = text('xl/styles.xml');
  const dates = dateStyles(stText ? parseXml(stText) : null);
  const sheetsNode = findAll(wb, 'sheet');
  const out: Sheet[] = [];
  let i = 0;
  for (const s of sheetsNode) {
    i += 1;
    const rid = s.attrs['r:id'] ?? s.attrs.id;
    let target = rid ? rels.get(rid) : undefined;
    target = target ? (target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.?\/?/, '')}`) : `xl/worksheets/sheet${i}.xml`;
    const xml = text(target);
    if (xml === null) continue;
    out.push({ name: s.attrs.name ?? `Sheet${i}`, rows: sheetRows(parseXml(xml), shared, dates) });
  }
  if (!out.length) throw new CoreError('invalid', 'The workbook has no worksheets');
  return out;
}

export function parseCsvRows(input: string, delimiter?: string): string[][] {
  const text = input.replace(/^﻿/, '');
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const d = delimiter ?? ([',', ';', '\t', '|'].map((c) => ({ c, n: first.split(c).length })).sort((a, b) => b.n - a.n)[0].c);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === d) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export function toCsv(rows: (string | number)[][]): string {
  return rows.map((r) => r.map((c) => (/[",\n\r]/.test(String(c)) ? `"${String(c).replaceAll('"', '""')}"` : String(c))).join(',')).join('\r\n');
}

function decode(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  return new TextDecoder('utf-8').decode(bytes);
}

export async function readSpreadsheet(fileName: string, bytes: Uint8Array): Promise<Sheet[]> {
  const isZip = bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (isZip) return parseXlsx(bytes);
  if (/\.xlsx?$/i.test(fileName) && !/\.csv$/i.test(fileName)) throw new CoreError('invalid', 'Only .xlsx workbooks and .csv files can be read');
  return [{ name: fileName.replace(/\.[^.]+$/, ''), rows: parseCsvRows(decode(bytes)) }];
}

export function pickSheet(sheets: Sheet[], name: string): Sheet | null {
  const t = name.trim().toLowerCase();
  return sheets.find((s) => s.name.trim().toLowerCase() === t) ?? null;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

interface FieldSpec {
  key: string;
  label: string;
  aliases: string[];
  required?: boolean;
}

const f = (key: string, label: string, aliases: string[], required = false): FieldSpec => ({ key, label, aliases, required });

const LEDGER_FIELDS: FieldSpec[] = [
  f('name', 'Name', ['name', 'ledgername'], true),
  f('group', 'Group Name', ['groupname', 'under', 'parent', 'parentgroup', 'group'], true),
  f('opening', 'Ledger - Opening Balance', ['ledgeropeningbalance', 'openingbalance', 'opening', 'ledgeropening']),
  f('openingDrCr', 'Ledger Opening Balance - Dr/Cr', ['ledgeropeningbalancedrcr', 'openingbalancedrcr', 'openingdrcr', 'ledgeropeningdrcr']),
  f('billDate', 'Bill - Date', ['billdate']),
  f('billName', 'Bill - Name', ['billname']),
  f('billAmount', 'Bill - Amount', ['billamount']),
  f('billDrCr', 'Bill Amount - Dr/Cr', ['billamountdrcr', 'billdrcr']),
  f('alias', 'Alias', ['alias']),
  f('mailing_name', 'Mailing Name', ['mailingname']),
  f('address', 'Address', ['address']),
  f('state', 'State', ['state']),
  f('country', 'Country', ['country']),
  f('pincode', 'Pincode', ['pincode', 'pin']),
  f('phone', 'Phone', ['phone', 'phoneno', 'mobile', 'mobileno']),
  f('email', 'E-mail', ['email', 'emailid']),
  f('contact', 'Contact Person', ['contactperson', 'contact']),
  f('pan', 'PAN', ['pan', 'panitno', 'incometaxnumber']),
  f('gstin', 'GSTIN', ['gstin', 'gstinuin', 'partygstin']),
  f('credit_days', 'Credit Period', ['creditperiod', 'creditdays']),
];

const FIELDS: Record<MasterKind, FieldSpec[]> = {
  group: [
    f('name', 'Name', ['name', 'groupname', 'group'], true),
    f('parent', 'Under', ['under', 'parent', 'parentgroup', 'groupname', 'group']),
    f('nature', 'Nature of Group', ['natureofgroup', 'nature']),
    f('alias', 'Alias', ['alias']),
  ],
  ledger: LEDGER_FIELDS,
  stock_group: [f('name', 'Name', ['name', 'stockgroupname', 'groupname'], true), f('parent', 'Under', ['under', 'parent', 'parentgroup']), f('alias', 'Alias', ['alias'])],
  stock_category: [f('name', 'Name', ['name', 'categoryname', 'stockcategoryname'], true), f('parent', 'Under', ['under', 'parent'])],
  stock_item: [
    f('name', 'Name', ['name', 'itemname', 'stockitemname', 'stockitem', 'item'], true),
    f('alias', 'Alias', ['alias']),
    f('group', 'Under', ['under', 'stockgroup', 'group', 'groupname', 'parent']),
    f('category', 'Category', ['category', 'stockcategory']),
    f('unit', 'Units', ['unitofmeasurement', 'unit', 'units', 'uom', 'baseunits', 'baseunit'], true),
    f('qty', 'Opening Quantity', ['openingbalancequantity', 'openingquantity', 'openingqty', 'quantity', 'qty', 'openingbalance']),
    f('rate', 'Rate', ['openingrate', 'rate']),
    f('value', 'Value', ['openingvalue', 'value', 'amount']),
    f('hsn', 'HSN/SAC', ['hsnsac', 'hsncode', 'hsn', 'sac']),
    f('gst', 'GST Rate', ['gstrate', 'igstrate', 'rateofgst', 'taxrate', 'gst']),
    f('part_no', 'Part No.', ['partno', 'partnumber']),
  ],
  unit: [
    f('symbol', 'Symbol', ['symbol', 'unit', 'name'], true),
    f('type', 'Type of Unit', ['typeofunit', 'type']),
    f('formal', 'Formal name', ['formalname']),
    f('first', 'First unit', ['firstunit']),
    f('conversion', 'Conversion', ['conversion']),
    f('second', 'Second unit', ['secondunit']),
    f('decimals', 'Number of Decimal Places', ['numberofdecimalplaces', 'decimalplaces', 'decimals']),
  ],
  godown: [f('name', 'Name', ['name', 'godownname', 'location'], true), f('parent', 'Under', ['under', 'parent']), f('address', 'Address', ['address'])],
  cost_centre: [f('name', 'Name', ['name', 'costcentrename', 'costcentre'], true), f('category', 'Category', ['category', 'costcategory']), f('parent', 'Under', ['under', 'parent'])],
};

const VOUCHER_FIELDS: FieldSpec[] = [
  f('date', 'Voucher Date', ['voucherdate', 'date'], true),
  f('type', 'Voucher Type Name', ['vouchertypename', 'vouchertype', 'type'], true),
  f('number', 'Voucher Number', ['vouchernumber', 'invoicenumber', 'voucherno', 'invoiceno']),
  f('ledger', 'Ledger Name', ['ledgername', 'ledger'], true),
  f('amount', 'Ledger Amount', ['ledgeramount', 'ledgeramt', 'amount'], true),
  f('drcr', 'Ledger Amount Dr/Cr', ['ledgeramountdrcr', 'drcr', 'ledgerdrcr', 'amountdrcr'], true),
  f('narration', 'Narration', ['narration']),
  f('reference', 'Reference No.', ['referenceno', 'reference', 'supplierinvoiceno']),
  f('party', 'Party Ledger Name', ['partyledgername', 'partyname', 'party']),
  f('item', 'Stock Item Name', ['itemname', 'stockitemname', 'stockitem']),
  f('qty', 'Quantity', ['quantity', 'qty', 'billedquantity']),
  f('uom', 'Unit', ['uom', 'unit', 'unitofmeasurement']),
  f('rate', 'Rate', ['rate']),
  f('value', 'Value', ['value', 'itemvalue', 'itemamount']),
  f('godown', 'Godown Name', ['godownname', 'godown', 'location']),
  f('billName', 'Bill Name', ['billname', 'billref', 'billreference']),
  f('billType', 'Bill Type', ['billtype', 'typeofref']),
  f('costCentre', 'Cost Centre Name', ['costcentrename', 'costcentre']),
  f('costAmount', 'Cost Centre Amount', ['costcentreamount', 'costamount']),
];

export interface ColumnMap {
  field: string;
  label: string;
  column: string | null;
  required: boolean;
}

function headerRowIndex(rows: string[][]): number {
  const i = rows.findIndex((r) => r.some((c) => clean(c)));
  return i < 0 ? 0 : i;
}

function mapColumns(header: string[], specs: FieldSpec[]): { idx: Record<string, number>; map: ColumnMap[] } {
  const normed = header.map(norm);
  const used = new Set<number>();
  const idx: Record<string, number> = {};
  const map: ColumnMap[] = [];
  for (const s of specs) {
    let found = -1;
    for (const a of s.aliases) {
      const i = normed.findIndex((h, k) => h === a && !used.has(k));
      if (i >= 0) {
        found = i;
        break;
      }
    }
    if (found >= 0) {
      used.add(found);
      idx[s.key] = found;
    }
    map.push({ field: s.key, label: s.label, column: found >= 0 ? header[found].trim() : null, required: !!s.required });
  }
  return { idx, map };
}

export function previewMapping(rows: string[][], kind: MasterKind | 'voucher'): ColumnMap[] {
  const specs = kind === 'voucher' ? VOUCHER_FIELDS : FIELDS[kind];
  return mapColumns(rows[headerRowIndex(rows)] ?? [], specs).map;
}

export function guessMasterKind(sheetName: string, rows: string[][]): MasterKind | null {
  const s = norm(sheetName);
  const h = (rows[headerRowIndex(rows)] ?? []).map(norm);
  if (h.includes('typeofunit') || h.includes('formalname')) return 'unit';
  if (h.includes('godownname') || s.startsWith('godown') || s.startsWith('location')) return 'godown';
  if (s.startsWith('costcentre') || h.includes('costcentrename')) return 'cost_centre';
  if (s.startsWith('stockitem') || h.includes('itemname') || h.includes('stockitemname')) return 'stock_item';
  if (s.startsWith('stockgroup')) return 'stock_group';
  if (s.startsWith('stockcategor')) return 'stock_category';
  if (s.startsWith('ledger') || h.includes('ledgeropeningbalance') || (h.includes('name') && h.includes('groupname'))) return 'ledger';
  if (s.startsWith('group')) return 'group';
  return null;
}

export function isVoucherSheet(rows: string[][]): boolean {
  const h = (rows[headerRowIndex(rows)] ?? []).map(norm);
  return h.some((x) => ['voucherdate', 'date'].includes(x)) && h.some((x) => ['ledgername', 'ledger'].includes(x)) && h.some((x) => ['drcr', 'ledgeramountdrcr', 'ledgerdrcr', 'amountdrcr'].includes(x));
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function parseCellDate(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  if (isIsoDate(t as unknown)) return t;
  if (/^\d{8}$/.test(t)) {
    const iso = `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
    return isIsoDate(iso) ? iso : null;
  }
  if (/^\d{5}(\.\d+)?$/.test(t)) {
    const n = Number(t);
    return n > 20000 && n < 80000 ? excelSerialToIso(n) : null;
  }
  let m = /^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2}|\d{4})$/.exec(t);
  let d: number, mo: number, y: number;
  if (m) {
    d = Number(m[1]);
    mo = Number(m[2]);
    y = Number(m[3]);
  } else {
    m = /^(\d{1,2})[-/. ]([A-Za-z]{3})[a-z]*[-/. ,]*(\d{2}|\d{4})$/.exec(t);
    if (!m) return null;
    d = Number(m[1]);
    mo = MONTHS.indexOf(m[2].toLowerCase()) + 1;
    y = Number(m[3]);
    if (!mo) return null;
  }
  if (y < 100) y += 2000;
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return isIsoDate(iso) && new Date(`${iso}T00:00:00Z`).getUTCDate() === d ? iso : null;
}

export function parseCellAmount(raw: string): number | null {
  let t = raw.replace(/[\s,₹]/g, '').replace(/ /g, '');
  if (!t) return null;
  let neg = false;
  if (/^\(.*\)$/.test(t)) {
    neg = true;
    t = t.slice(1, -1);
  }
  if (!/^-?\d*\.?\d+(e[+-]?\d+)?$/i.test(t)) return null;
  if (/e/i.test(t)) return Math.round(parseFloat(t) * 100) * (neg ? -1 : 1);
  const p = decimalToPaise(t);
  return neg ? -p : p;
}

function drcr(raw: string | undefined): 'Dr' | 'Cr' | null {
  const t = (raw ?? '').trim().toLowerCase();
  if (t.startsWith('d')) return 'Dr';
  if (t.startsWith('c')) return 'Cr';
  return null;
}

export interface ImportItem {
  row: number;
  name: string;
  action: 'Create' | 'Update' | 'Ignore' | 'Error';
  detail: string;
}

export interface ExcelError {
  row: number;
  name: string;
  message: string;
}

export interface ExcelImportReport {
  dryRun: boolean;
  kind: string;
  rowsRead: number;
  created: number;
  updated: number;
  ignored: number;
  errors: ExcelError[];
  warnings: string[];
  stats: { label: string; count: number }[];
  amount: number;
  items: ImportItem[];
  columns: ColumnMap[];
}

function newReport(kind: string, dryRun: boolean, columns: ColumnMap[]): ExcelImportReport {
  return { dryRun, kind, rowsRead: 0, created: 0, updated: 0, ignored: 0, errors: [], warnings: [], stats: [], amount: 0, items: [], columns };
}

function missingColumns(map: ColumnMap[]): string[] {
  return map.filter((m) => m.required && !m.column).map((m) => m.label);
}

export interface MasterImportOptions {
  dryRun?: boolean;
  behaviour?: ImportBehaviour;
}

const cell = (row: string[], idx: Record<string, number>, key: string): string => (key in idx ? clean(row[idx[key]] ?? '', 500) : '');

interface GroupRef {
  id: number;
  nature: Group['nature'];
}

export async function importMastersFromRows(books: Books, rows: string[][], kind: MasterKind, opts: MasterImportOptions = {}): Promise<ExcelImportReport> {
  const dry = !!opts.dryRun;
  const behaviour = opts.behaviour ?? 'Ignore Duplicates';
  const h = headerRowIndex(rows);
  const { idx, map } = mapColumns(rows[h] ?? [], FIELDS[kind]);
  const rep = newReport(MASTER_TYPES.find((t) => t.kind === kind)!.label, dry, map);
  const miss = missingColumns(map);
  if (miss.length) {
    rep.errors.push({ row: h + 1, name: '', message: `Mandatory column not found: ${miss.join(', ')}` });
    return rep;
  }
  const body = rows.slice(h + 1);
  const err = (row: number, name: string, message: string) => {
    rep.errors.push({ row, name, message });
    rep.items.push({ row, name, action: 'Error', detail: message });
  };
  const act = (row: number, name: string, action: ImportItem['action'], detail = '') => {
    if (action === 'Create') rep.created += 1;
    else if (action === 'Update') rep.updated += 1;
    else if (action === 'Ignore') rep.ignored += 1;
    rep.items.push({ row, name, action, detail });
  };
  const run = async (row: number, name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      err(row, name, (e as Error).message);
    }
  };
  let nextFake = -1;
  const seen = new Set<string>();

  if (kind === 'group' || kind === 'ledger') {
    const groups = new Map<string, GroupRef & { name: string }>();
    const load = async () => {
      groups.clear();
      for (const g of await books.groups()) groups.set(g.name.toLowerCase(), { id: g.id, nature: g.nature, name: g.name });
    };
    await load();
    const natureOf = (s: string): Group['nature'] | null => {
      const t = s.toLowerCase();
      return t.startsWith('asset') ? 'Assets' : t.startsWith('liab') ? 'Liabilities' : t.startsWith('inc') ? 'Income' : t.startsWith('exp') ? 'Expense' : null;
    };
    if (kind === 'group') {
      let queue = body.map((r, i) => ({ r, row: h + 2 + i })).filter(({ r }) => cell(r, idx, 'name'));
      rep.rowsRead = queue.length;
      let progress = true;
      while (queue.length && progress) {
        progress = false;
        const next: typeof queue = [];
        for (const q of queue) {
          const name = cell(q.r, idx, 'name');
          const parentName = cell(q.r, idx, 'parent');
          const parent = parentName && !/^primary$/i.test(parentName) ? groups.get(parentName.toLowerCase()) : undefined;
          if (parentName && !/^primary$/i.test(parentName) && !parent) {
            next.push(q);
            continue;
          }
          progress = true;
          const existing = groups.get(name.toLowerCase());
          if (existing) {
            if (behaviour === 'Modify with New Data' && cell(q.r, idx, 'alias')) {
              await run(q.row, name, async () => {
                if (!dry) await books.updateGroup(existing.id, { alias: cell(q.r, idx, 'alias') });
                act(q.row, name, 'Update', 'alias');
              });
            } else act(q.row, name, 'Ignore', 'Already exists');
            continue;
          }
          const nature = parent ? parent.nature : natureOf(cell(q.r, idx, 'nature'));
          if (!nature) {
            err(q.row, name, 'Nature of group is required for a primary group');
            continue;
          }
          await run(q.row, name, async () => {
            if (dry) groups.set(name.toLowerCase(), { id: nextFake--, nature, name });
            else {
              const g = await books.createGroup({ name, parent_id: parent?.id ?? null, nature, alias: cell(q.r, idx, 'alias') });
              groups.set(name.toLowerCase(), { id: g.id, nature: g.nature, name });
            }
            act(q.row, name, 'Create', parent ? `Under ${parent.name}` : 'Primary');
          });
        }
        queue = next;
      }
      for (const q of queue) err(q.row, cell(q.r, idx, 'name'), `Referenced master is missing: parent group "${cell(q.r, idx, 'parent')}"`);
      rep.stats.push({ label: 'Groups', count: rep.created + rep.updated });
      return rep;
    }

    const existingLedgers = new Map((await books.ledgers()).map((l) => [l.name.toLowerCase(), l]));
    interface Pending {
      row: number;
      name: string;
      r: string[];
      bills: { date: string; name: string; amount: number; side: 'Dr' | 'Cr' | null }[];
      addr: string[];
    }
    const ledgers: Pending[] = [];
    let cur: Pending | null = null;
    body.forEach((r, i) => {
      if (!r.some((c) => clean(c))) return;
      const name = cell(r, idx, 'name');
      if (name) {
        cur = { row: h + 2 + i, name, r, bills: [], addr: [] };
        ledgers.push(cur);
      }
      if (!cur) return;
      const bn = cell(r, idx, 'billName');
      const ba = cell(r, idx, 'billAmount');
      if (bn || ba) {
        const amt = parseCellAmount(ba) ?? 0;
        cur.bills.push({ date: parseCellDate(cell(r, idx, 'billDate')) ?? '', name: bn, amount: Math.abs(amt), side: drcr(cell(r, idx, 'billDrCr')) });
      }
      const a = cell(r, idx, 'address');
      if (a) cur.addr.push(a);
    });
    rep.rowsRead = ledgers.length;
    for (const p of ledgers) {
      const key = p.name.toLowerCase();
      if (seen.has(key)) {
        err(p.row, p.name, 'Duplicate name in the file');
        continue;
      }
      seen.add(key);
      const gname = cell(p.r, idx, 'group');
      const g = groups.get(gname.toLowerCase());
      const existing = existingLedgers.get(key);
      if (!g) {
        err(p.row, p.name, `Referenced master is missing: parent group "${gname}"`);
        continue;
      }
      const openRaw = cell(p.r, idx, 'opening');
      let opening = 0;
      if (openRaw) {
        const amt = parseCellAmount(openRaw);
        if (amt === null) {
          err(p.row, p.name, `Invalid opening balance "${openRaw}"`);
          continue;
        }
        const side = drcr(cell(p.r, idx, 'openingDrCr')) ?? (amt < 0 ? 'Cr' : g.nature === 'Assets' || g.nature === 'Expense' ? 'Dr' : 'Cr');
        opening = (side === 'Dr' ? 1 : -1) * Math.abs(amt);
      }
      const bills: BillInput[] = p.bills.map((b) => {
        const side = b.side ?? (opening < 0 ? 'Cr' : 'Dr');
        return { kind: 'opening', name: b.name, amount: (side === 'Dr' ? 1 : -1) * b.amount, bill_date: b.date };
      });
      if (bills.length && bills.reduce((s, b) => s + b.amount, 0) !== opening) {
        err(p.row, p.name, 'Bill-wise amounts do not add up to the opening balance');
        continue;
      }
      const fields: Record<string, string | number> = {};
      for (const k of ['alias', 'mailing_name', 'state', 'country', 'pincode', 'phone', 'email', 'contact', 'pan', 'gstin']) {
        const v = cell(p.r, idx, k);
        if (v) fields[k] = v;
      }
      if (p.addr.length) fields.address = [...new Set(p.addr)].join('\n');
      const cd = parseInt(cell(p.r, idx, 'credit_days'), 10);
      if (cd > 0) fields.credit_days = cd;
      if (bills.length) fields.bill_by_bill = 1;
      if (existing) {
        if (behaviour === 'Ignore Duplicates') {
          act(p.row, p.name, 'Ignore', 'Already exists');
          continue;
        }
        const newOpening = behaviour === 'Combine Opening Balance' ? existing.opening + opening : openRaw ? opening : existing.opening;
        await run(p.row, p.name, async () => {
          if (!dry) {
            const full = await books.ledger(existing.id);
            await books.updateLedger(existing.id, {
              ...fields,
              group_id: g.id,
              opening: newOpening,
              opening_bills: behaviour === 'Combine Opening Balance' ? [...(full?.opening_bills ?? []), ...bills] : bills.length ? bills : full?.opening_bills ?? [],
            });
          }
          rep.amount += Math.abs(opening);
          act(p.row, p.name, 'Update', behaviour);
        });
        continue;
      }
      await run(p.row, p.name, async () => {
        if (!dry) await books.createLedger({ name: p.name, group_id: g.id, opening, opening_bills: bills, ...fields });
        rep.amount += Math.abs(opening);
        act(p.row, p.name, 'Create', `${gname}${opening ? ` ${Math.abs(opening) / 100} ${opening > 0 ? 'Dr' : 'Cr'}` : ''}`);
      });
    }
    rep.stats.push({ label: 'Ledgers', count: rep.created + rep.updated });
    rep.stats.push({ label: 'Bills', count: ledgers.reduce((s, l) => s + l.bills.length, 0) });
    return rep;
  }

  const entries = body.map((r, i) => ({ r, row: h + 2 + i })).filter(({ r }) => cell(r, idx, kind === 'unit' ? 'symbol' : 'name'));
  rep.rowsRead = entries.length;

  if (kind === 'unit') {
    const have = new Set((await units(books.db)).map((u) => u.symbol.toLowerCase()));
    for (const { r, row } of entries) {
      const symbol = cell(r, idx, 'symbol');
      if (have.has(symbol.toLowerCase())) {
        act(row, symbol, 'Ignore', 'Already exists');
        continue;
      }
      if (/compound/i.test(cell(r, idx, 'type'))) {
        err(row, symbol, 'Compound units are not supported');
        continue;
      }
      await run(row, symbol, async () => {
        if (!dry) await createUnit(books.db, { symbol, formal_name: cell(r, idx, 'formal'), decimals: parseInt(cell(r, idx, 'decimals'), 10) || 0 });
        have.add(symbol.toLowerCase());
        act(row, symbol, 'Create');
      });
    }
    rep.stats.push({ label: 'Units', count: rep.created });
    return rep;
  }

  if (kind === 'godown') {
    const have = new Map((await godowns(books.db)).map((g) => [g.name.toLowerCase(), g.id]));
    let addressSeen = false;
    for (const { r, row } of entries) {
      const name = cell(r, idx, 'name');
      if (have.has(name.toLowerCase())) {
        act(row, name, 'Ignore', 'Already exists');
        continue;
      }
      const pn = cell(r, idx, 'parent');
      const parent = pn && !/^primary$/i.test(pn) ? have.get(pn.toLowerCase()) : null;
      if (pn && !/^primary$/i.test(pn) && !parent) {
        err(row, name, `Referenced master is missing: parent godown "${pn}"`);
        continue;
      }
      if (cell(r, idx, 'address')) addressSeen = true;
      await run(row, name, async () => {
        let id = nextFake--;
        if (!dry) id = (await createGodown(books.db, { name, parent_id: parent ?? null })).id;
        have.set(name.toLowerCase(), id);
        act(row, name, 'Create');
      });
    }
    if (addressSeen) rep.warnings.push('Godown addresses are not stored and were skipped');
    rep.stats.push({ label: 'Godowns', count: rep.created });
    return rep;
  }

  if (kind === 'stock_group' || kind === 'stock_category') {
    const isGroup = kind === 'stock_group';
    const have = new Map((isGroup ? await stockGroups(books.db) : await stockCategories(books.db)).map((g) => [g.name.toLowerCase(), g.id]));
    for (const { r, row } of entries) {
      const name = cell(r, idx, 'name');
      if (have.has(name.toLowerCase())) {
        act(row, name, 'Ignore', 'Already exists');
        continue;
      }
      const pn = cell(r, idx, 'parent');
      const parent = pn && !/^primary$/i.test(pn) ? have.get(pn.toLowerCase()) : null;
      if (pn && !/^primary$/i.test(pn) && !parent) {
        err(row, name, `Referenced master is missing: parent "${pn}"`);
        continue;
      }
      await run(row, name, async () => {
        let id = nextFake--;
        if (!dry) id = isGroup ? (await createStockGroup(books.db, { name, parent_id: parent ?? null, alias: cell(r, idx, 'alias') })).id : (await createStockCategory(books.db, { name, parent_id: parent ?? null })).id;
        have.set(name.toLowerCase(), id);
        act(row, name, 'Create');
      });
    }
    rep.stats.push({ label: isGroup ? 'Stock Groups' : 'Stock Categories', count: rep.created });
    return rep;
  }

  if (kind === 'cost_centre') {
    await ensureCosting(books.db);
    const cats = new Map((await costCategories(books.db)).map((c) => [c.name.toLowerCase(), c.id]));
    const centres = new Map<string, { id: number }>((await costCentres(books.db)).map((c) => [c.name.toLowerCase(), c]));
    for (const { r, row } of entries) {
      const name = cell(r, idx, 'name');
      const cn = cell(r, idx, 'category');
      const category = cn ? cats.get(cn.toLowerCase()) : 1;
      if (!category) {
        err(row, name, `Referenced master is missing: cost category "${cn}"`);
        continue;
      }
      const pn = cell(r, idx, 'parent');
      const parent = pn && !/^primary$/i.test(pn) ? centres.get(pn.toLowerCase()) : undefined;
      if (pn && !/^primary$/i.test(pn) && !parent) {
        err(row, name, `Referenced master is missing: parent cost centre "${pn}"`);
        continue;
      }
      const existing = centres.get(name.toLowerCase());
      if (existing) {
        if (behaviour === 'Modify with New Data') {
          await run(row, name, async () => {
            if (!dry) await updateCostCentre(books.db, existing.id, { name, category_id: category, parent_id: parent?.id ?? null });
            act(row, name, 'Update');
          });
        } else act(row, name, 'Ignore', 'Already exists');
        continue;
      }
      await run(row, name, async () => {
        if (dry) centres.set(name.toLowerCase(), { id: nextFake-- });
        else {
          const c = await createCostCentre(books.db, { name, category_id: category, parent_id: parent?.id ?? null });
          centres.set(name.toLowerCase(), c);
        }
        act(row, name, 'Create');
      });
    }
    rep.stats.push({ label: 'Cost Centres', count: rep.created });
    return rep;
  }

  const unitMap = new Map<string, number>();
  for (const u of await units(books.db)) {
    unitMap.set(u.symbol.toLowerCase(), u.id);
    if (u.formal_name) unitMap.set(u.formal_name.toLowerCase(), u.id);
  }
  const groupMap = new Map((await stockGroups(books.db)).map((g) => [g.name.toLowerCase(), g.id]));
  const catMap = new Map((await stockCategories(books.db)).map((g) => [g.name.toLowerCase(), g.id]));
  const items = new Map((await stockItems(books.db)).map((i) => [i.name.toLowerCase(), i]));
  for (const { r, row } of entries) {
    const name = cell(r, idx, 'name');
    if (seen.has(name.toLowerCase())) {
      err(row, name, 'Duplicate name in the file');
      continue;
    }
    seen.add(name.toLowerCase());
    const un = cell(r, idx, 'unit');
    const unitId = un ? unitMap.get(un.toLowerCase()) : 1;
    if (!unitId) {
      err(row, name, `Referenced master is missing: unit "${un}"`);
      continue;
    }
    const gn = cell(r, idx, 'group');
    const groupId = gn && !/^primary$/i.test(gn) ? groupMap.get(gn.toLowerCase()) : null;
    if (gn && !/^primary$/i.test(gn) && !groupId) {
      err(row, name, `Referenced master is missing: stock group "${gn}"`);
      continue;
    }
    const cn = cell(r, idx, 'category');
    const catId = cn && !/^not applicable$/i.test(cn) ? catMap.get(cn.toLowerCase()) : null;
    if (cn && !/^not applicable$/i.test(cn) && !catId) {
      err(row, name, `Referenced master is missing: stock category "${cn}"`);
      continue;
    }
    const qtyRaw = cell(r, idx, 'qty');
    const qtyMatch = /^-?[\d,]*\.?\d+/.exec(qtyRaw);
    const qty = qtyMatch ? parseQty(qtyMatch[0]) : qtyRaw ? null : 0;
    if (qty === null) {
      err(row, name, `Invalid opening quantity "${qtyRaw}"`);
      continue;
    }
    const rate = parseCellAmount(cell(r, idx, 'rate')) ?? 0;
    const valueRaw = parseCellAmount(cell(r, idx, 'value'));
    const value = valueRaw ?? lineAmount(qty, rate);
    const gst = parseFloat(cell(r, idx, 'gst').replace('%', ''));
    const input = {
      name,
      alias: cell(r, idx, 'alias'),
      group_id: groupId ?? null,
      category_id: catId ?? null,
      unit_id: unitId,
      hsn_sac: cell(r, idx, 'hsn'),
      part_no: cell(r, idx, 'part_no'),
      rate_bp: gst > 0 ? Math.round(gst * 100) : 0,
      opening_qty: qty,
      opening_rate: rate,
      opening_value: value,
    };
    const existing = items.get(name.toLowerCase());
    if (existing) {
      if (behaviour === 'Ignore Duplicates') {
        act(row, name, 'Ignore', 'Already exists');
        continue;
      }
      await run(row, name, async () => {
        const patch = Object.fromEntries(Object.entries(input).filter(([k, v]) => k === 'name' || (v !== null && v !== ''))) as typeof input;
        const merged =
          behaviour === 'Combine Opening Balance'
            ? { ...patch, opening_qty: existing.opening_qty + qty, opening_value: existing.opening_value + value, opening_rate: 0 }
            : patch;
        if (!dry) await updateStockItem(books.db, existing.id, merged);
        rep.amount += value;
        act(row, name, 'Update', behaviour);
      });
      continue;
    }
    await run(row, name, async () => {
      if (!dry) await createStockItem(books.db, input);
      rep.amount += value;
      act(row, name, 'Create', un);
    });
  }
  rep.stats.push({ label: 'Stock Items', count: rep.created + rep.updated });
  return rep;
}

export interface VoucherImportOptions {
  dryRun?: boolean;
}

interface ParsedEntry {
  row: number;
  ledger: string;
  amount: number;
  billName: string;
  billType: BillInput['kind'];
  costCentre: string;
  costAmount: number | null;
  sign: number;
  item?: { name: string; qty: string; rate: string; value: string; godown: string; uom: string };
}

interface ParsedVoucher {
  row: number;
  date: string;
  type: string;
  number: string;
  narration: string;
  reference: string;
  party: string;
  entries: ParsedEntry[];
  bad: string | null;
}

const OUTWARD = new Set(['Sales', 'Debit Note', 'Delivery Note', 'Rejection Out']);

const BILL_KINDS: Record<string, BillInput['kind']> = { newref: 'new', new: 'new', agstref: 'agst', against: 'agst', agst: 'agst', advance: 'adv', onaccount: 'onacc' };

export async function importVouchersFromRows(books: Books, rows: string[][], opts: VoucherImportOptions = {}): Promise<ExcelImportReport> {
  const dry = !!opts.dryRun;
  const h = headerRowIndex(rows);
  const { idx, map } = mapColumns(rows[h] ?? [], VOUCHER_FIELDS);
  const rep = newReport('Vouchers', dry, map);
  const miss = missingColumns(map);
  if (miss.length) {
    rep.errors.push({ row: h + 1, name: '', message: `Mandatory column not found: ${miss.join(', ')}` });
    return rep;
  }
  const vouchers: ParsedVoucher[] = [];
  let cur: ParsedVoucher | null = null;
  rows.slice(h + 1).forEach((r, i) => {
    const row = h + 2 + i;
    if (!r.some((c) => clean(c))) return;
    const dateRaw = cell(r, idx, 'date');
    if (dateRaw) {
      const date = parseCellDate(dateRaw);
      cur = {
        row,
        date: date ?? '',
        type: cell(r, idx, 'type'),
        number: cell(r, idx, 'number'),
        narration: cell(r, idx, 'narration'),
        reference: cell(r, idx, 'reference'),
        party: cell(r, idx, 'party'),
        entries: [],
        bad: date ? null : `Invalid voucher date "${dateRaw}"`,
      };
      vouchers.push(cur);
    }
    if (!cur) return;
    if (!cur.narration) cur.narration = cell(r, idx, 'narration');
    const ledger = cell(r, idx, 'ledger') || (cell(r, idx, 'item') && cur.entries.length ? cur.entries[cur.entries.length - 1].ledger : '');
    const item = cell(r, idx, 'item');
    const amtRaw = cell(r, idx, 'amount');
    const side = drcr(cell(r, idx, 'drcr'));
    if (!ledger && !item) return;
    let amount = amtRaw ? parseCellAmount(amtRaw) : null;
    if (amtRaw && amount === null) {
      cur.bad = cur.bad ?? `Invalid amount "${amtRaw}" in row ${row}`;
      return;
    }
    if (amount !== null && side) amount = (side === 'Cr' ? -1 : 1) * Math.abs(amount);
    const sameLedger = !cell(r, idx, 'ledger') && cur.entries.length ? cur.entries[cur.entries.length - 1] : null;
    const entry: ParsedEntry =
      sameLedger && amount === null
        ? sameLedger
        : {
            row,
            ledger,
            amount: amount ?? 0,
            billName: cell(r, idx, 'billName'),
            billType: BILL_KINDS[norm(cell(r, idx, 'billType'))] ?? 'new',
            costCentre: cell(r, idx, 'costCentre'),
            costAmount: parseCellAmount(cell(r, idx, 'costAmount')),
            sign: Math.sign(amount ?? 0),
          };
    if (entry !== sameLedger) cur.entries.push(entry);
    if (item) {
      const itemInfo = { name: item, qty: cell(r, idx, 'qty'), rate: cell(r, idx, 'rate'), value: cell(r, idx, 'value'), godown: cell(r, idx, 'godown'), uom: cell(r, idx, 'uom') };
      if (entry.item) cur.entries.push({ ...entry, amount: 0, billName: '', costCentre: '', costAmount: null, item: itemInfo });
      else entry.item = itemInfo;
    }
  });
  rep.rowsRead = vouchers.length;

  const types = new Map((await books.voucherTypes()).map((t) => [t.name.toLowerCase(), t]));
  const ledgers = new Map((await books.ledgers()).map((l) => [l.name.toLowerCase(), l]));
  const itemMap = new Map((await stockItems(books.db)).map((i) => [i.name.toLowerCase(), i]));
  const godownMap = new Map((await godowns(books.db)).map((g) => [g.name.toLowerCase(), g.id]));
  const usesCost = vouchers.some((v) => v.entries.some((e) => e.costCentre));
  if (usesCost) await ensureCosting(books.db);
  const centreMap = new Map((await costCentres(books.db).catch(() => [])).map((c) => [c.name.toLowerCase(), c.id]));
  const company = await books.requireCompany();
  const seen = new Set<string>();
  let stockLines = 0;

  for (const v of vouchers) {
    const label = `${v.type} ${v.number}`.trim();
    const fail = (m: string) => {
      rep.errors.push({ row: v.row, name: label, message: m });
      rep.items.push({ row: v.row, name: label, action: 'Error', detail: m });
    };
    if (v.bad) {
      fail(v.bad);
      continue;
    }
    const type = types.get(v.type.toLowerCase());
    if (!type) {
      fail(`Referenced master is missing: voucher type "${v.type}"`);
      continue;
    }
    if (v.date < company.books_from || v.date > company.fy_end) {
      fail('Voucher date is outside the books period');
      continue;
    }
    if (v.number) {
      const key = `${type.id}|${v.number}`;
      const dup = seen.has(key) || (await books.db.select('SELECT 1 FROM vouchers WHERE type_id = ? AND (number = ? OR (reference = ? AND date = ?))', [type.id, v.number, v.number, v.date])).length > 0;
      if (dup) {
        rep.ignored += 1;
        rep.items.push({ row: v.row, name: label, action: 'Ignore', detail: 'Voucher number already exists' });
        continue;
      }
      seen.add(key);
    }
    const stockOnly = (STOCK_VOUCHER_TYPES as readonly string[]).includes(type.parent);
    const inward = (e: ParsedEntry) => (e.sign ? e.sign > 0 : !OUTWARD.has(type.parent));
    let problem: string | null = null;
    const entries: { ledger_id: number; amount: number; bills: BillInput[]; cost: { name: string; amount: number | null } | null }[] = [];
    const stock: StockLineInput[] = [];
    for (const e of v.entries) {
      if (e.ledger && !ledgers.has(e.ledger.toLowerCase())) {
        problem = `Referenced master is missing: ledger "${e.ledger}"`;
        break;
      }
      const ledger = e.ledger ? ledgers.get(e.ledger.toLowerCase())! : null;
      if (e.item) {
        const it = itemMap.get(e.item.name.toLowerCase());
        if (!it) {
          problem = `Referenced master is missing: stock item "${e.item.name}"`;
          break;
        }
        const qtyMatch = /^-?[\d,]*\.?\d+/.exec(e.item.qty);
        const qty = qtyMatch ? parseQty(qtyMatch[0].replace('-', '')) : null;
        if (!qty) {
          problem = `Invalid quantity "${e.item.qty}" for ${it.name}`;
          break;
        }
        const rate = parseCellAmount(e.item.rate) ?? 0;
        const value = parseCellAmount(e.item.value) ?? lineAmount(qty, rate);
        let godownId = 1;
        if (e.item.godown) {
          const gid = godownMap.get(e.item.godown.toLowerCase());
          if (!gid) {
            problem = `Referenced master is missing: godown "${e.item.godown}"`;
            break;
          }
          godownId = gid;
        }
        stock.push({ item_id: it.id, godown_id: godownId, ledger_id: ledger?.id ?? null, qty: inward(e) ? qty : -qty, rate: rate || Math.round((value * 1000) / qty), amount: value });
      }
      if (e.amount && ledger) {
        const prev = entries.find((x) => x.ledger_id === ledger.id && !e.billName && !x.bills.length && !e.costCentre);
        if (prev) prev.amount += e.amount;
        else {
          const bills: BillInput[] = e.billName ? [{ kind: e.billType, name: e.billName, amount: e.amount }] : [];
          entries.push({ ledger_id: ledger.id, amount: e.amount, bills, cost: e.costCentre ? { name: e.costCentre, amount: e.costAmount } : null });
        }
      }
    }
    if (problem) {
      fail(problem);
      continue;
    }
    if (stockOnly) {
      if (entries.length) {
        fail(`${type.parent} vouchers do not post ledger entries`);
        continue;
      }
    } else {
      const sum = entries.reduce((s, e) => s + e.amount, 0);
      if (entries.length < 2) {
        fail('A voucher needs at least two ledger entries');
        continue;
      }
      if (sum !== 0) {
        fail(`Total debit and credit differ by ${Math.abs(sum) / 100}`);
        continue;
      }
    }
    const costBad = entries.find((e) => e.cost && !centreMap.has(e.cost.name.toLowerCase()));
    if (costBad) {
      fail(`Referenced master is missing: cost centre "${costBad.cost!.name}"`);
      continue;
    }
    const partyId = v.party ? ledgers.get(v.party.toLowerCase())?.id ?? null : null;
    const total = entries.filter((e) => e.amount > 0).reduce((s, e) => s + e.amount, 0);
    if (dry) {
      rep.created += 1;
      rep.amount += total;
      stockLines += stock.length;
      rep.items.push({ row: v.row, name: label, action: 'Create', detail: `${v.date}` });
      continue;
    }
    try {
      const made = await books.createVoucher({
        type_id: type.id,
        number: v.number || undefined,
        date: v.date,
        reference: v.reference || (type.numbering === 'manual' || type.numbering === 'none' ? '' : v.number),
        narration: v.narration,
        party_id: partyId,
        entries: entries.map((e) => ({ ledger_id: e.ledger_id, amount: e.amount, bills: e.bills })),
        stock,
      });
      for (let i = 0; i < entries.length; i++) {
        const c = entries[i].cost;
        if (c) await saveEntryAllocations(books.db, made.entries[i].id, [{ cost_centre_id: centreMap.get(c.name.toLowerCase())!, amount: c.amount ?? entries[i].amount }]);
      }
      rep.created += 1;
      rep.amount += total;
      stockLines += stock.length;
      rep.items.push({ row: v.row, name: `${made.type} ${made.number}`, action: 'Create', detail: v.date });
    } catch (e) {
      fail((e as Error).message);
    }
  }
  rep.stats.push({ label: 'Vouchers', count: rep.created });
  if (stockLines) rep.stats.push({ label: 'Stock lines', count: stockLines });
  return rep;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zipStored(files: [string, string][]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of files) {
    const data = enc.encode(text);
    const nameBytes = enc.encode(name);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    parts.push(local, data);
    central.push(cd);
    offset += local.length + data.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((s, c) => s + c.length, 0));
  let p = 0;
  for (const c of all) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

function colLetters(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

export function buildXlsx(sheets: Sheet[]): Uint8Array {
  const sheetXml = sheets.map((sh) => {
    const rows = sh.rows
      .map((r, ri) => {
        const cells = r
          .map((v, ci) => {
            if (v === '' || v === undefined) return '';
            const ref = `${colLetters(ci)}${ri + 1}`;
            return ri > 0 && /^-?\d+(\.\d+)?$/.test(v) && !/^0\d/.test(v) ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
          })
          .join('');
        return `<row r="${ri + 1}">${cells}</row>`;
      })
      .join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
  });
  const files: [string, string][] = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${xmlEsc(s.name).slice(0, 31)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`],
  ];
  sheetXml.forEach((x, i) => files.push([`xl/worksheets/sheet${i + 1}.xml`, x]));
  return zipStored(files);
}

export const SAMPLE_FILES: { label: string; file: string; target: 'masters' | 'transactions'; sheets: { name: string; kind: MasterKind | 'voucher' }[] }[] = [
  { label: 'All Accounting Masters', file: 'AllAccountingMasters.xlsx', target: 'masters', sheets: [{ name: 'Group', kind: 'group' }, { name: 'Ledger', kind: 'ledger' }, { name: 'Cost Centre', kind: 'cost_centre' }] },
  { label: 'All Inventory Masters', file: 'AllInventoryMasters.xlsx', target: 'masters', sheets: [{ name: 'Unit', kind: 'unit' }, { name: 'Godown or Location', kind: 'godown' }, { name: 'Stock Group', kind: 'stock_group' }, { name: 'Stock Category', kind: 'stock_category' }, { name: 'Stock Item', kind: 'stock_item' }] },
  { label: 'Accounting Voucher', file: 'AccountingVoucher.xlsx', target: 'transactions', sheets: [{ name: 'Accounting Voucher', kind: 'voucher' }] },
];

const SAMPLE_ROWS: Record<MasterKind | 'voucher', string[][]> = {
  group: [['Retail Customers', 'Sundry Debtors']],
  ledger: [['National Traders', 'Sundry Debtors', '15200', 'Dr']],
  stock_group: [['Stationery', '']],
  stock_category: [['Retail', '']],
  stock_item: [['Pen', 'Nos', '55', '315', '17325']],
  unit: [['Nos', 'Simple', 'Numbers']],
  godown: [['Delhi Godown', 'Pritampura, Delhi']],
  cost_centre: [['Rahul']],
  voucher: [['2026-04-10', 'Receipt', '15', 'National Traders', '15200', 'Cr'], ['', '', '', 'HDFC Bank', '15200', 'Dr']],
};

const SAMPLE_COLUMNS: Record<MasterKind | 'voucher', string[]> = {
  group: ['Name', 'Under'],
  ledger: ['Name', 'Group Name', 'Ledger - Opening Balance', 'Ledger Opening Balance - Dr/Cr', 'Bill - Date', 'Bill - Name', 'Bill - Amount', 'Bill Amount - Dr/Cr', 'Address', 'State', 'Country', 'Pincode'],
  stock_group: ['Name', 'Under'],
  stock_category: ['Name', 'Under'],
  stock_item: ['Name', 'Units', 'Opening Quantity', 'Rate', 'Value'],
  unit: ['Symbol', 'Type of Unit', 'Formal name', 'First unit', 'Conversion', 'Second unit'],
  godown: ['Name', 'Address'],
  cost_centre: ['Name'],
  voucher: ['Voucher Date', 'Voucher Type Name', 'Voucher Number', 'Ledger Name', 'Ledger Amount', 'Ledger Amount Dr/Cr'],
};

export function sampleWorkbook(file: (typeof SAMPLE_FILES)[number]): Uint8Array {
  return buildXlsx(file.sheets.map((s) => ({ name: s.name, rows: [SAMPLE_COLUMNS[s.kind], ...SAMPLE_ROWS[s.kind]] })));
}
