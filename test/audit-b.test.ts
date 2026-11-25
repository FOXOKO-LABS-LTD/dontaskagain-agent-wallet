// Regression tests of the 0.3.2 security review, part B: x402 approvals, swap price,
// (auto-lock) (https endpoints) (fee ceilings). Mock Signer on 127.0.0.1 only.
import { installFakeChrome } from './helpers/fake-chrome';
import { startMockSigner, type MockState } from './helpers/mock-signer';
import { hdAddresses, seedFromMnemonic } from '../src/lib/wallet/derive';
import { bytesToBase64, utf8 } from '../src/lib/bytes';
import { swapConfig } from '../src/lib/swap/config';
import { unsupportedReason } from '../src/lib/swap/quote';
import { bridgePlan } from '../src/lib/evm/cctp';
import { insecureUrl, isPrivateHost } from '../src/lib/urlPolicy';
import qUT from './fixtures/sunio-quote-usdt-trx.json';
import qTU from './fixtures/sunio-quote-trx-usdt.json';

const ABOUT = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seed = seedFromMnemonic(ABOUT);
const A0 = hdAddresses(seed, 0);
const E = 10n ** 18n;
const c = swapConfig();
const st: MockState = {
  accounts: {
    [A0.tron]: { exists: true, balanceSun: 500_000_000, energy: 0, freeNet: 600, usdt: 200_000_000n },
    TU3rMHyWHzeEJBReWLzHko728hbz6MtfNg: { exists: true, balanceSun: 1, energy: 1_000_000_000, freeNet: 0, usdt: 0n },
  },
  usdcMicro: 12_500_000n, coverPrice: '0.48', energyUsed: 40_000,
  swapQuotes: [...qUT.data, ...qTU.data], allowance: 7n, x402Quote: '0.30',
  evm: { native: { 1: E, 42161: E / 100n, 10: 0n, 137: 0n, 8453: E / 100n }, usdc: { 42161: 50_000_000n, 8453: 3_000_000n }, usdt: { 42161: 100_000_000n }, allowance: { 42161: 0n } },
};
const fake = installFakeChrome();
const call = fake.call;
let mock: Awaited<ReturnType<typeof startMockSigner>>;
const PAYTO = '0x16dDE7b0A9b092c4Dd985af5D9Ca04e389b3c87E';
const pr402 = (amount: string, path = '/x402/v1/tron/send', extra: any = {}) => bytesToBase64(utf8(JSON.stringify({ x402Version: 2, resource: { url: `https://api.awesomefee.com${path}` },
  accepts: [{ scheme: 'exact', network: 'eip155:8453', amount, asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: PAYTO, maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2', ...extra } }] })));
beforeAll(async () => { mock = await startMockSigner(st); await import('../src/background/index'); (await import('../src/background/swap')).setSunioUrl(`${mock.url}/sunio`); });
afterAll(async () => { await call({ cmd: 'disconnect' }).catch(() => {}); await mock.close(); });

describe('audit 0.3.2 — package B', () => {
  let main = '';
  it('setup', async () => {
    await call({ cmd: 'createWallet', mnemonic: ABOUT, password: 'correct horse battery' });
    main = (await call({ cmd: 'status' })).accounts[0].id;
    await call({ cmd: 'settings', patch: { signer_url: mock.url } });
    const sync = mock.next((m) => m.type === 'wallet.sync');
    await call({ cmd: 'connect' }); await sync;
  });

  it('the main and the fallback route share one ceiling (the larger), never their sum', async () => {
    const { approvePayment } = await import('../src/background/requests');
    const { getSession, patchSession } = await import('../src/background/store');
    const a = { request_id: 'awr_x1', req_id: 'awr_x1', account_id: main, txID: 'ab'.repeat(32), route: 'proxy' as const, fallback_route: 'direct' as const,
      caps_micro: { proxy: '576000', direct: '600000' }, paid_micro: {}, created_at: Date.now(), expires_at: Date.now() + 600_000, addresses: [A0.tron] };
    await patchSession({ approvals: { ...((await getSession()).approvals ?? {}), awr_x1: a } });
    await approvePayment({ request_id: 'awr_x1', route: 'proxy', payment_required_raw: pr402('500000'), pay_id: 'p1' });
    await expect(approvePayment({ request_id: 'awr_x1', route: 'direct', payment_required_raw: pr402('500000', '/x402/v1/tron/energy'), pay_id: 'p2' })).rejects.toThrow(/resource_above_max: .* in all routes/);
    // within the shared ceiling it pays
    await approvePayment({ request_id: 'awr_x1', route: 'direct', payment_required_raw: pr402('100000', '/x402/v1/tron/energy'), pay_id: 'p3' });
  });

  it('an approval stops with its TRON transaction and with its request; a 402 for another address / txid is refused', async () => {
    const { approvePayment, putRequest } = await import('../src/background/requests');
    const { getSession, patchSession } = await import('../src/background/store');
    const mk = (id: string, extra: any = {}) => ({ request_id: id, req_id: id, account_id: main, txID: 'cd'.repeat(32), route: 'direct' as const, fallback_route: null,
      caps_micro: { direct: '900000' }, paid_micro: {}, created_at: Date.now(), expires_at: Date.now() + 600_000, addresses: [A0.tron], ...extra });
    await patchSession({ approvals: { ...((await getSession()).approvals ?? {}), awr_old: mk('awr_old', { expires_at: Date.now() - 1 }), awr_done: mk('awr_done'), awr_bind: mk('awr_bind') } });
    await expect(approvePayment({ request_id: 'awr_old', route: 'direct', payment_required_raw: pr402('1000', '/x402/v1/tron/energy') })).rejects.toThrow(/expired/);
    await putRequest({ request_id: 'awr_done', status: 'confirmed', type: 'transfer', network: 'tron' });
    await expect(approvePayment({ request_id: 'awr_done', route: 'direct', payment_required_raw: pr402('1000', '/x402/v1/tron/energy') })).rejects.toThrow(/already confirmed/);
    expect((await getSession()).approvals?.awr_done).toBeUndefined();
    await expect(approvePayment({ request_id: 'awr_bind', route: 'direct', payment_required_raw: pr402('1000', '/x402/v1/tron/energy', { address: 'TU3rMHyWHzeEJBReWLzHko728hbz6MtfNg' }) })).rejects.toThrow(/not for this transfer/);
    await expect(approvePayment({ request_id: 'awr_bind', route: 'direct', payment_required_raw: pr402('1000', '/x402/v1/tron/energy', { txid: 'ee'.repeat(32) }) })).rejects.toThrow(/another transaction/);
    await approvePayment({ request_id: 'awr_bind', route: 'direct', payment_required_raw: pr402('1000', '/x402/v1/tron/energy', { address: A0.tron }) });
  });

  it('a path through an unknown token or a V4 hook is not supported', () => {
    const p: any = structuredClone(qUT.data[0]);
    expect(unsupportedReason(p, c, 'USDT', 'TRX')).toBeNull();
    const hooked = structuredClone(p); hooked.poolKeys[0].hooks = 'TU3rMHyWHzeEJBReWLzHko728hbz6MtfNg';
    expect(unsupportedReason(hooked, c, 'USDT', 'TRX')).toBe('hook');
    const mid: any = { ...structuredClone(p), tokens: [c.assets.USDT.address, 'TU3rMHyWHzeEJBReWLzHko728hbz6MtfNg', c.trx], poolVersions: ['v2', 'v2'], poolKeys: [null, null], poolFees: ['0', '0'], symbols: ['USDT', 'EVIL', 'TRX'] };
    expect(unsupportedReason(mid, c, 'USDT', 'TRX')).toBe('intermediate_token');
  });

  it('the Signer\'s quote much worse than sun.io directly → blocked; deviation from the reference > 5 % → blocked', async () => {
    st.sunio = (st.swapQuotes ?? []).map((q: any) => ({ ...q, amountOutRaw: (BigInt(q.amountOutRaw) * 110n / 100n).toString() }));
    const v = await call({ cmd: 'swapPrepare', account_id: main, asset_in: 'USDT', asset_out: 'TRX', amount_in: '100', slippage_bps: 100 });
    expect(v.blocked).toMatchObject({ code: 'SWAP_QUOTE_MISMATCH', reason_code: 'unsafe' });
    st.sunio = undefined;
    st.swapRef = { pair: 'TRXUSD', price_usd: '0.25', source: 'binance', as_of: new Date().toISOString(), stale: false }; // the quote is ~19 % worse than this rate
    const v2 = await call({ cmd: 'swapPrepare', account_id: main, asset_in: 'USDT', asset_out: 'TRX', amount_in: '100', slippage_bps: 100 });
    expect(v2.blocked).toMatchObject({ code: 'SWAP_PRICE_DEVIATION' });
    st.swapRef = undefined;
    const ok = await call({ cmd: 'swapPrepare', account_id: main, asset_in: 'USDT', asset_out: 'TRX', amount_in: '100', slippage_bps: 100 });
    expect(ok.blocked).toBeNull();
  });

  it('an EVM fee above the network ceiling blocks (it was only a warning)', async () => {
    st.evm!.baseFee = 30_000_000_000n; // 30 gwei on Arbitrum: above 0.002 ETH for a token transfer, below the balance
    const v = await call({ cmd: 'evmPrepare', account_id: main, network: 'evm:42161', asset: 'USDT', to: '0x3214a0bf8a5be0d3f2a9f1d2c3b4a5968776b67c', amount: '1' });
    expect(v.blocked).toMatchObject({ code: 'FEE_ABOVE_MAX', reason_code: 'unsafe' });
    st.evm!.baseFee = undefined;
  });

  it('CCTP fees from the Signer have ceilings of our own', () => {
    expect(() => bridgePlan({ amount: 1_000_000n, mode: 'fast', srcFast: true, forwarding: false, fees: [{ finalityThreshold: 1000, minimumFee: 50 }] })).toThrow(/above the ceiling/);
    expect(() => bridgePlan({ amount: 1_000_000n, mode: 'fast', srcFast: true, forwarding: true, fees: [{ finalityThreshold: 1000, minimumFee: 1, forwardFee: { low: 1, med: 50_000_000, high: 1 } }] })).toThrow(/forwarding fee/);
    expect(bridgePlan({ amount: 1_000_000n, mode: 'fast', srcFast: true, forwarding: false, fees: [{ finalityThreshold: 1000, minimumFee: 1.4 }] }).mode_effective).toBe('fast');
  });

  it('endpoints the human types must be https, http only to localhost / private networks', async () => {
    expect(isPrivateHost('10.0.0.2') && isPrivateHost('100.64.1.1') && isPrivateHost('192.168.1.5') && isPrivateHost('127.0.0.1') && isPrivateHost('localhost')).toBe(true);
    expect(isPrivateHost('198.51.100.7')).toBe(false);
    expect(insecureUrl('http://198.51.100.7:9985')).toBe(true);
    expect(insecureUrl('https://signer.example')).toBe(false);
    await expect(call({ cmd: 'settings', patch: { signer_url: 'http://198.51.100.8:9985' } })).rejects.toThrow(/INSECURE_URL/);
    await expect(call({ cmd: 'settings', patch: { e2e_tron_node: 'http://203.0.113.7:8090' } })).rejects.toThrow(/INSECURE_URL/);
    await expect(call({ cmd: 'settings', patch: { e2e_rpc: { 8453: 'http://203.0.113.7:8545' } } })).rejects.toThrow(/INSECURE_URL/);
    await expect(call({ cmd: 'signerMode', mode: 'own', own_url: 'http://203.0.113.7:9985' })).rejects.toThrow(/INSECURE_URL/);
    // 0.3.9: no exception for a built-in node any more; a private-network address over http is fine
    await expect(call({ cmd: 'settings', patch: { e2e_tron_node: 'http://198.51.100.7:8090' } })).rejects.toThrow(/INSECURE_URL/);
    await call({ cmd: 'settings', patch: { e2e_tron_node: 'http://10.0.0.1:8090', x402_gateway_url: 'http://10.0.0.1:9975/x402/v1' } });
  });

  it('opening the window, building and re-quoting do not move the auto-lock; an expired session locks at the next command', async () => {
    const store = await import('../src/background/store');
    const w = await import('../src/background/wallet');
    const s = await store.getSession();
    const t0 = Date.now() - 20 * 60_000;
    s.lastActivity = t0;
    await call({ cmd: 'prepare', request_id: 'awr_none' }).catch(() => {});
    await call({ cmd: 'swapQuote', asset_in: 'USDT', asset_out: 'TRX', amount_in: '100', slippage_bps: 100 }).catch(() => {});
    await call({ cmd: 'bridgeQuote', account_id: main, from_network: 'evm:42161', to_network: 'evm:8453', amount: '1', mode: 'fast', delivery: 'auto' }).catch(() => {});
    await call({ cmd: 'requests' });
    expect((await store.getSession()).lastActivity).toBe(t0);
    s.lastActivity = Date.now() - 3 * 3_600_000; // laptop slept past the deadline
    await call({ cmd: 'touch' });                  // the first command after it
    expect((await call({ cmd: 'status' })).unlocked).toBe(false);
    expect(await w.isUnlocked()).toBe(false);
  });
});
