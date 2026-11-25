// Signer session: sign-in by signature, WebSocket, wallet document sync, agents.
import networksCfg from '../config/networks.json';
import { checkChallenge, hostOf, signChallenge, type Challenge } from '../lib/signer/auth';
import { HttpError, postJSON } from '../lib/net';
import { checkPowTask, solvePow, type PowProgress } from '../lib/signer/pow';
import { normalizeInvite, readRegistration } from '../lib/signer/invite';
import { buildDoc, signDoc, validWalletId } from '../lib/wallet/doc';
import { stripBidi } from '../lib/text';
import { ALL_TYPES, newTypesOf, rootAccount, type AgentEntry, type VaultData } from '../lib/wallet/model';
import { LEGACY_MCP_NAME, claudeAdd, mcpJson, mcpNameFor, type LaunchChoice } from '../lib/agentConnect';
import type { AgentConnectView, AgentPatch } from '../shared/api';
import { getPublic, getSession, patchSession, clearSessionKeys, setPublic, type SignerSession } from './store';
import { SignerSocket } from './ws';
import { bindServerKeys, e2eActive, getServerMode, neutralName, newPairing, plaintextPolicy, syncE2EDoc } from './e2e';
import { DEFAULT_LAUNCH, isMcpLaunch, type McpLaunch } from '../lib/wallet/model';
import { bg } from './safe';
import { isUnlocked, requireUnlocked, rootKeys, updateVault } from './wallet';
import { t as tr } from '../i18n';

export const EXT_VERSION = chrome.runtime.getManifest().version;

let sessionCache: SignerSession | undefined;
let urlCache = '';
let wsHandler: (m: any) => Promise<void> = async () => {};
let stateListener: () => void = () => {};

export const socket = new SignerSocket(() => urlCache, () => sessionCache?.session, (m) => wsHandler(m), (c) => { if (c) bg('state', sendState); stateListener(); },
  () => bg('wallet blocked', markBlocked));

export function setHandlers(h: { onMessage: (m: any) => Promise<void>; onChange: () => void }) { wsHandler = h.onMessage; stateListener = h.onChange; }

export async function loadSession(): Promise<SignerSession | undefined> {
  const s = await getSession();
  const pub = await getPublic();
  urlCache = pub?.settings.signer_url ?? urlCache;
  sessionCache = s.signer && Date.parse(s.signer.expires_at) > Date.now() + 60_000 && s.signer.signer_url === urlCache ? s.signer : undefined;
  return sessionCache;
}
export const currentSession = () => sessionCache?.session;
export const signerUrl = () => urlCache;

/** Registration on a Signer with proof of work: what the pages show while it is solved. */
let registering: (PowProgress & { started_at: number }) | null = null;
export const registeringView = () => (registering ? { ...registering } : null);

/**
 * Invite-only registration: the Signer said this root pair needs an invite code (the Settings page shows the
 * field «Invite code»), or that it registers nobody. Kept in memory only, for the Signer it was learnt from; the
 * code itself is never stored — it is passed to signIn() and forgotten.
 */
let registration: { url: string; mode: 'invite' | 'closed' } | null = null;
/** the Signer operator blocked this wallet — no reconnects until the human signs in again by hand. */
let blocked: { url: string } | null = null;
export const registrationView = () => ({
  invite_required: registration?.url === urlCache && registration.mode === 'invite',
  registration_closed: registration?.url === urlCache && registration.mode === 'closed',
  blocked: blocked?.url === urlCache,
});

/** the wallet is blocked (WebSocket `wallet.blocked` / close 4403, or verify 403 WALLET_BLOCKED): forget the session. */
export async function markBlocked(): Promise<void> {
  blocked = { url: urlCache };
  socket.lastError = `WALLET_BLOCKED: ${tr('bg.walletBlocked')}`;
  socket.close();
  sessionCache = undefined;
  await clearSessionKeys(['signer']);
  stateListener();
}

