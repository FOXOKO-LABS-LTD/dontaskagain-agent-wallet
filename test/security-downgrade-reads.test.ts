// Security regression test (0.3.3): when E2E is wanted, reads with a recipient or an amount never go
// through the Signer — also after a hello «off» (a downgrade) and before the first hello after a worker restart; the
// human's own forms are refused before any read.
import { installFakeChrome } from './helpers/fake-chrome';
import { startMockSigner, type MockState } from './helpers/mock-signer';
import { hdAddresses, seedFromMnemonic } from '../src/lib/wallet/derive';
import { b64u, decrypt, generateKeys, nowAt, pairProof, parseBundle, seal, verifyEnvelope, type KeyPair } from '../src/lib/e2e/crypto';
import { randomBytes } from '../src/lib/bytes';

const ABOUT = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seed = seedFromMnemonic(ABOUT);
const A0 = hdAddresses(seed, 0), A1 = hdAddresses(seed, 1);
const BOOK = hdAddresses(seed, 5).tron;
const EVIL = hdAddresses(seed, 9).tron;
const PW = 'correct horse battery';
const st: MockState = {
  accounts: {
    [A0.tron]: { exists: true, balanceSun: 10_000_000, energy: 0, freeNet: 600, usdt: 0n },
    [A1.tron]: { exists: true, balanceSun: 0, energy: 0, freeNet: 600, usdt: 5_000_000n },
    [BOOK]: { exists: true, balanceSun: 1, energy: 0, freeNet: 600, usdt: 1n },
    [EVIL]: { exists: true, balanceSun: 1, energy: 0, freeNet: 600, usdt: 1n },
  },
  usdcMicro: 12_500_000n, coverPrice: '0.48', energyUsed: 64_285, e2eMode: 'on',
};
const fake = installFakeChrome();
let mock: Awaited<ReturnType<typeof startMockSigner>>;
const call = fake.call;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(f: () => any, ms = 8000): Promise<T> { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('until: timeout'); await wait(20); } }
class Agent {
  keys: KeyPair = generateKeys(); seq = 0;
  constructor(public id: string, public wallet: string) {}
  get w() { return parseBundle(this.wallet); }
  env(payload: any) { return seal({ wallet_id: 'wal_test', from: this.id, to: 'wallet', payload, senderSigPriv: this.keys.sig_priv, recipientKex: this.w.kex }); }
  push(env: any) { mock.push({ type: 'e2e.envelope', id: `x${++this.seq}`, seq: 1000 + this.seq, envelope: env }); }
  pair(code: string, walletFp: string) { const sig = b64u(this.keys.sig), kex = b64u(this.keys.kex);
    return this.env({ t: 'pair', agent_id: this.id, keys: { sig, kex }, wallet_fp: walletFp, proof: pairProof(code, { wallet_id: 'wal_test', agent_id: this.id, sig, kex, wallet_fp: walletFp }) }); }
  request(extra: any = {}) { const now = Date.now();
    return { t: 'request', request_id: `awr_${b64u(randomBytes(12))}`, client_request_id: `crid-${b64u(randomBytes(6))}`, created_at: nowAt(new Date(now)), expires_at: nowAt(new Date(now + 3_600_000)),
      type: 'transfer', network: 'tron', asset: 'USDT', to: BOOK, amount: '1', reason: 'r', ...extra }; }
  async inbox() { const out = []; for (const e of mock.e2eSent.filter((x) => x.to === this.id)) { expect(verifyEnvelope(e, this.w.sig)).toBe(true); out.push(await decrypt(e, this.keys.kex_priv)); } return out; }
}
const envOf = (cmd: string, k: string) => new RegExp(`${k}=([^ ']+)`).exec(cmd)?.[1] ?? '';
beforeAll(async () => { mock = await startMockSigner(st); await import('../src/background/index'); });
afterAll(async () => { await call({ cmd: 'disconnect' }).catch(() => {}); await mock.close(); });


