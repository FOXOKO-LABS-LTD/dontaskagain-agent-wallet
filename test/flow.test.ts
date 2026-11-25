// End-to-end flow of the service worker against a mock Signer (no real network, nothing broadcast):
// create wallet → second account → sign-in → wallet.sync → agent → book → request.new → prepare → sign → request.pay.
import { getAddress, verifyTypedData } from 'viem';
import { installFakeChrome } from './helpers/fake-chrome';
import { startMockSigner, type MockState } from './helpers/mock-signer';
import { decodeRaw } from '../src/lib/tron/tx';
import { recoverTronTxSigner } from '../src/lib/sign';
import { hdAddresses, seedFromMnemonic } from '../src/lib/wallet/derive';
import { AUTH_TYPES } from '../src/lib/x402/pay';
import { base64ToBytes, bytesToBase64, fromUtf8, utf8 } from '../src/lib/bytes';

const ABOUT = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seed = seedFromMnemonic(ABOUT);
const A0 = hdAddresses(seed, 0), A1 = hdAddresses(seed, 1);
const BOOK = hdAddresses(seed, 5).tron;
const STRANGER = hdAddresses(seed, 6).tron; // not an account of this wallet
const PAYTO = '0x16dDE7b0A9b092c4Dd985af5D9Ca04e389b3c87E';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PW = 'correct horse battery';

const st: MockState = {
  accounts: {
    [A0.tron]: { exists: true, balanceSun: 10_000_000, energy: 0, freeNet: 600, usdt: 0n },
    [A1.tron]: { exists: true, balanceSun: 0, energy: 0, freeNet: 600, usdt: 5_000_000n },
    [BOOK]: { exists: true, balanceSun: 1, energy: 0, freeNet: 600, usdt: 1n },
    [STRANGER]: { exists: true, balanceSun: 1, energy: 0, freeNet: 600, usdt: 1n },
  },
  usdcMicro: 12_500_000n, coverPrice: '0.48', energyUsed: 64_285,
};

const fake = installFakeChrome();
let mock: Awaited<ReturnType<typeof startMockSigner>>;
const call = fake.call;

const pr402 = (amount: string, path = '/x402/v1/tron/send') => bytesToBase64(utf8(JSON.stringify({ x402Version: 2, resource: { url: `http://127.0.0.1:9975${path}` },
  accepts: [{ scheme: 'exact', network: 'eip155:8453', amount, asset: USDC, payTo: PAYTO, maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } }] })));

beforeAll(async () => {
  mock = await startMockSigner(st);
  await import('../src/background/index');
});
afterAll(async () => { await call({ cmd: 'disconnect' }).catch(() => {}); await mock.close(); });

