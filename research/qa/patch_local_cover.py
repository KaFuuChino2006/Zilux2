"""本地歌曲：读取音频内嵌封面（FLAC PICTURE / MP3 ID3 APIC），并通过 /__cover 提供。"""
import io
import sys
from pathlib import Path

ROOT = Path(r"E:\Zilux2开发")
CS = ROOT / "src/Zilux2/Local/LocalMusicService.cs"
BRIDGE = ROOT / "web/src/bridge.ts"
SHELL = ROOT / "web/src/ui/spaceShell.ts"


def load(path):
    raw = io.open(str(path), "r", encoding="utf-8", newline="").read()
    crlf = "\r\n" in raw
    return raw.replace("\r\n", "\n"), crlf


def save(path, text, crlf):
    io.open(str(path), "w", encoding="utf-8", newline="").write(
        text.replace("\n", "\r\n") if crlf else text
    )


def rep(text, old, new, count=1, tag=""):
    got = text.count(old)
    assert got == count, f"{tag} expect {count} got {got}"
    return text.replace(old, new)


# ---------------------------------------------------------------- C#
cs, cs_crlf = load(CS)

cs = rep(
    cs,
    "    private CoreWebView2? _attachedCore;\n",
    "    private CoreWebView2? _attachedCore;\n"
    "    private readonly Dictionary<string, (byte[] Bytes, string ContentType)> _coverCache =\n"
    "        new(StringComparer.OrdinalIgnoreCase);\n",
    tag="cs-field",
)

cs = rep(
    cs,
    """        if (!string.Equals(uri.Host, VirtualHost, StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        var relative""",
    """        if (!string.Equals(uri.Host, VirtualHost, StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        if (string.Equals(uri.AbsolutePath, "/__cover", StringComparison.OrdinalIgnoreCase))
        {
            ServeCover(e, core, uri);
            return;
        }

        var relative""",
    tag="cs-cover-branch",
)

serve_cover = """    /// <summary>响应内嵌封面请求：https://localmusic.local/__cover?rel=相对路径</summary>
    private void ServeCover(CoreWebView2WebResourceRequestedEventArgs e, CoreWebView2 core, Uri uri)
    {
        var rel = QueryValue(uri.Query, "rel");
        var folder = _currentFolder;
        if (rel is null || folder.Length == 0)
        {
            Respond(e, core, 404, "Not Found", "text/plain", Array.Empty<byte>());
            return;
        }

        string fullPath;
        try
        {
            fullPath = Path.GetFullPath(Path.Combine(folder, rel.Replace('/', Path.DirectorySeparatorChar)));
        }
        catch
        {
            Respond(e, core, 404, "Not Found", "text/plain", Array.Empty<byte>());
            return;
        }

        if (!fullPath.StartsWith(folder, StringComparison.OrdinalIgnoreCase) || !File.Exists(fullPath))
        {
            Respond(e, core, 404, "Not Found", "text/plain", Array.Empty<byte>());
            return;
        }

        byte[] bytes;
        string contentType;
        lock (_coverCache)
        {
            if (_coverCache.TryGetValue(fullPath, out var cached))
            {
                bytes = cached.Bytes;
                contentType = cached.ContentType;
            }
            else
            {
                var found = LocalCover.Read(fullPath);
                if (found is null)
                {
                    HostLog.Warn($"[local] cover missing {Path.GetFileName(fullPath)}");
                    Respond(e, core, 404, "Not Found", "text/plain", Array.Empty<byte>());
                    return;
                }

                bytes = found.Value.Bytes;
                contentType = found.Value.ContentType;
                if (_coverCache.Count >= 200)
                {
                    _coverCache.Clear();
                }

                _coverCache[fullPath] = (bytes, contentType);
            }
        }

        HostLog.Info($"[local] cover {Path.GetFileName(fullPath)} {bytes.Length}B {contentType}");
        Respond(e, core, 200, "OK", contentType, bytes);
    }

    private static string? QueryValue(string query, string key)
    {
        foreach (var part in query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var eq = part.IndexOf('=');
            if (eq <= 0)
            {
                continue;
            }

            if (string.Equals(Uri.UnescapeDataString(part.Substring(0, eq)), key, StringComparison.OrdinalIgnoreCase))
            {
                return Uri.UnescapeDataString(part.Substring(eq + 1));
            }
        }

        return null;
    }

"""
cs = rep(cs, "    private static void Respond(\n", serve_cover + "    private static void Respond(\n", tag="cs-serve-cover")

