// Stable Audio ONNX 推理：T5 文本编码 → DiT sigma-Euler + CFG 采样 → VAE 解码。
using Microsoft.ML.OnnxRuntime;
using Microsoft.ML.OnnxRuntime.Tensors;

namespace Zilux2.Analysis;

/// <summary>
/// 三张图契约以 <c>tools/model-export/export_stable_audio.py</c> 为准（产物写在
/// <c>models/stable-audio-open-1.0/onnx/</c>，元数据见同目录 <c>export-manifest.json</c>）：
/// <list type="bullet">
/// <item>text_encoder.onnx — <c>input_ids</c> int64[batch,128]、<c>attention_mask</c> int64[batch,128]
/// → <c>text_emb</c> float32[batch,128,768]（T5 图内已按 mask 清零）。</item>
/// <item>dit.onnx — <c>latent</c> float32[batch,64,frames]、<c>sigma</c> float32[batch]、
/// <c>text_emb</c> float32[batch,128,768]、<c>seconds_start</c>/<c>seconds_total</c> float32[batch]、
/// <c>context_scale</c> float32[1] → <c>denoised</c> float32[batch,64,frames]。
/// 图内是 k-diffusion 的 VDenoiser 语义（rf 分支），输出即 x0 估计。</item>
/// <item>vae_decoder.onnx — <c>latent</c> float32[batch,64,frames] → <c>audio</c> float32[batch,2,frames*2048]。</item>
/// </list>
/// 采样器与导出脚本 <c>euler_sample</c> 逐字一致：polyexponential sigma 表（sigmaMin=0.3、
/// sigmaMax=500、rho=1.0，末位补 0），<c>x = noise * sigmas[0]</c>，每步先算 cond（context_scale=1）
/// 再算 uncond（context_scale=0），<c>denoised = uncond + (cond-uncond)*cfg</c>，
/// 最后 <c>x += (x-denoised)/sigma * (sigma_next-sigma)</c>。
/// </summary>
internal static class StableAudioRunner
{
    private static readonly string[] InputIdsAliases = ["input_ids", "ids", "tokens"];
    private static readonly string[] MaskAliases = ["attention_mask", "mask"];
    private static readonly string[] LatentAliases = ["latent", "latents", "hidden_states", "noise_latent", "sample"];
    private static readonly string[] SigmaAliases = ["sigma", "timestep", "t", "time"];
    private static readonly string[] TextAliases = ["text_emb", "encoder_hidden_states", "text_embeds", "prompt_embeds", "conditioning"];
    private static readonly string[] StartAliases = ["seconds_start", "audio_start_in_s", "start_seconds"];
    private static readonly string[] TotalAliases = ["seconds_total", "audio_end_in_s", "total_seconds"];
    private static readonly string[] ScaleAliases = ["context_scale", "cfg_scale", "guidance_scale"];

    internal readonly record struct TextEmbedding(float[] Values, int SeqLength, int Dim);

