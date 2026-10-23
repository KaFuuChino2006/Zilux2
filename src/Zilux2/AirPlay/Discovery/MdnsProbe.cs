using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;

namespace Zilux2.AirPlay.Discovery;

/// <summary>
/// 一个参与 mDNS 组播的本地网络接口。保留接口索引与 IPv4 子网信息，
/// 用于把收到的响应归因到"设备在哪个网卡侧"，以及多网卡时分别发送查询。
/// </summary>
internal sealed class MdnsProbeInterface
{
    public MdnsProbeInterface(string name, string description, NetworkInterfaceType type,
        IPAddress? ipv4, IPAddress? ipv4Mask, int ipv4Index,
        IPAddress? ipv6, int ipv6Index)
    {
        Name = name;
        Description = description;
        Type = type;
        IPv4 = ipv4;
        IPv4Mask = ipv4Mask;
        IPv4Index = ipv4Index;
        IPv6 = ipv6;
        IPv6Index = ipv6Index;
    }

    /// <summary>接口名（Windows 上如 "以太网"）。</summary>
    public string Name { get; }

    public string Description { get; }

    public NetworkInterfaceType Type { get; }

    public IPAddress? IPv4 { get; }

    public IPAddress? IPv4Mask { get; }

    /// <summary>IPv4 接口索引（IP_ADAPTER_INFO IfIndex），接收报文里的 Interface 字段与之对应。</summary>
    public int IPv4Index { get; }

    /// <summary>该接口上的一个 IPv6 地址（可能为链路本地）。</summary>
    public IPAddress? IPv6 { get; }

    /// <summary>IPv6 接口索引，用于 IPV6_MULTICAST_IF / IPv6MulticastOption。</summary>
    public int IPv6Index { get; }

    public bool SupportsIPv6 => IPv6Index >= 0;

    /// <summary>判断某个 IPv4 地址是否与本接口处于同一子网（用于按来源地址归因网卡）。</summary>
    public bool ContainsIPv4(IPAddress address)
    {
        if (IPv4 is null || IPv4Mask is null || address.AddressFamily != AddressFamily.InterNetwork)
        {
            return false;
        }
        byte[] local = IPv4.GetAddressBytes();
        byte[] remote = address.GetAddressBytes();
        byte[] mask = IPv4Mask.GetAddressBytes();
        for (int i = 0; i < 4; i++)
        {
            if ((local[i] & mask[i]) != (remote[i] & mask[i]))
            {
                return false;
            }
        }
        return true;
    }

    public override string ToString() =>
        $"{Name} (idx4={IPv4Index}, idx6={IPv6Index}, v4={IPv4?.ToString() ?? "-"}, v6={IPv6?.ToString() ?? "-"})";
}

/// <summary>一次接收到的 mDNS 响应包，附带来源地址与入站网卡索引。</summary>
internal sealed class MdnsProbePacket
{
    public MdnsProbePacket(DnsMessage message, IPEndPoint source, int interfaceIndex, bool fromIPv6, DateTimeOffset receivedAt, byte[]? rawBytes = null)
    {
        Message = message;
        Source = source;
        InterfaceIndex = interfaceIndex;
        FromIPv6 = fromIPv6;
        ReceivedAt = receivedAt;
        RawBytes = rawBytes;
    }

    public DnsMessage Message { get; }

    public IPEndPoint Source { get; }

    /// <summary>IP_PKTINFO 提供的入站接口索引；为 0 表示系统没给（此时可用来源子网匹配）。</summary>
    public int InterfaceIndex { get; }

    public bool FromIPv6 { get; }

    public DateTimeOffset ReceivedAt { get; }

    /// <summary>原始报文（仅当 <see cref="MdnsProbe.CaptureRawBytes"/> 打开时保留），用于日志留证。</summary>
    public byte[]? RawBytes { get; }

    public override string ToString() =>
        $"{Source} if={InterfaceIndex} ipv6={FromIPv6} an={Message.Answers.Count} ar={Message.Additionals.Count}";
}

