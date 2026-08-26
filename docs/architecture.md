# Architecture

```text
mobile browser -- HTTPS/private network --> bridge -- stdio or loopback WS --> Codex App Server
```

The bridge is a dependency-free Node.js server and a static mobile web client.
It does not call the OpenAI API directly. Authentication and model access remain
owned by the user's installed Codex environment.

## Transport modes

### Private stdio

The default starts `codex app-server --stdio` as a child process. This is the
simplest portable mode. Another Codex client may be unable to write the same
task concurrently.

### Shared WebSocket (advanced and experimental)

Set `CODEX_MOBILE_APP_SERVER_URL` to connect to an existing loopback App Server.
This can let multiple clients observe one server, but desktop integration and
protocol compatibility depend on the installed Codex version. Never expose the
App Server WebSocket itself to the network.

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
