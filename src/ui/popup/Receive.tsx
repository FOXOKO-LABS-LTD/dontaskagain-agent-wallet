// Receive (0.2.1 text): the address of the chosen network + QR and what arrives where (no scare lines:
// an EVM address is the same in every EVM network and the key is the human's).
import { useState } from 'react';
import { Qr } from '../common/Qr';
import { Addr, Copy } from '../common/ui';
import type { ScreenProps } from './screen';
import { t } from '../../i18n';
import { NetLabel, NetLogo } from '../common/Logo';

const EVM = (id: string, name: string, assets: string) => ({ id, name, assets, addr: (a: ScreenProps['account']) => a.addresses.evm });
const NETS = [
  { id: 'tron', name: 'TRON', assets: 'TRX, USDT (TRC-20)', addr: (a: ScreenProps['account']) => a.addresses.tron },
  EVM('evm:1', 'Ethereum', 'ETH, USDC, USDT'), EVM('evm:42161', 'Arbitrum', 'ETH, USDC, USDT'), EVM('evm:10', 'Optimism', 'ETH, USDC, USDT'),
  EVM('evm:137', 'Polygon', 'POL, USDC, USDT'), EVM('evm:8453', 'Base', 'USDC, ETH'),
];

export function Receive({ account }: ScreenProps) {
  const [net, setNet] = useState<string>('tron');
  const n = NETS.find((x) => x.id === net)!;
  const a = n.addr(account) ?? '';
  return (
    <div className="screen">
      <div className="tabs nets">{NETS.map((x) => <button key={x.id} className={`tab ${net === x.id ? 'active' : ''}`} onClick={() => setNet(x.id)} title={x.name}>{net === x.id ? <NetLabel network={x.id} name={x.name} /> : <NetLogo network={x.id} size={18} />}</button>)}</div>
      <div className="card center">
        <span className="eyebrow">{account.name} · {n.name}</span>
        <div style={{ marginTop: 12 }}><Qr text={a} /></div>
        <Addr a={a} network={net} size="md" />
        <div className="row" style={{ justifyContent: 'center', marginTop: 10 }}><Copy text={a} label={t('recv.copyAddr')} /></div>
      </div>
      {net === 'tron'
        ? <div className="plate info">{t('recv.tron')}</div>
        : <div className="plate info">{t('recv.evm', { net: n.name, assets: n.assets })}</div>}
      {net === 'evm:8453' && <p className="small muted">{t('recv.baseUsdc')}</p>}
    </div>
  );
}
