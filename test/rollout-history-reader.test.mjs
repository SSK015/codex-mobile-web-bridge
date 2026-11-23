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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const userMessage = (id, text, turn) => line({
  type: 'response_item',
  payload: {
    type: 'message',
    id,
    role: 'user',
    content: [{ type: 'input_text', text }],
    internal_chat_message_metadata_passthrough: { turn_id: turn },
  },
});
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

  // ① 同一线程有新旧两个 rollout（新文件是 `_<turnId>` 命名）时，取 mtime 最新的那个
  const newestRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rollout-reader-'));
  try {
    const legacyPath = path.join(newestRoot, `rollout-2026-08-25T15-18-28-${threadId}.jsonl`);
    const derivedPath = path.join(
      newestRoot,
      '2026',
      '09',
      '22',
      `rollout-2026-09-22T21-35-30-${threadId}_01a0c954-24f0-7c11-8b44-2e636bf1c2c6.jsonl`,
    );
    await fs.mkdir(path.dirname(derivedPath), { recursive: true });
    await fs.writeFile(legacyPath, userMessage('legacy-u1', '旧 rollout 的内容', turnId));
    await fs.writeFile(derivedPath, userMessage('derived-u1', '新 rollout 的内容', turnId));
    // 显式拉开 mtime，避免同毫秒写入让断言依赖文件系统时间精度
    const seconds = Date.now() / 1000;
    await fs.utimes(legacyPath, seconds - 600, seconds - 600);
    await fs.utimes(derivedPath, seconds, seconds);
    const nestedReader = new RolloutHistoryReader({ root: newestRoot, initialBytes: 1024 });
    const nestedTurns = await nestedReader.enrich(threadId, [{ id: turnId, status: 'inProgress', items: [] }]);
    assert.deepEqual(nestedTurns[0].items.map((item) => item.content[0].text), ['新 rollout 的内容']);
  } finally {
    await fs.rm(newestRoot, { recursive: true, force: true });
  }

  // ② 先解析到旧文件后，新文件出现（mtime 更新）要在索引 TTL 过期后被重新发现并切换
  const ttlRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rollout-reader-'));
  try {
    const oldPath = path.join(ttlRoot, `rollout-2026-08-25T15-18-28-${threadId}.jsonl`);
    await fs.writeFile(oldPath, userMessage('old-u1', '只有旧文件的内容', turnId));
    const seconds = Date.now() / 1000;
    await fs.utimes(oldPath, seconds - 600, seconds - 600);
    const ttlReader = new RolloutHistoryReader({ root: ttlRoot, initialBytes: 1024, indexTtlMs: 1000 });
    const first = await ttlReader.enrich(threadId, [{ id: turnId, status: 'inProgress', items: [] }]);
    assert.deepEqual(first[0].items.map((item) => item.content[0].text), ['只有旧文件的内容']);

    const newPath = path.join(ttlRoot, `rollout-2026-09-22T21-35-30-${threadId}_${turnId}-later.jsonl`);
    await fs.writeFile(newPath, userMessage('new-u1', '后出现的文件内容', turnId));
    await fs.utimes(newPath, seconds, seconds);

    // 索引还在 TTL 窗口内：仍读旧文件（原来的永久缓存会一直卡在这里）
    const cached = await ttlReader.enrich(threadId, [{ id: turnId, status: 'inProgress', items: [] }]);
    assert.deepEqual(cached[0].items.map((item) => item.content[0].text), ['只有旧文件的内容']);

    await sleep(1100);
    const refreshed = await ttlReader.enrich(threadId, [{ id: turnId, status: 'inProgress', items: [] }]);
    assert.deepEqual(refreshed[0].items.map((item) => item.content[0].text), ['后出现的文件内容']);
  } finally {
    await fs.rm(ttlRoot, { recursive: true, force: true });
  }

  // ③ 只存在 rollout-<时间>-<threadId>_<turnId>.jsonl 时也要能匹配
  const derivedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rollout-reader-'));
  try {
    const derivedOnly = path.join(
      derivedRoot,
      `rollout-2026-09-22T21-35-30-${threadId}_01a0c954-24f0-7c11-8b44-2e636bf1c2c6.jsonl`,
    );
    await fs.writeFile(derivedOnly, userMessage('derived-only-u1', '只存在派生命名的文件', turnId));
    const derivedReader = new RolloutHistoryReader({ root: derivedRoot, initialBytes: 1024 });
    const derivedTurns = await derivedReader.enrich(threadId, [{ id: turnId, status: 'inProgress', items: [] }]);
    assert.deepEqual(derivedTurns[0].items.map((item) => item.content[0].text), ['只存在派生命名的文件']);
  } finally {
    await fs.rm(derivedRoot, { recursive: true, force: true });
  }

  // ④ 别的线程的 rollout 不能被误匹配：线程 id 是另一个的前缀，或只是另一个的后缀片段
  const prefixRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rollout-reader-'));
  try {
    const longerThreadId = `${threadId}-longer`;
    const embeddedThreadId = `x${threadId}`;
    const untouched = [{ id: turnId, status: 'inProgress', items: [] }];
    const files = [
      [longerThreadId, '前缀线程的内容'],
      [embeddedThreadId, '后缀线程的内容'],
    ];
    for (const [id, text] of files) {
      await fs.writeFile(
        path.join(prefixRoot, `rollout-2026-09-22T21-35-30-${id}.jsonl`),
        userMessage(`msg-${id}`, text, turnId),
      );
    }
    const prefixReader = new RolloutHistoryReader({ root: prefixRoot, initialBytes: 1024 });
    assert.deepEqual(await prefixReader.enrich(threadId, untouched), untouched);
    for (const [id, text] of files) {
      const otherTurns = await prefixReader.enrich(id, [{ id: turnId, status: 'inProgress', items: [] }]);
      assert.deepEqual(otherTurns[0].items.map((item) => item.content[0].text), [text]);
    }
  } finally {
    await fs.rm(prefixRoot, { recursive: true, force: true });
  }
  console.log('rollout history reader tests passed');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
