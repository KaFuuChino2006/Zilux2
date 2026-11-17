using System.Globalization;
using System.IO;
using System.Net;
using System.Text.Json.Nodes;
using Zilux2.Settings;
using Zilux2.Wallpaper;
using Zilux2.Wallpaper.Data;
using Zilux2.Wallpaper.Library;
using Zilux2.Wallpaper.Model;

namespace Zilux2.Online;

/// <summary>
/// 动态壁纸 v2 的 HTTP 面（docs/wallpaper-v2-spec.md §7）。
/// 全部挂在 <c>/api/wallpaper/v2/</c> 前缀下，沿用宿主的 token 鉴权；这里只做参数解析与
/// JSON 编组，真正的状态都在 <see cref="WallpaperHost"/> 里。
/// </summary>
internal sealed partial class LocalMusicServer
{
    private const int MaxWallpaperBodyBytes = 256 * 1024;

    private async Task<int> HandleWallpaperV2Async(HttpListenerContext context, string path, string method)
    {
        var host = Wallpaper;
        var settings = Settings;
        var relative = path["/api/wallpaper/v2/".Length..].Trim('/');
        var segments = relative.Length == 0 ? Array.Empty<string>() : relative.Split('/');
        var isGet = method.Equals("GET", StringComparison.OrdinalIgnoreCase);
        var isPost = method.Equals("POST", StringComparison.OrdinalIgnoreCase);
        var isPut = method.Equals("PUT", StringComparison.OrdinalIgnoreCase);
        var isDelete = method.Equals("DELETE", StringComparison.OrdinalIgnoreCase);

        // 设置类端点不需要宿主（例如 /options 只读写配置），其余一律要有宿主。
        if (host is null && segments is not ["options"])
        {
            return WriteError(context, 503, "wallpaper-unavailable", "壁纸模块尚未就绪");
        }

        switch (segments)
        {
            case ["state"] when isGet:
                return WriteWallpaperState(context, host!);

            case ["monitors"] when isGet:
                return WriteWallpaperMonitors(context, host!);

            case ["monitors"] when isPut || isPost:
                return await SaveWallpaperMonitorAsync(context, host!).ConfigureAwait(false);

            case ["canvas", var settingsKind, "settings"] when isGet:
                return WriteWallpaperCanvasSettings(context, host!, settingsKind);

            case ["canvas", var settingsKind, "settings"] when isPut || isPost:
                return await SaveWallpaperCanvasSettingsAsync(context, host!, settingsKind).ConfigureAwait(false);

            case ["options"] when isGet:
                if (settings is null) return WriteError(context, 503, "wallpaper-unavailable", "设置服务尚未就绪");
                WriteWallpaperJson(context, 200, WallpaperOptionsJson(settings.WallpaperSnapshot));
                return 200;

            case ["options"] when isPut || isPost:
                if (settings is null) return WriteError(context, 503, "wallpaper-unavailable", "设置服务尚未就绪");
                return await PatchWallpaperOptionsAsync(context, settings).ConfigureAwait(false);

            case ["library", "items"] when isGet:
                return WriteWallpaperLibrary(context, host!);

            case ["library", "items", var id] when isGet:
                return WriteWallpaperAsset(context, host!, id);

            case ["library", "items", var id] when isPut || isPost:
                return await PatchWallpaperAssetAsync(context, host!, id).ConfigureAwait(false);

            case ["library", "items", var id] when isDelete:
                return DeleteWallpaperAsset(context, host!, id);

            case ["library", "items", var id, "localize"] when isPost:
                return LocalizeWallpaperAsset(context, host!, id);

            case ["library", "scan"] when isPost:
                return await ScanWallpaperLibraryAsync(context, host!).ConfigureAwait(false);

            case ["library", "import"] when isPost:
                return await ImportWallpaperAsync(context, host!).ConfigureAwait(false);

            case ["cover", var id] when isGet:
                return WriteWallpaperCover(context, host!, id);

            case ["media", var id] when isGet:
                return await WriteWallpaperMediaAsync(context, host!, id).ConfigureAwait(false);

            case ["library", "tags"] when isGet:                WriteWallpaperJson(context, 200, WallpaperTagsJson(host!.Store));
                return 200;

            case ["library", "collections"] when isGet:
                WriteWallpaperJson(context, 200, WallpaperCollectionsJson(host!.Store));
                return 200;

            case ["canvas", var kind, "apply"] when isPost:
                return await ApplyWallpaperCanvasAsync(context, host!, kind).ConfigureAwait(false);

            case ["canvas", var kind, "pause"] when isPost:
                return await PauseWallpaperCanvasAsync(context, host!, kind).ConfigureAwait(false);

            case ["sequences"] when isGet:
                return WriteWallpaperSequences(context, host!);

            case ["sequences"] when isPost || isPut:
                return await SaveWallpaperSequenceAsync(context, host!).ConfigureAwait(false);

            case ["sequences", var id] when isDelete:
                return DeleteWallpaperSequence(context, host!, id);

            case ["presets"] when isGet:
                return WriteWallpaperPresets(context, host!);

            case ["presets"] when isPost || isPut:
                return await SaveWallpaperPresetAsync(context, host!).ConfigureAwait(false);

            case ["presets", var id] when isDelete:
                return DeleteWallpaperPreset(context, host!, id);

            case ["rules"] when isGet:
                return WriteWallpaperRules(context, host!);

            case ["rules"] when isPost || isPut:
                return await SaveWallpaperRuleAsync(context, host!).ConfigureAwait(false);

            case ["rules", var id] when isDelete:
                return DeleteWallpaperRule(context, host!, id);

            case ["canvas", var kind, "sequence"] when isPost:
                return await ApplyWallpaperSequenceAsync(context, host!, kind).ConfigureAwait(false);

            case ["canvas", var kind, "next"] when isPost:
                return NextWallpaperCanvas(context, host!, kind);

            case ["canvas"] when isGet:
                return WriteWallpaperCanvas(context, host!);

            case ["desktop", "attach"] when isPost:
            {
                var attached = host!.AttachDesktop();
                var snapshot = host.Snapshot();
                WriteWallpaperJson(context, attached ? 200 : 503, new JsonObject
                {
                    ["ok"] = attached,
                    ["reason"] = attached ? null : "找不到可用的 WorkerW（资源管理器可能未运行）",
                    ["canvas"] = CanvasNode(snapshot.Desktop),
                });
                return attached ? 200 : 503;
            }

            case ["desktop", "detach"] when isPost:
            {
                host!.DetachDesktop();
                WriteWallpaperJson(context, 200, new JsonObject { ["ok"] = true });
                return 200;
            }

            case ["storage"] when isGet:
                WriteWallpaperJson(context, 200, WallpaperStorageJson(host!));
                return 200;

            case ["storage", "clean"] when isPost:
                return CleanWallpaperStorage(context, host!);

            case ["diagnostics"] when isGet:
                WriteWallpaperJson(context, 200, WallpaperDiagnosticsJson(host!, settings));
                return 200;

            case ["diagnostics", "export"] when isPost:
            {
                try
                {
                    var zipPath = host!.ExportDiagnostics();
                    WriteWallpaperJson(context, 200, new JsonObject { ["ok"] = true, ["path"] = zipPath });
                    return 200;
                }
                catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
                {
                    return WriteError(context, 500, "io-failed", $"导出失败：{exception.Message}");
                }
            }

            case ["selfcheck"] when isPost:
            {
                var checks = new JsonArray();
                var failures = 0;
                foreach (var (name, ok, detail) in host!.SelfCheck())
                {
                    if (!ok) failures++;
                    checks.Add(new JsonObject { ["name"] = name, ["ok"] = ok, ["detail"] = detail });
                }

                WriteWallpaperJson(context, 200, new JsonObject
                {
                    ["ok"] = failures == 0,
                    ["failures"] = failures,
                    ["checks"] = checks,
                });
                return 200;
            }

            default:
                return WriteError(context, 404, "not-found", "未知壁纸接口");
        }
    }

