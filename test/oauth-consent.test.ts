// 0.3.13: «Connect a chat app» (OAuth on the Signer, a cloud agent). The code is normalized; the consent text is
// byte-exact (the Signer verifies the same bytes); only a page of the wallet's own Signer may hand a code over; the
// consent shown comes from the Signer's WebSocket answer, cleaned; «Allow» puts a cloud agent (server-held key,
// no token) into the E2E document; «Deny» is signed too; the cloud mark is everywhere the agent is shown.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { installFakeChrome } from './helpers/fake-chrome';
import { startMockSigner, type MockState } from './helpers/mock-signer';
import { hdAddresses, seedFromMnemonic } from '../src/lib/wallet/derive';
import { acceptExternal, consentSignText, normalizeUserCode, parseConsent, redirectInfo } from '../src/lib/oauth';
import { CloudBadge, CloudPlate } from '../src/ui/common/Cloud';
import { setLangPref } from '../src/i18n';

const ABOUT = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const A0 = hdAddresses(seedFromMnemonic(ABOUT), 0);
const PW = 'correct horse battery';

describe('user code', () => {
  it('any case, spaces and dashes → XXXX-XXXX; anything else → null', () => {
    for (const v of ['ABCD-EFGH', 'abcd-efgh', 'abcdefgh', ' AbCd EfGh ', 'AB-CD-EF-GH', 'ABCD–EFGH']) expect(normalizeUserCode(v)).toBe('ABCD-EFGH');
    expect(normalizeUserCode('2B3C-4D5F')).toBe('2B3C-4D5F');
    for (const v of ['', 'ABCDEFG', 'ABCDEFGHI', 'ABCD_EFGH', 'ABCD-EFGЁ', 'ABCD.EFGH', null, 42, 'A'.repeat(50)]) expect(normalizeUserCode(v as any)).toBeNull();
  });
});

