using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Effects;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace Zilux2.Wallpaper.Render;

/// <summary>
/// 软件内背景层（第 3 轮 / 第 24 轮 / 第 11–12 轮转场）：铺在主窗口内容最底层的一块画面。
/// 解码线程只往 pending 缓冲里拷贝，UI 线程按 8ms 节拍把它刷进 WriteableBitmap，两边不共享 WPF 对象。
/// 双层结构：<see cref="_active"/> 指向正在写入的那层，另一层在转场期间冻结旧画面，
/// 转场按 <see cref="WallpaperTransitionId"/> 的预设对两层做属性插值（全部走 GPU 合成，不碰像素）。
/// </summary>
internal sealed class WallpaperCanvasSurface : IDisposable
{
    private readonly Grid _root;
    private readonly Image[] _layers = new Image[2];
    private readonly WriteableBitmap?[] _bitmaps = new WriteableBitmap?[2];
    private readonly TranslateTransform[] _translate = new TranslateTransform[2];
    private readonly ScaleTransform[] _scale = new ScaleTransform[2];
    private readonly BlurEffect[] _blur = new BlurEffect[2];
    private readonly Border _flash;
    private readonly Border _dim;
    private readonly DispatcherTimer _timer;
    private readonly object _gate = new();

    private int _active;
    private byte[] _pending = [];
    private int _pendingWidth;
    private int _pendingHeight;
    private int _hasPending;
    private bool _disposed;

    private WallpaperTransitionId? _transition;
    private long _transitionStart;
    private int _transitionMs;

    public WallpaperCanvasSurface()
    {
        for (var index = 0; index < 2; index++)
        {
            _translate[index] = new TranslateTransform();
            _scale[index] = new ScaleTransform(1, 1);
            _blur[index] = new BlurEffect { Radius = 0, KernelType = KernelType.Gaussian, RenderingBias = RenderingBias.Performance };

            var transform = new TransformGroup();
            transform.Children.Add(_scale[index]);
            transform.Children.Add(_translate[index]);

            _layers[index] = new Image
            {
                Stretch = Stretch.UniformToFill,
                SnapsToDevicePixels = false,
                IsHitTestVisible = false,
                Visibility = Visibility.Collapsed,
                RenderTransformOrigin = new Point(0.5, 0.5),
                RenderTransform = transform,
                Opacity = 0,
            };
        }

        // 闪层：黑场 / 白闪 / 曝光的公共覆盖层，转场时只改颜色与不透明度。
        _flash = new Border
        {
            Background = new SolidColorBrush(Colors.Black),
            Opacity = 0,
            IsHitTestVisible = false,
            Visibility = Visibility.Collapsed,
        };

        // 暗化遮罩：第 53 轮默认 20%，层间可调。用纯色层而不是改像素，省一次全屏遍历。
        _dim = new Border
        {
            Background = new SolidColorBrush(Colors.Black),
            Opacity = 0.2,
            IsHitTestVisible = false,
            Visibility = Visibility.Collapsed,
        };

        _root = new Grid { IsHitTestVisible = false, Visibility = Visibility.Collapsed };
        _root.Children.Add(_layers[0]);
        _root.Children.Add(_layers[1]);
        _root.Children.Add(_flash);
        _root.Children.Add(_dim);

        // 8ms 检查一次是否有新帧并推进转场；实际帧率由解码线程控制，这里只是搬运与插值。
        _timer = new DispatcherTimer(DispatcherPriority.Render)
        {
            Interval = TimeSpan.FromMilliseconds(8),
        };
        _timer.Tick += (_, _) =>
        {
            AdvanceTransition();
            FlushPendingFrame();
        };
    }

    /// <summary>可挂到任意 Panel 最底层的根元素。</summary>
    public FrameworkElement Root => _root;

    /// <summary>当前是否有画面。</summary>
    public bool HasFrame => _layers[0].Source is not null || _layers[1].Source is not null;

    /// <summary>暗化强度 0–1（第 53 轮自适应范围 0–0.4）。</summary>
    public double DimOpacity
    {
        get => _dim.Opacity;
        set => _dim.Opacity = Math.Clamp(value, 0, 1);
    }

    /// <summary>整层显隐。</summary>
    public void SetVisible(bool visible)
    {
        _root.Visibility = visible ? Visibility.Visible : Visibility.Collapsed;
        _flash.Visibility = visible ? Visibility.Visible : Visibility.Collapsed;
        _dim.Visibility = visible ? Visibility.Visible : Visibility.Collapsed;
        foreach (var layer in _layers)
        {
            layer.Visibility = visible ? Visibility.Visible : Visibility.Collapsed;
        }


        if (visible) _timer.Start(); else _timer.Stop();
    }

