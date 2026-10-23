# RAOP / AirPlay 1 协议规格（从 TuneBlade 1.30 反编译提取）

> 目的：给 Zilux2 用**全新代码**重新实现 AirPlay 投送的协议依据。本文只记录协议事实，不复制 TuneBlade 代码。
> 证据来源：`research/airplay/tuneblade-decomp/`（TuneBlade 1.30，.NET Framework 4.0，无混淆，ilspycmd 完整反编译）。
> 引用格式：`` `文件:行号` ``，均为**反编译输出中的真实行号**；`trace.txt` 是 TuneBlade 实际连接 Apple TV 时留下的真实抓包日志，用于交叉验证。
> 标注【规范】的段落是 ALAC/HAP/RAOP 通用规范知识（反编译代码里不解释语义，只体现数值），其余全部可从代码/日志直接验证。

---

## 0. 结论速览（先读这一段）

1. **TuneBlade 走的是经典 RAOP（AirPlay 1）路径**：mDNS 只浏览 `_raop._tcp`（`Tuneblade/DeviceController.cs:485`），RTSP over TCP 建立会话，音频走 ALAC + RTP/UDP。控制面（音量/进度/元数据/FLUSH/TEARDOWN）全部是 RTSP，音频面是 UDP。
2. **三组本地 UDP 端口固定角色**：audio = 6001 起、control = 6002 起、timing = 6003 起，各自在 500 个端口内找可用端口（`Tuneblade/AudioSource.cs:801-807`）。接收端的 audio/control/timing 端口由 SETUP 响应里的 `Transport` 头给出（`AirplayDevice.cs:1463-1501`）。
3. **RTSP 是手写字符串**，不走通用 RTSP 库；用 `\r\n\r\n` 判断响应结束（`AirplayDevice.cs:1799-1855`）。所有请求共 4 个身份头：`User-Agent` / `Client-Instance` / `DACP-ID` / `Active-Remote`。
4. **音频包结构**：`[RTP 头 12B][ALAC 数据]`；正常发送时用 `SendTo(buf, offset=4, len=payload+12)`——即缓冲区前 4 字节是重传响应专用头，正常流跳过它（`AudioSource.cs:1021/1031`，`1570-1586`）。
5. **ALAC 固定 352 帧/包**，对应 PCM `1408` 字节（352 × 2ch × 16bit/8）；RTP 时间戳每包 **+352**，初值是进程内毫秒计时换算的采样数（`AudioSource.cs:1533-1535`、`850-853`）。
6. **SSRC 固定 `874812771 (0x34249563)`**（`AudioSource.cs:1574`）。RTP 头 `marker=0`、payload type `96(0x60)`、version=2。
7. **加密分支默认关闭**：只有 mDNS TXT `et` 含 **1（RSA）** 才开（`AirplayDevice.cs:3241-3248`、`3142-3160`），且 AES key/IV/`rsaaeskey` 全是**硬编码常量**，`Crypto.GenerateAesKey()/RSAPublicEncrypt()` 在反编译代码里直接抛 `NotImplementedException`（`AirTunesCommon.Crypto/Crypto.cs:19-32`）。所以这条分支**不能照抄**，新实现必须按 TXT `pk=` 用 RSA-OAEP 加密随机 AES key。
8. **AirPlay2 配对只做了一半**：`sf` TXT 告知需要配对时，会走 pair-setup-pin + pair-verify（`Tuneblade/DeviceVerificationHandler.cs:95-151`），但配对完之后 **RTSP 仍是明文、音频仍是 AES-128-CBC（固定 key）**，全仓库搜不到 ChaCha20/Poly1305/LTSK/hap 任何字样 → **没有 HAP 加密会话**。这就是 HomePod / 新款 Apple TV 不能出声的根本原因（见 §9）。
9. **时钟是「进程内秒表 + NTP 纪元偏移」**，不是系统 NTP 时间：NTP 整数部分 = 进程运行秒数 + `2208988800`（`AirTunesCommon/NTPClockHost.cs:11-25`）。接收端只关心 RTP↔NTP 的相对关系，因此可接受这种实现。
10. 真实会话样本（`trace.txt`）证明：**Apple TV 3（`am=AppleTV3,1`、`vs=150.35`、`et=0,3,5`、`pw=false`）用明文 RAOP 即可出声**，SDP 不带 `rsaaeskey/aesiv`。

---

## 1. 总体时序

```
Sender(Zilux2)                                       Receiver(AirPort Express / Apple TV / mac)
   │  mDNS browse _raop._tcp (IPv4, local)                  │
   │◄──────────── SRV/TXT (port, ch, sr, ss, et, sf, am …) ─┤
   │  TCP connect ip:port                                   │
   │──── OPTIONS * ────────────────────────────────────────►│  (justPing=false 时若加密则带 Apple-Challenge)
   │◄─── 200 OK / 401 (WWW-Authenticate) / 453 / 503 ───────┤
   │──── ANNOUNCE rtsp://<senderIP>/<resId> + SDP ─────────►│
   │◄─── 200 OK                                             │
   │──── SETUP  (Transport: …control_port/timing_port) ────►│
   │◄─── 200 OK (Session, Transport: server_port/control_port/timing_port, Audio-Latency)
   │──── RECORD (Session, Range: npt=0-, RTP-Info) ────────►│
   │◄─── 200 OK (可选 Audio-Latency)                        │
   │──── SET_PARAMETER text/parameters "volume: x" ────────►│
   │◄─── 200 OK                                             │
   │──── SET_PARAMETER dmap (minm/asar/asal) + RTP-Info ──►│   刷新接收端"正在播放"信息
   │──── SET_PARAMETER text/parameters "progress: …" ──────►│
   │                                                         │
   │  == 音频面 ==                                            │
   │──── RTP/ALAC (UDP) ──────► receiver audio port 6000/server_port
   │──── Sync packet (UDP) ───► receiver control port          每 1s
   │◄─── Timing request (UDP) ─ receiver → 本机 timing port    需要时
   │──── Timing response (UDP)►
   │◄─── Resend request (UDP) ─ receiver → 本机 control port   丢包时
   │──── Resend response (UDP)►
   │                                                         │
   │──── FLUSH（缓冲管理/暂停时）                            │
   │──── TEARDOWN（断开/进 standby）                         │
```

### 1.1 本地端口与线程（实现时直接照这个骨架）

| 角色 | 本地端口 | 方向 | 代码 |
|---|---|---|---|
| audio | `AvailableUDPPort(6001, 500)` | → 接收端 audioEndpoint | `AudioSource.cs:801-802` |
| control | `AvailableUDPPort(6002, 500)` | ← 接收端重传请求；→ Sync/重传响应 | `AudioSource.cs:803-805` |
| timing | `AvailableUDPPort(6003, 500)` | ← 接收端 TimingRequest；→ TimingResponse | `AudioSource.cs:806-807` |
| RTSP | 由接收端 SRV 端口决定（手动设备可配） | TCP 双向 | `AirplayDevice.cs:2705-2709` |

线程模型（`AudioSource.cs:814-824`）：`PCM Processing Thread`（捕获→ALAC→入队，Highest）、`Audio Streaming Thread`（从队列取包→UDP 发送，Highest）、`Resend Thread`（重传队列）；另有 1s 一次的 `syncTimer`（`AudioSource.cs:837`）。

---

## 2. mDNS 发现

### 2.1 浏览与解析

- 只浏览 `_raop._tcp`，域 `local`，IPv4：`browser.Browse(0u, AddressProtocol.IPv4, "_raop._tcp", "local")`（`Tuneblade/DeviceController.cs:485`）。
  - **不浏览** `_airplay._tcp`、`_raop._tcp` 之外的任何服务做投送（DACP 是它自己发布的 `_dacp._tcp`，见 §8.5）。
