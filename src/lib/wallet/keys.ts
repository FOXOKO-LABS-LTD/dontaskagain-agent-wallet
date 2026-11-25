// Private keys of an account, resolved only in the unlocked service worker (never sent to pages).
// 0.1.7: several phrases. The BIP-39 seed of each phrase is derived once per unlock (WebCrypto, warmSeeds) and kept
// only in the worker's memory; derived account keys are cached too. On lock (clearKeyCache) the seed bytes are zeroed
// and the caches dropped — key strings and mnemonics cannot be zeroed in JS, they are only released.
import { addressesOfKey, hdKeys, seedFromMnemonic, seedFromMnemonicAsync, type Secp256k1Keys } from './derive';
import { seedOfAccount, type Account, type SeedSecret, type Secrets } from './model';

const seedCache = new Map<string, { mnemonic: string; seed: Uint8Array }>();
const keyCache = new Map<string, Secp256k1Keys>(); // `${seed_id}/${index}`

/** Counters for tests / profiling: how many times a seed was derived (PBKDF2-2048). */
export const keyStats = { seedDerivations: 0 };

export function clearKeyCache(): void {
  for (const c of seedCache.values()) c.seed.fill(0);
  seedCache.clear();
  keyCache.clear();
}

/** Drop one phrase (deleted). */
export function forgetSeed(id: string): void {
  const c = seedCache.get(id);
  if (c) c.seed.fill(0);
  seedCache.delete(id);
  for (const k of [...keyCache.keys()]) if (k.startsWith(id + '/')) keyCache.delete(k);
}

const cached = (s: SeedSecret) => { const c = seedCache.get(s.id); return c && c.mnemonic === s.mnemonic ? c.seed : undefined; };

/** Derive (async, native) every phrase not in the cache yet. Called after unlock and before any key use. */
export async function warmSeeds(secrets: Secrets): Promise<void> {
  for (const s of secrets.seeds ?? []) {
    if (cached(s)) continue;
    const seed = await seedFromMnemonicAsync(s.mnemonic);
    keyStats.seedDerivations++;
    seedCache.set(s.id, { mnemonic: s.mnemonic, seed });
  }
}

export function seedBytes(s: SeedSecret): Uint8Array {
  let seed = cached(s);
  if (!seed) { seed = seedFromMnemonic(s.mnemonic); keyStats.seedDerivations++; seedCache.set(s.id, { mnemonic: s.mnemonic, seed }); }
  return seed;
}

/** Keys of HD index `index` of a phrase (cached). */
export function hdKeysOf(s: SeedSecret, index: number): Secp256k1Keys {
  const k = `${s.id}/${index}`;
  let keys = keyCache.get(k);
  if (!keys) { keys = hdKeys(seedBytes(s), index); keyCache.set(k, keys); }
  return keys;
}

/** TRON + EVM addresses of HD index `index` of a phrase. */
export function hdAddressesOf(s: SeedSecret, index: number): { tron: string; evm: `0x${string}` } {
  const k = hdKeysOf(s, index);
  return { tron: addressesOfKey(k.tronKey).tron, evm: addressesOfKey(k.evmKey).evm };
}

export function keysOf(acc: Account, secrets: Secrets): Secp256k1Keys {
  if (acc.origin === 'hd') {
    const s = seedOfAccount(acc, secrets);
    if (!s || acc.hd_index === undefined) throw new Error('NO_KEY');
    return hdKeysOf(s, acc.hd_index);
  }
  const s = secrets.imported[acc.id];
  if (!s || s.kind !== 'secp256k1') throw new Error('NO_KEY');
  return { tronKey: s.key, evmKey: s.key };
}
