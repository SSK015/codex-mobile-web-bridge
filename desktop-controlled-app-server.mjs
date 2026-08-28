import { EventEmitter } from 'node:events';

function controlledError(message, code, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function unwrap(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.contentItems)) return value;
  const item = value.contentItems.find((candidate) => candidate?.type === 'inputText');
  if (value.success === false) {
    throw controlledError(
      item?.text || 'Desktop control tool call failed',
      'DESKTOP_TOOL_CALL_FAILED',
      502,
    );
  }
  if (!item || typeof item.text !== 'string') return value;
  try {
    return JSON.parse(item.text);
  } catch {
    throw controlledError('Desktop control tool returned invalid inputText JSON', 'DESKTOP_TOOL_INVALID_JSON', 502);
  }
}

function threadIdOf(thread) {
  return String(thread?.id ?? thread?.threadId ?? '');
}

function turnIdOf(turn) {
  return String(turn?.id ?? turn?.turnId ?? '');
}

function isComplete(turn) {
  const status = String(turn?.status?.type ?? turn?.status ?? '').toLowerCase();
  return ['completed', 'complete', 'failed', 'cancelled', 'canceled', 'interrupted'].includes(status);
}

function textFromInput(textOrInput) {
  if (!Array.isArray(textOrInput)) return String(textOrInput ?? '').trim();
  const parts = [];
  for (const item of textOrInput) {
    if ((item?.type === 'text' || item?.type === 'inputText') && item.text != null) {
      parts.push(String(item.text));
      continue;
    }
    if (item?.type === 'localImage' && item.path) parts.push(`[Image attachment: ${item.path}]`);
    if (item?.type === 'mention' && item.path) parts.push(`[File attachment: ${item.path}]`);
  }
  return parts.join('\n\n').trim();
}

function mapThread(summary, turns = undefined) {
  const id = threadIdOf(summary);
  const mapped = {
    ...summary,
    id,
    name: summary?.name ?? summary?.title ?? id,
  };
  if (turns !== undefined) mapped.turns = turns;
  return mapped;
}

export class DesktopControlledAppServer extends EventEmitter {
  constructor({
    client,
    clientFactory = null,
    pollIntervalMs = 350,
    startTimeoutMs = 20_000,
    completionTimeoutMs = 24 * 60 * 60 * 1_000,
    readTurnLimit = 10,
  } = {}) {
    super();
    if (!client && typeof clientFactory !== 'function') {
      throw new TypeError('client or clientFactory is required');
    }
    this.client = client ?? null;
    this.clientFactory = clientFactory;
    this.pollIntervalMs = pollIntervalMs;
    this.startTimeoutMs = startTimeoutMs;
    this.completionTimeoutMs = completionTimeoutMs;
    this.readTurnLimit = readTurnLimit;
    this.ready = false;
    this.serverRequests = new Map();
    this.stopping = false;
    this.pollers = new Map();
  }

  async start() {
    if (this.ready) return;
    if (!this.client) this.client = this.clientFactory();
    this.stopping = false;
    await this.client.connect();
    this.ready = true;
    this.emit('ready');
  }

  async stop() {
    this.stopping = true;
    this.ready = false;
    for (const [poller, resolve] of this.pollers) {
      clearTimeout(poller);
      resolve();
    }
    this.pollers.clear();
    this.client?.close();
    if (this.clientFactory) this.client = null;
  }

  async restart() {
    if (!this.clientFactory) {
      throw controlledError('Restart requires a clientFactory', 'DESKTOP_CONTROL_RESTART_UNSUPPORTED', 501);
    }
    await this.stop();
    await this.start();
  }

  async listThreads({ searchTerm = null, limit = 100, cursor = null } = {}) {
    this.#assertReady();
    if (cursor) return { data: [], nextCursor: null };
    const result = unwrap(await this.client.listThreads({ limit: Math.max(1, Math.min(Number(limit) || 50, 50)) }));
    const all = [
      ...(result?.pinnedThreads ?? []).map((thread) => ({ ...thread, isPinned: true })),
      ...(result?.threads ?? result?.data ?? []),
    ];
    const seen = new Set();
    const data = all
      .filter((thread) => {
        const id = threadIdOf(thread);
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return !searchTerm || String(thread?.title ?? thread?.name ?? '').toLowerCase().includes(String(searchTerm).toLowerCase());
      })
      .slice(0, limit)
      .map((thread) => mapThread(thread));
    return { data, nextCursor: null };
  }

