import { OriginPlate, SignedPlates } from './OriginPlate';
// Sign window for EVM: an EVM transfer or a refuel (one transaction), a CCTP bridge (approve? + burn
// now, mint later in the destination — by the wallet without a second window, or by Circle Forwarding). The agent's
// words on top, then the decoded built bytes of every transaction, gas in the native coin, blocks with the reason
// and «Refuel gas» when the native coin of an L2 is missing.
import { useEffect, useState } from 'react';
import type { EvmTxLine, GasCheck, PreparedView } from '../../shared/api';
import { fmtExact as fmtAmount } from '../../lib/portfolio';
import { shortAddr } from '../../lib/similar';
import { repeatText } from '../../lib/guard';
import { Addr, Countdown } from './ui';
import { useSignGate } from './Review';
import { NextSteps } from './NextSteps';
import { CoinLogo, NetLogo } from './Logo';
import { t, tk } from '../../i18n';

type Props = { v: PreparedView; onSign: (addressChecked: boolean) => void; onReject?: () => void; busy: boolean };

const NET: Record<string, string> = { 'evm:1': 'Ethereum', 'evm:42161': 'Arbitrum', 'evm:10': 'Optimism', 'evm:137': 'Polygon', 'evm:8453': 'Base', tron: 'TRON' };
export const netName = (n: string) => NET[n] ?? n;
export const eta = (sec: number) => (sec < 90 ? t('evmr.etaS', { n: sec }) : sec < 3600 ? t('evmr.etaM', { n: Math.round(sec / 60) }) : t('evmr.etaH', { n: Math.round(sec / 3600) }));
const stepWord = (s: string | undefined, method: string) => tk(`evmr.step.${s ?? ''}`, method);

/** Opens the refuel screen for an L2 (in the popup / panel app; from the sign window — a new tab of the app). */
export function openRefuel(to: string) {
  const path = `/refuel/${to}`;
  if (/(popup|panel)\.html$/.test(location.pathname)) location.hash = path;
  else window.open(`popup.html#${path}`, '_blank');
}

export function TxLine({ t: tx, n }: { t: EvmTxLine; n?: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="stepline">
      <div className="row between"><span><span className="n">{n ?? ''}{n ? '.' : ''}</span><b>{stepWord(tx.step, tx.method)}</b></span><span className="badge">{netName(tx.network)} · {tx.chain_id}</span></div>
      <div className="kv small" style={{ marginTop: 6 }}>
        <span className="k">{t('evmr.contractTo')}</span><span><Addr a={tx.to} network={tx.network} />{tx.to_label && <div className="small muted">{tx.to_label}</div>}</span>
        <span className="k">{t('evmr.method')}</span><span className="mono">{tx.method}</span>
        {tx.value !== '0' && <><span className="k">{t('review.amount')}</span><span className="num"><b>{tx.value} {tx.native}</b></span></>}
        <span className="k">{t('evmr.gas')}</span><span className="num">{t('evmr.upTo', { v: `${tx.fee_max_native} ${tx.native}` })} <span className="small muted">({tx.gas} × {tx.max_fee_per_gas_gwei} gwei{tx.gas_source === 'typical' ? t('evmr.typicalLimit') : ''})</span></span>
        <span className="k">nonce</span><span className="num">{tx.nonce}</span>
      </div>
      {tx.args.length > 0 && <button className="link small" onClick={() => setOpen(!open)}>{open ? t('evmr.hideArgs') : t('evmr.args')}</button>}
      {open && <div className="args">{tx.args.map((a) => <div key={a.k}><b>{a.k}</b>: {a.v.length > 80 ? a.v.slice(0, 40) + '…' + a.v.slice(-24) : a.v}</div>)}</div>}
    </div>
  );
}

