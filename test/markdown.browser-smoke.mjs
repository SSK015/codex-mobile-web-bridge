// Optional browser smoke test. Supply PLAYWRIGHT_MODULE (absolute module file)
// and CHROMIUM_PATH when using an existing runtime instead of a local install.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const screenshots = path.resolve(root, 'tmp', 'markdown-browser-smoke');
await fs.mkdir(screenshots, { recursive: true });
const fixture = [
  '# Markdown 预览', '', '一个独立的阅读页面，支持 **粗体**、*斜体* 和 `行内代码`。', '',
  '## 支持的内容', '', '- [x] 标题与嵌套列表', '  - 桌面双栏、手机单栏', '- [ ] 后续文档整理', '',
  '| 功能 | 状态 |', '| --- | --- |', '| 表格与引用 | 可用 |', '| 源码与预览 | 可切换 |', '',
  '> 本地文件只在浏览器中读取，不上传。', '', '```js', 'const message = "Hello, Markdown!";', 'console.log(message);', '```', '',
  '[回到顶部](#markdown-预览)',
].join('\n');
const requests = [];
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const prefix = '/codex-mobile/';
  if (!url.pathname.startsWith(prefix)) { response.writeHead(404).end(); return; }
  const resource = url.pathname.slice(prefix.length);
  requests.push({ method: request.method, resource });
  if (resource === 'api/login' && request.method === 'POST') {
    let body = '';
    for await (const chunk of request) body += chunk;
    if (JSON.parse(body).password !== 'synthetic-test-password') { response.writeHead(401).end(); return; }
    response.writeHead(200, { 'Set-Cookie': 'fixture-auth=1; HttpOnly; SameSite=Strict; Path=/', 'Content-Type': 'application/json' }).end('{}');
    return;
  }
  if (resource.startsWith('api/artifacts/')) {
    if (!request.headers.cookie?.includes('fixture-auth=1')) { response.writeHead(401).end(); return; }
    const token = resource.slice('api/artifacts/'.length);
    if (token === 'a'.repeat(48)) { response.writeHead(200, { 'Content-Type': 'text/plain' }).end(fixture); return; }
    if (token === 'b'.repeat(48)) {
      response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': 2097153 });
      response.flushHeaders(); response.end(); return;
    }
    if (token === 'c'.repeat(48)) {
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.write('x'.repeat(2097152)); response.end('x'); return;
    }
    response.writeHead(token === 'e'.repeat(48) ? 415 : 404).end(); return;
  }
  if (!/^(?:markdown\.(?:html|css|js)|markdown-renderer\.js|vendor\/markdown-it\.min\.js|examples\/markdown-viewer-test\.md)$/u.test(resource)) {
    response.writeHead(404).end(); return;
  }
  try {
    const data = await fs.readFile(path.join(root, 'public', resource));
    const contentType = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.md': 'application/octet-stream' }[path.extname(resource)];
    response.writeHead(200, { 'Content-Type': `${contentType}; charset=utf-8` }).end(data);
  } catch { response.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/codex-mobile/markdown.html`;
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
const pageErrors = [];
async function expectHeading(page, text) {
  await page.waitForFunction((expected) => document.querySelector('#preview h1')?.textContent === expected, text);
}
async function noOverflow(page) {
  const sizes = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  assert.ok(sizes.scroll <= sizes.width, `horizontal overflow: ${JSON.stringify(sizes)}`);
}
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light', acceptDownloads: true });
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(base);
  const [exampleDownload] = await Promise.all([page.waitForEvent('download'), page.locator('#download-example').click()]);
  assert.equal(exampleDownload.suggestedFilename(), 'markdown-viewer-test.md');
  const exampleSource = await fs.readFile(new URL('../public/examples/markdown-viewer-test.md', import.meta.url), 'utf8');
  assert.equal(await fs.readFile(await exampleDownload.path(), 'utf8'), exampleSource);
  await page.locator('#source').fill(fixture);
  await expectHeading(page, 'Markdown 预览');
  assert.equal(await page.locator('#preview table tbody tr').count(), 2);
  assert.equal(await page.locator('#preview input[type="checkbox"]').count(), 2);
  assert.equal(await page.locator('#preview a').getAttribute('href'), '#md-preview-markdown-预览');
  await page.locator('#preview a').click();
  assert.ok(decodeURIComponent(new URL(page.url()).hash).includes('md-preview-markdown-预览'));
  await noOverflow(page);
  await page.screenshot({ path: path.join(screenshots, 'desktop-light.png'), fullPage: true });
  await page.locator('#theme').click(); // system -> light
  await page.locator('#theme').click(); // light -> dark
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  await page.screenshot({ path: path.join(screenshots, 'desktop-dark.png'), fullPage: true });
  assert.equal(requests.filter((request) => request.resource.startsWith('api/')).length, 0, 'local text never uploads');

  await page.locator('#source').fill('# Safety\n\n<script>globalThis.pwned=1</script>\n\n<img src=x onerror="globalThis.pwned=1">\n\n[bad](javascript:alert(1))\n\n![bad](file:///private)');
  await expectHeading(page, 'Safety');
  assert.equal(await page.locator('#preview script, #preview img, #preview a').count(), 0);
  assert.equal(await page.evaluate(() => globalThis.pwned), undefined);

  await page.locator('#file-picker').setInputFiles({ name: '设计笔记.MD', mimeType: 'text/markdown', buffer: Buffer.from(fixture) });
  await expectHeading(page, 'Markdown 预览');
  assert.equal(await page.locator('#document-title').textContent(), '设计笔记.MD');
  assert.equal(await page.locator('#source').evaluate((element) => element.readOnly), false);
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#download-source').click()]);
  assert.equal(download.suggestedFilename(), '设计笔记.md');
  assert.equal(await fs.readFile(await download.path(), 'utf8'), fixture);
  await page.locator('#file-picker').setInputFiles({ name: 'too-large.md', mimeType: 'text/plain', buffer: Buffer.alloc(2097153, 'a') });
  await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('2 MiB'));
  assert.equal(await page.locator('#source').inputValue(), fixture, 'rejected file preserves current document');
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['# Dropped'], 'drop.md', { type: 'text/markdown' }));
    document.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
  });
  await expectHeading(page, 'Dropped');

  const artifactUrl = (letter) => `${base}?${new URLSearchParams({ artifact: letter.repeat(48), name: 'Shared notes.md' })}`;
  await page.goto(artifactUrl('a'));
  await page.locator('#login-panel').waitFor({ state: 'visible' });
  await page.locator('#login-password').fill('incorrect');
  await page.locator('#login-form button').click();
  await page.locator('#login-error').waitFor({ state: 'visible' });
  await page.locator('#login-password').fill('synthetic-test-password');
  await page.locator('#login-form button').click();
  await expectHeading(page, 'Markdown 预览');
  assert.equal(await page.locator('#source').evaluate((element) => element.readOnly), true);
  assert.equal(await page.locator('#login-password').inputValue(), '');
  assert.equal(await page.locator('#preview a').getAttribute('href'), '#md-preview-markdown-预览');
  await page.locator('#preview a').click();
  assert.equal(new URL(page.url()).searchParams.get('artifact'), 'a'.repeat(48));
  for (const token of ['b', 'c']) {
    await page.goto(artifactUrl(token));
    await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('2 MiB'));
    assert.equal(await page.locator('#download-source').isDisabled(), true);
  }
  for (const token of ['d', 'e']) {
    await page.goto(artifactUrl(token));
    await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('链接失效'));
  }
  const beforeInvalid = requests.filter((request) => request.resource.startsWith('api/')).length;
  await page.goto(`${base}?artifact=../../not-an-artifact`);
  await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('链接失效'));
  assert.equal(requests.filter((request) => request.resource.startsWith('api/')).length, beforeInvalid);

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 1, colorScheme: 'light' });
  const phone = await mobile.newPage();
  phone.on('pageerror', (error) => pageErrors.push(error.message));
  await phone.goto(base);
  await phone.locator('[data-view="source"].view-button').click();
  await phone.locator('#source').fill(fixture);
  await expectHeading(phone, 'Markdown 预览');
  await phone.locator('[data-view="preview"].view-button').click();
  await noOverflow(phone);
  await phone.screenshot({ path: path.join(screenshots, 'mobile-light.png'), fullPage: true });
  await phone.setViewportSize({ width: 320, height: 740 });
  await phone.locator('[data-view="split"].view-button').click();
  await noOverflow(phone);
  await phone.locator('#file-picker').setInputFiles({ name: 'mobile.md', mimeType: 'text/plain', buffer: Buffer.from('# Mobile file') });
  await expectHeading(phone, 'Mobile file');
  assert.equal(await phone.locator('#workspace').getAttribute('data-view'), 'preview');
  assert.equal(await phone.locator('[data-view="preview"].view-button').getAttribute('aria-pressed'), 'true');
  await noOverflow(phone);
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ ok: true, scenarios: ['live rendering', 'safe HTML', 'local files', 'drag and drop', 'download', 'authentication', 'expired tokens', 'header/stream byte limits', 'reverse-proxy prefix', 'mobile layouts', 'theme'], screenshots }));
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
