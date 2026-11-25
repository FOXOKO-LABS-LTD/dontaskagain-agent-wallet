// Visual groups of a full address (UI kit 1.1.1, components/ADDRESS.md + address-contract.json). Presentation only: the
// groups joined give the source string back unchanged (case included); nothing is inserted, trimmed or replaced.
// TRON: the first 4, the middle by 4, the last 4 on their own (a short group before them is allowed). EVM: «0x» + 4 hex
// (6 signs), the middle by 4, the last 4. Copy always takes the raw string (data-copy / data-address), never innerText.

export interface AddressGroups { groups: string[]; prefix: string; suffix: string }

export const SUFFIX_LEN = 4;
export const prefixLen = (raw: string): number => (/^0x/i.test(raw) ? 6 : 4);

export function groupAddress(raw: string): AddressGroups {
  const p = prefixLen(raw);
  if (raw.length <= p + SUFFIX_LEN) return { groups: raw ? [raw] : [], prefix: raw, suffix: '' };
  const prefix = raw.slice(0, p), suffix = raw.slice(raw.length - SUFFIX_LEN), mid = raw.slice(p, raw.length - SUFFIX_LEN);
  const groups = [prefix];
  for (let i = 0; i < mid.length; i += 4) groups.push(mid.slice(i, i + 4));
  groups.push(suffix);
  return { groups, prefix, suffix };
}

/**
 * The string a copy button writes to the clipboard: its data-copy exactly (no trim, no formatting). Kept separate so a
 * test can prove that the copied text is the address the transaction was built with.
 */
export function copySource(el: { dataset: DOMStringMap }): string {
  const v = el.dataset.copy ?? el.dataset.address;
  if (v === undefined) throw new Error('copy: no data-copy');
  return v;
}
