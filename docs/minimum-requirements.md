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

## Recommended default: Desktop remains the sole writer

The verified Windows deployment uses Codex Desktop's native `codex_app` tools
pipe. Start Codex Desktop normally, then launch the bridge with:

```powershell
$env:CODEX_MOBILE_DESKTOP_CONTROL = '1'
.\scripts\start.ps1
```

The Windows start script selects Desktop-control mode by default when no legacy
App Server URL is configured. The bridge discovers a valid local task context
from the user's Codex session index and discovers the native tools pipe owned by
the packaged Desktop process.

This mode requires:

- Windows with the verified or compatibility-tested Codex Desktop build;
- Codex Desktop running and authenticated for the same OS user;
- at least one existing local Codex task to provide control-call context; and
- the native `codex_app` catalog containing `list_threads`, `read_thread`, and
  `send_message_to_thread`.

Desktop control currently supports live task reads, running-turn append, soft
stop messages, project discovery, task creation, model selection, uploads, and
artifact preview. It does not expose hard `turn/interrupt` or Desktop approval
responses.

The legacy RPC multiplexer is not a fallback. Current Desktop builds can reject
or destabilize shared-writer cutovers. See the architecture document and update
checklist before testing another Codex version.

## Resource footprint

- One runtime npm dependency: `ws`
- Source package is currently under 100 KiB compressed
- Persistent metadata is small; uploaded attachments use their actual size
- Individual uploads are limited to 25 MiB
- The computer and Codex App Server must remain running while the phone is used
