// «Connect agent» (0.2.1): name → accounts → connection → the token once + what to run on the agent's
// side (its own MCP name, the launch command of the agent's machine — AgentConnect).
// 0.3.5: no auto-sign limits — every signature is the human's.
import { useState } from 'react';
import type { AgentConnectView } from '../../shared/api';
import { Copy, Err, api, useAsync, accountTag } from '../common/ui';
import { AgentConnect } from './AgentConnect';
import { t } from '../../i18n';
import type { ScreenProps } from './screen';

export function AgentWizard({ st, nav }: ScreenProps) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [accs, setAccs] = useState<string[]>(st.accounts[0] ? [st.accounts[0].id] : []);
  const [made, setMade] = useState<AgentConnectView | null>(null);
  // 0.3.0: with E2E the way is chosen before the agent is created (it decides who holds the agent's key)
  const e2e = !!st.e2e?.active;
  const [way, setWay] = useState<'npx' | 'remote'>('npx');
  const needE2e = !e2e; // an agent connects only with its own key (npx or remote MCP), which needs end-to-end encryption
  const { busy, err, run } = useAsync();

  const create = () => void run(async () => {
    const r = await api<AgentConnectView>({ cmd: 'agentCreate', name: name.trim(), accounts: accs, ...(e2e ? { launch: way } : {}) });
    setMade(r); setStep(3);
  });

  const STEPS = [t('agset.name'), t('title.accounts'), t('wiz.stepConnect'), t('agset.token')];
  return (
    <div className="screen">
      <div className="steps">{STEPS.map((s, i) => <div key={s} className={i === step ? 'on' : i < step ? 'done' : ''}>{i + 1}. {s}</div>)}</div>

      {step === 0 && (
        <form className="card" onSubmit={(e) => { e.preventDefault(); if (name.trim()) setStep(1); }}>
          <h2>{t('wiz.nameTitle')}</h2>
          <label className="field"><span>{t('wiz.nameField')}</span><input value={name} maxLength={48} autoFocus placeholder="claude-bot" onChange={(e) => setName(e.target.value)} /></label>
          <p className="small muted">{t('wiz.nameHint')}</p>
          <div className="row"><button type="button" className="btn" onClick={() => nav('/agents')}>{t('wiz.cancel')}</button><span className="grow" /><button className="btn primary" disabled={!name.trim()}>{t('common.next')}</button></div>
        </form>
      )}

      {step === 1 && (
        <div className="card">
          <h2>{t('wiz.accountsTitle')}</h2>
          <div className="col">{st.accounts.map((a) => <label key={a.id} className="check"><input type="checkbox" checked={accs.includes(a.id)} onChange={(e) => setAccs(e.target.checked ? [...accs, a.id] : accs.filter((x) => x !== a.id))} />
            <span><b>{a.name}</b> <span className="small muted">· {accountTag(st, a)}</span>{accs[0] === a.id && <span className="badge pop" style={{ marginLeft: 6 }}>{t('agents.default')}</span>}</span></label>)}</div>
          <p className="small muted">{t('wiz.accountsHint')}</p>
          <div className="row"><button className="btn" onClick={() => setStep(0)}>{t('common.back')}</button><span className="grow" /><button className="btn primary" disabled={!accs.length} onClick={() => setStep(2)}>{t('common.next')}</button></div>
        </div>
      )}

      {step === 2 && (
        <div className="card">
          <h2>{t('wiz.stepConnect')}</h2>
          <div className="plate info small">{t('agents.humanOnly')}</div>
          {e2e && <div className="field" style={{ marginTop: 12 }}><span>{t('wiz.way')}</span>
            <div className="col" style={{ gap: 4 }}>
              <label className="check"><input type="radio" name="way" checked={way === 'npx'} onChange={() => setWay('npx')} /><span><b>{t('wiz.wayNpx')}</b><br /><span className="small muted">{t('wiz.wayNpxNote')}</span></span></label>
              <label className="check"><input type="radio" name="way" checked={way === 'remote'} onChange={() => setWay('remote')} /><span><b>{t('wiz.wayRemote')}</b><br /><span className="small muted">{t('wiz.wayRemoteNote')}</span></span></label>
            </div></div>}
          {needE2e && <div className="plate warn small" style={{ marginTop: 12 }}>{t('wiz.needE2e')}</div>}
          <div className="row" style={{ marginTop: 12 }}><button className="btn" onClick={() => setStep(1)}>{t('common.back')}</button><span className="grow" />
            <button className="btn primary" disabled={busy || !st.signer.connected || needE2e} onClick={create}>{busy ? t('wiz.creating') : t('wiz.create')}</button></div>
          {!st.signer.connected && <div className="small subtle" style={{ marginTop: 6 }}>{t('agents.needSigner')}</div>}
          <Err msg={err} />
        </div>
      )}

      {step === 3 && made && (
        <div className="card danger">
          <span className="eyebrow red">{t('agset.shownOnce')}</span>
          <h2 style={{ marginTop: 8 }}>{t('wiz.tokenOf', { name: made.name })}</h2>
          <div className="token">{made.token}</div>
          <div className="row" style={{ marginTop: 8 }}><Copy text={made.token} label={t('agset.copyToken')} small /></div>
          <p className="small muted">{t('wiz.tokenOnce')}</p>
        </div>
      )}
      {step === 3 && made && <AgentConnect st={st} mode="new" mcpName={made.mcp_name} token={made.token} made={made} agentId={made.id} />}
      {step === 3 && made && (
        <div>
          <button className="btn primary block" onClick={() => { setMade(null); nav('/agents'); }}>{t('wiz.saved')}</button>
        </div>
      )}
    </div>
  );
}
