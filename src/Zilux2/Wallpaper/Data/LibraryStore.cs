using System.Text.Json;
using Microsoft.Data.Sqlite;
using Zilux2.Wallpaper.Model;

namespace Zilux2.Wallpaper.Data;

/// <summary>素材查询条件（库页筛选栏，第 103 轮）。</summary>
internal sealed class AssetQuery
{
    /// <summary>标题/路径模糊匹配。</summary>
    public string? Search { get; set; }

    public AssetKind? Kind { get; set; }

    public AssetSource? Source { get; set; }

    /// <summary>合辑过滤；内置 'favorites' 走收藏表。</summary>
    public long? CollectionId { get; set; }

    public long? TagId { get; set; }

    public bool FavoritesOnly { get; set; }

    /// <summary>'4k' | '1080' | '720'，按短边判档。</summary>
    public string? ResolutionBucket { get; set; }

    /// <summary>'short'(&lt;10s) | 'medium'(10–30s) | 'long'(&gt;30s)。</summary>
    public string? DurationBucket { get; set; }

    /// <summary>'small'(&lt;20MB) | 'medium'(20–200MB) | 'large'(&gt;200MB)。</summary>
    public string? SizeBucket { get; set; }

    /// <summary>'added_desc' | 'added_asc' | 'title' | 'duration' | 'size' | 'random'。</summary>
    public string Sort { get; set; } = "added_desc";

    public int Offset { get; set; }

    public int Limit { get; set; } = 200;
}

