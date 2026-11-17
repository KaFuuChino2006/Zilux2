using System.IO;
using System.IO.Compression;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows.Controls;
using System.Windows.Threading;
using Zilux2.Settings;
using Zilux2.Wallpaper.Data;
using Zilux2.Wallpaper.Library;
using Zilux2.Wallpaper.Media;
using Zilux2.Wallpaper.Model;
using Zilux2.Wallpaper.Render;
using Zilux2.Wallpaper.Rules;

namespace Zilux2.Wallpaper;

/// <summary>单个画布对外暴露的状态（前端 /state 与库页顶部卡片都读它）。</summary>
internal sealed record CanvasSnapshot(
    string Kind,
    long? AssetId,
    string? Title,
    string? CoverPath,
    bool Paused,
    bool Running,
    string? LastError);

/// <summary>整个模块的状态快照。</summary>
internal sealed record WallpaperSnapshot(
    bool Enabled,
    CanvasSnapshot InApp,
    CanvasSnapshot Desktop,
    int LibraryCount,
    bool FfmpegAvailable,
    string? FfmpegPath);

/// <summary>
/// 动态壁纸模块的门面（docs/wallpaper-v2-spec.md §3「控制层」）。
/// 一期只跑软件内画布；桌面层（WorkerW）留 <see cref="AttachDesktop"/> 入口，二期接入同一套解码。
/// 所有对外调用都在 UI 线程发起；解码线程只通过 <see cref="WallpaperCanvasSurface.Submit"/> 交接帧。
/// </summary>
internal sealed class WallpaperHost : IDisposable
{
    private readonly SettingsService _settings;
    private readonly WallpaperDb _db;
    private readonly LibraryStore _store;
    private readonly LibraryScanner _scanner;
    private readonly WallpaperPlayer _player = new();
    private readonly WallpaperCanvasSurface _inApp = new();

    // 桌面层（第 24/27 轮：两块画布各选各的，所以各有独立解码器与表面）
    private readonly WallpaperPlayer _desktopPlayer = new();
    private DesktopSurface? _desktop;
    // 桌面层优先走 WebView2（与软件内同一套 <video> 渲染）；WPF 位图只作回退。
    private WallpaperRuntime? _runtime;
    private bool _webSurfacesFailed;
    private WallpaperAsset? _desktopAsset;
    private bool _desktopPaused;
    private string? _desktopError;
    private readonly DispatcherTimer _rotationTimer;

    // 序列播放（第 85 轮）：与定时轮换互斥，进序列时把定时轮换停掉。
    private readonly DispatcherTimer _sequenceTimer;
    private WallpaperSequence? _inAppSequence;
    private int _sequenceIndex;
    private bool _sequenceAdvancing;
    private readonly RuleEngine _rules;
    private readonly object _gate = new();
    // 画布表面/解码器都是 DispatcherObject：HTTP 线程直接调用会抛「另一个线程拥有该对象」，
    // 所以凡是要改画面的公共入口都先回 UI 线程。
    private readonly Dispatcher _ui;

    /// <summary>随机轮换「播完一轮再重复」用的已播集合（第 10 章第 13 条）。</summary>
    private readonly HashSet<long> _playedThisRound = new();

    private WallpaperAsset? _inAppAsset;
    private (int Width, int Height, int Fps) _decodeSize;

    /// <summary>当前软件内画布的解码尺寸（诊断面板用）。</summary>
    public (int Width, int Height, int Fps) DecodeSize => _decodeSize;

    /// <summary>WPF 渲染档位：0=软件渲染，1=部分硬件，2=全部硬件。</summary>
    public static int RenderTier => System.Windows.Media.RenderCapability.Tier >> 16;
    private bool _inAppPaused;
    /// <summary>最近一次 onset 的时间戳（Environment.TickCount64），供「卡拍切」判定。</summary>
    private long _lastBeatTicks;
    private long _lastBeatSeen;
    /// <summary>等拍的排队项：到点或超时就执行，null 表示没排队。</summary>
    private Action? _beatQueued;
    private long _beatQueuedAt;
    private DispatcherTimer? _beatTimer;
    private string? _lastError;
    private CancellationTokenSource? _scanCancellation;
    private bool _disposed;

    /// <summary>桌面层要开第二个 WebView2：由 MainWindow 注入「怎么拿环境和导航地址」。</summary>
    internal Func<(Microsoft.Web.WebView2.Core.CoreWebView2Environment? Environment, string? NavigationUrl, string? FolderPath, string? VirtualHost)>? WebSurfaceSource { get; set; }

    /// <summary>桌面层推送要用的绝对地址前缀（端口 + token）；由 MainWindow 注入。</summary>
    internal Func<(int Port, string Token)?>? OnlineSource { get; set; }

    public WallpaperHost(SettingsService settings)
    {
        _settings = settings;
        _ui = Dispatcher.CurrentDispatcher;
        WallpaperFolders.Ensure();
        _db = WallpaperDb.Open(WallpaperFolders.Database);
        _store = new LibraryStore(_db);
        _scanner = new LibraryScanner(_store);

        _player.FrameReady += OnFrameReady;
        _player.Ended += OnPlayerEnded;
        _desktopPlayer.FrameReady += OnDesktopFrameReady;
        _desktopPlayer.Ended += OnDesktopPlayerEnded;

        _rotationTimer = new DispatcherTimer();
        _rotationTimer.Tick += (_, _) => Next(CanvasKind.InApp);

        _sequenceTimer = new DispatcherTimer();
        _sequenceTimer.Tick += OnSequenceTick;

        _rules = new RuleEngine(_store);
        _rules.Matched += OnRuleMatched;
        ApplyRotationTimer();

        _settings.WallpaperChanged += OnSettingsChanged;
    }

    /// <summary>素材库（端点与库页要直接查询）。</summary>
    public LibraryStore Store => _store;

    /// <summary>扫描器（端点触发重扫用）。</summary>
    public LibraryScanner Scanner => _scanner;

    /// <summary>扫描进度（后台线程触发）。</summary>
    public event Action<ScanProgress>? ScanProgressChanged;

    /// <summary>画布状态变化（UI 据此刷新顶栏/播放按钮）。</summary>
    public event Action? StateChanged;

    /// <summary>桌面层表面就绪（含重新挂载）后触发，供桌面歌词把自己重新提到壁纸之上。</summary>
    public event Action? DesktopSurfacesReady;

    /// <summary>后台线程也能安全地通知 UI：不在 UI 线程就丢过去再触发。</summary>
    private void RaiseStateChanged()
    {
        PushDesktopState();
        var handler = StateChanged;
        if (handler is null) return;
        if (_ui.CheckAccess()) handler();
        else _ui.BeginInvoke(DispatcherPriority.Background, new Action(handler));
    }

    /// <summary>把软件内画布挂到主窗口内容最底层。</summary>
    public void AttachInApp(Panel panel)
    {
        if (!panel.Children.Contains(_inApp.Root))
        {
            panel.Children.Insert(0, _inApp.Root);
        }
    }

    /// <summary>启动：后台静默扫描一次，然后恢复上次的壁纸（第 66 轮记住状态）。</summary>
    public void Start()
    {
        if (App.Audio is { } audio)
        {
            audio.Frame += OnAudioFrameForBeat;
        }

        _beatTimer ??= new DispatcherTimer(DispatcherPriority.Input) { Interval = TimeSpan.FromMilliseconds(12) };
        _beatTimer.Tick += OnBeatTimerTick;
        _beatTimer.Start();

        var options = _settings.WallpaperSnapshot;
        _rules.Start();
        _scanner.Progress += progress => ScanProgressChanged?.Invoke(progress);
        _ = Task.Run(() => ScanOnce(full: false));

        var canvas = _store.GetCanvas(CanvasKind.InApp, null);
        if (canvas.AssetId is { } assetId && _store.FindById(assetId) is { } asset)
        {
            ApplyToInApp(asset);
        }
        else if (options.Enabled)
        {
            AutoPickInApp();
        }

        if (!options.Enabled) _inApp.SetVisible(false);
    }

