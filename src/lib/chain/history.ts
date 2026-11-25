// Token history of the account's own EVM address read from the chain (ERC-20 `Transfer` logs) — what the wallet
// did not start itself (incoming payments, transfers made elsewhere). Pure: filters, window, parsing, the operation
// page of one chain row. The wallet's own operations (with their steps and txids) come from its local history; a chain
// row with a txid the wallet already knows is not shown twice.
//
// Limits (the Signer's relay admits exactly this form — `BAD_LOGS_FILTER` otherwise): `topics[0]` = Transfer, the
// listed token contracts of the network, a range of at most LOGS_CHUNK blocks per call, at most LOGS_MAX_CHUNKS calls
// per direction. The window is about a day (WINDOW_SEC), shorter on fast chains (Arbitrum: ~2 h).
// TRON: a full node has no history by address in its standard API — no chain rows; the page links to the explorer.
import { formatUnits } from '../amount';
import { fmtAmount } from '../portfolio';
import { shortAddr } from '../similar';
import { explorerTx, netLabel, type OpView } from '../op';
import { t } from '../../i18n';

export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const LOGS_CHUNK = 10_000;
export const LOGS_MAX_CHUNKS = 3;
export const WINDOW_SEC = 86_400;
/** Typical seconds per block (the window in blocks; timestamps of blocks not read are estimated from it). */
export const BLOCK_SEC: Record<string, number> = { 'evm:1': 12, 'evm:42161': 0.25, 'evm:10': 2, 'evm:137': 2, 'evm:8453': 2 };
/** Rows kept per account (newest). */
export const MAX_CHAIN_ROWS = 200;

export interface ChainToken { symbol: string; address: string; decimals: number }
export interface ChainRow {
  /** `chain:<network>:<txid>:<logIndex>` — the id of its operation page */
  id: string; account_id: string; network: string; txid: string; log_index: number; block: number;
  /** ms; `at_estimated` — from the block number, not read */
  at: number; at_estimated?: boolean;
  dir: 'in' | 'out' | 'self'; asset: string; amount: string; from: string; to: string;
}

export const chainId = (network: string, txid: string, logIndex: number) => `chain:${network}:${txid.toLowerCase()}:${logIndex}`;
export const isChainId = (id: string) => id.startsWith('chain:');

/** Block ranges of the window, newest first: [from, to] inclusive, each at most LOGS_CHUNK − 1 apart … LOGS_CHUNK. */
export function windowRanges(head: number, network: string, windowSec = WINDOW_SEC): [number, number][] {
  const blocks = Math.min(Math.ceil(windowSec / (BLOCK_SEC[network] ?? 2)), LOGS_CHUNK * LOGS_MAX_CHUNKS);
  const out: [number, number][] = [];
  let to = head;
  const stop = Math.max(0, head - blocks);
  while (to > stop && out.length < LOGS_MAX_CHUNKS) {
    const from = Math.max(stop + 1, to - LOGS_CHUNK);
    out.push([from, to]);
    to = from - 1;
  }
  return out;
}

const word = (addr: string) => `0x${'0'.repeat(24)}${addr.toLowerCase().replace(/^0x/, '')}`;
const hex = (n: number) => `0x${n.toString(16)}`;

/** The two filters of one range: sent by the address, received by it. */
export function logsFilters(address: string, tokens: ChainToken[], [from, to]: [number, number]): unknown[][] {
  const base = { fromBlock: hex(from), toBlock: hex(to), address: tokens.map((x) => x.address.toLowerCase()) };
  return [
    [{ ...base, topics: [TRANSFER_TOPIC, word(address)] }],
    [{ ...base, topics: [TRANSFER_TOPIC, null, word(address)] }],
  ];
}

