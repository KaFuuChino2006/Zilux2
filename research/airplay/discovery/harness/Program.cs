// Zilux2 AirPlay 发现模块 harness
// ------------------------------------------------------------
// 用途：
//   1) --discover [秒数]  在真实网络上跑一次 mDNS/DNS-SD 浏览，打印收到的报文摘要、
//                         hexdump 以及最终解析出来的 _raop/_airplay 设备列表。
//   2) --selftest         用「手工构造的 mDNS 字节」验证 DNS 报文编解码、缓存 TTL/goodbye、
//                        raop+airplay 归并以及 TXT 派生字段。
//
// 该文件不属于主工程，通过 Harness.csproj 里的 <Compile Include="...Discovery\*.cs" /> 链接源码。

using System.Net;
using System.Text;
using Zilux2.AirPlay;
using Zilux2.AirPlay.Discovery;

Console.OutputEncoding = Encoding.UTF8;

string mode = args.Length > 0 ? args[0] : "--discover";
switch (mode)
{
    case "--selftest":
        return SelfTest.Run();

    case "--discover":
        return DiscoveryRun.Run(ParseSeconds(args));

    default:
        Console.Error.WriteLine("用法: Harness [--selftest | --discover [秒数]]");
        return 2;
}

static int ParseSeconds(string[] arguments)
{
    if (arguments.Length > 1 && int.TryParse(arguments[1], out int seconds))
    {
        return Math.Clamp(seconds, 1, 300);
    }

    return 10;
}

/// <summary>真实网络发现模式。</summary>
internal static class DiscoveryRun
{
    public static int Run(int seconds)
    {
        Console.WriteLine("=== Zilux2 AirPlay mDNS 发现 harness ===");
        Console.WriteLine($"模式: 真实网络发现 {seconds}s");
        Console.WriteLine($"时间: {DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss zzz}");
        Console.WriteLine($"主机: {Environment.MachineName}  运行时: {Environment.Version}");
        Console.WriteLine();

        int callbackCount = 0;
        using var discovery = new AirPlayDiscovery { TraceRawPackets = true };
        discovery.OnTrace += message => Console.WriteLine(message);
        discovery.OnError += message => Console.Error.WriteLine("[OnError] " + message);

        discovery.Start(devices =>
        {
            callbackCount++;
            Console.WriteLine();
            Console.WriteLine($"--- 设备列表回调 #{callbackCount}：{devices.Count} 台 ---");
            PrintDevices(devices);
        });

        for (int i = 0; i < seconds; i++)
        {
            Thread.Sleep(TimeSpan.FromSeconds(1));
        }

        Console.WriteLine();
        Console.WriteLine("--- 调用 Refresh() 立即重查 ---");
        discovery.Refresh();
        Thread.Sleep(TimeSpan.FromSeconds(2));

        IReadOnlyList<AirPlayDevice> finalDevices = discovery.Devices;
        discovery.Stop();

        Console.WriteLine();
        Console.WriteLine($"=== 最终设备列表：{finalDevices.Count} 台（设备回调 {callbackCount} 次，IsRunning={discovery.IsRunning}）===");
        if (finalDevices.Count == 0)
        {
            Console.WriteLine("(未发现 _raop._tcp.local / _airplay._tcp.local 设备)");
        }
        else
        {
            PrintDevices(finalDevices);
        }

        Console.WriteLine("=== 结束 ===");
        return 0;
    }

    private static void PrintDevices(IReadOnlyList<AirPlayDevice> devices)
    {
        for (int i = 0; i < devices.Count; i++)
        {
            PrintDevice(i + 1, devices[i]);
        }
    }

    private static void PrintDevice(int index, AirPlayDevice device)
    {
        Console.WriteLine($"  [{index}] {device.Name}");
        Console.WriteLine($"      地址: {device.Host}:{device.Port}    主服务: {ServiceLabel(device)}");
        Console.WriteLine($"      SRV 端口: raop={device.RaopPort?.ToString() ?? "-"}  airplay={device.AirPlayPort?.ToString() ?? "-"}");
        Console.WriteLine($"      MAC={device.MacAddress ?? "-"}  Model={device.Model ?? "-"} ({device.ModelName ?? "-"})  md/元数据={(device.MetadataTypes.Count > 0 ? string.Join(",", device.MetadataTypes) : "-")}");
        Console.WriteLine($"      版本: vs/srcvers={device.Version ?? "-"}  vv={device.AirPlay2Version ?? "-"}  AirPlay2={device.SupportsAirPlay2}  需要密码={device.IsPasswordProtected}");
        Console.WriteLine($"      特性: {DescribeFeatures(device)}");
        Console.WriteLine($"      服务实例: {device.FullServiceName}");
        string txt = string.Join(
            "; ",
            device.Txt.OrderBy(kv => kv.Key, StringComparer.OrdinalIgnoreCase).Select(kv => $"{kv.Key}={kv.Value}"));
        Console.WriteLine($"      TXT: {txt}");
    }

