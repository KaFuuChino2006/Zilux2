// ONNX 会话缓存：同一模型只开一次，闲置 180 s 自动释放（模型可能占好几 GB）。
using System.IO;
using Microsoft.ML.OnnxRuntime;

namespace Zilux2.Analysis;

/// <summary>
/// 会话按「绝对路径 + 长度 + mtime」缓存；闲置 <see cref="IdleSeconds"/> 秒后由看门狗释放。
/// 租约（<see cref="Lease"/>）保证释放不会撞上正在进行的推理。
/// </summary>
internal static class OnnxSessionCache
{
    private const int IdleSeconds = ExtensionContract.SessionIdleSeconds;

    private static readonly object Gate = new();
    private static readonly Dictionary<string, Entry> Entries = new(StringComparer.OrdinalIgnoreCase);
    private static readonly Timer Watchdog = new(_ => Sweep(), null, TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(30));

    /// <summary>取一个租约；模型缺失/加载失败返回 null 并给出原因（调用方只记日志，不抛）。</summary>
    internal static Lease? Rent(string modelPath, out string? error)
    {
        error = null;
        if (string.IsNullOrWhiteSpace(modelPath) || !File.Exists(modelPath))
        {
            error = "模型文件不存在：" + modelPath;
            return null;
        }

        FileInfo info;
        try
        {
            info = new FileInfo(modelPath);
        }
        catch (Exception exception)
        {
            error = exception.Message;
            return null;
        }

        lock (Gate)
        {
            if (Entries.TryGetValue(modelPath, out var existing) &&
                existing.Length == info.Length &&
                existing.WriteTimeUtc == info.LastWriteTimeUtc)
            {
                existing.InUse++;
                existing.Touch();
                return new Lease(existing);
            }

            if (existing is not null)
            {
                // 模型文件被替换：旧会话先留着，等它的租约结束再释放。
                Entries.Remove(modelPath);
                existing.Retire();
            }
        }

        InferenceSession? session = null;
        try
        {
            var options = new SessionOptions
            {
                GraphOptimizationLevel = GraphOptimizationLevel.ORT_ENABLE_ALL,
                IntraOpNumThreads = Math.Clamp(Environment.ProcessorCount / 2, 2, 8),
                InterOpNumThreads = 1,
                EnableCpuMemArena = true,
                EnableMemoryPattern = true,
            };

            try
            {
                session = new InferenceSession(modelPath, options);
            }
            finally
            {
                options.Dispose();
            }
        }
        catch (Exception exception)
        {
            error = $"{exception.GetType().Name}: {exception.Message}";
            session?.Dispose();
            return null;
        }

        var entry = new Entry(modelPath, info.Length, info.LastWriteTimeUtc, session);
        entry.InUse = 1;
        lock (Gate)
        {
            // 两个线程同时首次打开同一模型：保留先到的，后来者直接用缓存，避免泄漏一个会话。
            if (Entries.TryGetValue(modelPath, out var winner) &&
                winner.Length == info.Length &&
                winner.WriteTimeUtc == info.LastWriteTimeUtc)
            {
                winner.InUse++;
                winner.Touch();
                entry.Dispose();
                return new Lease(winner);
            }

            Entries[modelPath] = entry;
        }

        return new Lease(entry);
    }

    private static void Release(Entry entry)
    {
        lock (Gate)
        {
            entry.InUse--;
        }

        // 已退役且没人用 → 立刻释放。
        if (entry.Retired && Volatile.Read(ref entry.InUse) <= 0)
        {
            entry.Dispose();
            lock (Gate)
            {
                if (Entries.TryGetValue(entry.Path, out var current) && ReferenceEquals(current, entry))
                {
                    Entries.Remove(entry.Path);
                }
            }
        }
    }

    private static void Sweep()
    {
        List<Entry>? stale = null;
        lock (Gate)
        {
            var now = Environment.TickCount64;
            foreach (var entry in Entries.Values)
            {
                if (entry.InUse <= 0 && now - entry.LastUsedMs > IdleSeconds * 1000L)
                {
                    (stale ??= []).Add(entry);
                }
            }

            if (stale is not null)
            {
                foreach (var entry in stale)
                {
                    Entries.Remove(entry.Path);
                }
            }
        }

        if (stale is null)
        {
            return;
        }

        foreach (var entry in stale)
        {
            entry.Dispose();
            HostLog.Info($"models.session-release {Path.GetFileName(entry.Path)}");
        }
    }

    internal sealed class Lease : IDisposable
    {
        private Entry? _entry;

        internal Lease(Entry entry) => _entry = entry;

        internal InferenceSession Session =>
            _entry?.Session ?? throw new ObjectDisposedException(nameof(Lease));

        public void Dispose()
        {
            var entry = Interlocked.Exchange(ref _entry, null);
            if (entry is not null)
            {
                Release(entry);
            }
        }
    }

    internal sealed class Entry : IDisposable
    {
        private int _disposed;

        internal Entry(string path, long length, DateTime writeTimeUtc, InferenceSession session)
        {
            Path = path;
            Length = length;
            WriteTimeUtc = writeTimeUtc;
            Session = session;
            LastUsedMs = Environment.TickCount64;
        }

        internal string Path { get; }

        internal long Length { get; }

        internal DateTime WriteTimeUtc { get; }

        internal InferenceSession Session { get; }

        internal int InUse;

        internal bool Retired { get; private set; }

        internal long LastUsedMs { get; private set; }

        internal void Touch() => LastUsedMs = Environment.TickCount64;

        internal void Retire() => Retired = true;

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 0)
            {
                Session.Dispose();
            }
        }
    }
}
