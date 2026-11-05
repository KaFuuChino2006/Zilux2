using System.Collections.Concurrent;
using System.IO;
using System.Text;

namespace Zilux2;

internal static class HostFolders
{
    public static string Root { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Zilux2");

    public static string Logs { get; } = Path.Combine(Root, "logs");
}

internal static class HostLog
{
    // Logging is off the UI thread on purpose: WebView2 messages (including page "log"
    // messages from chatty animation code) are handled on the dispatcher, and a synchronous
    // disk append per line showed up as dropped frames during window drags.
    private const long MaxLogBytes = 10L * 1024 * 1024;
    private const int KeepLogFiles = 5;
    private const int MaxQueuedLines = 8192;

    private static readonly BlockingCollection<string> Queue = new(new ConcurrentQueue<string>(), MaxQueuedLines);
    private static readonly Encoding Utf8NoBom = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);
    private static readonly Thread Writer;
    private static volatile bool _shutdown;

    public static string LogPath { get; } = Path.Combine(HostFolders.Logs, "host.log");

    static HostLog()
    {
        try
        {
            Directory.CreateDirectory(HostFolders.Logs);
        }
        catch
        {
            // The writer retries on its own; a read-only profile must not break startup.
        }

        Writer = new Thread(WriterLoop)
        {
            IsBackground = true,
            Name = "Zilux2-Log",
        };
        Writer.Start();
    }

    public static void Info(string message) => Write("INFO", message);

    public static void Warn(string message) => Write("WARN", message);

    public static void Error(string message) => Write("ERROR", message);

    public static void Error(string message, Exception exception) =>
        Write("ERROR", $"{message}: {exception.GetType().Name}: {exception.Message}");

    /// <summary>Flushes what is already queued. Call from OnExit; safe to call twice.</summary>
    public static void Shutdown()
    {
        _shutdown = true;
        try
        {
            Queue.CompleteAdding();
            Writer.Join(TimeSpan.FromSeconds(2));
        }
        catch
        {
            // Exit must never stall on the logger.
        }
    }

    private static void Write(string level, string message)
    {
        var line = $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} [{level}] {message}";
        if (_shutdown || !Queue.TryAdd(line))
        {
            System.Diagnostics.Debug.WriteLine(line);
        }
    }

    private static void WriterLoop()
    {
        var buffer = new StringBuilder(1024);
        foreach (var line in Queue.GetConsumingEnumerable())
        {
            buffer.Clear().Append(line).Append(Environment.NewLine);
            // Coalesce a burst into one file open; per-line opens were the hot spot.
            while (buffer.Length < 32 * 1024 && Queue.TryTake(out var extra))
            {
                buffer.Append(extra).Append(Environment.NewLine);
            }

            try
            {
                Directory.CreateDirectory(HostFolders.Logs);
                RotateIfNeeded(buffer.Length);
                File.AppendAllText(LogPath, buffer.ToString(), Utf8NoBom);
            }
            catch
            {
                // Logging must never be able to take the host down.
                System.Diagnostics.Debug.WriteLine(buffer.ToString());
            }
        }
    }

    /// <summary>D-19：单文件超过 10MB 就轮转，保留 5 份历史，避免日志无限增长。</summary>
    private static void RotateIfNeeded(int incomingLength)
    {
        long length;
        try
        {
            var info = new FileInfo(LogPath);
            length = info.Exists ? info.Length : 0;
        }
        catch
        {
            return;
        }

        if (length + incomingLength <= MaxLogBytes)
        {
            return;
        }

        try
        {
            var oldest = $"{LogPath}.{KeepLogFiles}";
            if (File.Exists(oldest))
            {
                File.Delete(oldest);
            }

            for (var index = KeepLogFiles - 1; index >= 1; index--)
            {
                var source = $"{LogPath}.{index}";
                if (File.Exists(source))
                {
                    File.Move(source, $"{LogPath}.{index + 1}", overwrite: true);
                }
            }

            if (File.Exists(LogPath))
            {
                File.Move(LogPath, $"{LogPath}.1", overwrite: true);
            }
        }
        catch
        {
            // 轮转失败时继续追加到当前文件。
        }
    }
}
