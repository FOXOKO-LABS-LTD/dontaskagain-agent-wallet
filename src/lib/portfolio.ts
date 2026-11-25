// Main screen "all networks as one list of assets" : rows «USDT · TRON», «USDC · Base», amount and $.
// Prices: every coin from the Signer (price.coins.ceo, lib/prices.ts), TRX falls back to the gateway quote;
// no price → no $ (stablecoins are not pegged at 1).
import type { BalancesView } from '../shared/api';
import { evmNet, shortName } from './evm/networks';
import type { PriceInfo } from './prices';
import { getLang } from '../i18n';

/** `coins` — prices by ticker; `TRX` — the legacy number (gateway quote) when `coins` has no TRX. */
export interface Prices { coins?: Record<string, PriceInfo>; TRX?: number | null }

export interface AssetRow {
  key: string;            // "tron/USDT"
  symbol: string;
  network: string;        // tron | evm:8453
  network_name: string;   // TRON | Base
  amount: string;         // decimal string as read from the chain
  usd: number | null;     // null = no price
  native: boolean;
  price: PriceInfo | null; // source / updated_at / stale for the tooltip
}

export function priceInfo(symbol: string, p: Prices): PriceInfo | null {
  const c = p.coins?.[symbol];
  if (c && Number.isFinite(c.usd) && c.usd > 0) return c;
  if (symbol === 'TRX' && typeof p.TRX === 'number' && Number.isFinite(p.TRX) && p.TRX > 0) return { usd: p.TRX, source: 'x402' };
  return null;
}

export function priceOf(symbol: string, p: Prices): number | null {
  return priceInfo(symbol, p)?.usd ?? null;
}

export function assetRows(b: BalancesView | null | undefined, p: Prices): AssetRow[] {
  if (!b) return [];
  const rows: AssetRow[] = [];
  const add = (symbol: string, network: string, network_name: string, amount: string, native: boolean) => {
    const pi = priceInfo(symbol, p);
    const q = Number(amount);
    rows.push({ key: `${network}/${symbol}`, symbol, network, network_name, amount, usd: pi === null || !Number.isFinite(q) ? null : q * pi.usd, native, price: pi });
  };
  if (b.tron) { add('USDT', 'tron', 'TRON', b.tron.USDT, false); add('TRX', 'tron', 'TRON', b.tron.TRX, true); }
  if (b.evm) {
    for (const [net, row] of Object.entries(b.evm)) {
      const n = evmNet(net);
      if (!n) continue;
      for (const [sym, amt] of Object.entries(row)) add(sym, net, shortName(net), amt, sym === n.native.symbol);
    }
  } else if (b.base) { add('USDC', 'evm:8453', 'Base', b.base.USDC, false); add('ETH', 'evm:8453', 'Base', b.base.ETH, true); }
  // larger $ first; rows without a price after those with one, then by symbol
  return rows.sort((a, c) => (c.usd ?? -1) - (a.usd ?? -1) || a.symbol.localeCompare(c.symbol));
}

export const isZero = (amount: string) => !(Number(amount) > 0);

export function visibleRows(rows: AssetRow[], showZero: boolean): AssetRow[] {
  return showZero ? rows : rows.filter((r) => !isZero(r.amount));
}

/** Sum in $ of the rows that have a price; `partial` = some non-zero asset has no price; `stale` = a non-zero asset is
 *  priced by a stale value. */
export function totalUsd(rows: AssetRow[]): { usd: number; partial: boolean; stale: boolean } {
  let usd = 0, partial = false, stale = false;
  for (const r of rows) {
    if (r.usd === null) { if (!isZero(r.amount)) partial = true; continue; }
    if (r.price?.stale && !isZero(r.amount)) stale = true;
    usd += r.usd;
  }
  return { usd, partial, stale };
}

export function fmtUsd(v: number): string {
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Amount for lists: up to 6 decimals, without trailing zeros; grouping by language (en «,», ru thin space), point «.» in both. */
export function fmtAmount(a: string, maxFrac = 6): string {
  const [i, f = ''] = a.split('.');
  const frac = f.slice(0, maxFrac).replace(/0+$/, '');
  const int = (i || '0').replace(/\B(?=(\d{3})+(?!\d))/g, getLang() === 'en' ? ',' : ' ');
  return frac ? `${int}.${frac}` : int;
}

/** 0.3.2: the sign window shows every decimal of what is signed (fmtAmount cut 0.0000009 ETH to «0»). */
export const fmtExact = (a: string): string => fmtAmount(a, 1000);
