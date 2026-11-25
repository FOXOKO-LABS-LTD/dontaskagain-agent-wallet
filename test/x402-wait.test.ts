// 0.3.1: the gateway answers within 25 s  — the extension's paid call in E2E mode follows
// the Signer: 202 processing → polled; no answer → lookup by
// nonce → found: followed / 404: the same signature again while it lives ≥ 22 s, else «not paid» (before money → a
// fallback route with a NEW signature); a 402 after an unknown outcome is no proof; the lookup unreachable → unknown.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Gateway, GwError, decodeAuthorization, payFollow, paymentView, type Offer } from '../src/lib/e2e/gateway';

const PAYER = '0x16dDE7b0A9b092c4Dd985af5D9Ca04e389b3c87E';
let seq = 0;
function sig(liveSec = 300, payer = PAYER) {
  const nonce = '0x' + (++seq).toString(16).padStart(64, '0');
  const p = { x402Version: 2, payload: { authorization: { from: payer, to: '0x1', value: '300000', validAfter: '0', validBefore: String(Math.floor(Date.now() / 1000) + liveSec), nonce }, signature: '0xsig' } };
  return { sig: Buffer.from(JSON.stringify(p)).toString('base64'), nonce };
}

/** A fake gateway: per nonce one payment (a repeat of the same signature never charges twice). */
interface Gw {
  calls: { method: string; path: string; nonce?: string }[];
  payments: Map<string, { id: string; status: string; answer?: any; polls: number }>;
  /** what the next POSTs do, in order; empty → «ok» */
  script: ('ok' | 'processing' | 'drop_after_pay' | 'drop_before_pay' | 'expires_too_soon' | 'facilitator_503' | 'tx_in_progress')[];
  /** polls of a processing payment before it is fulfilled */
  pollsToDone: number;
  /** final state of a processing payment */
  final: 'fulfilled' | 'refunded';
  lookupDown: boolean;
  charged: number;
}
let gw: Gw;
let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const body = await new Promise<string>((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
    const url = new URL(req.url!, 'http://x');
    const path = url.pathname.replace(/^\/x402\/v1/, '');
    const send = (code: number, x: unknown, h: Record<string, string> = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...h }); res.end(JSON.stringify(x)); };
    const view = (p: { id: string; status: string; answer?: any }) => ({ payment_id: p.id, status: p.status, settle_tx: '0xsettle', status_url: `https://public.example/x402/v1/payments/${p.id}`, ...(p.answer ? { answer: p.answer } : {}) });
    if (req.method === 'GET' && path === '/payments') {
      gw.calls.push({ method: 'GET', path, nonce: url.searchParams.get('nonce') ?? undefined });
      if (gw.lookupDown) { res.socket?.destroy(); return; }
      const p = gw.payments.get(url.searchParams.get('nonce') ?? '');
      return p ? send(200, view(p)) : send(404, { error: { code: 'NOT_FOUND', message: 'no payment with this nonce' } });
    }
    const pm = path.match(/^\/payments\/(.+)$/);
    if (req.method === 'GET' && pm) {
      gw.calls.push({ method: 'GET', path });
      const p = [...gw.payments.values()].find((x) => x.id === pm[1]);
      if (!p) return send(404, { error: { code: 'NOT_FOUND' } });
      if (p.status === 'fulfilling' && ++p.polls >= gw.pollsToDone) {
        p.status = gw.final;
        p.answer = gw.final === 'fulfilled' ? { status: 'DELIVERED', payment_id: p.id } : { error: { code: 'DELIVERY_FAILED', message: 'provider failed' } };
      }
      return send(200, view(p));
    }
    if (req.method === 'POST' && path === '/tron/energy') {
      const s = req.headers['payment-signature'] as string | undefined;
      const a = s ? decodeAuthorization(s) : null;
      gw.calls.push({ method: 'POST', path, nonce: a?.nonce });
      if (!s) return send(402, {}, { 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify({ x402Version: 2, accepts: [{ amount: '300000', maxTimeoutSeconds: 300 }] })).toString('base64') });
      const known = gw.payments.get(a!.nonce);
      if (known) return known.status === 'fulfilling' ? send(202, { status: 'processing', payment_status: 'fulfilling', payment_id: known.id, status_url: `https://public.example/x402/v1/payments/${known.id}`, retry_after: 0 }) : send(200, known.answer ?? { status: 'DELIVERED', payment_id: known.id });
      const step = gw.script.shift() ?? 'ok';
      const charge = (status: string) => { gw.charged++; const p = { id: `pay_${gw.charged}`, status, polls: 0, answer: status === 'fulfilled' ? { status: 'DELIVERED', payment_id: `pay_${gw.charged}` } : undefined }; gw.payments.set(a!.nonce, p); return p; };
      switch (step) {
        case 'drop_before_pay': res.socket?.destroy(); return;
        case 'drop_after_pay': charge('fulfilled'); res.socket?.destroy(); return;
        case 'expires_too_soon': return send(402, { error: { code: 'PAYMENT_INVALID', message: 'authorization expires too soon' } });
        case 'facilitator_503': return send(503, { error: { code: 'FACILITATOR_UNAVAILABLE', message: 'verify timeout' } });
        case 'tx_in_progress': return send(200, { result: false, code: 'TX_IN_PROGRESS' });
        case 'processing': { const p = charge('fulfilling'); return send(202, { status: 'processing', payment_status: 'fulfilling', payment_id: p.id, status_url: `https://public.example/x402/v1/payments/${p.id}`, retry_after: 5 }, { 'Retry-After': '5' }); }
        default: { const p = charge('fulfilled'); return send(200, p.answer); }
      }
    }
    send(404, { error: { code: 'NOT_FOUND' } });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/x402/v1`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { gw = { calls: [], payments: new Map(), script: [], pollsToDone: 2, final: 'fulfilled', lookupDown: false, charged: 0 }; });

const sleeps: number[] = [];
function ctx(extra: Partial<Parameters<typeof payFollow>[3]> = {}) {
  sleeps.length = 0;
  // no real waiting: the pauses are recorded (Retry-After / ≥ 5 s follow, 2 s repeat) and skipped
  return { deadline: Date.now() + 120_000, sleep: async (ms: number) => { sleeps.push(ms); }, ...extra };
}
async function offer(g: Gateway): Promise<Offer> { return g.offer('tron/energy', { address: 'TXYZ', amount: 65000 }); }
const posts = () => gw.calls.filter((c) => c.method === 'POST' && c.nonce);

describe('x402 paid call to its outcome', () => {
  it('reads the authorization of PAYMENT-SIGNATURE (nonce, payer, validBefore)', () => {
    const s = sig(300);
    const a = decodeAuthorization(s.sig)!;
    expect(a).toMatchObject({ from: PAYER, nonce: s.nonce });
    expect(a.valid_before_ms).toBeGreaterThan(Date.now() + 290_000);
    expect(decodeAuthorization(s.sig.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''))?.nonce).toBe(s.nonce);
    expect(decodeAuthorization('not base64 json')).toBeNull();
  });

  it('payment states: running → processing, invalid → before money, refunded → refundable, fulfilled → the stored answer', () => {
    expect(paymentView({ payment_id: 'p', status: 'settling' })).toMatchObject({ processing: true, payment_status: 'settling', payment_id: 'p' });
    expect(() => paymentView({ status: 'invalid', reason: 'bad sig' })).toThrow(expect.objectContaining({ before_payment: true, code: 'PAYMENT_REJECTED' }));
    expect(() => paymentView({ status: 'refunded', answer: { error: { code: 'DELIVERY_FAILED', message: 'x' } } })).toThrow(expect.objectContaining({ refundable: true, code: 'DELIVERY_FAILED', before_payment: false }));
    expect(paymentView({ payment_id: 'p', status: 'fulfilled', answer: { status: 'DELIVERED' } })).toMatchObject({ status: 'DELIVERED', payment_id: 'p', pending: false, processing: false });
  });

  it('202 processing → polled by Retry-After (at least 5 s) → the stored answer, one charge', async () => {
    const g = new Gateway(() => base);
    gw.script = ['processing'];
    const s = sig();
    const r = await payFollow(g, await offer(g), s.sig, ctx());
    expect(r).toMatchObject({ status: 'DELIVERED', payment_id: 'pay_1', processing: false });
    expect(gw.charged).toBe(1);
    expect(posts()).toHaveLength(1);
    expect(gw.calls.filter((c) => c.path === '/payments/pay_1')).toHaveLength(2);
    expect(sleeps.every((ms) => ms >= 5_000)).toBe(true);
  });

  it('202 processing that ends refunded → not delivered, refundable (no second payment)', async () => {
    const g = new Gateway(() => base);
    gw.script = ['processing']; gw.final = 'refunded';
    await expect(payFollow(g, await offer(g), sig().sig, ctx())).rejects.toMatchObject({ refundable: true, before_payment: false, code: 'DELIVERY_FAILED' });
    expect(gw.charged).toBe(1);
  });

  it('processing past the deadline → returned pending (paid, outcome later)', async () => {
    const g = new Gateway(() => base);
    gw.script = ['processing'];
    const r = await payFollow(g, await offer(g), sig().sig, ctx({ deadline: Date.now() + 1_000 }));
    expect(r).toMatchObject({ pending: true, payment_id: 'pay_1' });
  });

  it('dropped after the payment → found by nonce → delivered without a second payment', async () => {
    const g = new Gateway(() => base);
    gw.script = ['drop_after_pay'];
    const s = sig();
    const r = await payFollow(g, await offer(g), s.sig, ctx());
    expect(r).toMatchObject({ status: 'DELIVERED', payment_id: 'pay_1' });
    expect(gw.charged).toBe(1);
    expect(posts()).toHaveLength(1);
    expect(gw.calls.find((c) => c.path === '/payments')?.nonce).toBe(s.nonce);
  });

  it('dropped before the payment → nonce 404 → the same signature again → delivered', async () => {
    const g = new Gateway(() => base);
    gw.script = ['drop_before_pay'];
    const s = sig();
    const r = await payFollow(g, await offer(g), s.sig, ctx());
    expect(r.status).toBe('DELIVERED');
    expect(posts().map((c) => c.nonce)).toEqual([s.nonce, s.nonce]);
    expect(gw.charged).toBe(1);
  });

  it('dropped, nonce 404, the signature lives < 22 s → «not paid» before money (the caller falls back with a NEW signature)', async () => {
    const g = new Gateway(() => base);
    gw.script = ['drop_before_pay'];
    const err = await payFollow(g, await offer(g), sig(15).sig, ctx()).catch((e) => e);
    expect(err).toBeInstanceOf(GwError);
    expect(err).toMatchObject({ code: 'PAYMENT_NOT_TAKEN', before_payment: true });
    expect(posts()).toHaveLength(1);
    expect(gw.charged).toBe(0);
  });

  it('a 402 «expires too soon» after a dropped answer is no proof: nonce found → delivered', async () => {
    const g = new Gateway(() => base);
    // first POST: charged, answer lost; the repeat (same signature) is refused by verify as too old
    gw.script = ['drop_after_pay'];
    const s = sig();
    const o = await offer(g);
    // the first lookup round fails (gateway busy), so the repeat with the same signature happens and gets 402 «expires
    // too soon» — the second lookup finds the payment
    let lookups = 0;
    const flaky: Pick<Gateway, 'pay' | 'follow' | 'paymentByNonce'> = {
      pay: async (oo, ss) => (gw.charged ? Promise.reject(new GwError(402, 'PAYMENT_INVALID', 'authorization expires too soon', true)) : g.pay(oo, ss)),
      follow: (r) => g.follow(r),
      paymentByNonce: async (n, p) => { if (lookups++ < 4) throw new GwError(503, 'GATEWAY_UNAVAILABLE', 'down', false); return g.paymentByNonce(n, p); },
    };
    const r = await payFollow(flaky, o, s.sig, ctx());
    expect(r).toMatchObject({ status: 'DELIVERED', payment_id: 'pay_1' });
    expect(gw.charged).toBe(1);
  });

  it('the lookup unreachable after a drop → the outcome is UNKNOWN (not before money: no fallback route)', async () => {
    const g = new Gateway(() => base);
    gw.script = Array(6).fill('drop_before_pay');
    gw.lookupDown = true;
    const err = await payFollow(g, await offer(g), sig().sig, ctx()).catch((e) => e);
    expect(err).toMatchObject({ code: 'GATEWAY_UNAVAILABLE', before_payment: false });
  });

  it('a 402 after a drop with the lookup unreachable → unknown, never «not paid»', async () => {
    const g = new Gateway(() => base);
    gw.script = ['drop_before_pay', 'expires_too_soon'];
    gw.lookupDown = true;
    const err = await payFollow(g, await offer(g), sig().sig, ctx()).catch((e) => e);
    expect(err).toMatchObject({ code: 'GATEWAY_UNAVAILABLE', before_payment: false });
  });

  it('503 FACILITATOR_UNAVAILABLE → the same signature again → delivered', async () => {
    const g = new Gateway(() => base);
    gw.script = ['facilitator_503'];
    const s = sig();
    const r = await payFollow(g, await offer(g), s.sig, ctx());
    expect(r.status).toBe('DELIVERED');
    expect(posts().map((c) => c.nonce)).toEqual([s.nonce, s.nonce]);
  });

  it('503 FACILITATOR_UNAVAILABLE to the end → refused before money (fallback allowed)', async () => {
    const g = new Gateway(() => base);
    gw.script = Array(6).fill('facilitator_503');
    const err = await payFollow(g, await offer(g), sig().sig, ctx()).catch((e) => e);
    expect(err).toMatchObject({ code: 'FACILITATOR_UNAVAILABLE', before_payment: true, retryable: true });
    expect(posts()).toHaveLength(5);
    expect(gw.charged).toBe(0);
  });

  it('a 402 to a fresh signature → checked by nonce (404) → refused before money', async () => {
    const g = new Gateway(() => base);
    gw.script = ['expires_too_soon'];
    const err = await payFollow(g, await offer(g), sig().sig, ctx()).catch((e) => e);
    expect(err).toMatchObject({ code: 'PAYMENT_INVALID', before_payment: true });
    expect(gw.calls.some((c) => c.path === '/payments')).toBe(true);
  });

  it('tron/send already in a block after a drop → done by the chain', async () => {
    const g = new Gateway(() => base);
    const fake: Pick<Gateway, 'pay' | 'follow' | 'paymentByNonce'> = {
      pay: async () => { throw new GwError(503, 'GATEWAY_UNAVAILABLE', 'timeout', false); },
      follow: (r) => g.follow(r), paymentByNonce: (n, p) => g.paymentByNonce(n, p),
    };
    const o: Offer = { product: 'tron/send', resource_url: '', body: {}, payment_required_raw: '' };
    const r = await payFollow(fake, o, sig().sig, ctx({ sentOnChain: async () => ({ http: 200, body: { status: 'broadcast' }, status: 'broadcast', txid: 'abc', pending: false }) }));
    expect(r).toMatchObject({ status: 'broadcast', txid: 'abc' });
  });

  it('TX_IN_PROGRESS → wait and repeat', async () => {
    const g = new Gateway(() => base);
    gw.script = ['tx_in_progress'];
    const r = await payFollow(g, await offer(g), sig().sig, ctx());
    expect(r.status).toBe('DELIVERED');
  });

  it('follow reads status_url on OUR gateway base (path only)', async () => {
    const g = new Gateway(() => base);
    gw.payments.set('0xn', { id: 'pay_9', status: 'fulfilled', answer: { status: 'DELIVERED' }, polls: 0 });
    const r = await g.follow({ http: 202, body: {}, pending: true, processing: true, status_url: 'https://public.example/x402/v1/payments/pay_9' });
    expect(r.status).toBe('DELIVERED');
    expect(gw.calls.at(-1)?.path).toBe('/payments/pay_9');
  });
});
