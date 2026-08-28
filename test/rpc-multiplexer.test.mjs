import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { CodexAppServer } from '../app-server-client.mjs';
import { AppServerRpcMultiplexer } from '../rpc-multiplexer.mjs';

class MessageProbe extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.messages = [];
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString());
      this.messages.push(message);
      this.emit('message', message);
    });
  }

  async waitFor(predicate, timeoutMs = 3_000) {
    const existing = this.messages.find(predicate);
    if (existing) return existing;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('message', onMessage);
        reject(new Error('Timed out waiting for WebSocket message'));
      }, timeoutMs);
      const onMessage = (message) => {
        if (!predicate(message)) return;
        clearTimeout(timer);
        this.off('message', onMessage);
        resolve(message);
      };
      this.on('message', onMessage);
    });
  }
}

async function listen(server, host = '127.0.0.1') {
  server.listen(0, host);
  await once(server, 'listening');
  return server.address().port;
}

async function connect(url) {
  const socket = new WebSocket(url);
  await once(socket, 'open');
  return { socket, probe: new MessageProbe(socket) };
}

const upstreamHttp = http.createServer();
const upstreamWss = new WebSocketServer({ noServer: true });
const upstreamMessages = new EventEmitter();
let upstreamConnectionCount = 0;
let upstreamInitializeCount = 0;
let upstreamInitializedNotificationCount = 0;
let upstreamSocket = null;

upstreamHttp.on('upgrade', (request, socket, head) => {
  upstreamWss.handleUpgrade(request, socket, head, (client) => upstreamWss.emit('connection', client));
});
upstreamWss.on('connection', (socket) => {
  upstreamConnectionCount += 1;
  upstreamSocket = socket;
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    upstreamMessages.emit('message', message);
    if (message.method === 'initialize') {
      upstreamInitializeCount += 1;
      socket.send(JSON.stringify({ id: message.id, result: { serverInfo: { name: 'mock-app-server' } } }));
    } else if (message.method === 'initialized') {
      upstreamInitializedNotificationCount += 1;
    } else if (message.method === 'thread/read') {
      socket.send(JSON.stringify({ id: message.id, result: { thread: { id: message.params.threadId, turns: [] } } }));
    } else if (message.method === 'turn/start') {
      socket.send(JSON.stringify({ id: message.id, result: { turn: { id: 'turn-from-mobile' } } }));
    }
  });
});

const upstreamPort = await listen(upstreamHttp);
const mux = new AppServerRpcMultiplexer({
  upstreamUrl: `ws://127.0.0.1:${upstreamPort}/`,
  listenUrl: 'ws://127.0.0.1:0/',
});
await mux.start();
const preInitializeReady = await fetch(mux.boundUrl.replace(/^ws:/, 'http:') + 'readyz');
assert.equal(preInitializeReady.status, 200);
assert.equal((await preInitializeReady.json()).ready, false);

const appServer = new CodexAppServer({
  codexPath: 'unused',
  cwd: process.cwd(),
  rpcTransport: mux.createInternalTransport(),
});
const mobileStart = appServer.start();

let desktop = await connect(mux.boundUrl);
desktop.socket.send(Buffer.from(JSON.stringify({ method: 'initialize', id: 'desktop-init', params: { clientInfo: { name: 'desktop-test' } } })));
const initializeResponse = await desktop.probe.waitFor((message) => message.id === 'desktop-init');
assert.equal(initializeResponse.result.serverInfo.name, 'mock-app-server');
await mobileStart;
desktop.socket.send(JSON.stringify({ method: 'initialized', params: {} }));
assert.equal(appServer.ready, true);
assert.equal(mux.ready, true);
const postInitializeReady = await fetch(mux.boundUrl.replace(/^ws:/, 'http:') + 'readyz');
assert.equal(postInitializeReady.status, 200);
assert.equal((await postInitializeReady.json()).ready, true);
assert.equal(upstreamConnectionCount, 1);
assert.equal(upstreamInitializeCount, 1);
assert.equal(upstreamInitializedNotificationCount, 1);

desktop.socket.send(JSON.stringify({ method: 'thread/read', id: 7, params: { threadId: 'desktop-thread' } }));
const desktopRead = await desktop.probe.waitFor((message) => message.id === 7);
assert.equal(desktopRead.result.thread.id, 'desktop-thread');

const mobileTurn = await appServer.startTurn('desktop-thread', 'hello through the mux');
assert.equal(mobileTurn.turn.id, 'turn-from-mobile');
assert.equal(upstreamConnectionCount, 1);

const mobileNotification = once(appServer, 'notification');
upstreamSocket.send(JSON.stringify({ method: 'turn/started', params: { threadId: 'desktop-thread', turn: { id: 'turn-shared' } } }));
const [mobileNotificationMessage] = await mobileNotification;
const desktopNotification = await desktop.probe.waitFor((message) => message.method === 'turn/started');
assert.equal(mobileNotificationMessage.params.turn.id, 'turn-shared');
assert.equal(desktopNotification.params.turn.id, 'turn-shared');

const mobileServerRequest = once(appServer, 'serverRequest');
upstreamSocket.send(JSON.stringify({
  method: 'item/commandExecution/requestApproval',
  id: 'approval-upstream',
  params: { threadId: 'desktop-thread', command: 'echo safe' },
}));
const [approvalForMobile] = await mobileServerRequest;
const approvalForDesktop = await desktop.probe.waitFor((message) => message.method === 'item/commandExecution/requestApproval');
assert.equal(approvalForMobile.id, 'approval-upstream');
assert.equal(typeof approvalForDesktop.id, 'number');
assert.ok(approvalForDesktop.id < 0);

const approvalResponseAtUpstream = new Promise((resolve) => {
  const onMessage = (message) => {
    if (message.id !== 'approval-upstream' || message.method) return;
    upstreamMessages.off('message', onMessage);
    resolve(message);
  };
  upstreamMessages.on('message', onMessage);
});
appServer.respondToServerRequest('approval-upstream', { decision: 'accept' });
assert.deepEqual((await approvalResponseAtUpstream).result, { decision: 'accept' });

desktop.socket.close(1000, 'test reconnect');
await once(desktop.socket, 'close');
desktop = await connect(mux.boundUrl);
desktop.socket.send(JSON.stringify({ method: 'initialize', id: 99, params: { clientInfo: { name: 'desktop-reconnect' } } }));
const replayedInitialize = await desktop.probe.waitFor((message) => message.id === 99);
assert.equal(replayedInitialize.result.serverInfo.name, 'mock-app-server');
desktop.socket.send(JSON.stringify({ method: 'initialized', params: {} }));
desktop.socket.send(JSON.stringify({ method: 'thread/read', id: 100, params: { threadId: 'after-reconnect' } }));
const afterReconnect = await desktop.probe.waitFor((message) => message.id === 100);
assert.equal(afterReconnect.result.thread.id, 'after-reconnect');
assert.equal(upstreamInitializeCount, 1);
assert.equal(upstreamConnectionCount, 1);

await appServer.stop();
await mux.stop();
desktop.socket.terminate();
upstreamWss.close();
await new Promise((resolve) => upstreamHttp.close(resolve));

console.log(JSON.stringify({
  passed: true,
  upstreamConnections: upstreamConnectionCount,
  initializeCalls: upstreamInitializeCount,
  desktopReconnectReusedInitialization: true,
  mobileTurnSharedWriterConnection: true,
}));