/** A Signer's HTTP refusal in words the human can act on (421 / 429 / 503 / 507, PoW, invites). */
function signInError(e: unknown): Error {
  if (!(e instanceof HttpError)) return e as Error;
  const inv: Record<string, string> = { INVITE_REQUIRED: tr('bg.inviteRequired'), INVITE_INVALID: tr('bg.inviteInvalid'), REGISTRATION_CLOSED: tr('bg.registrationClosed'), WALLET_BLOCKED: tr('bg.walletBlocked') };
  const why = inv[e.code] ?? (e.status === 421 ? tr('bg.signer421') : e.status === 507 ? tr('bg.signer507') : e.status === 429 ? tr('bg.signer429')
    : e.code === 'WALLETS_LIMIT' ? tr('bg.signerWalletsLimit') : e.message);
  return new Error(`${e.code}: ${why}`);
}

/**
 * challenge → check the text → (invite / PoW when registering) → TIP-191 + EIP-191 by the root account →
 * verify → session (24 h). `invite` — the code the human typed (only sent when the Signer asks for one).
 */
export async function signIn(invite?: string): Promise<SignerSession> {
  for (let attempt = 0; ; attempt++) {
    try { return await signInOnce(invite); }
    catch (e) {
      // a PoW refusal burns the challenge — one more round with a new challenge and a new task
      if (attempt === 0 && e instanceof HttpError && (e.code === 'POW_REQUIRED' || e.code === 'POW_INVALID')) continue;
      if (e instanceof HttpError) {
        if (e.code === 'INVITE_REQUIRED' || e.code === 'INVITE_INVALID') registration = { url: urlCache, mode: 'invite' };
        if (e.code === 'REGISTRATION_CLOSED') registration = { url: urlCache, mode: 'closed' };
        if (e.code === 'WALLET_BLOCKED') { blocked = { url: urlCache }; socket.close(); }
        stateListener();
      }
      throw signInError(e);
    }
  }
}

async function signInOnce(invite?: string): Promise<SignerSession> {
  const pub = await getPublic();
  if (!pub) throw new Error('NO_WALLET');
  urlCache = pub.settings.signer_url.replace(/\/+$/, '');
  const { account, keys } = await rootKeys();
  const tron = account.addresses.tron!, evm = account.addresses.evm!;
  const ch = (await postJSON(`${urlCache}/v1/ext/auth/challenge`, { tron_address: tron, evm_address: evm, extension_id: chrome.runtime.id })) as Challenge & { pow?: unknown; registration?: unknown };
  checkChallenge(ch, { host: hostOf(urlCache), extensionId: chrome.runtime.id, tron, evm });
  // a root pair without a wallet on an invite-only (or closed) Signer — asked before any signature or PoW
  const reg = readRegistration(ch.registration);
  let code: string | undefined;
  if (reg?.mode === 'closed') throw new HttpError(403, 'REGISTRATION_CLOSED', 'registration closed');
  if (reg?.invite_required) {
    if (!invite?.trim()) throw new HttpError(403, 'INVITE_REQUIRED', 'invite required');
    code = normalizeInvite(invite) ?? undefined;
    if (!code) throw new HttpError(403, 'INVITE_INVALID', 'not an invite code');
  }
  let pow_nonce: string | undefined;
  if (ch.pow !== undefined && ch.pow !== null) {
    const task = checkPowTask(ch.pow); // > POW_MAX_BITS → refused as hostile
    registering = { bits: task.bits, tried: 0, expected: 2 ** task.bits, started_at: Date.now() };
    stateListener();
    let shown = 0;
    try {
      pow_nonce = await solvePow(task, ch.nonce, {
        deadline: Date.parse(task.expires_at ?? ch.expires_at),
        onProgress: (p) => { registering = { ...p, started_at: registering?.started_at ?? Date.now() }; if (Date.now() - shown > 500) { shown = Date.now(); stateListener(); } },
      });
    } finally { registering = null; stateListener(); }
  }
  const sig = await signChallenge(ch.message, keys);
  const r = await postJSON(`${urlCache}/v1/ext/auth/verify`, { nonce: ch.nonce, ...sig, ...(pow_nonce !== undefined ? { pow_nonce } : {}), ...(code ? { invite: code } : {}) });
  if (typeof r?.session !== 'string' || !r.session.startsWith('agws_')) throw new Error('verify: no session');
  if (!validWalletId(r.wallet_id)) throw new Error('verify: bad wallet_id'); // it goes into signed texts
  const ses: SignerSession = { session: r.session, wallet_id: r.wallet_id, expires_at: r.expires_at, signer_url: urlCache };
  sessionCache = ses;
  registration = null; blocked = null; // the code is not kept anywhere
  await patchSession({ signer: ses });
  const p2 = (await getPublic())!;
  if (p2.wallet_id !== r.wallet_id) { p2.wallet_id = r.wallet_id; await setPublic(p2); }
  return ses;
}

