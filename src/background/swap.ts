// Swap in the service worker: quotes for the panel, building / signing of an agent's `swap` request and of the
// human's own swap (own.swap), approvals of the step payments (request.pay of a step carries parent_request_id + step).
import { formatUnits, parseUnits } from '../lib/amount';
import { randomId } from '../lib/bytes';
import { normalizeTron } from '../lib/tron/address';
import { decodeRaw } from '../lib/tron/tx';
import { LIMITS, swapConfig, type SwapAsset } from '../lib/swap/config';
import { amountOutMin, deviationBps, pickPath, rateText, routeLines } from '../lib/swap/quote';
import { prepareSwap, signSwap, stepResourcePlan, swapBlock, type PreparedSwap, type SwapIntent, type SignedStep } from '../lib/swap/prepare';
import { SignerSwapReader } from '../lib/swap/reader';
import type { PreparedView, SwapQuoteView, SwapView } from '../shared/api';
import { agentCheckOf, assertOwnAllowed, decide, liveSigned, markOwnLocal, markSigned, ownSubmit, plaintextClosedFor, putRequest, sendSigned, readers, routes, sameIntent, updateBadge } from './requests';
import { buildIdOf } from '../lib/buildId';
import { isE2EId } from './e2e';
import { DirectSwapReader } from '../lib/swap/reader';
import { e2eDirectReads } from './e2e';
import e2eCfg from '../config/e2e.json';
import { currentSession, signerUrl, socket } from './signer';
import { getPublic, getSession, patchSession, type Approval, type SignedRec } from './store';
import { accountKeys, requireUnlocked } from './wallet';
import { both, t as tr } from '../i18n';

/** in E2E the quote goes straight to sun.io (it carries the amount), the reference rate stays with the Signer.
 * 0.3.3: whenever E2E is wanted (also under a downgrade / before the first hello). */
export const swapReader = async () => ((await e2eDirectReads()) ? new DirectSwapReader(e2eCfg.sunio_quote_url, new SignerSwapReader(signerUrl, currentSession)) : new SignerSwapReader(signerUrl, currentSession));
const REBUILD_AFTER_MS = 30_000;

/**
 * 0.3.2: the price protection must not rest on the Signer alone. In the old mode the quote AND the reference
 * come from it, so the wallet asks sun.io directly for a second opinion (only the pair and the amount, as in E2E); in
 * E2E the quote is already direct. Ceilings: the Signer's path pays > QUOTE_MISMATCH_BPS less than sun.io's own best →
 * blocked; deviation from the reference > HARD_DEVIATION_BPS → blocked (> auto_max_price_deviation_bps → a warning);
 * no independent check at all (no direct quote and no fresh reference) → blocked.
 */
export const QUOTE_MISMATCH_BPS = 200;
export const HARD_DEVIATION_BPS = 500;
let sunioUrl = e2eCfg.sunio_quote_url;
/** tests: point the direct sun.io quote at the mock (no network in tests) */
export function setSunioUrl(u: string): void { sunioUrl = u; }

async function secondOpinion(prep: PreparedSwap): Promise<bigint | null> {
  if ((await e2eDirectReads()) || prep.path_index < 0 || prep.net !== 'mainnet') return null;
  try {
    const q = await new DirectSwapReader(sunioUrl, new SignerSwapReader(signerUrl, currentSession)).quote({ asset_in: prep.asset_in, asset_out: prep.asset_out, amount_in_raw: prep.amount_in_raw, slippage_bps: prep.slippage_bps });
    const pk = pickPath(q, swapConfig(prep.net), prep.asset_in, prep.asset_out, BigInt(prep.amount_in_raw));
    return pk ? BigInt(pk.path.amountOutRaw) : null;
  } catch (e) { console.warn('[agent-wallet] sun.io second opinion:', (e as Error)?.message ?? e); return null; }
}

interface Prepared { key: string; kind: 'agent' | 'own'; account_id: string; intent: SwapIntent; prep: PreparedSwap; view: PreparedView; request?: any }
const prepared = new Map<string, Prepared>();

