// TRON reads used by balances and by the resource check. All through a TronReader (Signer relay).
import type { TronReader } from '../net';
import { tronToHex41 } from './address';
import { trc20TransferData } from './tx';

export const USDT_TRON = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

export interface TronAccountState {
  exists: boolean;              // getaccount not empty = activated
  balanceSun: bigint;
  energy: { available: number; limit: number };
  bandwidth: { staked_available: number; free_available: number; limit: number; free_limit: number };
}

export async function accountState(r: TronReader, address: string): Promise<TronAccountState> {
  const [acc, res] = await Promise.all([
    r.call('getaccount', { address, visible: true }),
    r.call('getaccountresource', { address, visible: true }),
  ]);
  const exists = !!acc && typeof acc === 'object' && !!acc.address;
  const el = Number(res?.EnergyLimit ?? 0), eu = Number(res?.EnergyUsed ?? 0);
  const fl = Number(res?.freeNetLimit ?? 0), fu = Number(res?.freeNetUsed ?? 0);
  const nl = Number(res?.NetLimit ?? 0), nu = Number(res?.NetUsed ?? 0);
  return {
    exists,
    balanceSun: BigInt(acc?.balance ?? 0),
    energy: { available: Math.max(0, el - eu), limit: el },
    // a non-account has no free bandwidth at all
    bandwidth: { staked_available: Math.max(0, nl - nu), free_available: exists ? Math.max(0, fl - fu) : 0, limit: nl, free_limit: exists ? fl : 0 },
  };
}

export async function trc20Balance(r: TronReader, token: string, owner: string): Promise<bigint> {
  const p = tronToHex41(owner).slice(2).padStart(64, '0');
  const out = await r.call('triggerconstantcontract', { owner_address: owner, contract_address: token, function_selector: 'balanceOf(address)', parameter: p, visible: true });
  const v = out?.constant_result?.[0];
  if (typeof v !== 'string') throw new Error('balanceOf failed');
  return v.length ? BigInt('0x' + v) : 0n;
}

export async function chainParams(r: TronReader): Promise<Record<string, number>> {
  const out = await r.call('getchainparameters', {});
  const m: Record<string, number> = {};
  for (const p of out?.chainParameter ?? []) m[p.key] = Number(p.value ?? 0);
  return m;
}

/** Energy of a TRC-20 transfer by the TRON node (energy_used already includes energy_penalty, as tron/estimate reads it);
 * null when the simulation fails. */
export async function estimateTrc20Energy(r: TronReader, token: string, owner: string, to: string, amountRaw: bigint): Promise<number | null> {
  try {
    const data = trc20TransferData(to, amountRaw);
    const out = await r.call('triggerconstantcontract', { owner_address: owner, contract_address: token, function_selector: 'transfer(address,uint256)', parameter: data.slice(8), visible: true });
    if (out?.result?.result !== true) return null;
    const e = Number(out.energy_used ?? 0);
    return e > 0 ? e : null;
  } catch {
    return null;
  }
}

export async function nowBlock(r: TronReader): Promise<{ blockID: string; number: number; timestamp: number }> {
  const b = await r.call('getnowblock', {});
  if (!b?.blockID) throw new Error('getnowblock failed');
  return { blockID: b.blockID, number: Number(b.block_header?.raw_data?.number ?? 0), timestamp: Number(b.block_header?.raw_data?.timestamp ?? 0) };
}
