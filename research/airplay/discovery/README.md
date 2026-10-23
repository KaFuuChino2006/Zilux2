# AirPlay / RAOP 设备发现（mDNS / DNS-SD，零依赖）

Zilux2 的"投送音频到 AirPlay 设备"功能的第一层：在局域网内发现 AirPlay / RAOP 接收端（HomePod、Apple TV、Mac、shairport-sync 等）。

纯 BCL 实现（`System.Net.Sockets` / `System.Net.NetworkInformation`），**不新增任何 NuGet 包**，不访问文件系统，不依赖宿主类型（WPF/WebView2 无关，可单测、可复用）。

- 源码：`src/Zilux2/AirPlay/Discovery/`（SDK 样式主工程自动包含，随 `Zilux2.csproj` 编译）
- 对外契约：`src/Zilux2/AirPlay/IDeviceDiscovery.cs`（Lead 定义，`AirPlayDiscovery` 直接实现 `IAirPlayDeviceDiscovery`，无需适配器）
- 实测日志：`research/airplay/discovery/discovery-log.md` + `discovery-raw.log`
- 自测/真机 harness：`research/airplay/discovery/harness/`（独立工程，链接同一份源码）

## 1. 文件清单

| 文件 | 职责 |
|------|------|
| `MdnsMessage.cs` | DNS 报文编解码：header、question、answer/authority/additional、名字压缩指针（0xC0）、RR 类型 PTR(12)/SRV(33)/TXT(16)/A(1)/AAAA(28)/NSEC(47)；同名多记录、TTL；查询报文构造 `MdnsQueryWriter` |
| `MdnsProbe.cs` | UDP 组播：IPv4 `224.0.0.251:5353` + IPv6 `[ff02::fb]:5353`；`SO_REUSEADDR`；逐网卡 `JoinMulticastGroup`；按网卡指定发送接口；`ReceiveMessageFrom` 保留到达网卡与源地址 |
| `AirPlayDiscovery.cs` | 设备发现器：后台线程、查询/接收循环、TTL 缓存（`MdnsServiceResolver`，含 goodbye/cache-flush）、raop+airplay 归并、变更回调、`IAirPlayDeviceDiscovery` 实现 |
| `AirPlayDevice.cs` | 设备模型 + TXT 派生信息解析（`AirPlayTxtInfo`）：型号、版本、vv、特性位、状态位、加密类型、通道、密码、MAC |

## 2. API

### 2.1 对外接口（`Zilux2.AirPlay` 命名空间，`IDeviceDiscovery.cs`）

```csharp
internal sealed class AirPlayDeviceInfo
{
    public required string Id { get; init; }        // 稳定唯一：优先 MAC，否则 raop 完整服务名
    public required string Name { get; init; }      // 人类可读名称，如 "客厅"、"白色pod"
    public required string Host { get; init; }      // IPv4 点分字符串（优先 A 记录）
    public int Port { get; init; } = 7000;          // 有 RAOP SRV 端口用 RAOP，否则 AirPlay
    public string? Model { get; init; }             // "AudioAccessory5,1"、"MacBookPro18,3"
    public bool RequiresPassword { get; init; }
    public bool SupportsAirPlay2 { get; init; }
}

internal interface IAirPlayDeviceDiscovery : IDisposable
{
    event Action<IReadOnlyList<AirPlayDeviceInfo>>? DevicesChanged;
    bool IsRunning { get; }
    void Start();    // 幂等
    void Stop();     // 幂等
    void Refresh();  // 立即重查
}
```

### 2.2 发现器（`Zilux2.AirPlay.Discovery` 命名空间）

```csharp
internal sealed class AirPlayDiscovery : IAirPlayDeviceDiscovery
{
    public AirPlayDiscovery();                                  // 默认发现 _raop._tcp.local + _airplay._tcp.local
    public AirPlayDiscovery(IEnumerable<string> serviceTypes);  // 自定义服务类型（须含 .local 后缀）

    // —— IAirPlayDeviceDiscovery ——
    public event Action<IReadOnlyList<AirPlayDeviceInfo>>? DevicesChanged; // 后台线程触发
    public bool IsRunning { get; }
    public void Start();                                        // 幂等，开始后台发现
    public void Stop();                                         // 幂等，停止并 Join 后台线程（≤3s）
    public void Refresh();                                      // 立即补发一轮查询（线程安全）
    public void Dispose();

    // —— 扩展 API ——
    public Action<string>? OnError { get; set; }                // 错误回调（后台线程），不抛异常逃逸
    public void Start(Action<IReadOnlyList<AirPlayDevice>> onDevicesChanged); // 富信息回调版本（见 AirPlayDevice）
    public IReadOnlyList<AirPlayDevice> Devices { get; }        // 最近一次快照（volatile，只读不可变）
    public IReadOnlyList<string> ServiceTypes { get; }
    public TimeSpan QueryInterval { get; set; }                 // 默认 5s
    public TimeSpan ReceiveSlice { get; set; }                  // 默认 250ms，单次 Select 等待上限
}
```

