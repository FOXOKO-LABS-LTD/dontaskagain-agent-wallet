// Agents tab : pause of all agents, the queue of waiting requests (with the time left), history of
// decisions (who: human / pause), agent cards — bound accounts, allowed types, revoke — and «Connect agent».
// 0.3.5: no auto-sign — every signature is the human's, so no limits or spend bars.
import { useEffect, useState } from 'react';
import type { AgentView, HistoryRow, RequestRow, StatusView } from '../../shared/api';
import { requestAmount, requestTarget } from '../../lib/requestLabel';
import { I } from '../common/icons';
import { Countdown, Err, api, fmtTime, useAsync } from '../common/ui';
import { TYPE_INFO, type RequestType } from '../../lib/wallet/model';
import { HistoryList } from './Home';
import { t } from '../../i18n';
import { Mascot } from '../common/Mascot';
import type { ScreenProps } from './screen';

export function AgentsTab({ st, nav }: ScreenProps) {
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [hist, setHist] = useState<HistoryRow[]>([]);
  const [server, setServer] = useState<Record<string, any>>({});
  const { busy, err, run } = useAsync();
  useEffect(() => {
    api<RequestRow[]>({ cmd: 'requests' }).then(setRows).catch(() => {});
    api<HistoryRow[]>({ cmd: 'history' }).then((h) => setHist(h.filter((x) => !x.own).slice(0, 20))).catch(() => {});
  }, [st]);
  useEffect(() => { if (st.signer.connected) api<any[]>({ cmd: 'agentsRefresh' }).then((l) => setServer(Object.fromEntries(l.map((a) => [a.id, a])))).catch(() => {}); }, [st.signer.connected]);
  const live = st.agents.filter((a) => !a.revoked_at);
  const paused = st.settings.agents_paused;
  return (
    <div>
      <div className={`pausebar ${paused ? 'on' : ''}`}>
        {paused ? <I.pause /> : <I.play />}
        <div className="grow"><b>{paused ? t('agents.paused') : t('agents.working')}</b>
          <div className="small">{paused ? t('agents.pausedHint') : t('agents.workingHint')}</div></div>
        <button className={`btn sm ${paused ? '' : 'danger'}`} disabled={busy} onClick={() => {
          if (!paused && !confirm(t('agents.pauseConfirm'))) return;
          void run(() => api({ cmd: 'pauseAgents', paused: !paused }));
        }}>{paused ? t('agents.unpause') : t('agents.pauseAll')}</button>
      </div>
      <Err msg={err} />

      {live.filter((a) => a.new_types.length).map((a) => <NewTypesPrompt key={a.id} a={a} st={st} />)}

      <h3 className="with-mascot">{rows.length > 0 && <Mascot state="waiting" size={24} />}{t('agents.waiting')} · {rows.length}</h3>
      <div className="list">
        {!rows.length && <div className="empty">{t('agents.noRequests')}</div>}
        {rows.map((r) => (
          <div key={r.request_id} className="list-item click" onClick={() => nav(`/sign/${r.request_id}`)}>
            <div className="req"><span className="what">{requestAmount(r)}</span><Countdown until={r.expires_at} />
              <span className="small muted">{r.agent?.name ?? t('agents.agent')} · {r.account?.name}{r.type === 'swap' ? ` · ${requestTarget(r)}` : ''}</span><span className="link small">{t('agents.openReq')}</span></div>
          </div>
        ))}
      </div>

      <div className="row between"><h3>{t('agents.agents')} · {live.length}</h3><button className="btn sm primary" onClick={() => nav('/agents/new')}><I.plus size={13} /> {t('title.agentNew')}</button></div>
      {!live.length && <div className="list"><div className="empty"><Mascot state="empty" size={64} />{t('agents.none')}</div></div>}
      {live.map((a) => <AgentCard key={a.id} a={a} st={st} srv={server[a.id]} nav={nav} />)}

      <h3>{t('agents.decisions')}</h3>
      <HistoryList rows={hist} showAccount />
    </div>
  );
}

