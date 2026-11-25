// 0.3.2: endpoints the human types (own Signer, TRON node, EVM RPC, x402 gateway) must be https — plain
// http only to this machine or a private network (loopback, 10/8, 172.16/12, 192.168/16, 100.64/10 for
// VPNs). Over http to the internet the session token, the document (old mode) and the content of direct reads
// (recipients, amounts) travel in the clear and answers can be forged on the way.
// 0.3.9: no exceptions — there is no built-in node; a TRON node is always the human's own.

export function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** http(s)/ws(s) URL that is not protected by TLS and leaves this machine / the private network. */
export function insecureUrl(u: string | undefined): boolean {
  let x: URL;
  try { x = new URL(String(u ?? '')); } catch { return false; }
  return (x.protocol === 'http:' || x.protocol === 'ws:') && !isPrivateHost(x.hostname);
}

/** For a URL the human sets: https, or http to a private host; anything else → INSECURE_URL. */
export function requireSecureUrl(raw: string, what: string): URL {
  const u = new URL(raw);
  if (!/^https?:$/.test(u.protocol)) throw new Error('BAD_URL');
  if (insecureUrl(u.href)) throw new Error(`INSECURE_URL: ${what} ${u.origin} — https only (plain http is allowed to localhost and private networks)`);
  return u;
}
