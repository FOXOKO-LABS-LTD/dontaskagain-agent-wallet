// «Agent settings» (0.2.1): everything about an agent and its access is done by the human here —
// name, accounts (default first), allowed request types (0.3.5: no auto-sign limits), re-issue of the token, revoke, and what to run on
// the agent's side. Every change goes into the signed wallet document (wallet.sync), which the Signer applies at once.
import { useState } from 'react';
import type { AgentConnectView, AgentView } from '../../shared/api';
import { ALL_TYPES, TYPE_INFO, type RequestType } from '../../lib/wallet/model';
import { Copy, Err, api, accountTag, fmtTime, useAsync } from '../common/ui';
import { AgentConnect, PairState } from './AgentConnect';
import { t } from '../../i18n';
import { npxDefaultCommand } from '../../lib/agentConnect';
import type { ScreenProps } from './screen';
import { CloudBadge, CloudPlate } from '../common/Cloud';

type Extra = { path: string };

export function AgentSettings({ st, nav, path }: ScreenProps & Extra) {
  const id = decodeURIComponent(path.split('/')[2] ?? '');
  const a = st.agents.find((x) => x.id === id);
  const [revoked, setRevoked] = useState<string | null>(null);
  if (!a) return <div className="screen"><div className="empty">{t('agset.notFound')}</div><button className="btn" onClick={() => nav('/agents')}>{t('agset.toAgents')}</button></div>;
  if (a.revoked_at || revoked) return (
    <div className="screen">
      <div className="card"><h2 style={{ margin: 0 }}>{a.name}</h2><div className="small muted">{t('agset.revokedAt', { at: fmtTime(a.revoked_at) })}</div></div>
      {!a.cloud && <AgentConnect st={st} mode="revoked" mcpName={revoked ?? a.mcp_name} />}
      <button className="btn block" onClick={() => nav('/agents')}>{t('agset.toAgents')}</button>
    </div>
  );
  return (
    <div className="screen">
      {!st.signer.connected && <div className="plate warn small">{t('agset.noSigner')}</div>}
      {a.cloud && <CloudSection a={a} />}
      <NameSection a={a} st={st} />
      <AccountsSection a={a} st={st} />
      <TypesSection a={a} st={st} />
      {/* a cloud agent has no token and nothing to run: it reconnects from the chat app */}
      {!a.cloud && <TokenSection a={a} st={st} />}
      {!a.cloud && <AgentConnect st={st} mode="current" mcpName={a.mcp_name} />}
      <RevokeSection a={a} st={st} onDone={setRevoked} />
    </div>
  );
}

type P = { a: AgentView; st: ScreenProps['st'] };

/** 0.3.13: a cloud agent — which chat app, where its sign-in returned, the plate. */
function CloudSection({ a }: { a: AgentView }) {
  if (!a.cloud) return null;
  return (
    <div className="card">
      <h2>{t('oauth.cloudInfo')} <CloudBadge /></h2>
      <CloudPlate />
      <div className="small" style={{ marginTop: 6 }}><b>{a.cloud.client_name}</b> <span className="badge">{t('oauth.unverified')}</span></div>
      <div className="small">{t('oauth.redirect')}: <b className="mono">{a.cloud.redirect_host}</b></div>
      <div className="small muted">{t('oauth.connectedAt', { at: fmtTime(a.cloud.connected_at) })}</div>
      <p className="small muted" style={{ marginTop: 6 }}>{t('oauth.cloudInfoHint')}</p>
    </div>
  );
}

function NameSection({ a, st }: P) {
  const [name, setName] = useState(a.name);
  const { busy, err, run } = useAsync();
  const dirty = name.trim() !== a.name;
  return (
    <div className="card">
      <h2>{t('agset.name')}</h2>
      <label className="field"><span>{t('agset.nameHint')}</span><input value={name} maxLength={48} onChange={(e) => setName(e.target.value)} /></label>
      <div className="row"><span className="small muted grow">{a.cloud ? t('oauth.connectedAt', { at: fmtTime(a.cloud.connected_at) }) : t('agset.sinceToken', { at: fmtTime(a.created_at), prefix: a.token_prefix ?? '' })}</span>
        <button className="btn sm primary" disabled={busy || !dirty || !name.trim() || !st.signer.connected} onClick={() => void run(() => api({ cmd: 'agentUpdate', id: a.id, patch: { name: name.trim() } }))}>{t('common.save')}</button></div>
      <Err msg={err} />
    </div>
  );
}

