# 里程碑 7：投送到 AirPlay 音响

> 2026-10-20 完成。目标：把 Windows 上的 Zilux2 播放声音直接投到苹果音响（AirPlay / HomePod）。
> 结果：**HomePod mini（AirTunes 980.77.2）实测出声、干净无杂音**，产品内「投送」面板可用（扫描 → 连接 → 播放/暂停/音量/断开）。
> 7.1 追加：**多台同时投送** —— 两台 HomePod mini 同时出声（共享 PTP 主时钟、单份采集/编码多路分发），面板可连续追加、单台停止、全部停止。
> 7.2 追加：**macOS「隔空播放接收器」** —— MacBook Pro 实测出声；该类设备拒绝瞬态配对，走 HAP **PIN 配对**（Mac 屏幕显示 4 位码，Zilux2 面板输入），首次配对后凭据落盘，之后再连免 PIN。可与 HomePod 同时投送。

## 1. 使用方式

1. 左侧栏点「投送」（AirPlay 图标）打开面板，或从设置里的「投送」区块进入。
2. 面板自动扫描局域网设备（mDNS `_raop._tcp` / `_airplay._tcp`），列出名字与型号。
3. 选一台设备 →「连接」；需要密码的设备会出现内联密码框。
4. 连接成功后，应用里播放的任何声音都会投到该设备（宿主采集系统默认输出设备的 loopback，不依赖前端播放器）。
5. 面板内可拖音量滑杆（0–100，映射到接收端 dB），可随时「断开」。
6. **多台同时投送**：投送中继续点其它设备的「投送」即追加（不替换）；已投送清单里可单台「停止」或「全部停止」，面板标题变为「已连接 N 台设备」。多台共享同一份采集/编码与同一个 PTP 主时钟，包时间线一致，因此同步播放。
7. **投到 Mac**：连接 macOS「隔空播放接收器」时，Mac 屏幕会弹出 4 位配对码，面板出现「Mac 配对码」输入框；填入即开始投送。首次配对成功后凭据保存在 `%LOCALAPPDATA%\Zilux2\airplay\pairing\<host>.hap`，之后连接不再询问（Mac 侧撤销配对后会重新要码）。

无宿主（浏览器直开）时投送面板为禁用态并提示。

## 2. 架构

```
WASAPI loopback (48k/2ch)                        ┌─ AirPlay 2 (HomePod / ATV / mac)
  → StereoResampler (Blackman-sinc 44.1k)        │   HAP 瞬态配对 → 加密 RTSP
  → 16-bit interleaved PCM                       │   两段式 SETUP → PTP 主时钟 + sync
  → encode (ALAC escape / L16)                   │   ChaCha20-Poly1305 RTP + 重传
  → 定速 sender 125 包/秒 ───────────────────────┤
                                                 └─ 经典 RAOP (AirPort Express / ATV3 …)
                                                     RTSP OPTIONS→ANNOUNCE→SETUP→RECORD
                                                     AES-128-CBC 音频 + Sync/Timing/Resend
```