    private static string ServiceLabel(AirPlayDevice device)
    {
        string label = device.ServiceType == AirPlayServiceType.Raop ? "raop(_raop._tcp)" : "airplay(_airplay._tcp)";
        if (device.HasRaopService && device.HasAirPlayService)
        {
            label += " + airplay";
        }

        return label;
    }

    private static string DescribeFeatures(AirPlayDevice device)
    {
        string features = device.Features is { } value ? "0x" + value.ToString("X") : "-";
        string statusFlags = device.StatusFlags is { } flags ? "0x" + flags.ToString("X") : "-";
        string encryption = device.EncryptionTypes.Count > 0 ? string.Join(",", device.EncryptionTypes) : "-";
        string channels = device.AudioChannels.Count > 0 ? string.Join(",", device.AudioChannels) : "-";
        string publicKey = string.IsNullOrEmpty(device.PublicKey) ? "-" : "有";
        return $"ft/features={features} sf/flags={statusFlags} et={encryption} cn={channels} " +
               $"sr={device.SampleRate?.ToString() ?? "-"} ss={device.SampleSize?.ToString() ?? "-"} " +
               $"tp={device.Transport ?? "-"} pk={publicKey}";
    }
}

/// <summary>解析/编解码自测。全部使用手工构造的字节，不依赖真实网络。</summary>
internal static class SelfTest
{
    private static int _failures;

    public static int Run()
    {
        Console.WriteLine("=== 自测：手工构造的 mDNS 字节 / 解析与聚合 ===");

        TestQueryWriter();
        TestResponseParse();
        TestResolveMergeAndDto();
        TestGoodbye();
        TestCacheFlush();
        TestTtlExpiry();
        TestTxtHelpers();
        TestMalformedPointer();

        Console.WriteLine();
        Console.WriteLine(_failures == 0 ? "=== 自测全部通过 ===" : $"=== 自测失败 {_failures} 项 ===");
        return _failures == 0 ? 0 : 1;
    }

    // ------------------------------------------------------------
    // 1. 查询报文
    // ------------------------------------------------------------
    private static void TestQueryWriter()
    {
        Console.WriteLine();
        Console.WriteLine("[1] 查询报文构造");

        byte[] query = MdnsQueryWriter.BuildQuery(new[] { "_raop._tcp.local", "_airplay._tcp.local" });
        Check("查询报文非空", query.Length > DnsMessage.HeaderSize, $"长度 {query.Length}");
        bool ok = DnsMessage.TryParse(query, out DnsMessage message, out string? error);
        Check("查询报文可被自身解析器解析", ok, error);
        Check("QDCOUNT=2", message.Questions.Count == 2, $"实际 {message.Questions.Count}");
        Check("查询报文不是响应", !message.IsResponse);
        if (message.Questions.Count == 2)
        {
            Check("问题 1 名称 =_raop._tcp.local", message.Questions[0].Name == "_raop._tcp.local", message.Questions[0].Name);
            Check("问题 2 名称 =_airplay._tcp.local", message.Questions[1].Name == "_airplay._tcp.local", message.Questions[1].Name);
            Check("问题类型都是 PTR", message.Questions[0].Type == DnsRecordType.Ptr && message.Questions[1].Type == DnsRecordType.Ptr);
            Check("问题 class 都是 IN", message.Questions[0].Class == DnsClass.In && message.Questions[1].Class == DnsClass.In);
            Check("单播响应位为 0（QM）", !message.Questions[0].UnicastResponse && !message.Questions[1].UnicastResponse);
        }
    }