    /* ------------------------------------------------------------------ 状态 */

    private int WriteWallpaperState(HttpListenerContext context, WallpaperHost host)
    {
        var snapshot = host.Snapshot();
        var payload = new JsonObject
        {
            ["ok"] = true,
            ["enabled"] = snapshot.Enabled,
            ["libraryCount"] = snapshot.LibraryCount,
            ["ffmpegAvailable"] = snapshot.FfmpegAvailable,
            ["ffmpegPath"] = snapshot.FfmpegPath,
            ["inApp"] = CanvasNode(snapshot.InApp),
            ["desktop"] = CanvasNode(snapshot.Desktop),
        };
        WriteWallpaperJson(context, 200, payload);
        return 200;
    }

    private static JsonObject CanvasNode(CanvasSnapshot canvas) => new()
    {
        ["kind"] = canvas.Kind,
        ["assetId"] = canvas.AssetId,
        ["title"] = canvas.Title,
        ["coverPath"] = canvas.CoverPath,
        ["paused"] = canvas.Paused,
        ["running"] = canvas.Running,
        ["lastError"] = canvas.LastError,
    };

    private int WriteWallpaperCanvas(HttpListenerContext context, WallpaperHost host)
    {
        var snapshot = host.Snapshot();
        var payload = new JsonObject
        {
            ["ok"] = true,
            ["inApp"] = CanvasNode(snapshot.InApp),
            ["desktop"] = CanvasNode(snapshot.Desktop),
        };
        WriteWallpaperJson(context, 200, payload);
        return 200;
    }

    /* ------------------------------------------------------------------ 素材库 */

    private int WriteWallpaperLibrary(HttpListenerContext context, WallpaperHost host)
    {
        var query = context.Request.QueryString;
        var request = new AssetQuery
        {
            Search = Trimmed(query["query"]),
            Kind = ParseKind(query["kind"]),
            Source = ParseSource(query["source"]),
            FavoritesOnly = IsTruthy(query["favorites"]),
            ResolutionBucket = Trimmed(query["resolution"]),
            DurationBucket = Trimmed(query["duration"]),
            SizeBucket = Trimmed(query["size"]),
            Sort = Trimmed(query["sort"]) ?? "added",
            Offset = ParseInt(query["offset"], 0),
            Limit = Math.Clamp(ParseInt(query["limit"], 120), 1, 500),
        };
        if (long.TryParse(query["collection"], NumberStyles.Integer, CultureInfo.InvariantCulture, out var collectionId) && collectionId > 0)
        {
            request.CollectionId = collectionId;
        }

        if (long.TryParse(query["tag"], NumberStyles.Integer, CultureInfo.InvariantCulture, out var tagId) && tagId > 0)
        {
            request.TagId = tagId;
        }

        var (items, total) = host.Store.List(request);
        var array = new JsonArray();
        foreach (var asset in items)
        {
            array.Add(AssetNode(asset, host.Store.IsFavorite(asset.Id)));
        }

        var payload = new JsonObject
        {
            ["ok"] = true,
            ["total"] = total,
            ["offset"] = request.Offset,
            ["limit"] = request.Limit,
            ["items"] = array,
        };
        WriteWallpaperJson(context, 200, payload);
        return 200;
    }

    private int WriteWallpaperAsset(HttpListenerContext context, WallpaperHost host, string rawId)
    {
        if (!TryParseId(rawId, out var id))
        {
            return WriteError(context, 400, "bad-request", "素材 ID 无效");
        }

        var asset = host.Store.FindById(id);
        if (asset is null)
        {
            return WriteError(context, 404, "not-found", "没有这条素材");
        }

        var payload = new JsonObject
        {
            ["ok"] = true,
            ["item"] = AssetNode(asset, host.Store.IsFavorite(id)),
            ["tags"] = WallpaperTagsOf(host.Store, id),
        };
        WriteWallpaperJson(context, 200, payload);
        return 200;
    }

    private static JsonObject AssetNode(WallpaperAsset asset, bool favorite) => new()
    {
        ["id"] = asset.Id,
        ["title"] = string.IsNullOrWhiteSpace(asset.Title)
            ? Path.GetFileNameWithoutExtension(asset.Path)
            : asset.Title,
        ["path"] = asset.Path,
        ["source"] = SourceKey(asset.Source),
        ["kind"] = KindKey(asset.Kind),
        ["width"] = asset.Width,
        ["height"] = asset.Height,
        ["durationMs"] = asset.DurationMs,
        ["effectiveDurationMs"] = asset.EffectiveDurationMs,
        ["fps"] = asset.Fps,
        ["sizeBytes"] = asset.SizeBytes,
        ["coverPath"] = asset.CoverPath,
        ["coverTimeMs"] = asset.CoverTimeMs,
        ["trimInMs"] = asset.TrimInMs,
        ["trimOutMs"] = asset.TrimOutMs,
        ["speed"] = asset.Speed,
        ["fitOverride"] = asset.FitOverride,
        ["transform"] = new JsonObject
        {
            ["mirrorH"] = asset.Transform.MirrorH,
            ["mirrorV"] = asset.Transform.MirrorV,
            ["rotation"] = asset.Transform.Rotation,
            ["cropLeft"] = asset.Transform.CropLeft,
            ["cropTop"] = asset.Transform.CropTop,
            ["cropRight"] = asset.Transform.CropRight,
            ["cropBottom"] = asset.Transform.CropBottom,
            ["zoom"] = asset.Transform.Zoom,
            ["blur"] = asset.Transform.Blur,
        },
        ["missing"] = asset.Missing,
        ["favorite"] = favorite,
        ["addedAt"] = asset.AddedAt,
    };

