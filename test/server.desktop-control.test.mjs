import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverPath = path.join(root, 'server.mjs');
const threadId = 'desktop-control-test-thread';
const turnId = 'desktop-control-test-turn';

function pipePath() {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\codex-mobile-server-control-${randomUUID()}`
    : path.join(os.tmpdir(), `codex-mobile-server-control-${randomUUID()}.sock`);
}

function frame(message) {
  const payload = Buffer.from(JSON.stringify(message));
  const output = Buffer.allocUnsafe(payload.length + 4);
  output.writeUInt32LE(payload.length, 0);
  payload.copy(output, 4);
  return output;
}

async function listen(server, ...args) {
  server.listen(...args);
  await once(server, 'listening');
}

async function freePort() {
  const server = net.createServer();
  await listen(server, 0, '127.0.0.1');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

async function waitFor(baseUrl, pathName, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const response = await requestJson(`${baseUrl}${pathName}`);
      last = response;
      if (response.status === 200 && predicate(response.body)) return response.body;
    } catch {
      // The child bridge may still be starting.
    }
    await delay(30);
  }
  throw new Error(`Timed out waiting for ${pathName}: ${JSON.stringify(last)}`);
}

const tools = ['list_threads', 'read_thread', 'send_message_to_thread']
  .map((name) => ({ name, namespace: 'codex_app' }));
const calls = [];
let sentAt = 0;
let readAfterSendCount = 0;
let omitCompletedItems = false;

function currentTurns() {
  if (!sentAt) return [];
  readAfterSendCount += 1;
  const completed = readAfterSendCount >= 3;
  return [{
    id: turnId,
    status: completed ? 'completed' : 'inProgress',
    items: completed && !omitCompletedItems
      ? [{ id: 'answer', type: 'agentMessage', text: 'DESKTOP_CONTROL_SERVER_OK' }]
      : [],
  }];
}

function toolResult(request) {
  if (request.method === 'tools/list') return { tools };
  assert.equal(request.method, 'tools/call');
  const { tool, arguments: args, namespace, threadId: contextThreadId } = request.params;
  calls.push({ tool, args, namespace, contextThreadId });
  assert.equal(namespace, 'codex_app');
  if (tool === 'list_threads') {
    assert.equal(contextThreadId, 'control-thread');
    return {
      pinnedThreads: [],
      threads: [{ id: threadId, title: 'Desktop controlled task', cwd: root, status: 'idle', updatedAt: 1 }],
    };
  }
  if (tool === 'read_thread') {
    assert.equal(contextThreadId, threadId);
    assert.equal(args.threadId, threadId);
    return {
      thread: { id: threadId, title: 'Desktop controlled task', cwd: root, status: sentAt ? 'active' : 'idle' },
      turns: currentTurns(),
    };
  }
  if (tool === 'send_message_to_thread') {
    assert.equal(contextThreadId, threadId);
    assert.deepEqual(args, { threadId, prompt: 'desktop control integration test' });
    sentAt = Date.now();
    return { ok: true };
  }
  throw new Error(`Unexpected tool: ${tool}`);
}

const mockPipe = pipePath();
const mock = net.createServer((socket) => {
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < length + 4) return;
      const request = JSON.parse(buffer.subarray(4, length + 4).toString());
      buffer = buffer.subarray(length + 4);
      try {
        socket.write(frame({ jsonrpc: '2.0', id: request.id, result: toolResult(request) }));
      } catch (error) {
        socket.write(frame({ jsonrpc: '2.0', id: request.id, error: { code: -32_000, message: error.message } }));
      }
    }
  });
});
await listen(mock, mockPipe);

const uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-mobile-desktop-control-'));
const bridgePort = await freePort();
const bridgeBaseUrl = `http://127.0.0.1:${bridgePort}`;
const childEnv = { ...process.env };
for (const key of [
  'CODEX_MOBILE_SECRET_FILE',
  'CODEX_MOBILE_APP_SERVER_URL',
  'CODEX_MOBILE_RPC_MUX_LISTEN_URL',
  'CODEX_MOBILE_SEEN_FILE',
  'CODEX_MOBILE_THREAD_LIST_CACHE_FILE',
]) delete childEnv[key];
Object.assign(childEnv, {
  CODEX_MOBILE_DESKTOP_CONTROL: '1',
  CODEX_MOBILE_APP_TOOLS_PIPE: mockPipe,
  CODEX_MOBILE_CONTROL_THREAD_ID: 'control-thread',
  CODEX_MOBILE_HOST: '127.0.0.1',
  CODEX_MOBILE_PORT: String(bridgePort),
  CODEX_MOBILE_CODEX_PATH: path.join(uploadRoot, 'MUST-NOT-SPAWN-CODEX'),
  CODEX_MOBILE_UPLOAD_ROOT: uploadRoot,
});

let child = null;
let childOutput = '';
try {
  child = spawn(process.execPath, [serverPath], {
    cwd: root,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (chunk) => { childOutput += chunk.toString(); });
  child.stderr.on('data', (chunk) => { childOutput += chunk.toString(); });

  const status = await waitFor(bridgeBaseUrl, '/api/status', (body) => body.ready === true);
  assert.equal(status.appServerTransport, 'desktop-control');
  assert.equal(status.rpcMux, undefined);

  const listed = await requestJson(`${bridgeBaseUrl}/api/threads?limit=20`);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.data[0].id, threadId);

  const resumed = await requestJson(`${bridgeBaseUrl}/api/threads/${threadId}/resume`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.thread.id, threadId);

  const sent = await requestJson(`${bridgeBaseUrl}/api/threads/${threadId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'desktop control integration test' }),
  });
  assert.equal(sent.status, 202, `${JSON.stringify(sent.body)}; child=${childOutput}`);
  assert.equal(sent.body.turn.id, turnId);

  const completed = await waitFor(bridgeBaseUrl, '/api/status', (body) => (
    body.lastStartedTurnId === turnId
      && body.lastCompletedTurnId === turnId
      && body.activeTurnId === null
  ));
  assert.equal(completed.appServerTransport, 'desktop-control');

  const finalThread = await waitFor(bridgeBaseUrl, `/api/threads/${threadId}`, (body) => (
    JSON.stringify(body).includes('DESKTOP_CONTROL_SERVER_OK')
  ));
  assert.match(JSON.stringify(finalThread), /DESKTOP_CONTROL_SERVER_OK/);
  omitCompletedItems = true;
  await delay(250);
  const refreshedThread = await requestJson(`${bridgeBaseUrl}/api/threads/${threadId}`);
  assert.equal(refreshedThread.status, 200);
  assert.match(JSON.stringify(refreshedThread.body), /DESKTOP_CONTROL_SERVER_OK/);
  assert.equal(calls.filter((call) => call.tool === 'send_message_to_thread').length, 1);
  assert.ok(calls.some((call) => call.tool === 'list_threads'));
  assert.ok(calls.some((call) => call.tool === 'read_thread'));

  console.log(JSON.stringify({
    passed: true,
    transport: completed.appServerTransport,
    turnId,
    reply: 'DESKTOP_CONTROL_SERVER_OK',
    codexChildStarted: false,
  }));
} finally {
  if (child && !child.killed) child.kill();
  if (child) await once(child, 'exit').catch(() => {});
  await new Promise((resolve) => mock.close(resolve));
  await fs.rm(uploadRoot, { recursive: true, force: true });
  if (process.platform !== 'win32') await fs.rm(mockPipe, { force: true }).catch(() => {});
}
