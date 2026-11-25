// Sign-in by signature. The extension signs the Signer's challenge text only after checking that it is
// exactly the agreed template with OUR host, OUR extension id, OUR root addresses and a sane time window.
import { getAddress } from 'viem';
import { signEvmMessage, signTronMessage } from '../sign';

export interface Challenge { nonce: string; message: string; expires_at: string; }

export function expectedChallenge(p: { host: string; extensionId: string; tron: string; evm: string; nonce: string; issuedAt: string; expiresAt: string }): string {
  return [
    'Agent Wallet sign-in',
    'This is not a transaction and costs nothing.',
    `Service: ${p.host}`,
    `Extension: chrome-extension://${p.extensionId}`,
    `TRON: ${p.tron}`,
    `EVM: ${getAddress(p.evm)}`,
    `Nonce: ${p.nonce}`,
    `Issued At: ${p.issuedAt}`,
    `Expiration Time: ${p.expiresAt}`,
  ].join('\n');
}

const RX = /^Agent Wallet sign-in\nThis is not a transaction and costs nothing\.\nService: ([^\n]+)\nExtension: chrome-extension:\/\/([a-p]{32}|[a-z0-9_-]{1,64})\nTRON: (T[1-9A-HJ-NP-Za-km-z]{33})\nEVM: (0x[0-9a-fA-F]{40})\nNonce: ([A-Za-z0-9_-]{22})\nIssued At: (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)\nExpiration Time: (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)$/;

/** Throws with the reason when the challenge must not be signed. */
export function checkChallenge(ch: Challenge, want: { host: string; extensionId: string; tron: string; evm: string }, now = Date.now(), skewMs = 5 * 60_000): void {
  const m = RX.exec(ch.message);
  if (!m) throw new Error('challenge: unexpected text');
  const [, host, ext, tron, evm, nonce, iat, exp] = m;
  if (host !== want.host) throw new Error(`challenge: service ${host} ≠ ${want.host}`);
  if (ext !== want.extensionId) throw new Error('challenge: extension id differs');
  if (tron !== want.tron) throw new Error('challenge: TRON address differs');
  if (evm !== getAddress(want.evm)) throw new Error('challenge: EVM address differs (or not EIP-55)');
  if (nonce !== ch.nonce) throw new Error('challenge: nonce differs');
  const t0 = Date.parse(iat), t1 = Date.parse(exp);
  if (!(t1 > t0) || t1 - t0 > 10 * 60_000) throw new Error('challenge: bad validity window');
  if (t0 > now + skewMs || t1 < now - skewMs) throw new Error('challenge: expired or from the future');
}

/** Host as the extension sees the Signer: host[:port] of its URL. */
export const hostOf = (url: string): string => new URL(url).host;

export async function signChallenge(message: string, keys: { tronKey: `0x${string}`; evmKey: `0x${string}` }) {
  return { sig_tron: await signTronMessage(message, keys.tronKey), sig_evm: await signEvmMessage(message, keys.evmKey) };
}
