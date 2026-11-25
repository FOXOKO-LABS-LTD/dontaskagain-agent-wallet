import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { utils } from 'tronweb';
import { decodeAbiParameters, encodeAbiParameters, keccak256, toHex } from 'viem';
import { tronToHex41 } from '../src/lib/tron/address';
import { bytesToHex } from '../src/lib/bytes';
import { rawTrigger, refFromBlockId, txIdOf, decodeRaw } from '../src/lib/tron/tx';
import { ABI, CMD, approveData, buildCommands, executeData, permitDomainSeparator, sectionsOf, type Command } from '../src/lib/swap/build';
import { CONTRACT_BALANCE, swapConfig } from '../src/lib/swap/config';
import { amountOutMin, deviationBps, pickPath, unsupportedReason, rateText, routeLines, type SunPath } from '../src/lib/swap/quote';
import { decodeExecute, verifyApprove, verifySwap } from '../src/lib/swap/verify';
import { userEnergyShare } from '../src/lib/swap/energy';
import { makeVectors, NOW_MS } from './helpers/swap-vectors';
import qUT from './fixtures/sunio-quote-usdt-trx.json';
import qTU from './fixtures/sunio-quote-trx-usdt.json';

const c = swapConfig('mainnet');
const UT = qUT.data as SunPath[], TU = qTU.data as SunPath[];
const VEC = 'test/fixtures/swap-vectors.json';

function oracle(raw_data: object) {
  const pb = utils.transaction.txJsonToPb({ raw_data });
  return { hex: utils.transaction.txPbToRawDataHex(pb).toLowerCase(), txID: utils.transaction.txPbToTxID(pb).replace(/^0x/, '') };
}

describe('swap: quote, amount_out_min, deviation', () => {
  it('amount_out_min rounds down; bps bounds', () => {
    expect(amountOutMin(323_476_563n, 100)).toBe(320_241_797n);   // = sun.io amountOutMinimumRaw at 100 bps
    expect(amountOutMin(30_884_754n, 100)).toBe(30_575_906n);
    expect(amountOutMin(999n, 1)).toBe(998n);                      // 998.9001 → 998
    expect(amountOutMin(1n, 50)).toBe(0n);
    expect(amountOutMin(123n, 0)).toBe(123n);
    expect(() => amountOutMin(1n, -1)).toThrow('BAD_SLIPPAGE');
    expect(() => amountOutMin(1n, 1.5)).toThrow('BAD_SLIPPAGE');
  });
  it('picks the first supported path; v1/curve/psm and unverified hooks are skipped', () => {
    expect(pickPath({ quotes: UT }, c, 'USDT', 'TRX')!.index).toBe(0);
    expect(pickPath({ quotes: TU }, c, 'TRX', 'USDT')!.index).toBe(0);
    const curve = { ...UT[1], poolVersions: ['curve_2pool', 'v2'] };
    expect(unsupportedReason(curve, c)).toBe('pool_curve_2pool');
    expect(unsupportedReason({ ...UT[0], containsUnverifiedHook: true }, c)).toBe('unverified_hook');
    expect(pickPath({ quotes: [curve, UT[1]] }, c, 'USDT', 'TRX')!.index).toBe(1);
    expect(pickPath({ quotes: UT }, c, 'TRX', 'USDT')).toBeNull();               // wrong direction
    expect(pickPath({ quotes: UT }, c, 'USDT', 'TRX', 1n)).toBeNull();          // amount differs from the intent
  });
  it('deviation from the exchange rate (USDT ≈ USD)', () => {
    // 100 TRX at 0.3087 USD = 30.87 USDT expected; quote 30.884754 is better → negative
    expect(deviationBps('TRX', 100_000_000n, 30_884_754n, '0.3087')).toBeLessThan(0);
    // 100 USDT / 0.3087 = 323.9391 TRX expected; quote 316 TRX → 245 bps worse
    expect(deviationBps('USDT', 100_000_000n, 316_000_000n, '0.3087')).toBe(245);
    expect(rateText(UT[0], 'USDT', 'TRX')).toBe('1 USDT ≈ 3.234765 TRX');
    expect(routeLines(UT[0])).toEqual([{ from: 'USDT', to: 'TRX', version: 'v4', fee_pct: '0.05' }]);
  });
  it('sections: wrap/unwrap hops are their own sections', () => {
    expect(sectionsOf(TU[0], c).map((s) => s.type)).toEqual(['wtrx', 'v3']);
    expect(sectionsOf(UT[1], c).map((s) => s.type)).toEqual(['v3', 'wtrx']);
    expect(sectionsOf(UT[2], c).map((s) => [s.type, s.hops.length])).toEqual([['v3', 2], ['wtrx', 1]]);
  });
  it('energy share of a subsidised contract (percent 1, origin limit 1 000 000)', () => {
    expect(userEnergyShare(336_018, { percent: 1, originLimit: 1_000_000, originAvailable: 10 ** 9 })).toBe(3_361);
    expect(userEnergyShare(336_018, { percent: 1, originLimit: 1_000_000, originAvailable: 0 })).toBe(336_018);
    expect(userEnergyShare(100_000, { percent: 100, originLimit: 0, originAvailable: 0 })).toBe(100_000);
    expect(userEnergyShare(100_000, { percent: 30, originLimit: 10_000_000, originAvailable: 20_000 })).toBe(80_000);
  });
});

