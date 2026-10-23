# Zilux2 AirPlay 加密与配对模块

> 交付范围：经典 RAOP(AirPlay 1) 的 AES/RSA 加密 + AirPlay 2(HAP) 的配对与通道加密。
> 全部实现位于 `src/Zilux2/AirPlay/Crypto/`（8 个 .cs，**零 NuGet 依赖**，只用 .NET 10 BCL），
> 测试向量 harness 位于 `research/airplay/crypto/harness/`（30/30 PASS），真机验证探针位于 `harness/PairProbe/`。

最后更新：2026-10-20 06:20 (+08:00)

---

## 1. 结论速览（TL;DR）

| 项目 | 状态 | 证据 |
| --- | --- | --- |
| RFC 测试向量 harness | **30 PASS / 0 FAIL** | 见 §8 完整输出 |
| 真机瞬态配对（HomePod mini `192.168.31.183:7000`） | **通过**：M1→M2→M3→**M4 设备 proof 校验 PASS** | 见 §7 |
| HAP 加密通道 | **通过**：加密 `GET /info` 返回 200 + 合法 bplist | 见 §7 |
| 主工程 `dotnet build src/Zilux2/Zilux2.csproj` | **0 error / 0 warning** | §10 |
| 新增 NuGet 包 / 改 csproj | **无**（未动任何 csproj/其它目录） | §10 |
| 经典 RAOP 加密（AES-128-CBC + rsaaeskey + Apple-Challenge） | 已实现+向量验证；但本机 3 台设备均为 AirPlay2 强制 HAP，未实机使用 | §5、§9 |

**一句话**：用户的 HomePod mini 只能走 **AirPlay 2 瞬态 HAP 配对（无需 PIN）**，配对后整条 RTSP/TCP 字节流用 HAP 帧加密；代码已在该设备上端到端验证。

---

## 2. 文件清单

### 2.1 主工程源码：`src/Zilux2/AirPlay/Crypto/`

| 文件 | 职责 |
| --- | --- |
| `CryptoPrimitives.cs` | 内部公共底座：SHA-1/SHA-512/HKDF-SHA512、hex/base64（含无填充与容错）、大端 BigInt 字节工具、常量时间比较、随机数 |
| `X25519.cs` | 纯托管 X25519（RFC 7748，BigInteger Montgomery ladder），用于 pair-verify 临时 ECDH |
| `Ed25519.cs` | 纯托管 Ed25519（RFC 8032）签名/验签/公钥派生，用于 HAP 长期身份（LTSK/LTPK）与 pair-verify 签名 |
| `HapTlv8.cs` | HAP TLV8 编解码（自动 255 字节分片/合并）、State 状态机校验、错误码映射、`HapPairingException` |
| `SrpClient.cs` | SRP-6a 客户端：HAP 模式（3072 位/g=5/SHA-512/user=`Pair-Setup`）与旧式 Apple 模式（2048 位/g=2/SHA-1，K=H(S‖0)‖H(S‖1)） |
| `HapPairing.cs` | HAP 配对状态机：`pair-setup`(M1–M6，PIN 异步注入)、`pair-verify`(M1–M4)、`transient`(M1–M4 免 PIN)、`HapCredentials` 持久化、委托化传输层 |
| `HapSessionCrypt.cs` | HAP 通道加密：`HapKeyDerivation`（Control/Events/DataStream 密钥派生）+ 流式加解密帧（2B LE 长度 + ChaCha20-Poly1305 + 16B tag） |
| `RaopCrypto.cs` | 经典 RAOP：AES-128-CBC 音频包加密（只加密 16 整倍数、尾部明文、每包 IV 重置）、`rsaaeskey` RSA-OAEP-SHA1 包装、Apple-Challenge/Apple-Response、设备公钥（`pk` TXT）解析与内置 AirPort Express 公钥 |

### 2.2 测试与工具：`research/airplay/crypto/`

