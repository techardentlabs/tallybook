import test from 'node:test';
import assert from 'node:assert/strict';
import { Books } from '../src/index.ts';
import {
  amountInWords, autoReconcile, bankingActivities, bankLedgers, cancelCheque, chequeList, chequePrintingList, chequeRangeRegister, chequeRegister, ensureBanking,
  importedBankData, importStatementCsv, issueBlankCheque, linkLine, nextChequeNo, parseBankDate, parseCsv, postDatedList, postDatedSummary, potentialMatches,
  reconciledTxns, reconSummary, saveBankAlloc, saveBankConfig, saveChequeBooks, saveOpeningBrs, setBankDates, setReconStatus, statementLines, unlinkLines, unreconciledTxns, markPrinted,
} from '../src/banking.ts';
import { nodeDb } from '../src/node-adapter.ts';

async function setup() {
  const books = new Books(nodeDb());
  await books.init();
  await books.createCompany({ name: 'Bank Co', fy_start: '2026-04-01' });
  await ensureBanking(books.db);
  const groups = await books.groups();
  const g = (n: string) => groups.find((x) => x.name === n)!.id;
  const ty = (await books.voucherTypes()).reduce((m, t) => m.set(t.name, t.id), new Map<string, number>());
  const mk = async (name: string, group: string, extra: object = {}) => (await books.createLedger({ name, group_id: g(group), ...extra })).id;
  const bank = await mk('HDFC', 'Bank Accounts', { opening: 100_000_00 });
  const rent = await mk('Rent', 'Indirect Expenses');
  const cust = await mk('Customer', 'Sundry Debtors');
  const pay = async (date: string, amount: number, party = rent) => (await books.createVoucher({ type_id: ty.get('Payment')!, date, entries: [{ ledger_id: party, amount }, { ledger_id: bank, amount: -amount }] })).id;
  const rec = async (date: string, amount: number) => (await books.createVoucher({ type_id: ty.get('Receipt')!, date, entries: [{ ledger_id: bank, amount }, { ledger_id: cust, amount: -amount }] })).id;
  return { books, db: books.db, bank, rent, cust, pay, rec, ty };
}

test('bank ledgers and cheque books', async () => {
  const s = await setup();
  assert.deepEqual((await bankLedgers(s.db)).map((b) => b.name), ['HDFC']);
  const cb = await saveChequeBooks(s.db, s.bank, [{ from_no: '100001', count: 100, name: 'Suppliers' }]);
  assert.equal(cb[0].to_no, 100100);
  await assert.rejects(() => saveChequeBooks(s.db, s.bank, [{ from_no: '100001', to_no: '100010' }, { from_no: '100005', to_no: '100020' }]), /overlap/);
  await saveChequeBooks(s.db, s.bank, [{ from_no: '100001', count: 100, name: 'Suppliers' }]);
  assert.equal((await nextChequeNo(s.db, s.bank))!.inst_no, '100001');
  const v = await s.pay('2026-04-02', 5_000_00);
  await saveBankAlloc(s.db, { voucher_id: v, ledger_id: s.bank, inst_no: '100001', inst_date: '2026-04-02', favouring: 'Landlord' });
  assert.equal((await nextChequeNo(s.db, s.bank))!.inst_no, '100002');
  const v2 = await s.pay('2026-04-03', 1_000_00);
  await assert.rejects(() => saveBankAlloc(s.db, { voucher_id: v2, ledger_id: s.bank, inst_no: '100001' }), /already used/);
});

