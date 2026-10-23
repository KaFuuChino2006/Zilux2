# AirPlay 投送：公开资料 / 开源实现交叉验证笔记

> 任务：Zilux2（Windows / C# / .NET 10 / WPF 音乐播放器）新增「AirPlay 投送」能力的外部资料调研，与队友的 TuneBlade 反编译结果互相印证。
> 产出范围：**仅公开资料 + 开源代码**，不含任何 TuneBlade 二进制分析结论。
> 作者：web-spec ｜ 日期：2026-10-20 ｜ 工作目录：`E:\Zilux2开发`

## 0. 方法与可信度标注

**标注约定**（文中每条结论都带标记 + 来源 URL）：

| 标记 | 含义 |
| --- | --- |
| 【源码确证】 | 我读了开源仓库的对应源码并给出 `文件:行号`，可逐行复核 |
| 【文档确证】 | 官方文档 / 项目 README / 协议说明页的明确表述 |
| 【社区经验】 | 论坛、issue、博客、第三方实现的说法，可能未经验证 |
| 【推断】 | 我的推理（基于上述证据链），需要实测确认 |

**本地源码快照**（调研期间浅克隆到 `research/airplay/web/.ref/`，**已清理、不属于交付物**；文中 `文件:行号` 均对应下列 commit，按上游 URL + commit 可完整复现）：

| 目录 | 上游 | commit | 许可 |
| --- | --- | --- | --- |
| `.ref/pyatv` | https://github.com/postlund/pyatv | `b277a4c` (2026-06-19) | MIT（LICENSE.md） |
| `.ref/shairport-sync` | https://github.com/mikebrady/shairport-sync | `cf6998d` (2026-10-15) | GPL-2.0（COPYING；`alac.c` 等个别文件另有 BSD 风格许可） |
| `.ref/airplay2-receiver` | https://github.com/openairplay/airplay2-receiver | `6c343d3` (2023-10-03) | 仓库内**未见 LICENSE 文件**（引用其思路/README，不抄代码） |
| `.ref/UxPlay` | https://github.com/FDH2/UxPlay | `d9e293d` (2026-10-19) | GPL-3.0 |

**关键结论先行**（供 Lead 快速决策，详情见后文）：

1. **先做经典 AirPlay 1（RAOP）是正确选择**：AirPort Express(第 2 代)、Apple TV(2/3 代)、macOS 接收器、以及大量第三方音箱走 TCP 7000 + RTSP + RTP/ALAC，**常规情况下不需要 HAP 配对**；而 HomePod / HomePod mini 实际上必须走 AirPlay 2（HAP 瞬态配对 + `shk` 加密）。【源码确证 + 推断，见 §1】
2. AP1 的音频格式**可以用 L16 裸 PCM 代替 ALAC**（pyatv 已这么做且通过了 AirPort Express / HomePod mini 的实测清单），MVP 可以省掉 ALAC 编码器，代价是带宽 1.41 Mbit/s。【源码确证，见 §6】
3. AirPlay 2 的配对 / 加密细节在 pyatv 里是**完整且 MIT 许可**的，可以逐行翻译成 C#；HAP 帧格式 = `2 字节小端长度 + 密文 + 16 字节 Poly1305 tag`，nonce = 8 字节小端计数器（补 4 个 0 前缀到 12 字节）。【源码确证，见 §2】
4. .NET 10 上没有"完美"的 mDNS 库：可用的是 Zeroconf 3.7.16（MIT、2024-12 发布、依赖 System.Reactive）与 Tmds.MDns 0.10.1（MIT、2026-09 发布、零依赖）；Makaretu 系已 7 年未发版。**自己实现 mDNS 查询是可行且不复杂的（约 500~800 行）**，AirPlay 场景只需要 PTR/SRV/TXT/AAAA 四类记录。【文档确证，见 §3】
5. 时间同步只要求"相对稳定"：经典 AirPlay 用 NTP 变体，**不需要系统时钟准确**；发送端按 1s 一次 sync 包 + 接收端 latency 窗口（推荐 2.0s）工作。Windows 的 15.6 ms 定时器粒度是最大坑，必须用 `Stopwatch` + 自旋/高精度定时器。【文档确证，见 §5】

---

## 1. 设备能力矩阵（决定先做哪条路径）

### 1.1 两种"AirPlay"在协议上的本质区别

| 维度 | 经典 AirPlay（RAOP / AirPlay 1） | AirPlay 2 |
| --- | --- | --- |
| 服务发现 | `_raop._tcp`（+ `_airplay._tcp` 辅助信息） | `_airplay._tcp`（`features` 位掩码 ≥ bit 38/48） |
| 控制通道 | **TCP 7000 明文 RTSP**（OPTIONS→ANNOUNCE→SETUP→RECORD…） | TCP 7000 RTSP，但**配对后整条通道被 HAP 帧加密** |
| 配对 | 一般**不需要**（除非 `pw=true` 或 flags 含 PIN 位）；即使要也是 RSASSA/AES-RSA 老式密码，不是 HAP | **必须** HAP `pair-setup-pin`（HomePod 用瞬态模式，PIN 固定 3939）+ `pair-verify` + `auth-setup` |
| 音频传输 | 3 条 UDP：audio / control(sync+重传) / timing(NTP) | 3 条 UDP 同上，但负载是 **ChaCha20-Poly1305** 加密的，key = SETUP 里的 `shk` |
| 流控 | `RECORD` 后立即按 RTP 时间戳发包 | 额外有 `SETUP` plist（含 `streams[].shk/ct/spf/type`）、`/feedback` keep-alive、事件通道 |

来源：pyatv 协议文档 https://github.com/postlund/pyatv/blob/master/docs/documentation/protocols.md （AirPlay 章 1161 行起、AirPlay 2 章 1525 行起）【文档确证】；pyatv 源码 `pyatv/protocols/raop/__init__.py`、`airplayv1.py`、`airplayv2.py`【源码确证】。

### 1.2 逐设备矩阵

| 设备 | 经典 AP1(RAOP) | AirPlay 2 | 配对要求 | 免配对投送条件 | 证据等级 |
| --- | --- | --- | --- | --- | --- |
| **AirPort Express 第 2 代**（802.11n, 2012） | ✅ | ✅（固件 **7.8** 起） | 不需要（`et=0,4` → 无加密） | 默认即可投送 | 【文档确证】Apple 支持页 https://support.apple.com/en-us/106643 原文："Firmware update 7.8 adds AirPlay 2 support to 802.11n AirPort Express base stations." |
| **AirPort Express 第 1 代**（802.11g） | ✅ 但 `et=1`（RSA 加密） | ❌ | 需要老式 **RSA/AES** 密钥交换（`rsaaeskey`/`aesiv`） | 不能免配对 | 【源码确证】SDP 带 `a=rsaaeskey`/`a=aesiv` 时，shairport-sync `rtsp.c:3490-3512` 用 `rsaaeskey` 经 `rsa_apply(..., RSA_MODE_KEY)` 解出 16 字节 AES key；pyatv TXT `et` 取值表（0=unencrypted,1=RSA,3=FairPlay,4=MFiSAP,5=FairPlay SAPv2.5） |
| **Apple TV 第 2/3 代** | ✅ | ❌ | 不需要 | 默认即可投送（AirPlay 1 时代设备） | 【文档确证】pyatv `docs/documentation/supported_features.md` 的已验证清单把 Apple TV 3 (tvOS 8.4.4) 列在 RAOP 音频流下 |
| **Apple TV HD / 4K** | ⚠️ 兼容 AP1 控制，但新固件默认 AP2 | ✅ | **不需要**（可选 PIN 配对） | 默认即可投送；AP2 是首选路径 | 【文档确证】pyatv 已验证清单含 Apple TV 4K (tvOS 14.5)；pyatv 文档：Apple TV 可以显示 PIN，因此支持常规配对 |
| **HomePod（初代）** | ❌（官方口径：AirPlay 2 设备） | ✅ **必须** | **瞬态配对（transient pairing）**：PIN 固定 `3939`，无 UI 交互 | 传输层仍要 pair-setup + pair-verify + auth-setup；用户侧"无需操作" ≠ "协议上免配对" | 【源码确证（配对机制）+ 推断（不支持 AP1，依据：pyatv 自动判 AP2 的 features 位、TuneBlade 目标列表无 HomePod）】pyatv `pyatv/protocols/airplay/auth/hap_transient.py:30` `TRANSIENT_PIN = 3939`；`docs/development/atvproxy.md`："HomePods use transient pairing and do not need credentials." |
| **HomePod mini** | ❌ | ✅ 必须 | 同上（瞬态 3939） | 同上 | 同上 + pyatv 已验证清单（HomePod mini, 14.5） |
| **macOS 12 Monterey+ 的"隔空播放接收器"** | ❓**未确证** | ✅（系统功能即 AP2 接收器） | 未知；pyatv 明确把 `Mac\d+,\d+` 型号列为**不支持配对**（`UNSUPPORTED_MODELS`），说明它不属于"可被 HAP 常规配对的设备" | 系统设置里"允许以下用户"= 任何人时，iOS 无需确认即可投送；但第三方发送端能否跳过 pair-verify **待实测** | 【源码确证】pyatv `pyatv/protocols/airplay/utils.py:34` `UNSUPPORTED_MODELS = [r"^Mac\d+,\d+$"]`；【推断】其余为推断 |
| **第三方 AirPlay 音箱**（Sonos、Yamaha、Bose、Shairport 系） | ✅ 绝大多数 | 少数新机型 ✅ | 一般不需要 | 默认即可投送 | 【文档确证】pyatv 已验证清单含 Yamaha RX-V773、airplay2-receiver、shairport-sync；TuneBlade 官网目标列表（见下） |

