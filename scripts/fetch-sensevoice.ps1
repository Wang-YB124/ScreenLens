param(
    [string]$Mirror = 'https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main',
    [string]$NodeVersion = '2.0.1'
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

$nodeDir = Join-Path $root 'vendor\sensevoice\node'
$nativeDir = Join-Path $nodeDir 'node_modules\sherpa-onnx-win-x64'
$nodeEntry = Join-Path $nodeDir 'sherpa-onnx.js'
$nativeEntry = Join-Path $nativeDir 'sherpa-onnx.node'
if (-not (Test-Path $nodeEntry) -or -not (Test-Path $nativeEntry)) {
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("screenlens-svnode-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    try {
        $packages = @(
            @{ Name = 'sherpa-onnx-node'; Url = "https://registry.npmjs.org/sherpa-onnx-node/-/sherpa-onnx-node-$NodeVersion.tgz" },
            @{ Name = 'sherpa-onnx-win-x64'; Url = "https://registry.npmjs.org/sherpa-onnx-win-x64/-/sherpa-onnx-win-x64-$NodeVersion.tgz" }
        )
        foreach ($pkg in $packages) {
            $tgz = Join-Path $tmp "$($pkg.Name).tgz"
            Write-Host "Downloading $($pkg.Url)"
            & curl.exe -L --retry 5 --connect-timeout 20 -o $tgz $pkg.Url
            if ($LASTEXITCODE -ne 0) { throw "Download failed: $($pkg.Url)" }
            $out = Join-Path $tmp $pkg.Name
            New-Item -ItemType Directory -Path $out -Force | Out-Null
            & tar.exe -xzf $tgz -C $out
            if ($LASTEXITCODE -ne 0) { throw "Extract failed: $tgz" }
        }
        New-Item -ItemType Directory -Path $nativeDir -Force | Out-Null
        Copy-Item -Path (Join-Path $tmp 'sherpa-onnx-node\package\*') -Destination $nodeDir -Recurse -Force
        Copy-Item -Path (Join-Path $tmp 'sherpa-onnx-win-x64\package\*') -Destination $nativeDir -Recurse -Force
    } finally {
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}
if (-not (Test-Path $nativeEntry)) { throw 'SenseVoice native runtime is incomplete.' }

Write-Host 'SenseVoice model and runtime ready.'
