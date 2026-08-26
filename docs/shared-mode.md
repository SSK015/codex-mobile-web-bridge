# Shared mode

Shared mode is the intended default product experience. Private stdio exists as
a compatibility and diagnostic fallback.

## User-visible difference

| Capability | Shared App Server | Separate private App Servers |
|---|---|---|
| See a desktop-started turn live | Yes | Usually delayed or incomplete |
| See live tool events and requests | Yes | Only for turns owned by the mobile server |
| Steer the desktop's active turn | Yes | No reliable shared turn identity |
| Stop the desktop's active turn | Yes | No reliable shared turn identity |
| Keep running state accurate | Yes | May be stale until persisted metadata changes |
| Open/write one task from both clients | Coordinated by one server | May conflict on task ownership or rollout files |
| Continue after switching devices | Immediate | Requires handoff, reload, or waiting for persistence |

Without shared mode, the bridge is still a useful independent mobile Codex
client, but it is not remote control of the desktop's live Codex session.

## Required topology

```text
Codex Desktop ----\
                   +--> one loopback Codex App Server
Mobile Web Bridge-/
```

The App Server must listen only on loopback. The phone connects to the bridge,
never directly to the App Server WebSocket.

## Current release blocker

The bridge can connect when `CODEX_MOBILE_APP_SERVER_URL` is supplied. What is
not yet portable is configuring every Codex Desktop version and operating
system to use that same externally managed server.

Before the first public release, the project should provide:

1. version and capability detection;
2. a one-command shared bootstrap on the tested host platform;
3. explicit fallback to private stdio when unsupported;
4. no copying or redistribution of Codex binaries;
5. a visible UI indicator showing `shared` or `private fallback` mode.
