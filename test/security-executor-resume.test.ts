// Security regression test (0.3.3): the E2E executor survives a worker restart — its journal (the
// signed body, the jobs given to the Signer, the payments started) is in the encrypted E2E store; at the next hello it
// resumes: a job is re-attached (no second job, no second payment), a bridge whose burn is attested after the restart
// gets its mint signed and sent. Nothing leaves the process.
import { installFakeChrome } from './helpers/fake-chrome';
import { startMockSigner, type MockState } from './helpers/mock-signer';
import { attest } from './helpers/attest';
import { hdAddresses, seedFromMnemonic } from '../src/lib/wallet/derive';
import { b64u, decrypt, generateKeys, nowAt, pairProof, parseBundle, seal, verifyEnvelope, type KeyPair } from '../src/lib/e2e/crypto';
import { randomBytes } from '../src/lib/bytes';
import { keccak256 } from 'viem';
import type { Hex } from 'viem';

const ABOUT = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seed = seedFromMnemonic(ABOUT);
const A0 = hdAddresses(seed, 0), A1 = hdAddresses(seed, 1);
const BOOK = hdAddresses(seed, 5).tron;
const PW = 'correct horse battery';
const REASON = 'r';
const E = 10n ** 18n;
const TM = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d', MT = '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64';
const USDC_ARB = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const st: MockState = {
  accounts: {
    [A0.tron]: { exists: true, balanceSun: 10_000_000, energy: 0, freeNet: 600, usdt: 0n },
    [A1.tron]: { exists: true, balanceSun: 0, energy: 0, freeNet: 600, usdt: 5_000_000n },
    [BOOK]: { exists: true, balanceSun: 1, energy: 0, freeNet: 600, usdt: 1n },
  },
  usdcMicro: 12_500_000n, coverPrice: '0.48', energyUsed: 64_285, e2eMode: 'on',
  evm: { native: { 1: E, 42161: E / 100n, 10: 0n, 137: 0n, 8453: E / 100n }, usdc: { 42161: 50_000_000n, 8453: 3_000_000n }, usdt: {}, allowance: { 42161: 0n } },
};
const fake = installFakeChrome();
let mock: Awaited<ReturnType<typeof startMockSigner>>;
const call = fake.call;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(f: () => T | undefined | null | false | Promise<T | undefined | null | false>, ms = 8000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('until: timeout'); await wait(20); }
}
const pad = (h: string, n = 64) => h.replace(/^0x/, '').toLowerCase().padStart(n, '0');
const u32 = (v: number) => v.toString(16).padStart(8, '0');
function message(src: number, dst: number, amount: bigint, recipient: string) {
  return ('0x' + u32(1) + u32(src) + u32(dst) + 'dd'.repeat(32) + pad(TM) + pad(TM) + pad('0') + u32(1000) + u32(1000)
    + u32(1) + pad(USDC_ARB) + pad(recipient) + pad(amount.toString(16)) + pad(recipient) + pad('0') + pad('0') + pad('ffff')) as Hex;
}
/** The agent side: what dontaskagain-mcp does (keys, pair, request, read statuses). */
class Agent {
  keys: KeyPair = generateKeys();
  seq = 0;
  constructor(public id: string, public wallet: string) {}
  get w() { return parseBundle(this.wallet); }
  async env(payload: any, opts: { signer?: KeyPair; id?: string } = {}) {
    return seal({ id: opts.id, wallet_id: 'wal_test', from: this.id, to: 'wallet', payload, senderSigPriv: (opts.signer ?? this.keys).sig_priv, recipientKex: this.w.kex });
  }
  push(env: any) { mock.push({ type: 'e2e.envelope', id: `x${++this.seq}`, seq: 1000 + this.seq, envelope: env }); return 1000 + this.seq; }
  /** push and wait until the wallet acked it (processed) */
  async deliver(env: any) {
    const seq = 1000 + this.seq + 1;
    const acked = mock.next((m) => m.type === 'e2e.ack' && Array.isArray(m.seqs) && m.seqs.includes(seq));
    this.push(env);
    await acked;
  }
  async pair(code: string, walletFp: string) {
    const sig = b64u(this.keys.sig), kex = b64u(this.keys.kex);
    return this.env({ t: 'pair', agent_id: this.id, keys: { sig, kex }, wallet_fp: walletFp, proof: pairProof(code, { wallet_id: 'wal_test', agent_id: this.id, sig, kex, wallet_fp: walletFp }), client: { name: 'test', version: '0' } });
  }
  request(extra: any = {}) {
    const now = Date.now();
    return { t: 'request', request_id: `awr_${b64u(randomBytes(12))}`, client_request_id: `crid-${b64u(randomBytes(6))}`, created_at: nowAt(new Date(now)), expires_at: nowAt(new Date(now + 3_600_000)),
      type: 'transfer', network: 'tron', asset: 'USDT', to: BOOK, amount: '1', reason: REASON, ...extra };
  }
  /** every envelope the wallet sent to this agent, verified by the wallet key and decrypted */
  async inbox(): Promise<any[]> {
    const out = [];
    for (const e of mock.e2eSent.filter((x) => x.to === this.id)) {
      expect(verifyEnvelope(e, this.w.sig)).toBe(true);
      out.push(await decrypt(e, this.keys.kex_priv));
    }
    return out;
  }
}

