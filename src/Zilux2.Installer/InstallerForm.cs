using System.Diagnostics;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Globalization;

namespace Zilux2.Installer;

/// <summary>
/// Zilux2 安装程序：无边框自绘窗口，暖纸质配色 + 金色主按钮，和主程序视觉保持一致。
/// 画面里所有元素（标题字、卡片、开关、进度、按钮）都由这里绘制，动画统一走一个 60fps 计时器：
/// 窗口淡入上浮、阶段切换淡入、进度条缓动、成功勾选描边、按钮悬停抬起。
/// </summary>
internal sealed class InstallerForm : Form
{
    private enum Stage
    {
        Setup,
        Installing,
        Done,
        Failed,
    }

    private enum Hit
    {
        None = 0,
        Title = 1,
        Minimize = 2,
        Close = 3,
        Browse = 4,
        Install = 5,
        Cancel = 6,
        ToggleLaunch = 7,
        ToggleShortcut = 8,
    }

    // ---- 配色：跟主程序浅色主题一致（bg #f3f1ea / ink #1b1d23 / accent #a9803f） ----
    private static readonly Color BgTop = Color.FromArgb(0xF8, 0xF4, 0xEB);
    private static readonly Color BgBottom = Color.FromArgb(0xEC, 0xE6, 0xD8);
    private static readonly Color Ink = Color.FromArgb(0x1B, 0x1D, 0x23);
    private static readonly Color InkSoft = Color.FromArgb(0x44, 0x49, 0x53);
    private static readonly Color Muted = Color.FromArgb(0x86, 0x7E, 0x6E);
    private static readonly Color Accent = Color.FromArgb(0xA9, 0x80, 0x3F);
    private static readonly Color AccentLight = Color.FromArgb(0xC9, 0xA2, 0x65);
    private static readonly Color AccentSoft = Color.FromArgb(0xF0, 0xE4, 0xCD);
    private static readonly Color Card = Color.FromArgb(0xFF, 0xFD, 0xF8);
    private static readonly Color CardBorder = Color.FromArgb(0xE3, 0xDA, 0xC8);
    private static readonly Color FieldBg = Color.FromArgb(0xFA, 0xF6, 0xED);
    private static readonly Color FieldBorder = Color.FromArgb(0xDE, 0xD3, 0xBF);
    private static readonly Color Line = Color.FromArgb(0xE1, 0xD8, 0xC5);
    private static readonly Color Danger = Color.FromArgb(0xB2, 0x50, 0x3B);
    private static readonly Color DangerSoft = Color.FromArgb(0xF4, 0xE2, 0xDC);

    // ---- 动画状态 ----
    private readonly System.Windows.Forms.Timer _anim = new() { Interval = 15 };
    private readonly Stopwatch _clock = Stopwatch.StartNew();
    private long _lastTick;
    private float _scale = 1f;
    private Stage _stage = Stage.Setup;
    private float _intro;
    private float _contentAlpha = 1f;
    private float _contentShift;
    private float _displayPercent;
    private float _targetPercent;
    private float _shimmer;
    private float _checkProgress;
    private string _statusMessage = "准备就绪";
    private string _errorText = "";
    private bool _installing;
    private bool _launchAfter = true;
    private bool _shortcuts = true;
    private bool _launched;
    private readonly float[] _toggleAnim = { 1f, 1f };
    private readonly Dictionary<Hit, float> _hover = new();
    private Hit _hovered = Hit.None;
    private Hit _pressed = Hit.None;
    private bool _dragging;
    private Point _dragStartScreen;
    private Point _dragStartLocation;
    private Point _baseLocation;
    private bool _locationReady;

    // ---- 自绘区域 ----
    private RectangleF _titleRect;
    private RectangleF _minRect;
    private RectangleF _closeRect;
    private RectangleF _wordmarkRect;
    private RectangleF _subtitleRect;
    private RectangleF _versionRect;
    private RectangleF _cardRect;
    private RectangleF _labelRect;
    private RectangleF _inputRect;
    private RectangleF _browseRect;
    private RectangleF _optLabelRect;
    private RectangleF _toggle1Rect;
    private RectangleF _toggle2Rect;
    private RectangleF _hintRect;
    private RectangleF _statusRect;
    private RectangleF _progressRect;
    private RectangleF _installRect;
    private RectangleF _cancelRect;
    private float _dividerY;

    private readonly TextBox _pathBox;
    private bool _uiReady;

    // ---- 字体（按 DPI 缩放成整数像素，避免 8.5pt / 10.5pt 落在半像素上发虚） ----
    private Font _fWord = new("Segoe UI Semibold", 30f);
    private Font _fSubtitle = new("Microsoft YaHei UI", 9f);
    private Font _fPill = new("Segoe UI", 9f);
    private Font _fLabel = new("Microsoft YaHei UI", 10f);
    private Font _fInput = new("Microsoft YaHei UI", 10.5f);
    private Font _fButton = new("Microsoft YaHei UI", 10.5f, FontStyle.Bold);
    private Font _fPercent = new("Segoe UI Semibold", 34f);
    private Font _fPercentUnit = new("Segoe UI", 15f);
    private Font _fCardTitle = new("Microsoft YaHei UI", 16.5f, FontStyle.Bold);
    private Font _fBody = new("Microsoft YaHei UI", 9.5f);
    private Font _fSmall = new("Microsoft YaHei UI", 8.5f);
    private bool _fontsReady;
    private bool _introFinished;

    public InstallerForm()
    {
        AutoScaleDimensions = new SizeF(96f, 96f);
        AutoScaleMode = AutoScaleMode.Dpi;
        Text = "Zilux2 安装程序";
        StartPosition = FormStartPosition.Manual;
        FormBorderStyle = FormBorderStyle.None;
        MaximizeBox = false;
        MinimizeBox = true;
        ShowInTaskbar = true;
        BackColor = BgTop;
        DoubleBuffered = true;
        KeyPreview = true;
        // ClientSize 放到控件创建之后再设：设置尺寸会触发 OnResize → LayoutUi，此时 _pathBox 还没建好。
        _uiReady = false;
        Font = new Font("Microsoft YaHei UI", 9f);
        try
        {
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        }
        catch
        {
            // 没有图标也能用
        }
        _pathBox = new TextBox
        {
            BorderStyle = BorderStyle.None,
            BackColor = FieldBg,
            ForeColor = Ink,
            Font = _fInput,
            Text = InstallerCore.DefaultInstallDir,
            ShortcutsEnabled = true,
        };
        _pathBox.TextChanged += (_, _) =>
        {
            if (_errorText.Length > 0)
            {
                _errorText = "";
            }
            Invalidate();
        };
        _pathBox.Enter += (_, _) => Invalidate();
        _pathBox.Leave += (_, _) => Invalidate();
        _pathBox.KeyDown += (_, e) =>
        {
            if (e.KeyCode == Keys.Enter)
            {
                e.SuppressKeyPress = true;
                StartInstall();
            }
        };
        Controls.Add(_pathBox);

        _lastTick = _clock.ElapsedMilliseconds;
        _anim.Tick += OnAnimTick;
        ClientSize = new Size(760, 564);
        _uiReady = true;
    }

