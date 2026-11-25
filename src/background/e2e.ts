// The E2E mode in the service worker: the public Signer is a mailbox.
//  • wallet keys (Ed25519 + X25519) in the vault; the E2E wallet document and an encrypted `view` per agent;
//  • envelopes from agents: signature by the bound agent key → freshness / replay / idempotency → the request goes
//    into the same queue and sign window; pairing by the code that went through the human; `cancel`;
//  • statuses back to the agent as encrypted `status` / `error` / `paired` envelopes;
//  • the executor: what the Signer did after `request.sign` in the old mode (x402 payments with our gateway, Direct
//    delivery, Proxy tron/send, swap steps, the CCTP mint) is done here; the Signer only gets send jobs (`e2e.job`)
//    with signed bytes, the no-burn guard `need`, and tracks them (`e2e.job.update`).
import e2eCfg from '../config/e2e.json';
import swapCfg from '../config/swap.json';
import networksCfg from '../config/networks.json';
import { base64ToBytes, bytesToBase64, randomBytes, utf8 } from '../lib/bytes';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { b64u, bundleOf, checkShape, decrypt, fingerprint, fpOfBundle, generateKeys, newPairCode, nowAt, pairProof, parseBundle, sameString, seal, unb64u, verifyEnvelope, type Envelope } from '../lib/e2e/crypto';
import { Gateway, GwError, deliveredStatus, failedStatus, payFollow, type GwResult, type Offer } from '../lib/e2e/gateway';
import { bodyHash, buildE2EDoc, checkFresh, e2eDocDigest, envelopeHash, forAgent, normalizeRequest, rejectOutcome, SEEN_KEEP_MS, viewPayload } from '../lib/e2e/protocol';
import type { Known } from '../lib/e2e/reads';
import { requireNet, servedNets } from '../lib/evm/networks';
import { doneText, isFinal } from '../lib/op';
import { pruneE2EHistory } from '../lib/e2e/retention';
import { notifyPages } from './pages';
import { signEvmMessage, signTronMessage } from '../lib/sign';
import { normalizeTron } from '../lib/tron/address';
import { decodeRaw, signedTxHex } from '../lib/tron/tx';
import { keccak256 } from 'viem';
import { USDT_TRON } from '../lib/tron/chain';
import { docSignText } from '../lib/wallet/doc';
import type { AgentEntry, VaultData } from '../lib/wallet/model';
import type { E2EView } from '../shared/api';
import { onBridgeMint } from './evm';
import { PRODUCT_NAME, approvePayment, notify, readers, openSignWindow, putRequest, updateBadge, agentsPaused } from './requests';
import { docService, socket } from './signer';
import { t as tr, ta } from '../i18n';
import { getPublic, getSession, patchSession, setPublic } from './store';
import { isUnlocked, onRekey, requireUnlocked, rootKeys, updateVault } from './wallet';

// ---------------- state ----------------
export type ServerMode = 'off' | 'on' | 'required' | 'unknown';
let serverMode: ServerMode = 'unknown';
/** Sync flag for readers (requests.ts readers(), swap reader): E2E is in use now. */
export let E2E_ON = false;

/** Persistent E2E state (chrome.storage.local): replay set, idempotency keys, E2E requests, send jobs. */
interface JobRec { job_id: string; request_id: string; purpose: 'tron' | 'evm' | 'bridge' | 'mint' | 'swap'; step?: string; steps: { network: string; txid?: string; expect?: string; state?: string; update?: any }[]; created_at: number }

/** 0.3.2: the id of the transaction we signed — the Signer's txid must be it (it cannot claim another one). */
function expectedTxid(x: any): string | undefined {
  if (x?.signed?.tx?.txID) return String(x.signed.tx.txID).toLowerCase();
  if (typeof x?.signed?.raw === 'string' && /^0x[0-9a-fA-F]+$/.test(x.signed.raw)) return keccak256(x.signed.raw as `0x${string}`).toLowerCase();
  if (x?.txid) return String(x.txid).toLowerCase();
  return undefined;
}
const sameTxid = (a: string, b: string) => a.toLowerCase().replace(/^0x/, '') === b.toLowerCase().replace(/^0x/, '');
interface Persist {
  seen: Record<string, number>;
  idem: Record<string, { request_id: string; hash: string; at: number }>;
  reqs: Record<string, any>;
  jobs: Record<string, JobRec>;
  outbox: { agent_id: string; payload: any }[];
  /** 0.3.3: the executor's journal — what was signed (the request.sign / own.* body), the send jobs made
   * for it (key → job_id) and the resource payments started (akey → route): a restart resumes from here, never pays twice */
  exec: Record<string, ExecRec>;
}
interface ExecRec { body: any; at: number; jobs: Record<string, string>; paid: Record<string, 'proxy' | 'direct'>; unacked?: Record<string, any> }
let mem: Persist | null = null;
/**
 * 0.3.2: on disk only what replay / idempotency need in clear (`seen` ids, `idem` hashes); the requests,
 * jobs and the outbox (recipients, amounts, reasons, names) are AES-GCM ciphertext (`e2e_enc`) under a key derived
 * from the vault key. That key lives in chrome.storage.session (memory) so the executor can still record its progress
 * after the human locks; after a browser restart it is back only with the unlock. Until then the encrypted part is
 * not loaded and what changes meanwhile waits in the session (`e2eBuf`), merged at unlock.
 */
let secretLoaded = false;
/** 0.3.3: the at-rest key of this vault did not open e2e_enc (a lost race of an old version, a damaged
 * write). At unlock the old ciphertext is kept aside (e2e_enc_lost_<time>) and a new history starts — instead of never
 * writing the E2E history to disk again. */
let decryptFailed = false;
const SECRET_KEYS = ['reqs', 'jobs', 'outbox', 'exec'] as const;
type Secret = Pick<Persist, typeof SECRET_KEYS[number]>;
interface EncPart { v: 1; iv: string; ct: string }

async function restKey(): Promise<CryptoKey | null> {
  const ses = (await getSession()) as any;
  let raw: string | undefined = ses.e2eRestKey;
  if (!raw && ses.unlocked?.rawKey) {
    raw = bytesToBase64(hkdf(sha256, base64ToBytes(ses.unlocked.rawKey), utf8('daa e2e at rest v1'), utf8('e2e_enc'), 32));
    await patchSession({ e2eRestKey: raw } as any);
  }
  return raw ? crypto.subtle.importKey('raw', base64ToBytes(raw) as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']) : null;
}
async function sealSecret(k: CryptoKey, x: Secret): Promise<EncPart> {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, k, utf8(JSON.stringify(x)) as BufferSource));
  return { v: 1, iv: bytesToBase64(iv), ct: bytesToBase64(ct) };
}
async function openSecret(k: CryptoKey, e: EncPart): Promise<Secret> {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(e.iv) as BufferSource }, k, base64ToBytes(e.ct) as BufferSource);
  return JSON.parse(new TextDecoder().decode(pt));
}
const mergeSecret = (a: Secret, b: Partial<Secret>): Secret => ({ reqs: { ...a.reqs, ...(b.reqs ?? {}) }, jobs: { ...a.jobs, ...(b.jobs ?? {}) }, outbox: [...a.outbox, ...(b.outbox ?? [])], exec: { ...(a.exec ?? {}), ...(b.exec ?? {}) } });

async function st(): Promise<Persist> {
  if (mem) return mem;
  const got = (await chrome.storage.local.get(['e2e', 'e2e_enc'])) as { e2e?: Partial<Persist>; e2e_enc?: EncPart };
  const plain = got.e2e ?? {};
  // 0.3.1 kept everything in clear: taken as is and re-written encrypted at the next save
  let secret: Secret = { reqs: plain.reqs ?? {}, jobs: plain.jobs ?? {}, outbox: plain.outbox ?? [], exec: plain.exec ?? {} };
  let loaded = !got.e2e_enc;
  if (got.e2e_enc) {
    const k = await restKey();
    if (k) { try { secret = mergeSecret(await openSecret(k, got.e2e_enc), secret); loaded = true; } catch (e) { decryptFailed = true; console.warn('[agent-wallet] e2e at rest:', (e as Error).message); } }
  }
  const buf = ((await getSession()) as any).e2eBuf as Partial<Secret> | undefined;
  if (buf) secret = mergeSecret(secret, buf);
  if (mem) return mem;
  secretLoaded = loaded;
  mem = { seen: plain.seen ?? {}, idem: plain.idem ?? {}, ...secret, exec: secret.exec ?? {} };
  return mem;
}
async function save(): Promise<void> {
  const s = await st();
  const now = Date.now();
  for (const [k, t] of Object.entries(s.seen)) if (now - t > SEEN_KEEP_MS) delete s.seen[k];
  for (const [k, v] of Object.entries(s.idem)) if (now - v.at > SEEN_KEEP_MS) delete s.idem[k];
  pruneE2EHistory(s.reqs, now); // 0.3.12: own operations are history — 90 days / 300 / 1 MB, not the 8 days of the replay set
  for (const [k, j] of Object.entries(s.jobs)) if (now - j.created_at > 7 * 86_400_000) delete s.jobs[k];
  for (const [k, x] of Object.entries(s.exec)) if (now - x.at > 7 * 86_400_000 || (s.reqs[k] && isFinal(s.reqs[k].status))) delete s.exec[k];
  const secret: Secret = { reqs: s.reqs, jobs: s.jobs, outbox: s.outbox, exec: s.exec };
  const k = secretLoaded ? await restKey() : null;
  if (k) {
    await chrome.storage.local.set({ e2e: { seen: s.seen, idem: s.idem }, e2e_enc: await sealSecret(k, secret) });
    if (((await getSession()) as any).e2eBuf) await patchSession({ e2eBuf: undefined } as any);
  } else {
    // locked since a browser restart: the ciphertext on disk stays as it is; the news waits in memory (session)
    await chrome.storage.local.set({ e2e: { seen: s.seen, idem: s.idem } });
    await patchSession({ e2eBuf: secret } as any);
  }
}
/** After unlock: load the encrypted part if it was not (a browser restart), merge what waited, write it encrypted. */
export async function e2eUnlocked(): Promise<void> {
  if (!secretLoaded && mem) mem = null;
  await st();
  if (!secretLoaded && decryptFailed && ((await getSession()) as any).unlocked) {
    const old = (await chrome.storage.local.get('e2e_enc')).e2e_enc;
    if (old) await chrome.storage.local.set({ [`e2e_enc_lost_${Date.now()}`]: old });
    await chrome.storage.local.remove('e2e_enc');
    console.warn('[agent-wallet] e2e at rest: the stored history does not open with this vault key — kept aside, a new one starts');
    decryptFailed = false; secretLoaded = true;
  }
  if (secretLoaded || !(await chrome.storage.local.get('e2e_enc')).e2e_enc) { secretLoaded = true; await save(); }
  await resumeE2E(); // after a browser restart the journal opens only now
}
// a password change: everything is read with the old key first, then written with the new one
onRekey(async () => { await e2eUnlocked(); }, async () => { await patchSession({ e2eRestKey: undefined } as any); if (secretLoaded) await save(); });
/** tests: forget the in-memory mirror */
export function dropE2ECache(): void { checkedAt.clear(); mem = null; secretLoaded = false; decryptFailed = false; serverMode = 'unknown'; E2E_ON = false; modeRestored = false; waiters.clear(); running.clear(); }

