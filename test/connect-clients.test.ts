// 0.3.8 : the wizard connects the agent in Claude Code, Codex (command + ~/.codex/config.toml) or any other
// stdio client (JSON). Same rules for all three: the secrets stay in the 600 file, the command line carries only
// DAA_CONFIG (the fallback one-liner aside); the package source is npm (0.3.11; the site archive before), the field overrides it.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CODEX_TOOL_TIMEOUT_SEC, MCP_CLIENTS, claudeAdd, codexAdd, codexCheck, codexRemove, codexReplace, codexTimeoutLines, codexToml, isMcpClient,
  launchArgv, mcpJson, npxArgs, npxConfigSteps, npxDefaultCommand, npxFileSteps, npxFileStepsWin, npxWhoami, tomlKey, tomlStr, type ConnectInput,
} from '../src/lib/agentConnect';
import mcpCfg from '../src/config/mcp.json';

const URL_ = 'https://dontaskagain.xyz/dl/dontaskagain-mcp-0.1.4.tgz';
const PKG = 'dontaskagain-mcp@0.1.4';
const base: ConnectInput = { name: 'dontaskagain-bot', url: 'https://wallet.example/', token: 'aw_ag_1_TOKEN', launch: { kind: 'npx' },
  e2e: { wallet: 'SIG.KEX', wallet_id: 'wal_x', pair: 'PAIRCODE' } };

/** Parse TOML with Python's tomllib (3.11+) — an independent parser; null when python3/tomllib is missing. */
function parseToml(src: string): any {
  try {
    return JSON.parse(execFileSync('python3', ['-I', '-c', 'import sys,json,tomllib;print(json.dumps(tomllib.loads(sys.stdin.read())))'], { input: src, encoding: 'utf8' }));
  } catch (e: any) {
    if (e?.code === 'ENOENT' || /No module named 'tomllib'/.test(String(e?.stderr ?? ''))) return null;
    throw e;
  }
}

describe('package source (mcp.json)', () => {
  it('pinned version; from npm (0.3.11); the field (path or URL) overrides; the site archive stays a fallback', () => {
    expect(mcpCfg.npx_package).toMatch(/^dontaskagain-mcp@\d+\.\d+\.\d+$/);
    expect(mcpCfg.npx_package).toBe(PKG);
    expect(mcpCfg.npx_url).toBe(`https://dontaskagain.xyz/dl/dontaskagain-mcp-${mcpCfg.npx_package.split('@')[1]}.tgz`);
    expect(mcpCfg.npm_published).toBe(true);
    expect(npxArgs()).toEqual(['-y', PKG]);
    expect(npxArgs('  /opt/my pkgs/d.tgz ')).toEqual(['-y', '-p', '/opt/my pkgs/d.tgz', 'dontaskagain-mcp']);
    expect(npxArgs('https://mirror.example/d.tgz')).toEqual(['-y', '-p', 'https://mirror.example/d.tgz', 'dontaskagain-mcp']);
    expect(npxArgs(URL_)).toEqual(['-y', '-p', URL_, 'dontaskagain-mcp']); // the site archive by hand
    expect(npxArgs('', { published: false, url: URL_, pkg: PKG })).toEqual(['-y', '-p', URL_, 'dontaskagain-mcp']);
    expect(npxArgs('/x.tgz', { published: true, url: URL_, pkg: PKG })).toEqual(['-y', '-p', '/x.tgz', 'dontaskagain-mcp']);
    expect(npxDefaultCommand()).toBe(`npx -y ${PKG}`);
    expect(launchArgv({ kind: 'npx', path: '' })).toEqual({ command: 'npx', args: ['-y', PKG] });
    expect(launchArgv({ kind: 'npx', path: URL_ })).toEqual({ command: 'npx', args: ['-y', '-p', URL_, 'dontaskagain-mcp'] });
  });
  it('clients', () => {
    expect(MCP_CLIENTS).toEqual(['claude', 'codex', 'json']);
    expect(isMcpClient('codex')).toBe(true);
    expect(isMcpClient('cursor')).toBe(false);
  });
});

