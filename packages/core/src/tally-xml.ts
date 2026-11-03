import { one, type Db, type Stmt } from './db.ts';
import type { Books, Group } from './books.ts';
import { child, childs, descendants, parseXml, textOf, XmlWriter, type XNode } from './xml.ts';
import { clean, isIsoDate, newGuid } from './util.ts';

export interface ImportError {
  kind: string;
  name: string;
  message: string;
}

export interface ImportReport {
  dryRun: boolean;
  created: { groups: number; ledgers: number; voucher_types: number; vouchers: number };
  updated: { ledgers: number; vouchers: number };
  skipped: { groups: number; voucher_types: number; vouchers: number };
  deleted: { vouchers: number };
  warnings: string[];
  errors: ImportError[];
  totals: { voucher_amount: number; ledger_opening_net: number };
}

export function decimalToPaise(raw: string): number {
  const m = /^\s*(-?)\s*([\d,]*)\.?(\d*)/.exec(raw ?? '');
  if (!m) return 0;
  const whole = parseInt((m[2] || '0').replace(/,/g, ''), 10) || 0;
  const frac = parseInt((m[3] || '').padEnd(3, '0').slice(0, 3), 10) || 0;
  const paise = whole * 100 + Math.round(frac / 10);
  return m[1] ? -paise : paise;
}

export function paiseToDecimal(paise: number): string {
  const abs = Math.abs(paise);
  return `${paise < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function tallyDate(raw: string): string | null {
  const t = raw.trim();
  if (/^\d{8}$/.test(t)) {
    const iso = `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
    return isIsoDate(iso) ? iso : null;
  }
  return isIsoDate(t) ? t : null;
}

const toTallyDate = (iso: string) => iso.replaceAll('-', '');

const yes = (v: string) => /^yes$/i.test(v.trim());

function nameOf(n: XNode): string {
  if (n.attrs.NAME) return n.attrs.NAME.trim();
  const list = child(n, 'LANGUAGENAME.LIST');
  const nl = list ? child(list, 'NAME.LIST') : child(n, 'NAME.LIST');
  const first = nl ? textOf(child(nl, 'NAME')) : '';
  return first || textOf(n, 'NAME');
}

function guidOf(n: XNode): string {
  return textOf(n, 'GUID') || n.attrs.REMOTEID || '';
}

const BILL_KIND: Record<string, 'new' | 'agst' | 'adv' | 'onacc'> = {
  'new ref': 'new',
  'agst ref': 'agst',
  advance: 'adv',
  'on account': 'onacc',
};

const NUMBERING: Record<string, 'auto' | 'auto_override' | 'manual' | 'none'> = {
  'auto': 'auto',
  'automatic': 'auto',
  'automatic (manual override)': 'auto_override',
  'auto (manual override)': 'auto_override',
  'manual': 'manual',
  'none': 'none',
  'multi-user auto': 'auto',
};

function natureFromXml(n: XNode): Group['nature'] | null {
  const revenue = yes(textOf(n, 'ISREVENUE'));
  const deemed = yes(textOf(n, 'ISDEEMEDPOSITIVE'));
  if (!n.children.length) return null;
  if (revenue) return deemed ? 'Expense' : 'Income';
  return deemed ? 'Assets' : 'Liabilities';
}

interface VGroup { id: number; name: string; parent_id: number | null; nature: Group['nature']; is_new: boolean }
interface VLedger { id: number; name: string; guid: string; is_new: boolean }