export function setServerMode(m: ServerMode): void { serverMode = m; void patchSession({ e2eServerMode: undefined } as any); }
export const getServerMode = () => serverMode;

/**
 * 0.3.3: after a worker restart the mode is `unknown` until the first hello. A `required` heard from
 * this very Signer in this browser session is restored (only the stricter way: `on`/`off` are not — `unknown` already
 * blocks plaintext when E2E is wanted, and reads go direct whenever E2E is wanted).
 */
let modeRestored = false;
async function restoreMode(): Promise<void> {
  if (modeRestored) return;
  modeRestored = true;
  if (serverMode !== 'unknown') return;
  const saved = ((await getSession()) as any).e2eServerMode as { mode?: string; origin?: string } | undefined;
  const p = await getPublic();
  if (saved?.mode === 'required' && p && saved.origin === originOf(p.settings.signer_url) && serverMode === 'unknown') serverMode = 'required';
}

const originOf = (u: string | undefined) => { try { return new URL(String(u)).origin; } catch { return ''; } };
/** This Signer has used E2E with this wallet before: a hello without E2E there is a downgrade. */
const pinned = (p: { settings: { signer_url: string }; e2e_pins?: string[] } | null) => !!p && (p.e2e_pins ?? []).includes(originOf(p.settings.signer_url));

/** Wanted by the human (or by a Signer that requires it): settings, public Signer, `required`, or used before here. */
export async function e2eWanted(): Promise<boolean> {
  await restoreMode();
  const p = await getPublic();
  return !!p && (p.settings.e2e_enabled || p.settings.signer_mode === 'public' || serverMode === 'required' || pinned(p));
}
/** In use now: wanted, the Signer supports it, the wallet has keys. */
export async function e2eActive(): Promise<boolean> {
  await restoreMode();
  const p = await getPublic();
  const on = !!p?.e2e_key && (serverMode === 'on' || serverMode === 'required') && (await e2eWanted());
  E2E_ON = on;
  if (on && p && !pinned(p)) { const o = originOf(p.settings.signer_url); if (o) await setPublic({ ...p, e2e_pins: [...(p.e2e_pins ?? []), o].slice(-16) }); }
  return on;
}
/** 0.3.3: reads with content go to the direct node / RPC / gateway whenever E2E is wanted — also while the
 * Signer says «off» (a downgrade) and before its first hello after a worker restart (`unknown`). */
export async function e2eDirectReads(): Promise<boolean> {
  return (await e2eActive()) || (await e2eWanted());
}
/** Wanted, but the Signer says it is off (or the wallet has no keys yet): nothing with content goes to it. */
export async function e2eDowngraded(): Promise<boolean> {
  return serverMode === 'off' && (await e2eWanted());
}
/**
 * What the Signer may get or give in plaintext: `open` — no E2E (the old mode); `legacy` — E2E on
 * our own Signer (`on`): only agents of the old way (no key bound) may still ask in plaintext; `closed` — the public
 * Signer, `required`, or E2E wanted but not in use (a downgrade): no plaintext documents, agents, own operations or
 * requests at all.
 */
export async function plaintextPolicy(): Promise<'open' | 'legacy' | 'closed'> {
  const p = await getPublic();
  if (await e2eActive()) return serverMode === 'required' || p?.settings.signer_mode === 'public' ? 'closed' : 'legacy';
  return (await e2eWanted()) ? 'closed' : 'open';
}
/** The human turned E2E off on this Signer (an explicit choice, not a hello): forget the pin. */
export async function unpinE2E(): Promise<void> {
  const p = await getPublic();
  if (!p || !pinned(p)) return;
  const o = originOf(p.settings.signer_url);
  await setPublic({ ...p, e2e_pins: (p.e2e_pins ?? []).filter((x) => x !== o) });
}

export async function e2eView(): Promise<E2EView> {
  const p = await getPublic();
  return { server_mode: serverMode, active: await e2eActive(), wanted: await e2eWanted(), downgraded: await e2eDowngraded(), wallet_fp: p?.e2e_key?.fp, wallet_key: p?.e2e_key?.bundle,
    public_signer_url: e2eCfg.public_signer_url, public_placeholder: !!e2eCfg.public_signer_placeholder };
}

// ---------------- wallet keys ----------------
/** Born when E2E is turned on; kept in the vault (private) and pub (public half). */
export async function ensureWalletKeys(): Promise<{ bundle: string; fp: string }> {
  let out!: { bundle: string; fp: string };
  await updateVault((vault) => { // one key pair even when two callers race
    if (vault.e2e) { out = { bundle: vault.e2e.bundle, fp: vault.e2e.fp }; return false; }
    const k = generateKeys();
    vault.e2e = { sig_priv: b64u(k.sig_priv), kex_priv: b64u(k.kex_priv), bundle: bundleOf(k), fp: fingerprint(k.sig, k.kex), created_at: nowAt() };
    out = { bundle: vault.e2e.bundle, fp: vault.e2e.fp };
  });
  const p2 = (await getPublic())!;
  if (!p2.e2e_key || p2.e2e_key.bundle !== out.bundle) { p2.e2e_key = { ...out }; await setPublic(p2); }
  return out;
}

/** «Change encryption key»: a new pair; every npx agent must pair again (its DAA_WALLET is stale). */
export async function rotateWalletKey(): Promise<{ fp: string; repair: string[] }> {
  const repair: string[] = [];
  await updateVault((vault) => {
    delete vault.e2e;
    for (const [id, a] of Object.entries(vault.agents)) if (!a.revoked_at && a.e2e?.mode === 'agent') { delete a.e2e; repair.push(id); }
  });
  const k = await ensureWalletKeys();
  await syncE2EDoc().catch((e) => console.warn('[agent-wallet] e2e sync', e));
  return { fp: k.fp, repair };
}

const walletKeys = (v: VaultData) => {
  if (!v.e2e) throw new Error('E2E_NO_KEYS');
  return { sig_priv: unb64u(v.e2e.sig_priv), kex_priv: unb64u(v.e2e.kex_priv) };
};

// ---------------- the E2E document ----------------
export async function syncE2EDoc(): Promise<void> {
  if (!socket.connected || !(await isUnlocked())) return;
  await ensureWalletKeys();
  const { vault, pub } = await requireUnlocked();
  const s = await getSession();
  const walletId = pub.wallet_id ?? s.signer?.wallet_id;
  if (!walletId) return;
  const version = Math.max(pub.doc_version, s.signerSeenDocVersion ?? 0) + 1;
  const wk = walletKeys(vault);
  const views: Record<string, Envelope> = {};
  const hashes: Record<string, string> = {};
  for (const [id, a] of Object.entries(vault.agents)) {
    if (a.revoked_at || !a.e2e) continue;
    const env = await seal({ wallet_id: walletId, from: 'wallet', to: id, payload: viewPayload(walletId, version, id, a, pub.accounts, vault), senderSigPriv: wk.sig_priv, recipientKex: parseBundle(a.e2e.bundle).kex });
    views[id] = env;
    hashes[id] = envelopeHash(env);
  }
  const service = await docService(); // the document is for this Signer only (when it announced doc_service)
  const doc = buildE2EDoc(walletId, version, pub.accounts, vault, hashes, new Date(), service);
  const digest = e2eDocDigest(doc);
  const { keys } = await rootKeys();
  const text = docSignText(walletId, version, digest, service);
  await socket.request('wallet.sync', { doc, digest, sig_evm: await signEvmMessage(text, keys.evmKey), sig_tron: await signTronMessage(text, keys.tronKey), views });
  const p2 = (await getPublic())!;
  p2.doc_version = version;
  p2.doc_digest = digest;
  await setPublic(p2);
  await patchSession({ signerSeenDocVersion: version });
}

/** hello: the Signer's E2E mode; keys are born and the document re-sent when E2E is wanted. */
export async function onHelloE2E(m: any): Promise<void> {
  const mode = m?.e2e?.mode;
  serverMode = mode === 'on' || mode === 'required' || mode === 'off' ? mode : 'off';
  modeRestored = true;
  const p0 = await getPublic();
  await patchSession({ e2eServerMode: { mode: serverMode, origin: originOf(p0?.settings.signer_url) } } as any);
  if (serverMode === 'off' && (await e2eWanted())) {
    // a downgrade — said once, loudly; nothing with content goes in plaintext (plaintextPolicy = closed)
    console.warn('[agent-wallet] E2E downgrade: the Signer says E2E is off, plaintext is blocked');
    notify('e2e:downgrade', PRODUCT_NAME, tr('bg.e2eDowngrade'));
  }
  if (serverMode !== 'off' && (await e2eWanted()) && (await isUnlocked())) {
    const p = await getPublic();
    const fresh = !p?.e2e_key;
    await ensureWalletKeys();
    if (fresh) await syncE2EDoc().catch((e) => console.warn('[agent-wallet] e2e sync', e));
  }
  await e2eActive();
  await drainOutbox();
  if (serverMode !== 'off') await resumeE2E(); // jobs and payments of a previous worker / browser session
}

