// 0.3.5: the wallet NEVER signs on the human's behalf. A spending signature
// happens only after the human's gesture in a sign window that shows this exact operation (its build_id). The only
// signatures without a new window are steps of an operation the human already signed, and the window names them:
//   (1) x402 payment for TRON resources within the cap the window showed, bound to that request;
//   (2) bridge.mint (CCTP) to the wallet's own address for a bridge the human signed (decision.by 'extension').
// Dynamic part: the service worker against the mock Signer — nothing is signed or sent without the window's build_id;
// a request.pay / bridge.mint before the human signed is refused. Static part: no other decision values in src, every
// sign path checks the build_id first. Nothing leaves the process.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { installFakeChrome } from './helpers/fake-chrome';
import { startMockSigner, type MockState } from './helpers/mock-signer';
import { attest } from './helpers/attest';
import { hdAddresses, seedFromMnemonic } from '../src/lib/wallet/derive';
import { base64ToBytes, bytesToBase64, fromUtf8, utf8 } from '../src/lib/bytes';
import { followUps } from '../src/lib/nextSteps';
import { tl } from '../src/i18n';
import type { Hex } from 'viem';

const ABOUT = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seed = seedFromMnemonic(ABOUT);
const A0 = hdAddresses(seed, 0);
const BOOK = hdAddresses(seed, 5).tron;
const PAYTO = '0x16dDE7b0A9b092c4Dd985af5D9Ca04e389b3c87E';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const TM = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d', MT = '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64';
const USDC_ARB = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const E = 10n ** 18n;
const st: MockState = {
  accounts: {
    [A0.tron]: { exists: true, balanceSun: 10_000_000, energy: 0, freeNet: 600, usdt: 5_000_000n },
    [BOOK]: { exists: true, balanceSun: 1, energy: 0, freeNet: 600, usdt: 1n },
  },
  usdcMicro: 12_500_000n, coverPrice: '0.48', energyUsed: 64_285,
  evm: { native: { 1: E, 42161: E / 100n, 10: 0n, 137: 0n, 8453: E / 100n }, usdc: { 42161: 50_000_000n, 8453: 3_000_000n }, usdt: {}, allowance: { 42161: 0n } },
};
const fake = installFakeChrome();
const call = fake.call;
let mock: Awaited<ReturnType<typeof startMockSigner>>;
const wait = (ms = 200) => new Promise((r) => setTimeout(r, ms));
const pr402 = (amount: string) => bytesToBase64(utf8(JSON.stringify({ x402Version: 2, resource: { url: 'http://127.0.0.1:9975/x402/v1/tron/send' },
  accepts: [{ scheme: 'exact', network: 'eip155:8453', amount, asset: USDC, payTo: PAYTO, maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } }] })));
const pad = (h: string, n = 64) => h.replace(/^0x/, '').toLowerCase().padStart(n, '0');
const u32 = (v: number) => v.toString(16).padStart(8, '0');
function message(src: number, dst: number, amount: bigint, recipient: string, nonceByte = 'aa') {
  return ('0x' + u32(1) + u32(src) + u32(dst) + nonceByte.repeat(32) + pad(TM) + pad(TM) + pad('0') + u32(1000) + u32(1000)
    + u32(1) + pad(USDC_ARB) + pad(recipient) + pad(amount.toString(16)) + pad(recipient) + pad('0') + pad('0') + pad('ffff')) as Hex;
}
/** Every message to the Signer that carries a signature or would move funds. */
const SIGNING = new Set(['request.sign', 'request.pay_signed', 'own.submit', 'own.swap', 'own.bridge', 'own.refuel', 'own.resource', 'e2e.job']);
const signingSince = (n: number) => mock.received.slice(n).filter((m) => SIGNING.has(m.type));

beforeAll(async () => { mock = await startMockSigner(st); await import('../src/background/index'); });
afterAll(async () => { await call({ cmd: 'disconnect' }).catch(() => {}); await mock.close(); });