cs = rep(
    cs,
    """                results.Add(new LocalTrackDto
                {
                    Rel = relative,
                    Name = Path.GetFileNameWithoutExtension(file),
                    Size = new FileInfo(file).Length,
                });""",
    """                results.Add(new LocalTrackDto
                {
                    Rel = relative,
                    Name = Path.GetFileNameWithoutExtension(file),
                    Size = new FileInfo(file).Length,
                    HasCover = LocalCover.Has(file),
                });""",
    tag="cs-scan-cover",
)

cs = rep(
    cs,
    """internal sealed class LocalTrackDto
{
    public string Rel { get; set; } = string.Empty;

    public string Name { get; set; } = string.Empty;

    public long Size { get; set; }
}""",
    """internal sealed class LocalTrackDto
{
    public string Rel { get; set; } = string.Empty;

    public string Name { get; set; } = string.Empty;

    public long Size { get; set; }

    /// <summary>音频文件里是否内嵌了封面图（FLAC PICTURE 块 / MP3 ID3 APIC 帧）。</summary>
    public bool HasCover { get; set; }
}""",
    tag="cs-dto",
)

cover_class = r"""/// <summary>读取音频文件内嵌封面：FLAC 的 PICTURE 元数据块、MP3 的 ID3v2 APIC 帧。</summary>
internal static class LocalCover
{
    /// <summary>只定位是否存在封面（不读图数据，扫描时用）。</summary>
    public static bool Has(string path)
    {
        return Locate(path) is not null;
    }

    public static (byte[] Bytes, string ContentType)? Read(string path)
    {
        var located = Locate(path);
        if (located is null)
        {
            return null;
        }

        try
        {
            using var stream = File.OpenRead(path);
            stream.Position = located.Value.Offset;
            var bytes = new byte[located.Value.Length];
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

            if (read < 32)
            {
                return null;
            }

            if (read < bytes.Length)
            {
                Array.Resize(ref bytes, read);
            }

            return (bytes, Sniff(bytes) ?? located.Value.ContentType);
        }
        catch
        {
            return null;
        }
    }

    private static (long Offset, int Length, string ContentType)? Locate(string path)
    {
        try
        {
            return Path.GetExtension(path).ToLowerInvariant() switch
            {
                ".flac" => LocateFlac(path),
                ".mp3" => LocateId3(path),
                _ => null,
            };
        }
        catch
        {
            return null;
        }
    }

    private static (long Offset, int Length, string ContentType)? LocateFlac(string path)
    {
        using var stream = File.OpenRead(path);
        var magic = new byte[4];
        if (stream.Read(magic, 0, 4) != 4 || magic[0] != (byte)'f' || magic[1] != (byte)'L' || magic[2] != (byte)'a' || magic[3] != (byte)'C')
        {
            return null;
        }

        var header = new byte[4];
        while (stream.Read(header, 0, 4) == 4)
        {
            var last = (header[0] & 0x80) != 0;
            var type = header[0] & 0x7F;
            var length = (header[1] << 16) | (header[2] << 8) | header[3];
            if (type == 6 && length > 0)
            {
                var start = stream.Position;
                var probe = new byte[Math.Min(length, 256)];
                var got = stream.Read(probe, 0, probe.Length);
                if (got < 12)
                {
                    return null;
                }

                var mimeLength = ReadBe(probe, 4);
                var mimeStart = 8;
                var descriptorAt = mimeStart + mimeLength;
                if (mimeLength <= 1 || descriptorAt + 4 > got)
                {
                    return null;
                }

                var mime = System.Text.Encoding.ASCII.GetString(probe, mimeStart, mimeLength).Trim();
                var descriptorLength = ReadBe(probe, descriptorAt);
                var dataLengthAt = descriptorAt + 4 + descriptorLength + 16;
                if (dataLengthAt + 4 > got)
                {
                    return null;
                }

                var dataLength = ReadBe(probe, dataLengthAt);
                var dataStart = dataLengthAt + 4;
                if (dataLength <= 0 || dataStart + dataLength > length)
                {
                    return null;
                }

                return (start + dataStart, dataLength, string.IsNullOrWhiteSpace(mime) ? "image/jpeg" : mime);
            }

            stream.Seek(length, SeekOrigin.Current);
            if (last)
            {
                break;
            }
        }

        return null;
    }

    private static (long Offset, int Length, string ContentType)? LocateId3(string path)
    {
        using var stream = File.OpenRead(path);
        var head = new byte[10];
        if (stream.Read(head, 0, 10) != 10 || head[0] != (byte)'I' || head[1] != (byte)'D' || head[2] != (byte)'3')
        {
            return null;
        }

        var major = head[3];
        var flags = head[5];
        var tagSize = SyncSafe(head, 6);
        if (tagSize <= 0)
        {
            return null;
        }

        long position = 10;
        if ((flags & 0x40) != 0)
        {
            var ext = new byte[4];
            stream.Position = 10;
            if (stream.Read(ext, 0, 4) != 4)
            {
                return null;
            }

            var extSize = major == 4 ? SyncSafe(ext, 0) : ReadBe(ext, 0);
            position += major == 4 ? extSize : extSize + 4;
        }

        var limit = 10L + tagSize;
        var frameHead = new byte[10];
        while (position + 10 <= limit)
        {
            stream.Position = position;
            if (stream.Read(frameHead, 0, 10) != 10 || frameHead[0] == 0)
            {
                return null;
            }

            var id = System.Text.Encoding.ASCII.GetString(frameHead, 0, 4);
            var frameSize = major == 4 ? SyncSafe(frameHead, 4) : ReadBe(frameHead, 4);
            if (frameSize <= 0)
            {
                return null;
            }

            if (id == "APIC")
            {
                var probeLength = (int)Math.Min(1024, frameSize);
                var probe = new byte[probeLength];
                stream.Position = position + 10;
                var got = stream.Read(probe, 0, probeLength);
                var apic = ParseApic(probe, got, frameSize);
                if (apic is not null)
                {
                    return (position + 10 + apic.Value.Offset, apic.Value.Length, apic.Value.ContentType);
                }
            }

            position += 10 + frameSize;
        }

        return null;
    }

    private static (int Offset, int Length, string ContentType)? ParseApic(byte[] probe, int got, long frameSize)
    {
        if (got < 8)
        {
            return null;
        }

        var encoding = probe[0];
        var p = 1;
        var mimeEnd = Array.IndexOf(probe, (byte)0, p, got - p);
        if (mimeEnd <= 0)
        {
            return null;
        }

        var mime = System.Text.Encoding.ASCII.GetString(probe, p, mimeEnd - p);
        p = mimeEnd + 1;
        if (p >= got)
        {
            return null;
        }

        p += 1; // 图片类型
        if (encoding == 1 || encoding == 2)
        {
            while (p + 1 < got && !(probe[p] == 0 && probe[p + 1] == 0))
            {
                p += 2;
            }

            p += 2;
        }
        else
        {
            var descEnd = Array.IndexOf(probe, (byte)0, p, got - p);
            if (descEnd < 0)
            {
                return null;
            }

            p = descEnd + 1;
        }

        if (p >= got)
        {
            return null;
        }

        var length = (int)(frameSize - p);
        if (length <= 0)
        {
            return null;
        }

        return (p, length, string.IsNullOrWhiteSpace(mime) ? "image/jpeg" : mime);
    }

    private static int ReadBe(byte[] buffer, int offset)
    {
        return (buffer[offset] << 24) | (buffer[offset + 1] << 16) | (buffer[offset + 2] << 8) | buffer[offset + 3];
    }

    private static int SyncSafe(byte[] buffer, int offset)
    {
        return ((buffer[offset] & 0x7F) << 21)
            | ((buffer[offset + 1] & 0x7F) << 14)
            | ((buffer[offset + 2] & 0x7F) << 7)
            | (buffer[offset + 3] & 0x7F);
    }

    private static string? Sniff(byte[] data)
    {
        if (data.Length > 3 && data[0] == 0xFF && data[1] == 0xD8)
        {
            return "image/jpeg";
        }

        if (data.Length > 8 && data[0] == 0x89 && data[1] == 0x50 && data[2] == 0x4E && data[3] == 0x47)
        {
            return "image/png";
        }

        if (data.Length > 3 && data[0] == (byte)'G' && data[1] == (byte)'I' && data[2] == (byte)'F')
        {
            return "image/gif";
        }

        if (data.Length > 12
            && data[0] == (byte)'R' && data[1] == (byte)'I' && data[2] == (byte)'F' && data[3] == (byte)'F'
            && data[8] == (byte)'W' && data[9] == (byte)'E' && data[10] == (byte)'B' && data[11] == (byte)'P')
        {
            return "image/webp";
        }

        return null;
    }
}

"""
cs = rep(cs, "internal sealed class LocalTrackDto\n", cover_class + "internal sealed class LocalTrackDto\n", tag="cs-cover-class")
save(CS, cs, cs_crlf)
print("OK: cs")

