using System.Diagnostics;
using System.Linq;
using System.Net;
using System.Text;

namespace Zilux2.AirPlay.Discovery;

/// <summary>
/// AirPlay / RAOP 设备发现器（mDNS/DNS-SD，零第三方依赖）。
///
/// 用法（典型）：
/// <code>
/// var discovery = new AirPlayDiscovery();
/// discovery.OnError = message =&gt; Debug.WriteLine(message);
/// discovery.Start(devices =&gt; Dispatcher.Invoke(() =&gt; UpdateDeviceList(devices)));
/// ...
/// discovery.Refresh(); // 用户点击"重新扫描"
/// ...
/// discovery.Dispose();
/// </code>
///
/// 线程模型：
/// - <see cref="Start"/> 在本机创建一个后台线程负责组播收发、记录缓存与解析；
/// - <see cref="OnError"/> 与传给 <see cref="Start"/> 的 onDevicesChanged 回调都在这条后台线程上触发，
///   WPF 宿主必须自行 Marshal 到 UI 线程（例如 Dispatcher.BeginInvoke）；
/// - <see cref="Devices"/> 可以在任意线程读取（返回不可变快照）；
/// - <see cref="Refresh"/> 可在任意线程调用（只置一个标志，由后台线程执行查询）；
/// - 不要在 onDevicesChanged 回调里调用 <see cref="Stop"/> / <see cref="Dispose"/> 并等待，避免自锁。
///
/// 生命周期：
/// - Start 之后立即发送第一轮 PTR 查询，之后每 <see cref="QueryInterval"/> 秒重复一轮（默认 5 秒）；
///   收到响应后会立即重算设备列表，并通过回调发布变化（首次可能发布空列表）。
/// - Stop 会尽快停止线程并释放 socket；Stop 返回后不会再有回调。
/// - 发现过程的所有网络错误都通过 OnError 上报，不会从线程逃逸。
/// </summary>
internal sealed class AirPlayDiscovery : IAirPlayDeviceDiscovery
{
    /// <summary>RAOP（AirPlay 1 音频）服务类型。</summary>
    public const string RaopServiceType = "_raop._tcp.local";

    /// <summary>AirPlay（音视频/镜像）服务类型。</summary>
    public const string AirPlayServiceType = "_airplay._tcp.local";

    private static readonly string[] DefaultServiceTypes = { RaopServiceType, AirPlayServiceType };

    private readonly object _sync = new();
    private readonly ManualResetEventSlim _stopEvent = new(false);
    private readonly MdnsServiceResolver _resolver = new();
    private readonly string[] _serviceTypes;

    private Action<IReadOnlyList<AirPlayDevice>>? _onDevicesChanged;
    private Action<string>? _onError;
    private Thread? _thread;
    private volatile IReadOnlyList<AirPlayDevice> _snapshot = Array.Empty<AirPlayDevice>();
    private string? _publishedSignature;
    private volatile bool _running;
    private volatile bool _disposed;
    private int _refreshRequested;

    public AirPlayDiscovery()
        : this(DefaultServiceTypes)
    {
    }

    /// <summary>可选：自定义要浏览的服务类型（默认 _raop._tcp.local + _airplay._tcp.local）。</summary>
    public AirPlayDiscovery(IEnumerable<string> serviceTypes)
    {
        var list = new List<string>();
        foreach (var item in serviceTypes)
        {
            if (!string.IsNullOrWhiteSpace(item))
            {
                list.Add(item.Trim().TrimEnd('.'));
            }
        }
        if (list.Count == 0)
        {
            throw new ArgumentException("至少需要一个服务类型", nameof(serviceTypes));
        }
        _serviceTypes = list.ToArray();
    }

    /// <summary>
    /// 错误上报（网络 socket 失败、报文异常、回调抛异常等）。在后台线程触发；
    /// 允许为 null（此时只写 Debug 输出）。回调自身抛出的异常会被吞掉并转成 Debug 输出。
    /// </summary>
    public Action<string>? OnError
    {
        get => _onError;
        set => _onError = value;
    }

