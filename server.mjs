import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexAppServer, isActiveWriterError, resumeThreadWithReadFallback } from './app-server-client.mjs';
import { safeCommandPreview, safeFileChangePreview, safePreviewText } from './sanitizers.mjs';
import { buildTurnInput } from './turn-input.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const CODEX_PATH = process.env.CODEX_MOBILE_CODEX_PATH || (process.platform === 'win32' ? 'codex.exe' : 'codex');
const APP_SERVER_URL = process.env.CODEX_MOBILE_APP_SERVER_URL || '';
const HOST = process.env.CODEX_MOBILE_HOST || '127.0.0.1';
const PORT = Number(process.env.CODEX_MOBILE_PORT || 4780);
const SECRET_FILE = process.env.CODEX_MOBILE_SECRET_FILE || '';
const SEEN_FILE = process.env.CODEX_MOBILE_SEEN_FILE || (SECRET_FILE ? path.join(path.dirname(SECRET_FILE), 'seen-threads.json') : '');
const THREAD_LIST_CACHE_FILE = process.env.CODEX_MOBILE_THREAD_LIST_CACHE_FILE || (SECRET_FILE ? path.join(path.dirname(SECRET_FILE), 'thread-list-cache.json') : '');
const UPLOAD_ROOT = process.env.CODEX_MOBILE_UPLOAD_ROOT || path.join(process.env.LOCALAPPDATA || ROOT, 'CodexMobile', 'uploads');
const COOKIE_PATH = process.env.CODEX_MOBILE_COOKIE_PATH || '/';
const secret = SECRET_FILE ? fs.readFileSync(SECRET_FILE, 'utf8').trim() : '';
const IMAGE_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const UPLOAD_IDLE_TIMEOUT_MS = 90 * 1000;
const IMAGE_TOKEN_KEY = crypto.createHash('sha256')
  .update(secret ? `codex-mobile-image-v1:${secret}` : crypto.randomBytes(32))
  .digest();
const IMAGE_TOKEN_AAD = Buffer.from('codex-mobile-image-v1');
const sealedImageTokenCache = new Map();
const preparedImageCache = new Map();
const sealedArtifactTokenCache = new Map();
const preparedArtifactCache = new Map();
const ARTIFACT_TOKEN_KEY = crypto.createHash('sha256')
  .update(secret ? `codex-mobile-artifact-v1:${secret}` : crypto.randomBytes(32))
  .digest();