# ---------------------------------------------------------------- bridge.ts
bridge, bridge_crlf = load(BRIDGE)
bridge = rep(
    bridge,
    """export interface LocalLibraryTrack {
  rel: string;
  name: string;
  size: number;
}""",
    """export interface LocalLibraryTrack {
  rel: string;
  name: string;
  size: number;
  /** 音频里是否内嵌封面（宿主只给标记，图片走 /__cover 单独取）。 */
  hasCover?: boolean;
}""",
    tag="ts-track",
)
bridge = rep(
    bridge,
    """        tracks: tracks.filter(
          (item): item is LocalLibraryTrack =>
            !!item && typeof item.rel === 'string' && typeof item.name === 'string',
        ),""",
    """        tracks: tracks
          .filter(
            (item): item is LocalLibraryTrack =>
              !!item && typeof item.rel === 'string' && typeof item.name === 'string',
          )
          .map((item) => ({ ...item, hasCover: item.hasCover === true })),""",
    tag="ts-normalize",
)
save(BRIDGE, bridge, bridge_crlf)
print("OK: bridge")

# ---------------------------------------------------------------- spaceShell.ts
shell, shell_crlf = load(SHELL)
shell = rep(
    shell,
    "  /** 用文件名 hash 生成一张渐变封面（24 套共享，省内存） */\n  function localCoverFor(name: string): string {",
    "  /** 内嵌封面地址（宿主 /__cover 返回图片字节） */\n"
    "  function localCoverUrl(rel: string): string {\n"
    "    return `https://localmusic.local/__cover?rel=${encodeURIComponent(rel)}`;\n"
    "  }\n\n"
    "  /** 用文件名 hash 生成一张渐变封面（24 套共享，省内存） */\n"
    "  function localCoverFor(name: string): string {",
    tag="ts-cover-url",
)
save(SHELL, shell, shell_crlf)
print("OK: shell-helper")
