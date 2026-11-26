// E2E content: checks of an agent's request, its normalization into the request object (the rules the
// Signer applies — in E2E the extension is the only one who sees the request), the E2E wallet
// document and the per-agent `view`. Pure: no storage, no network.
import { getAddress, isAddress } from 'viem';
import { parseUnits } from '../amount';
import { evmNet, isEvm, assetOf, SERVED_EVM } from '../evm/networks';
import { jcs } from '../jcs';
import { normalizeTron } from '../tron/address';
import { sha256Hex } from '../wallet/doc';
import type { Account, AgentEntry, VaultData } from '../wallet/model';
import { t } from '../../i18n';
import { stripBidi } from '../text';

export const E2E_TYPES = ['transfer', 'swap', 'bridge', 'refuel'] as const;           // executed by the extension in E2E
export const KNOWN_NOT_E2E = ['x402_pay', 'contract_call', 'tron_resource'];          // known types not executed in E2E (yet)
export const MIN_TTL_S = 60, MAX_TTL_S = 86_400, CLOCK_SKEW_MS = 5 * 60_000;
export const SEEN_KEEP_MS = 8 * 86_400_000;

export interface E2EError { code: string; message: string; field?: string }
const err = (code: string, message: string, field?: string): E2EError => ({ code, message, ...(field ? { field } : {}) });

const isTs = (s: unknown) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(s) && !Number.isNaN(Date.parse(s));
export const validCRID = (s: unknown) => typeof s === 'string' && s.length >= 1 && s.length <= 128 && [...s].every((c) => c.charCodeAt(0) > 0x20 && c.charCodeAt(0) < 0x7f);

/** Freshness: created_at ≤ now + 5 min, expires_at > now, expires_at − created_at ∈ [60 s, 86 400 s]. */
export function checkFresh(p: any, now: number): E2EError | null {
  if (!isTs(p?.created_at) || !isTs(p?.expires_at)) return err('BAD_REQUEST', 'created_at / expires_at must be RFC 3339 UTC', 'expires_at');
  const c = Date.parse(p.created_at), x = Date.parse(p.expires_at);
  if (c > now + CLOCK_SKEW_MS) return err('E2E_CLOCK', 'created_at is in the future');
  const ttl = (x - c) / 1000;
  if (ttl < MIN_TTL_S || ttl > MAX_TTL_S) return err('BAD_EXPIRES', `expires_at − created_at must be ${MIN_TTL_S}…${MAX_TTL_S} s`, 'expires_at');
  if (x <= now) return err('E2E_EXPIRED', 'the request expired before the wallet saw it');
  return null;
}

/** Idempotency hash: JCS of the request without request_id, times and metadata. */
export function bodyHash(p: any): string {
  const { request_id, created_at, expires_at, metadata, t, ...rest } = p ?? {};
  void request_id; void created_at; void expires_at; void metadata; void t;
  return 'sha256:' + sha256Hex(jcs(rest));
}

const COMMON = new Set(['t', 'request_id', 'client_request_id', 'created_at', 'expires_at', 'type', 'account', 'network', 'reason', 'metadata', 'intent', 'expires_in']);
/** `intent` as an object or the intent fields flat (as in POST /v1/requests). */
function intentFields(p: any): Record<string, any> {
  const flat: Record<string, any> = {};
  for (const [k, v] of Object.entries(p ?? {})) if (!COMMON.has(k)) flat[k] = v;
  return { ...flat, ...(p?.intent && typeof p.intent === 'object' ? p.intent : {}) };
}

function resourcesOf(r: any): { ok: true; v: any } | { ok: false; e: E2EError } {
  const ri = r && typeof r === 'object' ? { ...r } : {};
  ri.route ??= 'auto';
  if (!['auto', 'direct', 'proxy'].includes(ri.route)) return { ok: false, e: err('BAD_REQUEST', 'route must be auto | direct | proxy', 'resources.route') };
  ri.payment = { ...(ri.payment ?? {}) };
  ri.payment.method ??= 'x402_base';
  if (ri.payment.method === 'cabinet_balance' || ri.payment.method === 'api_key') return { ok: false, e: err('PAYMENT_METHOD_UNAVAILABLE', `payment method ${ri.payment.method} is not implemented`, 'resources.payment.method') };
  if (ri.payment.method !== 'x402_base') return { ok: false, e: err('BAD_REQUEST', `unknown payment method ${ri.payment.method}`, 'resources.payment.method') };
  if (ri.max_cost_usdc !== undefined) {
    try { if (parseUnits(String(ri.max_cost_usdc), 6) <= 0n) throw 0; } catch { return { ok: false, e: err('BAD_AMOUNT', 'max_cost_usdc must be a positive USDC decimal', 'resources.max_cost_usdc') }; }
    ri.max_cost_usdc = String(ri.max_cost_usdc);
  }
  return { ok: true, v: ri };
}