    /// <summary>T5 编码。失败返回 false 并给 <paramref name="error"/>（调用方只记日志）。</summary>
    internal static bool TryEncodeText(
        string modelPath,
        long[] inputIds,
        long[] attentionMask,
        out TextEmbedding embedding,
        out string? error)
    {
        embedding = default;
        error = null;

        using var lease = OnnxSessionCache.Rent(modelPath, out error);
        if (lease is null)
        {
            return false;
        }

        var session = lease.Session;
        var idsName = PickInput(session, null, InputIdsAliases);
        if (idsName is null)
        {
            error = "text_encoder 缺少 input_ids";
            return false;
        }

        var idsDims = session.InputMetadata[idsName].Dimensions;
        var length = idsDims.Length >= 2 && idsDims[^1] > 0 ? idsDims[^1] : attentionMask.Length;
        length = Math.Clamp(length, 2, Math.Min(inputIds.Length, attentionMask.Length));

        var idsTensor = new DenseTensor<long>(new[] { 1, length });
        var idsSpan = idsTensor.Buffer.Span;
        for (var i = 0; i < length; i++)
        {
            idsSpan[i] = inputIds[i];
        }

        var inputs = new List<NamedOnnxValue>(2)
        {
            NamedOnnxValue.CreateFromTensor(idsName, idsTensor),
        };

        var maskName = PickInput(session, null, MaskAliases);
        if (maskName is not null)
        {
            var maskTensor = new DenseTensor<long>(new[] { 1, length });
            var maskSpan = maskTensor.Buffer.Span;
            for (var i = 0; i < length; i++)
            {
                maskSpan[i] = attentionMask[i];
            }

            inputs.Add(NamedOnnxValue.CreateFromTensor(maskName, maskTensor));
        }

        try
        {
            using var results = session.Run(inputs);
            var output = FindFloatOutput(results, "text_emb");
            if (output is null)
            {
                error = "text_encoder 输出不是 float 张量";
                return false;
            }

            var dims = output.Dimensions.ToArray();
            if (dims.Length != 3)
            {
                error = $"text_encoder 输出维度 {dims.Length} != 3";
                return false;
            }

            var seq = dims[1] > 0 ? dims[1] : length;
            var dim = dims[2] > 0 ? dims[2] : ExtensionContract.TextDimFallback;
            var values = ReadFloats(output);
            if (values.Length < seq * dim)
            {
                error = $"text_encoder 输出长度 {values.Length} < {seq}x{dim}";
                return false;
            }

            embedding = new TextEmbedding(values, seq, dim);
            return true;
        }
        catch (OnnxRuntimeException exception)
        {
            error = "text_encoder: " + exception.Message;
            return false;
        }
    }

