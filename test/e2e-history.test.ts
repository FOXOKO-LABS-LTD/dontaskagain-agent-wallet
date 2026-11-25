// 0.3.12: history and the operation page in E2E (a public Signer that requires E2E, everything read through the Signer):
// own operations live in the wallet's encrypted local history (with steps and txids) and survive a browser restart;
// token movements of the EVM address come from the chain (Transfer logs, bounded filter) and open their own page;
// the operation page follows every step and the end is a notification; statuses are brought in line with the chain
// (a mint stuck at `minting`, a «not seen in time» failure of a successful transaction); a read that fails is never
// «not found». The real service worker on the in-memory chrome.* + the mock Signer (nothing leaves the machine).
import { createServer } from 'node:http';
import { installFakeChrome } from './helpers/fake-chrome';
import { startMockSigner, type MockState } from './helpers/mock-signer';
import { hdAddresses, seedFromMnemonic } from '../src/lib/wallet/derive';
import { TRANSFER_TOPIC, chainOpView, logsFilters, parseLogs, txidsOf, windowRanges, LOGS_CHUNK } from '../src/lib/chain/history';
import { pruneE2EHistory, E2E_HISTORY_MAX } from '../src/lib/e2e/retention';
import { evmReadIsSafe, DirectEvmReader } from '../src/lib/e2e/reads';
import { evmRpcsOf } from '../src/lib/wallet/model';

const ABOUT = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PW = 'correct horse battery';
const seed = seedFromMnemonic(ABOUT);
const A0 = hdAddresses(seed, 0), BOOK = hdAddresses(seed, 5).tron;
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const STRANGER = '0x1111111111111111111111111111111111111111';
const word = (a: string) => `0x${'0'.repeat(24)}${a.toLowerCase().slice(2)}`;
const TX_IN = `0x${'a1'.repeat(32)}`, TX_OUT = `0x${'b2'.repeat(32)}`;
const HEAD = 0x200000;

const st: MockState = {
  accounts: { [A0.tron]: { exists: true, balanceSun: 50_000_000, energy: 0, freeNet: 600, usdt: 5_000_000n }, [BOOK]: { exists: true, balanceSun: 1, energy: 0, freeNet: 600, usdt: 1n } },
  usdcMicro: 12_500_000n, coverPrice: '0.48', energyUsed: 64_285, e2eMode: 'required',
  evm: { native: {}, usdc: {} }, head: HEAD,
  logs: {
    8453: [
      { address: BASE_USDC, topics: [TRANSFER_TOPIC, word(STRANGER), word(A0.evm)], data: '0x' + (5_000_000).toString(16), blockNumber: '0x' + (HEAD - 100).toString(16), transactionHash: TX_IN, logIndex: '0x3' },
      { address: BASE_USDC, topics: [TRANSFER_TOPIC, word(A0.evm), word(STRANGER)], data: '0x' + (2_000_000).toString(16), blockNumber: '0x' + (HEAD - 15_000).toString(16), transactionHash: TX_OUT, logIndex: '0x0' },
      // another token contract / another address: never taken
      { address: '0x2222222222222222222222222222222222222222', topics: [TRANSFER_TOPIC, word(STRANGER), word(A0.evm)], data: '0x1', blockNumber: '0x' + (HEAD - 5).toString(16), transactionHash: `0x${'c3'.repeat(32)}`, logIndex: '0x0' },
    ],
  },
};

const fake = installFakeChrome();
const call = fake.call;
let mock: Awaited<ReturnType<typeof startMockSigner>>;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(f: () => T | undefined | null | false | Promise<T | undefined | null | false>, ms = 8000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('until: timeout'); await wait(20); }
}
let acc = '';

beforeAll(async () => { mock = await startMockSigner(st); await import('../src/background/index'); });
afterAll(async () => { await call({ cmd: 'disconnect' }).catch(() => {}); await mock.close(); });

