# AirPlay 2 SETUP 静态复核（task-9）

> 复核对象：`src/Zilux2/AirPlay/Ap2/`（raop-re 写作用域，只读）。
> 复核目标：解释真机失败 `AirPlay 2 SETUP rtsp://192.168.31.41/9468287064 read failed: Unable to read data from the transport connection`（HomePod mini .183，瞬态配对成功、加密 OPTIONS 200、SETUP 无响应且连接被对端关闭），并给出可直接落地的修改建议。
> 复核方式：纯离线，对照 pyatv master 快照（`research/airplay/_ref/pyatv-*.py`）与 shairport-sync 接收端源码（`research/airplay/_ref/shairport-src/`）。**未连接真机**（避免配对限流）。

---

## 0. 结论速览

**最可能的根因（P0）：我方只发了一段「合并体」SETUP，而 AirPlay 2 的音频 SETUP 是两段式。**

1. **P0-1 两段式 SETUP 缺失**：第一阶段 SETUP 的 plist 里**不能有 `streams`**（只放 `timingProtocol/timingPort/deviceID/sessionUUID/name/model/...`），响应给出 `eventPort`；第二阶段 SETUP 的 plist 里**只能有 `streams`**（音频参数全部在 `streams[0]` 内），响应给出 `streams[0].dataPort/controlPort`。
   我方 `Ap2Connection.Handshake()`（`src/Zilux2/AirPlay/Ap2/Ap2Connection.cs:185`）在 `:205-228` 只发一次 SETUP，body 由 `Ap2Setup.BuildBody()`（`src/Zilux2/AirPlay/Ap2/Ap2Setup.cs:88`）生成，把 `streams` 与 `timingProtocol/latencyMin/latencyMax/isMedia/controlPort/timingPort/deviceID` 全部塞在同一个 root 里。对端（HomePod）在协议层看到「带 streams 但会话/事件/时序通道尚未建立」的非法请求，直接断开 TCP——这与日志中 `read failed / Unable to read data`（对端关闭，而非单纯超时）吻合。
2. **P0-2 每个 RTSP 请求缺 3 个必需头**：pyatv 对**每一个** RTSP 请求都发 `DACP-ID`（64 位十六进制）、`Active-Remote`（32 位十进制）、`Client-Instance`（=DACP-ID），我方 `HapEncryptedTransport.Send()` 只自动加了 `CSeq`，`Ap2Connection.CommonHeaders()` 只给 `User-Agent`（`Ap2Connection.cs:445`）。
3. **P0-3 事件通道（event channel）未建立**：第一阶段 SETUP 响应里的 `eventPort` 必须由发送端主动 TCP 连上去，并用 HAP 帧加密（密钥用 pair 共享密钥派生，Events-Salt，读/写方向相反）——pyatv 在发第二阶段 SETUP 之前就完成这一步。我方完全没连 `eventPort`。

其余为 P1/P2（顺序、头部细节、body 字段、RECORD/FLUSH 序列），见第 4 节差异清单。

**给 raop-re 的一句话**：把 SETUP 拆成两段（先建会话+事件通道，再挂音频流），每请求补 DACP-ID/Active-Remote/Client-Instance，第二段 body 完全照 `pyatv-protocols-airplayv2.py:127-147` 抄。除此之外我方配对与 HAP 加密通道已由真机证明可用（加密 OPTIONS/GET /info 均 200），**不要动配对/加密层**。

---

## 1. 权威依据（本地快照）

