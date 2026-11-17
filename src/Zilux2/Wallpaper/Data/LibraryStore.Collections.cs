using Zilux2.Wallpaper.Model;

namespace Zilux2.Wallpaper.Data;

/// <summary>标签、收藏、合辑三块（第 63、64 轮）。</summary>
internal sealed partial class LibraryStore
{
    /* ---------------------------------------------------------------- 标签 */

    /// <summary>全部标签 + 使用次数，按次数降序（自动补全列表就用这个）。</summary>
    public List<(long Id, string Name, int Count)> ListTags()
    {
        return _db.Read(connection =>
        {
            using var command = connection.CreateCommand();
            command.CommandText = """
                SELECT t.id, t.name, COUNT(at.asset_id)
                FROM tags t LEFT JOIN asset_tags at ON at.tag_id=t.id
                GROUP BY t.id, t.name
                ORDER BY COUNT(at.asset_id) DESC, t.name COLLATE NOCASE ASC;
                """;
            var list = new List<(long, string, int)>();
            using var reader = command.ExecuteReader();
            while (reader.Read()) list.Add((reader.GetInt64(0), reader.GetString(1), reader.GetInt32(2)));
            return list;
        });
    }

    /// <summary>某张素材的标签名。</summary>
    public List<string> TagsOf(long assetId)
    {
        return _db.Read(connection =>
        {
            using var command = connection.CreateCommand();
            command.CommandText = """
                SELECT t.name FROM asset_tags at JOIN tags t ON t.id=at.tag_id
                WHERE at.asset_id=$id ORDER BY t.name COLLATE NOCASE ASC;
                """;
            command.Parameters.AddWithValue("$id", assetId);
            var list = new List<string>();
            using var reader = command.ExecuteReader();
            while (reader.Read()) list.Add(reader.GetString(0));
            return list;
        });
    }

    /// <summary>整体替换某张素材的标签（前端提交完整列表最省心）。</summary>
    public void SetTags(long assetId, IEnumerable<string> names)
    {
        _db.Write(connection =>
        {
            using var transaction = connection.BeginTransaction();

            using (var clear = connection.CreateCommand())
            {
                clear.Transaction = transaction;
                clear.CommandText = "DELETE FROM asset_tags WHERE asset_id=$id;";
                clear.Parameters.AddWithValue("$id", assetId);
                clear.ExecuteNonQuery();
            }

            foreach (var raw in names)
            {
                var name = raw.Trim();
                if (name.Length == 0) continue;
                if (name.Length > 48) name = name[..48];

                long tagId;
                using (var insert = connection.CreateCommand())
                {
                    insert.Transaction = transaction;
                    insert.CommandText = "INSERT INTO tags(name) VALUES($name) ON CONFLICT(name) DO NOTHING; SELECT id FROM tags WHERE name=$name;";
                    insert.Parameters.AddWithValue("$name", name);
                    tagId = Convert.ToInt64(insert.ExecuteScalar() ?? 0L);
                }

                if (tagId == 0) continue;

                using var link = connection.CreateCommand();
                link.Transaction = transaction;
                link.CommandText = "INSERT OR IGNORE INTO asset_tags(asset_id, tag_id) VALUES($a, $t);";
                link.Parameters.AddWithValue("$a", assetId);
                link.Parameters.AddWithValue("$t", tagId);
                link.ExecuteNonQuery();
            }

            transaction.Commit();
        });
    }

    /* ---------------------------------------------------------------- 收藏 */

    public bool IsFavorite(long assetId)
    {
        return _db.Read(connection =>
        {
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT 1 FROM favorites WHERE asset_id=$id LIMIT 1;";
            command.Parameters.AddWithValue("$id", assetId);
            return command.ExecuteScalar() is not null;
        });
    }

    /// <summary>切换收藏，返回切换后的状态。</summary>
    public bool ToggleFavorite(long assetId)
    {
        return _db.Write(connection =>
        {
            using var query = connection.CreateCommand();
            query.CommandText = "SELECT 1 FROM favorites WHERE asset_id=$id LIMIT 1;";
            query.Parameters.AddWithValue("$id", assetId);
            var exists = query.ExecuteScalar() is not null;

            using var command = connection.CreateCommand();
            command.CommandText = exists
                ? "DELETE FROM favorites WHERE asset_id=$id;"
                : "INSERT OR IGNORE INTO favorites(asset_id) VALUES($id);";
            command.Parameters.AddWithValue("$id", assetId);
            command.ExecuteNonQuery();
            return !exists;
        });
    }

    /* ---------------------------------------------------------------- 合辑 */

