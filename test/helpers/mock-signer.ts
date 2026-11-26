// Mock of the Signer's extension side for the flow test: sign-in (verifies both signatures), WebSocket,
// wallet.sync (verifies digest and signatures), agents, relay with a canned TRON node / Base RPC / x402 estimate.
// It never talks to a real network and never broadcasts anything.
import { createServer, type Server } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { getAddress } from 'viem';
import { expectedChallenge } from '../../src/lib/signer/auth';
import { recoverEvmMessage, recoverTronMessage } from '../../src/lib/sign';
import { docDigest, docSignText } from '../../src/lib/wallet/doc';
import { tronToHex41 } from '../../src/lib/tron/address';
import { e2eDocDigest } from '../../src/lib/e2e/protocol';
import { bundleOf, fingerprint, generateKeys } from '../../src/lib/e2e/crypto';
import { consentSignText } from '../../src/lib/oauth';

export interface MockState {
  accounts: Record<string, { exists: boolean; balanceSun: number; energy: number; freeNet: number; usdt: bigint }>;
  usdcMicro: bigint;
  coverPrice: string | null;
  energyUsed: number;
  /** swap: sun.io paths relayed by /v1/ext/swap/quote, reference TRX/USD, allowance(owner, Permit2) */
  swapQuotes?: any[]; swapRef?: any; allowance?: bigint;
  /** 0.3.2: what sun.io answers the wallet directly (unset = the same paths as the relay) */
  sunio?: any[];
  /** 0.3.2: hello announces doc_service; false = an older Signer */
  docService?: boolean;
  /** price of GET /v1/ext/x402/quote (Direct products, energy-only send); unset → 404 */
  x402Quote?: string;
  /** server side: pause flag (hello, wallet.pause/resume) and GET /v1/ext/history items (request objects) */
  paused?: boolean; history?: any[];
  /** 0.2.1: GET /v1/ext/requests/{id} */
  requestsById?: Record<string, any>;
  /** EVM: per chain id — native wei, USDC/USDT micro of the account, allowance to TokenMessengerV2, nonce,
   *  code at the account, base fee / priority (wei); Iris fees relayed by /v1/ext/bridge/fees */
  evm?: { native: Record<number, bigint>; usdc: Record<number, bigint>; usdt?: Record<number, bigint>; allowance?: Record<number, bigint>; nonce?: Record<number, number>; code?: string; baseFee?: bigint; prio?: bigint };
  bridgeFees?: any[];
  /** 0.3.13: OAuth consents by user code (what oauth.consent.get answers) and the decisions received (signature checked) */
  oauth?: { consents: Record<string, any>; decided?: { m: any; text: string; sig_ok: boolean }[] };
  /** the Signer's E2E mode in hello (unset = an old Signer without E2E) */
  e2eMode?: 'on' | 'required' | 'off';
  /** direct reads (E2E: /wallet/<method> = the TRON node, /rpc/<chain> = EVM RPC) and the x402 gateway (/gw/…) */
  direct?: { tron: any[]; evm: any[] };
  relay?: any[];
  /** 0.3.3 (attack scenarios): hold the ack of agent.create; stay silent on the next N request.sign */
  delayCreateMs?: number; dropSignAck?: number;
  /** 0.3.3: proof of work at registration: bits for a root pair without a wallet; refuse the next N verifies */
  pow?: { bits: number; refuseNext?: number }; verifies?: any[];
  /** 0.3.4: invite-only registration — the valid code (single use) or a closed Signer; a blocked wallet */
  registration?: { mode: 'invite' | 'closed' | 'open'; code?: string; used?: boolean }; blocked?: boolean; wsAuths?: number;
  /** 0.3.3: what the direct node / RPC says about a txid (gettransactioninfobyid, eth_getTransactionReceipt):
   *  in a block once the mock pushed a `confirmed` job update with it (as a real chain would have it); `missing` — never
   *  found, `failed` — in a block, failed */
  chain?: { missing?: string[]; failed?: string[]; /** 0.3.12: in a block (successful) whatever the job updates said */ ok?: string[] };
  /** 0.3.12: eth_getLogs answers per chain (filtered by the request's topics and range) and the head block */
  logs?: Record<number, any[]>; head?: number;
  /** 0.3.12: relay paths answered 403 METHOD_NOT_ALLOWED (an older Signer), e.g. '/v1/ext/net/tron/gettransactioninfobyid' */
  refuse?: string[];
  gw?: { calls: any[]; sendStatus?: number; energyStatus?: string; /** 0.3.1: paid tron/send answers 202 processing; payments/{id} answers this */ sendProcessing?: boolean; payState?: any };
}

