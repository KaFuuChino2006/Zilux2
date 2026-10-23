# 里程碑 3 实机截图：设置面板（常规 / 外观），验证宿主 + 前端设置面板
# 用法：pwsh -File research/qa/settings-capture.ps1 [-Exe <path>] [-OutDir <dir>]
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
using System.Drawing;
public static class QaWin3 {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, IntPtr dwExtraInfo);
    public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004;
    public static void Click(int x, int y) {
        SetCursorPos(x, y);
        System.Threading.Thread.Sleep(60);
        mouse_event(LEFTDOWN, 0, 0, 0, IntPtr.Zero);
        System.Threading.Thread.Sleep(40);
        mouse_event(LEFTUP, 0, 0, 0, IntPtr.Zero);
    }
}
'@

function Save-Shot3([IntPtr]$hwnd, [string]$path) {
    $rect = New-Object QaWin3+RECT
    [void][QaWin3]::GetWindowRect($hwnd, [ref]$rect)
    $w = $rect.Right - $rect.Left
    $h = $rect.Bottom - $rect.Top
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $hdc = $g.GetHdc()
    $ok = [QaWin3]::PrintWindow($hwnd, $hdc, 2)
    $g.ReleaseHdc($hdc)
    $g.Dispose()
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Output ("shot {0} ok={1}" -f (Split-Path $path -Leaf), $ok)
}

$proc = Start-Process -FilePath $Exe -PassThru
Write-Output ("started pid={0}" -f $proc.Id)
$deadline = (Get-Date).AddSeconds(30)
$hwnd = [IntPtr]::Zero
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 300
    $proc.Refresh()
    if ($proc.MainWindowHandle -ne [IntPtr]::Zero) { $hwnd = $proc.MainWindowHandle; break }
}
if ($hwnd -eq [IntPtr]::Zero) { throw 'main window not found' }
Start-Sleep -Seconds 8
[void][QaWin3]::ShowWindow($hwnd, 5)
[void][QaWin3]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 400

$rect = New-Object QaWin3+RECT
[void][QaWin3]::GetWindowRect($hwnd, [ref]$rect)
Write-Output ("rect=({0},{1})-({2},{3})" -f $rect.Left, $rect.Top, $rect.Right, $rect.Bottom)
Save-Shot3 $hwnd (Join-Path $OutDir 'm3-host-home.png')

# 点左侧导航「设置」→ 打开设置面板（常规）
[QaWin3]::Click(($rect.Left + 42), ($rect.Top + 782))
Start-Sleep -Milliseconds 900
Save-Shot3 $hwnd (Join-Path $OutDir 'm3-host-settings.png')

# 点「外观」分类
[QaWin3]::Click(($rect.Left + 384), ($rect.Top + 260))
Start-Sleep -Milliseconds 700
Save-Shot3 $hwnd (Join-Path $OutDir 'm3-host-settings-appearance.png')

# 点「播放」分类
[QaWin3]::Click(($rect.Left + 384), ($rect.Top + 301))
Start-Sleep -Milliseconds 700
Save-Shot3 $hwnd (Join-Path $OutDir 'm3-host-settings-playback.png')

# Esc 关闭
$wshell = New-Object -ComObject WScript.Shell
[void][QaWin3]::SetForegroundWindow($hwnd)
$wshell.SendKeys('{ESC}')
Start-Sleep -Milliseconds 600
Save-Shot3 $hwnd (Join-Path $OutDir 'm3-host-settings-closed.png')

Start-Sleep -Milliseconds 300
[void]$proc.CloseMainWindow()
$proc.WaitForExit(8000) | Out-Null
if (-not $proc.HasExited) { $proc.Kill() }
Write-Output 'closed'
