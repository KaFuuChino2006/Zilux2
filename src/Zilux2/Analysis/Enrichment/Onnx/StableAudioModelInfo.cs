// 生成模型元数据：读 onnx/export-manifest.json（导出脚本写），缺省值即 stable-audio-open-1.0。
using System.IO;
using System.Text.Json;

namespace Zilux2.Analysis;

/// <summary>
/// <c>models/stable-audio-open-1.0/onnx/export-manifest.json</c> 的可选字段。导出脚本写它，
/// C# 不改代码就能跟着变（缺省值即本次导出的实测值）：
/// <code>
/// {
///   "latentChannels": 64,
///   "downsamplingRatio": 2048,      // VAE 每个 latent 帧还原的采样数（44.1k / 2048 ≈ 21.53 Hz）
///   "t5": { "maxLength": 128, "dim": 768 },
///   "graphs": {
///     "text_encoder": { "inputs": [{"name": "input_ids"}, {"name": "attention_mask"}] },
///     "dit": { "inputs": [{"name": "latent"}, {"name": "sigma"}, {"name": "text_emb"},
///                         {"name": "seconds_start"}, {"name": "seconds_total"},
///                         {"name": "context_scale"}] },
///     "vae_decoder": { "inputs": [{"name": "latent"}] }
///   },
///   "sampling": { "sampler": "euler",
///                 "sigmas": "polyexponential(steps, sigmaMin=0.3, sigmaMax=500, rho=1.0) + 0",
///                 "cfgScale": 7.0 }
/// }
/// </code>
/// 兼容旧 <c>model.json</c>（samplesPerLatent/textSeqLen/inputs 等键）。图文件固定放在模型目录的
/// <c>onnx/</c> 下，分词器在 <c>tokenizer/tokenizer.json</c>。
/// </summary>
internal sealed class StableAudioModelInfo
{
    internal const string DefaultOnnxDirectory = "onnx";
    internal const string DefaultTextEncoderFile = "text_encoder.onnx";
    internal const string DefaultDitFile = "dit.onnx";
    internal const string DefaultVaeDecoderFile = "vae_decoder.onnx";
    internal const string DefaultDitDataFile = "dit.onnx.data";
    internal const string DefaultTokenizerFile = "tokenizer/tokenizer.json";

    internal double SamplesPerLatent { get; private set; } = 2048;

    internal int LatentChannels { get; private set; } = 64;

    internal int TextSeqLen { get; private set; } = 128;

    internal int TextDim { get; private set; } = 768;

    internal double SigmaMin { get; private set; } = 0.3;

    internal double SigmaMax { get; private set; } = 500.0;

    internal double Rho { get; private set; } = 1.0;

    internal double CfgScale { get; private set; } = 7.0;

    internal string Sampler { get; private set; } = "euler";

    internal int Steps { get; private set; } = ExtensionContract.DefaultSteps;

    internal string OnnxDirectory { get; private set; } = DefaultOnnxDirectory;

    internal string TextEncoderFile { get; private set; } = DefaultTextEncoderFile;

    internal string DitFile { get; private set; } = DefaultDitFile;

    internal string VaeDecoderFile { get; private set; } = DefaultVaeDecoderFile;

    internal string TokenizerFile { get; private set; } = DefaultTokenizerFile;

    internal Dictionary<string, string> Inputs { get; } = new(StringComparer.OrdinalIgnoreCase);

    internal double LatentRate => SamplesPerLatent > 0 ? ExtensionContract.SampleRate / SamplesPerLatent : 44100.0 / 2048.0;

    internal string TextEncoderPath(string modelDirectory) => Path.Combine(modelDirectory, OnnxDirectory, TextEncoderFile);

    internal string DitPath(string modelDirectory) => Path.Combine(modelDirectory, OnnxDirectory, DitFile);

    internal string VaeDecoderPath(string modelDirectory) => Path.Combine(modelDirectory, OnnxDirectory, VaeDecoderFile);

    internal string TokenizerPath(string modelDirectory) => Path.Combine(modelDirectory, TokenizerFile.Replace('/', Path.DirectorySeparatorChar));

    internal string? ExplicitInput(string role) =>
        Inputs.TryGetValue(role, out var name) && !string.IsNullOrWhiteSpace(name) ? name : null;

