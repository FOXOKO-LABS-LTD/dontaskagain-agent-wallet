# Contributing

Thanks for your interest. Issues and pull requests are welcome.

- **Security problems**: see [SECURITY.md](SECURITY.md) — never in a public issue.
- **Bugs**: open an issue with the extension version, Chrome version, the network and what you expected. Never paste
  a recovery phrase, private key, agent token or pairing code.
- **Pull requests**: keep them small and focused, add or update tests, and make sure these pass:

  ```bash
  npm ci
  npm run typecheck
  npm test
  npm run build
  ```

- The one rule that is not up for discussion: the wallet never signs on its own. Every transaction is shown to the
  human and signed by the human; changes that add auto-signing, batch signing or remote key access will not be
  merged.
- By contributing you agree that your contribution is licensed under the Apache License 2.0 (see [LICENSE](LICENSE)).
