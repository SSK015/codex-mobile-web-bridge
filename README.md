# Codex Mobile Web Bridge

An unofficial mobile web client for a Codex App Server running on your own
computer.

Use a phone browser to open local Codex tasks, steer running turns, inspect
sanitized tool activity, answer approvals, upload files, and preview generated
artifacts without streaming the desktop.

> [!WARNING]
> This project uses experimental Codex App Server messages. It is not an
> official OpenAI product, and a Codex update may require compatibility fixes.

## What works

- Fast task list with running, unread-complete, and empty states
- Recent-history-first rendering and paginated older turns
- Streaming replies and collapsed live tool previews
- Steering and interruption of active turns
- Command, file-change, permission, user-input, and MCP request handling
- Authenticated image viewing and local artifact preview/download
- Phone file upload and clipboard-image upload with progress and deduplication
- Browser Back/edge-swipe navigation
- Loopback-only default binding and password authentication

## Requirements

- Node.js 22 or later
- Codex installed and authenticated for the current operating-system user
- A Codex version that provides `codex app-server --stdio`
- One free local port (`4780` by default) and a modern browser

This repository does **not** include Codex binaries or credentials.

That is enough to run the bridge locally. It does **not** require a separate
OpenAI API key beyond the user's existing Codex authentication, database, VPS,
domain name, TLS certificate, modified Codex Desktop, or public
relay service.

For phone access, choose one level:

| Use case | Additional minimum |
|---|---|
| Same trusted Wi-Fi | Bind to the LAN interface and allow the port in the computer firewall |
| Access from anywhere | Provide one authenticated HTTPS route to the loopback bridge |
| Full desktop/mobile experience | One App Server connection shared through the loopback RPC multiplexer; this is the recommended default |

See [minimum deployment requirements](docs/minimum-requirements.md) for exact
commands, security boundaries, and what remains experimental.

## Quick start

### Windows

```powershell
git clone https://github.com/SSK015/codex-mobile-web-bridge.git
cd codex-mobile-web-bridge
npm install
.\scripts\start.ps1
```

### macOS or Linux

```shell
git clone https://github.com/SSK015/codex-mobile-web-bridge.git
cd codex-mobile-web-bridge
npm install
chmod +x scripts/start.sh
./scripts/start.sh
```

Open `http://127.0.0.1:4780`. The first start creates a random bridge password
inside the private state directory printed by the script.

The only runtime package is the widely used `ws` WebSocket implementation. It
provides the loopback WebSocket endpoint used by single-connection shared mode.

## Deploy with another coding agent

An agent can deploy this project, but it must treat the Codex process and task
history as user-owned state. Give the agent this instruction:

> Deploy this repository by following `docs/agent-deployment.md`. Prefer one
> single-connection shared mode through the loopback RPC multiplexer when the
> installed Codex version supports it. Do
> not copy, replace, patch, stop, or redistribute Codex binaries, and do not
> interrupt existing Codex tasks. Keep the bridge and App Server on loopback,
> create a fresh private state directory and password, run all checks, and
> report the exact access URL, connection mode, persistence method, and
> verification results. Do not expose the bridge directly to the public
> internet. If shared mode cannot be verified, stop and explain the limitation
> before using private stdio fallback.

The complete [agent deployment runbook](docs/agent-deployment.md) defines
preflight checks, safe startup order, remote-access boundaries, acceptance
tests, and the required handoff report. It intentionally forbids an agent from
silently killing a running Desktop/App Server or claiming that private stdio is
the full shared experience.

## Connection modes

### Single-connection shared mode - intended default experience

Codex currently associates a task's active writer with the client transport
connection. Merely opening two WebSockets to one App Server is therefore not
enough. The bridge includes an RPC multiplexer: a loopback proxy that gives
Desktop and the mobile bridge one shared upstream connection while routing
their request IDs, responses, notifications, and approval requests separately.

Start the bridge with both the private upstream App Server and the Desktop-facing
multiplexer endpoint:

```shell
CODEX_MOBILE_APP_SERVER_URL=ws://127.0.0.1:4512 \
CODEX_MOBILE_RPC_MUX_LISTEN_URL=ws://127.0.0.1:4513 \
node server.mjs
```

Configure Codex Desktop to connect to `ws://127.0.0.1:4513`, never directly to
the upstream `4512` endpoint. The multiplexer must start before Desktop so that
Desktop performs the one allowed App Server initialization through it. Desktop
integration remains version-dependent, so perform the switch only while tasks
are idle and keep a rollback path.

See [shared mode](docs/shared-mode.md) and [architecture](docs/architecture.md).

### Private stdio - compatibility fallback

Without `CODEX_MOBILE_APP_SERVER_URL`, the bridge starts
`codex app-server --stdio`. This is the smallest portable smoke-test mode, but
it is a second independent Codex client rather than remote control of the
desktop's live client. Same-task writes may conflict, desktop-started turns
cannot be steered reliably, and live events may appear only after persistence.

## Phone access

Do not bind this server directly to a public interface. Keep it on loopback and
use either:

1. a private overlay network with HTTPS; or
2. an HTTPS reverse proxy with authentication and rate limiting.

For a path-based reverse proxy, set:

```shell
CODEX_MOBILE_SECURE_COOKIE=1
CODEX_MOBILE_COOKIE_PATH=/codex-mobile/
```

See [deployment guidance](docs/deployment.md), the
[Nginx example](examples/nginx.conf), and [security policy](SECURITY.md).

A VPS and domain are optional implementation choices, not minimum requirements.

## Configuration

All configuration uses environment variables. See [.env.example](.env.example).
Important settings include:

| Variable | Purpose |
|---|---|
| `CODEX_MOBILE_CODEX_PATH` | Installed Codex executable |
| `CODEX_MOBILE_APP_SERVER_URL` | Existing loopback App Server WebSocket |
| `CODEX_MOBILE_RPC_MUX_LISTEN_URL` | Loopback endpoint used by Desktop in single-connection shared mode |
| `CODEX_MOBILE_SECRET_FILE` | Bridge password file |
| `CODEX_MOBILE_HOST` | Bind host; defaults to `127.0.0.1` |
| `CODEX_MOBILE_PORT` | Bind port; defaults to `4780` |
| `CODEX_MOBILE_COOKIE_PATH` | Cookie scope behind a path proxy |
| `CODEX_MOBILE_SECURE_COOKIE` | Set to `1` behind HTTPS |
| `CODEX_MOBILE_UPLOAD_ROOT` | Private local upload directory |

## Privacy model

- Task data stays between the browser, bridge, and local Codex environment.
- The initial task response omits raw tool schemas and large tool output.
- Local file URLs are expiring authenticated tokens bound to file identity.
- Service workers are not currently used, so task content is not offline-cached.
- Uploads stay in the configured local state directory.

## Development

```shell
npm run check
npm test
npm run release:check
```

The release check fails on tracked binaries, large files, private keys, common
personal path patterns, public deployment hostnames, and real-looking task IDs.

## Compatibility

The bridge has no stable-protocol guarantee because App Server messages are
experimental. When reporting a compatibility issue, include the Codex version,
operating system, transport mode, and a redacted message shape. Never include a
real task transcript or credential.

Private stdio should not be described as the normal user experience.
Single-connection shared mode is the product path; private stdio remains a
diagnostic and compatibility fallback.

## Project status and license

The project is preparing its first public release and is licensed under the
Apache License 2.0.

See [LICENSE](LICENSE), [NOTICE](NOTICE.md), and
[CONTRIBUTING](CONTRIBUTING.md).
