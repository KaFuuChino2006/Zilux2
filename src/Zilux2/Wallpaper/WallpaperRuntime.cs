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

    /// <summary>屏幕集合没变 → 原地换片；变了 → 返回 true 由调用方重建。</summary>
    private bool NeedsRebuild(IReadOnlyList<DesktopTarget> targets)
    {
        if (_slots.Count != targets.Count)
        {
            return true;
        }

        for (var i = 0; i < targets.Count; i++)
        {
            // Index 是 1 基；这里写成 i 会恒不成立，导致每次都被当成「换了屏」整层重建。
            if (_slots[i].Index != i + 1)
            {
                return true;
            }

            if (!string.Equals(_slots[i].Key, targets[i].Key, StringComparison.OrdinalIgnoreCase))
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
                HostLog.Info(
                    $"[wallpaper] desktop surface #{slot.Index} ready key={MonitorCatalog.Short(target.Key)} " +
                    $"{target.Bounds.Width}x{target.Bounds.Height} at {target.Bounds.X},{target.Bounds.Y}");
                Push(slot, target);
            }
            catch (Exception exception) when (IsOutOfMemory(exception))
            {
                surface?.Dispose();
                HostLog.Warn($"[wallpaper] desktop surface #{target.Index} abandoned: out of memory (0x8007000E)");
            }
            catch (Exception exception)
            {
                surface?.Dispose();
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

        var count = Math.Min(_slots.Count, targets.Count);
        for (var i = 0; i < count; i++)
        {
            var slot = _slots[i];
            // 1 基比较：写成 i 会恒为 -1，每次整层重建。
            if (slot.Index != i + 1)
            {
                continue;
            }

            var target = targets[i];
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

        for (var i = 0; i < _slots.Count && i < _targets.Count; i++)
        {
            if (_slots[i].Index != i + 1)
            {
                continue;
            }

            Push(_slots[i], _targets[i]);
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

        var payload = _payloadFactory(target);
        var online = _onlineSource?.Invoke();
        var baseUrl = online is { } endpoint ? $"http://127.0.0.1:{endpoint.Port}" : null;
        slot.Web.PostState(WallpaperStateJson.Build(payload, null, baseUrl, online?.Token));
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
