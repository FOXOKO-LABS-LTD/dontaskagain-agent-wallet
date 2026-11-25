// Wallet state in the service worker: create / import / unlock / lock, phrases (0.1.7: several), accounts, auto-lock.
import { base64ToBytes, bytesToBase64, randomId } from '../lib/bytes';
import { createVault, encryptWithRawKey, unlockVault } from '../lib/crypto/vault';
import { requireStrongPassword } from '../lib/crypto/password';
import { addressesOfKey, isValidMnemonic, normalizeMnemonic, parsePrivateKey } from '../lib/wallet/derive';
import { clearKeyCache, forgetSeed, hdAddressesOf, keysOf, warmSeeds } from '../lib/wallet/keys';
import {
  DEFAULT_SETTINGS, firstSeedName, defaultVault, migrateSeeds, normalizeVault, rootAccount, validName,
  type Account, type PublicState, type SeedSecret, type VaultData,
} from '../lib/wallet/model';
import { clearAllStorage, clearSessionKeys, getPublic, getSession, getVaultBlob, patchSession, setActivity, setPublic, setVaultBlob } from './store';

export const MIN_AUTOLOCK = 5, MAX_AUTOLOCK = 240;

export async function isUnlocked(): Promise<boolean> { return !!(await getSession()).unlocked; }

/**
 * 0.3.2: every lock starts a new epoch. Work that began before a lock (saveVault, warming seeds) must not
 * write the unlocked state back after it — it checks the epoch before its last write and gives up with LOCKED.
 */
let epoch = 0;
export const lockEpoch = () => epoch;

/**
 * The unlocked vault (a copy: change it, then saveVault) + the public state. Storage of ≤ 0.1.6 is migrated here on
 * first use, and the seeds of every phrase are derived once (WebCrypto) and cached until lock.
 */
export async function requireUnlocked(): Promise<{ vault: VaultData; rawKey: Uint8Array; pub: PublicState }> {
  const s = await getSession();
  let pub = await getPublic();
  if (!s.unlocked || !pub) throw new Error('LOCKED');
  if (await autolockCheck()) throw new Error('LOCKED'); // past the deadline nothing uses the keys any more
  let vault = structuredClone(s.unlocked.vault);
  const rawKey = base64ToBytes(s.unlocked.rawKey);
  if (vault.secrets.mnemonic !== undefined || !vault.secrets.seeds || pub.accounts.some((a) => a.origin === 'hd' && !a.seed_id)) {
    ({ vault, pub } = await migrate(vault, pub));
  }
  const e = epoch;
  await warmSeeds(vault.secrets);
  if (e !== epoch || !(await getSession()).unlocked) { clearKeyCache(); throw new Error('LOCKED'); } // locked meanwhile
  return { vault, rawKey, pub };
}

/** The id of the phrase migrated from ≤ 0.1.6 (fixed: a repeated or concurrent migration gives the same result). */
export const MIGRATED_SEED_ID = 'seed_main';
let migrating: Promise<{ vault: VaultData; pub: PublicState }> | null = null;

function migrate(vault: VaultData, pub: PublicState): Promise<{ vault: VaultData; pub: PublicState }> {
  migrating ??= migrateOnce(vault, pub).finally(() => { migrating = null; });
  return migrating;
}

async function migrateOnce(vault: VaultData, pub: PublicState): Promise<{ vault: VaultData; pub: PublicState }> {
  const m = migrateSeeds(vault.secrets, pub.accounts, () => MIGRATED_SEED_ID, pub.created_at || new Date().toISOString());
  const v2 = { ...vault, secrets: m.secrets };
  if (m.vaultChanged) await saveVault(v2); // the vault first: a half-done migration repeats from it
  const p2 = { ...pub, accounts: m.accounts };
  if (m.pubChanged) await setPublic(p2);
  return { vault: v2, pub: p2 };
}

/**
 * 0.3.3: ONE queue for every change of the vault. `updateVault(fn)` takes the vault as it is now (inside
 * the queue), applies `fn` and writes it — nothing waits for the network while holding a copy, so a revoke, a pairing,
 * a bridge approval or a mint counter written meanwhile is never overwritten by an older copy. A password change
 * (rekey) runs in the same queue: no save can slip between its blob and its session key. `fn` returns false → no write.
 * `fn` must not call updateVault itself (the queue is not re-entrant).
 */