| 文件 | 作用 |
| --- | --- |
| `src/Zilux2/AirPlay/AirPlayService.cs` | 状态机（idle/scanning/connecting/streaming/error）、连接编排、AP2 优先 + RAOP 回退、错误码（passwordRequired/unsupported/busy/network/capture/internal） |
| `src/Zilux2/AirPlay/IDeviceDiscovery.cs` | 发现抽象（`IAirPlayDeviceDiscovery` / `AirPlayDeviceInfo`） |
| `src/Zilux2/AirPlay/Discovery/` | 零依赖 mDNS：`MdnsProbe`（224.0.0.251 + ff02::fb、逐网卡 join）、`MdnsMessage`（DNS 编解码/压缩指针/TTL）、`AirPlayDiscovery`（PTR→SRV→TXT→A 归并、TTL 缓存、goodbye） |
| `src/Zilux2/AirPlay/Protocol/` | 经典 RAOP：`RaopConnection`（RTSP 会话 + RTP + Sync/Timing/Resend）、`RaopPackets`、`RtspTransport`（含 Digest 鉴权） |
| `src/Zilux2/AirPlay/Ap2/` | AirPlay 2：`Ap2Connection`（加密 RTSP + 两段 SETUP + 音频 + 重传）、`Ap2Pairing`、`HapEncryptedTransport`、`Bplist`、`Ap2Setup`、`Ap2AudioPacket`、`Ap2Sync`、`Ap2Feedback`、`Ap2PtpMaster`、`Ap2PtpLink` |
| `src/Zilux2/AirPlay/Crypto/` | HAP：`SrpClient`（SRP-3072/SHA-512）、`HapTlv8`、`HapPairing`、`HapSessionCrypt`、`Ed25519`、`X25519`、`HapKeyDerivation` |
| `src/Zilux2/AirPlay/Audio/` | `AirPlayStreamer`（采集线程 + 定速发送线程）、`StereoResampler`、`AlacAudioEncoder`（经典 RAOP 用压缩 ALAC）、`Ap2UncompressedAlacEncoder`（AP2 用未压缩 escape 帧）、`PcmLittleEndianEncoder`、`Ap2AudioConnection`（AP2 ↔ `IAirPlayConnection` 适配） |
| `src/Zilux2/AirPlay/Alac/` | 纯托管 ALAC 编解码器（RFC 参考实现 clean-room C# 版，820 帧 bit-exact 自测） |
| `src/Zilux2/_devtest/airplay/` | 进程内自测：mock RAOP 接收端（32 断言）+ mock AirPlay 2 接收端（63 断言，含重传） |

## 3. 协议实现要点（关键坑）

### 3.1 发现
- 只读 TXT/SRV，不依赖 Bonjour；SRV 端口通常是 7000（不是 5000）。
- `md=` 是元数据类型、不是型号；型号取 AirPlay TXT 的 `model`。
- `vv=1` / `srcvers≥130` 视为支持 AirPlay 2。

### 3.2 HAP 瞬态配对（无需 PIN 输入）
- `POST /pair-setup`，TLV8：`Method=0, State=1, Flags=0x10`（transient）→ 设备回 `State=2 + Salt(16) + PublicKey B(384)`。
- SRP-3072 / SHA-512 / g=5；M3 回 `PublicKey A(384, 自动分片) + Proof(64)`，M4 校验设备 proof（`H(A|M1|K)`）。
- 瞬态配对**没有 pair-verify**：shared secret = SRP 会话密钥 K（64 B）。
- 之后整条 TCP 字节流加密：`[2B LE len][ChaCha20-Poly1305 密文][16B tag]`，AAD=长度字段，nonce=`4×00 + 8B LE counter`；Control 通道密钥 = HKDF(K, "Control-Salt", "Control-Write/Read-Encryption-Key")，事件通道方向相反。

### 3.3 AirPlay 2 会话
- 顺序：配对 → 加密 `GET /info` → **SETUP#1（会话级，无 streams，含 `timingPeerInfo`/`timingPeerList`）** → 读回 `eventPort` → 连事件通道 → `RECORD`（空 body）→ **SETUP#2（root 只有 streams）** → 读回 `dataPort`/`controlPort` → 发音频。
- 每个请求带 `CSeq`、`User-Agent`、`DACP-ID`、`Active-Remote`、`Client-Instance`；SETUP 额外 `X-Apple-StreamID: 1`。RTSP URI = `rtsp://<本机IP>/<sessionId>`，**sessionId 同时是 RTP SSRC**。
- **PTP 是 phase2 SETUP 的前提**：`timingProtocol="NTP"` 时 HomePod 对流 SETUP 零响应；改 `PTP` 后同连接立即 200。
- 接收端是 **PTP master**：HomePod 主动往本机 UDP 319 发 Sync、320 发 Follow_Up/Announce/Delay_Resp。Zilux2 反过来当 **PTP master**：绑定 319/320，125 ms 发 Sync(→设备:319)/Follow_Up(→设备:320)，1 s 发 Announce，并应答 Delay_Req/Pdelay_Req；`clockId` 随机 63 位，写进 SETUP#1 的 `timingPeerInfo.ClockID`。
- 控制通道每秒（实现为 100 ms）发 sync 包：PTP 模式 28 B（`0x90/0x80, 0xD7, 0, 6, rtp, nowNs(8B Unix ns), rtp-latency, clockId(8B)`）；NTP 模式 20 B（`0xD4`、序号 7）。
- 音频包：12 B RTP 头（`0x80, first?0xE0:0x60, seq BE, ts BE, ssrc BE`）+ ChaCha20-Poly1305（key = shared secret 前 32 B、AAD = header[4..12]、8 B 计数器 nonce）+ 16 B tag + 8 B nonce。
- 音频载荷：**未压缩 ALAC（escape 帧）**。接收端无视 `ct`/`audioFormat` 按 ALAC 解码；`ct=1`+PCM 会出声但全是杂音。escape 帧 1412 B（1408 采样 + 25 bit 头尾），格式：`CPE(1) | 0(4) | 0(12) | hasSize=0 | 0(2) | isNotCompressed=1 | 352×{L16,R16} | END(7) | 补零`。
- 重传：接收端发 8 B `0x55` 请求（起始 seq@4、count@6），发送端回 `[0x80, 0xD6, seq BE] + 原包`；保留最近 1024 包。

