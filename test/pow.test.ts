// Proof of work at wallet registration: the reference vector, the client-side cap,
// task checks.
import { checkPowTask, leadingZeroBits, powHash, solvePow, POW_MAX_BITS } from '../src/lib/signer/pow';
import { bytesToHex } from '@noble/hashes/utils.js';

describe('PoW', () => {
  it('reference vector: salt 0011…eeff, nonce AbCd…Uv, 12 bits → "17009"', async () => {
    const t = checkPowTask({ alg: 'sha256', bits: 12, salt: '00112233445566778899aabbccddeeff', expires_at: new Date(Date.now() + 60_000).toISOString() });
    expect(await solvePow(t, 'AbCdEfGhIjKlMnOpQrStUv')).toBe('17009');
    expect(bytesToHex(powHash(t.salt, 'AbCdEfGhIjKlMnOpQrStUv', '17009'))).toBe('00007ce86ebf9149a698b7448a134cec11aa75e52b4c6afaf19c87b4d602defa');
    expect(leadingZeroBits(powHash(t.salt, 'AbCdEfGhIjKlMnOpQrStUv', '17009'))).toBeGreaterThanOrEqual(12);
  });
  it('hostile or malformed tasks are refused', () => {
    expect(() => checkPowTask({ alg: 'sha256', bits: POW_MAX_BITS + 1, salt: 'aa' })).toThrow(/POW_TOO_HARD/);
    expect(() => checkPowTask({ alg: 'md5', bits: 8, salt: 'aa' })).toThrow(/POW_UNSUPPORTED/);
    expect(() => checkPowTask({ alg: 'sha256', bits: 8, salt: 'x"; drop' })).toThrow(/POW_BAD/);
    expect(() => checkPowTask({ alg: 'sha256', bits: 0, salt: 'aa' })).toThrow(/POW_BAD/);
  });
  it('progress is reported and an expired task stops', async () => {
    const seen: number[] = [];
    await expect(solvePow({ alg: 'sha256', bits: 26, salt: 'aa' }, 'n', { chunk: 1000, deadline: Date.now() - 1, onProgress: (p) => seen.push(p.tried) })).rejects.toThrow(/POW_EXPIRED/);
    expect(seen[0]).toBe(1000);
  });
});