function AccountsSection({ a, st }: P) {
  const [accs, setAccs] = useState<string[]>(a.accounts);
  const [def, setDef] = useState<string>(a.accounts[0] ?? '');
  const { busy, err, run } = useAsync();
  const ordered = def && accs.includes(def) ? [def, ...accs.filter((x) => x !== def)] : accs;
  const dirty = JSON.stringify(ordered) !== JSON.stringify(a.accounts);
  return (
    <div className="card">
      <h2>{t('title.accounts')}</h2>
      <p className="small muted">{t('agset.accountsHint')}</p>
      <div className="col">{st.accounts.map((x) => {
        const on = accs.includes(x.id);
        return <div key={x.id} className="row between">
          <label className="check"><input type="checkbox" checked={on} onChange={(e) => {
            const next = e.target.checked ? [...accs, x.id] : accs.filter((y) => y !== x.id);
            setAccs(next); if (!next.includes(def)) setDef(next[0] ?? '');
          }} /><span><b>{x.name}</b> <span className="small muted">· {accountTag(st, x)}</span></span></label>
          {on && <label className="check small"><input type="radio" name={`def-${a.id}`} checked={def === x.id} onChange={() => setDef(x.id)} /><span>{t('agents.default')}</span></label>}
        </div>;
      })}</div>
      <div className="row" style={{ marginTop: 8 }}><span className="grow" />
        <button className="btn sm primary" disabled={busy || !dirty || !accs.length || !st.signer.connected} onClick={() => void run(() => api({ cmd: 'agentUpdate', id: a.id, patch: { accounts: ordered } }))}>{t('common.save')}</button></div>
      <Err msg={err} />
    </div>
  );
}

export function TypeLabel({ t: ty }: { t: string }) {
  const i = TYPE_INFO[ty as RequestType];
  if (!i) return <span className="mono">{ty}</span>;
  return <span><b>{i.label}</b>
    {!i.available && <span className="badge warn" style={{ marginLeft: 6 }}>{t('agset.notYet')}</span>}<br /><span className="small muted">{i.hint}</span></span>;
}

function TypesSection({ a, st }: P) {
  const [types, setTypes] = useState<string[]>(a.allowed_types);
  const { busy, err, run } = useAsync();
  const norm = (l: string[]) => ALL_TYPES.filter((t) => l.includes(t)).join(',');
  const dirty = norm(types) !== norm(a.allowed_types);
  return (
    <div className="card">
      <h2>{t('agset.allowedOps')}</h2>
      <p className="small muted">{t('agset.allowedOpsHint')}</p>
      <div className="col">{ALL_TYPES.map((ty) => <label key={ty} className="check"><input type="checkbox" checked={types.includes(ty)} onChange={(e) => setTypes(e.target.checked ? [...types, ty] : types.filter((x) => x !== ty))} /><TypeLabel t={ty} /></label>)}</div>
      <div className="row" style={{ marginTop: 8 }}><span className="grow" />
        <button className="btn sm primary" disabled={busy || !dirty || !st.signer.connected} onClick={() => void run(() => api({ cmd: 'agentUpdate', id: a.id, patch: { allowed_types: types } }))}>{t('common.save')}</button></div>
      <Err msg={err} />
    </div>
  );
}


