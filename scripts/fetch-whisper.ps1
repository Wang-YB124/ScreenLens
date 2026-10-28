$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$base = Join-Path $root 'vendor\whisper'
$runtime = Join-Path $base 'runtime'
$models = Join-Path $base 'models'
New-Item -ItemType Directory -Path $runtime, $models -Force | Out-Null

$zip = Join-Path $env:TEMP 'whisper-blas-bin-x64.zip'
$binUrl = 'https://gh-proxy.com/https://github.com/ggerganov/whisper.cpp/releases/download/b5454/whisper-blas-bin-x64.zip'

if (-not (Test-Path (Join-Path $runtime 'whisper-cli.exe'))) {
    Write-Host 'Downloading whisper.cpp BLAS runtime...'
    curl.exe -L --fail --retry 3 --max-time 900 -o $zip $binUrl
    $tmp = Join-Path $env:TEMP ('whisper-bin-' + [guid]::NewGuid().ToString('N'))
    Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
    $release = Get-ChildItem -Path $tmp -Recurse -Directory -Filter 'Release' | Select-Object -First 1
    if (-not $release) { throw 'Release folder not found in whisper archive.' }
    Copy-Item -Path (Join-Path $release.FullName 'whisper-cli.exe') -Destination $runtime -Force
    if (Test-Path (Join-Path $release.FullName 'whisper-server.exe')) {
        Copy-Item -Path (Join-Path $release.FullName 'whisper-server.exe') -Destination $runtime -Force
    }
    Copy-Item -Path (Join-Path $release.FullName 'whisper.dll') -Destination $runtime -Force
    Copy-Item -Path (Join-Path $release.FullName 'ggml*.dll') -Destination $runtime -Force
    Copy-Item -Path (Join-Path $release.FullName 'libopenblas.dll') -Destination $runtime -Force
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
}

$modelUrls = [ordered]@{
    'ggml-base-q5_1.bin'  = 'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin'
    'ggml-small-q5_1.bin' = 'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin'
}
$minimum = @{
    'ggml-base-q5_1.bin'  = 40MB
    'ggml-small-q5_1.bin' = 150MB
}
foreach ($name in $modelUrls.Keys) {
    $target = Join-Path $models $name
    if ((Test-Path $target) -and ((Get-Item $target).Length -ge $minimum[$name])) {
        Write-Host "Model already present: $name"
        continue
    }
    Write-Host "Downloading model $name (this can take a few minutes)..."
    curl.exe -L --fail --retry 3 --max-time 1800 -o $target $modelUrls[$name]
}

Write-Host 'Whisper runtime ready:'
Get-ChildItem -LiteralPath $runtime | Select-Object Name, Length | Format-Table -AutoSize
Get-ChildItem -LiteralPath $models | Select-Object Name, Length | Format-Table -AutoSize
Write-Host 'The release build copies vendor\whisper into resources\app\vendor\whisper.'
