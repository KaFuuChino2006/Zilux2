# AirPlay 2 / HAP 配对与加密：TuneBlade 实证 + 开源实现字节级规格

> 作者：投送开发（2026-10-20）。配套文档：`raop-flow.md`（经典 RAOP 明文全流程）、`sharp-notes.md`（实现清单）、`self-test.md`（无硬件自测）。
>
> **本文解决的问题**：实测 macOS 26「隔空播放接收器」与 HomePod mini 对 TuneBlade 风格的 `OPTIONS *` 直接回 **403 Forbidden**（真机实测，Server: AirTunes/980.77.x，无 `WWW-Authenticate` 挑战头）。403 说明它们要求 **AirPlay 2（HAP）配对后的加密会话**，经典 RAOP 明文/密码分支无效。本文给出：
> 1. TuneBlade 反编译里的配对实现到底做了什么、为什么不能用于 HomePod/mac；
> 2. 标准 AirPlay 2 / HAP 的字节级配对与加密规格（可据实现）；
> 3. AP2 会话建立后 RTSP/音频包的具体封装；
> 4. 把现有 `RaopConnection` 改造成 AP2 的 C# 文件清单与工程量。
>
> 证据等级标签：【T】TuneBlade 反编译源码确证（`文件:行号`）；【P】pyatv 源码/文档确证（行号指 github master 的 `docs/documentation/protocols.md`，本地下载副本 1979 行，2026-10-20 抓取）；【S】shairport-sync（GPL，只阅读不抄代码）确证；【X】交叉验证（`../web/external-notes.md`，另一队友独立整理）；【推断】按代码逻辑推断，需实测。

---

## 0. 结论速览

| # | 结论 | 依据 |
|---|------|------|
| 1 | **TuneBlade 的配对不是 HAP**：body 用 binary plist（`{method:"pin",user}` / `{pk,proof}` / `{epk,authTag}`），SRP 用 **2048 位 + SHA-1**，pair-verify 用 **AES-CTR** 而不是 ChaCha20-Poly1305，且不校验对端 GCM tag。它是 **经典 AirPlay 1 的「PIN 配对」**，只对老设备（Apple TV 3 等）有意义。 | 【T】`Tuneblade/DeviceVerificationHandler.cs:95-151`、`Tuneblade/BinaryPlistConverter.cs:11-72`、`Tuneblade/AirPlaySRPClient.cs`（全 245 行，rfc5054_2048 + Sha1Digest） |
| 2 | 标准 AP2 用 **HAP TLV8**（不是 plist）：pair-setup-pin M1→M4（HomePod 瞬态 PIN=`3939`，可跳过 M5/M6），然后 pair-verify M1→M4（X25519 + Ed25519 签名），再 `POST /auth-setup`（33 字节），之后 **整条 RTSP TCP 被 HAP 帧加密**（ChaCha20-Poly1305-IETF）。 | 【P】`protocols.md:1525-1558`；【X】`../web/external-notes.md:96-237`；【P】`pyatv/auth/hap_tlv8.py:6-48`、`hap_srp.py`、`hap_session.py` |
| 3 | AP2 音频 RTP 与 AP1 **不是同一种包**：无 12 字节 RTP 头，而是 `[2B seq BE][4B ts BE][4B ssrc][ChaCha20 密文][16B tag][8B nonce]`，key = SETUP plist 的 `shk`，AAD = `ts+ssrc`（8 字节，不含 seq）。 | 【S】shairport-sync `rtp.c:1505-1568`；【X】`../web/external-notes.md:190-199` |
| 4 | AP2 的 SETUP body 是 **binary plist**（`Content-Type: application/x-apple-binary-plist`），关键键 `streams[].{type,ct,spf,sr,shk}.latencyMin=11025/latencyMax=88200/controlPort/timingProtocol="NTP"`；AP2 的 ANNOUNCE/RECORD 仍沿用 RAOP 那套，只是跑在加密通道里。 | 【X】`../web/external-notes.md:219-237`；【P】`protocols.md:1314`（AP1 SETUP 对照）、`protocols.md:1468-1505`（/auth-setup） |
| 5 | 纯音频投送 **不需要** event 通道和 data 通道（`type=130` remote-control 才需要），AP2 分支可只做 audio 流 + `/feedback` keep-alive，工程量大幅降低。 | 【X】`../web/external-notes.md:237`（依据 pyatv `airplayv2.py` 的 `_setup_remote_control` 条件分支）；【推断】 |
| 6 | 对现有代码：**RTSP 报文层（`RtspTransport.cs`）与音频发送节奏可保留**；需新增 `HapTlv`/`HapSrp`/`HapPairing`/`HapCipher`/`HapEncryptedStream`/`Ap2SetupPlist`/`Ap2AudioPacket` 七个模块，估算 1500–2200 行 C#，约 2–3 人日可跑通 loopback（无设备）。 | 见 §5；【推断】按本文 §2-§3 的字节规格 + 现有 `src/Zilux2/AirPlay/Protocol/` 结构估算 |

---

## 1. TuneBlade 配对实现实证（为什么它救不了 HomePod/macOS）

### 1.1 触发条件

- mDNS 只浏览 **`_raop._tcp`**，从不看 `_airplay._tcp`。【T】`Tuneblade/DeviceController.cs:485`（`ServiceBrowser.Browse(0u, IPv4, "_raop._tcp", "local")`）
- TXT 的 `sf` 位决定是否配对：`0x200`=需配对（`DeviceVerificationMode=FirstTimePassCode`）、`0x8`=每次要配对码、`0x80`=密码、其余不配。【T】`Tuneblade/AirplayDevice.cs:3070-3091`（`populateValuesFromTXTRecord` 的 `sf` 分支）
- 只支持 `DeviceVerificationMode.FirstTimePassCode`，其它模式直接报错；Apple TV 才走验证分支（`isAppleTV4OrAbove`）。【T】`AirplayDevice.cs:1087-1159`（`performDeviceVerification`，仅 `FirstTimePassCode` 可用，:1099 报错文案；:1109 用随机 MAC 当 ID；:1122/:1146 调 Handler）
- POST 封装：`POST /<request> RTSP/1.0` + `CSeq` + `User-Agent` + `Client-Instance` + `DACP-ID` + `Active-Remote`；有 body 时加 `Content-Type`/`Content-Length`；只接受 200。【T】`AirplayDevice.cs:1161-1206`（`Post`）

### 1.2 请求时序（6 个请求）

【T】`Tuneblade/DeviceVerificationHandler.cs`：

| # | 请求 | Content-Type | body | 行号 |
|---|------|------|------|------|
| 1 | `POST /pair-pin-start` | 无 | 空 | `:97` |
| 2 | `POST /pair-setup-pin` | `application/x-apple-binary-plist` | bplist `{method:"pin", user:<ID>}` | `:99-100`；编码 `BinaryPlistConverter.cs:11-31` |
| 3 | `POST /pair-setup-pin` | 同上 | bplist `{pk:A, proof:M1}` | `:103-104`；编码 `BinaryPlistConverter.cs:54-62` |
| 4 | `POST /pair-setup-pin` | 同上 | bplist `{epk, authTag}`（M5 数据） | `:114-123`；编码 `BinaryPlistConverter.cs:64-72` |
| 5 | `POST /pair-verify` | `application/octet-stream` | `[0,0,0,0]`? 否：`[1,0,0,0]` + 32B 本机 X25519 公钥 + 32B 长期 Ed25519 公钥 = 68B | `:135-136` |
| 6 | `POST /pair-verify` | `application/octet-stream` | `[0,0,0,0]` + 64B AES-CTR 加密的 Ed25519 签名 = 68B | `:144-146` |

响应解析：步骤 2 的响应是 bplist `{salt, pk}`；步骤 3 响应是 bplist `{proof}`；步骤 5 响应前 32 字节为对端 X25519 公钥，其余为密文。【T】`BinaryPlistConverter.cs:33-52`（`DecodePK`/`DecodeSalt`/`DecodeProof`）、`DeviceVerificationHandler.cs:137-141`。

### 1.3 SRP 参数（**经典 AirPlay 1 的 2048 位组**）

【T】`Tuneblade/AirPlaySRPClient.cs:100-116`：`Org.BouncyCastle.Crypto.Agreement.Srp.Srp6StandardGroups.rfc5054_2048`（2048 位 N）、`g=2`（RFC 5054 2048 组）、digest=`Sha1Digest`。
- `I = BigInteger(UTF8(UserID))`、`P = BigInteger(UTF8(PIN))`；`x = CalculateX`、`a` 随机、`A = g^a mod N`、`k/u = CalculateK/CalculateU`、`S = (B-k*g^x)^(u*x+a) mod N`。【T】`:136-147`
- `K_bytes = SHA1(S) || SHA1(S || {0,0,0,1})`（拼接后 BigInteger 转字节）。【T】`:160-177`
- `M1 = SHA1( H(N) xor H(g) || H(I) || salt || A || B || K )`，`M2 = SHA1(A || M1 || K)`。【T】`:179-207`、`:209-220`
- `VerifyServerProof(expected_m2)` 比对 M2。【T】`:232-244`