    /// <summary>
    /// DiT 采样（sigma Euler + CFG）。latent 布局按模型输入维度自动判断（channel-first 优先）。
    /// </summary>
    internal static bool TrySample(
        string modelPath,
        StableAudioModelInfo info,
        TextEmbedding text,
        int latentFrames,
        float secondsStart,
        float secondsTotal,
        int steps,
        long seed,
        CancellationToken cancellationToken,
        out float[] latents,
        out string? error)
    {
        latents = [];
        error = null;

        // polyexponential 的 linspace(0,1,steps) 需要至少两个点才有端点；契约下限 8 步。
        steps = Math.Clamp(steps, ExtensionContract.MinSteps, ExtensionContract.MaxSteps);

        using var lease = OnnxSessionCache.Rent(modelPath, out error);
        if (lease is null)
        {
            return false;
        }

        var session = lease.Session;
        var latentName = PickInput(session, info.ExplicitInput("latent"), LatentAliases);
        var sigmaName = PickInput(session, info.ExplicitInput("sigma") ?? info.ExplicitInput("t"), SigmaAliases);
        var textName = PickInput(session, info.ExplicitInput("text"), TextAliases);
        var startName = PickInput(session, info.ExplicitInput("secondsStart"), StartAliases);
        var totalName = PickInput(session, info.ExplicitInput("secondsTotal"), TotalAliases);
        var scaleName = PickInput(session, info.ExplicitInput("contextScale"), ScaleAliases);

        if (latentName is null || sigmaName is null || textName is null)
        {
            error = $"dit 输入不完整（latent={latentName ?? "-"}, sigma={sigmaName ?? "-"}, text={textName ?? "-"}）";
            return false;
        }

        var latentDims = session.InputMetadata[latentName].Dimensions;
        var channelFirst = latentDims.Length < 3 || latentDims[1] <= 0 || latentDims[1] == info.LatentChannels;
        if (latentDims.Length == 3 && latentDims[2] == info.LatentChannels && latentDims[1] != info.LatentChannels)
        {
            channelFirst = false;
        }

        var latentTensor = channelFirst
            ? new DenseTensor<float>(new[] { 1, info.LatentChannels, latentFrames })
            : new DenseTensor<float>(new[] { 1, latentFrames, info.LatentChannels });
        var latentSpan = latentTensor.Buffer.Span;
        var latentLength = latentSpan.Length;

        // 与导出脚本一致：x = noise * sigmas[0]。
        var sigmas = BuildSigmas(steps, info.SigmaMin, info.SigmaMax, info.Rho);
        FillGaussian(latentSpan, seed);
        var initialSigma = (float)sigmas[0];
        for (var i = 0; i < latentSpan.Length; i++)
        {
            latentSpan[i] *= initialSigma;
        }

        var sigmaTensor = new DenseTensor<float>(new[] { 1 });
        var textTensor = new DenseTensor<float>(new[] { 1, text.SeqLength, text.Dim });
        text.Values.AsSpan(0, Math.Min(text.Values.Length, textTensor.Buffer.Length)).CopyTo(textTensor.Buffer.Span);

        DenseTensor<float>? startTensor = null;
        DenseTensor<float>? totalTensor = null;
        if (startName is not null)
        {
            startTensor = new DenseTensor<float>(SecondsShape(session.InputMetadata[startName].Dimensions));
            startTensor.Buffer.Span[0] = secondsStart;
        }

        if (totalName is not null)
        {
            totalTensor = new DenseTensor<float>(SecondsShape(session.InputMetadata[totalName].Dimensions));
            totalTensor.Buffer.Span[0] = secondsTotal;
        }

        var scaleTensor = scaleName is null ? null : new DenseTensor<float>(ScaleShape(session.InputMetadata[scaleName].Dimensions));

        float[]? forward = new float[latentLength];
        var cfgScale = scaleName is null ? 1.0 : info.CfgScale;
        try
        {
            for (var step = 0; step < steps; step++)
            {
                cancellationToken.ThrowIfCancellationRequested();

                var sigma = (float)sigmas[step];
                if (!RunForward(sigma, 1f, out var conditional, out error))
                {
                    return false;
                }

                float[] denoised;
                if (cfgScale != 1.0)
                {
                    if (!RunForward(sigma, 0f, out var unconditional, out error))
                    {
                        return false;
                    }

                    var scale = (float)cfgScale;
                    denoised = forward!;
                    for (var i = 0; i < denoised.Length; i++)
                    {
                        denoised[i] = unconditional[i] + (conditional[i] - unconditional[i]) * scale;
                    }
                }
                else
                {
                    denoised = conditional;
                }

                var delta = (float)(sigmas[step + 1] - sigmas[step]);
                var inverse = 1f / sigma;
                if (channelFirst)
                {
                    for (var i = 0; i < latentSpan.Length; i++)
                    {
                        latentSpan[i] += (latentSpan[i] - denoised[i]) * inverse * delta;
                    }
                }
                else
                {
                    // [1, T, C]：输出按同一交错布局返回，逐帧转置积分。
                    for (var frame = 0; frame < latentFrames; frame++)
                    {
                        for (var channel = 0; channel < info.LatentChannels; channel++)
                        {
                            var index = frame * info.LatentChannels + channel;
                            var slot = channel * latentFrames + frame;
                            latentSpan[slot] += (latentSpan[slot] - denoised[index]) * inverse * delta;
                        }
                    }
                }
            }
        }
        catch (OnnxRuntimeException exception)
        {
            error = "dit: " + exception.Message;
            return false;
        }

        latents = latentSpan.ToArray();
        return true;

        bool RunForward(float sigma, float contextScale, out float[] output, out string? failure)
        {
            output = [];
            failure = null;
            sigmaTensor.Buffer.Span[0] = sigma;

            var inputs = new List<NamedOnnxValue>(6)
            {
                NamedOnnxValue.CreateFromTensor(latentName, latentTensor),
                NamedOnnxValue.CreateFromTensor(sigmaName, sigmaTensor),
                NamedOnnxValue.CreateFromTensor(textName, textTensor),
            };

            if (startTensor is not null)
            {
                inputs.Add(NamedOnnxValue.CreateFromTensor(startName!, startTensor));
            }

            if (totalTensor is not null)
            {
                inputs.Add(NamedOnnxValue.CreateFromTensor(totalName!, totalTensor));
            }

            if (scaleName is not null && scaleTensor is not null)
            {
                scaleTensor.Buffer.Span[0] = contextScale;
                inputs.Add(NamedOnnxValue.CreateFromTensor(scaleName, scaleTensor));
            }

            using var results = session.Run(inputs);
            var tensor = FindFloatOutput(results, "denoised");
            if (tensor is null)
            {
                failure = "dit 输出不是 float 张量";
                return false;
            }

            var values = ReadFloats(tensor);
            if (values.Length < latentLength)
            {
                failure = $"dit 输出长度 {values.Length} < {latentLength}";
                return false;
            }

            output = values;
            return true;
        }
    }

