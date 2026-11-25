// Small byte helpers shared by the service worker, pages and tests (no Buffer: MV3 pages and workers have none).

export function hexToBytes(hex: string): Uint8Array {
  let h = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (h.length % 2) throw new Error('odd hex length');
  if (!/^[0-9a-fA-F]*$/.test(h)) throw new Error('bad hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
export const fromUtf8 = (b: Uint8Array): string => new TextDecoder().decode(b);

export function bytesToBase64(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

export function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const bytesToBase64Url = (b: Uint8Array): string => bytesToBase64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/** Random id with a prefix: acc_…, ab_… (base32-like lowercase, 16 chars = 80 bits). */
export function randomId(prefix: string): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const b = randomBytes(16);
  let s = '';
  for (const x of b) s += alphabet[x % alphabet.length];
  return `${prefix}_${s}`;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
