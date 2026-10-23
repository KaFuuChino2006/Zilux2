"""给本地歌曲库加上 CUE 分轨、DSF 转码播放、SMTC 本地封面读取。"""
import io
import sys
from pathlib import Path

ROOT = Path(r"E:\Zilux2开发")
QUEUE = ROOT / "research" / "qa"
STEP = []


def load(path):
    raw = io.open(str(path), "r", encoding="utf-8", newline="").read()
    crlf = "\r\n" in raw
    return raw.replace("\r\n", "\n"), crlf


def save(path, text, crlf):
    io.open(str(path), "w", encoding="utf-8", newline="").write(text.replace("\n", "\r\n") if crlf else text)


def rep(text, old, new, name, count=1):
    got = text.count(old)
    assert got == count, f"{name}: count={got} (expect {count})"
    STEP.append(name)
    return text.replace(old, new)


# ---------------------------------------------------------------- SmtcArtwork
p = ROOT / "src" / "Zilux2" / "Media" / "SmtcArtwork.cs"
text, crlf = load(p)
text = rep(
    text,
    "    internal const int MaxBytes = 5 * 1024 * 1024;\n",
    "    internal const int MaxBytes = 5 * 1024 * 1024;\n\n"
    "    /// <summary>本地歌曲库的封面用的是 virtual host，HttpClient 解析不了，交给宿主自己读文件。</summary>\n"
    "    internal static Func<string, byte[]?>? LocalResolver;\n",
    "smtc-field",
)
text = rep(
    text,
    "        if (trimmed.StartsWith(\"data:\", StringComparison.OrdinalIgnoreCase))\n"
    "        {\n"
    "            return ReadDataUrl(trimmed);\n"
    "        }\n",
    "        if (trimmed.StartsWith(\"data:\", StringComparison.OrdinalIgnoreCase))\n"
    "        {\n"
    "            return ReadDataUrl(trimmed);\n"
    "        }\n\n"
    "        if (LocalResolver is not null)\n"
    "        {\n"
    "            var local = LocalResolver(trimmed);\n"
    "            if (local is not null)\n"
    "            {\n"
    "                return local;\n"
    "            }\n"
    "        }\n",
    "smtc-local-hook",
)
save(p, text, crlf)

# ---------------------------------------------------------------- LocalMusicService
p = ROOT / "src" / "Zilux2" / "Local" / "LocalMusicService.cs"
text, crlf = load(p)

text = rep(
    text,
    "using Microsoft.Win32;\n",
    "using Microsoft.Win32;\nusing Zilux2.Media;\n",
    "using-media",
)

text = rep(
    text,
    "        _window = window;\n        _core = core;\n        _post = post;\n    }\n",
    "        _window = window;\n        _core = core;\n        _post = post;\n"
    "        SmtcArtwork.LocalResolver = TryReadCoverBytes;\n    }\n\n"
    "    /// <summary>Windows 媒体浮层的封面：把 https://localmusic.local/__cover?rel=… 映射回本地文件。</summary>\n"
    "    private byte[]? TryReadCoverBytes(string source)\n"
    "    {\n"
    "        if (!Uri.TryCreate(source, UriKind.Absolute, out var uri)\n"
    "            || !string.Equals(uri.Host, VirtualHost, StringComparison.OrdinalIgnoreCase)\n"
    "            || _currentFolder.Length == 0)\n"
    "        {\n"
    "            return null;\n"
    "        }\n\n"
    "        var rel = string.Equals(uri.AbsolutePath, \"/__cover\", StringComparison.OrdinalIgnoreCase)\n"
    "            ? QueryValue(uri.Query, \"rel\")\n"
    "            : Uri.UnescapeDataString(uri.AbsolutePath).TrimStart('/');\n"
    "        if (string.IsNullOrWhiteSpace(rel))\n"
    "        {\n"
    "            return null;\n"
    "        }\n\n"
    "        try\n"
    "        {\n"
    "            var fullPath = Path.GetFullPath(Path.Combine(_currentFolder, rel.Replace('/', Path.DirectorySeparatorChar)));\n"
    "            if (!fullPath.StartsWith(_currentFolder, StringComparison.OrdinalIgnoreCase) || !File.Exists(fullPath))\n"
    "            {\n"
    "                return null;\n"
    "            }\n\n"
    "            return LocalCover.Read(fullPath)?.Bytes;\n"
    "        }\n"
    "        catch\n"
    "        {\n"
    "            return null;\n"
    "        }\n"
    "    }\n",
    "smtc-resolver",
)

