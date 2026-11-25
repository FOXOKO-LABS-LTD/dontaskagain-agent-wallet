// EVM: calldata builders against the shared vectors (viem-generated, also used by the Signer's Go tests),
// decoding of signed type-2 transactions, the CCTP fee formula, the Iris message, and the own byte checks — every
// substitution is refused.
import V from './fixtures/evm-vectors.json';
import { approveData, burnData, depositEthData, depositETHData, receiveMessageData, transferData, CCTP_FORWARD_HOOK } from '../src/lib/evm/abi';
import { bridgePlan, maxFeeOf, parseMessage, verifyMessage } from '../src/lib/evm/cctp';
import { decodeTx, signChecked, unsignedHex, type Unsigned } from '../src/lib/evm/tx';
import { verifyApproveTx, verifyBurnTx, verifyMintTx, verifyRefuelTx, verifyTransferTx } from '../src/lib/evm/verify';
import { requireNet, usdcOf } from '../src/lib/evm/networks';
import type { Hex } from 'viem';

const ME = V.address;
const USDC_ARB = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const TO = '0x3214a0bf8a5be0d3f2a9f1d2c3b4a5968776b67c';
const tx = (n: string) => V.txs.find((t) => t.name === n)!;

describe('calldata (shared vectors)', () => {
  it('builders reproduce the vectors byte for byte', () => {
    expect(approveData(V.token_messenger, 20002801n)).toBe(V.calls.approve);
    expect(transferData(TO, 40_000_000n)).toBe(V.calls.transfer);
    expect(burnData({ amount: 20002801n, destinationDomain: 6, mintRecipient: ME, burnToken: USDC_ARB, maxFee: 2801n, minFinalityThreshold: 1000, forwarding: false })).toBe(V.calls.depositForBurn);
    expect(burnData({ amount: 20057988n, destinationDomain: 6, mintRecipient: ME, burnToken: USDC_ARB, maxFee: 57988n, minFinalityThreshold: 1000, forwarding: true })).toBe(V.calls.depositForBurnWithHook);
    expect(receiveMessageData(V.iris_message.message as Hex, V.iris_message.attestation as Hex)).toBe(V.calls.receiveMessage);
    expect(depositETHData(200_000)).toBe(V.calls.depositETH);
    expect(depositEthData()).toBe(V.calls.depositEth);
    expect(CCTP_FORWARD_HOOK).toBe(V.hook_data);
  });
  it('signed vectors decode: chainId, from, to, value, data, hash', async () => {
    for (const t of V.txs) {
      const d = await decodeTx(t.raw as Hex);
      expect([d.chainId, d.nonce, d.from, d.to.toLowerCase(), d.value.toString(), d.data, d.hash]).toEqual([t.chain_id, t.nonce, t.from, t.to.toLowerCase(), t.value, t.data, t.hash]);
      expect(d.call).not.toBeNull();
    }
  });
  it('non type-2 and junk after arguments are refused', async () => {
    await expect(decodeTx('0xf86c' as Hex)).rejects.toThrow(/EIP-1559/);
    const u: Unsigned = { chainId: 1, nonce: 0, to: TO as any, value: 0n, data: (V.calls.transfer + '00') as Hex, gas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n };
    expect((await decodeTx(unsignedHex(u))).call).toBeNull();
  });
});

describe('CCTP fee', () => {
  it('reproduces every vector', () => {
    for (const f of V.fees) {
      const r = maxFeeOf(BigInt(f.amount), f.f, BigInt(f.fwd));
      expect([r.maxFee.toString(), r.burn.toString()]).toEqual([f.max_fee, f.burn]);
    }
  });
  it('plan: fast row, forwarding med, standard without fee; source without fast → standard', () => {
    const fees = [{ finalityThreshold: 1000, minimumFee: 1.4, forwardFee: { low: 53312, med: 55107, high: 56440 } }, { finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: 53312, med: 55107, high: 56440 } }];
    expect(bridgePlan({ amount: 20_000_000n, mode: 'fast', srcFast: true, forwarding: false, fees })).toMatchObject({ finality_threshold: 1000, max_fee: 2801n, burn: 20_002_801n });
    expect(bridgePlan({ amount: 20_000_000n, mode: 'fast', srcFast: true, forwarding: true, fees })).toMatchObject({ max_fee: 57_916n });
    expect(bridgePlan({ amount: 20_000_000n, mode: 'standard', srcFast: true, forwarding: false, fees })).toMatchObject({ finality_threshold: 2000, max_fee: 0n });
    expect(bridgePlan({ amount: 1_000_000n, mode: 'fast', srcFast: false, forwarding: true, fees })).toMatchObject({ mode_effective: 'standard', max_fee: 55_107n });
  });
});

