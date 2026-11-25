// «Operation page» #/op/<request_id> (0.2.1): what is going on and where the transactions are —
// a title in words, who started it, the status in big letters, a timeline of steps (waiting / running / done /
// error) with the short tx hash + explorer link, fee, amount, expected time and «N min ago». Live: the page
// re-reads on every worker change (request.update / request.bridge) and refreshes from the Signer while not final.
import { useEffect, useState } from 'react';
import { elapsed, netLabel, type OpStep, type OpView } from '../../lib/op';
import { CoinLogo, NetLogo } from '../common/Logo';
import { I } from '../common/icons';
import { Copy, Err, api, fmtTime } from '../common/ui';
import type { ScreenProps } from './screen';
import { t } from '../../i18n';
import { Mascot, type MascotState } from '../common/Mascot';

const stateWord = (s: OpStep['state']) => t(`opPage.state.${s}`);
/** The mascot of the page (shell only, the status itself is said in words in the plate under it). */
const opMascot = (v: OpView): MascotState => v.status === 'confirmed' ? 'done' : v.status === 'failed' ? 'network-error'
  : v.status === 'rejected' || v.status === 'cancelled' || v.status === 'expired' ? 'canceled' : 'waiting';

export function Operation({ st, nav, path }: ScreenProps & { path: string }) {
  const id = decodeURIComponent(path.split('/')[2] ?? '');
  const [v, setV] = useState<OpView | null>(null);
  const [err, setErr] = useState('');
  const [now, setNow] = useState(Date.now());
  const load = () => api<OpView>({ cmd: 'op', request_id: id }).then((x) => { setV(x); setErr(''); }).catch((e) => setErr((e as Error).message));
  useEffect(() => { void load(); }, [id, st]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    const r = setInterval(() => { if (v && !v.final) void load(); }, 15_000);
    return () => { clearInterval(t); clearInterval(r); };
  }, [v?.final, id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!v) return <div className="screen">{err ? <div className="empty">{err !== 'NOT_FOUND' && <Mascot state="network-error" size={96} />}<Err msg={err === 'NOT_FOUND' ? t('opPage.notFound') : err} /></div> : <div className="muted small">{t('opPage.loading')}</div>}</div>;
  const toneCls = v.tone === 'ok' ? 'ok' : v.tone === 'bad' ? 'bad' : v.tone === 'warn' ? 'warn' : 'info';
  return (
    <div className="screen op">
      <div className="card op-head">
        <Mascot state={opMascot(v)} size={64} className="op-mascot" />
        <span className="eyebrow">{v.own ? t('opPage.yours') : v.initiator}{v.account ? ` · ${v.account}` : ''}</span>
        <div className="row" style={{ gap: 10, marginTop: 8, alignItems: 'center' }}>
          {v.asset ? <CoinLogo symbol={v.asset} network={v.network} size={30} /> : v.network ? <NetLogo network={v.network} size={24} /> : null}
          <h2 style={{ margin: 0 }}>{v.title}</h2></div>
        {v.subtitle && <div className="small muted">{v.subtitle}</div>}
        {v.reason && <div className="small" style={{ marginTop: 4 }}>{t('opPage.agentWords', { reason: v.reason })}</div>}
        <div className={`plate ${toneCls}`} style={{ fontSize: 16, fontWeight: 800, marginTop: 10 }}>{v.status_label}</div>
        <div className="small muted">
          {v.created_at ? t('opPage.started', { t: fmtTime(v.created_at) }) : ''}
          {v.created_at && !v.final ? t('opPage.elapsed', { e: elapsed(v.created_at, now) }) : ''}
          {v.final && v.finished_at ? t('opPage.finished', { t: fmtTime(v.finished_at) }) : ''}
        </div>
      </div>

      <div className="card">
        <h2>{t('evmr.steps')}</h2>
        <ol className="timeline">
          {v.steps.map((s, i) => (
            <li key={s.key + i} className={`tl ${s.state}`}>
              <span className="dot">{s.state === 'done' ? <I.check size={14} /> : s.state === 'error' ? '!' : i + 1}</span>
              <div className="grow">
                <div className="row between"><b>{s.title}</b><span className={`badge ${s.state === 'done' ? 'ok' : s.state === 'error' ? 'bad' : s.state === 'active' ? 'accent' : ''}`}>{stateWord(s.state)}</span></div>
                {s.note && <div className="small" style={{ fontWeight: 600 }}>{s.note}</div>}
                {s.eta && s.state !== 'done' && <div className="small muted">{s.eta}{s.state === 'active' && v.created_at ? t('opPage.elapsed', { e: elapsed(v.created_at, now) }) : ''}</div>}
                {s.amount && <div className="small num">{s.amount}</div>}
                {s.tx && <div className="small row tx-row" style={{ gap: 6, alignItems: 'center' }}>
                  <span className="mono">{s.tx.short}</span>
                  {s.tx.url && <a className="link" href={s.tx.url} target="_blank" rel="noreferrer"><I.externalLink size={12} /> {t('opPage.explorer')}{s.network ? <> (<NetLogo network={s.network} size={12} /> {netLabel(s.network)})</> : ''}</a>}
                  <Copy text={s.tx.hash} label={t('opPage.hash')} small />
                </div>}
                {s.fee && <div className="small muted">{t('opPage.networkFee', { fee: s.fee })}</div>}
                {s.error && <div className="error small">{s.error}</div>}
              </div>
            </li>
          ))}
        </ol>
      </div>

      {v.facts.length > 0 && <div className="card">
        {v.facts.map((f) => <div key={f.k} className="row between small" style={{ marginBottom: 4, gap: 8 }}><span className="muted">{f.k}</span><span className="num" style={{ fontWeight: 700, textAlign: 'right', wordBreak: 'break-all' }}>{f.v}</span></div>)}
      </div>}
      <div className="small subtle">{t('opPage.id')} <span className="mono">{v.request_id}</span></div>
      <button className="btn block" style={{ marginTop: 10 }} onClick={() => nav('/history')}>{t('opPage.toHistory')}</button>
    </div>
  );
}
