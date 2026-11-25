// UI language: Russian and English, like the site. Our own small dictionary instead of chrome.i18n
// messages.json — that one cannot switch on the fly. The default follows the browser (ru* → ru, anything else → en);
// the choice in Settings is kept in chrome.storage.local (`ui_lang`) and every open view (popup, side panel, sign
// window) and the worker switch at once through storage.onChanged — no reload.
//
// Texts that the AGENT sees (reject details we send to the Signer) are not localized: they are always built with
// `ta()` (AGENT_LANG), and the human copy of the same text goes next to them (`both()`).
import { ru } from './ru';
import { en } from './en';

export type Lang = 'ru' | 'en';
export type LangPref = Lang | 'auto';
/** Plural forms: ru needs one/few/many, en — one/other (`other` is the fallback of every language). */
export interface Forms { one: string; few?: string; many?: string; other: string }
export type Entry = string | Forms;
export type Key = keyof typeof ru;
export type Params = Record<string, string | number | bigint | null | undefined>;

export const LANGS: Lang[] = ['ru', 'en'];
export const DICTS: Record<Lang, Record<string, Entry>> = { ru, en };
/** The language of texts that go to agents (reject details): fixed, never the human's UI language. */
export const AGENT_LANG: Lang = 'ru';
export const STORAGE_KEY = 'ui_lang';

const chromeApi = (): any => (typeof chrome !== 'undefined' ? chrome : undefined);

/** ru, ru-RU, ru_RU → ru; everything else (and nothing) → en. */
export function langOf(tag: string | undefined | null): Lang {
  return /^ru(?:[-_]|$)/i.test(String(tag ?? '').trim()) ? 'ru' : 'en';
}
export function detectLang(): Lang {
  let tag = '';
  try { tag = chromeApi()?.i18n?.getUILanguage?.() ?? ''; } catch { /* not in an extension */ }
  if (!tag && typeof navigator !== 'undefined') tag = navigator.language ?? '';
  return langOf(tag);
}

let pref: LangPref = 'auto';
let lang: Lang = detectLang();
const listeners = new Set<(l: Lang) => void>();

export const getLang = (): Lang => lang;
export const getLangPref = (): LangPref => pref;
export const locale = (l: Lang = lang): string => (l === 'ru' ? 'ru-RU' : 'en-US');

function apply(p: LangPref): void {
  pref = p === 'ru' || p === 'en' ? p : 'auto';
  const next = pref === 'auto' ? detectLang() : pref;
  if (typeof document !== 'undefined') document.documentElement.lang = next;
  if (next === lang) return;
  lang = next;
  listeners.forEach((f) => { try { f(lang); } catch { /* a listener must not break the others */ } });
}

/** Subscribe to language changes; returns the unsubscribe function. */
export function onLangChange(f: (l: Lang) => void): () => void { listeners.add(f); return () => { listeners.delete(f); }; }

let inited: Promise<void> | null = null;
/** Read the saved choice and follow its changes (pages and the worker call it once at start). */
export function initI18n(): Promise<void> {
  inited ??= (async () => {
    const c = chromeApi();
    try {
      const got = await c?.storage?.local?.get?.(STORAGE_KEY);
      apply(got?.[STORAGE_KEY] ?? 'auto');
    } catch { apply('auto'); }
    try {
      c?.storage?.onChanged?.addListener?.((ch: Record<string, { newValue?: unknown }>, area: string) => {
        if (area === 'local' && ch[STORAGE_KEY]) apply((ch[STORAGE_KEY].newValue as LangPref) ?? 'auto');
      });
    } catch { /* no events (tests) */ }
  })();
  return inited;
}

/** Settings → «Language»: applied here at once, saved for every other view and the worker. */
export async function setLangPref(p: LangPref): Promise<void> {
  apply(p);
  await chromeApi()?.storage?.local?.set?.({ [STORAGE_KEY]: pref });
}

const rules = new Map<Lang, Intl.PluralRules>();
export function pluralForm(l: Lang, n: number, f: Forms): string {
  let r = rules.get(l);
  if (!r) { r = new Intl.PluralRules(locale(l)); rules.set(l, r); }
  const cat = r.select(Math.abs(n)) as keyof Forms;
  return f[cat] ?? f.other;
}

/** A text of language `l`: `{name}` → params.name; an entry with plural forms picks one by `params.n`. */
export function tl(l: Lang, key: Key, p?: Params): string {
  const e = DICTS[l][key] ?? DICTS.ru[key];
  if (e === undefined) return String(key);
  const s = typeof e === 'string' ? e : pluralForm(l, Number(p?.n ?? 0), e);
  return p ? s.replace(/\{(\w+)\}/g, (m, k: string) => (p[k] === undefined || p[k] === null ? m : String(p[k]))) : s;
}
/** A text in the human's language. */
export const t = (key: Key, p?: Params): string => tl(lang, key, p);
/** A text for the agent (fixed language, see AGENT_LANG). */
export const ta = (key: Key, p?: Params): string => tl(AGENT_LANG, key, p);
/** The same text for both: `message` goes to the agent, `text` is shown to the human. */
export const both = (key: Key, p?: Params): { message: string; text: string } => ({ message: ta(key, p), text: t(key, p) });
/** Dynamic keys (`status.${s}`): a key that may not exist. */
export const hasKey = (key: string): key is Key => key in DICTS.ru;
export const tk = (key: string, fallback: string, p?: Params): string => (hasKey(key) ? t(key, p) : fallback);

// ---- numbers, dates, times by the language ----
export const fmtNum = (x: number, o?: Intl.NumberFormatOptions): string => x.toLocaleString(locale(), o);
export function fmtDateTime(d: Date | string | number, o: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }): string {
  const x = d instanceof Date ? d : new Date(d);
  return Number.isNaN(x.getTime()) ? '' : x.toLocaleString(locale(), o);
}
export function fmtClock(d: Date | string | number): string {
  const x = d instanceof Date ? d : new Date(d);
  return Number.isNaN(x.getTime()) ? '' : x.toLocaleTimeString(locale());
}
