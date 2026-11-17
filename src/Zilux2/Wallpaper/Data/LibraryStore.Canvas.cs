using Zilux2.Wallpaper.Model;

namespace Zilux2.Wallpaper.Data;

/// <summary>画布、序列、预设、规则四块（第 25、58、83、85 轮）。</summary>
internal sealed partial class LibraryStore
{
    /* ---------------------------------------------------------------- 画布 */

    /// <summary>取某个画布的状态；没有就返回默认值（不落库，等第一次保存）。</summary>
    public CanvasState GetCanvas(CanvasKind kind, string? monitorId)
    {
        return _db.Read(connection =>
        {
            using var command = connection.CreateCommand();
            command.CommandText = """
                SELECT id, kind, monitor_id, asset_id, sequence_id, fit_mode, filter_json, transition_id, paused, updated_at
                FROM canvases WHERE kind=$kind AND IFNULL(monitor_id,'')=$monitor LIMIT 1;
                """;
            command.Parameters.AddWithValue("$kind", kind == CanvasKind.Desktop ? "desktop" : "inapp");
            command.Parameters.AddWithValue("$monitor", monitorId ?? string.Empty);
            using var reader = command.ExecuteReader();
            if (!reader.Read())
            {
                return new CanvasState { Kind = kind, MonitorId = monitorId };
            }

            return new CanvasState
            {
                Id = reader.GetInt64(0),
                Kind = reader.GetString(1) == "desktop" ? CanvasKind.Desktop : CanvasKind.InApp,
                MonitorId = reader.IsDBNull(2) ? null : reader.GetString(2),
                AssetId = reader.IsDBNull(3) ? null : reader.GetInt64(3),
                SequenceId = reader.IsDBNull(4) ? null : reader.GetInt64(4),
                FitMode = reader.IsDBNull(5) ? null : reader.GetString(5),
                FilterJson = reader.IsDBNull(6) ? null : reader.GetString(6),
                TransitionId = reader.IsDBNull(7) ? null : reader.GetString(7),
                Paused = reader.GetInt32(8) != 0,
                UpdatedAt = reader.IsDBNull(9) ? 0 : reader.GetInt64(9),
            };
        });
    }

