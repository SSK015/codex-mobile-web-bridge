# Security policy

## Supported versions

Until the first stable release, only the latest commit is supported.

## Reporting a vulnerability

Do not open a public issue containing credentials, local paths, task content,
or remote-access details. Use the repository's private security advisory flow.

## Deployment boundary

The bridge has access to local Codex tasks and explicitly referenced local
files. It must not be exposed directly to the internet.

- Bind to `127.0.0.1`.
- Enable a strong bridge password.
- Put remote access behind HTTPS and an authenticated private network or a
  carefully configured reverse proxy.
- Never cache API, task, image, artifact, or upload responses in a service
  worker or shared proxy.
- Keep App Server WebSocket listeners on loopback.
- Rotate the bridge password after suspected exposure.

Opaque file tokens are authenticated, expire, and are bound to file identity,
but they are not a substitute for transport authentication.
