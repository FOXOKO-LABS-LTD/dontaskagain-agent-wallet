// Swap reads relayed by the Signer: GET /v1/ext/swap/quote and /v1/ext/swap/reference with the session.
import { getJSON, HttpError } from '../net';
import type { QuoteAnswer, Reference, SwapReader } from './quote';
import { swapConfig, type SwapAsset } from './config';

export class SignerSwapReader implements SwapReader {
  constructor(private base: () => string, private session: () => string | undefined) {}
  private h() { const s = this.session(); if (!s) throw new HttpError(401, 'NO_SESSION', 'not signed in to the Signer'); return { Authorization: `Bearer ${s}` }; }
  quote(p: { asset_in: SwapAsset; asset_out: SwapAsset; amount_in_raw: string; slippage_bps: number }): Promise<QuoteAnswer> {
    return getJSON(`${this.base()}/v1/ext/swap/quote?${new URLSearchParams({ ...p, slippage_bps: String(p.slippage_bps) })}`, this.h());
  }
  reference(): Promise<Reference> { return getJSON(`${this.base()}/v1/ext/swap/reference`, this.h()); }
}

/** E2E: sun.io directly — the quote carries the amount, so it never goes through the mailbox server. The same
 * request the Signer makes; the answer is shaped like the relay's. */
export class DirectSwapReader implements SwapReader {
  constructor(private url: string, private ref: SwapReader, private fetchFn: typeof fetch = (...a) => fetch(...a)) {}
  async quote(p: { asset_in: SwapAsset; asset_out: SwapAsset; amount_in_raw: string; slippage_bps: number }): Promise<QuoteAnswer> {
    const c = swapConfig();
    const q = new URLSearchParams({ fromToken: c.assets[p.asset_in].address, toToken: c.assets[p.asset_out].address, amountIn: p.amount_in_raw,
      typeList: 'SUNSWAP_V2,SUNSWAP_V3,SUNSWAP_V4,WTRX', maxCost: '3', includeUnverifiedV4Hook: 'false', ...(p.slippage_bps > 0 ? { slippageBips: String(p.slippage_bps) } : {}) });
    const r = await this.fetchFn(`${this.url}?${q}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new HttpError(503, 'QUOTE_UNAVAILABLE', `sun.io: HTTP ${r.status}`);
    const b = await r.json();
    if (b?.code !== 0) throw new HttpError(422, 'SWAP_NO_ROUTE', `sun.io: ${b?.message ?? 'no route'}`);
    return { schema_version: '1', source: 'sun.io', fetched_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), quotes: Array.isArray(b.data) ? b.data : [], best: null };
  }
  reference(): Promise<Reference> { return this.ref.reference(); }
}
