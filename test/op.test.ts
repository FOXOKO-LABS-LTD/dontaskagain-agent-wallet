// 0.2.1 operation page: the timeline built from the request object (bridge in progress / done, refuel, swap, TRON with
// resources), history without step rows and with progress, request.update carrying the whole request, the
// notification at the end of a multi-step operation, the page refreshed from GET /v1/ext/requests/{id}.
import { installFakeChrome } from './helpers/fake-chrome';
import { startMockSigner, type MockState } from './helpers/mock-signer';
import { hdAddresses, seedFromMnemonic } from '../src/lib/wallet/derive';
import { buildOp, elapsed, explorerTx, finishText } from '../src/lib/op';
// 0.3.7: ranges in the texts carry a word joiner after the dash (no line break inside «1–5»); compare without it
const wj = (s?: string) => (s ?? '').replace(/\u2060/g, '');

const H = (c: string) => '0x' + c.repeat(64);
const bridgeReq = (over: any = {}, bridge: any = {}) => ({
  request_id: 'awr_br1', type: 'bridge', network: 'evm:1', status: 'broadcast', agent: null, account: { id: 'acc_m', name: 'main' }, created_at: '2026-11-19T10:00:00Z',
  intent: { asset: 'USDC', from_network: 'evm:1', to_network: 'evm:8453', amount: '30', mode: 'standard', delivery: 'auto' },
  bridge: { from_network: 'evm:1', to_network: 'evm:8453', amount: '30', burn_amount: '30.000140', max_fee: '0.000140', fee_executed: null, mode: 'standard', mode_effective: 'standard', delivery: 'self', state: 'attesting',
    steps: [{ step: 'approve', status: 'confirmed', network: 'evm:1', tx: { tx_id: H('a'), fee: { native: '0.00021' } } }, { step: 'burn', status: 'confirmed', network: 'evm:1', tx: { tx_id: H('b'), explorer_url: 'https://etherscan.io/tx/' + H('b') } },
      { step: 'mint', request_id: null, status: 'waiting', network: 'evm:8453', by: 'wallet', tx: null }], ...bridge },
  ...over,
});