    /// <summary>
    /// <see cref="IAirPlayDeviceDiscovery"/> 契约事件：设备列表变化（后台线程触发，宿主需 Marshal 到 UI 线程）。
    /// 只有通过无参 <see cref="Start()"/> 启动时才会触发；用
    /// <see cref="Start(Action{IReadOnlyList{AirPlayDevice}})"/> 启动时用传入的回调。
    /// </summary>
    public event Action<IReadOnlyList<AirPlayDeviceInfo>>? DevicesChanged;

    /// <summary>当前已知设备快照（按显示名排序）。读取线程安全，返回的列表不会再被修改。</summary>
    public IReadOnlyList<AirPlayDevice> Devices => _snapshot;

    /// <summary>后台发现线程是否在运行。</summary>
    public bool IsRunning => _running;

    /// <summary>重复查询周期，默认 5 秒。mDNS 是通知驱动的，这个值主要影响"设备刚上线多久被发现"。</summary>
    public TimeSpan QueryInterval { get; set; } = TimeSpan.FromSeconds(5);

    /// <summary>单次接收阻塞切片，默认 250ms；决定 Stop/Refresh 的响应延迟与快照刷新节奏。</summary>
    public TimeSpan ReceiveSlice { get; set; } = TimeSpan.FromMilliseconds(250);

    /// <summary>本次浏览的服务类型。</summary>
    public IReadOnlyList<string> ServiceTypes => _serviceTypes;

    /// <summary>
    /// 调试：接收报文时输出摘要与十六进制 dump。默认 false；harness 打开它来留原始证据。
    /// </summary>
    internal bool TraceRawPackets { get; set; }

    /// <summary>调试日志钩子（在后台线程触发）。主要给 harness/README 记录原始过程。</summary>
    internal event Action<string>? OnTrace;

