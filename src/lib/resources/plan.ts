// TRON resources without burning. need / have / deficit, then routes (direct | proxy) by live price.
// TRX is never burned: no resource and no way to buy it → no signature.
import { formatUnits, mulDivUp, parseUnits } from '../amount';
import type { X402Reader } from '../net';
import { receiverActivationProxyAllowed } from '../swap/config';
import { both, t, ta, type Key, type Params } from '../../i18n';

/** A route note: `note` for the human, `note_agent` for the agent (see RouteQuote). */
const noteOf = (key: Key, p?: Params) => ({ note: t(key, p), note_agent: ta(key, p) });

export const ENERGY_MARGIN_PCT = 15;        // as Proxy AGENTS_ENERGY_MARGIN
export const PROXY_MAX_ENERGY = 300_000;    // tron/send limit
export const DIRECT_MIN_ENERGY = 65_000;    // tron/energy 65 000…300 000
export const CEILING_PCT = 120;             // approved_max = min(price × 1.2, max_cost_usdc)

export type RouteName = 'direct' | 'proxy';
export type RouteChoice = 'auto' | RouteName;

export interface ResourceNeed {
  need: { energy: number; bandwidth: number };
  have: { energy: number; bandwidth: number };
  deficit: { energy: number; bandwidth: number };
  activate: { sender: boolean; recipient: boolean };
}

/** Resource need. `bandwidthStaked`/`bandwidthFree`: a transaction is paid by ONE of them (staked first, then free), they do
 * not add up — so "have" is the larger one, and a deficit must be bought on top of the staked part. */
export function computeNeed(p: { energyNeed: number; bandwidthNeed: number; energyHave: number; bandwidthStaked: number; bandwidthFree: number; senderActivated: boolean; recipientNeedsActivation: boolean }): ResourceNeed {
  const bwHave = Math.max(p.bandwidthStaked, p.bandwidthFree);
  const deficitE = Math.max(0, p.energyNeed - p.energyHave);
  const deficitB = bwHave >= p.bandwidthNeed ? 0 : p.bandwidthNeed - p.bandwidthStaked;
  return {
    need: { energy: p.energyNeed, bandwidth: p.bandwidthNeed },
    have: { energy: p.energyHave, bandwidth: bwHave },
    deficit: { energy: deficitE, bandwidth: deficitB },
    activate: { sender: !p.senderActivated, recipient: p.recipientNeedsActivation },
  };
}

export const withMargin = (energy: number): number => Math.ceil((energy * (100 + ENERGY_MARGIN_PCT)) / 100);

export const needsPurchase = (n: ResourceNeed): boolean => n.deficit.energy > 0 || n.deficit.bandwidth > 0 || n.activate.sender || n.activate.recipient;

export interface RouteQuote {
  route: RouteName; ok: boolean;
  cost_usdc?: string;                         // live quote
  parts?: { energy?: string; bandwidth?: string; activate?: string };
  buy?: { energy: number; bandwidth: number; activate: string[] };
  code?: string;                              // why not ok: NO_CAPACITY, BANDWIDTH_UNAVAILABLE, ACTIVATION_UNAVAILABLE, DIRECT_UNAVAILABLE, PRICE_UNAVAILABLE…
  note?: string;
  /** the same note for the agent (fixed language): it becomes blocked.message when no route is left */
  note_agent?: string;
  /** energy split of a contract call reported by the gateway: energy_total, energy_user, energy_origin,
   * user_percent, energy_split (percent | origin_limit | origin_energy | caller_is_origin | unknown_contract | none) */
  energy?: EnergySplit;
}

export interface EnergySplit { energy_total?: number; energy_user?: number; energy_origin?: number; user_percent?: number; energy_split?: string }

/** The energy split fields of a tron/estimate answer (cover first, then estimate). */
export function energySplitOf(est: any): EnergySplit | undefined {
  const out: Record<string, unknown> = {};
  for (const src of [est?.cover, est?.estimate]) {
    if (!src) continue;
    for (const k of ['energy_total', 'energy_user', 'energy_origin', 'user_percent', 'energy_split']) if (src[k] != null && out[k] == null) out[k] = src[k];
  }
  return Object.keys(out).length ? out as EnergySplit : undefined;
}

export interface QuoteContext {
  need: ResourceNeed;
  owner: string; recipient?: string;
  kind: 'trx' | 'trc20';
  estimateBody: Record<string, unknown>;      // body for tron/estimate (trc20_transfer | trx_transfer | transaction)
  /** the energy is an estimate without simulation (swap after a not-yet-sent approve) */
  estimated?: boolean;
  /** price Direct by free per-product quotes only, never by cover.* (the swap step while the gateway ignores the
   * router's energy subsidy) */
  quotesOnly?: boolean;
  /** a contract call: a gateway answer with energy_split "unknown_contract" priced the whole energy — not trusted */
  isCall?: boolean;
}

