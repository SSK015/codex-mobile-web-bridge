import assert from 'node:assert/strict';
import { buildTurnInput } from '../turn-input.mjs';

const input = buildTurnInput('分析这两个附件', [
  { name: '报告.pdf', path: 'C:\\uploads\\report.pdf', isImage: false },
  { name: '截图.png', path: 'C:\\uploads\\screen.png', isImage: true },
]);

assert.deepEqual(input.map((item) => item.type), ['text', 'localImage', 'mention']);
assert.ok(input[0].text.startsWith('# Files mentioned by the user:'));
assert.ok(input[0].text.includes('## 报告.pdf: C:\\uploads\\report.pdf'));
assert.ok(input[0].text.includes('## My request:\n分析这两个附件'));
assert.equal(input[1].path, 'C:\\uploads\\screen.png');
assert.equal(input[2].name, '报告.pdf');

const fileOnly = buildTurnInput('', [
  { name: '说明.txt', path: 'C:\\uploads\\readme.txt', isImage: false },
]);
assert.ok(fileOnly[0].text.endsWith('## My request:\n请查看我上传的附件。'));

const imageOnly = buildTurnInput('', [
  { name: '截图.png', path: 'C:\\uploads\\screen.png', isImage: true },
]);
assert.equal(imageOnly[0].text, '请查看我上传的附件。');

console.log(JSON.stringify({
  passed: true,
  mixedTypes: input.map((item) => item.type),
  fileEnvelope: true,
  imageNativeInput: true,
}));
