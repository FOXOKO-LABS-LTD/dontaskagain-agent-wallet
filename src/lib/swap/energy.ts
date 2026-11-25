// Energy of a contract call paid by the CALLER: java-tron splits a call's energy between the contract owner
// (origin) and the caller by consume_user_resource_percent, the owner pays at most origin_energy_limit and only what
// it has. sun.io Universal Router has percent = 1 → the owner pays 99 % while it has energy.
import type { TronReader } from '../net';

export interface ContractEnergyTerms { percent: number; originLimit: number; originAvailable: number }

/** total − min(origin available, origin_energy_limit, total × (100 − percent) / 100). */
export function userEnergyShare(total: number, t: ContractEnergyTerms): number {
  const originWanted = Math.floor((total * (100 - t.percent)) / 100);
  const origin = Math.max(0, Math.min(t.originAvailable, t.originLimit, originWanted));
  return Math.max(0, total - origin);
}

export async function contractEnergyTerms(r: TronReader, contract: string): Promise<ContractEnergyTerms> {
  const c = await r.call('getcontract', { value: contract, visible: true });
  const percent = Number(c?.consume_user_resource_percent ?? 0);
  const originLimit = Number(c?.origin_energy_limit ?? 0);
  let originAvailable = 0;
  if (c?.origin_address && percent < 100) {
    const res = await r.call('getaccountresource', { address: c.origin_address, visible: true }).catch(() => null);
    originAvailable = Math.max(0, Number(res?.EnergyLimit ?? 0) - Number(res?.EnergyUsed ?? 0));
  }
  return { percent, originLimit, originAvailable };
}

export interface Simulation { ok: boolean; energy_total: number; message?: string }

/** triggerconstantcontract of the exact call (owner, contract, data, call_value). */
export async function simulateCall(r: TronReader, owner: string, contract: string, dataHex: string, callValue: bigint): Promise<Simulation> {
  const body: Record<string, unknown> = { owner_address: owner, contract_address: contract, data: dataHex, visible: true };
  if (callValue > 0n) body.call_value = Number(callValue);
  const out = await r.call('triggerconstantcontract', body);
  const ok = out?.result?.result === true && !(out?.transaction?.ret?.[0]?.ret === 'FAILED');
  let message: string | undefined;
  if (!ok) {
    const m = out?.result?.message ?? '';
    try { message = /^[0-9a-f]+$/i.test(m) ? new TextDecoder().decode(Uint8Array.from(m.match(/../g)!.map((h: string) => parseInt(h, 16)))) : m; } catch { message = m; }
    if (!message) message = out?.transaction?.ret?.[0]?.ret ?? 'REVERT';
  }
  return { ok, energy_total: Number(out?.energy_used ?? 0), message };
}
