// Top bar: the account (square identicon + name ▾ → the «Accounts» screen), short address with copy, Signer dot,
// side panel, lock (at once, every open view), settings (a cog with teeth + title; 0.1.7 — the old icon read as «theme»).
import type { AccountView, StatusView } from '../../shared/api';
import { Identicon } from '../common/Identicon';
import { I } from '../common/icons';
import { AddrChip, accountTag, lockNow } from '../common/ui';
import { MODE } from './screen';
import { BrandMark } from '../common/Mascot';
import { t } from '../../i18n';

async function openSidePanel() {
  const w = await chrome.windows.getCurrent();
  await chrome.sidePanel.open({ windowId: w.id! });
  window.close();
}

export function Header({ st, account, nav }: { st: StatusView; account: AccountView; pick: (id: string) => void; nav: (p: string) => void; reload: () => void }) {
  return (
    <div className="topbar">
      <BrandMark size={24} />
      <button className="acc-btn" onClick={() => nav('/accounts')} title={t('header.accounts', { tag: accountTag(st, account) })} aria-label={t('header.chooseAccount')}>
        <Identicon addr={account.addresses.tron ?? account.addresses.evm ?? account.id} size={28} />
        <span className="name">{account.name}</span><I.chevronDown size={14} />
      </button>
      <AddrChip a={account.addresses.tron ?? ''} />
      <span className="grow" />
      {st.signer.registering && <span className="small muted" role="status">{t('header.registering')}</span>}
      <span className={`dot ${st.signer.connected ? 'on' : ''}`} title={st.signer.connected ? t('header.signerOn') : t('header.signerOff')} />
      {MODE === 'popup' && chrome.sidePanel && <button className="iconbtn flat" title={t('settings.openPanel')} aria-label={t('settings.openPanel')} onClick={() => void openSidePanel().catch(() => {})}><I.panel size={18} /></button>}
      <button className="iconbtn flat" title={t('header.lockNow')} aria-label={t('settings.lock')} onClick={() => void lockNow()}><I.lock size={18} /></button>
      <button className="iconbtn flat" title={t('title.settings')} aria-label={t('title.settings')} onClick={() => nav('/settings')}><I.gear size={18} /></button>
    </div>
  );
}
