// Coin prices in $ : from the Signer GET /v1/ext/prices (aggregator price.coins.ceo, cached 60 s on the
// server); TRX falls back to trx_usd of our gateway's free quote. A coin without either has no price (no $1 peg).

import { fmtDateTime, t } from '../i18n';

export interface PriceInfo {
  usd: number;
  source: string;        // coins.ceo | x402
  updated_at?: string;   // RFC 3339
  stale?: boolean;       // the source failed, this is the last known value
  logo_url?: string;     // https only (when the aggregator gives logos)
}

/** Reads the `prices` object of GET /v1/ext/prices; drops entries without a positive price. */
export function fromServer(body: any): Record<string, PriceInfo> {
  const out: Record<string, PriceInfo> = {};
  const p = body?.prices;
  if (!p || typeof p !== 'object') return out;
  for (const [sym, v] of Object.entries<any>(p)) {
    const usd = Number(v?.usd);
    if (!Number.isFinite(usd) || usd <= 0) continue;
    const e: PriceInfo = { usd, source: typeof v.source === 'string' ? v.source : 'signer' };
    if (typeof v.updated_at === 'string') e.updated_at = v.updated_at;
    if (v.stale === true) e.stale = true;
    if (typeof v.logo_url === 'string' && v.logo_url.startsWith('https://')) e.logo_url = v.logo_url;
    out[sym.toUpperCase()] = e;
  }
  return out;
}

/** Server prices + the TRX fallback from the x402 quote (used only when the server has no TRX price). */
export function mergePrices(server: Record<string, PriceInfo> | null, trxQuote: number | null, quoteAsOf?: string): Record<string, PriceInfo> {
  const out = { ...(server ?? {}) };
  if (!out.TRX && trxQuote !== null && Number.isFinite(trxQuote) && trxQuote > 0) {
    out.TRX = { usd: trxQuote, source: 'x402', ...(quoteAsOf ? { updated_at: quoteAsOf } : {}) };
  }
  return out;
}


/** Tooltip of a price: «1 = $0.3126 · source: coins.ceo · 01.12, 12:08 · stale». */
export function priceHint(p: PriceInfo | null | undefined): string {
  if (!p) return t('price.none');
  const parts = [`1 = $${p.usd < 1 ? p.usd.toPrecision(4) : p.usd.toFixed(2)}`, t('price.source', { src: p.source === 'x402' ? t('price.srcX402') : p.source })];
  if (p.updated_at) {
    const d = new Date(p.updated_at);
    if (!Number.isNaN(d.getTime())) parts.push(fmtDateTime(d));
  }
  if (p.stale) parts.push(t('price.stale'));
  return parts.join(' · ');
}
