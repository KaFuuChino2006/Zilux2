using System.Runtime.InteropServices;
using System.Text;

namespace Zilux2.Wallpaper.Render;

/// <summary>
/// 桌面层宿主定位（规格书 §5.5 / 第 24–26 轮）：把壁纸窗口挂到资源管理器的 WorkerW 上，
/// 让它待在桌面图标下面，图标、框选、右键菜单、拖放全部照常工作。
///
/// 流程沿用社区标准做法：先给 Progman 发 0x052C 让资源管理器派生 WorkerW，
/// 再枚举顶层窗口找「含有 SHELLDLL_DefView 的 WorkerW」，它后面的兄弟 WorkerW 就是壁纸层。
/// </summary>
internal static partial class WorkerWLocator
{
    private const uint WmSpawnWorker = 0x052C;
    private const uint SmtoNormal = 0x0000;
    private const uint SmtoAbortIfHung = 0x0002;

    [LibraryImport("user32.dll", EntryPoint = "FindWindowW", StringMarshalling = StringMarshalling.Utf16)]
    private static partial IntPtr FindWindow(string? className, string? windowName);

    [LibraryImport("user32.dll", EntryPoint = "FindWindowExW", StringMarshalling = StringMarshalling.Utf16)]
    private static partial IntPtr FindWindowEx(IntPtr parent, IntPtr childAfter, string? className, string? windowName);

    [LibraryImport("user32.dll", EntryPoint = "SendMessageTimeoutW")]
    private static partial IntPtr SendMessageTimeout(
        IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder name, int maxCount);

    [LibraryImport("user32.dll")]
    private static partial IntPtr SetParent(IntPtr child, IntPtr newParent);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool MoveWindow(IntPtr hWnd, int x, int y, int width, int height, [MarshalAs(UnmanagedType.Bool)] bool repaint);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool SetWindowPos(
        IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint flags);

    private static readonly IntPtr HwndBottom = new(1);
    private const uint SwpNoSize = 0x0001;
    private const uint SwpNoMove = 0x0002;
    private const uint SwpNoActivate = 0x0010;

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    /// <summary>找挂壁纸的那层窗口；找不到返回 <see cref="IntPtr.Zero"/>。</summary>
    public static IntPtr Find()
    {
        try
        {
            var progman = FindWindow("Progman", null);

            if (progman != IntPtr.Zero)
            {
                // 让资源管理器派生 WorkerW。Win10 常见，Win11 上多半没反应，失败继续往下找。
                SendMessageTimeout(progman, WmSpawnWorker, (IntPtr)0xD, (IntPtr)0x1, SmtoNormal | SmtoAbortIfHung, 1000, out _);
                Thread.Sleep(120);
            }

            // 桌面图标层（SHELLDLL_DefView）的父窗口：Win10 是某个 WorkerW，Win11 是 Progman 自己。
            var iconHost = IntPtr.Zero;
            EnumWindows((handle, _) =>
            {
                if (FindWindowEx(handle, IntPtr.Zero, "SHELLDLL_DefView", null) == IntPtr.Zero) return true;
                iconHost = handle;
                return false;
            }, IntPtr.Zero);

            if (iconHost == IntPtr.Zero) iconHost = progman;

            if (iconHost != IntPtr.Zero)
            {
                // 壁纸层是图标宿主之后的兄弟 WorkerW（Win10 的两层结构）。
                var sibling = FindWindowEx(IntPtr.Zero, iconHost, "WorkerW", null);
                if (sibling != IntPtr.Zero && sibling != iconHost)
                {
                    HostLog.Info($"[desktop] workerw found iconHost=0x{iconHost.ToInt64():X} wallpaper=0x{sibling.ToInt64():X}");
                    return sibling;
                }

                // Win11：没有独立 WorkerW，直接挂到 Progman，再把自己压到图标层下面。
                HostLog.Info($"[desktop] workerw fallback progman=0x{iconHost.ToInt64():X}");
                return iconHost;
            }

            HostLog.Warn("[desktop] workerw not found: progman=0");
            return IntPtr.Zero;
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[desktop] locate failed：{exception.GetType().Name}: {exception.Message}");
            return IntPtr.Zero;
        }
    }

    /// <summary>把自己排到同层兄弟的最底部，避免盖住桌面图标。</summary>
    public static void SendToBottom(IntPtr child)
    {
        if (child == IntPtr.Zero) return;
        try
        {
            SetWindowPos(child, HwndBottom, 0, 0, 0, 0, SwpNoMove | SwpNoSize | SwpNoActivate);
        }
        catch
        {
            // 排序失败不影响显示。
        }
    }

    /// <summary>把已经创建好的窗口句柄挂到 WorkerW 上，并按屏幕铺满。</summary>
    public static bool Attach(IntPtr child, IntPtr workerW)
    {
        if (child == IntPtr.Zero || workerW == IntPtr.Zero) return false;

        try
        {
            SetParent(child, workerW);
            var bounds = System.Windows.Forms.Screen.PrimaryScreen?.Bounds;
            MoveWindow(child, 0, 0, bounds?.Width ?? 1920, bounds?.Height ?? 1080, true);
            SendToBottom(child);
            return true;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>从 WorkerW 上摘下来（退出接管 / 程序关闭时）。</summary>
    public static void Detach(IntPtr child)
    {
        if (child == IntPtr.Zero) return;
        try
        {
            SetParent(child, IntPtr.Zero);
        }
        catch
        {
            // 资源管理器可能已经重启，句柄失效时忽略。
        }
    }

    private static bool IsWorkerW(IntPtr handle)
    {
        var buffer = new StringBuilder(64);
        if (GetClassName(handle, buffer, buffer.Capacity) == 0) return false;
        return buffer.ToString() == "WorkerW";
    }
}
