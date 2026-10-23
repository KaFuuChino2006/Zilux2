using System;
using System.Collections.Generic;

namespace Zilux2.AirPlay.Crypto;

/// <summary>
/// HAP（HomeKit Accessory Protocol）TLV8 编解码。
///
/// HAP 配对的 pair-setup / pair-verify 请求体全部是 TLV8：每项 1 字节 type + 1 字节 length + value。
/// - value 超过 255 字节时按 255 字节分片，每片都带同一个 type（例如 SRP 的 B 有 384 字节 → 255 + 129）；
/// - 解析时把“相邻且同 type”的分片重新拼成一个逻辑值（pyatv / pair_ap 的行为）；
/// - type 0xFF 是分隔符，仅用于部分 HomeKit 场景，本实现按空值项保留。
///
/// 参考：pair_ap 的 pair-tlv.c、pyatv 的 tlv8.py，均为 MIT/开源实现，此处为独立重写。
/// </summary>
public static class HapTlvType
{
    public const byte Method = 0;          // 配对方法：0=PairSetup, 1=PairSetupWithAuth, 2=PairVerify, ...
    public const byte Identifier = 1;      // 客户端/设备标识（UTF-8 字符串）
    public const byte Salt = 2;            // SRP salt
    public const byte PublicKey = 3;       // SRP/曲线公钥
    public const byte Proof = 4;           // SRP 证明
    public const byte EncryptedData = 5;   // ChaCha20-Poly1305 加密的子 TLV（密文 + 16B tag）
    public const byte State = 6;           // 配对状态机序号：1..6
    public const byte Error = 7;           // 错误码（见 HapPairingError）
    public const byte RetryDelay = 8;      // 重试延迟（秒）
    public const byte Certificate = 9;     // 证书（传统 pair-setup）
    public const byte Signature = 10;      // Ed25519 签名（64B）
    public const byte Permissions = 11;    // 权限位
    public const byte FragmentData = 13;   // 分片数据
    public const byte FragmentLast = 14;   // 最后一片
    public const byte Flags = 19;          // 扩展标志（transient 配对 = 0x10）
    public const byte Separator = 0xFF;
}

/// <summary>TLV8 中解析出的一个逻辑项（分片已合并）。</summary>
public readonly struct HapTlvItem
{
    /// <summary>TLV type。</summary>
    public byte Type { get; }

    /// <summary>value（分片合并后的完整数据，可能为空数组）。</summary>
    public byte[] Value { get; }

    public HapTlvItem(byte type, byte[] value)
    {
        Type = type;
        Value = value;
    }

    public override string ToString() => $"TLV({Type}, {Value.Length}B)";
}

/// <summary>TLV8 编码器。</summary>
public sealed class HapTlvBuilder
{
    private readonly List<byte> _buffer = new();

    /// <summary>追加一项（自动分片）。</summary>
    public HapTlvBuilder Add(byte type, ReadOnlySpan<byte> value)
    {
        if (value.Length == 0)
        {
            _buffer.Add(type);
            _buffer.Add(0);
            return this;
        }

        // HAP：value 按 255 字节分片，每片 type 相同
        var offset = 0;
        while (offset < value.Length)
        {
            var chunk = Math.Min(255, value.Length - offset);
            _buffer.Add(type);
            _buffer.Add((byte)chunk);
            for (var i = 0; i < chunk; i++) _buffer.Add(value[offset + i]);
            offset += chunk;
        }
        return this;
    }

    /// <summary>追加一个单字节值（如 State/Method/Error）。</summary>
    public HapTlvBuilder AddByte(byte type, byte value) => Add(type, new[] { value });

    /// <summary>追加一个 ASCII/UTF-8 字符串（如 Identifier）。</summary>
    public HapTlvBuilder AddString(byte type, string value) => Add(type, CryptoPrimitives.Utf8(value));

    /// <summary>追加一个 4 字节大端整数（TLV 场景很少用，保留）。</summary>
    public HapTlvBuilder AddUInt32(byte type, uint value)
    {
        var bytes = new byte[4];
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32BigEndian(bytes, value);
        return Add(type, bytes);
    }

    /// <summary>生成 TLV8 字节流。</summary>
    public byte[] Build() => _buffer.ToArray();
}