    private async Task<int> PatchWallpaperAssetAsync(HttpListenerContext context, WallpaperHost host, string rawId)
    {
        if (!TryParseId(rawId, out var id))
        {
            return WriteError(context, 400, "bad-request", "素材 ID 无效");
        }

        var asset = host.Store.FindById(id);
        if (asset is null)
        {
            return WriteError(context, 404, "not-found", "没有这条素材");
        }

        var body = await ReadWallpaperBodyAsync(context).ConfigureAwait(false);
        if (body is null)
        {
            return WriteError(context, 400, "bad-request", "请求体无效");
        }

        if (body["title"] is JsonNode title && title.GetValueKind() == System.Text.Json.JsonValueKind.String)
        {
            var text = (title.GetValue<string>() ?? string.Empty).Trim();
            if (text.Length is > 0 and <= 120)
            {
                asset.Title = text;
            }
        }

        if (TryReadLong(body["trimInMs"], out var trimIn))
        {
            asset.TrimInMs = trimIn <= 0 ? null : trimIn;
        }

        if (TryReadLong(body["trimOutMs"], out var trimOut))
        {
            asset.TrimOutMs = trimOut <= 0 ? null : trimOut;
        }

        if (body["speed"] is JsonNode speed && speed.GetValueKind() == System.Text.Json.JsonValueKind.Number)
        {
            asset.Speed = Math.Clamp(speed.GetValue<double>(), 0.5, 2.0);
        }

        if (body["fitOverride"] is JsonNode fit && fit.GetValueKind() == System.Text.Json.JsonValueKind.String)
        {
            var value = (fit.GetValue<string>() ?? string.Empty).Trim();
            asset.FitOverride = WallpaperSettings.FitModes.Contains(value) && value != "smart" ? value : null;
        }

        if (body["transform"] is JsonObject transform)
        {
            if (transform["mirrorH"] is JsonNode mh && mh.GetValueKind() is System.Text.Json.JsonValueKind.True or System.Text.Json.JsonValueKind.False)
            {
                asset.Transform.MirrorH = mh.GetValue<bool>();
            }

            if (transform["mirrorV"] is JsonNode mv && mv.GetValueKind() is System.Text.Json.JsonValueKind.True or System.Text.Json.JsonValueKind.False)
            {
                asset.Transform.MirrorV = mv.GetValue<bool>();
            }

            if (transform["rotation"] is JsonNode rot && rot.GetValueKind() == System.Text.Json.JsonValueKind.Number)
            {
                var degrees = rot.GetValue<int>();
                if (degrees is 0 or 90 or 180 or 270) asset.Transform.Rotation = degrees;
            }

            asset.Transform.CropLeft = ReadCrop(transform["cropLeft"], asset.Transform.CropLeft);
            asset.Transform.CropTop = ReadCrop(transform["cropTop"], asset.Transform.CropTop);
            asset.Transform.CropRight = ReadCrop(transform["cropRight"], asset.Transform.CropRight);
            asset.Transform.CropBottom = ReadCrop(transform["cropBottom"], asset.Transform.CropBottom);
            asset.Transform.Zoom = ReadZoom(transform["zoom"], asset.Transform.Zoom);
            asset.Transform.Blur = ReadBlur(transform["blur"], asset.Transform.Blur);
        }

        // 出点必须大于入点，否则一次解码进程会立刻 EOF。
        if (asset.TrimOutMs is { } outMs && asset.TrimInMs is { } inMs && outMs <= inMs)
        {
            asset.TrimOutMs = null;
        }

        host.Store.Save(asset);

        if (body["tags"] is JsonArray tags)
        {
            var names = new List<string>();
            foreach (var node in tags)
            {
                if (node is JsonNode item && item.GetValueKind() == System.Text.Json.JsonValueKind.String)
                {
                    var name = (item.GetValue<string>() ?? string.Empty).Trim();
                    if (name.Length is > 0 and <= 40)
                    {
                        names.Add(name);
                    }
                }
            }

            host.Store.SetTags(id, names);
        }

        if (body["favorite"] is JsonNode favoriteNode &&
            favoriteNode.GetValueKind() is System.Text.Json.JsonValueKind.True or System.Text.Json.JsonValueKind.False &&
            favoriteNode.GetValue<bool>() != host.Store.IsFavorite(id))
        {
            host.Store.ToggleFavorite(id);
        }

        // 改的是正在播的那张，就让宿主重推一次渲染指令（裁剪 / 变换 / 速度都在 payload 里）。
        host.NotifyAssetChanged(id);

        WriteWallpaperJson(context, 200, new JsonObject
        {
            ["ok"] = true,
            ["item"] = AssetNode(host.Store.FindById(id) ?? asset, host.Store.IsFavorite(id)),
            ["tags"] = WallpaperTagsOf(host.Store, id),
        });
        return 200;
    }

    // ── 序列 / 预设 / 规则（§5.4 / §5.8，第 58/83/85 轮） ──────────────────────
    // 三张表的读写都在 LibraryStore.Canvas.cs，这里只做 JSON 编解码与校验。

    private static JsonObject SequenceNode(WallpaperSequence sequence)
    {
        var items = new JsonArray();
        foreach (var item in sequence.Items)
        {
            items.Add(new JsonObject
            {
                ["assetId"] = item.AssetId,
                ["sort"] = item.Sort,
                ["durationMs"] = item.DurationMs,
                ["transitionId"] = item.TransitionId,
            });
        }

        return new JsonObject
        {
            ["id"] = sequence.Id,
            ["name"] = sequence.Name,
            ["canvas"] = sequence.Canvas is null ? null : (sequence.Canvas == CanvasKind.Desktop ? "desktop" : "inapp"),
            ["loop"] = sequence.Loop,
            ["items"] = items,
        };
    }

    private int WriteWallpaperSequences(HttpListenerContext context, WallpaperHost host)
    {
        var array = new JsonArray();
        foreach (var sequence in host.Store.ListSequences()) array.Add(SequenceNode(sequence));
        WriteWallpaperJson(context, 200, new JsonObject { ["ok"] = true, ["items"] = array });
        return 200;
    }

    private async Task<int> SaveWallpaperSequenceAsync(HttpListenerContext context, WallpaperHost host)
    {
        var body = await ReadWallpaperBodyAsync(context).ConfigureAwait(false);
        if (body is null) return WriteError(context, 400, "bad-request", "请求体无效");

        var sequence = new WallpaperSequence();
        if (body["id"] is JsonNode idNode && idNode.GetValueKind() == System.Text.Json.JsonValueKind.Number)
        {
            sequence.Id = idNode.GetValue<long>();
        }

        var name = (body["name"]?.GetValue<string>() ?? string.Empty).Trim();
        sequence.Name = name.Length is > 0 and <= 60 ? name : $"序列 {DateTime.Now:HHmmss}";
        sequence.Loop = body["loop"] is null || IsTruthy(body["loop"]);

        if (body["canvas"] is JsonNode canvasNode && canvasNode.GetValueKind() == System.Text.Json.JsonValueKind.String)
        {
            var canvas = (canvasNode.GetValue<string>() ?? string.Empty).Trim();
            sequence.Canvas = canvas == "desktop" ? CanvasKind.Desktop : canvas == "inapp" ? CanvasKind.InApp : null;
        }

        if (body["items"] is JsonArray items)
        {
            var sort = 0;
            foreach (var node in items)
            {
                if (node is not JsonObject item) continue;
                if (!TryReadLong(item["assetId"], out var assetId) || assetId <= 0) continue;
                if (host.Store.FindById(assetId) is null) continue;

                sequence.Items.Add(new SequenceItem
                {
                    AssetId = assetId,
                    Sort = sort++,
                    DurationMs = TryReadLong(item["durationMs"], out var duration) && duration > 0 ? duration : null,
                    TransitionId = item["transitionId"] is JsonNode transition &&
                                   transition.GetValueKind() == System.Text.Json.JsonValueKind.String
                        ? (transition.GetValue<string>() ?? string.Empty).Trim() is { Length: > 0 } key ? key : null
                        : null,
                });
            }
        }

        if (sequence.Items.Count == 0) return WriteError(context, 400, "bad-request", "序列至少要有一条素材");

        var saved = host.Store.SaveSequence(sequence);
        var fresh = host.Store.ListSequences().FirstOrDefault(item => item.Id == saved);
        WriteWallpaperJson(context, 200, new JsonObject
        {
            ["ok"] = true,
            ["item"] = fresh is null ? null : SequenceNode(fresh),
        });
        return 200;
    }

    private int DeleteWallpaperSequence(HttpListenerContext context, WallpaperHost host, string rawId)
    {
        if (!TryParseId(rawId, out var id)) return WriteError(context, 400, "bad-request", "序列 ID 无效");
        host.Store.DeleteSequence(id);
        WriteWallpaperJson(context, 200, new JsonObject { ["ok"] = true });
        return 200;
    }

