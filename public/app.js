const $ = (selector) => document.querySelector(selector);

const state = {
  threads: [],
  activeThread: null,
  activeTurnId: null,
  activeTurnThreadId: null,
  turnActivityPhase: null,
  turnLifecycleGeneration: 0,
  canSteer: true,
  canInterrupt: true,
  eventSource: null,
  pendingRequests: new Map(),
  toolAlerts: new Map(),
  streaming: new Map(),
  liveToolGroups: new Map(),
  deferredThreadSnapshot: null,
  threadRefreshTimer: null,
  threadListRequest: 0,
  threadOpenRequest: 0,
  historyPager: null,
  historyObserver: null,
  attachments: [],
  uploadQueue: Promise.resolve(),
  followLatest: true,
  jumpScrollTimer: null,
  viewSequence: 0,
  viewerId: getViewerId(),
};

const elements = {
  login: $('#login'),
  loginForm: $('#login-form'),
  loginError: $('#login-error'),
  password: $('#password'),
  connection: $('#connection'),
  threadList: $('#thread-list'),
  threadListStatus: $('#thread-list-status'),
  search: $('#search'),
  emptyState: $('#empty-state'),
  threadView: $('#thread-view'),
  threadTitle: $('#thread-title'),
  threadMeta: $('#thread-meta'),
  messages: $('#messages'),
  jumpBottom: $('#jump-bottom'),
  notice: $('#notice'),
  composer: $('#composer'),
  prompt: $('#prompt'),
  send: $('#send'),
  stop: $('#stop'),
  refresh: $('#refresh'),
  back: $('#back'),
  approvals: $('#approvals'),
  turnActivity: $('#turn-activity'),
  turnActivityText: $('#turn-activity-text'),
  retryResume: $('#retry-resume'),
  imageViewer: $('#image-viewer'),
  imageViewerClose: $('#image-viewer-close'),
  imageViewerStage: $('#image-viewer-stage'),
  imageViewerImage: $('#image-viewer-image'),
  imageViewerCaption: $('#image-viewer-caption'),
  attachments: $('#attachments'),
  attach: $('#attach'),
  attachmentInput: $('#attachment-input'),
  requestsToggle: $('#requests-toggle'),
  requestsBadge: $('#requests-badge'),
  requestDrawer: $('#request-drawer'),
  requestDrawerClose: $('#request-drawer-close'),
  requestPanelList: $('#request-panel-list'),
};

initializeNavigation();
boot();

async function boot() {
  try {
    const status = await api('api/status');
    setOnline(status.ready);
    state.canSteer = status.capabilities?.steerTurn !== false;
    state.canInterrupt = status.capabilities?.interruptTurn !== false;
    if (status.activeThreadId) {
      state.activeTurnId = status.activeTurnId;
      state.activeTurnThreadId = status.activeTurnId ? status.activeThreadId : null;
      state.turnActivityPhase = status.activeTurnId ? 'thinking' : null;
    }
    await loadThreads();
    connectEvents();
    await loadApprovals();
    if (history.state?.codexMobileView === 'thread' && history.state.threadId) {
      await openThread(history.state.threadId, { fromHistory: true });
    }
  } catch (error) {
    if (error.status === 401) {
      elements.login.classList.remove('hidden');
      elements.password.focus();
    } else {
      showNotice(error.message);
    }
  }
}

elements.loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  elements.loginError.textContent = '';
  try {
    await api('api/login', { method: 'POST', body: { password: elements.password.value } });
    elements.login.classList.add('hidden');
    elements.password.value = '';
    await boot();
  } catch (error) {
    elements.loginError.textContent = error.message;
  }
});

elements.search.addEventListener('input', debounce(loadThreads, 250));
elements.refresh.addEventListener('click', () => loadThreads({ forceRefresh: true }));
elements.back.addEventListener('click', () => {
  if (history.state?.codexMobileView === 'thread') history.back();
  else showThreadList();
});
elements.retryResume.addEventListener('click', () => state.activeThread && openThread(state.activeThread.id));
elements.messages.addEventListener('scroll', updateJumpBottom, { passive: true });
elements.jumpBottom.addEventListener('click', jumpToLatest);
document.addEventListener('visibilitychange', () => reportViewState());
window.addEventListener('pagehide', () => sendViewState(false));
window.addEventListener('resize', updateJumpBottom);
setInterval(() => reportViewState(), 15_000);
elements.imageViewerClose.addEventListener('click', closeImageViewer);
elements.imageViewer.addEventListener('click', (event) => {
  if (event.target === elements.imageViewer) closeImageViewer();
});
elements.imageViewerImage.addEventListener('click', () => elements.imageViewerImage.classList.toggle('zoomed'));
elements.attach.addEventListener('click', () => elements.attachmentInput.click());
elements.attachmentInput.addEventListener('change', () => {
  addSelectedAttachments([...elements.attachmentInput.files]);
  elements.attachmentInput.value = '';
});
elements.requestsToggle.addEventListener('click', openRequestDrawer);
elements.requestDrawerClose.addEventListener('click', closeRequestDrawer);
elements.requestDrawer.addEventListener('click', (event) => {
  if (event.target === elements.requestDrawer) closeRequestDrawer();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !elements.imageViewer.classList.contains('hidden')) closeImageViewer();
  else if (event.key === 'Escape' && !elements.requestDrawer.classList.contains('hidden')) closeRequestDrawer();
});

elements.composer.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.activeThread) return;
  const text = elements.prompt.value.trim();
  if (state.attachments.some((attachment) => ['queued', 'uploading'].includes(attachment.status))) {
    showNotice('附件仍在上传，请稍候');
    return;
  }
  if (state.attachments.some((attachment) => attachment.status === 'failed')) {
    showNotice('请先移除上传失败的附件后再发送');
    return;
  }
  const readyAttachments = state.attachments.filter((attachment) => attachment.status === 'ready' && attachment.id);
  if (!text && readyAttachments.length === 0) return;
  const submittedThreadId = state.activeThread.id;
  const pendingText = text || `已发送附件：${readyAttachments.map((attachment) => attachment.name).join('、')}`;
  const pending = addMessage({ type: 'userMessage', text: pendingText }, { pending: true });
  scrollBottom({ force: true });
  if (pending) pending._awaitingUserCompletion = true;
  const wasBusy = Boolean(state.activeTurnId && state.activeTurnThreadId === submittedThreadId);
  const lifecycleGeneration = state.turnLifecycleGeneration;
  elements.prompt.value = '';
  resizeComposer();
  if (!wasBusy) {
    state.activeTurnId = true;
    state.activeTurnThreadId = submittedThreadId;
    state.turnActivityPhase = 'thinking';
    syncComposerState();
  }
  try {
    const result = await api(`api/threads/${encodeURIComponent(submittedThreadId)}/messages`, {
      method: 'POST',
      body: { text, attachments: readyAttachments.map((attachment) => ({ id: attachment.id })) },
    });
    clearAttachments({ removeRemote: false });
    if (lifecycleGeneration === state.turnLifecycleGeneration && state.activeThread?.id === submittedThreadId) {
      state.activeTurnId = result.turn?.id || state.activeTurnId || true;
      state.activeTurnThreadId = submittedThreadId;
    }
    syncComposerState();
  } catch (error) {
    pending?.remove();
    if (state.activeThread?.id === submittedThreadId) {
      if (!elements.prompt.value) elements.prompt.value = text;
      resizeComposer();
      showNotice(error.message);
      if (!wasBusy) {
        state.activeTurnId = null;
        state.activeTurnThreadId = null;
        state.turnActivityPhase = null;
      }
      syncComposerState();
    }
  }
});

elements.prompt.addEventListener('input', resizeComposer);
elements.prompt.addEventListener('paste', handleClipboardPaste);
elements.prompt.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && window.innerWidth > 720) {
    event.preventDefault();
    elements.composer.requestSubmit();
  }
});

elements.stop.addEventListener('click', async () => {
  if (!state.activeThread || !state.activeTurnId) return;
  try {
    await api(`api/threads/${encodeURIComponent(state.activeThread.id)}/interrupt`, {
      method: 'POST',
      body: { turnId: state.activeTurnId === true ? null : state.activeTurnId },
    });
  } finally {
    state.turnLifecycleGeneration += 1;
    state.activeTurnId = null;
    state.activeTurnThreadId = null;
    state.turnActivityPhase = null;
    syncComposerState();
  }
});

async function loadThreads({ forceRefresh = false } = {}) {
  const requestId = ++state.threadListRequest;
  const query = elements.search.value.trim();
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (forceRefresh) params.set('refresh', '1');
  const result = await api(`api/threads${params.size ? `?${params}` : ''}`);
  if (requestId !== state.threadListRequest) return;
  state.threads = result.data || [];
  const statusText = result.partial
    ? `已显示最近 ${state.threads.length} 个，正在后台加载全部…`
    : result.refreshing
      ? '已显示缓存，正在后台更新…'
      : '';
  elements.threadListStatus.textContent = statusText;
  elements.threadListStatus.classList.toggle('hidden', !statusText);
  renderThreads();
}

function renderThreads() {
  elements.threadList.replaceChildren();
  for (const thread of state.threads) {
    const button = document.createElement('button');
    button.className = `thread${state.activeThread?.id === thread.id ? ' active' : ''}`;
    const name = document.createElement('div');
    name.className = 'thread-name';
    const title = document.createElement('span');
    title.className = 'thread-name-text';
    title.textContent = `${thread.isPinned ? '★ ' : ''}${thread.name || thread.preview || '未命名 task'}`;
    name.append(title);
    const badge = activityBadge(thread.activityState);
    if (badge) name.append(badge);
    const preview = document.createElement('div');
    preview.className = 'thread-preview';
    preview.textContent = thread.preview || (thread.activityState === 'empty' ? '尚无消息' : '');
    const time = document.createElement('div');
    time.className = 'thread-time';
    time.textContent = formatTime(thread.updatedAt || thread.createdAt);
    button.append(name, preview, time);
    button.addEventListener('click', () => openThread(thread.id));
    elements.threadList.append(button);
  }
}

function activityBadge(activityState) {
  const labels = { running: '运行中', unseen: '未查看', empty: '无消息' };
  if (!labels[activityState]) return null;
  const badge = document.createElement('span');
  badge.className = `activity-badge ${activityState}`;
  badge.textContent = labels[activityState];
  return badge;
}

