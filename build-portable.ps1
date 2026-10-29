param([string]$Output = 'dist\ScreenLens')

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$electron = Join-Path $root 'vendor\electron'
$dist = if ([IO.Path]::IsPathRooted($Output)) { $Output } else { Join-Path $root $Output }
$exe = Join-Path $dist 'electron.exe'

if (-not (Test-Path (Join-Path $electron 'electron.exe'))) {
    throw 'Electron runtime not found in vendor\electron.'
}

if (Test-Path $dist) {
    Remove-Item -LiteralPath $dist -Recurse -Force
}
New-Item -ItemType Directory -Path $dist -Force | Out-Null
Get-ChildItem -LiteralPath $electron -Force | Where-Object { $_.Name -ne 'resources' } | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $dist -Recurse -Force
}
$resDir = Join-Path $dist 'resources'
if (-not (Test-Path $resDir)) { New-Item -ItemType Directory -Path $resDir -Force | Out-Null }
$srcRes = Join-Path $electron 'resources'
if (Test-Path $srcRes) {
    Get-ChildItem -LiteralPath $srcRes -Force | Where-Object { $_.Name -ne 'default_app.asar' } | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $resDir -Recurse -Force
    }
}
Rename-Item -LiteralPath $exe -NewName 'ScreenLens.exe'

$localeDir = Join-Path $dist 'locales'
if (Test-Path $localeDir) {
    $keepLocales = @('zh-CN.pak', 'zh-TW.pak', 'en-US.pak', 'en-GB.pak')
    Get-ChildItem -LiteralPath $localeDir -File | Where-Object { $_.Name -notin $keepLocales } | Remove-Item -Force
}

$appDir = Join-Path $dist 'resources\app'
New-Item -ItemType Directory -Path $appDir | Out-Null
Copy-Item -Path (Join-Path $root 'src') -Destination $appDir -Recurse -Force
Copy-Item -Path (Join-Path $root 'assets') -Destination $appDir -Recurse -Force
Copy-Item -Path (Join-Path $root 'package.json') -Destination $appDir -Force
Remove-Item -LiteralPath (Join-Path $appDir 'assets\make-icons.py') -ErrorAction SilentlyContinue

$whisper = Join-Path $root 'vendor\whisper'
if (Test-Path $whisper) {
    $target = Join-Path $appDir 'vendor\whisper'
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    $srcRuntime = Join-Path $whisper 'runtime'
    if (Test-Path $srcRuntime) {
        Copy-Item -LiteralPath $srcRuntime -Destination $target -Recurse -Force
    }
    $srcModels = Join-Path $whisper 'models'
    if (Test-Path $srcModels) {
        $modelTarget = Join-Path $target 'models'
        New-Item -ItemType Directory -Path $modelTarget -Force | Out-Null
        foreach ($name in @('ggml-base-q5_1.bin')) {
            $file = Join-Path $srcModels $name
            if (Test-Path $file) {
                Copy-Item -LiteralPath $file -Destination $modelTarget -Force
            }
        }
    }
    foreach ($name in @('libopenblas.dll', 'ggml-blas.dll')) {
        $file = Join-Path $target "runtime\$name"
        if (Test-Path $file) {
            Remove-Item -LiteralPath $file -Force
        }
    }
}

$sensevoice = Join-Path $root 'vendor\sensevoice'
if (Test-Path $sensevoice) {
    $target = Join-Path $appDir 'vendor\sensevoice'
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    foreach ($name in @('node', 'models')) {
        $source = Join-Path $sensevoice $name
        if (Test-Path $source) {
            Copy-Item -LiteralPath $source -Destination $target -Recurse -Force
        }
    }
}

$licenses = Join-Path $root 'licenses'
if (Test-Path $licenses) {
    $target = Join-Path $dist 'licenses'
    New-Item -ItemType Directory -Path $target | Out-Null
    $legacy = @('python-LICENSE.txt', 'pyinstaller-LICENSE.txt')
    Get-ChildItem -LiteralPath $licenses -File | Where-Object { $_.Name -notin $legacy } | Copy-Item -Destination $target -Force
}

$releaseDocs = Join-Path $root 'release'
if (Test-Path $releaseDocs) {
    Copy-Item -Path (Join-Path $releaseDocs '*') -Destination $dist -Force
}

$rcedit = Join-Path $root 'vendor\rcedit.exe'
if (Test-Path $rcedit) {
    & $rcedit (Join-Path $dist 'ScreenLens.exe') `
        --set-icon (Join-Path $root 'assets\icon.ico') `
        --set-file-version '1.1.2.0' `
        --set-product-version '1.1.2.0' `
        --set-version-string 'ProductName' 'ScreenLens' `
        --set-version-string 'FileDescription' 'ScreenLens - instant screen translation and explanation' `
        --set-version-string 'CompanyName' 'ScreenLens' `
        --set-version-string 'LegalCopyright' 'ScreenLens'
    if ($LASTEXITCODE -ne 0) {
        Write-Warning 'rcedit failed; the exe keeps the default Electron icon.'
    }
}

$size = [math]::Round(((Get-ChildItem $dist -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 1)
Write-Host "Portable build ready: $dist ($size MB)"
