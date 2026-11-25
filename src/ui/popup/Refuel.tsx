// «Refuel gas»: ETH from Ethereum to Base / Optimism / Arbitrum through the canonical L1→L2 bridge to the same
// address; not Polygon (gas is POL, REFUEL_UNSUPPORTED). Sign window → own.refuel; the Signer follows the L2 credit.
import { useState } from 'react';
import type { PreparedView } from '../../shared/api';
import { refuelNets } from '../../lib/evm/networks';
import { fmtAmount } from '../../lib/portfolio';
import { Review } from '../common/Review';
import { eta, netName } from '../common/EvmReview';
import { NetLabel } from '../common/Logo';
import { Err, api, useAsync, useBalances } from '../common/ui';
import type { ScreenProps } from './screen';
import { t } from '../../i18n';

const PRESETS = ['0.001', '0.003', '0.01'];

export function Refuel({ st, account, path, nav }: ScreenProps & { path?: string }) {
  const bal = useBalances([account.id], [st.signer.signed_in])[account.id];
  const nets = refuelNets();
  const initial = path?.split('/')[2];
  const [to, setTo] = useState(nets.some((n) => n.network === initial) ? initial! : 'evm:8453');
  const [amount, setAmount] = useState('0.003');
  const [view, setView] = useState<PreparedView | null>(null);
  const [done, setDone] = useState('');
  const { busy, err, setErr, run } = useAsync();
  const amt = amount.trim().replace(',', '.');
  const amtOk = /^\d+(\.\d{1,18})?$/.test(amt) && Number(amt) > 0;
  const l1 = bal?.evm?.['evm:1']?.ETH;
  const sel = nets.find((n) => n.network === to);

  if (view) return (
    <div className="screen">
      <Review v={view} busy={busy} onReject={() => setView(null)} onSign={() => void run(async () => {
        const r = await api<{ status: string; view?: PreparedView; request_id?: string }>({ cmd: 'evmSign', key: view.key, addressChecked: true, build_id: view.build_id });
        if (r.status === 'changed' && r.view) { setView(r.view); setErr(t('refuel.changed')); return; }
        // 0.2.1+: always the operation page (no «Sent to the Signer: awr_…» line); without an id — the history
        nav(r.request_id ? `/op/${encodeURIComponent(r.request_id)}` : '/history'); return;
      })} />
      <Err msg={err} />
    </div>
  );

  return (
    <div className="screen">
      <span className="eyebrow">{account.name} · {t('refuel.eyebrow')}</span>
      <div style={{ height: 10 }} />
      {done && <div className="plate ok">{done}</div>}
      <form className="card" onSubmit={(e) => { e.preventDefault(); setDone(''); void run(async () => setView(await api<PreparedView>({ cmd: 'refuelPrepare', account_id: account.id, to_network: to, amount_eth: amt }))); }}>
        <div className="kv small"><span className="k">{t('refuel.from')}</span><span><b>Ethereum</b> · ETH {l1 !== undefined ? <span className="num">{fmtAmount(l1)}</span> : '…'}</span></div>
        <div className="field"><span>{t('refuel.to')}</span>
          <div className="netpick">
            {nets.map((n) => <button type="button" key={n.network} className={`btn sm ${to === n.network ? 'primary' : ''}`} onClick={() => setTo(n.network)}><NetLabel network={n.network} name={netName(n.network)} /> · {eta(n.refuel!.eta_sec)}</button>)}
            <button type="button" className="btn sm" disabled title="REFUEL_UNSUPPORTED">{t('refuel.polygon')}</button>
          </div></div>
        <label className="field"><span>{t('refuel.howMuch')}</span><input className="mono" style={{ fontSize: 20, fontWeight: 700 }} value={amount} inputMode="decimal" onChange={(e) => setAmount(e.target.value)} /></label>
        <div className="row">{PRESETS.map((p) => <button type="button" key={p} className={`btn sm ${amount === p ? 'primary' : ''}`} onClick={() => setAmount(p)}>{p}</button>)}</div>
        <div className="kv small" style={{ marginTop: 8 }}>
          <span className="k">{t('refuel.now', { net: netName(to) })}</span><span className="num">{bal?.evm?.[to]?.ETH !== undefined ? fmtAmount(bal.evm[to].ETH) : '…'} ETH</span>
          <span className="k">{t('bridge.time')}</span><span>{t('refuel.after', { eta: eta(sel?.refuel?.eta_sec ?? 300) })}</span>
          <span className="k">{t('refuel.bridge')}</span><span>{sel?.refuel?.kind === 'arbitrum' ? t('refuel.arb') : t('refuel.op')}</span>
        </div>
        <p className="small muted">{t('refuel.hint')}</p>
        <div className="row"><span className="grow" /><button className="btn primary" disabled={busy || !amtOk || !st.signer.connected}>{busy ? t('send.building') : t('send.check')}</button></div>
        <Err msg={err} />
      </form>
    </div>
  );
}
