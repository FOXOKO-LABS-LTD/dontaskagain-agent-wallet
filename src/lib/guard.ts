// Protection against "signing by habit": the same request seen recently, and a sign button that
// is armed only after a delay and after the human has reached the end of a long window. Pure logic, no DOM.

import { t, type Key } from '../i18n';

export const REPEAT_WINDOW_MS = 30 * 60_000;   // "the same transfer N min ago" — 30 minutes back
export const SIGN_DELAY_MS = 1_500;            // the "Sign" button wakes up 1.5 s after the window opens

/** What is compared: the same agent, the same recipient, the same asset (amount may differ). */
export interface RequestLike {
  request_id: string;
  agent_id?: string;
  to?: string;
  asset?: string;
  amount?: string;
  network?: string;
  at: number;          // when it arrived (ms)
  status?: string;
  kind?: 'transfer' | 'swap';  // a swap: `to` = "swap:<asset_out>", `asset` = asset_in
}

export interface RepeatHit { request_id: string; minutes_ago: number; status?: string; amount?: string; count: number; kind?: 'transfer' | 'swap'; }

const norm = (s?: string) => (s ?? '').trim();
const sameAsset = (a?: string, b?: string) => norm(a).toUpperCase() === norm(b).toUpperCase();

/** The latest earlier request of the same agent to the same recipient in the same asset within `windowMs`
 * before `cur.at` (or `now`). TRON addresses compare as is, EVM — case-insensitively. */
export function findRepeat(cur: RequestLike, others: RequestLike[], now = Date.now(), windowMs = REPEAT_WINDOW_MS): RepeatHit | null {
  if (!cur.agent_id || !norm(cur.to) || !norm(cur.asset)) return null;
  const evm = /^0x/i.test(norm(cur.to));
  const sameTo = (x?: string) => (evm ? norm(x).toLowerCase() === norm(cur.to).toLowerCase() : norm(x) === norm(cur.to));
  const ref = Math.min(cur.at || now, now);
  const hits = others.filter((o) => o.request_id !== cur.request_id && o.agent_id === cur.agent_id && sameTo(o.to) && sameAsset(o.asset, cur.asset)
    && (!cur.network || !o.network || o.network === cur.network) && o.at <= ref && ref - o.at <= windowMs);
  if (!hits.length) return null;
  const last = hits.reduce((a, b) => (b.at > a.at ? b : a));
  return { request_id: last.request_id, minutes_ago: Math.max(0, Math.floor((now - last.at) / 60_000)), status: last.status, amount: last.amount, count: hits.length, ...(cur.kind === 'swap' ? { kind: 'swap' as const } : {}) };
}

const REPEAT_STATUS = new Set(['signed', 'broadcast', 'confirmed', 'rejected', 'expired', 'failed', 'pending']);

/** A human phrase for the plate: «the same transfer 4 min ago (signed)». */
export function repeatText(h: RepeatHit): string {
  const when = h.minutes_ago < 1 ? t('guard.lessThanMinute') : t('guard.minAgo', { n: h.minutes_ago });
  const s = h.status && REPEAT_STATUS.has(h.status) ? ` (${t(`guard.st.${h.status}` as Key)})` : '';
  const more = h.count > 1 ? t('guard.more', { n: h.count }) : '';
  return `${h.kind === 'swap' ? t('guard.sameSwap') : t('guard.sameTransfer')} ${when}${s}${h.amount ? `: ${h.amount}` : ''}${more}`;
}

export interface GateInput {
  openedAt: number;          // when this view (request + build) was shown
  now: number;
  reachedEnd: boolean;       // the end of the window was visible at least once (true at once when it fits)
  delayMs?: number;
}
export interface GateState { armed: boolean; waitMs: number; needScroll: boolean; }

/** The sign button: armed only when the delay has passed AND the end of the window has been seen. */
export function signGate(g: GateInput): GateState {
  const waitMs = Math.max(0, g.openedAt + (g.delayMs ?? SIGN_DELAY_MS) - g.now);
  const needScroll = !g.reachedEnd;
  return { armed: waitMs === 0 && !needScroll, waitMs, needScroll };
}
