// Proof of work at wallet registration against the mock Signer: a new wallet solves the task and sends pow_nonce;
// a refused proof → a new challenge and a new task once; an existing wallet gets no task; a task over the client cap is
// refused without solving.
import { installFakeChrome } from './helpers/fake-chrome';
import { startMockSigner, type MockState } from './helpers/mock-signer';
import { hdAddresses, seedFromMnemonic } from '../src/lib/wallet/derive';

const ABOUT = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const A0 = hdAddresses(seedFromMnemonic(ABOUT), 0);
const st: MockState = { accounts: { [A0.tron]: { exists: true, balanceSun: 1, energy: 0, freeNet: 600, usdt: 0n } }, usdcMicro: 0n, coverPrice: '0.48', energyUsed: 0, pow: { bits: 12, refuseNext: 1 } };
const fake = installFakeChrome();
const call = fake.call;
let mock: Awaited<ReturnType<typeof startMockSigner>>;
beforeAll(async () => { mock = await startMockSigner(st); await import('../src/background/index'); });
afterAll(async () => { await call({ cmd: 'disconnect' }).catch(() => {}); await mock.close(); });

describe('PoW at registration', () => {
  it('a new wallet solves the task (after one refused proof, with a new challenge) and is signed in', async () => {
    await call({ cmd: 'createWallet', mnemonic: ABOUT, password: 'correct horse battery' });
    await call({ cmd: 'settings', patch: { signer_url: mock.url } });
    const sync = mock.next((m) => m.type === 'wallet.sync');
    await call({ cmd: 'connect' }); await sync;
    expect(st.verifies).toHaveLength(2);
    expect(typeof st.verifies![1].pow_nonce).toBe('string');
    expect((await call({ cmd: 'status' })).signer).toMatchObject({ connected: true, registering: null });
  });
  it('an existing wallet gets no task', async () => {
    await call({ cmd: 'disconnect' });
    st.verifies = [];
    await call({ cmd: 'connect' });
    expect(st.verifies[0].pow_nonce).toBeUndefined();
  });
  it('a task above the client cap (26 bits) is refused without solving', async () => {
    const { checkPowTask } = await import('../src/lib/signer/pow');
    expect(() => checkPowTask({ alg: 'sha256', bits: 40, salt: 'aa' })).toThrow(/POW_TOO_HARD/);
  });
});
