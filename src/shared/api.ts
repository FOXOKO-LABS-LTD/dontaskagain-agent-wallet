import type { PriceInfo } from '../lib/prices';
import type { McpLaunch } from '../lib/wallet/model';
// Pages (popup, sign window) ↔ service worker. Pages never receive private keys; the phrase only once, when it is
// created (to be written down) — and never again.

export type Cmd =
  | { cmd: 'status' }
  | { cmd: 'touch' }
  | { cmd: 'newMnemonic'; words: 12 | 24 }
  | { cmd: 'createWallet'; mnemonic: string; password: string; seed_name?: string; account_name?: string }
  | { cmd: 'importWallet'; mnemonic?: string; privateKey?: string; password: string; seed_name?: string; account_name?: string }
  | { cmd: 'unlock'; password: string }
  | { cmd: 'changePassword'; old_password: string; new_password: string }
  | { cmd: 'lock' }
  | { cmd: 'resetWallet'; confirm: 'DELETE' }
  | { cmd: 'addAccount'; name: string; seed_id?: string }
  // 0.1.7: several phrases
  | { cmd: 'accountPreview'; seed_id?: string; mnemonic?: string; privateKey?: string }
  | { cmd: 'seedCreate'; name: string; mnemonic: string; account_name?: string }
  | { cmd: 'seedRename'; id: string; name: string }
  | { cmd: 'seedRemove'; id: string; password: string }
  | { cmd: 'balancesCached'; ids: string[] }
  | { cmd: 'importKey'; privateKey: string; name: string }
  | { cmd: 'renameAccount'; id: string; name: string }
  | { cmd: 'hideAccount'; id: string }
  | { cmd: 'balances'; id: string; force?: boolean }
  | { cmd: 'bookAdd'; label: string; network: string; address: string; memo?: string }
  | { cmd: 'bookRemove'; id: string }
  | { cmd: 'bookCheck'; network: string; address: string }
  | { cmd: 'agentCreate'; name: string; accounts: string[]; launch?: McpLaunch }
  | { cmd: 'agentRevoke'; id: string }
  | { cmd: 'agentSetAccounts'; id: string; accounts: string[] }
  // a new account → access for the ticked agents, one wallet document update
  | { cmd: 'agentsBindAccount'; account_id: string; agent_ids: string[] }
  | { cmd: 'agentsRefresh' }
  // 0.2.1: «Agent settings», token re-issue, the migration prompt for new types
  | { cmd: 'agentUpdate'; id: string; patch: AgentPatch }
  | { cmd: 'agentRotate'; id: string }
  | { cmd: 'agentNewTypes'; id: string; allow: string[] }
  // 0.2.1: operation page
  | { cmd: 'op'; request_id: string }
  | { cmd: 'openOp'; request_id: string }
  | { cmd: 'chainStatus'; account_id: string }
  | { cmd: 'settings'; patch: Partial<SettingsView> }
  | { cmd: 'connect'; invite?: string }
  | { cmd: 'disconnect' }
  | { cmd: 'tgLink' }
  | { cmd: 'tgUnlink' }
  | { cmd: 'requests' }
  | { cmd: 'prepare'; request_id: string }
  | { cmd: 'sign'; request_id: string; addressChecked: boolean; build_id?: string }
  | { cmd: 'reject'; request_id: string }
  | { cmd: 'seen'; request_id: string }
  | { cmd: 'ownPrepare'; account_id: string; asset: 'TRX' | 'USDT'; to: string; amount: string }
  | { cmd: 'ownSign'; own_id: string; addressChecked: boolean; build_id?: string }
  | { cmd: 'openSignWindow' }
  // side panel, pause, history (UI)
  | { cmd: 'prices' }
  | { cmd: 'history'; account_id?: string }
  | { cmd: 'pauseAgents'; paused: boolean }
  | { cmd: 'resourceQuote'; account_id: string; product: 'energy' | 'bandwidth' | 'activate'; amount: number }
  | { cmd: 'buyResource'; account_id: string; product: 'energy' | 'bandwidth' | 'activate'; amount: number; approved_max_usdc: string }
  // swap TRX ↔ USDT via sun.io
  | { cmd: 'swapQuote'; asset_in: 'TRX' | 'USDT'; asset_out: 'TRX' | 'USDT'; amount_in: string; slippage_bps: number }
  | { cmd: 'swapPrepare'; account_id: string; asset_in: 'TRX' | 'USDT'; asset_out: 'TRX' | 'USDT'; amount_in: string; slippage_bps: number }
  | { cmd: 'swapSign'; swap_id: string; build_id?: string }
  // EVM: transfers, CCTP bridge, refuel
  | { cmd: 'evmPrepare'; account_id: string; network: string; asset: string; to: string; amount: string }
  | { cmd: 'bridgeQuote'; account_id: string; from_network: string; to_network: string; amount: string; mode: 'fast' | 'standard'; delivery: 'auto' | 'self' | 'forwarding' }
  | { cmd: 'bridgePrepare'; account_id: string; from_network: string; to_network: string; amount: string; mode: 'fast' | 'standard'; delivery: 'auto' | 'self' | 'forwarding' }
  | { cmd: 'refuelPrepare'; account_id: string; to_network: string; amount_eth: string }
  | { cmd: 'evmSign'; key: string; addressChecked: boolean; build_id?: string }
  // 0.3.0: E2E
  | { cmd: 'e2eEnable'; on: boolean }
  | { cmd: 'e2eRotateWalletKey'; confirm: 'ROTATE' }
  | { cmd: 'agentConnectE2E'; id: string; launch: 'npx' | 'remote' }
  | { cmd: 'agentManualFp'; id: string; fp: string }
  | { cmd: 'agentConfirmFp'; id: string; ok: boolean }
  | { cmd: 'signerMode'; mode: 'own' | 'public'; own_url?: string }
  // 0.3.13: «Connect a chat app» (OAuth on the Signer, a cloud agent)
  | { cmd: 'oauthConsentGet'; user_code: string }
  | { cmd: 'oauthConsentDecide'; consent_id: string; decision: 'approve' | 'deny'; accounts: string[]; allowed_types: string[]; name?: string };