describe('service worker flow', () => {
  let ops = '', agentId = '';

  it('creates the wallet and a second account (index 1)', async () => {
    await call({ cmd: 'createWallet', mnemonic: ABOUT, password: PW });
    const a = await call({ cmd: 'addAccount', name: 'ops' });
    ops = a.id;
    const s = await call({ cmd: 'status' });
    expect(s.unlocked).toBe(true);
    expect(s.accounts.map((x: any) => [x.name, x.addresses.tron, x.addresses.evm])).toEqual([['main', A0.tron, A0.evm], ['ops', A1.tron, A1.evm]]);
    const disk = JSON.stringify((fake.chrome.storage.local as any)._dump());
    expect(disk).not.toContain('abandon');
  });

  it('signs in by signature, gets hello, sends a signed wallet document', async () => {
    await call({ cmd: 'settings', patch: { signer_url: mock.url } });
    const sync = mock.next((m) => m.type === 'wallet.sync');
    await call({ cmd: 'connect' });
    const m = await sync;
    await new Promise((x) => setTimeout(x, 300));
    expect(m.doc.wallet_id).toBe('wal_test');
    expect(m.doc.version).toBe(1);
    expect(m.doc.accounts).toHaveLength(2);
    expect(mock.docs).toHaveLength(1);
    const s = await call({ cmd: 'status' });
    expect(s.signer.connected).toBe(true);
    expect(s.signer.server_networks_diff.some((d: string) => d.startsWith('evm:999'))).toBe(true);
  });

  it('creates an agent bound to ops; token returned once; document v2 carries the binding', async () => {
    const r = await call({ cmd: 'agentCreate', name: 'claude-bot', accounts: [ops] });
    agentId = r.id;
    expect(r.token).toMatch(/^aw_/);
    expect(r.claude).toContain('_TOKEN=' + r.token); // the token goes to the connect command once
    await new Promise((x) => setTimeout(x, 50));
    const last = mock.docs.at(-1);
    expect(last.doc.version).toBe(2);
    expect(last.doc.agents[agentId].accounts).toEqual([ops]);
    expect(JSON.stringify((fake.chrome.storage.local as any)._dump())).not.toContain(r.token);
  });

  it('book entry, then a request from the agent: proxy plan, both prices, ceiling', async () => {
    await call({ cmd: 'bookAdd', label: 'Склад USDT', network: 'tron', address: BOOK });
    mock.push({ type: 'request.new', id: 'n1', request: { request_id: 'awr_1', agent: { id: agentId, name: 'claude-bot' }, account: { id: ops, name: 'ops', address: A1.tron },
      type: 'transfer', network: 'tron', intent: { asset: 'USDT', to: BOOK, amount: '1', amount_raw: '1000000', resources: { route: 'auto', payment: { method: 'x402_base' }, max_cost_usdc: '1.00' } },
      reason: 'Оплата счёта #118', status: 'pending', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString() }, preview: { decision: 'human' } });
    await new Promise((x) => setTimeout(x, 300));
    expect(fake.windows.length).toBeGreaterThan(0);
    const rows = await call({ cmd: 'requests' });
    expect(rows.map((r: any) => r.request_id)).toEqual(['awr_1']);
    const v = await call({ cmd: 'prepare', request_id: 'awr_1' });
    expect(v.blocked).toBeNull();
    expect(v.tx).toMatchObject({ asset: 'USDT', amount: '1', from: A1.tron, to: BOOK });
    expect(v.to_check.in_book.label).toBe('Склад USDT');
    expect(v.resources.need.energy).toBe(73_928);
    expect(v.resources.route).toBe('proxy');
    expect(v.resources.quotes.proxy.cost_usdc).toBe('0.48');
    expect(v.resources.quotes.direct.ok).toBe(false);
    expect(v.resources.approved_max_usdc).toBe('0.576');
    expect(v.tx.fee_limit_trx).toBe('30');
  });

  it('signs: request.sign carries a tx signed by ops and the resource plan', async () => {
    const got = mock.next((m) => m.type === 'request.sign');
    const r = await call({ cmd: 'sign', request_id: 'awr_1', addressChecked: false });
    expect(r.status).toBe('signed');
    const m = await got;
    const tx = m.signed.tx;
    const d = decodeRaw(tx.raw_data_hex);
    expect(d.txID).toBe(tx.txID);
    expect(d.owner).toBe(A1.tron);
    expect(d.trc20).toEqual({ to: BOOK, amountRaw: 1_000_000n });
    expect(await recoverTronTxSigner(tx.txID, tx.signature[0])).toBe(A1.tron);
    expect(d.expiration - d.timestamp).toBe(600_000);
    expect(m.resource_plan).toMatchObject({ route: 'proxy', payment_method: 'x402_base', approved_max_usdc: '0.576', counted_in_limit: false, quotes: { proxy: '0.48' } });
    expect(m.decision).toMatchObject({ by: 'human', rule: null });
  });

  it('request.pay within the ceiling → EIP-3009 from the ops Base address, no window', async () => {
    const got = mock.next((m) => m.type === 'request.pay_signed');
    mock.push({ type: 'request.pay', request_id: 'awr_1', pay_id: 'pay_1', purpose: 'resources', route: 'proxy', payment_required_raw: pr402('500000'), resource_url: 'http://127.0.0.1:9975/x402/v1/tron/send' });
    const m = await got;
    expect(m.pay_id).toBe('pay_1');
    const p = JSON.parse(fromUtf8(base64ToBytes(m.payment_signature)));
    const a = p.payload.authorization;
    expect(a.from).toBe(A1.evm);
    expect(a.to).toBe(getAddress(PAYTO));
    expect(a.value).toBe('500000');
    expect(await verifyTypedData({ address: A1.evm, domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC }, types: AUTH_TYPES, primaryType: 'TransferWithAuthorization',
      message: { from: A1.evm, to: getAddress(PAYTO), value: 500000n, validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce }, signature: p.payload.signature })).toBe(true);
  });

  it('the same pay_id again → the same signature; a second 402 above the remaining ceiling → refused', async () => {
    const first = mock.received.filter((m) => m.type === 'request.pay_signed').at(-1);
    const again = mock.next((m) => m.type === 'request.pay_signed');
    mock.push({ type: 'request.pay', request_id: 'awr_1', pay_id: 'pay_1', purpose: 'resources', route: 'proxy', payment_required_raw: pr402('500000'), resource_url: 'http://127.0.0.1:9975/x402/v1/tron/send' });
    expect((await again).payment_signature).toBe(first.payment_signature);
    const rej = mock.next((m) => m.type === 'request.reject');
    mock.push({ type: 'request.pay', request_id: 'awr_1', pay_id: 'pay_2', purpose: 'resources', route: 'proxy', payment_required_raw: pr402('100000'), resource_url: 'http://127.0.0.1:9975/x402/v1/tron/send' });
    expect((await rej).reason_code).toBe('resource_above_max');
  });

  it('refuses a 402 with a foreign payTo or a product of another route', async () => {
    mock.push({ type: 'request.new', id: 'n2', request: { request_id: 'awr_2', agent: { id: agentId, name: 'claude-bot' }, account: { id: ops, name: 'ops' }, type: 'transfer', network: 'tron',
      intent: { asset: 'USDT', to: BOOK, amount: '0.5' }, status: 'pending', expires_at: new Date(Date.now() + 3600_000).toISOString() } });
    await new Promise((x) => setTimeout(x, 300));
    await call({ cmd: 'prepare', request_id: 'awr_2' });
    await call({ cmd: 'sign', request_id: 'awr_2', addressChecked: false });
    const rej = mock.next((m) => m.type === 'request.reject' && m.request_id === 'awr_2');
    mock.push({ type: 'request.pay', request_id: 'awr_2', pay_id: 'pay_3', route: 'proxy', payment_required_raw: pr402('100000', '/x402/v1/tron/energy'), resource_url: 'http://127.0.0.1:9975/x402/v1/tron/energy' });
    expect((await rej).reason_code).toBe('unsafe');
  });

  it('first transfer needs the tick; book match; no resource and no USDC → cannot sign', async () => {
    // 0.2.2: an own account is a trusted recipient — no tick
    const mine = await call({ cmd: 'ownPrepare', account_id: ops, asset: 'USDT', to: A0.tron, amount: '0.1' });
    expect(mine.to_check).toMatchObject({ own: { name: 'main' }, first_time: false });
    const v = await call({ cmd: 'ownPrepare', account_id: ops, asset: 'USDT', to: STRANGER, amount: '0.1' });
    expect(v.to_check.first_time).toBe(true);
    expect(v.to_check.own).toBeUndefined();
    await expect(call({ cmd: 'ownSign', own_id: v.key, addressChecked: false })).rejects.toThrow(/ADDRESS_NOT_CHECKED/);
    const chk = await call({ cmd: 'bookCheck', network: 'tron', address: BOOK });
    expect(chk.match.label).toBe('Склад USDT');
    // look-alike detection itself is covered by test/similar.test.ts (a real poisoned address cannot be derived cheaply)
    st.usdcMicro = 0n;
    const v2 = await call({ cmd: 'ownPrepare', account_id: ops, asset: 'USDT', to: BOOK, amount: '0.1' });
    expect(v2.blocked.code).toBe('RESOURCE_PAYMENT_FAILED');
    st.usdcMicro = 12_500_000n;
    st.coverPrice = null;
    const v3 = await call({ cmd: 'ownPrepare', account_id: ops, asset: 'USDT', to: BOOK, amount: '0.1' });
    expect(v3.blocked.reason_code).toBe('resource_unavailable');
    st.coverPrice = '0.48';
  });

  it('TRX to a non-activated address: Proxy tron/send activates the recipient in one payment (the default)', async () => {
    const { setReceiverActivationProxyAllowed } = await import('../src/lib/swap/config');
    setReceiverActivationProxyAllowed(true);
    const fresh = hdAddresses(seed, 7).tron;
    const v = await call({ cmd: 'ownPrepare', account_id: (await call({ cmd: 'status' })).accounts[0].id, asset: 'TRX', to: fresh, amount: '1' });
    expect(v.resources.activate.recipient).toBe(true);
    expect(v.blocked).toBeNull();
    expect(v.resources.route).toBe('proxy');
    expect(v.resources.buy.activate).toContain(fresh);
    expect(v.resources.quotes.proxy.parts).toEqual({ activate: '0.339790', bandwidth: '0.083095' });
  });

  it('TRX to a non-activated address in the Direct-only mode (receiver_activation_proxy_allowed:false): tron/activate', async () => {
    const { setReceiverActivationProxyAllowed } = await import('../src/lib/swap/config');
    setReceiverActivationProxyAllowed(false);
    const fresh = hdAddresses(seed, 7).tron;
    const prevQ = st.x402Quote;
    st.x402Quote = '0.30';
    const v = await call({ cmd: 'ownPrepare', account_id: (await call({ cmd: 'status' })).accounts[0].id, asset: 'TRX', to: fresh, amount: '1' });
    st.x402Quote = prevQ;
    setReceiverActivationProxyAllowed(true);
    expect(v.resources.activate.recipient).toBe(true);
    expect(v.blocked).toBeNull();
    expect(v.resources.route).toBe('direct');
    expect(v.resources.fallback_route).toBeNull();
    expect(v.resources.quotes.proxy).toMatchObject({ ok: false, code: 'RESOURCE_ROUTE_NOT_ALLOWED' });
    expect(v.resources.buy.activate).toContain(fresh);
  });

  it('own transfer with enough resources: route none, own.submit', async () => {
    st.accounts[A1.tron].energy = 100_000;
    const v = await call({ cmd: 'ownPrepare', account_id: ops, asset: 'USDT', to: BOOK, amount: '0.2' });
    expect(v.resources.route).toBe('none');
    const got = mock.next((m) => m.type === 'own.submit');
    const r = await call({ cmd: 'ownSign', own_id: v.key, addressChecked: false });
    expect(r.request_id).toBe('awr_own1');
    const m = await got;
    expect(m.resource_plan).toMatchObject({ route: 'none' }); // 0.3.0: + need (the E2E executor's no-burn guard; the Signer ignores it)
    expect(m.account).toBe(ops);
    st.accounts[A1.tron].energy = 0;
  });

  // ---- repeat plate, pause, history ----
  it('the same agent → same recipient + asset within 30 min: the window gets a repeat plate', async () => {
    mock.push({ type: 'request.new', id: 'n3', request: { request_id: 'awr_3', agent: { id: agentId, name: 'claude-bot' }, account: { id: ops, name: 'ops' }, type: 'transfer', network: 'tron',
      intent: { asset: 'USDT', to: BOOK, amount: '0.5' }, status: 'pending', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString() } });
    await new Promise((x) => setTimeout(x, 300));
    const v = await call({ cmd: 'prepare', request_id: 'awr_3' });
    expect(v.repeat).toMatchObject({ minutes_ago: 0, status: 'signed', amount: '0.5 USDT' });
    expect(v.repeat.count).toBeGreaterThanOrEqual(2); // awr_1 and awr_2
  });

  it('history: decided agent requests and own transfers, with who decided', async () => {
    const h = await call({ cmd: 'history', account_id: ops });
    const own = h.find((x: any) => x.request_id === 'awr_own1');
    expect(own).toMatchObject({ own: true, by: 'human', status: 'signed', intent: { asset: 'USDT', to: BOOK, amount: '0.2' } });
    expect(h.find((x: any) => x.request_id === 'awr_1')).toMatchObject({ by: 'human', status: 'signed' });
    expect(h.some((x: any) => x.request_id === 'awr_3')).toBe(false); // still pending
  });

  it('pause of all agents on the Signer (wallet.pause): waiting requests leave the queue; a request still arriving is refused locally with reason_code paused', async () => {
    const got = mock.next((m) => m.type === 'wallet.pause');
    const r = await call({ cmd: 'pauseAgents', paused: true });
    expect(await got).toMatchObject({ paused: true });
    expect(r).toMatchObject({ paused: true, server: true, rejected: 1 });
    expect(st.paused).toBe(true);
    expect((await call({ cmd: 'requests' })).some((x: any) => x.request_id === 'awr_3')).toBe(false);
    expect((await call({ cmd: 'status' })).settings.agents_paused).toBe(true);
    const windows = fake.windows.length;
    const rej4 = mock.next((m) => m.type === 'request.reject' && m.request_id === 'awr_4');
    mock.push({ type: 'request.new', id: 'n4', request: { request_id: 'awr_4', agent: { id: agentId, name: 'claude-bot' }, account: { id: ops, name: 'ops' }, type: 'transfer', network: 'tron',
      intent: { asset: 'TRX', to: BOOK, amount: '1' }, status: 'pending', expires_at: new Date(Date.now() + 3600_000).toISOString() } });
    expect(await rej4).toMatchObject({ reason_code: 'paused' });
    await new Promise((x) => setTimeout(x, 300)); // the local mark follows the Signer's ack
    expect(fake.windows.length).toBe(windows);
    expect((await call({ cmd: 'requests' })).length).toBe(0);
    expect((await call({ cmd: 'history' })).find((x: any) => x.request_id === 'awr_4')).toMatchObject({ by: 'pause', status: 'rejected' });
    // a settings patch cannot lift the pause; only pauseAgents → wallet.resume
    await call({ cmd: 'settings', patch: { agents_paused: false } });
    expect((await call({ cmd: 'status' })).settings.agents_paused).toBe(true);
    const res = mock.next((m) => m.type === 'wallet.resume');
    await call({ cmd: 'pauseAgents', paused: false });
    await res;
    expect(st.paused).toBe(false);
    expect((await call({ cmd: 'status' })).settings.agents_paused).toBe(false);
  });

  it('after a restart: hello carries the server pause, GET /v1/ext/history refills History and the repeat plate', async () => {
    const old = new Date(Date.now() - 5 * 60_000).toISOString();
    st.history = [
      { request_id: 'awr_old1', agent: { id: agentId, name: 'claude-bot' }, account: { id: ops, name: 'ops' }, type: 'transfer', network: 'tron', intent: { asset: 'USDT', to: BOOK, amount: '7' },
        status: 'confirmed', decision: { by: 'human' }, created_at: old },
      { request_id: 'awr_oldr', agent: null, account: { id: ops, name: 'ops' }, type: 'tron_resource', network: 'tron', intent: { action: 'buy', product: 'tron/energy', amount: 65000 },
        status: 'failed', error: { code: 'NO_CAPACITY' }, decision: { by: 'human' }, created_at: old },
    ];
    st.paused = true;
    await (fake.chrome.storage.session as any).remove(['requests', 'historyAt']); // the browser was closed
    (await import('../src/background/store')).dropStorageCache();
    await call({ cmd: 'disconnect' });
    await call({ cmd: 'connect' });
    for (let i = 0; i < 100 && !(await call({ cmd: 'status' })).settings.agents_paused; i++) await new Promise((x) => setTimeout(x, 50)); // hello under a loaded run
    expect((await call({ cmd: 'status' })).settings.agents_paused).toBe(true);
    const h = await call({ cmd: 'history', account_id: ops });
    // 0.3.3: «decided by the human» only from the wallet's own marks — the server's word is «server»
    expect(h.find((x: any) => x.request_id === 'awr_old1')).toMatchObject({ by: 'server', status: 'confirmed', own: false });
    expect(h.find((x: any) => x.request_id === 'awr_oldr')).toMatchObject({ own: true, status: 'failed', message: 'NO_CAPACITY' });
    // a new request of the same agent to the same recipient in USDT → plate from the server history
    st.paused = false;
    await call({ cmd: 'pauseAgents', paused: false });
    mock.push({ type: 'request.new', id: 'n5', request: { request_id: 'awr_5', agent: { id: agentId, name: 'claude-bot' }, account: { id: ops, name: 'ops' }, type: 'transfer', network: 'tron',
      intent: { asset: 'USDT', to: BOOK, amount: '7' }, status: 'pending', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString() } });
    await new Promise((x) => setTimeout(x, 150));
    const v = await call({ cmd: 'prepare', request_id: 'awr_5' });
    expect(v.repeat).toMatchObject({ request_id: 'awr_old1', minutes_ago: 5, status: 'confirmed' });
    await call({ cmd: 'reject', request_id: 'awr_5' });
    st.history = [];
  });

  it('0.3.5: a new agent has no auto-sign rules or spend; old limits sent by a page are ignored', async () => {
    const r = await call({ cmd: 'agentCreate', name: 'limits-bot', accounts: [ops], limits: { transfer: { per_tx: { 'tron/USDT': '10' } } } });
    const a = (await call({ cmd: 'status' })).agents.find((x: any) => x.id === r.id);
    expect(a.rules).toBeUndefined();
    expect(a.spent_24h).toBeUndefined();
    await new Promise((x) => setTimeout(x, 50));
    expect(mock.docs.at(-1).doc.agents[r.id]).toEqual({ name: 'limits-bot', accounts: [ops], allowed_types: expect.any(Array) });
    expect(r.claude).toContain('claude mcp add -s user dontaskagain-limits-bot ');
  });

  it('separate purchase of bandwidth (Direct, own.resource): quote, ceiling, then request.pay within it', async () => {
    st.x402Quote = '0.09';
    await expect(call({ cmd: 'resourceQuote', account_id: ops, product: 'bandwidth', amount: 100 })).rejects.toThrow(/BAD_AMOUNT/);
    const q = await call({ cmd: 'resourceQuote', account_id: ops, product: 'bandwidth', amount: 600 });
    expect(q).toMatchObject({ price_usdc: '0.09', approved_max_usdc: '0.108', address: A1.tron });
    const got = mock.next((m) => m.type === 'own.resource');
    const r = await call({ cmd: 'buyResource', account_id: ops, product: 'bandwidth', amount: 600, approved_max_usdc: q.approved_max_usdc });
    expect(r.request_id).toBe('awr_res1');
    expect(await got).toMatchObject({ account: ops, product: 'tron/bandwidth', address: A1.tron, amount: 600, resource_plan: { route: 'direct', approved_max_usdc: '0.108', buy: { bandwidth: 600 } } });
    const paid = mock.next((m) => m.type === 'request.pay_signed' && m.request_id === 'awr_res1');
    mock.push({ type: 'request.pay', request_id: 'awr_res1', pay_id: 'pay_r1', purpose: 'resources', route: 'direct', payment_required_raw: pr402('90000', '/x402/v1/tron/bandwidth'), resource_url: 'http://127.0.0.1:9975/x402/v1/tron/bandwidth' });
    expect((await paid).payer).toBe(A1.evm);
    const rej = mock.next((m) => m.type === 'request.reject' && m.request_id === 'awr_res1');
    mock.push({ type: 'request.pay', request_id: 'awr_res1', pay_id: 'pay_r2', purpose: 'resources', route: 'direct', payment_required_raw: pr402('90000', '/x402/v1/tron/bandwidth'), resource_url: 'http://127.0.0.1:9975/x402/v1/tron/bandwidth' });
    expect((await rej).reason_code).toBe('resource_above_max');
    // the Signer reports delivery checked on chain → confirmed; a failure carries its code
    mock.push({ type: 'request.update', id: 'u_r1', request_id: 'awr_res1', status: 'confirmed', resources: { state: 'delivered' } });
    await new Promise((x) => setTimeout(x, 300));
    expect((await call({ cmd: 'history', account_id: ops })).find((x: any) => x.request_id === 'awr_res1')).toMatchObject({ status: 'confirmed', own: true, type: 'tron_resource' });
    mock.push({ type: 'request.update', id: 'u_r2', request_id: 'awr_res1', status: 'failed', error: { code: 'ADDRESS_NOT_ACTIVATED', detail: { buy_activate: true } } });
    await new Promise((x) => setTimeout(x, 300));
    expect((await call({ cmd: 'history', account_id: ops })).find((x: any) => x.request_id === 'awr_res1')).toMatchObject({ status: 'failed', message: 'ADDRESS_NOT_ACTIVATED' });
    st.x402Quote = '0.5';
    await expect(call({ cmd: 'buyResource', account_id: ops, product: 'energy', amount: 65000, approved_max_usdc: '0.1' })).rejects.toThrow(/PRICE_CHANGED/);
    delete (st as any).x402Quote;
  });

  it('lock: no signing; unlock with a wrong password fails', async () => {
    await call({ cmd: 'lock' });
    await expect(call({ cmd: 'prepare', request_id: 'awr_5' })).rejects.toThrow(/LOCKED/);
    await expect(call({ cmd: 'unlock', password: 'wrong password!' })).rejects.toThrow('BAD_PASSWORD');
    await call({ cmd: 'unlock', password: PW });
    expect((await call({ cmd: 'status' })).unlocked).toBe(true);
  });
});
