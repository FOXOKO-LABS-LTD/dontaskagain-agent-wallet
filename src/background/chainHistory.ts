// The account's token history from the chain (EVM: ERC-20 Transfer logs of its own address over about a day). Read
// through the same readers as everything else (E2E: the Signer relay admits only this filter form; direct mode: the
// RPC of the settings), cached in chrome.storage.session (memory only) per account, refreshed when History is opened.
import { servedNets } from '../lib/evm/networks';
import { MAX_CHAIN_ROWS, dateRows, logsFilters, parseLogs, windowRanges, type ChainRow } from '../lib/chain/history';
import { readers } from './requests';
import { getPublic, getSession, patchSession, type ChainHistState } from './store';

export const CHAIN_TTL_MS = 120_000;
/** Block times read per network (the rest are estimated from the nearest read block). */
const MAX_BLOCK_READS = 8;
const running = new Map<string, Promise<boolean>>();

export async function chainCached(accountId: string): Promise<ChainHistState | undefined> {
  return (await getSession()).chainHist?.[accountId];
}

/** Find a chain row by its id (operation page). */
export async function chainRow(id: string): Promise<ChainRow | undefined> {
  for (const st of Object.values((await getSession()).chainHist ?? {})) { const r = st.rows.find((x) => x.id === id); if (r) return r; }
  return undefined;
}

/** Re-read when older than the TTL (or forced). True when the rows changed. One read per account at a time. */
export function refreshChain(accountId: string, force = false): Promise<boolean> {
  const cur = running.get(accountId);
  if (cur) return cur;
  const p = (async () => {
    const prev = await chainCached(accountId);
    if (!force && prev && Date.now() - prev.at < CHAIN_TTL_MS) return false;
    const pub = await getPublic();
    const acc = pub?.accounts.find((a) => a.id === accountId && !a.removed_at);
    const address = acc?.addresses.evm;
    if (!address) return false;
    const r = await readers();
    const rows: ChainRow[] = [];
    const errors: ChainHistState['errors'] = [];
    await Promise.all(servedNets().map(async (net) => {
      try {
        const chain = net.chain_id;
        const head = Number.parseInt(String(await r.evm.rpc(chain, 'eth_blockNumber', [])), 16);
        if (!Number.isFinite(head)) throw new Error('BAD_HEAD');
        const tokens = net.tokens.map((x) => ({ symbol: x.symbol, address: x.address, decimals: x.decimals }));
        const found: ChainRow[] = [];
        for (const range of windowRanges(head, net.network)) {
          for (const params of logsFilters(address, tokens, range)) {
            const logs = await r.evm.rpc(chain, 'eth_getLogs', params);
            found.push(...parseLogs(logs, { accountId, network: net.network, address, tokens }));
          }
        }
        const uniq = [...new Map(found.map((x) => [x.id, x])).values()];
        const known = new Map<number, number>();
        let headAt = Date.now();
        const blocks = [...new Set(uniq.map((x) => x.block))].sort((a, b) => b - a).slice(0, MAX_BLOCK_READS);
        for (const b of [head, ...blocks]) {
          try {
            const blk: any = await r.evm.rpc(chain, 'eth_getBlockByNumber', [`0x${b.toString(16)}`, false]);
            const ts = Number.parseInt(String(blk?.timestamp ?? ''), 16) * 1000;
            if (Number.isFinite(ts) && ts > 0) { known.set(b, ts); if (b === head) headAt = ts; }
          } catch { /* estimated */ }
        }
        rows.push(...dateRows(uniq, known, net.network, { block: head, at: headAt }));
      } catch (e) {
        errors.push({ network: net.network, code: (e as any)?.code ?? String((e as Error)?.message ?? e).split(':')[0].slice(0, 40) });
      }
    }));
    // a network that failed now keeps its rows of the last good read
    const failed = new Set(errors.map((x) => x.network));
    const kept = (prev?.rows ?? []).filter((x) => failed.has(x.network));
    const all = [...rows, ...kept].sort((a, b) => b.at - a.at).slice(0, MAX_CHAIN_ROWS);
    const next: ChainHistState = { at: Date.now(), rows: all, errors };
    const s = await getSession();
    await patchSession({ chainHist: { ...(s.chainHist ?? {}), [accountId]: next } });
    return JSON.stringify(prev?.rows ?? []) !== JSON.stringify(all) || JSON.stringify(prev?.errors ?? []) !== JSON.stringify(errors);
  })().finally(() => running.delete(accountId));
  running.set(accountId, p);
  return p;
}
