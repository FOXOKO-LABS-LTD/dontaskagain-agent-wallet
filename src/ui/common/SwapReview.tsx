import { OriginPlate, SignedPlates } from './OriginPlate';
import { CloudBadge, CloudPlate } from './Cloud';
// Sign window of a swap: you give / you get at least / rate and deviation from the market / pool route with
// fees / slippage / recipient (own address) / approve of exactly the amount / resources of both transactions and price.
// One «Sign» signs the Permit2 permit and both transactions. Used by the swap panel and by the sign window
// (Review renders <SwapReview> for v.type === 'swap'; <SwapBlock> and <ProxyParts> are reusable parts).
import { Fragment, useEffect, useRef, useState } from 'react';
import type { PreparedView, SwapView } from '../../shared/api';
import { repeatText, signGate } from '../../lib/guard';
import { Addr, Countdown, n } from './ui';
import { CoinLogo } from './Logo';
import { fmtClock, t } from '../../i18n';
import { NextSteps } from './NextSteps';

type Res = NonNullable<PreparedView['resources']>;
type Parts = { energy?: string; bandwidth?: string; activate?: string } | undefined;

/** «recipient activation ≈ X USDC», «bandwidth ≈ Y USDC», «energy ≈ Z USDC» — parts of a route price (gateway cover). */
export function ProxyParts({ parts }: { parts: Parts }) {
  if (!parts || (!parts.activate && !parts.bandwidth && !parts.energy)) return null;
  return (
    <div className="small muted">
      {parts.energy && <div>{t('swapr.partEnergy', { v: parts.energy })}</div>}
      {parts.bandwidth && <div>{t('swapr.partBandwidth', { v: parts.bandwidth })}</div>}
      {parts.activate && <div>{t('swapr.partActivate', { v: parts.activate })}</div>}
    </div>
  );
}

function StepResources({ r }: { r: Res }) {
  if (r.route === 'none') return <div className="small"><span className="badge ok">{t('swapr.enough')}</span></div>;
  return (
    <div className="kv">
      <span className="k energy">{t('review.energy')}</span><span className="num">{t('review.needHave', { need: n(r.need.energy), have: n(r.have.energy) })} <b>{t('review.buying', { n: n(r.buy.energy) })}</b></span>
      <span className="k bandwidth">{t('review.bandwidth')}</span><span className="num">{t('review.needHave', { need: n(r.need.bandwidth), have: n(r.have.bandwidth) })} <b>{t('review.buying', { n: n(r.buy.bandwidth) })}</b></span>
      {(['direct', 'proxy'] as const).map((k) => {
        const q = r.quotes[k];
        if (!q) return null;
        return <Fragment key={k}><span className="k">{k === 'direct' ? 'Direct' : 'Proxy'}</span>
          <span>{q.ok ? <><span className="num">≈{'\u00a0'}{q.cost_usdc} USDC</span> <span className="small muted">{t('review.cap', { v: q.approved_max_usdc })}</span>{r.route === k && <span className="badge accent" style={{ marginLeft: 6 }}>{t('review.chosen')}</span>}{r.fallback_route === k && <span className="badge" style={{ marginLeft: 6 }}>{t('review.fallback')}</span>}<ProxyParts parts={q.parts} /></>
            : <span className="subtle">{t('review.unavailable')}{q.code ? ` (${q.code})` : ''}{q.note ? ` — ${q.note}` : ''}</span>}
            {q.energy?.energy_user != null && <div className="small muted">{t('swapr.gwShare', { n: n(q.energy.energy_user) })}{q.energy.energy_origin != null ? t('swapr.gwOrigin', { n: n(q.energy.energy_origin) }) : ''}{q.energy.energy_total != null ? t('swapr.gwTotal', { n: n(q.energy.energy_total) }) : ''}{q.energy.energy_split ? ` (${q.energy.energy_split})` : ''}</div>}</span></Fragment>;
      })}
    </div>
  );
}