/** Sign in when needed and open the WebSocket; `invite` only for the first sign-in on an invite-only Signer. */
export async function connect(invite?: string): Promise<void> {
  if (!(await loadSession())) {
    if (!(await isUnlocked())) throw new Error('LOCKED: unlock to sign in to the Signer');
    await signIn(invite);
  }
  socket.connect();
}

export async function disconnect(): Promise<void> {
  socket.close();
  helloDocService = false;
  sessionCache = undefined;
  await clearSessionKeys(['signer']);
}

export async function sendState(): Promise<void> {
  if (!socket.connected) return;
  const pub = await getPublic();
  socket.raw({ type: 'state', id: `s${Date.now()}`, unlocked: await isUnlocked(), version: EXT_VERSION, wallet_doc_version: pub?.doc_version ?? 0 });
}

/**
 * 0.3.2: the host the wallet document is signed for. A Signer that announced `doc_service` in hello gets the form with «Service:»; its origin is remembered, and a later hello without the flag
 * there is a downgrade — no document then. An older Signer (never announced) gets the old text (it would refuse the new).
 */
let helloDocService = false;
const originOfUrl = (u: string) => { try { return new URL(u).origin; } catch { return ''; } };
export async function docService(): Promise<string | undefined> {
  const pub = await getPublic();
  const pinned = (pub?.doc_service_pins ?? []).includes(originOfUrl(urlCache));
  if (helloDocService) return hostOf(urlCache);
  if (pinned) throw new Error('DOC_SERVICE_DOWNGRADE: this Signer used to accept documents bound to it and now does not — not sent');
  return undefined;
}

/** hello: wallet id, the version the Signer has, its network registry (shown yellow where it differs from ours). */
export async function onHello(m: any): Promise<void> {
  helloDocService = m?.doc_service === true;
  if (helloDocService) {
    const p0 = await getPublic();
    const o = originOfUrl(urlCache);
    if (p0 && o && !(p0.doc_service_pins ?? []).includes(o)) await setPublic({ ...p0, doc_service_pins: [...(p0.doc_service_pins ?? []), o].slice(-16) });
  }
  const pub = await getPublic();
  if (m.wallet_id !== undefined && !validWalletId(m.wallet_id)) { console.warn('[agent-wallet] hello: bad wallet_id ignored'); m = { ...m, wallet_id: undefined }; }
  if (pub && m.wallet_id && pub.wallet_id !== m.wallet_id) { pub.wallet_id = m.wallet_id; await setPublic(pub); }
  const diff: string[] = [];
  for (const n of (m.networks ?? []) as any[]) {
    const mine = networksCfg.networks.find((x) => x.network === n.network);
    if (!mine) { diff.push(tr('bg.diffNewNetwork', { net: n.network })); continue; }
    for (const t of (n.tokens ?? []) as any[]) {
      const mt = mine.tokens.find((x) => x.symbol === t.symbol);
      if (!mt) diff.push(tr('bg.diffNewToken', { net: n.network, sym: t.symbol }));
      else if (String(mt.address).toLowerCase() !== String(t.address).toLowerCase() || mt.decimals !== t.decimals) diff.push(tr('bg.diffToken', { net: n.network, sym: t.symbol }));
    }
    if ('chain_id' in mine && n.chain_id !== undefined && n.chain_id !== (mine as any).chain_id) diff.push(tr('bg.diffChainId', { net: n.network }));
  }
  await patchSession({ serverNetworksDiff: diff, signerSeenDocVersion: Number(m.wallet_doc_version_seen ?? 0) });
  if ((pub?.doc_version ?? 0) > Number(m.wallet_doc_version_seen ?? 0) || !m.wallet_doc_version_seen) await syncDoc().catch((e) => console.warn('wallet.sync', e));
}

