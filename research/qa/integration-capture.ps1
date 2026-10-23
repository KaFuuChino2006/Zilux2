# 里程碑 2 实机联调截图：启动宿主 → 首页(在线源就绪) → 搜索面板 → 搜索结果 → 播放 → 歌词面板
# 用法：pwsh -File research/qa/integration-capture.ps1 [-Exe <path>] [-OutDir <dir>] [-KeepOpen]
param(
    [string]$Exe = 'E:\Zilux2开发\src\Zilux2\bin\Debug\net10.0-windows10.0.19041.0\Zilux2.exe',
    [string]$OutDir = 'E:\Zilux2开发\research\shots',
    [switch]$KeepOpen
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Drawing;
public static class QaWin {
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

function Save-WindowShot([IntPtr]$hwnd, [string]$path) {
    $rect = New-Object QaWin+RECT
    [void][QaWin]::GetWindowRect($hwnd, [ref]$rect)
    $w = $rect.Right - $rect.Left
    $h = $rect.Bottom - $rect.Top
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $hdc = $g.GetHdc()
    $ok = [QaWin]::PrintWindow($hwnd, $hdc, 2)
    $g.ReleaseHdc($hdc)
    $g.Dispose()
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Output ("shot {0} ok={1} {2}x{3} " -f (Split-Path $path -Leaf), $ok, $w, $h)
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
Write-Output ("window hwnd={0} title={1}" -f $hwnd, $proc.MainWindowTitle)

# 等启动页走完、首页挂载（WebView2 首帧 + splash 2.6s + 过渡）
Start-Sleep -Seconds 8
[void][QaWin]::ShowWindow($hwnd, 5)
[void][QaWin]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 400

$rect = New-Object QaWin+RECT
[void][QaWin]::GetWindowRect($hwnd, [ref]$rect)
Write-Output ("rect=({0},{1})-({2},{3})" -f $rect.Left, $rect.Top, $rect.Right, $rect.Bottom)

Save-WindowShot $hwnd (Join-Path $OutDir 'm2-host-home.png')

# 1) 点搜索框 → 打开搜索面板
[QaWin]::Click(($rect.Left + 290), ($rect.Top + 82))
Start-Sleep -Milliseconds 900
Save-WindowShot $hwnd (Join-Path $OutDir 'm2-host-search-open.png')

# 2) 点“晴天”快捷词 → 触发搜索（结果多为可播放曲目）
[QaWin]::Click(($rect.Left + 695), ($rect.Top + 382))
Start-Sleep -Seconds 3
Save-WindowShot $hwnd (Join-Path $OutDir 'm2-host-search-results.png')

# 3) 点第一行直接播放
[QaWin]::Click(($rect.Left + 780), ($rect.Top + 265))
Start-Sleep -Seconds 5
Save-WindowShot $hwnd (Join-Path $OutDir 'm2-host-playing.png')

# 4) 播放时歌词面板会自动展开（在线歌曲）→ 点「歌词」按钮验证可收起
[QaWin]::Click(($rect.Left + 1342), ($rect.Top + 915))
Start-Sleep -Milliseconds 900
Save-WindowShot $hwnd (Join-Path $OutDir 'm2-host-lyrics-closed.png')

# 5) 再点一次 → 重新展开歌词面板
[QaWin]::Click(($rect.Left + 1342), ($rect.Top + 915))
Start-Sleep -Milliseconds 900
Save-WindowShot $hwnd (Join-Path $OutDir 'm2-host-lyrics.png')

# 6) 最大化 3440×1392 实机截图
[void][QaWin]::ShowWindow($hwnd, 3)
Start-Sleep -Milliseconds 1400
$maxRect = New-Object QaWin+RECT
[void][QaWin]::GetWindowRect($hwnd, [ref]$maxRect)
Save-WindowShot $hwnd (Join-Path $OutDir 'm2-host-max.png')

if (-not $KeepOpen) {
    Start-Sleep -Milliseconds 300
    [void]$proc.CloseMainWindow()
    $proc.WaitForExit(8000) | Out-Null
    if (-not $proc.HasExited) { $proc.Kill() }
    Write-Output 'closed'
}
