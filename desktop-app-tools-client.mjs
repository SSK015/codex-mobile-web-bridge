import net from 'node:net';
import { randomUUID } from 'node:crypto';

const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;

export class DesktopAppToolsClient {
  constructor({
    pipePath = null,
    discoverPipePath = null,
    contextThreadId = null,
    connectTimeoutMs = 5_000,
    requestTimeoutMs = DEFAULT_TIMEOUT_MS,
    maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
  } = {}) {
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
    this.connectPromise = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.nextId = 1;
    this.toolsPromise = null;
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
    const path = this.fixedPipePath ?? await this.discoverPipePath();
    if (typeof path !== 'string' || !path) throw new Error('Desktop app tools pipe was not found');
    const socket = net.createConnection(path);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('Timed out connecting to Desktop app tools pipe'));
      }, this.connectTimeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        socket.off('connect', onConnect);
        socket.off('error', onError);
      };
      const onConnect = () => {
        cleanup();
        resolve();
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      socket.once('connect', onConnect);
      socket.once('error', onError);
    });
    if (this.stopped) {
      socket.destroy();
      throw new Error('Desktop app tools client is stopped');
    }
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => this.#onData(socket, chunk));
    socket.on('error', (error) => this.#disconnect(socket, error));
    socket.on('close', () => this.#disconnect(socket, new Error('Desktop app tools pipe closed')));
  }

  async request(method, params = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    await this.connect();
    const socket = this.socket;
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

  async listTools() {
    if (!this.toolsPromise) {
      this.toolsPromise = this.request('tools/list', { threadStartKind: 'all' })
        .then((result) => {
          const tools = Array.isArray(result?.tools) ? result.tools : [];
          return new Map(tools.map((tool) => [tool.name, tool]));
        })
        .catch((error) => {
          this.toolsPromise = null;
          throw error;
        });
    }
    return this.toolsPromise;
  }

  listThreads(args = {}, contextThreadId = this.contextThreadId) {
    return this.#callTool('list_threads', args, contextThreadId);
  }

  listProjects(args = {}, contextThreadId = this.contextThreadId) {
    return this.#callTool('list_projects', args, contextThreadId);
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
    const tool = tools.get(name);
    if (!tool) throw new Error(`Desktop app tool is unavailable: ${name}`);
    return this.request('tools/call', {
      arguments: args ?? {},
      callId: `mobile-${name}-${randomUUID()}`,
      namespace: tool.namespace,
      threadId: contextThreadId.trim(),
      tool: name,
      turnId: `mobile-${randomUUID()}`,
    });
  }

  close() {
    this.stopped = true;
    const socket = this.socket;
    this.socket = null;
    this.connectPromise = null;
    this.toolsPromise = null;
    this.buffer = Buffer.alloc(0);
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
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
    }
  }

  #disconnect(socket, error) {
    if (socket !== this.socket) return;
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
