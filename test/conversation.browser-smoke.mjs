// Real layout regression checks against synthetic conversations; no Desktop
// connection, credentials, or task messages are used.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../public/', import.meta.url));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const fixture = {
  id: 'stability', name: 'Synthetic conversation', status: 'idle', eventSequence: 1, updatedAt: 1,
  turns: Array.from({ length: 24 }, (_, index) => ({
    id: `turn-${index}`, status: 'completed', items: [
      { id: `user-${index}`, type: 'userMessage', text: `Question ${index}` },
      { id: `agent-${index}`, type: 'agentMessage', text: Array.from({ length: 3 + index % 7 }, (_, paragraph) =>
        `Paragraph ${index}.${paragraph}. ${'Keep this reading position stable. '.repeat(12)}`).join('\n\n') },
    ],
  })),
};
fixture.turns[10].items.splice(1, 0, {
  id: 'fixture-tools', type: 'toolGroup', turnId: 'turn-10', count: 3, status: 'completed', hasDetails: false,
});
const eventClients = new Set();
const server = http.createServer(async (request, response) => {
  request.resume();
  const resource = new URL(request.url, 'http://localhost').pathname.replace(/^\/codex-mobile\//, '');
  if (resource === 'events') {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    response.write(': connected\n\n');
    eventClients.add(response);
    response.on('close', () => eventClients.delete(response));
    return;
  }
  if (resource.startsWith('api/')) {
    const body = resource === 'api/status' ? { ready: true }
      : resource === 'api/threads' ? { data: [fixture] }
        : resource.startsWith('api/threads/stability') ? { thread: fixture }
          : resource === 'api/model-options' ? { models: [], thinking: [], modelThinking: {} } : {};
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    return;
  }
  const name = resource || 'index.html';
  const target = path.resolve(root, name);
  if (!target.startsWith(root) || !/\.(?:html|css|js|svg|png)$/.test(target)) { response.writeHead(404).end(); return; }
  try {
    const body = await fs.readFile(target);
    const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' }[path.extname(target)];
    response.writeHead(200, { 'Content-Type': mime }).end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      window.setInterval = () => 0;
      window.IntersectionObserver = class { observe() {} disconnect() {} };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/codex-mobile/`);
    await page.evaluate(async () => {
      window.app = await import('./app.js');
      while (app.state.bootInFlight) await new Promise((resolve) => setTimeout(resolve, 10));
      await app.openThread('stability');
    });
    const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await settle();
    const readMiddle = (fraction = 0.45) => page.evaluate((fraction) => {
      const pane = document.querySelector('#messages');
      pane.scrollTop = (pane.scrollHeight - pane.clientHeight) * fraction;
      app.updateJumpBottom();
      const top = pane.getBoundingClientRect().top;
      const anchor = [...pane.querySelectorAll('[data-item-id]')].find((node) => node.getBoundingClientRect().bottom > top + 1);
      window.anchor = { id: anchor.dataset.itemId, offset: anchor.getBoundingClientRect().top - top };
      window.keptMessage = anchor;
      return window.anchor;
    }, fraction);
    const checkAnchor = async (before, label) => {
      await settle();
      const after = await page.evaluate((id) => {
        const pane = document.querySelector('#messages');
        const node = pane.querySelector(`[data-item-id="${id}"]`);
        return { offset: node.getBoundingClientRect().top - pane.getBoundingClientRect().top, sameNode: node === window.keptMessage };
      }, before.id);
      assert.ok(Math.abs(after.offset - before.offset) < 2, `${viewport.width}px ${label}: ${JSON.stringify({ before, after })}`);
      return after;
    };

    const before = await readMiddle();
    await page.waitForFunction(() => window.app.state.eventSource?.readyState === EventSource.OPEN);
    const snapshot = { type: 'threadSnapshot', thread: { ...fixture, eventSequence: 2, updatedAt: 2 } };
    for (const response of eventClients) response.write('data: ' + JSON.stringify(snapshot) + '\n\n');
    await page.waitForFunction(() => window.app.state.activeThread?.eventSequence === 2, null, { timeout: 5000 });
    assert.equal((await checkAnchor(before, 'identical pushed snapshot')).sameNode, true, 'unchanged messages retain their DOM nodes');

    await page.evaluate(() => {
      window.toolDisclosure = document.querySelector('[data-item-id="fixture-tools"] details');
      toolDisclosure.open = true;
      app.handleEvent({ type: 'threadSnapshot', thread: { ...app.state.activeThread, eventSequence: 3, updatedAt: 3 } });
    });
    assert.equal(await page.evaluate(() => document.querySelector('[data-item-id="fixture-tools"] details') === toolDisclosure && toolDisclosure.open), true,
      'an unchanged tool disclosure remains expanded');

    await page.evaluate(() => {
      const pane = document.querySelector('#messages');
      pane.scrollTop = pane.scrollHeight;
      app.updateJumpBottom();
      window.originalFetch = window.fetch;
      window.fetch = (url, options) => String(url).endsWith('api/threads/stability')
        ? new Promise((resolve) => { window.deliverSnapshot = resolve; }) : originalFetch(url, options);
      window.pendingSnapshot = app.refreshActiveThreadSnapshot();
    });
    const duringRequest = await readMiddle();
    await page.evaluate(() => deliverSnapshot(new Response(JSON.stringify({ thread: { ...app.state.activeThread, eventSequence: 4, updatedAt: 4 } }), { headers: { 'Content-Type': 'application/json' } })));
    await page.evaluate(() => pendingSnapshot);
    await checkAnchor(duringRequest, 'reader scrolls up during HTTP request');

    await page.evaluate(() => { window.pendingSnapshot = app.refreshActiveThreadSnapshot(); });
    await page.evaluate(() => {
      const thread = structuredClone(app.state.activeThread);
      thread.eventSequence = 6;
      thread.turns.at(-1).items.at(-1).text += '\n\nNewest pushed answer.';
      app.handleEvent({ type: 'threadSnapshot', thread });
      const stale = structuredClone(thread);
      stale.eventSequence = 5;
      stale.turns.at(-1).items.at(-1).text = 'Stale HTTP answer.';
      deliverSnapshot(new Response(JSON.stringify({ thread: stale }), { headers: { 'Content-Type': 'application/json' } }));
    });
    await page.evaluate(() => pendingSnapshot);
    assert.match(await page.locator('[data-item-id="agent-23"] .content').textContent(), /Newest pushed answer/);

    await page.evaluate(() => {
      const pane = document.querySelector('#messages');
      pane.scrollTop = pane.scrollHeight;
      app.updateJumpBottom();
      app.scrollBottom();
      pane.scrollTop = (pane.scrollHeight - pane.clientHeight) * 0.4;
      app.updateJumpBottom();
    });
    await settle();
    assert.equal(await page.evaluate(() => app.state.followLatest), false, 'queued scroll respects the reader moving away');
    await page.evaluate(() => {
      const pane = document.querySelector('#messages');
      pane.scrollTop = pane.scrollHeight;
      app.updateJumpBottom();
      const thread = structuredClone(app.state.activeThread);
      thread.eventSequence++;
      thread.turns.at(-1).items.at(-1).text += '\n\nMore output. '.repeat(20);
      app.handleEvent({ type: 'threadSnapshot', thread });
    });
    await settle();
    const bottomGap = await page.evaluate(() => {
      const pane = document.querySelector('#messages');
      return pane.scrollHeight - pane.clientHeight - pane.scrollTop;
    });
    assert.ok(bottomGap < 2, `following latest remains pinned: ${bottomGap}`);

    const livePosition = await readMiddle();
    await page.evaluate(() => {
      const thread = structuredClone(app.state.activeThread);
      thread.eventSequence++;
      thread.status = 'active';
      thread.turns.at(-1).status = 'inProgress';
      thread.turns.at(-1).items.at(-1).text += '\n\nLive snapshot grows below the reader.';
      app.state.activeTurnId = thread.turns.at(-1).id;
      app.state.activeTurnThreadId = thread.id;
      app.handleEvent({ type: 'threadSnapshot', thread });
    });
    assert.equal((await checkAnchor(livePosition, 'live snapshot while reading history')).sameNode, true);

    await page.evaluate(() => {
      const thread = structuredClone(app.state.activeThread);
      thread.eventSequence++;
      thread.status = 'idle';
      thread.turns.at(-1).status = 'completed';
      thread.hasOlderTurns = true;
      thread.olderTurnsCursor = 'older-page-1';
      app.handleEvent({ type: 'threadSnapshot', thread });
      window.fetch = (url, options) => String(url).includes('/turns?')
        ? new Promise((resolve) => { window.deliverOlder = resolve; }) : originalFetch(url, options);
      window.pendingOlder = app.loadOlderTurns();
      // A background refresh must not cancel an in-flight history page.
      app.handleEvent({ type: 'threadSnapshot', thread: { ...thread, eventSequence: thread.eventSequence + 1 } });
    });
    const historyWaitPosition = await readMiddle(0.3);
    await page.evaluate(() => {
      const olderTurns = app.state.activeThread.turns.slice(0, 3).map((turn, index) => ({
        ...turn, id: `older-turn-${index}`,
        items: turn.items.map((item) => ({ ...item, id: `older-${item.id}` })),
      }));
      deliverOlder(new Response(JSON.stringify({ turns: olderTurns, hasOlderTurns: true, olderTurnsCursor: 'older-page-2' }),
        { headers: { 'Content-Type': 'application/json' } }));
    });
    await page.evaluate(() => pendingOlder);
    await checkAnchor(historyWaitPosition, 'reader scrolls while older history is loading');
    const olderPosition = await readMiddle(0.02);
    assert.match(olderPosition.id, /^older-/, 'the reader is viewing the newly loaded older page');
    await page.evaluate(() => {
      window.loadedPager = app.state.historyPager;
      const thread = structuredClone(app.state.activeThread);
      thread.turns = thread.turns.slice(-24);
      thread.hasOlderTurns = true;
      thread.olderTurnsCursor = 'older-page-1';
      thread.eventSequence++;
      app.handleEvent({ type: 'threadSnapshot', thread });
    });
    assert.equal((await checkAnchor(olderPosition, 'recent snapshot retains loaded older history')).sameNode, true);
    assert.equal(await page.evaluate(() => app.state.activeThread.turns.length === 27
      && app.state.historyPager === loadedPager && loadedPager.cursor === 'older-page-2'), true);

    await page.evaluate(() => {
      window.fetch = (url, options) => String(url).endsWith('api/threads/stability')
        ? new Promise((resolve) => { window.deliverSnapshot = resolve; }) : originalFetch(url, options);
      window.pendingSnapshot = app.refreshActiveThreadSnapshot();
      const thread = structuredClone(app.state.activeThread);
      thread.turns = thread.turns.slice(-24);
      thread.olderTurnsCursor = 'older-page-1';
      thread.eventSequence++;
      deliverSnapshot(new Response(JSON.stringify({ thread }), { headers: { 'Content-Type': 'application/json' } }));
    });
    await page.evaluate(() => pendingSnapshot);
    assert.equal((await checkAnchor(olderPosition, 'polled snapshot retains loaded older history')).sameNode, true);

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ viewport: viewport.width, passed: true, bottomGap }));
    await page.close();
  }
  // A refresh should restore the conversation even if an optional model
  // request never finishes. The visible transcript is the critical path.
  const startupPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
  let releaseModels;
  try {
    await startupPage.addInitScript(() => {
      history.replaceState({ codexMobileView: 'thread', threadId: 'stability' }, '', location.href);
      window.setInterval = () => 0;
      window.EventSource = class { addEventListener() {} close() {} };
      window.IntersectionObserver = class { observe() {} disconnect() {} };
    });
    await startupPage.route('**/api/model-options', (route) => new Promise((resolve) => {
      releaseModels = async () => {
        await route.fulfill({ json: { models: [], thinking: [], modelThinking: {} } });
        resolve();
      };
    }));
    await startupPage.goto(`http://127.0.0.1:${server.address().port}/codex-mobile/`, { waitUntil: 'domcontentloaded' });
    await startupPage.waitForSelector('#messages [data-item-id]', { timeout: 3000 });
    assert.equal(typeof releaseModels, 'function');
    console.log(JSON.stringify({ restoredBeforeModelOptions: true }));
    await releaseModels();
    releaseModels = null;
  } finally {
    if (releaseModels) await releaseModels();
    await startupPage.close();
  }
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
