// Balances of an account: TRX / USDT / energy / bandwidth on TRON; native + USDC/USDT in every served EVM network.
import { formatUnits } from '../lib/amount';
import { erc20Balance, nativeBalance } from '../lib/evm/erc20';
import { servedNets } from '../lib/evm/networks';
import { accountState, trc20Balance, USDT_TRON } from '../lib/tron/chain';
import type { BalancesView } from '../shared/api';
import { currentSession } from './signer';
import { readers } from './requests';
import { getPublic } from './store';
import { t } from '../i18n';

// 0.1.7 (speed): the last balances of each account live in the worker's memory. A page shows them at once
// (balancesCached), then asks for fresh ones; a repeated ask within TTL_MS — and parallel asks — share one fetch.
const TTL_MS = 20_000;
const cache = new Map<string, { at: number; v: BalancesView }>();
const inflight = new Map<string, Promise<BalancesView>>();

export function balancesCached(ids: string[]): Record<string, BalancesView> {
  return Object.fromEntries(ids.filter((id) => cache.has(id)).map((id) => [id, cache.get(id)!.v]));
}

export function balancesOf(id: string, force = false): Promise<BalancesView> {
  const c = cache.get(id);
  if (!force && c && Date.now() - c.at < TTL_MS) return Promise.resolve(c.v);
  const running = inflight.get(id);
  if (running) return running;
  const p = fetchBalances(id).then((v) => { if (!v.errors.length || !c) cache.set(id, { at: Date.now(), v }); return v; }).finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

/** After a signed transaction the numbers are stale. */
export function dropBalances(id?: string): void { if (id) cache.delete(id); else cache.clear(); }

async function fetchBalances(id: string): Promise<BalancesView> {
  const pub = await getPublic();
  const a = pub?.accounts.find((x) => x.id === id);
  if (!a) throw new Error('UNKNOWN_ACCOUNT');
  const r = await readers();
  const out: BalancesView = { at: new Date().toISOString(), errors: [] };
  const jobs: Promise<void>[] = [];
  if (a.addresses.tron) jobs.push((async () => {
    try {
      const [st, usdt] = await Promise.all([accountState(r.tron, a.addresses.tron!), trc20Balance(r.tron, USDT_TRON, a.addresses.tron!).catch(() => 0n)]);
      out.tron = { TRX: formatUnits(st.balanceSun, 6), USDT: formatUnits(usdt, 6), activated: st.exists, energy: st.energy, bandwidth: { staked_available: st.bandwidth.staked_available, free_available: st.bandwidth.free_available } };
    } catch (e) { out.errors.push('TRON: ' + (e as Error).message); }
  })());
  // EVM: native + tokens of every served EVM network (one address for all); Base keeps `base` too
  if (a.addresses.evm && currentSession()) {
    const evm: Record<string, Record<string, string>> = {};
    out.evm = evm;
    for (const n of servedNets()) jobs.push((async () => {
      try {
        const [nat, ...toks] = await Promise.all([nativeBalance(r.evm, n.chain_id, a.addresses.evm!), ...n.tokens.map((t) => erc20Balance(r.evm, n.chain_id, t.address, a.addresses.evm!))]);
        const row: Record<string, string> = { [n.native.symbol]: formatUnits(nat, n.native.decimals, 6) };
        n.tokens.forEach((t, i) => { row[t.symbol] = formatUnits(toks[i], t.decimals); });
        evm[n.network] = row;
        if (n.network === 'evm:8453') out.base = { USDC: row.USDC ?? '0', ETH: row.ETH ?? '0' };
      } catch (e) { out.errors.push(`${n.name}: ${(e as Error).message}`); }
    })());
  } else if (a.addresses.evm) out.errors.push(t('bg.evmNeedsSignIn'));
  await Promise.all(jobs);
  return out;
}
