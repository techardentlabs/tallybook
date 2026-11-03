import { posReceipt, type PosReceipt, type Books } from '@tallybook/core';
import { fmtAmount } from '@tallybook/core';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

export function receiptHtml(r: PosReceipt): string {
  const money = (n: number) => fmtAmount(n, false);
  const row = (a: string, b: string, bold = false) => `<div class="r${bold ? ' b' : ''}"><span>${esc(a)}</span><span>${esc(b)}</span></div>`;
  const lines = r.lines.map((l) => `<div>${esc(l.item)}</div>${row(`  ${l.qty / 1000} x ${money(l.rate)}`, money(l.amount))}`).join('');
  const charges = r.charges.map((c) => row(c.label, money(c.amount))).join('');
  const pays = r.payments.map((p) => row(p.ref ? `${p.label} (${p.ref})` : p.label, money(p.amount))).join('');
  const change = r.tendered && r.balance ? row('Tendered', money(r.tendered)) + row('Balance returned', money(r.balance)) : '';
  const msgs = r.messages.map((m) => `<p class="c">${esc(m)}</p>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(r.title)} ${esc(r.number)}</title><style>
@page{size:80mm auto;margin:4mm}
body{font:12px/1.35 'Courier New',monospace;width:72mm;margin:0;color:#000}
.c{text-align:center;margin:2px 0}.r{display:flex;justify-content:space-between;gap:6px}.b{font-weight:700}
hr{border:0;border-top:1px dashed #000;margin:4px 0}
</style></head><body>
<p class="c b">${esc(r.company)}</p>${r.address ? `<p class="c">${esc(r.address)}</p>` : ''}${r.gstin ? `<p class="c">GSTIN: ${esc(r.gstin)}</p>` : ''}
<p class="c b">${esc(r.title)}</p><hr>${row(`No. ${r.number}`, r.date)}${r.party ? `<div>Customer: ${esc(r.party)}</div>` : ''}<hr>
${lines}<hr>${charges}${row('TOTAL', `${r.currency} ${money(r.total)}`, true)}${pays}${change}${msgs}
</body></html>`;
}

export function printHtml(html: string, copies = 1): void {
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  if (!doc || !frame.contentWindow) {
    frame.remove();
    return;
  }
  doc.open();
  doc.write(html);
  doc.close();
  const win = frame.contentWindow;
  setTimeout(() => {
    for (let i = 0; i < copies; i += 1) win.print();
    setTimeout(() => frame.remove(), 1500);
  }, 150);
}

export async function printPosReceipt(books: Books, voucherId: number, copies = 1): Promise<boolean> {
  const r = await posReceipt(books, voucherId);
  if (!r) return false;
  printHtml(receiptHtml(r), copies);
  return true;
}
