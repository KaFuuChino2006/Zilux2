namespace Zilux2.Wallpaper.Model;

/// <summary>
/// 一条素材记录（wallpaper.db 的 assets 表）。
/// 字段与 docs/wallpaper-v2-spec.md §4 一一对应，改名要同步改库表和前端 API。
/// </summary>
internal sealed class WallpaperAsset
{
    public long Id { get; set; }

    /// <summary>SHA-256 全文哈希，去重用（第 36 轮）。</summary>
    public string Hash { get; set; } = string.Empty;

    /// <summary>绝对路径。导入副本指向 Library，监控与工坊指向原始位置。</summary>
    public string Path { get; set; } = string.Empty;

    public AssetSource Source { get; set; }

    public AssetKind Kind { get; set; }

    public int? Width { get; set; }

    public int? Height { get; set; }

    /// <summary>视频时长；图片为 null。</summary>
    public long? DurationMs { get; set; }

    public double? Fps { get; set; }

    public long? SizeBytes { get; set; }

    /// <summary>封面图路径（工坊用自带 preview.gif，本地视频抽帧，第 62 轮）。</summary>
    public string? CoverPath { get; set; }

    /// <summary>抽帧时间点，自动跳黑场后的结果。</summary>
    public long? CoverTimeMs { get; set; }

    /// <summary>片段入点（第 80 轮），null = 从 0 开始。</summary>
    public long? TrimInMs { get; set; }

    /// <summary>片段出点，null = 到片尾。</summary>
    public long? TrimOutMs { get; set; }

    /// <summary>播放速度 0.5–2.0。</summary>
    public double Speed { get; set; } = 1.0;

    public WallpaperTransform Transform { get; set; } = new();

    /// <summary>单张覆盖的适配方式（cover/contain/fill/stretch），null = 跟随全局智能适配。</summary>
    public string? FitOverride { get; set; }

    /// <summary>文件已失联（第 13 轮：标灰 + 原因，等路径修复）。</summary>
    public bool Missing { get; set; }

    public long AddedAt { get; set; }

    public long? LastSeenAt { get; set; }

    /// <summary>显示名：默认取文件名（去扩展名），可在详情里改。</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>片段有效长度：出点 - 入点，缺省用总时长。</summary>
    public long EffectiveDurationMs
    {
        get
        {
            var total = DurationMs ?? 0;
            if (total <= 0) return 0;
            var start = Math.Clamp(TrimInMs ?? 0, 0, total);
            var end = Math.Clamp(TrimOutMs ?? total, start, total);
            var span = end - start;
            if (span <= 0) return total;
            return (long)(span / Math.Clamp(Speed <= 0 ? 1.0 : Speed, 0.5, 2.0));
        }
    }
}