    private async Task<int> ApplyWallpaperSequenceAsync(HttpListenerContext context, WallpaperHost host, string rawKind)
    {
        if (!TryParseCanvasKind(rawKind, out var kind))
        {
            return WriteError(context, 400, "bad-request", "画布类型无效");
        }

        var body = await ReadWallpaperBodyAsync(context).ConfigureAwait(false);
        if (body is null) return WriteError(context, 400, "bad-request", "请求体无效");

        if (!TryReadLong(body["sequenceId"], out var sequenceId) || sequenceId <= 0)
        {
            // 0 / 缺省 = 退出序列。
            host.ClearSequence(kind);
            WriteWallpaperJson(context, 200, new JsonObject { ["ok"] = true, ["canvas"] = kind == CanvasKind.Desktop ? CanvasNode(host.Snapshot().Desktop) : CanvasNode(host.Snapshot().InApp) });
            return 200;
        }

        if (!host.ApplySequence(sequenceId, kind))
        {
            return WriteError(context, 404, "not-found", "序列不存在或为空");
        }

        WriteWallpaperJson(context, 200, new JsonObject { ["ok"] = true, ["canvas"] = kind == CanvasKind.Desktop ? CanvasNode(host.Snapshot().Desktop) : CanvasNode(host.Snapshot().InApp) });
        return 200;
    }

    private static JsonObject PresetNode(WallpaperPreset preset)
    {
        JsonNode payload;
        try
        {
            payload = JsonNode.Parse(preset.PayloadJson) ?? new JsonObject();
        }
        catch (System.Text.Json.JsonException)
        {
            payload = new JsonObject();
        }

        return new JsonObject
        {
            ["id"] = preset.Id,
            ["name"] = preset.Name,
            ["kind"] = preset.Kind,
            ["payload"] = payload,
        };
    }

    private int WriteWallpaperPresets(HttpListenerContext context, WallpaperHost host)
    {
        var array = new JsonArray();
        foreach (var preset in host.Store.ListPresets()) array.Add(PresetNode(preset));
        WriteWallpaperJson(context, 200, new JsonObject { ["ok"] = true, ["items"] = array });
        return 200;
    }

    private async Task<int> SaveWallpaperPresetAsync(HttpListenerContext context, WallpaperHost host)
    {
        var body = await ReadWallpaperBodyAsync(context).ConfigureAwait(false);
        if (body is null) return WriteError(context, 400, "bad-request", "请求体无效");

        var preset = new WallpaperPreset();
        if (body["id"] is JsonNode idNode && idNode.GetValueKind() == System.Text.Json.JsonValueKind.Number)
        {
            preset.Id = idNode.GetValue<long>();
        }

        var name = (body["name"]?.GetValue<string>() ?? string.Empty).Trim();
        if (name.Length == 0 || name.Length > 60) return WriteError(context, 400, "bad-request", "预设名称为空或过长");
        preset.Name = name;

        var kind = (body["kind"]?.GetValue<string>() ?? "manual").Trim();
        preset.Kind = kind == "appearance" ? "appearance" : "manual";
        preset.PayloadJson = body["payload"]?.ToJsonString() ?? "{}";

        var saved = host.Store.SavePreset(preset);
        WriteWallpaperJson(context, 200, new JsonObject { ["ok"] = true, ["id"] = saved });
        return 200;
    }

    private int DeleteWallpaperPreset(HttpListenerContext context, WallpaperHost host, string rawId)
    {
        if (!TryParseId(rawId, out var id)) return WriteError(context, 400, "bad-request", "预设 ID 无效");
        host.Store.DeletePreset(id);
        WriteWallpaperJson(context, 200, new JsonObject { ["ok"] = true });
        return 200;
    }

    private static JsonObject RuleNode(WallpaperRule rule)
    {
        JsonNode condition;
        JsonNode action;
        try
        {
            condition = JsonNode.Parse(rule.ConditionJson) ?? new JsonObject();
        }
        catch (System.Text.Json.JsonException)
        {
            condition = new JsonObject();
        }

        try
        {
            action = JsonNode.Parse(rule.ActionJson) ?? new JsonObject();
        }
        catch (System.Text.Json.JsonException)
        {
            action = new JsonObject();
        }

        return new JsonObject
        {
            ["id"] = rule.Id,
            ["name"] = rule.Name,
            ["enabled"] = rule.Enabled,
            ["priority"] = rule.Priority,
            ["condition"] = condition,
            ["action"] = action,
        };
    }

    private int WriteWallpaperRules(HttpListenerContext context, WallpaperHost host)
    {
        var array = new JsonArray();
        foreach (var rule in host.Store.ListRules()) array.Add(RuleNode(rule));
        WriteWallpaperJson(context, 200, new JsonObject { ["ok"] = true, ["items"] = array });
        return 200;
    }

    private async Task<int> SaveWallpaperRuleAsync(HttpListenerContext context, WallpaperHost host)
    {
        var body = await ReadWallpaperBodyAsync(context).ConfigureAwait(false);
        if (body is null) return WriteError(context, 400, "bad-request", "请求体无效");

        var rule = new WallpaperRule();
        if (body["id"] is JsonNode idNode && idNode.GetValueKind() == System.Text.Json.JsonValueKind.Number)
        {
            rule.Id = idNode.GetValue<long>();
        }

        var name = (body["name"]?.GetValue<string>() ?? string.Empty).Trim();
        rule.Name = name.Length is > 0 and <= 60 ? name : "新规则";
        rule.Enabled = body["enabled"] is null || IsTruthy(body["enabled"]);
        rule.Priority = body["priority"] is JsonNode priority &&
                        priority.GetValueKind() == System.Text.Json.JsonValueKind.Number
            ? Math.Clamp(priority.GetValue<int>(), 0, 999)
            : 100;
        rule.ConditionJson = body["condition"]?.ToJsonString() ?? "{}";
        rule.ActionJson = body["action"]?.ToJsonString() ?? "{}";

        var saved = host.Store.SaveRule(rule);
        host.EvaluateRules();
        WriteWallpaperJson(context, 200, new JsonObject { ["ok"] = true, ["id"] = saved });
        return 200;
    }

    private int DeleteWallpaperRule(HttpListenerContext context, WallpaperHost host, string rawId)
    {
        if (!TryParseId(rawId, out var id)) return WriteError(context, 400, "bad-request", "规则 ID 无效");
        host.Store.DeleteRule(id);
        host.EvaluateRules();
        WriteWallpaperJson(context, 200, new JsonObject { ["ok"] = true });
        return 200;
    }

    /// <summary>
    /// 把工坊条目「转成本地副本」并替换原条目（第 10 章第 9 条建议值）。
    /// 复制进库目录后改 path/source，同一条记录换掉，不在库里留两条。
    /// </summary>
    private int LocalizeWallpaperAsset(HttpListenerContext context, WallpaperHost host, string idText)
    {
        if (!TryParseId(idText, out var id)) return WriteError(context, 400, "bad-id", "素材 id 不合法");
        if (host.Store.FindById(id) is not { } asset) return WriteError(context, 404, "not-found", "素材不存在");
        if (asset.Source == Zilux2.Wallpaper.Model.AssetSource.Import)
        {
            WriteWallpaperJson(context, 200, new JsonObject { ["ok"] = true, ["alreadyLocal"] = true, ["path"] = asset.Path });
            return 200;
        }

        if (!System.IO.File.Exists(asset.Path)) return WriteError(context, 404, "file-missing", "原文件已经不在了");

        try
        {
            Zilux2.Wallpaper.WallpaperFolders.Ensure();
            var fileName = System.IO.Path.GetFileName(asset.Path);
            var target = System.IO.Path.Combine(Zilux2.Wallpaper.WallpaperFolders.Library, fileName);
            var stem = System.IO.Path.GetFileNameWithoutExtension(fileName);
            var extension = System.IO.Path.GetExtension(fileName);
            var counter = 1;
            while (System.IO.File.Exists(target) &&
                   !string.Equals(target, asset.Path, StringComparison.OrdinalIgnoreCase))
            {
                target = System.IO.Path.Combine(Zilux2.Wallpaper.WallpaperFolders.Library, $"{stem} ({counter++}){extension}");
            }

            if (!string.Equals(target, asset.Path, StringComparison.OrdinalIgnoreCase))
            {
                System.IO.File.Copy(asset.Path, target, overwrite: false);
            }

            asset.Path = target;
            asset.Source = Zilux2.Wallpaper.Model.AssetSource.Import;
            asset.Missing = false;
            host.Store.Save(asset);
            host.NotifyAssetChanged(id);

            WriteWallpaperJson(context, 200, new JsonObject
            {
                ["ok"] = true,
                ["path"] = target,
                ["source"] = SourceKey(asset.Source),
            });
            return 200;
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[wallpaper] localize failed id={id}: {exception.Message}");
            return WriteError(context, 500, "internal-error", "转本地副本失败");
        }
    }

