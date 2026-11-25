// Request queue, sign window, building and signing. Every signature is manual.
import { formatUnits, parseUnits } from '../lib/amount';
import { randomId } from '../lib/bytes';
import { DirectTronReader, SignerEvmReader, SignerTronReader, SignerX402Reader, getJSON, type EvmReader, type TronReader, type X402Reader } from '../lib/net';
import e2eCfg from '../config/e2e.json';
import { DirectEvmReader, E2EEvmReader, E2ETronReader, type ReadLog } from '../lib/e2e/reads';
import { Gateway } from '../lib/e2e/gateway';
import { decideE2E, e2eActive, e2eDirectReads, e2eRequest, isE2EId, knownAddresses, ownE2E, plaintextPolicy } from './e2e';
import { originMark } from '../lib/e2e/protocol';
import { buildOp, doneText, finishText, isFinal, type OpView } from '../lib/op';
import { DirectRoute, ProxyRoute } from '../lib/resources/plan';
import { signTronTxId } from '../lib/sign';
import { bookMatch } from '../lib/similar';
import { ownEntries, recipientCheck } from '../lib/ownAccounts';
import { checkDecodedAgainstIntent, prepareTronTransfer, type PreparedTron, type TransferIntent } from '../lib/tron/prepare';
import { decodeRaw } from '../lib/tron/tx';
import { normalizeTron } from '../lib/tron/address';
import { decodePaymentRequired, pickResourceTerms, signResourcePayment } from '../lib/x402/pay';
import { directReadsOn, evmRpcsOf, tronNodeOf } from '../lib/wallet/model';
import type { HistoryRow, PreparedView, RequestRow } from '../shared/api';
import { findRepeat, type RequestLike } from '../lib/guard';
import { notificationText } from '../lib/requestLabel';
import { showRequestsInPanel } from './panel';
import { currentSession, signerUrl, socket } from './signer';
import { getPublic, getSession, patchSession, type Approval, type SignedRec } from './store';
import { accountKeys, isUnlocked, requireUnlocked, updateVault } from './wallet';
import { approvalKey, prepareSwapRequest, signSwapRequest } from './swap';
import { isEvmRequest, onMintUpdate, prepareEvmRequest, signEvmRequest } from './evm';
import { both, t as tr, ta, type Key, type Params } from '../i18n';
import { buildIdOf } from '../lib/buildId';
import { cleanRequestText } from '../lib/text';
import { checkAgent } from './agentCheck';

/** The product name (not translated): notification titles. */
export const PRODUCT_NAME = "Don't Ask Again";

export const REBUILD_AFTER_MS = 30_000;   // rebuild on "Sign" if the first build is older than 30 s

// ---- readers (relay through the Signer; the human's own TRON node directly — by choice, or as a debug option) ----
export async function readers(): Promise<{ tron: TronReader; evm: EvmReader; x402: X402Reader }> {
  const pub = await getPublic();
  const ownNode = tronNodeOf(pub?.settings); // 0.3.9: '' — no node of the human's own (there is no built-in one)
  const relayTron = pub?.settings.debug_direct_node && ownNode ? new DirectTronReader(ownNode) : new SignerTronReader(signerUrl, currentSession);
  const relayEvm = new SignerEvmReader(signerUrl, currentSession);
  if (await e2eDirectReads()) { // 0.3.3: wanted is enough — also under a downgrade and before the first hello
    // reads with content go straight to the node / RPC; quotes and payments — to our gateway directly
    const st = pub!.settings;
    const viaSigner = !directReadsOn(st); // 0.3.9: direct only with a TRON node of the human's own
    const known = await knownAddresses();
    return {
      tron: new E2ETronReader(relayTron, new DirectTronReader(ownNode), () => known, viaSigner, readLog),
      evm: new E2EEvmReader(relayEvm, new DirectEvmReader((id) => evmRpcsOf(st, id)), () => known, viaSigner, readLog),
      x402: new Gateway(() => st.x402_gateway_url || e2eCfg.x402_gateway_url),
    };
  }
  return { tron: relayTron, evm: relayEvm, x402: new SignerX402Reader(signerUrl, currentSession) };
}

/** Tests read which way each E2E read went (a recipient or an amount must never reach the relay). */
export const readTrail: ReadLog[] = [];
const readLog = (l: ReadLog) => { readTrail.push(l); if (readTrail.length > 500) readTrail.shift(); };

/** request.sign / request.reject: to the Signer, or — for an E2E request — to the local executor. */
export async function decide(type: 'request.sign' | 'request.reject', body: Record<string, unknown> & { request_id: string }): Promise<any> {
  if (await isE2EId(body.request_id)) return decideE2E(type, body);
  // 0.3.3: the last gate — a signed transaction never goes to the Signer in plaintext when plaintext is closed
  if (type === 'request.sign' && (await plaintextPolicy()) === 'closed') throw new Error(`E2E_DOWNGRADE: ${tr('bg.e2eDowngrade')}`);
  return socket.request(type, body);
}

/** 0.3.3: a plaintext request of the Signer cannot be signed now (a downgrade / public Signer). */
export async function plaintextClosedFor(id: string): Promise<boolean> {
  return !(await isE2EId(id)) && (await plaintextPolicy()) === 'closed';
}
/** 0.3.3: the human's own forms are refused before any read with content when nothing could be signed. */
export async function assertOwnAllowed(): Promise<void> {
  if (!(await e2eActive()) && (await plaintextPolicy()) === 'closed') throw new Error(`E2E_DOWNGRADE: ${tr('bg.e2eDowngrade')}`);
}
/** An agent of the vault with a bound key or a pairing under way: it asks only in envelopes. */
const keyedAgent = (vault: any, agentId: unknown) => typeof agentId === 'string' && Object.prototype.hasOwnProperty.call(vault?.agents ?? {}, agentId) && !!(vault.agents[agentId].e2e || vault.agents[agentId].pairing);
/** own.*: the Signer, or the local executor when E2E is in use (the operator never gets a summary of the human's own operation). */
export async function ownSubmit(type: string, body: Record<string, unknown>): Promise<any> {
  if (await e2eActive()) return ownE2E(type, body);
  if ((await plaintextPolicy()) === 'closed') throw new Error(`E2E_DOWNGRADE: ${tr('bg.e2eDowngrade')}`); // never in plaintext
  return socket.request(type, body);
}

