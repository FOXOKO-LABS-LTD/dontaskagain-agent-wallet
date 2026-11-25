// Invite-only registration. The code is `daa-inv-` + 26 base32
// characters (128 random bits); case, dashes, spaces and `_` do not matter. A Signer link `https://host/#invite=<code>`
// is split here into the Signer address and the code — the fragment goes nowhere else (only the code, to verify).

/** `registration` of a challenge for a root pair without a wallet. */
export interface Registration { mode: 'open' | 'invite' | 'closed'; invite_required: boolean; }

const BODY = 26;

/** The canonical code (`daa-inv-` + 26 lower-case base32 characters) or null when it cannot be an invite code. */
export function normalizeInvite(input: string): string | null {
  if (typeof input !== 'string' || input.length > 128) return null;
  const s = input.toLowerCase().replace(/[-\s_]/g, '');
  if (!/^daainv[a-z2-7]+$/.test(s) || s.length !== 6 + BODY) return null;
  const body = s.slice(6);
  // 128 bits in 26 characters: the last one carries 3 bits, its low 2 bits must be zero (as the Signer decodes it)
  const last = 'abcdefghijklmnopqrstuvwxyz234567'.indexOf(body[BODY - 1]);
  if (last & 3) return null;
  return `daa-inv-${body}`;
}

/**
 * What the human pasted into the Signer address or the invite field: a link with `#invite=` → its origin and the code;
 * a bare code → the code; an address without a code → the address. null = neither.
 */
export function parseSignerInput(input: string): { url?: string; invite?: string } | null {
  const s = (input ?? '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) {
    let u: URL;
    try { u = new URL(s); } catch { return null; }
    const m = /^#invite=([^&]*)$/.exec(u.hash);
    if (!m) return { url: u.origin };
    let raw = m[1];
    try { raw = decodeURIComponent(raw); } catch { return null; }
    const invite = normalizeInvite(raw);
    return invite ? { url: u.origin, invite } : { url: u.origin };
  }
  const invite = normalizeInvite(s);
  return invite ? { invite } : null;
}

/** A sane `registration` object from a challenge (anything else → undefined: the Signer predates invites). */
export function readRegistration(x: unknown): Registration | undefined {
  if (!x || typeof x !== 'object') return undefined;
  const r = x as Record<string, unknown>;
  if (r.mode !== 'open' && r.mode !== 'invite' && r.mode !== 'closed') return undefined;
  return { mode: r.mode, invite_required: r.invite_required === true };
}