| 依据 | 文件（`research/airplay/_ref/`） | 关键位置 |
| --- | --- | --- |
| AP2 音频 SETUP 的发送端实现 | `pyatv-protocols-airplayv2.py` | `_setup_base` :51-105（第一阶段）、`setup()` :107-110、`setup_audio_stream` :112-156（第二阶段）、`send_audio_packet` :183-208 |
| 流控编排（顺序） | `pyatv-raop-stream_client.py` | `initialize()` :287-338（建本地 UDP 端口→GET /info→按需 auth-setup→protocol.setup）、`send_audio` :375-453（feedback→RECORD→FLUSH→发音频） |
| RTSP 请求构造 / 头部 / URI | `pyatv-support-rtsp.py` | 常量 :23-24、`uri` :91-94、`info()` :101-110、`auth_setup()` :112-123、`setup()` :170-176、`exchange()` 基头 :254-302（CSeq/DACP-ID/Active-Remote/Client-Instance） |
| 事件/数据通道的 HAP 加密 | `pyatv-auth-hap_channel.py` | `setup_channel` :79-104（`out_key, in_key = verifier.encryption_keys(salt, output_info, input_info)`） |
| 通道内部协议（事件通道收 HTTP 请求并回 200） | `pyatv-protocols-airplay-channels.py` | `BaseEventChannel` / `EventChannel.handle_received` :30-105 |
| 接收端两段式 SETUP 语义 | `shairport-src/rtsp.c` | `handle_setup_2` :2345 起（无 `streams` → 初始阶段；有 `streams` → 第二阶段，`ct`/`spf`/`sr`/`shk`、`type` 96/103、响应字段） |
| 接收端不实现 `/auth-setup` | `shairport-src/` | grep 无 `/auth-setup` 处理分支 |

> 注：task-9 任务书提到的「pyatv `stream_client.py` 里 `_setup_audio_stream`/`_setup_control_stream`」在 pyatv master 的 `airplay/` 目录中不存在；对应实现是 `protocols/raop/protocols/airplayv2.py` 的 `_setup_base()` + `setup_audio_stream()`。`airplay/ap2_session.py` 是「遥控会话」的通道建立（`isRemoteControlOnly` + type 130 数据通道），可作通道框架参考，但与音频 SETUP 不是同一条路径。

---

## 2. 正确的 AP2 音频握手序（pyatv 实际顺序，瞬态配对场景）

```
1. TCP connect <device>:7000
2. POST /pair-setup            (transient TLV8, PIN=3939；我方已验证 PASS)
3. 启用 HAP 加密（整条 TCP 字节流；密钥 = HKDF(SRP K, "Control-Salt", Control-Read/Write-Encryption-Key)）
   —— 瞬态配对没有 pair-verify，也不需要 pair-verify（pyatv hap_transient：verify_credentials() 直接 True，
      加密密钥由 SRP K 派生）。我方现状正确。
4. GET /info                   (pyatv stream_client.py:330，固定先拿设备信息；可解析 features/model)
5. [仅当设备是 AirPort + 支持 MFiSAP 时] POST /auth-setup   (0x01 + 32B 静态 Curve25519 公钥)
6. SETUP #1（无 streams）      → 200 + plist {eventPort}
7. TCP connect <device>:<eventPort>，HAP 加密，Events 密钥（读/写 info 与发送端方向相反）
8. SETUP #2（只有 streams）    → 200 + plist {streams:[{dataPort, controlPort, ...}]}
9. UDP 音频 socket connect <device>:<dataPort>；UDP 控制/时序 socket 已就绪
10. POST /feedback 每 2s（keep-alive，我方已有 Ap2Feedback）
11. RECORD（裸请求，不带 Session/Range/RTP-Info）
12. FLUSH（带 Range: npt=0-、Session: <session_id>、RTP-Info: seq=...;rtptime=...）
13. UDP 发 AP2 音频包（shk 加密；我方 Ap2AudioPacket 布局已对）
```

### 2.1 SETUP #1 的 body（逐字段照抄 pyatv `airplayv2.py:56-74`）

```python
{
  "deviceID": "AA:BB:CC:DD:EE:FF",          # 我方 DeviceId 即可
  "sessionUUID": "<uuid4 大写>",             # 每次连接新生成
  "timingPort": <本机 UDP timing 端口>,       # = 我方 LocalTimingPort
  "timingProtocol": "NTP",
  "isMultiSelectAirPlay": True,
  "groupContainsGroupLeader": False,
  "macAddress": "AA:BB:CC:DD:EE:FF",
  "model": "iPhone14,3",
  "name": "pyatv",                          # 发送端名称（可自定义，如 "Zilux2"）
  "osBuildVersion": "20F66",
  "osName": "iPhone OS",
  "osVersion": "16.5",
  "senderSupportsRelay": False,
  "sourceVersion": "690.7.1",
  "statsCollectionEnabled": False,
}
```

