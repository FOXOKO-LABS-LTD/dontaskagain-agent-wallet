// Security regression test (0.3.3): no ack on request.sign (or a false «failed») never yields a second
// distinct signed transaction for one request — the window shows the signed one, «Подписать» re-sends THE SAME bytes
// (TRON: until its expiration; EVM: the same raw, same nonce); a new request of the agent to the same recipient while
// that signature may still land gets a red plate.
import { installFakeChrome } from './helpers/fake-chrome';
import { startMockSigner, type MockState } from './helpers/mock-signer';
import { hdAddresses, seedFromMnemonic } from '../src/lib/wallet/derive';
import { decodeRaw } from '../src/lib/tron/tx';

const ABOUT = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seed = seedFromMnemonic(ABOUT);
const A0 = hdAddresses(seed, 0);
const TO = hdAddresses(seed, 9).tron;
const TO_EVM = hdAddresses(seed, 9).evm;
const E = 10n ** 18n;
const st: MockState = { accounts: { [A0.tron]: { exists: true, balanceSun: 500_000_000, energy: 0, freeNet: 600, usdt: 0n }, [TO]: { exists: true, balanceSun: 1, energy: 0, freeNet: 600, usdt: 0n } },
  usdcMicro: 12_500_000n, coverPrice: '0.48', energyUsed: 0,
  evm: { native: { 1: E, 42161: E / 100n, 10: 0n, 137: 0n, 8453: E / 100n }, usdc: { 42161: 50_000_000n, 8453: 3_000_000n }, usdt: {}, allowance: { 42161: 0n } } };
const fake = installFakeChrome();
const call = fake.call;
let mock: Awaited<ReturnType<typeof startMockSigner>>;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
beforeAll(async () => { mock = await startMockSigner(st); await import('../src/background/index'); (await import('../src/background/ws')).WS_TIMING.ack_ms = 1500; });
afterAll(async () => { await call({ cmd: 'disconnect' }).catch(() => {}); await mock.close(); });

describe('one signed transaction per request', () => {
  let main = '', agentId = '';
  const newReq = (id: string, network: string, intent: any) => ({ type: 'request.new', id: `n-${id}`, request: { request_id: id, agent: { id: agentId, name: 'claude-bot' }, account: { id: main, name: 'main' }, type: 'transfer', network,
    intent, status: 'pending', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString() } });

  it('TRON: no ack → the window shows the signed transaction; the next click re-sends the same txID', async () => {
    await call({ cmd: 'createWallet', mnemonic: ABOUT, password: 'correct horse battery' });
    main = (await call({ cmd: 'status' })).accounts[0].id;
    await call({ cmd: 'settings', patch: { signer_url: mock.url } });
    const sync = mock.next((m) => m.type === 'wallet.sync');
    await call({ cmd: 'connect' }); await sync;
    agentId = (await call({ cmd: 'agentCreate', name: 'claude-bot', accounts: [main] })).id;
    mock.push(newReq('awr_pay_1', 'tron', { asset: 'TRX', to: TO, amount: '100' }));
    await wait(300);
    const v1 = await call({ cmd: 'prepare', request_id: 'awr_pay_1' });
    expect(v1.blocked).toBeNull();
    st.dropSignAck = 1;
    await expect(call({ cmd: 'sign', request_id: 'awr_pay_1', addressChecked: true, build_id: v1.build_id })).rejects.toThrow(/no ack.*(до|until)/);
    const v2 = await call({ cmd: 'prepare', request_id: 'awr_pay_1' });
    expect(v2.signed_once).toMatchObject({ txids: [v1.tx.txID], acked: false });
    expect(v2.tx.txID).toBe(v1.tx.txID);
    const again = await call({ cmd: 'sign', request_id: 'awr_pay_1', addressChecked: true, build_id: 'whatever-another-build' });
    expect(again).toMatchObject({ status: 'signed', resent: true });
    const signs = mock.received.filter((m) => m.type === 'request.sign' && m.request_id === 'awr_pay_1');
    expect(signs).toHaveLength(2);
    expect(signs[0].signed.tx.txID).toBe(signs[1].signed.tx.txID);
    expect(signs[0].signed.tx.raw_data_hex).toBe(signs[1].signed.tx.raw_data_hex);
    expect(decodeRaw(signs[0].signed.tx.raw_data_hex).to).toBe(TO);
  });

  it('a false «failed», then the agent repeats with a new request: a red plate names the live signature', async () => {
    mock.push({ type: 'request.update', id: 'u-f', request_id: 'awr_pay_1', status: 'failed', error: { code: 'BROADCAST_FAILED' } });
    await wait(200);
    mock.push(newReq('awr_pay_2', 'tron', { asset: 'TRX', to: TO, amount: '100' }));
    await wait(300);
    const v = await call({ cmd: 'prepare', request_id: 'awr_pay_2' });
    expect(v.live_signature).toMatchObject({ request_id: 'awr_pay_1' });
    expect(Date.parse(v.live_signature.until)).toBeGreaterThan(Date.now());
    await call({ cmd: 'reject', request_id: 'awr_pay_2' });
  });

  it('EVM: no ack → the re-send carries the same raw transaction (same nonce), never a second build', async () => {
    mock.push(newReq('awr_evm_1', 'evm:8453', { asset: 'USDC', to: TO_EVM, amount: '1' }));
    await wait(300);
    const v1 = await call({ cmd: 'prepare', request_id: 'awr_evm_1' });
    expect(v1.blocked).toBeNull();
    st.dropSignAck = 1;
    await expect(call({ cmd: 'sign', request_id: 'awr_evm_1', addressChecked: true, build_id: v1.build_id })).rejects.toThrow(/no ack/);
    st.evm!.nonce = { 8453: 6 }; // the RPC would now give another nonce
    await wait(200);
    const v2 = await call({ cmd: 'prepare', request_id: 'awr_evm_1' });
    expect(v2.signed_once?.txids).toHaveLength(1);
    expect((await call({ cmd: 'sign', request_id: 'awr_evm_1', addressChecked: true })).resent).toBe(true);
    const signs = mock.received.filter((m) => m.type === 'request.sign' && m.request_id === 'awr_evm_1');
    expect(signs).toHaveLength(2);
    expect(signs[0].signed.raw).toBe(signs[1].signed.raw);
  });
});