/** A way to buy resources. */
export interface ResourceRoute { name: RouteName; quote(ctx: QuoteContext): Promise<RouteQuote>; }

/** USDC price of a free gateway quote: `price_usdc` (decimal), or `amount` (micro) of older answers. */
export function quotePrice(q: any): string | null {
  if (typeof q?.price_usdc === 'string' && /^\d+(\.\d+)?$/.test(q.price_usdc)) return q.price_usdc;
  if (typeof q?.amount === 'string' && /^\d+$/.test(q.amount)) return formatUnits(BigInt(q.amount), 6);
  return null;
}

export const DIRECT_MIN_BANDWIDTH = 300;     // tron/bandwidth 300…5000 bytes
export const DIRECT_MAX_BANDWIDTH = 5_000;

/** One tron/estimate per quote context: Proxy and Direct read the same answer (cover.proxy_usdc / direct_usdc). */
const estimates = new WeakMap<X402Reader, WeakMap<QuoteContext, Promise<any>>>();
function estimateOnce(x402: X402Reader, ctx: QuoteContext): Promise<any> {
  let m = estimates.get(x402);
  if (!m) { m = new WeakMap(); estimates.set(x402, m); }
  let p = m.get(ctx);
  if (!p) { p = x402.estimate(ctx.estimateBody); m.set(ctx, p); }
  return p;
}
const usdc = (v: unknown): string | null => (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? v : null);
const activateList = (ctx: QuoteContext) => [...(ctx.need.activate.sender ? [ctx.owner] : []), ...(ctx.need.activate.recipient && ctx.recipient ? [ctx.recipient] : [])];

/** Proxy = POST /x402/v1/tron/send: energy, bandwidth, activation of the sender AND of a new TRX recipient —
 * one payment. Price = `cover.proxy_usdc` of tron/estimate (= price_usdc), `cover.price_usdc`
 * as a fallback. */
export class ProxyRoute implements ResourceRoute {
  name = 'proxy' as const;
  constructor(private x402: X402Reader) {}
  async quote(ctx: QuoteContext): Promise<RouteQuote> {
    const n = ctx.need;
    const buy = { energy: n.deficit.energy, bandwidth: n.deficit.bandwidth, activate: activateList(ctx) };
    // An older gateway charged tron/send for the receiver's activation without activating it — a new TRX recipient → Direct only
    if (n.activate.recipient && !receiverActivationProxyAllowed()) return { route: 'proxy', ok: false, code: 'RESOURCE_ROUTE_NOT_ALLOWED', ...noteOf('plan.recipientDirect'), buy };
    if (n.deficit.energy > PROXY_MAX_ENERGY) return { route: 'proxy', ok: false, code: 'NO_CAPACITY', ...noteOf('plan.energyAbove', { max: PROXY_MAX_ENERGY }), buy };
    if (ctx.estimated) {
      // a call that cannot be simulated yet (swap after approve): price by energy only, 402 above the ceiling is refused
      try {
        const price = quotePrice(await this.x402.quote({ product: 'send', amount: String(Math.max(1, n.deficit.energy)) }));
        if (price) return { route: 'proxy', ok: true, cost_usdc: price, buy, ...noteOf('plan.noSimulation') };
      } catch { /* fall through */ }
      return { route: 'proxy', ok: false, code: 'PRICE_UNAVAILABLE', buy };
    }
    let est: any;
    try { est = await estimateOnce(this.x402, ctx); } catch (e) { return { route: 'proxy', ok: false, code: 'PRICE_UNAVAILABLE', note: (e as Error).message, buy }; }
    if (est?.buyable === false) return { route: 'proxy', ok: false, code: est?.refusal?.code ?? 'REFUSED', note: est?.refusal?.message, buy };
    const cover = est?.cover ?? {};
    const energy = energySplitOf(est);
    if (ctx.isCall && energy?.energy_split === 'unknown_contract') {
      // the gateway could not read the contract's energy terms: its cover is for the whole energy — price our own share
      try {
        const own = quotePrice(await this.x402.quote({ product: 'send', amount: String(Math.max(1, n.deficit.energy)) }));
        if (own) return { route: 'proxy', ok: true, cost_usdc: own, buy, energy, ...noteOf('plan.unknownContract') };
      } catch { /* fall through */ }
      return { route: 'proxy', ok: false, code: 'PRICE_UNAVAILABLE', buy, energy };
    }
    const price = usdc(cover.proxy_usdc) ?? usdc(cover.price_usdc);
    if (!price) return { route: 'proxy', ok: false, code: 'PRICE_UNAVAILABLE', buy };
    const parts: RouteQuote['parts'] = {};
    if (typeof cover.activate_receiver_usdc === 'string' && cover.activate_receiver) parts.activate = cover.activate_receiver_usdc;
    if (typeof cover.bandwidth_usdc === 'string' && Number(cover.bandwidth ?? 0) > 0) parts.bandwidth = cover.bandwidth_usdc;
    return { route: 'proxy', ok: true, cost_usdc: price, buy, parts, energy };
  }
}