    /// <summary>扫描（后台线程安全，内部串行）。</summary>
    public ScanResult ScanOnce(bool full)
    {
        try { _scanCancellation?.Cancel(); } catch (ObjectDisposedException) { }
        var cancellation = new CancellationTokenSource();
        _scanCancellation = cancellation;

        try
        {
            var options = _settings.WallpaperSnapshot;
            var result = _scanner.Scan(options.WatchFolders, full, cancellation.Token);
            RaiseStateChanged();
            return result;
        }
        catch (OperationCanceledException)
        {
            return new ScanResult(0, 0, 0, 0);
        }
        finally
        {
            if (ReferenceEquals(_scanCancellation, cancellation)) _scanCancellation = null;
            // 不 Dispose：可能还有工作线程持有 token，Dispose 会让它抛 ObjectDisposedException。
        }
    }

    /// <summary>导入素材（可复制进库目录）；网页拖拽与「添加素材」都走这里。</summary>
    public IReadOnlyList<long> Import(IReadOnlyList<string> paths, bool copy)
    {
        if (_disposed) return Array.Empty<long>();

        var ids = _scanner.Import(paths, copy, CancellationToken.None);
        RaiseStateChanged();
        return ids;
    }

    /// <summary>
    /// 库里增删之后调：当前正在播的素材被删掉时要立刻换一张，否则画面会僵在已删记录上。
    /// </summary>
    public void RefreshAfterLibraryChange()
    {
        if (!_ui.CheckAccess())
        {
            _ui.Invoke(() => RefreshAfterLibraryChange());
            return;
        }

        if (_disposed) return;

        var currentId = _inAppAsset?.Id;
        if (currentId is { } id)
        {
            var stillThere = _store.FindById(id);
            if (stillThere is null)
            {
                _player.Stop();
                _inApp.Clear();
                _inAppAsset = null;
                AutoPickInApp();
            }
            else
            {
                _inAppAsset = stillThere;
            }
        }

        RaiseStateChanged();
    }

    /// <summary>应用一张壁纸到软件内画布。</summary>
    public void ApplyToInApp(WallpaperAsset asset)
    {
        if (!_ui.CheckAccess())
        {
            _ui.Invoke(() => ApplyToInApp(asset));
            return;
        }

        // 软件内壁纸由页面渲染（§5.6 硬解优先 + 性能门槛）：
        // WPF 每帧上传 1080p 位图在本机要吃掉近一个核，同一段视频交给 Chromium 只要 4%。
        // 所以这里只更新状态并清掉 WPF 画布，画面交给 web 层。
        _player.Stop();
        _inApp.Clear();

        _inAppAsset = asset;
        _inAppPaused = false;
        _lastError = null;
        _store.SaveCanvas(new CanvasState
        {
            Kind = CanvasKind.InApp,
            AssetId = asset.Id,
            Paused = false,
        });

        RaiseStateChanged();
    }

    /// <summary>
    /// 按序列播放（第 85 轮）：有序列表 + 单条时长 + 单条转场，可循环。
    ///
    /// 与定时轮换互斥 —— 序列自己管节奏，再把 15/30 分钟的轮换叠上去会打架。
    /// 单条时长缺省时，优先用素材自身有效长度，其次用全局轮换间隔。
    /// </summary>
    public bool ApplySequence(long sequenceId, CanvasKind kind = CanvasKind.InApp)
    {
        if (!_ui.CheckAccess()) return _ui.Invoke(() => ApplySequence(sequenceId, kind));

        var sequence = _store.ListSequences().FirstOrDefault(item => item.Id == sequenceId);
        if (sequence is null || sequence.Items.Count == 0) return false;

        _inAppSequence = sequence;
        _sequenceIndex = 0;
        _rotationTimer.Stop();
        _rules.Dispose();
        _store.SaveCanvas(new CanvasState
        {
            Kind = kind,
            AssetId = sequence.Items[0].AssetId,
            SequenceId = sequence.Id,
            Paused = false,
        });
        ShowSequenceItem(kind);
        RaiseStateChanged();
        return true;
    }

    /// <summary>退出序列，回到单张。</summary>
    public void ClearSequence(CanvasKind kind = CanvasKind.InApp)
    {
        if (!_ui.CheckAccess())
        {
            _ui.Invoke(() => ClearSequence(kind));
            return;
        }

        _sequenceTimer.Stop();
        _inAppSequence = null;
        _sequenceIndex = 0;
        _store.SaveCanvas(new CanvasState { Kind = kind, AssetId = _inAppAsset?.Id, Paused = _inAppPaused });
        ApplyRotationTimer();
        RaiseStateChanged();
    }

    /// <summary>序列里当前这一条的索引（0 基），没在跑序列时返回 -1。</summary>
    public int SequenceIndex => _inAppSequence is null ? -1 : _sequenceIndex;

    private void ShowSequenceItem(CanvasKind kind)
    {
        var sequence = _inAppSequence;
        if (sequence is null || sequence.Items.Count == 0) return;

        if (_sequenceIndex < 0) _sequenceIndex = 0;
        if (_sequenceIndex >= sequence.Items.Count)
        {
            if (!sequence.Loop)
            {
                _sequenceTimer.Stop();
                return;
            }

            _sequenceIndex = 0;
        }

        var item = sequence.Items[_sequenceIndex];
        if (_store.FindById(item.AssetId) is not { } asset)
        {
            // 素材被删了：跳过这一条，别把整个序列卡死。
            if (sequence.Items.Count <= 1) return;
            _sequenceAdvancing = true;
            try
            {
                _sequenceIndex++;
                ShowSequenceItem(kind);
            }
            finally
            {
                _sequenceAdvancing = false;
            }

            return;
        }

        if (kind == CanvasKind.Desktop) ApplyToDesktop(asset);
        else ApplyToInApp(asset);

        var options = _settings.WallpaperSnapshot;
        var hold = item.DurationMs ?? asset.EffectiveDurationMs;
        if (hold <= 0) hold = Math.Max(5_000, options.RotationMinutes * 60_000);

        _sequenceTimer.Stop();
        _sequenceTimer.Interval = TimeSpan.FromMilliseconds(Math.Clamp(hold, 1_000, 3_600_000));
        _sequenceTimer.Start();
    }

    /// <summary>把叠层配置推给桌面层（软件内由页面画，桌面层没有页面）。</summary>
    private void ApplyDesktopOverlay()
    {
        if (_desktop is null) return;
        var options = _settings.WallpaperSnapshot;
        _desktop.ApplyOverlay(options.OverlayEnabled, options.OverlayTemplate);
    }

    /// <summary>规则命中：按动作切素材或起序列（第 58 轮 B）。</summary>
    private void OnRuleMatched(WallpaperRule rule)
    {
        if (!_ui.CheckAccess())
        {
            _ui.BeginInvoke(DispatcherPriority.Background, new Action(() => OnRuleMatched(rule)));
            return;
        }

        JsonNode? action;
        try
        {
            action = JsonNode.Parse(rule.ActionJson);
        }
        catch
        {
            return;
        }

        if (action is not JsonObject actionObject) return;

        switch (actionObject["type"]?.GetValue<string>())
        {
            case "asset" when actionObject["assetId"] is JsonNode idNode && idNode.GetValueKind() == JsonValueKind.Number:
                if (_store.FindById(idNode.GetValue<long>()) is { } asset)
                {
                    ClearSequence(CanvasKind.InApp);
                    ApplyToInApp(asset);
                }
                break;
            case "sequence" when actionObject["sequenceId"] is JsonNode seqNode && seqNode.GetValueKind() == JsonValueKind.Number:
                ApplySequence(seqNode.GetValue<long>());
                break;
        }
    }