describe('history and operation page in E2E (0.3.12)', () => {
  it('setup: public-style Signer (E2E required), every read through the Signer', async () => {
    await call({ cmd: 'createWallet', mnemonic: ABOUT, password: PW });
    await call({ cmd: 'settings', patch: { signer_url: mock.url, x402_gateway_url: `${mock.url}/gw/x402/v1`, e2e_reads: 'signer' } });
    await call({ cmd: 'e2eEnable', on: true });
    await call({ cmd: 'connect' });
    const s = await until(async () => { const x = await call({ cmd: 'status' }); return x.e2e?.active && x; });
    expect(s.e2e.server_mode).toBe('required');
    acc = s.accounts[0].id;
  });

  let rid = '', txid = '';
  it('own TRON transfer: the page shows its steps with the tx link, follows them live, a notification opens it', async () => {
    const v = await call({ cmd: 'ownPrepare', account_id: acc, asset: 'TRX', to: BOOK, amount: '1' });
    expect(v.blocked ?? null).toBeNull();
    const jobP = mock.next((m) => m.type === 'e2e.job');
    const r = await call({ cmd: 'ownSign', own_id: v.key, addressChecked: true });
    rid = r.request_id; txid = v.tx.txID;
    expect(rid).toMatch(/^awr_own_/);
    const job = await jobP;
    const op1 = await call({ cmd: 'op', request_id: rid });
    expect(op1.steps.map((x: any) => x.key)).toEqual(['send', 'confirm']);
    expect(op1.final).toBe(false);
    const sent: any[] = [];
    const orig = fake.chrome.runtime.sendMessage;
    fake.chrome.runtime.sendMessage = async (m: any) => { sent.push(m); return orig(m); };
    mock.push({ type: 'e2e.job.update', id: 'u1', job_id: job.job.job_id, step: 0, state: 'confirmed', txid });
    const op2 = await until(async () => { const o = await call({ cmd: 'op', request_id: rid }); return o.final && o; });
    fake.chrome.runtime.sendMessage = orig;
    expect(op2.status).toBe('confirmed');
    expect(op2.steps.find((x: any) => x.key === 'send').tx.url).toBe(`https://tronscan.org/#/transaction/${txid}`);
    expect(op2.steps.every((x: any) => x.state === 'done')).toBe(true);
    // pages were told at each change (the page re-reads on `changed`, not only on a status change)
    expect(sent.some((m) => m?.event === 'changed')).toBe(true);
    // the end is a notification that opens the operation page
    const n = fake.notifications.find((x) => x[0] === `op:${rid}`);
    expect(n?.[1].title).toBe('Перевод выполнен');
  });

  it('openOp opens the operation page in its own window (from the sign window while more requests wait)', async () => {
    const created: any[] = [];
    const orig = fake.chrome.windows.create;
    fake.chrome.windows.create = async (o: any) => { created.push(o); return { id: 99 }; };
    await call({ cmd: 'openOp', request_id: rid });
    fake.chrome.windows.create = orig;
    expect(created[0].url).toBe(`chrome-extension://${fake.chrome.runtime.id}/popup.html#/op/${encodeURIComponent(rid)}`);
  });

  it('history of the account: own operation + chain rows (in and out), the chain page; the filter is the bounded form', async () => {
    st.relay = [];
    await call({ cmd: 'history', account_id: acc });
    const rows = await until(async () => { const h = await call({ cmd: 'history', account_id: acc }); return h.some((x: any) => x.chain) && h; });
    const own = rows.find((x: any) => x.request_id === rid);
    expect(own).toMatchObject({ own: true, status: 'confirmed' });
    const chain = rows.filter((x: any) => x.chain);
    expect(chain.map((x: any) => [x.chain.dir, x.intent.amount, x.intent.asset, x.network])).toEqual([['in', '5', 'USDC', 'evm:8453'], ['out', '2', 'USDC', 'evm:8453']]);
    expect(chain[0].chain.counterparty).toBe(STRANGER);
    // the page of a chain row
    const op = await call({ cmd: 'op', request_id: chain[0].request_id });
    expect(op.title).toBe('Получено 5 USDC');
    expect(op.status).toBe('confirmed');
    expect(op.steps[0].tx.url).toBe(`https://basescan.org/tx/${TX_IN}`);
    // what went to the relay: eth_getLogs with the Transfer topic, own address only, ≤ 10 000 blocks
    const logs = (st.relay as any[]).filter((x) => x.body?.method === 'eth_getLogs').map((x) => x.body.params[0]);
    expect(logs.length).toBeGreaterThan(0);
    for (const f of logs) {
      expect(f.topics[0]).toBe(TRANSFER_TOPIC);
      expect(Number.parseInt(f.toBlock, 16) - Number.parseInt(f.fromBlock, 16)).toBeLessThanOrEqual(LOGS_CHUNK);
      expect(JSON.stringify(f.topics.slice(1))).toContain(A0.evm.toLowerCase().slice(2));
    }
    // nothing of the own TRON operation went to the Signer in plaintext (recipient)
    expect(JSON.stringify(st.relay)).not.toContain(BOOK);
    const cs = await call({ cmd: 'chainStatus', account_id: acc });
    expect(cs.loading).toBe(false);
  });

  it('a chain row whose txid a local operation carries is not shown twice', async () => {
    const { setE2EReq } = await import('../src/background/e2e');
    await setE2EReq({ request_id: 'awr_own_evmtransfer01', own: true, type: 'transfer', network: 'evm:8453', status: 'confirmed', account: { id: acc, name: 'x' },
      intent: { asset: 'USDC', to: STRANGER, amount: '2' }, tx: { network: 'evm:8453', tx_id: TX_OUT }, created_at: new Date().toISOString(), e2e: { own: true } });
    const rows = await call({ cmd: 'history', account_id: acc });
    expect(rows.filter((x: any) => x.chain?.txid === TX_OUT)).toHaveLength(0);
    expect(rows.some((x: any) => x.request_id === 'awr_own_evmtransfer01')).toBe(true);
  });

  it('a browser restart: the encrypted local history comes back at unlock', async () => {
    const e2e = await import('../src/background/e2e');
    const store = await import('../src/background/store');
    const wallet = await import('../src/background/wallet');
    expect(JSON.stringify(fake.chrome.storage.local._dump().e2e_enc ?? null)).not.toContain(BOOK); // ciphertext on disk
    await call({ cmd: 'lock' });
    await fake.chrome.storage.session.clear(); e2e.dropE2ECache(); store.dropStorageCache();
    void wallet;
    await call({ cmd: 'unlock', password: PW });
    const rows = await until(async () => { const h = await call({ cmd: 'history', account_id: acc }); return h.some((x: any) => x.request_id === rid) && h; });
    expect(rows.find((x: any) => x.request_id === rid).status).toBe('confirmed');
    const op = await call({ cmd: 'op', request_id: rid });
    expect(op.steps.find((x: any) => x.key === 'send').tx.hash).toBe(txid);
  });

  it('a bridge stuck at `minting` whose mint is in a block closes as confirmed by the chain', async () => {
    const e2e = await import('../src/background/e2e');
    Object.assign(e2e.RECONCILE_TIMING, { stuck_ms: 0, failed_ms: 0 });
    const MINT = '0x395b62721e2bb4250b5625e08112c75ae6010a4dbb058c4c0aadf7da09f3ad4f';
    await e2e.setE2EReq({ request_id: 'awr_bridge_stuck0001', own: true, type: 'bridge', network: 'evm:8453', status: 'broadcast', account: { id: acc, name: 'x' }, created_at: new Date().toISOString(), e2e: { own: true },
      intent: { asset: 'USDC', from_network: 'evm:8453', to_network: 'evm:42161', amount: '1' },
      bridge: { from_network: 'evm:8453', to_network: 'evm:42161', state: 'minting', steps: [{ step: 'burn', status: 'confirmed', tx: { tx_id: `0x${'d4'.repeat(32)}` } }, { step: 'mint', status: 'broadcast', tx: { tx_id: MINT } }] } });
    expect(await e2e.reconcileE2E()).toBe(0); // not on chain yet: stays
    st.chain = { ok: [MINT] };
    expect(await e2e.reconcileE2E()).toBe(1);
    const op = await call({ cmd: 'op', request_id: 'awr_bridge_stuck0001' });
    expect(op.status).toBe('confirmed');
    expect(op.steps.find((x: any) => x.key === 'mint').state).toBe('done');
    // a late failure from the Signer's tracker never turns it back
    const r = await e2e.e2eRequest('awr_bridge_stuck0001');
    expect(r.bridge.state).toBe('done');
  });

  it('«failed: not seen in time» of a successful transaction is corrected to confirmed; other failures stay', async () => {
    const e2e = await import('../src/background/e2e');
    const TX = 'd3ad38d62c13e6ca5b4961b0eeaa2224dfdc58c62927de1182d83f490ca5e01e';
    await e2e.setE2EReq({ request_id: 'awr_XVz6IL-t_NosPlGYU-XFcg', type: 'transfer', network: 'tron', status: 'failed', account: { id: acc, name: 'x' }, created_at: new Date().toISOString(),
      intent: { asset: 'TRX', to: BOOK, amount: '0.1' }, tx: { network: 'tron', tx_id: TX }, error: { code: 'TX_NOT_FOUND_ONCHAIN', message: 'never saw it' }, e2e: { agent_id: 'none' } });
    await e2e.setE2EReq({ request_id: 'awr_realfailure000001', type: 'transfer', network: 'tron', status: 'failed', account: { id: acc, name: 'x' }, created_at: new Date().toISOString(),
      intent: { asset: 'TRX', to: BOOK, amount: '0.1' }, tx: { network: 'tron', tx_id: TX }, error: { code: 'TX_FAILED_ONCHAIN', message: 'reverted' }, e2e: { agent_id: 'none' } });
    st.chain = { ok: [TX] };
    await e2e.reconcileE2E();
    expect((await e2e.e2eRequest('awr_XVz6IL-t_NosPlGYU-XFcg'))).toMatchObject({ status: 'confirmed', error: null, corrected: { from: 'failed', code: 'TX_NOT_FOUND_ONCHAIN' } });
    expect((await e2e.e2eRequest('awr_realfailure000001')).status).toBe('failed');
  });

  it('confirmation reads refused by the Signer: past the hold it stays `broadcast`, never «failed» unchecked', async () => {
    const e2e = await import('../src/background/e2e');
    const TX = 'e5'.repeat(32);
    await e2e.setE2EReq({ request_id: 'awr_unverified000001', type: 'transfer', network: 'tron', status: 'broadcast', account: { id: acc, name: 'x' }, created_at: new Date().toISOString(),
      intent: { asset: 'TRX', to: BOOK, amount: '0.1' }, tx: { network: 'tron', tx_id: TX }, e2e: { agent_id: 'none' },
      unverified: { network: 'tron', txid: TX, patch: { tx: { network: 'tron', tx_id: TX } }, until: Date.now() - 1000 } });
    st.refuse = ['/v1/ext/net/tron/gettransactioninfobyid'];
    await e2e.reverifyE2E();
    expect((await e2e.e2eRequest('awr_unverified000001')).status).toBe('broadcast');
    // the read works and the transaction is not there: now it is a failure
    st.refuse = [];
    st.chain = {};
    await e2e.reverifyE2E();
    expect((await e2e.e2eRequest('awr_unverified000001'))).toMatchObject({ status: 'failed', error: { code: 'TX_NOT_FOUND_ONCHAIN' } });
    // …and it is still corrected if the chain shows it later
    st.chain = { ok: [TX] };
    await e2e.reconcileE2E();
    expect((await e2e.e2eRequest('awr_unverified000001')).status).toBe('confirmed');
  });
});