// ---------------- agents: create / rotate in E2E ----------------
export const neutralName = () => `agent-${b64u(randomBytes(3)).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
export function pairExpiry(now = Date.now()): string { return new Date(now + e2eCfg.pair_code_ttl_hours * 3_600_000).toISOString(); }

/** New pairing code for an agent whose key is born at the agent (npx). */
export function newPairing(a: AgentEntry): string {
  const code = newPairCode();
  a.pairing = { code, expires_at: pairExpiry() };
  return code;
}

/** agent.create / agent.rotate ack of a remote-MCP agent: the server's public keys, bound at once (mode server). */
export function bindServerKeys(a: AgentEntry, ack: any): void {
  const k = ack?.agent_keys;
  if (!k?.bundle) throw new Error('agent.create: no agent_keys for a remote MCP agent');
  const fp = fpOfBundle(k.bundle);
  if (k.fp && k.fp !== fp) throw new Error('agent.create: agent_keys fingerprint mismatch');
  a.e2e = { bundle: k.bundle, fp, mode: 'server', via: 'server', paired_at: nowAt(), confirmed: true };
  delete a.pairing;
}

/** «Check the fingerprint by hand»: no code — the key whose fingerprint the human typed will be accepted once. */
export async function setManualFp(id: string, fp: string): Promise<void> {
  const norm = fp.toUpperCase().replace(/[^A-Z2-7]/g, '');
  if (norm.length !== 24) throw new Error('BAD_FINGERPRINT: 24 base32 characters (6 groups of 4)');
  await updateVault((vault) => {
    const a = vault.agents[id];
    if (!a || a.revoked_at) throw new Error('UNKNOWN_AGENT');
    a.pairing = { manual_fp: norm.match(/.{4}/g)!.join('-'), expires_at: pairExpiry() };
  });
}

/** The human compared the fingerprint with the agent's `whoami`: match → confirmed; mismatch → the key is unbound. */
export async function confirmFp(id: string, ok: boolean): Promise<void> {
  await updateVault((vault) => {
    const a = vault.agents[id];
    if (!a?.e2e) throw new Error('UNKNOWN_AGENT');
    if (ok) a.e2e.confirmed = true;
    else delete a.e2e;
  });
  if (!ok) await syncE2EDoc().catch(() => {});
}

// ---------------- sending to agents ----------------
async function sendToAgent(agentId: string, payload: any): Promise<void> {
  const s = await st();
  if (!socket.connected || !(await isUnlocked())) { s.outbox.push({ agent_id: agentId, payload }); await save(); return; }
  const { vault, pub } = await requireUnlocked();
  const a = vault.agents[agentId];
  if (!a?.e2e || a.revoked_at) return; // nobody to encrypt to
  const ses = await getSession();
  const walletId = pub.wallet_id ?? ses.signer?.wallet_id;
  if (!walletId) return;
  const env = await seal({ wallet_id: walletId, from: 'wallet', to: agentId, payload, senderSigPriv: walletKeys(vault).sig_priv, recipientKex: parseBundle(a.e2e.bundle).kex });
  try { await socket.request('e2e.send', { envelope: env }); }
  catch (e) { s.outbox.push({ agent_id: agentId, payload }); await save(); throw e; }
}
export async function drainOutbox(): Promise<void> {
  if (!socket.connected || !(await isUnlocked())) return;
  const s = await st();
  const list = s.outbox.splice(0);
  await save();
  for (const x of list) await sendToAgent(x.agent_id, x.payload).catch(() => {});
}
const sendError = (agentId: string, ref: string, code: string, message: string) => sendToAgent(agentId, { t: 'error', ref, code, message }).catch((e) => console.warn('[agent-wallet] e2e error', e));

/** Store an E2E request (session queue + local copy) and tell its agent when its status / resources changed. */
export async function setE2EReq(req: any, event = 'request.status'): Promise<void> {
  const s = await st();
  const prev = s.reqs[req.request_id];
  const next = { ...(prev ?? {}), ...req, updated_at: nowAt() };
  s.reqs[req.request_id] = next;
  await save();
  await putRequest(next);
  notifyPages(); // an open operation page follows every step (payments, broadcast, confirmation)
  // 0.3.12: the end of an operation is a notification that opens its page (failures notify in fail())
  if (prev && !isFinal(prev.status) && next.status === 'confirmed' && !String(next.request_id).endsWith(':mint')) {
    const d = doneText(next);
    if (d) notify(`op:${next.request_id}`, d.title, d.message);
  }
  const agentId = next.e2e?.agent_id;
  if (!agentId) return;
  const changed = !prev || prev.status !== next.status || JSON.stringify(prev.resources) !== JSON.stringify(next.resources) || JSON.stringify(prev.tx) !== JSON.stringify(next.tx)
    || JSON.stringify(prev.bridge) !== JSON.stringify(next.bridge) || JSON.stringify(prev.swap) !== JSON.stringify(next.swap);
  if (changed || event === 'request.created') await sendToAgent(agentId, { t: 'status', event, request: forAgent(next) }).catch((e) => console.warn('[agent-wallet] e2e status', e));
}

export async function e2eRequest(id: string): Promise<any | undefined> { return (await st()).reqs[id]; }
export async function isE2EId(id: string): Promise<boolean> {
  if ((await st()).reqs[id]) return true;
  const mint = id.endsWith(':mint') ? id.slice(0, -5) : '';
  return !!mint && !!(await st()).reqs[mint];
}

/** After a browser restart the session queue is empty: E2E requests come back from local storage. */
export async function restoreE2E(): Promise<void> {
  const s = await st();
  const ses = await getSession();
  for (const r of Object.values(s.reqs)) if (!ses.requests?.[r.request_id]) await putRequest(r, undefined, typeof r.received_at === 'number' ? r.received_at : Date.parse(r.created_at ?? '') || Date.now());
}

// ---------------- receiving ----------------
export async function onE2EList(m: any): Promise<void> {
  const list: any[] = Array.isArray(m?.envelopes) ? m.envelopes : [];
  const done: number[] = [];
  for (const x of list) if ((await processEnvelope(x.envelope ?? x)) === 'ack' && x.seq !== undefined) done.push(x.seq);
  if (done.length) await socket.request('e2e.ack', { seqs: done }).catch(() => {});
}
export async function onE2EEnvelope(m: any): Promise<void> {
  if ((await processEnvelope(m.envelope)) === 'ack' && m.seq !== undefined) await socket.request('e2e.ack', { seqs: [m.seq] }).catch(() => {});
}

/** Waiting for unlock (the key is in the vault): the Signer keeps the envelope until it is acked. */
/** 0.3.3: what waits for the unlock is bounded; beyond it nothing is stored and nothing acked (the
 * Signer keeps the envelope and sends it again after the unlock). */
export const INBOX_LIMITS = { count: 50, bytes: 1_500_000 };
async function keepLocked(env: any): Promise<'keep'> {
  const ses = await getSession() as any;
  const inbox = { ...(ses.e2eInbox ?? {}) };
  if (env?.id && !inbox[env.id]) {
    const size = JSON.stringify(inbox).length + JSON.stringify(env).length;
    if (Object.keys(inbox).length >= INBOX_LIMITS.count || size > INBOX_LIMITS.bytes) { console.warn('[agent-wallet] e2e: locked inbox full, the Signer keeps the envelope'); return 'keep'; }
    inbox[env.id] = env;
    await patchSession({ e2eInbox: inbox } as any);
    notify('e2e:locked', PRODUCT_NAME, tr('e2e.lockedRequest'));
  }
  return 'keep';
}
export async function drainInbox(): Promise<void> {
  if (!(await isUnlocked())) return;
  const ses = await getSession() as any;
  const inbox = ses.e2eInbox ?? {};
  if (!Object.keys(inbox).length) return;
  await patchSession({ e2eInbox: {} } as any);
  for (const env of Object.values(inbox)) await processEnvelope(env);
}

export type Outcome = 'ack' | 'keep';
const badSigAnswered = new Map<string, number>();
const BAD_SIG_ANSWER_MS = 60_000;
/** One envelope from an agent. Returns 'ack' when it may be deleted from the mailbox. */
export async function processEnvelope(env: any): Promise<Outcome> {
  try { checkShape(env); } catch (e) { console.warn('[agent-wallet] e2e: bad envelope', (e as Error).message); return 'ack'; }
  if (!(await isUnlocked())) return keepLocked(env);
  const { vault, pub } = await requireUnlocked();
  const ses = await getSession();
  const walletId = pub.wallet_id ?? ses.signer?.wallet_id;
  if (!vault.e2e) return 'keep';
  if (env.wallet_id !== walletId || env.to !== 'wallet') { console.warn('[agent-wallet] e2e: not for this wallet', env.id); return 'ack'; }
  const agent = vault.agents[env.from];
  if (!agent || agent.revoked_at) { console.warn('[agent-wallet] e2e: unknown or revoked agent', env.from); return 'ack'; }
  const s = await st();
  if (s.seen[env.id]) return 'ack'; // replay
  const kex = unb64u(vault.e2e.kex_priv);
  let payload: any;
  if (agent.e2e && verifyEnvelope(env, parseBundle(agent.e2e.bundle).sig)) {
    try { payload = await decrypt(env, kex); } catch (e) { console.warn('[agent-wallet] e2e:', (e as Error).message); return 'ack'; }
  } else if (agent.pairing) {
    let p: any;
    try { p = await decrypt(env, kex); } catch { return 'ack'; }
    if (p?.t !== 'pair') { console.warn('[agent-wallet] e2e: not paired yet, dropped', env.id); return 'ack'; }
    // into the replay set only once the pairing is proven (anyone can encrypt to the wallet key)
    if (await handlePair(env, p, vault, walletId!)) { s.seen[env.id] = Date.now(); await save(); }
    return 'ack';
  } else {
    // forged by someone who is not the agent (the server, a stale key): never shown; not written to the replay
    // set (a repeat of an invalid envelope is harmless) and the error answer is rate-limited per agent
    console.warn('[agent-wallet] e2e: E2E_BAD_SIGNATURE', env.from, env.id);
    if (agent.e2e && Date.now() - (badSigAnswered.get(env.from) ?? 0) > BAD_SIG_ANSWER_MS) {
      badSigAnswered.set(env.from, Date.now());
      await sendError(env.from, env.id, 'E2E_BAD_SIGNATURE', 'the envelope is not signed by your bound key — pair again if you rotated it');
    }
    return 'ack';
  }
  s.seen[env.id] = Date.now();
  await save();
  if (payload?.t === 'request') await handleRequest(env, payload, env.from, agent);
  else if (payload?.t === 'cancel') await handleCancel(env.from, String(payload.request_id ?? ''));
  else if (payload?.t === 'pair') await sendToAgent(env.from, { t: 'paired', agent_id: env.from, agent_fp: agent.e2e!.fp, wallet_fp: vault.e2e.fp, name: agent.name }).catch(() => {});
  else console.warn('[agent-wallet] e2e: unknown payload', payload?.t);
  return 'ack';
}

async function handlePair(env: Envelope, p: any, vault: VaultData, walletId: string): Promise<boolean> {
  const a = vault.agents[env.from];
  const pr = a.pairing!;
  const fail = (why: string) => { console.warn('[agent-wallet] e2e pairing refused:', env.from, why); return false; };
  if (Date.parse(pr.expires_at) <= Date.now()) return fail('pairing expired');
  if (p.agent_id !== env.from) return fail('agent_id');
  let keys;
  try { keys = parseBundle(`${p.keys?.sig}.${p.keys?.kex}`); } catch { return fail('keys'); }
  if (!verifyEnvelope(env, keys.sig)) return fail('signature');
  if (p.wallet_fp !== vault.e2e!.fp) return fail('wallet_fp: the agent has another wallet key (DAA_WALLET)');
  const fp = fingerprint(keys.sig, keys.kex);
  let via: 'code' | 'manual';
  if (pr.code) {
    const want = pairProof(pr.code, { wallet_id: walletId, agent_id: env.from, sig: p.keys.sig, kex: p.keys.kex, wallet_fp: vault.e2e!.fp });
    if (!sameString(String(p.proof ?? ''), want)) return fail('proof');
    via = 'code';
  } else if (pr.manual_fp) {
    if (pr.manual_fp !== fp) return fail('fingerprint differs from the one typed by the human');
    via = 'manual';
  } else return fail('no pairing');
  const e2e = { bundle: bundleOf(keys), fp, mode: 'agent' as const, via, paired_at: nowAt(), confirmed: via === 'manual' };
  let ok = false;
  await updateVault((v) => { // bound in the vault as it is now (a revoke meanwhile wins)
    const cur = v.agents[env.from];
    if (!cur || cur.revoked_at || !cur.pairing || JSON.stringify(cur.pairing) !== JSON.stringify(pr)) return false;
    cur.e2e = e2e; delete cur.pairing; ok = true;
  });
  if (!ok) return fail('the agent was revoked or its pairing changed meanwhile');
  a.e2e = e2e; delete a.pairing;
  await patchSession({ e2ePaired: { ...(((await getSession()) as any).e2ePaired ?? {}), [env.from]: fp } } as any);
  await syncE2EDoc().catch((e) => console.warn('[agent-wallet] e2e sync', e));
  await sendToAgent(env.from, { t: 'paired', agent_id: env.from, agent_fp: fp, wallet_fp: vault.e2e!.fp, name: a.name });
  notify(`e2e:paired:${env.from}`, PRODUCT_NAME, tr('e2e.paired', { name: a.name, fp }));
  return true;
}

async function handleRequest(env: Envelope, p: any, agentId: string, agent: AgentEntry): Promise<void> {
  const s = await st();
  const rid = String(p.request_id ?? '');
  const fresh = checkFresh(p, Date.now());
  if (fresh) return void (await sendError(agentId, rid || env.id, fresh.code, fresh.message));
  // 0.3.3: an id the Signer's own queue already holds is not taken over (that request would vanish)
  if (rid && !s.reqs[rid] && (await getSession()).requests?.[rid]) return void (await sendError(agentId, rid, 'DUPLICATE_REQUEST_ID', 'this request_id is already used — choose another'));
  if (rid && s.reqs[rid]) { // the same request again: its latest status
    const r = s.reqs[rid];
    if (r.e2e?.agent_id === agentId) await sendToAgent(agentId, { t: 'status', event: 'request.status', request: forAgent(r) }).catch(() => {});
    return;
  }
  const ik = `${agentId}:${p.client_request_id}`;
  const h = bodyHash(p);
  const old = s.idem[ik];
  if (old) {
    const r = s.reqs[old.request_id];
    if (old.hash === h && r) return void (await sendToAgent(agentId, { t: 'status', event: 'request.status', request: forAgent(r) }).catch(() => {}));
    if (old.hash !== h) return void (await sendError(agentId, rid, 'IDEMPOTENCY_CONFLICT', 'the same client_request_id with another body'));
  }
  const pub = await getPublic();
  const n = normalizeRequest(p, { agent_id: agentId, agent, accounts: pub?.accounts ?? [] });
  if (!n.ok) return void (await sendError(agentId, rid, n.error.code, n.error.message));
  s.idem[ik] = { request_id: rid, hash: h, at: Date.now() };
  const req = { ...n.request, received_at: Date.now(), e2e: { agent_id: agentId, key_mode: agent.e2e!.mode, fp: agent.e2e!.fp, envelope_id: env.id, confirmed: !!agent.e2e!.confirmed } };
  await setE2EReq(req, 'request.created');
  if (await agentsPaused()) { await decideE2E('request.reject', { request_id: rid, reason_code: 'paused', detail: { code: 'paused', message: ta('bg.agentsPaused') } }); return; }
  await updateBadge();
  notify(`req:${rid}`, `${PRODUCT_NAME}: ${tr('bg.signRequest')}`, `${agent.name}: ${req.type} ${req.intent?.amount ?? req.intent?.amount_in ?? req.intent?.amount_eth ?? ''} ${req.intent?.asset ?? req.intent?.asset_in ?? ''}`.trim());
  await openSignWindow();
}

async function handleCancel(agentId: string, rid: string): Promise<void> {
  const r = (await st()).reqs[rid];
  if (!r || r.e2e?.agent_id !== agentId) return void (await sendError(agentId, rid, 'NOT_FOUND', 'no such request'));
  if (r.status !== 'pending') return void (await sendError(agentId, rid, 'NOT_CANCELLABLE', `request is ${r.status}`));
  await setE2EReq({ request_id: rid, status: 'cancelled', decision: { by: 'agent', via: 'agent', at: nowAt() } });
  await updateBadge();
}

/** Tick: pending E2E requests past expires_at → expired (the Signer cannot see them). */
export async function expireE2E(): Promise<void> {
  const s = await st();
  for (const r of Object.values(s.reqs)) if (r.status === 'pending' && r.expires_at && Date.parse(r.expires_at) <= Date.now()) await setE2EReq({ request_id: r.request_id, status: 'expired' });
}

// ---------------- decisions: the old request.sign / request.reject go to the executor ----------------
export class ExecError extends Error { constructor(public code: string, message: string, public detail?: any) { super(`${code}: ${message}`); } }

/** request.sign / request.reject / own.* of an E2E request — instead of the Signer. */
export async function decideE2E(type: string, body: any): Promise<any> {
  const rid: string = body.request_id;
  if (type === 'request.reject') {
    if (rid.endsWith(':mint')) return mintRejected(rid.slice(0, -5), body);
    const o = rejectOutcome(body.reason_code ?? 'human', body.detail);
    await setE2EReq({ request_id: rid, status: o.status, decision: { by: body.reason_code === 'human' ? 'human' : 'extension', via: 'extension', at: nowAt() },
      error: { code: o.code, message: `rejected: ${body.reason_code}`, ...(body.detail ? { detail: body.detail } : {}) } });
    return { ok: true };
  }
  if (type === 'request.sign') {
    if (rid.endsWith(':mint')) { void runMint(rid.slice(0, -5), body); return { ok: true }; }
    const pub = await getPublic();
    await journal(rid, body);
    await setE2EReq({ request_id: rid, status: 'signed', decision: { by: body.decision?.by ?? 'human', via: 'extension', rule: body.decision?.rule ?? null, wallet_doc_version: pub?.doc_version ?? 0, at: nowAt() } });
    void runExec(rid);
    return { ok: true };
  }
  throw new Error(`E2E: ${type} is not handled`);
}

/** own.submit / own.refuel / own.bridge / own.swap in E2E: a local request id, the same executor, no Signer content. */
export async function ownE2E(type: string, body: any): Promise<any> {
  const rid = `awr_own_${b64u(randomBytes(12))}`;
  const pub = await getPublic();
  const acc = pub?.accounts.find((a) => a.id === body.account);
  const kind = type === 'own.refuel' ? 'refuel' : type === 'own.bridge' ? 'bridge' : type === 'own.swap' ? 'swap' : 'transfer';
  const network = body.network ?? body.signed?.network ?? body.intent?.from_network ?? 'tron';
  const req = { request_id: rid, own: true, type: kind, network, status: 'signed', account: { id: body.account, name: acc?.name ?? '' }, intent: body.intent ?? undefined, created_at: nowAt(), e2e: { own: true } };
  await journal(rid, body);
  await setE2EReq(req);
  void runExec(rid);
  return { request_id: rid, request: { request_id: rid, status: 'signed' } };
}

const gateway = async () => { const p = await getPublic(); return new Gateway(() => p?.settings.x402_gateway_url ?? e2eCfg.x402_gateway_url); };

async function fail(rid: string, code: string, message: string, detail?: any): Promise<void> {
  // 0.3.12: a request the chain already showed as done is never turned into a failure by a late update
  if ((await st()).reqs[rid]?.status === 'confirmed') { console.warn('[e2e] late failure ignored: confirmed on chain', { request_id: rid, code }); return; }
  await setE2EReq({ request_id: rid, status: 'failed', error: { code, message, ...(detail ? { detail } : {}) } });
  const r = (await st()).reqs[rid];
  notify(`op:${rid}`, `${PRODUCT_NAME}: ${tr('e2e.opFailed')}`, `${code}: ${message}`.slice(0, 200));
  if (r) await updateBadge();
}

// ---------------- the journal and the resume (0.3.3) ----------------
async function journal(rid: string, body: any): Promise<void> {
  const s = await st();
  s.exec[rid] = { body, at: Date.now(), jobs: {}, paid: {} };
  await save();
}
const running = new Set<string>();
/** Run (or resume) the executor of one request — once per worker at a time. */
async function runExec(rid: string): Promise<void> {
  if (running.has(rid)) return;
  const x = (await st()).exec[rid];
  if (!x) return;
  running.add(rid);
  try { await execute(rid, x.body); }
  finally {
    running.delete(rid);
    const s = await st();
    if (s.reqs[rid] && isFinal(s.reqs[rid].status)) { delete s.exec[rid]; await save(); }
  }
}
/**
 * After a worker restart (hello on the new connection) or a browser restart (unlock: the journal is in the encrypted
 * part): every signed E2E request that is not final is resumed. Jobs already handed to the Signer are re-attached (its
 * catching-up e2e.job.update fills them), a payment already started is never made again, a pending mint is signed.
 */
export async function resumeE2E(): Promise<number> {
  if (!socket.connected) return 0;
  const s = await st();
  if (!secretLoaded) return 0;
  let n = 0;
  for (const rid of Object.keys(s.exec)) {
    const r = s.reqs[rid];
    if (!r || isFinal(r.status)) { delete s.exec[rid]; continue; }
    if (running.has(rid) || running.has(`${rid}:mint`)) continue;
    n++;
    console.info('[e2e] resume', { request_id: rid, status: r.status });
    void runExec(rid);
  }
  await save();
  return n;
}
/** A send job of a request made once: the same key again (a resume) gets the job already given to the Signer (re-sent
 * with the same job_id when its ack never came). `fresh` — a new signature (a mint gas retry): a new job. */
async function runJobOnce(rid: string, key: string, purpose: JobRec['purpose'], steps: any[], deadline: Date, step?: string, fresh = false): Promise<string> {
  const s = await st();
  const known = s.exec[rid]?.jobs?.[key];
  if (!fresh && known && s.jobs[known]) {
    const unacked = s.exec[rid]?.unacked?.[known];
    if (unacked) await sendJob(rid, unacked);
    return known;
  }
  return runJob(rid, purpose, steps, deadline, step, key);
}
/** a resource payment is marked before it is signed — a resume never buys again for the same transaction. */
async function markPaid(rid: string, akey: string, route: 'proxy' | 'direct'): Promise<void> {
  const s = await st();
  if (s.exec[rid]) { s.exec[rid].paid = { ...(s.exec[rid].paid ?? {}), [akey]: route }; await save(); }
}
const paidBefore = async (rid: string, akey: string) => (await st()).exec[rid]?.paid?.[akey];

async function execute(rid: string, body: any): Promise<void> {
  try {
    if (body.swap && Array.isArray(body.steps)) await execSwap(rid, body);
    else if (body.bridge && Array.isArray(body.steps)) await execBridge(rid, body);
    else if (body.signed?.network === 'tron') {
      const r = await execTron({ rid, akey: rid, tx: body.signed.tx, plan: body.resource_plan ?? { route: 'none' }, onTx: async (u) => setE2EReq({ request_id: rid, ...u }) });
      await confirmVerified(rid, 'tron', r.txid, { tx: { network: 'tron', tx_id: r.txid, ...(r.fee ? { fee: r.fee } : {}) } });
    } else if (body.signed?.raw) {
      const net = String(body.signed.network);
      const job = await runJobOnce(rid, 'evm', 'evm', [{ network: net, signed: { raw: body.signed.raw } }], new Date(Date.now() + 3_600_000));
      const up = await awaitStep(job, 0, async (u) => { if (u.state === 'broadcast') await setE2EReq({ request_id: rid, status: 'broadcast', tx: { network: net, tx_id: u.txid } }); });
      const req = (await st()).reqs[rid];
      await confirmVerified(rid, net, up.txid, { tx: { network: net, tx_id: up.txid, ...(up.fee ? { fee: up.fee } : {}) },
        ...(req?.type === 'refuel' ? { refuel: { ...(req.refuel ?? {}), state: 'l1_confirmed', to_network: req.intent?.to_network, amount_eth: req.intent?.amount_eth, note: ta('e2e.refuelL2Note') } } : {}) });
    } else throw new ExecError('BAD_REQUEST', 'nothing signed');
  } catch (e) {
    if (e instanceof JobUnconfirmed) { console.warn('[e2e] job not acked — resumed at the next hello', { request_id: rid, job_id: e.job_id }); return; }
    const x = e instanceof ExecError ? e : new ExecError('ERROR', (e as Error).message);
    await fail(rid, x.code, x.message.replace(/^[A-Z_]+: /, ''), x.detail);
  }
}

// ---------------- jobs ----------------
type JobUpdate = { job_id: string; step: number; state: string; txid?: string; error?: any; attestation?: any; message?: string; fee?: any };
const waiters = new Map<string, { resolve: (u: JobUpdate) => void; reject: (e: Error) => void; onUpdate?: (u: JobUpdate) => Promise<void> | void; until: string[] }>();

/** The job may have reached the Signer, its ack did not come back (the connection dropped): not a failure — the next
 * hello re-sends the same job_id (the Signer returns the existing job) and the executor resumes. */
export class JobUnconfirmed extends Error { constructor(public job_id: string) { super(`JOB_UNCONFIRMED: ${job_id}`); } }

export async function runJob(rid: string, purpose: JobRec['purpose'], steps: any[], deadline: Date, step?: string, key?: string): Promise<string> {
  const job_id = `job_${b64u(randomBytes(16))}`;
  const job = { job_id, deadline: deadline.toISOString().replace(/\.\d{3}Z$/, 'Z'), steps };
  const s = await st();
  s.jobs[job_id] = { job_id, request_id: rid, purpose, step, steps: steps.map((x) => ({ network: x.network, txid: x.txid, expect: expectedTxid(x) })), created_at: Date.now() };
  if (key && s.exec[rid]) s.exec[rid] = { ...s.exec[rid], jobs: { ...(s.exec[rid].jobs ?? {}), [key]: job_id }, unacked: { ...(s.exec[rid].unacked ?? {}), [job_id]: job } };
  await save();
  await sendJob(rid, job);
  return job_id;
}
async function sendJob(rid: string, job: any): Promise<void> {
  try { await socket.request('e2e.job', { job }); } // {job} → ack {job_id, job}
  catch (e) {
    if (!(e as any)?.ack) throw new JobUnconfirmed(job.job_id); // transport: maybe delivered
    const s = await st();
    if (s.exec[rid]?.unacked?.[job.job_id]) { delete s.exec[rid].unacked![job.job_id]; await save(); }
    throw e; // refused by the Signer
  }
  const s = await st();
  if (s.exec[rid]?.unacked?.[job.job_id]) { delete s.exec[rid].unacked![job.job_id]; await save(); }
}

/** Wait for a step of a job to reach one of `until` (default: confirmed). failed → ExecError with the Signer's code. */
export function awaitStep(job_id: string, step: number, onUpdate?: (u: JobUpdate) => Promise<void> | void, until: string[] = ['confirmed']): Promise<JobUpdate> {
  return new Promise((resolve, reject) => {
    const key = `${job_id}#${step}`;
    waiters.set(key, { resolve, reject, onUpdate, until });
    // an update that came before we started waiting
    void st().then(async (s) => {
      const u = s.jobs[job_id]?.steps[step]?.update;
      if (u) await deliver(u);
    });
  });
}