const ARTIFACT_TOKEN_AAD = Buffer.from('codex-mobile-artifact-v1');
const IMAGE_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.avif', 'image/avif'],
  ['.bmp', 'image/bmp'],
]);
const ARTIFACT_TYPES = new Map([
  ['.pdf', { mimeType: 'application/pdf', previewable: true }],
  ['.txt', { mimeType: 'text/plain; charset=utf-8', previewable: true }],
  ['.md', { mimeType: 'text/plain; charset=utf-8', previewable: true }],
  ['.log', { mimeType: 'text/plain; charset=utf-8', previewable: true }],
  ['.json', { mimeType: 'application/json; charset=utf-8', previewable: true }],
  ['.csv', { mimeType: 'text/csv; charset=utf-8', previewable: true }],
  ['.tsv', { mimeType: 'text/tab-separated-values; charset=utf-8', previewable: true }],
  ['.yaml', { mimeType: 'text/plain; charset=utf-8', previewable: true }],
  ['.yml', { mimeType: 'text/plain; charset=utf-8', previewable: true }],
  ['.png', { mimeType: 'image/png', previewable: true }],
  ['.jpg', { mimeType: 'image/jpeg', previewable: true }],
  ['.jpeg', { mimeType: 'image/jpeg', previewable: true }],
  ['.gif', { mimeType: 'image/gif', previewable: true }],
  ['.webp', { mimeType: 'image/webp', previewable: true }],
  ['.avif', { mimeType: 'image/avif', previewable: true }],
  ['.docx', { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', previewable: false }],
  ['.xlsx', { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', previewable: false }],
  ['.pptx', { mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', previewable: false }],
  ['.zip', { mimeType: 'application/zip', previewable: false }],
]);
const IMAGE_ALLOWED_ROOTS = [...new Set([
  process.env.USERPROFILE,
  process.env.HOME,
  process.env.TEMP,
  process.env.TMP,
  ROOT,
  process.cwd(),
  UPLOAD_ROOT,
  ...(process.env.CODEX_MOBILE_IMAGE_ROOTS || '').split(path.delimiter),
].filter(Boolean).map((value) => normalizePathKey(path.resolve(value))))];
const seenState = loadSeenState();
const threadListCache = loadThreadListCache();

const appServer = new CodexAppServer({
  codexPath: CODEX_PATH,
  cwd: process.cwd(),
  websocketUrl: APP_SERVER_URL || null,
});
const sseClients = new Set();
const threadCache = new Map();
const threadCacheSizes = new Map();
const THREAD_CACHE_MAX_ENTRIES = 12;
const THREAD_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const THREAD_CACHE_MAX_ITEM_BYTES = 32 * 1024 * 1024;
let threadCacheBytes = 0;
const threadHistoryLoads = new Map();
const threadHistoryForceRequests = new Map();
const threadHistoryEvictionGenerations = new Map();
const itemDetailCache = new Map();
const mobileViewers = new Map();
const uploadedFiles = new Map();
let threadListRefreshPromise = null;
let threadListPersistTimer = null;
let threadListMutationSequence = 0;
const threadListMutationVersions = new Map();
const threadListTombstones = new Set();
const threadListStatusOverrides = new Map();
setInterval(sweepMobileViewers, 30_000).unref();
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [uploadId, upload] of uploadedFiles.entries()) {
    if (upload.createdAt < cutoff) uploadedFiles.delete(uploadId);
  }
}, 60 * 60 * 1000).unref();
let activeThreadId = null;
let activeTurnId = null;
let activeTurnThreadId = null;
let takeoverGeneration = 0;
let appServerEventSequence = 0;

appServer.on('notification', async (message) => {
  const eventSequence = ++appServerEventSequence;
  await prepareItemAssets(message.params?.item);
  const notificationThreadId = message.params?.threadId || null;
  const notificationTurnId = message.params?.turnId || message.params?.turn?.id || null;
  if (message.method === 'item/completed' && message.params?.item?.type === 'dynamicToolCall') {
    prunePendingServerRequests({
      threadId: notificationThreadId,
      turnId: notificationTurnId,
      callId: message.params.item.id,
    });
  }
  if (message.method === 'turn/completed') {
    prunePendingServerRequests({ threadId: notificationThreadId, turnId: notificationTurnId });
  }
  if (message.method === 'thread/started') {
    rememberEmptyThread(message.params?.thread);
    upsertThreadListEntry(message.params?.thread);
  }
  if (message.method === 'thread/deleted') {
    prunePendingServerRequests({ threadId: message.params?.threadId });
    evictThreadData(message.params?.threadId);
  }
  if (message.method === 'thread/status/changed') {
    if ((message.params?.status?.type || message.params?.status) === 'idle') {
      prunePendingServerRequests({ threadId: message.params?.threadId });
    }
    updateEmptyThreadStatus(message.params?.threadId, message.params?.status);
    updateThreadListStatus(message.params?.threadId, message.params?.status);
  }
  const completedItem = message.method === 'item/completed' ? message.params?.item : null;
  const completedThreadId = message.params?.threadId || activeThreadId;
  if (completedItem?.id && completedThreadId) {
    itemDetailCache.set(`${completedThreadId}:${completedItem.id}`, publicItemDetail(completedItem));
    if (itemDetailCache.size > 500) itemDetailCache.delete(itemDetailCache.keys().next().value);
  }
  const completionThreadId = message.method === 'turn/completed' ? message.params?.threadId : null;
  const completionVisible = completionThreadId ? isThreadVisibleOnMobile(completionThreadId) : false;
  if (completionThreadId) {
    if (completionVisible) markThreadSeen(completionThreadId, Date.now());
    else markThreadUnseen(completionThreadId);
  }
  const publicEvent = sanitizeNotification(message, eventSequence);
  if (publicEvent) broadcast(publicEvent);
  if (message.method === 'turn/started') {
    const startedThreadId = message.params?.threadId || message.params?.turn?.threadId;
    forgetEmptyThread(startedThreadId);
    updateThreadListStatus(startedThreadId, { type: 'active' });
    activeTurnId = message.params?.turn?.id ?? message.params?.turnId ?? activeTurnId;
    activeTurnThreadId = startedThreadId || activeTurnThreadId;
  }
  if (message.method === 'turn/completed') {
    const threadId = message.params?.threadId;
    if (!activeTurnThreadId || activeTurnThreadId === threadId) {
      activeTurnId = null;
      activeTurnThreadId = null;
    }
    if (threadId) {
      // Ephemeral threads deliberately have no readable on-disk history. The
      // browser already received their complete turn over SSE, so replacing it
      // with an empty thread/read snapshot would erase the visible reply.
      if (getCachedThread(threadId)?.ephemeral) return;
      try {
        const result = await appServer.readThread(threadId, { includeTurns: false });
        upsertThreadListEntry(result.thread);
        if (completionVisible) markThreadSeen(threadId, result.thread.updatedAt);
        scheduleRecentThreadHistory(result.thread, { force: true });
      } catch {
        const cached = getCachedThread(threadId);
        if (cached) scheduleRecentThreadHistory(cached, { force: true });
      }
    }
  }
});
appServer.on('serverRequest', (message) => {
  broadcast({ type: 'serverRequest', request: publicServerRequest(message) });
});
appServer.on('exit', (event) => broadcast({ type: 'appServerExit', event }));
appServer.on('error', (error) => broadcast({ type: 'appServerError', message: error.message }));
appServer.on('exit', (event) => {
  if (APP_SERVER_URL && !event.intentional) {
    console.error(`Shared App Server connection exited unexpectedly (${event.code ?? 'unknown'}); restarting bridge process.`);
    setTimeout(() => process.exit(1), 25).unref();
  }
});

await appServer.start();
await cleanupOrphanedUploadFiles();

const server = http.createServer(async (request, response) => {
  try {
    await route(request, response);
  } catch (error) {
    const status = error.statusCode || 500;
    json(response, status, { error: error.message, code: error.publicCode || null });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Codex Mobile Web listening on http://${HOST}:${PORT}`);
  console.log(`Authentication: ${secret ? 'enabled' : 'disabled (loopback testing only)'}`);
  console.log(`App Server transport: ${APP_SERVER_URL ? 'shared WebSocket' : 'private stdio'}`);
});

async function route(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (request.method === 'POST' && pathname === '/api/login') {
    if (!secret) return json(response, 200, { ok: true, authDisabled: true });
    const body = await readJson(request);
    if (!safeEqual(String(body.password || ''), secret)) {
      return json(response, 401, { error: '密码错误' });
    }
    response.setHeader('Set-Cookie', sessionCookie());
    return json(response, 200, { ok: true });
  }

  if (request.method === 'POST' && pathname === '/api/logout') {
    response.setHeader('Set-Cookie', `codex_mobile_session=; Path=${COOKIE_PATH}; HttpOnly; SameSite=Strict; Max-Age=0`);
    return json(response, 200, { ok: true });
  }

  if (pathname.startsWith('/api/') || pathname === '/events') {
    requireAuth(request);
  }

  if (request.method === 'GET' && pathname === '/api/status') {
    return json(response, 200, {
      ready: appServer.ready,
      activeThreadId,
      activeTurnId,
      authEnabled: Boolean(secret),
      appServerTransport: APP_SERVER_URL ? 'websocket' : 'stdio',
    });
  }

  const imageMatch = pathname.match(/^\/api\/images\/([a-zA-Z0-9_-]{40,1024})$/);
  if ((request.method === 'GET' || request.method === 'HEAD') && imageMatch) {
    return serveImageAsset(request, response, imageMatch[1]);
  }

  const artifactMatch = pathname.match(/^\/api\/artifacts\/([a-zA-Z0-9_-]{40,2048})$/);
  if ((request.method === 'GET' || request.method === 'HEAD') && artifactMatch) {
    return serveArtifactAsset(request, response, artifactMatch[1], {
      download: url.searchParams.get('download') === '1',
    });
  }

  if (request.method === 'POST' && pathname === '/api/view-state') {
    const body = await readJson(request);
    const viewerId = String(body.viewerId || '').slice(0, 128);
    const sequence = Number(body.sequence || 0);
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(viewerId)) {
      const error = new Error('无效的查看状态标识');
      error.statusCode = 400;
      throw error;
    }
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      const error = new Error('无效的查看状态序号');
      error.statusCode = 400;
      throw error;
    }
    let existing = mobileViewers.get(viewerId);
    if (existing && existing.seenAt < Date.now() - 45_000) {
      mobileViewers.delete(viewerId);
      existing = null;
    }
    if (existing && sequence <= existing.sequence) return json(response, 200, { ok: true, stale: true });
    mobileViewers.set(viewerId, {
      threadId: body.visible && body.threadId ? String(body.threadId) : null,
      seenAt: Date.now(),
      sequence,
    });
    return json(response, 200, { ok: true });
  }

  if (request.method === 'GET' && pathname === '/api/threads') {
    const searchTerm = url.searchParams.get('q') || null;
    const limit = Math.min(Number(url.searchParams.get('limit') || 200), 200);
    let partial = !threadListCache.complete;
    if (threadListCache.threads.length === 0) {
      const refreshStartedAtSequence = threadListMutationSequence;
      const initial = await appServer.listThreads({ limit: Math.min(20, limit) });
      replaceThreadListCache(initial.data || [], { complete: false, refreshStartedAtSequence });
      partial = true;
    }
    const forceRefresh = url.searchParams.get('refresh') === '1' || !threadListCache.complete;
    scheduleThreadListRefresh({ force: forceRefresh });
    const data = buildCachedThreadList(searchTerm, limit);
    return json(response, 200, {
      data: data.map(publicThreadSummary),
      nextCursor: null,
      partial,
      refreshing: Boolean(threadListRefreshPromise),
      cacheUpdatedAt: threadListCache.updatedAt || null,
    });
  }

  if (request.method === 'POST' && pathname === '/api/threads') {
    if (activeTurnId) {
      const error = new Error('当前回复尚未结束');
      error.statusCode = 409;
      throw error;
    }
    const body = await readJson(request);
    const result = await appServer.startThread({
      cwd: process.cwd(),
      ephemeral: Boolean(body.ephemeral),
    });
    activeThreadId = result.thread.id;
    setCachedThread(result.thread.id, result.thread);
    upsertThreadListEntry(result.thread);
    return json(response, 201, { thread: publicThread(result.thread) });
  }

  const resumeMatch = pathname.match(/^\/api\/threads\/([^/]+)\/resume$/);
  if (request.method === 'POST' && resumeMatch) {
    const threadId = decodeURIComponent(resumeMatch[1]);
    const generation = ++takeoverGeneration;
    try {
      const opened = await resumeThreadWithReadFallback(appServer, threadId, {
        allowReadFallback: Boolean(APP_SERVER_URL),
      });
      const { result, desktopWriter } = opened;
      if (desktopWriter) result.thread.mobileDesktopWriter = true;
      if (generation !== takeoverGeneration) {
        const error = new Error('这个 task 的打开请求已被更新的导航取代');
        error.statusCode = 409;
        error.publicCode = 'STALE_TAKEOVER';
        throw error;
      }
      const cached = getCachedThread(threadId);
      const cachedUsable = hasUsableCachedHistory(cached);
      const cachedFresh = cachedUsable
        && normalizeTimestamp(cached.updatedAt) >= normalizeTimestamp(result.thread.updatedAt);
      const responseThread = cachedUsable
        ? { ...cached, ...result.thread, turns: cached.turns, mobileHistoryPartial: cached.mobileHistoryPartial, mobileHistoryLoading: false }
        : { ...result.thread, turns: [], mobileHistoryPartial: false, mobileHistoryLoading: true };
      responseThread.mobileDesktopWriter = desktopWriter;
      if (cachedUsable) await prepareThreadImages(responseThread);
      if (generation !== takeoverGeneration) {
        const error = new Error('这个 task 的打开请求已被更新的导航取代');
        error.statusCode = 409;
        error.publicCode = 'STALE_TAKEOVER';
        throw error;
      }
      activeThreadId = threadId;
      activeTurnId = findInProgressTurnId(responseThread) || ((result.thread.status?.type || result.thread.status) === 'active' ? true : null);
      activeTurnThreadId = activeTurnId ? threadId : null;
      upsertThreadListEntry(result.thread);
      markThreadSeen(threadId, result.thread.updatedAt);
      const threadIsActive = (result.thread.status?.type || result.thread.status) === 'active';
      if (!cachedFresh || threadIsActive || desktopWriter) {
        scheduleRecentThreadHistory(result.thread, { force: desktopWriter || (threadIsActive && cachedUsable) });
      }
      return json(response, 200, { thread: publicThread(responseThread), activeTurnId, desktopWriter });
    } catch (error) {
      if (isThreadNotFound(error)) evictThreadData(threadId);
      if (isActiveWriterError(error)) {
        error.statusCode = 409;
        error.publicCode = 'ACTIVE_WRITER';
        error.message = '这个 task 正被桌面 Codex 使用。请在电脑上切换到另一 task 或退出 Codex，然后重试。';
      }
      throw error;
    }
  }

  const threadMatch = pathname.match(/^\/api\/threads\/([^/]+)$/);
  if (request.method === 'GET' && threadMatch) {
    const threadId = decodeURIComponent(threadMatch[1]);
    let thread;
    try {
      const result = await appServer.readThread(threadId, { includeTurns: false });
      const cached = getCachedThread(threadId);
      const cachedUsable = hasUsableCachedHistory(cached);
      const cachedFresh = cachedUsable
        && normalizeTimestamp(cached.updatedAt) >= normalizeTimestamp(result.thread.updatedAt);
      thread = cachedUsable
        ? { ...cached, ...result.thread, turns: cached.turns, mobileHistoryLoading: false, mobileHistoryError: false }
        : { ...result.thread, turns: [], mobileHistoryLoading: true };
      if (cachedUsable) await prepareThreadImages(thread);
      upsertThreadListEntry(result.thread);
      const threadIsActive = (result.thread.status?.type || result.thread.status) === 'active';
      if (!cachedFresh || threadIsActive) {
        scheduleRecentThreadHistory(result.thread, { force: threadIsActive && cachedUsable });
      }
    } catch (error) {
      if (isThreadNotFound(error)) {
        evictThreadData(threadId);
        error.statusCode = 404;
        throw error;
      }
      thread = getCachedThread(threadId);
      if (!thread) throw error;
    }
    return json(response, 200, { thread: publicThread(thread) });
  }

  const olderTurnsMatch = pathname.match(/^\/api\/threads\/([^/]+)\/turns$/);
  if (request.method === 'GET' && olderTurnsMatch) {
    const threadId = decodeURIComponent(olderTurnsMatch[1]);
    const cursor = String(url.searchParams.get('cursor') || '');
    const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 12), 24));
    if (!cursor || cursor.length > 4_096) {
      const error = new Error('无效的历史分页标识');
      error.statusCode = 400;
      throw error;
    }
    try {
      await appServer.readThread(threadId, { includeTurns: false });
      const page = await appServer.listTurns(threadId, {
        cursor,
        limit,
        sortDirection: 'desc',
        itemsView: 'full',
      });
      const turns = [...(page.data || [])].reverse();
      await prepareThreadImages({ turns });
      return json(response, 200, {
        turns: turns.map(publicTurn),
        olderTurnsCursor: page.nextCursor || null,
        hasOlderTurns: Boolean(page.nextCursor),
      });
    } catch (error) {
      if (isThreadNotFound(error)) {
        evictThreadData(threadId);
        error.statusCode = 404;
      }
      throw error;
    }
  }

  const itemDetailMatch = pathname.match(/^\/api\/threads\/([^/]+)\/items\/([^/]+)$/);
  if (request.method === 'GET' && itemDetailMatch) {
    const threadId = decodeURIComponent(itemDetailMatch[1]);
    const itemId = decodeURIComponent(itemDetailMatch[2]);
    const cachedDetail = itemDetailCache.get(`${threadId}:${itemId}`);
    try {
      await appServer.readThread(threadId, { includeTurns: false });
    } catch (error) {
      if (isThreadNotFound(error)) {
        evictThreadData(threadId);
        error.statusCode = 404;
        throw error;
      }
      if (!cachedDetail) throw error;
    }
    if (cachedDetail) return json(response, 200, { item: cachedDetail });
    let item = findThreadItem(getCachedThread(threadId), itemId);
    if (!item) {
      try {
        const result = await appServer.readThread(threadId);
        item = findThreadItem(result.thread, itemId);
      } catch (error) {
        if (isThreadNotFound(error)) evictThreadData(threadId);
        throw error;
      }
    }
    if (!item) {
      const error = new Error('找不到这条工具详情');
      error.statusCode = 404;
      throw error;
    }
    return json(response, 200, { item: publicItemDetail(item) });
  }

  const uploadMatch = pathname.match(/^\/api\/threads\/([^/]+)\/uploads$/);
  if (request.method === 'POST' && uploadMatch) {
    const threadId = decodeURIComponent(uploadMatch[1]);
    if (threadId !== activeThreadId) {
      const error = new Error('请先打开并接管这个 task');
      error.statusCode = 409;
      throw error;
    }
    const attachment = await receiveUpload(request, threadId);
    return json(response, 201, { attachment: publicUpload(attachment) });
  }

  const deleteUploadMatch = pathname.match(/^\/api\/uploads\/([a-zA-Z0-9_-]{16,128})$/);
  if (request.method === 'DELETE' && deleteUploadMatch) {
    const uploadId = deleteUploadMatch[1];
    const upload = uploadedFiles.get(uploadId);
    if (!upload) return json(response, 200, { ok: true, alreadyRemoved: true });
    if (upload.claimed) {
      const error = new Error('这个文件已经发送给 Codex');
      error.statusCode = 409;
      throw error;
    }
    uploadedFiles.delete(uploadId);
    await fs.promises.unlink(upload.path).catch(() => {});
    return json(response, 200, { ok: true });
  }

  const turnToolsMatch = pathname.match(/^\/api\/threads\/([^/]+)\/turns\/([^/]+)\/tools$/);
  if (request.method === 'GET' && turnToolsMatch) {
    const threadId = decodeURIComponent(turnToolsMatch[1]);
    const turnId = decodeURIComponent(turnToolsMatch[2]);
    let thread = getCachedThread(threadId);
    try {
      await appServer.readThread(threadId, { includeTurns: false });
    } catch (error) {
      if (isThreadNotFound(error)) {
        evictThreadData(threadId);
        error.statusCode = 404;
        throw error;
      }
      if (!thread) throw error;
    }
    let turn = (thread?.turns || []).find((candidate) => String(candidate?.id) === String(turnId));
    if (!turn) {
      try {
        const result = await appServer.readThread(threadId);
        thread = result.thread;
        turn = (thread?.turns || []).find((candidate) => String(candidate?.id) === String(turnId));
      } catch (error) {
        if (isThreadNotFound(error)) evictThreadData(threadId);
        throw error;
      }
    }
    if (!turn) {
      const error = new Error('找不到这一轮工具活动');
      error.statusCode = 404;
      throw error;
    }
    const allTools = (turn.items || []).filter(isToolActivity);
    const visibleTools = allTools.slice(-120);
    return json(response, 200, {
      total: allTools.length,
      omitted: Math.max(0, allTools.length - visibleTools.length),
      items: visibleTools.map(publicItem).filter(Boolean),
    });
  }

  const messageMatch = pathname.match(/^\/api\/threads\/([^/]+)\/messages$/);
  if (request.method === 'POST' && messageMatch) {
    const threadId = decodeURIComponent(messageMatch[1]);
    if (threadId !== activeThreadId) {
      const error = new Error('请先打开并接管这个 task');
      error.statusCode = 409;
      throw error;
    }
    const body = await readJson(request);
    const text = String(body.text || '').trim();
    const attachments = await resolveUploadAttachments(threadId, body.attachments);
    if (!text && attachments.length === 0) {
      const error = new Error('消息或附件不能为空');
      error.statusCode = 400;
      throw error;
    }
    const input = buildTurnInput(text, attachments);
    if (activeTurnId && activeTurnThreadId === threadId) {
      if (activeTurnId === true) {
        const error = new Error('正在恢复运行中的回复，请稍后再追加');
        error.statusCode = 409;
        throw error;
      }
      const result = await appServer.steerTurn(threadId, activeTurnId, input);
      attachments.forEach((attachment) => { attachment.claimed = true; });
      return json(response, 202, { turn: { id: result.turnId }, steered: true });
    }
    const result = await appServer.startTurn(threadId, input);
    attachments.forEach((attachment) => { attachment.claimed = true; });
    activeTurnId = result.turn?.id || null;
    activeTurnThreadId = activeTurnId ? threadId : null;
    return json(response, 202, { turn: result.turn, steered: false });
  }

  const interruptMatch = pathname.match(/^\/api\/threads\/([^/]+)\/interrupt$/);
  if (request.method === 'POST' && interruptMatch) {
    const threadId = decodeURIComponent(interruptMatch[1]);
    const body = await readJson(request);
    let turnId = body.turnId || activeTurnId;
    try {
      const result = await appServer.readThread(threadId);
      turnId = findInProgressTurnId(result.thread) || turnId;
    } catch (error) {
      if (isThreadNotFound(error)) {
        evictThreadData(threadId);
        error.statusCode = 404;
        throw error;
      }
    }
    if (!turnId) return json(response, 200, { ok: true, alreadyIdle: true });
    await appServer.interruptTurn(threadId, turnId);
    if (!activeTurnThreadId || activeTurnThreadId === threadId) {
      activeTurnId = null;
      activeTurnThreadId = null;
    }
    return json(response, 200, { ok: true });
  }

  if (request.method === 'GET' && pathname === '/api/requests') {
    return json(response, 200, {
      data: [...appServer.serverRequests.values()].map(publicServerRequest),
    });
  }

  const approvalMatch = pathname.match(/^\/api\/requests\/([^/]+)\/respond$/);
  if (request.method === 'POST' && approvalMatch) {
    const requestId = decodeURIComponent(approvalMatch[1]);
    const pending = appServer.serverRequests.get(String(requestId));
    if (!pending) {
      const error = new Error('这个审批已经失效');
      error.statusCode = 404;
      throw error;
    }
    const body = await readJson(request);
    if (pending.method === 'item/commandExecution/requestApproval' ||
        pending.method === 'item/fileChange/requestApproval') {
      const safeDecisions = new Set(['accept', 'decline', 'cancel']);
      const advertised = Array.isArray(pending.params?.availableDecisions)
        ? new Set(pending.params.availableDecisions.filter((value) => typeof value === 'string'))
        : null;
      const allowed = advertised
        ? new Set([...safeDecisions].filter((value) => advertised.has(value)))
        : safeDecisions;
      if (!allowed.has(body.decision)) {
        const error = new Error('无效的审批决定');
        error.statusCode = 400;
        throw error;
      }
      appServer.respondToServerRequest(pending.id, { decision: body.decision });
    } else if (pending.method === 'item/tool/requestUserInput') {
      const questions = Array.isArray(pending.params?.questions) ? pending.params.questions.slice(0, 8) : [];
      const submitted = body.answers && typeof body.answers === 'object' ? body.answers : {};
      const answers = {};
      for (const question of questions) {
        const questionId = String(question?.id || '');
        const values = Array.isArray(submitted[questionId])
          ? submitted[questionId].map((value) => String(value || '').trim()).filter(Boolean).slice(0, 8)
          : [];
        if (!questionId || values.length === 0 || values.some((value) => value.length > 4_000)) {
          const error = new Error('请完成所有问题后再提交');
          error.statusCode = 400;
          throw error;
        }
        const allowedOptions = Array.isArray(question?.options)
          ? new Set(question.options.map((option) => String(option?.label || '')).filter(Boolean))
          : null;
        if (allowedOptions?.size && !question.isOther && values.some((value) => !allowedOptions.has(value))) {
          const error = new Error('回答不在可选范围内');
          error.statusCode = 400;
          throw error;
        }
        answers[questionId] = { answers: values };
      }
      appServer.respondToServerRequest(pending.id, { answers });
    } else if (pending.method === 'item/permissions/requestApproval') {
      const decision = String(body.decision || '');
      if (!['accept', 'decline'].includes(decision)) {
        const error = new Error('无效的权限决定');
        error.statusCode = 400;
        throw error;
      }
      const requested = pending.params?.permissions || {};
      const permissions = decision === 'accept'
        ? Object.fromEntries(Object.entries({
            network: requested.network,
            fileSystem: requested.fileSystem,
          }).filter(([, value]) => value != null))
        : {};
      appServer.respondToServerRequest(pending.id, { permissions, scope: 'turn' });
    } else if (pending.method === 'mcpServer/elicitation/request') {
      const safeActions = new Set(['accept', 'decline', 'cancel']);
      const action = String(body.action || '');
      if (!safeActions.has(action)) {
        const error = new Error('无效的请求处理动作');
        error.statusCode = 400;
        throw error;
      }
      let content = null;
      if (action === 'accept' && body.content && typeof body.content === 'object') {
        const serialized = JSON.stringify(body.content);
        if (serialized.length > 16_000) {
          const error = new Error('表单内容过长');
          error.statusCode = 400;
          throw error;
        }
        content = JSON.parse(serialized);
      }
      appServer.respondToServerRequest(pending.id, { action, content, _meta: null });
    } else {
      const error = new Error('这个请求类型暂不支持在手机网页处理');
      error.statusCode = 400;
      throw error;
    }
    return json(response, 200, { ok: true });
  }

  if (request.method === 'POST' && pathname === '/api/release') {
    if (activeTurnId) {
      const error = new Error('请先停止当前回复，再释放给桌面');
      error.statusCode = 409;
      throw error;
    }
    // A private stdio server must be restarted to release its rollout lock.
    // Clients of one shared WebSocket server do not have that cross-process
    // lock, so disconnecting here is unnecessary and can leave a stale TCP
    // connection while the WebSocket close handshake times out.
    if (!APP_SERVER_URL) await appServer.restart();
    activeThreadId = null;
    activeTurnId = null;
    activeTurnThreadId = null;
    takeoverGeneration += 1;
    clearThreadCache();
    broadcast({ type: 'released' });
    return json(response, 200, {
      ok: true,
      appServerDisconnected: !APP_SERVER_URL,
    });
  }

  if (request.method === 'GET' && pathname === '/events') {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
    sseClients.add(response);
    request.on('close', () => sseClients.delete(response));
    return;
  }

  if (request.method === 'GET') return serveStatic(pathname, response);
  json(response, 404, { error: 'Not found' });
}

