using System.Runtime.InteropServices;
using System.Text;

namespace Zilux2.Wallpaper;

/// <summary>
/// 判断「当前前台窗口是不是全屏应用」，给「有全屏应用时暂停」开关用。
///
/// 为什么要自己判：Windows 没有现成 API，只能拿前台窗口矩形和它所在显示器的
/// 工作区/全尺寸比。三个坑都在下面处理了：
///   1. 桌面本身（Progman / WorkerW）和任务栏也会“占满屏幕”，要排掉；
///   2. 我们自己进程的窗口（主窗口最大化、桌面层的 WebView2 表面、桌面歌词窗口）
///      不能算“外部全屏应用”，否则一最大化就自己把自己暂停；
///   3. 无边框全屏游戏往往正好等于显示器尺寸，而少数独占全屏会落在 (0,0) 覆盖
///      整个虚拟桌面，两种都按“盖住某块屏”处理。
/// </summary>
internal static class FullscreenWatcher
{
    private const int MonitorDefaultToNearest = 2;
    private const int DwmwaExtendedFrameBounds = 9;
    private const int DwmwaCloaked = 14;

    /// <summary>允许的像素误差：有些游戏开无边框全屏会差 1~2 px。</summary>
    private const int Tolerance = 2;

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;

        public int Width => Right - Left;
        public int Height => Bottom - Top;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MonitorInfo
    {
        public int Size;
        public Rect Monitor;
        public Rect Work;
        public int Flags;
    }

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr hwnd, int flags);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hwnd, StringBuilder name, int count);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out Rect value, int size);

    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);

    /// <summary>前台是不是一块屏上的全屏应用（排掉桌面、任务栏和我们自己）。</summary>
    public static bool IsFullscreenForeground()
    {
        var hwnd = GetForegroundWindow();
        if (hwnd == IntPtr.Zero || !IsWindowVisible(hwnd) || IsIconic(hwnd)) return false;

        if (IsOwnProcess(hwnd)) return false;
        if (IsShellSurface(hwnd)) return false;
        if (IsCloaked(hwnd)) return false;

        if (!TryGetBounds(hwnd, out var bounds)) return false;

        var monitor = MonitorFromWindow(hwnd, MonitorDefaultToNearest);
        if (monitor == IntPtr.Zero) return false;

        var info = new MonitorInfo { Size = Marshal.SizeOf<MonitorInfo>() };
        if (!GetMonitorInfo(monitor, ref info)) return false;

        // 只认「盖住整块显示器」。普通最大化窗口只盖住工作区（还看得见任务栏），
        // 拿它当全屏会在你只是最大化个资源管理器时就把壁纸停掉。
        return Covers(bounds, info.Monitor);
    }

    /// <summary>
    /// 前台窗口盖住了它所在显示器多少（0~1），给「被窗口盖住多少就静音」用。
    /// 和自己的进程无关的窗口才算（主窗口最大化不该把壁纸静音）；桌面/任务栏/挂到桌面下的
    /// 窗口一律 0，否则桌面一刷新就会被当成「盖满了」。
    /// </summary>
    public static double ForegroundCoverage()
    {
        var hwnd = GetForegroundWindow();
        if (hwnd == IntPtr.Zero || !IsWindowVisible(hwnd) || IsIconic(hwnd)) return 0;

        if (IsOwnProcess(hwnd)) return 0;
        if (IsShellSurface(hwnd)) return 0;
        if (IsCloaked(hwnd)) return 0;

        if (!TryGetBounds(hwnd, out var bounds)) return 0;

        var monitor = MonitorFromWindow(hwnd, MonitorDefaultToNearest);
        if (monitor == IntPtr.Zero) return 0;

        var info = new MonitorInfo { Size = Marshal.SizeOf<MonitorInfo>() };
        if (!GetMonitorInfo(monitor, ref info)) return 0;

        var area = info.Monitor;
        if (area.Width <= 0 || area.Height <= 0) return 0;

        var width = Math.Max(0, Math.Min(bounds.Right, area.Right) - Math.Max(bounds.Left, area.Left));
        var height = Math.Max(0, Math.Min(bounds.Bottom, area.Bottom) - Math.Max(bounds.Top, area.Top));
        return Math.Clamp((double)width * height / ((double)area.Width * area.Height), 0, 1);
    }

    /// <summary>取窗口真实边界：优先 DWM 的扩展边框（去掉 Win10 的隐形 8px 阴影）。</summary>
    private static bool TryGetBounds(IntPtr hwnd, out Rect bounds)
    {
        if (DwmGetWindowAttribute(hwnd, DwmwaExtendedFrameBounds, out bounds, Marshal.SizeOf<Rect>()) == 0
            && bounds.Width > 0 && bounds.Height > 0)
        {
            return true;
        }

        return GetWindowRect(hwnd, out bounds) && bounds.Width > 0 && bounds.Height > 0;
    }

    private static bool Covers(Rect window, Rect area)
    {
        return window.Left <= area.Left + Tolerance
            && window.Top <= area.Top + Tolerance
            && window.Right >= area.Right - Tolerance
            && window.Bottom >= area.Bottom - Tolerance;
    }

    private static bool IsOwnProcess(IntPtr hwnd)
    {
        GetWindowThreadProcessId(hwnd, out var pid);
        return pid == (uint)Environment.ProcessId;
    }

    /// <summary>桌面、任务栏、以及“桌面背景歌词”这类挂到 Progman 下的窗口都不算应用。</summary>
    private static bool IsShellSurface(IntPtr hwnd)
    {
        var name = new StringBuilder(64);
        if (GetClassName(hwnd, name, name.Capacity) == 0) return false;

        return name.ToString() switch
        {
            "Progman" => true,
            "WorkerW" => true,
            "Shell_TrayWnd" => true,
            "Shell_SecondaryTrayWnd" => true,
            _ => false,
        };
    }

    private static bool IsCloaked(IntPtr hwnd)
    {
        return DwmGetWindowAttribute(hwnd, DwmwaCloaked, out int cloaked, sizeof(int)) == 0 && cloaked != 0;
    }
}
