// Send by the human : asset → address (address book + look-alike highlight) → amount → the same review
// window as for agents (resources plan, no burning). Goes the existing `own.submit` path (ownPrepare / ownSign).
import { useEffect, useState } from 'react';
import type { PreparedView } from '../../shared/api';
import { assetRows, fmtAmount, fmtUsd } from '../../lib/portfolio';
import { Review } from '../common/Review';
import { Addr, Err, accountTag, api, useAsync, useBalances, usePrices } from '../common/ui';
import { CoinLogo } from '../common/Logo';
import type { ScreenProps } from './screen';
import { t } from '../../i18n';
import { Mascot } from '../common/Mascot';

interface Pick { network: string; symbol: string }
const EVM_NETS = ['evm:1', 'evm:42161', 'evm:10', 'evm:137', 'evm:8453'];

export function Send({ st, account, nav }: ScreenProps) {
  const bal = useBalances([account.id], [st.signer.signed_in])[account.id];
  const prices = usePrices(st.signer.signed_in);
  const rows = assetRows(bal, prices ?? {});
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [pick, setPick] = useState<Pick>({ network: 'tron', symbol: 'USDT' });
  const asset = pick.symbol;
  const isEvm = pick.network !== 'tron';
  const [to, setTo] = useState(''), [amount, setAmount] = useState('');
  const [chk, setChk] = useState<any>(null);
  const [view, setView] = useState<PreparedView | null>(null);
  const [done, setDone] = useState('');
  const { busy, err, setErr, run } = useAsync();

  useEffect(() => {
    setChk(null);
    const a = to.trim();
    if (a.length < 30) return;
    if (isEvm && !/^0x[0-9a-fA-F]{40}$/.test(a)) { setChk({ error: 'INVALID_ADDRESS' }); return; }
    const t = setTimeout(() => { api({ cmd: 'bookCheck', network: pick.network, address: a }).then(setChk).catch((e) => setChk({ error: (e as Error).message })); }, 250);
    return () => clearTimeout(t);
  }, [to, pick.network]);

  if (view) return (
    <div className="screen">
      <Review v={view} busy={busy} onReject={() => setView(null)} onSign={(checked) => void run(async () => {
        const r = await api<{ status: string; view?: PreparedView; request_id?: string }>(isEvm ? { cmd: 'evmSign', key: view.key, addressChecked: checked, build_id: view.build_id } : { cmd: 'ownSign', own_id: view.key, addressChecked: checked, build_id: view.build_id });
        if (r.status === 'changed' && r.view) { setView(r.view); setErr(t('send.changed')); return; }
        // 0.2.1+: always the operation page (no «Sent to the Signer: awr_…» line); without an id — the history
        nav(r.request_id ? `/op/${encodeURIComponent(r.request_id)}` : '/history'); return;
      })} />
      <Err msg={err} />
    </div>
  );

  const have = rows.find((r) => r.key === `${pick.network}/${asset}`);
  const netLabel = rows.find((r) => r.network === pick.network)?.network_name ?? (isEvm ? pick.network : 'TRON');
  const evmRows = rows.filter((r) => EVM_NETS.includes(r.network)).sort((a, b) => EVM_NETS.indexOf(a.network) - EVM_NETS.indexOf(b.network));
  return (
    <div className="screen">
      <div className="steps">{[t('send.stepAsset'), t('send.stepTo'), t('send.stepAmount')].map((s, i) => <div key={s} className={i === step ? 'on' : i < step ? 'done' : ''}>{i + 1}. {s}</div>)}</div>
      {done && <div className="plate ok">{done}</div>}

      {step === 0 && (
        <div className="list">
          {(['USDT', 'TRX'] as const).map((s) => {
            const r = rows.find((x) => x.key === `tron/${s}`);
            return <div key={s} className="asset list-item click" onClick={() => { setPick({ network: 'tron', symbol: s }); setTo(''); setStep(1); setDone(''); }}>
              <CoinLogo symbol={s} network="tron" logo={r?.price?.logo_url} /><div><div className="sym">{s} <span className="net">· TRON</span></div></div>
              <div><div className="amt">{r ? fmtAmount(r.amount) : '…'}</div><div className="usd">{r?.usd != null ? fmtUsd(r.usd) : ''}</div></div></div>;
          })}
          {evmRows.map((r) => (
            <div key={r.key} className="asset list-item click" onClick={() => { setPick({ network: r.network, symbol: r.symbol }); setTo(''); setStep(1); setDone(''); }}>
              <CoinLogo symbol={r.symbol} network={r.network} logo={r.price?.logo_url} /><div><div className="sym">{r.symbol} <span className="net">· {r.network_name}</span></div>{r.native && <div className="small muted">{t('send.gas')}</div>}</div>
              <div><div className="amt">{fmtAmount(r.amount)}</div><div className="usd">{r.usd != null ? fmtUsd(r.usd) : ''}</div></div></div>
          ))}
          {!evmRows.length && <div className="empty small">{t('send.evmLater')}</div>}
        </div>
      )}

      {step === 1 && (
        <div className="card">
          <h2>{t('send.toTitle', { asset, net: netLabel })}</h2>
          <RecipientPicker st={st} self={account.id} network={pick.network} symbol={asset} to={to} onPick={setTo} />
          <label className="field" style={{ marginTop: 8 }}><span>{t('send.manual')}</span><input className="mono" value={to} placeholder={isEvm ? '0x…' : 'T…'} onChange={(e) => setTo(e.target.value)} /></label>
          {chk?.error && <div className="error">{t('err.INVALID_ADDRESS')}</div>}
          {chk?.own && <div className="plate ok">{t('send.own', { name: chk.own.name, group: chk.own.group })}</div>}
          {chk?.match && <div className="plate ok">{t('send.inBook', { label: chk.match.label })}</div>}
          {chk && !chk.error && !chk.match && !chk.own && <div className="plate warn">{t('send.unknown')}</div>}
          {chk?.similar?.map((s: any, i: number) => <div key={i} className="plate bad"><Mascot state="warning" size={32} className="plate-mascot" />{t('send.similar', { what: s.source === 'own' ? t('send.similarOwn', { label: s.label }) : t('send.similarOther', { label: s.label || t('send.pastRecipient') }) })}
            <div className="small"><Addr a={chk.address} compare={s.address} network={pick.network} /></div><div className="small"><Addr a={s.address} compare={chk.address} network={pick.network} /></div></div>)}
          <div className="row"><button className="btn" onClick={() => setStep(0)}>{t('common.back')}</button><span className="grow" /><button className="btn primary" disabled={!to.trim() || !!chk?.error} onClick={() => setStep(2)}>{t('common.next')}</button></div>
        </div>
      )}

      {step === 2 && (
        <form className="card" onSubmit={(e) => { e.preventDefault(); void run(async () => setView(await api<PreparedView>(isEvm
          ? { cmd: 'evmPrepare', account_id: account.id, network: pick.network, asset, to: to.trim(), amount: amount.trim().replace(',', '.') }
          : { cmd: 'ownPrepare', account_id: account.id, asset: asset as 'TRX' | 'USDT', to: to.trim(), amount: amount.trim().replace(',', '.') }))); }}>
          <h2>{t('send.howMuch', { asset, net: netLabel })}</h2>
          <label className="field"><span>{t('send.stepAmount')}</span><input className="mono" style={{ fontSize: 22, fontWeight: 700 }} value={amount} inputMode="decimal" autoFocus onChange={(e) => setAmount(e.target.value)} /></label>
          <div className="row between small"><span className="muted">{t('send.available')} <span className="num">{have ? fmtAmount(have.amount) : '…'} {asset}</span></span>
            {have && !have.native && <button type="button" className="link" onClick={() => setAmount(have.amount)}>{t('send.all')}</button>}</div>
          <p className="small muted">{isEvm ? t('send.gasHint', { net: netLabel }) : t('send.resHint')}</p>
          <div className="row"><button type="button" className="btn" onClick={() => setStep(1)}>{t('common.back')}</button><span className="grow" />
            <button className="btn primary" disabled={busy || !amount.trim() || !st.signer.connected}>{busy ? t('send.building') : t('send.check')}</button></div>
          {!st.signer.connected && <div className="small subtle" style={{ marginTop: 6 }}>{t('send.needSigner')}</div>}
          <Err msg={err} />
        </form>
      )}
      {step === 0 && <button className="btn block" onClick={() => nav('/')}>{t('acc.cancel')}</button>}
    </div>
  );
}

