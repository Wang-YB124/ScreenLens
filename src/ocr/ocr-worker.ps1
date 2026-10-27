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

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ScreenLensWin32 {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int max);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT pt);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")]
    public static extern int DwmGetWindowAttributeInt(IntPtr hWnd, int attr, out int value, int size);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
}
'@

function Get-WindowClientRect([IntPtr]$Hwnd) {
    if (-not [ScreenLensWin32]::IsWindow($Hwnd)) { throw 'WINDOW_GONE' }
    if ([ScreenLensWin32]::IsIconic($Hwnd)) { throw 'WINDOW_MINIMIZED' }
    $rect = New-Object ScreenLensWin32+RECT
    if (-not [ScreenLensWin32]::GetClientRect($Hwnd, [ref]$rect)) { throw 'WINDOW_RECT_FAILED' }
    $pt = New-Object ScreenLensWin32+POINT
    $pt.X = 0
    $pt.Y = 0
    if (-not [ScreenLensWin32]::ClientToScreen($Hwnd, [ref]$pt)) { throw 'WINDOW_RECT_FAILED' }
    $w = $rect.Right - $rect.Left
    $h = $rect.Bottom - $rect.Top
    if ($w -lt 8 -or $h -lt 8) { throw 'WINDOW_TOO_SMALL' }
    return [ordered]@{ x = $pt.X; y = $pt.Y; w = $w; h = $h }
}

function Get-OpenWindowList([int]$ExcludePid) {
    $result = New-Object System.Collections.Generic.List[object]
    $callback = [ScreenLensWin32+EnumWindowsProc]{
        param([IntPtr]$hWnd, [IntPtr]$lParam)
        try {
            if (-not [ScreenLensWin32]::IsWindowVisible($hWnd)) { return $true }
            if ([ScreenLensWin32]::IsIconic($hWnd)) { return $true }
            $titleLength = [ScreenLensWin32]::GetWindowTextLength($hWnd)
            if ($titleLength -le 0) { return $true }
            $classBuilder = New-Object System.Text.StringBuilder 256
            [void][ScreenLensWin32]::GetClassName($hWnd, $classBuilder, $classBuilder.Capacity)
            $className = $classBuilder.ToString()
            if ($className -in @('Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd')) { return $true }
            $ownerPid = [uint32]0
            [void][ScreenLensWin32]::GetWindowThreadProcessId($hWnd, [ref]$ownerPid)
            if ($ExcludePid -gt 0 -and [int]$ownerPid -eq $ExcludePid) { return $true }
            $cloaked = 0
            try { [void][ScreenLensWin32]::DwmGetWindowAttributeInt($hWnd, 14, [ref]$cloaked, 4) } catch { $cloaked = 0 }
            if ($cloaked -ne 0) { return $true }
            $wr = New-Object ScreenLensWin32+RECT
            if (-not [ScreenLensWin32]::GetWindowRect($hWnd, [ref]$wr)) { return $true }
            $ww = $wr.Right - $wr.Left
            $wh = $wr.Bottom - $wr.Top
            if ($ww -lt 120 -or $wh -lt 80) { return $true }
            $client = $null
            try { $client = Get-WindowClientRect $hWnd } catch { return $true }
            $sb = New-Object System.Text.StringBuilder ($titleLength + 2)
            [void][ScreenLensWin32]::GetWindowText($hWnd, $sb, $sb.Capacity)
            $title = $sb.ToString().Trim()
            if ([string]::IsNullOrWhiteSpace($title)) { return $true }
            if ($title.Length -gt 120) { $title = $title.Substring(0, 120) }
            $result.Add([ordered]@{
                    id     = $hWnd.ToInt64().ToString()
                    title  = $title
                    pid    = [int]$ownerPid
                    rect   = [ordered]@{ x = $wr.Left; y = $wr.Top; w = $ww; h = $wh }
                    client = $client
                })
        }
        catch {}
        return $true
    }
    [void][ScreenLensWin32]::EnumWindows($callback, [IntPtr]::Zero)
    return , $result.ToArray()
}

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
        elseif ($action -eq 'windows') {
            $exclude = 0
            if ($req.excludePid) { $exclude = [int]$req.excludePid }
            $res = [ordered]@{
                ok      = $true
                windows = Get-OpenWindowList $exclude
            }
        }
        elseif ($action -eq 'capture') {
            $windowRect = $null
            $capX = [int]$req.x
            $capY = [int]$req.y
            $capW = [int]$req.w
            $capH = [int]$req.h
            if ($req.hwnd) {
                $handle = [IntPtr]([Int64]([string]$req.hwnd))
                $windowRect = Get-WindowClientRect $handle
                $capX = [int]$windowRect.x
                $capY = [int]$windowRect.y
                $capW = [int]$windowRect.w
                $capH = [int]$windowRect.h
            }
            $cap = Invoke-Capture $capX $capY $capW $capH $req.image
            if ($req.ocr) {
                $res = Invoke-Ocr $req.image $req.lang
                $res['captureMs'] = $cap.captureMs
                $res['width'] = $cap.width
                $res['height'] = $cap.height
            }
            else {
                $res = [ordered]@{ ok = $true; capture = $cap }
            }
            if ($null -ne $windowRect) { $res['windowRect'] = $windowRect }
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
