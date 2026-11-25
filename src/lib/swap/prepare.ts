// Build a swap at signing time: fresh quote → best supported path → amount_out_min → [approve] + execute,
// resources of both transactions. Signing (`signSwap`) puts the Permit2 signature in and re-checks the
// very bytes against the intent before the txIDs are signed.
import { sign } from 'viem/accounts';
import type { Hex } from 'viem';
import { formatUnits, parseUnits } from '../amount';
import { bytesToHex } from '../bytes';
import type { EvmReader, TronReader } from '../net';
import { choosePlan, computeNeed, feeLimitSun, needsPurchase, withMargin, type ResourceNeed, type ResourceRoute, type RouteChoice, type RoutePlan, type QuoteContext } from '../resources/plan';
import { normalizeTron, tronToHex41 } from '../tron/address';
import { accountState, chainParams, nowBlock, trc20Balance } from '../tron/chain';
import { bandwidthOfRaw, rawTrigger, refFromBlockId, txIdOf, type RawCommon } from '../tron/tx';
import { usdcBalance } from '../evm/erc20';
import { signTronTxId } from '../sign';
import { approveData, buildCommands, executeData, permitDigest, type PermitSingle } from './build';
import { LIMITS, swapProxyAllowed, evmHex, isSwapAsset, swapConfig, type SwapAsset, type SwapConfig, type SwapNet } from './config';
import { contractEnergyTerms, simulateCall, userEnergyShare } from './energy';
import { amountOutMin, deviationBps, pickPath, type QuoteAnswer, type Reference, type SunPath, type SwapReader } from './quote';
import { verifyApprove, verifySwap } from './verify';
import { both, t } from '../../i18n';

export const SWAP_TX_TTL_MS = 10 * 60_000;
const DUMMY_SIG = ('0x' + '00'.repeat(65)) as Hex;

export interface SwapIntent {
  asset_in: string; asset_out: string; amount_in: string; slippage_bps?: number;
  resources?: { route?: RouteChoice; payment?: { method?: string }; max_cost_usdc?: string };
}

export interface SwapStep {
  step: 'approve' | 'swap';
  raw_data_hex: string; txID: string; fee_limit_sun: number; expiration: number;
  call_value: string; contract: string;
  energy: { total: number; user: number; need: number; source: 'simulation' | 'estimate'; direct_only?: boolean };
  need: ResourceNeed; plan: RoutePlan;
}

export interface PreparedSwap {
  built_at: number; net: SwapNet; owner: string;
  asset_in: SwapAsset; asset_out: SwapAsset; amount_in: string; amount_in_raw: string; slippage_bps: number;
  quote: QuoteAnswer; path: SunPath; path_index: number;
  amount_out_raw: string; amount_out_min_raw: string;
  reference: Reference | null; deviation_bps: number | null;
  approve: { needed: boolean; spender: string; amount_raw: string; current_allowance_raw: string | null };
  permit: PermitSingle | null;
  common: RawCommon; deadline: string;
  steps: SwapStep[];
  usdc_base_micro: string | null;
  balances: { asset_in_raw: string };
  blocked: null | { reason_code: string; code: string; message: string; text?: string };
  warnings: string[];
}

async function constant(r: TronReader, owner: string, contract: string, selector: string, paramsHex: string): Promise<string> {
  const out = await r.call('triggerconstantcontract', { owner_address: owner, contract_address: contract, function_selector: selector, parameter: paramsHex, visible: true });
  const v = out?.constant_result?.[0];
  if (out?.result?.result !== true || typeof v !== 'string') throw new Error(`${selector} failed`);
  return v;
}
const word = (tron: string) => tronToHex41(tron).slice(2).padStart(64, '0');

/** ERC-20 allowance(owner, spender). */
export async function tokenAllowance(r: TronReader, token: string, owner: string, spender: string): Promise<bigint> {
  const v = await constant(r, owner, token, 'allowance(address,address)', word(owner) + word(spender));
  return v ? BigInt('0x' + v.slice(0, 64)) : 0n;
}

