import assert from 'node:assert/strict';
import fs from 'node:fs';

const stylesheet = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
assert.match(stylesheet, /\.messages-shell\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;/);
assert.match(stylesheet, /\.messages\s*\{[^}]*max-width:\s*100%;[^}]*min-width:\s*0;/);

class FakeClassList {
  constructor(node) {
    this.node = node;
    this.values = new Set();
  }

  sync() {
    String(this.node.className || '').split(/\s+/).filter(Boolean).forEach((value) => this.values.add(value));
  }

  add(...values) {
    this.sync();
    values.forEach((value) => this.values.add(value));
    this.node.className = [...this.values].join(' ');
  }

  remove(...values) {
    this.sync();
    values.forEach((value) => this.values.delete(value));
    this.node.className = [...this.values].join(' ');
  }

  toggle(value, force) {
    this.sync();
    const enabled = force == null ? !this.values.has(value) : Boolean(force);
    if (enabled) this.values.add(value);
    else this.values.delete(value);
    this.node.className = [...this.values].join(' ');
    return enabled;
  }

  contains(value) {
    this.sync();
    return this.values.has(value);
  }
}

class FakeNode {
  constructor(tagName = '', text = '') {
    this.tagName = tagName.toUpperCase();
    this.nodeText = text;
    this.children = [];
    this.dataset = {};
    this.className = '';
    this.classList = new FakeClassList(this);
    this.value = '';
    this.scrollTop = 0;
    this.clientHeight = 120;
  }

  append(...nodes) {
    for (const value of nodes) {
      const node = typeof value === 'string' ? new FakeNode('', value) : value;
      if (node.parentNode && node.parentNode !== this) {
        node.parentNode.children = node.parentNode.children.filter((child) => child !== node);
      }
      node.parentNode = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes) {
    this.children = [];
    this.nodeText = '';
    this.append(...nodes);
  }

  addEventListener() {}
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
  }
  replaceWith(node) {
    if (!this.parentNode) return;
    const parent = this.parentNode;
    const index = parent.children.indexOf(this);
    if (node.parentNode && node.parentNode !== parent) {
      node.parentNode.children = node.parentNode.children.filter((child) => child !== node);
    }
    parent.children[index] = node;
    node.parentNode = parent;
    this.parentNode = null;
  }
  after(...nodes) {
    if (!this.parentNode) return;
    const parent = this.parentNode;
    let index = parent.children.indexOf(this) + 1;
    for (const value of nodes) {
      const node = typeof value === 'string' ? new FakeNode('', value) : value;
      if (node.parentNode) node.parentNode.children = node.parentNode.children.filter((child) => child !== node);
      node.parentNode = parent;
      parent.children.splice(index++, 0, node);
    }
  }
  setAttribute(name, value) { this[name] = String(value); }
  removeAttribute(name) { delete this[name]; }
  focus() {}

  querySelector(selector) {
    const parts = selector.trim().split(/\s+/);
    const matches = (node, part) => {
      if (part.startsWith('.')) return String(node.className || '').split(/\s+/).includes(part.slice(1));
      const itemIdMatch = part.match(/^\[data-item-id="(.*)"\]$/);
      if (itemIdMatch) return String(node.dataset.itemId || '') === itemIdMatch[1];
      return node.tagName === part.toUpperCase();
    };
    const descendants = (node) => node.children.flatMap((child) => [child, ...descendants(child)]);
    let candidates = descendants(this).filter((node) => matches(node, parts[0]));
    for (const part of parts.slice(1)) {
      candidates = candidates.flatMap((node) => descendants(node).filter((child) => matches(child, part)));
    }
    return candidates[0] || null;
  }

  get childElementCount() {
    return this.children.filter((child) => child.tagName).length;
  }

  get lastElementChild() {
    return [...this.children].reverse().find((child) => child.tagName) || null;
  }

  get scrollHeight() {
    return (1 + allDescendants(this).length) * 40;
  }

  get textContent() {
    return this.nodeText + this.children.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    this.nodeText = String(value || '');
    this.children = [];
  }
}

