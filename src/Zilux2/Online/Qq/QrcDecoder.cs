using System.IO;
using System.IO.Compression;
using System.Text;

namespace Zilux2.Online.Qq;

// QQ QRC 解密（非标准 3DES + zlib），移植自 qrc-decoder 1.0.2
// （web/node_modules/qrc-decoder/dist/qrc_codec.mjs）。
//
// 这里的 “3DES” 不是标准 DES：S 盒、P 盒、E 盒和密钥字节的位序都是 QQ 音乐私有的，
// 只有 Feistel 结构和 PC-1/PC-2 式的位选取沿用 DES 的写法。常量表由 Node 脚本
// 直接从 npm 包的数组字面量解析生成，没有手工录入，避免抄错 DES 表。
//
// 数据流：hex → 每 8 字节一段，依次过 3 套轮密钥（KEY_3 解密、KEY_2 加密、KEY_1 解密）
// → zlib inflate → 去掉 UTF-8 BOM → 前后带 XML 的 QRC 歌词文本。
//
// 该实现只用于解析歌词，不承担任何安全职责。
internal static class QrcDecoder
{
    private const int BlockSize = 8;

    // 解压结果上限：正常 QRC 歌词几十 KB，超过这个量级只可能是异常响应。
    private const int MaxInflatedBytes = 8 * 1024 * 1024;

    // 28 位密钥分量存在一个 32 位字的高 28 位，低 4 位始终为 0。
    private const uint Bits28Mask = 0xFFFFFFF0u;

    private static readonly byte[] Key1 = Encoding.ASCII.GetBytes("!@#)(*$%");
    private static readonly byte[] Key2 = Encoding.ASCII.GetBytes("123ZXC!@");
    private static readonly byte[] Key3 = Encoding.ASCII.GetBytes("!@#)(NHL");

    private static readonly int[][] SBoxes =
    [
        [
            14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7,
            0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8,
            4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0,
            15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13
        ],
        [
            15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10,
            3, 13, 4, 7, 15, 2, 8, 15, 12, 0, 1, 10, 6, 9, 11, 5,
            0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15,
            13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9
        ],
        [
            10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8,
            13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1,
            13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7,
            1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12
        ],
        [
            7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15,
            13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9,
            10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4,
            3, 15, 0, 6, 10, 10, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14
        ],
        [
            2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9,
            14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6,
            4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14,
            11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3
        ],
        [
            12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11,
            10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8,
            9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6,
            4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13
        ],
        [
            4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1,
            13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6,
            1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2,
            6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12
        ],
        [
            13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7,
            1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2,
            7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8,
            2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11
        ],
    ];

    private static readonly int[] PBox =
    [
        16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10,
        2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25
    ];

    private static readonly int[] EBoxTable =
    [
        32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11,
        12, 13, 12, 13, 14, 15, 16, 17, 16, 17, 18, 19, 20, 21, 20, 21,
        22, 23, 24, 25, 24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1
    ];

    private static readonly int[] KeyRndShift =
    [
        1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1
    ];

    private static readonly int[] KeyPermC =
    [
        56, 48, 40, 32, 24, 16, 8, 0, 57, 49, 41, 33, 25, 17, 9, 1,
        58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35
    ];

    private static readonly int[] KeyPermD =
    [
        62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5,
        60, 52, 44, 36, 28, 20, 12, 4, 27, 19, 11, 3
    ];

    private static readonly int[] KeyCompression =
    [
        13, 16, 10, 23, 0, 4, 2, 27, 14, 5, 20, 9, 22, 18, 11, 3,
        25, 7, 15, 6, 26, 19, 12, 1, 40, 51, 30, 36, 46, 54, 29, 39,
        50, 44, 32, 47, 43, 48, 38, 55, 33, 52, 45, 41, 49, 35, 28, 31
    ];

    private static readonly int[] IpRule =
    [
        34, 42, 50, 58, 2, 10, 18, 26, 36, 44, 52, 60, 4, 12, 20, 28,
        38, 46, 54, 62, 6, 14, 22, 30, 40, 48, 56, 64, 8, 16, 24, 32,
        33, 41, 49, 57, 1, 9, 17, 25, 35, 43, 51, 59, 3, 11, 19, 27,
        37, 45, 53, 61, 5, 13, 21, 29, 39, 47, 55, 63, 7, 15, 23, 31
    ];

    private static readonly int[] InvIpRule =
    [
        37, 5, 45, 13, 53, 21, 61, 29, 38, 6, 46, 14, 54, 22, 62, 30,
        39, 7, 47, 15, 55, 23, 63, 31, 40, 8, 48, 16, 56, 24, 64, 32,
        33, 1, 41, 9, 49, 17, 57, 25, 34, 2, 42, 10, 50, 18, 58, 26,
        35, 3, 43, 11, 51, 19, 59, 27, 36, 4, 44, 12, 52, 20, 60, 28
    ];

