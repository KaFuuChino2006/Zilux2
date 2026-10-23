# -*- coding: utf-8 -*-
"""窗口外观：6px 边条 + 边条颜色跟随页面（chromeColor）+ 页面内窗口按钮。
1) MainWindow.xaml：Background #F2F4FA、ResizeBorderThickness 6、Margin 6、Grid 命名 RootGrid
2) MainWindow.xaml.cs：ResizeGrip 6、SetChromeColor
3) WebViewHost.cs：HandleWindowCommand(root) 支持 chromeColor
"""
import io

def patch(path, pairs):
    s = io.open(path, "r", encoding="utf-8-sig", newline="").read()
    for old, new in pairs:
        assert s.count(old) == 1, (path, "missing:", old[:80], "count:", s.count(old))
        s = s.replace(old, new, 1)
    io.open(path, "w", encoding="utf-8", newline="").write(s)
    print("patched", path)

xaml = r"E:\Zilux2开发\src\Zilux2\MainWindow.xaml"
patch(xaml, [
    ('        Background="#F6F7FB"', '        Background="#F2F4FA"'),
    ('    <Grid Background="#F6F7FB">', '    <Grid x:Name="RootGrid" Background="#F2F4FA">'),
    ('                            ResizeBorderThickness="8"', '                            ResizeBorderThickness="6"'),
    ('        <wv2:WebView2 x:Name="Browser" Margin="8" />', '        <wv2:WebView2 x:Name="Browser" Margin="6" />'),
])

cs = r"E:\Zilux2开发\src\Zilux2\MainWindow.xaml.cs"
patch(cs, [
    ("    // Mirrors WindowChrome.ResizeBorderThickness (see MainWindow.xaml for the reason).\n    private const double ResizeGrip = 8;",
     "    // Mirrors WindowChrome.ResizeBorderThickness (see MainWindow.xaml for the reason).\n    private const double ResizeGrip = 6;"),
    ("    public void ToggleMaximize()\n    {",
     """    // 页面把当前主背景色报上来，宿主用它给 6px 的窗口边条上色，
    // 这样边条和页面背景融合，不会再出现与页面不一致的黑框/白框。
    public void SetChromeColor(string? hex)
    {
        if (string.IsNullOrWhiteSpace(hex)) return;
        try
        {
            var color = (Color)ColorConverter.ConvertFromString(hex)!;
            var brush = new SolidColorBrush(color);
            brush.Freeze();
            Background = brush;
            RootGrid.Background = brush;
            HostLog.Info($"window.chromeColor {hex}");
        }
        catch (Exception exception)
        {
            HostLog.Warn($"window.chromeColor ignored: {hex} ({exception.GetType().Name})");
        }
    }

    public void ToggleMaximize()
    {"""),
])

wh = r"E:\Zilux2开发\src\Zilux2\WebViewHost.cs"
patch(wh, [
    ("                    HandleWindowCommand(ReadString(root, \"action\"));",
     "                    HandleWindowCommand(root);"),
    ("""    private void HandleWindowCommand(string? action)
    {
        switch (action)
        {""",
     """    private void HandleWindowCommand(JsonElement root)
    {
        var action = ReadString(root, "action");
        switch (action)
        {
            case "chromeColor":
                _window.SetChromeColor(ReadString(root, "color"));
                break;
"""),
])
