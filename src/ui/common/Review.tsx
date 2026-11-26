import { OriginPlate, SignedPlates } from './OriginPlate';
import { CloudBadge, CloudPlate } from './Cloud';
// Sign window body (with the «signing by habit» protection): the agent's own words on top, large, next to the amount;
// a plate when the same agent asked the same recipient + asset within 30 min; then the decoded built transaction,
// recipient checks, resources and their purchase. «Sign» wakes up 1.5 s after the view opens
// and only after the end of a long window has been seen. One click approves the transfer AND the purchase.
import { Fragment, useEffect, useRef, useState } from 'react';
import type { PreparedView } from '../../shared/api';
import { repeatText, signGate } from '../../lib/guard';
import { shortAddr } from '../../lib/similar';
import { fmtExact as fmtAmount } from '../../lib/portfolio';
import { Addr, Countdown, n } from './ui';
import { ProxyParts, SwapReview } from './SwapReview';
import { EvmReview } from './EvmReview';
import { CoinLogo, NetLabel } from './Logo';
import { fmtClock, t, tk } from '../../i18n';
import { NextSteps } from './NextSteps';

/** Type of a request in words (sign window). */
const typeWord = (x: string) => tk(`review.type.${x}`, x);
const NET: Record<string, string> = { tron: 'TRON', 'evm:8453': 'Base', 'evm:1': 'Ethereum', 'evm:42161': 'Arbitrum', 'evm:10': 'Optimism', 'evm:137': 'Polygon' };

/** Gate state for the sign button: opened-at timer + "the end was seen" by an IntersectionObserver on a sentinel. */
export function useSignGate(key: string) {
  const [openedAt, setOpenedAt] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  const [reachedEnd, setReachedEnd] = useState(false);
  const end = useRef<HTMLDivElement>(null);
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
  return { ...g, end };
}

type Props = { v: PreparedView; onSign: (addressChecked: boolean) => void; onReject?: () => void; busy: boolean };

/** A swap has its own window (SwapReview: same words-on-top, repeat plate and delayed button). */
export function Review(p: Props) {
  if (p.v.type === 'swap' || p.v.swap) return <SwapReview v={p.v} busy={p.busy} onReject={p.onReject} onSign={() => p.onSign(false)} />;
  if (p.v.evm || p.v.bridge || p.v.type === 'bridge' || p.v.type === 'refuel' || p.v.network.startsWith('evm:')) return <EvmReview {...p} />;
  return <TransferReview {...p} />;
}