    private static readonly uint[] IpLeftTable = new uint[2048];
    private static readonly uint[] IpRightTable = new uint[2048];
    private static readonly uint[] InvIpLeftTable = new uint[2048];
    private static readonly uint[] InvIpRightTable = new uint[2048];
    private static readonly uint[] SpTable = new uint[512];
    private static readonly uint[] EBoxHighTable = new uint[1024];
    private static readonly uint[] EBoxLowTable = new uint[1024];

    // decryptBlock 的三段 schedule，顺序固定：KEY_3 解密 → KEY_2 加密 → KEY_1 解密。
    private static readonly uint[] DecryptScheduleKey3;
    private static readonly uint[] DecryptScheduleKey2;
    private static readonly uint[] DecryptScheduleKey1;

    static QrcDecoder()
    {
        GeneratePermutationTables();
        GenerateSpTables();
        GenerateEBoxTables();
        DecryptScheduleKey3 = KeySchedule(Key3, decrypt: true);
        DecryptScheduleKey2 = KeySchedule(Key2, decrypt: false);
        DecryptScheduleKey1 = KeySchedule(Key1, decrypt: true);
    }

    /// <summary>
    /// 把 QQ 歌词接口返回的 qrc 十六进制串解密成完整 XML 文本。
    /// 长度不是 8 的倍数、非法 hex、inflate 失败等任何异常都返回 <c>null</c>，不向调用方抛异常。
    /// </summary>
    internal static string? TryDecrypt(string? encryptedHex)
    {
        if (encryptedHex is null)
        {
            // 接口没给 qrc 字段是常见情况（只有 LRC），不算错误，不刷日志。
            return null;
        }

        byte[] cipher;
        try
        {
            // 大小写不敏感；奇数长度或非十六进制字符会抛 FormatException。
            cipher = Convert.FromHexString(encryptedHex);
        }
        catch (FormatException)
        {
            OnlineHttp.Warn("QRC 解密失败：qrc 字段不是合法的十六进制串");
            return null;
        }

        if (cipher.Length == 0)
        {
            OnlineHttp.Warn("QRC 解密失败：qrc 字段为空");
            return null;
        }

        if (cipher.Length % BlockSize != 0)
        {
            OnlineHttp.Warn("QRC 解密失败：密文长度 " + cipher.Length + " 不是 8 的倍数");
            return null;
        }

        var plain = new byte[cipher.Length];
        Span<byte> temp1 = stackalloc byte[BlockSize];
        Span<byte> temp2 = stackalloc byte[BlockSize];
        for (var offset = 0; offset < cipher.Length; offset += BlockSize)
        {
            DecryptBlock(
                cipher.AsSpan(offset, BlockSize),
                plain.AsSpan(offset, BlockSize),
                temp1,
                temp2);
        }

        var inflated = Inflate(plain);
        if (inflated is null)
        {
            return null;
        }

        // QQ 的明文有时带 UTF-8 BOM，pako 版本会显式剥掉，这里保持一致。
        var start = 0;
        if (inflated.Length >= 3 && inflated[0] == 0xEF && inflated[1] == 0xBB && inflated[2] == 0xBF)
        {
            start = 3;
        }

        return Encoding.UTF8.GetString(inflated, start, inflated.Length - start);
    }

    private static void DecryptBlock(ReadOnlySpan<byte> input, Span<byte> output, Span<byte> temp1, Span<byte> temp2)
    {
        DesCrypt(input, temp1, DecryptScheduleKey3);
        DesCrypt(temp1, temp2, DecryptScheduleKey2);
        DesCrypt(temp2, output, DecryptScheduleKey1);
    }

    private static byte[]? Inflate(byte[] data)
    {
        try
        {
            using var input = new MemoryStream(data, writable: false);
            using var zlib = new ZLibStream(input, CompressionMode.Decompress);
            using var output = new MemoryStream(Math.Max(data.Length, 256));
            var buffer = new byte[81920];
            int read;
            while ((read = zlib.Read(buffer, 0, buffer.Length)) > 0)
            {
                // 正常歌词远小于 1 MB；给异常响应留一个上限，避免解压炸弹把进程撑爆。
                if (output.Length + read > MaxInflatedBytes)
                {
                    OnlineHttp.Warn("QRC 解密失败：解压后超过 " + MaxInflatedBytes + " 字节");
                    return null;
                }

                output.Write(buffer, 0, read);
            }

            return output.ToArray();
        }
        catch (InvalidDataException)
        {
            OnlineHttp.Warn("QRC 解密失败：zlib 流非法");
            return null;
        }
        catch (IOException)
        {
            OnlineHttp.Warn("QRC 解密失败：zlib 解压被截断");
            return null;
        }
    }

