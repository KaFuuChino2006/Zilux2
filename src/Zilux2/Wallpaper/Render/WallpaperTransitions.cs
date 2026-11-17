namespace Zilux2.Wallpaper.Render;

/// <summary>
/// 转场预设（规格书 §5.3 / 第 11–12 轮）：表驱动，新增一种只要在枚举与 <see cref="WallpaperTransitions"/>
/// 里各加一处，渲染层按 id 分支即可，不用改调度代码。
/// </summary>
internal enum WallpaperTransitionId
{
    /// <summary>交叉淡化。</summary>
    Fade,

    /// <summary>黑场：压黑 → 换画 → 提亮。</summary>
    FadeBlack,

    /// <summary>白闪：过曝白 → 换画 → 落回。</summary>
    FadeWhite,

    /// <summary>左推：新画面从右侧推进。</summary>
    SlideLeft,

    /// <summary>右推：新画面从左侧推进。</summary>
    SlideRight,

    /// <summary>上滑：新画面从下方升起。</summary>
    SlideUp,

    /// <summary>缩放推近。</summary>
    ZoomIn,

    /// <summary>模糊叠化。</summary>
    BlurDissolve,

    /// <summary>径向模糊（缩放 + 模糊叠加）。</summary>
    RadialBlur,

    /// <summary>曝光过渡。</summary>
    Exposure,

    /// <summary>故障风：位移抖动 + 明暗闪。</summary>
    Glitch,

    /// <summary>胶片颗粒（近似：抖动 + 灰白叠层）。</summary>
    FilmGrain,

    /// <summary>斑点溶解（近似：不透明度分档硬切）。</summary>
    DissolveNoise,

    /// <summary>水波纹（近似：正弦缩放 + 模糊波动）。</summary>
    Ripple,
}

/// <summary>转场元数据：持久化用的稳定键、中文名、是否为随机池成员。</summary>
internal static class WallpaperTransitions
{
    public static readonly WallpaperTransitionId[] All =
    [
        WallpaperTransitionId.Fade,
        WallpaperTransitionId.FadeBlack,
        WallpaperTransitionId.FadeWhite,
        WallpaperTransitionId.SlideLeft,
        WallpaperTransitionId.SlideRight,
        WallpaperTransitionId.SlideUp,
        WallpaperTransitionId.ZoomIn,
        WallpaperTransitionId.BlurDissolve,
        WallpaperTransitionId.RadialBlur,
        WallpaperTransitionId.Exposure,
        WallpaperTransitionId.Glitch,
        WallpaperTransitionId.FilmGrain,
        WallpaperTransitionId.DissolveNoise,
        WallpaperTransitionId.Ripple,
    ];

    /// <summary>旧数据里可能出现的兼容名（历史 spec 用过连字符）。</summary>
    public static string Key(WallpaperTransitionId id) => id switch
    {
        WallpaperTransitionId.Fade => "fade",
        WallpaperTransitionId.FadeBlack => "fade-black",
        WallpaperTransitionId.FadeWhite => "fade-white",
        WallpaperTransitionId.SlideLeft => "slide-left",
        WallpaperTransitionId.SlideRight => "slide-right",
        WallpaperTransitionId.SlideUp => "slide-up",
        WallpaperTransitionId.ZoomIn => "zoom-in",
        WallpaperTransitionId.BlurDissolve => "blur-dissolve",
        WallpaperTransitionId.RadialBlur => "radial-blur",
        WallpaperTransitionId.Exposure => "exposure",
        WallpaperTransitionId.Glitch => "glitch",
        WallpaperTransitionId.FilmGrain => "film-grain",
        WallpaperTransitionId.DissolveNoise => "dissolve-noise",
        _ => "ripple",
    };

    public static string Label(WallpaperTransitionId id) => id switch
    {
        WallpaperTransitionId.Fade => "交叉淡化",
        WallpaperTransitionId.FadeBlack => "黑场",
        WallpaperTransitionId.FadeWhite => "白闪",
        WallpaperTransitionId.SlideLeft => "左推",
        WallpaperTransitionId.SlideRight => "右推",
        WallpaperTransitionId.SlideUp => "上滑",
        WallpaperTransitionId.ZoomIn => "缩放推近",
        WallpaperTransitionId.BlurDissolve => "模糊叠化",
        WallpaperTransitionId.RadialBlur => "径向模糊",
        WallpaperTransitionId.Exposure => "曝光",
        WallpaperTransitionId.Glitch => "故障风",
        WallpaperTransitionId.FilmGrain => "胶片颗粒",
        WallpaperTransitionId.DissolveNoise => "斑点溶解",
        _ => "水波纹",
    };

    public static WallpaperTransitionId? Parse(string? key)
    {
        if (string.IsNullOrWhiteSpace(key)) return null;
        var normalized = key.Trim().Replace('_', '-').ToLowerInvariant();
        // "crossfade" 是旧默认值（已改成 "fade"），配置里可能还留着，按同义处理。
        if (normalized == "crossfade") return WallpaperTransitionId.Fade;
        foreach (var id in All)
        {
            if (Key(id) == normalized) return id;
        }

        return null;
    }

    /// <summary>随机取一种（第 56 轮：默认随机预设）。</summary>
    public static WallpaperTransitionId PickRandom() => All[Random.Shared.Next(All.Length)];
}
