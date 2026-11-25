// Invite-only registration and a blocked wallet against the
// mock Signer: the code is asked only when the challenge says invite_required, sent once in its canonical form and not
// kept anywhere; a Signer link is split into the address and the code; a blocked wallet is not reconnected.
import { installFakeChrome } from './helpers/fake-chrome';
import { startMockSigner, type MockState } from './helpers/mock-signer';
import { hdAddresses, seedFromMnemonic } from '../src/lib/wallet/derive';
import { normalizeInvite, parseSignerInput, readRegistration } from '../src/lib/signer/invite';

const ABOUT = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const A0 = hdAddresses(seedFromMnemonic(ABOUT), 0);
const CODE = 'daa-inv-testinvitecodeforunittesta';
const st: MockState = { accounts: { [A0.tron]: { exists: true, balanceSun: 1, energy: 0, freeNet: 600, usdt: 0n } }, usdcMicro: 0n, coverPrice: '0.48', energyUsed: 0,
  pow: { bits: 8 }, registration: { mode: 'invite', code: CODE } };
const fake = installFakeChrome();
const call = fake.call;
let mock: Awaited<ReturnType<typeof startMockSigner>>;
beforeAll(async () => { mock = await startMockSigner(st); await import('../src/background/index'); });
afterAll(async () => { await call({ cmd: 'disconnect' }).catch(() => {}); await mock.close(); });

const dumpAll = () => JSON.stringify([fake.chrome.storage.local._dump(), fake.chrome.storage.session._dump()]);

describe('invite code', () => {
  it('normalises case, dashes and spaces; refuses what cannot be a code', () => {
    for (const v of [CODE, CODE.toUpperCase(), 'daainv' + CODE.slice(8), ' DAA INV testi-nvite-codef-orunit-testa ', 'daa_inv_' + CODE.slice(8)]) expect(normalizeInvite(v)).toBe(CODE);
    for (const v of ['', 'daa-inv-', 'daa-inv-abc', CODE + 'a', 'daa-inv-' + '1'.repeat(26), 'daa-inv-' + 'a'.repeat(25) + 'b', 'dab-inv-' + CODE.slice(8)]) expect(normalizeInvite(v)).toBeNull();
  });
  it('splits a Signer link into the origin and the code', () => {
    expect(parseSignerInput(`https://signer.example.com/#invite=${CODE.toUpperCase()}`)).toEqual({ url: 'https://signer.example.com', invite: CODE });
    expect(parseSignerInput(`https://signer.example.com:8443/path?x=1#invite=${encodeURIComponent(CODE)}`)).toEqual({ url: 'https://signer.example.com:8443', invite: CODE });
    expect(parseSignerInput('https://signer.example.com/#invite=nope')).toEqual({ url: 'https://signer.example.com' });
    expect(parseSignerInput('https://signer.example.com')).toEqual({ url: 'https://signer.example.com' });
    expect(parseSignerInput(CODE)).toEqual({ invite: CODE });
    expect(parseSignerInput('hello')).toBeNull();
    expect(readRegistration({ mode: 'invite', invite_required: true })).toEqual({ mode: 'invite', invite_required: true });
    expect(readRegistration({ mode: 'weird' })).toBeUndefined();
  });
});

describe('invite-only registration and a blocked wallet', () => {
  it('asks for the code when the challenge says invite_required, without signing or solving anything', async () => {
    await call({ cmd: 'createWallet', mnemonic: ABOUT, password: 'correct horse battery' });
    await call({ cmd: 'settings', patch: { signer_url: mock.url } });
    st.verifies = [];
    await expect(call({ cmd: 'connect' })).rejects.toThrow(/INVITE_REQUIRED/);
    expect(st.verifies).toHaveLength(0);
    expect((await call({ cmd: 'status' })).signer).toMatchObject({ connected: false, invite_required: true, blocked: false });
    await expect(call({ cmd: 'connect', invite: 'not a code' })).rejects.toThrow(/INVITE_INVALID/);
    expect(st.verifies).toHaveLength(0);
  });
  it('a wrong code is refused by the Signer with a clear text', async () => {
    await expect(call({ cmd: 'connect', invite: 'daa-inv-' + 'a'.repeat(26) })).rejects.toThrow(/INVITE_INVALID: .*(invite|приглаш)/i);
    expect(st.verifies).toHaveLength(1);
    expect((await call({ cmd: 'status' })).signer.invite_required).toBe(true);
  });
  it('the right code (any case, with dashes) registers; it is sent canonical, no PoW, and kept nowhere', async () => {
    st.verifies = [];
    const sync = mock.next((m) => m.type === 'wallet.sync');
    await call({ cmd: 'connect', invite: ' ' + CODE.toUpperCase().replace('TESTI', 'TESTI-') + ' ' });
    await sync;
    expect(st.verifies).toHaveLength(1);
    expect(st.verifies![0].invite).toBe(CODE);
    expect(st.verifies![0].pow_nonce).toBeUndefined();
    expect((await call({ cmd: 'status' })).signer).toMatchObject({ connected: true, invite_required: false });
    expect(dumpAll()).not.toContain(CODE.slice(8));
    expect(dumpAll().toLowerCase()).not.toContain('testinvitecodefor');
  });
  it('an existing wallet signs in without a code (and sends none)', async () => {
    await call({ cmd: 'disconnect' });
    st.verifies = [];
    await call({ cmd: 'connect', invite: CODE });
    expect(st.verifies).toHaveLength(1);
    expect(st.verifies![0].invite).toBeUndefined();
  });
  it('a blocked wallet: the socket closes, the session is dropped, no reconnect; sign-in says WALLET_BLOCKED', async () => {
    // 0.3.7: wait up to 5 s (was 2.5 s) for the first connection — the test failed once in a full run under load
    for (let i = 0; i < 100 && !(await call({ cmd: 'status' })).signer.connected; i++) await new Promise((r) => setTimeout(r, 50));
    expect((await call({ cmd: 'status' })).signer.connected).toBe(true);
    const auths = st.wsAuths ?? 0;
    mock.block();
    await new Promise((r) => setTimeout(r, 2500)); // the socket would retry after 1 s
    const s = (await call({ cmd: 'status' })).signer;
    expect(s).toMatchObject({ connected: false, signed_in: false, blocked: true });
    expect(s.error).toMatch(/WALLET_BLOCKED/);
    expect(st.wsAuths ?? 0).toBe(auths);
    st.verifies = [];
    await expect(call({ cmd: 'connect' })).rejects.toThrow(/WALLET_BLOCKED: /);
    expect(st.verifies).toHaveLength(1);
    expect((await call({ cmd: 'status' })).signer.blocked).toBe(true);
    // unblocked by the operator: a manual sign-in works again
    st.blocked = false;
    await call({ cmd: 'connect' });
    expect((await call({ cmd: 'status' })).signer).toMatchObject({ signed_in: true, blocked: false });
  });
  it('a closed Signer says so before anything is signed', async () => {
    await call({ cmd: 'disconnect' });
    mock.forget();
    st.registration = { mode: 'closed' };
    st.verifies = [];
    await expect(call({ cmd: 'connect', invite: CODE })).rejects.toThrow(/REGISTRATION_CLOSED/);
    expect(st.verifies).toHaveLength(0);
    expect((await call({ cmd: 'status' })).signer).toMatchObject({ registration_closed: true, invite_required: false });
  });
});