describe('swap: Permit2 EIP-712 domain (checked on chain)', () => {
  it('DOMAIN_SEPARATOR of TTJx…uM9 with chainId 728126428', () => {
    expect(permitDomainSeparator(c)).toBe('0x14564e8c2e3290aa3b797863206f2ec2fc430355f335dfa38a1b500c9e14d789');
  });
});

describe('swap: transactions and their check', () => {
  let V: Awaited<ReturnType<typeof makeVectors>>;
  beforeAll(async () => {
    V = await makeVectors();
    if (process.env.UPDATE_VECTORS === '1' || !existsSync(VEC)) writeFileSync(VEC, JSON.stringify(V, null, 1) + '\n');
  });
  it('vectors on disk are what the builder makes (deterministic)', () => {
    expect(JSON.parse(readFileSync(VEC, 'utf8'))).toEqual(JSON.parse(JSON.stringify(V)));
    expect(V.vectors.map((v) => v.commands.join(','))).toEqual([
      '0x0a,0x12,0x04', '0x0a,0x00,0x0c,0x04', '0x0b,0x00,0x04', '0x12,0x04']);
  });
  it('approve and execute: bytes and txID equal tronweb (call_value too)', () => {
    for (const v of V.vectors) for (const s of v.steps) {
      const d = decodeRaw(s.tx.raw_data_hex);
      const value: any = { owner_address: tronToHex41(d.owner), contract_address: tronToHex41(d.contract!), data: d.data };
      if (d.callValue) value.call_value = Number(d.callValue);
      const o = oracle({ contract: [{ parameter: { value, type_url: 'type.googleapis.com/protocol.TriggerSmartContract' }, type: 'TriggerSmartContract' }],
        ref_block_bytes: d.refBytes, ref_block_hash: d.refHash, expiration: d.expiration, timestamp: d.timestamp, fee_limit: d.feeLimit });
      expect(s.tx.raw_data_hex).toBe(o.hex);
      expect(s.tx.txID).toBe(o.txID);
    }
  });
  it('every vector passes our own check', async () => {
    for (const v of V.vectors) {
      const intent = { account: v.account, asset_in: v.intent.asset_in, asset_out: v.intent.asset_out, amount_in_raw: BigInt(v.intent.amount_in_raw), amount_out_min_raw: BigInt(v.amount_out_min_raw) };
      for (const s of v.steps) {
        if (s.step === 'approve') verifyApprove(s.tx.raw_data_hex, intent, c, NOW_MS);
        else await verifySwap(s.tx.raw_data_hex, intent, c, NOW_MS);
      }
    }
  });

  // tampering: rebuild the execute of vector «trx-usdt-v4» / «usdt-trx-v4» with one thing changed
  const v4 = () => V.vectors.find((x) => x.name === 'usdt-trx-v4')!;
  const t4 = () => V.vectors.find((x) => x.name === 'trx-usdt-v4')!;
  const intentOf = (v: any) => ({ account: v.account, asset_in: v.intent.asset_in, asset_out: v.intent.asset_out, amount_in_raw: BigInt(v.intent.amount_in_raw), amount_out_min_raw: BigInt(v.amount_out_min_raw) });
  const rewrap = (v: any, fn: (cmds: Command[]) => Command[], callValue?: bigint, contract = c.router) => {
    const d = decodeRaw(v.steps.at(-1).tx.raw_data_hex);
    const ex = decodeExecute(d.data!);
    const types = ex.commands.map((x) => x.type);
    const [, inputs] = decodeAbiParameters(ABI.execute, ('0x' + d.data!.slice(8)) as `0x${string}`);
    const cmds = fn(types.map((t, i) => ({ type: t, input: inputs[i] as `0x${string}` })));
    return bytesToHex(rawTrigger({ refBytes: d.refBytes, refHash: d.refHash, expiration: d.expiration, timestamp: d.timestamp, feeLimit: d.feeLimit, owner: d.owner, contract, dataHex: executeData(cmds, ex.deadline), callValue: callValue ?? d.callValue }));
  };
  const reject = async (raw: string, v: any, what: RegExp) => { await expect(verifySwap(raw, intentOf(v), c, NOW_MS)).rejects.toThrow(what); };
  const sweep = (rcpt: string, min: bigint, token = '0x0000000000000000000000000000000000000000') => ({ type: CMD.SWEEP, input: encodeAbiParameters(ABI.sweep, [token as `0x${string}`, rcpt as `0x${string}`, min]) });

  it('refuses another SWEEP recipient, a lower min, another token', async () => {
    const v = v4();
    const evil = '0x' + 'ab'.repeat(20);
    await reject(rewrap(v, (cm) => [...cm.slice(0, -1), sweep(evil, BigInt(v.amount_out_min_raw))]), v, /SWEEP recipient/);
    const me = '0x' + tronToHex41(v.account).slice(2);
    await reject(rewrap(v, (cm) => [...cm.slice(0, -1), sweep(me, BigInt(v.amount_out_min_raw) - 1n)]), v, /amount_out_min/);
    await reject(rewrap(v, (cm) => [...cm.slice(0, -1), sweep(me, BigInt(v.amount_out_min_raw), '0x' + tronToHex41(c.wtrx).slice(2))]), v, /SWEEP token/);
  });
  it('refuses an extra command, the allow-revert flag, another router, another call_value', async () => {
    const t = t4();
    const extra = { type: CMD.SWEEP, input: encodeAbiParameters(ABI.sweep, ['0x0000000000000000000000000000000000000000', ('0x' + 'cd'.repeat(20)) as `0x${string}`, 0n]) };
    await reject(rewrap(t, (cm) => [extra, ...cm]), t, /SWEEP/);
    await reject(rewrap(t, (cm) => [{ type: 0x06, input: '0x' }, ...cm]), t, /command 0x6/);
    await reject(rewrap(t, (cm) => [{ ...cm[0], type: cm[0].type | 0x80 }, ...cm.slice(1)]), t, /allow-revert/);
    await reject(rewrap(t, (cm) => cm, undefined, 'TSJEtPuqHpvSaVnSwvCsngaeBxrGUzp95Q'), t, /Universal Router/);
    await reject(rewrap(t, (cm) => cm, BigInt(t.intent.amount_in_raw) + 1n), t, /call_value/);
  });
  it('refuses a second user payment and a wrong permit amount', async () => {
    const v = V.vectors.find((x) => x.name === 'usdt-trx-v3-unwrap')!;
    await reject(rewrap(v, (cm) => [cm[0], cm[1], cm[1], ...cm.slice(2)]), v, /second user payment|path does not continue/);
    const half = BigInt(v.intent.amount_in_raw) / 2n;
    await expect(verifySwap(v.steps[1].tx.raw_data_hex, { ...intentOf(v), amount_in_raw: half }, c, NOW_MS)).rejects.toThrow(/permit amount|amount_in/);
  });
  it('approve: spender must be Permit2 and the amount exactly amount_in', () => {
    const v = v4();
    const a = decodeRaw(v.steps[0].tx.raw_data_hex);
    const mk = (data: string) => bytesToHex(rawTrigger({ refBytes: a.refBytes, refHash: a.refHash, expiration: a.expiration, timestamp: a.timestamp, feeLimit: a.feeLimit, owner: a.owner, contract: a.contract!, dataHex: data }));
    expect(() => verifyApprove(mk(approveData(c.router, BigInt(v.intent.amount_in_raw))), intentOf(v), c, NOW_MS)).toThrow(/spender/);
    expect(() => verifyApprove(mk(approveData(c.permit2, (1n << 256n) - 1n)), intentOf(v), c, NOW_MS)).toThrow(/amount/);
    expect(() => verifyApprove(v.steps[0].tx.raw_data_hex, intentOf(v), c, NOW_MS + 3_600_000)).toThrow(/expiration/);
  });
  it('executeData has the execute selector and CONTRACT_BALANCE in later sections', () => {
    const v = V.vectors.find((x) => x.name === 'trx-usdt-wrap-v3')!;
    const ex = decodeExecute(decodeRaw(v.steps[0].tx.raw_data_hex).data!);
    expect(ex.commands[1].args[1]).toBe(CONTRACT_BALANCE);
    expect(keccak256(toHex('execute(bytes,bytes[],uint256)')).slice(2, 10)).toBe('3593564c');
    const p = buildCommands({ cfg: c, path: TU[0], account: v.account, amountIn: 1n, amountOutMin: 0n, deadline: 1n });
    expect(p.map((x) => x.type)).toEqual([CMD.WRAP_ETH, CMD.V3_SWAP_EXACT_IN, CMD.SWEEP]);
  });
});