> 对比标准 HAP（§2.2）：**3072 位 N、g=5、SHA-512**。TuneBlade 的 2048/SHA-1 与 HomePod 不兼容——这是"不能直接改改用"的第二个硬证据。

### 1.4 pair-verify 实现（AES-CTR，不是 ChaCha）

【T】`DeviceVerificationHandler.Verify`（`:126-151`）：
1. `seed = Base64Decode(key)`；`Ed25519.KeyPairFromSeed(seed) → publicKey(32), expandedPrivateKey(64)`（**用长期身份**）；`:128-131`
2. 随机 32 字节 → `Curve25519.ClampPrivateKey` → 临时 X25519 私钥，`publicKey2 = GetPublicKey(privateKey)`；`:132-134`
3. 第一次 `/pair-verify`：`[1,0,0,0] + publicKey2(32) + publicKey(32)`；`:135-136`
4. 取响应前 32B 为对端 X25519 公钥 → `sharedSecret = X25519(privateKey, peer)`；`:137-141`
5. `signature = Ed25519.Sign(publicKey2 || peerPub, expandedPrivateKey)`（64B）；`:142`
6. **AES-CTR 加密签名**：key = `SHA512("Pair-Verify-AES-Key" || sharedSecret)[0..16]`，IV = `SHA512("Pair-Verify-AES-IV" || sharedSecret)[0..16]`；`:59-60, 143`
7. 关键细节：`aesCtrEncrypt` **先用 `bytesToEncrypt`（对端那 32B 公钥）跑 4 个 AES 块把计数器推过 32 字节，再加密 64B 签名**；所以对端若按 CTR 流解开整段 68B 密文，前 32B 是对端公钥 XOR keystream、后 64B 才是签名。【T】`:57-76`（`:65-69` 先 `ProcessBlock(bytesToEncrypt)` 4 次、`:70-75` 再处理 signature）
8. 第二次 `/pair-verify`：`[0,0,0,0] + 64B 密文`，只检查响应非 null，**不校验 GCM tag / 不消费剩余密文**。【T】`:144-150`

另：`generateAES_IV(prefix, sharedSecret) = SHA512(UTF8(prefix) || sharedSecret)[0..16]`。【T】`:24-35`

### 1.5 结论：TuneBlade 配对 vs 标准 HAP

| 维度 | TuneBlade（经典 AP1 PIN 配对） | 标准 HAP / AirPlay 2 |
|---|---|---|
| 报文单元 | binary plist（`NSDictionary`） | **TLV8**（`[type:1][len:1][value]`，长值 0x0C/0x0D 分片） |
| SRP | 2048 位、SHA-1、g=2 | **3072 位、SHA-512、g=5** |
| 持久化 | 只存 32 字节 Ed25519 seed（base64） | 存 identifier + LTSK/LTPK，可重新 pair-verify |
| pair-setup 最后 | AES-GCM（key/iv 用 SHA512 前缀派生） | ChaCha20-Poly1305 (HKDF 派生, nonce=`PS-Msg05/06`) |
| pair-verify 加密 | AES-CTR | **ChaCha20-Poly1305**（nonce=`PV-Msg02/03`） |
| 配对后 RTSP | 明文 | **HAP 帧加密（ChaCha20-Poly1305）** |
| 音频 | 明文 RTP（或固定 AES key） | `shk` 加密的 AP2 音频包 |

**判断**：TuneBlade 的 `DeviceVerificationHandler` 是给 Apple TV 3 时代"支持 PIN 配对但不出 HAP"的设备用的，对 HomePod/macOS 26 完全无效；只能借它的**流程形状**（pair-pin-start → setup×3 → verify×2），字节级全部要按 HAP 重写。

---

## 2. 标准 HAP 配对规格（可据实现）

### 2.1 TLV8 编码

格式：`type:1B | length:1B | value:lengthB`；value > 255 时拆成多个 `0x0C`(FragmentData) 片段，最后一片用 `0x0D`(FragmentLast)；接收端按同 type 相邻拼接。【P】pyatv `auth/hap_tlv8.py:6-48`；【X】`../web/external-notes.md:96-118`

| type | 名称 | 说明 |
|---|---|---|
| `0x00` | Method | 1=pair-setup，2=pair-verify，3=add pairing，4=remove… |
| `0x01` | Identifier | 用户名 / pairing id（UTF-8 字符串） |
| `0x02` | Salt | SRP salt / HKDF salt |
| `0x03` | PublicKey | SRP `A`/`B`（384B @3072）或 Curve25519 公钥（32B） |
| `0x04` | Proof | SRP `M1`/`M2`（SHA-512 → 64B）；pair-verify 里是被加密的签名 |
| `0x05` | EncryptedData | 加密的 pairing 子数据（M5/M6 / PV-Msg02/03） |
| `0x06` | SeqNo | 状态号 1..6 |
| `0x07` | Error | 1=Unknown,2=Authentication,3=BackOff,4=MaxPeers,5=MaxTries,6=Unavailable,7=Busy |
| `0x08` | BackOff | 秒 |
| `0x09` | Certificate | MFi 证书（`/auth-setup` 响应用） |
| `0x0A` | Signature | Ed25519 签名（64B） |
| `0x0B` | Permissions | 权限位 |
| `0x13` | Flags | `0x10`=TransientPairing |

### 2.2 pair-setup-pin（M1→M6）

请求统一是 `POST /pair-setup RTSP/1.0` + `Content-Type: application/octet-stream`，**body 就是裸 TLV8**（不是 plist）。【P】pyatv `protocols/airplay/pairing.py`；【X】`../web/external-notes.md:120-134`

| 步 | 方向 | TLV | 说明 |
|---|---|---|---|
| M1 | C→R | `0x00=1`(pair-setup), `0x06=1`, `0x00=0`?（Method 内层） | 开始 |
| M2 | R→C | `0x06=2`, `0x02`=Salt(16B), `0x03`=SRP `B`(384B) | 拿 salt/B |
| M3 | C→R | `0x06=3`, `0x03`=SRP `A`(384B), `0x04`=SRP `M1`(64B) | 客户端 S/M1 |
| M4 | R→C | `0x06=4`, `0x04`=SRP `M2`(64B) | 校验 |
| M5 | C→R | `0x06=5`, `0x05`=密文( ChaCha20-Poly1305(`{0x01 id, 0x03 LTPK, 0x0A sig}`) + 16B tag ) | 见 2.3 |
| M6 | R→C | `0x06=6`, `0x05`=密文(同上结构, 对端 LTPK) | 交换长期公钥 |

**SRP 参数**（必须精确）：`SRPContext("Pair-Setup", pin, prime=PRIME_3072, generator=5, hash=sha512)`；用户名固定字符串 `"Pair-Setup"`；HomePod/ATV 瞬态模式 **PIN=`"3939"`**（无 UI）。【P】pyatv `auth/hap_srp.py`；【X】`../web/external-notes.md:133`（引 `hap_transient.py:30` `TRANSIENT_PIN = 3939`）
- `S` 经 **HKDF-SHA512** 导出 32B 作为 shared secret（后续所有子密钥从它派生）。【X】`:134`
- **瞬态配对只跑 M1→M4 + pair-verify，跳过 M5/M6**（无长期凭证）。【X】`:147`

### 2.3 M5/M6 的数据保护

1. `device_x = HKDF(salt="Pair-Setup-Controller-Sign-Salt", info="Pair-Setup-Controller-Sign-Info", key=shared_secret, 32B)`
2. `msg = device_x || identifier(UTF-8) || LTPK(32B Ed25519 公钥)`
3. `signature = Ed25519_sign(LTSK, msg)`（64B）
4. `sub_tlv = {0x01: identifier, 0x03: LTPK, 0x0A: signature}`
5. `enc_key = HKDF("Pair-Setup-Encrypt-Salt","Pair-Setup-Encrypt-Info", shared_secret)`
6. `cipher = ChaCha20Poly1305(enc_key, nonce=ASCII "PS-Msg05" 前补 4 个 0x00, plaintext=sub_tlv)` → M5 的 `0x05` 值 = 密文+tag。【X】`../web/external-notes.md:136-145`（引 pyatv `hap_srp.py:160-200`）

### 2.4 pair-verify（M1→M4）

