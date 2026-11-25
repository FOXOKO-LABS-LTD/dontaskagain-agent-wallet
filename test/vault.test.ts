import { createVault, unlockVault, encryptWithRawKey, KDF_ITERATIONS, encryptJSON, decryptJSON } from '../src/lib/crypto/vault';

describe('vault (PBKDF2 600k + AES-256-GCM)', () => {
  const data = { secrets: { mnemonic: 'abandon … about', imported: {} }, book: [1, 2, 3] };
  it('round trip, params on disk', async () => {
    const { blob, rawKey } = await createVault('correct horse battery', data);
    expect(blob.kdf.iterations).toBe(600_000);
    expect(KDF_ITERATIONS).toBeGreaterThanOrEqual(600_000);
    expect(atob(blob.kdf.salt).length).toBe(16);
    expect(atob(blob.cipher.iv).length).toBe(12);
    expect(JSON.stringify(blob)).not.toContain('abandon');
    const u = await unlockVault('correct horse battery', blob);
    expect(u.data).toEqual(data);
    expect(Array.from(u.rawKey)).toEqual(Array.from(rawKey));
  });
  it('wrong password and tampering fail', async () => {
    const { blob } = await createVault('correct horse battery', data);
    await expect(unlockVault('wrong horse battery', blob)).rejects.toThrow('BAD_PASSWORD');
    const ct = atob(blob.ct).split('');
    ct[3] = String.fromCharCode(ct[3].charCodeAt(0) ^ 1);
    await expect(unlockVault('correct horse battery', { ...blob, ct: btoa(ct.join('')) })).rejects.toThrow('BAD_PASSWORD');
  });
  it('re-encrypt with the session key (no password), fresh IV, same password opens it', async () => {
    const { blob, rawKey } = await createVault('correct horse battery', data);
    const b2 = await encryptWithRawKey(rawKey, blob.kdf, { ...data, book: [9] });
    expect(b2.cipher.iv).not.toBe(blob.cipher.iv);
    expect((await unlockVault<typeof data>('correct horse battery', b2)).data.book).toEqual([9]);
  });
  it('short password and weak KDF refused', async () => {
    await expect(createVault('short', data)).rejects.toThrow('PASSWORD_TOO_SHORT');
    const weak = await encryptJSON('correct horse battery', data, 1000);
    await expect(decryptJSON('correct horse battery', weak)).rejects.toThrow('WEAK_KDF');
  });
});
