// Decimal string <-> integer base units (money is never a JSON number).

export function parseUnits(amount: string, decimals: number): bigint {
  const s = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('BAD_AMOUNT');
  const [int, frac = ''] = s.split('.');
  if (frac.length > decimals) throw new Error('BAD_AMOUNT');
  return BigInt(int) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

export function formatUnits(raw: bigint | string | number, decimals: number, maxFrac = decimals): string {
  let v = BigInt(raw);
  const neg = v < 0n;
  if (neg) v = -v;
  const base = 10n ** BigInt(decimals);
  const int = v / base;
  let frac = (v % base).toString().padStart(decimals, '0').slice(0, maxFrac).replace(/0+$/, '');
  return (neg ? '-' : '') + int.toString() + (frac ? '.' + frac : '');
}

/** USDC micro (6 decimals) from a decimal string, rounding up (for ceilings). */
export const usdcMicro = (s: string): bigint => parseUnits(s, 6);
export const usdcStr = (micro: bigint): string => formatUnits(micro, 6);

/** x × num / den rounded up, on integers. */
export const mulDivUp = (x: bigint, num: bigint, den: bigint): bigint => (x * num + den - 1n) / den;