- `ServiceAdded` → `ServiceFound`（`DeviceController.cs:752`）→ `new AirplayDevice(args.Service.Name)`（`DeviceController.cs:779`）；`device.ServiceType = args.Service.RegType`（`:782`）。
- **实例名格式**：`<MAC/ID>@<显示名>`，如 `56B6CB929BB20486@Living Room`。解析逻辑：`FullName.Split('@', 2)` → `[0]=UniqueID`、`[1]=Name`（`AirplayDevice.cs:540-551`）。
  - 名字里的 `@` 只切第一个；无 `@` 视为非法名（`:541-550`）。
- 解析地址：`BrowseService(FullName, Domain, ServiceType)`，7 秒超时（`AirplayDevice.cs:3280-3305`）；回调 `bonjour_ServiceResolved`：
  - `ipAddress = HostEntry.AddressList[0]`（取第一个 IPv4，`AirplayDevice.cs:3234`）
  - `port = (ushort)Service.Port`（`:3236`，RTSP 端口，典型 5000 或随机）
  - `TxtRecord` 存入 `deviceDetailsRecord` 并 `populateValuesFromTXTRecord`（`:3237-3239`）
  - `EncryptionNeeded = (selectedEncryption() != EncryptionTypes.None)`（`:3241-3248`）

### 2.2 TXT 记录（键 → TuneBlade 的解读）

真实样本（`trace.txt:5-22`，Apple TV）：

```
txtvers=1  ch=2  cn=0,1,2,3  da=true  et=0,3,5  ft=0x1A7FCA00  md=0,1,2
pw=false   pk=82a83b4b…      sv=false  sr=44100  ss=16  tp=UDP
vn=65537   vs=150.35         vv=1      am=AppleTV3,1  sf=0x4
```

| TXT 键 | 含义 | TuneBlade 用途 | 代码 |
|---|---|---|---|
| `ch` | 声道数 | `numberOfChannels` | `AirplayDevice.cs:2800` |
| `sr` | 采样率 | `audioSampleRate`（44100） | `:2819` |
| `ss` | 位深 | `audioSampleSize`（16） | `:2838` |
| `vs` | 接收端 AirTunes 版本 | 日志/兼容判断（真实值如 `150.35`） | `:2857` |
| `am` | 设备型号 | `deviceModel`；含 `APPLETV` → `IsAppleTV=true` | `:2862-2875` |
| `pw` | 是否需要密码 | `passwordNeeded` | `:2880` |
| `da` | 是否 Digest 认证 | `digestAuthentication`（决定 MD5 大小写，见 §4.3） | `:2893` |
| `cn` | 支持的音频编码 | 0=PCM,1=ALAC,2=AAC,3=AAC-ELD | `:2906-2949` |
| `et` | 加密类型 | **决定是否启用加密**，见下 | `:2950-2994` |
| `tp` | 传输协议 | `UDP`/`TCP` 位掩码 | `:2995-3030` |
| `md` | 元数据类型 | 0=text,1=artwork,2=progress | `:3031-3063` |
| `sf` | 状态标志 | **决定是否走 AirPlay2 配对**，见 §9 | `:3065-3098` |
| `pk` | RSA 公钥（hex） | **完全没被读取**（这是它硬编码 rsaaeskey 的原因） | 无 |
| `txtvers/vn/vv/ft/sv` | 其他 | 未使用 | 无 |

`et` 位映射（`AirplayDevice.cs:2962-2979`）：

| `et` 数值 | 含义 |
|---|---|
| 0 | 无加密（None） |
| 1 | RSA（=AirPlay 1 经典加密） |
| 3 | FairPlay |
| 4 | MFiSAP |
| 5 | FairPlay SAP 2.5 |

判断顺序（`AirplayDevice.cs:3142-3160`）：**有 RSA(1) 就选 RSA**，否则有 None(0) 选 None，否则报"不支持"并默认 None。
真实 Apple TV 3 的 `et=0,3,5` 不含 1 → 不加密（与 `trace.txt` 一致：SDP 无密钥字段）。

`sf` 位映射（`AirplayDevice.cs:3065-3098`）：

| `sf` 位 | 结论 |
|---|---|
| `& 0x200` 为 0 | 不需要配对（经典 RAOP，直接 OPTIONS） |
| `& 0x200` 非 0 且 `& 0x008` | `PasscodeEverytime`（每次输入配对码） |
| `& 0x200` 非 0 且 `& 0x080` | `Password`（AirPlay 密码） |
| `& 0x200` 非 0 且其他 | `FirstTimePassCode`（首次配对，记住 LTPK） |

> 注意：真实 Apple TV 3 的 `sf=0x4` 不含 0x200，因此走明文 RAOP。需要配对的设备（Apple TV 4+、HomePod 类）才会置 0x200。

### 2.3 手动添加设备

- 手动设备完全绕开 mDNS：直接给 `IP + port + encryption + digestAuth + isAppleTV4OrAbove`（`DeviceController.cs:361-390`、`AirplayDevice.cs:2199-2228`）：
  - `encryption=true` → `encryptionTypes |= RSA; EncryptionNeeded=true`（`:2205-2209`）
  - `encryption=false` → `encryptionTypes |= None; deviceModel="AppleTV"; EncryptionNeeded=false`（`:2210-2215`）
  - `isAppleTV4OrAbove=true` → `DeviceVerificationMode=FirstTimePassCode`（`:2217-2220`）

---

## 3. RTSP 会话（逐包精确规格）

### 3.1 通用规则

- **版本行**：`METHOD resource RTSP/1.0\r\n`。
- **身份头**（每个请求都带，顺序见各条）：

| 头 | 值 | 代码 |
|---|---|---|
| `User-Agent` | `TuneBlade/1.0 (Windows)` | `AirplayDevice.cs:197` |
| `Client-Instance` | `56B6CB929BB20486`（16 hex 常量） | `:199` |
| `DACP-ID` | 随机 8 hex 大写，持久化到设置；`Active-Remote` 配套 | `:201`、`DACPServer.cs:185-193` |
| `Active-Remote` | 随机 uint（1e8 ~ int.MaxValue），每个设备实例一个 | `:2234`、`DACPServer.cs:180-183` |

- **CSeq**：每发一个请求前 `seqNum++`，从 0 开始（`AirplayDevice.cs:2736` 重置；每个 `send*` 方法首行自增）。
  - 老版本 trace 里 OPTIONS 与 ANNOUNCE 都写 `CSeq: 1`（`trace.txt:29/46`），是新旧版本差异；**实现按当前代码：单调递增**。
- **URL**：
  - OPTIONS 用 `*`（`AirplayDevice.cs:1249`）
  - 其他用 `rtsp://<本机IP>/<resourceId>`（`:1388`），`resourceId` 是常量 `3121287335`（`:181`；trace 老版本为 `3415187335`，说明它只是任意数字串，接收端不校验）。
  - 本机 IP = TCP 连接后 `LocalEndPoint.Address`（`:2709`）。
- **响应读取**：ASCII 读到缓冲区以 `\r\n\r\n` 结尾为止（`AirplayDevice.cs:1799-1855`）；`ReceiveTimeout/SendTimeout=30000`（`:2707-2708`），TEARDOWN 时改 2500（`:1751-1752`）。
- **状态码**：`getResponseCode()` 用子串匹配 `200/401/403/453/503`（`AirplayDevice.cs:1875-1942`）；401 → 解析 `WWW-Authenticate` 的 `realm`/`nonce` 并触发密码输入（`:1293-1304`、`:1353-1381`）；453 = 设备被占用；503 = 服务不可用。
- 每条请求失败时若 `authenticationFailed`，会把 `addAuthenticationHeader=true` 后**重试同一条请求一次**（示例 `:2438-2448`）。

### 3.2 OPTIONS（`AirplayDevice.cs:1232-1280`）

