# Architecture

```text
mobile browser
    | HTTPS
    v
authenticated Node.js bridge (127.0.0.1)
    |
    +-- list/read/send/create through approved codex_app tools
    |                         |
    |                         v
    |                   Codex Desktop
    |                         | sole writer
    |                         v
    |                 Desktop-owned App Server
    |
    +-- read-only fallback --> ~/.codex/sessions/.../rollout-*.jsonl
```

The bridge is a Node.js server and a static mobile web client. Its only runtime
package is `ws`, retained for legacy App Server compatibility modes.
It does not call the OpenAI API directly. Authentication and model access remain
owned by the user's installed Codex environment.

The production Desktop-control path has one writer: Codex Desktop. The bridge
connects to Desktop's native app-tools pipe, discovers the runtime tool catalog,
and calls only tools that Desktop exposes, such as `list_threads`,
`read_thread`, `send_message_to_thread`, `list_projects`, and `create_thread`.
It never injects an App Server transport into `config.toml`.

## Transport modes

### Desktop control (recommended, Windows-verified)

Set `CODEX_MOBILE_DESKTOP_CONTROL=1`. The bridge discovers the packaged
Desktop `codex_app` pipe and lets Desktop perform task operations. Running-turn
append works through `send_message_to_thread`. Stop is currently a soft stop
message because the app-tools catalog does not expose the internal hard
`turn/interrupt` method.

When `read_thread` returns recent turns with empty `items`, the bridge fills
only those missing items from the local rollout JSONL. Rollouts are never used
to write or control a task.

### Private stdio (compatibility fallback)

The default starts `codex app-server --stdio` as a child process. This is the
simplest portable mode. Another Codex client may be unable to write the same
task concurrently.

### Single-connection RPC mux (legacy experiment, not recommended)

Set `CODEX_MOBILE_APP_SERVER_URL` to the upstream loopback App Server and
`CODEX_MOBILE_RPC_MUX_LISTEN_URL` to a second loopback endpoint used by Desktop.
The mux remaps request IDs, caches the single initialize response, broadcasts
notifications, and routes server requests. This route previously attempted to
share a writer between Desktop and mobile. Current Desktop builds can bind task
ownership to the client and reject or destabilize this setup. Keep it for
protocol research only; do not use it as an automatic production fallback.

Never configure Desktop to use this route without an idle-task cutover, explicit
version-specific testing, and a rollback that restores ordinary Desktop as the
only writer.

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