    /// <summary>VAE 解码：返回 planar [L..., R...]；模型单声道时复制成双声道。</summary>
    internal static bool TryDecode(
        string modelPath,
        StableAudioModelInfo info,
        float[] latents,
        int latentFrames,
        out float[] left,
        out float[] right,
        out string? error)
    {
        left = [];
        right = [];
        error = null;

        using var lease = OnnxSessionCache.Rent(modelPath, out error);
        if (lease is null)
        {
            return false;
        }

        var session = lease.Session;
        var latentName = PickInput(session, info.ExplicitInput("latent"), LatentAliases);
        if (latentName is null)
        {
            error = "vae_decoder 缺少 latent 输入";
            return false;
        }

        var dims = session.InputMetadata[latentName].Dimensions;
        var channelFirst = dims.Length < 3 || dims[1] <= 0 || dims[1] == info.LatentChannels;

        DenseTensor<float> tensor;
        if (channelFirst)
        {
            tensor = new DenseTensor<float>(new[] { 1, info.LatentChannels, latentFrames });
            latents.AsSpan(0, Math.Min(latents.Length, tensor.Buffer.Length)).CopyTo(tensor.Buffer.Span);
        }
        else
        {
            tensor = new DenseTensor<float>(new[] { 1, latentFrames, info.LatentChannels });
            var span = tensor.Buffer.Span;
            for (var frame = 0; frame < latentFrames; frame++)
            {
                for (var channel = 0; channel < info.LatentChannels; channel++)
                {
                    span[frame * info.LatentChannels + channel] = latents[channel * latentFrames + frame];
                }
            }
        }

        try
        {
            using var results = session.Run(new[] { NamedOnnxValue.CreateFromTensor(latentName, tensor) });
            var output = FindFloatOutput(results, "audio");
            if (output is null)
            {
                error = "vae_decoder 输出不是 float 张量";
                return false;
            }

            var outDims = output.Dimensions.ToArray();
            var values = ReadFloats(output);
            if (outDims.Length != 3)
            {
                error = $"vae_decoder 输出维度 {outDims.Length} != 3";
                return false;
            }

            var channels = outDims[1] > 0 ? outDims[1] : 0;
            int samples;
            if (channels is 1 or 2)
            {
                samples = outDims[2] > 0 ? outDims[2] : values.Length / channels;
                left = new float[samples];
                right = new float[samples];
                if (channels == 1)
                {
                    values.AsSpan(0, samples).CopyTo(left);
                    values.AsSpan(0, samples).CopyTo(right);
                }
                else
                {
                    values.AsSpan(0, samples).CopyTo(left);
                    values.AsSpan(samples, samples).CopyTo(right);
                }
            }
            else if (outDims[2] is 1 or 2)
            {
                // [1, N, 2] 交错布局。
                channels = outDims[2];
                samples = outDims[1] > 0 ? outDims[1] : values.Length / channels;
                left = new float[samples];
                right = new float[samples];
                if (channels == 1)
                {
                    for (var i = 0; i < samples; i++)
                    {
                        left[i] = values[i];
                        right[i] = values[i];
                    }
                }
                else
                {
                    for (var i = 0; i < samples; i++)
                    {
                        left[i] = values[i * 2];
                        right[i] = values[i * 2 + 1];
                    }
                }
            }
            else
            {
                error = $"vae_decoder 输出形状无法识别（[{string.Join(',', outDims)}]）";
                return false;
            }

            return true;
        }
        catch (OnnxRuntimeException exception)
        {
            error = "vae_decoder: " + exception.Message;
            return false;
        }
    }

