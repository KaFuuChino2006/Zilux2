using System;
using System.Collections.Concurrent;
using System.IO;
using System.Text;

namespace Zilux2.Local;

/// <summary>本地音频文件里读出来的标签（只取展示需要的字段）。</summary>
internal sealed class LocalTagInfo
{
    public string? Title { get; init; }

    public string? Artist { get; init; }

    public string? Album { get; init; }
}

/// <summary>
/// 轻量级音频标签读取：MP3(ID3v2/ID3v1)、FLAC(Vorbis Comment)、M4A/MP4(ilst)、
/// OGG/Opus(Vorbis Comment)、WAV(LIST INFO)。
/// 只读文件开头/结尾的有限字节，按 mtime+size 缓存结果，扫描几千首也不会拖慢。
/// </summary>
internal static class LocalTagReader
{
    private const int MaxCacheEntries = 4000;
    private const int MaxId3Bytes = 4 * 1024 * 1024;
    private const int MaxMoovBytes = 16 * 1024 * 1024;
    private const int ProbeBytes = 1024 * 1024;

    private static readonly ConcurrentDictionary<string, CacheEntry> Cache = new(StringComparer.OrdinalIgnoreCase);

    private readonly record struct CacheEntry(long Mtime, long Length, LocalTagInfo? Info);

    public static LocalTagInfo? TryRead(string path)
    {
        try
        {
            var fileInfo = new FileInfo(path);
            if (!fileInfo.Exists)
            {
                return null;
            }

            if (Cache.TryGetValue(path, out var cached) &&
                cached.Mtime == fileInfo.LastWriteTimeUtc.Ticks &&
                cached.Length == fileInfo.Length)
            {
                return cached.Info;
            }

            LocalTagInfo? result;
            try
            {
                result = Parse(path, fileInfo.Length);
            }
            catch (Exception exception)
            {
                HostLog.Warn($"[tag] read failed {Path.GetFileName(path)}: {exception.Message}");
                result = null;
            }

            if (Cache.Count > MaxCacheEntries)
            {
                Cache.Clear();
            }

            Cache[path] = new CacheEntry(fileInfo.LastWriteTimeUtc.Ticks, fileInfo.Length, result);
            return result;
        }
        catch
        {
            return null;
        }
    }

