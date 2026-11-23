import assert from 'node:assert/strict';
import { discoverDesktopAppToolsPipe, isPackagedCodexExecutable } from '../desktop-app-tools-discovery.mjs';

const localAppData = 'C:\\Fixtures\\LocalAppData';
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
const livePipe = { name: `codex-browser-use-${uuid}`, ownerPid: parent.ProcessId };
const discover = (processes, options = {}) => discoverDesktopAppToolsPipe({
  platform: 'win32', env: {}, localAppData, sessionId: 7,
  queryProcesses: async () => ({ processes, pipes: [livePipe] }), ...options,
});

assert.equal(await discoverDesktopAppToolsPipe({
  platform: 'linux', env: { CODEX_MOBILE_APP_TOOLS_PIPE: '/tmp/explicit.sock' },
  queryProcesses: () => assert.fail('explicit value must bypass discovery'),
}), '/tmp/explicit.sock');
await assert.rejects(discoverDesktopAppToolsPipe({ platform: 'darwin', env: {} }), /only supported on Windows/);

assert.equal(isPackagedCodexExecutable(child.ExecutablePath, localAppData), true);
assert.equal(isPackagedCodexExecutable(`${localAppData}\\OpenAI\\Codex\\bin\\not-hex\\codex.exe`, localAppData), false);
assert.equal(await discover([parent, child]), `\\\\.\\pipe\\codex-browser-use-${uuid}`);

const storePackage = `${process.env.ProgramFiles || 'C:\\Program Files'}\\WindowsApps\\OpenAI.Codex_26.1103.4239.0_x64__2p2nqsd0c76g0`;
const storeParent = { ...parent, ExecutablePath: `${storePackage}\\app\\ChatGPT.exe` };
const storeChild = { ...child, ExecutablePath: `${storePackage}\\app\\resources\\codex.exe` };
assert.equal(isPackagedCodexExecutable(storeChild.ExecutablePath, localAppData), true);
assert.equal(await discover([storeParent, storeChild]), `\\\\.\\pipe\\codex-browser-use-${uuid}`);
await assert.rejects(discover([storeParent, {
  ...storeChild, CommandLine: `${child.CommandLine} --listen 127.0.0.1:9999`,
}]), /found 0/);
for (const executable of [
  'C:\\Downloads\\OpenAI.Codex_26.1103\\app\\resources\\codex.exe',
  `${storePackage}\\app\\codex.exe`,
  `${storePackage}\\app\\resources\\other\\codex.exe`,
  storeChild.ExecutablePath.replace('OpenAI.Codex_', 'Other.App_'),
]) {
  assert.equal(isPackagedCodexExecutable(executable, localAppData), false);
}

await assert.rejects(discover([parent, { ...child, CommandLine: `${child.CommandLine} --listen 127.0.0.1:9999` }]), /found 0/);
await assert.rejects(discover([parent, { ...child, SessionId: 8 }]), /found 0/);
await assert.rejects(discover([parent, { ...child, ExecutablePath: 'C:\\Tools\\codex.exe' }]), /found 0/);
await assert.rejects(discover([{ ...parent, Name: 'explorer.exe' }, child]), /found 0/);
await assert.rejects(discover([parent, child, { ...child, ProcessId: 102 }]), /found 2/);
assert.equal(await discover([parent, { ...child, CommandLine: 'codex.exe app-server' }]), `\\\\.\\pipe\\${livePipe.name}`,
  'new Desktop no longer exposes pipe name on the app-server command line');
await assert.rejects(discoverDesktopAppToolsPipe({
  platform: 'win32', env: {}, localAppData, queryProcesses: async () => [parent, child],
}), /session ID is unavailable/);

const stalePipe = '\\\\.\\pipe\\codex-browser-use-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
assert.equal(await discover([parent, child], { env: { CODEX_MOBILE_APP_TOOLS_PIPE: stalePipe } }), `\\\\.\\pipe\\${livePipe.name}`,
  'a stale inherited explicit Desktop pipe must not win over live owner discovery');
assert.equal(await discover([parent, child], { env: { CODEX_APP_TOOLS_PIPE_PATH: stalePipe } }), `\\\\.\\pipe\\${livePipe.name}`);
await assert.rejects(discover([parent, child], {
  queryProcesses: async () => ({ processes: [parent, child], pipes: [{ ...livePipe, ownerPid: 999 }] }),
}), /found 0/);
await assert.rejects(discover([{ ...parent, SessionId: 8 }, child]), /found 0/);
await assert.rejects(discover([{ ...parent, ExecutablePath: 'C:\\Program Files\\WindowsApps\\Other.App_1\\app\\ChatGPT.exe' }, child]), /found 0/);
await assert.rejects(discover([parent, child], {
  env: { CODEX_MOBILE_APP_TOOLS_PIPE: stalePipe },
  queryProcesses: async () => ({ processes: [parent, child], pipes: [] }),
}), /found 0/);
assert.equal(await discover([parent, child], {
  queryProcesses: async () => ({ processes: [parent, child], pipes: [livePipe, livePipe] }),
}), `\\\\.\\pipe\\${livePipe.name}`, 'duplicate named pipe instances are deduplicated');