const queriedNodes = new Map();
const allDescendants = (node) => (node?.children || []).flatMap((child) => [child, ...allDescendants(child)]);
globalThis.document = {
  visibilityState: 'visible',
  hidden: false,
  body: new FakeNode('body'),
  querySelector(selector) {
    if (!queriedNodes.has(selector)) queriedNodes.set(selector, new FakeNode('div'));
    return queriedNodes.get(selector);
  },
  createElement(tagName) { return new FakeNode(tagName); },
  createTextNode(text) { return new FakeNode('', String(text)); },
  addEventListener() {},
};
const windowListeners = new Map();
globalThis.window = {
  location: { href: 'https://example.test/codex-mobile/' },
  addEventListener(type, listener) {
    if (!windowListeners.has(type)) windowListeners.set(type, []);
    windowListeners.get(type).push(listener);
  },
};
globalThis.location = globalThis.window.location;
globalThis.history = {
  state: null,
  stack: [null],
  index: 0,
  replaceState(state) { this.state = state; this.stack[this.index] = state; },
  pushState(state) { this.state = state; this.stack = this.stack.slice(0, this.index + 1); this.stack.push(state); this.index += 1; },
  back() {
    if (this.index === 0) return;
    this.index -= 1;
    this.state = this.stack[this.index];
    for (const listener of windowListeners.get('popstate') || []) listener({ state: this.state });
  },
};
globalThis.sessionStorage = { getItem() { return null; }, setItem() {} };
globalThis.requestAnimationFrame = (callback) => callback();
globalThis.CSS = { escape: (value) => String(value) };
globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: 'test' }) });

const { renderMarkdown, renderMessageImages, renderArtifacts, clipboardImageFiles, prepareClipboardImages, updateLiveToolGroup, openThread, handleEvent, syncComposerState, loadOlderTurns, updateJumpBottom, scrollBottom, isThreadNotFoundMessage, clearStaleThreadNotFoundNotice, state } = await import('../public/app.js');
assert.equal(history.state.codexMobileView, 'list');
await openThread('thread-navigation-test');
assert.equal(history.state.codexMobileView, 'thread');
assert.ok(document.body.classList.contains('thread-open'));
history.back();
assert.equal(history.state.codexMobileView, 'list');
assert.ok(!document.body.classList.contains('thread-open'));

state.activeThread = { id: 'jump-bottom-test' };
const messagePane = document.querySelector('#messages');
const jumpBottom = document.querySelector('#jump-bottom');
messagePane.replaceChildren(...Array.from({ length: 8 }, () => new FakeNode('div')));
messagePane.clientHeight = 120;
messagePane.scrollTop = 0;
updateJumpBottom();
assert.equal(state.followLatest, false);
assert.ok(!jumpBottom.classList.contains('hidden'));
scrollBottom({ force: true });
assert.equal(state.followLatest, true);
assert.ok(jumpBottom.classList.contains('hidden'));
messagePane.replaceChildren();

const notice = document.querySelector('#notice');
notice.textContent = 'thread not found: synthetic-thread';
notice.classList.remove('hidden');
assert.equal(isThreadNotFoundMessage(notice.textContent), true);
clearStaleThreadNotFoundNotice();
assert.equal(notice.textContent, '');
assert.ok(notice.classList.contains('hidden'));

const root = new FakeNode('div');
const source = [
  '已经完成，约 **0.58–0.66 秒**。&#x20;',
  '',
  '- 第一项含 `inline code`',
  '- 第二项含 [网页](https://example.com/docs) 与 [summary.json](<C:/workspace/summary.json>)',
  '- 文件 :codex-file-citation{path="C:\\workspace\\{test}\\report.pdf" purpose="source"}',
  '',
  '> 引用内容',
  '',
  '| 状态 | 耗时 |',
  '| --- | ---: |',
  '| 暖缓存 | 8ms |',
  '',
  '```txt',
  '&lt;img src=x onerror=alert(1)&gt;',
  '```',
  '',
  '[不安全链接](javascript:alert(1))',
].join('\n');

renderMarkdown(root, source);

const all = [];
const visit = (node) => {
  all.push(node);
  node.children.forEach(visit);
};
visit(root);
const tags = (name) => all.filter((node) => node.tagName === name);

