// The request queue + one request under review. Used by the sign window, and in the side panel / popup (
// with the panel open, agent requests are shown in it instead of a separate window).
import { useCallback, useEffect, useState } from 'react';
import type { PreparedView, RequestRow, StatusView } from '../../shared/api';
import { requestAmount, requestTarget } from '../../lib/requestLabel';
import { Review } from './Review';
import { Countdown, Err, api, useAsync } from './ui';
import { t } from '../../i18n';
import { Mascot } from './Mascot';

export function UnlockCard({ onDone, text }: { onDone: () => void; text?: string }) {
  const [pw, setPw] = useState('');
  const { busy, err, run } = useAsync();
  return (
    <div className="card">
      <h2>{t('sign.locked')}</h2>
      {text && <p className="muted">{text}</p>}
      <form onSubmit={(e) => { e.preventDefault(); void run(async () => { await api({ cmd: 'unlock', password: pw }); setPw(''); onDone(); }); }}>
        <label className="field"><span>{t('sign.password')}</span><input type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} /></label>
        <button className="btn primary block" disabled={busy || !pw}>{busy ? t('sign.checking') : t('sign.unlock')}</button>
      </form>
      <Err msg={err} />
    </div>
  );
}

/**
 * 0.3.12: after a signature the operation page follows — `onSigned(id)` when nothing else waits (the popup / panel
 * navigate to #/op/<id>, the sign window shows the page in place); with more requests in the queue a «progress» button
 * stays under the note (`openOp`) and the queue goes on.
 */
export function SignQueue({ st, reload, initial, onClose, mascots, onSigned, openOp }: { st: StatusView; reload: () => void; initial?: string; onClose?: () => void; mascots?: boolean;
  onSigned?: (id: string) => void; openOp?: (id: string) => void }) {
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [cur, setCur] = useState<string | null>(initial ?? null);
  const [view, setView] = useState<PreparedView | null>(null);
  const [note, setNote] = useState('');
  const [signedId, setSignedId] = useState<string | null>(null);
  const { busy, err, setErr, run } = useAsync();

  const loadRows = useCallback(async (): Promise<RequestRow[]> => {
    const r = await api<RequestRow[]>({ cmd: 'requests' }).catch(() => [] as RequestRow[]);
    setRows(r); setLoaded(true);
    setCur((c) => (c && r.some((x) => x.request_id === c) ? c : r[0]?.request_id ?? null));
    return r;
  }, []);
  useEffect(() => { void loadRows(); }, [loadRows, st]);

  useEffect(() => {
    setView(null); setErr('');
    if (!cur || !st.unlocked) return;
    api({ cmd: 'seen', request_id: cur }).catch(() => {});
    void run(async () => setView(await api<PreparedView>({ cmd: 'prepare', request_id: cur })));
  }, [cur, st.unlocked, run, setErr]);

  const row = rows.find((r) => r.request_id === cur);
  return (
    <div>
      {!st.unlocked && <UnlockCard onDone={reload} text={t('sign.lockedText')} />}
      {rows.length > 1 && (
        <div className="list">
          {rows.map((r) => (
            <div key={r.request_id} className={`list-item click queue-item ${r.request_id === cur ? 'cur' : ''}`} onClick={() => setCur(r.request_id)}>
              <div className="req"><span className="what">{requestAmount(r)}</span><Countdown until={r.expires_at} />
                <span className="small muted">{r.agent?.name ?? t('sign.agent')} · {r.account?.name}{r.type === 'swap' ? ` · ${requestTarget(r)}` : ''}</span></div>
            </div>
          ))}
        </div>
      )}
      {signedId && rows.length > 0 && <div className="plate ok small row between" style={{ gap: 8, alignItems: 'center' }}><span>{t('sign.signedMore')}</span>
        <button className="btn sm" onClick={() => (openOp ? openOp(signedId) : void api({ cmd: 'openOp', request_id: signedId }))}>{t('sign.toOp')}</button></div>}
      {loaded && !rows.length && <div className="card">{/* the sign window has no mascot but the small one in its header (UI kit); the popup / panel show the result */}{mascots && note && <Mascot state={note === t('sign.rejected') ? 'canceled' : 'done'} size={64} className="queue-mascot" />}<p className="muted" style={{ marginTop: 0 }}>{t('sign.noRequests')}</p>{note && <div className="plate ok">{note}</div>}{signedId && <button className="btn primary" style={{ marginRight: 8 }} onClick={() => (openOp ? openOp(signedId) : void api({ cmd: 'openOp', request_id: signedId }))}>{t('sign.toOp')}</button>}{onClose && <button className="btn" onClick={onClose}>{t('sign.close')}</button>}</div>}
      {row && st.unlocked && !view && busy && <div className="card muted">{t('sign.building')}</div>}
      {row && view && (
        <Review v={view} busy={busy}
          onReject={() => void run(async () => { await api({ cmd: 'reject', request_id: view.key }); setNote(t('sign.rejected')); setSignedId(null); await loadRows(); })}
          onSign={(checked) => void run(async () => {
            const r = await api<{ status: string; view?: PreparedView; resent?: boolean }>({ cmd: 'sign', request_id: view.key, addressChecked: checked, build_id: view.build_id });
            if (r.status === 'changed' && r.view) { setView(r.view); setErr(t('sign.changed')); return; }
            setNote(r.resent ? t('sign.resent') : t('sign.signedSent'));
            const id = view.key;
            setSignedId(id);
            const left = await loadRows();
            if (!left.length && onSigned) onSigned(id); // nothing else waits: straight to the operation page
          })} />
      )}
      <Err msg={err} />
    </div>
  );
}
