// Security regression test (0.3.3): in E2E the nonce, fees, block and own resources are read from
// the direct node / RPC, never from the Signer; a `confirmed` job update closes the request only when the direct node sees the
// transaction in a block (failed there → failed; never seen → held as «sent», unverified).
import { installFakeChrome } from './helpers/fake-chrome';
import { startMockSigner, type MockState } from './helpers/mock-signer';
import { hdAddresses, seedFromMnemonic } from '../src/lib/wallet/derive';
import { b64u, decrypt, generateKeys, nowAt, pairProof, parseBundle, seal, verifyEnvelope, type KeyPair } from '../src/lib/e2e/crypto';
import { randomBytes } from '../src/lib/bytes';

const ABOUT = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seed = seedFromMnemonic(ABOUT);
const A0 = hdAddresses(seed, 0), A1 = hdAddresses(seed, 1);
const BOOK = hdAddresses(seed, 5).tron;
const PW = 'correct horse battery';
const st: MockState = {
  accounts: { [A0.tron]: { exists: true, balanceSun: 10_000_000, energy: 0, freeNet: 600, usdt: 0n }, [A1.tron]: { exists: true, balanceSun: 50_000_000, energy: 200_000, freeNet: 600, usdt: 5_000_000n },
    [BOOK]: { exists: true, balanceSun: 1, energy: 0, freeNet: 600, usdt: 1n } },
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
      type: 'transfer', network: 'tron', asset: 'USDT', to: BOOK, amount: '1', reason: 'r', account: 'ops', ...extra }; }
  async inbox() { const out = []; for (const e of mock.e2eSent.filter((x) => x.to === this.id)) { expect(verifyEnvelope(e, this.w.sig)).toBe(true); out.push(await decrypt(e, this.keys.kex_priv)); } return out; }
}
const envOf = (cmd: string, k: string) => new RegExp(`${k}=([^ ']+)`).exec(cmd)?.[1] ?? '';
beforeAll(async () => { mock = await startMockSigner(st); await import('../src/background/index'); const { E2E_TIMING } = await import('../src/background/e2e'); E2E_TIMING.verify_ms = 50; E2E_TIMING.verify_tries = 3; });
afterAll(async () => { await call({ cmd: 'disconnect' }).catch(() => {}); await mock.close(); });

describe('bounded trust in the Signer under E2E', () => {
  let agent!: Agent;
  const signOne = async () => {
    const q = agent.request();
    agent.push(await agent.env(q));
    await until(async () => (await call({ cmd: 'requests' })).find((r: any) => r.request_id === q.request_id));
    st.relay = [];
    const v = await call({ cmd: 'prepare', request_id: q.request_id });
    expect(v.resources.route).toBe('none'); // own energy is enough (read from the direct node)
    const jobP = mock.next((m) => m.type === 'e2e.job');
    await call({ cmd: 'sign', request_id: q.request_id, addressChecked: true });
    return { q, v, job: (await jobP).job };
  };
  const statusOf = async (id: string) => (await (await import('../src/background/e2e')).e2eRequest(id))?.status;

  it('setup; the build reads block, chain parameters and own resources from the direct node only', async () => {
    await call({ cmd: 'createWallet', mnemonic: ABOUT, password: PW });
    await call({ cmd: 'addAccount', name: 'ops' });
    await call({ cmd: 'settings', patch: { signer_url: mock.url, x402_gateway_url: `${mock.url}/gw/x402/v1`, e2e_tron_node: mock.url, e2e_reads: 'direct' } });
    const walletFp = (await call({ cmd: 'e2eEnable', on: true })).wallet_fp;
    const sync = mock.next((m) => m.type === 'wallet.sync' && m.doc?.mode === 'e2e');
    await call({ cmd: 'connect' }); await sync;
    const ops = (await call({ cmd: 'status' })).accounts.find((a: any) => a.name === 'ops').id;
    const r = await call({ cmd: 'agentCreate', name: 'claude-bot', accounts: [ops], launch: 'npx' });
    agent = new Agent(r.id, envOf(r.claude, 'DAA_WALLET'));
    agent.push(await agent.pair(envOf(r.claude, 'DAA_PAIR'), walletFp));
    await until(async () => (await agent.inbox()).find((x) => x.t === 'paired'));
    st.relay = [];
    const { q } = await signOne();
    const relayed = JSON.stringify(st.relay);
    for (const m of ['getnowblock', 'getchainparameters', 'getaccountresource']) expect(relayed).not.toContain(m);
    await call({ cmd: 'status' }); void q;
  });

  it('«confirmed» that the direct node does not see → held as broadcast (unverified), not confirmed', async () => {
    const { q, v, job } = await signOne();
    st.chain = { missing: [v.tx.txID] };
    mock.push({ type: 'e2e.job.update', id: 'u-lie', job_id: job.job_id, step: 0, state: 'confirmed', txid: v.tx.txID });
    await until(async () => (await (await import('../src/background/e2e')).e2eRequest(q.request_id))?.unverified);
    expect(await statusOf(q.request_id)).toBe('broadcast');
    // later the direct node sees it: the tick closes it
    st.chain = {};
    const { reverifyE2E } = await import('../src/background/e2e');
    mock.push({ type: 'e2e.job.update', id: 'u-note', job_id: 'none', step: 0, state: 'confirmed', txid: v.tx.txID }); // (mock: now on chain)
    await reverifyE2E();
    expect(await statusOf(q.request_id)).toBe('confirmed');
  });

  it('«confirmed», but in a block it failed → failed', async () => {
    const { q, v, job } = await signOne();
    st.chain = { failed: [v.tx.txID] };
    mock.push({ type: 'e2e.job.update', id: 'u-f', job_id: job.job_id, step: 0, state: 'confirmed', txid: v.tx.txID });
    await until(async () => (await statusOf(q.request_id)) === 'failed');
    expect((await (await import('../src/background/e2e')).e2eRequest(q.request_id)).error.code).toBe('TX_FAILED_ONCHAIN');
    st.chain = {};
  });
});