/** build, sign by the root, send; version = max(ours, Signer's) + 1. Needs an unlocked wallet. */
export async function syncDoc(): Promise<void> {
  if (!socket.connected || !(await isUnlocked())) return;
  if (await e2eActive()) return syncE2EDoc(); // no rules, book or names for the Signer
  // E2E wanted but the Signer says off (or not yet) — the document never goes in plaintext
  if ((await plaintextPolicy()) === 'closed') throw new Error(`E2E_DOWNGRADE: ${tr('bg.e2eDowngrade')}`);
  const { vault, pub } = await requireUnlocked();
  const s = await getSession();
  const walletId = pub.wallet_id ?? s.signer?.wallet_id;
  if (!walletId) return;
  const version = Math.max(pub.doc_version, s.signerSeenDocVersion ?? 0) + 1;
  const { keys } = await rootKeys();
  const signed = await signDoc(buildDoc(walletId, version, pub.accounts, vault, new Date(), await docService()), keys); // + Service
  await socket.request('wallet.sync', { doc: signed.doc, digest: signed.digest, sig_evm: signed.sig_evm, sig_tron: signed.sig_tron });
  const p2 = (await getPublic())!; // the state as it is after the network wait, not the copy from before it
  p2.doc_version = version;
  p2.doc_digest = signed.digest;
  await setPublic(p2);
  await patchSession({ signerSeenDocVersion: version });
}

/** the token is returned to the page once and never stored. */
/** What identifies a token without revealing it: `aw_<agent_id>_` + 4 characters (the Signer's own prefix when given). */
const prefixOf = (id: string, token: string, server?: unknown) => (typeof server === 'string' && token.startsWith(server) ? server : token.slice(0, `aw_${id}_`.length + 4));

/** The MCP server names of the other live agents (a new name must not collide with them on one machine). */
const takenMcpNames = (v: VaultData, except?: string) =>
  Object.entries(v.agents).filter(([id, a]) => id !== except && !a.revoked_at).map(([, a]) => a.mcp_name ?? LEGACY_MCP_NAME);

/** How the agent's machine starts the MCP server — the last choice in the extension settings (local). */
async function launchChoice(): Promise<LaunchChoice> {
  const st = (await getPublic())?.settings;
  const kind = st?.mcp_launch;
  return { kind: isMcpLaunch(kind) ? kind : DEFAULT_LAUNCH, path: st?.mcp_launch_path ?? '' };
}

/** The token shown once + what to run on the agent's side (the page rebuilds the commands when the launch changes). */
async function connectView(id: string, a: AgentEntry, token: string, oldMcpName?: string, launchOverride?: McpLaunch): Promise<AgentConnectView> {
  const url = urlCache;
  const name = a.mcp_name ?? LEGACY_MCP_NAME;
  const base = await launchChoice();
  const launch = launchOverride ? { kind: launchOverride, path: launchOverride === base.kind ? base.path : '' } : base;
  const pub = await getPublic();
  const e2eOn = await e2eActive();
  const e2e = e2eOn && pub?.e2e_key && (launch.kind === 'npx' || launch.kind === 'remote')
    ? { wallet: pub.e2e_key.bundle, ...(pub.wallet_id ? { wallet_id: pub.wallet_id } : {}), ...(launch.kind === 'npx' && a.pairing?.code ? { pair: a.pairing.code } : {}) } : undefined;
  const c = { name, url, token, launch, e2e };
  return { id, name: a.name, token, mcp_name: name, old_mcp_name: oldMcpName ?? null, signer_url: url, claude: claudeAdd(c), mcp: mcpJson(c), launch: launch.kind,
    ...(e2eOn && pub?.e2e_key && e2e ? { e2e: { wallet_fp: pub.e2e_key.fp, wallet_key: pub.e2e_key.bundle, ...(pub.wallet_id ? { wallet_id: pub.wallet_id } : {}), ...(e2e.pair ? { pair: e2e.pair } : {}), pair_expires_at: a.pairing?.expires_at, key_mode: a.e2e?.mode ?? (launch.kind === 'remote' ? 'server' : 'agent'), agent_fp: a.e2e?.fp } } : {}) };
}

