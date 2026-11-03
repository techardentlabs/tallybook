import { CoreError } from './db.ts';
import type { BackupFile } from './backup.ts';

export const VAULT_ITERATIONS = 310_000;
export const VAULT_MIN_ITERATIONS = 200_000;
export const WRONG_VAULT_PASSWORD = 'Incorrect TallyVault password';

export interface SealedBytes {
  iterations: number;
  salt: Uint8Array;
  iv: Uint8Array;
  data: Uint8Array;
}

export interface EncryptedBackupFile {
  format: 'tallybook-backup-encrypted';
  version: 1;
  kdf: 'pbkdf2-sha256';
  iterations: number;
  salt: string;
  iv: string;
  data: string;
}

const BACKUP_AAD = new TextEncoder().encode('tallybook-backup-encrypted/1');

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new CoreError('invalid', 'Encryption is not available on this system');
  return s;
}

export function randomBytes(n: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

export function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function deriveVaultKey(password: string, salt: Uint8Array, iterations = VAULT_ITERATIONS): Promise<CryptoKey> {
  if (!password) throw new CoreError('invalid', 'TallyVault password is required');
  if (!Number.isInteger(iterations) || iterations < VAULT_MIN_ITERATIONS) throw new CoreError('invalid', 'Unsupported TallyVault key settings');
  const base = await subtle().importKey('raw', new TextEncoder().encode(password) as BufferSource, 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function sealWithKey(key: CryptoKey, bytes: Uint8Array, aad?: Uint8Array): Promise<{ iv: Uint8Array; data: Uint8Array }> {
  const iv = randomBytes(12);
  const params: AesGcmParams = { name: 'AES-GCM', iv: iv as BufferSource };
  if (aad) params.additionalData = aad as BufferSource;
  const data = new Uint8Array(await subtle().encrypt(params, key, bytes as BufferSource));
  return { iv, data };
}

export async function openWithKey(key: CryptoKey, iv: Uint8Array, data: Uint8Array, aad?: Uint8Array): Promise<Uint8Array> {
  const params: AesGcmParams = { name: 'AES-GCM', iv: iv as BufferSource };
  if (aad) params.additionalData = aad as BufferSource;
  try {
    return new Uint8Array(await subtle().decrypt(params, key, data as BufferSource));
  } catch {
    throw new CoreError('invalid', WRONG_VAULT_PASSWORD);
  }
}

export async function encryptBytes(password: string, bytes: Uint8Array, iterations = VAULT_ITERATIONS, aad?: Uint8Array): Promise<SealedBytes> {
  const salt = randomBytes(16);
  const key = await deriveVaultKey(password, salt, iterations);
  const { iv, data } = await sealWithKey(key, bytes, aad);
  return { iterations, salt, iv, data };
}

export async function decryptBytes(password: string, sealed: SealedBytes, aad?: Uint8Array): Promise<Uint8Array> {
  const key = await deriveVaultKey(password, sealed.salt, sealed.iterations);
  return openWithKey(key, sealed.iv, sealed.data, aad);
}

export function isEncryptedBackup(file: unknown): file is EncryptedBackupFile {
  return !!file && typeof file === 'object' && (file as { format?: unknown }).format === 'tallybook-backup-encrypted';
}

export async function encryptBackup(file: BackupFile, password: string, iterations = VAULT_ITERATIONS): Promise<EncryptedBackupFile> {
  const sealed = await encryptBytes(password, new TextEncoder().encode(JSON.stringify(file)), iterations, BACKUP_AAD);
  return {
    format: 'tallybook-backup-encrypted',
    version: 1,
    kdf: 'pbkdf2-sha256',
    iterations: sealed.iterations,
    salt: bytesToB64(sealed.salt),
    iv: bytesToB64(sealed.iv),
    data: bytesToB64(sealed.data),
  };
}

export async function decryptBackup(file: unknown, password: string): Promise<BackupFile> {
  if (!isEncryptedBackup(file)) throw new CoreError('invalid', 'This is not an encrypted TallyBook backup file');
  if (file.version !== 1 || file.kdf !== 'pbkdf2-sha256' || typeof file.salt !== 'string' || typeof file.iv !== 'string' || typeof file.data !== 'string') {
    throw new CoreError('invalid', 'Unsupported encrypted backup version');
  }
  let sealed: SealedBytes;
  try {
    sealed = { iterations: Number(file.iterations), salt: b64ToBytes(file.salt), iv: b64ToBytes(file.iv), data: b64ToBytes(file.data) };
  } catch {
    throw new CoreError('invalid', 'The encrypted backup file is damaged');
  }
  const plain = await decryptBytes(password, sealed, BACKUP_AAD);
  try {
    return JSON.parse(new TextDecoder().decode(plain)) as BackupFile;
  } catch {
    throw new CoreError('invalid', 'The encrypted backup file is damaged');
  }
}
