// Settings: Signer, language + view (side panel), address book link, Telegram, security, debug.
import { useEffect, useState } from 'react';
import { I } from '../common/icons';
import { Addr, Err, LangSelect, ThemeSelect, api, lockNow, useAsync, useAutolockMinutes } from '../common/ui';
import { t } from '../../i18n';
import { Mascot } from '../common/Mascot';
import E2E_DEFAULTS from '../../config/e2e.json';
import { servedNets } from '../../lib/evm/networks';
import type { ScreenProps } from './screen';
import { MODE } from './screen';
import { insecureUrl } from '../../lib/urlPolicy';
import { pwErrorText, pwProblemText } from '../common/pw';
import { normalizeInvite, parseSignerInput } from '../../lib/signer/invite';

export function Settings({ st, nav, reload }: ScreenProps) {
  const [url, setUrl] = useState(st.settings.signer_url);
  // the invite code lives in this field only — sent with the sign-in, never stored
  const [invite, setInvite] = useState('');
  const [linkNote, setLinkNote] = useState(false);
  const [lock, setLock] = useState(String(st.settings.autolock_min));
  const [tg, setTg] = useState<any>(null);
  const { busy, err, setErr, run } = useAsync();
  const left = useAutolockMinutes(st);
  useEffect(() => { setUrl(st.settings.signer_url); }, [st.settings.signer_url]);
  useEffect(() => { if (st.signer.connected) { setInvite(''); setLinkNote(false); } }, [st.signer.connected]);
  const isPublic = st.settings.signer_mode === 'public';
  /** A pasted Signer link `https://host/#invite=<code>`: the address goes to the address field, the code to the invite field. */
  const pasteLink = (v: string): boolean => {
    const p = /#invite=/i.test(v) ? parseSignerInput(v) : null;
    if (!p?.invite || !p.url) return false;
    if (isPublic && p.url !== new URL(st.settings.signer_url).origin) throw new Error(t('settings.inviteOtherSigner', { origin: p.url }));
    if (!isPublic) setUrl(p.url);
    setInvite(p.invite); setLinkNote(true);
    return true;
  };
  const saveUrl = async (u: string) => {
    // a Signer outside localhost (WG address) needs a host permission — asked here, on the click
    const origin = new URL(u).origin;
    if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin) && !(await chrome.permissions.request({ origins: [origin + '/*'] }))) throw new Error(t('settings.noPermission', { origin }));
    await api({ cmd: 'settings', patch: { signer_url: u } });
  };
  const showInvite = !st.signer.connected && (st.signer.invite_required || invite !== '');
  return (
    <div className="screen">
      <div className="card">
        <h2>Signer</h2>
        <div className="row"><span className={`dot ${st.signer.connected ? 'on' : ''}`} /><b>{st.signer.connected ? t('settings.connected') : st.signer.signed_in ? t('settings.signedNoWs') : t('settings.notSignedIn')}</b></div>
        {st.signer.wallet_id && <div className="small muted mono" style={{ marginTop: 4 }}>{st.signer.wallet_id} · {t('settings.docVersion', { v: st.doc_version })}</div>}
        {st.signer.registering && <div className="plate info small" role="status">{t('settings.registering', { pct: Math.min(99, Math.round((100 * st.signer.registering.tried) / st.signer.registering.expected)) })}</div>}
        {st.signer.error && !st.signer.connected && <div className="small subtle with-mascot"><Mascot state="network-error" size={40} /><span>{st.signer.error}</span></div>}
        {insecureUrl(st.settings.signer_url) && <div className="plate bad small" role="alert">{t('settings.insecureSigner')}</div>}
        {st.signer.server_networks_diff.map((d, i) => <div key={i} className="plate warn small">{t('settings.netDiff', { d })}</div>)}
        <div className="field" style={{ marginTop: 10 }}><span>{t('settings.whichSigner')}</span>
          <div className="col" style={{ gap: 4 }}>
            <label className="check"><input type="radio" name="smode" checked={st.settings.signer_mode === 'public'} onChange={() => void run(async () => {
              const origin = new URL(st.e2e?.public_signer_url ?? '').origin;
              if (!(await chrome.permissions.request({ origins: [origin + '/*'] }))) throw new Error(t('settings.noPermission', { origin }));
              await api({ cmd: 'signerMode', mode: 'public' });
            })} /><span><b>{t('settings.publicSigner')}</b> <span className="small muted">{t('settings.publicSignerNote')}</span>
              {st.e2e?.public_placeholder && <div className="small subtle">{t('settings.publicPlaceholder', { url: st.e2e?.public_signer_url })}</div>}</span></label>
            <label className="check"><input type="radio" name="smode" checked={st.settings.signer_mode !== 'public'} onChange={() => void run(() => api({ cmd: 'signerMode', mode: 'own' }))} /><span><b>{t('settings.ownSigner')}</b> <span className="small muted">{t('settings.ownSignerNote')}</span></span></label>
          </div></div>
        {st.settings.signer_mode !== 'public' && <label className="field" style={{ marginTop: 10 }}><span>{t('settings.signerUrl')}</span><input className="mono" value={url} onChange={(e) => { const v = e.target.value; try { if (!pasteLink(v)) setUrl(v); } catch { setUrl(v); } }} /></label>}
        {linkNote && <div className="small subtle">{t('settings.linkSplit')}</div>}
        {showInvite && <label className="field" style={{ marginTop: 10 }}><span>{t('settings.inviteCode')}</span>
          <input className="mono" value={invite} autoComplete="off" spellCheck={false} placeholder="daa-inv-…" onChange={(e) => { const v = e.target.value; setErr(''); try { if (!pasteLink(v)) setInvite(v.slice(0, 200)); } catch (x) { setErr((x as Error).message); } }} />
          <span className="small muted">{t('settings.inviteHint')}</span></label>}
        {st.signer.registration_closed && !st.signer.connected && <div className="plate warn small" role="alert">{t('settings.registrationClosed')}</div>}
        {st.signer.blocked && !st.signer.connected && <div className="plate bad small" role="alert">{t('settings.walletBlocked')}</div>}
        <div className="row wrap">
          {st.settings.signer_mode !== 'public' && <button className="btn" disabled={busy || url === st.settings.signer_url} onClick={() => void run(() => saveUrl(url))}>{t('settings.saveUrl')}</button>}
          {st.signer.connected ? <button className="btn" disabled={busy} onClick={() => void run(() => api({ cmd: 'disconnect' }))}>{t('settings.disconnect')}</button>
            : <button className="btn primary" disabled={busy} onClick={() => void run(async () => {
              const code = invite.trim() ? normalizeInvite(invite) : null;
              if (invite.trim() && !code) throw new Error(t('settings.inviteBad'));
              // a link pasted into the address: the Signer address is saved first (the code is not saved anywhere)
              if (!isPublic && url !== st.settings.signer_url) await saveUrl(url);
              await api({ cmd: 'connect', ...(code ? { invite: code } : {}) });
            })}>{t('settings.signIn')}</button>}
        </div>
        <p className="small muted">{t('settings.signInHint')}</p>
      </div>

      <E2ECard st={st} />

      <div className="card">
        <h2>{t('settings.view')}</h2>
        <LangSelect />
        <ThemeSelect />
        <label className="switch"><span><b>{t('settings.alwaysPanel')}</b><div className="small muted">{t('settings.alwaysPanelHint')}</div></span>
          <input type="checkbox" checked={st.settings.open_in_side_panel} onChange={(e) => void run(() => api({ cmd: 'settings', patch: { open_in_side_panel: e.target.checked } }))} /></label>
        {MODE === 'popup' && chrome.sidePanel && <button className="btn" onClick={() => void (async () => { const w = await chrome.windows.getCurrent(); await chrome.sidePanel.open({ windowId: w.id! }); window.close(); })()}><I.panel size={14} /> {t('settings.openPanel')}</button>}
      </div>

      <div className="card">
        <div className="row between"><h2 style={{ margin: 0 }}>{t('title.seeds')}</h2><button className="btn sm" onClick={() => nav('/seeds')}><I.seed size={13} /> {t('common.open')}</button></div>
        <p className="small muted">{st.seeds.length ? st.seeds.map((x) => `${x.name} (${x.accounts})`).join(' · ') : t('settings.noSeeds')}. {t('settings.seedsHint')}</p>
      </div>

      <div className="card">
        <div className="row between"><h2 style={{ margin: 0 }}>{t('title.book')}</h2><button className="btn sm" onClick={() => nav('/book')}><I.book size={13} /> {t('common.open')}</button></div>
        <p className="small muted">{st.book.length ? t('settings.bookCount', { n: st.book.length }) : t('common.empty')} · {t('settings.bookHint')}</p>
      </div>

      <div className="card">
        <h2 className="with-mascot"><I.telegram size={18} />Telegram</h2>
        <p className="small muted">{t('settings.tgHint')}</p>
        <div className="row"><button className="btn" disabled={busy || !st.signer.connected} onClick={() => void run(async () => setTg(await api({ cmd: 'tgLink' })))}>{t('settings.tgLink')}</button>
          <button className="btn" disabled={busy || !st.signer.connected} onClick={() => void run(async () => { await api({ cmd: 'tgUnlink' }); setTg(null); })}>{t('settings.tgUnlink')}</button></div>
        {tg && <div className="token" style={{ marginTop: 8 }}>{tg.url ?? tg.link ?? tg.code ?? JSON.stringify(tg)}</div>}
      </div>

      <div className="card">
        <h2>{t('settings.security')}</h2>
        <label className="field"><span>{t('settings.autolock')}</span><input type="number" min={5} max={240} value={lock} onChange={(e) => setLock(e.target.value)} /></label>
        {left !== null && <div className="plate info small autolock-left">{t('settings.autolockLeft', { n: left })}</div>}
        <div className="row"><button className="btn" disabled={busy || Number(lock) === st.settings.autolock_min} onClick={() => void run(() => api({ cmd: 'settings', patch: { autolock_min: Number(lock) } }))}>{t('common.save')}</button>
          <span className="grow" /><button className="btn" onClick={() => void lockNow().then(reload)}><I.lock size={14} /> {t('settings.lock')}</button></div>
        <ChangePassword />
        <h3>{t('settings.debug')}</h3>
        {/* 0.3.9: no built-in node — the debug option reads the human's own TRON node only */}
        <label className="check"><input type="checkbox" checked={st.settings.debug_direct_node} disabled={!st.settings.e2e_tron_node && !st.settings.debug_direct_node} onChange={(e) => void run(() => api({ cmd: 'settings', patch: { debug_direct_node: e.target.checked } }))} /><span>{t('settings.debugNode')}</span></label>
        {!st.settings.e2e_tron_node && <div className="small subtle">{t('settings.debugNodeNeedsNode')}</div>}
        <div className="small subtle" style={{ marginTop: 8 }}>{t('settings.extension', { v: st.version })} · id <span className="mono">{st.extension_id}</span></div>
      </div>
      <Err msg={err} />
    </div>
  );
}

