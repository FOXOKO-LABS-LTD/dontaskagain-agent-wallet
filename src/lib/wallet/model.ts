// Wallet model. Public data (accounts, settings) is stored in clear; everything else — phrase, imported
// keys, address book, agents — only inside the encrypted vault. 0.3.5: the wallet
// never signs on its own — no auto-sign rules, limits or spend journal (old vaults: those fields are ignored on load).
import type { BookEntry, SimilarCfg } from '../similar';
import e2eCfg from '../../config/e2e.json';
import { insecureUrl } from '../urlPolicy';
import { t, type Key } from '../../i18n';

export type Origin = 'hd' | 'imported';

/** One set of addresses. TON (stage 3) is part of the model: `addresses.ton` + `ton_pubkey`. */
export interface Account {
  id: string;                 // acc_… random, stable
  name: string;               // 1–32 chars
  origin: Origin;
  hd_index?: number;          // origin "hd": index inside its own phrase (seed_id)
  seed_id?: string;           // origin "hd" (0.1.7): which phrase; missing in ≤ 0.1.6 storage → migrated to the first
  addresses: { tron?: string; evm?: `0x${string}`; ton?: string };
  ton_pubkey?: string;        // hex 32 bytes (stage 3)
  removed_at?: string;        // hidden, kept so ids are not reused
}

/** Secret material per imported account. `ton_mnemonic` is reserved for stage 3. */
export type ImportedSecret = { kind: 'secp256k1'; key: `0x${string}` } | { kind: 'ton_mnemonic'; words: string };

/** One BIP-39 phrase (0.1.7: several, like TronLink). The first one is the root: its account 0 signs in to the Signer. */
export interface SeedSecret { id: string; name: string; mnemonic: string; created_at: string; }

export interface Secrets {
  seeds?: SeedSecret[];
  /** ≤ 0.1.6: the single phrase. Moved into `seeds[0]` («Main») at the first unlock of 0.1.7. */
  mnemonic?: string;
  imported: Record<string, ImportedSecret>;
}

/** The name of the first phrase, in the UI language at the moment it is created (stored as is afterwards). */
export const firstSeedName = (): string => t('own.firstSeed');

// ---- what the human allows an agent (no auto-sign since 0.3.5 — every signature is the human's) ----
export type RequestType = 'transfer' | 'swap' | 'bridge' | 'refuel' | 'x402_pay' | 'tron_resource' | 'contract_call';
/** Every request type this version knows (the same list as the Signer). New agents get all of them. */
export const ALL_TYPES: RequestType[] = ['transfer', 'swap', 'bridge', 'refuel', 'x402_pay', 'tron_resource', 'contract_call'];
/** The types of ≤ 0.1.5 (an agent without `known_types` was created knowing only these). */
export const LEGACY_TYPES: RequestType[] = ['transfer', 'x402_pay', 'contract_call', 'tron_resource'];

/**
 * How the agent settings show a type. `available:false`: the Signer of this stage refuses the type itself
 * (UNKNOWN_TYPE), allowing it only takes effect later. Every type is signed by the human (0.3.5: no auto-sign).
 * label / hint are getters: they follow the UI language at the moment they are read.
 */
function typeInfo(type: RequestType, available: boolean) {
  return { get label() { return t(`type.${type}.label` as Key); }, get hint() { return t(`type.${type}.hint` as Key); }, available };
}
export const TYPE_INFO: Record<RequestType, { label: string; hint: string; available: boolean }> = {
  transfer: typeInfo('transfer', true),
  swap: typeInfo('swap', true),
  bridge: typeInfo('bridge', true),
  refuel: typeInfo('refuel', true),
  x402_pay: typeInfo('x402_pay', false),
  tron_resource: typeInfo('tron_resource', false),
  contract_call: typeInfo('contract_call', false),
};

/** Types this version knows that the agent was never asked about (migration prompt, nothing is allowed silently). */
export function newTypesOf(a: Pick<AgentEntry, 'allowed_types' | 'known_types'>): RequestType[] {
  const known = new Set<string>([...(a.known_types ?? LEGACY_TYPES), ...a.allowed_types]);
  return ALL_TYPES.filter((t) => !known.has(t));
}

