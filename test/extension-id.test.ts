// 0.3.14: the extension id is fixed by the public key in the manifest ("key"), so every install (the zip, a build from
// source, the Chrome Web Store item) has the same id. The authorize page of the Signer messages the extension by this id
// (externally_connectable), so it must never change by accident.
import { createHash } from 'node:crypto';
import manifest from '../public/manifest.json';

const EXTENSION_ID = 'lfjhjcdnafhiageojbcodejdhlohelea';

/** Chrome's id of an extension: the first 128 bits of sha256 over the DER public key, hex digits 0-f written as a-p. */
const idOf = (keyB64: string) =>
  [...createHash('sha256').update(Buffer.from(keyB64, 'base64')).digest('hex').slice(0, 32)]
    .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
    .join('');

describe('extension id', () => {
  it('the manifest key is a public key (SubjectPublicKeyInfo, RSA 2048), not a private one', () => {
    const der = Buffer.from((manifest as { key: string }).key, 'base64');
    expect(der.length).toBe(294);
    expect(der.subarray(0, 4).toString('hex')).toBe('30820122');
    expect((manifest as { key: string }).key).not.toMatch(/PRIVATE|BEGIN|\s/);
  });
  it('the key gives the fixed id', () => {
    expect(idOf((manifest as { key: string }).key)).toBe(EXTENSION_ID);
  });
  it('only the public Signer may message the extension', () => {
    expect(manifest.externally_connectable).toEqual({ matches: ['https://signer.dontaskagain.xyz/*'] });
  });
});
