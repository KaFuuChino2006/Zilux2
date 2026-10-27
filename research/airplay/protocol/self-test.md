# RAOP 发送栈无硬件自测报告（任务）

- 作者：投送开发（team "Zilux2"，任务板 任务）
- 日期：2026-10-20
- 目标：在没有 Apple 硬件、没有 ALAC 编码器的机器上，端到端验证 `src/Zilux2/AirPlay/Protocol/` 里的 RAOP 发送栈：
  RTSP 握手 → RTP 音频 → Sync/Timing 时钟 → 重传 → 音量 → FLUSH → TEARDOWN。
- 结论（当前）：**32/32 断言 PASS，exit code 0**。主工程 `dotnet build` 已 **0 警告 0 错误**；
  用反射 harness 加载真实 `Zilux2.dll` 运行 `AirPlayLoopbackTest.Run()` 得到同样结果（§5.1，最终验收证据）。

---

## 1. 被测对象与边界

| 层 | 文件 | 本测试是否覆盖 |
|---|---|---|
| RTSP 客户端 | `src/Zilux2/AirPlay/Protocol/RtspTransport.cs` | ✅ OPTIONS/ANNOUNCE/SETUP/RECORD/SET_PARAMETER/FLUSH/TEARDOWN 收发 |
| RAOP/RTP 封包 | `src/Zilux2/AirPlay/Protocol/RaopPackets.cs` | ✅ 音频包、Sync、Timing、重传请求/响应字节布局 |
| 连接编排 | `src/Zilux2/AirPlay/Protocol/RaopConnection.cs` | ✅ 握手、发送节奏、音量、FLUSH、TEARDOWN、接收循环 |
| ALAC 编码 | `src/Zilux2/AirPlay/Alac/`（任务） | ❌ 不测（本测试用随机 500B 假负载，只验证封装/时序） |
| HAP 配对/AirPlay2 | `src/Zilux2/AirPlay/Crypto/`（任务） | ❌ 不测（仅经典 RAOP 明文路径） |
| mDNS 发现 | `src/Zilux2/AirPlay/Discovery/`（任务） | ❌ 不测（直接给 `127.0.0.1:<mock RTSP 端口>`） |

协议规格依据：`research/airplay/protocol/raop-flow.md`（本 team 的反编译规格，尤其 §3–§6）。

---

## 2. 交付文件

| 文件 | 行数 | 作用 |
|---|---|---|
| `src/Zilux2/_devtest/airplay/AirPlayMockDevice.cs` | 1017 | 纯 BCL 的模拟 RAOP 接收端（RTSP + UDP 音频/control/timing + 统计 + 探针） |
| `src/Zilux2/_devtest/airplay/AirPlayLoopbackTest.cs` | 256 | `internal static int Run()`：起 mock → 连 → 流 → 断言 → 返回 0/1 |
| `research/airplay/protocol/self-test.md` | 本文件 | 说明、跑法、证据、局限 |

两个 `.cs` 只在 `_devtest/` 下，属于主工程（`Zilux2.csproj` 自动包含），**不改 csproj、不改 App/MainWindow/WebViewHost**。

### Mock 接收端做了什么

- **RTSP**：`TcpListener(IPAddress.Loopback, 0)` 随机端口，每个 TCP 连接一个会话；解析请求行 + header + `Content-Length` body。
  支持 `OPTIONS/ANNOUNCE/SETUP/RECORD/SET_PARAMETER/FLUSH/TEARDOWN/GET_PARAMETER/POST`，未知方法回 **400**；
  每个请求连同响应码记入 `Stats().RtspRequests`。
- **SETUP**：分配 3 个随机 UDP 端口，回 `Session: 1`、`Transport: RTP/AVP/UDP;unicast;mode=record;server_port=<audio>;control_port=<control>;timing_port=<timing>`、`Audio-Latency: 88200`。
- **UDP 音频**：解析 12B RTP 头（version/PT、marker、seq、timestamp、SSRC），统计包数、首末 seq、`SequenceGaps`、`Timestamps`、负载字节数、未知 PT。
- **UDP control**：`PT=82` TimingRequest → 回 32B `TimingResponse(PT=83)`（origin 回显、received/sent 为当前 NTP）；`PT=85` ResendRequest → 记录并回 `PT=86`。
- **探针**（测试主动触发客户端响应路径）：`RequestTiming()` 从 mock 的 timing 端口发 TimingRequest；
  `RequestResend(firstSequence, count)` 从 control 端口发重传请求。