| 步 | 内容 |
|---|---|
| M1 | C 生一次性 X25519 `(c_priv,c_pub)`；发 `{0x06=1, 0x03=c_pub}` |
| M2 | R 生 `(r_priv,r_pub)`，`shared=X25519(r_priv,c_pub)`；回 `{0x06=2, 0x03=r_pub, 0x05=enc}`；`enc=ChaCha20Poly1305(HKDF("Pair-Verify-Encrypt-Salt","Pair-Verify-Encrypt-Info",shared), nonce="PV-Msg02", plaintext={0x01:r_id, 0x0A: sign(r_LTSK, r_pub||r_id||c_pub)})` |
| M3 | C 验签回 `{0x06=3, 0x05=enc2}`；`enc2` 同 key，nonce=`"PV-Msg03"`，plaintext=`{0x01:c_id, 0x0A: sign(c_LTSK, c_pub||c_id||r_pub)}` |
| M4 | R 回 `{0x06=4}`；`shared` 作为后续通道密钥派生的根 |

**签名内容顺序**：`本地公钥 || 本地标识 || 对端公钥`（顺序不可调整）。【P】pyatv `hap_srp.py:60-110`；【X】`../web/external-notes.md:149-160`

### 2.5 HKDF-SHA512 密钥派生总表（全部 32B）

【X】`../web/external-notes.md:162-176`（pyatv `hap_srp.py:91,172-179` + `auth/hap.py` + shairport-sync `pair_ap/pair_homekit.c` 交叉一致）

| 用途 | salt | info |
|---|---|---|
| pair-setup 加密 | `Pair-Setup-Encrypt-Salt` | `Pair-Setup-Encrypt-Info` |
| pair-setup 控制器签名 | `Pair-Setup-Controller-Sign-Salt` | `Pair-Setup-Controller-Sign-Info` |
| pair-setup 接收端签名 | `Pair-Setup-Accessory-Sign-Salt` | `Pair-Setup-Accessory-Sign-Info` |
| pair-verify 加密 | `Pair-Verify-Encrypt-Salt` | `Pair-Verify-Encrypt-Info` |
| RTSP control 发送 | `Control-Salt` | `Control-Write-Encryption-Key` |
| RTSP control 接收 | `Control-Salt` | `Control-Read-Encryption-Key` |
| event 通道 | `Events-Salt` | `Events-Write/Read-Encryption-Key`（**发送端方向要反用**） |
| data 通道 | `DataStream-Salt<seed>` | `DataStream-Output/Input-Encryption-Key`（`seed` = SETUP plist 的流 `seed`，十进制 u64） |
| **AP2 音频 RTP** | **不用 HKDF** | 直接用 SETUP plist 的 **`shk`**（32B 固定 ChaCha20-Poly1305 密钥） |

### 2.6 `/auth-setup`（MFi 步骤）

【P】`protocols.md:1468-1505`（含真实响应：1076 字节 MFi 证书）；【X】`../web/external-notes.md:205-217`

```
POST /auth-setup RTSP/1.0
Content-Type: application/octet-stream
Content-Length: 33

[1B 加密类型: 0x01=明文 / 0x02=MFi-SAP] [32B 本机 Curve25519 公钥]
```

- 响应体是 1076B MFi 证书，**可以忽略**（pyatv 直接丢弃）；设备不需要时回 403 或 200 空体，两种都可继续。
- 注意：TuneBlade 也发 `/auth-setup`，但 body 是**33 字节硬编码常量**（首字节 1 + 32B 固定数据），既不是随机 Curve25519 公钥也不区分 0x01/0x02。【T】`Tuneblade/AirplayDevice.cs:1777-1786`——说明它只是"让老 Apple TV 不报错"，对 AP2 设备必须按标准实现（0x02 + 随机公钥）。

### 2.7 AP2 会话请求顺序

【X】`../web/external-notes.md:217`（pyatv `airplayv2.py`）：
```
（mDNS _airplay._tcp 发现，配对需求判定）
OPTIONS *
POST /pair-setup   （瞬态：M1..M4；TuneBlade 式老设备才用 pair-setup-pin plist）
POST /pair-verify  （M1..M4）
POST /auth-setup   （33B）
   ── 此后 TCP 7000 上全部 RTSP 被 HAP 帧加密 ──
ANNOUNCE（SDP，同 AP1 或按设备要求）
SETUP（body = binary plist，见 §3.1）
RECORD
UDP 音频（shk 加密）+ 每 2s POST /feedback
```

---

## 3. 配对后的会话封装

### 3.1 HAP 加密帧（RTSP 通道）

【P】`protocols.md:1545-1558`；【X】`../web/external-notes.md:178-188`

```
[2B little-endian 长度 N][N 字节密文][16B Poly1305 tag]
```
- 算法：**ChaCha20-Poly1305-IETF**（Py/C# 的 AEAD，12B nonce）。
- nonce：`counter.to_bytes(8,'little')` 前补 4 个 `0x00`；**每帧 counter+1，从 0 开始**（收发各自独立计数）。
- **AAD = 那 2 字节长度字段本身**（加密/解密都带上，这是最容易写错的地方）。
- 明文长度上限：HomeKit 规定 1024B；AirPlay 不强制但跟随更安全（超长就拆多帧）。
- 实现：.NET 10 `System.Security.Cryptography.ChaCha20Poly1305`，无需第三方库。【推断：API 在 net5+ 可用，`.NET 10` 确认存在】
- 收发语义：pair-verify 成功后，**所有** RTSP 请求/响应（含 ANNOUNCE/SETUP/RECORD/SET_PARAMETER/FLUSH/TEARDOWN）都走这套帧；接收端实现参考 shairport-sync `rtsp.c` 的 `read_encrypted()/write_encrypted()`。【X】`:180`

> 工程建议：把 HAP 加密封装放在 `Stream` 层（`HapEncryptedStream : Stream`），让现有 `RtspTransport` 的"写 ASCII、读响应"逻辑保持不变——它只认字节流，不关心下面有没有加密。

### 3.2 AP2 SETUP 的 binary plist

`SETUP rtsp://<ip>/<sessionid> RTSP/1.0` + `Content-Type: application/x-apple-binary-plist` + `Content-Length` + bplist body。【X】`../web/external-notes.md:219-237`；【P】`protocols.md:1599-1720`（对照 SETUP 的 plist 风格）

音频流关键字段：

| key | 值 | 说明 |
|---|---|---|
| `streams[0].type` | `0x60`(96)=realtime / `0x67`(103)=buffered | 音频流，shairport 只接受 96/103 |
| `streams[0].ct` | `1`=PCM(L16) / `2`=ALAC | MVP 建议先用 1（L16），省掉 ALAC 编码器 |
| `streams[0].spf` | `352` | frames per packet（ALAC 固定 352；L16 时按设备接受） |
| `streams[0].sr` | `44100` | 采样率 |
| `streams[0].shk` | 32B 随机 | **音频包加密密钥**（§3.3） |
| `deviceID` / `sessionUUID` | MAC / GUID | 设备标识/会话 |
| `timingPort` + `timingProtocol` | `"NTP"` | AP2 发送端仍用 NTP 时序 |
| `controlPort` | 随机 | 发送端在此 UDP 端口收 control 包 |
| `isMedia` / `latencyMin=11025` / `latencyMax=88200` | — | latency 窗口 0.25–2s |

响应：`200 OK` + `Content-Type: application/x-apple-binary-plist` + body 含 `streams[].{streamID,dataPort|controlPort|audioPort}`、可选 `eventPort`（纯音频不需要）。【推断/待实测：不同接收端返回键名有差异，pyatv 文档未覆盖音频 SETUP 响应】

### 3.3 AP2 音频 RTP 包

【S】shairport-sync `rtp.c:1505-1568` `decipher_player_put_packet()`；【X】`../web/external-notes.md:190-199`

```
[2B seq BE][4B RTP timestamp BE][4B SSRC][密文 ...][16B Poly1305 tag][8B nonce]
```
- **没有 12B 标准 RTP 头**（无 version/PT/marker），前 10B 只是 seq/ts/ssrc。
- key = `shk`；算法 ChaCha20-Poly1305-IETF；12B nonce = 4 个 `0x00` + 包尾那 8 字节（发送端随机生成）。
- **AAD = 偏移 2..10 的 8 字节（timestamp + SSRC）**，seq 不参与 AAD。
- 密文长度 = 总长 − 10 − 16 − 8。
- 发送端每包：`seq` 递增（16 位回绕）、`ts` 按 `spf/44100` 递增、`ssrc` 固定（例如 0x34249563）。
- .NET 实现：`ChaCha20Poly1305.Encrypt(nonce, plaintext, ciphertext, tag, aad)`；注意 `System.Security.Cryptography.ChaCha20Poly1305` 需要 12B nonce。

### 3.4 control 通道（UDP）与 `/feedback`

