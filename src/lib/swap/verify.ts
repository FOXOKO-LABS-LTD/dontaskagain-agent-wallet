// Our own check of the very bytes we sign for a swap (router, path, recipient, amounts, deadline + amount_out_min — the same rules as the Signer's check): any
// difference → INTENT_MISMATCH, nothing is signed.
import { decodeAbiParameters, recoverAddress, type Hex } from 'viem';
import { hexToBytes } from '../bytes';
import { decodeRaw, type DecodedTx } from '../tron/tx';
import { normalizeTron, tronFromEvm } from '../tron/address';
import { ABI, ACT, APPROVE_SELECTOR, CMD, EXECUTE_SELECTOR, permitDigest } from './build';
import { ADDRESS_THIS, CONTRACT_BALANCE, ZERO_ADDRESS, evmHex, type SwapAsset, type SwapConfig } from './config';

export const MAX_FEE_LIMIT_SUN = 100_000_000;

export interface SwapIntentRaw { account: string; asset_in: SwapAsset; asset_out: SwapAsset; amount_in_raw: bigint; amount_out_min_raw: bigint }

const mm = (what: string): never => { throw new Error('INTENT_MISMATCH: ' + what); };
const eqA = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export interface DecodedCommand { type: number; name: string; args: any }
export interface DecodedExecute { commands: DecodedCommand[]; deadline: bigint }

const NAMES: Record<number, string> = { 0x00: 'V3_SWAP_EXACT_IN', 0x04: 'SWEEP', 0x08: 'V2_SWAP_EXACT_IN', 0x0a: 'PERMIT2_PERMIT', 0x0b: 'WRAP_ETH', 0x0c: 'UNWRAP_WETH', 0x12: 'V4_SWAP' };

/** v3 packed path → token list (addresses, lowercase 0x…). */
export function v3PathTokens(path: Hex): Hex[] {
  const h = path.slice(2);
  if ((h.length / 2 - 20) % 23 !== 0 || h.length < 86) throw new Error('bad v3 path');
  const out: Hex[] = [];
  for (let i = 0; i < h.length; i += 46) out.push(('0x' + h.slice(i, i + 40)) as Hex);
  return out;
}

export function decodeExecute(dataHex: string): DecodedExecute {
  const d = dataHex.replace(/^0x/, '').toLowerCase();
  if (!d.startsWith(EXECUTE_SELECTOR)) mm('selector is not execute(bytes,bytes[],uint256)');
  const [commands, inputs, deadline] = decodeAbiParameters(ABI.execute, ('0x' + d.slice(8)) as Hex);
  const types = Array.from(hexToBytes(commands));
  if (types.length !== inputs.length) mm('commands and inputs differ in length');
  const out: DecodedCommand[] = types.map((t, i) => {
    if (t & 0x80) mm('allow-revert flag 0x80 is not allowed');
    const inp = inputs[i] as Hex;
    let args: any;
    switch (t) {
      case CMD.PERMIT2_PERMIT: args = decodeAbiParameters(ABI.permit, inp); break;
      case CMD.V3_SWAP_EXACT_IN: args = decodeAbiParameters(ABI.v3, inp); break;
      case CMD.V2_SWAP_EXACT_IN: args = decodeAbiParameters(ABI.v2, inp); break;
      case CMD.WRAP_ETH: case CMD.UNWRAP_WETH: args = decodeAbiParameters(ABI.wrap, inp); break;
      case CMD.SWEEP: args = decodeAbiParameters(ABI.sweep, inp); break;
      case CMD.V4_SWAP: {
        const [actions, params] = decodeAbiParameters(ABI.v4, inp);
        const acts = Array.from(hexToBytes(actions));
        if (acts.length !== params.length) mm('v4 actions and params differ');
        args = acts.map((a, j) => {
          const p = params[j] as Hex;
          switch (a) {
            case ACT.SETTLE: return { a, v: decodeAbiParameters(ABI.settle, p) };
            case ACT.TAKE: return { a, v: decodeAbiParameters(ABI.take, p) };
            case ACT.CL_SWAP_EXACT_IN_SINGLE: return { a, v: decodeAbiParameters(ABI.single, p) };
            case ACT.CL_SWAP_EXACT_IN: return { a, v: decodeAbiParameters(ABI.multi, p) };
            default: return mm(`v4 action 0x${a.toString(16)} is not allowed`);
          }
        });
        break;
      }
      default: mm(`command 0x${t.toString(16)} is not allowed`);
    }
    return { type: t, name: NAMES[t], args };
  });
  return { commands: out, deadline };
}

