// 0.3.2: words from an agent or a server (reason, agent name) must not reorder the window — bidi
// controls (RLO / LRO / isolates / marks) and other invisible format characters are removed before they are stored.
const BIDI = /[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;
export const stripBidi = (s: unknown): string => String(s ?? '').replace(BIDI, '');
/** A request as it may be shown: reason and agent name cleaned. */
export function cleanRequestText<T extends Record<string, any>>(r: T): T {
  if (!r || typeof r !== 'object') return r;
  const out: any = { ...r };
  if (typeof out.reason === 'string') out.reason = stripBidi(out.reason);
  if (out.agent && typeof out.agent === 'object' && typeof out.agent.name === 'string') out.agent = { ...out.agent, name: stripBidi(out.agent.name) };
  if (out.account && typeof out.account === 'object' && typeof out.account.name === 'string') out.account = { ...out.account, name: stripBidi(out.account.name) };
  return out;
}