- `packet[1]==0xD6`：AP2 加密音频的另一种封装（control 通道上转发的音频，前 6 字节是 AP2 control 头，之后才是 §3.3 结构）。【X】`:201-203`（shairport-sync `rtp.c` 分支）
- `packet[1]==0xD7`：**anchoring announcement**，携带 `8B remote_packet_time_ns`、`8B clock_id`、`4B frame_1`、`4B frame_2`；`stream_specified_latency = frame_2 − frame_1`（正常 **77175 帧**）；另有 `ap2_realttime_stream_latency_fudge_factor = 11025 帧`。【X】`:203`
- **`/feedback` keep-alive**：`POST /feedback RTSP/1.0`（走加密 RTSP 通道），**每 2 秒**一次；响应 `200 OK` + bplist `{'streams': []}`（或带流状态）。【P】`protocols.md:1722-1749`

> 时序/同步：AP2 仍用 NTP timing（`timingProtocol="NTP"` + timing UDP 端口），经典 RAOP 的 Timing/Sync 包思路可复用，但 control 包要用 0xD6/0xD7 语义、且 `rtpTime` 基准要跟 `stream_specified_latency` 对齐。【推断】需实测抓包确认；pyatv 文档未给出音频流时序细节。

---

## 4. 与 TuneBlade 的差异清单（避免照着 TuneBlade 写错）

| 环节 | TuneBlade（AP1） | AP2 正确做法 | 证据 |
|---|---|---|---|
| 配对报文 | binary plist | **TLV8** | §1.2 vs §2.1 |
| SRP | 2048/SHA-1/g=2 | 3072/SHA-512/g=5 | §1.3 vs §2.2 |
| pair-setup 最后一步 | AES-GCM(SHA512 前缀) | ChaCha20-Poly1305(HKDF, `PS-Msg05`) | §1.4 vs §2.3 |
| pair-verify 加密 | AES-CTR | ChaCha20-Poly1305(`PV-Msg02/03`) | §1.4 vs §2.4 |
| 配对后 RTSP | 明文 | HAP 帧（`[2B len][cipher][tag]`，AAD=len） | §3.1 |
| auth-setup | 33B 硬编码常量 | `0x02` + 随机 X25519 公钥 | §2.6 |
| 音频包 | 12B RTP 头 + 明文/固定 AES | 10B 头 + ChaCha20(shk) + tag + 8B nonce | §3.3 |
| SETUP | `Transport:` 头 | **binary plist body**（含 shk） | §3.2 |
| keep-alive | 无 | `POST /feedback` 每 2s | §3.4 |
| 设备发现 | 只 `_raop._tcp` | `_airplay._tcp`，看 `features`/`sf` 判 AP2 | 【T】`DeviceController.cs:485`、`AirplayDevice.cs:3070-3091`；【X】`../web/external-notes.md:68-80` |

### 4.1 哪些设备必须走 AP2（判定逻辑）

【X】`../web/external-notes.md:51-62`（逐设备矩阵 + pyatv 源码依据）：

1. 只有 `_raop._tcp`、`sf/flags` 无配对位、`et` 含 `0`(明文) → **AP1 明文**（AirPort Express 2、Apple TV 2/3、shairport-sync、多数第三方音箱）。
2. `_raop._tcp` 的 `et` 含 `1`(RSA) → AP1 + 老式 RSA/AES（需实现 `rsaaeskey` 解密）。
3. `pw=true` 或 `sf` bit 0x80 → AP1 + 密码（HTTP Digest）。
4. **只有 `_airplay._tcp` 或 `_raop._tcp` 的 `sf` bit 0x200/0x8 置位，或 `features` 高位（≥bit 38/48）** → **AP2/HAP**（HomePod/HomePod mini、新 Apple TV、macOS 13+ 隔空播放接收器）。
5. 实测异常：macOS 26 接收器与 HomePod mini 对明文 OPTIONS 回 **403**（不是 401）——这是"必须先 HAP 认证"的强信号，没有 `WWW-Authenticate`，密码分支无从触发。**结论：现有 AP1 栈对它们永远 403，必须新增 AP2 分支。**

---

## 5. 改造清单：从现有 `RaopConnection`（AP1）到 AP2

现有代码（已交付、`dotnet build` 0 错误）：
- `src/Zilux2/AirPlay/Protocol/RtspTransport.cs`（450 行）：RTSP over TCP、Digest 认证。
- `src/Zilux2/AirPlay/Protocol/RaopPackets.cs`（231 行）：AP1 RTP/Sync/Timing/Resend 构造与解析。
- `src/Zilux2/AirPlay/Protocol/RaopConnection.cs`（738 行）：OPTIONS→ANNOUNCE→SETUP→RECORD 握手、UDP 收发、Sync 定时、重传缓存、音量/FLUSH/TEARDOWN。
- `src/Zilux2/AirPlay/Protocol/` 已有 `HostLog` 日志基础设施。

### 5.1 需要新增的文件（建议路径，均 `namespace Zilux2.AirPlay.Hap`）

| 文件 | 职责 | 行数估算 |
|---|---|---|
| `HapTlv.cs` | TLV8 编解码（含 0x0C/0x0D 分片） | ~150 |
| `HapSrp.cs` | SRP-6a 3072/SHA-512（N/g 常量、K、M1/M2 校验） | ~300 |
| `HapCrypto.cs` | HKDF-SHA512、ChaCha20-Poly1305 AEAD 封装（HAP 帧 + AP2 音频）、X25519/Ed25519 包装 | ~250 |
| `HapPairing.cs` | pair-setup-pin（瞬态 PIN 3939）、pair-verify 状态机；持久化 Transient/长期凭证 | ~450 |
| `HapEncryptedStream.cs` | `Stream` 子类：读写按 §3.1 帧加解密（AAD=长度字段、counter 单调） | ~200 |
| `Ap2SetupPlist.cs` | 最小 binary plist **编码器**（SETUP 请求/解析响应）——.NET 无内置 bplist | ~200 |
| `Ap2AudioPacket.cs` | §3.3 包构造 + `/feedback` 定时器 | ~120 |

改造点：
1. `RaopConnection` 增加 `enum RaopSessionMode { LegacyRaop, AirPlay2 }` 与 `RaopOptions.UseAirPlay2`；`Connect()` 按模式分支。
2. AP2 握手序：`OPTIONS`（明文）→ `HapPairing.PairSetupTransient()` → `HapPairing.PairVerify()` → `POST /auth-setup` → **把 socket 包成 `HapEncryptedStream`** → `ANNOUNCE` → `SETUP`(bplist) → `RECORD` → 启动 `/feedback` 2s 定时器 → UDP 音频用 `Ap2AudioPacket`（key=响应里的 `shk`）。
3. 音频发送：AP2 走 `Ap2AudioPacket`（10B 头+AEAD），AP1 保留 `RaopPackets.BuildAudioPacket`（12B RTP 头）；共用同一个"每 352 帧一包、ts 递增"的调度器。
4. 时序：AP2 用 NTP timing（timingPort），control 端口的 0xD6/0xD7 解析新增；重传请求格式待实测（AP2 接收端可能不再发 0x55 重传，先不实现）。
5. 设备发现：`_airplay._tcp` 的 `features`/`sf`/`am` 解析 + `AirPlay2` 标志位，把现有 mDNS 层（mdns-dev 的模块）扩展一个 TXT 字段解析函数即可。

### 5.2 自测策略（无设备）

- 扩展 `src/Zilux2/_devtest/airplay/AirPlayMockDevice.cs` 的兄弟类 `AirPlay2MockDevice`：实现 TLV8 pair-setup（M1→M4，**不校验** proof 只回随机 M2 也可先跑通）、pair-verify（回随机 r_pub + 用 shared 加密签名）、HAP 帧解包、SETUP bplist 解析、音频 AEAD 解密，断言能解出 200 帧明文。
- 复用现有 loopback 模式：`AirPlayLoopbackTest.Run()` 的断言框架（32 条）稍改即可；新增断言：TLV 序列号 1→6、HAP frame counter 单调、解密后音频 seq/ts 连续。
- 这一步可完全在没有 HomePod 的情况下验证 90% 的字节逻辑；真正的风险只剩"设备是否接受瞬态配对/auth-setup"。

### 5.3 风险与工作量

| 风险 | 说明 | 缓解 |
|---|---|---|
| HomePod 瞬态配对是否够用 | pyatv 对 HomePod 用 transient（PIN 3939）；但 **MFi `/auth-setup` 证书校验**可能被要求（HomePod 有 `_mfi` 协处理器） | 先跑 M1-M4 + pair-verify + auth-setup（回 200/403 都继续），不行再研究 MFi 证书（TuneBlade 的硬编码 33B 就是为绕这个，但值不可用） |
| macOS 26 接收器 | 隔空播放接收器可能要求**显示器 PIN 确认**，或只接受同 Apple ID/家庭成员 | 先试瞬态；失败则提示用户"请用 iPhone/Mac 的 AirPlay 菜单手动配一次"（pyatv 思路：读 `_airplay._tcp` 的 `pk`/`sf`/`acl`） |
| bplist 编码器 | 需要自己写（NSData/NSNumber/NSDictionary/UID 等） | 只实现 SETUP 需要的子集（dict/array/string/data/int/real），~200 行 |
| 时序对齐 | AP2 `stream_specified_latency=77175` 帧 + fudge 11025 帧，若 NTP 基准错会"能连但爆音/延迟" | 复刻 shairport-sync 的 anchor 逻辑；先按 latencyMin/Max 取中间值（44100 帧=1s） |
| 整体工期 | 本文规格齐备后，纯 C# 实现 + mock 自测约 2–3 人日；真机调试 1–2 天（若设备接受瞬态配对） | 先做 mock loopback，再借前端侧的 HomePod/mac 实测（每次改 <1 分钟验证） |

