using System;
using System.Numerics;
using System.Security.Cryptography;
using Zilux2.AirPlay.Crypto;

namespace AirPlayCryptoHarness;

/// <summary>
/// 基础工具测试：hex/base64 转换、BigInteger 大端往返、HKDF-SHA512（与手写 RFC 5869 流程对比）。
/// </summary>
public static class Tests_Misc
{
    public static void Register(TestRunner r)
    {
        r.Add("CryptoPrimitives：hex 往返 + 容错 base64", () =>
        {
            var bytes = Hex.Parse("00ff10a3bc4d");
            if (CryptoPrimitives.ToHex(bytes) != "00ff10a3bc4d") return false;
            if (!Hex.Eq(CryptoPrimitives.ParseHex("00 ff:10-A3 bc4D"), bytes)) return false;

            // App 侧 rsaaeskey / pk 常常省掉 '=' 填充，也要能解
            var b64 = Convert.ToBase64String(bytes);
            var unpadded = b64.TrimEnd('=');
            if (!Hex.Eq(CryptoPrimitives.Base64DecodeLenient(unpadded), bytes)) return false;
            if (!Hex.Eq(CryptoPrimitives.Base64DecodeLenient(b64), bytes)) return false;
            // Base64NoPadding 再解回来
            var strip = CryptoPrimitives.Base64NoPadding(bytes);
            if (strip.Contains('=')) return false;
            return Hex.Eq(CryptoPrimitives.Base64DecodeLenient(strip), bytes);
        });

        r.Add("CryptoPrimitives：BigInteger 大端无符号往返（0 → 空数组）", () =>
        {
            var values = new[] { "00", "01", "7f", "80", "ff01", "0102030405", "0abc" };
            foreach (var hex in values)
            {
                var bytes = Hex.Parse(hex);
                var number = CryptoPrimitives.FromBigEndian(bytes);
                var expected = bytes.AsSpan().TrimStart(new byte[] { 0 }).ToArray();
                var actual = CryptoPrimitives.ToBigEndianUnsigned(number);
                if (!Hex.Eq(actual, expected)) return false;
            }
            // 0 的约定：srptools/BouncyCastle 的 ToByteArrayUnsigned 返回空数组
            return CryptoPrimitives.ToBigEndianUnsigned(BigInteger.Zero).Length == 0;
        });

        r.Add("HKDF-SHA512：与手写 RFC 5869 extract/expand 一致", () =>
        {
            var ikm = Hex.Parse("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b");
            var salt = Hex.Parse("000102030405060708090a0b0c");
            var info = Hex.Parse("f0f1f2f3f4f5f6f7f8f9");

            // 手写 RFC 5869 流程（独立实现，用 BCL HMACSHA512）
            var prk = HMACSHA512.HashData(salt, ikm);
            var output = new byte[82];
            var t = Array.Empty<byte>();
            var offset = 0;
            for (var i = 1; offset < output.Length; i++)
            {
                var input = CryptoPrimitives.Concat(t, info, new[] { (byte)i });
                t = HMACSHA512.HashData(prk, input);
                var take = Math.Min(t.Length, output.Length - offset);
                Array.Copy(t, 0, output, offset, take);
                offset += take;
            }

            var actual = CryptoPrimitives.HkdfSha512(ikm, salt, info, 82);
            return TestRunner.CheckBytes("HKDF-SHA512", output, actual);
        });

        r.Add("SHA-512(abc) 已知向量", () =>
        {
            var expected = Hex.Parse(
                "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a" +
                "2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f");
            var actual = CryptoPrimitives.Sha512(CryptoPrimitives.Ascii("abc"));
            return TestRunner.CheckBytes("SHA-512(abc)", expected, actual);
        });
    }
}