    /// <summary>保存画布状态（UPSERT 到唯一键 kind+monitor）。</summary>
    public void SaveCanvas(CanvasState state)
    {
        _db.Write(connection =>
        {
            using var command = connection.CreateCommand();
            command.CommandText = """
                INSERT INTO canvases(kind, monitor_id, asset_id, sequence_id, fit_mode, filter_json, transition_id, paused, updated_at)
                VALUES($kind, $monitor, $asset, $sequence, $fit, $filter, $transition, $paused, $updated)
                ON CONFLICT(kind, IFNULL(monitor_id,'')) DO UPDATE SET
                  asset_id=excluded.asset_id, sequence_id=excluded.sequence_id,
                  fit_mode=excluded.fit_mode, filter_json=excluded.filter_json,
                  transition_id=excluded.transition_id, paused=excluded.paused, updated_at=excluded.updated_at;
                """;
            command.Parameters.AddWithValue("$kind", state.Kind == CanvasKind.Desktop ? "desktop" : "inapp");
            command.Parameters.AddWithValue("$monitor", (object?)state.MonitorId ?? string.Empty);
            command.Parameters.AddWithValue("$asset", (object?)state.AssetId ?? DBNull.Value);
            command.Parameters.AddWithValue("$sequence", (object?)state.SequenceId ?? DBNull.Value);
            command.Parameters.AddWithValue("$fit", (object?)state.FitMode ?? DBNull.Value);
            command.Parameters.AddWithValue("$filter", (object?)state.FilterJson ?? DBNull.Value);
            command.Parameters.AddWithValue("$transition", (object?)state.TransitionId ?? DBNull.Value);
            command.Parameters.AddWithValue("$paused", state.Paused ? 1 : 0);
            command.Parameters.AddWithValue("$updated", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            command.ExecuteNonQuery();
        });
    }

    /* ---------------------------------------------------------------- 序列 */

    public List<WallpaperSequence> ListSequences()
    {
        return _db.Read(connection =>
        {
            var sequences = new List<WallpaperSequence>();
            using (var command = connection.CreateCommand())
            {
                command.CommandText = "SELECT id, name, canvas, loop FROM sequences ORDER BY id ASC;";
                using var reader = command.ExecuteReader();
                while (reader.Read())
                {
                    sequences.Add(new WallpaperSequence
                    {
                        Id = reader.GetInt64(0),
                        Name = reader.GetString(1),
                        Canvas = reader.IsDBNull(2)
                            ? null
                            : reader.GetString(2) == "desktop" ? CanvasKind.Desktop : CanvasKind.InApp,
                        Loop = reader.GetInt32(3) != 0,
                    });
                }
            }

            foreach (var sequence in sequences)
            {
                using var items = connection.CreateCommand();
                items.CommandText = """
                    SELECT id, sequence_id, asset_id, sort, duration_ms, transition_id
                    FROM sequence_items WHERE sequence_id=$id ORDER BY sort ASC, id ASC;
                    """;
                items.Parameters.AddWithValue("$id", sequence.Id);
                using var reader = items.ExecuteReader();
                while (reader.Read())
                {
                    sequence.Items.Add(new SequenceItem
                    {
                        Id = reader.GetInt64(0),
                        SequenceId = reader.GetInt64(1),
                        AssetId = reader.GetInt64(2),
                        Sort = reader.GetInt32(3),
                        DurationMs = reader.IsDBNull(4) ? null : reader.GetInt64(4),
                        TransitionId = reader.IsDBNull(5) ? null : reader.GetString(5),
                    });
                }
            }

            return sequences;
        });
    }

    /// <summary>整条序列保存（含成员），name 为空时用「序列 N」。</summary>
    public long SaveSequence(WallpaperSequence sequence)
    {
        return _db.Write(connection =>
        {
            using var transaction = connection.BeginTransaction();
            long id = sequence.Id;

            if (id > 0)
            {
                using var update = connection.CreateCommand();
                update.Transaction = transaction;
                update.CommandText = "UPDATE sequences SET name=$name, canvas=$canvas, loop=$loop WHERE id=$id;";
                update.Parameters.AddWithValue("$name", sequence.Name);
                update.Parameters.AddWithValue("$canvas", sequence.Canvas is null ? DBNull.Value : (object)(sequence.Canvas == CanvasKind.Desktop ? "desktop" : "inapp"));
                update.Parameters.AddWithValue("$loop", sequence.Loop ? 1 : 0);
                update.Parameters.AddWithValue("$id", id);
                update.ExecuteNonQuery();
            }
            else
            {
                using var insert = connection.CreateCommand();
                insert.Transaction = transaction;
                insert.CommandText = """
                    INSERT INTO sequences(name, canvas, loop) VALUES($name, $canvas, $loop) RETURNING id;
                    """;
                insert.Parameters.AddWithValue("$name", sequence.Name);
                insert.Parameters.AddWithValue("$canvas", sequence.Canvas is null ? DBNull.Value : (object)(sequence.Canvas == CanvasKind.Desktop ? "desktop" : "inapp"));
                insert.Parameters.AddWithValue("$loop", sequence.Loop ? 1 : 0);
                id = Convert.ToInt64(insert.ExecuteScalar() ?? 0L);
            }

            using (var clear = connection.CreateCommand())
            {
                clear.Transaction = transaction;
                clear.CommandText = "DELETE FROM sequence_items WHERE sequence_id=$id;";
                clear.Parameters.AddWithValue("$id", id);
                clear.ExecuteNonQuery();
            }

            for (var index = 0; index < sequence.Items.Count; index++)
            {
                var item = sequence.Items[index];
                using var add = connection.CreateCommand();
                add.Transaction = transaction;
                add.CommandText = """
                    INSERT INTO sequence_items(sequence_id, asset_id, sort, duration_ms, transition_id)
                    VALUES($s, $a, $sort, $duration, $transition);
                    """;
                add.Parameters.AddWithValue("$s", id);
                add.Parameters.AddWithValue("$a", item.AssetId);
                add.Parameters.AddWithValue("$sort", index);
                add.Parameters.AddWithValue("$duration", (object?)item.DurationMs ?? DBNull.Value);
                add.Parameters.AddWithValue("$transition", (object?)item.TransitionId ?? DBNull.Value);
                add.ExecuteNonQuery();
            }

            transaction.Commit();
            sequence.Id = id;
            return id;
        });
    }

    public void DeleteSequence(long id)
    {
        _db.Write(connection =>
        {
            using var transaction = connection.BeginTransaction();
            using (var items = connection.CreateCommand())
            {
                items.Transaction = transaction;
                items.CommandText = "DELETE FROM sequence_items WHERE sequence_id=$id;";
                items.Parameters.AddWithValue("$id", id);
                items.ExecuteNonQuery();
            }
            using (var self = connection.CreateCommand())
            {
                self.Transaction = transaction;
                self.CommandText = "DELETE FROM sequences WHERE id=$id;";
                self.Parameters.AddWithValue("$id", id);
                self.ExecuteNonQuery();
            }
            transaction.Commit();
        });
    }

    /* ---------------------------------------------------------------- 预设 */

    public List<WallpaperPreset> ListPresets()
    {
        return _db.Read(connection =>
        {
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT id, name, kind, payload_json FROM presets ORDER BY kind ASC, id ASC;";
            var list = new List<WallpaperPreset>();
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                list.Add(new WallpaperPreset
                {
                    Id = reader.GetInt64(0),
                    Name = reader.GetString(1),
                    Kind = reader.GetString(2),
                    PayloadJson = reader.GetString(3),
                });
            }
            return list;
        });
    }

