# Deployment

Start with [minimum deployment requirements](minimum-requirements.md). The
smallest phone setup is a trusted LAN; this document covers safer remote access.

## Recommended boundary

Keep both the bridge and App Server on loopback. For phone access, prefer a
private overlay network that provides HTTPS. A conventional reverse proxy is
also possible, but makes authentication, patching, and rate limiting your
responsibility.

## Reverse proxy

The bridge must know the public cookie path:

```shell
export CODEX_MOBILE_SECURE_COOKIE=1
export CODEX_MOBILE_COOKIE_PATH=/codex-mobile/
```

Use `examples/nginx.conf` inside an HTTPS server block. The proxy upload limit
is intentionally slightly larger than the bridge's 25 MiB per-file limit.

## State directory

Back up only if desired:

- `seen-threads.json`
- `thread-list-cache.json`

Treat as sensitive and do not back up publicly:

- `secret.txt`
- `uploads/`
- logs or diagnostics containing task metadata

## Updates

Run unit and release checks before updating. App Server protocol changes may be
breaking even when the bridge source did not change.
