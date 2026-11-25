// Prices from the Signer (GET /v1/ext/prices → price.coins.ceo), TRX fallback to the gateway quote, portfolio sums,
// tooltips, logos (built-in / server https / letters).
import { describe, expect, it } from 'vitest';
import { assetRows, totalUsd } from '../src/lib/portfolio';
import { fromServer, mergePrices, priceHint } from '../src/lib/prices';
import { BUILT_IN, coinLogo, initials, netLogo, safeLogo } from '../src/lib/logos';
import { toDataUrl } from '../src/background/logos';

const server = {
  schema_version: '1', at: '2026-11-19T12:08:48Z',
  prices: {
    ETH: { usd: '1802.97', source: 'coins.ceo', updated_at: '2026-11-19T12:08:48Z', stale: false },
    POL: { usd: '0.08232', source: 'coins.ceo', updated_at: '2026-11-19T12:08:48Z', stale: false },
    TRX: { usd: '0.31257', source: 'coins.ceo', updated_at: '2026-11-19T12:08:48Z', stale: false },
    USDT: { usd: '0.99893', source: 'coins.ceo', updated_at: '2026-11-19T12:08:48Z', stale: false },
    USDC: { usd: '1.00023', source: 'coins.ceo', updated_at: '2026-11-19T12:02:00Z', stale: true, logo_url: 'https://cdn.example/usdc.png' },
    BAD: { usd: '0', source: 'coins.ceo' },
    EVIL: { usd: '2', source: 'coins.ceo', logo_url: 'javascript:alert(1)' },
  },
};

const bal = {
  at: '', errors: [],
  tron: { TRX: '100', USDT: '10', activated: true, energy: { available: 0, limit: 0 }, bandwidth: { staked_available: 0, free_available: 600 } },
  evm: { 'evm:1': { ETH: '0.01', USDC: '0', USDT: '0' }, 'evm:137': { POL: '50', USDC: '2' }, 'evm:8453': { ETH: '0', USDC: '3' } },
} as any;

describe('prices from the Signer', () => {
  it('reads the server object: positive prices only, https logos only', () => {
    const p = fromServer(server);
    expect(Object.keys(p).sort()).toEqual(['ETH', 'EVIL', 'POL', 'TRX', 'USDC', 'USDT']);
    expect(p.ETH).toEqual({ usd: 1802.97, source: 'coins.ceo', updated_at: '2026-11-19T12:08:48Z' });
    expect(p.USDC.stale).toBe(true);
    expect(p.USDC.logo_url).toBe('https://cdn.example/usdc.png');
    expect(p.EVIL.logo_url).toBeUndefined();
    expect(fromServer(null)).toEqual({});
  });
  it('TRX falls back to the gateway quote only when the server has no TRX', () => {
    const s = fromServer(server);
    expect(mergePrices(s, 0.3, 'x').TRX.source).toBe('coins.ceo');
    const noTrx = { ...s }; delete (noTrx as any).TRX;
    expect(mergePrices(noTrx, 0.3, '2026-11-19T12:00:00Z').TRX).toEqual({ usd: 0.3, source: 'x402', updated_at: '2026-11-19T12:00:00Z' });
    expect(mergePrices(null, null)).toEqual({});
    expect(mergePrices(null, 0.3).ETH).toBeUndefined(); // others: no price
  });
  it('portfolio in $ for every asset, total without «+» when all are priced', () => {
    const coins = mergePrices(fromServer(server), null);
    const rows = assetRows(bal, { coins, TRX: coins.TRX.usd });
    const by = Object.fromEntries(rows.map((r) => [r.key, r.usd === null ? null : Math.round(r.usd * 1e6) / 1e6]));
    expect(by).toEqual({
      'tron/TRX': 31.257, 'tron/USDT': 9.9893, 'evm:1/ETH': 18.0297, 'evm:1/USDC': 0, 'evm:1/USDT': 0,
      'evm:137/POL': 4.116, 'evm:137/USDC': 2.00046, 'evm:8453/ETH': 0, 'evm:8453/USDC': 3.00069,
    });
    const t = totalUsd(rows);
    expect(t.partial).toBe(false);
    expect(t.stale).toBe(true); // USDC is stale and non-zero
    expect(Math.round(t.usd * 100) / 100).toBe(68.39);
    expect(rows[0].key).toBe('tron/TRX');
  });
  it('a coin without a price makes the total partial; a zero one does not', () => {
    const coins = fromServer(server); delete (coins as any).POL;
    expect(totalUsd(assetRows(bal, { coins })).partial).toBe(true);
    const b2 = { ...bal, evm: { ...bal.evm, 'evm:137': { POL: '0', USDC: '2' } } };
    expect(totalUsd(assetRows(b2, { coins })).partial).toBe(false);
  });
  it('tooltip: price, source, time, «устарела»', () => {
    const p = fromServer(server);
    expect(priceHint(p.TRX)).toMatch(/^1 = \$0\.3126 · источник: coins\.ceo · /);
    expect(priceHint(p.USDC)).toMatch(/устарела$/);
    expect(priceHint({ usd: 0.3, source: 'x402' })).toBe('1 = $0.3000 · источник: котировка шлюза x402');
    expect(priceHint(null)).toBe('нет цены');
  });
});