describe('no auto-sign: only the window gesture signs', () => {
  let main = '', agentId = '';
  const req = (id: string, type: string, network: string, intent: any) => ({ type: 'request.new', id: `n-${id}`, request: { request_id: id, agent: { id: agentId, name: 'claude-bot' },
    account: { id: main, name: 'main', address: A0.tron }, type, network, intent, reason: 'тест', status: 'pending', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString() },
    preview: { decision: 'human' } });

  it('setup: wallet, Signer, an agent; the state sent to the Signer claims no auto-sign', async () => {
    await call({ cmd: 'createWallet', mnemonic: ABOUT, password: 'correct horse battery' });
    main = (await call({ cmd: 'status' })).accounts[0].id;
    await call({ cmd: 'settings', patch: { signer_url: mock.url } });
    const sync = mock.next((m) => m.type === 'wallet.sync');
    await call({ cmd: 'connect' });
    const doc = (await sync).doc;
    expect(doc.global).toEqual({ similar: { prefix: 4, suffix: 4 } });
    agentId = (await call({ cmd: 'agentCreate', name: 'claude-bot', accounts: [main] })).id;
    await wait(100);
    const last = mock.docs.at(-1).doc;
    expect(last.agents[agentId]).toEqual({ name: 'claude-bot', accounts: [main], allowed_types: expect.any(Array) });
    for (const m of mock.received.filter((x) => x.type === 'state')) expect(m.auto_enabled ?? false).toBe(false);
  });

  it('TRON transfer: request.new alone signs nothing; a request.pay before the human signed is refused', async () => {
    const n0 = mock.received.length;
    mock.push(req('awr_t1', 'transfer', 'tron', { asset: 'USDT', to: BOOK, amount: '1', amount_raw: '1000000', resources: { route: 'auto', payment: { method: 'x402_base' }, max_cost_usdc: '1.00' } }));
    await wait(300);
    expect(signingSince(n0)).toEqual([]);
    const rej = mock.next((m) => m.type === 'request.reject' && m.request_id === 'awr_t1');
    mock.push({ type: 'request.pay', request_id: 'awr_t1', pay_id: 'p0', purpose: 'resources', route: 'proxy', payment_required_raw: pr402('100000'), resource_url: 'http://127.0.0.1:9975/x402/v1/tron/send' });
    expect((await rej).reason_code).toBe('unsafe');
    expect(signingSince(n0)).toEqual([]);
  });

  it('TRON transfer: no build_id / another build_id → nothing signed; the shown build → request.sign by human', async () => {
    const v = await call({ cmd: 'prepare', request_id: 'awr_t1' });
    expect(v.blocked).toBeNull();
    expect(v.build_id).toMatch(/\S/);
    // the window line: the resource payment cap it shows
    expect(followUps(v)).toEqual({ pay_cap_usdc: v.resources.approved_max_usdc });
    const n0 = mock.received.length;
    expect((await call({ cmd: 'sign', request_id: 'awr_t1', addressChecked: true, build_id: undefined })).status).toBe('changed');
    expect((await call({ cmd: 'sign', request_id: 'awr_t1', addressChecked: true, build_id: 'b_forged' })).status).toBe('changed');
    await wait(100);
    expect(signingSince(n0)).toEqual([]);
    const shown = await call({ cmd: 'prepare', request_id: 'awr_t1' });
    const got = mock.next((m) => m.type === 'request.sign' && m.request_id === 'awr_t1');
    expect((await call({ cmd: 'sign', request_id: 'awr_t1', addressChecked: true, build_id: shown.build_id })).status).toBe('signed');
    expect((await got).decision).toMatchObject({ by: 'human', rule: null });
  });

  it('exception (1): x402 pay for the signed request within its cap → signed without a window; above the cap → refused', async () => {
    const paid = mock.next((m) => m.type === 'request.pay_signed' && m.request_id === 'awr_t1');
    mock.push({ type: 'request.pay', request_id: 'awr_t1', pay_id: 'p1', purpose: 'resources', route: 'proxy', payment_required_raw: pr402('480000'), resource_url: 'http://127.0.0.1:9975/x402/v1/tron/send' });
    const p = JSON.parse(fromUtf8(base64ToBytes((await paid).payment_signature)));
    expect(p.payload.authorization.value).toBe('480000');
    const rej = mock.next((m) => m.type === 'request.reject' && m.request_id === 'awr_t1');
    mock.push({ type: 'request.pay', request_id: 'awr_t1', pay_id: 'p2', purpose: 'resources', route: 'proxy', payment_required_raw: pr402('200000'), resource_url: 'http://127.0.0.1:9975/x402/v1/tron/send' });
    expect((await rej).reason_code).toBe('resource_above_max');
  });

  it('bridge: a mint before the human signed the bridge is refused; no build_id → nothing; then exception (2) by extension', async () => {
    mock.push(req('awr_b1', 'bridge', 'evm:42161', { asset: 'USDC', from_network: 'evm:42161', to_network: 'evm:8453', amount: '20', mode: 'fast', delivery: 'self' }));
    await wait();
    const msg = message(3, 6, 20_002_801n, A0.evm);
    const att = await attest(msg);
    const n0 = mock.received.length;
    const early = mock.next((m) => m.type === 'request.reject' && m.request_id === 'awr_b1m0');
    mock.push({ type: 'bridge.mint', id: 'bm0', request_id: 'awr_b1m0', parent_request_id: 'awr_b1', network: 'evm:8453', message: msg, attestation: att, message_transmitter: MT });
    expect(await early).toMatchObject({ reason_code: 'unsafe', detail: { step: 'mint' } });
    const v = await call({ cmd: 'prepare', request_id: 'awr_b1' });
    expect(v.bridge.delivery).toBe('self');
    expect(followUps(v)).toEqual({ mint_net: 'Base' });
    expect((await call({ cmd: 'sign', request_id: 'awr_b1', addressChecked: true, build_id: undefined })).status).toBe('changed');
    expect((await call({ cmd: 'sign', request_id: 'awr_b1', addressChecked: true, build_id: 'b_forged' })).status).toBe('changed');
    await wait(100);
    expect(signingSince(n0)).toEqual([]);
    const shown = await call({ cmd: 'prepare', request_id: 'awr_b1' });
    const burn = mock.next((m) => m.type === 'request.sign' && m.request_id === 'awr_b1');
    expect((await call({ cmd: 'sign', request_id: 'awr_b1', addressChecked: true, build_id: shown.build_id })).status).toBe('signed');
    expect((await burn).decision).toMatchObject({ by: 'human' });
    const mint = mock.next((m) => m.type === 'request.sign' && m.request_id === 'awr_b1m');
    mock.push({ type: 'bridge.mint', id: 'bm1', request_id: 'awr_b1m', parent_request_id: 'awr_b1', network: 'evm:8453', message: msg, attestation: att, message_transmitter: MT, amount_raw: '20002801', recipient: A0.evm });
    expect((await mint).decision).toMatchObject({ by: 'extension', rule: 'bridge_approval' });
  });

  it('forwarding bridge: Circle mints, so the window lists no step', async () => {
    mock.push(req('awr_b2', 'bridge', 'evm:42161', { asset: 'USDC', from_network: 'evm:42161', to_network: 'evm:10', amount: '20', delivery: 'forwarding' }));
    await wait();
    const v = await call({ cmd: 'prepare', request_id: 'awr_b2' });
    expect(v.bridge.delivery).toBe('forwarding');
    expect(followUps(v)).toEqual({});
    await call({ cmd: 'reject', request_id: 'awr_b2' });
  });

  it('every request.sign of the run: by human after a window gesture, or the mint step by extension', () => {
    const signs = mock.received.filter((m) => m.type === 'request.sign');
    expect(signs.length).toBeGreaterThan(0);
    for (const m of signs) {
      if (m.decision?.by === 'extension') { expect(m.decision.rule).toBe('bridge_approval'); expect(m.request_id).toBe('awr_b1m'); continue; }
      expect(m.decision?.by).toBe('human');
    }
    // x402 payments only for the request the human signed
    expect(new Set(mock.received.filter((m) => m.type === 'request.pay_signed').map((m) => m.request_id))).toEqual(new Set(['awr_t1']));
  });
});