// ---- one signature per request (0.3.3) ----
const SIGNED_KEEP_MS = 86_400_000;
const SKEW_MS = 60_000;
/** May the transaction signed for it still land? TRON: until its expiration (+ clock skew); EVM: no expiry (24 h). */
export const recAlive = (r: SignedRec, now = Date.now()) => (r.until !== undefined ? now < r.until + SKEW_MS : now - r.at < SIGNED_KEEP_MS);
export async function liveSigned(key: string): Promise<SignedRec | undefined> {
  const r = (await getSession()).signedOnce?.[key];
  return r && recAlive(r) ? r : undefined;
}
async function putSignedRec(r: SignedRec): Promise<void> {
  const all = { ...((await getSession()).signedOnce ?? {}) };
  for (const [k, x] of Object.entries(all)) if (!recAlive(x) && Date.now() - x.at > SIGNED_KEEP_MS) delete all[k];
  all[r.key] = r;
  await patchSession({ signedOnce: all });
}
const untilText = (r: SignedRec) => (r.until !== undefined ? new Date(r.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null);
/**
 * Send what was signed. The record is written first; on any error it stays, and the error says that the signature may
 * already be at the Signer and until when it is valid — the next «Sign» re-sends the SAME bytes.
 */
export async function sendSigned<T>(r: SignedRec, send: () => Promise<T>): Promise<T> {
  await putSignedRec(r);
  try {
    const out = await send();
    await putSignedRec({ ...r, acked: true });
    return out;
  } catch (e) {
    const u = untilText(r);
    throw new Error(`${(e as Error).message} — ${u ? tr('bg.signedNotConfirmedUntil', { until: u }) : tr('bg.signedNotConfirmed')}`);
  }
}
/** The window's line about it: signed, delivery not confirmed, valid until… */
function signedOnceView(r: SignedRec): PreparedView['signed_once'] {
  return { at: r.at, until: r.until !== undefined ? new Date(r.until).toISOString() : undefined, txids: r.txids, acked: !!r.acked };
}
/** Another request of the same agent to the same recipient whose signature may still land (a red plate). */
async function liveSignatureOf(id: string, req: any): Promise<PreparedView['live_signature']> {
  const s = await getSession();
  const to = String(req?.intent?.to ?? (req?.type === 'swap' ? `swap:${req?.intent?.asset_out ?? ''}` : '')).toLowerCase();
  const agent = req?.agent?.id;
  if (!to || !agent) return null;
  for (const r of Object.values(s.signedOnce ?? {})) {
    if (r.key === id || r.kind !== 'request' || r.agent_id !== agent || String(r.to ?? '').toLowerCase() !== to || !recAlive(r)) continue;
    const st = s.requests?.[r.key]?.request?.status;
    if (st === 'confirmed') continue;
    return { request_id: r.key, until: r.until !== undefined ? new Date(r.until).toISOString() : undefined, status: st };
  }
  return null;
}

// ---- queue ----
type Entry = NonNullable<Awaited<ReturnType<typeof getSession>>['requests']>[string];

/**
 * 0.3.2: what a request was when the wallet first got it stays so — the Signer may move its status and
 * progress, never what is signed (intent, account, type, network, agent, reason, times). Its `e2e` mark is dropped (only
 * the local E2E executor sets it), a decided request never goes back to `pending`, and E2E requests (ours only) are
 * never touched at all. A new pending request in plaintext is taken only when plaintext is allowed (plaintextPolicy).
 */
/** 0.3.3: limits of what the Signer can put into chrome.storage.session. */
export const MAX_PENDING = 200, MAX_REQUEST_BYTES = 32_768, MAX_PENDING_PAYS = 50;
const PINNED = ['request_id', 'schema_version', 'client_request_id', 'agent', 'account', 'type', 'network', 'intent', 'reason', 'metadata', 'created_at', 'expires_at', 'own', 'parent_request_id'] as const;

export async function putServerRequests(list: { req: any; preview?: any; receivedAt?: number }[]): Promise<number> {
  const s = await getSession();
  const policy = await plaintextPolicy();
  const out: { req: any; preview?: any; receivedAt?: number }[] = [];
  for (const x of list) {
    const id = x.req?.request_id;
    if (typeof id !== 'string' || !id || (await isE2EId(id))) continue;
    const { e2e, ...r } = cleanRequestText(x.req);
    void e2e;
    const prev = s.requests?.[id]?.request;
    if (prev?.e2e) continue; // a local E2E copy (own E2E operation)
    if (!prev) {
      const pending = (r.status ?? 'pending') === 'pending';
      // bounded — a request too large, or a queue already full of pending ones, is not taken (the Signer keeps it)
      if (JSON.stringify(r).length > MAX_REQUEST_BYTES) { console.warn('[agent-wallet] request too large, dropped:', id); continue; }
      if (pending && Object.values(s.requests ?? {}).filter((e) => e.request.status === 'pending').length + out.length >= MAX_PENDING) { console.warn('[agent-wallet] queue full, request not taken:', id); continue; }
      if (pending && policy === 'closed') { console.warn('[agent-wallet] plaintext request from the Signer dropped (E2E):', id); continue; }
      // an agent with a bound key asks only in envelopes — a plaintext one in its name is forged (whatever the
      // policy; while locked it is checked again at unlock — dropForgedPlaintext — and blocked in the window anyway)
      if (pending && s.unlocked && keyedAgent(s.unlocked.vault, r.agent?.id)) { console.warn('[agent-wallet] plaintext request in the name of a keyed agent dropped:', id); continue; }
      out.push({ req: r, preview: x.preview, receivedAt: x.receivedAt });
      continue;
    }
    const next: any = { ...prev, ...r };
    for (const k of PINNED) { if (k in prev) next[k] = prev[k]; else delete next[k]; }
    // a decided request never goes back to pending; `unknown` (only missing from one request.list) may
    if (prev.status && prev.status !== 'pending' && prev.status !== 'unknown' && next.status === 'pending') next.status = prev.status;
    out.push({ req: next, receivedAt: x.receivedAt });
  }
  return putRequests(out);
}

export async function putRequest(req: any, preview?: any, receivedAt?: number): Promise<void> {
  await putRequests([{ req, preview, receivedAt }]);
}

/** Many at once (server history, request.list): one storage write instead of one per request (0.1.7, speed). */
export async function putRequests(list: { req: any; preview?: any; receivedAt?: number }[]): Promise<number> {
  if (!list.length) return 0;
  const s = await getSession();
  const all = { ...(s.requests ?? {}) };
  let changed = 0;
  for (const { req, preview, receivedAt } of list) {
    const prev = all[req.request_id];
    // received_at is ours (the repeat check counts from it, not from the request's own created_at)
    const next = { request: { ...(prev?.request ?? {}), ...req }, preview: preview ?? prev?.preview, received_at: prev?.received_at ?? Math.min(receivedAt ?? Date.now(), Date.now()), local: prev?.local, ...(prev?.own_local ? { own_local: true } : {}) };
    if (!prev || JSON.stringify(prev) !== JSON.stringify(next)) changed++;
    all[req.request_id] = next;
  }
  if (!changed) return 0;
  // keep only what still matters: pending + the last 400 others (the Signer's history fills it after a restart)
  const ids = Object.keys(all).sort((a, b) => all[b].received_at - all[a].received_at);
  let kept = 0;
  for (const id of ids) if (all[id].request.status !== 'pending' && ++kept > 400) delete all[id];
  await patchSession({ requests: all });
  return changed;
}

/**
 * 0.3.3: requests that came while the wallet was locked could not be checked against the vault. At unlock a
 * pending plaintext request in the name of an agent with a key (or a pairing) is refused as forged.
 */
export async function dropForgedPlaintext(): Promise<number> {
  const s = await getSession();
  const vault = s.unlocked?.vault;
  if (!vault) return 0;
  let n = 0;
  for (const [id, e] of Object.entries(s.requests ?? {})) {
    if (e.request.status !== 'pending' || e.local || e.request.e2e || (await isE2EId(id)) || !keyedAgent(vault, e.request.agent?.id)) continue;
    const s2 = await getSession();
    await patchSession({ requests: { ...s2.requests, [id]: { ...s2.requests![id], local: { state: 'rejected', message: 'E2E_PLAINTEXT' } } } });
    prepared.delete(id);
    if (socket.connected) await socket.request('request.reject', { request_id: id, reason_code: 'unsafe', detail: { code: 'E2E_PLAINTEXT', message: 'a plaintext request in the name of an agent with a key' } }).catch(() => {});
    n++;
  }
  if (n) { console.warn('[agent-wallet] forged plaintext requests refused at unlock:', n); await updateBadge(); }
  return n;
}

/** Notifications must never break the flow (the API rejects e.g. on a bad icon or when notifications are off). */
export function notify(id: string, title: string, message: string): void {
  try {
    const p = chrome.notifications.create(id, { type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'), title, message, priority: 2 }) as unknown;
    (p as Promise<unknown> | undefined)?.catch?.((e: unknown) => console.warn('[agent-wallet] notification:', (e as Error)?.message ?? e));
  } catch (e) { console.warn('[agent-wallet] notification:', (e as Error)?.message ?? e); }
}

/** 0.3.3: a request without its own expires_at lives 24 h from when the wallet got it. */
export const NO_EXPIRY_TTL_MS = 86_400_000;
const expiryOf = (e: Entry) => (e.request.expires_at ? Date.parse(e.request.expires_at) : e.received_at + NO_EXPIRY_TTL_MS);
const isLive = (e: Entry) => e.request.status === 'pending' && !e.local && e.request.type !== 'bridge_step' && expiryOf(e) > Date.now();
/** 0.3.3: an agent's name is the vault's (the Signer's name is never shown); unknown → none. */
const agentOf = (vault: any, a: any): { id: string; name: string; known?: boolean } | undefined => {
  if (!a || typeof a.id !== 'string') return undefined;
  const mine = vault && Object.prototype.hasOwnProperty.call(vault.agents, a.id) ? vault.agents[a.id] : undefined;
  return { id: a.id, name: mine?.name ?? '', known: !!mine };
};

export async function pendingRows(): Promise<RequestRow[]> {
  const s = await getSession();
  const vault = s.unlocked?.vault;
  return Object.values(s.requests ?? {}).filter(isLive).sort((a, b) => a.received_at - b.received_at).map((e) => ({
    request_id: e.request.request_id, agent: agentOf(vault, e.request.agent) as any, account: e.request.account, type: e.request.type, network: e.request.network,
    intent: e.request.intent, reason: e.request.reason, status: e.request.status, expires_at: e.request.expires_at ?? new Date(expiryOf(e)).toISOString(), created_at: e.request.created_at, local: e.local,
    swap: undefined, // the Signer's amount_out_min of a pending swap is not shown (the window shows our own build)
    e2e_mode: e.request.e2e?.key_mode,
  }));
}

export async function pendingCount(): Promise<number> { return (await pendingRows()).length; }

export async function updateBadge(): Promise<void> {
  const n = await pendingCount();
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#292936' }); // UI kit 1.1.1: graphite accent; the icon keeps its corner free (badge-safe)
    await chrome.action.setBadgeText({ text: n ? String(n) : '' });
  } catch (e) { console.warn('[agent-wallet] badge:', (e as Error)?.message ?? e); }
}

export async function openSignWindow(): Promise<void> {
  // an open side panel shows the queue itself — no separate window
  if (showRequestsInPanel()) return;
  const s = await getSession();
  if (s.signWindowId !== undefined) {
    try { await chrome.windows.update(s.signWindowId, { focused: true }); return; } catch { /* closed */ }
  }
  const w = await chrome.windows.create({ url: chrome.runtime.getURL('sign.html'), type: 'popup', width: 460, height: 760, focused: true });
  await patchSession({ signWindowId: w?.id });
}

export async function onRequestNew(m: any): Promise<void> {
  const req = m.request ?? m;
  if (!req?.request_id) return;
  const existed = !!(await getSession()).requests?.[req.request_id];
  if (!(await putServerRequests([{ req: { ...req, status: req.status ?? 'pending' }, preview: m.preview }])) && !existed) return; // dropped (E2E) — no window, no notification
  if (existed) { await updateBadge(); return; } // the same id again: nothing new to show
  if ((req.status ?? 'pending') === 'pending' && (await agentsPaused())) { await rejectPaused(req.request_id); return; }
  await updateBadge();
  // the vault's name of the agent (locked or unknown → «agent»), the request's words cleaned like everywhere
  const who = agentOf((await getSession()).unlocked?.vault, req.agent)?.name || tr('bg.agent');
  const { swap: _swap, ...shown } = cleanRequestText(req); void _swap;
  notify(`req:${req.request_id}`, `${PRODUCT_NAME}: ${tr('bg.signRequest')}`, notificationText(who, shown));
  await openSignWindow();
}

export async function onRequestList(m: any): Promise<void> {
  const list: any[] = m.requests ?? [];
  const s = await getSession();
  const all = { ...(s.requests ?? {}) };
  const live = new Set(list.map((r) => r.request_id));
  // the Signer knows only its own requests — E2E ones (and own E2E operations) are never its to close
  for (const [id, e] of Object.entries(all)) if (e.request.status === 'pending' && !live.has(id) && !e.request.e2e && !(await isE2EId(id))) e.request.status = 'unknown';
  await patchSession({ requests: all });
  await putServerRequests(list.map((r) => ({ req: { ...r, status: r.status ?? 'pending' } })));
  if (await agentsPaused()) { for (const r of list) if ((r.status ?? 'pending') === 'pending') await rejectPaused(r.request_id).catch(() => {}); return; }
  await updateBadge();
  if (list.length) await openSignWindow();
}

export async function onRequestUpdate(m: any): Promise<void> {
  if (typeof m?.request_id !== 'string' || (await isE2EId(m.request_id))) return; // E2E requests change only here
  const s = await getSession();
  const e = s.requests?.[m.request_id];
  if (e?.request.e2e) return;
  // `request` = the whole request object (tx, bridge/refuel/swap with steps) — merged as is
  const full = m.request && typeof m.request === 'object' && m.request.request_id === m.request_id ? m.request : null;
  if (e) {
    const wasFinal = isFinal(e.request.status);
    await putServerRequests([{ req: { ...e.request, ...(full ?? {}), status: m.status ?? full?.status ?? e.request.status, decision: m.decision ?? full?.decision ?? e.request.decision,
      resources: m.resources ?? full?.resources ?? e.request.resources, error: m.error ?? full?.error ?? e.request.error } }]);
    const now = (await getSession()).requests?.[m.request_id]?.request;
    const fin = now && !wasFinal ? (finishText(now) ?? doneText(now)) : null;
    if (fin) notify(`op:${m.request_id}`, fin.title, fin.message);
  } else if (full && !full.parent_request_id && full.status !== 'pending') {
    await putServerRequests([{ req: full, receivedAt: Date.parse(full.created_at ?? '') || Date.now() }]);
  }
  if (m.status && m.status !== 'pending') prepared.delete(m.request_id);
  await onMintUpdate(m);
  await updateBadge();
}

// ---- preparing and signing ----
interface Prepared { key: string; kind: 'agent' | 'own'; account_id: string; intent: TransferIntent; prep: PreparedTron; view: PreparedView; request?: any; }
const prepared = new Map<string, Prepared>();

export function routes(x402: X402Reader) { return [new ProxyRoute(x402), new DirectRoute(x402)]; }

async function build(kind: 'agent' | 'own', key: string, accountId: string, intent: TransferIntent, request?: any): Promise<Prepared> {
  const { pub, vault } = await requireUnlocked();
  const acc = pub.accounts.find((a) => a.id === accountId && !a.removed_at);
  if (!acc?.addresses.tron) throw new Error('UNKNOWN_ACCOUNT');
  const r = await readers();
  const prep = await prepareTronTransfer({ owner: acc.addresses.tron, evmPayer: acc.addresses.evm, intent, tron: r.tron, evm: currentSession() ? r.evm : null, routes: routes(r.x402) });
  const warnings: string[] = [];
  let blocked = prep.blocked;
  // the agent and its binding (not bound to the account → deny; unknown / type not allowed → deny too)
  let agent: PreparedView['agent'];
  if (kind === 'agent') {
    const ac = await agentCheckOf(key, request, vault, accountId);
    agent = ac.agent;
    if (ac.blocked) blocked = ac.blocked;
  }
  const match = bookMatch('tron', prep.to, vault.address_book);
  const pubNow = await getPublic();
  const rc = recipientCheck({ network: 'tron', address: prep.to, own: ownEntries(pubNow?.accounts ?? [], vault.secrets, 'tron'), book: vault.address_book, history: vault.recipients, cfg: vault.global.similar,
    firstTime: !vault.recipients.some((x) => x.network === 'tron' && x.address === prep.to) });
  const { similar, first_time: firstTime } = rc;
  if (prep.energy_source === 'fallback') warnings.push(tr('bg.energyFallback'));
  for (const q of Object.values(prep.plan.quotes)) if (q?.ok && q.note) warnings.push(`${q.route}: ${q.note}`);
  const d = prep.decoded;
  const view: PreparedView = {
    key, kind, agent, account: { id: acc.id, name: acc.name, tron: acc.addresses.tron, evm: acc.addresses.evm },
    network: 'tron', type: 'transfer', reason: request?.reason, expires_at: request?.expires_at, created_at: request?.created_at,
    tx: {
      asset: prep.asset, asset_contract: prep.asset === 'USDT' ? d.contract : undefined, amount: formatUnits(BigInt(prep.amount_raw), 6),
      from: d.owner, to: prep.asset === 'USDT' ? d.trc20!.to : d.to!, txID: prep.txID, fee_limit_trx: formatUnits(BigInt(d.feeLimit), 6), expiration: new Date(d.expiration).toISOString(),
    },
    to_check: { in_book: match ? { label: match.label, id: match.id } : undefined, ...(rc.own ? { own: rc.own } : {}), similar, first_time: firstTime },
    resources: {
      need: prep.need.need, have: prep.need.have, deficit: prep.need.deficit, activate: prep.need.activate,
      route: prep.plan.route, fallback_route: prep.plan.fallback_route,
      quotes: Object.fromEntries(Object.entries(prep.plan.quotes).map(([k, v]) => [k, { ok: !!v?.ok, cost_usdc: v?.cost_usdc, approved_max_usdc: v?.approved_max_usdc, code: v?.code, note: v?.note, parts: v?.parts }])),
      approved_max_usdc: prep.plan.approved_max_usdc, fallback_approved_max_usdc: prep.plan.fallback_approved_max_usdc,
      payer: acc.addresses.evm, usdc_balance: prep.balances.usdc_base_micro === null ? null : formatUnits(BigInt(prep.balances.usdc_base_micro), 6),
      energy_source: prep.energy_source, buy: prep.plan.buy,
    },
    blocked, warnings, built_at: prep.built_at,
  };
  view.build_id = buildIdOf(view, [prep.raw_data_hex]);
  const p: Prepared = { key, kind, account_id: accountId, intent, prep, view, request };
  prepared.set(key, p);
  return p;
}

/** The agent check of a request in the window (all request kinds use it). */
export async function agentCheckOf(id: string, request: any, vault: Parameters<typeof checkAgent>[1], accountId: string) {
  return checkAgent(request, vault, accountId, { e2eId: await isE2EId(id), e2eInUse: await e2eActive() });
}

function intentOf(req: any): TransferIntent {
  const i = req.intent ?? {};
  return { asset: String(i.asset ?? ''), to: String(i.to ?? ''), amount: String(i.amount ?? ''), resources: i.resources };
}

/** Only `transfer` in `tron` is signed by this path; everything else can only be rejected. */
function stage1Supported(req: any): [Key, Params] | null {
  if (isEvmRequest(req)) return null; // EVM
  if (req.type === 'swap') return req.network === 'tron' ? null : ['blk.swapTronOnly', { net: req.network }]; // swaps: TRON only
  if (req.type !== 'transfer') return ['blk.typeNotStage1', { type: req.type }];
  if (req.network !== 'tron') return ['blk.networkNotStage1', { net: req.network }];
  if (!['TRX', 'USDT'].includes(String(req.intent?.asset ?? '').toUpperCase())) return ['blk.assetNotStage1', { asset: req.intent?.asset }];
  return null;
}

export async function prepareRequest(id: string): Promise<PreparedView> {
  // already signed and maybe at the Signer — the window shows THAT transaction (and re-sends it), never a new build
  const rec = await liveSigned(id);
  const req = await requestOf(id);
  if (rec?.view && req?.status === 'pending') return decorate(id, { ...rec.view, signed_once: signedOnceView(rec), warnings: [...(rec.view.warnings ?? [])] });
  return decorate(id, await prepareRequestInner(id));
}

/** The window's extras over a build: the origin plate, the block reason for «Reject», the repeat plate. */
async function decorate(id: string, v: PreparedView): Promise<PreparedView> {
  // the origin plate comes only from the E2E store (a request the Signer sent has no `e2e` mark by now)
  const mark = originMark((await e2eRequest(id)) ?? { ...((await getSession()).requests?.[id]?.request ?? {}), e2e: undefined }, await e2eDirectReads());
  if (mark) v.e2e = mark;
  if (v.blocked) blockedViews.set(id, v.blocked); else blockedViews.delete(id);
  v.repeat = await repeatOf(id);
  v.live_signature = await liveSignatureOf(id, await requestOf(id));
  return v;
}

// ---- «the same transfer N min ago», pause of all agents, history ----
// a swap compares by direction (asset_in → asset_out); the recipient of a swap is always the account itself
const likeOf = (id: string, e: Entry): RequestLike => (e.request.type === 'swap' ? {
  request_id: id, agent_id: e.request.agent?.id, to: `swap:${e.request.intent?.asset_out ?? ''}`, asset: e.request.intent?.asset_in, kind: 'swap',
  amount: e.request.intent?.amount_in != null ? `${e.request.intent.amount_in} ${e.request.intent?.asset_in ?? ''}`.trim() : undefined,
  network: e.request.network, at: e.received_at, // our own clock — created_at is the agent's (or server's)
  status: e.local?.state === 'rejected' ? 'rejected' : e.request.status,
} : {
  request_id: id, agent_id: e.request.agent?.id, to: e.request.intent?.to, asset: e.request.intent?.asset, amount: e.request.intent?.amount != null ? `${e.request.intent.amount} ${e.request.intent?.asset ?? ''}`.trim() : undefined,
  network: e.request.network, at: e.received_at,
  status: e.local?.state === 'rejected' ? 'rejected' : e.request.status,
});

async function repeatOf(id: string): Promise<PreparedView['repeat']> {
  const s = await getSession();
  const all = s.requests ?? {};
  const e = all[id];
  if (!e) return null;
  const others = Object.entries(all).filter(([k]) => k !== id).map(([k, x]) => likeOf(k, x));
  return findRepeat(likeOf(id, e), others);
}

export async function agentsPaused(): Promise<boolean> { return !!(await getPublic())?.settings.agents_paused; }

/** Pause fallback (the Signer refuses itself while paused): reason_code "paused". */
export async function rejectPaused(id: string): Promise<void> {
  await decide('request.reject', { request_id: id, reason_code: 'paused', detail: { code: 'paused', message: ta('bg.agentsPaused') } });
  const s = await getSession();
  const e = s.requests?.[id];
  if (e) await patchSession({ requests: { ...s.requests, [id]: { ...e, local: { state: 'rejected', message: 'paused' } } } });
  prepared.delete(id);
  await updateBadge();
}

/** The Signer already refused it (wallet.pause): mark locally so it leaves the queue at once. */
export async function markRejectedLocally(id: string, message: string): Promise<void> {
  const s = await getSession();
  const e = s.requests?.[id];
  if (e) await patchSession({ requests: { ...s.requests, [id]: { ...e, local: { state: 'rejected', message } } } });
  prepared.delete(id);
  await updateBadge();
}

/** Decided requests (agent and own), newest first; optionally of one account. */
/** Steps of a bridge / swap are not operations of their own: the parent shows them (0.2.1). */
const isStep = (r: any) => r?.type === 'bridge_step' || r?.type === 'swap_step' || !!r?.parent_request_id;

export async function historyRows(accountId?: string): Promise<HistoryRow[]> {
  const s = await getSession();
  const vault = s.unlocked?.vault;
  return Object.values(s.requests ?? {}).filter((e) => !isLive(e) && !isStep(e.request) && (!accountId || e.request.account?.id === accountId))
    .sort((a, b) => b.received_at - a.received_at).map((e) => {
      const r = e.request;
      // «own» and «decided by the human» only from the wallet's own marks (a Signer may claim either)
      const own = !!e.own_local || !!r.e2e?.own || (!!r.own && !r.agent);
      const by: HistoryRow['by'] = e.local?.message === 'paused' ? 'pause'
        : r.decision?.by === 'extension' ? 'extension'
        : r.error?.code === 'AGENTS_PAUSED' ? 'pause'
        : e.local || e.own_local || (r.e2e && r.decision?.by === 'human') ? 'human' : 'server';
      const status = e.local?.state === 'rejected' && r.status === 'pending' ? 'rejected' : r.status === 'pending' && e.local?.state === 'signed' ? 'signed' : r.status;
      return { request_id: r.request_id, agent: agentOf(vault, r.agent), account: r.account, type: r.type, network: r.network, intent: r.intent, status, at: e.received_at, own, by, message: e.local?.message ?? r.error?.code,
        swap: r.swap ? { amount_out_min: r.swap.amount_out_min } : undefined, ...opLine(r, status) };
    });
}

/** The words a history line shows for the status, and the progress of a multi-step operation. */
function opLine(r: any, status: string): { status_label: string; progress?: string } {
  try { const v = buildOp({ ...r, status }); return { status_label: v.status_label, progress: v.progress }; } catch { return { status_label: status }; }
}

// ---- operation page (0.2.1) ----
const fetchedAt = new Map<string, number>();
const OP_REFRESH_MS = 15_000;

/** One operation for its page: the local copy, refreshed from the Signer (GET /v1/ext/requests/{id}) when not final. */
export async function opView(id: string): Promise<OpView> {
  const s = await getSession();
  let e = s.requests?.[id];
  const stale = !(await isE2EId(id)) && !e?.request.e2e && (!e || ((!isFinal(e.request.status) || needsDetail(e.request)) && Date.now() - (fetchedAt.get(id) ?? 0) > OP_REFRESH_MS));
  const ses = currentSession();
  if (stale && ses) {
    fetchedAt.set(id, Date.now());
    try {
      const r = await getJSON(`${signerUrl()}/v1/ext/requests/${encodeURIComponent(id)}`, { Authorization: `Bearer ${ses}` });
      if (r?.request_id === id) {
        await putServerRequests([{ req: { ...r, own: e?.request.own ?? !r.agent }, receivedAt: Date.parse(r.created_at ?? '') || Date.now() }]);
        e = (await getSession()).requests?.[id];
      }
    } catch (err) { console.warn('[agent-wallet] op:', (err as Error)?.message ?? err); }
  }
  if (!e) throw new Error('NOT_FOUND');
  return buildOp(e.request);
}
/** A final multi-step request stored before 0.2.1 has no steps yet: fetch it once. */
const needsDetail = (r: any) => (r.type === 'bridge' && !r.bridge) || (r.type === 'refuel' && !r.refuel) || (r.type === 'swap' && !r.swap?.steps);

/** The request as the wallet knows it: an E2E one from the E2E store only, else the session queue. */
export async function requestOf(id: string): Promise<any | undefined> {
  if (await isE2EId(id)) return e2eRequest(id);
  return (await getSession()).requests?.[id]?.request;
}

async function prepareRequestInner(id: string): Promise<PreparedView> {
  const req = await requestOf(id);
  if (!req) throw new Error('NOT_FOUND');
  const unsupported = stage1Supported(req);
  const pub = await getPublic();
  const acc = pub?.accounts.find((a) => a.id === req.account?.id && !a.removed_at);
  const vault = (await getSession()).unlocked?.vault;
  const agentName = (vault && typeof req.agent?.id === 'string' && Object.prototype.hasOwnProperty.call(vault.agents, req.agent.id) ? vault.agents[req.agent.id].name : undefined) ?? req.agent?.name;
  // 0.3.3: plaintext closed (a downgrade, the public Signer) — not built at all, nothing can be signed
  if (await plaintextClosedFor(id)) {
    return { key: id, kind: 'agent', agent: { id: req.agent?.id, name: agentName, known: false }, account: { id: req.account?.id ?? '?', name: acc?.name ?? req.account?.name ?? '?' },
      network: req.network, type: req.type, reason: req.reason, expires_at: req.expires_at, created_at: req.created_at,
      blocked: { reason_code: 'unsafe', code: 'E2E_DOWNGRADE', ...both('blk.e2eDowngrade') }, warnings: [], built_at: Date.now() };
  }
  if (unsupported || !acc) {
    return { key: id, kind: 'agent', agent: { id: req.agent?.id, name: agentName, known: false }, account: { id: req.account?.id ?? '?', name: req.account?.name ?? '?' },
      network: req.network, type: req.type, reason: req.reason, expires_at: req.expires_at, created_at: req.created_at,
      blocked: { reason_code: unsupported ? 'build_failed' : 'unsafe', code: unsupported ? 'UNSUPPORTED' : 'UNKNOWN_ACCOUNT', ...(unsupported ? both(...unsupported) : both('blk.unknownAccount')) },
      warnings: [], built_at: Date.now() };
  }
  try {
    if (req.type === 'swap') return await prepareSwapRequest(id, req, acc.id);
    if (isEvmRequest(req)) return await prepareEvmRequest(id, req, acc.id);
    return (await build('agent', id, acc.id, intentOf(req), req)).view;
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === 'LOCKED') throw err;
    const code = /^(SELF_TRANSFER|BAD_AMOUNT|INVALID_ADDRESS|UNSUPPORTED_ASSET|UNSUPPORTED_NETWORK|SAME_ASSET|SAME_NETWORK|BAD_SLIPPAGE|FEES_UNAVAILABLE)/.test(msg) ? msg : 'BUILD_FAILED';
    return { key: id, kind: 'agent', agent: { id: req.agent?.id, name: agentName, known: false }, account: { id: acc.id, name: acc.name, tron: acc.addresses.tron, evm: acc.addresses.evm },
      network: req.network, type: req.type, reason: req.reason, expires_at: req.expires_at, blocked: { reason_code: 'build_failed', code, message: msg }, warnings: [], built_at: Date.now() };
  }
}

/**
 * 0.3.2: the window sends the id of the build it shows; only that very build is signed. No build in memory
 * (a worker restart), another build, or one older than 30 s → a new build is made and SHOWN, never signed.
 */
async function signPrepared(p: Prepared, addressChecked: boolean, buildId: string | undefined): Promise<{ status: 'changed'; view: PreparedView } | { status: 'signed'; tx: any; resource_plan: any }> {
  if (!buildId || buildId !== p.view.build_id || Date.now() - p.prep.built_at > REBUILD_AFTER_MS) {
    const next = await build(p.kind, p.key, p.account_id, p.intent, p.request);
    return { status: 'changed', view: next.view };
  }
  const cur = p;
  const v = cur.view;
  if (v.blocked) throw new Error(`${v.blocked.code}: ${v.blocked.text ?? v.blocked.message}`);
  if (!v.to_check?.in_book && v.to_check?.first_time && !addressChecked) throw new Error(`ADDRESS_NOT_CHECKED: ${tr('bg.tickAddressChecked')}`);
  // our own check of the very bytes we sign (same rules as the Signer)
  const d = decodeRaw(cur.prep.raw_data_hex);
  checkDecodedAgainstIntent(d, cur.prep);
  if (d.txID !== cur.prep.txID) throw new Error('INTENT_MISMATCH: txID');
  const { account, keys } = await accountKeys(cur.account_id);
  if (normalizeTron(account.addresses.tron!) !== d.owner) throw new Error('INTENT_MISMATCH: owner');
  const sig = await signTronTxId(cur.prep.txID, keys.tronKey);
  const tx = { txID: cur.prep.txID, raw_data_hex: cur.prep.raw_data_hex, signature: [sig] };
  const plan = cur.prep.plan;
  // `need` also for route none and `buys` of both routes: the E2E executor needs them (the Signer ignores them)
  const resource_plan = plan.route === 'none' ? { route: 'none', need: cur.prep.need.need } : {
    route: plan.route, fallback_route: plan.fallback_route, payment_method: plan.payment_method,
    buy: plan.buy, buys: Object.fromEntries(Object.entries(plan.quotes).filter(([, q]) => q?.buy).map(([k, q]) => [k, q!.buy])), need: cur.prep.need.need, have: cur.prep.need.have,
    quote_usdc: plan.quote_usdc, approved_max_usdc: plan.approved_max_usdc,
    fallback_quote_usdc: plan.fallback_route ? plan.quotes[plan.fallback_route]?.cost_usdc : undefined,
    fallback_approved_max_usdc: plan.fallback_approved_max_usdc,
    quotes: Object.fromEntries(Object.entries(plan.quotes).filter(([, q]) => q?.ok).map(([k, q]) => [k, q!.cost_usdc])),
    payer: account.addresses.evm, counted_in_limit: false,
  };
  return { status: 'signed', tx, resource_plan };
}

async function rememberRecipient(to: string): Promise<void> {
  await updateVault((vault) => {
    if (vault.recipients.some((x) => x.network === 'tron' && x.address === to)) return false;
    vault.recipients.push({ network: 'tron', address: to, at: new Date().toISOString() });
    if (vault.recipients.length > 500) vault.recipients.shift();
  });
}

async function approve(request_id: string, p: Prepared, resource_plan: any): Promise<void> {
  if (resource_plan.route === 'none') return;
  const s = await getSession();
  const caps: Approval['caps_micro'] = {};
  caps[resource_plan.route as 'proxy' | 'direct'] = parseUnits(resource_plan.approved_max_usdc, 6).toString();
  if (resource_plan.fallback_route) caps[resource_plan.fallback_route as 'proxy' | 'direct'] = parseUnits(resource_plan.fallback_approved_max_usdc, 6).toString();
  const a: Approval = { request_id, account_id: p.account_id, txID: p.prep.txID, route: resource_plan.route, fallback_route: resource_plan.fallback_route ?? null, caps_micro: caps, paid_micro: {}, created_at: Date.now(),
    req_id: request_id, expires_at: p.prep.decoded.expiration, addresses: [p.prep.decoded.owner, ...(p.prep.plan.buy?.activate ?? [])] };
  await patchSession({ approvals: { ...pruneApprovals(s.approvals), [request_id]: a } });
}

/** The build in memory still is the request the wallet holds now (its intent is pinned; this is the last check). */
export const sameIntent = (built: any, now: any): boolean => !!built && !!now && JSON.stringify(built.intent ?? null) === JSON.stringify(now.intent ?? null)
  && built.account?.id === now.account?.id && built.type === now.type && built.network === now.network && built.agent?.id === now.agent?.id;

export async function signRequest(id: string, addressChecked: boolean, buildId?: string): Promise<{ status: string; view?: PreparedView; resent?: boolean }> {
  const s = await getSession();
  const e = s.requests?.[id];
  const req = await requestOf(id);
  if (!e || !req || req.status !== 'pending' || e.request.status !== 'pending' || e.local?.state === 'rejected') throw new Error('NOT_PENDING');
  if (req.expires_at && Date.parse(req.expires_at) <= Date.now()) throw new Error('REQUEST_EXPIRED');
  if (!req.expires_at && e.received_at + NO_EXPIRY_TTL_MS <= Date.now()) throw new Error('REQUEST_EXPIRED'); // no expires_at: 24 h from arrival
  if (await plaintextClosedFor(id)) throw new Error(`E2E_DOWNGRADE: ${tr('bg.e2eDowngrade')}`); // at sign time too
  if (!(await isE2EId(id)) && keyedAgent((await getSession()).unlocked?.vault, req.agent?.id)) throw new Error(`E2E_PLAINTEXT: ${tr('blk.plaintextFromServer')}`);
  const changed = async (v?: PreparedView) => ({ status: 'changed', view: v ? await decorate(id, v) : await prepareRequest(id) });
  // a signature made for this request that may still land is re-sent as is — no second transaction
  const rec = await liveSigned(id);
  if (req.type === 'swap') { const r = await signSwapRequest(id, { request: req }, buildId, rec); return r.status === 'changed' ? changed(r.view) : r; }
  if (isEvmRequest(req)) { const r = await signEvmRequest(id, { request: req }, addressChecked, buildId, rec); return r.status === 'changed' ? changed(r.view) : r; }
  let r2: SignedRec;
  if (rec) r2 = rec;
  else {
    const p = prepared.get(id);
    if (!p || !sameIntent(p.request, req)) return changed();
    const r = await signPrepared(p, addressChecked, buildId);
    if (r.status === 'changed') return changed(r.view);
    const pub = await getPublic();
    await approve(id, p, r.resource_plan); // before sending: request.pay may follow the ack immediately
    r2 = { key: id, kind: 'request', type: 'transfer', network: 'tron', at: Date.now(), until: p.prep.decoded.expiration, txids: [p.prep.txID], agent_id: req.agent?.id, to: p.prep.to, account_id: p.account_id,
      view: p.view, body: { request_id: id, decision: { by: 'human', rule: null, wallet_doc_version: pub?.doc_version ?? 0 }, signed: { network: 'tron', tx: r.tx }, resource_plan: r.resource_plan } };
  }
  await sendSigned(r2, () => decide('request.sign', r2.body));
  await markSigned(id, e.request);
  if (r2.to) await rememberRecipient(r2.to);
  return { status: 'signed', ...(rec ? { resent: true } : {}) };
}

/** After request.sign was taken: the queue entry is `signed` (an E2E one: the executor set its status). */
export async function markSigned(id: string, request: any): Promise<void> {
  if (!(await isE2EId(id))) await putRequest({ ...request, status: 'signed' });
  const s2 = await getSession();
  await patchSession({ requests: { ...s2.requests, [id]: { ...s2.requests![id], local: { state: 'signed' } } } });
  prepared.delete(id);
  await updateBadge();
}

const blockedViews = new Map<string, NonNullable<PreparedView['blocked']>>();

/** Reject from the window: a request that cannot be signed is refused with its reason (insufficient_balance,
 * resource_unavailable…, detail.code = RESOURCE_PAYMENT_FAILED etc.), otherwise "human". */
export async function rejectRequest(id: string, reason_code?: string, detail?: unknown): Promise<void> {
  const b = blockedViews.get(id);
  if (!reason_code) { reason_code = b?.reason_code ?? 'human'; detail = b ? { code: b.code, message: b.message, ...(b.detail ?? {}) } : undefined; }
  if (!['human', 'paused', 'type_not_allowed', 'build_failed', 'insufficient_balance', 'insufficient_gas', 'resource_unavailable', 'resource_above_max', 'network_not_trusted', 'unsafe'].includes(reason_code)) reason_code = 'unsafe';
  blockedViews.delete(id);
  await decide('request.reject', { request_id: id, reason_code, ...(detail ? { detail } : {}) });
  const s = await getSession();
  const e = s.requests?.[id];
  if (e) await patchSession({ requests: { ...s.requests, [id]: { ...e, local: { state: 'rejected' } } } });
  prepared.delete(id);
  await updateBadge();
}

/** request.seen goes only for the Signer's own requests (an E2E id would tell it what the human reads now). */
export async function markSeen(id: string): Promise<void> {
  if ((await isE2EId(id)) || (await getSession()).requests?.[id]?.request?.e2e) return;
  try { socket.raw({ type: 'request.seen', id: `v${Date.now()}`, request_id: id }); } catch (e) { console.warn('[agent-wallet] seen:', (e as Error)?.message ?? e); }
}

// ---- own transfer by the human (own.submit) ----
export async function ownPrepare(account_id: string, asset: 'TRX' | 'USDT', to: string, amount: string): Promise<PreparedView> {
  await assertOwnAllowed(); // not under a downgrade
  const key = randomId('own');
  return (await build('own', key, account_id, { asset, to, amount, resources: { route: 'auto', payment: { method: 'x402_base' } } })).view;
}

export async function ownSign(own_id: string, addressChecked: boolean, buildId?: string): Promise<{ status: string; view?: PreparedView; request_id?: string }> {
  const p = prepared.get(own_id);
  if (!p) throw new Error('NOT_FOUND: prepare again');
  // the same transaction again after an unanswered own.submit, never a second one
  let rec = await liveSigned(own_id);
  if (!rec) {
    const r = await signPrepared(p, addressChecked, buildId);
    if (r.status === 'changed') return r;
    const summary = `${p.prep.asset} ${p.prep.amount} → ${p.prep.to}`;
    rec = { key: own_id, kind: 'own', type: 'transfer', network: 'tron', own_type: 'own.submit', at: Date.now(), until: p.prep.decoded.expiration, txids: [p.prep.txID], to: p.prep.to, account_id: p.account_id,
      body: { account: p.account_id, network: 'tron', signed: { network: 'tron', tx: r.tx }, summary, resource_plan: r.resource_plan, intent: { asset: p.prep.asset, to: p.prep.to, amount: formatUnits(BigInt(p.prep.amount_raw), 6) } } };
  }
  const rr = rec;
  const ack = await sendSigned(rr, () => ownSubmit(rr.own_type!, rr.body));
  const rid: string | undefined = ack.request_id ?? ack.request?.request_id;
  if (rid) await approve(rid, p, rr.body.resource_plan);
  if (rid) {
    // own transfers in the account history (the Signer's request.update keeps the status current)
    const { pub } = await requireUnlocked();
    const acc = pub.accounts.find((a) => a.id === p.account_id);
    await putRequest({ request_id: rid, own: true, type: 'transfer', network: 'tron', status: ack.request?.status && ack.request.status !== 'pending' ? ack.request.status : 'signed', account: { id: p.account_id, name: acc?.name ?? '' },
      intent: { asset: p.prep.asset, to: p.prep.to, amount: formatUnits(BigInt(p.prep.amount_raw), 6) }, created_at: new Date().toISOString() });
    await markOwnLocal(rid);
  }
  prepared.delete(own_id);
  await rememberRecipient(p.prep.to);
  return { status: 'submitted', request_id: rid };
}

/** an own operation is marked as such by the wallet itself (the Signer's `own` flag is not trusted for history). */
export async function markOwnLocal(rid: string): Promise<void> {
  const s = await getSession();
  const e = s.requests?.[rid];
  if (e) await patchSession({ requests: { ...s.requests, [rid]: { ...e, own_local: true } } });
}

/** Approvals that can no longer pay (expired) are dropped whenever a new one is written. */
export function pruneApprovals(all: Record<string, Approval> | undefined, now = Date.now()): Record<string, Approval> {
  return Object.fromEntries(Object.entries(all ?? {}).filter(([, a]) => !(a.expires_at && now > a.expires_at + 60_000) && now - a.created_at < 86_400_000));
}

// ---- request.pay: our gateway's 402 for the resource, signed without a second window within the approved ceiling ----
const PRODUCT_PATHS: Record<'proxy' | 'direct', RegExp[]> = {
  proxy: [/\/x402\/v1\/tron\/send$/],
  direct: [/\/x402\/v1\/tron\/activate$/, /\/x402\/v1\/tron\/energy$/, /\/x402\/v1\/tron\/bandwidth$/],
};

/**
 * A 402 of our gateway for a TRON resource, paid without a second window within the approved ceiling: payTo from
 * the built-in list, the product of the approved route, the running total ≤ the ceiling. The same 402 again (pay_id)
 * gets the same signature, counted once. Throws `<reason_code>: <message>` when it may not be paid. Used by the Signer's
 * request.pay (old mode) and by the E2E executor, which talks to the gateway itself.
 */
export async function approvePayment(m: { request_id: string; parent_request_id?: string; step?: string; route?: string; purpose?: string; payment_required_raw: unknown; resource_url?: string; pay_id?: string }):
  Promise<{ payment_signature: string; payment_payload: unknown; payer?: string; amount_micro?: string; again?: boolean }> {
  const s = await getSession();
  const akey = approvalKey(m, s.approvals); // a swap step pays under its parent's approval
  const a = s.approvals?.[akey];
  if (!a) throw new Error('unsafe: no approval for this request');
  // 0.3.2: an approval lives as long as its TRON transaction can still be sent, and closes with its request
  if (a.expires_at && Date.now() > a.expires_at) throw new Error('unsafe: the approval expired with its transaction');
  const owner = a.req_id ? await requestOf(a.req_id) : undefined;
  if (owner && isFinal(owner.status)) {
    const all = { ...((await getSession()).approvals ?? {}) };
    delete all[akey];
    await patchSession({ approvals: all });
    throw new Error(`unsafe: the request is already ${owner.status}`);
  }
  const route = (m.route ?? a.route) as 'proxy' | 'direct';
  if (route !== a.route && route !== a.fallback_route) throw new Error(`unsafe: route ${route} was not approved`);
  if (m.purpose && m.purpose !== 'resources') throw new Error('unsafe: purpose');
  const pr = decodePaymentRequired(m.payment_required_raw);
  const url = String(m.resource_url ?? pr.resource?.url ?? '');
  let path = '';
  try { path = new URL(url).pathname; } catch { /* bad url */ }
  if (!PRODUCT_PATHS[route].some((rx) => rx.test(path))) throw new Error(`unsafe: resource ${url} is not a ${route} product`);
  const terms = pickResourceTerms(pr);
  // what the resource is for: when the gateway names it in the 402 (extra.address / extra.txid), it must be ours
  const ex: any = terms.requirement.extra ?? {};
  if (ex.address !== undefined && a.addresses && !a.addresses.includes(String(ex.address))) throw new Error(`unsafe: the resource is for ${String(ex.address)}, not for this transfer`);
  if ((ex.txid ?? ex.txID) !== undefined && a.txID && String(ex.txid ?? ex.txID).toLowerCase() !== a.txID.toLowerCase()) throw new Error('unsafe: the resource is for another transaction');
  const payId: string | undefined = m.pay_id;
  const again = payId ? a.pays?.[payId] : undefined;
  if (again) return { payment_signature: again.payment_signature, payment_payload: again.payment_payload, amount_micro: again.amount_micro, again: true };
  const paid = BigInt(a.paid_micro[route] ?? '0');
  const cap = BigInt(a.caps_micro[route] ?? '0');
  if (paid + terms.amountMicro > cap) throw new Error(`resource_above_max: ${formatUnits(paid + terms.amountMicro, 6)} USDC > approved ${formatUnits(cap, 6)}`);
  // the main and the fallback route share one ceiling — the larger of the two, never their sum
  const paidAll = Object.values(a.paid_micro).reduce((x, v) => x + BigInt(v ?? '0'), 0n);
  const capAll = Object.values(a.caps_micro).reduce((x, v) => (BigInt(v ?? '0') > x ? BigInt(v ?? '0') : x), 0n);
  if (paidAll + terms.amountMicro > capAll) throw new Error(`resource_above_max: ${formatUnits(paidAll + terms.amountMicro, 6)} USDC in all routes > approved ${formatUnits(capAll, 6)}`);
  const { account, keys } = await accountKeys(a.account_id);
  const signed = await signResourcePayment(pr, terms, keys.evmKey);
  a.paid_micro[route] = (paid + terms.amountMicro).toString();
  if (payId) a.pays = { ...(a.pays ?? {}), [payId]: { route, amount_micro: terms.amountMicro.toString(), payment_signature: signed.payment_signature, payment_payload: signed.payment_payload } };
  await patchSession({ approvals: { ...((await getSession()).approvals ?? {}), [akey]: a } });
  return { payment_signature: signed.payment_signature, payment_payload: signed.payment_payload, payer: account.addresses.evm, amount_micro: terms.amountMicro.toString() };
}

export async function onRequestPay(m: any): Promise<void> {
  // an E2E request is paid only by our own executor (it talks to the gateway itself); under E2E the Signer
  // never asks the wallet to pay anything
  if ((await isE2EId(String(m?.request_id ?? ''))) || (m?.parent_request_id && (await isE2EId(String(m.parent_request_id)))) || (await plaintextPolicy()) === 'closed') {
    socket.ack(m?.id, false, { code: 'unsafe', message: 'request.pay is not accepted for this request' });
    return;
  }
  if (!(await isUnlocked())) {
    // keep it until the human unlocks (the TRON transaction expires by itself if nobody does)
    const s = await getSession();
    const rest = (s.pendingPays ?? []).filter((x) => !(m.pay_id && x.pay_id === m.pay_id));
    // bounded; beyond it nothing is kept or acked (the Signer asks again)
    if (rest.length >= MAX_PENDING_PAYS || JSON.stringify(m).length > MAX_REQUEST_BYTES) { console.warn('[agent-wallet] request.pay not kept (limit)'); return; }
    await patchSession({ pendingPays: [...rest, m] });
    notify(`pay:${m.request_id}`, PRODUCT_NAME, tr('bg.payWaitsUnlock'));
    return;
  }
  const refuse = async (reason_code: string, message: string) => {
    socket.ack(m.id, false, { code: reason_code, message });
    await socket.request('request.reject', { request_id: m.request_id, reason_code, detail: { stage: 'pay', pay_id: m.pay_id, message } }).catch(() => {});
  };
  try {
    const r = await approvePayment(m);
    socket.ack(m.id, true);
    await socket.request('request.pay_signed', { request_id: m.request_id, ...(m.pay_id ? { pay_id: m.pay_id } : {}), payment_signature: r.payment_signature, payment_payload: r.payment_payload, ...(r.again ? {} : { payer: r.payer }) });
  } catch (e) {
    const msg = (e as Error).message;
    const mm = /^(unsafe|resource_above_max): (.*)$/.exec(msg);
    await refuse(mm ? mm[1] : 'unsafe', mm ? mm[2] : msg);
  }
}

export async function drainPendingPays(): Promise<void> {
  const s = await getSession();
  const list = s.pendingPays ?? [];
  if (!list.length) return;
  await patchSession({ pendingPays: [] });
  for (const m of list) await onRequestPay(m);
}