const secondPipe = { ...livePipe, name: 'codex-browser-use-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
const multiple = { processes: [parent, child], pipes: [livePipe, secondPipe, { ...livePipe, name: 'codex-browser-use-cccccccc-cccc-4ccc-8ccc-cccccccccccc', ownerPid: 999 }] };
assert.equal(await discover([parent, child], {
  env: { CODEX_MOBILE_APP_TOOLS_PIPE: stalePipe }, queryProcesses: async () => multiple,
}), `\\\\.\\pipe\\${livePipe.name}`);
assert.equal(await discover([parent, child], {
  env: { CODEX_APP_TOOLS_PIPE_PATH: `\\\\.\\pipe\\${livePipe.name}` },
  excludePaths: [`\\\\.\\pipe\\${livePipe.name}`], queryProcesses: async () => multiple,
}), `\\\\.\\pipe\\${secondPipe.name}`, 'a failed live-looking hint must not starve another verified endpoint');
assert.equal(await discover([parent, child], {
  excludePaths: [`\\\\.\\pipe\\${livePipe.name}`, `\\\\.\\pipe\\${secondPipe.name}`], queryProcesses: async () => multiple,
}), `\\\\.\\pipe\\${livePipe.name}`, 'retry a new discovery cycle once all verified candidates have failed');

// Desktop 26.1013 separates control tools from browser-use endpoints.
const appToolsPipe = { name: `codex-app-tools-${uuid}`, ownerPid: parent.ProcessId };
const appToolsPath = `\\\\.\\pipe\\${appToolsPipe.name}`;
const staleAppToolsPath = '\\\\.\\pipe\\codex-app-tools-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const separated = { processes: [parent, child], pipes: [livePipe, appToolsPipe] };
const utility = { ...storeParent, ProcessId: 105, ParentProcessId: storeParent.ProcessId,
  CommandLine: 'ChatGPT.exe --type=utility --utility-sub-type=node.mojom.NodeService' };
const utilityChild = { ...storeChild, ParentProcessId: utility.ProcessId };
const throughUtility = (main, pipes = [appToolsPipe]) => discover([], {
  queryProcesses: async () => ({ processes: [main, utility, utilityChild], pipes }),
});
assert.equal(await throughUtility(storeParent), appToolsPath);
await assert.rejects(throughUtility({ ...storeParent, SessionId: 8 }), /verify/);
await assert.rejects(throughUtility({ ...storeParent, ExecutablePath: parent.ExecutablePath }), /verify/);
await assert.rejects(throughUtility(storeParent, [{ ...appToolsPipe, ownerPid: utility.ProcessId }]), /found 0/);
assert.equal(await discover([parent, child], {
  queryProcesses: async () => separated,
}), appToolsPath, 'prefer the dedicated control endpoint when no hint is available');
assert.equal(await discover([parent, child], {
  env: { CODEX_APP_TOOLS_PIPE_PATH: appToolsPath }, queryProcesses: async () => separated,
}), appToolsPath);
assert.equal(await discover([parent, child], {
  env: { CODEX_MOBILE_APP_TOOLS_PIPE: staleAppToolsPath }, queryProcesses: async () => separated,
}), appToolsPath, 'a stale dedicated control endpoint is a hint, not a pinned custom endpoint');
await assert.rejects(discover([parent, child], {
  env: { CODEX_MOBILE_APP_TOOLS_PIPE: appToolsPath },
  queryProcesses: async () => ({ processes: [parent, child], pipes: [{ ...appToolsPipe, ownerPid: 999 }] }),
}), /found 0/, 'dedicated endpoints still require the verified Desktop owner');
assert.equal(await discover([parent, child], {
  env: { CODEX_APP_TOOLS_PIPE_PATH: appToolsPath }, excludePaths: [appToolsPath],
  queryProcesses: async () => separated,
}), appToolsPath, 'retry the dedicated endpoint after a transient failure instead of probing incompatible browser pipes');

for (const hint of ['CODEX_MOBILE_APP_TOOLS_PIPE', 'CODEX_APP_TOOLS_PIPE_PATH']) {
  assert.equal(await discover([parent, child], {
    env: { [hint]: `\\\\.\\pipe\\${livePipe.name}` }, queryProcesses: async () => separated,
  }), appToolsPath, 'an inherited browser-use hint cannot override a dedicated control endpoint');
}

const browserContexts = Array.from({ length: 36 }, (_, index) => ({
  name: `codex-browser-use-${String(index).padStart(8, '0')}-1234-4234-9234-123456789abc`, ownerPid: parent.ProcessId,
}));
const manyContexts = { processes: [parent, child], pipes: [...browserContexts, appToolsPipe] };
for (let retry = 0; retry < 4; retry++) {
  assert.equal(await discover([parent, child], {
    env: { CODEX_APP_TOOLS_PIPE_PATH: `\\\\.\\pipe\\${browserContexts[retry].name}` },
    excludePaths: [appToolsPath], queryProcesses: async () => manyContexts,
  }), appToolsPath, 'dedicated recovery never detours through 36 browser contexts');
}

const rotatedToolsPipe = { ...appToolsPipe, name: 'codex-app-tools-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
const rotatedToolsPath = `\\\\.\\pipe\\${rotatedToolsPipe.name}`;
const multipleDedicated = { ...separated, pipes: [...separated.pipes, rotatedToolsPipe] };
assert.equal(await discover([parent, child], {
  excludePaths: [appToolsPath], queryProcesses: async () => multipleDedicated,
}), rotatedToolsPath, 'another verified dedicated endpoint is still tried after a failed handshake');
assert.equal(await discover([parent, child], {
  excludePaths: [appToolsPath, rotatedToolsPath], queryProcesses: async () => multipleDedicated,
}), appToolsPath, 'an exhausted dedicated pool starts a new cycle without falling back to browser-use');
assert.equal(await discover([parent, child], {
  excludePaths: [appToolsPath],
  queryProcesses: async () => ({ ...separated, pipes: [livePipe] }),
}), `\\\\.\\pipe\\${livePipe.name}`, 'legacy discovery works when the verified owner has no dedicated endpoint');

console.log('desktop app tools discovery tests passed');