/** Quick quote for the swap panel (no build): best supported path, min, rate, route, deviation from the reference. */
export async function swapQuote(asset_in: SwapAsset, asset_out: SwapAsset, amount_in: string, slippage_bps: number): Promise<SwapQuoteView> {
  const c = swapConfig();
  const amt = parseUnits(amount_in, c.assets[asset_in].decimals);
  if (amt <= 0n) throw new Error('BAD_AMOUNT');
  if (!Number.isInteger(slippage_bps) || slippage_bps < 1 || slippage_bps > LIMITS.max_slippage_bps) throw new Error('BAD_SLIPPAGE');
  const r = await swapReader();
  const [q, ref] = await Promise.all([r.quote({ asset_in, asset_out, amount_in_raw: amt.toString(), slippage_bps }), r.reference().catch(() => null)]);
  const pk = pickPath(q, c, asset_in, asset_out, amt);
  if (!pk) return { ok: false, code: 'SWAP_NO_ROUTE', message: tr('bg.swapNoRoute'), fetched_at: q.fetched_at };
  const out = BigInt(pk.path.amountOutRaw), min = amountOutMin(out, slippage_bps);
  let dev: number | null = null;
  if (ref && !ref.stale) { try { dev = deviationBps(asset_in, amt, out, ref.price_usd); } catch { dev = null; } }
  return { ok: true, amount_out: formatUnits(out, 6), amount_out_min: formatUnits(min, 6), rate: rateText(pk.path, asset_in, asset_out), route: routeLines(pk.path),
    fee: pk.path.fee, impact: pk.path.impact, reference: ref ? { price_usd: ref.price_usd, source: ref.source, as_of: ref.as_of ?? ref.ts, stale: !!ref.stale, deviation_bps: dev } : null,
    fetched_at: q.fetched_at };
}

function resourcesView(s: PreparedSwap['steps'][number], payer?: string, usdc?: string | null): NonNullable<PreparedView['resources']> {
  return {
    need: s.need.need, have: s.need.have, deficit: s.need.deficit, activate: s.need.activate, route: s.plan.route, fallback_route: s.plan.fallback_route,
    quotes: Object.fromEntries(Object.entries(s.plan.quotes).map(([k, v]) => [k, { ok: !!v?.ok, cost_usdc: v?.cost_usdc, approved_max_usdc: v?.approved_max_usdc, code: v?.code, note: v?.note, parts: v?.parts, energy: v?.energy }])),
    approved_max_usdc: s.plan.approved_max_usdc, fallback_approved_max_usdc: s.plan.fallback_approved_max_usdc, payer, usdc_balance: usdc ?? null,
    energy_source: s.energy.source, buy: s.plan.buy,
  };
}

export function swapViewOf(prep: PreparedSwap, payer?: string): SwapView {
  const c = swapConfig(prep.net);
  const usdc = prep.usdc_base_micro === null ? null : formatUnits(BigInt(prep.usdc_base_micro), 6);
  const ok = prep.path_index >= 0;
  const total = prep.steps.filter((s) => s.plan.route !== 'none').reduce((a, s) => a + parseUnits(s.plan.quote_usdc ?? '0', 6), 0n);
  const cap = prep.steps.filter((s) => s.plan.route !== 'none').reduce((a, s) => a + parseUnits(s.plan.approved_max_usdc ?? '0', 6), 0n);
  return {
    asset_in: prep.asset_in, asset_out: prep.asset_out, amount_in: prep.amount_in, slippage_bps: prep.slippage_bps,
    amount_out: ok ? formatUnits(BigInt(prep.amount_out_raw), 6) : '0', amount_out_min: ok ? formatUnits(BigInt(prep.amount_out_min_raw), 6) : '0',
    rate: ok ? rateText(prep.path, prep.asset_in, prep.asset_out) : '', route: ok ? routeLines(prep.path) : [], fee: prep.path?.fee, impact: prep.path?.impact,
    reference: prep.reference ? { price_usd: prep.reference.price_usd, source: prep.reference.source, as_of: prep.reference.as_of ?? prep.reference.ts, stale: !!prep.reference.stale, deviation_bps: prep.deviation_bps } : null,
    router: c.router, recipient: prep.owner, quote_fetched_at: prep.quote.fetched_at,
    approve: { needed: prep.approve.needed, spender: prep.approve.spender, amount: formatUnits(BigInt(prep.approve.amount_raw), 6),
      current_allowance: prep.approve.current_allowance_raw === null ? null : formatUnits(BigInt(prep.approve.current_allowance_raw), 6) },
    steps: prep.steps.map((s) => ({ step: s.step, txID: s.txID, contract: s.contract, fee_limit_trx: formatUnits(BigInt(s.fee_limit_sun), 6), expiration: new Date(s.expiration).toISOString(),
      energy: s.energy, resources: resourcesView(s, payer, usdc) })),
    resources_total_usdc: formatUnits(total, 6), resources_cap_usdc: formatUnits(cap, 6),
  };
}