    // ------------------------------------------------------------
    // 2. 响应报文解析：压缩指针、PTR/SRV/TXT/A/AAAA、未知类型、同名多记录
    // ------------------------------------------------------------
    private static void TestResponseParse()
    {
        Console.WriteLine();
        Console.WriteLine("[2] 响应报文解析（压缩指针 / PTR / SRV / TXT / A / AAAA / NSEC）");

        byte[] bytes = Samples.BuildRendezvousResponse();
        PrintHex("响应包头部", bytes, 96);

        bool ok = DnsMessage.TryParse(bytes, out DnsMessage message, out string? error);
        Check("响应包解析成功", ok, error);
        Check("无解析告警", message.ParseWarning is null, message.ParseWarning);
        Check("flags=0x8400（QR+AA）", message.Flags == 0x8400, $"0x{message.Flags:X4}");
        Check("ANCOUNT=6", message.Answers.Count == 6, $"实际 {message.Answers.Count}");
        Check("NSCOUNT=0", message.Authorities.Count == 0, $"实际 {message.Authorities.Count}");
        Check("ARCOUNT=4", message.Additionals.Count == 4, $"实际 {message.Additionals.Count}");
        Check("记录总数=10", message.AllRecords().Count() == 10, $"实际 {message.AllRecords().Count()}");

        DnsRecord? raopPtr = message.Answers.FirstOrDefault(
            record => record.Type == DnsRecordType.Ptr && record.Name.Equals("_raop._tcp.local", StringComparison.OrdinalIgnoreCase));
        Check("raop PTR 存在且 PTR 目标名正确（压缩指针）", raopPtr?.PtrTarget == Samples.RaopInstance, raopPtr?.PtrTarget);

        DnsRecord? raopSrv = message.Answers.FirstOrDefault(record => record.Type == DnsRecordType.Srv);
        Check("raop SRV 端口=5000", raopSrv?.SrvPort == 5000, raopSrv?.SrvPort.ToString());
        Check("raop SRV 目标=Living-Room.local", raopSrv?.SrvTarget == Samples.HostName, raopSrv?.SrvTarget);

        DnsRecord? raopTxt = message.Answers.FirstOrDefault(record => record.Type == DnsRecordType.Txt);
        Dictionary<string, string>? txt = raopTxt?.ToTxtDictionary();
        Check("raop TXT 共 17 条", txt?.Count == 17, txt?.Count.ToString());
        Check(
            "TXT md=0,1,2（元数据类型，不是型号）",
            txt is not null && txt.TryGetValue("md", out string? md) && md == "0,1,2");
        Check(
            "TXT ft=0x5A7FFFFF,0x1E",
            txt is not null && txt.TryGetValue("ft", out string? ft) && ft == "0x5A7FFFFF,0x1E");
        Check(
            "TXT txtvers=1",
            txt is not null && txt.TryGetValue("txtvers", out string? txtvers) && txtvers == "1");

        List<DnsRecord> aRecords = message.Answers.Where(record => record.Type == DnsRecordType.A).ToList();
        Check("同名多 A 记录（2 条）", aRecords.Count == 2, $"实际 {aRecords.Count}");
        Check("首条 A=192.168.31.100", aRecords.Count > 0 && aRecords[0].Address?.ToString() == "192.168.31.100", aRecords.FirstOrDefault()?.Address?.ToString());

        DnsRecord? aaaa = message.AllRecords().FirstOrDefault(record => record.Type == DnsRecordType.Aaaa);
        Check("AAAA 解析出 fe80::1", aaaa?.Address?.ToString() == "fe80::1", aaaa?.Address?.ToString());

        DnsRecord? nsec = message.AllRecords().FirstOrDefault(record => record.Type == DnsRecordType.Nsec);
        Check("未知类型 NSEC(47) 保留原始 RDATA 不崩", nsec is not null && nsec.UnparsedRDataHex is not null);
    }

