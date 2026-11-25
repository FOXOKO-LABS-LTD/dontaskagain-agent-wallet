import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
// UI kit 1.1.1: local fonts (Manrope, JetBrains Mono; latin + cyrillic), the kit's tokens of both themes, our styles
import './fonts.css';
import './tokens.css';
import './styles.css';
import type { AccountView, BalancesView, Cmd, PricesView, Reply, StatusView } from '../../shared/api';
import { diffMask, shortAddr } from '../../lib/similar';
import { copySource, groupAddress, prefixLen, SUFFIX_LEN } from '../../lib/addressFormat';
import { I } from './icons';
import { detectLang, fmtDateTime, fmtNum, getLangPref, onLangChange, setLangPref, t, type Key, type LangPref } from '../../i18n';
import { useLang } from '../../i18n/react';
import { setThemePref, useThemePref, type ThemePref } from './theme';

export async function api<T = any>(c: Cmd): Promise<T> {
  const r = (await chrome.runtime.sendMessage(c)) as Reply<T> | undefined;
  if (!r) throw new Error('no answer from the extension worker');
  if (!r.ok) throw new Error(r.error);
  return r.result;
}

/** Status + refresh when the worker says something changed. */
// 0.1.7: answers that arrive out of order are dropped (a slow status from before «lock» used to bring the unlocked view
// back), an identical status keeps the same object (no re-render, no effects re-run every 15 s), and lockNow() shows
// the password screen at once — before the worker even answers.
const lockListeners = new Set<() => void>();
export function lockNow(): Promise<void> {
  lockListeners.forEach((f) => f());
  return api({ cmd: 'lock' }).then(() => undefined, () => undefined);
}

export function useStatus(): [StatusView | null, () => void] {
  const [st, setSt] = useState<StatusView | null>(null);
  const seq = useRef(0), last = useRef('');
  const load = useCallback(() => {
    const my = ++seq.current;
    api<StatusView>({ cmd: 'status' }).then((x) => {
      if (my !== seq.current) return; // a newer request was sent meanwhile
      const j = JSON.stringify(x);
      if (j === last.current) return;
      last.current = j;
      setSt(x);
    }).catch(() => {});
  }, []);
  useEffect(() => {
    load();
    const l = (m: any) => { if (m?.event === 'changed') load(); };
    const onLock = () => { seq.current++; last.current = ''; setSt((x) => (x ? { ...x, unlocked: false, seeds: [], agents: [], book: [] } : x)); setTimeout(load, 50); };
    chrome.runtime.onMessage.addListener(l);
    lockListeners.add(onLock);
    const t = setInterval(load, 15_000);
    // texts built by the worker (history lines, operation page, block reasons) follow the language too: after a switch a
    // fresh status object makes every view that loads on `st` load again (the worker gets the change a moment later)
    const offLang = onLangChange(() => { last.current = ''; setTimeout(load, 200); });
    return () => { chrome.runtime.onMessage.removeListener(l); lockListeners.delete(onLock); clearInterval(t); offLang(); };
  }, [load]);
  return [st, load];
}

/** 0.3.12: re-read on every worker change (`changed`), even when the status object itself stayed the same — an
 * operation's steps and the history move without changing the status. */
export function useWorkerChanged(f: () => void): void {
  const ref = useRef(f);
  ref.current = f;
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const l = (m: any) => { if (m?.event === 'changed') { if (t) clearTimeout(t); t = setTimeout(() => ref.current(), 120); } };
    chrome.runtime.onMessage.addListener(l);
    return () => { chrome.runtime.onMessage.removeListener(l); if (t) clearTimeout(t); };
  }, []);
}