```
OPTIONS * RTSP/1.0
CSeq: <n>
User-Agent: TuneBlade/1.0 (Windows)
Client-Instance: 56B6CB929BB20486
DACP-ID: <dacpId>
Active-Remote: <activeRemote>
[Authorization: Digest ...]          ← 仅 401 之后
[Apple-Challenge: <22 字符 base64>]  ← 仅 EncryptionNeeded 且非 ping
<空行>
```

- 无 body。
- 真实抓包响应（`trace.txt:37-40`）：
  ```
  RTSP/1.0 200 OK
  Public: ANNOUNCE, SETUP, RECORD, PAUSE, FLUSH, TEARDOWN, OPTIONS, GET_PARAMETER, SET_PARAMETER, POST, GET
  Server: AirTunes/150.35
  CSeq: 1
  ```
- `justPing=true`（保活）时**不**加 `Apple-Challenge`，也不校验 `Apple-Response`（`:1239`、`:1268`）。
- 保活节奏：每 15 秒一次 `Ping()`（`AudioSource.cs:902-906` 调用 `DeviceController.PingAll()`；`AirplayDevice.cs:2099-2167`）。
- 加密分支下会校验响应头 `Apple-Response`（`:1268-1278`）；但 `Crypto.VerifyAppleResponse()` 是恒 `true` 的 stub（`AirTunesCommon.Crypto/Crypto.cs:14-17`）。

### 3.3 ANNOUNCE + SDP（`AirplayDevice.cs:1383-1426`）

```
ANNOUNCE rtsp://<本机IP>/<resourceId> RTSP/1.0
CSeq: <n>
Content-Type: application/sdp
Content-Length: <SDP 字节数，含末尾 CRLF>
User-Agent: TuneBlade/1.0 (Windows)
Client-Instance: 56B6CB929BB20486
DACP-ID: <dacpId>
Active-Remote: <activeRemote>
[Authorization: Digest ...]
<空行>
v=0
o=iTunes <resourceId> 0 IN IP4 <接收端IP>
s=iTunes
c=IN IP4 <接收端IP>
t=0 0
m=audio 0 RTP/AVP 96
a=rtpmap:96 AppleLossless
a=fmtp:96 352 0 16 40 10 14 2 255 0 0 44100
[a=rsaaeskey:<base64>]        ← 仅 EncryptionNeeded
[a=aesiv:<base64>]            ← 仅 EncryptionNeeded
<CRLF>
```

要点与坑：
- **`o=` 和 `c=` 里写的是接收端 IP**（`:1392/1394` 用的是 `ipAddress` 字段），不是标准做法里的发送端 IP；实测 Apple TV 接受（`trace.txt:55-57`）。新实现建议按规范写发送端 IP，两可。
- `Content-Length` = SDP 字符串长度，包含 SDP 每行末尾 CRLF + 最后额外一个 CRLF（`:1404`、`:1409`）。trace 中该 SDP（resourceId=3415187335）长度恰为 `182`（`trace.txt:48`）。
- `a=fmtp:96` 的 11 个数字是 ALAC magic cookie：
  `frameLength=352, compatibleVersion=0, bitDepth=16, pb=40, mb=10, kb=14, numChannels=2, maxRun=255, maxFrameBytes=0, avgBitRate=0, sampleRate=44100`【规范：Apple Lossless 文件格式 magic cookie 字段顺序】。
  代码里该字符串写死为 `"96 352 0 16 40 10 14 2 255 0 0 44100"`（`:1387`）。
- 仅当 `EncryptionNeeded` 才追加 `rsaaeskey`/`aesiv`（`:1399-1403`），值来自 `AudioSource.Instance.CryptoInfo.RSAAES_Str / IV_Str`（硬编码，见 §4.1）。
- 响应只看状态码，未解析 body。

### 3.4 SETUP（`AirplayDevice.cs:1428-1523`）

```
SETUP rtsp://<本机IP>/<resourceId> RTSP/1.0
CSeq: <n>
Transport: RTP/AVP/UDP;unicast;interleaved=0-1;mode=record;control_port=<本地control端口>;timing_port=<本地timing端口>
User-Agent: TuneBlade/1.0 (Windows)
Client-Instance: 56B6CB929BB20486
DACP-ID: <dacpId>
Active-Remote: <activeRemote>
[Authorization: Digest ...]
<空行>
```

- `control_port/timing_port` 必填（`:1437-1438`、`:1447`）；`interleaved=0-1` 即使走 UDP 也带上（接收端忽略）。
- 真实响应（`trace.txt:82-87`）：
  ```
  RTSP/1.0 200 OK
  Transport: RTP/AVP/UDP;unicast;mode=record;server_port=51319;control_port=50709;timing_port=53284
  Session: 1
  Audio-Jack-Status: connected
  Server: AirTunes/150.35
  CSeq: 2
  ```
- 响应解析（`AirplayDevice.cs:1463-1521`）：
  - `Session` → `sessionID`（纯字符串，`Session: 1` 也照抄回传，不需要按 RTSP 规范解析 `;timeout=`）
  - `Transport` 里 `server_port` → `audioEndpoint = (ipAddress, server_port)`；**缺失时默认 6000**（`:1466-1474`）
  - `Transport` 里 `control_port` → `controlEndpoint`；缺失则 **null**（`:1475-1483`）
  - `Transport` 里 `timing_port` → `timingEndpoint`；缺失则 **null**（`:1484-1492`）
  - `Audio-Latency` → `audioLatency`（int，单位 = 采样帧；见 §5.5）（`:1504-1521`）

### 3.5 RECORD（`AirplayDevice.cs:1525-1573`）

```
RECORD rtsp://<本机IP>/<resourceId> RTSP/1.0
CSeq: <n>
Session: <sessionID>
Range: npt=0-
RTP-Info: seq=<首个音频包 seq>;rtptime=<首包 RTP 时间戳>
User-Agent: TuneBlade/1.0 (Windows)
Client-Instance: 56B6CB929BB20480
DACP-ID: <dacpId>
Active-Remote: <activeRemote>
[Authorization: Digest ...]
<空行>
```

（注：上面 `Client-Instance` 的十六进制是笔误示例，实际值见 §3.1 表格 `56B6CB929BB20486`。）
- `RTP-Info` 取 `AudioSource.CurrentSeqNum` 与 `AudioSource.RTPTimestamp`（连接时全局音频时钟的当前值，`AirplayDevice.cs:2489`）。
- 响应可选 `Audio-Latency`，再次覆盖 `audioLatency`（`:1551-1571`）。

### 3.6 SET_PARAMETER — 音量（`AirplayDevice.cs:1575-1604`）

```
SET_PARAMETER rtsp://<本机IP>/<resourceId> RTSP/1.0
CSeq: <n>
Session: <sessionID>
Content-Type: text/parameters
Content-Length: <body 字节数>
User-Agent: TuneBlade/1.0 (Windows)
Client-Instance: 56B6CB929BB20486
DACP-ID: <dacpId>
Active-Remote: <activeRemote>
[Authorization: Digest ...]
<空行>
volume: <dB 值，格式 N6，如 -12.345678>\r\n
```

- dB 换算（`AirplayDevice.cs:3106-3117`）：
  - `percent == 0` → **-144.0**（静音）
  - `percent == 100` → **-0.001**
  - 其他 → **-30.0 * (100 - percent) / 100.0**
- 实际发送时 `percent = totalVolume / 100`，`totalVolume = 设备音量(0..100) * 主音量(0..100)`（`:2173`、`:2546`），即最终 0..100 的百分比。
- `volume: -144` 就是"静音"（`MuteVolume = -144` 常量，`AirplayDevice.cs:153`）。
- 格式用 `ToString("N6", CultureInfo.InvariantCulture)`（`:1581`），**必须不变文化**，否则逗号小数点会破坏协议。

### 3.7 SET_PARAMETER — 元数据 DMAP（`AirplayDevice.cs:1606-1652`）

用通用 `RTSPRequest` 对象（`AirTunesCommon/RTSPRequest.cs`）构造，**先发 header 段再发二进制 body**：

