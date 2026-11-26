// «Operation page» (0.2.1): one request (transfer, swap, bridge, refuel, resource purchase, agent
// requests) as a human sees it — a title in words, who started it, the status in big letters and a timeline of steps
// with their state, time, short tx hash + explorer link, fee and amount; for a bridge: burned, fee, «you get».
// Pure: built from the request object the Signer sends (request.update carries it whole).
import { fmtAmount } from './portfolio';
import { shortAddr } from './similar';
import { t } from '../i18n';

export const NET_NAMES: Record<string, string> = { tron: 'TRON', 'evm:1': 'Ethereum', 'evm:42161': 'Arbitrum', 'evm:10': 'Optimism', 'evm:137': 'Polygon', 'evm:8453': 'Base', 'evm:56': 'BNB Chain', 'evm:43114': 'Avalanche' };
export const netLabel = (n?: string) => (n ? NET_NAMES[n] ?? n : '');

const EXPLORERS: Record<string, string> = {
  tron: 'https://tronscan.org/#/transaction/', 'evm:1': 'https://etherscan.io/tx/', 'evm:42161': 'https://arbiscan.io/tx/', 'evm:10': 'https://optimistic.etherscan.io/tx/',
  'evm:137': 'https://polygonscan.com/tx/', 'evm:8453': 'https://basescan.org/tx/', 'evm:56': 'https://bscscan.com/tx/', 'evm:43114': 'https://snowtrace.io/tx/',
};
export function explorerTx(network: string | undefined, hash: string | undefined): string | null {
  if (!network || !hash || !/^(0x)?[0-9a-fA-F]{64}$/.test(hash)) return null; // a hash, nothing else in the URL
  const b = EXPLORERS[network];
  if (!b) return null;
  return b + (network === 'tron' ? hash.replace(/^0x/, '') : hash.startsWith('0x') ? hash : `0x${hash}`);
}

export type StepState = 'waiting' | 'active' | 'done' | 'error';
export interface OpStep {
  key: string; title: string; state: StepState; note?: string;
  network?: string; tx?: { hash: string; short: string; url: string | null }; fee?: string; amount?: string;
  eta?: string; error?: string;
}
export interface OpView {
  request_id: string; type: string; title: string; subtitle?: string; initiator: string; reason?: string;
  /** started by the human (no agent): the page says «your operation» without comparing words */
  own: boolean;
  /** 0.3.13: started by a cloud agent of a chat app (the Signer sees its requests) */
  cloud?: boolean;
  status: string; status_label: string; tone: 'ok' | 'bad' | 'warn' | 'info'; final: boolean;
  created_at?: string; finished_at?: string;
  steps: OpStep[]; facts: { k: string; v: string }[];
  /** «step 3 of 4 · waiting for Circle» for lists (multi-step only) */
  progress?: string;
  account?: string;
  /** main asset and its network (logo next to the title) */
  asset?: string; network?: string;
}

// 0.3.3: `unknown` (missing from one request.list) is not a decision — the request may come back
const FINAL = new Set(['confirmed', 'failed', 'rejected', 'expired', 'cancelled']);
const ERR = new Set(['failed', 'rejected', 'expired', 'cancelled']);
export const isFinal = (status?: string) => FINAL.has(String(status));

/** Request (or step) status → step state. */
function stateOf(status?: string): StepState {
  if (status === 'confirmed') return 'done';
  if (status && ERR.has(status)) return 'error';
  if (status === 'signed' || status === 'broadcast') return 'active';
  return 'waiting';
}

function txOf(tx: any, network?: string): OpStep['tx'] | undefined {
  const hash = tx?.tx_id ?? tx?.txID ?? tx?.hash;
  if (!hash || typeof hash !== 'string') return undefined;
  return { hash, short: hash.length > 16 ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : hash, url: explorerTx(network, hash) };
  // 0.3.2: the server's explorer_url is never used — the link is built from our own explorer list only
}

