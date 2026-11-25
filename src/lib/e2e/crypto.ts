// End-to-end envelopes of the public Signer.
// Ed25519 (sender signature) + X25519 (ephemeral per envelope) + HKDF-SHA256 + AES-256-GCM (WebCrypto).
// Must reproduce test/fixtures/e2e-vectors.json byte for byte (test/e2e-crypto.test.ts).
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base64ToBytes, bytesToBase64Url, concatBytes, fromUtf8, randomBytes, utf8 } from '../bytes';

export const E2E_V = 'daa-e2e-1';
export const MAX_CT = 65_536;

export const b64u = bytesToBase64Url;
export function unb64u(s: string): Uint8Array {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('E2E_BAD_ENVELOPE: base64url');
  const p = s.replace(/-/g, '+').replace(/_/g, '/');
  return base64ToBytes(p + '='.repeat((4 - (p.length % 4)) % 4));
}

export interface Envelope {
  v: string; id: string; wallet_id: string; from: string; to: string; at: string;
  epk: string; rk: string; n: string; ct: string; sig: string;
}
export interface KeyPair { sig_priv: Uint8Array; kex_priv: Uint8Array; sig: Uint8Array; kex: Uint8Array }
export interface PubKeys { sig: Uint8Array; kex: Uint8Array }

export const x25519Pub = (priv: Uint8Array) => x25519.getPublicKey(priv);
export const ed25519Pub = (priv: Uint8Array) => ed25519.getPublicKey(priv);