/// <summary>
/// mDNS 组播探测器：负责 socket 生命周期、加入组播组、发送 PTR 查询、接收并解析响应。
/// 只做网络收发，不理解业务；设备聚合在 <see cref="AirPlayDiscovery"/> 里。
///
/// 设计要点：
/// - 同时支持 IPv4 224.0.0.251:5353 与 IPv6 [ff02::fb]:5353（IPv6 失败不影响 IPv4）。
/// - 绑定 0.0.0.0:5353 / [::]:5353 并开启 SO_REUSEADDR：Windows 上允许与 Bonjour(mDNSResponder)
///   或浏览器等已占用 5353 的进程共存（各自收一份组播）。
/// - 对每块活动网卡分别 JoinMulticastGroup；发送时逐网卡设置 IP_MULTICAST_IF / IPV6_MULTICAST_IF，
///   避免像"只发到回环"那样的经典坑。
/// - 收到的包带 IPPacketInformation（接口索引），并使用来源地址做本机过滤。
/// - 所有网络错误通过构造时传入的 onError 回调上报，绝不向上抛异常。
/// - 本类型非线程安全，约定只由 <see cref="AirPlayDiscovery"/> 的后台线程使用。
/// </summary>
internal sealed class MdnsProbe : IDisposable
{
    public const string MdnsGroupIPv4 = "224.0.0.251";
    public const string MdnsGroupIPv6 = "ff02::fb";
    public const int MdnsPort = 5353;

    /// <summary>单条 UDP 报文的接收缓冲，mDNS 建议单包 &lt; 1500，留足余量。</summary>
    private const int ReceiveBufferSize = 9000;

    private readonly string[] _serviceTypes;
    private readonly Action<string>? _onError;
    private readonly byte[] _receiveBuffer = new byte[ReceiveBufferSize];
    private readonly List<MdnsProbeInterface> _interfaces = new();
    private readonly HashSet<IPAddress> _localAddresses = new();
    private readonly byte[] _queryPayload;

    private Socket? _socket4;
    private Socket? _socket6;
    private EndPoint _remoteTemplate4 = new IPEndPoint(IPAddress.Any, 0);
    private EndPoint _remoteTemplate6 = new IPEndPoint(IPAddress.IPv6Any, 0);
    private bool _packetInfo4;
    private bool _packetInfo6;
    private bool _disposed;

    public MdnsProbe(IEnumerable<string> serviceTypes, Action<string>? onError = null)
    {
        var list = new List<string>();
        foreach (var type in serviceTypes)
        {
            if (!string.IsNullOrWhiteSpace(type))
            {
                list.Add(type.Trim().TrimEnd('.'));
            }
        }
        if (list.Count == 0)
        {
            throw new ArgumentException("至少需要一个 DNS-SD 服务类型", nameof(serviceTypes));
        }
        _serviceTypes = list.ToArray();
        _onError = onError;
        _queryPayload = MdnsQueryWriter.BuildQuery(_serviceTypes);
        _endpoint4 = new IPEndPoint(IPAddress.Parse(MdnsGroupIPv4), MdnsPort);
    }

    private readonly IPEndPoint _endpoint4;

    /// <summary>参与组播的接口列表（IPv4 可用者；IPv6 仅作附加信息）。</summary>
    public IReadOnlyList<MdnsProbeInterface> Interfaces => _interfaces;

    public string[] ServiceTypes => _serviceTypes;

    /// <summary>是否至少有一个 socket 处于可用状态。</summary>
    public bool IsOpen => !_disposed && (_socket4 is not null || _socket6 is not null);

    public bool HasIPv4Socket => _socket4 is not null;

    public bool HasIPv6Socket => _socket6 is not null;