function initializeNavigation() {
  if (!history.state?.codexMobileView) {
    history.replaceState({ ...(history.state || {}), codexMobileView: 'list' }, '', location.href);
  }
  window.addEventListener('popstate', (event) => {
    if (event.state?.codexMobileView === 'thread' && event.state.threadId) {
      openThread(event.state.threadId, { fromHistory: true });
    } else {
      showThreadList();
    }
  });
}

function showThreadList({ replaceHistory = false } = {}) {
  state.threadOpenRequest += 1;
  reportViewState(false);
  closeImageViewer();
  state.activeThread = null;
  state.pendingRequests.clear();
  state.streaming.clear();
  state.liveToolGroups.clear();
  state.deferredThreadSnapshot = null;
  resetHistoryPaging();
  clearAttachments({ removeRemote: true });
  document.body.classList.remove('thread-open');
  elements.threadView.classList.add('hidden');
  elements.emptyState.classList.remove('hidden');
  elements.messages.replaceChildren();
  resetConversationScroll();
  elements.approvals.replaceChildren();
  renderThreads();
  syncComposerState();
  if (replaceHistory) {
    history.replaceState({ ...(history.state || {}), codexMobileView: 'list', threadId: null }, '', location.href);
  }
}

async function openThread(threadId, { fromHistory = false } = {}) {
  const requestId = ++state.threadOpenRequest;
  state.deferredThreadSnapshot = null;
  resetHistoryPaging();
  clearAttachments({ removeRemote: true });
  if (!fromHistory) {
    const nextState = { ...(history.state || {}), codexMobileView: 'thread', threadId };
    if (history.state?.codexMobileView === 'thread') history.replaceState(nextState, '', location.href);
    else history.pushState(nextState, '', location.href);
  }
  await reportViewState(false);
  if (requestId !== state.threadOpenRequest) return;
  const summary = state.threads.find((thread) => thread.id === threadId) || { id: threadId };
  state.activeThread = summary;
  document.body.classList.add('thread-open');
  elements.emptyState.classList.add('hidden');
  elements.threadView.classList.remove('hidden');
  elements.threadTitle.textContent = summary.name || summary.preview || '未命名 task';
  elements.threadMeta.textContent = summary.cwd || threadId;
  elements.messages.replaceChildren();
  resetConversationScroll();
  state.liveToolGroups.clear();
  elements.notice.classList.add('hidden');
  elements.retryResume.classList.add('hidden');
  renderThreads();
  addLoading();
  await reportViewState();
  if (requestId !== state.threadOpenRequest) return;
  try {
    const lifecycleGeneration = state.turnLifecycleGeneration;
    const result = await api(`api/threads/${encodeURIComponent(threadId)}/resume`, {
      method: 'POST',
      body: {},
    });
    if (requestId !== state.threadOpenRequest) return;
    if (lifecycleGeneration === state.turnLifecycleGeneration) {
      state.activeTurnId = result.activeTurnId || null;
      state.activeTurnThreadId = state.activeTurnId ? threadId : null;
      state.turnActivityPhase = state.activeTurnId ? 'thinking' : null;
    }
    const preserveLiveState = Boolean(
      (state.activeTurnId && state.activeTurnThreadId === threadId)
      || state.streaming.size
      || state.liveToolGroups.size
      || hasPreservableLiveMessageNodes()
    );
    if (preserveLiveState) applyDeferredThreadSnapshot(result.thread);
    else {
      state.activeThread = result.thread;
      renderThread(result.thread);
    }
    clearStaleThreadNotFoundNotice();
    syncComposerState();
    await reportViewState();
    if (requestId !== state.threadOpenRequest) return;
    await loadApprovals();
    if (requestId !== state.threadOpenRequest) return;
    await loadThreads();
  } catch (error) {
    if (requestId !== state.threadOpenRequest) return;
    await reportViewState(false);
    elements.messages.replaceChildren();
    showNotice(error.message);
    if (error.code === 'ACTIVE_WRITER') elements.retryResume.classList.remove('hidden');
  }
}

function renderThread(thread, { preserveLiveState = false } = {}) {
  if (!preserveLiveState) {
    state.streaming.clear();
    state.liveToolGroups.clear();
  }
  elements.threadTitle.textContent = thread.name || thread.preview || '未命名 task';
  elements.threadMeta.textContent = thread.cwd || thread.id;
  resetHistoryPaging();
  elements.messages.replaceChildren();
  if (thread.historyLoading) {
    const note = document.createElement('div');
    note.className = 'history-note loading';
    note.textContent = '会话已打开，正在后台加载最近记录…';
    elements.messages.append(note);
  }
  if (thread.historyError) {
    const note = document.createElement('div');
    note.className = 'history-note error-note';
    note.append(document.createTextNode('最近记录加载失败。'));
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'secondary history-retry';
    retry.textContent = '重试';
    retry.addEventListener('click', () => openThread(thread.id, { fromHistory: true }));
    note.append(retry);
    elements.messages.append(note);
  }
  if (thread.desktopWriter) {
    const note = document.createElement('div');
    note.className = 'history-note desktop-writer-note';
    note.textContent = '桌面正在使用此 task；当前网页可跟随查看，发送需桌面先切换到其他 task。';
    elements.messages.append(note);
  }
  if (thread.hasOlderTurns && thread.olderTurnsCursor && !thread.historyLoading) {
    initializeHistoryPaging(thread);
  } else if (thread.hasOlderTurns && !thread.historyLoading) {
    const note = document.createElement('div');
    note.className = 'history-note';
    note.textContent = '为加快加载，仅显示最近 24 轮；更早记录未加载。';
    elements.messages.append(note);
  }
  if (thread.omittedTurnCount > 0) {
    const note = document.createElement('div');
    note.className = 'history-note';
    note.textContent = `为加快加载，仅显示最近 24 轮；已省略更早的 ${thread.omittedTurnCount} 轮。`;
    elements.messages.append(note);
  }
  for (const turn of thread.turns || []) renderTurn(turn);
  scrollBottom({ force: !preserveLiveState });
}

function renderTurn(turn, target = elements.messages) {
  const block = document.createElement('section');
  block.className = 'turn-block';
  if (turn?.id) block.dataset.turnId = turn.id;
  for (const item of turn?.items || []) addMessage(item, { target: block, autoScroll: false });
  if (turn?.error) {
    const error = document.createElement('div');
    error.className = 'turn-error';
    error.textContent = String(turn.error);
    block.append(error);
  }
  target.append(block);
  return block;
}

function initializeHistoryPaging(thread) {
  const node = document.createElement('div');
  node.className = 'history-pager history-note';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'secondary history-load-older';
  button.textContent = '加载更早记录';
  node.append(button);
  elements.messages.append(node);
  state.historyPager = {
    threadId: thread.id,
    cursor: thread.olderTurnsCursor,
    loading: false,
    node,
    button,
    turnIds: new Set((thread.turns || []).map((turn) => String(turn?.id || '')).filter(Boolean)),
  };
  button.addEventListener('click', loadOlderTurns);
  if (typeof IntersectionObserver === 'function') {
    state.historyObserver = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadOlderTurns();
    }, { root: elements.messages, rootMargin: '240px 0px 0px', threshold: 0 });
    state.historyObserver.observe(node);
  }
}

function resetHistoryPaging() {
  state.historyObserver?.disconnect();
  state.historyObserver = null;
  state.historyPager = null;
}

async function loadOlderTurns() {
  const pager = state.historyPager;
  if (!pager || pager.loading || !pager.cursor || state.activeThread?.id !== pager.threadId) return;
  pager.loading = true;
  pager.button.disabled = true;
  pager.button.textContent = '正在加载更早记录…';
  const previousHeight = elements.messages.scrollHeight;
  const previousTop = elements.messages.scrollTop;
  try {
    const params = new URLSearchParams({ cursor: pager.cursor, limit: '12' });
    const result = await api(`api/threads/${encodeURIComponent(pager.threadId)}/turns?${params}`);
    if (state.historyPager !== pager || state.activeThread?.id !== pager.threadId) return;
    const turns = (result.turns || []).filter((turn) => {
      const turnId = String(turn?.id || '');
      if (!turnId || pager.turnIds.has(turnId)) return false;
      pager.turnIds.add(turnId);
      return true;
    });
    const holder = document.createElement('div');
    for (const turn of turns) renderTurn(turn, holder);
    while (holder.lastElementChild) pager.node.after(holder.lastElementChild);
    if (state.activeThread) state.activeThread.turns = [...turns, ...(state.activeThread.turns || [])];
    pager.cursor = result.olderTurnsCursor || null;
    if (!pager.cursor || !result.hasOlderTurns) {
      state.historyObserver?.disconnect();
      state.historyObserver = null;
      pager.button.textContent = '已加载到最早记录';
      pager.button.disabled = true;
    } else {
      pager.button.textContent = '加载更早记录';
      pager.button.disabled = false;
    }
    requestAnimationFrame(() => {
      elements.messages.scrollTop = previousTop + Math.max(0, elements.messages.scrollHeight - previousHeight);
    });
  } catch (error) {
    if (state.historyPager !== pager) return;
    pager.button.textContent = '加载失败，点此重试';
    pager.button.disabled = false;
    showNotice(error.message);
  } finally {
    if (state.historyPager === pager) pager.loading = false;
  }
}

function addMessage(item, { streaming = false, pending = false, target = elements.messages, autoScroll = true } = {}) {
  if (!item) return null;
  const div = document.createElement('div');
  const role = item.type === 'userMessage' ? 'user' :
    item.type === 'agentMessage' || item.type === 'imageMessage' ? 'agent' :
      item.type === 'plan' ? 'plan' : 'tool';
  div.className = `message ${role}${streaming ? ' streaming' : ''}${pending ? ' pending' : ''}`;
  if (item.id) div.dataset.itemId = item.id;
  if (item.type === 'toolGroup') {
    div._toolItemIds = new Set((item.toolItems || []).map((tool) => String(tool.id || '')).filter(Boolean));
    div._toolRunningItemIds = new Set((item.toolItems || [])
      .filter((tool) => /progress|running|started/i.test(String(tool.status || '')))
      .map((tool) => String(tool.id || ''))
      .filter(Boolean));
    div._toolItemsComplete = item.toolItemsComplete !== false;
  }
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = role === 'user' ? '你' : role === 'agent' ? 'Codex' : item.type;
  const content = document.createElement('div');
  content.className = 'content';
  if (role === 'tool') {
    renderToolMessage(div, item);
  } else {
    if (role === 'agent' || role === 'plan') {
      div._rawText = String(item.text || '');
      content.classList.add('markdown');
      renderMarkdown(content, item.text || '');
    } else {
      content.textContent = item.text || '';
    }
    renderMessageImages(content, item.images || []);
    renderArtifacts(content, item.artifacts || []);
    div.append(label, content);
  }
  target.append(div);
  if (autoScroll) scrollBottom();
  return div;
}