export function generateKeys(): KeyPair {
  const sig_priv = randomBytes(32), kex_priv = randomBytes(32);
  return { sig_priv, kex_priv, sig: ed25519Pub(sig_priv), kex: x25519Pub(kex_priv) };
}
export function keysFromPriv(sig_priv: Uint8Array, kex_priv: Uint8Array): KeyPair {
  return { sig_priv, kex_priv, sig: ed25519Pub(sig_priv), kex: x25519Pub(kex_priv) };
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** base32(sha256("daa-fp-1\n" ‖ sig ‖ kex)[0:15]) in 6 groups of 4. */
export function fingerprint(sig: Uint8Array, kex: Uint8Array): string {
  const h = sha256(concatBytes(utf8('daa-fp-1\n'), sig, kex)).subarray(0, 15);
  let bits = 0, val = 0, out = '';
  for (const byte of h) { val = ((val << 8) | byte) & 0xffff; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  return out.match(/.{4}/g)!.join('-');
}
export const keyId = (kex: Uint8Array): string => b64u(sha256(kex).subarray(0, 8));
export const bundleOf = (k: PubKeys): string => `${b64u(k.sig)}.${b64u(k.kex)}`;
export function parseBundle(s: string): PubKeys {
  const m = /^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(String(s ?? '').trim());
  if (!m) throw new Error('E2E_BAD_KEY: bundle');
  return { sig: unb64u(m[1]), kex: unb64u(m[2]) };
}
export const fpOfBundle = (s: string): string => { const k = parseBundle(s); return fingerprint(k.sig, k.kex); };

type Header = Pick<Envelope, 'id' | 'wallet_id' | 'from' | 'to' | 'at' | 'epk' | 'rk'>;
export const aadOf = (h: Header): string => [E2E_V, h.id, h.wallet_id, h.from, h.to, h.at, h.epk, h.rk].join('\n');
export const sigMessage = (h: Header & { n: string }, ct: Uint8Array): string => `sig:${aadOf(h)}\n${h.n}\n${b64u(sha256(ct))}`;

function kdf(shared: Uint8Array, epk: Uint8Array, rcptKex: Uint8Array): Uint8Array {
  if (shared.every((x) => x === 0)) throw new Error('E2E_BAD_KEY: all-zero shared secret');
  return hkdf(sha256, shared, concatBytes(epk, rcptKex), utf8(`${E2E_V} aes-256-gcm key`), 32);
}

const subtle = () => globalThis.crypto.subtle;
const buf = (b: Uint8Array) => b.slice().buffer as ArrayBuffer;
async function gcm(op: 'encrypt' | 'decrypt', key: Uint8Array, nonce: Uint8Array, data: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  const k = await subtle().importKey('raw', buf(key), 'AES-GCM', false, [op]);
  const out = await subtle()[op]({ name: 'AES-GCM', iv: buf(nonce), additionalData: buf(aad), tagLength: 128 }, k, buf(data));
  return new Uint8Array(out);
}

export const nowAt = (d = new Date()): string => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
export const newEnvelopeId = (): string => `env_${b64u(randomBytes(16))}`;

export interface SealArgs {
  id?: string; wallet_id: string; from: string; to: string; at?: string; payload: unknown;
  senderSigPriv: Uint8Array; recipientKex: Uint8Array;
  /** vectors only: fixed ephemeral key and nonce */
  eph?: Uint8Array; nonce?: Uint8Array;
}

export async function seal(a: SealArgs): Promise<Envelope> {
  const eph = a.eph ?? randomBytes(32), nonce = a.nonce ?? randomBytes(12);
  const epk = x25519Pub(eph);
  const h = { id: a.id ?? newEnvelopeId(), wallet_id: a.wallet_id, from: a.from, to: a.to, at: a.at ?? nowAt(), epk: b64u(epk), rk: keyId(a.recipientKex), n: b64u(nonce) };
  const key = kdf(x25519.getSharedSecret(eph, a.recipientKex), epk, a.recipientKex);
  const ct = await gcm('encrypt', key, nonce, utf8(JSON.stringify(a.payload)), utf8(aadOf(h)));
  if (ct.length > MAX_CT) throw new Error('E2E_TOO_LARGE');
  const sig = ed25519.sign(utf8(sigMessage(h, ct)), a.senderSigPriv);
  return { v: E2E_V, ...h, ct: b64u(ct), sig: b64u(sig) };
}

const FIELDS: (keyof Envelope)[] = ['v', 'id', 'wallet_id', 'from', 'to', 'at', 'epk', 'rk', 'n', 'ct', 'sig'];
/**
 * 0.3.3: hard sizes on receipt — before anything is stored (replay set, inbox) or answered. Keys, nonce and
 * signature have exact base64url lengths; ids and names are short; the ciphertext is at most MAX_CT bytes.
 */
const B64U = /^[A-Za-z0-9_-]+$/;
const ID_RX = /^[A-Za-z0-9_.:-]{1,64}$/;
const EXACT: Partial<Record<keyof Envelope, number>> = { epk: 43, rk: 11, n: 16, sig: 86 };
export const MAX_CT_B64 = Math.ceil((MAX_CT * 4) / 3) + 4;
export function checkShape(e: any): asserts e is Envelope {
  if (!e || typeof e !== 'object') throw new Error('E2E_BAD_ENVELOPE');
  for (const f of FIELDS) if (typeof e[f] !== 'string' || !e[f]) throw new Error(`E2E_BAD_ENVELOPE: ${f}`);
  if (e.v !== E2E_V) throw new Error('E2E_VERSION');
  for (const f of ['id', 'wallet_id', 'from', 'to'] as const) if (!ID_RX.test(e[f])) throw new Error(`E2E_BAD_ENVELOPE: ${f}`);
  if (e.at.length > 32) throw new Error('E2E_BAD_ENVELOPE: at');
  for (const [f, n] of Object.entries(EXACT)) if (e[f].length !== n || !B64U.test(e[f])) throw new Error(`E2E_BAD_ENVELOPE: ${f}`);
  if (e.ct.length > MAX_CT_B64 || !B64U.test(e.ct)) throw new Error('E2E_BAD_ENVELOPE: ct');
}

/** The sender's signature over header + nonce + sha256(ct) — checked before anything is decrypted. */
export function verifyEnvelope(e: Envelope, senderSig: Uint8Array): boolean {
  try {
    checkShape(e);
    return ed25519.verify(unb64u(e.sig), utf8(sigMessage(e, unb64u(e.ct))), senderSig);
  } catch { return false; }
}

/** Decrypt without the signature check (pairing: the key to check with is inside). Throws on any mismatch. */
export async function decrypt(e: Envelope, recipientKexPriv: Uint8Array): Promise<any> {
  checkShape(e);
  const rk = x25519Pub(recipientKexPriv);
  if (e.rk !== keyId(rk)) throw new Error('E2E_WRONG_KEY');
  const epk = unb64u(e.epk);
  if (epk.length !== 32) throw new Error('E2E_BAD_ENVELOPE: epk');
  const key = kdf(x25519.getSharedSecret(recipientKexPriv, epk), epk, rk);
  let pt: Uint8Array;
  try { pt = await gcm('decrypt', key, unb64u(e.n), unb64u(e.ct), utf8(aadOf(e))); } catch { throw new Error('E2E_DECRYPT_FAILED'); }
  return JSON.parse(fromUtf8(pt));
}

/** verify (sender key) + decrypt (our key). */
export async function open(e: Envelope, senderSig: Uint8Array, recipientKexPriv: Uint8Array): Promise<any> {
  if (!verifyEnvelope(e, senderSig)) throw new Error('E2E_BAD_SIGNATURE');
  return decrypt(e, recipientKexPriv);
}

/** Pairing proof: HMAC-SHA256(code, "daa-pair-1\n" + wallet_id + agent_id + sig + kex + wallet_fp, LF-joined). */
export function pairProof(codeB64u: string, p: { wallet_id: string; agent_id: string; sig: string; kex: string; wallet_fp: string }): string {
  return b64u(hmac(sha256, unb64u(codeB64u), utf8(['daa-pair-1', p.wallet_id, p.agent_id, p.sig, p.kex, p.wallet_fp].join('\n'))));
}
/** Constant-time string compare (proofs). */
export function sameString(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
export const newPairCode = (): string => b64u(randomBytes(16));
