// 0.3.6: the theme choice (system / light / dark) is a UI setting next to the language — chrome.storage.local `ui_theme`
// — never the vault; the boot script in <head> resolves the same way as the app (no flash of the other theme).
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { resolveTheme, setThemePref, THEME_KEY } from '../src/ui/common/theme';

describe('theme', () => {
  it('system follows prefers-color-scheme; an explicit choice wins', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('the choice is saved as ui_theme in chrome.storage.local, nothing else is written', async () => {
    const sets: unknown[] = [];
    vi.stubGlobal('chrome', { storage: { local: { set: async (x: unknown) => { sets.push(x); } } } });
    try {
      await setThemePref('dark');
      await setThemePref('system');
      expect(THEME_KEY).toBe('ui_theme');
      expect(sets).toEqual([{ ui_theme: 'dark' }, { ui_theme: 'system' }]);
    } finally { vi.unstubAllGlobals(); }
  });

  it('public/theme-boot.js: the cached choice or the system theme on <html data-theme> before the first paint', () => {
    const src = readFileSync('public/theme-boot.js', 'utf8');
    const run = (cached: string | null, systemDark: boolean) => {
      const attrs: Record<string, string> = {};
      runInNewContext(src, {
        localStorage: { getItem: (k: string) => (k === 'aw.theme' ? cached : null) },
        window: { matchMedia: () => ({ matches: systemDark }) },
        document: { documentElement: { setAttribute: (k: string, v: string) => { attrs[k] = v; } } },
      });
      return attrs['data-theme'];
    };
    expect(run(null, true)).toBe('dark');
    expect(run(null, false)).toBe('light');
    expect(run('system', true)).toBe('dark');
    expect(run('light', true)).toBe('light');
    expect(run('dark', false)).toBe('dark');
  });
});