/** E2E launch kinds: npx = the key at the agent (a pairing code), remote = the key at the server. */
const keyModeOf = (l: McpLaunch | undefined): 'agent' | 'server' | null => (l === 'npx' ? 'agent' : l === 'remote' ? 'server' : null);

/** a new agent — every type this version knows (each signature is the human's), its own MCP name. The token is returned once. */
export async function createAgent(name: string, accounts: string[], launch?: McpLaunch): Promise<AgentConnectView> {
  const { vault, pub } = await requireUnlocked();
  const n = stripBidi(name).trim();
  if (n.length < 1 || n.length > 48) throw new Error('BAD_NAME');
  const live = new Set(pub.accounts.filter((a) => !a.removed_at).map((a) => a.id));
  const accs = accounts.filter((a) => live.has(a));
  if (!accs.length) { const root = rootAccount(pub.accounts, vault.secrets); if (root) accs.push(root.id); }
  const e2e = await e2eActive();
  if (!e2e && (await plaintextPolicy()) === 'closed') throw new Error(`E2E_DOWNGRADE: ${tr('bg.e2eDowngrade')}`); // no real names in plaintext
  const km = e2e ? keyModeOf(launch ?? (await launchChoice()).kind) : null;
  if (e2e && !km && getServerMode() === 'required') throw new Error('E2E_REQUIRED: this Signer accepts only agents with a key (npx or remote MCP)');
  if (!e2e && launch === 'remote') throw new Error('E2E_UNAVAILABLE: remote MCP needs end-to-end encryption (public Signer or E2E on your own)');
  // E2E: the server knows a neutral name only; the real one is in the encrypted view
  const serverName = e2e ? neutralName() : n;
  const ack = await socket.request('agent.create', { name: serverName, accounts: accs, ...(km ? { key_mode: km } : {}) });
  const agent = ack.agent ?? {};
  const token: string = ack.token;
  if (!agent.id || typeof token !== 'string') throw new Error('agent.create: bad answer');
  const entry: AgentEntry = { name: e2e ? n : agent.name ?? n, accounts: accs, allowed_types: [...ALL_TYPES],
    created_at: new Date().toISOString(), token_prefix: prefixOf(agent.id, token, agent.token_prefix), known_types: [...ALL_TYPES], mcp_name: '',
    ...(e2e ? { server_name: serverName } : {}) };
  if (km === 'server') bindServerKeys(entry, ack);
  if (km === 'agent') newPairing(entry);
  // the ack may come late (the Signer decides) — the agent is added to the vault as it is NOW
  await updateVault((v) => {
    if (Object.prototype.hasOwnProperty.call(v.agents, agent.id)) throw new Error('agent.create: the Signer returned an id that already exists');
    entry.mcp_name = mcpNameFor(n, agent.id, takenMcpNames(v));
    v.agents[agent.id] = entry;
  });
  await syncDoc().catch((e) => console.warn('wallet.sync', e));
  return connectView(agent.id, entry, token, undefined, launch);
}

/**
 * «Connect key»: an agent of the old way (or one whose key must change) gets a key — npx: a new token
 * (agent.rotate) + a pairing code; remote: agent.rotate with key_mode server (new token and server keys).
 */