function common(d: DecodedTx, owner: string, now: number): void {
  if (d.type !== 'TriggerSmartContract') mm('not TriggerSmartContract');
  if (d.owner !== owner) mm('owner');
  if (d.feeLimit > MAX_FEE_LIMIT_SUN) mm('fee_limit');
  if (d.expiration < now + 30_000 || d.expiration > now + 3_600_000) mm('expiration');
}

/** approve(Permit2, amount_in) on the asset_in token, exactly 68 bytes. */
export function verifyApprove(rawHex: string, intent: SwapIntentRaw, c: SwapConfig, now: number): DecodedTx {
  const d = decodeRaw(rawHex);
  common(d, normalizeTron(intent.account), now);
  if (c.assets[intent.asset_in].native) mm('approve for TRX');
  if (d.contract !== c.assets[intent.asset_in].address) mm('approve contract is not the asset_in token');
  if ((d.callValue ?? 0n) !== 0n) mm('approve call_value');
  const data = d.data ?? '';
  if (data.length !== 136 || !data.startsWith(APPROVE_SELECTOR)) mm('approve calldata');
  if (!/^0{24}$/.test(data.slice(8, 32)) || !eqA('0x' + data.slice(32, 72), evmHex(c.permit2))) mm('approve spender is not Permit2');
  if (BigInt('0x' + data.slice(72)) !== intent.amount_in_raw) mm('approve amount ≠ amount_in');
  return d;
}

