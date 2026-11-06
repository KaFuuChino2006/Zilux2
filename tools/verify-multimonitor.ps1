# 多显示器 / DPI / 贴边 可控验证（Zilux2 需先启动）
# 用法： powershell -STA -ExecutionPolicy Bypass -File tools\verify-multimonitor.ps1
#
# 做三件事：
#   1) 打印所有显示器的 bounds / 工作区 / DPI，便于核对混合 DPI 拓扑；
#   2) 若 Zilux2 正在运行，把窗口依次 SetWindowPos 到每块屏幕中央，检查落点与
#      GetDpiForWindow 是否随显示器变化；
#   3) 恢复原位置。真实鼠标拖动无法脚本化，仍需要人工拖一次跨屏/贴边缩放。

Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  public static IntPtr FindByPid(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@

$screens = [System.Windows.Forms.Screen]::AllScreens
Write-Host "== screens =="
foreach ($s in $screens) {
  Write-Host ("{0} primary={1} bounds={2}x{3}@{4},{5} work={6}x{7}" -f `
    $s.DeviceName, $s.Primary, $s.Bounds.Width, $s.Bounds.Height, $s.Bounds.X, $s.Bounds.Y, `
    $s.WorkingArea.Width, $s.WorkingArea.Height)
}

$proc = Get-Process Zilux2 -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) {
  Write-Host "`nZilux2 未运行：只做了显示器枚举。启动应用后重跑可验证窗口移动。" -ForegroundColor Yellow
  exit 0
}

$hwnd = [Win]::FindByPid([uint32]$proc.Id)
if ($hwnd -eq [IntPtr]::Zero) {
  Write-Host "找不到 Zilux2 可见窗口（可能最小化到托盘）。" -ForegroundColor Yellow
  exit 1
}

$rect = New-Object Win+RECT
[void][Win]::GetWindowRect($hwnd, [ref]$rect)
$orig = @{ X = $rect.Left; Y = $rect.Top; W = ($rect.Right - $rect.Left); H = ($rect.Bottom - $rect.Top) }
Write-Host ("`nwindow {0}x{1}@{2},{3} dpi={4}" -f $orig.W, $orig.H, $orig.X, $orig.Y, [Win]::GetDpiForWindow($hwnd))

[void][Win]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 300

$fail = 0
foreach ($s in $screens) {
  $b = $s.WorkingArea
  $x = $b.X + [Math]::Max(0, [int](($b.Width - $orig.W) / 2))
  $y = $b.Y + [Math]::Max(0, [int](($b.Height - $orig.H) / 2))
  # SWP_NOSIZE=0x1 | SWP_NOZORDER=0x4 | SWP_NOACTIVATE=0x10
  [void][Win]::SetWindowPos($hwnd, [IntPtr]::Zero, $x, $y, $orig.W, $orig.H, 0x15)
  Start-Sleep -Milliseconds 700

  $r = New-Object Win+RECT
  [void][Win]::GetWindowRect($hwnd, [ref]$r)
  $dpi = [Win]::GetDpiForWindow($hwnd)
  $onScreen = ($r.Left -ge $s.Bounds.Left - 2) -and ($r.Left -lt $s.Bounds.Right) -and
              ($r.Top -ge $s.Bounds.Top - 2) -and ($r.Top -lt $s.Bounds.Bottom)
  $ok = $onScreen -and ([Math]::Abs($r.Left - $x) -le 4) -and ([Math]::Abs($r.Top - $y) -le 4)
  if (-not $ok) { $fail++ }
  Write-Host ("{0}: target {1},{2} -> got {3},{4} dpi={5} {6}" -f `
    $s.DeviceName, $x, $y, $r.Left, $r.Top, $dpi, $(if ($ok) { 'OK' } else { 'FAIL' })) `
    -ForegroundColor $(if ($ok) { 'Green' } else { 'Red' })
}

[void][Win]::SetWindowPos($hwnd, [IntPtr]::Zero, $orig.X, $orig.Y, $orig.W, $orig.H, 0x15)
Write-Host "`nrestored to original position."

if ($fail -eq 0) {
  Write-Host "PASS: 程序化跨屏移动全部落点正确（真实鼠标拖动/贴边缩放仍需人工确认）。" -ForegroundColor Green
  exit 0
} else {
  Write-Host "FAIL: $fail 块屏幕落点不正确。" -ForegroundColor Red
  exit 1
}