    /// <summary>
    /// 开始一次转场（规格书 §5.3）：冻结当前画面到另一层，新画面写进刚切换的层。
    /// 还没有任何画面时退化为硬切；<paramref name="durationMs"/> 为 0 时也走硬切。
    /// </summary>
    public void BeginTransition(WallpaperTransitionId id, int durationMs)
    {
        if (_disposed) return;

        // 上一段转场没结束就当它已经完成，避免两层都留着旧状态。
        FinishTransition();

        if (durationMs <= 0 || !HasFrame)
        {
            return;
        }

        var previous = 1 - _active;
        _active = previous ^ 1;

        var incoming = _layers[_active];
        incoming.Source = null;
        incoming.Opacity = 0;
        _bitmaps[_active] = null;
        ResetTransforms(_active);

        _transition = id;
        _transitionMs = Math.Clamp(durationMs, 60, 5000);
        _transitionStart = Stopwatch.GetTimestamp();
        _flash.Opacity = 0;
    }

    /// <summary>解码线程调用：把最新一帧放进 pending 槽（后到覆盖先到）。</summary>
    public void Submit(ReadOnlyMemory<byte> frame, int width, int height)
    {
        if (_disposed || width <= 0 || height <= 0) return;

        lock (_gate)
        {
            var needed = width * height * 4;
            if (_pending.Length != needed)
            {
                _pending = new byte[needed];
                // 尺寸变了要重建位图，交给 UI 线程处理。
                _pendingWidth = width;
                _pendingHeight = height;
                _bitmaps[_active] = null;
                Interlocked.Exchange(ref _hasPending, 1);
                return;
            }

            frame.Span[..needed].CopyTo(_pending);
            _pendingWidth = width;
            _pendingHeight = height;
            Interlocked.Exchange(ref _hasPending, 1);
        }
    }

    private void FlushPendingFrame()
    {
        if (_disposed) return;
        if (Interlocked.Exchange(ref _hasPending, 0) == 0) return;

        int width;
        int height;
        byte[] buffer;
        lock (_gate)
        {
            width = _pendingWidth;
            height = _pendingHeight;
            buffer = _pending;
        }

        if (width <= 0 || height <= 0) return;

        var bitmap = _bitmaps[_active];
        if (bitmap is null || bitmap.PixelWidth != width || bitmap.PixelHeight != height)
        {
            bitmap = new WriteableBitmap(width, height, 96, 96, PixelFormats.Bgra32, null);
            _bitmaps[_active] = bitmap;
            _layers[_active].Source = bitmap;
        }

        bitmap.Lock();
        try
        {
            bitmap.WritePixels(new Int32Rect(0, 0, width, height), buffer, width * 4, 0);
        }
        finally
        {
            bitmap.Unlock();
        }
    }

    private void AdvanceTransition()
    {
        if (_transition is not { } id) return;

        var elapsedMs = (Stopwatch.GetTimestamp() - _transitionStart) * 1000.0 / Stopwatch.Frequency;
        var t = Math.Clamp(elapsedMs / _transitionMs, 0, 1);
        Apply(id, t);

        if (t >= 1)
        {
            FinishTransition();
        }
    }

