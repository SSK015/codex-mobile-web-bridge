import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { WebSocket } from 'ws';
import { CodexAppServer } from '../app-server-client.mjs';
import { AppServerRpcMultiplexer } from '../rpc-multiplexer.mjs';

const upstreamUrl = process.env.CODEX_MUX_TEST_UPSTREAM_URL;
if (!upstreamUrl) throw new Error('Set CODEX_MUX_TEST_UPSTREAM_URL to an isolated Codex App Server WebSocket');

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

  notify(method, params = {}) {
    this.socket.send(JSON.stringify({ method, params }));
  }
}

const mux = new AppServerRpcMultiplexer({
  upstreamUrl,
  listenUrl: 'ws://127.0.0.1:0/',
});
await mux.start();

const transport = mux.createInternalTransport();
const mobile = new CodexAppServer({ codexPath: 'unused', cwd: process.cwd(), rpcTransport: transport });
const mobileReady = mobile.start();
const desktopSocket = new WebSocket(mux.boundUrl);
await once(desktopSocket, 'open');
const desktop = new DesktopPeer(desktopSocket);
await desktop.request('initialize', {
  clientInfo: { name: 'codex-mobile-rpc-mux-smoke', title: 'RPC Mux Smoke Test', version: '1.0.0' },
  capabilities: { experimentalApi: true },
});
desktop.notify('initialized');
await mobileReady;

const started = await desktop.request('thread/start', {
  cwd: process.cwd(),
  ephemeral: true,
  historyMode: 'paginated',
});
const threadId = started.thread.id;
const completion = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Timed out waiting for the real turn to complete')), 180_000);
  const onNotification = (message) => {
    if (message.method !== 'turn/completed' || message.params?.threadId !== threadId) return;
    clearTimeout(timer);
    mobile.off('notification', onNotification);
    resolve(message);
  };
  mobile.on('notification', onNotification);
});
const turn = await mobile.startTurn(threadId, 'Reply exactly MUX_OK. Do not call tools.');
const completed = await completion;

assert.equal(mux.stats.upstreamConnected, true);
assert.equal(mux.stats.desktopConnected, true);
assert.ok(turn.turn?.id);
assert.equal(completed.params?.turn?.id || completed.params?.turnId, turn.turn.id);

console.log(JSON.stringify({
  passed: true,
  threadId,
  turnId: turn.turn.id,
  singleUpstreamConnection: true,
  desktopStartedThread: true,
  mobileStartedTurn: true,
}));

desktopSocket.close(1000, 'smoke test complete');
await mobile.stop();
await mux.stop();
