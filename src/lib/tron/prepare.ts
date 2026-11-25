// Build a TRON `transfer` (TRX or USDT) from an intent at signing time and plan the resources.
import { formatUnits, parseUnits } from '../amount';
import { bytesToHex } from '../bytes';
import type { EvmReader, TronReader } from '../net';
import { choosePlan, computeNeed, feeLimitSun, withMargin, type ResourceNeed, type ResourceRoute, type RouteChoice, type RoutePlan, type QuoteContext } from '../resources/plan';
import { normalizeTron } from './address';
import { accountState, chainParams, estimateTrc20Energy, nowBlock, trc20Balance, USDT_TRON } from './chain';
import { bandwidthOfRaw, decodeRaw, rawTransferTrx, rawTrigger, refFromBlockId, trc20TransferData, txIdOf, type DecodedTx } from './tx';
import { usdcBalance } from '../evm/erc20';
import { both } from '../../i18n';

export const TX_TTL_MS = 10 * 60_000;       // expiration = build + 10 min
export const ENERGY_FALLBACK_HOLDER = 64_285;   // USDT to a holder (if the node cannot simulate)
export const ENERGY_FALLBACK_NEW = 130_285;     // USDT to an address without USDT

export interface TransferIntent { asset: string; to: string; amount: string; resources?: { route?: RouteChoice; payment?: { method?: string }; max_cost_usdc?: string } }

export interface PreparedTron {
  built_at: number;
  owner: string; to: string; asset: 'TRX' | 'USDT'; amount: string; amount_raw: string;
  raw_data_hex: string; txID: string; decoded: DecodedTx;
  fee_limit_sun: number;
  need: ResourceNeed; plan: RoutePlan;
  balances: { trx_sun: string; usdt_raw: string; usdc_base_micro: string | null };
  energy_source: 'node' | 'fallback' | 'none';
  /** non-null: cannot be signed (reject code for request.reject) */
  blocked: null | { reason_code: string; code: string; message: string; text?: string };
}