    private int DeleteWallpaperAsset(HttpListenerContext context, WallpaperHost host, string rawId)
    {
        if (!TryParseId(rawId, out var id))
        {
            return WriteError(context, 400, "bad-request", "素材 ID 无效");
        }

        if (host.Store.FindById(id) is null)
        {
            return WriteError(context, 404, "not-found", "没有这条素材");
        }

        // 只删库里的记录：导入副本留在磁盘上，用户想清理走「存储」页（第 87 轮）。
        host.Store.Delete(id);
        host.RefreshAfterLibraryChange();
        WriteWallpaperJson(context, 200, new JsonObject { ["ok"] = true, ["id"] = id });
        return 200;
    }

    private async Task<int> ScanWallpaperLibraryAsync(HttpListenerContext context, WallpaperHost host)
    {
        var body = await ReadWallpaperBodyAsync(context).ConfigureAwait(false);
        var full = body is not null && IsTruthy(body["full"]?.GetValue<string>());
        var result = host.ScanOnce(full);
        WriteWallpaperJson(context, 200, new JsonObject
        {
            ["ok"] = true,
            ["added"] = result.Added,
            ["updated"] = result.Updated,
            ["missing"] = result.Missing,
            ["skipped"] = result.Skipped,
        });
        return 200;
    }

    private async Task<int> ImportWallpaperAsync(HttpListenerContext context, WallpaperHost host)
    {
        var body = await ReadWallpaperBodyAsync(context).ConfigureAwait(false);
        if (body is null || body["paths"] is not JsonArray pathArray)
        {
            return WriteError(context, 400, "bad-request", "缺少 paths");
        }

        var paths = new List<string>();
        foreach (var node in pathArray)
        {
            if (node is not JsonNode item || item.GetValueKind() != System.Text.Json.JsonValueKind.String)
            {
                continue;
            }

            var path = (item.GetValue<string>() ?? string.Empty).Trim();
            if (path.Length > 0 && path.Length <= 1024)
            {
                paths.Add(path);
            }

            if (paths.Count >= 500)
            {
                break;
            }
        }

        if (paths.Count == 0)
        {
            return WriteError(context, 400, "bad-request", "paths 为空");
        }

        // copy 是 JSON 布尔，不能走 GetValue<string>()（会抛「An element of type 'True'
        // cannot be converted to a 'System.String'」）；统一交给 IsTruthy 按 kind 判。
        var copy = IsTruthy(body["copy"]);
        var ids = host.Import(paths, copy);
        WriteWallpaperJson(context, 200, new JsonObject
        {
            ["ok"] = true,
            ["added"] = ids.Count,
            ["ids"] = new JsonArray(ids.Select(id => (JsonNode?)JsonValue.Create(id)).ToArray()),
        });
        return 200;
    }

    private static JsonArray WallpaperTagsOf(LibraryStore store, long assetId)
    {
        var array = new JsonArray();
        foreach (var tag in store.TagsOf(assetId))
        {
            array.Add(tag);
        }

        return array;
    }

    private int WriteWallpaperTags(HttpListenerContext context, LibraryStore store)
    {
        WriteWallpaperJson(context, 200, WallpaperTagsJson(store));
        return 200;
    }

    private static JsonObject WallpaperTagsJson(LibraryStore store)
    {
        var array = new JsonArray();
        foreach (var (id, name, count) in store.ListTags())
        {
            array.Add(new JsonObject { ["id"] = id, ["name"] = name, ["count"] = count });
        }

        return new JsonObject { ["ok"] = true, ["tags"] = array };
    }

    private static JsonObject WallpaperCollectionsJson(LibraryStore store)
    {
        var array = new JsonArray();
        foreach (var collection in store.ListCollections())
        {
            array.Add(new JsonObject
            {
                ["id"] = collection.Id,
                ["name"] = collection.Name,
                ["builtin"] = collection.Builtin,
                ["count"] = collection.Count,
            });
        }

        return new JsonObject { ["ok"] = true, ["collections"] = array };
    }

    /* ------------------------------------------------------------------ 画布 */

    private async Task<int> ApplyWallpaperCanvasAsync(HttpListenerContext context, WallpaperHost host, string rawKind)
    {
        if (!TryParseCanvasKind(rawKind, out var kind))
        {
            return WriteError(context, 400, "bad-request", "画布类型无效");
        }

        var body = await ReadWallpaperBodyAsync(context).ConfigureAwait(false);
        if (body is null || !TryReadLong(body["assetId"], out var assetId) || assetId <= 0)
        {
            return WriteError(context, 400, "bad-request", "缺少 assetId");
        }

        var asset = host.Store.FindById(assetId);
        if (asset is null)
        {
            return WriteError(context, 404, "not-found", "没有这条素材");
        }

        if (asset.Missing || !File.Exists(asset.Path))
        {
            return WriteError(context, 409, "asset-missing", "素材文件已失联");
        }

        if (kind == CanvasKind.Desktop)
        {
            if (!host.AttachDesktop())
            {
                return WriteError(context, 503, "desktop-unavailable", "桌面层挂不上（找不到 WorkerW）");
            }

            host.ApplyToDesktop(asset);
        }
        else
        {
            host.ApplyToInApp(asset);
        }

        var snapshot = host.Snapshot();
        WriteWallpaperJson(context, 200, new JsonObject
        {
            ["ok"] = true,
            ["canvas"] = CanvasNode(kind == CanvasKind.Desktop ? snapshot.Desktop : snapshot.InApp),
        });
        return 200;
    }

    /// <summary>每块屏的画布状态（第 88 轮多屏画面管理）。</summary>
    private int WriteWallpaperMonitors(HttpListenerContext context, WallpaperHost host)
    {
        var array = new JsonArray();
        foreach (var monitor in host.Monitors())
        {
            array.Add(new JsonObject
            {
                ["key"] = monitor.Key,
                ["index"] = monitor.Index,
                ["x"] = monitor.X,
                ["y"] = monitor.Y,
                ["w"] = monitor.Width,
                ["h"] = monitor.Height,
                ["primary"] = monitor.Primary,
                ["assetId"] = monitor.AssetId,
                ["fps"] = monitor.Fps,
                ["maxFps"] = monitor.MaxFps,
                ["follow"] = monitor.Follow,
                ["attached"] = monitor.Attached,
                ["title"] = monitor.Title,
                ["coverPath"] = monitor.CoverPath,
            });
        }

        WriteWallpaperJson(context, 200, new JsonObject { ["ok"] = true, ["items"] = array });
        return 200;
    }

