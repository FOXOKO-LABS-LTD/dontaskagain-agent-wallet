// A CCTP-shaped attestation for tests (0.3.2): two ECDSA signatures over keccak256(message) by throwaway
// keys, signers in increasing order — what checkAttestation accepts. Not Circle's attesters (the contract checks that).
import { keccak256, type Hex } from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';

const KEYS: Hex[] = ['0x' + '11'.repeat(32), '0x' + '22'.repeat(32)] as Hex[];

export async function attest(message: Hex, keys: Hex[] = KEYS): Promise<Hex> {
  const h = keccak256(message);
  const signers = keys.map((k) => ({ k, a: BigInt(privateKeyToAccount(k).address) })).sort((x, y) => (x.a < y.a ? -1 : 1));
  let out = '0x';
  for (const s of signers) out += (await sign({ hash: h, privateKey: s.k, to: 'hex' })).slice(2);
  return out as Hex;
}
