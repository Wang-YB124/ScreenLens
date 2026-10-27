[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
$exe = Join-Path $PSScriptRoot '..\dist\ScreenLens\ScreenLens.exe'
$exe = (Resolve-Path $exe).Path
$item = Get-Item $exe
$v = $item.VersionInfo
"ProductName=$($v.ProductName)"
"FileDescription=$($v.FileDescription)"
"FileVersion=$($v.FileVersion)"
"SizeMB=$([math]::Round($item.Length / 1MB, 1))"
$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($exe)
$bmp = $icon.ToBitmap()
$out = Join-Path $PSScriptRoot 'shots\exe-icon.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
"Icon=$out $($bmp.Width)x$($bmp.Height)"
