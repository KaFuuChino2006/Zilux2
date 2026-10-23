# AirPlay/RAOP 实现者清单（Zilux2 专用）

> 配套文档：[`raop-flow.md`](./raop-flow.md)（完整协议规格）。本文只讲**怎么落地、先做什么、哪里会踩坑**。
> 证据统一引用 `research/airplay/tuneblade-decomp/` 下的反编译文件:行号；`trace.txt` 为真实抓包。

---

## 0. 一句话路线

**先做经典 RAOP（明文）把声音放出来，再做体验功能；AirPlay2/HAP（HomePod 必需）单独立项、不要基于 TuneBlade。**
理由：TuneBlade 的明文 RAOP 路径有真实 Apple TV 抓包证明可用（`trace.txt`），而它的 AirPlay2 只做了配对、没有 HAP 加密会话（全仓无 ChaCha20/Poly1305，`Tuneblade/DeviceVerificationHandler.cs:153-156` 直接 `return false`），HomePod 这条路在 TuneBlade 里根本走不通。

---

## 1. 最小可用子集（MVP：能出声）

按顺序做，每步都有明确的"过"标准。**全程只需要一个接收端做验证**，推荐先拿 shairport-sync（Linux/树莓派，`shairport-sync -v` 可打印收包）当靶子，再上 Apple TV 3 / mac。

| # | 步骤 | 要做的 | 过标准 | 证据 |
|---|---|---|---|---|
| 1 | mDNS 发现 | 浏览 `_raop._tcp`（IPv4，local），解析 `<ID>@<名字>`、SRV 端口、TXT | 能拿到 ip/port/`am`/`et`/`sf` | `Tuneblade/DeviceController.cs:485`、`AirplayDevice.cs:3230-3253`、`:540-551` |
| 2 | TCP 连接 | connect 到接收端 RTSP 端口，读超时 30s；记下本机 IP | TCP 通 | `AirplayDevice.cs:2690-2742` |
| 3 | 本地 UDP 端口 | 开 3 个 UDP：audio（6001+ 起找空）、control（6002+）、timing（6003+）；立刻挂上 receive | 三个端口能收包 | `AudioSource.cs:801-807` |
| 4 | OPTIONS | `OPTIONS *` + 4 个身份头 + CSeq | 收到 `200 OK`（401 说明要密码，先跳过） | `AirplayDevice.cs:1232-1280` |
| 5 | ANNOUNCE | SDP（ALAC/352 帧）；body 长度精确 | `200 OK` | `AirplayDevice.cs:1383-1426` |
| 6 | SETUP | `Transport: RTP/AVP/UDP;unicast;interleaved=0-1;mode=record;control_port=<本机>;timing_port=<本机>` | `200 OK`，解析出 `Session`/`server_port`/`control_port`/`timing_port` | `AirplayDevice.cs:1428-1523` |
| 7 | RECORD | `RTP-Info: seq=0;rtptime=<首包时间戳>` | `200 OK` | `AirplayDevice.cs:1525-1573` |
| 8 | 音量 | `SET_PARAMETER` `volume: -12.000000`（见坑 15） | `200 OK`，接收端音量变化 | `AirplayDevice.cs:1575-1604` |
| 9 | 采音→ALAC | WASAPI 抓 44100/16/2ch（不匹配先重采样），每 352 帧编码一包 | 本地能解回原音 | `AudioSource.cs:1533-1553`、`:73/69` |
| 10 | RTP 发包 | 12 字节头 + ALAC，`SendTo(audioSocket, buffer, offset=4, len=12+n, audioEndpoint)` | **听到声音** | `AudioSource.cs:1570-1586`、`:1021/1031` |
| 11 | Timing 应答 | 收 32 字节 TimingRequest → 回 32 字节 TimingResponse | 接收端不报 timing 错误 | `AudioSource.cs:1615-1668` |
| 12 | Sync 包 | 每 1 秒发 20 字节 Sync 到 control 端口 | 音画/多设备同步稳定、不断音 | `AudioSource.cs:881-934` |
| 13 | TEARDOWN | 断开时发，超时 2.5s | 设备正常回到空闲 | `AirplayDevice.cs:1744-1775` |

