// Coin and network logos : built-in files in public/logos (official brand materials)
//, no network loads at run time. A server-given logo (https, cached as a data: URL by
// the service worker) wins; an unknown coin gets its ticker letters.

const COIN: Record<string, string> = { TRX: 'tron', USDT: 'usdt', USDC: 'usdc', ETH: 'eth', POL: 'polygon', MATIC: 'polygon' };
const NET: Record<string, string> = {
  tron: 'tron', 'evm:1': 'eth', 'evm:8453': 'base', 'evm:42161': 'arbitrum', 'evm:10': 'optimism', 'evm:137': 'polygon',
};

export const NET_NAMES: Record<string, string> = {
  tron: 'TRON', 'evm:1': 'Ethereum', 'evm:8453': 'Base', 'evm:42161': 'Arbitrum', 'evm:10': 'Optimism', 'evm:137': 'Polygon',
};

const file = (name: string) => `/logos/${name}.svg`;

/** Usable server logo: only a data: image URL cached by the worker (never a remote https <img> — that would
 * tell the server when and from where the wallet is opened; CSP img-src is 'self' data:). */
export function safeLogo(u: unknown): string | null {
  if (typeof u !== 'string') return null;
  if (/^data:image\/(png|webp|jpeg);base64,[A-Za-z0-9+/=]+$/.test(u)) return u;
  return null;
}

/** Built-in logos win (a server cannot restyle USDT); a server logo only for a coin we have no file for. */
export function coinLogo(symbol: string, remote?: unknown): string | null {
  return (COIN[symbol.toUpperCase()] ? file(COIN[symbol.toUpperCase()]) : null) ?? safeLogo(remote);
}

export function netLogo(network: string): string | null {
  return NET[network] ? file(NET[network]) : null;
}

/** Letters for the placeholder: «USDT» → «US», «TRX» → «TR». */
export function initials(symbol: string): string {
  return symbol.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?';
}

/** All built-in logo files (the build check asserts they are in dist). */
export const BUILT_IN = [...new Set([...Object.values(COIN), ...Object.values(NET)])].map(file);