function feeOf(tx: any, network?: string): string | undefined {
  const f = tx?.fee;
  if (!f) return undefined;
  if (typeof f === 'string') return f;
  const native = f.native ?? f.burned_trx;
  if (native == null || native === '' || native === '0') return undefined;
  const sym = network === 'tron' ? 'TRX' : network === 'evm:137' ? 'POL' : 'ETH';
  return `${fmtAmount(String(native))} ${sym}`;
}

const errText = (e: any) => (e ? [e.code, e.message].filter(Boolean).join(': ') : undefined);

/** Expected times, honest and approximate. */
function attestEta(mode: string | undefined, from: string | undefined): string {
  if (mode === 'fast') return t('op.eta.fast');
  if (from === 'evm:137') return t('op.eta.polygon');
  return t('op.eta.ethereum');
}
function refuelEta(to: string | undefined): string { return to === 'evm:42161' ? t('op.eta.arbitrum') : t('op.eta.l2'); }

function bridgeSteps(r: any): { steps: OpStep[]; facts: OpView['facts'] } {
  const i = r.intent ?? {}, b = r.bridge ?? {};
  const from = b.from_network ?? i.from_network, to = b.to_network ?? i.to_network;
  const list: any[] = Array.isArray(b.steps) ? b.steps : [];
  const find = (s: string) => list.find((x) => x?.step === s);
  const steps: OpStep[] = [];
  const st = String(b.state ?? '');
  const approve = find('approve');
  if (approve) steps.push({ key: 'approve', title: t('op.step.approveUsdc', { net: netLabel(from) }), network: from, state: stateOf(approve.status), tx: txOf(approve.tx, from), fee: feeOf(approve.tx, from), error: errText(approve.error) });
  const burn = find('burn');
  const burnState = burn ? stateOf(burn.status) : (st === 'approving' || st === 'burning' || !st || st === 'pending') ? (r.status === 'broadcast' ? 'active' : stateOf(r.status) === 'error' ? 'error' : 'waiting') : 'done';
  steps.push({ key: 'burn', title: t('op.step.burn', { amount: b.burn_amount ? fmtAmount(String(b.burn_amount)) + ' ' : '', net: netLabel(from) }), network: from, state: burnState, tx: txOf(burn?.tx, from), fee: feeOf(burn?.tx, from), error: errText(burn?.error) });
  const attDone = ['attested', 'minting', 'awaiting_gas', 'forwarding', 'done'].includes(st) || b.attestation?.status === 'complete';
  const attState: StepState = attDone ? 'done' : st === 'attesting' ? 'active' : st === 'failed' && burnState === 'done' ? 'error' : burnState === 'done' ? 'active' : 'waiting';
  steps.push({ key: 'attest', title: t('op.step.attest'), state: attState, eta: attestEta(b.mode_effective ?? i.mode, from),
    note: attState === 'active' ? t('op.note.attest') : undefined });
  const mint = find('mint');
  const by = mint?.by ?? b.mint?.by ?? (b.delivery === 'forwarding' ? 'circle' : 'wallet');
  let mintState: StepState = mint ? stateOf(mint.status) : 'waiting';
  if (mint?.status === 'waiting') mintState = attDone ? 'active' : 'waiting';
  if (st === 'done') mintState = 'done';
  if (mintState === 'waiting' && attDone) mintState = 'active';
  const mintNote = st === 'awaiting_gas' ? t('op.note.awaitingGas', { net: netLabel(to) }) : st === 'forwarding' ? t('op.note.forwarding') : by === 'third_party' ? t('op.note.thirdParty') : undefined;
  steps.push({ key: 'mint', title: t('op.step.mint', { net: netLabel(to), by: by === 'circle' ? t('op.by.circle') : by === 'third_party' ? t('op.by.thirdParty') : t('op.by.wallet') }), network: to, state: mintState,
    tx: txOf(mint?.tx ?? (b.mint?.tx_id ? { tx_id: b.mint.tx_id, explorer_url: b.mint.explorer_url } : null), to), fee: feeOf(mint?.tx, to), note: mintNote, error: errText(mint?.error),
    amount: i.amount ? `+${fmtAmount(String(i.amount))} USDC` : undefined });
  const facts: OpView['facts'] = [];
  if (i.amount) facts.push({ k: t('op.fact.receive'), v: t('op.v.usdcIn', { amount: fmtAmount(String(i.amount)), net: netLabel(to) }) });
  if (b.burn_amount) facts.push({ k: t('op.fact.burn'), v: t('op.v.usdcIn', { amount: fmtAmount(String(b.burn_amount)), net: netLabel(from) }) });
  if (b.fee_executed != null) facts.push({ k: t('op.fact.circleFee'), v: `${fmtAmount(String(b.fee_executed))} USDC` });
  else if (b.max_fee) facts.push({ k: t('op.fact.circleFeeMax'), v: `${fmtAmount(String(b.max_fee))} USDC` });
  const mode = b.mode_effective ?? i.mode;
  if (mode) facts.push({ k: t('op.fact.mode'), v: mode === 'fast' ? t('op.mode.fast') : t('op.mode.standard') });
  facts.push({ k: t('op.fact.delivery'), v: by === 'circle' ? t('op.v.byCircle') : t('op.v.byWallet') });
  return { steps, facts };
}

