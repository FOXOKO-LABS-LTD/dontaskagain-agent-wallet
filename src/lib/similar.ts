// Address poisoning defence: an address is "similar" to a book entry (or a past recipient) when it is in the
// same network family, is not equal, and shares the first `prefix` characters after T / 0x / 0: or the last `suffix`.

export interface BookEntry { id: string; label: string; network: string; address: string; memo?: string; added_at?: string; }
export interface SimilarHit { label: string; address: string; source: 'book' | 'history' | 'own'; entry_id?: string; same_prefix: boolean; same_suffix: boolean; }
export interface SimilarCfg { prefix: number; suffix: number; }
export const DEFAULT_SIMILAR: SimilarCfg = { prefix: 4, suffix: 4 };

export const familyOf = (network: string): 'tron' | 'evm' | 'ton' | 'other' =>
  network === 'tron' ? 'tron' : network.startsWith('evm') ? 'evm' : network.startsWith('ton') ? 'ton' : 'other';

/** Does a book entry's network cover the request network? `evm:*` covers every EVM network. */
export function networkCovers(entryNet: string, net: string): boolean {
  if (entryNet === net) return true;
  if (entryNet === 'evm:*' && familyOf(net) === 'evm') return true;
  return false;
}

/** Comparable body: without the family prefix; EVM lowercase (checksum case does not matter). */
export function addrBody(network: string, address: string): string {
  const f = familyOf(network);
  if (f === 'evm') return address.toLowerCase().replace(/^0x/, '');
  if (f === 'tron') return address.replace(/^T/, '');
  if (f === 'ton') return address.toLowerCase().replace(/^-?\d+:/, '');
  return address;
}

export function sameAddress(network: string, a: string, b: string): boolean {
  return addrBody(network, a) === addrBody(network, b);
}

export function findSimilar(network: string, address: string, book: BookEntry[], history: { address: string; network: string }[] = [], cfg: SimilarCfg = DEFAULT_SIMILAR,
  own: { label: string; address: string; network: string }[] = []): SimilarHit[] {
  const fam = familyOf(network);
  const me = addrBody(network, address);
  const hits: SimilarHit[] = [];
  const seen = new Set<string>();
  const check = (net: string, addr: string, label: string, source: SimilarHit['source'], entry_id?: string) => {
    if (familyOf(net === 'evm:*' ? 'evm:0' : net) !== fam) return;
    const other = addrBody(network, addr);
    if (other === me || seen.has(other)) return;
    const same_prefix = cfg.prefix > 0 && me.slice(0, cfg.prefix) === other.slice(0, cfg.prefix);
    const same_suffix = cfg.suffix > 0 && me.slice(-cfg.suffix) === other.slice(-cfg.suffix);
    if (same_prefix || same_suffix) { seen.add(other); hits.push({ label, address: addr, source, entry_id, same_prefix, same_suffix }); }
  };
  for (const o of own) check(o.network, o.address, o.label, 'own'); // 0.2.2: «looks like your account» first
  for (const e of book) check(e.network, e.address, e.label, 'book', e.id);
  for (const h of history) check(h.network, h.address, '', 'history');
  return hits;
}

/** Exact match in the book for this network (the only match auto-sign would accept). */
export function bookMatch(network: string, address: string, book: BookEntry[]): BookEntry | undefined {
  return book.find((e) => networkCovers(e.network, network) && sameAddress(network, e.address, address));
}

/** Character mask: true where a[i] differs from b[i] (EVM compared case-insensitively). */
export function diffMask(network: string, a: string, b: string): boolean[] {
  const ci = familyOf(network) === 'evm';
  const out: boolean[] = [];
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    out.push(y === undefined || (ci ? x.toLowerCase() !== y.toLowerCase() : x !== y));
  }
  return out;
}

/** Groups of 4 for display; head/tail = the first and last 4 characters (highlighted in the UI). */
export function groups4(address: string): string[] {
  const g: string[] = [];
  for (let i = 0; i < address.length; i += 4) g.push(address.slice(i, i + 4));
  return g;
}

/** Short form with both ends (TKHb…SU4A) — only for lists, never in the sign window. */
export const shortAddr = (a: string): string => (a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);
