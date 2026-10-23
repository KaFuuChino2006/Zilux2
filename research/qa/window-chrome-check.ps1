$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class QaChrome {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
}
'@
function Save-Shot([IntPtr]$hwnd, [string]$path) {
  $rect = New-Object QaChrome+RECT; [QaChrome]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
  $w = $rect.Right - $rect.Left; $h = $rect.Bottom - $rect.Top
  if ($w -le 0 -or $h -le 0) { $w = 1600; $h = 960 }
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp); $hdc = $g.GetHdc()
  $ok = [QaChrome]::PrintWindow($hwnd, $hdc, 2); $g.ReleaseHdc($hdc); $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  Write-Output ("shot {0} ok={1}" -f (Split-Path -Leaf $path), $ok)
}
$exe = 'E:\Zilux2开发\src\Zilux2\bin\Debug\net10.0-windows10.0.19041.0\Zilux2.exe'
$proc = Start-Process -FilePath $exe -WorkingDirectory (Split-Path -Parent $exe) -PassThru
Write-Output "started pid=$($proc.Id)"
$hwnd = [IntPtr]::Zero; $deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250; $proc.Refresh(); if ($proc.HasExited) { throw "exited early: $($proc.ExitCode)" }; if ($proc.MainWindowHandle -ne [IntPtr]::Zero) { $hwnd = $proc.MainWindowHandle; break } }
if ($hwnd -eq [IntPtr]::Zero) { throw 'window not found' }
Start-Sleep -Seconds 8
$rect = New-Object QaChrome+RECT; [QaChrome]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
Write-Output ("rect=({0},{1})-({2},{3})" -f $rect.Left, $rect.Top, $rect.Right, $rect.Bottom)
[QaChrome]::SetForegroundWindow($hwnd) | Out-Null; Start-Sleep -Milliseconds 400
Save-Shot $hwnd 'E:\Zilux2开发\research\shots\chrome-login.png'
# 最大化按钮（登录页右上角最右前 3 个按钮中的中间：wctrl right 20，按钮 30+gap，居中按钮约 windowW-20-4-30-4-15=windowW-73）
[QaChrome]::SetCursorPos(($rect.Left + 1600 - 73), ($rect.Top + 33)) | Out-Null; Start-Sleep -Milliseconds 200
[QaChrome]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 70
[QaChrome]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Seconds 2
Save-Shot $hwnd 'E:\Zilux2开发\research\shots\chrome-maximized.png'
# 还原
[QaChrome]::SetCursorPos(($rect.Left + 1600 - 73), ($rect.Top + 33)) | Out-Null; Start-Sleep -Milliseconds 200
[QaChrome]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 70
[QaChrome]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Seconds 2
# 进入空间（按钮约 y=831）
[QaChrome]::SetCursorPos(($rect.Left + 800), ($rect.Top + 831)) | Out-Null; Start-Sleep -Milliseconds 150
[QaChrome]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 70
[QaChrome]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Seconds 3
Save-Shot $hwnd 'E:\Zilux2开发\research\shots\chrome-space.png'
Start-Sleep -Milliseconds 300; $proc.CloseMainWindow() | Out-Null; Start-Sleep -Seconds 2
if (-not $proc.HasExited) { $proc.Kill() }
Write-Output 'closed'
