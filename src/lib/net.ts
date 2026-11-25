// Network reads. In production every read goes through the Signer relay (white-listed methods, session Bearer);
// nodes and RPC are never contacted directly. A direct TRON node read is a debug option only (off by default).

export interface TronReader {
  call<T = any>(method: string, body: Record<string, unknown>): Promise<T>;
}
export interface EvmReader {
  rpc<T = any>(chainId: number, method: string, params: unknown[]): Promise<T>;
}
/** Quotes of our x402 gateway (free routes), relayed by the Signer. */
export interface X402Reader {
  estimate(body: Record<string, unknown>): Promise<any>;
  quote(params: Record<string, string>): Promise<any>;
}

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public body?: unknown) { super(message); }
}

async function readBody(r: Response): Promise<any> {
  const t = await r.text();
  try { return JSON.parse(t); } catch { return t; }
}

export async function postJSON(url: string, body: unknown, headers: Record<string, string> = {}, timeoutMs = 20_000): Promise<any> {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const b = await readBody(r);
  if (!r.ok) throw new HttpError(r.status, b?.error?.code ?? `HTTP_${r.status}`, b?.error?.message ?? String(b).slice(0, 200), b);
  return b;
}

export async function getJSON(url: string, headers: Record<string, string> = {}, timeoutMs = 20_000): Promise<any> {
  const r = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  const b = await readBody(r);
  if (!r.ok) throw new HttpError(r.status, b?.error?.code ?? `HTTP_${r.status}`, b?.error?.message ?? String(b).slice(0, 200), b);
  return b;
}

/** Relay: POST /v1/ext/net/tron/<method>, body = the node's own body. */
export class SignerTronReader implements TronReader {
  constructor(private base: () => string, private session: () => string | undefined) {}
  call(method: string, body: Record<string, unknown>) {
    const s = this.session();
    if (!s) throw new HttpError(401, 'NO_SESSION', 'not signed in to the Signer');
    return postJSON(`${this.base()}/v1/ext/net/tron/${method}`, body, { Authorization: `Bearer ${s}` });
  }
}

/** Debug only: our full node directly (settings → "read TRON from the node"). */
export class DirectTronReader implements TronReader {
  constructor(private node: string) {}
  call(method: string, body: Record<string, unknown>) { return postJSON(`${this.node}/wallet/${method}`, body); }
}

export class SignerEvmReader implements EvmReader {
  private id = 1;
  constructor(private base: () => string, private session: () => string | undefined) {}
  async rpc(chainId: number, method: string, params: unknown[]) {
    const s = this.session();
    if (!s) throw new HttpError(401, 'NO_SESSION', 'not signed in to the Signer');
    const r = await postJSON(`${this.base()}/v1/ext/net/evm/${chainId}`, { jsonrpc: '2.0', id: this.id++, method, params }, { Authorization: `Bearer ${s}` });
    if (r?.error) throw new HttpError(502, 'RPC_ERROR', r.error.message ?? 'rpc error', r);
    return r.result;
  }
}

export class SignerX402Reader implements X402Reader {
  constructor(private base: () => string, private session: () => string | undefined) {}
  private h() { const s = this.session(); if (!s) throw new HttpError(401, 'NO_SESSION', 'not signed in'); return { Authorization: `Bearer ${s}` }; }
  estimate(body: Record<string, unknown>) { return postJSON(`${this.base()}/v1/ext/x402/estimate`, body, this.h()); }
  quote(params: Record<string, string>) { return getJSON(`${this.base()}/v1/ext/x402/quote?${new URLSearchParams(params)}`, this.h()); }
}
