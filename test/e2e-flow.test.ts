// E2E mode in the service worker against a mock Signer in E2E mode (no real network, nothing broadcast):
// E2E document without names / book / rules → npx agent pairs by the code → a signed request reaches the window →
// forged / replayed / expired / wrong-code envelopes are refused → signing goes to our gateway directly (Proxy) and to
// a send job → the job update closes the request → the agent reads every status from encrypted envelopes; a remote-MCP
// agent is marked and never auto-signable; reads with the recipient never reach the Signer relay.
import { installFakeChrome } from './helpers/fake-chrome';
import { startMockSigner, type MockState } from './helpers/mock-signer';
import { keylessAgent } from './helpers/keyless';
import { hdAddresses, seedFromMnemonic } from '../src/lib/wallet/derive';
import { tronToHex41 } from '../src/lib/tron/address';
import { b64u, bundleOf, decrypt, fingerprint, generateKeys, nowAt, pairProof, parseBundle, seal, verifyEnvelope, type KeyPair } from '../src/lib/e2e/crypto';
import { randomBytes } from '../src/lib/bytes';

const ABOUT = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seed = seedFromMnemonic(ABOUT);
const A0 = hdAddresses(seed, 0), A1 = hdAddresses(seed, 1);
const BOOK = hdAddresses(seed, 5).tron;
const PW = 'correct horse battery';
const REASON = 'Оплата счёта #118 поставщику';

const st: MockState = {
  accounts: {
    [A0.tron]: { exists: true, balanceSun: 10_000_000, energy: 0, freeNet: 600, usdt: 0n },
    [A1.tron]: { exists: true, balanceSun: 0, energy: 0, freeNet: 600, usdt: 5_000_000n },
    [BOOK]: { exists: true, balanceSun: 1, energy: 0, freeNet: 600, usdt: 1n },
  },
  usdcMicro: 12_500_000n, coverPrice: '0.48', energyUsed: 64_285, e2eMode: 'on',
};

const fake = installFakeChrome();
let mock: Awaited<ReturnType<typeof startMockSigner>>;
const call = fake.call;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(f: () => T | undefined | null | false | Promise<T | undefined | null | false>, ms = 8000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('until: timeout'); await wait(20); }
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

beforeAll(async () => {
  mock = await startMockSigner(st);
  await import('../src/background/index');
});
afterAll(async () => { await call({ cmd: 'disconnect' }).catch(() => {}); await mock.close(); });