### 3.4 经典 RAOP
- 握手五连：OPTIONS `*` → ANNOUNCE（SDP `AppleLossless`，`a=fmtp:96 352 0 16 40 10 14 2 255 0 0 44100`）→ SETUP（带本机 control/timing 端口）→ RECORD（`RTP-Info: seq;rtptime`）→ SET_PARAMETER 音量。
- 音频包：12 B RTP 头 + ALAC 负载，发往设备 SETUP 返回的 `server_port`（默认 6000）；Sync（20 B，1 s）、Timing（32 B 应答）、Resend（8 B 请求/`0x86` 响应）。
- 音量：`dB = -30 × (100 − percent) / 100`，0 % = −144。

### 3.5 实时性
- **必须定速发送**：接收端按 125 包/秒（352 帧/包）消费，突发或间隙都会造成卡顿/杂音。`AirPlayStreamer` 用绝对 deadline（`start + index × 352/44100 s`）+ 补静音，采集线程只负责填环形缓冲。
- Windows 上 `Thread.Sleep(8)` 实际约 15.6 ms，不能用睡眠节拍当发送时钟。
- 接收端缓冲：**300 ms**（`latencyMin=latencyMax=13230` 帧）。120 ms 时偶发杂音，300 ms 干净。

### 3.6 多台同时投送（7.1）
- 采集与编码只做一份：`AirPlayStreamer` 在一个发送循环里编码一次，把同一份加密音频包分发给所有接收端；每台设备各自保持自己的 AP2 会话（配对、加密 RTSP、事件通道、SETUP/RECORD、重传）。
- **PTP 主时钟全局共享**（`Ap2SharedPtp`）：进程内只起一个 PTP master（UDP 319/320），按引用计数复用，所有接收端拿到同一个 `clockId` 与同一时间域；否则第二条连接会因 319/320 端口冲突拿不到时钟。
- `SETPEERS` 里上报全部接收端 IP + 本机 IP（先上报首台，其余设备接入时再更新）。
- 某台中途断开时只移除该接收端，其余继续；连续发送失败约 0.4 s（50 包）判定掉线并 teardown 该台，全部掉线才报错。
- 契约：`host event=airplay` 的 `payload.actives`（数组）+ `action:"disconnect"` 可选 `deviceId`（带=停单台，不带=全停）；音量仍为全局值。

### 3.7 macOS 接收端（7.2）
- macOS 26「隔空播放接收器」的 `/pair-setup` 对**瞬态** M1 返回 `HTTP 470 Connection Authorization Required`（HomePod 相反，只接受瞬态），必须走 HAP 长期配对：
  1. `POST /pair-pin-start`（`X-Apple-HKP: 3`）→ Mac 屏幕显示 4 位 PIN；
  2. `POST /pair-setup`（M1 不带 Flags，`X-Apple-HKP: 3`）→ M2（Salt + B 384 B）→ 用户输入 PIN → M3/M4；
  3. `POST /pair-verify`（Ed25519 + X25519）→ 得到 Control 通道密钥；
  4. 同一条 TCP 字节流切 HAP 加密，继续 `GET /info` / 两段 SETUP / RECORD（与 HomePod 同一套代码）。
