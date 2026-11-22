using System.Drawing;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;
using Zilux2.Wallpaper.Render;

namespace Zilux2.Wallpaper;

/// <summary>一块屏要铺的桌面壁纸（第 88 轮多屏画面管理）。</summary>
internal sealed record DesktopTarget(
    string Key,
    int Index,
    Rectangle Bounds,
    bool Primary,
    long? AssetId,
    int Fps);

/// <summary>
/// 多屏桌面层：每块屏一块独立的 WebView2（各自 bounds、各自吃一份状态推送）。
///
/// 两条路径分清楚：
/// - <see cref="UpdateDesktopVideos"/>：屏幕没变，只是换了素材/帧率 → 原地推新载荷，
///   页面里只换 &lt;video&gt;，不重建表面（这是日常操作）。
/// - <see cref="StartDesktopSurfaces"/>：屏幕增删/分辨率变了才重建。
///
/// 重建必须错峰（每块屏间隔 700ms）：三块屏同时 EnsureCoreWebView2 会一起申请
/// 渲染进程和 D3D 资源，实测直接 0x8007000E。真撞上了就放弃那块屏，别把整个
/// 桌面层拖下去。
/// </summary>
internal sealed class WallpaperRuntime : IDisposable
{
    private const int OutOfMemory = unchecked((int)0x8007000E);
    private const int StartStaggerMs = 700;

    private readonly Dispatcher _ui;
    private readonly Func<(CoreWebView2Environment? Environment, string? NavigationUrl, string? FolderPath, string? VirtualHost)>? _surfaceSource;
    private readonly Func<DesktopTarget, WallpaperLayerPayload?> _payloadFactory;
    private readonly Func<(int Port, string Token)?>? _onlineSource;
    private readonly List<SurfaceSlot> _slots = new();

    private IReadOnlyList<DesktopTarget> _targets = Array.Empty<DesktopTarget>();
    private IReadOnlyList<DesktopTarget>? _pending;
    private bool _starting;
    private bool _disposed;

    public WallpaperRuntime(
        Dispatcher ui,
        Func<(CoreWebView2Environment? Environment, string? NavigationUrl, string? FolderPath, string? VirtualHost)>? surfaceSource,
        Func<DesktopTarget, WallpaperLayerPayload?> payloadFactory,
        Func<(int Port, string Token)?>? onlineSource)
    {
        _ui = ui;
        _surfaceSource = surfaceSource;
        _payloadFactory = payloadFactory;
        _onlineSource = onlineSource;
    }

    /// <summary>已经挂上的屏数。</summary>
    public int SurfaceCount => _slots.Count;

    public bool IsRunning => _slots.Count > 0;