/** Logs → rows of this account (only Transfer of listed tokens touching the address; anything else is dropped). */
export function parseLogs(logs: any[], o: { accountId: string; network: string; address: string; tokens: ChainToken[] }): ChainRow[] {
  const me = o.address.toLowerCase();
  const out: ChainRow[] = [];
  for (const l of Array.isArray(logs) ? logs : []) {
    try {
      const tok = o.tokens.find((x) => x.address.toLowerCase() === String(l?.address ?? '').toLowerCase());
      const tp: string[] = Array.isArray(l?.topics) ? l.topics.map((x: unknown) => String(x).toLowerCase()) : [];
      if (!tok || tp.length !== 3 || tp[0] !== TRANSFER_TOPIC) continue;
      if (!/^0x[0-9a-f]{64}$/.test(tp[1]) || !/^0x[0-9a-f]{64}$/.test(tp[2])) continue;
      const from = `0x${tp[1].slice(26)}`, to = `0x${tp[2].slice(26)}`;
      if (from !== me && to !== me) continue;
      const txid = String(l.transactionHash ?? '').toLowerCase();
      if (!/^0x[0-9a-f]{64}$/.test(txid) || l.removed === true) continue;
      const data = String(l.data ?? '0x');
      if (!/^0x[0-9a-fA-F]{1,64}$/.test(data)) continue;
      const logIndex = Number.parseInt(String(l.logIndex ?? '0x0'), 16) || 0;
      const block = Number.parseInt(String(l.blockNumber ?? ''), 16);
      if (!Number.isFinite(block)) continue;
      const dir = from === me && to === me ? 'self' : to === me ? 'in' : 'out';
      out.push({ id: chainId(o.network, txid, logIndex), account_id: o.accountId, network: o.network, txid, log_index: logIndex, block, at: 0,
        dir, asset: tok.symbol, amount: formatUnits(BigInt(data), tok.decimals), from, to });
    } catch { /* a malformed log is skipped */ }
  }
  return out;
}

/** Times of rows: read block times where known, the rest estimated from the nearest known block. */
export function dateRows(rows: ChainRow[], known: Map<number, number>, network: string, head: { block: number; at: number }): ChainRow[] {
  const per = (BLOCK_SEC[network] ?? 2) * 1000;
  const pts = [...known.entries(), [head.block, head.at] as [number, number]];
  return rows.map((r) => {
    const exact = known.get(r.block);
    if (exact !== undefined) return { ...r, at: exact, at_estimated: undefined };
    const near = pts.reduce((a, b) => (Math.abs(b[0] - r.block) < Math.abs(a[0] - r.block) ? b : a));
    return { ...r, at: near[1] - (near[0] - r.block) * per, at_estimated: true };
  });
}

/** Every txid a request object carries (tx, steps, mint, refunds…): chain rows of these are the wallet's own. */
export function txidsOf(x: unknown, out = new Set<string>(), depth = 0): Set<string> {
  if (depth > 8 || x == null) return out;
  if (typeof x === 'string') { if (/^(0x)?[0-9a-fA-F]{64}$/.test(x)) out.add(x.toLowerCase().replace(/^0x/, '')); return out; }
  if (Array.isArray(x)) { for (const y of x) txidsOf(y, out, depth + 1); return out; }
  if (typeof x === 'object') for (const v of Object.values(x as Record<string, unknown>)) txidsOf(v, out, depth + 1);
  return out;
}
export const plainTxid = (txid: string) => txid.toLowerCase().replace(/^0x/, '');

/** The operation page of a chain row: one step «in a block», tx link, from / to. */
export function chainOpView(r: ChainRow): OpView {
  const amount = `${fmtAmount(r.amount)} ${r.asset}`;
  const other = r.dir === 'in' ? r.from : r.to;
  const title = r.dir === 'in' ? t('chain.title.in', { amount }) : r.dir === 'out' ? t('chain.title.out', { amount, to: shortAddr(other) }) : t('chain.title.self', { amount });
  const iso = r.at ? new Date(r.at).toISOString() : undefined;
  return {
    request_id: r.id, type: 'transfer', title, subtitle: t('op.subtitle.network', { net: netLabel(r.network) }), initiator: t('chain.initiator'), own: false,
    status: 'confirmed', status_label: t('chain.st.inBlock'), tone: 'ok', final: true, created_at: iso, finished_at: iso,
    steps: [{ key: 'confirm', title: t('chain.step.inBlock', { block: String(r.block) }), state: 'done', network: r.network,
      tx: { hash: r.txid, short: `${r.txid.slice(0, 8)}…${r.txid.slice(-6)}`, url: explorerTx(r.network, r.txid) }, amount: `${r.dir === 'in' ? '+' : r.dir === 'out' ? '−' : ''}${amount}` }],
    facts: [
      { k: t('chain.fact.from'), v: r.from }, { k: t('chain.fact.to'), v: r.to },
      { k: t('chain.fact.where'), v: t('chain.v.where', { net: netLabel(r.network), block: String(r.block) }) },
      ...(r.at_estimated ? [{ k: t('chain.fact.time'), v: t('chain.v.timeEstimated') }] : []),
    ],
    asset: r.asset, network: r.network,
  };
}