    /// <summary>
    /// <see cref="IAirPlayDeviceDiscovery"/> 的启动方法：幂等（已在运行时直接返回）。
    /// 启动后设备变化通过 <see cref="DevicesChanged"/> 事件发布（后台线程）。
    /// </summary>
    public void Start()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (_running)
        {
            return;
        }
        Start(devices =>
        {
            var info = new AirPlayDeviceInfo[devices.Count];
            for (int i = 0; i < devices.Count; i++)
            {
                info[i] = ToDeviceInfo(devices[i]);
            }
            DevicesChanged?.Invoke(info);
        });
    }

    /// <summary>
    /// 启动发现。onDevicesChanged 会在后台线程被调用（含设备增删改后的完整列表）。
    /// 已在运行时重复 Start 只会上报错误、不重启。
    /// </summary>
    public void Start(Action<IReadOnlyList<AirPlayDevice>> onDevicesChanged)
    {
        ArgumentNullException.ThrowIfNull(onDevicesChanged);
        ObjectDisposedException.ThrowIf(_disposed, this);

        lock (_sync)
        {
            if (_running)
            {
                ReportError("AirPlayDiscovery 已在运行，重复 Start 被忽略");
                return;
            }

            _onDevicesChanged = onDevicesChanged;
            _resolver.Clear();
            _publishedSignature = null;
            _snapshot = Array.Empty<AirPlayDevice>();
            _refreshRequested = 0;
            _stopEvent.Reset();
            _running = true;
            _thread = new Thread(RunLoop)
            {
                IsBackground = true,
                Name = "Zilux2.AirPlay.mDNS",
            };
            _thread.Start();
        }
    }

    /// <summary>停止发现并等待后台线程退出（最多 3 秒）。可在任意线程调用，回调里调用也不会自锁。</summary>
    public void Stop()
    {
        Thread? thread;
        lock (_sync)
        {
            _running = false;
            _onDevicesChanged = null;
            _stopEvent.Set();
            thread = _thread;
        }

        if (thread is not null && thread != Thread.CurrentThread)
        {
            try
            {
                thread.Join(TimeSpan.FromSeconds(3));
            }
            catch
            {
                // 忽略 join 异常（线程已退出等）。
            }
        }

        lock (_sync)
        {
            if (_thread == thread)
            {
                _thread = null;
            }
        }
    }

    /// <summary>请求立即重新发送一轮查询（异步；不阻塞调用方）。未运行时无副作用。</summary>
    public void Refresh()
    {
        if (!_running)
        {
            return;
        }
        Interlocked.Exchange(ref _refreshRequested, 1);
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }
        Stop();
        _disposed = true;
        _stopEvent.Dispose();
        _resolver.Clear();
    }

    // ---------------- 后台线程 ----------------

    private void RunLoop()
    {
        MdnsProbe? probe = null;
        try
        {
            Trace($"[discovery] 启动；服务类型: {string.Join(", ", _serviceTypes)}；查询周期: {QueryInterval.TotalSeconds:0.#}s");
            probe = new MdnsProbe(_serviceTypes, ReportError) { DebugTrace = Trace, CaptureRawBytes = TraceRawPackets };
            if (!probe.Open())
            {
                ReportError("AirPlay 设备发现无法启动：mDNS socket 未能打开");
                return;
            }
            Trace($"[discovery] 本机参与组播的网卡:\n{probe.DescribeInterfaces()}");

            var packets = new List<MdnsProbePacket>(8);
            DateTimeOffset lastQuery = DateTimeOffset.MinValue;
            DateTimeOffset lastSnapshot = DateTimeOffset.MinValue;
            bool firstCycle = true;

            while (!_stopEvent.IsSet)
            {
                DateTimeOffset now = DateTimeOffset.UtcNow;
                bool forced = Interlocked.Exchange(ref _refreshRequested, 0) != 0;
                if (firstCycle || forced || now - lastQuery >= QueryInterval)
                {
                    probe.SendQueries();
                    lastQuery = now;
                    firstCycle = false;
                }

                int received = probe.Receive(ReceiveSlice, packets);
                if (received > 0)
                {
                    foreach (var packet in packets)
                    {
                        TracePacket(probe, packet);
                        _resolver.AddRecords(packet, packet.ReceivedAt);
                    }
                }

                // 收到新记录立即重算；否则至少每秒检查一次缓存过期（TTL/goodbye 会让设备消失）。
                if (received > 0 || (DateTimeOffset.UtcNow - lastSnapshot) >= TimeSpan.FromSeconds(1))
                {
                    var devices = _resolver.Snapshot(DateTimeOffset.UtcNow);
                    lastSnapshot = DateTimeOffset.UtcNow;
                    Publish(devices);
                }
            }
        }
        catch (Exception ex)
        {
            ReportError($"发现线程异常退出: {ex.GetType().Name}: {ex.Message}");
            System.Diagnostics.Debug.WriteLine(ex);
        }
        finally
        {
            probe?.Dispose();
            _running = false;
            Trace("[discovery] 已停止");
        }
    }

    private void TracePacket(MdnsProbe probe, MdnsProbePacket packet)
    {
        if (OnTrace is null)
        {
            return;
        }

        var iface = probe.FindInterfaceFor(packet);
        bool relevant = IsRelevantMessage(packet.Message);
        Trace($"[discovery] 收到响应 {(relevant ? "*" : " ")} {packet.Source} if={packet.InterfaceIndex} ipv6={packet.FromIPv6} 网卡={iface?.Name ?? "未知"} " +
              $"an={packet.Message.Answers.Count} ns={packet.Message.Authorities.Count} ar={packet.Message.Additionals.Count}");
        if (!relevant)
        {
            // 局域网里 mDNS 流量很杂（iPhone/Bonjour 各种服务）；无关报文只留一行来源记录。
            return;
        }

        Trace("[discovery]   " + MdnsProbe.DescribeMessage(packet.Message).Replace("\n", "\n[discovery]   "));
        if (TraceRawPackets && packet.RawBytes is { Length: > 0 } raw)
        {
            Trace("[discovery]   raw:\n" + MdnsProbe.HexDump(raw, 256));
        }
    }

    /// <summary>报文里是否包含本次浏览的服务（名字以服务类型结尾，或 PTR 指向该服务实例）。</summary>
    private bool IsRelevantMessage(DnsMessage message)
    {
        foreach (var record in message.AllRecords())
        {
            if (IsRelevantName(record.Name) ||
                IsRelevantName(record.PtrTarget) ||
                IsRelevantName(record.SrvTarget))
            {
                return true;
            }
        }
        return false;
    }

    private bool IsRelevantName(string? name)
    {
        if (string.IsNullOrEmpty(name))
        {
            return false;
        }
        foreach (var serviceType in _serviceTypes)
        {
            if (name.Equals(serviceType, StringComparison.OrdinalIgnoreCase) ||
                name.EndsWith("." + serviceType, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }
        return false;
    }

    private void Publish(IReadOnlyList<AirPlayDevice> devices)
    {
        Action<IReadOnlyList<AirPlayDevice>>? callback;
        lock (_sync)
        {
            string signature = BuildSignature(devices);
            if (string.Equals(_publishedSignature, signature, StringComparison.Ordinal))
            {
                _snapshot = devices;
                return;
            }
            _publishedSignature = signature;
            _snapshot = devices;
            callback = _onDevicesChanged;
        }

        if (callback is null || !_running)
        {
            return;
        }

        Trace($"[discovery] 设备列表更新：{devices.Count} 台");
        try
        {
            callback(devices);
        }
        catch (Exception ex)
        {
            ReportError($"设备列表回调抛出异常（已忽略）: {ex.GetType().Name}: {ex.Message}");
        }
    }

    /// <summary>把内部设备模型转换成宿主契约 DTO（见 <see cref="AirPlayDeviceInfo"/>）。internal 便于 harness 自测。</summary>
    internal static AirPlayDeviceInfo ToDeviceInfo(AirPlayDevice device)
    {
        // Id 必须稳定且同一设备 raop+airplay 合并后不变：优先 raop 服务名里的 MAC，其次完整服务名。
        string id = !string.IsNullOrEmpty(device.MacAddress) ? device.MacAddress! : device.FullServiceName;
        string? model = !string.IsNullOrEmpty(device.Model) ? device.Model : device.ModelName;
        return new AirPlayDeviceInfo
        {
            Id = id,
            Name = string.IsNullOrWhiteSpace(device.Name) ? device.ServiceName : device.Name,
            Host = device.Host,
            // 契约默认 7000：有 RAOP SRV 端口（通常 5000）就用它，否则用 AirPlay 端口（7000）。
            Port = device.Port > 0 ? device.Port : 7000,
            Model = string.IsNullOrEmpty(model) ? null : model,
            RequiresPassword = device.IsPasswordProtected,
            SupportsAirPlay2 = device.SupportsAirPlay2,
        };
    }

    private static string BuildSignature(IReadOnlyList<AirPlayDevice> devices)
    {
        if (devices.Count == 0)
        {
            return string.Empty;
        }
        var sb = new StringBuilder(devices.Count * 160);
        foreach (var device in devices)
        {
            sb.Append(device.Signature).Append('\n');
        }
        return sb.ToString();
    }

    private void ReportError(string message)
    {
        System.Diagnostics.Debug.WriteLine($"[mDNS] 错误: {message}");
        var handler = _onError;
        if (handler is null)
        {
            return;
        }
        try
        {
            handler(message);
        }
        catch
        {
            // 错误回调本身不能再抛。
        }
    }

    private void Trace(string message)
    {
        var handler = OnTrace;
        if (handler is null)
        {
            return;
        }
        try
        {
            handler(message);
        }
        catch
        {
            // 调试输出失败不应影响发现。
        }
    }
}

/// <summary>
/// 把 mDNS 响应聚合成 <see cref="AirPlayDevice"/>：
/// 缓存 PTR/SRV/TXT/A/AAAA 记录（含 TTL 与 goodbye），按 DNS-SD 关系解析 PTR → SRV/TXT → A/AAAA，
/// 并把同一台设备的 _raop._tcp 与 _airplay._tcp 两条服务合并（raop 优先）。
/// 非线程安全，只由发现线程使用。
/// </summary>
internal sealed class MdnsServiceResolver
{
    /// <summary>只缓存这些记录；NSEC/SOA 等直接忽略。</summary>
    private static readonly HashSet<DnsRecordType> CachedTypes = new()
    {
        DnsRecordType.Ptr,
        DnsRecordType.Srv,
        DnsRecordType.Txt,
        DnsRecordType.A,
        DnsRecordType.Aaaa,
    };

    private const int MaxCacheEntries = 4096;

    private readonly Dictionary<string, List<CacheEntry>> _byOwner = new(StringComparer.OrdinalIgnoreCase);

    private sealed class CacheEntry
    {
        public required DnsRecord Record { get; set; }

        public required DateTimeOffset ExpiresAt { get; set; }

        public IPAddress? SourceAddress { get; set; }

        public int InterfaceIndex { get; set; }
    }

    public void Clear() => _byOwner.Clear();

    /// <summary>把响应包里的所有 answer/authority/additional 记录并入缓存。</summary>
    public void AddRecords(MdnsProbePacket packet, DateTimeOffset now)
    {
        foreach (var record in packet.Message.AllRecords())
        {
            if (!CachedTypes.Contains(record.Type))
            {
                continue;
            }
            AddRecord(record, packet.Source.Address, packet.InterfaceIndex, now);
        }
        Cleanup(now);
    }

    private void AddRecord(DnsRecord record, IPAddress source, int interfaceIndex, DateTimeOffset now)
    {
        string key = record.Name;
        if (!_byOwner.TryGetValue(key, out var entries))
        {
            if (_byOwner.Count >= MaxCacheEntries)
            {
                Cleanup(now);
                if (_byOwner.Count >= MaxCacheEntries)
                {
                    return;
                }
            }
            entries = new List<CacheEntry>(2);
            _byOwner[key] = entries;
        }

        string rdataKey = record.RDataKey();

        // TTL=0 是 goodbye：立即让同一条记录过期。
        if (record.TimeToLiveSeconds == 0)
        {
            entries.RemoveAll(e => e.Record.Type == record.Type && string.Equals(e.Record.RDataKey(), rdataKey, StringComparison.Ordinal));
            return;
        }

        // cache-flush 位：声明"我这条记录是唯一的"，清掉同名同类型的旧记录（PTR 是共享记录，不 flush）。
        if (record.CacheFlush && record.Type is not DnsRecordType.Ptr)
        {
            entries.RemoveAll(e => e.Record.Type == record.Type);
        }

        foreach (var entry in entries)
        {
            if (entry.Record.Type == record.Type &&
                string.Equals(entry.Record.RDataKey(), rdataKey, StringComparison.Ordinal))
            {
                // 同一记录重复通告：刷新 TTL 与来源信息即可（TXT 内容变化由 RDataKey 区分）。
                entry.Record = record;
                entry.ExpiresAt = now.AddSeconds(Math.Clamp(record.TimeToLiveSeconds, 1u, 24u * 3600u));
                entry.SourceAddress = source;
                entry.InterfaceIndex = interfaceIndex;
                return;
            }
        }

        entries.Add(new CacheEntry
        {
            Record = record,
            ExpiresAt = now.AddSeconds(Math.Clamp(record.TimeToLiveSeconds, 1u, 24u * 3600u)),
            SourceAddress = source,
            InterfaceIndex = interfaceIndex,
        });
    }

    private void Cleanup(DateTimeOffset now)
    {
        List<string>? emptyKeys = null;
        foreach (var pair in _byOwner)
        {
            pair.Value.RemoveAll(e => e.ExpiresAt <= now);
            if (pair.Value.Count == 0)
            {
                (emptyKeys ??= new List<string>()).Add(pair.Key);
            }
        }
        if (emptyKeys is not null)
        {
            foreach (var key in emptyKeys)
            {
                _byOwner.Remove(key);
            }
        }
    }

    /// <summary>根据当前缓存解析出设备列表（已合并 raop/airplay、已去重、按名称排序）。</summary>
    public IReadOnlyList<AirPlayDevice> Snapshot(DateTimeOffset now)
    {
        Cleanup(now);

        var raop = new List<AirPlayDevice>();
        var airplay = new List<AirPlayDevice>();

        foreach (var serviceBase in new[] { AirPlayDiscovery.RaopServiceType, AirPlayDiscovery.AirPlayServiceType })
        {
            var isRaop = string.Equals(serviceBase, AirPlayDiscovery.RaopServiceType, StringComparison.OrdinalIgnoreCase);
            var target = isRaop ? raop : airplay;
            foreach (var instance in FindServiceInstances(serviceBase, isRaop))
            {
                var device = ResolveInstance(instance, isRaop ? AirPlayServiceType.Raop : AirPlayServiceType.AirPlay);
                if (device is not null)
                {
                    target.Add(device);
                }
            }
        }

        // 先按 MAC/名称给 raop 去重；再吸收 airplay 记录。
        var merged = new List<AirPlayDevice>(raop.Count);
        var byMergeKey = new Dictionary<string, AirPlayDevice>(StringComparer.OrdinalIgnoreCase);
        foreach (var device in raop)
        {
            string key = MergeKey(device);
            if (byMergeKey.TryGetValue(key, out var existing))
            {
                // 同一台设备的多条 raop 记录（例如重复 PTR / 多地址）：保留信息更全的一条。
                if (IsMoreComplete(device, existing))
                {
                    byMergeKey[key] = device;
                }
                continue;
            }
            byMergeKey[key] = device;
        }

        var usedAirplay = new HashSet<AirPlayDevice>();
        foreach (var device in raop)
        {
            string key = MergeKey(device);
            if (!byMergeKey.TryGetValue(key, out var best) || !ReferenceEquals(best, device))
            {
                continue;
            }
            var match = FindAirPlayCounterpart(device, airplay, usedAirplay);
            if (match is not null)
            {
                usedAirplay.Add(match);
                merged.Add(AirPlayDevice.Merge(device, match));
            }
            else
            {
                merged.Add(device);
            }
        }

        // 只有 airplay 服务、没有 raop 的设备（AirPlay 2 / 不支持 RAOP 音频的设备）。
        foreach (var device in airplay)
        {
            if (!usedAirplay.Contains(device))
            {
                merged.Add(device);
            }
        }

        merged.Sort(static (a, b) =>
        {
            int byName = string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase);
            return byName != 0 ? byName : string.Compare(a.Host, b.Host, StringComparison.OrdinalIgnoreCase);
        });
        return merged;
    }

    /// <summary>找出某个服务类型下所有候选实例名：PTR 目标 + 缓存里直接出现的 SRV 记录名。</summary>
    private List<string> FindServiceInstances(string serviceBase, bool isRaop)
    {
        var instances = new List<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        if (_byOwner.TryGetValue(serviceBase, out var ptrOwners))
        {
            foreach (var entry in ptrOwners)
            {
                if (entry.Record.Type != DnsRecordType.Ptr || entry.Record.PtrTarget is null)
                {
                    continue;
                }
                if (seen.Add(entry.Record.PtrTarget))
                {
                    instances.Add(entry.Record.PtrTarget);
                }
            }
        }

        // 有些设备不发 PTR（或我们错过了），直接把缓存里的 SRV 记录名当候选。
        string suffix = isRaop ? "." + serviceBase : "." + serviceBase;
        foreach (var pair in _byOwner)
        {
            foreach (var entry in pair.Value)
            {
                if (entry.Record.Type == DnsRecordType.Srv &&
                    entry.Record.Name.EndsWith(suffix, StringComparison.OrdinalIgnoreCase) &&
                    seen.Add(entry.Record.Name))
                {
                    instances.Add(entry.Record.Name);
                }
            }
        }
        return instances;
    }

    private AirPlayDevice? ResolveInstance(string instanceName, AirPlayServiceType serviceType)
    {
        if (!_byOwner.TryGetValue(instanceName, out var entries) || entries.Count == 0)
        {
            return null;
        }

        DnsRecord? srvRecord = null;
        IReadOnlyDictionary<string, string>? txt = null;
        foreach (var entry in entries)
        {
            if (entry.Record.Type == DnsRecordType.Srv && srvRecord is null)
            {
                srvRecord = entry.Record;
            }
            else if (entry.Record.Type == DnsRecordType.Txt && txt is null)
            {
                txt = entry.Record.ToTxtDictionary();
            }
        }

        if (srvRecord is null || string.IsNullOrEmpty(srvRecord.SrvTarget))
        {
            return null;
        }

        IPAddress? address = ResolveAddress(srvRecord.SrvTarget);
        if (address is null)
        {
            return null;
        }

        try
        {
            return AirPlayDevice.Create(serviceType, srvRecord, address, txt);
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"[mDNS] 解析设备 {instanceName} 失败: {ex.Message}");
            return null;
        }
    }

    /// <summary>在缓存中找 SRV target 对应的 A（优先）/ AAAA 记录。</summary>
    private IPAddress? ResolveAddress(string hostName)
    {
        if (!_byOwner.TryGetValue(hostName, out var entries) || entries.Count == 0)
        {
            // SRV target 有时带/不带结尾点，尝试宽松匹配一次。
            string normalized = AirPlayDevice.NormalizeHostName(hostName);
            var match = _byOwner.Keys.FirstOrDefault(k =>
                string.Equals(AirPlayDevice.NormalizeHostName(k), normalized, StringComparison.OrdinalIgnoreCase));
            if (match is null || !_byOwner.TryGetValue(match, out entries))
            {
                return null;
            }
        }

        IPAddress? ipv4 = null;
        IPAddress? ipv6 = null;
        foreach (var entry in entries)
        {
            if (entry.Record.Address is null)
            {
                continue;
            }
            if (entry.Record.Type == DnsRecordType.A && ipv4 is null)
            {
                ipv4 = entry.Record.Address;
            }
            else if (entry.Record.Type == DnsRecordType.Aaaa && ipv6 is null)
            {
                ipv6 = entry.Record.Address;
            }
        }

        // 优先 IPv4：Windows 上 RAOP 走 IPv4 最稳，且多半和 mDNS 来源地址同网段。
        return ipv4 ?? ipv6;
    }

    private static string MergeKey(AirPlayDevice device)
    {
        if (!string.IsNullOrEmpty(device.MacAddress))
        {
            return "mac:" + device.MacAddress;
        }
        string name = device.Name.Trim();
        return name.Length > 0 ? "name:" + name.ToLowerInvariant() : "host:" + device.Host;
    }

    private static bool IsMoreComplete(AirPlayDevice candidate, AirPlayDevice current)
    {
        static int Score(AirPlayDevice d) =>
            (d.HasRaopService ? 1 : 0) + (d.HasAirPlayService ? 1 : 0) +
            (string.IsNullOrEmpty(d.Model) ? 0 : 1) + (string.IsNullOrEmpty(d.Version) ? 0 : 1) +
            d.Txt.Count;
        return Score(candidate) > Score(current);
    }

    /// <summary>在 airplay 设备里找与 raop 设备是同一台的那条：MAC 相同 / 名称相同 / IP 相同。</summary>
    private static AirPlayDevice? FindAirPlayCounterpart(AirPlayDevice raopDevice, List<AirPlayDevice> airplayDevices, HashSet<AirPlayDevice> used)
    {
        AirPlayDevice? byName = null;
        AirPlayDevice? byAddress = null;
        foreach (var candidate in airplayDevices)
        {
            if (used.Contains(candidate))
            {
                continue;
            }
            if (!string.IsNullOrEmpty(raopDevice.MacAddress) &&
                !string.IsNullOrEmpty(candidate.MacAddress) &&
                string.Equals(raopDevice.MacAddress, candidate.MacAddress, StringComparison.OrdinalIgnoreCase))
            {
                return candidate;
            }
            if (byName is null &&
                !string.IsNullOrWhiteSpace(raopDevice.Name) &&
                string.Equals(raopDevice.Name.Trim(), candidate.Name.Trim(), StringComparison.OrdinalIgnoreCase))
            {
                byName = candidate;
            }
            if (byAddress is null && IPAddress.Equals(raopDevice.Address, candidate.Address))
            {
                byAddress = candidate;
            }
        }
        return byName ?? byAddress;
    }
}
