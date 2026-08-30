import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(root, 'public');
const host = process.env.CODEX_MOBILE_DEMO_HOST || '127.0.0.1';
const port = Number(process.env.CODEX_MOBILE_DEMO_PORT || 4792);
const now = Math.floor(Date.now() / 1_000);

const threads = [
  { id: 'demo-live', name: 'Release readiness', preview: 'Preparing the Android compatibility report…', cwd: 'Demo workspace', updatedAt: now, status: 'active', activityState: 'running', isPinned: true },
  { id: 'demo-unseen', name: 'Android upload check', preview: 'Screenshot and attachment flow verified.', cwd: 'Demo workspace', updatedAt: now - 420, status: 'idle', activityState: 'unseen', isPinned: false },
  { id: 'demo-viewed', name: 'Architecture review', preview: 'Desktop remains the sole task writer.', cwd: 'Demo workspace', updatedAt: now - 2_400, status: 'idle', activityState: 'viewed', isPinned: false },
  { id: 'demo-empty', name: 'Fresh workspace', preview: '', cwd: 'Demo workspace', updatedAt: now - 8_400, status: 'idle', activityState: 'empty', isPinned: false },
];

const demoThread = {
  ...threads[0],
  historyLoading: false,
  historyError: false,
  hasOlderTurns: false,
  olderTurnsCursor: null,
  omittedTurnCount: 0,
  eventSequence: 0,
  desktopWriter: false,
  turns: [{
    id: 'demo-turn',
    status: 'completed',
    error: null,
    items: [
      { id: 'demo-user', type: 'userMessage', text: 'Verify the Android interface and prepare a public release screenshot.' },
      { id: 'demo-agent-1', type: 'agentMessage', text: 'The Pixel test is complete. Chrome layout, project creation, model selection, and image upload all passed.', phase: 'commentary' },
      { id: 'demo-tools', type: 'toolGroup', turnId: 'demo-turn', count: 4, status: 'completed', hasDetails: true, toolItems: [] },
      { id: 'demo-agent-2', type: 'agentMessage', text: 'Release check passed:\n\n- Desktop stays the sole writer\n- Running turns accept follow-up messages\n- Long histories recover through a read-only fallback\n- No private paths or credentials are included', phase: 'final_answer' },
    ],
  }],
};

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (url.pathname === '/events') {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    response.write(': demo\n\n');
    return;
  }
  if (url.pathname === '/api/status') return json(response, {
    ready: true,
    activeThreadId: null,
    activeTurnId: null,
    appServerTransport: 'desktop-control',
    capabilities: { createThread: true, steerTurn: true, interruptTurn: true, interruptMode: 'soft-message', approvals: false, attachments: true },
  });
  if (url.pathname === '/api/threads' && request.method === 'GET') return json(response, { data: threads, nextCursor: null, partial: false, refreshing: false, cacheUpdatedAt: Date.now() });
  if (url.pathname === '/api/model-options') return json(response, {
    models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
    thinking: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    modelThinking: { 'gpt-5.6-sol': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  });
  if (url.pathname === '/api/projects') return json(response, { data: [
    { projectId: 'demo-project', label: 'Mobile Bridge Demo', path: 'Demo workspace', isGitRepository: true, worktreeReady: true },
  ] });
  if (url.pathname === '/api/requests') return json(response, { data: [] });
  if (url.pathname === '/api/viewers' && request.method === 'POST') return json(response, { ok: true });
  if ((url.pathname === '/api/threads/demo-live' && request.method === 'GET')
      || (url.pathname === '/api/threads/demo-live/resume' && request.method === 'POST')) {
    return json(response, { thread: demoThread, activeTurnId: null, desktopWriter: false });
  }
  if (url.pathname.startsWith('/api/')) return json(response, { ok: true }, 200);
  return serveStatic(url.pathname, response);
});

server.listen(port, host, () => {
  console.log(`Sanitized Codex Mobile demo at http://${host}:${port}`);
});

function json(response, value, status = 200) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

function serveStatic(pathname, response) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(publicRoot, relative);
  if (!filePath.startsWith(publicRoot) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return json(response, { error: 'Not found' }, 404);
  const type = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
  }[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  fs.createReadStream(filePath).pipe(response);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
