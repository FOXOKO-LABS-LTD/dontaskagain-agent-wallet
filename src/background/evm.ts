// EVM in the service worker: EVM transfers (agent `transfer` on evm:<id> and the human's own.submit), the
// CCTP v2 bridge (agent `bridge` / own.bridge: approve? + burn with one button, then bridge.mint signed under the
// approval) and refuel (agent `refuel` / own.refuel: ETH from Ethereum to an L2 by the native bridge).
// Every transaction is built here, parsed back and checked against the intent before the key touches it.
import { formatEther, formatGwei, getAddress, isAddress, type Hex } from 'viem';
import { formatUnits, parseUnits } from '../lib/amount';
import { randomId } from '../lib/bytes';
import { getJSON } from '../lib/net';
import type { EvmReader } from '../lib/net';
import { approveData, burnData, depositEthData, depositETHData, receiveMessageData, transferData } from '../lib/evm/abi';
import { bridgePlan, parseMessage, verifyMessage, type BridgeFees } from '../lib/evm/cctp';
import { assetOf, evmNet, requireNet, shortName, usdcOf, type EvmNet } from '../lib/evm/networks';
import { allowanceData, balanceOfData, decodeTx, erc20Call, estimateGas, feeOf, feeQuote, nativeOf, nonceOf, signChecked, TYPICAL_GAS, unsignedHex, type DecodedTx, type FeeQuote, type Unsigned } from '../lib/evm/tx';
import { verifyApproveTx, verifyBurnTx, verifyMintTx, verifyRefuelTx, verifyTransferTx } from '../lib/evm/verify';
import { bookMatch } from '../lib/similar';
import { ownEntries, recipientCheck } from '../lib/ownAccounts';
import type { BridgeQuoteView, BridgeView, EvmTxLine, EvmView, GasCheck, PreparedView } from '../shared/api';
import { PRODUCT_NAME, agentCheckOf, assertOwnAllowed, decide, plaintextClosedFor, liveSigned, markOwnLocal, markSigned, sendSigned, notify, ownSubmit, putRequest, readers, sameIntent, updateBadge } from './requests';
import { buildIdOf } from '../lib/buildId';
import type { BridgeApprovalRec } from '../lib/wallet/model';
import type { SignedRec } from './store';
import { checkAttestation } from '../lib/evm/cctp';
import { isE2EId } from './e2e';
import { currentSession, signerUrl, socket } from './signer';
import { getPublic, getSession, patchSession } from './store';
import { accountKeys, isUnlocked, requireUnlocked, updateVault } from './wallet';
import { both, t as tr } from '../i18n';

export const REBUILD_AFTER_MS = 30_000;
type Kind = 'agent' | 'own';
type Delivery = 'auto' | 'self' | 'forwarding';

export interface TransferIn { network: string; asset: string; to: string; amount: string }
export interface RefuelIn { from_network: string; to_network: string; amount_eth: string }
export interface BridgeIn { asset: string; from_network: string; to_network: string; amount: string; mode: 'fast' | 'standard'; delivery: Delivery }

interface BuiltTx { step: NonNullable<EvmTxLine['step']>; u: Unsigned }
interface Prepared {
  key: string; kind: Kind; type: 'transfer' | 'refuel' | 'bridge'; account_id: string; from: `0x${string}`;
  intent: TransferIn | RefuelIn | BridgeIn; request?: any; txs: BuiltTx[]; view: PreparedView; built_at: number;
  bridge?: { plan: ReturnType<typeof bridgePlan>; fees: BridgeFees; delivery: 'self' | 'forwarding'; dst: EvmNet; src: EvmNet };
  refuel?: { l2_before: string | null };
}
const prepared = new Map<string, Prepared>();

const gwei = (v: bigint) => formatGwei(v).replace(/(\.\d{4})\d+$/, '$1');
const nat = (v: bigint, n: EvmNet) => formatUnits(v, n.native.decimals, 8);

export function bridgeReader() {
  return {
    fees: (from: string, to: string): Promise<BridgeFees> => {
      const s = currentSession();
      if (!s) throw new Error('NO_SESSION: not signed in to the Signer');
      return getJSON(`${signerUrl()}/v1/ext/bridge/fees?${new URLSearchParams({ from_network: from, to_network: to })}`, { Authorization: `Bearer ${s}` });
    },
  };
}

// ---------- helpers ----------
function gasCheck(n: EvmNet, need: bigint, have: bigint, fee: bigint): GasCheck {
  const cap = parseUnits(n.max_fee_native, n.native.decimals);
  return { network: n.network, native: n.native.symbol, need_native: nat(need, n), have_native: nat(have, n), ok: have >= need, fee_max_native: nat(fee, n), max_fee_native: n.max_fee_native, above_max: fee > cap };
}
function gasBlock(g: GasCheck): PreparedView['blocked'] {
  return { reason_code: 'insufficient_gas', code: 'INSUFFICIENT_GAS', ...both('blk.noGas', { native: g.native, net: shortName(g.network), need: g.need_native, have: g.have_native }),
    detail: { network: g.network, need_native: g.need_native, have_native: g.have_native, native: g.native } };
}
/** 0.3.2: a fee above the network's ceiling (max_fee_native) blocks — gas prices come from the RPC/relay. */
function feeBlock(g: GasCheck, net: string): PreparedView['blocked'] {
  return { reason_code: 'unsafe', code: 'FEE_ABOVE_MAX', ...both('blk.feeAboveMax', { net, fee: g.fee_max_native, sym: g.native, max: g.max_fee_native }), detail: { network: g.network, fee_max_native: g.fee_max_native, max_fee_native: g.max_fee_native } };
}
const refuelHintFor = (network: string) => (evmNet(network)?.refuel ? { to_network: network } : null);

