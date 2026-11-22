using System.IO;
using Microsoft.Data.Sqlite;

namespace Zilux2.Wallpaper.Data;

/// <summary>
/// 壁纸索引库（SQLite）。表结构见 docs/wallpaper-v2-spec.md §4。
/// 并发模型：一个连接 + 一把锁。壁纸的读写都来自 UI 线程、扫描线程和 HTTP 线程，
/// SQLite 的单写者语义下串行化最省心；单条语句都在亚毫秒级，不构成瓶颈。
/// </summary>
internal sealed class WallpaperDb : IDisposable
{
    /// <summary>当前 schema 版本。改表就 +1 并在 Migrate 里补迁移。</summary>
    /// <remarks>
    /// 2：新增 asset_canvas_settings（每张素材自己记住的画面参数）。
    /// 版本号不涨的话 Migrate 会直接返回，老库永远补不上新表 —— 这条踩过。
    /// </remarks>
    private const int SchemaVersion = 2;

    private readonly SqliteConnection _connection;
    private readonly object _gate = new();
    private bool _disposed;

    private WallpaperDb(SqliteConnection connection)
    {
        _connection = connection;
    }

    /// <summary>打开（必要时创建）库文件并完成建表。</summary>
    public static WallpaperDb Open(string path)
    {
        var directory = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);

        var builder = new SqliteConnectionStringBuilder
        {
            DataSource = path,
            Mode = SqliteOpenMode.ReadWriteCreate,
            // 共享缓存让同进程内的读不互相阻塞；跨进程没有第二个连接，安全。
            Cache = SqliteCacheMode.Shared,
            Pooling = false,
        };

        var connection = new SqliteConnection(builder.ToString());
        connection.Open();

        using (var pragma = connection.CreateCommand())
        {
            // WAL：写不挡读；NORMAL：壁纸索引丢了能重建，不值得每次 fsync。
            pragma.CommandText = "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;";
            pragma.ExecuteNonQuery();
        }

        var db = new WallpaperDb(connection);
        db.Migrate();
        return db;
    }

    /// <summary>在锁内跑一段读操作。</summary>
    public T Read<T>(Func<SqliteConnection, T> work)
    {
        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            return work(_connection);
        }
    }

    /// <summary>在锁内跑一段写操作。</summary>
    public void Write(Action<SqliteConnection> work)
    {
        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            work(_connection);
        }
    }

    /// <summary>在锁内跑一段写操作并返回结果（INSERT 后取 last_insert_rowid 之类）。</summary>
    public T Write<T>(Func<SqliteConnection, T> work)
    {
        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            return work(_connection);
        }
    }

    private void Migrate()
    {
        var version = Read(connection =>
        {
            using var command = connection.CreateCommand();
            command.CommandText = "PRAGMA user_version;";
            return Convert.ToInt32(command.ExecuteScalar() ?? 0);
        });

        if (version >= SchemaVersion) return;

        Write(connection =>
        {
            using var transaction = connection.BeginTransaction();
            using (var command = connection.CreateCommand())
            {
                command.Transaction = transaction;
                command.CommandText = Schema;
                command.ExecuteNonQuery();
            }

            using (var stamp = connection.CreateCommand())
            {
                stamp.Transaction = transaction;
                stamp.CommandText = $"PRAGMA user_version={SchemaVersion};";
                stamp.ExecuteNonQuery();
            }

            transaction.Commit();
        });
    }

    /// <summary>建表语句。全部 IF NOT EXISTS，重复执行无害。</summary>
    private const string Schema = """
        CREATE TABLE IF NOT EXISTS assets (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          hash          TEXT UNIQUE NOT NULL,
          path          TEXT NOT NULL,
          source        TEXT NOT NULL,
          kind          TEXT NOT NULL,
          width         INTEGER,
          height        INTEGER,
          duration_ms   INTEGER,
          fps           REAL,
          size_bytes    INTEGER,
          cover_path    TEXT,
          cover_time_ms INTEGER,
          trim_in_ms    INTEGER,
          trim_out_ms   INTEGER,
          speed         REAL NOT NULL DEFAULT 1.0,
          transform_json TEXT,
          fit_override  TEXT,
          missing       INTEGER NOT NULL DEFAULT 0,
          title         TEXT,
          added_at      INTEGER NOT NULL,
          last_seen_at  INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_assets_source ON assets(source);
        CREATE INDEX IF NOT EXISTS idx_assets_added ON assets(added_at DESC);

        CREATE TABLE IF NOT EXISTS tags (
          id   INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT UNIQUE NOT NULL
        );
        CREATE TABLE IF NOT EXISTS asset_tags (
          asset_id INTEGER NOT NULL,
          tag_id   INTEGER NOT NULL,
          PRIMARY KEY (asset_id, tag_id)
        );

        CREATE TABLE IF NOT EXISTS collections (
          id      INTEGER PRIMARY KEY AUTOINCREMENT,
          name    TEXT NOT NULL,
          builtin TEXT,
          sort    INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS collection_assets (
          collection_id INTEGER NOT NULL,
          asset_id      INTEGER NOT NULL,
          sort          INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (collection_id, asset_id)
        );

        CREATE TABLE IF NOT EXISTS sequences (
          id     INTEGER PRIMARY KEY AUTOINCREMENT,
          name   TEXT NOT NULL,
          canvas TEXT,
          loop   INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS sequence_items (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          sequence_id   INTEGER NOT NULL,
          asset_id      INTEGER NOT NULL,
          sort          INTEGER NOT NULL,
          duration_ms   INTEGER,
          transition_id TEXT
        );

        CREATE TABLE IF NOT EXISTS canvases (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          kind          TEXT NOT NULL,
          monitor_id    TEXT,
          asset_id      INTEGER,
          sequence_id   INTEGER,
          fit_mode      TEXT,
          filter_json   TEXT,
          transition_id TEXT,
          paused        INTEGER NOT NULL DEFAULT 0,
          updated_at    INTEGER
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_canvases_key ON canvases(kind, IFNULL(monitor_id, ''));

        -- 每张素材自己记住的画面参数（镜像/旋转/移动/缩放/模糊）：
        -- 换到别的屏、下次再用这张壁纸时自动带回来。fps 属于屏，不进这张表。
        CREATE TABLE IF NOT EXISTS asset_canvas_settings (
          asset_id   INTEGER PRIMARY KEY,
          json       TEXT NOT NULL,
          updated_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS presets (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          name         TEXT NOT NULL,
          kind         TEXT NOT NULL DEFAULT 'manual',
          payload_json TEXT NOT NULL DEFAULT '{}'
        );

        CREATE TABLE IF NOT EXISTS rules (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          name        TEXT NOT NULL,
          enabled     INTEGER NOT NULL DEFAULT 1,
          priority    INTEGER NOT NULL DEFAULT 0,
          cond_json   TEXT NOT NULL DEFAULT '{}',
          action_json TEXT NOT NULL DEFAULT '{}'
        );

        CREATE TABLE IF NOT EXISTS favorites (
          asset_id INTEGER PRIMARY KEY
        );
        """;

    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed) return;
            _disposed = true;
            _connection.Dispose();
        }
    }
}