/** Permit2.allowance(owner, token, spender) → (amount, expiration, nonce). */
export async function permit2Allowance(r: TronReader, c: SwapConfig, owner: string, token: string): Promise<{ amount: bigint; expiration: number; nonce: number }> {
  const v = await constant(r, owner, c.permit2, 'allowance(address,address,address)', word(owner) + word(token) + word(c.router));
  return { amount: BigInt('0x' + v.slice(0, 64)), expiration: Number(BigInt('0x' + v.slice(64, 128))), nonce: Number(BigInt('0x' + v.slice(128, 192))) };
}

export async function prepareSwap(p: {
  owner: string; evmPayer?: `0x${string}`; intent: SwapIntent; tron: TronReader; evm: EvmReader | null; swap: SwapReader;
  routes: ResourceRoute[]; now?: number; net?: SwapNet;
}): Promise<PreparedSwap> {
  const now = p.now ?? Date.now();
  const c = swapConfig(p.net ?? 'mainnet');
  const owner = normalizeTron(p.owner);
  const ai = String(p.intent.asset_in).toUpperCase(), ao = String(p.intent.asset_out).toUpperCase();
  if (!isSwapAsset(ai) || !isSwapAsset(ao)) throw new Error('UNSUPPORTED_ASSET');
  if (ai === ao) throw new Error('SAME_ASSET');
  const bps = p.intent.slippage_bps ?? LIMITS.default_slippage_bps;
  if (!Number.isInteger(bps) || bps < 1 || bps > LIMITS.max_slippage_bps) throw new Error('BAD_SLIPPAGE');
  const inA = c.assets[ai];
  const amountIn = parseUnits(p.intent.amount_in, inA.decimals);
  if (amountIn <= 0n) throw new Error('BAD_AMOUNT');
  const warnings: string[] = [];

  const [blk, sender, params, quote, reference] = await Promise.all([
    nowBlock(p.tron), accountState(p.tron, owner), chainParams(p.tron),
    p.swap.quote({ asset_in: ai, asset_out: ao, amount_in_raw: amountIn.toString(), slippage_bps: bps }),
    p.swap.reference().catch(() => null),
  ]);
  const balIn = inA.native ? sender.balanceSun : await trc20Balance(p.tron, inA.address, owner);
  const picked = pickPath(quote, c, ai, ao, amountIn);
  const common: RawCommon = { ...refFromBlockId(blk.blockID), expiration: now + SWAP_TX_TTL_MS, timestamp: now };
  const deadline = BigInt(Math.floor(common.expiration / 1000));
  const base = {
    built_at: now, net: c.net, owner, asset_in: ai, asset_out: ao, amount_in: p.intent.amount_in, amount_in_raw: amountIn.toString(), slippage_bps: bps,
    quote, reference: reference ?? null, common, deadline: deadline.toString(), balances: { asset_in_raw: balIn.toString() }, warnings,
  };
  if (!picked) {
    return { ...base, path: quote.quotes?.[0] as SunPath, path_index: -1, amount_out_raw: '0', amount_out_min_raw: '0', deviation_bps: null,
      approve: { needed: false, spender: c.permit2, amount_raw: amountIn.toString(), current_allowance_raw: null }, permit: null, steps: [], usdc_base_micro: null,
      blocked: { reason_code: 'build_failed', code: 'SWAP_NO_ROUTE', ...both('blk.swapNoRouteFull') } };
  }
  const path = picked.path;
  const outRaw = BigInt(path.amountOutRaw);
  const minRaw = amountOutMin(outRaw, bps);
  let dev: number | null = null;
  if (reference && !reference.stale && reference.price_usd) { try { dev = deviationBps(ai, amountIn, outRaw, reference.price_usd); } catch { dev = null; } }

  // approve: exactly amount_in for Permit2, unless the allowance already equals amount_in
  let allowance: bigint | null = null, permit: PermitSingle | null = null;
  if (!inA.native) {
    allowance = await tokenAllowance(p.tron, inA.address, owner, c.permit2);
    const pa = await permit2Allowance(p.tron, c, owner, inA.address);
    const nowS = Math.floor(now / 1000);
    permit = { token: evmHex(inA.address), amount: amountIn, expiration: nowS + LIMITS.permit_ttl_sec, nonce: pa.nonce, spender: evmHex(c.router), sigDeadline: BigInt(nowS + LIMITS.permit_ttl_sec) };
  }
  const approveNeeded = !inA.native && allowance !== amountIn;
  const energyFee = params.getEnergyFee ?? 100;
  const steps: SwapStep[] = [];
  let blocked: PreparedSwap['blocked'] = null;

  // step: approve
  let usedE = 0, usedBw = 0;
  const planStep = async (step: 'approve' | 'swap', contract: string, data: string, callValue: bigint, energy: { total: number; source: 'simulation' | 'estimate' }) => {
    const terms = await contractEnergyTerms(p.tron, contract);
    const user = userEnergyShare(energy.total, terms);
    const need = user > 0 ? withMargin(user) : 0;
    const feeLimit = feeLimitSun(need, energyFee);
    const raw = rawTrigger({ ...common, feeLimit, owner, contract, dataHex: data, callValue });
    const n = computeNeed({
      energyNeed: need, bandwidthNeed: bandwidthOfRaw(raw), energyHave: Math.max(0, sender.energy.available - usedE),
      bandwidthStaked: Math.max(0, sender.bandwidth.staked_available - usedBw), bandwidthFree: Math.max(0, sender.bandwidth.free_available - usedBw),
      senderActivated: sender.exists || steps.length > 0, recipientNeedsActivation: false,
    });
    usedE += need; usedBw += bandwidthOfRaw(raw);
    // the swap step (router call): Direct only, priced by quotes, while the gateway sells the whole energy of the call
    const directOnly = step === 'swap' && !swapProxyAllowed();
    const ctx: QuoteContext = { need: n, owner, kind: 'trc20', estimateBody: { transaction: { raw_data_hex: bytesToHex(raw) } },
      estimated: energy.source === 'estimate', quotesOnly: directOnly, isCall: true };
    let choice = (p.intent.resources?.route ?? 'auto') as RouteChoice;
    if (directOnly && choice === 'proxy' && needsPurchase(n) && !blocked)
      blocked = { reason_code: 'resource_unavailable', code: 'RESOURCE_ROUTE_NOT_ALLOWED', ...both('blk.swapDirectOnly') };
    if (directOnly) choice = 'direct';
    const routes = p.routes.filter((r) => (choice === 'auto' || r.name === choice) && !(directOnly && r.name === 'proxy'));
    const quotes = needsPurchase(n) ? await Promise.all(routes.map((r) => r.quote(ctx))) : [];
    const plan = choosePlan(n, quotes, { choice, maxCostUsdc: p.intent.resources?.max_cost_usdc ?? null, usdcBalanceMicro: null });
    steps.push({ step, raw_data_hex: bytesToHex(raw), txID: txIdOf(raw), fee_limit_sun: feeLimit, expiration: common.expiration, call_value: callValue.toString(), contract,
      energy: { total: energy.total, user, need, source: energy.source, direct_only: directOnly }, need: n, plan });
  };

  if (approveNeeded) {
    const data = approveData(c.permit2, amountIn);
    const sim = await simulateCall(p.tron, owner, inA.address, data, 0n);
    if (!sim.ok) blocked = { reason_code: 'build_failed', code: 'SWAP_WOULD_REVERT', message: `approve: ${sim.message}` };
    await planStep('approve', inA.address, data, 0n, { total: sim.energy_total || 50_000, source: sim.ok ? 'simulation' : 'estimate' });
  }
  // step: swap — built with a placeholder Permit2 signature (same size); the real one is put in by signSwap
  const cmds = buildCommands({ cfg: c, path, account: owner, amountIn, amountOutMin: minRaw, deadline, permit: permit ? { permit, signature: DUMMY_SIG } : undefined });
  const exData = executeData(cmds, deadline);
  const callValue = inA.native ? amountIn : 0n;
  let energy: { total: number; source: 'simulation' | 'estimate' } = { total: LIMITS.swap_energy_estimate, source: 'estimate' };
  if (inA.native) {
    const sim = await simulateCall(p.tron, owner, c.router, exData, callValue);
    if (!sim.ok && !blocked) blocked = { reason_code: 'build_failed', code: 'SWAP_WOULD_REVERT', message: `swap: ${sim.message}` };
    if (sim.ok) energy = { total: sim.energy_total, source: 'simulation' };
  }
  await planStep('swap', c.router, exData, callValue, energy);
  if (energy.source === 'estimate') warnings.push(t('bg.swapEnergyEstimate'));

  // money checks
  let usdcMicro: bigint | null = null;
  if (p.evm && p.evmPayer) usdcMicro = await usdcBalance(p.evm, 8453, p.evmPayer).catch(() => null);
  const payMethod = p.intent.resources?.payment?.method ?? 'x402_base';
  const buying = steps.filter((s) => s.plan.route !== 'none');
  const quoteSum = buying.reduce((a, s) => a + parseUnits(s.plan.quote_usdc ?? '0', 6), 0n);
  const maxCost = p.intent.resources?.max_cost_usdc ? parseUnits(p.intent.resources.max_cost_usdc, 6) : null;
  if (!blocked) {
    if (balIn < amountIn) blocked = { reason_code: 'insufficient_balance', code: 'INSUFFICIENT_BALANCE', ...both('blk.balance', { asset: ai, have: formatUnits(balIn, 6), need: p.intent.amount_in }) };
    else if (buying.length && payMethod !== 'x402_base') blocked = { reason_code: 'resource_unavailable', code: 'PAYMENT_METHOD_UNAVAILABLE', ...both('blk.payMethod', { method: payMethod }) };
    else if (steps.find((s) => s.plan.blocked)) { const b = steps.find((s) => s.plan.blocked)!; blocked = { ...b.plan.blocked!, message: `${b.step}: ${b.plan.blocked!.message}`, text: `${b.step}: ${b.plan.blocked!.text ?? b.plan.blocked!.message}` }; }
    else if (maxCost !== null && quoteSum > maxCost) blocked = { reason_code: 'resource_above_max', code: 'RESOURCE_ABOVE_MAX', ...both('blk.swapResourcesAbove', { sum: formatUnits(quoteSum, 6), max: p.intent.resources!.max_cost_usdc }) };
    else if (buying.length && !p.evmPayer) blocked = { reason_code: 'resource_unavailable', code: 'RESOURCE_PAYMENT_FAILED', ...both('blk.noBasePayer') };
    else if (buying.length && usdcMicro !== null && usdcMicro < quoteSum) blocked = { reason_code: 'insufficient_balance', code: 'RESOURCE_PAYMENT_FAILED', ...both('blk.noUsdcSwap') };
  }
  // per-step ceilings must fit max_cost_usdc together: each ≤ max − the other steps' quotes
  if (maxCost !== null && !blocked) {
    for (const s of buying) {
      const others = quoteSum - parseUnits(s.plan.quote_usdc ?? '0', 6);
      const room = maxCost - others;
      for (const k of ['approved_max_usdc', 'fallback_approved_max_usdc'] as const) {
        const v = s.plan[k];
        if (v && parseUnits(v, 6) > room) s.plan[k] = formatUnits(room, 6);
      }
    }
  }
  return {
    ...base, path, path_index: picked.index, amount_out_raw: outRaw.toString(), amount_out_min_raw: minRaw.toString(), deviation_bps: dev,
    approve: { needed: approveNeeded, spender: c.permit2, amount_raw: amountIn.toString(), current_allowance_raw: allowance === null ? null : allowance.toString() },
    permit, steps, usdc_base_micro: usdcMicro === null ? null : usdcMicro.toString(), blocked,
  };
}