```
SET_PARAMETER rtsp://<本机IP>/<resourceId> RTSP/1.0
User-Agent: TuneBlade/1.0 (Windows)
RTP-Info: rtptime=<当前 RTP 时间戳>
Client-Instance: 56B6CB929BB20486
DACP-ID: <dacpId>
Active-Remote: <activeRemote>
[Authorization: Digest ...]
Content-Type: application/x-dmap-tagged
Content-Length: 56
CSeq: <n>
<空行>
<56 字节 DMAP>
```

> 注意 `RTSPRequest.ConvertToString()` 把 `CSeq` **放在所有头之后**，且 `Content-Length` 在头列表之后、`CSeq` 之前（`AirTunesCommon/RTSPRequest.cs:103-118`）。接收端不关心顺序。

56 字节 DMAP 内容逐字节（`AirplayDevice.cs:1615-1623`），解析成树：

```
mlit  长度 48
 ├─ minm  长度 13  "System Audio\0"     ← 曲名（DMAP 字符串长度包含结尾 NUL）
 ├─ asar  长度 10  "TuneBlade\0"        ← 艺术家
 └─ asal  长度  1  "\0"                 ← 专辑（空串）
```

- 通用 DMAP 结构：4 字节 tag + **4 字节大端长度** + 内容；容器 `mlit` 的长度只算其内容（不含自身 8 字节头）——本例 `48 = 8+13 + 8+10 + 8+1`。
- 想显示真实歌曲信息时把 `minm` 换成曲名、`asar` 换艺术家、`asal` 换专辑；`asal` 也是专辑名 tag。封面另走 §8.4。
- 该请求只发一次（连接完成后，`AirplayDevice.cs:2581`），不解析响应内容（`RTSPResponse.CreateRTSPResponseObject` 只读掉响应，`:1643-1650`）。

### 3.8 SET_PARAMETER — 进度（`AirplayDevice.cs:1654-1683`）

```
SET_PARAMETER rtsp://<本机IP>/<resourceId> RTSP/1.0
CSeq: <n>
Session: <sessionID>
Content-Type: text/parameters
Content-Length: <n>
User-Agent: TuneBlade/1.0 (Windows)
Client-Instance: 56B6CB929BB20486
DACP-ID: <dacpId>
Active-Remote: <activeRemote>
[Authorization: Digest ...]
<空行>
progress: <RTPTime>/<RTPTime>/<RTPTime>\r\n
```

- 代码三个值全填同一个 RTP 时间戳（`AudioplayDevice.cs:1660`，即 `text = "progress: " + RTPTime + "/" + RTPTime + "/" + RTPTime`）。
- 语义【规范】：`progress: <start>/<current>/<end>`，单位是 RTP 采样帧，相对本次 RTP 时间戳基准。真实实现应填 当前播放位置/总时长，接收端用它显示进度条。

### 3.9 FLUSH（`AirplayDevice.cs:1685-1742`）

```
FLUSH rtsp://<本机IP>/<resourceId> RTSP/1.0
CSeq: <n>
Session: <sessionID>
RTP-Info: seq=<当前 seq>;rtptime=<当前 RTP 时间戳>
User-Agent: TuneBlade/1.0 (Windows)
Client-Instance: 56B6CB929BB20486
DACP-ID: <dacpId>
Active-Remote: <activeRemote>
[Authorization: Digest ...]
<空行>
```

- 语义：让接收端**丢弃已缓冲的音频**。TuneBlade 用它做"缓冲溢出保护"：当发送端落后 `SeqNumber - lastSentSeqNum` 超过阈值（30/45/…包）时，把最差的设备 `SubState=Waiting` 并 FLUSH（`AudioSource.cs:2603-2651`）；之后某设备（`getFirstWaitingDevice`）在落后小于 5/10 包且距上次操作 >2s 时直接切回 `Streaming`（`AudioSource.cs:2653-2665`）。
- 注意：**TuneBlade 恢复时没有再发 RECORD**，只是内部状态切回 Streaming、继续用连续的 seq/rtptime 发流；缺 RECORD 意味着接收端要靠 Sync 包重新对齐。新实现建议在 FLUSH 后按标准再发一次 RECORD（带新的 RTP-Info）。
- `Flush()` 发送前把自身 `SubState` 置 `Waiting`（`AirplayDevice.cs:1688`），失败时 `cleanUp()+reconnect`（`:1703-1709`）。

### 3.10 TEARDOWN（`AirplayDevice.cs:1744-1775`）

```
TEARDOWN rtsp://<本机IP>/<resourceId> RTSP/1.0
CSeq: <n>
Session: <sessionID>
User-Agent: TuneBlade/1.0 (Windows)
Client-Instance: 56B6CB929BB20486
DACP-ID: <dacpId>
Active-Remote: <activeRemote>
[Authorization: Digest ...]
<空行>
```

- 超时降到 2500ms；发完不解析响应（`:1773`）。
- 用途：断开连接 / 进 standby（`AirplayDevice.cs:3457-3492`：TEARDOWN → 关 TCP → 保留 UI 状态；Resume 时重走完整 connect，`:3494-3509`）。

### 3.11 POST — 配对与 auth-setup

通用 `Post(resource, body, len, contentType)`（`AirplayDevice.cs:1161-1206`）：

```
POST /<resource> RTSP/1.0
User-Agent: TuneBlade/1.0 (Windows)
Client-Instance: 56B6CB929BB20486
DACP-ID: <dacpId>
Active-Remote: <activeRemote>
Content-Type: <contentType>
Content-Length: <len>
CSeq: <n>
<空行>
<二进制 body>
```

> 与其他请求不同，`Post` 的 URL **资源以 `/` 开头**（如 `/pair-setup-pin`），不是 `rtsp://` 全 URL（`AirplayDevice.cs:1163-1170` 附近）。

用到的 POST：

| resource | Content-Type | body | 触发条件 | 代码 |
|---|---|---|---|---|
| `auth-setup` | `application/octet-stream` | 固定 33 字节 `{01 4E EA D0 4E A9 2E 47 69 D2 E1 FB D0 96 81 D5 94 A8 EF 18 45 4A 24 AE AF B3 14 97 0D A0 B5 A3 49}` | `et&MFiSAP` 或（手动设备且未加密） | `AirplayDevice.cs:1777-1786`、`:2354-2357` |
| `pair-pin-start` | null/无 | 空 | 需要配对 | `DeviceVerificationHandler.cs:97` |
| `pair-setup-pin` | `application/x-apple-binary-plist` | `{method:"pin", user:<ID>}` 二进制 plist | 同上 | `:99-102` |
| `pair-setup-pin` | 同上 | `{pk:<A>, proof:<M1>}` | 同上 | `:103-104` |
| `pair-setup-pin` | 同上 | `{epk:<32B>, authTag:<16B>}` → 返回 32 字节 seed（base64 存为 DeviceVerificationKey） | 同上 | `:114-123` |
| `pair-verify` | `application/octet-stream` | `{01 00 00 00} + 我方 X25519 公钥(32) + 设备 Ed25519 LTPK(32)` = 68B | 已配对设备重连 | `:132-136` |
| `pair-verify` | `application/octet-stream` | `{00 00 00 00} + AES-CTR 加密的 Ed25519 签名(64)` = 68B | 同上 | `:143-146` |

`auth-setup` 这 33 字节是 MFiSAP 方向的一个常量（`AirPlayDevice.cs:1779-1785`）；经典 RAOP 用不到它。

### 3.12 会话建立编排（`AirplayDevice.cs:2291-2600`）