    /// <summary>
    /// 让某一块屏的实际画面扫一道光（用户在「画布设置」里点这块屏时提示「就是这一块」）。
    /// 找不到这块屏（还没挂上/键对不上）就静默返回 —— 这只是个提示，不该影响主流程。
    /// </summary>
    public void Sweep(string key)
    {
        if (_disposed || string.IsNullOrEmpty(key))
        {
            return;
        }

        if (!_ui.CheckAccess())
        {
            _ui.BeginInvoke(new Action(() => Sweep(key)));
            return;
        }

        foreach (var slot in _slots)
        {
            if (!string.Equals(slot.Key, key, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            slot.Web.PostSweep();
            return;
        }

        HostLog.Warn($"[wallpaper] monitor sweep {key} not found (slots={_slots.Count})");
    }

    /// <summary>一轮启动结束（true = 至少挂上一块屏）。</summary>
    public event Action<bool>? SurfacesStarted;

    public bool Has(string key)
    {
        foreach (var slot in _slots)
        {
            if (string.Equals(slot.Key, key, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>入口：按最新 targets 决定「原地换片」还是「重建表面」。</summary>
    public void Apply(IReadOnlyList<DesktopTarget> targets)
    {
        if (_disposed)
        {
            return;
        }

        if (!_ui.CheckAccess())
        {
            _ui.BeginInvoke(new Action(() => Apply(targets)));
            return;
        }

        _targets = targets;

        if (_starting)
        {
            _pending = targets;
            return;
        }

        if (NeedsRebuild(targets))
        {
            StartDesktopSurfaces(targets);
            return;
        }

        UpdateDesktopVideos(targets);
    }

    /// <summary>上一轮启动失败的屏键。用于「别每帧重试同一块坏屏」，但屏集合真变了仍然重建。</summary>
    private readonly HashSet<string> _failedKeys = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>本轮 Apply 的 payload 缓存：N 块屏只算 N 次，而不是 N(N+1) 次。</summary>
    private Dictionary<string, WallpaperLayerPayload?>? _payloadCache;

    /// <summary>屏幕集合没变 → 原地换片；变了 → 返回 true 由调用方重建。</summary>
    private bool NeedsRebuild(IReadOnlyList<DesktopTarget> targets)
    {
        if (targets.Count == 0)
        {
            return _slots.Count > 0;
        }

        // 按屏键判断「屏集合变了没有」。不能用 Count/Index 对齐：
        // 某块屏一次启动失败就会让 _slots 少一项，索引全错位 → 后面每次 Apply 都整层重建（全屏闪黑）。
        var slotKeys = new HashSet<string>(_slots.Count, StringComparer.OrdinalIgnoreCase);
        foreach (var slot in _slots)
        {
            slotKeys.Add(slot.Key);
        }

        foreach (var target in targets)
        {
            if (slotKeys.Contains(target.Key))
            {
                continue;
            }

            // 这块屏上次试过、失败了：不因为「它还没起来」就重建整个桌面层。
            if (_failedKeys.Contains(target.Key))
            {
                continue;
            }

            return true;
        }

        // 反过来：目标里已经没有这块屏了（拔屏/改显示模式）→ 得重建把它收掉。
        foreach (var slot in _slots)
        {
            var stillThere = false;
            foreach (var target in targets)
            {
                if (string.Equals(target.Key, slot.Key, StringComparison.OrdinalIgnoreCase))
                {
                    stillThere = true;
                    break;
                }
            }

            if (!stillThere)
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>重建全部桌面表面（错峰启动，OOM 的屏直接跳过）。</summary>
    public void StartDesktopSurfaces(IReadOnlyList<DesktopTarget> targets)
    {
        if (_disposed)
        {
            return;
        }

        if (!_ui.CheckAccess())
        {
            _ui.BeginInvoke(new Action(() => StartDesktopSurfaces(targets)));
            return;
        }

        _targets = targets;
        StopSurfaces();

        var source = _surfaceSource?.Invoke();
        if (source?.Environment is not { } environment || string.IsNullOrWhiteSpace(source.Value.NavigationUrl))
        {
            HostLog.Warn("[wallpaper] desktop surfaces unavailable: no WebView2 environment");
            SurfacesStarted?.Invoke(false);
            return;
        }

        _starting = true;
        _ = StartSurfacesAsync(environment, source.Value.NavigationUrl!, source.Value.FolderPath, source.Value.VirtualHost, targets);
    }

    private async Task StartSurfacesAsync(
        CoreWebView2Environment environment,
        string navigationUrl,
        string? folderPath,
        string? virtualHost,
        IReadOnlyList<DesktopTarget> targets)
    {
        for (var i = 0; i < targets.Count; i++)
        {
            if (_disposed)
            {
                _starting = false;
                return;
            }

            if (i > 0)
            {
                // 三屏同起会 OOM，必须错峰。
                await Task.Delay(StartStaggerMs).ConfigureAwait(true);
            }

            var target = targets[i];
            DesktopWebSurface? surface = null;
            try
            {
                surface = new DesktopWebSurface(environment, navigationUrl, folderPath, virtualHost, target.Bounds);
                var attached = await surface.StartAsync().ConfigureAwait(true);
                if (_disposed)
                {
                    surface.Dispose();
                    _starting = false;
                    return;
                }

                if (!attached)
                {
                    _failedKeys.Add(target.Key);
                    HostLog.Warn($"[wallpaper] desktop surface #{target.Index} not attached key={MonitorCatalog.Short(target.Key)}");
                    surface.Dispose();
                    continue;
                }

                surface.PageReady += OnSurfacePageReady;
                var slot = new SurfaceSlot
                {
                    Index = target.Index,
                    Key = target.Key,
                    Bounds = target.Bounds,
                    Web = surface,
                    AssetId = target.AssetId,
                };
                _slots.Add(slot);
                _failedKeys.Remove(target.Key);
                HostLog.Info(
                    $"[wallpaper] desktop surface #{slot.Index} ready key={MonitorCatalog.Short(target.Key)} " +
                    $"{target.Bounds.Width}x{target.Bounds.Height} at {target.Bounds.X},{target.Bounds.Y}");
                Push(slot, target);
            }
            catch (Exception exception) when (IsOutOfMemory(exception))
            {
                surface?.Dispose();
                _failedKeys.Add(target.Key);
                HostLog.Warn($"[wallpaper] desktop surface #{target.Index} abandoned: out of memory (0x8007000E)");
            }
            catch (Exception exception)
            {
                surface?.Dispose();
                _failedKeys.Add(target.Key);
                HostLog.Warn($"[wallpaper] desktop surface #{target.Index} failed: {exception.Message}");
            }
        }

        _starting = false;
        if (_disposed)
        {
            return;
        }

        SurfacesStarted?.Invoke(_slots.Count > 0);

        if (_pending is { } pending)
        {
            _pending = null;
            Apply(pending);
        }
    }

    /// <summary>屏幕没增删，只换素材/帧率：原地推新载荷，不碰表面。</summary>
    public void UpdateDesktopVideos(IReadOnlyList<DesktopTarget> targets)
    {
        if (_disposed)
        {
            return;
        }

        if (!_ui.CheckAccess())
        {
            _ui.BeginInvoke(new Action(() => UpdateDesktopVideos(targets)));
            return;
        }

        _payloadCache = BuildPayloadCache(targets);
        try
        {
        foreach (var slot in _slots)
        {
            var target = FindTarget(targets, slot.Key);
            if (target is null)
            {
                continue;
            }

            if (!slot.Bounds.Equals(target.Bounds))
            {
                slot.Bounds = target.Bounds;
                slot.Web.SetBounds(target.Bounds);
                HostLog.Info(
                    $"[wallpaper] desktop surface #{slot.Index} moved to {target.Bounds.X},{target.Bounds.Y} " +
                    $"{target.Bounds.Width}x{target.Bounds.Height}");
            }

            if (slot.AssetId != target.AssetId)
            {
                HostLog.Info(
                    $"[wallpaper] desktop video switched surface={slot.Index} from={FormatAsset(slot.AssetId)} " +
                    $"to={FormatAsset(target.AssetId)}");
                slot.AssetId = target.AssetId;
            }

            Push(slot, target);
        }
        }
        finally
        {
            _payloadCache = null;
        }
    }

    /// <summary>按屏键找目标。`_targets` 每次刷新都重建一批 record，不能按下标配对。</summary>
    private static DesktopTarget? FindTarget(IReadOnlyList<DesktopTarget> targets, string key)
    {
        foreach (var target in targets)
        {
            if (string.Equals(target.Key, key, StringComparison.OrdinalIgnoreCase))
            {
                return target;
            }
        }

        return null;
    }

    /// <summary>本轮所有屏的 payload 只算一遍（每份要读好几次 SQLite，全在 UI 线程）。</summary>
    private Dictionary<string, WallpaperLayerPayload?> BuildPayloadCache(IReadOnlyList<DesktopTarget> targets)
    {
        var map = new Dictionary<string, WallpaperLayerPayload?>(targets.Count, StringComparer.OrdinalIgnoreCase);
        foreach (var target in targets)
        {
            if (map.ContainsKey(target.Key))
            {
                continue;
            }

            map[target.Key] = _payloadFactory(target);
        }

        return map;
    }

    private WallpaperLayerPayload? PayloadOf(DesktopTarget target)
    {
        if (_payloadCache is { } cache && cache.TryGetValue(target.Key, out var cached))
        {
            return cached;
        }

        return _payloadFactory(target);
    }

    /// <summary>把所有表面的当前状态重推一遍（选项变化、页面刚就绪时用）。</summary>
    public void PushAll()
    {
        if (_disposed)
        {
            return;
        }

        if (!_ui.CheckAccess())
        {
            _ui.BeginInvoke(new Action(PushAll));
            return;
        }

        _payloadCache = BuildPayloadCache(_targets);
        try
        {
            foreach (var slot in _slots)
            {
                var target = FindTarget(_targets, slot.Key);
                if (target is null)
                {
                    continue;
                }

                Push(slot, target);
            }
        }
        finally
        {
            _payloadCache = null;
        }
    }

    private void OnSurfacePageReady()
    {
        if (_disposed)
        {
            return;
        }

        PushAll();
    }

    private void Push(SurfaceSlot slot, DesktopTarget target)
    {
        if (_disposed || !slot.Web.IsReady)
        {
            return;
        }

        var payload = PayloadOf(target);

        // 同一张壁纸铺在多块屏上时只让一块屏出声：三路音轨同时播会叠成回声，也白烧三份解码。
        // 想各屏各放声音，就是各屏选不同的壁纸（每块屏还能单独调音量）。
        if (payload is { AudioEnabled: true } && !IsFirstAudibleTarget(target))
        {
            payload = payload with { AudioEnabled = false };
        }

        var online = _onlineSource?.Invoke();
        var baseUrl = online is { } endpoint ? $"http://127.0.0.1:{endpoint.Port}" : null;
        slot.Web.PostState(WallpaperStateJson.Build(payload, null, baseUrl, online?.Token));
    }

    /// <summary>同一张素材最先出现在哪块屏（屏序按 targets 顺序，即系统枚举顺序）。</summary>
    private DesktopTarget? FirstTargetForAsset(long assetId)
    {
        foreach (var target in _targets)
        {
            if (target.AssetId == assetId)
            {
                return target;
            }
        }

        return null;
    }

    /// <summary>
    /// 这块屏是不是「同素材里第一块真正会出声的」。
    /// 只看第一块不够：用户可能把第一块屏的音量拉到 0（或者它是静音覆盖），
    /// 那时声音应该落到下一块同素材的屏上，而不是整个素材都哑掉。
    /// </summary>
    private bool IsFirstAudibleTarget(DesktopTarget self)
    {
        if (PayloadOf(self) is not { AudioEnabled: true }) return false;

        foreach (var target in _targets)
        {
            // 按屏键比，不按引用比：_targets 每次刷新都会重建一批 record，
            // 用 ReferenceEquals 会一个都匹配不上，于是每块屏都当自己是「第一块」→ 多路同时出声。
            if (string.Equals(target.Key, self.Key, StringComparison.OrdinalIgnoreCase)) return true;
            if (target.AssetId != self.AssetId) continue;
            if (PayloadOf(target) is { AudioEnabled: true }) return false;
        }

        return true;
    }

    private void StopSurfaces()
    {
        foreach (var slot in _slots)
        {
            try
            {
                slot.Web.PageReady -= OnSurfacePageReady;
                slot.Web.Dispose();
            }
            catch (Exception exception)
            {
                HostLog.Warn($"[wallpaper] desktop surface #{slot.Index} dispose failed: {exception.Message}");
            }
        }

        _slots.Clear();
    }

    private static bool IsOutOfMemory(Exception exception)
    {
        for (var current = exception; current is not null; current = current.InnerException)
        {
            if (current.HResult == OutOfMemory)
            {
                return true;
            }
        }

        return false;
    }

    private static string FormatAsset(long? assetId) => assetId?.ToString() ?? "none";

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _starting = false;
        _pending = null;
        StopSurfaces();
    }

    private sealed class SurfaceSlot
    {
        public int Index { get; init; }

        public string Key { get; init; } = string.Empty;

        public Rectangle Bounds { get; set; }

        public DesktopWebSurface Web { get; init; } = null!;

        public long? AssetId { get; set; }
    }
}
