using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace Zilux2.Interop;

internal static class NativeMethods
{
    public const int WmGetMinMaxInfo = 0x0024;
    public const int WmMoving = 0x0216;
    public const int WmExitSizeMove = 0x0232;
    public const int WmNcLButtonDown = 0x00A1;
    public const int HtCaption = 2;
    public const int HtLeft = 10;
    public const int HtRight = 11;
    public const int HtTop = 12;
    public const int HtTopLeft = 13;
    public const int HtTopRight = 14;
    public const int HtBottom = 15;
    public const int HtBottomLeft = 16;
    public const int HtBottomRight = 17;
    public const int WmSize = 0x0005;
    public const int WmDisplayChange = 0x007E;
    public const int WmDpiChanged = 0x02E0;
    public const uint MonitorDefaultToNearest = 2;
    public const uint SwpNoZOrder = 0x0004;
    public const uint SwpNoActivate = 0x0010;

    // 全局热键（RegisterHotKey / WM_HOTKEY）
    public const int WmHotkey = 0x0312;
    public const uint ModAlt = 0x0001;
    public const uint ModControl = 0x0002;
    public const uint ModShift = 0x0004;
    public const uint ModWin = 0x0008;
    // MOD_NOREPEAT：按住不放时系统不再连续投递 WM_HOTKEY。自动重复由底层钩子负责吞掉，
    // 这里关掉系统重复，快速连按才不会被误当成重复而丢掉。
    public const uint ModNoRepeat = 0x4000;
    public const uint VkSpace = 0x20;
    public const uint VkLeft = 0x25;
    public const uint VkRight = 0x27;
    public const uint VkJ = 0x4A; // 备选键：Ctrl+Alt+Left/Right 被占用时用 Ctrl+Alt+J/K
    public const uint VkK = 0x4B;
    public const uint VkZ = 0x5A;

    // 系统媒体键接管（WH_KEYBOARD_LL）：媒体键常被别的程序用 RegisterHotKey 抢注（例如 QQ 音乐），
    // 被抢注后本机 SMTC 永远收不到 ButtonPressed；底层键盘钩子仍然能看到这些按键，可以在本机是
    // 当前媒体会话时吞下并自行处理，其余情况原样放行。
    public const int WhKeyboardLl = 13;
    public const int WmKeyDown = 0x0100;
    public const int WmKeyUp = 0x0101;
    public const int WmSysKeyDown = 0x0104;
    public const int WmSysKeyUp = 0x0105;
    public const uint VkMediaNextTrack = 0xB0;
    public const uint VkMediaPrevTrack = 0xB1;
    public const uint VkMediaStop = 0xB2;
    public const uint VkMediaPlayPause = 0xB3;

    // 鼠标侧键导航（WH_MOUSE_LL）：XBUTTON1=后退、XBUTTON2=前进。Chromium 自己会把侧键
    // 当成浏览器历史，这里在钩子里先吞掉，改成给页面发 navBack / navForward。
    public const int WhMouseLl = 14;
    public const int WmXButtonDown = 0x020B;
    public const int WmXButtonUp = 0x020C;
    public const uint XButton1 = 0x0001;
    public const uint XButton2 = 0x0002;
    public const uint GaRoot = 2;

    [StructLayout(LayoutKind.Sequential)]
    public struct MsllHookStruct
    {
        public int PointX;
        public int PointY;
        public uint MouseData;
        public uint Flags;
        public uint Time;
        public IntPtr ExtraInfo;
    }

    public delegate IntPtr LowLevelMouseProc(int nCode, IntPtr wParam, IntPtr lParam);

    // 热键钩子线程：独立消息循环 + 结束信号
    public const int WmQuit = 0x0012;
    public const int VkShift = 0x10;
    public const int VkControl = 0x11;
    public const int VkMenu = 0x12;
    public const int VkLWin = 0x5B;
    public const int VkRWin = 0x5C;

    [StructLayout(LayoutKind.Sequential)]
    public struct Msg
    {
        public IntPtr Hwnd;
        public uint Message;
        public IntPtr WParam;
        public IntPtr LParam;
        public uint Time;
        public int PointX;
        public int PointY;
    }