/**
 * 0.2.2 : pick the recipient from «My accounts» (every account of every phrase and imported keys, grouped
 * by phrase, with the address of this network and its balance) or «Address book»; search by name / address.
 */
function RecipientPicker({ st, self, network, symbol, to, onPick }: { st: ScreenProps['st']; self: string; network: string; symbol: string; to: string; onPick: (a: string) => void }) {
  const isEvm = network !== 'tron';
  const [tab, setTab] = useState<'own' | 'book'>('own');
  const [q, setQ] = useState('');
  const accs = st.accounts.filter((a) => a.id !== self && (isEvm ? a.addresses.evm : a.addresses.tron));
  const bals = useBalances(tab === 'own' ? accs.map((a) => a.id) : [], [st.signer.signed_in]);
  const book = st.book.filter((b) => (isEvm ? b.network === 'evm:*' || b.network === network : b.network === 'tron'));
  const needle = q.trim().toLowerCase();
  const hit = (...xs: (string | undefined)[]) => !needle || xs.some((x) => x?.toLowerCase().includes(needle));
  const groups = new Map<string, typeof accs>();
  for (const a of accs) {
    const addr = (isEvm ? a.addresses.evm : a.addresses.tron)!;
    const g = a.origin === 'imported' ? t('acc.groupImported') : t('send.groupPhrase', { name: accountTag(st, a) });
    if (hit(a.name, addr, g)) groups.set(g, [...(groups.get(g) ?? []), a]);
  }
  const books = book.filter((b) => hit(b.label, b.address));
  const cur = to.trim().toLowerCase();
  return <>
    <div className="tabs" style={{ marginBottom: 8 }}>
      <button className={`tab ${tab === 'own' ? 'active' : ''}`} onClick={() => setTab('own')}>{t('send.myAccounts')}</button>
      <button className={`tab ${tab === 'book' ? 'active' : ''}`} onClick={() => setTab('book')}>{t('send.bookTab', { n: book.length })}</button>
    </div>
    <div className="search"><input value={q} placeholder={t('send.searchPh')} onChange={(e) => setQ(e.target.value)} /></div>
    <div className="list" style={{ boxShadow: 'none', maxHeight: 320, overflowY: 'auto' }}>
      {tab === 'own' && !groups.size && <div className="empty small">{accs.length ? t('acc.nothing') : t('send.noOther')}</div>}
      {tab === 'own' && [...groups.entries()].map(([g, list]) => <div key={g}>
        <div className="small" style={{ fontWeight: 800, padding: '6px 10px 2px' }}>{g}</div>
        {list.map((a) => {
          const addr = (isEvm ? a.addresses.evm : a.addresses.tron)!;
          const row = assetRows(bals[a.id], {}).find((r) => r.key === `${network}/${symbol}`);
          return <div key={a.id} className={`list-item click ${cur === addr.toLowerCase() ? 'queue-item cur' : ''}`} onClick={() => onPick(addr)}>
            <div className="row between"><b>{a.name}</b><span className="small num">{row ? `${fmtAmount(row.amount)} ${symbol}` : bals[a.id] ? `0 ${symbol}` : '…'}</span></div>
            <div className="small"><Addr a={addr} network={network} /></div></div>;
        })}
      </div>)}
      {tab === 'book' && !books.length && <div className="empty small">{book.length ? t('acc.nothing') : t('send.bookEmptyNet')}</div>}
      {tab === 'book' && books.map((b) => <div key={b.id} className={`list-item click ${cur === b.address.toLowerCase() ? 'queue-item cur' : ''}`} onClick={() => onPick(b.address)}><b>{b.label}</b><div className="small"><Addr a={b.address} network={network} /></div></div>)}
    </div>
  </>;
}
