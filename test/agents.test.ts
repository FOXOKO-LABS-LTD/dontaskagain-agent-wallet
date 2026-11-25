// 0.2.1: agent settings — what to run on the agent's side (pure) and the worker flow against the mock Signer:
// a new agent gets every type and its own MCP name; «Настройки агента» changes go into the wallet document; an agent
// of ≤ 0.2.0 is asked once about the new types (nothing allowed silently); token re-issue; revoke → remove command.
import { installFakeChrome } from './helpers/fake-chrome';
import { startMockSigner, type MockState } from './helpers/mock-signer';
import { hdAddresses, seedFromMnemonic } from '../src/lib/wallet/derive';
import { LEGACY_MCP_NAME, claudeAdd, npxDefaultCommand, claudeRemove, claudeReplace, envFile, envFileName, mcpJson, mcpNameFor, npxConfigSteps, npxWhoami, shq, slugOf } from '../src/lib/agentConnect';
import { ALL_TYPES, LEGACY_TYPES, newTypesOf } from '../src/lib/wallet/model';

describe('agent connection commands', () => {
  it('slug and a unique MCP name per agent', () => {
    expect(slugOf('Claude Bot №2')).toBe('claude-bot-no2');
    expect(slugOf('Café Agent 2')).toBe('cafe-agent-2');
    expect(slugOf('Бухгалтер')).toBe('buhgalter');
    expect(slugOf('  ---  ')).toBe('');
    expect(slugOf('x'.repeat(50))).toHaveLength(32);
    expect(mcpNameFor('claude-bot', 'ag_1', [])).toBe('dontaskagain-claude-bot');
    expect(mcpNameFor('Claude Bot', 'ag_1', ['dontaskagain-claude-bot'])).toBe('dontaskagain-claude-bot-2');
    expect(mcpNameFor('claude bot', 'ag_1', ['dontaskagain-claude-bot', 'dontaskagain-claude-bot-2'])).toBe('dontaskagain-claude-bot-3');
    expect(mcpNameFor('🙂', 'ag_k3x9', [])).toBe('dontaskagain-k3x9');
  });

  it('add / replace / remove for Claude Code and JSON for other clients; never a path of this server', () => {
    const c = { name: 'dontaskagain-bot', url: 'https://wallet.example', token: 'aw_ag_1_TOKEN', launch: { kind: 'npx' as const } };
    expect(claudeRemove('dontaskagain-bot')).toBe('claude mcp remove -s user dontaskagain-bot');
    expect(claudeReplace(LEGACY_MCP_NAME, c)).toBe(`claude mcp remove -s user agent-wallet && ${claudeAdd(c)}`);
    expect(claudeAdd({ ...c, launch: { kind: 'npx' } })).toMatch(/ -- npx -y dontaskagain-mcp@0\.1\.4$/); // 0.3.11: from npm (the site archive before)
    expect(JSON.parse(mcpJson({ ...c, launch: { kind: 'npx' } })).mcpServers['dontaskagain-bot']).toEqual({ command: 'npx', args: ['-y', 'dontaskagain-mcp@0.1.4'], env: { DAA_CONFIG: '~/.dontaskagain/dontaskagain-bot.env' } });
    // 0.3.3 (dontaskagain-mcp 0.1.1): the secrets in a downloaded file, the MCP added by DAA_CONFIG, whoami to compare
    const e = { ...c, launch: { kind: 'npx' as const }, e2e: { wallet: 'SIG.KEX', wallet_id: 'wal_x', pair: 'PAIRCODE' } };
    expect(envFileName(e)).toBe('dontaskagain-bot.env');
    expect(envFile(e)).toBe('DAA_URL=https://wallet.example\nDAA_TOKEN=aw_ag_1_TOKEN\nDAA_WALLET=SIG.KEX\nDAA_WALLET_ID=wal_x\nDAA_PAIR=PAIRCODE\n');
    expect(npxConfigSteps(e)).toBe('mkdir -p -m 700 ~/.dontaskagain\nmv ~/Downloads/dontaskagain-bot.env ~/.dontaskagain/ && chmod 600 ~/.dontaskagain/dontaskagain-bot.env\n'
      + 'claude mcp add -s user dontaskagain-bot -e DAA_CONFIG=~/.dontaskagain/dontaskagain-bot.env -- npx -y dontaskagain-mcp@0.1.4');
    expect(npxConfigSteps(e)).not.toContain('aw_ag_1_TOKEN');
    expect(npxWhoami(e)).toBe('DAA_CONFIG=~/.dontaskagain/dontaskagain-bot.env npx -y dontaskagain-mcp@0.1.4 whoami');
    expect(claudeAdd(e)).toContain('-e DAA_WALLET_ID=wal_x -e DAA_PAIR=PAIRCODE -- npx -y dontaskagain-mcp@0.1.4');
    expect(npxWhoami({ ...e, launch: { kind: 'npx', path: '/opt/d.tgz' } })).toBe('DAA_CONFIG=~/.dontaskagain/dontaskagain-bot.env npx -y -p /opt/d.tgz dontaskagain-mcp whoami');
    expect(shq("it's")).toBe(`'it'\\''s'`);
  });

  it('new types of an agent: legacy agents miss swap/bridge/refuel; answered → none', () => {
    expect(newTypesOf({ allowed_types: [...LEGACY_TYPES] })).toEqual(['swap', 'bridge', 'refuel']);
    expect(newTypesOf({ allowed_types: ['transfer'] })).toEqual(['swap', 'bridge', 'refuel']); // a type taken away earlier is not «new»
    expect(newTypesOf({ allowed_types: ['transfer'], known_types: [...ALL_TYPES] })).toEqual([]);
    expect(newTypesOf({ allowed_types: [...ALL_TYPES] })).toEqual([]);
  });
});