# 用磁盘分段读取替换「整文件读入内存」的老逻辑（同时处理 dsf 转码）
old_serve = """        byte[] bytes;
        try
        {
            bytes = File.ReadAllBytes(fullPath);
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[local] read failed {fullPath}: {exception.Message}");
            Respond(e, core, 500, "Internal Server Error", "text/plain", Array.Empty<byte>());
            return;
        }

        var contentType = ContentTypeOf(fullPath);
        var total = bytes.Length;
        var range = TryGetHeader(e.Request.Headers, "Range");
        HostLog.Info($"[local] serve {Path.GetFileName(fullPath)} {total}B range={range ?? "-"} type={contentType}");

        if (!string.IsNullOrWhiteSpace(range) && range.StartsWith("bytes=", StringComparison.OrdinalIgnoreCase))
        {
            var spec = range.Substring(6).Split(',')[0].Trim();
            var dash = spec.IndexOf('-');
            if (dash > 0)
            {
                var startText = spec.Substring(0, dash);
                var endText = spec.Substring(dash + 1);
                if (int.TryParse(startText, out var start) && start >= 0 && start < total)
                {
                    var end = total - 1;
                    if (endText.Length > 0 && int.TryParse(endText, out var parsedEnd) && parsedEnd >= start && parsedEnd < total)
                    {
                        end = parsedEnd;
                    }

                    var slice = new byte[end - start + 1];
                    Array.Copy(bytes, start, slice, 0, slice.Length);
                    Respond(e, core, 206, "Partial Content", contentType, slice, $"bytes {start}-{end}/{total}");
                    return;
                }
            }
        }

        Respond(e, core, 200, "OK", contentType, bytes);
    }
"""
new_serve = """        ServeLocalFile(e, core, fullPath);
    }

    /// <summary>按 Range 从磁盘分段读取（大文件不整块进内存）；DSF 先转成 WAV 缓存再当 WAV 提供。</summary>
    private static void ServeLocalFile(CoreWebView2WebResourceRequestedEventArgs e, CoreWebView2 core, string fullPath)
    {
        var path = fullPath;
        var contentType = ContentTypeOf(fullPath);
        if (string.Equals(Path.GetExtension(fullPath), ".dsf", StringComparison.OrdinalIgnoreCase))
        {
            if (!DsfTranscoder.TryEnsureWav(fullPath, out var wavPath, out var error))
            {
                HostLog.Warn($"[local] dsf transcode failed {Path.GetFileName(fullPath)}: {error}");
                Respond(e, core, 415, "Unsupported Media Type", "text/plain", System.Text.Encoding.UTF8.GetBytes(error));
                return;
            }

            path = wavPath;
            contentType = "audio/wav";
        }

        long total;
        try
        {
            total = new FileInfo(path).Length;
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[local] size failed {path}: {exception.Message}");
            Respond(e, core, 500, "Internal Server Error", "text/plain", Array.Empty<byte>());
            return;
        }

        var rangeHeader = TryGetHeader(e.Request.Headers, "Range");
        long start = 0;
        long end = total - 1;
        var partial = false;
        if (!string.IsNullOrWhiteSpace(rangeHeader) && rangeHeader.StartsWith("bytes=", StringComparison.OrdinalIgnoreCase))
        {
            var spec = rangeHeader.Substring(6).Split(',')[0].Trim();
            var dash = spec.IndexOf('-');
            if (dash >= 0)
            {
                var startText = spec.Substring(0, dash);
                var endText = spec.Substring(dash + 1);
                if (startText.Length == 0 && long.TryParse(endText, out var suffix) && suffix > 0)
                {
                    start = Math.Max(0, total - suffix);
                }
                else if (long.TryParse(startText, out var parsedStart))
                {
                    start = Math.Max(0, Math.Min(parsedStart, total - 1));
                    if (endText.Length > 0 && long.TryParse(endText, out var parsedEnd))
                    {
                        end = Math.Max(start, Math.Min(parsedEnd, total - 1));
                    }
                }

                partial = true;
            }
        }

        if (end < start || total <= 0)
        {
            Respond(e, core, 416, "Range Not Satisfiable", "text/plain", Array.Empty<byte>());
            return;
        }

        byte[] bytes;
        try
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            stream.Position = start;
            bytes = new byte[end - start + 1];
            var read = 0;
            while (read < bytes.Length)
            {
                var got = stream.Read(bytes, read, bytes.Length - read);
                if (got <= 0)
                {
                    break;
                }

                read += got;
            }

            if (read < bytes.Length)
            {
                Array.Resize(ref bytes, read);
            }
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[local] read failed {path}: {exception.Message}");
            Respond(e, core, 500, "Internal Server Error", "text/plain", Array.Empty<byte>());
            return;
        }

        HostLog.Info($"[local] serve {Path.GetFileName(path)} {bytes.Length}B range={rangeHeader ?? "-"} type={contentType}");
        if (partial)
        {
            Respond(e, core, 206, "Partial Content", contentType, bytes, $"bytes {start}-{start + bytes.Length - 1}/{total}");
            return;
        }

        Respond(e, core, 200, "OK", contentType, bytes);
    }
"""
text = rep(text, old_serve, new_serve, "serve-range")

