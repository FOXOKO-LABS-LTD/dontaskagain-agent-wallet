// Storage layout.
//   chrome.storage.local   — public state (accounts, settings, doc version) + the encrypted vault blob. Nothing secret
//                            in clear.
//   chrome.storage.session — decrypted vault + the session AES key (memory only, cleared when the browser closes),
//                            Signer session, the request queue and payment approvals (survive service-worker restarts).
import type { EncryptedBlob } from '../lib/crypto/vault';
import { DEFAULT_SETTINGS, normalizeReads, rpcOverrides, type PublicState, type VaultData } from '../lib/wallet/model';

export interface Approval {
  request_id: string; account_id: string; txID: string;
  route: 'direct' | 'proxy'; fallback_route: 'direct' | 'proxy' | null;
  caps_micro: Partial<Record<'direct' | 'proxy', string>>;
  paid_micro: Partial<Record<'direct' | 'proxy', string>>;
  /** pay_id → what was signed for it: a re-sent request.pay (reconnect) gets the same signature, counted once */
  pays?: Record<string, { route: 'direct' | 'proxy'; amount_micro: string; payment_signature: string; payment_payload: unknown }>;
  created_at: number;
  /** 0.3.2: the request it belongs to (a swap step's approval → the swap), when it stops paying (the TRON
   * transaction's expiration), and the TRON addresses a resource may go to (owner, activations of the plan) */
  req_id?: string; expires_at?: number; addresses?: string[];
}

export interface SignerSession { session: string; wallet_id: string; expires_at: string; signer_url: string; }

export interface SessionState {
  unlocked?: { vault: VaultData; rawKey: string };
  lastActivity?: number;
  signer?: SignerSession;
  requests?: Record<string, { request: any; preview?: any; received_at: number; local?: { state: 'signed' | 'rejected' | 'error'; message?: string }; /** 0.3.3: made by the human in this wallet */ own_local?: boolean }>;
  approvals?: Record<string, Approval>;
  pendingPays?: any[];
  signWindowId?: number;
  serverNetworksDiff?: string[];
  signerSeenDocVersion?: number;
  /** EVM: approved bridges (parent request id → what the mint may carry) and mint steps waiting (unlock / gas) */
  bridges?: Record<string, any>;
  pendingMints?: Record<string, any>;
  /** 0.3.3: what was signed for a request / own operation — re-sent as is while it may still be valid */
  signedOnce?: Record<string, SignedRec>;
  /** 0.3.12: token history of the accounts' EVM addresses read from the chain (memory only; account id → rows) */
  chainHist?: Record<string, ChainHistState>;
}
export interface ChainHistState { at: number; rows: import('../lib/chain/history').ChainRow[]; errors: { network: string; code: string }[] }

/**
 * 0.3.3: one signed transaction per request. Written BEFORE it is sent; while it may still be valid (TRON:
 * until its expiration; EVM: no expiry — 24 h, same nonce), «Sign» sends the same bytes again instead of a new build.
 */
export interface SignedRec {
  key: string; kind: 'request' | 'own'; type: string; network: string;
  /** what goes to the Signer (request.sign body / own.* body) and the own.* message type */
  body: any; own_type?: string;
  view?: any; txids: string[]; until?: number; at: number;
  agent_id?: string; to?: string; account_id?: string;
  /** the Signer took it (ack) — the record stays: it still marks a live signature for the repeat plate */
  acked?: boolean;
}

// ---- in-memory mirrors (0.1.7, speed) ----
// Only this worker writes both areas, so it keeps a copy in memory: one read per worker start instead of a full
// chrome.storage read (JSON + IPC of the whole request queue) on every call. Writes go to memory first, then storage.
let pubMem: PublicState | null | undefined;      // undefined = not loaded
let sesMem: SessionState | null = null;
let sesLoading: Promise<SessionState> | null = null;

/** Tests that edit chrome.storage directly (a "browser restart") drop the mirrors with this. */
export function dropStorageCache(): void { pubMem = undefined; sesMem = null; sesLoading = null; }

export async function getPublic(): Promise<PublicState | null> {
  if (pubMem === undefined) {
    const { pub } = (await chrome.storage.local.get('pub')) as { pub?: PublicState };
    if (pubMem === undefined) pubMem = pub ?? null;
  }
  if (!pubMem) return null;
  const pub = structuredClone(pubMem);
  // 0.3.9: no built-in TRON node — a former default (the old built-in node, TronGrid) or none → reads through the Signer;
  // the human's own node and choice stay. RPC: only overrides are kept
  const settings = normalizeReads({ ...DEFAULT_SETTINGS, ...(pub.settings ?? {}) });
  settings.e2e_rpc = rpcOverrides(settings.e2e_rpc);
  return { ...pub, settings };
}
export async function setPublic(pub: PublicState): Promise<void> {
  pubMem = structuredClone(pub);
  await chrome.storage.local.set({ pub });
}

export async function getVaultBlob(): Promise<EncryptedBlob | null> {
  const { vault } = await chrome.storage.local.get('vault');
  return (vault as EncryptedBlob) ?? null;
}
export const setVaultBlob = (vault: EncryptedBlob) => chrome.storage.local.set({ vault });

/** The live session object (do not keep references across awaits; change it only through patchSession). */
export async function getSession(): Promise<SessionState> {
  if (sesMem) return sesMem;
  sesLoading ??= chrome.storage.session.get(null).then((x) => x as SessionState);
  const s = await sesLoading;
  sesMem ??= s;
  sesLoading = null;
  return sesMem;
}
export async function patchSession(p: Partial<SessionState>): Promise<void> {
  const s = await getSession();
  for (const [k, v] of Object.entries(p)) { if (v === undefined) delete (s as any)[k]; else (s as any)[k] = v; }
  await chrome.storage.session.set(p);
}
export async function clearSessionKeys(keys: (keyof SessionState)[]): Promise<void> {
  const s = await getSession();
  for (const k of keys) delete (s as any)[k];
  await chrome.storage.session.remove(keys as string[]);
}
export async function clearAllStorage(): Promise<void> {
  pubMem = null; sesMem = {}; sesLoading = null;
  await chrome.storage.local.clear();
  await chrome.storage.session.clear();
}

/** lastActivity: kept in memory at once, written to storage at most every 10 s (it survives a worker restart). */
let activityWritten = 0;
export async function setActivity(at: number): Promise<void> {
  const s = await getSession();
  s.lastActivity = at;
  if (at - activityWritten < 10_000) return;
  activityWritten = at;
  await chrome.storage.session.set({ lastActivity: at });
}
