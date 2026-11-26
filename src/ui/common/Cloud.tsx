// 0.3.13: the mark of a cloud agent (a chat app connected through OAuth): the Signer holds its key and sees its
// requests. Shown wherever the agent is: the agents list, its settings, the sign window, the operation page, history.
import { t } from '../../i18n';

export function CloudBadge() {
  return <span className="badge warn cloud-badge" title={t('cloud.plate')}>{t('cloud.badge')}</span>;
}

export function CloudPlate() {
  return <div className="plate warn small cloud-plate" role="note"><CloudBadge /> {t('cloud.plate')}</div>;
}
