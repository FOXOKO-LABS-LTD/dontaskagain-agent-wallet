// Regression tests of the 0.3.2 security review, old (relay) mode against a hostile mock Signer — the attack
// scenarios found there now fail. Nothing leaves the process.
import { installFakeChrome } from './helpers/fake-chrome';
import { startMockSigner, type MockState } from './helpers/mock-signer';
import { decodeRaw } from '../src/lib/tron/tx';
import { hdAddresses, seedFromMnemonic } from '../src/lib/wallet/derive';

const ABOUT = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seed = seedFromMnemonic(ABOUT);
const A0 = hdAddresses(seed, 0), A1 = hdAddresses(seed, 1);
const BOOK = hdAddresses(seed, 5).tron;
const ATTACKER = hdAddresses(seed, 6).tron;
const st: MockState = {
  accounts: {
    [A0.tron]: { exists: true, balanceSun: 10_000_000, energy: 0, freeNet: 600, usdt: 0n },
    [A1.tron]: { exists: true, balanceSun: 0, energy: 1_000_000, freeNet: 600, usdt: 5_000_000n },
    [BOOK]: { exists: true, balanceSun: 1, energy: 0, freeNet: 600, usdt: 1n },
    [ATTACKER]: { exists: true, balanceSun: 1, energy: 0, freeNet: 600, usdt: 1n },
  },
  usdcMicro: 12_500_000n, coverPrice: '0.48', energyUsed: 64_285,
};
const fake = installFakeChrome();
let mock: Awaited<ReturnType<typeof startMockSigner>>;
const call = fake.call;
const wait = (ms = 120) => new Promise((x) => setTimeout(x, ms));
beforeAll(async () => { mock = await startMockSigner(st); await import('../src/background/index'); });
afterAll(async () => { await call({ cmd: 'disconnect' }).catch(() => {}); await mock.close(); });

