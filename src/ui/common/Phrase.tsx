// Phrase pieces shared by onboarding and «Add account» (0.1.7): a new phrase (24 words by default, option 12)
// with the write-down check by 3 words, and the import form — a phrase + its name, or a private key + account name.
import { useEffect, useMemo, useState } from 'react';
import { Err, api, useAsync } from './ui';
import { t } from '../../i18n';

function pick3(n: number): number[] {
  const s = new Set<number>();
  const r = new Uint32Array(8);
  while (s.size < 3) { crypto.getRandomValues(r); for (const x of r) { if (s.size < 3) s.add(x % n); } }
  return [...s].sort((a, b) => a - b);
}

/** Generate → show → check 3 words → onReady(phrase). The words exist only in this page's memory. */
export function NewPhrase({ onReady, onBack, backLabel }: { onReady: (phrase: string) => void; onBack: () => void; backLabel?: string }) {
  const [words, setWords] = useState<string[]>([]);
  const [len, setLen] = useState<12 | 24>(24);
  const [step, setStep] = useState<'show' | 'verify'>('show');
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const { err, run } = useAsync();
  const check = useMemo(() => (words.length ? pick3(words.length) : []), [words]);
  const generate = (l: 12 | 24) => run(async () => { setLen(l); setWords((await api<string>({ cmd: 'newMnemonic', words: l })).split(' ')); setAnswers({}); setStep('show'); });
  useEffect(() => { void generate(24); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (step === 'show') return (
    <div className="card">
      <div className="row between"><h2 style={{ margin: 0 }}>{t('phrase.title')}</h2><button className="link" onClick={() => void generate(len === 12 ? 24 : 12)}>{len === 12 ? t('phrase.words24') : t('phrase.words12')}</button></div>
      <p className="muted">{t('phrase.warn')}</p>
      <div className="words-grid">{words.map((w, i) => <div className="w" key={i}><i>{i + 1}</i>{w}</div>)}</div>
      <div className="actions"><button className="btn" onClick={onBack}>{backLabel ?? t('common.back')}</button><span className="grow" /><button className="btn primary" disabled={!words.length} onClick={() => setStep('verify')}>{t('phrase.written')}</button></div>
      <Err msg={err} />
    </div>
  );
  const ok = check.every((i) => (answers[i] ?? '').trim().toLowerCase() === words[i]);
  return (
    <div className="card">
      <h2>{t('phrase.check')}</h2>
      {check.map((i) => <label className="field" key={i}><span>{t('phrase.wordN', { n: i + 1 })}</span><input className="mono" autoComplete="off" spellCheck={false} autoCapitalize="off" autoCorrect="off" value={answers[i] ?? ''} onChange={(e) => setAnswers({ ...answers, [i]: e.target.value })} /></label>)}
      <div className="actions"><button className="btn" onClick={() => setStep('show')}>{t('common.back')}</button><span className="grow" /><button className="btn primary" disabled={!ok} onClick={() => onReady(words.join(' '))}>{t('common.next')}</button></div>
    </div>
  );
}

export type ImportKind = 'seed' | 'key';
export interface ImportValue { kind: ImportKind; secret: string; name: string }

const isKey = (t: string) => /^(0x)?[0-9a-fA-F]{64}$/.test(t.trim());
const wordCount = (t: string) => (t.trim() ? t.trim().split(/\s+/).length : 0);
export const importReady = (v: ImportValue) => !!v.name.trim() && (v.kind === 'key' ? isKey(v.secret) : [12, 15, 18, 21, 24].includes(wordCount(v.secret)));

/** Import: two variants side by side — a phrase with the phrase's name, or a private key with the account's name. */
export function ImportFields({ v, set, seedDefault, keyDefault }: { v: ImportValue; set: (v: ImportValue) => void; seedDefault: string; keyDefault: string }) {
  const kind = (k: ImportKind) => set({ kind: k, secret: '', name: k === 'seed' ? seedDefault : keyDefault });
  const wc = wordCount(v.secret);
  return (
    <div>
      <div className="tabs" role="tablist">
        <button type="button" className={`tab ${v.kind === 'seed' ? 'active' : ''}`} onClick={() => kind('seed')}>{t('phrase.seedTab')}</button>
        <button type="button" className={`tab ${v.kind === 'key' ? 'active' : ''}`} onClick={() => kind('key')}>{t('phrase.keyTab')}</button>
      </div>
      {v.kind === 'seed' ? <>
        <label className="field"><span>{t('phrase.bip39')}</span><textarea rows={3} className="mono" autoComplete="off" spellCheck={false} value={v.secret} onChange={(e) => set({ ...v, secret: e.target.value })} /></label>
        <label className="field"><span>{t('phrase.seedName')}</span><input value={v.name} maxLength={32} onChange={(e) => set({ ...v, name: e.target.value })} /></label>
        <p className="small muted">{wc ? t('phrase.wordCount', { n: wc }) : ''}{t('phrase.seedHint')}</p>
      </> : <>
        <label className="field"><span>{t('phrase.pkLabel')}</span><input type="password" className="mono" autoComplete="off" value={v.secret} onChange={(e) => set({ ...v, secret: e.target.value })} /></label>
        <label className="field"><span>{t('phrase.accName')}</span><input value={v.name} maxLength={32} onChange={(e) => set({ ...v, name: e.target.value })} /></label>
        <p className="small muted">{t('phrase.keyHint')}</p>
      </>}
    </div>
  );
}
