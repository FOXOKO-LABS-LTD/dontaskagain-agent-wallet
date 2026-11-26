# Changelog

All notable changes to the Don't Ask Again Chrome extension. Versions before the first public release were
distributed as early-access zip archives.

## 0.3.14 — 2026-11-26
- **A fixed extension id.** The manifest carries the extension's public key (`key`), so the zip, a build from source
  and the future Chrome Web Store item all have the same id: `lfjhjcdnafhiageojbcodejdhlohelea`. The Signer's sign-in
  page for chat apps opens the consent window of exactly this extension.
- Upgrading from 0.3.13 or older: Chrome treats 0.3.14 as a new extension with its own empty storage. Before removing
  the old one, make sure you have every recovery phrase (and imported key) written down; import them in 0.3.14, connect
  to the Signer again and reconnect your agents.

## 0.3.13 — 2026-11-26
- **Connect a chat app.** Claude, ChatGPT or any MCP client with a remote server can connect to the wallet with an
  OAuth sign-in on the Signer. The sign-in page shows a one-time code; the extension opens its consent window by itself
  when the page is a page of your own Signer (or you type the code in Agents → «Connect a chat app»). The window reads
  who asks from the Signer: the app's name (marked «not verified»), the exact address the sign-in returns to (a warning
  for addresses on this computer), the access asked for. You pick the accounts and the operation types and name the
  agent; «Allow» and «Deny» are signed by your wallet.
- **Cloud agents.** The agent of a chat app cannot keep a key: the Signer holds its key and sees its requests. Such an
  agent is marked «cloud» everywhere it appears — the agents list, its settings, the sign window, the operation page
  and history. It has no token or commands; revoking it ends the chat app's access. Every transaction is still signed
  by you in the window that shows it.

## 0.3.12 — 2026-11-25
- **History of an account in E2E.** Your own operations (transfers, swaps, bridges, refuels, resources) come from the
  wallet's encrypted local history with their steps and transactions — kept up to 90 days (at most 300 finished
  operations, 1 MB) and back after a browser restart at unlock. Token transfers of the EVM address that did not go
  through this wallet (incoming payments, transfers made elsewhere) are read from the networks: ERC-20 `Transfer` logs
  of your own address over about a day, each with its own page and explorer link. A TRON node keeps no history by
  address, so incoming TRON transfers are not read; the History tab links to the explorer pages of the account.
- **The operation page after signing.** The sign window, the popup and the side panel open the operation's page with
  its steps (resources, approve, swap, burn / mint, sending, confirmation), transactions and explorer links; the
  steps update live. A finished operation is a notification that opens its page.
- Statuses follow the chain: a request stuck at «sent» (a bridge at «minting») closes as confirmed when its
  transaction is in a block; a «not seen in time» failure of a transaction that succeeded is corrected; a confirmation
  read that fails never turns a request into a failure.
- Direct EVM reads ask the next RPC of the network when one fails or refuses (official keyless public RPCs as
  fallbacks).
- Swap: the reference rate reads «1 TRX ≈ X USDT (reference, source …)».
- Texts for agents are English, whatever the language of the wallet.

## 0.3.11 — 2026-11-25
- `dontaskagain-mcp` is on npm: the wizard runs `npx -y dontaskagain-mcp@0.1.4` for Claude Code, Codex and JSON.
  The path or URL field still overrides it (for example the same version's archive from the website).

## 0.3.10 — 2026-11-25
- Agents connect only with a key of their own: `dontaskagain-mcp` through npx (recommended) or the Signer's remote
  MCP endpoint, for Claude Code, Codex or any MCP client (JSON). Both need end-to-end encryption with the Signer;
  the wizard says so when it is off. An agent left without a key by an older version is asked to get one on its page.
- The wizard runs `dontaskagain-mcp` 0.1.4.
- Source comments no longer point to documents that are not in this repository.

## 0.3.9 — 2026-11-25
- **No built-in TRON node.** Network reads go through the Signer by default. Direct reads (past the Signer) need a
  TRON node of your own: https, plain http only to localhost or a private network. Settings of older versions that
  pointed at the former built-in node are reset to «Read everything through the Signer»; a node you set yourself is
  kept. The debug option «read TRON directly» also uses only your own node.

## 0.3.8 — 2026-11-25
- Agent connect wizard: ready-made setup for Claude Code, OpenAI Codex (command and `~/.codex/config.toml`) or any
  MCP client (JSON). Until `dontaskagain-mcp` is on npm the wizard runs the package archive from the website.

## 0.3.7 — 2026-11-24
- UI polish: toolbar icons, select chevrons, settings gear, narrow side-panel fixes.

## 0.3.6 — 2026-11-24
- New UI kit: design tokens, dark theme (system / light / dark), Manrope and JetBrains Mono fonts, icons, mascot,
  logo, full-address component.

## 0.3.5 — 2026-11-23
- **No auto-sign.** The wallet never signs on the human's behalf: every transaction waits for the human's signature
  in a window that shows it. Auto-sign settings of older versions are dropped from the vault.

## 0.3.4 — 2026-11-23
- Public Signer `https://signer.dontaskagain.xyz` with invite-only registration (invite code or link in Settings).

## 0.3.3 — 2026-11-20
- Security hardening after an external audit: one queue for all vault changes, one signed transaction per request,
  no plaintext path around end-to-end encryption, bounded storage and bounded trust in the Signer, the E2E executor
  survives a worker or browser restart.
- Proof of work at wallet registration on a Signer.
- Wizard support for `dontaskagain-mcp` 0.1.1 (npx).

## 0.3.2 — 2026-11-20
- Security hardening: the extension verifies everything the Signer sends, signs exactly the build the human saw,
  money ceilings of its own, https-only endpoints (http only to localhost / private networks), auto-lock fixes.

## 0.3.0 – 0.3.1 — 2026-11-19
- End-to-end encryption with the public Signer: the Signer is a mailbox and cannot read or forge requests.
  Wallet key fingerprint, key rotation, pairing of agent keys.
- x402 payments for TRON resources in E2E mode; direct reads from a TRON node and EVM RPC, each overridable.

## 0.2.0 – 0.2.6 — 2026-11-19
- EVM networks (Ethereum, Base, Arbitrum, Optimism, Polygon): balances and transfers; USDC bridge on Circle CCTP v2
  (approve and burn in one signature, mint by the wallet or by Circle Forwarding); gas refuel from Ethereum to L2s
  through the canonical bridges.
- Interface in English and Russian.
- Agents managed in the wallet: name, accounts, allowed operation types, token re-issue, revoke.
- Operation pages: status, timeline of steps, transactions with explorer links.
- Own accounts as trusted recipients; address book with search.
- Coin prices and logos; activation of new TRX recipients; refund display.

## 0.1.7 – 0.1.9 — 2026-11-18
- Several recovery phrases with names, accounts screen, import with a name; auto-lock.
- Swap TRX ↔ USDT through the sun.io router with automatic TRON resources (energy / bandwidth via x402).

## Earlier
- 0.1.0 – 0.1.6: TRON accounts from a recovery phrase or a private key, encrypted vault, sign window for agent
  requests relayed by a Signer, address book and look-alike address warnings, pause of all agents, side panel,
  TRON resources (energy / bandwidth) bought automatically for transfers.
