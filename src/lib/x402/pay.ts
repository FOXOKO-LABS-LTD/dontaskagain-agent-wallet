// x402 v2 `exact` / EIP-3009 payment built and signed by the extension itself.
// The extension decodes the raw 402 on its own, checks it against its built-in list, and signs a
// TransferWithAuthorization it assembled — never bytes handed over by the server.
import { getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import x402cfg from '../../config/x402.json';
import { base64ToBytes, bytesToBase64, bytesToHex, fromUtf8, randomBytes, utf8 } from '../bytes';

export interface PaymentRequirements {
  scheme: string; network: string; amount: string; asset: string; payTo: string; maxTimeoutSeconds: number;
  extra?: { name?: string; version?: string; [k: string]: unknown };
  [k: string]: unknown;
}
export interface PaymentRequired {
  x402Version: number; error?: string; resource?: { url?: string; description?: string; [k: string]: unknown };
  accepts: PaymentRequirements[]; extensions?: Record<string, unknown>;
}

/** PAYMENT-REQUIRED as it came: base64 JSON, a JSON string, or an object. */
export function decodePaymentRequired(raw: unknown): PaymentRequired {
  let v: unknown = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    v = s.startsWith('{') ? JSON.parse(s) : JSON.parse(fromUtf8(base64ToBytes(s)));
  }
  if (!v || typeof v !== 'object' || !Array.isArray((v as PaymentRequired).accepts)) throw new Error('X402_BAD_PAYLOAD');
  return v as PaymentRequired;
}

export interface ResourceSellerTerms { network: string; asset: string; payTo: string; amountMicro: bigint; maxTimeoutSeconds: number; domain: { name: string; version: string }; requirement: PaymentRequirements; }

/** Pick the accepts[] entry we may pay for a TRON resource: exact, Base, USDC, payTo from the built-in list. */
export function pickResourceTerms(pr: PaymentRequired): ResourceSellerTerms {
  if (pr.x402Version !== 2) throw new Error('X402_UNSUPPORTED: version');
  for (const a of pr.accepts) {
    if (a.scheme !== 'exact') continue;
    const cfg = x402cfg.resource_payments.find((c) => c.network === a.network && c.asset.toLowerCase() === String(a.asset).toLowerCase());
    if (!cfg) continue;
    if (!cfg.pay_to.some((p) => p.toLowerCase() === String(a.payTo).toLowerCase())) throw new Error('X402_UNSAFE: payTo not in the built-in list');
    if (a.extra?.name !== cfg.eip3009.name || a.extra?.version !== cfg.eip3009.version) throw new Error('X402_UNSAFE: EIP-712 domain differs from the built-in list');
    if (!/^\d+$/.test(String(a.amount))) throw new Error('X402_BAD_PAYLOAD: amount');
    const t = Number(a.maxTimeoutSeconds);
    if (!Number.isInteger(t) || t <= 0 || t > x402cfg.max_timeout_seconds_cap) throw new Error('X402_BAD_PAYLOAD: maxTimeoutSeconds');
    return { network: a.network, asset: getAddress(cfg.asset), payTo: getAddress(a.payTo), amountMicro: BigInt(a.amount), maxTimeoutSeconds: t, domain: cfg.eip3009, requirement: a };
  }
  throw new Error('X402_UNSUPPORTED: no exact USDC Base option');
}

export const AUTH_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
  ],
} as const;

export interface SignedPayment { payment_payload: Record<string, unknown>; payment_signature: string; nonce: `0x${string}`; valid_before: number; amount_micro: bigint; pay_to: string; }

/** EIP-3009 authorization (validAfter = now − 600 s, validBefore = now + maxTimeoutSeconds, random 32-byte nonce),
 * wrapped in PaymentPayload v2 and encoded as the PAYMENT-SIGNATURE header value (as x402HTTPClient). */
export async function signResourcePayment(pr: PaymentRequired, terms: ResourceSellerTerms, evmKey: `0x${string}`, nowSec = Math.floor(Date.now() / 1000)): Promise<SignedPayment> {
  const acct = privateKeyToAccount(evmKey);
  const chainId = Number(terms.network.split(':')[1]);
  const nonce = ('0x' + bytesToHex(randomBytes(32))) as `0x${string}`;
  const authorization = {
    from: acct.address, to: terms.payTo, value: terms.amountMicro.toString(),
    validAfter: String(nowSec - 600), validBefore: String(nowSec + terms.maxTimeoutSeconds), nonce,
  };
  const signature = await acct.signTypedData({
    domain: { name: terms.domain.name, version: terms.domain.version, chainId, verifyingContract: terms.asset as `0x${string}` },
    types: AUTH_TYPES, primaryType: 'TransferWithAuthorization',
    message: { from: acct.address, to: terms.payTo as `0x${string}`, value: terms.amountMicro, validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore), nonce },
  });
  const payment_payload: Record<string, unknown> = { x402Version: 2, payload: { authorization, signature }, resource: pr.resource, accepted: terms.requirement };
  if (pr.extensions) payment_payload.extensions = pr.extensions;
  return { payment_payload, payment_signature: bytesToBase64(utf8(JSON.stringify(payment_payload))), nonce, valid_before: nowSec + terms.maxTimeoutSeconds, amount_micro: terms.amountMicro, pay_to: terms.payTo };
}
