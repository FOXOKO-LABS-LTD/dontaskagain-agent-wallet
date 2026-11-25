// WebSocket to the Signer: auth first, envelope {type,id,…}, ack {type:"ack",id,ok,error}, ping/pong 20 s.
// Chrome ≥ 116 keeps an MV3 service worker alive while a WebSocket is active; an alarm reconnects after a restart.
import { logBg } from './safe';

type Handler = (msg: any) => void | Promise<void>;
/** How long a request waits for its ack (tests shorten it). */
export const WS_TIMING = { ack_ms: 20_000 };

export class SignerSocket {
  private ws: WebSocket | null = null;
  private seq = 0;
  private waiters = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastServerPing = 0;
  private retry = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUs = false;
  public lastError = '';
  /** 0.3.3: number of the current connection — the Signer's hello is taken once per connection */
  public conn = 0;

  constructor(private url: () => string, private session: () => string | undefined, private onMessage: Handler, private onState: (connected: boolean) => void,
    private onBlocked: () => void = () => {}) {}

  get connected(): boolean { return !!this.ws && this.ws.readyState === WebSocket.OPEN; }

  connect(): void {
    const s = this.session();
    if (!s || this.ws) return;
    this.closedByUs = false;
    const u = this.url().replace(/^http/, 'ws') + '/v1/ext/ws';
    let ws: WebSocket;
    try { ws = new WebSocket(u); } catch (e) { this.lastError = (e as Error).message; this.schedule(); return; }
    this.ws = ws;
    let openedAt = 0;
    ws.onopen = () => {
      this.conn++;
      openedAt = Date.now();
      this.lastServerPing = Date.now();
      ws.send(JSON.stringify({ type: 'auth', session: s }));
      this.onState(true);
      // the Signer pings every 20 s (that traffic keeps the worker alive); 3 missed pings → reconnect
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN && Date.now() - this.lastServerPing > 70_000) { this.lastError = 'no ping from the Signer (3 missed)'; ws.close(); }
      }, 20_000);
    };
    ws.onmessage = (ev) => {
      let m: any;
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.type === 'ping') { this.lastServerPing = Date.now(); this.raw({ type: 'pong', id: m.id }); return; }
      // the Signer operator blocked the wallet — no reconnect (the close 4403 follows)
      if (m.type === 'wallet.blocked' || (m.type === 'ack' && m.ok === false && m.error?.code === 'WALLET_BLOCKED')) { this.closedByUs = true; this.onBlocked(); return; }
      if (m.type === 'ack' && m.id && this.waiters.has(m.id)) {
        const w = this.waiters.get(m.id)!;
        this.waiters.delete(m.id); clearTimeout(w.timer);
        if (m.ok === false) w.reject(Object.assign(new Error(m.error?.message ?? m.error?.code ?? 'refused'), { code: m.error?.code, ack: m }));
        else w.resolve(m);
        return;
      }
      Promise.resolve(this.onMessage(m)).catch((e) => logBg(`ws ${m?.type}`, e));
    };
    ws.onerror = () => { this.lastError = 'WebSocket error'; };
    ws.onclose = (ev) => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.ws = null;
      for (const [, w] of this.waiters) { clearTimeout(w.timer); w.reject(new Error('connection closed')); }
      this.waiters.clear();
      if (ev.code === 4403) { this.closedByUs = true; this.onBlocked(); } // wallet blocked — never reconnect
      else if (ev.code === 4401 || ev.code === 1008) this.lastError = 'session refused by the Signer';
      else if (ev.reason) this.lastError = `closed by the Signer: ${String(ev.reason).slice(0, 120)}`;
      // 0.3.3: the backoff is reset only after a connection that lived (a Signer that closes at once — flood limits,
      // logout — is not hammered every second)
      if (openedAt && Date.now() - openedAt > 60_000) this.retry = 0;
      this.onState(false);
      if (!this.closedByUs) this.schedule();
    };
  }

  private schedule(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(30_000, 1000 * 2 ** this.retry++);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, delay);
  }

  close(): void {
    this.closedByUs = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close();
    this.ws = null;
  }

  raw(m: object): void { if (this.connected) this.ws!.send(JSON.stringify(m)); }

  /** Send and wait for the ack (rejects on ok:false, timeout, closed socket). */
  request(type: string, body: Record<string, unknown>, timeoutMs = WS_TIMING.ack_ms): Promise<any> {
    if (!this.connected) return Promise.reject(new Error('Signer is not connected'));
    const id = `e${Date.now().toString(36)}${(this.seq++).toString(36)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.delete(id); reject(new Error(`${type}: no ack`)); }, timeoutMs);
      this.waiters.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ type, id, ...body }));
    });
  }

  ack(id: string | undefined, ok = true, error?: { code: string; message: string }): void {
    if (!id) return;
    this.raw(ok ? { type: 'ack', id, ok: true } : { type: 'ack', id, ok: false, error });
  }
}