**TuneBlade 的目标设备列表是"经典 AP1 能覆盖谁"的强证据**【文档确证】：
http://www.tuneblade.com/ 原文："TuneBlade … stream … to AirPort Express, Apple TV, AirPlay enabled speakers and HiFi receivers, and to AirPlay audio receiving applications such as ShairPort, XBMC/Kodi and TuneAero"，并列出 Sonos One/Beam/Playbase/Play:5(2nd gen)、免费版每 10 分钟断流、支持 Windows Vista~10。
→ **该列表里没有 HomePod、没有 macOS 接收器、没有 AirPlay 2**。TuneBlade 是纯 AP1 发射端，其支持矩阵正好等于我们的 MVP 目标集合。

### 1.3 免配对/免确认的判定规则（可直接写进 C# 探测逻辑）

对 `_airplay._tcp` 的 TXT 记录做如下判断（pyatv 源码逐条对应）：

1. `acl`（Access Control Level）：
   - `acl=0` → 无限制；`acl=1` → **同家庭设备才可投送**（第三方发送端应视为"不可用"）。
   【源码确证】pyatv `utils.py`：`PairingRequirement.Disabled`，注释原文 "Access control might say that pairing is not possible, e.g. only devices belonging to the same home (not supported by pyatv)"。
2. `flags` / `sf` / `ft` 的 **PIN_REQUIRED (0x8)** 或 **LEGACY_PAIRING (0x200)** 置位 → `PairingRequirement.Mandatory`。【源码确证】pyatv `utils.py:139-157`（`get_pairing_requirement`），docstring："Bit 0x200 is set in sf (AirPlay v1)/flags (AirPlay v2). But 0x8 set in sf/flags"。
3. `act=2`（Current User）→ pyatv 判 `Unsupported`（HomePod 系列经常带这个值）。
4. `pw=true` 或 `PASSWORD_BIT (0x80)` → 需要密码（经典 RAOP 密码保护）。【源码确证】`is_password_required`。
5. 其余情况 → `NotNeeded`（乐观假设，后续 SETUP 阶段可能才报错）。

**"HomePod 允许任何人" 这类设置影响的是 ACL/权限层，不会把 AP2 传输层变回 AP1。** 家庭 App 里的「允许访问」选项只是让 iOS 端少一次确认；对第三方发送端来说，HomePod 仍然要求瞬态 pair-setup + pair-verify + `shk` 加密。【推断】依据：HomePod 在 pyatv 的 `is_remote_control_supported` 分支中被特判（`model.startswith("AudioAccessory")` 且必须 `credentials == TRANSIENT_CREDENTIALS`），说明协议层不认"无凭证"，只认"瞬态凭证"。

### 1.4 结论：先做哪条路径

**MVP 走 AP1（`_raop._tcp` + TCP 7000 + RTP/ALAC 或 L16），完整版再加 AP2 分支。** 理由：
- AP1 无配对、无加密、可用明文抓包调试，工程量约为 AP2 的 1/3；
- 覆盖 AirPort Express 2、Apple TV、第三方音箱、Shairport 系（TuneBlade 十多年产品验证）；
- AP2 独有的只是 HomePod / 新版 Apple TV / HomePod mini，且其配对链（SRP+HAP+ChaCha）在 pyatv 里有 MIT 许可的完整参考；
- 但 **macOS 接收器是"待实测"的灰区**——它出现在 MVP 需求里，却无法从公开资料确证其支持 AP1。必须先用 §7.1 的 30 分钟探针脚本验证，再决定是否把它写进 MVP 验收标准。

---

## 2. AirPlay 2 配对与加密的字节级细节

> 以下全部来自 pyatv（MIT）与 shairport-sync（GPL，仅作阅读参考，不抄代码）源码。pyatv 是 HomePod/Apple TV 在用的实现，可信度高；`file:line` 可复核。

### 2.1 HAP TLV8 字典（配对消息的报文单元）

【源码确证】`pyatv/auth/hap_tlv8.py:6-48`：

| type | 名称 | 用途 |
| --- | --- | --- |
| `0x00` | Method | 1=pair-setup, 2=pair-verify, 3=add pairing… |
| `0x01` | Identifier | 对端标识（用户名 / pairing id） |
| `0x02` | Salt | SRP / HKDF 用的 salt |
| `0x03` | PublicKey | SRP `A`/`B` 或 Curve25519 公钥（32B） |
| `0x04` | Proof | SRP `M1`/`M2` 证明；pair-verify 里是**被加密的 Ed25519 签名** |
| `0x05` | EncryptedData | 加密的 pairing 数据（如 PS-Msg05/PV-Msg02） |
| `0x06` | SeqNo | 状态号 M1..M6 |
| `0x07` | Error | 错误码（1=Unknown,2=Authentication,3=BackOff,4=MaxPeers,5=MaxTries,6=Unavailable,7=Busy） |
| `0x08` | BackOff | 重试等待秒数 |
| `0x09` | Certificate | MFi 证书（auth-setup 响应 1076B 那个） |
| `0x0A` | Signature | 签名 |
| `0x0B` | Permissions | 权限 |
| `0x0C/0x0D` | FragmentData/FragmentLast | 长值分片（>255B 自动分块，`hap_tlv8.read_tlv` 会拼回） |
| `0x11` | Name | Apple 内部（设备名） |
| `0x13` | Flags | 配对标志；**`0x10` = TransientPairing** |

> 注意：网上一些逆向文章把 `0x03` 说成 "Proof"、`0x04` 说成 "EncryptedData"，是错的——以 HAP 规范 / pyatv 枚举为准。

### 2.2 pair-setup-pin（状态机 M1..M6）

【源码确证】`pyatv/auth/hap_srp.py`（SRP-6a 实现）、`pyatv/protocols/airplay/pairing.py`（AirPlay 层封装）、`pyatv/auth/hap_session.py`（消息封装）：

| 步骤 | 方向 | 携带 TLV | 说明 |
| --- | --- | --- | --- |
| M1 | C→R | `0x00=1`(pair-setup), `0x06=1`(M1), `0x00` 内层 Method | 请求开始 |
| M2 | R→C | `0x06=2`, `0x02`=Salt, `0x03`=SRP `B` | 接收端给 salt 与公钥 |
| M3 | C→R | `0x06=3`, `0x03`=SRP `A`, `0x04`=SRP `M1` proof | 客户端算 `S` 与 `M1` |
| M4 | R→C | `0x06=4`, `0x04`=SRP `M2` proof | 服务端校验 |
| M5 | C→R | `0x06=5`, `0x05`=**加密的** `{0x01 Identifier,0x03 LTPK,0x0A Signature}` | 见 2.3 |
| M6 | R→C | `0x06=6`, `0x05`=**加密的** `{0x01 Identifier,0x03 LTPK,0x0A Signature}` | 双方交换长期公钥后，派生 `shared secret` |