export interface AgentEntry {
  name: string;
  accounts: string[];          // first = default
  allowed_types: RequestType[];
  // local only (not in the document): when created / revoked in this extension
  created_at?: string;
  revoked_at?: string;
  token_prefix?: string;
  /** 0.2.1: types the human has seen for this agent (allowed or not); missing = LEGACY_TYPES (created ≤ 0.2.0) */
  known_types?: string[];
  /** 0.2.1: the MCP server name given to the agent's side; missing = 'agent-wallet' (what ≤ 0.2.0 printed) */
  mcp_name?: string;
  /** 0.3.0: the agent's E2E key bound to it — `agent` = born at the agent (npx), `server` = remote MCP (the
   * server holds it). Either way every signature is the human's (0.3.5).. `via`: how it was bound (pairing code, manual fingerprint). */
  e2e?: AgentE2EKey;
  /** 0.3.0: a live pairing (code shown in the command, or a fingerprint typed by the human), one use */
  pairing?: { code?: string; manual_fp?: string; expires_at: string };
  /** 0.3.0: the neutral name the server knows (E2E: the real name is only inside the encrypted view) */
  server_name?: string;
}

export interface AgentE2EKey { bundle: string; fp: string; mode: 'agent' | 'server'; via: 'code' | 'manual' | 'server'; paired_at: string; confirmed?: boolean }

/** 0.3.0: the wallet's E2E key pair (Ed25519 + X25519, raw b64url), born when E2E is turned on. */
export interface E2EWalletKeys { sig_priv: string; kex_priv: string; bundle: string; fp: string; created_at: string }

/** Wallet-wide settings in the document: only the similar-address check. 0.3.5: no auto-sign switch or limits. */
export interface GlobalRules { similar: SimilarCfg; }

export interface VaultData {
  secrets: Secrets;
  global: GlobalRules;
  address_book: BookEntry[];
  agents: Record<string, AgentEntry>;
  networks_trusted: string[];
  /** Past recipients (look-alike address check, «first transfer» tick). Never offered as suggestions. */
  recipients: { network: string; address: string; at: string }[];
  /** 0.3.0: E2E keys of the wallet (missing until E2E is turned on) */
  e2e?: E2EWalletKeys;
  /** 0.3.2: bridges this wallet signed — the only ones whose mint it signs (parent request id → approval) */
  bridge_approvals?: Record<string, BridgeApprovalRec>;
}

/** What the mint step of a bridge this wallet started may carry; one mint request per bridge. */
export interface BridgeApprovalRec {
  parent: string; account_id: string; recipient: string; src: string; dst: string; burn_raw: string; delivery: 'self' | 'forwarding'; gas_cap_wei: string; created_at: number;
  /** the mint request bound to it (the first that came) and how many times it was signed (gas retries) */
  mint_id?: string; mint_signs?: number;
  /** 0.3.3: the nonce of the first mint signature — every re-sign uses it, so only one mint can land */
  mint_nonce?: number;
}

export interface PublicState {
  wallet_id?: string;          // from Signer (wal_…) after the first sign-in
  accounts: Account[];
  doc_version: number;         // last wallet document version sent
  doc_digest?: string;
  settings: Settings;
  created_at: string;
  /** 0.3.0: the public half of the wallet's E2E key (shown while locked; the private half is in the vault) */
  e2e_key?: { bundle: string; fp: string };
  /** 0.3.2: Signer origins where E2E was in use — a later hello without E2E there is a downgrade, not a choice */
  e2e_pins?: string[];
  /** 0.3.2: Signer origins that announced `doc_service` — documents for them always carry its host */
  doc_service_pins?: string[];
}

export interface Settings {
  signer_url: string;          // default http://127.0.0.1:9985 (a local Signer)
  autolock_min: number;        // 5–240, default 30
  debug_direct_node: boolean;  // debug only: read TRON from the human's own node (e2e_tron_node) instead of the Signer relay
  open_in_side_panel: boolean; // the toolbar icon opens the side panel instead of the popup
  agents_paused: boolean;      // «Pause all agents» — incoming agent requests are refused locally (code paused)
  /** 0.2.1: how the MCP server is started on the agent's machine (the last choice; commands are built from it) */
  mcp_launch?: McpLaunch;
  mcp_launch_path?: string;    // mcp_launch 'npx': an archive path or URL (overrides the npm package)
  /** 0.3.8: the MCP client on the agent's machine the wizard prints commands for (the last choice) */
  mcp_client?: 'claude' | 'codex' | 'json';
  // ---- 0.3.0, E2E ----
  /** which Signer: the public one (address of this build, config/e2e.json) or the human's own (signer_url) */
  signer_mode: 'own' | 'public';
  /** the own Signer's address kept while the public one is selected */
  own_signer_url?: string;
  /** end-to-end encryption with the Signer (forced on when the Signer says `required`) */
  e2e_enabled: boolean;
  /** E2E: reads with content — through the Signer (default since 0.3.9; the operator sees them) or straight to the node/RPC (only with a TRON node of the human's own) */
  e2e_reads: 'direct' | 'signer';
  /** E2E direct TRON reads: the human's own node, '' = none (0.3.9: no built-in node; former defaults count as «not chosen») */
  e2e_tron_node: string;
  /** E2E direct EVM reads: per chain id, only the human's overrides — the rest comes from config/e2e.json evm_rpc */
  e2e_rpc: Record<string, string>;
  x402_gateway_url: string;
}