    /// <summary>
    /// 改一块屏：follow=true → 跟全局走（canvases.asset_id 写空）；
    /// follow=false → 只写这块屏那一行（assetId + fps）。
    /// 写完由宿主原地换片（WallpaperRuntime.UpdateDesktopVideos），不重建表面。
    /// </summary>
    private async Task<int> SaveWallpaperMonitorAsync(HttpListenerContext context, WallpaperHost host)
    {
        var body = await ReadWallpaperBodyAsync(context).ConfigureAwait(false);
        if (body is null)
        {
            return WriteError(context, 400, "bad-request", "请求体无效");
        }

        var key = body["key"] is JsonValue keyValue && keyValue.TryGetValue<string>(out var rawKey)
            ? rawKey.Trim()
            : string.Empty;
        if (key.Length == 0)
        {
            return WriteError(context, 400, "bad-request", "缺少显示器 key");
        }

        // 网页那边可能发真布尔，也可能发 "true"，两种都认。
        var follow = IsTruthy(body["follow"]);

        long? assetId = null;
        if (!follow && TryReadLong(body["assetId"], out var parsedAsset) && parsedAsset > 0)
        {
            assetId = parsedAsset;
        }

        int? fps = null;
        if (TryReadLong(body["fps"], out var parsedFps))
        {
            fps = MonitorCatalog.Normalize((int)Math.Clamp(parsedFps, 0, 240));
        }

        if (!host.SaveMonitor(key, assetId, fps, follow, out var error))
        {
            return WriteError(context, 400, "bad-request", error ?? "保存失败");
        }

        WriteWallpaperJson(context, 200, new JsonObject { ["ok"] = true });
        return 200;
    }

    private int WriteWallpaperCanvasSettings(HttpListenerContext context, WallpaperHost host, string rawKind)
    {
        if (!TryParseCanvasKind(rawKind, out var kind))
        {
            return WriteError(context, 400, "bad-request", "画布类型无效");
        }

        var monitor = context.Request.QueryString["monitor"];
        var snapshot = host.CanvasSettingsOf(kind, monitor, out var error);
        if (snapshot is null)
        {
            return WriteError(context, 400, "bad-request", error ?? "没有这块屏");
        }

        WriteWallpaperJson(context, 200, CanvasSettingsJson(snapshot));
        return 200;
    }

    private async Task<int> SaveWallpaperCanvasSettingsAsync(HttpListenerContext context, WallpaperHost host, string rawKind)
    {
        if (!TryParseCanvasKind(rawKind, out var kind))
        {
            return WriteError(context, 400, "bad-request", "画布类型无效");
        }

        var body = await ReadWallpaperBodyAsync(context).ConfigureAwait(false);
        if (body is not JsonObject patch)
        {
            return WriteError(context, 400, "bad-request", "请求体无效");
        }

        var monitor = patch["monitor"] is JsonValue monitorValue && monitorValue.TryGetValue<string>(out var rawMonitor)
            ? rawMonitor.Trim()
            : context.Request.QueryString["monitor"];
        if (kind == CanvasKind.Desktop && string.IsNullOrWhiteSpace(monitor))
        {
            return WriteError(context, 400, "bad-request", "缺少显示器 key");
        }

        if (!host.SaveCanvasSettings(kind, monitor, patch, out var error))
        {
            return WriteError(context, 400, "bad-request", error ?? "保存失败");
        }

        var snapshot = host.CanvasSettingsOf(kind, monitor, out _);
        if (snapshot is null)
        {
            WriteWallpaperJson(context, 200, new JsonObject { ["ok"] = true });
            return 200;
        }

        WriteWallpaperJson(context, 200, CanvasSettingsJson(snapshot));
        return 200;
    }

    private static JsonObject CanvasSettingsJson(WallpaperHost.CanvasSettingsSnapshot snapshot) => new()
    {
        ["ok"] = true,
        ["kind"] = snapshot.Kind,
        ["monitor"] = snapshot.Monitor,
        ["follow"] = snapshot.Follow,
        ["assetId"] = snapshot.AssetId,
        ["fps"] = snapshot.Fps,
        ["maxFps"] = snapshot.MaxFps,
        ["picture"] = new JsonObject
        {
            ["mirrorH"] = snapshot.Picture.MirrorH,
            ["mirrorV"] = snapshot.Picture.MirrorV,
            ["rotation"] = snapshot.Picture.Rotation,
            ["cropLeft"] = snapshot.Picture.CropLeft,
            ["cropTop"] = snapshot.Picture.CropTop,
            ["cropRight"] = snapshot.Picture.CropRight,
            ["cropBottom"] = snapshot.Picture.CropBottom,
            ["zoom"] = snapshot.Picture.Zoom,
            ["blur"] = snapshot.Picture.Blur,
        },
    };

    private async Task<int> PauseWallpaperCanvasAsync(HttpListenerContext context, WallpaperHost host, string rawKind)    {
        if (!TryParseCanvasKind(rawKind, out var kind))
        {
            return WriteError(context, 400, "bad-request", "画布类型无效");
        }

        var body = await ReadWallpaperBodyAsync(context).ConfigureAwait(false);
        // 网页那边可能发真布尔，也可能发 "true"，两种都认。
        var paused = false;
        if (body?["paused"] is { } pausedNode)
        {
            paused = pausedNode.GetValueKind() switch
            {
                System.Text.Json.JsonValueKind.True => true,
                System.Text.Json.JsonValueKind.False => false,
                System.Text.Json.JsonValueKind.String => IsTruthy(pausedNode.GetValue<string>()),
                _ => false,
            };
        }
        host.Pause(kind, paused);
        var snapshot = host.Snapshot();
        WriteWallpaperJson(context, 200, new JsonObject
        {
            ["ok"] = true,
            ["canvas"] = CanvasNode(kind == CanvasKind.Desktop ? snapshot.Desktop : snapshot.InApp),
        });
        return 200;
    }

    private int NextWallpaperCanvas(HttpListenerContext context, WallpaperHost host, string rawKind)
    {
        if (!TryParseCanvasKind(rawKind, out var kind))
        {
            return WriteError(context, 400, "bad-request", "画布类型无效");
        }

        host.Next(kind);
        var snapshot = host.Snapshot();
        WriteWallpaperJson(context, 200, new JsonObject
        {
            ["ok"] = true,
            ["canvas"] = CanvasNode(kind == CanvasKind.Desktop ? snapshot.Desktop : snapshot.InApp),
        });
        return 200;
    }

    /* ------------------------------------------------------------------ 选项 */

