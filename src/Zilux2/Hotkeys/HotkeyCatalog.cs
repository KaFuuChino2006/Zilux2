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
        // 以下为「不常用但值得给全局键」的动作：默认不绑定，用户在设置里录制后才注册。
        new(5, "volumeUp", "volumeUp", string.Empty, Array.Empty<string>()),
        new(6, "volumeDown", "volumeDown", string.Empty, Array.Empty<string>()),
        new(7, "mute", "mute", string.Empty, Array.Empty<string>()),
        new(8, "like", "like", string.Empty, Array.Empty<string>()),
        new(9, "mode", "mode", string.Empty, Array.Empty<string>()),
        new(10, "mini", "mini", string.Empty, Array.Empty<string>()),
        new(11, "desktopLyrics", "desktopLyrics", string.Empty, Array.Empty<string>()),
        new(12, "crossfade", "crossfade", string.Empty, Array.Empty<string>()),
        // 音频通路：appOutput 切本软件输出（跟随系统 ↔ 指定设备），systemOutput 切 Windows 默认输出。
        new(13, "appOutput", "appOutput", string.Empty, Array.Empty<string>()),
        new(14, "systemOutput", "systemOutput", string.Empty, Array.Empty<string>()),
    };

    /// <summary>读取 settings.shortcuts 中对应字段（switch 而不是反射，热键应用只在 UI 线程跑）。</summary>
    internal static string ConfiguredValue(ShortcutSettings settings, string settingKey) => settingKey switch
    {
        "playPause" => settings.PlayPause,
        "prev" => settings.Prev,
        "next" => settings.Next,
        "toggleWindow" => settings.ToggleWindow,
        "volumeUp" => settings.VolumeUp,
        "volumeDown" => settings.VolumeDown,
        "mute" => settings.Mute,
        "like" => settings.Like,
        "mode" => settings.Mode,
        "mini" => settings.Mini,
        "desktopLyrics" => settings.DesktopLyrics,
        "crossfade" => settings.Crossfade,
        "appOutput" => settings.AppOutput,
        "systemOutput" => settings.SystemOutput,
        _ => string.Empty,
    };
}