describe('pure parts (0.3.12)', () => {
  it('window: newest first, ≤ 10 000 blocks per call, ≤ 3 calls per direction', () => {
    expect(windowRanges(1_000_000, 'evm:1')).toEqual([[992_801, 1_000_000]]); // a day of 12 s blocks = 7 200
    const base = windowRanges(1_000_000, 'evm:8453');
    expect(base).toHaveLength(3);
    for (const [a, b] of base) expect(b - a).toBeLessThanOrEqual(LOGS_CHUNK);
    expect(base[0][1]).toBe(1_000_000);
    expect(base[1][1]).toBe(base[0][0] - 1);
  });

  it('parse: only listed tokens and the own address; amounts by decimals; malformed logs skipped', () => {
    const me = '0x9858effd232b4033e47d90003d41ec34ecaeda94';
    const tokens = [{ symbol: 'USDC', address: BASE_USDC, decimals: 6 }];
    const rows = parseLogs([
      { address: BASE_USDC, topics: [TRANSFER_TOPIC, word(STRANGER), word(me)], data: '0x' + (1_234_567).toString(16), blockNumber: '0x10', transactionHash: TX_IN, logIndex: '0x1' },
      { address: BASE_USDC, topics: [TRANSFER_TOPIC, word(STRANGER), word(STRANGER)], data: '0x1', blockNumber: '0x10', transactionHash: TX_IN, logIndex: '0x2' },
      { address: BASE_USDC, topics: [TRANSFER_TOPIC, word(me)], data: '0x1', blockNumber: '0x10', transactionHash: TX_IN, logIndex: '0x3' },
      { address: BASE_USDC, topics: [TRANSFER_TOPIC, word(STRANGER), word(me)], data: '0x1', blockNumber: '0x10', transactionHash: 'bad', logIndex: '0x4' },
      { address: BASE_USDC, topics: [TRANSFER_TOPIC, word(STRANGER), word(me)], data: '0x1', blockNumber: '0x10', transactionHash: TX_OUT, logIndex: '0x5', removed: true },
    ], { accountId: 'a', network: 'evm:8453', address: me, tokens });
    expect(rows.map((r) => [r.dir, r.amount, r.log_index])).toEqual([['in', '1.234567', 1]]);
    expect(chainOpView({ ...rows[0], at: Date.now() }).steps[0].tx?.url).toBe(`https://basescan.org/tx/${TX_IN}`);
  });

  it('the filter the wallet builds is what the E2E read classifier calls safe; a foreign address is not', () => {
    const me = '0x9858effd232b4033e47d90003d41ec34ecaeda94';
    const known = { tron: new Set<string>(), evm: new Set([me]), tronContracts: new Set<string>(), evmContracts: new Set([BASE_USDC]) };
    for (const p of logsFilters(me, [{ symbol: 'USDC', address: BASE_USDC, decimals: 6 }], [1, 10_001])) expect(evmReadIsSafe('eth_getLogs', p, known)).toBe(true);
    expect(evmReadIsSafe('eth_getLogs', logsFilters(STRANGER, [{ symbol: 'USDC', address: BASE_USDC, decimals: 6 }], [1, 2])[0], known)).toBe(false);
    expect(evmReadIsSafe('eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x5000', address: [BASE_USDC], topics: [TRANSFER_TOPIC, word(me)] }], known)).toBe(false); // > 10 000
    expect(evmReadIsSafe('eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x2', address: [STRANGER], topics: [TRANSFER_TOPIC, word(me)] }], known)).toBe(false);
  });

  it('txids of a request: tx, steps, mint — with or without 0x', () => {
    const s = txidsOf({ tx: { tx_id: TX_IN }, bridge: { steps: [{ tx: { tx_id: TX_OUT.slice(2) } }] }, other: 'short' });
    expect([...s].sort()).toEqual([TX_IN.slice(2), TX_OUT.slice(2)].sort());
  });

  it('retention: final operations ≤ 90 days and ≤ 300, under way never dropped', () => {
    const now = Date.parse('2026-11-25T12:00:00Z');
    const reqs: Record<string, any> = {};
    for (let i = 0; i < E2E_HISTORY_MAX + 20; i++) reqs[`f${i}`] = { status: 'confirmed', updated_at: new Date(now - i * 60_000).toISOString() };
    reqs.old = { status: 'failed', updated_at: new Date(now - 91 * 86_400_000).toISOString() };
    reqs.live = { status: 'broadcast', updated_at: new Date(now - 200 * 86_400_000).toISOString() };
    const dropped = pruneE2EHistory(reqs, now);
    expect(reqs.live).toBeTruthy();
    expect(reqs.old).toBeUndefined();
    expect(reqs.f0).toBeTruthy();
    expect(reqs[`f${E2E_HISTORY_MAX}`]).toBeUndefined();
    expect(dropped).toContain('old');
    // the byte cap: big entries — the oldest go first
    const big: Record<string, any> = {};
    for (let i = 0; i < 30; i++) big[`b${i}`] = { status: 'confirmed', updated_at: new Date(now - i * 1000).toISOString(), pad: 'x'.repeat(50_000) };
    pruneE2EHistory(big, now);
    expect(JSON.stringify(big).length).toBeLessThanOrEqual(1_000_000);
    expect(big.b0).toBeTruthy();
    expect(big.b29).toBeUndefined();
  });

  it('direct EVM reads: several RPCs, the next one after a refusal (publicnode -32602) or a missing receipt', async () => {
    const answers = [
      { error: { code: -32602, message: 'Archive requests require a personal token' } },
      { result: null },
      { result: { status: '0x1', blockNumber: '0x1f707c8b' } },
    ];
    const hits: number[] = [];
    const srv = createServer((req, res) => {
      const i = Number(req.url!.slice(1));
      hits.push(i);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, ...answers[i] }));
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(srv.address() as any).port}`;
    const rd = new DirectEvmReader(() => [`${base}/0`, `${base}/1`, `${base}/2`]);
    expect(await rd.rpc(42161, 'eth_getTransactionReceipt', ['0x395b'])).toMatchObject({ status: '0x1' });
    expect(hits).toEqual([0, 1, 2]);
    await expect(new DirectEvmReader(() => [`${base}/0`]).rpc(42161, 'eth_chainId', [])).rejects.toThrow(/personal token/);
    expect(await new DirectEvmReader(() => [`${base}/0`, `${base}/1`]).rpc(42161, 'eth_getTransactionReceipt', ['0x1'])).toBeNull();
    await new Promise((r) => srv.close(r));
    // the list of a network: the human's own, the built-in, the official fallback
    expect(evmRpcsOf({ e2e_rpc: { 42161: 'https://my.rpc' } }, 42161)).toEqual(['https://my.rpc', 'https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc']);
  });
});
