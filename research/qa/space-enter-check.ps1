$ErrorActionPreference = 'Stop'
$root = 'E:\Zilux2开发'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class QaCS2 {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
}
'@
function Save-Shot([IntPtr]$hwnd, [string]$path) {
  $rect = New-Object QaCS2+RECT; [QaCS2]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
  $w = $rect.Right - $rect.Left; $h = $rect.Bottom - $rect.Top
  if ($w -le 0 -or $h -le 0) { $w = 1600; $h = 960 }
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp); $hdc = $g.GetHdc()
  $ok = [QaCS2]::PrintWindow($hwnd, $hdc, 2); $g.ReleaseHdc($hdc); $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  Write-Output ("shot {0} ok={1}" -f (Split-Path -Leaf $path), $ok)
}
$exe = Join-Path $root 'src\Zilux2\bin\Debug\net10.0-windows10.0.19041.0\Zilux2.exe'
$proc = Start-Process -FilePath $exe -WorkingDirectory (Split-Path -Parent $exe) -PassThru
$hwnd = [IntPtr]::Zero; $deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250; $proc.Refresh(); if ($proc.HasExited) { throw "exited early: $($proc.ExitCode)" }; if ($proc.MainWindowHandle -ne [IntPtr]::Zero) { $hwnd = $proc.MainWindowHandle; break } }
if ($hwnd -eq [IntPtr]::Zero) { throw 'window not found' }
Start-Sleep -Seconds 8
$rect = New-Object QaCS2+RECT; [QaCS2]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
$w = $rect.Right - $rect.Left; $h = $rect.Bottom - $rect.Top
Write-Output ("rect=({0},{1}) size={2}x{3}" -f $rect.Left, $rect.Top, $w, $h)
[QaCS2]::SetForegroundWindow($hwnd) | Out-Null; Start-Sleep -Milliseconds 500
# Enter -> enter space
$wshell = New-Object -ComObject WScript.Shell
$wshell.SendKeys('{ENTER}')
Start-Sleep -Seconds 3
Save-Shot $hwnd (Join-Path $root 'research\shots\chrome-space2.png')
# click entry button (center, 86.6% height) after going back
$wshell.SendKeys('{ESC}')
Start-Sleep -Seconds 2
[QaCS2]::SetCursorPos(($rect.Left + [int]($w * 0.5)), ($rect.Top + [int]($h * 0.866))) | Out-Null; Start-Sleep -Milliseconds 250
[QaCS2]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 70
[QaCS2]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Seconds 3
Save-Shot $hwnd (Join-Path $root 'research\shots\chrome-space3.png')
Start-Sleep -Milliseconds 300; $proc.CloseMainWindow() | Out-Null; Start-Sleep -Seconds 2
if (-not $proc.HasExited) { $proc.Kill() }
Write-Output 'closed'