```
harness/
  Harness.csproj        # 独立 console 工程，用 <Compile Include> 链接主工程 Crypto/*.cs（可访问 internal）
  Program.cs            # 注册全部测试组，支持按关键字过滤
  TestRunner.cs         # PASS/FAIL 打印、合计、失败退出码 1
  Tests_Curve.cs        # X25519 / Ed25519 / hash / hex
  Tests_Misc.cs         # 通用工具
  Tests_Crypto.cs       # TLV8 / SRP / HAP 帧 / ChaCha20 / HKDF / AES-CBC / RAOP / RSA-OAEP / 真机 KAT
  PairProbe/            # 真机配对探针（raw TcpClient + HTTP/1.1 keep-alive，支持加密后字节流）
    PairProbe.csproj
    Program.cs
_ref/
  ae-private.pem        # 从 shairport-sync 提取的 AirPort Express 私钥（仅用于验证 AE 公钥/向量，不参与产品代码）
  extract-ae-key.sh     # 提取脚本
  AeKeyDump/            # 一次性证据程序：证明 RSAAES_Str = RSA-OAEP(SHA-1) 封装、导出 AE 公钥
  srp-groups.txt        # RFC 5054 组 hex（从 srptools 提取）
  rfc5054.txt / rfc8439.txt   # RFC 原文（测试向量来源）
  tuneblade-rsaaes-*.txt      # TuneBlade 硬编码证据
```

---

## 3. 协议依据（都来自源码级证据，不是猜测）

### 3.1 AirPlay 2 HAP 配对

参考实现（本机已落盘）：`research/airplay/_ref/pair_ap/`（shairport-sync 的 pair_ap 子模块）、
`research/airplay/_ref/pyatv-*.py`（pyatv 的 HAP/AirPlay 配对实现）、`_ref/shairport-src/`（shairport-sync master）。

| 事实 | 证据 |
| --- | --- |
| `pair-setup` / `pair-verify` / `pair-pin-start` 端点、`Content-Type: application/octet-stream`、TLV8 body | `_ref/shairport-src/rtsp.c`（`handle_pair_setup`/`handle_pair_verify`）、pyatv `ap/hap.py` |
| 请求头 `User-Agent: AirPlay/320.20`、`X-Apple-HKP: 3`（普通）/`4`（瞬态）、`Connection: keep-alive` | pyatv `ap/hap.py`；HomePod 对自定义 UA 返回 403（实测） |
| SRP：user=`Pair-Setup`、3072 位组 g=5、SHA-512、K=SHA-512(S) | `pair_ap/pair_homekit.c`（`USERNAME "Pair-Setup"`、`SRP_NG_3072`）、pyatv `hap_srp.py`、srptools 源码 |
| SRP 证明：x=H(s‖H(I:P))、k=H(N‖PAD(g))、u=H(PAD(A)‖PAD(B))、M1=H(H(N)⊕H(g)‖H(I)‖s‖A‖B‖K)、M2=H(A‖M1‖K) | srptools `client.py`/`common.py`；RFC 5054 |
| M5 签名：`info = HKDF(K,"Pair-Setup-Controller-Sign-Salt","Pair-Setup-Controller-Sign-Info") ‖ client_id ‖ client_ltpk`，Ed25519 签名后连同 `Identifier`/`PublicKey` 放进 `EncryptedData`（nonce 4×0x00+`PS-Msg05`） | `pair_ap/pair_homekit.c:1102/1116/1128`；pyatv `hap_srp.py step3` |
| M6 验签：`info = HKDF(K,"Pair-Setup-Accessory-Sign-Salt","Pair-Setup-Accessory-Sign-Info") ‖ accessory_id ‖ accessory_ltpk`，nonce `PS-Msg06` | `pair_homekit.c:1620/1636`；pyatv `step4`（pyatv 本身未校验，我们实现了校验） |
| pair-verify：M2 验签 `info = server_eph_pub ‖ accessory_id ‖ client_eph_pub`（nonce `PV-Msg02`）；M3 签名 `info = client_eph_pub ‖ client_id ‖ server_eph_pub`（nonce `PV-Msg03`） | `pair_homekit.c:1157`、pyatv `ap/hap.py verify1/verify2` |
| 通道密钥：`HKDF-SHA512(shared,"Control-Salt","Control-Write-Encryption-Key"/"Control-Read-Encryption-Key")`，Events/DataStream 同构 | `pair_ap/pair_homekit.c` 密钥表；pyatv `auth/__init__.py` |
| 瞬态配对：`X-Apple-HKP: 4`、PIN=`3939`、M1 加 `Flags=0x10`、M1–M4 结束**没有** pair-verify，直接以 SRP K 作 shared secret 派生控制密钥 | pyatv `ap/hap_transient.py`（`TRANSIENT_PIN=3939`） |
| HAP 加密帧：明文每帧 ≤1024B；`[2B 小端长度][ChaCha20-Poly1305 密文][16B tag]`，AAD=那 2 字节长度，nonce=4×0x00+8B 小端计数器（每帧 +1，读写方向独立） | `pair_ap/pair_homekit.c:2993-3120`；pyatv `auth/hap_session.py` |

