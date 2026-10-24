using System.Text.Json.Serialization;

namespace Zilux2.Hotkeys;

/// <summary>
/// host → page：全局快捷键的生效状态（docs/zilux2-settings-contract.md §3.3）。
/// 每次应用热键后回推，页面 ready 后补推一次，供设置面板显示「已生效 / 已回落 / 被占用 / 未启用」。
/// </summary>
internal sealed class HostShortcutsMessage
{
    public int V { get; set; } = 1;

    public string Type { get; set; } = "host";

    public string Event { get; set; } = "shortcuts";

    public ShortcutState State { get; set; } = new();
}

internal sealed class ShortcutState
{
    public bool Enabled { get; set; } = true;

    public List<ShortcutItemState> Items { get; set; } = new();
}

/// <summary>一条热键的应用结果。<c>error</c> 为空表示已生效。</summary>
internal sealed class ShortcutItemState
{
    public int Id { get; set; }

    public string Action { get; set; } = string.Empty;

    /// <summary>设置里的原始字符串；空字符串表示该条被用户关闭。</summary>
    public string Configured { get; set; } = string.Empty;

    /// <summary>实际注册成功的组合键（规范显示名）；未注册为空。</summary>
    public string Applied { get; set; } = string.Empty;

    public bool Ok { get; set; }

    /// <summary>实际生效的组合与配置值不同（默认值候选链回落，或非法值保留上次可用注册）。</summary>
    public bool Fallback { get; set; }

    /// <summary>未生效原因：disabled / empty / invalid / error=&lt;win32 错误码&gt;；成功为空。</summary>
    public string Error { get; set; } = string.Empty;

    public ShortcutItemState Clone() => new()
    {
        Id = Id,
        Action = Action,
        Configured = Configured,
        Applied = Applied,
        Ok = Ok,
        Fallback = Fallback,
        Error = Error,
    };
}

[JsonSourceGenerationOptions(WriteIndented = false, PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(HostShortcutsMessage))]
internal sealed partial class HotkeyJsonContext : JsonSerializerContext
{
}