/** How the agent's machine reaches the wallet: `npx` = the dontaskagain-mcp package (the agent's own key), `remote` = the Signer's MCP endpoint. */
export type McpLaunch = 'npx' | 'remote';
export const MCP_LAUNCHES: readonly McpLaunch[] = ['npx', 'remote'];
export const DEFAULT_LAUNCH: McpLaunch = 'npx';
export const isMcpLaunch = (x: unknown): x is McpLaunch => typeof x === 'string' && (MCP_LAUNCHES as readonly string[]).includes(x);

export const DEFAULT_SETTINGS: Settings = { signer_url: 'http://127.0.0.1:9985', autolock_min: 30, debug_direct_node: false, open_in_side_panel: false, agents_paused: false, mcp_launch: DEFAULT_LAUNCH, mcp_launch_path: '',
  signer_mode: 'own', e2e_enabled: false, e2e_reads: 'signer', e2e_tron_node: '', e2e_rpc: {}, x402_gateway_url: e2eCfg.x402_gateway_url };

/**
 * 0.3.9: the human's own TRON node for direct reads, or '' — there is no built-in node. Not a choice of the human
 * (→ ''): an empty value, a former built-in default (TronGrid), and plain http to a public host — such a value could
 * only be the former built-in node (typed endpoints must be https since 0.3.2) and is not allowed any more.
 */
export function tronNodeOf(s: Partial<Settings> | undefined): string {
  const v = String(s?.e2e_tron_node ?? '').trim().replace(/\/+$/, '');
  if (!v || (e2eCfg.tron_node_legacy_defaults as string[]).includes(v)) return '';
  try { if (!/^https?:$/.test(new URL(v).protocol)) return ''; } catch { return ''; }
  return insecureUrl(v) ? '' : v;
}
/** 0.3.9: reads go straight to the node / RPC only when the human chose it and set a TRON node; otherwise through the Signer. */
export const directReadsOn = (s: Partial<Settings> | undefined): boolean => s?.e2e_reads === 'direct' && !!tronNodeOf(s);
/**
 * 0.3.9 migration (on every load, pure): no node of the human's own → no node, reads through the Signer, no debug
 * direct reads. The human's own node and their choice of reads stay as they are.
 */
export function normalizeReads<T extends Partial<Settings>>(s: T): T {
  const node = tronNodeOf(s);
  return node ? { ...s, e2e_tron_node: node } : { ...s, e2e_tron_node: '', e2e_reads: 'signer', debug_direct_node: false };
}
/** The EVM RPC of a chain for direct reads: the human's override, else the built-in one. */
export function evmRpcOf(s: Partial<Settings> | undefined, chainId: number | string): string | undefined {
  return s?.e2e_rpc?.[String(chainId)] || (e2eCfg.evm_rpc as Record<string, string>)[String(chainId)];
}
/** 0.3.12: every RPC of a network for direct reads, in order: the human's own, the built-in one, the official fallbacks. */
export function evmRpcsOf(s: Partial<Settings> | undefined, chainId: number | string): string[] {
  const id = String(chainId);
  const list = [s?.e2e_rpc?.[id], (e2eCfg.evm_rpc as Record<string, string>)[id], ...((e2eCfg as any).evm_rpc_fallback?.[id] ?? [])].filter((x): x is string => !!x);
  const seen = new Set<string>();
  return list.filter((u) => { const k = u.replace(/\/+$/, ''); if (seen.has(k)) return false; seen.add(k); return true; });
}
/** Only real overrides are kept (a value equal to the built-in one or empty means «default»). */
export function rpcOverrides(m: Record<string, string> | undefined): Record<string, string> {
  const def = e2eCfg.evm_rpc as Record<string, string>;
  return Object.fromEntries(Object.entries(m ?? {}).filter(([id, u]) => u && u.replace(/\/+$/, '') !== String(def[id] ?? '').replace(/\/+$/, '')));
}

