import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import MarkdownIt from 'markdown-it';
import {
  createMarkdownRenderer, isValidArtifactToken, MAX_CONTENT_BYTES, readBoundedResponse,
} from '../public/markdown-renderer.js';

const baseUrl = `https://example.test/bridge/markdown.html?artifact=${'a'.repeat(48)}&name=notes.md`;
const renderer = createMarkdownRenderer(MarkdownIt, { baseUrl });
const document = [
  '# Overview', '', '[Jump](#overview)', '', '## Details', '',
  '- parent', '  - child', '- [x] Complete', '- [ ] Pending', '',
  '| Name | State |', '| --- | --- |', '| Renderer | Ready |', '',
  '> A quoted line', '', '```js', 'const n = 1 < 2;', '```', '',
  '**Strong** and *emphasis* and ~~removed~~.',
].join('\n');
const html = renderer.render(document);
assert.match(html, /<h1 id="md-preview-overview">Overview<\/h1>/);
assert.match(html, /href="#md-preview-overview"/);
assert.match(html, /<li>parent\s*<ul>\s*<li>child/);
assert.match(html, /type="checkbox" disabled checked/);
assert.match(html, /type="checkbox" disabled aria-label=/);
assert.match(html, /<table>[\s\S]*<td>Renderer<\/td>/);
assert.match(html, /<blockquote>/);
assert.match(html, /class="language-js">const n = 1 &lt; 2;/);
assert.match(html, /<strong>Strong<\/strong>/);
assert.match(html, /<s>removed<\/s>/);

const headings = renderer.render('# A\n\n# A\n\n# A-2\n\n# 中文标题\n\n[中文](#中文标题)');
const ids = Array.from(headings.matchAll(/id="([^"]+)"/g), (match) => match[1]);
assert.equal(new Set(ids).size, ids.length, 'heading IDs must not collide');
assert.ok(ids.every((id) => id.startsWith('md-preview-')));
assert.match(headings, /href="#md-preview-中文标题"/);
assert.match(renderer.render('# A'), /id="md-preview-a"/, 'render state resets per document');

const unsafe = renderer.render([
  '<script>globalThis.pwned = true</script>',
  '<img src=x onerror="alert(1)">',
  '[js](javascript:alert(1))', '[file](file:///etc/passwd)',
  '[data](data:text/html,hello)', '[relative](../private)',
  '[protocol relative](//example.test/private)',
  '![relative image](./image.png)', '![data image](data:image/png;base64,AAAA)',
  '[missing anchor](#missing)', '[credentials](https://name:password@example.test/)',
].join('\n\n'));
assert.doesNotMatch(unsafe, /<(?:script|img)\b/i);
assert.doesNotMatch(unsafe, /href=/i);
assert.match(unsafe, /&lt;script&gt;/);
assert.match(unsafe, /md-blocked-link/);
assert.match(unsafe, /md-blocked-image/);
const external = renderer.render('[safe](https://example.test/?a=1&b=2)\n\n![A **bold** diagram](https://example.test/image.png)');
assert.match(external, /target="_blank" rel="noopener noreferrer"/);
assert.match(external, /alt="A bold diagram"/);
assert.match(external, /loading="lazy"/);
assert.match(external, /referrerpolicy="no-referrer"/);
assert.match(renderer.render('[email](mailto:test@example.test) [phone](tel:+123456)'), /href="mailto:test@example.test"/);

assert.equal(MAX_CONTENT_BYTES, 2 * 1024 * 1024);
for (const token of ['a'.repeat(40), '_-'.repeat(24), 'b'.repeat(2048)]) assert.ok(isValidArtifactToken(token));
for (const token of [null, 42, '', 'a'.repeat(39), 'a'.repeat(2049), '../secret', `${'a'.repeat(48)}/bad`]) {
  assert.equal(isValidArtifactToken(token), false);
}
const bytes = new TextEncoder().encode('A中文🙂Z');
const splitUtf8 = new ReadableStream({
  start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  },
});
assert.equal(await readBoundedResponse(new Response(splitUtf8), bytes.length), 'A中文🙂Z');
assert.equal(await readBoundedResponse(new Response('')), '');
let headerCancelled = false;
await assert.rejects(readBoundedResponse(new Response(new ReadableStream({
  cancel() { headerCancelled = true; },
}), { headers: { 'content-length': '100' } }), 10), RangeError);
assert.ok(headerCancelled);
let bodyCancelled = false;
await assert.rejects(readBoundedResponse(new Response(new ReadableStream({
  start(controller) { controller.enqueue(new Uint8Array(11)); },
  cancel() { bodyCancelled = true; },
}), { headers: { 'content-length': '1' } }), 10), RangeError);
assert.ok(bodyCancelled, 'actual streamed bytes, not just the header, enforce the cap');
await assert.rejects(readBoundedResponse(new Response('x'.repeat(11)), 10), RangeError);

// Exercise the exact vendored browser build, not just the Node dependency.
const context = vm.createContext({});
vm.runInContext(await fs.readFile(new URL('../public/vendor/markdown-it.min.js', import.meta.url), 'utf8'), context);
assert.equal(typeof context.markdownit, 'function');
const browserRenderer = createMarkdownRenderer(context.markdownit, { baseUrl });
assert.equal(browserRenderer.render(document), html);
assert.equal(browserRenderer.render('![A **bold** diagram](https://example.test/image.png)'), renderer.render('![A **bold** diagram](https://example.test/image.png)'));

console.log('markdown tests passed (rendering, safe URLs/HTML, anchors, UTF-8 size limits, vendored build)');