function Gas({ g, title }: { g: GasCheck; title: string }) {
  return (
    <div className="kv small">
      <span className="k">{title}</span>
      <span className="num">{t('evmr.gasNeedHave', { need: `${g.need_native} ${g.native}`, have: g.have_native })} {g.ok ? <span className="badge ok">{t('evmr.enough')}</span> : <span className="badge bad">{t('evmr.notEnough')}</span>}
        {g.above_max && <div style={{ color: 'var(--danger-ink)', fontWeight: 700 }}>{t('evmr.aboveMax', { fee: g.fee_max_native, max: `${g.max_fee_native} ${g.native}` })}</div>}</span>
    </div>
  );
}

export function EvmReview({ v, onSign, onReject, busy }: Props) {
  const [checked, setChecked] = useState(false);
  useEffect(() => { setChecked(false); }, [v.key, v.built_at]);
  const gate = useSignGate(`${v.key}:${v.built_at}`);
  const e = v.evm, b = v.bridge;
  const tc = v.to_check;
  const needTick = e?.kind === 'transfer' && !!tc && !tc.in_book && tc.first_time;
  const ready = !!(e?.txs.length || b?.steps.length);
  const canSign = !v.blocked && ready && gate.armed && (!needTick || checked) && !busy;
  return (
    <div>
      <div className="said">
        <div className="who">
          {v.kind === 'agent' ? <><span className="eyebrow">{t('review.agentEyebrow')}</span><b>{v.agent?.name}</b>{!v.agent?.known && <span className="badge warn">{t('review.notInDoc')}</span>}</>
            : <><span className="eyebrow blue">{t('review.youEyebrow')}</span><b>{t('review.noAgent')}</b></>}
          <span className="grow" />
          {v.expires_at && <Countdown until={v.expires_at} />}
        </div>
        {v.kind === 'agent' && (v.reason
          ? <div className="words"><div className="small muted" style={{ fontWeight: 700, fontSize: 10, textTransform: 'uppercase', letterSpacing: '.06em' }}>{t('review.agentWords')}</div>{t('review.reasonQuoted', { reason: v.reason })}</div>
          : <div className="words none">{t('review.noReason')}</div>)}
        <div className="amount">
          {e?.kind === 'transfer' && <><CoinLogo symbol={e.asset} network={v.network} size={30} /><span className="big">{fmtAmount(e.amount)}</span><b>{e.asset}</b><span className="grow" /><span className="to">→ {tc?.own ? <b>{t('review.toOwn', { name: tc.own.name })}</b> : tc?.in_book ? <b>{t('review.quoted', { label: tc.in_book.label })}</b> : shortAddr(e.to)} · {netName(e.network)}</span></>}
          {e?.kind === 'refuel' && <><span className="big">{fmtAmount(e.amount)}</span><b>ETH</b><span className="grow" /><span className="to">Ethereum → {e.refuel?.to_name}</span></>}
          {b && <><CoinLogo symbol="USDC" network={b.from_network} size={30} /><span className="big">{fmtAmount(b.amount)}</span><b>USDC</b><span className="grow" /><span className="to"><NetLogo network={b.from_network} size={14} /> {netName(b.from_network)} → <NetLogo network={b.to_network} size={14} /> {netName(b.to_network)}</span></>}
          {!e && !b && <b>{v.type} · {netName(v.network)}</b>}
        </div>
      </div>

      <SignedPlates v={v} />
      {v.repeat && <div className="plate repeat">{repeatText(v.repeat)}{t('review.repeatCheck')}</div>}

      <div className="card flat">
        <div className="kv">
          <span className="k">{t('review.account')}</span><span><b>{v.account.name}</b>{v.account.evm && <div className="small"><Addr a={v.account.evm} network="evm:1" /></div>}</span>
          <span className="k">{t('review.type')}</span><span>{b ? t('evmr.typeBridge') : e?.kind === 'refuel' ? t('evmr.typeRefuel') : t('evmr.typeTransfer', { net: netName(v.network) })}</span>
        </div>
      </div>

      {b && (
        <div className="card">
          <h2>{t('evmr.bridgeTitle')} <span className="small muted" style={{ fontWeight: 600 }}>CCTP v2</span></h2>
          <div className="kv">
            <span className="k">{t('evmr.receive')}</span><span className="num" style={{ fontSize: 16, fontWeight: 700 }}>{t('evmr.atLeast', { v: `${b.receive_at_least} USDC` })} <span className="small muted">{t('evmr.onNet', { net: b.to_name })}</span></span>
            <span className="k">{t('evmr.burned')}</span><span className="num">{b.burn} USDC <span className="small muted">{t('evmr.onNet', { net: b.from_name })}{b.usdc_balance ? t('evmr.have', { v: b.usdc_balance }) : ''}</span></span>
            <span className="k">{t('evmr.fee')}</span><span className="num">{t('evmr.upTo', { v: `${b.max_fee} USDC` })} <div className="small muted">{t('evmr.cctpFee', { fee: b.protocol_fee, bps: b.minimum_fee_bps })}{b.delivery === 'forwarding' ? t('evmr.forwardFee', { fee: b.forward_fee }) : ''}</div></span>
            <span className="k">{t('evmr.mode')}</span><span>{b.mode_effective === 'fast' ? t('evmr.fast') : t('evmr.standard')} · {eta(b.eta_sec)}{b.mode !== b.mode_effective && <span className="small muted">{t('evmr.noFast', { net: b.from_name })}</span>}</span>
            <span className="k">{t('swapr.recipient')}</span><span>{t('evmr.ownAddress')}<div className="small"><Addr a={b.recipient} network={b.to_network} copy /></div></span>
            <span className="k">{t('evmr.delivery')}</span><span>{b.delivery === 'self' ? t('evmr.deliverySelf', { net: b.to_name, gas: b.dst_gas?.native ?? t('evmr.gasWord') }) : t('evmr.deliveryForwarding')}
              {b.delivery_reason && b.delivery_requested === 'auto' && <div className="small muted">{t('evmr.auto', { r: b.delivery_reason })}</div>}</span>
          </div>
          <h3>{t('evmr.steps')}</h3>
          {b.steps.map((t, i) => <TxLine key={i} t={t} n={i + 1} />)}
          <div className="stepline"><div className="row between"><span><span className="n">{b.steps.length + 1}.</span><b>{t('evmr.receiveOn', { net: b.to_name })}</b></span><span className="badge">{b.delivery === 'self' ? t('evmr.wallet') : 'Circle'}</span></div>
            <div className="small muted" style={{ marginTop: 4 }}>{b.delivery === 'self'
              ? t('evmr.mintSelf', { mt: shortAddr(b.mint.message_transmitter), gas: `${b.dst_gas?.need_native ?? '?'} ${b.dst_gas?.native ?? ''}`.trim() })
              : t('evmr.mintCircle')}</div></div>
          {!b.approve.needed && <div className="small muted">{t('evmr.approveNotNeeded', { v: b.approve.amount })}</div>}
          <Gas g={b.gas} title={t('evmr.gasOn', { net: b.from_name })} />
          {b.dst_gas && b.delivery === 'self' && <Gas g={b.dst_gas} title={t('evmr.gasOn', { net: b.to_name })} />}
        </div>
      )}

      {e && (
        <div className="card">
          <h2>{t('review.tx')} <span className="small muted" style={{ fontWeight: 600 }}>{t('review.txDecoded')}</span></h2>
          {e.kind === 'transfer' && (
            <div className="kv">
              <span className="k">{t('review.amount')}</span><span className="num" style={{ fontSize: 16, fontWeight: 700 }}>{e.amount} {e.asset}</span>
              {e.token && <><span className="k">{t('evmr.token')}</span><span><Addr a={e.token} network={e.network} /> <span className="badge ok">{t('review.fromList', { asset: e.asset })}</span></span></>}
              <span className="k">{t('review.to')}</span><span><Addr a={e.to} network={e.network} copy /></span>
            </div>
          )}
          {e.refuel && (
            <div className="kv">
              <span className="k">{t('evmr.youSend')}</span><span className="num" style={{ fontSize: 16, fontWeight: 700 }}>{t('evmr.fromEthereum', { v: e.amount })}</span>
              <span className="k">{t('evmr.arrives')}</span><span>{t('evmr.arrivesText', { v: e.amount, net: e.refuel.to_name })}{e.refuel.l2_balance !== null && <div className="small muted">{t('evmr.nowThere', { v: e.refuel.l2_balance })}</div>}</span>
              <span className="k">{t('evmr.bridge')}</span><span>{e.refuel.kind === 'op_stack' ? 'L1StandardBridge.depositETH' : 'Arbitrum Inbox.depositEth'}<div className="small"><Addr a={e.refuel.l1_contract} network="evm:1" /></div></span>
              <span className="k">{t('evmr.time')}</span><span>{t('evmr.refuelTime', { eta: eta(e.refuel.eta_sec) })}</span>
            </div>
          )}
          {tc?.own && <div className="plate ok">{t('review.ownAccount', { name: tc.own.name, group: tc.own.group })}</div>}
          {tc?.in_book && <div className="plate ok">{t('review.inBook', { label: tc.in_book.label })}</div>}
          {tc && !tc.in_book && !tc.own && e.kind === 'transfer' && <div className="plate warn">{t('review.notInBook')}{tc.first_time ? t('review.firstTime') : ''}</div>}
          {tc?.similar.map((s, i) => (
            <div key={i} className="plate bad">{t('review.similar', { what: s.source === 'own' ? t('review.similarOwn', { label: s.label }) : s.source === 'book' ? t('review.quoted', { label: s.label }) : t('review.similarHistory') })}
              <div className="small">{t('review.recipient')}: <Addr a={e.to} compare={s.address} network={e.network} /></div>
              <div className="small">{s.source === 'own' ? t('review.srcOwn') : s.source === 'book' ? t('review.srcBook') : t('review.srcHistory')}: <Addr a={s.address} compare={e.to} network={e.network} /></div></div>
          ))}
          {e.txs.map((t, i) => <TxLine key={i} t={t} />)}
          <Gas g={e.gas} title={t('evmr.gasOn', { net: e.network_name })} />
        </div>
      )}

      {v.e2e && <OriginPlate e={v.e2e} />}
      {v.warnings.map((w, i) => <div key={i} className="plate warn">{w}</div>)}
      {v.blocked && <div className="plate bad">{t('review.blocked')} {v.blocked.text ?? v.blocked.message} <span className="small">({v.blocked.code})</span>
        {v.refuel_hint && <div style={{ marginTop: 8 }}><button className="btn sm primary" onClick={() => openRefuel(v.refuel_hint!.to_network)}>{t('evmr.refuelOn', { net: netName(v.refuel_hint.to_network) })}</button></div>}
        {v.blocked.code === 'INSUFFICIENT_GAS' && !v.refuel_hint && <div className="small" style={{ marginTop: 6 }}>{t('evmr.topUp', { native: String(v.blocked.detail?.native ?? t('evmr.nativeCoin')), net: netName(String(v.blocked.detail?.network ?? '')) })}</div>}
      </div>}
      <NextSteps v={v} />
      <div ref={gate.end} className="end-sentinel" />

      <div className="sticky-actions">
        {needTick && !v.blocked && <label className="check" style={{ marginBottom: 8 }}><input type="checkbox" checked={checked} onChange={(x) => setChecked(x.target.checked)} /><span>{t('review.addrTick')}</span></label>}
        {!v.blocked && ready && !gate.armed && <div className="gatehint">{gate.needScroll ? t('review.gateScroll') : t('review.gateWait')}</div>}
        <div className="row">
          {onReject && <button className="btn grow ghost-danger" disabled={busy} onClick={onReject}>{t('review.reject')}</button>}
          {!v.blocked && ready && <button className="btn primary grow" disabled={!canSign} onClick={() => onSign(checked)}>{b ? (b.steps.length === 2 ? t('evmr.signApproveBurn') : t('evmr.signBurn')) : t('review.sign')}</button>}
        </div>
      </div>
    </div>
  );
}
