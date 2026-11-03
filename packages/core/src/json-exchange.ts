import { CoreError } from './db.ts';
import type { Books } from './books.ts';
import { escapeXml, parseXml, type XNode } from './xml.ts';
import { exportMastersXml, exportVouchersXml, paiseToDecimal } from './tally-xml.ts';
import { exportMastersXml2, exportVouchersXml2 } from './tally-xml2.ts';
import { STOCK_VOUCHER_TYPES } from './schema.ts';
import { stockSummary } from './inventory.ts';
import { ledgerClosings } from './split.ts';
import { addDays } from './dbtools.ts';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
export type JsonObject = { [k: string]: JsonValue };

export interface TallyJsonFile {
  static_variables: { name: string; value: string }[];
  tallymessage: JsonObject[];
}

export const EXPORT_FILE_FORMATS = ['XML (Data Interchange)', 'JSON (Data Exchange)'] as const;
export type ExportFileFormat = (typeof EXPORT_FILE_FORMATS)[number];
export const MASTER_EXPORT_TYPES = ['All Masters', 'Accounting Masters', 'Inventory Masters'] as const;
export type MasterExportType = (typeof MASTER_EXPORT_TYPES)[number];
export const VOUCHER_EXPORT_TYPES = ['All Vouchers', 'Accounting Vouchers', 'Inventory Vouchers'] as const;
export type VoucherExportType = (typeof VOUCHER_EXPORT_TYPES)[number];

const TYPE_NAMES: Record<string, string> = {
  GROUP: 'Group',
  LEDGER: 'Ledger',
  VOUCHERTYPE: 'Voucher Type',
  UNIT: 'Unit',
  GODOWN: 'Godown',
  STOCKGROUP: 'Stock Group',
  STOCKCATEGORY: 'Stock Category',
  STOCKITEM: 'Stock Item',
  COSTCATEGORY: 'Cost Category',
  COSTCENTRE: 'Cost Centre',
  CURRENCY: 'Currency',
  VOUCHER: 'Voucher',
};
const TAG_OF = Object.fromEntries(Object.entries(TYPE_NAMES).map(([k, v]) => [v.toLowerCase().replace(/\s+/g, ''), k]));
const ACCOUNTING_TYPES = new Set(['Group', 'Ledger', 'Voucher Type', 'Cost Category', 'Cost Centre', 'Currency']);
const INVENTORY_TYPES = new Set(['Unit', 'Godown', 'Stock Group', 'Stock Category', 'Stock Item']);
const MASTER_ORDER = ['Group', 'Currency', 'Unit', 'Godown', 'Stock Group', 'Stock Category', 'Cost Category', 'Cost Centre', 'Voucher Type', 'Ledger', 'Stock Item'];

const isLeaf = (n: XNode) => n.children.length === 0;

function leafValue(text: string): JsonValue {
  const t = text.trim();
  if (t === 'Yes') return true;
  if (t === 'No') return false;
  return t;
}

function scalarList(n: XNode): JsonValue[] | null {
  const base = n.name.replace(/\.LIST$/, '');
  if (!n.children.length || !n.children.every((c) => isLeaf(c) && c.name === base)) return null;
  return [{ metadata: true, type: n.attrs.TYPE || 'String' }, ...n.children.map((c) => c.text.trim())];
}

function nodeToJson(n: XNode): JsonObject {
  const out: JsonObject = {};
  for (const c of n.children) {
    if (c.name.endsWith('.LIST')) {
      const key = c.name.slice(0, -5).toLowerCase();
      const sl = scalarList(c);
      if (sl) {
        out[key] = sl;
        continue;
      }
      const arr = (Array.isArray(out[key]) ? out[key] : (out[key] = [])) as JsonValue[];
      arr.push(nodeToJson(c));
      continue;
    }
    const key = c.name.toLowerCase();
    const v: JsonValue = isLeaf(c) ? leafValue(c.text) : nodeToJson(c);
    if (key in out) {
      const prev = out[key];
      out[key] = Array.isArray(prev) ? [...prev, v] : [prev, v];
    } else out[key] = v;
  }
  return out;
}

