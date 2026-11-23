// Keep the standalone viewer usable without a CDN or a frontend build step.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(root, 'public', 'vendor');
const packages = ['markdown-it', 'argparse', 'entities', 'linkify-it', 'mdurl', 'punycode.js', 'uc.micro'];
fs.mkdirSync(destination, { recursive: true });
const bundle = fs.readFileSync(require.resolve('markdown-it/browser'), 'utf8')
  .replace(/^\/\/# sourceMappingURL=.*$/gm, '');
fs.writeFileSync(path.join(destination, 'markdown-it.min.js'), bundle);
const licenses = packages.map((name) => {
  const packageRoot = path.join(root, 'node_modules', name);
  const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  const filename = fs.readdirSync(packageRoot).find((entry) => /^licen[cs]e(?:-mit)?(?:\.(?:md|txt))?$/i.test(entry));
  if (!filename) throw new Error(`Missing license for ${name}`);
  return `${name} ${metadata.version}\n${'='.repeat(60)}\n${fs.readFileSync(path.join(packageRoot, filename), 'utf8').trim()}\n`;
});
fs.writeFileSync(path.join(destination, 'markdown-it.LICENSE.txt'), licenses.join('\n'));
console.log('Vendored Markdown renderer and third-party licenses.');
