// 0.3.0: where the request came from — signed by the agent's own key, by the server's key of a remote-MCP
// agent (the operator sees it; manual signature only), or the old way without an agent signature.
import type { PreparedView } from '../../shared/api';
import { t } from '../../i18n';

export function OriginPlate({ e }: { e: NonNullable<PreparedView['e2e']> }) {
  const cls = e.mode === 'agent' ? 'ok' : e.mode === 'server' ? 'warn' : 'info';
  return <div className={`plate ${cls} small`}>
    {e.mode === 'agent' ? <>{t('origin.agentKey')} <span className="mono">{e.fp}</span>{e.confirmed ? ` ${t('origin.confirmed')}` : ''}</> : e.note}
  </div>;
}

/** 0.3.3: this request is signed already (delivery not confirmed) / another live signature to the same place. */
export function SignedPlates({ v }: { v: PreparedView }) {
  const until = (s?: string) => (s ? new Date(s).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
  return <>
    {v.signed_once && <div className="plate bad">{v.signed_once.until ? t('review.signedOnceUntil', { until: until(v.signed_once.until) }) : t('review.signedOnce')}</div>}
    {v.live_signature && <div className="plate bad">{v.live_signature.until ? t('review.liveSignatureUntil', { until: until(v.live_signature.until) }) : t('review.liveSignature')}</div>}
  </>;
}
