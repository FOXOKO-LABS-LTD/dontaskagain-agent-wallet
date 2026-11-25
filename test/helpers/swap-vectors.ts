// Deterministic swap vectors for the Signer's Go verifier (test/fixtures/swap-vectors.json): key = «abandon ×11
// about» index 0, now = 2026-11-18T12:00:00Z, fixed ref block, Permit2 nonce 0, slippage 100 bps, fee_limit 30 TRX.
import { bytesToHex } from '../../src/lib/bytes';
import { approveData, buildCommands, executeData, permitDigest, type PermitSingle } from '../../src/lib/swap/build';
import { evmHex, swapConfig, type SwapAsset } from '../../src/lib/swap/config';
import { amountOutMin, type SunPath } from '../../src/lib/swap/quote';
import { rawTrigger, refFromBlockId, txIdOf } from '../../src/lib/tron/tx';
import { signTronTxId } from '../../src/lib/sign';
import { hdAddresses, hdKeys, seedFromMnemonic } from '../../src/lib/wallet/derive';
import { sign } from 'viem/accounts';
import qUT from '../fixtures/sunio-quote-usdt-trx.json';
import qTU from '../fixtures/sunio-quote-trx-usdt.json';

export const ABOUT = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
export const NOW_MS = Date.parse('2026-11-18T12:00:00Z');
export const BLOCK_ID = '0000000004b8a1c2abcdef012345678900112233445566778899aabbccddeeff';
export const SLIPPAGE = 100;
export const FEE_LIMIT = 30_000_000;

export async function makeVectors() {
  const c = swapConfig('mainnet');
  const seed = seedFromMnemonic(ABOUT);
  const account = hdAddresses(seed, 0).tron;
  const key = hdKeys(seed, 0).tronKey;
  const common = { ...refFromBlockId(BLOCK_ID), expiration: NOW_MS + 600_000, timestamp: NOW_MS };
  const deadline = BigInt((NOW_MS + 600_000) / 1000);
  const cases: { name: string; asset_in: SwapAsset; asset_out: SwapAsset; path: SunPath; approve: boolean }[] = [
    { name: 'usdt-trx-v4', asset_in: 'USDT', asset_out: 'TRX', path: qUT.data[0] as SunPath, approve: true },
    { name: 'usdt-trx-v3-unwrap', asset_in: 'USDT', asset_out: 'TRX', path: qUT.data[1] as SunPath, approve: true },
    { name: 'trx-usdt-wrap-v3', asset_in: 'TRX', asset_out: 'USDT', path: qTU.data[0] as SunPath, approve: false },
    { name: 'trx-usdt-v4', asset_in: 'TRX', asset_out: 'USDT', path: qTU.data[2] as SunPath, approve: false },
  ];
  const out = [];
  for (const k of cases) {
    const amountIn = BigInt(k.path.amountInRaw);
    const min = amountOutMin(BigInt(k.path.amountOutRaw), SLIPPAGE);
    const native = c.assets[k.asset_in].native;
    let permit: PermitSingle | undefined, psig: `0x${string}` | undefined;
    if (!native) {
      permit = { token: evmHex(c.assets[k.asset_in].address), amount: amountIn, expiration: NOW_MS / 1000 + 1800, nonce: 0, spender: evmHex(c.router), sigDeadline: BigInt(NOW_MS / 1000 + 1800) };
      psig = await sign({ hash: permitDigest(c, permit), privateKey: key, to: 'hex' });
    }
    const steps: any[] = [];
    if (k.approve) {
      const raw = rawTrigger({ ...common, feeLimit: FEE_LIMIT, owner: account, contract: c.assets[k.asset_in].address, dataHex: approveData(c.permit2, amountIn) });
      const txID = txIdOf(raw);
      steps.push({ step: 'approve', tx: { txID, raw_data_hex: bytesToHex(raw), signature: [await signTronTxId(txID, key)] } });
    }
    const cmds = buildCommands({ cfg: c, path: k.path, account, amountIn, amountOutMin: min, deadline, permit: permit ? { permit, signature: psig! } : undefined });
    const raw = rawTrigger({ ...common, feeLimit: FEE_LIMIT, owner: account, contract: c.router, dataHex: executeData(cmds, deadline), callValue: native ? amountIn : 0n });
    const txID = txIdOf(raw);
    steps.push({ step: 'swap', tx: { txID, raw_data_hex: bytesToHex(raw), signature: [await signTronTxId(txID, key)] } });
    out.push({
      name: k.name, account, now_ms: NOW_MS,
      intent: { asset_in: k.asset_in, asset_out: k.asset_out, amount_in_raw: amountIn.toString(), slippage_bps: SLIPPAGE },
      quote_path: k.path, amount_out_raw: k.path.amountOutRaw, amount_out_min_raw: min.toString(),
      permit: permit ? { token: permit.token, amount: permit.amount.toString(), expiration: permit.expiration, sig_deadline: permit.sigDeadline.toString(), nonce: permit.nonce, spender: permit.spender, signature: psig } : null,
      commands: cmds.map((x) => '0x' + x.type.toString(16).padStart(2, '0')),
      steps,
    });
  }
  return { comment: 'swap vectors built by test/helpers/swap-vectors.ts; regenerate: UPDATE_VECTORS=1 npx vitest run test/swap.test.ts',
    router: c.router, permit2: c.permit2, wtrx: c.wtrx, chain_id: c.chainId, vectors: out };
}