function lineOf(step: BuiltTx['step'], u: Unsigned, from: string, n: EvmNet, d: DecodedTx, labels: Record<string, string>): EvmTxLine {
  const c = d.call;
  const args: { k: string; v: string }[] = [];
  let method = tr('bg.nativeTransfer', { sym: n.native.symbol });
  if (c && c.fn !== 'none') {
    method = c.fn;
    for (const [k, v] of Object.entries(c)) if (k !== 'fn') args.push({ k, v: typeof v === 'bigint' ? v.toString() : String(v) });
  }
  return { step, network: n.network, chain_id: n.chain_id, from, to: d.to, to_label: labels[d.to.toLowerCase()] ?? '', value: nat(d.value, n), native: n.native.symbol, method, args,
    nonce: d.nonce, gas: u.gas.toString(), gas_source: 'estimate', max_fee_per_gas_gwei: gwei(u.maxFeePerGas), fee_max_native: nat(feeOf(u), n) };
}

/** The agent check of an agent's request (unknown / revoked / unbound / type not allowed → blocked). */
async function agentCheck(kind: Kind, key: string, request: any, vault: any, accountId: string): Promise<{ agent?: PreparedView['agent']; blocked: PreparedView['blocked'] }> {
  if (kind !== 'agent') return { blocked: null };
  return agentCheckOf(key, request, vault, accountId);
}

/** the id of exactly this build (the view + the unsigned bytes of every transaction). */
function stamp(p: Prepared): Prepared {
  p.view.build_id = buildIdOf(p.view, p.txs.map((t) => unsignedHex(t.u)));
  return p;
}

async function account(accountId: string) {
  const { pub, vault } = await requireUnlocked();
  const acc = pub.accounts.find((a) => a.id === accountId && !a.removed_at);
  if (!acc?.addresses.evm) throw new Error('UNKNOWN_ACCOUNT');
  return { acc, vault, from: getAddress(acc.addresses.evm) };
}

async function mkTx(r: EvmReader, n: EvmNet, f: FeeQuote, from: string, nonce: number, to: string, value: bigint, data: Hex, typical: bigint, estimate = true): Promise<{ u: Unsigned; source: 'estimate' | 'typical' }> {
  const g = estimate ? await estimateGas(r, n.chain_id, { from, to, value, data }, typical) : { gas: typical * 2n, source: 'typical' as const };
  return { u: { chainId: n.chain_id, nonce, to: getAddress(to), value, data, gas: g.gas, maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.priority > f.maxFeePerGas ? f.maxFeePerGas : f.priority }, source: g.source };
}

// ---------- transfer ----------
async function buildTransfer(kind: Kind, key: string, accountId: string, it: TransferIn, request?: any): Promise<Prepared> {
  const { acc, vault, from } = await account(accountId);
  const n = requireNet(it.network);
  const a = assetOf(it.network, it.asset);
  if (!isAddress(it.to, { strict: false })) throw new Error('INVALID_ADDRESS');
  if (/[a-f]/.test(it.to.slice(2)) && /[A-F]/.test(it.to.slice(2)) && !isAddress(it.to, { strict: true })) throw new Error('INVALID_ADDRESS: bad EIP-55 checksum');
  const to = getAddress(it.to);
  if (to === from) throw new Error('SELF_TRANSFER');
  const amount = parseUnits(it.amount, a.decimals);
  if (amount <= 0n) throw new Error('BAD_AMOUNT');
  const r = (await readers()).evm;
  const [f, nonce, native, tokenBal] = await Promise.all([feeQuote(r, n.chain_id), nonceOf(r, n.chain_id, from), nativeOf(r, n.chain_id, from),
    a.native ? Promise.resolve(null) : erc20Call(r, n.chain_id, a.address!, balanceOfData(from))]);
  const t = a.native ? await mkTx(r, n, f, from, nonce, to, amount, '0x', TYPICAL_GAS.native) : await mkTx(r, n, f, from, nonce, a.address!, 0n, transferData(to, amount), TYPICAL_GAS.token);
  const d = await decodeTx(unsignedHex(t.u));
  verifyTransferTx(d, { chainId: n.chain_id, to, amount, token: a.address });
  const fee = feeOf(t.u);
  const gas = gasCheck(n, fee + (a.native ? amount : 0n), native, fee);
  const warnings: string[] = [];
  const ac = await agentCheck(kind, key, request, vault, accountId);
  let blocked = ac.blocked;
  const have = a.native ? native : tokenBal!;
  if (!blocked && have < amount) blocked = { reason_code: 'insufficient_balance', code: 'INSUFFICIENT_BALANCE', ...both('blk.onBalance', { amount: formatUnits(have, a.decimals), sym: a.symbol }) };
  if (!blocked && !gas.ok) blocked = gasBlock(gas);
  if (t.source === 'typical') warnings.push(tr('bg.gasTypical'));
  if (!blocked && gas.above_max) blocked = feeBlock(gas, n.name); // the network ceiling is a limit, not a hint
  const match = bookMatch(it.network, to, vault.address_book);
  const pubNow = await getPublic();
  const rc = recipientCheck({ network: it.network, address: to, own: ownEntries(pubNow?.accounts ?? [], vault.secrets, it.network), book: vault.address_book, history: vault.recipients, cfg: vault.global.similar,
    firstTime: !vault.recipients.some((x: any) => x.network.startsWith('evm') && x.address.toLowerCase() === to.toLowerCase()) });
  const { similar, first_time: firstTime } = rc;
  const line = lineOf('transfer', t.u, from, n, d, a.address ? { [a.address.toLowerCase()]: tr('bg.fromList', { sym: a.symbol }) } : {});
  line.gas_source = t.source;
  const ev: EvmView = { kind: 'transfer', network: n.network, network_name: n.name, asset: a.symbol, amount: formatUnits(amount, a.decimals), to, token: a.address, txs: [line], gas };
  const view: PreparedView = {
    key, kind, agent: ac.agent, account: { id: acc.id, name: acc.name, tron: acc.addresses.tron, evm: from },
    network: n.network, type: 'transfer', reason: request?.reason, expires_at: request?.expires_at, created_at: request?.created_at,
    to_check: { in_book: match ? { label: match.label, id: match.id } : undefined, ...(rc.own ? { own: rc.own } : {}), similar, first_time: firstTime },
    evm: ev, blocked, warnings, built_at: Date.now(), refuel_hint: blocked?.code === 'INSUFFICIENT_GAS' ? refuelHintFor(n.network) : null,
  };
  const p: Prepared = { key, kind, type: 'transfer', account_id: accountId, from, intent: it, request, txs: [{ step: 'transfer', u: t.u }], view, built_at: view.built_at };
  prepared.set(key, stamp(p));
  return p;
}

