using System.Buffers.Binary;
using System.IO;
using System.Net;
using System.Text;

namespace Zilux2.AirPlay.Discovery;

/// <summary>
/// DNS 记录类型。mDNS / DNS-SD 里实际用到的子集；其余类型在解析时只保留原始字节、不解释。
/// 数值与 IANA DNS Parameters 一致。
/// </summary>
internal enum DnsRecordType : ushort
{
    A = 1,
    Ns = 2,
    Cname = 5,
    Soa = 6,
    Ptr = 12,
    Mx = 15,
    Txt = 16,
    Aaaa = 28,
    Srv = 33,
    Nsec = 47,
    Any = 255,
}

/// <summary>DNS 类。mDNS 只用 IN；查询里 class 最高位是 mDNS 私有的 QU（unicast response）标志。</summary>
internal enum DnsClass : ushort
{
    In = 1,
    Any = 255,
}

/// <summary>DNS 查询段里的一条 question。</summary>
internal sealed class DnsQuestion
{
    public DnsQuestion(string name, DnsRecordType type, DnsClass @class, bool unicastResponse)
    {
        Name = name;
        Type = type;
        Class = @class;
        UnicastResponse = unicastResponse;
    }

    /// <summary>查询名，例如 "_raop._tcp.local"（不带结尾的点）。</summary>
    public string Name { get; }

    public DnsRecordType Type { get; }

    public DnsClass Class { get; }

    /// <summary>mDNS 的 QU 位：置位表示请求方希望对方用单播回复。</summary>
    public bool UnicastResponse { get; }

    public override string ToString() =>
        $"{Name} type={(ushort)Type} class={(ushort)Class}{(UnicastResponse ? " QU" : "")}";
}

/// <summary>
/// 一条 DNS 资源记录（RR）。mDNS 的 answer / authority / additional 段都复用这个类型。
/// RDATA 只解析本项目需要的字段（PTR target、SRV 三段 + target、TXT 键值、A/AAAA 地址），
/// 其它类型留给 <see cref="UnparsedRDataHex"/> 便于调试，不影响整体解析。
/// </summary>
internal sealed class DnsRecord
{
    public DnsRecord(string name, DnsRecordType type, DnsClass @class, bool cacheFlush, uint timeToLiveSeconds)
    {
        Name = name;
        Type = type;
        Class = @class;
        CacheFlush = cacheFlush;
        TimeToLiveSeconds = timeToLiveSeconds;
    }

    /// <summary>记录 owner 名（不带结尾的点），比较时大小写不敏感。</summary>
    public string Name { get; }

    public DnsRecordType Type { get; }

    public DnsClass Class { get; }

    /// <summary>mDNS 响应里 class 的最高位是 cache-flush 标志（RFC 6762 §10.2）。</summary>
    public bool CacheFlush { get; }

    /// <summary>TTL（秒）。mDNS 里 0 表示"再见"（goodbye），应让缓存立即过期。</summary>
    public uint TimeToLiveSeconds { get; }

    // ---- PTR ----
    /// <summary>PTR / CNAME 指向的目标名。</summary>
    public string? PtrTarget { get; internal set; }

    // ---- SRV ----
    public ushort SrvPriority { get; internal set; }
    public ushort SrvWeight { get; internal set; }
    public ushort SrvPort { get; internal set; }
    public string? SrvTarget { get; internal set; }

    // ---- TXT ----
    /// <summary>TXT 键值对（按原始顺序保留，可能含无 '=' 的裸键，此时 value 为空串）。</summary>
    public IReadOnlyList<KeyValuePair<string, string>>? TxtEntries { get; internal set; }

    // ---- A / AAAA ----
    public IPAddress? Address { get; internal set; }

    /// <summary>未解析类型的 RDATA 十六进制（截断，便于调试，如 NSEC=47）。</summary>
    public string? UnparsedRDataHex { get; internal set; }