describe('consent text', () => {
  const base = { service: 'signer.dontaskagain.xyz', wallet_id: 'wal_abc', consent_id: 'oc_xyz123', client_id: 'https://claude.ai/oauth/client.json',
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback', scope: 'wallet' };
  it('approve: byte-exact, lines joined by \\n, no final newline', () => {
    expect(consentSignText({ ...base, decision: 'approve', accounts: ['acc_a', 'acc_b'], types: ['transfer', 'swap'] })).toBe(
      'Agent Wallet OAuth consent\nService: signer.dontaskagain.xyz\nWallet: wal_abc\nConsent: oc_xyz123\nClient: https://claude.ai/oauth/client.json\n' +
      'Redirect: https://claude.ai/api/mcp/auth_callback\nScope: wallet\nDecision: approve\nAccounts: acc_a,acc_b\nTypes: transfer,swap');
  });
  it('deny: accounts and types are «-»', () => {
    const s = consentSignText({ ...base, decision: 'deny', accounts: ['acc_a'], types: ['transfer'] });
    expect(s.endsWith('\nDecision: deny\nAccounts: -\nTypes: -')).toBe(true);
    expect(s.endsWith('\n')).toBe(false);
  });
});

describe('consent from the Signer', () => {
  const view = { id: 'oc_test01', client: { id: 'daa_c_x1', name: 'Claude‮ evil', uri: 'https://claude.ai/some/path', kind: 'dcr', verified: false },
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback', redirect_host: 'claude.ai', redirect_loopback: false, scope: 'wallet', expires_at: '2026-11-26T10:10:00Z' };
  it('cleaned: bidi characters out, client link reduced to its origin, verified always false', () => {
    const c = parseConsent({ consent: view });
    expect(c.client.name).toBe('Claude evil');
    expect(c.client.uri).toBe('https://claude.ai');
    expect(c.client.verified).toBe(false);
    expect(c.redirect_host).toBe('claude.ai');
  });
  it('refused: a redirect that is not https / loopback, a redirect_host that disagrees, a newline in a signed field', () => {
    expect(() => parseConsent({ consent: { ...view, redirect_uri: 'http://evil.example/cb', redirect_host: 'evil.example' } })).toThrow(/BAD_CONSENT/);
    expect(() => parseConsent({ consent: { ...view, redirect_host: 'other.example' } })).toThrow(/BAD_CONSENT/);
    expect(() => parseConsent({ consent: { ...view, client: { ...view.client, id: 'a\nDecision: approve' } } })).toThrow(/BAD_CONSENT/);
    expect(() => parseConsent({ consent: { ...view, id: 'nope' } })).toThrow(/BAD_CONSENT/);
  });
  it('loopback redirects are marked', () => {
    expect(redirectInfo('http://127.0.0.1:33418/callback')).toEqual({ host: '127.0.0.1:33418', loopback: true });
    expect(redirectInfo('http://localhost/cb')).toEqual({ host: 'localhost', loopback: true });
    expect(redirectInfo('https://chatgpt.com/connector_platform_oauth_redirect')).toEqual({ host: 'chatgpt.com', loopback: false });
    expect(redirectInfo('javascript:alert(1)')).toBeNull();
    expect(redirectInfo('https://u:p@claude.ai/cb')).toBeNull();
  });
});

describe('externally_connectable', () => {
  const msg = { type: 'daa.oauth.consent', consent_id: 'oc_abcdef', user_code: 'abcd-efgh' };
  it('accepted only from the origin of the wallet’s own Signer', () => {
    expect(acceptExternal(msg, 'https://signer.dontaskagain.xyz', 'https://signer.dontaskagain.xyz')).toEqual({ user_code: 'ABCD-EFGH', consent_id: 'oc_abcdef' });
    expect(acceptExternal(msg, 'https://signer.dontaskagain.xyz', 'https://my-signer.example')).toBeNull();
    expect(acceptExternal(msg, 'https://evil.example', 'https://signer.dontaskagain.xyz')).toBeNull();
    expect(acceptExternal(msg, undefined, 'https://signer.dontaskagain.xyz')).toBeNull();
    expect(acceptExternal(msg, 'http://signer.dontaskagain.xyz', 'https://signer.dontaskagain.xyz')).toBeNull();
  });
  it('only the consent message with a valid code', () => {
    const o = 'https://signer.dontaskagain.xyz';
    expect(acceptExternal({ ...msg, type: 'other' }, o, o)).toBeNull();
    expect(acceptExternal({ ...msg, user_code: 'bad' }, o, o)).toBeNull();
    expect(acceptExternal('x', o, o)).toBeNull();
    expect(acceptExternal({ ...msg, consent_id: '<script>' }, o, o)).toEqual({ user_code: 'ABCD-EFGH' });
  });
});

describe('cloud mark', () => {
  it('badge and plate say the Signer sees the requests (ru, en)', async () => {
    await setLangPref('ru');
    expect(renderToStaticMarkup(createElement(CloudBadge))).toContain('облачный');
    expect(renderToStaticMarkup(createElement(CloudPlate))).toContain('Signer видит запросы этого агента');
    await setLangPref('en');
    expect(renderToStaticMarkup(createElement(CloudPlate))).toContain('the Signer sees this agent’s requests');
    await setLangPref('auto');
  });
});

describe('consent against the mock Signer', () => {
  const st: MockState = { accounts: { [A0.tron]: { exists: true, balanceSun: 1, energy: 0, freeNet: 600, usdt: 0n } }, usdcMicro: 0n, coverPrice: '0.48', energyUsed: 0, e2eMode: 'on',
    oauth: { consents: {} } };
  const fake = installFakeChrome();
  const call = fake.call;
  let mock: Awaited<ReturnType<typeof startMockSigner>>;
  const consent = (id: string, extra: any = {}) => ({ view: { id, client: { id: 'https://chatgpt.com/oauth/client.json', name: 'ChatGPT', kind: 'cimd', verified: false },
    redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect', redirect_host: 'chatgpt.com', redirect_loopback: false, scope: 'wallet', expires_at: new Date(Date.now() + 600_000).toISOString(), ...extra } });
  beforeAll(async () => { mock = await startMockSigner(st); await import('../src/background/index'); });
  afterAll(async () => { await call({ cmd: 'disconnect' }).catch(() => {}); await mock.close(); });
  let ops = '';

  it('setup: E2E wallet connected', async () => {
    await call({ cmd: 'createWallet', mnemonic: ABOUT, password: PW });
    ops = (await call({ cmd: 'addAccount', name: 'ops' })).id;
    await call({ cmd: 'settings', patch: { signer_url: mock.url } });
    await call({ cmd: 'e2eEnable', on: true });
    await call({ cmd: 'connect' });
    for (let i = 0; i < 200 && !((await call({ cmd: 'status' })).signer.connected && (await call({ cmd: 'status' })).e2e.active); i++) await new Promise((r) => setTimeout(r, 25));
    expect((await call({ cmd: 'status' })).e2e.active).toBe(true);
    expect((await call({ cmd: 'status' })).e2e.oauth).toBe(true); // hello.e2e.oauth → «Connect a chat app» is shown
  });

  it('a wrong code: the Signer says CONSENT_NOT_FOUND', async () => {
    await expect(call({ cmd: 'oauthConsentGet', user_code: 'ZZZZ-ZZZZ' })).rejects.toThrow(/CONSENT_NOT_FOUND/);
    await expect(call({ cmd: 'oauthConsentGet', user_code: 'nope' })).rejects.toThrow(/BAD_CODE/);
  });

  it('allow: the signed decision, then a cloud agent (server key, no token) in the E2E document with its view', async () => {
    st.oauth!.consents['ABCD-EFGH'] = consent('oc_allow01');
    const c = await call({ cmd: 'oauthConsentGet', user_code: 'abcdefgh' });
    expect(c).toMatchObject({ id: 'oc_allow01', redirect_host: 'chatgpt.com', client: { name: 'ChatGPT', verified: false } });
    const docs0 = mock.docs.length;
    const r = await call({ cmd: 'oauthConsentDecide', consent_id: 'oc_allow01', decision: 'approve', accounts: [ops], allowed_types: ['transfer', 'swap', 'nonsense'], name: 'GPT helper' });
    expect(r).toMatchObject({ decision: 'approve', name: 'GPT helper' });
    const d = st.oauth!.decided!.at(-1)!;
    expect(d.sig_ok).toBe(true);
    expect(d.m).toMatchObject({ consent_id: 'oc_allow01', decision: 'approve', accounts: [ops], allowed_types: ['transfer', 'swap'] });
    expect(d.text).toContain(`\nAccounts: ${ops}\nTypes: transfer,swap`);
    expect(mock.docs.length).toBeGreaterThan(docs0);
    const doc = mock.docs.at(-1);
    const entry = doc.doc.agents[r.agent_id];
    expect(entry).toMatchObject({ accounts: [ops], key: { mode: 'server' }, cloud: { client_id: 'https://chatgpt.com/oauth/client.json', consent_id: 'oc_allow01' } });
    expect(doc.views[r.agent_id]).toBeTruthy();
    const a = (await call({ cmd: 'status' })).agents.find((x: any) => x.id === r.agent_id);
    expect(a).toMatchObject({ name: 'GPT helper', allowed_types: ['transfer', 'swap'], cloud: { client_name: 'ChatGPT', redirect_host: 'chatgpt.com' }, e2e: { mode: 'server' } });
    expect(a.token_prefix).toBeUndefined();
    // a consent is decided once
    await expect(call({ cmd: 'oauthConsentDecide', consent_id: 'oc_allow01', decision: 'approve', accounts: [ops], allowed_types: [] })).rejects.toThrow(/CONSENT_NOT_FOUND/);
  });

  it('deny: signed too, nothing added', async () => {
    st.oauth!.consents['WXYZ-2345'] = consent('oc_deny001', { redirect_uri: 'http://127.0.0.1:33418/callback', redirect_host: '127.0.0.1:33418', redirect_loopback: true });
    const c = await call({ cmd: 'oauthConsentGet', user_code: 'WXYZ2345' });
    expect(c.redirect_loopback).toBe(true);
    const n = (await call({ cmd: 'status' })).agents.length;
    expect(await call({ cmd: 'oauthConsentDecide', consent_id: 'oc_deny001', decision: 'deny', accounts: [ops], allowed_types: ['transfer'] })).toEqual({ decision: 'deny' });
    const d = st.oauth!.decided!.at(-1)!;
    expect(d.sig_ok).toBe(true);
    expect(d.text.endsWith('Decision: deny\nAccounts: -\nTypes: -')).toBe(true);
    expect((await call({ cmd: 'status' })).agents.length).toBe(n);
  });

  it('a decision for a consent this wallet never read is refused before anything is signed', async () => {
    const before = st.oauth!.decided!.length;
    await expect(call({ cmd: 'oauthConsentDecide', consent_id: 'oc_never01', decision: 'approve', accounts: [ops], allowed_types: [] })).rejects.toThrow(/CONSENT_NOT_FOUND/);
    expect(st.oauth!.decided!.length).toBe(before);
  });

  it('agent.list may only ADD the cloud mark (the Signer\'s record), never remove it', async () => {
    const r = await call({ cmd: 'agentCreate', name: 'remote-one', accounts: [ops], launch: 'remote' });
    (st as any).agentList = [{ id: r.id }];
    (st as any).cloudList = { [r.id]: { client_id: 'daa_c_x9', client_name: 'Claude\u202e', redirect_host: 'claude.ai', consent_id: 'oc_zz9999' } };
    await call({ cmd: 'agentsRefresh' });
    const a = (await call({ cmd: 'status' })).agents.find((x: any) => x.id === r.id);
    expect(a.cloud).toMatchObject({ client_id: 'daa_c_x9', client_name: 'Claude', redirect_host: 'claude.ai' });
    (st as any).cloudList = {};
    await call({ cmd: 'agentsRefresh' });
    expect((await call({ cmd: 'status' })).agents.find((x: any) => x.id === r.id).cloud).toBeTruthy();
  });
});