/** A change of an agent from «Agent settings» — everything goes through the wallet document. */
export interface AgentPatch { name?: string; accounts?: string[]; allowed_types?: string[] }

/** A token shown once (create / re-issue) and what to run on the agent's side. */
export interface AgentConnectView {
  id: string; name: string; token: string; mcp_name: string;
  /** re-issue: the connection to remove first (≤ 0.2.0 agents: `agent-wallet`) */
  old_mcp_name: string | null;
  signer_url: string; claude: string; mcp: string;
  /** 0.3.0: how the agent connects and what the human checks */
  launch?: string; e2e?: { wallet_fp: string; wallet_key: string; wallet_id?: string; pair?: string; pair_expires_at?: string; key_mode: 'agent' | 'server'; agent_fp?: string };
}

/** `coins` — prices by ticker (Signer GET /v1/ext/prices, TRX fallback = gateway quote); `TRX` — its $ for old callers. */
export interface PricesView { TRX: number | null; coins?: Record<string, PriceInfo>; energy_quote?: { energy: number; price_usdc: string } | null; as_of?: string; error?: string }

/** A decided (or own) request for the history lists. */
export interface HistoryRow {
  request_id: string; agent?: { id: string; name: string; cloud?: boolean }; account?: { id: string; name: string };
  type: string; network: string; intent: any; status: string; at: number; own: boolean;
  by: 'human' | 'pause' | 'extension' | 'server'; message?: string;
  swap?: { amount_out_min?: string } | null;
  /** 0.2.1: the status in words («on the way: waiting for Circle») and the progress of a multi-step operation */
  status_label?: string; progress?: string;
  /** 0.3.12: a token movement read from the chain (not started by this wallet): direction, the other side, txid */
  chain?: { dir: 'in' | 'out' | 'self'; counterparty: string; txid: string; block: number; estimated?: boolean };
}
export interface ChainStatusView { at: number | null; errors: { network: string; code: string }[]; loading: boolean }

