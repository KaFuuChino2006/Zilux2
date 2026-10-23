using System.Globalization;
using System.Net;
using System.Text;

namespace Zilux2.AirPlay.Discovery;

/// <summary>设备被发现时命中的 DNS-SD 服务类型。</summary>
internal enum AirPlayServiceType
{
    /// <summary>RAOP（AirPlay 1 音频）：_raop._tcp，RTSP 端口通常是 5000。</summary>
    Raop,

    /// <summary>AirPlay（音视频/镜像）：_airplay._tcp，端口通常是 7000。</summary>
    AirPlay,
}

/// <summary>
/// 一台可投送的 AirPlay/RAOP 接收端。
/// 由 <see cref="AirPlayDiscovery"/> 从 mDNS 记录聚合而来；同一台设备可能同时广播
/// _raop._tcp 与 _airplay._tcp 两个服务，聚合时会合并成这一条对象（raop 记录优先）。
/// 所有属性只读，实例可跨线程安全读取（构造完成后不再修改）。
/// </summary>
internal sealed class AirPlayDevice
{
    private readonly Dictionary<string, string> _txt;
    private readonly AirPlayTxtInfo _info;

    internal AirPlayDevice(
        string serviceName,
        string fullServiceName,
        AirPlayServiceType primaryServiceType,
        string name,
        string? macAddress,
        IPAddress address,
        int? raopPort,
        int? airplayPort,
        Dictionary<string, string> txt)
    {
        ServiceName = serviceName;
        FullServiceName = fullServiceName;
        ServiceType = primaryServiceType;
        Name = name;
        MacAddress = macAddress;
        Address = address;
        RaopPort = raopPort;
        AirPlayPort = airplayPort;
        _txt = txt;
        _info = AirPlayTxtInfo.Parse(txt);
        Signature = BuildSignature();
    }

    // ---------------- 基础连接信息 ----------------

    /// <summary>人类可读名称。RAOP 取服务名 "MAC@房间名" 里 @ 后面的部分；AirPlay 取服务实例名本身。</summary>
    public string Name { get; }

    /// <summary>连接地址。IPv4 优先；只有 AAAA 记录时才用 IPv6。</summary>
    public IPAddress Address { get; }

    /// <summary>IP 字符串形式（IPv6 不含 scope id），方便直接拼 RTSP URL。</summary>
    public string Host => Address.ToString();

    /// <summary>主服务端口：优先 RAOP 端口，其次 AirPlay 端口。0 表示缺失（正常不会出现）。</summary>
    public int Port => RaopPort ?? AirPlayPort ?? 0;

    /// <summary>主服务类型（合并记录时固定为 <see cref="AirPlayServiceType.Raop"/>）。</summary>
    public AirPlayServiceType ServiceType { get; }

    /// <summary>是否声明了 RAOP 服务（可以走 AirPlay 1 音频流）。</summary>
    public bool HasRaopService => RaopPort.HasValue;

    /// <summary>是否声明了 AirPlay 服务（AirPlay 2 / 镜像能力）。</summary>
    public bool HasAirPlayService => AirPlayPort.HasValue;

    /// <summary>RAOP RTSP 端口（_raop._tcp SRV 端口，通常 5000）。</summary>
    public int? RaopPort { get; }

    /// <summary>AirPlay 端口（_airplay._tcp SRV 端口，通常 7000）。</summary>
    public int? AirPlayPort { get; }

    /// <summary>主服务实例名（不含服务类型后缀），例如 "AABBCCDDEEFF@客厅" / "客厅"。</summary>
    public string ServiceName { get; }

    /// <summary>主服务实例的完整名，例如 "AABBCCDDEEFF@客厅._raop._tcp.local"。</summary>
    public string FullServiceName { get; }

    /// <summary>
    /// 设备 MAC 地址，格式 "AA:BB:CC:DD:EE:FF"。来自 RAOP 服务实例名前缀，
    /// 或 _airplay._tcp 的 deviceid（若其形如 MAC）。没有可靠来源时为 null。
    /// </summary>
    public string? MacAddress { get; }

    /// <summary>原始 TXT 键值（键大小写不敏感）。合并了 raop 与 airplay 两份记录，raop 优先。</summary>
    public IReadOnlyDictionary<string, string> Txt => _txt;

    // ---------------- TXT 派生信息 ----------------

    /// <summary>
    /// 型号 ID，例如 "AppleTV6,2"、"AudioAccessory1,1"。
    /// 取 AirPlay 服务的 TXT model；RAOP 服务没有 model 键时回退 RAOP 的 am（型号名）。
    /// 注意：RAOP 的 md 不是型号，而是"支持的元数据类型"（0,1,2），这里不采用。
    /// </summary>
    public string? Model => _info.Model;

