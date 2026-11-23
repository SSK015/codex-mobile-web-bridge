import {
  createMarkdownRenderer,
  isValidArtifactToken,
  MAX_CONTENT_BYTES,
  readBoundedResponse,
} from './markdown-renderer.js';

(() => {
  'use strict';

  const THEME_STORAGE_KEY = 'codex-mobile-theme';
  const ACCEPTED_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.txt']);
  const encoder = new TextEncoder();
  const $ = (selector) => document.querySelector(selector);
  const elements = {
    copy: $('#copy-source'),
    documentStatus: $('#document-status'),
    documentTitle: $('#document-title'),
    download: $('#download-source'),
    dropOverlay: $('#drop-overlay'),
    filePicker: $('#file-picker'),
    loginError: $('#login-error'),
    loginForm: $('#login-form'),
    loginPanel: $('#login-panel'),
    loginPassword: $('#login-password'),
    notice: $('#notice'),
    preview: $('#preview'),
    size: $('#source-size'),
    source: $('#source'),
    sourceHint: $('#source-hint'),
    theme: $('#theme'),
    workspace: $('#workspace'),
  };
  const state = {
    artifactName: '',
    artifactToken: '',
    content: '',
    hasDocument: false,
    isArtifact: false,
    renderer: null,
    requestController: null,
    renderTimer: 0,
    view: 'split',
  };

  function byteLength(value) {
    return encoder.encode(value).byteLength;
  }

  function formatBytes(size) {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
    return `${(size / (1024 * 1024)).toFixed(2)} MB`;
  }

  function setNotice(message, kind = 'info') {
    elements.notice.textContent = message;
    elements.notice.classList.toggle('error', kind === 'error');
    elements.notice.hidden = !message;
  }

  function setStatus(message) {
    elements.documentStatus.textContent = message;
  }

  function setDocumentTitle(name) {
    const cleanName = String(name || '').trim().slice(0, 255) || '未命名文档';
    elements.documentTitle.textContent = cleanName;
    document.title = `${cleanName} · Markdown 预览`;
  }

  function setDocumentAvailable(available) {
    state.hasDocument = available;
    elements.copy.disabled = !available;
    elements.download.disabled = !available;
  }

  function readThemePreference() {
    try {
      const saved = localStorage.getItem(THEME_STORAGE_KEY);
      return ['system', 'light', 'dark'].includes(saved) ? saved : 'system';
    } catch {
      return 'system';
    }
  }

  function applyTheme(preference, { persist = false } = {}) {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    const resolved = preference === 'system'
      ? (media ? (media.matches ? 'dark' : 'light') : 'dark')
      : preference;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themePreference = preference;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'light' ? '#f6f8fa' : '#0d1117');

    const labels = {
      system: ['◐', '主题：跟随系统'],
      light: ['☀', '主题：浅色'],
      dark: ['☾', '主题：深色'],
    };
    const [icon, label] = labels[preference];
    elements.theme.textContent = icon;
    elements.theme.setAttribute('aria-label', label);
    elements.theme.title = label;
    if (persist) {
      try { localStorage.setItem(THEME_STORAGE_KEY, preference); } catch {}
    }
  }

  function cycleTheme() {
    const current = document.documentElement.dataset.themePreference || 'system';
    const next = { system: 'light', light: 'dark', dark: 'system' }[current] || 'system';
    applyTheme(next, { persist: true });
  }

  function renderPreview() {
    if (!state.content) {
      elements.preview.innerHTML = state.hasDocument
        ? '<div class="empty-preview"><p>这是一个空文档</p><span>在源码中输入内容即可开始预览</span></div>'
        : '<div class="empty-preview"><span class="empty-icon" aria-hidden="true">M↓</span><p>预览会显示在这里</p><span>粘贴文字、打开文件，或拖放 Markdown 文件</span></div>';
      return;
    }
    if (!state.renderer) {
      elements.preview.textContent = 'Markdown 渲染器尚未加载，请刷新页面后重试。';
      setNotice('Markdown 渲染器未能加载，文档内容仍保留在源码框中。', 'error');
      return;
    }
    try {
      elements.preview.innerHTML = state.renderer.render(state.content);
    } catch {
      elements.preview.textContent = '无法渲染此文档。';
      setNotice('渲染文档时发生错误。', 'error');
    }
  }

  function schedulePreview(immediate = false) {
    window.clearTimeout(state.renderTimer);
    if (immediate) {
      renderPreview();
      return;
    }
    state.renderTimer = window.setTimeout(renderPreview, 120);
  }

  function updateSource(value, { showStatus = false, immediate = false } = {}) {
    const size = byteLength(value);
    if (size > MAX_CONTENT_BYTES) {
      elements.source.value = state.content;
      setNotice('文档最多支持 2 MiB；当前内容超过限制。', 'error');
      return false;
    }
    state.content = value;
    setDocumentAvailable(true);
    elements.size.textContent = formatBytes(size);
    setNotice('');
    schedulePreview(immediate);
    if (showStatus) setStatus(`本地内容 · ${formatBytes(size)}`);
    return true;
  }

  function cancelArtifactRequest() {
    if (!state.requestController) return;
    state.requestController.abort();
    state.requestController = null;
  }

  function enableLocalMode(name = '未命名文档') {
    cancelArtifactRequest();
    state.isArtifact = false;
    state.artifactName = '';
    state.artifactToken = '';
    elements.loginPanel.hidden = true;
    elements.loginError.hidden = true;
    elements.source.readOnly = false;
    elements.sourceHint.textContent = '文字会即时显示在预览中';
    elements.source.value = '';
    updateSource('', { immediate: true });
    setDocumentAvailable(false);
    elements.size.textContent = '0 B';
    setDocumentTitle(name);
    setStatus('输入文字、打开文件，或拖放一个 Markdown 文件');
    setNotice('');
  }

  function artifactEndpoint(token) {
    const endpoint = new URL(`api/artifacts/${token}`, window.location.href);
    if (endpoint.origin !== window.location.origin || endpoint.search || endpoint.hash) {
      throw new TypeError('无效的文件链接。');
    }
    return endpoint;
  }

  function showLogin() {
    elements.loginPanel.hidden = false;
    elements.loginError.hidden = true;
    setStatus('登录后会重新加载此文件');
  }

  async function loadArtifact() {
    if (!state.isArtifact || !state.artifactToken) return;
    cancelArtifactRequest();
    const controller = new AbortController();
    state.requestController = controller;
    elements.loginPanel.hidden = true;
    setNotice('正在从当前会话加载文件…');
    setStatus('正在加载文件');
    try {
      const response = await fetch(artifactEndpoint(state.artifactToken), {
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
      });
      if (response.status === 401) {
        showLogin();
        setNotice('此文件需要通过访问密码验证。');
        return;
      }
      if (response.status === 404 || response.status === 415) {
        setDocumentAvailable(false);
        setNotice('文件已变化/链接失效，请回到会话重新打开', 'error');
        setStatus('无法打开此文件');
        return;
      }
      if (!response.ok) {
        setNotice(`无法加载文件（HTTP ${response.status}）。`, 'error');
        setStatus('加载失败');
        return;
      }
      const content = await readBoundedResponse(response);
      if (!state.isArtifact || state.artifactToken === '') return;
      elements.source.value = content;
      elements.source.readOnly = true;
      elements.sourceHint.textContent = '来自会话的只读文件';
      elements.size.textContent = formatBytes(byteLength(content));
      state.content = content;
      setDocumentAvailable(true);
      setDocumentTitle(state.artifactName);
      setStatus(`来自当前会话 · ${formatBytes(byteLength(content))} · 只读`);
      setNotice('');
      schedulePreview(true);
    } catch (error) {
      if (error?.name === 'AbortError') return;
      if (error instanceof RangeError) {
        setDocumentAvailable(false);
        setNotice('此文件超过 2 MiB，无法在预览器中打开。', 'error');
        setStatus('文件过大');
      } else {
        setNotice('无法连接到当前会话，请确认链接仍有效后重试。', 'error');
        setStatus('加载失败');
      }
    } finally {
      if (state.requestController === controller) state.requestController = null;
    }
  }

  async function loginAndRetry(event) {
    event.preventDefault();
    if (!state.isArtifact) return;
    elements.loginError.hidden = true;
    const endpoint = new URL('api/login', window.location.href);
    if (endpoint.origin !== window.location.origin) {
      elements.loginError.textContent = '无法连接到登录服务。';
      elements.loginError.hidden = false;
      return;
    }
    const submit = elements.loginForm.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: elements.loginPassword.value }),
      });
      if (!response.ok) {
        elements.loginError.textContent = '密码不正确，或登录服务暂时不可用。';
        elements.loginError.hidden = false;
        return;
      }
      elements.loginPassword.value = '';
      await loadArtifact();
    } catch {
      elements.loginError.textContent = '无法连接到登录服务，请重试。';
      elements.loginError.hidden = false;
    } finally {
      submit.disabled = false;
    }
  }

  function filenameExtension(name) {
    const match = /\.([^.]+)$/u.exec(name);
    return match ? `.${match[1].toLowerCase()}` : '';
  }

  function markdownFilename(name) {
    const leaf = String(name || 'document').split(/[\\/]/u).pop()
      .replace(/[\u0000-\u001f\u007f<>:"|?*]/gu, '_')
      .replace(/^[. ]+|[. ]+$/gu, '') || 'document';
    const stem = leaf.replace(/\.[^.]*$/u, '').trim() || 'document';
    return `${stem}.md`;
  }

  async function openFile(file) {
    if (!file) return;
    const extension = filenameExtension(file.name);
    if (!ACCEPTED_EXTENSIONS.has(extension)) {
      setNotice('请打开 .md、.markdown、.mdown 或 .txt 文件。', 'error');
      return;
    }
    if (file.size > MAX_CONTENT_BYTES) {
      setNotice('文件超过 2 MiB，无法打开。', 'error');
      return;
    }
    try {
      const content = await file.text();
      if (byteLength(content) > MAX_CONTENT_BYTES) {
        setNotice('文件解码后的内容超过 2 MiB，无法打开。', 'error');
        return;
      }
      enableLocalMode(file.name);
      elements.source.value = content;
      updateSource(content, { showStatus: true, immediate: true });
      setDocumentTitle(file.name);
      setStatus(`本地文件 · ${formatBytes(byteLength(content))}`);
      setView(window.matchMedia?.('(max-width: 680px)').matches ? 'preview' : state.view);
      if (elements.filePicker) elements.filePicker.value = '';
    } catch {
      setNotice('无法读取此文件。', 'error');
    }
  }

  async function copySource() {
    if (!state.hasDocument) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(state.content);
      } else {
        elements.source.focus();
        elements.source.select();
        const copied = document.execCommand('copy');
        elements.source.setSelectionRange(0, 0);
        if (!copied) throw new Error('clipboard unavailable');
      }
      setStatus('源码已复制到剪贴板');
      window.setTimeout(() => {
        if (state.hasDocument) setStatus(`${state.isArtifact ? '来自当前会话 · ' : '本地内容 · '}${formatBytes(byteLength(state.content))}${state.isArtifact ? ' · 只读' : ''}`);
      }, 1800);
    } catch {
      setNotice('复制失败，请选中源码后手动复制。', 'error');
    }
  }

  function downloadSource() {
    if (!state.hasDocument) return;
    const blob = new Blob([state.content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = markdownFilename(state.artifactName || elements.documentTitle.textContent);
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function setView(view) {
    if (!['source', 'split', 'preview'].includes(view)) return;
    state.view = view;
    elements.workspace.dataset.view = view;
    document.querySelectorAll('.view-button').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.view === view));
    });
  }

  function isMarkdownFile(file) {
    return Boolean(file && ACCEPTED_EXTENSIONS.has(filenameExtension(file.name)));
  }

  function handleDroppedFiles(event) {
    event.preventDefault();
    elements.dropOverlay.hidden = true;
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    if (!isMarkdownFile(file)) {
      setNotice('请拖入 .md、.markdown、.mdown 或 .txt 文件。', 'error');
      return;
    }
    void openFile(file);
  }

  function initializeDropHandling() {
    let dragDepth = 0;
    document.addEventListener('dragenter', (event) => {
      if (!event.dataTransfer?.types?.includes('Files')) return;
      event.preventDefault();
      dragDepth += 1;
      elements.dropOverlay.hidden = false;
    });
    document.addEventListener('dragover', (event) => {
      if (event.dataTransfer?.types?.includes('Files')) event.preventDefault();
    });
    document.addEventListener('dragleave', (event) => {
      if (!event.dataTransfer?.types?.includes('Files')) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) elements.dropOverlay.hidden = true;
    });
    document.addEventListener('drop', (event) => {
      if (!event.dataTransfer?.types?.includes('Files') && !event.dataTransfer?.files?.length) return;
      dragDepth = 0;
      handleDroppedFiles(event);
    });
  }

  function initialize() {
    applyTheme(readThemePreference());
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    media?.addEventListener?.('change', () => {
      if (document.documentElement.dataset.themePreference === 'system') applyTheme('system');
    });
    elements.theme.addEventListener('click', cycleTheme);
    elements.source.addEventListener('input', () => {
      if (!state.isArtifact) updateSource(elements.source.value, { showStatus: true });
    });
    elements.copy.addEventListener('click', () => { void copySource(); });
    elements.download.addEventListener('click', downloadSource);
    $('#open-file').addEventListener('click', () => elements.filePicker.click());
    elements.filePicker.addEventListener('change', () => { void openFile(elements.filePicker.files?.[0]); });
    elements.loginForm.addEventListener('submit', (event) => { void loginAndRetry(event); });
    document.querySelectorAll('.view-button').forEach((button) => {
      button.addEventListener('click', () => setView(button.dataset.view));
    });
    initializeDropHandling();

    state.renderer = typeof window.markdownit === 'function'
      ? createMarkdownRenderer(window.markdownit, { baseUrl: window.location.href })
      : null;
    const mobileDefault = window.matchMedia?.('(max-width: 680px)').matches;
    setView(mobileDefault ? 'preview' : 'split');

    const params = new URLSearchParams(window.location.search);
    if (!params.has('artifact')) {
      renderPreview();
      return;
    }

    const token = params.get('artifact') || '';
    if (!isValidArtifactToken(token)) {
      setStatus('文件链接无效');
      setNotice('文件已变化/链接失效，请回到会话重新打开', 'error');
      return;
    }
    state.isArtifact = true;
    state.artifactToken = token;
    state.artifactName = params.get('name') || '会话文件.md';
    setDocumentTitle(state.artifactName);
    setStatus('正在加载会话文件');
    elements.source.readOnly = true;
    elements.sourceHint.textContent = '来自会话的只读文件';
    void loadArtifact();
  }

  initialize();
})();