export interface SettingsView { signer_url: string; autolock_min: number; debug_direct_node: boolean; open_in_side_panel: boolean; agents_paused: boolean; mcp_launch?: McpLaunch; mcp_launch_path?: string; mcp_client?: 'claude' | 'codex' | 'json';
  // 0.3.0
  signer_mode?: 'own' | 'public'; own_signer_url?: string; e2e_enabled?: boolean; e2e_reads?: 'direct' | 'signer'; e2e_tron_node?: string; e2e_rpc?: Record<string, string>; x402_gateway_url?: string; }

/** 0.3.0: E2E state for the pages. */
export interface E2EView {
  /** the Signer's mode from hello (`off` = an old Signer without E2E) */
  server_mode: 'off' | 'on' | 'required' | 'unknown';
  /** E2E is in use now: the wallet has keys, the Signer supports it and it is on (or required) */
  active: boolean;
  wanted: boolean;
  /** 0.3.2: E2E is wanted (switched on, public Signer, or used before on this Signer) but the Signer says it
   * is off — nothing with content goes to it until the human decides */
  downgraded?: boolean;
  wallet_fp?: string;
  wallet_key?: string;
  public_signer_url: string; public_placeholder: boolean;
  /** 0.3.13: the Signer offers OAuth for chat apps (hello.e2e.oauth) */
  oauth?: boolean;
}

/** A phrase as pages see it: name and counts only — the words never leave the worker (no «show phrase»). */
export interface SeedView { id: string; name: string; created_at: string; accounts: number; root: boolean; next_index: number; }

export interface AccountPreview { tron: string; evm: string; index?: number; exists?: string }

export interface AccountView {
  id: string; name: string; origin: 'hd' | 'imported'; hd_index?: number; seed_id?: string;
  addresses: { tron?: string; evm?: string; ton?: string }; root: boolean;
}

export interface AgentView {
  id: string; name: string; accounts: string[]; allowed_types: string[]; created_at?: string; revoked_at?: string;
  last_used_at?: string | null; token_prefix?: string;
  /** 0.2.1: types added since the agent was set up — asked once, never allowed silently */
  new_types: string[];
  /** 0.2.1: the MCP server name on the agent's side */
  mcp_name: string;
  /** 0.3.0: the agent's E2E key (fingerprint, who holds it) and a live pairing */
  e2e?: { fp: string; mode: 'agent' | 'server'; via: string; paired_at: string; confirmed?: boolean } | null;
  pairing?: { expires_at: string; manual?: boolean } | null;
  /** 0.3.13: a cloud agent of a chat app (OAuth): the Signer holds its key and sees its requests */
  cloud?: { client_id: string; client_name: string; redirect_host: string; connected_at: string } | null;
}

export interface StatusView {
  initialized: boolean; unlocked: boolean; has_mnemonic: boolean;
  /** 0.1.7: phrases (empty while locked) */
  seeds: SeedView[];
  accounts: AccountView[];
  settings: SettingsView;
  signer: { connected: boolean; signed_in: boolean; wallet_id?: string; error?: string; session_expires_at?: string; server_networks_diff: string[];
    /** 0.3.3: proof of work of the registration on this Signer is being solved */
    registering?: { bits: number; tried: number; expected: number; started_at: number } | null;
    /** 0.3.4: the Signer registers this wallet only with an invite code / registers nobody; the operator blocked it */
    invite_required?: boolean; registration_closed?: boolean; blocked?: boolean };
  pending: number;
  book: { id: string; label: string; network: string; address: string; memo?: string }[];
  agents: AgentView[];
  doc_version: number;
  extension_id: string;
  version: string;
  autolock_at?: number;
  e2e?: E2EView;
}

