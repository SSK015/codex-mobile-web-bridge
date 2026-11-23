# Desktop control reconnection

The bridge can remain open after the Codex Desktop endpoint it first found has changed or disappeared. Desktop-generated pipe names are therefore hints, not permanent addresses.

## Discovery and health checks

- On Windows, discovery checks the current private App Server and its Codex Desktop owner.
- Matching named pipes are filtered by the server process ID. A pipe is used only when it belongs to the current Desktop process.
- When Desktop exposes its dedicated `codex-app-tools-*` endpoint, keep candidate rotation and retries inside that pool. Use legacy browser-use endpoints only when no dedicated endpoint is present.
- Confirm readiness with a read-only `tools/list` handshake that exposes the required bridge tools. A valid pipe name or a healthy browser event stream alone is not enough.
- Refresh the read-only health check while the bridge is idle. Use bounded retries when Desktop is unavailable, and keep the web interface available.

The bridge status endpoint reports the Desktop connection state. `ready` and the Desktop connection events describe that channel; an open browser event stream does not mean Desktop is connected.

## Safe recovery

- Do not restart Codex Desktop, edit its configuration, or start a second App Server as part of reconnection.
- Clear tool namespaces when a socket changes. A namespace belongs to its original connection.
- Do not replay `tools/call` or a queued prompt after a disconnect. If a call might have reached Desktop, inspect the conversation before manually retrying it.
- Existing turn observation may resume after reconnect. The bridge does not resend the prompt that started the turn.
- If Desktop is unavailable, wait for bounded rediscovery or run read-only/offline; do not switch to a shared-writer topology as an automatic fallback.

## Read-only history restoration

Some Desktop responses omit items for recent turns. The bridge can fill those missing items from the matching local rollout history for display. This path is read-only: it does not change Codex files or write to a task.

The latest compatibility check on Codex Desktop `26.1117.4957.0` with bundled CLI `0.171.0-alpha.13` verified process-filtered endpoint discovery, a read-only catalog handshake, session listing, and latest-turn read. The bridge retains a read-only rollout-history restore path for omitted items, but that smoke check did not exercise restoration. It did not send a task message or verify the complete phone workflow. See the [update checklist](codex-update-checklist.md) for the recorded scope.

## Regression checks

Run `npm run check` and `npm test` after changing discovery or reconnection behavior. The isolated coverage includes a missing Desktop at startup, pipe rotation, failed handshakes, health timeouts, fresh tool namespaces, offline HTTP/SSE state, and no message replay.

To report a compatibility issue, include the Codex Desktop and bundled CLI versions, operating system, connection mode, and a redacted error or message shape. Do not include task text, credentials, local paths, or private endpoint names.
