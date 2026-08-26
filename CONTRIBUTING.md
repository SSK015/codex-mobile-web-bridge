# Contributing

Contributions are welcome after the initial public release.

## Development rules

- Never commit Codex binaries, credentials, rollout files, task transcripts,
  local paths, public IPs, SSH keys, or reverse-proxy secrets.
- Keep the server bound to loopback by default.
- Treat App Server payloads as untrusted and expose only sanitized fields.
- Add tests for protocol-shape changes and browser-visible rendering changes.
- Preserve compatibility with Node.js 22 or later on Windows, macOS, and Linux.

## Checks

```shell
npm run check
npm test
npm run release:check
```

Protocol changes should document the tested Codex version and include a
redacted fixture rather than a real task transcript.
