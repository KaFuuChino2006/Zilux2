# 发布版验证：进入空间 + 拖动方向（默认俯视 -> 向下拖更平视）
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class QaDrag {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
}
'@
function Save-Shot([IntPtr]$hwnd, [string]$path) {
  $rect = New-Object QaDrag+RECT; [QaDrag]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
  $w = $rect.Right - $rect.Left; $h = $rect.Bottom - $rect.Top
  if ($w -le 0 -or $h -le 0) { $w = 1600; $h = 960 }
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp); $hdc = $g.GetHdc()
  $ok = [QaDrag]::PrintWindow($hwnd, $hdc, 2); $g.ReleaseHdc($hdc); $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  Write-Output ("shot {0} ok={1}" -f (Split-Path -Leaf $path), $ok)
}
function Drag-Rel([IntPtr]$hwnd, [int]$x, [int]$y, [int]$dx, [int]$dy) {
  $rect = New-Object QaDrag+RECT; [QaDrag]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
  $sx = $rect.Left + $x; $sy = $rect.Top + $y
  [QaDrag]::SetCursorPos($sx, $sy) | Out-Null; Start-Sleep -Milliseconds 200
  [QaDrag]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 120
  $steps = 12
  for ($i = 1; $i -le $steps; $i++) {
    [QaDrag]::SetCursorPos(($sx + [int]($dx * $i / $steps)), ($sy + [int]($dy * $i / $steps))) | Out-Null
    Start-Sleep -Milliseconds 45
  }
  Start-Sleep -Milliseconds 140
  [QaDrag]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 300
}

$exe = 'E:\Zilux2开发\dist\Zilux2\Zilux2.exe'
$proc = Start-Process -FilePath $exe -WorkingDirectory 'E:\Zilux2开发\dist\Zilux2' -PassThru
Write-Output "started pid=$($proc.Id)"
$hwnd = [IntPtr]::Zero; $deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 250; $proc.Refresh()
  if ($proc.HasExited) { throw "exited early: $($proc.ExitCode)" }
  if ($proc.MainWindowHandle -ne [IntPtr]::Zero) { $hwnd = $proc.MainWindowHandle; break }
}
if ($hwnd -eq [IntPtr]::Zero) { throw 'window not found' }
Start-Sleep -Seconds 8
$rect = New-Object QaDrag+RECT; [QaDrag]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
Write-Output ("rect=({0},{1})-({2},{3})" -f $rect.Left, $rect.Top, $rect.Right, $rect.Bottom)
[QaDrag]::SetForegroundWindow($hwnd) | Out-Null; Start-Sleep -Milliseconds 400
# 进入空间
[QaDrag]::SetCursorPos(($rect.Left + 800), ($rect.Top + 831)) | Out-Null; Start-Sleep -Milliseconds 150
[QaDrag]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 70
[QaDrag]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Seconds 3
Save-Shot $hwnd 'E:\Zilux2开发\research\shots\space-drag-default.png'
# 向下拖 140px（应该变得更平视）
Drag-Rel $hwnd 800 520 0 140
Start-Sleep -Milliseconds 700
Save-Shot $hwnd 'E:\Zilux2开发\research\shots\space-drag-down.png'
# 向上拖 300px（应该回到更俯视）
Drag-Rel $hwnd 800 520 0 -300
Start-Sleep -Milliseconds 700
Save-Shot $hwnd 'E:\Zilux2开发\research\shots\space-drag-up.png'
Start-Sleep -Milliseconds 400; $proc.CloseMainWindow() | Out-Null; Start-Sleep -Seconds 2
if (-not $proc.HasExited) { $proc.Kill() }
Write-Output 'closed'
