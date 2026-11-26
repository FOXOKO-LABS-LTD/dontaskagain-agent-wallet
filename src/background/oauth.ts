// 0.3.13: «Connect a chat app» — the human's consent to an OAuth client of the Signer. The consent is read from the
// Signer over the WebSocket by its one-time code (never from the page that showed the code), decided here and signed
// by the root account like the wallet document; on «Allow» the Signer creates the cloud agent (it holds the agent's
// E2E key), the wallet adds it to the E2E document with the human's accounts and types, and the Signer then hands
// the authorization code to the chat app.
import { hostOf } from '../lib/signer/auth';
import { consentSignText, normalizeUserCode, parseConsent, type CloudInfo, type ConsentDecision, type ConsentView } from '../lib/oauth';
import { signEvmMessage, signTronMessage } from '../lib/sign';
import { stripBidi } from '../lib/text';
import { ALL_TYPES, rootAccount, type AgentEntry, type RequestType } from '../lib/wallet/model';
import { mcpNameFor } from '../lib/agentConnect';
import { getPublic, getSession } from './store';
import { socket, signerUrl, syncDoc } from './signer';
import { bindServerKeys, e2eActive } from './e2e';
import { requireUnlocked, rootKeys, updateVault } from './wallet';

/** Consents read from the Signer in this worker's life (id → view); decide() uses only these. */
const seen = new Map<string, ConsentView & { read_at: number }>();
const SEEN_MAX = 20;

const wsErr = (e: any): Error => new Error(`${e?.code ?? 'ERROR'}: ${e?.message ?? e}`);

/** oauth.consent.get by the code the human typed (or the Signer page handed over). */
export async function consentGet(rawCode: string): Promise<ConsentView> {
  await requireUnlocked();
  const code = normalizeUserCode(rawCode);
  if (!code) throw new Error('BAD_CODE');
  if (!socket.connected) throw new Error('NOT_CONNECTED');
  if (!(await e2eActive())) throw new Error('E2E_UNAVAILABLE: a chat app connects only with end-to-end encryption on');
  let ack: any;
  try { ack = await socket.request('oauth.consent.get', { user_code: code }); } catch (e) { throw wsErr(e); }
  const v = parseConsent(ack);
  seen.set(v.id, { ...v, read_at: Date.now() });
  while (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value!);
  return v;
}

export interface ConsentAnswer { decision: ConsentDecision; agent_id?: string; name?: string }

/** «Allow» / «Deny»: the signed decision; «Allow» also creates the cloud agent in the vault and the document. */
export async function consentDecide(consentId: string, decision: ConsentDecision, accounts: string[], types: string[], name?: string): Promise<ConsentAnswer> {
  const c = seen.get(consentId);
  if (!c) throw new Error('CONSENT_NOT_FOUND: open the code again');
  if (decision !== 'approve' && decision !== 'deny') throw new Error('BAD_REQUEST');
  const { vault, pub } = await requireUnlocked();
  const walletId = pub.wallet_id ?? (await getSession()).signer?.wallet_id;
  if (!walletId) throw new Error('NOT_SIGNED_IN');
  let accs: string[] = [], tys: RequestType[] = [];
  let n = '';
  if (decision === 'approve') {
    const live = new Set(pub.accounts.filter((a) => !a.removed_at).map((a) => a.id));
    accs = [...new Set(accounts)].filter((a) => live.has(a));
    if (!accs.length) { const root = rootAccount(pub.accounts, vault.secrets); if (root) accs.push(root.id); }
    if (!accs.length) throw new Error('NO_ACCOUNTS');
    const want = new Set(types);
    tys = ALL_TYPES.filter((t) => want.has(t));
    n = stripBidi(name ?? c.client.name).trim().slice(0, 48) || c.client.name.slice(0, 48) || 'chat app';
  }
  const text = consentSignText({ service: hostOf(signerUrl()), wallet_id: walletId, consent_id: c.id, client_id: c.client.id, redirect_uri: c.redirect_uri,
    scope: c.scope, decision, accounts: accs, types: tys });
  const { keys } = await rootKeys();
  const sig_evm = await signEvmMessage(text, keys.evmKey), sig_tron = await signTronMessage(text, keys.tronKey);
  let ack: any;
  try {
    ack = await socket.request('oauth.consent.decide', { consent_id: c.id, decision, accounts: accs, allowed_types: tys, ...(decision === 'approve' ? { name: n } : {}), sig_evm, sig_tron });
  } catch (e) { throw wsErr(e); }
  seen.delete(c.id);
  if (decision === 'deny') return { decision };
  const agentId = ack?.agent?.id;
  if (typeof agentId !== 'string' || !/^ag_[A-Za-z0-9_-]{1,64}$/.test(agentId)) throw new Error('oauth.consent.decide: bad answer');
  const cloud: CloudInfo = { client_id: c.client.id, client_name: c.client.name, redirect_host: c.redirect_host, consent_id: c.id, connected_at: new Date().toISOString() };
  const entry: AgentEntry = { name: n, accounts: accs, allowed_types: tys, created_at: cloud.connected_at, known_types: [...ALL_TYPES], mcp_name: '',
    server_name: typeof ack.agent?.name === 'string' ? ack.agent.name : undefined, cloud };
  bindServerKeys(entry, ack); // the Signer's public keys of this agent, mode server
  await updateVault((v) => {
    if (Object.prototype.hasOwnProperty.call(v.agents, agentId)) throw new Error('oauth: the Signer returned an id that already exists');
    entry.mcp_name = mcpNameFor(n, agentId, Object.entries(v.agents).filter(([, a]) => !a.revoked_at).map(([, a]) => a.mcp_name ?? ''));
    v.agents[agentId] = entry;
  });
  // the document with the agent and its view: only then does the Signer give the chat app its code
  await syncDoc();
  return { decision, agent_id: agentId, name: n };
}

/** Is this agent a cloud one (for the views)? */
export async function cloudAgents(): Promise<Set<string>> {
  const v = (await getSession()).unlocked?.vault;
  return new Set(v ? Object.entries(v.agents).filter(([, a]) => !!a.cloud).map(([id]) => id) : []);
}

/** The origin of the wallet's Signer (externally_connectable senders are compared with it). */
export async function signerOrigin(): Promise<string> {
  const u = (await getPublic())?.settings.signer_url ?? signerUrl();
  try { return new URL(u).origin; } catch { return ''; }
}
