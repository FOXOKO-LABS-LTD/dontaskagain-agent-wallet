// QR of an address (Receive). Local generation (qrcode-generator, MIT), drawn as SVG cells.
import qrcode from 'qrcode-generator';

export function Qr({ text, size = 184 }: { text: string; size?: number }) {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  const quiet = 2;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  return (
    <svg className="qr" width={size} height={size} viewBox={`0 0 ${n + quiet * 2} ${n + quiet * 2}`} shapeRendering="crispEdges" role="img" aria-label={text}>
      <rect width="100%" height="100%" fill="#fff" /><path d={d} fill="rgb(40 42 52)" />
    </svg>
  );
}