assert.equal(tags('UL').length, 1);
assert.equal(tags('LI').length, 3);
assert.equal(tags('STRONG').length, 1);
assert.equal(tags('BLOCKQUOTE').length, 1);
assert.equal(tags('TABLE').length, 1);
assert.equal(tags('PRE').length, 1);
assert.equal(tags('IMG').length, 0);
assert.equal(tags('A').length, 1);
assert.equal(tags('A')[0].href, 'https://example.com/docs');
assert.equal(all.filter((node) => node.className === 'local-reference').length, 2);
assert.ok(root.textContent.includes('<img src=x onerror=alert(1)>'));
assert.ok(!root.textContent.includes('&#x20;'));
assert.ok(!root.textContent.includes('**'));
assert.ok(!root.textContent.includes('[summary.json]'));
assert.equal(all.filter((node) => node.className === 'file-citation').length, 1);
assert.ok(root.textContent.includes('PDFreport.pdf'));
assert.ok(!root.textContent.includes('codex-file-citation'));
assert.ok(!root.textContent.includes('C:\\workspace\\{test}'));
assert.ok(!root.textContent.includes('secret'));

const deepRoot = new FakeNode('div');
renderMarkdown(deepRoot, `${'>'.repeat(10_000)} nested`);
const deepNodes = [];
const visitDeep = (node) => {
  deepNodes.push(node);
  node.children.forEach(visitDeep);
};
visitDeep(deepRoot);
assert.ok(deepNodes.filter((node) => node.tagName === 'BLOCKQUOTE').length <= 16);

const manyTokensRoot = new FakeNode('div');
const tokenStart = performance.now();
renderMarkdown(manyTokensRoot, Array.from({ length: 5_000 }, () => '*x*').join(' '));
const tokenMilliseconds = Math.round(performance.now() - tokenStart);
assert.ok(tokenMilliseconds < 2_000);

const oversizedRoot = new FakeNode('div');
const oversizedSource = `**${'x'.repeat(70_000)}`;
const oversizedStart = performance.now();
renderMarkdown(oversizedRoot, oversizedSource);
const oversizedMilliseconds = Math.round(performance.now() - oversizedStart);
assert.equal(oversizedRoot.textContent, oversizedSource);
assert.equal(oversizedRoot.children.length, 0);

const imageRoot = new FakeNode('div');
renderMessageImages(imageRoot, [{ name: 'sample.jpg', url: 'api/images/opaque-token', mimeType: 'image/jpeg' }]);
const imageGallery = imageRoot.children[0];
assert.equal(imageGallery.className, 'message-images single');
assert.equal(imageGallery.children[0].className, 'message-image-button');
assert.equal(imageGallery.children[0].children[0].tagName, 'IMG');
assert.equal(imageGallery.children[0].children[0].src, 'api/images/opaque-token');
assert.equal(imageGallery.children[0].children[0].loading, 'lazy');

const artifactRoot = new FakeNode('div');
renderArtifacts(artifactRoot, [{
  name: 'report.pdf',
  extension: 'PDF',
  mimeType: 'application/pdf',
  size: 1_572_864,
  previewable: true,
  previewUrl: 'api/artifacts/opaque-preview-token',
  downloadUrl: 'api/artifacts/opaque-preview-token?download=1',
}]);
assert.equal(artifactRoot.querySelector('.artifact-type').textContent, 'PDF');
assert.equal(artifactRoot.querySelector('.artifact-info strong').textContent, 'report.pdf');
assert.ok(artifactRoot.textContent.includes('1.5 MB'));
assert.equal(allDescendants(artifactRoot).filter((node) => node.className === 'artifact-action').length, 1);
assert.equal(allDescendants(artifactRoot).filter((node) => String(node.className).includes('primary-link')).length, 1);

const clipboardPng = { name: 'image.png', type: 'image/png', size: 128, lastModified: 42 };
const duplicateClipboardPng = { name: 'image.png', type: 'image/png', size: 128, lastModified: 42 };
const clipboardImages = clipboardImageFiles({
  clipboardData: {
    items: [
      { kind: 'string', type: 'text/plain', getAsFile: () => null },
      { kind: 'file', type: 'image/png', getAsFile: () => clipboardPng },
    ],
    files: [duplicateClipboardPng],
  },
});
assert.deepEqual(clipboardImages, [clipboardPng]);
if (typeof File === 'function') {
  const duplicateContent = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
  const preparedClipboardImages = await prepareClipboardImages([
    new File([duplicateContent], 'browser-copy-a.png', { type: 'image/png', lastModified: 1 }),
    new File([duplicateContent], 'browser-copy-b.png', { type: 'image/png', lastModified: 2 }),
  ]);
  assert.equal(preparedClipboardImages.length, 1);
  assert.ok(!preparedClipboardImages[0].name.includes('-1.'));
}