> 注：`EncryptedData` 的 nonce 是「4 个 0x00 + 8 字节 ASCII 消息名」（共 12B），等价于把 8 字节消息名前置补零。

### 3.2 经典 RAOP（AirPlay 1）

| 事实 | 证据 |
| --- | --- |
| 音频负载：每包只加密 `len & ~0xF` 字节（AES-128-CBC/NoPadding），尾部余数字节明文，每包 IV 重置为同一 `aesiv` | shairport-sync `player.c:1588-1615`；TuneBlade `AudioSource.cs`（逐包 `CreateEncryptor(Key,IV)`） |
| `rsaaeskey` = RSA-OAEP(**SHA-1**) 包装 16 字节 AES key；`aesiv` 为 base64 | shairport-sync `common.c`（`PSA_ALG_RSA_OAEP(PSA_ALG_SHA_1)`）+ 本文 §9 一次性验证 |
| ANNOUNCE 中 `a=rsaaeskey:` 与 `a=aesiv:` 同时存在才表示加密；`et=0` 不加密、`et=1` RSA | nto.github.io/AirPlay.html；shairport-sync `rtsp.c` |
| `Apple-Challenge` = 16 字节随机数 base64（去 `=`）；`Apple-Response` = 对 `challenge ‖ 客户端 IP(4/16B) ‖ ap1_prefix(6B)` 的 RSA PKCS#1 v1.5 + SHA-1 签名 | shairport-sync `common.c:809-885`、`rtsp.c:3648-3703` |
| AirPort Express 固定 RSA-2048 公钥可用于 OAEP 加密 `rsaaeskey`（TuneBlade 的硬编码值即该密钥的预计算结果） | shairport-sync `common.c` 内嵌 AE 私钥 → 导出公钥；§9 验证 |

---

## 4. 三条加密路径与选择逻辑

```
设备 TXT / ET 判定
├── AirPlay 2（vv=1 / 设备支持 HAP 且明文 OPTIONS 返回 403）
│   ├── 首次/需要身份：POST /pair-pin-start → 设备显示 PIN → HapPairing.SetupAsync(pinProvider)
│   │       → 得到 HapCredentials（LTPK/LTSK/client_id 持久化）→ HapPairing.VerifyAsync → 控制密钥
│   └── 免 PIN/临时（HomePod mini 实测可用）：HapPairing.TransientAsync → 控制密钥
│       两种方式之后都用 HapSessionCrypt 对整条 RTSP/TCP 字节流加解密
└── 经典 RAOP（AirPlay 1，et=0 或 et=1）
    ├── et=0：不加密（本机设备均不可用，仅保留能力）
    └── et=1：RaopCrypto.CreateEncryptionInfo(pkTxt) → ANNOUNCE 带 rsaaeskey/aesiv
             + Apple-Challenge；音频包用 info.EncryptAudioPacketInPlace(...)
```