**MVP 可以先不做**：重传（会偶发爆音/断音）、FLUSH、DMAP/progress、DACP 封面、加密、配对、多设备。

### 1.1 RTP 包构造（C# 示意，非 TuneBlade 代码）

```csharp
// packet buffer: [0..4) 重传响应头占位 | [4..16) RTP 头 | [16..) ALAC 数据
void BuildPacket(byte[] buf, ushort seq, uint rtpTs, ReadOnlySpan<byte> alac, int n) {
    buf[4] = 0x80;                                   // V=2, P=0, X=0, CC=0
    buf[5] = 0x60;                                   // M=0, PT=96 (AppleLossless)
    BinaryPrimitives.WriteUInt16BigEndian(buf.AsSpan(6), seq);
    BinaryPrimitives.WriteUInt32BigEndian(buf.AsSpan(8), rtpTs);
    BinaryPrimitives.WriteUInt32BigEndian(buf.AsSpan(12), 0x34249563); // 任意固定 SSRC
    alac.CopyTo(buf.AsSpan(16));
    // 发送：socket.SendTo(buf, 4, 12 + n, SocketFlags.None, audioEndpoint);
}
```

### 1.2 SDP（照抄数值即可）

```
v=0
o=iTunes <resourceId> 0 IN IP4 <接收端IP>
s=iTunes
c=IN IP4 <接收端IP>
t=0 0
m=audio 0 RTP/AVP 96
a=rtpmap:96 AppleLossless
a=fmtp:96 352 0 16 40 10 14 2 255 0 0 44100

```
（`<resourceId>` 任意数字串，如 `3121287335`；`Content-Length` 要等于 SDP 字节数，**包含**每行 CRLF 和最后那一个额外 CRLF——`AirplayDevice.cs:1387-1409`、`trace.txt:48`。）

### 1.3 RTSP 请求模板

```
{METHOD} {resource} RTSP/1.0
CSeq: {n}
User-Agent: Zilux2/0.1 (Windows)
Client-Instance: {16 位 hex，连接期间不变}
DACP-ID: {8 位 hex}
Active-Remote: {随机 u32}
{业务头，如 Content-Type/Transport/Session/RTP-Info}
[Authorization: Digest ...]
<CRLF>
[body]
```
`resource`：OPTIONS 用 `*`，其余 `rtsp://<本机IP>/<resourceId>`；POST 用 `/pair-setup-pin` 这类路径。响应读到 `\r\n\r\n` 为止（`AirplayDevice.cs:1799-1855`）。

---

## 2. 易踩坑清单（按踩到概率排序）

