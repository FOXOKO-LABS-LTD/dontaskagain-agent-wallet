// EVM networks of the built-in trusted list: which are served, their tokens, CCTP v2 and the
// L1→L2 refuel bridges. One EVM address of an account works in every network.
import networks from '../../config/networks.json';

export interface EvmToken { symbol: string; address: `0x${string}`; decimals: number }
export interface CctpCfg { domain: number; token_messenger: `0x${string}`; message_transmitter: `0x${string}`; fast: boolean; eta_fast_sec?: number; eta_standard_sec: number }
export interface RefuelCfg { from: string; kind: 'op_stack' | 'arbitrum'; l1_contract: `0x${string}`; min_gas_limit?: number; eta_sec: number }
export interface EvmNet {
  network: string; chain_id: number; name: string; native: { symbol: string; decimals: number };
  explorer_tx: string; explorer_addr: string; finality: { head: number; solid: number };
  max_fee_native: string; tokens: EvmToken[]; cctp?: CctpCfg; refuel?: RefuelCfg;
}

/** Served networks (the others of the list — BSC, Avalanche — are listed but not checked on chain yet). */
export const SERVED_EVM = ['evm:1', 'evm:42161', 'evm:10', 'evm:137', 'evm:8453'] as const;

const all = networks.networks as unknown as (EvmNet & { network: string })[];

export function evmNet(network: string): EvmNet | undefined {
  if (!/^evm:\d+$/.test(network)) return undefined;
  return all.find((n) => n.network === network);
}
export function requireNet(network: string): EvmNet {
  const n = evmNet(network);
  if (!n || !(SERVED_EVM as readonly string[]).includes(network)) throw new Error(`UNSUPPORTED_NETWORK: ${network}`);
  return n;
}
export const servedNets = (): EvmNet[] => SERVED_EVM.map((id) => evmNet(id)!).filter(Boolean);
export const isEvm = (network: string) => /^evm:\d+$/.test(network);
export const chainIdOf = (network: string) => requireNet(network).chain_id;
export const shortName = (network: string) => ({ 'evm:42161': 'Arbitrum', 'evm:137': 'Polygon', 'evm:10': 'Optimism' } as Record<string, string>)[network] ?? evmNet(network)?.name ?? (network === 'tron' ? 'TRON' : network);

/** Asset of a network by symbol: the native coin (address undefined) or a listed token. */
export function assetOf(network: string, symbol: string): { symbol: string; decimals: number; address?: `0x${string}`; native: boolean } {
  const n = requireNet(network);
  if (symbol === n.native.symbol) return { symbol, decimals: n.native.decimals, native: true };
  const t = n.tokens.find((x) => x.symbol === symbol);
  if (!t) throw new Error(`UNSUPPORTED_ASSET: ${symbol} in ${n.name}`);
  return { symbol, decimals: t.decimals, address: t.address, native: false };
}
export const usdcOf = (network: string): EvmToken => {
  const t = requireNet(network).tokens.find((x) => x.symbol === 'USDC');
  if (!t) throw new Error(`UNSUPPORTED_ASSET: USDC in ${network}`);
  return t;
};
export const explorerTx = (network: string, hash: string) => evmNet(network)?.explorer_tx.replace('{hash}', hash) ?? '';
/** Networks with CCTP (bridge) and the L2s reachable by refuel. */
export const cctpNets = (): EvmNet[] => servedNets().filter((n) => n.cctp);
export const refuelNets = (): EvmNet[] => servedNets().filter((n) => n.refuel);
