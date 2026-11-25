// Resources of the account : Energy (red) / Bandwidth (blue) on TRON. A transfer buys what it lacks
// itself (window of the transfer: Proxy or Direct, the cheaper). Here — a separate purchase by the human through the
// Direct products of the gateway: tron/energy, tron/bandwidth, tron/activate, paid in USDC on Base (own.resource).
import { useEffect, useState } from 'react';
import type { StatusView, AccountView, HistoryRow } from '../../shared/api';
import { fmtAmount } from '../../lib/portfolio';
import { I } from '../common/icons';
import { Err, api, loadBalances, n, useAsync, useBalances } from '../common/ui';
import type { ScreenProps } from './screen';
import { t, tk, type Key } from '../../i18n';

type Product = 'energy' | 'bandwidth' | 'activate';
interface Quote { product: Product; amount: number; price_usdc: string; approved_max_usdc: string; usdc_balance: string | null }
const DEF: Record<Product, string> = { energy: '65000', bandwidth: '600', activate: '' };
const LABEL: Record<Product, Key> = { energy: 'home.energy', bandwidth: 'home.bandwidth', activate: 'res.activate' };
/** Purchase failure code → words (res.fail.<CODE>); an unknown code is shown as is. */
const failText = (code: string, status: string) => (code ? tk(`res.fail.${code}`, code) : status);

/** signed → paying / delivering; confirmed → delivered on chain; failed → its code. */
function PurchaseStatus({ row, onActivate }: { row: HistoryRow | null; onActivate: () => void }) {
  if (!row || row.status === 'signed' || row.status === 'pending' || row.status === 'broadcast')
    return <div className="plate info small">{t('res.paying')}</div>;
  if (row.status === 'confirmed') return <div className="plate ok small">{t('res.delivered')}</div>;
  const code = row.message ?? '';
  return <div className="plate bad small">{t('res.failed', { why: failText(code, row.status) })}{code === 'ADDRESS_NOT_ACTIVATED' && <> · <button className="link red" onClick={onActivate}>{t('res.buyActivation')}</button></>}</div>;
}

