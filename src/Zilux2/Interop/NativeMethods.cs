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
    public const int HtBottom = 15;
    public const uint MonitorDefaultToNearest = 2;
    public const uint SwpNoZOrder = 0x0004;
    public const uint SwpNoActivate = 0x0010;

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

    [DllImport("gdi32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool DeleteObject(IntPtr hObject);

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
    /// multi-monitor behaviour then match a normal title bar for free.
    /// </summary>
    public static void BeginWindowDrag(IntPtr hwnd)
    {
        ReleaseCapture();
        SendMessage(hwnd, WmNcLButtonDown, (IntPtr)HtCaption, IntPtr.Zero);
    }

    /// <summary>Hands a page edge pointerdown to the OS resize loop (borderless window).</summary>
    public static void BeginWindowResize(IntPtr hwnd, int hitTest)
    {
        ReleaseCapture();
        SendMessage(hwnd, WmNcLButtonDown, (IntPtr)hitTest, IntPtr.Zero);
    }
}
