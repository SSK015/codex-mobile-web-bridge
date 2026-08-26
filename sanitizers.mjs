import path from 'node:path';

export function safeCommandPreview(command) {
  const value = Array.isArray(command) ? command.join(' ') : String(command || '');
  const firstLine = value.split(/\r?\n/, 1)[0].trim();
  const executable = firstLine.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/)?.slice(1).find(Boolean) || '';
  const basename = path.win32.basename(executable.replaceAll('/', '\\')).slice(0, 80);
  return /^[a-zA-Z0-9][a-zA-Z0-9_.+-]{0,79}$/.test(basename) ? basename : '本地命令';
}

export function safeFileChangePreview(changes) {
  const values = Array.isArray(changes) ? changes : [];
  const names = values.slice(0, 3).map((change) => path.win32.basename(String(change?.path || '').replaceAll('/', '\\'))).filter(Boolean);
  return names.length > 0 ? `修改 ${values.length} 个文件：${names.join('、')}${values.length > names.length ? '…' : ''}` : '修改文件';
}

export function safePreviewText(value, limit = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
