using System.Security.Cryptography;
using System.Text;

namespace Zilux2.Online.Qq;

// QQ 音乐 CGI 接口的 zzc 签名（research/qqmusic-api.md §2）。
//
// 协议事实来自对该接口黑盒请求的独立观察与 research 文档，不复制任何第三方实现；
// qqmusic-api-python 是 GPL-3.0，Zilux2 是 MIT，这里只按文档描述重新实现。
//
// 算法（输入必须是**实际发送的 JSON 文本**，不是重新序列化后的等价对象）：
//   1. hex = SHA1(UTF-8(json)) 的大写 40 字符十六进制串；
//   2. part1 = hex[23] hex[14] hex[6] hex[36] hex[16] hex[7] hex[19]（7 字符）；
//   3. part2 = hex[16] hex[1] hex[32] hex[12] hex[19] hex[27] hex[8] hex[5]（8 字符）；
//   4. 20 字节 part3[i] = Scramble[i] XOR byte(hex[2i..2i+2])；
//   5. b64 = Base64(part3)，去掉 '\\' '/' '+' '=' 四类字符；
//   6. sign = ("zzc" + part1 + b64 + part2) 转小写。
// 请求时把 sign 与毫秒时间戳放进查询串：?sign=<sign>&_=<unix ms>。
internal static class QqApiSigner
{
    // 固定混淆表，20 字节，与 SHA1 输出的前 20 字节逐字节异或。
    private static readonly byte[] Scramble =
    [
        89, 39, 179, 150, 218, 82, 58, 252, 177, 52,
        186, 123, 120, 64, 242, 133, 143, 161, 121, 179,
    ];

    private static readonly int[] PartOneIndexes = [23, 14, 6, 36, 16, 7, 19];
    private static readonly int[] PartTwoIndexes = [16, 1, 32, 12, 19, 27, 8, 5];

    /// <summary>
    /// 对将要发送的 JSON 文本计算 zzc 签名。调用方必须把同一个字符串同时用于签名和请求体，
    /// 任何重新格式化（空格、键序）都会让服务端返回 code=2000。
    /// </summary>
    internal static string Sign(string payload)
    {
        ArgumentNullException.ThrowIfNull(payload);

        // Convert.ToHexString 输出大写十六进制，与协议要求一致。
        var hex = Convert.ToHexString(SHA1.HashData(Encoding.UTF8.GetBytes(payload)));

        var part1 = Pick(hex, PartOneIndexes);
        var part2 = Pick(hex, PartTwoIndexes);

        Span<byte> shuffled = stackalloc byte[Scramble.Length];
        for (var i = 0; i < shuffled.Length; i++)
        {
            shuffled[i] = (byte)(Scramble[i] ^ Convert.ToByte(hex.Substring(i * 2, 2), 16));
        }

        var base64 = Convert.ToBase64String(shuffled);
        var builder = new StringBuilder(base64.Length);
        foreach (var ch in base64)
        {
            // 协议要求去掉转义符、路径分隔符、加号和填充。
            if (ch is '\\' or '/' or '+' or '=')
            {
                continue;
            }

            builder.Append(ch);
        }

        return ("zzc" + part1 + builder + part2).ToLowerInvariant();
    }

    private static string Pick(string hex, int[] indexes)
    {
        var builder = new StringBuilder(indexes.Length);
        foreach (var index in indexes)
        {
            builder.Append(hex[index]);
        }

        return builder.ToString();
    }
}
