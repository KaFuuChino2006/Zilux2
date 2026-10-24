using Zilux2.Settings;

namespace Zilux2.Hotkeys;

/// <summary>
/// 一条可配置的全局热键：<paramref name="Id"/> 是 RegisterHotKey 的标识，<paramref name="Action"/>
/// 与页面 command / 托盘菜单共用语义，<paramref name="SettingKey"/> 是 settings.shortcuts 下的字段名。
/// </summary>
internal sealed record HotkeyActionSpec(
    int Id,
    string Action,
    string SettingKey,
    string DefaultValue,
    string[] FallbackCandidates);

internal static class HotkeyCatalog
{
    internal static readonly HotkeyActionSpec[] Actions =
    {
        new(1, "togglePlay", "playPause", ShortcutSettings.DefaultPlayPause, Array.Empty<string>()),
        // Ctrl+Alt+Left/Right 在部分机器被输入法/显卡驱动/远程桌面占用（真机实测 error=1409）；
        // 仍是默认值时按候选链回落，用户改过的组合只注册配置值（见 MainWindow.ApplyShortcutSettings）。
        new(2, "prev", "prev", ShortcutSettings.DefaultPrev, new[] { "Ctrl+Alt+Shift+Left", "Ctrl+Alt+J" }),
        new(3, "next", "next", ShortcutSettings.DefaultNext, new[] { "Ctrl+Alt+Shift+Right", "Ctrl+Alt+K" }),
        new(4, "toggleWindow", "toggleWindow", ShortcutSettings.DefaultToggleWindow, Array.Empty<string>()),
    };

    /// <summary>读取 settings.shortcuts 中对应字段（switch 而不是反射，热键应用只在 UI 线程跑）。</summary>
    internal static string ConfiguredValue(ShortcutSettings settings, string settingKey) => settingKey switch
    {
        "playPause" => settings.PlayPause,
        "prev" => settings.Prev,
        "next" => settings.Next,
        "toggleWindow" => settings.ToggleWindow,
        _ => string.Empty,
    };
}