export const DEFAULT_TRUSTED = ['tron', 'evm:1', 'evm:42161', 'evm:10', 'evm:137', 'evm:56', 'evm:43114', 'evm:8453'];

export const defaultVault = (secrets: Secrets): VaultData => ({
  secrets,
  global: { similar: { prefix: 4, suffix: 4 } },
  address_book: [],
  agents: {},
  networks_trusted: [...DEFAULT_TRUSTED],
  recipients: [],
});

/**
 * 0.3.5: a vault written by ≤ 0.3.4 may still carry the auto-sign parts — the spend
 * journal (`spend`), `global.auto_enabled / window / wallet_per_day`, per-agent `rules` (limits) and `temp`. They are
 * dropped on load (pure; never an error); what deny decisions use stays: accounts, allowed types, book, similar cfg.
 */
export function normalizeVault(data: any): VaultData {
  const d = data && typeof data === 'object' ? data : {};
  const def = defaultVault(d.secrets ?? { seeds: [], imported: {} });
  const { spend: _spend, ...rest } = d;
  const sim = d.global?.similar;
  const similar = sim && Number(sim.prefix) > 0 && Number(sim.suffix) > 0 ? { prefix: Number(sim.prefix), suffix: Number(sim.suffix) } : def.global.similar;
  const agents: Record<string, AgentEntry> = {};
  for (const [id, a] of Object.entries((d.agents && typeof d.agents === 'object' ? d.agents : {}) as Record<string, any>)) {
    if (!a || typeof a !== 'object') continue;
    const { rules: _r, temp: _t, ...keep } = a;
    agents[id] = keep as AgentEntry;
  }
  return { ...def, ...rest, global: { similar }, agents };
}

export const validName = (n: string, max = 32): boolean => n.trim().length >= 1 && n.trim().length <= max;

/** Root account: index 0 of the first phrase, or the first imported secp256k1 key when there is no phrase. */
export function rootAccount(accounts: Account[], secrets: Secrets): Account | undefined {
  const live = accounts.filter((a) => !a.removed_at);
  const first = secrets.seeds?.[0];
  if (first) return live.find((a) => a.origin === 'hd' && a.hd_index === 0 && (a.seed_id ?? first.id) === first.id);
  if (secrets.mnemonic) return live.find((a) => a.origin === 'hd' && a.hd_index === 0);
  return live.find((a) => a.origin === 'imported' && secrets.imported[a.id]?.kind === 'secp256k1');
}

/** The phrase of an HD account (a missing seed_id = the first phrase, as in ≤ 0.1.6). */
export function seedOfAccount(acc: Account, secrets: Secrets): SeedSecret | undefined {
  if (acc.origin !== 'hd') return undefined;
  const seeds = secrets.seeds ?? [];
  return acc.seed_id ? seeds.find((s) => s.id === acc.seed_id) : seeds[0];
}

/**
 * Storage of ≤ 0.1.6 → 0.1.7 (pure): the single phrase becomes seeds[0] «Main», HD accounts get its seed_id.
 * Addresses, ids, hd_index and the root account stay the same (so does the Signer sign-in).
 */
export function migrateSeeds(secrets: Secrets, accounts: Account[], newId: () => string, createdAt: string): { secrets: Secrets; accounts: Account[]; vaultChanged: boolean; pubChanged: boolean } {
  let vaultChanged = false, pubChanged = false;
  let seeds = secrets.seeds ?? [];
  const out: Secrets = { ...secrets };
  if (secrets.mnemonic !== undefined) {
    if (!seeds.some((s) => s.mnemonic === secrets.mnemonic)) seeds = [{ id: newId(), name: firstSeedName(), mnemonic: secrets.mnemonic, created_at: createdAt }, ...seeds];
    delete out.mnemonic;
    vaultChanged = true;
  }
  if (!secrets.seeds) vaultChanged = true;
  out.seeds = seeds;
  const first = seeds[0];
  const accs = accounts.map((a) => {
    if (a.origin !== 'hd' || a.seed_id || !first) return a;
    pubChanged = true;
    return { ...a, seed_id: first.id };
  });
  return { secrets: out, accounts: accs, vaultChanged, pubChanged };
}