    /// <summary>型号名称，例如 "HomePod"（TXT am）。</summary>
    public string? ModelName => _info.ModelName;

    /// <summary>设备固件/协议版本，例如 "130.14"（RAOP 的 vs、AirPlay 的 srcvers）。</summary>
    public string? Version => _info.Version;

    /// <summary>AirPlay 2 版本字符串，例如 "2"（TXT vv）。AirPlay 2 设备才有。</summary>
    public string? AirPlay2Version => _info.AirPlay2Version;

    /// <summary>设备 ID（_airplay._tcp 的 deviceid，常见为 MAC 或 UUID 形式）。</summary>
    public string? DeviceId => _info.DeviceId;

    /// <summary>配对公钥（TXT pk，十六进制）。AirPlay 2 配对/HAP 用到。</summary>
    public string? PublicKey => _info.PublicKey;

    /// <summary>是否要求密码才能播放（TXT pw=true/1）。</summary>
    public bool IsPasswordProtected => _info.IsPasswordProtected;

    /// <summary>
    /// 是否支持 AirPlay 2。判定规则（保守启发式）：
    /// 存在 TXT vv；或 / 与 vs（srcvers）主版本号 &gt;= 130。
    /// 说明：AirPlay 1 时代设备（AirPort Express、Apple TV 3）版本号通常 &lt; 110，
    /// 也有的发布 _airplay._tcp 但仅支持 AirPlay 1，因此以 vv/版本号为准。
    /// </summary>
    public bool SupportsAirPlay2 => _info.SupportsAirPlay2;

    /// <summary>
    /// 特性位（TXT ft / _airplay._tcp 的 features）。按 Apple 约定解析为 64 位：
    /// 逗号分隔两个 32 位十六进制数时，前者是低 32 位、后者是高 32 位（"0x5A7FFFF7,0x1E" ⇒ 0x0000001E5A7FFFF7）。
    /// 未声明时为 null。
    /// </summary>
    public ulong? Features => _info.Features;

    /// <summary>状态位（TXT sf / _airplay._tcp 的 flags）。未声明时为 null。</summary>
    public uint? StatusFlags => _info.StatusFlags;

    /// <summary>支持的加密类型（TXT et，例如 0=无、1=RSA、4=FairPlay、5=MFi）。</summary>
    public IReadOnlyList<int> EncryptionTypes => _info.EncryptionTypes;

    /// <summary>
    /// RAOP 支持的元数据类型（TXT md，例如 0=文本、1=封面、2=进度）。注意：md 不是型号！
    /// 未声明时为空列表。
    /// </summary>
    public IReadOnlyList<int> MetadataTypes => _info.MetadataTypes;

    /// <summary>音频通道位掩码（TXT cn，例如 0,1,2,3）。</summary>
    public IReadOnlyList<int> AudioChannels => _info.AudioChannels;

    /// <summary>采样率（TXT sr，例如 44100）。未声明时为 null。</summary>
    public int? SampleRate => _info.SampleRate;

    /// <summary>位深（TXT ss，例如 16）。未声明时为 null。</summary>
    public int? SampleSize => _info.SampleSize;

    /// <summary>传输协议（RAOP 的 tp，通常为 "UDP"）。</summary>
    public string? Transport => _info.Transport;

    // ---------------- 内部辅助 ----------------

    /// <summary>用于发现器判断"设备集合是否变化"的指纹（含关键 TXT，不含易变字段如端口外的无关项）。</summary>
    internal string Signature { get; }

    private string BuildSignature()
    {
        var sb = new StringBuilder(160);
        sb.Append(Name).Append('|')
            .Append(Host).Append('|')
            .Append(ServiceType).Append('|')
            .Append(RaopPort?.ToString(CultureInfo.InvariantCulture) ?? "-").Append('|')
            .Append(AirPlayPort?.ToString(CultureInfo.InvariantCulture) ?? "-").Append('|')
            .Append(MacAddress ?? "-").Append('|')
            .Append(Model ?? "-").Append('|')
            .Append(ModelName ?? "-").Append('|')
            .Append(Version ?? "-").Append('|')
            .Append(AirPlay2Version ?? "-").Append('|')
            .Append(Features?.ToString("X", CultureInfo.InvariantCulture) ?? "-").Append('|')
            .Append(SupportsAirPlay2).Append(IsPasswordProtected);

        if (_txt.Count > 0)
        {
            sb.Append('|');
            foreach (var key in _txt.Keys.OrderBy(k => k, StringComparer.OrdinalIgnoreCase))
            {
                sb.Append(key).Append('=').Append(_txt[key]).Append(';');
            }
        }
        return sb.ToString();
    }