async function receiveUpload(request, threadId) {
  let originalName;
  try {
    originalName = decodeURIComponent(String(request.headers['x-codex-file-name'] || ''));
  } catch {
    originalName = '';
  }
  originalName = path.basename(originalName).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().slice(0, 180);
  if (!originalName) {
    const error = new Error('附件文件名无效');
    error.statusCode = 400;
    throw error;
  }
  const declaredLength = Number(request.headers['content-length'] || 0);
  if (declaredLength > MAX_UPLOAD_BYTES) {
    const error = new Error('单个附件不能超过 25 MB');
    error.statusCode = 413;
    throw error;
  }
  const threadDirectory = path.join(UPLOAD_ROOT, crypto.createHash('sha256').update(threadId).digest('hex').slice(0, 24));
  await fs.promises.mkdir(threadDirectory, { recursive: true });
  const uploadId = crypto.randomBytes(18).toString('base64url');
  const storedName = `${Date.now()}-${uploadId.slice(0, 8)}-${originalName}`;
  const finalPath = path.join(threadDirectory, storedName);
  const temporaryPath = `${finalPath}.uploading`;
  let handle;
  let bytes = 0;
  let tooLarge = false;
  const contentHash = crypto.createHash('sha256');
  request.setTimeout(UPLOAD_IDLE_TIMEOUT_MS, () => request.destroy(new Error('Upload idle timeout')));
  try {
    handle = await fs.promises.open(temporaryPath, 'wx');
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > MAX_UPLOAD_BYTES) {
        tooLarge = true;
        continue;
      }
      contentHash.update(chunk);
      await handle.writeFile(chunk);
    }
    await handle.close();
    handle = null;
    if (tooLarge) {
      const error = new Error('单个附件不能超过 25 MB');
      error.statusCode = 413;
      throw error;
    }
    if (bytes <= 0) {
      const error = new Error('附件内容为空');
      error.statusCode = 400;
      throw error;
    }
    await fs.promises.rename(temporaryPath, finalPath);
    const extension = path.extname(originalName).toLowerCase();
    const attachment = {
      id: uploadId,
      threadId,
      name: originalName,
      path: finalPath,
      size: bytes,
      mimeType: safePreviewText(request.headers['content-type'], 120) || 'application/octet-stream',
      isImage: IMAGE_TYPES.has(extension),
      sha256: contentHash.digest('hex'),
      createdAt: Date.now(),
      claimed: false,
    };
    uploadedFiles.set(uploadId, attachment);
    return attachment;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.promises.unlink(temporaryPath).catch(() => {});
    throw error;
  } finally {
    request.setTimeout(0);
  }
}

