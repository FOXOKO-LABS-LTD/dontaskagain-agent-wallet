// Main screen : big $ sum of the account, Send / Receive / Swap / Resources, tabs Assets / History /
// Agents (with the number of waiting requests). Assets: every asset of every network in one list with a network tag,
// zero rows hidden (toggle), and for TRON the Energy / Bandwidth line under the list.
import { useEffect, useState } from 'react';
import type { AccountView, BalancesView, ChainStatusView, HistoryRow } from '../../shared/api';
import { assetRows, fmtAmount, fmtUsd, totalUsd, visibleRows } from '../../lib/portfolio';
import { requestAmount, requestTarget } from '../../lib/requestLabel';
import { I } from '../common/icons';
import { Mascot } from '../common/Mascot';
import { CoinLogo } from '../common/Logo';
import { priceHint } from '../../lib/prices';
import { api, fmtTime, loadBalances, n, useBalances, usePrices, useWorkerChanged } from '../common/ui';
import { shortAddr } from '../../lib/similar';
import { netLabel } from '../../lib/op';
import { fmtAmount as fmtAmt } from '../../lib/portfolio';
import networksCfg from '../../config/networks.json';
import { AgentsTab } from './Agents';
import { TYPE_INFO, type RequestType } from '../../lib/wallet/model';
import type { ScreenProps } from './screen';
import { t, tk, type Key } from '../../i18n';

type Tab = 'assets' | 'history' | 'agents';
const ZERO_KEY = 'aw.showZero';

export function Home(p: ScreenProps & { tab: Tab }) {
  const { st, account, nav, tab } = p;
  const bal = useBalances([account.id], [st.signer.signed_in, st.settings.debug_direct_node])[account.id];
  const prices = usePrices(st.signer.signed_in);
  const rows = assetRows(bal, prices ?? {});
  const tot = totalUsd(rows);
  const T = (id: Tab, label: string, extra?: React.ReactNode) => <button className={`tab ${tab === id ? 'active' : ''}`} onClick={() => nav(id === 'assets' ? '/' : `/${id}`)}>{label}{extra}</button>;
  return (
    <div className="screen">
      {!st.signer.connected && <div className="plate warn small">{t('home.noSigner')} <button className="link" onClick={() => nav('/settings')}>{t('home.signIn')}</button></div>}
      {st.settings.agents_paused && <div className="plate bad small">{t('home.paused')} <button className="link red" onClick={() => nav('/agents')}>{t('home.agents')}</button></div>}
      {tab !== 'agents' && st.agents.some((a) => !a.revoked_at && a.new_types?.length) && <div className="plate info small">{t('home.newTypes', { list: [...new Set(st.agents.filter((a) => !a.revoked_at).flatMap((a) => a.new_types ?? []))].map((x) => TYPE_INFO[x as RequestType]?.label ?? x).join(', ') })} <button className="link" onClick={() => nav('/agents')}>{t('home.agents')}</button></div>}
      <div className="balance">
        <div className="row between"><span className="eyebrow">{account.name}</span>
          <button className="iconbtn flat" title={t('home.refresh')} onClick={() => void loadBalances(account.id, true)} style={{ width: 26, height: 26 }}><I.refresh size={13} /></button></div>
        <div className={`total ${tot.partial ? 'partial' : ''}`} style={{ marginTop: 8 }}>{bal ? fmtUsd(tot.usd) : '—'}</div>
        <div className="small" style={{ marginTop: 4, fontWeight: 600 }}>
          {!bal ? t('home.loadingBalances') : tot.partial ? t('home.partial') : tot.stale ? <span title={t('home.staleTitle')}>{t('home.stale')}</span> : sourceLine(rows)}
        </div>
      </div>
      <div className="actions4">
        <button className="act primary" onClick={() => nav('/send')}><I.send />{t('title.send')}</button>
        <button className="act" onClick={() => nav('/receive')}><I.receive />{t('title.receive')}</button>
        <button className="act" onClick={() => nav('/swap')}><I.swap />{t('title.swap')}</button>
        <button className="act" onClick={() => nav('/resources')}><I.bolt />{t('title.resources')}</button>
      </div>
      <div className="actions2">
        <button className="act" onClick={() => nav('/bridge')}><I.bridge size={15} />{t('home.bridge')}</button>
        <button className="act" onClick={() => nav('/refuel')}><I.fuel size={15} />{t('home.refuel')}</button>
      </div>
      <div className="tabs">{T('assets', t('home.tabAssets'))}{T('history', t('home.tabHistory'))}{T('agents', t('home.agents'), st.pending > 0 ? <span className="badge accent">{st.pending}</span> : null)}</div>
      {tab === 'assets' && <Assets bal={bal} rows={rows} />}
      {tab === 'history' && <History account={account} st={p.st} />}
      {tab === 'agents' && <AgentsTab {...p} />}
    </div>
  );
}