// ---------- activity (auto-lock counts only the human's actions) ----------
// Real input in any of our pages (popup, side panel, sign window) is activity: at most one `touch` per 15 s. Opening a
// view is NOT (0.3.2): the sign window is opened by the worker when an agent asks, not by the human.
let autolockAt: number | undefined;
const autolockListeners = new Set<() => void>();
const setAutolockAt = (x: number | undefined) => { autolockAt = x; autolockListeners.forEach((f) => f()); };
export function useActivity(): void {
  useEffect(() => {
    let lastSent = 0;
    const send = (e: Event) => {
      if (!e.isTrusted) return; // a synthetic event is not a person
      const now = Date.now();
      if (now - lastSent < 15_000) return;
      lastSent = now;
      api<{ autolock_at?: number }>({ cmd: 'touch' }).then((r) => setAutolockAt(r?.autolock_at)).catch(() => {});
    };
    api<{ autolock_at?: number }>({ cmd: 'status' }).then((r) => setAutolockAt(r?.autolock_at)).catch(() => {}); // the deadline, without moving it
    const evs = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    for (const e of evs) window.addEventListener(e, send, { passive: true, capture: true });
    return () => { for (const e of evs) window.removeEventListener(e, send, { capture: true } as any); };
  }, []);
}
/** «Locks in N min»: minutes left (live), or null when locked / unknown. */
export function useAutolockMinutes(st: StatusView): number | null {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((x) => x + 1);
    autolockListeners.add(f);
    const t = setInterval(f, 10_000);
    return () => { autolockListeners.delete(f); clearInterval(t); };
  }, []);
  if (!st.unlocked) return null;
  const at = Math.max(autolockAt ?? 0, st.autolock_at ?? 0);
  if (!at) return null;
  return Math.max(0, Math.ceil((at - Date.now()) / 60_000));
}

export function useAsync() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const run = useCallback(async <T,>(f: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true); setErr('');
    try { return await f(); } catch (e) { setErr((e as Error).message); return undefined; } finally { setBusy(false); }
  }, []);
  return { busy, err, setErr, run };
}

export const Err = ({ msg }: { msg: string }) => (msg ? <div className="error">{humanError(msg)}</div> : null);

/** Error codes of the worker → the human's words (the code itself stays in brackets when the error has details). */
const ERRORS: Record<string, Key> = {
  LOCKED: 'err.LOCKED', BAD_PASSWORD: 'err.BAD_PASSWORD', PASSWORD_TOO_SHORT: 'err.PASSWORD_TOO_SHORT',
  BAD_MNEMONIC: 'err.BAD_MNEMONIC', BAD_PRIVATE_KEY: 'err.BAD_PRIVATE_KEY', BAD_NAME: 'err.BAD_NAME',
  SEED_EXISTS: 'err.SEED_EXISTS', ACCOUNT_EXISTS: 'err.ACCOUNT_EXISTS', ROOT_SEED: 'err.ROOT_SEED',
  ROOT_ACCOUNT: 'err.ROOT_ACCOUNT', UNKNOWN_SEED: 'err.UNKNOWN_SEED', UNKNOWN_ACCOUNT: 'err.UNKNOWN_ACCOUNT',
  INVALID_ADDRESS: 'err.INVALID_ADDRESS', ALREADY_IN_BOOK: 'err.ALREADY_IN_BOOK', NO_MNEMONIC: 'err.NO_MNEMONIC',
  'Signer is not connected': 'err.NOT_CONNECTED', NOT_CONNECTED: 'err.NOT_CONNECTED', UNKNOWN_AGENT: 'err.UNKNOWN_AGENT',
  NO_ACCOUNTS: 'err.NO_ACCOUNTS', AGENT_REVOKED: 'err.AGENT_REVOKED', NOT_PENDING: 'err.NOT_PENDING', REQUEST_EXPIRED: 'err.REQUEST_EXPIRED',
  E2E_REQUIRED: 'err.E2E_REQUIRED', E2E_UNAVAILABLE: 'err.E2E_UNAVAILABLE', BAD_FINGERPRINT: 'err.BAD_FINGERPRINT', RPC_NOT_CONFIGURED: 'err.RPC_NOT_CONFIGURED', NO_TRON_NODE: 'err.NO_TRON_NODE',
};

export function humanError(m: string): string {
  for (const [k, key] of Object.entries(ERRORS)) if (m.startsWith(k)) return t(key) + (m.length > k.length ? ` (${m})` : '');
  return m;
}

/**
 * Full address (UI kit ADDRESS.md): mono, visual groups (TRON 4·4…·4, EVM 0x+4·4…·4), both ends marked, nothing hidden,
 * LTR and isolated. The groups are separate spans with CSS gaps — no space characters — so the visible text is the raw
 * address; data-address holds it and an optional copy button copies exactly it (data-copy). `compare` marks the
 * characters that differ from a similar address. `size="md"` is the 13 px variant, the default is 11 px (KV).
 */
