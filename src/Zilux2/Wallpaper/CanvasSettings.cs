using System.Text.Json;
using System.Text.Json.Nodes;
using Zilux2.Wallpaper.Model;

namespace Zilux2.Wallpaper;

/// <summary>
/// 画布级的画面参数（第 89 轮）：镜像 / 旋转 / 四边裁剪 / 缩放 / 模糊。
///
/// 这些值以前挂在素材（AssetEnvelop.Transform）上，改一次是全屏一起变——
/// 同一张壁纸铺在两块屏上时没法分别调。现在每块屏画布各自一份，落在
/// canvases.filter_json 里，跟 fps 共用同一个 JSON（MonitorCatalog 只认 "fps" 键，
/// 其它键原样保留，互不干扰）。
///
/// 取值优先级：画布 filter_json 里的键 → 素材自身的 Transform → 默认值。
/// 这样老数据（filter_json 为空）行为不变，新调过的屏才产生覆盖。
/// </summary>
internal readonly record struct CanvasOverrides(
    bool MirrorH,
    bool MirrorV,
    int Rotation,
    double CropLeft,
    double CropTop,
    double CropRight,
    double CropBottom,
    double Zoom,
    double Blur)
{
    public static CanvasOverrides FromTransform(WallpaperTransform transform) => new(
        transform.MirrorH,
        transform.MirrorV,
        NormalizeRotation(transform.Rotation),
        Clamp(transform.CropLeft, 0, 45),
        Clamp(transform.CropTop, 0, 45),
        Clamp(transform.CropRight, 0, 45),
        Clamp(transform.CropBottom, 0, 45),
        Clamp(transform.Zoom <= 0 ? 1 : transform.Zoom, 1, 3),
        Clamp(transform.Blur, 0, 24));

    public static int NormalizeRotation(int rotation)
    {
        var step = (int)Math.Round(rotation / 90.0) * 90;
        var wrapped = step % 360;
        return wrapped < 0 ? wrapped + 360 : wrapped;
    }

    public static double Clamp(double value, double min, double max) =>
        double.IsNaN(value) ? min : Math.Min(max, Math.Max(min, value));
}

/// <summary>画布参数在 filter_json 里的读写（与 fps 共用一个对象，只动自己认识的键）。</summary>
internal static class CanvasSettings
{
    public const string MirrorHKey = "mirrorH";
    public const string MirrorVKey = "mirrorV";
    public const string RotationKey = "rotation";
    public const string CropLeftKey = "cropLeft";
    public const string CropTopKey = "cropTop";
    public const string CropRightKey = "cropRight";
    public const string CropBottomKey = "cropBottom";
    public const string ZoomKey = "zoom";
    public const string BlurKey = "blur";

    /// <summary>画布自己的值；没有覆盖的键回落到素材 Transform。</summary>
    public static CanvasOverrides Read(string? filterJson, WallpaperTransform fallback) =>
        Read(filterJson, CanvasOverrides.FromTransform(fallback));

    /// <summary>画布自己的值；没有覆盖的键回落到上一层（全局画布 / 素材）的值。</summary>
    public static CanvasOverrides Read(string? filterJson, CanvasOverrides fallback)
    {
        var result = fallback;
        var root = Parse(filterJson);
        if (root is null) return result;

        var mirrorH = Bool(root, MirrorHKey);
        var mirrorV = Bool(root, MirrorVKey);
        var rotation = Int(root, RotationKey);
        var cropLeft = Double(root, CropLeftKey);
        var cropTop = Double(root, CropTopKey);
        var cropRight = Double(root, CropRightKey);
        var cropBottom = Double(root, CropBottomKey);
        var zoom = Double(root, ZoomKey);
        var blur = Double(root, BlurKey);

        return new CanvasOverrides(
            mirrorH ?? result.MirrorH,
            mirrorV ?? result.MirrorV,
            rotation is { } r ? CanvasOverrides.NormalizeRotation(r) : result.Rotation,
            cropLeft is { } cl ? CanvasOverrides.Clamp(cl, 0, 45) : result.CropLeft,
            cropTop is { } ct ? CanvasOverrides.Clamp(ct, 0, 45) : result.CropTop,
            cropRight is { } cr ? CanvasOverrides.Clamp(cr, 0, 45) : result.CropRight,
            cropBottom is { } cb ? CanvasOverrides.Clamp(cb, 0, 45) : result.CropBottom,
            zoom is { } z ? CanvasOverrides.Clamp(z, 1, 3) : result.Zoom,
            blur is { } b ? CanvasOverrides.Clamp(b, 0, 24) : result.Blur);
    }