const ABOUT = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const A0 = hdAddresses(seedFromMnemonic(ABOUT), 0), A1 = hdAddresses(seedFromMnemonic(ABOUT), 1);
const st: MockState = {
  accounts: { [A0.tron]: { exists: true, balanceSun: 0, energy: 0, freeNet: 600, usdt: 0n }, [A1.tron]: { exists: true, balanceSun: 0, energy: 0, freeNet: 600, usdt: 0n } },
  usdcMicro: 0n, coverPrice: '0.48', energyUsed: 64_285,
};
const fake = installFakeChrome();
const call = fake.call;
let mock: Awaited<ReturnType<typeof startMockSigner>>;
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const lastDoc = () => mock.docs.at(-1).doc;
const agentOf = async (id: string) => (await call({ cmd: 'status' })).agents.find((x: any) => x.id === id);

beforeAll(async () => {
  mock = await startMockSigner(st);
  await import('../src/background/index');
});
afterAll(async () => { await call({ cmd: 'disconnect' }).catch(() => {}); await mock.close(); });

describe('agent settings (worker + mock Signer)', () => {
  let main = '', ops = '', id = '';

  it('a new agent: every type, its own MCP name, the command of the agent machine', async () => {
    await call({ cmd: 'createWallet', mnemonic: ABOUT, password: 'correct horse battery' });
    ops = (await call({ cmd: 'addAccount', name: 'ops' })).id;
    main = (await call({ cmd: 'status' })).accounts[0].id;
    await call({ cmd: 'settings', patch: { signer_url: mock.url } });
    await call({ cmd: 'connect' });
    await tick(400); // hello and the first document first (under a parallel run 100 ms was not always enough)
    const r = await call({ cmd: 'agentCreate', name: 'Claude Bot', accounts: [ops] });
    id = r.id;
    expect(r.mcp_name).toBe('dontaskagain-claude-bot');
    expect(r.old_mcp_name).toBeNull();
    expect(r.claude).toBe(`claude mcp add -s user dontaskagain-claude-bot -e DAA_URL=${mock.url} -e DAA_TOKEN=${r.token} -- ${npxDefaultCommand()}`);
    expect(r.claude).not.toContain('/home/');
    await tick();
    expect(lastDoc().agents[id].allowed_types).toEqual(ALL_TYPES);
    const a = await agentOf(id);
    expect(a).toMatchObject({ new_types: [], mcp_name: 'dontaskagain-claude-bot' });
    // a second agent with the same name does not collide on one machine
    const r2 = await call({ cmd: 'agentCreate', name: 'claude bot', accounts: [ops] });
    expect(r2.mcp_name).toBe('dontaskagain-claude-bot-2');
    // the last launch choice is kept locally and used for the next agent
    await call({ cmd: 'settings', patch: { mcp_launch: 'npx', mcp_launch_path: '/opt/aw/pkg.tgz' } });
    const r3 = await call({ cmd: 'agentCreate', name: 'third', accounts: [ops] });
    expect(r3.claude).toMatch(/ -- npx -y -p \/opt\/aw\/pkg\.tgz dontaskagain-mcp$/);
    await expect(call({ cmd: 'settings', patch: { mcp_launch: 'custom' } })).rejects.toThrow(/BAD_LAUNCH/);
    await expect(call({ cmd: 'agentCreate', name: 'x', accounts: [ops], launch: 'custom' })).rejects.toThrow(/BAD_LAUNCH/);
    await expect(call({ cmd: 'settings', patch: { mcp_launch: 'curl' } })).rejects.toThrow(/BAD_LAUNCH/);
  });

  it('«Настройки агента»: name, accounts with the default first, types — all in the next document (no auto-sign limits)', async () => {
    await call({ cmd: 'agentUpdate', id, patch: { name: 'Бухгалтер' } });
    expect(lastDoc().agents[id].name).toBe('Бухгалтер');
    await call({ cmd: 'agentUpdate', id, patch: { accounts: [main, ops, 'acc_gone'] } });
    expect(lastDoc().agents[id].accounts).toEqual([main, ops]);
    await call({ cmd: 'agentUpdate', id, patch: { allowed_types: ['bridge', 'transfer', 'nonsense'] } });
    expect(lastDoc().agents[id].allowed_types).toEqual(['transfer', 'bridge']);
    await call({ cmd: 'agentUpdate', id, patch: { limits: { [ops]: { transfer: { per_tx: { 'tron/USDT': '5', 'evm:*/USDC': 'x' }, per_day: { 'tron/USDT': '15' }, max_count_per_day: 7 },
      x402: { per_tx: { 'evm:8453/USDC': '0.5' }, per_day: {}, max_count_per_day: 0 } } } } });
    const a = await agentOf(id);
    expect(a.rules).toBeUndefined(); // 0.3.5: limits from an old page are ignored, nothing auto-signs
    expect(lastDoc().agents[id].rules).toBeUndefined();
    expect(a.name).toBe('Бухгалтер');
    expect(a.mcp_name).toBe('dontaskagain-claude-bot'); // the agent side keeps its name after a rename
    await expect(call({ cmd: 'agentUpdate', id, patch: { accounts: [] } })).rejects.toThrow(/NO_ACCOUNTS/);
    await expect(call({ cmd: 'agentUpdate', id, patch: { name: ' ' } })).rejects.toThrow(/BAD_NAME/);
  });

  it('an agent of ≤ 0.2.0: asked once about the new types, nothing allowed silently', async () => {
    const { dropStorageCache } = await import('../src/background/store');
    const ses = (fake.chrome.storage.session as any)._dump();
    const legacy = ses.unlocked.vault.agents[id];
    legacy.allowed_types = [...LEGACY_TYPES];
    delete legacy.known_types; delete legacy.mcp_name;
    dropStorageCache();
    const a = await agentOf(id);
    expect(a.new_types).toEqual(['swap', 'bridge', 'refuel']);
    expect(a.mcp_name).toBe('agent-wallet');
    const before = mock.docs.length;
    await call({ cmd: 'agentNewTypes', id, allow: ['bridge', 'refuel', 'contract_call_not_new'] });
    expect(lastDoc().agents[id].allowed_types).toEqual(['transfer', 'bridge', 'refuel', 'x402_pay', 'tron_resource', 'contract_call']);
    expect(mock.docs.length).toBe(before + 1);
    expect((await agentOf(id)).new_types).toEqual([]); // swap stays off and is not asked again
    // «Не разрешать»: answered, the document does not change
    const s2 = (fake.chrome.storage.session as any)._dump();
    const other = Object.keys(s2.unlocked.vault.agents).find((x) => x !== id)!;
    s2.unlocked.vault.agents[other].allowed_types = ['transfer']; delete s2.unlocked.vault.agents[other].known_types;
    dropStorageCache();
    expect((await agentOf(other)).new_types).toEqual(['swap', 'bridge', 'refuel']);
    const n = mock.docs.length;
    await call({ cmd: 'agentNewTypes', id: other, allow: [] });
    expect(mock.docs.length).toBe(n);
    const o = await agentOf(other);
    expect(o.new_types).toEqual([]);
    expect(o.allowed_types).toEqual(['transfer']);
  });

  it('re-issue: agent.rotate, the token once, a one-line replace from the old `agent-wallet` connection', async () => {
    await call({ cmd: 'settings', patch: { mcp_launch: 'npx', mcp_launch_path: '' } });
    const got = mock.next((m) => m.type === 'agent.rotate');
    const r = await call({ cmd: 'agentRotate', id });
    expect((await got).agent_id).toBe(id);
    expect(r.token).toMatch(new RegExp(`^aw_${id}_R1`));
    expect(r.old_mcp_name).toBe('agent-wallet');
    expect(r.mcp_name).toBe('dontaskagain-buhgalter'); // the legacy agent gets its own name from its current name
    expect(r.claude).toContain('DAA_TOKEN=' + r.token);
    expect(claudeReplace(r.old_mcp_name, { name: r.mcp_name, url: mock.url, token: r.token, launch: { kind: 'npx' } }))
      .toBe(`claude mcp remove -s user agent-wallet && claude mcp add -s user dontaskagain-buhgalter -e DAA_URL=${mock.url} -e DAA_TOKEN=${r.token} -- ${npxDefaultCommand()}`);
    const a = await agentOf(id);
    expect(a.token_prefix).toBe(`aw_${id}_R1`);
    expect(JSON.stringify((fake.chrome.storage.local as any)._dump())).not.toContain(r.token);
    expect(JSON.stringify((fake.chrome.storage.session as any)._dump())).not.toContain(r.token);
    // a second re-issue keeps the agent's own name
    const r2 = await call({ cmd: 'agentRotate', id });
    expect(r2.old_mcp_name).toBe('dontaskagain-buhgalter');
    expect(r2.mcp_name).toBe('dontaskagain-buhgalter');
  });

  it('revoke → the name of the connection to remove on the agent side', async () => {
    const r = await call({ cmd: 'agentRevoke', id });
    expect(r).toEqual({ mcp_name: 'dontaskagain-buhgalter' });
    await tick();
    expect(lastDoc().agents[id]).toBeUndefined();
    await expect(call({ cmd: 'agentRotate', id })).rejects.toThrow(/UNKNOWN_AGENT/);
    await expect(call({ cmd: 'agentUpdate', id, patch: { name: 'x' } })).rejects.toThrow(/UNKNOWN_AGENT/);
  });

  it('without the Signer a change is refused before anything is saved', async () => {
    const live = (await call({ cmd: 'status' })).agents.find((x: any) => !x.revoked_at);
    await call({ cmd: 'disconnect' });
    await expect(call({ cmd: 'agentUpdate', id: live.id, patch: { name: 'offline' } })).rejects.toThrow(/NOT_CONNECTED/);
    expect((await agentOf(live.id)).name).toBe(live.name);
  });
});

