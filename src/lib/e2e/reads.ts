// Network reads in E2E mode: the Signer relay only for reads that carry no content (own addresses, blocks,
// chain parameters, gas prices, balances of own addresses at listed tokens). Everything with a foreign address or an
// amount (energy estimate of a transfer, the recipient's account, eth_estimateGas, eth_getCode, simulations) goes
// directly to the node / RPC chosen in the settings — never through the mailbox server.
import { normalizeTron, tronFromHex41, tronToHex41 } from '../tron/address';
import { HttpError, postJSON, type EvmReader, type TronReader } from '../net';

/** Addresses the relay may see: own accounts + listed contracts (tokens, router, Permit2, CCTP). */
export interface Known { tron: Set<string>; evm: Set<string>; tronContracts: Set<string>; evmContracts: Set<string> }

// 0.3.3: what the transaction is BUILT from (block reference and time, chain parameters → fee_limit, the
// account's own energy / bandwidth → route «none», EVM nonce and fees) is read directly too — the Signer may only see
// balances of own addresses at listed tokens and the chain id / height.
const SAFE_TRON_FREE = new Set<string>([]);
const SAFE_TRON_OWN = new Set<string>([]);
const SAFE_SELECTORS_TRON = new Set(['balanceOf(address)', 'allowance(address,address)']);

function normT(a: unknown): string | null { try { return typeof a === 'string' ? normalizeTron(a) : null; } catch { return null; } }

/** 64-hex words of an ABI parameter; null if any word is not an address word (amounts are content). */
function addressWordsTron(param: string): string[] | null {
  if (typeof param !== 'string' || param.length % 64 !== 0 || !/^[0-9a-fA-F]*$/.test(param)) return null;
  const out: string[] = [];
  for (let i = 0; i < param.length; i += 64) {
    const w = param.slice(i, i + 64).toLowerCase();
    if (!/^0{24}/.test(w)) return null;
    try { out.push(tronFromHex41('41' + w.slice(24))); } catch { return null; }
  }
  return out;
}

/** True when a TRON read reveals nothing but own addresses / listed contracts. */
export function tronReadIsSafe(method: string, body: Record<string, unknown>, k: Known): boolean {
  if (SAFE_TRON_FREE.has(method)) return Object.keys(body ?? {}).every((x) => x === 'visible' || x === 'detail');
  if (SAFE_TRON_OWN.has(method)) { const a = normT(body?.address); return !!a && k.tron.has(a); }
  if (method === 'triggerconstantcontract') {
    const c = normT(body?.contract_address), o = normT(body?.owner_address);
    if (!c || !o || !k.tronContracts.has(c) || !k.tron.has(o)) return false;
    if (!SAFE_SELECTORS_TRON.has(String(body?.function_selector ?? ''))) return false;
    if (body?.data !== undefined || (body?.call_value !== undefined && Number(body.call_value) !== 0)) return false;
    const words = addressWordsTron(String(body?.parameter ?? ''));
    return !!words && words.every((w) => k.tron.has(w) || k.tronContracts.has(w));
  }
  return false;
}

const SAFE_EVM_FREE = new Set(['eth_chainId', 'eth_blockNumber']);
const SAFE_EVM_SELECTORS = new Set(['0x70a08231', '0xdd62ed3e']); // balanceOf(address), allowance(address,address)

export function evmReadIsSafe(method: string, params: unknown[], k: Known): boolean {
  if (SAFE_EVM_FREE.has(method)) {
    if (method === 'eth_getBlockByNumber') return params?.[1] !== true; // headers only, no transactions
    return true;
  }
  if (method === 'eth_getLogs') return logsFilterIsSafe(params, k);
  if (method === 'eth_getBalance') return typeof params?.[0] === 'string' && k.evm.has(String(params[0]).toLowerCase());
  if (method === 'eth_call') {
    const c = params?.[0] as any;
    if (!c || typeof c !== 'object') return false;
    if (c.from && !k.evm.has(String(c.from).toLowerCase())) return false;
    if (c.value && BigInt(c.value) !== 0n) return false;
    if (!k.evmContracts.has(String(c.to ?? '').toLowerCase())) return false;
    const data = String(c.data ?? c.input ?? '').toLowerCase();
    if (!SAFE_EVM_SELECTORS.has(data.slice(0, 10))) return false;
    const args = data.slice(10);
    if (args.length % 64 !== 0) return false;
    for (let i = 0; i < args.length; i += 64) {
      const w = args.slice(i, i + 64);
      if (!/^0{24}/.test(w)) return false;
      const a = '0x' + w.slice(24);
      if (!k.evm.has(a) && !k.evmContracts.has(a)) return false;
    }
    return true;
  }
  return false;
}