/** «Change password»: old password, new one twice; a new salt and key for the vault. */
function ChangePassword() {
  const [o, setO] = useState(''), [a, setA] = useState(''), [b, setB] = useState('');
  const [done, setDone] = useState(false);
  const { busy, err, run } = useAsync();
  const weak = a ? pwProblemText(a) : null;
  return (
    <details className="small" style={{ marginTop: 8 }}><summary>{t('pw.change')}</summary>
      <p className="muted">{t('pw.changeHint')}</p>
      <label className="field"><span>{t('pw.old')}</span><input type="password" autoComplete="current-password" value={o} onChange={(e) => { setO(e.target.value); setDone(false); }} /></label>
      <label className="field"><span>{t('pw.new')}</span><input type="password" autoComplete="new-password" value={a} onChange={(e) => { setA(e.target.value); setDone(false); }} /></label>
      <label className="field"><span>{t('onb.pwRepeat')}</span><input type="password" autoComplete="new-password" value={b} onChange={(e) => setB(e.target.value)} /></label>
      {a && weak && <div className="error">{weak}</div>}
      {a && b && a !== b && <div className="error">{t('onb.pwMismatch')}</div>}
      {done && <div className="plate ok">{t('pw.changed')}</div>}
      <button className="btn sm" disabled={busy || !o || !!weak || a !== b} onClick={() => void run(async () => {
        try { await api({ cmd: 'changePassword', old_password: o, new_password: a }); } catch (e) { throw new Error(pwErrorText((e as Error).message)); }
        setO(''); setA(''); setB(''); setDone(true);
      })}>{t('pw.changeBtn')}</button>
      <Err msg={err} />
    </details>
  );
}