function TokenSection({ a, st }: P) {
  const [made, setMade] = useState<AgentConnectView | null>(null);
  const { busy, err, run } = useAsync();
  if (made) return <>
    <div className="card danger">
      <span className="eyebrow red">{t('agset.shownOnce')}</span>
      <h2 style={{ marginTop: 8 }}>{t('agset.newToken', { name: made.name })}</h2>
      <div className="token">{made.token}</div>
      <div className="row" style={{ marginTop: 8 }}><Copy text={made.token} label={t('agset.copyToken')} small /></div>
      <p className="small muted">{t('agset.oldTokenDead')}</p>
    </div>
    <AgentConnect st={st} mode="rotate" mcpName={made.mcp_name} oldMcpName={made.old_mcp_name} token={made.token} made={made} agentId={made.id} />
    <button className="btn primary block" onClick={() => setMade(null)}>{t('agset.replaced')}</button>
  </>;
  const e2e = !!st.e2e?.active;
  return (<>
    {e2e && <KeySection a={a} st={st} onMade={setMade} />}
    <div className="card">
      <h2>{t('agset.token')}</h2>
      <p className="small muted">{t('agset.rotateHint')}</p>
      <div className="row"><span className="grow" />
        <button className="btn sm" disabled={busy || !st.signer.connected} onClick={() => {
          if (!confirm(t('agset.rotateConfirm', { name: a.name }))) return;
          void run(async () => { const r = await api<AgentConnectView>({ cmd: 'agentRotate', id: a.id }); if (r) setMade(r); });
        }}>{t('agset.rotate')}</button></div>
      <Err msg={err} />
    </div>
  </>);
}

/** 0.3.0: the agent's E2E key — state, «Connect key (npx)», remote MCP, manual fingerprint. */
function KeySection({ a, st, onMade }: P & { onMade: (v: AgentConnectView) => void }) {
  const [fp, setFp] = useState('');
  const { busy, err, run } = useAsync();
  const connect = (launch: 'npx' | 'remote', q: string) => { if (!confirm(q)) return; void run(async () => { const r = await api<AgentConnectView>({ cmd: 'agentConnectE2E', id: a.id, launch }); if (r) onMade(r); }); };
  return (
    <div className="card">
      <h2>{t('agkey.title')}</h2>
      {a.e2e?.mode === 'server' && <div className="plate warn small">{t('agkey.remote')}</div>}
      {a.e2e?.mode === 'agent' && <PairState a={a} />}
      {!a.e2e && (a.pairing ? <PairState a={a} /> : <div className="plate warn small">{st.e2e?.server_mode === 'required' ? t('agkey.noneRequired') : t('agkey.none')}</div>)}
      <div className="row wrap" style={{ marginTop: 8 }}>
        <button className="btn sm" disabled={busy || !st.signer.connected} onClick={() => connect('npx', t('agkey.npxConfirm', { name: a.name }))}>{a.e2e?.mode === 'agent' ? t('agkey.changeNpx') : t('agkey.connectNpx')}</button>
        <button className="btn sm" disabled={busy || !st.signer.connected} onClick={() => connect('remote', t('agkey.remoteConfirm', { name: a.name }))}>{t('agkey.remoteBtn')}</button>
      </div>
      <details className="small" style={{ marginTop: 8 }}><summary>{t('agkey.manual')}</summary>
        <p className="muted">{t('agkey.manual1')} <span className="mono">{npxDefaultCommand()} whoami</span>{t('agkey.manual2')}</p>
        <input className="mono" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" value={fp} onChange={(e) => setFp(e.target.value)} />
        <div className="row" style={{ marginTop: 6 }}><button className="btn sm" disabled={busy || fp.replace(/[^A-Za-z2-7]/g, '').length !== 24} onClick={() => void run(() => api({ cmd: 'agentManualFp', id: a.id, fp }))}>{t('agkey.waitFp')}</button></div>
      </details>
      <Err msg={err} />
    </div>
  );
}

function RevokeSection({ a, st, onDone }: P & { onDone: (mcpName: string) => void }) {
  const { busy, err, run } = useAsync();
  return (
    <div className="card">
      <h2>{t('agset.revokeTitle')}</h2>
      <p className="small muted">{t('agset.revokeHint')}</p>
      <div className="row"><span className="grow" />
        <button className="btn sm ghost-danger" disabled={busy || !st.signer.connected} onClick={() => {
          if (!confirm(t('agents.revokeConfirm', { name: a.name }))) return;
          void run(async () => { const r = await api<{ mcp_name: string }>({ cmd: 'agentRevoke', id: a.id }); onDone(r?.mcp_name ?? a.mcp_name); });
        }}>{t('agents.revoke')}</button></div>
      <Err msg={err} />
    </div>
  );
}
