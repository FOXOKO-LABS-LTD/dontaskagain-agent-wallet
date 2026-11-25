// request normalization (the Signer's rules, now in the extension) and the read classifier.
import { normalizeRequest, checkFresh, bodyHash } from '../src/lib/e2e/protocol';
import { tronReadIsSafe, evmReadIsSafe, type Known } from '../src/lib/e2e/reads';
import { hdAddresses, seedFromMnemonic } from '../src/lib/wallet/derive';
import { tronToHex41 } from '../src/lib/tron/address';
import { nowAt } from '../src/lib/e2e/crypto';

const seed = seedFromMnemonic('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const A0 = hdAddresses(seed, 0), A1 = hdAddresses(seed, 1), X = hdAddresses(seed, 7);
const accounts: any[] = [{ id: 'acc_a', name: 'main', origin: 'hd', addresses: { tron: A0.tron, evm: A0.evm } }, { id: 'acc_b', name: 'ops', origin: 'hd', addresses: { tron: A1.tron, evm: A1.evm } }];
const agent: any = { name: 'bot', accounts: ['acc_b'], allowed_types: ['transfer', 'swap', 'bridge', 'refuel'], rules: {}, temp: [] };
const base = () => ({ t: 'request', request_id: 'awr_abcdefghijkl', client_request_id: 'c-1', created_at: nowAt(), expires_at: nowAt(new Date(Date.now() + 600_000)) });
const norm = (p: any) => normalizeRequest({ ...base(), ...p }, { agent_id: 'ag_1', agent, accounts });

describe('normalizeRequest', () => {
  it('TRON transfer: default account = first bound, amount_raw, resources defaults', () => {
    const r = norm({ type: 'transfer', network: 'tron', asset: 'usdt', to: X.tron, amount: '2.5' });
    expect(r.ok && r.request).toMatchObject({ account: { id: 'acc_b', address: A1.tron }, intent: { asset: 'USDT', to: X.tron, amount_raw: '2500000', resources: { route: 'auto', payment: { method: 'x402_base' } } }, status: 'pending' });
  });
  it('intent object and flat fields are the same', () => {
    const a = norm({ type: 'transfer', network: 'tron', asset: 'TRX', to: X.tron, amount: '1' });
    const b = norm({ type: 'transfer', network: 'tron', intent: { asset: 'TRX', to: X.tron, amount: '1' } });
    expect(a).toEqual(b);
  });
  it('refusals like the Signer', () => {
    const code = (p: any) => { const r = norm(p); return r.ok ? 'ok' : r.error.code; };
    expect(code({ type: 'transfer', network: 'tron', account: 'main', asset: 'TRX', to: X.tron, amount: '1' })).toBe('ACCOUNT_NOT_ALLOWED');
    expect(code({ type: 'transfer', network: 'tron', asset: 'TRX', to: A1.tron, amount: '1' })).toBe('SELF_TRANSFER');
    expect(code({ type: 'transfer', network: 'tron', asset: 'TRX', to: 'Tnope', amount: '1' })).toBe('INVALID_ADDRESS');
    expect(code({ type: 'transfer', network: 'tron', asset: 'TRX', to: X.tron, amount: '1.0000001' })).toBe('BAD_AMOUNT');
    expect(code({ type: 'x402_pay' })).toBe('E2E_TYPE_UNSUPPORTED');
    expect(code({ type: 'nope' })).toBe('UNKNOWN_TYPE');
    expect(code({ type: 'transfer', network: 'tron', asset: 'TRX', to: X.tron, amount: '1', reason: 'x'.repeat(501) })).toBe('REASON_TOO_LONG');
    expect(code({ type: 'swap', asset_in: 'TRX', asset_out: 'TRX', amount_in: '1' })).toBe('SAME_ASSET');
    expect(code({ type: 'bridge', from_network: 'evm:42161', to_network: 'evm:8453', amount: '5', to: X.evm })).toBe('BAD_REQUEST');
    expect(code({ type: 'refuel', to_network: 'evm:137', amount_eth: '0.01' })).toBe('REFUEL_UNSUPPORTED');
    expect(norm({ type: 'transfer', network: 'evm:8453', asset: 'USDC', to: X.evm.toLowerCase(), amount: '1' })).toMatchObject({ ok: true, request: { intent: { to: X.evm, amount_raw: '1000000' } } });
  });
  it('freshness and the idempotency hash', () => {
    expect(checkFresh(base(), Date.now())).toBeNull();
    expect(checkFresh({ ...base(), expires_at: nowAt(new Date(Date.now() + 10_000)) }, Date.now())?.code).toBe('BAD_EXPIRES');
    expect(checkFresh({ ...base(), created_at: nowAt(new Date(Date.now() + 3_600_000)), expires_at: nowAt(new Date(Date.now() + 4_000_000)) }, Date.now())?.code).toBe('E2E_CLOCK');
    expect(bodyHash({ ...base(), amount: '1' })).toBe(bodyHash({ ...base(), request_id: 'awr_other_000000', amount: '1' }));
    expect(bodyHash({ ...base(), amount: '1' })).not.toBe(bodyHash({ ...base(), amount: '2' }));
  });
});

describe('read classifier: content never goes through the Signer relay', () => {
  const k: Known = { tron: new Set([A0.tron, A1.tron]), evm: new Set([A0.evm.toLowerCase()]), tronContracts: new Set(['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t']), evmContracts: new Set(['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913']) };
  const word = (t: string) => tronToHex41(t).slice(2).padStart(64, '0');
  it('TRON', () => {
    // 0.3.3: what the transaction is built from (block, chain parameters, own resources) is read directly
    expect(tronReadIsSafe('getnowblock', {}, k)).toBe(false);
    expect(tronReadIsSafe('getchainparameters', {}, k)).toBe(false);
    expect(tronReadIsSafe('getaccountresource', { address: A1.tron, visible: true }, k)).toBe(false);
    expect(tronReadIsSafe('getaccount', { address: A1.tron, visible: true }, k)).toBe(false);
    expect(tronReadIsSafe('getaccount', { address: X.tron, visible: true }, k)).toBe(false);
    const bal = { owner_address: A1.tron, contract_address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', function_selector: 'balanceOf(address)', parameter: word(A1.tron), visible: true };
    expect(tronReadIsSafe('triggerconstantcontract', bal, k)).toBe(true);
    expect(tronReadIsSafe('triggerconstantcontract', { ...bal, parameter: word(X.tron) }, k)).toBe(false);
    expect(tronReadIsSafe('triggerconstantcontract', { ...bal, function_selector: 'transfer(address,uint256)', parameter: word(X.tron) + '0'.repeat(63) + '1' }, k)).toBe(false);
    expect(tronReadIsSafe('estimateenergy', bal, k)).toBe(false);
  });
  it('EVM', () => {
    expect(evmReadIsSafe('eth_getBalance', [A0.evm, 'latest'], k)).toBe(true);
    expect(evmReadIsSafe('eth_getBalance', [X.evm, 'latest'], k)).toBe(false);
    expect(evmReadIsSafe('eth_call', [{ to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', data: '0x70a08231' + A0.evm.slice(2).toLowerCase().padStart(64, '0') }, 'latest'], k)).toBe(true);
    expect(evmReadIsSafe('eth_call', [{ to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', data: '0x70a08231' + X.evm.slice(2).toLowerCase().padStart(64, '0') }, 'latest'], k)).toBe(false);
    expect(evmReadIsSafe('eth_estimateGas', [{ from: A0.evm, to: X.evm, value: '0x1' }], k)).toBe(false);
    expect(evmReadIsSafe('eth_getCode', [X.evm, 'latest'], k)).toBe(false);
    expect(evmReadIsSafe('eth_getBlockByNumber', ['latest', true], k)).toBe(false);
    // 0.3.3: nonce and fees come from our RPC, never from the Signer
    expect(evmReadIsSafe('eth_feeHistory', [5, 'latest', [50]], k)).toBe(false);
    expect(evmReadIsSafe('eth_getTransactionCount', [A0.evm, 'pending'], k)).toBe(false);
    expect(evmReadIsSafe('eth_maxPriorityFeePerGas', [], k)).toBe(false);
    expect(evmReadIsSafe('eth_getBlockByNumber', ['latest', false], k)).toBe(false);
    expect(evmReadIsSafe('eth_chainId', [], k)).toBe(true);
  });
});

// 0.3.9: there is no built-in TRON node — reads go through the Signer unless the human sets a node of their own (never
// TronGrid as a default); EVM RPC per network overridable.
import { DEFAULT_SETTINGS, directReadsOn, evmRpcOf, rpcOverrides, tronNodeOf } from '../src/lib/wallet/model';
import e2eDefaults from '../src/config/e2e.json';
import manifest from '../public/manifest.json';
describe('direct read endpoints (0.3.1)', () => {
  it('TRON: no node by default (reads through the Signer); the former TronGrid default and an empty value mean none; a chosen node stays', () => {
    expect('tron_node' in e2eDefaults).toBe(false);
    expect('tron_node_require_https' in e2eDefaults).toBe(false);
    expect(DEFAULT_SETTINGS.e2e_reads).toBe('signer');
    expect(tronNodeOf(DEFAULT_SETTINGS)).toBe('');
    expect(directReadsOn(DEFAULT_SETTINGS)).toBe(false);
    expect(tronNodeOf({ e2e_tron_node: 'https://api.trongrid.io' })).toBe('');
    expect(tronNodeOf({ e2e_tron_node: '' })).toBe('');
    expect(tronNodeOf({ e2e_tron_node: 'https://node.example/' })).toBe('https://node.example');
    expect(JSON.stringify(manifest.host_permissions)).not.toContain('trongrid');
  });
  it('EVM: the override of a network, else the built-in RPC; only real overrides are kept', () => {
    expect(evmRpcOf(DEFAULT_SETTINGS, 8453)).toBe(e2eDefaults.evm_rpc['8453']);
    expect(evmRpcOf({ e2e_rpc: { 8453: 'https://base.example/rpc' } }, 8453)).toBe('https://base.example/rpc');
    expect(evmRpcOf({ e2e_rpc: { 8453: 'https://base.example/rpc' } }, 1)).toBe(e2eDefaults.evm_rpc['1']);
    expect(rpcOverrides({ 1: e2eDefaults.evm_rpc['1'], 10: '', 8453: 'https://base.example/rpc' })).toEqual({ 8453: 'https://base.example/rpc' });
  });
});
