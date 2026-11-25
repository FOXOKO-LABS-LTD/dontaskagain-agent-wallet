// Optional, read-only check against a TRON node (no broadcast): AW_LIVE_NODE=1 AW_LIVE_NODE_URL=https://… npx vitest run test/live-node.test.ts
// The node builds a USDT transfer; the local builder must produce the same bytes (as the self-check in e2e.mjs).
import { rawTrigger, trc20TransferData, txIdOf } from '../src/lib/tron/tx';
import { bytesToHex } from '../src/lib/bytes';
import { DirectTronReader } from '../src/lib/net';
import { accountState, estimateTrc20Energy, USDT_TRON } from '../src/lib/tron/chain';

const NODE = process.env.AW_LIVE_NODE_URL ?? ''; // a TRON node of your own (there is no built-in one)
const live = process.env.AW_LIVE_NODE === '1' && !!NODE;
const OWNER = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'; // any existing account works as the owner of a build-only call
const TO = 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH';

describe.skipIf(!live)('live node (read-only)', () => {
  it('local raw_data equals the node builder byte for byte', async () => {
    const data = trc20TransferData(TO, 1_000_000n);
    const r = await fetch(`${NODE}/wallet/triggersmartcontract`, { method: 'POST', body: JSON.stringify({ owner_address: OWNER, contract_address: USDT_TRON, function_selector: 'transfer(address,uint256)', parameter: data.slice(8), fee_limit: 30_000_000, visible: true }) }).then((x) => x.json());
    const rd = r.transaction.raw_data;
    const mine = rawTrigger({ refBytes: rd.ref_block_bytes, refHash: rd.ref_block_hash, expiration: rd.expiration, timestamp: rd.timestamp, feeLimit: rd.fee_limit, owner: OWNER, contract: USDT_TRON, dataHex: data });
    expect(bytesToHex(mine)).toBe(r.transaction.raw_data_hex);
    expect(txIdOf(mine)).toBe(r.transaction.txID);
  });
  it('reads account state and an energy estimate', async () => {
    const rd = new DirectTronReader(NODE);
    const st = await accountState(rd, OWNER);
    expect(st.exists).toBe(true);
    const e = await estimateTrc20Energy(rd, USDT_TRON, 'TKHuVq1oKVruCGLvqVexFs6dawKv6fQgFs', TO, 1n);
    console.log('energy estimate', e);
  });
});