    // ------------------------------------------------------------
    // 3. raop + airplay 归并 & 宿主 DTO 映射
    // ------------------------------------------------------------
    private static void TestResolveMergeAndDto()
    {
        Console.WriteLine();
        Console.WriteLine("[3] raop + airplay 归并 & AirPlayDeviceInfo 映射");

        DateTimeOffset now = new(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
        var resolver = new MdnsServiceResolver();
        resolver.AddRecords(Samples.Packet(Samples.BuildRendezvousResponse()), now);

        IReadOnlyList<AirPlayDevice> devices = resolver.Snapshot(now);
        Check("raop+airplay 归并为 1 台设备", devices.Count == 1, $"实际 {devices.Count}");
        if (devices.Count != 1)
        {
            return;
        }

        AirPlayDevice device = devices[0];
        Check("名称 =Living Room", device.Name == "Living Room", device.Name);
        Check("优先 A 记录 IPv4=192.168.31.100", device.Host == "192.168.31.100", device.Host);
        Check("端口优先 RAOP=5000", device.Port == 5000, device.Port.ToString());
        Check("RaopPort=5000", device.RaopPort == 5000, device.RaopPort.ToString());
        Check("AirPlayPort=7000", device.AirPlayPort == 7000, device.AirPlayPort.ToString());
        Check("同时具备 raop+airplay 服务", device.HasRaopService && device.HasAirPlayService);
        Check("MAC=AA:BB:CC:DD:EE:FF", device.MacAddress == "AA:BB:CC:DD:EE:FF", device.MacAddress);
        Check("Model=AudioAccessory5,1（取 airplay 的 model，不是 raop md）", device.Model == "AudioAccessory5,1", device.Model);
        Check("ModelName=AudioAccessory5,1（raop 的 am）", device.ModelName == "AudioAccessory5,1", device.ModelName);
        Check("MetadataTypes=[0,1,2]（raop md 解码为元数据类型）", string.Join(",", device.MetadataTypes) == "0,1,2", string.Join(",", device.MetadataTypes));
        Check("Version=130.14", device.Version == "130.14", device.Version);
        Check("AirPlay2Version=2", device.AirPlay2Version == "2", device.AirPlay2Version);
        Check("SupportsAirPlay2=true", device.SupportsAirPlay2);
        Check("Features=0x1E5A7FFFFF", device.Features == 0x1E5A7FFFFFUL, $"0x{device.Features:X}");
        Check("StatusFlags=0x4", device.StatusFlags == 0x4, $"0x{device.StatusFlags:X}");
        Check("et=[0,4]", string.Join(",", device.EncryptionTypes) == "0,4", string.Join(",", device.EncryptionTypes));
        Check("cn=[0,1]", string.Join(",", device.AudioChannels) == "0,1", string.Join(",", device.AudioChannels));
        Check("sr=44100", device.SampleRate == 44100, device.SampleRate.ToString());
        Check("ss=16", device.SampleSize == 16, device.SampleSize.ToString());
        Check("tp=UDP", device.Transport == "UDP", device.Transport);
        Check("pw=false → 不需要密码", !device.IsPasswordProtected);
        Check(
            "Txt 保留 ek/tp/cn/deviceid",
            device.Txt.ContainsKey("ek") && device.Txt.ContainsKey("tp") && device.Txt.ContainsKey("cn") && device.Txt.TryGetValue("deviceid", out string? deviceId) && deviceId == "AA:BB:CC:DD:EE:FF");

        AirPlayDeviceInfo info = AirPlayDiscovery.ToDeviceInfo(device);
        Check("DTO Id=MAC（稳定唯一）", info.Id == "AA:BB:CC:DD:EE:FF", info.Id);
        Check("DTO Name=Living Room", info.Name == "Living Room", info.Name);
        Check("DTO Host=192.168.31.100", info.Host == "192.168.31.100", info.Host);
        Check("DTO Port=5000", info.Port == 5000, info.Port.ToString());
        Check("DTO Model=AudioAccessory5,1", info.Model == "AudioAccessory5,1", info.Model);
        Check("DTO RequiresPassword=false", !info.RequiresPassword);
        Check("DTO SupportsAirPlay2=true", info.SupportsAirPlay2);
    }

    // ------------------------------------------------------------
    // 4. goodbye（TTL=0）
    // ------------------------------------------------------------
    private static void TestGoodbye()
    {
        Console.WriteLine();
        Console.WriteLine("[4] goodbye（TTL=0）删除 raop 记录后保留 airplay");

        DateTimeOffset now = new(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
        var resolver = new MdnsServiceResolver();
        resolver.AddRecords(Samples.Packet(Samples.BuildRendezvousResponse()), now);
        Check("goodbye 之前 1 台设备", resolver.Snapshot(now).Count == 1, $"实际 {resolver.Snapshot(now).Count}");

        now = now.AddSeconds(5);
        resolver.AddRecords(Samples.Packet(Samples.BuildGoodbyeResponse()), now);
        IReadOnlyList<AirPlayDevice> after = resolver.Snapshot(now);

        Check("raop goodbye 后仍有 1 台（airplay 保留）", after.Count == 1, $"实际 {after.Count}");
        if (after.Count == 1)
        {
            AirPlayDevice device = after[0];
            Check("goodbye 后主服务变为 airplay", device.ServiceType == AirPlayServiceType.AirPlay, device.ServiceType.ToString());
            Check("goodbye 后端口回落 7000", device.Port == 7000, device.Port.ToString());
            Check("goodbye 后名称不变", device.Name == "Living Room", device.Name);
        }
    }

    // ------------------------------------------------------------
    // 5. cache-flush（同 owner 同类型的新记录替换旧记录）
    // ------------------------------------------------------------
    private static void TestCacheFlush()
    {
        Console.WriteLine();
        Console.WriteLine("[5] cache-flush 位：新 A 记录替换旧 IP");

        DateTimeOffset now = new(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
        var resolver = new MdnsServiceResolver();
        resolver.AddRecords(Samples.Packet(Samples.BuildRendezvousResponse()), now);
        resolver.AddRecords(Samples.Packet(Samples.BuildCacheFlushResponse()), now.AddSeconds(1));

        IReadOnlyList<AirPlayDevice> devices = resolver.Snapshot(now.AddSeconds(1));
        Check("cache-flush 后仍 1 台设备", devices.Count == 1, $"实际 {devices.Count}");
        if (devices.Count == 1)
        {
            Check("新 IP 192.168.31.200 生效", devices[0].Host == "192.168.31.200", devices[0].Host);
        }
    }

    // ------------------------------------------------------------
    // 6. TTL 过期
    // ------------------------------------------------------------
    private static void TestTtlExpiry()
    {
        Console.WriteLine();
        Console.WriteLine("[6] TTL 过期");

        DateTimeOffset now = new(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
        var resolver = new MdnsServiceResolver();
        resolver.AddRecords(Samples.Packet(Samples.BuildShortTtlResponse()), now);

        Check("TTL=1 内可见 1 台设备", resolver.Snapshot(now).Count == 1, $"实际 {resolver.Snapshot(now).Count}");
        Check("TTL=1 过期后 0 台设备", resolver.Snapshot(now.AddSeconds(2)).Count == 0, $"实际 {resolver.Snapshot(now.AddSeconds(2)).Count}");
    }

    // ------------------------------------------------------------
    // 7. TXT 派生字段 / 助手函数
    // ------------------------------------------------------------
    private static void TestTxtHelpers()
    {
        Console.WriteLine();
        Console.WriteLine("[7] TXT 派生字段 / MAC / 特性位助手");

        bool featureOk = AirPlayTxtInfo.TryParseFeatureFlags("0x5A7FFFFF,0x1E", out ulong featureValue);
        Check("features 低 32 位在前 =0x1E5A7FFFFF", featureOk && featureValue == 0x1E5A7FFFFFUL, $"0x{featureValue:X}");
        bool singleOk = AirPlayTxtInfo.TryParseFeatureFlags("0x1000", out ulong singleValue);
        Check("单值 features=0x1000", singleOk && singleValue == 0x1000UL, $"0x{singleValue:X}");
        Check("非法 features 返回 false", !AirPlayTxtInfo.TryParseFeatureFlags("xyz", out ulong _));
        Check("版本主号 130.14 → 130", AirPlayTxtInfo.ParseVersionMajor("130.14") == 130);
        Check("版本主号 366 → 366", AirPlayTxtInfo.ParseVersionMajor("366") == 366);
        Check("版本主号非法 → -1", AirPlayTxtInfo.ParseVersionMajor("x") == -1);

        bool macOk = AirPlayTxtInfo.TryNormalizeMac("aabbccddeeff", out string? normalizedMac);
        Check("MAC 归一化 aabbccddeeff", macOk && normalizedMac == "AA:BB:CC:DD:EE:FF", normalizedMac);
        Check("非法 MAC 返回 false", !AirPlayTxtInfo.TryNormalizeMac("not-a-mac", out string? _));

        IReadOnlyList<int> list = AirPlayTxtInfo.ParseIntList("0, 1 ,2");
        Check("int 列表解析 0,1,2", list.Count == 3 && list[0] == 0 && list[1] == 1 && list[2] == 2);

        // SplitRaopInstance 的入参是「服务实例名」（不含 ._raop._tcp.local 后缀），与 AirPlayDevice.Create 内部一致。
        AirPlayDevice.SplitRaopInstance("AABBCCDDEEFF@Living Room", out string? raopMac, out string raopName);
        Check("raop 实例名拆分出 MAC", raopMac == "AA:BB:CC:DD:EE:FF", raopMac);
        Check("raop 实例名拆分出名称 Living Room", raopName == "Living Room", raopName);

        AirPlayTxtInfo passwordInfo = AirPlayTxtInfo.Parse(
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["pw"] = "true" });
        Check("pw=true → 需要密码", passwordInfo.IsPasswordProtected);

        AirPlayTxtInfo airplay1Info = AirPlayTxtInfo.Parse(
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["vs"] = "110.5" });
        Check("vs=110 且无 vv → 非 AirPlay2", !airplay1Info.SupportsAirPlay2);

        AirPlayTxtInfo airplay2Info = AirPlayTxtInfo.Parse(
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["vs"] = "130.14" });
        Check("vs=130.14 → AirPlay2", airplay2Info.SupportsAirPlay2);
    }

    // ------------------------------------------------------------
    // 8. 畸形报文：越界指针 / 自指指针 / 截断
    // ------------------------------------------------------------
    private static void TestMalformedPointer()
    {
        Console.WriteLine();
        Console.WriteLine("[8] 畸形报文健壮性");

        // 12 字节头 + 一条 RR，RR 名字指针指向缓冲区外（偏移 0x80）。
        var bad = new byte[12 + 2 + 2 + 2 + 4 + 2 + 4];
        bad[2] = 0x84;
        bad[3] = 0x00;
        bad[7] = 1;
        bad[12] = 0xC0;
        bad[13] = 0x80;
        bad[14] = 0x00;
        bad[15] = 0x01;
        bad[16] = 0x00;
        bad[17] = 0x01;
        bad[22] = 0x00;
        bad[23] = 0x04;
        bad[24] = 192;
        bad[25] = 168;
        bad[26] = 31;
        bad[27] = 200;

        bool ok = DnsMessage.TryParse(bad, out DnsMessage message, out string? error);
        Check(
            "越界压缩指针被拒绝或标记解析告警",
            !ok || message.ParseWarning is not null,
            ok ? $"ok=true warning={message.ParseWarning}" : error);

        // 自指压缩指针（偏移 12 指向自身）必须被防环保护拦下，不能死循环。
        var loop = new byte[12 + 2 + 2 + 2 + 4 + 2];
        loop[2] = 0x84;
        loop[7] = 1;
        loop[12] = 0xC0;
        loop[13] = 0x0C;
        loop[14] = 0x00;
        loop[15] = 0x01;
        loop[16] = 0x00;
        loop[17] = 0x01;
        bool loopOk = DnsMessage.TryParse(loop, out DnsMessage loopMessage, out string? loopError);
        Check(
            "自指压缩指针被防环保护拦下",
            !loopOk || loopMessage.ParseWarning is not null,
            loopOk ? $"ok=true warning={loopMessage.ParseWarning}" : loopError);

        bool truncatedOk = DnsMessage.TryParse(bad.AsSpan(0, 6), out DnsMessage _, out string? truncatedError);
        Check("截断报文被拒绝", !truncatedOk, truncatedError);
    }

    // ------------------------------------------------------------
    // 断言/打印辅助
    // ------------------------------------------------------------
    private static void Check(string name, bool condition, string? detail = null)
    {
        if (condition)
        {
            Console.WriteLine($"  [通过] {name}");
        }
        else
        {
            _failures++;
            Console.WriteLine($"  [失败] {name}" + (detail is null ? "" : $" —— {detail}"));
        }
    }

    private static void PrintHex(string title, byte[] data, int maxBytes)
    {
        int count = Math.Min(data.Length, maxBytes);
        var builder = new StringBuilder();
        for (int i = 0; i < count; i++)
        {
            if (i > 0 && i % 16 == 0)
            {
                builder.Append('\n');
            }

            builder.Append(data[i].ToString("X2")).Append(' ');
        }

        Console.WriteLine($"  {title}（共 {data.Length} 字节，显示 {count} 字节）：");
        Console.WriteLine("    " + builder.ToString().Replace("\n", "\n    "));
    }
}

/// <summary>手工构造自测报文的样例包。</summary>
internal static class Samples
{
    public const string RaopInstance = "AABBCCDDEEFF@Living Room._raop._tcp.local";
    public const string AirplayInstance = "Living Room._airplay._tcp.local";
    public const string HostName = "Living-Room.local";

