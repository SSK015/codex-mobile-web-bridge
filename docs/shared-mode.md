# Single-connection shared mode

Single-connection shared mode is the intended default product experience.
Private stdio exists as a compatibility and diagnostic fallback.

## Why a multiplexer is required

Current Codex App Server builds associate a loaded task and its active writer
with the client transport connection. Two clients connected to the same App
Server process can read persisted history, but the second connection may receive
`active writer` on `thread/resume` and `thread not found` on `turn/start`.

The RPC multiplexer (a local proxy that routes several logical clients over one
physical connection) removes that split. Desktop initializes the upstream App
Server connection once. Desktop RPC and the mobile bridge then receive separate
request-ID namespaces on that same connection. Notifications are fanned out to
both clients, and server-initiated approval requests are resolved by the first
client that answers.

## User-visible difference

| Capability | Single shared connection | Separate App Server connections |
|---|---|---|
| See a desktop-started turn live | Yes | Usually delayed or incomplete |
| See live tool events and requests | Yes | Only for turns owned by that connection |
| Send or steer from the phone | Yes | Can fail with writer ownership errors |
| Stop the desktop's active turn | Yes | No reliable shared turn identity |
| Keep running state accurate | Yes | May be stale until persistence catches up |
| Continue after switching devices | Immediate | Requires handoff or writer release |

## Required topology

```text
                         +-- Desktop logical client
Codex App Server <== one RPC multiplexer connection
                         +-- Mobile bridge logical client <-- HTTPS <-- phone
```

All App Server and multiplexer sockets must listen only on loopback. The phone
connects to the authenticated bridge HTTP endpoint, never to either WebSocket.

Example ports:

- upstream App Server: `ws://127.0.0.1:4512`
- Desktop-facing multiplexer: `ws://127.0.0.1:4513`
- mobile bridge HTTP: `http://127.0.0.1:4780`

Start the bridge with:

```shell
CODEX_MOBILE_APP_SERVER_URL=ws://127.0.0.1:4512 \
CODEX_MOBILE_RPC_MUX_LISTEN_URL=ws://127.0.0.1:4513 \
node server.mjs
```

Then configure Desktop to use the multiplexer endpoint at `4513`, not the
upstream App Server at `4512`.

## Lifecycle rules

1. Start the App Server.
2. Start the bridge and wait for the multiplexer listener.
3. Start Desktop pointed at the multiplexer.
4. Desktop sends the single upstream `initialize`; the mobile HTTP server
   becomes ready after Desktop sends `initialized`.
5. On Desktop renderer reconnect, the multiplexer replays the cached initialize
   response without initializing the upstream connection again.

Do not insert the multiplexer underneath a running Desktop connection. A
connection's writer state cannot be migrated in place. Wait until tasks are
idle, stop only the Desktop client, start the multiplexer, and relaunch Desktop
against the multiplexer. If the installed Desktop does not support an external
App Server WebSocket, use private stdio fallback.

## Safety and limits

- Only one Desktop downstream connection is accepted at a time.
- Queues, payloads, and WebSocket backpressure are bounded.
- An upstream disconnect fails pending requests and forces clients to reconnect;
  it does not silently replay mutating RPC calls.
- App Server WebSocket transport and Desktop integration remain experimental and
  may require adapter changes after a Codex update.
- The repository does not patch or redistribute Codex Desktop or Codex binaries.