export function Addr({ a, compare, network = 'tron', copy, size }: { a: string; compare?: string; network?: string; copy?: boolean; size?: 'md' }) {
  const mask = compare ? diffMask(network, a, compare) : null;
  const { groups } = groupAddress(a);
  const p = prefixLen(a);
  let at = 0;
  const visual: ReactNode[] = groups.map((g, gi) => {
    const start = at; at += g.length;
    const edge = a.length > p + SUFFIX_LEN && (gi === 0 || gi === groups.length - 1);
    const chars: ReactNode[] = [];
    if (mask) { for (let j = start; j < start + g.length; j++) chars.push(mask[j] ? <span key={j} className="address-diff diff">{a[j]}</span> : a[j]); }
    return <span key={start} className={`address-group g${edge ? ' address-edge end' : ''}`}>{mask ? chars : g}</span>;
  });
  const el = <span className={`addr address address-grouped${size === 'md' ? '' : ' address-compact'}`} dir="ltr" role="group" aria-label={t('addr.full', { a })} data-address={a}>
    <span className="address-visual" aria-hidden="true">{visual}</span></span>;
  if (!copy || !a) return el;
  return <span className="addr-copy">{el}<CopyIcon text={a} /></span>;
}

/** Writes the raw string of a copy button (its data-copy) to the clipboard; the «copied» mark only after it succeeded. */
export async function copyFrom(el: { dataset: DOMStringMap }): Promise<string> {
  const v = copySource(el);
  await navigator.clipboard.writeText(v);
  return v;
}

/** 32 px icon button «copy the full address without spaces». */
export function CopyIcon({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return <button type="button" className="iconbtn flat copy-addr" data-copy={text} title={t('addr.copy')} aria-label={t('addr.copy')}
    onClick={(e) => { e.stopPropagation(); void copyFrom(e.currentTarget).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }, () => {}); }}>
    {done ? <I.check size={16} /> : <I.copy size={16} />}<span className="sr-only" role="status">{done ? t('common.copied') : ''}</span></button>;
}

export function Copy({ text, label, small }: { text: string; label?: string; small?: boolean }) {
  const [done, setDone] = useState(false);
  return <button className={`btn${small ? ' sm' : ''}`} data-copy={text} onClick={(e) => { void copyFrom(e.currentTarget).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }, () => {}); }}>{done ? <><I.check size={16} /> {t('common.copied')}</> : <><I.copy size={16} /> {label ?? t('common.copy')}</>}</button>;
}

/** Short address with both ends (lists only) + copy on click. */
export function AddrChip({ a }: { a: string }) {
  const [done, setDone] = useState(false);
  if (!a) return null;
  return <button className="addr-chip" title={a} data-copy={a} onClick={(e) => { e.stopPropagation(); void copyFrom(e.currentTarget).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); }, () => {}); }}>
    {shortAddr(a)} {done ? <I.check size={12} /> : <I.copy size={12} />}</button>;
}

