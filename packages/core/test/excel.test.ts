import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { Books, createUnit, stockItems, units } from '../src/index.ts';
import { nodeDb } from '../src/node-adapter.ts';
import { SAMPLE_FILES, buildXlsx, importMastersFromRows, sampleWorkbook, importVouchersFromRows, guessMasterKind, parseCellAmount, parseCellDate, parseCsvRows, parseXlsx, previewMapping, readSpreadsheet, toCsv } from '../src/excel.ts';

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function zip(files: Record<string, string>, deflate: boolean): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = enc.encode(text);
    const data = deflate ? new Uint8Array(deflateRawSync(raw)) : raw;
    const nameBytes = enc.encode(name);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, deflate ? 8 : 0, true);
    lv.setUint32(14, crc32(raw), true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    chunks.push(local, data);
    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, deflate ? 8 : 0, true);
    cv.setUint32(16, crc32(raw), true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
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
  const all = [...chunks, ...central, end];
  const out = new Uint8Array(all.reduce((s, c) => s + c.length, 0));
  let p = 0;
  for (const c of all) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const colName = (i: number) => String.fromCharCode(65 + i);

function xlsx(sheets: { name: string; rows: (string | number | { date: number } | null)[][] }[], deflate = true): Uint8Array {
  const shared: string[] = [];
  const sst = (s: string) => {
    let i = shared.indexOf(s);
    if (i < 0) i = shared.push(s) - 1;
    return i;
  };
  const sheetXml = sheets.map((sh) => {
    const rows = sh.rows
      .map((r, ri) => {
        const cells = r
          .map((v, ci) => {
            const ref = `${colName(ci)}${ri + 1}`;
            if (v === null || v === '') return '';
            if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
            if (typeof v === 'object') return `<c r="${ref}" s="1"><v>${v.date}</v></c>`;
            if (ci % 2 === 1 && ri > 0) return `<c r="${ref}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`;
            return `<c r="${ref}" t="s"><v>${sst(v)}</v></c>`;
          })
          .join('');
        return `<row r="${ri + 1}">${cells}</row>`;
      })
      .join('');
    return `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
  });
  const files: Record<string, string> = {
    '[Content_Types].xml': '<Types/>',
    'xl/workbook.xml': `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
      .map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships>${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`,
    'xl/styles.xml': '<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
  };
  sheetXml.forEach((x, i) => (files[`xl/worksheets/sheet${i + 1}.xml`] = x));
  files['xl/sharedStrings.xml'] = `<sst>${shared.map((s) => `<si><t>${esc(s)}</t></si>`).join('')}</sst>`;
  return zip(files, deflate);
}

const serial = (iso: string) => Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000);

async function setup() {
  const books = new Books(nodeDb());
  await books.init();
  await books.createCompany({ name: 'Excel Co', fy_start: '2026-04-01', state: 'Maharashtra' });
  return books;
}

test('xlsx reader handles stored and deflated archives, shared and inline strings, date styles', async () => {
  const rows = [
    ['Name', 'Group Name', 'Amount'],
    ['A & B', 'Sundry Debtors', 1858.5],
    ['', 'x', { date: serial('2026-04-10') }],
  ];
  for (const deflate of [false, true]) {
    const sheets = await parseXlsx(xlsx([{ name: 'Ledger', rows }], deflate));
    assert.equal(sheets.length, 1);
    assert.equal(sheets[0].name, 'Ledger');
    assert.deepEqual(sheets[0].rows[0], ['Name', 'Group Name', 'Amount']);
    assert.deepEqual(sheets[0].rows[1], ['A & B', 'Sundry Debtors', '1858.5']);
    assert.deepEqual(sheets[0].rows[2], ['', 'x', '2026-04-10']);
  }
});

test('csv reader and helpers', async () => {
  assert.deepEqual(parseCsvRows('a,b\r\n"x, y","he said ""hi"""\r\n'), [['a', 'b'], ['x, y', 'he said "hi"']]);
  assert.deepEqual(parseCsvRows('a;b\n1;2'), [['a', 'b'], ['1', '2']]);
  assert.equal(toCsv([['a', 'b,c']]), 'a,"b,c"');
  const sheets = await readSpreadsheet('x.csv', new TextEncoder().encode('Name,Group Name\nCash2,Cash-in-Hand'));
  assert.equal(sheets[0].rows[1][0], 'Cash2');
  assert.equal(parseCellDate('10-04-2026'), '2026-04-10');
  assert.equal(parseCellDate('10-Apr-26'), '2026-04-10');
  assert.equal(parseCellDate('45017'), '2023-04-01');
  assert.equal(parseCellDate('31/02/2026'), null);
  assert.equal(parseCellAmount('1,858.50'), 185850);
  assert.equal(parseCellAmount('(100)'), -10000);
  assert.equal(parseCellAmount('abc'), null);
});

test('ledger import with bills, preview then apply, behaviours', async () => {
  const books = await setup();
  const rows = [
    ['Name', 'Group Name', 'Ledger - Opening Balance', 'Ledger Opening Balance - Dr/Cr', 'Bill - Date', 'Bill - Name', 'Bill - Amount', 'Bill Amount - Dr/Cr', 'Address', 'State'],
    ['National Traders', 'Sundry Debtors', '15200', 'Dr'],
    ['ABC Company Limited', 'Sundry Debtors', '10000', 'Dr', '2026-04-01', 'ABC/1', '4000', 'Dr', '15 MG Road', 'Karnataka'],
    ['', '', '', '', '2026-04-03', 'ABC/2', '6000', 'Dr', 'Near LIC building'],
    ['Lost Co', 'Nowhere', '5', 'Dr'],
    ['Bad Bills', 'Sundry Debtors', '100', 'Dr', '', 'B1', '50', 'Dr'],
  ];
  assert.equal(guessMasterKind('Ledger', rows), 'ledger');
  assert.equal(previewMapping(rows, 'ledger').find((m) => m.field === 'group')!.column, 'Group Name');
  const dry = await importMastersFromRows(books, rows, 'ledger', { dryRun: true });
  assert.equal(dry.created, 2);
  assert.equal(dry.errors.length, 2);
  assert.match(dry.errors[0].message, /Referenced master is missing/);
  assert.equal(await books.count('ledgers'), (await books.ledgers()).length);
  const before = (await books.ledgers()).length;
  const rep = await importMastersFromRows(books, rows, 'ledger');
  assert.equal(rep.created, 2);
  assert.equal((await books.ledgers()).length, before + 2);
  const abc = (await books.ledgers()).find((l) => l.name === 'ABC Company Limited')!;
  assert.equal(abc.opening, 1000000);
  assert.equal(abc.address, '15 MG Road\nNear LIC building');
  assert.equal(abc.state, 'Karnataka');
  assert.equal((await books.ledger(abc.id))!.opening_bills.length, 2);
  const again = await importMastersFromRows(books, rows, 'ledger');
  assert.equal(again.created, 0);
  assert.equal(again.ignored, 2);
  const combined = await importMastersFromRows(books, rows.slice(0, 2), 'ledger', { behaviour: 'Combine Opening Balance' });
  assert.equal(combined.updated, 1);
  assert.equal((await books.ledgers()).find((l) => l.name === 'National Traders')!.opening, 3040000);
  const modified = await importMastersFromRows(books, rows.slice(0, 2), 'ledger', { behaviour: 'Modify with New Data' });
  assert.equal((await books.ledgers()).find((l) => l.name === 'National Traders')!.opening, 1520000);
  assert.equal(modified.updated, 1);
});

test('group, unit, godown, cost centre and stock item masters', async () => {
  const books = await setup();
  const g = await importMastersFromRows(books, [['Name', 'Under'], ['Retail', 'Sundry Debtors'], ['Retail North', 'Retail']], 'group');
  assert.equal(g.created, 2);
  assert.equal((await books.groups()).find((x) => x.name === 'Retail North')!.nature, 'Assets');
  const u = await importMastersFromRows(books, [['Symbol', 'Type of Unit', 'Formal name'], ['Pcs', 'Simple', 'Pieces'], ['Nos', 'Simple', 'Numbers'], ['Box', 'Compound', 'Box']], 'unit');
  assert.equal(u.created, 1);
  assert.equal(u.ignored, 1);
  assert.equal(u.errors.length, 1);
  assert.ok((await units(books.db)).some((x) => x.symbol === 'Pcs'));
  const go = await importMastersFromRows(books, [['Name', 'Address'], ['Delhi Godown', 'Pritampura']], 'godown');
  assert.equal(go.created, 1);
  assert.equal(go.warnings.length, 1);
  const cc = await importMastersFromRows(books, [['Name'], ['Rahul'], ['Anish']], 'cost_centre');
  assert.equal(cc.created, 2);
  const si = await importMastersFromRows(
    books,
    [
      ['Item Name', ' Unit of Measurement', ' Quantity', 'Rate', ' Value'],
      ['Pen', ' Nos', '55', '315', '17325'],
      ['Eraser', 'Pcs', '40', '30', ''],
      ['Ghost', 'Kg', '1', '1', '1'],
    ],
    'stock_item'
  );
  assert.equal(si.created, 2);
  assert.equal(si.errors.length, 1);
  const items = await stockItems(books.db);
  assert.equal(items.find((i) => i.name === 'Pen')!.opening_value, 1732500);
  assert.equal(items.find((i) => i.name === 'Eraser')!.opening_value, 120000);
  assert.equal(items.find((i) => i.name === 'Eraser')!.opening_qty, 40000);
  await createUnit(books.db, { symbol: 'Kg' });
});

test('voucher import in default template and item rows', async () => {
  const books = await setup();
  const groups = await books.groups();
  const gid = (n: string) => groups.find((x) => x.name === n)!.id;
  await books.createLedger({ name: 'National Traders', group_id: gid('Sundry Debtors') });
  await books.createLedger({ name: 'HDFC Bank', group_id: gid('Bank Accounts') });
  await books.createLedger({ name: 'Sales', group_id: gid('Sales Accounts') });
  await books.createLedger({ name: 'Output CGST', group_id: gid('Duties & Taxes') });
  await importMastersFromRows(books, [['Item Name', 'Unit', 'Quantity', 'Rate'], ['Pen', 'Nos', '100', '300']], 'stock_item');
  await importMastersFromRows(books, [['Name'], ['Rahul']], 'cost_centre');
  const d1 = serial('2026-04-10');
  const d2 = serial('2026-04-12');
  const book = xlsx([
    {
      name: 'Accounting Voucher',
      rows: [
        ['Voucher Date', 'Voucher Type Name', 'Voucher Number', 'Ledger Name', 'Ledger Amount', 'Ledger Amount Dr/Cr', 'Item Name', 'Quantity', 'Rate', 'Value', 'Cost Centre Name'],
        [{ date: d1 }, 'Receipt', '15', 'National Traders', 15200, 'Cr'],
        [null, null, null, 'HDFC Bank', 15200, 'Dr'],
        [{ date: d2 }, 'Sales', '201', 'National Traders', 1858.5, 'Dr'],
        [null, null, null, 'Sales', 1575, 'Cr', 'Pen', 5, 315, 1575, 'Rahul'],
        [null, null, null, 'Output CGST', 283.5, 'Cr'],
        [{ date: d2 }, 'Payment', '9', 'Nobody', 10, 'Dr'],
        [null, null, null, 'HDFC Bank', 10, 'Cr'],
        [{ date: d2 }, 'Payment', '10', 'HDFC Bank', 10, 'Dr'],
        [null, null, null, 'HDFC Bank', 9, 'Cr'],
      ],
    },
  ]);
  const sheet = (await parseXlsx(book))[0];
  const dry = await importVouchersFromRows(books, sheet.rows, { dryRun: true });
  assert.equal(dry.created, 2);
  assert.equal(dry.errors.length, 2);
  assert.equal(await books.count('vouchers'), 0);
  const rep = await importVouchersFromRows(books, sheet.rows);
  assert.equal(rep.created, 2);
  assert.equal(rep.amount, 1520000 + 185850);
  const vs = await books.db.select<{ id: number }>('SELECT id FROM vouchers ORDER BY id');
  assert.equal(vs.length, 2);
  const sales = (await books.voucher(vs[1].id))!;
  assert.equal(sales.reference, '201');
  assert.equal(sales.date, '2026-04-12');
  assert.equal(sales.entries.length, 3);
  assert.equal(sales.stock.length, 1);
  assert.equal(sales.stock[0].qty, -5000);
  assert.equal(sales.stock[0].amount, 157500);
  const alloc = await books.db.select('SELECT * FROM cost_allocations');
  assert.equal(alloc.length, 1);
  const again = await importVouchersFromRows(books, sheet.rows);
  assert.equal(again.created, 0);
  assert.equal(again.ignored, 2);
});

test('missing mandatory columns are reported', async () => {
  const books = await setup();
  const rep = await importMastersFromRows(books, [['Foo'], ['bar']], 'ledger');
  assert.equal(rep.errors.length, 1);
  assert.match(rep.errors[0].message, /Mandatory column/);
});

test('built workbooks read back and sample templates import cleanly', async () => {
  const sheets = await parseXlsx(buildXlsx([{ name: 'A & B', rows: [['Name', 'Amt'], ['x < y', '12.5'], ['', '7']] }]));
  assert.equal(sheets[0].name, 'A & B');
  assert.deepEqual(sheets[0].rows, [['Name', 'Amt'], ['x < y', '12.5'], ['', '7']]);
  const books = await setup();
  for (const f of SAMPLE_FILES.filter((x) => x.target === 'masters')) {
    const read = await parseXlsx(sampleWorkbook(f));
    assert.equal(read.length, f.sheets.length);
    for (const [i, s] of f.sheets.entries()) {
      assert.equal(read[i].name, s.name);
      assert.equal(guessMasterKind(read[i].name, read[i].rows), s.kind === 'voucher' ? null : s.kind);
    }
  }
  const vouchers = await parseXlsx(sampleWorkbook(SAMPLE_FILES.find((x) => x.target === 'transactions')!));
  assert.equal(previewMapping(vouchers[0].rows, 'voucher').filter((m) => m.required && !m.column).length, 0);
  assert.equal((await importMastersFromRows(books, (await parseXlsx(sampleWorkbook(SAMPLE_FILES[0])))[0].rows, 'group')).created, 1);
});
