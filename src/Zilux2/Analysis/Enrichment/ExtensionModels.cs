// extend stage 的内部契约常量（载荷类型由 EnrichmentPayloads.cs 定义，此处不重复）。
namespace Zilux2.Analysis;

/// <summary>
/// extend stage 的版本 / 模型 / 时长 / 采样约定，集中在一处，避免字符串散落。
/// <para>
/// 生成链路（与 <c>tools/model-export/export_stable_audio.py</c> 的 <c>euler_sample</c> 逐字一致）：
/// T5 文本编码（tokenizer/tokenizer.json，pad 到 128）→ DiT sigma-Euler + CFG
/// （polyexponential 表 sigmaMin=0.3 / sigmaMax=500 / rho=1.0，末位补 0；<c>x = noise * sigmas[0]</c>；
/// 每步 cond（context_scale=1）与 uncond（context_scale=0）各一次前向，
/// <c>denoised = uncond + (cond-uncond)*cfgScale(7.0)</c>，<c>x += (x-denoised)/sigma*(sigma_next-sigma)</c>）
/// → VAE 解码（latent*frames*2048 → 44.1 kHz 双声道）。
/// </para>
/// <para>
/// 步数 12（契约 8–16），seed = FNV-1a(prompt, startMs, durationMs)，同一输入可复现；
/// 输出时长先夹到 2–47 s，再由 VAE 帧数决定实际采样数，最后按目标采样数截断；
/// 解码后峰值超过 0.99 时整体衰减（不提升），避免削波。
/// 落盘 <c>analysis/features/&lt;sha1-16&gt;/extend/&lt;startMs&gt;-&lt;lenMs&gt;.wav</c>（PCM16，44.1 kHz 双声道），
/// 同目录 <c>index.json</c> 记 prompt / LUFS / createdAtMs，prompt 一致时直接复用缓存。
/// 缺模型 / 超时（120 s）/ 任何推理失败都返回 null，前端回落循环，不留半截 wav
/// （wav 只在全部推理成功后经 GUID 临时文件原子改名写入）。
/// </para>
/// </summary>
internal static class ExtensionContract
{
    internal const string StageName = "extend";

    internal const string StageVersion = "extend/model-v1";

    internal const string ModelId = "stable-audio-open-1.0";

    /// <summary>模型原生采样率与声道（stable-audio-open-1.0）。</summary>
    internal const int SampleRate = 44_100;

    /// <summary>模型一次最多生成 47 s（契约 §7）。</summary>
    internal const int MaxDurationMs = 47_000;

    /// <summary>短于 2 s 的垫底没有意义，且前端循环衔接不上。</summary>
    internal const int MinDurationMs = 2_000;

    /// <summary>整条生成（文本编码 + 采样 + VAE 解码）的上限；超时按失败返回 null。</summary>
    internal const int TimeoutSeconds = 120;

    /// <summary>模型会话空闲多久后释放显存/内存。</summary>
    internal const int SessionIdleSeconds = 180;

    /// <summary>flow-matching 采样步数：契约要求 8–16 步，默认 12（Euler + CFG）。</summary>
    internal const int MinSteps = 8;

    internal const int MaxSteps = 16;

    internal const int DefaultSteps = 12;

    /// <summary>extend 目录里的清单文件名（wav 的副索引，写失败不影响主产物）。</summary>
    internal const string IndexFileName = "index.json";

    /// <summary>text_encoder 输出维度未知时的兜底（T5-base）。</summary>
    internal const int TextDimFallback = 768;

    /// <summary>三张图放在模型目录的 onnx/ 下（导出脚本的产物布局）。</summary>
    internal const string OnnxDirectory = "onnx";

    internal const string TextEncoderFile = "text_encoder.onnx";

    internal const string DitFile = "dit.onnx";

    internal const string DitDataFile = "dit.onnx.data";

    internal const string VaeDecoderFile = "vae_decoder.onnx";

    /// <summary>导出脚本写的元数据（图 I/O、latent 比例、sigma 表、CFG 默认值）。</summary>
    internal const string ExportManifestFile = "export-manifest.json";

    /// <summary>分词器相对模型目录的路径（HF T5 tokenizer.json，Unigram）。</summary>
    internal const string TokenizerRelativePath = "tokenizer/tokenizer.json";

    /// <summary>相对 analysis 根（features 的父目录）的路径，写进 payload.File 与索引。</summary>
    internal static string RelativePath(string hash, long startMs, int durationMs) =>
        $"features/{hash}/extend/{startMs}-{durationMs}.wav";

    /// <summary>相对 FeatureRoot（analysis/features）的落盘路径。</summary>
    internal static string CachePath(string hash, long startMs, int durationMs) =>
        $"{hash}/extend/{startMs}-{durationMs}.wav";
}