export async function prepareTronTransfer(p: {
  owner: string; evmPayer?: `0x${string}`; intent: TransferIntent;
  tron: TronReader; evm: EvmReader | null; routes: ResourceRoute[]; now?: number;
}): Promise<PreparedTron> {
  const now = p.now ?? Date.now();
  const owner = normalizeTron(p.owner);
  const to = normalizeTron(p.intent.to);
  const asset = p.intent.asset.toUpperCase();
  if (asset !== 'TRX' && asset !== 'USDT') throw new Error('UNSUPPORTED_ASSET');
  if (owner === to) throw new Error('SELF_TRANSFER');
  const amountRaw = parseUnits(p.intent.amount, 6);
  if (amountRaw <= 0n) throw new Error('BAD_AMOUNT');
  const payMethod = p.intent.resources?.payment?.method ?? 'x402_base';

  const [blk, sender, recipient, params] = await Promise.all([nowBlock(p.tron), accountState(p.tron, owner), accountState(p.tron, to), chainParams(p.tron)]);
  const ref = refFromBlockId(blk.blockID);
  const common = { ...ref, expiration: now + TX_TTL_MS, timestamp: now };
  let usdtRaw = 0n;
  let energyNeed = 0, energySource: PreparedTron['energy_source'] = 'none', feeLimit = 0;
  let raw: Uint8Array;
  if (asset === 'USDT') {
    usdtRaw = await trc20Balance(p.tron, USDT_TRON, owner);
    const est = await estimateTrc20Energy(p.tron, USDT_TRON, owner, to, amountRaw);
    let base = est;
    if (base === null) {
      const rcv = await trc20Balance(p.tron, USDT_TRON, to).catch(() => 0n);
      base = rcv > 0n ? ENERGY_FALLBACK_HOLDER : ENERGY_FALLBACK_NEW;
      energySource = 'fallback';
    } else energySource = 'node';
    energyNeed = withMargin(base);
    feeLimit = feeLimitSun(energyNeed, params.getEnergyFee ?? 100);
    raw = rawTrigger({ ...common, feeLimit, owner, contract: USDT_TRON, dataHex: trc20TransferData(to, amountRaw) });
  } else {
    raw = rawTransferTrx({ ...common, owner, to, amountSun: amountRaw });
  }
  const decoded = decodeRaw(bytesToHex(raw));
  const need = computeNeed({
    energyNeed, bandwidthNeed: bandwidthOfRaw(raw), energyHave: sender.energy.available,
    bandwidthStaked: sender.bandwidth.staked_available, bandwidthFree: sender.bandwidth.free_available,
    senderActivated: sender.exists, recipientNeedsActivation: asset === 'TRX' && !recipient.exists,
  });

  let usdcMicro: bigint | null = null;
  if (p.evm && p.evmPayer) usdcMicro = await usdcBalance(p.evm, 8453, p.evmPayer).catch(() => null);

  const ctx: QuoteContext = {
    need, owner, recipient: to, kind: asset === 'TRX' ? 'trx' : 'trc20',
    estimateBody: asset === 'USDT'
      ? { trc20_transfer: { owner, token: USDT_TRON, to, amount: amountRaw.toString() } }
      : { trx_transfer: { owner, to, amount_sun: Number(amountRaw) } },
  };
  const choice = (p.intent.resources?.route ?? 'auto') as RouteChoice;
  const quotes = needPurchase(need) ? await Promise.all(p.routes.filter((r) => choice === 'auto' || r.name === choice).map((r) => r.quote(ctx))) : [];
  const plan = choosePlan(need, quotes, { choice, maxCostUsdc: p.intent.resources?.max_cost_usdc ?? null, usdcBalanceMicro: usdcMicro });

  let blocked: PreparedTron['blocked'] = null;
  if (asset === 'TRX' && sender.balanceSun < amountRaw) blocked = { reason_code: 'insufficient_balance', code: 'INSUFFICIENT_BALANCE', ...both('blk.balance', { asset: 'TRX', have: formatUnits(sender.balanceSun, 6), need: p.intent.amount }) };
  else if (asset === 'USDT' && usdtRaw < amountRaw) blocked = { reason_code: 'insufficient_balance', code: 'INSUFFICIENT_BALANCE', ...both('blk.balance', { asset: 'USDT', have: formatUnits(usdtRaw, 6), need: p.intent.amount }) };
  else if (plan.route !== 'none' && payMethod !== 'x402_base') blocked = { reason_code: 'resource_unavailable', code: 'PAYMENT_METHOD_UNAVAILABLE', ...both('blk.payMethod', { method: payMethod }) };
  else if (plan.blocked) blocked = plan.blocked;
  else if (plan.route !== 'none' && !p.evmPayer) blocked = { reason_code: 'resource_unavailable', code: 'RESOURCE_PAYMENT_FAILED', ...both('blk.noBasePayer') };

  return {
    built_at: now, owner, to, asset: asset as 'TRX' | 'USDT', amount: p.intent.amount, amount_raw: amountRaw.toString(),
    raw_data_hex: bytesToHex(raw), txID: txIdOf(raw), decoded, fee_limit_sun: feeLimit, need, plan,
    balances: { trx_sun: sender.balanceSun.toString(), usdt_raw: usdtRaw.toString(), usdc_base_micro: usdcMicro === null ? null : usdcMicro.toString() },
    energy_source: energySource, blocked,
  };
}

const needPurchase = (n: ResourceNeed) => n.deficit.energy > 0 || n.deficit.bandwidth > 0 || n.activate.sender || n.activate.recipient;

/** Before signing: the decoded bytes must say exactly what the intent says (our own check, the same rules as the Signer's). */
export function checkDecodedAgainstIntent(d: DecodedTx, prep: PreparedTron): void {
  if (d.owner !== prep.owner) throw new Error('INTENT_MISMATCH: owner');
  if (prep.asset === 'TRX') {
    if (d.type !== 'TransferContract' || d.to !== prep.to || d.amountSun?.toString() !== prep.amount_raw) throw new Error('INTENT_MISMATCH: TRX transfer');
  } else {
    if (d.type !== 'TriggerSmartContract' || d.contract !== USDT_TRON || !d.trc20 || d.trc20.to !== prep.to || d.trc20.amountRaw.toString() !== prep.amount_raw || (d.callValue ?? 0n) !== 0n) throw new Error('INTENT_MISMATCH: USDT transfer');
    if (d.feeLimit > 100_000_000) throw new Error('INTENT_MISMATCH: fee_limit');
  }
}
