using System.Collections.Generic;

namespace Zilux2;

/// <summary>一句歌词里的一个词（QRC/YRC 逐字数据；普通 LRC 时为空）。</summary>
public readonly record struct DesktopLyricWord(string Text, bool SpaceBefore, double StartMs = 0, double EndMs = 0)
{
    public double DurationMs => EndMs > StartMs ? EndMs - StartMs : 0;
}

/// <summary>桌面歌词上下文里的一整句（只带悬浮扇形需要的字段）。</summary>
public sealed record DesktopLyricLine(
    string Text,
    string Translation,
    double StartMs,
    double EndMs,
    IReadOnlyList<DesktopLyricWord> Words)
{
    public double DurationMs => EndMs > StartMs ? EndMs - StartMs : 0;
}

/// <summary>
/// 页面每一轮推给桌面歌词的完整快照：当前句、相邻句、逐词时间轴，外加悬浮样式需要的
/// 播放位置与上下文窗口（<see cref="Lines"/> 为空表示沿用上一轮）。
/// </summary>
public sealed record DesktopLyricsFrame(
    string Now,
    string Translation,
    string Previous,
    string Next,
    IReadOnlyList<DesktopLyricWord> Words,
    int ActiveWord,
    double PositionMs = 0,
    bool Playing = false,
    int CurrentIndex = -1,
    IReadOnlyList<DesktopLyricLine>? Lines = null,
    int LinesStart = -1);

/// <summary>
/// 桌面歌词的两种样式共用同一套宿主接口：经典三行（<see cref="DesktopLyricsWindow"/>）与
/// 悬浮扇形（<see cref="DesktopLyricsFanWindow"/>）。MainWindow 只认这个接口，换样式＝换实现。
/// </summary>
internal interface IDesktopLyricsSurface
{
    event System.Action? ClosedByUser;

    double Left { get; set; }

    double Top { get; set; }

    void Show();

    void Close();

    /// <summary>首次出现时的默认位置（经典样式在屏幕底部居中，扇形贴着任务栏上方）。</summary>
    void PlaceDefault();

    /// <summary>字号/锁定/置顶/粗细/底色；<paramref name="fanLines"/> 与 <paramref name="fanWidth"/> 只对悬浮样式生效。</summary>
    void ApplyStyle(int fontSize, bool locked, bool topmost, string weight, int backdropOpacity, int fanLines, int fanWidth);

    void UpdateLines(DesktopLyricsFrame frame);

    /// <summary>托盘解锁（锁定时窗口鼠标穿透，右键菜单点不到）。</summary>
    void SetLocked(bool locked);
}
