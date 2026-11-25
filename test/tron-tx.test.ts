import { utils } from 'tronweb';
import { rawTransferTrx, rawTrigger, decodeRaw, txIdOf, trc20TransferData, refFromBlockId, signedTxHex, bandwidthOfRaw } from '../src/lib/tron/tx';
import { tronToHex41 } from '../src/lib/tron/address';
import { bytesToHex } from '../src/lib/bytes';
import { signTronTxId, recoverTronTxSigner } from '../src/lib/sign';
import { hdKeys, seedFromMnemonic, hdAddresses } from '../src/lib/wallet/derive';

const ABOUT = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seed = seedFromMnemonic(ABOUT);
const A0 = hdAddresses(seed, 0).tron, A1 = hdAddresses(seed, 1).tron;
const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const blockID = '0000000004b8a1c2' + 'abcdef0123456789' + '00112233445566778899aabbccddeeff';
const common = { ...refFromBlockId(blockID), expiration: 1763400000000, timestamp: 1763399400000 };

/** tronweb as an independent oracle: JSON raw_data → protobuf → raw hex / txID. */
function oracle(raw_data: object) {
  const pb = utils.transaction.txJsonToPb({ raw_data });
  return { hex: utils.transaction.txPbToRawDataHex(pb).toLowerCase(), txID: utils.transaction.txPbToTxID(pb).replace(/^0x/, '') };
}

describe('TRON transactions built locally', () => {
  it('ref block from blockID', () => { expect(common.refBytes).toBe('a1c2'); expect(common.refHash).toBe('abcdef0123456789'); });

  it('TRX TransferContract: bytes and txID equal tronweb', () => {
    const raw = rawTransferTrx({ ...common, owner: A0, to: A1, amountSun: 1_500_000n });
    const o = oracle({ contract: [{ parameter: { value: { owner_address: tronToHex41(A0), to_address: tronToHex41(A1), amount: 1_500_000 }, type_url: 'type.googleapis.com/protocol.TransferContract' }, type: 'TransferContract' }],
      ref_block_bytes: common.refBytes, ref_block_hash: common.refHash, expiration: common.expiration, timestamp: common.timestamp });
    expect(bytesToHex(raw)).toBe(o.hex);
    expect(txIdOf(raw)).toBe(o.txID);
  });

  it('USDT TriggerSmartContract with fee_limit: bytes and txID equal tronweb', () => {
    const data = trc20TransferData(A1, 25_000_000n);
    const raw = rawTrigger({ ...common, feeLimit: 30_000_000, owner: A0, contract: USDT, dataHex: data });
    const o = oracle({ contract: [{ parameter: { value: { owner_address: tronToHex41(A0), contract_address: tronToHex41(USDT), data }, type_url: 'type.googleapis.com/protocol.TriggerSmartContract' }, type: 'TriggerSmartContract' }],
      ref_block_bytes: common.refBytes, ref_block_hash: common.refHash, expiration: common.expiration, timestamp: common.timestamp, fee_limit: 30_000_000 });
    expect(bytesToHex(raw)).toBe(o.hex);
    expect(txIdOf(raw)).toBe(o.txID);
  });

  it('decoder reads back what was built', () => {
    const raw = rawTrigger({ ...common, feeLimit: 45_000_000, owner: A0, contract: USDT, dataHex: trc20TransferData(A1, 7n) });
    const d = decodeRaw(bytesToHex(raw));
    expect(d.type).toBe('TriggerSmartContract');
    expect(d.owner).toBe(A0); expect(d.contract).toBe(USDT);
    expect(d.trc20).toEqual({ to: A1, amountRaw: 7n });
    expect(d.feeLimit).toBe(45_000_000); expect(d.expiration).toBe(common.expiration);
    const t = decodeRaw(bytesToHex(rawTransferTrx({ ...common, owner: A1, to: A0, amountSun: 1n })));
    expect(t).toMatchObject({ type: 'TransferContract', owner: A1, to: A0, amountSun: 1n, feeLimit: 0 });
  });

  it('signature over txID recovers the owner; signed hex size = bandwidth − 64', async () => {
    const raw = rawTransferTrx({ ...common, owner: A0, to: A1, amountSun: 1n });
    const txID = txIdOf(raw);
    const sig = await signTronTxId(txID, hdKeys(seed, 0).tronKey);
    expect(sig).toHaveLength(130);
    expect(await recoverTronTxSigner(txID, sig)).toBe(A0);
    const hex = signedTxHex({ txID, raw_data_hex: bytesToHex(raw), signature: [sig] });
    expect(hex.length / 2 + 64).toBe(bandwidthOfRaw(raw));
  });
});