    /// <summary>与导出脚本 <c>get_sigmas_polyexponential</c> 一致：升序到 0，末位补 0。</summary>
    private static double[] BuildSigmas(int steps, double sigmaMin, double sigmaMax, double rho)
    {
        sigmaMin = sigmaMin > 0 ? sigmaMin : 0.3;
        sigmaMax = sigmaMax > sigmaMin ? sigmaMax : 500.0;
        rho = rho > 0 ? rho : 1.0;

        var minInv = Math.Pow(sigmaMin, 1.0 / rho);
        var maxInv = Math.Pow(sigmaMax, 1.0 / rho);
        var sigmas = new double[steps + 1];
        var span = steps - 1;
        for (var i = 0; i < steps; i++)
        {
            var alpha = span <= 0 ? 0.0 : (double)i / span;
            sigmas[i] = Math.Pow(maxInv + alpha * (minInv - maxInv), rho);
        }

        sigmas[steps] = 0.0;
        return sigmas;
    }

    private static int[] SecondsShape(ReadOnlySpan<int> dims)
    {
        if (dims.Length == 2)
        {
            return [1, 1];
        }

        return [1];
    }

    private static int[] ScaleShape(ReadOnlySpan<int> dims)
    {
        if (dims.Length == 2)
        {
            return [1, 1];
        }

        return [1];
    }

    private static string? PickInput(InferenceSession session, string? explicitName, string[] aliases)
    {
        var metadata = session.InputMetadata;

        if (!string.IsNullOrWhiteSpace(explicitName) && metadata.ContainsKey(explicitName))
        {
            return explicitName;
        }

        foreach (var alias in aliases)
        {
            foreach (var name in metadata.Keys)
            {
                if (string.Equals(name, alias, StringComparison.OrdinalIgnoreCase))
                {
                    return name;
                }
            }
        }

        foreach (var alias in aliases)
        {
            if (alias.Length < 4)
            {
                continue;
            }

            foreach (var name in metadata.Keys)
            {
                if (name.Contains(alias, StringComparison.OrdinalIgnoreCase))
                {
                    return name;
                }
            }
        }

        return null;
    }

    private static Tensor<float>? FindFloatOutput(
        IDisposableReadOnlyCollection<DisposableNamedOnnxValue> results,
        string? preferred)
    {
        if (!string.IsNullOrWhiteSpace(preferred))
        {
            foreach (var result in results)
            {
                if (string.Equals(result.Name, preferred, StringComparison.Ordinal))
                {
                    return result.AsTensor<float>();
                }
            }
        }

        foreach (var result in results)
        {
            try
            {
                return result.AsTensor<float>();
            }
            catch (Exception)
            {
                // 跳到下一个输出。
            }
        }

        return null;
    }

    private static float[] ReadFloats(Tensor<float> tensor) =>
        tensor is DenseTensor<float> dense ? dense.Buffer.ToArray() : tensor.ToArray();

    private static void FillGaussian(Span<float> destination, long seed)
    {
        // 固定种子：同一 (prompt,start,duration) 重复生成得到同一段音频，缓存与调试都可复现。
        var random = new Random(unchecked((int)(seed ^ (seed >> 32))));
        for (var i = 0; i < destination.Length; i += 2)
        {
            var u1 = 1.0 - random.NextDouble();
            var u2 = random.NextDouble();
            var radius = Math.Sqrt(-2.0 * Math.Log(u1));
            var angle = 2.0 * Math.PI * u2;
            destination[i] = (float)(radius * Math.Cos(angle));
            if (i + 1 < destination.Length)
            {
                destination[i + 1] = (float)(radius * Math.Sin(angle));
            }
        }
    }
}
