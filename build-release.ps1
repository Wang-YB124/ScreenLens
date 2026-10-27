$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$version = (Get-Content (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$out = Join-Path $root 'dist\release\ScreenLens'

& (Join-Path $root 'build-portable.ps1') -Output 'dist\release\ScreenLens'

$zip = Join-Path $root "dist\ScreenLens-$version-win64.zip"
if (Test-Path $zip) {
    Remove-Item -LiteralPath $zip -Force
}
Compress-Archive -Path $out -DestinationPath $zip -CompressionLevel Optimal

$hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
$hashFile = "$zip.sha256.txt"
Set-Content -LiteralPath $hashFile -Value ("$hash  " + [IO.Path]::GetFileName($zip)) -Encoding ASCII

$zipSize = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host "Release folder: $out"
Write-Host "Release archive: $zip ($zipSize MB)"
Write-Host "SHA256: $hash"