export function tallyXmlToMessages(xml: string): JsonObject[] {
  const root = parseXml(xml);
  const out: JsonObject[] = [];
  const visit = (n: XNode) => {
    if (n.name === 'TALLYMESSAGE') {
      for (const c of n.children) {
        const type = TYPE_NAMES[c.name];
        if (!type) continue;
        const metadata: JsonObject = { type };
        if (c.attrs.NAME) metadata.name = c.attrs.NAME;
        if (c.attrs.REMOTEID) metadata.remoteid = c.attrs.REMOTEID;
        if (c.attrs.VCHTYPE) metadata.vchtype = c.attrs.VCHTYPE;
        metadata.action = c.attrs.ACTION || 'Create';
        if (c.attrs.OBJVIEW) metadata.objview = c.attrs.OBJVIEW;
        const body = nodeToJson(c);
        if (type !== 'Voucher' && body.name === undefined && c.attrs.NAME) body.name = c.attrs.NAME;
        out.push({ metadata, ...body });
      }
      return;
    }
    n.children.forEach(visit);
  };
  visit(root);
  return out;
}

const typeOf = (m: JsonObject) => String((m.metadata as JsonObject | undefined)?.type ?? '');
const nameOf = (m: JsonObject) => String((m.metadata as JsonObject | undefined)?.name ?? (typeof m.name === 'string' ? m.name : ''));

function mergeMasters(list: JsonObject[]): JsonObject[] {
  const by = new Map<string, JsonObject>();
  for (const m of list) {
    const k = `${typeOf(m)}|${nameOf(m).toLowerCase()}`;
    const cur = by.get(k);
    by.set(k, cur ? { ...cur, ...m, metadata: cur.metadata } : m);
  }
  const rank = (m: JsonObject) => {
    const i = MASTER_ORDER.indexOf(typeOf(m));
    return i < 0 ? MASTER_ORDER.length : i;
  };
  return [...by.values()].map((m, i) => ({ m, i })).sort((a, b) => rank(a.m) - rank(b.m) || a.i - b.i).map((x) => x.m);
}

export interface MasterExportOptions {
  type?: MasterExportType;
  closingAsOpening?: { asOn: string } | null;
}

export async function masterMessages(books: Books, opts: MasterExportOptions = {}): Promise<JsonObject[]> {
  let list = mergeMasters([...tallyXmlToMessages(await exportMastersXml(books)), ...tallyXmlToMessages(await exportMastersXml2(books))]);
  const type = opts.type ?? 'All Masters';
  if (type === 'Accounting Masters') list = list.filter((m) => ACCOUNTING_TYPES.has(typeOf(m)));
  if (type === 'Inventory Masters') list = list.filter((m) => INVENTORY_TYPES.has(typeOf(m)));
  if (opts.closingAsOpening) list = await closingAsOpening(books, list, opts.closingAsOpening.asOn);
  return list;
}

async function closingAsOpening(books: Books, list: JsonObject[], asOn: string): Promise<JsonObject[]> {
  const c = await books.requireCompany();
  const carry = await ledgerClosings(books.db, addDays(asOn, 1));
  const names = new Map((await books.ledgers()).map((l) => [l.name.toLowerCase(), l.id]));
  const byId = new Map(carry.ledgers.map((l) => [l.id, l]));
  const stock = (await books.db.select('SELECT 1 FROM stock_items LIMIT 1')).length ? await stockSummary(books.db, c.books_from, asOn) : null;
  const items = new Map((stock?.rows ?? []).map((r) => [r.name.toLowerCase(), r]));
  return list.map((m) => {
    const t = typeOf(m);
    if (t === 'Ledger') {
      const id = names.get(nameOf(m).toLowerCase());
      const l = id !== undefined ? byId.get(id) : undefined;
      if (!l) return m;
      const opening = l.id === carry.plId ? l.closing + carry.nominal - (stock?.closing_value ?? 0) + (stock?.opening_value ?? 0) : l.nominal ? 0 : l.closing;
      const out: JsonObject = { ...m, openingbalance: paiseToDecimal(-opening) };
      delete out.billallocations;
      const bills = carry.bills.get(l.id);
      if (bills?.length && l.id !== carry.plId) {
        out.billallocations = bills.map((b) => {
          const o: JsonObject = { name: b.name, amount: paiseToDecimal(-b.amount) };
          if (b.bill_date) o.billdate = b.bill_date.replaceAll('-', '');
          if (b.due_date) o.billcreditperiod = b.due_date.replaceAll('-', '');
          return o;
        });
      }
      return out;
    }
    if (t === 'Stock Item') {
      const r = items.get(nameOf(m).toLowerCase());
      if (!r) return m;
      const unit = String(m.baseunits ?? r.unit);
      const qty = Math.abs(r.closing_qty) / 1000;
      const out: JsonObject = { ...m, openingbalance: `${Number.isInteger(qty) ? qty : qty.toFixed(3)} ${unit}`, openingvalue: paiseToDecimal(-r.closing_value) };
      out.openingrate = `${paiseToDecimal(r.closing_qty ? Math.round((r.closing_value * 1000) / r.closing_qty) : 0)}/${unit}`;
      return out;
    }
    return m;
  });
}