    /// <summary>缓存去重用的 RDATA 指纹（大小写不敏感部分统一转小写）。</summary>
    public string RDataKey()
    {
        switch (Type)
        {
            case DnsRecordType.Ptr:
                return "ptr:" + (PtrTarget ?? string.Empty).ToLowerInvariant();
            case DnsRecordType.Srv:
                return $"srv:{SrvPriority}:{SrvWeight}:{SrvPort}:{(SrvTarget ?? string.Empty).ToLowerInvariant()}";
            case DnsRecordType.Txt:
                var entries = TxtEntries;
                if (entries is null || entries.Count == 0)
                {
                    return "txt:";
                }
                var sb = new StringBuilder("txt:");
                foreach (var kv in entries)
                {
                    sb.Append(kv.Key).Append('=').Append(kv.Value).Append('\u0001');
                }
                return sb.ToString();
            case DnsRecordType.A:
            case DnsRecordType.Aaaa:
                return "addr:" + (Address?.ToString() ?? string.Empty);
            default:
                return "raw:" + (UnparsedRDataHex ?? string.Empty);
        }
    }

    /// <summary>把 TXT 记录转成字典；重复键以后出现的为准（mDNS 里同键重复是设备实现问题）。</summary>
    public Dictionary<string, string>? ToTxtDictionary()
    {
        if (Type != DnsRecordType.Txt || TxtEntries is null)
        {
            return null;
        }

        var dict = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var kv in TxtEntries)
        {
            dict[kv.Key] = kv.Value;
        }
        return dict;
    }

    public override string ToString()
    {
        var ttl = TimeToLiveSeconds;
        return Type switch
        {
            DnsRecordType.Ptr => $"PTR {Name} TTL={ttl} -> {PtrTarget}",
            DnsRecordType.Srv => $"SRV {Name} TTL={ttl} {SrvTarget}:{SrvPort} (prio={SrvPriority} weight={SrvWeight})",
            DnsRecordType.Txt => $"TXT {Name} TTL={ttl} [{string.Join(", ", (TxtEntries ?? Array.Empty<KeyValuePair<string, string>>()).Select(kv => kv.Key + "=" + kv.Value))}]",
            DnsRecordType.A or DnsRecordType.Aaaa => $"{Type} {Name} TTL={ttl} {Address}",
            _ => $"{Type}({(ushort)Type}) {Name} TTL={ttl} rdata={UnparsedRDataHex}",
        };
    }
}

/// <summary>
/// 一个完整的 DNS 报文（mDNS 查询或响应）。
/// 解析按 RFC 1035 线格式实现，兼容 name compression pointer（0xC0 高两位），
/// 记录数上限（<see cref="MaxRecords"/>）用于抵御畸形/恶意报文。
/// </summary>
internal sealed class DnsMessage
{
    public const int HeaderSize = 12;

    /// <summary>单段记录数上限。正常 mDNS 响应远小于此值。</summary>
    public const int MaxRecords = 512;

    public ushort TransactionId { get; private set; }

    public ushort Flags { get; private set; }

    public List<DnsQuestion> Questions { get; } = new();

    public List<DnsRecord> Answers { get; } = new();

    public List<DnsRecord> Authorities { get; } = new();

    public List<DnsRecord> Additionals { get; } = new();

    /// <summary>QR 位：true 表示响应包。</summary>
    public bool IsResponse => (Flags & 0x8000) != 0;

    /// <summary>AA 位：mDNS 响应一般置位。</summary>
    public bool IsAuthoritative => (Flags & 0x0400) != 0;

    /// <summary>TC 位：截断。</summary>
    public bool IsTruncated => (Flags & 0x0200) != 0;

    public int Opcode => (Flags >> 11) & 0x0F;

    public int ResponseCode => Flags & 0x0F;

    /// <summary>解析过程中遇到非致命格式问题时的说明（例如尾随垃圾数据）。</summary>
    public string? ParseWarning { get; private set; }

    /// <summary>按 answer → authority → additional 的顺序枚举所有记录。</summary>
    public IEnumerable<DnsRecord> AllRecords()
    {
        foreach (var record in Answers)
        {
            yield return record;
        }
        foreach (var record in Authorities)
        {
            yield return record;
        }
        foreach (var record in Additionals)
        {
            yield return record;
        }
    }

