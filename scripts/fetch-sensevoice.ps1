param(
    [string]$Mirror = 'https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dir = Join-Path $root 'vendor\sensevoice\models'
New-Item -ItemType Directory -Path $dir -Force | Out-Null

$files = @{
    'model.int8.onnx' = 'model.int8.onnx'
    'tokens.txt' = 'tokens.txt'
}

foreach ($name in $files.Keys) {
    $file = Join-Path $dir $name
    $min = if ($name -eq 'model.int8.onnx') { 100MB } else { 100KB }
    if ((Test-Path $file) -and ((Get-Item $file).Length -ge $min)) {
        Write-Host "Exists: $file"
        continue
    }
    $url = "$Mirror/$($files[$name])"
    Write-Host "Downloading $url"
    & curl.exe -L --retry 5 --connect-timeout 20 -o $file $url
    if ($LASTEXITCODE -ne 0) { throw "Download failed: $url" }
    if ((Get-Item $file).Length -lt $min) { throw "Downloaded file is incomplete: $file" }
}

Write-Host 'SenseVoice model ready. Build the server with scripts\build-sensevoice-server.ps1 if needed.'