describe('npx (E2E): the three clients', () => {
  it('Claude Code: file steps + claude mcp add by DAA_CONFIG, no secret', () => {
    const s = npxConfigSteps(base, 'claude');
    expect(s).toBe(`${npxFileSteps(base)}\nclaude mcp add -s user dontaskagain-bot -e DAA_CONFIG=~/.dontaskagain/dontaskagain-bot.env -- npx -y ${PKG}`);
    for (const secret of ['aw_ag_1_TOKEN', 'PAIRCODE', 'SIG.KEX']) expect(s).not.toContain(secret);
  });

  it('Codex: command, config.toml with timeouts, list/get check; no secret', () => {
    expect(codexAdd(base)).toBe(`codex mcp add dontaskagain-bot --env DAA_CONFIG=~/.dontaskagain/dontaskagain-bot.env -- npx -y ${PKG}`);
    expect(npxConfigSteps(base, 'codex')).toBe(`${npxFileSteps(base)}\n${codexAdd(base)}`);
    const toml = codexToml(base);
    expect(toml).toBe('[mcp_servers.dontaskagain-bot]\n'
      + 'command = "npx"\n'
      + `args = ["-y", "${PKG}"]\n`
      + 'env = { DAA_CONFIG = "~/.dontaskagain/dontaskagain-bot.env" }\n'
      + 'startup_timeout_sec = 60\n'
      + 'tool_timeout_sec = 330\n');
    for (const secret of ['aw_ag_1_TOKEN', 'PAIRCODE', 'SIG.KEX']) { expect(toml).not.toContain(secret); expect(codexAdd(base)).not.toContain(secret); }
    expect(CODEX_TOOL_TIMEOUT_SEC).toBeGreaterThan(300); // wallet_request_status waits up to 300 s
    expect(codexTimeoutLines()).toBe('startup_timeout_sec = 60\ntool_timeout_sec = 330');
    expect(codexCheck('dontaskagain-bot')).toBe('codex mcp list\ncodex mcp get dontaskagain-bot');
    expect(codexRemove('dontaskagain-bot')).toBe('codex mcp remove dontaskagain-bot');
    expect(codexReplace('agent-wallet', base)).toBe(`codex mcp remove agent-wallet && ${codexAdd(base)}`);
    const parsed = parseToml(toml);
    if (parsed) expect(parsed).toEqual({ mcp_servers: { 'dontaskagain-bot': { command: 'npx', args: ['-y', PKG], env: { DAA_CONFIG: '~/.dontaskagain/dontaskagain-bot.env' }, startup_timeout_sec: 60, tool_timeout_sec: 330 } } });
  });

  it('Codex fallback one-liner carries the secrets (warned in the wizard), quoted', () => {
    const f = codexAdd(base, { inline: true })!;
    expect(f).toBe(`codex mcp add dontaskagain-bot --env DAA_URL=https://wallet.example/ --env DAA_TOKEN=aw_ag_1_TOKEN --env DAA_WALLET=SIG.KEX --env DAA_WALLET_ID=wal_x --env DAA_PAIR=PAIRCODE -- npx -y ${PKG}`);
    expect(codexAdd({ ...base, token: "a b'c" }, { inline: true })).toContain(`--env 'DAA_TOKEN=a b'\\''c'`);
  });

  it('JSON: mcpServers stdio block by DAA_CONFIG; file steps without a client command', () => {
    expect(JSON.parse(mcpJson(base))).toEqual({ mcpServers: { 'dontaskagain-bot': { command: 'npx', args: ['-y', PKG], env: { DAA_CONFIG: '~/.dontaskagain/dontaskagain-bot.env' } } } });
    expect(npxFileSteps(base)).toBe('mkdir -p -m 700 ~/.dontaskagain\nmv ~/Downloads/dontaskagain-bot.env ~/.dontaskagain/ && chmod 600 ~/.dontaskagain/dontaskagain-bot.env');
    expect(mcpJson(base)).not.toContain('aw_ag_1_TOKEN');
  });

  it('paths with spaces and quotes: shell-quoted in commands, escaped in TOML and JSON', () => {
    const c = { ...base, launch: { kind: 'npx' as const, path: `/home/me/My "pkgs"/d's.tgz` } };
    expect(codexAdd(c)).toBe(`codex mcp add dontaskagain-bot --env DAA_CONFIG=~/.dontaskagain/dontaskagain-bot.env -- npx -y -p '/home/me/My "pkgs"/d'\\''s.tgz' dontaskagain-mcp`);
    expect(npxWhoami(c)).toBe(`DAA_CONFIG=~/.dontaskagain/dontaskagain-bot.env npx -y -p '/home/me/My "pkgs"/d'\\''s.tgz' dontaskagain-mcp whoami`);
    const toml = codexToml(c);
    expect(toml).toContain(`args = ["-y", "-p", "/home/me/My \\"pkgs\\"/d's.tgz", "dontaskagain-mcp"]`);
    const p = parseToml(toml);
    if (p) expect(p.mcp_servers['dontaskagain-bot'].args[2]).toBe(`/home/me/My "pkgs"/d's.tgz`);
    expect(JSON.parse(mcpJson(c)).mcpServers['dontaskagain-bot'].args[2]).toBe(`/home/me/My "pkgs"/d's.tgz`);
  });

  it('Windows: PowerShell file steps; cmd /c npx variant; backslash paths escaped in TOML', () => {
    expect(npxFileStepsWin(base)).toBe('New-Item -ItemType Directory -Force "$HOME\\.dontaskagain" | Out-Null\nMove-Item "$HOME\\Downloads\\dontaskagain-bot.env" "$HOME\\.dontaskagain"');
    const w = codexToml({ ...base, launch: { kind: 'npx', path: 'C:\\Users\\Me\\Downloads\\dontaskagain-mcp-0.1.4.tgz' } }, { win: true });
    expect(w).toContain('command = "cmd"');
    expect(w).toContain('args = ["/c", "npx", "-y", "-p", "C:\\\\Users\\\\Me\\\\Downloads\\\\dontaskagain-mcp-0.1.4.tgz", "dontaskagain-mcp"]');
    const p = parseToml(w);
    if (p) expect(p.mcp_servers['dontaskagain-bot'].args).toEqual(['/c', 'npx', '-y', '-p', 'C:\\Users\\Me\\Downloads\\dontaskagain-mcp-0.1.4.tgz', 'dontaskagain-mcp']);
  });
});