    /// <summary>改完规则后立刻重算（设置页保存规则时会调）。</summary>
    public void EvaluateRules()
    {
        if (!_ui.CheckAccess())
        {
            _ui.BeginInvoke(DispatcherPriority.Background, new Action(EvaluateRules));
            return;
        }

        _rules.Evaluate();
        RaiseStateChanged();
    }

    /// <summary>当前命中的规则名，供诊断面板显示。</summary>
    public string? ActiveRuleName => _rules.ActiveRuleName;

    private void OnSequenceTick(object? sender, EventArgs e)
    {
        if (_inAppSequence is null || _sequenceAdvancing) return;
        _sequenceIndex++;
        ShowSequenceItem(CanvasKind.InApp);
        RaiseStateChanged();
    }

    /* ---------------------------------------------------------- 卡拍切（第 78 轮 C） */

    private void OnAudioFrameForBeat(Zilux2.Audio.AudioFrameSnapshot frame)
    {
        if (!frame.Beat) return;
        _lastBeatTicks = Environment.TickCount64;
        _lastBeatSeen = _lastBeatTicks;
    }

    private bool IsMusicBeating()
    {
        var last = Interlocked.Read(ref _lastBeatTicks);
        return last != 0 && Environment.TickCount64 - last < 1200;
    }

    private void OnBeatTimerTick(object? sender, EventArgs e)
    {
        if (_beatQueued is not { } queued) return;

        var waited = Environment.TickCount64 - _beatQueuedAt;
        var beatHit = Environment.TickCount64 - Interlocked.Read(ref _lastBeatSeen) < 40;
        // 命中的是排队之后产生的那一拍；等不到拍就 1.5 秒兜底，别把切换卡死。
        if (!beatHit && waited < 1500) return;

        _beatQueued = null;
        queued();
    }

    /// <summary>切下一张（收藏优先 / 随机或顺序）。</summary>
    public void Next(CanvasKind kind = CanvasKind.InApp)
    {
        if (!_ui.CheckAccess())
        {
            _ui.Invoke(() => Next(kind));
            return;
        }

        var options = _settings.WallpaperSnapshot;
        var ids = _store.ListRotatableIds(options.RotationFavoriteFirst);
        if (ids.Count == 0) return;

        // 卡拍切（第 78 轮 C）：开启且音乐正在播（1.2 秒内有过 onset）时，把切换推迟到下一拍。
        if (options.BeatLock && IsMusicBeating())
        {
            _beatQueued = () => Next(kind);
            _beatQueuedAt = Environment.TickCount64;
            return;
        }

        var index = _inAppAsset is null ? -1 : ids.IndexOf(_inAppAsset.Id);
        long nextId;

        if (options.RotationOrder == WallpaperSettings.RotationRandom)
        {
            if (ids.Count == 1) nextId = ids[0];
            else
            {
                // 随机但「播完一轮再重复」（第 10 章第 13 条）：把本轮已经播过的排除掉，
                // 全都播过了就清空重来 —— 这样一轮之内不会撞到同一张，也不会像纯随机会连续重复。
                if (_inAppAsset is { } current) _playedThisRound.Add(current.Id);
                var pool = ids.Where(id => !_playedThisRound.Contains(id)).ToList();
                if (pool.Count == 0)
                {
                    _playedThisRound.Clear();
                    if (_inAppAsset is { } again) _playedThisRound.Add(again.Id);
                    pool = ids.Where(id => id != _inAppAsset?.Id).ToList();
                    if (pool.Count == 0) pool = ids;
                }

                nextId = pool[Random.Shared.Next(pool.Count)];
            }
        }
        else
        {
            nextId = ids[(index + 1 + ids.Count) % ids.Count];
            _playedThisRound.Clear();
        }

        if (_store.FindById(nextId) is not { } asset) return;
        if (kind == CanvasKind.Desktop) ApplyToDesktop(asset);
        else ApplyToInApp(asset);
    }

    /// <summary>暂停 / 继续（暂停冻结当前帧，第 4 轮）。</summary>
    public void Pause(CanvasKind kind, bool paused)
    {
        if (!_ui.CheckAccess())
        {
            _ui.Invoke(() => Pause(kind, paused));
            return;
        }

        if (kind == CanvasKind.Desktop)
        {
            _desktopPaused = paused;
            if (paused) _desktopPlayer.Pause(); else _desktopPlayer.Resume();
            _store.SaveCanvas(new CanvasState { Kind = CanvasKind.Desktop, AssetId = _desktopAsset?.Id, Paused = paused });
            RaiseStateChanged();
            return;
        }

        _inAppPaused = paused;
        _player.Pause();
        _store.SaveCanvas(new CanvasState { Kind = CanvasKind.InApp, AssetId = _inAppAsset?.Id, Paused = paused });
        RaiseStateChanged();
    }

    /// <summary>整层显隐（总开关 / 页面策略 / 最小化都会调它）。</summary>
    public void SetVisible(bool visible)
    {
        if (!_ui.CheckAccess())
        {
            _ui.Invoke(() => SetVisible(visible));
            return;
        }

        _inApp.SetVisible(visible && _inAppAsset is not null);
        if (!visible) _player.Pause();
        else if (!_inAppPaused) _player.Resume();
    }

    /// <summary>当前状态快照。</summary>
    public WallpaperSnapshot Snapshot()
    {
        if (!_ui.CheckAccess()) return _ui.Invoke(() => Snapshot());

        var options = _settings.WallpaperSnapshot;
        var inApp = new CanvasSnapshot(
            "inapp",
            _inAppAsset?.Id,
            _inAppAsset?.Title,
            _inAppAsset?.CoverPath,
            _inAppPaused,
            _inAppAsset is not null && !_inAppPaused,
            _lastError);

        var desktop = new CanvasSnapshot(
            "desktop",
            _desktopAsset?.Id,
            _desktopAsset?.Title,
            _desktopAsset?.CoverPath,
            _desktopPaused,
            _runtime is not null ? _desktopAsset is not null && !_desktopPaused : _desktopPlayer.IsRunning,
            _desktopError);
        var (_, total) = _store.List(new AssetQuery { Limit = 1 });

        return new WallpaperSnapshot(
            options.Enabled,
            inApp,
            desktop,
            total,
            FfmpegLocator.FfmpegPath is not null,
            FfmpegLocator.FfmpegPath);
    }

    private void OnFrameReady(ReadOnlyMemory<byte> frame, int width, int height)
    {
        _inApp.Submit(frame, width, height);
    }

    private void OnPlayerEnded(VideoOpenFailure failure)
    {
        if (failure != VideoOpenFailure.None)
        {
            _lastError = DescribeFailure(failure);
            RaiseStateChanged();
            return;
        }

        // 不循环的素材播完了就停住最后一帧（循环由 ffmpeg -stream_loop 负责，通常走不到这里）。
        _inAppPaused = true;
        RaiseStateChanged();
    }

    private void AutoPickInApp()
    {
        var options = _settings.WallpaperSnapshot;
        var ids = _store.ListRotatableIds(options.RotationFavoriteFirst);
        if (ids.Count == 0) return;
        if (_store.FindById(ids[0]) is { } asset) ApplyToInApp(asset);
    }

