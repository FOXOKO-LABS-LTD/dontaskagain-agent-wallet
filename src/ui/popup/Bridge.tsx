// «Move USDC between networks»: from, to, amount, mode (fast / standard), delivery (auto / self / Circle), live
// Iris fees through the Signer: minimum received, burned, fee, time → sign window (approve? + burn with one
// button) → own.bridge. The mint on the destination network is done by the wallet itself or by Circle Forwarding.
import { useEffect, useState } from 'react';
import type { BridgeQuoteView, PreparedView } from '../../shared/api';
import { cctpNets } from '../../lib/evm/networks';
import { fmtAmount } from '../../lib/portfolio';
import { Review } from '../common/Review';
import { eta, netName, openRefuel } from '../common/EvmReview';
import { NetLabel } from '../common/Logo';
import { I } from '../common/icons';
import { Err, api, useAsync, useBalances } from '../common/ui';
import type { ScreenProps } from './screen';
import { t } from '../../i18n';

type Mode = 'fast' | 'standard';
type Delivery = 'auto' | 'self' | 'forwarding';
const NETS = cctpNets().map((n) => n.network);

export function Bridge({ st, account, nav }: ScreenProps) {
  const bal = useBalances([account.id], [st.signer.signed_in])[account.id];
  const [from, setFrom] = useState('evm:42161');
  const [to, setTo] = useState('evm:8453');
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState<Mode>('fast');
  const [delivery, setDelivery] = useState<Delivery>('auto');
  const [q, setQ] = useState<BridgeQuoteView | null>(null);
  const [view, setView] = useState<PreparedView | null>(null);
  const [done, setDone] = useState('');
  const { busy, err, setErr, run } = useAsync();
  const amt = amount.trim().replace(',', '.');
  const amtOk = /^\d+(\.\d{1,6})?$/.test(amt) && Number(amt) > 0;
  const have = bal?.evm?.[from]?.USDC;

  useEffect(() => {
    setQ(null);
    if (!amtOk || !st.signer.signed_in || from === to) return;
    let stop = false;
    const load = () => api<BridgeQuoteView>({ cmd: 'bridgeQuote', account_id: account.id, from_network: from, to_network: to, amount: amt, mode, delivery })
      .then((x) => { if (!stop) setQ(x); }).catch((e) => { if (!stop) setQ({ ok: false, code: 'ERROR', message: (e as Error).message } as BridgeQuoteView); });
    const t = setTimeout(load, 400);
    const iv = setInterval(load, 20_000);
    return () => { stop = true; clearTimeout(t); clearInterval(iv); };
  }, [from, to, amt, mode, delivery, st.signer.signed_in, account.id]);

  if (view) return (
    <div className="screen">
      <Review v={view} busy={busy} onReject={() => setView(null)} onSign={() => void run(async () => {
        const r = await api<{ status: string; view?: PreparedView; request_id?: string }>({ cmd: 'evmSign', key: view.key, addressChecked: true, build_id: view.build_id });
        if (r.status === 'changed' && r.view) { setView(r.view); setErr(t('bridge.changed')); return; }
        // 0.2.1+: always the operation page (no «Sent to the Signer: awr_…» line); without an id — the history
        nav(r.request_id ? `/op/${encodeURIComponent(r.request_id)}` : '/history'); return;
      })} />
      <Err msg={err} />
    </div>
  );

  const pick = (label: string, cur: string, set: (x: string) => void, other: string) => (
    <div className="field"><span>{label}</span>
      <div className="netpick">{NETS.map((n) => <button type="button" key={n} disabled={n === other} className={`btn sm ${cur === n ? 'primary' : ''}`} onClick={() => set(n)}><NetLabel network={n} name={netName(n)} /></button>)}</div></div>
  );
  return (
    <div className="screen">
      <span className="eyebrow">{account.name} · USDC · CCTP Circle</span>
      <div style={{ height: 10 }} />
      {done && <div className="plate ok">{done}</div>}
      <form className="card" onSubmit={(e) => { e.preventDefault(); setDone(''); void run(async () => setView(await api<PreparedView>({ cmd: 'bridgePrepare', account_id: account.id, from_network: from, to_network: to, amount: amt, mode, delivery }))); }}>
        {pick(t('bridge.from'), from, (x) => { setFrom(x); if (x === to) setTo(from); }, '')}
        <div className="flip" style={{ margin: '-4px 0 4px' }}><button type="button" className="iconbtn" title={t('swap.flip')} onClick={() => { setFrom(to); setTo(from); }}><I.swap size={14} /></button></div>
        {pick(t('bridge.to'), to, setTo, from)}
        <label className="field"><span>{t('bridge.amount')}</span><input className="mono" style={{ fontSize: 20, fontWeight: 700 }} value={amount} inputMode="decimal" placeholder="0" onChange={(e) => setAmount(e.target.value)} /></label>
        <div className="row between small"><span className="muted">{t('bridge.inNet', { net: netName(from) })} <span className="num">{have !== undefined ? fmtAmount(have) : '…'} USDC</span></span>
          {have && Number(have) > 0 && <button type="button" className="link" onClick={() => setAmount(have)}>{t('send.all')}</button>}</div>
        <div className="field"><span>{t('bridge.mode')}</span><div className="row">
          <button type="button" className={`btn sm ${mode === 'fast' ? 'primary' : ''}`} onClick={() => setMode('fast')}>{t('bridge.fast')}</button>
          <button type="button" className={`btn sm ${mode === 'standard' ? 'primary' : ''}`} onClick={() => setMode('standard')}>{t('bridge.standard')}</button></div></div>
        <div className="field"><span>{t('bridge.delivery')}</span><div className="row">
          {([['auto', t('bridge.dAuto')], ['self', t('bridge.dSelf')], ['forwarding', 'Circle']] as const).map(([k, l]) => <button type="button" key={k} className={`btn sm ${delivery === k ? 'primary' : ''}`} onClick={() => setDelivery(k)}>{l}</button>)}</div>
          <div className="small muted">{t('bridge.deliveryHint', { net: netName(to) })}</div></div>
        {q && q.ok && (
          <div className="kv small">
            <span className="k">{t('bridge.receive')}</span><span className="num"><b>{t('bridge.atLeast', { v: q.receive_at_least })}</b> {t('bridge.onNet', { net: netName(q.to_network) })}</span>
            <span className="k">{t('bridge.burn')}</span><span className="num">{q.burn} USDC {t('bridge.onNet', { net: netName(q.from_network) })}</span>
            <span className="k">{t('bridge.fee')}</span><span className="num">{t('bridge.upTo', { v: q.max_fee })} <span className="muted">(CCTP {q.protocol_fee}{q.delivery === 'forwarding' ? ` + Circle ${q.forward_fee}` : ''})</span></span>
            <span className="k">{t('bridge.time')}</span><span>{eta(q.eta_sec)} · {q.mode_effective === 'fast' ? t('bridge.modeFast') : t('bridge.modeStd')}</span>
            <span className="k">{t('bridge.receiving')}</span><span>{q.delivery === 'self' ? t('bridge.self') : 'Circle Forwarding'}{q.delivery_reason && delivery === 'auto' ? ` — ${q.delivery_reason}` : ''}</span>
          </div>
        )}
        {q && !q.ok && <div className="plate warn">{q.message} {q.code && <span className="small">({q.code})</span>}
          {q.code === 'INSUFFICIENT_GAS' && <div style={{ marginTop: 6 }}><button type="button" className="btn sm" onClick={() => setDelivery('forwarding')}>{t('bridge.viaCircle')}</button>{' '}
            {(to === 'evm:8453' || to === 'evm:10' || to === 'evm:42161') && <button type="button" className="btn sm" onClick={() => openRefuel(to)}>{t('title.refuel')}</button>}</div>}</div>}
        <p className="small muted">{t('bridge.hint')}</p>
        <div className="row"><span className="grow" /><button className="btn primary" disabled={busy || !amtOk || from === to || !st.signer.connected || (!!q && !q.ok)}>{busy ? t('send.building') : t('send.check')}</button></div>
        {!st.signer.connected && <div className="small subtle" style={{ marginTop: 6 }}>{t('bridge.needSigner')}</div>}
        <Err msg={err} />
      </form>
    </div>
  );
}