    private const string KitchenInstance = "112233445566@Kitchen._raop._tcp.local";
    private const string KitchenHost = "Kitchen.local";

    private static readonly string[] RaopTxtEntries =
    {
        "txtvers=1",
        "ch=2",
        "cn=0,1",
        "et=0,4",
        "sv=false",
        "da=true",
        "sr=44100",
        "ss=16",
        "pw=false",
        "vn=3",
        "tp=UDP",
        "md=0,1,2",
        "am=AudioAccessory5,1",
        "vs=130.14",
        "ft=0x5A7FFFFF,0x1E",
        "sf=0x4",
        "ek=1",
    };

    private static readonly string[] AirplayTxtEntries =
    {
        "deviceid=AA:BB:CC:DD:EE:FF",
        "features=0x5A7FFFFF,0x1E",
        "flags=0x4",
        "model=AudioAccessory5,1",
        "pk=0123456789abcdef",
        "srcvers=220.68",
        "vv=2",
    };

    /// <summary>一台同时有 _raop 与 _airplay 的 HomePod：PTR/SRV/TXT/A/AAAA + 未知类型 NSEC，全部走名字压缩。</summary>
    public static byte[] BuildRendezvousResponse()
    {
        var builder = new PacketBuilder();
        builder.StartResponse(answers: 6, additionals: 4);

        // 1、2) 两个服务类型的 PTR，目标分别是 raop/airplay 服务实例（压缩指针）。
        builder.WriteRecord("_raop._tcp.local", DnsRecordType.Ptr, cacheFlush: false, ttlSeconds: 4500,
            writer => writer.WriteNameOrPointer(RaopInstance));
        builder.WriteRecord("_airplay._tcp.local", DnsRecordType.Ptr, cacheFlush: false, ttlSeconds: 4500,
            writer => writer.WriteNameOrPointer(AirplayInstance));

        // 3) raop SRV：端口 5000。
        builder.WriteRecord(RaopInstance, DnsRecordType.Srv, cacheFlush: true, ttlSeconds: 120, writer =>
        {
            writer.WriteU16(0);
            writer.WriteU16(0);
            writer.WriteU16(5000);
            writer.WriteNameOrPointer(HostName);
        });

        // 4) raop TXT。
        builder.WriteRecord(RaopInstance, DnsRecordType.Txt, cacheFlush: true, ttlSeconds: 120,
            writer => writer.WriteTxt(RaopTxtEntries));

        // 5、6) 同一个 host 的两条 A 记录（同名多记录；解析/归并时优先第一条 .100）。
        builder.WriteRecord(HostName, DnsRecordType.A, cacheFlush: false, ttlSeconds: 120,
            writer => writer.WriteBytes(new byte[] { 192, 168, 31, 100 }));
        builder.WriteRecord(HostName, DnsRecordType.A, cacheFlush: false, ttlSeconds: 120,
            writer => writer.WriteBytes(new byte[] { 192, 168, 31, 101 }));

        // 以下 4 条在 additional 段。
        builder.WriteRecord(HostName, DnsRecordType.Aaaa, cacheFlush: false, ttlSeconds: 120,
            writer => writer.WriteBytes(new byte[] { 0xfe, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1 }));
        builder.WriteRecord(AirplayInstance, DnsRecordType.Srv, cacheFlush: true, ttlSeconds: 120, writer =>
        {
            writer.WriteU16(0);
            writer.WriteU16(0);
            writer.WriteU16(7000);
            writer.WriteNameOrPointer(HostName);
        });
        builder.WriteRecord(AirplayInstance, DnsRecordType.Txt, cacheFlush: true, ttlSeconds: 120,
            writer => writer.WriteTxt(AirplayTxtEntries));

        // 未知类型（NSEC=47）：解析器应保留原始 RDATA 而不崩。
        builder.WriteRecord(RaopInstance, DnsRecordType.Nsec, cacheFlush: false, ttlSeconds: 120,
            writer => writer.WriteBytes(new byte[] { 0x00, 0x04, 0x00, 0x00, 0x00, 0x08 }));

        return builder.ToArray();
    }

