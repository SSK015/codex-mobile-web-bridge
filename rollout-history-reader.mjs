import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_INITIAL_BYTES = 8 * 1024 * 1024;

function turnIdOf(payload) {
  return String(payload?.turn_id ?? payload?.internal_chat_message_metadata_passthrough?.turn_id ?? '');
}

function messageItem(payload) {
  const text = (payload?.content || []).map((part) => part?.text).filter(Boolean).join('\n');
  if (!text) return null;
  if (payload.role === 'user') {
    return { type: 'userMessage', id: payload.id, content: [{ type: 'text', text }] };
  }
  if (payload.role === 'assistant') {
    return { type: 'agentMessage', id: payload.id, text, phase: payload.phase || null };
  }
  return null;
}

export class RolloutHistoryReader {
  constructor({ root, initialBytes = DEFAULT_INITIAL_BYTES } = {}) {
    this.root = root || null;
    this.initialBytes = initialBytes;
    this.states = new Map();
    this.paths = new Map();
  }

  async enrich(threadId, turns) {
    if (!this.root || !threadId || !Array.isArray(turns)) return turns;
    const state = await this.#update(String(threadId));
    if (!state) return turns;
    return turns.map((turn) => {
      const local = state.turns.get(String(turn?.id || ''));
      if (!local || (Array.isArray(turn?.items) && turn.items.length > 0)) return turn;
      return { ...turn, items: [...local.items] };
    });
  }

  async #update(threadId) {
    const filePath = await this.#find(threadId);
    if (!filePath) return null;
    const stat = await fs.stat(filePath);
    let state = this.states.get(threadId);
    if (!state || state.path !== filePath || stat.size < state.offset) {
      state = {
        path: filePath,
        offset: Math.max(0, stat.size - this.initialBytes),
        discardFirstPartialLine: stat.size > this.initialBytes,
        turns: new Map(),
      };
      this.states.set(threadId, state);
    }
    if (stat.size === state.offset) return state;
    const handle = await fs.open(filePath, 'r');
    try {
      const length = stat.size - state.offset;
      const buffer = Buffer.allocUnsafe(length);
      await handle.read(buffer, 0, length, state.offset);
      let text = buffer.toString('utf8');
      if (state.discardFirstPartialLine) {
        text = text.slice(text.indexOf('\n') + 1);
        state.discardFirstPartialLine = false;
      }
      state.offset = stat.size;
      for (const line of text.split('\n')) this.#consume(state, line);
    } finally {
      await handle.close();
    }
    return state;
  }

  #consume(state, line) {
    if (!line) return;
    let record;
    try { record = JSON.parse(line); } catch { return; }
    const payload = record?.payload || {};
    const turnId = turnIdOf(payload);
    if (!turnId) return;
    let turn = state.turns.get(turnId);
    if (!turn) {
      turn = { id: turnId, items: [], itemIds: new Set() };
      state.turns.set(turnId, turn);
      while (state.turns.size > 64) state.turns.delete(state.turns.keys().next().value);
    }
    if (record.type === 'event_msg' && payload.type === 'task_started') turn.status = 'inProgress';
    if (record.type === 'event_msg' && payload.type === 'task_complete') turn.status = 'completed';
    if (record.type !== 'response_item' || payload.type !== 'message') return;
    const item = messageItem(payload);
    if (!item || !item.id || turn.itemIds.has(item.id)) return;
    turn.itemIds.add(item.id);
    turn.items.push(item);
  }

  async #find(threadId) {
    if (this.paths.has(threadId)) return this.paths.get(threadId);
    const suffix = `${threadId}.jsonl`.toLowerCase();
    const stack = [this.root];
    while (stack.length) {
      const directory = stack.pop();
      let entries;
      try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory()) stack.push(candidate);
        else if (entry.name.toLowerCase().endsWith(suffix)) {
          this.paths.set(threadId, candidate);
          return candidate;
        }
      }
    }
    this.paths.set(threadId, null);
    return null;
  }
}
