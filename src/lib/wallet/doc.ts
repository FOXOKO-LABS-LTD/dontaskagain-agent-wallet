// Wallet document: accounts, book, agents (accounts, allowed types), signed by the root account.
// 0.3.5: no auto-sign — agents carry no `rules` / `temp`, `global` only the similar-address cfg.
// digest = sha256(JCS(doc with every agents.<id>.rules, where present, replaced by rules_hash = "sha256:" + sha256(JCS(rules)))) —
// the Signer's DocDigest does the same, so a document without rules has the same digest on both sides.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8 } from '../bytes';
import { jcs } from '../jcs';
import { signEvmMessage, signTronMessage } from '../sign';
import type { Account, VaultData } from './model';

export interface DocAgent { name: string; accounts: string[]; allowed_types: string[]; rules?: unknown; }
export interface WalletDoc {
  schema_version: '1'; wallet_id: string; version: number; updated_at: string;
  /** 0.3.2: the Signer host this document is for (the sign-in's Service); signed in the text too */
  service?: string;
  accounts: { id: string; name: string; origin: string; hd_index?: number; addresses: Account['addresses']; ton_pubkey?: string }[];
  networks_trusted: string[];
  global: VaultData['global'];
  address_book: VaultData['address_book'];
  agents: Record<string, DocAgent>;
}

export const sha256Hex = (s: string): string => bytesToHex(sha256(utf8(s)));

export function buildDoc(walletId: string, version: number, accounts: Account[], v: VaultData, now = new Date(), service?: string): WalletDoc {
  const agents: Record<string, DocAgent> = {};
  for (const [id, a] of Object.entries(v.agents)) {
    if (a.revoked_at) continue;
    agents[id] = { name: a.name, accounts: a.accounts, allowed_types: a.allowed_types };
  }
  return {
    schema_version: '1', wallet_id: walletId, version, updated_at: now.toISOString().replace(/\.\d{3}Z$/, 'Z'), ...(service ? { service } : {}),
    accounts: accounts.filter((a) => !a.removed_at).map((a) => ({
      id: a.id, name: a.name, origin: a.origin, ...(a.hd_index !== undefined ? { hd_index: a.hd_index } : {}),
      addresses: a.addresses, ...(a.ton_pubkey ? { ton_pubkey: a.ton_pubkey } : {}),
    })),
    networks_trusted: v.networks_trusted, global: { similar: v.global.similar }, address_book: v.address_book, agents,
  };
}

export function rulesHash(rules: unknown): string { return 'sha256:' + sha256Hex(jcs(rules)); }

/** The form the digest is computed over (and that other agents see via doc_proof). */
export function docForDigest(doc: WalletDoc): unknown {
  const agents: Record<string, unknown> = {};
  for (const [id, a] of Object.entries(doc.agents)) {
    if (!('rules' in a)) { agents[id] = a; continue; }
    const { rules, ...rest } = a;
    agents[id] = { ...rest, rules_hash: rulesHash(rules) };
  }
  return { ...doc, agents };
}

export const docDigest = (doc: WalletDoc): string => 'sha256:' + sha256Hex(jcs(docForDigest(doc)));

/** wallet_id as the Signer issues it: `wal_` + base64url (no line breaks: they would change the signed text). */
export const WALLET_ID_RX = /^wal_[A-Za-z0-9_-]{1,64}$/;
export const validWalletId = (s: unknown): s is string => typeof s === 'string' && WALLET_ID_RX.test(s);
/** A Signer host as in the sign-in text: host[:port], no spaces or line breaks. */
const HOST_RX = /^[A-Za-z0-9.-]+(:\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/;

/**
 * The text both root keys sign. 0.3.2: with the Signer host — a document signed for one Signer cannot be
 * replayed to another (the Signer accepts both forms; the form without Service only from extensions ≤ 0.3.1).
 */
export const docSignText = (walletId: string, version: number, digest: string, service?: string): string => {
  if (!validWalletId(walletId)) throw new Error('BAD_WALLET_ID');
  if (service !== undefined && !HOST_RX.test(service)) throw new Error('BAD_SERVICE');
  return service !== undefined
    ? `Agent Wallet document\nService: ${service}\nWallet: ${walletId}\nVersion: ${version}\nDigest: ${digest}`
    : `Agent Wallet document\nWallet: ${walletId}\nVersion: ${version}\nDigest: ${digest}`;
};

export async function signDoc(doc: WalletDoc, rootKeys: { tronKey: `0x${string}`; evmKey: `0x${string}` }) {
  const digest = docDigest(doc);
  const text = docSignText(doc.wallet_id, doc.version, digest, doc.service);
  return { doc, digest, sig_evm: await signEvmMessage(text, rootKeys.evmKey), sig_tron: await signTronMessage(text, rootKeys.tronKey) };
}