let vaultChain: Promise<unknown> = Promise.resolve();
export function withVaultLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = vaultChain.then(fn, fn);
  vaultChain = run.catch(() => {});
  return run;
}
export function updateVault(fn: (vault: VaultData, pub: PublicState) => void | boolean | Promise<void | boolean>): Promise<void> {
  return withVaultLock(async () => {
    const { vault, pub } = await requireUnlocked();
    if ((await fn(vault, pub)) === false) return;
    await saveVault(vault);
  });
}

/** Persist a changed vault: re-encrypt with the session key (no password) and update the session copy.
 * Callers outside this file go through updateVault; this is the raw write. */
export async function saveVault(vault: VaultData): Promise<void> {
  const e = epoch;
  const s = await getSession();
  if (!s.unlocked) throw new Error('LOCKED');
  const rawKey = s.unlocked.rawKey;
  const blob = await getVaultBlob();
  if (!blob) throw new Error('NO_WALLET');
  const enc = await encryptWithRawKey(base64ToBytes(rawKey), blob.kdf, vault);
  // a lock (or a password change: another key) meanwhile — the change is not written and the wallet stays locked
  if (e !== epoch || (await getSession()).unlocked?.rawKey !== rawKey) throw new Error('LOCKED');
  await setVaultBlob(enc);
  if (e !== epoch) throw new Error('LOCKED'); // the blob is saved (same key); the session stays locked
  await patchSession({ unlocked: { vault: structuredClone(vault), rawKey } });
}

async function initWallet(vault: VaultData, accounts: Account[], password: string): Promise<void> {
  if (await getVaultBlob()) throw new Error('WALLET_EXISTS');
  requireStrongPassword(password); // the worker refuses a weak one, not only the page
  const { blob, rawKey } = await createVault(password, vault);
  const prev = await getPublic();
  await setVaultBlob(blob);
  await setPublic({ accounts, doc_version: 0, settings: prev?.settings ?? DEFAULT_SETTINGS, created_at: new Date().toISOString() });
  await patchSession({ unlocked: { vault, rawKey: bytesToBase64(rawKey) }, lastActivity: Date.now() });
}

function newSeed(mnemonic: string, name: string): SeedSecret {
  const m = normalizeMnemonic(mnemonic);
  if (!isValidMnemonic(m)) throw new Error('BAD_MNEMONIC');
  if (!validName(name)) throw new Error('BAD_NAME');
  return { id: randomId('seed'), name: name.trim(), mnemonic: m, created_at: new Date().toISOString() };
}

export async function createFromMnemonic(mnemonic: string, password: string, seedName = firstSeedName(), accountName = 'main'): Promise<void> {
  const seed = newSeed(mnemonic, seedName);
  if (!validName(accountName)) throw new Error('BAD_NAME');
  await warmSeeds({ seeds: [seed], imported: {} });
  const a = hdAddressesOf(seed, 0);
  const acc: Account = { id: randomId('acc'), name: accountName.trim(), origin: 'hd', hd_index: 0, seed_id: seed.id, addresses: { tron: a.tron, evm: a.evm } };
  await initWallet(defaultVault({ seeds: [seed], imported: {} }), [acc], password);
}

export async function createFromKey(privateKey: string, password: string, accountName = 'main'): Promise<void> {
  const key = parsePrivateKey(privateKey);
  if (!validName(accountName)) throw new Error('BAD_NAME');
  const a = addressesOfKey(key);
  const acc: Account = { id: randomId('acc'), name: accountName.trim(), origin: 'imported', addresses: { tron: a.tron, evm: a.evm } };
  await initWallet(defaultVault({ seeds: [], imported: { [acc.id]: { kind: 'secp256k1', key } } }), [acc], password);
}

