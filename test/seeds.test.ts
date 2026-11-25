// 0.1.7: several phrases, migration of the 0.1.6 storage, seed cache, auto-lock by the human's activity only, lock at once.
// The real service worker on the in-memory chrome.* + the mock Signer (nothing leaves the machine).
import { installFakeChrome } from './helpers/fake-chrome';
import { startMockSigner, type MockState } from './helpers/mock-signer';
import { createVault, unlockVault } from '../src/lib/crypto/vault';
import { addressesOfKey, hdAddresses, seedFromMnemonic, seedFromMnemonicAsync } from '../src/lib/wallet/derive';
import { keyStats } from '../src/lib/wallet/keys';
import { migrateSeeds, rootAccount } from '../src/lib/wallet/model';

const ABOUT = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
// second public test vector (BIP-39 "legal winner …"), never used with real funds
const LEGAL = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const PW = 'correct horse battery';
const A = (m: string, i: number) => hdAddresses(seedFromMnemonic(m), i);
const A0 = A(ABOUT, 0), A1 = A(ABOUT, 1), L0 = A(LEGAL, 0), L1 = A(LEGAL, 1);

const st: MockState = { accounts: {}, usdcMicro: 0n, coverPrice: '0.48', energyUsed: 64_285 };
const fake = installFakeChrome();
const call = fake.call;
let mock: Awaited<ReturnType<typeof startMockSigner>>;
const challenges: any[] = [];

/** Exactly what 0.1.6 left in chrome.storage.local: one phrase in the vault, account `main` without seed_id. */
async function writeStorage016() {
  const vault016 = {
    secrets: { mnemonic: ABOUT, imported: {} },
    global: { auto_enabled: false, window: 'rolling_24h', wallet_per_day: {}, similar: { prefix: 4, suffix: 4 } },
    address_book: [{ id: 'ab_1', label: 'Склад', network: 'tron', address: A(ABOUT, 7).tron, added_at: '2026-11-17T10:00:00.000Z' }],
    agents: {}, networks_trusted: ['tron', 'evm:8453'], spend: [], recipients: [],
  };
  const { blob } = await createVault(PW, vault016);
  const pub016 = {
    wallet_id: 'wal_test',
    accounts: [{ id: 'acc_main016', name: 'main', origin: 'hd', hd_index: 0, addresses: { tron: A0.tron, evm: A0.evm } },
      { id: 'acc_ops016', name: 'ops', origin: 'hd', hd_index: 1, addresses: { tron: A1.tron, evm: A1.evm } }],
    doc_version: 3, settings: { signer_url: 'http://127.0.0.1:9985', autolock_min: 30, debug_direct_node: false, open_in_side_panel: false, agents_paused: false },
    created_at: '2026-11-17T09:00:00.000Z',
  };
  await fake.chrome.storage.local.set({ vault: blob, pub: pub016 });
}

beforeAll(async () => {
  mock = await startMockSigner(st);
  const f = globalThis.fetch;
  globalThis.fetch = (async (u: any, o?: any) => { if (String(u).endsWith('/v1/ext/auth/challenge')) challenges.push(JSON.parse(o.body)); return f(u, o); }) as any;
  await writeStorage016();
  await import('../src/background/index');
});
afterAll(async () => { await call({ cmd: 'disconnect' }).catch(() => {}); await mock.close(); });

describe('pure parts', () => {
  it('WebCrypto BIP-39 seed = the pure-JS one', async () => {
    for (const m of [ABOUT, LEGAL]) expect(Buffer.from(await seedFromMnemonicAsync(m)).toString('hex')).toBe(Buffer.from(seedFromMnemonic(m)).toString('hex'));
  });
  it('migrateSeeds: phrase → seeds[0] «Основная», HD accounts get its id, root unchanged; idempotent', () => {
    const accounts: any[] = [{ id: 'acc_1', name: 'main', origin: 'hd', hd_index: 0, addresses: {} }, { id: 'acc_k', name: 'k', origin: 'imported', addresses: {} }];
    const m = migrateSeeds({ mnemonic: ABOUT, imported: {} }, accounts, () => 'seed_main', '2026-11-17T09:00:00Z');
    expect(m.secrets).toEqual({ imported: {}, seeds: [{ id: 'seed_main', name: 'Основная', mnemonic: ABOUT, created_at: '2026-11-17T09:00:00Z' }] });
    expect(m.accounts.map((a) => a.seed_id)).toEqual(['seed_main', undefined]);
    expect(rootAccount(m.accounts, m.secrets)?.id).toBe('acc_1');
    expect(rootAccount(accounts, { mnemonic: ABOUT, imported: {} })?.id).toBe('acc_1');
    const again = migrateSeeds(m.secrets, m.accounts, () => 'other', 'x');
    expect(again).toMatchObject({ vaultChanged: false, pubChanged: false });
  });
});

