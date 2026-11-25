// Security regression test (0.3.3): concurrent bridge.mint messages do not bypass «one mint per
// bridge» or MAX_MINT_SIGNS (one queue, counters in the vault before the signature leaves); a re-sign keeps the nonce
// of the first mint; a Circle-forwarding bridge has no mint signed by the wallet.
import { installFakeChrome } from './helpers/fake-chrome';
import { startMockSigner, type MockState } from './helpers/mock-signer';
import { attest } from './helpers/attest';
import { hdAddresses, seedFromMnemonic } from '../src/lib/wallet/derive';
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



describe('bridge.mint queue', () => {
  let main = '', agentId = '';
  it('setup: one bridge signed by the human', async () => {
    await call({ cmd: 'createWallet', mnemonic: ABOUT, password: 'correct horse battery' });
    main = (await call({ cmd: 'status' })).accounts[0].id;
    await call({ cmd: 'settings', patch: { signer_url: mock.url } });
    const sync = mock.next((m) => m.type === 'wallet.sync');
    await call({ cmd: 'connect' }); await sync;
    agentId = (await call({ cmd: 'agentCreate', name: 'claude-bot', accounts: [main] })).id;
    mock.push({ type: 'request.new', id: 'nb', request: { request_id: 'awr_b1', agent: { id: agentId, name: 'claude-bot' }, account: { id: main, name: 'main' }, type: 'bridge', network: 'evm:42161',
      intent: { asset: 'USDC', from_network: 'evm:42161', to_network: 'evm:8453', amount: '20', mode: 'fast', delivery: 'self' }, status: 'pending', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString() } });
    await wait();
    await call({ cmd: 'prepare', request_id: 'awr_b1' });
    expect((await call({ cmd: 'sign', request_id: 'awr_b1', addressChecked: true })).status).toBe('signed');
  });

  it('12 bridge.mint at once with their own request ids → ONE mint signed, the rest refused', async () => {
    const msg = message(3, 6, 20_002_801n, A0.evm);
    const att = await attest(msg);
    for (let i = 0; i < 12; i++) mock.push({ type: 'bridge.mint', id: `c${i}`, request_id: `awr_mint_${i}`, parent_request_id: 'awr_b1', network: 'evm:8453', message: msg, attestation: att, message_transmitter: MT });
    await wait(2500);
    const signs = mock.received.filter((m) => m.type === 'request.sign' && String(m.request_id).startsWith('awr_mint_'));
    expect(signs).toHaveLength(1);
    expect(mock.received.filter((m) => m.type === 'request.reject' && String(m.request_id).startsWith('awr_mint_'))).toHaveLength(11);
    const { requireUnlocked } = await import('../src/background/wallet');
    const a = (await requireUnlocked()).vault.bridge_approvals!.awr_b1;
    expect(a.mint_id).toBe(signs[0].request_id);
    expect(a.mint_signs).toBe(1);
    expect(a.mint_nonce).toBe(5);
  });

  it('the same mint again (gas retries) keeps the first nonce and stops at MAX_MINT_SIGNS', async () => {
    const { requireUnlocked } = await import('../src/background/wallet');
    const { MAX_MINT_SIGNS } = await import('../src/background/evm');
    const id = (await requireUnlocked()).vault.bridge_approvals!.awr_b1.mint_id!;
    const msg = message(3, 6, 20_002_801n, A0.evm);
    const att = await attest(msg);
    st.evm!.nonce = { 8453: 9 }; // the RPC (here: the Signer) now says another nonce
    for (let i = 0; i < 6; i++) mock.push({ type: 'bridge.mint', id: `r${i}`, request_id: id, parent_request_id: 'awr_b1', network: 'evm:8453', message: msg, attestation: att, message_transmitter: MT });
    await wait(2500);
    const signs = mock.received.filter((m) => m.type === 'request.sign' && m.request_id === id);
    expect(signs).toHaveLength(MAX_MINT_SIGNS);
    const { decodeTx } = await import('../src/lib/evm/tx');
    for (const s of signs) expect((await decodeTx(s.signed.raw)).nonce).toBe(5);
  });

  it('a bridge with Circle forwarding: the wallet signs no mint for it', async () => {
    const { updateVault } = await import('../src/background/wallet');
    await updateVault((v) => { v.bridge_approvals!.awr_fwd = { ...v.bridge_approvals!.awr_b1, parent: 'awr_fwd', delivery: 'forwarding', mint_id: undefined, mint_signs: 0, mint_nonce: undefined }; });
    const msg = message(3, 6, 20_002_801n, A0.evm, 'cc');
    const rej = mock.next((m) => m.type === 'request.reject' && m.request_id === 'awr_fwd_mint');
    mock.push({ type: 'bridge.mint', id: 'fw', request_id: 'awr_fwd_mint', parent_request_id: 'awr_fwd', network: 'evm:8453', message: msg, attestation: await attest(msg), message_transmitter: MT });
    expect((await rej).detail.message).toMatch(/forwarding/);
  });
});
