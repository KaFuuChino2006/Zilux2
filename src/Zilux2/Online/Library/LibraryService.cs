using Zilux2.Online.Account;

namespace Zilux2.Online.Library;

// Host-side personal library cache (docs/zilux2-library.md §3).
//
// One instance lives next to the online music providers. Overview and playlist pages are cached for
// five minutes; a different account fingerprint (login/logout) makes a cache entry unusable, so an
// account switch invalidates lazily without wiring logout callbacks into the account service.
internal sealed class LibraryService : IDisposable
{
    private const int MaxPlaylistPageSize = 500;
    private const int DefaultPlaylistPageSize = 200;

    private static readonly TimeSpan CacheTtl = TimeSpan.FromMinutes(5);

    private readonly AccountService? _accounts;
    private readonly NeteaseLibraryProvider _netease;
    private readonly QqLibraryProvider _qq;
    private readonly object _gate = new();
    private readonly Dictionary<string, SnapshotEntry> _snapshots = new(StringComparer.Ordinal);
    private readonly Dictionary<string, DetailEntry> _details = new(StringComparer.Ordinal);
    private bool _disposed;

    public LibraryService(AccountService? accounts)
    {
        _accounts = accounts;
        _netease = new NeteaseLibraryProvider(accounts);
        _qq = new QqLibraryProvider(accounts);
    }

    public static string[] Sources => [AccountSources.Netease, AccountSources.Qq];

    public void Dispose() => _disposed = true;

    public static bool IsKnownSource(string source) => AccountSources.IsKnown(source);

    public async Task<LibraryOverview> GetOverviewAsync(CancellationToken cancellationToken)
    {
        ThrowIfDisposed();
        // Both sources are fetched concurrently; each one fails on its own and only fills its error slot.
        var tasks = Sources.Select(source => BuildSourceStateAsync(source, cancellationToken)).ToArray();
        var states = await Task.WhenAll(tasks).ConfigureAwait(false);
        return new LibraryOverview { Sources = states.ToList() };
    }

    public async Task<LibraryDetail> GetPlaylistAsync(string source, string id, int offset, int limit, CancellationToken cancellationToken)
    {
        ThrowIfDisposed();
        source = NormalizeSource(source);
        if (string.IsNullOrEmpty(id))
        {
            throw new OnlineUpstreamException("缺少歌单 id 参数", 400);
        }

        if (id.Length > 512)
        {
            throw new OnlineUpstreamException("歌单 id 参数非法", 400);
        }

        if (offset < 0)
        {
            offset = 0;
        }

        limit = limit <= 0 ? DefaultPlaylistPageSize : Math.Min(limit, MaxPlaylistPageSize);

        if (_accounts?.IsLoggedIn(source) != true)
        {
            throw new OnlineUpstreamException("该音源尚未登录，请先登录", 401);
        }

        var providerId = id;
        if (string.Equals(id, "liked", StringComparison.OrdinalIgnoreCase) && source == AccountSources.Netease)
        {
            var snapshot = await GetSnapshotAsync(source, cancellationToken).ConfigureAwait(false);
            if (snapshot?.Liked is null || snapshot.Liked.Id.Length == 0)
            {
                throw new OnlineUpstreamException("没有找到我喜欢的音乐", 404);
            }

            providerId = snapshot.Liked.Id;
        }

        var key = $"{source}|{providerId}|{offset}|{limit}";
        var fingerprint = Fingerprint(source);
        lock (_gate)
        {
            if (_details.TryGetValue(key, out var entry) && entry.ExpiresAt > DateTimeOffset.UtcNow && entry.Fingerprint == fingerprint)
            {
                HostLog.Info($"[library] playlist cache hit source={source} id={providerId} offset={offset} limit={limit}");
                return entry.Detail;
            }
        }

        var detail = await FetchPlaylistAsync(source, providerId, offset, limit, cancellationToken).ConfigureAwait(false);
        // Keep the caller's spelling of the liked pseudo-id in the response; the front-end keys cards
        // by the id it already holds from the overview.
        if (!string.Equals(detail.Meta.Id, id, StringComparison.Ordinal))
        {
            detail = detail with { Meta = detail.Meta with { Id = id } };
        }

        lock (_gate)
        {
            _details[key] = new DetailEntry(DateTimeOffset.UtcNow.Add(CacheTtl), fingerprint, detail);
        }

        return detail;
    }

    public void Refresh(string? source)
    {
        lock (_gate)
        {
            if (string.IsNullOrEmpty(source))
            {
                var removed = _snapshots.Count + _details.Count;
                _snapshots.Clear();
                _details.Clear();
                HostLog.Info($"[library] refresh all entries={removed}");
                return;
            }

            var normalized = NormalizeSource(source);
            _snapshots.Remove(normalized);
            var prefix = normalized + "|";
            var keys = _details.Keys.Where(key => key.StartsWith(prefix, StringComparison.Ordinal)).ToList();
            foreach (var key in keys)
            {
                _details.Remove(key);
            }

            HostLog.Info($"[library] refresh source={normalized} details={keys.Count}");
        }
    }