function Assets({ bal, rows }: { bal?: BalancesView; rows: ReturnType<typeof assetRows> }) {
  const [showZero, setShowZero] = useState(() => localStorage.getItem(ZERO_KEY) === '1');
  const vis = visibleRows(rows, showZero);
  const tron = bal?.tron;
  return (
    <div>
      <div className="list">
        {!bal && <div className="empty">{t('home.loading')}</div>}
        {bal && !vis.length && <div className="empty"><Mascot state="empty" size={64} />{t('home.noAssets')}{rows.length ? t('home.zeroHidden') : ''}</div>}
        {vis.map((r) => (
          <div key={r.key} className="asset">
            <CoinLogo symbol={r.symbol} network={r.network} logo={r.price?.logo_url} />
            <div><div className="sym">{r.symbol} <span className="net">· {r.network_name}</span></div>
              {r.key === 'tron/TRX' && tron && !tron.activated && <span className="badge warn">{t('home.notActivated')}</span>}
              {r.key === 'evm:8453/USDC' && <div className="small muted">{t('home.x402')}</div>}</div>
            <div><div className="amt">{fmtAmount(r.amount)}</div><div className={`usd ${r.price?.stale ? 'stale' : ''}`} title={priceHint(r.price)}>{r.usd === null ? t('home.noPrice') : fmtUsd(r.usd)}{r.price?.stale && <span className="stale-mark">{t('home.staleMark')}</span>}</div></div>
          </div>
        ))}
      </div>
      <label className="switch small" style={{ marginTop: -6 }}><span className="muted" style={{ fontWeight: 600 }}>{t('home.showZero')}</span>
        <input type="checkbox" checked={showZero} onChange={(e) => { setShowZero(e.target.checked); localStorage.setItem(ZERO_KEY, e.target.checked ? '1' : '0'); }} /></label>
      {tron && (
        <div className="card" style={{ marginTop: 8 }}>
          <div className="row between" style={{ marginBottom: 6 }}><span className="eyebrow">{t('home.tronRes')}</span></div>
          <div className="res">
            <div><div className="lbl energy">{t('home.energy')}</div><div className="num small">{n(tron.energy.available)} / {n(tron.energy.limit)}</div>
              <div className="meter energy"><div style={{ width: `${tron.energy.limit ? Math.min(100, (tron.energy.available / tron.energy.limit) * 100) : 0}%` }} /></div></div>
            <div><div className="lbl bandwidth">{t('home.bandwidth')}</div><div className="num small">{t('home.bytes', { v: n(tron.bandwidth.free_available + tron.bandwidth.staked_available) })}</div>
              <div className="meter bandwidth"><div style={{ width: `${Math.min(100, ((tron.bandwidth.free_available + tron.bandwidth.staked_available) / 600) * 100)}%` }} /></div></div>
          </div>
        </div>
      )}
      {bal?.errors.map((e, i) => <div key={i} className="small subtle">{e}</div>)}
    </div>
  );
}

// Status word + badge class; the words follow the UI language (getters, so importers keep the same shape).
const STATUS_CLS: Record<string, string> = { signed: 'ok', broadcast: 'ok', confirmed: 'ok', rejected: 'bad', expired: 'warn', failed: 'bad', unknown: '', pending: 'warn' };
export const STATUS: Record<string, [string, string]> = Object.defineProperties({}, Object.fromEntries(Object.entries(STATUS_CLS).map(([k, c]) =>
  [k, { enumerable: true, get: (): [string, string] => [t(`hist.st.${k}` as Key), c] }])));
const BY_KEYS: HistoryRow['by'][] = ['human', 'pause', 'extension', 'server'];
export const BY: Record<HistoryRow['by'], string> = Object.defineProperties({} as Record<HistoryRow['by'], string>, Object.fromEntries(BY_KEYS.map((k) =>
  [k, { enumerable: true, get: () => t(`hist.by.${k}` as Key) }])));