// ---------- refuel ----------
async function buildRefuel(kind: Kind, key: string, accountId: string, it: RefuelIn, request?: any): Promise<Prepared> {
  const { acc, vault, from } = await account(accountId);
  const warnings: string[] = [];
  const ac = await agentCheck(kind, key, request, vault, accountId);
  const l1 = requireNet('evm:1');
  const dst = evmNet(it.to_network);
  const base: PreparedView = { key, kind, agent: ac.agent, account: { id: acc.id, name: acc.name, tron: acc.addresses.tron, evm: from }, network: 'evm:1', type: 'refuel',
    reason: request?.reason, expires_at: request?.expires_at, created_at: request?.created_at, blocked: ac.blocked, warnings, built_at: Date.now() };
  if (it.from_network && it.from_network !== 'evm:1') throw new Error('UNSUPPORTED_NETWORK: refuel goes from evm:1 only');
  if (!dst?.refuel) {
    base.blocked = { reason_code: 'build_failed', code: 'REFUEL_UNSUPPORTED', ...(dst?.network === 'evm:137' ? both('blk.refuelPolygon') : both('blk.refuelUnsupported', { net: it.to_network })) };
    const p: Prepared = { key, kind, type: 'refuel', account_id: accountId, from, intent: it, request, txs: [], view: base, built_at: base.built_at };
    prepared.set(key, stamp(p));
    return p;
  }
  const rf = dst.refuel;
  const amount = parseUnits(it.amount_eth, 18);
  if (amount <= 0n) throw new Error('BAD_AMOUNT');
  const r = (await readers()).evm;
  const [f, nonce, native, code, l2] = await Promise.all([feeQuote(r, 1), nonceOf(r, 1, from), nativeOf(r, 1, from), r.rpc(1, 'eth_getCode', [from, 'latest']) as Promise<string>,
    nativeOf(r, dst.chain_id, from).catch(() => null)]);
  const data = rf.kind === 'op_stack' ? depositETHData(rf.min_gas_limit ?? 200_000) : depositEthData();
  const t = await mkTx(r, l1, f, from, nonce, rf.l1_contract, amount, data, rf.kind === 'op_stack' ? TYPICAL_GAS.deposit_op : TYPICAL_GAS.deposit_arb);
  const d = await decodeTx(unsignedHex(t.u));
  verifyRefuelTx(d, { kind: rf.kind, l1Contract: rf.l1_contract, amount, minGasLimit: rf.min_gas_limit });
  const fee = feeOf(t.u);
  const gas = gasCheck(l1, fee + amount, native, fee);
  let blocked = base.blocked;
  if (!blocked && code && code !== '0x') blocked = { reason_code: 'build_failed', code: 'REFUEL_UNSUPPORTED', ...both('blk.refuel7702') };
  if (!blocked && !gas.ok) blocked = gasBlock(gas);
  if (!blocked && gas.above_max) blocked = feeBlock(gas, l1.name);
  const line = lineOf('refuel', t.u, from, l1, d, { [rf.l1_contract.toLowerCase()]: rf.kind === 'op_stack' ? `L1StandardBridge ${dst.name}` : 'Arbitrum Inbox' });
  line.gas_source = t.source;
  base.evm = { kind: 'refuel', network: 'evm:1', network_name: l1.name, asset: 'ETH', amount: formatUnits(amount, 18), to: from, txs: [line], gas,
    refuel: { to_network: dst.network, to_name: dst.name, kind: rf.kind, l1_contract: rf.l1_contract, eta_sec: rf.eta_sec, l2_balance: l2 === null ? null : nat(l2, dst) } };
  base.blocked = blocked;
  const p: Prepared = { key, kind, type: 'refuel', account_id: accountId, from, intent: it, request, txs: [{ step: 'refuel', u: t.u }], view: base, built_at: base.built_at, refuel: { l2_before: l2 === null ? null : l2.toString() } };
  prepared.set(key, stamp(p));
  return p;
}

// ---------- bridge ----------
const MINT_TYPICAL = TYPICAL_GAS.mint;