    /// <summary>合辑列表，内置三类（全部/收藏/最近导入）不落库，只有自定义与未分类落库。</summary>
    public List<WallpaperCollection> ListCollections()
    {
        return _db.Read(connection =>
        {
            var list = new List<WallpaperCollection>();
            using var command = connection.CreateCommand();
            command.CommandText = """
                SELECT c.id, c.name, c.builtin, c.sort,
                       (SELECT COUNT(*) FROM collection_assets ca WHERE ca.collection_id=c.id)
                FROM collections c
                ORDER BY c.sort ASC, c.id ASC;
                """;
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                list.Add(new WallpaperCollection
                {
                    Id = reader.GetInt64(0),
                    Name = reader.GetString(1),
                    Builtin = reader.IsDBNull(2) ? null : reader.GetString(2),
                    Sort = reader.GetInt32(3),
                    Count = reader.GetInt32(4),
                });
            }
            return list;
        });
    }

    public long CreateCollection(string name)
    {
        return _db.Write(connection =>
        {
            using var command = connection.CreateCommand();
            command.CommandText = """
                INSERT INTO collections(name, builtin, sort)
                VALUES($name, NULL, (SELECT IFNULL(MAX(sort),0)+1 FROM collections))
                RETURNING id;
                """;
            command.Parameters.AddWithValue("$name", name.Trim());
            return Convert.ToInt64(command.ExecuteScalar() ?? 0L);
        });
    }

    public void RenameCollection(long id, string name)
    {
        _db.Write(connection =>
        {
            using var command = connection.CreateCommand();
            command.CommandText = "UPDATE collections SET name=$name WHERE id=$id;";
            command.Parameters.AddWithValue("$name", name.Trim());
            command.Parameters.AddWithValue("$id", id);
            command.ExecuteNonQuery();
        });
    }

    public void DeleteCollection(long id)
    {
        _db.Write(connection =>
        {
            using var transaction = connection.BeginTransaction();
            using (var members = connection.CreateCommand())
            {
                members.Transaction = transaction;
                members.CommandText = "DELETE FROM collection_assets WHERE collection_id=$id;";
                members.Parameters.AddWithValue("$id", id);
                members.ExecuteNonQuery();
            }
            using (var self = connection.CreateCommand())
            {
                self.Transaction = transaction;
                self.CommandText = "DELETE FROM collections WHERE id=$id;";
                self.Parameters.AddWithValue("$id", id);
                self.ExecuteNonQuery();
            }
            transaction.Commit();
        });
    }

    public void AddToCollection(long collectionId, long assetId)
    {
        _db.Write(connection =>
        {
            using var command = connection.CreateCommand();
            command.CommandText = """
                INSERT OR IGNORE INTO collection_assets(collection_id, asset_id, sort)
                VALUES($c, $a, (SELECT IFNULL(MAX(sort),0)+1 FROM collection_assets WHERE collection_id=$c));
                """;
            command.Parameters.AddWithValue("$c", collectionId);
            command.Parameters.AddWithValue("$a", assetId);
            command.ExecuteNonQuery();
        });
    }

    public void RemoveFromCollection(long collectionId, long assetId)
    {
        _db.Write(connection =>
        {
            using var command = connection.CreateCommand();
            command.CommandText = "DELETE FROM collection_assets WHERE collection_id=$c AND asset_id=$a;";
            command.Parameters.AddWithValue("$c", collectionId);
            command.Parameters.AddWithValue("$a", assetId);
            command.ExecuteNonQuery();
        });
    }

    /// <summary>合辑成员（按 sort 顺序），拖拽排序就改这个顺序。</summary>
    public List<long> CollectionMembers(long collectionId)
    {
        return _db.Read(connection =>
        {
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT asset_id FROM collection_assets WHERE collection_id=$c ORDER BY sort ASC, asset_id ASC;";
            command.Parameters.AddWithValue("$c", collectionId);
            var ids = new List<long>();
            using var reader = command.ExecuteReader();
            while (reader.Read()) ids.Add(reader.GetInt64(0));
            return ids;
        });
    }

    /// <summary>整批重写成员顺序（第 36 轮拖拽排序）。</summary>
    public void ReorderCollection(long collectionId, IReadOnlyList<long> assetIds)
    {
        _db.Write(connection =>
        {
            using var transaction = connection.BeginTransaction();
            for (var index = 0; index < assetIds.Count; index++)
            {
                using var command = connection.CreateCommand();
                command.Transaction = transaction;
                command.CommandText = "UPDATE collection_assets SET sort=$sort WHERE collection_id=$c AND asset_id=$a;";
                command.Parameters.AddWithValue("$sort", index);
                command.Parameters.AddWithValue("$c", collectionId);
                command.Parameters.AddWithValue("$a", assetIds[index]);
                command.ExecuteNonQuery();
            }
            transaction.Commit();
        });
    }
}
