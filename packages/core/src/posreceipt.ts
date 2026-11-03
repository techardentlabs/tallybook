import { Books } from './books.ts';
import { fmtAmount, fmtDate } from './util.ts';
import { posPayments } from './pos.ts';
import { voucherClassUse, voucherTypeOptions } from './vclass.ts';

export interface PosReceiptLine {
  item: string;
  qty: number;
  rate: number;
  amount: number;
}

export interface PosReceipt {
  title: string;
  company: string;
  address: string;
  gstin: string;
  number: string;
  date: string;
  party: string;
  lines: PosReceiptLine[];
  charges: { label: string; amount: number }[];
  total: number;
  payments: { label: string; amount: number; ref: string }[];
  tendered: number;
  balance: number;
  messages: string[];
  currency: string;
}

const MODE_LABEL: Record<string, string> = { gift: 'Gift Voucher', card: 'Card', cheque: 'Cheque / DD', cash: 'Cash' };

export async function posReceipt(books: Books, voucherId: number): Promise<PosReceipt | null> {
  const v = await books.voucher(voucherId);
  const co = await books.company();
  if (!v || !co) return null;
  const [opts, cls, pays] = await Promise.all([voucherTypeOptions(books.db, v.type_id), voucherClassUse(books.db, voucherId).catch(() => null), posPayments(books.db, voucherId).catch(() => [])]);
  const party = v.party_id ? v.entries.find((e) => e.ledger_id === v.party_id)?.ledger ?? '' : '';
  const lines = v.stock.map((m) => ({ item: m.item, qty: Math.abs(m.qty), rate: m.rate, amount: Math.abs(m.amount) }));
  const itemTotal = lines.reduce((s, l) => s + l.amount, 0);
  const total = v.entries.filter((e) => e.amount > 0).reduce((s, e) => s + e.amount, 0);
  const itemLedgers = new Set(v.stock.map((m) => m.ledger_id).filter(Boolean));
  const charges = v.entries
    .filter((e) => e.amount < 0 && !itemLedgers.has(e.ledger_id))
    .map((e) => ({ label: e.ledger, amount: -e.amount }));
  const tendered = pays.reduce((s, p) => s + (p.tendered || p.amount), 0);
  const balance = pays.reduce((s, p) => s + p.balance, 0);
  void itemTotal;
  return {
    title: cls?.print_title || opts.default_title || 'Invoice',
    company: co.name,
    address: [co.address, co.state, co.pincode].filter(Boolean).join(', '),
    gstin: co.gstin,
    number: v.number,
    date: fmtDate(v.date),
    party: party === 'Cash' ? '' : party,
    lines,
    charges,
    total,
    payments: pays.map((p) => ({ label: MODE_LABEL[p.mode] ?? p.mode, amount: p.amount, ref: p.ref_no || p.bank_name })),
    tendered,
    balance,
    messages: [opts.pos_message1, opts.pos_message2].filter(Boolean),
    currency: co.currency_symbol,
  };
}

export function posReceiptText(r: PosReceipt, width = 40): string {
  const center = (s: string) => (s.length >= width ? s : ' '.repeat(Math.floor((width - s.length) / 2)) + s);
  const two = (a: string, b: string) => a + ' '.repeat(Math.max(1, width - a.length - b.length)) + b;
  const money = (n: number) => fmtAmount(n, false);
  const out: string[] = [center(r.company)];
  if (r.address) out.push(center(r.address));
  if (r.gstin) out.push(center(`GSTIN: ${r.gstin}`));
  out.push(center(r.title), '-'.repeat(width), two(`No. ${r.number}`, r.date));
  if (r.party) out.push(`Customer: ${r.party}`);
  out.push('-'.repeat(width));
  for (const l of r.lines) {
    out.push(l.item.slice(0, width));
    out.push(two(`  ${l.qty / 1000} x ${money(l.rate)}`, money(l.amount)));
  }
  out.push('-'.repeat(width));
  for (const c of r.charges) out.push(two(c.label, money(c.amount)));
  out.push(two('TOTAL', `${r.currency} ${money(r.total)}`));
  for (const p of r.payments) out.push(two(p.ref ? `${p.label} (${p.ref})` : p.label, money(p.amount)));
  if (r.tendered && r.balance) out.push(two('Tendered', money(r.tendered)), two('Balance returned', money(r.balance)));
  for (const m of r.messages) out.push('', center(m));
  return out.join('\n');
}
