import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const SOURCE_KINDS = [
  'cli',
  'vscode',
  'exec',
  'appServer',
  'subAgent',
  'subAgentReview',
  'subAgentCompact',
  'subAgentThreadSpawn',
  'subAgentOther',
  'unknown',
];

export class CodexAppServer extends EventEmitter {
  constructor({ codexPath, cwd, websocketUrl = null, rpcTransport = null }) {
    super();
    this.codexPath = codexPath;
    this.cwd = cwd;
    this.websocketUrl = websocketUrl;
    this.rpcTransport = rpcTransport;
    this.child = null;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.serverRequests = new Map();
    this.ready = false;
    this.stopping = false;
    this.rpcTransportHandlersAttached = false;
  }

  async start() {
    if (this.child || this.ws || this.rpcTransport?.active) return;
    this.stopping = false;
    if (this.rpcTransport) {
      this.#startRpcTransport();
      await this.rpcTransport.start();
    } else {
      if (this.websocketUrl) await this.#startWebSocket();
      else this.#startStdio();

      await this.request('initialize', {
        clientInfo: {
          name: 'codex-mobile-web',
          title: 'Codex Mobile Web',
          version: '0.2.0',
        },
        capabilities: {
          experimentalApi: true,
        },
      });
      this.notify('initialized', {});
    }
    this.ready = true;
    this.emit('ready');
  }

  #startRpcTransport() {
    if (this.rpcTransportHandlersAttached) return;
    this.rpcTransportHandlersAttached = true;
    const transport = this.rpcTransport;
    transport.on('message', (message) => this.#handleMessage(message));
    transport.on('error', (error) => this.emit('error', error));
    transport.on('log', (message) => this.emit('log', message));
    transport.on('close', (event = {}) => {
      if (this.rpcTransport !== transport) return;
      this.#rejectPending(new Error(`Codex App Server RPC transport closed (${event.code ?? 'unknown'}${event.reason ? `: ${event.reason}` : ''})`));
      this.ready = false;
      this.emit('exit', { ...event, intentional: this.stopping });
    });
  }

