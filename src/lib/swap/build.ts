// Universal Router calldata for one sun.io path — the same command plan as sun.io SDK TradePlanner
// (no referral, no split): [PERMIT2_PERMIT] + swap sections (recipients ADDRESS_THIS) + SWEEP(asset_out → account).
import { encodeAbiParameters, encodePacked, hashTypedData, keccak256, toHex, type Hex } from 'viem';
import { normalizeTron } from '../tron/address';
import { ADDRESS_THIS, CONTRACT_BALANCE, OPEN_DELTA, ZERO_ADDRESS, evmHex, type SwapConfig } from './config';
import type { SunPath } from './quote';

export const CMD = {
  V3_SWAP_EXACT_IN: 0x00, SWEEP: 0x04, V2_SWAP_EXACT_IN: 0x08, PERMIT2_PERMIT: 0x0a, WRAP_ETH: 0x0b, UNWRAP_WETH: 0x0c, V4_SWAP: 0x12,
} as const;
export const ACT = { CL_SWAP_EXACT_IN_SINGLE: 0x06, CL_SWAP_EXACT_IN: 0x07, SETTLE: 0x0b, TAKE: 0x0e } as const;
export const EXECUTE_SELECTOR = '3593564c'; // execute(bytes,bytes[],uint256)
export const APPROVE_SELECTOR = '095ea7b3'; // approve(address,uint256)

const P = {
  permit: [{ type: 'tuple', components: [
    { name: 'details', type: 'tuple', components: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }] },
    { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }] }, { type: 'bytes' }],
  v3: [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }],
  v2: [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address[]' }, { type: 'bool' }],
  wrap: [{ type: 'address' }, { type: 'uint256' }],
  sweep: [{ type: 'address' }, { type: 'address' }, { type: 'uint160' }],
  v4: [{ type: 'bytes' }, { type: 'bytes[]' }],
  settle: [{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }],
  take: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }],
  poolKey: { type: 'tuple', components: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'hooks', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'parameters', type: 'bytes32' }] },
  pathKey: { type: 'tuple[]', components: [{ name: 'intermediateCurrency', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'hooks', type: 'address' }, { name: 'hookData', type: 'bytes' }, { name: 'parameters', type: 'bytes32' }] },
  execute: [{ type: 'bytes' }, { type: 'bytes[]' }, { type: 'uint256' }],
} as const;
const P_SINGLE = [{ type: 'tuple', components: [{ ...P.poolKey, name: 'poolKey' }, { name: 'zeroForOne', type: 'bool' }, { name: 'amountIn', type: 'uint128' }, { name: 'amountOutMinimum', type: 'uint128' }, { name: 'hookData', type: 'bytes' }] }] as const;
const P_MULTI = [{ type: 'tuple', components: [{ name: 'currencyIn', type: 'address' }, { ...P.pathKey, name: 'path' }, { name: 'amountIn', type: 'uint128' }, { name: 'amountOutMinimum', type: 'uint128' }] }] as const;
export const ABI = { ...P, single: P_SINGLE, multi: P_MULTI };

export interface PermitSingle { token: Hex; amount: bigint; expiration: number; nonce: number; spender: Hex; sigDeadline: bigint }

// ---- Permit2 EIP-712 ----
export const PERMIT_TYPES = {
  PermitDetails: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }],
  PermitSingle: [{ name: 'details', type: 'PermitDetails' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }],
} as const;

export const permitDomain = (c: SwapConfig) => ({ name: 'Permit2', chainId: c.chainId, verifyingContract: evmHex(c.permit2) });

export function permitDigest(c: SwapConfig, p: PermitSingle): Hex {
  return hashTypedData({ domain: permitDomain(c), types: PERMIT_TYPES, primaryType: 'PermitSingle',
    message: { details: { token: p.token, amount: p.amount, expiration: p.expiration, nonce: p.nonce }, spender: p.spender, sigDeadline: p.sigDeadline } });
}

/** keccak256(abi.encode(EIP712Domain typehash, "Permit2", chainId, Permit2)) — Permit2.DOMAIN_SEPARATOR(). */
export function permitDomainSeparator(c: SwapConfig): Hex {
  const th = keccak256(toHex('EIP712Domain(string name,uint256 chainId,address verifyingContract)'));
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }], [th, keccak256(toHex('Permit2')), BigInt(c.chainId), evmHex(c.permit2)]));
}

// ---- sections (sun.io buildExecutionFromRoute) ----
type SectionType = 'v2' | 'v3' | 'v4' | 'wtrx';
interface Hop { type: SectionType; from: string; to: string; fee: number; key: SunPath['poolKeys'][number] }
export interface Section { type: SectionType; hops: Hop[]; first: boolean }

export function sectionsOf(path: SunPath, c: SwapConfig): Section[] {
  const toks = path.tokens.map(normalizeTron);
  const hops: Hop[] = path.poolVersions.map((v, i) => {
    const wrap = (toks[i] === c.trx && toks[i + 1] === c.wtrx) || (toks[i] === c.wtrx && toks[i + 1] === c.trx);
    return { type: wrap ? 'wtrx' : (v as SectionType), from: toks[i], to: toks[i + 1], fee: Number(path.poolFees?.[i] ?? 0), key: path.poolKeys?.[i] ?? null };
  });
  const out: Section[] = [];
  for (const h of hops) {
    const last = out[out.length - 1];
    if (last && last.type === h.type && h.type !== 'wtrx') last.hops.push(h);
    else out.push({ type: h.type, hops: [h], first: out.length === 0 });
  }
  return out;
}

export interface ExecuteParams {
  cfg: SwapConfig; path: SunPath; account: string; amountIn: bigint; amountOutMin: bigint; deadline: bigint;
  permit?: { permit: PermitSingle; signature: Hex };   // token input
}

