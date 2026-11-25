// The mascot and the logo of the UI kit 1.1.1 (public/mascot, public/brand: local SVG files, no network). The mascot lives
// in the shell only — onboarding, empty lists, waiting, results, errors, the password screen, the agent wizard, beside a
// warning — never in transaction data and never next to «Sign» / «Reject» (UI kit rule).
// ≤ 32 px uses the simplified `small` drawing; the meaning of a state is always said in words next to it.
import { useTheme } from './theme';
import { PRODUCT } from './ui';

export type MascotState = 'neutral' | 'waiting' | 'done' | 'canceled' | 'network-error' | 'locked' | 'connected' | 'warning' | 'empty';

export const mascotSrc = (state: MascotState, size: number, theme: 'light' | 'dark'): string =>
  `/mascot/${size <= 32 ? `small/${theme}` : theme}/${state}.svg`;

export function Mascot({ state, size = 96, className }: { state: MascotState; size?: number; className?: string }) {
  const theme = useTheme();
  return <img className={`mascot${className ? ` ${className}` : ''}`} src={mascotSrc(state, size, theme)} width={size} height={size} alt="" aria-hidden="true" draggable={false} />;
}

/** The full logo (mark + name, in curves): at least 96 px wide (logo/RULES.md); on a dark surface its dark version. */
export function BrandLogo({ width = 160 }: { width?: number }) {
  const theme = useTheme();
  return <img className="brand-logo" src={theme === 'dark' ? '/brand/horizontal-dark.svg' : '/brand/horizontal.svg'} width={width} height={Math.round((width * 84) / 422)} alt={PRODUCT} draggable={false} />;
}

/** The mark alone, 24–32 px (logo/mark-small.svg) — where the full logo does not fit. */
export function BrandMark({ size = 28 }: { size?: number }) {
  return <img className="brand-mark" src="/brand/mark-small.svg" width={size} height={size} alt="" aria-hidden="true" draggable={false} />;
}