describe('audit 0.3.2 — relay mode, hostile Signer', () => {
  let ops = '', agentId = '';
  const base = (id: string, extra: any = {}) => ({ request_id: id, agent: { id: agentId, name: 'claude-bot' }, account: { id: ops, name: 'ops' }, type: 'transfer', network: 'tron',
    intent: { asset: 'USDT', to: BOOK, amount: '1' }, reason: 'Оплата счёта', status: 'pending', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString(), ...extra });

  it('setup', async () => {
    await call({ cmd: 'createWallet', mnemonic: ABOUT, password: 'correct horse battery' });
    ops = (await call({ cmd: 'addAccount', name: 'ops' })).id;
    await call({ cmd: 'settings', patch: { signer_url: mock.url } });
    await call({ cmd: 'connect' }); await wait(200);
    agentId = (await call({ cmd: 'agentCreate', name: 'claude-bot', accounts: [ops] })).id; await wait();
    await call({ cmd: 'bookAdd', label: 'Склад', network: 'tron', address: BOOK });
  });

  it('the Signer swaps the intent of a shown request (update to signed, back to pending) → the shown 1 USDT → BOOK is what gets signed', async () => {
    mock.push({ type: 'request.new', id: 'n1', request: base('awr_poc1') }); await wait();
    const v = await call({ cmd: 'prepare', request_id: 'awr_poc1' });
    expect(v.tx).toMatchObject({ amount: '1', to: BOOK });
    mock.push({ type: 'request.update', id: 'u1', request_id: 'awr_poc1', status: 'signed' });
    mock.push({ type: 'request.update', id: 'u2', request_id: 'awr_poc1', status: 'pending', request: { ...base('awr_poc1'), intent: { asset: 'USDT', to: ATTACKER, amount: '4.9' } } });
    await wait(200);
    const rows = await call({ cmd: 'requests' });
    expect(rows.find((r: any) => r.request_id === 'awr_poc1')).toBeUndefined(); // decided requests never come back to pending
    const pinned = (await (await import('../src/background/store')).getSession()).requests!.awr_poc1.request;
    expect(pinned.intent).toMatchObject({ to: BOOK, amount: '1' }); // the intent stays what the wallet received
    await expect(call({ cmd: 'sign', request_id: 'awr_poc1', addressChecked: true, build_id: v.build_id })).rejects.toThrow(/NOT_PENDING/);
  });

  it('an amount-only change by request.update of a pending request is ignored; what is signed = what was shown', async () => {
    mock.push({ type: 'request.new', id: 'n3', request: base('awr_poc3') }); await wait();
    const v = await call({ cmd: 'prepare', request_id: 'awr_poc3' });
    mock.push({ type: 'request.update', id: 'u4', request_id: 'awr_poc3', status: 'pending', request: base('awr_poc3', { intent: { asset: 'USDT', to: BOOK, amount: '3.9' } }) });
    mock.push({ type: 'request.new', id: 'n3b', request: base('awr_poc3', { intent: { asset: 'USDT', to: ATTACKER, amount: '3.9' } }) });
    await wait(200);
    const got = mock.next((m) => m.type === 'request.sign' && m.request_id === 'awr_poc3');
    expect((await call({ cmd: 'sign', request_id: 'awr_poc3', addressChecked: false, build_id: v.build_id })).status).toBe('signed');
    const d = decodeRaw((await got).signed.tx.raw_data_hex);
    expect(d.trc20).toEqual({ to: BOOK, amountRaw: 1_000_000n });
  });

  it('«Подписать» without the shown build, with another build, or after a worker restart → a new build is shown, nothing is signed', async () => {
    mock.push({ type: 'request.new', id: 'n5', request: base('awr_poc5') }); await wait();
    const v = await call({ cmd: 'prepare', request_id: 'awr_poc5' });
    let signed = false;
    const sub = mock.next((m) => m.type === 'request.sign' && m.request_id === 'awr_poc5', 1500).then(() => { signed = true; }, () => {});
    const r1 = await call({ cmd: 'sign', request_id: 'awr_poc5', addressChecked: false, build_id: undefined });
    expect(r1.status).toBe('changed');
    expect(r1.view.build_id).toBeTruthy();
    const r2 = await call({ cmd: 'sign', request_id: 'awr_poc5', addressChecked: false, build_id: v.build_id }); // the build of r1 replaced it
    expect(r2.status).toBe('changed');
    await sub;
    expect(signed).toBe(false);
    // the shown (latest) build signs
    const got = mock.next((m) => m.type === 'request.sign' && m.request_id === 'awr_poc5');
    expect((await call({ cmd: 'sign', request_id: 'awr_poc5', addressChecked: false, build_id: r2.view.build_id })).status).toBe('signed');
    await got;
  });

  it('a build older than 30 s is rebuilt and shown, not signed silently', async () => {
    mock.push({ type: 'request.new', id: 'n6', request: base('awr_poc6') }); await wait();
    const v = await call({ cmd: 'prepare', request_id: 'awr_poc6' });
    const now = Date.now;
    Date.now = () => now() + 31_000;
    try {
      const r = await call({ cmd: 'sign', request_id: 'awr_poc6', addressChecked: false, build_id: v.build_id });
      expect(r.status).toBe('changed');
      expect(r.view.build_id).not.toBe(v.build_id);
    } finally { Date.now = now; }
  });

  it('a plaintext request with a forged `e2e` block gets no «signed by the agent key» plate', async () => {
    mock.push({ type: 'request.new', id: 'n2', request: base('awr_poc2', { e2e: { key_mode: 'agent', fp: 'AB12-CD34', confirmed: true } }) }); await wait();
    const v = await call({ cmd: 'prepare', request_id: 'awr_poc2' });
    expect(v.e2e?.mode).not.toBe('agent');
    const rows = await call({ cmd: 'requests' });
    expect(rows.find((r: any) => r.request_id === 'awr_poc2').e2e_mode).toBeUndefined();
  });

  it('an agent not in the document is blocked (not a warning), whatever name the Signer gives it', async () => {
    mock.push({ type: 'request.new', id: 'n7', request: base('awr_poc7', { agent: { id: 'ag_ghost', name: 'claude-bot' } }) }); await wait();
    const v = await call({ cmd: 'prepare', request_id: 'awr_poc7' });
    expect(v.blocked).toMatchObject({ code: 'AGENT_UNKNOWN', reason_code: 'unsafe' });
    expect(v.agent.known).toBe(false);
    await expect(call({ cmd: 'sign', request_id: 'awr_poc7', addressChecked: true, build_id: v.build_id })).rejects.toThrow(/AGENT_UNKNOWN/);
  });

  it('the name in the window is the one from the vault, not the request\'s', async () => {
    mock.push({ type: 'request.new', id: 'n8', request: base('awr_poc8', { agent: { id: agentId, name: 'бухгалтер' } }) }); await wait();
    const v = await call({ cmd: 'prepare', request_id: 'awr_poc8' });
    expect(v.agent).toMatchObject({ id: agentId, name: 'claude-bot', known: true });
  });

  it('a type the human did not allow is blocked in the relay path too', async () => {
    await call({ cmd: 'agentUpdate', id: agentId, patch: { allowed_types: ['swap'] } });
    mock.push({ type: 'request.new', id: 'n9', request: base('awr_poc9') }); await wait();
    const v = await call({ cmd: 'prepare', request_id: 'awr_poc9' });
    expect(v.blocked).toMatchObject({ code: 'TYPE_NOT_ALLOWED', reason_code: 'type_not_allowed' });
    await call({ cmd: 'agentUpdate', id: agentId, patch: { allowed_types: ['transfer', 'swap', 'bridge', 'refuel', 'x402_pay', 'tron_resource', 'contract_call'] } });
  });

  it('agent.list never adds a server-made agent to the vault (or to the signed document)', async () => {
    (st as any).agentList = [{ id: 'ag_evil', name: 'evil', accounts: [ops], token_prefix: 'aw_ag_evil_AAAA', created_at: new Date().toISOString() }];
    const list = await call({ cmd: 'agentsRefresh' });
    expect(list.find((a: any) => a.id === 'ag_evil')).toMatchObject({ unknown: true });
    const s = await call({ cmd: 'status' });
    expect(s.agents.find((a: any) => a.id === 'ag_evil')).toBeUndefined();
    const sync = mock.next((m) => m.type === 'wallet.sync');
    await call({ cmd: 'renameAccount', id: ops, name: 'ops2' });
    expect(Object.keys((await sync).doc.agents)).not.toContain('ag_evil');
    delete (st as any).agentList;
  });
});
