import test from 'node:test';
import assert from 'node:assert/strict';
import { nodeDb } from '../src/node-adapter.ts';
import {
  addCompanyRef, can, canEnterOn, changePassword, checkPasswordPolicy, editLog, editLogByUser, emptyCompanyList, enableSecurity, ensureSecurity, hashPassword,
  login, logEdit, passwordPolicy, removeUser, savePasswordPolicy, saveSecurityLevel, saveUser, securityControl, securityEnabled, securityLevels, securityUsers,
  selectCompanyRef, setCurrentUser, currentUser, canCurrent, clearLegacyVault, unlockVault, vaultEnabled, verifyPassword, DEFAULT_POLICY, builtinLevels,
} from '../src/security.ts';

async function setup() {
  const db = nodeDb();
  await ensureSecurity(db);
  await ensureSecurity(db);
  return db;
}

test('password hashing is salted and verifiable', async () => {
  const a = await hashPassword('secret', 1000);
  const b = await hashPassword('secret', 1000);
  assert.notEqual(a, b);
  assert.ok(await verifyPassword('secret', a));
  assert.ok(!(await verifyPassword('Secret', a)));
  assert.ok(!(await verifyPassword('secret', null)));
  assert.ok(!(await verifyPassword('secret', 'garbage')));
});

test('enable security creates owner and login works', async () => {
  const db = await setup();
  assert.equal(await securityEnabled(db), false);
  const owner = await enableSecurity(db, { username: 'admin', password: 'pw1' });
  assert.equal(owner.role, 'Owner');
  assert.equal(await securityEnabled(db), true);
  await assert.rejects(enableSecurity(db, { username: 'x', password: 'y' }), /already enabled/);
  const r = await login(db, 'admin', 'pw1');
  assert.equal(r.user.username, 'admin');
  assert.equal(r.must_change, false);
  await assert.rejects(login(db, 'admin', 'bad'), /Incorrect password/);
  await assert.rejects(login(db, 'ghost', 'pw1'), /does not exists/);
});

test('role permissions and security level overrides', async () => {
  const db = await setup();
  const owner = await enableSecurity(db, { username: 'admin', password: 'pw1' });
  const clerk = await saveUser(db, { username: 'Rajesh', role: 'Data Entry', password: 'pw2' });
  const auditor = await saveUser(db, { username: 'Anita', role: 'Tally.NET Auditor', password: 'pw3' });
  assert.ok(can(owner, 'Vouchers.delete'));
  assert.ok(can(owner, 'Balance Sheet.display'));
  assert.ok(can(clerk, 'Vouchers.create'));
  assert.ok(can(clerk, 'Vouchers.alter'));
  assert.ok(!can(clerk, 'Vouchers.delete'));
  assert.ok(!can(clerk, 'Balance Sheet.display'));
  assert.ok(!can(clerk, { facility: 'Accounts Masters', right: 'create' }));
  assert.ok(can(auditor, 'Balance Sheet.display'));
  assert.ok(!can(auditor, 'Vouchers.create'));
  assert.ok(can(null, 'Anything.delete'));

  await saveSecurityLevel(db, { name: 'Rajesh', basis: 'Data Entry', allow: { 'Balance Sheet': 'Display/Print' }, disallow: ['Vouchers'] });
  const users = await securityUsers(db);
  const raj = users.find((u) => u.username === 'Rajesh')!;
  assert.ok(can(raj, 'Balance Sheet.display'));
  assert.ok(!can(raj, 'Vouchers.create'));

  await saveSecurityLevel(db, { name: 'Rajesh', basis: 'Data Entry', disallow: ['Vouchers'], allow: { Vouchers: 'Display' } });
  const raj2 = (await securityUsers(db)).find((u) => u.username === 'Rajesh')!;
  assert.ok(can(raj2, 'Vouchers.display'));
  assert.ok(!can(raj2, 'Vouchers.create'));

  setCurrentUser(auditor);
  assert.equal(currentUser()?.username, 'Anita');
  assert.ok(!canCurrent('Vouchers.create'));
  setCurrentUser(null);
  assert.ok(canCurrent('Vouchers.create'));
});