async function bridgeCore(accountId: string, it: BridgeIn) {
  if (it.asset !== 'USDC') throw new Error('UNSUPPORTED_ASSET: bridge carries USDC only');
  if (it.from_network === it.to_network) throw new Error('SAME_NETWORK');
  const src = requireNet(it.from_network), dst = requireNet(it.to_network);
  if (!src.cctp || !dst.cctp) throw new Error('UNSUPPORTED_NETWORK: no CCTP');
  const { from } = await account(accountId);
  const amount = parseUnits(it.amount, 6);
  if (amount <= 0n) throw new Error('BAD_AMOUNT');
  const r = (await readers()).evm;
  const [fees, dstFee, dstNative, usdc] = await Promise.all([bridgeReader().fees(src.network, dst.network), feeQuote(r, dst.chain_id), nativeOf(r, dst.chain_id, from),
    erc20Call(r, src.chain_id, usdcOf(src.network).address, balanceOfData(from)).catch(() => null)]);
  const mintFee = MINT_TYPICAL * 13n / 10n * dstFee.maxFeePerGas;
  const dstGas = gasCheck(dst, mintFee, dstNative, mintFee);
  let delivery: 'self' | 'forwarding' = it.delivery === 'forwarding' ? 'forwarding' : 'self';
  let reason = it.delivery === 'auto' ? '' : tr('bg.deliveryChosen');
  if (it.delivery === 'auto') { delivery = dstGas.ok ? 'self' : 'forwarding'; reason = dstGas.ok ? tr('bg.deliveryHasGas', { sym: dst.native.symbol, net: shortName(dst.network) }) : tr('bg.deliveryNoGas', { sym: dst.native.symbol, net: shortName(dst.network) }); }
  const plan = bridgePlan({ amount, mode: it.mode, srcFast: !!src.cctp.fast, forwarding: delivery === 'forwarding', fees: fees.fees });
  const q: BridgeQuoteView = {
    ok: true, from_network: src.network, to_network: dst.network, amount: formatUnits(amount, 6), receive_at_least: formatUnits(amount, 6), burn: formatUnits(plan.burn, 6),
    max_fee: formatUnits(plan.max_fee, 6), protocol_fee: formatUnits(plan.protocol, 6), forward_fee: formatUnits(plan.forward_fee_micro, 6),
    mode_effective: plan.mode_effective, finality_threshold: plan.finality_threshold, minimum_fee_bps: plan.minimum_fee_bps, delivery, delivery_reason: reason,
    eta_sec: plan.mode_effective === 'fast' ? src.cctp.eta_fast_sec ?? src.cctp.eta_standard_sec : src.cctp.eta_standard_sec,
    fees_fetched_at: fees.fetched_at, usdc_balance: usdc === null ? null : formatUnits(usdc, 6), dst_gas: dstGas,
  };
  let qAgent: string | undefined; // q.message for the agent (q.message itself is the human's)
  if (usdc !== null && usdc < plan.burn) { q.ok = false; q.code = 'INSUFFICIENT_BALANCE'; ({ message: qAgent, text: q.message } = both('blk.bridgeBalance', { net: shortName(src.network), have: q.usdc_balance, burn: q.burn })); }
  if (it.delivery === 'self' && !dstGas.ok) { q.ok = false; q.code = 'INSUFFICIENT_GAS'; ({ message: qAgent, text: q.message } = both('blk.bridgeNoGas', { sym: dst.native.symbol, net: shortName(dst.network) })); }
  return { src, dst, from, amount, plan, fees, delivery, q, qAgent, r, usdc, dstGas };
}

export async function bridgeQuote(accountId: string, it: BridgeIn): Promise<BridgeQuoteView> {
  try { return (await bridgeCore(accountId, it)).q; } catch (e) {
    const m = (e as Error).message;
    return { ok: false, code: m.split(':')[0], message: m } as BridgeQuoteView;
  }
}

async function buildBridge(kind: Kind, key: string, accountId: string, it: BridgeIn, request?: any): Promise<Prepared> {
  const { acc, vault } = await account(accountId);
  const c = await bridgeCore(accountId, it);
  const { src, dst, from, plan, r } = c;
  const warnings: string[] = [];
  const ac = await agentCheck(kind, key, request, vault, accountId);
  const usdc = usdcOf(src.network).address;
  const tm = src.cctp!.token_messenger;
  const [f, nonce, native, allowance] = await Promise.all([feeQuote(r, src.chain_id), nonceOf(r, src.chain_id, from), nativeOf(r, src.chain_id, from), erc20Call(r, src.chain_id, usdc, allowanceData(from, tm))]);
  const needApprove = allowance !== plan.burn;
  const txs: BuiltTx[] = [];
  const lines: EvmTxLine[] = [];
  const labels = { [usdc.toLowerCase()]: `USDC ${src.name}`, [tm.toLowerCase()]: 'CCTP TokenMessengerV2' };
  let n0 = nonce;
  if (needApprove) {
    const t = await mkTx(r, src, f, from, n0++, usdc, 0n, approveData(tm, plan.burn), TYPICAL_GAS.approve);
    const d = await decodeTx(unsignedHex(t.u));
    verifyApproveTx(d, { chainId: src.chain_id, token: usdc, spender: tm, amount: plan.burn });
    txs.push({ step: 'approve', u: t.u }); const l = lineOf('approve', t.u, from, src, d, labels); l.gas_source = t.source; lines.push(l);
  }
  const fwd = c.delivery === 'forwarding';
  const bd = burnData({ amount: plan.burn, destinationDomain: dst.cctp!.domain, mintRecipient: from, burnToken: usdc, maxFee: plan.max_fee, minFinalityThreshold: plan.finality_threshold, forwarding: fwd });
  const bt = await mkTx(r, src, f, from, n0, tm, 0n, bd, fwd ? TYPICAL_GAS.burn_hook : TYPICAL_GAS.burn, !needApprove);
  const bdec = await decodeTx(unsignedHex(bt.u));
  verifyBurnTx(bdec, { chainId: src.chain_id, tokenMessenger: tm, burnToken: usdc, recipient: from, dstDomain: dst.cctp!.domain, burn: plan.burn, maxFee: plan.max_fee, finality: plan.finality_threshold, forwarding: fwd });
  txs.push({ step: 'burn', u: bt.u }); const bl = lineOf('burn', bt.u, from, src, bdec, labels); bl.gas_source = bt.source; lines.push(bl);
  const fee = txs.reduce((a, t) => a + feeOf(t.u), 0n);
  const gas = gasCheck(src, fee, native, fee);
  let blocked = ac.blocked;
  if (!blocked && !c.q.ok) blocked = c.q.code === 'INSUFFICIENT_GAS'
    ? { ...gasBlock(c.dstGas)!, detail: { ...gasBlock(c.dstGas)!.detail, alternatives: [{ delivery: 'forwarding' }] } }
    : { reason_code: 'insufficient_balance', code: c.q.code ?? 'BUILD_FAILED', message: c.qAgent ?? c.q.message ?? '', text: c.q.message ?? '' };
  if (!blocked && !gas.ok) blocked = gasBlock(gas);
  if (!blocked && gas.above_max) blocked = feeBlock(gas, src.name);
  if (it.mode === 'fast' && plan.mode_effective === 'standard') warnings.push(tr('bg.noFastCctp', { net: src.name }));
  const bv: BridgeView = { ...c.q, from_name: src.name, to_name: dst.name, mode: it.mode, delivery_requested: it.delivery, recipient: from,
    approve: { needed: needApprove, spender: tm, amount: formatUnits(plan.burn, 6), current_allowance: formatUnits(allowance, 6) }, steps: lines, gas,
    mint: { by: fwd ? 'circle' : 'wallet', network: dst.network, message_transmitter: dst.cctp!.message_transmitter } };
  const view: PreparedView = { key, kind, agent: ac.agent, account: { id: acc.id, name: acc.name, tron: acc.addresses.tron, evm: from }, network: src.network, type: 'bridge',
    reason: request?.reason, expires_at: request?.expires_at, created_at: request?.created_at, bridge: bv, blocked, warnings, built_at: Date.now(),
    refuel_hint: blocked?.code === 'INSUFFICIENT_GAS' ? refuelHintFor(String(blocked.detail?.network ?? '')) : null };
  const p: Prepared = { key, kind, type: 'bridge', account_id: accountId, from, intent: it, request, txs, view, built_at: view.built_at, bridge: { plan, fees: c.fees, delivery: c.delivery, src, dst } };
  prepared.set(key, stamp(p));
  return p;
}