describe('no content to the Signer under a downgrade', () => {
  let ops = '', agent!: Agent, walletFp = '';
  const leak = (to: string) => (st.relay ?? []).filter((x: any) => JSON.stringify(x).includes(to) || JSON.stringify(x).includes('1234567') || JSON.stringify(x).toLowerCase().includes((1234567).toString(16).padStart(64, '0')));
  it('setup', async () => {
    await call({ cmd: 'createWallet', mnemonic: ABOUT, password: PW });
    ops = (await call({ cmd: 'addAccount', name: 'ops' })).id;
    await call({ cmd: 'settings', patch: { signer_url: mock.url, x402_gateway_url: `${mock.url}/gw/x402/v1`, e2e_tron_node: mock.url, e2e_reads: 'direct', e2e_rpc: { 8453: `${mock.url}/rpc/8453` } } });
    walletFp = (await call({ cmd: 'e2eEnable', on: true })).wallet_fp;
    const sync = mock.next((m) => m.type === 'wallet.sync' && m.doc?.mode === 'e2e');
    await call({ cmd: 'connect' }); await sync;
    const r = await call({ cmd: 'agentCreate', name: 'claude-bot', accounts: [ops], launch: 'npx' });
    agent = new Agent(r.id, envOf(r.claude, 'DAA_WALLET'));
    agent.push(await agent.pair(envOf(r.claude, 'DAA_PAIR'), walletFp));
    await until(async () => (await agent.inbox()).find((x) => x.t === 'paired'));
  });

  it('after a downgrade the E2E request is built with direct reads only; own forms are refused', async () => {
    const req = agent.request({ to: EVIL, amount: '1.234567', account: 'ops' });
    agent.push(await agent.env(req));
    await until(async () => (await call({ cmd: 'requests' })).length);
    st.relay = [];
    await call({ cmd: 'prepare', request_id: req.request_id });
    expect(leak(EVIL)).toHaveLength(0);
    st.e2eMode = 'off';
    await call({ cmd: 'disconnect' }); await call({ cmd: 'connect' }); await wait(500);
    expect((await call({ cmd: 'status' })).e2e).toMatchObject({ server_mode: 'off', downgraded: true });
    st.relay = [];
    const v = await call({ cmd: 'prepare', request_id: req.request_id });
    expect(v.e2e?.mode).toBe('agent');
    expect(v.tx?.to).toBe(EVIL);
    expect(leak(EVIL)).toHaveLength(0);
    st.relay = [];
    await expect(call({ cmd: 'ownPrepare', account_id: ops, asset: 'USDT', to: EVIL, amount: '0.5' })).rejects.toThrow(/E2E_DOWNGRADE/);
    await expect(call({ cmd: 'swapPrepare', account_id: ops, asset_in: 'USDT', asset_out: 'TRX', amount_in: '1', slippage_bps: 50 })).rejects.toThrow(/E2E_DOWNGRADE/);
    expect(st.relay ?? []).toHaveLength(0);
    st.e2eMode = 'on';
    await call({ cmd: 'disconnect' }); await call({ cmd: 'connect' }); await wait(500);
  });

  it('before the first hello after a worker restart (mode unknown): still direct', async () => {
    const req = agent.request({ to: EVIL, amount: '1.234567', account: 'ops', client_request_id: 'c-unknown' });
    agent.push(await agent.env(req));
    await until(async () => (await call({ cmd: 'requests' })).some((x: any) => x.request_id === req.request_id));
    const { setServerMode, getServerMode } = await import('../src/background/e2e');
    setServerMode('unknown');
    expect(getServerMode()).toBe('unknown');
    st.relay = [];
    const v = await call({ cmd: 'prepare', request_id: req.request_id });
    expect(v.tx?.to).toBe(EVIL);
    expect(leak(EVIL)).toHaveLength(0);
  });
});
