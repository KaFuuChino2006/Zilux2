using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using Zilux2.AirPlay.Crypto;

namespace AirPlayCryptoHarness;

/// <summary>
/// 测试向量运行器：逐项打印 PASS/FAIL，任何一项失败则进程退出码非 0。
/// </summary>
public sealed class TestRunner
{
    private readonly List<(string Name, Func<bool> Body)> _tests = new();

    /// <summary>输出编码（中文在 Windows 控制台可能乱码，统一用 UTF-8）。</summary>
    public static readonly Encoding ConsoleEncoding = new UTF8Encoding(false);

    public void Add(string name, Func<bool> body) => _tests.Add((name, body));

    /// <summary>添加一项测试；断言用 <see cref="Check"/> / <see cref="CheckBytes"/>。</summary>
    public void AddEqual(string name, string expected, string actual) => _tests.Add((name, () => Check(name, expected, actual)));

    public int Run(string? filter = null)
    {
        try { Console.OutputEncoding = ConsoleEncoding; } catch { /* 某些宿主不支持，忽略 */ }
        Console.WriteLine("========================================================");
        Console.WriteLine(" Zilux2 AirPlay Crypto — RFC 测试向量 harness");
        Console.WriteLine($" .NET: {Environment.Version}  runtime: {System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription}");
        Console.WriteLine($" 时间: {DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss zzz}");
        Console.WriteLine("========================================================");

        var passed = 0;
        var failed = 0;
        var index = 0;
        foreach (var (name, body) in _tests)
        {
            index++;
            if (filter is not null && !name.Contains(filter, StringComparison.OrdinalIgnoreCase)) continue;
            var ok = false;
            string? error = null;
            try
            {
                ok = body();
            }
            catch (Exception ex)
            {
                error = $"{ex.GetType().Name}: {ex.Message}";
            }

            if (ok) passed++;
            else failed++;

            var mark = ok ? "PASS" : "FAIL";
            Console.WriteLine($"[{index:D2}] {mark}  {name}");
            if (!ok && error is not null)
            {
                Console.WriteLine($"       └─ 异常: {error}");
            }
        }

        Console.WriteLine("--------------------------------------------------------");
        Console.WriteLine($"合计: {passed} PASS, {failed} FAIL（共 {passed + failed} 项）");
        Console.WriteLine(failed == 0 ? "结果: ALL PASS ✅" : "结果: 存在失败项 ❌");
        return failed == 0 ? 0 : 1;
    }

    /// <summary>断言字符串相等（打印期望/实际）。</summary>
    public static bool Check(string name, string expected, string actual)
    {
        if (string.Equals(expected, actual, StringComparison.Ordinal)) return true;
        Console.WriteLine($"       └─ 期望: {expected}");
        Console.WriteLine($"       └─ 实际: {actual}");
        return false;
    }

    /// <summary>断言字节序列相等（hex 打印，长度不同也打印长度）。</summary>
    public static bool CheckBytes(string name, ReadOnlySpan<byte> expected, ReadOnlySpan<byte> actual)
    {
        if (expected.Length == actual.Length && expected.SequenceEqual(actual)) return true;
        Console.WriteLine($"       └─ 期望({expected.Length}): {Convert.ToHexString(expected).ToLowerInvariant()}");
        Console.WriteLine($"       └─ 实际({actual.Length}): {Convert.ToHexString(actual).ToLowerInvariant()}");
        return false;
    }

    /// <summary>断言为 true。</summary>
    public static bool CheckTrue(string name, bool condition, string? detail = null)
    {
        if (condition) return true;
        if (detail is not null) Console.WriteLine($"       └─ {detail}");
        return false;
    }
}

/// <summary>字节/十六进制小工具（测试里用，避免和被测代码互相“自证”）。</summary>
public static class Hex
{
    public static byte[] Parse(string hex) => Convert.FromHexString(hex.Replace(" ", "").Replace("\n", "").Replace("\r", ""));

    public static string Of(ReadOnlySpan<byte> bytes) => Convert.ToHexString(bytes).ToLowerInvariant();

    public static bool Eq(ReadOnlySpan<byte> a, ReadOnlySpan<byte> b) => a.SequenceEqual(b);
}
