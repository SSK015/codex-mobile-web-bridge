import assert from 'node:assert/strict';
import { discoverDesktopAppToolsPipe, isPackagedCodexExecutable } from '../desktop-app-tools-discovery.mjs';

const localAppData = 'C:\\Users\\alice\\AppData\\Local';
const uuid = '12345678-1234-4234-9234-123456789abc';
const parent = {
  Name: 'ChatGPT.exe', ProcessId: 100, ParentProcessId: 1, SessionId: 7,
  ExecutablePath: `${localAppData}\\OpenAI\\Codex\\ChatGPT.exe`, CommandLine: 'ChatGPT.exe',
};
const child = {
  Name: 'codex.exe', ProcessId: 101, ParentProcessId: 100, SessionId: 7,
  ExecutablePath: `${localAppData}\\OpenAI\\Codex\\bin\\a1b2c3d4\\codex.exe`,
  CommandLine: `"codex.exe" app-server --codex-browser-use-pipe-name codex-browser-use-${uuid}`,
};
const discover = (processes, options = {}) => discoverDesktopAppToolsPipe({
  platform: 'win32', env: {}, localAppData, sessionId: 7, queryProcesses: async () => processes, ...options,
});

assert.equal(await discoverDesktopAppToolsPipe({
  platform: 'linux', env: { CODEX_MOBILE_APP_TOOLS_PIPE: '/tmp/explicit.sock' },
  queryProcesses: () => assert.fail('explicit value must bypass discovery'),
}), '/tmp/explicit.sock');
await assert.rejects(discoverDesktopAppToolsPipe({ platform: 'darwin', env: {} }), /only supported on Windows/);

assert.equal(isPackagedCodexExecutable(child.ExecutablePath, localAppData), true);
assert.equal(isPackagedCodexExecutable(`${localAppData}\\OpenAI\\Codex\\bin\\not-hex\\codex.exe`, localAppData), false);
assert.equal(await discover([parent, child]), `\\\\.\\pipe\\codex-browser-use-${uuid}`);

await assert.rejects(discover([parent, { ...child, CommandLine: `${child.CommandLine} --listen 127.0.0.1:9999` }]), /found 0/);
await assert.rejects(discover([parent, { ...child, SessionId: 8 }]), /found 0/);
await assert.rejects(discover([parent, { ...child, ExecutablePath: 'C:\\Tools\\codex.exe' }]), /found 0/);
await assert.rejects(discover([{ ...parent, Name: 'explorer.exe' }, child]), /found 0/);
await assert.rejects(discover([parent, child, { ...child, ProcessId: 102 }]), /found 2/);
await assert.rejects(discover([parent, { ...child, CommandLine: 'codex.exe app-server' }]), /found 0/);
await assert.rejects(discoverDesktopAppToolsPipe({
  platform: 'win32', env: {}, localAppData, queryProcesses: async () => [parent, child],
}), /session ID is unavailable/);

console.log('desktop app tools discovery tests passed');