    // DES 密钥调度：从 8 字节密钥生成 16 个 48 位轮密钥，按高 24 位 / 低 24 位拆成 32 个 int。
    // decrypt 为真时轮密钥倒序写入，等价于解密。
    private static uint[] KeySchedule(byte[] key, bool decrypt)
    {
        var schedule = new uint[32];
        var c = PermuteFromKeyBytes(key, KeyPermC) << 4;
        var d = PermuteFromKeyBytes(key, KeyPermD) << 4;
        for (var i = 0; i < 16; i++)
        {
            c = RotateLeft28(c, KeyRndShift[i]);
            d = RotateLeft28(d, KeyRndShift[i]);

            var target = decrypt ? 15 - i : i;
            // 轮密钥是 48 位，必须用 ulong 累加：uint 的移位量会被掩码成 5 位，1u << 46 会变成 1u << 14。
            var subkey = 0UL;
            for (var k = 0; k < KeyCompression.Length; k++)
            {
                var position = KeyCompression[k];
                var bit = position < 28
                    ? (c >> (31 - position)) & 1u
                    : (d >> (31 - (position - 27))) & 1u;
                if (bit != 0)
                {
                    subkey |= 1UL << (47 - k);
                }
            }

            schedule[target * 2] = (uint)(subkey >> 24) & 0xFFFFFFu;
            schedule[(target * 2) + 1] = (uint)subkey & 0xFFFFFFu;
        }

        return schedule;
    }

    // 从 8 字节密钥里按置换表取位：字按小端序拆成两个 32 位整数，第 0 位取 key[3] 的最高位。
    private static uint PermuteFromKeyBytes(byte[] key, int[] table)
    {
        var output = 0u;
        var bitMask = 1u << (table.Length - 1);
        foreach (var position in table)
        {
            var wordIndex = position >> 5;
            var bitInWord = position & 31;
            var byteInWord = bitInWord >> 3;
            var bitInByte = bitInWord & 7;
            if (((key[(wordIndex * 4) + 3 - byteInWord] >> (7 - bitInByte)) & 1) != 0)
            {
                output |= bitMask;
            }

            bitMask >>= 1;
        }

        return output;
    }

    private static uint RotateLeft28(uint value, int amount)
    {
        var val = value & Bits28Mask;
        return ((val << amount) | (val >> (28 - amount))) & Bits28Mask;
    }

    private static void GeneratePermutationTables()
    {
        for (var bytePosition = 0; bytePosition < 8; bytePosition++)
        {
            for (var byteValue = 0; byteValue < 256; byteValue++)
            {
                var index = (bytePosition << 8) | byteValue;
                ApplyPermutation(byteValue, bytePosition, IpRule, out var left, out var right);
                IpLeftTable[index] = left;
                IpRightTable[index] = right;
                ApplyPermutation(byteValue, bytePosition, InvIpRule, out var invLeft, out var invRight);
                InvIpLeftTable[index] = invLeft;
                InvIpRightTable[index] = invRight;
            }
        }
    }

    // 把单个字节放在 64 位块的 bytePosition 位置，按 1-based 规则表做置换，输出高/低 32 位。
    private static void ApplyPermutation(int byteValue, int bytePosition, int[] rule, out uint left, out uint right)
    {
        var input = (ulong)byteValue << (56 - (bytePosition * 8));
        var permuted = 0UL;
        for (var i = 0; i < 64; i++)
        {
            var sourceBit = rule[i];
            if (((input >> (64 - sourceBit)) & 1UL) != 0)
            {
                permuted |= 1UL << (63 - i);
            }
        }

        left = (uint)(permuted >> 32);
        right = (uint)permuted;
    }

    // S-P 合并表：S 盒输出先放到 32 位中间结果的高半区，再做一次 P 盒置换。
    private static void GenerateSpTables()
    {
        for (var sBoxIndex = 0; sBoxIndex < 8; sBoxIndex++)
        {
            for (var sBoxInput = 0; sBoxInput < 64; sBoxInput++)
            {
                var sBoxOutput = SBoxes[sBoxIndex][CalculateSboxIndex(sBoxInput)];
                var prePBox = (uint)sBoxOutput << (28 - (sBoxIndex * 4));
                SpTable[(sBoxIndex << 6) | sBoxInput] = ApplyQqPboxPermutation(prePBox);
            }
        }
    }

