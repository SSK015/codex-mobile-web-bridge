import assert from 'node:assert/strict';
import { safeCommandPreview, safeFileChangePreview, safePreviewText } from '../sanitizers.mjs';

assert.equal(safeCommandPreview('"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command secret'), 'pwsh.exe');
assert.equal(safeCommandPreview('rm -rf /private/value'), 'rm');
assert.equal(safeCommandPreview('"bad name.exe" --token secret'), '本地命令');
assert.equal(
  safeFileChangePreview([{ path: 'C:\\workspace\\server.mjs' }, { path: '/workspace/public/app.js' }]),
  '修改 2 个文件：server.mjs、app.js',
);
assert.equal(safePreviewText('  many\n spaces  ', 20), 'many spaces');
assert.equal(safePreviewText('abcdefghijklmnopqrstuvwxyz', 8), 'abcdefgh…');

console.log(JSON.stringify({ passed: true, sanitizers: 6 }));