---

## 6. 证据索引

**TuneBlade 反编译（根：`research/airplay/tuneblade-decomp/`）**
- `Tuneblade/DeviceVerificationHandler.cs:17-35`（随机数/SHA512-IV）、`:37-55`（AES-GCM）、`:57-76`（AES-CTR + 32B 预推流）、`:95-124`（Pair）、`:126-151`（Verify）、`:153-156`（IsSecurityModeAcceptable 恒 false）
- `Tuneblade/BinaryPlistConverter.cs:11-31`（userID plist）、`:33-52`（解析 salt/pk/proof）、`:54-72`（pk+proof / epk+authTag）
- `Tuneblade/AirPlaySRPClient.cs:100-116`（2048 组 + SHA-1）、`:136-147`（S）、`:160-177`（K）、`:179-220`（M1/M2）、`:232-244`（校验）
- `Tuneblade/AirplayDevice.cs:1161-1206`（POST 封装）、`:1777-1786`（auth-setup 33B 常量）、`:1087-1159`（仅 FirstTimePassCode）、`:3070-3091`（sf 位映射）、`:2789-3105`（TXT 解析）
- `Tuneblade/DeviceController.cs:485`（只浏览 `_raop._tcp`）

**pyatv 文档**：https://github.com/postlund/pyatv/blob/master/docs/documentation/protocols.md
- `:1468-1505` `/auth-setup`（含 1076B 证书）
- `:1525-1558` AirPlay 2 + Encryption（HAP 帧格式、1024B 上限）
- `:1599-1720` control 通道（SETUP plist 样例、eventPort）
- `:1722-1749` `/feedback` 每 2s
- `:1753-1797` event 通道（HKDF Events-Salt、方向反转、`/command` 必须回 200 否则 30s 断连）
- `:1799+` data 通道

**pyatv 源码**（外部笔记引用）：`auth/hap_tlv8.py:6-48`、`auth/hap_srp.py`（SRP 3072/SHA-512、M5/M6 加密）、`auth/hap_session.py`（HAP 帧）、`protocols/airplay/pairing.py`、`auth/hap_transient.py:30`（PIN 3939）、`protocols/airplay/utils.py:34,139-157`（UNSUPPORTED_MODELS / pairing requirement）

**shairport-sync**（GPL，只读参考）：`rtsp.c`（read_encrypted/write_encrypted、AP2 分支）、`rtp.c:1505-1568`（`decipher_player_put_packet`）、`pair_ap/pair_homekit.c`（`pair_keys_map`）

**交叉验证笔记**：`research/airplay/web/external-notes.md` §1（设备矩阵/判定规则）、§2（HAP 字节细节）、§5.3（NTP）、§7（MVP vs 完整路线）

---

## 7. Zilux2 实现状态与真机验证（2026-10-20）

### 7.1 已落地代码（`src/Zilux2/AirPlay/Ap2/`，主工程 build 0 警告 0 错误）

| 文件 | 行数 | 职责 |
|---|---|---|
| `Ap2Connection.cs` | 780 | 连接编排：配对 → HAP 加密 → `GET /info` → session SETUP → 事件通道 → RECORD → stream SETUP → 音频/控制/时钟接收；`Ap2Connection.Connect(...)` 为唯一入口 |
| `Ap2Setup.cs` | 355 | 二进制 plist 构造/解析：session body（15 键）、streams body（13 键，`streams[0]`）、PTP 分支、响应端口解析 |
| `HapEncryptedTransport.cs` | 324 | HAP 帧（`[2B LE len][密文][16B tag]`，AAD=2B 长度，nonce=4×0+8B LE 计数器）流式加解密 + RTSP 收发（CSeq 自增、Content-Length 自动补） |
| `Ap2AudioPacket.cs` | 161 | RTP 12B 头 + ChaCha20-Poly1305 音频封包/解包（AAD=RTP 头 `[4..12)`，密文+16B tag+8B nonce） |
| `Bplist.cs` | 474 | 纯 BCL 二进制 plist 编解码（无 NuGet 依赖） |
| `Ap2Pairing.cs` | 114 | 瞬态配对适配层：`HapPairing.TransientAsync` ↔ `IFrameCryptor` |
| `Ap2Feedback.cs` | 105 | `POST /feedback`（RTSP/1.0，bplist `{streams:[]}`，实现默认 2s，参考实现为 25s，设备均接受） |
| `IFrameCryptor.cs` | 163 | 帧加解密抽象（Null / TestChaCha / 真实 `HapSessionCrypt` 适配），单点替换 |
| `_devtest/airplay/AirPlay2MockDevice.cs` | — | mock HAP 接收端：TLV8 配对、加密帧、bplist 两段 SETUP、事件通道、音频 AEAD 解密统计 |
| `_devtest/airplay/AirPlay2LoopbackTest.cs` | — | 56 条端到端断言（配对/加密/两段 SETUP/RECORD/音频/音量/FLUSH/TEARDOWN） |

依赖（crypto-dev，`src/Zilux2/AirPlay/Crypto/`）：`HapPairing.cs`（SRP-3072/SHA-512 瞬态配对）、`HapSessionCrypt.cs`（HAP 帧）、`HapTlv8.cs`、`SrpClient.cs`、`X25519.cs`、`Ed25519.cs`。自查命令：

```bash
cd E:\Zilux2开发
dotnet build src/Zilux2/Zilux2.csproj -v q --nologo     # 0 警告 0 错误
cd C:\Users\13329\AppData\Local\Temp\zilux2-airplay-harness
dotnet run -c Release -- --ap2 "E:\Zilux2开发\src\Zilux2\bin\Debug\net10.0-windows10.0.19041.0\Zilux2.dll"
# → [airplay2-test] summary passed=56 failed=0
```

### 7.2 真机验证（HomePod mini：.183 = `192.168.31.183`、.136 = `192.168.31.136`，均 `AirTunes/980.77.2`；本机 `192.168.31.41`）

| 阶段 | 结果 | 证据 |
|---|---|---|
| HAP 瞬态配对 `POST /pair-pin-start` → `POST /pair-setup` M1–M4 | ✅ | M1 200 + 409B；M2 Salt 16B + PublicKey 384B（SRP-3072/SHA-512）；M3→69B；M4 设备 proof 校验通过；K=SHA-512(S) 64B；HKDF 导出 control write/read key |
| `GET /info`（加密通道） | ✅ 200 | bplist 2151B（.183）/ 2026B（.136），含 deviceID/osvers/srcvers/vv |
| session SETUP（root 无 streams） | ✅ 200 | 75B bplist `{skipRecord:true, eventPort:49xxx}`；`timingProtocol` 必须是 **`PTP`**（见 §8） |
| 事件通道 TCP `host:eventPort` | ✅ | 一次连上；设备推送 `POST /command`（updateInfo），回裸 200 后设备继续会话 |
| `RECORD`（空 body） | ✅ 200 | 无 Range/RTP-Info |
| stream SETUP（root 仅 streams） | ✅ 200 | `streams[0].dataPort=58784`、`controlPort=53209`（每次不同）；`ct=2/type=0x60/spf=352/sr=44100/shk=32B` |
| 音频 UDP（精确 125 包/秒，20s） | ✅ | 2500 包，设备 control 端口 0 个重传请求，20s 无断连；`TEARDOWN` 200 |
| 音量 / FLUSH / TEARDOWN | ✅ 200 | `volume: -12.000000`（60%） |
| `timingProtocol=NTP` 对照 | ❌ | stream SETUP 读超时（设备 0 字节）；同代码改 `PTP` 后同一连接立即 200 |

### 7.3 本轮新增踩坑（实现者必读）

