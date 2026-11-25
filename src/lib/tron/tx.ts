// TRON transactions built locally (raw_data like rawTrigger in e2e.mjs) and decoded back from the very bytes
// that will be signed, so the sign window shows what is signed, not what the server said.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes, utf8, fromUtf8 } from '../bytes';
import { tronFromHex41, tronToHex41 } from './address';

// ---------- protobuf writer ----------
function varint(n: bigint | number): Uint8Array {
  let v = BigInt(n);
  if (v < 0n) throw new Error('negative varint');
  const o: number[] = [];
  do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; o.push(b); } while (v);
  return new Uint8Array(o);
}
const fBytes = (f: number, b: Uint8Array) => concatBytes(varint((f << 3) | 2), varint(b.length), b);
const fNum = (f: number, v: bigint | number) => (BigInt(v) ? concatBytes(varint(f << 3), varint(v)) : new Uint8Array(0));

export const CONTRACT_TRANSFER = 1;
export const CONTRACT_TRIGGER = 31;
const TYPE_URL: Record<number, string> = {
  [CONTRACT_TRANSFER]: 'type.googleapis.com/protocol.TransferContract',
  [CONTRACT_TRIGGER]: 'type.googleapis.com/protocol.TriggerSmartContract',
};

export interface RefBlock { refBytes: string; refHash: string; } // hex, 2 + 8 bytes

/** From getnowblock.blockID (64 hex): bytes 6..8 and 8..16. */
export function refFromBlockId(blockID: string): RefBlock {
  if (!/^[0-9a-f]{64}$/i.test(blockID)) throw new Error('bad blockID');
  return { refBytes: blockID.slice(12, 16).toLowerCase(), refHash: blockID.slice(16, 32).toLowerCase() };
}

export interface RawCommon extends RefBlock { expiration: number; timestamp: number; feeLimit?: number; }

function rawData(c: RawCommon, type: number, value: Uint8Array): Uint8Array {
  const any = concatBytes(fBytes(1, utf8(TYPE_URL[type])), fBytes(2, value));
  const contract = concatBytes(fNum(1, type), fBytes(2, any));
  return concatBytes(
    fBytes(1, hexToBytes(c.refBytes)), fBytes(4, hexToBytes(c.refHash)), fNum(8, c.expiration),
    fBytes(11, contract), fNum(14, c.timestamp), fNum(18, c.feeLimit ?? 0),
  );
}

export function rawTransferTrx(c: RawCommon & { owner: string; to: string; amountSun: bigint }): Uint8Array {
  const v = concatBytes(fBytes(1, hexToBytes(tronToHex41(c.owner))), fBytes(2, hexToBytes(tronToHex41(c.to))), fNum(3, c.amountSun));
  return rawData({ ...c, feeLimit: 0 }, CONTRACT_TRANSFER, v);
}

export function rawTrigger(c: RawCommon & { owner: string; contract: string; dataHex: string; callValue?: bigint }): Uint8Array {
  const v = concatBytes(fBytes(1, hexToBytes(tronToHex41(c.owner))), fBytes(2, hexToBytes(tronToHex41(c.contract))), fNum(3, c.callValue ?? 0n), fBytes(4, hexToBytes(c.dataHex)));
  return rawData(c, CONTRACT_TRIGGER, v);
}

/** transfer(address,uint256) calldata. */
export function trc20TransferData(to: string, amountRaw: bigint): string {
  return 'a9059cbb' + tronToHex41(to).slice(2).padStart(64, '0') + amountRaw.toString(16).padStart(64, '0');
}

export const txIdOf = (raw: Uint8Array): string => bytesToHex(sha256(raw));

export interface SignedTronTx { txID: string; raw_data_hex: string; signature: string[]; }

/** Signed Transaction protobuf hex (raw_data field 1 + signature field 2) — for broadcasthex / size. */
export function signedTxHex(tx: SignedTronTx): string {
  return bytesToHex(concatBytes(fBytes(1, hexToBytes(tx.raw_data_hex)), ...tx.signature.map((s) => fBytes(2, hexToBytes(s)))));
}

