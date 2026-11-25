// UI theme (0.3.6, UI kit 1.1.1): «System / Light / Dark», the default follows the system. The choice lives next
// to the language — chrome.storage.local (`ui_theme`), never in the vault — and every open view (popup, side panel, sign
// window) switches at once through storage.onChanged. A copy in localStorage (`aw.theme`) is read synchronously by
// public/theme-boot.js in <head>, before the first paint, so a window never flashes the other theme when it opens.
import { useSyncExternalStore } from 'react';

export type ThemePref = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';
export const THEME_KEY = 'ui_theme';
/** must match public/theme-boot.js */
export const THEME_CACHE_KEY = 'aw.theme';

const chromeApi = (): any => (typeof chrome !== 'undefined' ? chrome : undefined);
const norm = (p: unknown): ThemePref => (p === 'light' || p === 'dark' ? p : 'system');
/** a page (not the worker, not Node tests — touching Node's own localStorage only prints a warning) */
const inPage = typeof document !== 'undefined';
const media = (): MediaQueryList | null => (typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null);

let pref: ThemePref = 'system';
if (inPage) try { pref = norm(localStorage.getItem(THEME_CACHE_KEY)); } catch { /* no storage */ }
const listeners = new Set<() => void>();

export const resolveTheme = (p: ThemePref, systemDark = !!media()?.matches): Theme => (p === 'system' ? (systemDark ? 'dark' : 'light') : p);
export const getThemePref = (): ThemePref => pref;
export const getTheme = (): Theme => resolveTheme(pref);

function apply(p: ThemePref): void {
  pref = norm(p);
  if (inPage) {
    try { localStorage.setItem(THEME_CACHE_KEY, pref); } catch { /* ignore */ }
    document.documentElement.dataset.theme = getTheme();
  }
  listeners.forEach((f) => { try { f(); } catch { /* a listener must not break the others */ } });
}

let inited = false;
/** Read the saved choice and follow its changes and the system theme (every page calls it once at start). */
export function initTheme(): Promise<void> {
  if (inited) return Promise.resolve();
  inited = true;
  apply(pref); // the cached value at once (theme-boot.js did the same before the CSS)
  media()?.addEventListener?.('change', () => { if (pref === 'system') apply(pref); });
  const c = chromeApi();
  try {
    c?.storage?.onChanged?.addListener?.((ch: Record<string, { newValue?: unknown }>, area: string) => {
      if (area === 'local' && ch[THEME_KEY]) apply(norm(ch[THEME_KEY].newValue));
    });
  } catch { /* no events */ }
  return (async () => {
    try { const got = await c?.storage?.local?.get?.(THEME_KEY); apply(norm(got?.[THEME_KEY])); } catch { /* keep the cached one */ }
  })();
}

/** Settings → «Theme»: applied here at once, saved for every other view. */
export async function setThemePref(p: ThemePref): Promise<void> {
  apply(p);
  await chromeApi()?.storage?.local?.set?.({ [THEME_KEY]: pref });
}

const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
/** The resolved theme (light / dark); re-renders on a change. */
export const useTheme = (): Theme => useSyncExternalStore(subscribe, getTheme, getTheme);
/** The saved choice (system / light / dark). */
export const useThemePref = (): ThemePref => useSyncExternalStore(subscribe, getThemePref, getThemePref);
