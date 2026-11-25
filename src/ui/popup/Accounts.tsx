// Accounts and phrases (0.1.7):
//  /accounts            — choose the account: a full screen, grouped by phrase (imported keys — their own group),
//                         identicon, name, short addresses, $ sum, the current one marked; search when > 6;
//                         add / rename / hide. In search results each account carries its phrase's name.
//  /accounts/add[/<x>]  — add an account: from which phrase (or a new phrase, import a phrase, import a key), the name,
//                         and the future TRON / EVM addresses before anything is created.
//  /seeds               — phrases: name and number of accounts; create, import with a name, rename, delete (not the
//                         first one; password; its accounts are hidden and unbound from agents). No «show phrase».
import { useEffect, useMemo, useState } from 'react';
import type { AccountPreview, AccountView, SeedView, StatusView } from '../../shared/api';
import { shortAddr } from '../../lib/similar';
import { assetRows, fmtUsd, totalUsd } from '../../lib/portfolio';
import { Identicon } from '../common/Identicon';
import { I } from '../common/icons';
import { ImportFields, NewPhrase, importReady, type ImportValue } from '../common/Phrase';
import { Addr, Err, accountTag, api, humanError, useAsync, useBalances, usePrices } from '../common/ui';
import { TYPE_INFO, type RequestType } from '../../lib/wallet/model';
import type { ScreenProps } from './screen';
import { t } from '../../i18n';

const IMPORTED = '__imported';

function groupsOf(st: StatusView, list: AccountView[]): { id: string; title: string; root?: boolean; items: AccountView[] }[] {
  const out = st.seeds.map((s) => ({ id: s.id, title: s.name, root: s.root, items: list.filter((a) => a.origin === 'hd' && a.seed_id === s.id) }));
  const orphan = list.filter((a) => a.origin === 'hd' && !st.seeds.some((s) => s.id === a.seed_id));
  if (orphan.length) out.push({ id: '__hd', title: t('acc.groupPhrase'), root: false, items: orphan });
  out.push({ id: IMPORTED, title: t('acc.groupImported'), root: false, items: list.filter((a) => a.origin === 'imported') });
  return out.filter((g) => g.items.length);
}

