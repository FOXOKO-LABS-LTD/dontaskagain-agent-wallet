// 0.3.13: «Connect a chat app» — #/oauth (type the code) and #/oauth/<code> (opened by the Signer's authorize page
// through externally_connectable). Everything shown comes from the Signer over the WebSocket, read by the code: the
// client's name and link (marked «not verified»), the exact host the sign-in returns to (big; a loopback warning),
// the scope; the human picks the accounts and types and names the agent. «Allow» / «Deny» are signed by the root
// account; the cloud agent is then in the wallet document like any other agent.
import { useEffect, useState } from 'react';
import type { ConsentView } from '../../lib/oauth';
import { normalizeUserCode } from '../../lib/oauth';
import { ALL_TYPES } from '../../lib/wallet/model';
import { Err, api, accountTag, fmtTime, useAsync } from '../common/ui';
import { CloudPlate } from '../common/Cloud';
import { TypeLabel } from './AgentSettings';
import { t } from '../../i18n';
import type { ScreenProps } from './screen';

type Extra = { path: string };

/** The window opened for the consent closes itself when done; inside the popup / panel it goes back to Agents. */
const isOwnWindow = () => new URLSearchParams(location.search).get('w') === 'oauth';

export function OAuthConsent({ st, nav, path }: ScreenProps & Extra) {
  const fromPath = decodeURIComponent(path.split('/')[2] ?? '');
  const [code, setCode] = useState(fromPath);
  const [c, setC] = useState<ConsentView | null>(null);
  const [done, setDone] = useState<null | { decision: 'approve' | 'deny'; name?: string }>(null);
  const { busy, err, run } = useAsync();
  const ready = st.signer.connected && !!st.e2e?.active;
  const load = (raw: string) => void run(async () => {
    const n = normalizeUserCode(raw);
    if (!n) throw new Error(t('oauth.badCode'));
    setC(await api<ConsentView>({ cmd: 'oauthConsentGet', user_code: n }));
  });
  useEffect(() => { if (fromPath && ready && !c && !done) load(fromPath); }, [fromPath, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => { if (isOwnWindow()) window.close(); else nav('/agents'); };
  if (done) return (
    <div className="screen">
      <div className={`plate ${done.decision === 'approve' ? 'ok' : 'info'}`}>{done.decision === 'approve' ? t('oauth.approved', { name: done.name ?? '' }) : t('oauth.denied')}</div>
      <button className="btn primary block" onClick={close}>{t('oauth.close')}</button>
    </div>
  );
  if (!c) return (
    <div className="screen">
      {!ready && <div className="plate warn small">{t('oauth.needSigner')}</div>}
      <form className="card" onSubmit={(e) => { e.preventDefault(); load(code); }}>
        <h2>{t('oauth.codeTitle')}</h2>
        <p className="small muted">{t('oauth.codeHint')}</p>
        <label className="field"><span>{t('oauth.codeField')}</span>
          <input className="mono oauth-code" value={code} maxLength={20} autoFocus placeholder="XXXX-XXXX" autoComplete="off" spellCheck={false}
            onChange={(e) => setCode(e.target.value.toUpperCase())} /></label>
        <div className="row"><button type="button" className="btn" onClick={close}>{t('wiz.cancel')}</button><span className="grow" />
          <button className="btn primary" disabled={busy || !ready || !normalizeUserCode(code)}>{t('oauth.next')}</button></div>
        <Err msg={err} />
      </form>
    </div>
  );
  return <ConsentCard c={c} st={st} onDone={setDone} onCancel={close} />;
}

export function ConsentCard({ c, st, onDone, onCancel, preview }: { c: ConsentView; st: ScreenProps['st']; onDone: (d: { decision: 'approve' | 'deny'; name?: string }) => void; onCancel?: () => void; preview?: boolean }) {
  const [name, setName] = useState(c.client.name.slice(0, 48));
  const [accs, setAccs] = useState<string[]>(st.accounts[0] ? [st.accounts[0].id] : []);
  const [types, setTypes] = useState<string[]>([...ALL_TYPES]);
  const { busy, err, run } = useAsync();
  const decide = (decision: 'approve' | 'deny') => void run(async () => {
    if (preview) return;
    const r = await api<{ decision: 'approve' | 'deny'; name?: string }>({ cmd: 'oauthConsentDecide', consent_id: c.id, decision, accounts: accs, allowed_types: types, ...(decision === 'approve' ? { name: name.trim() } : {}) });
    onDone(r ?? { decision });
  });
  return (
    <div className="screen oauth">
      <div className="card">
        <span className="eyebrow">{t('title.oauth')}</span>
        <h2 style={{ marginTop: 8 }}>{c.client.name} <span className="badge warn">{t('oauth.unverified')}</span></h2>
        <div className="small">{t('oauth.asks')}</div>
        {c.client.uri && <div className="small muted mono">{c.client.uri}</div>}
        <p className="small muted">{t('oauth.unverifiedHint')}</p>
        <div className="field"><span>{t('oauth.redirect')}</span>
          <div className="oauth-host mono" style={{ fontSize: 20, fontWeight: 800, wordBreak: 'break-all' }}>{c.redirect_host}</div>
          <div className="small muted mono" style={{ wordBreak: 'break-all' }}>{c.redirect_uri}</div></div>
        {c.redirect_loopback && <div className="plate bad small">{t('oauth.loopback')}</div>}
        <div className="small muted">{t('oauth.redirectHint')}</div>
        <div className="small" style={{ marginTop: 6 }}>{t('oauth.scope', { scope: c.scope })}</div>
        {c.expires_at && <div className="small subtle">{t('oauth.expires', { t: fmtTime(c.expires_at) })}</div>}
      </div>
      <CloudPlate />
      <div className="card">
        <label className="field"><span>{t('oauth.name')}</span><input value={name} maxLength={48} onChange={(e) => setName(e.target.value)} /></label>
        <h2>{t('oauth.accounts')}</h2>
        <div className="col">{st.accounts.map((a) => <label key={a.id} className="check"><input type="checkbox" checked={accs.includes(a.id)} onChange={(e) => setAccs(e.target.checked ? [...accs, a.id] : accs.filter((x) => x !== a.id))} />
          <span><b>{a.name}</b> <span className="small muted">· {accountTag(st, a)}</span>{accs[0] === a.id && <span className="badge pop" style={{ marginLeft: 6 }}>{t('agents.default')}</span>}</span></label>)}</div>
        <h2 style={{ marginTop: 10 }}>{t('oauth.types')}</h2>
        <div className="col">{ALL_TYPES.map((ty) => <label key={ty} className="check"><input type="checkbox" checked={types.includes(ty)} onChange={(e) => setTypes(e.target.checked ? [...types, ty] : types.filter((x) => x !== ty))} /><TypeLabel t={ty} /></label>)}</div>
        <div className="plate info small" style={{ marginTop: 8 }}>{t('agents.humanOnly')}</div>
      </div>
      <div className="row">
        <button className="btn ghost-danger" disabled={busy} onClick={() => decide('deny')}>{t('oauth.deny')}</button>
        <span className="grow" />
        <button className="btn primary" disabled={busy || !accs.length || !name.trim()} onClick={() => decide('approve')}>{t('oauth.allow')}</button>
      </div>
      <Err msg={err} />
    </div>
  );
}
