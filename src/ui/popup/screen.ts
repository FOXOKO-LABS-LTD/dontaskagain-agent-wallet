import type { AccountView, StatusView } from '../../shared/api';

/** Props of every screen of the popup / side panel app (also the swap screen). */
export interface ScreenProps { st: StatusView; account: AccountView; nav: (path: string) => void; reload: () => void; }

export const MODE: 'popup' | 'panel' = location.pathname.endsWith('panel.html') ? 'panel' : 'popup';