function stepIndex(m: any, rec?: JobRec): number {
  if (typeof m.step === 'number') return m.step;
  if (typeof m.step === 'string' && /^\d+$/.test(m.step)) return Number(m.step);
  if (m.txid && rec) { const i = rec.steps.findIndex((x) => x.txid === m.txid); if (i >= 0) return i; }
  return 0;
}

async function deliver(u: JobUpdate): Promise<void> {
  const w = waiters.get(`${u.job_id}#${u.step}`);
  if (!w) return;
  await w.onUpdate?.(u);
  if (u.state === 'failed') { waiters.delete(`${u.job_id}#${u.step}`); w.reject(new ExecError(u.error?.code ?? 'FAILED', u.error?.message ?? 'the Signer reports the step failed', u.error)); return; }
  if (w.until.includes(u.state)) { waiters.delete(`${u.job_id}#${u.step}`); w.resolve(u); }
}

/** S→E e2e.job.update. Without a waiter (a worker restart) a one-step job still closes its request. */
export async function onJobUpdate(m: any): Promise<void> {
  // catching-up update after (re)connect: the whole job without `step`
  if (m?.job && typeof m.job === 'object' && Array.isArray(m.job.steps) && m.step === undefined) {
    const s0 = await st();
    const rec = s0.jobs[m.job_id ?? m.job.job_id];
    if (!rec) return;
    for (let i = 0; i < m.job.steps.length; i++) {
      const x = m.job.steps[i];
      if (!x?.state || rec.steps[i]?.state === x.state) continue;
      await onJobUpdate({ job_id: rec.job_id, step: i, state: x.state, txid: x.txid, error: x.error, attestation: x.attestation, fee: x.fee });
    }
    return;
  }
  const s = await st();
  const rec = s.jobs[m.job_id];
  if (!rec) return;
  const idx = stepIndex(m, rec);
  const att = m.attestation && typeof m.attestation === 'object' ? m.attestation : (m.message && m.attestation ? { message: m.message, attestation: m.attestation } : m.attestation);
  let u: JobUpdate = { job_id: m.job_id, step: idx, state: String(m.state ?? ''), txid: m.txid ?? rec.steps[idx]?.txid, error: m.error, attestation: att, fee: m.fee };
  const want = rec.steps[idx]?.expect;
  if (want && u.txid && !sameTxid(String(u.txid), want)) {
    console.warn('[agent-wallet] e2e: the Signer reports another transaction than the one signed', m.job_id, idx, u.txid, want);
    u = { ...u, state: 'failed', txid: want, error: { code: 'TXID_MISMATCH', message: 'the Signer reported a transaction id that is not the signed one' } };
  }
  if (rec.steps[idx]) { rec.steps[idx].state = u.state; rec.steps[idx].update = u; if (u.txid) rec.steps[idx].txid = u.txid; }
  await save();
  if (waiters.has(`${u.job_id}#${idx}`)) return deliver(u);
  // no live executor for it: close simple jobs by the update itself
  const r = s.reqs[rec.request_id];
  if (!r || isFinal(r.status)) return;
  if ((rec.purpose === 'tron' || rec.purpose === 'evm') && rec.steps.length === 1) {
    const net = rec.steps[0].network;
    if (u.state === 'broadcast') await setE2EReq({ request_id: r.request_id, status: 'broadcast', tx: { network: net, tx_id: u.txid } });
    if (u.state === 'confirmed') await confirmVerified(r.request_id, net, u.txid, { tx: { network: net, tx_id: u.txid } });
    if (u.state === 'failed') await fail(r.request_id, u.error?.code ?? 'FAILED', u.error?.message ?? 'failed');
  }
}