    /// <summary>按画布实际像素 + 渲染分辨率与帧率上限算解码目标尺寸（第 59 轮 / §5.6）。</summary>
    private (int Width, int Height, int Fps) ResolveTargetSize(WallpaperAsset asset, CanvasKind kind = CanvasKind.InApp)
    {
        var options = _settings.WallpaperSnapshot;
        var scale = Math.Clamp(options.RenderScale, 25, 100) / 100.0;

        var width = asset.Width ?? 1920;
        var height = asset.Height ?? 1080;

        // 按画布实际像素收口：素材比画布大就降到画布大小（cover 语义，只缩不放）。
        // 之前按素材尺寸解码，3440×1440 的工坊视频会把 CPU 拉满、位图也白占内存。
        var (canvasWidth, canvasHeight) = kind == CanvasKind.Desktop ? DesktopPixels() : InAppPixels();
        if (canvasWidth > 1 && canvasHeight > 1)
        {
            var cover = Math.Max(canvasWidth / (double)width, canvasHeight / (double)height);
            if (cover < 1.0)
            {
                width = Math.Max(2, (int)Math.Round(width * cover));
                height = Math.Max(2, (int)Math.Round(height * cover));
            }
        }

        if (options.DownsampleAbove > 0 && height > options.DownsampleAbove)
        {
            var factor = options.DownsampleAbove / (double)height;
            width = (int)(width * factor);
            height = options.DownsampleAbove;
        }

        width = Math.Max(2, (int)(width * scale));
        height = Math.Max(2, (int)(height * scale));

        // 偶数尺寸给 BGRA 管道留余量，避免 ffmpeg 在 pad/scale 上贴边。
        width += width % 2;
        height += height % 2;

        var fps = options.FrameRateLimit <= 0 ? 60 : Math.Clamp(options.FrameRateLimit, 15, 144);

        if (kind == CanvasKind.Desktop)
        {
            // 桌面层没有页面可用，只能走 WPF 位图管线；这条路线在 1440p60 下要吃一个多核。
            // 桌面壁纸是背景画面，30fps + 半分辨率肉眼几乎看不出差别，CPU 却能砍掉一多半。
            width = Math.Max(2, width / 2);
            height = Math.Max(2, height / 2);
            fps = Math.Min(fps, 30);
        }

        return (width, height, fps);
    }

    /// <summary>软件内画布的实际像素尺寸（窗口客户区 × DPI）。</summary>
    private (int Width, int Height) InAppPixels()
    {
        var root = _inApp.Root;
        var dipWidth = root.ActualWidth;
        var dipHeight = root.ActualHeight;
        if (dipWidth < 2 || dipHeight < 2) return (1920, 1080);

        var dpi = System.Windows.Media.VisualTreeHelper.GetDpi(root);
        return ((int)Math.Round(dipWidth * dpi.DpiScaleX), (int)Math.Round(dipHeight * dpi.DpiScaleY));
    }

    /// <summary>桌面层的像素尺寸（主屏物理像素）。</summary>
    private static (int Width, int Height) DesktopPixels()
    {
        var area = System.Windows.Forms.Screen.PrimaryScreen;
        if (area is null) return (1920, 1080);
        var bounds = area.Bounds;
        return (bounds.Width > 1 ? bounds.Width : 1920, bounds.Height > 1 ? bounds.Height : 1080);
    }

    /// <summary>按设置挑这次用的转场：fixed 用指定预设，random 从池里随机（排除列表生效）。</summary>
    private static Render.WallpaperTransitionId ResolveTransition(WallpaperSettings options)
    {
        if (options.TransitionMode == WallpaperSettings.TransitionFixed)
        {
            var fixedId = Render.WallpaperTransitions.Parse(options.TransitionId);
            if (fixedId is { } chosen) return chosen;
        }

        var exclude = options.TransitionExclude;
        if (exclude.Count == 0) return Render.WallpaperTransitions.PickRandom();

        var pool = new List<Render.WallpaperTransitionId>(Render.WallpaperTransitions.All.Length);
        foreach (var candidate in Render.WallpaperTransitions.All)
        {
            var key = Render.WallpaperTransitions.Key(candidate);
            if (!exclude.Contains(key, StringComparer.OrdinalIgnoreCase)) pool.Add(candidate);
        }

        return pool.Count == 0 ? Render.WallpaperTransitions.PickRandom() : pool[Random.Shared.Next(pool.Count)];
    }

    private static string DescribeFailure(VideoOpenFailure failure) => failure switch
    {
        VideoOpenFailure.FfmpegMissing => "找不到 ffmpeg，无法解码视频",
        VideoOpenFailure.FileMissing => "文件不存在",
        VideoOpenFailure.ProcessFailed => "ffmpeg 启动失败",
        _ => "解码失败",
    };

    private void ApplyRotationTimer()
    {
        var options = _settings.WallpaperSnapshot;
        if (!options.RotationEnabled)
        {
            _rotationTimer.Stop();
            return;
        }

        _rotationTimer.Interval = TimeSpan.FromMinutes(Math.Clamp(options.RotationMinutes, 1, 1440));
        _rotationTimer.Start();
    }

    private void OnSettingsChanged()
    {
        // 设置来自任意线程；UI 相关操作用 Dispatcher 兜一层。
        var dispatcher = _inApp.Root.Dispatcher;
        if (!dispatcher.CheckAccess())
        {
            dispatcher.BeginInvoke(() => OnSettingsChanged());
            return;
        }

        var options = _settings.WallpaperSnapshot;
        _inApp.DimOpacity = options.DimMode switch
        {
            WallpaperSettings.DimOff => 0,
            WallpaperSettings.DimFixed => options.DimBase,
            _ => options.DimBase,
        };

        if (!options.Enabled)
        {
            SetVisible(false);
        }
        else if (_inAppAsset is not null)
        {
            SetVisible(true);
        }

        ApplyRotationTimer();

        // 软件内画面已经交给页面里的 <video>（第 2026-11-15 架构迁移），这里只更新诊断用的尺寸，
        // 不再起 ffmpeg 解码进程 —— 否则每次改设置都会偷偷拉一个子进程，CPU 直接回到 80%。
        if (_inAppAsset is { Kind: AssetKind.Video } asset)
        {
            var (width, height, fps) = ResolveTargetSize(asset);
            _decodeSize = (width, height, fps);
        }

        RaiseStateChanged();
        ApplyDesktopOverlay();
    }

    /// <summary>接管桌面（第 66 轮：手动接管 + 记住状态）。返回是否挂上了 WorkerW。</summary>
    public bool AttachDesktop()
    {
        if (!_ui.CheckAccess()) return _ui.Invoke(() => AttachDesktop());

        if (_disposed) return false;

        try
        {
            // 首选 WebView2：桌面层和软件内共用页面里的 <video>，CPU 只有个位数。
            // 多屏（第 88 轮）：每块屏一块表面，统一交给 WallpaperRuntime。
            if (_runtime is null && !_webSurfacesFailed)
            {
                var source = WebSurfaceSource?.Invoke();
                if (source?.Environment is { } environment && !string.IsNullOrWhiteSpace(source.Value.NavigationUrl))
                {
                    var runtime = new WallpaperRuntime(_ui, WebSurfaceSource, BuildMonitorPayload, OnlineSource);
                    runtime.SurfacesStarted += ready => OnDesktopSurfacesStarted(runtime, ready);
                    _runtime = runtime;
                    _desktopError = null;
                    RestoreDesktopCanvas();
                    runtime.Apply(BuildDesktopTargets());
                    _settings.UpdateWallpaper(options => options.DesktopAttached = true);
                    RaiseStateChanged();
                    return true;
                }
            }
            else if (_runtime is not null)
            {
                _desktopError = null;
                RestoreDesktopCanvas();
                RefreshDesktopTargets();
                _settings.UpdateWallpaper(options => options.DesktopAttached = true);
                RaiseStateChanged();
                return true;
            }

            // 回退：WPF 位图（WebView2 环境还没就绪时也能先把壁纸铺上去）。
            _desktop ??= new DesktopSurface();
            if (!_desktop.Attach())
            {
                _desktopError = "找不到可用的桌面层（资源管理器可能未运行）";
                RaiseStateChanged();
                return false;
            }

            _desktopError = null;

            // 恢复上次桌面画布的素材，没有就挑一张（两块画布各选各的）。
            var canvas = _store.GetCanvas(CanvasKind.Desktop, null);
            var asset = canvas.AssetId is { } id ? _store.FindById(id) : null;
            asset ??= AutoPickDesktop();
            if (asset is not null) ApplyToDesktop(asset);

            _settings.UpdateWallpaper(options => options.DesktopAttached = true);
            ApplyDesktopOverlay();
            RaiseStateChanged();
            return true;
        }
        catch (Exception exception)
        {
            _desktopError = exception.Message;
            RaiseStateChanged();
            return false;
        }
    }