export interface VoucherExportOptions {
  type?: VoucherExportType;
  dependentMasters?: boolean;
}

const INVENTORY_PARENTS = new Set<string>(STOCK_VOUCHER_TYPES);

export async function voucherMessages(books: Books, from: string, to: string, opts: VoucherExportOptions = {}): Promise<JsonObject[]> {
  let vouchers = tallyXmlToMessages(await exportVouchersXml2(books, from, to));
  if (!vouchers.length) vouchers = tallyXmlToMessages(await exportVouchersXml(books, from, to));
  const parents = new Map((await books.voucherTypes()).map((t) => [t.name.toLowerCase(), t.parent]));
  const isInv = (m: JsonObject) => INVENTORY_PARENTS.has(parents.get(String(m.vouchertypename ?? '').toLowerCase()) ?? String((m.metadata as JsonObject)?.vchtype ?? ''));
  const type = opts.type ?? 'All Vouchers';
  if (type === 'Accounting Vouchers') vouchers = vouchers.filter((m) => !isInv(m));
  if (type === 'Inventory Vouchers') vouchers = vouchers.filter(isInv);
  if (!opts.dependentMasters) return vouchers;
  return [...dependentMasters(await masterMessages(books), vouchers), ...vouchers];
}

const REF_KEYS: Record<string, string> = {
  ledgername: 'Ledger',
  partyledgername: 'Ledger',
  stockitemname: 'Stock Item',
  godownname: 'Godown',
  vouchertypename: 'Voucher Type',
  name: '',
};

function collectRefs(v: JsonValue, out: Set<string>, ctx = '') {
  if (Array.isArray(v)) return v.forEach((x) => collectRefs(x, out, ctx));
  if (!v || typeof v !== 'object') return;
  for (const [k, x] of Object.entries(v)) {
    const t = REF_KEYS[k];
    if (typeof x === 'string' && t) out.add(`${t}|${x.toLowerCase()}`);
    if (k === 'costcentreallocations' && Array.isArray(x)) for (const c of x) if (c && typeof c === 'object' && !Array.isArray(c) && typeof c.name === 'string') out.add(`Cost Centre|${c.name.toLowerCase()}`);
    if (k === 'category' && typeof x === 'string') out.add(`Cost Category|${x.toLowerCase()}`);
    if (typeof x === 'object') collectRefs(x, out, k || ctx);
  }
}

export function dependentMasters(masters: JsonObject[], vouchers: JsonObject[]): JsonObject[] {
  const want = new Set<string>();
  for (const v of vouchers) collectRefs(v, want);
  const by = new Map(masters.map((m) => [`${typeOf(m)}|${nameOf(m).toLowerCase()}`, m]));
  const parentType: Record<string, string> = { Ledger: 'Group', Group: 'Group', 'Stock Item': 'Stock Group', 'Stock Group': 'Stock Group', Godown: 'Godown', 'Cost Centre': 'Cost Centre' };
  const queue = [...want];
  while (queue.length) {
    const k = queue.pop()!;
    const m = by.get(k);
    if (!m) continue;
    const t = typeOf(m);
    const extra: string[] = [];
    if (typeof m.parent === 'string' && parentType[t]) extra.push(`${parentType[t]}|${m.parent.toLowerCase()}`);
    if (t === 'Stock Item' && typeof m.baseunits === 'string') extra.push(`Unit|${m.baseunits.toLowerCase()}`);
    if (t === 'Stock Item' && typeof m.category === 'string') extra.push(`Stock Category|${m.category.toLowerCase()}`);
    if (t === 'Cost Centre' && typeof m.category === 'string') extra.push(`Cost Category|${m.category.toLowerCase()}`);
    for (const e of extra) if (!want.has(e)) (want.add(e), queue.push(e));
  }
  return masters.filter((m) => want.has(`${typeOf(m)}|${nameOf(m).toLowerCase()}`));
}

export function jsonExFile(company: string, kind: 'masters' | 'vouchers', messages: JsonObject[]): TallyJsonFile {
  return {
    static_variables: [
      { name: kind === 'masters' ? 'svMstImportFormat' : 'svVchImportFormat', value: 'jsonex' },
      { name: 'svCurrentCompany', value: company },
    ],
    tallymessage: messages,
  };
}

export async function exportMastersJson(books: Books, opts: MasterExportOptions = {}): Promise<string> {
  const c = await books.requireCompany();
  return JSON.stringify(jsonExFile(c.name, 'masters', await masterMessages(books, opts)), null, 2);
}

