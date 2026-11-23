# Contributing

English | [简体中文](CONTRIBUTING.zh-CN.md)

Bug reports, compatibility reports, documentation improvements, tests, and code contributions are welcome.

## Before opening an issue or pull request

- Search existing issues first.
- Discuss large protocol or security-boundary changes before starting implementation.
- Reproduce problems with synthetic or redacted data. Never include a real task transcript, rollout file, credential, private path, key, or public endpoint.
- For compatibility reports, include the operating system, Codex Desktop version, bundled CLI version, browser, and connection mode.

## Development workflow

1. Use Node.js 22 or later and install dependencies with `npm install`.
2. Make one focused change on a topic branch.
3. Add or update coverage for protocol changes and browser-visible behavior.
4. Check the interface at a narrow mobile width when changing the UI.
5. Keep the English and Simplified Chinese READMEs aligned.
6. Run the required checks before opening a pull request.

## Development rules

- Never commit Codex binaries, credentials, rollout files, task transcripts, private paths, public IPs, SSH keys, or proxy secrets.
- Keep the bridge bound to loopback by default.
- Keep Codex Desktop as the only task writer in Desktop-control mode.
- Treat App Server payloads as untrusted and expose only sanitized fields.
- Do not silently enable the legacy RPC multiplexer as a fallback.
- Preserve compatibility with Node.js 22 or later.

## Required checks

    npm run check
    npm test
    npm run release:check

Protocol changes should document the tested Codex version and use a redacted fixture instead of a real task transcript.