// 0.2.2: own accounts are trusted recipients
import { ownEntries, recipientCheck } from '../src/lib/ownAccounts';
import { readdirSync, readFileSync } from 'node:fs';

describe('own accounts as recipients', () => {
  const seeds = [{ id: 'seed_a', name: 'Основная', mnemonic: '', created_at: '' }, { id: 'seed_b', name: 'Рабочая', mnemonic: '', created_at: '' }];
  const accounts: any[] = [
    { id: 'acc_1', name: 'main', origin: 'hd', seed_id: 'seed_a', addresses: { tron: A0.tron, evm: A0.evm } },
    { id: 'acc_2', name: 'work', origin: 'hd', seed_id: 'seed_b', addresses: { tron: A1.tron, evm: A1.evm } },
    { id: 'acc_3', name: 'cold', origin: 'imported', addresses: { tron: 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8', evm: '0x3214a91bCd29b8ce7D3C5E26bE1cEa3E8D57b67C' } },
    { id: 'acc_4', name: 'gone', origin: 'hd', seed_id: 'seed_a', removed_at: 'x', addresses: { tron: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf' } },
  ];
  it('every live account of every phrase and imported keys, grouped; exact match → own, no «first time»', () => {
    const own = ownEntries(accounts, { seeds }, 'tron');
    expect(own.map((o) => o.label)).toEqual(['main (Основная)', 'work (Рабочая)', 'cold (ключ)']);
    const r = recipientCheck({ network: 'tron', address: A1.tron, own, book: [], history: [], cfg: { prefix: 4, suffix: 4 }, firstTime: true });
    expect(r).toEqual({ own: { id: 'acc_2', name: 'work', group: 'Рабочая' }, similar: [], first_time: false });
    const e = recipientCheck({ network: 'evm:42161', address: A1.evm.toLowerCase(), own: ownEntries(accounts, { seeds }, 'evm:42161'), book: [], history: [], cfg: { prefix: 4, suffix: 4 }, firstTime: true });
    expect(e.own?.name).toBe('work');
  });
  it('an address that only looks like an own account is flagged (source own)', () => {
    const own = ownEntries(accounts, { seeds }, 'tron');
    const fake = A1.tron.slice(0, 5) + 'x'.repeat(A1.tron.length - 9) + A1.tron.slice(-4);
    const r = recipientCheck({ network: 'tron', address: fake, own, book: [], history: [], cfg: { prefix: 4, suffix: 4 }, firstTime: true });
    expect(r.own).toBeUndefined();
    expect(r.first_time).toBe(true);
    expect(r.similar[0]).toMatchObject({ source: 'own', label: 'work (Рабочая)', address: A1.tron });
  });
  it('the sign window of a send to an own account says «ваш аккаунт», no address tick needed', async () => {
    await call({ cmd: 'connect' }).catch(() => {});
    await tick(100);
    const st0 = await call({ cmd: 'status' });
    const main = st0.accounts[0], ops = st0.accounts[1];
    const v = await call({ cmd: 'ownPrepare', account_id: main.id, asset: 'TRX', to: ops.addresses.tron, amount: '1' });
    expect(v.to_check).toMatchObject({ own: { id: ops.id, name: 'ops', group: 'Основная' }, first_time: false });
    const chk = await call({ cmd: 'bookCheck', network: 'tron', address: ops.addresses.tron });
    expect(chk.own).toMatchObject({ name: 'ops' });
  });
  it('no screen says «Отправлено в Signer» after a submit (every own op opens the operation page)', () => {
    for (const f of readdirSync('src/ui/popup')) {
      const s = readFileSync(`src/ui/popup/${f}`, 'utf8');
      expect(s, f).not.toMatch(/(Отправлено|отправлен[аы]?|принята) Signer|в Signer\$\{r\.request_id/);
    }
  });
});
