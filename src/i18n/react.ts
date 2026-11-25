import { useSyncExternalStore } from 'react';
import { getLang, onLangChange, type Lang } from './index';

/** The current UI language; the component re-renders when it changes (Settings → «Language», any open view). */
export function useLang(): Lang {
  return useSyncExternalStore(onLangChange, getLang, getLang);
}
