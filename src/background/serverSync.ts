// With the Signer's support:
// - pause of all agents on the server: WS wallet.pause / wallet.resume, `paused` in hello; the local refusal stays
//   only as a fallback while the Signer is unreachable (the change is sent at the next hello);
// - wallet history GET /v1/ext/history (cursor, limit ≤ 200) merged into the local queue, so History, decisions in
//   Agents and the repeat plate survive a browser restart.
import { getJSON } from '../lib/net';
import { currentSession, signerUrl, socket } from './signer';
import { putServerRequests } from './requests';
import { getPublic, getSession, patchSession, setPublic } from './store';

const HISTORY_PAGES = 2;        // up to 400 newest entries
const HISTORY_TTL_MS = 60_000;

export async function setPaused(paused: boolean): Promise<{ paused: boolean; server: boolean; rejected?: number }> {
  const pub = await getPublic();
  if (!pub) throw new Error('NO_WALLET');
  pub.settings = { ...pub.settings, agents_paused: paused };
  await setPublic(pub);
  if (socket.connected) {
    try {
      const a = await socket.request(paused ? 'wallet.pause' : 'wallet.resume', paused ? { paused: true } : {});
      await patchSession({ pauseUnsynced: false } as any);
      return { paused: a?.paused ?? paused, server: true, rejected: a?.rejected };
    } catch (e) { console.warn('wallet.pause', e); }
  }
  await patchSession({ pauseUnsynced: true } as any);
  return { paused, server: false };
}

/** hello: the server's flag wins, unless the human changed it while the Signer was unreachable — then send ours. */
export async function pauseOnHello(m: any): Promise<void> {
  if (typeof m?.paused !== 'boolean') return;
  const s = (await getSession()) as any;
  const pub = await getPublic();
  if (!pub) return;
  if (s.pauseUnsynced) {
    await setPaused(!!pub.settings.agents_paused);
    return;
  }
  if (pub.settings.agents_paused !== m.paused) { pub.settings = { ...pub.settings, agents_paused: m.paused }; await setPublic(pub); }
}

/** Server history → local queue (status, decision.by, error, swap). Pending ones stay pending (they are real). */
export async function fetchHistory(force = false): Promise<number> {
  const ses = currentSession();
  if (!ses) return 0;
  const s = (await getSession()) as any;
  if (!force && s.historyAt && Date.now() - s.historyAt < HISTORY_TTL_MS) return 0;
  let cursor: string | null = null, n = 0;
  for (let page = 0; page < HISTORY_PAGES; page++) {
    const q = new URLSearchParams({ limit: '200', ...(cursor ? { cursor } : {}) });
    const r = await getJSON(`${signerUrl()}/v1/ext/history?${q}`, { Authorization: `Bearer ${ses}` });
    const batch: Parameters<typeof putServerRequests>[0] = [];
    for (const it of (r?.items ?? []) as any[]) {
      const req = it?.request;
      if (it?.kind !== 'request' || !req?.request_id) continue;
      batch.push({ req: { ...req, own: !req.agent }, receivedAt: Date.parse(req.created_at ?? it.at) || Date.now() });
    }
    n += await putServerRequests(batch); // one write per page (was one read + write per item: seconds for 400 items); n = changed
    if (typeof r?.paused === 'boolean' && page === 0) await pauseOnHello({ paused: r.paused });
    cursor = r?.next_cursor ?? null;
    if (!cursor) break;
  }
  await patchSession({ historyAt: Date.now() } as any);
  return n;
}
