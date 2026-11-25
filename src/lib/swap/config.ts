// Swap constants: sun.io Universal Router, Permit2, WTRX and the swap asset list.
import cfg from '../../config/swap.json';
import { tronToHex41 } from '../tron/address';

export type SwapNet = 'mainnet' | 'nile';
export type SwapAsset = 'TRX' | 'USDT';

export interface SwapAssetInfo { symbol: SwapAsset; address: string; decimals: number; native: boolean }

export interface SwapConfig {
  net: SwapNet; chainId: number; router: string; permit2: string; wtrx: string; trx: string;
  assets: Record<SwapAsset, SwapAssetInfo>;
}

export const LIMITS = cfg.limits;
/** The swap step (router call) may buy resources through Proxy (false until the gateway counts the router subsidy). */
let proxyAllowed: boolean = !!(cfg as any).swap_proxy_allowed;
export const swapProxyAllowed = (): boolean => proxyAllowed;
/** tests: run the restricted mode (an older gateway) */
export function setSwapProxyAllowed(v: boolean): void { proxyAllowed = v; }
/** Activation of a new TRX recipient through Proxy (tron/send) is off until the gateway activates for real. */
let recvActProxy: boolean = !!(cfg as any).receiver_activation_proxy_allowed;
export const receiverActivationProxyAllowed = (): boolean => recvActProxy;
export function setReceiverActivationProxyAllowed(v: boolean): void { recvActProxy = v; }

export function swapConfig(net: SwapNet = 'mainnet'): SwapConfig {
  const c = cfg[net];
  const assets = {} as Record<SwapAsset, SwapAssetInfo>;
  for (const [k, v] of Object.entries(c.assets)) assets[k as SwapAsset] = { symbol: k as SwapAsset, address: v.address, decimals: v.decimals, native: !!(v as any).native };
  return { net, chainId: c.chain_id, router: c.router, permit2: c.permit2, wtrx: c.wtrx, trx: c.trx, assets };
}

export const SWAP_ASSETS: SwapAsset[] = ['TRX', 'USDT'];
export const isSwapAsset = (s: string): s is SwapAsset => (SWAP_ASSETS as string[]).includes(s);

/** TRON address → 20-byte EVM form used inside the router calldata (0x…, lowercase). T9yD…uWwb (TRX) → 0x00…00. */
export const evmHex = (tron: string): `0x${string}` => ('0x' + tronToHex41(tron).slice(2)) as `0x${string}`;

// Universal Router constants (sun.io SDK constants.ts / v4 ActionConstants)
export const MSG_SENDER = '0x0000000000000000000000000000000000000001' as const;
export const ADDRESS_THIS = '0x0000000000000000000000000000000000000002' as const;
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
export const CONTRACT_BALANCE = 1n << 255n;
export const OPEN_DELTA = 0n;
