// What to run on the agent's side (0.2.1): the wallet itself tells the human how to add, replace or remove
// the agent's MCP connection. One MCP server name per agent (`dontaskagain-<slug>`), so several agents on one machine
// do not collide; the launch command is the agent machine's (never a path of this server), the Signer URL — settings.
import type { McpLaunch } from './wallet/model';
import { t } from '../i18n';
import mcpCfg from '../config/mcp.json';

export const MCP_PREFIX = 'dontaskagain-';
/** The name ≤ 0.2.0 printed for every agent (an agent without `mcp_name` was connected under it). */
export const LEGACY_MCP_NAME = 'agent-wallet';

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o',
  п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/** «Claude Bot 2» → `claude-bot-2`, «Бухгалтер» → `buhgalter`; empty → ''. Lowercase a–z, 0–9 and single dashes, ≤ 32 chars. */
export function slugOf(name: string): string {
  const s = [...name.toLowerCase()].map((c) => TRANSLIT[c] ?? c).join('')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s.slice(0, 32).replace(/-+$/, '');
}

/**
 * A unique MCP server name for an agent: `dontaskagain-<slug>`; taken by another live agent of this wallet → `-2`, `-3`…
 * A name without letters/digits falls back to the agent id.
 */
export function mcpNameFor(agentName: string, agentId: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = MCP_PREFIX + (slugOf(agentName) || slugOf(agentId.replace(/^ag_/, '')) || 'agent');
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}-${i}`)) return `${base}-${i}`;
}

export interface LaunchChoice { kind: McpLaunch; path?: string }

export const LAUNCH_OPTIONS: { kind: McpLaunch; label: string; note: string; soon?: boolean; e2e?: boolean }[] = [
  { kind: 'npx', get label() { return t('conn.optNpx'); }, get note() { return t('conn.optNpxNote'); }, e2e: true },
  { kind: 'remote', get label() { return t('conn.optRemote'); }, get note() { return t('conn.optRemoteNote'); }, e2e: true },
];

/** The package with its exact version (config/mcp.json) and its bin. `npm_published: true` (0.3.11) →
 * `npx -y dontaskagain-mcp@<v>` from npm; the same version's archive on the site (`npx -y -p <url> dontaskagain-mcp`)
 * stays a fallback: the human's path/URL, or the default again with `npm_published: false`. */
export const NPX_PACKAGE: string = mcpCfg.npx_package;
export const NPX_BIN: string = mcpCfg.npx_bin;
export const NPX_URL: string = mcpCfg.npx_url;
export const NPM_PUBLISHED: boolean = mcpCfg.npm_published === true;
/** Where the agent's machine keeps the connection file (0700 dir, 0600 file; the package checks both). */
export const CONFIG_DIR: string = mcpCfg.config_dir;
/** Codex (0.3.8): first start may download the package (default 10 s is short); wallet_request_status waits up to 300 s
 * (default tool timeout 60 s would cut it). */
export const CODEX_STARTUP_TIMEOUT_SEC: number = mcpCfg.codex_startup_timeout_sec;
export const CODEX_TOOL_TIMEOUT_SEC: number = mcpCfg.codex_tool_timeout_sec;

/** The npx arguments of the package: the human's path/URL → the npm name (or the site archive while not on npm). */
export function npxArgs(path?: string, cfg: { published: boolean; url: string; pkg: string } = { published: NPM_PUBLISHED, url: NPX_URL, pkg: NPX_PACKAGE }): string[] {
  const p = (path ?? '').trim();
  if (p) return ['-y', '-p', p, NPX_BIN];
  return cfg.published ? ['-y', cfg.pkg] : ['-y', '-p', cfg.url, NPX_BIN];
}
/** The default npx command line (no override) — for texts like «compare with `… whoami`». */
export const npxDefaultCommand = (): string => ['npx', ...npxArgs()].map((w) => shq(w)).join(' ');

/** The MCP client on the agent's machine (0.3.8): the wizard prints commands for it; the choice is kept in the settings. */
export type McpClient = 'claude' | 'codex' | 'json';
export const MCP_CLIENTS: readonly McpClient[] = ['claude', 'codex', 'json'];
export const isMcpClient = (x: unknown): x is McpClient => typeof x === 'string' && (MCP_CLIENTS as readonly string[]).includes(x);

/** Shell word: as is when safe, else in single quotes. */
export function shq(w: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`;
}

/** The program and its arguments of a stdio launch on the agent's machine (remote MCP has none: callers handle it first). */
export function launchArgv(l: LaunchChoice): { command: string; args: string[] } {
  // an archive (path or URL) must be given as a package to install, then the bin is named: `npx -y -p <tgz> dontaskagain-mcp`
  return { command: 'npx', args: npxArgs(l.path) };
}

/** E2E: the wallet key pinned at the agent and the one-time pairing code — they pass through the human, never
 * through the Signer. */