updateLiveToolGroup({ id: 'tool-1', type: 'commandExecution', status: 'inProgress', preview: 'echo hello' }, 'turn-1', 5);
updateLiveToolGroup({ id: 'tool-1', type: 'commandExecution', status: 'completed', preview: 'echo hello' }, 'turn-1', 11);
const liveGroup = queriedNodes.get('#messages').children.at(-1);
assert.ok(!liveGroup.querySelector('.tool-details').open);
assert.equal(liveGroup.querySelector('.tool-chevron').textContent, '展开');
assert.equal(liveGroup.querySelector('.live-tool-previews').childElementCount, 1);
assert.equal(liveGroup.querySelector('.tool-summary-text strong').textContent, '1 项工具活动');
assert.equal(liveGroup.querySelector('.tool-status').textContent, '已完成');
assert.equal(liveGroup.querySelector('.live-tool-preview-detail').textContent, 'echo hello');
const liveToolRows = liveGroup.querySelector('.live-tool-previews').childElementCount;

state.activeThread = { id: 'thread-snapshot-test' };
state.activeTurnId = 'turn-snapshot-test';
state.activeTurnThreadId = 'thread-snapshot-test';
const streamingPrefixNode = new FakeNode('div');
streamingPrefixNode.className = 'message agent streaming';
streamingPrefixNode.dataset.itemId = 'stream-prefix';
streamingPrefixNode._rawText = '世界';
streamingPrefixNode._liveChunks = [{ sequence: 5, text: '世界' }];
const streamingPrefixContent = new FakeNode('div');
streamingPrefixContent.className = 'content markdown';
streamingPrefixContent.textContent = '世界';
streamingPrefixNode.append(streamingPrefixContent);
state.streaming.set('stream-prefix', streamingPrefixNode);
queriedNodes.get('#messages').replaceChildren(liveGroup, streamingPrefixNode);
updateLiveToolGroup({ id: 'tool-between-snapshot-and-delivery', type: 'commandExecution', status: 'inProgress', preview: 'newer tool' }, 'turn-1', 12);
handleEvent({
  type: 'threadSnapshot',
  thread: {
    id: 'thread-snapshot-test',
    eventSequence: 10,
    turns: [{
      id: 'history-turn',
      items: [
        { id: 'history-agent', type: 'agentMessage', text: '历史已经显示' },
        { id: 'stream-prefix', type: 'agentMessage', text: '你好，世界' },
        { id: 'tool-group-turn-1', type: 'toolGroup', turnId: 'turn-1', count: 1, status: 'inProgress', hasDetails: true, toolItems: [{ id: 'tool-1', status: 'inProgress' }] },
      ],
    }],
  },
});
assert.equal(state.deferredThreadSnapshot, null);
assert.equal(state.activeThread.turns.length, 1);
assert.ok(queriedNodes.get('#messages').querySelector('[data-item-id="history-agent"]'));
const adoptedLiveGroup = state.liveToolGroups.get('turn-1').node;
assert.equal(queriedNodes.get('#messages').querySelector('[data-item-id="tool-group-turn-1"]'), adoptedLiveGroup);
assert.equal(allDescendants(queriedNodes.get('#messages')).filter((node) => node.dataset.itemId === 'tool-group-turn-1').length, 1);
assert.equal(adoptedLiveGroup.querySelector('.tool-summary-text strong').textContent, '2 项工具活动');
assert.equal(state.streaming.get('stream-prefix').querySelector('.content').textContent, '你好，世界');
handleEvent({ type: 'notification', method: 'item/agentMessage/delta', sequence: 11, params: { threadId: 'thread-snapshot-test', turnId: 'turn-snapshot-test', itemId: 'stream-prefix', delta: '！' } });
assert.equal(state.streaming.get('stream-prefix').querySelector('.content').textContent, '你好，世界！');
handleEvent({ type: 'notification', method: 'item/completed', sequence: 12, params: { threadId: 'thread-snapshot-test', turnId: 'turn-snapshot-test', item: { id: 'stream-prefix', type: 'agentMessage', text: '你好，世界！最终' } } });
handleEvent({
  type: 'threadSnapshot',
  thread: {
    id: 'thread-snapshot-test',
    eventSequence: 11,
    turns: [{
      id: 'history-turn',
      items: [
        { id: 'stream-prefix', type: 'agentMessage', text: '你好，世界！' },
        { id: 'tool-group-turn-1', type: 'toolGroup', turnId: 'turn-1', count: 1, status: 'completed', hasDetails: true, toolItems: [{ id: 'tool-1', status: 'completed' }] },
      ],
    }],
  },
});
assert.equal(queriedNodes.get('#messages').querySelector('[data-item-id="stream-prefix"]').querySelector('.content').textContent, '你好，世界！最终');
assert.equal(allDescendants(queriedNodes.get('#messages')).filter((node) => node.dataset.itemId === 'tool-group-turn-1').length, 1);
updateLiveToolGroup({ id: 'tool-1', type: 'commandExecution', status: 'completed', preview: 'snapshot 后仍可更新' }, 'turn-1', 13);
assert.equal(state.liveToolGroups.get('turn-1').node.querySelector('.live-tool-preview-detail').textContent, 'snapshot 后仍可更新');
handleEvent({ type: 'notification', method: 'turn/completed', params: { threadId: 'thread-snapshot-test', turnId: 'turn-snapshot-test' } });
assert.equal(state.activeTurnId, null);
assert.equal(state.activeTurnThreadId, null);
assert.equal(state.deferredThreadSnapshot, null);
assert.equal(state.activeThread.id, 'thread-snapshot-test');