describe('the sign-window line', () => {
  const base: any = { key: 'k', type: 'transfer', network: 'tron', warnings: [], blocked: null };
  it('resource payment: the larger of the main and fallback ceilings; nothing when route none', () => {
    expect(followUps({ ...base, resources: { route: 'proxy', fallback_route: 'direct', approved_max_usdc: '0.576', fallback_approved_max_usdc: '0.88' } })).toEqual({ pay_cap_usdc: '0.88' });
    expect(followUps({ ...base, resources: { route: 'proxy', fallback_route: null, approved_max_usdc: '0.576', fallback_approved_max_usdc: '0.88' } })).toEqual({ pay_cap_usdc: '0.576' });
    expect(followUps({ ...base, resources: { route: 'none', fallback_route: null } })).toEqual({});
    expect(followUps(base)).toEqual({});
    expect(followUps({ ...base, type: 'swap', swap: { resources_cap_usdc: '1.2' } })).toEqual({ pay_cap_usdc: '1.2' });
    expect(followUps({ ...base, type: 'swap', swap: { resources_cap_usdc: '0' } })).toEqual({});
  });
  it('ru / en wording', () => {
    for (const [l, want] of [['ru', 'Дальше без нового окна: оплата ресурсов ≤ 0.88 USDC; зачисление на ваш адрес в Base'],
      ['en', 'Next, without a new window: resource payment ≤ 0.88 USDC; credit to your address on Base']] as const)
      expect(tl(l, 'review.next', { items: [tl(l, 'review.nextPay', { cap: '0.88' }), tl(l, 'review.nextMint', { net: 'Base' })].join('; ') })).toBe(want);
  });
});

