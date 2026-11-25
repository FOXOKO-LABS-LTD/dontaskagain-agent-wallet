// Server-given coin logos (`logo_url` in GET /v1/ext/prices, https only): fetched once and kept as data: URLs in
// chrome.storage.local (≤ 64 KB each, ≤ 40 entries). When the fetch is not possible (no host permission / CORS), the
// https URL itself is used by <img> (browser cache). Built-in logos (public/logos) need none of this.
import type { PriceInfo } from '../lib/prices';

const KEY = 'logo_cache';
const MAX_BYTES = 64 * 1024;
const MAX_ENTRIES = 40;
const TYPES = /^image\/(png|webp|jpeg)$/; // no SVG from servers (a document, not a picture)
/** Logos are fetched only from our own hosts: the x402 gateway / prices host and the connected Signer. */
const LOGO_HOSTS = ['api.awesomefee.com'];
let signerOrigin = '';
export function setLogoSigner(url: string): void { try { signerOrigin = new URL(url).origin; } catch { signerOrigin = ''; } }
const allowedLogo = (url: string) => { try { const u = new URL(url); return u.protocol === 'https:' && (LOGO_HOSTS.includes(u.hostname) || u.origin === signerOrigin); } catch { return false; } };

type Cache = Record<string, { data: string; at: number }>;

async function load(): Promise<Cache> {
  try { return ((await chrome.storage.local.get(KEY)) as Record<string, Cache>)[KEY] ?? {}; } catch { return {}; }
}

export async function toDataUrl(url: string, fetchFn: typeof fetch = fetch): Promise<string | null> {
  if (!allowedLogo(url)) return null;
  try {
    const r = await fetchFn(url, { signal: AbortSignal.timeout(5000), credentials: 'omit', referrerPolicy: 'no-referrer' });
    const type = (r.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!r.ok || !TYPES.test(type)) return null;
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_BYTES) return null;
    let bin = '';
    for (const b of buf) bin += String.fromCharCode(b);
    return `data:${type};base64,${btoa(bin)}`;
  } catch { return null; }
}

/** Replaces https logo_url of the coins by cached data: URLs (fetching the missing ones). */
export async function cacheLogos(coins: Record<string, PriceInfo>): Promise<Record<string, PriceInfo>> {
  const urls = [...new Set(Object.values(coins).map((c) => c.logo_url).filter((u): u is string => !!u && u.startsWith('https://')))];
  if (!urls.length) return coins;
  const cache = await load();
  let changed = false;
  for (const u of urls) {
    if (cache[u]) continue;
    const d = await toDataUrl(u);
    if (d) { cache[u] = { data: d, at: Date.now() }; changed = true; }
  }
  if (changed) {
    const keep = Object.entries(cache).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_ENTRIES);
    try { await chrome.storage.local.set({ [KEY]: Object.fromEntries(keep) }); } catch { /* quota: use as is */ }
  }
  const out: Record<string, PriceInfo> = {};
  for (const [k, c] of Object.entries(coins)) out[k] = c.logo_url && cache[c.logo_url] ? { ...c, logo_url: cache[c.logo_url].data } : { ...c, logo_url: undefined };
  return out;
}
