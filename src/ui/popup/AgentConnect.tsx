// «Connection on the agent side» (0.2.1): the wallet tells the human what to run where the agent lives —
// add (new agent), replace in one line (re-issued token), remove (revoked).
// 0.3.8 : for the chosen MCP client — Claude Code, Codex (command + ~/.codex/config.toml) or any other
// stdio client (JSON mcpServers); the same safety rules for all: the secrets in a 600 file in ~/.dontaskagain, never on
// a command line (except the warned fallback). The launch and the client are kept in the extension settings.
import { useState } from 'react';
import type { AgentConnectView, StatusView } from '../../shared/api';
import { LAUNCH_OPTIONS, MCP_CLIENTS, claudeAdd, claudeRemove, claudeReplace, codexAdd, codexCheck, codexRemove, codexReplace, codexTimeoutLines, codexToml, envFile, envFileName, isMcpClient, mcpJson, npxConfigSteps, npxDefaultCommand, npxFileSteps, npxFileStepsWin, npxWhoami, type ConnectInput, type LaunchChoice, type McpClient } from '../../lib/agentConnect';
import { Copy, Err, api, useAsync } from '../common/ui';
import { DEFAULT_LAUNCH, isMcpLaunch } from '../../lib/wallet/model';
import { fmtDateTime, t } from '../../i18n';
import { Mascot } from '../common/Mascot';
import { I } from '../common/icons';

export type ConnectMode = 'new' | 'rotate' | 'revoked' | 'current';

const clientLabel = (k: McpClient) => (k === 'claude' ? 'Claude Code' : k === 'codex' ? 'Codex' : t('conn.clientJson'));

