// Swap through the service worker against the mock Signer: quote, own swap USDT → TRX (approve + execute,
// own.swap), a step's request.pay under the parent's approval, an agent's swap TRX → USDT (one step, request.sign
// with steps). Nothing leaves the process.
import { installFakeChrome } from './helpers/fake-chrome';
import { startMockSigner, type MockState } from './helpers/mock-signer';
import { hdAddresses, seedFromMnemonic } from '../src/lib/wallet/derive';
import { swapConfig } from '../src/lib/swap/config';
import { verifyApprove, verifySwap } from '../src/lib/swap/verify';
import { bytesToBase64, utf8 } from '../src/lib/bytes';
import qUT from './fixtures/sunio-quote-usdt-trx.json';
import qTU from './fixtures/sunio-quote-trx-usdt.json';

const ABOUT = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seed = seedFromMnemonic(ABOUT);
const A0 = hdAddresses(seed, 0);
const c = swapConfig();
const st: MockState = {
  accounts: {
    [A0.tron]: { exists: true, balanceSun: 500_000_000, energy: 0, freeNet: 600, usdt: 200_000_000n },
    TU3rMHyWHzeEJBReWLzHko728hbz6MtfNg: { exists: true, balanceSun: 1, energy: 1_000_000_000, freeNet: 0, usdt: 0n },
  },
  usdcMicro: 12_500_000n, coverPrice: '0.48', energyUsed: 40_000,
  swapQuotes: [...qUT.data, ...qTU.data], allowance: 7n, x402Quote: '0.30',
};
const fake = installFakeChrome();
const call = fake.call;
let mock: Awaited<ReturnType<typeof startMockSigner>>;
const PAYTO = '0x16dDE7b0A9b092c4Dd985af5D9Ca04e389b3c87E';
const pr402 = (amount: string) => bytesToBase64(utf8(JSON.stringify({ x402Version: 2, resource: { url: 'http://127.0.0.1:9975/x402/v1/tron/send' },
  accepts: [{ scheme: 'exact', network: 'eip155:8453', amount, asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: PAYTO, maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } }] })));

beforeAll(async () => { mock = await startMockSigner(st); await import('../src/background/index'); (await import('../src/background/swap')).setSunioUrl(`${mock.url}/sunio`); });
afterAll(async () => { await call({ cmd: 'disconnect' }).catch(() => {}); await mock.close(); });