| # | 坑 | 正确做法 | 证据 |
|---|---|---|---|
| 1 | **ALAC 编码器**：TuneBlade 用自带原生 `AlacCodec.dll` P/Invoke，仓库里只有接口没有实现 | 必须找替代：FFmpeg `-f alac`、libavcodec、或自己实现 ALAC 编码（苹果开源 AppleLossless 解码器可反推）。**这是最大的工程风险，先验证再排期** | `AirTunesCommon/AlacCodec.cs`、`AudioSource.cs:790-794`、`:1553` |
| 2 | RTP 头字节序 | seq/timestamp/SSRC 全部**大端**；别用 `BitConverter`（TuneBlade 手翻字节，`RTPHeader.cs:58-67`） | `AirTunesCommon/RTPHeader.cs`、`AudioPacketMetadata.cs:22-29` |
| 3 | 音频包偏移搞错 | 缓冲区前 4 字节是为重传响应预留的，正常发送 `offset=4`、长度 `12+n`；重传响应才从 0 开始发 `len+4` | `AudioSource.cs:1021/1031`、`:1873/1894`、`:1670-1680` |
| 4 | `Content-Length` 算错 | 必须=**body 字节数**（ASCII/UTF-8 都行，但中文元数据要 UTF-8 且按字节数）；SDP 长度包含末尾 CRLF | `AirplayDevice.cs:1409`、`trace.txt:48` |
| 5 | CSeq/Session | CSeq 每请求 +1、从 0 开始；`Session` 原样回传收到的字符串（如 `"1"`，不要自己解析） | `AirplayDevice.cs:2736`、`:1465` |
| 6 | 接收端端口 | `server_port` 缺失 → audio 默认 **6000**；`control_port`/`timing_port` 缺失 → **null**（此时 Sync/重传改发 audio 端口，Timing 不做）；不要硬编码 6000/6001/6002 | `AirplayDevice.cs:1466-1492`、`AudioSource.cs:1871-1878` |
| 7 | 本地端口不一致 | SETUP 里报的 `control_port/timing_port` 必须是**已 bind 的那个 socket 的实际端口**；audio socket 端口不用报（接收端发去 server_port 对应 IP 的音频端口，但重传请求会打到你的 control 端口） | `AirplayDevice.cs:1437-1438` |
| 8 | RTP 时间戳基准 | 每包 `+= 352`，初值任意 u32；**不要**用墙钟逐包重算（会抖动）。TuneBlade 初值=进程毫秒×44.1 | `AudioSource.cs:850-853`、`:1535` |
| 9 | seq 回绕 | u16 自然回绕；重传窗口比较要做回绕安全（`(short)(a-b)` 或 TuneBlade 的 `compareSeqNumbers` 逻辑） | `AudioSource.cs:1692-1710` |
| 10 | 发送节奏 | 不要按固定 7.98ms 定时器"均匀"发；按采集到达驱动、允许突发（接收端按 `Audio-Latency` 缓冲）。TuneBlade 追平后 `WaitOne(500)` 等下一包 | `AudioSource.cs:936-1051` |
| 11 | Timing 包长度/偏移 | 固定 32 字节，offset 4-7 是保留 0，时间字段在 8/16/24；别写成 36 或 28 | `AirTunesCommon/TimingPacket.cs:39-59`、`AudioSource.cs:1651-1662` |
| 12 | Sync 包 | 20 字节：`PT=84`、`seq=7`（常量）、`rtpTime@4`、`ntpTime@8`、`rtpNext@16`；每 1 秒；发 control 端口 | `AirTunesCommon/SyncPacket.cs`、`AudioSource.cs:899-933` |
| 13 | NTP 时间基准 | TuneBlade 用"进程运行秒+2208988800"的假墙钟（`NTPClockHost.cs:11-25`）——它可行但**不推荐**；新实现用真实 UTC 秒+2208988800，fraction 用 2^32 换算（TuneBlade 读的时候用 2^32-1，误差可忽略） | `AirTunesCommon/NTPClockHost.cs`、`NTPTime.cs:14-16` |
| 14 | 重传响应格式 | 请求 8 字节（`0x80 0x55`+起始 seq BE+个数 BE）；响应 = 4 字节头（`0x80 0x56` + `u16 BE = ceil(包长/4)`）+ 原音频包（含 12B RTP 头），发到 control 端口 | `AirTunesCommon/ResendPacket.cs`、`AudioSource.cs:1670-1680`、`:1849-1909` |
| 15 | 音量 dB 换算 | 不是 0..1 线性：`0% → -144`、`100% → -0.001`、其余 `-30×(100-x)/100`；发 `volume: <N6 格式>`，必须 invariant culture；静音=发 -144 | `AirplayDevice.cs:3106-3117`、`:1581`、`:153` |
| 16 | 每设备独立会话 | 每台设备**各自**一条 RTSP TCP、各自 Session/端口；但**共享**同一个音频时钟（同一 seq/rtptime 广播给所有设备，这样多设备才同步） | `AudioSource.cs:1007-1041` |
| 17 | 线程模型 | 至少 4 类线程：捕获+编码（高优先）、发送（按 seq 追发）、control 收（重传请求）、timing 收（ping-pong 应答）；再加 1s sync timer。不要用一个线程串行做 | `AudioSource.cs:814-824`、`:837` |
| 18 | 采样率不匹配 | WASAPI 默认 mix format 常是 48000/24bit；必须重采样到 44100/16/2ch（TuneBlade 用 DMO Resampler） | `AudioSource.cs:1469-1470`、`resampler` |
| 19 | 防火墙 | RECORD 成功但设备无声，先查本机防火墙挡了入站 UDP；TuneBlade 专门检测并弹"防火墙"提示 | `AirplayDevice.cs:2503-2519` |
| 20 | 设备的 `am`/`sf` 判断 | `am` 含 `APPLETV` → MaxLatency 小（154350）；`sf&0x200` → 需要 AirPlay2 配对；`et&1` → 需要加密（但 TuneBlade 的加密不可用） | `AirplayDevice.cs:2862-2875`、`:3065-3098`、`:3142-3160` |
| 21 | Apple TV 的 882 补偿 | Sync 包里 `rtpNext = now - 882`，是给 Apple TV 类接收端的固定补偿；照抄这个数 | `AudioSource.cs:913` |
| 22 | DACP 头缺失 | `DACP-ID`/`Active-Remote` 每个请求都要带（即使你不做 DACP 服务）；Apple TV 可能据此决定是否接受/显示元数据 | `AirplayDevice.cs:1254-1256` 等所有请求 |
| 23 | FLUSH 后没有 RECORD | TuneBlade 只发 FLUSH 然后内部状态切回 Streaming 继续发流（`AudioSource.cs:2637-2665`）。标准做法应 FLUSH→停发→RECORD（新 RTP-Info）再恢复；新实现建议按标准 | `AirplayDevice.cs:1685-1742` |
| 24 | 加密分支别抄 | TuneBlade 的 AES key/IV/`rsaaeskey` 是硬编码常量、`pk` 根本没用（`AudioSource.cs:760-775`、`Crypto.cs:19-32`）。要加密就按 `pk=` RSA-OAEP 自己生成 | 见 `raop-flow.md` §4 |
| 25 | 配对只做一半 | pair-setup-pin/pair-verify 之后 TuneBlade 仍发明文 RTSP；HomePod/新 Apple TV 需要 HAP 加密会话 → 不要试图用"配对了就能投" | `DeviceVerificationHandler.cs:95-156` |

