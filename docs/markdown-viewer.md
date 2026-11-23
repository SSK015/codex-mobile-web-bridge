# Standalone Markdown viewer

The bridge includes a separate page for reading Markdown documents. It does not load the chat interface, open an event stream, start a task, or change task state.

## Open a document

- Open **Markdown preview** from the task list, then choose a local text file, drop a file onto the page, or paste Markdown.
- Open a Markdown artifact from a task to preview it in a new tab. The artifact download action still returns the original file.
- You can also open `markdown.html` from the same bridge.

Task artifacts use the existing authenticated endpoint. If needed, the preview page can prompt for sign-in and retry the artifact fetch, so a user does not have to sign in before opening the preview. An expired link or changed file must be reopened from its task.

## Limits and rendering

The viewer accepts `.md`, `.markdown`, `.mdown`, and `.txt` files up to 2 MiB. Local files and pasted text stay in the browser; the bridge does not upload or save them.

Markdown is rendered with the locally served markdown-it bundle. Raw HTML is shown as text, and unsafe URL schemes are rejected. Relative local image and file references are not resolved. Images with explicit HTTP(S) URLs may be requested by the browser. Code blocks are displayed as text; math and diagram extensions are not enabled.

Copy and download use the current source text. Editing in the viewer never changes a task artifact on the host.

## Development

After changing the pinned markdown-it development dependency, run:

    npm run vendor:markdown

The generated browser bundle and its license notices are under `public/vendor/`; production does not load a CDN.

Focused checks are available with `npm run test:markdown` and `npm run test:markdown:browser`. The optional browser check requires Playwright and Chromium installed separately; it uses synthetic content and a loopback fixture, and does not connect to a real Codex task.