    private static LocalTagInfo? Parse(string path, long length)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite, 64 * 1024, FileOptions.SequentialScan);
        return Path.GetExtension(path).ToLowerInvariant() switch
        {
            ".mp3" => ParseMp3(stream, length),
            ".flac" => ParseFlac(stream, length),
            ".m4a" or ".mp4" or ".aac" or ".alac" => ParseMp4(stream, length),
            ".ogg" or ".opus" => ParseOgg(stream),
            ".wav" => ParseWav(stream, length),
            _ => null,
        };
    }

    /* ------------------------------ MP3 ------------------------------ */

    private static LocalTagInfo? ParseMp3(Stream stream, long length)
    {
        string? title = null;
        string? artist = null;
        string? album = null;

        var header = ReadAt(stream, 0, 10);
        if (header is not null && header[0] == 'I' && header[1] == 'D' && header[2] == '3')
        {
            var version = header[3];
            var flags = header[5];
            var tagSize = SyncSafe(header, 6);
            if (tagSize > 0 && tagSize <= MaxId3Bytes)
            {
                var tag = ReadAt(stream, 0, (int)Math.Min(tagSize, length));
                if (tag is not null && tag.Length > 10)
                {
                    var offset = 10;
                    if ((flags & 0x40) != 0 && tag.Length >= 14)
                    {
                        offset += version >= 4 ? SyncSafe(tag, 10) : 4 + Be32(tag, 10);
                    }

                    offset = Math.Max(10, Math.Min(offset, tag.Length));
                    while (offset + 10 <= tag.Length)
                    {
                        if (tag[offset] == 0)
                        {
                            break;
                        }

                        var id = Encoding.ASCII.GetString(tag, offset, 4);
                        var frameSize = version >= 4 ? SyncSafe(tag, offset + 4) : Be32(tag, offset + 4);
                        if (frameSize <= 0 || offset + 10 + frameSize > tag.Length)
                        {
                            break;
                        }

                        var dataOffset = offset + 10;
                        switch (id)
                        {
                            case "TIT2":
                                title ??= DecodeId3Text(tag, dataOffset, frameSize);
                                break;
                            case "TPE1":
                                artist ??= DecodeId3Text(tag, dataOffset, frameSize);
                                break;
                            case "TALB":
                                album ??= DecodeId3Text(tag, dataOffset, frameSize);
                                break;
                        }

                        offset = dataOffset + frameSize;
                    }
                }
            }
        }

        if (title is null || artist is null)
        {
            if (length >= 128)
            {
                var tail = ReadAt(stream, length - 128, 128);
                if (tail is not null && tail[0] == 'T' && tail[1] == 'A' && tail[2] == 'G')
                {
                    title ??= DecodeLatin1(tail, 3, 30);
                    artist ??= DecodeLatin1(tail, 33, 30);
                    album ??= DecodeLatin1(tail, 63, 30);
                }
            }
        }

        return Create(title, artist, album);
    }

    /* ------------------------------ FLAC ----------------------------- */

    private static LocalTagInfo? ParseFlac(Stream stream, long length)
    {
        var magic = ReadAt(stream, 0, 4);
        if (magic is null || magic[0] != 'f' || magic[1] != 'L' || magic[2] != 'a' || magic[3] != 'C')
        {
            return null;
        }

        string? title = null;
        string? artist = null;
        string? album = null;
        long position = 4;
        for (var guard = 0; guard < 128 && position + 4 <= length; guard += 1)
        {
            var blockHeader = ReadAt(stream, position, 4);
            if (blockHeader is null)
            {
                break;
            }

            var isLast = (blockHeader[0] & 0x80) != 0;
            var type = blockHeader[0] & 0x7F;
            var size = (blockHeader[1] << 16) | (blockHeader[2] << 8) | blockHeader[3];
            position += 4;
            if (size < 0 || position + size > length)
            {
                break;
            }

            if (type == 4 && size > 0 && size <= MaxId3Bytes)
            {
                var block = ReadAt(stream, position, size);
                if (block is not null)
                {
                    ParseVorbisComments(block, 0, block.Length, ref title, ref artist, ref album);
                }
            }

            position += size;
            if (isLast)
            {
                break;
            }
        }

        return Create(title, artist, album);
    }

    /* --------------------------- MP4 / M4A --------------------------- */

    private static LocalTagInfo? ParseMp4(Stream stream, long length)
    {
        byte[]? moov = null;
        long position = 0;
        for (var guard = 0; guard < 256 && position + 8 <= length; guard += 1)
        {
            var header = ReadAt(stream, position, 16);
            if (header is null)
            {
                break;
            }

            long size = Be32(header, 0);
            var type = Encoding.ASCII.GetString(header, 4, 4);
            var headerSize = 8L;
            if (size == 1)
            {
                if (header.Length < 16)
                {
                    break;
                }

                size = Be64(header, 8);
                headerSize = 16;
            }
            else if (size == 0)
            {
                size = length - position;
            }

            if (size < headerSize)
            {
                break;
            }

            if (type == "moov")
            {
                var read = (int)Math.Min(size, MaxMoovBytes);
                moov = ReadAt(stream, position, read);
                break;
            }

            position += size;
        }

        if (moov is null || moov.Length < 32)
        {
            return null;
        }

        var title = FindMp4Text(moov, 0xA9, (byte)'n', (byte)'a', (byte)'m');
        var artist = FindMp4Text(moov, 0xA9, (byte)'A', (byte)'R', (byte)'T');
        var album = FindMp4Text(moov, 0xA9, (byte)'a', (byte)'l', (byte)'b');
        return Create(title, artist, album);
    }

    private static string? FindMp4Text(byte[] moov, byte a, byte b, byte c, byte d)
    {
        for (var i = 4; i + 4 < moov.Length; i += 1)
        {
            if (moov[i] != a || moov[i + 1] != b || moov[i + 2] != c || moov[i + 3] != d)
            {
                continue;
            }

            var atomSize = Be32(moov, i - 4);
            if (atomSize < 16 || i - 4 + atomSize > moov.Length)
            {
                continue;
            }

            var limit = i - 4 + atomSize;
            for (var j = i + 4; j + 8 < limit; j += 1)
            {
                if (moov[j] != (byte)'d' || moov[j + 1] != (byte)'a' || moov[j + 2] != (byte)'t' || moov[j + 3] != (byte)'a')
                {
                    continue;
                }

                var dataSize = Be32(moov, j - 4);
                var contentStart = j + 12; // 'data' + version/flags(4) + locale(4)
                var contentEnd = Math.Min(limit, j - 4 + dataSize);
                if (dataSize < 16 || contentStart >= contentEnd)
                {
                    continue;
                }

                var bytes = new byte[contentEnd - contentStart];
                Array.Copy(moov, contentStart, bytes, 0, bytes.Length);
                return DecodeMp4Payload(bytes);
            }
        }

        return null;
    }

    private static string? DecodeMp4Payload(byte[] payload)
    {
        if (payload.Length >= 2 && payload[0] == 0xFF && payload[1] == 0xFE)
        {
            return CleanText(Encoding.Unicode.GetString(payload, 2, payload.Length - 2));
        }

        if (payload.Length >= 2 && payload[0] == 0xFE && payload[1] == 0xFF)
        {
            return CleanText(Encoding.BigEndianUnicode.GetString(payload, 2, payload.Length - 2));
        }

        return CleanText(Encoding.UTF8.GetString(payload));
    }

    /* --------------------------- OGG / Opus -------------------------- */

    private static LocalTagInfo? ParseOgg(Stream stream)
    {
        var probe = ReadAt(stream, 0, ProbeBytes);
        if (probe is null || probe.Length < 64)
        {
            return null;
        }

        string? title = null;
        string? artist = null;
        string? album = null;

        var opus = IndexOf(probe, Encoding.ASCII.GetBytes("OpusTags"));
        if (opus >= 0)
        {
            ParseVorbisComments(probe, opus + 8, probe.Length, ref title, ref artist, ref album);
        }
        else
        {
            var vorbis = IndexOf(probe, Encoding.ASCII.GetBytes("vorbis"));
            if (vorbis > 0)
            {
                var start = vorbis + 6 + 23; // 版本(4)+声道(1)+采样率(4)+3 个码率(12)+块大小(1)+帧标志(1)
                ParseVorbisComments(probe, start, probe.Length, ref title, ref artist, ref album);
            }
        }

        return Create(title, artist, album);
    }

    /* ------------------------------ WAV ------------------------------ */

    private static LocalTagInfo? ParseWav(Stream stream, long length)
    {
        var probe = ReadAt(stream, 0, (int)Math.Min(Math.Min(length, ProbeBytes), ProbeBytes));
        if (probe is null || probe.Length < 12 ||
            probe[0] != 'R' || probe[1] != 'I' || probe[2] != 'F' || probe[3] != 'F')
        {
            return null;
        }

        string? title = null;
        string? artist = null;
        string? album = null;
        var position = 12;
        while (position + 8 <= probe.Length)
        {
            var id = Encoding.ASCII.GetString(probe, position, 4);
            long size = Le32(probe, position + 4);
            var dataStart = position + 8;
            if (size < 0 || dataStart + size > probe.Length)
            {
                break;
            }

            if (id == "LIST" && size >= 4 && Encoding.ASCII.GetString(probe, dataStart, 4) == "INFO")
            {
                var inner = dataStart + 4;
                while (inner + 8 <= dataStart + size)
                {
                    var subId = Encoding.ASCII.GetString(probe, inner, 4);
                    var subSize = Le32(probe, inner + 4);
                    var subStart = inner + 8;
                    if (subSize <= 0 || subStart + subSize > dataStart + size)
                    {
                        break;
                    }

                    var text = CleanText(Encoding.UTF8.GetString(probe, subStart, subSize));
                    switch (subId)
                    {
                        case "INAM":
                            title ??= text;
                            break;
                        case "IART":
                            artist ??= text;
                            break;
                        case "IPRD":
                            album ??= text;
                            break;
                    }

                    inner = subStart + subSize + (subSize & 1);
                }
            }

            position = dataStart + (int)size + (int)(size & 1);
        }

        return Create(title, artist, album);
    }

    /* ---------------------------- helpers ---------------------------- */

    private static void ParseVorbisComments(byte[] buffer, int start, int end, ref string? title, ref string? artist, ref string? album)
    {
        if (start < 0 || start + 4 > end)
        {
            return;
        }

        var vendorLength = (int)Math.Min(Le32(buffer, start), end - start - 4);
        var position = start + 4 + Math.Max(0, vendorLength);
        if (position + 4 > end)
        {
            return;
        }

        var count = (int)Math.Min(Le32(buffer, position), 256);
        position += 4;
        for (var i = 0; i < count && position + 4 <= end; i += 1)
        {
            var length = (int)Le32(buffer, position);
            position += 4;
            if (length <= 0 || position + length > end)
            {
                break;
            }

            var text = Encoding.UTF8.GetString(buffer, position, length);
            position += length;
            var equals = text.IndexOf('=');
            if (equals <= 0)
            {
                continue;
            }

            var key = text[..equals].Trim().ToUpperInvariant();
            var value = CleanText(text[(equals + 1)..]);
            if (value is null)
            {
                continue;
            }

            switch (key)
            {
                case "TITLE":
                    title ??= value;
                    break;
                case "ARTIST":
                    artist ??= value;
                    break;
                case "ALBUM":
                    album ??= value;
                    break;
            }
        }
    }

    private static string? DecodeId3Text(byte[] buffer, int offset, int count)
    {
        if (count <= 0 || offset < 0 || offset + count > buffer.Length)
        {
            return null;
        }

        var encoding = buffer[offset];
        var start = offset + 1;
        var length = count - 1;
        if (length <= 0)
        {
            return null;
        }

        var text = encoding switch
        {
            1 => DecodeUtf16WithBom(buffer, start, length),
            2 => Encoding.BigEndianUnicode.GetString(buffer, start, length & ~1),
            3 => Encoding.UTF8.GetString(buffer, start, length),
            _ => DecodeLatin1(buffer, start, length),
        };
        return CleanText(text);
    }

    private static string DecodeUtf16WithBom(byte[] buffer, int start, int length)
    {
        if (length >= 2 && buffer[start] == 0xFF && buffer[start + 1] == 0xFE)
        {
            return Encoding.Unicode.GetString(buffer, start + 2, (length - 2) & ~1);
        }

        if (length >= 2 && buffer[start] == 0xFE && buffer[start + 1] == 0xFF)
        {
            return Encoding.BigEndianUnicode.GetString(buffer, start + 2, (length - 2) & ~1);
        }

        return Encoding.Unicode.GetString(buffer, start, length & ~1);
    }

    private static LocalTagInfo? Create(string? title, string? artist, string? album)
    {
        title = CleanText(title);
        artist = CleanText(artist);
        album = CleanText(album);
        if (artist is not null &&
            (artist.Equals("unknown", StringComparison.OrdinalIgnoreCase) ||
             artist.Equals("unknown artist", StringComparison.OrdinalIgnoreCase) ||
             artist == "未知" ||
             artist == "未知艺术家"))
        {
            artist = null;
        }

        if (title is null && artist is null && album is null)
        {
            return null;
        }

        return new LocalTagInfo { Title = title, Artist = artist, Album = album };
    }

    private static string? CleanText(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        var trimmed = value.Replace("\0", " ").Trim();
        if (trimmed.Length == 0)
        {
            return null;
        }

        // 去掉不可见控制字符（标签里偶尔混入 0x01-0x1F）。
        var builder = new StringBuilder(trimmed.Length);
        foreach (var character in trimmed)
        {
            if (character >= 0x20 || character == '\t')
            {
                builder.Append(character);
            }
        }

        var cleaned = builder.ToString().Trim();
        return cleaned.Length == 0 ? null : cleaned;
    }

    private static string? DecodeLatin1(byte[] buffer, int offset, int count)
    {
        if (count <= 0 || offset < 0 || offset + count > buffer.Length)
        {
            return null;
        }

        return CleanText(Encoding.Latin1.GetString(buffer, offset, count));
    }

    private static byte[]? ReadAt(Stream stream, long offset, int count)
    {
        if (count <= 0 || offset < 0 || offset > stream.Length)
        {
            return null;
        }

        var size = (int)Math.Min(count, stream.Length - offset);
        if (size <= 0)
        {
            return null;
        }

        var buffer = new byte[size];
        stream.Seek(offset, SeekOrigin.Begin);
        var read = 0;
        while (read < size)
        {
            var chunk = stream.Read(buffer, read, size - read);
            if (chunk <= 0)
            {
                break;
            }

            read += chunk;
        }

        if (read == size)
        {
            return buffer;
        }

        var trimmed = new byte[read];
        Array.Copy(buffer, trimmed, read);
        return trimmed;
    }

    private static int IndexOf(byte[] haystack, byte[] needle)
    {
        for (var i = 0; i <= haystack.Length - needle.Length; i += 1)
        {
            var match = true;
            for (var j = 0; j < needle.Length; j += 1)
            {
                if (haystack[i + j] != needle[j])
                {
                    match = false;
                    break;
                }
            }

            if (match)
            {
                return i;
            }
        }

        return -1;
    }

    private static int SyncSafe(byte[] buffer, int offset) =>
        ((buffer[offset] & 0x7F) << 21) |
        ((buffer[offset + 1] & 0x7F) << 14) |
        ((buffer[offset + 2] & 0x7F) << 7) |
        (buffer[offset + 3] & 0x7F);

    private static int Be32(byte[] buffer, int offset) =>
        (buffer[offset] << 24) | (buffer[offset + 1] << 16) | (buffer[offset + 2] << 8) | buffer[offset + 3];

    private static long Be64(byte[] buffer, int offset) =>
        ((long)Be32(buffer, offset) << 32) | (uint)Be32(buffer, offset + 4);

    private static int Le32(byte[] buffer, int offset) =>
        buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16) | (buffer[offset + 3] << 24);
}
