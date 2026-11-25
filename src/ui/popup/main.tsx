// The wallet app: the same React app in the popup (~360×600) and in the side panel (full width). Hash routes:
// / · /history · /agents (tabs of the main screen), /send, /receive, /swap, /resources, /settings, /book,
// /agents/new, /agent/<id> (agent settings), /op/<request_id> (operation page), /sign[/<request_id>] (the queue inline — in the panel requests are shown here, not in a window).
import { Suspense, lazy, useEffect, type ComponentType, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { I } from '../common/icons';
import { LangSwitch, useActivity, useRoute, useSelectedAccount, useStatus } from '../common/ui';
import { Header } from './Header';
import { Home } from './Home';
import { Onboarding, Unlock } from './Onboarding';
import { MODE, type ScreenProps } from './screen';
import { initI18n, t, type Key } from '../../i18n';
import { useLang } from '../../i18n/react';
import { initTheme } from '../common/theme';
import { BrandLogo, Mascot } from '../common/Mascot';

// 0.1.7 (speed): the first frame needs only the header + main screen; every other screen is its own chunk, loaded
// when the browser is idle after the first paint (so a click does not wait for it either).
type Extra = { pick: (id: string) => void; path: string };
const loaders = {
  send: () => import('./Send'), receive: () => import('./Receive'), swap: () => import('./SwapPanel'), resources: () => import('./Resources'),
  bridge: () => import('./Bridge'), refuel: () => import('./Refuel'), settings: () => import('./Settings'), wizard: () => import('./AgentWizard'), agentSettings: () => import('./AgentSettings'), op: () => import('./Operation'), accounts: () => import('./Accounts'), sign: () => import('../common/SignQueue'),
};
const L = <K extends keyof typeof loaders>(k: K, name: string) =>
  lazy(() => loaders[k]().then((m: any) => ({ default: m[name] as ComponentType<ScreenProps & Extra> })));
const Send = L('send', 'Send'), Receive = L('receive', 'Receive'), SwapPanel = L('swap', 'SwapPanel'), Resources = L('resources', 'Resources');
const Bridge = L('bridge', 'Bridge'), Refuel = L('refuel', 'Refuel');
const Settings = L('settings', 'Settings'), Book = L('settings', 'Book'), AgentWizard = L('wizard', 'AgentWizard');
const AgentSettings = L('agentSettings', 'AgentSettings');
const Operation = L('op', 'Operation');
const AccountsScreen = L('accounts', 'AccountsScreen'), AddAccount = L('accounts', 'AddAccount'), Seeds = L('accounts', 'Seeds');
const SignQueue = lazy(() => loaders.sign().then((m) => ({ default: m.SignQueue })));
function usePreload() {
  useEffect(() => {
    const go = () => { for (const f of Object.values(loaders)) void f().catch(() => {}); };
    const ric = (window as any).requestIdleCallback as ((f: () => void, o?: object) => number) | undefined;
    const id = ric ? ric(go, { timeout: 1500 }) : window.setTimeout(go, 300);
    return () => { const c = (window as any).cancelIdleCallback; if (ric && c) c(id); else clearTimeout(id); };
  }, []);
}

const TITLES: Record<string, [Key, string]> = {
  '/send': ['title.send', '/'], '/receive': ['title.receive', '/'], '/swap': ['title.swap', '/'], '/resources': ['title.resources', '/'], '/bridge': ['title.bridge', '/'], '/refuel': ['title.refuel', '/'],
  '/settings': ['title.settings', '/'], '/book': ['title.book', '/settings'], '/agents/new': ['title.agentNew', '/agents'], '/agent': ['title.agent', '/agents'], '/op': ['title.op', '/history'], '/sign': ['title.sign', '/agents'],
  '/accounts': ['title.accounts', '/'], '/accounts/add': ['title.accountAdd', '/accounts'], '/seeds': ['title.seeds', '/accounts'],
};

/** In the side panel: keep a port so the worker knows the panel is open and sends requests here. */
function usePanelPort(onRequests: () => void) {
  useEffect(() => {
    if (MODE !== 'panel') return;
    let port: chrome.runtime.Port | null = null, stop = false, t: ReturnType<typeof setTimeout> | undefined;
    const open = () => {
      if (stop) return;
      port = chrome.runtime.connect({ name: 'panel' });
      port.onMessage.addListener((m) => { if (m?.event === 'requests') onRequests(); });
      port.onDisconnect.addListener(() => { port = null; t = setTimeout(open, 1000); }); // the worker restarted
    };
    open();
    return () => { stop = true; if (t) clearTimeout(t); port?.disconnect(); };
  }, [onRequests]);
}

function Sub({ path, nav, children }: { path: string; nav: (p: string) => void; children: ReactNode }) {
  const [title, back] = TITLES[path] ?? TITLES[path.replace(/\/[^/]+$/, '')] ?? TITLES[path.split('/').slice(0, 3).join('/')] ?? [null, '/'];
  return <><div className="subbar"><button className="iconbtn" title={t('common.back')} aria-label={t('common.back')} onClick={() => nav(back)}><I.back size={16} /></button><h1>{title ? t(title) : ''}</h1></div>
    <div className="scroll"><Suspense fallback={<div className="screen muted small">…</div>}>{children}</Suspense></div></>;
}

function App() {
  useLang(); // a language switch re-renders the whole app at once
  const [st, reload] = useStatus();
  const [path, nav] = useRoute();
  const [account, pick] = useSelectedAccount(st);
  usePanelPort(() => nav('/sign'));
  useActivity();
  usePreload();
  if (!st) return null;
  if (!st.initialized) return <div className="app"><div className="subbar"><h1 className="brand-h"><BrandLogo /></h1><span className="grow" /><LangSwitch /></div><div className="scroll"><Onboarding onDone={reload} /></div></div>;
  if (path.startsWith('/sign')) return (
    <div className="app"><Sub path="/sign" nav={nav}><div className="screen"><SignQueue st={st} reload={reload} initial={path.split('/')[2]} onClose={() => nav('/agents')} mascots /></div></Sub></div>
  );
  if (!st.unlocked) return (
    <div className="app">
      <div className="subbar"><h1 className="brand-h"><BrandLogo /></h1><span className="grow" />{st.pending > 0 && <button className="btn sm" onClick={() => nav('/sign')}>{t('main.requests')} <span className="badge accent">{st.pending}</span></button>}</div>
      <div className="scroll"><Unlock onDone={reload} /></div>
    </div>
  );
  if (!account) return null;
  const p: ScreenProps = { st, account, nav, reload };
  const tab = path === '/history' ? 'history' : path === '/agents' ? 'agents' : path === '/' ? 'assets' : null;
  if (tab) return (
    <div className="app">
      <Header st={st} account={account} pick={pick} nav={nav} reload={reload} />
      <div className="scroll">{st.e2e?.downgraded && <div className="screen" style={{ paddingBottom: 0 }}><div className="plate bad small" role="alert"><Mascot state="warning" size={32} className="plate-mascot" />{t('e2eset.downgraded')}</div></div>}<Home {...p} tab={tab} /></div>
    </div>
  );
  const screens: Record<string, ComponentType<ScreenProps & Extra>> = {
    '/send': Send, '/receive': Receive, '/bridge': Bridge, '/refuel': Refuel, '/swap': SwapPanel, '/resources': Resources, '/settings': Settings, '/book': Book, '/agents/new': AgentWizard,
    '/accounts': AccountsScreen, '/accounts/add': AddAccount, '/seeds': Seeds,
  };
  const S = screens[path] ?? (path.startsWith('/accounts/add/') ? AddAccount : path.startsWith('/refuel/') ? Refuel : path.startsWith('/agent/') ? AgentSettings : path.startsWith('/op/') ? Operation : undefined);
  const k = path.startsWith('/accounts') || path === '/seeds' ? path : account.id;
  return <div className="app"><Sub path={path} nav={nav}>{S ? <S key={k} {...p} pick={pick} path={path} /> : <div className="screen"><button className="btn" onClick={() => nav('/')}>{t('main.toHome')}</button></div>}</Sub></div>;
}

document.body.classList.add(MODE);
void Promise.all([initI18n(), initTheme()]).finally(() => createRoot(document.getElementById('root')!).render(<App />));
