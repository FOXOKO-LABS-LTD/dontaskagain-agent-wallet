import { verifyTypedData, getAddress } from 'viem';
import { decodePaymentRequired, pickResourceTerms, signResourcePayment, AUTH_TYPES } from '../src/lib/x402/pay';
import { hdKeys, hdAddresses, seedFromMnemonic } from '../src/lib/wallet/derive';
import { base64ToBytes, fromUtf8, bytesToBase64, utf8 } from '../src/lib/bytes';

const seed = seedFromMnemonic('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PAYTO = '0x16dDE7b0A9b092c4Dd985af5D9Ca04e389b3c87E';
const pr = {
  x402Version: 2, resource: { url: 'http://127.0.0.1:9975/x402/v1/tron/send', description: 'send' },
  accepts: [{ scheme: 'exact', network: 'eip155:8453', amount: '481200', asset: USDC, payTo: PAYTO, maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } }],
};
const raw = bytesToBase64(utf8(JSON.stringify(pr)));

describe('x402 resource payment', () => {
  it('decodes base64, JSON text and objects', () => {
    expect(decodePaymentRequired(raw).accepts[0].amount).toBe('481200');
    expect(decodePaymentRequired(JSON.stringify(pr)).x402Version).toBe(2);
    expect(decodePaymentRequired(pr).x402Version).toBe(2);
    expect(() => decodePaymentRequired('bm9wZQ==')).toThrow();
  });
  it('accepts only exact / Base / USDC / built-in payTo / built-in domain', () => {
    expect(pickResourceTerms(decodePaymentRequired(raw)).amountMicro).toBe(481200n);
    const bad = (patch: object) => ({ ...pr, accepts: [{ ...pr.accepts[0], ...patch }] });
    expect(() => pickResourceTerms(bad({ payTo: '0x000000000000000000000000000000000000dEaD' }))).toThrow(/payTo/);
    expect(() => pickResourceTerms(bad({ extra: { name: 'USDC', version: '2' } }))).toThrow(/domain/);
    expect(() => pickResourceTerms(bad({ network: 'eip155:1' }))).toThrow(/UNSUPPORTED/);
    expect(() => pickResourceTerms(bad({ scheme: 'upto' }))).toThrow(/UNSUPPORTED/);
    expect(() => pickResourceTerms(bad({ maxTimeoutSeconds: 86400 }))).toThrow(/maxTimeout/);
    expect(() => pickResourceTerms({ ...pr, x402Version: 1 })).toThrow(/version/);
  });
  it('EIP-3009 signature verifies for the account Base address; header = base64(PaymentPayload v2)', async () => {
    const k = hdKeys(seed, 1), from = hdAddresses(seed, 1).evm;
    const p = decodePaymentRequired(raw);
    const now = 1_763_400_000;
    const s = await signResourcePayment(p, pickResourceTerms(p), k.evmKey, now);
    const decoded = JSON.parse(fromUtf8(base64ToBytes(s.payment_signature)));
    expect(decoded).toEqual(s.payment_payload);
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepted).toEqual(pr.accepts[0]);
    expect(decoded.resource).toEqual(pr.resource);
    const a = decoded.payload.authorization;
    expect(a).toMatchObject({ from, to: getAddress(PAYTO), value: '481200', validAfter: String(now - 600), validBefore: String(now + 60) });
    expect(a.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    const ok = await verifyTypedData({ address: from, domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC },
      types: AUTH_TYPES, primaryType: 'TransferWithAuthorization',
      message: { from, to: getAddress(PAYTO), value: 481200n, validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce }, signature: decoded.payload.signature });
    expect(ok).toBe(true);
  });
});