export async function startMockSigner(st: MockState) {
  const received: any[] = [];
  const docs: any[] = [];
  let sockets: WebSocket[] = [];
  let walletRoot: { tron: string; evm: string } | null = null;
  const challenges = new Map<string, { message: string; tron: string; evm: string }>();
  let agentSeq = 0, rotSeq = 0;
  const waiters: ((m: any) => boolean)[] = [];
  const e2eSent: any[] = [];
  const jobs: any[] = [];
  const serverAgents: Record<string, ReturnType<typeof generateKeys>> = {};
  const onChain = new Set<string>();
  const noteChain = (m: any) => {
    if (m?.type !== 'e2e.job.update') return;
    const add = (t: unknown) => { if (typeof t === 'string') onChain.add(t.toLowerCase().replace(/^0x/, '')); };
    if (m.state === 'confirmed' || m.state === 'attested') add(m.txid);
    for (const x of m.job?.steps ?? []) if (x?.state === 'confirmed' || x?.state === 'attested') add(x.txid);
  };

  const server: Server = createServer(async (req, res) => {
    const body = await new Promise<string>((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
    const j = body ? JSON.parse(body) : {};
    const send = (code: number, x: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(x)); };
    const url = new URL(req.url!, 'http://x');
    const host = req.headers.host!;
    if (url.pathname === '/v1/ext/auth/challenge') {
      const nonce = 'N'.repeat(21) + String(challenges.size % 10);
      const iat = new Date(Date.now() - 1000).toISOString().replace(/\.\d+Z$/, 'Z');
      const exp = new Date(Date.now() + 299_000).toISOString().replace(/\.\d+Z$/, 'Z');
      const message = expectedChallenge({ host, extensionId: j.extension_id, tron: j.tron_address, evm: getAddress(j.evm_address), nonce, issuedAt: iat, expiresAt: exp });
      const isNew = !walletRoot || walletRoot.tron !== j.tron_address;
      const regMode = st.registration?.mode ?? 'open';
      const pow = st.pow && isNew && regMode === 'open' ? { alg: 'sha256', bits: st.pow.bits, salt: randomBytes(16).toString('hex'), expires_at: exp } : undefined;
      const registration = st.registration && isNew ? { mode: regMode, invite_required: regMode === 'invite' } : undefined;
      challenges.set(nonce, { message, tron: j.tron_address, evm: getAddress(j.evm_address), pow } as any);
      return send(200, { nonce, message, expires_at: exp, ...(pow ? { pow } : {}), ...(registration ? { registration } : {}) });
    }
    if (url.pathname === '/v1/ext/auth/verify') {
      const c = challenges.get(j.nonce);
      if (!c) return send(400, { error: { code: 'BAD_NONCE' } });
      challenges.delete(j.nonce);
      (st.verifies ??= []).push(j);
      const pw = (c as any).pow;
      if (pw) {
        if (st.pow?.refuseNext) { st.pow.refuseNext--; return send(401, { error: { code: 'POW_INVALID', message: 'test: refused' } }); }
        if (typeof j.pow_nonce !== 'string') return send(401, { error: { code: 'POW_REQUIRED', message: 'pow_nonce' } });
        const h = createHash('sha256').update(`${pw.salt}:${j.nonce}:${j.pow_nonce}`).digest();
        let z = 0; for (const b of h) { if (b === 0) { z += 8; continue; } z += Math.clz32(b) - 24; break; }
        if (!/^(0|[1-9][0-9]{0,19})$/.test(j.pow_nonce) || z < pw.bits) return send(401, { error: { code: 'POW_INVALID', message: 'not enough zero bits' } });
      }
      const t = await recoverTronMessage(c.message, j.sig_tron), e = await recoverEvmMessage(c.message, j.sig_evm);
      if (t !== c.tron || e !== c.evm) return send(401, { error: { code: 'UNAUTHORIZED', message: 'bad signature' } });
      const isNew = !walletRoot;
      if (!isNew && st.blocked) return send(403, { error: { code: 'WALLET_BLOCKED', message: 'blocked' } });
      if (isNew && st.registration?.mode === 'closed') return send(403, { error: { code: 'REGISTRATION_CLOSED', message: 'closed' } });
      if (isNew && st.registration?.mode === 'invite') {
        if (typeof j.invite !== 'string' || !j.invite) return send(403, { error: { code: 'INVITE_REQUIRED', message: 'invite' } });
        if (j.invite !== st.registration.code || st.registration.used) return send(403, { error: { code: 'INVITE_INVALID', message: 'invite' } });
        st.registration.used = true;
      }
      walletRoot = { tron: c.tron, evm: c.evm };
      return send(200, { session: 'agws_test', wallet_id: 'wal_test', expires_at: new Date(Date.now() + 86400_000).toISOString(), new_wallet: isNew });
    }
    // 0.3.2: sun.io itself (the wallet's direct second opinion) — the same paths unless st.sunio overrides
    if (url.pathname === '/sunio') {
      const amt = url.searchParams.get('amountIn'), from = url.searchParams.get('fromToken');
      const qs = (st.sunio ?? st.swapQuotes ?? []).filter((p: any) => p.amountInRaw === amt && p.tokens[0] === from);
      return send(200, { code: 0, message: 'SUCCESS', data: qs });
    }
    // ---- E2E: direct node / RPC (not the Signer) and our x402 gateway ----
    if (url.pathname.startsWith('/wallet/')) { (st.direct ??= { tron: [], evm: [] }).tron.push({ method: url.pathname.slice(8), body: j }); return send(200, tron(url.pathname.slice(8), j)); }
    const rpcM = url.pathname.match(/^\/rpc\/(\d+)$/);
    if (rpcM && st.evm) { (st.direct ??= { tron: [], evm: [] }).evm.push({ chain: Number(rpcM[1]), method: j.method, params: j.params }); return send(200, { jsonrpc: '2.0', id: j.id, ...evmRpc(Number(rpcM[1]), j.method, j.params ?? []) }); }
    if (url.pathname.startsWith('/gw/')) {
      const g = (st.gw ??= { calls: [] });
      const path = url.pathname.slice(3).replace(/^\/x402\/v1/, '');
      g.calls.push({ path, body: j, sig: req.headers['payment-signature'] ?? null, method: req.method });
      if (path === '/tron/estimate') {
        const toNew = j.trx_transfer && !acc(j.trx_transfer.to).exists;
        return send(200, { estimate: { energy: st.energyUsed, receiver_activated: !toNew }, buyable: true, cover: { energy: st.energyUsed, price_usdc: st.coverPrice } });
      }
      if (path === '/quote') return st.x402Quote ? send(200, { product: url.searchParams.get('product'), price_usdc: st.x402Quote }) : send(404, { error: { code: 'NOT_FOUND' } });
      const pm = path.match(/^\/payments\/(.+)$/);
      if (pm) return send(200, g.payState ?? { payment_id: pm[1], status: 'DELIVERED' });
      if (['/tron/send', '/tron/energy', '/tron/activate', '/tron/bandwidth'].includes(path)) {
        if (!req.headers['payment-signature']) {
          const raw = Buffer.from(JSON.stringify({ x402Version: 2, resource: { url: `http://127.0.0.1:9975/x402/v1${path}` },
            accepts: [{ scheme: 'exact', network: 'eip155:8453', amount: path === '/tron/send' ? '480000' : '300000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: '0x16dDE7b0A9b092c4Dd985af5D9Ca04e389b3c87E', maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } }] })).toString('base64');
          res.writeHead(402, { 'Content-Type': 'application/json', 'PAYMENT-REQUIRED': raw }); return res.end('{}');
        }
        if (path === '/tron/send' && g.sendProcessing) { res.writeHead(202, { 'Content-Type': 'application/json', 'Retry-After': '5' }); return res.end(JSON.stringify({ status: 'processing', payment_status: 'settling', payment_id: 'pay_send1', status_url: 'https://gw.example/x402/v1/payments/pay_send1', retry_after: 5 })); }
        if (path === '/tron/send') return send(g.sendStatus ?? 200, { status: 'confirmed', txid: 'from-gw', payment_id: 'pay_send1' });
        if (path === '/tron/energy') { const a = st.accounts[j.address]; if (a) a.energy += Number(j.amount); return send(200, { status: g.energyStatus ?? 'DELIVERED', payment_id: 'pay_en1' }); }
        return send(200, { status: 'DELIVERED', payment_id: 'pay_x' });
      }
      return send(404, { error: { code: 'NOT_FOUND' } });
    }
    if (req.headers.authorization !== 'Bearer agws_test') return send(401, { error: { code: 'UNAUTHORIZED' } });
    (st.relay ??= []).push({ path: url.pathname, body: j, query: url.search });
    if (st.refuse?.includes(url.pathname)) return send(403, { error: { code: 'METHOD_NOT_ALLOWED', message: 'method not in the relay whitelist' } });
    if (url.pathname.startsWith('/v1/ext/net/tron/')) return send(200, tron(url.pathname.split('/').pop()!, j));
    const evmM = url.pathname.match(/^\/v1\/ext\/net\/evm\/(\d+)$/);
    if (evmM && st.evm) return send(200, { jsonrpc: '2.0', id: j.id, ...evmRpc(Number(evmM[1]), j.method, j.params ?? []) });
    if (url.pathname === '/v1/ext/bridge/fees') return send(200, { source: 'iris', src_domain: 3, dst_domain: 6, fetched_at: new Date().toISOString(),
      fees: st.bridgeFees ?? [{ finalityThreshold: 1000, minimumFee: 1.4, forwardFee: { low: 53312, med: 55107, high: 56440 } }, { finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: 53312, med: 55107, high: 56440 } }] });
    if (url.pathname === '/v1/ext/net/evm/8453') {
      if (j.method === 'eth_call') return send(200, { jsonrpc: '2.0', id: j.id, result: '0x' + st.usdcMicro.toString(16).padStart(64, '0') });
      if (j.method === 'eth_getBalance') return send(200, { jsonrpc: '2.0', id: j.id, result: '0x0' });
      return send(200, { jsonrpc: '2.0', id: j.id, error: { message: 'method not allowed' } });
    }
    if (url.pathname === '/v1/ext/swap/quote') {
      const amt = url.searchParams.get('amount_in_raw');
      const qs = (st.swapQuotes ?? []).filter((p) => p.amountInRaw === amt && p.symbols[0] === url.searchParams.get('asset_in'));
      return send(200, { schema_version: '1', source: 'sun.io', fetched_at: new Date().toISOString(), quotes: qs, best: qs.length ? 0 : null });
    }
    if (url.pathname.startsWith('/v1/ext/requests/')) {
      const r = st.requestsById?.[decodeURIComponent(url.pathname.slice('/v1/ext/requests/'.length))];
      return r ? send(200, r) : send(404, { error: { code: 'NOT_FOUND', message: 'no such request' } });
    }
    if (url.pathname === '/v1/ext/history') {
      const items = (st.history ?? []).map((r) => ({ kind: 'request', at: r.created_at, request: r }));
      return send(200, { items: items.slice(0, Number(url.searchParams.get('limit') ?? 50)), next_cursor: null, paused: !!st.paused });
    }
    if (url.pathname === '/v1/ext/swap/reference') return send(200, st.swapRef ?? { pair: 'TRXUSD', price_usd: '0.3087', source: 'binance', as_of: new Date().toISOString(), stale: false });
    if (url.pathname === '/v1/ext/x402/quote' && st.x402Quote) return send(200, { product: url.searchParams.get('product'), price_usdc: st.x402Quote });
    if (url.pathname === '/v1/ext/x402/estimate') {
      if (!st.coverPrice) return send(503, { error: { code: 'PRICE_UNAVAILABLE' } });
      const toNew = j.trx_transfer && !acc(j.trx_transfer.to).exists;
      // cover.price_usdc is the full tron/send price incl. a new recipient and bandwidth
      return send(200, { estimate: { energy: st.energyUsed, receiver_activated: !toNew }, buyable: true,
        cover: { energy: st.energyUsed, price_usdc: st.coverPrice, ...(toNew ? { activate_receiver: true, activate_receiver_trx: 1.1, activate_receiver_usdc: '0.339790', bandwidth: 269, bandwidth_usdc: '0.083095' } : {}) } });
    }
    send(404, { error: { code: 'NOT_FOUND' } });
  });

  const TOKENS: Record<number, { USDC: string; USDT?: string }> = {
    1: { USDC: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', USDT: '0xdac17f958d2ee523a2206206994597c13d831ec7' },
    42161: { USDC: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', USDT: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9' },
    10: { USDC: '0x0b2c639c533813f4aa9d7837caf62653d097ff85', USDT: '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58' },
    137: { USDC: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', USDT: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f' },
    8453: { USDC: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
  };
  const hex = (v: bigint | number) => '0x' + BigInt(v).toString(16);
  function evmRpc(chain: number, method: string, p: any[]): { result: any } | { error: { message: string } } {
    const e = st.evm!;
    switch (method) {
      case 'eth_getBalance': return { result: hex(e.native[chain] ?? 0n) };
      case 'eth_getTransactionCount': return { result: hex(e.nonce?.[chain] ?? 5) };
      case 'eth_getBlockByNumber': {
        const n = typeof p[0] === 'string' && /^0x/.test(p[0]) ? Number.parseInt(p[0], 16) : 0x10;
        const head = st.head ?? 0x10;
        return { result: { number: hex(n), baseFeePerGas: hex(e.baseFee ?? 1_000_000_000n), timestamp: hex(Math.floor(Date.now() / 1000) - Math.max(0, head - n) * 2) } };
      }
      case 'eth_blockNumber': return { result: hex(st.head ?? 0x10) };
      case 'eth_getLogs': {
        const f = p[0] ?? {}, from = Number.parseInt(f.fromBlock, 16), to = Number.parseInt(f.toBlock, 16);
        const addrs: string[] = (Array.isArray(f.address) ? f.address : [f.address]).map((x: string) => String(x).toLowerCase());
        const match = (want: unknown, got: string) => want === null || want === undefined || (Array.isArray(want) ? want.map((x) => String(x).toLowerCase()).includes(got) : String(want).toLowerCase() === got);
        const out = (st.logs?.[chain] ?? []).filter((l) => { const b = Number.parseInt(l.blockNumber, 16); return b >= from && b <= to && addrs.includes(String(l.address).toLowerCase())
          && (f.topics ?? []).every((w: unknown, i: number) => match(w, String(l.topics[i] ?? '').toLowerCase())); });
        return { result: out };
      }
      case 'eth_maxPriorityFeePerGas': return { result: hex(e.prio ?? 1_000_000n) };
      case 'eth_getCode': return { result: e.code ?? '0x' };
      case 'eth_chainId': return { result: hex(chain) };
      case 'eth_getTransactionReceipt': {
        const id = String(p[0] ?? '').toLowerCase();
        if (st.chain?.missing?.some((x) => x.toLowerCase() === id) || (!onChain.has(id.replace(/^0x/, '')) && !st.chain?.ok?.some((x) => x.toLowerCase().replace(/^0x/, '') === id.replace(/^0x/, '')))) return { result: null };
        return { result: { transactionHash: id, blockNumber: '0x11', status: st.chain?.failed?.some((x) => x.toLowerCase() === id) ? '0x0' : '0x1' } };
      }
      case 'eth_estimateGas': {
        const d: string = p[0]?.data ?? '0x';
        if ((d.startsWith('0x8e0250ee') || d.startsWith('0x779b432d')) && (e.allowance?.[chain] ?? 0n) < BigInt('0x' + d.slice(10, 74))) return { error: { message: 'execution reverted: ERC20: transfer amount exceeds allowance' } };
        return { result: hex(d === '0x' ? 21_000 : 90_000) };
      }
      case 'eth_call': {
        const to = String(p[0]?.to ?? '').toLowerCase(), d: string = p[0]?.data ?? '';
        if (d.startsWith('0xdd62ed3e')) return { result: '0x' + (e.allowance?.[chain] ?? 0n).toString(16).padStart(64, '0') };
        if (d.startsWith('0x70a08231')) {
          const v = to === TOKENS[chain]?.USDC ? e.usdc[chain] ?? 0n : to === TOKENS[chain]?.USDT ? e.usdt?.[chain] ?? 0n : 0n;
          return { result: '0x' + v.toString(16).padStart(64, '0') };
        }
        return { error: { message: 'unknown call' } };
      }
      default: return { error: { message: 'method not allowed' } };
    }
  }

  function acc(a: string) { return st.accounts[a] ?? { exists: false, balanceSun: 0, energy: 0, freeNet: 0, usdt: 0n }; }
  function tron(method: string, j: any): any {
    switch (method) {
      case 'getnowblock': return { blockID: '0000000004b8a1c2abcdef012345678900112233445566778899aabbccddeeff', block_header: { raw_data: { number: 79208898, timestamp: Date.now() } } };
      case 'getaccount': { const a = acc(j.address); return a.exists ? { address: j.address, balance: a.balanceSun } : {}; }
      case 'getaccountresource': { const a = acc(j.address); return a.exists ? { freeNetLimit: a.freeNet, freeNetUsed: 0, EnergyLimit: a.energy, EnergyUsed: 0 } : {}; }
      case 'getchainparameters': return { chainParameter: [{ key: 'getEnergyFee', value: 210 }] };
      case 'gettransactioninfobyid': {
        const id = String(j.value ?? '').toLowerCase();
        if (st.chain?.missing?.some((x) => x.toLowerCase() === id) || (!onChain.has(id.replace(/^0x/, '')) && !st.chain?.ok?.some((x) => x.toLowerCase().replace(/^0x/, '') === id.replace(/^0x/, '')))) return {};
        if (st.chain?.failed?.some((x) => x.toLowerCase() === id)) return { id, blockNumber: 79208899, result: 'FAILED', receipt: { result: 'REVERT' } };
        return { id, blockNumber: 79208899, receipt: {} };
      }
      case 'triggerconstantcontract':
        if (j.function_selector === 'balanceOf(address)') {
          const who = Object.keys(st.accounts).find((k) => tronToHex41(k).slice(2) === j.parameter.slice(24));
          return { result: { result: true }, constant_result: [(who ? st.accounts[who].usdt : 0n).toString(16).padStart(64, '0')] };
        }
        if (j.function_selector === 'allowance(address,address)') return { result: { result: true }, constant_result: [(st.allowance ?? 0n).toString(16).padStart(64, '0')] };
        if (j.function_selector === 'allowance(address,address,address)') return { result: { result: true }, constant_result: ['0'.repeat(192)] };
        return { result: { result: true }, energy_used: st.energyUsed, constant_result: [''] };
      case 'getcontract': return j.value === 'TQqgNg13s2DjvXhW1ky4v6TsR8wZGvb7Y4'
        ? { name: 'UniversalRouter', origin_address: 'TU3rMHyWHzeEJBReWLzHko728hbz6MtfNg', consume_user_resource_percent: 1, origin_energy_limit: 1_000_000 }
        : { name: 'Token', origin_address: 'TU3rMHyWHzeEJBReWLzHko728hbz6MtfNg', consume_user_resource_percent: 100 };
      default: return { Error: 'not allowed' };
    }
  }

  const wss = new WebSocketServer({ server, path: '/v1/ext/ws' });
  wss.on('connection', (ws, upgrade) => {
    const wsHost = upgrade.headers.host;
    let authed = false;
    sockets.push(ws);
    ws.on('close', () => { sockets = sockets.filter((s) => s !== ws); });
    ws.on('message', async (raw) => {
      const m = JSON.parse(String(raw));
      if (!authed) {
        st.wsAuths = (st.wsAuths ?? 0) + 1;
        if (m.type === 'auth' && st.blocked) { ws.send(JSON.stringify({ type: 'ack', ok: false, error: { code: 'WALLET_BLOCKED', message: 'blocked' } })); return ws.close(4403, 'wallet blocked'); }
        if (m.type !== 'auth' || m.session !== 'agws_test') return ws.close(4401);
        authed = true;
        ws.send(JSON.stringify({ type: 'hello', id: 'h1', server_time: new Date().toISOString(), wallet_id: 'wal_test', wallet_doc_version_seen: docs.at(-1)?.doc.version ?? 0, paused: !!st.paused, ...(st.docService !== false ? { doc_service: true } : {}),
          ...(st.e2eMode ? { e2e: { mode: st.e2eMode, limits: { max_envelope: 65536 }, ...(st.oauth ? { oauth: true } : {}) } } : {}),
          networks: [{ network: 'tron' }, { network: 'evm:8453', chain_id: 8453, tokens: [{ symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 }] }, { network: 'evm:999', chain_id: 999 }] }));
        ws.send(JSON.stringify({ type: 'request.list', id: 'l1', requests: [] }));
        return;
      }
      received.push(m);
      for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i](m)) waiters.splice(i, 1);
      const ack = (extra: object = {}) => ws.send(JSON.stringify({ type: 'ack', id: m.id, ok: true, ...extra }));
      const nack = (code: string, message: string) => ws.send(JSON.stringify({ type: 'ack', id: m.id, ok: false, error: { code, message } }));
      switch (m.type) {
        case 'wallet.sync': {
          const digest = m.doc?.mode === 'e2e' ? e2eDocDigest(m.doc) : docDigest(m.doc);
          if (st.e2eMode === 'required' && m.doc?.mode !== 'e2e') return nack('E2E_REQUIRED', 'e2e document required');
          if (digest !== m.digest) return nack('BAD_DIGEST', 'digest');
          // 0.3.2: the document names this Signer (as the Signer checks it: Service = the host it serves)
          if (m.doc.service !== undefined && m.doc.service !== wsHost) return nack('BAD_DOC', 'doc.service');
          if (st.docService !== false && m.doc.service === undefined) return nack('BAD_DOC', 'test: a 0.3.2 extension names this Signer');
          const text = docSignText(m.doc.wallet_id, m.doc.version, digest, m.doc.service);
          if ((await recoverEvmMessage(text, m.sig_evm)) !== walletRoot!.evm || (await recoverTronMessage(text, m.sig_tron)) !== walletRoot!.tron) return nack('BAD_SIGNATURE', 'sig');
          if (docs.length && m.doc.version <= docs.at(-1).doc.version) return nack('STALE_VERSION', 'version');
          docs.push(m);
          return ack();
        }
        case 'agent.create': {
          if (st.delayCreateMs) await new Promise((r) => setTimeout(r, st.delayCreateMs));
          agentSeq++;
          const id = `ag_t${agentSeq}`;
          if (m.key_mode === 'server') { const k = generateKeys(); serverAgents[id] = k; return ack({ agent: { id, name: m.name }, token: `aw_${id}_${'A'.repeat(52)}`, agent_keys: { bundle: bundleOf(k), fp: fingerprint(k.sig, k.kex) } }); }
          return ack({ agent: { id, name: m.name }, token: `aw_${id}_${'A'.repeat(52)}` });
        }
        case 'oauth.consent.get': {
          const c = st.oauth?.consents[m.user_code];
          if (!c) return nack('CONSENT_NOT_FOUND', 'no such code');
          if (c.wallet && c.wallet !== 'wal_test') return nack('CONSENT_TAKEN', 'taken');
          c.wallet = 'wal_test';
          return ack({ consent: c.view });
        }
        case 'oauth.consent.decide': {
          const c = Object.values(st.oauth?.consents ?? {}).find((x: any) => x.view.id === m.consent_id) as any;
          if (!c || c.wallet !== 'wal_test') return nack('CONSENT_NOT_FOUND', 'no such consent');
          const text = consentSignText({ service: wsHost!, wallet_id: 'wal_test', consent_id: c.view.id, client_id: c.view.client.id, redirect_uri: c.view.redirect_uri,
            scope: c.view.scope, decision: m.decision, accounts: m.accounts ?? [], types: m.allowed_types ?? [] });
          const sig_ok = (await recoverEvmMessage(text, m.sig_evm)) === walletRoot!.evm && (await recoverTronMessage(text, m.sig_tron)) === walletRoot!.tron;
          (st.oauth!.decided ??= []).push({ m, text, sig_ok });
          if (!sig_ok) return nack('BAD_SIGNATURE', 'sig');
          if (m.decision === 'deny') return ack({});
          agentSeq++;
          const id = `ag_c${agentSeq}`;
          const k = generateKeys(); serverAgents[id] = k;
          return ack({ agent: { id, name: `cloud-${agentSeq}` }, agent_keys: { bundle: bundleOf(k), fp: fingerprint(k.sig, k.kex), mode: 'server' },
            cloud: { client_id: c.view.client.id, client_name: c.view.client.name, redirect_host: c.view.redirect_host } });
        }
        case 'e2e.send': e2eSent.push(m.envelope); return ack({ seq: e2eSent.length });
        case 'e2e.ack': return ack();
        case 'e2e.job': jobs.push(m.job); return ack({ job_id: m.job.job_id, job: { ...m.job, state: 'running' } });
        case 'agent.list': return ack({ agents: (st as any).agentList ?? [], ...((st as any).cloudList ? { cloud: (st as any).cloudList } : {}) });
        case 'agent.revoke': return ack();
        case 'agent.rotate': {
          rotSeq++; const pre = `aw_${m.agent_id}_R${rotSeq}`;
          const keys = m.key_mode === 'server' ? (() => { const k = generateKeys(); serverAgents[m.agent_id] = k; return { agent_keys: { bundle: bundleOf(k), fp: fingerprint(k.sig, k.kex) } }; })() : {};
          return ack({ agent: { id: m.agent_id, token_prefix: pre.slice(0, pre.length) }, token: `${pre}${'B'.repeat(50)}`, ...keys });
        }
        case 'own.swap': return ack({ request_id: 'awr_swap1', request: { request_id: 'awr_swap1', status: 'signed' } });
        case 'wallet.pause': st.paused = m.paused !== false; return ack({ paused: st.paused, rejected: 1 });
        case 'wallet.resume': st.paused = false; return ack({ paused: false, rejected: 0 });
        case 'own.bridge': return ack({ request_id: 'awr_ownb1', request: { request_id: 'awr_ownb1', status: 'signed' } });
        case 'own.refuel': return ack({ request_id: 'awr_ownr1', request: { request_id: 'awr_ownr1', status: 'signed' } });
        case 'own.resource': return ack({ request_id: 'awr_res1', request: { request_id: 'awr_res1', status: 'signed' } });
        case 'request.sign': if (st.dropSignAck) { st.dropSignAck--; return; } // falls through
        case 'request.reject': case 'request.pay_signed': case 'own.submit': case 'state': case 'request.seen':
          return m.id ? ack(m.type === 'own.submit' ? { request: { request_id: 'awr_own1' } } : {}) : undefined;
        default: if (m.id) ack();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;
  return {
    url: `http://127.0.0.1:${port}`, received, docs, e2eSent, jobs, serverAgents,
    push: (m: object) => { noteChain(m); for (const s of sockets) s.send(JSON.stringify(m)); },
    /** the operator blocks the wallet — wallet.blocked, then close 4403 (as the Signer does at the next ping) */
    block: () => { st.blocked = true; for (const s of sockets) { s.send(JSON.stringify({ type: 'wallet.blocked', error: { code: 'WALLET_BLOCKED', message: 'blocked' } })); s.close(4403, 'wallet blocked'); } },
    /** forget the registered wallet (the next sign-in registers again) */
    forget: () => { walletRoot = null; },
    next: (pred: (m: any) => boolean, ms = 10_000) => new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('mock: timeout waiting for a message')), ms);
      waiters.push((m) => { if (pred(m)) { clearTimeout(t); resolve(m); return true; } return false; });
    }),
    close: async () => { for (const s of sockets) s.close(); wss.close(); await new Promise((r) => server.close(r)); },
  };
}