    internal static StableAudioModelInfo Load(string modelDirectory, out string? error)
    {
        error = null;
        var info = new StableAudioModelInfo();

        var manifest = Path.Combine(modelDirectory, DefaultOnnxDirectory, "export-manifest.json");
        var legacy = Path.Combine(modelDirectory, "model.json");
        var path = File.Exists(manifest) ? manifest : legacy;
        if (!File.Exists(path))
        {
            return info;
        }

        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(path));
            var root = document.RootElement;

            info.SamplesPerLatent = ReadDouble(root, "downsamplingRatio", ReadDouble(root, "samplesPerLatent", info.SamplesPerLatent));
            info.LatentChannels = ReadInt(root, "latentChannels", info.LatentChannels);
            info.TextDim = ReadInt(root, "textDim", info.TextDim);
            info.Sampler = ReadString(root, "sampler", info.Sampler);

            if (root.TryGetProperty("t5", out var t5) && t5.ValueKind == JsonValueKind.Object)
            {
                info.TextSeqLen = ReadInt(t5, "maxLength", info.TextSeqLen);
                info.TextDim = ReadInt(t5, "dim", info.TextDim);
            }
            else
            {
                info.TextSeqLen = ReadInt(root, "textSeqLen", info.TextSeqLen);
            }

            if (root.TryGetProperty("sampling", out var sampling) && sampling.ValueKind == JsonValueKind.Object)
            {
                info.Sampler = ReadString(sampling, "sampler", info.Sampler);
                info.CfgScale = ReadSamplingDouble(sampling, "cfgScale", info.CfgScale);
                info.Steps = ReadSamplingInt(sampling, "steps", info.Steps);
                var sigmas = ReadString(sampling, "sigmas", string.Empty);
                if (sigmas.Length > 0)
                {
                    info.SigmaMin = ReadNamedDouble(sigmas, "sigmaMin", info.SigmaMin);
                    info.SigmaMax = ReadNamedDouble(sigmas, "sigmaMax", info.SigmaMax);
                    info.Rho = ReadNamedDouble(sigmas, "rho", info.Rho);
                }
            }
            else
            {
                info.Steps = ReadInt(root, "steps", info.Steps);
                info.CfgScale = ReadDouble(root, "cfgScale", info.CfgScale);
            }

            if (root.TryGetProperty("inputs", out var inputs) && inputs.ValueKind == JsonValueKind.Object)
            {
                foreach (var property in inputs.EnumerateObject())
                {
                    if (property.Value.ValueKind == JsonValueKind.String)
                    {
                        info.Inputs[property.Name] = property.Value.GetString() ?? string.Empty;
                    }
                }
            }

            ReadGraphs(root, info);

            info.SamplesPerLatent = Math.Clamp(info.SamplesPerLatent, 256, 8192);
            info.LatentChannels = Math.Clamp(info.LatentChannels, 1, 512);
            info.TextSeqLen = Math.Clamp(info.TextSeqLen, 2, 512);
            info.TextDim = Math.Clamp(info.TextDim, 64, 4096);
            info.Steps = Math.Clamp(info.Steps, ExtensionContract.MinSteps, ExtensionContract.MaxSteps);
            info.SigmaMin = info.SigmaMin > 0 ? info.SigmaMin : 0.3;
            info.SigmaMax = info.SigmaMax > info.SigmaMin ? info.SigmaMax : 500.0;
            info.Rho = info.Rho > 0 ? info.Rho : 1.0;
            info.CfgScale = Math.Clamp(info.CfgScale, 1.0, 32.0);