// ---------- tiny hash router (popup / side panel share one app) ----------
export function useRoute(): [string, (p: string) => void] {
  const get = () => (location.hash.replace(/^#/, '') || '/');
  const [path, setPath] = useState(get);
  useEffect(() => { const f = () => setPath(get()); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, []);
  const nav = useCallback((p: string) => { location.hash = p; }, []);
  return [path, nav];
}

// ---------- the selected account (UI-only, shared by popup and panel) ----------
const ACC_KEY = 'aw.account';
export function useSelectedAccount(st: StatusView | null): [AccountView | undefined, (id: string) => void] {
  const [id, setId] = useState<string>(() => localStorage.getItem(ACC_KEY) ?? '');
  const acc = st?.accounts.find((a) => a.id === id) ?? st?.accounts[0];
  const pick = useCallback((x: string) => { localStorage.setItem(ACC_KEY, x); setId(x); }, []);
  return [acc, pick];
}

// ---------- balances and prices ----------
// The worker keeps the last balances (20 s TTL, shared fetches). A page first takes what the worker already has (one
// message, no network) and paints, then asks for fresh numbers.
const balCache = new Map<string, BalancesView>();
const balListeners = new Set<() => void>();
const inflight = new Map<string, Promise<BalancesView>>();
const emitBal = () => balListeners.forEach((f) => f());
export function loadBalances(id: string, force = false): Promise<BalancesView> {
  if (!force && inflight.has(id)) return inflight.get(id)!;
  const p = api<BalancesView>({ cmd: 'balances', id, force }).then((b) => { balCache.set(id, b); emitBal(); return b; }).finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}
export function useBalances(ids: string[], deps: unknown[] = []): Record<string, BalancesView | undefined> {
  const [, tick] = useState(0);
  useEffect(() => { const f = () => tick((x) => x + 1); balListeners.add(f); return () => { balListeners.delete(f); }; }, []);
  const key = ids.join(',');
  useEffect(() => {
    const missing = ids.filter((id) => id && !balCache.has(id));
    const fresh = () => { for (const id of ids) if (id) void loadBalances(id).catch(() => {}); };
    if (!missing.length) { fresh(); return; }
    api<Record<string, BalancesView>>({ cmd: 'balancesCached', ids: missing })
      .then((m) => { let any = false; for (const [id, b] of Object.entries(m ?? {})) if (!balCache.has(id)) { balCache.set(id, b); any = true; } if (any) emitBal(); })
      .catch(() => {}).finally(fresh);
  }, [key, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  return Object.fromEntries(ids.map((id) => [id, balCache.get(id)]));
}
let pricesMem: PricesView | null = null;
export function usePrices(dep: unknown): PricesView | null {
  const [p, setP] = useState<PricesView | null>(pricesMem);
  useEffect(() => { api<PricesView>({ cmd: 'prices' }).then((x) => { pricesMem = x; setP(x); }).catch(() => {}); }, [dep]);
  return p;
}

/** Name of the phrase of an account, or «key» / «key» for an imported one (the mark in flat account lists). */
export function accountTag(st: StatusView, a: AccountView): string {
  if (a.origin === 'imported') return t('common.tagKey');
  return st.seeds.find((x) => x.id === a.seed_id)?.name ?? t('common.tagPhrase');
}

export const fmtTime = (iso?: string) => (iso ? fmtDateTime(iso) : '');

export function Countdown({ until }: { until?: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  if (!until) return null;
  const s = Math.floor((Date.parse(until) - now) / 1000);
  if (s <= 0) return <span className="badge bad">{t('common.expired')}</span>;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return <span className={`badge ${s < 120 ? 'bad' : s < 600 ? 'warn' : ''}`}>{h ? t('common.countdownH', { h, m }) : t('common.countdownM', { m, s: String(ss).padStart(2, '0') })}</span>;
}

export const n = (x: number) => fmtNum(x);

/** The product name is not translated. */
export const PRODUCT = "Don't Ask Again";

/** RU / EN in the bar of the first-run screen (the full choice with «like the browser» is in Settings). */
export function LangSwitch() {
  const l = useLang();
  return <span className="row" style={{ gap: 4 }}>{(['ru', 'en'] as const).map((x) => <button key={x} className={`btn sm${l === x ? ' primary' : ''}`} aria-pressed={l === x} onClick={() => void setLangPref(x)}>{x.toUpperCase()}</button>)}</span>;
}

/** Settings → «Language»: like the browser / Русский / English. */
export function LangSelect() {
  useLang();
  const [p, setP] = useState<LangPref>(getLangPref);
  return <label className="field"><span>{t('settings.langLabel')}</span>
    <select value={p} onChange={(e) => { const v = e.target.value as LangPref; setP(v); void setLangPref(v); }}>
      <option value="auto">{t('settings.langAuto', { lang: t(detectLang() === 'ru' ? 'lang.ru' : 'lang.en') })}</option>
      <option value="ru">{t('lang.ru')}</option>
      <option value="en">{t('lang.en')}</option>
    </select></label>;
}

/** Settings → «Theme»: system (default) / light / dark — a segmented control (UI kit), kept next to the language. */
export function ThemeSelect() {
  useLang();
  const p = useThemePref();
  const opts: [ThemePref, Key, ReactNode][] = [['system', 'settings.themeSystem', null], ['light', 'settings.themeLight', <I.themeLight size={16} />], ['dark', 'settings.themeDark', <I.themeDark size={16} />]];
  return <div className="field"><span id="theme-label">{t('settings.themeLabel')}</span>
    <div className="segmented" role="group" aria-labelledby="theme-label">
      {opts.map(([v, k, ic]) => <button key={v} type="button" className="segment" aria-pressed={p === v} onClick={() => void setThemePref(v)}>{ic}{t(k)}</button>)}
    </div></div>;
}