**SRP 参数**【源码确证】`hap_srp.py`：`SRPContext("Pair-Setup", str(pin), prime=PRIME_3072, generator=PRIME_3072_GEN, hash=sha512)` → **3072-bit N、g=5、SHA-512**（用户名固定 `"Pair-Setup"`，HomePod 瞬态模式 PIN=`"3939"`）。
**派生**：`SRP` 会话密钥 `S` 经 **HKDF-SHA512** 导出 32 字节；后续每把子密钥都从 `shared secret` 再用 HKDF 派生（salt/info 见 2.4）。

### 2.3 M5/M6 的加密结构（pair-setup 内的数据保护）

【源码确证】`hap_srp.py:160-200`、`hap_session.py`：

1. 先算 `device_x = HKDF(salt="Pair-Setup-Controller-Sign-Salt", info="Pair-Setup-Controller-Sign-Info", key=shared_secret, 32B)`；
2. `iOSDeviceX = device_x || identifier(UTF-8 用户名) || LTPK(32B Ed25519 公钥)`；
3. `signature = Ed25519_sign(LTSK, iOSDeviceX)`；
4. 组装 `sub_tlv = {0x01: identifier, 0x03: LTPK, 0x0A: signature}`；
5. 用 `enc_key = HKDF("Pair-Setup-Encrypt-Salt", "Pair-Setup-Encrypt-Info", shared_secret)` 的 **ChaCha20-Poly1305** 加密，**nonce = ASCII "PS-Msg05"/"PS-Msg06"（8 字节，前补 4 个 0x00）**；
6. 最终 M5/M6 的 `0x05` 值 = 上面加密后的密文 + tag。

> 这就是"pair-setup 最后一步为什么不只是明文换公钥"的原因；**HomePod 的瞬态配对只跑 M1~M4 + pair-verify**，M5/M6 可跳过（无长期凭证）。

### 2.4 pair-verify（Curve25519 + Ed25519）

【源码确证】`hap_srp.py:60-110`、`pyatv/auth/hap_pairing.py`、`hap_transient.py`：

| 步骤 | 内容 |
| --- | --- |
| M1 | C 生成一次性 **Curve25519** 密钥对 `(c_priv, c_pub)`；发 `{0x06=1, 0x03=c_pub}` |
| M2 | R 生成 `(r_priv, r_pub)`，`shared = X25519(r_priv, c_pub)`；回 `{0x06=2, 0x03=r_pub, 0x05=enc}`；其中 `enc = ChaCha20Poly1305(key=HKDF("Pair-Verify-Encrypt-Salt","Pair-Verify-Encrypt-Info",shared), nonce="PV-Msg02", plaintext={0x01: r_identifier, 0x0A: Ed25519_sign(r_LTSK, r_pub||r_identifier||c_pub)})` |
| M3 | C 验签后回 `{0x06=3, 0x05=enc2}`，`enc2 = ChaCha20Poly1305(同上key, nonce="PV-Msg03", plaintext={0x01: c_identifier, 0x0A: sign(c_LTSK, c_pub||c_identifier||r_pub)})` |
| M4 | R 回 `{0x06=4}`，pair-verify 完成；此后 `shared` 作为 **`shk` 之外的会话主密钥**（用于派生 control/event/data 通道密钥） |

**签名内容顺序很重要**：`本地公钥 || 本地标识 || 对端公钥`（pyatv 的 `verify1`/`verify2` 顺序如此）。写 C# 时按 pyatv 的参数顺序抄，不要自己"合理调整"。

### 2.5 通道密钥派生表（HKDF-SHA512，全部 32 字节）

【源码确证】`hap_srp.py:91,172-179`（pair-verify/pair-setup 部分）+ `pyatv/auth/hap.py`（control 通道）+ shairport-sync `pair_ap/pair_homekit.c` 的 `pair_keys_map`（交叉验证一致）：

| 用途 | salt | info | 备注 |
| --- | --- | --- | --- |
| pair-setup M5 加密 | `Pair-Setup-Encrypt-Salt` | `Pair-Setup-Encrypt-Info` | ChaCha20-Poly1305，nonce="PS-Msg05"/"PS-Msg06" |
| pair-setup 控制器签名 | `Pair-Setup-Controller-Sign-Salt` | `Pair-Setup-Controller-Sign-Info` | 见 2.3 |
| pair-setup 接收端签名 | `Pair-Setup-Accessory-Sign-Salt` | `Pair-Setup-Accessory-Sign-Info` | M6 对端 |
| pair-verify 加密 | `Pair-Verify-Encrypt-Salt` | `Pair-Verify-Encrypt-Info` | nonce="PV-Msg02"/"PV-Msg03" |
| RTSP control 通道（发送） | `Control-Salt` | `Control-Write-Encryption-Key` | 发送端→接收端方向 |
| RTSP control 通道（接收） | `Control-Salt` | `Control-Read-Encryption-Key` | 接收端→发送端方向 |
| event 通道（发送/接收） | `Events-Salt` | `Events-Write-Encryption-Key` / `Events-Read-Encryption-Key` | **发送端要反用方向**（通道在协议上由接收端发起，见 pyatv protocols.md 1753 行） |
| data 通道（MRP） | `DataStream-Salt<seed>`（seed 为 SETUP 里给出的十进制无符号 64 位） | `DataStream-Output-Encryption-Key` / `DataStream-Input-Encryption-Key` | pyatv protocols.md 1804 行 |
| AP2 音频 RTP 包 | **不用 HKDF**：直接用 SETUP plist 里的 `shk`（32 字节固定 ChaCha20-Poly1305 密钥） | — | shairport-sync `rtsp.c:2658` 注释原文 "session key is used later as a fixed 32-byte ChaCha20-Poly1305-IETF key" |

### 2.6 "验证后 RTSP 是否被加密" / HAP 帧格式 / 音频包加密

**(a) RTSP 明文 → 加密的切换点**：pair-verify 成功后，**TCP 7000 上后续所有 RTSP 请求/响应都被 HAP 帧包裹**（包括 ANNOUNCE/SETUP/RECORD）。收包时必须先按帧解密再交给 RTSP 解析器。shairport-sync 接收端实现 `rtsp.c` 的 `read_encrypted()`/`write_encrypted()`；pyatv 对应 `hap_session.py` 的 `HapSession` 包装 socket。

**(b) HAP 帧格式**【源码确证】`pyatv/auth/hap_session.py`：
```
[2 字节 little-endian 长度 N][N 字节密文][16 字节 Poly1305 tag]
```
- 加密：`ChaCha20-Poly1305-IETF`，`nonce = counter.to_bytes(8,'little')` 再前置 4 个 `0x00`（12 字节；`pyatv/support/chacha20.py` 默认 `nonce_length=8`），**每帧 counter+1，从 0 开始**；
- **AAD = 那 2 字节长度字段本身**（pyatv 解密时 `decrypt(block, aad=length_bytes)`，加密时反向）——这是个容易写错的地方；
- 明文超过 1024 字节需拆多帧（HomeKit 规定块上限 1024；AirPlay 不强制，但跟随更安全）。来源：https://github.com/postlund/pyatv/blob/master/docs/documentation/protocols.md （AirPlay 2 → Encryption 节，引用 HAP 规范 5.2.2 Release R1）。

**(c) AP2 音频 RTP 包加密**【源码确证，shairport-sync `rtp.c:1505-1568` `decipher_player_put_packet()` + pyatv `airplayv2.py`/`chacha20.py` 交叉一致】：

```
[2B seq BE][4B RTP timestamp BE][4B SSRC][密文 ...][16B tag][8B nonce]
```
- **AAD = 偏移 2..10 的 8 字节**（即 `timestamp(4B) + SSRC(4B)`；**seq 不参与 AAD**）；
- 密文长度 = 总长 − 10 − 8（含 16B tag）；
- **nonce = 包尾那 8 字节**（发送端随机生成，直接附在密文后），12 字节 nonce = 4 个 0x00 + 这 8 字节；
- key = SETUP plist 的 `shk`（32B）；
- 实现：libsodium `crypto_aead_chacha20poly1305_ietf_decrypt`；.NET 对应 `System.Security.Cryptography.ChaCha20Poly1305`（.NET 5+ 内置，无需 BouncyCastle）。

