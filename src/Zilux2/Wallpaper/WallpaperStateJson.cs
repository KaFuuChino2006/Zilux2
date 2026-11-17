using System;
using System.Text.Json;
using Zilux2.Wallpaper.Render;

namespace Zilux2.Wallpaper;

/// <summary>
/// 壁纸层状态消息的唯一构造点。
///
/// 主窗口的 WebView2 和桌面层的 WebView2 是两个独立页面（后者挂在 Progman 下），
/// 但两者吃的都是这一份 JSON —— 抽出来避免两处字段慢慢跑偏（漏一个字段就是
/// 桌面层不跟着转场/不跟着滤镜这类难查的问题）。
/// </summary>
internal static class WallpaperStateJson
{
    public static string Build(
        WallpaperLayerPayload? payload,
        string? screensJson = null,
        string? baseUrl = null,
        string? token = null)
    {
        // 桌面层那块页面没有主窗口的 boot 数据，拿不到在线源端口 —— onlineEndpoint()
        // 会返回空串，<video>/<img> 的 src 变成空值后浏览器按「当前文档 URL」解释，
        // 结果就是一张加载失败的图 + 整块黑屏。所以推送时直接给绝对地址。
        var absolute = !string.IsNullOrWhiteSpace(baseUrl);
        var mediaUrl = absolute ? $"{baseUrl}{payload?.MediaUrl}?token={token}" : payload?.MediaUrl;
        var coverUrl = payload is null
            ? null
            : absolute
                ? $"{baseUrl}/api/wallpaper/v2/cover/{payload.AssetId}?token={token}"
                : payload.CoverPath;

        return JsonSerializer.Serialize(new
        {
            v = 1,
            type = "host",
            @event = "wallpaperState",
            visible = payload?.Visible ?? false,
            layer = payload is null
                ? null
                : new
                {
                    assetId = payload.AssetId,
                    kind = payload.Kind,
                    mediaUrl,
                    coverUrl,
                    paused = payload.Paused,
                    transition = payload.TransitionKey,
                    transitionMs = payload.TransitionMs,
                    dim = payload.Dim,
                    blur = payload.Blur,
                    brightness = payload.Brightness,
                    contrast = payload.Contrast,
                    saturation = payload.Saturation,
                    // 音轨：壁纸默认静音，audioEnabled 才出声；音乐在播时宿主会把
                    // AudioEnabled 传成 false（第 4 轮「音乐优先」的落地方式）。
                    audioEnabled = payload.AudioEnabled,
                    audioVolume = payload.AudioVolume,
                    fitMode = payload.FitMode,
                    beatStrength = payload.BeatStrength,
                    visualizer = payload.VisualizerEnabled,
                    visualizerStyle = payload.VisualizerStyle,
                    trimInMs = payload.TrimInMs,
                    trimOutMs = payload.TrimOutMs,
                    speed = payload.Speed,
                    mirrorH = payload.MirrorH,
                    mirrorV = payload.MirrorV,
                    rotation = payload.Rotation,
                    cropLeft = payload.CropLeft,
                    cropTop = payload.CropTop,
                    cropRight = payload.CropRight,
                    cropBottom = payload.CropBottom,
                    // 画面自身的缩放/模糊；上面的 blur 是「背板压暗模糊」那个选项，两者别混。
                    pictureZoom = payload.PictureZoom,
                    pictureBlur = payload.PictureBlur,
                    // 上屏帧率上限（每屏一份）：0 = 不限，<60 时页面用 canvas 取帧。
                    fps = payload.Fps,
                    overlayEnabled = payload.OverlayEnabled,
                    overlayTemplate = payload.OverlayTemplate,
                    // 多屏布局：每块屏相对虚拟屏的百分比矩形。桌面层才有；
                    // 用百分比而不是像素，页面里不必关心 DPI（100%/150% 混插也对）。
                    // 必须反序列化成 JsonElement —— 直接把 JSON 字符串塞进去会变成
                    // 带引号的字符串字面量，前端拿到的是 "screens":"[{...}]"。
                    screens = string.IsNullOrWhiteSpace(screensJson)
                        ? (object?)null
                        : JsonSerializer.Deserialize<JsonElement>(screensJson!),
                },
        });
    }
}
