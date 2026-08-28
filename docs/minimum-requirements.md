# Minimum deployment requirements

There are three distinct deployment levels. A VPS, domain name, reverse tunnel,
and modified Codex Desktop are **not** required for the basic bridge.

## Level 0: minimum compatibility fallback

Minimum requirements:

- Windows, macOS, or Linux computer
- Node.js 22 or later
- Codex installed and authenticated for that operating-system user
- A Codex version that provides `codex app-server --stdio`
- One free local TCP port, `4780` by default
- A modern JavaScript browser

Start the bridge and open `http://127.0.0.1:4780` on the same computer. No API
separate OpenAI API key, database, VPS, domain, or TLS certificate is needed.
Run `npm install` once to install the `ws` WebSocket package. The bridge uses the
user's existing Codex authentication.

This private-stdio setup proves that the bridge can run, but it starts a second
independent Codex client. It is not the intended default experience when Codex
Desktop is also in use.

Windows is the currently tested host platform. macOS and Linux launch scripts
are included, but should be treated as community-tested until CI and real-device
coverage are added.

## Level 1: use a phone on the same trusted Wi-Fi

Additional requirements:

- The phone can reach the computer's LAN IP
- The computer firewall allows the selected bridge port
- The bridge binds to the LAN interface

Windows PowerShell example:

```powershell
$env:CODEX_MOBILE_HOST = '0.0.0.0'
.\scripts\start.ps1
```

macOS or Linux example:

```shell
CODEX_MOBILE_HOST=0.0.0.0 ./scripts/start.sh
```

Open `http://<computer-lan-ip>:4780` on the phone and use the generated bridge
password.

This is the smallest phone deployment, but plain HTTP exposes the bridge
password and task traffic to the local network. Use it only on a trusted private
LAN, never on public Wi-Fi, and do not forward the port from the router.

## Level 2: use the phone away from home

Additional requirement: one authenticated HTTPS route from the phone to the
loopback bridge. This can be provided by either:

- a private overlay network with HTTPS; or
- an HTTPS reverse proxy plus a private/reverse tunnel.

The bridge should remain bound to `127.0.0.1`. Set secure cookie options for a
path-based public URL:

```shell
CODEX_MOBILE_SECURE_COOKIE=1
CODEX_MOBILE_COOKIE_PATH=/codex-mobile/
```

A VPS and public domain are one possible implementation, not a project
requirement. The project does not provide or operate a relay service.

## Recommended default: desktop and phone share one App Server connection

This is required for the complete experience demonstrated by this project.
Private stdio remains available only as a portable fallback.

Single-connection shared mode additionally requires:

- a Codex App Server listening on a loopback WebSocket; and
- a second loopback port for the RPC multiplexer; and
- Codex Desktop configured to use the multiplexer rather than the upstream App
  Server directly.

Set both bridge variables, for example:

```shell
CODEX_MOBILE_APP_SERVER_URL=ws://127.0.0.1:4512 \
CODEX_MOBILE_RPC_MUX_LISTEN_URL=ws://127.0.0.1:4513 \
node server.mjs
```

Desktop must connect to `ws://127.0.0.1:4513`. Pointing Desktop and the bridge
at `4512` as two independent WebSocket clients does not share writer ownership.

Shared desktop/mobile operation is experimental and version-dependent. The
repository does not patch or redistribute Codex Desktop.

Without shared mode, the phone cannot reliably observe, steer, interrupt, or
answer requests for a turn owned by the desktop's separate App Server. Both
clients can also compete for the same task's persisted state.

## Resource footprint

- One runtime npm dependency: `ws`
- Source package is currently under 100 KiB compressed
- Persistent metadata is small; uploaded attachments use their actual size
- Individual uploads are limited to 25 MiB
- The computer and Codex App Server must remain running while the phone is used
