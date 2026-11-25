// Who may ask (0.3.2): only an agent of the signed wallet document (the vault), not revoked, bound to the
// account, with the request's type allowed. Anything else is blocked — never only a warning. The name in the window is
// the vault's, not the one the request (the Signer) carries. An agent with a bound key (or a pairing) never asks in plaintext.
import { both } from '../i18n';
import type { VaultData } from '../lib/wallet/model';
import type { PreparedView } from '../shared/api';

export interface AgentCheck { agent: NonNullable<PreparedView['agent']>; blocked: PreparedView['blocked'] }

export function checkAgent(request: any, vault: VaultData, accountId: string, o: { e2eId?: boolean; e2eInUse?: boolean } = {}): AgentCheck {
  const id = typeof request?.agent?.id === 'string' ? request.agent.id : '';
  const ag = id && Object.prototype.hasOwnProperty.call(vault.agents, id) ? vault.agents[id] : undefined;
  const agent = { id: id || '?', name: ag?.name ?? String(request?.agent?.name ?? '?'), known: !!ag && !ag.revoked_at };
  const type = String(request?.type ?? '');
  let blocked: PreparedView['blocked'] = null;
  if (!ag) blocked = { reason_code: 'unsafe', code: 'AGENT_UNKNOWN', ...both('blk.agentUnknown') };
  else if (ag.revoked_at) blocked = { reason_code: 'unsafe', code: 'AGENT_REVOKED', ...both('blk.agentRevoked') };
  else if (!ag.accounts.includes(accountId)) blocked = { reason_code: 'unsafe', code: 'ACCOUNT_NOT_ALLOWED', ...both('blk.accountNotAllowed') };
  else if (!(ag.allowed_types as string[]).includes(type)) blocked = { reason_code: 'type_not_allowed', code: 'TYPE_NOT_ALLOWED', ...both('blk.typeNotAllowed', { type }) };
  // 0.3.3: an agent with a bound key (or a pairing under way) asks only in envelopes — a plaintext request
  // in its name is forged, whatever the Signer says about E2E right now (a hello «off» must not unblock it)
  else if (!o.e2eId && (ag.e2e || ag.pairing)) blocked = { reason_code: 'unsafe', code: 'E2E_PLAINTEXT', ...both('blk.plaintextFromServer') };
  if (!blocked && request?.expires_at && Date.parse(request.expires_at) <= Date.now()) blocked = { reason_code: 'unsafe', code: 'REQUEST_EXPIRED', ...both('blk.requestExpired') };
  return { agent, blocked };
}
