import { buildOp } from '../../src/lib/op';
import { chainOpView } from '../../src/lib/chain/history';
// first meaningful frame (timing.mjs reads body[data-ff]): the header / sub-bar of the app is in the DOM
new MutationObserver((_, o) => {
  if (document.querySelector('#root .topbar, #root .subbar')) { document.body.dataset.ff = String(Math.round(performance.now())); o.disconnect(); }
}).observe(document, { subtree: true, childList: true });
// Screenshot harness only (not in dist/): a fake chrome.* with mock data, so the popup / panel / sign pages render
// without a wallet, a Signer or a network. `?act=` runs UI steps (click / type) after load.
const A0 = { tron: 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH', evm: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94' };
const A1 = { tron: 'TSeJkUh4Qv67VNFwY8LaAxERygNdy6NQZK', evm: '0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0' };
const A2 = { tron: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf', evm: '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf' };
const A3 = { tron: 'TAEcUaVF7UxD7G4Y2mYhUVqRYfDWwRp5Nx', evm: '0x3aD2D2e7E5a7f6C5F30C2dA46B0a3C3b3A9fC0e1' };
const A4 = { tron: 'TFq6nBc8JzQ2s3uNt5vUQhQ5yXkV2wQ2Dk', evm: '0x1C2b8a7D0e9F3a4B5c6D7e8F9a0B1c2D3e4F5a6B' };
const W0 = { tron: 'TCq1qVZkU4gN2xN9n6Jc5pJ3zV3b4xX9Qp', evm: '0x58A57ed9d8d624cBD12e2C467D34787555bB1b25' };
const W1 = { tron: 'TPkB6r1fYg9Tq7sS1jYwFqzvR2xVxQ8Yk1', evm: '0x9D6E4c1B7e8a2F3c4D5e6F7a8B9c0D1e2F3a4B5C' };
const BOOK = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8';
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const q = new URLSearchParams(location.search);

const status = {
  initialized: q.get('fresh') !== '1', unlocked: q.get('locked') !== '1', has_mnemonic: true,
  seeds: [
    { id: 'seed_main', name: 'Основная', created_at: iso(now - 86400_000 * 9), accounts: 3, root: true, next_index: 3 },
    { id: 'seed_w', name: 'Рабочая', created_at: iso(now - 86400_000 * 2), accounts: 2, root: false, next_index: 2 },
  ],
  accounts: [
    { id: 'acc_main', name: 'main', origin: 'hd', hd_index: 0, seed_id: 'seed_main', addresses: A0, root: true },
    { id: 'acc_ops', name: 'ops', origin: 'hd', hd_index: 1, seed_id: 'seed_main', addresses: A1, root: false },
    { id: 'acc_sav', name: 'savings', origin: 'hd', hd_index: 2, seed_id: 'seed_main', addresses: A3, root: false },
    { id: 'acc_w0', name: 'work', origin: 'hd', hd_index: 0, seed_id: 'seed_w', addresses: W0, root: false },
    { id: 'acc_w1', name: 'work-2', origin: 'hd', hd_index: 1, seed_id: 'seed_w', addresses: W1, root: false },
    { id: 'acc_old', name: 'old-key', origin: 'imported', addresses: A2, root: false },
    { id: 'acc_cold', name: 'cold', origin: 'imported', addresses: A4, root: false },
  ].slice(0, q.get('few') === '1' ? 3 : 7),
  autolock_at: now + 27 * 60_000,
  settings: { signer_url: 'http://127.0.0.1:9985', autolock_min: 30, debug_direct_node: false, open_in_side_panel: false, agents_paused: q.get('paused') === '1' },
  signer: { connected: true, signed_in: true, wallet_id: 'wal_9q2demo', server_networks_diff: [] },
  pending: 4,
  book: [{ id: 'ab_1', label: 'Склад USDT', network: 'tron', address: BOOK }, { id: 'ab_2', label: 'Подрядчик', network: 'evm:*', address: '0x3214a91bCd29b8ce7D3C5E26bE1cEa3E8D57b67C' }],
  agents: [
    { id: 'ag_7f3k', name: 'claude-bot', accounts: ['acc_ops', 'acc_main'], allowed_types: ['transfer', 'x402_pay'], created_at: iso(now - 86400_000 * 2), token_prefix: 'aw_ag_7f3k_Q',
      new_types: q.get('migrated') === '1' ? [] : ['swap', 'bridge', 'refuel'], mcp_name: 'agent-wallet',
    },
    { id: 'ag_2bq1', name: 'research-bot', accounts: ['acc_main'], allowed_types: ['transfer', 'swap', 'bridge', 'refuel', 'x402_pay'], created_at: iso(now - 86400_000 * 6), token_prefix: 'aw_ag_2bq1_M',
      new_types: [], mcp_name: 'dontaskagain-research-bot',
    },
  ],
  doc_version: 7, extension_id: 'abcdefghijklmnopabcdefghijklmnop', version: '0.1.5',
};
const balances: Record<string, any> = {
  acc_main: { at: iso(now), errors: [], tron: { TRX: '412.381200', USDT: '1250.500000', activated: true, energy: { available: 41_250, limit: 130_000 }, bandwidth: { staked_available: 0, free_available: 512 } }, base: { USDC: '18.420000', ETH: '0.002100' },
    evm: { 'evm:1': { ETH: '0.041', USDT: '320', USDC: '75.5' }, 'evm:42161': { ETH: '0.0032', USDC: '240', USDT: '0' }, 'evm:10': { ETH: '0', USDC: '12', USDT: '0' },
      'evm:137': { POL: '0', USDC: '0', USDT: '55' }, 'evm:8453': { ETH: '0.0021', USDC: '18.42' } } },
  acc_ops: { at: iso(now), errors: [], tron: { TRX: '35.000000', USDT: '84.000000', activated: true, energy: { available: 0, limit: 0 }, bandwidth: { staked_available: 0, free_available: 600 } }, base: { USDC: '6.100000', ETH: '0' } },
  acc_sav: { at: iso(now), errors: [], tron: { TRX: '1500', USDT: '5000', activated: true, energy: { available: 0, limit: 0 }, bandwidth: { staked_available: 0, free_available: 600 } }, base: { USDC: '0', ETH: '0' } },
  acc_w0: { at: iso(now), errors: [], tron: { TRX: '22.5', USDT: '310', activated: true, energy: { available: 0, limit: 0 }, bandwidth: { staked_available: 0, free_available: 600 } }, base: { USDC: '3.2', ETH: '0' } },
  acc_w1: { at: iso(now), errors: [], tron: { TRX: '0', USDT: '0', activated: false, energy: { available: 0, limit: 0 }, bandwidth: { staked_available: 0, free_available: 0 } }, base: { USDC: '0', ETH: '0' } },
  acc_cold: { at: iso(now), errors: [], tron: { TRX: '10', USDT: '12000', activated: true, energy: { available: 0, limit: 0 }, bandwidth: { staked_available: 0, free_available: 600 } }, base: { USDC: '0', ETH: '0' } },
  acc_old: { at: iso(now), errors: [], tron: { TRX: '0', USDT: '0', activated: false, energy: { available: 0, limit: 0 }, bandwidth: { staked_available: 0, free_available: 0 } }, base: { USDC: '0', ETH: '0' } },
};
const reqs = [
  { request_id: 'awr_r1', agent: { id: 'ag_7f3k', name: 'claude-bot' }, account: { id: 'acc_ops', name: 'ops' }, type: 'transfer', network: 'tron', intent: { asset: 'USDT', to: BOOK, amount: '25' }, reason: 'Оплата склада за ноябрь, счёт №1142 — повтор, первая отправка не дошла', status: 'pending', created_at: iso(now - 60_000), expires_at: iso(now + 14 * 60_000) },
  { request_id: 'awr_r2', agent: { id: 'ag_2bq1', name: 'research-bot' }, account: { id: 'acc_main', name: 'main' }, type: 'transfer', network: 'tron', intent: { asset: 'TRX', to: A1.tron, amount: '5' }, reason: 'Пополнить ops на комиссии', status: 'pending', created_at: iso(now - 30_000), expires_at: iso(now + 55 * 60_000) },
];
reqs.push(
  { request_id: 'awr_s1', agent: { id: 'ag_7f3k', name: 'claude-bot' }, account: { id: 'acc_main', name: 'main' }, type: 'swap', network: 'tron', intent: { asset_in: 'USDT', asset_out: 'TRX', amount_in: '10', slippage_bps: 100 }, swap: { amount_out_min: '33.912041' }, reason: 'Нужен TRX на комиссии: меняю 10 USDT', status: 'pending', created_at: iso(now - 20_000), expires_at: iso(now + 9 * 60_000) } as any,
  { request_id: 'awr_n1', agent: { id: 'ag_2bq1', name: 'research-bot' }, account: { id: 'acc_main', name: 'main' }, type: 'transfer', network: 'tron', intent: { asset: 'TRX', to: 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7', amount: '3' }, reason: 'Оплата подписки на данные, новый адрес продавца', status: 'pending', created_at: iso(now - 10_000), expires_at: iso(now + 30 * 60_000) } as any,
);
const res = (o: any) => ({ need: { energy: 0, bandwidth: 345 }, have: { energy: 0, bandwidth: 0 }, deficit: { energy: 0, bandwidth: 345 }, activate: { sender: false, recipient: false }, route: 'proxy', fallback_route: 'direct', approved_max_usdc: '0.1', fallback_approved_max_usdc: '0.112', payer: A0.evm, usdc_balance: '18.42', energy_source: 'node', buy: { energy: 0, bandwidth: 345, activate: [] }, ...o });
const swapView = {
  key: 'awr_s1', kind: 'agent', agent: { id: 'ag_7f3k', name: 'claude-bot', known: true }, account: { id: 'acc_main', name: 'main', tron: A0.tron, evm: A0.evm },
  network: 'tron', type: 'swap', reason: 'Нужен TRX на комиссии: меняю 10 USDT', expires_at: iso(now + 9 * 60_000), created_at: iso(now - 20_000), blocked: null, warnings: [], built_at: now,
  repeat: { request_id: 'awr_s0', minutes_ago: 3, status: 'confirmed', amount: '10 USDT', count: 1, kind: 'swap' },
  swap: { asset_in: 'USDT', asset_out: 'TRX', amount_in: '10', amount_out: '34.254587', amount_out_min: '33.912041', slippage_bps: 100, rate: '1 USDT = 3.425459 TRX',
    route: [{ from: 'USDT', to: 'WTRX', version: 'v3', fee_pct: '0.05' }, { from: 'WTRX', to: 'TRX', version: 'wtrx', fee_pct: '0' }], fee: '0.005', impact: '0.01 %',
    reference: { price_usd: '0.2914', source: 'binance', stale: false, deviation_bps: 18 }, router: 'TQqgW8Hs6x5FnDCXR1QySzfbjT1ZoTY7Y4', recipient: A0.tron,
    approve: { needed: true, spender: 'TDJNTBi51CnnpCYYgi6GitoT4CJWrqim2G', amount: '10', current_allowance: '0' },
    steps: [
      { step: 'approve', txID: '4b1e0c7d2a9f88e1c3d5b7a9f0e2d4c6b8a0f1e3d5c7b9a1f3e5d7c9b1a3f5e7', contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', fee_limit_trx: '30', expiration: iso(now + 600_000),
        energy: { total: 98_000, user: 98_000, need: 112_700, source: 'simulation' }, resources: res({ need: { energy: 112_700, bandwidth: 313 }, deficit: { energy: 112_700, bandwidth: 313 }, buy: { energy: 112_700, bandwidth: 313, activate: [] },
          quotes: { proxy: { ok: true, cost_usdc: '0.83', approved_max_usdc: '0.996', parts: { bandwidth: '0.09' } }, direct: { ok: true, cost_usdc: '0.95', approved_max_usdc: '1.14', parts: { energy: '0.86', bandwidth: '0.09' } } } }) },
      { step: 'swap', txID: '', contract: 'TQqgW8Hs6x5FnDCXR1QySzfbjT1ZoTY7Y4', fee_limit_trx: '75', expiration: iso(now + 600_000),
        energy: { total: 380_000, user: 266_000, need: 305_900, source: 'estimate' }, resources: res({ need: { energy: 305_900, bandwidth: 620 }, deficit: { energy: 305_900, bandwidth: 620 }, buy: { energy: 300_000, bandwidth: 620, activate: [] },
          quotes: { proxy: { ok: false, code: 'NO_CAPACITY', note: 'энергия > 300000' }, direct: { ok: true, cost_usdc: '2.21', approved_max_usdc: '2.652', parts: { energy: '2.05', bandwidth: '0.16' } } }, route: 'direct', fallback_route: null }) },
    ],
    resources_total_usdc: '3.04', resources_cap_usdc: '3.648' },
};
const newAddrView = {
  key: 'awr_n1', kind: 'agent', agent: { id: 'ag_2bq1', name: 'research-bot', known: true }, account: { id: 'acc_main', name: 'main', tron: A0.tron, evm: A0.evm },
  network: 'tron', type: 'transfer', reason: 'Оплата подписки на данные, новый адрес продавца', expires_at: iso(now + 30 * 60_000), created_at: iso(now - 10_000), blocked: null, warnings: [], built_at: now, repeat: null,
  tx: { asset: 'TRX', amount: '3', from: A0.tron, to: 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7', txID: '7e2d9c1b3a5f7e9d1c3b5a7f9e1d3c5b7a9f1e3d5c7b9a1f3e5d7c9b1a3f5e70', fee_limit_trx: '0', expiration: iso(now + 600_000) },
  to_check: { similar: [], first_time: true },
  resources: res({ activate: { sender: false, recipient: true }, need: { energy: 0, bandwidth: 270 }, have: { energy: 0, bandwidth: 512 }, deficit: { energy: 0, bandwidth: 0 }, buy: { energy: 0, bandwidth: 0, activate: ['TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7'] },
    quotes: { proxy: { ok: true, cost_usdc: '0.339790', approved_max_usdc: '0.407748', parts: { activate: '0.339790' } }, direct: { ok: true, cost_usdc: '0.351200', approved_max_usdc: '0.42144', parts: { activate: '0.351200' } } },
    approved_max_usdc: '0.407748', fallback_approved_max_usdc: '0.42144' }),
};
const history = [
  { request_id: 'awr_h1', agent: { id: 'ag_7f3k', name: 'claude-bot' }, account: { id: 'acc_ops', name: 'ops' }, type: 'transfer', network: 'tron', intent: { asset: 'USDT', to: BOOK, amount: '25' }, status: 'confirmed', at: now - 6 * 60_000, own: false, by: 'human' },
  { request_id: 'awr_h2', account: { id: 'acc_main', name: 'main' }, type: 'transfer', network: 'tron', intent: { asset: 'USDT', to: BOOK, amount: '100' }, status: 'confirmed', at: now - 50 * 60_000, own: true, by: 'human' },
  { request_id: 'awr_h3', agent: { id: 'ag_2bq1', name: 'research-bot' }, account: { id: 'acc_main', name: 'main' }, type: 'transfer', network: 'tron', intent: { asset: 'TRX', to: A2.tron, amount: '40' }, status: 'rejected', at: now - 3 * 3600_000, own: false, by: 'human' },
  { request_id: 'awr_h4', agent: { id: 'ag_7f3k', name: 'claude-bot' }, account: { id: 'acc_ops', name: 'ops' }, type: 'transfer', network: 'tron', intent: { asset: 'USDT', to: BOOK, amount: '3' }, status: 'rejected', at: now - 5 * 3600_000, own: false, by: 'pause' },
];
const prepared = {
  key: 'awr_r1', kind: 'agent', agent: { id: 'ag_7f3k', name: 'claude-bot', known: true }, account: { id: 'acc_ops', name: 'ops', tron: A1.tron, evm: A1.evm },
  network: 'tron', type: 'transfer', reason: reqs[0].reason, expires_at: reqs[0].expires_at, created_at: reqs[0].created_at,
  tx: { asset: 'USDT', asset_contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', amount: '25', from: A1.tron, to: BOOK, txID: '9c1f5b3e0a7d44c2b8e6f1a2d3c4b5a6978877665544332211ffeeddccbbaa99', fee_limit_trx: '30', expiration: iso(now + 600_000) },
  to_check: { in_book: { label: 'Склад USDT', id: 'ab_1' }, similar: [], first_time: false },
  resources: { need: { energy: 73_928, bandwidth: 345 }, have: { energy: 0, bandwidth: 600 }, deficit: { energy: 73_928, bandwidth: 0 }, activate: { sender: false, recipient: false },
    route: 'proxy', fallback_route: null, quotes: { proxy: { ok: true, cost_usdc: '0.48', approved_max_usdc: '0.576' }, direct: { ok: false, code: 'DIRECT_UNAVAILABLE', note: 'этап 1' } },
    approved_max_usdc: '0.576', payer: A1.evm, usdc_balance: '6.1', energy_source: 'node', buy: { energy: 73_928, bandwidth: 0, activate: [] } },
  blocked: null, warnings: [], built_at: now,
  repeat: { request_id: 'awr_h1', minutes_ago: 6, status: 'confirmed', amount: '25 USDT', count: 1 },
};

const answers: Record<string, (c: any) => any> = {
  status: () => status, touch: () => ({ autolock_at: now + 30 * 60_000 }), balances: (c) => balances[c.id],
  balancesCached: (c) => Object.fromEntries(c.ids.filter((id: string) => balances[id]).map((id: string) => [id, balances[id]])),
  newMnemonic: (c) => 'hamster diagram private dutch cause delay private meat slide toddler razor book happy fancy gospel tennis maple dilemma loan word shrug inflict delay length' /* BIP39 test vector */.split(' ').slice(0, c.words).join(' '),
  accountPreview: (c) => (c.seed_id === 'seed_w' ? { tron: 'TWkx3Ftd5LjBRrP7m8yVq2hJ4n5bC6dE7f', evm: '0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF', index: 2 }
    : c.seed_id ? { tron: 'TLfuHTv7TT2hxRHJ8Fhq3rQZ2cBDsGqsnL', evm: '0x4dBd4fc535Ac27206064B68FfCf827b0A60BAB3f', index: 3 }
    : c.privateKey ? { tron: 'TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC', evm: '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf' }
    : { tron: 'TXJgMdjVX5dKiQaUi9QobwNxtSQaFqccvd', evm: '0x7f7C1A3b4D5e6F7a8B9c0D1e2F3a4B5c6D7e8F9a', index: 0 }), prices: () => ({ TRX: 0.31257, energy_quote: { energy: 65000, price_usdc: '0.42' }, as_of: iso(now), coins: {
      TRX: { usd: 0.31257, source: 'coins.ceo', updated_at: iso(now) }, ETH: { usd: 1802.97, source: 'coins.ceo', updated_at: iso(now) },
      POL: { usd: 0.08232, source: 'coins.ceo', updated_at: iso(now) }, USDT: { usd: 0.99893, source: 'coins.ceo', updated_at: iso(now) },
      USDC: { usd: 1.00023, source: 'coins.ceo', updated_at: iso(now) } } }),
  history: (c) => history.filter((h) => !c.account_id || h.account.id === c.account_id), requests: () => reqs, prepare: (c) => (c.request_id === 'awr_s1' ? swapView : c.request_id === 'awr_n1' ? newAddrView : prepared), seen: () => null,
  agentsRefresh: () => [{ id: 'ag_7f3k', last_used_at: iso(now - 60_000) }], bookCheck: (c) => { const a = status.accounts.find((x: any) => x.addresses.tron === c.address || x.addresses.evm?.toLowerCase() === String(c.address).toLowerCase()); return { address: c.address, match: null, own: a ? { id: a.id, name: a.name, group: a.origin === 'imported' ? 'ключ' : a.seed_id === 'seed_w' ? 'Рабочая' : 'Основная' } : null,
    // 0.3.6 screenshots: a look-alike of the own «main» address (same start, other end) shows the warning plate
    similar: !a && String(c.address).startsWith(A0.tron.slice(0, 8)) ? [{ source: 'own', label: 'main', address: A0.tron }] : [] }; },
  swapQuote: () => ({ ok: true, amount_out: '34.254587', amount_out_min: '34.083314', rate: '1 USDT = 3.425459 TRX', route: [{ from: 'USDT', to: 'WTRX', version: 'v3', fee_pct: '0.05' }, { from: 'WTRX', to: 'TRX', version: 'wtrx', fee_pct: '0' }],
    reference: { price_usd: '0.2914', source: 'binance', stale: false, deviation_bps: 18 } }),
  resourceQuote: (c) => ({ product: c.product, amount: c.amount, address: A0.tron, price_usdc: c.product === 'bandwidth' ? '0.18' : '0.40', approved_max_usdc: c.product === 'bandwidth' ? '0.216' : '0.48', usdc_balance: '18.42' }),
  agentCreate: (c) => ({ id: 'ag_new1', name: c.name, token: 'aw_ag_new1_K4QZ7XN2B5TPLW3RJ6YDFM8CVHS4AEGQ', mcp_name: 'dontaskagain-' + String(c.name).toLowerCase().replace(/[^a-z0-9]+/g, '-'), old_mcp_name: null, signer_url: 'http://127.0.0.1:9985', mcp: '', claude: '' }),
  agentRotate: () => ({ id: 'ag_7f3k', name: 'claude-bot', token: 'aw_ag_7f3k_P8WN3ZK5QX2TMB7RJ4YDHF6CVLS9AEGQ', mcp_name: 'dontaskagain-claude-bot', old_mcp_name: 'agent-wallet', signer_url: 'http://127.0.0.1:9985', mcp: '', claude: '' }),
  agentRevoke: () => ({ mcp_name: 'dontaskagain-research-bot' }),
};

// ---- EVM: transfer, bridge, refuel, insufficient gas ----
const ME = A0.evm, TO = '0x3214a91bCd29b8ce7D3C5E26bE1cEa3E8D57b67C';
const TM = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d', MT = '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64';
const line = (o: any) => ({ network: 'evm:42161', chain_id: 42161, from: ME, value: '0', native: 'ETH', args: [], nonce: 41, gas: '72800', gas_source: 'estimate', max_fee_per_gas_gwei: '0.0201', fee_max_native: '0.00000146', to_label: '', ...o });
const gas = (o: any) => ({ network: 'evm:42161', native: 'ETH', need_native: '0.00000584', have_native: '0.0032', ok: true, fee_max_native: '0.00000584', max_fee_native: '0.002', above_max: false, ...o });
reqs.push(
  { request_id: 'awr_b1', agent: { id: 'ag_7f3k', name: 'claude-bot' }, account: { id: 'acc_main', name: 'main' }, type: 'bridge', network: 'evm:42161', intent: { asset: 'USDC', from_network: 'evm:42161', to_network: 'evm:8453', amount: '20', mode: 'fast', delivery: 'auto' }, reason: 'Нужны USDC на Base для оплаты ресурсов TRON', status: 'pending', created_at: iso(now - 5_000), expires_at: iso(now + 50 * 60_000) } as any,
);
const bridgeQ = { ok: true, from_network: 'evm:42161', to_network: 'evm:8453', amount: '20', receive_at_least: '20', burn: '20.002801', max_fee: '0.002801', protocol_fee: '0.002801', forward_fee: '0',
  mode_effective: 'fast', finality_threshold: 1000, minimum_fee_bps: '1.4', delivery: 'self', delivery_reason: 'есть ETH на газ в Base', eta_sec: 8, usdc_balance: '240', dst_gas: gas({ network: 'evm:8453', need_native: '0.0000026', have_native: '0.0021', fee_max_native: '0.0000026' }) };
const bridgeView = {
  key: 'awr_b1', kind: 'agent', agent: { id: 'ag_7f3k', name: 'claude-bot', known: true }, account: { id: 'acc_main', name: 'main', tron: A0.tron, evm: ME },
  network: 'evm:42161', type: 'bridge', reason: 'Нужны USDC на Base для оплаты ресурсов TRON', expires_at: iso(now + 50 * 60_000), created_at: iso(now - 5_000), blocked: null, warnings: [], built_at: now, repeat: null,
  bridge: { ...bridgeQ, from_name: 'Arbitrum One', to_name: 'Base', mode: 'fast', delivery_requested: 'auto', recipient: ME,
    approve: { needed: true, spender: TM, amount: '20.002801', current_allowance: '0' },
    steps: [line({ step: 'approve', to: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', to_label: 'USDC Arbitrum One', method: 'approve', args: [{ k: 'spender', v: TM }, { k: 'amount', v: '20002801' }] }),
      line({ step: 'burn', to: TM, to_label: 'CCTP TokenMessengerV2', method: 'depositForBurn', nonce: 42, gas: '400000', gas_source: 'typical', fee_max_native: '0.00000804',
        args: [{ k: 'amount', v: '20002801' }, { k: 'destinationDomain', v: '6' }, { k: 'mintRecipient', v: '0x000000000000000000000000' + ME.slice(2).toLowerCase() }, { k: 'maxFee', v: '2801' }, { k: 'minFinalityThreshold', v: '1000' }] })],
    gas: gas({ need_native: '0.0000095', fee_max_native: '0.0000095' }), mint: { by: 'wallet', network: 'evm:8453', message_transmitter: MT } },
};
const evmTransferView = {
  key: 'own_t1', kind: 'own', account: { id: 'acc_main', name: 'main', tron: A0.tron, evm: ME }, network: 'evm:42161', type: 'transfer', blocked: null, warnings: [], built_at: now, repeat: null,
  to_check: { in_book: { label: 'Подрядчик', id: 'ab_2' }, similar: [], first_time: false },
  evm: { kind: 'transfer', network: 'evm:42161', network_name: 'Arbitrum One', asset: 'USDC', amount: '40', to: TO, token: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    txs: [line({ step: 'transfer', to: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', to_label: 'USDC из списка', method: 'transfer', args: [{ k: 'to', v: TO }, { k: 'amount', v: '40000000' }] })], gas: gas({}) },
};
const noGasView = { ...evmTransferView, key: 'own_t2', network: 'evm:10', to_check: { similar: [], first_time: false },
  evm: { ...evmTransferView.evm, network: 'evm:10', network_name: 'Optimism', amount: '12', token: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', gas: gas({ network: 'evm:10', ok: false, have_native: '0', need_native: '0.0000021' }),
    txs: [line({ network: 'evm:10', chain_id: 10, step: 'transfer', to: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', to_label: 'USDC из списка', method: 'transfer', nonce: 0 })] },
  blocked: { reason_code: 'insufficient_gas', code: 'INSUFFICIENT_GAS', message: 'не хватает ETH на газ в сети Optimism: нужно 0.0000021, есть 0', detail: { network: 'evm:10', need_native: '0.0000021', have_native: '0', native: 'ETH' } },
  refuel_hint: { to_network: 'evm:10' } };
const refuelView = {
  key: 'ref_1', kind: 'own', account: { id: 'acc_main', name: 'main', tron: A0.tron, evm: ME }, network: 'evm:1', type: 'refuel', blocked: null, warnings: [], built_at: now, repeat: null,
  evm: { kind: 'refuel', network: 'evm:1', network_name: 'Ethereum', asset: 'ETH', amount: '0.003', to: ME,
    txs: [line({ network: 'evm:1', chain_id: 1, step: 'refuel', to: '0x3154Cf16ccdb4C6d922629664174b904d80F2C35', to_label: 'L1StandardBridge Base', method: 'depositETH', value: '0.003', nonce: 12, gas: '128700', max_fee_per_gas_gwei: '18.4', fee_max_native: '0.00236',
      args: [{ k: 'minGasLimit', v: '200000' }, { k: 'extraData', v: '0x' }] })],
    gas: gas({ network: 'evm:1', need_native: '0.00536', have_native: '0.041', fee_max_native: '0.00236', max_fee_native: '0.01' }),
    refuel: { to_network: 'evm:8453', to_name: 'Base', kind: 'op_stack', l1_contract: '0x3154Cf16ccdb4C6d922629664174b904d80F2C35', eta_sec: 180, l2_balance: '0.0021' } },
};
Object.assign(answers, {
  bridgeQuote: () => bridgeQ, bridgePrepare: () => ({ ...bridgeView, kind: 'own', key: 'brg_1', reason: undefined }), refuelPrepare: () => refuelView,
  evmPrepare: (c: any) => (c.network === 'evm:10' ? noGasView : evmTransferView),
});
// 0.2.1 operation page samples
const HX = (c: string) => '0x' + c.repeat(32);
const brBase = { type: 'bridge', network: 'evm:1', agent: null, account: { id: 'acc_main', name: 'main' }, created_at: iso(now - 7 * 60_000),
  intent: { asset: 'USDC', from_network: 'evm:1', to_network: 'evm:8453', amount: '30', mode: 'standard', delivery: 'auto' } };
const brSteps = [{ step: 'approve', status: 'confirmed', network: 'evm:1', tx: { tx_id: HX('a3'), fee: { native: '0.000214' } } }, { step: 'burn', status: 'confirmed', network: 'evm:1', tx: { tx_id: HX('b7'), fee: { native: '0.000391' } } }];
const OPS: Record<string, any> = {
  op_br_run: { ...brBase, request_id: 'op_br_run', status: 'broadcast', bridge: { from_network: 'evm:1', to_network: 'evm:8453', amount: '30', burn_amount: '30.00014', max_fee: '0.00014', fee_executed: null, mode_effective: 'standard', delivery: 'self', state: 'attesting',
    steps: [...brSteps, { step: 'mint', status: 'waiting', network: 'evm:8453', by: 'wallet', tx: null }] } },
  op_br_done: { ...brBase, request_id: 'op_br_done', status: 'confirmed', created_at: iso(now - 26 * 60_000), confirmed_at: iso(now - 4 * 60_000), bridge: { from_network: 'evm:1', to_network: 'evm:8453', amount: '30', burn_amount: '30.00014', max_fee: '0.00014', fee_executed: '0.00012', mode_effective: 'standard', delivery: 'self', state: 'done',
    mint: { by: 'wallet', tx_id: HX('c1') }, steps: [...brSteps, { step: 'mint', status: 'confirmed', network: 'evm:8453', by: 'wallet', tx: { tx_id: HX('c1'), fee: { native: '0.0000021' } } }] } },
  op_rf: { request_id: 'op_rf', type: 'refuel', network: 'evm:1', status: 'broadcast', agent: null, account: { id: 'acc_main', name: 'main' }, created_at: iso(now - 2 * 60_000), intent: { from_network: 'evm:1', to_network: 'evm:8453', amount_eth: '0.003' },
    tx: { tx_id: HX('d4'), fee: { native: '0.00048' } }, refuel: { to_network: 'evm:8453', amount_eth: '0.003', state: 'l2_pending' } },
  op_sw: { request_id: 'op_sw', type: 'swap', network: 'tron', status: 'confirmed', agent: { id: 'ag_7f3k', name: 'claude-bot' }, reason: 'Нужен TRX на комиссии', account: { id: 'acc_ops', name: 'ops' }, created_at: iso(now - 3 * 60_000), confirmed_at: iso(now - 2 * 60_000),
    intent: { asset_in: 'USDT', asset_out: 'TRX', amount_in: '10' }, swap: { amount_out_min: '34.083314', steps: [{ step: 'approve', status: 'confirmed', tx: { tx_id: 'e5'.repeat(32), fee: { native: '0' } } }, { step: 'swap', status: 'confirmed', tx: { tx_id: 'f6'.repeat(32), fee: { native: '0' } } }] } },
};
// 0.3.6 screenshots: a refused and a failed operation (the canceled / network-error mascot of the operation page)
(OPS as any).op_rej = { ...(OPS as any).op_br_run, request_id: 'op_rej', status: 'rejected' };
(OPS as any).op_fail = { ...(OPS as any).op_br_run, request_id: 'op_fail', status: 'failed', error: { code: 'NODE_UNAVAILABLE' } };
(answers as any).op = (c: any) => buildOp(OPS[c.request_id] ?? OPS.op_br_run);

// ?e2e=1 (0.3.1): own Signer with end-to-end encryption on, wallet key fingerprint, direct read endpoints;
// a new agent is created for the npx way (wallet key + one-time pairing code in the command)
if (q.get('e2e') === '1') {
  const FP = 'K7QX-M2PA-9RTD-4WZE-H6NB-3CJF';
  (status as any).e2e = { server_mode: 'on', active: true, wanted: true, wallet_fp: FP, wallet_key: 'daa1.x25519.ed25519.Q2xhdWRlIHByZXZpZXcga2V5', public_signer_url: 'https://signer.dontaskagain.example', public_placeholder: true };
  Object.assign(status.settings, { signer_mode: 'own', e2e_enabled: true, e2e_reads: 'direct', e2e_tron_node: 'https://node.example', e2e_rpc: {}, x402_gateway_url: 'https://api.awesomefee.com/x402/v1', mcp_launch: 'npx', mcp_launch_path: '' });
  const create0 = answers.agentCreate;
  answers.agentCreate = (c: any) => ({ ...create0(c), launch: c.launch ?? 'npx',
    e2e: { wallet_fp: FP, wallet_key: 'daa1.x25519.ed25519.Q2xhdWRlIHByZXZpZXcga2V5', pair: 'PAIR-7HQ2-KX4M', pair_expires_at: iso(now + 24 * 3600_000), key_mode: c.launch === 'remote' ? 'server' : 'agent' } });
}
// ?e2e=public (0.3.12): the public Signer (E2E required, everything read through it); History = own operations from
// the wallet's local history + token transfers of the EVM address read from the chain; the E2E operation pages
if (q.get('e2e') === 'public') {
  (status as any).e2e = { server_mode: 'required', active: true, wanted: true, wallet_fp: 'K7QX-M2PA-9RTD-4WZE-H6NB-3CJF', wallet_key: 'daa1.x25519.ed25519.Q2xhdWRlIHByZXZpZXcga2V5', public_signer_url: 'https://signer.dontaskagain.xyz', public_placeholder: false };
  Object.assign(status.settings, { signer_mode: 'public', e2e_enabled: true, e2e_reads: 'signer' });
  const ST = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
  const e2eHist = [
    { request_id: 'op_e2e_run', agent: { id: 'ag_7f3k', name: 'claude-bot' }, account: { id: 'acc_main', name: 'main' }, type: 'transfer', network: 'tron', intent: { asset: 'USDT', to: BOOK, amount: '25' }, status: 'broadcast', at: now - 40_000, own: false, by: 'human', status_label: 'отправлено, ждём блок' },
    { request_id: 'chain:evm:8453:' + HX('9a') + ':3', account: { id: 'acc_main', name: 'main' }, type: 'transfer', network: 'evm:8453', intent: { asset: 'USDC', amount: '120', from: ST }, status: 'confirmed', at: now - 25 * 60_000, own: false, by: 'server',
      chain: { dir: 'in', counterparty: ST, txid: HX('9a'), block: 38_745_112 } },
    { request_id: 'op_sw', account: { id: 'acc_main', name: 'main' }, type: 'swap', network: 'tron', intent: { asset_in: 'USDT', asset_out: 'TRX', amount_in: '10' }, swap: { amount_out_min: '34.083314' }, status: 'confirmed', at: now - 52 * 60_000, own: true, by: 'human' },
    { request_id: 'op_br_done', account: { id: 'acc_main', name: 'main' }, type: 'bridge', network: 'evm:1', intent: { asset: 'USDC', from_network: 'evm:1', to_network: 'evm:8453', amount: '30' }, status: 'confirmed', at: now - 3 * 3600_000, own: true, by: 'human' },
    { request_id: 'chain:evm:42161:' + HX('7b') + ':0', account: { id: 'acc_main', name: 'main' }, type: 'transfer', network: 'evm:42161', intent: { asset: 'USDT', amount: '15.5', to: ST }, status: 'confirmed', at: now - 7 * 3600_000, own: false, by: 'server',
      chain: { dir: 'out', counterparty: ST, txid: HX('7b'), block: 402_118_907, estimated: true } },
  ];
  answers.history = (c: any) => (c.account_id ? e2eHist.filter((h) => h.account.id === c.account_id) : e2eHist);
  (answers as any).chainStatus = () => ({ at: now - 30_000, errors: [], loading: false });
  OPS.op_e2e_run = { request_id: 'op_e2e_run', type: 'transfer', network: 'tron', status: 'broadcast', agent: { id: 'ag_7f3k', name: 'claude-bot' }, reason: 'Оплата счёта #118 поставщику', account: { id: 'acc_main', name: 'main' },
    created_at: iso(now - 40_000), intent: { asset: 'USDT', to: BOOK, amount: '25' }, e2e: { agent_id: 'ag_7f3k' },
    resources: { route: 'proxy', state: 'delivered', cost_usdc: '0.48', x402: [{ route: 'proxy', product: 'tron/send', state: 'delivered' }] }, tx: { network: 'tron', tx_id: '9c1f5b3e0a7d44c2b8e6f1a2d3c4b5a6978877665544332211ffeeddccbbaa99' } };
  OPS.op_e2e_done = { ...OPS.op_e2e_run, request_id: 'op_e2e_done', status: 'confirmed', confirmed_at: iso(now - 20_000), tx: { ...OPS.op_e2e_run.tx, fee: { native: '0' } } };
  const chainIn = { id: e2eHist[1].request_id, account_id: 'acc_main', network: 'evm:8453', txid: HX('9a'), log_index: 3, block: 38_745_112, at: now - 25 * 60_000, dir: 'in', asset: 'USDC', amount: '120', from: ST, to: A0.evm };
  const op0 = (answers as any).op;
  (answers as any).op = (c: any) => (String(c.request_id).startsWith('chain:') ? chainOpView(chainIn as any) : op0(c));
}
// ?client=claude|codex|json (0.3.8): the MCP client the connect step prints commands for
if (q.get('client')) (status.settings as any).mcp_client = q.get('client');
const prepare0 = answers.prepare;
answers.prepare = (c: any) => (c.request_id === 'awr_b1' ? bridgeView : prepare0(c));

// ?lang=en: the UI language (chrome.storage.local ui_lang) and the mock's own data (names, agents' reasons, worker
// texts) in English, so the English screenshots are not mixed; without it — ru as before.
const LANG = q.get('lang') === 'en' ? 'en' : 'ru';
// ?theme=dark|light|system (0.3.6): the saved theme choice (chrome.storage.local ui_theme)
const THEME = q.get('theme') ?? 'light';
const EN: [string, string][] = [
  ['Оплата склада за ноябрь, счёт №1142 — повтор, первая отправка не дошла', 'Warehouse payment for November, invoice #1142 — a retry, the first send did not arrive'],
  ['Оплата подписки на данные, новый адрес продавца', 'Data subscription payment, the seller’s new address'],
  ['Нужны USDC на Base для оплаты ресурсов TRON', 'Need USDC on Base to pay for TRON resources'],
  ['Нужен TRX на комиссии: меняю 10 USDT', 'Need TRX for fees: swapping 10 USDT'],
  ['Нужен TRX на комиссии', 'Need TRX for fees'],
  ['Пополнить ops на комиссии', 'Top up ops for fees'],
  ['не хватает ETH на газ в сети Optimism: нужно 0.0000021, есть 0', 'not enough ETH for gas on Optimism: need 0.0000021, have 0'],
  ['есть ETH на газ в Base', 'there is ETH for gas on Base'], ['USDC из списка', 'USDC from the list'],
  ['энергия > 300000', 'energy > 300000'], ['не поддерживается', 'not supported yet'],
  ['Склад USDT', 'USDT warehouse'], ['Подрядчик', 'Contractor'], ['Основная', 'Main'], ['Рабочая', 'Work'], ['ключ', 'key'],
];
const loc = (x: unknown): unknown => {
  if (LANG !== 'en' || x === null || x === undefined) return x;
  let j = JSON.stringify(x);
  for (const [r, e] of EN) j = j.split(JSON.stringify(r).slice(1, -1)).join(JSON.stringify(e).slice(1, -1));
  return JSON.parse(j);
};
(globalThis as any).chrome = {
  storage: { local: { get: async () => ({ ui_lang: LANG, ui_theme: THEME }), set: async () => {} }, onChanged: { addListener() {} } },
  runtime: {
    id: status.extension_id,
    sendMessage: async (c: any) => ({ ok: true, result: loc((answers[c.cmd] ?? (() => null))(c)) }),
    onMessage: { addListener() {}, removeListener() {} },
    connect: () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, disconnect() {} }),
    getURL: (p: string) => p,
  },
  sidePanel: { open: async () => {} },
  windows: { getCurrent: async () => ({ id: 1 }) },
  permissions: { request: async () => true },
};

// ?act=click:.sel|type:.sel=text|focus:.sel|wait:300 — steps after the first render (focus: 0.3.7, the focus ring check)
const steps = (q.get('act') ?? '').split('|').filter(Boolean);
async function act() {
  await new Promise((r) => setTimeout(r, 400));
  for (const s of steps) {
    const [k, rest] = [s.slice(0, s.indexOf(':')), s.slice(s.indexOf(':') + 1)];
    if (k === 'wait') { await new Promise((r) => setTimeout(r, Number(rest))); continue; }
    if (k === 'scroll') { (document.querySelector(decodeURIComponent(rest)) as HTMLElement | null)?.scrollIntoView({ block: 'start' }); }
    if (k === 'text') { const t = decodeURIComponent(rest); ([...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === t) as HTMLElement | undefined)?.click(); }
    if (k === 'focus') { const [sel, i] = rest.split('@'); (document.querySelectorAll(decodeURIComponent(sel))[Number(i ?? 0)] as HTMLElement | undefined)?.focus(); }
    if (k === 'click') { const [sel, i] = rest.split('@'); (document.querySelectorAll(sel)[Number(i ?? 0)] as HTMLElement | undefined)?.click(); }
    if (k === 'type') {
      const cut = rest.lastIndexOf('='); const [sel, text] = [rest.slice(0, cut), rest.slice(cut + 1)];
      const [css, i] = sel.split('@');
      const el = document.querySelectorAll(css)[Number(i ?? 0)] as HTMLInputElement | HTMLTextAreaElement | undefined;
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      if (el) { Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, decodeURIComponent(text)); el.dispatchEvent(new Event('input', { bubbles: true })); }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}
window.confirm = () => true; // preview: confirm dialogs say yes
void act();
