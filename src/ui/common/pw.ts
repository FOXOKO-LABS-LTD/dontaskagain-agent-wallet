// Password strength in the pages: the same rule as the worker, the reason in words.
import { passwordProblem } from '../../lib/crypto/password';
import { t, type Key } from '../../i18n';

const KEYS: Record<string, Key> = { PW_SHORT: 'pw.short', PW_REPEAT: 'pw.repeat', PW_SEQUENCE: 'pw.sequence', PW_COMMON: 'pw.common', PW_SIMPLE: 'pw.simple', PW_SAME: 'pw.same' };
export const pwProblemText = (pw: string): string | null => { const p = passwordProblem(pw); return p ? t(KEYS[p]) : null; };
export const pwErrorText = (e: string): string => { const m = /WEAK_PASSWORD: (PW_\w+)/.exec(e); return m && KEYS[m[1]] ? t(KEYS[m[1]]) : e; };
