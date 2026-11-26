// 0.3.13: connecting a chat app (Claude, ChatGPT, any remote MCP client) through OAuth on the Signer. The chat app's
// agent is a «cloud» agent: its E2E key is held by the Signer, so the Signer sees its requests; its rights are what the
// human picks here, and every transaction is still signed by the human in the extension window.
//
// What is here is pure (no chrome.*): the one-time code, the signed consent text, the consent object as the Signer
// sends it (checked and cleaned — the page that showed the code is never trusted), and which page may hand the
// extension a code (externally_connectable: only the origin of the wallet's own Signer).
import { stripBidi } from './text';

/** The code the authorize page shows: 8 letters/digits, shown and sent as XXXX-XXXX. */
export const USER_CODE_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;

/** Any case, spaces and dashes → «XXXX-XXXX»; anything else (other length, other characters) → null. */
export function normalizeUserCode(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 40) return null;
  const s = raw.toUpperCase().replace(/[\s\-‐-―]+/g, '');
  if (!/^[A-Z0-9]{8}$/.test(s)) return null;
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export type ConsentDecision = 'approve' | 'deny';

export interface ConsentTextInput {
  service: string; wallet_id: string; consent_id: string; client_id: string; redirect_uri: string; scope: string;
  decision: ConsentDecision; accounts: string[]; types: string[];
}

/**
 * The text both root keys sign (EIP-191 and TIP-191), exactly the Signer's form: lines joined by «\n», no final
 * newline; an empty list (deny) is «-».
 */
export function consentSignText(x: ConsentTextInput): string {
  const list = (l: string[]) => (x.decision === 'deny' || !l.length ? '-' : l.join(','));
  return [
    'Agent Wallet OAuth consent',
    `Service: ${x.service}`,
    `Wallet: ${x.wallet_id}`,
    `Consent: ${x.consent_id}`,
    `Client: ${x.client_id}`,
    `Redirect: ${x.redirect_uri}`,
    `Scope: ${x.scope}`,
    `Decision: ${x.decision}`,
    `Accounts: ${list(x.accounts)}`,
    `Types: ${list(x.types)}`,
  ].join('\n');
}

/** A consent as the window shows it: everything from the Signer's WS answer, cleaned. */
export interface ConsentView {
  id: string;
  client: { id: string; name: string; uri?: string; kind: 'dcr' | 'cimd' | 'other'; verified: false };
  redirect_uri: string; redirect_host: string; redirect_loopback: boolean;
  scope: string; resource?: string; expires_at?: string;
}

const clean = (v: unknown, max: number): string => stripBidi(String(v ?? '')).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
/** No newline or other control character may reach a signed line. */
const lineSafe = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v) ? v : null);

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * The redirect host the window shows big — taken from the redirect URI itself (not from the Signer's
 * redirect_host field, which only has to agree with it). https, or http to a loopback host only.
 */
export function redirectInfo(uri: string): { host: string; loopback: boolean } | null {
  let u: URL;
  try { u = new URL(uri); } catch { return null; }
  if (u.username || u.password || u.hash) return null;
  const loopback = LOOPBACK.has(u.hostname.toLowerCase());
  if (u.protocol === 'https:') return { host: u.host.toLowerCase(), loopback };
  if (u.protocol === 'http:' && loopback) return { host: u.host.toLowerCase(), loopback: true };
  return null;
}

/** The ack of `oauth.consent.get` → ConsentView, or an error code (the window shows nothing it could not check). */
export function parseConsent(ack: any): ConsentView {
  const c = ack?.consent;
  const id = lineSafe(c?.id, 80);
  if (!c || !id || !/^oc_[A-Za-z0-9_-]{4,76}$/.test(id)) throw new Error('BAD_CONSENT: no consent id');
  const clientId = lineSafe(c.client?.id, 512);
  if (!clientId) throw new Error('BAD_CONSENT: no client id');
  const redirect = lineSafe(c.redirect_uri, 1024);
  const ri = redirect ? redirectInfo(redirect) : null;
  if (!redirect || !ri) throw new Error('BAD_CONSENT: redirect_uri is not https or loopback');
  if (typeof c.redirect_host === 'string' && c.redirect_host && c.redirect_host.toLowerCase() !== ri.host && c.redirect_host.toLowerCase() !== ri.host.replace(/:\d+$/, '')) {
    throw new Error('BAD_CONSENT: redirect_host does not match redirect_uri');
  }
  const scope = lineSafe(c.scope, 200) ?? 'wallet';
  const kind = c.client?.kind === 'dcr' || c.client?.kind === 'cimd' ? c.client.kind : 'other';
  let uri: string | undefined;
  try { const u = new URL(String(c.client?.uri ?? '')); if (u.protocol === 'https:') uri = u.origin; } catch { /* none */ }
  return {
    id, client: { id: clientId, name: clean(c.client?.name, 64) || clientId.slice(0, 64), ...(uri ? { uri } : {}), kind, verified: false },
    redirect_uri: redirect, redirect_host: ri.host, redirect_loopback: ri.loopback || c.redirect_loopback === true,
    scope, ...(typeof c.resource === 'string' ? { resource: clean(c.resource, 300) } : {}), ...(typeof c.expires_at === 'string' ? { expires_at: c.expires_at } : {}),
  };
}

const originOf = (u: string): string => { try { return new URL(u).origin; } catch { return ''; } };

/**
 * externally_connectable: a page may hand the extension a consent code only if it is a page of the wallet's own
 * Signer (sender.origin = the origin of the Signer in the settings). The message carries the code only; the
 * consent itself is read from the Signer over the WebSocket. → the normalized code, or null (ignored).
 */
export function acceptExternal(msg: any, senderOrigin: string | undefined, signerUrl: string): { user_code: string; consent_id?: string } | null {
  const mine = originOf(signerUrl);
  if (!mine || !senderOrigin || senderOrigin !== mine) return null;
  if (!msg || typeof msg !== 'object' || msg.type !== 'daa.oauth.consent') return null;
  const code = normalizeUserCode(msg.user_code);
  if (!code) return null;
  const cid = typeof msg.consent_id === 'string' && /^oc_[A-Za-z0-9_-]{4,76}$/.test(msg.consent_id) ? msg.consent_id : undefined;
  return { user_code: code, ...(cid ? { consent_id: cid } : {}) };
}

/** The local record of a cloud agent (in the vault and in the wallet document). */
export interface CloudInfo { client_id: string; client_name: string; redirect_host: string; consent_id: string; connected_at: string }
