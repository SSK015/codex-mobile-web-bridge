# Codex Mobile Web Bridge

An unofficial mobile web client for Codex Desktop running on your own computer.

```text
phone browser
    | HTTPS
    v
Codex Mobile bridge (loopback)
    | approved codex_app tools
    v
Codex Desktop -- sole writer --> Desktop-owned App Server
    ^
    +-- read-only rollout fallback for missing long-history items
```

The bridge does not connect a second writer to Desktop tasks. Desktop remains
the owner of every live task; mobile reads and writes are proxied through the
native `codex_app` control channel.

Use a phone browser to open local Codex tasks, append to running turns, inspect
sanitized tool activity, upload files, and preview generated artifacts without
streaming the desktop.

> [!WARNING]
> This project uses experimental Codex App Server messages. It is not an
> official OpenAI product, and a Codex update may require compatibility fixes.

## What works

- Fast task list with running, unread-complete, and empty states
- Recent-history-first rendering and paginated older turns
- Streaming replies and collapsed live tool previews
- Running-turn append and soft stop requests
- Collapsed command, file-change, and tool activity previews
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
| Full desktop/mobile experience | Windows Codex Desktop running normally; the bridge uses its native `codex_app` tools pipe |

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

The only runtime package is the widely used `ws` WebSocket implementation,
retained for legacy App Server compatibility modes.

## Deploy with another coding agent

An agent can deploy this project, but it must treat the Codex process and task
history as user-owned state. Give the agent this instruction:

> Deploy this repository by following `docs/agent-deployment.md`. On verified
> Windows builds, prefer Desktop-control mode through the native `codex_app`
> tools pipe. Keep Codex Desktop as the sole writer. Do not copy, replace,
> patch, stop, or redistribute Codex binaries, and do not
> interrupt existing Codex tasks. Keep the bridge and App Server on loopback,
> create a fresh private state directory and password, run all checks, and
> report the exact access URL, connection mode, persistence method, and
> verification results. Do not expose the bridge directly to the public
> internet. Do not enable the legacy RPC-multiplexer topology as a fallback.

The complete [agent deployment runbook](docs/agent-deployment.md) defines
preflight checks, safe startup order, remote-access boundaries, acceptance
tests, and the required handoff report. It intentionally forbids an agent from
silently killing a running Desktop/App Server or claiming that private stdio is
the full shared experience.

## Connection modes

### Desktop control - recommended experience

On the verified Windows build, the bridge uses Desktop's native `codex_app`
tools pipe. Desktop remains the sole task writer; the phone invokes approved
Desktop operations for listing, reading, sending, running-turn append, project
discovery, and task creation. Recent items omitted by `read_thread` can be
recovered from local rollout files through a read-only fallback.

This production path does not inject a `codex_app` transport into `config.toml`
and does not start or share another Desktop App Server.

### Single-connection shared mode - legacy experiment

Codex currently associates a task's active writer with the client transport
connection. Merely opening two WebSockets to one App Server is therefore not
enough. The repository retains an RPC multiplexer for protocol research, but
current Desktop ownership behavior can reject or destabilize this setup. It is
not the recommended deployment path.

Start the bridge with both the private upstream App Server and the Desktop-facing
multiplexer endpoint:

```shell
CODEX_MOBILE_APP_SERVER_URL=ws://127.0.0.1:4512 \
CODEX_MOBILE_RPC_MUX_LISTEN_URL=ws://127.0.0.1:4513 \
node server.mjs
```

Do not configure Codex Desktop to connect to this route in normal deployment.
Any experiment must use idle disposable tasks, version-specific acceptance
tests, and an immediate rollback to an ordinary Desktop-owned App Server.

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

### Verified environment

The following combination has passed real Desktop/mobile tests. This is a
verified baseline, not a claim that other combinations are incompatible.

| Component | Verified version | Status |
|---|---|---|
| Operating system | Windows 11 Home Chinese, 25H2, x64, build `26200.9168` | Verified |
| Codex Desktop | Microsoft Store MSIX `26.820.9563.0` | Verified |
| Codex CLI bundled with Desktop | `codex-cli 0.150.0-alpha.8` | Verified |
| Desktop-control transport | Native `codex_app` tools pipe with Desktop as the sole writer | Verified |
| Mobile browsers | Chromium-based Android/HarmonyOS browser | Verified manually |
| macOS | Not yet tested | Unverified |
| Linux | Not yet tested | Unverified |
| Other Codex Desktop releases | Run the update checklist before enabling writes | Unverified |

The verified Desktop-control implementation currently auto-discovers the
native tools pipe on Windows. Portable private-stdio/App Server code exists,
but it must not be presented as equivalent to controlling the live Desktop
task until that platform has passed the same acceptance tests.

Before accepting a Codex Desktop update, follow the
[Codex update checklist](docs/codex-update-checklist.md). It records the
known-good version and tool catalog, verifies idle and active-turn messaging,
checks long-history recovery, and defines a Desktop-safe rollback boundary.

Desktop control is the verified product path on Windows. Private stdio remains
a diagnostic fallback, and the RPC multiplexer remains a legacy experiment.

## Project status and license

The project is preparing its first public release and is licensed under the
Apache License 2.0.

See [LICENSE](LICENSE), [NOTICE](NOTICE.md), and
[CONTRIBUTING](CONTRIBUTING.md).