test('inactive users cannot act or log in', async () => {
  const db = await setup();
  await enableSecurity(db, { username: 'admin', password: 'pw1' });
  const u = await saveUser(db, { username: 'Tmp', role: 'Data Entry', password: 'x1', active: false });
  assert.ok(!can(u, 'Vouchers.create'));
  await assert.rejects(login(db, 'Tmp', 'x1'), /inactive/);
});

test('back dated voucher entry limits', async () => {
  const db = await setup();
  await enableSecurity(db, { username: 'admin', password: 'pw1' });
  const u = await saveUser(db, { username: 'Rajesh', role: 'Data Entry', password: 'a', level: { days_back: 5 } });
  assert.ok(canEnterOn(u, '2026-06-10', '2026-06-10'));
  assert.ok(canEnterOn(u, '2026-06-05', '2026-06-10'));
  assert.ok(!canEnterOn(u, '2026-06-04', '2026-06-10'));
  const none = await saveUser(db, { username: 'Zero', role: 'Data Entry', password: 'a' });
  assert.ok(!canEnterOn(none, '2026-06-09', '2026-06-10'));
  const cut = await saveUser(db, { username: 'Cut', role: 'Data Entry', password: 'a', level: { days_back: 30, cutoff_date: '2026-06-08' } });
  assert.ok(canEnterOn(cut, '2026-06-08', '2026-06-10'));
  assert.ok(!canEnterOn(cut, '2026-06-07', '2026-06-10'));
  const owner = (await securityUsers(db)).find((x) => x.username === 'admin')!;
  assert.ok(canEnterOn(owner, '2020-01-01', '2026-06-10'));
});

test('password policy validation, expiry, first login change and old password reuse', async () => {
  const db = await setup();
  assert.deepEqual(await passwordPolicy(db), DEFAULT_POLICY);
  await enableSecurity(db, { username: 'admin', password: 'pw1', today: '2026-01-01' });
  await assert.rejects(savePasswordPolicy(db, { ...DEFAULT_POLICY, advanced: true, min_length: 4, min_alpha: 3, min_numeric: 2 }), /cannot exceed/);
  const policy = await savePasswordPolicy(db, {
    ...DEFAULT_POLICY,
    active: true,
    min_length: 6,
    advanced: true,
    min_alpha: 2,
    min_numeric: 2,
    min_special: 1,
    expires_days: 30,
    notify_expiry: true,
    restrict_old: true,
    change_on_first_login: true,
  });
  assert.ok(checkPasswordPolicy(policy, 'ab1'));
  assert.ok(checkPasswordPolicy(policy, 'abcdef'));
  assert.ok(checkPasswordPolicy(policy, 'ab12cd'));
  assert.equal(checkPasswordPolicy(policy, 'ab12#c'), null);
  await assert.rejects(saveUser(db, { username: 'Rajesh', role: 'Data Entry', password: 'weak' }), /at least 6/);
  await saveUser(db, { username: 'Rajesh', role: 'Data Entry', password: 'ab12#c', today: '2026-02-01' });
  const first = await login(db, 'Rajesh', 'ab12#c', '2026-02-02');
  assert.equal(first.must_change, true);
  assert.equal(first.expires_in_days, 29);
  await assert.rejects(changePassword(db, 'Rajesh', 'wrong', 'zz99#y', { today: '2026-02-02' }), /Incorrect old password/);
  await assert.rejects(changePassword(db, 'Rajesh', 'ab12#c', 'ab12#c', { today: '2026-02-02' }), /used earlier/);
  await changePassword(db, 'Rajesh', 'ab12#c', 'zz99#y', { today: '2026-02-02' });
  await assert.rejects(changePassword(db, 'Rajesh', 'zz99#y', 'ab12#c', { today: '2026-02-03' }), /used earlier/);
  const ok = await login(db, 'Rajesh', 'zz99#y', '2026-02-10');
  assert.equal(ok.must_change, false);
  const late = await login(db, 'Rajesh', 'zz99#y', '2026-03-10');
  assert.equal(late.expired, true);
  assert.equal(late.must_change, true);
  const admin = await login(db, 'admin', 'pw1', '2026-12-01');
  assert.equal(admin.expired, false);
});

