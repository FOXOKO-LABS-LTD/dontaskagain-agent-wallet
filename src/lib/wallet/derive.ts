// Key derivation: one BIP-39 phrase → accounts i = 0, 1, 2…
//   TRON m/44'/195'/0'/0/i (base58 T…), EVM m/44'/60'/0'/0/i (0x…, one address for every EVM network).
//   TON m/44'/607'/i' (SLIP-10 ed25519, W5) — stage 3; the model keeps a slot for it.
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';
import { privateKeyToAccount } from 'viem/accounts';
import { bytesToHex, hexToBytes } from '../bytes';
import { tronFromEvm } from '../tron/address';

export const PATH_TRON = (i: number) => `m/44'/195'/0'/0/${i}`;
export const PATH_EVM = (i: number) => `m/44'/60'/0'/0/${i}`;
export const PATH_TON = (i: number) => `m/44'/607'/${i}'`;

export function newMnemonic(words: 12 | 24 = 24): string {
  return generateMnemonic(wordlist, words === 24 ? 256 : 128);
}

export const normalizeMnemonic = (m: string): string => m.trim().toLowerCase().split(/\s+/).join(' ');
export const isValidMnemonic = (m: string): boolean => validateMnemonic(normalizeMnemonic(m), wordlist);

export function seedFromMnemonic(m: string): Uint8Array {
  const n = normalizeMnemonic(m);
  if (!validateMnemonic(n, wordlist)) throw new Error('BAD_MNEMONIC');
  return mnemonicToSeedSync(n);
}

/**
 * The same BIP-39 seed through WebCrypto (native PBKDF2-SHA512, 2048 rounds): ~1 ms instead of ~50–150 ms of the
 * pure-JS version, and it does not block the worker. Checked against mnemonicToSeedSync in test/derive.test.ts.
 */
export async function seedFromMnemonicAsync(m: string): Promise<Uint8Array> {
  const n = normalizeMnemonic(m);
  if (!validateMnemonic(n, wordlist)) throw new Error('BAD_MNEMONIC');
  const enc = new TextEncoder();
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return mnemonicToSeedSync(n);
  const key = await subtle.importKey('raw', enc.encode(n.normalize('NFKD')) as BufferSource, 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-512', salt: enc.encode('mnemonic') as BufferSource, iterations: 2048 }, key, 512);
  return new Uint8Array(bits);
}

function childKey(seed: Uint8Array, path: string): string {
  const k = HDKey.fromMasterSeed(seed).derive(path);
  if (!k.privateKey) throw new Error('derivation failed');
  return '0x' + bytesToHex(k.privateKey);
}

export interface Secp256k1Keys { tronKey: `0x${string}`; evmKey: `0x${string}`; }

export function hdKeys(seed: Uint8Array, index: number): Secp256k1Keys {
  return { tronKey: childKey(seed, PATH_TRON(index)) as `0x${string}`, evmKey: childKey(seed, PATH_EVM(index)) as `0x${string}` };
}

/** EVM checksum address and TRON address of a secp256k1 private key. */
export function addressesOfKey(key: `0x${string}`): { evm: `0x${string}`; tron: string } {
  const evm = privateKeyToAccount(key).address;
  return { evm, tron: tronFromEvm(evm) };
}

export function hdAddresses(seed: Uint8Array, index: number): { tron: string; evm: `0x${string}` } {
  const k = hdKeys(seed, index);
  return { tron: addressesOfKey(k.tronKey).tron, evm: addressesOfKey(k.evmKey).evm };
}

/** Imported private key: 64 hex, optional 0x. Same key → TRON and EVM addresses. */
export function parsePrivateKey(input: string): `0x${string}` {
  const h = input.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new Error('BAD_PRIVATE_KEY');
  // 0 < k < n here, so no library error (which carries the number) can reach a page or a log
  const k = BigInt('0x' + h);
  if (k === 0n || k >= 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n) throw new Error('BAD_PRIVATE_KEY');
  void hexToBytes;
  return ('0x' + h.toLowerCase()) as `0x${string}`;
}