/** The only slow step by design: PBKDF2 600 000 of the password. Then migration (if any) and seeds — once. */
export async function unlock(password: string): Promise<void> {
  const blob = await getVaultBlob();
  if (!blob) throw new Error('NO_WALLET');
  const { data, rawKey } = await unlockVault<VaultData>(password, blob);
  const v = normalizeVault(data); // 0.3.5: auto-sign leftovers of an old vault are dropped
  await patchSession({ unlocked: { vault: v, rawKey: bytesToBase64(rawKey) }, lastActivity: Date.now() });
  const { vault, pub } = await requireUnlocked();
  // 0.3.2: the public state on disk is not protected — its addresses must be the ones the keys give
  for (const a of pub.accounts) {
    if (a.removed_at) continue;
    let k;
    try { k = keysOf(a, vault.secrets); } catch { continue; }
    const tron = addressesOfKey(k.tronKey).tron, evm = addressesOfKey(k.evmKey).evm;
    if ((a.addresses.tron && a.addresses.tron !== tron) || (a.addresses.evm && a.addresses.evm.toLowerCase() !== evm.toLowerCase())) {
      await lock();
      throw new Error(`PUB_TAMPERED: the address of account «${a.name}» on disk differs from its key — the profile may have been modified`);
    }
  }
}

/** Password check without changing anything (deleting a phrase). */
export async function checkPassword(password: string): Promise<void> {
  const blob = await getVaultBlob();
  if (!blob) throw new Error('NO_WALLET');
  await unlockVault(password, blob);
}

/**
 * «Change password» (0.3.2): the old password is checked, a NEW salt and key encrypt the vault, the session
 * key is replaced (the E2E history at rest follows: e2e.ts re-encrypts it with the new key). The same re-key with the
 * same password after a phrase is deleted: old copies of the blob on disk no longer open with the key.
 */
export async function changePassword(oldPw: string, newPw: string): Promise<void> {
  requireStrongPassword(newPw);
  if (oldPw === newPw) throw new Error('WEAK_PASSWORD: PW_SAME');
  await rekey(oldPw, newPw);
}

async function rekey(oldPw: string, newPw: string): Promise<void> {
  const blob0 = await getVaultBlob();
  if (!blob0) throw new Error('NO_WALLET');
  const { data } = await unlockVault<VaultData>(oldPw, blob0); // BAD_PASSWORD when wrong (outside the queue: it is slow)
  // the vault as it is when the queue reaches us; no save runs between the new blob and the new session key
  await withVaultLock(async () => {
  const s = await getSession();
  const vault = s.unlocked ? structuredClone(s.unlocked.vault) : { ...defaultVault(data.secrets), ...data };
  const e = epoch;
  const { blob: next, rawKey } = await createVault(newPw, vault);
  if (e !== epoch) throw new Error('LOCKED');
  for (const h of rekeyHooks) await h.before();
  await setVaultBlob(next);
  if (s.unlocked) await patchSession({ unlocked: { vault, rawKey: bytesToBase64(rawKey) } });
  for (const h of rekeyHooks) await h.after();
  });
}
const rekeyHooks: { before: () => Promise<void>; after: () => Promise<void> }[] = [];
/** Around a change of the vault key: `before` still has the old key, `after` the new one (the E2E history at rest). */
export function onRekey(before: () => Promise<void>, after: () => Promise<void>): void { rekeyHooks.push({ before, after }); }

export async function lock(): Promise<void> {
  epoch++;
  clearKeyCache();
  await clearSessionKeys(['unlocked']);
}

export async function touch(): Promise<void> { await setActivity(Date.now()); }

/** When the wallet locks by itself (ms epoch), or undefined when locked. */
export async function autolockAt(): Promise<number | undefined> {
  const s = await getSession();
  const pub = await getPublic();
  if (!s.unlocked || !pub) return undefined;
  return (s.lastActivity ?? Date.now()) + autolockMinutes(pub) * 60_000;
}
const autolockMinutes = (pub: PublicState) => Math.min(MAX_AUTOLOCK, Math.max(MIN_AUTOLOCK, Number(pub.settings.autolock_min) || 30));

/** Auto-lock: 30 min (5–240) without the human's activity. Called by the alarm. */
export async function autolockCheck(now = Date.now()): Promise<boolean> {
  const at = await autolockAt();
  if (at !== undefined && now >= at) { await lock(); return true; }
  return false;
}

// ---- phrases ----
const liveAccounts = (pub: PublicState) => pub.accounts.filter((a) => !a.removed_at);
const firstSeedId = (v: VaultData) => v.secrets.seeds?.[0]?.id;
const seedIdOf = (a: Account, v: VaultData) => a.seed_id ?? firstSeedId(v);