async function cleanupOrphanedUploadFiles() {
  let directories;
  try {
    directories = await fs.promises.readdir(UPLOAD_ROOT, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`Unable to scan upload directory: ${error.message}`);
    return;
  }
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    const directoryPath = path.join(UPLOAD_ROOT, directory.name);
    const files = await fs.promises.readdir(directoryPath, { withFileTypes: true }).catch(() => []);
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.uploading')) continue;
      await fs.promises.unlink(path.join(directoryPath, file.name)).catch(() => {});
    }
  }
}

function publicUpload(upload) {
  return {
    id: upload.id,
    name: upload.name,
    size: upload.size,
    mimeType: upload.mimeType,
    isImage: upload.isImage,
  };
}

async function resolveUploadAttachments(threadId, values) {
  const ids = Array.isArray(values)
    ? [...new Set(values.map((value) => String(value?.id || value || '')).filter(Boolean))]
    : [];
  if (ids.length > 4) {
    const error = new Error('每条消息最多发送 4 个附件');
    error.statusCode = 400;
    throw error;
  }
  const result = [];
  const seenImageHashes = new Set();
  for (const uploadId of ids) {
    const upload = uploadedFiles.get(uploadId);
    if (!upload || upload.threadId !== threadId || upload.claimed || !isAllowedLocalPath(upload.path)) {
      const error = new Error('附件已失效，请重新选择');
      error.statusCode = 400;
      throw error;
    }
    const stats = await fs.promises.stat(upload.path).catch(() => null);
    if (!stats?.isFile() || stats.size !== upload.size || stats.size > MAX_UPLOAD_BYTES) {
      const error = new Error('附件已失效，请重新选择');
      error.statusCode = 400;
      throw error;
    }
    if (upload.isImage && upload.sha256 && seenImageHashes.has(upload.sha256)) {
      uploadedFiles.delete(uploadId);
      await fs.promises.unlink(upload.path).catch(() => {});
      continue;
    }
    if (upload.isImage && upload.sha256) seenImageHashes.add(upload.sha256);
    result.push(upload);
  }
  return result;
}

function publicThreadSummary(thread) {
  const preview = compactFileCitations(String(thread.preview || '')).trim();
  const status = thread.status?.type || thread.status || null;
  const hasMessages = Boolean(preview);
  const running = status === 'active';
  const updatedAt = normalizeTimestamp(thread.updatedAt);
  const seenRecord = getSeenRecord(thread.id);
  const activityState = running ? 'running' : !hasMessages ? 'empty' : seenRecord.unread || updatedAt > seenRecord.seenAt ? 'unseen' : 'viewed';
  return {
    id: thread.id,
    name: thread.name || null,
    preview: preview.slice(0, 240),
    cwd: thread.cwd || null,
    updatedAt: thread.updatedAt || null,
    createdAt: thread.createdAt || null,
    status,
    activityState,
    isPinned: Boolean(thread.isPinned),
  };
}

function compactFileCitations(text) {
  return String(text || '').replace(/:{1,2}codex-file-citation\{((?:[^}"\n]|"[^"\n]*")*)\}/g, (whole, rawAttributes) => {
    const pathMatch = String(rawAttributes).match(/\bpath="([^"]*)"/);
    if (!pathMatch) return '本地文件';
    return path.win32.basename(pathMatch[1].replaceAll('/', '\\')) || '本地文件';
  });
}

function publicThread(thread) {
  const allTurns = Array.isArray(thread.turns) ? thread.turns : [];
  const turns = allTurns.slice(-24);
  return {
    ...publicThreadSummary(thread),
    historyMode: thread.historyMode || null,
    omittedTurnCount: Math.max(0, allTurns.length - turns.length),
    historyLoading: Boolean(thread.mobileHistoryLoading),
    historyError: Boolean(thread.mobileHistoryError),
    hasOlderTurns: Boolean(thread.mobileHistoryPartial),
    olderTurnsCursor: thread.mobileHistoryNextCursor || null,
    eventSequence: Number(thread.mobileEventSequence || 0),
    desktopWriter: Boolean(thread.mobileDesktopWriter),
    turns: turns.map(publicTurn),
  };
}

function publicTurn(turn) {
  return {
    id: turn.id,
    status: turn.status,
    error: turn.error?.message || turn.error || null,
    items: publicTurnItems(turn),
  };
}

function hasUsableCachedHistory(thread) {
  return Boolean(thread
    && !thread.mobileHistoryLoading
    && !thread.mobileHistoryError
    && Array.isArray(thread.turns)
    && thread.turns.length > 0);
}

function getCachedThread(threadId) {
  if (!threadId || !threadCache.has(threadId)) return null;
  const thread = threadCache.get(threadId);
  // Refresh insertion order so eviction removes the least recently used task.
  threadCache.delete(threadId);
  threadCache.set(threadId, thread);
  return thread;
}

function setCachedThread(threadId, thread) {
  if (!threadId || !thread) return false;
  const bytes = estimateCacheBytes(thread, THREAD_CACHE_MAX_ITEM_BYTES);
  deleteCachedThread(threadId);
  if (bytes > THREAD_CACHE_MAX_ITEM_BYTES) return false;
  threadCache.set(threadId, thread);
  threadCacheSizes.set(threadId, bytes);
  threadCacheBytes += bytes;
  while (threadCache.size > THREAD_CACHE_MAX_ENTRIES || threadCacheBytes > THREAD_CACHE_MAX_BYTES) {
    const oldestThreadId = threadCache.keys().next().value;
    if (oldestThreadId === undefined) break;
    deleteCachedThread(oldestThreadId);
  }
  return true;
}

function deleteCachedThread(threadId) {
  if (!threadId) return;
  threadCache.delete(threadId);
  threadCacheBytes = Math.max(0, threadCacheBytes - (threadCacheSizes.get(threadId) || 0));
  threadCacheSizes.delete(threadId);
}

function clearThreadCache() {
  threadCache.clear();
  threadCacheSizes.clear();
  threadCacheBytes = 0;
}

function estimateCacheBytes(value, limit) {
  let bytes = 0;
  const stack = [value];
  const seen = new WeakSet();
  while (stack.length > 0) {
    const current = stack.pop();
    if (current == null) {
      bytes += 4;
    } else if (typeof current === 'string') {
      // A UTF-8 string is never smaller than its JS code-unit length. This
      // lets very large tool outputs stop the walk without allocating a JSON copy.
      if (current.length > limit - bytes) return limit + 1;
      bytes += Buffer.byteLength(current, 'utf8') + 2;
    } else if (typeof current === 'number' || typeof current === 'bigint') {
      bytes += 16;
    } else if (typeof current === 'boolean') {
      bytes += 5;
    } else if (typeof current === 'object') {
      if (seen.has(current)) continue;
      seen.add(current);
      bytes += 2;
      for (const key of Object.keys(current)) {
        if (key.length > limit - bytes) return limit + 1;
        bytes += Buffer.byteLength(key, 'utf8') + 3;
        stack.push(current[key]);
      }
    }
    if (bytes > limit) return limit + 1;
  }
  return bytes;
}

function isThreadNotFound(error) {
  return /not found|unknown thread|does not exist|deleted/i.test(String(error?.message || ''));
}

function evictThreadData(threadId) {
  if (!threadId) return;
  threadHistoryForceRequests.delete(threadId);
  const nextEvictionGeneration = (threadHistoryEvictionGenerations.get(threadId) || 0) + 1;
  threadHistoryEvictionGenerations.delete(threadId);
  threadHistoryEvictionGenerations.set(threadId, nextEvictionGeneration);
  while (threadHistoryEvictionGenerations.size > 5_000) {
    const candidate = [...threadHistoryEvictionGenerations.keys()].find((id) => !threadHistoryLoads.has(id));
    if (!candidate) break;
    threadHistoryEvictionGenerations.delete(candidate);
  }
  deleteCachedThread(threadId);
  for (const key of itemDetailCache.keys()) {
    if (key.startsWith(`${threadId}:`)) itemDetailCache.delete(key);
  }
  forgetThread(threadId);
  removeThreadListEntry(threadId);
  if (activeThreadId === threadId || activeTurnThreadId === threadId) {
    takeoverGeneration += 1;
    activeThreadId = null;
    activeTurnId = null;
    activeTurnThreadId = null;
  }
  broadcast({ type: 'threadDeleted', threadId });
}

function scheduleRecentThreadHistory(metadata, { force = false } = {}) {
  const threadId = metadata?.id;
  if (!threadId) return null;
  if (threadHistoryLoads.has(threadId)) {
    const existing = threadHistoryLoads.get(threadId);
    if (force) threadHistoryForceRequests.set(threadId, metadata);
    return existing;
  }
  const cached = getCachedThread(threadId);
  if (!force && cached
    && !cached.mobileHistoryLoading
    && Array.isArray(cached.turns)
    && cached.turns.length > 0
    && normalizeTimestamp(cached.updatedAt) >= normalizeTimestamp(metadata.updatedAt)) return null;
  const evictionGeneration = threadHistoryEvictionGenerations.get(threadId) || 0;
  const promise = (async () => {
    try {
      const page = await appServer.listTurns(threadId, { limit: 24, sortDirection: 'desc', itemsView: 'full' });
      const thread = {
        ...metadata,
        turns: [...(page.data || [])].reverse(),
        mobileEventSequence: appServerEventSequence,
        mobileHistoryLoading: false,
        mobileHistoryError: false,
        mobileHistoryPartial: Boolean(page.nextCursor),
        mobileHistoryNextCursor: page.nextCursor || null,
      };
      if ((threadHistoryEvictionGenerations.get(threadId) || 0) !== evictionGeneration) return;
      await prepareThreadImages(thread);
      if ((threadHistoryEvictionGenerations.get(threadId) || 0) !== evictionGeneration) return;
      setCachedThread(threadId, thread);
      if (activeThreadId === threadId && activeTurnId === true) {
        activeTurnId = findInProgressTurnId(thread) || activeTurnId;
        activeTurnThreadId = threadId;
      }
      broadcast({ type: 'threadSnapshot', thread: publicThread(thread) });
    } catch (error) {
      if (isThreadNotFound(error)) {
        evictThreadData(threadId);
        return;
      }
      if ((threadHistoryEvictionGenerations.get(threadId) || 0) !== evictionGeneration) return;
      const cached = getCachedThread(threadId);
      const failedThread = {
        ...(cached || metadata),
        turns: Array.isArray(cached?.turns) ? cached.turns : [],
        mobileHistoryLoading: false,
        mobileHistoryError: true,
      };
      setCachedThread(threadId, failedThread);
      broadcast({ type: 'threadSnapshot', thread: publicThread(failedThread) });
      broadcast({ type: 'threadHistoryError', threadId, message: safePreviewText(error.message || '历史加载失败', 240) });
    } finally {
      threadHistoryLoads.delete(threadId);
      const forcedMetadata = threadHistoryForceRequests.get(threadId);
      threadHistoryForceRequests.delete(threadId);
      if (forcedMetadata && (threadHistoryEvictionGenerations.get(threadId) || 0) === evictionGeneration) {
        scheduleRecentThreadHistory(forcedMetadata, { force: true });
      }
    }
  })();
  threadHistoryLoads.set(threadId, promise);
  return promise;
}