describe('remote MCP and the old way in Codex', () => {
  it('remote: config.toml only (url + Authorization header), no command', () => {
    const r = { ...base, launch: { kind: 'remote' as const }, e2e: { wallet: 'SIG.KEX' } };
    expect(codexAdd(r)).toBeNull();
    expect(codexReplace('x', r)).toBeNull();
    const toml = codexToml(r);
    expect(toml).toBe('[mcp_servers.dontaskagain-bot]\nurl = "https://wallet.example/mcp"\nhttp_headers = { Authorization = "Bearer aw_ag_1_TOKEN" }\nstartup_timeout_sec = 60\ntool_timeout_sec = 330\n');
    const p = parseToml(toml);
    if (p) expect(p.mcp_servers['dontaskagain-bot'].http_headers).toEqual({ Authorization: 'Bearer aw_ag_1_TOKEN' });
    expect(claudeAdd(r)).toContain('--transport http'); // Claude Code unchanged
  });
});

describe('TOML encoding', () => {
  it('strings and keys', () => {
    expect(tomlStr('a"b\\c\n\t\u0001')).toBe('"a\\"b\\\\c\\n\\t\\u0001"');
    expect(tomlStr('\ud800x')).toBe('"\ufffdx"');
    expect(tomlKey('dontaskagain-claude-bot-2')).toBe('dontaskagain-claude-bot-2');
    expect(tomlKey('a.b')).toBe('"a.b"');
    const odd = { ...base, name: 'odd name.x' };
    const p = parseToml(codexToml(odd));
    if (p) expect(Object.keys(p.mcp_servers)).toEqual(['odd name.x']);
  });
});

describe('UI wiring', () => {
  it('the wizard offers the three clients and keeps the choice in the settings', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'ui', 'popup', 'AgentConnect.tsx'), 'utf8');
    expect(src).toContain("patch: { mcp_client: k }");
    expect(src).toContain('MCP_CLIENTS.map');
    const bg = readFileSync(join(__dirname, '..', 'src', 'background', 'index.ts'), 'utf8');
    expect(bg).toContain("['claude', 'codex', 'json'].includes(p.mcp_client)");
  });
});
