# Changelog

All notable changes to the Don't Ask Again Chrome extension. Versions before the first public release were
distributed as early-access zip archives.

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
