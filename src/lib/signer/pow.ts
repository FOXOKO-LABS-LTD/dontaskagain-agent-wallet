// Proof of work at wallet registration on a Signer. The sign-in
// challenge of a root pair that has no wallet there yet MAY carry `pow: {alg:"sha256", bits, salt, expires_at}`; the
// client finds a decimal `pow_nonce` with SHA-256(utf8(salt + ":" + challenge_nonce + ":" + pow_nonce)) having at least
// `bits` leading zero bits and sends it with verify. Synchronous pure-JS SHA-256 in chunks (WebCrypto per hash is ~10×
// slower), yielding between chunks so the service worker stays responsive.
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8 } from '../bytes';

/** More than this is hostile (2^26 ≈ 67 M hashes ≈ minutes): refused, never solved. */
export const POW_MAX_BITS = 26;
export interface PowTask { alg: 'sha256'; bits: number; salt: string; expires_at?: string }

/** Throws when the task must not be solved (unknown algorithm, too hard, malformed). */
export function checkPowTask(p: any): PowTask {
  if (!p || typeof p !== 'object' || p.alg !== 'sha256') throw new Error('POW_UNSUPPORTED: unknown proof-of-work algorithm');
  if (!Number.isInteger(p.bits) || p.bits < 1) throw new Error('POW_BAD: bits');
  if (p.bits > POW_MAX_BITS) throw new Error(`POW_TOO_HARD: the Signer asks for ${p.bits} bits (more than ${POW_MAX_BITS})`);
  if (typeof p.salt !== 'string' || !/^[0-9a-fA-F]{2,128}$/.test(p.salt)) throw new Error('POW_BAD: salt');
  if (p.expires_at !== undefined && (typeof p.expires_at !== 'string' || Number.isNaN(Date.parse(p.expires_at)))) throw new Error('POW_BAD: expires_at');
  return { alg: 'sha256', bits: p.bits, salt: p.salt, expires_at: p.expires_at };
}

export function leadingZeroBits(h: Uint8Array): number {
  let n = 0;
  for (const b of h) { if (b === 0) { n += 8; continue; } return n + Math.clz32(b) - 24; }
  return n;
}
const enough = (h: Uint8Array, bits: number) => {
  const full = bits >> 3, rem = bits & 7;
  for (let i = 0; i < full; i++) if (h[i] !== 0) return false;
  return rem === 0 || h[full] >> (8 - rem) === 0;
};

export function powHash(salt: string, nonce: string, powNonce: string): Uint8Array { return sha256(utf8(`${salt}:${nonce}:${powNonce}`)); }

export interface PowProgress { bits: number; tried: number; expected: number }
/** Search 0, 1, 2, … (the smallest answer, as the reference); `onProgress` after each chunk; past `deadline` → POW_EXPIRED. */
export async function solvePow(task: PowTask, nonce: string, o: { chunk?: number; onProgress?: (p: PowProgress) => void; deadline?: number; pause?: () => Promise<void> } = {}): Promise<string> {
  const chunk = o.chunk ?? 20_000;
  const pause = o.pause ?? (() => new Promise<void>((r) => setTimeout(r, 0)));
  const base = sha256.create().update(utf8(`${task.salt}:${nonce}:`));
  const expected = 2 ** task.bits;
  for (let i = 0; ; ) {
    const end = i + chunk;
    for (; i < end; i++) {
      const s = String(i);
      if (enough(base.clone().update(utf8(s)).digest(), task.bits)) { o.onProgress?.({ bits: task.bits, tried: i + 1, expected }); return s; }
    }
    o.onProgress?.({ bits: task.bits, tried: i, expected });
    if (o.deadline !== undefined && Date.now() > o.deadline) throw new Error('POW_EXPIRED: the task expired before it was solved');
    await pause();
  }
}