**(d) 控制 UDP 通道**（`controlPort`）在 AP2 下有 2 种包：
- `packet[1]==0xD6`：AP2 per-packet 加密的音频（上面 c），前 6 字节是 AP2 control 头，之后才是上面的结构；
- `packet[1]==0xD7`（anchoring announcement，0xD7=215）：携带 `8B remote_packet_time_ns`、`8B clock_id`、`4B frame_1`、`4B frame_2`；`stream_specified_latency = frame_2 − frame_1`，正常 = **77175 帧**；另有 `ap2_realttime_stream_latency_fudge_factor = 11025` 帧。【源码确证】`shairport-sync/rtp.c` 对应分支。

### 2.7 AP2 的 `auth-setup`（MFi 步骤，不能省）

【文档确证】pyatv protocols.md（/auth-setup 节，来源 owntone `src/outputs/raop.c` L1568）+ openairplay 规范 https://openairplay.github.io/airplay-spec/ （本地快照 `evidence/authsetup.txt`）：
```
POST /auth-setup RTSP/1.0
Content-Type: application/octet-stream
Content-Length: 33

[1 字节加密类型: 0x01=明文 / 0x02=MFi-SAP 加密] [32 字节 Curve25519 公钥]
```
- 对要求该步骤的设备，"只发请求、不处理响应"也能继续（响应体是 1076 字节 MFi 证书，pyatv 直接忽略）；
- 设备不需要时返回 403 或 200 空体，都可继续；
- AP2 流程顺序（pyatv `airplayv2.py`）：`OPTIONS` → `POST /pair-setup`(瞬态) → `POST /pair-verify` → `POST /auth-setup` → `ANNOUNCE` → `SETUP(plist)` → `RECORD` → UDP 音频 + `/feedback`。

### 2.8 AP2 `SETUP` 的 plist 关键字段（最容易卡住的地方）

【源码确证】pyatv `protocols/raop/airplayv2.py` 与 shairport-sync `rtsp.c` AP2 分支：

| plist key | 典型值 | 说明 |
| --- | --- | --- |
| `streams[0].type` | `0x60` (96) realtime / `0x67` (103) buffered / `0x82` (130) remote-control | 音频流用 96 或 103；shairport 只接受 96/103 |
| `streams[0].ct` | `1` | compression type；pyatv 用 **1 = 原始 PCM(L16)**；`2=ALAC`、AAC 见 shairport 注释指向 emanuelecozzi 的 audio 页 |
| `streams[0].spf` | `352` | frames per packet（ALAC 固定 352；pyatv AAC 才改） |
| `streams[0].sr` | `44100` | sample rate |
| `streams[0].shk` | 32B | **音频 RTP 加密密钥**（见 2.6c） |
| `streams[0].audioFormat` | buffered 分支用 | 初始音频格式（0x40000=ALAC/44100/16/2 等，取值见 emanuelecozzi 文档；仅 buffered 流需要） |
| `deviceID` / `sessionUUID` | MAC / UUID | 设备标识 |
| `timingPort` + `timingProtocol` | `"NTP"` | AP2 发送端仍用 NTP 时序（接收端内部用 PTP） |
| `controlPort` | 随机 | 发送端在此端口收 control/sync 包 |
| `isMedia` / `latencyMin=11025` / `latencyMax=88200` / `supportsDynamicStreamID=false` | — | AP2 的 latency 窗口：0.25s ~ 2s |
| 响应 `eventPort` | 随机 TCP | 可选的 event 通道；连接后要发 `POST /command`，**必须回 200，否则 30s 超时断连** |

> `type=130`（remote control）是**独立的 Remote-Control 会话**，pyatv 只在"要控制 Apple TV"时才建；纯音频投送（`isRemoteControlOnly` 不置位）**不需要** event 通道和 data 通道。这意味着 Zilux2 若只做"放歌"，AP2 的分支可以只实现 audio 通道（大幅减少工作量）。【推断，依据 pyatv `airplayv2.py` 的 `_setup_remote_control` 分支与 protocols.md §AirPlay 2 Remote Control 的条件描述】

### 2.9 AP1 通道的明文细节（对照用）

【文档确证】pyatv protocols.md §RAOP（1240-1460 行）+【源码确证】`pyatv/protocols/raop/*.py`：

- **ANNOUNCE SDP 模板**（原样可用）：
  ```
  v=0
  o=iTunes 4018537194 0 IN IP4 10.0.10.254      ; 第二个数字是 session id，与 rtsp://<ip>/<id> 一致
  s=iTunes
  c=IN IP4 10.0.10.84                            ; 接收端地址
  t=0 0
  m=audio 0 RTP/AVP 96
  a=rtpmap:96 AppleLossless
  a=fmtp:96 352 0 16 40 10 14 2 255 0 0 44100
  ```
  `fmtp` 逐字段：`352`=每包帧数、`0`=ALAC 版本、`16`=位深、`40`=history mult、`10`=initial history、`14`=rice limit、`2`=声道、`255`=max run、`0`=max coded frame size、`0`=avg bitrate、`44100`=采样率。**L16 变体**：`a=rtpmap:96 L16/44100/2`（pyatv `support/rtsp.py` 的 `ANNOUNCE_PAYLOAD`，位深仍 16）。
- **SETUP**：请求头 `Transport: RTP/AVP/UDP;unicast;interleaved=0-1;mode=record;control_port=<本端>;timing_port=<本端>`；响应 `Transport: RTP/AVP/UDP;unicast;mode=record;server_port=<接收端音频端口>;control_port=<同步端口>;timing_port=<时序端口>` + `Session: 1` + `Audio-Jack-Status: connected`。
- **RECORD**：`Range: npt=0-` + `RTP-Info: seq=<16bit 随机>;rtptime=<32bit 随机>`（**必须与首包 RTP 头一致**）；响应含 `Audio-Latency: 3035`（该值是**帧数**，44100 下 ≈ 68.8 ms，部分实现直接给 44100/88200 等）。
- **RTP 头**：标准 12 字节（V=2, P=0, X=0, CC=0, M, PT=0x60, seq, timestamp, SSRC）；**首包置 marker 位**、之后每 352 帧 +352；SSRC 用 SETUP 响应里的 `Session` 值。
- **control 通道 sync 包**（pyatv `stream_client.py`，每秒 1 次）：
  - 12 字节；`byte0 = 0x90`（首包）/`0x80`；`byte1 = 0xD4`；`byte2-3 = 0x0007`；
  - 后面跟 `RTP timestamp (4B)`、`NTP seconds (4B)`、`NTP fraction (4B)`；
  - `timestamp = now + latency`，`NTP now = rtptime − latency`（**发送端时间基准**，接收端据此对齐）；
  - **latency 默认 22050 + 44100 = 66150 帧 = 1.5 s**（pyatv `protocols/raop/protocols/__init__.py:28,51`：`self.latency = 22050 + self.sample_rate`；经典接收端允许 2.0~2.25s，shairport README 明确说"经典源通常设 2.0~2.25 秒"）。
- **重传**：接收端在 control 通道发 `[0x55][seq 2B][count 2B]` 请求补包；发送端需保留最近 ~2s 的 RTP 包环形缓冲（pyatv `stream_client.py` 的 `_handle_retransmit`）。

---

## 3. .NET 10 上的 mDNS

### 3.1 NuGet 候选对比（数据抓取自 nuget.org API，2026-10）

| 包 | 最新版 / 发布日 | 许可 | 目标框架 | 依赖 | 维护状态 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| **Zeroconf**（novotnyllc） | 3.7.16 / **2024-12-17** | MIT | net8.0 + netstandard2.0 | System.Reactive ≥5.0.0 | 仓库 2026-10-08 仍有 push，活跃 | ✅ 最省事；Rx 依赖略重；`ZeroconfResolver.ResolveAsync("_raop._tcp.local.")` 一行出结果 |
| **Tmds.MDns** | 0.10.1 / **2026-09-28** | MIT | net8.0 + netstandard2.0 | 无 | 发布很新，但仓库 README 已 404（文档缺失） | ✅ 零依赖、API 简洁（`Browser` 事件）；适合快速验证 |
| **Makaretu.Dns.Multicast** | 0.27.0 / **2019-11-05** | MIT | netstandard2.0 | Makaretu.Dns 2.0.1(2019) + IPNetwork2 + Tmds.LibC | 7 年未发版；仓库 2024-04-24 有 push，未归档 | ⚠️ 功能最全（多网卡/IPv6/子类型/反向解析），但版本老旧、依赖链已停更；短期试验可用 |
| **Makaretu.Dns** | 2.0.1 / 2019 | MIT | netstandard2.0 | — | 停更 | ❌ 仅作 Multicast 的依赖 |
| **Mono.Zeroconf** | 0.9.0 / **2011** | 未确证（LGPL 系） | net20/net40 | **原生 Bonjour(dns_sd.dll)** | 死项目 | ❌ 部署需装 Bonjour，不推荐 |