export async function exportVouchersJson(books: Books, from: string, to: string, opts: VoucherExportOptions = {}): Promise<string> {
  const c = await books.requireCompany();
  return JSON.stringify(jsonExFile(c.name, 'vouchers', await voucherMessages(books, from, to, opts)), null, 2);
}

export async function exportMastersXmlFor(books: Books, opts: MasterExportOptions = {}): Promise<string> {
  const c = await books.requireCompany();
  return messagesToTallyXml(await masterMessages(books, opts), { company: c.name, report: 'All Masters' });
}

export async function exportVouchersXmlFor(books: Books, from: string, to: string, opts: VoucherExportOptions = {}): Promise<string> {
  const c = await books.requireCompany();
  return messagesToTallyXml(await voucherMessages(books, from, to, opts), { company: c.name, report: 'Vouchers' });
}

function unwrap(v: JsonValue): JsonValue {
  if (v && typeof v === 'object' && !Array.isArray(v) && 'value' in v && 'type' in v && Object.keys(v).length <= 3 && typeof v.type === 'string') return v.value as JsonValue;
  return v;
}

const normKey = (k: string) => k.toLowerCase().replace(/[\s_.-]+/g, '');

function scalarText(v: JsonValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v).replace(/^\u0004\s*/, '');
}

function isDescriptor(v: JsonValue): v is JsonObject {
  return !!v && typeof v === 'object' && !Array.isArray(v) && v.metadata === true;
}

function writeFields(obj: JsonObject, parts: string[], depth: number) {
  const pad = '  '.repeat(depth);
  for (const [rawKey, rawVal] of Object.entries(obj)) {
    if (rawKey === 'metadata' || rawKey.includes(':')) continue;
    const key = normKey(rawKey).toUpperCase();
    if (!key) continue;
    const val = unwrap(rawVal);
    if (Array.isArray(val)) {
      if (!val.length) continue;
      const scalars = val.filter((x) => !isDescriptor(x));
      const desc = val.find(isDescriptor);
      if (desc || scalars.every((x) => x === null || typeof x !== 'object')) {
        const type = desc && typeof desc.type === 'string' ? desc.type : 'String';
        parts.push(`${pad}<${key}.LIST TYPE="${escapeXml(type)}">`);
        for (const s of scalars) parts.push(`${pad}  <${key}>${escapeXml(scalarText(unwrap(s)))}</${key}>`);
        parts.push(`${pad}</${key}.LIST>`);
        continue;
      }
      for (const item of scalars) {
        const u = unwrap(item);
        if (!u || typeof u !== 'object' || Array.isArray(u)) continue;
        parts.push(`${pad}<${key}.LIST>`);
        writeFields(u, parts, depth + 1);
        parts.push(`${pad}</${key}.LIST>`);
      }
      continue;
    }
    if (val && typeof val === 'object') {
      parts.push(`${pad}<${key}>`);
      writeFields(val, parts, depth + 1);
      parts.push(`${pad}</${key}>`);
      continue;
    }
    parts.push(`${pad}<${key}>${escapeXml(scalarText(val))}</${key}>`);
  }
}

function findMessages(v: JsonValue, depth = 0): JsonObject[] | null {
  if (depth > 6 || !v || typeof v !== 'object') return null;
  if (Array.isArray(v)) {
    if (v.length && v.every((x) => x && typeof x === 'object' && !Array.isArray(x) && 'metadata' in x)) return v as JsonObject[];
    return null;
  }
  for (const [k, x] of Object.entries(v)) {
    const n = normKey(k);
    if ((n === 'tallymessage' || n === 'collection') && x && typeof x === 'object') {
      if (Array.isArray(x)) return x.filter((m): m is JsonObject => !!m && typeof m === 'object' && !Array.isArray(m));
      return [x as JsonObject];
    }
  }
  for (const x of Object.values(v)) {
    const f = findMessages(x, depth + 1);
    if (f) return f;
  }
  return null;
}

function legacyMessages(v: JsonValue): JsonObject[] {
  const out: JsonObject[] = [];
  const walk = (x: JsonValue) => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (!x || typeof x !== 'object') return;
    for (const [k, y] of Object.entries(x)) {
      const tag = TAG_OF[normKey(k)];
      if (tag) {
        for (const o of Array.isArray(y) ? y : [y]) {
          if (!o || typeof o !== 'object' || Array.isArray(o)) continue;
          const name = typeof o.NAME === 'string' ? o.NAME : typeof o['@NAME'] === 'string' ? o['@NAME'] : undefined;
          out.push({ metadata: { type: TYPE_NAMES[tag], ...(name ? { name } : {}) }, ...o });
        }
      } else walk(y);
    }
  };
  walk(v);
  return out;
}

