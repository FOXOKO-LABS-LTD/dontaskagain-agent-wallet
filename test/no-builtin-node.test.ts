// 0.3.9: there is no built-in TRON node. Reads go through the Signer by default; «direct» needs a TRON node of the
// human's own (https; plain http only to localhost / a private network). Settings left by ≤ 0.3.8 migrate on load.
// The real service worker on the in-memory chrome.* + the mock Signer (nothing leaves the machine).
import { installFakeChrome } from './helpers/fake-chrome';
import { startMockSigner, type MockState } from './helpers/mock-signer';
import { DEFAULT_SETTINGS, directReadsOn, normalizeReads, tronNodeOf } from '../src/lib/wallet/model';
import { requireSecureUrl } from '../src/lib/urlPolicy';
import * as urlPolicy from '../src/lib/urlPolicy';
import e2eDefaults from '../src/config/e2e.json';
import manifest from '../public/manifest.json';

const ABOUT = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const st: MockState = { accounts: {}, usdcMicro: 0n, coverPrice: '0.48', energyUsed: 64_285 };
const fake = installFakeChrome();
const call = fake.call;
let mock: Awaited<ReturnType<typeof startMockSigner>>;
// the shape of the former built-in node: plain http to a public host (a documentation address stands in for it)
const OLD_BUILTIN = 'http://198.51.100.7:8090';
const IPV4 = /\b\d{1,3}(\.\d{1,3}){3}\b/g;

beforeAll(async () => { mock = await startMockSigner(st); await import('../src/background/index'); });
afterAll(async () => { await call({ cmd: 'disconnect' }).catch(() => {}); await mock.close(); });

/** Write settings straight into storage (as an older version left them) and read them back as the worker does. */
async function loadWith(settings: Record<string, unknown>) {
  const store = await import('../src/background/store');
  const { pub } = (await fake.chrome.storage.local.get('pub')) as any;
  await fake.chrome.storage.local.set({ pub: { ...pub, settings: { ...pub.settings, ...settings } } });
  store.dropStorageCache();
  return (await store.getPublic())!.settings;
}