export function HistoryList({ rows, showAccount }: { rows: HistoryRow[]; showAccount?: boolean }) {
  if (!rows.length) return <div className="list"><div className="empty"><Mascot state="empty" size={64} />{t('hist.empty')}</div></div>;
  return (
    <div className="list">
      {rows.map((h) => {
        const [st0, cls] = STATUS[h.status] ?? [h.status, ''];
        // 0.2.1: words instead of «sent» for a bridge / refuel / swap on the way (a multi-step operation that is
        // neither final nor waiting has a progress line); the line opens the operation page
        const st = h.progress ? t('hist.onTheWay') : st0;
        if (h.chain) return <ChainLine key={h.request_id} h={h} showAccount={showAccount} />;
        return (
          <div key={h.request_id} className="list-item click" onClick={() => { location.hash = `#/op/${encodeURIComponent(h.request_id)}`; }}>
            <div className="row between">
              <span className="num" style={{ fontWeight: 700 }}>{requestAmount(h)}</span>
              <span className={`badge ${cls}`}>{st}</span>
            </div>
            {h.progress && <div className="small" style={{ marginTop: 2, fontWeight: 700, color: 'var(--info)' }}>{h.progress}</div>}
            <div className="row between small muted" style={{ marginTop: 2 }}>
              <span>{h.own ? t('hist.you') : h.agent?.name ?? t('hist.agent')} {requestTarget(h)}{showAccount && h.account ? ` · ${h.account.name}` : ''}</span>
              <span>{h.status !== 'unknown' && <span className="badge" style={{ marginRight: 4 }}>{BY[h.by]}</span>}{fmtTime(new Date(h.at).toISOString())}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** 0.3.12: a token movement read from the chain (not started by this wallet): direction, amount, the other side. */
function ChainLine({ h, showAccount }: { h: HistoryRow; showAccount?: boolean }) {
  const c = h.chain!;
  const sign = c.dir === 'in' ? '+' : c.dir === 'out' ? '−' : '';
  return (
    <div className="list-item click chain-row" title={t('hist.chainTitle')} onClick={() => { location.hash = `#/op/${encodeURIComponent(h.request_id)}`; }}>
      <div className="row between">
        <span className="num" style={{ fontWeight: 700 }}>{sign}{fmtAmt(String(h.intent?.amount ?? ''))} {h.intent?.asset ?? ''}</span>
        <span className="badge">{t('hist.chainBadge')}</span>
      </div>
      <div className="row between small muted" style={{ marginTop: 2 }}>
        <span>{c.dir === 'in' ? t('hist.chainIn') : c.dir === 'out' ? t('hist.chainOut') : t('hist.chainSelf')} {c.dir === 'in' ? '←' : '→'} {shortAddr(c.counterparty)} · {netLabel(h.network)}{showAccount && h.account ? ` · ${h.account.name}` : ''}</span>
        <span>{c.estimated ? '≈ ' : ''}{fmtTime(new Date(h.at).toISOString())}</span>
      </div>
    </div>
  );
}

/** Explorer pages of the account's addresses (our own list of explorers only). */
function explorerLinks(a: AccountView): { label: string; url: string }[] {
  const out: { label: string; url: string }[] = [];
  for (const n of networksCfg.networks as any[]) {
    if (!n.enabled || !n.explorer_addr) continue;
    const addr = n.network === 'tron' ? a.addresses.tron : /^evm:/.test(n.network) ? a.addresses.evm : undefined;
    if (!addr || !/^(T[1-9A-HJ-NP-Za-km-z]{33}|0x[0-9a-fA-F]{40})$/.test(addr)) continue;
    if (n.network !== 'tron' && !['evm:1', 'evm:42161', 'evm:10', 'evm:137', 'evm:8453'].includes(n.network)) continue;
    out.push({ label: netLabel(n.network), url: String(n.explorer_addr).replace('{addr}', addr) });
  }
  return out;
}

function History({ account, st }: { account: AccountView; st: ScreenProps['st'] }) {
  const accountId = account.id;
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [chain, setChain] = useState<ChainStatusView | null>(null);
  const load = () => {
    api<HistoryRow[]>({ cmd: 'history', account_id: accountId }).then(setRows).catch(() => setRows([]));
    api<ChainStatusView>({ cmd: 'chainStatus', account_id: accountId }).then(setChain).catch(() => setChain(null));
  };
  useEffect(load, [accountId, st]); // eslint-disable-line react-hooks/exhaustive-deps
  useWorkerChanged(load);
  if (!rows) return <div className="list"><div className="empty">{t('home.loading')}</div></div>;
  return (
    <div>
      {chain?.loading && account.addresses.evm && <div className="small muted" style={{ marginBottom: 6 }}>{t('hist.loadingChain')}</div>}
      <HistoryList rows={rows} />
      {chain?.errors.map((e) => <div key={e.network} className="small subtle">{t('hist.chainErr', { net: netLabel(e.network), code: e.code })}</div>)}
      <div className="small muted hist-note" style={{ marginTop: 8 }}>{t('hist.note')}{' '}
        {explorerLinks(account).map((x, i) => <span key={x.url}>{i ? ' · ' : ''}<a className="link" href={x.url} target="_blank" rel="noreferrer">{x.label}</a></span>)}
      </div>
    </div>
  );
}

/** Under the total: where the prices come from (all priced, none stale). */
function sourceLine(rows: ReturnType<typeof assetRows>): string {
  const src = new Set(rows.filter((r) => r.price && !isZeroAmt(r.amount)).map((r) => r.price!.source));
  if (!src.size) return t('home.pricesSrc', { src: 'coins.ceo' });
  return t('home.pricesSrc', { src: [...src].map((x) => (x === 'x402' ? t('home.trxByQuote') : x)).join(', ') });
}
const isZeroAmt = (a: string) => !(Number(a) > 0);
