// Security regression test (0.3.3): forged envelopes cannot fill chrome.storage — hard sizes in
// checkShape, no replay-set entry for an envelope without a valid signature, a bounded locked inbox, bounded request.pay
// and pending queue.
import { installFakeChrome } from './helpers/fake-chrome';
import { startMockSigner, type MockState } from './helpers/mock-signer';
import { hdAddresses, seedFromMnemonic } from '../src/lib/wallet/derive';
import { b64u, checkShape, decrypt, generateKeys, nowAt, pairProof, parseBundle, seal, verifyEnvelope, type KeyPair } from '../src/lib/e2e/crypto';

const ABOUT = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seed = seedFromMnemonic(ABOUT);
const A0 = hdAddresses(seed, 0);
const PW = 'correct horse battery';
const st: MockState = { accounts: { [A0.tron]: { exists: true, balanceSun: 10_000_000, energy: 0, freeNet: 600, usdt: 0n } }, usdcMicro: 12_500_000n, coverPrice: '0.48', energyUsed: 64_285, e2eMode: 'on' };
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
  async inbox() { const out = []; for (const e of mock.e2eSent.filter((x) => x.to === this.id)) { expect(verifyEnvelope(e, this.w.sig)).toBe(true); out.push(await decrypt(e, this.keys.kex_priv)); } return out; }
}
const envOf = (cmd: string, k: string) => new RegExp(`${k}=([^ ']+)`).exec(cmd)?.[1] ?? '';
beforeAll(async () => { mock = await startMockSigner(st); await import('../src/background/index'); });
afterAll(async () => { await call({ cmd: 'disconnect' }).catch(() => {}); await mock.close(); });

describe('storage cannot be filled by forged envelopes', () => {
  let agent!: Agent;
  const size = (a: any) => JSON.stringify(a._dump()).length;

  it('checkShape: sizes are hard (id, keys, nonce, signature, ciphertext)', async () => {
    const k = generateKeys();
    const good = await seal({ wallet_id: 'wal_test', from: 'ag_1', to: 'wallet', payload: { t: 'x' }, senderSigPriv: k.sig_priv, recipientKex: k.kex });
    expect(() => checkShape(good)).not.toThrow();
    for (const bad of [{ id: 'A'.repeat(65) }, { from: 'x'.repeat(100) }, { epk: 'x' }, { sig: 'x' }, { n: 'x' }, { rk: 'x' }, { ct: 'B'.repeat(200_000) }, { id: 'bad id\n' }])
      expect(() => checkShape({ ...good, ...bad })).toThrow(/E2E_BAD_ENVELOPE/);
  });

  it('PoC: 1 MB ids from the agent → nothing stored; a valid-shape forgery is not added to the replay set', async () => {
    await call({ cmd: 'createWallet', mnemonic: ABOUT, password: PW });
    const ops = (await call({ cmd: 'addAccount', name: 'ops' })).id;
    await call({ cmd: 'settings', patch: { signer_url: mock.url, x402_gateway_url: `${mock.url}/gw/x402/v1`, e2e_tron_node: mock.url, e2e_reads: 'direct' } });
    const walletFp = (await call({ cmd: 'e2eEnable', on: true })).wallet_fp;
    const sync = mock.next((m) => m.type === 'wallet.sync' && m.doc?.mode === 'e2e');
    await call({ cmd: 'connect' }); await sync;
    const r = await call({ cmd: 'agentCreate', name: 'claude-bot', accounts: [ops], launch: 'npx' });
    agent = new Agent(r.id, envOf(r.claude, 'DAA_WALLET'));
    agent.push(await agent.pair(envOf(r.claude, 'DAA_PAIR'), walletFp));
    await until(async () => (await agent.inbox()).find((x) => x.t === 'paired'));
    const before = size(fake.chrome.storage.local);
    for (let i = 0; i < 6; i++) mock.push({ type: 'e2e.envelope', id: `f${i}`, seq: 5000 + i, envelope: { v: 'daa-e2e-1', id: `env_${i}_` + 'A'.repeat(1_000_000), wallet_id: 'wal_test', from: agent.id, to: 'wallet', at: nowAt(), epk: 'x', rk: 'x', n: 'x', ct: 'x', sig: 'x' } });
    // the right shape, someone else's key (the server forging the agent)
    const other = generateKeys();
    for (let i = 0; i < 20; i++) mock.push({ type: 'e2e.envelope', id: `g${i}`, seq: 5100 + i, envelope: await seal({ wallet_id: 'wal_test', from: agent.id, to: 'wallet', payload: { t: 'request' }, senderSigPriv: other.sig_priv, recipientKex: agent.w.kex }) });
    await wait(1500);
    expect(size(fake.chrome.storage.local) - before).toBeLessThan(20_000);
    const seen = (fake.chrome.storage.local as any)._dump().e2e?.seen ?? {};
    expect(Object.keys(seen).every((k) => k.length <= 64)).toBe(true);
    expect(Object.keys(seen).some((k) => k.startsWith('env_0_'))).toBe(false);
    const errors = (await agent.inbox()).filter((x) => x.t === 'error' && x.code === 'E2E_BAD_SIGNATURE');
    expect(errors.length).toBe(1); // rate-limited answers
  });

  it('locked: the inbox is bounded; over the limit nothing is stored or acked', async () => {
    await call({ cmd: 'lock' });
    const sb = size(fake.chrome.storage.session);
    const other = generateKeys();
    const acks0 = mock.received.filter((m) => m.type === 'e2e.ack').length;
    for (let i = 0; i < 80; i++) mock.push({ type: 'e2e.envelope', id: `l${i}`, seq: 6000 + i, envelope: await seal({ wallet_id: 'wal_test', from: 'nobody', to: 'wallet', payload: { pad: 'B'.repeat(40_000) }, senderSigPriv: other.sig_priv, recipientKex: agent.w.kex }) });
    await wait(1500);
    const inbox = (fake.chrome.storage.session as any)._dump().e2eInbox ?? {};
    expect(Object.keys(inbox).length).toBeLessThanOrEqual(50);
    expect(size(fake.chrome.storage.session) - sb).toBeLessThan(1_700_000);
    expect(mock.received.filter((m) => m.type === 'e2e.ack').length).toBe(acks0);
    await call({ cmd: 'unlock', password: PW });
  });
});