    /// <summary>
    /// 枚举网卡并打开 socket、加入组播组。重复调用无副作用。
    /// 返回 false 表示一个 socket 都没能建立（此时不会有任何发现结果）。
    /// </summary>
    public bool Open()
    {
        if (_disposed)
        {
            return false;
        }
        if (IsOpen)
        {
            return true;
        }

        try
        {
            DiscoverInterfaces();
            if (_interfaces.Count == 0)
            {
                Report("没有找到可用于 mDNS 的 IPv4 网络接口（需要已连接且支持组播的网卡，如以太网/WLAN）");
            }

            _socket4 = OpenSocket4();
            if (_socket4 is not null)
            {
                foreach (var iface in _interfaces)
                {
                    TryJoinIPv4(iface);
                }
                TryConfigureCommonOptions(_socket4, isIPv6: false);
            }

            _socket6 = OpenSocket6();
            if (_socket6 is not null)
            {
                int joined = 0;
                foreach (var iface in _interfaces)
                {
                    if (iface.SupportsIPv6 && TryJoinIPv6(iface))
                    {
                        joined++;
                    }
                }
                TryConfigureCommonOptions(_socket6, isIPv6: true);
                if (joined == 0)
                {
                    // 没有成功加入任何组：IPv6 socket 留着也没意义，关掉减少干扰。
                    _socket6.Dispose();
                    _socket6 = null;
                }
            }

            if (!IsOpen)
            {
                Report("mDNS socket 未能建立（IPv4/IPv6 都失败）");
                return false;
            }

            ReportDebug($"已打开 mDNS socket：IPv4={_socket4 is not null}, IPv6={_socket6 is not null}, 接口={_interfaces.Count}");
            return true;
        }
        catch (Exception ex)
        {
            Report($"初始化 mDNS 失败: {ex.GetType().Name}: {ex.Message}");
            return false;
        }
    }

    /// <summary>向所有接口发送一轮 PTR 组播查询。返回成功发出的目标数。不抛异常。</summary>
    public int SendQueries()
    {
        if (!IsOpen)
        {
            return 0;
        }

        int sent = 0;
        foreach (var iface in _interfaces)
        {
            if (_socket4 is not null && iface.IPv4 is not null)
            {
                try
                {
                    // 注意：IP_MULTICAST_IF 传 IPAddress 会抛 ArgumentException（"The specified value is not valid"），
                    // .NET/Windows 下必须传地址字节数组。
                    _socket4.SetSocketOption(SocketOptionLevel.IP, SocketOptionName.MulticastInterface, iface.IPv4.GetAddressBytes());
                    _socket4.SendTo(_queryPayload, _endpoint4);
                    sent++;
                }
                catch (Exception ex)
                {
                    Report($"经 {iface.Name}({iface.IPv4}) 发送 IPv4 mDNS 查询失败: {ex.GetType().Name}: {ex.Message}");
                }
            }

            if (_socket6 is not null && iface.SupportsIPv6)
            {
                try
                {
                    _socket6.SetSocketOption(SocketOptionLevel.IPv6, SocketOptionName.MulticastInterface, iface.IPv6Index);
                    // ff02:: 是链路本地组播，目的地址必须带 scope id，否则 Windows 会报 EADDRNOTAVAIL。
                    var target = new IPAddress(IPv6GroupBytes, iface.IPv6Index);
                    _socket6.SendTo(_queryPayload, new IPEndPoint(target, MdnsPort));
                    sent++;
                }
                catch (Exception ex)
                {
                    Report($"经 {iface.Name} 发送 IPv6 mDNS 查询失败: {ex.GetType().Name}: {ex.Message}");
                }
            }
        }

        if (sent == 0)
        {
            Report("mDNS 查询未能从任何接口发出（检查网卡状态 / IPv4 地址）");
        }
        ReportDebug($"已发送 mDNS 查询，目标接口数={sent}；查询={string.Join(", ", _serviceTypes)}");
        return sent;
    }