state.activeThread = { id: 'thread-history-pager', turns: [] };
state.activeTurnId = null;
state.activeTurnThreadId = null;
queriedNodes.get('#messages').replaceChildren();
handleEvent({
  type: 'threadSnapshot',
  thread: {
    id: 'thread-history-pager',
    eventSequence: 20,
    hasOlderTurns: true,
    olderTurnsCursor: 'cursor-page-2',
    turns: [{ id: 'recent-turn', items: [{ id: 'recent-agent', type: 'agentMessage', text: '最近一页' }] }],
  },
});
globalThis.fetch = async (url) => ({
  ok: true,
  status: 200,
  json: async () => String(url).includes('/turns?')
    ? {
        turns: [{ id: 'older-turn', items: [{ id: 'older-agent', type: 'agentMessage', text: '更早一页' }] }],
        olderTurnsCursor: 'cursor-page-3',
        hasOlderTurns: true,
      }
    : {},
});
await loadOlderTurns();
const pagerChildren = queriedNodes.get('#messages').children;
assert.equal(pagerChildren[0].className, 'history-pager history-note');
assert.equal(pagerChildren[1].dataset.turnId, 'older-turn');
assert.equal(pagerChildren[2].dataset.turnId, 'recent-turn');
assert.equal(state.activeThread.turns.map((turn) => turn.id).join(','), 'older-turn,recent-turn');
assert.ok(queriedNodes.get('#messages').querySelector('[data-item-id="older-agent"]'));

state.activeThread = { id: 'thread-snapshot-first', turns: [] };
state.activeTurnId = 'turn-snapshot-first';
state.activeTurnThreadId = 'thread-snapshot-first';
queriedNodes.get('#messages').replaceChildren();
handleEvent({
  type: 'threadSnapshot',
  thread: {
    id: 'thread-snapshot-first',
    eventSequence: 10,
    turns: [{ id: 'turn-snapshot-first', items: [{ id: 'tool-group-turn-snapshot-first', type: 'toolGroup', turnId: 'turn-snapshot-first', count: 2, status: 'inProgress', hasDetails: true, toolItems: [{ id: 'base-tool-a', status: 'completed' }, { id: 'base-tool-b', status: 'inProgress' }] }] }],
  },
});
updateLiveToolGroup({ id: 'base-tool-b', type: 'commandExecution', status: 'completed', preview: 'base tool completed' }, 'turn-snapshot-first', 11);
assert.equal(queriedNodes.get('#messages').querySelector('[data-item-id="tool-group-turn-snapshot-first"]').querySelector('.tool-summary-text strong').textContent, '2 项工具活动');
assert.equal(queriedNodes.get('#messages').querySelector('[data-item-id="tool-group-turn-snapshot-first"]').querySelector('.tool-status').textContent, '已完成');
updateLiveToolGroup({ id: 'tool-after-snapshot', type: 'commandExecution', status: 'inProgress', preview: 'new tool' }, 'turn-snapshot-first', 12);
assert.equal(allDescendants(queriedNodes.get('#messages')).filter((node) => node.dataset.itemId === 'tool-group-turn-snapshot-first').length, 1);
assert.equal(queriedNodes.get('#messages').querySelector('[data-item-id="tool-group-turn-snapshot-first"]').querySelector('.tool-summary-text strong').textContent, '3 项工具活动');
handleEvent({ type: 'notification', method: 'turn/completed', params: { threadId: 'thread-snapshot-first', turnId: 'turn-snapshot-first' } });

