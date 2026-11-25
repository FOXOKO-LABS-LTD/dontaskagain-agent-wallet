// Security regression test (0.3.3): a hostile own Signer forges a plaintext request in the
// name of an agent with a key — arriving while the wallet is locked, followed by a second hello «E2E off» — and it is
// refused; a real downgrade blocks even a legacy agent's request at sign time; an agent mid-pairing counts as keyed;
// an E2E request id that collides with the Signer's queue is refused.
import { installFakeChrome } from './helpers/fake-chrome';
import { startMockSigner, type MockState } from './helpers/mock-signer';
import { keylessAgent } from './helpers/keyless';
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


const forged = (id: string, agentId: string, ops: string) => ({ type: 'request.new', id: `n-${id}`, request: { request_id: id, agent: { id: agentId, name: 'whatever' }, account: { id: ops, name: 'ops' }, type: 'transfer', network: 'tron',
  intent: { asset: 'USDT', to: EVIL, amount: '2' }, reason: 'invoice 42', status: 'pending', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString() } });

describe('plaintext in the name of a keyed agent', () => {
  let ops = '', agent!: Agent, walletFp = '', legacyId = '';
  it('setup: E2E on our own Signer, an npx agent paired, a legacy agent without a key', async () => {
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
    legacyId = await keylessAgent(call, 'old-way', [ops]);
  });

  it('PoC: arrival while locked + a second hello «off» → refused at unlock, never signed', async () => {
    await call({ cmd: 'lock' });
    mock.push(forged('awr_forged_0001', agent.id, ops));
    await until(async () => (await call({ cmd: 'requests' })).some((x: any) => x.request_id === 'awr_forged_0001'));
    mock.push({ type: 'hello', id: 'h-evil', wallet_id: 'wal_test', wallet_doc_version_seen: 99, doc_service: true, e2e: { mode: 'off' }, networks: [] });
    await wait(300);
    const rej = mock.next((m) => m.type === 'request.reject' && m.request_id === 'awr_forged_0001');
    await call({ cmd: 'unlock', password: PW });
    expect((await rej).detail.code).toBe('E2E_PLAINTEXT');
    expect((await call({ cmd: 'status' })).e2e).toMatchObject({ server_mode: 'on', active: true }); // the second hello was ignored
    expect((await call({ cmd: 'requests' })).some((x: any) => x.request_id === 'awr_forged_0001')).toBe(false);
    const v = await call({ cmd: 'prepare', request_id: 'awr_forged_0001' });
    expect(v.blocked?.code).toBe('E2E_PLAINTEXT');
    await expect(call({ cmd: 'sign', request_id: 'awr_forged_0001', addressChecked: true, build_id: v.build_id })).rejects.toThrow(/NOT_PENDING|E2E_PLAINTEXT/);
    expect(mock.received.some((m) => m.type === 'request.sign' && m.request_id === 'awr_forged_0001')).toBe(false);
  });

  it('a real downgrade (reconnect with «off»): the keyed agent stays blocked, and a legacy request taken before is not signable', async () => {
    mock.push(forged('awr_legacy_1', legacyId, ops));
    await until(async () => (await call({ cmd: 'requests' })).some((x: any) => x.request_id === 'awr_legacy_1'));
    const before = await call({ cmd: 'prepare', request_id: 'awr_legacy_1' });
    expect(before.blocked).toBeNull(); // legacy policy: an agent without a key may still ask in plaintext
    st.e2eMode = 'off';
    await call({ cmd: 'disconnect' }); await call({ cmd: 'connect' }); await wait(500);
    expect((await call({ cmd: 'status' })).e2e).toMatchObject({ downgraded: true, active: false });
    mock.push(forged('awr_legacy_1', legacyId, ops)); // the Signer lists it again (`unknown` may come back to pending)
    await until(async () => (await call({ cmd: 'requests' })).some((x: any) => x.request_id === 'awr_legacy_1'));
    const v = await call({ cmd: 'prepare', request_id: 'awr_legacy_1' });
    expect(v.blocked?.code).toBe('E2E_DOWNGRADE');
    await expect(call({ cmd: 'sign', request_id: 'awr_legacy_1', addressChecked: true, build_id: before.build_id })).rejects.toThrow(/E2E_DOWNGRADE/);
    expect(mock.received.some((m) => m.type === 'request.sign' && m.request_id === 'awr_legacy_1')).toBe(false);
    // a keyed agent's forged request while unlocked: dropped at arrival
    mock.push(forged('awr_forged_0002', agent.id, ops));
    await wait(300);
    expect((await call({ cmd: 'requests' })).some((x: any) => x.request_id === 'awr_forged_0002')).toBe(false);
    st.e2eMode = 'on';
    await call({ cmd: 'disconnect' }); await call({ cmd: 'connect' }); await wait(500);
  });

  it('an agent with a pairing under way (no key yet) is keyed too: its plaintext request is blocked', async () => {
    const r = await call({ cmd: 'agentCreate', name: 'pairing-now', accounts: [ops], launch: 'npx' });
    await call({ cmd: 'lock' });
    mock.push(forged('awr_forged_0003', r.id, ops));
    await until(async () => (await call({ cmd: 'requests' })).some((x: any) => x.request_id === 'awr_forged_0003'));
    await call({ cmd: 'unlock', password: PW });
    await until(async () => !(await call({ cmd: 'requests' })).some((x: any) => x.request_id === 'awr_forged_0003'));
  });

  it('an agent request id that the Signer\'s queue already holds is refused (that request does not vanish)', async () => {
    mock.push(forged('awr_taken_1', legacyId, ops));
    await until(async () => (await call({ cmd: 'requests' })).some((x: any) => x.request_id === 'awr_taken_1'));
    const now = Date.now();
    agent.push(await agent.env({ t: 'request', request_id: 'awr_taken_1', client_request_id: 'c-taken', created_at: nowAt(new Date(now)), expires_at: nowAt(new Date(now + 3_600_000)), type: 'transfer', network: 'tron', asset: 'USDT', to: BOOK, amount: '1', account: 'ops' }));
    const err = await until<any>(async () => (await agent.inbox()).find((x) => x.t === 'error' && x.code === 'DUPLICATE_REQUEST_ID'));
    expect(err.ref).toBe('awr_taken_1');
    const v = await call({ cmd: 'prepare', request_id: 'awr_taken_1' });
    expect(v.tx?.to).toBe(EVIL); // still the Signer's own request, not overwritten
  });
});