    /// <summary>取消桌面接管。</summary>
    public void DetachDesktop()
    {
        if (!_ui.CheckAccess())
        {
            _ui.Invoke(() => DetachDesktop());
            return;
        }

        try
        {
            _desktopPlayer.Stop();
            _desktop?.Detach();
            _runtime?.Dispose();
            _runtime = null;
            _webSurfacesFailed = false;
        }
        catch
        {
            // 资源管理器重启时句柄可能已经失效。
        }

        _settings.UpdateWallpaper(options => options.DesktopAttached = false);
        RaiseStateChanged();
    }

    /// <summary>显示器/分辨率变化后让桌面层重铺一次。</summary>
    public void RepositionDesktop()
    {
        if (!_ui.CheckAccess())
        {
            _ui.Invoke(RepositionDesktop);
            return;
        }

        try
        {
            RefreshDesktopTargets();
            _desktop?.ResizeTo(
                Math.Max(1, (int)System.Windows.SystemParameters.PrimaryScreenWidth),
                Math.Max(1, (int)System.Windows.SystemParameters.PrimaryScreenHeight));
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[wallpaper] reposition desktop failed: {exception.Message}");
        }
    }

    /// <summary>把一张壁纸应用到桌面层（与软件内同一套解码与转场）。</summary>
    public void ApplyToDesktop(WallpaperAsset asset)
    {
        if (!_ui.CheckAccess())
        {
            _ui.Invoke(() => ApplyToDesktop(asset));
            return;
        }

        if (_disposed) return;

        _desktopAsset = asset;
        _desktopPaused = false;
        _desktopError = null;
        _store.SaveCanvas(new CanvasState { Kind = CanvasKind.Desktop, AssetId = asset.Id });

        // 桌面层走 WebView2 时，画面由页面自己画，宿主只负责更新状态并推过去。
        if (_runtime is not null)
        {
            RefreshDesktopTargets();
            RaiseStateChanged();
            return;
        }

        _desktopPlayer.Stop();
        var options = _settings.WallpaperSnapshot;
        _desktop?.Surface.BeginTransition(ResolveTransition(options), options.TransitionMs);

        switch (asset.Kind)
        {
            case AssetKind.Video:
            {
                var (width, height, fps) = ResolveTargetSize(asset, CanvasKind.Desktop);
                if (!_desktopPlayer.Play(asset, width, height, fps, loop: true, hardwareDecode: _settings.WallpaperSnapshot.HardwareDecode, out var failure))
                {
                    _desktopError = DescribeFailure(failure);
                    if (!string.IsNullOrEmpty(asset.CoverPath)) _desktop?.Surface.ShowImage(asset.CoverPath);
                }

                break;
            }

            case AssetKind.Image:
            case AssetKind.Gif:
                _desktop?.Surface.ShowImage(asset.Path);
                break;
        }

        _desktop?.Surface.DimOpacity = options.DimMode switch
        {
            WallpaperSettings.DimOff => 0,
            _ => options.DimBase,
        };

        _store.SaveCanvas(new CanvasState { Kind = CanvasKind.Desktop, AssetId = asset.Id });
        RaiseStateChanged();
    }

    /// <summary>恢复桌面画布上次选的素材，没有就挑一张（两块画布各选各的）。</summary>
    private void RestoreDesktopCanvas()
    {
        var canvas = _store.GetCanvas(CanvasKind.Desktop, null);
        var asset = canvas.AssetId is { } id ? _store.FindById(id) : null;
        asset ??= AutoPickDesktop();
        if (asset is not null)
        {
            ApplyToDesktop(asset);
        }
    }

    /// <summary>把桌面层状态推给每块屏上的页面（各自一份，互不干扰）。</summary>
    private void PushDesktopState()
    {
        if (_runtime is null) return;
        // WebView2 的 PostWebMessageAsJson 只能在 UI 线程调，后台线程一律转过去。
        if (!_ui.CheckAccess())
        {
            _ui.BeginInvoke(new Action(PushDesktopState));
            return;
        }

        try
        {
            _runtime.PushAll();
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[wallpaper] desktop state push failed: {exception.Message}");
        }
    }

    /// <summary>桌面表面一轮启动结束（false = 一块都没挂上，退回 WPF 位图）。</summary>
    private void OnDesktopSurfacesStarted(WallpaperRuntime runtime, bool anyReady)
    {
        if (!_ui.CheckAccess())
        {
            _ui.BeginInvoke(new Action(() => OnDesktopSurfacesStarted(runtime, anyReady)));
            return;
        }

        if (!ReferenceEquals(_runtime, runtime)) return;

        if (anyReady)
        {
            HostLog.Info($"[wallpaper] desktop surfaces ready count={runtime.SurfaceCount}");
            RaiseStateChanged();
            // 壁纸表面刚插到图标层下面，可能盖住了同样挂在 Progman 下的桌面歌词窗口：
            // 让它自己重新挂一次，保证歌词永远在壁纸之上。
            DesktopSurfacesReady?.Invoke();
            return;
        }

        HostLog.Warn("[wallpaper] desktop surfaces unavailable, falling back to WPF bitmap");
        _webSurfacesFailed = true;
        _desktopError = "桌面层页面初始化失败，已回退到位图渲染";
        _runtime = null;
        runtime.Dispose();
        AttachDesktop();
    }

    /// <summary>
    /// 每块屏要铺什么（第 88 轮）：先读该屏自己的 canvases 行，
    /// 没单独指定（asset_id 为 null 或整行不存在）就跟全局那行走。
    /// </summary>
    private IReadOnlyList<DesktopTarget> BuildDesktopTargets()
    {
        var screens = System.Windows.Forms.Screen.AllScreens;
        var global = _store.GetCanvas(CanvasKind.Desktop, null);
        var globalAsset = global.AssetId is { } globalId ? _store.FindById(globalId) : null;
        var fallbackId = globalAsset?.Id ?? _desktopAsset?.Id ?? AutoPickDesktop()?.Id;

        var targets = new List<DesktopTarget>(screens.Length);
        for (var index = 0; index < screens.Length; index++)
        {
            var screen = screens[index];
            var key = MonitorCatalog.KeyOf(screen);
            var canvas = _store.GetCanvas(CanvasKind.Desktop, key);
            var assetId = canvas.AssetId ?? fallbackId;
            targets.Add(new DesktopTarget(
                key,
                index + 1,
                screen.Bounds,
                screen.Primary,
                assetId,
                MonitorCatalog.ReadFps(canvas.FilterJson, MonitorCatalog.MaxRefresh(screen))));
        }

        return targets;
    }

    /// <summary>
    /// 主屏桌面层此刻该播的载荷。桌面背景歌词窗口要跟桌面壁纸走（不是软件内那张），
    /// 所以它拿的是这一份，而不是 <see cref="BuildLayerPayload"/>。
    /// </summary>
    public WallpaperLayerPayload? BuildPrimaryDesktopPayload()
    {
        if (!_ui.CheckAccess()) return _ui.Invoke(BuildPrimaryDesktopPayload);
        var targets = BuildDesktopTargets();
        var primary = targets.FirstOrDefault(target => target.Primary) ?? targets.FirstOrDefault();
        return primary is null ? null : BuildMonitorPayload(primary);
    }

    /// <summary>一块屏当前该推的载荷（运行时的回调）。</summary>
    private WallpaperLayerPayload? BuildMonitorPayload(DesktopTarget target)
    {
        var asset = target.AssetId is { } assetId ? _store.FindById(assetId) : null;
        if (asset is null) return null;
        var canvas = _store.GetCanvas(CanvasKind.Desktop, target.Key);
        return BuildPayload(
            asset,
            _desktopPaused,
            _settings.WallpaperSnapshot.Enabled,
            CanvasSettings.Read(canvas.FilterJson, asset.Transform),
            target.Fps);
    }

