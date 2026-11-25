// Swap panel: you give / you get TRX ↔ USDT, amount, slippage (0.1 / 0.5 / 1 % or custom ≤ 3 %),
// live sun.io quote through the Signer (rate, route, fees, minimum received), «Swap» → sign window
// SwapReview → own.swap. Route `/swap` renders it (src/ui/popup/Swap.tsx keeps the stub's `SwapPair`).
import { useEffect, useState } from 'react';
import type { PreparedView, SwapQuoteView } from '../../shared/api';
import { assetRows, fmtAmount } from '../../lib/portfolio';
import { SwapReview } from '../common/SwapReview';
import { I } from '../common/icons';
import { Err, api, useAsync, useBalances, usePrices } from '../common/ui';
import { CoinLogo } from '../common/Logo';
import type { ScreenProps } from './screen';
import { t } from '../../i18n';

type A = 'TRX' | 'USDT';
const PRESETS = [10, 50, 100];

export function SwapPanel({ st, account, nav }: ScreenProps) {
  const bal = useBalances([account.id], [st.signer.signed_in])[account.id];
  const prices = usePrices(st.signer.signed_in);
  const rows = assetRows(bal, prices ?? {});
  const [give, setGive] = useState<A>('USDT');
  const get: A = give === 'USDT' ? 'TRX' : 'USDT';
  const [amount, setAmount] = useState('');
  const [bps, setBps] = useState(50);
  const [custom, setCustom] = useState('');
  const [q, setQ] = useState<SwapQuoteView | null>(null);
  const [qErr, setQErr] = useState('');
  const [view, setView] = useState<PreparedView | null>(null);
  const [done, setDone] = useState('');
  const { busy, err, setErr, run } = useAsync();
  const slip = custom ? Math.round(Number(custom.replace(',', '.')) * 100) : bps;
  const slipOk = Number.isInteger(slip) && slip >= 1 && slip <= 300;
  const amt = amount.trim().replace(',', '.');
  const amtOk = /^\d+(\.\d{1,6})?$/.test(amt) && Number(amt) > 0;
  const have = rows.find((r) => r.key === `tron/${give}`);

  // live quote, debounced; again every 15 s while the form is open
  useEffect(() => {
    setQ(null); setQErr('');
    if (!amtOk || !slipOk || !st.signer.signed_in) return;
    let stop = false;
    const load = () => api<SwapQuoteView>({ cmd: 'swapQuote', asset_in: give, asset_out: get, amount_in: amt, slippage_bps: slip })
      .then((x) => { if (!stop) setQ(x); }).catch((e) => { if (!stop) setQErr((e as Error).message); });
    const t = setTimeout(load, 400);
    const iv = setInterval(load, 15_000);
    return () => { stop = true; clearTimeout(t); clearInterval(iv); };
  }, [give, amt, slip, st.signer.signed_in]);

  if (view) return (
    <div className="screen">
      <SwapReview v={view} busy={busy} onReject={() => setView(null)} onSign={() => void run(async () => {
        const r = await api<{ status: string; view?: PreparedView; request_id?: string }>({ cmd: 'swapSign', swap_id: view.key, build_id: view.build_id });
        if (r.status === 'changed' && r.view) { setView(r.view); setErr(t('swap.changed')); return; }
        // 0.2.1+: always the operation page (no «Sent to the Signer: awr_…» line); without an id — the history
        nav(r.request_id ? `/op/${encodeURIComponent(r.request_id)}` : '/history'); return;
      })} />
      <Err msg={err} />
    </div>
  );

  return (
    <div className="screen">
      <span className="eyebrow">{account.name} · TRON · sun.io</span>
      <div style={{ height: 10 }} />
      {done && <div className="plate ok">{done}</div>}
      <form className="card" onSubmit={(e) => { e.preventDefault(); setDone(''); void run(async () => setView(await api<PreparedView>({ cmd: 'swapPrepare', account_id: account.id, asset_in: give, asset_out: get, amount_in: amt, slippage_bps: slip }))); }}>
        <div style={{ boxShadow: 'var(--shadow-sm)', marginBottom: 12 }}>
          <div className="pair">
            <div className="row between"><div className="lbl netlabel"><CoinLogo symbol={give} size={18} />{t('swap.give')}</div>
              <div className="small muted">{t('send.available')} <span className="num">{have ? fmtAmount(have.amount) : '…'}</span>{have && give === 'USDT' && <> · <button type="button" className="link" onClick={() => setAmount(have.amount)}>{t('send.all')}</button></>}</div></div>
            <div className="in">
              <input value={amount} inputMode="decimal" placeholder="0" autoFocus onChange={(e) => setAmount(e.target.value)} />
              <select value={give} onChange={(e) => { setGive(e.target.value as A); setAmount(''); }}><option value="USDT">USDT</option><option value="TRX">TRX</option></select>
            </div>
          </div>
          <div className="flip"><button type="button" className="iconbtn" title={t('swap.flip')} onClick={() => { setGive(get); setAmount(''); }}><I.swap size={14} /></button></div>
          <div className="pair">
            <div className="lbl">{t('swap.get')}</div>
            <div className="in"><input readOnly value={q && q.ok ? q.amount_out : ''} placeholder="—" /><div className="tok-sel"><CoinLogo symbol={get} size={22} /> <b>{get}</b> · TRON</div></div>
          </div>
        </div>
        <div className="field"><span>{t('swap.slippage')}</span>
          <div className="row slip-row">
            {PRESETS.map((p) => <button type="button" key={p} className={`btn sm ${!custom && bps === p ? 'primary' : ''}`} onClick={() => { setBps(p); setCustom(''); }}>{(p / 100).toFixed(1)} %</button>)}
            <input className="mono" placeholder={t('swap.customPh')} value={custom} inputMode="decimal" onChange={(e) => setCustom(e.target.value)} />
          </div>
          {!slipOk && <div className="error">{t('swap.slipErr')}</div>}
        </div>
        {q && q.ok && (
          <div className="kv small">
            <span className="k">{t('swap.rate')}</span><span className="num">{q.rate}</span>
            <span className="k">{t('swap.minOut')}</span><span className="num"><b>{q.amount_out_min} {get}</b></span>
            <span className="k">{t('swap.route')}</span><span>{q.route.map((x, i) => <div key={i}>{x.from} → {x.to} · {x.version} · {x.fee_pct} %</div>)}</span>
            {q.reference && <><span className="k">{t('swap.ref')}</span><span>{t('swapr.refRate', { p: q.reference.price_usd, src: q.reference.source ?? t('swapr.exchanges') })}{q.reference.deviation_bps !== null ? t('swap.dev', { dir: q.reference.deviation_bps <= 0 ? t('swap.better') : t('swap.worse'), pct: (Math.abs(q.reference.deviation_bps) / 100).toFixed(2) }) : ''}</span></>}
          </div>
        )}
        {q && !q.ok && <div className="plate warn">{q.message} ({q.code})</div>}
        {qErr && <Err msg={qErr} />}
        <p className="small muted">{t('swap.hint')}</p>
        <div className="row"><button type="button" className="btn" onClick={() => nav('/')}>{t('acc.cancel')}</button><span className="grow" />
          <button className="btn primary" disabled={busy || !amtOk || !slipOk || !st.signer.connected || (!!q && !q.ok)}>{busy ? t('send.building') : t('swap.do')}</button></div>
        {!st.signer.connected && <div className="small subtle" style={{ marginTop: 6 }}>{t('swap.needSigner')}</div>}
        <Err msg={err} />
      </form>
    </div>
  );
}