export interface SignedStep { step: 'approve' | 'swap'; tx: { txID: string; raw_data_hex: string; signature: string[] }; plan: RoutePlan; need: ResourceNeed }

/** Sign: Permit2 (token input), final execute bytes, our own check of both transactions, then the txIDs. */
export async function signSwap(prep: PreparedSwap, tronKey: `0x${string}`, now = Date.now()): Promise<SignedStep[]> {
  if (prep.blocked) throw new Error(`${prep.blocked.code}: ${prep.blocked.message}`);
  const c = swapConfig(prep.net);
  const amountIn = BigInt(prep.amount_in_raw), minRaw = BigInt(prep.amount_out_min_raw);
  const intent = { account: prep.owner, asset_in: prep.asset_in, asset_out: prep.asset_out, amount_in_raw: amountIn, amount_out_min_raw: minRaw };
  const out: SignedStep[] = [];
  for (const s of prep.steps) {
    let raw = s.raw_data_hex;
    if (s.step === 'swap') {
      let permit: { permit: PermitSingle; signature: Hex } | undefined;
      if (prep.permit) {
        const sig = await sign({ hash: permitDigest(c, prep.permit), privateKey: tronKey, to: 'hex' });
        permit = { permit: prep.permit, signature: sig };
      }
      const cmds = buildCommands({ cfg: c, path: prep.path, account: prep.owner, amountIn, amountOutMin: minRaw, deadline: BigInt(prep.deadline), permit });
      raw = bytesToHex(rawTrigger({ ...prep.common, feeLimit: s.fee_limit_sun, owner: prep.owner, contract: c.router, dataHex: executeData(cmds, BigInt(prep.deadline)), callValue: BigInt(s.call_value) }));
      await verifySwap(raw, intent, c, now);
    } else verifyApprove(raw, intent, c, now);
    const txID = txIdOf(Uint8Array.from(raw.match(/../g)!.map((h) => parseInt(h, 16))));
    const sig = await signTronTxId(txID, tronKey);
    out.push({ step: s.step, tx: { txID, raw_data_hex: raw, signature: [sig] }, plan: s.plan, need: s.need });
  }
  return out;
}