// ---------------- TRON with resources bought by the extension ----------------
interface TronExec { rid: string; akey: string; tx: { txID: string; raw_data_hex: string; signature: string[] }; plan: any; onTx: (u: any) => Promise<void> }

async function setResources(rid: string, patch: any): Promise<void> {
  const r = (await st()).reqs[rid];
  await setE2EReq({ request_id: rid, resources: { ...(r?.resources ?? {}), ...patch } }, 'request.resources');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const E2E_TIMING = { poll_ms: 2_000, retry_ms: 3_000, follow_min_ms: 5_000, repeat_ms: 2_000, verify_ms: 3_000, verify_tries: 5, verify_hold_ms: 3_600_000 };

// ---------------- our own check of «confirmed» (0.3.3) ----------------
/** What the read path (the human's own node / RPC, or the Signer) says about a transaction: in a block and successful, failed, or not seen. */
/** `unknown` — the read worked and the transaction is not there (yet); `error` — the read itself failed (a refused
 * method, a provider error): nothing is known, it never counts as «not found» (0.3.12). */
export async function chainVerdict(network: string, txid: string): Promise<'ok' | 'failed' | 'unknown' | 'error'> {
  try {
    const r = await readers();
    if (network === 'tron') {
      const info: any = await r.tron.call('gettransactioninfobyid', { value: txid.replace(/^0x/, '') });
      if (!info?.id && !info?.blockNumber) return 'unknown';
      return info.result === 'FAILED' || (info.receipt?.result && info.receipt.result !== 'SUCCESS') ? 'failed' : 'ok';
    }
    const rc: any = await r.evm.rpc(requireNet(network).chain_id, 'eth_getTransactionReceipt', [txid]);
    if (!rc || !rc.blockNumber) return 'unknown';
    return rc.status === '0x1' ? 'ok' : 'failed';
  } catch { return 'error'; }
}
/**
 * The Signer says `confirmed`: the request closes only when the read path sees it in a block (direct reads: the human's own node). Failed there → failed; not
 * seen after a few tries → it stays `broadcast` (marked unverified, re-checked by the tick for up to an hour).
 */
async function confirmVerified(rid: string, network: string, txid: string | undefined, patch: any): Promise<void> {
  if (!txid) return setE2EReq({ request_id: rid, status: 'confirmed', ...patch });
  for (let i = 0; i < E2E_TIMING.verify_tries; i++) {
    const v = await chainVerdict(network, txid);
    if (v === 'ok') return setE2EReq({ request_id: rid, status: 'confirmed', ...patch });
    if (v === 'failed') return fail(rid, 'TX_FAILED_ONCHAIN', 'the transaction is in a block but failed (checked by a network read)');
    if (i + 1 < E2E_TIMING.verify_tries) await sleep(E2E_TIMING.verify_ms);
  }
  console.warn('[e2e] the Signer says confirmed, the network read does not see it yet', { request_id: rid, txid });
  await setE2EReq({ request_id: rid, status: 'broadcast', ...patch, unverified: { network, txid, patch, until: Date.now() + E2E_TIMING.verify_hold_ms } });
  notify(`op:${rid}`, PRODUCT_NAME, tr('e2e.unverified'));
}
/** Tick: requests held as unverified are checked again; past the hold — failed. */
export async function reverifyE2E(): Promise<void> {
  if (!secretLoaded) return;
  const s = await st();
  for (const r of Object.values(s.reqs)) {
    const u = r.unverified;
    if (!u || r.status !== 'broadcast') continue;
    const v = await chainVerdict(u.network, u.txid);
    if (v === 'ok') await setE2EReq({ request_id: r.request_id, status: 'confirmed', ...u.patch, unverified: null });
    else if (v === 'failed') await fail(r.request_id, 'TX_FAILED_ONCHAIN', 'the transaction is in a block but failed (checked by a network read)');
    // 0.3.12: past the hold only when the network was actually read and the transaction is not there; a read that
    // fails (a refused method, a provider error) keeps it `broadcast` — never «failed» without a check on chain
    else if (v === 'unknown' && Date.now() > u.until) await fail(r.request_id, 'TX_NOT_FOUND_ONCHAIN', 'the Signer reported it confirmed, a network read never saw it in a block');
  }
  await reconcileE2E();
}

// ---------------- 0.3.12: statuses brought in line with the chain ----------------
/** Failures that only say «not seen in time» — a successful transaction on chain overrides them. */
export const RECHECK_FAILED = new Set(['TX_NOT_FOUND_ONCHAIN', 'TX_EXPIRED']);
const RECHECK_FAILED_DAYS = 30;
export const RECONCILE_TIMING = { stuck_ms: 60_000, failed_ms: 600_000, per_tick: 5 };
const checkedAt = new Map<string, number>();

/** The transaction that decides a request: a bridge — its mint; otherwise its own tx (or the one held as unverified). */
function decisiveTx(r: any): { network: string; txid: string; mint?: number } | null {
  if (r.type === 'bridge') {
    const steps: any[] = r.bridge?.steps ?? [];
    const mi = steps.findIndex((x) => x?.step === 'mint');
    const tx = steps[mi]?.tx?.tx_id;
    const net = r.bridge?.to_network ?? r.intent?.to_network;
    return mi >= 0 && tx && net ? { network: net, txid: tx, mint: mi } : null;
  }
  if (r.type === 'swap') return null; // several transactions: its steps are followed by the executor
  const txid = r.unverified?.txid ?? r.tx?.tx_id ?? r.error?.detail?.tx_id;
  const network = r.unverified?.network ?? r.tx?.network ?? r.network;
  return txid && network ? { network, txid } : null;
}

/**
 * A request stuck at `broadcast` (a bridge at `minting`) whose transaction is in a block and successful closes as
 * confirmed; one marked failed only for «not seen in time» (RECHECK_FAILED) is corrected to confirmed when the chain
 * shows it succeeded. Each request is read at most once a minute (failed ones: every 10 min), a few per tick.
 */
export async function reconcileE2E(now = Date.now()): Promise<number> {
  if (!secretLoaded) return 0;
  const s = await st();
  let n = 0, reads = 0;
  for (const r of Object.values(s.reqs)) {
    if (reads >= RECONCILE_TIMING.per_tick) break;
    const stuck = (r.status === 'broadcast' && !r.unverified) || (r.type === 'bridge' && ['minting', 'awaiting_gas'].includes(r.bridge?.state) && !isFinal(r.status));
    const failed = r.status === 'failed' && RECHECK_FAILED.has(String(r.error?.code ?? '')) && now - Date.parse(r.updated_at ?? r.created_at ?? '') < RECHECK_FAILED_DAYS * 86_400_000;
    if (!stuck && !failed) continue;
    const d = decisiveTx(r);
    if (!d) continue;
    const last = checkedAt.get(r.request_id) ?? 0;
    if (now - last < (failed ? RECONCILE_TIMING.failed_ms : RECONCILE_TIMING.stuck_ms)) continue;
    checkedAt.set(r.request_id, now);
    reads++;
    const v = await chainVerdict(d.network, d.txid);
    if (v !== 'ok') continue;
    const patch: any = { request_id: r.request_id, status: 'confirmed', tx: { ...(r.tx ?? {}), network: d.network, tx_id: d.txid }, unverified: null,
      ...(failed ? { error: null, corrected: { from: 'failed', code: r.error?.code, at: nowAt() } } : {}) };
    if (d.mint !== undefined) {
      const steps = [...(r.bridge?.steps ?? [])];
      steps[d.mint] = { ...steps[d.mint], status: 'confirmed', error: undefined };
      patch.bridge = { ...(r.bridge ?? {}), state: 'done', steps };
    }
    console.info('[e2e] confirmed by the chain', { request_id: r.request_id, was: r.status, txid: d.txid });
    await setE2EReq(patch);
    n++;
  }
  return n;
}

/** The paid call to its outcome: processing → followed; no answer → nonce. */
function payToOutcome(gw: Gateway, o: Offer, sig: string, deadline: Date, rid: string, txid?: string): Promise<GwResult> {
  return payFollow(gw, o, sig, {
    deadline: deadline.getTime(),
    timing: { follow_min_ms: E2E_TIMING.follow_min_ms, repeat_ms: E2E_TIMING.repeat_ms },
    sentOnChain: txid ? () => sentOnChain(txid) : undefined,
    log: (event, d) => console.info(`[e2e] x402 ${event}`, { request_id: rid, ...d }),
  });
}

/** tron/send: the signed transaction is already in a block (a network read: direct, it carries the txid). */
async function sentOnChain(txid: string): Promise<GwResult | null> {
  try {
    const info: any = await (await readers()).tron.call('gettransactioninfobyid', { value: txid });
    if (!info?.id && !info?.blockNumber) return null;
    return { http: 200, body: { status: 'broadcast', txid, block: info.blockNumber, source: 'chain' }, txid, status: 'broadcast', pending: false };
  } catch { return null; }
}

/** Approval of a payment may be written a moment after the executor starts (own operations): wait a little. */
async function payFor(akey: string, route: 'proxy' | 'direct', o: Offer): Promise<{ payment_signature: string; payment_payload: unknown; payer?: string; amount_micro?: string }> {
  for (let i = 0; i < 20; i++) {
    const s = await getSession();
    if (s.approvals?.[akey]) break;
    await sleep(100);
  }
  return approvePayment({ request_id: akey, route, purpose: 'resources', payment_required_raw: o.payment_required_raw, resource_url: o.resource_url });
}

export async function execTron(x: TronExec): Promise<{ txid: string; fee?: any }> {
  const d = decodeRaw(x.tx.raw_data_hex);
  const owner = d.owner;
  const deadline = new Date(d.expiration - 60_000);
  const need = x.plan?.need ?? { energy: 0, bandwidth: 0 };
  const accounts = [owner, ...(d.type === 'TransferContract' && d.to ? [d.to] : [])];
  const sendOwn = async (extraAccounts: string[] = []) => {
    const job = await runJobOnce(x.rid, `${x.akey}:send`, 'tron', [{ network: 'tron', signed: { tx: x.tx }, need: { energy: need.energy ?? 0, bandwidth: need.bandwidth ?? 0, accounts: [...new Set([...accounts, ...extraAccounts])] } }], deadline);
    const up = await awaitStep(job, 0, async (u) => {
      if (u.state === 'waiting_resources') await setResources(x.rid, { state: 'waiting_resources' });
      if (u.state === 'broadcast') await x.onTx({ status: 'broadcast', tx: { network: 'tron', tx_id: u.txid ?? x.tx.txID } });
    });
    return { txid: up.txid ?? x.tx.txID, fee: up.fee };
  };
  const route = x.plan?.route ?? 'none';
  if (route === 'none') return sendOwn();
  const sentExternal = async () => {
    const job = await runJobOnce(x.rid, `${x.akey}:ext`, 'tron', [{ network: 'tron', txid: x.tx.txID, external: true }], deadline);
    await x.onTx({ status: 'broadcast', tx: { network: 'tron', tx_id: x.tx.txID } });
    const up = await awaitStep(job, 0);
    return { txid: up.txid ?? x.tx.txID, fee: up.fee };
  };
  // a resume after a payment was started — never pay again: Proxy sends the transaction itself (wait for it by
  // txID); Direct delivered (or is delivering) — the Signer sends ours with the no-burn guard `need`
  const before = await paidBefore(x.rid, x.akey);
  if (before === 'proxy') return sentExternal();
  if (before === 'direct') return sendOwn([...((x.plan?.buys?.direct ?? x.plan?.buy)?.activate ?? [])]);
  await setResources(x.rid, { state: 'planned', route, fallback_route: x.plan.fallback_route ?? null, x402: [] });
  const order: ('proxy' | 'direct')[] = [route, ...(x.plan.fallback_route ? [x.plan.fallback_route] : [])];
  let lastWhy: any = null;
  for (const r of order) {
    const res = r === 'proxy' ? await buyProxy(x, deadline) : await buyDirect(x, deadline);
    if (res.kind === 'before_payment') { lastWhy = res.why; continue; } // nothing paid: the fallback route may try
    if (res.kind === 'not_needed') return sendOwn();
    if (res.kind === 'sent') return sentExternal();
    return sendOwn(res.activated); // direct delivered: the Signer waits for it on chain (need) and sends
  }
  throw new ExecError('RESOURCE_UNAVAILABLE', lastWhy?.message ?? lastWhy?.code ?? 'no route could buy the resource', lastWhy);
}

type BuyResult = { kind: 'before_payment'; why: any } | { kind: 'not_needed' } | { kind: 'sent' } | { kind: 'delivered'; activated: string[] };

async function addPayment(rid: string, p: any): Promise<number> {
  const r = (await st()).reqs[rid];
  const list = [...(r?.resources?.x402 ?? []), p];
  await setResources(rid, { x402: list });
  return list.length - 1;
}
async function setPayment(rid: string, i: number, patch: any, state?: string): Promise<void> {
  const r = (await st()).reqs[rid];
  const list = [...(r?.resources?.x402 ?? [])];
  list[i] = { ...(list[i] ?? {}), ...patch };
  await setResources(rid, { x402: list, ...(state ? { state } : {}) });
}

async function buyProxy(x: TronExec, deadline: Date): Promise<BuyResult> {
  const gw = await gateway();
  let o: Offer | null = null;
  for (let t = 0; ; t++) {
    try { o = await gw.offer('tron/send', { signed_tx: signedTxHex(x.tx) }); break; }
    catch (e) {
      const g = e as GwError;
      if (g.code === 'NO_RESOURCES_NEEDED') return { kind: 'not_needed' };
      if (g.code === 'NODE_UNAVAILABLE' && t < 4 && Date.now() + E2E_TIMING.retry_ms < deadline.getTime()) { await sleep(E2E_TIMING.retry_ms); continue; }
      return { kind: 'before_payment', why: { code: g.code, message: g.message, http: g.http } };
    }
  }
  let pay;
  await markPaid(x.rid, x.akey, 'proxy');
  try { pay = await payFor(x.akey, 'proxy', o); }
  catch (e) { throw new ExecError('RESOURCE_PAYMENT_FAILED', `resource payment not signed: ${(e as Error).message}`); }
  const i = await addPayment(x.rid, { route: 'proxy', product: 'tron/send', amount_usdc: pay.amount_micro ? (Number(pay.amount_micro) / 1e6).toFixed(6) : undefined, state: 'signed', payer: pay.payer });
  try {
    const res = await payToOutcome(gw, o, pay.payment_signature, deadline, x.rid, x.tx.txID);
    // still processing at the deadline: paid, the outcome by txID (the tracker)
    await setPayment(x.rid, i, { state: res.pending ? 'paid' : 'delivered', payment_id: res.payment_id, settle_tx: res.settle_tx }, res.pending ? 'paid' : 'delivered');
    const st2 = String(res.body?.status ?? '');
    if (st2 === 'failed' || st2 === 'expired') throw new ExecError('TX_EXPIRED', `Proxy: ${st2}`);
    if (st2 === 'rejected') throw new ExecError('BROADCAST_REJECTED', 'Proxy: rejected');
    return { kind: 'sent' };
  } catch (e) {
    if (e instanceof ExecError) throw e;
    const g = e as GwError;
    if (g.before_payment) { await setPayment(x.rid, i, { state: 'refused', error: g.code }); return { kind: 'before_payment', why: { code: g.code, message: g.message } }; }
    if (g.code === 'GATEWAY_UNAVAILABLE' || g.code === 'TX_IN_PROGRESS') { await setPayment(x.rid, i, { state: 'unknown', error: g.message }); return { kind: 'sent' }; } // the tracker decides by txID
    if (g.code === 'BROADCAST_REJECTED') { await setPayment(x.rid, i, { state: 'paid', error: g.code }, 'paid'); throw new ExecError('BROADCAST_REJECTED', g.message); }
    await setPayment(x.rid, i, { state: 'failed', error: g.message }, g.refundable ? 'refunded' : 'failed');
    throw new ExecError('RESOURCE_NOT_DELIVERED', g.message, { gateway: { code: g.code, http: g.http } });
  }
}

async function buyDirect(x: TronExec, deadline: Date): Promise<BuyResult> {
  const gw = await gateway();
  const d = decodeRaw(x.tx.raw_data_hex);
  const buy = x.plan?.buys?.direct ?? (x.plan?.route === 'direct' ? x.plan?.buy : null) ?? x.plan?.buy ?? { energy: 0, bandwidth: 0, activate: [] };
  const items: { product: string; body: Record<string, unknown> }[] = [];
  for (const a of buy.activate ?? []) items.push({ product: 'tron/activate', body: { address: a } });
  if (buy.energy > 0) items.push({ product: 'tron/energy', body: { address: d.owner, amount: Math.max(buy.energy, 65_000) } });
  if (buy.bandwidth > 0) items.push({ product: 'tron/bandwidth', body: { address: d.owner, amount: Math.max(buy.bandwidth, 300) } });
  let paid = false;
  const activated: string[] = [];
  for (const it of items) {
    let o: Offer;
    try { o = await gw.offer(it.product, it.body); }
    catch (e) {
      const g = e as GwError;
      if (it.product === 'tron/activate' && (g.code === 'ALREADY_ACTIVATED' || g.code === 'ACTIVATION_IN_PROGRESS')) { activated.push(String(it.body.address)); continue; }
      if (!paid) return { kind: 'before_payment', why: { code: g.code, message: g.message, product: it.product } };
      throw new ExecError('RESOURCE_UNAVAILABLE', `direct: ${it.product} refused after a partial purchase`, { product: it.product, gateway: g.code });
    }
    let pay;
    await markPaid(x.rid, x.akey, 'direct');
    try { pay = await payFor(x.akey, 'direct', o); }
    catch (e) {
      if (!paid && /resource_above_max|above/i.test((e as Error).message)) return { kind: 'before_payment', why: { code: 'ABOVE_APPROVED_MAX', message: (e as Error).message } };
      throw new ExecError('RESOURCE_PAYMENT_FAILED', `resource payment not signed: ${(e as Error).message}`);
    }
    const i = await addPayment(x.rid, { route: 'direct', product: it.product, amount_usdc: pay.amount_micro ? (Number(pay.amount_micro) / 1e6).toFixed(6) : undefined, state: 'signed', payer: pay.payer });
    let res;
    try { res = await payToOutcome(gw, o, pay.payment_signature, deadline, x.rid); }
    catch (e) {
      const g = e as GwError;
      if (g.before_payment && !paid) { await setPayment(x.rid, i, { state: 'refused', error: g.code }); return { kind: 'before_payment', why: { code: g.code, message: g.message } }; }
      await setPayment(x.rid, i, { state: 'failed', error: g.message }, 'failed');
      throw new ExecError(g.before_payment ? 'RESOURCE_UNAVAILABLE' : 'RESOURCE_NOT_DELIVERED', g.message, { product: it.product });
    }
    paid = true;
    await setPayment(x.rid, i, { state: 'paid', payment_id: res.payment_id, settle_tx: res.settle_tx }, 'paid');
    while (res.pending || !deliveredStatus(res.status, res.http)) {
      if (failedStatus(res.status)) { await setPayment(x.rid, i, { state: 'failed', refund_tx: res.refund_tx }, 'refunded'); throw new ExecError('RESOURCE_NOT_DELIVERED', `${it.product}: ${res.status}`, { product: it.product, payment_id: res.payment_id }); }
      if (Date.now() + E2E_TIMING.poll_ms > deadline.getTime()) throw new ExecError('RESOURCE_NOT_DELIVERED', `${it.product} not delivered before the transaction deadline`, { payment_id: res.payment_id });
      if (!res.payment_id) break; // nothing to poll: the Signer checks the chain (need)
      await sleep(E2E_TIMING.poll_ms);
      try { const r2 = await gw.follow(res); res = { ...r2, payment_id: r2.payment_id || res.payment_id, pending: !!r2.processing || (!deliveredStatus(r2.status, 0) && !failedStatus(r2.status)) }; }
      catch (e) {
        const g = e as GwError;
        if (g instanceof GwError && g.refundable) { await setPayment(x.rid, i, { state: 'failed', error: g.message }, 'refunded'); throw new ExecError('RESOURCE_NOT_DELIVERED', g.message, { product: it.product, payment_id: res.payment_id }); }
        /* unreadable for now: keep polling */
      }
    }
    await setPayment(x.rid, i, { state: 'delivered' });
    if (it.product === 'tron/activate') activated.push(String(it.body.address));
  }
  await setResources(x.rid, { state: 'delivered' });
  return { kind: 'delivered', activated };
}

// ---------------- swap (both steps; step 2 after the approve is in a block) ----------------
async function execSwap(rid: string, body: any): Promise<void> {
  const steps: any[] = body.steps;
  const view: any[] = steps.map((s) => ({ step: s.step, status: 'signed', tx: { tx_id: s.signed?.tx?.txID } }));
  await setE2EReq({ request_id: rid, swap: { ...(body.swap ?? {}), steps: view } });
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const mark = async (patch: any) => { view[i] = { ...view[i], ...patch }; await setE2EReq({ request_id: rid, swap: { ...(body.swap ?? {}), steps: [...view] }, ...(patch.status === 'broadcast' && i === 0 ? { status: 'broadcast' } : {}) }); };
    try {
      const r = await execTron({ rid, akey: `${rid}:${s.step}`, tx: s.signed.tx, plan: s.resource_plan ?? { route: 'none' }, onTx: async (u) => mark({ status: u.status, tx: u.tx }) });
      await mark({ status: 'confirmed', tx: { network: 'tron', tx_id: r.txid } });
    } catch (e) {
      if (e instanceof JobUnconfirmed) throw e;
      const x = e instanceof ExecError ? e : new ExecError('ERROR', (e as Error).message);
      await mark({ status: 'failed', error: { code: x.code, message: x.message } });
      for (let j = i + 1; j < steps.length; j++) view[j] = { ...view[j], status: 'failed', error: { code: 'PREVIOUS_STEP_FAILED' } };
      throw new ExecError(x.code, x.message.replace(/^[A-Z_]+: /, ''), { step: s.step });
    }
  }
  const last = view[view.length - 1];
  await confirmVerified(rid, 'tron', last?.tx?.tx_id, { tx: { network: 'tron', tx_id: last?.tx?.tx_id } });
}

