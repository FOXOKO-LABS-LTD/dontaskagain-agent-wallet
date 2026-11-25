// UI language : both dictionaries have the same keys, plural forms and placeholders; the code outside
// the dictionaries has no Cyrillic (except comments and the white list); language detection, plurals, live switch.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ru } from '../src/i18n/ru';
import { en } from '../src/i18n/en';
import { both, getLang, initI18n, langOf, onLangChange, setLangPref, t, ta, tl, type Entry } from '../src/i18n';

const SRC = join(__dirname, '..', 'src');
const CYR = /[Ѐ-ӿ]/;
const placeholders = (e: Entry) => new Set([...(typeof e === 'string' ? [e] : Object.values(e)).join(' ').matchAll(/\{(\w+)\}/g)].map((m) => m[1]));

describe('dictionaries', () => {
  it('every ru key exists in en and vice versa', () => {
    const r = Object.keys(ru), e = Object.keys(en);
    expect(r.filter((k) => !(k in en)), 'missing in en').toEqual([]);
    expect(e.filter((k) => !(k in ru)), 'missing in ru').toEqual([]);
    expect(r.length).toBeGreaterThan(300);
  });
  it('no empty texts; plural forms complete (ru one/few/many/other, en one/other)', () => {
    for (const [d, need] of [[ru, ['one', 'few', 'many', 'other']], [en, ['one', 'other']]] as const) {
      for (const [k, v] of Object.entries(d as Record<string, Entry>)) {
        if (typeof v === 'string') { expect(v.trim(), k).not.toBe(''); continue; }
        for (const f of need) expect((v as any)[f], `${k}.${f}`).toBeTruthy();
      }
    }
  });
  it('the same placeholders in both languages', () => {
    const bad = Object.keys(ru).filter((k) => {
      const a = placeholders((ru as any)[k]), b = placeholders((en as any)[k]);
      return a.size !== b.size || [...a].some((x) => !b.has(x));
    });
    expect(bad).toEqual([]);
  });
  it('English has no Cyrillic (except the name of the Russian language)', () => {
    const bad = Object.entries(en as Record<string, Entry>).filter(([k, v]) => k !== 'lang.ru' && CYR.test(JSON.stringify(v))).map(([k]) => k);
    expect(bad).toEqual([]);
  });
});

/** Code without comments (block, JSX and line comments); string contents stay. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n').map((l) => l.replace(/(^|[\s;,(){}\]])\/\/.*$/, '$1')).join('\n');
}
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
}
// What may keep Cyrillic outside the dictionaries: data, not UI text.
const WHITE: { file: string; line: RegExp; why: string }[] = [
  { file: 'lib/agentConnect.ts', line: /^\s*(?:[а-яё]: '[a-z]*',\s*)+$/, why: 'transliteration table for agent slugs' },
  { file: 'lib/crypto/password.ts', line: /^\s*'(?:йцукен|пароль)'|^const ROWS = |^\s*const classes = /, why: 'weak-password lists (keyboard rows, common words) and letter classes — data, not UI text' },
];

describe('no UI text outside the dictionaries', () => {
  it('no Cyrillic in src/ (comments, src/i18n and the white list aside)', () => {
    const hits: string[] = [];
    for (const f of files(SRC)) {
      const rel = relative(SRC, f).replace(/\\/g, '/');
      if (rel.startsWith('i18n/')) continue;
      stripComments(readFileSync(f, 'utf8')).split('\n').forEach((l, i) => {
        if (!CYR.test(l)) return;
        if (WHITE.some((w) => w.file === rel && w.line.test(l))) return;
        hits.push(`${rel}:${i + 1}: ${l.trim().slice(0, 120)}`);
      });
    }
    expect(hits).toEqual([]);
  });
  it('every literal key used in the code exists', () => {
    const used = new Set<string>();
    for (const f of files(SRC)) {
      for (const m of readFileSync(f, 'utf8').matchAll(/\b(?:t|ta|both)\(\s*'([a-zA-Z0-9_]+\.[a-zA-Z0-9_.]+)'/g)) used.add(m[1]);
    }
    expect(used.size).toBeGreaterThan(100);
    expect([...used].filter((k) => !(k in ru))).toEqual([]);
  });
});

describe('language', () => {
  it('ru* → ru, anything else → en', () => {
    for (const x of ['ru', 'ru-RU', 'ru_RU', 'RU-ru']) expect(langOf(x), x).toBe('ru');
    for (const x of ['en', 'en-US', 'uk', 'be-BY', 'de', '', undefined, 'rus']) expect(langOf(x as any), String(x)).toBe('en');
  });
  it('plurals and placeholders', () => {
    const k = 'settings.bookCount' as const;
    expect([1, 2, 5, 11, 21, 22, 25].map((n) => tl('ru', k, { n }))).toEqual(['1 адрес', '2 адреса', '5 адресов', '11 адресов', '21 адрес', '22 адреса', '25 адресов']);
    expect([1, 2, 5].map((n) => tl('en', k, { n }))).toEqual(['1 address', '2 addresses', '5 addresses']);
    expect(tl('en', 'book.removeConfirm', { label: 'Office' })).toBe('Remove “Office” from the book?');
  });
  it('switches at once without a reload; agent texts stay in the fixed language', async () => {
    const store: Record<string, any> = {};
    const changed: ((c: any, area: string) => void)[] = [];
    (globalThis as any).chrome = { storage: { local: { get: async (k: string) => ({ [k]: store[k] }), set: async (v: any) => { Object.assign(store, v); } }, onChanged: { addListener: (f: any) => changed.push(f) } } };
    await initI18n();
    expect(getLang()).toBe('ru');
    const seen: string[] = [];
    const off = onLangChange((l) => seen.push(l));
    await setLangPref('en');
    expect(store.ui_lang).toBe('en');
    expect(getLang()).toBe('en');
    expect(t('err.LOCKED')).toBe('The wallet is locked');
    expect(ta('err.LOCKED')).toBe('Кошелёк заблокирован');
    expect(both('err.LOCKED')).toEqual({ message: 'Кошелёк заблокирован', text: 'The wallet is locked' });
    // another view changed it: storage.onChanged
    for (const f of changed) f({ ui_lang: { newValue: 'ru' } }, 'local');
    expect(getLang()).toBe('ru');
    for (const f of changed) f({ ui_lang: { newValue: 'auto' } }, 'local'); // like the browser (here ru-RU)
    expect(getLang()).toBe('ru');
    expect(seen).toEqual(['en', 'ru']);
    off();
    delete (globalThis as any).chrome;
  });
});
