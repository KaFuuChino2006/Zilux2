namespace Zilux2.Wallpaper.Model;

/// <summary>
/// 一个画布的当前状态（canvases 表，第 27 轮：两画布共用素材库但各选各的）。
/// 软件内一行；桌面层每块屏一行（第 25 轮）。
/// </summary>
internal sealed class CanvasState
{
    public long Id { get; set; }

    public CanvasKind Kind { get; set; }

    /// <summary>桌面层用显示器 ID（MonitorCatalog 的稳定键）；软件内为 null。</summary>
    public string? MonitorId { get; set; }

    /// <summary>当前单张壁纸；与 SequenceId 二选一。</summary>
    public long? AssetId { get; set; }

    /// <summary>当前序列；为 null 时用 AssetId。</summary>
    public long? SequenceId { get; set; }

    /// <summary>适配方式覆盖：cover/contain/fill/stretch；null = 智能自动（第 52 轮）。</summary>
    public string? FitMode { get; set; }

    /// <summary>滤镜参数 JSON（暗化/模糊/亮度/对比度/饱和度，第 53 轮）。</summary>
    public string? FilterJson { get; set; }

    /// <summary>转场预设 ID；null = 跟随全局默认（第 56 轮）。</summary>
    public string? TransitionId { get; set; }

    public bool Paused { get; set; }

    public long UpdatedAt { get; set; }
}

/// <summary>序列（第 85 轮）：有序列表，单条可设时长与转场，可绑画布。</summary>
internal sealed class WallpaperSequence
{
    public long Id { get; set; }

    public string Name { get; set; } = string.Empty;

    /// <summary>绑定画布；null = 两个画布都能用。</summary>
    public CanvasKind? Canvas { get; set; }

    public bool Loop { get; set; } = true;

    public List<SequenceItem> Items { get; } = new();
}

/// <summary>序列里的一条。</summary>
internal sealed class SequenceItem
{
    public long Id { get; set; }

    public long SequenceId { get; set; }

    public long AssetId { get; set; }

    public int Sort { get; set; }

    /// <summary>本条的停留时长；null = 用轮换间隔或素材自身长度。</summary>
    public long? DurationMs { get; set; }

    /// <summary>本条的转场预设 ID；null = 跟随全局。</summary>
    public string? TransitionId { get; set; }
}

/// <summary>合辑（第 64 轮：扁平多对多，内置三类用 builtin 标记）。</summary>
internal sealed class WallpaperCollection
{
    public long Id { get; set; }

    public string Name { get; set; } = string.Empty;

    /// <summary>内置合辑键：all / favorites / recent / unsorted；自定义为 null。</summary>
    public string? Builtin { get; set; }

    public int Sort { get; set; }

    /// <summary>成员数，列表时填。</summary>
    public int Count { get; set; }
}

/// <summary>配置预设（第 83 轮：滤镜 + 转场 + 轮换间隔 + 可视化开关，不含壁纸选择）。</summary>
internal sealed class WallpaperPreset
{
    public long Id { get; set; }

    public string Name { get; set; } = string.Empty;

    /// <summary>manual = 用户手动切换；appearance = 由明暗主题/时段自动触发（第 84 轮）。</summary>
    public string Kind { get; set; } = "manual";

    /// <summary>预设载荷 JSON，键名与 SettingsModel.Wallpaper 的对应字段一致。</summary>
    public string PayloadJson { get; set; } = "{}";
}

/// <summary>条件规则（第 58 轮：时段 / 前台应用 / 电量，可拖拽排序）。</summary>
internal sealed class WallpaperRule
{
    public long Id { get; set; }

    public string Name { get; set; } = string.Empty;

    public bool Enabled { get; set; } = true;

    /// <summary>数值越小越优先。</summary>
    public int Priority { get; set; }

    /// <summary>条件 JSON：{ timeRanges: [{from:"08:00",to:"18:00",days:[1..7]}], apps: ["xxx.exe"], power: "ac"|"battery" }。</summary>
    public string ConditionJson { get; set; } = "{}";

    /// <summary>动作 JSON：{ presetId?: number, collectionId?: number, sequenceId?: number, assetId?: number }。</summary>
    public string ActionJson { get; set; } = "{}";
}