function renderMessageImages(container, images) {
  if (!Array.isArray(images) || images.length === 0) return;
  const gallery = document.createElement('div');
  gallery.className = `message-images${images.length === 1 ? ' single' : ''}`;
  for (const image of images) {
    if (!image?.url) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'message-image-button';
    button.setAttribute('aria-label', `查看图片 ${image.name || ''}`.trim());
    const preview = document.createElement('img');
    preview.src = image.url;
    preview.alt = image.name || '图片';
    preview.loading = 'lazy';
    preview.decoding = 'async';
    preview.referrerPolicy = 'no-referrer';
    preview.addEventListener('load', () => scrollBottom());
    preview.addEventListener('error', () => {
      button.classList.add('failed');
      button.textContent = '图片加载失败';
    }, { once: true });
    button.append(preview);
    button.addEventListener('click', () => openImageViewer(image));
    gallery.append(button);
  }
  if (gallery.childElementCount > 0) container.append(gallery);
}

function renderArtifacts(container, artifacts) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) return;
  const list = document.createElement('div');
  list.className = 'message-artifacts';
  for (const artifact of artifacts) {
    if (!artifact?.downloadUrl || !artifact?.name) continue;
    const card = document.createElement('div');
    card.className = 'artifact-card';
    const badge = document.createElement('span');
    badge.className = 'artifact-type';
    badge.textContent = String(artifact.extension || 'FILE').slice(0, 8);
    const info = document.createElement('div');
    info.className = 'artifact-info';
    const name = document.createElement('strong');
    name.textContent = artifact.name;
    const meta = document.createElement('span');
    meta.textContent = formatBytes(artifact.size);
    info.append(name, meta);
    const actions = document.createElement('div');
    actions.className = 'artifact-actions';
    if (artifact.previewable && artifact.previewUrl) {
      if (String(artifact.mimeType || '').startsWith('image/')) {
        const preview = document.createElement('button');
        preview.type = 'button';
        preview.className = 'artifact-action';
        preview.textContent = '预览';
        preview.addEventListener('click', () => openImageViewer({ url: artifact.previewUrl, name: artifact.name }));
        actions.append(preview);
      } else {
        const preview = document.createElement('a');
        preview.className = 'artifact-action';
        preview.href = artifact.previewUrl;
        preview.target = '_blank';
        preview.rel = 'noopener noreferrer';
        preview.textContent = '预览';
        actions.append(preview);
      }
    }
    const download = document.createElement('a');
    download.className = 'artifact-action primary-link';
    download.href = artifact.downloadUrl;
    download.download = artifact.name;
    download.textContent = '下载';
    actions.append(download);
    card.append(badge, info, actions);
    list.append(card);
  }
  if (list.childElementCount > 0) container.append(list);
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(bytes < 10 * 1_024 * 1_024 ? 1 : 0)} MB`;
}

function addSelectedAttachments(files) {
  const available = Math.max(0, 4 - state.attachments.length);
  const selected = files.slice(0, available);
  if (files.length > available) showNotice('每条消息最多添加 4 个附件');
  for (const file of selected) {
    if (file.size <= 0 || file.size > 25 * 1_024 * 1_024) {
      showNotice(`${file.name} 为空或超过 25 MB`);
      continue;
    }
    const attachment = {
      localId: `attachment-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      file,
      name: file.name,
      size: file.size,
      mimeType: file.type || 'application/octet-stream',
      status: 'queued',
      progress: 0,
      error: '',
      xhr: null,
      previewUrl: String(file.type || '').startsWith('image/') ? URL.createObjectURL(file) : null,
    };
    state.attachments.push(attachment);
    state.uploadQueue = state.uploadQueue
      .then(() => uploadAttachment(attachment))
      .catch(() => {});
  }
  renderPendingAttachments();
  syncComposerState();
}

function handleClipboardPaste(event) {
  if (!state.activeThread) return false;
  const images = clipboardImageFiles(event);
  if (images.length === 0) return false;
  event.preventDefault();
  const text = String(event.clipboardData?.getData?.('text/plain') || '');
  if (text) insertPromptText(text);
  showNotice('正在读取剪贴板图片…');
  prepareClipboardImages(images).then((prepared) => {
    const available = Math.max(0, 4 - state.attachments.length);
    addSelectedAttachments(prepared);
    if (available > 0) showNotice(`已从剪贴板添加 ${Math.min(available, prepared.length)} 张图片`);
  }).catch((error) => showNotice(`读取剪贴板图片失败：${error.message}`));
  return true;
}

function clipboardImageFiles(event) {
  const result = [];
  const seen = new Set();
  const add = (file) => {
    if (!file || !String(file.type || '').startsWith('image/')) return;
    const fingerprint = [file.type, file.size, file.lastModified || 0].join(':');
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);
    result.push(file);
  };
  for (const item of event?.clipboardData?.items || []) {
    if (item?.kind !== 'file' || !String(item.type || '').startsWith('image/')) continue;
    add(item.getAsFile?.());
  }
  for (const file of event?.clipboardData?.files || []) {
    add(file);
  }
  return result;
}

async function prepareClipboardImages(images) {
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '').replace('T', '-');
  const unique = [];
  const contentFingerprints = new Set();
  for (const file of images) {
    const prepared = await prepareClipboardImage(file, `剪贴板-${timestamp}-临时`);
    const fingerprint = await fileContentFingerprint(prepared);
    if (contentFingerprints.has(fingerprint)) continue;
    contentFingerprints.add(fingerprint);
    unique.push(prepared);
  }
  return unique.map((file, index) => {
    const suffix = unique.length > 1 ? `-${index + 1}` : '';
    const extension = clipboardImageExtension(file.type);
    return new File([file], `剪贴板-${timestamp}${suffix}.${extension}`, {
      type: file.type || `image/${extension}`,
      lastModified: Date.now(),
    });
  });
}

async function fileContentFingerprint(file) {
  const bytes = new Uint8Array(await promiseWithTimeout(file.arrayBuffer(), 20_000, '读取图片超时'));
  if (globalThis.crypto?.subtle) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
  }
  let hash = 2166136261;
  for (const value of bytes) hash = Math.imul(hash ^ value, 16777619);
  return `${bytes.length}:${(hash >>> 0).toString(16)}`;
}

async function prepareClipboardImage(file, baseName) {
  const bytes = await promiseWithTimeout(file.arrayBuffer(), 20_000, '读取图片超时');
  const sourceType = file.type || 'image/png';
  const source = new Blob([bytes], { type: sourceType });
  if (bytes.byteLength > 1024 * 1024 && typeof createImageBitmap === 'function') {
    try {
      const bitmap = await promiseWithTimeout(createImageBitmap(source), 20_000, '解析图片超时');
      const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close?.();
      const compressed = await promiseWithTimeout(new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.86)), 20_000, '压缩图片超时');
      if (compressed && compressed.size > 0 && compressed.size < bytes.byteLength) {
        return new File([compressed], `${baseName}.webp`, { type: 'image/webp', lastModified: Date.now() });
      }
    } catch {}
  }
  const extension = clipboardImageExtension(sourceType);
  return new File([bytes], `${baseName}.${extension}`, { type: sourceType, lastModified: Date.now() });
}

function promiseWithTimeout(promise, milliseconds, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function clipboardImageExtension(mimeType) {
  const extensions = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/avif': 'avif',
  };
  return extensions[String(mimeType || '').toLowerCase()] || 'png';
}

function insertPromptText(text) {
  const start = Number(elements.prompt.selectionStart ?? elements.prompt.value.length);
  const end = Number(elements.prompt.selectionEnd ?? start);
  if (typeof elements.prompt.setRangeText === 'function') {
    elements.prompt.setRangeText(text, start, end, 'end');
  } else {
    elements.prompt.value = `${elements.prompt.value.slice(0, start)}${text}${elements.prompt.value.slice(end)}`;
  }
  resizeComposer();
}

async function uploadAttachment(attachment) {
  const threadId = state.activeThread?.id;
  if (!threadId || !state.attachments.includes(attachment)) return;
  attachment.status = 'uploading';
  attachment.progress = 0;
  renderPendingAttachments();
  syncComposerState();
  try {
    const result = await uploadAttachmentWithProgress(threadId, attachment);
    if (!state.attachments.includes(attachment) || state.activeThread?.id !== threadId) {
      if (result.attachment?.id) api(`api/uploads/${encodeURIComponent(result.attachment.id)}`, { method: 'DELETE' }).catch(() => {});
      return;
    }
    Object.assign(attachment, result.attachment, { status: 'ready', progress: 100, error: '', xhr: null });
  } catch (error) {
    if (error.name === 'AbortError' || !state.attachments.includes(attachment)) return;
    attachment.status = 'failed';
    attachment.xhr = null;
    attachment.error = error.message;
    showNotice(`附件上传失败：${error.message}`);
  } finally {
    renderPendingAttachments();
    syncComposerState();
  }
}

