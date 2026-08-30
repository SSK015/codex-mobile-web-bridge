import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_INITIAL_BYTES = 8 * 1024 * 1024;
const TOOL_TYPES = new Set([
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'webSearch',
  'collabToolCall',
  'collabAgentToolCall',
  'dynamicToolCall',
]);

function boundedIdentifier(value, fallback = 'rollout-tool') {
  const normalized = String(value || '').replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 160);
  return normalized || fallback;
}

function boundedToolName(value, fallback = 'tool') {
  const normalized = String(value || '').replace(/[^a-zA-Z0-9._:/-]/g, '_').slice(0, 120);
  return normalized || fallback;
}

function toolTypeFromName(name) {
  const normalized = String(name || '').toLowerCase();
  if (normalized === 'exec' || normalized.includes('exec_command')) return 'commandExecution';
  if (normalized.includes('apply_patch') || normalized.includes('file_change')) return 'fileChange';
  if (normalized === 'web__run' || normalized.includes('web_search')) return 'webSearch';
  if (normalized.startsWith('mcp__')) return 'mcpToolCall';
  if (normalized.includes('collaboration') || normalized.includes('spawn_agent')) return 'collabToolCall';
  return 'dynamicToolCall';
}

function toolParts(name) {
  const value = boundedToolName(name);
  const mcp = value.match(/^mcp__([^_]+)__(.+)$/i);
  if (mcp) return { namespace: mcp[1], server: mcp[1], tool: mcp[2] };
  const separator = value.indexOf('__');
  if (separator > 0) return { namespace: value.slice(0, separator), tool: value.slice(separator + 2) };
  return { namespace: 'Codex', tool: value };
}

function customToolItem(payload, callId) {
  const type = toolTypeFromName(payload?.name);
  const parts = toolParts(payload?.name);
  const base = {
    id: callId,
    type,
    status: 'inProgress',
    _rolloutTool: true,
    _rolloutCallId: callId,
  };
  if (type === 'commandExecution') return { ...base, command: [] };
  if (type === 'fileChange') return { ...base, changes: [] };
  if (type === 'mcpToolCall') return { ...base, server: parts.server, tool: parts.tool };
  if (type === 'webSearch') return base;
  if (type === 'collabToolCall') return { ...base, tool: parts.tool };
  return { ...base, namespace: parts.namespace, tool: parts.tool };
}

function normalizeCompletedToolType(value) {
  const compact = String(value || '').replace(/[^a-z]/gi, '').toLowerCase();
  return {
    commandexecution: 'commandExecution',
    filechange: 'fileChange',
    mcptoolcall: 'mcpToolCall',
    websearch: 'webSearch',
    collabtoolcall: 'collabToolCall',
    collabagenttoolcall: 'collabAgentToolCall',
    dynamictoolcall: 'dynamicToolCall',
  }[compact] || null;
}

function boundedCommand(command) {
  if (Array.isArray(command)) return command.slice(0, 8).map((value) => String(value).slice(0, 2_000));
  return String(command || '').slice(0, 4_000);
}

function completedToolFields(item, type) {
  const failed = /fail|error|declin|cancel/i.test(String(item?.status || ''))
    || (type === 'commandExecution' && Number.isFinite(Number(item?.exit_code)) && Number(item.exit_code) !== 0);
  const base = { type, status: failed ? 'failed' : 'completed', _rolloutTool: true, _rolloutEventCompleted: true };
  if (type === 'commandExecution') return { ...base, command: boundedCommand(item?.command) };
  if (type === 'fileChange') {
    const changes = Array.isArray(item?.changes)
      ? item.changes.slice(0, 64).map((change) => ({ path: path.basename(String(change?.path || '')).slice(0, 240) })).filter((change) => change.path)
      : [];
    return { ...base, changes };
  }
  if (type === 'mcpToolCall') return { ...base, server: boundedToolName(item?.server, 'mcp'), tool: boundedToolName(item?.tool) };
  if (type === 'collabToolCall' || type === 'collabAgentToolCall') return { ...base, tool: boundedToolName(item?.tool) };
  if (type === 'dynamicToolCall') return {
    ...base,
    namespace: boundedToolName(item?.namespace, 'Codex'),
    tool: boundedToolName(item?.tool),
  };
  return base;
}

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
      if (!local) return turn;
      const remoteItems = Array.isArray(turn?.items) ? turn.items : [];
      if (remoteItems.length === 0) return { ...turn, items: [...local.items] };
      const remoteIds = new Set(remoteItems.map((item) => String(item?.id || '')).filter(Boolean));
      const missingTools = local.items.filter((item) => item?._rolloutTool && !remoteIds.has(String(item.id || '')));
      return missingTools.length > 0 ? { ...turn, items: [...remoteItems, ...missingTools] } : turn;
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
      turn = {
        id: turnId,
        items: [],
        itemIds: new Set(),
        toolCallItems: new Map(),
        completedToolCalls: new Set(),
      };
      state.turns.set(turnId, turn);
      while (state.turns.size > 64) state.turns.delete(state.turns.keys().next().value);
    }
    if (record.type === 'event_msg' && payload.type === 'task_started') turn.status = 'inProgress';
    if (record.type === 'event_msg' && payload.type === 'task_complete') {
      turn.status = 'completed';
      for (const item of turn.toolCallItems.values()) {
        if (/progress|running|started/i.test(String(item.status || ''))) item.status = 'completed';
      }
    }
    if (record.type === 'response_item' && payload.type === 'custom_tool_call') {
      const callId = boundedIdentifier(payload.call_id || payload.id, `rollout-tool-${turn.items.length + 1}`);
      let item = turn.toolCallItems.get(callId);
      if (!item) {
        item = customToolItem(payload, callId);
        if (turn.completedToolCalls.has(callId)) item.status = 'completed';
        turn.toolCallItems.set(callId, item);
        if (!turn.itemIds.has(item.id)) {
          turn.itemIds.add(item.id);
          turn.items.push(item);
        }
      }
      return;
    }
    if (record.type === 'response_item' && payload.type === 'custom_tool_call_output') {
      const callId = boundedIdentifier(payload.call_id || payload.id, `rollout-tool-output-${turn.items.length + 1}`);
      turn.completedToolCalls.add(callId);
      const item = turn.toolCallItems.get(callId);
      if (item) item.status = 'completed';
      else {
        const placeholder = {
          id: callId,
          type: 'dynamicToolCall',
          namespace: 'Codex',
          tool: 'tool',
          status: 'completed',
          _rolloutTool: true,
          _rolloutCallId: callId,
        };
        turn.toolCallItems.set(callId, placeholder);
        if (!turn.itemIds.has(placeholder.id)) {
          turn.itemIds.add(placeholder.id);
          turn.items.push(placeholder);
        }
      }
      return;
    }
    if (record.type === 'event_msg' && payload.type === 'item_completed') {
      const type = normalizeCompletedToolType(payload.item?.type);
      if (type && TOOL_TYPES.has(type)) {
        const matching = [...turn.toolCallItems.values()].reverse().find((item) => item.type === type && !item._rolloutEventCompleted);
        if (matching) Object.assign(matching, completedToolFields(payload.item, type));
        else {
          const id = boundedIdentifier(payload.item?.id, `rollout-${type}-${turn.items.length + 1}`);
          if (!turn.itemIds.has(id)) {
            turn.itemIds.add(id);
            turn.items.push({ id, ...completedToolFields(payload.item, type) });
          }
        }
      }
      return;
    }
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