/** 0.3.0: end-to-end encryption with the Signer — switch, wallet key fingerprint, where content reads go. */
function E2ECard({ st }: { st: ScreenProps['st'] }) {
  const e = st.e2e;
  const [node, setNode] = useState(st.settings.e2e_tron_node ?? '');
  const [gw, setGw] = useState(st.settings.x402_gateway_url ?? '');
  // 0.3.1: per EVM network — empty = the built-in RPC (shown as the placeholder)
  const [rpc, setRpc] = useState<Record<string, string>>({ ...(st.settings.e2e_rpc ?? {}) });
  const { busy, err, run } = useAsync();
  const forced = e?.server_mode === 'required' || st.settings.signer_mode === 'public';
  // one permission request for every origin (a second request after an await loses the click's user gesture)
  const askHosts = async (urls: string[]) => {
    const origins = [...new Set(urls.filter((u) => u.trim()).map((u) => new URL(u.trim()).origin + '/*'))];
    if (origins.length && !(await chrome.permissions.request({ origins }))) throw new Error(t('settings.noPermission', { origin: origins.join(', ') }));
  };
  return (
    <div className="card">
      <h2>{t('e2eset.title')}</h2>
      {e?.downgraded && <div className="plate bad small" role="alert">{t('e2eset.downgraded')}</div>}
      <label className="switch"><span><b>{t('e2eset.switch')}</b><div className="small muted">{t('e2eset.switchHint')}</div></span>
        <input type="checkbox" checked={!!(st.settings.e2e_enabled || forced)} disabled={busy || forced} onChange={(x) => void run(() => api({ cmd: 'e2eEnable', on: x.target.checked }))} /></label>
      <div className="small" style={{ marginTop: 6 }}>Signer: {e?.server_mode === 'required' ? t('e2eset.modeRequired') : e?.server_mode === 'on' ? t('e2eset.modeOn') : e?.server_mode === 'off' ? t('e2eset.modeOff') : t('e2eset.modeNone')}
        {e?.active ? <span className="badge pop" style={{ marginLeft: 6 }}>{t('e2eset.on')}</span> : null}</div>
      {insecureUrl(st.settings.e2e_tron_node) && <div className="plate warn small">{t('e2eset.insecureNode')}</div>}
      {e?.wallet_fp && <div className="small" style={{ marginTop: 4 }}>{t('e2eset.walletFp')} <span className="mono" style={{ fontWeight: 800 }}>{e.wallet_fp}</span></div>}
      <details className="small" style={{ marginTop: 8 }}><summary>{t('e2eset.reads')}</summary>
        <p className="muted">{t('e2eset.readsHint')}</p>
        {/* 0.3.9: no built-in TRON node — direct reads only with a node of the human's own (saved) */}
        <label className="check"><input type="checkbox" checked={st.settings.e2e_reads === 'signer' || !st.settings.e2e_tron_node} disabled={busy || !st.settings.e2e_tron_node} onChange={(x) => {
          if (x.target.checked && !confirm(t('e2eset.viaSignerConfirm'))) return;
          void run(() => api({ cmd: 'settings', patch: { e2e_reads: x.target.checked ? 'signer' : 'direct' } }));
        }} /><span>{t('e2eset.viaSigner')}</span></label>
        {!st.settings.e2e_tron_node && <div className="small subtle">{t('e2eset.directNeedsNode')}</div>}
        <label className="field"><span>{t('e2eset.tronNode')}</span><input className="mono" value={node} placeholder={t('e2eset.tronNodePlaceholder')} onChange={(x) => setNode(x.target.value)} /></label>
        {servedNets().map((n) => <label key={n.network} className="field"><span>{t('e2eset.evmRpc', { net: n.name })}</span>
          <input className="mono" value={rpc[String(n.chain_id)] ?? ''} placeholder={(E2E_DEFAULTS.evm_rpc as Record<string, string>)[String(n.chain_id)] ?? ''} onChange={(x) => setRpc({ ...rpc, [String(n.chain_id)]: x.target.value })} /></label>)}
        <div className="small subtle" style={{ marginBottom: 6 }}>{t('e2eset.rpcHint')}</div>
        <label className="field"><span>{t('e2eset.gateway')}</span><input className="mono" value={gw} onChange={(x) => setGw(x.target.value)} /></label>
        <button className="btn sm" disabled={busy} onClick={() => void run(async () => {
          await askHosts([node, gw, ...Object.values(rpc)]);
          await api({ cmd: 'settings', patch: { e2e_tron_node: node, x402_gateway_url: gw, e2e_rpc: rpc } });
        })}>{t('common.save')}</button>
      </details>
      {e?.wallet_fp && <details className="small" style={{ marginTop: 8 }}><summary>{t('e2eset.rotate')}</summary>
        <p className="muted">{t('e2eset.rotateHint')}</p>
        <button className="btn sm ghost-danger" disabled={busy} onClick={() => { if (confirm(t('e2eset.rotateConfirm'))) void run(() => api({ cmd: 'e2eRotateWalletKey', confirm: 'ROTATE' })); }}>{t('e2eset.rotateBtn')}</button>
      </details>}
      <Err msg={err} />
    </div>
  );
}