### 2.3 设备模型（富信息，供 RTSP 层直接用）

```csharp
internal enum AirPlayServiceType { Raop, AirPlay }

internal sealed class AirPlayDevice
{
    public string Name { get; }                       // raop 实例名去掉 "MAC@" 前缀；无 raop 时用 airplay 实例名
    public IPAddress Address { get; }
    public string Host { get; }                       // Address.ToString()
    public int Port { get; }                          // RaopPort ?? AirPlayPort ?? 0
    public AirPlayServiceType ServiceType { get; }    // 主服务（有 raop 即 raop）
    public bool HasRaopService { get; }               // RaopPort.HasValue
    public bool HasAirPlayService { get; }            // AirPlayPort.HasValue
    public int? RaopPort { get; }                     // 实测 HomePod/Mac 均为 7000
    public int? AirPlayPort { get; }
    public string ServiceName { get; }                // 主服务实例名，如 "8218BF001807@白色pod"
    public string FullServiceName { get; }            // 带服务类型后缀的完整名
    public string? MacAddress { get; }                // "82:18:BF:00:18:07"（raop 前缀或 deviceid）
    public IReadOnlyDictionary<string, string> Txt { get; } // 原始 TXT 键值（大小写不敏感，raop+airplay 合并）
    public string? Model { get; }                     // airplay "model"，无则 raop "am"
    public string? ModelName { get; }                 // "am"
    public string? Version { get; }                   // vs / srcvers
    public string? AirPlay2Version { get; }           // vv
    public string? DeviceId { get; }
    public string? PublicKey { get; }                 // pk
    public bool IsPasswordProtected { get; }          // pw=true/1/yes
    public bool SupportsAirPlay2 { get; }             // vv 存在 或 vs 主版本 >= 130
    public ulong? Features { get; }                   // ft/features（低 32 位在前）
    public uint? StatusFlags { get; }                 // sf/flags
    public IReadOnlyList<int> EncryptionTypes { get; } // et（0 明文/1 RSA/4 FairPlay/5 MFi）
    public IReadOnlyList<int> MetadataTypes { get; }  // md（RAOP 元数据类型，不是型号！）
    public IReadOnlyList<int> AudioChannels { get; }  // cn
    public int? SampleRate { get; }                   // sr
    public int? SampleSize { get; }                   // ss
    public string? Transport { get; }                 // tp（通常 "UDP"）
}
```

### 2.4 集成示例（宿主 UI 线程注意 Marshal）

```csharp
_discovery = new AirPlayDiscovery
{
    OnError = message => Log.Warn("AirPlay 发现: " + message),
};
_discovery.DevicesChanged += devices =>            // ← 后台线程！
{
    App.Current.Dispatcher.Invoke(() =>
    {
        DeviceList.ItemsSource = devices;          // AirPlayDeviceInfo 列表
    });
};
_discovery.Start();
// 之后：
_discovery.Refresh();                              // 用户点"刷新"
_discovery.Dispose();                              // 窗口关闭
```

> 若需要 `ek=`/`tp=`/`cn=` 等原始字段，用 `Start(Action<IReadOnlyList<AirPlayDevice>>)` 富回调版本，`AirPlayDevice.Txt` 里有完整 TXT。

## 3. 线程模型

- `Start()` 创建 **一个后台线程**（`IsBackground=true`，名称 `Zilux2.AirPlay.mDNS`）：
  `Open()` socket → 发送首轮查询 → 循环 { 每 `QueryInterval` 或收到 `Refresh()` 请求时 `SendQueries()`；`Receive(ReceiveSlice)` 收包；`resolver.AddRecords`；有变化时 `Snapshot()` 并回调 } → `Stop()` 时退出并 `Dispose` socket。
- **回调线程**：`DevicesChanged` / `Start(Action<...>)` 的回调 / `OnError` 全部在后台 mDNS 线程上触发，**不是 UI 线程**。宿主必须自行 `Dispatcher.Invoke/BeginInvoke`（WPF）或同步上下文。
- 回调只在**设备集合的指纹**（名称/地址/端口/MAC/型号/版本/特性/TXT…）变化时触发；首次为"空列表"也会触发一次，方便宿主初始化。
- 回调内部抛异常会被捕获并转给 `OnError`，不会杀死后台线程；后台循环的异常同样兜底后以错误回调上报并重试下一轮。
- `Devices` 是 `volatile` 不可变快照，任意线程可安全读取。
- `Stop()` 从回调线程内调用不会自锁（检测到自身线程则跳过 Join）；`Start()`/`Stop()`/`Refresh()` 幂等且线程安全。

## 4. 限流、重试与缓存