export async function importTallyXml(books: Books, xml: string, opts: { dryRun?: boolean } = {}): Promise<ImportReport> {
  const dryRun = !!opts.dryRun;
  const db = books.db;
  const report: ImportReport = {
    dryRun,
    created: { groups: 0, ledgers: 0, voucher_types: 0, vouchers: 0 },
    updated: { ledgers: 0, vouchers: 0 },
    skipped: { groups: 0, voucher_types: 0, vouchers: 0 },
    deleted: { vouchers: 0 },
    warnings: [],
    errors: [],
    totals: { voucher_amount: 0, ledger_opening_net: 0 },
  };
  const err = (kind: string, name: string, message: string) => report.errors.push({ kind, name, message });

  const root = parseXml(xml);
  const company = await books.requireCompany();
  const stmts: Stmt[] = [];

  const maxId = async (table: string) => ((await one<{ m: number }>(db, `SELECT COALESCE(MAX(id), 0) AS m FROM ${table}`))!.m);
  let gid = await maxId('groups');
  let lid = await maxId('ledgers');
  let tid = await maxId('voucher_types');
  let vid = await maxId('vouchers');
  let eid = await maxId('entries');

  const existingGroups = await books.groups();
  const groups = new Map<string, VGroup>(
    existingGroups.map((g) => [g.name.toLowerCase(), { id: g.id, name: g.name, parent_id: g.parent_id, nature: g.nature, is_new: false }])
  );
  const groupAffects = new Map(existingGroups.map((g) => [g.id, g.affects_gross]));

  const pendingGroups = descendants(root, 'GROUP').map((n) => ({ n, name: nameOf(n), parent: textOf(n, 'PARENT') }));
  let progress = true;
  let queue = pendingGroups.filter((g) => g.name);
  while (queue.length && progress) {
    progress = false;
    const next: typeof queue = [];
    for (const g of queue) {
      if (groups.has(g.name.toLowerCase())) {
        report.skipped.groups += 1;
        progress = true;
        continue;
      }
      const parentName = g.parent && !/^primary$/i.test(g.parent) ? g.parent : '';
      let parent: VGroup | undefined;
      if (parentName) {
        parent = groups.get(parentName.toLowerCase());
        if (!parent) {
          next.push(g);
          continue;
        }
      }
      const nature = parent ? parent.nature : natureFromXml(g.n);
      if (!nature) {
        err('group', g.name, 'Cannot determine the nature of this primary group');
        progress = true;
        continue;
      }
      gid += 1;
      const affects = parent ? groupAffects.get(parent.id) ?? 0 : 0;
      groupAffects.set(gid, affects);
      groups.set(g.name.toLowerCase(), { id: gid, name: g.name, parent_id: parent?.id ?? null, nature, is_new: true });
      stmts.push({
        sql: 'INSERT INTO groups (id, guid, name, parent_id, nature, affects_gross) VALUES (?, ?, ?, ?, ?, ?)',
        params: [gid, guidOf(g.n) || newGuid(), g.name, parent?.id ?? null, nature, affects],
      });
      report.created.groups += 1;
      progress = true;
    }
    queue = next;
  }
  for (const g of queue) err('group', g.name, `Parent group "${g.parent}" was not found`);

  const existingLedgers = await books.ledgers();
  const ledgers = new Map<string, VLedger>(existingLedgers.map((l) => [l.name.toLowerCase(), { id: l.id, name: l.name, guid: l.guid, is_new: false }]));
  const ledgerByGuid = new Map(existingLedgers.map((l) => [l.guid, l.id]));
  const existingById = new Map(existingLedgers.map((l) => [l.id, l]));
  const seenLedger = new Set<string>();

  for (const n of descendants(root, 'LEDGER')) {
    const name = nameOf(n);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seenLedger.has(key)) continue;
    seenLedger.add(key);
    const parentName = textOf(n, 'PARENT');
    const group = groups.get(parentName.toLowerCase());
    const match = ledgers.get(key) ?? (ledgerByGuid.has(guidOf(n)) ? [...ledgers.values()].find((l) => l.id === ledgerByGuid.get(guidOf(n))) : undefined);
    if (!group && !(match && !parentName)) {
      err('ledger', name, `Group "${parentName}" was not found`);
      continue;
    }
    const openingRaw = textOf(n, 'OPENINGBALANCE');
    const opening = openingRaw ? -decimalToPaise(openingRaw) : 0;
    const billNodes = descendants(n, 'BILLALLOCATIONS.LIST');
    let bills = billNodes.map((b) => ({
      name: textOf(b, 'NAME'),
      bill_date: tallyDate(textOf(b, 'BILLDATE')) ?? '',
      due_date: tallyDate(textOf(b, 'BILLCREDITPERIOD')) ?? '',
      amount: -decimalToPaise(textOf(b, 'AMOUNT')),
    })).filter((b) => b.name);
    if (bills.length && bills.reduce((s, b) => s + b.amount, 0) !== opening) {
      report.warnings.push(`Ledger "${name}": opening bill allocations do not add up to the opening balance and were skipped`);
      bills = [];
    }
    const mailing = child(n, 'LEDMAILINGDETAILS.LIST');
    const addrNode = mailing ? child(mailing, 'ADDRESS.LIST') ?? n : child(n, 'ADDRESS.LIST');
    const address = addrNode ? childs(addrNode, 'ADDRESS').map((a) => a.text.trim()).filter(Boolean).join('\n') : '';
    const credit = parseInt(/\d+/.exec(textOf(n, 'BILLCREDITPERIOD'))?.[0] ?? '0', 10) || 0;
    const fields = {
      address,
      state: textOf(mailing, 'STATE') || textOf(n, 'LEDSTATENAME'),
      country: textOf(mailing, 'COUNTRY') || textOf(n, 'COUNTRYOFRESIDENCE'),
      pincode: textOf(mailing, 'PINCODE'),
      phone: textOf(n, 'LEDGERPHONE') || textOf(n, 'LEDGERMOBILE'),
      email: textOf(n, 'EMAIL'),
      contact: textOf(n, 'LEDGERCONTACT'),
      pan: textOf(n, 'INCOMETAXNUMBER'),
      gstin: textOf(n, 'PARTYGSTIN'),
      reg_type: textOf(n, 'GSTREGISTRATIONTYPE'),
    };
    report.totals.ledger_opening_net += opening;
    if (match && !match.is_new) {
      const cur = existingById.get(match.id)!;
      const sets = ['opening = ?', 'bill_by_bill = ?', 'credit_days = ?', 'address = ?', 'state = ?', 'pincode = ?', 'phone = ?', 'email = ?', 'pan = ?', 'gstin = ?', 'reg_type = ?'];
      const params: (string | number)[] = [opening, yes(textOf(n, 'ISBILLWISEON')) ? 1 : 0, credit, clean(fields.address, 500), clean(fields.state), clean(fields.pincode, 10), clean(fields.phone), clean(fields.email), clean(fields.pan, 10), clean(fields.gstin, 15), clean(fields.reg_type)];
      if (group && !cur.is_system) {
        sets.push('group_id = ?');
        params.push(group.id);
      }
      stmts.push({ sql: `UPDATE ledgers SET ${sets.join(', ')} WHERE id = ?`, params: [...params, match.id] });
      stmts.push({ sql: "DELETE FROM bills WHERE ledger_id = ? AND kind = 'opening'", params: [match.id] });
      for (const b of bills) stmts.push(openingBill(match.id, b));
      report.updated.ledgers += 1;
      continue;
    }
    lid += 1;
    const guid = guidOf(n) || newGuid();
    ledgers.set(key, { id: lid, name, guid, is_new: true });
    stmts.push({
      sql: `INSERT INTO ledgers (id, guid, name, group_id, opening, bill_by_bill, credit_days, address, state, country, pincode, phone, email, contact, pan, gstin, reg_type)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [lid, guid, name, group!.id, opening, yes(textOf(n, 'ISBILLWISEON')) ? 1 : 0, credit, clean(fields.address, 500), clean(fields.state), clean(fields.country) || 'India', clean(fields.pincode, 10), clean(fields.phone), clean(fields.email), clean(fields.contact), clean(fields.pan, 10), clean(fields.gstin, 15), clean(fields.reg_type)],
    });
    for (const b of bills) stmts.push(openingBill(lid, b));
    report.created.ledgers += 1;
  }

  const types = new Map((await books.voucherTypes()).map((t) => [t.name.toLowerCase(), { id: t.id, parent: t.parent, numbering: t.numbering, prefix: t.prefix, suffix: t.suffix }]));
  const systemParents = new Set((await books.voucherTypes()).filter((t) => t.is_system).map((t) => t.name));
  for (const n of descendants(root, 'VOUCHERTYPE')) {
    const name = nameOf(n);
    if (!name) continue;
    if (types.has(name.toLowerCase())) {
      report.skipped.voucher_types += 1;
      continue;
    }
    const parent = textOf(n, 'PARENT');
    if (!systemParents.has(parent)) {
      err('voucher type', name, `Parent type "${parent}" is not supported`);
      continue;
    }
    tid += 1;
    const numbering = NUMBERING[textOf(n, 'NUMBERINGSTYLE').toLowerCase()] ?? 'auto';
    types.set(name.toLowerCase(), { id: tid, parent, numbering, prefix: '', suffix: '' });
    stmts.push({
      sql: 'INSERT INTO voucher_types (id, guid, name, parent, numbering) VALUES (?, ?, ?, ?, ?)',
      params: [tid, guidOf(n) || newGuid(), name, parent, numbering],
    });
    report.created.voucher_types += 1;
  }

  const existingVouchers = await db.select<{ id: number; guid: string; type_id: number; number: string }>('SELECT id, guid, type_id, number FROM vouchers');
  const byGuid = new Map(existingVouchers.map((v) => [v.guid, v]));
  const usedNumbers = new Set(existingVouchers.map((v) => `${v.type_id}|${v.number}`));
  const seqRows = await db.select<{ type_id: number; m: number }>('SELECT type_id, MAX(seq) AS m FROM vouchers GROUP BY type_id');
  const seqs = new Map(seqRows.map((r) => [r.type_id, r.m]));
  const typeIds = new Map<string, number>();
  let inventoryWarned = false;

  for (const v of descendants(root, 'VOUCHER')) {
    const guid = guidOf(v);
    const action = (v.attrs.ACTION || '').toLowerCase();
    const label = `${v.attrs.VCHTYPE || textOf(v, 'VOUCHERTYPENAME')} ${textOf(v, 'VOUCHERNUMBER')}`.trim();
    const existing = guid ? byGuid.get(guid) : undefined;
    if (action === 'delete') {
      if (existing) {
        stmts.push(
          { sql: 'DELETE FROM bills WHERE entry_id IN (SELECT id FROM entries WHERE voucher_id = ?)', params: [existing.id] },
          { sql: 'DELETE FROM entries WHERE voucher_id = ?', params: [existing.id] },
          { sql: 'DELETE FROM vouchers WHERE id = ?', params: [existing.id] }
        );
        report.deleted.vouchers += 1;
      }
      continue;
    }
    if (action === 'cancel') {
      report.warnings.push(`Voucher ${label}: Cancel action is not applied by import`);
      continue;
    }
    if (existing && action !== 'alter') {
      report.skipped.vouchers += 1;
      continue;
    }
    const date = tallyDate(textOf(v, 'DATE'));
    if (!date) {
      err('voucher', label, 'Missing or invalid date');
      continue;
    }
    if (date < company.books_from || date > company.fy_end) {
      err('voucher', label, `Date ${date} is outside the books period ${company.books_from} to ${company.fy_end}`);
      continue;
    }
    const typeName = textOf(v, 'VOUCHERTYPENAME') || v.attrs.VCHTYPE || '';
    let type = types.get(typeName.toLowerCase());
    if (!type) {
      const parent = v.attrs.VCHTYPE;
      if (parent && systemParents.has(parent)) {
        tid += 1;
        type = { id: tid, parent, numbering: 'auto', prefix: '', suffix: '' };
        types.set(typeName.toLowerCase(), type);
        stmts.push({ sql: 'INSERT INTO voucher_types (id, guid, name, parent, numbering) VALUES (?, ?, ?, ?, ?)', params: [tid, newGuid(), typeName, parent, 'auto'] });
        report.created.voucher_types += 1;
      } else {
        err('voucher', label, `Voucher type "${typeName}" is not supported`);
        continue;
      }
    }
    typeIds.set(typeName, type.id);

    const entryNodes = [...descendants(v, 'ALLLEDGERENTRIES.LIST'), ...descendants(v, 'LEDGERENTRIES.LIST'), ...descendants(v, 'ACCOUNTINGALLOCATIONS.LIST')];
    if (!inventoryWarned && (descendants(v, 'ALLINVENTORYENTRIES.LIST').length || descendants(v, 'INVENTORYENTRIES.LIST').length)) {
      inventoryWarned = true;
      report.warnings.push('Item (inventory) lines are not imported yet; their accounting amounts are kept');
    }
    const entries: { ledger_id: number; amount: number; bills: { kind: string; name: string; amount: number }[] }[] = [];
    let ok = true;
    let sum = 0;
    for (const e of entryNodes) {
      const ln = textOf(e, 'LEDGERNAME');
      const amt = -decimalToPaise(textOf(e, 'AMOUNT'));
      if (!ln || amt === 0) continue;
      const led = ledgers.get(ln.toLowerCase());
      if (!led) {
        err('voucher', label, `Ledger "${ln}" was not found`);
        ok = false;
        break;
      }
      let bills = childs(e, 'BILLALLOCATIONS.LIST').map((b) => ({
        kind: BILL_KIND[textOf(b, 'BILLTYPE').toLowerCase()] ?? 'onacc',
        name: textOf(b, 'NAME'),
        amount: -decimalToPaise(textOf(b, 'AMOUNT')),
      }));
      if (bills.length && bills.reduce((s, b) => s + b.amount, 0) !== amt) {
        report.warnings.push(`Voucher ${label}: bill allocations for "${ln}" did not match the amount and were skipped`);
        bills = [];
      }
      sum += amt;
      entries.push({ ledger_id: led.id, amount: amt, bills });
    }
    if (!ok) continue;
    if (entries.length < 2) {
      err('voucher', label, 'Fewer than two ledger entries');
      continue;
    }
    if (sum !== 0) {
      err('voucher', label, `Debit and credit differ by ${paiseToDecimal(Math.abs(sum))}`);
      continue;
    }
    let number = textOf(v, 'VOUCHERNUMBER');
    let seq = seqs.get(type.id) ?? 0;
    if (/^\d+$/.test(number)) seq = Math.max(seq, Number(number));
    else seq += 1;
    if (!number) number = String(seq);
    seqs.set(type.id, seq);
    const numKey = `${type.id}|${number}`;
    if (usedNumbers.has(numKey) && !(existing && existing.type_id === type.id && existing.number === number)) {
      err('voucher', label, `Voucher number ${number} already exists for ${typeName}`);
      continue;
    }
    usedNumbers.add(numKey);

    if (existing) {
      stmts.push(
        { sql: 'DELETE FROM bills WHERE entry_id IN (SELECT id FROM entries WHERE voucher_id = ?)', params: [existing.id] },
        { sql: 'DELETE FROM entries WHERE voucher_id = ?', params: [existing.id] },
        { sql: 'DELETE FROM vouchers WHERE id = ?', params: [existing.id] }
      );
      report.updated.vouchers += 1;
    } else {
      report.created.vouchers += 1;
    }
    vid += 1;
    const partyName = textOf(v, 'PARTYLEDGERNAME');
    const party = partyName ? ledgers.get(partyName.toLowerCase()) : undefined;
    stmts.push({
      sql: `INSERT INTO vouchers (id, guid, type_id, number, seq, date, reference, narration, party_id, place_of_supply)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [vid, guid || newGuid(), type.id, number, seq, date, clean(textOf(v, 'REFERENCE')), clean(textOf(v, 'NARRATION'), 500), party?.id ?? null, clean(textOf(v, 'PLACEOFSUPPLY'))],
    });
    entries.forEach((e, i) => {
      eid += 1;
      stmts.push({ sql: 'INSERT INTO entries (id, voucher_id, ledger_id, amount, seq) VALUES (?, ?, ?, ?, ?)', params: [eid, vid, e.ledger_id, e.amount, i] });
      for (const b of e.bills) {
        stmts.push({ sql: 'INSERT INTO bills (entry_id, ledger_id, kind, name, amount) VALUES (?, ?, ?, ?, ?)', params: [eid, e.ledger_id, b.kind, clean(b.name), b.amount] });
      }
      if (e.amount > 0) report.totals.voucher_amount += e.amount;
    });
  }

  if (!dryRun && stmts.length) await db.batch(stmts);
  return report;
}