// ---------- entry points: prepare ----------
export const intentOfTransfer = (req: any): TransferIn => ({ network: String(req.network), asset: String(req.intent?.asset ?? ''), to: String(req.intent?.to ?? ''), amount: String(req.intent?.amount ?? '') });
export const intentOfRefuel = (req: any): RefuelIn => ({ from_network: String(req.intent?.from_network ?? req.network ?? 'evm:1'), to_network: String(req.intent?.to_network ?? ''), amount_eth: String(req.intent?.amount_eth ?? '') });
export const intentOfBridge = (req: any): BridgeIn => ({ asset: String(req.intent?.asset ?? 'USDC'), from_network: String(req.intent?.from_network ?? req.network), to_network: String(req.intent?.to_network ?? ''),
  amount: String(req.intent?.amount ?? ''), mode: req.intent?.mode === 'standard' ? 'standard' : 'fast', delivery: (['self', 'forwarding'].includes(req.intent?.delivery) ? req.intent.delivery : 'auto') as Delivery });

function build(kind: Kind, key: string, accountId: string, type: Prepared['type'], intent: any, request?: any): Promise<Prepared> {
  if (type === 'transfer') return buildTransfer(kind, key, accountId, intent, request);
  if (type === 'refuel') return buildRefuel(kind, key, accountId, intent, request);
  return buildBridge(kind, key, accountId, intent, request);
}

/** An agent's request handled here: transfer on evm:<id>, bridge, refuel. */
export const isEvmRequest = (req: any) => req.type === 'bridge' || req.type === 'refuel' || (req.type === 'transfer' && /^evm:\d+$/.test(String(req.network)));

export async function prepareEvmRequest(id: string, req: any, accountId: string): Promise<PreparedView> {
  const type = req.type as Prepared['type'];
  const intent = type === 'transfer' ? intentOfTransfer(req) : type === 'refuel' ? intentOfRefuel(req) : intentOfBridge(req);
  return (await build('agent', id, accountId, type, intent, req)).view;
}
// 0.3.3: the human's own forms are refused before any read with content when nothing could be signed
export async function evmPrepare(accountId: string, it: TransferIn): Promise<PreparedView> { await assertOwnAllowed(); return (await build('own', randomId('own'), accountId, 'transfer', it)).view; }
export async function refuelPrepare(accountId: string, to_network: string, amount_eth: string): Promise<PreparedView> {
  await assertOwnAllowed();
  return (await build('own', randomId('ref'), accountId, 'refuel', { from_network: 'evm:1', to_network, amount_eth })).view;
}
export async function bridgePrepare(accountId: string, it: BridgeIn): Promise<PreparedView> { await assertOwnAllowed(); return (await build('own', randomId('brg'), accountId, 'bridge', it)).view; }

// ---------- signing ----------
/**
 * 0.3.2: only the build the window shows (its build_id) is signed. Another build, none, or one older than
 * 30 s → a new build is made and shown; a rebuilt transaction is never signed without being seen (that also
 * ends the silent ×1.5 fee drift of 0.3.1).
 */
async function signPrepared(p: Prepared, addressChecked: boolean, buildId: string | undefined): Promise<{ status: 'changed'; view: PreparedView } | { status: 'signed'; cur: Prepared; raws: { step: string; raw: Hex; hash: Hex }[] }> {
  if (!buildId || buildId !== p.view.build_id || Date.now() - p.built_at > REBUILD_AFTER_MS) {
    const next = await build(p.kind, p.key, p.account_id, p.type, p.intent, p.request);
    return { status: 'changed', view: next.view };
  }
  const cur = p;
  const v = cur.view;
  if (v.blocked) throw new Error(`${v.blocked.code}: ${v.blocked.text ?? v.blocked.message}`);
  if (cur.type === 'transfer' && !v.to_check?.in_book && v.to_check?.first_time && !addressChecked) throw new Error(`ADDRESS_NOT_CHECKED: ${tr('bg.tickAddressChecked')}`);
  const { account: a, keys } = await accountKeys(cur.account_id);
  if (getAddress(a.addresses.evm!) !== cur.from) throw new Error('INTENT_MISMATCH: owner');
  const raws = [];
  for (const t of cur.txs) raws.push({ step: t.step, ...(await signChecked(t.u, keys.evmKey, cur.from)) });
  return { status: 'signed', cur, raws };
}