    /// <summary>cache-flush：同 owner/同类型替换，host 的 A 记录变成 192.168.31.200。</summary>
    public static byte[] BuildCacheFlushResponse()
    {
        var builder = new PacketBuilder();
        builder.StartResponse(answers: 4);

        builder.WriteRecord("_raop._tcp.local", DnsRecordType.Ptr, cacheFlush: false, ttlSeconds: 4500,
            writer => writer.WriteNameOrPointer(RaopInstance));
        builder.WriteRecord(RaopInstance, DnsRecordType.Srv, cacheFlush: true, ttlSeconds: 120, writer =>
        {
            writer.WriteU16(0);
            writer.WriteU16(0);
            writer.WriteU16(5000);
            writer.WriteNameOrPointer(HostName);
        });
        builder.WriteRecord(RaopInstance, DnsRecordType.Txt, cacheFlush: true, ttlSeconds: 120,
            writer => writer.WriteTxt(RaopTxtEntries));
        builder.WriteRecord(HostName, DnsRecordType.A, cacheFlush: true, ttlSeconds: 120,
            writer => writer.WriteBytes(new byte[] { 192, 168, 31, 200 }));

        return builder.ToArray();
    }

    /// <summary>goodbye：TTL=0 删掉 raop 的 PTR/SRV/TXT，airplay 记录继续有效。</summary>
    public static byte[] BuildGoodbyeResponse()
    {
        var builder = new PacketBuilder();
        builder.StartResponse(answers: 5);

        builder.WriteRecord("_raop._tcp.local", DnsRecordType.Ptr, cacheFlush: false, ttlSeconds: 0,
            writer => writer.WriteNameOrPointer(RaopInstance));
        builder.WriteRecord(RaopInstance, DnsRecordType.Srv, cacheFlush: true, ttlSeconds: 0, writer =>
        {
            writer.WriteU16(0);
            writer.WriteU16(0);
            writer.WriteU16(5000);
            writer.WriteNameOrPointer(HostName);
        });
        builder.WriteRecord(RaopInstance, DnsRecordType.Txt, cacheFlush: true, ttlSeconds: 0,
            writer => writer.WriteTxt(RaopTxtEntries));

        // 重新宣告 airplay 一侧，保证 goodbye 之后 airplay 设备仍然可解析。
        builder.WriteRecord("_airplay._tcp.local", DnsRecordType.Ptr, cacheFlush: false, ttlSeconds: 4500,
            writer => writer.WriteNameOrPointer(AirplayInstance));
        builder.WriteRecord(AirplayInstance, DnsRecordType.Srv, cacheFlush: true, ttlSeconds: 120, writer =>
        {
            writer.WriteU16(0);
            writer.WriteU16(0);
            writer.WriteU16(7000);
            writer.WriteNameOrPointer(HostName);
        });

        return builder.ToArray();
    }