1. **发送节奏必须精确 125 包/秒**（352 帧/包 @44.1k = 7.98ms/包）。Windows `Thread.Sleep(8)` 实际约 15.6ms → 约 64 包/秒 → 接收端缓冲欠载 → 设备约 10–12s 后拆会话（下一次 RTSP 写报 “你的主机中的软件中止了一个已建立的连接”）。修法：`Stopwatch` 计时 + 按已过时间补发（实测精确补发后 20s 无断连、0 重传请求）。
2. 事件通道的 200 必须**极简**：`RTSP/1.0 200 OK\r\nServer: …\r\nCSeq: n\r\n\r\n`，不能带 `Content-Length` / `Audio-Latency`。
3. `shk`（音频 key）= 配对共享密钥**前 32 字节**，不做 HKDF；只有 control/event 通道 key 才 HKDF。
4. `GET /info` 必须在 session SETUP **之前**；AP2 不需要 `OPTIONS`/`ANNOUNCE`/`pair-verify`（瞬态配对无 pair-verify）。
5. 设备对连续瞬态配对有限流：失败后等 ≥30–40s；多端并发配对会互相打断（表现为 M3 读超时）。
6. `timingProtocol=PTP` 时 session body 需带 `timingPeerInfo{Addresses,ID}`、`groupUUID`、`groupContainsGroup前端侧er=true`，否则设备可能不进入 PTP 流程。

### 7.4 出声还缺的两块（**已于 2026-10-20 晚全部补齐并真机出声，见 §9、§10.6**）

历史记录（当时判断）：
1. **控制通道 Sync 包未实现**：真实实现改为 PTP 变体 0xD7、每 100ms 发往设备 control 端口，用它在 RTP 时间戳与 PTP 时间之间建立锚点；规格见 §9.5。
2. **PTP 时钟未实现**：最终方案不是 follower，而是**我方当 PTP 主时钟**（bind 319/320、125ms Sync+Follow_Up、1s Announce、回 Delay_Req），HomePod 作 slave；见 §9.3。

## 8. PTP 时钟：HomePod 的必要条件与最小实现

### 8.1 结论（真机证据）

- `timingProtocol` 取 `"NTP"`：session SETUP 200，但 **stream SETUP 设备不回任何字节**（读超时）；取 `"PTP"`：同一份代码、同一条加密连接，stream SETUP 立即 200 并开始收音频。→ **HomePod（AirTunes/980.77.2，vv=1）要求 PTP timing**。
- `research/airplay/_ref/shairport-src/AIRPLAY2.md`：AirPlay 2 用伴生程序 **NQPTP**（Not Quite PTP）做 timing/sync；NQPTP 需要独占 UDP **319/320** 端口。接收端有 NQPTP，发送端没有现成实现 → 必须自己写。

### 8.2 实测报文（本机 bind 319/320 后抓取，连续 20s）

| 端口 | messageType | 长度 | 频率 | 首 20B 示例（hex） |
|---|---|---|---|---|
| 319（PTP event） | `0x00` Sync | 44 | ~125ms | `10 02 00 2C 00 00 06 08 00 00 00 00 …` |
| 320（PTP general） | `0x08` Follow_Up | 96 | ~125ms | `18 02 00 60 00 00 04 08 00 00 00 00 …` |
| 320 | `0x0B` Announce | 76 | ~1s | `1B 02 00 4C 00 00 04 08 00 00 00 00 …` |
| 320 | `0x0C` Signaling | 106 | ~1s | `1C 02 00 6A 00 00 04 08 00 00 00 00 …` |

- 公共头解析：`byte0 & 0x0F` = messageType（高 4 位 transportSpecific）；`byte1 & 0x0F` = versionPTP = 2；`byte2-3` = messageLength（BE）；`byte4` = domainNumber；`byte6-7` = flags（BE）；`byte8-15` = correctionField；`byte16-23` = sourcePortIdentity；`byte30-31` = sequenceId（BE）。Sync 44B = 34B 头 + 10B originTimestamp（48bit 秒 + 32bit 纳秒）；Follow_Up 96B 内含 preciseOriginTimestamp；Delay_Resp 长度 54B。
- 角色判定：**接收端（HomePod）是 PTP master（grandmaster），发送端必须是 slave**——设备主动 Sync/Follow_Up/Announce，我们只需要跟随 + 发 Delay_Req 测时延；若角色反了（发送端自称 master），设备会忽略/不进入同步。

### 8.3 最小实现清单（发送端 PTP slave，约 250–400 行 C#）

1. `PtpEndpoint`：`UdpClient` bind 319（event）和 320（general），各起一个接收线程/任务；Windows 低端口无需管理员权限，但要放行防火墙。
2. 报文解析：解析 34B 公共头 + Sync / Follow_Up / Announce / Delay_Resp；用 `sequenceId` 把 Sync 与 Follow_Up 配对（two-step）得到 master 时间戳；维护 master↔本地时钟的 offset。
3. 时钟滤波：最少延迟/滑动中位数，1–2s 更新一次 offset（2s 播放缓冲下 ±10ms 误差可接受）。
4. `Delay_Req`：每 1s 从 319 向 master:319 发 `Delay_Req`（34B 头 + 10B originTimestamp，type `0x01`，correction 0）；在 320 收 `Delay_Resp`（`0x09`），用 t1..t4 计算 path delay 与 offset。
5. 时钟 API：`PtpClock.Now`（48bit 秒 + 32bit 纳秒 ↔ 本机 Stopwatch/QPC），供 Sync 包和音频时间戳使用。
6. 音频时间锚：RTP 时间戳与 Sync 锚点必须落在 **PTP 时间域**（当前实现用 `Environment.TickCount64` 生成，须替换）；首个音频包的 RTP ts 对应 `PtpClock.Now + latency`，之后每包 +352。
7. 可选：`Signaling`（`0x0C`）只需忽略（记录日志观察设备是否继续）；PTP master 模式、多房间 group 不必实现。

### 8.4 控制通道 Sync 包（0xD4）规格（参考实现 + pyatv 一致）

每秒发往设备 control 端口：
- `byte0 = 0x90`（仅首个）否则 `0x80`；`byte1 = 0xD4`；`byte2-3 = seq（BE，固定 7）`；`byte4-7 = now - latency`（RTP 时间域，PTP 基准）；`byte8-15 = ts2ntp(start_ts + framesSent)`（NTP 64bit 格式的 PTP 时间）；`byte16-23 = now`（NTP 64bit）。
其余控制包：Timing 响应 `0xD3`（echo 请求 b0，seq=7，offset 4..8 为 0，reftime=请求 sendtime，recvtime/sendtime=当前时间）；重传响应 `0xD6`（`0x80 0xD6` + 原包 seq BE + 完整原 RTP 包，回请求方端点）；设备重传请求 `0xD6` 语义与 AP1 的 PT=85 相同。

### 8.5 风险

- Windows 软件时间戳存在 us 级抖动，2s 缓冲下通常足够；跨设备多房间同步精度会差一些。
- 设备可能在长时间收不到 Delay_Req/PTP 时降级（本次 20s 测试未拆会话，但出声未验证）。
- 端口 319/320 若被系统 PTP 服务占用需先停用。

### 8.6 验证顺序

①`PtpEndpoint` 跑通：能持续解出 Sync/Follow_Up、offset 抖动 <5ms；②发 `Delay_Req` 收到 `Delay_Resp`（HomePod 会回，可用日志确认）；③把 Sync 0xD4 与音频 RTP 时间戳锚到 PTP 域；④真机听声（.136 白色 HomePod 可听）；⑤多设备/长时稳定性。

> §8 是 2026-10-20 早期（PTP follower / NTP 基线）的记录。实际落地版本改为 **PTP master + 0xD7 sync + 12B RTP 头 + HKDF 音频 key**，以 §9 为准（§8.4 的 0xD4 规格是 NTP 模式变体，PTP 模式不发送）。

---

## 9. 实现状态（任务 落地版，2026-10-20）

本节记录 `src/Zilux2/AirPlay/Ap2/` 中 **已实现并真机验证过握手链路** 的版本，是给维护者的“代码 ↔ 协议”对照表。

### 9.1 文件清单与职责

| 文件 | 职责 |
|---|---|
| `Ap2Connection.cs` | 主连接状态机：配对 → 加密 RTSP 通道 → GET /info → 会话 SETUP → 事件通道 → SETPEERS → RECORD → 流 SETUP → 音频/Sync/反馈/音量/Flush/Teardown |
| `Ap2Setup.cs` | 会话 SETUP body（含 `timingPeerInfo`/`timingPeerList`）、流 SETUP body（含 audioFormat/ct/latencyMin/Max/shk/streamConnectionID）、解析响应、`SETPEERS` body |
| `Ap2Sync.cs` | 20B NTP 同步包（0xD4）与 28B PTP 同步包（0xD7）的构造 |
| `Ap2AudioPacket.cs` | AP2 音频包：12B RTP 头 + ChaCha20-Poly1305 密文 + 16B tag + 8B nonce |
| `Ap2Pairing.cs` | `HapPairing.TransientAsync` 与 `HapEncryptedTransport` 的适配（HAP 帧加解密器） |
| `Ap2Feedback.cs` | 每 2s `POST /feedback`（AP2 keep-alive） |
| `Ap2PtpLink.cs` | PTP 主时钟的晚绑定桥（反射加载 `Ap2PtpMaster`，接口 `IAp2PtpMaster { ClockId; NowNs; SetPeers }`） |
| `Ap2PtpMaster.cs` | PTP 主时钟（ptp-dev 交付）：bind UDP 319/320，125ms Sync+Follow_Up、1s Announce、回 Delay_Req/PDelay_Req |
| `HapEncryptedTransport.cs` / `IFrameCryptor.cs` / `Bplist.cs` | HAP 帧加密的 RTSP 传输、加解密抽象、二进制 plist 编解码 |

