// Security regression test (0.3.3): a request once missing from request.list comes back;
// a request without expires_at expires 24 h after the wallet got it; the queue row and the notification show the
// vault's agent name, never the Signer's; the Signer's amount_out_min of a pending swap is not listed; «own» and
// «by human» in History come only from the wallet's own marks.
import { installFakeChrome } from './helpers/fake-chrome';
import { startMockSigner, type MockState } from './helpers/mock-signer';
import { hdAddresses, seedFromMnemonic } from '../src/lib/wallet/derive';

const ABOUT = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seed = seedFromMnemonic(ABOUT);
const A0 = hdAddresses(seed, 0);
const TO = hdAddresses(seed, 9).tron;
const st: MockState = { accounts: { [A0.tron]: { exists: true, balanceSun: 500_000_000, energy: 0, freeNet: 600, usdt: 0n }, [TO]: { exists: true, balanceSun: 1, energy: 0, freeNet: 600, usdt: 0n } },
  usdcMicro: 12_500_000n, coverPrice: '0.48', energyUsed: 0 };
const fake = installFakeChrome();
const call = fake.call;
let mock: Awaited<ReturnType<typeof startMockSigner>>;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
beforeAll(async () => { mock = await startMockSigner(st); await import('../src/background/index'); });
afterAll(async () => { await call({ cmd: 'disconnect' }).catch(() => {}); await mock.close(); });

describe('request list, expiry and names', () => {
  let main = '', agentId = '';
  const req = (id: string, extra: any = {}) => ({ request_id: id, agent: { id: agentId, name: 'EVIL-NAME' }, account: { id: main, name: 'main' }, type: 'transfer', network: 'tron',
    intent: { asset: 'TRX', to: TO, amount: '1' }, status: 'pending', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString(), ...extra });
  it('setup', async () => {
    await call({ cmd: 'createWallet', mnemonic: ABOUT, password: 'correct horse battery' });
    main = (await call({ cmd: 'status' })).accounts[0].id;
    await call({ cmd: 'settings', patch: { signer_url: mock.url } });
    const sync = mock.next((m) => m.type === 'wallet.sync');
    await call({ cmd: 'connect' }); await sync;
    agentId = (await call({ cmd: 'agentCreate', name: 'claude-bot', accounts: [main] })).id;
  });

  it('missing from one request.list → back in the queue when listed again', async () => {
    mock.push({ type: 'request.new', id: 'n1', request: req('awr_u1') });
    await wait(200);
    mock.push({ type: 'request.list', id: 'l-empty', requests: [] });
    await wait(200);
    expect((await call({ cmd: 'requests' })).some((r: any) => r.request_id === 'awr_u1')).toBe(false);
    mock.push({ type: 'request.list', id: 'l-again', requests: [req('awr_u1')] });
    await wait(200);
    expect((await call({ cmd: 'requests' })).some((r: any) => r.request_id === 'awr_u1')).toBe(true);
  });

  it('no expires_at → it lives 24 h from when the wallet got it', async () => {
    mock.push({ type: 'request.new', id: 'n2', request: req('awr_noexp', { expires_at: undefined }) });
    await wait(200);
    const row = (await call({ cmd: 'requests' })).find((r: any) => r.request_id === 'awr_noexp');
    expect(Date.parse(row.expires_at) - Date.now()).toBeGreaterThan(23 * 3_600_000);
    const { getSession, patchSession } = await import('../src/background/store');
    const s = await getSession();
    await patchSession({ requests: { ...s.requests, awr_noexp: { ...s.requests!.awr_noexp, received_at: Date.now() - 25 * 3_600_000 } } });
    expect((await call({ cmd: 'requests' })).some((r: any) => r.request_id === 'awr_noexp')).toBe(false);
    await expect(call({ cmd: 'sign', request_id: 'awr_noexp', addressChecked: true })).rejects.toThrow(/REQUEST_EXPIRED/);
  });

  it('the queue and the notification use the vault name; a pending swap row has no server amount_out_min', async () => {
    const n0 = fake.notifications.length;
    mock.push({ type: 'request.new', id: 'n3', request: req('awr_name', { swap: { amount_out_min: '999999' } }) });
    await wait(200);
    const row = (await call({ cmd: 'requests' })).find((r: any) => r.request_id === 'awr_name');
    expect(row.agent.name).toBe('claude-bot');
    expect(row.swap).toBeUndefined();
    const note = fake.notifications.slice(n0).map((x: any) => JSON.stringify(x)).join(' ');
    expect(note).toContain('claude-bot');
    expect(note).not.toContain('EVIL-NAME');
  });

  it('History — the server\'s «own» with an agent and «by: human» are not taken', async () => {
    mock.push({ type: 'request.update', id: 'u-h', request_id: 'awr_srv', request: req('awr_srv', { status: 'confirmed', own: true, decision: { by: 'human' } }) });
    await wait(200);
    const h = await call({ cmd: 'history' });
    expect(h.find((x: any) => x.request_id === 'awr_srv')).toMatchObject({ own: false, by: 'server' });
  });
});
