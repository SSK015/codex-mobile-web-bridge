import { EventEmitter } from 'node:events';
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

const DEFAULT_MAX_PAYLOAD = 128 * 1024 * 1024;
const DEFAULT_MAX_BUFFERED = 64 * 1024 * 1024;
const DEFAULT_MAX_PENDING = 20_000;

function rpcIdKey(id) {
  return `${typeof id}:${String(id)}`;
}

function isLoopbackAddress(address) {
  const normalized = String(address || '').toLowerCase();
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === '::ffff:127.0.0.1';
}

function assertLoopbackWebSocketUrl(value, label, { allowPortZero = false } = {}) {
  const url = new URL(value);
  if (url.protocol !== 'ws:') throw new Error(`${label} must use ws://`);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error(`${label} must be bound to loopback`);
  }
  const port = Number(url.port || 80);
  if (!Number.isInteger(port) || port < (allowPortZero ? 0 : 1) || port > 65_535) {
    throw new Error(`${label} has an invalid port`);
  }
  return url;
}

class MultiplexedRpcTransport extends EventEmitter {
  constructor(multiplexer) {
    super();
    this.multiplexer = multiplexer;
    this.active = false;
  }

  get ready() {
    return this.active && this.multiplexer.ready;
  }

  async start() {
    if (this.active) return;
    this.active = true;
    this.multiplexer.registerInternalTransport(this);
    try {
      await this.multiplexer.waitUntilReady();
    } catch (error) {
      this.active = false;
      this.multiplexer.unregisterInternalTransport(this);
      throw error;
    }
  }

  send(message) {
    if (!this.ready) throw new Error('RPC multiplexer is not ready');
    this.multiplexer.sendInternal(this, message);
  }

  async stop() {
    if (!this.active) return;
    this.active = false;
    this.multiplexer.unregisterInternalTransport(this);
  }

  deliver(message) {
    if (this.active) this.emit('message', message);
  }

  fail(error, event) {
    if (!this.active) return;
    if (this.listenerCount('error') > 0) this.emit('error', error);
    this.emit('close', event);
  }
}

export class AppServerRpcMultiplexer extends EventEmitter {
  constructor({
    upstreamUrl,
    listenUrl,
    maxPayloadBytes = DEFAULT_MAX_PAYLOAD,
    maxBufferedBytes = DEFAULT_MAX_BUFFERED,
    maxPendingRequests = DEFAULT_MAX_PENDING,
  }) {
    super();
    this.upstreamUrl = assertLoopbackWebSocketUrl(upstreamUrl, 'upstreamUrl').toString();
    this.listen = assertLoopbackWebSocketUrl(listenUrl, 'listenUrl', { allowPortZero: true });
    this.maxPayloadBytes = maxPayloadBytes;
    this.maxBufferedBytes = maxBufferedBytes;
    this.maxPendingRequests = maxPendingRequests;
    this.httpServer = null;
    this.webSocketServer = null;
    this.upstream = null;
    this.desktop = null;
    this.internalTransports = new Set();
    this.pendingUpstream = new Map();
    this.serverRequests = new Map();
    this.desktopServerRequestIds = new Map();
    this.nextUpstreamId = 1;
    this.nextDesktopServerRequestId = -1;
    this.initializeAccepted = false;
    this.initializeResponse = null;
    this.initialized = false;
    this.started = false;
    this.stopping = false;
    this.boundUrl = null;
    this.#resetReadyPromise();
  }

  get ready() {
    return this.started && this.initialized && this.upstream?.readyState === WebSocket.OPEN;
  }

  get stats() {
    return {
      ready: this.ready,
      upstreamConnected: this.upstream?.readyState === WebSocket.OPEN,
      desktopConnected: this.desktop?.socket?.readyState === WebSocket.OPEN,
      initialized: this.initialized,
      pendingRequests: this.pendingUpstream.size,
      pendingServerRequests: this.serverRequests.size,
      boundUrl: this.boundUrl,
      upstreamUrl: this.upstreamUrl,
    };
  }

  createInternalTransport() {
    return new MultiplexedRpcTransport(this);
  }

  registerInternalTransport(transport) {
    this.internalTransports.add(transport);
  }

  unregisterInternalTransport(transport) {
    this.internalTransports.delete(transport);
  }

  waitUntilReady() {
    if (this.ready) return Promise.resolve();
    return this.readyPromise;
  }