    /// <summary>
    /// 从一条 SRV + TXT + 地址记录构造设备对象。SRV 记录名即服务实例完整名，例如
    /// "AABBCCDDEEFF@客厅._raop._tcp.local"。
    /// </summary>
    internal static AirPlayDevice Create(
        AirPlayServiceType serviceType,
        DnsRecord srvRecord,
        IPAddress address,
        IReadOnlyDictionary<string, string>? txt)
    {
        if (srvRecord.Type != DnsRecordType.Srv)
        {
            throw new ArgumentException("需要 SRV 记录", nameof(srvRecord));
        }

        string fullName = srvRecord.Name;
        string suffix = serviceType == AirPlayServiceType.Raop ? "._raop._tcp.local" : "._airplay._tcp.local";
        string instance = StripSuffix(fullName, suffix);

        var txtDict = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (txt is not null)
        {
            foreach (var kv in txt)
            {
                txtDict[kv.Key] = kv.Value;
            }
        }

        string name;
        string? mac;
        if (serviceType == AirPlayServiceType.Raop)
        {
            SplitRaopInstance(instance, out mac, out name);
        }
        else
        {
            name = instance;
            mac = null;
        }

        if (mac is null &&
            txtDict.TryGetValue("deviceid", out var deviceId) &&
            AirPlayTxtInfo.TryNormalizeMac(deviceId, out var fromTxtMac))
        {
            mac = fromTxtMac;
        }

        if (string.IsNullOrWhiteSpace(name))
        {
            name = mac ?? instance;
        }

        int? raopPort = serviceType == AirPlayServiceType.Raop ? srvRecord.SrvPort : null;
        int? airplayPort = serviceType == AirPlayServiceType.AirPlay ? srvRecord.SrvPort : null;

        return new AirPlayDevice(instance, fullName, serviceType, name, mac, address, raopPort, airplayPort, txtDict);
    }

    /// <summary>
    /// 合并同一台设备的 RAOP 与 AirPlay 两条记录：raop 作为主记录，airplay 仅补充缺失信息
    /// （例如 AirPlay2 的 vv/features/pk/deviceid）。两个入参必须是同一设备。
    /// </summary>
    internal static AirPlayDevice Merge(AirPlayDevice primary, AirPlayDevice secondary)
    {
        var txt = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        // 先铺 airplay 的 TXT，再让 raop 覆盖：raop 记录是音频投送的主依据。
        foreach (var kv in secondary._txt)
        {
            txt[kv.Key] = kv.Value;
        }
        foreach (var kv in primary._txt)
        {
            txt[kv.Key] = kv.Value;
        }

        AirPlayDevice raop = primary.HasRaopService ? primary : secondary;
        AirPlayDevice airplay = ReferenceEquals(raop, primary) ? secondary : primary;

        int? raopPort = primary.RaopPort ?? secondary.RaopPort;
        int? airplayPort = primary.AirPlayPort ?? secondary.AirPlayPort;

        string name = !string.IsNullOrWhiteSpace(primary.Name) ? primary.Name : secondary.Name;
        // 主记录名称可能是 MAC 前缀形式，优先取 @ 之后的房间名；已有显示名则保留。
        string? mac = raop.MacAddress ?? airplay.MacAddress;

        return new AirPlayDevice(
            raop.ServiceName,
            raop.FullServiceName,
            AirPlayServiceType.Raop,
            name,
            mac,
            raop.Address,
            raopPort,
            airplayPort,
            txt);
    }

    /// <summary>去掉 ".local" 和结尾的点，得到可比较的主机名。</summary>
    internal static string NormalizeHostName(string hostName)
    {
        string name = hostName.Trim().TrimEnd('.');
        if (name.EndsWith(".local", StringComparison.OrdinalIgnoreCase))
        {
            name = name.Substring(0, name.Length - ".local".Length);
        }
        return name.TrimEnd('.');
    }

    private static string StripSuffix(string fullName, string suffix)
    {
        if (fullName.EndsWith(suffix, StringComparison.OrdinalIgnoreCase))
        {
            return fullName.Substring(0, fullName.Length - suffix.Length);
        }
        // 有些设备把 PTR 目标名以 ".local" 结尾但实例名大小写不同，做一次宽松匹配。
        int index = fullName.IndexOf("._", StringComparison.Ordinal);
        return index > 0 ? fullName.Substring(0, index) : fullName;
    }