### 9.2 与 §3/§4 的差异（早期文档 → 实际实现）

1. **不发送 ANNOUNCE**；AP2 用「GET /info + 两段 SETUP」取代 ANNOUNCE。
2. **不发送 OPTIONS**（`Ap2Options.SendOptions` 默认 false）；配对完成后第一个请求是加密的 `GET /info`。
3. 会话 SETUP 的 `timingProtocol` 默认 **"PTP"**（HomePod/新固件在 NTP 下会回 200 但流 SETUP 被静默忽略；`Ap2Options.TimingProtocolPtp` 默认 true）。
4. **RECORD 的响应可能是 500**（HomePod mini 实测），必须容错继续发流 SETUP（参考实现同样不检查 RECORD 状态）。
5. RECORD 成功后**同头补发 FLUSH**（`Range: npt=0-` + `RTP-Info: seq=…;rtptime=…`），这是 AirFlash 蓝本的行为。
6. 会话 SETUP 的 `timingPeerInfo` 规范（AirFlash `session.rs`）：`ID` 是**每次会话新生成的随机 UUID**（不是 sessionUUID）、`DeviceType=0`、`ClockID`=PTP master 的 clockIdentity、`Addresses=[本机IP]`、`SupportsClockPortMatchingOverride=false`；`timingPeerList` 为同一 dict 的数组。`groupContainsGroup前端侧er` **恒为 false**；`groupUUID` 仅在配置了多房间 group 时才写（单设备不写）。
7. SETUP#2 的 `streamConnectionID` 与 RTP 头里的 SSRC 用同一个值（单设备实现里两者都取 session id 即可，AirFlash 用随机 ssrc 并两处共用）。

### 9.3 PTP 主时钟（我们当 master，HomePod 当 slave）

HomePod 在会话 SETUP 声明 PTP 后，**期待发送端是 PTP 主时钟**：它向本机 319/320 发 Delay_Req/PDelay_Req，并按我们发的 Sync/Follow_Up 校准播放时钟。若我们按 follower 实现（等 HomePod 发 Sync），PTP 永远锁不上、会话 ~10s 后被拆。

- 本机 bind UDP **319（event）** 与 **320（general）**；clockIdentity 随机 63bit（`Ap2PtpMaster.ClockId`）。
- **PTP master 的 peer 列表只包含接收端地址**（不要把本机地址传给 `SetPeers`，否则会给自己发 Sync/Announce）；本机地址只出现在 RTSP `SETPEERS` 的 body 数组里（`[peer IP…, 本机IP]`）。
- 每 **125ms**：向每个 peer 的 319 发 `Sync`（kind 0，44B）、向 320 发 `Follow_Up`（kind 8，96B）；每 **1s** 向 320 发 `Announce`（kind 11，76B）。
- 收到 `Delay_Req`（kind 1）→ 向 peer:320 回 `Delay_Resp`（kind 9，54B）；收到 `PDelay_Req`（kind 2）→ 向 peer:319 回 `PDelay_Resp`（kind 3，54B）+ 向 320 发 `PDelay_Resp_Follow_Up`（kind 10，54B）。
- 时间戳格式：48bit 秒（BE 6B）+ 32bit 纳秒（BE 4B）；时间域=**Unix epoch 原始纳秒**（`Clock::now_ns()`，非 NTP 1900 纪元）。
- 报文头：`p[0]=0x10|kind`、`p[1]=2`（version 2）、`p[2..4]=length BE`、`p[6..8]=flags BE`、`p[20..28]=clockIdentity BE`、`p[28..30]=0x8005`（port 5）、`p[30..32]=seq BE`、`p[33]=logMessageInterval`（-3 → 0xFD）。
- 日志证据（.183，25s）：`AP2 PTP master listening on 192.168.31.41:319/320 clockId=0x788CB547E9641ED8 peers=[192.168.31.183]`、`AP2 PTP tx started: sync/follow-up every 125 ms, announce every 1000 ms`、`AP2 PTP stats: syncRounds=213 announce=26 tx=1099 rx=672 delayReq=200 pdelayReq=0 rejected=0 sendFailures=0 peers=2` —— **delayReq 持续增长说明 HomePod 已把我们当 master**。

### 9.4 SETPEERS（PTP 模式下事件通道建立后必发）

事件通道 TCP 连上（host:eventPort）后、流 SETUP 之前，发一条 RTSP 方法 `SETPEERS`，body 为 **bplist 数组**：各 peer 的 IP 字符串 + 本机 IP 字符串，例如 `["192.168.31.183", "192.168.31.41"]`（注意实测本机 IP 在前/在后均可，设备回 200）。同时把同样列表传给 `Ap2PtpMaster.SetPeers`，让主时钟向所有 peer 发 Sync。

### 9.5 PTP 同步包（0xD7，替代 §8.4 的 0xD4）

每 **100ms** 发往设备 control 端口，28 字节：

```
off  0: 0x90（首包）| 0x80
off  1: 0xD7
off  2-3: BE16 = 6            // 与 NTP 变体的 7 区分
off  4-7: BE32 = 当前音频 RTP 时间戳（随机基值 + 352×已发包数）
off  8-15: BE64 = 当前 Unix 纪元纳秒（与 PTP master 同一时钟域）
off 16-19: BE32 = RTP 时间戳 − latencyFrames（当前 latency=5292 帧 ≈120ms）
off 20-27: BE64 = PTP clockIdentity（master.ClockId）
```

NTP 模式变体（`timingProtocol=NTP` 时）为 20 字节：`[1]=0xD4`、`[2..4]=7`、`[8..16]=NTP64(now)`、`[16..20]=rtp`。

### 9.6 音频包（12B RTP 头，与 §3.3 的早期 10B 版本不同）

```
[0]=0x80  [1]=0x60（首包 0xE0，marker=1）  [2..4]=seq BE  [4..8]=ts BE  [8..12]=SSRC=sessionId
[12..] = ChaCha20-Poly1305 密文
[.. ]  = 16B tag
[.. ]  = 8B nonce（4×00 + 4B LE counter 的高 4B？——实现为 LE 递增计数器 8B 附尾）
AAD = RTP 头 [4..12]（ts+ssrc 共 8B）
```

- 音频 key = **HKDF-SHA512(sharedSecret, salt="Events-Salt", info="Events-Write-Encryption-Key", 32B)**（AirFlash `session.rs` 的 `audio_key`），**不是** sharedSecret 前 32B（早期实现错误，会导致解密出噪声）。
- 每包 352 帧；PCM 模式载荷=1408B LE int16（`ct=1`、`audioFormat=1<<11=2048`）；ALAC 模式=`ct=2`、`audioFormat=1<<18=262144`。
- 流 SETUP 的 `latencyMin=latencyMax=5292`（120ms×44.1k），接收端按此播放；**sync 包 16-20 字段不要再减一次 latency 之外的值**（AirFlash 注释：重复扣减会让可听延迟翻倍）。

### 9.7 实测状态（.183 白色 HomePod mini，25s）

| 步骤 | 结果 |
|---|---|
| 瞬态配对 | pair-pin-start 200 → /pair-setup 409B → M3 → M4 proof 校验通过 |
| 加密 GET /info | 200，2151B |
| 会话 SETUP（PTP） | 200，498B，eventPort=49196 |
| 事件通道 | 连接成功（attempt 1） |
| SETPEERS | 200，0B |
| RECORD | **500**（容错继续） |
| 流 SETUP（PCM/ct=1/latency 5292） | 200，137B |
| 音频/Sync/feedback | 25s 发 3124 帧无断连；sync 100ms 正常；`/feedback` 13 次 200 |
| TEARDOWN | 200 |

**后续结论：已确认出声**。该轮 live2 用随机负载只验证协议；2026-10-20 晚 lead 用同一套本层代码（ALAC 载荷 + PTP 主时钟 + 125 包/秒定速）在 .136 黑色 HomePod mini 上真实出声，接收端 latency 提到 300ms 后用户复听「干净了（没杂音）」。详见 §10.6。