- **绝对不能**带 `streams` 键。
- 响应：`Content-Type: application/x-apple-binary-plist`，body 解析出 **`eventPort`**（int）。
- `timingPort` 必须是**本机**已打开的 UDP 端口（接收端会往这里发 NTP 时序包）。

### 2.2 事件通道（SETUP #1 与 #2 之间）

pyatv `airplayv2.py:88-96`：

```python
setup_channel(EventChannel, verifier, remote_ip, event_port,
              "Events-Salt", EVENTS_READ_INFO, EVENTS_WRITE_INFO)
# setup_channel 内部：out_key, in_key = verifier.encryption_keys(salt, output_info, input_info)
#   EVENTS_READ_INFO  = "Events-Read-Encryption-Key"
#   EVENTS_WRITE_INFO = "Events-Write-Encryption-Key"
```

即：TCP 连 `eventPort`，HAP 帧（2B LE len + 密文 + 16B tag，AAD=长度字段，nonce=4×0+8B LE counter）加解密；**发送方向用 Write 密钥，接收方向用 Read 密钥**（与主连接方向相反，因为连接由接收端发起）。接收端会在该通道上发 HTTP 请求（如音量/状态事件），发送端回 200（`channels.py` 的 `EventChannel.handle_received`），回包时带 `CSeq`/`Server`/`Content-Length: 0`/`Audio-Latency: 0`。

注意：HomePod 的 eventPort 通常立刻可连；pyatv 对第三方接收端做了 5 次重试（连接被拒时 sleep 1s），可照抄该容错。

### 2.3 SETUP #2 的 body（逐字段照抄 pyatv `airplayv2.py:127-147`）

```python
{
  "streams": [{
    "audioFormat": 0x800,          # PCM；ALAC 建议先不用（见 P2-1）
    "audioMode": "default",
    "controlPort": <本机 UDP control 端口>,   # = 我方 LocalControlPort
    "ct": 1,                       # 1=PCM(L16)，2=ALAC（pyatv 走 1）
    "isMedia": True,
    "latencyMax": 88200,
    "latencyMin": 11025,
    "shk": <32 字节 bytes，binary data>,      # 音频包 ChaCha20-Poly1305 的 key
    "spf": 352,
    "sr": 44100,
    "type": 0x60,                  # 96 = realtime
    "supportsDynamicStreamID": False,
    "streamConnectionID": <RTSP session id>,  # = URI 里的那个十进制 id（pyatv rtsp.session_id）
  }]
}
```

- **root 只有 `streams` 一个键**。`timingProtocol/latencyMin/latencyMax/isMedia/controlPort/timingPort/deviceID` 全部不在这段（`isMedia/latencyMin/latencyMax/controlPort` 在 stream 内）。
- `shk` 可以是**任意随机 32 字节**：pyatv 源码注释明确「it doesn't really matter what the key is (could be hardcoded) as it's merely a security feature」（`airplayv2.py:117-121`）。我方「随机 `_audioKey`」不依赖配对密钥，成立。
- 响应：plist `{streams:[{type, dataPort, controlPort, ...}]}`；音频 UDP 目标端口 = `streams[0].dataPort`。
- 我方 `Ap2Setup.ParseResponse` 已能解析 `streams[].dataPort/controlPort/audioPort` 与 root `servicePort`（`Ap2Setup.cs:160-188`），可复用。

---

## 3. 我方现状（读过的代码位置）

