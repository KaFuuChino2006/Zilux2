using Zilux2.Interop;

namespace Zilux2.Hotkeys;

/// <summary>
/// RegisterHotKey 风格的组合键（修饰符 + 虚拟键）。设置里的字符串格式见
/// docs/zilux2-settings-contract.md §2：修饰键 <c>Ctrl</c>/<c>Alt</c>/<c>Shift</c>/<c>Win</c>
/// （大小写不限、顺序任意、允许 <c>Control</c>/<c>Meta</c> 别名）+ 一个键名；至少要有 1 个修饰键
/// 或键名是 F1-F24（例如单独 <c>F5</c> 合法，单独 <c>A</c>/<c>Space</c> 非法）。
/// </summary>
internal readonly record struct HotkeyBinding(uint Modifiers, uint VirtualKey, string Key)
{
    public override string ToString() => Key;

    /// <summary>
    /// 解析用户配置。失败返回 false（调用方保留上一次可用注册），成功时 <see cref="Key"/> 是
    /// 固定顺序的规范显示名（Ctrl+Alt+Shift+Win+Key），可以直接和默认值比较、写日志、回推页面。
    /// </summary>
    public static bool TryParse(string? text, out HotkeyBinding binding)
    {
        binding = default;
        if (string.IsNullOrWhiteSpace(text))
        {
            return false;
        }

        var modifiers = 0u;
        var virtualKey = 0u;

        foreach (var rawToken in text.Split('+'))
        {
            var token = rawToken.Trim();
            if (token.Length == 0)
            {
                return false;
            }

            if (TryParseModifier(token, out var modifier))
            {
                modifiers |= modifier;
                continue;
            }

            // 非修饰键只允许出现一次：重复键名或修饰符之后又跟键名都视为非法，避免歧义。
            if (virtualKey != 0 || !TryParseKey(token, out virtualKey))
            {
                return false;
            }
        }

        if (virtualKey == 0)
        {
            return false;
        }

        // 无修饰键时只接受功能键，否则会抢走打字等正常按键。
        if (modifiers == 0 && !IsFunctionKey(virtualKey))
        {
            return false;
        }

        binding = new HotkeyBinding(modifiers, virtualKey, Format(modifiers, virtualKey));
        return true;
    }

    /// <summary>规范显示名；用于默认值比较与日志（保证 "control+alt+left" 和默认值等价）。</summary>
    internal static string Format(uint modifiers, uint virtualKey)
    {
        var parts = new List<string>(5);
        if ((modifiers & NativeMethods.ModControl) != 0)
        {
            parts.Add("Ctrl");
        }

        if ((modifiers & NativeMethods.ModAlt) != 0)
        {
            parts.Add("Alt");
        }

        if ((modifiers & NativeMethods.ModShift) != 0)
        {
            parts.Add("Shift");
        }

        if ((modifiers & NativeMethods.ModWin) != 0)
        {
            parts.Add("Win");
        }

        parts.Add(KeyName(virtualKey));
        return string.Join("+", parts);
    }

    internal static bool IsFunctionKey(uint virtualKey) => virtualKey is >= 0x70 and <= 0x87;

    internal static string KeyName(uint virtualKey)
    {
        if (virtualKey is >= 0x41 and <= 0x5A)
        {
            return ((char)virtualKey).ToString();
        }

        if (virtualKey is >= 0x30 and <= 0x39)
        {
            return ((char)virtualKey).ToString();
        }

        if (IsFunctionKey(virtualKey))
        {
            return "F" + (virtualKey - 0x70 + 1);
        }

        return virtualKey switch
        {
            0x20 => "Space",
            0x09 => "Tab",
            0x0D => "Enter",
            0x1B => "Esc",
            0x08 => "Backspace",
            0x2E => "Delete",
            0x2D => "Insert",
            0x24 => "Home",
            0x23 => "End",
            0x21 => "PageUp",
            0x22 => "PageDown",
            0x26 => "Up",
            0x28 => "Down",
            0x25 => "Left",
            0x27 => "Right",
            _ => "Key" + virtualKey.ToString("X2"),
        };
    }

    private static bool TryParseModifier(string token, out uint modifier)
    {
        switch (token.ToLowerInvariant())
        {
            case "ctrl":
            case "control":
                modifier = NativeMethods.ModControl;
                return true;
            case "alt":
                modifier = NativeMethods.ModAlt;
                return true;
            case "shift":
                modifier = NativeMethods.ModShift;
                return true;
            case "win":
            case "meta":
                modifier = NativeMethods.ModWin;
                return true;
            default:
                modifier = 0;
                return false;
        }
    }

    private static bool TryParseKey(string token, out uint virtualKey)
    {
        virtualKey = 0;
        var name = token.ToLowerInvariant();

        if (name.Length == 1)
        {
            var upper = char.ToUpperInvariant(token[0]);
            if (upper is >= 'A' and <= 'Z' or >= '0' and <= '9')
            {
                virtualKey = upper;
                return true;
            }
        }

        if (name.Length is >= 2 and <= 3 && name[0] == 'f' &&
            int.TryParse(name.AsSpan(1), out var functionNumber) &&
            functionNumber is >= 1 and <= 24)
        {
            virtualKey = (uint)(0x70 + functionNumber - 1);
            return true;
        }

        switch (name)
        {
            case "space":
                virtualKey = 0x20;
                return true;
            case "tab":
                virtualKey = 0x09;
                return true;
            case "enter":
            case "return":
                virtualKey = 0x0D;
                return true;
            case "esc":
            case "escape":
                virtualKey = 0x1B;
                return true;
            case "backspace":
                virtualKey = 0x08;
                return true;
            case "delete":
            case "del":
                virtualKey = 0x2E;
                return true;
            case "insert":
            case "ins":
                virtualKey = 0x2D;
                return true;
            case "home":
                virtualKey = 0x24;
                return true;
            case "end":
                virtualKey = 0x23;
                return true;
            case "pageup":
            case "pgup":
                virtualKey = 0x21;
                return true;
            case "pagedown":
            case "pgdn":
                virtualKey = 0x22;
                return true;
            case "up":
            case "arrowup":
                virtualKey = 0x26;
                return true;
            case "down":
            case "arrowdown":
                virtualKey = 0x28;
                return true;
            case "left":
            case "arrowleft":
                virtualKey = 0x25;
                return true;
            case "right":
            case "arrowright":
                virtualKey = 0x27;
                return true;
            default:
                return false;
        }
    }
}