    // 6 位输入重排成 S 盒行/列索引：首尾两位拼行号，中间四位是列号（QQ 的私有位序）。
    private static int CalculateSboxIndex(int value) =>
        (value & 32) | ((value & 31) >> 1) | ((value & 1) << 4);

    private static uint ApplyQqPboxPermutation(uint input)
    {
        var output = 0u;
        for (var i = 0; i < 32; i++)
        {
            var destMask = 1u << (31 - i);
            if ((input & (1u << (32 - PBox[i]))) != 0)
            {
                output |= destMask;
            }
        }

        return output;
    }

    // E 盒把 32 位右半块扩成 48 位，这里按 4 个字节位置各建一张表，拆成高/低 24 位。
    private static void GenerateEBoxTables()
    {
        for (var chunkIndex = 0; chunkIndex < 4; chunkIndex++)
        {
            var shift = (3 - chunkIndex) * 8;
            for (var byteValue = 0; byteValue < 256; byteValue++)
            {
                var input = (uint)byteValue << shift;
                var high24 = 0u;
                var low24 = 0u;
                for (var i = 0; i < 24; i++)
                {
                    if (((input >> (32 - EBoxTable[i])) & 1u) != 0)
                    {
                        high24 |= 1u << (23 - i);
                    }
                }

                for (var i = 24; i < 48; i++)
                {
                    if (((input >> (32 - EBoxTable[i])) & 1u) != 0)
                    {
                        low24 |= 1u << (47 - i);
                    }
                }

                var index = (chunkIndex << 8) | byteValue;
                EBoxHighTable[index] = high24;
                EBoxLowTable[index] = low24;
            }
        }
    }

    private static uint FFunction(uint state, uint keyHigh24, uint keyLow24)
    {
        var b0 = (int)((state >> 24) & 0xFF);
        var b1 = (int)((state >> 16) & 0xFF);
        var b2 = (int)((state >> 8) & 0xFF);
        var b3 = (int)(state & 0xFF);

        var eboxHigh24 = EBoxHighTable[b0]
            | EBoxHighTable[256 | b1]
            | EBoxHighTable[512 | b2]
            | EBoxHighTable[768 | b3];
        var eboxLow24 = EBoxLowTable[b0]
            | EBoxLowTable[256 | b1]
            | EBoxLowTable[512 | b2]
            | EBoxLowTable[768 | b3];

        var xorHigh24 = eboxHigh24 ^ keyHigh24;
        var xorLow24 = eboxLow24 ^ keyLow24;

        return SpTable[(int)((xorHigh24 >> 18) & 63)]
            | SpTable[64 | (int)((xorHigh24 >> 12) & 63)]
            | SpTable[128 | (int)((xorHigh24 >> 6) & 63)]
            | SpTable[192 | (int)(xorHigh24 & 63)]
            | SpTable[256 | (int)((xorLow24 >> 18) & 63)]
            | SpTable[320 | (int)((xorLow24 >> 12) & 63)]
            | SpTable[384 | (int)((xorLow24 >> 6) & 63)]
            | SpTable[448 | (int)(xorLow24 & 63)];
    }

    private static void DesCrypt(ReadOnlySpan<byte> input, Span<byte> output, uint[] schedule)
    {
        var left = 0u;
        var right = 0u;
        for (var i = 0; i < 8; i++)
        {
            var index = (i << 8) | input[i];
            left |= IpLeftTable[index];
            right |= IpRightTable[index];
        }

        for (var i = 0; i < 15; i++)
        {
            var temp = right;
            right = left ^ FFunction(right, schedule[i * 2], schedule[(i * 2) + 1]);
            left = temp;
        }

        left ^= FFunction(right, schedule[30], schedule[31]);

        var outLeft = 0u;
        var outRight = 0u;
        for (var i = 0; i < 4; i++)
        {
            var leftIndex = (i << 8) | (int)((left >> (24 - (i * 8))) & 0xFF);
            outLeft |= InvIpLeftTable[leftIndex];
            outRight |= InvIpRightTable[leftIndex];

            var rightIndex = ((i + 4) << 8) | (int)((right >> (24 - (i * 8))) & 0xFF);
            outLeft |= InvIpLeftTable[rightIndex];
            outRight |= InvIpRightTable[rightIndex];
        }

        output[0] = (byte)(outLeft >> 24);
        output[1] = (byte)(outLeft >> 16);
        output[2] = (byte)(outLeft >> 8);
        output[3] = (byte)outLeft;
        output[4] = (byte)(outRight >> 24);
        output[5] = (byte)(outRight >> 16);
        output[6] = (byte)(outRight >> 8);
        output[7] = (byte)outRight;
    }
}
