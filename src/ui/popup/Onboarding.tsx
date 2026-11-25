// First run: create (24 words, option 12, write-down check by 3 words) or import — a phrase + its name, or a
// private key + the account's name — then a password. 0.1.7: every step has the same footer — «Back» on the left,
// the main button on the right, inside the card (the «Back» of the password step used to drift below the card).
import { useState } from 'react';
import { ImportFields, NewPhrase, importReady, type ImportValue } from '../common/Phrase';
import { Err, PRODUCT, api, useAsync } from '../common/ui';
import { t } from '../../i18n';
import { Mascot } from '../common/Mascot';
import { I } from '../common/icons';
import { pwProblemText } from '../common/pw';

function Password({ onSubmit, onBack, busy, err }: { onSubmit: (pw: string) => void; onBack: () => void; busy: boolean; err: string }) {
  const [a, setA] = useState(''), [b, setB] = useState('');
  const weak = a ? pwProblemText(a) : null; // the worker checks it too
  const ok = !weak && a === b;
  return (
    <form className="card pw-step" onSubmit={(e) => { e.preventDefault(); if (ok) onSubmit(a); }}>
      <h2>{t('onb.password')}</h2>
      <label className="field"><span>{t('onb.pwLabel')}</span><input type="password" autoComplete="new-password" value={a} onChange={(e) => setA(e.target.value)} autoFocus /></label>
      <label className="field"><span>{t('onb.pwRepeat')}</span><input type="password" autoComplete="new-password" value={b} onChange={(e) => setB(e.target.value)} /></label>
      {a && weak && <div className="error">{weak}</div>}
      {a && b && a !== b && <div className="error">{t('onb.pwMismatch')}</div>}
      <p className="small muted">{t('onb.pwHint')}</p>
      <Err msg={err} />
      <div className="actions">
        <button type="button" className="btn" disabled={busy} onClick={onBack}>{t('common.back')}</button>
        <span className="grow" />
        <button className="btn primary" disabled={!ok || busy}>{busy ? t('onb.encrypting') : t('onb.done')}</button>
      </div>
    </form>
  );
}

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<'start' | 'create' | 'createPw' | 'import' | 'importPw'>('start');
  const [phrase, setPhrase] = useState('');
  const [imp, setImp] = useState<ImportValue>(() => ({ kind: 'seed', secret: '', name: t('onb.mainSeed') }));
  const { busy, err, setErr, run } = useAsync();

  if (mode === 'start') return (
    <div className="screen">
      <div className="card onb-start">
        <Mascot state="neutral" size={96} />
        <h2>{PRODUCT}</h2>
        <p className="muted">{t('onb.intro')}</p>
        <div className="actions"><button className="btn primary grow" onClick={() => setMode('create')}>{t('onb.create')}</button><button className="btn grow" onClick={() => setMode('import')}>{t('onb.import')}</button></div>
      </div>
    </div>
  );

  if (mode === 'create') return <div className="screen"><NewPhrase onBack={() => setMode('start')} onReady={(p) => { setPhrase(p); setMode('createPw'); }} /></div>;

  if (mode === 'createPw') return (
    <div className="screen">
      <Password busy={busy} err={err} onBack={() => { setErr(''); setPhrase(''); setMode('create'); }}
        onSubmit={(pw) => void run(async () => { await api({ cmd: 'createWallet', mnemonic: phrase, password: pw, seed_name: t('onb.mainSeed'), account_name: 'main' }); setPhrase(''); onDone(); })} />
    </div>
  );

  if (mode === 'import') return (
    <div className="screen">
      <div className="card">
        <h2>{t('onb.importTitle')}</h2>
        <ImportFields v={imp} set={(v) => { setImp(v); setErr(''); }} seedDefault={t('onb.mainSeed')} keyDefault="main" />
        <div className="actions"><button className="btn" onClick={() => setMode('start')}>{t('common.back')}</button><span className="grow" /><button className="btn primary" disabled={!importReady(imp)} onClick={() => setMode('importPw')}>{t('common.next')}</button></div>
      </div>
    </div>
  );

  return (
    <div className="screen">
      <Password busy={busy} err={err} onBack={() => { setErr(''); setMode('import'); }} onSubmit={(pw) => void run(async () => {
        const sec = imp.secret.trim();
        await api(imp.kind === 'key'
          ? { cmd: 'importWallet', privateKey: sec, password: pw, account_name: imp.name.trim() }
          : { cmd: 'importWallet', mnemonic: sec, password: pw, seed_name: imp.name.trim(), account_name: 'main' });
        setImp({ kind: 'seed', secret: '', name: t('onb.mainSeed') }); onDone();
      })} />
    </div>
  );
}

export function Unlock({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState('');
  const [reset, setReset] = useState('');
  const { busy, err, run } = useAsync();
  return (
    <div className="screen">
      <div className="card unlock-card">
        <Mascot state="locked" size={96} />
        <h2>{t('onb.unlock')}</h2>
        <form onSubmit={(e) => { e.preventDefault(); void run(async () => { await api({ cmd: 'unlock', password: pw }); setPw(''); onDone(); }); }}>
          <label className="field"><span>{t('onb.password')}</span><input type="password" autoComplete="current-password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} /></label>
          <button className="btn primary block" disabled={busy || !pw}>{busy ? t('onb.checking') : <><I.unlock size={16} />{t('onb.unlock')}</>}</button>
        </form>
        <Err msg={err} />
      </div>
      <details className="small muted"><summary>{t('onb.forgot')}</summary>
        <p>{t('onb.resetHint')}</p>
        <div className="row"><input value={reset} onChange={(e) => setReset(e.target.value)} /><button className="btn danger" disabled={reset !== 'DELETE'} onClick={() => void run(async () => { await api({ cmd: 'resetWallet', confirm: 'DELETE' }); onDone(); })}>{t('onb.delete')}</button></div>
      </details>
    </div>
  );
}
