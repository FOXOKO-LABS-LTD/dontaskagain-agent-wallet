// Live, read-only (AW_LIVE_NODE=1 AW_LIVE_NODE_URL=https://…): a TRON node simulates the execute we build for TRX → USDT (path v4 and path
// TRX→WTRX→USDT v3). Owner = an address with TRX (the router deployer); the recipient check of the router requires
// SWEEP recipient = msg.sender, so the account is the owner itself. Nothing is signed or sent.
import { DirectTronReader } from '../src/lib/net';
import { buildCommands, executeData } from '../src/lib/swap/build';
import { swapConfig } from '../src/lib/swap/config';
import { simulateCall, contractEnergyTerms, userEnergyShare } from '../src/lib/swap/energy';
import { amountOutMin, type SunPath } from '../src/lib/swap/quote';
import q from './fixtures/sunio-quote-trx-usdt.json';

const NODE = process.env.AW_LIVE_NODE_URL ?? ''; // a TRON node of your own (there is no built-in one)
const live = process.env.AW_LIVE_NODE === '1' && !!NODE;
const OWNER = 'TU3rMHyWHzeEJBReWLzHko728hbz6MtfNg';

describe.skipIf(!live)('swap execute simulated on a TRON node (read-only)', () => {
  const c = swapConfig('mainnet');
  const r = new DirectTronReader(NODE);
  const amountIn = 10_000_000n; // 10 TRX
  for (const pick of ['v4', 'v3']) {
    it(`TRX → USDT via ${pick}`, async () => {
      const base = (q.data as SunPath[]).find((p) => p.poolVersions.includes(pick) && p.tokens.length <= 3)!;
      // the fixture quoted 100 TRX; scale the min to 10 TRX with a wide margin (price moved since)
      const out = (BigInt(base.amountOutRaw) * amountIn) / BigInt(base.amountInRaw);
      const path = { ...base, amountInRaw: amountIn.toString() };
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      const data = executeData(buildCommands({ cfg: c, path, account: OWNER, amountIn, amountOutMin: amountOutMin(out, 1000), deadline }), deadline);
      const sim = await simulateCall(r, OWNER, c.router, data, amountIn);
      const terms = await contractEnergyTerms(r, c.router);
      console.log(pick, JSON.stringify(sim), 'user share', userEnergyShare(sim.energy_total, terms), JSON.stringify(terms));
      expect(sim.ok).toBe(true);
      expect(sim.energy_total).toBeGreaterThan(0);
    }, 30_000);
  }
  it('amount_out_min above the market → the router reverts (SWEEP min is enforced)', async () => {
    const base = (q.data as SunPath[]).find((p) => p.poolVersions.includes('v4'))!;
    const out = (BigInt(base.amountOutRaw) * amountIn) / BigInt(base.amountInRaw);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const data = executeData(buildCommands({ cfg: c, path: { ...base, amountInRaw: amountIn.toString() }, account: OWNER, amountIn, amountOutMin: out * 2n, deadline }), deadline);
    const sim = await simulateCall(r, OWNER, c.router, data, amountIn);
    console.log('min×2', JSON.stringify(sim));
    expect(sim.ok).toBe(false);
  }, 30_000);
});