    /// <summary>
    /// 把请求体里的画面参数并进 filter_json：只动认识的键，其它（fps、以后的扩展）原样保留。
    /// 传 null 表示删掉这个覆盖、回落到素材值。
    /// </summary>
    public static string? Merge(string? filterJson, JsonObject patch)
    {
        var root = Parse(filterJson) ?? new JsonObject();

        ApplyBool(root, MirrorHKey, patch);
        ApplyBool(root, MirrorVKey, patch);
        ApplyInt(root, RotationKey, patch, value => CanvasOverrides.NormalizeRotation(value));
        ApplyDouble(root, CropLeftKey, patch, value => CanvasOverrides.Clamp(value, 0, 45));
        ApplyDouble(root, CropTopKey, patch, value => CanvasOverrides.Clamp(value, 0, 45));
        ApplyDouble(root, CropRightKey, patch, value => CanvasOverrides.Clamp(value, 0, 45));
        ApplyDouble(root, CropBottomKey, patch, value => CanvasOverrides.Clamp(value, 0, 45));
        ApplyDouble(root, ZoomKey, patch, value => CanvasOverrides.Clamp(value, 1, 3));
        ApplyDouble(root, BlurKey, patch, value => CanvasOverrides.Clamp(value, 0, 24));

        return root.Count == 0 ? null : root.ToJsonString();
    }

    private static JsonObject? Parse(string? filterJson)
    {
        if (string.IsNullOrWhiteSpace(filterJson)) return null;
        try
        {
            return JsonNode.Parse(filterJson) as JsonObject;
        }
        catch (JsonException)
        {
            // filter_json 是历史数据，坏了就当没设过。
            return null;
        }
    }

    private static bool? Bool(JsonObject root, string key) =>
        root[key] is JsonValue value && value.TryGetValue<bool>(out var parsed) ? parsed : null;

    private static int? Int(JsonObject root, string key) =>
        root[key] is JsonValue value && value.TryGetValue<int>(out var parsed) ? parsed : null;

    private static double? Double(JsonObject root, string key) =>
        root[key] is JsonValue value && value.TryGetValue<double>(out var parsed) ? parsed : null;

    private static void ApplyBool(JsonObject root, string key, JsonObject patch)
    {
        if (!patch.TryGetPropertyValue(key, out var node)) return;
        if (node is JsonValue value && value.TryGetValue<bool>(out var parsed)) root[key] = parsed;
        else if (node is null) root.Remove(key);
    }

    private static void ApplyInt(JsonObject root, string key, JsonObject patch, Func<int, int> normalize)
    {
        if (!patch.TryGetPropertyValue(key, out var node)) return;
        if (node is JsonValue value && value.TryGetValue<int>(out var parsed)) root[key] = normalize(parsed);
        else if (node is JsonValue raw && raw.TryGetValue<double>(out var number)) root[key] = normalize((int)Math.Round(number));
        else if (node is null) root.Remove(key);
    }

    private static void ApplyDouble(JsonObject root, string key, JsonObject patch, Func<double, double> normalize)
    {
        if (!patch.TryGetPropertyValue(key, out var node)) return;
        if (node is JsonValue value && value.TryGetValue<double>(out var parsed)) root[key] = normalize(parsed);
        else if (node is null) root.Remove(key);
    }
}
