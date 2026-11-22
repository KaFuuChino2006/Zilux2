using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace Zilux2.Online;

/// <summary>
/// 歌词结果的进程内缓存 + 单飞（single-flight）。
///
/// 为什么需要：歌词是「一次播放拉一次、还可能被两个页面同时拉」的请求
/// （主页面歌词面板 + 背景歌词窗口），而上游 netease/qq/kugou 实测 1.3–5 s。
/// 没有缓存时，同一首歌每次播放/每次开歌词面板都要重新走一遍上游，
/// 慢的那几秒里歌词区是空的，用户看到的就是「歌词迟迟不出来」。
///
/// 单飞更重要：两个窗口同时请求同一首时，第二个不能再发一次上游请求
/// （那会把 5 s 的延迟叠成两次，还可能触发平台限流）。
/// </summary>
internal static class LyricCache
{
    /// <summary>缓存条目上限。一首歌一份歌词，240 份足够覆盖「来回切歌」的使用习惯。</summary>
    private const int Limit = 240;

    /// <summary>多久之后重新问上游。平台会补字幕，但半小时内重复拉同一首没有意义。</summary>
    private static readonly TimeSpan Ttl = TimeSpan.FromMinutes(30);

    /// <summary>
    /// 「确定没有这首歌」的负缓存：短 TTL、与正缓存分开存。
    ///
    /// 为什么单独存：负结论是用 <see cref="LyricUnavailableException"/> 表达的，
    /// 共享 Task 一 faulted 就不再满足命中条件，于是 404 每次都要重新打一遍 GitHub。
    /// 这里改成「值」记录，命中也算命中，只是答案是没有。
    /// </summary>
    private static readonly TimeSpan MissingTtl = TimeSpan.FromMinutes(10);

    private const int MissingLimit = 500;

    private static readonly Dictionary<string, DateTime> Missing = new(StringComparer.Ordinal);

    private static readonly object Gate = new();
    private static readonly Dictionary<string, Entry> Entries = new(StringComparer.Ordinal);

    private sealed class Entry
    {
        public Task<LyricData> Task { get; init; } = null!;

        public DateTime CreatedUtc { get; init; }
    }

    /// <summary>
    /// 取缓存；没有（或过期）就用 <paramref name="factory"/> 起一个共享任务并登记。
    /// 并发调用同一 key 只会执行一次 factory —— 后来者拿到的是同一个 Task。
    /// </summary>
    public static (Task<LyricData> Task, bool Hit) GetOrAdd(string key, Func<Task<LyricData>> factory)
    {
        Entry slot;
        TaskCompletionSource<LyricData> completion;
        bool hit;

        lock (Gate)
        {
            if (Entries.TryGetValue(key, out var existing))
            {
                var age = DateTime.UtcNow - existing.CreatedUtc;
                if (age < Ttl && !existing.Task.IsFaulted && !existing.Task.IsCanceled)
                {
                    return (existing.Task, true);
                }

                Entries.Remove(key);
            }

            // 先在锁里占位，再在锁外跑 factory：
            // factory 是 ResolveLyricAsync，会做平台判定、AMLL 地址拼装等同步准备，
            // 少数平台还要读本地凭据文件。把它放在 lock 里等于「任意一首歌词的准备工作
            // 都会阻塞其它歌的取缓存」，而并发同一首只执行一次的需求用 TCS 就能满足。
            completion = new TaskCompletionSource<LyricData>(TaskCreationOptions.RunContinuationsAsynchronously);
            slot = new Entry { Task = completion.Task, CreatedUtc = DateTime.UtcNow };
            Entries[key] = slot;
            hit = false;
        }

        try
        {
            var started = factory();
            _ = started.ContinueWith(
                task =>
                {
                    if (task.IsFaulted)
                    {
                        var aggregate = task.Exception;
                        if (aggregate is not null)
                        {
                            completion.TrySetException(aggregate.InnerExceptions);
                        }
                        else
                        {
                            completion.TrySetException(new InvalidOperationException("lyric task faulted without exception"));
                        }
                    }
                    else if (task.IsCanceled)
                    {
                        completion.TrySetCanceled();
                    }
                    else
                    {
                        completion.TrySetResult(task.Result);
                    }
                },
                CancellationToken.None,
                TaskContinuationOptions.ExecuteSynchronously,
                TaskScheduler.Default);
        }
        catch (Exception exception)
        {
            completion.TrySetException(exception);
        }

        lock (Gate)
        {
            TrimLocked();
        }

        return (slot.Task, hit);
    }

    /// <summary>记下「这首歌确定没有逐字歌词」，10 分钟内不再问上游。</summary>
    public static void MarkMissing(string key)
    {
        lock (Gate)
        {
            Missing[key] = DateTime.UtcNow;
            if (Missing.Count > MissingLimit)
            {
                var cutoff = DateTime.UtcNow - MissingTtl;
                var expired = new List<string>();
                foreach (var pair in Missing)
                {
                    if (pair.Value < cutoff)
                    {
                        expired.Add(pair.Key);
                    }
                }

                foreach (var key2 in expired)
                {
                    Missing.Remove(key2);
                }

                if (Missing.Count > MissingLimit)
                {
                    Missing.Clear();
                }
            }
        }
    }

    /// <summary>这个 key 是否在负缓存有效期内。</summary>
    public static bool IsMissing(string key)
    {
        lock (Gate)
        {
            if (!Missing.TryGetValue(key, out var at))
            {
                return false;
            }

            if (DateTime.UtcNow - at < MissingTtl)
            {
                return true;
            }

            Missing.Remove(key);
            return false;
        }
    }

    /// <summary>失败后把条目清掉，否则一次上游超时会被缓存成「这首歌永远没歌词」直到 TTL 到期。</summary>
    public static void Forget(string key)
    {
        lock (Gate)
        {
            Entries.Remove(key);
        }
    }

    /// <summary>缓存条数与命中情况（诊断页/日志用）。</summary>
    public static int Count
    {
        get
        {
            lock (Gate)
            {
                return Entries.Count;
            }
        }
    }

    private static void TrimLocked()
    {
        if (Entries.Count <= Limit)
        {
            return;
        }

        // 先按 TTL 清过期，再按创建时间清最旧的一半：比 LRU 简单，且歌词访问有强时间局部性。
        var now = DateTime.UtcNow;
        var stale = new List<string>();
        foreach (var pair in Entries)
        {
            if (now - pair.Value.CreatedUtc >= Ttl)
            {
                stale.Add(pair.Key);
            }
        }

        foreach (var key in stale)
        {
            Entries.Remove(key);
        }

        if (Entries.Count <= Limit)
        {
            return;
        }

        var ordered = new List<KeyValuePair<string, DateTime>>(Entries.Count);
        foreach (var pair in Entries)
        {
            ordered.Add(new KeyValuePair<string, DateTime>(pair.Key, pair.Value.CreatedUtc));
        }

        ordered.Sort(static (a, b) => a.Value.CompareTo(b.Value));
        var drop = Entries.Count - Limit / 2;
        for (var i = 0; i < drop && i < ordered.Count; i++)
        {
            Entries.Remove(ordered[i].Key);
        }
    }
}

/// <summary>「确定没有」这类结论（AMLL 库里查无此歌）用异常表达，由调用方映射成 404。</summary>
internal sealed class LyricUnavailableException : Exception
{
    public LyricUnavailableException()
        : base("lyric unavailable")
    {
    }
}