---

## 5. 给 Lead / raop-re 的集成说明

### 5.1 AirPlay 2：瞬态配对（HomePod mini 实测路径，推荐先接这条）

```csharp
using Zilux2.AirPlay.Crypto;

// transport 由调用方实现：在同一条 TCP 连接上发一条 HTTP 请求并读回响应。
// 普通配对/验证阶段是明文 HTTP；拿到 session 后调用方需自己用 HapSessionCrypt 包住收发。
HapPairingTransport transport = async (method, path, headers, body, ct) =>
{
    await conn.SendHttpAsync(method, path, headers, body, ct);   // 自定义
    return await conn.ReadHttpResponseAsync(ct);                 // 返回 HapHttpResponse
};

HapVerifyResult verify = await HapPairing.TransientAsync(transport, ct, trace: Console.WriteLine);
// verify.SharedSecret / ControllerWriteKey(32B) / ControllerReadKey(32B)

HapSessionCrypt session = verify.CreateControlSession();
byte[] cipher = session.Encrypt(plainHttpBytes);          // 任意长度，内部按 1024B 分帧
byte[] plain  = session.Decrypt(incomingCipherBytes);    // 流式：可能返回空数组，继续喂后续字节
```

要点：
- `HapPairing.BuildHeaders(HapPairing.HkpTransient)` 已含 `User-Agent: AirPlay/320.20`、`Connection: keep-alive`、`X-Apple-HKP: 4`、`Content-Type: application/octet-stream`、`Accept: */*`。**不要改 User-Agent**，HomePod 对自定义 UA 返回 403。
- 瞬态配对**没有** `pair-verify`：shared secret 就是 SRP K（64B），直接 HKDF 派生控制密钥。后续 RTSP 请求/响应（包括 OPTIONS/SETUP/ANNOUNCE/RECORD 与事件通道）全部走 `HapSessionCrypt`。
- `HapSessionCrypt` 是**字节流级**的：Encrypt 输入的明文可以跨 HTTP 消息边界；Decrypt 是流式缓冲的（凑不满一帧时返回空数组，`BufferedCiphertextLength` 可查剩余字节）。
- 首次正常配对后请保存 `credentials.ToBase64()`；下次直接 `HapCredentials.FromBase64(...)` + `HapPairing.VerifyAsync`（免 PIN）。PIN 输入用 `Func<CancellationToken, Task<string>> pinProvider` 异步等待 UI/控制台输入。

### 5.2 AirPlay 2：普通 PIN 配对（首次，需设备显示 PIN）

```csharp
var cred = await HapPairing.SetupAsync(transport,
    async ct => await ui.ShowPinDialogAsync(ct),   // 4 位数字，去掉空白
    ct, trace: Console.WriteLine);
string store = cred.ToBase64();                    // 持久化
// 下次：
var cred2 = HapCredentials.FromBase64(store);
var v = await HapPairing.VerifyAsync(transport, cred2, ct);
```

注意：`SetupAsync` 内部已先调 `/pair-pin-start` 让设备显示 PIN（失败不致命），
M4 会校验设备 `Proof`（失败抛 `HapPairingException(AuthenticationError)`），M6 会用设备 LTPK 校验签名。

### 5.3 经典 RAOP（仅作后备/旧设备）