export async function connectAgentE2E(id: string, launch: 'npx' | 'remote'): Promise<AgentConnectView> {
  if (!(await e2eActive())) throw new Error('E2E_UNAVAILABLE: end-to-end encryption is off or the Signer does not support it');
  const { vault } = await requireUnlocked();
  const ag = vault.agents[id];
  if (!ag || ag.revoked_at) throw new Error('UNKNOWN_AGENT');
  const km = keyModeOf(launch)!;
  const ack = await socket.request('agent.rotate', { agent_id: id, key_mode: km });
  const token: string = ack.token;
  if (typeof token !== 'string' || !token.startsWith(`aw_${id}_`)) throw new Error('agent.rotate: bad answer');
  let old = LEGACY_MCP_NAME;
  let entry!: AgentEntry;
  await updateVault((v) => { // applied to the vault as it is after the ack
    const a = v.agents[id];
    if (!a || a.revoked_at) throw new Error('UNKNOWN_AGENT');
    old = a.mcp_name ?? LEGACY_MCP_NAME;
    if (!a.mcp_name) a.mcp_name = mcpNameFor(a.name, id, takenMcpNames(v, id));
    a.token_prefix = prefixOf(id, token, ack.agent?.token_prefix);
    delete a.e2e;
    if (km === 'server') bindServerKeys(a, ack); else newPairing(a);
    entry = a;
  });
  await syncDoc().catch((e) => console.warn('wallet.sync', e));
  return connectView(id, entry, token, old, launch);
}

/**
 * «Re-issue token» (agent.rotate): the same agent, a new token shown once; the old one stops working at once.
 * An agent of ≤ 0.2.0 (MCP name `agent-wallet`) gets its own name now: the replace command removes the old one.
 */
export async function rotateAgent(id: string): Promise<AgentConnectView> {
  const { vault } = await requireUnlocked();
  const ag = vault.agents[id];
  if (!ag || ag.revoked_at) throw new Error('UNKNOWN_AGENT');
  const km = (await e2eActive()) ? ag.e2e?.mode ?? null : null;
  const ack = await socket.request('agent.rotate', { agent_id: id, ...(km ? { key_mode: km } : {}) });
  const token: string = ack.token;
  if (typeof token !== 'string' || !token.startsWith(`aw_${id}_`)) throw new Error('agent.rotate: bad answer');
  let old = LEGACY_MCP_NAME;
  let entry!: AgentEntry;
  await updateVault((v) => { // applied to the vault as it is after the ack
    const a = v.agents[id];
    if (!a || a.revoked_at) throw new Error('UNKNOWN_AGENT');
    old = a.mcp_name ?? LEGACY_MCP_NAME;
    if (!a.mcp_name) a.mcp_name = mcpNameFor(a.name, id, takenMcpNames(v, id));
    a.token_prefix = prefixOf(id, token, ack.agent?.token_prefix);
    // rotation: remote MCP — the server changed its keys too; npx — the agent pairs again with a new code
    if (km === 'server' && ack.agent_keys) bindServerKeys(a, ack);
    if (km === 'agent') { delete a.e2e; newPairing(a); }
    entry = a;
  });
  if (km) await syncDoc().catch((e) => console.warn('wallet.sync', e));
  return connectView(id, entry, token, old, km === 'agent' ? 'npx' : km === 'server' ? 'remote' : undefined);
}

/** Revoke now; the answer names the MCP connection to remove on the agent's side. */
export async function revokeAgent(id: string): Promise<{ mcp_name: string }> {
  await requireUnlocked();
  await socket.request('agent.revoke', { agent_id: id });
  let mcp = LEGACY_MCP_NAME;
  await updateVault((v) => { const ag = v.agents[id]; if (!ag) return false; ag.revoked_at ??= new Date().toISOString(); mcp = ag.mcp_name ?? LEGACY_MCP_NAME; });
  await syncDoc().catch((e) => console.warn('wallet.sync', e));
  return { mcp_name: mcp };
}

export async function setAgentAccounts(id: string, accounts: string[]): Promise<void> {
  await updateAgent(id, { accounts });
}

/**
 * «Add account» → «Give agents access» : the new account joins the accounts of the ticked agents
 * (appended — each agent's default account stays first) in ONE
 * wallet document update, the same path as «Agent settings». Everything is checked before anything changes: no
 * connection, an unknown / revoked agent or a hidden account → nothing is saved (the account itself already exists).
 */