export interface NormCtx { agent_id: string; agent: AgentEntry; accounts: Account[] }

/**
 * An agent's `request` payload → the request object the queue and the sign window use (status pending). Same rules as
 * the Signer's prepare(): type, client_request_id, account (id or name, bound to the agent; none → the first bound),
 * allowed types, reason ≤ 500, metadata ≤ 2 KB, network, asset, amount → amount_raw, to normalized, resources.
 */
export function normalizeRequest(p: any, c: NormCtx): { ok: true; request: any } | { ok: false; error: E2EError } {
  const fail = (e: E2EError) => ({ ok: false as const, error: e });
  if (typeof p?.request_id !== 'string' || !/^awr_[A-Za-z0-9_-]{8,64}$/.test(p.request_id)) return fail(err('BAD_REQUEST', 'request_id: awr_ + base64url', 'request_id'));
  if (!validCRID(p.client_request_id)) return fail(err('BAD_REQUEST', 'client_request_id: 1–128 ASCII characters without spaces', 'client_request_id'));
  const type = String(p.type ?? '');
  if (KNOWN_NOT_E2E.includes(type)) return fail(err('E2E_TYPE_UNSUPPORTED', `type ${type} is not executed in E2E mode (switch to your own Signer)`, 'type'));
  if (!(E2E_TYPES as readonly string[]).includes(type)) return fail(err('UNKNOWN_TYPE', `unknown type ${type}`, 'type'));
  // account
  const live = c.accounts.filter((a) => !a.removed_at);
  const bound = c.agent.accounts.filter((id) => live.some((a) => a.id === id));
  let acc: Account | undefined;
  if (p.account === undefined || p.account === '') {
    acc = live.find((a) => a.id === bound[0]);
    if (!acc) return fail(err('ACCOUNT_NOT_ALLOWED', 'the agent is not bound to any account', 'account'));
  } else {
    acc = live.find((a) => a.id === p.account) ?? live.find((a) => a.name === p.account);
    if (!acc) return fail(err('UNKNOWN_ACCOUNT', `no account ${p.account} in the wallet`, 'account'));
    if (!bound.includes(acc.id)) return fail(err('ACCOUNT_NOT_ALLOWED', `the agent is not bound to account ${acc.name}`, 'account'));
  }
  if (!c.agent.allowed_types.includes(type as any)) return fail(err('TYPE_NOT_ALLOWED', `type ${type} is not allowed for this agent`, 'type'));
  const reason = p.reason === undefined || p.reason === null ? '' : stripBidi(p.reason); // no bidi controls in the agent's words
  if ([...reason].length > 500) return fail(err('REASON_TOO_LONG', 'reason is limited to 500 characters', 'reason'));
  let metadata: any = {};
  if (p.metadata !== undefined && p.metadata !== null) {
    if (typeof p.metadata !== 'object' || Array.isArray(p.metadata)) return fail(err('BAD_REQUEST', 'metadata must be an object', 'metadata'));
    if (JSON.stringify(p.metadata).length > 2048) return fail(err('BAD_REQUEST', 'metadata is limited to 2 KB', 'metadata'));
    metadata = p.metadata;
  }
  const f = intentFields(p);
  let network = String(p.network ?? '');
  let intent: any;
  if (type === 'bridge') {
    for (const k of ['to', 'recipient', 'max_fee', 'resources']) if (f[k] !== undefined) return fail(err('BAD_REQUEST', `field ${k} is not allowed in a bridge`, k));
    const from = String(f.from_network ?? network);
    if (network && network !== from) return fail(err('BAD_REQUEST', 'network must equal from_network', 'network'));
    if (!from || !f.to_network) return fail(err('UNSUPPORTED_NETWORK', 'from_network and to_network are required', 'from_network'));
    if (String(f.asset ?? 'USDC') !== 'USDC') return fail(err('UNSUPPORTED_ASSET', 'the bridge moves USDC only (CCTP)', 'asset'));
    for (const n of [from, String(f.to_network)]) if (!(SERVED_EVM as readonly string[]).includes(n) || !evmNet(n)?.cctp) return fail(err('UNSUPPORTED_NETWORK', `network ${n} has no CCTP`, 'to_network'));
    if (from === f.to_network) return fail(err('SAME_NETWORK', 'from_network and to_network are the same', 'to_network'));
    const mode = f.mode ?? 'fast', delivery = f.delivery ?? 'auto';
    if (!['fast', 'standard'].includes(mode)) return fail(err('BAD_MODE', 'mode must be fast | standard', 'mode'));
    if (!['self', 'forwarding', 'auto'].includes(delivery)) return fail(err('BAD_REQUEST', 'delivery must be self | forwarding | auto', 'delivery'));
    try { if (parseUnits(String(f.amount ?? ''), 6) <= 0n) throw 0; } catch { return fail(err('BAD_AMOUNT', 'amount must be a positive USDC decimal', 'amount')); }
    network = from;
    intent = { asset: 'USDC', from_network: from, to_network: String(f.to_network), amount: String(f.amount), amount_raw: parseUnits(String(f.amount), 6).toString(), mode, delivery };
  } else if (type === 'refuel') {
    for (const k of ['to', 'recipient', 'asset']) if (f[k] !== undefined) return fail(err('BAD_REQUEST', `field ${k} is not allowed in a refuel`, k));
    const from = String(f.from_network ?? (network || 'evm:1'));
    if (network && network !== from) return fail(err('BAD_REQUEST', 'network must equal from_network', 'network'));
    if (from !== 'evm:1') return fail(err('UNSUPPORTED_NETWORK', 'refuel goes from evm:1 (Ethereum) only', 'from_network'));
    const dst = evmNet(String(f.to_network ?? ''));
    if (!dst) return fail(err('UNSUPPORTED_NETWORK', `unknown EVM network ${f.to_network}`, 'to_network'));
    if (!dst.refuel) return fail(err('REFUEL_UNSUPPORTED', `no canonical L1→L2 bridge to ${dst.name}`, 'to_network'));
    try { if (parseUnits(String(f.amount_eth ?? ''), 18) <= 0n) throw 0; } catch { return fail(err('BAD_AMOUNT', 'amount_eth must be a positive ETH decimal', 'amount_eth')); }
    network = from;
    intent = { from_network: from, to_network: dst.network, amount_eth: String(f.amount_eth) };
  } else if (type === 'transfer' && isEvm(network)) {
    if (!(SERVED_EVM as readonly string[]).includes(network)) return fail(err('UNSUPPORTED_NETWORK', `network ${network} is not served`, 'network'));
    if (!acc.addresses.evm) return fail(err('UNSUPPORTED_NETWORK', `account ${acc.name} has no EVM address`, 'network'));
    let a;
    try { a = assetOf(network, String(f.asset ?? '')); } catch (e) { return fail(err('UNSUPPORTED_ASSET', (e as Error).message, 'asset')); }
    let raw: bigint;
    try { raw = parseUnits(String(f.amount ?? ''), a.decimals); if (raw <= 0n) throw 0; } catch { return fail(err('BAD_AMOUNT', `amount must be a positive decimal with at most ${a.decimals} fraction digits`, 'amount')); }
    if (!isAddress(String(f.to ?? ''), { strict: false })) return fail(err('INVALID_ADDRESS', 'to is not an EVM address', 'to'));
    const to = getAddress(String(f.to));
    if (to === getAddress(acc.addresses.evm)) return fail(err('SELF_TRANSFER', 'transfer to the same address', 'to'));
    if (f.resources !== undefined) return fail(err('BAD_REQUEST', 'resources are TRON only', 'resources'));
    intent = { asset: a.symbol, to, amount: String(f.amount), amount_raw: raw.toString() };
  } else {
    if (!network && type === 'swap') network = 'tron';
    if (!network) return fail(err('UNSUPPORTED_NETWORK', 'network is required', 'network'));
    if (network !== 'tron') return fail(err('UNSUPPORTED_NETWORK', `type ${type} is not served on ${network}`, 'network'));
    if (!acc.addresses.tron) return fail(err('UNSUPPORTED_NETWORK', `account ${acc.name} has no TRON address`, 'network'));
    if (f.memo !== undefined) return fail(err('MEMO_NOT_SUPPORTED', 'memo is only supported on ton', 'memo'));
    const r = resourcesOf(f.resources);
    if (!r.ok) return fail(r.e);
    if (type === 'swap') {
      const ai = String(f.asset_in ?? '').toUpperCase(), ao = String(f.asset_out ?? '').toUpperCase();
      if (!['TRX', 'USDT'].includes(ai) || !['TRX', 'USDT'].includes(ao)) return fail(err('UNSUPPORTED_ASSET', 'swap is TRX ↔ USDT only', 'asset_in'));
      if (ai === ao) return fail(err('SAME_ASSET', 'asset_in and asset_out are the same', 'asset_out'));
      for (const k of ['to', 'recipient']) if (f[k] !== undefined) return fail(err('BAD_REQUEST', `field ${k} is not allowed in a swap: the recipient is the account`, k));
      try { if (parseUnits(String(f.amount_in ?? ''), 6) <= 0n) throw 0; } catch { return fail(err('BAD_AMOUNT', 'amount_in must be a positive decimal', 'amount_in')); }
      const bps = f.slippage_bps === undefined ? undefined : Number(f.slippage_bps);
      if (bps !== undefined && (!Number.isInteger(bps) || bps < 1 || bps > 300)) return fail(err('BAD_SLIPPAGE', 'slippage_bps must be 1…300', 'slippage_bps'));
      intent = { asset_in: ai, asset_out: ao, amount_in: String(f.amount_in), amount_in_raw: parseUnits(String(f.amount_in), 6).toString(), ...(bps !== undefined ? { slippage_bps: bps } : {}), recipient: acc.addresses.tron, resources: r.v };
    } else {
      const asset = String(f.asset ?? '').toUpperCase();
      if (!['TRX', 'USDT'].includes(asset)) return fail(err('UNSUPPORTED_ASSET', `asset ${f.asset} is not in the TRON token list`, 'asset'));
      let raw: bigint;
      try { raw = parseUnits(String(f.amount ?? ''), 6); if (raw <= 0n) throw 0; } catch { return fail(err('BAD_AMOUNT', 'amount must be a positive decimal with at most 6 fraction digits', 'amount')); }
      let to: string;
      try { to = normalizeTron(String(f.to ?? '')); } catch (e) { return fail(err('INVALID_ADDRESS', (e as Error).message, 'to')); }
      if (to === normalizeTron(acc.addresses.tron)) return fail(err('SELF_TRANSFER', 'transfer to the same address', 'to'));
      intent = { asset, to, amount: String(f.amount), amount_raw: raw.toString(), resources: r.v };
    }
  }
  const address = network === 'tron' ? acc.addresses.tron : acc.addresses.evm;
  return { ok: true, request: {
    schema_version: '1', request_id: p.request_id, client_request_id: p.client_request_id,
    agent: { id: c.agent_id, name: c.agent.name }, account: { id: acc.id, name: acc.name, address },
    type, network, intent, reason, metadata, status: 'pending', created_at: p.created_at, expires_at: p.expires_at,
  } };
}