```csharp
var info = RaopCrypto.CreateEncryptionInfo(devicePkTxt);   // devicePkTxt = mDNS TXT 里 "pk"（可空）
// ANNOUNCE 的 SDP 里追加：
//     a=rsaaeskey:<info.RsaaesKeyBase64>
//     a=aesiv:<info.AesIvBase64>
// 或直接用 info.SdpEncryptionAttributes（已带 CRLF 结尾）
// Apple-Challenge：ANNOUNCE 里加 "Apple-Challenge: " + RaopCrypto.GenerateAppleChallengeHeader()
// 音频包（16 字节 RTP 头 + ALAC payload）：
info.EncryptAudioPacketInPlace(packet, payloadOffset: 16, payloadLength); // 原地加密，返回加密字节数
```

---

## 6. 关键细节（实现笔记）

### 6.1 HAP 加密帧

```
明文 → 分帧（每帧 ≤ 1024B）：
  帧 = u16le(明文长度) ‖ ChaCha20-Poly1305-IETF(key, nonce, plaintext, aad=u16le(明文长度)) ‖ 16B tag
  nonce(12B) = 00 00 00 00 ‖ u64le(counter)；发送方向 counter 从 0 每帧 +1
```
接收方向独立计数。缓冲式解密：按 `u16le` 长度读帧、凑不齐继续等数据；长度 >1024 或认证失败抛 `CryptographicException`。

### 6.2 SRP 两种语义（易错点）

| | HAP 模式 | 旧式 Apple 模式 |
| --- | --- | --- |
| 组 | RFC 5054 3072 位，g=5 | RFC 5054 2048 位，g=2 |
| 哈希 | SHA-512 | SHA-1 |
| 用户名 | `Pair-Setup`（固定） | client_id 的十六进制大写字符串 |
| 会话密钥 K | `SHA512(S)`（64B，S 取最小大端字节） | `SHA1(S‖00000000) ‖ SHA1(S‖00000001)`（40B） |
| M1 中的 K | 原始 64B | 转 BigInteger 后的最小字节（BouncyCastle/TuneBlade 语义，见 SrpClient 注释） |

`SrpClient` 的 `PublicKey`/`ClientProof` 均为**最小大端**（无前导零），`SessionKey` 为 K 原始字节。
RFC 5054 附录 B 的 1024 位/SHA-1 向量已用来验证 `k/x/A/u/S`（A 与 S 完全一致）。

### 6.3 经典 RAOP 音频包布局

TuneBlade/shairport 的包帧（本模块不负责 RTP 头生成，只做 payload 加密）：

```
[0..4)   retransmit/预留（TuneBlade 中前 4 字节，明文）
[4..16)  RTP 头 12 字节（明文）
[16..)   ALAC payload → AES-128-CBC 只加密其中 (len & ~0xF) 字节，剩余尾部明文
```

`RaopCrypto.EncryptAudioPayloadInPlace(packet, payloadOffset, payloadLength, key, iv)` 的 `payloadOffset/payloadLength` 由调用方按实际布局传入（经典布局是 offset=16）。

---

## 7. 真机验证证据（HomePod mini，2026-10-20）

探针：`research/airplay/crypto/harness/PairProbe`（同一条 TCP 长连接，明文 → 切换加密）
运行：`cd research/airplay/crypto/harness/PairProbe && dotnet run -c Release -- 192.168.31.183 7000`

```
[0] 明文 GET /info            → 200, 2151B (application/x-apple-binary-plist, Server: AirTunes/980.77.2)
[1] POST /pair-pin-start      → 200, 0B
[2] M1 = TLV{Method=0,State=1,Flags=0x10}            (hex 000100060101130110)
    M2 → 200, 409B TLV{State=2, Salt=16B, PublicKey=384B(B)}
[3] SRP-6a(HAP/3072/SHA-512, PIN=3939) → A(384B), M1 proof(64B)
[4] M3 = TLV{State=3, PublicKey=A, Proof=M1}  (A 跨 255B 分片：06 01 03 / 03 FF.. / 03 81.. / 04 40..)
    M4 → 200, 69B TLV{State=4, Proof=64B}
    设备 Proof 校验 (M2 = H(A‖M1‖K))            → PASS ✅
[5] K = SHA512(S) → HKDF("Control-Salt","Control-Write/Read-Encryption-Key") 得到 32B 密钥
[6] 启用 HapSessionCrypt 后加密 GET /info
    → 200, 2151B，解密后为合法 bplist（bplist00…，含 vv/protocolVersion 等键）  ✅
```

