// Prices for the main screen: every coin from the Signer GET /v1/ext/prices (aggregator price.coins.ceo, cached
// 60 s there); TRX falls back to our gateway's free quote (GET /x402/v1/quote?product=energy → trx_usd, relayed by the
// Signer /v1/ext/x402/quote), which also gives the energy quote. Cached 5 min in session storage.
import type { PricesView } from '../shared/api';
import { getJSON } from '../lib/net';
import { fromServer, mergePrices } from '../lib/prices';
import { cacheLogos, setLogoSigner } from './logos';
import { currentSession, signerUrl } from './signer';
import { readers } from './requests';
import { getSession, patchSession } from './store';
import { t } from '../i18n';

const TTL_MS = 5 * 60_000;
const QUOTE_ENERGY = 65_000;

export async function prices(force = false): Promise<PricesView> {
  const s = (await getSession()) as any;
  const c: (PricesView & { at: number }) | undefined = s.prices;
  if (!force && c && Date.now() - c.at < TTL_MS && (c.TRX || (c.coins && Object.keys(c.coins).length))) return c;
  const sess = currentSession();
  if (!sess) return c ? { ...c, error: t('bg.noSignIn') } : { TRX: null, error: t('bg.noSignIn') };
  const [srv, quote] = await Promise.allSettled([
    getJSON(`${signerUrl()}/v1/ext/prices`, { Authorization: `Bearer ${sess}` }, 10_000),
    (async () => (await readers()).x402.quote({ product: 'energy', amount: String(QUOTE_ENERGY) }))(),
  ]);
  if (srv.status === 'rejected' && quote.status === 'rejected') {
    const msg = (srv.reason as Error)?.message ?? t('bg.noPrices');
    return c ? { ...c, error: msg } : { TRX: null, error: msg };
  }
  const r: any = quote.status === 'fulfilled' ? quote.value : null;
  const trx = Number(r?.trx_usd);
  setLogoSigner(signerUrl());
  const coins = await cacheLogos(mergePrices(srv.status === 'fulfilled' ? fromServer(srv.value) : null, Number.isFinite(trx) && trx > 0 ? trx : null, r?.as_of));
  const out: PricesView & { at: number } = {
    TRX: coins.TRX?.usd ?? null,
    coins,
    energy_quote: typeof r?.price_usdc === 'string' ? { energy: Number(r.energy ?? QUOTE_ENERGY), price_usdc: r.price_usdc } : (c?.energy_quote ?? null),
    as_of: r?.as_of, at: Date.now(),
  };
  await patchSession({ prices: out } as any);
  return out;
}