// ---------------- bridge: approve? + burn → Iris attestation by the Signer → mint here ----------------
const domainOf = (network: string) => requireNet(network).cctp!.domain;

async function execBridge(rid: string, body: any): Promise<void> {
  const req = (await st()).reqs[rid];
  const from = String(req?.intent?.from_network ?? req?.network ?? body.steps[0]?.signed?.network);
  const to = String(req?.intent?.to_network ?? '');
  const meta = body.bridge ?? {};
  const bsteps: any[] = body.steps.map((s: any) => ({ step: s.step, status: 'signed' }));
  bsteps.push({ step: 'mint', status: 'waiting', by: meta.delivery === 'forwarding' ? 'circle' : 'wallet' });
  const bridge = { from_network: from, to_network: to, delivery: meta.delivery, mode_effective: meta.mode_effective, burn_amount: meta.burn_amount_raw ? (Number(meta.burn_amount_raw) / 1e6).toString() : undefined,
    max_fee: meta.max_fee_raw ? (Number(meta.max_fee_raw) / 1e6).toString() : undefined, state: 'burning', steps: bsteps };
  const put = async (extra: any = {}) => setE2EReq({ request_id: rid, bridge: { ...bridge, steps: bsteps.map((x) => ({ ...x })) }, ...extra });
  await put();
  const jobSteps = body.steps.map((s: any) => ({ network: String(s.signed.network ?? from), signed: { raw: s.signed.raw }, ...(s.step === 'burn' ? { cctp: { src_domain: domainOf(from) } } : {}) }));
  const job = await runJobOnce(rid, 'bridge', 'bridge', jobSteps, new Date(Date.now() + 2 * 3_600_000));
  for (let i = 0; i < jobSteps.length; i++) {
    const isBurn = body.steps[i].step === 'burn';
    const up = await awaitStep(job, i, async (u) => {
      if (u.state === 'broadcast') { bsteps[i] = { ...bsteps[i], status: 'broadcast', tx: { tx_id: u.txid } }; await put(i === 0 ? { status: 'broadcast' } : {}); }
      if (u.state === 'confirmed') { bsteps[i] = { ...bsteps[i], status: 'confirmed', tx: { tx_id: u.txid } }; if (isBurn) bridge.state = 'attesting'; await put(); }
    }, isBurn ? ['attested'] : ['confirmed']);
    if (isBurn) {
      const att = up.attestation ?? {};
      if (!att.message || !att.attestation) throw new ExecError('ATTESTATION_MISSING', 'the Signer reported attested without the message');
      bsteps[i] = { ...bsteps[i], status: 'confirmed' };
      bridge.state = 'attested';
      await put();
      if (meta.delivery === 'forwarding') {
        bridge.state = 'done'; bsteps[bsteps.length - 1] = { ...bsteps[bsteps.length - 1], status: 'confirmed', by: 'circle' };
        await put({ status: 'confirmed' });
        return;
      }
      const mintId = `${rid}:mint`;
      // a resume — the mint already went to the Signer: wait for it; never sign another
      if ((await st()).exec[rid]?.jobs?.mint) { void runMint(rid, null); return; }
      const s = await st();
      s.reqs[rid] = { ...s.reqs[rid], mint_pending: { message: att.message, attestation: att.attestation } };
      await save();
      bridge.state = 'minting';
      await put();
      const r = await onBridgeMint({ request_id: mintId, parent_request_id: rid, network: to, message: att.message, attestation: att.attestation, message_transmitter: requireNet(to).cctp!.message_transmitter, amount_raw: meta.burn_amount_raw });
      if (r === 'insufficient_gas') { bridge.state = 'awaiting_gas'; await put(); }
      return; // runMint finishes the request (now or after a retry of the pending mint)
    }
  }
}

