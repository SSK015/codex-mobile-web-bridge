import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;

export class DesktopAppToolsClient extends EventEmitter {
  constructor({
    pipePath = null,
    discoverPipePath = null,
    contextThreadId = null,
    connectTimeoutMs = 5_000,
    requestTimeoutMs = DEFAULT_TIMEOUT_MS,
    maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
  } = {}) {
    super();
    if (!pipePath && typeof discoverPipePath !== 'function') {
      throw new TypeError('pipePath or discoverPipePath is required');
    }
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) {
      throw new TypeError('maxFrameBytes must be a positive safe integer');
    }
    this.fixedPipePath = pipePath;
    this.discoverPipePath = discoverPipePath;
    this.contextThreadId = typeof contextThreadId === 'string' && contextThreadId.trim()
      ? contextThreadId.trim()
      : null;
    this.connectTimeoutMs = connectTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxFrameBytes = maxFrameBytes;
    this.socket = null;
    this.connectingSocket = null;
    this.socketPaths = new WeakMap();
    this.failedPipePaths = new Set();
    this.connectPromise = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.nextId = 1;
    this.toolsPromise = null;
    this.toolConnections = new WeakMap();
    this.stopped = false;
  }

  get connected() {
    return Boolean(this.socket && !this.socket.destroyed);
  }

  async connect() {
    if (this.stopped) throw new Error('Desktop app tools client is stopped');
    if (this.connected) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.#connectOnce().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  async #connectOnce() {
    const path = this.fixedPipePath ?? await this.discoverPipePath({ excludePaths: [...this.failedPipePaths] });
    if (this.stopped) throw new Error('Desktop app tools client is stopped');
    if (typeof path !== 'string' || !path) throw new Error('Desktop app tools pipe was not found');
    const socket = net.createConnection(path);
    this.socketPaths.set(socket, path);
    this.connectingSocket = socket;
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => fail(new Error('Timed out connecting to Desktop app tools pipe')), this.connectTimeoutMs);
        const cleanup = () => {
          clearTimeout(timer);
          socket.off('connect', onConnect);
          socket.off('error', onError);
          socket.off('close', onClose);
        };
        const onConnect = () => {
          cleanup();
          resolve();
        };
        const fail = (error) => {
          cleanup();
          socket.destroy();
          reject(error);
        };
        const onError = (error) => fail(error);
        const onClose = () => fail(new Error('Desktop app tools pipe closed while connecting'));
        socket.once('connect', onConnect);
        socket.once('error', onError);
        socket.once('close', onClose);
      });
    } catch (error) {
      this.#markFailedPipe(socket);
      throw error;
    } finally {
      if (this.connectingSocket === socket) this.connectingSocket = null;
    }
    if (this.stopped) {
      socket.destroy();
      throw new Error('Desktop app tools client is stopped');
    }
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => this.#onData(socket, chunk));
    socket.on('error', (error) => this.#disconnect(socket, error));
    socket.on('close', () => this.#disconnect(socket, new Error('Desktop app tools pipe closed')));
    this.emit('connected');
  }

  async request(method, params = {}, { timeoutMs = this.requestTimeoutMs, expectedSocket = null } = {}) {
    // A tool namespace belongs to one connection. Never reconnect and replay a
    // tools/call after its original connection has gone away.
    if (!expectedSocket) await this.connect();
    const socket = this.socket;
    if (expectedSocket && socket !== expectedSocket) throw new Error('Desktop connection changed before sending; please retry');
    if (!socket || socket.destroyed) throw new Error('Desktop app tools pipe is not connected');
    const id = this.nextId++;
    const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }), 'utf8');
    if (payload.length > this.maxFrameBytes) throw new Error('Request frame is too large');
    const frame = Buffer.allocUnsafe(payload.length + 4);
    frame.writeUInt32LE(payload.length, 0);
    payload.copy(frame, 4);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method, socket });
      socket.write(frame, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  async listTools({ refresh = false, timeoutMs = this.requestTimeoutMs } = {}) {
    await this.connect();
    if (refresh) this.toolsPromise = null;
    if (!this.toolsPromise) {
      const socket = this.socket;
      const promise = this.request('tools/list', { threadStartKind: 'all' }, { timeoutMs, expectedSocket: socket })
        .then((result) => {
          if (!Array.isArray(result?.tools)) throw new Error('Desktop returned an invalid tools list');
          const tools = result.tools;
          const mapped = new Map(tools.map((tool) => [tool.name, tool]));
          this.toolConnections.set(mapped, socket);
          return mapped;
        })
        .catch((error) => {
          if (this.toolsPromise === promise) this.toolsPromise = null;
          throw error;
        });
      this.toolsPromise = promise;
    }
    return this.toolsPromise;
  }

  async checkConnection({ timeoutMs = 5_000 } = {}) {
    await this.connect();
    const socket = this.socket;
    try {
      const tools = await this.listTools({ refresh: true, timeoutMs });
      if (this.socket !== socket || !this.connected) throw new Error('Desktop connection changed during health check');
      if (!tools.has('list_threads') || !tools.has('send_message_to_thread')) {
        throw new Error('Desktop control tools are unavailable on this connection');
      }
      this.failedPipePaths.clear();
    } catch (error) {
      this.#disconnect(socket, error);
      throw error;
    }
  }

  listThreads(args = {}, contextThreadId = this.contextThreadId) {
    return this.#callTool('list_threads', args, contextThreadId);
  }

  listProjects(args = {}, contextThreadId = this.contextThreadId) {
    return this.#callTool('list_projects', args, contextThreadId);
  }

  getUsageLimits(args = {}, contextThreadId = this.contextThreadId) {
    return this.#callTool('get_usage_limits', args, contextThreadId);
  }

  createThread(args, contextThreadId = this.contextThreadId) {
    return this.#callTool('create_thread', args, contextThreadId);
  }

  readThread(args) {
    return this.#callTool('read_thread', args, args?.threadId);
  }

  waitThreads(args, contextThreadId = this.contextThreadId ?? args?.targets?.[0]?.threadId) {
    return this.#callTool('wait_threads', args, contextThreadId);
  }

  sendMessageToThread(args) {
    return this.#callTool('send_message_to_thread', args, args?.threadId);
  }

  async #callTool(name, args, contextThreadId = '') {
    if (typeof contextThreadId !== 'string' || !contextThreadId.trim()) {
      throw new Error(`Desktop app tool ${name} requires a context thread ID`);
    }
    const tools = await this.listTools();
    const socket = this.toolConnections.get(tools);
    const tool = tools.get(name);
    if (!tool) throw new Error(`Desktop app tool is unavailable: ${name}`);
    return this.request('tools/call', {
      arguments: args ?? {},
      // Desktop 26.924 requires the backing task source on the call envelope.
      // This bridge controls local Codex tasks, not ChatGPT conversations.
      callerSource: 'codex',
      callId: `mobile-${name}-${randomUUID()}`,
      namespace: tool.namespace,
      threadId: contextThreadId.trim(),
      tool: name,
      turnId: `mobile-${randomUUID()}`,
    }, { expectedSocket: socket });
  }

  close() {
    this.stopped = true;
    const socket = this.socket;
    this.socket = null;
    this.connectPromise = null;
    this.toolsPromise = null;
    this.buffer = Buffer.alloc(0);
    this.connectingSocket?.destroy();
    if (socket && !socket.destroyed) socket.destroy();
    this.#rejectPending(new Error('Desktop app tools client closed'));
  }

  #onData(socket, chunk) {
    if (socket !== this.socket) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > this.maxFrameBytes) {
        this.#disconnect(socket, new Error('Response frame is too large'));
        return;
      }
      if (this.buffer.length < length + 4) return;
      const payload = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      let message;
      try {
        message = JSON.parse(payload.toString('utf8'));
      } catch {
        this.#disconnect(socket, new Error('Desktop returned invalid JSON'));
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending || pending.socket !== socket) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(message.error.message || `${pending.method} failed`);
        error.code = message.error.code;
        error.data = message.error.data;
        if (message.error.code === -32602 && message.error.message === 'Invalid app tool request') {
          error.message = '桌面 Codex 拒绝了 Bridge 的调用格式，可能需要适配当前版本；无需接管任务或关闭桌面 Codex。';
          error.publicCode = 'DESKTOP_TOOL_PROTOCOL_MISMATCH';
          error.statusCode = 502;
        }
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
    }
  }

  #disconnect(socket, error) {
    if (!socket || socket !== this.socket) return;
    this.#markFailedPipe(socket);
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.toolsPromise = null;
    if (!socket.destroyed) socket.destroy();
    for (const [id, pending] of this.pending) {
      if (pending.socket !== socket) continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.emit('disconnected', error);
  }

  #markFailedPipe(socket) {
    const path = this.socketPaths.get(socket);
    if (path) {
      this.failedPipePaths.delete(path);
      this.failedPipePaths.add(path);
    }
    // Match the discovery limit so earlier failures cannot starve later pipes.
    if (this.failedPipePaths.size > 128) this.failedPipePaths.delete(this.failedPipePaths.values().next().value);
  }

  #rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export { DEFAULT_MAX_FRAME_BYTES };
