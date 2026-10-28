param(
    [string]$Python = 'python',
    [string]$Index = 'https://pypi.tuna.tsinghua.edu.cn/simple'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$venv = Join-Path $root '.venv-sensevoice'
$server = Join-Path $root 'vendor\sensevoice\server'
$work = Join-Path $root 'test\tmp\sv-build'

if (-not (Test-Path (Join-Path $venv 'Scripts\python.exe'))) {
    & $Python -m venv $venv
}
& (Join-Path $venv 'Scripts\python.exe') -m pip install --upgrade pip -i $Index
& (Join-Path $venv 'Scripts\python.exe') -m pip install sherpa-onnx numpy pyinstaller -i $Index

New-Item -ItemType Directory -Path $work -Force | Out-Null
& (Join-Path $venv 'Scripts\pyinstaller.exe') --noconfirm --clean --onedir --name sensevoice-server `
    --collect-all sherpa_onnx --hidden-import numpy `
    --distpath (Join-Path $work 'dist') --workpath (Join-Path $work 'work') --specpath $work `
    (Join-Path $root 'scripts\sensevoice-server.py')

if (Test-Path $server) { Remove-Item -LiteralPath $server -Recurse -Force }
Copy-Item -LiteralPath (Join-Path $work 'dist\sensevoice-server') -Destination $server -Recurse -Force
Write-Host "SenseVoice server ready: $server"