# 扫描：CUE 分轨 + 普通文件
old_scan_start = """    private static List<LocalTrackDto> Scan(string folder, List<string> lyrics)
    {
        var results = new List<LocalTrackDto>();
        var queue = new Queue<string>();
        queue.Enqueue(folder);
        var visited = 0;

        while (queue.Count > 0 && results.Count < MaxTracks && visited < 20000)
        {
            var current = queue.Dequeue();
            visited += 1;

            string[] files;
            try
            {
                files = Directory.GetFiles(current, "*", SearchOption.TopDirectoryOnly);
            }
            catch (Exception exception)
            {
                HostLog.Warn($"[local] skip folder {current}: {exception.Message}");
                continue;
            }

            foreach (var file in files)
            {
                if (results.Count >= MaxTracks)
                {
                    break;
                }

                var extension = Path.GetExtension(file);
                if (string.Equals(extension, ".lrc", StringComparison.OrdinalIgnoreCase))
                {
                    if (lyrics.Count < 2000)
                    {
                        lyrics.Add(Path.GetRelativePath(folder, file).Replace('\\\\', '/'));
                    }

                    continue;
                }

                if (!AudioExtensions.Contains(extension))
                {
                    continue;
                }

                var relative = Path.GetRelativePath(folder, file).Replace('\\\\', '/');
                results.Add(new LocalTrackDto
                {
                    Rel = relative,
                    Name = Path.GetFileNameWithoutExtension(file),
                    Size = new FileInfo(file).Length,
                    HasCover = LocalCover.Has(file),
                });
            }
"""
new_scan_start = """    private static List<LocalTrackDto> Scan(string folder, List<string> lyrics)
    {
        var results = new List<LocalTrackDto>();
        var queue = new Queue<string>();
        queue.Enqueue(folder);
        var visited = 0;

        while (queue.Count > 0 && results.Count < MaxTracks && visited < 20000)
        {
            var current = queue.Dequeue();
            visited += 1;

            string[] files;
            try
            {
                files = Directory.GetFiles(current, "*", SearchOption.TopDirectoryOnly);
            }
            catch (Exception exception)
            {
                HostLog.Warn($"[local] skip folder {current}: {exception.Message}");
                continue;
            }

            var audioFiles = new List<string>();
            var cueFiles = new List<string>();
            foreach (var file in files)
            {
                var extension = Path.GetExtension(file);
                if (string.Equals(extension, ".lrc", StringComparison.OrdinalIgnoreCase))
                {
                    if (lyrics.Count < 2000)
                    {
                        lyrics.Add(Path.GetRelativePath(folder, file).Replace('\\\\', '/'));
                    }

                    continue;
                }

                if (string.Equals(extension, ".cue", StringComparison.OrdinalIgnoreCase))
                {
                    cueFiles.Add(file);
                    continue;
                }

                if (AudioExtensions.Contains(extension))
                {
                    audioFiles.Add(file);
                }
            }

            // CUE：一个整轨镜像文件按 index 拆成多首（播放时用同一个 URL + startAt 偏移）
            var covered = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var cue in cueFiles)
            {
                if (results.Count >= MaxTracks)
                {
                    break;
                }

                var cueTracks = LocalCue.Parse(cue, folder, HostLog.Info);
                if (cueTracks.Count == 0)
                {
                    continue;
                }

                var durations = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
                foreach (var cueTrack in cueTracks)
                {
                    covered.Add(cueTrack.FileRel);
                }

                for (var i = 0; i < cueTracks.Count && results.Count < MaxTracks; i += 1)
                {
                    var cueTrack = cueTracks[i];
                    var imagePath = Path.Combine(folder, cueTrack.FileRel.Replace('/', Path.DirectorySeparatorChar));
                    if (!File.Exists(imagePath))
                    {
                        continue;
                    }

                    if (!durations.TryGetValue(cueTrack.FileRel, out var imageDuration))
                    {
                        imageDuration = LocalCue.Duration(imagePath);
                        durations[cueTrack.FileRel] = imageDuration;
                    }

                    var nextStart = i + 1 < cueTracks.Count ? cueTracks[i + 1].StartSeconds : imageDuration;
                    var trackDuration = nextStart > cueTrack.StartSeconds ? nextStart - cueTrack.StartSeconds : 0;
                    var title = string.IsNullOrWhiteSpace(cueTrack.Title)
                        ? Path.GetFileNameWithoutExtension(cueTrack.FileRel)
                        : cueTrack.Title;
                    results.Add(new LocalTrackDto
                    {
                        Rel = cueTrack.FileRel,
                        Name = cueTrack.Number > 0 ? $"{cueTrack.Number:00} - {title}" : title,
                        Title = title,
                        Artist = cueTrack.Performer,
                        Size = new FileInfo(imagePath).Length,
                        HasCover = LocalCover.Has(imagePath),
                        StartMs = (long)Math.Round(cueTrack.StartSeconds * 1000),
                        DurationMs = (long)Math.Round(trackDuration * 1000),
                        Cue = cueTrack.Number,
                    });
                }
            }

            foreach (var file in audioFiles)
            {
                if (results.Count >= MaxTracks)
                {
                    break;
                }

                var relative = Path.GetRelativePath(folder, file).Replace('\\\\', '/');
                if (covered.Contains(relative))
                {
                    continue;
                }

                results.Add(new LocalTrackDto
                {
                    Rel = relative,
                    Name = Path.GetFileNameWithoutExtension(file),
                    Size = new FileInfo(file).Length,
                    HasCover = LocalCover.Has(file),
                });
            }
"""
text = rep(text, old_scan_start, new_scan_start, "scan-cue")