/** What goes back to the agent: the request object without our local fields. */
export function forAgent(req: any): any {
  const { e2e, own, ...rest } = req ?? {};
  void e2e; void own;
  return rest;
}

// ---- the E2E wallet document and the per-agent view ----
export interface E2EDoc {
  schema_version: '1'; mode: 'e2e'; wallet_id: string; version: number; updated_at: string; service?: string;
  e2e: { wallet_key: string; fp: string };
  accounts: { id: string; addresses: Account['addresses']; ton_pubkey?: string }[];
  networks_trusted: string[];
  agents: Record<string, { accounts: string[]; key: { bundle: string; fp: string; mode: 'agent' | 'server'; paired_at: string } | null; cloud?: { client_id: string; consent_id: string } }>;
  views: Record<string, string>;
}

const ts = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

export function viewPayload(walletId: string, version: number, agentId: string, a: AgentEntry, accounts: Account[], v: VaultData, now = new Date()): any {
  const live = accounts.filter((x) => !x.removed_at);
  const accs = a.accounts.map((id) => live.find((x) => x.id === id)).filter(Boolean) as Account[];
  return {
    t: 'view', version, wallet_id: walletId,
    agent: { id: agentId, name: a.name, accounts: accs.map((x) => ({ id: x.id, name: x.name, addresses: x.addresses })), default_account: accs[0]?.id ?? null,
      allowed_types: a.allowed_types },
    address_book: v.address_book, networks_trusted: v.networks_trusted,
    updated_at: ts(now),
  };
}