来源：https://www.nuget.org/packages/Zeroconf 、https://www.nuget.org/packages/Tmds.MDns 、https://www.nuget.org/packages/Makaretu.Dns.Multicast 、https://www.nuget.org/packages/Mono.Zeroconf （元数据经 NuGet registration API 抓取）【文档确证】。

### 3.2 P/Invoke 系统 `dns_sd.dll` 的可行性

- Windows 自带 **没有** Bonjour；`dns_sd.dll` 只随 **Apple Bonjour Print Services / iTunes / iCloud for Windows** 安装。用户在客户机上装 Zilux2 时不该被迫装 iTunes。【社区经验】
- 因此 P/Invoke 方案（`DNSServiceBrowse` / `DNSServiceResolve` / `DNSServiceGetAddrInfo`）只适合"检测到已安装就加速"的旁路，不适合作为主路径。
- 若走此法，DLL 搜索路径要防 DLL 劫持（使用 `AddDllDirectory`/绝对路径加载），且要处理 32/64 位后缀差异。谨慎。

### 3.3 零依赖自实现 mDNS 查询：可行性评估 + 最小实现要点

**结论：完全可行，推荐作为主方案。** AirPlay 发现只需要"发一次 PTR 查询 + 解析应答里的 SRV/TXT/AAAA"，不需要 responder、不需要缓存维护、不需要服务发布（Zilux2 只做 sender）。估算 **500~800 行 C#（含 UTF-8 压缩名解析）**，无外部依赖，可跨 .NET 10 / Windows 10/11。

最小实现要点（按 RFC 6762 / 6763，来源 https://www.rfc-editor.org/rfc/rfc6762 、https://www.rfc-editor.org/rfc/rfc6763 ）：

1. **套接字**：`Socket(AF_INET, Dgram, Udp)`，`ReuseAddress=true`（必须，才能与系统 Bonjour 共存），绑定 `0.0.0.0:5353`；**入站组播要求绑定 INADDR_ANY，不能绑单播地址**。
2. **加入组播组**：IPv4 `224.0.0.251`；IPv6 `ff02::fb`（每个网卡单独 `IPv6MulticastOption`，`InterfaceIndex` 取 `NetworkInterface.GetAllNetworkInterfaces()` 的 IPv6 index）。多网卡时对每个"已启用且非环回"的网卡 `JoinMulticastGroup`（或每网卡一个 socket，便于控制出口网卡）。
3. **发送**：`MulticastTTL = 255`（RFC 6762 要求）、`MulticastLoopback = true`、`ExclusiveAddressUse=false`；查询包一次发一个"问题集"：`_raop._tcp.local.` PTR、`_airplay._tcp.local.` PTR，以及可选 `_raop._tcp.local.` 的 SRV/TXT（QDCOUNT=2~4）。标志位 `flags=0x0000`（标准查询，不要置 QR/AA）。
4. **DNS 报文**：header 12 字节（ID=0、flags、QDCOUNT/ANCOUNT/NSCOUNT/ARCOUNT）；name 用**标签长度前缀**格式并以 `0x00` 结尾；**读应答时必须支持压缩指针**（`0xC0` 高位，offset 指向报文前部）——这是手写 mDNS 最容易崩的地方，务必先写单测。
5. **应答解析**：一次应答通常含 `PTR`（服务实例名，附加段里带 `SRV`/`TXT`/`AAAA`/`A`）。收集三元组：`实例名`（`Name._raop._tcp.local.`）、`SRV.target:port`、`TXT key=value`（AirPlay 靠 `features/ft`、`et`、`cn`、`sr`、`pk`、`pw`、`acl`、`model` 等）、`AAAA/A` 地址。**优先用附加段（additional）里的记录**，没有就再单独发 SRV/TXT 查询（大多数设备一次应答就带全）。
6. **超时/重试**：首次查询后 1s、2s 再各发一次（RFC 建议初始间隔随机 20~120ms 防风暴，之后 1s 翻倍）；设备列表 UI 用 2~3s 的"发现窗口"即可。
7. **IPv6**：链路本地 `fe80::` 地址**必须带 scope id**（`IPAddress.ScopeId = 网卡索引`）才能用于 TCP 连接；mDNS 应答里可能出现无 scope 的 fe80，需按收到的接口补 scope。MVP 建议优先 IPv4（同网段设备几乎都有 A 记录），IPv6 作为 fallback。
8. **Windows 特有坑**：系统可能有 `mDNSResponder`/Bonjour 已在 5353 监听（iTunes 用户）；`ReuseAddress` 下双方都能收组播，但**单播回包可能只到其中一个 socket**——所以查询包要显式要求组播应答（QU bit=0）；Hyper-V/WSL/VPN 虚拟网卡会被枚举出来，查询要跳过（`OperationalStatus != Up`、`NetworkInterfaceType` 为 `Tunnel`/`Loopback`、或没有默认网关的接口），否则会出现"发到错误网卡、收不到应答"的经典问题。来源：Windows `SocketOptionName.ReuseAddress` 文档 + RFC 6762 §15.1。【文档确证 + 社区经验】

**若不想手写，推荐顺序**：`Tmds.MDns`（零依赖，先跑通）→ `Zeroconf`（若需要更稳的事件流/多网卡）→ 自实现（最终形态，去除 System.Reactive 依赖）。三条路的技术风险都远低于 AP2 加密。

---

## 4. 开源发射端参考：可直接借鉴的具体细节

| 项目 | 许可 | 语言 | 可借鉴处 | 不宜照抄处 |
| --- | --- | --- | --- | --- |
| **pyatv** https://github.com/postlund/pyatv | MIT | Python | **AP1+AP2 发送端全流程**：RTSP 客户端、ANNOUNCE SDP、SETUP、RTP 打包/重传、sync 包、AP2 plist SETUP、HAP 配对（SRP/TLV8/ChaCha）、NTP 时序。`pyatv/protocols/raop/{__init__,stream_client,airplayv1,airplayv2,audio_source}.py` + `pyatv/auth/*` | Python 异步结构；`audio_source.py` 依赖 ffmpeg 转码 |
| **shairport-sync** https://github.com/mikebrady/shairport-sync | GPL-2.0 | C | **接收端**，是最好的"字节级照妖镜"：`rtsp.c`（SDP/transport 解析、SETUP 各字段、AP2 plist）、`rtp.c`（AP2 音频解密布局、control 包 0xD6/0xD7）、`player.c`（SSRC→编解码选择）、`AIRPLAY2.md`（延迟/格式矩阵）、`pair_ap/`（HAP 配对，含瞬态 3939） | GPL：只能读思路，不能把代码抄进闭源产品 |
| **pair_ap** https://github.com/ejurgensen/pair_ap | MIT | C | **HAP 配对的独立 C 实现**（shairport/owntone 共用）：TLV8、SRP 3072、Curve25519、pair-setup/pair-verify 全套，代码量小，最适合对照翻译成 C# | — |
| **airplay2-receiver** https://github.com/openairplay/airplay2-receiver | 未见 LICENSE | Python | **AP2 接收端的协议流程**（wiki 有 AirPlay2 协议笔记：https://github.com/openairplay/airplay2-receiver/wiki/AirPlay2-Protocol ）；README 提到 macOS Ventura 需关闭系统"隔空播放接收器"以释放 7000 | 无许可证，只参考思路 |
| **UxPlay** https://github.com/FDH2/UxPlay | GPL-3.0 | C++ | AP2 镜像/音频接收、FairPlay 老式配对（`lib/pairing.c` 的 `Pair-Setup-AES-Key`/`Pair-Verify-AES-Key`）；README 明确 "AirPlay2 multi-room audio streaming is not supported: use shairport-sync" | 同 GPL 限制 |
| **owntone-server** https://github.com/ejurgensen/owntone-server | GPL-2.0 | C | `src/outputs/raop.c`：经典 RAOP 发射端实现（pyatv 的 `/auth-setup` 就抄自它 L1568；Curve25519 公钥硬编码 L276） | GPL |
| **openairplay 非官方规范** https://openairplay.github.io/airplay-spec/ | 文档 | — | 服务发现、`/pair-setup`、`/pair-verify`、`/auth-setup`、RTP、音频格式章节；措辞比抓包博客规范 | 部分章节过时（AP1 时代） |
| **nto.github.io/AirPlay** https://nto.github.io/AirPlay.html | 文档 | — | 2011 年最完整的 AP1 逆向文档：RTSP 方法、SDP、RTP、加密类型、照片/视频 | 非常老，AP2 部分完全没有 |
| **Airtunes2 分析** https://git.zx2c4.com/Airtunes2/about/ | 文档 | — | AirTunes v2 的 RSA 密钥、AES、RTP/ALAC 结构（AP Express 1 代需要的部分） | 老 |
| **emanuelecozzi AirPlay 2 Internals** https://emanuelecozzi.net/docs/airplay2 | 文档 | — | AP2 特征位、音频格式（`audioFormat` 取值表）、RTSP/plist 细节；pyatv 的 feature 注释即引用此站 | **站点 TLS 证书已过期**（2026-10 实测），只能用 `curl -k` 或 archive.org 访问 |
| **RAOP-Player** https://github.com/philippe44/RAOP-Player | — | C | Windows 端 RAOP 播放器的实现参考（AirPlay 1 音频接收） | 老 |
| **node-raop**（社区） | MIT | JS | AP1 发送端最简实现，适合看"最小可行流程" | 维护停滞 |