describe('operation view (pure)', () => {
  it('bridge in progress: approve → burn → Circle → receipt, standard-mode wait, «в пути: ждём Circle», progress', () => {
    const v = buildOp(bridgeReq());
    expect(v.title).toBe('Мост 30 USDC: Ethereum → Base');
    expect(v.initiator).toBe('вы');
    expect(v.steps.map((s) => [s.key, s.state])).toEqual([['approve', 'done'], ['burn', 'done'], ['attest', 'active'], ['mint', 'waiting']]);
    expect(wj(v.steps[2].eta)).toMatch(/обычный режим: ждём финальности Ethereum ~15–20 мин/);
    expect(v.steps[0].tx).toMatchObject({ url: 'https://etherscan.io/tx/' + H('a'), short: '0xaaaaaa…aaaaaa' });
    expect(v.steps[0].fee).toBe('0.00021 ETH');
    expect(v.status_label).toBe('в пути: ждём Circle');
    expect(v.progress).toBe('шаг 3 из 4 · ждём Circle');
    expect(v.facts).toEqual(expect.arrayContaining([{ k: 'Получите', v: '30 USDC в Base' }, { k: 'Сожжётся', v: '30.00014 USDC в Ethereum' }, { k: 'Комиссия Circle, не больше', v: '0.00014 USDC' }]));
    expect(v.final).toBe(false);
  });

  it('bridge waiting for gas, then done with the mint tx on basescan; fast mode wording', () => {
    const g = buildOp(bridgeReq({}, { state: 'awaiting_gas', mode_effective: 'fast' }));
    expect(g.steps[2]).toMatchObject({ state: 'done' });
    expect(g.steps[3]).toMatchObject({ state: 'active', note: expect.stringMatching(/ждём газ в Base/) });
    expect(g.status_label).toBe('в пути: ждём газ в Base');
    const d = buildOp(bridgeReq({ status: 'confirmed', confirmed_at: '2026-11-19T10:18:00Z' }, { state: 'done', fee_executed: '0.00012', mint: { by: 'wallet', tx_id: H('c') },
      steps: [{ step: 'burn', status: 'confirmed', tx: { tx_id: H('b') } }, { step: 'mint', status: 'confirmed', tx: { tx_id: H('c') } }] }));
    expect(d.steps.map((s) => s.state)).toEqual(['done', 'done', 'done']);
    expect(d.steps[2].tx?.url).toBe('https://basescan.org/tx/' + H('c'));
    expect(d.status_label).toBe('готово: USDC в Base');
    expect(d.progress).toBeUndefined();
    expect(d.facts).toContainEqual({ k: 'Комиссия Circle', v: '0.00012 USDC' });
    expect(buildOp(bridgeReq({}, { mode_effective: 'fast' })).steps[2].eta).toMatch(/быстрый режим/);
    expect(finishText(bridgeReq({ status: 'confirmed' }))).toEqual({ title: 'Мост завершён', message: '30 USDC пришли в Base' });
  });

  it('refuel: deposit in L1 → credit in L2 with the expected time; Arbitrum slower', () => {
    const r = { request_id: 'awr_rf1', type: 'refuel', network: 'evm:1', status: 'broadcast', intent: { from_network: 'evm:1', to_network: 'evm:8453', amount_eth: '0.003' }, tx: { tx_id: H('d') },
      refuel: { to_network: 'evm:8453', amount_eth: '0.003', state: 'l2_pending' } };
    const v = buildOp(r);
    expect(v.title).toBe('Заправка газом 0.003 ETH: Ethereum → Base');
    expect(v.steps.map((s) => [s.key, s.state])).toEqual([['deposit', 'done'], ['credit', 'active']]);
    expect(wj(v.steps[1].eta)).toBe('обычно 1–5 мин');
    expect(v.status_label).toBe('в пути: зачисление в Base');
    expect(wj(buildOp({ ...r, intent: { ...r.intent, to_network: 'evm:42161' }, refuel: { ...r.refuel, to_network: 'evm:42161' } }).steps[1].eta)).toBe('обычно 10–15 мин');
    expect(buildOp({ ...r, status: 'confirmed', refuel: { ...r.refuel, state: 'credited' } }).steps.every((s) => s.state === 'done')).toBe(true);
  });

  it('swap steps and a TRON transfer with a resource purchase', () => {
    const s = buildOp({ request_id: 'awr_s', type: 'swap', network: 'tron', status: 'broadcast', agent: { id: 'ag_1', name: 'bot' }, intent: { asset_in: 'USDT', asset_out: 'TRX', amount_in: '10' },
      swap: { amount_out_min: '33.1', steps: [{ step: 'approve', status: 'confirmed', tx: { tx_id: 'ab'.repeat(32) } }, { step: 'swap', status: 'broadcast', tx: null }] } });
    expect(s.initiator).toBe('агент «bot»');
    expect(s.steps.map((x) => x.state)).toEqual(['done', 'active']);
    expect(s.steps[0].tx?.url).toBe('https://tronscan.org/#/transaction/' + 'ab'.repeat(32));
    expect(s.progress).toBe('шаг 2 из 2 · обмен');
    const t = buildOp({ request_id: 'awr_t', type: 'transfer', network: 'tron', status: 'signed', intent: { asset: 'USDT', to: 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8', amount: '5' }, resources: { route: 'proxy', state: 'paid', cost_usdc: '0.48' } });
    expect(t.steps.map((x) => [x.key, x.state])).toEqual([['resources', 'active'], ['send', 'active'], ['confirm', 'waiting']]);
    expect(t.status_label).toBe('подписано, отправляется');
  });

  it('Proxy refund of the activation share: в очереди → отправлен (tx) → подтверждён', () => {
    const mk = (refund: any) => buildOp({ request_id: 'awr_rf', type: 'transfer', network: 'tron', status: 'confirmed', intent: { asset: 'TRX', to: 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8', amount: '1' },
      tx: { tx_id: 'ab'.repeat(32) }, resources: { route: 'proxy', state: 'delivered', cost_usdc: '0.42', x402: [{ product: 'tron/send', refund }] } });
    const q = mk({ status: 'queued', reason: 'activation_not_ours', amount_usdc: '0.343750', activated_by_other: ['receiver'] });
    expect(q.steps[0].note).toBe('аккаунт получателя активировал кто-то другой — доля за активацию возвращается');
    expect(q.steps.at(-1)).toMatchObject({ key: 'refund', state: 'active', note: 'возврат: в очереди — аккаунт активировал кто-то другой', amount: '+0.34375 USDC' });
    expect(q.facts).toContainEqual({ k: 'Возврат', v: '0.34375 USDC: в очереди' });
    const sent = mk({ status: 'sent', reason: 'activation_not_ours', amount_usdc: '0.343750', tx: '0x' + 'c'.repeat(64), to: '0xpayer' });
    expect(sent.steps.at(-1)).toMatchObject({ state: 'active', tx: { url: 'https://basescan.org/tx/0x' + 'c'.repeat(64) } });
    expect(sent.steps.at(-1)!.note).toMatch(/^возврат: отправлен/);
    expect(mk({ status: 'confirmed', reason: 'activation_not_ours', amount_usdc: '0.343750', tx: '0x' + 'c'.repeat(64) }).steps.at(-1)).toMatchObject({ state: 'done' });
  });

  it('elapsed and explorer links', () => {
    expect(elapsed('2026-11-19T10:00:00Z', Date.parse('2026-11-19T10:12:30Z'))).toBe('12 мин');
    expect(elapsed('2026-11-19T10:00:00Z', Date.parse('2026-11-19T10:00:09Z'))).toBe('9 с');
    expect(explorerTx('evm:10', H('e'))).toBe('https://optimistic.etherscan.io/tx/' + H('e'));
    expect(explorerTx('evm:137', H('e'))).toBe('https://polygonscan.com/tx/' + H('e'));
    expect(explorerTx('evm:42161', H('e'))).toBe('https://arbiscan.io/tx/' + H('e'));
  });
});

const ABOUT = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const A0 = hdAddresses(seedFromMnemonic(ABOUT), 0);
const st: MockState = { accounts: { [A0.tron]: { exists: true, balanceSun: 0, energy: 0, freeNet: 600, usdt: 0n } }, usdcMicro: 0n, coverPrice: '0.48', energyUsed: 64_285 };
const fake = installFakeChrome();
const call = fake.call;
let mock: Awaited<ReturnType<typeof startMockSigner>>;
const tick = (ms = 250) => new Promise((r) => setTimeout(r, ms));
beforeAll(async () => { mock = await startMockSigner(st); await import('../src/background/index'); });
afterAll(async () => { await call({ cmd: 'disconnect' }).catch(() => {}); await mock.close(); });

describe('operation page (worker + mock Signer)', () => {
  it('history: steps hidden, the parent with progress; request.update with the whole request; notification at the end', async () => {
    await call({ cmd: 'createWallet', mnemonic: ABOUT, password: 'correct horse battery' });
    const acc = (await call({ cmd: 'status' })).accounts[0];
    const parent = bridgeReq({ account: { id: acc.id, name: 'main' } });
    st.history = [parent,
      { request_id: 'awr_st1', type: 'bridge_step', parent_request_id: 'awr_br1', status: 'confirmed', network: 'evm:1', account: { id: acc.id, name: 'main' }, intent: { step: 'approve' }, created_at: parent.created_at },
      { request_id: 'awr_st2', type: 'bridge_step', parent_request_id: 'awr_br1', status: 'confirmed', network: 'evm:1', account: { id: acc.id, name: 'main' }, intent: { step: 'burn' }, created_at: parent.created_at }];
    await call({ cmd: 'settings', patch: { signer_url: mock.url } });
    await call({ cmd: 'connect' });
    await tick(200);
    const h = await call({ cmd: 'history', account_id: acc.id });
    expect(h.map((x: any) => x.request_id)).toEqual(['awr_br1']);
    expect(h[0]).toMatchObject({ status_label: 'в пути: ждём Circle', progress: 'шаг 3 из 4 · ждём Circle' });
    await tick(400); // the history fetch started by hello settles first (it carries the older state)
    // a bridge state change arrives as request.update with the whole object
    mock.push({ type: 'request.update', id: 'u1', request_id: 'awr_br1', status: 'broadcast', event: 'request.bridge', request: { ...parent, bridge: { ...parent.bridge, state: 'minting' } } });
    await tick();
    expect((await call({ cmd: 'op', request_id: 'awr_br1' })).steps.map((s: any) => s.state)).toEqual(['done', 'done', 'done', 'active']);
    expect(fake.notifications.length).toBe(0);
    const done = { ...parent, status: 'confirmed', bridge: { ...parent.bridge, state: 'done', mint: { by: 'wallet', tx_id: H('c') }, steps: [...parent.bridge.steps.slice(0, 2), { step: 'mint', status: 'confirmed', tx: { tx_id: H('c') } }] } };
    mock.push({ type: 'request.update', id: 'u2', request_id: 'awr_br1', status: 'confirmed', request: done });
    await tick();
    const n = fake.notifications.find((x) => x[0] === 'op:awr_br1');
    expect(n?.[1]).toMatchObject({ title: 'Мост завершён', message: '30 USDC пришли в Base' });
    mock.push({ type: 'request.update', id: 'u3', request_id: 'awr_br1', status: 'confirmed', request: done });
    await tick();
    expect(fake.notifications.filter((x) => x[0] === 'op:awr_br1')).toHaveLength(1); // once
    const v = await call({ cmd: 'op', request_id: 'awr_br1' });
    expect(v).toMatchObject({ status_label: 'готово: USDC в Base', final: true });
  });

  it('a request not known locally is read from GET /v1/ext/requests/{id}; unknown → NOT_FOUND', async () => {
    st.requestsById = { awr_rf9: { request_id: 'awr_rf9', type: 'refuel', network: 'evm:1', status: 'broadcast', agent: null, account: { id: 'acc_x', name: 'main' }, created_at: new Date().toISOString(),
      intent: { from_network: 'evm:1', to_network: 'evm:10', amount_eth: '0.002' }, tx: { tx_id: H('f') }, refuel: { to_network: 'evm:10', amount_eth: '0.002', state: 'l1_pending' } } };
    const v = await call({ cmd: 'op', request_id: 'awr_rf9' });
    expect(v.title).toBe('Заправка газом 0.002 ETH: Ethereum → Optimism');
    expect(v.steps[0].tx.url).toBe('https://etherscan.io/tx/' + H('f'));
    await expect(call({ cmd: 'op', request_id: 'awr_nope' })).rejects.toThrow(/NOT_FOUND/);
  });
});
