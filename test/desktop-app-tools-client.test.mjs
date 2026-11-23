import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DesktopAppToolsClient } from '../desktop-app-tools-client.mjs';
import { DesktopControlledAppServer } from '../desktop-controlled-app-server.mjs';
import { discoverDesktopAppToolsPipe } from '../desktop-app-tools-discovery.mjs';

function socketPath(label) {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\codex-mobile-${label}-${randomUUID()}`
    : path.join(os.tmpdir(), `codex-mobile-${label}-${randomUUID()}.sock`);
}

function frame(message) {
  const payload = Buffer.from(JSON.stringify(message));
  const output = Buffer.allocUnsafe(payload.length + 4);
  output.writeUInt32LE(payload.length, 0);
  payload.copy(output, 4);
  return output;
}

async function startMock(pipe, handler) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    socket.on('data', async (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (buffer.length < length + 4) return;
        const request = JSON.parse(buffer.subarray(4, length + 4).toString());
        buffer = buffer.subarray(length + 4);
        const result = await handler(request, socket);
        if (result !== undefined && !socket.destroyed) socket.write(frame({ jsonrpc: '2.0', id: request.id, result }));
      }
    });
  });
  server.testSockets = sockets;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipe, resolve);
  });
  return server;
}

async function stop(server) {
  for (const socket of server.testSockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
}

async function waitUntil(predicate) {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Reconnect test timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const tools = ['list_threads', 'list_projects', 'get_usage_limits', 'create_thread', 'read_thread', 'wait_threads', 'send_message_to_thread']
  .map((name) => ({ name, namespace: 'codex_app' }));

{
  let accepted = 0;
  const pipe = socketPath('required-source');
  const server = await startMock(pipe, (request, socket) => {
    if (request.method === 'tools/list') return { tools };
    if (request.params.callerSource !== 'codex') {
      socket.write(frame({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'Invalid app tool request' } }));
      return;
    }
    accepted++;
    return { ok: true };
  });
  const client = new DesktopAppToolsClient({ pipePath: pipe, contextThreadId: 'control-thread' });
  try {
    await assert.rejects(client.request('tools/call', { tool: 'list_projects', arguments: {} }), (error) => {
      assert.equal(error.code, -32602);
      assert.equal(error.publicCode, 'DESKTOP_TOOL_PROTOCOL_MISMATCH');
      assert.equal(error.statusCode, 502);
      assert.match(error.message, /无需接管/);
      return true;
    });
    assert.equal(accepted, 0, 'a schema rejection must not replay the call');
    assert.deepEqual(await client.listProjects(), { ok: true });
    assert.equal(accepted, 1);
  } finally {
    client.close();
    await stop(server);
  }
}

{
  const pipe = socketPath('basic');
  const requests = [];
  const server = await startMock(pipe, (request) => {
    requests.push(request);
    if (request.method === 'tools/list') return { tools };
    return { called: request.params.tool, args: request.params.arguments };
  });
  const client = new DesktopAppToolsClient({ pipePath: pipe, contextThreadId: 'control-thread', requestTimeoutMs: 500 });
  try {
    assert.deepEqual(await client.listThreads({ limit: 3 }), { called: 'list_threads', args: { limit: 3 } });
    assert.equal((await client.listProjects()).called, 'list_projects');
    assert.equal((await client.getUsageLimits()).called, 'get_usage_limits');
    assert.equal((await client.createThread({ prompt: 'new', target: { type: 'projectless' } })).called, 'create_thread');
    assert.equal((await client.readThread({ threadId: 't1', turnLimit: 2 })).called, 'read_thread');
    assert.equal((await client.waitThreads({ targets: [{ threadId: 't1' }], timeoutMs: 0 })).called, 'wait_threads');
    assert.equal((await client.sendMessageToThread({ threadId: 't1', prompt: 'hello' })).called, 'send_message_to_thread');
    assert.equal(requests.filter((request) => request.method === 'tools/list').length, 1, 'tools/list is cached');
    const call = requests.find((request) => request.params?.tool === 'send_message_to_thread');
    assert.equal(call.params.namespace, 'codex_app');
    assert.equal(call.params.threadId, 't1');
    for (const request of requests.filter((entry) => entry.method === 'tools/call')) {
      assert.equal(request.params.callerSource, 'codex', `${request.params.tool} must identify the local task source`);
      assert.equal(request.params.arguments.callerSource, undefined, 'source belongs to the envelope, not tool arguments');
    }
  } finally {
    client.close();
    await stop(server);
  }
}

{
  const firstPipe = socketPath('reconnect-a');
  const secondPipe = socketPath('reconnect-b');
  let discovered = firstPipe;
  let listCount = 0;
  const first = await startMock(firstPipe, (request, socket) => {
    if (request.method === 'tools/list') return { tools };
    socket.destroy();
    return undefined;
  });
  const client = new DesktopAppToolsClient({ discoverPipePath: async () => discovered, contextThreadId: 'control-thread', requestTimeoutMs: 500 });
  await assert.rejects(client.listThreads(), /closed|pipe/i);
  await stop(first);
  discovered = secondPipe;
  const second = await startMock(secondPipe, (request) => {
    if (request.method === 'tools/list') {
      listCount++;
      return { tools };
    }
    return { ok: true };
  });
  try {
    assert.deepEqual(await client.listThreads(), { ok: true });
    assert.equal(listCount, 1, 'tools are refreshed after reconnect');
  } finally {
    client.close();
    await stop(second);
  }
}

{
  const pipe = socketPath('limits');
  const server = await startMock(pipe, (request) => {
    if (request.method === 'slow') return new Promise(() => {});
    return { value: 'x'.repeat(256) };
  });
  const client = new DesktopAppToolsClient({ pipePath: pipe, requestTimeoutMs: 30, maxFrameBytes: 128 });
  try {
    await assert.rejects(client.request('large-request', { value: 'x'.repeat(256) }), /too large/);
    await assert.rejects(client.request('slow'), /timed out/);
    await assert.rejects(client.request('large-response'), /too large/);
  } finally {
    client.close();
    await stop(server);
  }
}

{
  // An endpoint may disappear after accepting a message. Recovery must restore
  // readiness with a fresh namespace, but must never replay that message.
  const firstPipe = socketPath('auto-a');
  const secondPipe = socketPath('auto-b');
  let currentPipe = firstPipe;
  const calls = [];
  const first = await startMock(firstPipe, (request, socket) => {
    calls.push(request);
    if (request.method === 'tools/list') return { tools };
    socket.destroy();
  });
  const client = new DesktopAppToolsClient({ discoverPipePath: async () => currentPipe, contextThreadId: 'control-thread' });
  const app = new DesktopControlledAppServer({ client, reconnectDelayMs: 20, maxReconnectDelayMs: 40, healthIntervalMs: 100 });
  const events = [];
  app.on('ready', () => events.push('ready'));
  app.on('exit', () => events.push('exit'));
  await app.start();
  assert.equal(app.ready, true);
  await assert.rejects(client.sendMessageToThread({ threadId: 't1', prompt: 'one message only' }), /closed|pipe/i);
  assert.equal(app.ready, false, 'socket disconnect immediately clears readiness');
  await stop(first);
  currentPipe = secondPipe;
  const second = await startMock(secondPipe, (request) => {
    calls.push(request);
    if (request.method === 'tools/list') return { tools: tools.map((tool) => ({ ...tool, namespace: 'new_desktop' })) };
    assert.equal(request.params.namespace, 'new_desktop');
    return { ok: true };
  });
  try {
    await waitUntil(() => app.ready);
    assert.deepEqual(events, ['ready', 'exit', 'ready']);
    assert.deepEqual(await client.listThreads(), { ok: true });
    assert.equal(calls.filter((request) => request.params?.tool === 'send_message_to_thread').length, 1);
  } finally {
    await app.stop();
    await stop(second);
  }
}

{
  // Cold start without Desktop must remain offline, then recover automatically.
  const pipe = socketPath('delayed-desktop');
  let discoveryCalls = 0;
  const client = new DesktopAppToolsClient({ discoverPipePath: async () => { discoveryCalls++; return pipe; } });
  const app = new DesktopControlledAppServer({ client, reconnectDelayMs: 10, maxReconnectDelayMs: 20, healthIntervalMs: 50 });
  await app.start();
  assert.equal(app.ready, false);
  const server = await startMock(pipe, () => ({ tools }));
  try {
    await waitUntil(() => app.ready);
    assert.ok(discoveryCalls >= 2);
  } finally {
    await app.stop();
    await stop(server);
  }
  const stoppedCalls = discoveryCalls;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(discoveryCalls, stoppedCalls, 'stop cancels background recovery');
}

{
  // A connected socket alone is insufficient if Desktop stops answering.
  const pipe = socketPath('silent-health');
  let responds = true;
  const server = await startMock(pipe, () => responds ? { tools } : undefined);
  const client = new DesktopAppToolsClient({ pipePath: pipe });
  const check = client.checkConnection.bind(client);
  client.checkConnection = () => check({ timeoutMs: 30 });
  const app = new DesktopControlledAppServer({ client, reconnectDelayMs: 10, maxReconnectDelayMs: 20, healthIntervalMs: 30 });
  try {
    await app.start();
    assert.equal(app.ready, true);
    responds = false;
    await waitUntil(() => !app.ready);
    responds = true;
    await waitUntil(() => app.ready);
  } finally {
    await app.stop();
    await stop(server);
  }
}

{
  // End-to-end recovery within the mock transport: one temporary health timeout
  // beside 36 browser contexts must retry control, without visiting a browser
  // pipe or submitting any tools/call. The discovered names are virtual only.
  const pipe = socketPath('dedicated-health-retry');
  const localAppData = 'C:\\Fixtures\\LocalAppData';
  const parent = { Name: 'ChatGPT.exe', ProcessId: 100, SessionId: 7, ExecutablePath: `${localAppData}\\OpenAI\\Codex\\ChatGPT.exe` };
  const child = {
    Name: 'codex.exe', ProcessId: 101, ParentProcessId: 100, SessionId: 7,
    ExecutablePath: `${localAppData}\\OpenAI\\Codex\\bin\\aabbcc\\codex.exe`, CommandLine: 'codex.exe app-server',
  };
  const dedicatedName = `codex-app-tools-${randomUUID()}`;
  const dedicatedPath = `\\\\.\\pipe\\${dedicatedName}`;
  const browserContexts = Array.from({ length: 36 }, () => ({ name: `codex-browser-use-${randomUUID()}`, ownerPid: 100 }));
  const discovered = [];
  const requests = [];
  let responds = true;
  const server = await startMock(pipe, (request) => {
    requests.push(request.method);
    return responds ? { tools } : undefined;
  });
  const client = new DesktopAppToolsClient({ discoverPipePath: async ({ excludePaths }) => {
    const selected = await discoverDesktopAppToolsPipe({
      platform: 'win32', env: {}, localAppData, sessionId: 7,
      excludePaths: excludePaths.map((value) => value === pipe ? dedicatedPath : value),
      queryProcesses: async () => ({ processes: [parent, child], pipes: [{ name: dedicatedName, ownerPid: 100 }, ...browserContexts] }),
    });
    discovered.push(selected);
    assert.equal(selected, dedicatedPath, 'a failed dedicated handshake must never select browser-use');
    return pipe;
  } });
  const check = client.checkConnection.bind(client);
  client.checkConnection = () => check({ timeoutMs: 30 });
  const app = new DesktopControlledAppServer({ client, reconnectDelayMs: 10, maxReconnectDelayMs: 20, healthIntervalMs: 30 });
  try {
    await app.start();
    assert.equal(app.ready, true);
    responds = false;
    await waitUntil(() => !app.ready);
    responds = true;
    await waitUntil(() => app.ready);
    assert.deepEqual(discovered, [dedicatedPath, dedicatedPath], 'recovery returns straight to the dedicated endpoint');
    assert.ok(requests.length >= 3 && requests.every((method) => method === 'tools/list'), 'recovery is read-only');
  } finally {
    await app.stop();
    await stop(server);
  }
}

{
  let releaseDiscovery;
  let connects = 0;
  const pipe = socketPath('closed-discovery');
  const server = await startMock(pipe, () => ({ tools }));
  server.on('connection', () => connects++);
  const client = new DesktopAppToolsClient({ discoverPipePath: () => new Promise((resolve) => { releaseDiscovery = resolve; }) });
  const connecting = client.connect();
  client.close();
  releaseDiscovery(pipe);
  await assert.rejects(connecting, /stopped/);
  assert.equal(connects, 0, 'closing during discovery must not open a new connection');
  await stop(server);
}

{
  const badPipe = socketPath('wrong-tools');
  const goodPipe = socketPath('right-tools');
  const bad = await startMock(badPipe, () => ({ tools: [{ name: 'unrelated_tool' }] }));
  const good = await startMock(goodPipe, () => ({ tools }));
  let sawRejected = false;
  const client = new DesktopAppToolsClient({ discoverPipePath: async ({ excludePaths }) => {
    if (excludePaths.includes(badPipe)) { sawRejected = true; return goodPipe; }
    return badPipe;
  } });
  const app = new DesktopControlledAppServer({ client, reconnectDelayMs: 10, maxReconnectDelayMs: 20 });
  try {
    await app.start();
    assert.equal(app.ready, false, 'a connected but incompatible endpoint is not ready');
    await waitUntil(() => app.ready);
    assert.ok(sawRejected, 'failed handshake candidate is passed back to discovery');
  } finally {
    await app.stop();
    await stop(bad);
    await stop(good);
  }
}

{
  // A long-lived Desktop may expose more than 32 endpoints. Retaining every
  // failed candidate lets discovery reach a working endpoint later in the list.
  const missing = Array.from({ length: 40 }, () => socketPath('missing-context'));
  const goodPipe = socketPath('many-contexts');
  const candidates = [...missing, goodPipe];
  const visited = [];
  const good = await startMock(goodPipe, () => ({ tools }));
  const client = new DesktopAppToolsClient({ discoverPipePath: async ({ excludePaths }) => {
    const selected = candidates.find((candidate) => !excludePaths.includes(candidate)) ?? candidates[0];
    visited.push(selected);
    return selected;
  } });
  try {
    for (const candidate of missing) await assert.rejects(client.checkConnection());
    await client.checkConnection();
    assert.equal(client.connected, true);
    assert.deepEqual(visited, candidates, 'failed early candidates must not repeat before later candidates are tried');
  } finally {
    client.close();
    await stop(good);
  }
}

console.log('desktop app tools client tests passed (including automatic rollover, offline startup, health timeout, no replay)');