/** The execute transaction: router from the list, every command, the single user payment, SWEEP to the account. */
export async function verifySwap(rawHex: string, intent: SwapIntentRaw, c: SwapConfig, now: number): Promise<{ decoded: DecodedTx; exec: DecodedExecute }> {
  const d = decodeRaw(rawHex);
  const owner = normalizeTron(intent.account);
  common(d, owner, now);
  if (d.contract !== c.router) mm('contract is not the sun.io Universal Router');
  const inA = c.assets[intent.asset_in], outA = c.assets[intent.asset_out];
  const native = inA.native;
  if ((d.callValue ?? 0n) !== (native ? intent.amount_in_raw : 0n)) mm('call_value');
  const exec = decodeExecute(d.data ?? '');
  const nowS = BigInt(Math.floor(now / 1000));
  if (exec.deadline < nowS + 30n || exec.deadline > nowS + 3600n) mm('deadline');
  const cmds = exec.commands;
  const me = evmHex(owner);
  const wtrx = evmHex(c.wtrx), inHex = evmHex(inA.address), outHex = evmHex(outA.address);
  let userPays = 0, cursor: string = native ? ZERO_ADDRESS : inHex;
  if (!cmds.length || cmds[cmds.length - 1].type !== CMD.SWEEP) mm('SWEEP must be the last command');
  for (let i = 0; i < cmds.length; i++) {
    const x = cmds[i];
    const a = x.args;
    switch (x.type) {
      case CMD.PERMIT2_PERMIT: {
        if (i !== 0 || native) mm('PERMIT2_PERMIT only first and only for a token');
        const [ps, sig] = a;
        if (!eqA(ps.details.token, inHex)) mm('permit token');
        if (BigInt(ps.details.amount) !== intent.amount_in_raw) mm('permit amount ≠ amount_in');
        if (!eqA(ps.spender, evmHex(c.router))) mm('permit spender is not the router');
        const exp = BigInt(ps.details.expiration);
        if (exp <= nowS || exp > nowS + 3600n || ps.sigDeadline <= nowS || ps.sigDeadline > nowS + 3600n) mm('permit expiration / sigDeadline');
        const signer = await recoverAddress({ hash: permitDigest(c, { token: ps.details.token, amount: BigInt(ps.details.amount), expiration: Number(ps.details.expiration), nonce: Number(ps.details.nonce), spender: ps.spender, sigDeadline: ps.sigDeadline }), signature: sig });
        if (tronFromEvm(signer) !== owner) mm('permit signature is not the account');
        break;
      }
      case CMD.WRAP_ETH: {
        if (!native || i !== 0) mm('WRAP_ETH');
        if (!eqA(a[0], ADDRESS_THIS) || a[1] !== intent.amount_in_raw) mm('WRAP_ETH recipient / amount');
        userPays++; cursor = wtrx; break;
      }
      case CMD.UNWRAP_WETH: {
        if (!eqA(cursor, wtrx) || !outA.native) mm('UNWRAP_WETH');
        if (!eqA(a[0], ADDRESS_THIS)) mm('UNWRAP_WETH recipient');
        cursor = ZERO_ADDRESS; break;
      }
      case CMD.V2_SWAP_EXACT_IN: case CMD.V3_SWAP_EXACT_IN: {
        const [rcpt, amt, , path, payerIsUser] = a;
        if (!eqA(rcpt, ADDRESS_THIS)) mm('swap recipient is not the router');
        const toks: string[] = x.type === CMD.V3_SWAP_EXACT_IN ? v3PathTokens(path) : path;
        if (!eqA(toks[0], cursor)) mm('path does not continue the previous step');
        if (payerIsUser) {
          if (native || userPays) mm('second user payment');
          if (amt !== intent.amount_in_raw) mm('swap amountIn ≠ amount_in'); userPays++;
        } else if (amt !== CONTRACT_BALANCE) mm('swap amountIn (router balance expected)');
        cursor = toks[toks.length - 1]; break;
      }
      case CMD.V4_SWAP: {
        for (const s of a as { a: number; v: any }[]) {
          if (s.a === ACT.SETTLE) {
            const [cur, amt, payerIsUser] = s.v;
            if (!eqA(cur, cursor)) mm('v4 settle currency');
            if (payerIsUser || (native && userPays === 0)) {
              if (userPays) mm('second user payment');
              if (payerIsUser === native) mm('v4 settle payer');
              if (amt !== intent.amount_in_raw) mm('v4 settle amount ≠ amount_in'); userPays++;
            } else if (amt !== CONTRACT_BALANCE) mm('v4 settle amount (router balance expected)');
          } else if (s.a === ACT.TAKE) {
            if (!eqA(s.v[1], ADDRESS_THIS)) mm('v4 take recipient is not the router');
          } else if (s.a === ACT.CL_SWAP_EXACT_IN_SINGLE) {
            const p = s.v[0];
            const other = eqA(p.poolKey.currency0, cursor) ? p.poolKey.currency1 : eqA(p.poolKey.currency1, cursor) ? p.poolKey.currency0 : mm('v4 pool does not hold the input');
            if (p.zeroForOne !== eqA(p.poolKey.currency0, cursor)) mm('v4 direction');
            cursor = other;
          } else if (s.a === ACT.CL_SWAP_EXACT_IN) {
            const p = s.v[0];
            if (!eqA(p.currencyIn, cursor)) mm('v4 path input');
            cursor = p.path[p.path.length - 1].intermediateCurrency;
          }
        }
        break;
      }
      case CMD.SWEEP: {
        if (i !== cmds.length - 1) mm('SWEEP not last');
        const [token, rcpt, min] = a;
        if (!eqA(token, outHex)) mm('SWEEP token is not asset_out');
        if (!eqA(rcpt, me)) mm('SWEEP recipient is not the account');
        if (BigInt(min) !== intent.amount_out_min_raw) mm('amount_out_min');
        if (!eqA(cursor, outHex)) mm('path does not end with asset_out');
        break;
      }
      default: mm('command');
    }
  }
  if (userPays !== 1) mm(`user payments: ${userPays}, want 1`);
  if (!native && cmds[0].type !== CMD.PERMIT2_PERMIT) mm('token input without PERMIT2_PERMIT');
  return { decoded: d, exec };
}