/** The mint step signed by onBridgeMint (request.sign of `<parent>:mint`): send it and close the bridge. */
async function runMint(parent: string, body: any | null): Promise<void> {
  const req = (await st()).reqs[parent];
  if (!req || running.has(`${parent}:mint`)) return;
  const known = (await st()).exec[parent]?.jobs?.mint;
  const net = String(body?.signed?.network ?? (known ? (await st()).jobs[known]?.steps[0]?.network : ''));
  if (!body && !(known && (await st()).jobs[known])) return;
  running.add(`${parent}:mint`);
  try { await runMintInner(parent, body, net, req); } finally { running.delete(`${parent}:mint`); }
}
async function runMintInner(parent: string, body: any | null, net: string, req: any): Promise<void> {
  const b = { ...(req.bridge ?? {}) };
  const steps = [...(b.steps ?? [])];
  const mi = steps.findIndex((x: any) => x.step === 'mint');
  const put = async (extra: any = {}) => setE2EReq({ request_id: parent, bridge: { ...b, steps: [...steps] }, ...extra });
  try {
    // a new signature (a gas retry) is a new job; none (a resume) — the job already given to the Signer
    const job = await runJobOnce(parent, 'mint', 'mint', [{ network: net, signed: { raw: body?.signed?.raw } }], new Date(Date.now() + 3_600_000), 'mint', !!body);
    if (mi >= 0) steps[mi] = { ...steps[mi], status: 'signed' };
    b.state = 'minting';
    await put();
    const up = await awaitStep(job, 0, async (u) => { if (u.state === 'broadcast' && mi >= 0) { steps[mi] = { ...steps[mi], status: 'broadcast', tx: { tx_id: u.txid } }; await put(); } });
    if (mi >= 0) steps[mi] = { ...steps[mi], status: 'confirmed', tx: { tx_id: up.txid } };
    b.state = 'done';
    await confirmVerified(parent, net, up.txid, { bridge: { ...b, steps: [...steps] }, tx: { network: net, tx_id: up.txid } });
  } catch (e) {
    if (e instanceof JobUnconfirmed) return; // resumed at the next hello
    const x = e instanceof ExecError ? e : new ExecError('ERROR', (e as Error).message);
    if (mi >= 0) steps[mi] = { ...steps[mi], status: 'failed', error: { code: x.code, message: x.message } };
    b.state = 'failed';
    await put();
    await fail(parent, x.code, x.message, { step: 'mint' });
  }
}

