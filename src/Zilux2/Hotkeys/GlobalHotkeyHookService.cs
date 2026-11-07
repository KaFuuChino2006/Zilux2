using System.Runtime.InteropServices;
using Zilux2.Interop;

namespace Zilux2.Hotkeys;

/// <summary>
/// 全局热键的底层键盘钩子兜底。RegisterHotKey 有两个天生的坑：
///   1) 组合被别的程序先注册时会直接失败（error=1409），我们只能回落到备用键；
///   2) 前台窗口是管理员权限进程时，WM_HOTKEY 会被 UIPI 拦住不投递。
/// QQ 音乐一类播放器同样靠 RegisterHotKey 注册系统热键，但会把「注册失败」当成常态去处理。
/// 这里在独立线程上装 WH_KEYBOARD_LL：注册成功与否都能看到物理按键，命中配置组合时自己
/// 触发动作并把按键吞掉，行为与 RegisterHotKey 一致（别的窗口收不到）。两个通路同时存在时，
/// 由调用方按「钩子先触发、窗口消息 600ms 内去重」处理。
/// </summary>
internal sealed class GlobalHotkeyHookService : IDisposable
{
    /// <summary>按住不放时，超过这个时长还没收到抬起就当作「抬起丢了」，允许下一次触发。</summary>
    private const int HoldTimeoutMs = 1500;

    private readonly Action<string> _fire;
    private readonly NativeMethods.LowLevelKeyboardProc _callback;
    private readonly ManualResetEventSlim _ready = new(false);
    private readonly object _gate = new();
    private readonly HashSet<uint> _swallowedVks = new();
    private readonly Dictionary<uint, int> _heldSince = new();
    private HotkeyHookBinding[] _bindings = Array.Empty<HotkeyHookBinding>();
    private Thread? _thread;
    private uint _threadId;
    private IntPtr _hook;
    private volatile bool _running;

    public GlobalHotkeyHookService(Action<string> fire)
    {
        _fire = fire;
        _callback = OnKeyboardMessage;
    }

    /// <summary>启动钩子线程并等它完成安装；失败只记日志，不影响 RegisterHotKey 主通路。</summary>
    public bool Start()
    {
        if (_thread is not null)
        {
            return _hook != IntPtr.Zero;
        }

        _running = true;
        _thread = new Thread(ThreadMain)
        {
            IsBackground = true,
            Name = "zilux-hotkey-hook",
        };
        _thread.SetApartmentState(ApartmentState.STA);
        _thread.Start();
        _ready.Wait(2500);

        if (_hook == IntPtr.Zero)
        {
            HostLog.Warn("hotkey.hook install failed");
            return false;
        }

        return true;
    }

    /// <summary>设置变更后更新命中表；空表表示只剩 RegisterHotKey 通路。</summary>
    public void UpdateBindings(IReadOnlyList<HotkeyHookBinding> bindings)
    {
        lock (_gate)
        {
            _bindings = bindings.ToArray();
        }
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
            HostLog.Warn("hotkey.hook thread did not exit in time");
        }

        _thread = null;
        _ready.Dispose();
    }

    private void ThreadMain()
    {
        _threadId = NativeMethods.GetCurrentThreadId();
        _hook = NativeMethods.SetWindowsHookEx(
            NativeMethods.WhKeyboardLl,
            _callback,
            NativeMethods.GetModuleHandle(null),
            0);
        _ready.Set();

        if (_hook == IntPtr.Zero)
        {
            return;
        }

        HostLog.Info("hotkey.hook installed");

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
            HostLog.Info("hotkey.hook uninstalled");
        }
    }

    private IntPtr OnKeyboardMessage(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode < 0 || !_running)
        {
            return NativeMethods.CallNextHookEx(_hook, nCode, wParam, lParam);
        }

        var message = wParam.ToInt32();
        var data = Marshal.PtrToStructure<NativeMethods.KbdLlHookStruct>(lParam);

        if (message is NativeMethods.WmKeyUp or NativeMethods.WmSysKeyUp)
        {
            _heldSince.Remove(data.VirtualKeyCode);
            // 命中时按下与抬起都吞掉，别让前台程序只收到半次按键。
            if (_swallowedVks.Remove(data.VirtualKeyCode))
            {
                return (IntPtr)1;
            }

            return NativeMethods.CallNextHookEx(_hook, nCode, wParam, lParam);
        }

        if (message is not (NativeMethods.WmKeyDown or NativeMethods.WmSysKeyDown))
        {
            return NativeMethods.CallNextHookEx(_hook, nCode, wParam, lParam);
        }

        HotkeyHookBinding[] bindings;
        lock (_gate)
        {
            bindings = _bindings;
        }

        if (bindings.Length == 0)
        {
            return NativeMethods.CallNextHookEx(_hook, nCode, wParam, lParam);
        }

        var modifiers = CurrentModifiers();
        string? action = null;
        foreach (var binding in bindings)
        {
            if (binding.Modifiers == modifiers && binding.VirtualKey == data.VirtualKeyCode)
            {
                action = binding.Action;
                break;
            }
        }

        if (action is null)
        {
            return NativeMethods.CallNextHookEx(_hook, nCode, wParam, lParam);
        }

        // 按住不放的自动重复：同一个键在收到抬起之前只吞不触发；但快速连按（按下-抬起-再按下）
        // 必须立刻响应，所以这里不看时间窗口，只看「这次按下之前有没有抬起」。
        var now = Environment.TickCount;
        if (_swallowedVks.Contains(data.VirtualKeyCode))
        {
            _heldSince.TryGetValue(data.VirtualKeyCode, out var heldSince);
            if (now - heldSince < HoldTimeoutMs)
            {
                return (IntPtr)1;
            }

            // 抬起消息丢了（例如钩子刚装上/切了前台）：超过握持上限就当新的一次按下。
            _swallowedVks.Remove(data.VirtualKeyCode);
        }

        _swallowedVks.Add(data.VirtualKeyCode);
        _heldSince[data.VirtualKeyCode] = now;

        try
        {
            _fire(action);
        }
        catch (Exception exception)
        {
            HostLog.Warn($"hotkey.hook fire failed action={action}: {exception.Message}");
        }

        return (IntPtr)1;
    }

    private static uint CurrentModifiers()
    {
        // 必须用 GetAsyncKeyState：低层钩子回调跑在自己的线程上，GetKeyState 只看本线程
        // 消息队列的按键状态，别的线程/注入的输入在这里永远是「没按下」。
        static bool Down(int virtualKey) => (NativeMethods.GetAsyncKeyState(virtualKey) & 0x8000) != 0;

        var modifiers = 0u;
        if (Down(NativeMethods.VkControl))
        {
            modifiers |= NativeMethods.ModControl;
        }

        if (Down(NativeMethods.VkMenu))
        {
            modifiers |= NativeMethods.ModAlt;
        }

        if (Down(NativeMethods.VkShift))
        {
            modifiers |= NativeMethods.ModShift;
        }

        if (Down(NativeMethods.VkLWin) || Down(NativeMethods.VkRWin))
        {
            modifiers |= NativeMethods.ModWin;
        }

        return modifiers;
    }
}

internal readonly record struct HotkeyHookBinding(uint Modifiers, uint VirtualKey, string Action);
