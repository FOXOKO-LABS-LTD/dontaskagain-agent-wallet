// 0.3.6 (UI kit 1.1.1, components/ADDRESS.md): the full-address component groups the address for the eye only. The
// visible text, data-address and the copy button's data-copy are the raw string — no spaces, same case — and the copy
// handler writes exactly that string to the clipboard (TRON and EVM). The look-alike marking still works.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import contract from './fixtures/address-contract-1.1.json';
import { copySource, groupAddress } from '../src/lib/addressFormat';
import { Addr, copyFrom } from '../src/ui/common/ui';
import { diffMask } from '../src/lib/similar';

const TRON = 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH';
const EVM = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';

const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const attr = (html: string, name: string): string[] => [...html.matchAll(new RegExp(`${name}="([^"]*)"`, 'g'))].map((m) => unescape(m[1]));
/** textContent of the visual part (what a person sees and what a select-and-copy would take) */
const visualText = (html: string) => unescape(html.match(/<span class="address-visual"[^>]*>(.*?)<\/span><\/span>(?:<button|$|<\/span>)/)![1].replace(/<[^>]+>/g, ''));
const render = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(Addr, props as any));

describe('address groups (address-contract.json of the kit)', () => {
  for (const c of contract.cases) {
    it(`${c.raw}: groups, prefix, suffix; joined back = raw`, () => {
      const g = groupAddress(c.raw);
      expect(g.groups).toEqual(c.groups);
      expect(g.prefix).toBe(c.prefix);
      expect(g.suffix).toBe(c.suffix);
      expect(g.groups.join('')).toBe(c.raw);
    });
  }
  it('nothing is cleaned silently: invisible / look-alike characters stay in the groups (validation rejects them before)', () => {
    for (const raw of contract.reject_instead_of_silently_cleaning) expect(groupAddress(raw).groups.join('')).toBe(raw);
  });
  it('TRON 4 / EVM 6 at the start, 4 at the end', () => {
    expect(groupAddress(TRON).groups[0]).toBe('TUEZ');
    expect(groupAddress(EVM).groups[0]).toBe('0x9858');
    expect(groupAddress(EVM).groups.at(-1)).toBe('da94');
  });
});

describe('<Addr>: markup and copy', () => {
  for (const [name, raw, network] of [['TRON', TRON, 'tron'], ['EVM (mixed case)', EVM, 'evm:8453']] as const) {
    it(`${name}: visible text, data-address and data-copy are the raw address, no whitespace inside`, () => {
      const html = render({ a: raw, network, copy: true });
      expect(visualText(html)).toBe(raw);
      expect(attr(html, 'data-address')).toEqual([raw]);
      expect(attr(html, 'data-copy')).toEqual([raw]);
      const visual = html.match(/<span class="address-visual"[^>]*>(.*?)<\/span><\/span>/)![1];
      expect(visual).not.toMatch(/>\s+</); // gaps are CSS margins, never characters
      expect(visual.replace(/<[^>]+>/g, '')).not.toMatch(/[\s  -​ ⁠﻿]/);
      expect(html).toContain('dir="ltr"');
      expect((html.match(/address-edge/g) ?? []).length).toBe(2);
    });

    it(`${name}: the copy handler writes exactly the raw string (data-copy), not the formatted text`, async () => {
      const writes: string[] = [];
      vi.stubGlobal('navigator', { ...globalThis.navigator, clipboard: { writeText: async (s: string) => { writes.push(s); } } });
      try {
        const html = render({ a: raw, network, copy: true });
        const copied = await copyFrom({ dataset: { copy: attr(html, 'data-copy')[0] } });
        expect(copied).toBe(raw);
        expect(writes).toEqual([raw]);
        expect(writes[0]).toHaveLength(raw.length);
      } finally { vi.unstubAllGlobals(); }
    });
  }

  it('copySource never trims or reformats; without data-copy it falls back to data-address, else refuses', () => {
    expect(copySource({ dataset: { copy: TRON } })).toBe(TRON);
    expect(copySource({ dataset: { address: EVM } })).toBe(EVM);
    expect(() => copySource({ dataset: {} })).toThrow();
  });

  it('no copy button unless asked (lists, compare plates)', () => {
    expect(attr(render({ a: TRON }), 'data-copy')).toEqual([]);
  });

  it('look-alike marking still marks exactly the differing characters and keeps the text', () => {
    const [a, b] = [contract.cases[1].raw, contract.cases[3].raw]; // differ in one middle character
    const html = render({ a, compare: b, network: 'tron' });
    expect(visualText(html)).toBe(a);
    const marked = [...html.matchAll(/<span class="address-diff diff">(.)<\/span>/g)].map((m) => m[1]);
    const mask = diffMask('tron', a, b);
    expect(marked).toEqual([...a].filter((_, i) => mask[i]));
    expect(marked).toEqual(['r']);
    // EVM compares case-insensitively: a checksum-case twin shows no difference
    const evmHtml = render({ a: EVM, compare: EVM.toLowerCase(), network: 'evm:1' });
    expect(evmHtml).not.toContain('address-diff');
    expect(visualText(evmHtml)).toBe(EVM);
  });
});
