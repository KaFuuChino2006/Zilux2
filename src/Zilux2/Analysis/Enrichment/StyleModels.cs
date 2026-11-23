// style stage 的 DSP 结果：字段与 .scratch/style-extend-contract.md §2 逐字一致。
namespace Zilux2.Analysis;

/// <summary>
/// 风格特征（500 ms 网格）。前端按 <see cref="HopMs"/> 把数组铺到时间轴；
/// 宿主只负责算，不做插值、不做归一化之外的改写。
/// </summary>
public sealed class StyleProfilePayload
{
    public int V { get; set; } = 1;

    /// <summary>数据来源：dsp（纯 DSP，不依赖模型）。</summary>
    public string Source { get; set; } = "dsp";

    /// <summary>算法版本标记，随实现升级变化。</summary>
    public string Method { get; set; } = "band-stats-v1";

    /// <summary>数组的时间间隔（毫秒）。</summary>
    public int HopMs { get; set; } = 500;

    /// <summary>谱质心（Hz），与 HopMs 等间隔。</summary>
    public double[] CentroidHz { get; set; } = [];

    /// <summary>谱平坦度 0..1（噪声性越强越接近 1）。</summary>
    public double[] Flatness { get; set; } = [];

    /// <summary>&gt;8 kHz 能量占比 0..1（失真/齿音代理）。</summary>
    public double[] HighRatio { get; set; } = [];

    /// <summary>0..1 瞬态密度（谱通量起音密度）。</summary>
    public double[] Percussivity { get; set; } = [];

    /// <summary>0..1 谐波性（归一化自相关峰）。</summary>
    public double[] Tonalness { get; set; } = [];

    /// <summary>p95-p10 瞬时响度（dB，RMS 近似 LU）。</summary>
    public double DynamicRangeLu { get; set; }

    /// <summary>&lt;-50 dBFS 帧占比 0..1。</summary>
    public double SilenceRatio { get; set; }

    /// <summary>&lt;250 Hz 能量占比（整曲）。</summary>
    public double LowEnergyRatio { get; set; }

    /// <summary>250–2000 Hz 能量占比（整曲）。</summary>
    public double MidEnergyRatio { get; set; }

    /// <summary>&gt;2000 Hz 能量占比（整曲）。</summary>
    public double HighEnergyRatio { get; set; }
}
