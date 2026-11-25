# Don't Ask Again — Agent Wallet (Chrome extension)

**The agent asks — the human signs every transaction. Keys never leave the browser.**

Don't Ask Again is a Chrome extension wallet for people and their AI agents. An agent (Claude Code, OpenAI Codex,
any MCP client) sends an *intent* — a transfer, a swap, a USDC bridge, a gas refuel — and the human
sees the parsed transaction in the extension and signs it, or rejects it.

- **The wallet never signs on its own.** No auto-sign, no spending limits that sign for you, no batch signing.
  The only steps that follow without a new window belong to an operation the human has just signed, and that window
  lists them in advance (the x402 payment for TRON resources up to the shown cap, the bridge mint to the wallet's own
  address).
- **Keys stay in the browser.** Recovery phrases and private keys are encrypted with the human's password inside the
  extension. The Signer server that relays agent requests holds no keys.
- **End-to-end encryption.** With the public Signer, agent requests and wallet answers are signed and encrypted
  end to end ([`dontaskagain-mcp`](https://github.com/FOXOKO-LABS-LTD/dontaskagain-mcp) on the agent side); the Signer
  operator sees who talks to whom and when, but not amounts, recipients or reasons, and cannot forge a request.

Website: https://dontaskagain.xyz · For agents: [llms.txt](https://dontaskagain.xyz/llms.txt),
[SKILL.md](https://dontaskagain.xyz/SKILL.md), [llms-full.txt](https://dontaskagain.xyz/llms-full.txt)

## What it does

- **TRON**: TRX and USDT; energy, bandwidth and account activation are bought automatically through an x402 gateway
  (USDC on Base) instead of burning TRX; swap TRX ↔ USDT through the sun.io router.
- **EVM**: Ethereum, Base, Arbitrum, Optimism, Polygon — balances and transfers; USDC bridge on Circle CCTP v2; gas
  refuel from Ethereum to L2s through the canonical bridges.
- **Agents**: each agent gets its own token, the accounts it may use and the operation types it may ask for; tokens
  can be re-issued or revoked at any time; pause all agents with one switch.
- **Safety in the sign window**: the transaction is decoded from the very bytes being signed; address-book and
  look-alike address checks, "the same transfer N minutes ago" warning, a sign button that wakes up after a moment.
- Several recovery phrases and imported keys, side panel, operation pages, prices in USD, English and Russian UI.

Status: early access. The extension is distributed as a zip archive ("Load unpacked"); a Chrome Web Store listing is
planned.

## Install

### From the release archive

1. Download the extension zip from https://dontaskagain.xyz/dl/ (current files and sha256:
   https://dontaskagain.xyz/dl/latest.json) and check the sha256.
2. Unzip it into a folder you keep.
3. Open `chrome://extensions`, switch on **Developer mode**, click **Load unpacked** and pick that folder
   (Chrome 116 or newer).
4. Create or import a recovery phrase and set a password.
5. To use the public Signer, request an invitation at https://dontaskagain.xyz/#access and paste the invitation link
   in **Settings → Signer**. A Signer at another address can be set there too (**Own Signer**).

### From source

```bash
git clone https://github.com/FOXOKO-LABS-LTD/dontaskagain-agent-wallet.git
cd dontaskagain-agent-wallet
npm ci
npm test
npm run build        # typecheck + vite build + dist check → dist/
```

Then **Load unpacked** the `dist/` folder. Node.js 20.19+ (CI uses the current LTS).

## Connect an agent

In the extension: **Agents → Connect agent** — name, accounts, allowed operation types, then the MCP client
(Claude Code, Codex or other) and the way to connect ("npx on the agent's machine" is recommended: the agent key lives
on the agent's machine and requests are end-to-end encrypted). The wizard gives a connection file
`dontaskagain-<name>.env` (mode 600; it holds the Signer address, the agent token, the wallet key and a one-time
pairing code) and the exact commands. Keep the token and the pairing code out of chats and command lines.

The agent side is the [`dontaskagain-mcp`](https://www.npmjs.com/package/dontaskagain-mcp) package from npm
(source: [FOXOKO-LABS-LTD/dontaskagain-mcp](https://github.com/FOXOKO-LABS-LTD/dontaskagain-mcp)), pinned to the
version the wizard was tested with:

```
npx -y dontaskagain-mcp@0.1.4
```

Without access to the npm registry, the same version runs from the website archive — put its path or URL in the
wizard's field: `npx -y -p https://dontaskagain.xyz/dl/dontaskagain-mcp-0.1.4.tgz dontaskagain-mcp`.

**Claude Code**

```bash
mkdir -p -m 700 ~/.dontaskagain
mv ~/Downloads/dontaskagain-<name>.env ~/.dontaskagain/ && chmod 600 ~/.dontaskagain/dontaskagain-<name>.env
claude mcp add -s user dontaskagain-<name> -e DAA_CONFIG=~/.dontaskagain/dontaskagain-<name>.env -- npx -y dontaskagain-mcp@0.1.4
DAA_CONFIG=~/.dontaskagain/dontaskagain-<name>.env npx -y dontaskagain-mcp@0.1.4 whoami
```

**OpenAI Codex** (CLI and IDE extension share `~/.codex/config.toml`) — the same two file lines, then:

```toml
[mcp_servers.dontaskagain-<name>]
command = "npx"
args = ["-y", "dontaskagain-mcp@0.1.4"]
env = { DAA_CONFIG = "~/.dontaskagain/dontaskagain-<name>.env" }
startup_timeout_sec = 60
tool_timeout_sec = 330
```

(`tool_timeout_sec` matters: `wallet_request_status` may wait up to 300 s for the human.)

**Any MCP client (stdio, JSON)**

```json
{
  "mcpServers": {
    "dontaskagain-<name>": {
      "command": "npx",
      "args": ["-y", "dontaskagain-mcp@0.1.4"],
      "env": { "DAA_CONFIG": "~/.dontaskagain/dontaskagain-<name>.env" }
    }
  }
}
```

Finally the human compares the agent key fingerprint printed by `whoami` (`agent_fp`) with the one shown in the
wizard. Then the agent calls `wallet_status`. See [SKILL.md](https://dontaskagain.xyz/SKILL.md) for the tools,
statuses and what the agent should tell the human.

## Development

| Command | What |
|---|---|
| `npm run typecheck` | TypeScript check |
| `npm test` | unit and flow tests (vitest) against an in-process mock Signer; no network |
| `npm run build` | production build into `dist/` |
| `npm run dev` | rebuild on change |

Optional live tests (read-only, never broadcast): `AW_LIVE_NODE=1 AW_LIVE_NODE_URL=<TRON node>` (a TRON full node of your own),
`AW_LIVE_EVM=1` (public EVM RPC).

Layout: `src/background` — service worker (vault, Signer connection, request handling, E2E);
`src/lib` — pure libraries (TRON/EVM transaction builders and verifiers, crypto, swap, x402); `src/ui` — popup,
side panel and sign window (React); `src/config` — built-in networks, tokens, contracts and endpoints;
`test` — tests and fixtures; `scripts/preview` — UI preview with mock data.

## Security

Please report vulnerabilities privately — see [SECURITY.md](SECURITY.md).

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE). Copyright 2026 FOXOKO LABS LTD.
