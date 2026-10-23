# AirPlay 2 PTP 主时钟（Ap2PtpMaster）自测工程

本目录是 `src/Zilux2/AirPlay/Ap2/Ap2PtpMaster.cs`（AirPlay 2 PTP 主时钟，IEEE 1588-2008 / 802.1AS 子集）
的独立自测工程：不引用主工程，直接把产品源文件和 `HostLog.cs` 一起编进控制台程序，用本地 UDP
回环（`127.0.0.1` 发 → `127.0.0.5` 收）验证**报文二进制格式**和**真实收发时序**。

- 目标框架：`net10.0` 控制台，无 NuGet 依赖。
- 编译进来的源文件：
  - `..\..\..\src\Zilux2\AirPlay\Ap2\Ap2PtpMaster.cs`
  - `..\..\..\src\Zilux2\HostLog.cs`（产品代码里写日志用）
- 使用 `ImplicitUsings=enable`，与 WPF 主工程保持一致——产品源码依赖隐式全局 using（`System`、
  `System.Collections.Generic`、`System.Threading` 等），自测工程若关掉会直接编译失败。

## 构建与运行

```powershell
cd E:\Zilux2开发\research\airplay\ptp
E:\dotnet\dotnet.exe build .\PtpSelfTest.csproj -c Release --nologo
E:\dotnet\dotnet.exe .\bin\Release\net10.0\PtpSelfTest.dll
```

- 默认模式：先跑纯内存的**报文字节级断言**，再跑真实 UDP 的**收发/时序断言**。全部通过时退出码 0，
  输出 `===== result: 125 passed, 0 failed =====`；有失败时打印 `FAIL` 行并以退出码 1 结束。
- `--dump`：只打印固定参数下的 6 种报文十六进制（本 README 里的 hex 就是这么来的），不做网络测试。

```powershell
E:\dotnet\dotnet.exe .\bin\Release\net10.0\PtpSelfTest.dll --dump
```

本机验证结果（2026-10-20，Windows，dotnet 10.0.401）：**125 passed, 0 failed**。
网络测试用 `127.0.0.5:319/320` 收包，因此运行时不要有别的进程占用 UDP 319/320。
（`127.0.0.5` 是 Windows 可绑定的本机回环别名；Master 绑 `127.0.0.1`，两者互不冲突，
所以同一台机器上能完整跑「master 发 → 接收端收」的真实链路。）

## 产品 API（`Zilux2.AirPlay.Ap2.Ap2PtpMaster`）

`internal sealed class Ap2PtpMaster : IDisposable`。`internal` 意味着调用方必须和它编在同一个程序集
（主工程自然满足）；自测工程靠「直接 include 源文件」也满足。

```csharp
using System.Net;
using Zilux2.AirPlay.Ap2;

// 1) 启动：绑本机的 UDP 319(事件口)/320(通用口)，失败返回 null 并写 Warn 日志
Ap2PtpMaster? master = Ap2PtpMaster.TryStart(localAddress, new[] { deviceAddress });
if (master is null)
{
    // 端口被占 / 地址不可用：要么放弃 PTP 走 NTP 兜底，要么终止本次 AirPlay 会话
}

// 2) SETUP 阶段：把 ClockId 填进 plist 的 timingPeerInfo.ClockID（数值型，不是字符串）
ulong clockId = master.ClockId;   // 随机 63 位，最高位恒为 0

// 3) 需要时更新对端（设备可能有多个地址，例如 HomePod 的 IPv4/IPv6 多播组地址）
master.SetPeers(new[] { deviceAddress });

// 4) 任意时刻取 Unix 纪元纳秒墙钟（单调、线程安全），给 Ap2Sync 起播时间戳用
ulong nowNs = master.NowNs;
ulong nowNs2 = master.NowNanoseconds();   // 同义

// 5) 结束
master.Dispose();   // 幂等，关两个 socket 并 join 后台线程
```

### 成员一览