    /// <summary>按预设把进度 t（0–1）映射成两层属性；全部是纯函数，方便以后加新预设。</summary>
    private void Apply(WallpaperTransitionId id, double t)
    {
        var incoming = _layers[_active];
        var outgoing = _layers[1 - _active];

        incoming.Opacity = 0;
        outgoing.Opacity = 1;
        _flash.Opacity = 0;
        ResetTransforms(_active);
        ResetTransforms(1 - _active);

        var width = _root.ActualWidth > 1 ? _root.ActualWidth : 1920;
        var height = _root.ActualHeight > 1 ? _root.ActualHeight : 1080;

        switch (id)
        {
            case WallpaperTransitionId.Fade:
                incoming.Opacity = t;
                break;

            case WallpaperTransitionId.FadeBlack:
                incoming.Opacity = t < 0.5 ? 0 : 1;
                Flash(Colors.Black, t < 0.5 ? t * 2 : (1 - t) * 2);
                break;

            case WallpaperTransitionId.FadeWhite:
                incoming.Opacity = t < 0.5 ? 0 : 1;
                Flash(Colors.White, t < 0.5 ? t * 2 : (1 - t) * 2);
                break;

            case WallpaperTransitionId.SlideLeft:
                incoming.Opacity = 1;
                _translate[_active].X = width * (1 - t);
                _translate[1 - _active].X = -width * t;
                break;

            case WallpaperTransitionId.SlideRight:
                incoming.Opacity = 1;
                _translate[_active].X = -width * (1 - t);
                _translate[1 - _active].X = width * t;
                break;

            case WallpaperTransitionId.SlideUp:
                incoming.Opacity = 1;
                _translate[_active].Y = height * (1 - t);
                _translate[1 - _active].Y = -height * t;
                break;

            case WallpaperTransitionId.ZoomIn:
                incoming.Opacity = Math.Min(1, t * 1.6);
                _scale[_active].ScaleX = _scale[_active].ScaleY = 1.16 - 0.16 * t;
                break;

            case WallpaperTransitionId.BlurDissolve:
                incoming.Opacity = t;
                _blur[_active].Radius = 22 * (1 - t);
                _blur[1 - _active].Radius = 22 * t;
                ApplyBlur();
                break;

            case WallpaperTransitionId.RadialBlur:
                incoming.Opacity = t;
                _scale[_active].ScaleX = _scale[_active].ScaleY = 1 + 0.28 * (1 - t);
                _blur[_active].Radius = 26 * (1 - t);
                ApplyBlur();
                break;

            case WallpaperTransitionId.Exposure:
                incoming.Opacity = t;
                Flash(Colors.White, 0.55 * (1 - t) * (1 - t));
                break;

            case WallpaperTransitionId.Glitch:
                incoming.Opacity = t < 0.2 ? 0 : 1;
                _translate[_active].X = Math.Sin(t * 70) * 18 * (1 - t);
                _translate[1 - _active].X = -_translate[_active].X * 0.6;
                Flash(Colors.White, 0.25 * Math.Abs(Math.Sin(t * 40)));
                break;

            case WallpaperTransitionId.FilmGrain:
                incoming.Opacity = t;
                Flash(Colors.White, 0.16 * Math.Sin(Math.PI * t));
                _translate[_active].X = Math.Sin(t * 260) * 1.5;
                break;

            case WallpaperTransitionId.DissolveNoise:
            {
                // 近似实现：把不透明度量化成 6 档硬切，模拟斑点状溶解。
                const double steps = 6;
                incoming.Opacity = Math.Round(t * steps) / steps;
                break;
            }

            default:
            {
                // Ripple：正弦缩放 + 模糊波动。
                incoming.Opacity = t;
                var wave = 0.05 * Math.Sin(t * Math.PI * 4) * (1 - t);
                _scale[_active].ScaleX = _scale[_active].ScaleY = 1 + Math.Abs(wave);
                _blur[_active].Radius = 40 * Math.Abs(wave);
                ApplyBlur();
                break;
            }
        }
    }

    private void Flash(Color color, double opacity)
    {
        _flash.Background = new SolidColorBrush(color);
        _flash.Opacity = Math.Clamp(opacity, 0, 1);
    }

    private void ResetTransforms(int index)
    {
        _translate[index].X = 0;
        _translate[index].Y = 0;
        _scale[index].ScaleX = 1;
        _scale[index].ScaleY = 1;
        _blur[index].Radius = 0;
        _layers[index].Effect = null;
    }

    private void ApplyBlur()
    {
        for (var index = 0; index < 2; index++)
        {
            _layers[index].Effect = _blur[index].Radius > 0.05 ? _blur[index] : null;
        }
    }

    private void FinishTransition()
    {
        _transition = null;
        _flash.Opacity = 0;

        var stale = 1 - _active;
        _layers[stale].Source = null;
        _layers[stale].Opacity = 0;
        _bitmaps[stale] = null;
        ResetTransforms(stale);

        if (_active >= 0 && _active < _layers.Length)
        {
            _layers[_active].Opacity = 1;
            ResetTransforms(_active);
        }
    }

    /// <summary>显示一张静态图片（图片素材或抽帧封面）。</summary>
    public void ShowImage(string path)
    {
        try
        {
            var bitmap = new BitmapImage();
            bitmap.BeginInit();
            bitmap.CacheOption = BitmapCacheOption.OnLoad;
            bitmap.CreateOptions = BitmapCreateOptions.IgnoreColorProfile;
            bitmap.UriSource = new Uri(path, UriKind.Absolute);
            bitmap.EndInit();
            bitmap.Freeze();

            // 静态图接管画面：把硬件视频层收起来，否则它会一直盖在上面。
    
            _layers[_active].Source = bitmap;
            _layers[_active].Opacity = 1;
            _bitmaps[_active] = null;
            _timer.Stop();
        }
        catch (Exception exception) when (exception is IOException or NotSupportedException or UriFormatException)
        {
            // 图片坏了就当没画面，交给上层降级（第 13 轮）。
        }
    }

    /// <summary>清空画面（切到视频或停用壁纸时）。</summary>
    public void Clear()
    {
        lock (_gate)
        {
            _pending = [];
            _pendingWidth = 0;
            _pendingHeight = 0;
            Interlocked.Exchange(ref _hasPending, 0);
        }


        for (var index = 0; index < 2; index++)
        {
            _layers[index].Source = null;
            _layers[index].Opacity = 0;
            _bitmaps[index] = null;
            ResetTransforms(index);
        }

        _transition = null;
        _flash.Opacity = 0;
        _dim.Visibility = Visibility.Collapsed;
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _timer.Stop();
        Clear();
        if (_root.Parent is Panel parent) parent.Children.Remove(_root);
    }
}
