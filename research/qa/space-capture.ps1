# 3D 登录空间实机截图（Debug 宿主 + 真实回环服务）
# 用法：pwsh -File research/qa/space-capture.ps1
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$exe = Join-Path $repo 'src\Zilux2\bin\Debug\net10.0-windows10.0.19041.0\Zilux2.exe'
$outDir = Join-Path $repo 'research\shots'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class QaSpace {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
}
'@

function Save-Shot([IntPtr]$hwnd, [string]$path) {
  $rect = New-Object QaSpace+RECT
  [QaSpace]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
  $w = $rect.Right - $rect.Left
  $h = $rect.Bottom - $rect.Top
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  $ok = [QaSpace]::PrintWindow($hwnd, $hdc, 2)
  $g.ReleaseHdc($hdc)
  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output ("shot {0} ok={1} {2}x{3}" -f (Split-Path -Leaf $path), $ok, $w, $h)
}

function Click-Rel([IntPtr]$hwnd, [int]$x, [int]$y) {
  $rect = New-Object QaSpace+RECT
  [QaSpace]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
  $dpi = [QaSpace]::GetDpiForWindow($hwnd)
  $scale = if ($dpi -gt 96) { $dpi / 96.0 } else { 1.0 }
  $px = [int]($rect.Left + $x * $scale)
  $py = [int]($rect.Top + $y * $scale)
  [QaSpace]::SetCursorPos($px, $py) | Out-Null
  Start-Sleep -Milliseconds 120
  [QaSpace]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 80
  [QaSpace]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Write-Output ("click rel={0},{1} -> screen {2},{3} scale={4}" -f $x, $y, $px, $py, $scale)
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

$rect = New-Object QaSpace+RECT
[QaSpace]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
# 窗口刚创建时 WPF 可能还未完成最终定位（副屏/居中），等待稳定后再读一次
Start-Sleep -Seconds 3
[QaSpace]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
if ($rect.Top -lt -200) {
  [QaSpace]::ShowWindow($hwnd, 5) | Out-Null
  Start-Sleep -Milliseconds 500
  [QaSpace]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
}
Write-Output ("window rect=({0},{1})-({2},{3})" -f $rect.Left, $rect.Top, $rect.Right, $rect.Bottom)

Start-Sleep -Seconds 4
Save-Shot $hwnd (Join-Path $outDir 'space-host-home.png')

# 网易云卡片中心（1600x960 窗口坐标；3D 卡片中心约 x=533,y=470）
[QaSpace]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 300
Click-Rel $hwnd 533 470
Start-Sleep -Seconds 3
Save-Shot $hwnd (Join-Path $outDir 'space-host-netease-qr.png')

# QQ 卡片中心（约 x=1067,y=470）
Click-Rel $hwnd 1067 470
Start-Sleep -Seconds 3
Save-Shot $hwnd (Join-Path $outDir 'space-host-qq-qr.png')

# 进入空间：键盘 Enter（窗口可能被 WPF 定位到屏幕外，鼠标坐标不可靠）
[QaSpace]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 400
$wshell = New-Object -ComObject WScript.Shell
$wshell.SendKeys('{ENTER}')
Start-Sleep -Seconds 2
Save-Shot $hwnd (Join-Path $outDir 'space-host-entered.png')

Start-Sleep -Milliseconds 500
$proc.CloseMainWindow() | Out-Null
Start-Sleep -Seconds 2
if (-not $proc.HasExited) { $proc.Kill() }
Write-Output 'closed'
