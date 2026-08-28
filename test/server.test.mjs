import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverPath = path.join(root, 'server.mjs');

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function freePort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendJson(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function waitForSocketMessage(socket, predicate, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error('Timed out waiting for WebSocket message'));
    }, timeoutMs);
    const onMessage = (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!predicate(message)) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(message);
    };
    socket.on('message', onMessage);
  });
}

async function connectWebSocket(url, timeoutMs = 2_000) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error(`Timed out connecting to ${url}`));
    }, timeoutMs);
    const onOpen = () => {
      clearTimeout(timer);
      socket.off('error', onError);
      resolve();
    };
    const onError = (error) => {
      clearTimeout(timer);
      socket.off('open', onOpen);
      reject(error);
    };
    socket.once('open', onOpen);
    socket.once('error', onError);
  });
  return socket;
}

async function connectWithRetry(url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = new Error(`Unable to connect to ${url}`);
  while (Date.now() < deadline) {
    try {
      return await connectWebSocket(url);
    } catch (error) {
      lastError = error;
      await delay(50);
    }
  }
  throw lastError;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

async function waitForStatus(baseUrl, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const result = await requestJson(`${baseUrl}/api/status`);
      last = result.body;
      if (result.status === 200 && predicate(result.body)) return result.body;
    } catch {
      // The child server may still be starting.
    }
    await delay(25);
  }
  throw new Error(`Timed out waiting for bridge status: ${JSON.stringify(last)}`);
}

const source = await fs.readFile(serverPath, 'utf8');
const notificationHandlerStart = source.indexOf("appServer.on('notification'");
const lifecycleUpdate = source.indexOf('applyTurnLifecycleNotification(message);', notificationHandlerStart);
const assetPreparation = source.indexOf('await prepareItemAssets(message.params?.item);', notificationHandlerStart);
assert.ok(notificationHandlerStart >= 0, 'notification handler must exist');
assert.ok(lifecycleUpdate >= 0 && lifecycleUpdate < assetPreparation, 'turn state must update before asset preparation');

const uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-mobile-server-test-'));
const upstreamHttp = http.createServer();
const upstreamWss = new WebSocketServer({ noServer: true });
const upstreamMessages = [];
let upstreamSocket = null;
let turnStartCount = 0;
let steerCount = 0;
let turnStartMode = 'success';

upstreamHttp.on('upgrade', (request, socket, head) => {
  upstreamWss.handleUpgrade(request, socket, head, (client) => upstreamWss.emit('connection', client));
});

upstreamWss.on('connection', (socket) => {
  upstreamSocket = socket;
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    upstreamMessages.push(message);
    if (message.method === 'initialize') {
      sendJson(socket, { id: message.id, result: { serverInfo: { name: 'server-test' } } });
      return;
    }
    if (message.method === 'thread/start') {
      sendJson(socket, {
        id: message.id,
        result: { thread: { id: 'server-test-thread', name: 'Server test', cwd: root, status: 'idle', turns: [] } },
      });
      return;
    }
    if (message.method === 'thread/read') {
      sendJson(socket, {
        id: message.id,
        result: { thread: { id: message.params.threadId, name: 'Server test', cwd: root, status: 'idle', turns: [] } },
      });
      return;
    }
    if (message.method === 'thread/turns/list') {
      sendJson(socket, { id: message.id, result: { data: [], nextCursor: null } });
      return;
    }
    if (message.method === 'turn/start') {
      turnStartCount += 1;
      if (turnStartMode === 'active-writer') {
        sendJson(socket, {
          id: message.id,
          error: { code: -32_000, message: 'thread already has an active writer' },
        });
      } else {
        setTimeout(() => sendJson(socket, { id: message.id, result: { turn: { id: 'server-test-turn' } } }), 75);
      }
      return;
    }
    if (message.method === 'turn/steer') {
      steerCount += 1;
      sendJson(socket, { id: message.id, result: { turnId: 'server-test-turn' } });
      return;
    }
    if (message.method === 'thread/list') {
      sendJson(socket, { id: message.id, result: { data: [], nextCursor: null } });
    }
  });
});

const upstreamPort = await listen(upstreamHttp);
const bridgePort = await freePort();
const muxPort = await freePort();
const bridgeBaseUrl = `http://127.0.0.1:${bridgePort}`;
const muxUrl = `ws://127.0.0.1:${muxPort}`;
const childEnv = { ...process.env };
for (const key of [
  'CODEX_MOBILE_SECRET_FILE',
  'CODEX_MOBILE_DISABLE_RPC_MUX',
  'CODEX_MOBILE_RPC_MUX_LISTEN_URL',
  'CODEX_MOBILE_APP_SERVER_URL',
]) delete childEnv[key];
Object.assign(childEnv, {
  CODEX_MOBILE_APP_SERVER_URL: `ws://127.0.0.1:${upstreamPort}`,
  CODEX_MOBILE_RPC_MUX_LISTEN_URL: muxUrl,
  CODEX_MOBILE_HOST: '127.0.0.1',
  CODEX_MOBILE_PORT: String(bridgePort),
  CODEX_MOBILE_CODEX_PATH: 'unused',
  CODEX_MOBILE_UPLOAD_ROOT: uploadRoot,
});

