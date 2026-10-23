# 验证：卡片 hover 动画 + 「进入空间」按钮点击（Debug 宿主 + 新 web/dist）
# 用法：pwsh -File research/qa/space-hover-click.ps1
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$exe = Join-Path $repo 'src\Zilux2\bin\Debug\net10.0-windows10.0.19041.0\Zilux2.exe'
$outDir = Join-Path $repo 'research\shots'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class QaHC {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
}
'@

function Get-Rect([IntPtr]$hwnd) {
  $rect = New-Object QaHC+RECT
  [QaHC]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
  $rect
}

function Save-Shot([IntPtr]$hwnd, [string]$path) {
  $rect = Get-Rect $hwnd
  $w = $rect.Right - $rect.Left
  $h = $rect.Bottom - $rect.Top
  if ($w -le 0 -or $h -le 0) { $w = 1600; $h = 960 }
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  $ok = [QaHC]::PrintWindow($hwnd, $hdc, 2)
  $g.ReleaseHdc($hdc)
  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output ("shot {0} ok={1}" -f (Split-Path -Leaf $path), $ok)
}

function Move-Rel([IntPtr]$hwnd, [int]$x, [int]$y) {
  $rect = Get-Rect $hwnd
  [QaHC]::SetCursorPos(($rect.Left + $x), ($rect.Top + $y)) | Out-Null
  Start-Sleep -Milliseconds 250
}

function Click-Rel([IntPtr]$hwnd, [int]$x, [int]$y) {
  Move-Rel $hwnd $x $y
  [QaHC]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 70
  [QaHC]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 250
}

$proc = Start-Process -FilePath $exe -WorkingDirectory (Split-Path -Parent $exe) -PassThru
Write-Output "started pid=$($proc.Id)"
$hwnd = [IntPtr]::Zero
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 250
  $proc.Refresh()
  if ($proc.HasExited) { throw "host exited early: $($proc.ExitCode)" }
  if ($proc.MainWindowHandle -ne [IntPtr]::Zero) { $hwnd = $proc.MainWindowHandle; break }
}
if ($hwnd -eq [IntPtr]::Zero) { throw 'window not found' }

Start-Sleep -Seconds 8
$rect = Get-Rect $hwnd
Write-Output ("rect=({0},{1})-({2},{3})" -f $rect.Left, $rect.Top, $rect.Right, $rect.Bottom)
if ($rect.Top -lt -200) {
  Write-Output 'rect looks off-screen; re-reading after 1s'
  Start-Sleep -Seconds 1
  $rect = Get-Rect $hwnd
  Write-Output ("rect2=({0},{1})-({2},{3})" -f $rect.Left, $rect.Top, $rect.Right, $rect.Bottom)
}

[QaHC]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 400

# 1) hover 网易云卡片
Move-Rel $hwnd 533 470
Start-Sleep -Milliseconds 900
Save-Shot $hwnd (Join-Path $outDir 'space-hover-netease.png')

# 2) hover QQ 卡片
Move-Rel $hwnd 1067 470
Start-Sleep -Milliseconds 900
Save-Shot $hwnd (Join-Path $outDir 'space-hover-qq.png')

# 3) 鼠标移开，然后点击「进入 Zilux2 空间」按钮
Move-Rel $hwnd 150 500
Start-Sleep -Milliseconds 500
Click-Rel $hwnd 800 831
Start-Sleep -Seconds 3
Save-Shot $hwnd (Join-Path $outDir 'space-click-entered.png')

Start-Sleep -Milliseconds 400
$proc.CloseMainWindow() | Out-Null
Start-Sleep -Seconds 2
if (-not $proc.HasExited) { $proc.Kill() }
Write-Output 'closed'