function refuelSteps(r: any): { steps: OpStep[]; facts: OpView['facts'] } {
  const i = r.intent ?? {}, f = r.refuel ?? {};
  const to = f.to_network ?? i.to_network;
  const st = String(f.state ?? '');
  const depState: StepState = r.status === 'confirmed' || st === 'l2_pending' || st === 'credited' ? 'done' : stateOf(r.status) === 'error' ? 'error' : r.status === 'broadcast' || r.status === 'signed' ? 'active' : 'waiting';
  const amount = f.amount_eth ?? i.amount_eth;
  const steps: OpStep[] = [
    { key: 'deposit', title: t('op.step.deposit'), network: 'evm:1', state: depState, tx: txOf(r.tx, 'evm:1'), fee: feeOf(r.tx, 'evm:1'), amount: amount ? `${fmtAmount(String(amount))} ETH` : undefined, error: depState === 'error' ? errText(r.error) : undefined },
    { key: 'credit', title: t('op.step.credit', { net: netLabel(to) }), network: to, state: st === 'credited' ? 'done' : st === 'not_seen' ? 'error' : depState === 'done' ? 'active' : 'waiting',
      eta: refuelEta(to), note: st === 'not_seen' ? t('op.note.notSeen') : f.stuck ? t('op.note.stuck') : undefined,
      amount: amount ? `+${fmtAmount(String(amount))} ETH` : undefined },
  ];
  const facts: OpView['facts'] = [];
  if (amount) facts.push({ k: t('op.fact.amount'), v: `${fmtAmount(String(amount))} ETH` });
  if (f.l2_balance_seen) facts.push({ k: t('op.fact.balanceIn', { net: netLabel(to) }), v: `${fmtAmount(String(f.l2_balance_seen))} ETH` });
  return { steps, facts };
}

function swapSteps(r: any): { steps: OpStep[]; facts: OpView['facts'] } {
  const i = r.intent ?? {}, s = r.swap ?? {};
  const list: any[] = Array.isArray(s.steps) ? s.steps : [];
  const steps: OpStep[] = list.map((x) => ({ key: x.step, title: x.step === 'approve' ? t('op.step.swapApprove', { amount: fmtAmount(String(i.amount_in ?? '')), asset: i.asset_in ?? '' }) : t('op.step.swapSun'), network: 'tron',
    state: stateOf(x.status), tx: txOf(x.tx, 'tron'), fee: feeOf(x.tx, 'tron'), error: errText(x.error) }));
  if (!steps.length) steps.push({ key: 'swap', title: t('op.step.swapSun'), network: 'tron', state: stateOf(r.status), tx: txOf(r.tx, 'tron'), error: errText(r.error) });
  const facts: OpView['facts'] = [{ k: t('op.fact.give'), v: `${fmtAmount(String(i.amount_in ?? '?'))} ${i.asset_in ?? ''}` }];
  if (s.amount_out_min) facts.push({ k: t('op.fact.getMin'), v: `${fmtAmount(String(s.amount_out_min))} ${i.asset_out ?? ''}` });
  return { steps, facts };
}