describe('0.1.6 storage → 0.1.7', () => {
  it('locked: the same accounts are listed; unlock migrates; addresses, ids and the root stay', async () => {
    const before = await call({ cmd: 'status' });
    expect(before.unlocked).toBe(false);
    expect(before.accounts.find((a: any) => a.root)?.id).toBe('acc_main016');
    await call({ cmd: 'unlock', password: PW });
    const s = await call({ cmd: 'status' });
    expect(s.seeds).toEqual([{ id: 'seed_main', name: 'Основная', created_at: '2026-11-17T09:00:00.000Z', accounts: 2, root: true, next_index: 2 }]);
    expect(s.accounts.map((a: any) => [a.id, a.name, a.hd_index, a.seed_id, a.addresses.tron, a.addresses.evm, a.root]))
      .toEqual([['acc_main016', 'main', 0, 'seed_main', A0.tron, A0.evm, true], ['acc_ops016', 'ops', 1, 'seed_main', A1.tron, A1.evm, false]]);
    expect(s.book).toHaveLength(1);
    // on disk: the vault holds seeds (no bare `mnemonic`), the phrase only inside the ciphertext
    const disk = (fake.chrome.storage.local as any)._dump();
    expect(JSON.stringify(disk)).not.toContain('abandon');
    const { data } = await unlockVault<any>(PW, disk.vault);
    expect(data.secrets.mnemonic).toBeUndefined();
    expect(data.secrets.seeds[0]).toMatchObject({ id: 'seed_main', name: 'Основная', mnemonic: ABOUT });
    expect(disk.pub.accounts.map((a: any) => a.seed_id)).toEqual(['seed_main', 'seed_main']);
  });

  it('sign-in to the Signer by the same root; the wallet document is the same as 0.1.6 would send (no phrase data)', async () => {
    await call({ cmd: 'settings', patch: { signer_url: mock.url } });
    const sync = mock.next((m) => m.type === 'wallet.sync');
    await call({ cmd: 'connect' });
    expect(challenges.at(-1)).toMatchObject({ tron_address: A0.tron, evm_address: A0.evm });
    const m = await sync; // the mock checks the digest and both root signatures
    // 0.3.2: another Signer URL = another wallet there: its id and versions start over (this one has none)
    expect(m.doc.version).toBe(1);
    expect(m.doc.service).toBe(new URL(mock.url).host);
    expect(m.doc.accounts).toEqual([
      { id: 'acc_main016', name: 'main', origin: 'hd', hd_index: 0, addresses: { tron: A0.tron, evm: A0.evm } },
      { id: 'acc_ops016', name: 'ops', origin: 'hd', hd_index: 1, addresses: { tron: A1.tron, evm: A1.evm } },
    ]);
    expect(JSON.stringify(m.doc)).not.toMatch(/seed|Основная/);
  });
});