function publicTurnItems(turn) {
  const result = [];
  const tools = [];
  let groupIndex = -1;
  for (const item of turn.items || []) {
    if (isToolActivity(item)) {
      if (groupIndex < 0) {
        groupIndex = result.length;
        result.push(null);
      }
      tools.push(item);
      continue;
    }
    const publicValue = publicItem(item);
    if (publicValue) result.push(publicValue);
  }
  if (tools.length > 0) {
    const runningTools = tools.filter((item) => /progress|running|started/i.test(String(item.status || '')));
    const runningToolItems = runningTools.map((item) => {
      const id = String(item.id || '');
      if (id.length > 160) return null;
      return /^[a-zA-Z0-9._:-]+$/.test(id)
        ? { id, status: safePreviewText(item.status, 48) || null }
        : null;
    }).filter(Boolean);
    const boundedRunningToolItems = runningToolItems.slice(-256);
    const status = tools.some((item) => /fail|error|declin/i.test(String(item.status || '')))
      ? 'failed'
      : tools.some((item) => /progress|running|started/i.test(String(item.status || '')))
        ? 'inProgress'
        : 'completed';
    result[groupIndex] = {
      id: `tool-group-${turn.id}`,
      type: 'toolGroup',
      turnId: turn.id,
      count: tools.length,
      status,
      hasDetails: true,
      ...(runningTools.length > 0 ? {
        toolItems: boundedRunningToolItems,
        toolItemsComplete: runningToolItems.length === runningTools.length && runningToolItems.length <= 256,
      } : {}),
    };
  }
  return result.filter(Boolean);
}