**2026-10-20 修复后状态**（三处与 AirFlash 蓝本的偏差已修，见 §9.2/§9.4/§9.5）：主工程 `dotnet build` 0 警告 0 错误；AP2 mock 反射自测 `passed=58 failed=0`；修复后 .183 live2 20s 复测：`CONNECT OK 0.83s`、dataPort=60500、controlPort=57400、eventPort=49203、`eventConnected`、RECORD **500** 容错、流 SETUP 200(137B)、frames=2498、feedback=10、TEARDOWN 200、无断连。若试听仍静音，下一步对照顺序：①SETPEERS 与流 SETUP 的先后（当前 SETPEERS 在前）；②首个 Sync 与首个音频包的先后；③latency 取值（5292 vs AirFlash 默认 150ms=6615）；④PCM 载荷字节序/声道交错（LE int16 已与参考一致）。

### 9.8 复跑命令

```bash
# 主工程
cd "/e/Zilux2开发" && dotnet build src/Zilux2/Zilux2.csproj -v q --nologo

# AP2 mock 自测（反射加载真实 dll，期望 passed=63 failed=0）
cd /c/Users/13329/AppData/Local/Temp/zilux2-airplay-harness
dotnet run -c Release -- --ap2 "E:\Zilux2开发\src\Zilux2\bin\Debug\net10.0-windows10.0.19041.0\Zilux2.dll"

# 真机（live2 临时工程，随机负载；主机 .183 白色，.136 黑色）
cd /c/Users/13329/AppData/Local/Temp/zilux2-ap2-live2
dotnet run --no-build -c Debug -- 192.168.31.183 20
```

## 10. 音频重传（控制通道 0x55 / 0xD6，2026-10-20 任务）

### 10.1 为什么需要

AP2 的音频走 UDP（dataPort），Wi-Fi 抖动/漫游会丢包；HomePod 等接收端发现序号空洞后会向**发送端的 UDP control 端口**（流 SETUP 里我们声明的 `controlPort`）发重传请求。不回应时表现为：短促爆音/卡顿，严重时接收端缓冲耗尽 → 掉音或拆会话。本实现是「发送端缓存 + 按请求重发原包」，只影响丢包时延，不影响正常播放（无丢包时完全静默）。

### 10.2 请求报文（接收端 → 发送端，发到本机 controlPort）

```
off 0: 0x80
off 1: 0x55            // 请求类型（低 7 位有效；高位可能带标记）
off 2-3: 0x0000        // 未使用
off 4-5: BE16 = 丢失的起始 RTP 序号 seq
off 6-7: BE16 = 请求重传的包数 count（设备通常 1..8，个别 32+）
```

共 8 字节。判据：`len >= 8 && (data[0] & 0xC0) == 0x80 && (data[1] & 0x7F) == 0x55`（兼容高两位版本标记）。

### 10.3 响应报文（发送端 → 接收端，发回请求来源地址:端口）

对请求的**每个序号**回一包：

```
[0x80, 0xD6, BE16 seq, <原始完整音频包>]
```

即 4 字节头 + 原样重发当初的音频包（12B RTP 头 + 密文 + 16B tag + 8B nonce，密文与 nonce 保持原值，接收端按原 nonce 解密）。**不要**重新加密、不要改 seq/时间戳。

### 10.4 实现要点（`src/Zilux2/AirPlay/Ap2/Ap2Connection.cs`）

- 发送 `SendAudioFrame` 成功时把整包写入环形缓存 `_audioHistory[1024]`，槽位 `seq & 1023`（与参考实现一致的 1024 深度，覆盖 44.1k/352 帧下约 8 秒音频）。
- control 端口接收循环（`DrainUdp`）校验 0x55 → `HandleControlPacket`：
  - `count` 上限 64（防放大攻击/风暴）；缺失槽位跳过并计入 `missingResends`。
  - 响应从**收包 socket** 发回请求来源（NAT/多网卡时比固定发设备端口可靠）。
- 统计（日志每 5 秒）：`resendRequests / resentPackets / missingResends`；公开属性 `ResendRequestsReceived`、`ResendResponsesSent`、`AudioHistoryCount`。
- 与 timing 响应（0xD3）共用同一 control socket；`0x52` / `0x55` 按 `data[1] & 0x7F` 区分。

### 10.5 无设备自测（已接入 mock，`passed=63 failed=0`）

`AirPlay2MockDevice` 用 `RequestResend(firstSeq, count)` 向发送端 control 端口发 0x55 请求，并用独立控制 socket 收 0xD6 响应；`AirPlay2LoopbackTest` 断言：history=音频包数、请求 190/3 后收到 seq=190/191/192 三个响应、发送端 `ResendResponsesSent==3`。真机丢包场景由 lead 换网络/远距离复测。

### 10.6 最终状态（2026-10-20 晚，产品链路）

- lead 用 `AirPlayStreamer`（采集线程 + 125 包/秒定速 sender）+ 本层（ALAC 载荷、PTP 主时钟、12B RTP 头、0xE0 首包、100ms PTP sync）在 **.136 黑色 HomePod mini 上真实出声**；接收端 `latencyMin/Max` 提到 300ms 后用户复听「干净了（没杂音）」。
- 本层与产品接口：`Ap2Connection.Connect / BeginStreaming / SendAudioFrame / SetVolume / Flush / Teardown`，`Ap2Options.LatencyMilliseconds`（产品默认 300）、`UseAlac`（产品为 true 时 audioFormat=1<<18，否则 PCM 2048）。
- 任务 重传仅鲁棒性增强，不改变已出声链路的默认行为。

## 11. 多设备投送：进程级共享 PTP 主时钟（任务，2026-10-20）

### 11.1 问题

单设备实现里每个 `Ap2Connection` 各自 `Ap2PtpLink.TryStart(localAddress, [Target.Host])`，第二条连接 bind UDP 319/320 会冲突或时钟分裂，导致第二台设备无法完成 phase2 SETUP。

### 11.2 实现（`src/Zilux2/AirPlay/Ap2/Ap2SharedPtp.cs`，新增）

- 进程级静态管理器：`lock` 保护，内部 `IAp2PtpMaster? _master`、`_localIp`、活跃租约列表。
- `Acquire(localIp, [deviceIp])`：首个租约真正调用 `Ap2PtpLink.TryStart(localIp, peers)`；后续租约只登记设备并 `SetPeers(并集)`；返回 `Ap2PtpLease : IAp2PtpMaster`（`ClockId`/`NowNs` 委派共享 master，`SetPeers` 更新本租约设备并 Apply）。
- `Release(lease)`：租约释放；引用计数归零才 `Dispose` master（日志 `clock released`）。
- 全进程唯一 `ClockId`：所有连接 SETUP#1 的 `timingPeerInfo.ClockID` 复用；`timingPeerList` 与 `SETPEERS` body 用**全部活跃端点**（各设备 IP + 本机 IP）；PTP master 实际发送 peer 只含设备 IP（见 §9.3）。
- 并发安全：Acquire/Release/SetPeers 全部加锁；日志 `[airplay] AP2 PTP shared: clock=0x… peers=N refs=M`。
- `Ap2Connection` 只在 PTP 模式 Acquire（`timingPeerInfo` 需要 ClockID），NTP 模式保持原行为；`Dispose` 时释放租约。

### 11.3 双设备真机验收（2026-10-20 07:36，.136 黑 + .183 白 同时投送 25s）

```text
[dual] 192.168.31.136: CONNECT OK dataPort=57352 controlPort=54355 event=True
[dual] 192.168.31.183: CONNECT OK dataPort=57797 controlPort=56201 event=True
[dual] 192.168.31.136: packets=3125 rate=124.9/s streamSetup=True alive=True teardown=200 statuses=[200,200,200,500,200]
[dual] 192.168.31.183: packets=3125 rate=124.9/s streamSetup=True alive=True teardown=200 statuses=[200,200,200,500,200]
[dual] exit=0
```

（statuses 里的 500 是 RECORD，AP2 路径按配方容错跳过；两台 phase2 SETUP 均 200。）

host.log 证据：单一 master `clock=0x57DE01D4B97C912C`，`refs=2 peers=2`；SETPEERS body = `[192.168.31.41, 192.168.31.136, 192.168.31.183]`；一台断开后 `refs=1 peers=1 (release)`，引用归零后 `clock released`。

注意：若产品进程（`Zilux2.exe`）同时在跑，它的 PTP 主时钟也会占本机 319/320（SO_REUSEADDR 可共存，但单播收包归属不确定；本机日志显示设备 Delay_Req 可能被另一进程收走）。这不影响 phase2 SETUP/音频链路；做 PTP 收包统计的隔离测试前应先关产品进程。

### 11.4 已知限制

- 跨进程不共享：两个进程各自起 master，接收端会同时收到两份 PTP（产品为单进程，无影响）。
- 设备下线要求显式 `Dispose` 连接才会 release；进程异常退出由系统回收。
- 时间线以本地墙钟 Unix 纳秒为基准（AirFlash 蓝本），多设备间按 PTP 报文延迟同步（亚毫秒~ms 级），未做房间级延迟校准。