**给 Zilux2 的具体借鉴清单**（按实现顺序）：
1. SDP 模板与 fmtp 字段顺序 ← pyatv `support/rtsp.py` + protocols.md §ANNOUNCE（可逐字复制）；
2. `Transport` 头与三端口协商 ← 同上 §SETUP；
3. RTP 头 + 首包 marker + `RTP-Info` 一致性 ← pyatv `stream_client.py`；
4. sync 包 `0x90/0x80 + 0xD4 + 0x0007 + timestamp + NTP` ← pyatv `stream_client.py` `_send_sync_packet`（已核）；
5. 重传请求 `0x55` 处理 ← pyatv `stream_client.py`；
6. 2s 抖动缓冲与 latency 常量 ← shairport README + pyatv `protocols/raop/protocols/__init__.py`（66150 帧）；
7. AP2 配对 ← `pair_ap`（C，短）对照 pyatv `hap_srp.py`；
8. AP2 音频加密 ← shairport `rtp.c` 的 10 字节布局（§2.6c）。

---

## 5. Windows 实操

### 5.1 端口与防火墙

【文档确证】Apple 官方端口表 https://support.apple.com/en-us/103229 （抓取快照 `evidence/apple-ports-2026-10.txt`）：

| 端口 | 协议 | 用途 | Zilux2 是否为发送端所需 |
| --- | --- | --- | --- |
| 7000 | TCP | AirPlay / RAOP 控制（RTSP） | ✅ 出站连接接收端 7000 |
| 6000 | TCP | AirPlay（旧式，照片/视频） | ❌ 音频不需要 |
| 5000 | TCP | AirPlay | ❌ 音频不需要 |
| 5353 | UDP | mDNS 服务发现 | ✅ 需要收发组播 |
| 554 | TCP/UDP | RTSP | ❌ AirPlay 用 7000，不用 554 |
| 3689 | TCP | DAAP（iTunes 共享） | ❌ |
| 49152–65535 | TCP/UDP | 设备配对 / AirPlay | ✅ **动态端口**：SETUP 协商出的 audio/control/timing 都在此范围 |
| 319/320 | UDP | PTP（AirPlay 2 接收端内部用） | ❌ 发送端不监听（发送端用 NTP 变体） |

**Windows 防火墙**：
- 出站默认放行；**入站**需要为 Zilux2 进程放行 `UDP 5353`（mDNS 组播接收）与 SETUP 协商出的 3 个动态 UDP 端口（audio/control/timing 由发送端 bind，接收端会回包/发重传请求）。
- 首次 bind 时会弹 Windows 防火墙授权框；正式产品应在安装时写入规则（`netsh advfirewall firewall add rule name="Zilux2 AirPlay" dir=in action=allow program="..." protocol=UDP localport=...`）。**注意**：动态端口无法预先固定——可选择 bind 在固定范围（如 6001/6002/6003）并加对应用规则，但多设备并发时要扩范围。
- 建议：开发期直接在"专用网络"配置下允许应用；发布期用 `WindowsFirewallHelper` 或 MSI 自定义动作加规则。

### 5.2 多网卡 mDNS 选路

- 枚举 `NetworkInterface.GetAllNetworkInterfaces()`，过滤：`OperationalStatus==Up`、`NetworkInterfaceType` 非 `Loopback`/`Tunnel`、支持 IPv4、有默认网关（`GetIPProperties().GatewayAddresses` 非空）。
- 每个合格网卡 join 组播组（或每网卡独立 socket）；应答里的地址要按"收到应答的 socket / 接口索引"标注，UI 上区分"同一局域网"。
- 发送 SETUP/ANNOUNCE 时，SDP 里 `c=` 与 `o=` 的 IP 必须是"与目标同网段的本地 IP"——pyatv 用 `--local-ip` 手工指定（`atvproxy` 文档），TuneBlade 也要求选择网卡。**MVP 必须让用户可手动指定网卡/IP**，否则 VPN/双网卡场景下接收端会连错地址。
- 目标设备可能同时通告 IPv4 与 IPv6 地址：优先用与 mDNS 应答同源的地址；连接失败再试另一个。

### 5.3 NTP 时间同步

- 经典 AirPlay 的 timing 通道是 **NTP 变体**（pyatv `timing.py`：`NTP_EPOCH = 2208988800` 秒偏移，`ntp2ts` 把 NTP 时间戳换成 Python 时间/相对毫秒）。发送端只需：每秒发一个 sync 包，包里带"当前 RTP 时间 + 对应 NTP 时间"；接收端据此算 offset 并自行插值。
- **不需要系统时钟准确**，只需要 offset 稳定；不要求高精度 NTP 服务器。
- 但 Windows 定时器精度是硬限制：`Thread.Sleep(1)` 实际 1~15.6ms 抖动。必须：
  - 用 `Stopwatch`/`QueryPerformanceCounter` 做时间基准；
  - 用 `timeBeginPeriod(1)`（`winmm.dll`）提升系统定时器精度，或 `ThreadPoolTimer`/`Task.Delay` + 自旋补足；
  - 音频包按"每 352 帧一个包、时间戳 +352"排程，**发送节奏允许 ±几 ms 抖动**（接收端有 2s 缓冲），但 sync 包时间戳必须与发包时刻一致。
- 更稳的做法：预先按 20~50ms 的窗口批量排包（每窗口 2~6 个 RTP 包），用高精度等待循环发送；不要依赖 `Thread.Sleep(8)` 精确代表 352 帧。

### 5.4 推荐 latency 与音画同步

- **经典 AP1**：shairport README 原文："Classic AirPlay sources set a latency of around 2.0 to 2.25 seconds."；pyatv 用 66150 帧 = **1.5s** 也能工作。Zilux2 是音乐播放器，**不需要音画同步**，latency 只影响"按播放键到出声"的延迟与切歌响应（FLUSH 后要按新 rtptime 重排）。
  - 建议：**MVP 用 2.0s**（最兼容、抖动余量大，AirPort Express 这类老设备反而稳）；后续可试 0.5~1.0s 提升手感。
- **AP2**：`latencyMin=11025`(0.25s) / `latencyMax=88200`(2s) 由 SETUP 协商；shairport AIRPLAY2.md 说 AP2 的 realtime 流"通常约 2 秒"、buffered 流几乎无延迟。做 HomePod 时建议先用 `latencyMax`（2s）保守值。
- 音量：SET_PARAMETER `volume: -20`（dB 值，text/parameters）；`-30`~`0` 映射 0~100%。静音用 `volume: -144`（shairport-sync `audio_alsa.c:142` 注释原文："when volume goes down to -144, i.e. mute"）。【源码确证】

### 5.5 IPv6 链路本地地址

- mDNS 应答里可能出现 `fe80::xxxx` 的 AAAA。**用 `fe80::` 地址建 TCP 连接必须带 scope id**（`IPAddress.Parse("fe80::1%12")` 或设置 `ScopeId`），否则 `Socket.Connect` 报 `NetworkUnreachable`。
- 建议：解析时记录该 AAAA 是从哪个接口收到的，把接口索引写进 scope id；无 scope 的 fe80 直接丢弃。
- MVP 只走 IPv4 是合理的（同网段 AirPlay 设备都有 A 记录；Python/C 实现也大多默认 IPv4）。IPv6 作为增强项。