    // WM_APPCOMMAND（0x0319）：部分键盘驱动 / OEM 热键服务按下「系统切换音乐」键时不发
    // VK_MEDIA_* 按键，而是直接往前台窗口投一条 APPCOMMAND 消息。底层键盘钩子看不到这条路径，
    // 只能在窗口消息里兜接；lParam 高 16 位的低 12 位是命令号。
    public const int WmAppCommand = 0x0319;
    public const int AppCommandMediaNextTrack = 11;
    public const int AppCommandMediaPrevTrack = 12;
    public const int AppCommandMediaStop = 13;
    public const int AppCommandMediaPlayPause = 14;

    [StructLayout(LayoutKind.Sequential)]
    public struct KbdLlHookStruct
    {
        public uint VirtualKeyCode;
        public uint ScanCode;
        public uint Flags;
        public uint Time;
        public IntPtr ExtraInfo;
    }

    public delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

    private const uint ShfoDelete = 0x0003;
    private const ushort FofAllowUndo = 0x0040;
    private const ushort FofNoConfirmation = 0x0010;
    private const ushort FofSilent = 0x0004;
    private const ushort FofNoErrorUi = 0x0400;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ShFileOpStruct
    {
        public nint Hwnd;
        public uint WFunc;
        public nint PFrom;
        public nint PTo;
        public ushort FFlags;

        [MarshalAs(UnmanagedType.Bool)]
        public bool FAnyOperationsAborted;

        public nint HNameMappings;
        public nint LpszProgressTitle;
    }

    [DllImport("shell32.dll", EntryPoint = "SHFileOperationW", CharSet = CharSet.Unicode)]
    private static extern int SHFileOperation(ref ShFileOpStruct fileOp);

    /// <summary>把一组文件移进资源管理器回收站（可撤销），返回失败的文件数。</summary>
    public static int MoveFilesToRecycleBin(IReadOnlyList<string> paths)
    {
        var builder = new System.Text.StringBuilder();
        foreach (var path in paths)
        {
            if (!string.IsNullOrWhiteSpace(path))
            {
                builder.Append(path).Append('\0');
            }
        }

        if (builder.Length == 0)
        {
            return 0;
        }

        builder.Append('\0');
        var buffer = Marshal.StringToHGlobalUni(builder.ToString());
        try
        {
            var op = new ShFileOpStruct
            {
                WFunc = ShfoDelete,
                PFrom = buffer,
                FFlags = (ushort)(FofAllowUndo | FofNoConfirmation | FofSilent | FofNoErrorUi),
            };
            var code = SHFileOperation(ref op);
            return code == 0 && !op.FAnyOperationsAborted ? 0 : paths.Count;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct Point
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MinMaxInfo
    {
        public Point Reserved;
        public Point MaxSize;
        public Point MaxPosition;
        public Point MinTrackSize;
        public Point MaxTrackSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MonitorInfo
    {
        public int Size;
        public Rect Monitor;
        public Rect Work;
        public uint Flags;
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool ReleaseCapture();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);

    [DllImport("user32.dll")]
    public static extern IntPtr MonitorFromRect(ref Rect rect, uint flags);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MonitorInfo monitorInfo);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetWindowRect(IntPtr hWnd, out Rect rect);

    // 桌面歌词锁定/解锁：读写 GWL_EXSTYLE（WS_EX_TRANSPARENT 让鼠标穿透）。
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")]
    public static extern int GetWindowLong(IntPtr hWnd, int index);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongW")]
    public static extern int SetWindowLong(IntPtr hWnd, int index, int value);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetWindowPos(
        IntPtr hWnd,
        IntPtr insertAfter,
        int x,
        int y,
        int cx,
        int cy,
        uint flags);

    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int vKey);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetCursorPos(out Point point);

    [DllImport("user32.dll")]
    public static extern IntPtr WindowFromPoint(Point point);

    // 桌面背景歌词：把第二个 WebView2 窗口挂到桌面壁纸层（WorkerW）下面。
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr FindWindow(string? className, string? windowName);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string? className, string? windowName);

    [DllImport("user32.dll")]
    public static extern IntPtr SetParent(IntPtr hWnd, IntPtr newParent);