```
connect()
  ├─ [非手动] Resolve()（mDNS，7s 超时）
  ├─ connectTcpClient()    // TCP connect + myIPAddress；seqNum=0、realm/nonce 清空
  ├─ if DeviceVerificationMode != None && !performDeviceVerification() → 退出
  ├─ if (et&MFiSAP || (IsManual && !EncryptionNeeded)) sendAuthSetupRequest()
  ├─ sendOptionsRequest(false)          // 401 → 密码对话框 → 带 Authorization 重试
  ├─ sendAnnouncePacket()
  ├─ sendSetupRequest()
  ├─ sendRecordRequest(AudioSource.CurrentSeqNum, AudioSource.RTPTimestamp)
  ├─ totalVolume = Volume * MasterVolume; sendSetParamRequest()
  ├─ Status=Connected; SubState=Streaming
  ├─ sendSetParam2Request(RTPTimestamp) // DMAP "正在播放"
  ├─ sendSetParam3Request(RTPTimestamp) // progress
  └─ AudioSource.RegisterDevice(this)   // 之后音频线程开始向它发包
```

### 3.13 Digest 认证

- 401 时从 `WWW-Authenticate` 里取 `realm`、`nonce`（`AirplayDevice.cs:1295-1297`、`:1353-1373`）。
- 计算（`AirplayDevice.cs:1788-1797`、`AirTunesCommon.Crypto/Crypto.cs:44-49`）：
  ```
  HA1 = MD5("iTunes:realm:password")
  HA2 = MD5(method + ":" + uri)          // uri = rtspUri，如 "rtsp://192.168.0.7/3121287335"
  response = MD5(HA1 + ":" + nonce + ":" + HA2)
  ```
- 大小写：`digestAuthentication(TXT da)==false` → 大写 hex；`==true` → 小写 hex（`AirplayDevice.cs:1790-1794`）。
- 请求头格式（`:1796`）：
  `Authorization: Digest username="iTunes", realm="<realm>", nonce="<nonce>", uri="<rtspUri>", response="<MD5 hex>"`
- username 固定 **`iTunes`**（`AirTunesCommon.Crypto/Crypto.cs:1795` 调用处传 "iTunes"）。
- 密码来源：TuneBlade 弹对话框（`AirplayDevice.cs:2380-2417`、`1210-1229`）；密码错误会重新 401 → 重新弹框，直到空密码取消。

---

## 4. 加密分支

### 4.1 密钥与硬编码

**结论：TuneBlade 的加密分支是不可移植的**。它把 AES key、IV、RSA 加密后的 aeskey 全部写成常量，并让"生成"函数抛异常——这意味着它从不真正生成密钥，也不使用接收端 `pk=`。

- `CryptoInfo`：`byte[] AES; byte[] IV; string RSAAES_Str; string IV_Str`（`AirTunesCommon.Crypto/CryptoInfo.cs:3-21`）。
- 初始化位置：`AudioSource.initFixedEncryptionKeys()`（`AudioSource.cs:760-775`）
  - AES key = `0B A0 D6 B0 92 06 D2 14 F8 D5 9A F0 9F AB BB 15`
  - IV = `30 7C 0D 00 60 43 C8 07 F4 F5 CB 51 41 2D A8 C2`；`IV_Str = Base64(IV) = "MHwNAGBDyAf09ctRQy2owg=="`
  - `RSAAES_Str` = 一个固定 base64 长串（`AudioSource.cs:773`，约 440 字符），即"已用某 RSA 公钥加密好的 AES key"。
- AES 用法（`AudioSource.cs:796-800`、`1555-1569`）：`AesCryptoServiceProvider`，`CBC`，**Padding=None**，Key/IV 固定；**每个音频包都用同一个 IV 独立加密**（不跨包链接），只加密 ALAC 载荷、不加密 RTP 头；最后不足 16 字节的尾巴**明文拷贝**。
- 未实现的函数（stub）：`Crypto.GenerateAesKey()`、`GenerateAesIV()`、`RSAPublicEncrypt()` 全部 `throw new NotImplementedException()`（`AirTunesCommon.Crypto/Crypto.cs:19-32`）；`GenerateAppleChallenge()` 返回常量 `"X/GmLMLuFvgWf8Y1bQuUug"`、`VerifyAppleResponse()` 恒 true（`:9-17`）——即源码作者（TuneBlade 基于开源 airtunes 发送端）故意把加密部分阉割了。
- 结果：只有"能接受固定 key/固定 rsaaeskey 的接收端"才可能工作；正常 RAOP 接收端会因 `rsaaeskey` 解不开而拒绝出声。**新实现不要复用这条分支。**

### 4.2 标准 RAOP 加密应怎么做（供新实现参考，非反编译内容）

1. 从 mDNS TXT 读 `pk=<hex>`（TuneBlade 完全没读，`AirplayDevice.cs:2789-3103` 里没有 `"pk"` 的解析）。
2. 随机生成 16 字节 AES key + 16 字节 IV。
3. `rsaaeskey = RSA-OAEP(SHA1, 接收端 pk)(aeskey)`，base64 放进 SDP `a=aesaaeskey:`；`aesiv = base64(IV)`。
4. 音频载荷 AES-128-CBC 加密（固定 IV、每包独立、Padding=None——与 TuneBlade 相同），RTP 头明文。
5. 响应里 `Apple-Response` = RSA 私钥签名（对 `Apple-Challenge + 本机IP + 本机MAC` 做 RSA-SHA1 再 base64），标准接收端不校验或只校验其可解性，一般可略。

> 若目标只是让现代设备（HomePod、Apple TV 4K、macOS 新系统）出声，别走 RAOP 加密分支，要走 AirPlay2/HAP（§9）。

### 4.3 AirPort/密码设备：Digest 认证（不是 SRP）

- 经典 AirPort Express 的"AirPlay 密码"走 RTSP **Digest** 认证（§3.13），不是 SRP。TXT `pw=true`、`da` 决定 MD5 大小写；401 挑战里拿 realm/nonce。
- SRP 只在 AirPlay2 配对（`pair-setup-pin`）里出现。

### 4.4 AirPlay2 配对（pair-setup-pin + pair-verify，TuneBlade 的实现）

证据：`Tuneblade/DeviceVerificationHandler.cs`、`Tuneblade/AirPlaySRPClient.cs`、`Tuneblade/BinaryPlistConverter.cs`。

触发：`DeviceVerificationMode != None` 时在 connect 的**第一步**（TCP 连上后、OPTIONS 前）执行 `performDeviceVerification()`（`AirplayDevice.cs:2341-2346`）；模式来自 `sf` TXT（`AirplayDevice.cs:3065-3098`）或手动设备勾选 Apple TV 4+（`:2217-2220`）。
已存 `DeviceVerificationKey` 则 `Verify(key)`，否则 `Pair(ID)` 后保存返回 key（`AirplayDevice.cs:1087-1159`）。

**pair-setup-pin**（`DeviceVerificationHandler.cs:95-124`）：

1. `POST /pair-pin-start`（空 body）→ 接收端显示 4 位配对码。
2. `POST /pair-setup-pin`，body = 二进制 plist `{method:"pin", user:"<ID>"}`（`BinaryPlistConverter.cs:11-31`）。ID 为客户端标识（TuneBlade 用随机 MAC 字符串，`AirplayDevice.cs:1087-1159`）。
3. 响应 = 二进制 plist `{salt:<NSData>, pk:<NSData>}`。
4. SRP-6a 计算（`AirPlaySRPClient.cs`）：
   - 群：**RFC 5054 2048-bit**(`Srp6StandardGroups.rfc5054_2048`)，哈希 **SHA-1**（`:105-108`）
   - `x = H(salt | H(user) | H(pass))` 由 BouncyCastle `Srp6Utilities.CalculateX` 完成（`:136`）
   - `A = g^a mod N`；`k = H(N|g)`；`u = H(A|B)`；`S = (B - k·g^x)^(a+u·x) mod N`（`:136-147`）
   - `K = SHA1(S) || SHA1(S | 00 00 00 01)`（`:160-177`）
   - `M1 = H( H(N) xor H(g) | H(user) | salt | A | B | K )` → 作为 `proof` 回给设备（`:179-207`）
   - `M2 = H(A | M1 | K)` → 校验设备返回的 proof（`:209-244`）