| 位置 | 现状 |
| --- | --- |
| `Ap2Connection.cs:185 Handshake()` | `OPTIONS *`（:197）→ **单段 SETUP**（:205-228）→ 解析（:232）→ 取响应 `Session` 头（:233）→ UDP 连 dataPort（:245）→ 后台 DrainUdp |
| `Ap2Connection.cs:205-214` | `Ap2Setup.BuildBody` 一次性传入 AudioKey/ControlPort/TimingPort/Latency/ct/DeviceId |
| `Ap2Connection.cs:217-218` | `_sessionUri = rtsp://{Target.Host 或本地 IP}/{10 位随机数}`；`UseLocalRtspUri` 默认 `false` |
| `Ap2Connection.cs:219, 255-276` | `SendAuthSetup()`：**无条件** POST `/auth-setup`，body=33B（`0x01` + 随机 X25519 公钥） |
| `Ap2Connection.cs:445 CommonHeaders()` | 仅 `User-Agent`；CSeq 由 `HapEncryptedTransport.Send` 自动加 |
| `Ap2Setup.cs:88-131 BuildBody` | root = `{streams:[{type,ct,spf,sr,shk}], timingProtocol, latencyMin, latencyMax, isMedia}` + 可选 `controlPort/timingPort/deviceID` |
| `Ap2Setup.cs:133-156 BuildHeaders` | `Content-Type: application/x-apple-binary-plist` + `User-Agent` + 可选 `Session` |
| `Ap2Connection.cs:278-310 BeginStreaming` | RECORD 直接带 `Session` + `Range: npt=0-` + `RTP-Info`（:292-303），之后启动 feedback；**没有 FLUSH** |
| `Ap2AudioPacket.cs` | AP2 音频包布局/加密已按 shairport 权威实现（2B seq + 4B ts + 4B ssrc + 密文+tag + 8B nonce、AAD=ts+ssrc、key=shk），**保持不动** |

---

## 4. 差异清单（优先级 + 依据 + 建议）

### P0（不修基本不可能出声）

#### P0-1 SETUP 改成两段式
- **我方**：`Ap2Connection.cs:205-228` 一段合并 body。
- **依据**：`pyatv-protocols-airplayv2.py:51-74`（阶段1，无 streams）与 `:112-156`（阶段2，只有 streams）；`shairport-src/rtsp.c` `handle_setup_2`（阶段1 只认 `timingProtocol`/`isRemoteControlOnly`/`name`，阶段2 才读 `streams[0].shk/ct/spf/sr`，且要求先有阶段1）。
- **建议**：
  1. `Ap2Setup` 新增 `BuildSessionBody(...)`（阶段1，字段见 §2.1）与 `BuildStreamBody(...)`（阶段2，字段见 §2.3）；保留现有 `BuildBody` 仅供旧测试。
  2. `Handshake()` 改为：`OPTIONS *` → `GET /info`（见 P1-1）→ `SETUP #1` → 解析 `eventPort` → 连事件通道（P0-3）→ `SETUP #2` → 解析 `streams[0]`。
  3. 两段都用**同一个** `_sessionUri`。
- **预期**：SETUP #1 若成功，设备会回 200 + `eventPort`，这在离线无法验证，但这是 HomePod/macOS 的通用两段式；若 #1 仍被关连接，再排查 P0-2/P1-2。

#### P0-2 每个 RTSP 请求补 `DACP-ID` / `Active-Remote` / `Client-Instance`
- **我方**：`HapEncryptedTransport.Send` 只加 `CSeq`；`Ap2Connection.CommonHeaders()` 仅 UA。
- **依据**：`pyatv-support-rtsp.py:265-273`（每个请求都带三项，`Client-Instance` 与 `DACP-ID` 同值）；shairport `handle_setup_2` 也在 SETUP 请求头里读 `Active-Remote`/`DACP-ID`。
- **建议**：连接建立时生成一次并存：`DacpId = Random 64-bit 大写十六进制`、`ActiveRemote = Random 32-bit 十进制`、`ClientInstance = DacpId`。放在 `CommonHeaders()` 里（或 `HapEncryptedTransport` 的固定头），对包括 OPTIONS/GET/SETUP/RECORD/FLUSH/SET_PARAMETER/TEARDOWN/feedback 在内的**所有**请求生效。
- **备注**：`CSeq` 从 0 或 1 开始递增均可（pyatv 从 0 开始，先发后增）。

