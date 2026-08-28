# Codex Desktop update checklist

Use this checklist whenever Codex Desktop changes version. The mobile bridge
depends on private Desktop integration points, so a successful application
launch is not sufficient evidence of compatibility.

Do not modify `config.toml`, inject an App Server transport, start a second
writer, or replace Codex binaries while performing these checks.

## 1. Capture the known-good baseline

- [ ] Record the Codex Desktop package name and version.
- [ ] Record `codex --version` and the packaged `codex.exe` path.
- [ ] Record the bridge commit and run `npm run check` and `npm test`.
- [ ] Save the names returned by the Desktop `tools/list` catalog.
- [ ] Confirm the catalog contains at least:
  - `list_threads`
  - `read_thread`
  - `wait_threads`
  - `send_message_to_thread`
- [ ] Record hashes of the bundled `codex-app-tools/server.mjs` and `app.asar`
  for comparison only. Do not patch either file.
- [ ] Confirm the ordinary Desktop task is usable before touching the bridge.

## 2. Prepare for the update

- [ ] Let active turns finish and close approval dialogs.
- [ ] Stop only the mobile bridge and tunnel. Do not kill or replace Desktop's
  private App Server independently.
- [ ] Save the bridge state and logs, excluding the password, uploaded private
  files, task transcripts, credentials, and keys from any bug report.
- [ ] Note the release notes or observed package-version change.
- [ ] Keep the previous bridge commit available for rollback.

## 3. Verify Desktop before reconnecting mobile

- [ ] Start Codex Desktop normally with no bridge configuration injection.
- [ ] Confirm `config.toml` parses and contains no bridge-created `codex_app`
  transport override.
- [ ] Confirm exactly one normal Desktop-owned App Server is running.
- [ ] Open an existing task, send an ordinary message, and receive a reply.
- [ ] Confirm the native `codex_app` pipe can be discovered and `tools/list`
  succeeds.
- [ ] Diff the new tool catalog and schemas against the baseline.

Stop here if Desktop itself is unhealthy. Do not try to repair Desktop by
enabling shared-writer mode.

## 4. Bridge compatibility tests

Use a disposable test task; never run write tests against important work.

- [ ] Start the bridge in Desktop-control mode and confirm `/api/status` reports
  `ready: true` and `appServerTransport: desktop-control`.
- [ ] Load the first task-list page and open a task without creating a writer
  conflict.
- [ ] Read a recent short task through `read_thread`.
- [ ] Open a long task whose recent Desktop turns have empty `items`; confirm
  the read-only rollout fallback restores the latest user and assistant text.
- [ ] Send one ordinary message to an idle disposable task.
- [ ] While that task is active, send a second marker message. Confirm it enters
  the same turn rather than being rejected or queued as a later turn.
- [ ] Trigger **Request stop** during a harmless running test. Confirm the stop
  instruction enters the active turn. Do not describe this as a hard interrupt.
- [ ] Confirm image/file upload, authenticated preview, and download still work.
- [ ] Confirm tool activity is summarized and collapsed by default.
- [ ] Restart only the bridge and verify task history, authentication, and the
  public HTTPS route recover without restarting Desktop.

## 5. Interpret failures

| Failure | Meaning | Safe response |
|---|---|---|
| `send_message_to_thread` missing | Mobile writes and soft stop are unavailable | Disable send/stop and update the adapter |
| Active send is rejected | Running-turn steer compatibility changed | Allow idle sends only; disable soft stop |
| Active send is queued | Soft stop no longer works promptly | Label it unsupported for this version |
| `read_thread` omits recent items | Desktop read shape changed or remains partial | Validate the rollout fallback before release |
| `already has an active writer` | A second-writer path was reintroduced | Stop the bridge path; leave Desktop as sole writer |
| `invalid transport` in `codex_app` | Desktop configuration was injected or corrupted | Remove only the invalid override and restore normal Desktop startup |
| Native pipe method/schema changes | Private control ABI changed | Update the discovery/client adapter; do not patch Codex |

## 6. Acceptance and rollback

- [ ] Record the new Desktop version, CLI version, tool-catalog diff, bridge
  commit, test time, and result.
- [ ] Accept the update only after Desktop read, idle send, active send, rollout
  recovery, bridge restart, and public HTTPS checks pass.
- [ ] If compatibility fails, keep Desktop as the only writer and run the
  bridge read-only or offline until the adapter is updated.
- [ ] Never restore the abandoned shared App Server/RPC-multiplexer production
  cutover as an automatic rollback.

## Compatibility log

| Date | Desktop package | CLI | Bridge commit | Catalog change | Result |
|---|---|---|---|---|---|
| 2026-08-28 | `OpenAI.Codex 26.820.9563.0` | `codex-cli 0.150.0-alpha.8` | `d59a1d3` or later | `send_message_to_thread` supports active-turn append; no exposed hard interrupt | Desktop-control mode accepted |
