using System.Text.Json;
using System.Text.Json.Nodes;
using Zilux2.Settings;

namespace Zilux2.Wallpaper;

/// <summary>
/// 把页面推来的 options 补丁（<c>PUT /api/wallpaper/v2/options</c>）写进
/// <see cref="WallpaperSettings"/>。每个字段都按规格书 §6 的取值域裁剪，
/// 越界值直接忽略而不是写进去——设置文件是用户手改过的，脏数据不能传播。
/// </summary>
internal static class WallpaperOptionsPatch
{
    public static void Apply(WallpaperSettings options, JsonObject body)
    {
        Bool(body, "enabled", value => options.Enabled = value);
        Bool(body, "inAppEnabled", value => options.InAppEnabled = value);
        Bool(body, "desktopEnabled", value => options.DesktopEnabled = value);
        Bool(body, "audioEnabled", value => options.AudioEnabled = value);
        Int(body, "audioVolume", 0, 100, value => options.AudioVolume = value);
        Bool(body, "audioFollowSystem", value => options.AudioFollowSystem = value);
        Int(body, "musicDuckMs", 0, 3000, value => options.MusicDuckMs = value);
        Int(body, "musicRestoreMs", 0, 5000, value => options.MusicRestoreMs = value);
        Double(body, "occludeThreshold", 0.1, 1.0, value => options.OccludeThreshold = value);
        Bool(body, "closeToTray", value => options.CloseToTray = value);
        OneOf(body, "autoLaunch", WallpaperSettings.AutoLaunchModes, value => options.AutoLaunch = value);

        Bool(body, "pageNormal", value => options.PageNormal = value);
        Bool(body, "pageImmersive", value => options.PageImmersive = value);
        Bool(body, "pageRoom", value => options.PageRoom = value);
        Bool(body, "pageLogin", value => options.PageLogin = value);

        OneOf(body, "transitionMode", WallpaperSettings.TransitionModes, value => options.TransitionMode = value);
        Plain(body, "transitionId", 64, value => options.TransitionId = value);
        Int(body, "transitionMs", 0, 2000, value => options.TransitionMs = value);
        StringArray(body, "transitionExclude", 32, 64, values => options.TransitionExclude = values);

        Bool(body, "rotationEnabled", value => options.RotationEnabled = value);
        OneOfInt(body, "rotationMinutes", WallpaperSettings.RotationMinutesOptions, value => options.RotationMinutes = value);
        OneOf(body, "rotationOrder", WallpaperSettings.RotationOrders, value => options.RotationOrder = value);
        Bool(body, "rotationFavoriteFirst", value => options.RotationFavoriteFirst = value);
        Bool(body, "prewarm", value => options.Prewarm = value);

        Bool(body, "desktopAttached", value => options.DesktopAttached = value);
        Bool(body, "desktopSound", value => options.DesktopSound = value);
        Bool(body, "edgeBarEnabled", value => options.EdgeBarEnabled = value);
        Int(body, "edgeBarDelayMs", 0, 3000, value => options.EdgeBarDelayMs = value);

        OneOfInt(body, "frameRateLimit", new[] { 0, 15, 24, 30, 60, 144 }, value => options.FrameRateLimit = value);
        OneOfInt(body, "renderScale", WallpaperSettings.RenderScales, value => options.RenderScale = value);
        Bool(body, "hardwareDecode", value => options.HardwareDecode = value);
        OneOfInt(body, "downsampleAbove", new[] { 0, 1080, 1440, 2160 }, value => options.DownsampleAbove = value);
        Int(body, "concurrentDecode", 0, 8, value => options.ConcurrentDecode = value);
        Bool(body, "pauseOnMinimize", value => options.PauseOnMinimize = value);
        Int(body, "idleFpsAfterSec", 0, 3600, value => options.IdleFpsAfterSec = value);
        OneOfInt(body, "idleFps", WallpaperSettings.IdleFpsOptions, value => options.IdleFps = value);
        Bool(body, "pauseOnBattery", value => options.PauseOnBattery = value);
        Bool(body, "pauseOnFullscreen", value => options.PauseOnFullscreen = value);
        Bool(body, "adaptiveQuality", value => options.AdaptiveQuality = value);
        OneOf(body, "reduceMotion", WallpaperSettings.ReduceMotionModes, value => options.ReduceMotion = value);

        Double(body, "parallax", 0.0, 1.0, value => options.Parallax = value);
        Bool(body, "overlayEnabled", value => options.OverlayEnabled = value);
        Bool(body, "appearanceLink", value => options.AppearanceLink = value);
        Bool(body, "beatLock", value => options.BeatLock = value);
        Plain(body, "overlayTemplate", 120, value => options.OverlayTemplate = value);
        OneOf(body, "dimMode", WallpaperSettings.DimModes, value => options.DimMode = value);
        Double(body, "dimBase", 0.0, 0.9, value => options.DimBase = value);
        Double(body, "dimMax", 0.0, 0.9, value => options.DimMax = value);
        Int(body, "dimEmaMs", 0, 5000, value => options.DimEmaMs = value);
        Int(body, "brightness", -100, 100, value => options.Brightness = value);
        Int(body, "contrast", -100, 100, value => options.Contrast = value);
        Int(body, "saturation", -100, 100, value => options.Saturation = value);
        Int(body, "blur", 0, 40, value => options.Blur = value);
        Bool(body, "accentFromFrame", value => options.AccentFromFrame = value);
        OneOf(body, "fitMode", WallpaperSettings.FitModes, value => options.FitMode = value);

        Bool(body, "visualizerEnabled", value => options.VisualizerEnabled = value);
        OneOf(body, "visualizerStyle", WallpaperSettings.VisualizerStyles, value => options.VisualizerStyle = value);
        Int(body, "beatStrength", 0, 100, value => options.BeatStrength = value);
        OneOf(body, "gridDensity", WallpaperSettings.GridDensities, value => options.GridDensity = value);
        OneOfInt(body, "thumbConcurrency", WallpaperSettings.ThumbConcurrencyOptions, value => options.ThumbConcurrency = value);
        OneOfInt(body, "cacheKeepDays", WallpaperSettings.CacheKeepDaysOptions, value => options.CacheKeepDays = value);
        StringArray(body, "watchFolders", 16, 1024, values => options.WatchFolders = values);
    }