实测得到的关键值（已固化为 harness 测试 [21] 的 KAT）：

```
SRP K    = A1074C496563AC1CEA5996A102E1AD477F5C6536B67565F13D823212EBF9000699A079BADA3714356867E4F785BE919FBC84B6BFDAB0832643F2F121A284777D
writeKey = E1AECA67A7A4BE46B4745076C879B9C3AF8DDD4809706EDC4CF94A5686EE5D44
readKey  = 9D8C5F7EF8299A03338642F6F84EBF595C39689A724C336930533A9D31AA3F02
M4 proof = 611EFD377C629FB9BA833821FC7CF8662203F8F856655E8421B0A512E384417F23DDFC4FD37DC2E097F89AC7B26671DA13F1B17CC1797557AF5B67F9CA3359B9
```

失败/受限记录（不影响结论）：
- `192.168.31.233`（MacBook Pro，`AirTunes/980.77.5`）：明文 `GET /info` 200，但 `/pair-pin-start`、`/pair-setup`、`/pair-setup-pin` 全部 **403 Forbidden**（macOS 接收器的系统配对受限/需在系统设置里允许），未继续侵入尝试。
- `192.168.31.136`：连接超时（设备可能休眠），未尝试。
- 自定义 `User-Agent: Zilux2/1.0` 时 HomePod 直接 403；换成 `AirPlay/….` 或 `iTunes/….` 正常。

---

## 8. 测试向量结果（30/30 PASS）

运行方式：

```bash
cd research/airplay/crypto/harness
dotnet run -c Release              # 全量
dotnet run -c Release -- SRP       # 只跑名字含 SRP 的
```

实测输出（2026-10-20 06:17，.NET 10.0.12）：

```
[01] PASS  X25519 RFC 7748 §5.2 向量1（scalar mult）
[02] PASS  X25519 RFC 7748 §5.2 向量2（scalar mult）
[03] PASS  X25519 RFC 7748 §6.1 DH（alice/bob 公钥 + 共享密钥）
[04] PASS  Ed25519 RFC 8032 Test 1（空消息）
[05] PASS  Ed25519 RFC 8032 Test 2（1 字节消息）
[06] PASS  Ed25519 RFC 8032 Test 3（2 字节消息）
[07] PASS  Ed25519 RFC 8032 Test 4（64 字节 SHA-512(abc) 消息）
[08] PASS  Ed25519 反例：篡改签名/消息/公钥必须验签失败
[09] PASS  Ed25519 确定性签名（同输入两次结果一致）
[10] PASS  CryptoPrimitives：hex 往返 + 容错 base64
[11] PASS  CryptoPrimitives：BigInteger 大端无符号往返（0 → 空数组）
[12] PASS  HKDF-SHA512：与手写 RFC 5869 extract/expand 一致
[13] PASS  SHA-512(abc) 已知向量
[14] PASS  RFC 8439 §2.8.2：ChaCha20-Poly1305 AEAD 测试向量
[15] PASS  HAP 加密帧：2B 小端长度 + AAD=长度字段 + 计数器 nonce（已知答案）
[16] PASS  HAP 加密帧：>1024 字节分多帧、计数器递增、流式解密
[17] PASS  HAP 加密帧：密文被篡改必须抛 CryptographicException
[18] PASS  TLV8：编码/解码、384 字节自动分片与合并、状态与错误码
[19] PASS  SRP-6a RFC 5054 附录 B：k/x/A/u/S 与 1024 位组测试向量
[20] PASS  SRP-6a HAP：服务端独立复算 B/M1/M2 与客户端互验（3072 位/SHA-512）
[21] PASS  真机 KAT：HomePod 瞬态配对 K → Control-Read/Write 密钥
[22] PASS  HKDF-SHA512：与手写 RFC 5869 流程（HMAC 链）一致（含多块 >64B）
[23] PASS  AES-128-CBC：NIST SP 800-38A F.2.1 测试向量
[24] PASS  RAOP 音频负载：只加密 16 整倍数、尾部明文、头部不动、可解密还原
[25] PASS  RAOP 音频负载：每个包都用同一 IV 重置（不是链式延续）
[26] PASS  rsaaeskey：RSA-OAEP-SHA1 包装/解包 + pk 三种格式解析
[27] PASS  AirPort Express 公钥 + TuneBlade 硬编码 RSAAES_Str 解出固定 AES key
[28] PASS  Apple-Challenge：16B 随机 / base64 去填充 / PKCS#1 v1.5 SHA-1 验签
[29] PASS  HapCredentials：序列化/反序列化/Base64 往返与截断防护
[30] PASS  HapPairing：请求头（User-Agent / X-Apple-HKP / Content-Type）
--------------------------------------------------------
合计: 30 PASS, 0 FAIL（共 30 项）
结果: ALL PASS ✅
```