    /// <summary>另一台设备的短 TTL 广播（全部 TTL=1），用于验证缓存过期。</summary>
    public static byte[] BuildShortTtlResponse()
    {
        var builder = new PacketBuilder();
        builder.StartResponse(answers: 4);

        builder.WriteRecord("_raop._tcp.local", DnsRecordType.Ptr, cacheFlush: false, ttlSeconds: 1,
            writer => writer.WriteNameOrPointer(KitchenInstance));
        builder.WriteRecord(KitchenInstance, DnsRecordType.Srv, cacheFlush: true, ttlSeconds: 1, writer =>
        {
            writer.WriteU16(0);
            writer.WriteU16(0);
            writer.WriteU16(5000);
            writer.WriteNameOrPointer(KitchenHost);
        });
        builder.WriteRecord(KitchenInstance, DnsRecordType.Txt, cacheFlush: true, ttlSeconds: 1,
            writer => writer.WriteTxt(new[] { "vs=220.68", "md=0,1,2", "am=AudioAccessory5,1" }));
        builder.WriteRecord(KitchenHost, DnsRecordType.A, cacheFlush: false, ttlSeconds: 1,
            writer => writer.WriteBytes(new byte[] { 192, 168, 31, 102 }));

        return builder.ToArray();
    }

    /// <summary>把字节包包装成 resolver 需要的 MdnsProbePacket。</summary>
    public static MdnsProbePacket Packet(byte[] bytes)
    {
        if (!DnsMessage.TryParse(bytes, out DnsMessage message, out string? error))
        {
            throw new InvalidOperationException("自测报文解析失败: " + error);
        }

        return new MdnsProbePacket(
            message,
            new IPEndPoint(IPAddress.Parse("192.168.31.100"), 5353),
            interfaceIndex: 6,
            fromIPv6: false,
            receivedAt: DateTimeOffset.UtcNow);
    }
}

/// <summary>极简 mDNS 报文构造器：只够自测用，支持名字压缩（复用已写过的名字偏移）。</summary>
internal sealed class PacketBuilder
{
    private readonly List<byte> _bytes = new();
    private readonly Dictionary<string, int> _nameOffsets = new(StringComparer.OrdinalIgnoreCase);