/** Next free HD index of a phrase (hidden accounts keep theirs: indexes are never reused). */
export function nextIndex(pub: PublicState, v: VaultData, seedId: string): number {
  return Math.max(-1, ...pub.accounts.filter((a) => a.origin === 'hd' && seedIdOf(a, v) === seedId).map((a) => a.hd_index ?? 0)) + 1;
}

function dupCheck(pub: PublicState, evm: string) {
  const dup = liveAccounts(pub).find((x) => x.addresses.evm?.toLowerCase() === evm.toLowerCase());
  if (dup) throw new Error(`ACCOUNT_EXISTS: ${dup.name}`);
}

export interface SeedInfo { id: string; name: string; created_at: string; accounts: number; root: boolean; next_index: number; }
export function seedsInfo(pub: PublicState, v: VaultData): SeedInfo[] {
  return (v.secrets.seeds ?? []).map((s, i) => ({
    id: s.id, name: s.name, created_at: s.created_at, root: i === 0, next_index: nextIndex(pub, v, s.id),
    accounts: liveAccounts(pub).filter((a) => a.origin === 'hd' && seedIdOf(a, v) === s.id).length,
  }));
}

/** Addresses an account would get, before creating it (add-account page). */
export async function previewAccount(p: { seed_id?: string; mnemonic?: string; privateKey?: string }): Promise<{ tron: string; evm: string; index?: number; exists?: string }> {
  const { vault, pub } = await requireUnlocked();
  let r: { tron: string; evm: string; index?: number };
  if (p.privateKey) r = addressesOfKey(parsePrivateKey(p.privateKey));
  else if (p.mnemonic) {
    const s = newSeed(p.mnemonic, 'preview');
    await warmSeeds({ seeds: [s], imported: {} });
    r = { ...hdAddressesOf(s, 0), index: 0 };
    forgetSeed(s.id);
  } else {
    const s = vault.secrets.seeds?.find((x) => x.id === p.seed_id);
    if (!s) throw new Error('UNKNOWN_SEED');
    const i = nextIndex(pub, vault, s.id);
    r = { ...hdAddressesOf(s, i), index: i };
  }
  const dup = liveAccounts(pub).find((x) => x.addresses.evm?.toLowerCase() === r.evm.toLowerCase());
  return { ...r, ...(dup ? { exists: dup.name } : {}) };
}

/** Next account of a phrase (default: the first one). */
export async function addHdAccount(name: string, seedId?: string): Promise<Account> {
  const { vault, pub } = await requireUnlocked();
  const s = seedId ? vault.secrets.seeds?.find((x) => x.id === seedId) : vault.secrets.seeds?.[0];
  if (!s) throw new Error(seedId ? 'UNKNOWN_SEED' : 'NO_MNEMONIC');
  if (!validName(name)) throw new Error('BAD_NAME');
  const next = nextIndex(pub, vault, s.id);
  const a = hdAddressesOf(s, next);
  dupCheck(pub, a.evm);
  const acc: Account = { id: randomId('acc'), name: name.trim(), origin: 'hd', hd_index: next, seed_id: s.id, addresses: { tron: a.tron, evm: a.evm } };
  pub.accounts.push(acc);
  await setPublic(pub);
  return acc;
}

/** A new or imported phrase with a name; its account 0 is created at once (name: accountName or the phrase's). */
export async function addSeed(mnemonic: string, name: string, accountName?: string): Promise<{ seed_id: string; account: Account }> {
  const seed = newSeed(mnemonic, name);
  const accName = (accountName ?? '').trim() || seed.name;
  if (!validName(accName)) throw new Error('BAD_NAME');
  await warmSeeds({ seeds: [seed], imported: {} });
  const a = hdAddressesOf(seed, 0);
  const acc: Account = { id: randomId('acc'), name: accName.slice(0, 32), origin: 'hd', hd_index: 0, seed_id: seed.id, addresses: { tron: a.tron, evm: a.evm } };
  let pub!: PublicState;
  await updateVault((vault, p) => {
    const same = vault.secrets.seeds?.find((x) => x.mnemonic === seed.mnemonic);
    if (same) throw new Error(`SEED_EXISTS: ${same.name}`);
    dupCheck(p, a.evm);
    vault.secrets.seeds = [...(vault.secrets.seeds ?? []), seed];
    pub = p;
  });
  pub.accounts.push(acc);
  await setPublic(pub);
  return { seed_id: seed.id, account: acc };
}

