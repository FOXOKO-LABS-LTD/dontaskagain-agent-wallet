// MV3 service worker: the only place where keys are decrypted and used.
import { newMnemonic } from '../lib/wallet/derive';
import { normalizeTron } from '../lib/tron/address';
import { bookMatch } from '../lib/similar';
import { ownEntries, recipientCheck } from '../lib/ownAccounts';
import { randomId } from '../lib/bytes';
import { requireSecureUrl } from '../lib/urlPolicy';
import { DEFAULT_SETTINGS, isMcpLaunch, newTypesOf, normalizeReads, rootAccount, rpcOverrides, tronNodeOf, validName } from '../lib/wallet/model';
import type { Cmd, HistoryRow, Reply, StatusView } from '../shared/api';
import { balancesOf } from './balances';
import { applyPanelBehavior, initPanelPorts, panelOpen } from './panel';
import { prices } from './prices';
import { buyResource, resourceQuote } from './resources';
import { fetchHistory, pauseOnHello, setPaused } from './serverSync';
import { swapPrepare, swapQuote, swapSign } from './swap';
import { bridgePrepare, bridgeQuote, drainPendingMints, evmPrepare, evmSign, onBridgeMint, refuelPrepare } from './evm';
import {
  drainPendingPays, markSeen, onRequestList, onRequestNew, onRequestPay, onRequestUpdate, openSignWindow, ownPrepare, ownSign,
  pendingCount, pendingRows, prepareRequest, dropForgedPlaintext, opView, rejectRequest, signRequest, updateBadge, historyRows, rejectPaused, markRejectedLocally,
} from './requests';
import { reconcileE2E, e2eUnlocked, unpinE2E, confirmFp, drainInbox, drainOutbox, e2eActive, e2eView, e2eWanted, ensureWalletKeys, expireE2E, reverifyE2E, getServerMode, onE2EEnvelope, onE2EList, onHelloE2E, onJobUpdate, restoreE2E, rotateWalletKey, setManualFp, setServerMode } from './e2e';
import e2eCfg from '../config/e2e.json';
import { registeringView, registrationView, answerNewTypes, connectAgentE2E, connect, createAgent, disconnect, EXT_VERSION, loadSession, onHello, refreshAgents, revokeAgent, rotateAgent, sendState, setAgentAccounts, bindAccountToAgents, setHandlers, socket, syncDoc, updateAgent } from './signer';
import { LEGACY_MCP_NAME } from '../lib/agentConnect';
import { getPublic, getSession, getVaultBlob, patchSession, setPublic } from './store';
import {
  addHdAccount, addSeed, autolockAt, autolockCheck, createFromKey, createFromMnemonic, hideAccount, importKeyAccount, isUnlocked, lock, MAX_AUTOLOCK, MIN_AUTOLOCK,
  previewAccount, removeSeed, changePassword, renameAccount, renameSeed, requireUnlocked, resetWallet, updateVault, seedsInfo, touch, unlock,
} from './wallet';
import { balancesCached, dropBalances } from './balances';
import { bg, installGlobalCatch } from './safe';
import { initI18n } from '../i18n';

installGlobalCatch();
void initI18n(); // notifications and the human copy of errors follow the UI language (Settings → «Language»)
import { notifyPages } from './pages';
import { chainCached, chainRow, refreshChain } from './chainHistory';
import { chainOpView, isChainId, plainTxid, txidsOf } from '../lib/chain/history';

