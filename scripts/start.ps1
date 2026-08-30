param(
    [string]$StateDir = $(if ($env:CODEX_MOBILE_STATE_DIR) { $env:CODEX_MOBILE_STATE_DIR } else { Join-Path $env:LOCALAPPDATA 'CodexMobileWeb' })
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = Get-Command node -ErrorAction Stop

if (-not $env:CODEX_MOBILE_DESKTOP_CONTROL -and -not $env:CODEX_MOBILE_APP_SERVER_URL) {
    $env:CODEX_MOBILE_DESKTOP_CONTROL = '1'
}

if (-not $env:CODEX_MOBILE_APP_SERVER_URL -and $env:CODEX_MOBILE_DESKTOP_CONTROL -ne '1') {
    $codex = if ($env:CODEX_MOBILE_CODEX_PATH) {
        Get-Item -LiteralPath $env:CODEX_MOBILE_CODEX_PATH
    } else {
        Get-Command codex.exe, codex -ErrorAction SilentlyContinue | Select-Object -First 1
    }
    if (-not $codex) { throw 'Codex was not found. Install and sign in to Codex, or set CODEX_MOBILE_CODEX_PATH.' }
    $codexPath = if ($codex.PSObject.Properties.Name -contains 'Source' -and $codex.Source) { $codex.Source } else { $codex.FullName }
    $env:CODEX_MOBILE_CODEX_PATH = [string]$codexPath
}

New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
$secretFile = Join-Path $StateDir 'secret.txt'
if (-not (Test-Path -LiteralPath $secretFile)) {
    $bytes = [byte[]]::new(32)
    $random = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $random.GetBytes($bytes) } finally { $random.Dispose() }
    [IO.File]::WriteAllText($secretFile, [Convert]::ToBase64String($bytes))
    Write-Host "Created a bridge password at $secretFile"
}

$env:CODEX_MOBILE_SECRET_FILE = $secretFile
$env:CODEX_MOBILE_SEEN_FILE = Join-Path $StateDir 'seen-threads.json'
$env:CODEX_MOBILE_THREAD_LIST_CACHE_FILE = Join-Path $StateDir 'thread-list-cache.json'
$env:CODEX_MOBILE_UPLOAD_ROOT = Join-Path $StateDir 'uploads'
if (-not $env:CODEX_MOBILE_HOST) { $env:CODEX_MOBILE_HOST = '127.0.0.1' }
if (-not $env:CODEX_MOBILE_PORT) { $env:CODEX_MOBILE_PORT = '4780' }

Set-Location -LiteralPath $root
& $node.Source .\server.mjs