export function AccountsScreen({ st, account, nav, pick }: ScreenProps & { pick: (id: string) => void }) {
  const bal = useBalances(st.accounts.map((a) => a.id), [st.signer.signed_in, st.settings.debug_direct_node]);
  const prices = usePrices(st.signer.signed_in);
  const [q, setQ] = useState('');
  const [rename, setRename] = useState<{ id: string; name: string } | null>(null);
  const { busy, err, run } = useAsync();
  const query = q.trim().toLowerCase();
  const list = query ? st.accounts.filter((a) => [a.name, a.addresses.tron, a.addresses.evm, accountTag(st, a)].some((x) => x?.toLowerCase().includes(query))) : st.accounts;
  const choose = (id: string) => { pick(id); nav('/'); };

  const item = (a: AccountView, flat: boolean) => {
    const rows = assetRows(bal[a.id], prices ?? {});
    const tot = totalUsd(rows);
    const cur = a.id === account.id;
    const editing = rename?.id === a.id;
    return (
      <div key={a.id} className={`acc-item ${cur ? 'active' : ''}`} onClick={() => !editing && choose(a.id)}>
        <Identicon addr={a.addresses.tron ?? a.addresses.evm ?? a.id} size={32} />
        <div className="who">
          {editing ? (
            <form className="row" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); void run(async () => { await api({ cmd: 'renameAccount', id: a.id, name: rename!.name }); setRename(null); }); }}>
              <input value={rename!.name} maxLength={32} autoFocus onChange={(e) => setRename({ id: a.id, name: e.target.value })} />
              <button className="btn sm primary" disabled={busy || !rename!.name.trim()}>OK</button>
              <button type="button" className="btn sm" onClick={() => setRename(null)}>×</button>
            </form>
          ) : (
            <b>{a.name}
              {a.root && <span className="badge pop">{t('acc.badgeLogin')}</span>}
              {flat && <span className="badge">{accountTag(st, a)}</span>}
              {cur && <span className="badge ink"><I.check size={10} /> {t('acc.badgeCurrent')}</span>}
            </b>
          )}
          <div className="short muted">{shortAddr(a.addresses.tron ?? '')} · {shortAddr(a.addresses.evm ?? '')}</div>
        </div>
        <div className="num sum">{bal[a.id] ? fmtUsd(tot.usd) + (tot.partial ? '+' : '') : '…'}</div>
        {!editing && (
          <div className="acc-acts" onClick={(e) => e.stopPropagation()}>
            <button className="iconbtn flat" title={t('acc.rename')} aria-label={t('acc.rename')} onClick={() => setRename({ id: a.id, name: a.name })}><I.pencil size={14} /></button>
            {!a.root && <button className="iconbtn flat" title={t('acc.hide')} aria-label={t('acc.hide')}
              onClick={() => { if (confirm(t('acc.hideConfirm', { name: a.name, suffix: a.origin === 'hd' ? t('acc.hidePhraseSuffix') : '' }))) void run(() => api({ cmd: 'hideAccount', id: a.id })); }}><I.eyeOff size={14} /></button>}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="screen">
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="btn primary grow" onClick={() => nav('/accounts/add')}><I.plus size={14} /> {t('title.accountAdd')}</button>
        <button className="btn" onClick={() => nav('/seeds')} title={t('title.seeds')}><I.seed size={14} /> {t('acc.phrases')}</button>
      </div>
      {st.accounts.length > 6 && (
        <label className="search"><I.search size={14} /><input placeholder={t('acc.search')} value={q} onChange={(e) => setQ(e.target.value)} autoFocus /></label>
      )}
      {query ? (
        <div className="list">{list.length ? list.map((a) => item(a, true)) : <div className="empty">{t('acc.nothing')}</div>}</div>
      ) : groupsOf(st, list).map((g) => (
        <div key={g.id} className="acc-group">
          <div className="group-head"><span className="eyebrow">{g.title}</span>{g.root && <span className="small muted">{t('acc.rootHint')}</span>}</div>
          <div className="list">{g.items.map((a) => item(a, false))}</div>
        </div>
      ))}
      <Err msg={err} />
    </div>
  );
}

// ---------------- add account ----------------
type Src = { seed: string } | 'new' | 'import';

function Preview({ p, loading, err }: { p: AccountPreview | null; loading: boolean; err?: string }) {
  return (
    <div className="card flat preview">
      <h3 style={{ marginTop: 0 }}>{t('acc.previewTitle')}{p?.index !== undefined ? t('acc.previewIndex', { i: p.index }) : ''}</h3>
      {err ? <div className="error">{err}</div> : !p ? <div className="small muted">{loading ? t('acc.counting') : t('acc.previewEmpty')}</div> : <>
        <div className="kv"><span className="k">TRON</span><Addr a={p.tron} /><span className="k">{t('acc.evmAll')}</span><Addr a={p.evm} network="evm" /></div>
        {p.exists && <div className="plate bad small">{t('acc.exists', { name: p.exists })}</div>}
      </>}
    </div>
  );
}