test('cheque register statuses and ranges', async () => {
  const s = await setup();
  await saveChequeBooks(s.db, s.bank, [{ from_no: '100001', count: 100, name: 'Kotak Suppliers' }]);
  const a = await s.pay('2026-04-02', 5_000_00);
  const b = await s.pay('2026-04-03', 2_000_00);
  const c = await s.pay('2026-04-04', 3_000_00);
  await saveBankAlloc(s.db, { voucher_id: a, ledger_id: s.bank, inst_no: '100001', inst_date: '2026-04-02' });
  await saveBankAlloc(s.db, { voucher_id: b, ledger_id: s.bank, inst_no: '100002', inst_date: '2026-04-03' });
  await saveBankAlloc(s.db, { voucher_id: c, ledger_id: s.bank, inst_no: '555', inst_date: '2026-04-04' });
  await setBankDates(s.db, s.bank, [{ ref: `v:${b}`, bank_date: '2026-04-05' }]);
  await issueBlankCheque(s.db, s.bank, '100003');
  await cancelCheque(s.db, s.bank, '100004');
  const [row] = await chequeRegister(s.db, '2026-04-01', '2026-04-30');
  assert.equal(row.label, 'HDFC');
  assert.deepEqual([row.available, row.unreconciled, row.reconciled, row.blank, row.cancelled, row.out_of_period, row.total], [96, 2, 1, 1, 1, 0, 101]);
  const out = (await chequeRegister(s.db, '2026-05-01', '2026-05-31'))[0];
  assert.equal(out.out_of_period, 3);
  const ranges = await chequeRangeRegister(s.db, s.bank, '2026-04-01', '2026-04-30');
  assert.equal(ranges.length, 2);
  assert.equal(ranges[0].label, '100001-100100');
  assert.equal(ranges[0].sub, '(Kotak Suppliers)');
  assert.equal(ranges[1].label, 'Not in Range');
  assert.equal(ranges[1].total, 1);
  const unrec = await chequeList(s.db, s.bank, '2026-04-01', '2026-04-30', { status: 'Unreconciled' });
  assert.deepEqual(unrec.map((i) => i.inst_no), ['555', '100001']);
  assert.equal((await chequeList(s.db, s.bank, '2026-04-01', '2026-04-30', { status: 'Blank Cheque' })).length, 1);
  await saveBankAlloc(s.db, { voucher_id: a, ledger_id: s.bank, inst_no: '100003', inst_date: '2026-04-02' });
  assert.equal((await chequeList(s.db, s.bank, '2026-04-01', '2026-04-30', { status: 'Blank Cheque' })).length, 0);
});

test('cheque printing list and amount in words', async () => {
  const s = await setup();
  const a = await s.pay('2026-04-02', 1_25_000_00);
  await saveBankAlloc(s.db, { voucher_id: a, ledger_id: s.bank, inst_no: '200001', inst_date: '2026-04-02', favouring: 'Landlord' });
  const list = await chequePrintingList(s.db, s.bank, '2026-04-01', '2026-04-30');
  assert.equal(list.length, 1);
  assert.equal(list[0].amount, 1_25_000_00);
  await markPrinted(s.db, [list[0].alloc_id]);
  assert.equal((await chequePrintingList(s.db, s.bank, '2026-04-01', '2026-04-30')).length, 0);
  assert.equal((await chequePrintingList(s.db, s.bank, '2026-04-01', '2026-04-30', true)).length, 1);
  assert.equal(amountInWords(1_25_000_00), 'One Lakh Twenty Five Thousand Only');
  assert.equal(amountInWords(10_000_50), 'Ten Thousand and Fifty Paise Only');
  assert.equal(amountInWords(2_50_00_000_00), 'Two Crore Fifty Lakh Only');
  await saveBankConfig(s.db, s.bank, { cheque_printing: true, print: { width: 210 } });
});

test('csv parsing and dates', () => {
  assert.deepEqual(parseCsv('a,"b,c",d\n1,"x ""y""",3\r\n'), [['a', 'b,c', 'd'], ['1', 'x "y"', '3']]);
  assert.equal(parseBankDate('07/11/2024'), '2024-11-07');
  assert.equal(parseBankDate('7-Nov-24'), '2024-11-07');
  assert.equal(parseBankDate('2024-11-07'), '2024-11-07');
  assert.equal(parseBankDate('31/02/2024'), null);
});

const CSV = [
  'Statement of account,,,,,',
  'Date,Narration,Chq./Ref.No.,Withdrawal Amt.,Deposit Amt.,Closing Balance',
  '02/04/26,NEFT-RENT,100001,"5,000.00",,"95,000.00"',
  '04/04/26,UPI-CUSTOMER,UTR1,,"3,000.00","98,000.00"',
  '05/04/26,BANK CHARGES,,50.00,,"97,950.00"',
  'xx/04/26,BAD,,1.00,,',
].join('\n');