- 查询周期默认 **5 秒**（`QueryInterval`）；`Refresh()` 只置一个标志，由后台线程在下一轮立即补发，不阻塞调用者。
- 每个报文只解析一次，TTL 缓存按 **owner 名 + RR 类型** 分桶，TTL clamp 到 `[1s, 86400s]`；`TTL=0`（goodbye）删除同 `RDataKey` 记录；同 owner/同类型的 cache-flush 记录先清旧值再加新值。
- 缓存上限 4096 条，防止异常网络刷爆内存；`Snapshot()` 时过滤过期项，所以**设备离线后最多一个 TTL 周期（实测 4500s）内仍会显示**——需要更快的离线感知可缩短 `QueryInterval` 或加 UI 侧超时。
- 接收超时（`ReceiveSlice=250ms`）不会发新查询；"先查缓存再发新一轮"由主循环实现：每轮先处理已缓存的记录并回调，再按 `QueryInterval` 决定是否重新发查询。
- 无设备时不会报错，只是回调一次空列表；LAN 上无响应时下一次查询周期自然重试。

## 5. 协议要点与实测坑

1. **查询**：`_raop._tcp.local`、`_airplay._tcp.local` 的 PTR/IN/QM 查询，`id=0`、`flags=0`；响应 flags 常见 `0x8400`（QR+AA），**QDCOUNT=0**，PTR 在 Answer、SRV/TXT/A/AAAA 在 Additional。
2. **名字压缩**：大量 `0xC0` 指针；解析器支持跳转、最多 16 次防环、总名长 ≤255，遇到越界/截断置 `ParseWarning` 或拒绝解析，不会崩。
3. **归并**：单台设备同时通告 `_raop._tcp` 与 `_airplay._tcp`。用 `MAC`（raop 实例名前缀 `AABBCCDDEEFF@名称`）或 `Host+名称` 归并；**raop 记录优先**（端口/名称/地址），TXT 两份合并（raop 覆盖 airplay），合并后 `Id` 稳定不变（MAC 或 raop 完整服务名）。
4. **`md` 不是型号**（实测 HomePod mini / MacBook）：RAOP TXT 的 `md=0,1,2` 是"支持的元数据类型"，型号在 AirPlay 的 `model=`（`AudioAccessory5,1`、`MacBookPro18,3`）；raop 的 `am=` 是型号名。`Model` 取 `model`→`am`，`md` 单独暴露为 `MetadataTypes`。
5. **端口**：HomePod 与新款 Mac 的 RAOP SRV 端口是 **7000**（不是 AirPort 时代的 5000）；`AirPlayDeviceInfo.Port` = raop 端口优先，即实际 RTSP 端口。
6. **双栈重复**：同一设备在 IPv4/IPv6 各应答一次，缓存按记录级去重（同名同 RDATA 刷新 TTL），设备列表不重复。
7. **IPv6 组播**：目标 `ff02::fb`，必须带 scope-id（接口 ifIndex），`IPV6_MULTICAST_IF` 传 int；IPv4 的 `IP_MULTICAST_IF` 必须传 **4 字节地址**（传 `IPAddress` 会 ArgumentException）。本机无 IPv6 时自动跳过 IPv6 socket。
8. **多网卡**：只枚举 `OperationalStatus=Up && SupportsMulticast` 且非 Loopback/Tunnel/Unknown 的接口，跳过 169.254.*；`GetIPv4Properties()/GetIPv6Properties()` 在虚拟/过滤接口上会抛 `NetworkInformationException 10043`，必须逐个 try/catch。每个活动网卡分别 Join + 分别指定发送接口，`ReceiveMessageFrom` 的 `PacketInformation.Interface` 用于判断设备来自哪块网卡。
9. **端口 5353 常被占用**（本机有 msedge/steamwebhelper/Apple mDNSResponder）：必须 `SO_REUSEADDR` 后 `Bind(Any:5353)`；会收到本机自己发出的查询和本机 mDNSResponder 的报文，用"QR=0 不是响应 / 源地址是本机"过滤。
10. **防火墙**：Windows 防火墙可能拦截组播入站或首次绑定；开发机需允许应用访问专用网络，否则只能看到自己发出的包。测试时用 `--discover` harness 打印原始报文可快速判断是"没发出"还是"没收到"。
11. **同子网**：mDNS 不跨路由器，设备必须与 PC 在同一二层广播域；Android/Windows 上的 mDNS 服务与 Apple Bonjour 并存时可能抢答，属正常现象。

## 6. 验证方式

```powershell
# 1) 主工程编译（发现模块随之编译）
dotnet build src\Zilux2\Zilux2.csproj -c Debug

# 2) 自测：手工构造 mDNS 字节，验编解码/归并/goodbye/cache-flush/TTL/畸形报文
cd research\airplay\discovery\harness
dotnet run -c Debug -- --selftest

# 3) 真实网络发现 10 秒（打印每台设备 + 原始报文）
dotnet run -c Debug -- --discover 10
```

本次实测结果（2026-10-20，192.168.31.0/24）：发现 3 台 —— 白色pod（HomePod，192.168.31.183:7000）、香风智乃的MacBook Pro（192.168.31.233:7000）、黑色pod（HomePod，192.168.31.136:7000）。详见 `discovery-log.md`。
