// Our x402 gateway called by the extension itself in E2E mode: quotes, estimates, 402 → PAYMENT-SIGNATURE →
// repeat, payment lookups. Same semantics as the Signer's x402 client (offer / pay / payment / follow / payment by nonce).
//
// 0.3.1 — the gateway answers within 25 s: verify
// ≤ 10 s (beyond: 503 FACILITATOR_UNAVAILABLE, nothing charged), maxTimeoutSeconds 300, the final answer or 202
// {"status":"processing","payment_status","payment_id","status_url","retry_after"} + Retry-After; a repeat of the same
// PAYMENT-SIGNATURE returns the stored answer or 202 (never a second charge); GET /payments?nonce=&payer= finds a
// payment without its id (404 = the signature was never accepted). `payFollow` below is the Signer's `pay` loop.
import { base64ToBytes, bytesToBase64, utf8 } from '../bytes';
import { getJSON, postJSON, HttpError, type X402Reader } from '../net';

export interface Offer { product: string; resource_url: string; body: Record<string, unknown>; payment_required_raw: string }
export interface GwResult {
  http: number; body: any; payment_id?: string; settle_tx?: string; refund_tx?: string; txid?: string; status?: string; pending: boolean;
  /** 202 processing: paid (or being paid) and still running at the gateway — the outcome comes from the payment state */
  processing?: boolean; payment_status?: string; status_url?: string; retry_after_ms?: number;
}
export class GwError extends Error {
  /** refused before money for a transient reason (503 FACILITATOR_UNAVAILABLE / OFAC_UNAVAILABLE): repeat the same signature */
  public retryable = false;
  constructor(public http: number, public code: string, public detail: string, public before_payment: boolean, public refundable = false, public body?: unknown) { super(`${code}: ${detail}`); }
}

/** A paid POST: the gateway answers within 25 s (final or 202 processing). */
export const PAY_TIMEOUT_MS = 30_000;
/** The gateway refuses an authorization living < 20 s ("authorization expires too soon"); repeat only while ≥ 22 s. */
export const MIN_VALIDITY_MS = 22_000;

const trim = (u: string) => u.replace(/\/+$/, '');

async function read(r: Response): Promise<any> { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } }
function errOf(code: number, b: any, before: boolean): GwError {
  const inner = b && typeof b === 'object' ? (typeof b.error === 'object' ? b.error : b) : {};
  const c = inner?.code ?? (typeof b?.error === 'string' ? b.error : undefined) ?? `HTTP_${code}`;
  return new GwError(code, String(c), String(inner?.message ?? (typeof b === 'string' ? b.slice(0, 200) : '')), before, !!inner?.refundable, b);
}
function resultOf(code: number, b: any): GwResult {
  const st = b?.status ?? b?.state ?? (b?.tl?.already_sent ? 'already_sent' : undefined);
  const r: GwResult = { http: code, body: b, payment_id: b?.payment_id, settle_tx: b?.settle_tx, refund_tx: b?.refund_tx, txid: b?.txid ?? b?.tl?.txid, status: st, pending: code === 202,
    payment_status: b?.payment_status, status_url: b?.status_url };
  if (code === 202 && st === 'processing') { r.processing = true; r.retry_after_ms = Number(b?.retry_after ?? 0) * 1000 || undefined; }
  return r;
}

const RUNNING = new Set(['received', 'settling', 'settle_pending', 'settled', 'fulfilling', 'processing']);

/** GET /payments/{id} (or ?nonce=) → as Pay would answer: running → processing; invalid / settle_failed → refused
 *  before money; refund_pending / refunded / refund_manual → not delivered, refundable; fulfilled / pending → the stored
 *  product answer (`answer`). */
export function paymentView(b: any): GwResult {
  if (!b || typeof b !== 'object') throw new GwError(502, 'X402_BAD_PAYLOAD', 'payment state is not JSON', false);
  const st = String(b.status ?? '').toLowerCase();
  if (RUNNING.has(st)) return { http: 202, body: b, payment_id: b.payment_id, settle_tx: b.settle_tx, status: 'processing', pending: true, processing: true, payment_status: st, status_url: b.status_url };
  if (st === 'invalid' || st === 'settle_failed') throw new GwError(402, 'PAYMENT_REJECTED', `${st}: ${b.reason ?? ''}`, true, false, b);
  if (st === 'refund_pending' || st === 'refunded' || st === 'refund_manual') {
    const a = b.answer && typeof b.answer === 'object' ? errOf(0, b.answer, false) : null;
    const known = a && !a.code.startsWith('HTTP_');
    throw new GwError(503, known ? a!.code : 'PAYMENT_REFUNDED', `${st}: ${known ? a!.detail : b.reason ?? ''}`, false, true, b);
  }
  const hasAnswer = b.answer !== undefined && b.answer !== null;
  const r = resultOf(200, hasAnswer ? b.answer : b);
  r.payment_status = st;
  r.payment_id ||= b.payment_id;
  r.settle_tx ||= b.settle_tx;
  if (!r.status || !hasAnswer) r.status = st;
  r.pending = st === 'pending' || String(r.status).toLowerCase() === 'pending';
  r.processing = false;
  return r;
}

