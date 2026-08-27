# QuickLogin engine installer: register Native Messaging host
# Usage: run in packages/engine (or anywhere; script locates itself)
# Prereq: `npm run build` has produced dist/engine.cjs

$ErrorActionPreference = 'Stop'

$engineDir = $PSScriptRoot
$distDir = Join-Path $engineDir 'dist'
$hostName = 'com.quicklogin.engine'
$extId = 'bingdkdlocnmdheghbmpnjilamcbciek'

if (-not (Test-Path (Join-Path $distDir 'engine.cjs'))) {
    Write-Error 'dist/engine.cjs not found. Run npm run build first.'
    exit 1
}

# 1. engine-host.bat (native messaging host entry: run engine.cjs with node)
$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) {
    Write-Error 'node not found in PATH. Install Node.js or place runtime/node.exe first.'
    exit 1
}
$batLines = @(
    '@echo off',
    'if exist "%~dp0runtime\node.exe" (',
    '  "%~dp0runtime\node.exe" "%~dp0engine.cjs"',
    ') else (',
    "  `"$nodeExe`" `"%~dp0engine.cjs`"",
    ')'
)
$batPath = Join-Path $distDir 'engine-host.bat'
[System.IO.File]::WriteAllText($batPath, ($batLines -join "`r`n") + "`r`n", [System.Text.Encoding]::ASCII)

# 2. native messaging host manifest
$manifest = @{
    name            = $hostName
    description     = 'QuickLogin local engine: parallel multi-account browser orchestration'
    path            = (Join-Path $distDir 'engine-host.bat')
    type            = 'stdio'
    allowed_origins = @("chrome-extension://$extId/")
}
$manifestPath = Join-Path $distDir 'com.quicklogin.engine.json'
$manifest | ConvertTo-Json | Set-Content -Path $manifestPath -Encoding Utf8

# 3. registry (HKCU)
$regPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
New-Item -Path $regPath -Force | Out-Null
Set-ItemProperty -Path $regPath -Name '(default)' -Value $manifestPath

Write-Host "QuickLogin engine registered (extension id: $extId)"
Write-Host "NM manifest: $manifestPath"