export function AgentConnect({ st, mode, mcpName, oldMcpName, token, made, agentId }: { st: StatusView; mode: ConnectMode; mcpName: string; oldMcpName?: string | null; token?: string; made?: AgentConnectView | null; agentId?: string }) {
  // 0.3.0: an E2E agent was created for one way (npx: key at the agent + pairing code; remote: key at the server) —
  // the way is fixed; npx may point to an archive path or URL (`npx -y -p <tgz> dontaskagain-mcp`)
  const fixed = made?.e2e && (made.launch === 'npx' || made.launch === 'remote') ? (made.launch as 'npx' | 'remote') : null;
  const [launch, setLaunch] = useState<LaunchChoice>(fixed ? { kind: fixed, path: fixed === 'npx' && st.settings.mcp_launch === 'npx' ? st.settings.mcp_launch_path ?? '' : '' } : { kind: isMcpLaunch(st.settings.mcp_launch) ? st.settings.mcp_launch : DEFAULT_LAUNCH, path: st.settings.mcp_launch_path ?? '' });
  const [client, setClient] = useState<McpClient>(isMcpClient(st.settings.mcp_client) ? st.settings.mcp_client : 'claude');
  const save = (l: LaunchChoice) => { setLaunch(l); void api({ cmd: 'settings', patch: { mcp_launch: l.kind, mcp_launch_path: l.path ?? '' } }).catch(() => {}); };
  const pick = (k: McpClient) => { setClient(k); void api({ cmd: 'settings', patch: { mcp_client: k } }).catch(() => {}); };
  const url = st.settings.signer_url;
  const e2e = fixed && made?.e2e ? { wallet: made.e2e.wallet_key, ...(made.e2e.wallet_id ? { wallet_id: made.e2e.wallet_id } : {}), ...(made.e2e.pair ? { pair: made.e2e.pair } : {}) } : undefined;
  const c = token ? { name: mcpName, url, token, launch, e2e } : null;
  const plainWay = false; // an agent connects only with its own key: npx (dontaskagain-mcp) or remote MCP
  const options = LAUNCH_OPTIONS.filter((o) => (fixed ? o.kind === fixed : !o.e2e));
  const live = agentId ? st.agents.find((a) => a.id === agentId) : undefined;
  const oldName = mode === 'rotate' ? oldMcpName || mcpName : null;
  return (
    <div className="card">
      {mode === 'new' ? <h2 className="with-mascot"><Mascot state="connected" size={48} />{t('conn.title')}</h2> : <h2>{t('conn.title')}</h2>}
      <div className="small">{t('conn.mcpName')} <span className="mono" style={{ fontWeight: 700 }}>{mcpName}</span></div>

      <div className="field" style={{ marginTop: 10 }}><span>{t('conn.client')}</span>
        <div className="col" style={{ gap: 4 }}>
          {MCP_CLIENTS.map((k) => <label key={k} className="check"><input type="radio" name="mcp-client" checked={client === k} onChange={() => pick(k)} />
            <span><span style={{ fontWeight: 700 }}>{clientLabel(k)}</span><br /><span className="small muted">{k === 'claude' ? t('conn.clientClaudeNote') : k === 'codex' ? t('conn.clientCodexNote') : t('conn.clientJsonNote')}</span></span></label>)}
        </div>
      </div>

      {mode === 'revoked' && <>
        <div className="plate warn small">{t('conn.revoked')}</div>
        <Remove client={client} name={mcpName} label={clientLabel(client)} />
      </>}

      {mode === 'current' && <>
        <p className="small muted">{t('conn.current')}</p>
        <Remove client={client} name={mcpName} label={t('conn.removeIn', { client: clientLabel(client) })} />
      </>}

      {c && !fixed && !plainWay && <div className="plate warn small">{t('conn.needKey')}</div>}

      {c && (fixed || plainWay) && <>
        <div className="field" style={{ marginTop: 10 }}><span>{t('conn.launch')}</span>
          <div className="col" style={{ gap: 4 }}>
            {options.map((o) => <label key={o.kind} className="check"><input type="radio" name="launch" checked={launch.kind === o.kind} onChange={() => save({ ...launch, kind: o.kind })} />
              <span><span style={{ fontWeight: 700 }}>{o.label}</span>{o.soon && <span className="badge warn" style={{ marginLeft: 6 }}>{t('agset.soon')}</span>}<br /><span className="small muted">{o.note}</span></span></label>)}
          </div>
          {launch.kind === 'npx' && <>
            <input className="mono" style={{ marginTop: 6 }} placeholder={t('conn.npxPathPh')} value={launch.path ?? ''} onChange={(e) => save({ ...launch, path: e.target.value })} />
            <span className="small subtle" style={{ textTransform: 'none', letterSpacing: 0 }}>{t('conn.npxSource')} <span className="mono">{npxDefaultCommand()}</span></span>
          </>}
        </div>
        {fixed === 'npx' ? <NpxSteps c={c} client={client} oldName={oldName} /> : <PlainSteps c={c} client={client} mode={mode} oldMcpName={oldMcpName ?? null} />}
        <p className="small muted">{t('conn.url1')} <span className="mono">{url}</span>. {t('conn.url2')}</p>
        {fixed === 'npx' && made?.e2e && <div className="plate info small">{t('conn.npxE2e1')} <b>DAA_WALLET</b> {t('conn.npxE2e2')} <span className="mono">{made.e2e.wallet_fp}</span>), <b>DAA_PAIR</b> {t('conn.npxE2e3')}{made.e2e.pair_expires_at ? ` ${t('conn.until', { at: fmtDateTime(made.e2e.pair_expires_at) })}` : ''}. {t('conn.npxE2e4')}</div>}
        {fixed === 'remote' && <div className="plate warn small"><b>{t('conn.remoteTitle')}</b> {t('conn.remoteWarn')}</div>}
      </>}

      {live && fixed === 'npx' && <PairState a={live} />}

      <div className="plate info small">{t('conn.tokenOnlyRequests')}</div>
    </div>
  );
}