| 成员 | 说明 |
| --- | --- |
| `static Ap2PtpMaster? TryStart(IPAddress localAddress, IEnumerable<IPAddress> peers)` | 绑定 `localAddress:319`（事件口）和 `localAddress:320`（通用口），成功返回已启动的实例，失败返回 `null`。`localAddress` 为 `null` 抛 `ArgumentNullException`。 |
| `IPAddress BindAddress` | 实际绑定的本地地址。 |
| `ulong ClockId` | 本机 PTP 时钟标识（随机 63 位，非 0），同一实例生命周期内不变。 |
| `ulong NowNs` / `ulong NowNanoseconds()` | Unix 纪元纳秒（UTC），`Stopwatch` 平滑后单调递增。 |
| `IReadOnlyList<IPAddress> Peers` | 当前对端快照。 |
| `void SetPeers(IReadOnlyList<IPAddress>)` | 热更新对端列表；空列表 = 暂停对外发送。 |
| `ReceivedPackets` / `RejectedPackets` / `SentPackets` | 诊断计数（`Interlocked`，可跨线程读）。 |
| `SyncRounds` / `AnnounceSends` / `DelayRequests` / `PdelayRequests` | 分别统计 Sync 轮次、Announce 发出次数、应答的 Delay_Req、应答的 Pdelay_Req。 |
| `Dispose()` | 幂等。停线程 → 关两个 socket；之后端口可被重新 `TryStart`。 |
| 常量 | `EventPort=319`、`GeneralPort=320`、`SyncIntervalMilliseconds=125`、`AnnounceIntervalMilliseconds=1000`、`HeaderLength=34`、`TimestampOffset=34`、`TimestampLength=10`、`SyncLength=44`、`FollowUpLength=96`、`AnnounceLength=76`、`DelayResponseLength=54`。 |

### 行为要点

- **单后台线程**：一个线程同时负责定时发送和非阻塞收包（每轮 `Sleep(2ms)`），没有定时器/线程池抖动。
- **Sync + Follow_Up 成对**：每 125 ms 一轮，同一序号、同一时间戳。`Sync` 发到对端 `319`，
  `Follow_Up` 发到对端 `320`。调度采用绝对时钟累加（`next += 125ms`），明显滞后时重新对齐，
  不补发积压的轮次。
- **Announce**：每 1 s 每对端发一个（对端 `320`），与当轮 Sync 同序号。首个发送 tick 立刻发第一次。
- **Delay_Req（messageType 1）** → 回 `Delay_Resp`（type 9）到请求方，目标端口 **320**。
- **Pdelay_Req（messageType 2）** → 回 `Pdelay_Resp`（type 3）到请求方 **319**，并追加一个
  `Pdelay_Resp_Follow_Up`（type 10）到请求方 **320**。
- 只处理**来源 IP 在 peers 列表里**、且 header 合法的包；其他一律丢弃并计入 `RejectedPackets`。
- 日志前缀统一 `[airplay] AP2 PTP`：启动/停止/peer 变化各一条；周期性 stats 每 10 s 一条；
  异常有节流，不会刷爆日志。端口不可用时是 `[airplay] AP2 PTP unavailable: <异常类型>: <消息>`。
- `Dispose` 后不再发送任何数据；已绑端口释放，可以再次 `TryStart`。

## 报文格式

所有数值**大端**。公共头 34 字节：

| 偏移 | 长度 | 字段 | 本实现取值 |
| --- | --- | --- | --- |
| 0 | 1 | `messageType` | 低 4 位是类型，高 4 位 `0x1` = PTPv2 transportSpecific；见下表 |
| 1 | 1 | `versionPTP` | `0x02` |
| 2 | 2 | `messageLength` | 报文总长（含头），BE |
| 4 | 2 | 保留 | `0x0000` |
| 6 | 2 | `flags` | `0x0608`（event 报文）/ `0x0408`（general 报文） |
| 8 | 12 | 保留 | 全 0（对端源端口身份在包内不回填） |
| 20 | 8 | `clockIdentity` | `ClockId` |
| 28 | 2 | `sourcePortIdentity.portNumber` | `0x8005` |
| 30 | 2 | `sequenceId` | 每 tick +1；应答类消息回显请求序号 |
| 32 | 1 | 控制域 | `0x00` |
| 33 | 1 | `logMessageInterval` | `Sync`/`Follow_Up`/`Delay_Resp` = `-3`(`0xFD`)；`Announce` = `0x00` |

