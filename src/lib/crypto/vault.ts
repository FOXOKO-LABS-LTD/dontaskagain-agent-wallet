// Password vault: PBKDF2-SHA256(password, salt 16 B, 600 000 iterations) → AES-256-GCM (WebCrypto).
// On disk only {ciphertext, iv, salt, kdf params}. The plaintext is JSON (phrase, imported keys, rules, book…).
import { base64ToBytes, bytesToBase64, randomBytes, utf8, fromUtf8 } from '../bytes';

export const KDF_ITERATIONS = 600_000;
export { MIN_PASSWORD } from './password';
import { MIN_PASSWORD } from './password';

export interface EncryptedBlob {
  v: 1;
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string };
  cipher: { name: 'AES-GCM'; iv: string };
  ct: string;
}

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', utf8(password) as BufferSource, 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptJSON(password: string, data: unknown, iterations = KDF_ITERATIONS): Promise<EncryptedBlob> {
  if (password.length < MIN_PASSWORD) throw new Error('PASSWORD_TOO_SHORT');
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(password, salt, iterations);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, utf8(JSON.stringify(data)) as BufferSource));
  return { v: 1, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: bytesToBase64(salt) }, cipher: { name: 'AES-GCM', iv: bytesToBase64(iv) }, ct: bytesToBase64(ct) };
}

/** Throws BAD_PASSWORD on a wrong password or a tampered blob (GCM tag). */
export async function decryptJSON<T>(password: string, blob: EncryptedBlob): Promise<T> {
  if (blob.v !== 1 || blob.kdf.name !== 'PBKDF2' || blob.cipher.name !== 'AES-GCM') throw new Error('UNSUPPORTED_VAULT');
  if (blob.kdf.iterations < KDF_ITERATIONS) throw new Error('WEAK_KDF');
  const key = await deriveKey(password, base64ToBytes(blob.kdf.salt), blob.kdf.iterations);
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(blob.cipher.iv) as BufferSource }, key, base64ToBytes(blob.ct) as BufferSource);
    return JSON.parse(fromUtf8(new Uint8Array(pt))) as T;
  } catch {
    throw new Error('BAD_PASSWORD');
  }
}

// ---- re-encryption without the password (changes in an unlocked wallet need no password) ----
// At unlock the AES key is derived once (extractable) and kept, as raw bytes, only in chrome.storage.session next to the
// decrypted material; every later save encrypts with it under the same salt and a fresh IV.

async function deriveRawKey(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey('raw', utf8(password) as BufferSource, 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, base, 256));
}

const aesKey = (raw: Uint8Array) => crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);

/** New vault: returns the blob and the raw key to keep in the session. */
export async function createVault(password: string, data: unknown): Promise<{ blob: EncryptedBlob; rawKey: Uint8Array }> {
  if (password.length < MIN_PASSWORD) throw new Error('PASSWORD_TOO_SHORT');
  const salt = randomBytes(16);
  const rawKey = await deriveRawKey(password, salt, KDF_ITERATIONS);
  const blob = await encryptWithRawKey(rawKey, { iterations: KDF_ITERATIONS, salt: bytesToBase64(salt) }, data);
  return { blob, rawKey };
}

export async function unlockVault<T>(password: string, blob: EncryptedBlob): Promise<{ data: T; rawKey: Uint8Array }> {
  if (blob.v !== 1 || blob.kdf.name !== 'PBKDF2' || blob.cipher.name !== 'AES-GCM') throw new Error('UNSUPPORTED_VAULT');
  if (blob.kdf.iterations < KDF_ITERATIONS) throw new Error('WEAK_KDF');
  const rawKey = await deriveRawKey(password, base64ToBytes(blob.kdf.salt), blob.kdf.iterations);
  return { data: await decryptWithRawKey<T>(rawKey, blob), rawKey };
}

export async function encryptWithRawKey(rawKey: Uint8Array, kdf: { iterations: number; salt: string }, data: unknown): Promise<EncryptedBlob> {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, await aesKey(rawKey), utf8(JSON.stringify(data)) as BufferSource));
  return { v: 1, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: kdf.iterations, salt: kdf.salt }, cipher: { name: 'AES-GCM', iv: bytesToBase64(iv) }, ct: bytesToBase64(ct) };
}

export async function decryptWithRawKey<T>(rawKey: Uint8Array, blob: EncryptedBlob): Promise<T> {
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(blob.cipher.iv) as BufferSource }, await aesKey(rawKey), base64ToBytes(blob.ct) as BufferSource);
    return JSON.parse(fromUtf8(new Uint8Array(pt))) as T;
  } catch {
    throw new Error('BAD_PASSWORD');
  }
}