  async start() {
    if (this.started) return;
    if (!this.readyResolve && !this.readyReject) this.#resetReadyPromise();
    this.started = true;
    this.stopping = false;
    await this.#startDownstreamServer();
    try {
      await this.#connectUpstream();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop() {
    if (!this.started && !this.httpServer && !this.upstream) return;
    this.stopping = true;
    this.started = false;
    const closeEvent = { code: 1001, reason: 'RPC multiplexer stopping', intentional: true };
    for (const transport of this.internalTransports) transport.fail(new Error(closeEvent.reason), closeEvent);
    this.internalTransports.clear();
    this.#rejectReady(new Error(closeEvent.reason));
    this.#rejectPending(new Error(closeEvent.reason));
    if (this.desktop?.socket?.readyState === WebSocket.OPEN) {
      this.desktop.socket.close(1001, closeEvent.reason);
    }
    this.desktop = null;
    if (this.upstream && this.upstream.readyState < WebSocket.CLOSING) {
      this.upstream.close(1000, closeEvent.reason);
    }
    this.upstream = null;
    if (this.webSocketServer) {
      for (const client of this.webSocketServer.clients) client.terminate();
      this.webSocketServer.close();
      this.webSocketServer = null;
    }
    if (this.httpServer) {
      const server = this.httpServer;
      this.httpServer = null;
      await new Promise((resolve) => server.close(resolve));
    }
    this.initialized = false;
    this.initializeAccepted = false;
    this.initializeResponse = null;
    this.stopping = false;
  }

  sendInternal(transport, message) {
    if (!this.internalTransports.has(transport)) throw new Error('RPC transport is not registered');
    if (!message || typeof message !== 'object') throw new Error('RPC message must be an object');
    if (message.id != null && message.method) {
      this.#forwardRequest('internal', transport, message);
      return;
    }
    if (message.id != null && !message.method) {
      this.#resolveServerRequest(message);
      return;
    }
    if (message.method) this.#sendUpstream(message);
  }

  async #startDownstreamServer() {
    const expectedPath = this.listen.pathname || '/';
    const server = http.createServer((request, response) => {
      if (request.url === '/readyz') {
        const status = this.ready ? 200 : 503;
        response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify(this.stats));
        return;
      }
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
    });
    const wss = new WebSocketServer({ noServer: true, maxPayload: this.maxPayloadBytes, perMessageDeflate: false });
    server.on('upgrade', (request, socket, head) => {
      let pathname = '';
      try {
        pathname = new URL(request.url, 'http://localhost').pathname;
      } catch {
        socket.destroy();
        return;
      }
      if (!isLoopbackAddress(request.socket.remoteAddress) || pathname !== expectedPath) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (client) => wss.emit('connection', client, request));
    });
    wss.on('connection', (socket) => this.#acceptDesktop(socket));
    wss.on('error', (error) => this.emit('error', error));
    this.httpServer = server;
    this.webSocketServer = wss;
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(Number(this.listen.port || 80), this.listen.hostname.replace(/^\[(.*)\]$/, '$1'));
    });
    const address = server.address();
    const host = this.listen.hostname === '[::1]' ? '[::1]' : this.listen.hostname;
    this.boundUrl = `ws://${host}:${address.port}${expectedPath}`;
  }

  async #connectUpstream() {
    const ws = new WebSocket(this.upstreamUrl, { perMessageDeflate: false, maxPayload: this.maxPayloadBytes });
    this.upstream = ws;
    ws.on('message', (data, isBinary) => {
      if (isBinary) return this.#fail(new Error('App Server sent a binary WebSocket frame'), { code: 1003, reason: 'binary frame' });
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return this.#fail(new Error('App Server sent invalid JSON'), { code: 1007, reason: 'invalid JSON' });
      }
      this.#handleUpstreamMessage(message);
    });
    ws.on('error', (error) => {
      if (this.started && this.listenerCount('error') > 0) this.emit('error', error);
    });
    ws.on('close', (code, reason) => {
      if (this.upstream !== ws || this.stopping) return;
      this.upstream = null;
      this.#fail(new Error(`Upstream App Server closed (${code}${reason.length ? `: ${reason}` : ''})`), {
        code,
        reason: reason.toString(),
      });
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`Timed out connecting to ${this.upstreamUrl}`));
      }, 15_000);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      ws.once('close', (code) => {
        clearTimeout(timer);
        reject(new Error(`Upstream closed before connection (${code})`));
      });
    });
  }

  #acceptDesktop(socket) {
    if (this.desktop?.socket?.readyState === WebSocket.OPEN) {
      socket.close(1013, 'A desktop client is already connected');
      return;
    }
    const desktop = { socket, protocolReady: false };
    this.desktop = desktop;
    socket.on('message', (data, isBinary) => {
      if (this.desktop !== desktop) return;
      if (isBinary) return socket.close(1003, 'Binary frames are not supported');
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return socket.close(1007, 'Invalid JSON');
      }
      try {
        this.#handleDesktopMessage(desktop, message);
      } catch (error) {
        if (message?.id != null && message?.method) {
          this.#sendDesktop(desktop, { id: message.id, error: { code: -32_000, message: error.message } });
        } else {
          socket.close(1011, 'RPC routing error');
        }
      }
    });
    socket.on('close', () => {
      if (this.desktop !== desktop) return;
      this.desktop = null;
      for (const [id, pending] of this.pendingUpstream.entries()) {
        // The upstream accepts initialize only once. Preserve an in-flight
        // initialize across a renderer reconnect so its response can be cached
        // and replayed to the replacement Desktop connection.
        if (pending.source === 'desktop' && pending.desktop === desktop && !pending.initialize) {
          this.pendingUpstream.delete(id);
        }
      }
      for (const [id, upstreamKey] of this.desktopServerRequestIds.entries()) {
        const request = this.serverRequests.get(upstreamKey);
        if (request?.desktop === desktop) request.desktop = null;
        this.desktopServerRequestIds.delete(id);
      }
      this.emit('desktopDisconnected');
    });
    socket.on('error', (error) => {
      if (this.listenerCount('error') > 0) this.emit('error', error);
    });
    this.emit('desktopConnected');
  }

  #handleDesktopMessage(desktop, message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('RPC message must be an object');
    if (message.id != null && message.method) {
      if (message.method === 'initialize') {
        this.#handleDesktopInitialize(desktop, message);
        return;
      }
      if (!this.initialized || !desktop.protocolReady) throw new Error('RPC connection is not initialized');
      this.#forwardRequest('desktop', desktop, message);
      return;
    }
    if (message.id != null && !message.method) {
      const desktopKey = rpcIdKey(message.id);
      const upstreamKey = this.desktopServerRequestIds.get(desktopKey);
      if (!upstreamKey) return;
      const request = this.serverRequests.get(upstreamKey);
      this.desktopServerRequestIds.delete(desktopKey);
      if (!request) return;
      this.serverRequests.delete(upstreamKey);
      this.#sendUpstream({ ...message, id: request.id });
      return;
    }
    if (!message.method) return;
    if (message.method === 'initialized') {
      if (!this.initializeAccepted) throw new Error('initialize has not completed');
      desktop.protocolReady = true;
      if (!this.initialized) {
        this.#sendUpstream(message);
        this.initialized = true;
        this.#resolveReady();
      }
      this.#deliverPendingServerRequests(desktop);
      return;
    }
    if (!this.initialized || !desktop.protocolReady) throw new Error('RPC connection is not initialized');
    this.#sendUpstream(message);
  }

  #handleDesktopInitialize(desktop, message) {
    if (this.initializeResponse) {
      this.#sendDesktop(desktop, { ...this.initializeResponse, id: message.id });
      return;
    }
    const pendingInitialize = [...this.pendingUpstream.values()].find((pending) => pending.initialize);
    if (pendingInitialize && pendingInitialize.desktop !== desktop) {
      pendingInitialize.desktop = desktop;
      pendingInitialize.originalId = message.id;
      return;
    }
    if (pendingInitialize) {
      this.#sendDesktop(desktop, {
        id: message.id,
        error: { code: -32_000, message: 'initialize is already pending' },
      });
      return;
    }
    this.#forwardRequest('desktop', desktop, message, { initialize: true });
  }

  #forwardRequest(source, target, message, { initialize = false } = {}) {
    if (this.pendingUpstream.size >= this.maxPendingRequests) throw new Error('RPC pending request limit reached');
    const upstreamId = this.#allocateUpstreamId();
    this.pendingUpstream.set(rpcIdKey(upstreamId), {
      source,
      desktop: source === 'desktop' ? target : null,
      transport: source === 'internal' ? target : null,
      originalId: message.id,
      method: message.method,
      initialize,
    });
    try {
      this.#sendUpstream({ ...message, id: upstreamId });
    } catch (error) {
      this.pendingUpstream.delete(rpcIdKey(upstreamId));
      throw error;
    }
  }

  #handleUpstreamMessage(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    if (message.id != null && !message.method) {
      const pending = this.pendingUpstream.get(rpcIdKey(message.id));
      if (!pending) return;
      this.pendingUpstream.delete(rpcIdKey(message.id));
      const routed = { ...message, id: pending.originalId };
      if (pending.initialize) {
        if (!message.error) {
          this.initializeAccepted = true;
          this.initializeResponse = { ...message };
          delete this.initializeResponse.id;
        } else {
          this.#rejectReady(new Error(message.error.message || 'App Server initialization failed'));
        }
      }
      if (pending.source === 'desktop') this.#sendDesktop(pending.desktop, routed);
      else pending.transport.deliver(routed);
      return;
    }
    if (message.id != null && message.method) {
      const upstreamKey = rpcIdKey(message.id);
      this.serverRequests.set(upstreamKey, { id: message.id, message, desktop: null });
      for (const transport of this.internalTransports) transport.deliver(message);
      if (this.desktop?.protocolReady) this.#deliverServerRequestToDesktop(this.desktop, upstreamKey);
      return;
    }
    if (!message.method) return;
    if (message.method === 'serverRequest/resolved') {
      this.#clearServerRequest(message.params?.requestId);
    }
    for (const transport of this.internalTransports) transport.deliver(message);
    if (this.desktop?.protocolReady) this.#sendDesktop(this.desktop, message);
  }

  #deliverPendingServerRequests(desktop) {
    for (const upstreamKey of this.serverRequests.keys()) this.#deliverServerRequestToDesktop(desktop, upstreamKey);
  }

  #deliverServerRequestToDesktop(desktop, upstreamKey) {
    const request = this.serverRequests.get(upstreamKey);
    if (!request || request.desktop === desktop) return;
    const desktopId = this.nextDesktopServerRequestId--;
    request.desktop = desktop;
    request.desktopId = desktopId;
    this.desktopServerRequestIds.set(rpcIdKey(desktopId), upstreamKey);
    this.#sendDesktop(desktop, { ...request.message, id: desktopId });
  }

  #resolveServerRequest(message) {
    const upstreamKey = rpcIdKey(message.id);
    const request = this.serverRequests.get(upstreamKey);
    if (!request) throw new Error('Server request is no longer pending');
    this.#clearServerRequest(message.id);
    this.#sendUpstream({ ...message, id: request.id });
  }

  #clearServerRequest(id) {
    if (id == null) return;
    const upstreamKey = rpcIdKey(id);
    const request = this.serverRequests.get(upstreamKey);
    if (!request) return;
    if (request.desktopId != null) this.desktopServerRequestIds.delete(rpcIdKey(request.desktopId));
    this.serverRequests.delete(upstreamKey);
  }

  #allocateUpstreamId() {
    for (let attempts = 0; attempts < this.maxPendingRequests + 1; attempts += 1) {
      const candidate = this.nextUpstreamId++;
      if (this.nextUpstreamId >= Number.MAX_SAFE_INTEGER) this.nextUpstreamId = 1;
      if (!this.pendingUpstream.has(rpcIdKey(candidate))) return candidate;
    }
    throw new Error('Unable to allocate an RPC request id');
  }

  #sendUpstream(message) {
    const ws = this.upstream;
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('Upstream App Server is not connected');
    if (ws.bufferedAmount > this.maxBufferedBytes) {
      this.#fail(new Error('Upstream WebSocket backpressure limit exceeded'), { code: 1013, reason: 'backpressure' });
      throw new Error('Upstream WebSocket backpressure limit exceeded');
    }
    ws.send(JSON.stringify(message));
  }

  #sendDesktop(desktop, message) {
    const ws = desktop?.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > this.maxBufferedBytes) {
      ws.close(1013, 'Backpressure limit exceeded');
      return;
    }
    ws.send(JSON.stringify(message));
  }

  #rejectPending(error) {
    for (const pending of this.pendingUpstream.values()) {
      if (pending.source === 'internal') {
        pending.transport.deliver({
          id: pending.originalId,
          error: { code: -32_000, message: error.message },
        });
      } else {
        this.#sendDesktop(pending.desktop, {
          id: pending.originalId,
          error: { code: -32_000, message: error.message },
        });
      }
    }
    this.pendingUpstream.clear();
    this.serverRequests.clear();
    this.desktopServerRequestIds.clear();
  }

  #fail(error, event) {
    if (!this.started) return;
    this.#rejectReady(error);
    this.#rejectPending(error);
    for (const transport of this.internalTransports) transport.fail(error, event);
    if (this.desktop?.socket?.readyState === WebSocket.OPEN) {
      this.desktop.socket.close(1012, 'Upstream App Server disconnected');
    }
    this.emit('upstreamExit', event);
  }

  #resetReadyPromise() {
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.readyPromise.catch(() => {});
  }

  #resolveReady() {
    this.readyResolve?.();
    this.readyResolve = null;
    this.readyReject = null;
    this.emit('ready');
  }

  #rejectReady(error) {
    this.readyReject?.(error);
    this.readyResolve = null;
    this.readyReject = null;
  }
}

export { MultiplexedRpcTransport, rpcIdKey };