async function mintRejected(parent: string, body: any): Promise<any> {
  const req = (await st()).reqs[parent];
  if (!req) return { ok: true };
  if (body.reason_code === 'insufficient_gas') { await setE2EReq({ request_id: parent, bridge: { ...(req.bridge ?? {}), state: 'awaiting_gas' } }); return { ok: true }; }
  await fail(parent, 'INTENT_MISMATCH', String(body.detail?.message ?? 'mint refused'), { step: 'mint' });
  return { ok: true };
}

// ---------------- known addresses for the read classifier ----------------
export async function knownAddresses(): Promise<Known> {
  const p = await getPublic();
  const tron = new Set<string>(), evm = new Set<string>();
  for (const a of p?.accounts ?? []) {
    if (a.removed_at) continue;
    if (a.addresses.tron) { try { tron.add(normalizeTron(a.addresses.tron)); } catch { /* skip */ } }
    if (a.addresses.evm) evm.add(a.addresses.evm.toLowerCase());
  }
  const sc = (swapCfg as any).mainnet;
  const tronContracts = new Set<string>([USDT_TRON, sc.router, sc.permit2, sc.wtrx].map((x: string) => normalizeTron(x)));
  const evmContracts = new Set<string>();
  for (const n of networksCfg.networks as any[]) {
    for (const t of n.tokens ?? []) evmContracts.add(String(t.address).toLowerCase());
    if (n.cctp) { evmContracts.add(String(n.cctp.token_messenger).toLowerCase()); evmContracts.add(String(n.cctp.message_transmitter).toLowerCase()); }
  }
  void servedNets;
  return { tron, evm, tronContracts, evmContracts };
}
