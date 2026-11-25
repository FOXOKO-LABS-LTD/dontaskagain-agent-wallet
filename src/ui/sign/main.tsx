// Sign window: the extension's own popup window, never embedded in pages. Opened only when no side panel is open.
// 0.3.12: after a signature, with nothing else waiting, the window shows that operation's page (its steps live) in
// place — the same page as in the popup; a new request brings the queue back with one button.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SignQueue } from '../common/SignQueue';
import { Operation } from '../popup/Operation';
import { PRODUCT, useActivity, useStatus } from '../common/ui';
import { initI18n, t } from '../../i18n';
import { useLang } from '../../i18n/react';
import { initTheme } from '../common/theme';
import { Mascot } from '../common/Mascot';

function App() {
  useLang();
  const [st, reload] = useStatus();
  const [op, setOp] = useState<string | null>(null);
  document.title = `${PRODUCT} — ${op ? t('title.op') : t('main.signTitle')}`;
  useActivity();
  if (!st) return null;
  return (
    <div className="app">
      <div className="subbar">{/* the only mascot of the sign window: small, neutral, in the header (UI kit) */}<Mascot state="waiting" size={28} className="sign-mark" /><h1>{op ? t('title.op') : t('main.signTitle')}</h1><span className="grow" />{st.pending > 0 && <span className="badge ink">{t('main.inQueue', { n: st.pending })}</span>}</div>
      <div className="scroll">
        {op ? <>
          {st.pending > 0 && <div className="screen" style={{ paddingBottom: 0 }}><button className="btn primary block" onClick={() => setOp(null)}>{t('sign.backToQueue', { n: st.pending })}</button></div>}
          <Operation st={st} nav={() => {}} path={`/op/${encodeURIComponent(op)}`} onClose={() => window.close()} />
        </> : <div className="screen"><SignQueue st={st} reload={reload} onClose={() => window.close()} onSigned={setOp} openOp={setOp} /></div>}
      </div>
    </div>
  );
}

document.body.classList.add('signwin');
void Promise.all([initI18n(), initTheme()]).finally(() => createRoot(document.getElementById('root')!).render(<App />));
