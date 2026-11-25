// Swap screen — STUB of the UI. The swap itself (TRX/USDT via sun.io, request type `swap`) is built by the
// swap work in src/lib/swap/* and owns this file from now on. Kept: route `/swap`,
// `Swap(p: ScreenProps)`, the «you give / you get» picker `SwapPair`.
import { useState } from 'react';
import { I } from '../common/icons';
import type { ScreenProps } from './screen';
import { CoinLogo } from '../common/Logo';
import { t } from '../../i18n';

export type SwapAsset = 'TRX' | 'USDT';
export interface SwapSide { asset: SwapAsset; amount: string }

export function SwapPair({ give, get, onChange }: { give: SwapSide; get: SwapSide; onChange: (give: SwapSide, get: SwapSide) => void }) {
  const side = (label: string, s: SwapSide, set: (x: SwapSide) => void, readOnly?: boolean) => (
    <div className="pair">
      <div className="lbl netlabel"><CoinLogo symbol={s.asset} size={18} />{label}</div>
      <div className="in">
        <input value={s.amount} inputMode="decimal" placeholder="0" readOnly={readOnly} onChange={(e) => set({ ...s, amount: e.target.value })} />
        <select value={s.asset} onChange={(e) => set({ ...s, asset: e.target.value as SwapAsset })}><option value="TRX">TRX · TRON</option><option value="USDT">USDT · TRON</option></select>
      </div>
    </div>
  );
  return (
    <div style={{ boxShadow: 'var(--shadow)', marginBottom: 14 }}>
      {side(t('swap.give'), give, (x) => onChange(x, x.asset === get.asset ? { ...get, asset: x.asset === 'TRX' ? 'USDT' : 'TRX' } : get))}
      <div className="flip"><button className="iconbtn" title={t('swap.flip')} onClick={() => onChange({ ...get, amount: give.amount }, { ...give, amount: '' })}><I.swap size={14} /></button></div>
      {side(t('swap.get'), get, (x) => onChange(x.asset === give.asset ? { ...give, asset: x.asset === 'TRX' ? 'USDT' : 'TRX' } : give, x), true)}
    </div>
  );
}

export function Swap({ account }: ScreenProps) {
  const [give, setGive] = useState<SwapSide>({ asset: 'TRX', amount: '' });
  const [get, setGet] = useState<SwapSide>({ asset: 'USDT', amount: '' });
  return (
    <div className="screen">
      <span className="eyebrow">{account.name} · TRON</span>
      <div style={{ height: 10 }} />
      <SwapPair give={give} get={get} onChange={(a, b) => { setGive(a); setGet(b); }} />
      <div className="plate info small">{t('swap.stubNote')}</div>
      <button className="btn primary block" disabled>{t('swap.getQuote')}</button>
    </div>
  );
}