text = rep(
    text,
    "        results.Sort((left, right) => string.CompareOrdinal(left.Rel, right.Rel));\n        return results;\n",
    "        results.Sort((left, right) =>\n"
    "        {\n"
    "            var compare = string.CompareOrdinal(left.Rel, right.Rel);\n"
    "            return compare != 0 ? compare : left.StartMs.CompareTo(right.StartMs);\n"
    "        });\n"
    "        return results;\n",
    "scan-sort",
)

# DTO 新字段
text = rep(
    text,
    "    /// <summary>音频文件里是否内嵌了封面图（FLAC PICTURE 块 / MP3 ID3 APIC 帧）。</summary>\n    public bool HasCover { get; set; }\n",
    "    /// <summary>音频文件里是否内嵌了封面图（FLAC PICTURE 块 / MP3 ID3 APIC 帧）。</summary>\n"
    "    public bool HasCover { get; set; }\n\n"
    "    /// <summary>CUE 曲名（没有就是文件名）。</summary>\n"
    "    public string? Title { get; set; }\n\n"
    "    /// <summary>CUE 歌手。</summary>\n"
    "    public string? Artist { get; set; }\n\n"
    "    /// <summary>CUE 分轨在镜像文件里的起始毫秒。</summary>\n"
    "    public long StartMs { get; set; }\n\n"
    "    /// <summary>CUE 分轨时长毫秒（0 表示播到文件结束）。</summary>\n"
    "    public long DurationMs { get; set; }\n\n"
    "    /// <summary>CUE 曲目号（0 表示整个文件）。</summary>\n"
    "    public int Cue { get; set; }\n",
    "dto-fields",
)

