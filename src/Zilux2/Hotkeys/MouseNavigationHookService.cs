using System.Runtime.InteropServices;
using Zilux2.Interop;

namespace Zilux2.Hotkeys;

/// <summary>
/// 鼠标侧键导航：XBUTTON1 = 后退、XBUTTON2 = 前进。
///
/// Chromium 默认会把侧键当成浏览器历史，而本应用是单页应用、历史里只有一条记录，
/// 结果就是「按了没反应，甚至可能整页重载」。这里在 WH_MOUSE_LL 钩子里先把它截下来，
/// 且只在本机窗口被鼠标指到时才处理；其它窗口的侧键原样放行。
/// </summary>
internal sealed class MouseNavigationHookService : IDisposable
{
    private readonly Action<bool> _navigate;
    private readonly NativeMethods.LowLevelMouseProc _callback;
    private readonly ManualResetEventSlim _ready = new(false);
    private readonly HashSet<uint> _swallowedButtons = new();
    private Thread? _thread;
    private uint _threadId;
    private IntPtr _hook;
    private volatile bool _running;
    private uint _ownProcessId;

    /// <param name="navigate">true = 前进，false = 后退。</param>
    public MouseNavigationHookService(Action<bool> navigate)
    {
        _navigate = navigate;
        _callback = OnMouseMessage;
    }

    public bool Start()
    {
        if (_thread is not null)
        {
            return _hook != IntPtr.Zero;
        }

        _ownProcessId = (uint)Environment.ProcessId;
        _running = true;
        _thread = new Thread(ThreadMain)
        {
            IsBackground = true,
            Name = "zilux-mouse-nav-hook",
        };
        _thread.SetApartmentState(ApartmentState.STA);
        _thread.Start();
        _ready.Wait(2500);

        if (_hook == IntPtr.Zero)
        {
            HostLog.Warn("mouseNav.hook install failed");
            return false;
        }

        HostLog.Info("mouseNav.hook installed");
        return true;
    }

    public void Dispose()
    {
        if (_thread is null)
        {
            return;
        }

        _running = false;
        if (_threadId != 0)
        {
            NativeMethods.PostThreadMessage(_threadId, NativeMethods.WmQuit, IntPtr.Zero, IntPtr.Zero);
        }

        if (!_thread.Join(1500))
        {
            HostLog.Warn("mouseNav.hook thread did not exit in time");
        }

        _thread = null;
        _ready.Dispose();
    }

    private void ThreadMain()
    {
        _threadId = NativeMethods.GetCurrentThreadId();
        _hook = NativeMethods.SetWindowsHookEx(
            NativeMethods.WhMouseLl,
            _callback,
            NativeMethods.GetModuleHandle(null),
            0);
        _ready.Set();

        if (_hook == IntPtr.Zero)
        {
            return;
        }

        while (_running)
        {
            var result = NativeMethods.GetMessage(out var message, IntPtr.Zero, 0, 0);
            if (result <= 0)
            {
                break;
            }

            NativeMethods.TranslateMessage(ref message);
            NativeMethods.DispatchMessage(ref message);
        }

        if (_hook != IntPtr.Zero)
        {
            NativeMethods.UnhookWindowsHookEx(_hook);
            _hook = IntPtr.Zero;
            HostLog.Info("mouseNav.hook uninstalled");
        }
    }

    private IntPtr OnMouseMessage(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode < 0 || !_running)
        {
            return NativeMethods.CallNextHookEx(_hook, nCode, wParam, lParam);
        }

        var message = wParam.ToInt32();
        if (message is not (NativeMethods.WmXButtonDown or NativeMethods.WmXButtonUp))
        {
            return NativeMethods.CallNextHookEx(_hook, nCode, wParam, lParam);
        }

        var data = Marshal.PtrToStructure<NativeMethods.MsllHookStruct>(lParam);
        // XBUTTON 的编号在 MouseData 的高 16 位：1 = 后退键，2 = 前进键。
        var button = (data.MouseData >> 16) & 0xFFFF;
        if (button is not (NativeMethods.XButton1 or NativeMethods.XButton2))
        {
            return NativeMethods.CallNextHookEx(_hook, nCode, wParam, lParam);
        }

        if (message == NativeMethods.WmXButtonUp)
        {
            // 按下时吞掉的那一次，抬起也要吞掉，别让前台程序只收到半次。
            if (_swallowedButtons.Remove(button))
            {
                return (IntPtr)1;
            }

            return NativeMethods.CallNextHookEx(_hook, nCode, wParam, lParam);
        }

        if (!IsCursorOverOwnWindow(data.PointX, data.PointY))
        {
            return NativeMethods.CallNextHookEx(_hook, nCode, wParam, lParam);
        }

        _swallowedButtons.Add(button);
        try
        {
            _navigate(button == NativeMethods.XButton2);
        }
        catch (Exception exception)
        {
            HostLog.Warn($"mouseNav.fire failed button={button}: {exception.Message}");
        }

        return (IntPtr)1;
    }

    private bool IsCursorOverOwnWindow(int x, int y)
    {
        var hit = NativeMethods.WindowFromPoint(new NativeMethods.Point { X = x, Y = y });
        if (hit == IntPtr.Zero)
        {
            return false;
        }

        var root = NativeMethods.GetAncestor(hit, NativeMethods.GaRoot);
        NativeMethods.GetWindowThreadProcessId(root, out var processId);
        return processId == _ownProcessId;
    }
}
