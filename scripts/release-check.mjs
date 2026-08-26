import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root })
  .toString('utf8').split('\0').filter(Boolean);
const errors = [];
const forbiddenExtensions = new Set(['.exe', '.dll', '.pem', '.key', '.pfx', '.log']);
const forbiddenText = [
  /[A-Za-z]:\\Users\\/i,
  /\/Users\/[A-Za-z0-9._-]+\//,
  /sslip\.io/i,
  /LightsailDefaultKey/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b01[a-f0-9]{6}-[a-f0-9-]{20,}\b/i,
];

try {
  const gitEmail = execFileSync('git', ['config', '--get', 'user.email'], { cwd: root })
    .toString('utf8').trim();
  const localPart = gitEmail.split('@')[0] || '';
  if (/^\d{7,}$/.test(localPart)) {
    errors.push('git user.email looks like a phone number; use a public or noreply address before committing');
  }
} catch {
  // A clone without Git identity can still run the source release audit.
}

for (const relative of tracked) {
  const fullPath = path.join(root, relative);
  const stats = fs.statSync(fullPath);
  if (forbiddenExtensions.has(path.extname(relative).toLowerCase())) errors.push(`${relative}: forbidden file type`);
  if (stats.size > 2 * 1024 * 1024) errors.push(`${relative}: larger than 2 MiB`);
  if (relative === 'scripts/release-check.mjs' || stats.size > 512 * 1024) continue;
  const text = fs.readFileSync(fullPath, 'utf8');
  for (const pattern of forbiddenText) {
    if (pattern.test(text)) errors.push(`${relative}: matches private-data pattern ${pattern}`);
  }
}

if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, trackedFiles: tracked.length }));