const typeName = (t: string) => TYPE_INFO[t as RequestType]?.label ?? t;

/**
 * Migration (0.2.1): this version knows types the agent was never asked about. Shown once per agent; nothing is ticked
 * by default and nothing is allowed silently — «Save» with no ticks means «do not allow».
 */
export function NewTypesPrompt({ a, st }: { a: AgentView; st: StatusView }) {
  const [pick, setPick] = useState<string[]>([]);
  const { busy, err, run } = useAsync();
  return (
    <div className="card pop">
      <span className="eyebrow">{t('agents.newTypes')}</span>
      <h2 style={{ marginTop: 8 }}>{t('agents.newTypesAsk', { types: a.new_types.map(typeName).join(', '), name: a.name })}</h2>
      <p className="small">{t('agents.newTypesHint')}</p>
      <div className="col">{a.new_types.map((ty) => <label key={ty} className="check"><input type="checkbox" checked={pick.includes(ty)} onChange={(e) => setPick(e.target.checked ? [...pick, ty] : pick.filter((x) => x !== ty))} />
        <span><b>{typeName(ty)}</b><br /><span className="small muted">{TYPE_INFO[ty as RequestType]?.hint}</span></span></label>)}</div>
      <div className="row" style={{ marginTop: 10 }}><span className="grow" />
        <button className="btn sm" disabled={busy} onClick={() => void run(() => api({ cmd: 'agentNewTypes', id: a.id, allow: [] }))}>{t('agents.dontAllow')}</button>
        <button className="btn sm primary" disabled={busy || !pick.length || !st.signer.connected} onClick={() => void run(() => api({ cmd: 'agentNewTypes', id: a.id, allow: pick }))}>{t('agents.allowTicked')}</button></div>
      {!st.signer.connected && pick.length > 0 && <div className="small subtle">{t('agents.needSigner')}</div>}
      <Err msg={err} />
    </div>
  );
}

function AgentCard({ a, st, srv, nav }: { a: AgentView; st: StatusView; srv?: any; nav: (p: string) => void }) {
  const { busy, err, run } = useAsync();
  const accName = (id: string) => st.accounts.find((x) => x.id === id)?.name ?? id;
  return (
    <div className="card">
      <div className="row between"><h2 style={{ margin: 0 }}>{a.name}</h2><span className="small mono subtle">{a.token_prefix ?? srv?.token_prefix ?? ''}…</span></div>
      <div className="small muted" style={{ marginTop: 2 }}>{a.created_at ? t('agents.since', { at: fmtTime(a.created_at) }) : ''}{srv?.last_used_at ? ` · ${t('agents.lastSeen', { at: fmtTime(srv.last_used_at) })}` : ` · ${t('agents.neverUsed')}`} · MCP <span className="mono">{a.mcp_name}</span></div>
      <div className="chips" style={{ marginTop: 8 }}>{a.accounts.map((id, i) => <span key={id} className={`badge ${i === 0 ? 'pop' : ''}`}>{accName(id)}{i === 0 ? ` · ${t('agents.default')}` : ''}</span>)}</div>
      <div className="small" style={{ marginTop: 6 }}><b>{t('agents.allowed')}</b> <span className="muted">{a.allowed_types.length ? a.allowed_types.map(typeName).join(', ') : t('agents.nothing')}</span></div>
      <div className="small subtle" style={{ marginTop: 6 }}>{t('agents.humanOnly')}</div>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn sm primary" onClick={() => nav(`/agent/${encodeURIComponent(a.id)}`)}>{t('title.agent')}</button>
        <span className="grow" />
        <button className="btn sm ghost-danger" disabled={busy || !st.signer.connected} onClick={() => { if (confirm(t('agents.revokeConfirm', { name: a.name }))) void run(async () => { await api({ cmd: 'agentRevoke', id: a.id }); nav(`/agent/${encodeURIComponent(a.id)}`); }); }}>{t('agents.revoke')}</button>
      </div>
      <Err msg={err} />
    </div>
  );
}
