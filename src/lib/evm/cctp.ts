// CCTP v2: the fee formula shared with the Signer, Iris fee rows, and the attested message (header v2 +
// BurnMessageV2) parsed and checked by the extension itself before it signs receiveMessage.
import { getAddress, keccak256, recoverAddress, type Hex } from 'viem';

export interface IrisFee { finalityThreshold: number; minimumFee: number | string; forwardFee?: { low: number; med: number; high: number } }
export interface BridgeFees { source?: string; src_domain?: number; dst_domain?: number; fetched_at?: string; fees: IrisFee[] }

/** Decimal bps (e.g. "1.3", 1, 0) → numerator / 10^scale. */
function decimalBps(f: number | string): { num: bigint; scale: bigint } {
  const s = typeof f === 'number' ? String(f) : f.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('FEES_UNAVAILABLE: bad minimumFee');
  const [i, fr = ''] = s.split('.');
  return { num: BigInt(i + fr), scale: 10n ** BigInt(fr.length) };
}

/** protocol = ceil((amount + fwd) × f / (10 000 − f)); max_fee = fwd + protocol; burn = amount + max_fee. */
export function maxFeeOf(amount: bigint, minimumFeeBps: number | string, forwardFee: bigint): { protocol: bigint; maxFee: bigint; burn: bigint } {
  const { num, scale } = decimalBps(minimumFeeBps);
  const den = 10_000n * scale - num;
  if (den <= 0n) throw new Error('FEES_UNAVAILABLE: minimumFee');
  const x = (amount + forwardFee) * num;
  const protocol = num === 0n ? 0n : (x + den - 1n) / den;
  const maxFee = forwardFee + protocol;
  return { protocol, maxFee, burn: amount + maxFee };
}

/** Ceilings of the CCTP fees the wallet accepts (Circle today: fast ≈ 1–1.4 bps, standard 0, forwarding cents). */
export const BRIDGE_FEE_CAPS = { fast_bps: 20, standard_bps: 5, forward_fee_micro: 5_000_000n } as const;

export interface BridgePlanIn { amount: bigint; mode: 'fast' | 'standard'; srcFast: boolean; forwarding: boolean; fees: IrisFee[] }
export interface BridgePlan { mode_effective: 'fast' | 'standard'; finality_threshold: 1000 | 2000; minimum_fee_bps: string; forward_fee_micro: bigint; protocol: bigint; max_fee: bigint; burn: bigint }

/** Pick the Iris row and compute the fee (fast unavailable at the source or not offered → standard). */
export function bridgePlan(p: BridgePlanIn): BridgePlan {
  let t: 1000 | 2000 = p.mode === 'fast' && p.srcFast ? 1000 : 2000;
  let row = p.fees.find((x) => Number(x.finalityThreshold) === t);
  if (!row && t === 1000) { t = 2000; row = p.fees.find((x) => Number(x.finalityThreshold) === 2000); }
  if (!row) throw new Error('FEES_UNAVAILABLE: no fee row');
  const fwd = p.forwarding ? BigInt(row.forwardFee?.med ?? -1) : 0n;
  if (fwd < 0n) throw new Error('FEES_UNAVAILABLE: no forwardFee');
  // 0.3.2: the fees come from the Signer (Iris relay) — hard ceilings of our own
  const { num, scale } = decimalBps(row.minimumFee);
  const capBps = t === 1000 ? BRIDGE_FEE_CAPS.fast_bps : BRIDGE_FEE_CAPS.standard_bps;
  if (num > BigInt(capBps) * scale) throw new Error(`FEES_UNAVAILABLE: minimumFee ${row.minimumFee} bps is above the ceiling ${capBps} bps`);
  if (fwd > BRIDGE_FEE_CAPS.forward_fee_micro) throw new Error(`FEES_UNAVAILABLE: forwarding fee ${fwd} micro-USDC is above the ceiling ${BRIDGE_FEE_CAPS.forward_fee_micro}`);
  const r = maxFeeOf(p.amount, row.minimumFee, fwd);
  return { mode_effective: t === 1000 ? 'fast' : 'standard', finality_threshold: t, minimum_fee_bps: String(row.minimumFee), forward_fee_micro: fwd, protocol: r.protocol, max_fee: r.maxFee, burn: r.burn };
}

// ---- message v2 ----
export interface CctpMessage {
  version: number; sourceDomain: number; destinationDomain: number; nonce: Hex; sender: Hex; recipient: Hex; destinationCaller: Hex;
  minFinalityThreshold: number; finalityThresholdExecuted: number;
  body: { version: number; burnToken: `0x${string}`; mintRecipient: `0x${string}`; amount: bigint; messageSender: `0x${string}`; maxFee: bigint; feeExecuted: bigint; expirationBlock: bigint; hookData: Hex };
}