export interface Command { type: number; input: Hex }

const sortPair = (a: Hex, b: Hex): [Hex, Hex] => (BigInt(a) < BigInt(b) ? [a, b] : [b, a]);

function v4Section(s: Section, p: ExecuteParams, payerIsUser: boolean, amountIn: bigint): Command {
  const acts: number[] = [], params: Hex[] = [];
  const add = (a: number, h: Hex) => { acts.push(a); params.push(h); };
  const cin = evmHex(s.hops[0].from), cout = evmHex(s.hops[s.hops.length - 1].to);
  add(ACT.SETTLE, encodeAbiParameters(ABI.settle, [cin, amountIn, payerIsUser]));
  const keyOf = (h: Hop) => {
    if (!h.key) throw new Error('V4 pool without poolKey');
    const [c0, c1] = sortPair(evmHex(h.from), evmHex(h.to));
    const params = (h.key.parameters.startsWith('0x') ? h.key.parameters : '0x' + h.key.parameters) as Hex;
    return { currency0: c0, currency1: c1, hooks: evmHex(normalizeTron(h.key.hooks)), fee: Number(h.key.fee), parameters: params };
  };
  if (s.hops.length === 1) {
    const k = keyOf(s.hops[0]);
    add(ACT.CL_SWAP_EXACT_IN_SINGLE, encodeAbiParameters(ABI.single, [{ poolKey: k, zeroForOne: cin.toLowerCase() === k.currency0.toLowerCase(), amountIn: OPEN_DELTA, amountOutMinimum: 0n, hookData: ZERO_ADDRESS }]));
  } else {
    const path = s.hops.map((h) => { const k = keyOf(h); return { intermediateCurrency: evmHex(h.to), fee: k.fee, hooks: k.hooks, hookData: ZERO_ADDRESS as Hex, parameters: k.parameters }; });
    add(ACT.CL_SWAP_EXACT_IN, encodeAbiParameters(ABI.multi, [{ currencyIn: cin, path, amountIn: OPEN_DELTA, amountOutMinimum: 0n }]));
  }
  add(ACT.TAKE, encodeAbiParameters(ABI.take, [cout, ADDRESS_THIS, OPEN_DELTA]));
  if (s.first) add(ACT.TAKE, encodeAbiParameters(ABI.take, [cin, ADDRESS_THIS, OPEN_DELTA]));
  const actions = toHex(new Uint8Array(acts));
  return { type: CMD.V4_SWAP, input: encodeAbiParameters(ABI.v4, [actions, params]) };
}

/** The command list for one supported path. */
export function buildCommands(p: ExecuteParams): Command[] {
  const c = p.cfg;
  const input = normalizeTron(p.path.tokens[0]);
  const native = input === c.trx;
  const cmds: Command[] = [];
  if (!native) {
    if (!p.permit) throw new Error('token input needs a Permit2 signature');
    const pm = p.permit.permit;
    cmds.push({ type: CMD.PERMIT2_PERMIT, input: encodeAbiParameters(ABI.permit, [{ details: { token: pm.token, amount: pm.amount, expiration: pm.expiration, nonce: pm.nonce }, spender: pm.spender, sigDeadline: pm.sigDeadline }, p.permit.signature]) });
  }
  for (const s of sectionsOf(p.path, c)) {
    const amountIn = s.first ? p.amountIn : CONTRACT_BALANCE;
    const payerIsUser = s.first && !native;
    if (s.type === 'wtrx') {
      if (s.hops[0].from === c.trx) cmds.push({ type: CMD.WRAP_ETH, input: encodeAbiParameters(ABI.wrap, [ADDRESS_THIS, amountIn]) });
      else cmds.push({ type: CMD.UNWRAP_WETH, input: encodeAbiParameters(ABI.wrap, [ADDRESS_THIS, 0n]) });
    } else if (s.type === 'v3') {
      const types: string[] = ['address'], vals: unknown[] = [evmHex(s.hops[0].from)];
      for (const h of s.hops) { types.push('uint24', 'address'); vals.push(h.fee, evmHex(h.to)); }
      cmds.push({ type: CMD.V3_SWAP_EXACT_IN, input: encodeAbiParameters(ABI.v3, [ADDRESS_THIS, amountIn, 0n, encodePacked(types, vals), payerIsUser]) });
    } else if (s.type === 'v2') {
      cmds.push({ type: CMD.V2_SWAP_EXACT_IN, input: encodeAbiParameters(ABI.v2, [ADDRESS_THIS, amountIn, 0n, [evmHex(s.hops[0].from), ...s.hops.map((h) => evmHex(h.to))], payerIsUser]) });
    } else if (s.type === 'v4') {
      cmds.push(v4Section(s, p, payerIsUser, amountIn));
    } else throw new Error('unsupported section ' + s.type);
  }
  const out = normalizeTron(p.path.tokens[p.path.tokens.length - 1]);
  cmds.push({ type: CMD.SWEEP, input: encodeAbiParameters(ABI.sweep, [evmHex(out), evmHex(normalizeTron(p.account)), p.amountOutMin]) });
  return cmds;
}

/** execute(commands, inputs, deadline) calldata hex (without 0x). */
export function executeData(cmds: Command[], deadline: bigint): string {
  const commands = toHex(new Uint8Array(cmds.map((x) => x.type)));
  return EXECUTE_SELECTOR + encodeAbiParameters(ABI.execute, [commands, cmds.map((x) => x.input), deadline]).slice(2);
}

/** approve(spender, amount) calldata hex (68 bytes). */
export function approveData(spender: string, amount: bigint): string {
  return APPROVE_SELECTOR + evmHex(spender).slice(2).padStart(64, '0') + amount.toString(16).padStart(64, '0');
}