    private static JsonObject WallpaperOptionsJson(WallpaperSettings options) => new()
    {
        ["ok"] = true,
        ["options"] = new JsonObject
        {
            ["enabled"] = options.Enabled,
            ["inAppEnabled"] = options.InAppEnabled,
            ["desktopEnabled"] = options.DesktopEnabled,
            ["audioEnabled"] = options.AudioEnabled,
            ["audioVolume"] = options.AudioVolume,
            ["audioFollowSystem"] = options.AudioFollowSystem,
            ["musicDuckMs"] = options.MusicDuckMs,
            ["musicRestoreMs"] = options.MusicRestoreMs,
            ["occludeThreshold"] = options.OccludeThreshold,
            ["closeToTray"] = options.CloseToTray,
            ["autoLaunch"] = options.AutoLaunch,
            // 页面显示壁纸的四个开关：前端 pageAllowsWallpaper() 按当前页面类型取用。
            ["pageNormal"] = options.PageNormal,
            ["pageImmersive"] = options.PageImmersive,
            ["pageRoom"] = options.PageRoom,
            ["pageLogin"] = options.PageLogin,
            ["transitionMode"] = options.TransitionMode,
            ["transitionMs"] = options.TransitionMs,
            ["rotationEnabled"] = options.RotationEnabled,
            ["rotationMinutes"] = options.RotationMinutes,
            ["rotationOrder"] = options.RotationOrder,
            ["rotationFavoriteFirst"] = options.RotationFavoriteFirst,
            ["prewarm"] = options.Prewarm,
            ["frameRateLimit"] = options.FrameRateLimit,
            ["renderScale"] = options.RenderScale,
            ["hardwareDecode"] = options.HardwareDecode,
            ["downsampleAbove"] = options.DownsampleAbove,
            ["concurrentDecode"] = options.ConcurrentDecode,
            ["pauseOnMinimize"] = options.PauseOnMinimize,
            ["idleFpsAfterSec"] = options.IdleFpsAfterSec,
            ["idleFps"] = options.IdleFps,
            ["pauseOnBattery"] = options.PauseOnBattery,
            ["pauseOnFullscreen"] = options.PauseOnFullscreen,
            ["adaptiveQuality"] = options.AdaptiveQuality,
            ["reduceMotion"] = options.ReduceMotion,
            ["parallax"] = options.Parallax,
            ["overlayEnabled"] = options.OverlayEnabled,
            ["appearanceLink"] = options.AppearanceLink,
            ["beatLock"] = options.BeatLock,
            ["overlayTemplate"] = options.OverlayTemplate,
            ["dimMode"] = options.DimMode,
            ["dimBase"] = options.DimBase,
            ["dimMax"] = options.DimMax,
            ["dimEmaMs"] = options.DimEmaMs,
            ["brightness"] = options.Brightness,
            ["contrast"] = options.Contrast,
            ["saturation"] = options.Saturation,
            ["blur"] = options.Blur,
            ["accentFromFrame"] = options.AccentFromFrame,
            ["fitMode"] = options.FitMode,
            ["desktopSound"] = options.DesktopSound,
            ["edgeBarEnabled"] = options.EdgeBarEnabled,
            ["edgeBarDelayMs"] = options.EdgeBarDelayMs,
            ["visualizerEnabled"] = options.VisualizerEnabled,
            ["visualizerStyle"] = options.VisualizerStyle,
            ["beatStrength"] = options.BeatStrength,
            ["gridDensity"] = options.GridDensity,
            ["thumbConcurrency"] = options.ThumbConcurrency,
            ["cacheKeepDays"] = options.CacheKeepDays,
        },
    };

    private async Task<int> PatchWallpaperOptionsAsync(HttpListenerContext context, SettingsService settings)
    {
        var body = await ReadWallpaperBodyAsync(context).ConfigureAwait(false);
        if (body is null)
        {
            return WriteError(context, 400, "bad-request", "请求体无效");
        }

        settings.UpdateWallpaper(options => WallpaperOptionsPatch.Apply(options, body));
        WriteWallpaperJson(context, 200, WallpaperOptionsJson(settings.WallpaperSnapshot));
        return 200;
    }

    /* ------------------------------------------------------------------ 存储 / 诊断 */

    private static JsonObject WallpaperStorageJson(WallpaperHost host)
    {
        var (count, totalBytes, favorites) = host.Store.Stats();
        var covers = CountFiles(WallpaperFolders.Covers);
        return new JsonObject
        {
            ["ok"] = true,
            ["libraryCount"] = count,
            ["favorites"] = favorites,
            ["mediaBytes"] = totalBytes,
            ["coverCount"] = covers.Count,
            ["coverBytes"] = covers.Bytes,
            ["root"] = WallpaperFolders.Root,
        };
    }

    private static (int Count, long Bytes) CountFiles(string directory)
    {
        try
        {
            if (!Directory.Exists(directory))
            {
                return (0, 0);
            }

            var count = 0;
            long bytes = 0;
            foreach (var file in Directory.EnumerateFiles(directory))
            {
                count++;
                try
                {
                    bytes += new FileInfo(file).Length;
                }
                catch (IOException)
                {
                    // 文件被占用时跳过它的大小，不要因为一张封面让统计失败。
                }
            }

            return (count, bytes);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return (0, 0);
        }
    }

    private int CleanWallpaperStorage(HttpListenerContext context, WallpaperHost host)
    {
        var removed = 0;
        long freed = 0;
        try
        {
            foreach (var file in Directory.EnumerateFiles(WallpaperFolders.Covers))
            {
                try
                {
                    var size = new FileInfo(file).Length;
                    File.Delete(file);
                    removed++;
                    freed += size;
                }
                catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
                {
                    // 单张删不掉就跳过，下一轮清理还会再扫到。
                }
            }
        }
        catch (DirectoryNotFoundException)
        {
            // 目录还没建过，等于已经清理干净。
        }

        WriteWallpaperJson(context, 200, new JsonObject
        {
            ["ok"] = true,
            ["removed"] = removed,
            ["freedBytes"] = freed,
        });
        return 200;
    }

    private static JsonObject WallpaperDiagnosticsJson(WallpaperHost host, SettingsService? settings)
    {
        var snapshot = host.Snapshot();
        var (count, totalBytes, favorites) = host.Store.Stats();
        var options = settings?.WallpaperSnapshot;
        return new JsonObject
        {
            ["ok"] = true,
            ["ffmpegAvailable"] = snapshot.FfmpegAvailable,
            ["ffmpegPath"] = snapshot.FfmpegPath,
            ["libraryCount"] = count,
            ["libraryBytes"] = totalBytes,
            ["favorites"] = favorites,
            ["frameRateLimit"] = options?.FrameRateLimit,
            ["renderScale"] = options?.RenderScale,
            ["hardwareDecode"] = options?.HardwareDecode,
            ["renderTier"] = WallpaperHost.RenderTier,
            ["decodeWidth"] = host.DecodeSize.Width,
            ["decodeHeight"] = host.DecodeSize.Height,
            ["decodeFps"] = host.DecodeSize.Fps,
            ["inApp"] = CanvasNode(snapshot.InApp),
            ["desktop"] = CanvasNode(snapshot.Desktop),
        };
    }

    /* ------------------------------------------------------------------ 预览文件 */

    /// <summary>封面字节（页面的 &lt;img&gt; 直接引用，不走 file://）。</summary>
    private int WriteWallpaperCover(HttpListenerContext context, WallpaperHost host, string rawId)
    {
        if (!TryParseId(rawId, out var id))
        {
            return WriteError(context, 400, "bad-request", "素材 ID 无效");
        }

        var asset = host.Store.FindById(id);
        var cover = asset?.CoverPath;
        if (cover is null || !File.Exists(cover))
        {
            return WriteError(context, 404, "not-found", "还没有封面");
        }

        try
        {
            var bytes = File.ReadAllBytes(cover);
            WriteBinary(context, 200, bytes, CoverContentType(cover));
            return 200;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return WriteError(context, 500, "io-failed", "封面读取失败");
        }
    }

    private static string CoverContentType(string path) => Path.GetExtension(path).ToLowerInvariant() switch
    {
        ".png" => "image/png",
        ".webp" => "image/webp",
        ".gif" => "image/gif",
        _ => "image/jpeg",
    };