`logMessageInterval` 是有符号 8 位（`0xFD` = -3 = 2⁻³ s = 125 ms，`0x00` = 1 s）。

`timestamp`（共 10 字节）编码：前 6 字节是秒（BE，取 u64 的低 6 字节），后 4 字节是纳秒（BE）。
例如 Unix 1.234567890 s → `00 00 00 00 00 01 | 0D FB 38 D2`。

### 带类型的公共头字节（首字节）

| 报文 | messageType | 首字节 | 端口 | 长度 |
| --- | --- | --- | --- | --- |
| Sync | 0 | `0x10` | event(319) | 44 |
| Delay_Req | 1 | `0x11` | event(319) | 44 |
| Pdelay_Req | 2 | `0x12` | event(319) | 54 |
| Pdelay_Resp | 3 | `0x13` | event(319) | 54 |
| Follow_Up | 8 | `0x18` | general(320) | 96 |
| Delay_Resp | 9 | `0x19` | general(320) | 54 |
| Pdelay_Resp_Follow_Up | 10 | `0x1A` | general(320) | 54 |
| Announce | 11 | `0x1B` | general(320) | 76 |

### 参考报文（固定参数：ClockId=`0x1234567812345678`、序号=`0xFFFF`、时间戳=Unix 1.234567890 s）

`--dump` 输出，16 字节一行：

**Sync（44 字节）**
```
00: 10 02 00 2c 00 00 06 08 00 00 00 00 00 00 00 00
16: 00 00 00 00 12 34 56 78 12 34 56 78 80 05 ff ff
32: 00 fd 00 00 00 00 00 01 0d fb 38 d2
```
- `44 = 0x2C`；`flags=0x0608`；`logInterval=-3`；时间戳在 `34..44`。

**Follow_Up（96 字节）**
```
00: 18 02 00 60 00 00 04 08 00 00 00 00 00 00 00 00
16: 00 00 00 00 12 34 56 78 12 34 56 78 80 05 ff ff
32: 00 fd 00 00 00 00 00 01 0d fb 38 d2 00 03 00 1c
48: 00 80 c2 00 00 01 00 00 00 00 00 00 00 00 00 00
64: 00 00 00 00 00 00 00 00 00 00 00 00 00 03 00 10
80: 00 0d 93 00 00 04 12 34 56 78 12 34 56 78 00 00
```
时间戳在 `34..44`，随后两个 organization extension TLV：

1. `44..76`（28 字节 body）：`00 03 | 00 1C`（TLV type 3、长度 28），body 前 6 字节
   `00 80 C2 00 00 01` = IEEE 802.1 organizationId + subType 1（802.1AS follow-up info / rate ratio），
   其余 22 字节为 0 → 速率比 1.0（本机与设备同频，不需要调整播放速率）。
2. `76..96`（16 字节 body）：`00 03 | 00 10`（type 3、长度 16），body 前 6 字节
   `00 0D 93 00 00 04` = Apple organizationId（00-0D-93）+ subType 4（clock identity），
   **`86..94` 是主时钟的 `ClockId`**（`12 34 56 78 12 34 56 78`），`94..96` 为 0。
   AirPlay 2 的接收端靠这个 TLV 认出「谁是我的 PTP 主时钟」，必须正确。

