import test from 'node:test';
import assert from 'node:assert/strict';
import { nodeDb } from '../src/node-adapter.ts';
import { Books } from '../src/books.ts';
import { backupNeedsPassword, createBackup, createVaultBackup, restoreBackup } from '../src/backup.ts';
import {
  VAULT_ITERATIONS,
  b64ToBytes,
  bytesToB64,
  decryptBackup,
  decryptBytes,
  deriveVaultKey,
  encryptBackup,
  encryptBytes,
  isEncryptedBackup,
  openWithKey,
  sealWithKey,
} from '../src/vault.ts';

const sample = {
  format: 'tallybook-backup' as const,
  version: 1 as const,
  created: '2026-11-03T00:00:00.000Z',
  tables: { company: [{ id: 1, name: 'Secret Traders' }], ledgers: [{ id: 7, name: 'Cash', opening: 1234.5 }] },
};

test('uses at least 200k pbkdf2 iterations by default', () => {
  assert.ok(VAULT_ITERATIONS >= 200_000);
});

test('base64 round trips large byte arrays', () => {
  const bytes = new Uint8Array(200_000).map((_, i) => (i * 31) & 0xff);
  assert.deepEqual(b64ToBytes(bytesToB64(bytes)), bytes);
});

test('backup envelope encrypts and decrypts with the vault password', async () => {
  const env = await encryptBackup(sample, 'correct horse');
  assert.equal(env.format, 'tallybook-backup-encrypted');
  assert.equal(env.version, 1);
  assert.equal(env.kdf, 'pbkdf2-sha256');
  assert.ok(env.iterations >= 200_000);
  assert.equal(b64ToBytes(env.salt).length, 16);
  assert.equal(b64ToBytes(env.iv).length, 12);
  assert.ok(isEncryptedBackup(env));
  const text = JSON.stringify(env);
  assert.ok(!text.includes('Secret Traders'));
  assert.ok(!text.includes('Cash'));
  assert.deepEqual(await decryptBackup(JSON.parse(text), 'correct horse'), sample);
});

test('each envelope uses a fresh salt and iv', async () => {
  const a = await encryptBackup(sample, 'pw-one-two');
  const b = await encryptBackup(sample, 'pw-one-two');
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.data, b.data);
});

test('wrong password fails to decrypt the backup', async () => {
  const env = await encryptBackup(sample, 'right-password');
  await assert.rejects(decryptBackup(env, 'wrong-password'), /Incorrect TallyVault password/);
});

test('tampered ciphertext is rejected', async () => {
  const env = await encryptBackup(sample, 'right-password');
  const data = b64ToBytes(env.data);
  data[5] ^= 1;
  await assert.rejects(decryptBackup({ ...env, data: bytesToB64(data) }, 'right-password'), /Incorrect TallyVault password/);
});

test('rejects weakened or unknown envelopes', async () => {
  const env = await encryptBackup(sample, 'right-password');
  await assert.rejects(decryptBackup({ ...env, iterations: 1000 }, 'right-password'), /Unsupported/);
  await assert.rejects(decryptBackup({ ...env, version: 2 }, 'right-password'), /Unsupported/);
  await assert.rejects(decryptBackup(sample, 'right-password'), /not an encrypted/);
});

test('byte sealing round trips and rejects the wrong password', async () => {
  const bytes = new TextEncoder().encode('SQLite format 3\0 company data');
  const sealed = await encryptBytes('vault-pass', bytes);
  assert.deepEqual(await decryptBytes('vault-pass', sealed), bytes);
  await assert.rejects(decryptBytes('vault-pas', sealed), /Incorrect TallyVault password/);
  const key = await deriveVaultKey('vault-pass', sealed.salt, sealed.iterations);
  const again = await sealWithKey(key, bytes);
  assert.deepEqual(await openWithKey(key, again.iv, again.data), bytes);
});

test('empty password is refused', async () => {
  await assert.rejects(encryptBackup(sample, ''), /required/);
});

test('encrypted company backup restores only with the password', async () => {
  const src = nodeDb();
  const books = new Books(src);
  await books.init();
  await books.createCompany({ name: 'Vault Co', fy_start: '2026-04-01' });
  const plain = await createBackup(src);
  const env = await createVaultBackup(src, 'company-vault');
  assert.ok(backupNeedsPassword(env));
  assert.ok(!backupNeedsPassword(plain));
  assert.ok(!JSON.stringify(env).includes('Vault Co'));
  const dst = nodeDb();
  await new Books(dst).init();
  await assert.rejects(restoreBackup(dst, env), /protected by a TallyVault password/);
  await assert.rejects(restoreBackup(dst, env, 'nope'), /Incorrect TallyVault password/);
  const r = await restoreBackup(dst, env, 'company-vault');
  assert.ok(r.rows > 0);
  const rows = await dst.select<{ name: string }>('SELECT name FROM company');
  assert.equal(rows[0].name, 'Vault Co');
});
