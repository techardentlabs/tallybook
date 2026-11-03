import test from 'node:test';
import assert from 'node:assert/strict';
import { Books } from '../src/index.ts';
import { nodeDb } from '../src/node-adapter.ts';
import {
  ACCESS_DENIED,
  SECURITY_FACILITIES,
  accessNamesFor,
  backDatedMessage,
  can,
  canEnterOn,
  canVoucher,
  enableSecurity,
  ensureSecurity,
  guardBooks,
  idleLockMinutes,
  menuActions,
  removeUser,
  saveSecurityLevel,
  saveUser,
  screenActions,
  securityControl,
  builtinLevels,
  securityUsers,
  setCurrentUser,
  voucherFacilities,
} from '../src/security.ts';

async function secured() {
  const books = new Books(nodeDb());
  await books.init();
  await ensureSecurity(books.db);
  await ensureSecurity(books.db);
  await books.createCompany({ name: 'Secure Traders', fy_start: '2026-04-01' });
  const owner = await enableSecurity(books.db, { username: 'admin', password: 'pw' });
  return { books, owner };
}

const user = async (db: Books['db'], name: string) => (await securityUsers(db)).find((u) => u.username === name)!;

test('facility list covers Tally masters, vouchers, reports and utilities', () => {
  assert.ok(SECURITY_FACILITIES.length >= 85);
  for (const f of ['Accounts Masters', 'Inventory Masters', 'Payroll Masters', 'Vouchers', 'Accounting Vouchers', 'Inventory Vouchers', 'Order Vouchers', 'Payroll Vouchers', 'Back Dated Vouchers', 'Balance Sheet', 'Profit & Loss A/c', 'Trial Balance', 'Day Book', 'Audit Listings', 'Edit Log', 'GST Reports', 'TDS Reports', 'Backup', 'Restore', 'Import', 'Export', 'Split Company Data', 'Company Alteration', 'Company Features', 'Configuration', 'Security Control']) {
    assert.ok(SECURITY_FACILITIES.includes(f), f);
  }
  assert.equal(new Set(SECURITY_FACILITIES).size, SECURITY_FACILITIES.length);
  assert.deepEqual(accessNamesFor('Backup'), ['Full Access', 'Display']);
  assert.ok(accessNamesFor('Vouchers').includes('Create/Alter'));
  assert.ok(accessNamesFor('Balance Sheet').includes('Print'));
});

test('role defaults match Tally: owner reserved facilities, data entry and auditor', () => {
  const rows = securityControl(builtinLevels());
  const get = (f: string, role: string) => rows.find((r) => r.facility === f)!.access[role];
  assert.equal(get('Audit Listings', 'Owner'), 'None');
  assert.equal(get('Company Alteration', 'Owner'), 'None');
  assert.equal(get('Edit Log', 'Owner'), 'Full Access');
  assert.equal(get('Day Book', 'Data Entry'), 'Display/Print');
  assert.equal(get('Balance Sheet', 'Data Entry'), 'None');
  assert.equal(get('Back Dated Vouchers', 'Data Entry'), 'None');
  assert.equal(get('Order Vouchers', 'Data Entry'), 'Create/Alter');
  assert.equal(get('Backup', 'Data Entry'), 'None');
  assert.equal(get('Audit Listings', 'Tally.NET Auditor'), 'Full Access');
  assert.equal(get('Company Features', 'Tally.NET Auditor'), 'None');
});

test('administrator keeps reserved facilities; other owners do not', async () => {
  const { books, owner } = await secured();
  assert.ok(owner.administrator);
  assert.ok(can(owner, 'Company Alteration.alter'));
  assert.ok(can(owner, 'Audit Listings.display'));
  const partner = await saveUser(books.db, { username: 'Partner', role: 'Owner', password: 'p' });
  assert.ok(!partner.administrator);
  assert.ok(!can(partner, 'Company Alteration.alter'));
  assert.ok(can(partner, 'Balance Sheet.print'));
  await removeUser(books.db, 'Partner');
  await assert.rejects(removeUser(books.db, 'admin'), /last Owner|Administrator/);
});

