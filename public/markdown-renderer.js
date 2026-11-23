export const MAX_CONTENT_BYTES = 2 * 1024 * 1024;

const ARTIFACT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,2048}$/u;

export function isValidArtifactToken(token) {
  return typeof token === 'string' && ARTIFACT_TOKEN_PATTERN.test(token);
}

export async function readBoundedResponse(response, maxBytes = MAX_CONTENT_BYTES) {
  const contentLength = response.headers.get('content-length');
  if (contentLength && /^\d+$/u.test(contentLength) && Number(contentLength) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new RangeError(`Document exceeds ${maxBytes} bytes.`);
  }

  if (!response.body?.getReader) {
    throw new Error('Streaming response bodies are required to enforce the size limit.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  const pieces = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new RangeError(`Document exceeds ${maxBytes} bytes.`);
      }
      pieces.push(decoder.decode(value, { stream: true }));
    }
    pieces.push(decoder.decode());
    return pieces.join('');
  } finally {
    reader.releaseLock();
  }
}

function getHeadingText(inlineToken) {
  return (inlineToken?.children || []).map((token) => {
    if (token.type === 'image') return token.attrGet('alt') || token.content;
    if (token.type === 'softbreak' || token.type === 'hardbreak') return ' ';
    return token.content || '';
  }).join('');
}

function slugifyHeading(value) {
  return value.normalize('NFKC').toLowerCase().trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

function sanitizeDestination(raw, { image = false, baseUrl } = {}) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || /[\u0000-\u001f\u007f]/u.test(value)) return null;

  if (!image && value.startsWith('#')) {
    try {
      const target = new URL(value, baseUrl);
      const current = new URL(baseUrl);
      if (target.origin === current.origin && target.pathname === current.pathname && target.search === current.search && target.hash) {
        return { fragment: decodeURIComponent(target.hash.slice(1)), external: false };
      }
    } catch {}
    return null;
  }

  if (/^https?:\/\//i.test(value)) {
    try {
      const target = new URL(value);
      if (!target.hostname || target.username || target.password) return null;
      return { href: target.href, external: true };
    } catch {
      return null;
    }
  }

  if (!image && /^mailto:/i.test(value) && !/[\r\n]/u.test(value)) {
    return { href: value, external: false };
  }
  if (!image && /^tel:[+0-9(). -]+$/i.test(value)) {
    return { href: value, external: false };
  }
  return null;
}

function prepareHeadings(tokens) {
  const headingAnchors = new Map();
  const slugCounts = new Map();
  const usedIds = new Set();
  let fallbackNumber = 0;
  tokens.forEach((token, index) => {
    if (token.type !== 'heading_open') return;
    const slug = slugifyHeading(getHeadingText(tokens[index + 1])) || `section-${++fallbackNumber}`;
    let count = slugCounts.get(slug) || 0;
    let id;
    do {
      id = `md-preview-${slug}${count ? `-${count + 1}` : ''}`;
      count += 1;
    } while (usedIds.has(id));
    slugCounts.set(slug, count);
    usedIds.add(id);
    token.attrSet('id', id);
    if (!headingAnchors.has(slug)) headingAnchors.set(slug, id);
    headingAnchors.set(id, id);
  });
  return headingAnchors;
}

function addTaskListSupport(md, tokens) {
  md.renderer.rules.task_checkbox = (children, index) => children[index].content;

  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].type !== 'list_item_open') continue;
    let nesting = 0;
    let inline = null;
    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      const current = tokens[cursor];
      if (current.type === 'list_item_open') nesting += 1;
      if (current.type === 'list_item_close') {
        if (nesting === 0) break;
        nesting -= 1;
      }
      if (nesting === 0 && current.type === 'inline') {
        inline = current;
        break;
      }
    }
    const match = inline && /^\[([ xX])\]\s+/u.exec(inline.content);
    if (!match) continue;

    tokens[index].attrJoin('class', 'task-list-item');
    const checked = match[1].toLowerCase() === 'x';
    const label = checked ? '已完成' : '未完成';
    const firstText = inline.children?.find((child) => child.type === 'text');
    if (firstText) firstText.content = firstText.content.replace(/^\[([ xX])\]\s+/u, '');
    inline.children.unshift({
      type: 'task_checkbox',
      content: `<input class="task-checkbox" type="checkbox" disabled${checked ? ' checked' : ''} aria-label="${label}"> `,
    });
  }
}

export function createMarkdownRenderer(markdownit, { baseUrl = globalThis.location?.href || 'https://localhost/' } = {}) {
  if (typeof markdownit !== 'function') throw new TypeError('markdownit must be a function.');
  const md = markdownit({
    breaks: false,
    html: false,
    linkify: true,
    typographer: false,
  });
  const linkKinds = [];
  let headingAnchors = new Map();

  md.renderer.rules.link_open = (tokens, index, options, environment, renderer) => {
    const token = tokens[index];
    const destination = sanitizeDestination(token.attrGet('href'), { baseUrl });
    if (!destination || (destination.fragment !== undefined && !headingAnchors.has(destination.fragment))) {
      linkKinds.push('blocked');
      return '<span class="md-blocked-link" role="note" title="本地路径或不安全链接未打开">';
    }
    linkKinds.push('link');
    token.attrSet('href', destination.fragment !== undefined ? `#${headingAnchors.get(destination.fragment)}` : destination.href);
    if (destination.external) {
      token.attrSet('target', '_blank');
      token.attrSet('rel', 'noopener noreferrer');
    }
    return renderer.renderToken(tokens, index, options);
  };

  md.renderer.rules.link_close = () => linkKinds.pop() === 'blocked' ? '</span>' : '</a>';

  md.renderer.rules.image = (tokens, index, options, environment, renderer) => {
    const token = tokens[index];
    const destination = sanitizeDestination(token.attrGet('src'), { baseUrl, image: true });
    if (!destination?.external) {
      const alt = md.utils.escapeHtml(token.content || token.attrGet('alt') || '图片');
      return `<span class="md-blocked-image" role="note">本地图片资源不支持：${alt}</span>`;
    }
    token.attrSet('alt', renderer.renderInlineAsText(token.children, options, environment));
    token.attrSet('src', destination.href);
    token.attrSet('loading', 'lazy');
    token.attrSet('decoding', 'async');
    token.attrSet('referrerpolicy', 'no-referrer');
    return renderer.renderToken(tokens, index, options);
  };

  return {
    render(source) {
      linkKinds.length = 0;
      const environment = {};
      const tokens = md.parse(source, environment);
      headingAnchors = prepareHeadings(tokens);
      addTaskListSupport(md, tokens);
      return md.renderer.render(tokens, md.options, environment);
    },
  };
}
