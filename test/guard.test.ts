// Repeat-request plate and the delayed sign button (logic only).
import { findRepeat, repeatText, signGate, SIGN_DELAY_MS, REPEAT_WINDOW_MS, type RequestLike } from '../src/lib/guard';
import { assetRows, fmtAmount, totalUsd, visibleRows } from '../src/lib/portfolio';

const T0 = Date.parse('2026-11-18T10:00:00Z');
const TO = 'TKHbK1wDZkJ6VKcxKqk4TTwzQhRYbSU4A1';
const base: RequestLike = { request_id: 'awr_cur', agent_id: 'ag_1', to: TO, asset: 'USDT', amount: '5', network: 'tron', at: T0 };

describe('findRepeat (same agent, recipient, asset within 30 min)', () => {
  it('finds the latest earlier one and counts minutes from now', () => {
    const others: RequestLike[] = [
      { ...base, request_id: 'a', at: T0 - 20 * 60_000, status: 'rejected', amount: '7' },
      { ...base, request_id: 'b', at: T0 - 4 * 60_000, status: 'signed', amount: '5' },
    ];
    const h = findRepeat(base, others, T0 + 30_000)!;
    expect(h.request_id).toBe('b');
    expect(h.minutes_ago).toBe(4);
    expect(h.count).toBe(2);
    expect(repeatText(h)).toBe('Такой же перевод 4 мин назад (подписан): 5 · всего таких за 30 мин: 2');
  });
  it('ignores other agent, other recipient, other asset, other network, itself, and older than 30 min', () => {
    const others: RequestLike[] = [
      { ...base, request_id: 'x1', agent_id: 'ag_2', at: T0 - 60_000 },
      { ...base, request_id: 'x2', to: 'TKHbK1wDZkJ6VKcxKqk4TTwzQhRYbSU4A2', at: T0 - 60_000 },
      { ...base, request_id: 'x3', asset: 'TRX', at: T0 - 60_000 },
      { ...base, request_id: 'x4', network: 'evm:8453', at: T0 - 60_000 },
      { ...base, request_id: 'awr_cur', at: T0 - 60_000 },
      { ...base, request_id: 'x5', at: T0 - REPEAT_WINDOW_MS - 1 },
      { ...base, request_id: 'x6', at: T0 + 60_000 }, // arrived after the current one
    ];
    expect(findRepeat(base, others, T0)).toBeNull();
  });
  it('asset case does not matter; EVM recipients compare case-insensitively', () => {
    const evm = { ...base, network: 'evm:8453', to: '0xAbCdEf0000000000000000000000000000000001', asset: 'usdc' };
    const h = findRepeat(evm, [{ ...evm, request_id: 'p', to: evm.to.toLowerCase(), asset: 'USDC', at: T0 - 30_000 }], T0);
    expect(h?.minutes_ago).toBe(0);
    expect(repeatText(h!)).toMatch(/^Такой же перевод меньше минуты назад/);
  });
  it('a swap repeats by agent + direction; the plate says «обмен»', () => {
    const sw: RequestLike = { request_id: 's2', agent_id: 'ag_1', to: 'swap:TRX', asset: 'USDT', amount: '10 USDT', network: 'tron', at: T0, kind: 'swap' };
    const h = findRepeat(sw, [{ ...sw, request_id: 's1', at: T0 - 120_000, status: 'signed' }, { ...sw, request_id: 's0', to: 'swap:USDT', asset: 'TRX', at: T0 - 60_000 }], T0)!;
    expect(h.request_id).toBe('s1');
    expect(repeatText(h)).toBe('Такой же обмен 2 мин назад (подписан): 10 USDT');
  });
  it('no agent (own transfer) or no recipient — no plate', () => {
    expect(findRepeat({ ...base, agent_id: undefined }, [{ ...base, request_id: 'p', at: T0 - 1 }], T0)).toBeNull();
    expect(findRepeat({ ...base, to: '' }, [{ ...base, request_id: 'p', at: T0 - 1 }], T0)).toBeNull();
  });
});

describe('signGate (1.5 s + scrolled to the end)', () => {
  it('is not armed before 1.5 s even if everything fits', () => {
    const g = signGate({ openedAt: T0, now: T0 + 1_000, reachedEnd: true });
    expect(g).toEqual({ armed: false, waitMs: SIGN_DELAY_MS - 1_000, needScroll: false });
  });
  it('is armed after 1.5 s when the window fits', () => {
    expect(signGate({ openedAt: T0, now: T0 + SIGN_DELAY_MS, reachedEnd: true }).armed).toBe(true);
  });
  it('a long window needs scrolling to the end, however long one waits', () => {
    const g = signGate({ openedAt: T0, now: T0 + 60_000, reachedEnd: false });
    expect(g.armed).toBe(false);
    expect(g.needScroll).toBe(true);
    expect(signGate({ openedAt: T0, now: T0 + 60_000, reachedEnd: true }).armed).toBe(true);
  });
  it('a rebuilt view starts the delay again (new openedAt)', () => {
    expect(signGate({ openedAt: T0 + 10_000, now: T0 + 10_500, reachedEnd: true }).armed).toBe(false);
  });
});

describe('portfolio rows', () => {
  const b = { at: '', errors: [], tron: { TRX: '100.5', USDT: '12', activated: true, energy: { available: 0, limit: 0 }, bandwidth: { staked_available: 0, free_available: 600 } }, base: { USDC: '3.25', ETH: '0' } };
  it('legacy TRX quote only: TRX priced by the gateway, stablecoins and ETH without a price (no $1 peg)', () => {
    const rows = assetRows(b, { TRX: 0.3 });
    expect(rows.map((r) => [r.key, r.usd])).toEqual([['tron/TRX', 30.15], ['evm:8453/ETH', null], ['evm:8453/USDC', null], ['tron/USDT', null]]);
    expect(rows[0].price).toEqual({ usd: 0.3, source: 'x402' });
    expect(visibleRows(rows, false).map((r) => r.key)).toEqual(['tron/TRX', 'evm:8453/USDC', 'tron/USDT']);
    expect(totalUsd(rows)).toEqual({ usd: 30.15, partial: true, stale: false });
  });
  it('without any price the total is partial and no row shows $', () => {
    const rows = assetRows(b, {});
    expect(rows.find((r) => r.symbol === 'TRX')!.usd).toBeNull();
    expect(totalUsd(rows)).toEqual({ usd: 0, partial: true, stale: false });
  });
  it('formats amounts', () => {
    expect(fmtAmount('1234567.120000')).toBe('1 234 567.12');
    expect(fmtAmount('0')).toBe('0');
  });
});
