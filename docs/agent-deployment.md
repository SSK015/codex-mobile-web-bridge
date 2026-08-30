# Agent deployment runbook

This runbook is written for a coding agent deploying the bridge on a user's
computer. Treat Codex processes, tasks, credentials, firewall rules, domains,
and remote hosts as user-owned resources. Discovery and validation are safe;
do not make unrelated system changes.

## Deployment contract

The deploying agent must:

1. preserve all running Codex tasks and existing user changes;
2. never copy, patch, replace, commit, upload, or redistribute a Codex binary;
3. keep the Codex App Server and this bridge on loopback by default;
4. prefer verified Windows Desktop-control mode and keep Desktop as sole writer;
5. create credentials in a private state directory, never in the repository;
6. ask before changing firewall, DNS, TLS, VPN, service, or public-host state;
7. redact secrets, task text, local paths, task IDs, and public endpoints from
   logs or issue reports; and
8. leave a rollback path and a precise handoff report.

## 1. Preflight

Record, without printing secrets:

- operating system and architecture;
- Node.js version (must be 22 or later);
- installed Codex and Codex CLI versions;
- whether Codex authentication already works for the current OS user;
- whether the packaged Codex Desktop process and native app-tools pipe exist;
- proposed bridge port and whether it is free; and
- the requested phone access boundary: same trusted LAN, private overlay, or
  authenticated HTTPS reverse proxy.

Then run from the repository root:

```shell
npm install
npm run check
npm test
npm run release:check
```

If a check fails, diagnose it before starting a long-lived process.

## 2. Select the connection mode

### Desktop-control mode (preferred on verified Windows builds)

Start Codex Desktop normally. Do not inject transport configuration or restart
its private App Server. The Windows start script enables Desktop-control mode
when no legacy App Server URL is configured:

```powershell
$env:CODEX_MOBILE_DESKTOP_CONTROL = '1'
.\scripts\start.ps1
```

Verify `/api/status` reports `desktop-control`. The bridge discovers the native
pipe and a valid local task context automatically. If discovery fails, stop and
report the installed Desktop version and redacted process shape; do not fall
back to a shared App Server cutover.

### Private stdio fallback

If no compatible shared endpoint exists, stop and tell the user what will be
lost: live Desktop-owned tool events, reliable steering/interruption, shared
approvals, and coordinated task ownership. Use private stdio only after that
fallback is accepted:

```powershell
.\scripts\start.ps1
```

```shell
./scripts/start.sh
```

The scripts locate the installed `codex` command, create a random bridge
password in the private state directory, bind to `127.0.0.1:4780`, and start
the bridge in the foreground.

## 3. Phone access

For a local smoke test, open `http://127.0.0.1:4780` on the host computer.

For a phone, choose one explicit boundary:

- **Trusted LAN:** bind only to the intended LAN interface and limit the host
  firewall to that trusted network.
- **Private overlay:** keep the bridge on loopback and publish it through the
  overlay's authenticated HTTPS facility.
- **Public network:** keep the bridge on loopback and use an authenticated HTTPS
  reverse proxy with rate limiting. Do not expose the App Server WebSocket.

When serving below a path such as `/codex-mobile/`, set:

```shell
CODEX_MOBILE_SECURE_COOKIE=1
CODEX_MOBILE_COOKIE_PATH=/codex-mobile/
```

Use [deployment guidance](deployment.md) and the
[Nginx example](../examples/nginx.conf). Do not transmit a password, private
key, task transcript, or personal file to a third-party service without the
user's explicit authorization.

## 4. Persistence

The foreground start scripts are sufficient for validation. Creating a login
item, systemd unit, launchd job, scheduled task, or supervisor changes system
state and must match the user's requested platform and lifecycle policy.

Whichever mechanism is chosen must:

- use an absolute repository or installed-release path;
- use an absolute private state directory;
- restart only the bridge it owns;
- never treat a Codex Desktop/App Server process as its disposable child; and
- preserve the password and upload directory with user-only permissions.

## 5. Acceptance tests

Verify all applicable items without sending a real task unless the user asks:

1. unauthenticated API access is rejected;
2. login succeeds with the generated password;
3. `/api/status` reports ready and the intended transport (`desktop-control`
   for the verified path, `stdio` only for an accepted diagnostic fallback);
4. the recent task list appears;
5. a long task opens at recent history and older history can be paged;
6. the jump-to-latest button appears after scrolling upward and returns to the
   newest message;
7. tool groups are collapsed by default;
8. image and artifact routes require authentication; and
9. the App Server remains loopback-only and existing Codex tasks remain alive.

For Desktop-control mode, additionally verify that a Desktop-started harmless
test task receives a phone message and an active-turn append without `active
writer` or `thread not found`. Confirm soft stop is labeled as a message request,
not a hard interrupt. Perform write tests only with user approval.

## 6. Required handoff

Report:

- repository revision;
- OS, Node.js, Codex Desktop, and CLI versions;
- bridge URL and phone URL;
- `desktop-control` or `private stdio diagnostic fallback`, with evidence;
- state directory (but never its password contents);
- startup/persistence mechanism and how to stop only the bridge;
- checks and acceptance tests performed;
- any firewall, proxy, DNS, TLS, or overlay change;
- known compatibility limitations; and
- rollback instructions.

Do not declare success merely because the HTML page loads. A successful
Desktop-control deployment must prove that Desktop remains usable as the sole
writer and that a disposable task can be read and continued through the native
tool channel.
