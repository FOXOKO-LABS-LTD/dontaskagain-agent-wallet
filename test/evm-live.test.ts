// Live, read-only (AW_LIVE_EVM=1): the built-in EVM list against the chains through public RPC — chain id,
// token symbol/decimals, CCTP v2 contracts (bytecode, localDomain), L1 bridges (bytecode); eth_estimateGas of an
// approve to TokenMessengerV2 built by our builder; Iris fees Ethereum → Base go through our fee formula.
// Nothing is signed or sent. (In the product every read goes through the Signer relay.)
import { approveData } from '../src/lib/evm/abi';
import { bridgePlan } from '../src/lib/evm/cctp';
import { servedNets } from '../src/lib/evm/networks';

const live = process.env.AW_LIVE_EVM === '1';
const RPC: Record<number, string> = { 1: 'https://ethereum-rpc.publicnode.com', 42161: 'https://arbitrum-one-rpc.publicnode.com', 10: 'https://optimism-rpc.publicnode.com', 137: 'https://polygon-bor-rpc.publicnode.com', 8453: 'https://base-rpc.publicnode.com' };
async function rpc(c: number, method: string, params: unknown[]) {
  const r = await fetch(RPC[c], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(JSON.stringify(j.error)); return j.result;
}
const str = (h: string) => { const b = Buffer.from(h.slice(2), 'hex'); return b.subarray(64, 64 + Number(BigInt('0x' + b.subarray(32, 64).toString('hex')))).toString(); };

describe.skipIf(!live)('EVM built-in list on chain (read-only)', () => {
  for (const n of servedNets()) {
    it(`${n.name}: chain id, tokens, CCTP`, async () => {
      expect(parseInt(await rpc(n.chain_id, 'eth_chainId', []), 16)).toBe(n.chain_id);
      for (const t of n.tokens) {
        expect(Number(BigInt(await rpc(n.chain_id, 'eth_call', [{ to: t.address, data: '0x313ce567' }, 'latest'])))).toBe(t.decimals);
        expect(str(await rpc(n.chain_id, 'eth_call', [{ to: t.address, data: '0x95d89b41' }, 'latest']))).toMatch(t.symbol === 'USDT' ? /USD/ : /^USDC$/);
      }
      expect((await rpc(n.chain_id, 'eth_getCode', [n.cctp!.token_messenger, 'latest'])).length).toBeGreaterThan(100);
      expect(Number(BigInt(await rpc(n.chain_id, 'eth_call', [{ to: n.cctp!.message_transmitter, data: '0x8d3638f4' }, 'latest'])))).toBe(n.cctp!.domain);
      if (n.refuel) expect((await rpc(1, 'eth_getCode', [n.refuel.l1_contract, 'latest'])).length).toBeGreaterThan(100);
      const usdc = n.tokens.find((t) => t.symbol === 'USDC')!;
      const g = BigInt(await rpc(n.chain_id, 'eth_estimateGas', [{ from: '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23', to: usdc.address, data: approveData(n.cctp!.token_messenger, 1_000_000n) }]));
      expect(g).toBeGreaterThan(20_000n);
    });
  }
  it('Iris fees Ethereum → Base through the formula', async () => {
    const fees = await (await fetch('https://iris-api.circle.com/v2/burn/USDC/fees/0/6?forward=true')).json();
    const p = bridgePlan({ amount: 1_000_000n, mode: 'fast', srcFast: true, forwarding: true, fees });
    expect(p.finality_threshold).toBe(1000);
    expect(p.max_fee).toBeGreaterThan(p.forward_fee_micro);
  });
});
