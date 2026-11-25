// «After creating an account I keep forgetting to give an agent access to it.» A new account (from a phrase, a new
// phrase, an imported key) gets the ticked agents in ONE wallet document update — the path of «Настройки агента»;
// nothing is widened silently; without the Signer the account exists and the binding fails with NOT_CONNECTED.
import { installFakeChrome } from './helpers/fake-chrome';
import { startMockSigner, type MockState } from './helpers/mock-signer';

const ABOUT = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const st: MockState = { accounts: {}, usdcMicro: 0n, coverPrice: '0.48', energyUsed: 64_285 };
const fake = installFakeChrome();
const call = fake.call;
let mock: Awaited<ReturnType<typeof startMockSigner>>;
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const lastDoc = () => mock.docs.at(-1).doc;

beforeAll(async () => {
  mock = await startMockSigner(st);
  await import('../src/background/index');
});
afterAll(async () => { await call({ cmd: 'disconnect' }).catch(() => {}); await mock.close(); });

describe('new account → access for agents', () => {
  let main = '', a1 = '', a2 = '', gone = '';

  it('setup: wallet, Signer, two live agents and a revoked one', async () => {
    await call({ cmd: 'createWallet', mnemonic: ABOUT, password: 'correct horse battery' });
    main = (await call({ cmd: 'status' })).accounts[0].id;
    await call({ cmd: 'settings', patch: { signer_url: mock.url } });
    await call({ cmd: 'connect' });
    // 0.3.7: a fixed 100 ms was too short under load (full suite next to a build) — the whole file then failed with
    // «Signer is not connected»; wait for the connection itself (up to 5 s)
    for (let i = 0; i < 50 && !(await call({ cmd: 'status' })).signer?.connected; i++) await tick(100);
    a1 = (await call({ cmd: 'agentCreate', name: 'one', accounts: [main] })).id;
    a2 = (await call({ cmd: 'agentCreate', name: 'two', accounts: [main] })).id;
    gone = (await call({ cmd: 'agentCreate', name: 'gone', accounts: [main] })).id;
    await call({ cmd: 'agentRevoke', id: gone });
    await tick();
  });

  it('nothing ticked → no document update', async () => {
    const acc = await call({ cmd: 'addAccount', name: 'plain' });
    await tick(); // the account itself goes into the document
    const n = mock.docs.length;
    expect(await call({ cmd: 'agentsBindAccount', account_id: acc.id, agent_ids: [] })).toEqual({ bound: [] });
    await tick();
    expect(mock.docs.length).toBe(n);
    expect(lastDoc().agents[a1].accounts).toEqual([main]);
  });

  it('HD account + two agents: one document, appended after the default (no auto-sign rules)', async () => {
    const acc = await call({ cmd: 'addAccount', name: 'ops' });
    await tick();
    const n = mock.docs.length;
    expect(await call({ cmd: 'agentsBindAccount', account_id: acc.id, agent_ids: [a1, a2] })).toEqual({ bound: [a1, a2] });
    await tick();
    expect(mock.docs.length).toBe(n + 1);
    const doc = lastDoc();
    for (const id of [a1, a2]) {
      expect(doc.agents[id].accounts).toEqual([main, acc.id]);
      expect(doc.agents[id].rules).toBeUndefined();
    }
    const view = (await call({ cmd: 'status' })).agents.find((x: any) => x.id === a1);
    expect(view.accounts).toEqual([main, acc.id]);
  });

  it('imported key and a new phrase work the same way', async () => {
    const key = await call({ cmd: 'importKey', privateKey: '0x' + '0'.repeat(63) + '9', name: 'cold' });
    await call({ cmd: 'agentsBindAccount', account_id: key.id, agent_ids: [a2] });
    const LEGAL = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
    const r = await call({ cmd: 'seedCreate', name: 'Office', mnemonic: LEGAL, account_name: 'office' });
    await call({ cmd: 'agentsBindAccount', account_id: r.account.id, agent_ids: [a2] });
    await tick();
    expect(lastDoc().agents[a2].accounts.slice(-2)).toEqual([key.id, r.account.id]);
    expect(lastDoc().agents[a1].accounts).not.toContain(key.id);
  });

  it('a revoked / unknown agent → refused, nothing changed', async () => {
    const acc = await call({ cmd: 'addAccount', name: 'x' });
    await tick();
    const n = mock.docs.length;
    await expect(call({ cmd: 'agentsBindAccount', account_id: acc.id, agent_ids: [a1, gone] })).rejects.toThrow(/UNKNOWN_AGENT/);
    await expect(call({ cmd: 'agentsBindAccount', account_id: 'acc_nope', agent_ids: [a1] })).rejects.toThrow(/UNKNOWN_ACCOUNT/);
    await tick();
    expect(mock.docs.length).toBe(n);
    expect((await call({ cmd: 'status' })).agents.find((x: any) => x.id === a1).accounts).not.toContain(acc.id);
  });

  it('without the Signer: the account is created, the binding fails with NOT_CONNECTED and saves nothing', async () => {
    await call({ cmd: 'disconnect' });
    await tick();
    const acc = await call({ cmd: 'addAccount', name: 'offline' });
    expect((await call({ cmd: 'status' })).accounts.map((a: any) => a.id)).toContain(acc.id);
    const n = mock.docs.length;
    await expect(call({ cmd: 'agentsBindAccount', account_id: acc.id, agent_ids: [a1] })).rejects.toThrow(/^NOT_CONNECTED/);
    expect((await call({ cmd: 'status' })).agents.find((x: any) => x.id === a1).accounts).not.toContain(acc.id);
    // later, from the agent's settings (the «привязать позже» path) once connected
    await call({ cmd: 'connect' });
    await tick(150);
    const cur = (await call({ cmd: 'status' })).agents.find((x: any) => x.id === a1).accounts;
    await call({ cmd: 'agentUpdate', id: a1, patch: { accounts: [...cur, acc.id] } });
    await tick();
    expect(mock.docs.length).toBeGreaterThan(n);
    expect(lastDoc().agents[a1].accounts).toContain(acc.id);
  });
});
