import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DesktopAppToolsClient } from '../desktop-app-tools-client.mjs';

function socketPath(label) {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\codex-mobile-${label}-${randomUUID()}`
    : path.join(os.tmpdir(), `codex-mobile-${label}-${randomUUID()}.sock`);
}

function frame(message) {
  const payload = Buffer.from(JSON.stringify(message));
  const output = Buffer.allocUnsafe(payload.length + 4);
  output.writeUInt32LE(payload.length, 0);
  payload.copy(output, 4);
  return output;
}

async function startMock(pipe, handler) {
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', async (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (buffer.length < length + 4) return;
        const request = JSON.parse(buffer.subarray(4, length + 4).toString());
        buffer = buffer.subarray(length + 4);
        const result = await handler(request, socket);
        if (result !== undefined && !socket.destroyed) socket.write(frame({ jsonrpc: '2.0', id: request.id, result }));
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipe, resolve);
  });
  return server;
}

async function stop(server) {
  await new Promise((resolve) => server.close(resolve));
}

const tools = ['list_threads', 'list_projects', 'create_thread', 'read_thread', 'wait_threads', 'send_message_to_thread']
  .map((name) => ({ name, namespace: 'codex_app' }));

{
  const pipe = socketPath('basic');
  const requests = [];
  const server = await startMock(pipe, (request) => {
    requests.push(request);
    if (request.method === 'tools/list') return { tools };
    return { called: request.params.tool, args: request.params.arguments };
  });
  const client = new DesktopAppToolsClient({ pipePath: pipe, contextThreadId: 'control-thread', requestTimeoutMs: 500 });
  try {
    assert.deepEqual(await client.listThreads({ limit: 3 }), { called: 'list_threads', args: { limit: 3 } });
    assert.equal((await client.listProjects()).called, 'list_projects');
    assert.equal((await client.createThread({ prompt: 'new', target: { type: 'projectless' } })).called, 'create_thread');
    assert.equal((await client.readThread({ threadId: 't1', turnLimit: 2 })).called, 'read_thread');
    assert.equal((await client.waitThreads({ targets: [{ threadId: 't1' }], timeoutMs: 0 })).called, 'wait_threads');
    assert.equal((await client.sendMessageToThread({ threadId: 't1', prompt: 'hello' })).called, 'send_message_to_thread');
    assert.equal(requests.filter((request) => request.method === 'tools/list').length, 1, 'tools/list is cached');
    const call = requests.find((request) => request.params?.tool === 'send_message_to_thread');
    assert.equal(call.params.namespace, 'codex_app');
    assert.equal(call.params.threadId, 't1');
  } finally {
    client.close();
    await stop(server);
  }
}

{
  const firstPipe = socketPath('reconnect-a');
  const secondPipe = socketPath('reconnect-b');
  let discovered = firstPipe;
  let listCount = 0;
  const first = await startMock(firstPipe, (request, socket) => {
    if (request.method === 'tools/list') return { tools };
    socket.destroy();
    return undefined;
  });
  const client = new DesktopAppToolsClient({ discoverPipePath: async () => discovered, contextThreadId: 'control-thread', requestTimeoutMs: 500 });
  await assert.rejects(client.listThreads(), /closed|pipe/i);
  await stop(first);
  discovered = secondPipe;
  const second = await startMock(secondPipe, (request) => {
    if (request.method === 'tools/list') {
      listCount++;
      return { tools };
    }
    return { ok: true };
  });
  try {
    assert.deepEqual(await client.listThreads(), { ok: true });
    assert.equal(listCount, 1, 'tools are refreshed after reconnect');
  } finally {
    client.close();
    await stop(second);
  }
}

{
  const pipe = socketPath('limits');
  const server = await startMock(pipe, (request) => {
    if (request.method === 'slow') return new Promise(() => {});
    return { value: 'x'.repeat(256) };
  });
  const client = new DesktopAppToolsClient({ pipePath: pipe, requestTimeoutMs: 30, maxFrameBytes: 128 });
  try {
    await assert.rejects(client.request('large-request', { value: 'x'.repeat(256) }), /too large/);
    await assert.rejects(client.request('slow'), /timed out/);
    await assert.rejects(client.request('large-response'), /too large/);
  } finally {
    client.close();
    await stop(server);
  }
}

console.log('desktop app tools client tests passed');