test('statement import, auto reconcile, potential matches, unlink', async () => {
  const s = await setup();
  const p = await s.pay('2026-04-02', 5_000_00);
  await saveBankAlloc(s.db, { voucher_id: p, ledger_id: s.bank, inst_no: '100001', inst_date: '2026-04-02' });
  const r = await s.rec('2026-04-04', 3_000_00);
  const odd = await s.rec('2026-04-09', 700_00);
  const res = await importStatementCsv(s.db, s.bank, CSV);
  assert.equal(res.imported, 3);
  assert.equal(res.rejected.length, 1);
  const again = await importStatementCsv(s.db, s.bank, CSV);
  assert.equal(again.imported, 0);
  assert.equal(again.skipped, 3);
  const lines = await statementLines(s.db, s.bank);
  assert.equal(lines[0].withdrawal, 5_000_00);
  assert.equal(lines[0].balance, 95_000_00);
  const m = await autoReconcile(s.db, s.bank, '2026-04-30');
  assert.deepEqual(m, { matched: 1, unmatched: 2 });
  const rt = await reconciledTxns(s.db, s.bank, '2026-04-01', '2026-04-30');
  assert.equal(rt.length, 1);
  assert.equal(rt[0].link, 'linked');
  assert.equal(rt[0].bank_date, '2026-04-02');
  const pm = await potentialMatches(s.db, s.bank, lines[1].id, '2026-04-30');
  assert.deepEqual(pm.map((t) => t.voucher_id), [r]);
  await linkLine(s.db, s.bank, lines[1].id, `v:${r}`);
  await assert.rejects(() => linkLine(s.db, s.bank, lines[2].id, `v:${odd}`), /Amounts do not match/);
  assert.equal(await unlinkLines(s.db, s.bank, [lines[0].id]), 1);
  const un = await unreconciledTxns(s.db, s.bank, '2026-04-30');
  assert.deepEqual(un.map((t) => t.voucher_id).sort(), [p, odd].sort());
});

test('reconciliation summary arithmetic', async () => {
  const s = await setup();
  const p = await s.pay('2026-04-02', 5_000_00);
  await saveBankAlloc(s.db, { voucher_id: p, ledger_id: s.bank, inst_no: '1' });
  await s.pay('2026-04-03', 1_000_00);
  await s.rec('2026-04-04', 3_000_00);
  await s.rec('2026-04-05', 700_00);
  await importStatementCsv(s.db, s.bank, 'Date,Narration,Withdrawal,Deposit,Balance\n02/04/2026,A,5000,,95000\n06/04/2026,B,,250,95250\n07/04/2026,C,20,,95230\n');
  await autoReconcile(s.db, s.bank, '2026-04-30');
  const sum = await reconSummary(s.db, s.bank, '2026-04-30');
  assert.equal(sum.books_balance, 100_000_00 - 5_000_00 - 1_000_00 + 3_000_00 + 700_00);
  assert.equal(sum.books_withdrawals.amount, 1_000_00);
  assert.equal(sum.books_deposits.amount, 3_700_00);
  assert.equal(sum.bank_deposits.amount, 250_00);
  assert.equal(sum.bank_withdrawals.amount, 20_00);
  assert.equal(sum.unreconciled_count, 5);
  assert.equal(sum.expected_balance, sum.books_balance + 1_000_00 - 3_700_00 + 250_00 - 20_00);
  assert.equal(sum.bank_balance, 95_230_00);
  assert.equal(sum.difference, sum.expected_balance - 95_230_00);
  const act = await bankingActivities(s.db, '2026-04-30');
  assert.equal(act[0].only_books.count, 3);
  assert.equal(act[0].only_bank.count, 2);
});

test('manual reconciliation, status and reconciled in subsequent period', async () => {
  const s = await setup();
  const a = await s.pay('2026-04-02', 1_000_00);
  const b = await s.pay('2026-04-03', 2_000_00);
  assert.equal(await setBankDates(s.db, s.bank, [{ ref: `v:${a}`, bank_date: '2026-04-10' }]), 1);
  let sum = await reconSummary(s.db, s.bank, '2026-04-30');
  assert.equal(sum.books_withdrawals.count, 1);
  sum = await reconSummary(s.db, s.bank, '2026-04-05');
  assert.equal(sum.subsequent.withdrawals.amount, 1_000_00);
  assert.equal(sum.books_withdrawals.count, 1);
  await setReconStatus(s.db, s.bank, [`v:${b}`], 'On Hold');
  assert.equal((await unreconciledTxns(s.db, s.bank, '2026-04-30', { status: 'On Hold' })).length, 1);
  await setReconStatus(s.db, s.bank, [`v:${a}`], 'System Inferred');
  assert.equal((await unreconciledTxns(s.db, s.bank, '2026-04-30')).length, 2);
  await assert.rejects(() => setBankDates(s.db, s.bank, [{ ref: `v:${a}`, bank_date: 'junk' }]), /Bank date/);
});

