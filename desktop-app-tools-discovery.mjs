import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const PIPE_PREFIX = '\\\\.\\pipe\\';
const PIPE_NAME_RE = /^codex-(?:app-tools|browser-use)-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalized(value) {
  return typeof value === 'string' ? value.replaceAll('/', '\\').toLowerCase() : '';
}

function isPackagedCodexExecutable(executablePath, localAppData) {
  if (!executablePath || !localAppData) return false;
  const root = normalized(path.win32.join(localAppData, 'OpenAI', 'Codex', 'bin'));
  const candidate = normalized(path.win32.normalize(executablePath));
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`^${escaped}\\\\[0-9a-f]+\\\\codex\\.exe$`, 'i').test(candidate)) return true;
  const windowsApps = normalized(path.win32.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'WindowsApps'));
  return candidate.startsWith(`${windowsApps}\\openai.codex_`)
    && /^openai\.codex_[^\\]+\\app\\resources\\codex\.exe$/i.test(candidate.slice(windowsApps.length + 1));
}

function isInstalledChatGpt(candidateProcess, localAppData) {
  if (String(candidateProcess?.Name ?? '').toLowerCase() !== 'chatgpt.exe') return false;
  const executable = normalized(candidateProcess?.ExecutablePath);
  if (!executable.endsWith('\\chatgpt.exe')) return false;
  const localInstall = normalized(path.win32.join(localAppData ?? '', 'OpenAI', 'Codex'));
  const windowsApps = normalized(path.win32.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'WindowsApps'));
  return executable === `${localInstall}\\chatgpt.exe`
    || executable === `${localInstall}\\app\\chatgpt.exe`
    || (executable.startsWith(`${windowsApps}\\openai.codex_`)
      && /^openai\.codex_[^\\]+\\app\\chatgpt\.exe$/i.test(executable.slice(windowsApps.length + 1)));
}

export async function queryWindowsProcesses() {
  const script = fileURLToPath(new URL('./scripts/query-desktop-app-tools.ps1', import.meta.url));
  const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 12_000,
  });
  return JSON.parse(stdout);
}

export async function discoverDesktopAppToolsPipe({
  env = process.env,
  platform = process.platform,
  localAppData = env.LOCALAPPDATA,
  sessionId,
  queryProcesses = queryWindowsProcesses,
  excludePaths = [],
} = {}) {
  const explicit = env.CODEX_MOBILE_APP_TOOLS_PIPE?.trim();
  // Custom test/operator endpoints remain pinned. Desktop-generated addresses
  // are only hints: the Desktop process can replace them at any time.
  const desktopPrefixes = ['codex-app-tools-', 'codex-browser-use-'];
  if (explicit && (platform !== 'win32' || !desktopPrefixes.some((prefix) => normalized(explicit).startsWith(`${PIPE_PREFIX}${prefix}`)))) return explicit;
  if (platform !== 'win32') {
    throw new Error('Desktop app tools pipe auto-discovery is only supported on Windows; set CODEX_MOBILE_APP_TOOLS_PIPE explicitly');
  }
  if (!localAppData) throw new Error('LOCALAPPDATA is required to identify the packaged Codex executable');

  const result = await queryProcesses();
  const processes = Array.isArray(result) ? result : result?.processes;
  const currentSessionId = sessionId ?? result?.currentSessionId;
  if (!Array.isArray(processes)) throw new Error('Windows process query returned an invalid process list');
  if (currentSessionId == null || !Number.isInteger(Number(currentSessionId))) throw new Error('Current Windows session ID is unavailable');

  const byPid = new Map(processes.map((process) => [Number(process.ProcessId), process]));
  const candidates = processes.filter((process) => {
    if (String(process.Name ?? '').toLowerCase() !== 'codex.exe') return false;
    if (Number(process.SessionId) !== Number(currentSessionId)) return false;
    if (!isPackagedCodexExecutable(process.ExecutablePath, localAppData)) return false;
    const commandLine = String(process.CommandLine ?? '');
    if (!/(?:^|\s)app-server(?:\s|$)/i.test(commandLine)) return false;
    if (/(?:^|\s)--listen(?:[=\s]|$)/i.test(commandLine)) return false;
    const parent = byPid.get(Number(process.ParentProcessId));
    return Number(parent?.SessionId) === Number(currentSessionId) && isInstalledChatGpt(parent, localAppData);
  });

  if (candidates.length !== 1) {
    throw new Error(`Expected exactly one Codex Desktop app-server process in this session; found ${candidates.length}`);
  }
  const parent = byPid.get(Number(candidates[0].ParentProcessId));
  let ownerPid = Number(parent.ProcessId);
  // Desktop 26.1117 launches app-server from its Node utility process.
  // The main Desktop process still owns the control pipe.
  if (/(?:^|\s)--type=utility(?:\s|$)/i.test(parent.CommandLine ?? '')
    && /(?:^|\s)--utility-sub-type=node\.mojom\.NodeService(?:\s|$)/i.test(parent.CommandLine ?? '')) {
    const main = byPid.get(Number(parent.ParentProcessId));
    if (!isInstalledChatGpt(main, localAppData)
      || Number(main.SessionId) !== Number(currentSessionId)
      || normalized(main.ExecutablePath) !== normalized(parent.ExecutablePath)
      || /(?:^|\s)--type(?:=|\s)/i.test(main.CommandLine ?? '')) {
      throw new Error('Unable to verify the Desktop main process for its Node utility');
    }
    ownerPid = Number(main.ProcessId);
  }
  const pipes = [...new Set((result?.pipes ?? [])
    .filter((pipe) => PIPE_NAME_RE.test(pipe?.name ?? '') && Number(pipe.ownerPid) === ownerPid)
    .map((pipe) => `${PIPE_PREFIX}${pipe.name.toLowerCase()}`))];
  if (!pipes.length) throw new Error('No verified Desktop app tools pipe is available; found 0');
  // Modern Desktop's browser-use pipes do not implement tools/list. A transient
  // control-pipe failure must not send recovery through every browser context.
  // Retain legacy discovery only when this verified owner has no dedicated pipe.
  const dedicated = pipes.filter((pipe) => pipe.startsWith(`${PIPE_PREFIX}codex-app-tools-`));
  const compatible = dedicated.length ? dedicated : pipes;
  const ordered = [...new Set([
    ...[explicit, env.CODEX_APP_TOOLS_PIPE_PATH].map((hint) => compatible.find((pipe) => normalized(pipe) === normalized(hint))).filter(Boolean),
    ...compatible.sort(),
  ])];
  // A Desktop process may expose several app-scoped endpoints. Only consider
  // the single verified Desktop owner above; the client must then complete a
  // read-only tools/list handshake before reporting readiness. Move past a
  // failed candidate on the next bounded connection attempt.
  const excluded = new Set(excludePaths.map(normalized));
  return ordered.find((pipe) => !excluded.has(normalized(pipe)))
    ?? excludePaths.map((failed) => ordered.find((pipe) => normalized(pipe) === normalized(failed))).find(Boolean)
    ?? ordered[0];
}

export { isPackagedCodexExecutable };
