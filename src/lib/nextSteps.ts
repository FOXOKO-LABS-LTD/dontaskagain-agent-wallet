// 0.3.5: the wallet never signs on the human's behalf. The only signatures that follow
// a human's «Sign» without a new window are steps of the very operation signed, and the sign window names them:
//   1) x402 payment for TRON resources, within the cap the window shows, bound to this request;
//   2) bridge.mint (CCTP) to the wallet's own address, for a bridge the human signed with delivery «self».
// Pure: the sign window and the tests use it; no item → no line.
import type { PreparedView } from '../shared/api';
import { formatUnits, parseUnits } from './amount';

export interface FollowUps { pay_cap_usdc?: string; mint_net?: string }

const micro = (s: string | undefined | null): bigint | null => {
  if (!s || !/^\d+(\.\d+)?$/.test(String(s).trim())) return null;
  try { return parseUnits(String(s).trim(), 6); } catch { return null; }
};
const maxOf = (xs: (string | undefined | null)[]): string | undefined => {
  let m: bigint | null = null;
  for (const x of xs) { const v = micro(x); if (v !== null && (m === null || v > m)) m = v; }
  return m === null || m <= 0n ? undefined : formatUnits(m, 6);
};

/** What the wallet signs after this window's «Sign» without a new window (only what applies to this view). */
export function followUps(v: PreparedView): FollowUps {
  const out: FollowUps = {};
  const r = v.resources;
  if (r && r.route && r.route !== 'none') {
    const cap = maxOf([r.approved_max_usdc, r.fallback_route ? r.fallback_approved_max_usdc : undefined]);
    if (cap) out.pay_cap_usdc = cap;
  }
  if (v.swap && Number(v.swap.resources_cap_usdc) > 0) {
    const cap = maxOf([v.swap.resources_cap_usdc]);
    if (cap) out.pay_cap_usdc = cap;
  }
  const b = v.bridge;
  if (b && b.delivery === 'self') out.mint_net = b.to_name || b.to_network;
  return out;
}
