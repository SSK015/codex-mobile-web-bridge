import { EventEmitter } from 'node:events';
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

const DEFAULT_MAX_PAYLOAD = 128 * 1024 * 1024;
const DEFAULT_MAX_BUFFERED = 64 * 1024 * 1024;
const DEFAULT_MAX_PENDING = 20_000;
const DEFAULT_RECONNECT_BASE_DELAY = 250;
const DEFAULT_RECONNECT_MAX_DELAY = 5_000;
const UPSTREAM_CONNECT_TIMEOUT = 15_000;
const UPSTREAM_INITIALIZE_TIMEOUT = 15_000;

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
    this.active = false;
    this.multiplexer.unregisterInternalTransport(this);
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
    reconnectBaseDelayMs = DEFAULT_RECONNECT_BASE_DELAY,
    reconnectMaxDelayMs = DEFAULT_RECONNECT_MAX_DELAY,
  }) {
    super();
    this.upstreamUrl = assertLoopbackWebSocketUrl(upstreamUrl, 'upstreamUrl').toString();
    this.listen = assertLoopbackWebSocketUrl(listenUrl, 'listenUrl', { allowPortZero: true });
    this.maxPayloadBytes = maxPayloadBytes;
    this.maxBufferedBytes = maxBufferedBytes;
    this.maxPendingRequests = maxPendingRequests;
    this.reconnectBaseDelayMs = this.#normalizeReconnectDelay(reconnectBaseDelayMs, DEFAULT_RECONNECT_BASE_DELAY);
    this.reconnectMaxDelayMs = Math.max(
      this.reconnectBaseDelayMs,
      this.#normalizeReconnectDelay(reconnectMaxDelayMs, DEFAULT_RECONNECT_MAX_DELAY),
    );
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
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.reconnectGeneration = 0;
    this.reconnecting = false;
    this.upstreamInitializeTimer = null;
    this.upstreamInitialization = null;
    this.initializeRequest = null;
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

  get acceptingConnections() {
    return this.started && this.upstream?.readyState === WebSocket.OPEN;
  }

  get stats() {
    return {
      ready: this.ready,
      acceptingConnections: this.acceptingConnections,
      upstreamConnected: this.upstream?.readyState === WebSocket.OPEN,
      desktopConnected: this.desktop?.socket?.readyState === WebSocket.OPEN,
      initialized: this.initialized,
      reconnecting: this.reconnecting,
      reconnectAttempt: this.reconnectAttempt,
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
    this.reconnectGeneration += 1;
    this.reconnectAttempt = 0;
    await this.#startDownstreamServer();
    try {
      await this.#connectUpstream();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop() {
    if (!this.started && !this.httpServer && !this.upstream && !this.reconnectTimer) return;
    this.stopping = true;
    this.started = false;
    this.reconnectGeneration += 1;
    this.#cancelReconnect();
    this.#clearUpstreamInitializeTimer();
    this.upstreamInitialization = null;
    const closeEvent = { code: 1001, reason: 'RPC multiplexer stopping', intentional: true };
    for (const transport of this.internalTransports) transport.fail(new Error(closeEvent.reason), closeEvent);
    this.internalTransports.clear();
    this.#rejectReady(new Error(closeEvent.reason));
    this.#rejectPending(new Error(closeEvent.reason));
    if (this.desktop?.socket?.readyState === WebSocket.OPEN) {
      this.desktop.socket.close(1001, closeEvent.reason);
    }
    this.desktop = null;
    if (this.upstream?.readyState === WebSocket.OPEN) {
      this.upstream.close(1000, closeEvent.reason);
    } else if (this.upstream?.readyState === WebSocket.CONNECTING) {
      this.upstream.terminate();
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
    this.initializeRequest = null;
    this.reconnectAttempt = 0;
    this.reconnecting = false;
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
        // Codex Desktop probes /readyz before it opens the WebSocket. Returning
        // 503 until Desktop initializes would create a circular wait: Desktop
        // waits for readyz, while the mux waits for Desktop's initialize.
        const status = this.acceptingConnections ? 200 : 503;
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
      if (this.upstream !== ws || this.stopping) return;
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return this.#fail(new Error('App Server sent invalid JSON'), { code: 1007, reason: 'invalid JSON' });
      }
      if (isBinary) this.emit('log', 'upstream frame: binary UTF-8 JSON');
      this.#handleUpstreamMessage(message);
    });
    ws.on('error', (error) => {
      if (this.upstream === ws && this.started && this.listenerCount('error') > 0) this.emit('error', error);
    });
    ws.on('close', (code, reason) => {
      if (this.upstream !== ws || this.stopping) return;
      this.#handleUpstreamExit(new Error(`Upstream App Server closed (${code}${reason.length ? `: ${reason}` : ''})`), {
        code,
        reason: reason.toString(),
      }, ws);
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`Timed out connecting to ${this.upstreamUrl}`));
      }, UPSTREAM_CONNECT_TIMEOUT);
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
    if (this.upstream === ws && this.started && !this.stopping) {
      this.emit('log', 'upstream connected');
    }
    return ws;
  }

  #scheduleReconnect() {
    if (!this.started || this.stopping || this.reconnectTimer) return;
    const exponent = Math.min(this.reconnectAttempt, 31);
    const delay = Math.min(
      this.reconnectMaxDelayMs,
      this.reconnectBaseDelayMs * (2 ** exponent),
    );
    this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, 31);
    const generation = this.reconnectGeneration;
    this.emit('log', `upstream reconnect scheduled in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.#attemptReconnect(generation).catch((error) => {
        if (!this.started || this.stopping || generation !== this.reconnectGeneration) return;
        this.#handleUpstreamExit(error, { code: 1011, reason: 'reconnect failed' });
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  #cancelReconnect() {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  async #attemptReconnect(generation) {
    if (!this.started || this.stopping || generation !== this.reconnectGeneration) return;
    try {
      const ws = await this.#connectUpstream();
      if (!this.started || this.stopping || generation !== this.reconnectGeneration || this.upstream !== ws) {
        if (ws.readyState < WebSocket.CLOSING) ws.close(1000, 'RPC multiplexer stopped');
        if (this.started && !this.stopping && generation === this.reconnectGeneration) this.#scheduleReconnect();
        return;
      }
      if (this.initializeRequest) {
        this.#beginUpstreamInitialization(true);
      } else {
        this.reconnectAttempt = 0;
        this.reconnecting = false;
      }
    } catch (error) {
      if (!this.started || this.stopping || generation !== this.reconnectGeneration) return;
      if (this.upstream?.readyState < WebSocket.CLOSING) {
        this.upstream.terminate();
      }
      this.upstream = null;
      this.#scheduleReconnect();
    }
  }

  #beginUpstreamInitialization(reconnecting = false) {
    if (!this.initializeRequest || !this.upstream || this.upstream.readyState !== WebSocket.OPEN) return;
    if (this.upstreamInitialization) return;
    // The App Server permits initialize only once per socket. A replacement
    // socket therefore performs a fresh handshake from the first Desktop
    // initialize parameters; Desktop itself stays on the original socket.
    const upstreamId = this.#allocateUpstreamId();
    const pending = {
      source: reconnecting ? 'reconnect' : 'desktop',
      desktop: null,
      transport: null,
      originalId: null,
      method: 'initialize',
      initialize: true,
      reconnect: reconnecting,
    };
    this.pendingUpstream.set(rpcIdKey(upstreamId), pending);
    this.upstreamInitialization = pending;
    this.initializeAccepted = false;
    this.initialized = false;
    this.reconnecting = reconnecting;
    try {
      this.#sendUpstream({
        method: 'initialize',
        id: upstreamId,
        params: this.initializeRequest.params,
      });
      this.#clearUpstreamInitializeTimer();
      this.upstreamInitializeTimer = setTimeout(() => {
        if (this.upstreamInitialization !== pending) return;
        this.#handleUpstreamExit(
          new Error('Timed out initializing the App Server after reconnect'),
          { code: 1002, reason: 'initialize timeout' },
        );
      }, UPSTREAM_INITIALIZE_TIMEOUT);
      this.upstreamInitializeTimer.unref?.();
    } catch (error) {
      this.pendingUpstream.delete(rpcIdKey(upstreamId));
      this.upstreamInitialization = null;
      this.#handleUpstreamExit(error, { code: 1011, reason: 'initialize failed' });
    }
  }

  #acceptDesktop(socket) {
    if (!this.started || this.upstream?.readyState !== WebSocket.OPEN) {
      socket.close(1013, 'RPC multiplexer is unavailable');
      return;
    }
    if (this.desktop?.socket?.readyState === WebSocket.OPEN) {
      socket.close(1013, 'A desktop client is already connected');
      return;
    }
    const desktop = { socket, protocolReady: false, initializeMessage: null };
    this.desktop = desktop;
    this.emit('log', 'desktop connected');
    socket.on('message', (data, isBinary) => {
      if (this.desktop !== desktop) return;
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return socket.close(1007, 'Invalid JSON');
      }
      this.emit('log', `desktop message: ${String(message?.method || (message?.id != null ? 'response' : 'unknown'))}${isBinary ? ' (binary)' : ''}`);
      try {
        this.#handleDesktopMessage(desktop, message);
      } catch (error) {
        if (message?.id != null && message?.method) {
          this.#sendDesktop(desktop, { id: message.id, error: { code: -32_000, message: error.message } });
        } else if (this.reconnecting) {
          return;
        } else {
          socket.close(1011, 'RPC routing error');
        }
      }
    });
    socket.on('close', () => {
      const wasCurrentDesktop = this.desktop === desktop;
      if (wasCurrentDesktop) this.desktop = null;
      for (const [id, pending] of this.pendingUpstream.entries()) {
        // The upstream accepts initialize only once. Preserve an in-flight
        // initialize across a renderer reconnect so its response can be cached
        // and replayed to the replacement Desktop connection.
        if (pending.source === 'desktop' && pending.desktop === desktop && !pending.initialize) {
          this.pendingUpstream.delete(id);
        }
        if (pending.reconnect && pending.desktopInitialize?.desktop === desktop) {
          pending.desktopInitialize = null;
        }
      }
      desktop.initializeMessage = null;
      for (const [id, route] of this.desktopServerRequestIds.entries()) {
        if (route.desktop !== desktop) continue;
        const request = this.serverRequests.get(route.upstreamKey);
        if (request?.desktop === desktop) {
          request.desktop = null;
          request.desktopId = null;
        }
        this.desktopServerRequestIds.delete(id);
      }
      if (!wasCurrentDesktop) return;
      this.emit('desktopDisconnected');
      this.emit('log', 'desktop disconnected');
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
      const route = this.desktopServerRequestIds.get(desktopKey);
      if (!route) return;
      const request = this.serverRequests.get(route.upstreamKey);
      this.desktopServerRequestIds.delete(desktopKey);
      if (!request) return;
      this.#clearServerRequest(request.id);
      this.#sendUpstream({ ...message, id: request.id });
      return;
    }
    if (!message.method) return;
    if (message.method === 'initialized') {
      if (!this.initializeAccepted) {
        if (this.upstreamInitialization) {
          return;
        }
        throw new Error('initialize has not completed');
      }
      desktop.protocolReady = true;
      if (!this.initialized) {
        try {
          this.#sendUpstream(message);
          this.initialized = true;
          this.#resolveReady();
          this.emit('log', 'RPC multiplexer initialized');
        } catch (error) {
          this.#handleUpstreamExit(error, { code: 1011, reason: 'initialized failed' });
          return;
        }
      }
      this.#deliverPendingServerRequests(desktop);
      return;
    }
    if (!this.initialized || !desktop.protocolReady) throw new Error('RPC connection is not initialized');
    this.#sendUpstream(message);
  }

  #handleDesktopInitialize(desktop, message) {
    if (!this.initializeRequest) {
      this.initializeRequest = {
        params: this.#cloneRpcValue(message.params || {}),
      };
    }
    if (this.reconnecting && this.upstream?.readyState === WebSocket.OPEN && !this.upstreamInitialization) {
      this.#beginUpstreamInitialization(true);
    }
    if (this.initializeResponse && this.initialized) {
      this.#sendDesktop(desktop, { ...this.initializeResponse, id: message.id });
      this.#completeDesktopInitialization(desktop);
      return;
    }
    const pendingInitialize = [...this.pendingUpstream.values()].find((pending) => pending.initialize);
    if (pendingInitialize?.reconnect) {
      pendingInitialize.desktopInitialize = { desktop, id: message.id };
      return;
    }
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
    if (!this.upstream || this.upstream.readyState !== WebSocket.OPEN) {
      desktop.initializeMessage = message;
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
      if (pending === this.upstreamInitialization) {
        this.#clearUpstreamInitializeTimer();
        this.upstreamInitialization = null;
      }
      const routed = pending.originalId == null ? { ...message } : { ...message, id: pending.originalId };
      if (pending.initialize) {
        if (!message.error) {
          this.initializeAccepted = true;
          this.initializeResponse = { ...message };
          delete this.initializeResponse.id;
          this.emit('log', 'upstream initialize accepted');
        } else {
          const error = new Error(message.error.message || 'App Server initialization failed');
          if (pending.reconnect) {
            this.#handleUpstreamExit(error, { code: 1002, reason: 'initialize rejected' });
          } else {
            this.#rejectReady(error);
          }
        }
      }
      if (pending.source === 'desktop') this.#sendDesktop(pending.desktop, routed);
      else if (pending.source === 'internal') pending.transport.deliver(routed);
      if (pending.initialize && !message.error) {
        if (pending.reconnect) this.#completeUpstreamInitialization(pending);
        else this.#completeInitialization(pending.desktop);
      }
      return;
    }
    if (message.id != null && message.method) {
      const upstreamKey = rpcIdKey(message.id);
      if (this.pendingUpstream.has(upstreamKey) || this.serverRequests.has(upstreamKey)) {
        return this.#fail(new Error(`Duplicate upstream RPC id ${String(message.id)}`), {
          code: 1002,
          reason: 'duplicate upstream RPC id',
        });
      }
      if (this.serverRequests.size >= this.maxPendingRequests) {
        return this.#fail(new Error('RPC server request limit reached'), {
          code: 1013,
          reason: 'server request limit',
        });
      }
      this.serverRequests.set(upstreamKey, { id: message.id, message, desktop: null });
      for (const transport of this.internalTransports) transport.deliver(message);
      if (this.desktop?.protocolReady) this.#deliverServerRequestToDesktop(this.desktop, upstreamKey);
      return;
    }
    if (!message.method) return;
    if (message.method === 'serverRequest/resolved') {
      this.#clearServerRequest(message.params?.requestId);
    } else if (message.method === 'turn/completed') {
      const threadId = message.params?.threadId || null;
      const turnId = message.params?.turnId || message.params?.turn?.id || null;
      if (threadId || turnId) this.#pruneServerRequests({ threadId, turnId });
    } else if (message.method === 'thread/deleted') {
      const threadId = message.params?.threadId || null;
      if (threadId) this.#pruneServerRequests({ threadId });
    } else if (message.method === 'thread/status/changed') {
      const status = message.params?.status?.type || message.params?.status;
      const threadId = message.params?.threadId || null;
      if (status === 'idle' && threadId) this.#pruneServerRequests({ threadId });
    } else if (message.method === 'item/completed' && message.params?.item?.type === 'dynamicToolCall') {
      const threadId = message.params?.threadId || null;
      const turnId = message.params?.turnId || message.params?.turn?.id || null;
      const callId = message.params?.item?.id || null;
      if (threadId || turnId || callId) this.#pruneServerRequests({ threadId, turnId, callId });
    }
    for (const transport of this.internalTransports) transport.deliver(message);
    if (this.desktop?.protocolReady) this.#sendDesktop(this.desktop, message);
  }

  #deliverPendingServerRequests(desktop) {
    for (const upstreamKey of this.serverRequests.keys()) this.#deliverServerRequestToDesktop(desktop, upstreamKey);
  }

  #completeInitialization(desktop) {
    desktop.protocolReady = true;
    if (!this.initialized) {
      // Recent Desktop builds begin issuing RPC immediately after the successful
      // initialize response and omit the optional initialized notification. Send
      // it upstream on Desktop's behalf so both protocol variants work.
      try {
        this.#sendUpstream({ method: 'initialized', params: {} });
        this.initialized = true;
        this.#resolveReady();
        this.emit('log', 'RPC multiplexer initialized');
      } catch (error) {
        this.#handleUpstreamExit(error, { code: 1011, reason: 'initialized failed' });
        return;
      }
    }
    this.#completeDesktopInitialization(desktop);
  }

  #completeUpstreamInitialization(pending) {
    if (this.upstreamInitialization === pending) this.upstreamInitialization = null;
    if (!this.initialized) {
      try {
        this.#sendUpstream({ method: 'initialized', params: {} });
      } catch (error) {
        this.#handleUpstreamExit(error, { code: 1011, reason: 'initialized failed' });
        return;
      }
      this.initialized = true;
      this.reconnectAttempt = 0;
      this.reconnecting = false;
      this.#resolveReady();
      this.emit('log', 'RPC multiplexer initialized after upstream reconnect');
    }
    const queuedInitialize = pending.desktopInitialize;
    if (queuedInitialize?.desktop?.socket?.readyState === WebSocket.OPEN && this.initializeResponse) {
      this.#sendDesktop(queuedInitialize.desktop, { ...this.initializeResponse, id: queuedInitialize.id });
      this.#completeDesktopInitialization(queuedInitialize.desktop);
    }
    if (this.desktop?.initializeMessage) {
      const desktop = this.desktop;
      const message = desktop.initializeMessage;
      desktop.initializeMessage = null;
      this.#sendDesktop(desktop, { ...this.initializeResponse, id: message.id });
      this.#completeDesktopInitialization(desktop);
    }
    if (this.desktop) this.#deliverPendingServerRequests(this.desktop);
  }

  #completeDesktopInitialization(desktop) {
    if (!desktop) return;
    desktop.protocolReady = true;
    this.#deliverPendingServerRequests(desktop);
  }

  #deliverServerRequestToDesktop(desktop, upstreamKey) {
    const request = this.serverRequests.get(upstreamKey);
    if (!request || request.desktop === desktop) return;
    const desktopId = this.nextDesktopServerRequestId--;
    request.desktop = desktop;
    request.desktopId = desktopId;
    this.desktopServerRequestIds.set(rpcIdKey(desktopId), { upstreamKey, desktop });
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
    for (const [desktopKey, route] of this.desktopServerRequestIds.entries()) {
      if (route.upstreamKey === upstreamKey) this.desktopServerRequestIds.delete(desktopKey);
    }
    this.serverRequests.delete(upstreamKey);
  }

  #pruneServerRequests({ threadId = null, turnId = null, callId = null } = {}) {
    for (const request of [...this.serverRequests.values()]) {
      const params = request.message?.params || {};
      if (threadId && params.threadId !== threadId) continue;
      if (turnId && params.turnId !== turnId) continue;
      if (callId && params.callId !== callId && params.itemId !== callId) continue;
      this.#clearServerRequest(request.id);
    }
  }

  #allocateUpstreamId() {
    for (let attempts = 0; attempts < this.maxPendingRequests + 1; attempts += 1) {
      const candidate = this.nextUpstreamId++;
      if (this.nextUpstreamId >= Number.MAX_SAFE_INTEGER) this.nextUpstreamId = 1;
      const key = rpcIdKey(candidate);
      if (!this.pendingUpstream.has(key) && !this.serverRequests.has(key)) return candidate;
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

  #rejectPending(error, { preserveInitialize = false } = {}) {
    for (const pending of this.pendingUpstream.values()) {
      const preserveDesktopInitialize = pending.initialize && preserveInitialize && pending.source === 'desktop' && pending.desktop;
      if (preserveDesktopInitialize) {
        pending.desktop.initializeMessage = {
          id: pending.originalId,
          params: this.initializeRequest?.params || {},
        };
      }
      if (preserveDesktopInitialize) continue;
      if (pending.source === 'internal') {
        pending.transport.deliver({
          id: pending.originalId,
          error: { code: -32_000, message: error.message },
        });
      } else if (pending.source === 'desktop' && pending.originalId != null) {
        this.#sendDesktop(pending.desktop, {
          id: pending.originalId,
          error: { code: -32_000, message: error.message },
        });
      }
    }
    this.pendingUpstream.clear();
    const requestIds = [...this.serverRequests.values()].map((request) => request.id);
    for (const requestId of requestIds) {
      for (const transport of this.internalTransports) {
        transport.deliver({ method: 'serverRequest/resolved', params: { requestId } });
      }
    }
    this.serverRequests.clear();
    this.desktopServerRequestIds.clear();
  }

  #fail(error, event) {
    this.#handleUpstreamExit(error, event);
  }

  #handleUpstreamExit(error, event = {}, source = this.upstream) {
    if (!this.started || this.stopping) return;
    if (!source && !this.upstream) return;
    if (source && this.upstream !== source) return;
    const normalizedError = error instanceof Error ? error : new Error(String(error || 'Upstream App Server disconnected'));
    const upstream = source || this.upstream;
    this.upstream = null;
    this.initialized = false;
    this.initializeAccepted = false;
    this.reconnecting = true;
    this.#clearUpstreamInitializeTimer();
    this.upstreamInitialization = null;
    // A transport that is already waiting for the first initialize must keep
    // waiting through a transient upstream outage. Only stop() rejects it.
    if (!this.readyResolve && !this.readyReject) this.#resetReadyPromise();
    this.#rejectPending(normalizedError, { preserveInitialize: true });
    if (upstream && upstream.readyState < WebSocket.CLOSING) upstream.terminate();
    this.emit('upstreamExit', event);
    this.#scheduleReconnect();
  }

  #clearUpstreamInitializeTimer() {
    if (!this.upstreamInitializeTimer) return;
    clearTimeout(this.upstreamInitializeTimer);
    this.upstreamInitializeTimer = null;
  }

  #normalizeReconnectDelay(value, fallback) {
    const delay = Number(value);
    if (!Number.isFinite(delay) || delay < 0) return fallback;
    return Math.min(Math.floor(delay), 2_147_483_647);
  }

  #cloneRpcValue(value) {
    try {
      return structuredClone(value);
    } catch {
      return value;
    }
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