test('opening BRS and recon beginning date', async () => {
  const s = await setup();
  await s.pay('2026-04-02', 100_00);
  await s.pay('2026-04-12', 300_00);
  await saveOpeningBrs(s.db, s.bank, [{ date: '2026-03-29', particulars: 'Staff', withdrawal: 5_000_00 }], '2026-04-10');
  const un = await unreconciledTxns(s.db, s.bank, '2026-04-30');
  assert.deepEqual(un.map((t) => t.vch_type), ['Opening BRS', 'Payment']);
  const dep = await unreconciledTxns(s.db, s.bank, '2026-04-30', { kind: 'deposits' });
  assert.equal(dep.length, 0);
  await assert.rejects(() => saveOpeningBrs(s.db, s.bank, [{ date: '2026-04-15', particulars: 'x', withdrawal: 1 }], '2026-04-10'), /before/);
});

test('imported bank data views', async () => {
  const s = await setup();
  await importStatementCsv(s.db, s.bank, 'Date,Narration,Withdrawal,Deposit,Balance\n01/04/2026,A,100,,900\n01/04/2026,B,,50,950\n03/05/2026,C,10,,940\n');
  const d = await importedBankData(s.db, s.bank, '2026-04-01', '2026-04-03', 'daily');
  assert.deepEqual(d.rows.map((r) => r.key), ['2026-04-03', '2026-04-02', '2026-04-01']);
  assert.equal(d.rows[2].dep_count, 1);
  assert.equal(d.rows[1].closing, 95_000);
  const m = await importedBankData(s.db, s.bank, '2026-04-01', '2026-05-31', 'monthly');
  assert.deepEqual(m.rows.map((r) => r.key), ['2026-04', '2026-05']);
  assert.equal(m.total.wd_amount, 110_00);
  assert.equal(m.total.wd_count, 2);
});

test('post-dated cheques', async () => {
  const s = await setup();
  const now = await s.pay('2026-04-02', 100_00);
  await saveBankAlloc(s.db, { voucher_id: now, ledger_id: s.bank, inst_no: '1' });
  const pd = await s.pay('2026-06-15', 4_000_00);
  await saveBankAlloc(s.db, { voucher_id: pd, ledger_id: s.bank, inst_no: '2', inst_date: '2026-06-15', post_dated: true, pdc_issue_date: '2026-04-02', pdc_note: 'Rent' });
  const rc = await s.rec('2026-07-01', 9_000_00);
  await saveBankAlloc(s.db, { voucher_id: rc, ledger_id: s.bank, inst_no: '3', post_dated: true });
  const list = await postDatedList(s.db, s.bank, '2026-04-01', '2027-03-31');
  assert.deepEqual(list.map((r) => [r.type, r.status]), [['Issued', 'Pending'], ['Received', 'Pending']]);
  assert.equal((await postDatedList(s.db, s.bank, '2026-04-01', '2027-03-31', 'Received')).length, 1);
  const sm = await postDatedSummary(s.db, s.bank, '2026-04-01', '2027-03-31');
  assert.equal(sm.rows.length, 12);
  assert.deepEqual(sm.rows[2].issued, { count: 1, amount: 4_000_00 });
  assert.deepEqual(sm.total.received, { count: 1, amount: 9_000_00 });
  const before = await unreconciledTxns(s.db, s.bank, '2026-12-31');
  assert.equal(before.length, 1);
  const withPd = await unreconciledTxns(s.db, s.bank, '2026-12-31', { includePostDated: true });
  assert.equal(withPd.length, 3);
  const bal = await reconSummary(s.db, s.bank, '2026-12-31');
  assert.equal(bal.books_balance, 100_000_00 - 100_00);
});