let helloConn = -1;
setHandlers({
  onChange: notifyPages,
  onMessage: async (m) => {
    switch (m.type) {
      case 'hello':
        // 0.3.3: one hello per connection — a second one (e.g. «E2E off» while a forged request waits) is ignored
        if (helloConn === socket.conn) { console.warn('[agent-wallet] a second hello in one connection ignored'); break; }
        helloConn = socket.conn;
        await onHelloE2E(m); await onHello(m); await pauseOnHello(m); bg('history', async () => { if (await fetchHistory(true)) notifyPages(); }); break;
      // E2E: the mailbox and the send jobs
      case 'e2e.list': await onE2EList(m); break;
      case 'e2e.envelope': await onE2EEnvelope(m); break;
      case 'e2e.job.update': await onJobUpdate(m); break;
      case 'request.list': await onRequestList(m); break;
      case 'request.new': await onRequestNew(m); break;
      case 'request.update': await onRequestUpdate(m); break;
      case 'request.pay': await onRequestPay(m); notifyPages(); return; // acked inside
      case 'bridge.mint': await onBridgeMint(m); notifyPages(); return; // acked inside
      default: break;
    }
    socket.ack(m.id, true);
    if (m.type === 'request.list' || m.type === 'hello') bg('mints', drainPendingMints);
    notifyPages();
  },
});

// ---- lifecycle: keepalive + auto-lock alarm, reconnect after a worker restart ----
// Every listener runs through bg(): an error is logged with its place, never an «Uncaught (in promise)»; LOCKED in a
// background task (the wallet is simply locked) is not an error at all.
async function ensureAlarm() {
  // re-create only when missing: create() restarts the period, and on every worker start that could starve the tick
  if (!(await chrome.alarms.get?.('tick'))) await chrome.alarms.create('tick', { periodInMinutes: 0.5 });
}
chrome.runtime.onInstalled.addListener(() => bg('onInstalled', ensureAlarm));
chrome.runtime.onStartup.addListener(() => bg('onStartup', boot));
chrome.alarms.onAlarm.addListener((a) => bg('alarm', async () => {
  if (a.name !== 'tick') return;
  if (await autolockCheck()) { await sendState(); notifyPages(); }
  if (!socket.connected && (await loadSession())) socket.connect();
  await drainPendingMints();
  await expireE2E();
  await reverifyE2E(); // re-check what the Signer said before the unlock
  await drainOutbox();
}));

async function boot() {
  await ensureAlarm();
  await applyPanelBehavior(!!(await getPublic())?.settings.open_in_side_panel);
  await restoreE2E();
  if (await loadSession()) socket.connect();
  await updateBadge();
}
initPanelPorts(notifyPages);
bg('boot', boot);

chrome.windows.onRemoved.addListener((id) => bg('windows.onRemoved', async () => {
  const s = await getSession();
  if (s.signWindowId === id) await patchSession({ signWindowId: undefined });
}));
chrome.notifications.onClicked.addListener((nid) => bg('notification click', async () => {
  // 0.2.1: the end of a bridge / refuel / swap opens its operation page
  if (typeof nid === 'string' && nid.startsWith('op:')) { await openOpWindow(nid.slice(3)); return; }
  await openSignWindow();
}));

// ---- pages → worker ----
async function status(): Promise<StatusView> {
  const pub = await getPublic();
  const s = await getSession();
  const unlocked = !!s.unlocked;
  const v = s.unlocked?.vault;
  // locked: the vault is not readable — the root is the first live HD account 0 (it is created first, never hidden)
  const root = pub && v ? rootAccount(pub.accounts, v.secrets) : pub?.accounts.find((a) => !a.removed_at && a.origin === 'hd' && a.hd_index === 0);
  return {
    initialized: !!(await getVaultBlob()) && !!pub,
    unlocked,
    has_mnemonic: !!(v?.secrets.seeds?.length || v?.secrets.mnemonic),
    seeds: pub && v ? seedsInfo(pub, v) : [],
    accounts: (pub?.accounts ?? []).filter((a) => !a.removed_at).map((a) => ({ id: a.id, name: a.name, origin: a.origin, hd_index: a.hd_index, seed_id: a.origin === 'hd' ? (a.seed_id ?? v?.secrets.seeds?.[0]?.id) : undefined, addresses: a.addresses, root: a.id === root?.id })),
    settings: pub?.settings ?? { ...DEFAULT_SETTINGS },
    signer: { connected: socket.connected, signed_in: !!(await loadSession()), wallet_id: pub?.wallet_id, error: socket.lastError || undefined, session_expires_at: s.signer?.expires_at, server_networks_diff: s.serverNetworksDiff ?? [], registering: registeringView(), ...registrationView() },
    pending: await pendingCount(),
    book: v?.address_book ?? [],
    agents: v ? Object.entries(v.agents).map(([id, a]) => ({ id, name: a.name, accounts: a.accounts, allowed_types: a.allowed_types, created_at: a.created_at, revoked_at: a.revoked_at, token_prefix: a.token_prefix,
      new_types: a.revoked_at ? [] : newTypesOf(a), mcp_name: a.mcp_name ?? LEGACY_MCP_NAME,
      e2e: a.e2e ? { fp: a.e2e.fp, mode: a.e2e.mode, via: a.e2e.via, paired_at: a.e2e.paired_at, confirmed: a.e2e.confirmed } : null,
      pairing: a.pairing ? { expires_at: a.pairing.expires_at, manual: !!a.pairing.manual_fp } : null,
    })) : [],
    doc_version: pub?.doc_version ?? 0,
    extension_id: chrome.runtime.id,
    version: EXT_VERSION,
    autolock_at: await autolockAt(),
    e2e: await e2eView(),
  };
}