#### P0-3 建立事件通道（event channel）
- **我方**：无。
- **依据**：`pyatv-protocols-airplayv2.py:78-105`（阶段1 响应取 `eventPort` 后立刻连）；`pyatv-auth-hap_channel.py:79-104`（Events-Salt + Read/Write 反序）；`pyatv-protocols-airplay-channels.py:30-105`（事件通道上收 HTTP 请求并回 200）。
- **建议**：
  1. `HapKeyDerivation` 已有 `DeriveEventKeys(sharedSecret)`；在 `Ap2Connection` 里用 `HapSessionCrypt` 建事件通道（注意方向：**发送用 Write key、接收用 Read key**，与主连接相反）。
  2. 事件通道收到的字节流按 HTTP 请求解析（`METHOD path HTTP/1.1` + headers + 可选 body），逐条回 `200 OK` + `Content-Length: 0` + `Audio-Latency: 0` + 回显 `CSeq`/`Server`；这是接收端（HomePod）发音量/状态事件的通道，不回包可能被判为异常。
  3. 连接失败重试（5 次 × 1s）以兼容非 Apple 接收端。
- **备注**：这一步依赖 `HapPairing.TransientAsync` 暴露的 `SharedSecret`；`HapVerifyResult.SharedSecret` 已有。

### P1（很可能影响设备是否接受会话）

#### P1-1 SETUP 前先 `GET /info`
- **我方**：只发 `OPTIONS *`，无 `/info`。
- **依据**：`pyatv-raop-stream_client.py:330`：`initialize()` 在建好本地端口后**固定**先 `await self.rtsp.info()`，然后才 setup。`/info` 返回 `features/model/vv` 等，pyatv 用它决定要不要 auth-setup。
- **建议**：加密通道建立后、`OPTIONS` 前后加 `GET /info`（加密通道上发，我方 PairProbe 已验证加密 GET /info 200）；解析 bplist 取 `features`（uint64，et 位）、`model`、`vv`。失败不阻塞（pyatv `allow_error=True`）。
- **说明**：`OPTIONS *` 是否必需未知——pyatv 不发 OPTIONS 也能工作；保留无害（真机已验证 200）。

#### P1-2 `/auth-setup` 不应无条件发送
- **我方**：`Ap2Options.SendAuthSetup` 默认 `true`，`SendAuthSetup()` 在 SETUP 前无条件 POST（body 33B = `0x01` + 随机 X25519 公钥，`Ap2Connection.cs:255-276`）。
- **依据**：`pyatv-support-rtsp.py:38-49`：`AUTH_SETUP_UNENCRYPTED = b"\x01"`（首字节 **0x01** 表示「希望明文」，不是 0x02），后面跟的是**固定** 32 字节 Curve25519 公钥（抄自 owntone）；`pyatv-raop-stream_client.py:353-363`：**仅当** 设备支持 MFiSAP（`et` 含 4）**且** `model` 以 `"AirPort"` 开头才发。
- **建议**：
  1. 默认改为「按设备决定」：`GET /info` 返回 `features` 后判断 `et&4`，或 `model` 前缀 AirPort；HomePod/macOS 走 **skip**。
  2. 若保留，body 首字节必须是 `0x01`（我方已对），并建议改用固定公钥（`pyatv` 那份来自 owntone 的 32B），不要每次随机；失败只 warn。
  3. 目标顺序：`/info` → （按需）`/auth-setup` → SETUP #1。
- **风险**：向 HomePod 发一个它没预期的 `/auth-setup`，可能被当作 MFi 流程开始、进而使后续 SETUP 被拒。这是仅次于 P0-1 的嫌疑项，建议先关掉再测。

#### P1-3 URI host 与 session id 形态
- **我方**：`rtsp://{Target.Host 或 localAddress}/{10 位随机数}`（`Ap2Connection.cs:217-218`，`UseLocalRtspUri=false` 默认）；session id 范围 1e9..1e10-1。
- **依据**：`pyatv-support-rtsp.py:91-94`：`uri = f"rtsp://{connection.local_ip}/{session_id}"`，`session_id = randrange(2**32)`（即 0..4294967295 的十进制，位数不定）；并且 `streamConnectionID` 用的就是 `rtsp.session_id`（`airplayv2.py:143`）。
- **建议**：
  1. URI host 用**本机（发送端）IP**（与 pyatv 一致；真机日志里 `rtsp://192.168.31.41/...` 恰好是本机 IP，说明当前实际配置可能已开 `UseLocalRtspUri`，请确认）。
  2. session id 用 `uint32` 十进制随机数，并**复用**为：URI path、`streamConnectionID`、以及后续 `Session:` 头的值。
  3. 我方现在 `SessionId` 取自 SETUP **响应头** `Session`（`:233`），这不是 Apple 发送端的做法（pyatv 不用响应 Session；AP1 才从 SETUP 响应 `Session` 头取，见 `airplayv1.py:71`）。建议改为使用自己的 session id 作为 `Session` 头（RECORD/FLUSH/TEARDOWN/SET_PARAMETER 均用它），响应头值仅作参考/记录。