function uploadAttachmentWithProgress(threadId, attachment) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    attachment.xhr = xhr;
    xhr.open('POST', `api/threads/${encodeURIComponent(threadId)}/uploads`);
    xhr.withCredentials = true;
    xhr.timeout = 5 * 60 * 1000;
    xhr.setRequestHeader('Content-Type', attachment.mimeType);
    xhr.setRequestHeader('X-Codex-File-Name', encodeURIComponent(attachment.name));
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || !state.attachments.includes(attachment)) return;
      const progress = Math.min(99, Math.round((event.loaded / event.total) * 100));
      if (progress === attachment.progress) return;
      attachment.progress = progress;
      renderPendingAttachments();
    };
    xhr.onload = () => {
      let result = {};
      try { result = JSON.parse(xhr.responseText || '{}'); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) return resolve(result);
      if (xhr.status === 413) return reject(new Error('图片超过上传大小限制'));
      reject(new Error(result.error || `HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('网络中断，请重试'));
    xhr.ontimeout = () => reject(new Error('上传超时，请重试'));
    xhr.onabort = () => {
      const error = new Error('上传已取消');
      error.name = 'AbortError';
      reject(error);
    };
    xhr.send(attachment.file);
  });
}

function renderPendingAttachments() {
  elements.attachments.replaceChildren();
  for (const attachment of state.attachments) {
    const chip = document.createElement('div');
    chip.className = `attachment-chip ${attachment.status}`;
    const preview = document.createElement('span');
    preview.className = 'attachment-preview';
    if (attachment.previewUrl) {
      const image = document.createElement('img');
      image.src = attachment.previewUrl;
      image.alt = '';
      preview.append(image);
    } else {
      preview.textContent = String(attachment.name.split('.').pop() || 'FILE').slice(0, 5).toUpperCase();
    }
    const info = document.createElement('div');
    info.className = 'attachment-info';
    const name = document.createElement('strong');
    name.textContent = attachment.name;
    const meta = document.createElement('span');
    meta.textContent = attachment.status === 'queued'
      ? `等待上传 · ${formatBytes(attachment.size)}`
      : attachment.status === 'uploading'
      ? `上传 ${attachment.progress || 0}% · ${formatBytes(attachment.size)}`
      : attachment.status === 'failed'
        ? `失败 · ${attachment.error || '请重试'}`
        : `已就绪 · ${formatBytes(attachment.size)}`;
    info.append(name, meta);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'attachment-remove';
    remove.setAttribute('aria-label', `移除 ${attachment.name}`);
    remove.textContent = '×';
    remove.addEventListener('click', () => removeAttachment(attachment));
    chip.append(preview, info, remove);
    elements.attachments.append(chip);
  }
  elements.attachments.classList.toggle('hidden', state.attachments.length === 0);
}

function removeAttachment(attachment) {
  attachment.xhr?.abort();
  state.attachments = state.attachments.filter((candidate) => candidate !== attachment);
  if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
  if (attachment.id && attachment.status === 'ready') {
    api(`api/uploads/${encodeURIComponent(attachment.id)}`, { method: 'DELETE' }).catch(() => {});
  }
  renderPendingAttachments();
  syncComposerState();
}

function clearAttachments({ removeRemote = false } = {}) {
  const attachments = state.attachments;
  state.attachments = [];
  for (const attachment of attachments) {
    attachment.xhr?.abort();
    if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    if (removeRemote && attachment.id && attachment.status === 'ready') {
      api(`api/uploads/${encodeURIComponent(attachment.id)}`, { method: 'DELETE' }).catch(() => {});
    }
  }
  renderPendingAttachments();
}

function openImageViewer(image) {
  elements.imageViewerImage.classList.remove('zoomed');
  elements.imageViewerImage.src = image.url;
  elements.imageViewerImage.alt = image.name || '图片';
  elements.imageViewerCaption.textContent = image.name || '';
  elements.imageViewer.classList.remove('hidden');
  elements.imageViewerClose.focus();
}

function closeImageViewer() {
  elements.imageViewer.classList.add('hidden');
  elements.imageViewerImage.classList.remove('zoomed');
  elements.imageViewerImage.removeAttribute('src');
  elements.imageViewerCaption.textContent = '';
}

function renderMarkdown(container, source, depth = 0) {
  const text = decodeCharacterReferences(source).replace(/\r\n?/g, '\n');
  if (depth >= 16 || text.length > 64_000) {
    container.textContent = text;
    return;
  }
  const lines = text.split('\n');
  container.replaceChildren();
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^\s*```([^`]*)$/);
    if (fence) {
      const codeLines = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      if (fence[1].trim()) code.dataset.language = fence[1].trim().slice(0, 40);
      code.textContent = codeLines.join('\n');
      pre.append(code);
      container.append(pre);
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
    if (heading) {
      const node = document.createElement(`h${Math.min(heading[1].length + 1, 6)}`);
      appendInlineMarkdown(node, heading[2]);
      container.append(node);
      index += 1;
      continue;
    }

    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      container.append(document.createElement('hr'));
      index += 1;
      continue;
    }

    if (isTableStart(lines, index)) {
      const wrapper = document.createElement('div');
      wrapper.className = 'markdown-table-wrap';
      const table = document.createElement('table');
      const head = document.createElement('thead');
      const headRow = document.createElement('tr');
      for (const cell of splitTableRow(lines[index])) {
        const th = document.createElement('th');
        appendInlineMarkdown(th, cell);
        headRow.append(th);
      }
      head.append(headRow);
      table.append(head);
      index += 2;
      const body = document.createElement('tbody');
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        const row = document.createElement('tr');
        for (const cell of splitTableRow(lines[index])) {
          const td = document.createElement('td');
          appendInlineMarkdown(td, cell);
          row.append(td);
        }
        body.append(row);
        index += 1;
      }
      table.append(body);
      wrapper.append(table);
      container.append(wrapper);
      continue;
    }

    const listMatch = line.match(/^\s{0,3}([-+*]|\d+[.)])\s+(.+)$/);
    if (listMatch) {
      const ordered = /^\d/.test(listMatch[1]);
      const list = document.createElement(ordered ? 'ol' : 'ul');
      if (ordered) list.start = Number.parseInt(listMatch[1], 10) || 1;
      while (index < lines.length) {
        const item = lines[index].match(/^\s{0,3}([-+*]|\d+[.)])\s+(.+)$/);
        if (!item || /^\d/.test(item[1]) !== ordered) break;
        const li = document.createElement('li');
        appendInlineMarkdown(li, item[2]);
        index += 1;
        while (index < lines.length && /^\s{2,}\S/.test(lines[index]) && !/^\s{0,3}([-+*]|\d+[.)])\s+/.test(lines[index])) {
          li.append(document.createElement('br'));
          appendInlineMarkdown(li, lines[index].trim());
          index += 1;
        }
        list.append(li);
      }
      container.append(list);
      continue;
    }

    if (/^\s{0,3}>/.test(line)) {
      const quoteLines = [];
      while (index < lines.length && /^\s{0,3}>/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s{0,3}>\s?/, ''));
        index += 1;
      }
      const quote = document.createElement('blockquote');
      renderMarkdown(quote, quoteLines.join('\n'), depth + 1);
      container.append(quote);
      continue;
    }

    const paragraphLines = [];
    while (index < lines.length && lines[index].trim() && !isMarkdownBlockStart(lines, index)) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    if (paragraphLines.length === 0) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    const paragraph = document.createElement('p');
    paragraphLines.forEach((value, lineIndex) => {
      if (lineIndex > 0) paragraph.append(document.createElement('br'));
      appendInlineMarkdown(paragraph, value);
    });
    container.append(paragraph);
  }
}

function isMarkdownBlockStart(lines, index) {
  const line = lines[index] || '';
  return /^\s*```/.test(line)
    || /^\s{0,3}#{1,6}\s+/.test(line)
    || /^\s{0,3}([-+*]|\d+[.)])\s+/.test(line)
    || /^\s{0,3}>/.test(line)
    || /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)
    || isTableStart(lines, index);
}

function isTableStart(lines, index) {
  if (!lines[index]?.includes('|') || !lines[index + 1]?.includes('|')) return false;
  const separators = splitTableRow(lines[index + 1]);
  return separators.length > 0 && separators.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function splitTableRow(line) {
  return String(line).trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

function appendInlineMarkdown(parent, source, depth = 0) {
  const text = String(source || '');
  if (depth >= 16) {
    parent.append(document.createTextNode(text));
    return;
  }
  const token = /`([^`\n]+)`|\*\*([^\n]+?)\*\*|__([^\n]+?)__|~~([^\n]+?)~~|\[([^\]\n]+)\]\((?:<([^>\n]+)>|([^\s)]+))\)|\*([^*\n]+?)\*|:{1,2}codex-file-citation\{((?:[^}"\n]|"[^"\n]*")*)\}/g;
  let cursor = 0;
  for (let match = token.exec(text); match; match = token.exec(text)) {
    if (match.index > cursor) parent.append(document.createTextNode(text.slice(cursor, match.index)));
    if (match[1] != null) {
      const code = document.createElement('code');
      code.textContent = match[1];
      parent.append(code);
    } else if (match[5] != null) {
      const target = match[6] || match[7] || '';
      const safeUrl = safeExternalUrl(target);
      const link = document.createElement(safeUrl ? 'a' : 'span');
      if (safeUrl) {
        link.href = safeUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      } else {
        link.className = 'local-reference';
        link.title = target;
      }
      appendInlineMarkdown(link, match[5], depth + 1);
      parent.append(link);
    } else if (match[9] != null) {
      appendFileCitation(parent, match[9]);
    } else {
      const value = match[2] ?? match[3] ?? match[4] ?? match[8] ?? '';
      const tag = match[2] != null || match[3] != null ? 'strong' : match[4] != null ? 's' : 'em';
      const node = document.createElement(tag);
      appendInlineMarkdown(node, value, depth + 1);
      parent.append(node);
    }
    cursor = token.lastIndex;
  }
  if (cursor < text.length) parent.append(document.createTextNode(text.slice(cursor)));
}

function appendFileCitation(parent, rawAttributes) {
  const attributes = {};
  for (const match of String(rawAttributes).matchAll(/([a-zA-Z][\w-]*)="([^"]*)"/g)) {
    attributes[match[1]] = match[2];
  }
  const fileName = String(attributes.path || '').split(/[\\/]/).filter(Boolean).pop() || '本地文件';
  const extension = fileName.includes('.') ? fileName.split('.').pop().toUpperCase() : '';
  const citation = document.createElement('span');
  citation.className = 'file-citation';
  const badge = document.createElement('span');
  badge.className = 'file-citation-type';
  badge.textContent = /^[A-Z0-9]{1,5}$/.test(extension) ? extension : 'FILE';
  const name = document.createElement('span');
  name.className = 'file-citation-name';
  name.textContent = fileName;
  citation.append(badge, name);
  parent.append(citation);
}

function safeExternalUrl(target) {
  try {
    const url = new URL(target, window.location.href);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function decodeCharacterReferences(source) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(source || '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, entity) => {
    if (entity[0] !== '#') return named[entity.toLowerCase()] ?? whole;
    const hexadecimal = entity[1]?.toLowerCase() === 'x';
    const value = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    return Number.isSafeInteger(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : whole;
  });
}

function renderToolMessage(div, item) {
  const details = document.createElement('details');
  details.className = 'tool-details';
  const summary = document.createElement('summary');
  summary.className = 'tool-summary';

  const icon = document.createElement('span');
  icon.className = 'tool-icon';
  icon.textContent = toolIcon(item.type);
  const text = document.createElement('span');
  text.className = 'tool-summary-text';
  const title = document.createElement('strong');
  title.textContent = toolTitle(item);
  const meta = document.createElement('span');
  meta.className = `tool-status ${toolStatusClass(item.status)}`;
  meta.textContent = toolStatus(item.status);
  text.append(title, meta);
  const chevron = document.createElement('span');
  chevron.className = 'tool-chevron';
  chevron.textContent = item.hasDetails ? '查看' : '';
  summary.append(icon, text, chevron);
  details.append(summary);

  if (item.live) {
    const body = document.createElement('div');
    body.className = 'live-tool-previews';
    details.append(body);
    chevron.textContent = '展开';
    details.addEventListener('toggle', () => {
      chevron.textContent = details.open ? '收起' : '展开';
    });
  } else if (item.hasDetails && item.id) {
    const body = document.createElement('div');
    body.className = 'tool-body';
    body.textContent = '点开后加载详情';
    details.append(body);
    details.addEventListener('toggle', () => {
      chevron.textContent = details.open ? '收起' : '查看';
      if (details.open && !details.dataset.loaded) {
        if (item.type === 'toolGroup') loadToolGroup(details, body, item);
        else loadToolDetails(details, body, item);
      }
    });
  } else {
    details.classList.add('no-details');
    summary.addEventListener('click', (event) => event.preventDefault());
  }
  div.append(details);
}

async function loadToolGroup(details, body, item) {
  details.dataset.loaded = 'loading';
  body.textContent = '正在加载本轮工具活动…';
  try {
    const result = await api(`api/threads/${encodeURIComponent(state.activeThread.id)}/turns/${encodeURIComponent(item.turnId)}/tools`);
    body.replaceChildren();
    if (result.omitted > 0) {
      const note = document.createElement('div');
      note.className = 'tool-group-note';
      note.textContent = `本轮共 ${result.total} 项，仅显示最近 ${result.items.length} 项。`;
      body.append(note);
    }
    for (const tool of result.items || []) appendToolRow(body, tool);
    if (!result.items?.length) body.textContent = '这一轮没有工具活动';
    details.dataset.loaded = 'true';
  } catch (error) {
    body.textContent = `工具列表加载失败：${error.message}`;
    details.dataset.loaded = '';
  }
}

function appendToolRow(body, item) {
  const row = document.createElement('details');
  row.className = 'tool-row';
  const summary = document.createElement('summary');
  const title = document.createElement('span');
  title.textContent = toolTitle(item);
  const status = document.createElement('span');
  status.className = `tool-status ${toolStatusClass(item.status)}`;
  status.textContent = toolStatus(item.status);
  summary.append(title, status);
  row.append(summary);
  if (item.hasDetails && item.id) {
    const detail = document.createElement('div');
    detail.className = 'tool-row-detail';
    detail.textContent = '点开后加载详情';
    row.append(detail);
    row.addEventListener('toggle', () => {
      if (row.open && !row.dataset.loaded) loadToolDetails(row, detail, item);
    });
  } else {
    row.classList.add('no-details');
    summary.addEventListener('click', (event) => event.preventDefault());
  }
  body.append(row);
}

async function loadToolDetails(details, body, item) {
  details.dataset.loaded = 'loading';
  body.textContent = '正在加载详情…';
  try {
    const result = await api(`api/threads/${encodeURIComponent(state.activeThread.id)}/items/${encodeURIComponent(item.id)}`);
    const detail = result.item || {};
    body.replaceChildren();
    if (detail.cwd) appendToolDetail(body, '目录', detail.cwd);
    if (detail.command) appendToolDetail(body, '命令', detail.command);
    if (detail.output) appendToolDetail(body, '输出', detail.output);
    if (!detail.cwd && !detail.command && !detail.output) body.textContent = '没有可显示的详情';
    details.dataset.loaded = 'true';
  } catch (error) {
    body.textContent = `详情加载失败：${error.message}`;
    details.dataset.loaded = '';
  }
}

function appendToolDetail(body, label, value) {
  const heading = document.createElement('span');
  heading.className = 'tool-detail-label';
  heading.textContent = label;
  const pre = document.createElement('pre');
  pre.textContent = value;
  body.append(heading, pre);
}

function toolTitle(item) {
  if (item.type === 'toolGroup') return `${item.count || 0} 项工具活动`;
  if (item.type === 'commandExecution') return '运行本地命令';
  if (item.type === 'fileChange') return '修改文件';
  if (item.type === 'webSearch') return item.text ? `网页搜索 · ${shortText(item.text)}` : '网页搜索';
  if (item.type === 'collabToolCall') return '协作任务';
  if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') return item.text ? `使用工具 · ${shortText(item.text)}` : '使用工具';
  return '工具活动';
}

function toolIcon(type) {
  if (type === 'commandExecution') return '›_';
  if (type === 'fileChange') return '±';
  if (type === 'webSearch') return '⌕';
  return '◇';
}

function toolStatus(status) {
  const normalized = String(status || '').toLowerCase();
  if (!normalized) return '';
  if (normalized.includes('progress') || normalized.includes('running') || normalized.includes('started')) return '进行中';
  if (normalized.includes('fail') || normalized.includes('error') || normalized.includes('declin')) return '失败';
  if (normalized.includes('cancel') || normalized.includes('interrupt')) return '已停止';
  if (normalized.includes('complete') || normalized.includes('success')) return '已完成';
  return status;
}

function toolStatusClass(status) {
  const text = toolStatus(status);
  return text === '失败' ? 'failed' : text === '进行中' ? 'running' : '';
}

function shortText(value, limit = 48) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function addLoading() {
  const node = addMessage({ type: 'agentMessage', text: '正在接管并加载历史…' }, { streaming: true });
  node?.classList.add('takeover-loading');
}

function connectEvents() {
  state.eventSource?.close();
  state.eventSource = new EventSource('events');
  state.eventSource.onopen = () => setOnline(true);
  state.eventSource.onerror = () => setOnline(false);
  state.eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    handleEvent(data);
  };
}

function handleEvent(event) {
  if (event.type === 'threadListUpdated') {
    loadThreads().catch(() => {});
    return;
  }
  if (event.type === 'threadHistoryError') {
    if (state.activeThread?.id === event.threadId) showNotice(`历史加载失败：${event.message}`);
    return;
  }
  if (event.type === 'threadDeleted') {
    handleDeletedThread(event.threadId);
    return;
  }
  if (event.type === 'serverRequest') {
    state.pendingRequests.set(event.request.id, event.request);
    if (state.activeThread?.id === event.request.threadId) {
      state.turnActivityPhase = event.request.availableDecisions?.length
        || event.request.method === 'item/tool/requestUserInput'
        || event.request.method === 'mcpServer/elicitation/request'
        ? 'approval'
        : 'waiting';
      syncComposerState();
    }
    renderApprovals();
    return;
  }
  if (event.type === 'serverRequestsPruned') {
    for (const requestId of event.requestIds || []) state.pendingRequests.delete(String(requestId));
    if (state.activeTurnId && ![...state.pendingRequests.values()].some((request) => request.threadId === state.activeThread?.id)) {
      state.turnActivityPhase = 'thinking';
      syncComposerState();
    }
    renderApprovals();
    return;
  }
  if (event.type === 'threadSnapshot' && state.activeThread?.id === event.thread.id) {
    if (state.activeTurnId && state.activeTurnThreadId === event.thread.id) {
      applyDeferredThreadSnapshot(event.thread);
      return;
    }
    state.deferredThreadSnapshot = null;
    state.activeThread = event.thread;
    renderThread(event.thread);
    clearStaleThreadNotFoundNotice();
    queueThreadRefresh();
    return;
  }
  if (event.type !== 'notification') return;
  const { method, params } = event;
  if (['turn/started', 'turn/completed', 'thread/started', 'thread/deleted', 'thread/status/changed'].includes(method)) queueThreadRefresh();
  const threadId = params.threadId || params.turn?.threadId;
  if (method === 'thread/deleted') {
    handleDeletedThread(threadId);
    return;
  }
  if (method === 'turn/started' && state.activeThread?.id === threadId) {
    state.activeTurnId = params.turn?.id || params.turnId || true;
    state.activeTurnThreadId = threadId || state.activeThread.id;
    state.turnActivityPhase = 'thinking';
    syncComposerState();
  }
  if (method === 'turn/completed' && (!state.activeTurnThreadId || state.activeTurnThreadId === threadId)) {
    state.turnLifecycleGeneration += 1;
    state.activeTurnId = null;
    state.activeTurnThreadId = null;
    state.turnActivityPhase = null;
    syncComposerState();
  }
  if (threadId && state.activeThread?.id !== threadId) return;

  if (method === 'item/agentMessage/delta') {
    state.turnActivityPhase = 'responding';
    syncComposerState();
    const itemId = params.itemId || 'streaming-agent';
    let div = state.streaming.get(itemId);
    if (!div) {
      div = addMessage({ id: itemId, type: 'agentMessage', text: '' }, { streaming: true });
      state.streaming.set(itemId, div);
    }
    const delta = String(params.delta || '');
    if (!Array.isArray(div._liveChunks)) div._liveChunks = [];
    div._liveChunks.push({ sequence: Number(event.sequence || Number.MAX_SAFE_INTEGER), text: delta });
    div._rawText = `${div._rawText || ''}${delta}`;
    div.querySelector('.content').append(document.createTextNode(delta));
    scrollBottom();
  }
  if (method === 'item/started' && params.item && isToolActivity(params.item)) {
    state.turnActivityPhase = 'tool';
    syncComposerState();
    updateLiveToolGroup(params.item, params.turnId || state.activeTurnId || 'active', event.sequence);
  }
  if (method === 'item/mcpToolCall/progress' && params.itemId) {
    updateLiveToolProgress(params.itemId, params.message || '');
  }
  if (method === 'item/completed' && params.item) {
    const item = params.item;
    if (item.type === 'userMessage') {
      const pendingCandidates = messageNodes().filter((node) => node.classList.contains('user') && node.classList.contains('pending'));
      const pending = pendingCandidates.find((node) => node.querySelector('.content')?.textContent === (item.text || ''))
        || pendingCandidates.find((node) => node._awaitingUserCompletion);
      if (pending) {
        pending.classList.remove('pending');
        pending._awaitingUserCompletion = false;
        if (item.id) pending.dataset.itemId = item.id;
        pending._eventSequence = Number(event.sequence || Number.MAX_SAFE_INTEGER);
        return;
      }
    }
    if (isToolActivity(item)) {
      if (/fail|error|declin|cancel/i.test(String(item.status || ''))) {
        const alertId = String(item.id || `${params.turnId || 'turn'}-${event.sequence || Date.now()}`);
        state.toolAlerts.set(alertId, {
          id: alertId,
          threadId,
          title: toolTitle(item),
          preview: shortText(item.preview || item.text || '工具执行失败', 240),
        });
        renderApprovals();
      }
      updateLiveToolGroup(item, params.turnId || state.activeTurnId || 'active', event.sequence);
      if (!hasRunningLiveTools()) {
        state.turnActivityPhase = 'thinking';
        syncComposerState();
      }
      return;
    }
    const existing = item.id ? elements.messages.querySelector(`[data-item-id="${CSS.escape(item.id)}"]`) : null;
    if (existing) existing.remove();
    state.streaming.delete(item.id);
    const completedNode = addMessage(item);
    if (completedNode) completedNode._eventSequence = Number(event.sequence || Number.MAX_SAFE_INTEGER);
  }
  if (method === 'turn/completed') {
    const deferredSnapshot = state.deferredThreadSnapshot;
    state.streaming.clear();
    for (const group of state.liveToolGroups.values()) {
      group.baseStatus = null;
      group.baseRunningItemIds?.clear();
      for (const entry of group.items.values()) {
        if (!/fail|error|declin|cancel|interrupt|complete|success/i.test(String(entry.status || ''))) {
          entry.status = 'completed';
          renderLiveToolStatus(entry);
        }
      }
      updateLiveToolHeader(group);
    }
    state.liveToolGroups.clear();
    if (deferredSnapshot) applyDeferredThreadSnapshot(deferredSnapshot);
    syncComposerState();
  }
  if (method === 'serverRequest/resolved') {
    const requestId = String(params.requestId || '');
    state.pendingRequests.delete(requestId);
    if (state.activeTurnId) {
      state.turnActivityPhase = 'thinking';
      syncComposerState();
    }
    renderApprovals();
  }
  if (method === 'error') {
    const message = params.error?.message || 'Codex 出错';
    if (isThreadNotFoundMessage(message) && state.activeThread && messageNodes().length > 0) {
      clearStaleThreadNotFoundNotice();
      return;
    }
    showNotice(message);
  }
}

function handleDeletedThread(threadId) {
  queueThreadRefresh();
  for (const [alertId, alert] of state.toolAlerts.entries()) {
    if (alert.threadId === threadId) state.toolAlerts.delete(alertId);
  }
  renderApprovals();
  if (!threadId || state.activeThread?.id !== threadId) return;
  state.turnLifecycleGeneration += 1;
  state.activeTurnId = null;
  state.activeTurnThreadId = null;
  state.turnActivityPhase = null;
  showThreadList({ replaceHistory: true });
  syncComposerState();
}

function applyDeferredThreadSnapshot(thread) {
  const previousHistoryItemIds = new Set((state.activeThread?.turns || [])
    .flatMap((turn) => turn.items || [])
    .map((item) => String(item?.id || ''))
    .filter(Boolean));
  const mappedLiveNodes = new Set([
    ...state.streaming.values(),
    ...[...state.liveToolGroups.values()].map((group) => group.node),
  ]);
  const liveNodes = messageNodes().filter((node) => {
    const classes = String(node.className || '').split(/\s+/);
    if (!classes.includes('message')) return false;
    if (classes.includes('takeover-loading')) return false;
    if (mappedLiveNodes.has(node) || classes.includes('pending') || classes.includes('streaming')) return true;
    if (Number(node._eventSequence || 0) > Number(state.activeThread?.eventSequence || 0)) return true;
    const itemId = String(node.dataset.itemId || '');
    return Boolean(itemId && !previousHistoryItemIds.has(itemId));
  });
  state.deferredThreadSnapshot = null;
  state.activeThread = thread;
  renderThread(thread, { preserveLiveState: true });
  for (const node of liveNodes) {
    const itemId = node.dataset.itemId;
    const duplicate = itemId ? elements.messages.querySelector(`[data-item-id="${CSS.escape(itemId)}"]`) : null;
    if (duplicate) {
      if (mappedLiveNodes.has(node) || node.classList.contains('streaming')) {
        mergeLiveNodeIntoSnapshot(node, duplicate, Number(thread.eventSequence || 0));
      } else if (Number(node._eventSequence || 0) > Number(thread.eventSequence || 0)) {
        duplicate.replaceWith(node);
      }
      continue;
    }
    elements.messages.append(node);
  }
  scrollBottom();
  queueThreadRefresh();
}

function hasPreservableLiveMessageNodes() {
  return messageNodes().some((node) => {
    const classes = String(node.className || '').split(/\s+/);
    return classes.includes('message')
      && !classes.includes('takeover-loading')
      && Boolean(node.dataset.itemId || classes.includes('pending') || classes.includes('streaming'));
  });
}

function messageNodes() {
  const result = [];
  const visit = (node) => {
    for (const child of node?.children || []) {
      if (String(child.className || '').split(/\s+/).includes('message')) result.push(child);
      visit(child);
    }
  };
  visit(elements.messages);
  return result;
}

function mergeLiveNodeIntoSnapshot(liveNode, snapshotNode, snapshotSequence) {
  const liveToolGroup = [...state.liveToolGroups.values()].find((group) => group.node === liveNode);
  if (liveToolGroup) {
    adoptLiveToolGroupSnapshot(liveToolGroup, snapshotNode, snapshotSequence);
    return;
  }
  const snapshotText = String(snapshotNode._rawText ?? snapshotNode.querySelector('.content')?.textContent ?? '');
  const remainingChunks = (liveNode._liveChunks || [])
    .filter((chunk) => Number(chunk.sequence) > snapshotSequence);
  const mergedText = `${snapshotText}${remainingChunks.map((chunk) => chunk.text).join('')}`;
  const content = snapshotNode.querySelector('.content');
  if (content) content.replaceChildren(document.createTextNode(mergedText));
  snapshotNode._rawText = mergedText;
  snapshotNode._liveChunks = remainingChunks;
  if (liveNode.classList.contains('streaming')) snapshotNode.classList.add('streaming');
  for (const [itemId, node] of state.streaming.entries()) {
    if (node === liveNode) state.streaming.set(itemId, snapshotNode);
  }
}

function adoptLiveToolGroupSnapshot(group, snapshotNode, snapshotSequence) {
  const details = snapshotNode.querySelector('.tool-details');
  if (group.body && details) details.append(group.body);
  group.node = snapshotNode;
  group.baseStatus = readToolGroupStatus(snapshotNode);
  group.baseItemIds = new Set(snapshotNode._toolItemIds || []);
  group.baseRunningItemIds = new Set(snapshotNode._toolRunningItemIds || []);
  group.baseIdentityComplete = snapshotNode._toolItemsComplete !== false;
  group.snapshotSequence = snapshotSequence;
  for (const entry of group.items.values()) {
    entry.includedInBase = isLiveToolEntryIncludedInBase(group, entry);
  }
  const includedEntries = [...group.items.values()].filter((entry) => entry.includedInBase);
  const includedCount = includedEntries.length;
  group.baseCount = Math.max(readToolGroupCount(snapshotNode), Number(group.baseCount || 0), includedCount);
  reconcileLiveToolBaseStatus(group);
  updateLiveToolHeader(group);
}

function reconcileLiveToolBaseStatus(group) {
  if (!group.baseItemIds?.size) return;
  for (const entry of group.items.values()) {
    if (!group.baseItemIds.has(entry.itemId)) continue;
    if (/progress|running|started/i.test(String(entry.status || ''))) group.baseRunningItemIds.add(entry.itemId);
    else group.baseRunningItemIds.delete(entry.itemId);
  }
  if (group.baseStatus !== 'failed') {
    if (group.baseRunningItemIds.size > 0) group.baseStatus = 'running';
    else if (group.baseIdentityComplete) group.baseStatus = null;
  }
}

function isLiveToolEntryIncludedInBase(group, entry) {
  if (group.baseItemIds?.has(entry.itemId)) return true;
  if (group.baseIdentityComplete !== false) return false;
  return Boolean(entry.firstObservedTerminal);
}

function readToolGroupCount(node) {
  const value = node.querySelector('.tool-summary-text strong')?.textContent || '';
  const match = value.match(/(\d+)\s*项工具活动/);
  return match ? Number(match[1]) : 0;
}

function readToolGroupStatus(node) {
  const value = node.querySelector('.tool-status')?.textContent || '';
  if (value === '失败') return 'failed';
  if (value === '进行中') return 'running';
  if (value === '已完成') return 'completed';
  return null;
}

function queueThreadRefresh() {
  clearTimeout(state.threadRefreshTimer);
  state.threadRefreshTimer = setTimeout(() => {
    loadThreads().catch(() => {});
  }, 700);
}

function getViewerId() {
  try { return crypto.randomUUID(); } catch {}
  return `viewer_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function isCurrentThreadVisible() {
  return Boolean(state.activeThread && !document.hidden && document.body.classList.contains('thread-open'));
}

async function reportViewState(forceVisible = null) {
  const visible = forceVisible == null ? isCurrentThreadVisible() : Boolean(forceVisible);
  const sequence = ++state.viewSequence;
  try {
    await api('api/view-state', {
      method: 'POST',
      body: {
        viewerId: state.viewerId,
        threadId: visible ? state.activeThread?.id || null : null,
        visible,
        sequence,
      },
    });
  } catch {}
}

function sendViewState(visible) {
  try {
    const sequence = ++state.viewSequence;
    const body = JSON.stringify({
      viewerId: state.viewerId,
      threadId: visible ? state.activeThread?.id || null : null,
      visible: Boolean(visible),
      sequence,
    });
    navigator.sendBeacon('api/view-state', new Blob([body], { type: 'application/json' }));
  } catch {}
}

function isToolActivity(item) {
  return ['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'collabToolCall', 'dynamicToolCall'].includes(item?.type);
}

function updateLiveToolGroup(item, turnId, sequence = Number.MAX_SAFE_INTEGER) {
  const key = String(turnId || 'active');
  const eventSequence = Number(sequence || Number.MAX_SAFE_INTEGER);
  let group = state.liveToolGroups.get(key);
  if (!group) {
    const canonicalId = `tool-group-${key}`;
    let node = elements.messages.querySelector(`[data-item-id="${CSS.escape(canonicalId)}"]`);
    const adoptedSnapshot = Boolean(node);
    let body;
    let baseCount = 0;
    let baseStatus = null;
    let baseItemIds = new Set();
    let baseRunningItemIds = new Set();
    let baseIdentityComplete = true;
    if (node) {
      const details = node.querySelector('.tool-details');
      body = details.querySelector('.live-tool-previews');
      if (!body) {
        body = document.createElement('div');
        body.className = 'live-tool-previews';
        details.append(body);
      }
      baseCount = readToolGroupCount(node);
      baseStatus = readToolGroupStatus(node);
      baseItemIds = new Set(node._toolItemIds || []);
      baseRunningItemIds = new Set(node._toolRunningItemIds || []);
      baseIdentityComplete = node._toolItemsComplete !== false;
    } else {
      node = addMessage({
        id: canonicalId,
        type: 'toolGroup',
        count: 0,
        status: 'inProgress',
        hasDetails: false,
        live: true,
      });
      const details = node.querySelector('.tool-details');
      body = details.querySelector('.live-tool-previews');
    }
    group = {
      node,
      body,
      items: new Map(),
      baseCount,
      baseStatus,
      baseItemIds,
      baseRunningItemIds,
      baseIdentityComplete,
      snapshotSequence: adoptedSnapshot ? Number(state.activeThread?.eventSequence || 0) : 0,
    };
    state.liveToolGroups.set(key, group);
  }

  const itemKey = String(item.id || `${item.type}-${group.items.size + 1}`);
  let entry = group.items.get(itemKey);
  if (!entry) {
    const row = document.createElement('div');
    row.className = 'live-tool-preview';
    const icon = document.createElement('span');
    icon.className = 'live-tool-preview-icon';
    icon.textContent = toolIcon(item.type);
    const main = document.createElement('div');
    main.className = 'live-tool-preview-main';
    const title = document.createElement('strong');
    title.textContent = toolTitle({ ...item, text: '' });
    const detail = document.createElement('span');
    detail.className = 'live-tool-preview-detail';
    main.append(title, detail);
    const status = document.createElement('span');
    row.append(icon, main, status);
    group.body.append(row);
    entry = {
      row,
      detail,
      statusNode: status,
      status: item.status || 'inProgress',
      preview: '',
      itemId: itemKey,
      firstObservedTerminal: !/progress|running|started/i.test(String(item.status || '')),
      firstSequence: eventSequence,
      lastSequence: eventSequence,
      includedInBase: false,
    };
    entry.includedInBase = isLiveToolEntryIncludedInBase(group, entry);
    group.items.set(itemKey, entry);
  }
  entry.lastSequence = Math.max(Number(entry.lastSequence || 0), eventSequence);
  entry.includedInBase = isLiveToolEntryIncludedInBase(group, entry);
  entry.status = item.status || entry.status || 'inProgress';
  entry.preview = shortText(item.preview || item.text || entry.preview || '正在执行…', 180);
  entry.detail.textContent = entry.preview;
  renderLiveToolStatus(entry);
  reconcileLiveToolBaseStatus(group);
  updateLiveToolHeader(group);
  scrollBottom();
}

function updateLiveToolProgress(itemId, message) {
  for (const group of state.liveToolGroups.values()) {
    const entry = group.items.get(String(itemId));
    if (!entry) continue;
    const progress = shortText(message, 180);
    entry.detail.textContent = progress || entry.preview;
    return;
  }
}

function renderLiveToolStatus(entry) {
  entry.statusNode.className = `tool-status ${toolStatusClass(entry.status)}`;
  entry.statusNode.textContent = toolStatus(entry.status) || '进行中';
}

function updateLiveToolHeader(group) {
  const entries = [...group.items.values()];
  const failed = group.baseStatus === 'failed'
    || entries.some((entry) => /fail|error|declin/i.test(String(entry.status || '')));
  const running = !failed && (group.baseStatus === 'running'
    || entries.some((entry) => /progress|running|started/i.test(String(entry.status || ''))));
  const title = group.node.querySelector('.tool-summary-text strong');
  const status = group.node.querySelector('.tool-status');
  const chevron = group.node.querySelector('.tool-chevron');
  const liveAdditions = entries.filter((entry) => !entry.includedInBase).length;
  const total = Math.max(entries.length, Number(group.baseCount || 0) + liveAdditions);
  if (title) title.textContent = `${total}${group.baseIdentityComplete === false ? '+' : ''} 项工具活动`;
  if (status) {
    status.textContent = failed ? '失败' : running ? '进行中' : '已完成';
    status.className = `tool-status ${failed ? 'failed' : running ? 'running' : ''}`;
  }
  const details = group.node.querySelector('.tool-details');
  if (chevron) chevron.textContent = details?.open ? '收起' : '展开';
}

async function loadApprovals() {
  const result = await api('api/requests');
  state.pendingRequests = new Map((result.data || []).map((request) => [request.id, request]));
  if (state.activeTurnId) {
    const activeRequests = [...state.pendingRequests.values()].filter((request) => !request.threadId || request.threadId === state.activeThread?.id);
    if (activeRequests.some((request) => request.method === 'item/tool/requestUserInput' || request.availableDecisions?.length)) {
      state.turnActivityPhase = 'approval';
    } else if (activeRequests.length > 0) {
      state.turnActivityPhase = 'waiting';
    }
    syncComposerState();
  }
  renderApprovals();
}

function renderApprovals() {
  elements.approvals.replaceChildren();
  elements.requestPanelList.replaceChildren();
  const requests = [...state.pendingRequests.values()];
  const alerts = [...state.toolAlerts.values()];
  const total = requests.length + alerts.length;
  elements.requestsBadge.textContent = String(total);
  elements.requestsBadge.classList.toggle('hidden', total === 0);
  if (total === 0) {
    const empty = document.createElement('div');
    empty.className = 'request-panel-empty';
    empty.textContent = '当前没有待处理请求';
    elements.requestPanelList.append(empty);
    return;
  }
  for (const request of requests) {
    const label = document.createElement('div');
    label.className = 'request-thread-label';
    const thread = state.threads.find((candidate) => candidate.id === request.threadId);
    label.textContent = thread?.name || request.threadId || '当前 task';
    elements.requestPanelList.append(label, buildRequestCard(request));
    if (!state.activeThread || !request.threadId || request.threadId === state.activeThread.id) {
      elements.approvals.append(buildRequestCard(request));
    }
  }
  for (const alert of alerts) {
    const label = document.createElement('div');
    label.className = 'request-thread-label';
    const thread = state.threads.find((candidate) => candidate.id === alert.threadId);
    label.textContent = thread?.name || alert.threadId || '当前 task';
    elements.requestPanelList.append(label, buildToolAlertCard(alert));
    if (!state.activeThread || !alert.threadId || alert.threadId === state.activeThread.id) {
      elements.approvals.append(buildToolAlertCard(alert));
    }
  }
}

function buildToolAlertCard(alert) {
  const box = document.createElement('div');
  box.className = 'approval tool-alert';
  const title = document.createElement('strong');
  title.textContent = `工具失败：${alert.title || '未知工具'}`;
  const reason = document.createElement('p');
  reason.textContent = alert.preview || '工具执行失败';
  const actions = document.createElement('div');
  actions.className = 'approval-actions';
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'secondary';
  dismiss.textContent = '知道了';
  dismiss.addEventListener('click', () => {
    state.toolAlerts.delete(String(alert.id));
    renderApprovals();
  });
  actions.append(dismiss);
  box.append(title, reason, actions);
  return box;
}

function buildRequestCard(request) {
  const box = document.createElement('div');
  box.className = 'approval';
  const title = document.createElement('strong');
  const reason = document.createElement('p');
  const isFileChange = request.method === 'item/fileChange/requestApproval';
  const isCommand = request.method === 'item/commandExecution/requestApproval';
  const isDynamicTool = request.method === 'item/tool/call';
  const isUserInput = request.method === 'item/tool/requestUserInput';
  const isElicitation = request.method === 'mcpServer/elicitation/request';
  const isPermissions = request.method === 'item/permissions/requestApproval';
  if (isDynamicTool) box.classList.add('passive-tool');
  title.textContent = isFileChange
    ? 'Codex 请求修改文件'
    : isCommand
      ? 'Codex 请求执行命令'
      : isDynamicTool
        ? '正在等待客户端工具'
        : isPermissions
          ? 'Codex 请求额外权限'
        : isUserInput
          ? 'Codex 需要你的回答'
          : isElicitation
            ? '外部工具请求信息'
            : 'Codex 请求需要在桌面处理';
  const dynamicToolName = [request.namespace, request.tool].filter(Boolean).join('/');
  reason.textContent = isDynamicTool
    ? `工具：${dynamicToolName || '名称未知'}`
    : isElicitation
      ? request.elicitation?.message || `来自 ${request.elicitation?.serverName || 'MCP 服务'}`
      : request.reason || (isCommand || isFileChange || isUserInput ? '' : `暂不支持：${request.method}`);
  box.append(title, reason);
  if (isUserInput) {
    box.append(buildUserInputForm(request));
    return box;
  }
  if (isElicitation) {
    box.append(buildElicitationForm(request));
    return box;
  }
  const details = document.createElement('pre');
  const visibleContext = Object.fromEntries(Object.entries({
    command: request.command,
    commandActions: request.commandActions,
    cwd: request.cwd,
    grantRoot: request.grantRoot,
    networkApprovalContext: request.networkApprovalContext,
    additionalPermissions: request.additionalPermissions,
    proposedExecpolicyAmendment: request.proposedExecpolicyAmendment,
    proposedNetworkPolicyAmendments: request.proposedNetworkPolicyAmendments,
    permissions: request.permissions,
  }).filter(([, value]) => value != null));
  details.textContent = isDynamicTool
    ? '手机端无需操作；正在等待具备该工具能力的客户端返回结果。请求完成或本轮结束后，此提示会自动消失。'
    : Object.keys(visibleContext).length > 0
      ? JSON.stringify(visibleContext, null, 2)
      : '请在桌面 Codex 中查看并处理此请求。';
  box.append(details);
  const actions = buildApprovalActions(request);
  if (actions.childElementCount > 0) box.append(actions);
  return box;
}

function buildApprovalActions(request) {
  const actions = document.createElement('div');
  actions.className = 'approval-actions';
  const labels = {
    accept: [request.method === 'item/permissions/requestApproval' ? '允许本轮' : '允许一次', 'primary'],
    decline: ['拒绝', 'danger'],
    cancel: ['取消', 'secondary'],
  };
  for (const decision of request.availableDecisions || []) {
    const [label, cls] = labels[decision] || [];
    if (!label) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = cls;
    button.textContent = label;
    button.addEventListener('click', () => answerApproval(request.id, decision).catch((error) => showNotice(error.message)));
    actions.append(button);
  }
  return actions;
}

function buildUserInputForm(request) {
  const form = document.createElement('form');
  form.className = 'request-input-form';
  const fields = [];
  for (const [index, question] of (request.questions || []).entries()) {
    const fieldset = document.createElement('fieldset');
    fieldset.className = 'request-question';
    const legend = document.createElement('legend');
    legend.textContent = question.header || `问题 ${index + 1}`;
    const prompt = document.createElement('p');
    prompt.textContent = question.question;
    fieldset.append(legend, prompt);
    const field = { id: question.id, choices: [], freeform: null };
    for (const option of question.options || []) {
      const label = document.createElement('label');
      label.className = 'request-choice';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = `request-${request.id}-${index}`;
      input.value = option.label;
      const text = document.createElement('span');
      text.textContent = option.label;
      label.append(input, text);
      if (option.description) {
        const description = document.createElement('small');
        description.textContent = option.description;
        label.append(description);
      }
      field.choices.push(input);
      fieldset.append(label);
    }
    if (!question.options?.length || question.isOther) {
      const input = document.createElement(question.isSecret ? 'input' : 'textarea');
      input.className = 'request-freeform';
      input.type = question.isSecret ? 'password' : 'text';
      input.placeholder = question.options?.length ? '其他答案' : '输入回答';
      field.freeform = input;
      fieldset.append(input);
    }
    fields.push(field);
    form.append(fieldset);
  }
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'primary';
  submit.textContent = '提交回答';
  form.append(submit);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const answers = {};
    for (const field of fields) {
      const freeform = field.freeform?.value.trim() || '';
      const selected = field.choices.find((choice) => choice.checked)?.value || '';
      const value = freeform || selected;
      if (!value) return showNotice('请完成所有问题后再提交');
      answers[field.id] = [value];
    }
    submit.disabled = true;
    try {
      await answerUserInput(request.id, answers);
    } catch (error) {
      showNotice(error.message);
    } finally {
      submit.disabled = false;
    }
  });
  return form;
}

function buildElicitationForm(request) {
  const container = document.createElement('div');
  const elicitation = request.elicitation || {};
  const actions = document.createElement('div');
  actions.className = 'approval-actions';
  const fields = [];
  const properties = elicitation.requestedSchema?.properties;
  if ((elicitation.mode === 'form' || elicitation.mode === 'openai/form') && properties && typeof properties === 'object') {
    const required = new Set(elicitation.requestedSchema?.required || []);
    for (const [name, schema] of Object.entries(properties).slice(0, 12)) {
      const label = document.createElement('label');
      label.className = 'request-question';
      const caption = document.createElement('strong');
      caption.textContent = schema?.title || name;
      const input = document.createElement(schema?.enum ? 'select' : 'input');
      input.required = required.has(name);
      if (schema?.enum) {
        for (const value of schema.enum.slice(0, 20)) {
          const option = document.createElement('option');
          option.value = String(value);
          option.textContent = String(value);
          input.append(option);
        }
      } else {
        input.type = schema?.type === 'number' || schema?.type === 'integer' ? 'number' : schema?.type === 'boolean' ? 'checkbox' : 'text';
        if (schema?.description) input.placeholder = String(schema.description).slice(0, 240);
      }
      label.append(caption, input);
      container.append(label);
      fields.push({ name, schema, input, required: required.has(name) });
    }
  }
  if (elicitation.url) {
    const link = document.createElement('a');
    link.className = 'artifact-action primary-link';
    link.href = elicitation.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = '打开请求页面';
    container.append(link);
  }
  const accept = document.createElement('button');
  accept.type = 'button';
  accept.className = 'primary';
  accept.textContent = elicitation.url ? '我已完成' : '提交';
  accept.addEventListener('click', async () => {
    const content = {};
    for (const field of fields) {
      const raw = field.input.type === 'checkbox' ? field.input.checked : field.input.value;
      if (field.required && (raw === '' || raw == null)) return showNotice('请完成必填字段');
      if (!field.required && raw === '') continue;
      content[field.name] = field.schema?.type === 'number' || field.schema?.type === 'integer' ? Number(raw) : raw;
    }
    await answerElicitation(request.id, 'accept', content).catch((error) => showNotice(error.message));
  });
  actions.append(accept);
  for (const [action, label, cls] of [['decline', '拒绝', 'danger'], ['cancel', '取消', 'secondary']]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = cls;
    button.textContent = label;
    button.addEventListener('click', () => answerElicitation(request.id, action, null).catch((error) => showNotice(error.message)));
    actions.append(button);
  }
  container.append(actions);
  return container;
}

async function answerApproval(requestId, decision) {
  await api(`api/requests/${encodeURIComponent(requestId)}/respond`, {
    method: 'POST',
    body: { decision },
  });
  state.pendingRequests.delete(String(requestId));
  state.turnActivityPhase = state.activeTurnId ? 'thinking' : null;
  syncComposerState();
  renderApprovals();
}

async function answerUserInput(requestId, answers) {
  await api(`api/requests/${encodeURIComponent(requestId)}/respond`, {
    method: 'POST',
    body: { answers },
  });
  finishRequest(requestId);
}

async function answerElicitation(requestId, action, content) {
  await api(`api/requests/${encodeURIComponent(requestId)}/respond`, {
    method: 'POST',
    body: { action, content },
  });
  finishRequest(requestId);
}

function finishRequest(requestId) {
  state.pendingRequests.delete(String(requestId));
  state.turnActivityPhase = state.activeTurnId ? 'thinking' : null;
  syncComposerState();
  renderApprovals();
}

function openRequestDrawer() {
  renderApprovals();
  elements.requestDrawer.classList.remove('hidden');
  elements.requestDrawerClose.focus();
}

function closeRequestDrawer() {
  elements.requestDrawer.classList.add('hidden');
}

function syncComposerState() {
  const busy = Boolean(state.activeTurnId && state.activeTurnThreadId === state.activeThread?.id);
  elements.send.classList.remove('hidden');
  elements.stop.classList.toggle('hidden', !busy || !state.canInterrupt);
  elements.prompt.disabled = false;
  elements.send.disabled = (busy && !state.canSteer)
    || state.attachments.some((attachment) => ['queued', 'uploading'].includes(attachment.status));
  elements.attach.disabled = state.attachments.length >= 4;
  elements.send.textContent = busy ? (state.canSteer ? '追加' : '运行中') : '发送';
  elements.prompt.placeholder = busy
    ? (state.canSteer ? 'Codex 正在工作，可追加指令…' : 'Codex 正在工作；可先输入，完成后再发送…')
    : '给 Codex 发消息…';
  syncTurnActivity(busy);
}

function syncTurnActivity(busy) {
  elements.turnActivity.classList.toggle('hidden', !busy);
  if (!busy) {
    state.turnActivityPhase = null;
    return;
  }
  const labels = {
    thinking: 'Codex 正在思考…',
    tool: 'Codex 正在使用工具…',
    responding: 'Codex 正在回复…',
    approval: 'Codex 正在等待你的确认…',
    waiting: 'Codex 正在等待工具结果…',
  };
  elements.turnActivityText.textContent = labels[state.turnActivityPhase] || labels.thinking;
}

function hasRunningLiveTools() {
  for (const group of state.liveToolGroups.values()) {
    for (const entry of group.items.values()) {
      if (/progress|running|started/i.test(String(entry.status || ''))) return true;
    }
  }
  return false;
}

function resizeComposer() {
  elements.prompt.style.height = 'auto';
  elements.prompt.style.height = `${Math.min(elements.prompt.scrollHeight, 160)}px`;
}

function setOnline(online) {
  elements.connection.textContent = online ? '在线' : '断线';
  elements.connection.classList.toggle('online', online);
}

function showNotice(text) {
  elements.notice.textContent = text;
  elements.notice.classList.remove('hidden');
}

function isThreadNotFoundMessage(text) {
  return /thread not found:/i.test(String(text || ''));
}

function clearStaleThreadNotFoundNotice() {
  if (!isThreadNotFoundMessage(elements.notice.textContent)) return;
  elements.notice.textContent = '';
  elements.notice.classList.add('hidden');
}

function distanceFromBottom() {
  return Math.max(0, elements.messages.scrollHeight - elements.messages.scrollTop - elements.messages.clientHeight);
}

function updateJumpBottom() {
  if (state.jumpScrollTimer) {
    elements.jumpBottom.classList.add('hidden');
    return;
  }
  const nearBottom = distanceFromBottom() <= 96;
  state.followLatest = nearBottom;
  const scrollable = elements.messages.scrollHeight > elements.messages.clientHeight + 1;
  elements.jumpBottom.classList.toggle('hidden', !state.activeThread || !scrollable || nearBottom);
}

function resetConversationScroll() {
  if (state.jumpScrollTimer) clearTimeout(state.jumpScrollTimer);
  state.jumpScrollTimer = null;
  state.followLatest = true;
  elements.messages.scrollTop = 0;
  elements.jumpBottom.classList.add('hidden');
}

function scrollBottom({ force = false } = {}) {
  if (!force && !state.followLatest) {
    updateJumpBottom();
    return;
  }
  requestAnimationFrame(() => {
    elements.messages.scrollTop = elements.messages.scrollHeight;
    state.followLatest = true;
    updateJumpBottom();
  });
}

function jumpToLatest() {
  if (state.jumpScrollTimer) clearTimeout(state.jumpScrollTimer);
  state.followLatest = true;
  elements.jumpBottom.classList.add('hidden');
  const top = elements.messages.scrollHeight;
  if (typeof elements.messages.scrollTo === 'function') {
    elements.messages.scrollTo({ top, behavior: 'smooth' });
  } else {
    elements.messages.scrollTop = top;
  }
  state.jumpScrollTimer = setTimeout(() => {
    state.jumpScrollTimer = null;
    scrollBottom({ force: true });
  }, 420);
}

function formatTime(timestamp) {
  if (!timestamp) return '';
  const value = Number(timestamp) < 10_000_000_000 ? Number(timestamp) * 1000 : Number(timestamp);
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.code = data.code;
    throw error;
  }
  return data;
}

function debounce(fn, wait) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export { decodeCharacterReferences, renderMarkdown, renderMessageImages, renderArtifacts, clipboardImageFiles, prepareClipboardImages, updateLiveToolGroup, updateLiveToolProgress, openThread, showThreadList, handleEvent, syncComposerState, loadOlderTurns, updateJumpBottom, scrollBottom, jumpToLatest, isThreadNotFoundMessage, clearStaleThreadNotFoundNotice, state };
