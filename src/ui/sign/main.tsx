// Sign window: the extension's own popup window, never embedded in pages. Opened only when no side panel is open.
import { createRoot } from 'react-dom/client';
import { SignQueue } from '../common/SignQueue';
import { PRODUCT, useActivity, useStatus } from '../common/ui';
import { initI18n, t } from '../../i18n';
import { useLang } from '../../i18n/react';
import { initTheme } from '../common/theme';
import { Mascot } from '../common/Mascot';

function App() {
  useLang();
  const [st, reload] = useStatus();
  document.title = `${PRODUCT} — ${t('main.signTitle')}`;
  useActivity();
  if (!st) return null;
  return (
    <div className="app">
      <div className="subbar">{/* the only mascot of the sign window: small, neutral, in the header (UI kit) */}<Mascot state="waiting" size={28} className="sign-mark" /><h1>{t('main.signTitle')}</h1><span className="grow" />{st.pending > 0 && <span className="badge ink">{t('main.inQueue', { n: st.pending })}</span>}</div>
      <div className="scroll"><div className="screen"><SignQueue st={st} reload={reload} onClose={() => window.close()} /></div></div>
    </div>
  );
}

document.body.classList.add('signwin');
void Promise.all([initI18n(), initTheme()]).finally(() => createRoot(document.getElementById('root')!).render(<App />));