export interface Authorization { from: string; nonce: string; valid_before_ms: number }
/** payload.authorization of a PAYMENT-SIGNATURE value (standard or URL-safe base64 JSON); null if it cannot be read. */
export function decodeAuthorization(sig: string): Authorization | null {
  try {
    const s = sig.trim().replace(/-/g, '+').replace(/_/g, '/');
    const j = JSON.parse(new TextDecoder().decode(base64ToBytes(s + '='.repeat((4 - (s.length % 4)) % 4))));
    const a = j?.payload?.authorization;
    const vb = Number(a?.validBefore);
    if (!a?.nonce || !a?.from || !Number.isFinite(vb)) return null;
    return { from: String(a.from), nonce: String(a.nonce).toLowerCase(), valid_before_ms: vb * 1000 };
  } catch { return null; }
}
/** A repeat of the same signature can still be accepted. */
export const alive = (a: Authorization | null, now: number) => !!a && a.valid_before_ms >= now + MIN_VALIDITY_MS;

export class Gateway implements X402Reader {
  constructor(private base: () => string, private fetchFn: typeof fetch = (...a) => fetch(...a)) {}

  estimate(body: Record<string, unknown>) { return postJSON(`${trim(this.base())}/tron/estimate`, body); }
  quote(params: Record<string, string>) { return getJSON(`${trim(this.base())}/quote?${new URLSearchParams(params)}`); }