    /// <summary>
    /// 解析一个 DNS/mDNS 报文。返回 false 表示连报文头/问题段都无法解析；
    /// 单个 RR 损坏时返回 true 并在 <see cref="ParseWarning"/> 里说明，已解析的记录保留。
    /// </summary>
    public static bool TryParse(ReadOnlySpan<byte> data, out DnsMessage message, out string? error)
    {
        message = new DnsMessage();
        error = null;
        try
        {
            message.ParseCore(data);
            error = message.ParseWarning;
            return true;
        }
        catch (FormatException ex)
        {
            error = ex.Message;
            if (message.Questions.Count == 0 && message.Answers.Count == 0)
            {
                message = new DnsMessage();
                return false;
            }
            message.ParseWarning = ex.Message;
            return true;
        }
    }

    private void ParseCore(ReadOnlySpan<byte> data)
    {
        if (data.Length < HeaderSize)
        {
            throw new FormatException($"报文长度 {data.Length} 小于 DNS 头 12 字节");
        }

        TransactionId = BinaryPrimitives.ReadUInt16BigEndian(data);
        Flags = BinaryPrimitives.ReadUInt16BigEndian(data.Slice(2));
        int questionCount = BinaryPrimitives.ReadUInt16BigEndian(data.Slice(4));
        int answerCount = BinaryPrimitives.ReadUInt16BigEndian(data.Slice(6));
        int authorityCount = BinaryPrimitives.ReadUInt16BigEndian(data.Slice(8));
        int additionalCount = BinaryPrimitives.ReadUInt16BigEndian(data.Slice(10));

        int offset = HeaderSize;
        for (int i = 0; i < questionCount; i++)
        {
            Questions.Add(ReadQuestion(data, ref offset));
        }

        answerCount = Math.Min(answerCount, MaxRecords);
        authorityCount = Math.Min(authorityCount, MaxRecords);
        additionalCount = Math.Min(additionalCount, MaxRecords);
        try
        {
            ReadRecords(data, ref offset, answerCount, Answers);
            ReadRecords(data, ref offset, authorityCount, Authorities);
            ReadRecords(data, ref offset, additionalCount, Additionals);
        }
        catch (FormatException ex)
        {
            // 单条 RR 畸形：保留已解析部分，交由上层决定是否使用。
            ParseWarning = ex.Message;
        }
    }

    private static void ReadRecords(ReadOnlySpan<byte> data, ref int offset, int count, List<DnsRecord> into)
    {
        for (int i = 0; i < count; i++)
        {
            if (offset >= data.Length)
            {
                throw new FormatException($"记录段需要 {count} 条，但报文在 {offset} 字节处结束");
            }
            into.Add(ReadRecord(data, ref offset));
        }
    }

    private static DnsQuestion ReadQuestion(ReadOnlySpan<byte> data, ref int offset)
    {
        string name = ReadName(data, ref offset);
        if (offset + 4 > data.Length)
        {
            throw new FormatException("question 段被截断");
        }
        ushort type = BinaryPrimitives.ReadUInt16BigEndian(data.Slice(offset));
        ushort classRaw = BinaryPrimitives.ReadUInt16BigEndian(data.Slice(offset + 2));
        offset += 4;
        return new DnsQuestion(name, (DnsRecordType)type, (DnsClass)(classRaw & 0x7FFF), (classRaw & 0x8000) != 0);
    }

