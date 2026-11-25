// EVM through the service worker against the mock Signer: balances of every EVM network, own EVM
// transfer (own.submit), INSUFFICIENT_GAS with the refuel hint, an agent's bridge with self delivery (approve + burn →
// bridge.mint → receiveMessage signed under the approval), an agent's bridge with auto → forwarding (no gas at the
// destination), a mint waiting for gas, refuel to Base and Arbitrum (own.refuel), REFUEL_UNSUPPORTED for Polygon,
// an agent's refuel. Nothing leaves the process.
import { installFakeChrome } from './helpers/fake-chrome';
import { startMockSigner, type MockState } from './helpers/mock-signer';
import { hdAddresses, seedFromMnemonic } from '../src/lib/wallet/derive';
import { decodeTx } from '../src/lib/evm/tx';
import { verifyApproveTx, verifyBurnTx, verifyMintTx, verifyRefuelTx, verifyTransferTx } from '../src/lib/evm/verify';
import type { Hex } from 'viem';
import { attest } from './helpers/attest';

const ABOUT = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const A0 = hdAddresses(seedFromMnemonic(ABOUT), 0);
const TM = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d', MT = '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64';
const USDC_ARB = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const E = 10n ** 18n;
const st: MockState = {
  accounts: { [A0.tron]: { exists: true, balanceSun: 100_000_000, energy: 0, freeNet: 600, usdt: 0n } },
  usdcMicro: 0n, coverPrice: '0.48', energyUsed: 40_000,
  evm: { native: { 1: E, 42161: E / 100n, 10: 0n, 137: 0n, 8453: E / 100n }, usdc: { 42161: 50_000_000n, 8453: 3_000_000n }, usdt: { 42161: 100_000_000n, 10: 5_000_000n }, allowance: { 42161: 0n } },
};
const fake = installFakeChrome();
const call = fake.call;
let mock: Awaited<ReturnType<typeof startMockSigner>>;
const pad = (h: string, n = 64) => h.replace(/^0x/, '').toLowerCase().padStart(n, '0');
const u32 = (v: number) => v.toString(16).padStart(8, '0');
/** CCTP v2 message as Iris returns it (header + BurnMessageV2). */
function message(src: number, dst: number, amount: bigint, recipient: string, burnToken = USDC_ARB) {
  return ('0x' + u32(1) + u32(src) + u32(dst) + 'aa'.repeat(32) + pad(TM) + pad(TM) + pad('0') + u32(1000) + u32(1000)
    + u32(1) + pad(burnToken) + pad(recipient) + pad(amount.toString(16)) + pad(recipient) + pad('0') + pad('0') + pad('ffff')) as Hex;
}
const newReq = (id: string, type: string, network: string, intent: any) => ({ type: 'request.new', id: `n-${id}`, request: { request_id: id, agent: { id: 'ag_x', name: 'claude-bot' },
  account: { id: '', name: 'main' }, type, network, intent, reason: 'тест', status: 'pending', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString() } });

beforeAll(async () => { mock = await startMockSigner(st); await import('../src/background/index'); });
afterAll(async () => { await call({ cmd: 'disconnect' }).catch(() => {}); await mock.close(); });

