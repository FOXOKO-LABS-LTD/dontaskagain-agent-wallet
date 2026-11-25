import { setReceiverActivationProxyAllowed } from '../src/lib/swap/config';
import { computeNeed, choosePlan, withMargin, feeLimitSun, ProxyRoute, DirectRoute, type RouteQuote } from '../src/lib/resources/plan';

const need0 = { energyNeed: 73_928, bandwidthNeed: 345, energyHave: 0, bandwidthStaked: 0, bandwidthFree: 600, senderActivated: true, recipientNeedsActivation: false };

describe('resources', () => {
  it('need / have / deficit; bandwidth sources do not add up', () => {
    const n = computeNeed(need0);
    expect(n.deficit).toEqual({ energy: 73_928, bandwidth: 0 });
    const n2 = computeNeed({ ...need0, bandwidthFree: 200, bandwidthStaked: 200 });
    expect(n2.have.bandwidth).toBe(200);
    expect(n2.deficit.bandwidth).toBe(145);
    expect(computeNeed({ ...need0, senderActivated: false, bandwidthFree: 0 }).activate.sender).toBe(true);
    expect(withMargin(64_285)).toBe(73_928);
  });
  it('fee_limit is a ceiling: ≥ 30 TRX, ≤ 100 TRX', () => {
    expect(feeLimitSun(73_928, 100)).toBe(30_000_000);
    expect(feeLimitSun(300_000, 210)).toBe(94_500_000);
    expect(feeLimitSun(1_000_000, 210)).toBe(100_000_000);
  });
  const q = (route: 'proxy' | 'direct', cost?: string, ok = true): RouteQuote => ({ route, ok, cost_usdc: cost, buy: { energy: 73_928, bandwidth: 0, activate: [] } });
  it('no deficit → route none', () => {
    const p = choosePlan(computeNeed({ ...need0, energyHave: 100_000 }), [], { choice: 'auto', usdcBalanceMicro: 0n });
    expect(p.route).toBe('none'); expect(p.blocked).toBeNull();
  });
  it('auto: cheaper wins, the other is the fallback; ceiling = min(price × 1.2, max_cost)', () => {
    const n = computeNeed(need0);
    const p = choosePlan(n, [q('proxy', '0.48'), q('direct', '0.47')], { choice: 'auto', usdcBalanceMicro: 10_000_000n, maxCostUsdc: '1.00' });
    expect(p.route).toBe('direct'); expect(p.fallback_route).toBe('proxy');
    expect(p.approved_max_usdc).toBe('0.564'); expect(p.fallback_approved_max_usdc).toBe('0.576');
    const eq = choosePlan(n, [q('direct', '0.48'), q('proxy', '0.48')], { choice: 'auto', usdcBalanceMicro: null });
    expect(eq.route).toBe('proxy');
    const capped = choosePlan(n, [q('proxy', '0.48')], { choice: 'auto', usdcBalanceMicro: null, maxCostUsdc: '0.50' });
    expect(capped.approved_max_usdc).toBe('0.5');
  });
  it('explicit route has no fallback; unavailable / above max / no USDC block signing', () => {
    const n = computeNeed(need0);
    expect(choosePlan(n, [q('proxy', '0.48')], { choice: 'proxy', usdcBalanceMicro: null }).fallback_route).toBeNull();
    expect(choosePlan(n, [{ route: 'direct', ok: false, code: 'DIRECT_UNAVAILABLE' }], { choice: 'direct', usdcBalanceMicro: null }).blocked?.reason_code).toBe('resource_unavailable');
    expect(choosePlan(n, [q('proxy', '0.48')], { choice: 'auto', usdcBalanceMicro: null, maxCostUsdc: '0.40' }).blocked?.code).toBe('RESOURCE_ABOVE_MAX');
    expect(choosePlan(n, [q('proxy', '0.48')], { choice: 'auto', usdcBalanceMicro: 100_000n }).blocked?.code).toBe('RESOURCE_PAYMENT_FAILED');
  });
  it('proxy: price = cover.price_usdc, recipient activation and bandwidth included, parts shown', async () => {
    const n = computeNeed(need0);
    const ctx = { need: n, owner: 'TA', recipient: 'TB', kind: 'trx' as const, estimateBody: {} };
    const cover = { activate_receiver: true, activate_receiver_trx: 1.1, activate_receiver_usdc: '0.339790', bandwidth: 269, bandwidth_usdc: '0.083095', energy: 0, price_usdc: '0.422885' };
    const proxy = new ProxyRoute({ estimate: async () => ({ estimate: { receiver_activated: false }, cover }), quote: async () => ({}) });
    const actNeed = computeNeed({ ...need0, energyNeed: 0, bandwidthFree: 0, recipientNeedsActivation: true });
    // the Direct-only mode (receiver_activation_proxy_allowed:false) — not quoted, an explicit proxy choice is blocked
    setReceiverActivationProxyAllowed(false);
    const off = await proxy.quote({ ...ctx, need: actNeed });
    expect(off).toMatchObject({ ok: false, code: 'RESOURCE_ROUTE_NOT_ALLOWED' });
    const dq: RouteQuote = { route: 'direct', ok: true, cost_usdc: '0.50', buy: { energy: 0, bandwidth: 269, activate: ['TB'] } };
    expect(choosePlan(actNeed, [off, dq], { choice: 'auto', usdcBalanceMicro: null })).toMatchObject({ route: 'direct', fallback_route: null, blocked: null });
    expect(choosePlan(actNeed, [off], { choice: 'proxy', usdcBalanceMicro: null }).blocked).toMatchObject({ code: 'RESOURCE_ROUTE_NOT_ALLOWED' });
    // the default since the gateway fix (true): one tron/send payment with the activation
    setReceiverActivationProxyAllowed(true);
    const act = await proxy.quote({ ...ctx, need: actNeed });
    expect(act).toMatchObject({ ok: true, cost_usdc: '0.422885', parts: { activate: '0.339790', bandwidth: '0.083095' } });
    expect(act.buy?.activate).toEqual(['TB']);
    // bandwidth only (no energy) is quoted now
    expect((await proxy.quote({ ...ctx, need: computeNeed({ ...need0, energyNeed: 0, bandwidthFree: 0 }) })).ok).toBe(true);
    // the old field name is still read
    const old = new ProxyRoute({ estimate: async () => ({ cover: { proxy_usdc: '0.61' } }), quote: async () => ({}) });
    expect(await old.quote(ctx)).toMatchObject({ ok: true, cost_usdc: '0.61' });
    const refused = new ProxyRoute({ estimate: async () => ({ buyable: false, refusal: { code: 'NO_CAPACITY', message: 'x' }, cover: {} }), quote: async () => ({}) });
    expect((await refused.quote(ctx)).code).toBe('NO_CAPACITY');
    // estimated energy (swap after approve): priced by quote?product=send
    const est = new ProxyRoute({ estimate: async () => { throw new Error('cannot simulate'); }, quote: async (p) => (p.product === 'send' ? { price_usdc: '0.30' } : {}) });
    expect(await est.quote({ ...ctx, estimated: true })).toMatchObject({ ok: true, cost_usdc: '0.30' });
  });
  it('proxy: cover.proxy_usdc wins over price_usdc (bandwidth included)', async () => {
    const ctx = { need: computeNeed(need0), owner: 'TA', recipient: 'TB', kind: 'trx' as const, estimateBody: {} };
    const p = new ProxyRoute({ estimate: async () => ({ cover: { proxy_usdc: '0.083095', price_usdc: '0.09' } }), quote: async () => ({}) });
    expect(await p.quote(ctx)).toMatchObject({ ok: true, cost_usdc: '0.083095' });
  });
  it('direct: cover.direct_usdc + direct_parts (activation, bandwidth, energy); one estimate for both routes', async () => {
    let calls = 0;
    const x = { estimate: async () => { calls++; return { cover: { proxy_usdc: '0.083095', price_usdc: '0.083095', direct_usdc: '0.092670',
      direct_parts: { bandwidth: { amount: 300, usdc: '0.092670' } } } }; }, quote: async () => ({}) };
    const ctx = { need: computeNeed({ ...need0, energyNeed: 0, bandwidthFree: 0 }), owner: 'TA', recipient: 'TB', kind: 'trx' as const, estimateBody: {} };
    const [px, dq] = await Promise.all([new ProxyRoute(x).quote(ctx), new DirectRoute(x).quote(ctx)]);
    expect(calls).toBe(1);
    expect(px.cost_usdc).toBe('0.083095');
    expect(dq).toMatchObject({ ok: true, cost_usdc: '0.092670', parts: { bandwidth: '0.092670' }, buy: { energy: 0, bandwidth: 345, activate: [] } });
    const plan = choosePlan(ctx.need, [px, dq], { choice: 'auto', usdcBalanceMicro: 10_000_000n });
    expect([plan.route, plan.fallback_route]).toEqual(['proxy', 'direct']); // Proxy is cheaper now
    // with a new TRX recipient: activation part summed from direct_parts
    const y = { estimate: async () => ({ cover: { direct_usdc: '0.83', direct_parts: { activate_receiver: { address: 'TB', usdc: '0.34' }, energy: { amount: 65000, usdc: '0.40' }, bandwidth: { amount: 300, usdc: '0.09' } } } }), quote: async () => ({}) };
    const ctx2 = { ...ctx, need: computeNeed({ ...need0, bandwidthFree: 0, recipientNeedsActivation: true }) };
    expect(await new DirectRoute(y).quote(ctx2)).toMatchObject({ ok: true, cost_usdc: '0.83', parts: { activate: '0.34', energy: '0.40', bandwidth: '0.09' }, buy: { activate: ['TB'] } });
  });
  it('direct: cover_refusal / no direct_usdc → the sum of quotes incl. tron/bandwidth (300…5000)', async () => {
    const x = { estimate: async () => ({ cover_refusal: { code: 'X' }, cover: {} }), quote: async (p: Record<string, string>) => (p.product === 'bandwidth' ? { price_usdc: p.amount === '345' ? '0.10' : '0' } : p.product === 'energy' ? { price_usdc: '0.47' } : {}) };
    const ctx = { need: computeNeed({ ...need0, bandwidthFree: 0 }), owner: 'TA', recipient: 'TB', kind: 'trx' as const, estimateBody: {} };
    expect(await new DirectRoute(x).quote(ctx)).toMatchObject({ ok: true, cost_usdc: '0.57', parts: { energy: '0.47', bandwidth: '0.10' } });
    const big = { ...ctx, need: { ...ctx.need, deficit: { energy: 0, bandwidth: 6000 } } };
    expect((await new DirectRoute(x).quote(big)).code).toBe('NO_CAPACITY');
  });
  it('direct: tron/activate + tron/energy by quote', async () => {
    const ctx = { need: computeNeed(need0), owner: 'TA', recipient: 'TB', kind: 'trx' as const, estimateBody: {} };
    expect((await new DirectRoute().quote(ctx)).code).toBe('DIRECT_UNAVAILABLE');
    const x = { estimate: async () => ({}), quote: async (p: Record<string, string>) => (p.product === 'activate' ? { price_usdc: '0.34' } : p.product === 'energy' ? { price_usdc: '0.47' } : {}) };
    const d = new DirectRoute(x);
    expect(await d.quote(ctx)).toMatchObject({ ok: true, cost_usdc: '0.47', parts: { energy: '0.47' } });
    const both = await d.quote({ ...ctx, need: computeNeed({ ...need0, recipientNeedsActivation: true }) });
    expect(both).toMatchObject({ ok: true, cost_usdc: '0.81', parts: { activate: '0.34', energy: '0.47' } });
    expect(both.buy?.activate).toEqual(['TB']);
  });
});