/// <summary>
/// 素材库的读写门面。所有 SQL 只出现在这里，上层看到的是模型对象。
/// </summary>
internal sealed partial class LibraryStore
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly WallpaperDb _db;

    public LibraryStore(WallpaperDb db)
    {
        _db = db;
    }

    /* ---------------------------------------------------------------- 素材 */

    /// <summary>按哈希查已有素材，用于导入前查重（第 36 轮）。</summary>
    public WallpaperAsset? FindByHash(string hash)
    {
        return _db.Read(connection =>
        {
            using var command = connection.CreateCommand();
            command.CommandText = SelectAssets + " WHERE a.hash = $hash;";
            command.Parameters.AddWithValue("$hash", hash);
            using var reader = command.ExecuteReader();
            return reader.Read() ? ReadAsset(reader) : null;
        });
    }

    public WallpaperAsset? FindById(long id)
    {
        return _db.Read(connection =>
        {
            using var command = connection.CreateCommand();
            command.CommandText = SelectAssets + " WHERE a.id = $id;";
            command.Parameters.AddWithValue("$id", id);
            using var reader = command.ExecuteReader();
            return reader.Read() ? ReadAsset(reader) : null;
        });
    }

    /// <summary>按路径查（监控目录重复扫描时避免重复插入）。</summary>
    public WallpaperAsset? FindByPath(string path)
    {
        return _db.Read(connection =>
        {
            using var command = connection.CreateCommand();
            command.CommandText = SelectAssets + " WHERE a.path = $path;";
            command.Parameters.AddWithValue("$path", path);
            using var reader = command.ExecuteReader();
            return reader.Read() ? ReadAsset(reader) : null;
        });
    }

    /// <summary>插入或更新一条素材，返回主键。</summary>
    public long Save(WallpaperAsset asset)
    {
        return _db.Write(connection =>
        {
            using var command = connection.CreateCommand();
            if (asset.Id > 0)
            {
                command.CommandText = """
                    UPDATE assets SET
                      hash=$hash, path=$path, source=$source, kind=$kind,
                      width=$width, height=$height, duration_ms=$duration, fps=$fps, size_bytes=$size,
                      cover_path=$cover, cover_time_ms=$coverTime,
                      trim_in_ms=$trimIn, trim_out_ms=$trimOut, speed=$speed,
                      transform_json=$transform, fit_override=$fit, missing=$missing,
                      title=$title, added_at=$added, last_seen_at=$seen
                    WHERE id=$id;
                    SELECT $id;
                    """;
                command.Parameters.AddWithValue("$id", asset.Id);
            }
            else
            {
                command.CommandText = """
                    INSERT INTO assets
                      (hash, path, source, kind, width, height, duration_ms, fps, size_bytes,
                       cover_path, cover_time_ms, trim_in_ms, trim_out_ms, speed, transform_json,
                       fit_override, missing, title, added_at, last_seen_at)
                    VALUES
                      ($hash, $path, $source, $kind, $width, $height, $duration, $fps, $size,
                       $cover, $coverTime, $trimIn, $trimOut, $speed, $transform,
                       $fit, $missing, $title, $added, $seen)
                    RETURNING id;
                    """;
            }

            command.Parameters.AddWithValue("$hash", asset.Hash);
            command.Parameters.AddWithValue("$path", asset.Path);
            command.Parameters.AddWithValue("$source", asset.Source.ToString().ToLowerInvariant());
            command.Parameters.AddWithValue("$kind", asset.Kind.ToString().ToLowerInvariant());
            command.Parameters.AddWithValue("$width", (object?)asset.Width ?? DBNull.Value);
            command.Parameters.AddWithValue("$height", (object?)asset.Height ?? DBNull.Value);
            command.Parameters.AddWithValue("$duration", (object?)asset.DurationMs ?? DBNull.Value);
            command.Parameters.AddWithValue("$fps", (object?)asset.Fps ?? DBNull.Value);
            command.Parameters.AddWithValue("$size", (object?)asset.SizeBytes ?? DBNull.Value);
            command.Parameters.AddWithValue("$cover", (object?)asset.CoverPath ?? DBNull.Value);
            command.Parameters.AddWithValue("$coverTime", (object?)asset.CoverTimeMs ?? DBNull.Value);
            command.Parameters.AddWithValue("$trimIn", (object?)asset.TrimInMs ?? DBNull.Value);
            command.Parameters.AddWithValue("$trimOut", (object?)asset.TrimOutMs ?? DBNull.Value);
            command.Parameters.AddWithValue("$speed", asset.Speed);
            command.Parameters.AddWithValue("$transform", JsonSerializer.Serialize(asset.Transform, JsonOptions));
            command.Parameters.AddWithValue("$fit", (object?)asset.FitOverride ?? DBNull.Value);
            command.Parameters.AddWithValue("$missing", asset.Missing ? 1 : 0);
            command.Parameters.AddWithValue("$title", asset.Title);
            command.Parameters.AddWithValue("$added", asset.AddedAt);
            command.Parameters.AddWithValue("$seen", (object?)asset.LastSeenAt ?? DBNull.Value);

            var id = Convert.ToInt64(command.ExecuteScalar() ?? 0L);
            asset.Id = id;
            return id;
        });
    }

    /// <summary>列表 + 总数（虚拟滚动要总数，第 36 轮）。</summary>
    public (List<WallpaperAsset> Items, int Total) List(AssetQuery query)
    {
        return _db.Read(connection =>
        {
            var (where, parameters) = BuildFilter(query);

            var total = 0;
            using (var countCommand = connection.CreateCommand())
            {
                countCommand.CommandText = $"SELECT COUNT(*) FROM assets a{where};";
                foreach (var (name, value) in parameters) countCommand.Parameters.AddWithValue(name, value);
                total = Convert.ToInt32(countCommand.ExecuteScalar() ?? 0);
            }

            var items = new List<WallpaperAsset>();
            using (var command = connection.CreateCommand())
            {
                var order = query.Sort switch
                {
                    "added_asc" => "a.added_at ASC",
                    "title" => "a.title COLLATE NOCASE ASC, a.id ASC",
                    "duration" => "IFNULL(a.duration_ms,0) DESC, a.id DESC",
                    "size" => "IFNULL(a.size_bytes,0) DESC, a.id DESC",
                    "random" => "RANDOM()",
                    _ => "a.added_at DESC, a.id DESC",
                };
                command.CommandText = $"{SelectAssets}{where} ORDER BY {order} LIMIT $limit OFFSET $offset;";
                foreach (var (name, value) in parameters) command.Parameters.AddWithValue(name, value);
                command.Parameters.AddWithValue("$limit", Math.Clamp(query.Limit, 1, 2000));
                command.Parameters.AddWithValue("$offset", Math.Max(0, query.Offset));
                using var reader = command.ExecuteReader();
                while (reader.Read()) items.Add(ReadAsset(reader));
            }

            return (items, total);
        });
    }

    /// <summary>轮换候选：按画布所用合辑/收藏挑一批（调度器用）。</summary>
    public List<long> ListRotatableIds(bool favoritesFirst)
    {
        return _db.Read(connection =>
        {
            using var command = connection.CreateCommand();
            command.CommandText = favoritesFirst
                ? "SELECT a.id FROM assets a WHERE a.missing=0 ORDER BY (SELECT 1 FROM favorites f WHERE f.asset_id=a.id) DESC, a.added_at DESC;"
                : "SELECT a.id FROM assets a WHERE a.missing=0 ORDER BY a.added_at DESC;";
            var ids = new List<long>();
            using var reader = command.ExecuteReader();
            while (reader.Read()) ids.Add(reader.GetInt64(0));
            return ids;
        });
    }

    public void Delete(long id)
    {
        _db.Write(connection =>
        {
            using var command = connection.CreateCommand();
            command.CommandText = """
                DELETE FROM asset_tags WHERE asset_id=$id;
                DELETE FROM collection_assets WHERE asset_id=$id;
                DELETE FROM sequence_items WHERE asset_id=$id;
                DELETE FROM favorites WHERE asset_id=$id;
                DELETE FROM assets WHERE id=$id;
                """;
            command.Parameters.AddWithValue("$id", id);
            command.ExecuteNonQuery();
        });
    }

    /// <summary>标记失联/恢复（第 13 轮健康巡检）。</summary>
    public void SetMissing(long id, bool missing)
    {
        _db.Write(connection =>
        {
            using var command = connection.CreateCommand();
            command.CommandText = "UPDATE assets SET missing=$missing, last_seen_at=$seen WHERE id=$id;";
            command.Parameters.AddWithValue("$missing", missing ? 1 : 0);
            command.Parameters.AddWithValue("$seen", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            command.Parameters.AddWithValue("$id", id);
            command.ExecuteNonQuery();
        });
    }

    /// <summary>只改路径（路径修复后回写）。</summary>
    public void UpdatePath(long id, string path)
    {
        _db.Write(connection =>
        {
            using var command = connection.CreateCommand();
            command.CommandText = "UPDATE assets SET path=$path, missing=0 WHERE id=$id;";
            command.Parameters.AddWithValue("$path", path);
            command.Parameters.AddWithValue("$id", id);
            command.ExecuteNonQuery();
        });
    }

    /// <summary>扫描后做失联检查用的轻量清单（只读 id/path/source/missing，不反序列化变换）。</summary>
    public List<(long Id, string Path, AssetSource Source, bool Missing)> ListForScan()
    {
        return _db.Read(connection =>
        {
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT id, path, source, missing FROM assets;";
            var list = new List<(long, string, AssetSource, bool)>();
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                list.Add((
                    reader.GetInt64(0),
                    reader.GetString(1),
                    ParseSource(reader.GetString(2)),
                    reader.GetInt64(3) != 0));
            }

            return list;
        });
    }

    private static (string Where, List<(string Name, object Value)> Parameters) BuildFilter(AssetQuery query)
    {
        var clauses = new List<string>();
        var parameters = new List<(string, object)>();

        if (!string.IsNullOrWhiteSpace(query.Search))
        {
            clauses.Add("(a.title LIKE $q OR a.path LIKE $q)");
            parameters.Add(("$q", $"%{query.Search.Trim()}%"));
        }

        if (query.Kind is { } kind)
        {
            clauses.Add("a.kind = $kind");
            parameters.Add(("$kind", kind.ToString().ToLowerInvariant()));
        }

        if (query.Source is { } source)
        {
            clauses.Add("a.source = $source");
            parameters.Add(("$source", source.ToString().ToLowerInvariant()));
        }

        if (query.CollectionId is { } collectionId)
        {
            clauses.Add("EXISTS (SELECT 1 FROM collection_assets ca WHERE ca.asset_id=a.id AND ca.collection_id=$cid)");
            parameters.Add(("$cid", collectionId));
        }

        if (query.TagId is { } tagId)
        {
            clauses.Add("EXISTS (SELECT 1 FROM asset_tags at WHERE at.asset_id=a.id AND at.tag_id=$tid)");
            parameters.Add(("$tid", tagId));
        }

        if (query.FavoritesOnly)
        {
            clauses.Add("EXISTS (SELECT 1 FROM favorites f WHERE f.asset_id=a.id)");
        }

        switch (query.ResolutionBucket)
        {
            case "4k":
                clauses.Add("MIN(IFNULL(a.width,0), IFNULL(a.height,0)) >= 2000");
                break;
            case "1080":
                clauses.Add("MIN(IFNULL(a.width,0), IFNULL(a.height,0)) >= 1000 AND MIN(IFNULL(a.width,0), IFNULL(a.height,0)) < 2000");
                break;
            case "720":
                clauses.Add("MIN(IFNULL(a.width,0), IFNULL(a.height,0)) < 1000");
                break;
        }

        switch (query.DurationBucket)
        {
            case "short":
                clauses.Add("IFNULL(a.duration_ms,0) < 10000");
                break;
            case "medium":
                clauses.Add("IFNULL(a.duration_ms,0) >= 10000 AND IFNULL(a.duration_ms,0) <= 30000");
                break;
            case "long":
                clauses.Add("IFNULL(a.duration_ms,0) > 30000");
                break;
        }

        switch (query.SizeBucket)
        {
            case "small":
                clauses.Add("IFNULL(a.size_bytes,0) < 20971520");
                break;
            case "medium":
                clauses.Add("IFNULL(a.size_bytes,0) >= 20971520 AND IFNULL(a.size_bytes,0) <= 209715200");
                break;
            case "large":
                clauses.Add("IFNULL(a.size_bytes,0) > 209715200");
                break;
        }

        var where = clauses.Count == 0 ? string.Empty : " WHERE " + string.Join(" AND ", clauses);
        return (where, parameters);
    }

    private const string SelectAssets = """
        SELECT a.id, a.hash, a.path, a.source, a.kind, a.width, a.height, a.duration_ms, a.fps,
               a.size_bytes, a.cover_path, a.cover_time_ms, a.trim_in_ms, a.trim_out_ms, a.speed,
               a.transform_json, a.fit_override, a.missing, a.title, a.added_at, a.last_seen_at
        FROM assets a
        """;

    private static WallpaperAsset ReadAsset(SqliteDataReader reader)
    {
        var asset = new WallpaperAsset
        {
            Id = reader.GetInt64(0),
            Hash = reader.GetString(1),
            Path = reader.GetString(2),
            Source = ParseSource(reader.GetString(3)),
            Kind = ParseKind(reader.GetString(4)),
            Width = reader.IsDBNull(5) ? null : reader.GetInt32(5),
            Height = reader.IsDBNull(6) ? null : reader.GetInt32(6),
            DurationMs = reader.IsDBNull(7) ? null : reader.GetInt64(7),
            Fps = reader.IsDBNull(8) ? null : reader.GetDouble(8),
            SizeBytes = reader.IsDBNull(9) ? null : reader.GetInt64(9),
            CoverPath = reader.IsDBNull(10) ? null : reader.GetString(10),
            CoverTimeMs = reader.IsDBNull(11) ? null : reader.GetInt64(11),
            TrimInMs = reader.IsDBNull(12) ? null : reader.GetInt64(12),
            TrimOutMs = reader.IsDBNull(13) ? null : reader.GetInt64(13),
            Speed = reader.IsDBNull(14) ? 1.0 : reader.GetDouble(14),
            FitOverride = reader.IsDBNull(16) ? null : reader.GetString(16),
            Missing = reader.GetInt32(17) != 0,
            Title = reader.IsDBNull(18) ? string.Empty : reader.GetString(18),
            AddedAt = reader.GetInt64(19),
            LastSeenAt = reader.IsDBNull(20) ? null : reader.GetInt64(20),
        };

        if (!reader.IsDBNull(15))
        {
            try
            {
                asset.Transform = JsonSerializer.Deserialize<WallpaperTransform>(reader.GetString(15), JsonOptions)
                    ?? new WallpaperTransform();
            }
            catch (JsonException)
            {
                asset.Transform = new WallpaperTransform();
            }
        }

        if (string.IsNullOrEmpty(asset.Title)) asset.Title = System.IO.Path.GetFileNameWithoutExtension(asset.Path);
        return asset;
    }

    private static AssetSource ParseSource(string value) => value switch
    {
        "watch" => AssetSource.Watch,
        "workshop" => AssetSource.Workshop,
        _ => AssetSource.Import,
    };

    private static AssetKind ParseKind(string value) => value switch
    {
        "image" => AssetKind.Image,
        "gif" => AssetKind.Gif,
        _ => AssetKind.Video,
    };
}