function simpleSteps(r: any): { steps: OpStep[]; facts: OpView['facts'] } {
  const net = r.network ?? 'tron';
  const steps: OpStep[] = [];
  const res = r.resources;
  if (res && res.route && res.route !== 'none') {
    const rs = String(res.state ?? '');
    const state: StepState = rs === 'delivered' ? 'done' : rs === 'refunded' ? 'error' : ['planned', 'quoted', 'paid'].includes(rs) ? 'active' : r.status === 'confirmed' || r.status === 'broadcast' ? 'done' : stateOf(r.status) === 'error' ? 'error' : 'waiting';
    const refund = (Array.isArray(res.x402) ? res.x402 : []).map((p: any) => p?.refund).find((x: any) => x?.reason === 'activation_not_ours');
    const refundNote = refund ? (refund.activated_by_other?.includes('sender') && !refund.activated_by_other?.includes('receiver') ? t('op.note.refundSender') : t('op.note.refundReceiver')) : undefined;
    steps.push({ key: 'resources', title: t('op.step.resources', { route: res.route === 'proxy' ? 'Proxy' : 'Direct' }), network: 'tron', state, note: refundNote ?? (rs === 'paid' ? t('op.note.paid') : undefined),
      fee: res.cost_usdc ? `${fmtAmount(String(res.cost_usdc))} USDC` : undefined });
  }
  if (r.type !== 'tron_resource') {
    const sent = r.status === 'broadcast' || r.status === 'confirmed' || !!r.tx?.tx_id;
    steps.push({ key: 'send', title: t('op.step.send', { net: netLabel(net) }), network: net, state: sent ? 'done' : stateOf(r.status) === 'error' ? 'error' : r.status === 'signed' ? 'active' : 'waiting', tx: txOf(r.tx, net), error: stateOf(r.status) === 'error' && !sent ? errText(r.error) : undefined });
    steps.push({ key: 'confirm', title: t('op.step.confirm'), network: net, state: r.status === 'confirmed' ? 'done' : r.status === 'failed' && sent ? 'error' : sent ? 'active' : 'waiting', fee: feeOf(r.tx, net), error: r.status === 'failed' && sent ? errText(r.error) : undefined });
  } else if (!steps.length) {
    steps.push({ key: 'resources', title: t('op.step.resource'), network: 'tron', state: stateOf(r.status), error: errText(r.error) });
  }
  const i = r.intent ?? {};
  const facts: OpView['facts'] = [];
  if (i.amount != null && r.type !== 'tron_resource') facts.push({ k: t('op.fact.amount'), v: `${fmtAmount(String(i.amount))} ${i.asset ?? ''}` });
  if (i.to) facts.push({ k: t('op.fact.recipient'), v: String(i.to) });
  const rf = (Array.isArray(res?.x402) ? res.x402 : []).map((p: any) => p?.refund).find((x: any) => x?.reason);
  if (rf) {
    // gateway states: queued → (pending) → sent (tx) → confirmed; manual — by hand
    const st = String(rf.status ?? '');
    const word = st === 'confirmed' ? t('op.refund.confirmed') : st === 'sent' ? t('op.refund.sent') : st === 'manual' ? t('op.refund.manual') : t('op.refund.queued');
    const amount = rf.amount_usdc ? `${fmtAmount(String(rf.amount_usdc))} USDC` : '';
    steps.push({ key: 'refund', title: t('op.step.refund', { amount: amount ? ` · ${amount}` : '' }), network: 'evm:8453',
      state: st === 'confirmed' ? 'done' : 'active', note: t(rf.reason === 'activation_not_ours' ? 'op.note.refundNotOurs' : 'op.note.refund', { word }),
      tx: txOf(rf.tx ? { tx_id: rf.tx } : null, 'evm:8453'), amount: amount ? `+${amount}` : undefined });
    facts.push({ k: t('op.fact.refund'), v: `${amount || t('op.v.activationShare')}: ${word}` });
  }
  return { steps, facts };
}

