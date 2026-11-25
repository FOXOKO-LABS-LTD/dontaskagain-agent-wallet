import { findSimilar, bookMatch, diffMask, groups4, networkCovers } from '../src/lib/similar';

const book = [
  { id: 'ab_1', label: 'Склад USDT', network: 'tron', address: 'TKHbK1wMSczfEFuSSgXBvz5RkH3tcmSU4A' },
  { id: 'ab_2', label: 'Подрядчик', network: 'evm:*', address: '0x3214aBcD000000000000000000000000Ee49b67C' },
];

describe('similar addresses', () => {
  it('same prefix after T, different address → hit', () => {
    const h = findSimilar('tron', 'TKHbKZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ', book);
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ label: 'Склад USDT', same_prefix: true, same_suffix: false, source: 'book' });
  });
  it('same suffix → hit; exact match → no hit (it is the address itself)', () => {
    expect(findSimilar('tron', 'TQQQQQQQQQQQQQQQQQQQQQQQQQQQQQSU4A', book)[0]).toMatchObject({ same_suffix: true });
    expect(findSimilar('tron', book[0].address, book)).toHaveLength(0);
  });
  it('EVM: case-insensitive, evm:* entry applies to every EVM network, not to TRON', () => {
    expect(findSimilar('evm:42161', '0x3214abcd111111111111111111111111111111ff', book)).toHaveLength(1);
    expect(findSimilar('evm:8453', '0x9999999999999999999999999999999999A9B67c', book)[0]).toMatchObject({ same_suffix: true });
    expect(findSimilar('tron', 'T3214ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ', book)).toHaveLength(0);
    expect(findSimilar('evm:1', '0x3214ABCD000000000000000000000000EE49B67C', book)).toHaveLength(0); // same address, other case
    expect(bookMatch('evm:1', '0x3214ABCD000000000000000000000000EE49B67C', book)?.id).toBe('ab_2');
    expect(networkCovers('evm:*', 'tron')).toBe(false);
  });
  it('history recipients count too; config prefix/suffix', () => {
    const h = findSimilar('tron', 'TAAAAAAAAAAAAAAAAAAAAAAAAAAAAAXYZ1', [], [{ network: 'tron', address: 'TBBBBBBBBBBBBBBBBBBBBBBBBBBBBBXYZ1' }]);
    expect(h[0].source).toBe('history');
    expect(findSimilar('tron', 'TKHbKZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ', book, [], { prefix: 5, suffix: 4 })).toHaveLength(0);
  });
  it('diff mask and groups', () => {
    expect(diffMask('tron', 'TKHbX', 'TKHbY')).toEqual([false, false, false, false, true]);
    expect(diffMask('evm:1', '0xAb', '0xaB')).toEqual([false, false, false, false]);
    expect(groups4('TKHbK1wMSczf')).toEqual(['TKHb', 'K1wM', 'Sczf']);
  });
});
