import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RolloutHistoryReader } from '../rollout-history-reader.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rollout-reader-'));
const threadId = 'thread-test';
const turnId = 'turn-new';
const file = path.join(root, `rollout-${threadId}.jsonl`);
const line = (value) => `${JSON.stringify(value)}\n`;
try {
  await fs.writeFile(file, [
    line({ type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } }),
    line({ type: 'response_item', payload: { type: 'message', id: 'u1', role: 'user', content: [{ type: 'input_text', text: 'hello' }], internal_chat_message_metadata_passthrough: { turn_id: turnId } } }),
  ].join(''));
  const reader = new RolloutHistoryReader({ root, initialBytes: 1024 });
  let turns = await reader.enrich(threadId, [{ id: turnId, status: 'inProgress', items: [] }]);
  assert.equal(turns[0].items[0].content[0].text, 'hello');
  await fs.appendFile(file, line({ type: 'response_item', payload: { type: 'message', id: 'a1', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'world' }], internal_chat_message_metadata_passthrough: { turn_id: turnId } } }));
  turns = await reader.enrich(threadId, [{ id: turnId, status: 'completed', items: [] }]);
  assert.equal(turns[0].items[1].text, 'world');
  assert.equal(turns[0].items[1].phase, 'final_answer');

  const callId = 'call_rollout_test';
  await fs.appendFile(file, line({
    type: 'response_item',
    payload: {
      type: 'custom_tool_call',
      id: 'ctc-rollout-test',
      call_id: callId,
      name: 'exec',
      status: 'completed',
      input: '{"schema":"must not be exposed"}',
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    },
  }));
  turns = await reader.enrich(threadId, [{ id: turnId, status: 'inProgress', items: [] }]);
  const runningTool = turns[0].items.find((item) => item.id === callId);
  assert.equal(runningTool.type, 'commandExecution');
  assert.equal(runningTool.status, 'inProgress');
  assert.equal('input' in runningTool, false);
  assert.equal('output' in runningTool, false);

  await fs.appendFile(file, line({
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      turn_id: turnId,
      item: {
        type: 'CommandExecution',
        id: 'exec-rollout-test',
        command: ['pwsh', '-Command', 'Write-Output synthetic'],
        cwd: 'C:\\private\\workspace',
        status: 'completed',
        stdout: 'private output must not be restored',
        exit_code: 0,
      },
    },
  }));
  turns = await reader.enrich(threadId, [{
    id: turnId,
    status: 'inProgress',
    items: [{ id: 'remote-agent', type: 'agentMessage', text: 'remote summary' }],
  }]);
  const completedTool = turns[0].items.find((item) => item.id === callId);
  assert.equal(completedTool.status, 'completed');
  assert.deepEqual(completedTool.command, ['pwsh', '-Command', 'Write-Output synthetic']);
  assert.equal('cwd' in completedTool, false);
  assert.equal('stdout' in completedTool, false);
  assert.equal(turns[0].items.filter((item) => item._rolloutTool).length, 1);

  await fs.appendFile(file, line({
    type: 'response_item',
    payload: {
      type: 'custom_tool_call_output',
      id: 'ctco-rollout-test',
      call_id: callId,
      output: [{ type: 'inputText', text: 'private output must not be restored' }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    },
  }));
  turns = await reader.enrich(threadId, [{ id: turnId, status: 'completed', items: [] }]);
  assert.equal(turns[0].items.filter((item) => item._rolloutTool).length, 1);
  assert.equal(JSON.stringify(turns[0]).includes('private output'), false);
  console.log('rollout history reader tests passed');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
