using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace Zilux2.Storage;

/// <summary>
/// 原子落盘：先写同目录临时文件，再 <see cref="File.Move(string,string,bool)"/> 覆盖。
///
/// 为什么必须走这里：直接 <c>File.WriteAllText(target, …)</c> 在写到一半时断电/被杀进程，
/// 目标文件就变成「长度已改、内容不全」的半截 JSON/TXT —— 下次读它会解析失败，
/// 表现为「配置丢了」「缓存全废」「下载根全没」。
///
/// 临时文件名带 GUID：旧代码用固定的 <c>path + ".tmp"</c>，两个写入方并发时
/// 会互相覆盖对方的临时文件，Move 时抛 IOException，然后被 catch 吞掉（静默丢写）。
/// </summary>
internal static class AtomicFile
{
    internal static void WriteAllText(string path, string contents, Encoding? encoding = null)
    {
        var temp = TempPathFor(path);
        try
        {
            File.WriteAllText(temp, contents, encoding ?? new UTF8Encoding(false));
            File.Move(temp, path, overwrite: true);
        }
        catch
        {
            TryDelete(temp);
            throw;
        }
    }

    internal static void WriteLines(string path, IEnumerable<string> lines)
    {
        var temp = TempPathFor(path);
        try
        {
            File.WriteAllLines(temp, lines, new UTF8Encoding(false));
            File.Move(temp, path, overwrite: true);
        }
        catch
        {
            TryDelete(temp);
            throw;
        }
    }

    internal static void WriteAllBytes(string path, byte[] bytes)
    {
        var temp = TempPathFor(path);
        try
        {
            File.WriteAllBytes(temp, bytes);
            File.Move(temp, path, overwrite: true);
        }
        catch
        {
            TryDelete(temp);
            throw;
        }
    }

    private static string TempPathFor(string path) =>
        path + "." + Guid.NewGuid().ToString("N") + ".tmp";

    private static void TryDelete(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch
        {
            // 清理失败不影响主流程：下一个写入方会用自己的 GUID 临时文件。
        }
    }
}