export function parseMessage(hex: string): CctpMessage {
  const h = hex.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]*$/.test(h) || h.length % 2) throw new Error('BAD_MESSAGE: not hex');
  const b = (o: number, n: number) => h.slice(o * 2, (o + n) * 2);
  if (h.length / 2 < 148 + 228) throw new Error('BAD_MESSAGE: too short');
  const u32 = (o: number) => parseInt(b(o, 4), 16);
  const w = (o: number) => ('0x' + b(o, 32)) as Hex;
  const B = 148;
  const a = (o: number) => getAddress('0x' + b(B + o + 12, 20));
  const big = (o: number) => BigInt('0x' + b(B + o, 32));
  return {
    version: u32(0), sourceDomain: u32(4), destinationDomain: u32(8), nonce: w(12), sender: w(44), recipient: w(76), destinationCaller: w(108),
    minFinalityThreshold: u32(140), finalityThresholdExecuted: u32(144),
    body: { version: u32(B), burnToken: a(4), mintRecipient: a(36), amount: big(68), messageSender: a(100), maxFee: big(132), feeExecuted: big(164), expirationBlock: big(196),
      hookData: ('0x' + h.slice((B + 228) * 2)) as Hex },
  };
}

const same32 = (w: Hex, addr: string) => w.toLowerCase() === '0x' + '0'.repeat(24) + addr.toLowerCase().replace(/^0x/, '');

/** What the mint step may carry: our account, the approved burn, the networks of the bridge. */
export interface MintExpect { srcDomain: number; dstDomain: number; tokenMessenger: string; burnToken: string; recipient: string; amount?: bigint; forwarding?: boolean }
export function verifyMessage(m: CctpMessage, e: MintExpect): void {
  const bad = (f: string, x: unknown) => { throw new Error(`INTENT_MISMATCH: message ${f} ${String(x)}`); };
  if (m.version !== 1 || m.body.version !== 1) bad('version', m.version);
  if (m.sourceDomain !== e.srcDomain) bad('sourceDomain', m.sourceDomain);
  if (m.destinationDomain !== e.dstDomain) bad('destinationDomain', m.destinationDomain);
  if (!same32(m.sender, e.tokenMessenger)) bad('sender', m.sender);
  if (!same32(m.recipient, e.tokenMessenger)) bad('recipient', m.recipient);
  if (!e.forwarding && !/^0x0{64}$/.test(m.destinationCaller)) bad('destinationCaller', m.destinationCaller);
  if (m.body.burnToken.toLowerCase() !== e.burnToken.toLowerCase()) bad('burnToken', m.body.burnToken);
  if (m.body.mintRecipient.toLowerCase() !== e.recipient.toLowerCase()) bad('mintRecipient', m.body.mintRecipient);
  if (m.body.messageSender.toLowerCase() !== e.recipient.toLowerCase()) bad('messageSender', m.body.messageSender);
  if (e.amount !== undefined && m.body.amount !== e.amount) bad('amount', m.body.amount);
}

// ---- attestation sanity (0.3.2) ----
const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
export const MAX_ATTESTERS = 10;

/**
 * Before the wallet spends gas on receiveMessage: the attestation must look like Circle's — 1…10 concatenated 65-byte
 * ECDSA signatures (v 27/28, r and s in range, low s) over keccak256(message), each recoverable, signers in strictly
 * increasing order (what MessageTransmitterV2 requires). It does not prove the signers are Circle's attesters (the
 * contract does), but a made-up blob is refused here instead of being paid for on chain.
 */
export async function checkAttestation(message: Hex, attestation: Hex): Promise<void> {
  const bad = (why: string) => { throw new Error(`INTENT_MISMATCH: attestation ${why}`); };
  const h = String(attestation ?? '').toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]+$/.test(h) || h.length % 130 !== 0) bad('is not a list of 65-byte signatures');
  const n = h.length / 130;
  if (n < 1 || n > MAX_ATTESTERS) bad(`has ${n} signatures`);
  const digest = keccak256(message);
  let prev = -1n;
  for (let i = 0; i < n; i++) {
    const sig = h.slice(i * 130, (i + 1) * 130);
    const r = BigInt('0x' + sig.slice(0, 64)), s = BigInt('0x' + sig.slice(64, 128)), v = parseInt(sig.slice(128, 130), 16);
    if (v !== 27 && v !== 28) bad(`signature ${i}: v ${v}`);
    if (r <= 0n || r >= SECP_N || s <= 0n || s > SECP_N / 2n) bad(`signature ${i}: r/s out of range`);
    let who: string;
    try { who = await recoverAddress({ hash: digest, signature: ('0x' + sig) as Hex }); } catch { return bad(`signature ${i}: not recoverable`); }
    const a = BigInt(who);
    if (a <= prev) bad('signers are not in increasing order');
    prev = a;
  }
}