function bridgeMeta(p: Prepared) {
  const b = p.bridge!;
  return { delivery: b.delivery, mode_effective: b.plan.mode_effective, finality_threshold: b.plan.finality_threshold, burn_amount_raw: b.plan.burn.toString(), max_fee_raw: b.plan.max_fee.toString(),
    fees: { minimum_fee_bps: b.plan.minimum_fee_bps, forward_fee_micro: b.plan.forward_fee_micro.toString(), fetched_at: b.fees.fetched_at ?? new Date().toISOString() } };
}

/**
 * What the mint step may carry — kept per bridge (parent request id) in the encrypted vault (it
 * survives a browser restart, and a mint without it is never signed).
 */
export type BridgeApproval = BridgeApprovalRec;
const BRIDGE_KEEP_MS = 14 * 86_400_000;
export const MAX_MINT_SIGNS = 3; // one mint request per bridge; re-signs only for gas retries of that same request

async function rememberBridge(parent: string, p: Prepared): Promise<void> {
  const b = p.bridge!;
  const cap = parseUnits(b.dst.max_fee_native, b.dst.native.decimals).toString();
  const a: BridgeApproval = { parent, account_id: p.account_id, recipient: p.from, src: b.src.network, dst: b.dst.network, burn_raw: b.plan.burn.toString(), delivery: b.delivery, gas_cap_wei: cap, created_at: Date.now() };
  await updateVault((vault) => {
    const all = { ...(vault.bridge_approvals ?? {}) };
    for (const [k, x] of Object.entries(all)) if (Date.now() - x.created_at > BRIDGE_KEEP_MS) delete all[k];
    all[parent] = a;
    vault.bridge_approvals = all;
  });
}

async function rememberRecipient(to: string): Promise<void> {
  await updateVault((vault) => {
    if (vault.recipients.some((x) => x.network === 'evm:*' && x.address.toLowerCase() === to.toLowerCase())) return false;
    vault.recipients.push({ network: 'evm:*', address: to, at: new Date().toISOString() });
    if (vault.recipients.length > 500) vault.recipients.shift();
  });
}

/** Agent request: request.sign — {signed} for transfer/refuel, {bridge, steps} for a bridge. */
export async function signEvmRequest(id: string, e: { request: any }, addressChecked: boolean, buildId?: string, rec?: SignedRec): Promise<{ status: string; view?: PreparedView; resent?: boolean }> {
  const req = e.request;
  if (await plaintextClosedFor(id)) throw new Error('E2E_DOWNGRADE: plaintext is closed'); // (also checked by signRequest)
  // what was signed for this request is re-sent as is (same nonce) — never a second transaction
  let r2 = rec;
  if (!r2) {
    const p = prepared.get(id);
    if (!p || !sameIntent(p.request, req)) {
      const next = await build('agent', id, req.account.id, req.type, req.type === 'transfer' ? intentOfTransfer(req) : req.type === 'refuel' ? intentOfRefuel(req) : intentOfBridge(req), req);
      return { status: 'changed', view: next.view };
    }
    const r = await signPrepared(p, addressChecked, buildId);
    if (r.status === 'changed') return r;
    const pub = await getPublic();
    const decision = { by: 'human', rule: null, wallet_doc_version: pub?.doc_version ?? 0 };
    const net = r.cur.view.network;
    if (r.cur.type === 'bridge') await rememberBridge(id, r.cur); // before the ack: bridge.mint may follow much later, after a worker restart
    const body = r.cur.type === 'bridge'
      ? { request_id: id, decision, bridge: bridgeMeta(r.cur), steps: r.raws.map((x) => ({ step: x.step, signed: { network: net, raw: x.raw } })) }
      : { request_id: id, decision, signed: { network: net, raw: r.raws[0].raw } };
    r2 = { key: id, kind: 'request', type: r.cur.type, network: net, at: Date.now(), txids: r.raws.map((x) => x.hash), agent_id: req.agent?.id, account_id: r.cur.account_id,
      to: r.cur.type === 'transfer' ? getAddress((r.cur.intent as TransferIn).to) : undefined, view: r.cur.view, body };
  }
  const rr = r2;
  await sendSigned(rr, () => decide('request.sign', rr.body));
  await markSigned(id, req);
  if (rr.type === 'transfer' && rr.to) await rememberRecipient(rr.to);
  return { status: 'signed', ...(rec ? { resent: true } : {}) };
}