state.activeThread = { id: 'thread-bounded-tools', turns: [] };
state.activeTurnId = 'turn-bounded-tools';
state.activeTurnThreadId = 'thread-bounded-tools';
queriedNodes.get('#messages').replaceChildren();
handleEvent({
  type: 'threadSnapshot',
  thread: {
    id: 'thread-bounded-tools',
    eventSequence: 20,
    turns: [{ id: 'turn-bounded-tools', items: [{
      id: 'tool-group-turn-bounded-tools',
      type: 'toolGroup',
      turnId: 'turn-bounded-tools',
      count: 300,
      status: 'inProgress',
      hasDetails: true,
      toolItems: [{ id: 'known-running-tool', status: 'inProgress' }],
      toolItemsComplete: false,
    }] }],
  },
});
updateLiveToolGroup({ id: 'unknown-completed-tool', type: 'commandExecution', status: 'completed', preview: 'unknown base tool' }, 'turn-bounded-tools', 21);
assert.equal(queriedNodes.get('#messages').querySelector('[data-item-id="tool-group-turn-bounded-tools"]').querySelector('.tool-summary-text strong').textContent, '300+ 项工具活动');
updateLiveToolGroup({ id: 'new-running-tool', type: 'commandExecution', status: 'inProgress', preview: 'new tool' }, 'turn-bounded-tools', 22);
assert.equal(queriedNodes.get('#messages').querySelector('[data-item-id="tool-group-turn-bounded-tools"]').querySelector('.tool-summary-text strong').textContent, '301+ 项工具活动');
handleEvent({ type: 'notification', method: 'turn/completed', params: { threadId: 'thread-bounded-tools', turnId: 'turn-bounded-tools' } });
state.activeThread = null;
state.activeTurnId = 'turn-background-test';
state.activeTurnThreadId = 'thread-background-test';
handleEvent({ type: 'notification', method: 'turn/completed', params: { threadId: 'thread-background-test', turnId: 'turn-background-test' } });
assert.equal(state.activeTurnId, null);
assert.equal(state.activeTurnThreadId, null);