**Announce（76 字节）**
```
00: 1b 02 00 4c 00 00 04 08 00 00 00 00 00 00 00 00
16: 00 00 00 00 12 34 56 78 12 34 56 78 80 05 ff ff
32: 00 00 00 00 00 00 00 01 0d fb 38 d2 00 00 00 60
48: f8 fe ff ff 80 12 34 56 78 12 34 56 78 00 00 a0
64: 00 08 00 08 12 34 56 78 12 34 56 78
```
- `34..44` 时间戳；`44..46` `currentUtcOffset=0`；`46..47` 保留 0；
  `47` `priority1=96`；`48` `clockClass=248`；`49` `clockAccuracy=0xFE`（未知）；
  `50..52` `offsetScaledLogVariance=0xFFFF`；`52` `priority2=128`；
  `53..61` `grandmasterIdentity=ClockId`；`61..63` `stepsRemoved=0`；
  `63` `timeSource=0xA0`（内部振荡器）；
  `64..76` path-trace TLV：`00 08 | 00 08` + 8 字节 `ClockId`。

**Delay_Resp（54 字节）**
```
00: 19 02 00 36 00 00 04 08 00 00 00 00 00 00 00 00
16: 00 00 00 00 12 34 56 78 12 34 56 78 80 05 43 21
32: 00 fd 00 00 00 00 00 01 0d fb 38 d2 01 23 45 67
48: 89 ab cd ef 00 01
```
- `30..32` 回显请求的 `sequenceId`（这里是 `0x4321`）；
- `34..44` 是本机**收包时刻**；
- `44..54` 回显请求方 `sourcePortIdentity`（请求报文 header 的 `20..30`，即 `0x0123456789ABCDEF` +
  `0x0001`）。注意：这是照抄 AirFlash 参考实现的写法（标准 1588 的 `requestingPortIdentity`
  本应位于消息体里），AirPlay 2 设备按这个格式认，因此保持一致。

**Pdelay_Resp（54 字节）**
```
00: 13 02 00 36 00 00 06 08 00 00 00 00 00 00 00 00
16: 00 00 00 00 12 34 56 78 12 34 56 78 80 05 77 88
32: 00 fd 00 00 00 00 00 01 0d fb 38 d2 11 22 33 44
48: 55 66 77 88 00 01
```
`flags=0x0608`（event 报文），发到请求方 `319`；时间戳与回显规则同 Delay_Resp。

**Pdelay_Resp_Follow_Up（54 字节）**
```
00: 1a 02 00 36 00 00 04 08 00 00 00 00 00 00 00 00
16: 00 00 00 00 12 34 56 78 12 34 56 78 80 05 77 88
32: 00 fd 00 00 00 00 00 01 0d fb 38 d2 11 22 33 44
48: 55 66 77 88 00 01
```
`flags=0x0408`（general 报文），发到请求方 `320`；序号与时间戳跟同一轮的 `Pdelay_Resp` 一致。

## 自测覆盖了什么

**报文字节级（纯内存，不碰网络）**：44/96/76/54 字节长度、首字节类型、版本、`messageLength` 字段、
保留字节、`flags`、`clockIdentity`、`sourcePortIdentity.port`、序号、`logMessageInterval`、时间戳
编码、Follow_Up 两个 TLV 的 type/长度/组织标识/子类型/速率比/ClockId 偏移（`86..94`）、Announce
各字段与 path-trace TLV、Delay_Resp/Pdelay 响应的序号回显与 `requestingPortIdentity` 回显、
`TryReadHeader` 的 5 种接受/拒绝场景。

**真实 UDP 链路（master `127.0.0.1` → 接收端 `127.0.0.5`）**：

- `Sync` 只到 `319`、`Follow_Up`/`Announce` 只到 `320`；大小与关键字段全部正确；
- 8 次/秒 ≈ 125 ms 节奏（平均间隔 125 ms ± 20 ms），序号逐 tick +1，时间戳与主机时钟 ±5 s；
- `Follow_Up` 确实带两个 TLV；`Announce` 每对端每秒一个且以 `ClockId` 作为 grandmaster；
- `Delay_Req` → `Delay_Resp`（320）；`Pdelay_Req` → `Pdelay_Resp`（319）+ `Pdelay_Resp_Follow_Up`（320），
  序号/身份回显正确，`DelayRequests`/`PdelayRequests`/`ReceivedPackets` 计数增加；