async function build(kind: 'agent' | 'own', key: string, accountId: string, intent: SwapIntent, request?: any): Promise<Prepared> {
  const { pub, vault } = await requireUnlocked();
  const acc = pub.accounts.find((a) => a.id === accountId && !a.removed_at);
  if (!acc?.addresses.tron) throw new Error('UNKNOWN_ACCOUNT');
  const r = await readers();
  const prep = await prepareSwap({ owner: acc.addresses.tron, evmPayer: acc.addresses.evm, intent, tron: r.tron, evm: currentSession() ? r.evm : null, swap: await swapReader(), routes: routes(r.x402) });
  let blocked = prep.blocked;
  const warnings = [...prep.warnings];
  let agent: PreparedView['agent'];
  if (kind === 'agent') {
    const ac = await agentCheckOf(key, request, vault, accountId); // only an agent of the signed document
    agent = ac.agent;
    if (ac.blocked) blocked = ac.blocked;
  }
  if (prep.deviation_bps !== null && prep.deviation_bps > LIMITS.auto_max_price_deviation_bps) warnings.push(tr('bg.quoteWorse', { pct: (prep.deviation_bps / 100).toFixed(2) }));
  const noRef = !prep.reference || prep.reference.stale || prep.deviation_bps === null;
  if (noRef) warnings.push(tr('bg.noReference'));
  const E2E_ON = await e2eDirectReads(); // the quote itself came straight from sun.io
  if (prep.path_index >= 0) {
    const indep = E2E_ON ? BigInt(prep.amount_out_raw) : await secondOpinion(prep);
    const out = BigInt(prep.amount_out_raw);
    if (!blocked && indep !== null && !E2E_ON && indep > 0n && (indep - out) * 10_000n > indep * BigInt(QUOTE_MISMATCH_BPS))
      blocked = { reason_code: 'unsafe', code: 'SWAP_QUOTE_MISMATCH', ...both('blk.swapQuoteMismatch', { pct: (Number(((indep - out) * 10_000n) / indep) / 100).toFixed(2) }) };
    if (!blocked && prep.deviation_bps !== null && prep.deviation_bps > HARD_DEVIATION_BPS)
      blocked = { reason_code: 'unsafe', code: 'SWAP_PRICE_DEVIATION', ...both('blk.swapPriceDeviation', { pct: (prep.deviation_bps / 100).toFixed(2), max: (HARD_DEVIATION_BPS / 100).toFixed(0) }) };
    if (!blocked && indep === null && noRef) blocked = { reason_code: 'unsafe', code: 'SWAP_NO_REFERENCE', ...both('blk.swapNoCheck') };
    if (indep === null && !E2E_ON) warnings.push(tr('bg.noSecondQuote'));
  }
  const view: PreparedView = {
    key, kind, agent, account: { id: acc.id, name: acc.name, tron: acc.addresses.tron, evm: acc.addresses.evm },
    network: 'tron', type: 'swap', reason: request?.reason, expires_at: request?.expires_at, created_at: request?.created_at,
    swap: swapViewOf(prep, acc.addresses.evm), blocked, warnings, built_at: prep.built_at,
  };
  view.build_id = buildIdOf(view, [JSON.stringify(prep, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))]);
  const p: Prepared = { key, kind, account_id: accountId, intent, prep, view, request };
  prepared.set(key, p);
  return p;
}

