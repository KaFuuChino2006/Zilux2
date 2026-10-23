# 里程碑 3：设置持久化 + 启动最大化 真机验证
param(
    [string]$Exe = 'E:\Zilux2开发\src\Zilux2\bin\Debug\net10.0-windows10.0.19041.0\Zilux2.exe',
    [string]$OutDir = 'E:\Zilux2开发\research\shots'
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class QaWin4 {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, IntPtr dwExtraInfo);
    public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004;
    public static void Click(int x, int y) {
        SetCursorPos(x, y); System.Threading.Thread.Sleep(60);
        mouse_event(LEFTDOWN, 0, 0, 0, IntPtr.Zero); System.Threading.Thread.Sleep(40);
        mouse_event(LEFTUP, 0, 0, 0, IntPtr.Zero);
    }
}
'@

function Save-Shot4([IntPtr]$hwnd, [string]$path) {
    $r = New-Object QaWin4+RECT
    [void][QaWin4]::GetWindowRect($hwnd, [ref]$r)
    $bmp = New-Object System.Drawing.Bitmap ($r.Right - $r.Left), ($r.Bottom - $r.Top)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $hdc = $g.GetHdc()
    $ok = [QaWin4]::PrintWindow($hwnd, $hdc, 2)
    $g.ReleaseHdc($hdc); $g.Dispose()
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
    Write-Output ("shot {0} ok={1}" -f (Split-Path $path -Leaf), $ok)
}

function Wait-AppWindow($proc, [int]$seconds = 30) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 300
        $proc.Refresh()
        if ($proc.MainWindowHandle -ne [IntPtr]::Zero) { return $proc.MainWindowHandle }
    }
    throw 'main window not found'
}

$settingsPath = Join-Path $env:LOCALAPPDATA 'Zilux2\settings.json'

# ---------- 第一轮：打开设置，切到「外观」关掉/开启动画？用「启动时最大化」 ----------
$p1 = Start-Process -FilePath $Exe -PassThru
$h1 = Wait-AppWindow $p1
Start-Sleep -Seconds 8
[void][QaWin4]::SetForegroundWindow($h1)
$r1 = New-Object QaWin4+RECT
[void][QaWin4]::GetWindowRect($h1, [ref]$r1)
Write-Output ("run1 rect=({0},{1})-({2},{3})" -f $r1.Left, $r1.Top, $r1.Right, $r1.Bottom)
[QaWin4]::Click(($r1.Left + 42), ($r1.Top + 782))
Start-Sleep -Milliseconds 900
# 「启动时最大化」开关中心
[QaWin4]::Click(($r1.Left + 1237), ($r1.Top + 387))
Start-Sleep -Milliseconds 1400
Save-Shot4 $h1 (Join-Path $OutDir 'm3-host-settings-toggled.png')
if (Test-Path $settingsPath) {
    Write-Output '--- settings.json after patch ---'
    Get-Content $settingsPath -Raw | Write-Output
} else { Write-Output 'settings.json NOT FOUND' }
[void]$p1.CloseMainWindow(); $p1.WaitForExit(8000) | Out-Null
if (-not $p1.HasExited) { $p1.Kill() }
Start-Sleep -Milliseconds 800

# ---------- 第二轮：重启验证 startMaximized 生效 ----------
$p2 = Start-Process -FilePath $Exe -PassThru
$h2 = Wait-AppWindow $p2
Start-Sleep -Seconds 8
$r2 = New-Object QaWin4+RECT
[void][QaWin4]::GetWindowRect($h2, [ref]$r2)
$w = $r2.Right - $r2.Left; $h = $r2.Bottom - $r2.Top
Write-Output ("run2 rect=({0},{1})-({2},{3}) size={4}x{5} maximizedExpected=3440x1392" -f $r2.Left, $r2.Top, $r2.Right, $r2.Bottom, $w, $h)
Save-Shot4 $h2 (Join-Path $OutDir 'm3-host-startmaximized.png')
# 恢复默认：再点一次「启动时最大化」关闭
[void][QaWin4]::SetForegroundWindow($h2)
[QaWin4]::Click(($r2.Left + 42), ($r2.Top + 782))
Start-Sleep -Milliseconds 900
[QaWin4]::Click(($r2.Left + 1237), ($r2.Top + 387))
Start-Sleep -Milliseconds 1200
[void]$p2.CloseMainWindow(); $p2.WaitForExit(8000) | Out-Null
if (-not $p2.HasExited) { $p2.Kill() }
Write-Output '--- settings.json final ---'
if (Test-Path $settingsPath) { Get-Content $settingsPath -Raw | Write-Output }
Write-Output 'done'
