import { utils } from 'tronweb';
import { expectedChallenge, checkChallenge, signChallenge } from '../src/lib/signer/auth';
import { recoverEvmMessage, recoverTronMessage, signTronMessage } from '../src/lib/sign';
import { hdKeys, hdAddresses, seedFromMnemonic } from '../src/lib/wallet/derive';

const ABOUT = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seed = seedFromMnemonic(ABOUT);
const keys = hdKeys(seed, 0), addr = hdAddresses(seed, 0);
const EXT = 'abcdefghijklmnopabcdefghijklmnop';
const now = Date.parse('2026-11-17T12:01:00Z');
const params = { host: '127.0.0.1:9985', extensionId: EXT, tron: addr.tron, evm: addr.evm, nonce: 'AAAAAAAAAAAAAAAAAAAAAA', issuedAt: '2026-11-17T12:00:00Z', expiresAt: '2026-11-17T12:05:00Z' };

describe('sign-in challenge', () => {
  const message = expectedChallenge(params);
  it('template', () => {
    expect(message.split('\n')).toHaveLength(9);
    expect(message).toContain(`TRON: ${addr.tron}\nEVM: 0x9858EfFD232B4033E47d90003D41EC34EcaEda94\n`);
  });
  it('accepts our own challenge, refuses foreign ones', () => {
    const want = { host: params.host, extensionId: EXT, tron: addr.tron, evm: addr.evm };
    expect(() => checkChallenge({ nonce: params.nonce, message, expires_at: params.expiresAt }, want, now)).not.toThrow();
    expect(() => checkChallenge({ nonce: params.nonce, message: message.replace('127.0.0.1:9985', 'evil.example'), expires_at: '' }, want, now)).toThrow(/service/);
    expect(() => checkChallenge({ nonce: params.nonce, message: message + '\nextra', expires_at: '' }, want, now)).toThrow(/unexpected/);
    expect(() => checkChallenge({ nonce: 'BBBBBBBBBBBBBBBBBBBBBB', message, expires_at: '' }, want, now)).toThrow(/nonce/);
    expect(() => checkChallenge({ nonce: params.nonce, message, expires_at: '' }, want, now + 3600_000)).toThrow(/expired/);
    expect(() => checkChallenge({ nonce: params.nonce, message: message.replace('0x9858EfFD232B4033E47d90003D41EC34EcaEda94', '0x9858effd232b4033e47d90003d41ec34ecaeda94'), expires_at: '' }, want, now)).toThrow(/EVM/);
  });
  it('both signatures recover the root addresses; TIP-191 equals tronweb', async () => {
    const s = await signChallenge(message, keys);
    expect(await recoverEvmMessage(message, s.sig_evm)).toBe(addr.evm);
    expect(await recoverTronMessage(message, s.sig_tron)).toBe(addr.tron);
    const tw = utils.message.signMessage(message, keys.tronKey.slice(2));
    expect(s.sig_tron.toLowerCase()).toBe(tw.toLowerCase());
    expect(utils.message.verifyMessage(message, s.sig_tron)).toBe(addr.tron);
    expect(await signTronMessage(message, keys.tronKey)).toBe(s.sig_tron);
  });
});
