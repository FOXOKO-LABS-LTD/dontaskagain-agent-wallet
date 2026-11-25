// 0.3.2: a password that guards the vault against an offline guesser (PBKDF2 600 000 ≈ 10^4 tries/s on one
// GPU) — not only ≥ 10 characters: no repeats, sequences, keyboard rows or a top-list word with digits around it; a
// short one needs several kinds of characters, a long passphrase does not.
export const MIN_PASSWORD = 10;

const COMMON = ['password', 'passw0rd', 'qwerty', 'qwertyuiop', 'asdfgh', 'zxcvbn', 'iloveyou', 'admin', 'letmein', 'welcome', 'monkey', 'dragon',
  'football', 'baseball', 'master', 'sunshine', 'princess', 'shadow', 'superman', 'trustno1', 'whatever', 'qazwsx', 'abc123', 'password1',
  'йцукен', 'пароль', 'qwerty123', '1q2w3e4r', '1qaz2wsx', 'zaq12wsx', 'changeme', 'secret', 'bitcoin', 'crypto', 'wallet', 'metamask', 'tronlink'];
const ROWS = ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm', 'йцукенгшщзхъ', 'фывапролджэ', 'ячсмитьбю', 'abcdefghijklmnopqrstuvwxyz'];

/** null = good enough; else the reason code (PW_SHORT, PW_REPEAT, PW_SEQUENCE, PW_COMMON, PW_SIMPLE). */
export function passwordProblem(pw: string): string | null {
  const chars = [...pw];
  if (chars.length < MIN_PASSWORD) return 'PW_SHORT';
  const low = pw.toLowerCase();
  if (new Set(chars).size < 5) return 'PW_REPEAT';
  const core = low.replace(/[\d\s\W_]+/gu, '');
  if (COMMON.some((w) => low === w || core === w || (low.includes(w) && low.length - w.length < 6))) return 'PW_COMMON';
  const seq = (s: string) => ROWS.some((r) => r.includes(s) || [...r].reverse().join('').includes(s));
  if (seq(low) || /^(\d)\1*$/.test(pw)) return 'PW_SEQUENCE';
  const classes = [/[a-zа-яё]/u, /[A-ZА-ЯЁ]/u, /\d/, /[^\p{L}\d]/u].filter((r) => r.test(pw)).length;
  if (chars.length < 16 && classes < 2) return 'PW_SIMPLE';
  return null;
}

export function requireStrongPassword(pw: string): void {
  const p = passwordProblem(pw);
  if (p) throw new Error(`WEAK_PASSWORD: ${p}`);
}