/** resource_plan of one step for request.sign (the same shape as transfers). */
export function stepResourcePlan(s: SignedStep, payer?: string): Record<string, unknown> {
  const plan = s.plan;
  if (plan.route === 'none') return { route: 'none', need: s.need.need };
  return {
    route: plan.route, fallback_route: plan.fallback_route, payment_method: plan.payment_method, buy: plan.buy, need: s.need.need, have: s.need.have,
    buys: Object.fromEntries(Object.entries(plan.quotes).filter(([, q]) => q?.buy).map(([k, q]) => [k, q!.buy])),
    quote_usdc: plan.quote_usdc, approved_max_usdc: plan.approved_max_usdc,
    fallback_quote_usdc: plan.fallback_route ? plan.quotes[plan.fallback_route]?.cost_usdc : undefined,
    fallback_approved_max_usdc: plan.fallback_approved_max_usdc,
    quotes: Object.fromEntries(Object.entries(plan.quotes).filter(([, q]) => q?.ok).map(([k, q]) => [k, q!.cost_usdc])),
    payer, counted_in_limit: false,
  };
}

/** `swap` block of request.sign / own.swap. */
export function swapBlock(prep: PreparedSwap): Record<string, unknown> {
  return {
    quote: { amount_out_raw: prep.amount_out_raw, amount_out_min_raw: prep.amount_out_min_raw, slippage_bps: prep.slippage_bps, fetched_at: prep.quote.fetched_at,
      symbols: prep.path.symbols, pool_versions: prep.path.poolVersions, pool_fees: prep.path.poolFees },
    reference: prep.reference && !prep.reference.stale ? { price_usd: prep.reference.price_usd, source: prep.reference.source, as_of: prep.reference.as_of ?? prep.reference.ts } : null,
  };
}