export function buildE2EDoc(walletId: string, version: number, accounts: Account[], v: VaultData, viewHashes: Record<string, string>, now = new Date(), service?: string): E2EDoc {
  if (!v.e2e) throw new Error('E2E_NO_KEYS');
  const agents: E2EDoc['agents'] = {};
  for (const [id, a] of Object.entries(v.agents)) {
    if (a.revoked_at) continue;
    agents[id] = { accounts: a.accounts, key: a.e2e ? { bundle: a.e2e.bundle, fp: a.e2e.fp, mode: a.e2e.mode, paired_at: a.e2e.paired_at } : null,
      ...(a.cloud ? { cloud: { client_id: a.cloud.client_id, consent_id: a.cloud.consent_id } } : {}) };
  }
  return {
    schema_version: '1', mode: 'e2e', wallet_id: walletId, version, updated_at: ts(now), ...(service ? { service } : {}),
    e2e: { wallet_key: v.e2e.bundle, fp: v.e2e.fp },
    accounts: accounts.filter((x) => !x.removed_at).map((x) => ({ id: x.id, addresses: x.addresses, ...(x.ton_pubkey ? { ton_pubkey: x.ton_pubkey } : {}) })),
    networks_trusted: v.networks_trusted, agents, views: viewHashes,
  };
}