/** Direct = tron/activate (each address) → tron/energy → tron/bandwidth (300…5000 bytes), then the
 * Signer checks on chain and broadcasts. Price = `cover.direct_usdc` + `cover.direct_parts` of tron/estimate; without
 * them (or `cover_refusal`, or an estimated swap step) — the sum of free quotes per product. */
export class DirectRoute implements ResourceRoute {
  name = 'direct' as const;
  constructor(private x402?: X402Reader) {}
  async quote(ctx: QuoteContext): Promise<RouteQuote> {
    const n = ctx.need;
    const activate = activateList(ctx);
    const energy = n.deficit.energy > 0 ? Math.max(n.deficit.energy, DIRECT_MIN_ENERGY) : 0;
    const bandwidth = n.deficit.bandwidth > 0 ? Math.max(n.deficit.bandwidth, DIRECT_MIN_BANDWIDTH) : 0;
    const buy = { energy, bandwidth, activate };
    if (!this.x402) return { route: 'direct', ok: false, code: 'DIRECT_UNAVAILABLE', ...noteOf('plan.directOff'), buy };
    if (energy > PROXY_MAX_ENERGY) return { route: 'direct', ok: false, code: 'NO_CAPACITY', ...noteOf('plan.energyAbove', { max: PROXY_MAX_ENERGY }), buy };
    if (bandwidth > DIRECT_MAX_BANDWIDTH) return { route: 'direct', ok: false, code: 'NO_CAPACITY', ...noteOf('plan.bandwidthAbove', { max: DIRECT_MAX_BANDWIDTH }), buy };
    if (!ctx.estimated && !ctx.quotesOnly) {
      try {
        const est = await estimateOnce(this.x402, ctx);
        const unknown = ctx.isCall && energySplitOf(est)?.energy_split === 'unknown_contract';
        const cover = unknown ? {} : est?.cover ?? {};
        const total = usdc(cover.direct_usdc);
        if (total) {
          const dp = cover.direct_parts ?? {};
          const parts: RouteQuote['parts'] = {};
          const act = [dp.activate_sender, dp.activate_receiver, dp.activate].map((x: any) => usdc(x?.usdc)).filter(Boolean) as string[];
          if (act.length) parts.activate = formatUnits(act.reduce((a, x) => a + parseUnits(x, 6), 0n), 6);
          if (usdc(dp.energy?.usdc)) parts.energy = dp.energy.usdc;
          if (usdc(dp.bandwidth?.usdc)) parts.bandwidth = dp.bandwidth.usdc;
          const b2 = { energy: Number(dp.energy?.amount) > 0 ? Math.max(energy, Number(dp.energy.amount)) : energy,
            bandwidth: Number(dp.bandwidth?.amount) > 0 ? Math.max(bandwidth, Number(dp.bandwidth.amount)) : bandwidth, activate };
          return { route: 'direct', ok: true, cost_usdc: total, parts, buy: b2 };
        }
      } catch { /* the sum of quotes below */ }
    }
    let total = 0n;
    const parts: RouteQuote['parts'] = {};
    try {
      if (activate.length) {
        const p = quotePrice(await this.x402.quote({ product: 'activate' }));
        if (!p) return { route: 'direct', ok: false, code: 'PRICE_UNAVAILABLE', ...noteOf('plan.noPrice', { product: 'tron/activate' }), buy };
        const v = parseUnits(p, 6) * BigInt(activate.length);
        total += v; parts.activate = formatUnits(v, 6);
      }
      if (energy > 0) {
        const p = quotePrice(await this.x402.quote({ product: 'energy', amount: String(energy) }));
        if (!p) return { route: 'direct', ok: false, code: 'PRICE_UNAVAILABLE', ...noteOf('plan.noPrice', { product: 'tron/energy' }), buy };
        total += parseUnits(p, 6); parts.energy = p;
      }
      if (bandwidth > 0) {
        const p = quotePrice(await this.x402.quote({ product: 'bandwidth', amount: String(bandwidth) }));
        if (!p) return { route: 'direct', ok: false, code: 'PRICE_UNAVAILABLE', ...noteOf('plan.noPrice', { product: 'tron/bandwidth' }), buy };
        total += parseUnits(p, 6); parts.bandwidth = p;
      }
    } catch (e) { return { route: 'direct', ok: false, code: 'PRICE_UNAVAILABLE', note: (e as Error).message, buy }; }
    return { route: 'direct', ok: true, cost_usdc: formatUnits(total, 6), parts, buy };
  }
}