describe('logos', () => {
  it('built-in files for the coins and networks, letters for the rest', () => {
    expect(coinLogo('TRX')).toBe('/logos/tron.svg');
    expect(coinLogo('pol')).toBe('/logos/polygon.svg');
    expect(netLogo('evm:42161')).toBe('/logos/arbitrum.svg');
    expect(netLogo('evm:8453')).toBe('/logos/base.svg');
    expect(netLogo('evm:56')).toBeNull();
    expect(coinLogo('BNB')).toBeNull();
    expect(initials('BNB')).toBe('BN');
    expect(BUILT_IN.sort()).toEqual(['arbitrum', 'base', 'eth', 'optimism', 'polygon', 'tron', 'usdc', 'usdt'].map((x) => `/logos/${x}.svg`));
  });
  it('0.3.2: built-in logos win; a server logo only as a cached data: image (never a remote <img>, never SVG)', () => {
    expect(coinLogo('USDC', 'https://cdn.example/usdc.png')).toBe('/logos/usdc.svg');
    expect(coinLogo('USDC', 'data:image/png;base64,iVBORw0KGgo=')).toBe('/logos/usdc.svg');
    expect(coinLogo('DOGE', 'https://cdn.example/doge.png')).toBeNull();
    expect(coinLogo('DOGE', 'data:image/png;base64,iVBORw0KGgo=')).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(safeLogo('data:image/png;base64,iVBORw0KGgo=')).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(safeLogo('data:image/svg+xml;base64,PHN2Zz4=')).toBeNull();
    expect(safeLogo('data:text/html;base64,PHNjcmlwdD4=')).toBeNull();
    expect(safeLogo('https://x/"><script>')).toBeNull();
  });
  it('the worker caches a server logo as a data: URL — only from our hosts (image types, ≤ 64 KB)', async () => {
    const ok = async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
    expect(await toDataUrl('https://api.awesomefee.com/logos/a.png', ok as any)).toBe('data:image/png;base64,AQID');
    expect(await toDataUrl('https://cdn.example/a.png', ok as any)).toBeNull(); // not an allowlisted host
    const html = async () => new Response('<b>', { headers: { 'content-type': 'text/html' } });
    expect(await toDataUrl('https://api.awesomefee.com/a.png', html as any)).toBeNull();
    const svg = async () => new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } });
    expect(await toDataUrl('https://api.awesomefee.com/a.svg', svg as any)).toBeNull();
    const big = async () => new Response(new Uint8Array(70_000), { headers: { 'content-type': 'image/png' } });
    expect(await toDataUrl('https://api.awesomefee.com/a.png', big as any)).toBeNull();
    expect(await toDataUrl('http://api.awesomefee.com/a.png', ok as any)).toBeNull();
  });
});