function Remove({ client, name, label }: { client: McpClient; name: string; label: string }) {
  if (client === 'json') return <p className="small muted">{t('conn.otherRemove1')} <span className="mono">"{name}"</span> {t('conn.otherRemove2')} <span className="mono">mcpServers</span>.</p>;
  if (client === 'codex') return <><Cmd label={label} text={codexRemove(name)} />
    <p className="small muted">{t('conn.codexRemoveNote1')} <span className="mono">[mcp_servers.{name}]</span> {t('conn.codexRemoveNote2')}</p></>;
  return <Cmd label={label} text={claudeRemove(name)} />;
}

/** Remote MCP: the commands of the chosen client. */
function PlainSteps({ c, client, mode, oldMcpName }: { c: ConnectInput; client: McpClient; mode: ConnectMode; oldMcpName: string | null }) {
  const oldName = oldMcpName || c.name;
  if (client === 'json') return <Cmd label={t('conn.jsonBlock')} text={mcpJson(c)} />;
  if (client === 'codex') {
    const add = codexAdd(c);
    return <>
      {mode === 'rotate' && <Cmd label={t('conn.npxRemoveOld')} text={codexRemove(oldName)} />}
      <Cmd label={t('conn.codexToml')} text={codexToml(c)} />
      {c.launch.kind === 'remote' && <div className="plate warn small">{t('conn.codexRemoteToken')}</div>}
      {add && <details className="small" style={{ marginTop: 8 }}><summary>{t('conn.codexOrCmd')}</summary>
        <Cmd label="Codex" text={add} />
        <p className="small muted">{t('conn.codexTimeouts', { name: c.name })}</p><div className="token" style={{ whiteSpace: 'pre-wrap' }}>{codexTimeoutLines()}</div></details>}
      <Cmd label={t('conn.codexCheck')} text={codexCheck(c.name)} />
    </>;
  }
  if (mode === 'rotate') return <>
    <Cmd label={t('conn.replaceCc')} text={claudeReplace(oldName, c)} />
    {oldMcpName && oldMcpName !== c.name && <p className="small muted">{t('conn.oldName1')} <span className="mono">{oldMcpName}</span> {t('conn.oldName2')}</p>}
    <details className="small"><summary>{t('conn.notYetHere')}</summary><Cmd label={t('conn.addOnly')} text={claudeAdd(c)} /></details>
  </>;
  return <Cmd label="Claude Code" text={claudeAdd(c)} />;
}

/** Pairing: waiting for the agent's first start → its key fingerprint, «Matches» / «Does not match». */
export function PairState({ a }: { a: StatusView['agents'][number] }) {
  const { busy, err, run } = useAsync();
  if (!a.e2e) return <div className="plate info small" style={{ marginTop: 8 }}>{t('pair.waiting')} {a.pairing ? t('pair.codeUntil', { at: fmtDateTime(a.pairing.expires_at) }) : t('pair.noCode')}</div>;
  return <div className="plate ok small" style={{ marginTop: 8 }}>
    <div>{t('pair.connected', { via: a.e2e.via === 'code' ? t('pair.viaCode') : a.e2e.via === 'manual' ? t('pair.viaManual') : t('pair.viaServer') })}</div>
    <div className="mono" style={{ fontWeight: 800, fontSize: 15, margin: '4px 0' }}>{a.e2e.fp}</div>
    {a.e2e.mode === 'agent' && !a.e2e.confirmed && <>
      <div>{t('pair.compare1')} <span className="mono">{npxDefaultCommand()} whoami</span> {t('pair.compare2')} <span className="mono">wallet_status → e2e.agent_fp</span>).</div>
      <div className="row" style={{ marginTop: 6 }}>
        <button className="btn sm primary" disabled={busy} onClick={() => void run(() => api({ cmd: 'agentConfirmFp', id: a.id, ok: true }))}>{t('pair.match')}</button>
        <button className="btn sm" disabled={busy} onClick={() => void run(() => api({ cmd: 'agentConfirmFp', id: a.id, ok: false }))}>{t('pair.noMatch')}</button>
      </div>
    </>}
    {a.e2e.confirmed && a.e2e.mode === 'agent' && <div>✓ {t('pair.confirmed')}</div>}
    <Err msg={err} />
  </div>;
}

