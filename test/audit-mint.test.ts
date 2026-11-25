// Regression test of the 0.3.2 security review: a bridge.mint the wallet did not start,
// a made-up attestation, or a second mint of one bridge is never signed. Nothing leaves the process.
import { installFakeChrome } from './helpers/fake-chrome';
import { startMockSigner, type MockState } from './helpers/mock-signer';
import { attest } from './helpers/attest';
import { hdAddresses, seedFromMnemonic } from '../src/lib/wallet/derive';
import { checkAttestation } from '../src/lib/evm/cctp';
import type { Hex } from 'viem';

const ABOUT = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const A0 = hdAddresses(seedFromMnemonic(ABOUT), 0);
const TM = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d', MT = '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64';
const USDC_ARB = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const E = 10n ** 18n;
const st: MockState = {
  accounts: { [A0.tron]: { exists: true, balanceSun: 100_000_000, energy: 0, freeNet: 600, usdt: 0n } },
  usdcMicro: 0n, coverPrice: '0.48', energyUsed: 40_000,
  evm: { native: { 1: E, 42161: E / 100n, 10: 0n, 137: 0n, 8453: E / 100n }, usdc: { 42161: 50_000_000n, 8453: 3_000_000n }, usdt: {}, allowance: { 42161: 0n }, baseFee: 100_000_000n, prio: 100_000_000n },
};
const fake = installFakeChrome();
const call = fake.call;
let mock: Awaited<ReturnType<typeof startMockSigner>>;
const pad = (h: string, n = 64) => h.replace(/^0x/, '').toLowerCase().padStart(n, '0');
const u32 = (v: number) => v.toString(16).padStart(8, '0');
function message(src: number, dst: number, amount: bigint, recipient: string, nonceByte = 'aa') {
  return ('0x' + u32(1) + u32(src) + u32(dst) + nonceByte.repeat(32) + pad(TM) + pad(TM) + pad('0') + u32(1000) + u32(1000)
    + u32(1) + pad(USDC_ARB) + pad(recipient) + pad(amount.toString(16)) + pad(recipient) + pad('0') + pad('0') + pad('ffff')) as Hex;
}
const GARBAGE = ('0x' + 'ab'.repeat(65)) as Hex;
const wait = (ms = 150) => new Promise((r) => setTimeout(r, ms));
beforeAll(async () => { mock = await startMockSigner(st); await import('../src/background/index'); });
afterAll(async () => { await call({ cmd: 'disconnect' }).catch(() => {}); await mock.close(); });

describe('security review 0.3.2 — bridge.mint', () => {
  let main = '', agentId = '';
  it('setup', async () => {
    await call({ cmd: 'createWallet', mnemonic: ABOUT, password: 'correct horse battery' });
    main = (await call({ cmd: 'status' })).accounts[0].id;
    await call({ cmd: 'settings', patch: { signer_url: mock.url } });
    const sync = mock.next((m) => m.type === 'wallet.sync');
    await call({ cmd: 'connect' }); await sync;
    agentId = (await call({ cmd: 'agentCreate', name: 'claude-bot', accounts: [main] })).id;
  });

  it('unsolicited mints (no bridge of this wallet) are refused — nothing signed, however many come', async () => {
    for (let i = 0; i < 3; i++) {
      const msg = message(3, 6, 1n, A0.evm, ['aa', 'bb', 'cc'][i]);
      const rej = mock.next((m) => m.type === 'request.reject' && m.request_id === `awr_fake${i}`);
      mock.push({ type: 'bridge.mint', id: `bmx${i}`, request_id: `awr_fake${i}`, parent_request_id: `awr_never_existed${i}`, network: 'evm:8453', message: msg, attestation: await attest(msg), message_transmitter: MT });
      expect(await rej).toMatchObject({ reason_code: 'unsafe', detail: { step: 'mint' } });
    }
    expect(mock.received.filter((m) => m.type === 'request.sign')).toHaveLength(0);
  });

  it('a made-up attestation is refused before gas is spent; one mint request per bridge', async () => {
    mock.push({ type: 'request.new', id: 'nb', request: { request_id: 'awr_b1', agent: { id: agentId, name: 'claude-bot' }, account: { id: main, name: 'main' }, type: 'bridge', network: 'evm:42161',
      intent: { asset: 'USDC', from_network: 'evm:42161', to_network: 'evm:8453', amount: '20', mode: 'fast', delivery: 'self' }, status: 'pending', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString() } });
    await wait();
    await call({ cmd: 'prepare', request_id: 'awr_b1' });
    expect((await call({ cmd: 'sign', request_id: 'awr_b1', addressChecked: true })).status).toBe('signed');
    const msg = message(3, 6, 20_002_801n, A0.evm);
    const rej = mock.next((m) => m.type === 'request.reject' && m.request_id === 'awr_b1m');
    mock.push({ type: 'bridge.mint', id: 'g1', request_id: 'awr_b1m', parent_request_id: 'awr_b1', network: 'evm:8453', message: msg, attestation: GARBAGE, message_transmitter: MT });
    expect((await rej).detail.message).toMatch(/attestation/);
    const ok = mock.next((m) => m.type === 'request.sign' && m.request_id === 'awr_b1m');
    mock.push({ type: 'bridge.mint', id: 'g2', request_id: 'awr_b1m', parent_request_id: 'awr_b1', network: 'evm:8453', message: msg, attestation: await attest(msg), message_transmitter: MT });
    expect((await ok).decision).toMatchObject({ by: 'extension', rule: 'bridge_approval' });
    const rej2 = mock.next((m) => m.type === 'request.reject' && m.request_id === 'awr_b1m2');
    mock.push({ type: 'bridge.mint', id: 'g3', request_id: 'awr_b1m2', parent_request_id: 'awr_b1', network: 'evm:8453', message: msg, attestation: await attest(msg), message_transmitter: MT });
    expect((await rej2).detail.message).toMatch(/already has its mint/);
  });

  it('checkAttestation: shape, v, low s, increasing signers', async () => {
    const msg = message(3, 6, 1n, A0.evm);
    await expect(checkAttestation(msg, GARBAGE)).rejects.toThrow(/attestation/);
    await expect(checkAttestation(msg, '0x1234' as Hex)).rejects.toThrow(/65-byte/);
    const good = await attest(msg);
    await expect(checkAttestation(msg, good)).resolves.toBeUndefined();
    const swapped = ('0x' + good.slice(132) + good.slice(2, 132)) as Hex; // signers in decreasing order
    await expect(checkAttestation(msg, swapped)).rejects.toThrow(/increasing/);
  });
});
