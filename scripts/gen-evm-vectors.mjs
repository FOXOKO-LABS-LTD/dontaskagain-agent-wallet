import { encodeFunctionData, parseAbi, serializeTransaction, keccak256, pad } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import fs from 'node:fs';
const msg = JSON.parse(fs.readFileSync(process.argv[2])).messages[0];
const abi = parseAbi([
 'function approve(address,uint256)', 'function transfer(address,uint256)',
 'function depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)',
 'function depositForBurnWithHook(uint256,uint32,bytes32,address,bytes32,uint256,uint32,bytes)',
 'function receiveMessage(bytes,bytes)', 'function depositETH(uint32,bytes)', 'function depositEth()']);
const KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const acc = privateKeyToAccount(KEY);
const TM='0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d', MT='0x81D40F21F12A8F0E3252Bccb954D722d4c464B64';
const USDC_ARB='0xaf88d065e77c8cC2239327C5EDb3A432268e5831', USDC_BASE='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const HOOK='0x636374702d666f72776172640000000000000000000000000000000000000000';
const me32 = pad(acc.address.toLowerCase(), {size:32});
const calls = {
  approve: encodeFunctionData({abi, functionName:'approve', args:[TM, 20002801n]}),
  transfer: encodeFunctionData({abi, functionName:'transfer', args:['0x3214a0bf8a5be0d3f2a9f1d2c3b4a5968776b67c', 40000000n]}),
  depositForBurn: encodeFunctionData({abi, functionName:'depositForBurn', args:[20002801n, 6, me32, USDC_ARB, pad('0x',{size:32}), 2801n, 1000]}),
  depositForBurnWithHook: encodeFunctionData({abi, functionName:'depositForBurnWithHook', args:[20057988n, 6, me32, USDC_ARB, pad('0x',{size:32}), 57988n, 1000, HOOK]}),
  receiveMessage: encodeFunctionData({abi, functionName:'receiveMessage', args:[msg.message, msg.attestation]}),
  depositETH: encodeFunctionData({abi, functionName:'depositETH', args:[200000, '0x']}),
  depositEth: encodeFunctionData({abi, functionName:'depositEth', args:[]}),
};
const txs = [];
const mk = async (name, chainId, nonce, to, value, data) => {
  const tx = { type:'eip1559', chainId, nonce, maxPriorityFeePerGas: 1000000n, maxFeePerGas: 20000000000n, gas: 210000n, to, value, data };
  const raw = await acc.signTransaction(tx);
  txs.push({ name, chain_id: chainId, nonce, to, value: value.toString(), data, raw, hash: keccak256(raw), from: acc.address });
};
await mk('approve_arb', 42161, 7, USDC_ARB, 0n, calls.approve);
await mk('burn_self_arb_to_base', 42161, 8, TM, 0n, calls.depositForBurn);
await mk('burn_fwd_arb_to_base', 42161, 8, TM, 0n, calls.depositForBurnWithHook);
await mk('mint_polygon', 137, 0, MT, 0n, calls.receiveMessage);
await mk('refuel_base', 1, 3, '0x3154Cf16ccdb4C6d922629664174b904d80F2C35', 10000000000000000n, calls.depositETH);
await mk('refuel_arb', 1, 3, '0x4Dbd4fc535Ac27206064B68FfCf827b0A60BAB3f', 10000000000000000n, calls.depositEth);
await mk('native_eth', 1, 0, '0x3214a0bf8a5be0d3f2a9f1d2c3b4a5968776b67c', 1000000000000000n, '0x');
await mk('usdt_arb', 42161, 1, '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', 0n, calls.transfer);
const fees = [
  {amount:'20000000', f:'1.4', fwd:'0', max_fee:'2801'},
  {amount:'20000000', f:'1.4', fwd:'55107', max_fee:null},
  {amount:'1000000', f:'1', fwd:'0', max_fee:null},
  {amount:'1000000', f:'0', fwd:'55107', max_fee:'55107'},
  {amount:'1000000', f:'0', fwd:'0', max_fee:'0'},
  {amount:'123456789', f:'1.3', fwd:'792254', max_fee:null},
];
// reference: ceil((a+fwd)*f/(10000-f)) with f decimal → scale by 10000
for (const x of fees) { const F = BigInt(Math.round(Number(x.f)*10000)); const num=(BigInt(x.amount)+BigInt(x.fwd))*F, den=(10000n*10000n - F); const p=(num+den-1n)/den; x.max_fee=(BigInt(x.fwd)+p).toString(); x.burn=(BigInt(x.amount)+BigInt(x.max_fee)).toString(); }
fs.writeFileSync(process.argv[3], JSON.stringify({ key: KEY, address: acc.address, token_messenger: TM, message_transmitter: MT, hook_data: HOOK, calls, txs, iris_message: msg, fees }, null, 1));
console.log('ok', acc.address, fees);