export function Book({ st }: ScreenProps) {
  const [label, setLabel] = useState(''), [net, setNet] = useState('tron'), [addr, setAddr] = useState('');
  const [chk, setChk] = useState<any>(null);
  const { busy, err, setErr, run } = useAsync();
  useEffect(() => {
    setChk(null); setErr('');
    if (addr.trim().length < 30) return;
    const t = setTimeout(() => { api({ cmd: 'bookCheck', network: net, address: addr.trim() }).then(setChk).catch((e) => setErr(e.message)); }, 300);
    return () => clearTimeout(t);
  }, [addr, net, setErr]);
  return (
    <div className="screen">
      <div className="list">
        {!st.book.length && <div className="empty"><Mascot state="empty" size={64} />{t('common.empty')}</div>}
        {st.book.map((b) => (
          <div key={b.id} className="list-item">
            <div className="row between"><b>{b.label}</b><span className="row"><span className="badge">{b.network}</span><button className="link red small" onClick={() => { if (confirm(t('book.removeConfirm', { label: b.label }))) void run(() => api({ cmd: 'bookRemove', id: b.id })); }}>{t('book.remove')}</button></span></div>
            <Addr a={b.address} network={b.network} copy />
          </div>
        ))}
      </div>
      <form className="card" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api({ cmd: 'bookAdd', label, network: net, address: addr }); setLabel(''); setAddr(''); }); }}>
        <h2>{t('book.add')}</h2>
        <label className="field"><span>{t('book.label')}</span><input value={label} maxLength={64} onChange={(e) => setLabel(e.target.value)} /></label>
        <label className="field"><span>{t('book.network')}</span><select value={net} onChange={(e) => setNet(e.target.value)}><option value="tron">TRON</option><option value="evm:*">{t('book.allEvm')}</option><option value="evm:8453">Base</option></select></label>
        <label className="field"><span>{t('book.address')}</span><input className="mono" value={addr} onChange={(e) => setAddr(e.target.value)} /></label>
        {chk?.similar?.map((s: any, i: number) => <div key={i} className="plate bad"><Mascot state="warning" size={32} className="plate-mascot" />{t('book.similar', { label: s.label || t('book.pastRecipient') })}<div className="small"><Addr a={chk.address} compare={s.address} network={net} /></div><div className="small"><Addr a={s.address} compare={chk.address} network={net} /></div></div>)}
        <button className="btn primary" disabled={busy || !label.trim() || !addr.trim()}>{t('book.addToBook')}</button>
        <Err msg={err} />
      </form>
    </div>
  );
}
