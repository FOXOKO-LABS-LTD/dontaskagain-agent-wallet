import type { PreparedView } from '../../shared/api';
import { t } from '../../i18n';
import { followUps } from '../../lib/nextSteps';

/**
 * 0.3.5: «Next, without a new window: …» — the only signatures that follow this window's «Sign» without a new
 * window (x402 payment for TRON resources within the cap shown; the CCTP mint to the own address). Nothing → no line.
 */
export function NextSteps({ v }: { v: PreparedView }) {
  if (v.blocked) return null;
  const f = followUps(v);
  const items = [f.pay_cap_usdc ? t('review.nextPay', { cap: f.pay_cap_usdc }) : '', f.mint_net ? t('review.nextMint', { net: f.mint_net }) : ''].filter(Boolean);
  if (!items.length) return null;
  return <div className="plate info next-steps" data-testid="next-steps">{t('review.next', { items: items.join('; ') })}</div>;
}