- **优先级说明**：这项未必导致连接关闭，但和 `streamConnectionID` 语义绑定，属「一次改对省一轮联调」。

### P2（协议细节，设备可能容忍但按官方实现更稳）

#### P2-1 音频编码从 ALAC 改 PCM（先跑通）
- **我方**：`Ap2Connection` 用 `_options.UseAlac` 决定 `ct`（默认 `UseAlac=true` → `ct=2/ALAC`）；`Ap2AudioPacket` 只负责打包，payload 由上层给。
- **依据**：`airplayv2.py:131-144`：pyatv 用 `audioFormat: 0x800, ct: 1`（PCM L16），`spf: 352, sr: 44100`；`research/airplay/protocol/ap2-flow.md` §3.2 也建议 MVP 先用 PCM。
- **建议**：第一版音频流先用 `ct=1` + `audioFormat=0x800`（与 pyatv 完全一致），ALAC 作为后续优化；同时确认 `IAirPlayConnection.SendAudioFrame` 的 payload 语义（PCM → L16 大端/小端）与 `Ap2AudioPacket` 打包一致。

#### P2-2 第二阶段 body 去掉 root 上的多余键
- 见 P0-1：`timingProtocol/latencyMin/latencyMax/isMedia/controlPort/timingPort/deviceID` 不应出现在第二阶段 root；`isMedia/latencyMin/latencyMax/controlPort` 放进 stream；`deviceID/sessionUUID/timingPort/timingProtocol` 只出现在阶段1。
- 依据 `airplayv2.py:127-147` 与 shairport `handle_setup_2` 的读取顺序（shairport 只在阶段1 读 timing/name，在阶段2 读 streams）。
- 另建议补 pyatv 有而我方缺的 stream 字段：`audioFormat: 0x800`、`audioMode: "default"`、`supportsDynamicStreamID: false`、`streamConnectionID: <session id>`。

#### P2-3 RECORD / FLUSH 序列对齐 pyatv
- **我方**：`BeginStreaming()` 发 RECORD 时直接带 `Session` + `Range: npt=0-` + `RTP-Info`（`Ap2Connection.cs:292-303`），之后启动 feedback；**不发 FLUSH**。
- **依据**：`pyatv-raop-stream_client.py:438-448`：先 `rtsp.record()`（**无额外头**），再 `rtsp.flush(headers={"Range": "npt=0-", "Session": rtsp_session, "RTP-Info": "seq=...;rtptime=..."})`。
- **建议**：RECORD 保持裸请求（仅通用头）；把 Range/Session/RTP-Info 移到紧随其后的 FLUSH；随后开始发音频。`/feedback` 每 2s 保持（我方已有）。
- 备注：pyatv V2 路径下 `context.rtsp_session` 实际是默认 0（只有 AP1 从 SETUP 响应头赋值，见 `airplayv1.py:71`），所以 `Session: 0` 也可能被接受；但按 P1-3 用自己 session id 更符合语义。

#### P2-4 事件通道/时序通道的 UDP 收包
- 我方已建 `_controlSocket`/`_timingSocket` 并后台 DrainUdp（`Ap2Connection.cs:245-246`），方向正确；时序按 `timingProtocol: "NTP"` 时接收端会向 `timingPort` 发 NTP 包，音频时序可用 `RTP-Info.rtptime` 驱动。此项无需改，仅确认 DrainUdp 不阻塞。

### P3（低风险/信息项）

