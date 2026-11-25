// Quotes of sun.io relayed by the Signer, path choice, amount_out_min, deviation from the reference rate.
import { formatUnits } from '../amount';
import { normalizeTron } from '../tron/address';
import type { SwapAsset, SwapConfig } from './config';

/** One path of GET /apiv2/quote/swap/routerUniversal (sun.io), as the Signer relays it. */
export interface SunPath {
  amountIn: string; amountInRaw: string; amountOut: string; amountOutRaw: string;
  amountOutMinimum?: string; amountOutMinimumRaw?: string;
  inUsd?: string; outUsd?: string; impact?: string; fee?: string;
  containsUnverifiedHook?: boolean;
  tokens: string[]; symbols: string[]; poolVersions: string[]; poolFees: string[];
  poolKeys: ({ token0: string; token1: string; hooks: string; fee: number; parameters: string } | null)[];
  stepAmountsOut?: string[];
}

export interface QuoteAnswer { schema_version?: string; source?: string; fetched_at?: string; quotes: SunPath[]; best?: number | null }

export interface Reference { pair?: string; price_usd: string; source?: string; as_of?: string; ts?: string; stale?: boolean }

/** Reads of the swap through the Signer: the extension never calls sun.io or market-data itself. */
export interface SwapReader {
  quote(p: { asset_in: SwapAsset; asset_out: SwapAsset; amount_in_raw: string; slippage_bps: number }): Promise<QuoteAnswer>;
  reference(): Promise<Reference>;
}

export const BPS = 10_000n;

/** floor(amountOutRaw × (10 000 − bps) / 10 000). */
export function amountOutMin(amountOutRaw: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) throw new Error('BAD_SLIPPAGE');
  if (amountOutRaw < 0n) throw new Error('BAD_AMOUNT');
  return (amountOutRaw * (BPS - BigInt(slippageBps))) / BPS;
}

const isTrxWtrx = (a: string, b: string, c: SwapConfig) => (a === c.trx && b === c.wtrx) || (a === c.wtrx && b === c.trx);

/** Why a path cannot be executed by our builder (null = supported): every hop v2 / v3 / v4 or TRX↔WTRX, no
 * unverified V4 hook, starts with asset_in and ends with asset_out, amounts positive. */
export function unsupportedReason(p: SunPath, c: SwapConfig, assetIn?: SwapAsset, assetOut?: SwapAsset): string | null {
  if (!p || !Array.isArray(p.tokens) || !Array.isArray(p.poolVersions)) return 'malformed';
  if (p.tokens.length !== p.poolVersions.length + 1 || p.tokens.length < 2) return 'malformed';
  if (p.containsUnverifiedHook) return 'unverified_hook';
  let toks: string[];
  try { toks = p.tokens.map(normalizeTron); } catch { return 'bad_address'; }
  if (assetIn && toks[0] !== c.assets[assetIn].address) return 'wrong_input';
  if (assetOut && toks[toks.length - 1] !== c.assets[assetOut].address) return 'wrong_output';
  // 0.3.2: only our own assets on the way (TRX, WTRX, USDT) — a pool of an unknown token in the middle is
  // where a hostile quote hides its price; V4 pools without hooks only (hooks = the zero address)
  const known = new Set([c.trx, c.wtrx, ...Object.values(c.assets).map((x) => x.address)]);
  if (toks.some((x) => !known.has(x))) return 'intermediate_token';
  for (let i = 0; i < p.poolVersions.length; i++) {
    if (isTrxWtrx(toks[i], toks[i + 1], c)) continue;
    const v = p.poolVersions[i];
    if (v === 'v2' || v === 'v3') { if (toks[i] === c.trx || toks[i + 1] === c.trx) return 'native_in_v2_v3'; continue; }
    if (v === 'v4') {
      const k = p.poolKeys?.[i];
      if (!k) return 'no_pool_key';
      let hook = '';
      try { hook = normalizeTron(String(k.hooks ?? '')); } catch { return 'hook'; }
      if (hook !== c.trx) return 'hook';
      continue;
    }
    return `pool_${v}`;
  }
  try { if (BigInt(p.amountInRaw) <= 0n || BigInt(p.amountOutRaw) <= 0n) return 'zero_amount'; } catch { return 'bad_amount'; }
  return null;
}

/** First supported path in sun.io order (best first). */
export function pickPath(q: QuoteAnswer, c: SwapConfig, assetIn: SwapAsset, assetOut: SwapAsset, amountInRaw?: bigint): { path: SunPath; index: number } | null {
  for (let i = 0; i < (q.quotes ?? []).length; i++) {
    const p = q.quotes[i];
    if (unsupportedReason(p, c, assetIn, assetOut)) continue;
    if (amountInRaw !== undefined && BigInt(p.amountInRaw) !== amountInRaw) continue;
    return { path: p, index: i };
  }
  return null;
}

/** deviation of the quote from the market (TRX/USD of the exchanges, USDT ≈ USD), in bps; < 0 = better than
 * market. Decimals of TRX and USDT are both 6. */
export function deviationBps(assetIn: SwapAsset, amountInRaw: bigint, amountOutRaw: bigint, priceUsd: string): number {
  const P = 1_000_000_000n; // fixed point for the price
  const [i, f = ''] = priceUsd.trim().split('.');
  if (!/^\d+$/.test(i) || !/^\d*$/.test(f)) throw new Error('bad price');
  const price = BigInt(i) * P + BigInt((f + '000000000').slice(0, 9));
  if (price <= 0n) throw new Error('bad price');
  // expected output in raw units
  const expected = assetIn === 'TRX' ? (amountInRaw * price) / P : (amountInRaw * P) / price;
  if (expected <= 0n) throw new Error('bad price');
  return Number(((expected - amountOutRaw) * BPS) / expected);
}

/** «1 USDT = 3.2347 TRX» for the window. */
export function rateText(path: SunPath, assetIn: string, assetOut: string): string {
  const inR = BigInt(path.amountInRaw), outR = BigInt(path.amountOutRaw);
  const r = (outR * 1_000_000n) / inR; // 6 decimals on both sides
  return `1 ${assetIn} ≈ ${formatUnits(r, 6, 6)} ${assetOut}`;
}

/** Pools of the path for the window: «USDT → TRX · v4 · 0.05 %». */
export function routeLines(path: SunPath): { from: string; to: string; version: string; fee_pct: string }[] {
  return path.poolVersions.map((v, i) => ({ from: path.symbols?.[i] ?? '?', to: path.symbols?.[i + 1] ?? '?', version: v, fee_pct: formatUnits(BigInt(path.poolFees?.[i] ?? '0'), 4) }));
}