describe('Iris message (fixture Arbitrum → Polygon)', () => {
  const m = parseMessage(V.iris_message.message);
  const dm = V.iris_message.decodedMessage;
  it('parses header and BurnMessageV2', () => {
    expect([m.sourceDomain, m.destinationDomain, m.nonce]).toEqual([3, 7, dm.nonce]);
    expect(m.body.amount.toString()).toBe(dm.decodedMessageBody.amount);
    expect(m.body.maxFee.toString()).toBe(dm.decodedMessageBody.maxFee);
    expect(m.body.feeExecuted.toString()).toBe(dm.decodedMessageBody.feeExecuted);
    expect(m.body.expirationBlock.toString()).toBe(dm.decodedMessageBody.expirationBlock);
    expect(m.body.mintRecipient.toLowerCase()).toBe(dm.decodedMessageBody.mintRecipient);
    expect(m.body.hookData).toBe(dm.decodedMessageBody.hookData);
  });
  it('verifies against the expected bridge (forwarding-style caller) and refuses another recipient / amount / domain', () => {
    const e = { srcDomain: 3, dstDomain: 7, tokenMessenger: V.token_messenger, burnToken: USDC_ARB, recipient: dm.decodedMessageBody.mintRecipient, amount: 24745818n, forwarding: true };
    expect(() => verifyMessage(m, e)).not.toThrow();
    expect(() => verifyMessage(m, { ...e, forwarding: false })).toThrow(/destinationCaller/);
    expect(() => verifyMessage(m, { ...e, recipient: ME })).toThrow(/mintRecipient/);
    expect(() => verifyMessage(m, { ...e, amount: 1n })).toThrow(/amount/);
    expect(() => verifyMessage(m, { ...e, dstDomain: 6 })).toThrow(/destinationDomain/);
  });
});

describe('own byte checks refuse substitutions', () => {
  const arb = requireNet('evm:42161');
  const burnX = { chainId: 42161, tokenMessenger: V.token_messenger, burnToken: usdcOf('evm:42161').address, recipient: ME, dstDomain: 6, burn: 20002801n, maxFee: 2801n, finality: 1000, forwarding: false };
  it('approve', async () => {
    const d = await decodeTx(tx('approve_arb').raw as Hex);
    verifyApproveTx(d, { chainId: 42161, token: USDC_ARB, spender: V.token_messenger, amount: 20002801n });
    expect(() => verifyApproveTx(d, { chainId: 42161, token: USDC_ARB, spender: TO, amount: 20002801n })).toThrow(/spender/);
    expect(() => verifyApproveTx(d, { chainId: 42161, token: USDC_ARB, spender: V.token_messenger, amount: 1n })).toThrow(/amount/);
  });
  it('burn self / forwarding', async () => {
    const d = await decodeTx(tx('burn_self_arb_to_base').raw as Hex);
    verifyBurnTx(d, burnX);
    expect(() => verifyBurnTx(d, { ...burnX, dstDomain: 2 })).toThrow(/destinationDomain/);
    expect(() => verifyBurnTx(d, { ...burnX, recipient: TO })).toThrow(/mintRecipient/);
    expect(() => verifyBurnTx(d, { ...burnX, burn: 20002800n })).toThrow(/amount/);
    expect(() => verifyBurnTx(d, { ...burnX, maxFee: 2000n })).toThrow(/maxFee/);
    expect(() => verifyBurnTx(d, { ...burnX, forwarding: true })).toThrow(/method/);
    const f = await decodeTx(tx('burn_fwd_arb_to_base').raw as Hex);
    verifyBurnTx(f, { ...burnX, burn: 20057988n, maxFee: 57988n, forwarding: true });
    expect(() => verifyBurnTx(f, { ...burnX, burn: 20057988n, maxFee: 57988n })).toThrow(/method/); // a hook where self was approved
    expect(arb.cctp!.domain).toBe(3);
  });
  it('mint, refuel, transfer', async () => {
    const d = await decodeTx(tx('mint_polygon').raw as Hex);
    const mx = { chainId: 137, messageTransmitter: V.message_transmitter, message: V.iris_message.message as Hex, attestation: V.iris_message.attestation as Hex };
    verifyMintTx(d, mx);
    expect(() => verifyMintTx(d, { ...mx, attestation: '0x00' })).toThrow(/attestation/);
    const r = await decodeTx(tx('refuel_base').raw as Hex);
    verifyRefuelTx(r, { kind: 'op_stack', l1Contract: '0x3154Cf16ccdb4C6d922629664174b904d80F2C35', amount: 10n ** 16n });
    expect(() => verifyRefuelTx(r, { kind: 'op_stack', l1Contract: '0x99C9fc46f92E8a1c0deC1b1747d010903E884bE1', amount: 10n ** 16n })).toThrow(/to/);
    expect(() => verifyRefuelTx(r, { kind: 'arbitrum', l1Contract: '0x3154Cf16ccdb4C6d922629664174b904d80F2C35', amount: 10n ** 16n })).toThrow(/method/);
    verifyRefuelTx(await decodeTx(tx('refuel_arb').raw as Hex), { kind: 'arbitrum', l1Contract: '0x4Dbd4fc535Ac27206064B68FfCf827b0A60BAB3f', amount: 10n ** 16n });
    const t = await decodeTx(tx('usdt_arb').raw as Hex);
    verifyTransferTx(t, { chainId: 42161, to: TO, amount: 40_000_000n, token: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9' });
    expect(() => verifyTransferTx(t, { chainId: 42161, to: ME, amount: 40_000_000n, token: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9' })).toThrow(/to/);
    const n = await decodeTx(tx('native_eth').raw as Hex);
    verifyTransferTx(n, { chainId: 1, to: TO, amount: 10n ** 15n });
    expect(() => verifyTransferTx(n, { chainId: 1, to: TO, amount: 10n ** 14n })).toThrow(/amount/);
  });
  it('signChecked signs and recovers our address', async () => {
    const u: Unsigned = { chainId: 8453, nonce: 3, to: TO as any, value: 5n, data: '0x', gas: 21000n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n };
    const s = await signChecked(u, V.key as Hex, ME);
    expect((await decodeTx(s.raw)).from).toBe(ME);
    await expect(signChecked(u, V.key as Hex, TO)).rejects.toThrow(/key is not the account/);
  });
});
