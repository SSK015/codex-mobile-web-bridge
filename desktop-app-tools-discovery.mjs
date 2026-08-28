import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PIPE_PREFIX = '\\\\.\\pipe\\';
const BROWSER_USE_RE = /(?:^|[\s"'=\\])codex-browser-use-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?=$|[\s"'\\])/i;

function normalized(value) {
  return typeof value === 'string' ? value.replaceAll('/', '\\').toLowerCase() : '';
}

function isPackagedCodexExecutable(executablePath, localAppData) {
  if (!executablePath || !localAppData) return false;
  const root = normalized(path.win32.join(localAppData, 'OpenAI', 'Codex', 'bin'));
  const candidate = normalized(path.win32.normalize(executablePath));
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}\\\\[0-9a-f]+\\\\codex\\.exe$`, 'i').test(candidate);
}

function isInstalledChatGpt(candidateProcess, localAppData) {
  if (String(candidateProcess?.Name ?? '').toLowerCase() !== 'chatgpt.exe') return false;
  const executable = normalized(candidateProcess?.ExecutablePath);
  if (!executable.endsWith('\\chatgpt.exe')) return false;
  const localInstall = normalized(path.win32.join(localAppData ?? '', 'OpenAI', 'Codex'));
  const windowsApps = normalized(path.win32.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'WindowsApps'));
  return (localInstall && executable.startsWith(`${localInstall}\\`))
    || executable.startsWith(`${windowsApps}\\`);
}

export async function queryWindowsProcesses() {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$processes = Get-CimInstance Win32_Process | Select-Object Name,ProcessId,ParentProcessId,SessionId,ExecutablePath,CommandLine',
    '[pscustomobject]@{ currentSessionId = (Get-Process -Id $PID).SessionId; processes = $processes } | ConvertTo-Json -Depth 4 -Compress',
  ].join('; ');
  const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

export async function discoverDesktopAppToolsPipe({
  env = process.env,
  platform = process.platform,
  localAppData = env.LOCALAPPDATA,
  sessionId,
  queryProcesses = queryWindowsProcesses,
} = {}) {
  const explicit = env.CODEX_MOBILE_APP_TOOLS_PIPE?.trim();
  if (explicit) return explicit;
  if (platform !== 'win32') {
    throw new Error('Desktop app tools pipe auto-discovery is only supported on Windows; set CODEX_MOBILE_APP_TOOLS_PIPE explicitly');
  }
  if (!localAppData) throw new Error('LOCALAPPDATA is required to identify the packaged Codex executable');

  const result = await queryProcesses();
  const processes = Array.isArray(result) ? result : result?.processes;
  const currentSessionId = sessionId ?? result?.currentSessionId;
  if (!Array.isArray(processes)) throw new Error('Windows process query returned an invalid process list');
  if (!Number.isInteger(Number(currentSessionId))) throw new Error('Current Windows session ID is unavailable');

  const byPid = new Map(processes.map((process) => [Number(process.ProcessId), process]));
  const candidates = processes.filter((process) => {
    if (String(process.Name ?? '').toLowerCase() !== 'codex.exe') return false;
    if (Number(process.SessionId) !== Number(currentSessionId)) return false;
    if (!isPackagedCodexExecutable(process.ExecutablePath, localAppData)) return false;
    const commandLine = String(process.CommandLine ?? '');
    if (!/(?:^|\s)app-server(?:\s|$)/i.test(commandLine)) return false;
    if (/(?:^|\s)--listen(?:[=\s]|$)/i.test(commandLine)) return false;
    if (!BROWSER_USE_RE.test(commandLine)) return false;
    return isInstalledChatGpt(byPid.get(Number(process.ParentProcessId)), localAppData);
  });

  if (candidates.length !== 1) {
    throw new Error(`Expected exactly one Codex Desktop app-server process in this session; found ${candidates.length}`);
  }
  const match = String(candidates[0].CommandLine).match(BROWSER_USE_RE);
  return `${PIPE_PREFIX}codex-browser-use-${match[1].toLowerCase()}`;
}

export { isPackagedCodexExecutable };