    /// <summary>按最新屏/画布重建 targets 并推给运行时（原地换片优先）。</summary>
    private void RefreshDesktopTargets()
    {
        if (!_ui.CheckAccess())
        {
            _ui.BeginInvoke(new Action(RefreshDesktopTargets));
            return;
        }

        _runtime?.Apply(BuildDesktopTargets());
    }

    /// <summary>设置页「屏幕」卡片读的每屏状态。</summary>
    public List<MonitorSnapshot> Monitors()
    {
        if (!_ui.CheckAccess()) return _ui.Invoke(() => Monitors());

        var screens = System.Windows.Forms.Screen.AllScreens;
        var global = _store.GetCanvas(CanvasKind.Desktop, null);
        var globalAsset = global.AssetId is { } globalId ? _store.FindById(globalId) : null;
        var result = new List<MonitorSnapshot>(screens.Length);

        for (var index = 0; index < screens.Length; index++)
        {
            var screen = screens[index];
            var key = MonitorCatalog.KeyOf(screen);
            var canvas = _store.GetCanvas(CanvasKind.Desktop, key);
            var maxFps = MonitorCatalog.MaxRefresh(screen);
            var following = canvas.AssetId is null;
            var asset = following
                ? globalAsset
                : canvas.AssetId is { } id ? _store.FindById(id) : null;
            result.Add(new MonitorSnapshot(
                key,
                index + 1,
                screen.Bounds.X,
                screen.Bounds.Y,
                screen.Bounds.Width,
                screen.Bounds.Height,
                screen.Primary,
                asset?.Id,
                MonitorCatalog.ReadFps(canvas.FilterJson, maxFps),
                maxFps,
                following,
                _runtime?.Has(key) == true,
                asset?.Title,
                asset?.CoverPath));
        }

        return result;
    }

    /// <summary>
    /// 改一块屏的画布（第 88 轮）：follow=true 时把 asset_id 写空 → 跟着全局走；
    /// 否则只写这块屏这一行，全局那行不动。
    /// </summary>
    public bool SaveMonitor(string key, long? assetId, int? fps, bool follow, out string? error)
    {
        if (!_ui.CheckAccess())
        {
            var outcome = _ui.Invoke(() => SaveMonitorCore(key, assetId, fps, follow));
            error = outcome.Error;
            return outcome.Ok;
        }

        var local = SaveMonitorCore(key, assetId, fps, follow);
        error = local.Error;
        return local.Ok;
    }

    private (bool Ok, string? Error) SaveMonitorCore(string key, long? assetId, int? fps, bool follow)
    {
        var screen = MonitorCatalog.Find(System.Windows.Forms.Screen.AllScreens, key);
        if (screen is null) return (false, "没有这块屏");

        var monitorKey = MonitorCatalog.KeyOf(screen);
        if (!follow && assetId is { } id && _store.FindById(id) is null)
        {
            return (false, "没有这条素材");
        }

        var current = _store.GetCanvas(CanvasKind.Desktop, monitorKey);
        var maxFps = MonitorCatalog.MaxRefresh(screen);
        var nextFps = MonitorCatalog.Clamp(fps ?? MonitorCatalog.ReadFps(current.FilterJson), maxFps);
        var next = new CanvasState
        {
            Kind = CanvasKind.Desktop,
            MonitorId = monitorKey,
            AssetId = follow ? null : assetId ?? current.AssetId,
            SequenceId = null,
            FitMode = current.FitMode,
            FilterJson = MonitorCatalog.WriteFps(current.FilterJson, nextFps),
            TransitionId = current.TransitionId,
            Paused = current.Paused,
        };
        _store.SaveCanvas(next);

        HostLog.Info(
            $"[wallpaper] monitor canvas saved key={MonitorCatalog.Short(monitorKey)} " +
            $"asset={next.AssetId?.ToString() ?? "global"} fps={MonitorCatalog.ReadFps(next.FilterJson)} maxFps={maxFps}");

        RefreshDesktopTargets();
        RaiseStateChanged();
        return (true, null);
    }

    /// <summary>一块屏对外暴露的状态（/api/wallpaper/v2/monitors）。</summary>
    internal sealed record MonitorSnapshot(
        string Key,
        int Index,
        int X,
        int Y,
        int Width,
        int Height,
        bool Primary,
        long? AssetId,
        int Fps,
        int MaxFps,
        bool Follow,
        bool Attached,
        string? Title,
        string? CoverPath);

    /// <summary>一个画布的画面参数（/api/wallpaper/v2/canvas/{kind}/settings 读回来的）。</summary>
    internal sealed record CanvasSettingsSnapshot(
        string Kind,
        string? Monitor,
        bool Follow,
        long? AssetId,
        int Fps,
        int MaxFps,
        CanvasOverrides Picture);

    /// <summary>
    /// 读某个画布的画面参数：软件内只有一份；桌面层按屏各一份（monitorKey 必填）。
    /// </summary>
    public CanvasSettingsSnapshot? CanvasSettingsOf(CanvasKind kind, string? monitorKey, out string? error)
    {
        if (!_ui.CheckAccess())
        {
            var local = _ui.Invoke(() => (Snapshot: CanvasSettingsOf(kind, monitorKey, out var invokeError), Error: invokeError));
            error = local.Error;
            return local.Snapshot;
        }

        error = null;
        if (kind == CanvasKind.InApp)
        {
            var canvas = _store.GetCanvas(CanvasKind.InApp, null);
            var asset = _inAppAsset ?? (canvas.AssetId is { } id ? _store.FindById(id) : null);
            var inAppPicture = CanvasSettings.Read(
                canvas.FilterJson,
                asset?.Transform ?? new WallpaperTransform());
            return new CanvasSettingsSnapshot("inapp", null, false, asset?.Id, 0, 0, inAppPicture);
        }

        var screen = MonitorCatalog.Find(System.Windows.Forms.Screen.AllScreens, monitorKey);
        if (screen is null) return null;

        var key = MonitorCatalog.KeyOf(screen);
        var row = _store.GetCanvas(CanvasKind.Desktop, key);
        var global = _store.GetCanvas(CanvasKind.Desktop, null);
        var following = row.AssetId is null;
        var effectiveId = row.AssetId ?? global.AssetId;
        var target = effectiveId is { } assetId ? _store.FindById(assetId) : null;
        var maxFps = MonitorCatalog.MaxRefresh(screen);
        var baseTransform = target?.Transform ?? new WallpaperTransform();
        var picture = following
            // 跟随全局：全局面板调的那套先叠上，本屏自己再调的在最上面。
            ? CanvasSettings.Read(row.FilterJson, CanvasSettings.Read(global.FilterJson, baseTransform))
            : CanvasSettings.Read(row.FilterJson, baseTransform);

        return new CanvasSettingsSnapshot(
            "desktop",
            key,
            following,
            effectiveId,
            MonitorCatalog.ReadFps(row.FilterJson, maxFps),
            maxFps,
            picture);
    }

    /// <summary>
    /// 写某个画布的画面参数（模糊 / 镜像 / 旋转 / 裁剪 / 缩放，桌面层还可带 fps）。
    /// 只动 filter_json 里自己认识的键，写完立刻重推该画布，不需要再「应用一次」。
    /// </summary>
    public bool SaveCanvasSettings(CanvasKind kind, string? monitorKey, JsonObject patch, out string? error)
    {
        if (!_ui.CheckAccess())
        {
            var outcome = _ui.Invoke(() => (Ok: SaveCanvasSettingsCore(kind, monitorKey, patch, out var invokeError), Error: invokeError));
            error = outcome.Error;
            return outcome.Ok;
        }

        var local = SaveCanvasSettingsCore(kind, monitorKey, patch, out error);
        return local;
    }