- `SetPeers([])` 后完全静默，恢复 peers 后继续发；`Dispose` 幂等、之后不再有包、端口可重新 `TryStart`；
- 绑不可用地址（`203.0.113.1`）返回 `null`；`TryStart(null)` 抛 `ArgumentNullException`；
- `ClockId` 非 0 且 `< 2^63`；`NowNs` 是 Unix 纳秒（与主机时钟差 < 5 s）且单调。

## 集成注意事项（给调用方）

0. **本类已经接进主工程**：`src/Zilux2/AirPlay/Ap2/Ap2Connection.cs` 通过 `Ap2PtpLink`（延迟绑定桥接）
   使用本类，接口是 `IAp2PtpMaster { ulong ClockId; ulong NowNs; void SetPeers(IReadOnlyList<string>) }`；
   桥接层按名字反射 `Zilux2.AirPlay.Ap2.Ap2PtpMaster`，并用
   `TryStart(IPAddress, IEnumerable<IPAddress>)`、`ClockId`/`NowNs` 属性、`SetPeers(IReadOnlyList<IPAddress>)`
   逐一匹配——这些签名与本类一致，不需要再写适配器。主工程 `dotnet build` 已验证 0 警告 0 错误。

1. **谁来启动**：由 AirPlay 2 会话层在 SETUP 前创建（每设备一个实例；若同一台设备要连多个对端，
   用 `SetPeers` 更新对端列表，不要建多个实例抢 319/320 端口）。失败时 `TryStart` 返回 `null`，
   要不要继续建会话由调用方决定（AirPlay 2 设备通常必须有 PTP 才出声，建议直接失败）。
   **`SetPeers` 只传设备地址，不要把本机地址加进去**：参考实现（AirFlash `session.rs:524` 的
   `let peers = options.peers.map(|p| p.host)`）喂给 PTP master 的就是对端地址；本机地址只出现在
   RTSP `SETPEERS` 请求体里（`session.rs:326-336` 的 `peers + local`）。把本机地址也交给本类，
   master 会往自己的 319/320 发 Sync/Announce（不致命，但纯属自环噪声）。
2. **`ClockId` 必须进 SETUP 的 `timingPeerInfo`**：AirPlay 2 的 `plist` 里
   `timingPeerInfo = { ID: <uuid 字符串>, DeviceType: 0, ClockID: <数值>, SupportsClockPortMatchingOverride: false, Addresses: [<本机 IP 字符串>] }`，
   并且通常还要把同一字典放进 `timingPeerList` 数组；`ClockID` 是**数字**，且用的就是本类的 `ClockId`，
   不能拿本机 IP 字符串顶替。
3. **SETUP 之后、起播之前**：参考实现还会通过事件通道给设备发 `SETPEERS`（body 是设备地址与本机地址
   的字符串数组），让设备知道把 PTP 事件发到哪；这一步属于设备会话层，不在本类职责内。
4. **时间基准**：`NowNs` 是 Unix 纪元纳秒；转成 NTP 时间戳（`Ap2Sync` 需要的高 32 位秒 + 低 32 位小数秒）
   时用 `ntp = ((nowNs / 1_000_000_000) << 32) | ((nowNs % 1_000_000_000) << 32) / 1_000_000_000`。
   设备的播放时间 = 该 NTP 基准 + RTP 帧偏移；同步上之后设备才会出声。
5. **和现有 `PtpMaster.cs`（另一份实现）二选一**：本类与 `src/Zilux2/AirPlay/Ap2/PtpMaster.cs`
   是两套独立实现，不要同时启动（会抢同一个 319/320）。本类的目标是严格对齐 AirFlash 参考实现的
   字节格式与节奏；集成时建议只保留一套，避免两套都发 Sync 导致设备时钟抖动。
6. **许可证**：协议格式参考自 GPLv3 的 AirFlash（`native_airflash-engine_src_clock.rs`），
   本实现是按协议字段独立重写的 C# 代码，未复制其代码结构。