    private float S(float value) => value * _scale;

    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            cp.ClassStyle |= 0x00020000; // CS_DROPSHADOW
            return cp;
        }
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        _scale = DeviceDpi / 96f;
        BuildFonts();
        // AutoScaleMode.Dpi 可能已经把尺寸缩过；这里按同一个比例再设一次，保证与自绘坐标一致。
        ClientSize = new Size((int)Math.Round(760 * _scale), (int)Math.Round(564 * _scale));
        UpdateWindowRegion();
        LayoutUi();
        if (!_locationReady)
        {
            _locationReady = true;
            var area = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1280, 800);
            _baseLocation = new Point(area.X + (area.Width - Width) / 2, area.Y + (area.Height - Height) / 2);
            Location = new Point(_baseLocation.X, _baseLocation.Y + (int)S(16));
        }
        Opacity = 0.01;
        _anim.Start();
        _lastTick = _clock.ElapsedMilliseconds;
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        // 启动时不要选中路径文字（否则输入框里是一条蓝色选区）；点进去再编辑。
        ActiveControl = null;
        _pathBox.SelectionStart = _pathBox.TextLength;
        _pathBox.SelectionLength = 0;
        Invalidate();
    }

    /// <summary>按当前 DPI 重建字体：用像素单位 + 四舍五入，文字落整像素，边缘更干净。</summary>
    private void BuildFonts()
    {
        if (_fontsReady) DisposeFonts();
        float k = _scale;
        float Px(float size) => Math.Max(8f, MathF.Round(size * k));
        _fWord = new Font("Segoe UI Semibold", Px(41f), FontStyle.Regular, GraphicsUnit.Pixel);
        _fSubtitle = new Font("Microsoft YaHei UI", Px(13f), FontStyle.Regular, GraphicsUnit.Pixel);
        _fPill = new Font("Segoe UI", Px(12f), FontStyle.Regular, GraphicsUnit.Pixel);
        _fLabel = new Font("Microsoft YaHei UI", Px(14f), FontStyle.Regular, GraphicsUnit.Pixel);
        _fInput = new Font("Microsoft YaHei UI", Px(14f), FontStyle.Regular, GraphicsUnit.Pixel);
        _fButton = new Font("Microsoft YaHei UI", Px(14f), FontStyle.Bold, GraphicsUnit.Pixel);
        _fPercent = new Font("Segoe UI Semibold", Px(47f), FontStyle.Regular, GraphicsUnit.Pixel);
        _fPercentUnit = new Font("Segoe UI", Px(20f), FontStyle.Regular, GraphicsUnit.Pixel);
        _fCardTitle = new Font("Microsoft YaHei UI", Px(23f), FontStyle.Bold, GraphicsUnit.Pixel);
        _fBody = new Font("Microsoft YaHei UI", Px(13f), FontStyle.Regular, GraphicsUnit.Pixel);
        _fSmall = new Font("Microsoft YaHei UI", Px(11.5f), FontStyle.Regular, GraphicsUnit.Pixel);
        _pathBox.Font = _fInput;
        _fontsReady = true;
    }

    private void DisposeFonts()
    {
        _fWord.Dispose();
        _fSubtitle.Dispose();
        _fPill.Dispose();
        _fLabel.Dispose();
        _fInput.Dispose();
        _fButton.Dispose();
        _fPercent.Dispose();
        _fPercentUnit.Dispose();
        _fCardTitle.Dispose();
        _fBody.Dispose();
        _fSmall.Dispose();
        _fontsReady = false;
    }

    /// <summary>
    /// 淡入结束：去掉 WS_EX_LAYERED。分层窗口会禁用 ClearType，去掉之后正文用 ClearType 绘制，
    /// 字体明显更锐利；圆角仍由 Region 保证。
    /// </summary>
    private void FinishIntro()
    {
        Opacity = 1.0;
        try
        {
            nint exStyle = GetWindowLongPtr(Handle, GwlExStyle);
            long style = exStyle.ToInt64();
            if ((style & WsExLayered) != 0)
            {
                SetWindowLongPtr(Handle, GwlExStyle, new nint(style & ~WsExLayered));
                SetWindowPos(Handle, nint.Zero, 0, 0, 0, 0,
                    SwpNoSize | SwpNoMove | SwpNoZOrder | SwpFrameChanged | SwpNoActivate);
            }
        }
        catch
        {
            // 老系统上失败不影响使用，只是仍用灰度抗锯齿
        }
        Invalidate();
    }

    private const int GwlExStyle = -20;
    private const long WsExLayered = 0x00080000L;
    private const uint SwpNoSize = 0x0001;
    private const uint SwpNoMove = 0x0002;
    private const uint SwpNoZOrder = 0x0004;
    private const uint SwpNoActivate = 0x0010;
    private const uint SwpFrameChanged = 0x0020;

    [System.Runtime.InteropServices.DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    private static extern nint GetWindowLongPtr(nint hWnd, int nIndex);

    [System.Runtime.InteropServices.DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
    private static extern nint SetWindowLongPtr(nint hWnd, int nIndex, nint dwNewLong);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool SetWindowPos(nint hWnd, nint hWndInsertAfter, int x, int y, int cx, int cy, uint flags);

    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        UpdateWindowRegion();
        LayoutUi();
        Invalidate();
    }

    private void UpdateWindowRegion()
    {
        if (ClientSize.Width <= 0 || ClientSize.Height <= 0) return;
        using var path = RoundRect(new RectangleF(0, 0, ClientSize.Width, ClientSize.Height), S(16));
        Region = new Region(path);
    }

    private void LayoutUi()
    {
        if (!_uiReady || _pathBox is null || ClientSize.Width <= 0) return;
        float w = ClientSize.Width;
        float pad = S(38);

        _titleRect = new RectangleF(0, 0, w, S(46));
        _closeRect = new RectangleF(w - S(50), S(9), S(30), S(28));
        _minRect = new RectangleF(w - S(86), S(9), S(30), S(28));

        _wordmarkRect = new RectangleF(pad, S(58), S(420), S(52));
        _subtitleRect = new RectangleF(pad + S(3), S(112), S(440), S(18));
        _versionRect = new RectangleF(w - pad - S(94), S(70), S(94), S(30));
        _dividerY = S(154);

        _cardRect = new RectangleF(pad, S(170), w - pad * 2, S(250));
        float cx = _cardRect.X;
        float cy = _cardRect.Y;
        float cw = _cardRect.Width;
        _labelRect = new RectangleF(cx + S(26), cy + S(20), cw - S(52), S(18));
        _inputRect = new RectangleF(cx + S(26), cy + S(44), cw - S(52) - S(96), S(44));
        _browseRect = new RectangleF(_inputRect.Right + S(12), cy + S(44), S(84), S(44));
        _optLabelRect = new RectangleF(cx + S(26), cy + S(104), cw - S(52), S(18));
        _toggle1Rect = new RectangleF(cx + S(26), cy + S(126), cw - S(52), S(34));
        _toggle2Rect = new RectangleF(cx + S(26), cy + S(162), cw - S(52), S(34));
        _hintRect = new RectangleF(cx + S(26), cy + S(202), cw - S(52), S(40));

        _statusRect = new RectangleF(pad, S(434), w - pad * 2 - S(208), S(18));
        _progressRect = new RectangleF(pad, S(458), w - pad * 2, S(6));
        _installRect = new RectangleF(w - pad - S(158), S(482), S(158), S(50));
        _cancelRect = new RectangleF(_installRect.X - S(116), S(482), S(104), S(50));

        _pathBox.Bounds = new Rectangle(
            (int)(_inputRect.X + S(15)),
            (int)(_inputRect.Y + (_inputRect.Height - _pathBox.PreferredHeight) / 2f + S(1)),
            Math.Max(20, (int)(_inputRect.Width - S(30))),
            _pathBox.PreferredHeight);
    }

    /* ------------------------------------------------------------------ */
    /* 动画                                                                */
    /* ------------------------------------------------------------------ */

    private void OnAnimTick(object? sender, EventArgs e)
    {
        long now = _clock.ElapsedMilliseconds;
        float dt = Math.Min(0.05f, Math.Max(0.001f, (now - _lastTick) / 1000f));
        _lastTick = now;
        bool dirty = false;

        if (_intro < 1f)
        {
            _intro = Math.Min(1f, _intro + dt / 0.34f);
            float ease = EaseOut(_intro);
            Opacity = 0.01 + 0.99 * ease;
            if (_locationReady)
            {
                Location = new Point(_baseLocation.X, _baseLocation.Y + (int)((1 - ease) * S(16)));
            }
            dirty = true;
        }
        else if (!_introFinished)
        {
            _introFinished = true;
            FinishIntro();
        }

        if (_contentAlpha < 1f)
        {
            _contentAlpha = Math.Min(1f, _contentAlpha + dt / 0.28f);
            _contentShift = (1 - EaseOut(_contentAlpha)) * S(10);
            dirty = true;
        }

        if (Math.Abs(_displayPercent - _targetPercent) > 0.03f)
        {
            float k = 1f - MathF.Pow(0.0015f, dt);
            _displayPercent += (_targetPercent - _displayPercent) * k;
            dirty = true;
        }
        else if (_displayPercent != _targetPercent)
        {
            _displayPercent = _targetPercent;
            dirty = true;
        }

        if (_stage == Stage.Installing)
        {
            _shimmer = (_shimmer + dt * 0.38f) % 1f;
            dirty = true;
        }

        if (_stage == Stage.Done && _checkProgress < 1f)
        {
            _checkProgress = Math.Min(1f, _checkProgress + dt / 0.9f);
            dirty = true;
        }

        for (int i = 0; i < _toggleAnim.Length; i++)
        {
            float target = (i == 0 ? _launchAfter : _shortcuts) ? 1f : 0f;
            if (Math.Abs(_toggleAnim[i] - target) > 0.002f)
            {
                _toggleAnim[i] += (target - _toggleAnim[i]) * (1f - MathF.Pow(0.0005f, dt));
                dirty = true;
            }
            else if (_toggleAnim[i] != target)
            {
                _toggleAnim[i] = target;
                dirty = true;
            }
        }

        foreach (Hit hit in Enum.GetValues<Hit>())
        {
            if (hit == Hit.None) continue;
            float target = _hovered == hit ? 1f : 0f;
            float current = _hover.GetValueOrDefault(hit);
            if (Math.Abs(current - target) > 0.004f)
            {
                _hover[hit] = current + (target - current) * (1f - MathF.Pow(0.0001f, dt));
                dirty = true;
            }
            else if (current != target)
            {
                _hover[hit] = target;
                dirty = true;
            }
        }

        if (dirty) Invalidate();
    }

    private static float EaseOut(float t) => 1f - MathF.Pow(1f - Math.Clamp(t, 0f, 1f), 3f);

    private static float EaseInOut(float t)
    {
        t = Math.Clamp(t, 0f, 1f);
        return t < 0.5f ? 4f * t * t * t : 1f - MathF.Pow(-2f * t + 2f, 3f) / 2f;
    }

    /* ------------------------------------------------------------------ */
    /* 绘制                                                                */
    /* ------------------------------------------------------------------ */

    protected override void OnPaint(PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
        g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
        g.Clear(BgTop);

        DrawBackground(g);
        DrawWindowChrome(g);
        DrawHeader(g);
        DrawCard(g);
        DrawStage(g);
        DrawFooter(g);
    }

    private void DrawBackground(Graphics g)
    {
        using (var bg = new LinearGradientBrush(
                   new RectangleF(0, 0, Math.Max(1, ClientSize.Width), Math.Max(1, ClientSize.Height)),
                   BgTop, BgBottom, 90f))
        {
            g.FillRectangle(bg, ClientRectangle);
        }

        // 右上角的暖光，给平面背景一点纵深（多层低透明度圆叠出来）
        float glowX = ClientSize.Width - S(150);
        float glowY = -S(40);
        for (int i = 5; i >= 0; i--)
        {
            float radius = S(60) + i * S(34);
            using var brush = new SolidBrush(Color.FromArgb(5 + i, Accent));
            g.FillEllipse(brush, glowX - radius, glowY - radius, radius * 2, radius * 2);
        }

        // 左下角一层很浅的金色弧
        for (int i = 4; i >= 0; i--)
        {
            float radius = S(120) + i * S(48);
            using var brush = new SolidBrush(Color.FromArgb(3 + i, AccentLight));
            g.FillEllipse(brush, -radius * 0.4f, ClientSize.Height - radius * 0.55f, radius * 2, radius * 2);
        }
    }

    private void DrawWindowChrome(Graphics g)
    {
        float minHover = _hover.GetValueOrDefault(Hit.Minimize);
        float closeHover = _hover.GetValueOrDefault(Hit.Close);

        for (int i = 0; i < 2; i++)
        {
            RectangleF r = i == 0 ? _minRect : _closeRect;
            float hover = i == 0 ? minHover : closeHover;
            if (hover > 0.01f)
            {
                using var brush = new SolidBrush(Color.FromArgb((int)(18 * hover), i == 0 ? Ink : Danger));
                using var path = RoundRect(r, S(8));
                g.FillPath(brush, path);
            }
            using var pen = new Pen(Color.FromArgb((int)(200 + 55 * hover), InkSoft), Math.Max(1f, S(1.2f)))
            {
                StartCap = LineCap.Round,
                EndCap = LineCap.Round,
            };
            if (i == 0)
            {
                float y = r.Y + r.Height / 2f;
                g.DrawLine(pen, r.X + r.Width * 0.32f, y, r.Right - r.Width * 0.32f, y);
            }
            else
            {
                float inset = r.Width * 0.33f;
                g.DrawLine(pen, r.X + inset, r.Y + inset, r.Right - inset, r.Bottom - inset);
                g.DrawLine(pen, r.Right - inset, r.Y + inset, r.X + inset, r.Bottom - inset);
            }
        }
    }

    private void DrawHeader(Graphics g)
    {
        // 字标：逐字绘制模拟 letter-spacing，和主程序启动画面的 ZILUX2 一致
        DrawSpacedText(g, "ZILUX2", _fWord, Ink, new PointF(_wordmarkRect.X, _wordmarkRect.Y - S(2)), S(4.5f));
        DrawSpacedText(g, "新一代创意播放器 · 让每首歌都有画面", _fSubtitle, Muted, new PointF(_subtitleRect.X, _subtitleRect.Y), S(1.5f));

        using (var path = RoundRect(_versionRect, _versionRect.Height / 2f))
        using (var fill = new SolidBrush(Color.FromArgb(150, 255, 253, 248)))
        using (var stroke = new Pen(Line, Math.Max(1f, S(1f))))
        {
            g.FillPath(fill, path);
            g.DrawPath(stroke, path);
        }
        TextIn(g, "v" + InstallerCore.Version, _fPill, InkSoft, _versionRect);

        using var pen = new Pen(Line, Math.Max(1f, S(1f)));
        g.DrawLine(pen, _cardRect.X, _dividerY, _cardRect.Right, _dividerY);
    }

    private void DrawCard(Graphics g)
    {
        using var shadow1 = RoundRect(Offset(_cardRect, 0, S(6)), S(20));
        using (var brush = new SolidBrush(Color.FromArgb(14, 0x6B, 0x5A, 0x3A)))
        {
            g.FillPath(brush, shadow1);
        }
        using var shadow2 = RoundRect(Offset(_cardRect, 0, S(2)), S(20));
        using (var brush = new SolidBrush(Color.FromArgb(10, 0x6B, 0x5A, 0x3A)))
        {
            g.FillPath(brush, shadow2);
        }
        using var cardPath = RoundRect(_cardRect, S(20));
        using (var fill = new SolidBrush(Card))
        {
            g.FillPath(fill, cardPath);
        }
        using (var stroke = new Pen(CardBorder, Math.Max(1f, S(1f))))
        {
            g.DrawPath(stroke, cardPath);
        }
    }

    private void DrawStage(Graphics g)
    {
        switch (_stage)
        {
            case Stage.Setup:
                DrawSetup(g);
                break;
            case Stage.Installing:
                DrawInstalling(g);
                break;
            case Stage.Done:
                DrawDone(g);
                break;
            case Stage.Failed:
                DrawFailed(g);
                break;
        }
    }

    private Color Fade(Color color, float? alpha = null)
    {
        float a = color.A * _contentAlpha * (alpha ?? 1f);
        return Color.FromArgb((int)Math.Clamp(a, 0, 255), color.R, color.G, color.B);
    }

    private RectangleF Shift(RectangleF rect) => new(rect.X, rect.Y + _contentShift, rect.Width, rect.Height);

    private void DrawSetup(Graphics g)
    {
        TextIn(g, "安装位置", _fLabel, Fade(InkSoft), Shift(_labelRect), StringAlignment.Near);

        // 输入框
        bool focus = _pathBox.Focused;
        using (var path = RoundRect(Shift(_inputRect), S(12)))
        using (var fill = new SolidBrush(Fade(FieldBg)))
        using (var stroke = new Pen(Fade(focus ? Accent : FieldBorder), Math.Max(1f, S(focus ? 1.6f : 1f))))
        {
            g.FillPath(fill, path);
            g.DrawPath(stroke, path);
        }

        DrawGhostButton(g, Shift(_browseRect), "浏览…", Hit.Browse, _contentAlpha);

        TextIn(g, "安装选项", _fLabel, Fade(InkSoft), Shift(_optLabelRect), StringAlignment.Near);

        DrawToggleRow(g, Shift(_toggle1Rect), _toggleAnim[0], "安装完成后立即启动 Zilux2", Hit.ToggleLaunch);
        DrawToggleRow(g, Shift(_toggle2Rect), _toggleAnim[1], "创建桌面与开始菜单快捷方式", Hit.ToggleShortcut);

        if (_errorText.Length > 0)
        {
            TextWrapped(g, _errorText, _fSmall, Fade(Danger), Shift(_hintRect));
        }
        else
        {
            TextWrapped(g, "安装到当前用户目录，无需管理员权限。覆盖安装会保留设置与曲库。", _fSmall, Fade(Muted), Shift(_hintRect));
        }
    }

    private void DrawInstalling(Graphics g)
    {
        float centerX = _cardRect.X + _cardRect.Width / 2f;
        TextIn(g, "正在安装 Zilux2", _fLabel, Fade(Muted),
            new RectangleF(_cardRect.X, _cardRect.Y + S(46) + _contentShift, _cardRect.Width, S(20)));

        string number = Math.Round(_displayPercent, MidpointRounding.AwayFromZero).ToString("0", CultureInfo.InvariantCulture);
        using (var brush = new SolidBrush(Fade(Ink)))
        using (var unitBrush = new SolidBrush(Fade(Muted)))
        using (var fmt = new StringFormat(StringFormat.GenericTypographic)
        {
            Alignment = StringAlignment.Near,
            LineAlignment = StringAlignment.Near,
        })
        {
            var numberSize = g.MeasureString(number, _fPercent, PointF.Empty, fmt);
            var unitSize = g.MeasureString("%", _fPercentUnit, PointF.Empty, fmt);
            float gap = S(3);
            float total = numberSize.Width + gap + unitSize.Width;
            float startX = centerX - total / 2f;
            float top = _cardRect.Y + S(70) + _contentShift;
            g.DrawString(number, _fPercent, brush, new PointF(startX, top), fmt);
            // 百分号底对齐数字基线，和数字拉开，避免叠在一起
            float unitTop = top + numberSize.Height - unitSize.Height - S(3);
            g.DrawString("%", _fPercentUnit, unitBrush, new PointF(startX + numberSize.Width + gap, unitTop), fmt);
        }

        string message = _statusMessage;
        if (message.Length > 64)
        {
            message = "…" + message[^60..];
        }
        TextIn(g, message, _fSmall, Fade(Muted),
            new RectangleF(_cardRect.X + S(30), _cardRect.Y + S(146) + _contentShift, _cardRect.Width - S(60), S(18)),
            StringAlignment.Center, ellipsis: true);

        TextIn(g, "请保持窗口打开，安装完成后会自动继续。", _fSmall, Fade(Muted, 0.8f),
            new RectangleF(_cardRect.X + S(30), _cardRect.Y + S(176) + _contentShift, _cardRect.Width - S(60), S(18)),
            StringAlignment.Center);
    }

    private void DrawDone(Graphics g)
    {
        float cx = _cardRect.X + _cardRect.Width / 2f;
        float cy = _cardRect.Y + S(78) + _contentShift;
        float r = S(31);

        // 外圈光晕
        for (int i = 4; i >= 0; i--)
        {
            float radius = r + i * S(7);
            using var glow = new SolidBrush(Color.FromArgb((int)(7 + i * 3 * _contentAlpha * _intro), Accent));
            g.FillEllipse(glow, cx - radius, cy - radius, radius * 2, radius * 2);
        }

        using (var baseRing = new Pen(Fade(AccentSoft), Math.Max(1f, S(4.2f))))
        {
            g.DrawEllipse(baseRing, cx - r, cy - r, r * 2, r * 2);
        }

        float sweep = Math.Clamp(_checkProgress / 0.62f, 0f, 1f);
        if (sweep > 0)
        {
            using var ring = new Pen(Fade(Accent), Math.Max(1f, S(4.2f)))
            {
                StartCap = LineCap.Round,
                EndCap = LineCap.Round,
            };
            g.DrawArc(ring, cx - r, cy - r, r * 2, r * 2, -90f, 360f * EaseInOut(sweep));
        }

        float check = Math.Clamp((_checkProgress - 0.5f) / 0.5f, 0f, 1f);
        if (check > 0)
        {
            using var pen = new Pen(Fade(Accent), Math.Max(1f, S(4.2f)))
            {
                StartCap = LineCap.Round,
                EndCap = LineCap.Round,
                LineJoin = LineJoin.Round,
            };
            var p1 = new PointF(cx - r * 0.42f, cy + r * 0.02f);
            var p2 = new PointF(cx - r * 0.10f, cy + r * 0.34f);
            var p3 = new PointF(cx + r * 0.46f, cy - r * 0.30f);
            DrawCheckProgress(g, pen, p1, p2, p3, check);
        }

        TextIn(g, "安装完成", _fCardTitle, Fade(Ink),
            new RectangleF(_cardRect.X, _cardRect.Y + S(122) + _contentShift, _cardRect.Width, S(28)), StringAlignment.Center);

        string target = _pathBox.Text.Trim();
        string line = "已安装到 " + target;
        TextIn(g, line, _fSmall, Fade(Muted),
            new RectangleF(_cardRect.X + S(40), _cardRect.Y + S(156) + _contentShift, _cardRect.Width - S(80), S(18)),
            StringAlignment.Center, ellipsis: true);

        string extra = _shortcuts ? "桌面与开始菜单快捷方式已创建" : "未创建快捷方式";
        if (_launched) extra += " · 已启动 Zilux2";
        TextIn(g, extra, _fSmall, Fade(Muted, 0.82f),
            new RectangleF(_cardRect.X + S(40), _cardRect.Y + S(184) + _contentShift, _cardRect.Width - S(80), S(18)),
            StringAlignment.Center);
    }

    private void DrawFailed(Graphics g)
    {
        float cx = _cardRect.X + _cardRect.Width / 2f;
        float cy = _cardRect.Y + S(72) + _contentShift;
        float r = S(29);

        using (var fill = new SolidBrush(Fade(DangerSoft, 0.75f)))
        {
            g.FillEllipse(fill, cx - r, cy - r, r * 2, r * 2);
        }
        using (var ring = new Pen(Fade(Danger, 0.55f), Math.Max(1f, S(3.4f))))
        {
            g.DrawEllipse(ring, cx - r * 0.62f, cy - r * 0.62f, r * 1.24f, r * 1.24f);
        }
        using (var pen = new Pen(Fade(Danger), Math.Max(1f, S(3.2f))) { StartCap = LineCap.Round, EndCap = LineCap.Round })
        {
            g.DrawLine(pen, cx, cy - r * 0.36f, cx, cy + r * 0.14f);
            g.FillEllipse(new SolidBrush(Fade(Danger)), cx - S(1.8f), cy + r * 0.30f, S(3.6f), S(3.6f));
        }

        TextIn(g, "安装失败", _fCardTitle, Fade(Ink),
            new RectangleF(_cardRect.X, _cardRect.Y + S(116) + _contentShift, _cardRect.Width, S(28)), StringAlignment.Center);

        string message = _errorText.Length > 0 ? _errorText : "发生了未知错误。";
        TextWrapped(g, message, _fSmall, Fade(Danger),
            new RectangleF(_cardRect.X + S(50), _cardRect.Y + S(152) + _contentShift, _cardRect.Width - S(100), S(44)));

        TextIn(g, "检查磁盘空间、关闭占用文件的程序后可以重试。", _fSmall, Fade(Muted, 0.85f),
            new RectangleF(_cardRect.X + S(30), _cardRect.Y + S(204) + _contentShift, _cardRect.Width - S(60), S(18)),
            StringAlignment.Center);
    }

    private void DrawFooter(Graphics g)
    {
        bool primaryEnabled = _stage != Stage.Installing;
        bool showProgress = _stage != Stage.Setup;
        float progressAlpha = _stage == Stage.Setup ? 0f : 1f;

        // 状态行（安装中由卡片里的步骤文案承担，这里不重复）
        if (_stage != Stage.Installing)
        {
            string status = _stage switch
            {
                Stage.Setup => "准备就绪 · 点击安装开始",
                Stage.Done => "安装完成 · 可以关闭安装程序",
                Stage.Failed => "安装未完成",
                _ => "",
            };
            var statusColor = _stage == Stage.Failed ? Danger : Color.FromArgb(0x6B, 0x63, 0x54);
            TextIn(g, status, _fSmall, Fade(statusColor, 0.96f), _statusRect);
        }

        if (showProgress)
        {
            float percent = (float)Math.Clamp(_displayPercent, 0, 100);
            using (var track = RoundRect(_progressRect, _progressRect.Height / 2f))
            using (var trackBrush = new SolidBrush(Color.FromArgb((int)(70 * progressAlpha), 0x8B, 0x7A, 0x5B)))
            {
                g.FillPath(trackBrush, track);
            }

            float fillWidth = _progressRect.Width * percent / 100f;
            if (fillWidth > 1f)
            {
                var fillRect = new RectangleF(_progressRect.X, _progressRect.Y, fillWidth, _progressRect.Height);
                using var fillPath = RoundRect(fillRect, _progressRect.Height / 2f);
                using (var gradient = new LinearGradientBrush(
                           new RectangleF(_progressRect.X, _progressRect.Y - 1, Math.Max(2f, _progressRect.Width), _progressRect.Height + 2),
                           Accent, AccentLight, 0f))
                {
                    g.FillPath(gradient, fillPath);
                }

                if (_stage == Stage.Installing)
                {
                    // 高光从左到右扫过已完成的进度
                    float bandWidth = S(80);
                    float bandX = _progressRect.X - bandWidth + (_progressRect.Width + bandWidth * 2) * _shimmer;
                    var band = new RectangleF(bandX, _progressRect.Y, bandWidth, _progressRect.Height);
                    using Region clip = g.Clip;
                    g.SetClip(fillPath, CombineMode.Intersect);
                    using (var bandBrush = new LinearGradientBrush(
                               new RectangleF(band.X, band.Y, Math.Max(2f, band.Width), band.Height),
                               Color.FromArgb(0, 255, 255, 255), Color.FromArgb(150, 255, 255, 255), 0f))
                    {
                        var blend = new ColorBlend(3)
                        {
                            Colors = new[] { Color.FromArgb(0, 255, 255, 255), Color.FromArgb(120, 255, 255, 255), Color.FromArgb(0, 255, 255, 255) },
                            Positions = new[] { 0f, 0.5f, 1f },
                        };
                        bandBrush.InterpolationColors = blend;
                        g.FillRectangle(bandBrush, band);
                    }
                    g.Clip = clip;
                }
            }
        }

        if (_stage == Stage.Done)
        {
            DrawGhostButton(g, _cancelRect, "打开 Zilux2", Hit.Cancel, 1f, enabled: true);
            DrawPrimaryButton(g, _installRect, "完成", Hit.Install, enabled: true);
        }
        else if (_stage == Stage.Failed)
        {
            DrawGhostButton(g, _cancelRect, "退出", Hit.Cancel, 1f);
            DrawPrimaryButton(g, _installRect, "重试", Hit.Install, enabled: true);
        }
        else
        {
            DrawGhostButton(g, _cancelRect, "取消", Hit.Cancel, 1f, enabled: !_installing);
            DrawPrimaryButton(g, _installRect, _stage == Stage.Installing ? "正在安装…" : "安装", Hit.Install,
                enabled: primaryEnabled);
        }
    }

    /* ------------------------------------------------------------------ */
    /* 绘制小工具                                                          */
    /* ------------------------------------------------------------------ */

    private static GraphicsPath RoundRect(RectangleF rect, float radius)
    {
        var path = new GraphicsPath();
        float d = Math.Min(radius * 2, Math.Min(rect.Width, rect.Height));
        if (d <= 1f)
        {
            path.AddRectangle(rect);
            return path;
        }
        path.AddArc(rect.X, rect.Y, d, d, 180, 90);
        path.AddArc(rect.Right - d, rect.Y, d, d, 270, 90);
        path.AddArc(rect.Right - d, rect.Bottom - d, d, d, 0, 90);
        path.AddArc(rect.X, rect.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    private static RectangleF Offset(RectangleF rect, float dx, float dy) =>
        new(rect.X + dx, rect.Y + dy, rect.Width, rect.Height);

    private void DrawPrimaryButton(Graphics g, RectangleF rect, string text, Hit hit, bool enabled)
    {
        float hover = _hover.GetValueOrDefault(hit);
        float lift = enabled ? hover * S(1.2f) : 0f;
        var bounds = new RectangleF(rect.X, rect.Y - lift, rect.Width, rect.Height);

        using var path = RoundRect(bounds, S(14));
        if (!enabled)
        {
            using var disabled = new SolidBrush(Color.FromArgb(0xEE, 0xE8, 0xDC));
            g.FillPath(disabled, path);
            TextIn(g, text, _fButton, Color.FromArgb(0xA9, 0x9E, 0x8B), bounds);
            return;
        }

        // 轻阴影：只往下探一点，不要形成一圈深色描边
        using (var shadowPath = RoundRect(new RectangleF(bounds.X + S(2), bounds.Y + S(2.5f), bounds.Width - S(4), bounds.Height), S(14)))
        using (var shadow = new SolidBrush(Color.FromArgb((int)(20 + 10 * hover), 0x6A, 0x52, 0x2C)))
        {
            g.FillPath(shadow, shadowPath);
        }

        // 主体：上浅下深，顶部不再叠一块对不上圆角的高光
        using (var gradient = new LinearGradientBrush(
                   new RectangleF(bounds.X, bounds.Y, Math.Max(2f, bounds.Width), Math.Max(2f, bounds.Height)),
                   Color.FromArgb(0xD3, 0xAD, 0x73), Color.FromArgb(0xAE, 0x85, 0x49), 90f))
        {
            g.FillPath(gradient, path);
        }

        // 内侧 1px 高光沿着同一条圆角路径，收口干净
        using (var innerPath = RoundRect(
                   new RectangleF(bounds.X + S(1), bounds.Y + S(1), bounds.Width - S(2), bounds.Height - S(2)),
                   S(13)))
        using (var rim = new Pen(Color.FromArgb((int)(42 + 28 * hover), 255, 255, 255), Math.Max(1f, S(1f))))
        {
            g.DrawPath(rim, innerPath);
        }

        TextIn(g, text, _fButton, Color.FromArgb(0xFF, 0xFB, 0xF1), bounds);
    }

    private void DrawGhostButton(Graphics g, RectangleF rect, string text, Hit hit, float alpha, bool enabled = true)
    {
        float hover = _hover.GetValueOrDefault(hit);
        var bounds = new RectangleF(rect.X, rect.Y - hover * S(1f), rect.Width, rect.Height);
        using var path = RoundRect(bounds, S(14));
        using (var fill = new SolidBrush(Color.FromArgb((int)((18 + 40 * hover) * alpha), 0x8B, 0x7A, 0x5B)))
        {
            g.FillPath(fill, path);
        }
        using (var stroke = new Pen(Color.FromArgb((int)((190 + 40 * hover) * alpha), 0xD4, 0xC9, 0xB4), Math.Max(1f, S(1f))))
        {
            g.DrawPath(stroke, path);
        }
        var textColor = enabled
            ? Color.FromArgb((int)(255 * alpha), InkSoft.R, InkSoft.G, InkSoft.B)
            : Color.FromArgb((int)(150 * alpha), Muted.R, Muted.G, Muted.B);
        TextIn(g, text, _fButton, textColor, bounds);
    }

    private void DrawToggleRow(Graphics g, RectangleF row, float anim, string label, Hit hit)
    {
        float hover = _hover.GetValueOrDefault(hit);
        if (hover > 0.01f)
        {
            using var path = RoundRect(row, S(10));
            using var fill = new SolidBrush(Color.FromArgb((int)(10 * hover * _contentAlpha), 0x8B, 0x7A, 0x5B));
            g.FillPath(fill, path);
        }

        var track = new RectangleF(row.X + S(2), row.Y + (row.Height - S(24)) / 2f, S(44), S(24));
        Color trackColor = Blend(Color.FromArgb(0xD9, 0xCF, 0xBC), Accent, anim);
        using (var trackPath = RoundRect(track, track.Height / 2f))
        using (var trackBrush = new SolidBrush(Fade(trackColor)))
        {
            g.FillPath(trackBrush, trackPath);
        }

        float knobSize = S(20);
        float travel = track.Width - knobSize - S(4);
        float knobX = track.X + S(2) + travel * anim;
        float knobY = track.Y + (track.Height - knobSize) / 2f;
        using (var knobBrush = new SolidBrush(Fade(Color.White)))
        {
            g.FillEllipse(knobBrush, knobX, knobY, knobSize, knobSize);
        }
        using (var knobShadow = new Pen(Fade(Color.FromArgb(28, 0, 0, 0)), Math.Max(1f, S(1f))))
        {
            g.DrawEllipse(knobShadow, knobX, knobY, knobSize, knobSize);
        }

        var labelRect = new RectangleF(track.Right + S(12), row.Y, row.Width - track.Width - S(14), row.Height);
        TextIn(g, label, _fBody, Fade(InkSoft), labelRect, StringAlignment.Near);
    }

    private static Color Blend(Color from, Color to, float t)
    {
        t = Math.Clamp(t, 0f, 1f);
        return Color.FromArgb(
            (int)(from.A + (to.A - from.A) * t),
            (int)(from.R + (to.R - from.R) * t),
            (int)(from.G + (to.G - from.G) * t),
            (int)(from.B + (to.B - from.B) * t));
    }

    private void TextIn(Graphics g, string text, Font font, Color color, RectangleF rect,
        StringAlignment align = StringAlignment.Center, bool ellipsis = false)
    {
        using var sf = new StringFormat(StringFormat.GenericTypographic)
        {
            Alignment = align,
            LineAlignment = StringAlignment.Center,
            Trimming = ellipsis ? StringTrimming.EllipsisCharacter : StringTrimming.None,
            FormatFlags = StringFormatFlags.NoWrap,
        };
        using var brush = new SolidBrush(color);
        g.DrawString(text, font, brush, rect, sf);
    }

    private void TextWrapped(Graphics g, string text, Font font, Color color, RectangleF rect)
    {
        using var sf = new StringFormat(StringFormat.GenericTypographic)
        {
            Alignment = StringAlignment.Near,
            LineAlignment = StringAlignment.Near,
            Trimming = StringTrimming.EllipsisWord,
        };
        using var brush = new SolidBrush(color);
        g.DrawString(text, font, brush, rect, sf);
    }

    private void DrawSpacedText(Graphics g, string text, Font font, Color color, PointF origin, float spacing)
    {
        using var brush = new SolidBrush(color);
        using var sf = StringFormat.GenericTypographic;
        float x = origin.X;
        foreach (char ch in text)
        {
            string s = ch.ToString();
            g.DrawString(s, font, brush, new PointF(x, origin.Y), sf);
            x += g.MeasureString(s, font, PointF.Empty, sf).Width + spacing;
        }
    }

    private static void DrawCheckProgress(Graphics g, Pen pen, PointF p1, PointF p2, PointF p3, float progress)
    {
        float l1 = Distance(p1, p2);
        float l2 = Distance(p2, p3);
        float total = l1 + l2;
        float drawn = total * progress;
        if (drawn <= 0) return;
        if (drawn <= l1)
        {
            g.DrawLine(pen, p1, Lerp(p1, p2, drawn / l1));
            return;
        }
        g.DrawLine(pen, p1, p2);
        g.DrawLine(pen, p2, Lerp(p2, p3, (drawn - l1) / l2));
    }

    private static float Distance(PointF a, PointF b) => MathF.Sqrt((a.X - b.X) * (a.X - b.X) + (a.Y - b.Y) * (a.Y - b.Y));

    private static PointF Lerp(PointF a, PointF b, float t) => new(a.X + (b.X - a.X) * t, a.Y + (b.Y - a.Y) * t);

    /* ------------------------------------------------------------------ */
    /* 交互                                                                */
    /* ------------------------------------------------------------------ */

    private Hit HitTest(Point p)
    {
        var point = new PointF(p.X, p.Y);
        if (_closeRect.Contains(point)) return Hit.Close;
        if (_minRect.Contains(point)) return Hit.Minimize;

        if (_stage == Stage.Setup)
        {
            if (_browseRect.Contains(point)) return Hit.Browse;
            if (_toggle1Rect.Contains(point)) return Hit.ToggleLaunch;
            if (_toggle2Rect.Contains(point)) return Hit.ToggleShortcut;
        }
        if (_installRect.Contains(point)) return Hit.Install;
        if (_cancelRect.Contains(point)) return Hit.Cancel;
        if (_stage != Stage.Installing && _titleRect.Contains(point)) return Hit.Title;
        return Hit.None;
    }

    private static bool IsClickable(Hit hit) => hit is not (Hit.None or Hit.Title);

    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        if (_dragging)
        {
            Point screen = PointToScreen(e.Location);
            Location = new Point(
                _dragStartLocation.X + (screen.X - _dragStartScreen.X),
                _dragStartLocation.Y + (screen.Y - _dragStartScreen.Y));
            _baseLocation = Location;
            return;
        }
        Hit hit = HitTest(e.Location);
        if (hit != _hovered)
        {
            _hovered = hit;
            Cursor = IsClickable(hit) ? Cursors.Hand : Cursors.Default;
        }
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        if (e.Button != MouseButtons.Left) return;
        Hit hit = HitTest(e.Location);
        _pressed = hit;
        if (hit == Hit.Title)
        {
            _dragging = true;
            _dragStartScreen = PointToScreen(e.Location);
            _dragStartLocation = Location;
        }
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        base.OnMouseUp(e);
        if (e.Button != MouseButtons.Left) return;
        if (_dragging)
        {
            _dragging = false;
            _pressed = Hit.None;
            return;
        }
        Hit hit = HitTest(e.Location);
        if (hit == _pressed)
        {
            Activate(hit);
        }
        _pressed = Hit.None;
    }

    protected override void OnMouseLeave(EventArgs e)
    {
        base.OnMouseLeave(e);
        _hovered = Hit.None;
        Cursor = Cursors.Default;
    }

    private void Activate(Hit hit)
    {
        switch (hit)
        {
            case Hit.Minimize:
                WindowState = FormWindowState.Minimized;
                break;
            case Hit.Close:
                RequestClose();
                break;
            case Hit.Browse:
                BrowseFolder();
                break;
            case Hit.ToggleLaunch:
                if (!_installing) _launchAfter = !_launchAfter;
                break;
            case Hit.ToggleShortcut:
                if (!_installing) _shortcuts = !_shortcuts;
                break;
            case Hit.Install:
                if (_stage == Stage.Setup) StartInstall();
                else if (_stage == Stage.Failed) RetryInstall();
                else if (_stage == Stage.Done) RequestClose();
                break;
            case Hit.Cancel:
                if (_stage == Stage.Done)
                {
                    LaunchApp();
                }
                else if (_stage != Stage.Installing)
                {
                    RequestClose();
                }
                break;
        }
        Invalidate();
    }

    protected override void OnKeyDown(KeyEventArgs e)
    {
        base.OnKeyDown(e);
        if (e.KeyCode == Keys.Escape && !_installing && _stage != Stage.Installing)
        {
            RequestClose();
        }
        else if (e.KeyCode == Keys.Enter && _stage != Stage.Installing)
        {
            if (_stage == Stage.Setup) StartInstall();
            else if (_stage == Stage.Failed) RetryInstall();
            else if (_stage == Stage.Done) RequestClose();
        }
    }

    private void BrowseFolder()
    {
        using var dialog = new FolderBrowserDialog
        {
            SelectedPath = _pathBox.Text,
            Description = "选择 Zilux2 的安装位置",
            UseDescriptionForTitle = true,
            ShowNewFolderButton = true,
        };
        if (dialog.ShowDialog(this) == DialogResult.OK)
        {
            _pathBox.Text = dialog.SelectedPath;
            _errorText = "";
        }
    }

    private void RequestClose()
    {
        if (_installing) return;
        Close();
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (_installing && e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            return;
        }
        _anim.Stop();
        base.OnFormClosing(e);
    }

    /* ------------------------------------------------------------------ */
    /* 安装流程                                                            */
    /* ------------------------------------------------------------------ */

    private void StartInstall()
    {
        if (_installing) return;
        if (_stage == Stage.Installing) return;
        string dir = _pathBox.Text.Trim();
        if (string.IsNullOrWhiteSpace(dir))
        {
            _errorText = "请填写安装位置";
            Invalidate();
            return;
        }
        try
        {
            dir = Path.GetFullPath(dir);
        }
        catch
        {
            _errorText = "安装位置不是有效路径";
            Invalidate();
            return;
        }

        _errorText = "";
        _pathBox.Text = dir;
        _pathBox.Visible = false;
        _statusMessage = "正在准备安装…";
        _targetPercent = 0;
        _displayPercent = 0;
        _checkProgress = 0;
        _installing = true;
        BeginStage(Stage.Installing);
        _ = RunInstallAsync(dir);
    }

    private void RetryInstall()
    {
        _pathBox.Visible = true;
        _errorText = "";
        BeginStage(Stage.Setup);
    }

    private void BeginStage(Stage stage)
    {
        _stage = stage;
        _contentAlpha = 0f;
        _contentShift = S(10);
        _pathBox.Visible = stage == Stage.Setup;
        Invalidate();
    }

    private async Task RunInstallAsync(string dir)
    {
        var progress = new Progress<(int Percent, string Message)>(p =>
        {
            _targetPercent = Math.Clamp(p.Percent, 0, 100);
            _statusMessage = p.Message;
            Invalidate();
        });

        try
        {
            await Task.Run(() =>
            {
                InstallerCore.KillRunning();
                InstallerCore.Install(dir, progress, _shortcuts, register: true);
            });

            _targetPercent = 100;
            _displayPercent = 100;
            _statusMessage = "安装完成";
            _launched = _launchAfter && InstallerCore.Launch(dir);
            _checkProgress = 0;
            _installing = false;
            BeginStage(Stage.Done);
        }
        catch (Exception error)
        {
            _installing = false;
            _errorText = error.Message;
            _statusMessage = "安装失败";
            BeginStage(Stage.Failed);
        }
    }

    private void LaunchApp()
    {
        string dir = _pathBox.Text.Trim();
        if (string.IsNullOrWhiteSpace(dir)) return;
        InstallerCore.Launch(dir);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _anim.Stop();
            _anim.Dispose();
            _pathBox.Dispose();
            DisposeFonts();
        }
        base.Dispose(disposing);
    }
}