    private bool SaveCanvasSettingsCore(CanvasKind kind, string? monitorKey, JsonObject patch, out string? error)
    {
        error = null;
        string? key = null;
        var maxFps = 0;
        if (kind == CanvasKind.Desktop)
        {
            var screen = MonitorCatalog.Find(System.Windows.Forms.Screen.AllScreens, monitorKey);
            if (screen is null)
            {
                error = "没有这块屏";
                return false;
            }

            key = MonitorCatalog.KeyOf(screen);
            maxFps = MonitorCatalog.MaxRefresh(screen);
        }

        var current = _store.GetCanvas(kind, key);
        var filterJson = CanvasSettings.Merge(current.FilterJson, patch);
        if (patch["fps"] is JsonValue fpsValue && fpsValue.TryGetValue<int>(out var fps) && kind == CanvasKind.Desktop)
        {
            filterJson = MonitorCatalog.WriteFps(filterJson, MonitorCatalog.Clamp(fps, maxFps));
        }

        var next = new CanvasState
        {
            Kind = kind,
            MonitorId = key,
            AssetId = current.AssetId,
            SequenceId = current.SequenceId,
            FitMode = current.FitMode,
            FilterJson = filterJson,
            TransitionId = current.TransitionId,
            Paused = current.Paused,
        };
        _store.SaveCanvas(next);

        HostLog.Info(
            $"[wallpaper] canvas settings saved kind={(kind == CanvasKind.Desktop ? "desktop" : "inapp")} " +
            $"monitor={(key is null ? "global" : MonitorCatalog.Short(key))} " +
            $"keys={string.Join(',', patch.Select(pair => pair.Key).Where(name => !string.Equals(name, "monitor", StringComparison.OrdinalIgnoreCase)))}");

        if (kind == CanvasKind.Desktop) RefreshDesktopTargets();
        RaiseStateChanged();
        return true;
    }

    private WallpaperAsset? AutoPickDesktop()
    {
        var options = _settings.WallpaperSnapshot;
        var ids = _store.ListRotatableIds(options.RotationFavoriteFirst);
        return ids.Count == 0 ? null : _store.FindById(ids[0]);
    }

    private void OnDesktopFrameReady(ReadOnlyMemory<byte> frame, int width, int height)
    {
        _desktop?.Surface.Submit(frame, width, height);
    }

    private void OnDesktopPlayerEnded(VideoOpenFailure failure)
    {
        if (failure != VideoOpenFailure.None)
        {
            _desktopError = DescribeFailure(failure);
            RaiseStateChanged();
        }
    }

    /// <summary>
    /// 导出一份诊断包（第 60 轮 D：面板 + 日志 + 导出 zip + 自检按钮）。
    /// 内容：状态快照、素材统计、最近日志尾部、库目录清单。zip 落在库目录的 exports\ 下。
    /// </summary>
    public string ExportDiagnostics()
    {
        if (!_ui.CheckAccess()) return _ui.Invoke(() => ExportDiagnostics());

        var exportDir = Path.Combine(WallpaperFolders.Root, "exports");
        Directory.CreateDirectory(exportDir);

        var stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss");
        var zipPath = Path.Combine(exportDir, $"wallpaper-diag-{stamp}.zip");
        if (File.Exists(zipPath)) File.Delete(zipPath);

        using (var archive = ZipFile.Open(zipPath, ZipArchiveMode.Create))
        {
            WriteEntry(archive, "state.json", BuildDiagnosticsJson());
            WriteEntry(archive, "library.txt", BuildLibraryListing());
            WriteEntry(archive, "log.txt", TailLog(2000));
        }

        return zipPath;
    }

    /// <summary>自检（第 60 轮 D）：返回逐项检查结果，前端直接列成清单。</summary>
    public List<(string Name, bool Ok, string Detail)> SelfCheck()
    {
        if (!_ui.CheckAccess()) return _ui.Invoke(() => SelfCheck());

        var checks = new List<(string Name, bool Ok, string Detail)>();

        checks.Add(("FFmpeg 可用", FfmpegLocator.Available,
            FfmpegLocator.FfmpegPath ?? "未找到 ffmpeg（解码会退化为静态封面）"));

        var (count, totalBytes, _) = _store.Stats();
        checks.Add(("素材库", count > 0, $"{count} 个素材 / {totalBytes / (1024.0 * 1024.0):F1} MB"));

        var canvas = _store.GetCanvas(CanvasKind.InApp, null);
        checks.Add(("软件内画布", canvas.AssetId is not null,
            canvas.AssetId is { } id && _store.FindById(id) is { } asset ? asset.Title ?? asset.Path : "还没有选择壁纸"));

        var snapshot = Snapshot();
        checks.Add(("软件内解码", snapshot.InApp.Running || snapshot.InApp.Paused,
            snapshot.InApp.LastError ?? (snapshot.InApp.Running ? "正在出帧" : "未运行")));

        // 桌面层可选（§5.5 手动接管）：点过「接管桌面」却没挂上才算失败，从没接管过记通过。
        var desktopWanted = _settings.WallpaperSnapshot.DesktopAttached;
        var surfaceCount = _runtime?.SurfaceCount ?? 0;
        var desktopAttached = surfaceCount > 0 || (_desktop is not null && _desktop.IsAttached);
        checks.Add(("桌面层", !desktopWanted || desktopAttached,
            desktopAttached
                ? (surfaceCount > 0 ? $"已挂 {surfaceCount} 块屏（WebView2）" : "已挂到 WorkerW")
                : desktopWanted
                    ? (_desktopError ?? "未接管")
                    : "未接管（未开启）"));

        checks.Add(("SQLite", true, WallpaperFolders.Database));
        checks.Add(("封面目录", Directory.Exists(WallpaperFolders.Covers), WallpaperFolders.Covers));
        return checks;
    }

    /// <summary>
    /// 素材元数据改了（裁剪 / 画面变换 / 速度 / 标题），把当前画布用的那份换成新记录并重推指令。
    ///
    /// PUT /library/items/{id} 只写库，内存里的 <see cref="WallpaperAsset"/> 还是旧的；
    /// 不刷新的话页面拿到的仍是改之前的 payload，改了半天看不到反应。
    /// </summary>
    public void NotifyAssetChanged(long assetId)
    {
        if (!_ui.CheckAccess())
        {
            _ui.BeginInvoke(new Action(() => NotifyAssetChanged(assetId)));
            return;
        }

        var affectsInApp = _inAppAsset?.Id == assetId;
        var affectsDesktop = _desktopAsset?.Id == assetId;
        if (!affectsDesktop && _runtime is not null)
        {
            // 多屏：桌面画布是按屏存的，_desktopAsset 不一定是当前铺的那张，
            // 得看每块屏的 target。漏了这一步就会出现「改完必须再应用一次才生效」。
            affectsDesktop = BuildDesktopTargets().Any(target => target.AssetId == assetId);
        }

        if (!affectsInApp && !affectsDesktop) return;

        if (_store.FindById(assetId) is { } fresh)
        {
            if (affectsInApp) _inAppAsset = fresh;
            if (affectsDesktop) _desktopAsset = fresh;
        }

        if (affectsDesktop) RefreshDesktopTargets();
        RaiseStateChanged();
    }

    /// <summary>
    /// 软件内壁纸层的渲染负载（交给页面里的 &lt;video&gt; / &lt;img&gt; 播）。
    ///
    /// 为什么画面交给页面而不是 WPF：WPF 每帧 WritePixels 上传 1080p 位图 + 全窗合成
    /// 在本机实测要吃掉近一个核（30fps 就 97% CPU），而同一段视频交给 Chromium 播是 4%。
    /// 桌面层（WorkerW）没有 WebView 可用，仍走 WPF 渲染。
    /// </summary>
    public WallpaperLayerPayload? BuildLayerPayload()
    {
        if (!_ui.CheckAccess()) return _ui.Invoke(() => BuildLayerPayload());

        var asset = _inAppAsset;
        if (asset is null) return null;

        var canvas = _store.GetCanvas(CanvasKind.InApp, null);
        return BuildPayload(asset, _inAppPaused, _settings.WallpaperSnapshot.Enabled, CanvasSettings.Read(canvas.FilterJson, asset.Transform));
    }