export interface ConnectInput { name: string; url: string; token: string; launch: LaunchChoice; e2e?: { wallet: string; pair?: string; wallet_id?: string } }

// ---- npx (dontaskagain-mcp 0.1.1): the secrets go in a file, not on a command line ----
/** The connection file the wallet offers to download: `dontaskagain-<slug>.env` (KEY=VALUE lines). */
export const envFileName = (c: ConnectInput) => `${c.name}.env`;
export const envFilePath = (c: ConnectInput) => `${CONFIG_DIR}/${envFileName(c)}`;
const envPairs = (c: ConnectInput): [string, string][] => [['DAA_URL', c.url], ['DAA_TOKEN', c.token], ...(c.e2e ? [['DAA_WALLET', c.e2e.wallet] as [string, string]] : []),
  ...(c.e2e?.wallet_id ? [['DAA_WALLET_ID', c.e2e.wallet_id] as [string, string]] : []), ...(c.e2e?.pair ? [['DAA_PAIR', c.e2e.pair] as [string, string]] : [])];
export function envFile(c: ConnectInput): string { return envPairs(c).map(([k, v]) => `${k}=${v}`).join('\n') + '\n'; }
/** Put the downloaded file in place: folder 700, file 600 (the same for every client; the package checks both). */
export function npxFileSteps(c: ConnectInput): string {
  return [`mkdir -p -m 700 ${CONFIG_DIR}`, `mv ~/Downloads/${shq(envFileName(c))} ${CONFIG_DIR}/ && chmod 600 ${envFilePath(c)}`].join('\n');
}
/** Windows (PowerShell): the same file in %USERPROFILE%\\.dontaskagain (the package skips POSIX modes there). */
export function npxFileStepsWin(c: ConnectInput): string {
  const dir = '$HOME\\.dontaskagain';
  return [`New-Item -ItemType Directory -Force "${dir}" | Out-Null`, `Move-Item "$HOME\\Downloads\\${envFileName(c)}" "${dir}"`].join('\n');
}
/** Preferred (no secret in the process list or the shell history): put the downloaded file in place, add by DAA_CONFIG.
 * The path keeps `~/`: the package expands it itself (clients run no shell for the server). */
export function npxConfigSteps(c: ConnectInput, client: Exclude<McpClient, 'json'> = 'claude'): string {
  const path = envFilePath(c);
  const { command, args } = launchArgv(c.launch);
  const add = client === 'codex'
    ? ['codex', 'mcp', 'add', shq(c.name), '--env', `DAA_CONFIG=${path}`, '--', shq(command), ...args.map(shq)]
    : ['claude', 'mcp', 'add', '-s', 'user', shq(c.name), '-e', `DAA_CONFIG=${path}`, '--', shq(command), ...args.map(shq)];
  return [npxFileSteps(c), add.join(' ')].join('\n');
}
/** The fingerprint check on the agent's machine (a mandatory step of the wizard). */
export function npxWhoami(c: ConnectInput): string {
  const { command, args } = launchArgv(c.launch);
  return [`DAA_CONFIG=${envFilePath(c)}`, shq(command), ...args.map(shq), 'whoami'].join(' ');
}

const trimUrl = (u: string) => u.replace(/\/+$/, '');

/** The env of a stdio launch: npx → only DAA_CONFIG (the secrets stay in the file). */
function stdioEnv(c: ConnectInput): Record<string, string> {
  return { DAA_CONFIG: envFilePath(c) };
}

/** npx (E2E), fallback form: `claude mcp add -s user <name> -e DAA_URL -e DAA_TOKEN -e DAA_WALLET -e DAA_WALLET_ID -e DAA_PAIR -- npx -y dontaskagain-mcp@<v>`;
 * remote MCP: `claude mcp add -s user --transport http <name> <url>/mcp --header "Authorization: Bearer …"`. */
export function claudeAdd(c: ConnectInput): string {
  if (c.launch.kind === 'remote') {
    return ['claude', 'mcp', 'add', '-s', 'user', '--transport', 'http', shq(c.name), shq(`${trimUrl(c.url)}/mcp`), '--header', shq(`Authorization: Bearer ${c.token}`)].join(' ');
  }
  const { command, args } = launchArgv(c.launch);
  // npx, the fallback one-liner: the secrets are visible in the process list and the shell history (the wizard says so)
  const env = envPairs(c).map(([k, v]) => `${k}=${v}`);
  return ['claude', 'mcp', 'add', '-s', 'user', shq(c.name), ...env.flatMap((e) => ['-e', shq(e)]), '--', shq(command), ...args.map(shq)].join(' ');
}

export const claudeRemove = (name: string): string => `claude mcp remove -s user ${shq(name)}`;

/** Re-issued token: remove what is there (the old name — ≤ 0.2.0 agents were `agent-wallet`) and add under the new name. */
export const claudeReplace = (oldName: string, c: ConnectInput): string => `${claudeRemove(oldName)} && ${claudeAdd(c)}`;