/** 0.3.12: the account's token history — a Transfer filter over listed token contracts whose address topics are own
 * addresses only, a bounded hex range (the same form the Signer's relay admits). */
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
function logsFilterIsSafe(params: unknown[], k: Known): boolean {
  if (!Array.isArray(params) || params.length !== 1) return false;
  const f = params[0] as any;
  if (!f || typeof f !== 'object' || Object.keys(f).some((x) => !['fromBlock', 'toBlock', 'address', 'topics'].includes(x))) return false;
  const from = /^0x[0-9a-f]{1,16}$/i.test(String(f.fromBlock)) ? Number.parseInt(f.fromBlock, 16) : NaN;
  const to = /^0x[0-9a-f]{1,16}$/i.test(String(f.toBlock)) ? Number.parseInt(f.toBlock, 16) : NaN;
  if (!(to - from >= 0 && to - from <= 10_000)) return false;
  const addrs: unknown[] = Array.isArray(f.address) ? f.address : [f.address];
  if (!addrs.length || addrs.length > 8 || !addrs.every((a) => k.evmContracts.has(String(a).toLowerCase()))) return false;
  const t: unknown[] = Array.isArray(f.topics) ? f.topics : [];
  if (t.length < 1 || t.length > 3 || String(t[0]).toLowerCase() !== TRANSFER) return false;
  for (const pos of t.slice(1)) {
    if (pos === null) continue;
    for (const w of Array.isArray(pos) ? pos : [pos]) {
      const s = String(w).toLowerCase();
      if (!/^0x0{24}[0-9a-f]{40}$/.test(s) || !k.evm.has(`0x${s.slice(26)}`)) return false;
    }
  }
  return true;
}

/** Logged decisions (tests read them: a recipient or an amount must never reach the relay). */
export interface ReadLog { via: 'relay' | 'direct'; kind: 'tron' | 'evm'; method: string; body: unknown }

export class E2ETronReader implements TronReader {
  constructor(private relay: TronReader, private direct: TronReader, private known: () => Known, private viaSigner = false, private log?: (l: ReadLog) => void) {}
  call(method: string, body: Record<string, unknown>) {
    const safe = this.viaSigner || tronReadIsSafe(method, body, this.known());
    this.log?.({ via: safe ? 'relay' : 'direct', kind: 'tron', method, body });
    return safe ? this.relay.call(method, body) : this.direct.call(method, body);
  }
}

/** 0.3.12: several RPCs per network — an RPC that fails, answers a JSON-RPC error (a provider refusing what it should
 * serve) or has no receipt yet is followed by the next; with no better answer the first error (a revert stays one). */
const NULL_MAY_LAG = new Set(['eth_getTransactionReceipt', 'eth_getTransactionByHash']);
export class DirectEvmReader implements EvmReader {
  private id = 1;
  constructor(private urlOf: (chainId: number) => string | string[] | undefined) {}
  async rpc(chainId: number, method: string, params: unknown[]) {
    const u = this.urlOf(chainId);
    const urls = (Array.isArray(u) ? u : u ? [u] : []).filter(Boolean);
    if (!urls.length) throw new HttpError(503, 'RPC_NOT_CONFIGURED', `no RPC for network ${chainId} in the settings (E2E: direct reads)`);
    let firstErr: HttpError | null = null, sawNull = false, lastNet: unknown = null;
    for (const url of urls) {
      let r: any;
      try { r = await postJSON(url, { jsonrpc: '2.0', id: this.id++, method, params }); } catch (e) { lastNet = e; continue; }
      if (r?.error) { firstErr ??= new HttpError(502, 'RPC_ERROR', r.error.message ?? 'rpc error', r); continue; }
      if (NULL_MAY_LAG.has(method) && (r?.result === null || r?.result === undefined)) { sawNull = true; continue; }
      return r.result;
    }
    if (sawNull) return null;
    if (firstErr) throw firstErr;
    throw lastNet instanceof Error ? lastNet : new HttpError(503, 'RPC_UNAVAILABLE', 'no RPC answered');
  }
}

export class E2EEvmReader implements EvmReader {
  constructor(private relay: EvmReader, private direct: EvmReader, private known: () => Known, private viaSigner = false, private log?: (l: ReadLog) => void) {}
  rpc(chainId: number, method: string, params: unknown[]) {
    const safe = this.viaSigner || evmReadIsSafe(method, params, this.known());
    this.log?.({ via: safe ? 'relay' : 'direct', kind: 'evm', method, body: params });
    return safe ? this.relay.rpc(chainId, method, params) : this.direct.rpc(chainId, method, params);
  }
}

export function hexOfTron(a: string): string { return tronToHex41(a); }
