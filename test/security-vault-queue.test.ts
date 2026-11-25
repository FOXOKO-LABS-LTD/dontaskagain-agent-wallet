// Security regression test (0.3.3): the vault has one queue for every change — a slow agent.create
// ack (the Signer decides how slow) no longer writes an older copy back over a revoke made meanwhile; a password change
// in the middle of saves leaves a vault that opens with the new password and keeps every change.
//
import { installFakeChrome } from './helpers/fake-chrome';
import { startMockSigner, type MockState } from './helpers/mock-signer';
import { hdAddresses, seedFromMnemonic } from '../src/lib/wallet/derive';
const ABOUT = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const A0 = hdAddresses(seedFromMnemonic(ABOUT), 0);
const st: MockState = { accounts: { [A0.tron]: { exists: true, balanceSun: 1, energy: 0, freeNet: 600, usdt: 0n } }, usdcMicro: 0n, coverPrice: '0.48', energyUsed: 0 };
const fake = installFakeChrome();
const call = fake.call;
let mock: Awaited<ReturnType<typeof startMockSigner>>;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
beforeAll(async () => { mock = await startMockSigner(st); await import('../src/background/index'); });
afterAll(async () => { await call({ cmd: 'disconnect' }).catch(() => {}); await mock.close(); });


describe('one queue for the vault', () => {
  let main = '', x = '';
  it('a revoke made while agent.create waits for its ack stays revoked (and out of the signed document)', async () => {
    await call({ cmd: 'createWallet', mnemonic: ABOUT, password: 'correct horse battery' });
    main = (await call({ cmd: 'status' })).accounts[0].id;
    await call({ cmd: 'settings', patch: { signer_url: mock.url } });
    const sync = mock.next((m) => m.type === 'wallet.sync');
    await call({ cmd: 'connect' }); await sync;
    x = (await call({ cmd: 'agentCreate', name: 'agent-x', accounts: [main] })).id;
    st.delayCreateMs = 1500;
    const creating = call({ cmd: 'agentCreate', name: 'agent-y', accounts: [main] });
    await wait(300);
    await call({ cmd: 'agentRevoke', id: x });
    const y = (await creating).id;
    st.delayCreateMs = 0;
    await wait(200);
    const s = await call({ cmd: 'status' });
    expect(s.agents.find((a: any) => a.id === x).revoked_at).toBeTruthy();
    expect(s.agents.find((a: any) => a.id === y)).toBeTruthy();
    const doc = mock.docs.at(-1).doc;
    expect(Object.keys(doc.agents)).not.toContain(x);
    expect(Object.keys(doc.agents)).toContain(y);
  });

  it('a password change racing with vault saves: every change kept, only the new password opens it', async () => {
    const pw2 = 'another horse battery staple';
    const changing = call({ cmd: 'changePassword', old_password: 'correct horse battery', new_password: pw2 });
    const books = Array.from({ length: 5 }, (_, i) => call({ cmd: 'bookAdd', label: `b${i}`, network: 'tron', address: hdAddresses(seedFromMnemonic(ABOUT), 20 + i).tron }));
    await Promise.all([changing, ...books]);
    await call({ cmd: 'lock' });
    await expect(call({ cmd: 'unlock', password: 'correct horse battery' })).rejects.toThrow();
    await call({ cmd: 'unlock', password: pw2 });
    expect((await call({ cmd: 'status' })).book).toHaveLength(5);
  }, 60_000);
});

describe('an E2E history that does not open is kept aside, a new one starts', () => {
  it('e2e_enc under another key → e2e_enc_lost_*, and the history is written again', async () => {
    const e2e = await import('../src/background/e2e');
    await chrome.storage.local.set({ e2e_enc: { v: 1, iv: 'AAAAAAAAAAAAAAAA', ct: 'AAAAAAAAAAAAAAAAAAAAAAAA' } });
    e2e.dropE2ECache();
    await e2e.e2eUnlocked();
    const all = await chrome.storage.local.get(null);
    expect(Object.keys(all).some((k) => k.startsWith('e2e_enc_lost_'))).toBe(true);
    expect(all.e2e_enc).toBeTruthy(); // written again with this vault's key
    expect((all.e2e_enc as any).ct).not.toBe('AAAAAAAAAAAAAAAAAAAAAAAA');
  });
});