export function swapIntentOf(req: any): SwapIntent {
  const i = req.intent ?? {};
  return { asset_in: String(i.asset_in ?? ''), asset_out: String(i.asset_out ?? ''), amount_in: String(i.amount_in ?? ''), slippage_bps: i.slippage_bps === undefined ? undefined : Number(i.slippage_bps), resources: i.resources };
}

/** An agent's `swap` request in the sign window (called from requests.ts prepareRequest). */
export async function prepareSwapRequest(id: string, req: any, accountId: string): Promise<PreparedView> {
  if (req.network !== 'tron') throw new Error('UNSUPPORTED_NETWORK');
  return (await build('agent', id, accountId, swapIntentOf(req), req)).view;
}

/** 0.3.2: only the build the window shows is signed; otherwise (or older than 30 s) a new one is shown. */
async function signPrepared(p: Prepared, buildId: string | undefined): Promise<{ status: 'changed'; view: PreparedView } | { status: 'signed'; steps: SignedStep[]; cur: Prepared }> {
  if (!buildId || buildId !== p.view.build_id || Date.now() - p.prep.built_at > REBUILD_AFTER_MS) {
    const next = await build(p.kind, p.key, p.account_id, p.intent, p.request);
    return { status: 'changed', view: next.view };
  }
  const cur = p;
  if (cur.view.blocked) throw new Error(`${cur.view.blocked.code}: ${cur.view.blocked.text ?? cur.view.blocked.message}`);
  const { account, keys } = await accountKeys(cur.account_id);
  if (normalizeTron(account.addresses.tron!) !== cur.prep.owner) throw new Error('INTENT_MISMATCH: owner');
  const steps = await signSwap(cur.prep, keys.tronKey); // re-checks the very bytes before the txIDs are signed
  return { status: 'signed', steps, cur };
}

function messageOf(p: Prepared, steps: SignedStep[], payer?: string) {
  return { swap: swapBlock(p.prep), steps: steps.map((s) => ({ step: s.step, signed: { network: 'tron', tx: s.tx }, resource_plan: stepResourcePlan(s, payer) })) };
}

/** Approvals of the step payments: keyed `<parent>:<step>` (request.pay of a step carries parent_request_id, step). */
async function approveSteps(parentId: string, p: Prepared, steps: SignedStep[]): Promise<void> {
  const s = await getSession();
  const all = { ...(s.approvals ?? {}) };
  for (const st of steps) {
    const plan = st.plan;
    if (plan.route === 'none') continue;
    const caps: Approval['caps_micro'] = { [plan.route]: parseUnits(plan.approved_max_usdc!, 6).toString() };
    if (plan.fallback_route) caps[plan.fallback_route] = parseUnits(plan.fallback_approved_max_usdc!, 6).toString();
    all[`${parentId}:${st.step}`] = { request_id: `${parentId}:${st.step}`, account_id: p.account_id, txID: st.tx.txID, route: plan.route, fallback_route: plan.fallback_route ?? null, caps_micro: caps, paid_micro: {}, created_at: Date.now(),
      req_id: parentId, expires_at: decodeRaw(st.tx.raw_data_hex).expiration, addresses: [p.prep.owner] }; // the approval: what the x402 payment may cover
  }
  await patchSession({ approvals: all });
}

/** Approval of a request.pay: the request itself (transfers) or the step of a swap. */
export function approvalKey(m: { request_id: string; parent_request_id?: string; step?: string }, approvals: Record<string, Approval> | undefined): string {
  if (approvals?.[m.request_id]) return m.request_id;
  if (m.parent_request_id && m.step && approvals?.[`${m.parent_request_id}:${m.step}`]) return `${m.parent_request_id}:${m.step}`;
  return m.request_id;
}