- **P3-1 `X-Apple-ProtocolVersion: 1` / `X-Apple-Session-ID` / `X-Apple-Stream-ID`**：pyatv 只在 `POST /play`（URL 播放）路径用这三头（`airplayv2.py:27-33`），RTSP 会话路径不用。**我方不需要加**，不必为它改代码。
- **P3-2 HTTP/1.1 vs RTSP/1.0**：pyatv 正常 RTSP 用 `RTSP/1.0`，仅 `/auth-setup` 用 `HTTP/1.1`（`support/rtsp.py:23,112-123`）。我方 `HapEncryptedTransport.Send` 默认 `RTSP/1.0`、支持传 `HTTP/1.1`，正确；确认 `/auth-setup` 调用传的是 `HTTP/1.1`。
- **P3-3 响应解析**：`HapEncryptedTransport.ReadResponse` 只处理 `Content-Length`（无 chunked）。HomePod 的 `/info` 与 SETUP 响应在 PairProbe 中均为 Content-Length 正文，可接受；若后续遇到 chunked 再补。
- **P3-4 bplist 编码**：`Bplist.cs` 已覆盖 dict/array/data/byte[]/int/uint/long/ulong/bool/double/string（`:113-200` 段），`shk` 用 `byte[]` → data 正确、`isMedia` bool 正确，**无需改编码器**。
- **P3-5 重试/限流**：真机首次失败后立刻重试导致 pair-setup 也超时（设备限流/休眠）。联调时请间隔 ≥30s；我方 `Ap2Connection` 失败路径可加退避，但不在本次 SETUP 修复范围。

---

## 5. 为什么“连接被关闭”而不是“超时”更支持 P0-1

日志 `read failed: Unable to read data from the transport connection` 是 `HapEncryptedTransport.ReadMore()` 抛出的（`HapEncryptedTransport.cs:254-264`）：socket Read 返回 0 或抛 IOException，即**对端主动关闭连接**（若只是设备不回，Read 会阻塞到 ReceiveTimeout，表现为 timeout 而不是该消息）。设备在收到它认为非法的 SETUP 后关闭连接，符合「两段式协议缺第一阶段 + 请求体结构非法」的假设。

同时可排除的项：
- **加密/配对层**：瞬态配对 M1–M4 已 PASS，M4 proof 校验 PASS；同一加密通道上 `OPTIONS *` 与 `GET /info` 均 200 → HAP 帧/密钥/CDN 正确，不是加密问题。
- **bplist 编码器**：同一编码器若用于 OPTIONS（无 body）不能证明，但 SETUP body 里的类型（data/bool/int）编码器均支持；若编码器有问题，多半会表现为设备回 4xx 而不是直接关连接。
- **网络/端口**：OPTIONS 已在同一 TCP 上成功。

---

## 6. 建议的最小改动顺序（给 raop-re）

1. **第一刀（最可能直接见效）**：`Ap2Setup` 拆两段 body（§2.1/§2.3）+ `Ap2Connection.Handshake` 拆两段 SETUP（同一 `_sessionUri`）+ 每请求补 `DACP-ID/Active-Remote/Client-Instance`（`CommonHeaders()`）。
2. **第二刀**：`GET /info` 前置于 SETUP；`SendAuthSetup` 改为按 `features/model` 条件发送（HomePod 默认跳过）。
3. **第三刀**：事件通道（连 `eventPort`，Events 密钥、读写反序、回 200、5×1s 重试）。
4. **第四刀**：URI 用本机 IP + `uint32` session id，`Session` 头用自己的 session id；RECORD 裸发、Range/RTP-Info 移到 FLUSH。
5. **第五刀**：`ct=1` + `audioFormat=0x800` PCM 先出声，再考虑 ALAC。
6. 每刀后跑一次真机（间隔 ≥30s，避免配对限流）；`Ap2Connection` 已有 `_rtspHistory`，失败时把两段 SETUP 的状态码/响应头/body hex 打全，便于下一轮定位。

---

## 7. 附：pyatv 关键代码原文（供直接对照抄写）

### 7.1 阶段1（`pyatv-protocols-airplayv2.py:51-105`，节选）