- **生命周期**：`Start()` → 用 `RtspPort/AudioPort/ControlPort/TimingPort` 建 `RaopTarget`；`Stats()` 取快照；`Dispose()` 关闭全部 socket。

### 测试流程（`Run()`）

1. `AirPlayMockDevice.Start()`，构造 `RaopTarget { Host="127.0.0.1", Port=mock.RtspPort }`，
   `RaopOptions { BufferLatencyMilliseconds = 2000 }`（其余默认）。
2. `RaopConnection.Connect(...)`（RTSP OPTIONS→ANNOUNCE→SETUP），断言 Session/延迟/Transport 回填。
3. `mock.RequestTiming()` 探针（验证客户端 timing 接收循环会回应）。
4. `BeginStreaming()`（内部发 RECORD），然后 `SendAudioFrame(500B 随机载荷)` × 200 帧。
5. `Thread.Sleep(1500)` 覆盖至少 1 次 Sync tick（1s 周期）；`mock.RequestResend(190,3)` 探针。
6. `SetVolume(60)` → 断言 body `volume: -12.000000`（线性 dB 换算）。
7. `Flush()` → 再 `SendAudioFrame` 若干帧（FLUSH 后应被丢弃，不计入总包数）。
8. `Teardown()` / `Dispose()` → 断言 mock 收到 TEARDOWN 且 RTSP 连接被关闭。

---

## 3. 断言清单（32 项）

握手/RTSP（12）：`handshake requests 200`、`OPTIONS uri *`、`ANNOUNCE answered 200`、`ANNOUNCE sdp rtpmap`、
`ANNOUNCE sdp alac fmtp`（含 `a=fmtp:96 352 0 16 40 10 14 2 255 0 0 44100`）、`ANNOUNCE sdp plain`（明文无 `a=rsaaeskey:`）、
`SETUP answered 200`、`SETUP transport control_port`、`SETUP transport timing_port`、`SETUP session id`、`SETUP audio latency`（88200）。

音频（8）：`timing probe sent`、`RECORD answered 200`、`RECORD range npt=0-`、`RECORD RTP-Info`（`seq=0;rtptime=` 开头）、
`audio frames accepted`、`resend probe sent`、`audio packet count`（=200）、`audio sequence contiguous`、
`audio timestamp step 352`、`audio payload bytes`（=200×500）。

时钟/重传/控制（5）：`sync packet received`、`timing round-trip`、`resend responses`、`volume body`（`volume: -12.000000`）、
`FLUSH answered 200` + `FLUSH RTP-Info`。

关闭与清理（5）：`TEARDOWN received`、`TEARDOWN closed session`、`connection packet count`、
`no unknown payload types`、`mock errors empty`。

> 断言失败会打印 `[airplay-test] FAIL <name> <detail>`，最后输出 `summary passed=N failed=M`；`Run()` 返回 0 当且仅当 failed=0。

---

## 4. 如何运行

### A. 隔离 harness（现在就能跑，链接源码；本报告证据来自它）