            return info;
        }
        catch (Exception exception)
        {
            error = $"{exception.GetType().Name}: {exception.Message}";
            return info;
        }
    }

    private static void ReadGraphs(JsonElement root, StableAudioModelInfo info)
    {
        if (!root.TryGetProperty("graphs", out var graphs) || graphs.ValueKind != JsonValueKind.Object)
        {
            return;
        }

        ReadGraph(graphs, "text_encoder", null, info.TextEncoderFile, out var encoderFile);
        info.TextEncoderFile = encoderFile;
        ReadGraph(graphs, "dit", "latent", info.DitFile, out var ditFile, info);
        info.DitFile = ditFile;
        ReadGraph(graphs, "vae_decoder", null, info.VaeDecoderFile, out var vaeFile);
        info.VaeDecoderFile = vaeFile;
    }

    private static void ReadGraph(
        JsonElement graphs,
        string graphName,
        string? role,
        string fallbackFile,
        out string fileName,
        StableAudioModelInfo? info = null)
    {
        fileName = fallbackFile;
        if (!graphs.TryGetProperty(graphName, out var graph) || graph.ValueKind != JsonValueKind.Object)
        {
            return;
        }

        if (graph.TryGetProperty("files", out var files) && files.ValueKind == JsonValueKind.Array)
        {
            foreach (var file in files.EnumerateArray())
            {
                if (file.ValueKind != JsonValueKind.Object)
                {
                    continue;
                }

                var name = ReadString(file, "name", string.Empty);
                if (name.EndsWith(".onnx", StringComparison.OrdinalIgnoreCase))
                {
                    fileName = name;
                    break;
                }
            }
        }

        if (info is null || role is null)
        {
            return;
        }

        // dit 的输入名写进 Inputs（role -> 实际名字），未知名字不覆盖别名兜底。
        if (!graph.TryGetProperty("inputs", out var inputs) || inputs.ValueKind != JsonValueKind.Array)
        {
            return;
        }

        foreach (var input in inputs.EnumerateArray())
        {
            if (input.ValueKind != JsonValueKind.Object)
            {
                continue;
            }

            var name = ReadString(input, "name", string.Empty);
            switch (name)
            {
                case "latent":
                    info.Inputs[role] = name;
                    break;
                case "sigma":
                    info.Inputs["sigma"] = name;
                    break;
                case "text_emb":
                case "encoder_hidden_states":
                    info.Inputs["text"] = name;
                    break;
                case "seconds_start":
                    info.Inputs["secondsStart"] = name;
                    break;
                case "seconds_total":
                    info.Inputs["secondsTotal"] = name;
                    break;
                case "context_scale":
                    info.Inputs["contextScale"] = name;
                    break;
            }
        }
    }

    private static double ReadSamplingDouble(JsonElement root, string name, double fallback)
    {
        if (root.TryGetProperty(name, out var element) && element.ValueKind == JsonValueKind.Number)
        {
            return element.GetDouble();
        }

        var text = ReadString(root, "sigmas", string.Empty);
        return text.Length > 0 ? ReadNamedDouble(text, name, fallback) : fallback;
    }

    private static int ReadSamplingInt(JsonElement root, string name, int fallback)
    {
        var text = ReadString(root, "sigmas", string.Empty);
        if (root.TryGetProperty(name, out var element) && element.ValueKind == JsonValueKind.Number)
        {
            return element.GetInt32();
        }

        return fallback;
    }

    /// <summary>从 "polyexponential(steps, sigmaMin=0.3, sigmaMax=500, rho=1.0) + 0" 里取数值。</summary>
    private static double ReadNamedDouble(string text, string name, double fallback)
    {
        var index = text.IndexOf(name + "=", StringComparison.OrdinalIgnoreCase);
        if (index < 0)
        {
            return fallback;
        }

        var start = index + name.Length + 1;
        var end = start;
        while (end < text.Length && (char.IsDigit(text[end]) || text[end] is '.' or '-' or '+' or 'e' or 'E'))
        {
            end++;
        }

        return end > start && double.TryParse(text.AsSpan(start, end - start), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var value)
            ? value
            : fallback;
    }

    private static double ReadDouble(JsonElement root, string name, double fallback) =>
        root.TryGetProperty(name, out var element) && element.ValueKind == JsonValueKind.Number
            ? element.GetDouble()
            : fallback;

    private static int ReadInt(JsonElement root, string name, int fallback) =>
        root.TryGetProperty(name, out var element) && element.ValueKind == JsonValueKind.Number
            ? element.GetInt32()
            : fallback;

    private static string ReadString(JsonElement root, string name, string fallback) =>
        root.TryGetProperty(name, out var element) && element.ValueKind == JsonValueKind.String
            ? element.GetString() ?? fallback
            : fallback;
}
