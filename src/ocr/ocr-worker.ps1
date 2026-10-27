param(
    [Parameter(Mandatory = $true)][string]$RequestFile
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
Add-Type -AssemblyName System.Drawing | Out-Null

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DpiAwareness {
    [DllImport("user32.dll")]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();
    public static void Enable() {
        try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch {}
        try { SetProcessDPIAware(); } catch {}
    }
}
'@
[DpiAwareness]::Enable()

$script:AsTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and
        $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]

function Await($WinRtTask, $ResultType) {
    $asTask = $script:AsTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}

$null = [Windows.Foundation.UniversalApiContract, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime]

$script:Engines = @{}
$script:DefaultEngine = $null

function Get-OcrEngine([string]$LangTag) {
    if ([string]::IsNullOrWhiteSpace($LangTag)) {
        if ($null -eq $script:DefaultEngine) {
            $script:DefaultEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
        }
        return $script:DefaultEngine
    }
    if ($script:Engines.ContainsKey($LangTag)) { return $script:Engines[$LangTag] }
    $language = New-Object Windows.Globalization.Language $LangTag
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
    if ($null -eq $engine) {
        $available = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag }
        throw "OCR language '$LangTag' is not installed. Available: $($available -join ', ')"
    }
    $script:Engines[$LangTag] = $engine
    return $engine
}

function Invoke-Ocr([string]$ImagePath, [string]$LangTag) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $engine = Get-OcrEngine $LangTag
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    try {
        $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $maxDim = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
        if ($decoder.PixelWidth -gt $maxDim -or $decoder.PixelHeight -gt $maxDim) {
            throw "IMAGE_TOO_LARGE: $($decoder.PixelWidth)x$($decoder.PixelHeight) exceeds $maxDim"
        }
        $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
        $bitmap.Dispose()

        $lines = New-Object System.Collections.Generic.List[object]
        $texts = New-Object System.Collections.Generic.List[string]
        foreach ($line in $result.Lines) {
            if ([string]::IsNullOrWhiteSpace($line.Text)) { continue }
            $words = New-Object System.Collections.Generic.List[object]
            foreach ($word in $line.Words) {
                $r = $word.BoundingRect
                $words.Add([ordered]@{
                        t = $word.Text
                        x = [math]::Round($r.X, 1)
                        y = [math]::Round($r.Y, 1)
                        w = [math]::Round($r.Width, 1)
                        h = [math]::Round($r.Height, 1)
                    })
            }
            $xs = @($line.Words | ForEach-Object { $_.BoundingRect.X })
            $ys = @($line.Words | ForEach-Object { $_.BoundingRect.Y })
            $rs = @($line.Words | ForEach-Object { $_.BoundingRect.Right })
            $bs = @($line.Words | ForEach-Object { $_.BoundingRect.Bottom })
            $lines.Add([ordered]@{
                    text  = $line.Text
                    x     = [math]::Round(($xs | Measure-Object -Minimum).Minimum, 1)
                    y     = [math]::Round(($ys | Measure-Object -Minimum).Minimum, 1)
                    w     = [math]::Round((($rs | Measure-Object -Maximum).Maximum - ($xs | Measure-Object -Minimum).Minimum), 1)
                    h     = [math]::Round((($bs | Measure-Object -Maximum).Maximum - ($ys | Measure-Object -Minimum).Minimum), 1)
                    words = $words.ToArray()
                })
            $texts.Add($line.Text)
        }

        $sw.Stop()
        return [ordered]@{
            ok     = $true
            lang   = if ($LangTag) { $LangTag } else { 'auto' }
            text   = ($texts -join "`n")
            lines  = $lines.ToArray()
            width  = $decoder.PixelWidth
            height = $decoder.PixelHeight
            ms     = $sw.ElapsedMilliseconds
        }
    }
    finally {
        if ($null -ne $stream) { $stream.Dispose() }
    }
}

function Invoke-Capture([int]$X, [int]$Y, [int]$W, [int]$H, [string]$Path) {
    if ($W -le 0 -or $H -le 0) { throw "INVALID_RECT: ${W}x${H}" }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $bmp = New-Object System.Drawing.Bitmap $W, $H
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
        $g.CopyFromScreen($X, $Y, 0, 0, (New-Object System.Drawing.Size($W, $H)), [System.Drawing.CopyPixelOperation]::SourceCopy)
    }
    finally {
        $g.Dispose()
    }
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    $sw.Stop()
    return [ordered]@{ path = $Path; width = $W; height = $H; captureMs = $sw.ElapsedMilliseconds }
}

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim() -eq 'quit') { break }
    if ($line.Trim() -ne 'run') { continue }

    $id = $null
    try {
        $req = Get-Content -LiteralPath $RequestFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $id = $req.id
        $action = if ($req.action) { $req.action } else { 'ocr' }

        if ($action -eq 'ping') {
            $langs = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag })
            try { $null = Get-OcrEngine 'zh-Hans-CN' } catch { }
            try { $null = Get-OcrEngine 'en-GB' } catch { }
            $res = [ordered]@{
                ok        = $true
                pong      = $true
                languages = $langs
                maxDim    = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
            }
        }
        elseif ($action -eq 'capture') {
            $cap = Invoke-Capture ([int]$req.x) ([int]$req.y) ([int]$req.w) ([int]$req.h) $req.image
            if ($req.ocr) {
                $res = Invoke-Ocr $req.image $req.lang
                $res['captureMs'] = $cap.captureMs
                $res['width'] = $cap.width
                $res['height'] = $cap.height
            }
            else {
                $res = [ordered]@{ ok = $true; capture = $cap }
            }
        }
        else {
            $res = Invoke-Ocr $req.image $req.lang
        }

        $res['id'] = $id
        $json = $res | ConvertTo-Json -Compress -Depth 8
        [Console]::Out.WriteLine('@@' + $json)
    }
    catch {
        $payload = [ordered]@{
            ok     = $false
            id     = $id
            error  = $_.Exception.Message
            where  = $_.InvocationInfo.PositionMessage
            stack  = $_.ScriptStackTrace
        }
        [Console]::Out.WriteLine('@@' + ($payload | ConvertTo-Json -Compress -Depth 4))
    }
    [Console]::Out.Flush()
}
