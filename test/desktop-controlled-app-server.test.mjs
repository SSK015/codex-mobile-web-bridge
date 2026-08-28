import assert from 'node:assert/strict';
import { DesktopControlledAppServer } from '../desktop-controlled-app-server.mjs';

const wrapped = (value) => ({ contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] });

class FakeDesktopClient {
  constructor() {
    this.connected = false;
    this.sent = [];
    this.reads = 0;
    this.turns = [{ id: 'old', status: 'completed', items: [] }];
  }
  async connect() { this.connected = true; }
  close() { this.connected = false; }
  async listThreads() {
    return wrapped({
      pinnedThreads: [{ id: 'pinned', title: 'Pinned' }],
      threads: [{ id: 'pinned', title: 'Pinned duplicate' }, { id: 'recent', title: 'Recent' }],
      nextCursor: 'next',
    });
  }
  async readThread({ threadId }) {
    this.reads++;
    if (this.sent.length && !this.turns.some((turn) => turn.id === 'new')) {
      this.turns.push({ id: 'new', status: 'inProgress', items: [] });
    } else if (this.reads >= 4) {
      this.turns = this.turns.map((turn) => turn.id === 'new' ? { ...turn, status: 'completed' } : turn);
    }
    return wrapped({
      thread: { id: threadId, title: 'Task' },
      page: { order: 'newest_first', nextCursor: 'older' },
      turns: [...this.turns].reverse(),
    });
  }
  async sendMessageToThread(args) { this.sent.push(args); return { ok: true }; }
}

const client = new FakeDesktopClient();
const app = new DesktopControlledAppServer({
  client,
  pollIntervalMs: 1,
  startTimeoutMs: 100,
  completionTimeoutMs: 100,
});
await app.start();
assert.equal(app.ready, true);

const listed = await app.listThreads({ limit: 10 });
assert.deepEqual(listed.data.map((thread) => thread.id), ['pinned', 'recent']);
assert.equal(listed.data[0].name, 'Pinned');
assert.equal(listed.nextCursor, null);

const read = await app.readThread('recent');
assert.equal(read.thread.id, 'recent');
assert.equal(read.thread.name, 'Task');
assert.equal(read.thread.turns[0].id, 'old');

const notifications = [];
app.on('notification', (message) => notifications.push(message));
const result = await app.startTurn('recent', [
  { type: 'text', text: 'hello' },
  { type: 'localImage', path: 'C:\\tmp\\image.png' },
]);
assert.equal(result.turn.id, 'new');
assert.match(client.sent[0].prompt, /hello/);
assert.match(client.sent[0].prompt, /image\.png/);
assert.equal(notifications[0].method, 'turn/started');

const completed = await Promise.race([
  (async () => {
    while (!notifications.some((message) => message.method === 'turn/completed')) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    return notifications.find((message) => message.method === 'turn/completed');
  })(),
  new Promise((_, reject) => setTimeout(() => reject(new Error('completion notification timed out')), 150)),
]);
assert.equal(completed.params.turn.id, 'new');

const page = await app.listTurns('recent', { limit: 1, sortDirection: 'desc' });
assert.equal(page.data[0].id, 'new');
assert.equal(page.nextCursor, 'older');

await assert.rejects(app.steerTurn('recent', 'new', 'more'), (error) => error.code === 'DESKTOP_CONTROL_STEER_UNSUPPORTED' && error.statusCode === 501);
await assert.rejects(app.interruptTurn('recent', 'new'), (error) => error.code === 'DESKTOP_CONTROL_INTERRUPT_UNSUPPORTED');
await assert.rejects(app.startThread(), (error) => error.code === 'DESKTOP_CONTROL_START_THREAD_UNSUPPORTED');
await assert.rejects(app.restart(), (error) => error.code === 'DESKTOP_CONTROL_RESTART_UNSUPPORTED');

await app.stop();
assert.equal(app.ready, false);
assert.equal(client.connected, false);

const invalidClient = new FakeDesktopClient();
invalidClient.listThreads = async () => ({ contentItems: [{ type: 'inputText', text: '{bad json' }] });
const invalid = new DesktopControlledAppServer({ client: invalidClient });
await invalid.start();
await assert.rejects(invalid.listThreads(), (error) => error.code === 'DESKTOP_TOOL_INVALID_JSON');
await invalid.stop();

console.log('desktop controlled app server tests passed');