说明：
- RFC 5054 附录 B 本身**不提供** M1/M2 期望值，所以 [19] 校验的是 `k/x/A/u/S`（其中 A、S 为完整值比对）；
  而 [20] 用独立的服务端 BigInteger 实现复算 `B = k·v + g^b`、`M1`、`M2` 与客户端互验；**比 RFC 向量更硬的证据是 §7 真机 M4 proof 校验通过**。
- internal 成员（`SrpClient.ComputeMultiplier/ComputeX/ComputeU/HapPrime/HapGenerator`）之所以能在 harness 直接调用，是因为 harness 用 `<Compile Include>` 把源码编进同一程序集。

---

## 9. AirPort Express RSA / TuneBlade 硬编码证据（一次性，已固化进测试 [27]）

`_ref/AeKeyDump` 用 `_ref/ae-private.pem` 导入 2048 位 AE 私钥，并解密 TuneBlade 硬编码的 `rsaaeskey`：

```
KeySize=2048  Exponent=010001
AE 公钥 SPKI PEM 导出/再导入往返: True
RSAAES_Str: 342 chars（无 '=' 填充） -> 补 '=' 后 344 chars -> 256B
OAEP-SHA1        : OK -> 0BA0D6B09206D214F8D59AF09FABBB15
TuneBlade 固定 AES key = 0B A0 D6 B0 92 06 D2 14 F8 D5 9A F0 9F AB BB 15 → 一致: True
OAEP-SHA256      : 失败 (Unknown error (0xc100000d))
PKCS#1 v1.5      : 失败 (Unknown error (0xc100000d))
客户端 AE 公钥 OAEP-SHA1 加密 → 私钥解密往返: True（256B 密文）
```

结论：
1. 经典 RAOP 的 `rsaaeskey` 确定使用 **RSA-OAEP + SHA-1**（不是 SHA-256、不是 PKCS#1 v1.5）。
2. 产品代码 `RaopCrypto` 里只内嵌 **AE 公钥**（modulus + e=65537，注释已注明来源 shairport-sync），**不内嵌任何私钥**；
   `_ref/ae-private.pem` 仅用于测试/证据，不参与主工程构建（主工程只编译 `src/Zilux2/AirPlay/Crypto/*.cs`）。
3. TuneBlade 写死的 AES key/IV：
   - AES key = `0BA0D6B09206D214F8D59AF09FABBB15`
   - AES IV  = `307C0D006043C807F4F5CB51412DA8C2`

---

## 10. 依赖与构建

