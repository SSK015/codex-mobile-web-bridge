import assert from 'node:assert/strict';
import { isActiveWriterError, resumeThreadWithReadFallback } from '../app-server-client.mjs';

const thread = { id: 'synthetic-thread', turns: [] };

{
  let reads = 0;
  const appServer = {
    async resumeThread() { return { thread }; },
    async readThread() { reads += 1; return { thread }; },
  };
  const opened = await resumeThreadWithReadFallback(appServer, thread.id, { allowReadFallback: true });
  assert.equal(opened.desktopWriter, false);
  assert.equal(opened.result.thread, thread);
  assert.equal(reads, 0);
}

{
  let reads = 0;
  const appServer = {
    async resumeThread() { throw new Error('thread already has an active writer'); },
    async readThread() { reads += 1; return { thread }; },
  };
  const opened = await resumeThreadWithReadFallback(appServer, thread.id, { allowReadFallback: true });
  assert.equal(opened.desktopWriter, true);
  assert.equal(opened.result.thread, thread);
  assert.equal(reads, 1);
}

{
  const appServer = {
    async resumeThread() { throw new Error('thread already has an active writer'); },
    async readThread() { throw new Error('must not read'); },
  };
  await assert.rejects(
    resumeThreadWithReadFallback(appServer, thread.id, { allowReadFallback: false }),
    /active writer/i,
  );
}

assert.equal(isActiveWriterError(new Error('ACTIVE WRITER')), true);
assert.equal(isActiveWriterError(new Error('thread not found')), false);

console.log(JSON.stringify({ passed: true, sharedWriterFallback: true }));