/** The human's own operation: own.submit (transfer), own.refuel, own.bridge. */
export async function evmSign(key: string, addressChecked: boolean, buildId?: string): Promise<{ status: string; view?: PreparedView; request_id?: string }> {
  const p = prepared.get(key);
  if (!p) throw new Error('NOT_FOUND: prepare again');
  // after an unanswered own.* the same signed transaction (same nonce) goes again, never a second one
  let rec = await liveSigned(key);
  if (!rec) {
    const r = await signPrepared(p, addressChecked, buildId);
    if (r.status === 'changed') return r;
    const net = r.cur.view.network;
    let type: string, intent: any, body: any;
    if (r.cur.type === 'transfer') {
      const it = r.cur.intent as TransferIn;
      intent = { asset: r.cur.view.evm!.asset, to: getAddress(it.to), amount: r.cur.view.evm!.amount };
      type = 'own.submit'; body = { account: p.account_id, network: net, signed: { network: net, raw: r.raws[0].raw }, summary: `${intent.asset} ${intent.amount} → ${intent.to} (${shortName(net)})`, intent };
    } else if (r.cur.type === 'refuel') {
      const it = r.cur.intent as RefuelIn;
      intent = { from_network: 'evm:1', to_network: it.to_network, amount_eth: r.cur.view.evm!.amount };
      type = 'own.refuel'; body = { account: p.account_id, network: 'evm:1', intent, signed: { network: 'evm:1', raw: r.raws[0].raw } };
    } else {
      const it = r.cur.intent as BridgeIn;
      intent = { asset: 'USDC', from_network: it.from_network, to_network: it.to_network, amount: r.cur.view.bridge!.amount, mode: it.mode, delivery: it.delivery };
      type = 'own.bridge'; body = { account: p.account_id, network: net, intent, bridge: bridgeMeta(r.cur), steps: r.raws.map((x) => ({ step: x.step, signed: { network: net, raw: x.raw } })) };
    }
    rec = { key, kind: 'own', type: r.cur.type, own_type: type, network: net, at: Date.now(), txids: r.raws.map((x) => x.hash), account_id: p.account_id, to: intent.to, body };
  }
  const rr = rec;
  const ack: any = await sendSigned(rr, () => ownSubmit(rr.own_type!, rr.body));
  const rid: string | undefined = ack?.request_id ?? ack?.request?.request_id;
  if (rid) {
    if (p.type === 'bridge') await rememberBridge(rid, p);
    const { pub } = await requireUnlocked();
    const acc = pub.accounts.find((a) => a.id === p.account_id);
    await putRequest({ request_id: rid, own: true, type: p.type, network: rr.network, status: ack.request?.status && ack.request.status !== 'pending' ? ack.request.status : 'signed',
      account: { id: p.account_id, name: acc?.name ?? '' }, intent: rr.body.intent, created_at: new Date().toISOString() });
    await markOwnLocal(rid);
  }
  prepared.delete(key);
  if (p.type === 'transfer') await rememberRecipient((p.intent as TransferIn).to);
  return { status: 'submitted', request_id: rid };
}

// ---------- bridge.mint ----------
export interface MintMsg { id?: string; request_id: string; parent_request_id: string; network: string; message: Hex; attestation: Hex; message_transmitter: string; amount_raw?: string; recipient?: string; expiration_block?: string }

/**
 * Expected message fields: only from the approval of a bridge THIS wallet signed (0.3.2). No approval → no
 * mint (the old «any message to our own address» fallback let a Signer spend our gas with made-up mints). One mint
 * request per bridge, signed at most MAX_MINT_SIGNS times (gas retries of that request). Since 0.3.3 it runs only
 * inside the mint queue; the mint id is bound in the vault as it is now; a bridge with Circle forwarding has no mint here.
 */
async function expectFor(m: MintMsg) {
  const dst = requireNet(m.network);
  const waitE2E = await isE2EId(m.parent_request_id); // an own E2E bridge writes its approval a moment after it starts
  let { vault } = await requireUnlocked();
  for (let i = 0; i < 20 && waitE2E && !vault.bridge_approvals?.[m.parent_request_id]; i++) { await new Promise((r) => setTimeout(r, 100)); ({ vault } = await requireUnlocked()); }
  let a!: BridgeApprovalRec;
  await updateVault((v) => {
    const cur = v.bridge_approvals?.[m.parent_request_id];
    if (!cur) throw new Error('INTENT_MISMATCH: no bridge of this wallet for this mint');
    if (cur.delivery === 'forwarding') throw new Error('INTENT_MISMATCH: this bridge is delivered by Circle forwarding — the wallet signs no mint for it');
    if (cur.dst !== m.network) throw new Error('INTENT_MISMATCH: mint network');
    if (cur.mint_id && cur.mint_id !== m.request_id) throw new Error('INTENT_MISMATCH: this bridge already has its mint');
    if ((cur.mint_signs ?? 0) >= MAX_MINT_SIGNS) throw new Error('INTENT_MISMATCH: the mint of this bridge was signed too many times');
    a = { ...cur };
    if (cur.mint_id) return false;
    cur.mint_id = m.request_id; a.mint_id = m.request_id;
  });
  const src = requireNet(a.src);
  return { a, src, dst, accountId: a.account_id, recipient: a.recipient, amount: BigInt(a.burn_raw), forwarding: false, cap: BigInt(a.gas_cap_wei) };
}

/** counted (and the nonce pinned) in the vault BEFORE the signature leaves; refused when the limit is reached. */
async function countMintSign(parent: string, mintId: string, nonce: number): Promise<void> {
  await updateVault((vault) => {
    const a = vault.bridge_approvals?.[parent];
    if (!a || a.mint_id !== mintId) throw new Error('INTENT_MISMATCH: the mint binding changed');
    if ((a.mint_signs ?? 0) >= MAX_MINT_SIGNS) throw new Error('INTENT_MISMATCH: the mint of this bridge was signed too many times');
    if (a.mint_nonce !== undefined && a.mint_nonce !== nonce) throw new Error('INTENT_MISMATCH: mint nonce');
    a.mint_signs = (a.mint_signs ?? 0) + 1;
    a.mint_nonce = nonce;
  });
}

/** 0.3.3: every bridge.mint (from the Signer, the retry tick, the E2E executor) runs one at a time. */
let mintChain: Promise<unknown> = Promise.resolve();
function inMintQueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = mintChain.then(fn, fn);
  mintChain = run.catch(() => {});
  return run;
}

