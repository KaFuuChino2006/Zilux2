using System.IO;
using System.Security.Cryptography;

namespace Zilux2.Wallpaper.Media;

/// <summary>
/// 去重用的文件指纹（第 36 轮）：整文件 SHA-256 在几十 GB 的壁纸库上太慢，
/// 这里取「大小 + 头 1MB + 尾 64KB」做 SHA-256——碰撞概率对壁纸去重足够低，
/// 且大文件也能在几十毫秒内算完。
/// </summary>
internal static class FileHasher
{
    private const int HeadBytes = 1024 * 1024;
    private const int TailBytes = 64 * 1024;

    /// <summary>计算指纹；读不到文件返回 null（扫描时按“跳过”处理）。</summary>
    public static string? Compute(string path)
    {
        try
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            var length = stream.Length;

            using var sha = SHA256.Create();
            Span<byte> sizeBytes = stackalloc byte[8];
            BitConverter.TryWriteBytes(sizeBytes, length);
            sha.TransformBlock(sizeBytes.ToArray(), 0, 8, null, 0);

            var headLength = (int)Math.Min(HeadBytes, length);
            if (headLength > 0)
            {
                var buffer = new byte[headLength];
                stream.ReadExactly(buffer, 0, headLength);
                sha.TransformBlock(buffer, 0, headLength, null, 0);
            }

            if (length > HeadBytes + TailBytes)
            {
                stream.Seek(-TailBytes, SeekOrigin.End);
                var buffer = new byte[TailBytes];
                stream.ReadExactly(buffer, 0, TailBytes);
                sha.TransformBlock(buffer, 0, TailBytes, null, 0);
            }

            sha.TransformFinalBlock(Array.Empty<byte>(), 0, 0);
            return Convert.ToHexString(sha.Hash ?? Array.Empty<byte>()).ToLowerInvariant();
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }
}