/** The same for other MCP clients (Claude Desktop, Cursor…): the `mcpServers` block. */
export function mcpJson(c: ConnectInput): string {
  if (c.launch.kind === 'remote') return JSON.stringify({ mcpServers: { [c.name]: { type: 'http', url: `${trimUrl(c.url)}/mcp`, headers: { Authorization: `Bearer ${c.token}` } } } }, null, 2);
  const { command, args } = launchArgv(c.launch);
  // the package expands `~/` itself (JSON clients run no shell); the secrets stay in the file
  return JSON.stringify({ mcpServers: { [c.name]: { command, args, env: stdioEnv(c) } } }, null, 2);
}

// ---- Codex (0.3.8): ~/.codex/config.toml, shared by the Codex CLI and the IDE extension ----

/** TOML basic string: `"…"` with \\, \" and control characters escaped (lone surrogates → U+FFFD: TOML has no such escape). */
export function tomlStr(s: string): string {
  return '"' + s.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\ufffd').replace(/[\\"\u0000-\u001f\u007f]/g, (ch) => {
    const m: Record<string, string> = { '\\': '\\\\', '"': '\\"', '\b': '\\b', '\t': '\\t', '\n': '\\n', '\f': '\\f', '\r': '\\r' };
    return m[ch] ?? '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
  }) + '"';
}
/** TOML key: bare when A–Z a–z 0–9 _ -, else quoted. */
export const tomlKey = (k: string): string => (/^[A-Za-z0-9_-]+$/.test(k) ? k : tomlStr(k));
const tomlArr = (a: string[]) => `[${a.map(tomlStr).join(', ')}]`;
const tomlInline = (o: Record<string, string>) => `{ ${Object.entries(o).map(([k, v]) => `${tomlKey(k)} = ${tomlStr(v)}`).join(', ')} }`;


/** The `[mcp_servers.<name>]` table for ~/.codex/config.toml. One table (env inline), so it pastes as a block and can be
 * replaced whole. `win`: Codex builds that cannot start `npx` (a .cmd) directly get `cmd /c npx …`. */
export function codexToml(c: ConnectInput, opts: { win?: boolean } = {}): string {
  const head = `[mcp_servers.${tomlKey(c.name)}]`;
  const timeouts = [`startup_timeout_sec = ${CODEX_STARTUP_TIMEOUT_SEC}`, `tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SEC}`];
  if (c.launch.kind === 'remote') {
    return [head, `url = ${tomlStr(`${trimUrl(c.url)}/mcp`)}`, `http_headers = ${tomlInline({ Authorization: `Bearer ${c.token}` })}`, ...timeouts].join('\n') + '\n';
  }
  let { command, args } = launchArgv(c.launch);
  if (opts.win && command === 'npx') { args = ['/c', 'npx', ...args]; command = 'cmd'; }
  return [head, `command = ${tomlStr(command)}`, `args = ${tomlArr(args)}`, `env = ${tomlInline(stdioEnv(c))}`, ...timeouts].join('\n') + '\n';
}

/** `codex mcp add <name> --env K=V -- <command> <args>` (stdio only: remote goes through config.toml — the CLI has no
 * header option, and a bearer env var would have to live in Codex's own environment). No timeout options in the CLI:
 * the wizard says to add them to the table. */
export function codexAdd(c: ConnectInput, opts: { inline?: boolean } = {}): string | null {
  if (c.launch.kind === 'remote') return null;
  const { command, args } = launchArgv(c.launch);
  // the fallback one-liner (opts.inline): the secrets on the command line, the wizard warns as for Claude Code
  if (c.launch.kind === 'npx' && opts.inline) return ['codex', 'mcp', 'add', shq(c.name), ...envPairs(c).flatMap(([k, v]) => ['--env', shq(`${k}=${v}`)]), '--', shq(command), ...args.map(shq)].join(' ');
  return ['codex', 'mcp', 'add', shq(c.name), '--env', `DAA_CONFIG=${envFilePath(c)}`, '--', shq(command), ...args.map(shq)].join(' ');
}
export const codexRemove = (name: string): string => `codex mcp remove ${shq(name)}`;
export const codexReplace = (oldName: string, c: ConnectInput, opts: { inline?: boolean } = {}): string | null => { const a = codexAdd(c, opts); return a ? `${codexRemove(oldName)} && ${a}` : null; };
/** The check after adding: the server is listed (and `codex mcp get <name>` shows its launch). */
export const codexCheck = (name: string): string => `codex mcp list\ncodex mcp get ${shq(name)}`;
/** The timeout lines `codex mcp add` cannot set. */
export const codexTimeoutLines = (): string => `startup_timeout_sec = ${CODEX_STARTUP_TIMEOUT_SEC}\ntool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SEC}`;