export interface BalancesView {
  at: string;
  /** every served EVM network → symbol → amount (native + tokens); `base` stays for older pages */
  evm?: Record<string, Record<string, string>>;
  tron?: { TRX: string; USDT: string; activated: boolean; energy: { available: number; limit: number }; bandwidth: { staked_available: number; free_available: number } };
  base?: { USDC: string; ETH: string };
  errors: string[];
}

/** One line of the sign window. */
export interface PreparedView {
  key: string;                               // request_id or own_id
  kind: 'agent' | 'own';
  agent?: { id: string; name: string; known: boolean; /** 0.3.13: a cloud agent (the Signer sees its requests) */ cloud?: boolean };
  account: { id: string; name: string; tron?: string; evm?: string };
  network: string; type: string; reason?: string; expires_at?: string; created_at?: string;
  /** 0.3.0: how the request reached the wallet — signed by the agent's own key, by the server's key of a
   * remote-MCP agent (the operator sees it; manual only), or the old way without an agent signature */
  e2e?: { mode: 'agent' | 'server' | 'none'; fp?: string; confirmed?: boolean; note: string };
  tx?: {
    asset: 'TRX' | 'USDT'; asset_contract?: string; amount: string; from: string; to: string; txID: string;
    fee_limit_trx: string; expiration: string;
  };
  to_check?: { in_book?: { label: string; id: string }; own?: { id: string; name: string; group: string }; similar: { label: string; address: string; source: string; same_prefix: boolean; same_suffix: boolean }[]; first_time: boolean };
  resources?: {
    need: { energy: number; bandwidth: number }; have: { energy: number; bandwidth: number }; deficit: { energy: number; bandwidth: number };
    activate: { sender: boolean; recipient: boolean };
    route: string; fallback_route: string | null;
    quotes: Record<string, { ok: boolean; cost_usdc?: string; approved_max_usdc?: string; code?: string; note?: string; parts?: { energy?: string; bandwidth?: string; activate?: string };
      energy?: { energy_total?: number; energy_user?: number; energy_origin?: number; user_percent?: number; energy_split?: string } }>;
    approved_max_usdc?: string; fallback_approved_max_usdc?: string;
    payer?: string; usdc_balance?: string | null; energy_source: string;
    buy: { energy: number; bandwidth: number; activate: string[] };
  };
  /** `message` goes to the agent (fixed language, i18n AGENT_LANG); `text` is the same in the human's UI language. */
  blocked: null | { reason_code: string; code: string; message: string; text?: string; detail?: Record<string, unknown> };
  warnings: string[];
  built_at: number;
  /** 0.3.2: id of exactly this build (hash of the view and the bytes); «Sign» signs only this build */
  build_id?: string;
  /** swap: the whole exchange and its steps (then `tx`/`resources` above are absent) */
  swap?: SwapView;
  /** an EVM transfer or a refuel (one transaction) / a CCTP bridge (approve? + burn, then mint) */
  evm?: EvmView;
  bridge?: BridgeView;
  /** INSUFFICIENT_GAS in an L2 reachable by refuel: the «Refuel gas» button opens /refuel with it */
  refuel_hint?: { to_network: string } | null;
  /** the same agent asked the same recipient + asset within 30 min */
  repeat?: { request_id: string; minutes_ago: number; status?: string; amount?: string; count: number; kind?: 'transfer' | 'swap' } | null;
  /** 0.3.3: this request is already signed — delivery to the Signer not confirmed; «Sign» re-sends the
   * SAME transaction (valid until `until`; EVM: same nonce, no expiry) */
  signed_once?: { at: number; until?: string; txids: string[]; acked: boolean };
  /** 0.3.3: another request of this agent to this recipient has a signature that may still land */
  live_signature?: { request_id: string; until?: string; status?: string } | null;
}