  /** POST the product without payment: 402 → offer; anything else is a refusal before money. */
  async offer(product: string, body: Record<string, unknown>): Promise<Offer> {
    const url = `${trim(this.base())}/${product}`;
    let r: Response;
    try { r = await this.fetchFn(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) }); }
    catch (e) { throw new GwError(503, 'GATEWAY_UNAVAILABLE', (e as Error).message, true); }
    const b = await read(r);
    if (r.status !== 402) throw errOf(r.status, b, true);
    const raw = r.headers.get('PAYMENT-REQUIRED') ?? bytesToBase64(utf8(typeof b === 'string' ? b : JSON.stringify(b)));
    return { product, resource_url: url, body, payment_required_raw: raw };
  }

  /** Repeat with PAYMENT-SIGNATURE: the answer comes within 25 s — final or 202 processing (0.3.1, was 180 s). No
   *  answer → GATEWAY_UNAVAILABLE with an UNKNOWN outcome (payFollow looks the payment up by its nonce). */
  async pay(o: Offer, paymentSignature: string, timeoutMs = PAY_TIMEOUT_MS): Promise<GwResult> {
    let r: Response, b: any;
    try {
      r = await this.fetchFn(`${trim(this.base())}/${o.product}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'PAYMENT-SIGNATURE': paymentSignature },
        body: JSON.stringify(o.body), signal: AbortSignal.timeout(timeoutMs) });
      b = await read(r);
    } catch (e) { throw new GwError(503, 'GATEWAY_UNAVAILABLE', (e as Error).message, false); }
    if (r.status === 200 || r.status === 202) {
      if (b && typeof b === 'object' && b.result === false && b.code) throw new GwError(r.status, b.code, JSON.stringify(b), false);
      const res = resultOf(r.status, b);
      if (res.processing) { const ra = Number(r.headers.get('Retry-After')); if (ra > 0) res.retry_after_ms = ra * 1000; }
      return res;
    }
    if (r.status === 402) {
      // a 402 to a fresh signature: not taken; after an unknown outcome it is no proof (payFollow checks the nonce)
      const e = errOf(402, b, true);
      if (e.code === 'HTTP_402') e.code = 'PAYMENT_REFUSED';
      if (!e.detail) { try { e.detail = String(JSON.parse(new TextDecoder().decode(base64ToBytes(r.headers.get('PAYMENT-REQUIRED') ?? ''))).error ?? ''); } catch { /* no header */ } }
      e.message = `${e.code}: ${e.detail}`;
      throw e;
    }
    const e = errOf(r.status, b, false);
    if (r.status === 503 && (e.code === 'FACILITATOR_UNAVAILABLE' || e.code === 'OFAC_UNAVAILABLE')) { e.before_payment = true; e.retryable = true; }
    throw e;
  }

  /** The payment state of a processing result (payment_id, else the path of status_url read on OUR gateway base). */
  follow(r: GwResult): Promise<GwResult> {
    if (r.payment_id) return this.view(`${trim(this.base())}/payments/${encodeURIComponent(r.payment_id)}`);
    const i = r.status_url?.indexOf('/x402/v1/payments') ?? -1;
    if (i < 0) return Promise.reject(new GwError(502, 'X402_BAD_PAYLOAD', 'processing without payment_id / status_url', false));
    return this.view(trim(this.base()) + r.status_url!.slice(i + '/x402/v1'.length));
  }

  /** GET /payments?nonce=&payer= converted like follow; 404 → GwError http 404: the authorization was never accepted. */
  paymentByNonce(nonce: string, payer: string): Promise<GwResult> {
    return this.view(`${trim(this.base())}/payments?${new URLSearchParams({ nonce, ...(payer ? { payer } : {}) })}`);
  }

  private async view(url: string): Promise<GwResult> {
    let r: Response, b: any;
    try { r = await this.fetchFn(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) }); b = await read(r); }
    catch (e) { throw new GwError(503, 'GATEWAY_UNAVAILABLE', (e as Error).message, false); }
    if (r.status !== 200) throw errOf(r.status, b, false);
    return paymentView(b);
  }

  async payment(id: string): Promise<GwResult> {
    const r = await this.fetchFn(`${trim(this.base())}/payments/${encodeURIComponent(id)}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
    const b = await read(r);
    if (r.status !== 200) throw errOf(r.status, b, false);
    return resultOf(200, b);
  }
}

export const deliveredStatus = (st?: string, code?: number) => {
  const s = String(st ?? '').toUpperCase();
  if (['DELIVERED', 'ACTIVATED', 'CONFIRMED', 'DONE', 'FULFILLED'].includes(s)) return true;
  return s === '' && code === 200;
};
export const failedStatus = (st?: string) => ['FAILED', 'REFUNDED', 'REFUND_PENDING', 'REFUND_MANUAL', 'EXPIRED'].includes(String(st ?? '').toUpperCase());

// ---------------- the paid call to its outcome (as the Signer does it: pay / lookup / follow) ----------------

export interface PayCtx {
  /** the transaction deadline (ms): no waiting past it */
  deadline: number;
  /** tron/send: the signed transaction is already in a block → a synthetic result (the tracker settles it) */
  sentOnChain?: () => Promise<GwResult | null>;
  /** pauses: between polls of a processing payment (at least, Retry-After wins when longer) and before a repeat */
  timing?: { follow_min_ms: number; repeat_ms: number };
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (event: string, detail?: Record<string, unknown>) => void;
}
export const PAY_TIMING = { follow_min_ms: 5_000, repeat_ms: 2_000 };

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One paid call: POST with the signature → the outcome, never a second payment for this offer:
 *  - 202 processing → the payment state is polled by Retry-After (≥ 5 s) until final or the deadline (then pending);
 *  - no answer (timeout / dropped): tron/send in a block → done; else the nonce lookup — found → followed; 404 → never
 *    accepted: the same signature again while it lives ≥ 22 s (up to 4 times), otherwise «not paid»
 *    (PAYMENT_NOT_TAKEN, before money → only then a fallback route, with a NEW signature);
 *  - a 402 after an unknown outcome (incl. «authorization expires too soon») is no proof: the nonce decides; the lookup
 *    unreachable → the outcome is unknown (GATEWAY_UNAVAILABLE, not before money: no fallback route);
 *  - 503 FACILITATOR_UNAVAILABLE / OFAC_UNAVAILABLE → the same signature again while it lives, then before money;
 *  - TX_IN_PROGRESS (a parallel repeat) → wait and repeat.
 * Throws GwError: before_payment = nothing was charged (a fallback route may be tried).
 */
export async function payFollow(gw: Pick<Gateway, 'pay' | 'follow' | 'paymentByNonce'>, o: Offer, sig: string, x: PayCtx): Promise<GwResult> {
  const now = x.now ?? Date.now;
  const tm = x.timing ?? PAY_TIMING;
  const sleep = x.sleep ?? realSleep;
  const sleepUntil = async (ms: number) => { if (now() + ms > x.deadline) return false; await sleep(ms); return true; };
  const auth = decodeAuthorization(sig);
  let unknown = false;
  let repeats = 0;

  const follow = async (res: GwResult): Promise<GwResult> => {
    x.log?.('processing', { product: o.product, payment_id: res.payment_id, payment_status: res.payment_status });
    let cur = res;
    for (;;) {
      if (!(await sleepUntil(Math.max(cur.retry_after_ms ?? 0, tm.follow_min_ms)))) return { ...cur, pending: true };
      if (o.product === 'tron/send') { const r = await x.sentOnChain?.(); if (r) return { ...r, payment_id: cur.payment_id }; }
      let r: GwResult;
      try { r = await gw.follow(cur); }
      catch (e) {
        const g = e as GwError;
        if (g instanceof GwError && (g.code === 'GATEWAY_UNAVAILABLE' || (g.http >= 500 && !g.refundable))) continue; // unreadable for now
        throw e;
      }
      if (!r.processing) return r;
      cur = { ...r, payment_id: r.payment_id || cur.payment_id };
    }
  };

  type Lookup = { verdict: 'found'; res?: GwResult; err?: unknown } | { verdict: 'not_taken' } | { verdict: 'unknown' };
  const lookup = async (): Promise<Lookup> => {
    if (!auth) return { verdict: 'unknown' };
    for (let t = 0; ; t++) {
      try {
        const r = await gw.paymentByNonce(auth.nonce, auth.from);
        x.log?.('nonce_found', { product: o.product, payment_id: r.payment_id, payment_status: r.payment_status });
        try { return { verdict: 'found', res: r.processing ? await follow(r) : r }; } catch (e) { return { verdict: 'found', err: e }; }
      } catch (e) {
        const g = e as GwError;
        if (g instanceof GwError) {
          if (g.http === 404) { x.log?.('nonce_absent', { product: o.product }); return { verdict: 'not_taken' }; }
          if (g.before_payment) return { verdict: 'not_taken' };      // invalid / settle_failed: no money
          if (g.refundable) return { verdict: 'found', err: g };     // paid, failed, refunded: an outcome
        }
      }
      if (t >= 3 || !(await sleepUntil(tm.repeat_ms))) return { verdict: 'unknown' };
    }
  };
  const notTaken = (g: GwError) => new GwError(402, g.http === 402 && g.code ? g.code : 'PAYMENT_NOT_TAKEN',
    `the gateway never accepted the payment authorization (no payment by its nonce)${g.detail ? ': ' + g.detail : ''}`, true);
  const stateUnknown = (m: string) => new GwError(503, 'GATEWAY_UNAVAILABLE', m, false);
  const found = (l: { res?: GwResult; err?: unknown }) => { if (l.err) throw l.err; return l.res!; };

  for (;;) {
    let ge: GwError;
    try {
      const res = await gw.pay(o, sig);
      return res.processing ? await follow(res) : res;
    } catch (e) {
      if (!(e instanceof GwError)) throw e;
      ge = e;
    }
    let repeat = false;
    if (ge.code === 'TX_IN_PROGRESS') {
      const r = await x.sentOnChain?.(); if (r) return r;
      if (!(await sleepUntil(tm.follow_min_ms))) throw ge;
      repeat = true;
    } else if (ge.code === 'GATEWAY_UNAVAILABLE' || (ge.http === 402 && (unknown || auth))) {
      if (ge.code === 'GATEWAY_UNAVAILABLE') unknown = true;
      const r = await x.sentOnChain?.(); if (r) return r;
      const l = await lookup();
      if (l.verdict === 'found') return found(l);
      if (l.verdict === 'not_taken') {
        if (ge.code === 'GATEWAY_UNAVAILABLE' && alive(auth, now()) && repeats < 4) repeat = true;
        else throw notTaken(ge);
      } else {
        if (ge.code !== 'GATEWAY_UNAVAILABLE' && !unknown) throw ge;                 // a 402 to a fresh signature: before money
        if (ge.code !== 'GATEWAY_UNAVAILABLE') throw stateUnknown(`refused after an unknown outcome, payment state unknown: ${ge.detail}`);
        if (repeats < 4 && (!auth || alive(auth, now()))) repeat = true;
      }
    } else if (ge.retryable) {
      if ((auth && !alive(auth, now())) || repeats >= 4) {
        if (unknown) { // refused now, but an earlier attempt had no answer: the nonce decides
          const l = await lookup();
          if (l.verdict === 'found') return found(l);
          if (l.verdict !== 'not_taken') throw stateUnknown(`payment state unknown: ${ge.detail}`);
        }
        throw ge;
      }
      repeat = true;
    }
    if (!repeat || now() >= x.deadline) throw ge;
    repeats++;
    x.log?.('repeat', { product: o.product, reason: ge.code });
    if (ge.code !== 'TX_IN_PROGRESS' && !(await sleepUntil(tm.repeat_ms))) throw ge;
  }
}

export { HttpError };
