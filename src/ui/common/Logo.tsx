// Coin / network logos in the neobrutalist frame: a square 2px ink frame around the round logo; a coin may carry a
// small network badge in the corner. Unknown coin → ticker letters.
import { useState } from 'react';
import { coinLogo, initials, NET_NAMES, netLogo } from '../../lib/logos';

export function CoinLogo({ symbol, network, logo, size = 34 }: { symbol: string; network?: string; logo?: string; size?: number }) {
  const src = coinLogo(symbol, logo);
  const [bad, setBad] = useState(false);
  const net = network ? netLogo(network) : null;
  // the network badge only when it adds information (not TRX on TRON, ETH on Ethereum, POL on Polygon)
  const showNet = !!net && net !== coinLogo(symbol);
  return (
    <span className="logo coin" style={{ width: size, height: size }} title={network ? `${symbol} · ${NET_NAMES[network] ?? network}` : symbol}>
      {src && !bad ? <img src={src} alt={symbol} className={shapeFree(src) ? 'free' : undefined} onError={() => setBad(true)} /> : <span className="ini" style={{ fontSize: Math.max(8, Math.round(size / 3.4)) }}>{initials(symbol)}</span>}
      {showNet && <img className={`badge-net ${shapeFree(net!) ? 'free' : ''}`} src={net!} alt={NET_NAMES[network!] ?? network} />}
    </span>
  );
}

/** Network logo, small and framed. */
export function NetLogo({ network, size = 16 }: { network: string; size?: number }) {
  const src = netLogo(network);
  if (!src) return null;
  return <span className="logo net" style={{ width: size, height: size }}><img src={src} alt="" className={shapeFree(src) ? 'free' : undefined} /></span>;
}

/** «[logo] Base» for pickers and kv rows. */
export function NetLabel({ network, name }: { network: string; name?: string }) {
  return <span className="netlabel"><NetLogo network={network} />{name ?? NET_NAMES[network] ?? network}</span>;
}

/** Marks that are not round in their brand kit (Arbitrum hexagon): shown whole, not clipped to a circle. */
const shapeFree = (src: string) => src.endsWith('/arbitrum.svg');