5. 发送 `{pk: A, proof: M1}`；响应 `{proof: M2}` 并校验（`:103-113`）。
6. 生成 **Ed25519 密钥对**（32 字节 seed → 32 字节公钥 LTPK），用 **AES-128-GCM** 加密 LTPK：
   - key = `SHA512("Pair-Setup-AES-Key" | K)[0..16]`
   - iv  = `SHA512("Pair-Setup-AES-IV" | K)[0..16]`，然后**末字节 +1（带进位）**（`DeviceVerificationHandler.cs:24-55`，`:39-46`）
   - 输出 = 密文(32) + authTag(16)（GCM 默认 16 字节 tag）
7. 发送 `{epk: <32B 密文>, authTag: <16B>}`；成功后把第 6 步的 **Ed25519 私钥 seed base64 存为 DeviceVerificationKey**（`:114-123`）。

**pair-verify**（`DeviceVerificationHandler.cs:126-151`）：

1. 我方用 X25519（Curve25519）随机密钥对；请求 = 4 字节 `{01 00 00 00}` + 我方 X25519 公钥(32) + 我方 Ed25519 LTPK(32)，Content-Type `application/octet-stream`。
2. 响应 = 设备 X25519 公钥(32) + 加密数据（≥64B）。
3. `sharedSecret = X25519(我方私钥, 设备公钥)`；`signature = Ed25519.Sign(我方X25519公钥 | 设备X25519公钥, LTPK私钥)`（64B）。
4. AES-128-CTR（BouncyCastle `SicBlockCipher`）：
   - key = `SHA512("Pair-Verify-AES-Key" | sharedSecret)[0..16]`
   - iv  = `SHA512("Pair-Verify-AES-IV" | sharedSecret)[0..16]`
   - **坑**：代码先用同一 CTR 流"加密"响应里剩下的加密数据（`array3`，长度 = 响应长度-32，通常 64B），**丢弃结果**，再加密 signature；这等于把 CTR 计数器推进了 `len(array3)` 字节后再加密签名（`DeviceVerificationHandler.cs:57-76`、`:143`）。新实现按 HAP 规范是 `ChaCha20-Poly1305` 或纯 CTR 无推进，TuneBlade 这里是老式 AirPlay2 变体，**不要照抄**。
5. 第二个 `pair-verify` 请求 = 4 字节 `{00 00 00 00}` + 加密后的签名(64B)（`:144-146`）。成功后**没有任何后续加密会话建立**。

**结论**：TuneBlade 的配对只用来"过 Apple TV 4+ 的配对门"，之后继续明文 RTSP + 固定 AES 音频。真正 AirPlay2 设备要求 pair-verify 成功后用协商出的密钥（`Pair-Verify` 的 sharedSecret 派生的会话密钥）加密所有 RTSP/音频（HAP 会话，ChaCha20-Poly1305 帧），TuneBlade 完全没有实现（全仓库无 `ChaCha20`/`Poly1305`/`hap`/`LTSK` 匹配）。`DeviceVerificationHandler.IsSecurityModeAcceptable()` 甚至直接 `return false;`（`:153-156`）。

---

## 5. RTP 音频流

### 5.1 包结构（正常音频包，UDP 发出）

发送缓冲区布局（`AudioSource.cs:736-748` 分配 1444 字节；`1570-1586` 填充）：

| 偏移 | 长度 | 内容 | 说明 |
|---|---|---|---|
| 0 | 4 | 重传响应头（`type=0x56 RangeResendResponse`，`seq=ceil(包长/4)`） | **正常发包时跳过**（`SendTo` 用 offset=4） |
| 4 | 1 | `0x80` = version 2 / padding 0 / ext 0 / CC 0 | `RTPHeader.serialize()` 首字节 |
| 5 | 1 | `0x60` = marker 0 | PT=96（AppleLossless）；**marker=false** |
| 6 | 2 | seq（大端） | 从 0 递增，u16 回绕 |
| 8 | 4 | RTP timestamp（大端） | 每包 +352 |
| 12 | 4 | SSRC = **874812771 (0x34249563)**（大端） | 固定值 |
| 16 | n | ALAC 帧数据 | n = 编码输出长度（≤1428） |

- 实际发出 = `audioPacketBytes[4 .. 4 + 12 + n)`，长度 `AudioPacketSize = n + 12`（`AudioSource.cs:1580`、`:1021`）。
- 缓冲上限：`MaxALACPacketSize=1428`、`MaxPacketSize=1444`（`AudioSource.cs:77-83`）。
- RTP 头序列化细节（`AirTunesCommon/RTPHeader.cs:58-67`）：seq 用 `BitConverter.GetBytes(seq)[1], [0]` 手动翻大端——在 little-endian 下等价于大端；接收端按标准 RTP 大端解析。**新实现直接用 BinaryPrimitives.WriteUInt16BigEndian**。

### 5.2 采样与编码

- 输入：WASAPI 捕获，目标格式 **44100Hz / 16bit / 2ch**；设备格式不同则 DMO 重采样（`AudioSource.cs:1469-1474`、`resampler` 字段）。
- 每包 PCM = **1408 字节** = 352 帧 × 2ch × 2B（`PCMDataPerPacketSize`，`AudioSource.cs:73`、`:1533-1552`）。
- ALAC 编码通过 P/Invoke 调 `AlacCodec.dll`：`InitializeEncoder(..., framesPerPacket=352)`（`AudioSource.cs:794`）；`EncodeALACBuffer` 输出到 3428 字节缓冲（`:790`、`:1553`）。
  - 该 DLL 是 TuneBlade 自带原生库（`AirTunesCommon/AlacCodec.cs` 的 `[DllImport("AlacCodec.dll")]`），新实现需自己找 ALAC 编码器（**关键风险点**，见 sharp-notes.md）。
- **时间戳规则**：`RTPTimestamp` 是**全局**（跨设备共用一个 AudioSource），每编码一包 `+= 352`（`AudioSource.cs:1535`）；初值 `44100 * RTPClock.ElapsedMilliseconds / 1000`（`:850-853`，进程内秒表，毫秒精度）。
  - 时间戳推进与实际采集时间**解耦**：只按"每包 352 帧"推进，发送节奏由 PCM 到达驱动。接收端用它在缓冲里做时间定位，能容忍抖动。

### 5.3 发送节奏

- `processPCMAndEnqueue` 把编码好的包放进按 seq 索引的环形数组（`audioBuffer[65536]`，只预建 `seq-1000 .. -1` 共 1000 个对象，`AudioSource.cs:736-748`、`:1542-1545`），然后 `updateDevicesThreadEvent.Set()`。
- `updateDevices` 线程：只要 `lastSentSeqNum != SeqNumber-1` 就把它之后的包逐台设备发出去；追平后 `WaitOne(500)`（`AudioSource.cs:936-1051`）。**没有固定定时器**——PCM 回调驱动。
- 只向 `SubState == Streaming` 的设备发（`AudioSource.cs:1007-1012`）；每包对所有设备各发一次（组播式多设备同步：同一 seq/rtptime）。
- 发送前 `resendFlagEvent.WaitOne(50)` 让重传线程有优先权（`:1019`、`:1029`）。

### 5.4 重传（Retransmit）

- 接收端发现丢包时，向**发送端 control 端口**发 8 字节请求（`AirTunesCommon/ResendPacket.cs`）：

| 偏移 | 长度 | 内容 |
|---|---|---|
| 0 | 1 | `0x80` |
| 1 | 1 | `0x55`（85 = RangeResendRequest） |
| 2 | 2 | 起始 seq（大端） |
| 4 | 2 | 丢失包个数（大端） |
| 6 | 2 | 未用（0） |