state.activeThread = { id: 'thread-composer-test' };
state.activeTurnId = 'turn-composer-test';
state.activeTurnThreadId = 'thread-composer-test';
syncComposerState();
assert.equal(queriedNodes.get('#prompt').disabled, false);
assert.equal(queriedNodes.get('#send').textContent, '追加');
assert.ok(!queriedNodes.get('#stop').classList.contains('hidden'));
assert.ok(!queriedNodes.get('#turn-activity').classList.contains('hidden'));
assert.equal(queriedNodes.get('#turn-activity-text').textContent, 'Codex 正在思考…');
handleEvent({
  type: 'serverRequest',
  request: {
    id: 'dynamic-request-test',
    method: 'item/tool/call',
    threadId: 'thread-composer-test',
    namespace: 'codex_app',
    tool: 'read_thread',
    availableDecisions: [],
  },
});
assert.ok(queriedNodes.get('#approvals').textContent.includes('codex_app/read_thread'));
assert.ok(queriedNodes.get('#approvals').textContent.includes('手机端无需操作'));
assert.equal(queriedNodes.get('#turn-activity-text').textContent, 'Codex 正在等待工具结果…');
handleEvent({ type: 'serverRequestsPruned', requestIds: ['dynamic-request-test'] });
assert.equal(queriedNodes.get('#approvals').childElementCount, 0);
assert.equal(queriedNodes.get('#turn-activity-text').textContent, 'Codex 正在思考…');
handleEvent({
  type: 'serverRequest',
  request: {
    id: 'user-input-request-test',
    method: 'item/tool/requestUserInput',
    threadId: 'thread-composer-test',
    questions: [{
      id: 'scope',
      header: '范围',
      question: '这次处理哪部分？',
      isOther: true,
      isSecret: false,
      options: [{ label: '最近记录', description: '只处理最近一页' }],
    }],
    availableDecisions: [],
  },
});
assert.ok(queriedNodes.get('#approvals').textContent.includes('Codex 需要你的回答'));
assert.ok(queriedNodes.get('#approvals').textContent.includes('这次处理哪部分？'));
assert.ok(queriedNodes.get('#approvals').textContent.includes('最近记录'));
assert.equal(queriedNodes.get('#requests-badge').textContent, '1');
assert.equal(queriedNodes.get('#turn-activity-text').textContent, 'Codex 正在等待你的确认…');
handleEvent({ type: 'serverRequestsPruned', requestIds: ['user-input-request-test'] });
assert.equal(queriedNodes.get('#requests-badge').textContent, '0');
state.toolAlerts.set('failed-tool-test', {
  id: 'failed-tool-test',
  threadId: 'thread-composer-test',
  title: '命令',
  preview: '测试命令失败',
});
handleEvent({ type: 'serverRequestsPruned', requestIds: [] });
assert.ok(queriedNodes.get('#approvals').textContent.includes('工具失败：命令'));
assert.equal(queriedNodes.get('#requests-badge').textContent, '1');
state.toolAlerts.clear();
handleEvent({ type: 'serverRequestsPruned', requestIds: [] });
assert.equal(queriedNodes.get('#requests-badge').textContent, '0');
handleEvent({
  type: 'notification',
  method: 'item/started',
  params: {
    threadId: 'thread-composer-test',
    turnId: 'turn-composer-test',
    item: { id: 'tool-composer-test', type: 'commandExecution', status: 'inProgress', preview: 'pwsh.exe' },
  },
});
assert.equal(queriedNodes.get('#turn-activity-text').textContent, 'Codex 正在使用工具…');
handleEvent({
  type: 'notification',
  method: 'item/completed',
  params: {
    threadId: 'thread-composer-test',
    turnId: 'turn-composer-test',
    item: { id: 'tool-composer-test', type: 'commandExecution', status: 'completed', preview: 'pwsh.exe' },
  },
});
assert.equal(queriedNodes.get('#turn-activity-text').textContent, 'Codex 正在思考…');
handleEvent({ type: 'threadDeleted', threadId: 'thread-composer-test' });
assert.equal(state.activeThread, null);
assert.equal(state.activeTurnId, null);
assert.equal(state.activeTurnThreadId, null);
assert.equal(history.state.codexMobileView, 'list');
assert.ok(!document.body.classList.contains('thread-open'));
assert.ok(queriedNodes.get('#turn-activity').classList.contains('hidden'));

console.log(JSON.stringify({
  passed: true,
  listItems: tags('LI').length,
  strongNodes: tags('STRONG').length,
  tables: tags('TABLE').length,
  codeBlocks: tags('PRE').length,
  externalLinks: tags('A').length,
  localReferences: all.filter((node) => node.className === 'local-reference').length,
  fileCitations: all.filter((node) => node.className === 'file-citation').length,
  rawEntityVisible: root.textContent.includes('&#x20;'),
  executableHtmlNodes: tags('IMG').length,
  deepQuoteNodes: deepNodes.filter((node) => node.tagName === 'BLOCKQUOTE').length,
  fiveThousandInlineTokensMilliseconds: tokenMilliseconds,
  oversizedPlainTextMilliseconds: oversizedMilliseconds,
  imageGalleryNodes: imageGallery.childElementCount,
  liveToolRows,
  busyComposerEditable: !queriedNodes.get('#prompt').disabled,
  turnActivityLifecycle: true,
  dynamicRequestLifecycle: true,
}, null, 2));
process.exit(0);