    public PacketBuilder()
    {
        // 先占位 12 字节 header，最后用 StartResponse/PatchU16 回填。
        for (int i = 0; i < 12; i++)
        {
            _bytes.Add(0);
        }
    }

    public int Position => _bytes.Count;

    public PacketBuilder StartResponse(ushort answers, ushort authorities = 0, ushort additionals = 0, ushort flags = 0x8400)
    {
        PatchU16(2, flags);
        PatchU16(4, 0);
        PatchU16(6, answers);
        PatchU16(8, authorities);
        PatchU16(10, additionals);
        return this;
    }

    public void WriteU8(byte value) => _bytes.Add(value);

    public void WriteU16(ushort value)
    {
        _bytes.Add((byte)(value >> 8));
        _bytes.Add((byte)(value & 0xFF));
    }

    public void WriteU32(uint value)
    {
        _bytes.Add((byte)(value >> 24));
        _bytes.Add((byte)((value >> 16) & 0xFF));
        _bytes.Add((byte)((value >> 8) & 0xFF));
        _bytes.Add((byte)(value & 0xFF));
    }

    public void WriteBytes(byte[] data) => _bytes.AddRange(data);

    public void WriteTxt(params string[] entries)
    {
        foreach (string entry in entries)
        {
            byte[] text = Encoding.UTF8.GetBytes(entry);
            if (text.Length > 255)
            {
                throw new ArgumentException("TXT 条目超长: " + entry, nameof(entries));
            }

            WriteU8((byte)text.Length);
            WriteBytes(text);
        }
    }

    public void PatchU16(int offset, ushort value)
    {
        _bytes[offset] = (byte)(value >> 8);
        _bytes[offset + 1] = (byte)(value & 0xFF);
    }

    /// <summary>写域名：已写过则输出压缩指针，否则写完整标签并记录偏移。</summary>
    public int WriteNameOrPointer(string name)
    {
        if (_nameOffsets.TryGetValue(name, out int existing) && existing <= 0x3FFF)
        {
            WriteU16((ushort)(0xC000 | existing));
            return existing;
        }

        int start = Position;
        foreach (string label in name.Split('.'))
        {
            byte[] labelBytes = Encoding.UTF8.GetBytes(label);
            if (labelBytes.Length is 0 or > 63)
            {
                throw new ArgumentException("非法 DNS 标签: " + name, nameof(name));
            }

            WriteU8((byte)labelBytes.Length);
            WriteBytes(labelBytes);
        }

        WriteU8(0);
        _nameOffsets[name] = start;
        return start;
    }

    /// <summary>写一条 RR；RDATA 长度自动回填。</summary>
    public void WriteRecord(string name, DnsRecordType type, bool cacheFlush, uint ttlSeconds, Action<PacketBuilder> writeRData)
    {
        WriteNameOrPointer(name);
        WriteU16((ushort)type);
        ushort recordClass = (ushort)((cacheFlush ? 0x8000 : 0) | (int)DnsClass.In);
        WriteU16(recordClass);
        WriteU32(ttlSeconds);

        int lengthOffset = Position;
        WriteU16(0);
        int dataStart = Position;
        writeRData(this);
        PatchU16(lengthOffset, (ushort)(Position - dataStart));
    }

    public byte[] ToArray() => _bytes.ToArray();
}