    private static DnsRecord ReadRecord(ReadOnlySpan<byte> data, ref int offset)
    {
        string name = ReadName(data, ref offset);
        if (offset + 10 > data.Length)
        {
            throw new FormatException($"@{offset} 资源记录头被截断（至少需要 10 字节）");
        }

        ushort typeRaw = BinaryPrimitives.ReadUInt16BigEndian(data.Slice(offset));
        ushort classRaw = BinaryPrimitives.ReadUInt16BigEndian(data.Slice(offset + 2));
        uint ttl = BinaryPrimitives.ReadUInt32BigEndian(data.Slice(offset + 4));
        ushort dataLength = BinaryPrimitives.ReadUInt16BigEndian(data.Slice(offset + 8));
        offset += 10;

        if (offset + dataLength > data.Length)
        {
            throw new FormatException($"@{offset} RDATA 长度 {dataLength} 超出报文剩余 {data.Length - offset} 字节");
        }

        var record = new DnsRecord(
            name,
            (DnsRecordType)typeRaw,
            (DnsClass)(classRaw & 0x7FFF),
            (classRaw & 0x8000) != 0,
            ttl);

        int rdataStart = offset;
        int rdataEnd = offset + dataLength;

        switch (record.Type)
        {
            case DnsRecordType.Ptr:
            case DnsRecordType.Cname:
            {
                int inner = rdataStart;
                record.PtrTarget = ReadName(data, ref inner);
                break;
            }

            case DnsRecordType.Srv:
            {
                if (dataLength < 6)
                {
                    throw new FormatException($"SRV RDATA 长度 {dataLength} < 6");
                }
                record.SrvPriority = BinaryPrimitives.ReadUInt16BigEndian(data.Slice(rdataStart));
                record.SrvWeight = BinaryPrimitives.ReadUInt16BigEndian(data.Slice(rdataStart + 2));
                record.SrvPort = BinaryPrimitives.ReadUInt16BigEndian(data.Slice(rdataStart + 4));
                int inner = rdataStart + 6;
                record.SrvTarget = ReadName(data, ref inner);
                break;
            }

            case DnsRecordType.Txt:
            {
                var entries = new List<KeyValuePair<string, string>>();
                int cursor = rdataStart;
                while (cursor < rdataEnd)
                {
                    int length = data[cursor];
                    cursor++;
                    if (cursor + length > rdataEnd)
                    {
                        throw new FormatException($"TXT 条目长度 {length} 越界");
                    }
                    string text = Encoding.UTF8.GetString(data.Slice(cursor, length));
                    cursor += length;
                    if (text.Length == 0)
                    {
                        // 空字符串条目（很多设备发一个长度为 0 的条目表示"没有 TXT"），跳过。
                        continue;
                    }
                    int equals = text.IndexOf('=');
                    entries.Add(equals < 0
                        ? new KeyValuePair<string, string>(text, string.Empty)
                        : new KeyValuePair<string, string>(text.Substring(0, equals), text.Substring(equals + 1)));
                }
                record.TxtEntries = entries;
                break;
            }

            case DnsRecordType.A:
            {
                if (dataLength != 4)
                {
                    throw new FormatException($"A RDATA 长度 {dataLength} != 4");
                }
                record.Address = new IPAddress(data.Slice(rdataStart, 4));
                break;
            }

            case DnsRecordType.Aaaa:
            {
                if (dataLength != 16)
                {
                    throw new FormatException($"AAAA RDATA 长度 {dataLength} != 16");
                }
                record.Address = new IPAddress(data.Slice(rdataStart, 16));
                break;
            }

            default:
            {
                int dumpLength = Math.Min((int)dataLength, 24);
                record.UnparsedRDataHex = Convert.ToHexString(data.Slice(rdataStart, dumpLength));
                break;
            }
        }

        offset = rdataEnd;
        return record;
    }