    /// <summary>
    /// 在 timeout 内等待报文到达并解析进 packets（先清空列表）。
    /// 使用 Socket.Select 同时监听 IPv4/IPv6 两个 socket。返回收到的响应包数量。
    /// 阻塞时间上限约等于 timeout；出错时提前返回，不抛异常。
    /// </summary>
    public int Receive(TimeSpan timeout, List<MdnsProbePacket> packets)
    {
        packets.Clear();
        if (!IsOpen)
        {
            SleepSafely(timeout);
            return 0;
        }

        var readable = new List<Socket>(2);
        if (_socket4 is not null)
        {
            readable.Add(_socket4);
        }
        if (_socket6 is not null)
        {
            readable.Add(_socket6);
        }

        int microseconds = (int)Math.Clamp(timeout.TotalMilliseconds * 1000, 0, int.MaxValue);
        try
        {
            Socket.Select(readable, null, null, microseconds);
        }
        catch (Exception ex)
        {
            Report($"等待 mDNS 报文失败: {ex.GetType().Name}: {ex.Message}");
            return 0;
        }

        foreach (var socket in readable)
        {
            DrainSocket(socket, packets);
        }
        return packets.Count;
    }

    /// <summary>判断地址是否属于本机（用一个无连接的 UDP socket 的本地端点信息判断，避免自己发的包自激）。</summary>
    public bool IsLocalAddress(IPAddress address)
    {
        if (IPAddress.IsLoopback(address))
        {
            return true;
        }
        IPAddress normalized = address.IsIPv4MappedToIPv6 ? address.MapToIPv4() : address;
        return _localAddresses.Contains(normalized);
    }

    /// <summary>根据入站接口索引或来源子网，找到报文来自哪块网卡。找不到返回 null。</summary>
    public MdnsProbeInterface? FindInterfaceFor(MdnsProbePacket packet)
    {
        if (packet.InterfaceIndex != 0)
        {
            foreach (var iface in _interfaces)
            {
                if (iface.IPv4Index == packet.InterfaceIndex || (iface.SupportsIPv6 && iface.IPv6Index == packet.InterfaceIndex))
                {
                    return iface;
                }
            }
        }
        foreach (var iface in _interfaces)
        {
            if (iface.ContainsIPv4(packet.Source.Address))
            {
                return iface;
            }
        }
        return null;
    }

