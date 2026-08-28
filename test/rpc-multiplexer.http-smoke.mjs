import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const upstreamUrl = process.env.CODEX_MUX_TEST_UPSTREAM_URL;
if (!upstreamUrl) throw new Error('Set CODEX_MUX_TEST_UPSTREAM_URL to an isolated Codex App Server WebSocket');

const muxPort = Number(process.env.CODEX_MUX_TEST_LISTEN_PORT || 4613);
const bridgePort = Number(process.env.CODEX_MUX_TEST_HTTP_PORT || 4880);
const muxUrl = `ws://127.0.0.1:${muxPort}/`;
const baseUrl = `http://127.0.0.1:${bridgePort}`;
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

class DesktopPeer extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString());
      if (message.id != null && !message.method) {
        const pending = this.pending.get(String(message.id));
        if (!pending) return;
        this.pending.delete(String(message.id));
        if (message.error) pending.reject(new Error(message.error.message || 'Desktop RPC failed'));
        else pending.resolve(message.result);
        return;
      }
      this.emit('message', message);
    });
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(String(id), { resolve, reject });
      this.socket.send(JSON.stringify({ method, id, params }));
    });
  }
}

async function connectWithRetry(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    const socket = new WebSocket(url);
    try {
      await Promise.race([
        once(socket, 'open'),
        once(socket, 'error').then(([error]) => Promise.reject(error)),
      ]);
      return socket;
    } catch (error) {
      lastError = error;
      socket.close();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Timed out connecting to ${url}: ${lastError?.message || 'unknown error'}`);
}

async function fetchJson(pathname, options = {}, expectedStatus = 200) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const body = await response.json();
  assert.equal(response.status, expectedStatus, `${pathname}: ${JSON.stringify(body)}`);
  return body;
}

const bridge = spawn(process.execPath, ['server.mjs'], {
  cwd: repoRoot,
  env: {
    ...process.env,
    CODEX_MOBILE_APP_SERVER_URL: upstreamUrl,
    CODEX_MOBILE_RPC_MUX_LISTEN_URL: muxUrl,
    CODEX_MOBILE_HOST: '127.0.0.1',
    CODEX_MOBILE_PORT: String(bridgePort),
    CODEX_MOBILE_SECRET_FILE: '',
    CODEX_MOBILE_SEEN_FILE: '',
    CODEX_MOBILE_THREAD_LIST_CACHE_FILE: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bridgeOutput = '';
bridge.stdout.on('data', (chunk) => { bridgeOutput += chunk.toString(); });
bridge.stderr.on('data', (chunk) => { bridgeOutput += chunk.toString(); });

let desktopSocket;
try {
  const upstreamDeadline = Date.now() + 30_000;
  let upstreamReady = false;
  while (Date.now() < upstreamDeadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${muxPort}/readyz`);
      const body = await response.json();
      if (response.ok && body.upstreamConnected === true) {
        upstreamReady = true;
        break;
      }
    } catch {
      // The bridge or upstream connection may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!upstreamReady) throw new Error(`Mux upstream did not become ready. Output: ${bridgeOutput}`);
  desktopSocket = await connectWithRetry(muxUrl);
  const desktop = new DesktopPeer(desktopSocket);
  await desktop.request('initialize', {
    clientInfo: { name: 'codex-mobile-http-smoke', title: 'Codex Mobile HTTP Smoke', version: '1.0.0' },
    capabilities: { experimentalApi: true },
  });

  const httpDeadline = Date.now() + 30_000;
  let status;
  while (Date.now() < httpDeadline) {
    try {
      status = await fetchJson('/api/status');
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (!status) throw new Error(`HTTP bridge did not become ready. Output: ${bridgeOutput}`);
  assert.equal(status.appServerTransport, 'rpc-mux');
  assert.equal(status.rpcMux.upstreamConnected, true);
  assert.equal(status.rpcMux.desktopConnected, true);
  assert.equal(status.rpcMux.initialized, true);

  const started = await fetchJson('/api/threads', {
    method: 'POST',
    body: JSON.stringify({ ephemeral: true }),
  }, 201);
  const threadId = started.thread.id;
  assert.ok(threadId);
  const opened = await fetchJson(`/api/threads/${encodeURIComponent(threadId)}`);
  assert.equal(opened.thread.id, threadId);

  const completion = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for HTTP-started turn completion')), 180_000);
    const onMessage = (message) => {
      if (message.method !== 'turn/completed' || message.params?.threadId !== threadId) return;
      clearTimeout(timer);
      desktop.off('message', onMessage);
      resolve(message);
    };
    desktop.on('message', onMessage);
  });
  const message = await fetchJson(`/api/threads/${encodeURIComponent(threadId)}/messages`, {
    method: 'POST',
    body: JSON.stringify({ text: 'Reply exactly HTTP_MUX_OK. Do not call tools.' }),
  }, 202);
  assert.ok(message.turn?.id);
  const completed = await completion;
  assert.equal(completed.params?.turn?.id || completed.params?.turnId, message.turn.id);
  const completedStatus = await fetchJson('/api/status');
  assert.equal(completedStatus.lastStartedTurnId, message.turn.id);
  assert.equal(completedStatus.lastCompletedTurnId, message.turn.id);

  console.log(JSON.stringify({
    passed: true,
    threadId,
    turnId: message.turn.id,
    httpCreatedEphemeralThread: true,
    httpReadThread: true,
    httpStartedTurn: true,
    desktopObservedCompletion: true,
  }));
} finally {
  desktopSocket?.close(1000, 'HTTP smoke complete');
  bridge.kill('SIGTERM');
  await Promise.race([once(bridge, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (!bridge.killed) bridge.kill('SIGKILL');
}