/// <summary>TLV8 解码器。</summary>
public static class HapTlv
{
    /// <summary>
    /// 解析 TLV8 字节流。相邻同 type 的分片会合并成一个逻辑值。
    /// </summary>
    /// <exception cref="FormatException">字节流被截断。</exception>
    public static IReadOnlyList<HapTlvItem> Parse(ReadOnlySpan<byte> data)
    {
        var items = new List<HapTlvItem>();
        var offset = 0;
        while (offset < data.Length)
        {
            if (offset + 2 > data.Length)
            {
                throw new FormatException($"TLV8 截断：offset={offset}, 剩余 {data.Length - offset} 字节");
            }

            var type = data[offset];
            var length = data[offset + 1];
            offset += 2;
            if (offset + length > data.Length)
            {
                throw new FormatException($"TLV8 截断：type={type}, 需要 {length} 字节，剩 {data.Length - offset}");
            }

            var value = data.Slice(offset, length).ToArray();
            offset += length;

            // 相邻同 type 分片合并（pair_ap/pyatv 语义）；Separator 不合并
            if (type != HapTlvType.Separator && items.Count > 0 && items[^1].Type == type)
            {
                var previous = items[^1].Value;
                var merged = new byte[previous.Length + value.Length];
                previous.CopyTo(merged, 0);
                value.CopyTo(merged, previous.Length);
                items[^1] = new HapTlvItem(type, merged);
            }
            else
            {
                items.Add(new HapTlvItem(type, value));
            }
        }

        return items;
    }

    /// <summary>按 type 查找第一项，找不到返回 null。</summary>
    public static byte[]? Find(ReadOnlySpan<byte> data, byte type)
    {
        foreach (var item in Parse(data))
        {
            if (item.Type == type) return item.Value;
        }
        return null;
    }

    /// <summary>
    /// 解析并取出状态字节（每步响应都必须带 State）。
    /// </summary>
    /// <exception cref="HapPairingException">缺少 State 或 TLV 非法。</exception>
    public static (byte State, IReadOnlyList<HapTlvItem> Items) ParseWithState(ReadOnlySpan<byte> data, byte expectedState)
    {
        IReadOnlyList<HapTlvItem> items;
        try
        {
            items = Parse(data);
        }
        catch (FormatException ex)
        {
            throw new HapPairingException(HapPairingError.TlvError, $"TLV8 解析失败：{ex.Message}");
        }

        byte? state = null;
        foreach (var item in items)
        {
            if (item.Type == HapTlvType.State && item.Value.Length == 1) state = item.Value[0];
        }

        if (state is null) throw new HapPairingException(HapPairingError.TlvError, "响应里缺少 State");
        if (state.Value != expectedState)
        {
            throw new HapPairingException(HapPairingError.UnexpectedState,
                $"配对状态不匹配：期望 M{expectedState}，实际 M{state.Value}");
        }
        return (state.Value, items);
    }

    /// <summary>从解析结果里取指定 type 的原始 value；找不到返回 null。</summary>
    public static byte[]? GetValue(IReadOnlyList<HapTlvItem> items, byte type)
    {
        foreach (var item in items)
        {
            if (item.Type == type) return item.Value;
        }
        return null;
    }

    /// <summary>从解析结果里取必须存在的 type，缺失抛 <see cref="HapPairingException"/>。</summary>
    public static byte[] Require(IReadOnlyList<HapTlvItem> items, byte type, string name)
    {
        return GetValue(items, type)
               ?? throw new HapPairingException(HapPairingError.TlvError, $"响应里缺少 {name}(TLV type {type})");
    }
}

/// <summary>HAP 配对错误码（与 TLV Error 值一致）。</summary>
public enum HapPairingError
{
    UnknownError = 0x01,
    AuthenticationError = 0x02,
    BackoffError = 0x03,
    MaxPeersError = 0x04,
    MaxTriesError = 0x05,
    UnavailableError = 0x06,
    BusyError = 0x07,
    // 本地错误（不会发给设备）
    TlvError = 0x80,
    UnexpectedState = 0x81,
    ProtocolError = 0x82,
    Cancelled = 0x83,
    Rejected = 0x84,
}

/// <summary>HAP 配对过程中抛出的异常（带设备错误码或本地错误码）。</summary>
public sealed class HapPairingException : Exception
{
    /// <summary>配对错误码。</summary>
    public HapPairingError Error { get; }

    public HapPairingException(HapPairingError error, string message) : base(message) => Error = error;

    public HapPairingException(HapPairingError error, string message, Exception inner) : base(message, inner)
        => Error = error;

    /// <summary>错误码是否为设备返回（≤ 0x07）。</summary>
    public bool IsDeviceError => (byte)Error <= 0x07;
}