/** `views` entry: "sha256:<hex sha256 of JCS(envelope)>". */
export const envelopeHash = (env: unknown): string => 'sha256:' + sha256Hex(jcs(env));
/** digest of the E2E document: sha256(JCS(doc)) — no rules to replace. */
export const e2eDocDigest = (doc: E2EDoc): string => 'sha256:' + sha256Hex(jcs(doc));

/** Reject reason → the status and error code the Signer would have set (its Reject). */
export function rejectOutcome(reasonCode: string, detail?: any): { status: 'rejected' | 'failed'; code: string } {
  switch (reasonCode) {
    case 'insufficient_gas': return { status: 'failed', code: 'INSUFFICIENT_GAS' };
    case 'resource_unavailable': return { status: 'failed', code: detail?.code === 'RESOURCE_PAYMENT_FAILED' ? 'RESOURCE_PAYMENT_FAILED' : 'RESOURCE_UNAVAILABLE' };
    case 'resource_above_max': return { status: 'failed', code: 'RESOURCE_ABOVE_MAX' };
    case 'type_not_allowed': return { status: 'rejected', code: 'TYPE_NOT_ALLOWED' };
    case 'paused': return { status: 'rejected', code: 'AGENTS_PAUSED' };
    case 'human': return { status: 'rejected', code: 'REJECTED_BY_HUMAN' };
    default: return { status: 'rejected', code: String(reasonCode).toUpperCase() };
  }
}

/** The line of the sign window about the request's origin. */
export function originMark(req: any, e2eInUse: boolean): { mode: 'agent' | 'server' | 'none'; fp?: string; confirmed?: boolean; note: string } | undefined {
  const e = req?.e2e;
  if (e?.key_mode === 'agent') return { mode: 'agent', fp: e.fp, confirmed: !!e.confirmed, note: `${t('origin.agentKey')} ${e.fp}` };
  if (e?.key_mode === 'server') return { mode: 'server', fp: e.fp, note: t('origin.server') };
  if (e2eInUse && !req?.own) return { mode: 'none', note: t('origin.none') };
  return undefined;
}
