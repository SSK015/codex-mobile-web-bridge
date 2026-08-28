# Architecture

```text
mobile browser -- HTTPS --> bridge ----\
                                       RPC mux == one WS ==> Codex App Server
Codex Desktop -------- local WS -------/
```

The bridge is a Node.js server and a static mobile web client. Its only runtime
package is `ws`, used for the loopback multiplexer server.
It does not call the OpenAI API directly. Authentication and model access remain
owned by the user's installed Codex environment.

## Transport modes

### Private stdio

The default starts `codex app-server --stdio` as a child process. This is the
simplest portable mode. Another Codex client may be unable to write the same
task concurrently.

### Single-connection RPC mux (recommended, experimental)

Set `CODEX_MOBILE_APP_SERVER_URL` to the upstream loopback App Server and
`CODEX_MOBILE_RPC_MUX_LISTEN_URL` to a second loopback endpoint used by Desktop.
The mux remaps request IDs, caches the single initialize response, broadcasts
notifications, and routes server requests. Desktop integration and protocol
compatibility depend on the installed Codex version. Never expose either
WebSocket to the network.

Two direct WebSocket connections to one App Server are not equivalent: current
builds bind active task writer state to the connection. The mux keeps one
physical upstream connection so Desktop-owned tasks remain writable from the
phone.

## Data flow

- Task metadata is cached locally for fast startup.
- Recent history loads in bounded pages; older turns load on demand.
- Tool payloads are summarized and details require an explicit request.
- Local file and image URLs use expiring authenticated tokens bound to file
  identity.
- Uploads are stored only in the configured local state directory.

## Protocol status

App Server messages used by this project are experimental. The bridge uses
runtime validation, conservative sanitization, bounded payloads, and regression
tests, but a Codex update may require an adapter change.