async function keepMint(m: MintMsg, why: string): Promise<void> {
  const s = await getSession();
  const all = (s as any).pendingMints ?? {};
  // bounded (a locked wallet cannot check a mint yet; the Signer sends it again)
  if (!(m.request_id in all) && (Object.keys(all).length >= 20 || JSON.stringify(m).length > 16_384)) { console.warn('[agent-wallet] mint not kept (limit)'); return; }
  await patchSession({ pendingMints: { ...((s as any).pendingMints ?? {}), [m.request_id]: { ...m, why, at: Date.now() } } } as any);
}
async function dropMint(id: string): Promise<void> {
  const s = await getSession();
  const all = { ...((s as any).pendingMints ?? {}) };
  if (!(id in all)) return;
  delete all[id];
  await patchSession({ pendingMints: all } as any);
}

/** S→E bridge.mint: verify, build receiveMessage, sign under the bridge approval (no second window). */
export async function onBridgeMint(m: MintMsg): Promise<'signed' | 'waiting_unlock' | 'insufficient_gas' | 'refused'> {
  if (m.id) socket.ack(m.id, true);
  return inMintQueue(() => mintOne(m));
}

async function mintOne(m: MintMsg): Promise<'signed' | 'waiting_unlock' | 'insufficient_gas' | 'refused'> {
  if (!(await isUnlocked())) {
    await keepMint(m, 'locked');
    notify(`mint:${m.request_id}`, PRODUCT_NAME, tr('bg.mintLocked'));
    return 'waiting_unlock';
  }
  let e: Awaited<ReturnType<typeof expectFor>>;
  try {
    e = await expectFor(m);
    if (m.message_transmitter.toLowerCase() !== e.dst.cctp!.message_transmitter.toLowerCase()) throw new Error('INTENT_MISMATCH: message_transmitter');
    verifyMessage(parseMessage(m.message), { srcDomain: e.src.cctp!.domain, dstDomain: e.dst.cctp!.domain, tokenMessenger: e.src.cctp!.token_messenger, burnToken: usdcOf(e.src.network).address,
      recipient: e.recipient, amount: e.amount, forwarding: e.forwarding });
    await checkAttestation(m.message, m.attestation);
  } catch (err) {
    await dropMint(m.request_id);
    await decide('request.reject', { request_id: m.request_id, reason_code: 'unsafe', detail: { step: 'mint', message: (err as Error).message } }).catch(() => {});
    return 'refused';
  }
  const r = (await readers()).evm;
  const dst = e.dst;
  const data = receiveMessageData(m.message, m.attestation);
  const [f, nonce0, native] = await Promise.all([feeQuote(r, dst.chain_id), nonceOf(r, dst.chain_id, e.recipient), nativeOf(r, dst.chain_id, e.recipient)]);
  const nonce = e.a.mint_nonce ?? nonce0; // a re-sign reuses the first mint's nonce — only one can ever land
  const t = await mkTx(r, dst, f, e.recipient, nonce, dst.cctp!.message_transmitter, 0n, data, MINT_TYPICAL);
  if (t.source !== 'estimate') {
    // receiveMessage that cannot even be estimated would revert — refuse instead of paying gas for it
    await dropMint(m.request_id);
    await decide('request.reject', { request_id: m.request_id, reason_code: 'unsafe', detail: { step: 'mint', message: 'MINT_SIMULATION_FAILED: eth_estimateGas of receiveMessage failed' } }).catch(() => {});
    return 'refused';
  }
  const fee = feeOf(t.u);
  if (native < fee || fee > e.cap) {
    const g = gasCheck(dst, fee, native, fee);
    await keepMint(m, 'gas');
    await decide('request.reject', { request_id: m.request_id, reason_code: 'insufficient_gas', detail: { step: 'mint', network: dst.network, need_native: g.need_native, have_native: g.have_native, native: g.native, above_cap: fee > e.cap } }).catch(() => {});
    notify(`mint:${m.request_id}`, PRODUCT_NAME, tr('bg.mintNoGas', { sym: dst.native.symbol, net: dst.name }));
    return 'insufficient_gas';
  }
  const d = await decodeTx(unsignedHex(t.u));
  verifyMintTx(d, { chainId: dst.chain_id, messageTransmitter: dst.cctp!.message_transmitter, message: m.message, attestation: m.attestation });
  const { keys, account: a } = await accountKeys(e.accountId);
  if (getAddress(a.addresses.evm!) !== getAddress(e.recipient)) throw new Error('INTENT_MISMATCH: account');
  try { await countMintSign(m.parent_request_id, m.request_id, nonce); }
  catch (err) {
    await dropMint(m.request_id);
    await decide('request.reject', { request_id: m.request_id, reason_code: 'unsafe', detail: { step: 'mint', message: (err as Error).message } }).catch(() => {});
    return 'refused';
  }
  const s = await signChecked(t.u, keys.evmKey, e.recipient);
  const pub = await getPublic();
  // the human approved the bridge; this signature is the extension's under that approval (not «by human»)
  await decide('request.sign', { request_id: m.request_id, decision: { by: 'extension', rule: 'bridge_approval', wallet_doc_version: pub?.doc_version ?? 0 }, signed: { network: dst.network, raw: s.raw } });
  await dropMint(m.request_id);
  return 'signed';
}

/** Retry what waits (unlock, reconnect, the 30 s tick). */
let draining = false;
export async function drainPendingMints(): Promise<void> {
  if (draining || !socket.connected || !(await isUnlocked())) return;
  draining = true;
  try {
    const s = await getSession();
    const list = Object.values(((s as any).pendingMints ?? {}) as Record<string, MintMsg & { at: number; why: string }>);
    for (const m of list) {
      if (m.why === 'gas' && Date.now() - m.at < 25_000) continue;
      await onBridgeMint({ ...m, id: undefined }).catch((e) => console.warn('[agent-wallet] mint', (e as Error).message));
    }
  } finally { draining = false; }
}

/** request.update of a mint step that is no longer pending — forget it. */
export async function onMintUpdate(m: { request_id: string; status?: string }): Promise<void> {
  if (m.status && m.status !== 'pending') await dropMint(m.request_id);
}

export { formatEther };
