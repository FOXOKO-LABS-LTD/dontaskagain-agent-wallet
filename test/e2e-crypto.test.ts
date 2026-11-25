// the reference vectors (test/fixtures/e2e-vectors.json) byte for byte.
import V from './fixtures/e2e-vectors.json';
import { aadOf, b64u, bundleOf, decrypt, ed25519Pub, fingerprint, generateKeys, keyId, open, pairProof, parseBundle, seal, sigMessage, unb64u, verifyEnvelope, x25519Pub } from '../src/lib/e2e/crypto';

const K = V.keys;
const priv = (s: string) => unb64u(s);

describe('e2e crypto vectors', () => {
  it('keys, bundles, fingerprints, key ids', () => {
    for (const k of [K.agent, K.wallet]) {
      expect(b64u(ed25519Pub(priv(k.sig_priv)))).toBe(k.sig_pub);
      expect(b64u(x25519Pub(priv(k.kex_priv)))).toBe(k.kex_pub);
      expect(bundleOf({ sig: unb64u(k.sig_pub), kex: unb64u(k.kex_pub) })).toBe(k.bundle);
      expect(fingerprint(unb64u(k.sig_pub), unb64u(k.kex_pub))).toBe(k.fp);
      expect(keyId(unb64u(k.kex_pub))).toBe(k.rk);
      const pb = parseBundle(k.bundle);
      expect(b64u(pb.sig)).toBe(k.sig_pub);
    }
  });

  it('seal reproduces the envelopes; open gives the payload', async () => {
    const cases = [
      { v: V.envelopes[0], sender: K.agent, rcpt: K.wallet },
      { v: V.envelopes[1], sender: K.wallet, rcpt: K.agent },
    ];
    for (const c of cases) {
      const e = c.v.envelope as any;
      expect(aadOf(e)).toBe(c.v.aad);
      expect(sigMessage(e, unb64u(e.ct))).toBe(c.v.sig_message);
      const s = await seal({ id: e.id, wallet_id: e.wallet_id, from: e.from, to: e.to, at: e.at, payload: c.v.payload, senderSigPriv: priv(c.sender.sig_priv),
        recipientKex: unb64u(c.rcpt.kex_pub), eph: priv(c.v.eph_priv!), nonce: unb64u(c.v.nonce!) });
      expect(s).toEqual(e);
      expect(await open(e, unb64u(c.sender.sig_pub), priv(c.rcpt.kex_priv))).toEqual(c.v.payload);
    }
  });

  it('invalid envelopes are refused before decryption', async () => {
    for (const bad of V.envelopes.filter((x) => !x.valid)) {
      expect(verifyEnvelope(bad.envelope as any, unb64u(K.agent.sig_pub))).toBe(false);
      await expect(open(bad.envelope as any, unb64u(K.agent.sig_pub), priv(K.wallet.kex_priv))).rejects.toThrow(bad.error!);
    }
  });

  it('wrong recipient key → E2E_WRONG_KEY', async () => {
    await expect(decrypt(V.envelopes[0].envelope as any, priv(K.agent.kex_priv))).rejects.toThrow('E2E_WRONG_KEY');
  });

  it('pairing proof', () => {
    const p = V.pairing;
    expect(pairProof(p.code, { wallet_id: p.wallet_id, agent_id: p.agent_id, sig: p.sig, kex: p.kex, wallet_fp: p.wallet_fp })).toBe(p.proof);
    expect(pairProof(b64u(new Uint8Array(16)), { wallet_id: p.wallet_id, agent_id: p.agent_id, sig: p.sig, kex: p.kex, wallet_fp: p.wallet_fp })).not.toBe(p.proof);
  });

  it('random keys round trip', async () => {
    const a = generateKeys(), w = generateKeys();
    const e = await seal({ wallet_id: 'wal_x', from: 'ag_x', to: 'wallet', payload: { t: 'ping', n: 1 }, senderSigPriv: a.sig_priv, recipientKex: w.kex });
    expect(await open(e, a.sig, w.kex_priv)).toEqual({ t: 'ping', n: 1 });
  });
});