    /// <summary>
    /// 原文件流（视频/图片/GIF），支持 Range 以便页面 &lt;video&gt; 拖动与悬停预览。
    /// 只读打开，不锁文件，也不改文件内容。
    /// </summary>
    private async Task<int> WriteWallpaperMediaAsync(HttpListenerContext context, WallpaperHost host, string rawId)
    {
        if (!TryParseId(rawId, out var id))
        {
            return WriteError(context, 400, "bad-request", "素材 ID 无效");
        }

        var asset = host.Store.FindById(id);
        if (asset is null || !File.Exists(asset.Path))
        {
            return WriteError(context, 404, "not-found", "素材文件不存在");
        }

        FileStream stream;
        try
        {
            stream = new FileStream(asset.Path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite, 64 * 1024, useAsync: true);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return WriteError(context, 500, "io-failed", "素材读取失败");
        }

        await using (stream.ConfigureAwait(false))
        {
            var response = context.Response;
            ApplyCors(context);
            response.ContentType = MediaContentType(asset.Path);
            response.Headers["Accept-Ranges"] = "bytes";
            response.Headers["Cache-Control"] = "private, max-age=600";

            var length = stream.Length;
            var range = context.Request.Headers["Range"];
            var start = 0L;
            var end = length - 1;
            var partial = false;
            if (!string.IsNullOrEmpty(range) && range.StartsWith("bytes=", StringComparison.OrdinalIgnoreCase))
            {
                var spec = range["bytes=".Length..].Split(',')[0];
                var dash = spec.IndexOf('-');
                if (dash >= 0)
                {
                    var head = spec[..dash].Trim();
                    var tail = spec[(dash + 1)..].Trim();
                    if (head.Length == 0 && long.TryParse(tail, out var suffix) && suffix > 0)
                    {
                        start = Math.Max(0, length - suffix);
                    }
                    else if (long.TryParse(head, out var from))
                    {
                        start = Math.Clamp(from, 0, Math.Max(0, length - 1));
                        if (tail.Length > 0 && long.TryParse(tail, out var to))
                        {
                            end = Math.Clamp(to, start, length - 1);
                        }
                    }

                    partial = true;
                }
            }

            var count = end - start + 1;
            response.StatusCode = partial ? 206 : 200;
            if (partial)
            {
                response.Headers["Content-Range"] = $"bytes {start}-{end}/{length}";
            }

            response.ContentLength64 = count;
            stream.Seek(start, SeekOrigin.Begin);
            var buffer = new byte[64 * 1024];
            var remaining = count;
            while (remaining > 0)
            {
                var want = (int)Math.Min(buffer.Length, remaining);
                var read = await stream.ReadAsync(buffer.AsMemory(0, want), _shutdown.Token).ConfigureAwait(false);
                if (read <= 0)
                {
                    break;
                }

                await response.OutputStream.WriteAsync(buffer.AsMemory(0, read), _shutdown.Token).ConfigureAwait(false);
                remaining -= read;
            }

            return response.StatusCode;
        }
    }

    private static string MediaContentType(string path) => Path.GetExtension(path).ToLowerInvariant() switch
    {
        ".mp4" or ".m4v" => "video/mp4",
        ".webm" => "video/webm",
        ".mkv" => "video/x-matroska",
        ".mov" => "video/quicktime",
        ".avi" => "video/x-msvideo",
        ".gif" => "image/gif",
        ".png" => "image/png",
        ".webp" => "image/webp",
        ".jpg" or ".jpeg" => "image/jpeg",
        _ => "application/octet-stream",
    };

    /* ------------------------------------------------------------------ 工具 */

    private static async Task<JsonObject?> ReadWallpaperBodyAsync(HttpListenerContext context)
    {
        var text = await ReadBodyAsync(context.Request, MaxWallpaperBodyBytes).ConfigureAwait(false);
        if (string.IsNullOrWhiteSpace(text))
        {
            return null;
        }

        try
        {
            return JsonNode.Parse(text) as JsonObject;
        }
        catch (System.Text.Json.JsonException)
        {
            return null;
        }
    }

    private static void WriteWallpaperJson(HttpListenerContext context, int status, JsonNode payload) =>
        WriteJson(context, status, payload.ToJsonString());

    private static string? Trimmed(string? value)
    {
        var text = value?.Trim();
        return string.IsNullOrEmpty(text) ? null : text;
    }

    /// <summary>JSON 里的布尔/字符串/数字都能当开关读（前端有时传 1 / "true"）。</summary>
    private static bool IsTruthy(JsonNode? node)
    {
        if (node is null) return false;
        return node.GetValueKind() switch
        {
            System.Text.Json.JsonValueKind.True => true,
            System.Text.Json.JsonValueKind.False => false,
            System.Text.Json.JsonValueKind.String => IsTruthy(node.GetValue<string>()),
            System.Text.Json.JsonValueKind.Number => node.GetValue<double>() != 0,
            _ => false,
        };
    }

    private static bool IsTruthy(string? value) =>
        value is not null && (value == "1" || value.Equals("true", StringComparison.OrdinalIgnoreCase));

    private static int ParseInt(string? value, int fallback) =>
        int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed) ? parsed : fallback;

    private static bool TryParseId(string raw, out long id) =>
        long.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out id) && id > 0;

    /// <summary>裁剪百分比：0–45，越界值忽略（保留旧值）。</summary>
    /// <summary>缩放：1–3 倍，两位小数。</summary>
    private static double ReadZoom(JsonNode? node, double fallback)
    {
        if (node is null || node.GetValueKind() != System.Text.Json.JsonValueKind.Number) return fallback;
        var value = node.GetValue<double>();
        return value is >= 1 and <= 3 ? Math.Round(value, 2) : fallback;
    }

    /// <summary>模糊半径：0–24px，一位小数。</summary>
    private static double ReadBlur(JsonNode? node, double fallback)
    {
        if (node is null || node.GetValueKind() != System.Text.Json.JsonValueKind.Number) return fallback;
        var value = node.GetValue<double>();
        return value is >= 0 and <= 24 ? Math.Round(value, 1) : fallback;
    }

    private static double ReadCrop(JsonNode? node, double fallback)
    {
        if (node is null || node.GetValueKind() != System.Text.Json.JsonValueKind.Number) return fallback;
        var value = node.GetValue<double>();
        return value is >= 0 and <= 45 ? Math.Round(value, 1) : fallback;
    }

    private static bool TryReadLong(JsonNode? node, out long value)
    {
        value = 0;
        if (node is null || node.GetValueKind() != System.Text.Json.JsonValueKind.Number)
        {
            return false;
        }

        value = node.GetValue<long>();
        return true;
    }

    private static bool TryParseCanvasKind(string raw, out CanvasKind kind)
    {
        switch (raw)
        {
            case "inapp":
                kind = CanvasKind.InApp;
                return true;
            case "desktop":
                kind = CanvasKind.Desktop;
                return true;
            default:
                kind = CanvasKind.InApp;
                return false;
        }
    }

    private static AssetKind? ParseKind(string? raw) => raw switch
    {
        "video" => AssetKind.Video,
        "image" => AssetKind.Image,
        "gif" => AssetKind.Gif,
        _ => null,
    };

    private static AssetSource? ParseSource(string? raw) => raw switch
    {
        "import" => AssetSource.Import,
        "watch" => AssetSource.Watch,
        "workshop" => AssetSource.Workshop,
        _ => null,
    };

    private static string KindKey(AssetKind kind) => kind switch
    {
        AssetKind.Image => "image",
        AssetKind.Gif => "gif",
        _ => "video",
    };

    private static string SourceKey(AssetSource source) => source switch
    {
        AssetSource.Watch => "watch",
        AssetSource.Workshop => "workshop",
        _ => "import",
    };
}