    /// <summary>桌面层（Progman 下的第二个 WebView2）用的载荷：资产与暂停状态都是桌面画布的。</summary>
    public WallpaperLayerPayload? BuildDesktopLayerPayload()
    {
        if (!_ui.CheckAccess()) return _ui.Invoke(() => BuildDesktopLayerPayload());

        if (_runtime is null)
        {
            return null;
        }

        var asset = _desktopAsset;
        if (asset is null)
        {
            return null;
        }

        return BuildPayload(asset, _desktopPaused, _settings.WallpaperSnapshot.Enabled);
    }

    private WallpaperLayerPayload BuildPayload(
        WallpaperAsset asset,
        bool paused,
        bool enabled,
        CanvasOverrides? overrides = null,
        int fps = 0)
    {
        var options = _settings.WallpaperSnapshot;
        var visible = enabled && !paused;
        // 画面参数按画布取：这块屏/这个画布自己调过就用它的，没调过就用素材的。
        var picture = overrides ?? CanvasOverrides.FromTransform(asset.Transform);
        return new WallpaperLayerPayload(
            visible,
            asset.Id,
            asset.Kind == AssetKind.Video ? "video" : asset.Kind == AssetKind.Gif ? "gif" : "image",
            asset.Path,
            $"/api/wallpaper/v2/media/{asset.Id}",
            asset.CoverPath,
            paused,
            ResolveTransition(options),
            WallpaperTransitions.Key(ResolveTransition(options)),
            options.TransitionMs,
            options.DimMode == WallpaperSettings.DimOff ? 0 : options.DimBase,
            options.Blur,
            options.Brightness,
            options.Contrast,
            options.Saturation,
            options.AudioEnabled,
            options.AudioVolume,
            options.FitMode,
            options.BeatStrength,
            options.OverlayEnabled,
            options.OverlayTemplate,
            options.VisualizerEnabled,
            options.VisualizerStyle,
            asset.TrimInMs ?? 0,
            asset.TrimOutMs ?? 0,
            asset.Speed,
            picture.MirrorH,
            picture.MirrorV,
            picture.Rotation,
            picture.CropLeft,
            picture.CropTop,
            picture.CropRight,
            picture.CropBottom,
            picture.Zoom,
            picture.Blur,
            fps);
    }

    private string BuildDiagnosticsJson()
    {
        var snapshot = Snapshot();
        var (count, totalBytes, favorites) = _store.Stats();
        var options = _settings.WallpaperSnapshot;
        var payload = new System.Text.Json.Nodes.JsonObject
        {
            ["inApp"] = new System.Text.Json.Nodes.JsonObject
            {
                ["assetId"] = snapshot.InApp.AssetId,
                ["title"] = snapshot.InApp.Title,
                ["running"] = snapshot.InApp.Running,
                ["paused"] = snapshot.InApp.Paused,
                ["error"] = snapshot.InApp.LastError,
            },
            ["desktop"] = new System.Text.Json.Nodes.JsonObject
            {
                ["attached"] = (_desktop is not null && _desktop.IsAttached) || (_runtime is not null && _runtime.SurfaceCount > 0),
                ["assetId"] = snapshot.Desktop.AssetId,
                ["title"] = snapshot.Desktop.Title,
                ["error"] = snapshot.Desktop.LastError,
            },
            ["library"] = new System.Text.Json.Nodes.JsonObject
            {
                ["count"] = count,
                ["bytes"] = totalBytes,
                ["favorites"] = favorites,
            },
            ["ffmpeg"] = new System.Text.Json.Nodes.JsonObject
            {
                ["available"] = snapshot.FfmpegAvailable,
                ["path"] = snapshot.FfmpegPath,
            },
            ["options"] = new System.Text.Json.Nodes.JsonObject
            {
                ["frameRateLimit"] = options.FrameRateLimit,
                ["renderScale"] = options.RenderScale,
                ["hardwareDecode"] = options.HardwareDecode,
                ["transitionId"] = options.TransitionId,
                ["transitionMs"] = options.TransitionMs,
                ["audioEnabled"] = options.AudioEnabled,
            },
            ["render"] = new System.Text.Json.Nodes.JsonObject
            {
                // RenderCapability.Tier 高 16 位：0=软件渲染，1=部分硬件，2=全部硬件。
                ["tier"] = System.Windows.Media.RenderCapability.Tier >> 16,
                ["decodeWidth"] = _decodeSize.Width,
                ["decodeHeight"] = _decodeSize.Height,
                ["decodeFps"] = _decodeSize.Fps,
            },
            ["exportedAt"] = DateTime.Now.ToString("O"),
        };

        return payload.ToJsonString(new System.Text.Json.JsonSerializerOptions { WriteIndented = true });
    }

    private string BuildLibraryListing()
    {
        var builder = new System.Text.StringBuilder();
        var (items, _) = _store.List(new AssetQuery { Limit = 5000 });
        builder.AppendLine($"count={items.Count}");
        foreach (var asset in items)
        {
            builder.AppendLine($"{asset.Id}	{asset.Kind}	{asset.Source}	{asset.Width}x{asset.Height}	{asset.Path}");
        }

        return builder.ToString();
    }

    private static string TailLog(int maxLines)
    {
        try
        {
            var path = HostLog.LogPath;
            if (string.IsNullOrEmpty(path) || !File.Exists(path)) return "(no log)";
            var lines = File.ReadAllLines(path);
            return string.Join(Environment.NewLine, lines.Skip(Math.Max(0, lines.Length - maxLines)));
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return $"(log unreadable: {exception.Message})";
        }
    }

    private static void WriteEntry(ZipArchive archive, string name, string content)
    {
        var entry = archive.CreateEntry(name, CompressionLevel.Optimal);
        using var stream = entry.Open();
        using var writer = new StreamWriter(stream, System.Text.Encoding.UTF8);
        writer.Write(content);
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;

        _settings.WallpaperChanged -= OnSettingsChanged;
        _scanCancellation?.Cancel();
        _rotationTimer.Stop();

        _player.FrameReady -= OnFrameReady;
        _player.Ended -= OnPlayerEnded;
        _player.Dispose();

        _desktopPlayer.FrameReady -= OnDesktopFrameReady;
        _desktopPlayer.Ended -= OnDesktopPlayerEnded;
        _desktopPlayer.Dispose();
        _desktop?.Dispose();
        _runtime?.Dispose();
        _runtime = null;

        _inApp.Dispose();
        _db.Dispose();
    }
}

/// <summary>软件内壁纸层的一份完整渲染指令（页面据此驱动 &lt;video&gt; / &lt;img&gt;）。</summary>
internal sealed record WallpaperLayerPayload(
    bool Visible,
    long AssetId,
    string Kind,
    string SourcePath,
    string MediaUrl,
    string? CoverPath,
    bool Paused,
    Render.WallpaperTransitionId Transition,
    string TransitionKey,
    int TransitionMs,
    double Dim,
    double Blur,
    double Brightness,
    double Contrast,
    double Saturation,
    bool AudioEnabled,
    int AudioVolume,
    string FitMode,
    int BeatStrength,
    bool OverlayEnabled,
    string OverlayTemplate,
    bool VisualizerEnabled,
    string VisualizerStyle,
    long TrimInMs,
    long TrimOutMs,
    double Speed,
    bool MirrorH,
    bool MirrorV,
    int Rotation,
    double CropLeft,
    double CropTop,
    double CropRight,
    double CropBottom,
    double PictureZoom,
    double PictureBlur,
    int Fps);
