// The extension's own check of the decoded bytes against the intent — the same rules the Signer applies.
// Every function throws INTENT_MISMATCH: <field> on the first difference.
import type { Hex } from 'viem';
import { bytes32Of, CCTP_FORWARD_HOOK } from './abi';
import type { DecodedTx } from './tx';

const bad = (f: string): never => { throw new Error(`INTENT_MISMATCH: ${f}`); };
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function verifyTransferTx(d: DecodedTx, x: { chainId: number; to: string; amount: bigint; token?: string }): void {
  if (d.chainId !== x.chainId) bad('chainId');
  if (!x.token) {
    if (!eq(d.to, x.to)) bad('to');
    if (d.value !== x.amount) bad('amount');
    if (d.data !== '0x') bad('data');
    return;
  }
  if (!eq(d.to, x.token)) bad('token');
  if (d.value !== 0n) bad('value');
  if (d.call?.fn !== 'transfer') bad('method');
  const c = d.call as Extract<DecodedTx['call'], { fn: 'transfer' }>;
  if (!eq(c.to, x.to)) bad('to');
  if (c.amount !== x.amount) bad('amount');
}

export function verifyApproveTx(d: DecodedTx, x: { chainId: number; token: string; spender: string; amount: bigint }): void {
  if (d.chainId !== x.chainId) bad('chainId');
  if (!eq(d.to, x.token)) bad('token');
  if (d.value !== 0n) bad('value');
  if (d.call?.fn !== 'approve') bad('method');
  const c = d.call as Extract<DecodedTx['call'], { fn: 'approve' }>;
  if (!eq(c.spender, x.spender)) bad('spender');
  if (c.amount !== x.amount) bad('amount');
}

export interface BurnExpect { chainId: number; tokenMessenger: string; burnToken: string; recipient: string; dstDomain: number; burn: bigint; maxFee: bigint; finality: number; forwarding: boolean }
export function verifyBurnTx(d: DecodedTx, x: BurnExpect): void {
  if (d.chainId !== x.chainId) bad('chainId');
  if (!eq(d.to, x.tokenMessenger)) bad('to');
  if (d.value !== 0n) bad('value');
  const want = x.forwarding ? 'depositForBurnWithHook' : 'depositForBurn';
  if (d.call?.fn !== want) bad('method');
  const c = d.call as Extract<DecodedTx['call'], { fn: 'depositForBurn' | 'depositForBurnWithHook' }>;
  if (c.amount !== x.burn) bad('amount');
  if (c.destinationDomain !== x.dstDomain) bad('destinationDomain');
  if (!eq(c.mintRecipient, bytes32Of(x.recipient))) bad('mintRecipient');
  if (!eq(c.burnToken, x.burnToken)) bad('burnToken');
  if (!/^0x0{64}$/.test(c.destinationCaller)) bad('destinationCaller');
  if (c.maxFee !== x.maxFee) bad('maxFee');
  if (c.maxFee >= c.amount) bad('maxFee');
  if (c.minFinalityThreshold !== x.finality) bad('minFinalityThreshold');
  if (x.forwarding && !eq(c.hookData ?? '0x', CCTP_FORWARD_HOOK)) bad('hookData');
}

export function verifyMintTx(d: DecodedTx, x: { chainId: number; messageTransmitter: string; message: Hex; attestation: Hex }): void {
  if (d.chainId !== x.chainId) bad('chainId');
  if (!eq(d.to, x.messageTransmitter)) bad('to');
  if (d.value !== 0n) bad('value');
  if (d.call?.fn !== 'receiveMessage') bad('method');
  const c = d.call as Extract<DecodedTx['call'], { fn: 'receiveMessage' }>;
  if (!eq(c.message, x.message)) bad('message');
  if (!eq(c.attestation, x.attestation)) bad('attestation');
}

export function verifyRefuelTx(d: DecodedTx, x: { kind: 'op_stack' | 'arbitrum'; l1Contract: string; amount: bigint; minGasLimit?: number }): void {
  if (d.chainId !== 1) bad('chainId');
  if (!eq(d.to, x.l1Contract)) bad('to');
  if (d.value !== x.amount) bad('amount');
  if (x.kind === 'op_stack') {
    if (d.call?.fn !== 'depositETH') bad('method');
    const c = d.call as Extract<DecodedTx['call'], { fn: 'depositETH' }>;
    if (c.minGasLimit !== (x.minGasLimit ?? 200_000) || c.extraData !== '0x') bad('depositETH args');
  } else if (d.call?.fn !== 'depositEth') bad('method');
}
