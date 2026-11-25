// Regression tests of the 0.3.2 security review, part C. Mock Signer on
// 127.0.0.1 only.
import { installFakeChrome } from './helpers/fake-chrome';
import { startMockSigner, type MockState } from './helpers/mock-signer';
import { hdAddresses, parsePrivateKey, seedFromMnemonic } from '../src/lib/wallet/derive';
import { passwordProblem } from '../src/lib/crypto/password';
import { stripBidi } from '../src/lib/text';
import { buildOp } from '../src/lib/op';
import { fmtExact } from '../src/lib/portfolio';

const ABOUT = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PW = 'correct horse battery';
const seed = seedFromMnemonic(ABOUT);
const A0 = hdAddresses(seed, 0), A1 = hdAddresses(seed, 1);
const BOOK = hdAddresses(seed, 5).tron;
const st: MockState = {
  accounts: {
    [A0.tron]: { exists: true, balanceSun: 10_000_000, energy: 0, freeNet: 600, usdt: 0n },
    [A1.tron]: { exists: true, balanceSun: 0, energy: 1_000_000, freeNet: 600, usdt: 5_000_000n },
    [BOOK]: { exists: true, balanceSun: 1, energy: 0, freeNet: 600, usdt: 1n },
  },
  usdcMicro: 12_500_000n, coverPrice: '0.48', energyUsed: 64_285,
};
const fake = installFakeChrome();
const call = fake.call;
let mock: Awaited<ReturnType<typeof startMockSigner>>;
const wait = (ms = 150) => new Promise((r) => setTimeout(r, ms));
beforeAll(async () => { mock = await startMockSigner(st); await import('../src/background/index'); });
afterAll(async () => { await call({ cmd: 'disconnect' }).catch(() => {}); await mock.close(); });

