using System.Globalization;

namespace Zilux2.Online;

/// <summary>原生优先链路的统一预算：单次原生调用 5 秒，同一 provider 连续 2 次失败后 60 秒内跳过原生。</summary>
internal static class NativeFirstPolicy
{
    internal static readonly TimeSpan Timeout = TimeSpan.FromSeconds(5);
    internal static readonly TimeSpan Cooldown = TimeSpan.FromSeconds(60);
    internal const int FailureThreshold = 2;

    /// <summary>请求音质 → 档位（1=标准/128k，2=高/320k，3=无损）。</summary>
    internal static int QualityTier(string? quality) => (quality ?? string.Empty).Trim().ToLowerInvariant() switch
    {
        "lossless" => 3,
        "standard" => 1,
        _ => 2,
    };

    /// <summary>实际码率 → 档位；未知码率按标准档处理。</summary>
    internal static int BitrateTier(int bitrate) => bitrate >= 900000 ? 3 : bitrate >= 300000 ? 2 : 1;

    /// <summary>
    /// 给原生调用套一层 5 秒超时。只有「外层 5 秒到期」才返回 TimedOut；调用方自己的取消原样抛出，
    /// 避免把宿主关闭误记成原生失败。
    /// </summary>
    internal static async Task<NativeAttempt<T>> RunAsync<T>(
        Func<CancellationToken, Task<T>> call,
        CancellationToken cancellationToken)
        where T : class
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(Timeout);
        try
        {
            var value = await call(timeout.Token).ConfigureAwait(false);
            return new NativeAttempt<T>(value, false);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return new NativeAttempt<T>(null, true);
        }
    }

    internal static string DescribeCooldown(TimeSpan remaining) =>
        Math.Max(1, (int)Math.Ceiling(remaining.TotalSeconds)).ToString(CultureInfo.InvariantCulture);
}

/// <summary>原生调用的结果分类。Unavailable（无权益/无歌词）不算失败，不触发熔断。</summary>
internal enum NativeCallOutcome
{
    Ok,
    Unavailable,
    Failed,
}

internal sealed record NativeResult<T>(NativeCallOutcome Outcome, T? Value)
    where T : class
{
    internal static NativeResult<T> Ok(T value) => new(NativeCallOutcome.Ok, value);

    internal static NativeResult<T> Unavailable() => new(NativeCallOutcome.Unavailable, null);

    internal static NativeResult<T> Failed() => new(NativeCallOutcome.Failed, null);
}

internal readonly record struct NativeAttempt<T>(T? Value, bool TimedOut)
    where T : class;

/// <summary>
/// 每个 provider 一个熔断器：连续 2 次网络/超时/解析失败后，60 秒内直接走 web。
/// 无权益（Unavailable）代表上游正常响应，只说明这首不能播，不打开熔断。
/// </summary>
internal sealed class NativeCircuitBreaker(string name)
{
    private readonly object _gate = new();
    private int _consecutiveFailures;
    private DateTimeOffset _skipUntil = DateTimeOffset.MinValue;

    internal bool ShouldAttempt(out TimeSpan remaining)
    {
        lock (_gate)
        {
            remaining = _skipUntil - DateTimeOffset.UtcNow;
            if (remaining > TimeSpan.Zero)
            {
                return false;
            }

            remaining = TimeSpan.Zero;
            return true;
        }
    }

    internal void RecordSuccess()
    {
        lock (_gate)
        {
            _consecutiveFailures = 0;
            _skipUntil = DateTimeOffset.MinValue;
        }
    }

    internal void RecordFailure()
    {
        var opened = false;
        lock (_gate)
        {
            _consecutiveFailures++;
            if (_consecutiveFailures >= NativeFirstPolicy.FailureThreshold)
            {
                _consecutiveFailures = 0;
                _skipUntil = DateTimeOffset.UtcNow + NativeFirstPolicy.Cooldown;
                opened = true;
            }
        }

        if (opened)
        {
            OnlineHttp.Warn(
                $"{name}.native circuit open after {NativeFirstPolicy.FailureThreshold} consecutive failures, " +
                $"skip native for {NativeFirstPolicy.Cooldown.TotalSeconds:F0}s");
        }
    }
}
