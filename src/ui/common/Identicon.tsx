// Square identicon by address: 5×5 mirrored cells in one of the brand colours on paper (Rabby/Trust-like recognition,
// neobrutalist square). Deterministic: FNV-1a over the address.
const COLORS = ['49 94 251', '230 0 18', '40 42 52', '22 119 255', '52 116 87', '214 160 0'];

function fnv(s: string, seed: number): number {
  let h = 0x811c9dc5 ^ seed;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

export function Identicon({ addr, size = 28 }: { addr: string; size?: number }) {
  const h1 = fnv(addr, 1), h2 = fnv(addr, 2);
  const color = COLORS[h2 % COLORS.length];
  const bg = (h2 >> 8) % 2 ? '255 226 122' : '253 251 246';
  const cells: [number, number][] = [];
  for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++) {
    if ((h1 >> (y * 3 + x)) & 1) { cells.push([x, y]); if (x < 2) cells.push([4 - x, y]); }
  }
  return (
    <svg className="identicon" width={size} height={size} viewBox="-0.5 -0.5 6 6" aria-hidden="true">
      <rect x="-0.5" y="-0.5" width="6" height="6" fill={`rgb(${bg})`} />
      {cells.map(([x, y]) => <rect key={`${x}.${y}`} x={x} y={y} width="1" height="1" fill={`rgb(${color})`} />)}
    </svg>
  );
}
