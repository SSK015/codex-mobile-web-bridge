$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

# Probe only pipe ownership. Never send tool calls to an unverified endpoint.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class CodexMobilePipeOwner {
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint processId);
}
'@

$names = @(Get-ChildItem -LiteralPath '\\.\pipe\' |
    Where-Object { $_.Name -match '^codex-(?:app-tools|browser-use)-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' } |
    Select-Object -ExpandProperty Name -Unique)
# Desktop can retain more than 32 app-tool contexts. Keep enumeration bounded;
# the verified Desktop process owner, not the endpoint count, identifies it.
if ($names.Count -gt 128) { throw 'Too many Desktop app tools pipe candidates; refusing oversized discovery' }
$pipes = @(foreach ($name in $names) {
    $pipe = $null
    try {
        $pipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', $name,
            [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::Asynchronous)
        $pipe.Connect(200)
        [uint32]$ownerId = 0
        if ([CodexMobilePipeOwner]::GetNamedPipeServerProcessId($pipe.SafePipeHandle, [ref]$ownerId)) {
            [pscustomobject]@{ name = $name; ownerPid = $ownerId }
        }
    } catch {
        # Desktop can rotate or close a pipe while it is being inspected.
    } finally {
        if ($null -ne $pipe) { $pipe.Dispose() }
    }
})
$currentSessionId = (Get-Process -Id $PID).SessionId
$processFilter = "SessionId = $currentSessionId AND (Name = 'codex.exe' OR Name = 'chatgpt.exe')"
# The JS verifier needs process roles only. Other arguments can contain
# private paths or credentials and should stay out of the discovery response.
$rolePattern = '(?i)(?<!\S)(?:app-server(?=\s|$)|--listen(?=[=\s]|$)|--type=utility(?=\s|$)|--type(?=[=\s])|--utility-sub-type=node\.mojom\.NodeService(?=\s|$))'
$roleFlags = @{ Name = 'CommandLine'; Expression = {
    $flags = [regex]::Matches([string]$_.CommandLine, $rolePattern) | ForEach-Object { $_.Value }
    ($flags -replace '^--type$', '--type=other') -join ' '
} }
$processes = @(Get-CimInstance Win32_Process -Filter $processFilter |
    Select-Object Name,ProcessId,ParentProcessId,SessionId,ExecutablePath,$roleFlags)
[pscustomobject]@{
    currentSessionId = $currentSessionId
    processes = $processes
    pipes = $pipes
} | ConvertTo-Json -Depth 4 -Compress