/** Sign an agent's swap (called from requests.ts signRequest). */
export async function signSwapRequest(id: string, e: { request: any }, buildId?: string, rec?: SignedRec): Promise<{ status: string; view?: PreparedView; resent?: boolean }> {
  if (await plaintextClosedFor(id)) throw new Error('E2E_DOWNGRADE: plaintext is closed'); // (also checked by signRequest)
  let r2 = rec; // the steps signed for this request are re-sent as they are
  if (!r2) {
    const p = prepared.get(id);
    if (!p || !sameIntent(p.request, e.request)) return { status: 'changed', view: (await build('agent', id, e.request.account.id, swapIntentOf(e.request), e.request)).view };
    const r = await signPrepared(p, buildId);
    if (r.status === 'changed') return r;
    const pub = await getPublic();
    await approveSteps(id, r.cur, r.steps); // before sending: request.pay may follow the ack immediately
    r2 = { key: id, kind: 'request', type: 'swap', network: 'tron', at: Date.now(), until: Math.max(...r.steps.map((x) => decodeRaw(x.tx.raw_data_hex).expiration)), txids: r.steps.map((x) => x.tx.txID),
      agent_id: e.request.agent?.id, to: `swap:${e.request.intent?.asset_out ?? ''}`, account_id: r.cur.account_id, view: r.cur.view,
      body: { request_id: id, decision: { by: 'human', rule: null, wallet_doc_version: pub?.doc_version ?? 0 }, ...messageOf(r.cur, r.steps, r.cur.view.account.evm) } };
  }
  const rr = r2;
  await sendSigned(rr, () => decide('request.sign', rr.body));
  await markSigned(id, e.request);
  return { status: 'signed', ...(rec ? { resent: true } : {}) };
}

// ---- the human's own swap (panel) → own.swap ----
export async function swapPrepare(account_id: string, asset_in: SwapAsset, asset_out: SwapAsset, amount_in: string, slippage_bps: number): Promise<PreparedView> {
  await assertOwnAllowed(); // not under a downgrade
  const key = randomId('swp');
  return (await build('own', key, account_id, { asset_in, asset_out, amount_in, slippage_bps, resources: { route: 'auto', payment: { method: 'x402_base' } } })).view;
}

export async function swapSign(swap_id: string, buildId?: string): Promise<{ status: string; view?: PreparedView; request_id?: string }> {
  const p = prepared.get(swap_id);
  if (!p) throw new Error('NOT_FOUND: prepare again');
  let rec = await liveSigned(swap_id); // after an unanswered own.swap the same steps go again
  let steps: SignedStep[] | undefined;
  if (!rec) {
    const r = await signPrepared(p, buildId);
    if (r.status === 'changed') return r;
    steps = r.steps;
    const it = { asset_in: r.cur.prep.asset_in, asset_out: r.cur.prep.asset_out, amount_in: r.cur.prep.amount_in, slippage_bps: r.cur.prep.slippage_bps };
    rec = { key: swap_id, kind: 'own', type: 'swap', own_type: 'own.swap', network: 'tron', at: Date.now(), until: Math.max(...r.steps.map((x) => decodeRaw(x.tx.raw_data_hex).expiration)), txids: r.steps.map((x) => x.tx.txID),
      account_id: p.account_id, body: { account: p.account_id, network: 'tron', intent: it, ...messageOf(r.cur, r.steps, r.cur.view.account.evm) }, view: { steps: r.steps } };
  }
  const rr = rec;
  const ack: any = await sendSigned(rr, () => ownSubmit(rr.own_type!, rr.body));
  const rid: string | undefined = ack.request_id ?? ack.request?.request_id;
  if (rid) {
    await approveSteps(rid, p, steps ?? rr.view.steps);
    await putRequest({ request_id: rid, own: true, type: 'swap', network: 'tron', status: ack.request?.status && ack.request.status !== 'pending' ? ack.request.status : 'signed',
      account: { id: p.account_id, name: p.view.account.name }, intent: { ...rr.body.intent, recipient: p.prep.owner }, created_at: new Date().toISOString() });
    await markOwnLocal(rid);
  }
  prepared.delete(swap_id);
  return { status: 'submitted', request_id: rid };
}
