// EIP-1559 transactions built and signed by the extension: nonce ('pending'), gas = eth_estimateGas × 1.3
// (typical value when it cannot be estimated yet), maxFeePerGas = 2 × base fee + eth_maxPriorityFeePerGas. Before a
// signature the very serialized bytes are parsed back and compared with what was meant (chainId, to, value, data).
import { getAddress, keccak256, parseTransaction, recoverTransactionAddress, serializeTransaction, type Hex, type TransactionSerializableEIP1559 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { EvmReader } from '../net';
import { decodeCall, type Decoded } from './abi';

/** Typical gas — forecasts, and the limit when a call cannot be estimated yet (burn before approve is mined). */
export const TYPICAL_GAS = { native: 21_000n, token: 65_000n, approve: 60_000n, burn: 200_000n, burn_hook: 230_000n, mint: 200_000n, deposit_op: 150_000n, deposit_arb: 100_000n } as const;
/** When estimation is impossible the limit is the typical × this (unused gas is not charged; Arbitrum counts L1 data in gas). */
export const FALLBACK_FACTOR = 2n;

export interface FeeQuote { baseFee: bigint; priority: bigint; maxFeePerGas: bigint }
export async function feeQuote(r: EvmReader, chainId: number): Promise<FeeQuote> {
  const [blk, prio] = await Promise.all([r.rpc<any>(chainId, 'eth_getBlockByNumber', ['latest', false]), r.rpc<string>(chainId, 'eth_maxPriorityFeePerGas', []).catch(() => '0x0')]);
  const baseFee = BigInt(blk?.baseFeePerGas ?? '0x0');
  const priority = BigInt(prio ?? '0x0');
  return { baseFee, priority, maxFeePerGas: 2n * baseFee + priority };
}

export async function estimateGas(r: EvmReader, chainId: number, tx: { from: string; to: string; value?: bigint; data?: Hex }, typical: bigint): Promise<{ gas: bigint; source: 'estimate' | 'typical'; error?: string }> {
  try {
    const g = BigInt(await r.rpc<string>(chainId, 'eth_estimateGas', [{ from: tx.from, to: tx.to, value: '0x' + (tx.value ?? 0n).toString(16), data: tx.data ?? '0x' }]));
    return { gas: (g * 13n + 9n) / 10n, source: 'estimate' };
  } catch (e) {
    return { gas: typical * FALLBACK_FACTOR, source: 'typical', error: (e as Error).message };
  }
}

export const nonceOf = async (r: EvmReader, chainId: number, addr: string) => Number(BigInt(await r.rpc<string>(chainId, 'eth_getTransactionCount', [addr, 'pending'])));
export const nativeOf = async (r: EvmReader, chainId: number, addr: string) => BigInt(await r.rpc<string>(chainId, 'eth_getBalance', [addr, 'latest']));
export async function erc20Call(r: EvmReader, chainId: number, token: string, data: Hex): Promise<bigint> {
  const out = await r.rpc<string>(chainId, 'eth_call', [{ to: token, data }, 'latest']);
  if (typeof out !== 'string' || !out.startsWith('0x')) throw new Error('eth_call failed');
  return out === '0x' ? 0n : BigInt(out);
}
export const balanceOfData = (owner: string): Hex => ('0x70a08231' + owner.slice(2).toLowerCase().padStart(64, '0')) as Hex;
export const allowanceData = (owner: string, spender: string): Hex => ('0xdd62ed3e' + owner.slice(2).toLowerCase().padStart(64, '0') + spender.slice(2).toLowerCase().padStart(64, '0')) as Hex;

export interface Unsigned { chainId: number; nonce: number; to: `0x${string}`; value: bigint; data: Hex; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
export const feeOf = (u: Pick<Unsigned, 'gas' | 'maxFeePerGas'>) => u.gas * u.maxFeePerGas;

const toSerializable = (u: Unsigned): TransactionSerializableEIP1559 => ({ type: 'eip1559', chainId: u.chainId, nonce: u.nonce, to: getAddress(u.to), value: u.value, data: u.data, gas: u.gas, maxFeePerGas: u.maxFeePerGas, maxPriorityFeePerGas: u.maxPriorityFeePerGas });
export const unsignedHex = (u: Unsigned): Hex => serializeTransaction(toSerializable(u));

export interface DecodedTx { chainId: number; nonce: number; to: `0x${string}`; value: bigint; data: Hex; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; from?: `0x${string}`; call: Decoded | null; hash?: Hex }

/** Parse a type-2 transaction (signed or not); the signer is recovered when there is a signature. */
export async function decodeTx(raw: Hex): Promise<DecodedTx> {
  if (!raw.startsWith('0x02')) throw new Error('INTENT_MISMATCH: not an EIP-1559 transaction');
  const t = parseTransaction(raw) as any;
  if (t.type !== 'eip1559' || !t.to) throw new Error('INTENT_MISMATCH: type/to');
  if (t.accessList?.length) throw new Error('INTENT_MISMATCH: access list');
  const out: DecodedTx = { chainId: Number(t.chainId), nonce: Number(t.nonce ?? 0), to: getAddress(t.to), value: t.value ?? 0n, data: (t.data ?? '0x') as Hex, gas: t.gas, maxFeePerGas: t.maxFeePerGas, maxPriorityFeePerGas: t.maxPriorityFeePerGas ?? 0n, call: null };
  out.call = decodeCall(out.data);
  if (t.r !== undefined) { out.from = await recoverTransactionAddress({ serializedTransaction: raw as any }); out.hash = keccak256(raw); }
  return out;
}

/** The parsed bytes must be exactly what was meant (the same check the Signer makes, on the extension side). */
export function checkSame(d: DecodedTx, u: Unsigned): void {
  const bad = (f: string) => { throw new Error(`INTENT_MISMATCH: ${f}`); };
  if (d.chainId !== u.chainId) bad('chainId');
  if (d.to.toLowerCase() !== u.to.toLowerCase()) bad('to');
  if (d.value !== u.value) bad('value');
  if (d.data.toLowerCase() !== u.data.toLowerCase()) bad('data');
  if (d.nonce !== u.nonce) bad('nonce');
  if (d.gas !== u.gas || d.maxFeePerGas !== u.maxFeePerGas || d.maxPriorityFeePerGas !== u.maxPriorityFeePerGas) bad('fee');
}

/** Serialize → parse back → compare → sign → parse the signed bytes again (signer = our address). */
export async function signChecked(u: Unsigned, key: Hex, expectFrom: string): Promise<{ raw: Hex; hash: Hex }> {
  checkSame(await decodeTx(unsignedHex(u)), u);
  const acc = privateKeyToAccount(key);
  if (acc.address.toLowerCase() !== expectFrom.toLowerCase()) throw new Error('INTENT_MISMATCH: key is not the account');
  const raw = await acc.signTransaction(toSerializable(u));
  const d = await decodeTx(raw);
  checkSame(d, u);
  if (d.from?.toLowerCase() !== expectFrom.toLowerCase()) throw new Error('INTENT_MISMATCH: signer');
  return { raw, hash: d.hash! };
}