    /// <summary>接口描述，供日志/README 示例输出。</summary>
    public string DescribeInterfaces()
    {
        if (_interfaces.Count == 0)
        {
            return "(无可用接口)";
        }
        var sb = new StringBuilder();
        foreach (var iface in _interfaces)
        {
            sb.Append("  - ").Append(iface).AppendLine();
        }
        return sb.ToString().TrimEnd();
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }
        _disposed = true;
        try
        {
            _socket4?.Dispose();
        }
        catch
        {
            // ignore
        }
        try
        {
            _socket6?.Dispose();
        }
        catch
        {
            // ignore
        }
        _socket4 = null;
        _socket6 = null;
    }

    // ---------------- 内部实现 ----------------

    private static readonly byte[] IPv6GroupBytes = IPAddress.Parse(MdnsGroupIPv6).GetAddressBytes();

    private void DiscoverInterfaces()
    {
        _interfaces.Clear();
        _localAddresses.Clear();
        _localAddresses.Add(IPAddress.Loopback);
        _localAddresses.Add(IPAddress.IPv6Loopback);

        foreach (var ni in NetworkInterface.GetAllNetworkInterfaces())
        {
            try
            {
                if (ni.OperationalStatus != OperationalStatus.Up || !ni.SupportsMulticast)
                {
                    continue;
                }
                if (ni.NetworkInterfaceType is NetworkInterfaceType.Loopback or NetworkInterfaceType.Tunnel or NetworkInterfaceType.Unknown)
                {
                    continue;
                }

                IPInterfaceProperties properties;
                try
                {
                    properties = ni.GetIPProperties();
                }
                catch
                {
                    continue;
                }

                IPAddress? v4 = null;
                IPAddress? mask = null;
                IPAddress? v6 = null;
                foreach (var unicast in properties.UnicastAddresses)
                {
                    try
                    {
                        if (unicast.Address.AddressFamily == AddressFamily.InterNetwork)
                        {
                            if (v4 is null && !unicast.Address.ToString().StartsWith("169.254.", StringComparison.Ordinal))
                            {
                                v4 = unicast.Address;
                                mask = unicast.IPv4Mask;
                            }
                        }
                        else if (unicast.Address.AddressFamily == AddressFamily.InterNetworkV6)
                        {
                            // 优先全局地址；没有的话链路本地地址也可以用于 Join。
                            if (v6 is null || (v6.IsIPv6LinkLocal && !unicast.Address.IsIPv6LinkLocal))
                            {
                                v6 = unicast.Address;
                            }
                        }
                    }
                    catch
                    {
                        // 某些虚拟接口访问属性会抛 NetworkInformationException，跳过即可。
                    }
                }

                if (v4 is null)
                {
                    continue;
                }

                int v4Index = -1;
                int v6Index = -1;
                try
                {
                    v4Index = properties.GetIPv4Properties()?.Index ?? -1;
                }
                catch
                {
                    v4Index = -1;
                }
                try
                {
                    v6Index = properties.GetIPv6Properties()?.Index ?? -1;
                }
                catch
                {
                    // 10043: 接口上没启用 IPv6，正常情况。
                    v6Index = -1;
                }

                _localAddresses.Add(v4);
                if (v6 is not null)
                {
                    _localAddresses.Add(v6);
                }
                _interfaces.Add(new MdnsProbeInterface(
                    ni.Name,
                    ni.Description ?? string.Empty,
                    ni.NetworkInterfaceType,
                    v4,
                    mask,
                    v4Index >= 0 ? v4Index : 0,
                    v6,
                    v6Index));
            }
            catch (Exception ex)
            {
                ReportDebug($"枚举网卡 {ni.Name} 时出错: {ex.GetType().Name}: {ex.Message}");
            }
        }
    }

    private Socket? OpenSocket4()
    {
        Socket? socket = null;
        try
        {
            socket = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp);
            socket.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
            socket.Bind(new IPEndPoint(IPAddress.Any, MdnsPort));
            try
            {
                socket.SetSocketOption(SocketOptionLevel.IP, SocketOptionName.PacketInformation, true);
                _packetInfo4 = true;
            }
            catch (Exception ex)
            {
                _packetInfo4 = false;
                ReportDebug($"IPv4 PacketInformation 不可用，将退化为按子网判断网卡: {ex.Message}");
            }
            return socket;
        }
        catch (Exception ex)
        {
            Report($"打开 IPv4 mDNS socket 失败（5353 端口是否被独占？）: {ex.GetType().Name}: {ex.Message}");
            socket?.Dispose();
            return null;
        }
    }

    private Socket? OpenSocket6()
    {
        Socket? socket = null;
        try
        {
            socket = new Socket(AddressFamily.InterNetworkV6, SocketType.Dgram, ProtocolType.Udp)
            {
                DualMode = false,
            };
            socket.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
            socket.Bind(new IPEndPoint(IPAddress.IPv6Any, MdnsPort));
            try
            {
                socket.SetSocketOption(SocketOptionLevel.IPv6, SocketOptionName.PacketInformation, true);
                _packetInfo6 = true;
            }
            catch (Exception ex)
            {
                _packetInfo6 = false;
                ReportDebug($"IPv6 PacketInformation 不可用: {ex.Message}");
            }
            return socket;
        }
        catch (Exception ex)
        {
            // IPv6 是可选能力：Windows 上关闭 IPv6 或端口冲突都可能失败，不影响 IPv4 发现。
            ReportDebug($"打开 IPv6 mDNS socket 失败（IPv4 发现不受影响）: {ex.GetType().Name}: {ex.Message}");
            socket?.Dispose();
            return null;
        }
    }

    private void TryJoinIPv4(MdnsProbeInterface iface)
    {
        if (_socket4 is null || iface.IPv4 is null)
        {
            return;
        }
        try
        {
            _socket4.SetSocketOption(
                SocketOptionLevel.IP,
                SocketOptionName.AddMembership,
                new MulticastOption(IPAddress.Parse(MdnsGroupIPv4), iface.IPv4));
            ReportDebug($"加入 IPv4 组播组 {MdnsGroupIPv4} @ {iface.IPv4} ({iface.Name})");
        }
        catch (Exception ex)
        {
            Report($"在 {iface.Name}({iface.IPv4}) 上加入 mDNS 组播组失败: {ex.GetType().Name}: {ex.Message}");
        }
    }

    private bool TryJoinIPv6(MdnsProbeInterface iface)
    {
        if (_socket6 is null || !iface.SupportsIPv6)
        {
            return false;
        }
        try
        {
            _socket6.SetSocketOption(
                SocketOptionLevel.IPv6,
                SocketOptionName.AddMembership,
                new IPv6MulticastOption(IPAddress.Parse(MdnsGroupIPv6), iface.IPv6Index));
            return true;
        }
        catch (Exception ex)
        {
            Report($"在 {iface.Name}(idx={iface.IPv6Index}) 上加入 IPv6 mDNS 组播组失败: {ex.GetType().Name}: {ex.Message}");
            return false;
        }
    }

    private void TryConfigureCommonOptions(Socket socket, bool isIPv6)
    {
        var level = isIPv6 ? SocketOptionLevel.IPv6 : SocketOptionLevel.IP;
        try
        {
            // mDNS 报文链路本地传播，TTL/HopLimit 设小即可（默认 1 也够用，这里显式设为 1）。
            socket.SetSocketOption(level, SocketOptionName.MulticastTimeToLive, 1);
        }
        catch
        {
            // 平台差异，忽略。
        }
        try
        {
            // 关掉组播回环：不需要看到自己发的包（仍会按本机地址过滤做兜底）。
            socket.SetSocketOption(level, SocketOptionName.MulticastLoopback, false);
        }
        catch
        {
            // 部分平台不支持关闭，忽略。
        }
        try
        {
            socket.ReceiveBufferSize = 128 * 1024;
        }
        catch
        {
            // ignore
        }
    }

    private void DrainSocket(Socket socket, List<MdnsProbePacket> packets)
    {
        bool packetInfo = socket.AddressFamily == AddressFamily.InterNetwork ? _packetInfo4 : _packetInfo6;
        EndPoint remoteTemplate = socket.AddressFamily == AddressFamily.InterNetwork ? _remoteTemplate4 : _remoteTemplate6;

        while (true)
        {
            bool readable;
            try
            {
                readable = socket.Poll(0, SelectMode.SelectRead);
            }
            catch
            {
                return;
            }
            if (!readable)
            {
                return;
            }

            EndPoint remote = remoteTemplate;
            try
            {
                var flags = SocketFlags.None;
                int received;
                IPPacketInformation packetInfoValue = default;
                if (packetInfo)
                {
                    received = socket.ReceiveMessageFrom(_receiveBuffer, 0, _receiveBuffer.Length, ref flags, ref remote, out packetInfoValue);
                }
                else
                {
                    received = socket.ReceiveFrom(_receiveBuffer, 0, _receiveBuffer.Length, SocketFlags.None, ref remote);
                }

                if (received < DnsMessage.HeaderSize)
                {
                    continue;
                }

                var source = (IPEndPoint)remote;
                if (!DnsMessage.TryParse(_receiveBuffer.AsSpan(0, received), out var message, out var parseError))
                {
                    ReportDebug($"丢弃无法解析的 mDNS 报文 ({source}, {received} 字节): {parseError}");
                    continue;
                }
                if (!message.IsResponse)
                {
                    // 别人发的查询（包括我们自己的镜像）不需要处理。
                    continue;
                }
                if (IsLocalAddress(source.Address))
                {
                    continue;
                }
                if (parseError is not null)
                {
                    ReportDebug($"mDNS 报文部分损坏 ({source}): {parseError}");
                }

                packets.Add(new MdnsProbePacket(
                    message,
                    source,
                    packetInfoValue.Interface,
                    socket.AddressFamily == AddressFamily.InterNetworkV6,
                    DateTimeOffset.UtcNow,
                    CaptureRawBytes ? _receiveBuffer.AsSpan(0, received).ToArray() : null));
            }
            catch (SocketException ex) when (ex.SocketErrorCode is SocketError.WouldBlock or SocketError.TimedOut or SocketError.ConnectionReset)
            {
                // 报文被 ICMP 拒绝等，忽略继续。
                return;
            }
            catch (Exception ex)
            {
                Report($"接收 mDNS 报文失败: {ex.GetType().Name}: {ex.Message}");
                return;
            }
        }
    }

    private static void SleepSafely(TimeSpan timeout)
    {
        if (timeout > TimeSpan.Zero)
        {
            try
            {
                Thread.Sleep(timeout);
            }
            catch (ThreadInterruptedException)
            {
                Thread.CurrentThread.Interrupt();
            }
        }
    }

    private void Report(string message) => _onError?.Invoke(message);

    private void ReportDebug(string message)
    {
        System.Diagnostics.Debug.WriteLine($"[mDNS] {message}");
        _debugTrace?.Invoke(message);
    }

    private Action<string>? _debugTrace;

    /// <summary>内部调试钩子：把 socket 生命周期等细节交给 harness / 发现器记录。</summary>
    internal Action<string>? DebugTrace
    {
        get => _debugTrace;
        set => _debugTrace = value;
    }

    /// <summary>为 true 时把每个收到的报文原始字节复制到 <see cref="MdnsProbePacket.RawBytes"/>（仅供调试，默认关闭）。</summary>
    internal bool CaptureRawBytes { get; set; }

    // ---------------- 调试辅助 ----------------

    /// <summary>把一条 mDNS 报文格式化成可读文本（用于日志与 harness 证据）。</summary>
    internal static string DescribeMessage(DnsMessage message, int maxRecords = 12)
    {
        var sb = new StringBuilder(256);
        sb.Append("flags=0x").Append(message.Flags.ToString("X4"))
            .Append(" qd=").Append(message.Questions.Count)
            .Append(" an=").Append(message.Answers.Count)
            .Append(" ns=").Append(message.Authorities.Count)
            .Append(" ar=").Append(message.Additionals.Count);
        if (message.ParseWarning is not null)
        {
            sb.Append(" warning=").Append(message.ParseWarning);
        }

        int shown = 0;
        foreach (var question in message.Questions)
        {
            if (shown++ >= maxRecords)
            {
                break;
            }
            sb.AppendLine().Append("  Q  ").Append(question);
        }
        foreach (var record in message.AllRecords())
        {
            if (shown++ >= maxRecords)
            {
                break;
            }
            sb.AppendLine().Append("  RR ").Append(record);
        }
        return sb.ToString();
    }

    /// <summary>十六进制 dump（截断到 maxBytes），用于日志留证。</summary>
    internal static string HexDump(ReadOnlySpan<byte> data, int maxBytes = 256)
    {
        int length = Math.Min(data.Length, maxBytes);
        var sb = new StringBuilder(length * 3 + 32);
        for (int offset = 0; offset < length; offset += 16)
        {
            sb.Append(offset.ToString("X4")).Append(": ");
            int lineEnd = Math.Min(offset + 16, length);
            for (int i = offset; i < lineEnd; i++)
            {
                sb.Append(data[i].ToString("X2")).Append(' ');
            }
            for (int i = lineEnd; i < offset + 16; i++)
            {
                sb.Append("   ");
            }
            sb.Append(" |");
            for (int i = offset; i < lineEnd; i++)
            {
                byte b = data[i];
                sb.Append(b >= 32 && b < 127 ? (char)b : '.');
            }
            sb.AppendLine("|");
        }
        if (data.Length > length)
        {
            sb.Append("... (").Append(data.Length).Append(" 字节，已截断)").AppendLine();
        }
        return sb.ToString();
    }
}