test('voucher type security: disallow Vouchers, allow Receipt and Sales only', async () => {
  const { books } = await secured();
  await saveUser(books.db, { username: 'Arun', role: 'Data Entry', password: 'a', level: { disallow: { Vouchers: 'Full Access' }, allow: { Receipt: 'Full Access', Sales: 'Create' } } });
  const arun = await user(books.db, 'Arun');
  assert.ok(can(arun, 'Receipt.create'));
  assert.ok(can(arun, 'Receipt.delete'));
  assert.ok(can(arun, 'Sales.create'));
  assert.ok(!can(arun, 'Sales.alter'));
  assert.ok(!can(arun, 'Payment.create'));
  assert.ok(!can(arun, 'Accounting Vouchers.create'));
  assert.ok(canVoucher(arun, 'Tax Invoice', 'Sales', 'create'));
  assert.ok(!canVoucher(arun, 'Cash Payment', 'Payment', 'create'));
  assert.deepEqual(voucherFacilities('Sales Order'), ['Vouchers', 'Order Vouchers', 'Sales Order']);
  assert.deepEqual(voucherFacilities('Tax Invoice', 'Sales'), ['Vouchers', 'Accounting Vouchers', 'Sales', 'Tax Invoice']);
});

test('typed disallow removes only the named rights', async () => {
  const { books } = await secured();
  await saveSecurityLevel(books.db, { name: 'Clerks', basis: 'Owner', disallow: { Vouchers: 'Create' } });
  await saveUser(books.db, { username: 'Mona', role: 'Owner', password: 'm', level: { disallow: { Vouchers: 'Create', 'Balance Sheet': 'Print' }, allow: {} } });
  const mona = await user(books.db, 'Mona');
  assert.ok(!can(mona, 'Payment.create'));
  assert.ok(can(mona, 'Payment.alter'));
  assert.ok(can(mona, 'Balance Sheet.display'));
  assert.ok(!can(mona, 'Balance Sheet.print'));
  await saveUser(books.db, { username: 'Old', role: 'Data Entry', password: 'o', level: { disallow: ['Day Book'] } });
  assert.ok(!can(await user(books.db, 'Old'), 'Day Book.display'));
  await assert.rejects(saveSecurityLevel(books.db, { name: 'Bad', basis: 'Owner', allow: { Vouchers: 'Everything' as never } }), /Type of Access/);
});

test('back dated limits count from the date of last entry and respect cut-off', async () => {
  const { books } = await secured();
  await saveUser(books.db, { username: 'Ravi', role: 'Data Entry', password: 'r', level: { days_back: 3 } });
  const ravi = await user(books.db, 'Ravi');
  assert.ok(canEnterOn(ravi, '2026-06-07', '2026-06-20', '2026-06-10'));
  assert.ok(!canEnterOn(ravi, '2026-06-06', '2026-06-20', '2026-06-10'));
  assert.ok(canEnterOn(ravi, '2026-06-15', '2026-06-20', '2026-06-10'));
  assert.ok(!canEnterOn(ravi, '2026-06-06', '2026-06-20', '2026-06-10', 'alter'));
  assert.match(backDatedMessage(ravi, '2026-06-01', '2026-06-20', '2026-06-10')!, /No Access Allowed! Back dated vouchers before 07-Jun-2026|No Access Allowed! Back dated vouchers before/);
  await saveUser(books.db, { username: 'Cut', role: 'Data Entry', password: 'c', level: { cutoff_date: '2026-06-01' } });
  const cut = await user(books.db, 'Cut');
  assert.ok(canEnterOn(cut, '2026-06-01', '2026-06-20'));
  assert.ok(!canEnterOn(cut, '2026-05-31', '2026-06-20'));
  await saveUser(books.db, { username: 'View', role: 'Data Entry', password: 'v', level: { days_back: 0, allow: { 'Back Dated Vouchers': 'Display/Print' } } });
  assert.ok(!canEnterOn(await user(books.db, 'View'), '2026-06-19', '2026-06-20'));
  await saveUser(books.db, { username: 'Free', role: 'Data Entry', password: 'f', level: { allow: { 'Back Dated Vouchers': 'Create/Alter' } } });
  assert.ok(canEnterOn(await user(books.db, 'Free'), '2026-04-02', '2026-06-20'));
});

test('idle auto lock settings', async () => {
  const { books } = await secured();
  await assert.rejects(saveUser(books.db, { username: 'Idle', role: 'Data Entry', password: 'i', level: { shut_on_idle: true, idle_minutes: 0 } }), /auto lock/);
  await saveUser(books.db, { username: 'Idle', role: 'Data Entry', password: 'i', level: { shut_on_idle: true, idle_minutes: 5 } });
  const idle = await user(books.db, 'Idle');
  assert.equal(idleLockMinutes(idle), 5);
  assert.equal(idle.level.shut_on_idle, true);
  await saveUser(books.db, { username: 'Idle', role: 'Data Entry', level: { shut_on_idle: false, idle_minutes: 5 } });
  assert.equal(idleLockMinutes(await user(books.db, 'Idle')), null);
});