function Buy({ st, account, activated, nav }: { st: StatusView; account: AccountView; activated: boolean; nav: (p: string) => void }) {
  const [product, setProduct] = useState<Product>('energy');
  const [amount, setAmount] = useState(DEF.energy);
  const [q, setQ] = useState<Quote | null>(null);
  const [done, setDone] = useState('');
  const [rid, setRid] = useState<string | null>(null);
  const [row, setRow] = useState<HistoryRow | null>(null);
  const { busy, err, setErr, run } = useAsync();
  // status of the last purchase until confirmed / failed (request.update → the page reloads status → here)
  useEffect(() => {
    if (!rid) return;
    let stop = false;
    const load = () => api<HistoryRow[]>({ cmd: 'history', account_id: account.id }).then((h) => {
      const r = h.find((x) => x.request_id === rid) ?? null;
      if (stop) return;
      setRow(r);
      if (r?.status === 'confirmed') void loadBalances(account.id, true);
    }).catch(() => {});
    load();
    const t = setInterval(load, 4000);
    return () => { stop = true; clearInterval(t); };
  }, [rid, st, account.id]);
  const final = row && ['confirmed', 'failed', 'rejected', 'expired'].includes(row.status);
  const pick = (p: Product) => { setProduct(p); setAmount(DEF[p]); setQ(null); setErr(''); setDone(''); setRid(null); setRow(null); };
  const products: Product[] = activated && product !== 'activate' ? ['energy', 'bandwidth'] : ['activate', 'energy', 'bandwidth'];
  return (
    <div className="card">
      <h2>{t('res.buyTitle')} <span className="small muted" style={{ fontWeight: 600 }}>{t('res.buySub')}</span></h2>
      <div className="tabs">{products.map((p) => <button key={p} className={`tab ${product === p ? 'active' : ''}`} onClick={() => pick(p)}>{t(LABEL[p])}</button>)}</div>
      {product !== 'activate'
        ? <label className="field"><span>{product === 'energy' ? t('res.energyField') : t('res.bwField')}</span>
            <input className="mono" value={amount} inputMode="numeric" onChange={(e) => { setAmount(e.target.value.replace(/\D/g, '')); setQ(null); }} /></label>
        : <p className="small muted">{t('res.activateHint')}</p>}
      {q && <div className="kv" style={{ marginBottom: 8 }}>
        <span className="k">{t('res.price')}</span><span className="num"><b>≈{'\u00a0'}{fmtAmount(q.price_usdc)} USDC</b> <span className="small muted">{t('res.cap', { v: q.approved_max_usdc })}</span></span>
        <span className="k">{t('res.payment')}</span><span className="small">{t('res.payFrom', { v: q.usdc_balance ?? t('res.unknown') })}</span></div>}
      {done && <div className="plate ok">{done}</div>}
      {rid && <PurchaseStatus row={row} onActivate={() => pick('activate')} />}
      <div className="row">
        <button className="btn" disabled={busy || !st.signer.connected || (product !== 'activate' && !amount)} onClick={() => void run(async () => setQ(await api<Quote>({ cmd: 'resourceQuote', account_id: account.id, product, amount: Number(amount) || 0 })))}>{t('res.quote')}</button>
        <span className="grow" />
        <button className="btn primary" disabled={busy || !q || !st.unlocked || (!!rid && !final)} onClick={() => void run(async () => {
          const r = await api<{ request_id?: string }>({ cmd: 'buyResource', account_id: account.id, product, amount: q!.amount, approved_max_usdc: q!.approved_max_usdc });
          // 0.2.1+: always the operation page (no «Sent to the Signer: awr_…» line); without an id — the history
          nav(r.request_id ? `/op/${encodeURIComponent(r.request_id)}` : '/history'); return;
        })}><I.bolt size={14} /> {t('res.buy')}{q ? ` ≤ ${q.approved_max_usdc} USDC` : ''}</button>
      </div>
      {!st.signer.connected && <div className="small subtle" style={{ marginTop: 6 }}>{t('res.needSigner')}</div>}
      <Err msg={err} />
      <p className="small muted" style={{ marginBottom: 0 }}>{t('res.autoHint')}</p>
    </div>
  );
}

export function Resources({ st, account, nav }: ScreenProps) {
  const b = useBalances([account.id], [st.signer.signed_in, st.settings.debug_direct_node])[account.id];
  const tr = b?.tron;
  const bw = tr ? tr.bandwidth.free_available + tr.bandwidth.staked_available : 0;
  return (
    <div className="screen">
      {!tr && <div className="card muted">{b ? t('res.notRead') : t('home.loading')}</div>}
      {tr && <>
        <div className="card">
          <div className="row between"><span className="lbl energy" style={{ fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em' }}>{t('home.energy')}</span><span className="num" style={{ fontWeight: 700 }}>{n(tr.energy.available)} / {n(tr.energy.limit)}</span></div>
          <div className="meter energy" style={{ height: 14 }}><div style={{ width: `${tr.energy.limit ? Math.min(100, (tr.energy.available / tr.energy.limit) * 100) : 0}%` }} /></div>
          <p className="small muted">{t('res.energyHint')}</p>
        </div>
        <div className="card">
          <div className="row between"><span className="lbl bandwidth" style={{ fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em' }}>{t('home.bandwidth')}</span><span className="num" style={{ fontWeight: 700 }}>{t('home.bytes', { v: n(bw) })}</span></div>
          <div className="meter bandwidth" style={{ height: 14 }}><div style={{ width: `${Math.min(100, (bw / Math.max(600, bw)) * 100)}%` }} /></div>
          <p className="small muted">{t('res.bwHint', { free: n(tr.bandwidth.free_available), staked: n(tr.bandwidth.staked_available) })}</p>
        </div>
        {!tr.activated && <div className="plate warn">{t('res.notActivated')}</div>}
        <Buy st={st} account={account} activated={tr.activated} nav={nav} />
      </>}
    </div>
  );
}