save(p, text, crlf)

# ---------------------------------------------------------------- LocalCover DSF
p = ROOT / "src" / "Zilux2" / "Local" / "LocalMusicService.cs"
text, crlf = load(p)
text = rep(
    text,
    "                \".flac\" => LocateFlac(path),\n                \".mp3\" => LocateId3(path),\n",
    "                \".flac\" => LocateFlac(path),\n                \".mp3\" => LocateId3(path, 0),\n                \".dsf\" => LocateDsf(path),\n",
    "cover-dsf-dispatch",
)
text = rep(
    text,
    "    private static (long Offset, int Length, string ContentType)? LocateId3(string path)\n    {\n        using var stream = File.OpenRead(path);\n        var head = new byte[10];\n        if (stream.Read(head, 0, 10) != 10 || head[0] != (byte)'I' || head[1] != (byte)'D' || head[2] != (byte)'3')\n",
    "    private static (long Offset, int Length, string ContentType)? LocateDsf(string path)\n"
    "    {\n"
    "        using var stream = File.OpenRead(path);\n"
    "        var head = new byte[28];\n"
    "        if (stream.Read(head, 0, head.Length) != head.Length)\n"
    "        {\n"
    "            return null;\n"
    "        }\n\n"
    "        if (head[0] != (byte)'D' || head[1] != (byte)'S' || head[2] != (byte)'D' || head[3] != (byte)' ')\n"
    "        {\n"
    "            return null;\n"
    "        }\n\n"
    "        var metadata = BitConverter.ToUInt64(head, 20);\n"
    "        if (metadata <= 28 || metadata > (ulong)new FileInfo(path).Length)\n"
    "        {\n"
    "            return null;\n"
    "        }\n\n"
    "        return LocateId3(path, (long)metadata);\n"
    "    }\n\n"
    "    private static (long Offset, int Length, string ContentType)? LocateId3(string path, long offset)\n"
    "    {\n"
    "        using var stream = File.OpenRead(path);\n"
    "        stream.Position = offset;\n"
    "        var head = new byte[10];\n"
    "        if (stream.Read(head, 0, 10) != 10 || head[0] != (byte)'I' || head[1] != (byte)'D' || head[2] != (byte)'3')\n",
    "cover-locateid3",
)
text = rep(
    text,
    "        long position = 10;\n        if ((flags & 0x40) != 0)\n        {\n            var ext = new byte[4];\n            stream.Position = 10;\n",
    "        long position = offset + 10;\n        if ((flags & 0x40) != 0)\n        {\n            var ext = new byte[4];\n            stream.Position = offset + 10;\n",
    "cover-id3-ext",
)
text = rep(
    text,
    "        var limit = 10L + tagSize;\n",
    "        var limit = offset + 10L + tagSize;\n",
    "cover-id3-limit",
)
save(p, text, crlf)

print("OK: " + ", ".join(STEP))
