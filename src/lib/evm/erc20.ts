// ERC-20 reads over the Signer EVM relay (eth_call).
import type { EvmReader } from '../net';
import networks from '../../config/networks.json';

export function tokenOf(network: string, symbol: string): { address: string; decimals: number } | undefined {
  const n = networks.networks.find((x) => x.network === network);
  return n?.tokens.find((t) => t.symbol === symbol);
}

export async function erc20Balance(r: EvmReader, chainId: number, token: string, owner: string): Promise<bigint> {
  const data = '0x70a08231' + owner.slice(2).toLowerCase().padStart(64, '0');
  const out = await r.rpc<string>(chainId, 'eth_call', [{ to: token, data }, 'latest']);
  if (typeof out !== 'string' || !out.startsWith('0x')) throw new Error('eth_call failed');
  return out === '0x' ? 0n : BigInt(out);
}

export async function usdcBalance(r: EvmReader, chainId: number, owner: string): Promise<bigint> {
  const t = tokenOf(`evm:${chainId}`, 'USDC');
  if (!t) throw new Error('no USDC in the built-in list');
  return erc20Balance(r, chainId, t.address, owner);
}

export async function nativeBalance(r: EvmReader, chainId: number, owner: string): Promise<bigint> {
  const out = await r.rpc<string>(chainId, 'eth_getBalance', [owner, 'latest']);
  return BigInt(out);
}
