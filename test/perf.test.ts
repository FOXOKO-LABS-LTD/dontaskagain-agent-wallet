// Worker latency profile (run with PERF=1): the real service worker on the in-memory chrome.* + the mock Signer.
// chrome.storage here is emulated with what makes the real one slow: every call serialises its value (JSON) and costs
// an IPC round trip (PERF_IPC_MS, default 0.3 ms). Numbers are relative (before/after), not Chrome's absolute ones.
// Only commands that exist in 0.1.6 are used, so the same file profiles the old and the new worker.
import { installFakeChrome } from './helpers/fake-chrome';
import { startMockSigner, type MockState } from './helpers/mock-signer';
import { hdAddresses, seedFromMnemonic } from '../src/lib/wallet/derive';

const RUN = process.env.PERF === '1';
const IPC_MS = Number(process.env.PERF_IPC_MS ?? 0.3);
const ABOUT = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PW = 'correct horse battery';
const seed = seedFromMnemonic(ABOUT);
const A0 = hdAddresses(seed, 0);

const st: MockState = { accounts: { [A0.tron]: { exists: true, balanceSun: 10_000_000, energy: 0, freeNet: 600, usdt: 5_000_000n } }, usdcMicro: 1_000_000n, coverPrice: '0.48', energyUsed: 64_285 };
st.history = Array.from({ length: 200 }, (_, i) => ({
  request_id: `awr_h${i}`, agent: { id: 'ag_x', name: 'claude-bot' }, account: { id: 'acc_x', name: 'main' }, type: 'transfer', network: 'tron',
  intent: { asset: 'USDT', to: A0.tron, amount: String(i + 1), resources: { energy: 'buy' } }, reason: 'Оплата счёта №' + i + ' — ' + 'x'.repeat(200),
  status: i % 3 ? 'confirmed' : 'rejected', created_at: new Date(Date.now() - i * 60_000).toISOString(), decision: { by: 'human', at: new Date().toISOString() },
  resources: { route: 'proxy', cost_usdc: '0.48', tx: 'f'.repeat(64) }, tx_id: 'e'.repeat(64),
}));

const fake = installFakeChrome();
// emulate the cost of the real chrome.storage: JSON both ways + an IPC hop
for (const name of ['local', 'session'] as const) {
  const a: any = fake.chrome.storage[name];
  const hop = () => new Promise((r) => setTimeout(r, IPC_MS));
  const { get, set, remove } = a;
  a.get = async (k: any) => { await hop(); return JSON.parse(JSON.stringify(await get(k))); };
  a.set = async (v: any) => { await hop(); return set(JSON.parse(JSON.stringify(v))); };
  a.remove = async (k: any) => { await hop(); return remove(k); };
}
fake.chrome.runtime.getManifest = () => ({ version: 'perf' });
const call = fake.call;
let mock: Awaited<ReturnType<typeof startMockSigner>>;

async function t<T>(label: string, f: () => Promise<T>, out: Record<string, number>): Promise<T> {
  const s = performance.now();
  const r = await f();
  out[label] = Math.round((performance.now() - s) * 10) / 10;
  return r;
}

(RUN ? describe : describe.skip)('perf profile', () => {
  beforeAll(async () => { mock = await startMockSigner(st); await import('../src/background/index'); });
  afterAll(async () => { await call({ cmd: 'disconnect' }).catch(() => {}); await mock.close(); });

  it('profiles the worker', async () => {
    const r: Record<string, number> = {};
    await t('createWallet (PBKDF2 600k)', () => call({ cmd: 'createWallet', mnemonic: ABOUT, password: PW }), r);
    const ids: string[] = [];
    for (let i = 1; i <= 5; i++) ids.push((await t(`addAccount #${i}`, () => call({ cmd: 'addAccount', name: 'acc' + i }), r)).id);
    await call({ cmd: 'settings', patch: { signer_url: mock.url } });
    const sync = mock.next((m) => m.type === 'wallet.sync');
    await t('connect (sign-in + ws)', () => call({ cmd: 'connect' }), r);
    await sync;
    await new Promise((x) => setTimeout(x, 300));
    await (fake.chrome.storage.session as any).remove(['requests', 'historyAt']);
    ((await import('../src/background/store')) as any).dropStorageCache?.();
    // a page opening while the server history is being merged (right after hello / reconnect)
    const h = call({ cmd: 'history' });
    await new Promise((x) => setTimeout(x, 5));
    await t('status while the history sync runs', () => call({ cmd: 'status' }), r);
    await h;
    await (fake.chrome.storage.session as any).remove(['requests', 'historyAt']);
    ((await import('../src/background/store')) as any).dropStorageCache?.();
    await t('history (server 200 items, cold)', () => call({ cmd: 'history' }), r);
    await t('history (warm)', () => call({ cmd: 'history' }), r);
    const N = 20;
    const s0 = performance.now();
    for (let i = 0; i < N; i++) await call({ cmd: 'status' });
    r['status (avg of 20, 200 requests in session)'] = Math.round(((performance.now() - s0) / N) * 10) / 10;
    const all = (await call({ cmd: 'status' })).accounts.map((a: any) => a.id);
    await t('balances of 6 accounts (parallel, first)', () => Promise.all(all.map((id: string) => call({ cmd: 'balances', id }))), r);
    await t('balances of 6 accounts (parallel, again)', () => Promise.all(all.map((id: string) => call({ cmd: 'balances', id }))), r);
    await t('switch account: balances of one', () => call({ cmd: 'balances', id: all[3] }), r);
    await t('ownPrepare (sign window build)', () => call({ cmd: 'ownPrepare', account_id: all[0], asset: 'USDT', to: hdAddresses(seed, 9).tron, amount: '0.1' }), r);
    await t('lock', () => call({ cmd: 'lock' }), r);
    await t('unlock (PBKDF2 600k)', () => call({ cmd: 'unlock', password: PW }), r);
    await t('first HD sign-in derivation after unlock: addAccount', () => call({ cmd: 'addAccount', name: 'late' }), r);
    if (process.env.PERF_OUT) (await import('node:fs')).writeFileSync(process.env.PERF_OUT, JSON.stringify(r, null, 1));
    console.log('PERF ' + JSON.stringify(r, null, 1));
  }, 120_000);
});
