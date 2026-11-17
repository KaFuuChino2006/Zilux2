namespace Zilux2.Wallpaper.Model;

/// <summary>素材类型。scene / web 壁纸已不在支持范围（第 29 轮）。</summary>
internal enum AssetKind
{
    Video,
    Image,
    Gif,
}

/// <summary>素材来源（第 2 轮、第 33 轮）：导入副本、目录监控、Wallpaper Engine 工坊。</summary>
internal enum AssetSource
{
    /// <summary>手动添加，文件已复制进 Library。</summary>
    Import,

    /// <summary>监控目录里发现的，引用原路径。</summary>
    Watch,

    /// <summary>Wallpaper Engine 工坊（project.json 里有 video 文件），引用原路径。</summary>
    Workshop,
}

/// <summary>画布：软件内背景层 / 桌面层（第 24 轮两套都做）。</summary>
internal enum CanvasKind
{
    InApp,
    Desktop,
}

/// <summary>画面变换（第 86 轮：逐张全能力）。</summary>
internal sealed class WallpaperTransform
{
    /// <summary>水平镜像。</summary>
    public bool MirrorH { get; set; }

    /// <summary>垂直镜像。</summary>
    public bool MirrorV { get; set; }

    /// <summary>顺时针旋转角度，只允许 0 / 90 / 180 / 270。</summary>
    public int Rotation { get; set; }

    /// <summary>裁剪百分比（0–45），四边各自裁掉的比例。</summary>
    public double CropLeft { get; set; }

    public double CropTop { get; set; }

    public double CropRight { get; set; }

    public double CropBottom { get; set; }

    /// <summary>缩放倍数（1–3，1 为原始大小）。裁剪后想再放大一点就靠它。</summary>
    public double Zoom { get; set; } = 1;

    /// <summary>画面模糊半径（px，0–24）。只作用在画面本身，不影响上层 UI。</summary>
    public double Blur { get; set; }

    /// <summary>是否为恒等变换（恒等时渲染路径完全跳过采样矩阵）。</summary>
    public bool IsIdentity =>
        !MirrorH && !MirrorV && Rotation == 0
        && CropLeft <= 0 && CropTop <= 0 && CropRight <= 0 && CropBottom <= 0
        && Math.Abs(Zoom - 1) < 0.005 && Blur <= 0;
}
