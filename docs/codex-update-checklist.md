# Codex Desktop update checklist

Use this checklist when Codex Desktop changes version. A successful application launch alone does not establish bridge compatibility.

Do not modify Codex configuration, inject an App Server transport, start a second task writer, or replace Codex binaries while checking an update.

## 1. Record the baseline

- [ ] Record the Codex Desktop package version and bundled CLI version.
- [ ] Record the bridge revision and results of `npm run check` and `npm test`.
- [ ] Record the names returned by the Desktop `tools/list` catalog.
- [ ] Confirm the catalog contains the read and history tools used by the bridge, including `list_threads`, `read_thread`, and `wait_threads`.
- [ ] Confirm ordinary tasks still work in Codex Desktop before checking the bridge.

## 2. Check Desktop before using the bridge

- [ ] Start Codex Desktop normally and confirm it is usable.
- [ ] Confirm there is one normal Desktop-owned App Server and no bridge-created transport override.
- [ ] Confirm the native tools pipe is discovered only when its owner belongs to the running Desktop process.
- [ ] Confirm `tools/list` completes successfully.
- [ ] Compare the tool catalog and schemas with the previous known-good version.
- [ ] Check the outer `tools/call` envelope as well as tool input schemas. The bridge uses `params.callerSource: "codex"` for calls from this local task bridge.

Stop if Desktop itself is unhealthy. Do not enable a shared-writer mode to repair it.

## 3. Read-only bridge checks

- [ ] Start the bridge in Desktop-control mode and confirm `/api/status` reports `ready: true` and `appServerTransport: desktop-control`.
- [ ] Load the task list and read an existing task without creating a second writer.
- [ ] Read the latest turn of the current task.
- [ ] For a task with recent Desktop turns that omit items, confirm the read-only rollout fallback can restore the missing history.
- [ ] Confirm a disconnection clears the old tool namespace and that the bridge reconnects without replaying an uncertain call.

Readiness and cached history are not substitutes for a successful read-only `tools/call`. A read-only check does not verify task writes or the complete mobile workflow.

## 4. Optional write and mobile checks

Use a disposable task, never important work. These checks are needed before claiming end-to-end compatibility on a new Desktop version.

- [ ] Send one ordinary message to an idle disposable task.
- [ ] If checking running-turn append, verify a second message reaches the active turn.
- [ ] Verify **Request stop** is described as a soft-stop message, not a hard interrupt.
- [ ] Confirm file and image upload, authenticated preview, and download.
- [ ] Confirm tool activity is summarized and collapsed by default.
- [ ] Reopen the task from a phone browser and verify the full workflow.

Do not repeat or replay an uncertain write after a disconnection. Check the task first.

## 5. Interpret failures

| Failure | Meaning | Safe response |
|---|---|---|
| `send_message_to_thread` is missing | Mobile writes and soft stop are unavailable | Keep the bridge read-only and update the adapter before claiming write compatibility |
| Active-turn append is rejected | Running-turn behavior changed | Allow only verified idle sends and disable soft stop |
| `read_thread` omits recent items | Desktop history is partial or changed | Validate the read-only rollout restoration path |
| A second-writer error appears | A competing writer was introduced | Stop bridge writes and keep Desktop as the only writer |
| `tools/list` fails on an endpoint | The endpoint may be stale or incompatible | Retry discovery within the verified Desktop-owned tools-pipe pool |

## Compatibility records

| Codex Desktop | Bundled CLI | Scope and result |
|---|---|---|
| `26.820.9563.0` | `0.150.0-alpha.8` | End-to-end mobile workflow checked in August 2026 on Windows 11 25H2 x64, with Chrome on Android (Pixel) and a Huawei HarmonyOS browser. |
| `26.1117.4957.0` | `0.171.0-alpha.13` | Process-filtered endpoint discovery, read-only `tools/list` handshake, session listing, and latest-turn reading checked; the bridge retains a read-only rollout-history restore path, but it was not exercised in this check. No task-write or full mobile workflow is claimed for this version. |