---

## 3. 可选功能与代价

| 功能 | 做法 | 代价 | 证据 |
|---|---|---|---|
| 音量同步 | 已有 §1 步骤 8；注意节流（避免每帧 UI 变化都发 RTSP） | 小 | `AirplayDevice.cs:2169-2192` |
| 静音 | 发 `volume: -144.000000` | 极小 | `AirplayDevice.cs:153` |
| 歌曲名/艺术家 | `SET_PARAMETER` + DMAP `mlit{minm,asar,asal}`，`Content-Type: application/x-dmap-tagged`，带 `RTP-Info: rtptime=` 头 | 小 | `AirplayDevice.cs:1606-1652`（56 字节样本已解码，见 `raop-flow.md` §3.7） |
| 进度条 | `SET_PARAMETER text/parameters` `progress: start/current/end`（RTP 帧单位） | 小（TuneBlade 只发了同值占位） | `AirplayDevice.cs:1654-1683` |
| 封面 | 实现 DACP HTTP 服务（随机端口 + `_dacp._tcp` 发布 + `iTunes_Ctrl_<DACPID>`），处理 `GET /ctrl-int/1/...`，返回 JPEG；并把 `Active-Remote` 映射回设备 | **中-大**（TuneBlade 只做了 204 响应骨架） | `DACPServer.cs:53-210`、`AirplayDevice.cs:861` |
| 暂停/恢复 | 标准：FLUSH → 停发流 → 恢复时 RECORD（新 RTP-Info）。TuneBlade 只 FLUSH + 状态切换 | 中 | `AirplayDevice.cs:1685-1715`、`AudioSource.cs:2637-2665` |
| 多设备同步 | 共享 seq/rtptime 广播给所有设备即可（TuneBlade 已是这样） | 已内建 | `AudioSource.cs:1007-1041` |
| 断线重连 | 3 秒延迟后重连；RECORD 失败且收不到 UDP 时判防火墙 | 小 | `AirplayDevice.cs:2650-2688`、`:2503-2519` |
| Standby/节能 | TEARDOWN + 关 TCP，保留设备条目；Resume 重走 connect | 小 | `AirplayDevice.cs:3438-3510` |

---

## 4. 推荐落地顺序（含验证手段）