/** dontaskagain-mcp: the secrets in a downloaded file (0600 in a 0700 folder), the MCP added by DAA_CONFIG for the chosen
 * client, the fingerprint check by `whoami` (mandatory); the one-line form only as a fallback, with its warning. */
function NpxSteps({ c, client, oldName }: { c: ConnectInput; client: McpClient; oldName: string | null }) {
  const download = () => {
    const url = URL.createObjectURL(new Blob([envFile(c)], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url; a.download = envFileName(c);
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  return <>
    <div className="small" style={{ fontWeight: 800, marginTop: 8 }}>{t('conn.npxStep1')}</div>
    <div className="row" style={{ marginTop: 4 }}><button className="btn sm primary" onClick={download}><I.download size={16} />{t('conn.npxDownload', { file: envFileName(c) })}</button></div>
    <p className="small muted">{t('conn.npxFileNote')}</p>
    {oldName && client !== 'json' && <Remove client={client} name={oldName} label={t('conn.npxRemoveOld')} />}
    {client === 'claude' && <Cmd label={t('conn.npxStep2')} text={npxConfigSteps(c, 'claude')} />}
    {client === 'codex' && <>
      <Cmd label={t('conn.npxStep2File')} text={npxFileSteps(c)} />
      <Cmd label={t('conn.codexToml')} text={codexToml(c)} />
      <details className="small" style={{ marginTop: 8 }}><summary>{t('conn.codexOrCmd')}</summary>
        <Cmd label="Codex" text={codexAdd(c) ?? ''} />
        <p className="small muted">{t('conn.codexTimeouts', { name: c.name })}</p><div className="token" style={{ whiteSpace: 'pre-wrap' }}>{codexTimeoutLines()}</div></details>
      <details className="small" style={{ marginTop: 8 }}><summary>{t('conn.codexWin')}</summary>
        <p className="small muted">{t('conn.codexWinNote')}</p>
        <Cmd label="PowerShell" text={npxFileStepsWin(c)} />
        <Cmd label={t('conn.codexToml')} text={codexToml(c, { win: true })} />
      </details>
    </>}
    {client === 'json' && <>
      <Cmd label={t('conn.npxStep2File')} text={npxFileSteps(c)} />
      <Cmd label={t('conn.jsonBlock')} text={mcpJson(c)} />
    </>}
    <Cmd label={t('conn.npxStep3')} text={npxWhoami(c)} />
    {client === 'codex' && <Cmd label={t('conn.codexCheck')} text={codexCheck(c.name)} />}
    {client !== 'json' && <details className="small" style={{ marginTop: 8 }}><summary>{t('conn.npxFallback')}</summary>
      <div className="plate warn small">{t('conn.npxFallbackWarn')}</div>
      {client === 'codex'
        ? <Cmd label="Codex" text={(oldName ? codexReplace(oldName, c, { inline: true }) : codexAdd(c, { inline: true })) ?? ''} />
        : <Cmd label="Claude Code" text={oldName ? claudeReplace(oldName, c) : claudeAdd(c)} />}
    </details>}
  </>;
}

function Cmd({ label, text }: { label: string; text: string }) {
  return <div style={{ marginTop: 8 }}>
    <div className="small" style={{ fontWeight: 800, marginBottom: 4 }}>{label}</div>
    <div className="token" style={{ whiteSpace: 'pre-wrap' }}>{text}</div>
    <div className="row" style={{ marginTop: 6 }}><Copy text={text} label={t('conn.copy')} small /></div>
  </div>;
}