describe('no built-in TRON node (0.3.9)', () => {
  it('config, manifest and policy carry no node address and no http exception', () => {
    expect('tron_node' in e2eDefaults).toBe(false);
    expect('tron_node_require_https' in e2eDefaults).toBe(false);
    expect('builtinNodeAllowed' in urlPolicy).toBe(false);
    const ips = (s: string) => (s.match(IPV4) ?? []).filter((ip) => ip !== '127.0.0.1');
    expect(ips(JSON.stringify(e2eDefaults))).toEqual([]);
    expect(ips(JSON.stringify(manifest))).toEqual([]);
    expect(manifest.host_permissions.every((h: string) => /^https:\/\//.test(h) || /^http:\/\/(127\.0\.0\.1|localhost)\//.test(h))).toBe(true);
  });

  it('defaults: reads through the Signer, no node; «direct» without a node is not in effect', () => {
    expect(DEFAULT_SETTINGS.e2e_reads).toBe('signer');
    expect(DEFAULT_SETTINGS.e2e_tron_node).toBe('');
    expect(directReadsOn({ ...DEFAULT_SETTINGS, e2e_reads: 'direct' })).toBe(false);
    expect(directReadsOn({ ...DEFAULT_SETTINGS, e2e_reads: 'direct', e2e_tron_node: 'https://node.example' })).toBe(true);
    expect(directReadsOn({ ...DEFAULT_SETTINGS, e2e_reads: 'signer', e2e_tron_node: 'https://node.example' })).toBe(false);
  });

  it('tronNodeOf: only the human\'s own https node (or http to localhost / a private network)', () => {
    expect(tronNodeOf({ e2e_tron_node: OLD_BUILTIN })).toBe('');
    expect(tronNodeOf({ e2e_tron_node: 'https://api.trongrid.io' })).toBe('');
    expect(tronNodeOf({ e2e_tron_node: '   ' })).toBe('');
    expect(tronNodeOf({ e2e_tron_node: 'not a url' })).toBe('');
    expect(tronNodeOf({ e2e_tron_node: 'ftp://node.example' })).toBe('');
    expect(tronNodeOf({ e2e_tron_node: 'https://node.example/' })).toBe('https://node.example');
    expect(tronNodeOf({ e2e_tron_node: 'http://localhost:8090' })).toBe('http://localhost:8090');
    expect(tronNodeOf({ e2e_tron_node: 'http://127.0.0.1:8090' })).toBe('http://127.0.0.1:8090');
    expect(tronNodeOf({ e2e_tron_node: 'http://node.localhost:8090' })).toBe('http://node.localhost:8090');
  });

  it('requireSecureUrl: http to a public host is refused for any endpoint, a former built-in one included', () => {
    expect(() => requireSecureUrl(OLD_BUILTIN, 'TRON node')).toThrow(/INSECURE_URL/);
    expect(() => requireSecureUrl('http://node.example:8090', 'TRON node')).toThrow(/INSECURE_URL/);
    expect(requireSecureUrl('https://node.example', 'TRON node').origin).toBe('https://node.example');
    expect(requireSecureUrl('http://localhost:8090', 'TRON node').origin).toBe('http://localhost:8090');
  });

  it('normalizeReads (pure migration)', () => {
    expect(normalizeReads({ e2e_reads: 'direct', e2e_tron_node: OLD_BUILTIN, debug_direct_node: true })).toEqual({ e2e_reads: 'signer', e2e_tron_node: '', debug_direct_node: false });
    expect(normalizeReads({ e2e_reads: 'direct', e2e_tron_node: '' }).e2e_reads).toBe('signer');
    expect(normalizeReads({ e2e_reads: 'direct', e2e_tron_node: 'https://node.example/' })).toEqual({ e2e_reads: 'direct', e2e_tron_node: 'https://node.example' });
    expect(normalizeReads({ e2e_reads: 'signer', e2e_tron_node: 'https://node.example', debug_direct_node: true })).toEqual({ e2e_reads: 'signer', e2e_tron_node: 'https://node.example', debug_direct_node: true });
  });

  it('setup: a new wallet reads through the Signer and has no node', async () => {
    await call({ cmd: 'createWallet', mnemonic: ABOUT, password: 'correct horse battery' });
    const s = await loadWith({});
    expect(s.e2e_reads).toBe('signer');
    expect(s.e2e_tron_node).toBe('');
  });

  it('migration: the former built-in node → no node, reads through the Signer, no debug direct reads; persisted on the next write', async () => {
    const s = await loadWith({ e2e_reads: 'direct', e2e_tron_node: OLD_BUILTIN, debug_direct_node: true });
    expect(s).toMatchObject({ e2e_reads: 'signer', e2e_tron_node: '', debug_direct_node: false });
    await call({ cmd: 'settings', patch: { autolock_min: 31 } });
    const { pub } = (await fake.chrome.storage.local.get('pub')) as any;
    expect(pub.settings).toMatchObject({ e2e_reads: 'signer', e2e_tron_node: '', debug_direct_node: false, autolock_min: 31 });
    expect(JSON.stringify(pub)).not.toContain('198.51.100.7');
  });

  it('migration: an empty node or the former TronGrid default → reads through the Signer', async () => {
    expect(await loadWith({ e2e_reads: 'direct', e2e_tron_node: '' })).toMatchObject({ e2e_reads: 'signer', e2e_tron_node: '' });
    expect(await loadWith({ e2e_reads: 'direct', e2e_tron_node: 'https://api.trongrid.io' })).toMatchObject({ e2e_reads: 'signer', e2e_tron_node: '' });
    expect(await loadWith({ e2e_tron_node: undefined, e2e_reads: undefined })).toMatchObject({ e2e_reads: 'signer', e2e_tron_node: '' });
  });

  it('migration: the human\'s own node and choice stay as they are', async () => {
    expect(await loadWith({ e2e_reads: 'direct', e2e_tron_node: 'https://my-node.example' })).toMatchObject({ e2e_reads: 'direct', e2e_tron_node: 'https://my-node.example' });
    expect(await loadWith({ e2e_reads: 'signer', e2e_tron_node: 'https://my-node.example' })).toMatchObject({ e2e_reads: 'signer', e2e_tron_node: 'https://my-node.example' });
    expect(await loadWith({ e2e_reads: 'direct', e2e_tron_node: 'http://localhost:8090' })).toMatchObject({ e2e_reads: 'direct', e2e_tron_node: 'http://localhost:8090' });
  });

  it('settings: «direct» and the debug direct node are refused without a node of the human\'s own', async () => {
    await loadWith({ e2e_reads: 'signer', e2e_tron_node: '', debug_direct_node: false });
    await expect(call({ cmd: 'settings', patch: { e2e_reads: 'direct' } })).rejects.toThrow(/NO_TRON_NODE/);
    await expect(call({ cmd: 'settings', patch: { debug_direct_node: true } })).rejects.toThrow(/NO_TRON_NODE/);
    await expect(call({ cmd: 'settings', patch: { e2e_tron_node: OLD_BUILTIN, e2e_reads: 'direct' } })).rejects.toThrow(/INSECURE_URL/);
    await expect(call({ cmd: 'settings', patch: { e2e_tron_node: 'http://node.example:8090' } })).rejects.toThrow(/INSECURE_URL/);
    const { pub } = (await fake.chrome.storage.local.get('pub')) as any;
    expect(pub.settings).toMatchObject({ e2e_reads: 'signer', e2e_tron_node: '' });
  });

  it('settings: with a node of the human\'s own «direct» is allowed; clearing the node returns reads to the Signer', async () => {
    await call({ cmd: 'settings', patch: { e2e_tron_node: 'https://my-node.example/' } });
    await call({ cmd: 'settings', patch: { e2e_reads: 'direct', debug_direct_node: true } });
    let { pub } = (await fake.chrome.storage.local.get('pub')) as any;
    expect(pub.settings).toMatchObject({ e2e_reads: 'direct', e2e_tron_node: 'https://my-node.example', debug_direct_node: true });
    await call({ cmd: 'settings', patch: { e2e_tron_node: '' } });
    ({ pub } = (await fake.chrome.storage.local.get('pub')) as any);
    expect(pub.settings).toMatchObject({ e2e_reads: 'signer', e2e_tron_node: '', debug_direct_node: false });
  });

  it('readers: without a node of the human\'s own TRON is read through the Signer (debug direct node too)', async () => {
    const { SignerTronReader, DirectTronReader } = await import('../src/lib/net');
    const { readers } = await import('../src/background/requests');
    await loadWith({ e2e_reads: 'direct', e2e_tron_node: OLD_BUILTIN, debug_direct_node: true });
    expect((await readers()).tron).toBeInstanceOf(SignerTronReader);
    await loadWith({ e2e_reads: 'signer', e2e_tron_node: 'https://my-node.example', debug_direct_node: true });
    expect((await readers()).tron).toBeInstanceOf(DirectTronReader);
  });
});