describe('static: no auto-sign left in src', () => {
  const files: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(f)) files.push(p); } };
  walk('src');
  const src = Object.fromEntries(files.map((f) => [f, readFileSync(f, 'utf8')]));

  it('decision.by is only human, or extension for the bridge mint (evm.ts, rule bridge_approval)', () => {
    const found: string[] = [];
    for (const [f, s] of Object.entries(src)) for (const m of s.matchAll(/decision:\s*\{\s*by:\s*'([a-z_]+)'([^}]*)\}/g)) found.push(`${f}:${m[1]}:${/rule:\s*'([a-z_]+)'/.exec(m[2])?.[1] ?? ''}`);
    for (const x of found) {
      const [f, by, rule] = x.split(':');
      if (by === 'human') continue;
      // the E2E executor records the agent's own cancel (not a signature)
      if (by === 'agent' && f.endsWith(join('background', 'e2e.ts'))) continue;
      expect({ f, by, rule }).toEqual({ f: join('src', 'background', 'evm.ts'), by: 'extension', rule: 'bridge_approval' });
    }
    expect(found.some((x) => x.includes(':extension:bridge_approval'))).toBe(true);
  });

  it('no auto-sign words, statuses or fields (in code; comments may tell the history)', () => {
    for (const [f, s0] of Object.entries(src)) {
      const s = s0.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      expect({ f, hit: /by:\s*'auto'|auto_signed|autoSign|auto_allowed|auto_enabled|decideSwapAuto|spent24h|wallet_per_day|autoStage2|spentAuto/.exec(s)?.[0] ?? null }).toEqual({ f, hit: null });
    }
  });

  it('every path that sends request.sign is an allowlisted one, and every signPrepared checks the build_id first', () => {
    const sites = Object.entries(src).flatMap(([f, s]) => [...s.matchAll(/decide\('request\.sign'/g)].map(() => f)).sort();
    expect(sites).toEqual([join('src', 'background', 'evm.ts'), join('src', 'background', 'evm.ts'), join('src', 'background', 'requests.ts'), join('src', 'background', 'swap.ts')].sort());
    for (const f of ['requests.ts', 'swap.ts', 'evm.ts']) {
      const s = src[join('src', 'background', f)];
      const body = s.slice(s.indexOf('async function signPrepared('));
      expect(body.split('\n').slice(0, 3).join('\n')).toMatch(/if \(!buildId \|\| buildId !== p\.view\.build_id/);
    }
  });
});
