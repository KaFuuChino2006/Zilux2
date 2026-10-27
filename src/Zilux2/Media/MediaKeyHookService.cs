using System.Runtime.InteropServices;
using Zilux2.Interop;

namespace Zilux2.Media;

/// <summary>
/// 系统媒体键接管。Windows 的媒体键（播放/暂停、上一首、下一首）会被别的程序用
/// RegisterHotKey 抢注（例如 QQ 音乐），一旦被抢注，本机 SMTC 就永远收不到 ButtonPressed，
/// 媒体键会一直控制那个程序。底层键盘钩子（WH_KEYBOARD_LL）在注册争抢之外仍能看到这些按键，
/// 所以这里在「Zilux2 是当前媒体会话」时把媒体键吞下、走自家命令链，其余情况原样放行——
/// 尽量贴近系统「媒体键跟着当前播放器走」的原生行为（Windows 会把媒体键优先交给当前媒体会话）。
/// </summary>
internal sealed class MediaKeyHookService : IDisposable
{
    private readonly Func<bool> _shouldHandle;
    private readonly Action<string> _onFire;
    private readonly NativeMethods.LowLevelKeyboardProc _callback;
    private readonly HashSet<uint> _consumed = new();
    private IntPtr _hook;
    private bool _disposed;

    public MediaKeyHookService(Func<bool> shouldHandle, Action<string> onFire)
    {
        _shouldHandle = shouldHandle;
        _onFire = onFire;
        _callback = OnKeyboardMessage;
    }

    /// <summary>在 UI 线程（有消息循环）安装全局底层键盘钩子；失败只记日志，不影响其它功能。</summary>
    public bool Install()
    {
        if (_hook != IntPtr.Zero || _disposed)
        {
            return _hook != IntPtr.Zero;
        }

        try
        {
            _hook = NativeMethods.SetWindowsHookEx(
                NativeMethods.WhKeyboardLl,
                _callback,
                NativeMethods.GetModuleHandle(null),
                0);
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[mediakey] hook install failed: {exception.Message}");
        }

        if (_hook == IntPtr.Zero)
        {
            return false;
        }

        HostLog.Info("[mediakey] hook installed");
        return true;
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        var hook = _hook;
        _hook = IntPtr.Zero;
        if (hook == IntPtr.Zero)
        {
            return;
        }

        try
        {
            if (!NativeMethods.UnhookWindowsHookEx(hook))
            {
                HostLog.Warn($"[mediakey] hook uninstall failed error={Marshal.GetLastWin32Error()}");
            }
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[mediakey] hook uninstall failed: {exception.Message}");
        }
    }

    private IntPtr OnKeyboardMessage(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode < 0 || _disposed)
        {
            return NativeMethods.CallNextHookEx(_hook, nCode, wParam, lParam);
        }

        var message = wParam.ToInt32();
        var isDown = message is NativeMethods.WmKeyDown or NativeMethods.WmSysKeyDown;
        var isUp = message is NativeMethods.WmKeyUp or NativeMethods.WmSysKeyUp;
        if (!isDown && !isUp)
        {
            return NativeMethods.CallNextHookEx(_hook, nCode, wParam, lParam);
        }

        var data = Marshal.PtrToStructure<NativeMethods.KbdLlHookStruct>(lParam);
        var action = data.VirtualKeyCode switch
        {
            NativeMethods.VkMediaNextTrack => "next",
            NativeMethods.VkMediaPrevTrack => "prev",
            NativeMethods.VkMediaPlayPause => "togglePlay",
            // 停止键（VK_MEDIA_STOP）和别的不在接管范围，交给系统/占用方。
            _ => null,
        };

        if (action is null)
        {
            return NativeMethods.CallNextHookEx(_hook, nCode, wParam, lParam);
        }

        if (isDown)
        {
            bool handle;
            try
            {
                handle = _shouldHandle();
            }
            catch (Exception exception)
            {
                HostLog.Warn($"[mediakey] should-handle failed: {exception.Message}");
                handle = false;
            }

            if (!handle)
            {
                return NativeMethods.CallNextHookEx(_hook, nCode, wParam, lParam);
            }

            // 按住不放时 Windows 会重复 keydown；一次物理按压只触发一次。
            if (_consumed.Add(data.VirtualKeyCode))
            {
                try
                {
                    _onFire(action);
                }
                catch (Exception exception)
                {
                    HostLog.Warn($"[mediakey] fire failed: {exception.Message}");
                }
            }

            return (IntPtr)1;
        }

        // 把配对的 keyup 也吃掉，避免其它程序只看到「抬起」。
        if (_consumed.Remove(data.VirtualKeyCode))
        {
            return (IntPtr)1;
        }

        return NativeMethods.CallNextHookEx(_hook, nCode, wParam, lParam);
    }
}
