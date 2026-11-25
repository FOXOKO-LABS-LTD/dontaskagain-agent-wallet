// Sanity check of dist/ for "Load unpacked": manifest, worker, pages, icons; the worker must not touch the DOM.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
const m = JSON.parse(readFileSync('dist/manifest.json', 'utf8'));
const logos = ['tron', 'usdt', 'usdc', 'eth', 'polygon', 'base', 'arbitrum', 'optimism'].map((x) => `logos/${x}.svg`);
// 0.3.6 UI kit: the toolbar icons, the theme boot script (before the first paint), the logo and every mascot state
const mascots = ['neutral', 'waiting', 'done', 'canceled', 'network-error', 'locked', 'connected', 'warning', 'empty'].flatMap((x) => ['light', 'dark', 'small/light', 'small/dark'].map((d) => `mascot/${d}/${x}.svg`));
const brand = ['brand/horizontal.svg', 'brand/horizontal-dark.svg', 'brand/mark-small.svg', 'theme-boot.js'];
const need = ['background.js', 'popup.html', 'panel.html', 'sign.html', ...Object.values(m.icons), ...Object.values(m.action?.default_icon ?? {}), ...logos, ...mascots, ...brand];
const missing = need.filter((f) => !existsSync('dist/' + f));
if (missing.length) { console.error('dist: missing', missing); process.exit(1); }
// name/description come from _locales (ru, en): every __MSG_x__ must exist in each locale, default_locale among them
const msgs = [...JSON.stringify(m).matchAll(/__MSG_(\w+)__/g)].map((x) => x[1]);
for (const loc of ['ru', 'en']) {
  const f = `dist/_locales/${loc}/messages.json`;
  if (!existsSync(f)) { console.error('dist: missing', f); process.exit(1); }
  const j = JSON.parse(readFileSync(f, 'utf8'));
  const gone = msgs.filter((k) => !j[k]?.message);
  if (gone.length) { console.error(`dist: ${f} has no`, gone); process.exit(1); }
}
if (msgs.length && !existsSync(`dist/_locales/${m.default_locale}/messages.json`)) { console.error('dist: default_locale', m.default_locale); process.exit(1); }
for (const f of ['popup.html', 'panel.html', 'sign.html']) if (!/<head>[^]*theme-boot\.js[^]*<\/head>/.test(readFileSync('dist/' + f, 'utf8'))) { console.error('dist: no theme-boot.js in the head of', f); process.exit(1); }
const bg = readFileSync('dist/background.js', 'utf8');
const imports = [...bg.matchAll(/from\s*["'](\.\/[^"']+)["']/g)].map((x) => x[1]);
for (const i of imports) if (!existsSync('dist/' + i.slice(2))) { console.error('dist: worker import missing', i); process.exit(1); }
console.log(`dist ok: manifest v${m.version}, worker imports ${imports.length} chunk(s), ${readdirSync('dist/assets').length} assets`);