    private async Task<LibrarySourceState> BuildSourceStateAsync(string source, CancellationToken cancellationToken)
    {
        var loggedIn = _accounts?.IsLoggedIn(source) == true;
        var account = loggedIn ? _accounts?.GetAccount(source) : null;
        if (!loggedIn)
        {
            return new LibrarySourceState
            {
                Source = source,
                LoggedIn = false,
                Playlists = [],
                Liked = null,
            };
        }

        try
        {
            var snapshot = await GetSnapshotAsync(source, cancellationToken).ConfigureAwait(false);
            return new LibrarySourceState
            {
                Source = source,
                LoggedIn = true,
                Nickname = account?.Nickname,
                AvatarDataUrl = account?.AvatarDataUrl,
                Liked = snapshot?.Liked,
                Playlists = snapshot?.Playlists.ToList() ?? [],
            };
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            var message = exception is OnlineUpstreamException upstream
                ? upstream.Message
                : "个人音乐库读取失败，请稍后重试";
            HostLog.Warn($"[library] overview source={source} failed: {Describe(exception)}");
            return new LibrarySourceState
            {
                Source = source,
                LoggedIn = true,
                Nickname = account?.Nickname,
                AvatarDataUrl = account?.AvatarDataUrl,
                Playlists = [],
                Liked = null,
                Error = message,
            };
        }
    }

    private async Task<LibrarySnapshot?> GetSnapshotAsync(string source, CancellationToken cancellationToken)
    {
        var fingerprint = Fingerprint(source);
        lock (_gate)
        {
            if (_snapshots.TryGetValue(source, out var entry) && entry.ExpiresAt > DateTimeOffset.UtcNow && entry.Fingerprint == fingerprint)
            {
                HostLog.Info($"[library] overview cache hit source={source}");
                return entry.Snapshot;
            }
        }

        var snapshot = await FetchSnapshotAsync(source, cancellationToken).ConfigureAwait(false);
        lock (_gate)
        {
            _snapshots[source] = new SnapshotEntry(DateTimeOffset.UtcNow.Add(CacheTtl), fingerprint, snapshot);
        }

        return snapshot;
    }

    private Task<LibrarySnapshot> FetchSnapshotAsync(string source, CancellationToken cancellationToken) => source switch
    {
        AccountSources.Netease => _netease.GetSnapshotAsync(cancellationToken),
        AccountSources.Qq => _qq.GetSnapshotAsync(cancellationToken),
        _ => throw new OnlineUpstreamException("暂不支持该音乐平台的该能力", 400),
    };

    private Task<LibraryDetail> FetchPlaylistAsync(string source, string id, int offset, int limit, CancellationToken cancellationToken) => source switch
    {
        AccountSources.Netease => _netease.GetPlaylistAsync(id, offset, limit, cancellationToken),
        AccountSources.Qq => _qq.GetPlaylistAsync(id, offset, limit, cancellationToken),
        _ => throw new OnlineUpstreamException("暂不支持该音乐平台的该能力", 400),
    };

    private string Fingerprint(string source) =>
        _accounts is null
            ? "anonymous"
            : $"{( _accounts.IsLoggedIn(source) ? "in" : "out")}:{_accounts.GetUserId(source) ?? "-"}";

    private static string NormalizeSource(string source) =>
        IsKnownSource(source) ? source.Trim().ToLowerInvariant() : source.Trim().ToLowerInvariant();

    private void ThrowIfDisposed()
    {
        if (_disposed)
        {
            throw new ObjectDisposedException(nameof(LibraryService));
        }
    }

    private static string Describe(Exception exception) =>
        exception is OnlineUpstreamException upstream
            ? $"{upstream.Message} (status={upstream.StatusCode})"
            : $"{exception.GetType().Name}: {exception.Message}";

    private sealed record SnapshotEntry(DateTimeOffset ExpiresAt, string Fingerprint, LibrarySnapshot Snapshot);

    private sealed record DetailEntry(DateTimeOffset ExpiresAt, string Fingerprint, LibraryDetail Detail);

    // 查询当前歌曲是否已在「我喜欢的音乐」中（前端点亮收藏状态）。
    public async Task<bool> CheckLikedAsync(string source, string trackId, CancellationToken cancellationToken)
    {
        ThrowIfDisposed();
        source = NormalizeSource(source);
        if (string.IsNullOrWhiteSpace(trackId) || trackId.Length > 64)
        {
            throw new OnlineUpstreamException("缺少或非法的歌曲 id 参数", 400);
        }

        if (_accounts?.IsLoggedIn(source) != true)
        {
            return false;
        }

        return source switch
        {
            AccountSources.Netease => await _netease.CheckLikedAsync(trackId, cancellationToken).ConfigureAwait(false),
            AccountSources.Qq => await _qq.CheckLikedAsync(trackId, cancellationToken).ConfigureAwait(false),
            _ => false,
        };
    }