```python
async def _setup_base(self, timing_server_port: int) -> None:
    self._verifier = await verify_connection(self.context.credentials, self.rtsp.connection)
    setup_resp = await self.rtsp.setup(body={
        "deviceID": "AA:BB:CC:DD:EE:FF",
        "sessionUUID": str(uuid4()).upper(),
        "timingPort": timing_server_port,
        "timingProtocol": "NTP",
        "isMultiSelectAirPlay": True,
        "groupContainsGroupLeader": False,
        "macAddress": "AA:BB:CC:DD:EE:FF",
        "model": "iPhone14,3",
        "name": "pyatv",
        "osBuildVersion": "20F66",
        "osName": "iPhone OS",
        "osVersion": "16.5",
        "senderSupportsRelay": False,
        "sourceVersion": "690.7.1",
        "statsCollectionEnabled": False,
    })
    resp = decode_bplist_from_body(setup_resp)
    event_port = resp.get("eventPort", 0)
    # ... 5 次重试连接 event_port ...
    transport, _ = await setup_channel(
        EventChannel, self._verifier, self.rtsp.connection.remote_ip, event_port,
        EVENTS_SALT, EVENTS_READ_INFO, EVENTS_WRITE_INFO)
```

### 7.2 阶段2（`pyatv-protocols-airplayv2.py:112-156`，节选）

```python
async def setup_audio_stream(self, control_client_port: int) -> None:
    # ... 注释：shk 可以随意（甚至硬编码），只是安全特性 ...
    out_key, _ = self._verifier.encryption_keys(EVENTS_SALT, EVENTS_WRITE_INFO, EVENTS_READ_INFO)
    shared_secret = out_key[0:32]
    setup_resp = await self.rtsp.setup(body={"streams": [{
        "audioFormat": 0x800, "audioMode": "default",
        "controlPort": control_client_port, "ct": 1, "isMedia": True,
        "latencyMax": 88200, "latencyMin": 11025, "shk": shared_secret,
        "spf": 352, "sr": 44100, "type": 0x60,
        "supportsDynamicStreamID": False,
        "streamConnectionID": self.rtsp.session_id,
    }]})
    resp = decode_bplist_from_body(setup_resp)
    stream = resp["streams"][0]
    self.context.control_port = stream["controlPort"]
    self.context.server_port = stream["dataPort"]
    self._cipher = Chacha20Cipher8byteNonce(shared_secret, shared_secret)
```

### 7.3 每请求通用头（`pyatv-support-rtsp.py:254-302`，节选）

```python
hdrs = {
    "CSeq": cseq,                    # 0,1,2... 每请求 +1
    "DACP-ID": self.dacp_id,         # randrange(2**64) 的十六进制（大写）
    "Active-Remote": self.active_remote,  # randrange(2**32) 十进制
    "Client-Instance": self.dacp_id,
}
# ... send_and_receive(..., user_agent="AirPlay/550.10", protocol="RTSP/1.0")
# ... body 为 dict 时：Content-Type = "application/x-apple-binary-plist" + bplist 序列化
```

### 7.4 流控顺序（`pyatv-raop-stream_client.py:330-338, 438-448`，节选）

```python
self._info.update(await self.rtsp.info())          # 1) GET /info
if self._requires_auth_setup:                      # 2) 仅 AirPort/MFiSAP
    await self.rtsp.auth_setup()
await self._protocol.setup(self.timing_server.port, self.control_client.port)  # 3) SETUP 两段
...
await self.rtsp.record()                           # 4) RECORD（裸）
await self.rtsp.flush(headers={                    # 5) FLUSH
    "Range": "npt=0-",
    "Session": self.context.rtsp_session,
    "RTP-Info": f"seq={self.context.rtpseq};rtptime={self.context.rtptime}",
})
```

---

## 8. 复核边界与未验证项

- 未连接真机：所有结论基于 pyatv（发送端，AirPlay2 音频 SETUP 的已知可用实现）与 shairport-sync（接收端，两段式语义）两份源码；HomePod 的具体校验行为仍需真机确认。
- 未覆盖：`/feedback` 响应内容、AP2 遥控（`ap2_session.py` 的 type 130 数据通道）、`/play` URL 播放路径（本项目走本地音频流，用不到）。
- 我方加密/配对层（`src/Zilux2/AirPlay/Crypto/`）经真机瞬态配对 + 加密通道验证通过，**本次复核未发现需要改动的点**；唯一可优化是事件通道密钥使用方式（`HapKeyDerivation.DeriveEventKeys` 已提供，直接调用即可）。