- **零第三方依赖**：只使用 .NET 10 BCL（`System.Security.Cryptography` 的 ChaCha20Poly1305/HKDF/AES/RSA、`System.Numerics.BigInteger`）。
- .NET 10 实测：`ChaCha20Poly1305`、`HKDF`、`AES`、`RSA` 可用；**没有** `X25519`/`Ed25519` 公开类型
  （`ECDiffieHellman` 的 `"curve25519"` friendly-name 是假曲线：导出的点 Y=0、无法导入任意公钥、与 RFC 7748 向量不符，已否决），
  因此 `X25519.cs` / `Ed25519.cs` 为纯托管实现（算法与 RFC 一致，已用 RFC 向量验证）。
- **未新增任何 NuGet 包、未修改任何 csproj**（主工程 csproj 保持原样；harness/PairProbe 是 research 下的独立工程）。
- 主工程构建：`dotnet build src/Zilux2/Zilux2.csproj -v q` → **0 Warning / 0 Error**（2026-10-20 06:19）。
- 代码风格：中文 XML 文档注释；不依赖 `System.IO`/`ImplicitUsings` 之外的隐式命名空间（本工程 ImplicitUsings 不含 System.IO，相关文件已显式 `using System.IO;`）。

---

## 11. 已知限制 / 后续

1. **普通 PIN 配对（pair-setup M1–M6）已完整实现但未真机联调**：本机 HomePod mini 用瞬态路径即可；
   若设备要求 PIN（如首次与 Apple TV 配对），则需真机跑一次 `SetupAsync` 验证 M5/M6 的签名/加密细节（代码按 pair_ap/pyatv 语义实现，M6 还做了 pyatv 未做的设备签名校验）。
2. **pair-verify（非瞬态）未真机联调**：需要先有 `HapCredentials`；逻辑与 pyatv/pair_ap 完全对齐，签名信息拼接顺序有源码行号依据（§3.1）。
3. **旧式 binary-plist 配对**（TuneBlade 的 `/pair-setup-pin` + `/verify`，M1–M5 plist 格式）：**未实现**。
   理由：本机 3 台设备全是 AirPlay 2（vv=1），它们用的是 TLV8 HAP；plist 路径仅旧 Apple TV/AirPlay1 设备用，
   且 `/pair-setup-pin` 在 HomePod 上返回 `Error=3`（被拒）。如后续需要可基于 `_ref/pyatv-auth-legacy.py` + TuneBlade `DeviceVerificationHandler.cs` 补。
4. **经典 RAOP 未实机验证**：设备 403 说明它们不接受明文 RAOP；`RaopCrypto` 仅作为旧设备后备与能力储备（向量/AE 证据齐全）。
5. HAP `Events`/`DataStream` 通道密钥派生已提供（`HapKeyDerivation.DeriveEventKeys/DeriveDataStreamKeys`），
   但事件通道（RTSP `GET /event`）的建链属于 RTSP 层（raop-re 的 `Ap2/`），不在本模块内。

## 12. 参考

- shairport-sync（master）：`_ref/shairport-src/`（`rtsp.c`/`player.c`/`common.c`）、`_ref/pair_ap/`
- pyatv：`_ref/pyatv-*.py`（`ap/hap.py`、`ap/hap_transient.py`、`hap_srp.py`、`auth/hap_session.py`、`auth/legacy.py`）
- srptools 0.2.0 源码：`research/airplay/_ref/srptools-src/`（SRP 语义与 RFC 5054 组）
- TuneBlade 1.30 反编译：`research/airplay/tuneblade-decomp/`（`AirPlaySRPClient.cs`、`DeviceVerificationHandler.cs`、`AirTunesCommon.Crypto/Crypto.cs`、`AudioSource.cs`）
- RFC 5054（SRP）、RFC 7748（X25519）、RFC 8032（Ed25519）、RFC 8439（ChaCha20-Poly1305）、RFC 5869（HKDF）、NIST SP 800-38A（AES-CBC）
- nto.github.io/AirPlay.html（RAOP 字段/端口/包类型）