test('guarded books reject denied changes before they reach the audit log', async () => {
  const { books } = await secured();
  guardBooks(books);
  guardBooks(books);
  const groups = await books.groups();
  const g = (n: string) => groups.find((x) => x.name === n)!.id;
  const types = await books.voucherTypes();
  const ty = (n: string) => types.find((x) => x.name === n)!.id;
  const cust = (await books.createLedger({ name: 'Cust', group_id: g('Sundry Debtors') })).id;
  const sales = (await books.createLedger({ name: 'Sales', group_id: g('Sales Accounts') })).id;
  const e = [{ ledger_id: cust, amount: 100 }, { ledger_id: sales, amount: -100 }];
  const first = await books.createVoucher({ type_id: ty('Sales'), date: '2026-06-10', entries: e });
  const audits = async () => (await books.db.select<{ n: number }>('SELECT COUNT(*) AS n FROM audit_log'))[0].n;
  const before = await audits();

  await saveUser(books.db, { username: 'Arun', role: 'Data Entry', password: 'a', level: { days_back: 2, disallow: { Payment: 'Full Access' } } });
  setCurrentUser(await user(books.db, 'Arun'));
  try {
    await assert.rejects(books.createLedger({ name: 'Nope', group_id: g('Sundry Debtors') }), new RegExp(ACCESS_DENIED));
    await assert.rejects(books.createVoucher({ type_id: ty('Payment'), date: '2026-06-10', entries: e }), /No Access Allowed/);
    await assert.rejects(books.createVoucher({ type_id: ty('Sales'), date: '2026-06-01', entries: e }), /Back dated/);
    await assert.rejects(books.deleteVoucher(first.id), /No Access Allowed/);
    assert.equal(await audits(), before);
    await books.createVoucher({ type_id: ty('Sales'), date: '2026-06-09', entries: e });
    assert.equal(await audits(), before + 1);
    const rows = await books.db.select<{ username: string }>('SELECT username FROM audit_log ORDER BY id DESC LIMIT 1');
    assert.equal(rows.length, 1);
  } finally {
    setCurrentUser(null);
  }
  await books.createLedger({ name: 'Free', group_id: g('Sundry Debtors') });
});

test('screen and menu titles map to Tally facilities', () => {
  assert.deepEqual(screenActions('Balance Sheet'), ['Balance Sheet.display']);
  assert.deepEqual(screenActions('Ledger Creation'), ['Accounts Masters.create']);
  assert.deepEqual(screenActions('Stock Item Alteration'), ['Inventory Masters.alter']);
  assert.deepEqual(screenActions('Pay Head Creation'), ['Payroll Masters.create']);
  assert.deepEqual(screenActions('Sales Register'), ['Sales Register.display']);
  assert.deepEqual(screenActions('Accounting Voucher Creation'), ['Accounting Vouchers.create']);
  assert.deepEqual(screenActions('GSTR-3B'), ['GST Reports.display']);
  assert.deepEqual(screenActions('Company Features'), ['Company Features.alter']);
  assert.deepEqual(screenActions('Edit Log'), ['Edit Log.display']);
  assert.deepEqual(screenActions('Export Data'), ['Export.create']);
  assert.deepEqual(screenActions('Print', ['Print', 'Balance Sheet']), ['Print.display', 'Balance Sheet.print']);
  assert.deepEqual(screenActions('Preview', ['Profit & Loss A/c']), ['Profit & Loss A/c.preview']);
  assert.equal(screenActions('Gateway of Tally'), null);
  assert.equal(screenActions('Company Creation'), null);
  assert.equal(screenActions('Change User'), null);
  assert.deepEqual(menuActions('Create', 'Ledger'), ['Accounts Masters.create']);
  assert.deepEqual(menuActions('Alter', 'Stock Item'), ['Inventory Masters.alter']);
  assert.deepEqual(menuActions('Create', 'Budget'), ['Budgets.create']);
  assert.deepEqual(menuActions('Gateway of Tally', 'Profit & Loss A/c'), ['Profit & Loss A/c.display']);
  assert.deepEqual(menuActions('Data', 'Backup'), ['Backup.create']);
  assert.deepEqual(menuActions('Company', 'Alter'), ['Company Alteration.alter']);
  assert.equal(menuActions('Gateway of Tally', 'Vouchers'), null);
  assert.equal(menuActions('Gateway of Tally', 'Create'), null);
});