describe('E2E mode', () => {
  let ops = '', agent!: Agent, walletKey = '', walletFp = '', firstReq: any;

  it('turns E2E on: wallet keys, an E2E document without names, book or rules', async () => {
    await call({ cmd: 'createWallet', mnemonic: ABOUT, password: PW });
    ops = (await call({ cmd: 'addAccount', name: 'ops' })).id;
    await call({ cmd: 'bookAdd', label: 'Склад USDT', network: 'tron', address: BOOK });
    await call({ cmd: 'settings', patch: { signer_url: mock.url, x402_gateway_url: `${mock.url}/gw/x402/v1`, e2e_tron_node: mock.url, e2e_reads: 'direct', e2e_rpc: { 8453: `${mock.url}/rpc/8453` } } });
    const v = await call({ cmd: 'e2eEnable', on: true });
    expect(v.wallet_fp).toMatch(/^([A-Z2-7]{4}-){5}[A-Z2-7]{4}$/);
    const sync = mock.next((m) => m.type === 'wallet.sync' && m.doc?.mode === 'e2e');
    await call({ cmd: 'connect' });
    const m = await sync;
    walletKey = m.doc.e2e.wallet_key; walletFp = m.doc.e2e.fp;
    expect(walletFp).toBe(v.wallet_fp);
    const txt = JSON.stringify(m);
    expect(txt).not.toContain('Склад');
    expect(txt).not.toContain('"name"');
    expect(txt).not.toContain('address_book');
    expect(m.doc.accounts.map((a: any) => a.addresses.tron)).toEqual([A0.tron, A1.tron]);
    const s = await call({ cmd: 'status' });
    expect(s.e2e.active).toBe(true);
    expect(s.e2e.server_mode).toBe('on');
  });

  it('npx agent: neutral name at the server, the command carries DAA_WALLET + a one-time DAA_PAIR', async () => {
    const created = mock.next((m) => m.type === 'agent.create');
    const r = await call({ cmd: 'agentCreate', name: 'claude-bot', accounts: [ops], launch: 'npx' });
    const m = await created;
    expect(m.name).toMatch(/^agent-[a-z0-9x]{4}$/);
    expect(m.key_mode).toBe('agent');
    expect(r.claude).toContain(`DAA_WALLET=${walletKey}`);
    expect(r.claude).toMatch(/DAA_PAIR=[A-Za-z0-9_-]{22}/);
    expect(r.claude).toContain('-- npx -y dontaskagain-mcp@0.1.4'); // 0.3.11: from npm (the site archive before)
    expect(r.e2e.wallet_fp).toBe(walletFp);
    expect(envOf(r.claude, 'DAA_URL')).toBe(mock.url);
    agent = new Agent(r.id, envOf(r.claude, 'DAA_WALLET'));
    (agent as any).code = envOf(r.claude, 'DAA_PAIR');
    // the code never reaches the Signer
    expect(JSON.stringify(mock.received)).not.toContain((agent as any).code);
  });

  it('a wrong pairing code is refused; the right one binds the key and the agent gets `paired`', async () => {
    const bad = new Agent(agent.id, agent.wallet);
    const ack1 = mock.next((m) => m.type === 'e2e.ack');
    bad.push(await bad.pair(b64u(randomBytes(16)), walletFp));
    await ack1;
    expect((await call({ cmd: 'status' })).agents.find((a: any) => a.id === agent.id).e2e).toBeNull();
    const ack2 = mock.next((m) => m.type === 'e2e.ack');
    const seq = agent.push(await agent.pair((agent as any).code, walletFp));
    expect((await ack2).seqs).toEqual([seq]);
    const paired = await until(async () => (await agent.inbox()).find((x) => x.t === 'paired'));
    const p = await paired;
    expect(p.agent_fp).toBe(fingerprint(agent.keys.sig, agent.keys.kex));
    expect(p.wallet_fp).toBe(walletFp);
    const a = (await call({ cmd: 'status' })).agents.find((x: any) => x.id === agent.id);
    expect(a.e2e).toMatchObject({ mode: 'agent', via: 'code', fp: p.agent_fp });
    expect(a.pairing).toBeNull();
    const doc = mock.docs.at(-1);
    expect(doc.doc.agents[agent.id].key.bundle).toBe(bundleOf(agent.keys));
    expect(doc.views[agent.id]).toBeTruthy();
    const view = await decrypt(doc.views[agent.id], agent.keys.kex_priv);
    expect(view.agent.name).toBe('claude-bot');
    expect(view.address_book[0].address).toBe(BOOK);
  });

  it('a signed request reaches the queue with the mark; the agent gets request.created', async () => {
    firstReq = agent.request({ account: 'ops' });
    agent.push(await agent.env(firstReq));
    const rows = await until(async () => { const r = await call({ cmd: 'requests' }); return r.length ? r : null; });
    const row = (await rows)[0];
    expect(row.request_id).toBe(firstReq.request_id);
    expect(row.e2e_mode).toBe('agent');
    expect(row.intent).toMatchObject({ asset: 'USDT', to: BOOK, amount: '1', amount_raw: '1000000' });
    const st0 = await until(async () => (await agent.inbox()).find((x) => x.t === 'status' && x.event === 'request.created'));
    expect((await st0).request.status).toBe('pending');
    expect((await st0).request.e2e).toBeUndefined();
  });

  it('forged (server key), replayed, tampered and expired envelopes never reach the window', async () => {
    const before = (await call({ cmd: 'requests' })).length;
    const forger = generateKeys();
    await agent.deliver(await agent.env(agent.request({ amount: '999' }), { signer: forger }));
    const good = await agent.env(agent.request({ amount: '2' }));
    await agent.deliver({ ...good, from: agent.id, ct: good.ct.slice(0, 20) + (good.ct[20] === 'A' ? 'B' : 'A') + good.ct.slice(21) });
    const stale = agent.request({ created_at: nowAt(new Date(Date.now() - 7200_000)), expires_at: nowAt(new Date(Date.now() - 3600_000)) });
    await agent.deliver(await agent.env(stale));
    await until(async () => (await agent.inbox()).find((x) => x.t === 'error' && x.code === 'E2E_EXPIRED'));
    expect((await call({ cmd: 'requests' })).length).toBe(before);
    const inbox = await agent.inbox();
    expect(inbox.some((x) => x.t === 'error' && x.code === 'E2E_BAD_SIGNATURE')).toBe(true);
    expect(inbox.some((x) => x.t === 'error' && x.code === 'E2E_EXPIRED' && x.ref === stale.request_id)).toBe(true);
    // replay of the very first envelope id: dropped silently
    const replay = await agent.env(agent.request(), { id: 'env_replay_test_00000001' });
    await agent.deliver(replay);
    const n1 = (await call({ cmd: 'requests' })).length;
    await agent.deliver(replay);
    expect((await call({ cmd: 'requests' })).length).toBe(n1);
    // a client_request_id reused with another body → IDEMPOTENCY_CONFLICT
    agent.push(await agent.env({ ...agent.request({ amount: '3' }), client_request_id: firstReq.client_request_id }));
    await until(async () => (await agent.inbox()).find((x) => x.t === 'error' && x.code === 'IDEMPOTENCY_CONFLICT'));
    // reject the extra one from the replay test
    const extra = (await call({ cmd: 'requests' })).find((r: any) => r.request_id !== firstReq.request_id);
    if (extra) await call({ cmd: 'reject', request_id: extra.request_id });
  });

  it('sign: Proxy through our gateway directly, a send job with the txid only, confirmed by the job update', async () => {
    st.relay = []; st.direct = { tron: [], evm: [] }; st.gw = { calls: [] };
    const v = await call({ cmd: 'prepare', request_id: firstReq.request_id });
    expect(v.blocked ?? null).toBeNull();
    expect(v.e2e).toMatchObject({ mode: 'agent' });
    expect(v.e2e.auto_allowed).toBeUndefined(); // 0.3.5: no auto-sign, whatever the key
    expect(v.resources.route).toBe('proxy');
    const jobP = mock.next((m) => m.type === 'e2e.job');
    const r = await call({ cmd: 'sign', request_id: firstReq.request_id, addressChecked: true });
    expect(r.status).toBe('signed');
    const job = await jobP;
    expect(job.steps).toBeUndefined();
    expect(job.job.steps).toEqual([{ network: 'tron', txid: v.tx.txID, external: true }]);
    const gw = st.gw!.calls.filter((c) => c.path === '/tron/send');
    expect(gw).toHaveLength(2);
    expect(gw[0].sig).toBeNull();
    expect(gw[1].sig).toBeTruthy();
    mock.push({ type: 'e2e.job.update', id: 'u1', job_id: job.job.job_id, step: 0, state: 'confirmed', txid: v.tx.txID });
    const fin = await until(async () => (await agent.inbox()).find((x) => x.t === 'status' && x.request.request_id === firstReq.request_id && x.request.status === 'confirmed'));
    expect((await fin).request.tx.tx_id).toBe(v.tx.txID);
    expect((await fin).request.resources.x402[0]).toMatchObject({ route: 'proxy', product: 'tron/send' });
    // nothing with content went to the Signer: no recipient (base58 or hex), no reason, no amount word
    const toServer = JSON.stringify([st.relay, mock.received.filter((m) => m.type !== 'e2e.send' && m.type !== 'wallet.sync')]);
    expect(toServer).not.toContain(BOOK);
    expect(toServer.toLowerCase()).not.toContain(tronToHex41(BOOK).slice(2).toLowerCase());
    expect(toServer).not.toContain('Оплата');
    // the recipient's reads went directly to the node
    expect(JSON.stringify(st.direct!.tron)).toContain(tronToHex41(BOOK).slice(2).toLowerCase());
  });

  it('Direct: energy bought from the gateway directly, then a job with the signed tx and the no-burn guard `need`', async () => {
    st.x402Quote = '0.30'; st.gw = { calls: [] };
    st.accounts[A1.tron].energy = 0;
    const q = agent.request({ account: 'ops', amount: '0.7' });
    agent.push(await agent.env(q));
    await until(async () => (await call({ cmd: 'requests' })).find((r: any) => r.request_id === q.request_id));
    const v = await call({ cmd: 'prepare', request_id: q.request_id });
    expect(v.resources.route).toBe('direct');
    const jobP = mock.next((m) => m.type === 'e2e.job');
    await call({ cmd: 'sign', request_id: q.request_id, addressChecked: true });
    const job = (await jobP).job;
    expect(job.steps).toHaveLength(1);
    expect(job.steps[0].signed.tx.txID).toBe(v.tx.txID);
    expect(job.steps[0].need.energy).toBe(v.resources.need.energy);
    expect(job.steps[0].need.accounts).toEqual([A1.tron]);
    const en = st.gw!.calls.filter((c) => c.path === '/tron/energy');
    expect(en.map((c) => !!c.sig)).toEqual([false, true]);
    expect(en[0].body).toEqual({ address: A1.tron, amount: Math.max(65_000, v.resources.deficit.energy) });
    // a catching-up update (whole job, no step) closes it after a reconnect
    mock.push({ type: 'e2e.job.update', id: 'u2', job_id: job.job_id, job_state: 'done', job: { ...job, state: 'done', steps: [{ ...job.steps[0], state: 'confirmed', txid: v.tx.txID }] } });
    await until(async () => (await agent.inbox()).find((x) => x.t === 'status' && x.request.request_id === q.request_id && x.request.status === 'confirmed'));
    delete st.x402Quote;
  });

  it('0.3.1: Proxy answered 202 processing → the payment state is followed (no second payment) → sent', async () => {
    const { E2E_TIMING } = await import('../src/background/e2e');
    const keep = { ...E2E_TIMING };
    E2E_TIMING.follow_min_ms = 20; E2E_TIMING.repeat_ms = 20;
    st.gw = { calls: [], sendProcessing: true, payState: { payment_id: 'pay_send1', status: 'fulfilled', answer: { status: 'confirmed', txid: 'from-gw', payment_id: 'pay_send1' } } };
    for (const a of Object.values(st.accounts)) a.energy = 0;
    const q = agent.request({ amount: '0.6' });
    agent.push(await agent.env(q));
    await until(async () => (await call({ cmd: 'requests' })).find((r: any) => r.request_id === q.request_id));
    const v = await call({ cmd: 'prepare', request_id: q.request_id });
    expect(v.resources.route).toBe('proxy');
    const jobP = mock.next((m) => m.type === 'e2e.job');
    await call({ cmd: 'sign', request_id: q.request_id, addressChecked: true });
    const job = (await jobP).job;
    expect(job.steps).toEqual([{ network: 'tron', txid: v.tx.txID, external: true }]);
    const calls = st.gw!.calls;
    expect(calls.filter((c) => c.path === '/tron/send' && c.sig)).toHaveLength(1);
    expect(calls.some((c) => c.path === '/payments/pay_send1' && c.method === 'GET')).toBe(true);
    mock.push({ type: 'e2e.job.update', id: 'u3', job_id: job.job_id, step: 0, state: 'confirmed', txid: v.tx.txID });
    const fin = await until(async () => (await agent.inbox()).find((x) => x.t === 'status' && x.request.request_id === q.request_id && x.request.status === 'confirmed'));
    expect((await fin).request.resources.x402[0]).toMatchObject({ route: 'proxy', product: 'tron/send', state: 'delivered', payment_id: 'pay_send1' });
    Object.assign(E2E_TIMING, keep);
    st.gw = { calls: [] };
  });

  it('cancel by the agent and rejection by the human come back as statuses', async () => {
    const q = agent.request({ amount: '0.5' });
    agent.push(await agent.env(q));
    await until(async () => (await call({ cmd: 'requests' })).find((r: any) => r.request_id === q.request_id));
    agent.push(await agent.env({ t: 'cancel', request_id: q.request_id }));
    await until(async () => (await agent.inbox()).find((x) => x.t === 'status' && x.request.request_id === q.request_id && x.request.status === 'cancelled'));
    const q2 = agent.request({ amount: '0.6' });
    agent.push(await agent.env(q2));
    await until(async () => (await call({ cmd: 'requests' })).find((r: any) => r.request_id === q2.request_id));
    await call({ cmd: 'reject', request_id: q2.request_id });
    const s = await until(async () => (await agent.inbox()).find((x) => x.t === 'status' && x.request.request_id === q2.request_id && x.request.status === 'rejected'));
    expect((await s).request.error.code).toBe('REJECTED_BY_HUMAN');
  });

  it('remote MCP agent: server keys bound at once, the request is marked and never auto-signable', async () => {
    const r = await call({ cmd: 'agentCreate', name: 'remote-bot', accounts: [ops], launch: 'remote' });
    expect(r.claude).toBe(`claude mcp add -s user --transport http dontaskagain-remote-bot ${mock.url}/mcp --header 'Authorization: Bearer ${r.token}'`);
    expect(r.e2e.key_mode).toBe('server');
    const k = mock.serverAgents[r.id];
    const remote = new Agent(r.id, walletKey);
    remote.keys = k;
    const q = remote.request({ account: 'ops' });
    remote.push(await remote.env(q));
    const row = await until(async () => (await call({ cmd: 'requests' })).find((x: any) => x.request_id === q.request_id));
    expect((await row).e2e_mode).toBe('server');
    const v = await call({ cmd: 'prepare', request_id: q.request_id });
    expect(v.e2e.mode).toBe('server');
    expect(v.e2e.auto_allowed).toBeUndefined();
    expect(v.e2e.note).toContain('удалённый MCP');
    await call({ cmd: 'reject', request_id: q.request_id });
  });

  it('an old-way agent (no key) still works on an `on` Signer, marked «без подписи агента»', async () => {
    const r = { id: await keylessAgent(call, 'legacy', [ops]) };
    mock.push({ type: 'request.new', id: 'n9', request: { request_id: 'awr_legacy1', agent: { id: r.id, name: 'legacy' }, account: { id: ops, name: 'ops', address: A1.tron },
      type: 'transfer', network: 'tron', intent: { asset: 'USDT', to: BOOK, amount: '1', amount_raw: '1000000' }, reason: 'x', status: 'pending', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString() } });
    await until(async () => (await call({ cmd: 'requests' })).find((x: any) => x.request_id === 'awr_legacy1'));
    const v = await call({ cmd: 'prepare', request_id: 'awr_legacy1' });
    expect(v.e2e.mode).toBe('none');
    const sent = mock.next((m) => m.type === 'request.reject');
    await call({ cmd: 'reject', request_id: 'awr_legacy1' });
    expect((await sent).request_id).toBe('awr_legacy1'); // the old way still talks to the Signer
  });
});