const envOf = (cmd: string, k: string) => new RegExp(`${k}=([^ ']+)`).exec(cmd)?.[1] ?? '';
beforeAll(async () => { mock = await startMockSigner(st); await import('../src/background/index'); });
afterAll(async () => { await call({ cmd: 'disconnect' }).catch(() => {}); await mock.close(); });

/** What a worker restart loses: the executor's promises and waiters, the in-memory mirror (the session stays). */
async function workerRestart() {
  (await import('../src/background/e2e')).dropE2ECache();
  await call({ cmd: 'disconnect' });
  await call({ cmd: 'connect' });
}

describe('the E2E executor resumes after a restart', () => {
  let ops = '', agent!: Agent;
  it('setup', async () => {
    await call({ cmd: 'createWallet', mnemonic: ABOUT, password: PW });
    ops = (await call({ cmd: 'addAccount', name: 'ops' })).id;
    await call({ cmd: 'settings', patch: { signer_url: mock.url, x402_gateway_url: `${mock.url}/gw/x402/v1`, e2e_tron_node: mock.url, e2e_reads: 'direct', e2e_rpc: { 8453: `${mock.url}/rpc/8453`, 42161: `${mock.url}/rpc/42161` } } });
    const walletFp = (await call({ cmd: 'e2eEnable', on: true })).wallet_fp;
    const sync = mock.next((m) => m.type === 'wallet.sync' && m.doc?.mode === 'e2e');
    await call({ cmd: 'connect' }); await sync;
    const r = await call({ cmd: 'agentCreate', name: 'claude-bot', accounts: [ops], launch: 'npx' });
    agent = new Agent(r.id, envOf(r.claude, 'DAA_WALLET'));
    await agent.deliver(await agent.pair(envOf(r.claude, 'DAA_PAIR'), walletFp));
    await until(async () => (await agent.inbox()).find((x) => x.t === 'paired'));
  });

  it('Direct paid, job given, then the worker restarts: the job is re-attached — no second payment, no second job', async () => {
    st.x402Quote = '0.30'; st.gw = { calls: [] };
    const q = agent.request({ account: 'ops', amount: '0.7' });
    agent.push(await agent.env(q));
    await until(async () => (await call({ cmd: 'requests' })).find((r: any) => r.request_id === q.request_id));
    const v = await call({ cmd: 'prepare', request_id: q.request_id });
    expect(v.resources.route).toBe('direct');
    const jobP = mock.next((m) => m.type === 'e2e.job');
    await call({ cmd: 'sign', request_id: q.request_id, addressChecked: true });
    const job = (await jobP).job;
    const paid = () => st.gw!.calls.filter((c) => c.path === '/tron/energy' && c.sig).length;
    expect(paid()).toBe(1);
    const jobIds = () => new Set(mock.received.filter((m) => m.type === 'e2e.job').map((m) => m.job.job_id)).size;
    const jobs0 = jobIds();
    await workerRestart();
    await wait(800);
    expect(paid()).toBe(1);
    expect(jobIds()).toBe(jobs0); // at most the same job_id again (the Signer returns the existing job)
    mock.push({ type: 'e2e.job.update', id: 'u-r1', job_id: job.job_id, step: 0, state: 'confirmed', txid: v.tx.txID });
    await until(async () => (await agent.inbox()).find((x) => x.t === 'status' && x.request.request_id === q.request_id && x.request.status === 'confirmed'));
    delete st.x402Quote;
  });

  it('a bridge: burn attested after a worker restart → the mint is signed and sent, the bridge completes', async () => {
    const q = agent.request({ type: 'bridge', network: 'evm:42161', asset: 'USDC', from_network: 'evm:42161', to_network: 'evm:8453', amount: '20', mode: 'fast', delivery: 'self', to: undefined, account: 'ops' });
    agent.push(await agent.env(q));
    await until(async () => (await call({ cmd: 'requests' })).find((r: any) => r.request_id === q.request_id));
    const v = await call({ cmd: 'prepare', request_id: q.request_id });
    expect(v.blocked ?? null).toBeNull();
    const jobP = mock.next((m) => m.type === 'e2e.job');
    expect((await call({ cmd: 'sign', request_id: q.request_id, addressChecked: true })).status).toBe('signed');
    const job = (await jobP).job;
    expect(job.steps.length).toBeGreaterThanOrEqual(1);
    await workerRestart();
    await wait(500);
    const opsEvm = hdAddresses(seed, 1).evm;
    const msg = message(3, 6, 20_002_801n, opsEvm);
    const att = await attest(msg);
    const mintP = mock.next((m) => m.type === 'e2e.job' && m.job.steps?.[0]?.network === 'evm:8453');
    // the Signer's catching-up update after the reconnect: every step done, the burn attested
    mock.push({ type: 'e2e.job.update', id: 'u-b', job_id: job.job_id, job: { ...job, state: 'done', steps: job.steps.map((s: any, i: number) => ({ ...s, state: i === job.steps.length - 1 ? 'attested' : 'confirmed', txid: keccak256(s.signed.raw),
      ...(i === job.steps.length - 1 ? { attestation: { message: msg, attestation: att } } : {}) })) } });
    const mint = (await mintP).job;
    mock.push({ type: 'e2e.job.update', id: 'u-m', job_id: mint.job_id, step: 0, state: 'confirmed', txid: keccak256(mint.steps[0].signed.raw) });
    const fin = await until<any>(async () => (await agent.inbox()).find((x) => x.t === 'status' && x.request.request_id === q.request_id && x.request.status === 'confirmed'));
    expect(fin.request.bridge.state).toBe('done');
  }, 30_000);
});
