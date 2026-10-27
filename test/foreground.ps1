param([string]$TitleLike = 'ScreenLens')
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Wf {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
$script:candidates = New-Object System.Collections.ArrayList
$cb = {
  param($h, $l)
  $t = New-Object System.Text.StringBuilder 512
  [Wf]::GetWindowText($h, $t, 512) | Out-Null
  $title = $t.ToString()
  if ($title -like "*$TitleLike*") {
    $r = New-Object Wf+RECT
    [Wf]::GetWindowRect($h, [ref]$r) | Out-Null
    $w = $r.Right - $r.Left
    $hh = $r.Bottom - $r.Top
    $c = New-Object System.Text.StringBuilder 256
    [Wf]::GetClassName($h, $c, 256) | Out-Null
    $script:candidates.Add([pscustomobject]@{ Hwnd = $h; Title = $title; W = $w; H = $hh; Rect = "$($r.Left),$($r.Top),$($r.Right),$($r.Bottom)"; Class = $c.ToString() }) | Out-Null
  }
  return $true
}
[Wf]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
$script:candidates | ForEach-Object { "found hwnd=$($_.Hwnd) size=$($_.W)x$($_.H) rect=$($_.Rect) class=$($_.Class) title=$($_.Title)" }
$target = $script:candidates | Sort-Object { $_.W * $_.H } -Descending | Select-Object -First 1
if (-not $target) { "no window found"; exit 1 }
$h = $target.Hwnd
$fg = [Wf]::GetForegroundWindow()
$pidFg = 0; $pidT = 0
$fgThread = [Wf]::GetWindowThreadProcessId($fg, [ref]$pidFg)
$tThread = [Wf]::GetWindowThreadProcessId($h, [ref]$pidT)
[Wf]::AttachThreadInput($tThread, $fgThread, $true) | Out-Null
[Wf]::ShowWindow($h, 9) | Out-Null
[Wf]::BringWindowToTop($h) | Out-Null
[Wf]::SetForegroundWindow($h) | Out-Null
[Wf]::AttachThreadInput($tThread, $fgThread, $false) | Out-Null
Start-Sleep -Milliseconds 700
"foregrounded hwnd=$h"
