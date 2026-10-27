param([string]$Version = '38.2.1')

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$vendor = Join-Path $root 'vendor'
$dest = Join-Path $vendor 'electron'

if (Test-Path (Join-Path $dest 'electron.exe')) {
    Write-Host "Electron already present at $dest"
    exit 0
}

$zip = Join-Path $env:TEMP "electron-v$Version-win32-x64.zip"
$url = "https://github.com/electron/electron/releases/download/v$Version/electron-v$Version-win32-x64.zip"

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Write-Host "Downloading Electron $Version..."
Write-Host $url
Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing

New-Item -ItemType Directory -Path $dest -Force | Out-Null
Expand-Archive -Path $zip -DestinationPath $dest -Force
Remove-Item -LiteralPath $zip -Force

if (-not (Test-Path (Join-Path $dest 'electron.exe'))) {
    throw 'Electron download did not contain electron.exe.'
}
Write-Host "Electron $Version ready at $dest"