function TransferReview({ v, onSign, onReject, busy }: Props) {
  const [checked, setChecked] = useState(false);
  useEffect(() => { setChecked(false); }, [v.key, v.built_at]);
  const gate = useSignGate(`${v.key}:${v.built_at}`);
  const r = v.resources;
  const tc = v.to_check;
  const needTick = !!tc && !tc.in_book && tc.first_time;
  const canSign = !v.blocked && !!v.tx && gate.armed && (!needTick || checked) && !busy;
  const amount = v.tx ? fmtAmount(v.tx.amount) : null;
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
          : <div className="words none">{t('review.noReason')}</div>)}
        <div className="amount">
          {amount !== null ? <><CoinLogo symbol={v.tx!.asset} network={v.network} size={30} /><span className="big">{amount}</span><b>{v.tx!.asset}</b><span className="grow" /><span className="to">→ {tc?.own ? <b>{t('review.toOwn', { name: tc.own.name })}</b> : tc?.in_book ? <b>{t('review.quoted', { label: tc.in_book.label })}</b> : shortAddr(v.tx!.to)}</span></>
            : <b>{typeWord(v.type)} · {NET[v.network] ?? v.network}</b>}
        </div>
      </div>

      <SignedPlates v={v} />
      {v.repeat && <div className="plate repeat">{repeatText(v.repeat)}{t('review.repeatCheck')}</div>}

      <div className="card flat">
        <div className="kv">
          <span className="k">{t('review.account')}</span><span><b>{v.account.name}</b></span>
          <span className="k">{t('review.network')}</span><span><NetLabel network={v.network} name={NET[v.network] ?? v.network} /></span>
          <span className="k">{t('review.type')}</span><span>{typeWord(v.type)}</span>
        </div>
      </div>

      {v.tx && (
        <div className="card">
          <h2>{t('review.tx')} <span className="small muted" style={{ fontWeight: 600 }}>{t('review.txDecoded')}</span></h2>
          <div className="kv">
            <span className="k">{t('review.amount')}</span><span className="num" style={{ fontSize: 16, fontWeight: 700 }}>{v.tx.amount} {v.tx.asset}</span>
            {v.tx.asset_contract && <><span className="k">{t('review.contract')}</span><span><Addr a={v.tx.asset_contract} /> <span className="badge ok">{t('review.fromList', { asset: 'USDT' })}</span></span></>}
            <span className="k">{t('review.from')}</span><span><Addr a={v.tx.from} copy /><div className="small muted">{v.account.name}</div></span>
            <span className="k">{t('review.to')}</span><span><Addr a={v.tx.to} copy /></span>
          </div>
          {tc?.own && <div className="plate ok">{t('review.ownAccount', { name: tc.own.name, group: tc.own.group })}</div>}
          {tc?.in_book && <div className="plate ok">{t('review.inBook', { label: tc.in_book.label })}</div>}
          {tc && !tc.in_book && !tc.own && <div className="plate warn">{t('review.notInBook')}{tc.first_time ? t('review.firstTime') : ''}</div>}
          {tc?.similar.map((s, i) => (
            <div key={i} className="plate bad">
              {t('review.similar', { what: s.source === 'own' ? t('review.similarOwn', { label: s.label }) : s.source === 'book' ? t('review.quoted', { label: s.label }) : t('review.similarHistory') })}
              <div className="small" style={{ marginTop: 4 }}>{t('review.recipient')}: <Addr a={v.tx!.to} compare={s.address} /></div>
              <div className="small">{s.source === 'own' ? t('review.srcOwn') : s.source === 'book' ? t('review.srcBook') : t('review.srcHistory')}: <Addr a={s.address} compare={v.tx!.to} /></div>
            </div>
          ))}
          <div className="kv" style={{ marginTop: 8 }}>
            {/* «0» holds only when the resources arrive; the signed transaction itself allows burning up to fee_limit */}
            <span className="k">{t('review.burn')}</span><span><b className="num">0 TRX</b> <span className="small muted">{v.tx.asset === 'USDT' ? t('review.burnHonest', { max: v.tx.fee_limit_trx }) : t('review.burnHonestTrx')}</span></span>
            {v.tx.asset === 'USDT' && <><span className="k">fee_limit</span><span className="num">{v.tx.fee_limit_trx} TRX <span className="small muted">{t('review.feeLimitHint')}</span></span></>}
            <span className="k">{t('review.txExpiry')}</span><span className="small">{fmtClock(v.tx.expiration)}</span>
            <span className="k">txID</span><span className="mono small" style={{ wordBreak: 'break-all' }}>{v.tx.txID}</span>
          </div>
        </div>
      )}

      {r && (
        <div className="card">
          <h2>{t('review.resources')}</h2>
          <div className="kv">
            <span className="k energy">{t('review.energy')}</span><span className="num">{t('review.needHave', { need: n(r.need.energy), have: n(r.have.energy) })} <b>{t('review.buying', { n: n(r.buy.energy) })}</b></span>
            <span className="k bandwidth">{t('review.bandwidth')}</span><span className="num">{t('review.needHave', { need: n(r.need.bandwidth), have: n(r.have.bandwidth) })} <b>{t('review.buying', { n: n(r.buy.bandwidth) })}</b></span>
            {(r.activate.sender || r.activate.recipient) && <><span className="k">{t('review.activation')}</span><span>{r.activate.sender && <div>{t('review.senderNotActive')}{r.route === 'proxy' ? t('review.senderBySend') : ''}</div>}{r.activate.recipient && <div>{t('review.recipientNotActive')}{r.quotes.proxy?.code === 'RESOURCE_ROUTE_NOT_ALLOWED' ? <div className="small" style={{ fontWeight: 700 }}>{t('review.recipientDirect')}</div>
              : (r.route === 'proxy' || r.fallback_route === 'proxy') ? <div className="small muted">{t('review.recipientProxy')}</div> : null}</div>}</span></>}
          </div>
          {r.route === 'none' ? <div className="plate ok">{t('review.enough')}</div> : (
            <>
              <div className="kv" style={{ marginTop: 8 }}>
                {(['direct', 'proxy'] as const).map((k) => {
                  const q = r.quotes[k];
                  return <Fragment key={k}><span className="k">{k === 'direct' ? 'Direct' : 'Proxy'}</span>
                    <span>{q?.ok ? <><span className="num">≈{'\u00a0'}{q.cost_usdc} USDC</span> <span className="small muted">{t('review.cap', { v: q.approved_max_usdc })}</span>{r.route === k && <span className="badge accent" style={{ marginLeft: 6 }}>{t('review.chosen')}</span>}{r.fallback_route === k && <span className="badge" style={{ marginLeft: 6 }}>{t('review.fallback')}</span>}<ProxyParts parts={q.parts} /></>
                      : <span className="subtle">{t('review.unavailable')}{q?.code ? ` (${q.code})` : ''}{q?.note ? ` — ${q.note}` : ''}</span>}</span></Fragment>;
                })}
                <span className="k">{t('review.payment')}</span><span>{t('review.payFrom')} <Addr a={r.payer ?? ''} network="evm:8453" /><div className="small muted">{t('review.usdcBalance', { v: r.usdc_balance ?? t('review.unknown') })}</div></span>
              </div>
              {!v.blocked && <div className="plate info">{t('review.oneButton', { max: r.approved_max_usdc, fb: r.fallback_route ? t('review.oneButtonFallback', { max: r.fallback_approved_max_usdc }) : '' })}</div>}
            </>
          )}
          {r.energy_source === 'fallback' && <div className="small muted">{t('review.energyFallback')}</div>}
        </div>
      )}

      {v.agent?.cloud ? <CloudPlate /> : v.e2e && <OriginPlate e={v.e2e} />}
      {v.warnings.map((w, i) => <div key={i} className="plate warn">{w}</div>)}
      {v.blocked && <div className="plate bad">{t('review.blocked')} {v.blocked.text ?? v.blocked.message} <span className="small">({v.blocked.code})</span></div>}
      <NextSteps v={v} />
      <div ref={gate.end} className="end-sentinel" />

      <div className="sticky-actions">
        {needTick && !v.blocked && (
          <label className="check" style={{ marginBottom: 8 }}><input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /><span>{t('review.addrTick')}</span></label>
        )}
        {!v.blocked && v.tx && !gate.armed && <div className="gatehint">{gate.needScroll ? t('review.gateScroll') : t('review.gateWait')}</div>}
        <div className="row">
          {onReject && <button className="btn grow ghost-danger" disabled={busy} onClick={onReject}>{t('review.reject')}</button>}
          {!v.blocked && v.tx && <button className="btn primary grow" disabled={!canSign} onClick={() => onSign(checked)}>{t('review.sign')}</button>}
        </div>
      </div>
    </div>
  );
}