/** Bandwidth a transaction consumes ≈ serialized signed tx + 64 (as tron/estimate). A 65-byte signature is
 * assumed before signing (its size is fixed). */
export function bandwidthOfRaw(raw: Uint8Array, signatures = 1): number {
  const signedLen = fBytes(1, raw).length + signatures * fBytes(2, new Uint8Array(65)).length;
  return signedLen + 64;
}

// ---------- protobuf reader (only what we build) ----------
interface Field { f: number; wt: number; v: bigint | Uint8Array; }
function readFields(b: Uint8Array): Field[] {
  const out: Field[] = [];
  let i = 0;
  const rv = (): bigint => { let r = 0n, s = 0n; for (;;) { if (i >= b.length) throw new Error('truncated'); const x = b[i++]; r |= BigInt(x & 0x7f) << s; if (!(x & 0x80)) return r; s += 7n; } };
  while (i < b.length) {
    const key = Number(rv()); const f = key >> 3, wt = key & 7;
    if (wt === 0) out.push({ f, wt, v: rv() });
    else if (wt === 2) { const n = Number(rv()); if (i + n > b.length) throw new Error('truncated'); out.push({ f, wt, v: b.slice(i, i + n) }); i += n; }
    else throw new Error('unsupported wire type ' + wt);
  }
  return out;
}
const one = (fs: Field[], f: number) => fs.filter((x) => x.f === f);

export interface DecodedTx {
  txID: string; refBytes: string; refHash: string; expiration: number; timestamp: number; feeLimit: number;
  type: 'TransferContract' | 'TriggerSmartContract' | 'other';
  owner: string; to?: string; amountSun?: bigint; contract?: string; data?: string; callValue?: bigint;
  trc20?: { to: string; amountRaw: bigint } | null;
}

export function decodeRaw(rawHex: string): DecodedTx {
  const raw = hexToBytes(rawHex);
  const fs = readFields(raw);
  const num = (f: number) => Number((one(fs, f)[0]?.v as bigint) ?? 0n);
  const bytes = (f: number) => (one(fs, f)[0]?.v as Uint8Array) ?? new Uint8Array();
  const contracts = one(fs, 11);
  if (contracts.length !== 1) throw new Error('exactly one contract expected');
  const cf = readFields(contracts[0].v as Uint8Array);
  const ctype = Number((one(cf, 1)[0]?.v as bigint) ?? 0n);
  const anyF = readFields(one(cf, 2)[0].v as Uint8Array);
  const typeUrl = fromUtf8(one(anyF, 1)[0].v as Uint8Array);
  const val = readFields(one(anyF, 2)[0].v as Uint8Array);
  const addr = (f: number) => { const b = one(val, f)[0]?.v as Uint8Array | undefined; return b ? tronFromHex41(bytesToHex(b)) : ''; };
  const base = { txID: txIdOf(raw), refBytes: bytesToHex(bytes(1)), refHash: bytesToHex(bytes(4)), expiration: num(8), timestamp: num(14), feeLimit: num(18) };
  if (ctype === CONTRACT_TRANSFER && typeUrl === TYPE_URL[CONTRACT_TRANSFER]) {
    return { ...base, type: 'TransferContract', owner: addr(1), to: addr(2), amountSun: (one(val, 3)[0]?.v as bigint) ?? 0n };
  }
  if (ctype === CONTRACT_TRIGGER && typeUrl === TYPE_URL[CONTRACT_TRIGGER]) {
    const data = bytesToHex((one(val, 4)[0]?.v as Uint8Array) ?? new Uint8Array());
    let trc20: DecodedTx['trc20'] = null;
    if (data.length === 8 + 128 && data.startsWith('a9059cbb') && /^0{24}$/.test(data.slice(8, 32))) {
      trc20 = { to: tronFromHex41('41' + data.slice(32, 72)), amountRaw: BigInt('0x' + data.slice(72)) };
    }
    return { ...base, type: 'TriggerSmartContract', owner: addr(1), contract: addr(2), data, callValue: (one(val, 3)[0]?.v as bigint) ?? 0n, trc20 };
  }
  return { ...base, type: 'other', owner: '' };
}
