param([string]$Out = "test\shots\screen.png")
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DpiAware2 {
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
[DpiAware2]::Enable()
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, (New-Object System.Drawing.Size($bounds.Width, $bounds.Height)))
$g.Dispose()
$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
"saved $Out $($bounds.Width)x$($bounds.Height)"