function titleOf(r: any): { title: string; subtitle?: string } {
  const i = r.intent ?? {};
  switch (r.type) {
    case 'bridge': return { title: t('op.title.bridge', { amount: fmtAmount(String(i.amount ?? '?')), from: netLabel(i.from_network), to: netLabel(i.to_network) }) };
    case 'refuel': return { title: t('op.title.refuel', { amount: fmtAmount(String(i.amount_eth ?? '?')), to: netLabel(i.to_network) }) };
    case 'swap': return { title: t('op.title.swap', { amount: fmtAmount(String(i.amount_in ?? '?')), ain: i.asset_in ?? '', aout: i.asset_out ?? '' }) };
    case 'tron_resource': return { title: i.product === 'tron/activate' ? t('op.title.activate') : t(i.product === 'tron/bandwidth' ? 'op.title.buyBandwidth' : 'op.title.buyEnergy', { amount: fmtAmount(String(i.amount ?? '')) }) };
    case 'x402_pay': return { title: t('op.title.x402') };
    case 'transfer': return { title: t('op.title.transfer', { amount: fmtAmount(String(i.amount ?? '?')), asset: i.asset ?? '', to: i.to ? ` → ${shortAddr(String(i.to))}` : '' }), subtitle: t('op.subtitle.network', { net: netLabel(r.network) }) };
    default: return { title: TYPE_WORDS[r.type] ?? String(r.type ?? t('op.title.op')) };
  }
}

/** Human names of types (history never shows `bridge_step`). */
// getters: the words follow the UI language at the moment they are read
export const TYPE_WORDS: Record<string, string> = {
  get transfer() { return t('op.type.transfer'); }, get swap() { return t('op.type.swap'); }, get bridge() { return t('op.type.bridge'); },
  get refuel() { return t('op.type.refuel'); }, get x402_pay() { return t('op.type.x402_pay'); }, get tron_resource() { return t('op.type.tron_resource'); },
  get contract_call() { return t('op.type.contract_call'); }, get bridge_step() { return t('op.type.bridge_step'); }, get swap_step() { return t('op.type.swap_step'); },
};

const MULTI = new Set(['bridge', 'refuel', 'swap']);

/** The status in words; for a bridge / refuel on the way — what it waits for. */
function statusLabel(r: any, steps: OpStep[]): { label: string; tone: OpView['tone'] } {
  const s = String(r.status ?? '');
  if (s === 'confirmed') return { label: r.type === 'bridge' ? t('op.st.doneUsdc', { net: netLabel(r.intent?.to_network) }) : r.type === 'refuel' ? t('op.st.doneEth', { net: netLabel(r.intent?.to_network) }) : t('op.st.done'), tone: 'ok' };
  if (s === 'failed') return { label: t('op.st.failed', { code: r.error?.code ? `: ${r.error.code}` : '' }), tone: 'bad' };
  if (s === 'rejected') return { label: t('op.st.rejected'), tone: 'bad' };
  if (s === 'expired') return { label: t('op.st.expired'), tone: 'bad' };
  if (s === 'cancelled') return { label: t('op.st.cancelled'), tone: 'bad' };
  if (s === 'unknown') return { label: t('op.st.unknown'), tone: 'warn' };
  if (s === 'pending') return { label: t('op.st.pending'), tone: 'warn' };
  const cur = steps.find((x) => x.state === 'active');
  if (MULTI.has(r.type) && cur) return { label: t('op.st.onWay', { what: waitWords(r, cur) }), tone: 'info' };
  if (s === 'broadcast') return { label: t('op.st.broadcast'), tone: 'info' };
  return { label: t('op.st.signed'), tone: 'info' };
}
function waitWords(r: any, cur: OpStep): string {
  switch (cur.key) {
    case 'attest': return t('op.wait.circle');
    case 'mint': return r.bridge?.state === 'awaiting_gas' ? t('op.wait.gas', { net: netLabel(r.intent?.to_network) }) : t('op.wait.receive', { net: netLabel(r.intent?.to_network) });
    case 'credit': return t('op.wait.credit', { net: netLabel(r.intent?.to_network) });
    case 'approve': return t('op.wait.approve');
    case 'burn': return t('op.wait.burn');
    case 'deposit': return t('op.wait.deposit');
    case 'swap': return t('op.wait.swap');
    default: return cur.title.toLowerCase();
  }
}