export function parseTallyJson(text: string): { company: string; messages: JsonObject[] } {
  let data: JsonValue;
  try {
    data = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new CoreError('invalid', 'This is not a valid JSON file');
  }
  let company = '';
  const sv = data && typeof data === 'object' && !Array.isArray(data) ? (data.static_variables ?? data.staticvariables) : null;
  if (Array.isArray(sv)) {
    for (const s of sv) if (s && typeof s === 'object' && !Array.isArray(s) && /^svcurrentcompany$/i.test(String(s.name))) company = String(s.value ?? '');
  }
  const messages = findMessages(data) ?? legacyMessages(data);
  if (!messages.length) throw new CoreError('invalid', 'The JSON file has no masters or vouchers in Tally format (tallymessage)');
  return { company, messages };
}

export function messagesToTallyXml(messages: JsonObject[], opts: { company?: string; report?: string } = {}): string {
  const parts: string[] = [];
  parts.push('<ENVELOPE>', '  <HEADER>', '    <TALLYREQUEST>Import Data</TALLYREQUEST>', '  </HEADER>', '  <BODY>', '    <IMPORTDATA>', '      <REQUESTDESC>');
  parts.push(`        <REPORTNAME>${escapeXml(opts.report ?? 'All Masters')}</REPORTNAME>`);
  if (opts.company) parts.push('        <STATICVARIABLES>', `          <SVCURRENTCOMPANY>${escapeXml(opts.company)}</SVCURRENTCOMPANY>`, '        </STATICVARIABLES>');
  parts.push('      </REQUESTDESC>', '      <REQUESTDATA>');
  for (const raw of messages) {
    const meta = (raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata) ? raw.metadata : {}) as JsonObject;
    const type = String(meta.type ?? '');
    const tag = TAG_OF[normKey(type)] ?? normKey(type).toUpperCase();
    if (!tag) continue;
    const attrs: string[] = [];
    const name = String(unwrap(meta.name ?? null) ?? '') || (typeof unwrap(raw.name) === 'string' ? String(unwrap(raw.name)) : '');
    if (name && tag !== 'VOUCHER') attrs.push(`NAME="${escapeXml(scalarText(name))}"`);
    if (meta.remoteid) attrs.push(`REMOTEID="${escapeXml(String(meta.remoteid))}"`);
    if (meta.vchtype) attrs.push(`VCHTYPE="${escapeXml(String(meta.vchtype))}"`);
    const action = String(meta.action ?? 'Create');
    attrs.push(`ACTION="${escapeXml(action.charAt(0).toUpperCase() + action.slice(1).toLowerCase())}"`);
    if (meta.objview) attrs.push(`OBJVIEW="${escapeXml(String(meta.objview))}"`);
    parts.push('        <TALLYMESSAGE xmlns:UDF="TallyUDF">');
    parts.push(`          <${tag} ${attrs.join(' ')}>`);
    const body: JsonObject = { ...raw };
    if (tag !== 'VOUCHER' && name && body.name === undefined && body.languagename === undefined) body.name = name;
    writeFields(body, parts, 6);
    parts.push(`          </${tag}>`);
    parts.push('        </TALLYMESSAGE>');
  }
  parts.push('      </REQUESTDATA>', '    </IMPORTDATA>', '  </BODY>', '</ENVELOPE>');
  return parts.join('\n');
}

export function tallyJsonToXml(text: string): { xml: string; mastersXml: string; vouchersXml: string; company: string; masters: number; vouchers: number } {
  const { company, messages } = parseTallyJson(text);
  const isVch = (m: JsonObject) => normKey(String((m.metadata as JsonObject | undefined)?.type ?? '')) === 'voucher';
  const vch = messages.filter(isVch);
  const mst = messages.filter((m) => !isVch(m));
  return {
    xml: messagesToTallyXml(messages, { company, report: vch.length ? 'Vouchers' : 'All Masters' }),
    mastersXml: messagesToTallyXml(mst, { company, report: 'All Masters' }),
    vouchersXml: messagesToTallyXml(vch, { company, report: 'Vouchers' }),
    company,
    masters: mst.length,
    vouchers: vch.length,
  };
}

export function isTallyJson(text: string): boolean {
  try {
    parseTallyJson(text);
    return true;
  } catch {
    return false;
  }
}