  async readThread(threadId, { includeTurns = true } = {}) {
    this.#assertReady();
    const result = unwrap(await this.client.readThread({
      threadId,
      turnLimit: includeTurns ? Math.min(this.readTurnLimit, 10) : 1,
      includeOutputs: includeTurns,
    }));
    const source = result?.thread ?? result ?? {};
    let turns = includeTurns ? [...(result?.turns ?? source?.turns ?? [])] : [];
    if (includeTurns && result?.page?.order === 'newest_first') turns.reverse();
    return { thread: mapThread({ ...source, id: threadIdOf(source) || String(threadId) }, turns) };
  }

  resumeThread(threadId, { excludeTurns = false } = {}) {
    return this.readThread(threadId, { includeTurns: !excludeTurns });
  }

  async listTurns(threadId, { cursor = null, limit = 24, sortDirection = 'desc' } = {}) {
    this.#assertReady();
    if (sortDirection !== 'desc') {
      throw controlledError('Desktop control channel only supports newest-first turn pages', 'DESKTOP_CONTROL_SORT_UNSUPPORTED', 501);
    }
    const result = unwrap(await this.client.readThread({
      threadId,
      ...(cursor ? { cursor: String(cursor) } : {}),
      turnLimit: Math.max(1, Math.min(Number(limit) || 10, 10)),
      includeOutputs: true,
      maxOutputCharsPerItem: 20_000,
    }));
    return {
      data: [...(result?.turns ?? result?.thread?.turns ?? [])],
      nextCursor: result?.page?.nextCursor ?? null,
    };
  }

  async startTurn(threadId, textOrInput) {
    this.#assertReady();
    const prompt = textFromInput(textOrInput);
    if (!prompt) throw controlledError('Message is empty', 'DESKTOP_CONTROL_EMPTY_MESSAGE', 400);
    const before = await this.readThread(threadId, { includeTurns: true });
    const known = new Set((before.thread.turns ?? []).map(turnIdOf));
    await this.client.sendMessageToThread({ threadId, prompt });
    const turn = await this.#waitForNewTurn(threadId, known);
    const message = { method: 'turn/started', params: { threadId, turn } };
    this.emit('notification', message);
    this.#pollCompletion(threadId, turnIdOf(turn));
    return { turn };
  }

  steerTurn() {
    return Promise.reject(controlledError(
      'Desktop control channel cannot steer an active turn',
      'DESKTOP_CONTROL_STEER_UNSUPPORTED',
      501,
    ));
  }

  interruptTurn() {
    return Promise.reject(controlledError(
      'Desktop control channel cannot interrupt an active turn',
      'DESKTOP_CONTROL_INTERRUPT_UNSUPPORTED',
      501,
    ));
  }

  startThread() {
    return Promise.reject(controlledError(
      'Desktop control channel cannot create a task',
      'DESKTOP_CONTROL_START_THREAD_UNSUPPORTED',
      501,
    ));
  }

  respondToServerRequest() {
    throw controlledError('Desktop control channel has no approval requests', 'DESKTOP_CONTROL_APPROVAL_UNSUPPORTED', 501);
  }

  #assertReady() {
    if (!this.ready) throw controlledError('Desktop control channel is not ready', 'DESKTOP_CONTROL_NOT_READY', 503);
  }

  async #waitForNewTurn(threadId, known) {
    const deadline = Date.now() + this.startTimeoutMs;
    while (!this.stopping && Date.now() < deadline) {
      const result = await this.readThread(threadId, { includeTurns: true });
      const turn = [...(result.thread.turns ?? [])].reverse().find((candidate) => {
        const id = turnIdOf(candidate);
        return id && !known.has(id);
      });
      if (turn) return turn;
      await this.#delay(this.pollIntervalMs);
    }
    throw controlledError('Timed out waiting for Desktop to start the turn', 'DESKTOP_CONTROL_TURN_START_TIMEOUT', 504);
  }

  async #pollCompletion(threadId, turnId) {
    const deadline = Date.now() + this.completionTimeoutMs;
    try {
      while (!this.stopping && Date.now() < deadline) {
        const result = await this.readThread(threadId, { includeTurns: true });
        const turn = (result.thread.turns ?? []).find((candidate) => turnIdOf(candidate) === turnId);
        if (turn && isComplete(turn)) {
          this.emit('notification', { method: 'turn/completed', params: { threadId, turn } });
          return;
        }
        await this.#delay(this.pollIntervalMs);
      }
      if (!this.stopping) this.emit('error', controlledError(
        'Timed out waiting for Desktop turn completion',
        'DESKTOP_CONTROL_TURN_COMPLETION_TIMEOUT',
        504,
      ));
    } catch (error) {
      if (!this.stopping) this.emit('error', error);
    }
  }

  #delay(milliseconds) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pollers.delete(timer);
        resolve();
      }, milliseconds);
      this.pollers.set(timer, resolve);
    });
  }
}

export { controlledError, textFromInput, unwrap };