- 收到后把 `[seq, seq+count)` 逐个加入该设备 `ResendList`，按 seq 排序（`AudioSource.cs:1799-1837`）。
- 重传线程逐个发送该包（`AudioSource.cs:1839-1910`）：
  - `controlEndpoint != null` → 向 control 端口发 `audioPacketBytes[0 .. size+4)`，即**带 4 字节重传响应头**
  - `controlEndpoint == null` → 向 audio 端口发 `audioPacketBytes[4 .. size+12)`（同正常包格式）
- 重传响应头（`AudioSource.cs:1670-1680`）：`type=0x56(RangeResendResponse)`，`seqNum = ceil(包长/4)`（**注意：这个位置的 u16 填的是包长/4，不是 seq**）。
- 过期的重传请求丢弃：`isResendRequestExpired` 用"当前正在播放的 seq = `SeqNumber - bufferSizeInRTP/352`"做窗口比较（`AudioSource.cs:1682-1690`、`:1692-1710` 的 `compareSeqNumbers` 处理 u16 回绕）。
- 速率统计 `ResendPacketRate > 40` 视为信号差（`AudioSource.cs:2549-2557`）。

### 5.5 延迟参数（latency）与缓冲

- `Audio-Latency` 响应头（单位：44100Hz 下的采样帧）→ `audioLatency`；**小于 100 时按 8500 处理**（`AirplayDevice.cs:754-764`）。
- `MaxLatency`：Apple TV（`am` 含 APPLETV）= **154350**（=3.5s），其他 = **2205000**（=50s）（`AirplayDevice.cs:555-565`）。用作接收端缓冲上限参考（UI/告警阈值）。
- `bufferSizeInRTP` = `max(各设备 AudioLatency, 当前 StreamingMode 对应毫秒×44.1)`（`AudioSource.cs:2077-2103`）。它**只用于** Sync 包的 `rtpTime` 计算（见 §6.1）与缓冲百分比显示，不参与"延迟发包"。
  - 真实音频延迟由接收端自己按 `Audio-Latency` 缓冲，发送端只需连续推流（这正是 RAOP 简单的原因）。
- 缓冲告警：落后包数超过 30/45/… 会 FLUSH 最差设备（§3.9）。

---

## 6. 时钟：Sync / Timing / NTP

### 6.1 Sync 包（sender → receiver control 端口，每 1 秒）

结构 20 字节（`AirTunesCommon/SyncPacket.cs`）：

| 偏移 | 长度 | 内容 |
|---|---|---|
| 0 | 4 | RTP 头：version=2、PT=**84 (0x54) Sync**、seq=**7**、marker=false |
| 4 | 4 | `rtpTime`（大端 u32） |
| 8 | 8 | `ntpTime`（NTP 64 位：秒 4 + 小数 4，大端） |
| 16 | 4 | `rtpNext`（大端 u32） |

发送逻辑（`AudioSource.cs:881-934`，`Timer(…,1000,1000)`）：

- `now = GetCurrentRTPTime()`
- `rtpNext = now - 882 (+ DSPDelay毫秒×44.1)`（882 是补偿量）
- `ntpTime = NTPClockHost.getCurrentNTPTimestamp()`
- `rtpTime = rtpNext - bufferSizeInRTP`
- 每个 Streaming 设备各发一份到其 `ControlEndpoint`
- 语义【规范】：`(rtpTime, ntpTime)` 给出"RTP 时间戳 ↔ NTP 墙钟"的锚点，`rtpNext` 预告下一批音频的时间基准；接收端用它在本地时钟上安排播放时刻。
- 同一 timer 里每 15 秒触发一次 OPTIONS 保活（`AudioSource.cs:902-906`）。

### 6.2 Timing 包（receiver → sender timing 端口；sender 原样回）

请求/响应都是 32 字节（`AirTunesCommon/TimingPacket.cs`）：

| 偏移 | 长度 | 内容 |
|---|---|---|
| 0 | 4 | RTP 头：PT=**82 (0x52) TimingRequest** / **83 (0x53) TimingResponse**；seq 回显 |
| 4 | 4 | 全 0（保留；serialize 时这块留空，`TimingPacket.cs:54-57` 从 offset 8 开始写） |
| 8 | 8 | `referenceTime`（请求里=设备发送时刻） |
| 16 | 8 | `receivedTime`（本机收到时刻） |
| 24 | 8 | `sendTime`（本机回复时刻） |

处理逻辑（`AudioSource.cs:1615-1668`）：

1. 收包 → 校验长度 32、`type == 82`，否则丢弃。
2. 回复：`type=83`、`seqNum` 回显；`referenceTime = 请求.sendTime`；`receivedTime = sendTime = NTPClockHost.getCurrentNTPTimestamp()`。
3. 发回同一 UDP 远端（设备地址）。

接收端据此估算单向延迟/时钟偏差（标准 RAOP 的 NTP 式 ping-pong）。

### 6.3 NTP 时间编码

- 编码（`AirTunesCommon/NTPClockHost.cs:11-25`）：
  - `integer = (uint)进程秒表秒数 + 2208988800`（NTP 纪元 1900-01-01 相对 1970 的秒差）
  - `fraction = (uint)(2^32 * (毫秒/1000))`
- 编解码在 `NTPTime.serialize()/desserialize()` 中都是**大端**（`NTPTime.cs:20-34`、`121-129`）。
- **坑**：`NTPClockHost` 用 `4294967296.0`（2^32）算小数部分（`NTPClockHost.cs:23`），而 `NTPTime.DoubleValue/Milliseconds` 用 `4294967295.0`（2^32-1）反算（`NTPTime.cs:14-16`）。两边不一致，误差 <1ms 量级，但实现时统一用 2^32 更正确。
- **坑**：这个 NTP 时间是"进程启动=0秒"的假时间，不是真实墙钟。因为双方都只做差，接收端可接受；但如果接收端把 NTP 时间当真墙钟（部分实现会用来显示），会出现 1970 年代。**新实现建议用真实系统 UTC 时间 + 2208988800 偏移**（shairport-sync 就是这样做的）。
- RTP 时间戳 ↔ NTP 换算：RTP 每 44100 单位 = 1 秒。

---

## 7. 音量 / 静音 / 元数据 / DACP（可选但影响体验）

### 7.1 音量

见 §3.6。要点：dB 线性映射（0% = -144，100% = -0.001，中间 = -30×(100-x)/100），发 `volume: <N6>`；接收端自己应用。
TuneBlade 的 `Volume` 属性修改后有节流线程保证最终一致（`AirplayDevice.cs:2169-2192`）。

### 7.2 静音

没有独立 MUTE RTSP 方法；静音 = 发 `volume: -144.000000`。`MuteVolume = -144` 常量（`AirplayDevice.cs:153`）。

### 7.3 进度

`progress: a/b/c`（§3.8）。TuneBlade 只在连接时发一次且三个值相同（等于没实现进度）。

### 7.4 封面/歌曲信息

- TuneBlade 的"元数据"只有 §3.7 的假 now-playing（"System Audio"/"TuneBlade"），**没有实现封面**。
- 真正封面路径【规范 + 代码线索】：接收端（Apple TV/iOS/macOS）收到 `DACP-ID` + `Active-Remote` 后，会向**发送端运行 DACP HTTP 服务**发 `GET /ctrl-int/1/...`（如 `getproperty?properties=dmcp.coverart`）请求封面，发送端返回 JPEG。
- TuneBlade 有 DACP 服务器：随机端口 49152-65535（`DACPServer.cs:57`），发布 `_dacp._tcp`：
  - 实例名 `iTunes_Ctrl_<DACPID>`（`:198`）
  - TXT：`txtvers=1, Ver=131077, DbId=929CEC49A3D3838C, OSsi=0x1F5`（`:202-207`）
  - 接受 `GET` + `Active-Remote` 头，映射回设备后 `RegisterDacpClient`（`:147-155`）；先回 `HTTP/1.1 204 No Content` + `DAAP-Server: TuneBlade`（`:167-178`）。
  - 具体 artwork 请求处理在 `AirplayDevice.RegisterDacpClient`（`AirplayDevice.cs:861`，本文未展开）。