describe('audit 0.3.2 — package C', () => {
  let ops = '', agentId = '';

  it('a weak password is refused — by the worker, not only by the page', async () => {
    for (const pw of ['aaaaaaaaaa', '1234567890', 'qwertyuiop', 'password12', 'abcdefghij']) expect(passwordProblem(pw), pw).not.toBeNull();
    expect(passwordProblem(PW)).toBeNull();
    expect(passwordProblem('Tr0ub4dor&3x')).toBeNull();
    await expect(call({ cmd: 'createWallet', mnemonic: ABOUT, password: '1234567890' })).rejects.toThrow(/WEAK_PASSWORD/);
    await call({ cmd: 'createWallet', mnemonic: ABOUT, password: PW });
    ops = (await call({ cmd: 'addAccount', name: 'ops' })).id;
  });

  it('«Сменить пароль»: old checked, new strong; then only the new one unlocks', async () => {
    await expect(call({ cmd: 'changePassword', old_password: 'wrong password!', new_password: 'n3w-Passphrase!' })).rejects.toThrow(/BAD_PASSWORD/);
    await expect(call({ cmd: 'changePassword', old_password: PW, new_password: 'qwerty1234' })).rejects.toThrow(/WEAK_PASSWORD/);
    const before = ((await chrome.storage.local.get('vault')) as any).vault.kdf.salt;
    await call({ cmd: 'changePassword', old_password: PW, new_password: 'n3w-Passphrase!' });
    expect(((await chrome.storage.local.get('vault')) as any).vault.kdf.salt).not.toBe(before);
    expect((await call({ cmd: 'status' })).unlocked).toBe(true); // the session follows the new key
    await call({ cmd: 'addAccount', name: 'after-change' });         // and saving works with it
    await call({ cmd: 'lock' });
    await expect(call({ cmd: 'unlock', password: PW })).rejects.toThrow(/BAD_PASSWORD/);
    await call({ cmd: 'unlock', password: 'n3w-Passphrase!' });
    await call({ cmd: 'changePassword', old_password: 'n3w-Passphrase!', new_password: PW });
  });

  it('«Заблокировать» during a vault save stays locked', async () => {
    const w = await import('../src/background/wallet');
    const { vault } = await w.requireUnlocked();
    vault.address_book.push({ id: 'ab_x', label: 'x', network: 'tron', address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', added_at: 'x' } as any);
    const p = w.saveVault(vault).catch((e) => (e as Error).message);
    await call({ cmd: 'lock' });
    expect(await p).toBe('LOCKED');
    expect((await call({ cmd: 'status' })).unlocked).toBe(false);
    expect(((await chrome.storage.session.get(null)) as any).unlocked).toBeUndefined();
    await call({ cmd: 'unlock', password: PW });
  });

  it('an address of the public state changed on disk → unlock refused', async () => {
    await call({ cmd: 'lock' });
    const store = await import('../src/background/store');
    const pub = await store.getPublic();
    const real = pub!.accounts[1].addresses.tron;
    pub!.accounts[1].addresses.tron = BOOK;
    await store.setPublic(pub!);
    await expect(call({ cmd: 'unlock', password: PW })).rejects.toThrow(/PUB_TAMPERED/);
    expect((await call({ cmd: 'status' })).unlocked).toBe(false);
    pub!.accounts[1].addresses.tron = real;
    await store.setPublic(pub!);
    await call({ cmd: 'unlock', password: PW });
  });

  it('the document is bound to the Signer that announced doc_service; a later hello without it there is a downgrade', async () => {
    await call({ cmd: 'settings', patch: { signer_url: mock.url } });
    const sync = mock.next((m) => m.type === 'wallet.sync');
    await call({ cmd: 'connect' });
    expect((await sync).doc.service).toBe(new URL(mock.url).host);
    agentId = (await call({ cmd: 'agentCreate', name: 'claude-bot', accounts: [ops] })).id;
    st.docService = false;
    await call({ cmd: 'disconnect' });
    await call({ cmd: 'connect' }); await wait(300);
    const n = mock.received.filter((m) => m.type === 'wallet.sync').length;
    await call({ cmd: 'renameAccount', id: ops, name: 'ops-x' });
    await wait(200);
    expect(mock.received.filter((m) => m.type === 'wallet.sync').length).toBe(n); // nothing in the unbound form here
    st.docService = undefined;
    await call({ cmd: 'disconnect' });
    await call({ cmd: 'connect' }); await wait(300);
  });

  it('a hello with a wallet_id that would change the signed text is ignored; another Signer URL forgets the wallet id and versions', async () => {
    mock.push({ type: 'hello', id: 'h-evil', wallet_id: 'wal_x\nVersion: 99', wallet_doc_version_seen: 0, networks: [] });
    await wait();
    expect((await call({ cmd: 'status' })).signer.wallet_id).toBe('wal_test');
    await call({ cmd: 'settings', patch: { signer_url: 'http://127.0.0.1:1' } });
    const s = await call({ cmd: 'status' });
    expect(s.signer.wallet_id).toBeUndefined();
    expect(s.doc_version).toBe(0);
    await call({ cmd: 'settings', patch: { signer_url: mock.url } });
    await call({ cmd: 'connect' }); await wait(300);
  });

  it('the repeat plate counts from our own clock, not from the request\'s created_at', async () => {
    const req = (id: string, ago: number) => ({ type: 'request.new', id: `n-${id}`, request: { request_id: id, agent: { id: agentId, name: 'claude-bot' }, account: { id: ops, name: 'ops' }, type: 'transfer', network: 'tron',
      intent: { asset: 'USDT', to: BOOK, amount: '0.5' }, reason: 'r', status: 'pending', created_at: new Date(Date.now() - ago).toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString() } });
    mock.push(req('awr_rep1', 0)); await wait();
    mock.push(req('awr_rep2', 5 * 3_600_000)); await wait(); // claims to be 5 h old
    const v = await call({ cmd: 'prepare', request_id: 'awr_rep2' });
    expect(v.repeat).toMatchObject({ request_id: 'awr_rep1' });
  });

  it('bidi controls are removed from the agent\'s words and name; the window shows every decimal', async () => {
    expect(stripBidi('Оплата ‮расходов‬ ⁦x⁩')).toBe('Оплата расходов x');
    mock.push({ type: 'request.new', id: 'n-bidi', request: { request_id: 'awr_bidi', agent: { id: agentId, name: 'claude‮-ops' }, account: { id: ops, name: 'ops' }, type: 'transfer', network: 'tron',
      intent: { asset: 'USDT', to: BOOK, amount: '0.5' }, reason: 'pay ‮evil‬ now', status: 'pending', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString() } });
    await wait();
    const v = await call({ cmd: 'prepare', request_id: 'awr_bidi' });
    expect(v.reason).toBe('pay evil now');
    expect(fmtExact('0.000000900000000001')).toBe('0.000000900000000001');
  });

  it('the explorer link is ours, never the server\'s explorer_url', () => {
    const h = 'ab'.repeat(32);
    const v = buildOp({ request_id: 'awr_l', type: 'transfer', network: 'tron', status: 'confirmed', intent: { asset: 'USDT', to: BOOK, amount: '1' }, tx: { tx_id: h, explorer_url: 'https://evil.example/tx' } } as any);
    const urls = JSON.stringify(v);
    expect(urls).not.toContain('evil.example');
    expect(urls).toContain(`https://tronscan.org/#/transaction/${h}`);
  });

  it('a private key ≥ n is BAD_PRIVATE_KEY without the number', () => {
    for (const k of ['f'.repeat(64), 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141', '0'.repeat(64)]) {
      expect(() => parsePrivateKey(k)).toThrow(/^BAD_PRIVATE_KEY$/);
    }
    expect(parsePrivateKey('0'.repeat(63) + '1')).toBe('0x' + '0'.repeat(63) + '1');
  });
});
