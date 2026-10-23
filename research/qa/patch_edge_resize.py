import io

native_path = r'E:\Zilux2开发\src\Zilux2\Interop\NativeMethods.cs'
window_path = r'E:\Zilux2开发\src\Zilux2\MainWindow.xaml.cs'
host_path = r'E:\Zilux2开发\src\Zilux2\WebViewHost.cs'
bridge_path = r'E:\Zilux2开发\web\src\core\bridge.ts'


def load(p):
    with io.open(p, 'r', encoding='utf-8', newline='') as f:
        return f.read()


def save(p, text):
    with io.open(p, 'w', encoding='utf-8', newline='') as f:
        f.write(text)


def sub(text, name, old, new):
    nl = '\r\n' if '\r\n' in text else '\n'
    old = old.replace('\n', nl)
    new = new.replace('\n', nl)
    got = text.count(old)
    assert got == 1, '%s: expected 1, got %d' % (name, got)
    return text.replace(old, new)


# 1) NativeMethods: hit-test 常量 + 开始缩放
native = load(native_path)
native = sub(
    native,
    'native constants',
    "    public const int HtCaption = 2;",
    """    public const int HtCaption = 2;
    public const int HtLeft = 10;
    public const int HtRight = 11;
    public const int HtTop = 12;
    public const int HtBottom = 15;""",
)
native = sub(
    native,
    'native BeginWindowResize',
    """    public static void BeginWindowDrag(IntPtr hwnd)
    {
        ReleaseCapture();
        SendMessage(hwnd, WmNcLButtonDown, (IntPtr)HtCaption, IntPtr.Zero);
    }
}""",
    """    public static void BeginWindowDrag(IntPtr hwnd)
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
}""",
)
save(native_path, native)
print('NativeMethods resize')

# 2) MainWindow: BeginResize(edge)
window = load(window_path)
window = sub(
    window,
    'window BeginResize',
    """    public void BeginDrag()
    {""",
    """    public void BeginResize(string edge)
    {
        if (_hwnd == IntPtr.Zero)
        {
            return;
        }

        var hitTest = edge switch
        {
            "left" => NativeMethods.HtLeft,
            "right" => NativeMethods.HtRight,
            "top" => NativeMethods.HtTop,
            "bottom" => NativeMethods.HtBottom,
            _ => 0,
        };
        if (hitTest == 0)
        {
            return;
        }

        CancelPendingDrag("resize");
        if (!IsActive)
        {
            Activate();
        }

        NativeMethods.BeginWindowResize(_hwnd, hitTest);
    }

    public void BeginDrag()
    {""",
)
save(window_path, window)
print('MainWindow.BeginResize')

# 3) WebViewHost: 消息 type=resize
host = load(host_path)
host = sub(
    host,
    'host resize case',
    """                case "drag":
                    HostLog.Info("page.drag: handing pointer to the OS move loop");
                    _window.BeginDrag();
                    break;""",
    """                case "drag":
                    HostLog.Info("page.drag: handing pointer to the OS move loop");
                    _window.BeginDrag();
                    break;

                case "resize":
                    _window.BeginResize(ReadString(root, "edge"));
                    break;""",
)
save(host_path, host)
print('WebViewHost resize case')

# 4) bridge.ts: host.resize()
bridge = load(bridge_path)
bridge = sub(
    bridge,
    'bridge resize',
    """  drag(): void {
    post({ v: 1, type: 'drag' });
  },""",
    """  drag(): void {
    post({ v: 1, type: 'drag' });
  },
  /** 无边框窗口：把边缘 pointerdown 交回系统缩放循环。 */
  resize(edge: 'left' | 'right' | 'top' | 'bottom'): void {
    post({ v: 1, type: 'resize', edge });
  },""",
)
save(bridge_path, bridge)
print('bridge resize')