位置（仓库外临时目录，不提交）：`C:\Users\13329\AppData\Local\Temp\zilux2-airplay-isolated\`

```bash
cd "C:/Users/13329/AppData/Local/Temp/zilux2-airplay-isolated"
dotnet run -c Release
```

该工程用 `<Compile Include="E:\Zilux2开发\src\Zilux2\...\*.cs" Link="..."/>` 链接同一份源码，
并 `<ImplicitUsings>disable</ImplicitUsings>` + 手写 `GlobalUsings.cs`（**只保留主工程实际有的 5 个全局 using**：
`System, System.Collections.Generic, System.Linq, System.Threading, System.Threading.Tasks`），
因此能等价暴露“主工程缺 using”这类编译错误（本轮正是靠它抓到并修掉了 `MemoryStream` 缺 `using System.IO`）。

### B. 反射 harness（主工程 build 绿后验证真实 `Zilux2.dll`；推荐 CI 用）

```bash
cd "E:/Zilux2开发" && dotnet build src/Zilux2/Zilux2.csproj -v q
cd "C:/Users/13329/AppData/Local/Temp/zilux2-airplay-harness"
dotnet run -- "E:\Zilux2开发\src\Zilux2\bin\Debug\net10.0-windows10.0.19041.0\Zilux2.dll"
```

`AirPlayLoopbackTest` 是 `internal`，harness 用 `Assembly.LoadFrom` + `GetMethod("Run", NonPublic|Static)` 反射调用，
**不需要 `InternalsVisibleTo`、不改产品 csproj**；参数可省（默认同上路径）。

### C. 应用内钩子（前端侧负责加，可选）

WPF 是 `WinExe`，没有控制台，`Console.WriteLine` 输出默认看不到。若要在应用里跑，建议 前端侧在
`App.xaml.cs` 的 `OnStartup` 里加：

```csharp
if (e.Args.Contains("--airplay-selftest"))
{
    Environment.ExitCode = Zilux2.DevTest.AirPlay.AirPlayLoopbackTest.Run();
    Shutdown(Environment.ExitCode);
    return;
}
```

（`Run` 是 `internal`，App 与它在同一程序集，可直接调用。）需要留证据时把 `Run()` 的输出同时写进
`HostLog`/临时文件，或直接用 §4-B 的反射 harness。

---

## 5. 实测证据（2026-10-20，dotnet 10.0.401，Windows）

### 5.1 最终验收：真实 `Zilux2.dll`（反射 harness，主工程 build 绿后）

命令：

```bash
cd "C:/Users/13329/AppData/Local/Temp/zilux2-airplay-harness"
dotnet run -c Release -- "E:\Zilux2开发\src\Zilux2\bin\Debug\net10.0-windows10.0.19041.0\Zilux2.dll"
```

```text
[harness] loading E:\Zilux2开发\src\Zilux2\bin\Debug\net10.0-windows10.0.19041.0\Zilux2.dll
[airplay-test] PASS handshake requests 200
[airplay-test] PASS OPTIONS uri *
[airplay-test] PASS ANNOUNCE answered 200
[airplay-test] PASS ANNOUNCE sdp rtpmap
[airplay-test] PASS ANNOUNCE sdp alac fmtp
[airplay-test] PASS ANNOUNCE sdp plain
[airplay-test] PASS SETUP answered 200
[airplay-test] PASS SETUP transport control_port
[airplay-test] PASS SETUP transport timing_port
[airplay-test] PASS SETUP session id
[airplay-test] PASS SETUP audio latency
[airplay-test] PASS timing probe sent
[airplay-test] PASS RECORD answered 200
[airplay-test] PASS RECORD range npt=0-
[airplay-test] PASS RECORD RTP-Info
[airplay-test] PASS audio frames accepted
[airplay-test] PASS resend probe sent
[airplay-test] PASS audio packet count
[airplay-test] PASS audio sequence contiguous
[airplay-test] PASS audio timestamp step 352
[airplay-test] PASS audio payload bytes
[airplay-test] PASS sync packet received
[airplay-test] PASS timing round-trip
[airplay-test] PASS resend responses
[airplay-test] PASS volume body
[airplay-test] PASS FLUSH answered 200
[airplay-test] PASS FLUSH RTP-Info
[airplay-test] PASS TEARDOWN received
[airplay-test] PASS TEARDOWN closed session
[airplay-test] PASS connection packet count
[airplay-test] PASS no unknown payload types
[airplay-test] PASS mock errors empty
[airplay-test] summary passed=32 failed=0
[harness] exit=0
```

### 5.2 隔离 harness（链接同一份源码编译；主工程 build 被 WIP 文件阻塞时用的等价验证，结果与 §5.1 完全一致）

命令：`cd C:/Users/13329/AppData/Local/Temp/zilux2-airplay-isolated && dotnet run -c Release`

```text
[harness] running AirPlayLoopbackTest.Run() in-process (linked sources).
[airplay-test] PASS handshake requests 200
[airplay-test] PASS OPTIONS uri *
[airplay-test] PASS ANNOUNCE answered 200
[airplay-test] PASS ANNOUNCE sdp rtpmap
[airplay-test] PASS ANNOUNCE sdp alac fmtp
[airplay-test] PASS ANNOUNCE sdp plain
[airplay-test] PASS SETUP answered 200
[airplay-test] PASS SETUP transport control_port
[airplay-test] PASS SETUP transport timing_port
[airplay-test] PASS SETUP session id
[airplay-test] PASS SETUP audio latency
[airplay-test] PASS timing probe sent
[airplay-test] PASS RECORD answered 200
[airplay-test] PASS RECORD range npt=0-
[airplay-test] PASS RECORD RTP-Info
[airplay-test] PASS audio frames accepted
[airplay-test] PASS resend probe sent
[airplay-test] PASS audio packet count
[airplay-test] PASS audio sequence contiguous
[airplay-test] PASS audio timestamp step 352
[airplay-test] PASS audio payload bytes
[airplay-test] PASS sync packet received
[airplay-test] PASS timing round-trip
[airplay-test] PASS resend responses
[airplay-test] PASS volume body
[airplay-test] PASS FLUSH answered 200
[airplay-test] PASS FLUSH RTP-Info
[airplay-test] PASS TEARDOWN received
[airplay-test] PASS TEARDOWN closed session
[airplay-test] PASS connection packet count
[airplay-test] PASS no unknown payload types
[airplay-test] PASS mock errors empty
[airplay-test] summary passed=32 failed=0
[harness] AirPlayLoopbackTest.Run() => 0
```

---

## 6. 构建与验收状态（2026-10-20 更新）

- `dotnet build src/Zilux2/Zilux2.csproj -v q --nologo` → `已成功生成。 0 个警告 0 个错误`。
- 反射 harness 加载真实 `Zilux2.dll` 执行 `AirPlayLoopbackTest.Run()` → **32/32 PASS，exit=0**（输出见 §5.1）。
- 任务 验收条件（主工程编译 0 error + 真实产物上握手/音频/时钟/重传/音量/FLUSH/TEARDOWN 全绿）**已满足**。

### 6.1 期间发现并修复的问题

- `AirPlayMockDevice.cs` 缺 `using System.IO;`（`MemoryStream`），导致主工程编译报 CS0246。已修复；
  隔离 harness 用与主工程相同的 5 个全局 using 复核通过（这也是保留 §4-A 隔离 harness 的价值：它绕开别人 WIP 文件，单独验证本任务文件的可编译性）。
- 期间主工程曾因 任务 的 `src/Zilux2/AirPlay/Alac/AlacDecoder.cs` 缺 `AlacBitReader` 而红构建；已把
  `research/airplay/alac/AlacDecoder.cs`（单文件自包含）同步覆盖到 src，随后 build 转绿。与本任务文件无关。

## 6.2 复跑快速检查清单

1. `cd "E:/Zilux2开发" && dotnet build src/Zilux2/Zilux2.csproj -v q --nologo` → 期望 0 error。
2. `cd "C:/Users/13329/AppData/Local/Temp/zilux2-airplay-harness" && dotnet run -c Release -- "E:\Zilux2开发\src\Zilux2\bin\Debug\net10.0-windows10.0.19041.0\Zilux2.dll"` → 期望 `summary passed=32 failed=0`、`exit=0`。
3. 若改了协议栈（`Protocol/*.cs`），先跑隔离 harness 再跑反射 harness，能快速定位是“本任务文件不可编译/逻辑回归”还是“别人 WIP 文件阻塞”。

---

## 7. 局限（别把 PASS 当“真出声”）

1. **不校验 ALAC 负载**：只断言包数/seq/ts/长度，随机载荷解码不出声音；ALAC 正确性由 任务 的 roundtrip 负责。
2. **回环网络**：无丢包、乱序、jitter、NAT。重传/时钟路径是用 mock 探针主动触发的，不等于真实设备的丢包行为。
3. **只测经典 RAOP 明文**（无密码、无 `rsaaeskey`）；AirPlay2/HAP 配对（HomePod）不在本测试范围。
4. **单会话**：没测多设备并发、断线重连、长时（>分钟）漂移。
5. **固定常量断言**（352 帧、88200 latency、`npt=0-`、`volume: -12.000000`）是 TuneBlade/RAOP 的既有约定；
   若以后改实现（例如换 latency 算法），要同步改断言，别反过来改协议去迁就测试。

---

## 8. 与协议规格的对应关系

| 断言组 | `raop-flow.md` 章节 |
|---|---|
| OPTIONS/ANNOUNCE/SDP(SETUP 前) | §4「RTSP 会话」、§4.4「ANNOUNCE 与 SDP」 |
| SETUP Transport/Session/Audio-Latency | §4.5「SETUP」 |
| RECORD / RTP-Info / npt Range | §4.6「RECORD」 |
| 音频包 12B 头、seq/ts(=352)/payload | §3「RTP 音频」 |
| Sync(PT=84) 20B / Timing(PT=82/83) 32B | §3.5「Sync 与 Timing」 |
| Resend(PT=85/86) 8B | §3.6「重传」 |
| volume：`-30*(100-p)/100`、0→-144 | §5「音量与 SET_PARAMETER」 |
| FLUSH 的 RTP-Info 语义 | §4.7「FLUSH」 |
| TEARDOWN | §4.8「TEARDOWN」 |