    /// <summary>
    /// 读取一个域名，处理压缩指针。offset 返回"该名字之后的逻辑位置"：
    /// 若名字以指针结尾，则指向指针字段之后；否则指向 0 终止符之后。
    /// </summary>
    private static string ReadName(ReadOnlySpan<byte> data, ref int offset)
    {
        int position = offset;
        int resumeAt = -1;
        int jumps = 0;
        int totalLength = 0;
        var labels = new List<string>(4);

        while (true)
        {
            if (position >= data.Length)
            {
                throw new FormatException($"@{position} 域名读取越界");
            }

            byte length = data[position];
            if (length == 0)
            {
                position++;
                break;
            }

            if ((length & 0xC0) == 0xC0)
            {
                if (position + 1 >= data.Length)
                {
                    throw new FormatException("压缩指针被截断");
                }
                int pointer = ((length & 0x3F) << 8) | data[position + 1];
                if (resumeAt < 0)
                {
                    resumeAt = position + 2;
                }
                if (pointer >= data.Length)
                {
                    throw new FormatException($"压缩指针 {pointer} 越界（报文 {data.Length} 字节）");
                }
                if (++jumps > 16)
                {
                    throw new FormatException("压缩指针跳转次数过多，疑似成环");
                }
                position = pointer;
                continue;
            }

            if ((length & 0xC0) != 0)
            {
                throw new FormatException($"@{-position} 非法标签长度字节 0x{length:X2}");
            }

            position++;
            if (position + length > data.Length)
            {
                throw new FormatException($"@{position} 标签内容越界");
            }
            labels.Add(Encoding.UTF8.GetString(data.Slice(position, length)));
            totalLength += length + 1;
            if (totalLength > 255)
            {
                throw new FormatException("域名总长度超过 255 字节");
            }
            position += length;
        }

        offset = resumeAt >= 0 ? resumeAt : position;
        return string.Join('.', labels);
    }
}

/// <summary>
/// mDNS 查询报文构造器。只构造 PTR 类型的问题（DNS-SD 服务浏览就靠 PTR）。
/// 查询用 QM（multicast response）语义，class 置 IN，不设 QU 位。
/// </summary>
internal static class MdnsQueryWriter
{
    /// <summary>构造标准 mDNS 查询：header + 每个服务名一条 PTR question。</summary>
    public static byte[] BuildQuery(IEnumerable<string> serviceTypes)
    {
        var names = new List<string>();
        foreach (var raw in serviceTypes)
        {
            if (string.IsNullOrWhiteSpace(raw))
            {
                continue;
            }
            names.Add(NormalizeName(raw));
        }
        if (names.Count == 0)
        {
            throw new ArgumentException("至少需要一个查询名", nameof(serviceTypes));
        }
        if (names.Count > 100)
        {
            throw new ArgumentException("查询名过多", nameof(serviceTypes));
        }

        using var stream = new MemoryStream(64);
        Span<byte> header = stackalloc byte[DnsMessage.HeaderSize];
        header.Clear();
        BinaryPrimitives.WriteUInt16BigEndian(header, 0); // 事务 ID：mDNS 固定为 0
        BinaryPrimitives.WriteUInt16BigEndian(header.Slice(2), 0); // standard query，非响应
        BinaryPrimitives.WriteUInt16BigEndian(header.Slice(4), (ushort)names.Count);
        // an/ns/ar 均为 0
        stream.Write(header);

        // CA2014：stackalloc 必须放在循环外复用，避免每轮迭代增长栈帧。
        Span<byte> questionTail = stackalloc byte[4];
        foreach (var name in names)
        {
            WriteName(stream, name);
            BinaryPrimitives.WriteUInt16BigEndian(questionTail, (ushort)DnsRecordType.Ptr);
            BinaryPrimitives.WriteUInt16BigEndian(questionTail.Slice(2), (ushort)DnsClass.In);
            stream.Write(questionTail);
        }

        return stream.ToArray();
    }

    /// <summary>去掉结尾的点；空名/超长名抛异常。</summary>
    internal static string NormalizeName(string name)
    {
        string trimmed = name.Trim().TrimEnd('.');
        if (trimmed.Length == 0)
        {
            throw new ArgumentException("查询名不能为空", nameof(name));
        }
        return trimmed;
    }

    /// <summary>按 DNS 线格式写入域名（不做压缩，查询报文只有几条问题，压缩没有收益）。</summary>
    internal static void WriteName(Stream stream, string name)
    {
        foreach (var label in name.TrimEnd('.').Split('.'))
        {
            var bytes = Encoding.UTF8.GetBytes(label);
            if (bytes.Length == 0)
            {
                continue;
            }
            if (bytes.Length > 63)
            {
                throw new ArgumentException($"DNS 标签超过 63 字节: {label}", nameof(name));
            }
            stream.WriteByte((byte)bytes.Length);
            stream.Write(bytes);
        }
        stream.WriteByte(0);
    }
}