export async function renameSeed(id: string, name: string): Promise<void> {
  if (!validName(name)) throw new Error('BAD_NAME');
  await updateVault((vault) => {
    const s = vault.secrets.seeds?.find((x) => x.id === id);
    if (!s) throw new Error('UNKNOWN_SEED');
    s.name = name.trim();
  });
}

/**
 * Delete a phrase (password required). The first one cannot be deleted (its account 0 signs in to the Signer).
 * Its accounts are hidden and unbound from agents, like «Hide account»; the phrase itself is gone from the vault.
 */
export async function removeSeed(id: string, password: string): Promise<{ hidden: number }> {
  await checkPassword(password);
  const gone = new Set<string>();
  let pub!: PublicState;
  await updateVault((vault, p) => {
    const seeds = vault.secrets.seeds ?? [];
    const i = seeds.findIndex((x) => x.id === id);
    if (i < 0) throw new Error('UNKNOWN_SEED');
    if (i === 0) throw new Error('ROOT_SEED');
    const now = new Date().toISOString();
    for (const a of p.accounts) if (a.origin === 'hd' && seedIdOf(a, vault) === id) { if (!a.removed_at) a.removed_at = now; gone.add(a.id); }
    for (const ag of Object.values(vault.agents)) ag.accounts = ag.accounts.filter((x) => !gone.has(x));
    vault.secrets.seeds = seeds.filter((x) => x.id !== id);
    pub = p;
  });
  await setPublic(pub);
  forgetSeed(id);
  // a new salt and key. An old copy of the blob left on disk (LevelDB) still opens with the same PASSWORD —
  // the page says so and offers «Change password»; the new key only stops the old session key from opening new blobs.
  await rekey(password, password);
  return { hidden: gone.size };
}

export async function importKeyAccount(privateKey: string, name: string): Promise<Account> {
  if (!validName(name)) throw new Error('BAD_NAME');
  const key = parsePrivateKey(privateKey);
  const a = addressesOfKey(key);
  const acc: Account = { id: randomId('acc'), name: name.trim(), origin: 'imported', addresses: { tron: a.tron, evm: a.evm } };
  let pub!: PublicState;
  await updateVault((vault, p) => {
    dupCheck(p, a.evm);
    vault.secrets.imported[acc.id] = { kind: 'secp256k1', key };
    pub = p;
  });
  pub.accounts.push(acc);
  await setPublic(pub);
  return acc;
}

export async function renameAccount(id: string, name: string): Promise<void> {
  const { pub } = await requireUnlocked();
  if (!validName(name)) throw new Error('BAD_NAME');
  const a = pub.accounts.find((x) => x.id === id);
  if (!a) throw new Error('UNKNOWN_ACCOUNT');
  a.name = name.trim();
  await setPublic(pub);
}

/** Hide (not delete): ids are never reused; the root account cannot be hidden. */
export async function hideAccount(id: string): Promise<void> {
  let pub!: PublicState;
  await updateVault((vault, p) => {
    const root = rootAccount(p.accounts, vault.secrets);
    if (root?.id === id) throw new Error('ROOT_ACCOUNT');
    const a = p.accounts.find((x) => x.id === id);
    if (!a) throw new Error('UNKNOWN_ACCOUNT');
    a.removed_at = new Date().toISOString();
    for (const ag of Object.values(vault.agents)) ag.accounts = ag.accounts.filter((x) => x !== id);
    pub = p;
  });
  await setPublic(pub);
}

export async function accountKeys(id: string) {
  const { pub, vault } = await requireUnlocked();
  const a = pub.accounts.find((x) => x.id === id && !x.removed_at);
  if (!a) throw new Error('UNKNOWN_ACCOUNT');
  return { account: a, keys: keysOf(a, vault.secrets) };
}

export async function rootKeys() {
  const { pub, vault } = await requireUnlocked();
  const root = rootAccount(pub.accounts, vault.secrets);
  if (!root) throw new Error('NO_ROOT');
  return { account: root, keys: keysOf(root, vault.secrets) };
}

/** Full reset of this profile (explicit "DELETE"): vault, public state, session. */
export async function resetWallet(): Promise<void> {
  clearKeyCache();
  await clearAllStorage();
}