- **失败重试坑**：macOS 有时忽略直接压在 RTSP 配对 socket 上的 `pair-pin-start`（读超时，随后 pair-setup 返回 200 但 0 字节）。修法是先单独用一条 HTTP 连接 `POST /pair-pin-start`（与 curl 同形）把配对窗口“叫醒”，再在配对 socket 上跑 `pair-setup`（`Ap2Pairing.PrimePinStartAsync`）。
- **凭据持久化**：`HapCredentials` 序列化到 `%LOCALAPPDATA%\Zilux2\airplay\pairing\<host>.hap`；后续连接先 `pair-verify`（无提示），失败或被撤销才重新 PIN 配对。
- 契约：连接中推 `{"state":"connecting","code":"pinRequired","error":"请在 Mac 屏幕上查看配对码并输入"}`，页面回 `{"action":"pin","deviceId":"<id>","value":"1234"}`；等待 120 s 超时回 `code:"network"`。

## 4. 验证

| 项 | 结果 |
| --- | --- |
| `dotnet build src/Zilux2/Zilux2.csproj` | 0 warning 0 error |
| `ZILUX2_AIRPLAY_SELFTEST=1`（进程内 mock RAOP） | 32/32 PASS |
| AP2 mock 自测（反射加载真实 dll） | 63/63 PASS（含重传） |
| 真机 HomePod mini ×2（黑色pod 192.168.31.136 / 白色pod 192.168.31.183） | 配对、加密、两段 SETUP、事件通道、音频 125 包/秒、音量、FLUSH、TEARDOWN 全通 |
| 用户听感（产品 UI 端到端，单台） | **「响了，干净无杂音」** |
| 多台同时投送（产品 UI，两台 HomePod mini） | 面板「已连接 2 台设备」、单台/全部停止正常；用户听感 **「两台同时出声、面板也对」** |
| 共享 PTP（raop-re 真机双设备 25s） | 单 master `refs=2 peers=2`、两台各 3125 包 ≈124.9 包/秒、SETUP 均 200 |
| 多设备音频（Lead harness `ap2multi`，22s） | `frames=2771 receivers=2 underruns=1`，无 ConnectionLost、不断连 |
| macOS 接收端（MacBook Pro 192.168.31.233，macOS 26） | HAP PIN 配对（PIN 8795/7989/1701 三次实测）→ 加密握手 → ALAC 30 s：`frames=3780`（≈126 包/秒）、0 编码失败、不断连；凭据落盘后再次连接 pair-verify 免 PIN（`frames=376`/8 s 无提示） |
| 用户听感（Mac，harness 产品链路） | **「有声音，正常」** |
| 用户听感（产品 UI，14 秒连 白色pod+Mac+黑色pod 三台） | **「Mac 有声，正常」**（日志 `receivers=3`） |

## 5. 已知限制

- **macOS 接收端**：需要开启「隔空播放接收器」（系统设置 → 通用 → 隔空播放与接力）；首次连接需要在 Mac 屏幕读 4 位配对码填入面板。锁屏/未开启时 RTSP 直返 403（不是协议问题）。macOS 对配对有节流，短时间内反复配对可能无响应，等一会儿再试。
- **需要 AirPlay 2 的设备**（HomePod / 新 Apple TV / macOS 26 接收器）只能走 AP2；不支持 AP2 的老设备走经典 RAOP。
- 目前只投「系统默认输出设备」的声音（WASAPI loopback），未做单应用捕获。
- 音量滑杆控制的是接收端音量；本机静音不影响投送内容。
- 音频为实时采集转码，端到端延迟约 300–500 ms（音画同步只对本应用内的可视化有意义）。
- **多台同时投送**：所有设备播同一份内容（系统默认输出），音量为全局统一值；实测 2 台，更多台未验证（每台独立 AP2 会话，带宽/CPU 随台数线性增长）。单台失败只影响该台，其余继续。

## 6. 来源与许可说明

- 协议知识来源：① TuneBlade 1.30 反编译源码（`research/airplay/tuneblade-decomp/`，仅用于学习报文格式）；② 公开文档与开源实现的**语义参考**：pyatv（MIT）、shairport-sync、AirFlash（GPLv3，仅阅读其 Rust 源码提取协议字段与常量，未复制任何代码）；③ 真机抓包与实测日志。
- Zilux2 中的实现全部为自行编写（C#），未包含上述项目的源码拷贝。ALAC 编解码器依据 Apple 公开的 ALAC 格式文档与传统 RFC 重新实现。