export async function bindAccountToAgents(accountId: string, agentIds: string[]): Promise<{ bound: string[] }> {
  const ids = [...new Set(agentIds)];
  if (!ids.length) return { bound: [] };
  if (!socket.connected) throw new Error(`NOT_CONNECTED: ${tr('bg.needSignerAgent')}`);
  await updateVault((vault, pub) => {
    if (!pub.accounts.some((a) => a.id === accountId && !a.removed_at)) throw new Error('UNKNOWN_ACCOUNT');
    for (const id of ids) if (!vault.agents[id] || vault.agents[id].revoked_at) throw new Error(`UNKNOWN_AGENT: ${id}`);
    for (const id of ids) {
      const ag = vault.agents[id];
      if (!ag.accounts.includes(accountId)) ag.accounts = [...ag.accounts, accountId];
    }
  });
  await syncDoc();
  return { bound: ids };
}

/**
 * «Agent settings»: name, accounts (first = default), allowed types. Everything goes into the wallet document, which
 * the Signer applies at once — so a change needs the connection (nothing is kept half-synced).
 */
export async function updateAgent(id: string, p: AgentPatch): Promise<void> {
  if (!socket.connected) throw new Error(`NOT_CONNECTED: ${tr('bg.needSignerAgent')}`);
  await updateVault((vault, pub) => {
  const ag = vault.agents[id];
  if (!ag || ag.revoked_at) throw new Error('UNKNOWN_AGENT');
  if (p.name !== undefined) {
    const n = stripBidi(p.name).trim();
    if (n.length < 1 || n.length > 48) throw new Error('BAD_NAME');
    ag.name = n;
  }
  if (p.accounts !== undefined) {
    const live = new Set(pub.accounts.filter((a) => !a.removed_at).map((a) => a.id));
    const accs = [...new Set(p.accounts)].filter((a) => live.has(a));
    if (!accs.length) throw new Error('NO_ACCOUNTS');
    ag.accounts = accs;
  }
  if (p.allowed_types !== undefined) {
    const want = new Set(p.allowed_types);
    ag.allowed_types = ALL_TYPES.filter((t) => want.has(t));
    ag.known_types = [...ALL_TYPES];
  }
  });
  await syncDoc();
}

/**
 * Migration prompt (0.2.1): types this version added since the agent was set up are shown once; only those the human
 * ticks are allowed — nothing is widened silently. Answered (even «nothing») → not asked again.
 */
export async function answerNewTypes(id: string, allow: string[]): Promise<void> {
  let add: string[] = [];
  await updateVault((vault) => {
    const ag = vault.agents[id];
    if (!ag) throw new Error('UNKNOWN_AGENT');
    const fresh = newTypesOf(ag);
    add = fresh.filter((t) => allow.includes(t));
    if (add.length && !socket.connected) throw new Error(`NOT_CONNECTED: ${tr('bg.needSignerPermission')}`);
    ag.allowed_types = ALL_TYPES.filter((t) => ag.allowed_types.includes(t) || add.includes(t));
    ag.known_types = [...ALL_TYPES]; // every type of this version has now been put to the human
  });
  if (add.length) await syncDoc();
}

/**
 * agent.list: server facts (last use, revoked) merged into the local list of KNOWN agents. Since 0.3.2 an agent
 * the Signer lists but the wallet document does not have is never added (that would let the server mint rights the
 * root key then signs) — it comes back marked `unknown: true` so the page can offer to revoke it.
 */
export async function refreshAgents(): Promise<any[]> {
  const ack = await socket.request('agent.list', {});
  const list: any[] = Array.isArray(ack?.agents) ? ack.agents : [];
  if (await isUnlocked()) await updateVault((vault) => { // merged into the vault as it is now
    let changed = false;
    for (const a of list) {
      const mine = typeof a?.id === 'string' && Object.prototype.hasOwnProperty.call(vault.agents, a.id) ? vault.agents[a.id] : undefined;
      if (!mine) {
        a.unknown = true;
      } else {
        if (a.revoked_at && !mine.revoked_at) { mine.revoked_at = a.revoked_at; changed = true; }
        if (typeof a.token_prefix === 'string' && a.token_prefix && a.token_prefix !== mine.token_prefix) { mine.token_prefix = a.token_prefix; changed = true; }
      }
    }
    return changed;
  });
  return list;
}
