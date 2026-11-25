// TRON addresses: base58check of 0x41 + 20 bytes (hex 41… accepted, base58 T… shown).
import { createBase58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '../bytes';

const b58c = createBase58check(sha256);

export function tronFromHex41(hex41: string): string {
  const b = hexToBytes(hex41);
  if (b.length !== 21 || b[0] !== 0x41) throw new Error('INVALID_ADDRESS');
  return b58c.encode(b);
}

/** 0x… EVM-style 20 bytes → T… (same key gives both: TRON = 0x41 + keccak(pub)[12:]). */
export const tronFromEvm = (evm: string): string => tronFromHex41('41' + evm.slice(2).toLowerCase());

export function tronToHex41(addr: string): string {
  if (/^41[0-9a-fA-F]{40}$/.test(addr)) return addr.toLowerCase();
  const b = b58c.decode(addr);
  if (b.length !== 21 || b[0] !== 0x41) throw new Error('INVALID_ADDRESS');
  return bytesToHex(b);
}

export function isTronAddress(addr: string): boolean {
  try { tronToHex41(addr); return /^T/.test(addr) || /^41/.test(addr); } catch { return false; }
}

/** Canonical T… form of any accepted input; throws INVALID_ADDRESS. */
export const normalizeTron = (addr: string): string => tronFromHex41(tronToHex41(addr.trim()));