/** The exchange itself + both steps; no buttons. */
export function SwapBlock({ s, accountName }: { s: SwapView; accountName?: string }) {
  const dev = s.reference?.deviation_bps;
  return (
    <>
      <div className="card">
        <h2>{t('swapr.title')} <span className="small muted" style={{ fontWeight: 600 }}>sun.io · {t('review.txDecoded')}</span></h2>
        <div className="kv">
          <span className="k">{t('swapr.give')}</span><span className="num" style={{ fontSize: 16, fontWeight: 700 }}>{s.amount_in} {s.asset_in}</span>
          <span className="k">{t('swapr.getAtLeast')}</span><span><span className="num" style={{ fontSize: 16, fontWeight: 700 }}>{s.amount_out_min} {s.asset_out}</span><div className="small muted">{t('swapr.expected', { v: `${s.amount_out} ${s.asset_out}` })}</div></span>
          <span className="k">{t('swapr.rate')}</span><span><span className="num">{s.rate}</span>
            {s.reference && !s.reference.stale && dev !== null && dev !== undefined
              ? <div className={`small ${dev > 200 ? '' : 'muted'}`}>{dev <= 0 ? t('swapr.better', { p: (-dev / 100).toFixed(2) }) : t('swapr.worse', { p: (dev / 100).toFixed(2) })} · {t('swapr.refRate', { p: s.reference.price_usd, src: s.reference.source ?? t('swapr.exchanges') })}</div>
              : <div className="small subtle">{t('swapr.noReference')}</div>}</span>
          <span className="k">{t('swapr.route')}</span><span>{s.route.map((x, i) => <div key={i} className="small"><b>{x.from} → {x.to}</b>{t('swapr.pool', { v: x.version })}{x.version !== 'v2' || x.fee_pct !== '0' ? t('swapr.poolFee', { p: x.fee_pct }) : ''}</div>)}
            {(s.fee || s.impact) && <div className="small muted">{t('swapr.sunFees', { fee: s.fee ?? '—', asset: s.asset_in, impact: s.impact ?? '—' })}</div>}</span>
          <span className="k">{t('swapr.slippage')}</span><span className="num">{(s.slippage_bps / 100).toFixed(2)} %</span>
          <span className="k">{t('swapr.recipient')}</span><span><Addr a={s.recipient} copy /><div className="small muted">{t('swapr.recipientOwn', { acc: accountName ? ` · ${accountName}` : '' })}</div></span>
          <span className="k">{t('swapr.router')}</span><span><Addr a={s.router} /> <span className="badge ok">{t('swapr.builtIn')}</span></span>
          <span className="k">Approve</span><span>{s.approve.needed
            ? <><b>{s.amount_in} {s.asset_in}</b> {t('swapr.approveExact')} <Addr a={s.approve.spender} /><div className="small muted">{t('swapr.allowanceNow', { v: s.approve.current_allowance ?? '0' })}</div></>
            : s.asset_in === 'TRX' ? <span className="muted">{t('swapr.approveNoTrx')}</span> : <span className="muted">{t('swapr.approveAlready', { v: s.approve.amount })}</span>}</span>
          <span className="k">{t('review.burn')}</span><span><b>0 TRX</b></span>
        </div>
      </div>
      {s.steps.map((st, i) => (
        <div key={st.step} className="card">
          <h2>{t('swapr.step', { i: i + 1, what: st.step === 'approve' ? `approve ${s.asset_in}` : t('swapr.stepSwap') })}</h2>
          <div className="kv">
            <span className="k">{t('review.contract')}</span><span><Addr a={st.contract} /></span>
            <span className="k">{t('review.energy')}</span><span className="num small">{t('swapr.energyTotal', { total: n(st.energy.total), user: n(st.energy.user) })}{st.energy.source === 'estimate' ? t('swapr.energyEstimate') : ''}</span>
            {st.step === 'swap' && st.energy.direct_only && <><span className="k">{t('swapr.swapEnergy')}</span>
              <span className="small">{t('swapr.shareDirect', { user: n(st.energy.user), p: st.energy.total > 0 ? Math.round((1 - st.energy.user / st.energy.total) * 100) : 99 })}</span></>}
            {st.step === 'swap' && !st.energy.direct_only && st.energy.total > st.energy.user && <><span className="k">{t('swapr.swapEnergy')}</span>
              <span className="small">{t('swapr.share', { user: n(st.energy.user), p: Math.round((1 - st.energy.user / st.energy.total) * 100) })}</span></>}
            <span className="k">fee_limit</span><span className="num small">{st.fee_limit_trx} TRX <span className="muted">{t('swapr.feeLimitHint')}</span></span>
            <span className="k">{t('review.txExpiry')}</span><span className="small">{fmtClock(st.expiration)}</span>
            {st.step === 'approve' || s.asset_in === 'TRX' ? <><span className="k">txID</span><span className="mono small" style={{ wordBreak: 'break-all' }}>{st.txID}</span></>
              : <><span className="k">txID</span><span className="small muted">{t('swapr.afterPermit')}</span></>}
          </div>
          <StepResources r={st.resources} />
        </div>
      ))}
      {Number(s.resources_cap_usdc) > 0 && (
        <div className="plate info">{t('swapr.resourcesInfo', { total: s.resources_total_usdc, cap: s.resources_cap_usdc })}</div>
      )}
    </>
  );
}