function usePreview(req: { seed_id?: string; mnemonic?: string; privateKey?: string } | null): { p: AccountPreview | null; loading: boolean; err: string } {
  const [p, setP] = useState<AccountPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const key = JSON.stringify(req);
  useEffect(() => {
    setP(null); setErr('');
    if (!req) return;
    let stop = false;
    setLoading(true);
    const t = setTimeout(() => {
      api<AccountPreview>({ cmd: 'accountPreview', ...req }).then((x) => { if (!stop) setP(x); }).catch((e) => { if (!stop) setErr(e.message); }).finally(() => { if (!stop) setLoading(false); });
    }, req.seed_id ? 0 : 250);
    return () => { stop = true; clearTimeout(t); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return { p, loading, err };
}

export function AddAccount({ st, nav, pick, path }: ScreenProps & { pick: (id: string) => void; path: string }) {
  const arg = path.split('/')[3];
  const startSeed = st.seeds.find((s) => s.id === arg)?.id ?? st.seeds[0]?.id;
  const [src, setSrc] = useState<Src>(arg === 'new' ? 'new' : arg === 'import' ? 'import' : startSeed ? { seed: startSeed } : 'import');
  const [name, setName] = useState('');
  const [phrase, setPhrase] = useState('');          // a new phrase after the write-down check
  const [seedName, setSeedName] = useState('');
  const [imp, setImp] = useState<ImportValue>(() => ({ kind: 'seed', secret: '', name: t('acc.phraseN', { n: st.seeds.length + 1 }) }));
  const { busy, err, setErr, run } = useAsync();
  const seed = typeof src === 'object' ? st.seeds.find((s) => s.id === src.seed) : undefined;
  // access for agents right away (nothing ticked by default — rights are never widened silently)
  const [agents, setAgents] = useState<string[]>([]);
  const [bindFail, setBindFail] = useState<{ id: string; msg: string } | null>(null);

  const previewReq = useMemo(() => {
    if (seed) return { seed_id: seed.id };
    if (src === 'new' && phrase) return { mnemonic: phrase };
    if (src === 'import' && importReady({ ...imp, name: imp.name || 'x' })) return imp.kind === 'key' ? { privateKey: imp.secret.trim() } : { mnemonic: imp.secret.trim() };
    return null;
  }, [seed, src, phrase, imp]);
  const pv = usePreview(previewReq);

  const bind = async (id: string): Promise<boolean> => {
    try { await api({ cmd: 'agentsBindAccount', account_id: id, agent_ids: agents }); setBindFail(null); return true; }
    catch (e) { setBindFail({ id, msg: (e as Error).message }); return false; }
  };
  const done = async (id: string) => { pick(id); if (agents.length && !(await bind(id))) return; nav('/'); };
  const create = () => void run(async () => {
    if (seed) { const a = await api<{ id: string }>({ cmd: 'addAccount', name: name.trim(), seed_id: seed.id }); return done(a.id); }
    if (src === 'new') { const r = await api<{ account: { id: string } }>({ cmd: 'seedCreate', name: seedName.trim(), mnemonic: phrase, account_name: name.trim() || seedName.trim() }); setPhrase(''); return done(r.account.id); }
    if (imp.kind === 'key') { const a = await api<{ id: string }>({ cmd: 'importKey', privateKey: imp.secret.trim(), name: imp.name.trim() }); return done(a.id); }
    const r = await api<{ account: { id: string } }>({ cmd: 'seedCreate', name: imp.name.trim(), mnemonic: imp.secret.trim(), account_name: name.trim() || imp.name.trim() });
    return done(r.account.id);
  });

  // the account exists, only the binding failed: say so, retry, or do it later in the agent's settings
  if (bindFail) {
    const chosen = st.agents.filter((a) => agents.includes(a.id));
    return (
      <div className="screen">
        <div className="card">
          <div className="plate ok small">{t('acc.bindCreated')}</div>
          <div className="plate bad small">{t('acc.bindFailed')}: {humanError(bindFail.msg)}</div>
          <p className="small muted">{t('acc.bindLaterHint')}</p>
          <div className="col" style={{ gap: 6 }}>
            {chosen.map((a) => <button key={a.id} className="btn" onClick={() => nav(`/agent/${a.id}`)}>{t('acc.bindLater', { name: a.name })}</button>)}
          </div>
          <div className="actions">
            <button className="btn" onClick={() => nav('/')}>{t('main.toHome')}</button><span className="grow" />
            <button className="btn primary" disabled={busy} onClick={() => void run(async () => { if (await bind(bindFail.id)) nav('/'); })}>{t('acc.bindRetry')}</button>
          </div>
        </div>
      </div>
    );
  }

  const choose = (s: Src) => { setSrc(s); setErr(''); setPhrase(''); };
  const opt = (k: string, on: boolean, title: string, sub: string, f: () => void) => (
    <label key={k} className={`opt ${on ? 'on' : ''}`}><input type="radio" name="src" checked={on} onChange={f} /><span><b>{title}</b><span className="small muted">{sub}</span></span></label>
  );

  // a new phrase: first the words and the check, then the rest of the form
  if (src === 'new' && !phrase) return (
    <div className="screen">
      <NewPhrase backLabel={t('acc.otherSource')} onBack={() => choose(st.seeds[0] ? { seed: st.seeds[0].id } : 'import')} onReady={(p) => { setPhrase(p); setSeedName((x) => x || t('acc.phraseN', { n: st.seeds.length + 1 })); }} />
    </div>
  );

  const ready = seed ? !!name.trim() : src === 'new' ? !!seedName.trim() : importReady(imp);
  return (
    <div className="screen">
      <div className="card">
        <h2>{t('acc.from')}</h2>
        <div className="opts">
          {st.seeds.map((s) => opt(s.id, seed?.id === s.id, s.name, t('acc.seedSub', { accounts: s.accounts, next: s.next_index, main: s.root ? t('acc.seedSubMain') : '' }), () => choose({ seed: s.id })))}
          {opt('new', src === 'new', t('acc.newPhrase'), t('acc.newPhraseSub'), () => choose('new'))}
          {opt('import', src === 'import', t('acc.import'), t('acc.importSub'), () => { choose('import'); setImp({ kind: 'seed', secret: '', name: t('acc.phraseN', { n: st.seeds.length + 1 }) }); })}
        </div>
      </div>
      <div className="card">
        {src === 'import' && <ImportFields v={imp} set={(v) => { setImp(v); setErr(''); }} seedDefault={t('acc.phraseN', { n: st.seeds.length + 1 })} keyDefault="" />}
        {src === 'new' && <>
          <div className="plate ok small">{t('acc.phraseChecked')}</div>
          <label className="field"><span>{t('phrase.seedName')}</span><input value={seedName} maxLength={32} onChange={(e) => setSeedName(e.target.value)} /></label>
        </>}
        {(seed || src === 'new' || (src === 'import' && imp.kind === 'seed')) && (
          <label className="field"><span>{t('phrase.accName')}{seed ? '' : t('acc.asPhrase')}</span><input value={name} maxLength={32} onChange={(e) => setName(e.target.value)} autoFocus={!!seed} /></label>
        )}
        <AgentAccess st={st} sel={agents} set={setAgents} />
        <Preview p={pv.p} loading={pv.loading} err={pv.err} />
        <Err msg={err} />
        <div className="actions">
          <button className="btn" onClick={() => nav('/accounts')}>{t('acc.cancel')}</button><span className="grow" />
          <button className="btn primary" disabled={busy || !ready || !!pv.p?.exists} onClick={create}>{busy ? t('acc.creating') : t('acc.create')}</button>
        </div>
      </div>
    </div>
  );
}

/** «Give agents access»: live agents with checkboxes, none ticked; what an agent gets. */
function AgentAccess({ st, sel, set }: { st: StatusView; sel: string[]; set: (x: string[]) => void }) {
  const live = st.agents.filter((a) => !a.revoked_at);
  return (
    <div className="agent-access" style={{ marginTop: 10 }}>
      <div className="eyebrow">{t('acc.agentsTitle')}</div>
      {!live.length ? <div className="small muted" style={{ marginTop: 4 }}>{t('acc.agentsNone')}</div> : <>
        {live.map((a) => (
          <label key={a.id} className="check">
            <input type="checkbox" checked={sel.includes(a.id)} onChange={(e) => set(e.target.checked ? [...sel, a.id] : sel.filter((x) => x !== a.id))} />
            <span><b>{a.name}</b> <span className="small muted">· {a.allowed_types.map((ty) => TYPE_INFO[ty as RequestType]?.label ?? ty).join(', ') || t('acc.agentsNoTypes')}</span></span>
          </label>
        ))}
        <p className="small muted" style={{ margin: '4px 0 0' }}>{t('acc.agentsHint')}</p>
        {sel.length > 0 && !st.signer.connected && <div className="plate warn small">{t('acc.agentsOffline')}</div>}
      </>}
    </div>
  );
}

// ---------------- phrases ----------------
export function Seeds({ st, nav }: ScreenProps) {
  const [rename, setRename] = useState<{ id: string; name: string } | null>(null);
  const [del, setDel] = useState<{ seed: SeedView; pw: string } | null>(null);
  const [note, setNote] = useState('');
  const { busy, err, setErr, run } = useAsync();
  return (
    <div className="screen">
      <p className="small muted" style={{ marginTop: 0 }}>{t('acc.seedsIntro')}</p>
      <div className="list">
        {st.seeds.map((s) => (
          <div key={s.id} className="list-item">
            {rename?.id === s.id ? (
              <form className="row" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api({ cmd: 'seedRename', id: s.id, name: rename.name }); setRename(null); }); }}>
                <input value={rename.name} maxLength={32} autoFocus onChange={(e) => setRename({ id: s.id, name: e.target.value })} />
                <button className="btn sm primary" disabled={busy || !rename.name.trim()}>OK</button><button type="button" className="btn sm" onClick={() => setRename(null)}>×</button>
              </form>
            ) : (
              <div className="row between">
                <div style={{ minWidth: 0 }}><b>{s.name}</b> {s.root && <span className="badge pop">{t('acc.seedRoot')}</span>}
                  <div className="small muted">{t('acc.seedLine', { accounts: s.accounts, next: s.next_index })}</div></div>
                <div className="row" style={{ gap: 2 }}>
                  <button className="iconbtn flat" title={t('acc.addFromSeed')} aria-label={t('title.accountAdd')} onClick={() => nav(`/accounts/add/${s.id}`)}><I.plus size={14} /></button>
                  <button className="iconbtn flat" title={t('acc.rename')} aria-label={t('acc.rename')} onClick={() => setRename({ id: s.id, name: s.name })}><I.pencil size={14} /></button>
                  {!s.root && <button className="iconbtn flat danger-ic" title={t('acc.removeSeed')} aria-label={t('acc.removeSeed')} onClick={() => { setDel({ seed: s, pw: '' }); setErr(''); }}><I.trash size={14} /></button>}
                </div>
              </div>
            )}
            {del?.seed.id === s.id && (
              <form className="plate bad" onSubmit={(e) => { e.preventDefault(); void run(async () => { const r = await api<{ hidden: number }>({ cmd: 'seedRemove', id: s.id, password: del.pw }); setDel(null); setNote(t('acc.seedRemoved', { name: s.name, n: r.hidden })); }); }}>
                {t('acc.removeConfirm', { name: s.name, n: s.accounts })}
                <label className="field" style={{ marginTop: 8 }}><span>{t('acc.walletPw')}</span><input type="password" autoComplete="current-password" autoFocus value={del.pw} onChange={(e) => setDel({ ...del, pw: e.target.value })} /></label>
                <div className="row"><button className="btn danger sm" disabled={busy || !del.pw}>{busy ? t('acc.checkingPw') : t('onb.delete')}</button><button type="button" className="btn sm" onClick={() => setDel(null)}>{t('acc.cancel')}</button></div>
              </form>
            )}
          </div>
        ))}
        {!st.seeds.length && <div className="empty">{t('acc.noSeeds')}</div>}
      </div>
      {note && <div className="plate ok small">{note}</div>}
      <Err msg={err} />
      <div className="row">
        <button className="btn primary grow" onClick={() => nav('/accounts/add/new')}><I.plus size={14} /> {t('acc.newPhrase')}</button>
        <button className="btn grow" onClick={() => nav('/accounts/add/import')}><I.key size={14} /> {t('acc.importPhrase')}</button>
      </div>
    </div>
  );
}
