// Regression tests of the 0.3.2 security review, E2E mode against a hostile mock Signer — the attack
// scenarios found there now fail. Nothing leaves the process.
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

describe('audit 0.3.2 — E2E mode, hostile Signer', () => {
  let ops = '', agent!: Agent, walletFp = '', req: any;
  it('setup: E2E on, npx agent paired, signed request in the queue', async () => {
    await call({ cmd: 'createWallet', mnemonic: ABOUT, password: PW });
    ops = (await call({ cmd: 'addAccount', name: 'ops' })).id;
    await call({ cmd: 'bookAdd', label: 'SECRET-BOOK-LABEL', network: 'tron', address: BOOK });
    await call({ cmd: 'settings', patch: { signer_url: mock.url, x402_gateway_url: `${mock.url}/gw/x402/v1`, e2e_tron_node: mock.url, e2e_reads: 'direct', e2e_rpc: { 8453: `${mock.url}/rpc/8453` } } });
    walletFp = (await call({ cmd: 'e2eEnable', on: true })).wallet_fp;
    const sync = mock.next((m) => m.type === 'wallet.sync' && m.doc?.mode === 'e2e');
    await call({ cmd: 'connect' }); await sync;
    const r = await call({ cmd: 'agentCreate', name: 'claude-bot', accounts: [ops], launch: 'npx' });
    agent = new Agent(r.id, envOf(r.claude, 'DAA_WALLET'));
    agent.push(await agent.pair(envOf(r.claude, 'DAA_PAIR'), walletFp));
    await until(async () => (await agent.inbox()).find((x) => x.t === 'paired'));
    req = agent.request({ account: 'ops' });
    agent.push(await agent.env(req));
    await until(async () => (await call({ cmd: 'requests' })).length);
  });

  it('request.update / request.new from the Signer cannot rewrite an agent-signed E2E request', async () => {
    const before = await call({ cmd: 'prepare', request_id: req.request_id });
    expect(before.tx.to).toBe(BOOK);
    const orig = (await call({ cmd: 'requests' }))[0];
    mock.push({ type: 'request.update', id: 'u-evil', request_id: req.request_id, request: { request_id: req.request_id, intent: { ...orig.intent, to: EVIL } } });
    mock.push({ type: 'request.new', id: 'n-evil', request: { ...orig, intent: { ...orig.intent, to: EVIL, amount: '1000' } } });
    await wait(300);
    const v = await call({ cmd: 'prepare', request_id: req.request_id });
    expect(v.tx.to).toBe(BOOK);
    expect(v.tx.amount).toBe('1');
    expect(v.e2e.mode).toBe('agent');
    const jobP = mock.next((m) => m.type === 'e2e.job' && JSON.stringify(m.job).includes(v.tx.txID));
    expect((await call({ cmd: 'sign', request_id: req.request_id, addressChecked: true, build_id: v.build_id })).status).toBe('signed');
    await jobP;
  });

  it('a job update with a txid that is not the signed transaction fails the request instead of «confirmed»', async () => {
    const job = mock.jobs.at(-1);
    mock.push({ type: 'e2e.job.update', id: 'ju-evil', job_id: job.job_id, step: 0, state: 'confirmed', txid: 'ff'.repeat(32) });
    await until(async () => (await call({ cmd: 'op', request_id: req.request_id })).final);
    const v = await call({ cmd: 'op', request_id: req.request_id });
    expect(JSON.stringify(v)).toContain('TXID_MISMATCH');
    expect(JSON.stringify(v)).not.toContain('ff'.repeat(32));
  });

  it('E2E history on disk is ciphertext — no recipients, amounts or reasons in chrome.storage.local', async () => {
    const dump = JSON.stringify((fake.chrome.storage.local as any)._dump());
    expect(dump).toContain('e2e_enc');
    expect(dump).not.toContain(BOOK);
    expect(dump).not.toContain('SECRET-BOOK-LABEL');
    expect(((fake.chrome.storage.local as any)._dump().e2e.reqs)).toBeUndefined();
  });

  it('opening an E2E request does not tell the Signer its id (no request.seen)', async () => {
    const r2 = agent.request({ account: 'ops', amount: '0.25' });
    agent.push(await agent.env(r2));
    await until(async () => (await call({ cmd: 'requests' })).some((x: any) => x.request_id === r2.request_id));
    const n = mock.received.filter((m) => m.type === 'request.seen').length;
    await call({ cmd: 'seen', request_id: r2.request_id });
    await wait(100);
    expect(mock.received.filter((m) => m.type === 'request.seen').length).toBe(n);
  });

  it('a plaintext request in the name of an agent that has a key is dropped / blocked (E2E on own Signer)', async () => {
    mock.push({ type: 'request.new', id: 'n-pl', request: { request_id: 'awr_plain_1', agent: { id: agent.id, name: 'claude-bot' }, account: { id: ops, name: 'ops' }, type: 'transfer', network: 'tron',
      intent: { asset: 'USDT', to: EVIL, amount: '2' }, status: 'pending', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString(), e2e: { key_mode: 'agent', fp: 'X', confirmed: true } } });
    await wait(200);
    expect((await call({ cmd: 'requests' })).some((x: any) => x.request_id === 'awr_plain_1')).toBe(false); // dropped at once
    // a locked wallet cannot check at arrival: then the window blocks it (the plate is «no agent signature», never ✓)
    const { checkAgent } = await import('../src/background/agentCheck');
    const { vault } = await (await import('../src/background/wallet')).requireUnlocked();
    expect(checkAgent({ agent: { id: agent.id }, type: 'transfer', account: { id: ops } }, vault, ops, { e2eId: false, e2eInUse: true }).blocked).toMatchObject({ code: 'E2E_PLAINTEXT' });
  });

  it('the Signer\'s request.pay for an E2E request is refused (only our executor pays)', async () => {
    const before = mock.received.filter((m) => m.type === 'request.pay_signed').length;
    mock.push({ type: 'request.pay', id: 'pay-evil', request_id: req.request_id, pay_id: 'pe1', purpose: 'resources', route: 'direct', payment_required_raw: 'x', resource_url: 'https://api.awesomefee.com/x402/v1/tron/energy' });
    await wait(200);
    expect(mock.received.filter((m) => m.type === 'request.pay_signed').length).toBe(before);
  });

  it('request.list from the Signer does not hide pending E2E requests', async () => {
    const r2 = agent.request({ account: 'ops', amount: '0.5' });
    agent.push(await agent.env(r2));
    await until(async () => (await call({ cmd: 'requests' })).some((x: any) => x.request_id === r2.request_id));
    mock.push({ type: 'request.list', id: 'l-evil', requests: [] });
    await wait(300);
    const rows = await call({ cmd: 'requests' });
    expect(rows.some((x: any) => x.request_id === r2.request_id)).toBe(true);
  });

  it('agent.list cannot inject an agent that the root key would then sign into the document', async () => {
    (st as any).agentList = [{ id: 'ag_evil', name: 'evil', accounts: [ops], token_prefix: 'aw_ag_evil_AAAA', created_at: nowAt() }];
    await call({ cmd: 'agentsRefresh' });
    const s = await call({ cmd: 'status' });
    expect(s.agents.find((a: any) => a.id === 'ag_evil')).toBeUndefined();
    const sync = mock.next((m) => m.type === 'wallet.sync');
    await call({ cmd: 'renameAccount', id: ops, name: 'ops2' });
    expect(Object.keys((await sync).doc.agents)).not.toContain('ag_evil');
    delete (st as any).agentList;
  });

  it('a hello without E2E is a downgrade — no plaintext document, a visible flag, plaintext requests dropped', async () => {
    st.e2eMode = undefined;
    await call({ cmd: 'disconnect' });
    await call({ cmd: 'connect' });
    await wait(500);
    const s = await call({ cmd: 'status' });
    expect(s.e2e).toMatchObject({ active: false, wanted: true, downgraded: true, server_mode: 'off' });
    const n = mock.received.filter((m) => m.type === 'wallet.sync').length;
    await call({ cmd: 'renameAccount', id: ops, name: 'ops3' });
    await wait(200);
    const syncs = mock.received.filter((m) => m.type === 'wallet.sync');
    expect(syncs.length).toBe(n);
    expect(JSON.stringify(mock.received)).not.toContain('SECRET-BOOK-LABEL');
    await expect(call({ cmd: 'agentCreate', name: 'real-name', accounts: [ops] })).rejects.toThrow(/E2E_DOWNGRADE/);
    await expect(call({ cmd: 'ownPrepare', account_id: ops, asset: 'USDT', to: BOOK, amount: '0.1' }).then((v: any) => call({ cmd: 'ownSign', own_id: v.key, addressChecked: true }))).rejects.toThrow(/E2E_DOWNGRADE/);
    mock.push({ type: 'request.new', id: 'n-down', request: { request_id: 'awr_down_1', agent: { id: agent.id, name: 'x' }, account: { id: ops, name: 'ops' }, type: 'transfer', network: 'tron',
      intent: { asset: 'USDT', to: EVIL, amount: '2' }, status: 'pending', expires_at: new Date(Date.now() + 3600_000).toISOString() } });
    await wait(200);
    expect((await call({ cmd: 'requests' })).some((x: any) => x.request_id === 'awr_down_1')).toBe(false);
  });

  it('only the human turns E2E off; then the old mode works again', async () => {
    await call({ cmd: 'e2eEnable', on: false });
    const s = await call({ cmd: 'status' });
    expect(s.e2e).toMatchObject({ wanted: false, downgraded: false });
    st.e2eMode = 'on';
  });
});