    [DllImport("user32.dll")]
    public static extern IntPtr GetParent(IntPtr hWnd);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder name, int maxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr SendMessageTimeout(
        IntPtr hWnd,
        int msg,
        IntPtr wParam,
        IntPtr lParam,
        uint flags,
        uint timeout,
        out IntPtr result);

    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int index);

    // 桌面背景歌词：方案 B 要把窗口改成 WS_CHILD 挂到 Progman 下（图标层 SHELLDLL_DefView 的正下方）。
    // 样式是 LONG_PTR，必须用 Ptr 版本读写，否则 64 位下会截断 WS_POPUP 这类高位标志。
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int index);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
    public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int index, IntPtr value);

    // SetParent 之后 GetParent 对 popup 语义的窗口仍返回 0，验证父子关系只能用 GetAncestor(GA_PARENT=1)。
    [DllImport("user32.dll")]
    public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);

    // SetWindowPos 的坐标是父客户区坐标，铺满父窗口要配合 ClientToScreen/GetClientRect。
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool ClientToScreen(IntPtr hWnd, ref Point point);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetClientRect(IntPtr hWnd, out Rect rect);

    // Explorer 重启后 Progman/WorkerW 会重建，桌面背景歌词要靠 TaskbarCreated 广播消息重新挂载。
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern uint RegisterWindowMessage(string name);

    /// <summary>
    /// The placement WPF/Windows keeps for a minimized window. rcNormalPosition is what the
    /// taskbar restore animates back to, so it has to survive the minimize shrink animation.
    /// </summary>
    [StructLayout(LayoutKind.Sequential)]
    public struct WindowPlacement
    {
        public int Length;
        public int Flags;
        public int ShowCmd;
        public Point MinPosition;
        public Point MaxPosition;
        public Rect NormalPosition;
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetWindowPlacement(IntPtr hWnd, ref WindowPlacement placement);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetWindowPlacement(IntPtr hWnd, ref WindowPlacement placement);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool ShowWindow(IntPtr hWnd, int command);

    public const int AwHide = 0x00010000;
    public const int AwBlend = 0x00080000;

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool AnimateWindow(IntPtr hWnd, int durationMs, int flags);

    [DllImport("gdi32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool DeleteObject(IntPtr hObject);

    /// <summary>
    /// 让无边框窗口显示成圆角小卡：传 round 区域即把窗口裁剪成圆角矩形；传 IntPtr.Zero 恢复直角。
    /// 区域一旦交给系统就由系统接管，不要再 DeleteObject。
    /// </summary>
    [DllImport("user32.dll")]
    public static extern int SetWindowRgn(IntPtr hWnd, IntPtr hRgn, [MarshalAs(UnmanagedType.Bool)] bool bRedraw);

    [DllImport("gdi32.dll")]
    public static extern IntPtr CreateRoundRectRgn(int x1, int y1, int x2, int y2, int w, int h);

    // Win11 圆角 / 边框：DwmSetWindowAttribute。Win10 没有这些属性（返回 E_INVALIDARG），
    // 由调用方回退到 SetWindowRgn。
    public const int DwmWindowCornerPreference = 33;
    public const int DwmWindowCornerDefault = 0;
    public const int DwmWindowCornerDoNotRound = 1;
    public const int DwmWindowCornerRound = 2;
    public const int DwmWindowBorderColor = 34;
    public const int DwmColorNone = unchecked((int)0xFFFFFFFE);

    [DllImport("dwmapi.dll")]
    public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    /// <summary>窗口所在显示器的物理 DPI（Win10 1607+）。不会像 WPF 的 DpiScale 那样滞后。</summary>
    [DllImport("user32.dll")]
    public static extern uint GetDpiForWindow(IntPtr hwnd);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, [MarshalAs(UnmanagedType.Bool)] bool attach);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsIconic(IntPtr hWnd);

    public const int SwRestore = 9;

    /// <summary>
    /// 把窗口真正带到前台。开机自启（隐藏启动）后从托盘/任务栏唤醒时，
    /// 进程不持有前台权限，SetForegroundWindow 会静默失败，窗口就停在别的窗口后面；
    /// 这里附到当前前台线程的输入队列再设置前台，是 Windows 官方认可的做法。
    /// </summary>
    public static void ForceForeground(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero)
        {
            return;
        }

        // 只对最小化的窗口走 SW_RESTORE：对最大化窗口调用会按系统的还原尺寸改窗口状态，
        // 但 WPF 的 WindowState 仍停在 Maximized，最大化状态就错位了（单实例激活实测复现）。
        // 调用方在进来前都已经 Show() 过窗口，所以非最小化时不需要 ShowWindow。
        if (IsIconic(hwnd))
        {
            ShowWindow(hwnd, SwRestore);
        }

        if (SetForegroundWindow(hwnd))
        {
            return;
        }

        var foreground = GetForegroundWindow();
        var foregroundThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, out _);
        var currentThread = GetCurrentThreadId();
        if (foregroundThread != 0 && foregroundThread != currentThread
            && AttachThreadInput(currentThread, foregroundThread, true))
        {
            try
            {
                SetForegroundWindow(hwnd);
            }
            finally
            {
                AttachThreadInput(currentThread, foregroundThread, false);
            }
        }

        BringWindowToTop(hwnd);
    }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SetWindowsHookEx(
        int idHook,
        LowLevelKeyboardProc callback,
        IntPtr module,
        uint threadId);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SetWindowsHookEx(
        int idHook,
        LowLevelMouseProc callback,
        IntPtr module,
        uint threadId);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool UnhookWindowsHookEx(IntPtr hook);

    [DllImport("user32.dll")]
    public static extern IntPtr CallNextHookEx(IntPtr hook, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr GetModuleHandle(string? moduleName);

    [DllImport("user32.dll")]
    public static extern int GetMessage(out Msg msg, IntPtr hWnd, uint messageFilterMin, uint messageFilterMax);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool TranslateMessage(ref Msg msg);

    [DllImport("user32.dll")]
    public static extern IntPtr DispatchMessage(ref Msg msg);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool PostThreadMessage(uint threadId, int message, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    public static extern short GetKeyState(int virtualKey);

    /// <summary>
    /// Keep the window's restore rect at <paramref name="normal"/> while it is minimized, so the
    /// taskbar brings it back to the size the user had instead of the shrunken animation frame.
    /// </summary>
    public static void SetMinimizedNormalRect(IntPtr hwnd, Rect normal)
    {
        var placement = new WindowPlacement { Length = Marshal.SizeOf<WindowPlacement>() };
        if (!GetWindowPlacement(hwnd, ref placement))
        {
            return;
        }

        placement.ShowCmd = 7; // SW_SHOWMINIMIZED
        placement.NormalPosition = normal;
        SetWindowPlacement(hwnd, ref placement);
    }

    /// <summary>
    /// The move loop is only meaningful while the physical button is held. A stray drag message
    /// (stale page, synthetic event) would otherwise start a modal loop with no button down and
    /// could block the UI thread indefinitely.
    /// </summary>
    public static bool IsLeftButtonDown() => (GetAsyncKeyState(0x01) & 0x8000) != 0;

    /// <summary>
    /// Hands the current pointer drag to the OS caption move loop: snapping, shake and
    /// multi-monitor behaviour then match a normal title bar for free. The lParam carries the
    /// screen point where the pointer went down so the loop keeps the grab offset.
    /// </summary>
    public static void BeginWindowDrag(IntPtr hwnd, int screenX, int screenY)
    {
        ReleaseCapture();
        SendMessage(hwnd, WmNcLButtonDown, (IntPtr)HtCaption, MakeLParam(screenX, screenY));
    }

    /// <summary>Hands a page edge pointerdown to the OS resize loop (borderless window).</summary>
    public static void BeginWindowResize(IntPtr hwnd, int hitTest, int screenX, int screenY)
    {
        ReleaseCapture();
        SendMessage(hwnd, WmNcLButtonDown, (IntPtr)hitTest, MakeLParam(screenX, screenY));
    }

    private static IntPtr MakeLParam(int x, int y) => (IntPtr)((y << 16) | (x & 0xFFFF));
}