    public long SavePreset(WallpaperPreset preset)
    {
        return _db.Write(connection =>
        {
            using var command = connection.CreateCommand();
            if (preset.Id > 0)
            {
                command.CommandText = """
                    UPDATE presets SET name=$name, kind=$kind, payload_json=$payload WHERE id=$id; SELECT $id;
                    """;
                command.Parameters.AddWithValue("$id", preset.Id);
            }
            else
            {
                command.CommandText = """
                    INSERT INTO presets(name, kind, payload_json) VALUES($name, $kind, $payload) RETURNING id;
                    """;
            }
            command.Parameters.AddWithValue("$name", preset.Name);
            command.Parameters.AddWithValue("$kind", string.IsNullOrWhiteSpace(preset.Kind) ? "manual" : preset.Kind);
            command.Parameters.AddWithValue("$payload", preset.PayloadJson);
            var id = Convert.ToInt64(command.ExecuteScalar() ?? 0L);
            preset.Id = id;
            return id;
        });
    }

    public void DeletePreset(long id)
    {
        _db.Write(connection =>
        {
            using var command = connection.CreateCommand();
            command.CommandText = "DELETE FROM presets WHERE id=$id;";
            command.Parameters.AddWithValue("$id", id);
            command.ExecuteNonQuery();
        });
    }

    /* ---------------------------------------------------------------- 规则 */

    public List<WallpaperRule> ListRules()
    {
        return _db.Read(connection =>
        {
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT id, name, enabled, priority, cond_json, action_json FROM rules ORDER BY priority ASC, id ASC;";
            var list = new List<WallpaperRule>();
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                list.Add(new WallpaperRule
                {
                    Id = reader.GetInt64(0),
                    Name = reader.GetString(1),
                    Enabled = reader.GetInt32(2) != 0,
                    Priority = reader.GetInt32(3),
                    ConditionJson = reader.GetString(4),
                    ActionJson = reader.GetString(5),
                });
            }
            return list;
        });
    }

    public long SaveRule(WallpaperRule rule)
    {
        return _db.Write(connection =>
        {
            using var command = connection.CreateCommand();
            if (rule.Id > 0)
            {
                command.CommandText = """
                    UPDATE rules SET name=$name, enabled=$enabled, priority=$priority, cond_json=$cond, action_json=$action
                    WHERE id=$id; SELECT $id;
                    """;
                command.Parameters.AddWithValue("$id", rule.Id);
            }
            else
            {
                command.CommandText = """
                    INSERT INTO rules(name, enabled, priority, cond_json, action_json)
                    VALUES($name, $enabled, $priority, $cond, $action) RETURNING id;
                    """;
            }
            command.Parameters.AddWithValue("$name", rule.Name);
            command.Parameters.AddWithValue("$enabled", rule.Enabled ? 1 : 0);
            command.Parameters.AddWithValue("$priority", rule.Priority);
            command.Parameters.AddWithValue("$cond", rule.ConditionJson);
            command.Parameters.AddWithValue("$action", rule.ActionJson);
            var id = Convert.ToInt64(command.ExecuteScalar() ?? 0L);
            rule.Id = id;
            return id;
        });
    }

    public void DeleteRule(long id)
    {
        _db.Write(connection =>
        {
            using var command = connection.CreateCommand();
            command.CommandText = "DELETE FROM rules WHERE id=$id;";
            command.Parameters.AddWithValue("$id", id);
            command.ExecuteNonQuery();
        });
    }

    /// <summary>整批重写优先级（拖拽排序）。</summary>
    public void ReorderRules(IReadOnlyList<long> idsInOrder)
    {
        _db.Write(connection =>
        {
            using var transaction = connection.BeginTransaction();
            for (var index = 0; index < idsInOrder.Count; index++)
            {
                using var command = connection.CreateCommand();
                command.Transaction = transaction;
                command.CommandText = "UPDATE rules SET priority=$p WHERE id=$id;";
                command.Parameters.AddWithValue("$p", index);
                command.Parameters.AddWithValue("$id", idsInOrder[index]);
                command.ExecuteNonQuery();
            }
            transaction.Commit();
        });
    }

    /* ---------------------------------------------------------------- 统计 */

    /// <summary>库总览：条数、占用、缩略图占用（第 87 轮存储页）。</summary>
    public (int Count, long TotalBytes, int Favorites) Stats()
    {
        return _db.Read(connection =>
        {
            using var command = connection.CreateCommand();
            command.CommandText = """
                SELECT COUNT(*), IFNULL(SUM(size_bytes),0),
                       (SELECT COUNT(*) FROM favorites)
                FROM assets;
                """;
            using var reader = command.ExecuteReader();
            if (!reader.Read()) return (0, 0L, 0);
            return (reader.GetInt32(0), reader.GetInt64(1), reader.GetInt32(2));
        });
    }
}