- 新实现若要做封面：需要完整实现 DACP 服务端（`/ctrl-int/1/nowplayingartwork`、`/ctrl-int/1/getproperty` 等）并在 ANNOUNCE/RECORD 前把 `DACP-ID`/`Active-Remote` 带对。工作量中等，**第一阶段可不做**。

---

## 8. 版本矩阵：什么设备走哪条路

| 设备类型 | mDNS 特征 | TuneBlade 实际路径 | 能否出声（推断依据） |
|---|---|---|---|
| AirPort Express (802.11n/802.11g) | `_raop._tcp`，`et=0`（或 0,1），`pw` 可 true | 明文 RAOP；需要密码时走 Digest | ✅ 标准路径（`et=0` 无 RSA → 不加密） |
| Apple TV 2/3 | `am=AppleTV3,1`、`et=0,3,5`、`sf=0x4`、`vs=150.35` | 明文 RAOP，`MaxLatency=154350` | ✅ 有真实 trace 证据（`trace.txt`） |
| shairport-sync / XBMC / Kodi / 第三方 RAOP | `am` 含 SHAIRPORT/XBMC/KODI 或无 `am` | 明文 RAOP（`IsOpenSource()` 识别，`AirplayDevice.cs:2744-2782`） | ✅ 标准路径 |
| macOS "AirPlay 接收器"（Monterey+）/ iOS | `_raop._tcp` 通常带 `et=0,3,5` 或 `0,1` + `sf` 含 `0x200`（视版本/设置） | 若 `sf&0x200` 走 pair-setup-pin/verify 后明文 RAOP | ⚠️ 视系统版本/安全设置而定：允许 AirPlay 1 老客户端时能出声，强制 HAP 时不行 |
| Apple TV 4/4K/mini | `sf&0x200` | 配对后明文 RAOP | ⚠️ 老 tvOS 可，新 tvOS 需 HAP 加密会话 → ❌ |
| HomePod / HomePod mini | AirPlay 2，需 pair-setup-pin + pair-verify + **HAP 加密 RTSP/音频** | 只有配对、没有 HAP 会话 | ❌ 不出声 |
| 手动添加设备 | 无 mDNS | 用户选 `encryption=true/false`、`isAppleTV4OrAbove` | 看情况：encryption=true → 固定密钥加密分支（基本不可用）；false → 明文 |

判定逻辑落点：
- `IsAppleTV` 只看 TXT `am` 是否含 `APPLETV`（`AirplayDevice.cs:2862-2875`）→ 影响 `MaxLatency`、`IsShairPort()`（`:3132-3140`）等。
- 是否配对只看 `sf & 0x200`（`:3070-3091`）或手动勾选。
- 是否加密只看 `et & 1`（`:3142-3160`）。
- 注意：**没有** `_airplay._tcp` / `features` 位解析，也没有 HAP 会话，所以 HomePod 类设备即使配对成功也停在明文 RTSP。

---

## 9. 与 AirPlay2（HAP）的差距 —— 为什么 HomePod 不行

要实现 HomePod / 新版 Apple TV / 强制 HAP 的 mac 出声，需要补齐 TuneBlade 缺的全部内容：

1. **发现**：浏览 `_airplay._tcp`（deviceid、features、flags、pk、pi、srcvers），按 `features` 位判定 AirPlay2 能力。
2. **配对**：pair-setup-pin（SRP）→ pair-verify（X25519 + Ed25519）→ 由 sharedSecret 派生 HAP 会话密钥（`Pair-Verify` 的 AES key/IV 之后还要按 HAP 规范做 `HAP` 加密）。
3. **加密会话**：所有 RTSP 请求/响应走 `POST /command`（或带加密帧）的 HAP 通道；音频 RTP 载荷用 **ChaCha20-Poly1305**（每帧 nonce = 计数器，AAD 含 RTP 头信息）。
4. **音频**：AirPlay2 接收端还要 `SETUP` 里带 `streams` plist（`type=96`、`ct=2`(ALAC)、`spf=352`、`sr=44100` 等）与 `timing_port/control_port` 的 plist 结构；RECORD 走 plist。
5. 以上在 TuneBlade 中**完全没有**（证据：全仓库 `grep -r "ChaCha\|Poly1305\|HAP\|LTSK"` 零命中；`DeviceVerificationHandler.IsSecurityModeAcceptable()` 直接返回 false，`:153-156`）。

**建议**：Zilux2 分两阶段——第一阶段做经典 RAOP（本文 §1-§7，覆盖 mac/AirPort/Apple TV 3/shairport-sync），第二阶段单独做 AirPlay2/HAP（可参考 shairport-sync 的 airplay2 实现、pyatv 的 HAP 实现思路，不要基于 TuneBlade）。

---

## 10. 常量速查表

| 名称 | 值 | 位置 |
|---|---|---|
| audio/control/timing 本地端口基数 | 6001 / 6002 / 6003（各试 500 个） | `AudioSource.cs:801-807` |
| 默认接收端 audio 端口 | 6000（SETUP 无 `server_port` 时） | `AirplayDevice.cs:1466-1474` |
| 采样率/声道/位深 | 44100 / 2 / 16 | `AudioSource.cs:63-67` |
| ALAC 每包帧数 | 352 | `AudioSource.cs:69`、`:794` |
| 每包 PCM 字节 | 1408 | `AudioSource.cs:73` |
| RTP 包最大长度 | 1444（其中 ALAC ≤1428） | `AudioSource.cs:77-83` |
| RTP 包 seq/timestamp 增量 | +1 / +352 | `AudioSource.cs:1588`、`:1535` |
| SSRC | 874812771 (0x34249563) | `AudioSource.cs:1574` |
| PayloadType | 音频 96、Sync 84、TimingReq 82、TimingResp 83、ResendReq 85、ResendResp 86 | `AirTunesCommon/PayloadType.cs` |
| 加密类型枚举 | None=1,RSA=2,FairPlay=4,MFiSAP=8,FairPlaySAP2.5=0x10 | `AirplayDevice.cs:136-143` |
| `et` 映射 | 0=None,1=RSA,3=FairPlay,4=MFiSAP,5=FPSAP2.5 | `AirplayDevice.cs:2962-2979` |
| `sf` 配对位 | 0x200 需配对；0x8 每次配对码；0x80 密码 | `AirplayDevice.cs:3070-3091` |
| 保活间隔 | 15 s（OPTIONS） | `AudioSource.cs:902-906` |
| Sync 间隔 | 1 s | `AudioSource.cs:837` |
| Sync 包的 rtpNext 补偿 | -882 采样 | `AudioSource.cs:913` |
| 默认 audioLatency | 8500（<100 时） | `AirplayDevice.cs:754-764` |
| MaxLatency | AppleTV 154350；其他 2205000 | `AirplayDevice.cs:555-565` |
| 音量 dB 映射 | 0%→-144；100%→-0.001；否则 -30×(100-x)/100 | `AirplayDevice.cs:3106-3117` |
| 固定 AES key | `0BA0D6B09206D214F8D59AF09FABBB15` | `AudioSource.cs:762-766` |
| 固定 IV | `307C0D006043C807F4F5CB51412DA8C2` | `AudioSource.cs:767-771` |
| 手动设备 auth-setup body | 33 字节常量 `01 4E EA D0 … A3 49` | `AirplayDevice.cs:1779-1785` |
| userAgent / clientInstance | `TuneBlade/1.0 (Windows)` / `56B6CB929BB20486` | `AirplayDevice.cs:197-199` |
| RTSP resourceId | `3121287335`（常量） | `AirplayDevice.cs:181` |
| 默认 Read/CSeq 超时 | 30000 ms（TEARDOWN 2500） | `AirplayDevice.cs:2707-2708`、`:1751-1752` |
