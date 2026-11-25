// Gateway: tron/estimate reports the energy split of a contract call; unknown_contract means the
// gateway priced the whole energy — the extension does not trust that cover for a call.
import { computeNeed, ProxyRoute, DirectRoute, energySplitOf, type QuoteContext } from '../src/lib/resources/plan';

const need = computeNeed({ energyNeed: 98, bandwidthNeed: 1100, energyHave: 0, bandwidthStaked: 0, bandwidthFree: 600, senderActivated: true, recipientNeedsActivation: false });
const reader = (split: Record<string, unknown>) => ({
  estimate: async () => ({ estimate: { energy: 85, ...split }, cover: { energy: 85, price_usdc: '0.111111', direct_usdc: '0.222222', direct_parts: { energy: { usdc: '0.2', amount: 65000 } }, ...split } }),
  quote: async (p: Record<string, string>) => ({ price_usdc: p.product === 'send' ? '0.333333' : '0.4' }),
});
const ctx = (): QuoteContext => ({ need, owner: 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH', kind: 'trc20', estimateBody: { transaction: { raw_data_hex: '00' } }, isCall: true });

describe('energy split of a contract call', () => {
  it('reads energy_user / energy_origin / energy_split', () => {
    expect(energySplitOf({ cover: { energy_user: 85, energy_origin: 8344, energy_total: 8429, user_percent: 1, energy_split: 'percent' } }))
      .toEqual({ energy_user: 85, energy_origin: 8344, energy_total: 8429, user_percent: 1, energy_split: 'percent' });
    expect(energySplitOf({ cover: { price_usdc: '1' } })).toBeUndefined();
  });
  it('percent: Proxy priced by cover and shows the split', async () => {
    const q = await new ProxyRoute(reader({ energy_total: 8429, energy_user: 85, energy_origin: 8344, energy_split: 'percent' })).quote(ctx());
    expect(q).toMatchObject({ ok: true, cost_usdc: '0.111111', energy: { energy_user: 85, energy_origin: 8344 } });
  });
  it('unknown_contract: cover not trusted — Proxy by quote of our own share, Direct by per-product quotes', async () => {
    const r = reader({ energy_total: 380000, energy_split: 'unknown_contract' });
    const p = await new ProxyRoute(r).quote(ctx());
    expect(p).toMatchObject({ ok: true, cost_usdc: '0.333333', energy: { energy_split: 'unknown_contract' } });
    const d = await new DirectRoute(r).quote(ctx());
    expect(d.ok).toBe(true);
    expect(d.cost_usdc).not.toBe('0.222222');
  });
});