---

## 6. 音频格式：ALAC 是否强制 / L16 / AAC

### 6.1 AP1 的 ANNOUNCE 必须声明什么

- **ALAC 352 是 Apple 发送端的事实标准**：SDP `a=rtpmap:96 AppleLossless` + `a=fmtp:96 352 0 16 40 10 14 2 255 0 0 44100`；`352` 是 ALAC 的"每包帧数"，Apple 的 encoder 固定输出 352 帧/包。【文档确证】pyatv protocols.md §ANNOUNCE；shairport-sync 只实现这一种经典格式（AIRPLAY2.md："Classic AirPlay: ALAC, S16, 44100, 2 channels only"）。
- 但 **"ALAC 352 是强制"仅对以 ALAC 声明成立的流**；协议允许发送端改声明为 L16 PCM：

### 6.2 L16 裸 PCM：MVP 的捷径（重点结论）

【源码确证 + 文档确证】：
1. pyatv 当前版本 **发送 L16（原始 PCM）而不是 ALAC**：`CHANGES` 有 commit "raop: Send audio as raw PCM"（`51dffc9`），`pyatv/support/rtsp.py` 的 ANNOUNCE 模板为 `a=rtpmap:96 L16/44100/2` + 同样的 fmtp 行（位深 16）；`support/rtsp.py:21` 与 `audio_source.py:28` 均为 `FRAMES_PER_PACKET = 352`，`stream_client.py` 直接把 16-bit little-endian PCM 按 352 帧打包（`audio_source.py:76` 注释："Frames are returned in little endian to match what AirPlay expects"）。
2. pyatv 的**已验证设备清单**（`docs/documentation/supported_features.md`）包含：Apple TV 3 (8.4.4)、Apple TV 4K (14.5)、AirPort Express (7.8.1)、HomePod mini (14.5)、airplay2-receiver、shairport-sync v4.2、Yamaha RX-V773 —— 这些设备对 pyatv 的 L16 流"能出声"（清单本身是社区+维护者实测汇总，标注了 issue/PR 来源）。
3. shairport-sync `player.c` 注释原文："a classic stream announced as L16 (e.g. from pyatv) carries big-endian 16-bit PCM in the same 352-frame packets rather than ALAC"（接收端为此专门加了大小端处理）—— 反向证明 L16 已在实际生态中使用。
4. 代价：44.1kHz/16bit/立体声 = 1.41 Mbit/s（ALAC 通常 500~900 kbit/s），同 Wi-Fi 下多设备并发需注意；但相比引入 ALAC 编码器（.NET 无内置，需要移植 Apple 的 ALAC 或第三方库），MVP 阶段 L16 是巨大简化。
5. 风险：**不是所有接收端都接受 L16**（尤其老 AirPort Express 1 代、部分第三方音箱），且 L16 走 AP2 时用 `ct=1`（pyatv 证明 HomePod mini 接受）。策略：先 L16 打通，再按设备回退 ALAC。**【推断】**（pyatv 的 L16 覆盖清单是"能工作"的强证据，但没有 Apple 官方文档背书。）

### 6.3 AAC / AAC-ELD 的真实支持

- pyatv TXT `cn` 字段的取值表（协议文档 §Service Discovery）：`0=PCM, 1=ALAC, 2=AAC, 3=AAC-ELD, 4=OPUS` —— 说明 `cn` 是**发送端宣告"我支持哪些编码"**的列表，不代表接收端一定接受。【文档确证】
- **AP2** 支持 AAC（有损）与 ALAC（无损），shairport AIRPLAY2.md 明确 AP2 格式：`ALAC`/`AAC` 两种编码 × `S16/S24/F24` 位深 × `44100/48000` 采样率 × `stereo/5.1/7.1` 声道；AAC 解码在 shairport 里走 FFmpeg（`AV_CODEC_ID_AAC`），且只有 buffered 流支持 AAC（realtime 流仍是 ALAC/原始）。【源码确证】`player.c` `prepare_decoding_chain()` 的 SSRC→codec 选择；SSRC 常量 `player.h:145-155`：`ALAC_44100_S16_2=0x0000FACE`（注释 "this is made up"）、`ALAC_48000_S24_2=0x15000000`、`AAC_44100_F24_2=0x16000000`、`AAC_48000_F24_2=0x17000000`、`AAC_48000_F24_5P1=0x27000000`、`AAC_48000_F24_7P1=0x28000000`。
- **AAC-ELD (cn=3)** 在 Apple 接收端的公开证据极少；`AirPlay 2` 里确实存在 `audioFormat` 值属于 AAC-ELD 的编码（emanuelecozzi 的 audio 页有表，但站点证书过期，未能直接取证）。**建议不在 MVP 使用**。【推断】
- **L16 PCM 在 AP2 里**用 `ct=1`（pyatv 实测 HomePod mini 等通过）；AP2 不用 SDP，而是 `SETUP` plist 里 `ct/spf/sr`。
- 对"音乐播放器"来说，**ALAC 或 L16 都够用**；AAC 只在需要带宽优化时才有意义，且要额外的 AAC 编码器（.NET 无内置 PCM→AAC 编码，Windows 可用 Media Foundation 转码）。

---

## 7. 一页结论：MVP 路线 vs 完整路线

### 7.1 MVP 路线（先让 macOS 接收器 / AirPort Express / Apple TV 出声）

**目标**：Windows 上点"投送"→ 目标设备出声，能暂停/继续/切歌/调音量/断开。**不含 HomePod。**

| 步骤 | 内容 | 预估 |
| --- | --- | --- |
| 0 | **灰区探针（0.5 天）**：手写一个 ~150 行的 C# 控制台：mDNS 查询 `_raop._tcp`/`_airplay._tcp` → 打印 TXT → 对每个设备跑 `OPTIONS * RTSP/1.0`（明文 7000）→ 若 200 则跑 `ANNOUNCE`（L16 SDP）→ 看是否 200。**这一步直接回答"macOS 接收器是否接受 AP1"**，也顺便验证 HomePod 是否会在明文 RTSP 阶段就拒绝。 | 0.5d |
| 1 | mDNS 发现层：Tmds.MDns 或自实现；解析 TXT 到设备模型（名称/型号/features/et/acl/pw/model/ports） | 1~1.5d |
| 2 | RTSP 客户端：TCP 连接 7000、`CSeq` 管理、请求/响应解析（POST/GET 的 Content-Length 处理） | 1d |
| 3 | AP1 音频往返：ANNOUNCE(L16) → SETUP(协商 3 端口) → RECORD → RTP 发包(352 帧/包) → sync 包(1/s) → 重传响应 → FLUSH/TEARDOWN | 2~3d |
| 4 | 播放控制：暂停(RECORD 即暂停)、切歌(FLUSH+TIMING/重开 RECORD)、音量(volume: dB)、断开 | 1~1.5d |
| 5 | WPF 集成：设备发现列表、投送按钮、状态显示、错误提示、网卡/IP 选择 | 1.5~2d |
| 6 | 稳定性：Wi-Fi 抖动、重连、防火墙提示、异常设备降级 | 1~2d |
| **合计** | | **8~11 人日** |

**风险**：
1. **macOS 接收器 AP1 支持未确证**（最大风险）：若探针失败，macOS 目标要挪到 AP2 阶段，或用 AirPlay 2 的 `pair-verify` 之外"只做 AP2 音频、不做控制"的混合路线。→ 探针必须最先做。
2. L16 兼容性：老设备/部分第三方音箱可能只认 ALAC → 需要 ALAC 回退（增加 2~3 人日，可用开源 ALAC 编码器移植，如 `alac.c` 的 BSD 许可实现）。
3. Windows 防火墙/网卡：首次投送失败的"玄学"大多来自防火墙与多网卡，需要充分的用户提示。
4. latency/切歌：FLUSH 后 RTP 时间戳要重排，否则声音会快进/卡顿。

### 7.2 完整路线（+ HomePod / HomePod mini / 新版 Apple TV，即 AP2）

在 MVP 基础上增加：

