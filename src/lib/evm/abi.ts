// Calldata of the few calls the wallet builds: ERC-20 transfer/approve, CCTP v2 depositForBurn(WithHook) and
// receiveMessage, L1→L2 deposits (OP-stack L1StandardBridge.depositETH, Arbitrum Inbox.depositEth). Decoders return null
// for anything else — the extension signs only what it can read back.
import { decodeFunctionData, encodeFunctionData, getAddress, pad, parseAbi, type Hex } from 'viem';

export const ABI = parseAbi([
  'function transfer(address to, uint256 amount)',
  'function approve(address spender, uint256 amount)',
  'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)',
  'function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)',
  'function receiveMessage(bytes message, bytes attestation)',
  'function depositETH(uint32 minGasLimit, bytes extraData)',
  'function depositEth()',
]);

/** Circle Forwarding hook, version 0 without data: "cctp-forward" + 20 zero bytes. */
export const CCTP_FORWARD_HOOK: Hex = '0x636374702d666f72776172640000000000000000000000000000000000000000';
export const ZERO32: Hex = '0x0000000000000000000000000000000000000000000000000000000000000000';
export const bytes32Of = (addr: string): Hex => pad(addr.toLowerCase() as Hex, { size: 32 });
export const addrOf32 = (b: string): `0x${string}` => getAddress('0x' + b.slice(-40));

export const transferData = (to: string, amount: bigint) => encodeFunctionData({ abi: ABI, functionName: 'transfer', args: [getAddress(to), amount] });
export const approveData = (spender: string, amount: bigint) => encodeFunctionData({ abi: ABI, functionName: 'approve', args: [getAddress(spender), amount] });
export interface BurnArgs { amount: bigint; destinationDomain: number; mintRecipient: string; burnToken: string; maxFee: bigint; minFinalityThreshold: number; forwarding: boolean }
export function burnData(b: BurnArgs): Hex {
  const common = [b.amount, b.destinationDomain, bytes32Of(b.mintRecipient), getAddress(b.burnToken), ZERO32, b.maxFee, b.minFinalityThreshold] as const;
  return b.forwarding
    ? encodeFunctionData({ abi: ABI, functionName: 'depositForBurnWithHook', args: [...common, CCTP_FORWARD_HOOK] })
    : encodeFunctionData({ abi: ABI, functionName: 'depositForBurn', args: [...common] });
}
export const receiveMessageData = (message: Hex, attestation: Hex) => encodeFunctionData({ abi: ABI, functionName: 'receiveMessage', args: [message, attestation] });
export const depositETHData = (minGasLimit = 200_000) => encodeFunctionData({ abi: ABI, functionName: 'depositETH', args: [minGasLimit, '0x'] });
export const depositEthData = () => encodeFunctionData({ abi: ABI, functionName: 'depositEth', args: [] });

export type Decoded =
  | { fn: 'none' }
  | { fn: 'transfer'; to: `0x${string}`; amount: bigint }
  | { fn: 'approve'; spender: `0x${string}`; amount: bigint }
  | { fn: 'depositForBurn' | 'depositForBurnWithHook'; amount: bigint; destinationDomain: number; mintRecipient: Hex; burnToken: `0x${string}`; destinationCaller: Hex; maxFee: bigint; minFinalityThreshold: number; hookData?: Hex }
  | { fn: 'receiveMessage'; message: Hex; attestation: Hex }
  | { fn: 'depositETH'; minGasLimit: number; extraData: Hex }
  | { fn: 'depositEth' };

/** Decode calldata of a known call; null — unknown selector or malformed (also: extra bytes after the arguments). */
export function decodeCall(data: Hex | undefined): Decoded | null {
  if (!data || data === '0x') return { fn: 'none' };
  try {
    const d = decodeFunctionData({ abi: ABI, data });
    // re-encode: the bytes must be exactly the canonical encoding (no trailing junk, no dirty padding)
    const again = encodeFunctionData({ abi: ABI, functionName: d.functionName as any, args: d.args as any });
    if (again.toLowerCase() !== data.toLowerCase()) return null;
    const a = (d.args ?? []) as readonly any[];
    switch (d.functionName) {
      case 'transfer': return { fn: 'transfer', to: getAddress(a[0]), amount: a[1] };
      case 'approve': return { fn: 'approve', spender: getAddress(a[0]), amount: a[1] };
      case 'depositForBurn': case 'depositForBurnWithHook':
        return { fn: d.functionName, amount: a[0], destinationDomain: Number(a[1]), mintRecipient: a[2], burnToken: getAddress(a[3]), destinationCaller: a[4], maxFee: a[5], minFinalityThreshold: Number(a[6]), hookData: a[7] };
      case 'receiveMessage': return { fn: 'receiveMessage', message: a[0], attestation: a[1] };
      case 'depositETH': return { fn: 'depositETH', minGasLimit: Number(a[0]), extraData: a[1] };
      case 'depositEth': return { fn: 'depositEth' };
    }
  } catch { /* unknown */ }
  return null;
}