function isToolActivity(item) {
  return ['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'collabToolCall', 'collabAgentToolCall', 'dynamicToolCall'].includes(item?.type);
}

function publicItem(item) {
  if (!item || typeof item !== 'object') return null;
  if (item.type === 'userMessage') {
    return {
      id: item.id,
      type: item.type,
      text: cleanUserMessageText(extractText(item)),
      images: extractMessageImages(item),
      artifacts: publicItemArtifacts(item),
    };
  }
  if (item.type === 'agentMessage' || item.type === 'plan') {
    return { id: item.id, type: item.type, text: extractText(item), artifacts: publicItemArtifacts(item) };
  }
  if (item.type === 'imageView') {
    const image = publicLocalImage(item.path);
    return image ? { id: item.id, type: 'imageMessage', text: '查看的图片', images: [image], artifacts: publicItemArtifacts(item) } : null;
  }
  if (item.type === 'imageGeneration') {
    const image = publicLocalImage(item.savedPath);
    return image ? {
      id: item.id,
      type: 'imageMessage',
      text: item.revisedPrompt ? String(item.revisedPrompt).slice(0, 500) : '生成的图片',
      images: [image],
      artifacts: publicItemArtifacts(item),
    } : null;
  }
  if (item.type === 'commandExecution') {
    return {
      id: item.id,
      type: item.type,
      status: item.status || null,
      preview: safeCommandPreview(item.command),
      hasDetails: true,
    };
  }
  if (item.type === 'fileChange') {
    return { id: item.id, type: item.type, status: item.status || null, preview: safeFileChangePreview(item.changes), text: '文件已修改' };
  }
  if (item.type === 'webSearch') {
    return { id: item.id, type: item.type, status: item.status || null, preview: '正在搜索网页', text: '' };
  }
  if (item.type === 'mcpToolCall') {
    const preview = [item.server, item.tool].filter(Boolean).map((value) => safePreviewText(value, 100)).join(' · ');
    return { id: item.id, type: item.type, status: item.status || null, preview, text: preview };
  }
  if (item.type === 'dynamicToolCall') {
    const preview = [item.namespace, item.tool].filter(Boolean).map((value) => safePreviewText(value, 100)).join(' · ');
    return { id: item.id, type: item.type, status: item.status || null, preview, text: preview };
  }
  if (item.type === 'collabAgentToolCall' || item.type === 'collabToolCall') {
    const preview = safePreviewText(item.tool, 160);
    return { id: item.id, type: 'collabToolCall', status: item.status || null, preview, text: preview };
  }
  return null;
}

function cleanUserMessageText(text) {
  const value = String(text || '').trim();
  if (!/^# Files mentioned by the user:/i.test(value)) return value;
  const requestMarker = value.match(/(?:^|\n)## My request:\s*\n/i);
  return requestMarker ? value.slice(requestMarker.index + requestMarker[0].length).trim() : value;
}

function extractMessageImages(item) {
  const images = [];
  const seen = new Set();
  const visit = (value, depth = 0) => {
    if (depth > 6 || value == null) return;
    if (Array.isArray(value)) {
      value.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    if (typeof value !== 'object') return;
    if (value.type === 'localImage' && typeof value.path === 'string') {
      const image = publicLocalImage(value.path, value.detail);
      if (image && !seen.has(image.id)) {
        seen.add(image.id);
        images.push(image);
      }
      return;
    }
    for (const key of ['content', 'images', 'attachments']) {
      if (key in value) visit(value[key], depth + 1);
    }
  };
  visit(item);
  return images.slice(0, 12);
}

function extractArtifactPaths(item) {
  if (!item || typeof item !== 'object') return [];
  const candidates = [];
  const add = (value) => {
    if (typeof value !== 'string' || candidates.length >= 12 || !isAllowedLocalPath(value)) return;
    candidates.push(path.resolve(value));
  };
  if (item.type === 'imageView') add(item.path);
  if (item.type === 'imageGeneration') add(item.savedPath);
  const visit = (value, depth = 0) => {
    if (depth > 6 || value == null) return;
    if (Array.isArray(value)) return value.forEach((entry) => visit(entry, depth + 1));
    if (typeof value !== 'object') return;
    if (['localImage', 'mention'].includes(value.type) && typeof value.path === 'string') add(value.path);
    for (const key of ['content', 'images', 'attachments']) {
      if (key in value) visit(value[key], depth + 1);
    }
  };
  visit(item);
  const text = extractText(item);
  for (const match of text.matchAll(/:{1,2}codex-file-citation\{((?:[^}"\n]|"[^"\n]*")*)\}/g)) {
    const pathMatch = String(match[1] || '').match(/\bpath="([^"]*)"/);
    if (pathMatch) add(pathMatch[1]);
  }
  for (const match of text.matchAll(/\[[^\]\n]+\]\((?:<([^>\n]+)>|([^\s)]+))\)/g)) {
    add(match[1] || match[2]);
  }
  return [...new Set(candidates.map(normalizePathKey))].slice(0, 12);
}

function publicItemArtifacts(item) {
  return extractArtifactPaths(item).map((candidatePath) => {
    const cached = preparedArtifactCache.get(candidatePath);
    return cached?.artifact && cached.expiresAt > Date.now() ? cached.artifact : null;
  }).filter(Boolean);
}

function publicLocalImage(candidatePath, detail = null) {
  if (!isAllowedImagePath(candidatePath)) return null;
  const cached = preparedImageCache.get(normalizePathKey(candidatePath));
  if (!cached?.image || cached.expiresAt < Date.now()) return null;
  return { ...cached.image, detail: detail || null };
}

async function prepareItemAssets(item) {
  await Promise.all([prepareItemImages(item), prepareItemArtifacts(item)]);
}

async function prepareItemImages(item) {
  if (!item || typeof item !== 'object') return;
  const candidates = [];
  const visit = (value, depth = 0) => {
    if (depth > 6 || value == null || candidates.length >= 12) return;
    if (Array.isArray(value)) {
      value.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    if (typeof value !== 'object') return;
    if ((value.type === 'localImage' || value.type === 'imageView') && typeof value.path === 'string') candidates.push(value.path);
    if (value.type === 'imageGeneration' && typeof value.savedPath === 'string') candidates.push(value.savedPath);
    for (const key of ['content', 'images', 'attachments']) {
      if (key in value) visit(value[key], depth + 1);
    }
  };
  visit(item);
  await Promise.all([...new Set(candidates)].map(prepareLocalImage));
}

async function prepareItemArtifacts(item) {
  await Promise.all(extractArtifactPaths(item).map(prepareLocalArtifact));
}

async function prepareThreadImages(thread) {
  const turns = Array.isArray(thread?.turns) ? thread.turns.slice(-24) : [];
  await Promise.all(turns.flatMap((turn) => turn.items || []).map(prepareItemAssets));
}

async function prepareLocalArtifact(candidatePath) {
  if (!isAllowedLocalPath(candidatePath)) return null;
  const candidateKey = normalizePathKey(candidatePath);
  const cached = preparedArtifactCache.get(candidateKey);
  if (cached?.checkedAt > Date.now() - 30_000 && cached.expiresAt > Date.now()) return cached.artifact;
  let handle;
  try {
    const resolved = await fs.promises.realpath(path.resolve(candidatePath));
    if (!isAllowedLocalPath(resolved)) throw new Error('Artifact path is outside allowed roots');
    handle = await fs.promises.open(resolved, 'r');
    const stats = await handle.stat({ bigint: true });
    if (!stats.isFile() || stats.size <= 0n || stats.size > BigInt(MAX_ARTIFACT_BYTES)) throw new Error('Unsupported artifact');
    const extension = path.extname(resolved).toLowerCase();
    const type = ARTIFACT_TYPES.get(extension) || { mimeType: 'application/octet-stream', previewable: false };
    const fileIdentity = {
      path: resolved,
      size: stats.size.toString(),
      mtimeNs: stats.mtimeNs.toString(),
      ino: stats.ino.toString(),
      dev: stats.dev.toString(),
    };
    const identity = JSON.stringify(fileIdentity);
    const token = artifactTokenForPath(identity, fileIdentity);
    const artifact = {
      id: crypto.createHash('sha256').update(identity).digest('base64url').slice(0, 20),
      name: path.basename(resolved),
      extension: extension.slice(1).toUpperCase() || 'FILE',
      mimeType: type.mimeType.split(';', 1)[0],
      size: Number(stats.size),
      previewable: Boolean(type.previewable),
      previewUrl: `api/artifacts/${token}`,
      downloadUrl: `api/artifacts/${token}?download=1`,
    };
    while (preparedArtifactCache.size >= 1_024) preparedArtifactCache.delete(preparedArtifactCache.keys().next().value);
    preparedArtifactCache.set(candidateKey, { artifact, checkedAt: Date.now(), expiresAt: Date.now() + IMAGE_TOKEN_TTL_MS });
    return artifact;
  } catch {
    preparedArtifactCache.set(candidateKey, { artifact: null, checkedAt: Date.now(), expiresAt: Date.now() + 10_000 });
    return null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function prepareLocalImage(candidatePath) {
  if (!isAllowedImagePath(candidatePath)) return null;
  const candidateKey = normalizePathKey(candidatePath);
  const cached = preparedImageCache.get(candidateKey);
  if (cached?.checkedAt > Date.now() - 30_000 && cached.expiresAt > Date.now()) return cached.image;
  let handle;
  try {
    const resolved = await fs.promises.realpath(path.resolve(candidatePath));
    if (!isAllowedImagePath(resolved)) throw new Error('Image path is outside allowed roots');
    handle = await fs.promises.open(resolved, 'r');
    const stats = await handle.stat({ bigint: true });
    const mimeType = IMAGE_TYPES.get(path.extname(resolved).toLowerCase());
    if (!stats.isFile() || !mimeType || stats.size <= 0n || stats.size > BigInt(MAX_IMAGE_BYTES)) throw new Error('Unsupported image');
    const fileIdentity = {
      path: resolved,
      size: stats.size.toString(),
      mtimeNs: stats.mtimeNs.toString(),
      ino: stats.ino.toString(),
      dev: stats.dev.toString(),
    };
    const identity = JSON.stringify(fileIdentity);
    const image = {
      id: crypto.createHash('sha256').update(identity).digest('base64url').slice(0, 20),
      name: path.basename(resolved),
      mimeType,
      url: `api/images/${imageTokenForPath(identity, fileIdentity)}`,
    };
    while (preparedImageCache.size >= 512) preparedImageCache.delete(preparedImageCache.keys().next().value);
    preparedImageCache.set(candidateKey, { image, checkedAt: Date.now(), expiresAt: Date.now() + IMAGE_TOKEN_TTL_MS });
    return image;
  } catch {
    preparedImageCache.set(candidateKey, { image: null, checkedAt: Date.now(), expiresAt: Date.now() + 10_000 });
    return null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function normalizePathKey(value) {
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isAllowedImagePath(candidatePath) {
  return isAllowedLocalPath(candidatePath);
}

function isAllowedLocalPath(candidatePath) {
  if (typeof candidatePath !== 'string' || !candidatePath || candidatePath.length > 1_024 || candidatePath.includes('\0')) return false;
  if (process.platform === 'win32') {
    if (!/^[a-zA-Z]:[\\/]/.test(candidatePath) || /^(?:[\\/]{2}|[\\/]{2}[?.][\\/])/.test(candidatePath)) return false;
  } else if (!path.isAbsolute(candidatePath)) {
    return false;
  }
  const key = normalizePathKey(candidatePath);
  return IMAGE_ALLOWED_ROOTS.some((root) => key === root || key.startsWith(`${root}${path.sep}`));
}

function imageTokenForPath(identity, fileIdentity) {
  const cached = sealedImageTokenCache.get(identity);
  if (cached?.expiresAt > Date.now() + 60_000) return cached.token;
  while (sealedImageTokenCache.size >= 512) sealedImageTokenCache.delete(sealedImageTokenCache.keys().next().value);
  const expiresAt = Date.now() + IMAGE_TOKEN_TTL_MS;
  const token = sealImageToken(fileIdentity, expiresAt);
  sealedImageTokenCache.set(identity, { token, expiresAt });
  return token;
}

function sealImageToken(fileIdentity, expiresAt) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', IMAGE_TOKEN_KEY, iv);
  cipher.setAAD(IMAGE_TOKEN_AAD);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify({ ...fileIdentity, expiresAt }), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

function openImageToken(token) {
  try {
    const payload = Buffer.from(token, 'base64url');
    if (payload.length < 29) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', IMAGE_TOKEN_KEY, payload.subarray(0, 12));
    decipher.setAAD(IMAGE_TOKEN_AAD);
    decipher.setAuthTag(payload.subarray(12, 28));
    const decoded = JSON.parse(Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString('utf8'));
    if (typeof decoded.path !== 'string'
      || !['size', 'mtimeNs', 'ino', 'dev'].every((key) => typeof decoded[key] === 'string')
      || !Number.isFinite(decoded.expiresAt)
      || decoded.expiresAt < Date.now()
      || !isAllowedImagePath(decoded.path)) return null;
    return decoded;
  } catch {
    return null;
  }
}

function artifactTokenForPath(identity, fileIdentity) {
  const cached = sealedArtifactTokenCache.get(identity);
  if (cached?.expiresAt > Date.now() + 60_000) return cached.token;
  while (sealedArtifactTokenCache.size >= 1_024) sealedArtifactTokenCache.delete(sealedArtifactTokenCache.keys().next().value);
  const expiresAt = Date.now() + IMAGE_TOKEN_TTL_MS;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ARTIFACT_TOKEN_KEY, iv);
  cipher.setAAD(ARTIFACT_TOKEN_AAD);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify({ ...fileIdentity, expiresAt }), 'utf8'), cipher.final()]);
  const token = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
  sealedArtifactTokenCache.set(identity, { token, expiresAt });
  return token;
}

function openArtifactToken(token) {
  try {
    const payload = Buffer.from(token, 'base64url');
    if (payload.length < 29) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', ARTIFACT_TOKEN_KEY, payload.subarray(0, 12));
    decipher.setAAD(ARTIFACT_TOKEN_AAD);
    decipher.setAuthTag(payload.subarray(12, 28));
    const decoded = JSON.parse(Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString('utf8'));
    if (typeof decoded.path !== 'string'
      || !['size', 'mtimeNs', 'ino', 'dev'].every((key) => typeof decoded[key] === 'string')
      || !Number.isFinite(decoded.expiresAt)
      || decoded.expiresAt < Date.now()
      || !isAllowedLocalPath(decoded.path)) return null;
    return decoded;
  } catch {
    return null;
  }
}

async function serveArtifactAsset(request, response, token, { download = false } = {}) {
  const sealed = openArtifactToken(token);
  if (!sealed) return json(response, 404, { error: 'Artifact not found' });
  let handle;
  try {
    handle = await fs.promises.open(sealed.path, 'r');
  } catch {
    return json(response, 404, { error: 'Artifact not found' });
  }
  let stats;
  try {
    stats = await handle.stat({ bigint: true });
  } catch {
    await handle.close().catch(() => {});
    return json(response, 404, { error: 'Artifact not found' });
  }
  const identityMatches = stats.size.toString() === sealed.size
    && stats.mtimeNs.toString() === sealed.mtimeNs
    && stats.ino.toString() === sealed.ino
    && stats.dev.toString() === sealed.dev;
  if (!stats.isFile() || !identityMatches || stats.size <= 0n || stats.size > BigInt(MAX_ARTIFACT_BYTES)) {
    await handle.close().catch(() => {});
    return json(response, 415, { error: 'Unsupported artifact' });
  }
  const fileName = path.basename(sealed.path);
  const type = ARTIFACT_TYPES.get(path.extname(sealed.path).toLowerCase()) || {
    mimeType: 'application/octet-stream',
    previewable: false,
  };
  const forceDownload = download || !type.previewable;
  const totalSize = Number(stats.size);
  const etag = `"${stats.size.toString(16)}-${stats.mtimeNs.toString(16)}"`;
  if (!request.headers.range && request.headers['if-none-match'] === etag) {
    await handle.close().catch(() => {});
    response.writeHead(304, {
      ETag: etag,
      'Cache-Control': 'private, no-cache',
      Vary: 'Cookie',
      'X-Content-Type-Options': 'nosniff',
    });
    return response.end();
  }
  let start = 0;
  let end = totalSize - 1;
  let partial = false;
  const rangeMatch = String(request.headers.range || '').match(/^bytes=(\d*)-(\d*)$/);
  if (rangeMatch) {
    if (rangeMatch[1]) start = Number(rangeMatch[1]);
    if (rangeMatch[2]) end = Number(rangeMatch[2]);
    if (!rangeMatch[1] && rangeMatch[2]) {
      const suffix = Number(rangeMatch[2]);
      start = Math.max(0, totalSize - suffix);
      end = totalSize - 1;
    }
    partial = Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start && start < totalSize;
    end = Math.min(end, totalSize - 1);
    if (!partial) {
      await handle.close().catch(() => {});
      response.writeHead(416, { 'Content-Range': `bytes */${totalSize}` });
      return response.end();
    }
  }
  const headers = {
    'Content-Type': type.mimeType,
    'Content-Length': String(end - start + 1),
    'Content-Disposition': `${forceDownload ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-cache',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'",
    Vary: 'Cookie',
    ETag: etag,
    ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${totalSize}` } : {}),
  };
  response.writeHead(partial ? 206 : 200, headers);
  if (request.method === 'HEAD') {
    await handle.close().catch(() => {});
    return response.end();
  }
  const stream = handle.createReadStream({ start, end, autoClose: true });
  stream.on('error', async () => {
    await handle.close().catch(() => {});
    response.destroy();
  });
  stream.pipe(response);
}

async function serveImageAsset(request, response, token) {
  const sealed = openImageToken(token);
  if (!sealed) return json(response, 404, { error: 'Image not found' });
  let handle;
  try {
    handle = await fs.promises.open(sealed.path, 'r');
  } catch {
    return json(response, 404, { error: 'Image not found' });
  }
  let stats;
  try {
    stats = await handle.stat({ bigint: true });
  } catch {
    await handle.close().catch(() => {});
    return json(response, 404, { error: 'Image not found' });
  }
  const mimeType = IMAGE_TYPES.get(path.extname(sealed.path).toLowerCase());
  const identityMatches = stats.size.toString() === sealed.size
    && stats.mtimeNs.toString() === sealed.mtimeNs
    && stats.ino.toString() === sealed.ino
    && stats.dev.toString() === sealed.dev;
  if (!stats.isFile() || !identityMatches || !mimeType || stats.size <= 0n || stats.size > BigInt(MAX_IMAGE_BYTES)) {
    await handle.close().catch(() => {});
    return json(response, 415, { error: 'Unsupported image' });
  }
  const etag = `"${stats.size.toString(16)}-${stats.mtimeNs.toString(16)}"`;
  if (request.headers['if-none-match'] === etag) {
    await handle.close().catch(() => {});
    response.writeHead(304, {
      ETag: etag,
      'Cache-Control': 'private, no-cache',
      Vary: 'Cookie',
      'X-Content-Type-Options': 'nosniff',
    });
    return response.end();
  }
  response.writeHead(200, {
    'Content-Type': mimeType,
    'Content-Length': stats.size.toString(),
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(path.basename(sealed.path))}`,
    'Cache-Control': 'private, no-cache',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Cookie',
    ETag: etag,
  });
  if (request.method === 'HEAD') {
    await handle.close().catch(() => {});
    return response.end();
  }
  const stream = handle.createReadStream({ autoClose: true });
  stream.on('error', async () => {
    await handle.close().catch(() => {});
    response.destroy();
  });
  stream.pipe(response);
}

function publicItemDetail(item) {
  if (item.type === 'commandExecution') {
    return {
      id: item.id,
      type: item.type,
      command: Array.isArray(item.command) ? item.command.join(' ') : String(item.command || ''),
      cwd: item.cwd || null,
      status: item.status || null,
      output: String(item.aggregatedOutput || item.output || '').slice(-16_000),
    };
  }
  return publicItem(item);
}

function findThreadItem(thread, itemId) {
  for (const turn of thread?.turns || []) {
    const item = (turn.items || []).find((candidate) => String(candidate?.id) === String(itemId));
    if (item) return item;
  }
  return null;
}

function findInProgressTurnId(thread) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const active = [...turns].reverse().find((turn) => /progress|running|started/i.test(String(turn?.status?.type || turn?.status || '')));
  return active?.id || null;
}

function loadThreadListCache() {
  const fallback = { schemaVersion: 2, updatedAt: 0, lastFullRefreshAt: 0, complete: false, threads: [] };
  if (!THREAD_LIST_CACHE_FILE) return fallback;
  try {
    const value = JSON.parse(fs.readFileSync(THREAD_LIST_CACHE_FILE, 'utf8'));
    const currentSchema = Number(value.schemaVersion) === 2 && Number.isFinite(Number(value.lastFullRefreshAt));
    return {
      schemaVersion: 2,
      updatedAt: Number(value.updatedAt || 0),
      lastFullRefreshAt: currentSchema ? Number(value.lastFullRefreshAt) : 0,
      complete: currentSchema && Boolean(value.complete),
      threads: Array.isArray(value.threads) ? value.threads.map(stripThreadListEntry).filter(Boolean) : [],
    };
  } catch {
    return fallback;
  }
}

function stripThreadListEntry(thread) {
  if (!thread?.id || thread.ephemeral) return null;
  return {
    id: thread.id,
    name: thread.name || null,
    preview: String(thread.preview || '').slice(0, 1_000),
    cwd: thread.cwd || null,
    updatedAt: thread.updatedAt || null,
    createdAt: thread.createdAt || null,
    status: thread.status?.type || thread.status || null,
    isPinned: Boolean(thread.isPinned),
  };
}

function buildCachedThreadList(searchTerm, limit) {
  let emptyStateChanged = pruneEmptyThreads();
  const cached = threadListCache.threads.filter(Boolean);
  const cachedIds = new Set(cached.map((thread) => thread.id));
  for (const thread of cached) {
    if (seenState.emptyThreads[thread.id] && String(thread.preview || '').trim()) {
      delete seenState.emptyThreads[thread.id];
      emptyStateChanged = true;
    }
  }
  if (emptyStateChanged) persistSeenState(seenState);
  const query = String(searchTerm || '').trim().toLowerCase();
  return [...cached, ...Object.values(seenState.emptyThreads).filter((thread) => !cachedIds.has(thread.id))]
    .filter((thread) => !query || [thread.id, thread.name, thread.preview, thread.cwd]
      .some((value) => String(value || '').toLowerCase().includes(query)))
    .sort((left, right) => normalizeTimestamp(right.updatedAt) - normalizeTimestamp(left.updatedAt))
    .slice(0, limit);
}

function replaceThreadListCache(threads, { complete = true, refreshStartedAtSequence = null } = {}) {
  const current = new Map(threadListCache.threads.filter(Boolean).map((thread) => [thread.id, thread]));
  const incoming = threads.map(stripThreadListEntry).filter(Boolean);
  const incomingIds = new Set(incoming.map((thread) => thread.id));
  const next = incoming.flatMap((thread) => {
    if (threadListTombstones.has(thread.id)) return [];
    const existing = current.get(thread.id);
    const changedDuringRefresh = refreshStartedAtSequence != null
      && (threadListMutationVersions.get(thread.id) || 0) > refreshStartedAtSequence;
    const value = changedDuringRefresh && existing
      ? existing
      : existing && normalizeTimestamp(existing.updatedAt) > normalizeTimestamp(thread.updatedAt)
        ? existing
        : thread;
    const statusOverride = threadListStatusOverrides.get(thread.id);
    if (statusOverride && refreshStartedAtSequence != null && statusOverride.sequence > refreshStartedAtSequence) {
      value.status = statusOverride.status;
    }
    return [value];
  });
  if (refreshStartedAtSequence != null) {
    for (const [threadId, existing] of current) {
      if (!incomingIds.has(threadId) && (threadListMutationVersions.get(threadId) || 0) > refreshStartedAtSequence) {
        next.push(existing);
      }
    }
  }
  if (complete) {
    for (const threadId of threadListTombstones) {
      if (!incomingIds.has(threadId)) threadListTombstones.delete(threadId);
    }
    for (const [threadId, override] of threadListStatusOverrides) {
      if (refreshStartedAtSequence == null || override.sequence <= refreshStartedAtSequence) {
        threadListStatusOverrides.delete(threadId);
      }
    }
    for (const [threadId, version] of threadListMutationVersions) {
      if ((refreshStartedAtSequence == null || version <= refreshStartedAtSequence)
        && !threadListTombstones.has(threadId)
        && !threadListStatusOverrides.has(threadId)) {
        threadListMutationVersions.delete(threadId);
      }
    }
    threadListCache.lastFullRefreshAt = Date.now();
  }
  threadListCache.threads = next;
  threadListCache.updatedAt = Date.now();
  threadListCache.complete = complete;
  persistThreadListCache();
}

function upsertThreadListEntry(thread) {
  const value = stripThreadListEntry(thread);
  if (!value) return;
  threadListMutationSequence += 1;
  threadListMutationVersions.set(value.id, threadListMutationSequence);
  threadListTombstones.delete(value.id);
  threadListStatusOverrides.delete(value.id);
  const index = threadListCache.threads.findIndex((candidate) => candidate?.id === value.id);
  if (index >= 0) threadListCache.threads[index] = value;
  else threadListCache.threads.unshift(value);
  threadListCache.updatedAt = Date.now();
  schedulePersistThreadListCache();
}

function updateThreadListStatus(threadId, status) {
  if (!threadId) return;
  const normalizedStatus = status?.type || status || null;
  threadListMutationSequence += 1;
  threadListMutationVersions.set(threadId, threadListMutationSequence);
  threadListStatusOverrides.set(threadId, { status: normalizedStatus, sequence: threadListMutationSequence });
  const thread = threadListCache.threads.find((candidate) => candidate?.id === threadId);
  if (!thread) return;
  thread.status = normalizedStatus;
  threadListCache.updatedAt = Date.now();
  schedulePersistThreadListCache();
}

function removeThreadListEntry(threadId) {
  if (!threadId) return;
  threadListMutationSequence += 1;
  threadListMutationVersions.set(threadId, threadListMutationSequence);
  threadListTombstones.add(threadId);
  threadListStatusOverrides.delete(threadId);
  const before = threadListCache.threads.length;
  threadListCache.threads = threadListCache.threads.filter((thread) => thread?.id !== threadId);
  if (threadListCache.threads.length === before) return;
  threadListCache.updatedAt = Date.now();
  schedulePersistThreadListCache();
}

function scheduleThreadListRefresh({ force = false } = {}) {
  if (threadListRefreshPromise) return threadListRefreshPromise;
  if (!force && threadListCache.complete && Date.now() - threadListCache.lastFullRefreshAt < 60_000) return null;
  threadListRefreshPromise = (async () => {
    try {
      const refreshStartedAtSequence = threadListMutationSequence;
      const threads = [];
      let cursor = null;
      let nextCursor = null;
      let pageCount = 0;
      const seenCursors = new Set();
      do {
        pageCount += 1;
        if (pageCount > 10_000) throw new Error('thread/list exceeded the pagination safety limit');
        const result = await appServer.listThreads({ limit: 200, cursor });
        threads.push(...(result.data || []));
        nextCursor = result.nextCursor || null;
        if (nextCursor && seenCursors.has(nextCursor)) throw new Error('thread/list returned a repeated cursor');
        if (nextCursor) seenCursors.add(nextCursor);
        cursor = nextCursor;
      } while (cursor);
      const uniqueThreads = [...new Map(threads.filter((thread) => thread?.id).map((thread) => [thread.id, thread])).values()];
      replaceThreadListCache(uniqueThreads, {
        complete: true,
        refreshStartedAtSequence,
      });
      broadcast({ type: 'threadListUpdated', count: threadListCache.threads.length, updatedAt: threadListCache.updatedAt });
    } catch (error) {
      console.warn(`Unable to refresh mobile thread-list cache: ${error.message}`);
    } finally {
      threadListRefreshPromise = null;
    }
  })();
  return threadListRefreshPromise;
}

function schedulePersistThreadListCache() {
  clearTimeout(threadListPersistTimer);
  threadListPersistTimer = setTimeout(() => {
    threadListPersistTimer = null;
    persistThreadListCache();
  }, 300);
  threadListPersistTimer.unref?.();
}

function persistThreadListCache() {
  if (!THREAD_LIST_CACHE_FILE) return;
  try {
    fs.mkdirSync(path.dirname(THREAD_LIST_CACHE_FILE), { recursive: true });
    const temporary = `${THREAD_LIST_CACHE_FILE}.tmp.${process.pid}`;
    fs.writeFileSync(temporary, JSON.stringify(threadListCache), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, THREAD_LIST_CACHE_FILE);
  } catch (error) {
    console.warn(`Unable to persist mobile thread-list cache: ${error.message}`);
  }
}

function loadSeenState() {
  const fallback = { schemaVersion: 2, baselineAt: Math.floor(Date.now() / 1000), threads: {}, emptyThreads: {} };
  if (!SEEN_FILE) return fallback;
  try {
    const value = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
    const normalized = {
      schemaVersion: 2,
      baselineAt: value.baselineAt == null ? fallback.baselineAt : Number(value.baselineAt),
      threads: value.threads && typeof value.threads === 'object' ? value.threads : {},
      emptyThreads: value.emptyThreads && typeof value.emptyThreads === 'object' ? value.emptyThreads : {},
    };
    const beforePruneCount = Object.keys(normalized.emptyThreads).length;
    const cutoff = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
    normalized.emptyThreads = Object.fromEntries(Object.entries(normalized.emptyThreads)
      .filter(([, thread]) => normalizeTimestamp(thread?.updatedAt) >= cutoff)
      .sort((left, right) => normalizeTimestamp(right[1]?.updatedAt) - normalizeTimestamp(left[1]?.updatedAt))
      .slice(0, 200));
    if (value.schemaVersion !== 2 || !value.emptyThreads || Object.keys(normalized.emptyThreads).length !== beforePruneCount) persistSeenState(normalized);
    return normalized;
  } catch {
    persistSeenState(fallback);
    return fallback;
  }
}

function markThreadSeen(threadId, updatedAt) {
  if (!threadId) return;
  seenState.threads[threadId] = {
    seenAt: Math.max(normalizeTimestamp(updatedAt), Math.floor(Date.now() / 1000)),
    unread: false,
  };
  pruneSeenState();
  persistSeenState(seenState);
}

function markThreadUnseen(threadId) {
  if (!threadId) return;
  const existing = getSeenRecord(threadId);
  seenState.threads[threadId] = { seenAt: existing.seenAt, unread: true };
  pruneSeenState();
  persistSeenState(seenState);
}

function getSeenRecord(threadId) {
  const value = seenState.threads[threadId];
  if (value && typeof value === 'object') {
    return { seenAt: Number(value.seenAt || 0), unread: Boolean(value.unread) };
  }
  return { seenAt: Number(value ?? seenState.baselineAt ?? 0), unread: false };
}

function pruneSeenState() {
  const entries = Object.entries(seenState.threads);
  if (entries.length > 2_000) {
    entries.sort((left, right) => getSeenRecord(right[0]).seenAt - getSeenRecord(left[0]).seenAt);
    seenState.threads = Object.fromEntries(entries.slice(0, 1_500));
  }
}

function isThreadVisibleOnMobile(threadId) {
  sweepMobileViewers();
  let visible = false;
  for (const viewer of mobileViewers.values()) {
    if (viewer.threadId === threadId) visible = true;
  }
  return visible;
}

function sweepMobileViewers() {
  const expiry = Date.now() - 45_000;
  for (const [viewerId, viewer] of mobileViewers) {
    if (viewer.seenAt < expiry) mobileViewers.delete(viewerId);
  }
  if (mobileViewers.size > 1_000) {
    const kept = [...mobileViewers.entries()]
      .sort((left, right) => right[1].seenAt - left[1].seenAt)
      .slice(0, 750);
    mobileViewers.clear();
    for (const [viewerId, viewer] of kept) mobileViewers.set(viewerId, viewer);
  }
}

function rememberEmptyThread(thread) {
  if (!thread?.id || thread.ephemeral || String(thread.preview || '').trim()) return;
  seenState.emptyThreads[thread.id] = {
    id: thread.id,
    name: thread.name || null,
    preview: '',
    cwd: thread.cwd || null,
    updatedAt: thread.updatedAt || thread.createdAt || Math.floor(Date.now() / 1000),
    createdAt: thread.createdAt || null,
    status: thread.status?.type || thread.status || 'idle',
    isPinned: Boolean(thread.isPinned),
  };
  pruneEmptyThreads();
  persistSeenState(seenState);
}

function pruneEmptyThreads() {
  const entries = Object.entries(seenState.emptyThreads);
  const cutoff = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
  const kept = entries
    .filter(([, thread]) => normalizeTimestamp(thread?.updatedAt) >= cutoff)
    .sort((left, right) => normalizeTimestamp(right[1]?.updatedAt) - normalizeTimestamp(left[1]?.updatedAt))
    .slice(0, 200);
  if (kept.length === entries.length && kept.every(([id], index) => id === entries[index]?.[0])) return false;
  seenState.emptyThreads = Object.fromEntries(kept);
  return true;
}

function forgetEmptyThread(threadId) {
  if (!threadId || !seenState.emptyThreads[threadId]) return;
  delete seenState.emptyThreads[threadId];
  persistSeenState(seenState);
}

function forgetThread(threadId) {
  if (!threadId) return;
  let changed = false;
  if (seenState.emptyThreads[threadId]) {
    delete seenState.emptyThreads[threadId];
    changed = true;
  }
  if (seenState.threads[threadId]) {
    delete seenState.threads[threadId];
    changed = true;
  }
  if (changed) persistSeenState(seenState);
}

function updateEmptyThreadStatus(threadId, status) {
  const thread = seenState.emptyThreads[threadId];
  if (!thread) return;
  thread.status = status?.type || status || thread.status;
  thread.updatedAt = Math.floor(Date.now() / 1000);
  persistSeenState(seenState);
}

function persistSeenState(value) {
  if (!SEEN_FILE) return;
  try {
    fs.mkdirSync(path.dirname(SEEN_FILE), { recursive: true });
    const temporary = `${SEEN_FILE}.tmp.${process.pid}`;
    fs.writeFileSync(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, SEEN_FILE);
  } catch (error) {
    console.warn(`Unable to persist mobile seen state: ${error.message}`);
  }
}

function normalizeTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric > 1e12 ? Math.floor(numeric / 1000) : Math.floor(numeric);
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

function extractText(value) {
  const parts = [];
  const visit = (node, depth = 0) => {
    if (depth > 6 || node == null) return;
    if (typeof node === 'string') return parts.push(node);
    if (Array.isArray(node)) return node.forEach((entry) => visit(entry, depth + 1));
    if (typeof node !== 'object') return;
    for (const key of ['text', 'content', 'message']) {
      if (key in node) visit(node[key], depth + 1);
    }
  };
  visit(value);
  return parts.join('\n').replace(/\r\n?/g, '\n').trim();
}

function sanitizeNotification(message, sequence = 0) {
  const allowed = new Set([
    'turn/started',
    'turn/completed',
    'thread/started',
    'thread/deleted',
    'item/started',
    'item/completed',
    'item/agentMessage/delta',
    'item/plan/delta',
    'item/mcpToolCall/progress',
    'thread/status/changed',
    'serverRequest/resolved',
    'error',
  ]);
  if (!allowed.has(message.method)) return null;
  const raw = message.params || {};
  const base = {
    threadId: raw.threadId || null,
    turnId: raw.turnId || raw.turn?.id || null,
  };
  let params;
  if (message.method === 'thread/started') {
    params = { thread: raw.thread ? publicThreadSummary(raw.thread) : null };
  } else if (message.method === 'thread/deleted') {
    params = { threadId: raw.threadId || null };
  } else if (message.method === 'thread/status/changed') {
    params = { threadId: raw.threadId || null, status: publicStatus(raw.status) };
  } else if (message.method === 'turn/started' || message.method === 'turn/completed') {
    params = { ...base, turn: raw.turn ? { id: raw.turn.id || null, status: publicStatus(raw.turn.status) } : null };
  } else if (message.method === 'item/started' || message.method === 'item/completed') {
    params = { ...base, item: raw.item ? publicItem(raw.item) : null };
  } else if (message.method === 'item/agentMessage/delta' || message.method === 'item/plan/delta') {
    params = { ...base, itemId: raw.itemId || null, delta: String(raw.delta || '').slice(-16_000) };
  } else if (message.method === 'item/mcpToolCall/progress') {
    params = { ...base, itemId: raw.itemId || null, message: '工具正在处理…' };
  } else if (message.method === 'serverRequest/resolved') {
    params = { requestId: raw.requestId == null ? null : String(raw.requestId) };
  } else {
    params = {
      error: {
        message: safePreviewText(raw.error?.message || raw.message || 'Codex 出错', 500),
        code: raw.error?.code || raw.code || null,
      },
    };
  }
  return { type: 'notification', method: message.method, params, sequence: Number(sequence || 0) };
}

function publicStatus(status) {
  if (status == null) return null;
  if (typeof status === 'string') return safePreviewText(status, 80);
  return { type: safePreviewText(status.type, 80) || null };
}

function publicServerRequest(message) {
  const params = message.params || {};
  const safeDecisions = new Set(['accept', 'decline', 'cancel']);
  const supportedApproval = message.method === 'item/commandExecution/requestApproval' ||
    message.method === 'item/fileChange/requestApproval' ||
    message.method === 'item/permissions/requestApproval';
  const availableDecisions = message.method === 'item/permissions/requestApproval'
    ? ['accept', 'decline']
    : !supportedApproval
    ? []
    : Array.isArray(params.availableDecisions)
      ? params.availableDecisions.filter((value) => typeof value === 'string' && safeDecisions.has(value))
      : ['accept', 'decline', 'cancel'];
  const questions = message.method === 'item/tool/requestUserInput'
    ? (Array.isArray(params.questions) ? params.questions : []).slice(0, 8).map((question) => ({
        id: safePreviewText(question?.id, 160),
        header: safePreviewText(question?.header, 120),
        question: safePreviewText(question?.question, 1_000),
        isOther: Boolean(question?.isOther),
        isSecret: Boolean(question?.isSecret),
        options: Array.isArray(question?.options)
          ? question.options.slice(0, 12).map((option) => ({
              label: safePreviewText(option?.label, 240),
              description: safePreviewText(option?.description, 500),
            })).filter((option) => option.label)
          : null,
      })).filter((question) => question.id && question.question)
    : [];
  const elicitation = message.method === 'mcpServer/elicitation/request'
    ? {
        mode: ['form', 'openai/form', 'url'].includes(params.mode) ? params.mode : null,
        serverName: safePreviewText(params.serverName, 160),
        message: safePreviewText(params.message, 1_000),
        url: /^https?:\/\//i.test(String(params.url || '')) ? String(params.url).slice(0, 2_048) : null,
        requestedSchema: boundedJsonValue(params.requestedSchema, 16_000),
      }
    : null;
  return {
    id: String(message.id),
    method: message.method,
    threadId: params.threadId || null,
    turnId: params.turnId || null,
    itemId: params.itemId || params.callId || null,
    namespace: safePreviewText(params.namespace, 100) || null,
    tool: safePreviewText(params.tool, 120) || null,
    reason: params.reason || null,
    command: params.command || null,
    commandActions: params.commandActions || null,
    cwd: params.cwd || null,
    networkApprovalContext: params.networkApprovalContext || null,
    additionalPermissions: params.additionalPermissions || null,
    proposedExecpolicyAmendment: params.proposedExecpolicyAmendment || null,
    proposedNetworkPolicyAmendments: params.proposedNetworkPolicyAmendments || null,
    grantRoot: params.grantRoot || null,
    permissions: boundedJsonValue(params.permissions, 8_000),
    availableDecisions,
    questions,
    elicitation,
  };
}

function boundedJsonValue(value, maxLength) {
  if (value == null) return null;
  try {
    const serialized = JSON.stringify(value);
    return serialized.length <= maxLength ? JSON.parse(serialized) : null;
  } catch {
    return null;
  }
}

function prunePendingServerRequests({ threadId = null, turnId = null, callId = null } = {}) {
  const requestIds = [];
  for (const [requestId, request] of appServer.serverRequests.entries()) {
    const params = request.params || {};
    if (threadId && params.threadId !== threadId) continue;
    if (turnId && params.turnId !== turnId) continue;
    if (callId && params.callId !== callId && params.itemId !== callId) continue;
    appServer.serverRequests.delete(requestId);
    requestIds.push(String(requestId));
  }
  if (requestIds.length > 0) broadcast({ type: 'serverRequestsPruned', requestIds });
  return requestIds;
}

function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) client.write(payload);
}

setInterval(() => {
  for (const client of sseClients) client.write(': ping\n\n');
}, 20_000).unref();

function requireAuth(request) {
  if (!secret) return;
  const cookies = parseCookies(request.headers.cookie || '');
  const expected = sessionToken();
  if (!safeEqual(cookies.codex_mobile_session || '', expected)) {
    const error = new Error('需要登录');
    error.statusCode = 401;
    throw error;
  }
}

function sessionToken() {
  return crypto.createHmac('sha256', secret).update('codex-mobile-session-v1').digest('hex');
}

function sessionCookie() {
  const secure = process.env.CODEX_MOBILE_SECURE_COOKIE === '1' ? '; Secure' : '';
  return `codex_mobile_session=${sessionToken()}; Path=${COOKIE_PATH}; HttpOnly; SameSite=Strict; Max-Age=2592000${secure}`;
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseCookies(header) {
  return Object.fromEntries(header.split(';').map((part) => {
    const index = part.indexOf('=');
    if (index < 0) return ['', ''];
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(([key]) => key));
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 128_000) throw Object.assign(new Error('Request too large'), { statusCode: 413 });
  }
  return body ? JSON.parse(body) : {};
}

function json(response, status, value) {
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
  const fullPath = path.resolve(PUBLIC, relative);
  if (!fullPath.startsWith(path.resolve(PUBLIC)) || !fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
    return json(response, 404, { error: 'Not found' });
  }
  const ext = path.extname(fullPath).toLowerCase();
  const type = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
  }[ext] || 'application/octet-stream';
  response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  fs.createReadStream(fullPath).pipe(response);
}

async function shutdown() {
  server.close();
  await appServer.stop();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