/** After any change of the document's content (accounts, book, agents): sign and send a new version. */
async function changed() { await syncDoc().catch((e) => console.warn('wallet.sync', e)); notifyPages(); }

/**
 * Commands a page sends by itself (polling, loading data, keeping a view fresh): they are NOT the human's activity
 * and do not move the auto-lock. The human's activity is `touch` (any input in a page) and every other command.
 */
// 0.3.2: a window the agent made the worker open builds its request (prepare), and open forms re-quote on
// timers (swapQuote, bridgeQuote, resourceQuote) — none of it is the human. Only real input (`touch` from a page's
// pointer / key handler) and commands the human clicks move the auto-lock.
const PASSIVE = new Set<Cmd['cmd']>(['op', 'chainStatus', 'status', 'balances', 'balancesCached', 'prices', 'history', 'requests', 'seen', 'agentsRefresh', 'lock', 'accountPreview',
  'prepare', 'swapQuote', 'bridgeQuote', 'resourceQuote', 'bookCheck', 'openSignWindow']);

async function handle(c: Cmd): Promise<unknown> {
  // an expired session locks at the first command, before anything could extend it (not at the next 30 s tick)
  if (await autolockCheck()) { notifyPages(); bg('after autolock', sendState); }
  if (!PASSIVE.has(c.cmd)) await touch();
  switch (c.cmd) {
    case 'status': return status();
    case 'touch': return { autolock_at: await autolockAt() };
    case 'newMnemonic': return newMnemonic(c.words);
    case 'createWallet': await createFromMnemonic(c.mnemonic, c.password, c.seed_name, c.account_name); notifyPages(); return null;
    case 'importWallet':
      if (c.mnemonic) await createFromMnemonic(c.mnemonic, c.password, c.seed_name, c.account_name);
      else if (c.privateKey) await createFromKey(c.privateKey, c.password, c.account_name);
      else throw new Error('BAD_REQUEST');
      notifyPages(); return null;
    case 'unlock':
      await unlock(c.password);
      notifyPages();
      bg('after unlock', async () => {
        await e2eUnlocked(); await restoreE2E(); // the encrypted E2E history opens with the vault key
        await dropForgedPlaintext(); // what came while locked is checked against the vault now
        await sendState(); await drainPendingPays();
        if (socket.connected && getServerMode() !== 'off' && getServerMode() !== 'unknown' && (await e2eWanted()) && !(await getPublic())?.e2e_key) { await ensureWalletKeys(); await syncDoc().catch(() => {}); }
        if (socket.connected) await syncDocIfBehind();
        await drainPendingMints(); await drainInbox(); await drainOutbox(); notifyPages();
      });
      return null;
    case 'changePassword': await changePassword(c.old_password, c.new_password); notifyPages(); return null;
    case 'lock':
      // at once: the session key and seeds are gone before the reply; the Signer and the other pages are told after
      await lock(); notifyPages();
      bg('after lock', sendState);
      return null;
    case 'resetWallet': if (c.confirm !== 'DELETE') throw new Error('BAD_REQUEST'); await disconnect(); await resetWallet(); notifyPages(); return null;
    case 'addAccount': { const a = await addHdAccount(c.name, c.seed_id); await changed(); return a; }
    case 'accountPreview': return previewAccount({ seed_id: c.seed_id, mnemonic: c.mnemonic, privateKey: c.privateKey });
    case 'seedCreate': { const r = await addSeed(c.mnemonic, c.name, c.account_name); await changed(); return r; }
    case 'seedRename': await renameSeed(c.id, c.name); notifyPages(); return null;
    case 'seedRemove': { const r = await removeSeed(c.id, c.password); await changed(); return r; }
    case 'importKey': { const a = await importKeyAccount(c.privateKey, c.name); await changed(); return a; }
    case 'renameAccount': await renameAccount(c.id, c.name); await changed(); return null;
    case 'hideAccount': await hideAccount(c.id); await changed(); return null;
    case 'balances': return balancesOf(c.id, !!c.force);
    case 'balancesCached': return balancesCached(c.ids);
    case 'bookAdd': {
      if (!validName(c.label, 64)) throw new Error('BAD_LABEL');
      if (c.network !== 'tron' && c.network !== 'evm:*' && !/^evm:\d+$/.test(c.network)) throw new Error('UNSUPPORTED_NETWORK');
      const address = c.network === 'tron' ? normalizeTron(c.address) : c.address.trim();
      if (c.network !== 'tron' && !/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('INVALID_ADDRESS');
      await updateVault((vault) => {
        if (bookMatch(c.network, address, vault.address_book)) throw new Error('ALREADY_IN_BOOK');
        vault.address_book.push({ id: randomId('ab'), label: c.label.trim(), network: c.network, address, ...(c.memo ? { memo: c.memo } : {}), added_at: new Date().toISOString() });
      });
      await changed(); return null;
    }
    case 'bookRemove': { await updateVault((vault) => { vault.address_book = vault.address_book.filter((e) => e.id !== c.id); }); await changed(); return null; }
    case 'bookCheck': {
      const { vault } = await requireUnlocked();
      const address = c.network === 'tron' ? normalizeTron(c.address) : c.address.trim();
      const { pub } = await requireUnlocked();
      const rc = recipientCheck({ network: c.network, address, own: ownEntries(pub.accounts, vault.secrets, c.network), book: vault.address_book, history: vault.recipients, cfg: vault.global.similar, firstTime: false });
      return { address, match: bookMatch(c.network, address, vault.address_book) ?? null, own: rc.own ?? null, similar: rc.similar };
    }
    case 'agentCreate': { if (c.launch !== undefined && !isMcpLaunch(c.launch)) throw new Error('BAD_LAUNCH'); const r = await createAgent(c.name, c.accounts, c.launch); notifyPages(); return r; }
    // ---- E2E ----
    case 'agentConnectE2E': { const r = await connectAgentE2E(c.id, c.launch); notifyPages(); return r; }
    case 'agentManualFp': await setManualFp(c.id, c.fp); notifyPages(); return null;
    case 'agentConfirmFp': await confirmFp(c.id, c.ok); notifyPages(); return null;
    case 'e2eEnable': {
      const pub = await getPublic();
      if (!pub) throw new Error('NO_WALLET');
      if (!c.on && (getServerMode() === 'required' || pub.settings.signer_mode === 'public')) throw new Error('E2E_REQUIRED: the public Signer works only with end-to-end encryption');
      pub.settings = { ...pub.settings, e2e_enabled: !!c.on };
      await setPublic(pub);
      if (!c.on) await unpinE2E(); // the human's explicit choice (a hello never turns it off)
      if (c.on) { await ensureWalletKeys(); }
      await e2eActive();
      if (socket.connected) await syncDoc().catch((e) => console.warn('wallet.sync', e));
      notifyPages(); return e2eView();
    }
    case 'e2eRotateWalletKey': { if (c.confirm !== 'ROTATE') throw new Error('BAD_REQUEST'); const r = await rotateWalletKey(); notifyPages(); return r; }
    case 'signerMode': {
      const pub = await getPublic();
      if (!pub) throw new Error('NO_WALLET');
      const st = pub.settings;
      const prevUrl = st.signer_url;
      if (c.mode === 'public') {
        if (st.signer_mode !== 'public') st.own_signer_url = st.signer_url;
        st.signer_url = new URL(e2eCfg.public_signer_url).origin;
        st.signer_mode = 'public';
        st.e2e_enabled = true;
      } else {
        const u = requireSecureUrl(c.own_url ?? st.own_signer_url ?? DEFAULT_SETTINGS.signer_url, 'Signer');
        st.signer_url = u.origin;
        st.signer_mode = 'own';
      }
      pub.settings = st;
      if (signerChanged(pub.settings.signer_url, prevUrl)) forgetSigner(pub);
      await setPublic(pub);
      await disconnect();
      if (signerChanged(pub.settings.signer_url, prevUrl)) await patchSession({ signerSeenDocVersion: undefined });
      setServerMode('unknown');
      notifyPages(); return null;
    }
    case 'agentRevoke': { const r = await revokeAgent(c.id); notifyPages(); return r; }
    case 'agentRotate': { const r = await rotateAgent(c.id); notifyPages(); return r; }
    case 'agentUpdate': await updateAgent(c.id, c.patch); notifyPages(); return null;
    case 'op': {
      bg('reconcile', async () => { if (await reconcileE2E()) notifyPages(); });
      if (isChainId(c.request_id)) { const r = await chainRow(c.request_id); if (!r) throw new Error('NOT_FOUND'); return chainOpView(r); }
      return opView(c.request_id);
    }
    case 'openOp': await openOpWindow(c.request_id); return null;
    case 'chainStatus': { const x = await chainCached(c.account_id); return { at: x?.at ?? null, errors: x?.errors ?? [], loading: !x }; }
    case 'agentNewTypes': await answerNewTypes(c.id, c.allow); notifyPages(); return null;
    case 'agentSetAccounts': await setAgentAccounts(c.id, c.accounts); notifyPages(); return null;
    case 'agentsBindAccount': { const r = await bindAccountToAgents(c.account_id, c.agent_ids); notifyPages(); return r; }
    case 'agentsRefresh': { const l = await refreshAgents(); notifyPages(); return l; }
    case 'settings': {
      const pub = await getPublic();
      if (!pub) throw new Error('NO_WALLET');
      const p = c.patch;
      if (p.autolock_min !== undefined && (p.autolock_min < MIN_AUTOLOCK || p.autolock_min > MAX_AUTOLOCK)) throw new Error('BAD_AUTOLOCK');
      if (p.mcp_launch !== undefined && !isMcpLaunch(p.mcp_launch)) throw new Error('BAD_LAUNCH');
      if (p.mcp_client !== undefined && !['claude', 'codex', 'json'].includes(p.mcp_client)) throw new Error('BAD_REQUEST');
      if (p.mcp_launch_path !== undefined) p.mcp_launch_path = String(p.mcp_launch_path).slice(0, 512);
      if (p.signer_url !== undefined) p.signer_url = requireSecureUrl(p.signer_url, 'Signer').origin; // https, plain http only to a private network
      // 0.3.0: E2E endpoints — URLs only; the Signer mode and E2E switch have their own commands
      for (const k of ['e2e_tron_node', 'x402_gateway_url'] as const) if (p[k] !== undefined) { if (!String(p[k]).trim()) { p[k] = k === 'e2e_tron_node' ? '' : e2eCfg.x402_gateway_url; continue; } const u = requireSecureUrl(String(p[k]).trim(), k === 'e2e_tron_node' ? 'TRON node' : 'x402 gateway'); p[k] = u.href.replace(/\/+$/, ''); }
      if (p.e2e_rpc !== undefined) { const out: Record<string, string> = {}; for (const [id, url] of Object.entries(p.e2e_rpc ?? {})) { if (!/^\d+$/.test(id) || !String(url ?? '').trim()) continue; const u = requireSecureUrl(String(url).trim(), `RPC ${id}`); out[id] = u.href; } p.e2e_rpc = rpcOverrides(out); } // empty = the built-in RPC
      if (p.e2e_reads !== undefined && !['direct', 'signer'].includes(p.e2e_reads)) throw new Error('BAD_REQUEST');
      delete (p as any).signer_mode; delete (p as any).e2e_enabled; delete (p as any).own_signer_url;
      const urlChanged = p.signer_url !== undefined && p.signer_url !== pub.settings.signer_url;
      delete (p as any).agents_paused; // only through pauseAgents
      // 0.3.9: no built-in TRON node — direct reads (and the debug direct node) need a node of the human's own
      const next = { ...pub.settings, ...p };
      if (!tronNodeOf(next) && ((p.e2e_reads === 'direct') || p.debug_direct_node === true)) throw new Error('NO_TRON_NODE: direct reads need a TRON node of your own (https)');
      pub.settings = normalizeReads(next);
      if (urlChanged) forgetSigner(pub);
      await setPublic(pub);
      if (urlChanged) { await disconnect(); await patchSession({ signerSeenDocVersion: undefined }); }
      if (p.open_in_side_panel !== undefined) await applyPanelBehavior(p.open_in_side_panel);
      notifyPages(); return null;
    }
    case 'connect': await connect(typeof c.invite === 'string' ? c.invite.slice(0, 200) : undefined); notifyPages(); return null;
    case 'disconnect': await disconnect(); notifyPages(); return null;
    case 'tgLink': return (await socket.request('tg.link', {}));
    case 'tgUnlink': return (await socket.request('tg.unlink', {}));
    case 'requests': return pendingRows();
    case 'prepare': return prepareRequest(c.request_id);
    case 'sign': { const r = await signRequest(c.request_id, c.addressChecked, c.build_id); dropBalances(); notifyPages(); return r; }
    case 'reject': await rejectRequest(c.request_id); notifyPages(); return null;
    case 'seen': await markSeen(c.request_id); return null;
    case 'ownPrepare': return ownPrepare(c.account_id, c.asset, c.to, c.amount);
    case 'ownSign': { const r = await ownSign(c.own_id, c.addressChecked, c.build_id); dropBalances(); notifyPages(); return r; }
    case 'openSignWindow': await openSignWindow(); return null;
    case 'prices': return prices();
    case 'resourceQuote': return resourceQuote(c.account_id, c.product, c.amount);
    case 'buyResource': { const r = await buyResource(c.account_id, c.product, c.amount, c.approved_max_usdc); dropBalances(); notifyPages(); return r; }
    case 'swapQuote': return swapQuote(c.asset_in, c.asset_out, c.amount_in, c.slippage_bps);
    case 'swapPrepare': return swapPrepare(c.account_id, c.asset_in, c.asset_out, c.amount_in, c.slippage_bps);
    case 'swapSign': { const r = await swapSign(c.swap_id, c.build_id); dropBalances(); notifyPages(); return r; }
    case 'evmPrepare': return evmPrepare(c.account_id, { network: c.network, asset: c.asset, to: c.to, amount: c.amount });
    case 'bridgeQuote': return bridgeQuote(c.account_id, { asset: 'USDC', from_network: c.from_network, to_network: c.to_network, amount: c.amount, mode: c.mode, delivery: c.delivery });
    case 'bridgePrepare': return bridgePrepare(c.account_id, { asset: 'USDC', from_network: c.from_network, to_network: c.to_network, amount: c.amount, mode: c.mode, delivery: c.delivery });
    case 'refuelPrepare': return refuelPrepare(c.account_id, c.to_network, c.amount_eth);
    case 'evmSign': { const r = await evmSign(c.key, c.addressChecked, c.build_id); dropBalances(); notifyPages(); return r; }
    case 'history': {
      // the UI never waits for the network when it has something to show: local rows now, the server's in the background
      let rows = await historyRows(c.account_id);
      if (rows.length) bg('history', async () => { if (await fetchHistory()) notifyPages(); });
      else { await fetchHistory().catch((e) => console.warn('history', e)); rows = await historyRows(c.account_id); }
      // 0.3.12: of one account — its token movements on the chain too (what the wallet did not start), never twice
      if (!c.account_id) return rows;
      const accId = c.account_id;
      bg('chain history', async () => { if (await refreshChain(accId)) notifyPages(); });
      bg('reconcile', async () => { if (await reconcileE2E()) notifyPages(); });
      return withChainRows(rows, accId);
    }
    case 'pauseAgents': {
      // the Signer pauses and refuses what waits (wallet.pause); without it — the local fallback refuses here
      const r = await setPaused(!!c.paused);
      if (c.paused && !r.server && socket.connected) for (const x of await pendingRows()) await rejectPaused(x.request_id).catch((e) => console.warn('pause', e));
      if (c.paused && r.server) for (const x of await pendingRows()) await markRejectedLocally(x.request_id, 'paused');
      notifyPages(); return { ...r, panel_open: panelOpen() };
    }
  }
}

/** Local rows + chain rows of the account (without those whose txid a local operation already carries), newest first. */
async function withChainRows(rows: HistoryRow[], accountId: string): Promise<HistoryRow[]> {
  const ch = await chainCached(accountId);
  if (!ch?.rows.length) return rows;
  const s = await getSession();
  const mine = new Set<string>();
  for (const e of Object.values(s.requests ?? {})) txidsOf(e.request, mine);
  const pub = await getPublic();
  const acc = pub?.accounts.find((a) => a.id === accountId);
  const extra: HistoryRow[] = ch.rows.filter((r) => !mine.has(plainTxid(r.txid))).map((r) => ({
    request_id: r.id, account: { id: accountId, name: acc?.name ?? '' }, type: 'transfer', network: r.network,
    intent: { asset: r.asset, amount: r.amount, ...(r.dir === 'in' ? { from: r.from } : { to: r.to }) }, status: 'confirmed', at: r.at, own: false, by: 'server',
    chain: { dir: r.dir, counterparty: r.dir === 'in' ? r.from : r.to, txid: r.txid, block: r.block, estimated: !!r.at_estimated },
  }));
  return [...rows, ...extra].sort((a, b) => b.at - a.at);
}

/** The operation page in its own window (a notification, the sign window while more requests wait). */
async function openOpWindow(id: string): Promise<void> {
  await chrome.windows.create({ url: chrome.runtime.getURL(`popup.html#/op/${encodeURIComponent(id)}`), type: 'popup', width: 400, height: 640, focused: true });
}

/** another Signer is another wallet there — its id and document versions are not carried over. */
const signerChanged = (a: string, b: string) => { try { return new URL(a).origin !== new URL(b).origin; } catch { return a !== b; } };
function forgetSigner(pub: NonNullable<Awaited<ReturnType<typeof getPublic>>>): void {
  delete pub.wallet_id; pub.doc_version = 0; delete pub.doc_digest;
}

async function syncDocIfBehind() {
  const pub = await getPublic();
  const s = await getSession();
  if ((s.signerSeenDocVersion ?? 0) < (pub?.doc_version ?? 0) || !pub?.doc_version) await syncDoc().catch(() => {});
}

chrome.runtime.onMessage.addListener((msg: Cmd, sender, reply: (r: Reply) => void) => {
  if (sender.id !== chrome.runtime.id || !msg || typeof (msg as any).cmd !== 'string') return false;
  const send = (r: Reply) => { try { reply(r); } catch { /* the page closed */ } };
  handle(msg).then((result) => send({ ok: true, result }), (e) => {
    const error = (e as Error)?.message ?? String(e);
    if (!/^LOCKED/.test(error)) console.warn('cmd', msg.cmd, error);
    send({ ok: false, error });
  });
  return true;
});