1. **P0（0.5 天）**：mDNS + RTSP 五连（OPTIONS/ANNOUNCE/SETUP/RECORD/TEARDOWN）跑通——用 shairport-sync 或 Apple TV 3 看 `200 OK`。先不发声。
2. **P1（1-2 天）**：ALAC 编码器选型验证（FFmpeg/libavcodec/自实现），能生成 352 帧包；再用自写 `RTP` 发到 shairport-sync 听到声音。
3. **P2（1 天）**：Timing 应答 + 1s Sync + 音量，解决"能出声但断音/爆音"（补重传）。
4. **P3（2-3 天）**：稳定性（缓冲/FLUSH/重连/多设备/防火墙提示）、DMAP+progress。
5. **P4（独立项目）**：AirPlay2/HAP（HomePod、新 Apple TV）——见下。

验证工具建议：`shairport-sync -vv`（看 RTSP 与 RTP 收包）、Wireshark（`rtsp`/`rtp` 解析）、`avahi-browse -rt _raop._tcp`（对照 TXT）。

---

## 5. 「先做哪条路径最容易让 HomePod / mac 出声」

**结论：先做 mac（和 Apple TV 3 / AirPort / shairport-sync）的经典 RAOP 明文路径；HomePod 不要指望 RAOP，必须另做 AirPlay2/HAP，工作量约是前者的 3-5 倍。**

依据：

1. **mac（macOS Monterey+ 的"隔空播放接收器"）**：仍然兼容 AirPlay 1 客户端（RAOP 明文），只要在系统设置里打开"隔空播放接收器"、且不强制"仅允许 AirPlay 2 设备"。用本文 §1 的 MVP 就能出声。**这是最快能看到效果的目标，建议第一优先。**
2. **Apple TV 3 / AirPort Express / shairport-sync**：标准 RAOP，同 MVP。Apple TV 3 有 `trace.txt` 的真实成功记录（`et=0,3,5`、`sf=0x4`、明文）。
3. **HomePod / HomePod mini / Apple TV 4K（新 tvOS）**：
   - 它们广告 `_airplay._tcp` + `features` 位，要求 **AirPlay2 配对 + HAP 加密会话 + ChaCha20-Poly1305 音频**；
   - TuneBlade 只实现了配对的前半段（SRP + X25519/Ed25519），配对后仍发明文 RTSP 和固定 key 的 AES 音频 → HomePod 直接静音/拒绝；
   - 要做只有一条路：按 HAP 规范补 `pair-setup-pin`（SRP-6a RFC5054 2048/SHA1）→ `pair-verify`（X25519+Ed25519+HAP 会话密钥）→ 之后所有 RTSP 走加密 HAP 帧、音频 RTP 载荷 ChaCha20-Poly1305（nonce=帧计数器，AAD 含 RTP 头）；SETUP/RECORD 用 plist（`streams`/`timing_port` 结构）。
   - 建议直接对齐开源实现（shairport-sync 的 `airplay2` 分支、pyatv 的 HAP 实现），**不要**从 TuneBlade 反推这一层——它没有。

---

## 6. 关键数值速查（实现时贴在屏幕上）

```
采样率 44100 / 16bit / 2ch（PCM）
每包 352 帧 = 1408 字节 PCM → ALAC ≤1428 → RTP 包 ≤1440
每包 RTP timestamp +352；每秒约 125.28 包
RTP: buf[4]=0x80, buf[5]=0x60, seq BE@6, ts BE@8, SSRC BE@12（任意固定，如 0x34249563）
本地端口：audio 6001+ / control 6002+ / timing 6003+（各找空 500 个）
接收端 audio：SETUP Transport server_port，缺省 6000
Sync 包：20B，PT=84，seq=7，rtpTime@4，ntpTime@8，rtpNext@16，每 1s
Timing 包：32B，offset 4-7 保留 0，ref@8，recv@16，send@24；请求 PT=82，响应 PT=83
重传请求：8B 0x80 0x55 + seq BE@2 + count BE@4；响应：4B 0x80 0x56 + u16(ceil(len/4)) + 原包
音量：0%→-144，100%→-0.001，中间 -30*(100-x)/100，格式 N6
保活：OPTIONS 每 15s；Sync 每 1s
默认 Audio-Latency 兜底：8500 采样（≈193ms）；MaxLatency AppleTV=154350，其他=2205000
```