describe('EVM through the worker', () => {
  let main = '', agentId = '';
  // 0.3.2: requests come from an agent of the signed wallet document
  const push = async (m: any) => { m.request.account.id = main; m.request.agent.id = agentId; mock.push(m); await new Promise((r) => setTimeout(r, 150)); };

  it('wallet, Signer, balances of every EVM network', async () => {
    await call({ cmd: 'createWallet', mnemonic: ABOUT, password: 'correct horse battery' });
    main = (await call({ cmd: 'status' })).accounts[0].id;
    await call({ cmd: 'settings', patch: { signer_url: mock.url } });
    const sync = mock.next((m) => m.type === 'wallet.sync');
    await call({ cmd: 'connect' });
    await sync;
    agentId = (await call({ cmd: 'agentCreate', name: 'claude-bot', accounts: [main] })).id;
    const b = await call({ cmd: 'balances', id: main, force: true });
    expect(Object.keys(b.evm).sort()).toEqual(['evm:1', 'evm:10', 'evm:137', 'evm:42161', 'evm:8453']);
    expect(b.evm['evm:42161']).toMatchObject({ ETH: '0.01', USDC: '50', USDT: '100' });
    expect(b.evm['evm:10'].USDT).toBe('5');
    expect(b.evm['evm:137']).toHaveProperty('POL');
    expect(b.base).toEqual({ USDC: '3', ETH: '0.01' });
  });

  it('own transfer USDT on Arbitrum → own.submit with checked bytes', async () => {
    const v = await call({ cmd: 'evmPrepare', account_id: main, network: 'evm:42161', asset: 'USDT', to: '0x3214a0bf8a5be0d3f2a9f1d2c3b4a5968776b67c', amount: '40' });
    expect(v.blocked).toBeNull();
    expect(v.evm).toMatchObject({ kind: 'transfer', asset: 'USDT', amount: '40' });
    const sub = mock.next((m) => m.type === 'own.submit');
    const r = await call({ cmd: 'evmSign', key: v.key, addressChecked: true });
    expect(r.status).toBe('submitted');
    const m = await sub;
    expect(m).toMatchObject({ network: 'evm:42161', signed: { network: 'evm:42161' } });
    const d = await decodeTx(m.signed.raw);
    expect(d.from).toBe(A0.evm);
    verifyTransferTx(d, { chainId: 42161, to: '0x3214a0bf8a5be0d3f2a9f1d2c3b4a5968776b67c', amount: 40_000_000n, token: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9' });
  });

  it('INSUFFICIENT_GAS on Optimism → blocked, refuel hint; agent request rejected with the detail', async () => {
    const v = await call({ cmd: 'evmPrepare', account_id: main, network: 'evm:10', asset: 'USDT', to: '0x3214a0bf8a5be0d3f2a9f1d2c3b4a5968776b67c', amount: '1' });
    expect(v.blocked).toMatchObject({ code: 'INSUFFICIENT_GAS', reason_code: 'insufficient_gas', detail: { network: 'evm:10' } });
    expect(v.refuel_hint).toEqual({ to_network: 'evm:10' });
    await push(newReq('awr_g1', 'transfer', 'evm:10', { asset: 'USDT', to: '0x3214a0bf8a5be0d3f2a9f1d2c3b4a5968776b67c', amount: '1' }));
    const pv = await call({ cmd: 'prepare', request_id: 'awr_g1' });
    expect(pv.blocked.code).toBe('INSUFFICIENT_GAS');
    const rej = mock.next((m) => m.type === 'request.reject' && m.request_id === 'awr_g1');
    await call({ cmd: 'reject', request_id: 'awr_g1' });
    expect(await rej).toMatchObject({ reason_code: 'insufficient_gas', detail: { code: 'INSUFFICIENT_GAS', network: 'evm:10', have_native: '0' } });
  });

  it('agent bridge Arbitrum → Base, auto with gas at Base → self: approve + burn, then bridge.mint → receiveMessage', async () => {
    await push(newReq('awr_b1', 'bridge', 'evm:42161', { asset: 'USDC', from_network: 'evm:42161', to_network: 'evm:8453', amount: '20', mode: 'fast', delivery: 'auto' }));
    const v = await call({ cmd: 'prepare', request_id: 'awr_b1' });
    expect(v.blocked).toBeNull();
    expect(v.bridge).toMatchObject({ delivery: 'self', burn: '20.002801', max_fee: '0.002801', mode_effective: 'fast', approve: { needed: true } });
    expect(v.bridge.steps.map((s: any) => s.step)).toEqual(['approve', 'burn']);
    const sign = mock.next((m) => m.type === 'request.sign' && m.request_id === 'awr_b1');
    expect((await call({ cmd: 'sign', request_id: 'awr_b1', addressChecked: true })).status).toBe('signed');
    const m = await sign;
    expect(m.bridge).toMatchObject({ delivery: 'self', burn_amount_raw: '20002801', max_fee_raw: '2801', finality_threshold: 1000, fees: { minimum_fee_bps: '1.4', forward_fee_micro: '0' } });
    const [a, b] = await Promise.all(m.steps.map((s: any) => decodeTx(s.signed.raw)));
    verifyApproveTx(a, { chainId: 42161, token: USDC_ARB, spender: TM, amount: 20_002_801n });
    verifyBurnTx(b, { chainId: 42161, tokenMessenger: TM, burnToken: USDC_ARB, recipient: A0.evm, dstDomain: 6, burn: 20_002_801n, maxFee: 2801n, finality: 1000, forwarding: false });
    expect(b.nonce).toBe(a.nonce + 1);
    // Circle attested: the Signer pushes the mint step
    const msg = message(3, 6, 20_002_801n, A0.evm);
    const att = await attest(msg);
    const mint = mock.next((x) => x.type === 'request.sign' && x.request_id === 'awr_b1m');
    mock.push({ type: 'bridge.mint', id: 'bm1', request_id: 'awr_b1m', parent_request_id: 'awr_b1', network: 'evm:8453', message: msg, attestation: att, message_transmitter: MT, amount_raw: '20002801', recipient: A0.evm });
    const ms = await mint;
    // 0.3.2: the extension signs the mint under the human's bridge approval — not «by human»
    expect(ms.decision).toMatchObject({ by: 'extension', rule: 'bridge_approval' });
    const md = await decodeTx(ms.signed.raw);
    expect(md.from).toBe(A0.evm);
    verifyMintTx(md, { chainId: 8453, messageTransmitter: MT, message: msg, attestation: att });
  });

  it('a substituted mint message (another recipient) is refused', async () => {
    const rej = mock.next((x) => x.type === 'request.reject' && x.request_id === 'awr_b1x');
    const bad = message(3, 6, 20_002_801n, '0x3214a0bf8a5be0d3f2a9f1d2c3b4a5968776b67c');
    mock.push({ type: 'bridge.mint', id: 'bm2', request_id: 'awr_b1x', parent_request_id: 'awr_b1', network: 'evm:8453', message: bad, attestation: await attest(bad), message_transmitter: MT });
    expect(await rej).toMatchObject({ reason_code: 'unsafe', detail: { step: 'mint' } });
  });

  it('agent bridge Arbitrum → Optimism, auto without gas at Optimism → forwarding (WithHook, fee incl. Circle)', async () => {
    await push(newReq('awr_b2', 'bridge', 'evm:42161', { asset: 'USDC', from_network: 'evm:42161', to_network: 'evm:10', amount: '20', delivery: 'auto' }));
    const v = await call({ cmd: 'prepare', request_id: 'awr_b2' });
    expect(v.bridge).toMatchObject({ delivery: 'forwarding', max_fee: '0.057916', burn: '20.057916' });
    const sign = mock.next((m) => m.type === 'request.sign' && m.request_id === 'awr_b2');
    await call({ cmd: 'sign', request_id: 'awr_b2', addressChecked: true });
    const m = await sign;
    const b = await decodeTx(m.steps.at(-1).signed.raw);
    verifyBurnTx(b, { chainId: 42161, tokenMessenger: TM, burnToken: USDC_ARB, recipient: A0.evm, dstDomain: 2, burn: 20_057_916n, maxFee: 57_916n, finality: 1000, forwarding: true });
  });

  it('self to Optimism without gas: blocked INSUFFICIENT_GAS with the forwarding alternative', async () => {
    const v = await call({ cmd: 'bridgePrepare', account_id: main, from_network: 'evm:42161', to_network: 'evm:10', amount: '1', mode: 'fast', delivery: 'self' });
    expect(v.blocked).toMatchObject({ code: 'INSUFFICIENT_GAS', detail: { network: 'evm:10', alternatives: [{ delivery: 'forwarding' }] } });
    expect(v.refuel_hint).toEqual({ to_network: 'evm:10' });
  });

  it('mint without gas at the destination → request.reject insufficient_gas, kept for a retry', async () => {
    st.evm!.native[8453] = 0n;
    // the same mint request again (0.3.2: one mint request per bridge; a retry of it is allowed)
    const rej = mock.next((x) => x.type === 'request.reject' && x.request_id === 'awr_b1m');
    const msg = message(3, 6, 20_002_801n, A0.evm);
    mock.push({ type: 'bridge.mint', id: 'bm3', request_id: 'awr_b1m', parent_request_id: 'awr_b1', network: 'evm:8453', message: msg, attestation: await attest(msg), message_transmitter: MT });
    expect(await rej).toMatchObject({ reason_code: 'insufficient_gas', detail: { step: 'mint', network: 'evm:8453', have_native: '0' } });
    const s = await chrome.storage.session.get('pendingMints');
    expect(Object.keys((s as any).pendingMints)).toContain('awr_b1m');
    st.evm!.native[8453] = E / 100n;
  });

  it('own bridge Base → Arbitrum standard → own.bridge (approve not needed when the allowance equals the burn)', async () => {
    st.evm!.allowance![8453] = 1_000_000n;
    const v = await call({ cmd: 'bridgePrepare', account_id: main, from_network: 'evm:8453', to_network: 'evm:42161', amount: '1', mode: 'standard', delivery: 'self' });
    expect(v.bridge).toMatchObject({ burn: '1', max_fee: '0', mode_effective: 'standard', approve: { needed: false } });
    const sub = mock.next((m) => m.type === 'own.bridge');
    expect((await call({ cmd: 'evmSign', key: v.key, addressChecked: true })).request_id).toBe('awr_ownb1');
    const m = await sub;
    expect(m.intent).toMatchObject({ asset: 'USDC', from_network: 'evm:8453', to_network: 'evm:42161', amount: '1', mode: 'standard', delivery: 'self' });
    expect(m.steps.map((s: any) => s.step)).toEqual(['burn']);
  });

  it('refuel Ethereum → Base and → Arbitrum (own.refuel), Polygon → REFUEL_UNSUPPORTED', async () => {
    for (const [to, kind, l1] of [['evm:8453', 'op_stack', '0x3154Cf16ccdb4C6d922629664174b904d80F2C35'], ['evm:42161', 'arbitrum', '0x4Dbd4fc535Ac27206064B68FfCf827b0A60BAB3f']] as const) {
      const v = await call({ cmd: 'refuelPrepare', account_id: main, to_network: to, amount_eth: '0.003' });
      expect(v.blocked).toBeNull();
      expect(v.evm.refuel).toMatchObject({ to_network: to, kind });
      const sub = mock.next((m) => m.type === 'own.refuel');
      await call({ cmd: 'evmSign', key: v.key, addressChecked: true });
      const m = await sub;
      expect(m.intent).toEqual({ from_network: 'evm:1', to_network: to, amount_eth: '0.003' });
      const d = await decodeTx(m.signed.raw);
      verifyRefuelTx(d, { kind, l1Contract: l1, amount: 3_000_000_000_000_000n });
    }
    const p = await call({ cmd: 'refuelPrepare', account_id: main, to_network: 'evm:137', amount_eth: '0.003' });
    expect(p.blocked).toMatchObject({ code: 'REFUEL_UNSUPPORTED' });
    st.evm!.code = '0xef0100' + '11'.repeat(20);
    expect((await call({ cmd: 'refuelPrepare', account_id: main, to_network: 'evm:10', amount_eth: '0.003' })).blocked).toMatchObject({ code: 'REFUEL_UNSUPPORTED' });
    st.evm!.code = undefined;
  });

  it('agent refuel → request.sign with the Ethereum transaction', async () => {
    await push(newReq('awr_r1', 'refuel', 'evm:1', { from_network: 'evm:1', to_network: 'evm:10', amount_eth: '0.001' }));
    const sign = mock.next((m) => m.type === 'request.sign' && m.request_id === 'awr_r1');
    await call({ cmd: 'prepare', request_id: 'awr_r1' });
    await call({ cmd: 'sign', request_id: 'awr_r1', addressChecked: true });
    const m = await sign;
    expect(m.signed.network).toBe('evm:1');
    verifyRefuelTx(await decodeTx(m.signed.raw), { kind: 'op_stack', l1Contract: '0x99C9fc46f92E8a1c0deC1b1747d010903E884bE1', amount: 10n ** 15n });
  });
});
