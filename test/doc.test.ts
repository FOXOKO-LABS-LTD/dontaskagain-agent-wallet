import { buildDoc, docDigest, docForDigest, signDoc, docSignText, rulesHash } from '../src/lib/wallet/doc';
import { defaultVault, normalizeVault } from '../src/lib/wallet/model';
import { jcs } from '../src/lib/jcs';
import { recoverEvmMessage, recoverTronMessage } from '../src/lib/sign';
import { hdKeys, hdAddresses, seedFromMnemonic } from '../src/lib/wallet/derive';

const seed = seedFromMnemonic('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const a0 = hdAddresses(seed, 0);

describe('wallet document', () => {
  const v = defaultVault({ imported: {} });
  v.agents.ag_1 = { name: 'claude-bot', accounts: ['acc_a'], allowed_types: ['transfer', 'x402_pay', 'contract_call', 'tron_resource'] };
  v.address_book.push({ id: 'ab_1', label: 'Склад', network: 'tron', address: 'TKHbK1wMSczfEFuSSgXBvz5RkH3tcmSU4A' });
  const accounts = [{ id: 'acc_a', name: 'main', origin: 'hd' as const, hd_index: 0, addresses: { tron: a0.tron, evm: a0.evm } }];
  const doc = buildDoc('wal_1', 3, accounts, v, new Date('2026-11-17T09:00:00Z'));
  it('0.3.5: no auto-sign parts — agents carry no rules / temp, global only the similar-address cfg', () => {
    expect(doc.agents.ag_1).toEqual({ name: 'claude-bot', accounts: ['acc_a'], allowed_types: ['transfer', 'x402_pay', 'contract_call', 'tron_resource'] });
    expect(doc.global).toEqual({ similar: { prefix: 4, suffix: 4 } });
    const f = docForDigest(doc) as any;
    expect(f.agents.ag_1).toEqual(doc.agents.ag_1); // nothing to replace (the Signer's DocDigest does the same)
    expect(docDigest(doc)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(doc.updated_at).toBe('2026-11-17T09:00:00Z');
  });
  it('a document that still has rules (≤ 0.3.4 form): rules are replaced by their hash in the digest form', () => {
    const old: any = { ...doc, agents: { ag_1: { ...doc.agents.ag_1, rules: { acc_a: { x402: { enabled: false }, transfer: { enabled: false } } }, temp: [] } } };
    const f = docForDigest(old) as any;
    expect(f.agents.ag_1.rules).toBeUndefined();
    expect(f.agents.ag_1.rules_hash).toBe(rulesHash(old.agents.ag_1.rules));
  });
  it('0.3.5: an old vault with auto-sign fields loads — the fields are dropped, nothing else changes', () => {
    const old: any = {
      secrets: { seeds: [], imported: {} },
      global: { auto_enabled: true, window: 'rolling_24h', wallet_per_day: { 'tron/USDT': '60' }, similar: { prefix: 5, suffix: 3 } },
      address_book: [{ id: 'ab_1', label: 'Склад', network: 'tron', address: 'TKHbK1wMSczfEFuSSgXBvz5RkH3tcmSU4A' }],
      agents: { ag_1: { name: 'bot', accounts: ['acc_a'], allowed_types: ['transfer'], known_types: ['transfer'], temp: [{ kind: 'x402_repeat' }],
        rules: { acc_a: { transfer: { enabled: true, per_tx: { 'tron/USDT': '10' } }, x402: { enabled: true } } } } },
      networks_trusted: ['tron'], spend: [{ at: '2026-11-17T09:00:00Z', agent_id: 'ag_1', account_id: 'acc_a', key: 'tron/USDT', network: 'tron', amount: '5', request_id: 'r1' }],
      recipients: [], bridge_approvals: { r1: { parent: 'r1' } },
    };
    const v2: any = normalizeVault(old);
    expect(v2.spend).toBeUndefined();
    expect(v2.global).toEqual({ similar: { prefix: 5, suffix: 3 } });
    expect(v2.agents.ag_1).toEqual({ name: 'bot', accounts: ['acc_a'], allowed_types: ['transfer'], known_types: ['transfer'] });
    expect(v2.address_book).toEqual(old.address_book);
    expect(v2.networks_trusted).toEqual(['tron']);
    expect(v2.bridge_approvals).toEqual(old.bridge_approvals);
    const d = buildDoc('wal_1', 4, accounts, v2);
    expect(JSON.stringify(d)).not.toMatch(/auto_enabled|wallet_per_day|"rules"|"temp"|spend/);
    // garbage in → a usable vault, no crash
    expect(normalizeVault({ secrets: { imported: {} }, global: null, agents: { x: null } }).global.similar).toEqual({ prefix: 4, suffix: 4 });
  });
  it('JCS ordering is stable', () => {
    expect(jcs({ b: 1, a: [true, null, 'x'], c: { z: 1, y: 2 } })).toBe('{"a":[true,null,"x"],"b":1,"c":{"y":2,"z":1}}');
  });
  it('0.3.2: the text names the Signer; a wallet_id or host that would change its lines is refused', async () => {
    const d2 = buildDoc('wal_1', 3, accounts, v, new Date('2026-11-17T09:00:00Z'), 'signer.example:9985');
    const s = await signDoc(d2, hdKeys(seed, 0));
    const text = docSignText('wal_1', 3, s.digest, 'signer.example:9985');
    expect(text.split('\n')).toEqual(['Agent Wallet document', 'Service: signer.example:9985', 'Wallet: wal_1', 'Version: 3', `Digest: ${s.digest}`]);
    expect(await recoverEvmMessage(text, s.sig_evm)).toBe(a0.evm);
    expect(await recoverEvmMessage(docSignText('wal_1', 3, s.digest), s.sig_evm)).not.toBe(a0.evm); // not valid for the old text / another host
    expect(() => docSignText('wal_1\nVersion: 999', 3, s.digest)).toThrow(/BAD_WALLET_ID/);
    expect(() => docSignText('wal_1', 3, s.digest, 'evil\nWallet: wal_2')).toThrow(/BAD_SERVICE/);
  });
  it('signatures of the root recover', async () => {
    const s = await signDoc(doc, hdKeys(seed, 0));
    const text = docSignText('wal_1', 3, s.digest);
    expect(await recoverEvmMessage(text, s.sig_evm)).toBe(a0.evm);
    expect(await recoverTronMessage(text, s.sig_tron)).toBe(a0.tron);
  });
});