export interface RoutePlan {
  route: RouteName | 'none';
  fallback_route: RouteName | null;
  payment_method: 'x402_base';
  quotes: Partial<Record<RouteName, RouteQuote & { approved_max_usdc?: string }>>;
  buy: { energy: number; bandwidth: number; activate: string[] };
  quote_usdc?: string;
  approved_max_usdc?: string;
  fallback_approved_max_usdc?: string;
  /** null = the plan can be signed; otherwise the reject reason (reason_code of request.reject) + error code. */
  blocked: null | { reason_code: 'resource_unavailable' | 'resource_above_max' | 'insufficient_balance'; code: string; message: string; text?: string };
}

const ceil = (priceMicro: bigint, maxMicro: bigint | null): bigint => {
  const c = mulDivUp(priceMicro, BigInt(CEILING_PCT), 100n);
  return maxMicro !== null && maxMicro < c ? maxMicro : c;
};

/** cheapest live price wins, the other is the fallback; equal → proxy. */
export function choosePlan(need: ResourceNeed, quotes: RouteQuote[], opts: { choice: RouteChoice; maxCostUsdc?: string | null; usdcBalanceMicro: bigint | null }): RoutePlan {
  const empty = { energy: 0, bandwidth: 0, activate: [] as string[] };
  if (!needsPurchase(need)) return { route: 'none', fallback_route: null, payment_method: 'x402_base', quotes: {}, buy: empty, blocked: null };
  const maxMicro = opts.maxCostUsdc ? parseUnits(opts.maxCostUsdc, 6) : null;
  const q: RoutePlan['quotes'] = {};
  for (const x of quotes) {
    const e = { ...x } as RouteQuote & { approved_max_usdc?: string };
    if (e.ok && e.cost_usdc) {
      const p = parseUnits(e.cost_usdc, 6);
      if (maxMicro !== null && p > maxMicro) { e.ok = false; e.code = 'RESOURCE_ABOVE_MAX'; Object.assign(e, noteOf('plan.aboveAgentMax', { price: e.cost_usdc, max: opts.maxCostUsdc })); }
      else e.approved_max_usdc = formatUnits(ceil(p, maxMicro), 6);
    }
    q[x.route] = e;
  }
  const allowed = (opts.choice === 'auto' ? (['proxy', 'direct'] as RouteName[]) : [opts.choice]).filter((r) => q[r]?.ok);
  const sorted = allowed.sort((a, b) => {
    const pa = parseUnits(q[a]!.cost_usdc!, 6), pb = parseUnits(q[b]!.cost_usdc!, 6);
    return pa === pb ? (a === 'proxy' ? -1 : 1) : pa < pb ? -1 : 1;
  });
  const base = { payment_method: 'x402_base' as const, quotes: q };
  if (!sorted.length) {
    const vals = Object.values(q);
    const above = vals.length > 0 && vals.every((v) => v?.code === 'RESOURCE_ABOVE_MAX');
    const first = vals.find((v) => v?.code && v.code !== 'DIRECT_UNAVAILABLE') ?? vals[0];
    return { ...base, route: opts.choice === 'auto' ? 'proxy' : opts.choice, fallback_route: null, buy: first?.buy ?? empty,
      blocked: above ? { reason_code: 'resource_above_max', code: 'RESOURCE_ABOVE_MAX', ...both('blk.resourceAboveMax') }
                     : { reason_code: 'resource_unavailable', code: first?.code ?? 'RESOURCE_UNAVAILABLE', message: first?.note_agent ?? first?.note ?? ta('blk.noRoute'), text: first?.note ?? t('blk.noRoute') } };
  }
  const main = sorted[0], fb = opts.choice === 'auto' ? sorted[1] ?? null : null;
  const plan: RoutePlan = { ...base, route: main, fallback_route: fb, buy: q[main]!.buy ?? empty, quote_usdc: q[main]!.cost_usdc, approved_max_usdc: q[main]!.approved_max_usdc,
    fallback_approved_max_usdc: fb ? q[fb]!.approved_max_usdc : undefined, blocked: null };
  if (opts.usdcBalanceMicro !== null && opts.usdcBalanceMicro < parseUnits(q[main]!.cost_usdc!, 6)) {
    plan.blocked = { reason_code: 'insufficient_balance', code: 'RESOURCE_PAYMENT_FAILED', ...both('blk.noUsdcResource') };
  }
  return plan;
}

/** fee_limit: a safety ceiling, not a burn plan: max(energy × getEnergyFee × 1.5, 30 TRX) ≤ 100 TRX. */
export function feeLimitSun(energyNeed: number, energyFeeSun: number): number {
  const v = Math.max(Math.ceil(energyNeed * energyFeeSun * 1.5), 30_000_000);
  return Math.min(v, 100_000_000);
}