    /* ------------------------------------------------------------------ 类型化读取 */

    private static bool TryNode(JsonObject body, string key, out JsonNode node)
    {
        node = null!;
        if (!body.TryGetPropertyValue(key, out var found) || found is null)
        {
            return false;
        }

        node = found;
        return true;
    }

    private static void Bool(JsonObject body, string key, Action<bool> set)
    {
        if (!TryNode(body, key, out var node)) return;
        switch (node.GetValueKind())
        {
            case JsonValueKind.True:
                set(true);
                break;
            case JsonValueKind.False:
                set(false);
                break;
            case JsonValueKind.String when bool.TryParse(node.GetValue<string>(), out var parsed):
                set(parsed);
                break;
        }
    }

    private static void Int(JsonObject body, string key, int min, int max, Action<int> set)
    {
        if (!TryNode(body, key, out var node) || node.GetValueKind() != JsonValueKind.Number) return;
        var value = node.GetValue<double>();
        if (double.IsNaN(value)) return;
        set(Math.Clamp((int)Math.Round(value), min, max));
    }

    private static void Double(JsonObject body, string key, double min, double max, Action<double> set)
    {
        if (!TryNode(body, key, out var node) || node.GetValueKind() != JsonValueKind.Number) return;
        var value = node.GetValue<double>();
        if (double.IsNaN(value) || double.IsInfinity(value)) return;
        set(Math.Round(Math.Clamp(value, min, max), 2));
    }

    private static void OneOf(JsonObject body, string key, string[] allowed, Action<string> set)
    {
        if (!TryNode(body, key, out var node) || node.GetValueKind() != JsonValueKind.String) return;
        var value = (node.GetValue<string>() ?? string.Empty).Trim();
        if (allowed.Contains(value, StringComparer.Ordinal)) set(value);
    }

    private static void OneOfInt(JsonObject body, string key, int[] allowed, Action<int> set)
    {
        if (!TryNode(body, key, out var node) || node.GetValueKind() != JsonValueKind.Number) return;
        var value = (int)Math.Round(node.GetValue<double>());
        if (allowed.Contains(value)) set(value);
    }

    /// <summary>标识符式字符串（转场 ID 等）：只留字母数字与 <c>-_</c>。</summary>
    private static void Plain(JsonObject body, string key, int maxLength, Action<string> set)
    {
        if (!TryNode(body, key, out var node) || node.GetValueKind() != JsonValueKind.String) return;
        var value = (node.GetValue<string>() ?? string.Empty).Trim();
        if (value.Length == 0 || value.Length > maxLength) return;
        // 叠层模板允许标点（用户会写「{time} · {weekday}」这种），只挡控制字符。
        foreach (var ch in value)
        {
            if (char.IsControl(ch))
            {
                return;
            }
        }

        set(value);
    }

    private static void StringArray(JsonObject body, string key, int maxItems, int maxLength, Action<List<string>> set)
    {
        if (!TryNode(body, key, out var node) || node is not JsonArray array) return;
        var values = new List<string>();
        foreach (var item in array)
        {
            if (item is null || item.GetValueKind() != JsonValueKind.String) continue;
            var value = (item.GetValue<string>() ?? string.Empty).Trim();
            if (value.Length == 0 || value.Length > maxLength) continue;
            values.Add(value);
            if (values.Count >= maxItems) break;
        }

        set(values);
    }
}