    /// <summary>拆 RAOP 实例名 "AABBCCDDEEFF@客厅" 为 MAC 与显示名。</summary>
    internal static void SplitRaopInstance(string instance, out string? mac, out string name)
    {
        int at = instance.IndexOf('@');
        if (at > 0)
        {
            string prefix = instance.Substring(0, at);
            name = instance.Substring(at + 1);
            mac = AirPlayTxtInfo.TryNormalizeMac(prefix, out var normalized) ? normalized : null;
            if (!string.IsNullOrWhiteSpace(name))
            {
                return;
            }
            name = instance;
            return;
        }

        mac = null;
        name = instance;
    }

    public override string ToString()
    {
        var sb = new StringBuilder(96);
        sb.Append(Name).Append(" @ ").Append(Host).Append(':').Append(Port)
            .Append(" (").Append(ServiceType == AirPlayServiceType.Raop ? "raop" : "airplay");
        if (HasRaopService && HasAirPlayService)
        {
            sb.Append(", raop+airplay");
        }
        sb.Append(')');
        if (Model is not null)
        {
            sb.Append(" model=").Append(Model);
        }
        if (Version is not null)
        {
            sb.Append(" vs=").Append(Version);
        }
        sb.Append(SupportsAirPlay2 ? " airplay2" : " airplay1");
        sb.Append(IsPasswordProtected ? " password" : " no-password");
        return sb.ToString();
    }
}

/// <summary>从 TXT 字典解析出的派生信息，构造 <see cref="AirPlayDevice"/> 时算一次。</summary>
internal sealed class AirPlayTxtInfo
{
    private AirPlayTxtInfo()
    {
    }

    public string? Model { get; private init; }

    public string? ModelName { get; private init; }

    public string? Version { get; private init; }

    public string? AirPlay2Version { get; private init; }

    public string? DeviceId { get; private init; }

    public string? PublicKey { get; private init; }

    public string? Transport { get; private init; }

    public bool IsPasswordProtected { get; private init; }

    public bool SupportsAirPlay2 { get; private init; }

    public ulong? Features { get; private init; }

    public uint? StatusFlags { get; private init; }

    public IReadOnlyList<int> EncryptionTypes { get; private init; } = Array.Empty<int>();

    public IReadOnlyList<int> MetadataTypes { get; private init; } = Array.Empty<int>();

    public IReadOnlyList<int> AudioChannels { get; private init; } = Array.Empty<int>();

    public int? SampleRate { get; private init; }

    public int? SampleSize { get; private init; }

    internal static AirPlayTxtInfo Parse(IReadOnlyDictionary<string, string> txt)
    {
        // RAOP 与 AirPlay 服务的 TXT 键名不同，做别名兼容：
        //   vs      (RAOP)      / srcvers (AirPlay)
        //   ft      (RAOP)      / features(AirPlay)
        //   sf      (RAOP 状态位)/ flags   (AirPlay)
        // 型号：AirPlay 服务用 model（如 "AudioAccessory5,1"），RAOP 服务没有 model，
        // 用 am（型号名，同样形如 "AudioAccessory5,1"）兜底。
        // 真实设备坑：RAOP 的 md 是"支持的元数据类型"（如 "0,1,2" = 文本/封面/进度），
        // 不是型号，绝不能拿来当 Model（早期实现踩过：HomePod 的 Model 显示成 "0,1,2"）。
        string? version = First(txt, "vs", "srcvers");
        string? vv = First(txt, "vv");
        string? model = First(txt, "model", "am");
        string? versionMajorText = First(txt, "vs", "srcvers");
        int versionMajor = ParseVersionMajor(versionMajorText);

        bool supportsAirPlay2 = !string.IsNullOrWhiteSpace(vv) || versionMajor >= 130;

        string? featuresText = First(txt, "ft", "features");
        ulong? features = TryParseFeatureFlags(featuresText, out var parsedFeatures) ? parsedFeatures : null;

        string? flagsText = First(txt, "sf", "flags");
        uint? statusFlags = TryParseUInt32(flagsText, out var parsedFlags) ? parsedFlags : null;

        string? pwText = First(txt, "pw");
        bool passwordProtected = pwText is not null && ParseBool(pwText) == true;

        return new AirPlayTxtInfo
        {
            Model = model,
            ModelName = First(txt, "am"),
            Version = version,
            AirPlay2Version = vv,
            DeviceId = First(txt, "deviceid"),
            PublicKey = First(txt, "pk"),
            Transport = First(txt, "tp"),
            IsPasswordProtected = passwordProtected,
            SupportsAirPlay2 = supportsAirPlay2,
            Features = features,
            StatusFlags = statusFlags,
            EncryptionTypes = ParseIntList(First(txt, "et")),
            MetadataTypes = ParseIntList(First(txt, "md")),
            AudioChannels = ParseIntList(First(txt, "cn")),
            SampleRate = TryParseInt32(First(txt, "sr"), out var sr) ? sr : null,
            SampleSize = TryParseInt32(First(txt, "ss"), out var ss) ? ss : null,
        };
    }

