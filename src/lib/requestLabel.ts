// One-line labels of a request for lists and notifications: a transfer «25 USDT → TJRa…RTv8», a swap
// «swap 10 USDT → TRX, at least 32.1 TRX» (the swap fields, not a transfer's).
import { fmtAmount } from './portfolio';
import { shortAddr } from './similar';
import { t } from '../i18n';

const NETS: Record<string, string> = { 'evm:1': 'Ethereum', 'evm:42161': 'Arbitrum', 'evm:10': 'Optimism', 'evm:137': 'Polygon', 'evm:8453': 'Base', tron: 'TRON' };

export interface Labelled { type?: string; network?: string; intent?: any; swap?: { amount_out_min?: string } | null }

/** Main line (amount) of a list row. */
export function requestAmount(r: Labelled): string {
  const i = r.intent ?? {};
  if (r.type === 'swap') return `${fmtAmount(String(i.amount_in ?? '?'))} ${i.asset_in ?? ''} → ${i.asset_out ?? ''}`.trim();
  if (r.type === 'bridge') return t('req.bridgeAmount', { amount: fmtAmount(String(i.amount ?? '?')) });
  if (r.type === 'refuel') return t('req.refuelAmount', { amount: fmtAmount(String(i.amount_eth ?? '?')) });
  if (r.type === 'tron_resource') return i.product === 'tron/activate' ? t('req.activation') : t(i.product === 'tron/bandwidth' ? 'req.bandwidthAmount' : 'req.energyAmount', { amount: fmtAmount(String(i.amount ?? '')) });
  if (i.amount != null) return `${fmtAmount(String(i.amount))} ${i.asset ?? ''}`.trim();
  return r.type ?? '';
}

/** Where it goes: a transfer — the short recipient; a swap — «at least X» when known. */
export function requestTarget(r: Labelled): string {
  const i = r.intent ?? {};
  if (r.type === 'tron_resource') return t('req.resourcePurchase');
  if (r.type === 'bridge') return `${NETS[i.from_network] ?? i.from_network ?? ''} → ${NETS[i.to_network] ?? i.to_network ?? ''}`;
  if (r.type === 'refuel') return `Ethereum → ${NETS[i.to_network] ?? i.to_network ?? ''}`;
  if (r.type === 'swap') return r.swap?.amount_out_min ? t('req.atLeast', { amount: r.swap.amount_out_min, asset: i.asset_out ?? '' }).trim() : t('req.swap');
  return i.to ? `→ ${shortAddr(String(i.to))}${r.network && r.network !== 'tron' && NETS[r.network] ? ` · ${NETS[r.network]}` : ''}` : '';
}

/** Notification text of a new request. */
export function notificationText(who: string, r: Labelled): string {
  const i = r.intent ?? {};
  if (r.type === 'swap') {
    const min = r.swap?.amount_out_min;
    return t('req.nSwap', { who, amount: i.amount_in ?? '?', ain: i.asset_in ?? '', min: min ? `${min} ${i.asset_out ?? ''}` : t('req.nSwapMinUnknown', { aout: i.asset_out ?? '' }) });
  }
  if (r.type === 'bridge') return t('req.nBridge', { who, amount: i.amount ?? '?', from: NETS[i.from_network] ?? i.from_network, to: NETS[i.to_network] ?? i.to_network });
  if (r.type === 'refuel') return t('req.nRefuel', { who, amount: i.amount_eth ?? '?', to: NETS[i.to_network] ?? i.to_network });
  return `${who}: ${r.type === 'transfer' ? t('req.transfer') : r.type} ${i.amount ?? ''} ${i.asset ?? ''}${i.to ? ` → ${shortAddr(String(i.to))}` : ''}`.replace(/\s+/g, ' ').trim();
}