/** Whole window of a swap with «Reject» / «Sign» (one click: permit + both transactions). */
export function SwapReview({ v, onSign, onReject, busy }: { v: PreparedView; onSign: () => void; onReject?: () => void; busy: boolean }) {
  const [openedAt, setOpenedAt] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  const [reachedEnd, setReachedEnd] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const key = `${v.key}:${v.built_at}`;
  useEffect(() => { setOpenedAt(Date.now()); setNow(Date.now()); setReachedEnd(false); }, [key]);
  useEffect(() => {
    const el = end.current;
    if (!el || typeof IntersectionObserver === 'undefined') { setReachedEnd(true); return; }
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) setReachedEnd(true); });
    io.observe(el);
    return () => io.disconnect();
  }, [key]);
  const g = signGate({ openedAt, now, reachedEnd });
  useEffect(() => { if (g.waitMs > 0) { const t = setTimeout(() => setNow(Date.now()), g.waitMs + 20); return () => clearTimeout(t); } }, [g.waitMs]);
  const s = v.swap;
  const canSign = !v.blocked && !!s && g.armed && !busy;
  return (
    <div>
      <div className="said">
        <div className="who">
          {v.kind === 'agent' ? <><span className="eyebrow">{t('review.agentEyebrow')}</span><b>{v.agent?.name}</b>{v.agent?.cloud && <CloudBadge />}{!v.agent?.known && <span className="badge warn">{t('review.notInDoc')}</span>}</>
            : <><span className="eyebrow blue">{t('review.youEyebrow')}</span><b>{t('review.noAgent')}</b></>}
          <span className="grow" />
          {v.expires_at && <Countdown until={v.expires_at} />}
        </div>
        {v.kind === 'agent' && (v.reason
          ? <div className="words"><div className="small muted" style={{ fontWeight: 700, fontSize: 10, textTransform: 'uppercase', letterSpacing: '.06em' }}>{t('review.agentWords')}</div>{t('review.reasonQuoted', { reason: v.reason })}</div>
          : <div className="words none">{t('swapr.noReason')}</div>)}
        {s && <div className="amount"><CoinLogo symbol={s.asset_in} network="tron" size={30} /><span className="big">{s.amount_in}</span><b>{s.asset_in}</b><span className="grow" /><span className="to">→ ≥ {s.amount_out_min} {s.asset_out}</span></div>}
      </div>
      <SignedPlates v={v} />
      {v.repeat && <div className="plate repeat">{repeatText({ ...v.repeat, kind: 'swap' })}{t('review.repeatCheck')}</div>}
      <div className="card flat"><div className="kv"><span className="k">{t('review.account')}</span><span><b>{v.account.name}</b></span><span className="k">{t('review.network')}</span><span>TRON</span><span className="k">{t('review.type')}</span><span>{t('review.type.swap')}</span></div></div>
      {s && <SwapBlock s={s} accountName={v.account.name} />}
      {v.agent?.cloud ? <CloudPlate /> : v.e2e && <OriginPlate e={v.e2e} />}
      {v.warnings.map((w, i) => <div key={i} className="plate warn">{w}</div>)}
      {v.blocked && <div className="plate bad">{t('review.blocked')} {v.blocked.text ?? v.blocked.message} <span className="small">({v.blocked.code})</span></div>}
      <NextSteps v={v} />
      <div ref={end} className="end-sentinel" />
      <div className="sticky-actions">
        {!v.blocked && s && !g.armed && <div className="gatehint">{g.needScroll ? t('review.gateScroll') : t('review.gateWait')}</div>}
        <div className="row">
          {onReject && <button className="btn grow ghost-danger" disabled={busy} onClick={onReject}>{t('review.reject')}</button>}
          {!v.blocked && s && <button className="btn primary grow" disabled={!canSign} onClick={onSign}>{t('swapr.sign')}</button>}
        </div>
      </div>
    </div>
  );
}
