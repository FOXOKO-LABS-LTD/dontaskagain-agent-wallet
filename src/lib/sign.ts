// Signatures made by the extension. Only text with a prefix (TIP-191 / EIP-191), our own built TRON txID, and the
// EIP-712 TransferWithAuthorization built by the extension itself (the Signer never builds what the wallet signs).
import { keccak256, toBytes, concat, recoverAddress, hashMessage } from 'viem';
import { sign, privateKeyToAccount } from 'viem/accounts';
import { utf8, bytesToHex, hexToBytes } from './bytes';
import { tronFromEvm } from './tron/address';

/** TIP-191 (signMessageV2): keccak256("\x19TRON Signed Message:\n" + len(bytes) + bytes). */
export function tronMessageHash(message: string): `0x${string}` {
  const b = utf8(message);
  return keccak256(concat([toBytes('\x19TRON Signed Message:\n' + b.length), b]));
}

/** 65-byte r||s||v (v = 27/28), 0x-prefixed, as tronweb signMessageV2. */
export async function signTronMessage(message: string, tronKey: `0x${string}`): Promise<`0x${string}`> {
  return sign({ hash: tronMessageHash(message), privateKey: tronKey, to: 'hex' });
}

export async function recoverTronMessage(message: string, sig: `0x${string}`): Promise<string> {
  return tronFromEvm(await recoverAddress({ hash: tronMessageHash(message), signature: sig }));
}

/** EIP-191 personal_sign. */
export async function signEvmMessage(message: string, evmKey: `0x${string}`): Promise<`0x${string}`> {
  return privateKeyToAccount(evmKey).signMessage({ message });
}

export async function recoverEvmMessage(message: string, sig: `0x${string}`): Promise<`0x${string}`> {
  return recoverAddress({ hash: hashMessage(message), signature: sig });
}

/** TRON transaction signature over txID (= sha256(raw_data)): hex r||s||v without 0x, as the node expects. */
export async function signTronTxId(txID: string, tronKey: `0x${string}`): Promise<string> {
  if (!/^[0-9a-f]{64}$/.test(txID)) throw new Error('bad txID');
  const s = await sign({ hash: ('0x' + txID) as `0x${string}`, privateKey: tronKey, to: 'hex' });
  return s.slice(2);
}

export async function recoverTronTxSigner(txID: string, sigHex: string): Promise<string> {
  return tronFromEvm(await recoverAddress({ hash: ('0x' + txID) as `0x${string}`, signature: ('0x' + sigHex) as `0x${string}` }));
}

export { bytesToHex, hexToBytes };