| 步骤 | 内容 | 预估 |
| --- | --- | --- |
| A | HAP 密码学层：SRP-3072/SHA-512（.NET 需自实现 SRP 或移植）、TLV8、ChaCha20-Poly1305、HKDF-SHA512、Ed25519/Curve25519（.NET 10 有 `ECDiffieHellman` 可做 X25519？——**无直接 X25519 API**，需 BouncyCastle 或自实现/移植） | 3~4d |
| B | pair-setup（瞬态模式 M1~M4；HomePod PIN=3939，无 UI） + pair-verify（含签名校验，可跳过验签但必须签名对） | 2~3d |
| C | `/auth-setup`（33 字节） + RTSP 通道加密（HAP 帧：2B LE 长度 + ChaCha + tag，nonce 计数器） | 1~2d |
| D | AP2 `SETUP` plist（`shk`/`ct=1`/`spf=352`/`sr`/`timingPort`/`controlPort`/latencyMin/Max）+ RTP 音频加密（AAD=timestamp+SSRC，nonce 附在包尾） + `/feedback` 保活 | 2~3d |
| E | 设备矩阵分支：HomePod 走 AP2，其他走 AP1；发现层按 features 位自动选择 | 1d |
| F | 联调/兼容性（HomePod 固件差异、iOS/macOS 版本差异、断连重连） | 2~3d |
| **合计** | | **11~17 人日**（含 MVP 基础则总计 **19~28 人日**） |

**风险**：
1. **X25519/Ed25519 在 .NET 10 的可用性**：`System.Security.Cryptography` 提供 ECDH P-256 但**不提供 X25519**（.NET 8/9/10 均如此），需要 BouncyCastle（MIT）或自实现；这是 AP2 的第一个硬门槛。
2. HomePod 瞬态配对失败后**无法用普通随机 PIN**（HomePod 无屏幕），必须严格按瞬态流程（只跑 M1~M4 + pair-verify）。
3. AP2 的 event/control 通道若要做"现在播放/音量同步"（遥控），工作量会再翻倍；**纯音频投送可只实现 audio 通道**（见 §2.8 推断）——建议先不碰 event 通道。
4. Apple 固件升级可能改 `audioFormat` 值/要求 MFi 证书校验（airplay2-receiver 等社区实现的 README 已多次提到此风险）。

### 7.3 建议

1. **立刻做 §7.1 第 0 步探针**（0.5 天，写进 `research/airplay/web/probe-plan.md` 也可留给实现组），用实测把 macOS 接收器的灰区消掉。
2. **MVP 承诺范围只写：AirPort Express 2 / Apple TV / 第三方 AirPlay 音箱（L16）**；macOS 接收器标注"实验性"。
3. AP2 单独排期，优先实现到"HomePod 出声"（audio 通道 + 瞬态配对 + `/feedback`），不做遥控通道。
4. **与 TuneBlade 反编译结果交叉验证的 10 个点**（见 §8），若对方结论与本文冲突，以抓包/实测为准并回填本文。

---

## 8. 与 TuneBlade 反编译结果的交叉验证清单（交给 Lead）

以下点建议与 `research/airplay/tuneblade-decomp/` 逐条对照，冲突时记录谁对谁错（外部资料可能过期，TuneBlade 可能有 bug/私货）：

| # | 待对照点 | 本文结论（外部资料） | 冲突时如何裁决 |
| --- | --- | --- | --- |
| 1 | TuneBlade 走 AP1 还是 AP2 | AP1（其官网目标列表无 HomePod/iOS 接收器） | 看是否有 HAP/ChaCha 相关代码 |
| 2 | SDP fmtp 行 | `352 0 16 40 10 14 2 255 0 0 44100` | 抓包比字节 |
| 3 | 音频编码 | 可能是 ALAC 或 L16；决定 MVP 是否要 ALAC | 看反编译里有无 ALAC 编码器 |
| 4 | SETUP Transport 头格式 | `RTP/AVP/UDP;unicast;interleaved=0-1;mode=record;control_port=X;timing_port=Y` | 抓包 |
| 5 | sync 包布局 | `0x90/0x80, 0xD4, 0x00 0x07, rtp_ts, ntp_sec, ntp_frac` | 抓包/反编译对照 |
| 6 | latency 常量 | 2.0s（经典源惯例）/1.5s（pyatv） | TuneBlade 可能用 2.25s |
| 7 | 重传请求处理 | `0x55 + seq(2B) + count(2B)` | 反编译有无 `0x55` 分支 |
| 8 | NTP timing 实现 | NTP 变体、1s 一次、offset 计算 | 看 NTPClockHost.cs 的字段布局 |
| 9 | 是否实现 AP2 配对 | 若 TuneBlade 支持 HomePod 则必然有 AP2（但官网未列 HomePod） | 搜 `pair-setup`/`ChaCha`/`shk` |
| 10 | mDNS 实现方式 | Bonjour P/Invoke vs 自实现 vs 第三方 | 决定 Zilux2 是否需要零依赖实现 |

---

## 附录 A：来源 URL 总表

**官方/文档**
- Apple AirPlay 端口表：https://support.apple.com/en-us/103229
- AirPort Express 固件 7.8 支持 AirPlay 2：https://support.apple.com/en-us/106643
- TuneBlade 官网（目标设备列表/免费版限制）：http://www.tuneblade.com/
- RFC 6762（mDNS）：https://www.rfc-editor.org/rfc/rfc6762 ｜ RFC 6763（DNS-SD）：https://www.rfc-editor.org/rfc/rfc6763
- openairplay 非官方 AirPlay 规范：https://openairplay.github.io/airplay-spec/
- nto 非官方规范（2011）：https://nto.github.io/AirPlay.html
- Airtunes2 分析：https://git.zx2c4.com/Airtunes2/about/
- AirPlay 2 Internals（证书已过期）：https://emanuelecozzi.net/docs/airplay2

**源码/仓库**
- pyatv：https://github.com/postlund/pyatv （MIT）— 协议文档 `docs/documentation/protocols.md`，已验证设备 `docs/documentation/supported_features.md`
- pyatv 文档站：https://pyatv.dev/development/stream/ ｜https://pyatv.dev/development/atvproxy/
- shairport-sync：https://github.com/mikebrady/shairport-sync （GPL-2.0）— `AIRPLAY2.md`、`rtsp.c`、`rtp.c`、`player.c`
- pair_ap（HAP 配对 C 实现）：https://github.com/ejurgensen/pair_ap
- owntone-server：https://github.com/ejurgensen/owntone-server
- airplay2-receiver：https://github.com/openairplay/airplay2-receiver ｜wiki：https://github.com/openairplay/airplay2-receiver/wiki/AirPlay2-Protocol
- UxPlay：https://github.com/FDH2/UxPlay
- philippe44/RAOP-Player：https://github.com/philippe44/RAOP-Player
- RAOP 客户端参考：https://github.com/ejurgensen/pair_ap 、https://github.com/postlund/pyatv

**NuGet**
- Zeroconf：https://www.nuget.org/packages/Zeroconf ｜https://github.com/novotnyllc/Zeroconf
- Tmds.MDns：https://www.nuget.org/packages/Tmds.MDns
- Makaretu.Dns.Multicast：https://www.nuget.org/packages/Makaretu.Dns.Multicast ｜https://github.com/richardschneider/net-mdns
- Makaretu.Dns：https://www.nuget.org/packages/Makaretu.Dns ｜https://github.com/richardschneider/net-dns
- Mono.Zeroconf：https://www.nuget.org/packages/Mono.Zeroconf

## 附录 B：复现命令

```bash
# 抓 Apple 端口表（工具自带的 h2t.pl 对 2026 版页面解析失败，改用 perl 直接提 <p> 单元格）
curl -sL https://support.apple.com/en-us/103229 -o apple-ports.html
perl -0777 -ne 'while (/<tr>(.*?)<\/tr>/gs) { my $r=$1;
  my @c = $r =~ /<p[^>]*>(.*?)<\/p>/gs;
  print join(" | ", map { s/<[^>]+>//g; s/\s+/ /g; $_ } @c), "\n" if @c; }' apple-ports.html

# 证书过期站
curl -k -sL https://emanuelecozzi.net/docs/airplay2 -o cozzi.html   # 需 -k

# NuGet 最新版（无 python/jq 时用 grep）
curl -s https://api.nuget.org/v3-flatcontainer/zeroconf/index.json

# IRC/GitHub API 查维护状态
curl -s https://api.github.com/repos/postlund/pyatv | grep -E '"(pushed_at|archived)"'
```

<!-- end -->
