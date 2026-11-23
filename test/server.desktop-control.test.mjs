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
const controlThreadId = '00000000-0000-7000-8000-000000000001';

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

const modelSchema = {
  properties: {
    model: { description: 'Models: gpt-test (Test.; supported reasoning efforts: low, high).' },
    thinking: { enum: ['low', 'high'] },
  },
};
const tools = ['list_threads', 'list_projects', 'get_usage_limits', 'create_thread', 'read_thread', 'send_message_to_thread']
  .map((name) => ({
    name,
    namespace: 'codex_app',
    ...(['create_thread', 'send_message_to_thread'].includes(name) ? { inputSchema: modelSchema } : {}),
  }));
const calls = [];
let sentAt = 0;
let readAfterSendCount = 0;
let omitCompletedItems = false;
let rejectProjectsEnvelope = false;

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
  assert.equal(request.params.callerSource, 'codex', 'Desktop 26.924 requires callerSource for all tool calls');
  const { tool, arguments: args, namespace, threadId: contextThreadId } = request.params;
  calls.push({ tool, args, namespace, contextThreadId });
  assert.equal(namespace, 'codex_app');
  if (tool === 'list_threads') {
    assert.equal(contextThreadId, controlThreadId);
    return {
      pinnedThreads: [],
      threads: [{ id: threadId, title: 'Desktop controlled task', cwd: root, status: 'idle', updatedAt: 1 }],
    };
  }
  if (tool === 'list_projects') {
    return { projects: [{ projectId: 'project-1', name: 'Project one', isGitRepository: false }] };
  }
  if (tool === 'get_usage_limits') {
    return {
      rateLimitsByLimitId: {
        codex: {
          limitId: 'codex',
          planType: 'pro',
          primary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 2_000_000_000 },
          secondary: { usedPercent: null },
        },
      },
      rateLimitResetCredits: { availableCount: 1 },
      accountId: 'must-not-leak',
    };
  }
  if (tool === 'create_thread') {
    assert.equal(args.prompt, 'create integration task');
    assert.equal(args.model, 'gpt-test');
    assert.equal(args.thinking, 'high');
    assert.deepEqual(args.target, { type: 'project', projectId: 'project-1', environment: { type: 'local' } });
    return { threadId: 'created-desktop-thread', hostId: 'local' };
  }
  if (tool === 'read_thread') {
    assert.equal(contextThreadId, args.threadId);
    if (args.threadId === 'oversized-history') {
      if (args.includeOutputs && args.turnLimit > 1) return {
        success: true,
        contentItems: [{ type: 'inputText', text: 'Tool response exceeds the size limit. Request fewer turns or omit outputs.' }],
      };
      return {
        thread: { id: args.threadId, title: 'Large task', status: 'idle' },
        turns: [{ id: 'large-answer', status: 'completed', items: [{ type: 'agentMessage', text: 'LARGE_HISTORY_RECOVERED' }] }],
        page: { order: 'newest_first', nextCursor: 'large-older-page' },
      };
    }
    if (args.threadId === 'failed-history' && args.turnLimit > 1) throw new Error('History fixture unavailable');
    return {
      thread: { id: args.threadId, title: 'Desktop controlled task', cwd: root, status: sentAt ? 'active' : 'idle' },
      turns: args.threadId === threadId ? currentTurns() : [],
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
const mockSockets = new Set();
const mock = net.createServer((socket) => {
  mockSockets.add(socket);
  socket.on('close', () => mockSockets.delete(socket));
  socket.on('error', () => {});
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < length + 4) return;
      const request = JSON.parse(buffer.subarray(4, length + 4).toString());
      buffer = buffer.subarray(length + 4);
      try {
        if (rejectProjectsEnvelope && request.params?.tool === 'list_projects') {
          socket.write(frame({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'Invalid app tool request' } }));
          continue;
        }
        socket.write(frame({ jsonrpc: '2.0', id: request.id, result: toolResult(request) }));
      } catch (error) {
        socket.write(frame({ jsonrpc: '2.0', id: request.id, error: { code: -32_000, message: error.message } }));
      }
    }
  });
});

const uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-mobile-desktop-control-'));
const codexHome = path.join(uploadRoot, 'codex-home');
await fs.mkdir(codexHome, { recursive: true });
await fs.writeFile(path.join(codexHome, 'session_index.jsonl'), `${JSON.stringify({ id: controlThreadId })}\n`);
const bridgePort = await freePort();
const bridgeBaseUrl = `http://127.0.0.1:${bridgePort}`;
const childEnv = { ...process.env };
for (const key of [
  'CODEX_MOBILE_SECRET_FILE',
  'CODEX_MOBILE_APP_SERVER_URL',
  'CODEX_MOBILE_RPC_MUX_LISTEN_URL',
  'CODEX_MOBILE_SEEN_FILE',
  'CODEX_MOBILE_THREAD_LIST_CACHE_FILE',
  'CODEX_MOBILE_CONTROL_THREAD_ID',
  'CODEX_HOME',
]) delete childEnv[key];
Object.assign(childEnv, {
  CODEX_MOBILE_DESKTOP_CONTROL: '1',
  CODEX_MOBILE_APP_TOOLS_PIPE: mockPipe,
  CODEX_HOME: codexHome,
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

  await waitFor(bridgeBaseUrl, '/api/status', (body) => body.ready === false);
  await listen(mock, mockPipe);
  const status = await waitFor(bridgeBaseUrl, '/api/status', (body) => body.ready === true);
  assert.equal(status.appServerTransport, 'desktop-control');
  assert.equal(status.rpcMux, undefined);

  const unopened = await requestJson(`${bridgeBaseUrl}/api/threads/${threadId}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'not connected yet' }),
  });
  assert.equal(unopened.status, 409);
  assert.equal(unopened.body.code, 'THREAD_NOT_OPEN');
  assert.doesNotMatch(unopened.body.error, /接管/);
  assert.equal(calls.filter((call) => call.tool === 'send_message_to_thread').length, 0);

  const listed = await requestJson(`${bridgeBaseUrl}/api/threads?limit=20`);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.data[0].id, threadId);

  const projects = await requestJson(`${bridgeBaseUrl}/api/projects`);
  assert.equal(projects.status, 200);
  assert.equal(projects.body.data[0].projectId, 'project-1');

  rejectProjectsEnvelope = true;
  const invalidEnvelope = await requestJson(`${bridgeBaseUrl}/api/projects`);
  assert.equal(invalidEnvelope.status, 502);
  assert.equal(invalidEnvelope.body.code, 'DESKTOP_TOOL_PROTOCOL_MISMATCH');
  assert.match(invalidEnvelope.body.error, /无需接管/);
  rejectProjectsEnvelope = false;

  const modelOptions = await requestJson(`${bridgeBaseUrl}/api/model-options`);
  assert.deepEqual(modelOptions.body.models, ['gpt-test']);
  assert.deepEqual(modelOptions.body.modelThinking['gpt-test'], ['low', 'high']);

  const usage = await requestJson(`${bridgeBaseUrl}/api/usage`);
  assert.equal(usage.status, 200);
  assert.equal(usage.body.limits[0].primary.usedPercent, 12);
  assert.equal(usage.body.limits[0].primary.remainingPercent, 88);
  assert.equal(usage.body.limits[0].secondary.remainingPercent, null);
  assert.equal(usage.body.resetCredits.availableCount, 1);
  assert.equal('accountId' in usage.body, false);

  const largeHistory = await waitFor(bridgeBaseUrl, '/api/threads/oversized-history', (body) => (
    !body.thread.historyLoading && JSON.stringify(body).includes('LARGE_HISTORY_RECOVERED')
  ));
  assert.equal(largeHistory.thread.olderTurnsCursor, 'large-older-page');
  assert.ok(calls.some((call) => call.tool === 'read_thread' && call.args.threadId === 'oversized-history'
    && call.args.includeOutputs === false && call.args.turnLimit === 10));
  const failedHistory = await waitFor(bridgeBaseUrl, '/api/threads/failed-history', (body) => body.thread.historyError);
  assert.equal(failedHistory.thread.historyLoading, false, 'a cached history error must not turn back into an endless loading note');
  const failedReadCount = calls.filter((call) => call.tool === 'read_thread' && call.args.threadId === 'failed-history' && call.args.turnLimit > 1).length;
  await requestJson(`${bridgeBaseUrl}/api/threads/failed-history`);
  assert.equal(calls.filter((call) => call.tool === 'read_thread' && call.args.threadId === 'failed-history' && call.args.turnLimit > 1).length,
    failedReadCount, 'polling an unchanged failed snapshot does not continually reload it');

  const created = await requestJson(`${bridgeBaseUrl}/api/threads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: 'project-1', prompt: 'create integration task', model: 'gpt-test', thinking: 'high' }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.thread.id, 'created-desktop-thread');

  const resumed = await requestJson(`${bridgeBaseUrl}/api/threads/${threadId}/resume`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.thread.id, threadId);

  // A normal clipboard image must reach disk, rather than throwing before
  // reading the request body (for example due to an undefined timeout).
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const uploaded = await requestJson(`${bridgeBaseUrl}/api/threads/${threadId}/uploads`, {
    method: 'POST',
    headers: { 'content-type': 'image/png', 'x-codex-file-name': encodeURIComponent('clipboard-test.png') },
    body: png,
  });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
  assert.equal(uploaded.body.attachment.name, 'clipboard-test.png');
  assert.equal(uploaded.body.attachment.size, png.length);
  assert.equal(uploaded.body.attachment.isImage, true);
  const uploadFolders = await fs.readdir(uploadRoot, { withFileTypes: true });
  const storedFiles = [];
  for (const entry of uploadFolders) {
    if (!entry.isDirectory() || !/^[a-f0-9]{24}$/.test(entry.name)) continue;
    const directory = path.join(uploadRoot, entry.name);
    for (const filename of await fs.readdir(directory)) storedFiles.push(path.join(directory, filename));
  }
  assert.equal(storedFiles.length, 1);
  assert.deepEqual(await fs.readFile(storedFiles[0]), png);
  const removedUpload = await requestJson(`${bridgeBaseUrl}/api/uploads/${uploaded.body.attachment.id}`, { method: 'DELETE' });
  assert.equal(removedUpload.status, 200);

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
  const reconciled = await waitFor(bridgeBaseUrl, '/api/status', (body) => body.activeTurnId === null);
  assert.equal(reconciled.activeTurnId, null, 'completed Desktop-control history clears stale active turn state');
  omitCompletedItems = true;
  await delay(250);
  const refreshedThread = await requestJson(`${bridgeBaseUrl}/api/threads/${threadId}`);
  assert.equal(refreshedThread.status, 200);
  assert.match(JSON.stringify(refreshedThread.body), /DESKTOP_CONTROL_SERVER_OK/);
  assert.equal(calls.filter((call) => call.tool === 'send_message_to_thread').length, 1);
  assert.ok(calls.some((call) => call.tool === 'list_threads'));
  assert.ok(calls.some((call) => call.tool === 'read_thread'));

  // A Desktop restart must not bring down HTTP or leave ready=true, and a
  // rejected offline write must not be queued/replayed after recovery.
  const eventResponse = await fetch(`${bridgeBaseUrl}/events`);
  const eventReader = eventResponse.body.getReader();
  let events = '';
  const readingEvents = (async () => {
    while (true) {
      const { value, done } = await eventReader.read();
      if (done) return;
      events += new TextDecoder().decode(value);
    }
  })();
  for (const socket of mockSockets) socket.destroy();
  await new Promise((resolve) => mock.close(resolve));
  await waitFor(bridgeBaseUrl, '/api/status', (body) => body.ready === false);
  const offlineWrite = await requestJson(`${bridgeBaseUrl}/api/threads/${threadId}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'must not queue this offline message' }),
  });
  assert.equal(offlineWrite.status, 503);
  await listen(mock, mockPipe);
  await waitFor(bridgeBaseUrl, '/api/status', (body) => body.ready === true);
  assert.equal((await requestJson(`${bridgeBaseUrl}/api/projects`)).status, 200);
  assert.equal(calls.filter((call) => call.tool === 'send_message_to_thread').length, 1);
  await delay(50);
  assert.match(events, /"type":"appServerExit"/);
  assert.match(events, /"type":"appServerReady"/);
  await eventReader.cancel();
  await readingEvents;

  console.log(JSON.stringify({
    passed: true,
    transport: completed.appServerTransport,
    turnId,
    reply: 'DESKTOP_CONTROL_SERVER_OK',
    codexChildStarted: false,
    coldStartOfflineAndAutoRecovery: true,
    disconnectStatusAndSseRecovery: true,
    offlineMessageReplayed: false,
  }));
} finally {
  if (child && !child.killed) child.kill();
  if (child) await once(child, 'exit').catch(() => {});
  await new Promise((resolve) => mock.close(resolve));
  await fs.rm(uploadRoot, { recursive: true, force: true });
  if (process.platform !== 'win32') await fs.rm(mockPipe, { force: true }).catch(() => {});
}