function openingBill(ledgerId: number, b: { name: string; bill_date: string; due_date: string; amount: number }): Stmt {
  return {
    sql: "INSERT INTO bills (entry_id, ledger_id, kind, name, amount, bill_date, due_date) VALUES (NULL, ?, 'opening', ?, ?, ?, ?)",
    params: [ledgerId, clean(b.name), b.amount, b.bill_date, b.due_date],
  };
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

const NUMBERING_LABEL = { auto: 'Automatic', auto_override: 'Automatic (Manual Override)', manual: 'Manual', none: 'None' } as const;
const BILL_LABEL = { new: 'New Ref', agst: 'Agst Ref', adv: 'Advance', onacc: 'On Account', opening: 'New Ref' } as const;

export async function exportMastersXml(books: Books): Promise<string> {
  const company = await books.requireCompany();
  const groups = (await books.groups()).filter((g) => !g.is_system);
  const ledgers = await books.ledgers();
  const types = (await books.voucherTypes()).filter((t) => !t.is_system);
  const w = new XmlWriter();
  envelopeOpen(w, 'All Masters', company.name);
  for (const g of groups) {
    w.open('GROUP', { NAME: g.name, ACTION: 'Create' });
    w.leaf('GUID', g.guid);
    w.leaf('PARENT', g.parent ?? '');
    w.open('NAME.LIST');
    w.leaf('NAME', g.name);
    w.close('NAME.LIST');
    w.close('GROUP');
  }
  for (const t of types) {
    w.open('VOUCHERTYPE', { NAME: t.name, ACTION: 'Create' });
    w.leaf('GUID', t.guid);
    w.leaf('PARENT', t.parent);
    w.leaf('NUMBERINGSTYLE', NUMBERING_LABEL[t.numbering]);
    w.close('VOUCHERTYPE');
  }
  for (const l of ledgers) {
    const full = await books.ledger(l.id);
    w.open('LEDGER', { NAME: l.name, ACTION: 'Create' });
    w.leaf('GUID', l.guid);
    w.leaf('PARENT', l.group_name);
    w.leaf('OPENINGBALANCE', paiseToDecimal(-l.opening));
    w.leaf('ISBILLWISEON', l.bill_by_bill ? 'Yes' : 'No');
    if (l.credit_days) w.leaf('BILLCREDITPERIOD', `${l.credit_days} Days`);
    if (l.address || l.state || l.pincode || l.country) {
      w.open('LEDMAILINGDETAILS.LIST');
      if (l.address) {
        w.open('ADDRESS.LIST');
        for (const line of l.address.split('\n')) w.leaf('ADDRESS', line);
        w.close('ADDRESS.LIST');
      }
      if (l.state) w.leaf('STATE', l.state);
      if (l.country) w.leaf('COUNTRY', l.country);
      if (l.pincode) w.leaf('PINCODE', l.pincode);
      w.close('LEDMAILINGDETAILS.LIST');
    }
    if (l.phone) w.leaf('LEDGERPHONE', l.phone);
    if (l.email) w.leaf('EMAIL', l.email);
    if (l.contact) w.leaf('LEDGERCONTACT', l.contact);
    if (l.pan) w.leaf('INCOMETAXNUMBER', l.pan);
    if (l.gstin) w.leaf('PARTYGSTIN', l.gstin);
    if (l.reg_type) w.leaf('GSTREGISTRATIONTYPE', l.reg_type);
    for (const b of full?.opening_bills ?? []) {
      w.open('BILLALLOCATIONS.LIST');
      w.leaf('NAME', b.name);
      if (b.bill_date) w.leaf('BILLDATE', toTallyDate(b.bill_date));
      if (b.due_date) w.leaf('BILLCREDITPERIOD', toTallyDate(b.due_date));
      w.leaf('AMOUNT', paiseToDecimal(-b.amount));
      w.close('BILLALLOCATIONS.LIST');
    }
    w.open('LANGUAGENAME.LIST');
    w.open('NAME.LIST', { TYPE: 'String' });
    w.leaf('NAME', l.name);
    w.close('NAME.LIST');
    w.close('LANGUAGENAME.LIST');
    w.close('LEDGER');
  }
  envelopeClose(w);
  return w.toString();
}

export async function exportVouchersXml(books: Books, from: string, to: string): Promise<string> {
  const company = await books.requireCompany();
  const ids = await books.db.select<{ id: number }>('SELECT id FROM vouchers WHERE date >= ? AND date <= ? ORDER BY date, id', [from, to]);
  const names = new Map((await books.ledgers()).map((l) => [l.id, l.name]));
  const w = new XmlWriter();
  envelopeOpen(w, 'Vouchers', company.name);
  for (const r of ids) {
    const v = (await books.voucher(r.id))!;
    w.open('VOUCHER', { REMOTEID: v.guid, VCHTYPE: v.parent, ACTION: 'Create', OBJVIEW: 'Accounting Voucher View' });
    w.leaf('DATE', toTallyDate(v.date));
    w.leaf('GUID', v.guid);
    w.leaf('VOUCHERTYPENAME', v.type);
    w.leaf('VOUCHERNUMBER', v.number);
    if (v.reference) w.leaf('REFERENCE', v.reference);
    if (v.party_id && names.has(v.party_id)) w.leaf('PARTYLEDGERNAME', names.get(v.party_id)!);
    if (v.place_of_supply) w.leaf('PLACEOFSUPPLY', v.place_of_supply);
    if (v.narration) w.leaf('NARRATION', v.narration);
    for (const e of v.entries) {
      w.open('ALLLEDGERENTRIES.LIST');
      w.leaf('LEDGERNAME', e.ledger);
      w.leaf('ISDEEMEDPOSITIVE', e.amount > 0 ? 'Yes' : 'No');
      w.leaf('AMOUNT', paiseToDecimal(-e.amount));
      for (const b of e.bills) {
        w.open('BILLALLOCATIONS.LIST');
        w.leaf('NAME', b.name);
        w.leaf('BILLTYPE', BILL_LABEL[b.kind]);
        w.leaf('AMOUNT', paiseToDecimal(-b.amount));
        w.close('BILLALLOCATIONS.LIST');
      }
      w.close('ALLLEDGERENTRIES.LIST');
    }
    w.close('VOUCHER');
  }
  envelopeClose(w);
  return w.toString();
}

export type { Db };