let child = null;
let desktop = null;
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

  const muxUpstreamDeadline = Date.now() + 10_000;
  let muxUpstreamReady = false;
  while (Date.now() < muxUpstreamDeadline) {
    try {
      const ready = await requestJson(`http://127.0.0.1:${muxPort}/readyz`);
      if (ready.status === 200 && ready.body?.upstreamConnected === true) {
        muxUpstreamReady = true;
        break;
      }
    } catch {
      // The mux listener or upstream may still be starting.
    }
    await delay(25);
  }
  if (!muxUpstreamReady) throw new Error(`Mux upstream did not become ready; child=${childOutput}`);
  desktop = await connectWithRetry(muxUrl);
  const initializeResponsePromise = waitForSocketMessage(desktop, (message) => message.id === 'desktop-init');
  desktop.send(JSON.stringify({
    method: 'initialize',
    id: 'desktop-init',
    params: { clientInfo: { name: 'server-test-desktop' } },
  }));
  const initializeResponse = await initializeResponsePromise.catch((error) => {
    throw new Error(`${error.message}; upstream=${JSON.stringify(upstreamMessages)}; child=${childOutput}`);
  });
  assert.equal(initializeResponse.result.serverInfo.name, 'server-test');
  desktop.send(JSON.stringify({ method: 'initialized', params: {} }));

  const status = await waitForStatus(bridgeBaseUrl, (value) => (
    value.ready === true
      && value.appServerTransport === 'rpc-mux'
      && value.rpcMux?.ready === true
      && value.rpcMux?.upstreamConnected === true
      && value.rpcMux?.desktopConnected === true
  ));
  assert.equal(status.rpcMux.initialized, true);
  assert.equal(upstreamMessages.filter((message) => message.method === 'initialize').length, 1);

  const threadResponse = await requestJson(`${bridgeBaseUrl}/api/threads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(threadResponse.status, 201);
  assert.equal(threadResponse.body.thread.id, 'server-test-thread');

  const assetPath = path.join(uploadRoot, 'asset-not-present.png');
  upstreamSocket.send(JSON.stringify({
    method: 'turn/started',
    params: {
      threadId: 'server-test-thread',
      turn: { id: 'notification-turn' },
      item: { type: 'imageView', path: assetPath },
    },
  }));
  await waitForStatus(bridgeBaseUrl, (value) => value.activeTurnId === 'notification-turn');
  upstreamSocket.send(JSON.stringify({
    method: 'turn/completed',
    params: { threadId: 'server-test-thread', turnId: 'notification-turn' },
  }));
  const completedNotificationStatus = await waitForStatus(bridgeBaseUrl, (value) => (
    value.activeTurnId === null
      && value.lastStartedTurnId === 'notification-turn'
      && value.lastCompletedTurnId === 'notification-turn'
  ));
  assert.equal(completedNotificationStatus.lastCompletedTurnId, 'notification-turn');

  const postMessage = (text) => requestJson(`${bridgeBaseUrl}/api/threads/server-test-thread/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const [first, second] = await Promise.all([
    postMessage('first concurrent message'),
    postMessage('second concurrent message'),
  ]);
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  assert.equal(turnStartCount, 1, 'concurrent messages must not issue two turn/start calls');
  assert.equal(steerCount, 1, 'the serialized second message should steer the active turn');

  turnStartMode = 'active-writer';
  upstreamSocket.send(JSON.stringify({
    method: 'turn/completed',
    params: { threadId: 'server-test-thread', turnId: 'server-test-turn' },
  }));
  await waitForStatus(bridgeBaseUrl, (value) => value.activeTurnId === null);
  const activeWriter = await postMessage('active writer mapping');
  assert.equal(activeWriter.status, 409);
  assert.equal(activeWriter.body.code, 'ACTIVE_WRITER');
  assert.equal(turnStartCount, 2);

  console.log(JSON.stringify({
    passed: true,
    notificationStateBeforeAssets: true,
    serializedTurnStarts: turnStartCount,
    serializedSteers: steerCount,
    muxActiveWriterCode: activeWriter.body.code,
  }));
} finally {
  if (desktop && desktop.readyState < WebSocket.CLOSING) desktop.terminate();
  if (child && !child.killed) child.kill();
  if (child) await once(child, 'exit').catch(() => {});
  await new Promise((resolve) => upstreamWss.close(resolve));
  await new Promise((resolve) => upstreamHttp.close(resolve));
  await fs.rm(uploadRoot, { recursive: true, force: true });
}