    // 「加入我喜欢」写入接口：成功后失效该音源缓存，下一次读取就能看到新数据。
    public async Task AddLikedAsync(string source, string trackId, CancellationToken cancellationToken)
    {
        ThrowIfDisposed();
        source = NormalizeSource(source);
        if (string.IsNullOrWhiteSpace(trackId))
        {
            throw new OnlineUpstreamException("缺少歌曲 id 参数", 400);
        }

        if (_accounts?.IsLoggedIn(source) != true)
        {
            throw new OnlineUpstreamException("该音源尚未登录，请先登录", 401);
        }

        switch (source)
        {
            case AccountSources.Netease:
                await _netease.AddLikedAsync(trackId, cancellationToken).ConfigureAwait(false);
                break;
            case AccountSources.Qq:
                await _qq.AddLikedAsync(trackId, cancellationToken).ConfigureAwait(false);
                break;
            default:
                throw new OnlineUpstreamException("未知音源", 400);
        }

        Refresh(source);
    }

    // 批量收藏状态（搜索结果一次点亮收藏按钮）：各音源内部各自合并请求。
    public async Task<Dictionary<string, bool>> CheckLikedManyAsync(
        string source,
        IReadOnlyList<string> trackIds,
        CancellationToken cancellationToken)
    {
        ThrowIfDisposed();
        source = NormalizeSource(source);
        if (_accounts?.IsLoggedIn(source) != true)
        {
            return new Dictionary<string, bool>(StringComparer.Ordinal);
        }

        var ids = trackIds
            .Where(id => !string.IsNullOrWhiteSpace(id) && id.Length <= 64)
            .Distinct(StringComparer.Ordinal)
            .Take(60)
            .ToArray();
        if (ids.Length == 0)
        {
            return new Dictionary<string, bool>(StringComparer.Ordinal);
        }

        return source switch
        {
            AccountSources.Netease => await _netease.CheckLikedManyAsync(ids, cancellationToken).ConfigureAwait(false),
            AccountSources.Qq => await _qq.CheckLikedManyAsync(ids, cancellationToken).ConfigureAwait(false),
            _ => new Dictionary<string, bool>(StringComparer.Ordinal),
        };
    }

    // 「取消喜欢」写入接口。
    public async Task RemoveLikedAsync(string source, string trackId, CancellationToken cancellationToken)
    {
        ThrowIfDisposed();
        source = NormalizeSource(source);
        if (string.IsNullOrWhiteSpace(trackId))
        {
            throw new OnlineUpstreamException("缺少歌曲 id 参数", 400);
        }

        if (_accounts?.IsLoggedIn(source) != true)
        {
            throw new OnlineUpstreamException("该音源尚未登录，请先登录", 401);
        }

        switch (source)
        {
            case AccountSources.Netease:
                await _netease.RemoveLikedAsync(trackId, cancellationToken).ConfigureAwait(false);
                break;
            case AccountSources.Qq:
                await _qq.RemoveLikedAsync(trackId, cancellationToken).ConfigureAwait(false);
                break;
            default:
                throw new OnlineUpstreamException("未知音源", 400);
        }

        Refresh(source);
    }

    // 发现面板：最近播放 / 每日推荐。数据实时性强，不进歌单缓存。
    public async Task<LibraryFeed> GetFeedAsync(string source, string kind, int limit, CancellationToken cancellationToken)
    {
        ThrowIfDisposed();
        source = NormalizeSource(source);
        kind = (kind ?? string.Empty).Trim().ToLowerInvariant();
        if (kind is not ("recent" or "daily"))
        {
            throw new OnlineUpstreamException("kind 参数必须是 recent 或 daily", 400);
        }

        limit = limit <= 0 ? 60 : Math.Min(limit, 200);
        if (_accounts?.IsLoggedIn(source) != true)
        {
            throw new OnlineUpstreamException("该音源尚未登录，请先登录", 401);
        }

        var tracks = source switch
        {
            AccountSources.Netease => await _netease.GetFeedAsync(kind, limit, cancellationToken).ConfigureAwait(false),
            AccountSources.Qq => await _qq.GetFeedAsync(kind, limit, cancellationToken).ConfigureAwait(false),
            _ => throw new OnlineUpstreamException("暂不支持该音乐平台的该能力", 400),
        };
        return new LibraryFeed(source, kind, tracks);
    }

}