export interface RequestRow {
  request_id: string; agent?: { id: string; name: string   /** 0.3.0: agent (own key) | server (remote MCP) | undefined (old way / own) */
  e2e_mode?: 'agent' | 'server';
  /** 0.3.13: a cloud agent of a chat app */
  cloud?: boolean;
}; account?: { id: string; name: string; address?: string };
  type: string; network: string; intent: any; reason?: string; status: string; expires_at?: string; created_at?: string;
  local?: { state: 'signed' | 'rejected' | 'error'; message?: string };
  swap?: { amount_out_min?: string } | null;   // the swap part of a swap request (for lists)
}

export type Reply<T = unknown> = { ok: true; result: T } | { ok: false; error: string };

// ---- swap ----
export interface SwapRouteLine { from: string; to: string; version: string; fee_pct: string }
export interface SwapReferenceView { price_usd: string; source?: string; as_of?: string; stale: boolean; deviation_bps: number | null }

/** Quick quote of the swap panel (no transactions built). */
export type SwapQuoteView =
  | { ok: true; amount_out: string; amount_out_min: string; rate: string; route: SwapRouteLine[]; fee?: string; impact?: string; reference: SwapReferenceView | null; fetched_at?: string }
  | { ok: false; code: string; message: string; fetched_at?: string };

/** The swap block of the sign window: you give / you get at least / rate / route / slippage / approve / resources. */
export interface SwapView {
  asset_in: string; asset_out: string; amount_in: string; amount_out: string; amount_out_min: string; slippage_bps: number;
  rate: string; route: SwapRouteLine[]; fee?: string; impact?: string; reference: SwapReferenceView | null;
  router: string; recipient: string; quote_fetched_at?: string;
  approve: { needed: boolean; spender: string; amount: string; current_allowance: string | null };
  steps: { step: 'approve' | 'swap'; txID: string; contract: string; fee_limit_trx: string; expiration: string;
    energy: { total: number; user: number; need: number; source: 'simulation' | 'estimate'; direct_only?: boolean };
    resources: NonNullable<PreparedView['resources']> }[];
  resources_total_usdc: string; resources_cap_usdc: string;
}

// ---- EVM ----
/** One EVM transaction as decoded from the built bytes. */
export interface EvmTxLine {
  step?: 'approve' | 'burn' | 'mint' | 'transfer' | 'refuel';
  network: string; chain_id: number; from: string; to: string; to_label: string; value: string; native: string;
  method: string; args: { k: string; v: string }[]; nonce: number; gas: string; gas_source: 'estimate' | 'typical';
  max_fee_per_gas_gwei: string; fee_max_native: string;
}
export interface GasCheck { network: string; native: string; need_native: string; have_native: string; ok: boolean; fee_max_native: string; max_fee_native: string; above_max: boolean }
export interface EvmView {
  kind: 'transfer' | 'refuel'; network: string; network_name: string; asset: string; amount: string; to: string; token?: string;
  txs: EvmTxLine[]; gas: GasCheck;
  refuel?: { to_network: string; to_name: string; kind: 'op_stack' | 'arbitrum'; l1_contract: string; eta_sec: number; l2_balance: string | null };
}
export interface BridgeQuoteView {
  ok: boolean; code?: string; message?: string;
  from_network: string; to_network: string; amount: string; receive_at_least: string; burn: string; max_fee: string; protocol_fee: string; forward_fee: string;
  mode_effective: 'fast' | 'standard'; finality_threshold: number; minimum_fee_bps: string; delivery: 'self' | 'forwarding'; delivery_reason: string;
  eta_sec: number; fees_fetched_at?: string; usdc_balance: string | null; dst_gas: GasCheck | null;
}
export interface BridgeView extends BridgeQuoteView {
  from_name: string; to_name: string; mode: 'fast' | 'standard'; delivery_requested: 'auto' | 'self' | 'forwarding'; recipient: string;
  approve: { needed: boolean; spender: string; amount: string; current_allowance: string | null };
  steps: EvmTxLine[]; gas: GasCheck;
  mint: { by: 'wallet' | 'circle'; network: string; message_transmitter: string };
}