  #startStdio() {
    const child = spawn(this.codexPath, ['app-server', '--stdio'], {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;

    child.on('error', (error) => this.emit('error', error));
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) this.emit('log', text);
    });
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.#rejectPending(new Error(`Codex App Server exited (${code ?? signal ?? 'unknown'})`));
      this.child = null;
      this.ready = false;
      this.emit('exit', { code, signal, intentional: this.stopping });
    });

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      this.#handleMessage(message);
    });
  }

  async #startWebSocket() {
    const ws = new WebSocket(this.websocketUrl);
    this.ws = ws;
    ws.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      this.#handleMessage(message);
    });
    ws.addEventListener('error', () => {
      if (this.ws === ws) this.emit('error', new Error(`WebSocket transport error for ${this.websocketUrl}`));
    });
    ws.addEventListener('close', (event) => {
      if (this.ws !== ws) return;
      this.#rejectPending(new Error(`Codex App Server WebSocket closed (${event.code}${event.reason ? `: ${event.reason}` : ''})`));
      this.ws = null;
      this.ready = false;
      this.emit('exit', { code: event.code, reason: event.reason, intentional: this.stopping });
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out connecting to ${this.websocketUrl}`)), 15_000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      ws.addEventListener('close', (event) => {
        clearTimeout(timer);
        reject(new Error(`WebSocket closed before initialization (${event.code})`));
      }, { once: true });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`Unable to connect to ${this.websocketUrl}`));
      }, { once: true });
    });
  }

  async restart() {
    await this.stop();
    await this.start();
  }

  async stop() {
    if (!this.child && !this.ws && !this.rpcTransport?.active) return;
    this.stopping = true;
    if (this.rpcTransport?.active) {
      await this.rpcTransport.stop();
      this.#rejectPending(new Error('Codex App Server RPC transport stopped'));
      this.ready = false;
      return;
    }
    if (this.ws) {
      const ws = this.ws;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        ws.addEventListener('close', () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
        ws.close(1000, 'mobile bridge disconnect');
      });
      if (this.ws === ws) {
        this.ws = null;
        this.ready = false;
      }
      return;
    }
    const child = this.child;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.stdin.end();
      child.kill();
    });
  }

  request(method, params = {}, timeoutMs = 60_000) {
    if (!this.#isWritable()) {
      return Promise.reject(new Error('Codex App Server is not running'));
    }
    const id = this.nextId++;
    const message = { method, id, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.#write(message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    this.#write({ method, params });
  }

  respondToServerRequest(id, result) {
    if (!this.serverRequests.has(String(id))) {
      throw new Error('Approval request is no longer pending');
    }
    this.#write({ id, result });
    this.serverRequests.delete(String(id));
  }

  listThreads({ searchTerm = null, limit = 100, cursor = null } = {}) {
    return this.request('thread/list', {
      cursor,
      limit,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      sourceKinds: SOURCE_KINDS,
      ...(searchTerm ? { searchTerm } : {}),
    });
  }

  startThread({ cwd = null, ephemeral = false } = {}) {
    return this.request('thread/start', {
      cwd,
      ephemeral,
      historyMode: 'paginated',
    }, 120_000);
  }

  resumeThread(threadId, { excludeTurns = false, initialTurnsPage = null } = {}) {
    return this.request('thread/resume', {
      threadId,
      ...(excludeTurns ? { excludeTurns: true } : {}),
      ...(initialTurnsPage ? { initialTurnsPage } : {}),
    }, 120_000);
  }

  readThread(threadId, { includeTurns = true } = {}) {
    return this.request('thread/read', { threadId, includeTurns }, 120_000);
  }

  listTurns(threadId, { cursor = null, limit = 24, sortDirection = 'desc', itemsView = 'full' } = {}) {
    return this.request('thread/turns/list', {
      threadId,
      cursor,
      limit,
      sortDirection,
      itemsView,
    }, 120_000);
  }

  startTurn(threadId, textOrInput) {
    const input = Array.isArray(textOrInput)
      ? textOrInput
      : [{ type: 'text', text: String(textOrInput || '') }];
    return this.request('turn/start', {
      threadId,
      input,
    }, 120_000);
  }

  steerTurn(threadId, turnId, textOrInput) {
    const input = Array.isArray(textOrInput)
      ? textOrInput
      : [{ type: 'text', text: String(textOrInput || '') }];
    return this.request('turn/steer', {
      threadId,
      expectedTurnId: turnId,
      input,
    }, 120_000);
  }

  interruptTurn(threadId, turnId) {
    return this.request('turn/interrupt', { threadId, turnId });
  }

  #write(message) {
    if (this.rpcTransport?.ready) {
      this.rpcTransport.send(message);
      return;
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      return;
    }
    if (this.child?.stdin?.writable) {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
      return;
    }
    throw new Error('Codex App Server is not running');
  }

  #isWritable() {
    return Boolean(this.rpcTransport?.ready) || this.ws?.readyState === WebSocket.OPEN || Boolean(this.child?.stdin?.writable);
  }

  #rejectPending(error) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
    this.serverRequests.clear();
  }

  #handleMessage(message) {
    if (message.id != null && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
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
      return;
    }

    if (message.id != null && message.method) {
      this.serverRequests.set(String(message.id), message);
      this.emit('serverRequest', message);
      return;
    }

    if (message.method) {
      if (message.method === 'serverRequest/resolved') {
        const requestId = String(message.params?.requestId ?? '');
        if (requestId) this.serverRequests.delete(requestId);
      }
      this.emit('notification', message);
    }
  }
}

export function isActiveWriterError(error) {
  return /active writer/i.test(String(error?.message || ''));
}

export async function resumeThreadWithReadFallback(appServer, threadId, {
  allowReadFallback = false,
  resumeOptions = { excludeTurns: true },
} = {}) {
  try {
    return {
      result: await appServer.resumeThread(threadId, resumeOptions),
      desktopWriter: false,
    };
  } catch (error) {
    if (!allowReadFallback || !isActiveWriterError(error)) throw error;
    return {
      result: await appServer.readThread(threadId, { includeTurns: false }),
      desktopWriter: true,
    };
  }
}

export { SOURCE_KINDS };