describe('swap through the worker', () => {
  let main = '', agentId = '';
  it('wallet and Signer', async () => {
    await call({ cmd: 'createWallet', mnemonic: ABOUT, password: 'correct horse battery' });
    main = (await call({ cmd: 'status' })).accounts[0].id;
    await call({ cmd: 'settings', patch: { signer_url: mock.url } });
    const sync = mock.next((m) => m.type === 'wallet.sync');
    await call({ cmd: 'connect' });
    await sync;
    agentId = (await call({ cmd: 'agentCreate', name: 'claude', accounts: [main] })).id; // 0.3.2: only agents of the document
  });

  it('quote for the panel: min out, rate, route, deviation', async () => {
    const q = await call({ cmd: 'swapQuote', asset_in: 'USDT', asset_out: 'TRX', amount_in: '100', slippage_bps: 100 });
    expect(q).toMatchObject({ ok: true, amount_out: '323.476563', amount_out_min: '320.241797', route: [{ from: 'USDT', to: 'TRX', version: 'v4', fee_pct: '0.05' }] });
    expect(q.reference.deviation_bps).toBeLessThan(200);
    expect((await call({ cmd: 'swapQuote', asset_in: 'USDT', asset_out: 'TRX', amount_in: '1', slippage_bps: 100 })).ok).toBe(false); // no path for 1 in the mock
  });

  it('own swap USDT → TRX: approve (allowance 7 ≠ 100) + execute, one click → own.swap with both steps', async () => {
    const v = await call({ cmd: 'swapPrepare', account_id: main, asset_in: 'USDT', asset_out: 'TRX', amount_in: '100', slippage_bps: 100 });
    expect(v.type).toBe('swap');
    expect(v.blocked).toBeNull();
    expect(v.swap.approve).toMatchObject({ needed: true, amount: '100', current_allowance: '0.000007' });
    expect(v.swap.steps.map((s: any) => s.step)).toEqual(['approve', 'swap']);
    expect(v.swap.steps[1].energy.source).toBe('estimate');
    expect(v.swap.steps[1].energy.user).toBe(4_000);           // 400 000 × 1 % (router subsidy)
    expect(v.swap.recipient).toBe(A0.tron);
    const got = mock.next((m) => m.type === 'own.swap');
    const r = await call({ cmd: 'swapSign', swap_id: v.key });
    expect(r).toMatchObject({ status: 'submitted', request_id: 'awr_swap1' });
    const m = await got;
    expect(m.intent).toEqual({ asset_in: 'USDT', asset_out: 'TRX', amount_in: '100', slippage_bps: 100 });
    expect(m.swap.quote).toMatchObject({ amount_out_raw: '323476563', amount_out_min_raw: '320241797', slippage_bps: 100, pool_versions: ['v4'] });
    const intent = { account: A0.tron, asset_in: 'USDT' as const, asset_out: 'TRX' as const, amount_in_raw: 100_000_000n, amount_out_min_raw: 320_241_797n };
    verifyApprove(m.steps[0].signed.tx.raw_data_hex, intent, c, Date.now());
    await verifySwap(m.steps[1].signed.tx.raw_data_hex, intent, c, Date.now());
    expect(m.steps[0].resource_plan).toMatchObject({ route: 'direct', fallback_route: 'proxy', quote_usdc: '0.3' }); // Direct 0.30 < Proxy 0.48
    // the swap step is auto again (the gateway counts the router subsidy): not simulatable before the approve →
    // Proxy priced by quote of our share 0.30 < Direct 0.6
    expect(m.steps[1].resource_plan).toMatchObject({ route: 'proxy', fallback_route: 'direct', quote_usdc: '0.30', approved_max_usdc: '0.36' });
  });

  it('request.pay of a step (parent_request_id + step) is paid under that step\'s ceiling', async () => {
    const signed = mock.next((m) => m.type === 'request.pay_signed');
    mock.push({ type: 'request.pay', id: 'p1', request_id: 'awr_step2', parent_request_id: 'awr_swap1', step: 'swap', pay_id: 'pay_s2', purpose: 'resources', route: 'proxy',
      product: 'tron/send', payment_required_raw: pr402('300000'), resource_url: 'http://127.0.0.1:9975/x402/v1/tron/send' });
    const m = await signed;
    expect(m.request_id).toBe('awr_step2');
    expect(m.pay_id).toBe('pay_s2');
    // above the swap step's Proxy ceiling (0.36 in total: 0.30 + 0.30) → refused
    const rej = mock.next((x) => x.type === 'request.reject');
    mock.push({ type: 'request.pay', id: 'p2', request_id: 'awr_step2', parent_request_id: 'awr_swap1', step: 'swap', pay_id: 'pay_s3', purpose: 'resources', route: 'proxy',
      product: 'tron/send', payment_required_raw: pr402('300000'), resource_url: 'http://127.0.0.1:9975/x402/v1/tron/send' });
    expect((await rej).reason_code).toBe('resource_above_max');
  });

  it('an agent\'s swap TRX → USDT: no approve, one step, request.sign with steps and the swap block', async () => {
    const id = 'awr_agentswap';
    mock.push({ type: 'request.new', request: { request_id: id, type: 'swap', network: 'tron', status: 'pending', agent: { id: agentId, name: 'claude' },
      account: { id: main, name: 'main' }, intent: { asset_in: 'TRX', asset_out: 'USDT', amount_in: '100', amount_in_raw: '100000000', slippage_bps: 50, recipient: A0.tron },
      reason: 'USDT на оплату', expires_at: new Date(Date.now() + 3600_000).toISOString() } });
    await new Promise((x) => setTimeout(x, 150));
    const v = await call({ cmd: 'prepare', request_id: id });
    expect(v.type).toBe('swap');
    expect(v.swap.approve.needed).toBe(false);
    expect(v.swap.steps.map((s: any) => s.step)).toEqual(['swap']);
    expect(v.swap.steps[0].energy.source).toBe('simulation');
    expect(v.swap.amount_out_min).toBe('30.73033');           // floor(30 884 754 × 0.995)
    const sent = mock.next((m) => m.type === 'request.sign');
    await call({ cmd: 'sign', request_id: id, addressChecked: false });
    const m = await sent;
    expect(m.signed).toBeUndefined();
    expect(m.steps).toHaveLength(1);
    expect(m.swap.quote.amount_out_min_raw).toBe('30730330');
    await verifySwap(m.steps[0].signed.tx.raw_data_hex, { account: A0.tron, asset_in: 'TRX', asset_out: 'USDT', amount_in_raw: 100_000_000n, amount_out_min_raw: 30_730_330n }, c, Date.now());
  });
});