test('users can be blocked from changing their own password', async () => {
  const db = await setup();
  await enableSecurity(db, { username: 'admin', password: 'pw1' });
  await saveUser(db, { username: 'Rajesh', role: 'Data Entry', password: 'a' });
  await savePasswordPolicy(db, { ...DEFAULT_POLICY, active: true, min_length: 1, allow_change: false });
  await assert.rejects(changePassword(db, 'Rajesh', 'a', 'b'), /not allowed/);
  const owner = (await securityUsers(db)).find((u) => u.username === 'admin')!;
  await changePassword(db, 'Rajesh', 'a', 'b', { actor: owner });
});

test('remove user and keep last owner', async () => {
  const db = await setup();
  await enableSecurity(db, { username: 'admin', password: 'pw1' });
  await saveUser(db, { username: 'Rajesh', role: 'Data Entry', password: 'a' });
  assert.equal((await securityLevels(db)).length, 2);
  await removeUser(db, 'Rajesh');
  assert.equal((await securityUsers(db)).length, 1);
  assert.equal((await securityLevels(db)).length, 1);
  await assert.rejects(removeUser(db, 'admin'), /last Owner/);
  await assert.rejects(removeUser(db, 'nobody'), /not found/);
});

test('security control matrix lists role access per facility', () => {
  const rows = securityControl(builtinLevels());
  const vouchers = rows.find((r) => r.facility === 'Vouchers')!;
  assert.equal(vouchers.access['Owner'], 'Full Access');
  assert.equal(vouchers.access['Data Entry'], 'Create/Alter');
  assert.equal(vouchers.access['Tally.NET Auditor'], 'Display/Print');
  const bs = rows.find((r) => r.facility === 'Balance Sheet')!;
  assert.equal(bs.access['Data Entry'], 'None');
});

test('legacy tallyvault hash is checked and can be cleared', async () => {
  const db = await setup();
  assert.equal(await vaultEnabled(db), false);
  assert.ok(await unlockVault(db, ''));
  await db.batch([{ sql: "INSERT INTO security_settings (key, value) VALUES ('vault', ?)", params: [await hashPassword('vault1')] }]);
  assert.equal(await vaultEnabled(db), true);
  assert.ok(await unlockVault(db, 'vault1'));
  assert.ok(!(await unlockVault(db, 'nope')));
  await clearLegacyVault(db);
  assert.equal(await vaultEnabled(db), false);
});

test('edit log attributes changes to users', async () => {
  const db = await setup();
  const owner = await enableSecurity(db, { username: 'admin', password: 'pw1' });
  const clerk = await saveUser(db, { username: 'Rajesh', role: 'Data Entry', password: 'a' });
  await logEdit(db, clerk, { action: 'create', entity: 'voucher', entity_id: 5, detail: 'Sales 1', at: '2026-05-01T10:00:00.000Z' });
  await logEdit(db, clerk, { action: 'alter', entity: 'voucher', entity_id: 5, at: '2026-05-02T10:00:00.000Z' });
  await logEdit(db, owner, { action: 'delete', entity: 'ledger', entity_id: 9, at: '2026-05-03T10:00:00.000Z' });
  assert.equal((await editLog(db)).length, 3);
  assert.equal((await editLog(db))[0].action, 'delete');
  assert.equal((await editLog(db, { username: 'Rajesh' })).length, 2);
  assert.equal((await editLog(db, { entity: 'voucher', entity_id: 5 })).length, 2);
  assert.equal((await editLog(db, { from: '2026-05-02', to: '2026-05-02' })).length, 1);
  const by = await editLogByUser(db);
  assert.deepEqual(by.map((b) => [b.username, b.count]), [['Rajesh', 2], ['admin', 1]]);
});

test('company list select and add', () => {
  let l = emptyCompanyList();
  l = addCompanyRef(l, { id: 'a', name: 'Zed Co', path: '/a' });
  l = addCompanyRef(l, { id: 'b', name: 'Alpha Co', path: '/b' });
  assert.throws(() => addCompanyRef(l, { id: 'a', name: 'dup', path: '/x' }), /already/);
  l = selectCompanyRef(l, 'b', '2026-01-01T00:00:00Z');
  assert.equal(l.selected, 'b');
  assert.equal(l.companies.find((c) => c.id === 'b')!.last_opened, '2026-01-01T00:00:00Z');
  assert.throws(() => selectCompanyRef(l, 'zz'), /not in list/);
});