    private static string? First(IReadOnlyDictionary<string, string> txt, params string[] keys)
    {
        foreach (var key in keys)
        {
            if (txt.TryGetValue(key, out var value) && !string.IsNullOrEmpty(value))
            {
                return value;
            }
        }
        return null;
    }

    /// <summary>取版本号主版本："130.14" ⇒ 130，"366" ⇒ 366，"2.0" ⇒ 2。失败返回 -1。</summary>
    internal static int ParseVersionMajor(string? version)
    {
        if (string.IsNullOrWhiteSpace(version))
        {
            return -1;
        }
        int end = 0;
        while (end < version.Length && char.IsAsciiDigit(version[end]))
        {
            end++;
        }
        if (end == 0)
        {
            return -1;
        }
        return int.TryParse(version.AsSpan(0, end), NumberStyles.None, CultureInfo.InvariantCulture, out var value)
            ? value
            : -1;
    }

    /// <summary>
    /// 解析 ft/features。Apple 用两个 32 位十六进制数表示 64 位特性位，低 32 位在前：
    /// "0x5A7FFFF7,0x1E" ⇒ 0x1E5A7FFFF7。也接受单个十进制/十六进制数。
    /// </summary>
    internal static bool TryParseFeatureFlags(string? raw, out ulong features)
    {
        features = 0;
        if (string.IsNullOrWhiteSpace(raw))
        {
            return false;
        }

        string[] parts = raw.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 1)
        {
            return TryParseUInt64(parts[0], out features);
        }
        if (parts.Length != 2)
        {
            return false;
        }
        if (!TryParseUInt64(parts[0], out var low) || !TryParseUInt64(parts[1], out var high))
        {
            return false;
        }
        features = low | (high << 32);
        return true;
    }

    private static bool TryParseUInt64(string text, out ulong value)
    {
        text = text.Trim();
        if (text.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
        {
            return ulong.TryParse(text.AsSpan(2), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out value);
        }
        if (ulong.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out value))
        {
            return true;
        }
        return ulong.TryParse(text, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out value);
    }

    private static bool TryParseUInt32(string? text, out uint value)
    {
        value = 0;
        if (string.IsNullOrWhiteSpace(text))
        {
            return false;
        }
        text = text.Trim();
        if (text.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
        {
            return uint.TryParse(text.AsSpan(2), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out value);
        }
        return uint.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out value);
    }

    private static bool TryParseInt32(string? text, out int value)
    {
        value = 0;
        if (string.IsNullOrWhiteSpace(text))
        {
            return false;
        }
        return int.TryParse(text.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out value);
    }

    private static bool? ParseBool(string raw)
    {
        string value = raw.Trim();
        if (value.Equals("true", StringComparison.OrdinalIgnoreCase) || value == "1" || value.Equals("yes", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }
        if (value.Equals("false", StringComparison.OrdinalIgnoreCase) || value == "0" || value.Equals("no", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }
        return null;
    }

    /// <summary>解析逗号分隔的整数列表（et/cn），如 "0,1,2,3"。</summary>
    internal static IReadOnlyList<int> ParseIntList(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return Array.Empty<int>();
        }
        var result = new List<int>(4);
        foreach (var part in raw.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
        {
            if (int.TryParse(part, NumberStyles.Integer, CultureInfo.InvariantCulture, out var value))
            {
                result.Add(value);
            }
        }
        return result;
    }

    /// <summary>把 "AABBCCDDEEFF" / "AA-BB-CC-DD-EE-FF" / "aa:bb:cc:dd:ee:ff" 统一成 "AA:BB:CC:DD:EE:FF"。</summary>
    internal static bool TryNormalizeMac(string? raw, out string mac)
    {
        mac = string.Empty;
        if (string.IsNullOrWhiteSpace(raw))
        {
            return false;
        }
        var hex = new StringBuilder(12);
        foreach (char c in raw)
        {
            if (c is ':' or '-' or '.' or ' ' or '_')
            {
                continue;
            }
            if (!Uri.IsHexDigit(c))
            {
                return false;
            }
            hex.Append(char.ToUpperInvariant(c));
        }
        if (hex.Length != 12)
        {
            return false;
        }
        mac = string.Join(':', Enumerable.Range(0, 6).Select(i => hex.ToString(i * 2, 2)));
        return true;
    }
}