describe('several phrases', () => {
  let legalId = '';
  it('preview → import a phrase with a name: account 0 of that phrase, same addresses as previewed', async () => {
    const pv = await call({ cmd: 'accountPreview', mnemonic: LEGAL });
    expect(pv).toEqual({ tron: L0.tron, evm: L0.evm, index: 0 });
    const r = await call({ cmd: 'seedCreate', name: 'Рабочая', mnemonic: LEGAL, account_name: 'work' });
    legalId = r.seed_id;
    expect(r.account).toMatchObject({ name: 'work', hd_index: 0, seed_id: legalId, addresses: { tron: L0.tron, evm: L0.evm } });
    await expect(call({ cmd: 'seedCreate', name: 'Дубль', mnemonic: LEGAL })).rejects.toThrow(/SEED_EXISTS: Рабочая/);
    await expect(call({ cmd: 'seedCreate', name: 'x', mnemonic: 'abandon abandon' })).rejects.toThrow(/BAD_MNEMONIC/);
  });

  it('index is counted inside each phrase', async () => {
    expect(await call({ cmd: 'accountPreview', seed_id: legalId })).toEqual({ tron: L1.tron, evm: L1.evm, index: 1 });
    const w2 = await call({ cmd: 'addAccount', name: 'work-2', seed_id: legalId });
    expect(w2).toMatchObject({ hd_index: 1, addresses: { tron: L1.tron } });
    const m2 = await call({ cmd: 'addAccount', name: 'main-2', seed_id: 'seed_main' });
    expect(m2).toMatchObject({ hd_index: 2, seed_id: 'seed_main', addresses: { tron: A(ABOUT, 2).tron } });
    const s = await call({ cmd: 'status' });
    expect(s.seeds.map((x: any) => [x.name, x.accounts, x.next_index, x.root])).toEqual([['Основная', 3, 3, true], ['Рабочая', 2, 2, false]]);
  });

  it('import a key with a name; a duplicate address is refused', async () => {
    const key = '0x' + '0'.repeat(63) + '7';
    expect(await call({ cmd: 'accountPreview', privateKey: key })).toEqual(addressesOfKey(key as `0x${string}`));
    await call({ cmd: 'importKey', privateKey: key, name: 'cold' });
    expect(await call({ cmd: 'accountPreview', privateKey: key })).toMatchObject({ exists: 'cold' });
    await expect(call({ cmd: 'importKey', privateKey: key, name: 'again' })).rejects.toThrow(/ACCOUNT_EXISTS/);
  });

  it('seeds are derived once per unlock (not per account / per call)', async () => {
    const n0 = keyStats.seedDerivations;
    const s = await call({ cmd: 'status' });
    for (const a of s.accounts.slice(0, 4)) await call({ cmd: 'accountPreview', seed_id: a.seed_id ?? 'seed_main' });
    await call({ cmd: 'addAccount', name: 'main-3' });
    expect(keyStats.seedDerivations).toBe(n0);
    await call({ cmd: 'lock' });
    await call({ cmd: 'unlock', password: PW });
    expect(keyStats.seedDerivations).toBe(n0 + 2); // two phrases, once each
  });

  it('rename; delete: not the first, password checked, accounts hidden and unbound from agents', async () => {
    await call({ cmd: 'seedRename', id: legalId, name: 'Офис' });
    const work = (await call({ cmd: 'status' })).accounts.filter((a: any) => a.seed_id === legalId).map((a: any) => a.id);
    const ag = await call({ cmd: 'agentCreate', name: 'bot', accounts: [work[0], 'acc_main016'] });
    await expect(call({ cmd: 'seedRemove', id: 'seed_main', password: PW })).rejects.toThrow(/ROOT_SEED/);
    await expect(call({ cmd: 'seedRemove', id: legalId, password: 'wrong password!' })).rejects.toThrow(/BAD_PASSWORD/);
    expect(await call({ cmd: 'seedRemove', id: legalId, password: PW })).toEqual({ hidden: 2 });
    const s = await call({ cmd: 'status' });
    expect(s.seeds.map((x: any) => x.name)).toEqual(['Основная']);
    expect(s.accounts.some((a: any) => work.includes(a.id))).toBe(false);
    expect(s.agents.find((a: any) => a.id === ag.id).accounts).toEqual(['acc_main016']);
    const { data } = await unlockVault<any>(PW, (fake.chrome.storage.local as any)._dump().vault);
    expect(JSON.stringify(data)).not.toContain('legal winner');
    // the same phrase can come back later
    await call({ cmd: 'seedCreate', name: 'Офис', mnemonic: LEGAL });
  });
});

describe('auto-lock and lock', () => {
  const sesDump = () => (fake.chrome.storage.session as any)._dump();
  it('only the human moves the auto-lock: passive commands do not, touch and actions do', async () => {
    const { getSession } = await import('../src/background/store');
    const s = await getSession();
    s.lastActivity = Date.now() - 20 * 60_000;
    const at0 = (await call({ cmd: 'status' })).autolock_at;
    for (const c of [{ cmd: 'status' }, { cmd: 'prices' }, { cmd: 'requests' }, { cmd: 'history' }, { cmd: 'balancesCached', ids: [] }]) await call(c);
    expect((await call({ cmd: 'status' })).autolock_at).toBe(at0);
    expect(Math.round((at0 - Date.now()) / 60_000)).toBe(10);
    const r = await call({ cmd: 'touch' });
    expect(Math.round((r.autolock_at - Date.now()) / 60_000)).toBe(30);
  });

  it('locks strictly by the setting', async () => {
    const { autolockCheck } = await import('../src/background/wallet');
    await call({ cmd: 'settings', patch: { autolock_min: 5 } });
    expect(await autolockCheck(Date.now() + 4 * 60_000)).toBe(false);
    expect((await call({ cmd: 'status' })).unlocked).toBe(true);
    expect(await autolockCheck(Date.now() + 5 * 60_000 + 1000)).toBe(true);
    expect((await call({ cmd: 'status' })).unlocked).toBe(false);
    await call({ cmd: 'unlock', password: PW });
    await call({ cmd: 'settings', patch: { autolock_min: 30 } });
  });

  it('lock is immediate: keys gone before the reply, the session copy too', async () => {
    const t = performance.now();
    await call({ cmd: 'lock' });
    expect(performance.now() - t).toBeLessThan(50);
    expect(sesDump().unlocked).toBeUndefined();
    expect((await call({ cmd: 'status' })).unlocked).toBe(false);
    await expect(call({ cmd: 'addAccount', name: 'x' })).rejects.toThrow(/LOCKED/);
  });
});