function assetOf(r: any): { asset?: string; network?: string } {
  const i = r.intent ?? {};
  switch (r.type) {
    case 'bridge': return { asset: 'USDC', network: i.from_network };
    case 'refuel': return { asset: 'ETH', network: 'evm:1' };
    case 'swap': return { asset: i.asset_in, network: 'tron' };
    case 'transfer': return { asset: i.asset, network: r.network };
    case 'x402_pay': return { asset: 'USDC', network: r.network };
    default: return { network: r.network };
  }
}

export function buildOp(r: any): OpView {
  const kind = r.type === 'bridge' ? bridgeSteps(r) : r.type === 'refuel' ? refuelSteps(r) : r.type === 'swap' ? swapSteps(r) : simpleSteps(r);
  const { title, subtitle } = titleOf(r);
  const st = statusLabel(r, kind.steps);
  const n = kind.steps.length;
  const idx = kind.steps.findIndex((x) => x.state === 'active' || x.state === 'error');
  const progress = MULTI.has(r.type) && !isFinal(r.status) && r.status !== 'pending' && idx >= 0 ? t('op.progress', { i: idx + 1, n, what: waitWords(r, kind.steps[idx]) }) : undefined;
  return {
    request_id: r.request_id, type: r.type, title, subtitle, initiator: r.agent?.name ? t('op.initiator.agent', { name: r.agent.name }) : t('op.initiator.you'), own: !r.agent?.name, reason: r.reason || undefined,
    status: r.status, status_label: st.label, tone: st.tone, final: isFinal(r.status),
    created_at: r.created_at, finished_at: r.confirmed_at ?? (r.refuel?.credited_at || undefined),
    steps: kind.steps, facts: kind.facts, progress, account: r.account?.name, ...assetOf(r),
  };
}

/** «3 min ago» / «12 s». */
export function elapsed(fromIso: string | undefined, now = Date.now()): string {
  const at = fromIso ? Date.parse(fromIso) : NaN;
  if (!Number.isFinite(at)) return '';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return t('op.el.s', { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t('op.el.m', { n: m });
  return t('op.el.hm', { h: Math.floor(m / 60), m: m % 60 });
}

/** Notification when any operation is done (confirmed): a multi-step one in its own words, the others by their title. */
export function doneText(r: any): { title: string; message: string } | null {
  if (r?.status !== 'confirmed') return null;
  const f = finishText(r);
  if (f) return f;
  return { title: r.type === 'transfer' ? t('op.done.transfer') : r.type === 'tron_resource' ? t('op.done.resource') : t('op.done.op'), message: titleOf(r).title };
}

/** Notification when a multi-step operation ends. */
export function finishText(r: any): { title: string; message: string } | null {
  if (!MULTI.has(r.type) || !isFinal(r.status)) return null;
  const i = r.intent ?? {};
  if (r.status === 'confirmed') {
    if (r.type === 'bridge') return { title: t('op.fin.bridge'), message: t('op.fin.usdcArrived', { amount: fmtAmount(String(i.amount ?? '')), net: netLabel(i.to_network) }) };
    if (r.type === 'refuel') return { title: t('op.fin.refuel'), message: t('op.fin.ethArrived', { amount: fmtAmount(String(i.amount_eth ?? '')), net: netLabel(i.to_network) }) };
    return { title: t('op.fin.swap'), message: `${fmtAmount(String(i.amount_in ?? ''))} ${i.asset_in ?? ''} → ${i.asset_out ?? ''}` };
  }
  return { title: `${TYPE_WORDS[r.type]}: ${r.status === 'failed' ? t('op.fin.failed') : t('op.fin.stopped')}`, message: `${titleOf(r).title}${r.error?.code ? ` — ${r.error.code}` : ''}` };
}
