// A separate purchase of TRON resources by the human (Resources screen, Direct products of the gateway):
// tron/energy (65 000…300 000), tron/bandwidth (300…5000 bytes), tron/activate — for the account's own TRON address.
// The Signer does the purchase (`own.resource`): it POSTs the product, relays its
// 402 as request.pay, and the extension signs EIP-3009 from the account's Base address within the approved ceiling —
// the same approval path as resources of a transfer (route "direct").
import { formatUnits, mulDivUp, parseUnits } from '../lib/amount';
import { usdcBalance } from '../lib/evm/erc20';
import { DIRECT_MIN_BANDWIDTH, DIRECT_MAX_BANDWIDTH, DIRECT_MIN_ENERGY, PROXY_MAX_ENERGY, CEILING_PCT, quotePrice } from '../lib/resources/plan';
import { currentSession, socket } from './signer';
import { markOwnLocal, putRequest, readers } from './requests';
import { getSession, patchSession, type Approval } from './store';
import { requireUnlocked } from './wallet';
import { e2eActive, plaintextPolicy } from './e2e';
import { t } from '../i18n';

export type ResourceProduct = 'energy' | 'bandwidth' | 'activate';

export interface ResourceQuoteView { product: ResourceProduct; amount: number; address: string; price_usdc: string; approved_max_usdc: string; usdc_balance: string | null }

export function checkAmount(product: ResourceProduct, amount: number): number {
  if (product === 'activate') return 0;
  const [lo, hi] = product === 'energy' ? [DIRECT_MIN_ENERGY, PROXY_MAX_ENERGY] : [DIRECT_MIN_BANDWIDTH, DIRECT_MAX_BANDWIDTH];
  if (!Number.isInteger(amount) || amount < lo || amount > hi) throw new Error(`BAD_AMOUNT: ${product} ${lo}…${hi}`);
  return amount;
}

export async function resourceQuote(account_id: string, product: ResourceProduct, amount: number): Promise<ResourceQuoteView> {
  const { pub } = await requireUnlocked();
  const acc = pub.accounts.find((a) => a.id === account_id && !a.removed_at);
  if (!acc?.addresses.tron) throw new Error('UNKNOWN_ACCOUNT');
  if (!currentSession()) throw new Error('Signer is not connected');
  const amt = checkAmount(product, amount);
  const r = await readers();
  const q = await r.x402.quote(product === 'activate' ? { product: 'activate', address: acc.addresses.tron } : { product, amount: String(amt), address: acc.addresses.tron });
  const price = quotePrice(q);
  if (!price) throw new Error('PRICE_UNAVAILABLE');
  const cap = mulDivUp(parseUnits(price, 6), BigInt(CEILING_PCT), 100n);
  const bal = acc.addresses.evm ? await usdcBalance(r.evm, 8453, acc.addresses.evm).catch(() => null) : null;
  return { product, amount: amt, address: acc.addresses.tron, price_usdc: price, approved_max_usdc: formatUnits(cap, 6), usdc_balance: bal === null ? null : formatUnits(bal, 6) };
}

/** Buy: re-quote, refuse if dearer than what the human saw, then `own.resource`; the approval covers its request.pay. */
export async function buyResource(account_id: string, product: ResourceProduct, amount: number, seen_max_usdc: string): Promise<{ request_id?: string; quote: ResourceQuoteView }> {
  const q = await resourceQuote(account_id, product, amount);
  if (parseUnits(q.approved_max_usdc, 6) > parseUnits(seen_max_usdc, 6)) return Promise.reject(new Error(`PRICE_CHANGED: ${q.price_usdc} USDC`));
  if (q.usdc_balance !== null && parseUnits(q.usdc_balance, 6) < parseUnits(q.price_usdc, 6)) throw new Error(`RESOURCE_PAYMENT_FAILED: ${t('bg.noUsdcBase')}`);
  const { pub } = await requireUnlocked();
  const acc = pub.accounts.find((a) => a.id === account_id)!;
  const buy = { energy: product === 'energy' ? q.amount : 0, bandwidth: product === 'bandwidth' ? q.amount : 0, activate: product === 'activate' ? [q.address] : [] };
  // the Signer executes it (no E2E executor for a bare resource purchase yet): never under E2E
  if ((await e2eActive()) || (await plaintextPolicy()) === 'closed') throw new Error(`E2E_TYPE_UNSUPPORTED: ${t('bg.resourceNoE2E')}`);
  const ack = await socket.request('own.resource', {
    account: account_id, network: 'tron', product: `tron/${product}`, address: q.address, ...(product === 'activate' ? {} : { amount: q.amount }),
    resource_plan: { route: 'direct', fallback_route: null, payment_method: 'x402_base', buy, quote_usdc: q.price_usdc, approved_max_usdc: seen_max_usdc,
      quotes: { direct: q.price_usdc }, payer: acc.addresses.evm, counted_in_limit: false },
  });
  const rid: string | undefined = ack?.request_id ?? ack?.request?.request_id;
  if (rid) {
    const s = await getSession();
    const a: Approval = { request_id: rid, account_id, txID: '', route: 'direct', fallback_route: null, caps_micro: { direct: parseUnits(seen_max_usdc, 6).toString() }, paid_micro: {}, created_at: Date.now(),
      req_id: rid, expires_at: Date.now() + 10 * 60_000, addresses: [q.address] }; // as long as a TRON transaction would live
    await patchSession({ approvals: { ...(s.approvals ?? {}), [rid]: a } });
    await putRequest({ request_id: rid, own: true, type: 'tron_resource', network: 'tron', status: ack.request?.status && ack.request.status !== 'pending' ? ack.request.status : 'signed',
      account: { id: account_id, name: acc.name }, intent: { product: `tron/${product}`, amount: q.amount, address: q.address }, created_at: new Date().toISOString() });
    await markOwnLocal(rid);
  }
  return { request_id: rid, quote: q };
}
