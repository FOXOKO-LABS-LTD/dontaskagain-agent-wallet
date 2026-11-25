// How long the wallet keeps its own E2E operations (the encrypted local history — the public Signer sees no content,
// so this is the only place they live). Final operations: up to E2E_HISTORY_KEEP_MS, at most E2E_HISTORY_MAX of them,
// and the whole history at most E2E_HISTORY_BYTES of JSON (before encryption); the oldest final ones go first. An
// operation still under way is never dropped.
import { isFinal } from '../op';

export const E2E_HISTORY_KEEP_MS = 90 * 86_400_000;
export const E2E_HISTORY_MAX = 300;
export const E2E_HISTORY_BYTES = 1_000_000;

const timeOf = (r: any) => Date.parse(r?.updated_at ?? r?.created_at ?? '') || 0;

/** Prune in place; returns the ids dropped. */
export function pruneE2EHistory(reqs: Record<string, any>, now = Date.now()): string[] {
  const dropped: string[] = [];
  const finals = Object.entries(reqs).filter(([, r]) => isFinal(r?.status)).sort((a, b) => timeOf(b[1]) - timeOf(a[1]));
  finals.forEach(([k, r], i) => { if (now - timeOf(r) > E2E_HISTORY_KEEP_MS || i >= E2E_HISTORY_MAX) { delete reqs[k]; dropped.push(k); } });
  let size = JSON.stringify(reqs).length;
  for (let i = finals.length - 1; i >= 0 && size > E2E_HISTORY_BYTES; i--) {
    const [k] = finals[i];
    if (!(k in reqs)) continue;
    size -= JSON.stringify(reqs[k]).length + k.length + 6;
    delete reqs[k]; dropped.push(k);
  }
  return dropped;
}
