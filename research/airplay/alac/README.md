# ALAC 编码器（纯托管 C#，用于 Zilux2 的 AirPlay / RAOP 投送）

AirPlay 1（RAOP）音频投送使用的 Apple Lossless（ALAC）格式**编码器**，纯托管 C# 实现，
**不依赖任何原生 DLL**、不依赖 NuGet、不使用 `unsafe`。
同一目录下还带一个**仅用于验证**的纯托管 ALAC 解码器：用它把编码结果解回来逐样本比较，
即可在没有任何外部解码器（本机没有 ffmpeg）的情况下自证"无损 = bit-exact"。

- 目标运行时：.NET 10（Windows x64）
- 目录：`research/airplay/alac/`
- 被 Zilux2 主工程使用的方式：只复制 `AlacEncoder.cs` 到 `src/Zilux2/AirPlay/Alac/`
  （`AlacDecoder.cs` 只是测试/验证用，产品不需要；如需保留亦可，二者无相互依赖）

---

## 1. 来源与许可（Attribution / License）

算法、常数表与码流格式来自 Apple 开源的 ALAC 参考实现：

- 仓库：<https://github.com/macosforge/alac>（`codec/` 目录）
- 文件：`ALACEncoder.cpp`、`ALACDecoder.cpp`、`ag_enc.c`、`ag_dec.c`、`dp_enc.c`、
  `dp_dec.c`、`matrix_enc.c`、`matrix_dec.c`、`ALACBitUtilities.c`、`aglib.h`、
  `dplib.h`、`ALACAudioTypes.h`、`ALACMagicCookieDescription.txt`
- 许可：**Apache License 2.0**（`Copyright (c) 2011 Apple Inc.`）

本目录下的 C# 代码是**按上述算法重写**的独立实现（保持相同的比特流格式、常数与
预测/熵编码流程），不是对 C/C++ 源码的逐行机翻，也不是 Apple 产品。原始参考源码
保留在 `_ref/` 子目录仅作对照，可随时删除（不参与编译）。

> 注意：不得使用 `E:\逆向用\AlacCodec.dll`（TuneBlade 的原生封装）或任何其它原生
> ALAC 库作为依赖；本实现与之没有任何代码/二进制关系。

---

## 2. 文件清单

| 文件 | 作用 | 产品需要 |
|---|---|---|
| `AlacEncoder.cs` | ALAC 编码器（`AlacEncoder` + 内部 `AlacBitWriter`） | ✅ 只复制这一个 |
| `AlacDecoder.cs` | ALAC 解码器（`AlacDecoder`/`AlacConfig` + 末尾的 `AlacBitReader`），仅验证用 | ❌ |
| `Program.cs` | 验证/基准测试台（roundtrip + 性能 + cookie + 边界） | ❌ |
| `AlacVerify.csproj` | 独立控制台验证工程（net10.0，零 NuGet） | ❌ |
| `README.md` | 本文档 | ❌ |
| `_ref/` | Apple 参考源码（Apache-2.0，仅作对照，不参与编译） | ❌ |

验证工程是**完全独立的 console 工程**，不引用主工程、不需要先构建 Zilux2：

```bash
cd research/airplay/alac
dotnet run -c Release --project AlacVerify.csproj   # 退出码 0 = 全部通过
```

（`dotnet new console` 的离线模板即可；本工程没有 `PackageReference`。）

---

## 3. API

### 3.1 `AlacEncoder`（`namespace Zilux2.AirPlay.Alac`）

```csharp
public sealed class AlacEncoder
{
    // 初始化。RAOP 默认：44100 Hz / 立体声 / 16-bit / 每帧 352 采样。
    // 只在 Init 里分配缓冲；Init 之后可反复调用 EncodeFrame（同一实例、单线程）。
    public void Init(int sampleRate = 44100, int channels = 2, int bitDepth = 16, int frameLength = 352);

    // 编码一帧：输入交错 16-bit PCM（352*2=704 个 short = 1408 字节），
    // 输出一个完整 ALAC 帧（含 element tag / ID_END / 字节对齐），返回写入字节数。
    public int EncodeFrame(ReadOnlySpan<short> pcmInterleaved, Span<byte> dest);

    // 生成 ALAC magic cookie：ALACSpecificConfig 24 字节，big-endian。
    // maxFrameBytes/avgBitRate 传 0 表示"未知"（RAOP 常见做法）。
    public byte[] GetMagicCookie(uint maxFrameBytes = 0, uint avgBitRate = 0);

    public int MaxFrameBytes { get; }     // = frameLength*channels*2 + 16（352 立体声 = 1424）
    public const int RaopMaxPacketSize = 1428;   // RAOP 协议 MaxALACPacketSize

    public int SampleRate { get; }
    public int Channels { get; }
    public int BitDepth { get; }
    public int FrameLength { get; }

    public bool LastFrameWasEscape { get; }   // 上一帧是否走了未压缩 escape 路径（诊断用）
    public int LastFrameBytes { get; }        // 上一帧字节数（诊断用）
}
```

#### `EncodeFrame` 返回值约定（给流式管道用）

| 返回 | 含义 | 调用方动作 |
|---|---|---|
| `> 0` | 本帧编码成功，值 = 字节数 | 作为该 RTP 包的 ALAC payload 发出 |
| `-1` | **可恢复失败**：`dest` 小于 `MaxFrameBytes`、PCM 长度不是声道数的整数倍、空帧、样本数超过 `frameLength`，或编码结果超过 RAOP 包预算 1428 B | **丢弃该帧**并记警告，不要重试同一帧 |
| 异常 | 仅 `InvalidOperationException`（未 `Init` 就调用，属编程错误） | 修代码，不要靠丢帧掩盖 |

关键点（按 前端侧的集成要求实现）：

- **不抛 `NotImplementedException`**；可恢复错误一律返回 `-1`。
- `dest` 不够大时**先检查再返回**，绝不越界写。
- 16-bit 立体声 352 采样的**实际最坏帧是 1412 字节**（escape 帧），
  小于 1428 的 RAOP 预算，也不会超过 `dest` 要求的 1424；即 `-1` 在正常参数下不会出现。
- 最后一包不足 352 采样时，直接传实际样本数即可（partial frame），
  编码器会写 `partialFrame` 标志 + 32-bit 实际样本数；`< 288` 采样的帧固定走 escape
  （压缩收益为负，Apple 参考实现同样会回退）。

典型流式用法（前端侧的泵线程里）：

```csharp
var enc = new AlacEncoder();
enc.Init(44100, 2, 16, 352);
byte[] dst = new byte[AlacEncoder.RaopMaxPacketSize];   // 1428
short[] pcm = new short[352 * 2];                       // WASAPI 采到的 16-bit 交错 PCM
// 每帧：
int n = enc.EncodeFrame(pcm, dst);
if (n > 0) SendRtpPacket(dst.AsSpan(0, n));
else       DropFrame();
```

### 3.2 `AlacDecoder`（仅验证用，产品不需要）

```csharp
public sealed class AlacDecoder
{
    public AlacConfig Config { get; }
    public void Init(ReadOnlySpan<byte> magicCookie);                     // 从 24 字节 cookie 初始化
    public void Init(int sampleRate = 44100, int channels = 2, int bitDepth = 16, int frameLength = 352);
    public int DecodeFrame(ReadOnlySpan<byte> frame, Span<short> pcmOut, int numSamplesHint);
}
```

解码器是 Apple `ALACDecoder.cpp` 的移植，覆盖范围与编码器输出一致：16-bit、1–2 声道、
`mode 0` 预测器、无 `bytesShifted`（不处理 20/24/32-bit 流）。
**它不是产品代码**，只保证"能解回我们编码器产生的帧"，不做恶意码流的健壮性加固。

---

## 4. 与 RAOP 帧尺寸 352 的关系

- AirPlay 1 在 RTSP `SETUP`/`ANNOUNCE` 的 SDP 里声明 `pt=96`、`framesPerPacket=352`
  （`a=fmtp:96 352 0 16 40 10 14 2 255 0 0 44100`），即 **每个 RTP 音频包 = 一个 ALAC 帧
  = 每声道 352 采样**。
- 44.1 kHz/16-bit/立体声：352 × 2 × 2 = **1408 字节 PCM** → 编码后通常 100–500 字节
  （本测试集平均约 60% 压缩率，白噪/随机数据回退到 escape 固定 1412 字节）。
- `frameLength` 同时写进 magic cookie，必须与每包样本数一致，否则接收端解不出正确长度。
- RTP 时间戳每包递增 352（与采样率同一时钟）；本编码器不处理 RTP 头，只产出 payload。
- 末包不足 352 采样：带 `partialFrame` 标志与 32-bit 实际样本数，接收端按实际样本数解。
- RAOP 的 `MaxALACPacketSize = 1428` 字节：本编码器 16-bit 立体声最坏 1412 B，安全。

---

## 5. Magic cookie 字节布局（24 字节，全 big-endian）

`GetMagicCookie()` 输出的是 `ALACSpecificConfig`（RAOP SDP 里通常 `a=fmtp` 已含参数，
容器/握手需要 cookie 时用这 24 字节；AirPlay 2 的 `apple-...` 头里会 base64 化）。

| 偏移 | 长度 | 字段 | 本实现取值（立体声/352） |
|---|---|---|---|
| 0 | 4 | `frameLength`（BE u32） | 352 = `00 00 01 60` |
| 4 | 1 | `compatibleVersion` | 0（必须为 0） |
| 5 | 1 | `bitDepth` | 16 = `0x10` |
| 6 | 1 | `pb` | 40 = `0x28`（`PB0`） |
| 7 | 1 | `mb` | 10 = `0x0a`（`MB0`） |
| 8 | 1 | `kb` | 14 = `0x0e`（`KB0`） |
| 9 | 1 | `numChannels` | 2（mono 为 1） |
| 10 | 2 | `maxRun`（BE u16） | 255 = `00 ff`（`MAX_RUN_DEFAULT`） |
| 12 | 4 | `maxFrameBytes`（BE u32） | 0 = 未知（RAOP 常规；也可传 `MaxFrameBytes`） |
| 16 | 4 | `avgBitRate`（BE u32） | 0 = 未知 |
| 20 | 4 | `sampleRate`（BE u32） | 44100 = `00 00 ac 44` |

立体声实测字节：

```
00 00 01 60 00 10 28 0a 0e 02 00 ff 00 00 00 00 00 00 00 00 00 00 ac 44
```

同样内容的 Base64（可用于 `apple-...` 形式的头部）：

```
AAABYAAQKAoOAgD/AAAAAAAAAAAAAKxE
```

mono：仅偏移 9 处为 `01`，其余相同。

> **关于 `chan` atom**：Apple 参考实现在 `numChannels > 2` 时会在 24 字节 config 后再追加
> 12 字节 `'chan'` atom + 12 字节 `ALACAudioChannelLayout`（合计 48 字节）。本编码器只支持
> 1–2 声道，因此**只需要 24 字节**，不需要 channel layout（Apple 对 ≤2 声道同样不输出）。

---

## 6. 正确性验证（bit-exact 自证）

### 6.1 方法

1. `Program.cs` 生成各类测试信号 → `AlacEncoder.EncodeFrame` 编码成 ALAC 帧；
2. 用同目录 `AlacDecoder.DecodeFrame` 解回 PCM；
3. **逐样本比较**（`short` 全等才算过，任何一位不同即失败）；
4. 全部通过时进程退出码 0，否则非 0（可放进 CI/脚本）。

没有第三方实现参与解码（本机没有 ffmpeg / 无原生 ALAC 库），所以这是
"**参考算法移植 + 自洽回环**"的证明；编码器和解码器都是对 Apple 参考实现的独立重写，
`_ref/` 中的原始 C/C++ 源码可随时人工对照（详见 §9 的已知风险）。

### 6.2 覆盖范围

- 信号（立体声、mono 各 30 帧 × 352 采样）：
  静音、正弦 440Hz 单左/单右/同相/90° 相位差、白噪、方波 220Hz、满幅 ±32767、渐进扫频 20Hz–20kHz、每帧随机数据；
- **partial 帧**：1、2、3、4、5、6、7、8、16、32、50、100、128、200、255、287、288、300、320、351 采样（共 20 种）；
- **连续 200 帧流式**：一次 `Init()` 后不重新初始化，逐帧 `EncodeFrame`（混合内容），每帧都 roundtrip；
- 用 `GetMagicCookie()` 生成的 24 字节 cookie 初始化解码器后再 roundtrip（验证 cookie 字段）；
- escape（未压缩）路径：满幅噪声强制走 escape，检查帧大小上限；
- `EncodeFrame` 契约：dest 过小 / PCM 长度非法 / 空帧 → 返回 `-1` 且不抛异常、不越界。

### 6.3 实测输出摘要（`dotnet run -c Release`，2026-10-20）

```
--- Round-trip: STEREO (30 frames per signal, 352 samples/frame)
silence 30/30 OK | sine 440 in phase 30/30 | white noise 30/30 (escape) | square 220 30/30
full scale ±32767 30/30 | chirp 20..20k 30/30 | random per frame 30/30 (escape)
--- Round-trip: MONO (30 frames per signal, 352 samples/frame)
（同 10 类信号，全部 30/30 OK）
--- partial frames: 20/20 partial sizes bit-exact（<288 走 escape，>=288 走压缩）
--- streaming: frames=200 bit-exact=200 avg=650 B escape=50 max=1412 B  OK
--- cookie-initialised decoder round-trip: bit-exact
--- 20 full-scale noise frames: 20 escape, max 1412 B (<= 1428: OK)
--- contract: dest too small / malformed PCM -> -1 (no exception, no partial write): OK

TOTAL: 820 frames encoded/decoded, 59.5% smaller than PCM, 186 escape frames, max frame 1412 B
RESULT: ALL ROUNDTRIPS BIT-EXACT — PASS      （进程退出码 0）
```

即：**820 帧、全部逐样本 bit-exact**；含 200 帧连续流式与 20 种 partial 帧。

---

## 7. 性能（44.1kHz / 16-bit / 立体声 / 352 采样每帧）

环境：Windows x64、.NET 10.0.401、`dotnet run -c Release`、同一实例预热后计时
（`Stopwatch` 包住 `EncodeFrame`，输入为随机混合信号，含 escape 帧）：

| 指标 | 多次运行范围 | 最近一次 |
|---|---|---|
| avg | 29.4 – 33.0 µs | **30.4 µs** |
| p50 | 28.3 – 29.6 µs | 29.3 µs |
| p99 | 43.3 – 49.4 µs | 49.4 µs |
| max | 79.1 – 128.7 µs | 109.0 µs |
| 吞吐 | ~30k–34k 帧/秒 | ~32 848 帧/秒 |

结论：**远优于 < 2 ms/帧的目标（约 60–70 倍余量）**；一帧预算 8 ms（352/44100 s），
编码只占约 0.4%，在 WPF 进程里由 GC/调度造成的抖动仍有充分余量。
注意：这是"每帧独立编码"的成本；Apple 参考实现会用上一帧的 mixRes 作为搜索起点
（本实现同样保留该策略），并不存在需要额外喂数据的训练期。

---

## 8. 已知限制 / 风险

1. **只支持 16-bit PCM、1–2 声道**：AirPlay 1（RAOP）以 16-bit 44.1kHz 立体声为主，
   满足 Zilux2 需求；20/24/32-bit、多声道、`bytesShifted`、`mode != 0` 预测器均不支持
   （这些路径没有实现，编码器也不产生）。
2. **每帧开销换正确性**：笔者的解码器只覆盖编码器能产生的子集，不做恶意码流加固；
   它用于验证，不应作为产品解码器使用。
3. **自洽验证的固有风险**：编码器与解码器都从同一份 Apple 参考源码重写，
   理论上存在"共同误解"导致两者自洽但第三方解码器解不出的风险。缓解：
   逐段对照 `_ref/` 原始源码；magic cookie/帧头字段与 Apple 格式一致；
   若后续环境有 ffmpeg（`ffmpeg -i x.alac -f s16le out.pcm`）或 macOS 端，
   建议做一次外部对照（本机没有 ffmpeg，无法在本次交付中完成）。
4. **与 Apple 参考实现的已知差异**（不影响码流合法性，只影响压缩率）：
   - 预测器 `pc_block`/`unpc_block` 用通用公式，而不是 4/8 阶展开优化版本
     （两者数学等价；编码器仍做 `numU/numV ∈ {4,8}` 搜索）；
   - 选 `numU/numV` 的评分阶段，本实现多跑一次 `pc_block(n/8)` 让评分输入确定
     （Apple 复用收敛后的前 1/32 样本、其余是陈旧数据）。这让选出的阶数可能略有不同，
     但阶数会写进帧头，解码完全一致。
5. **性能取决于宿主**：测试是 Release/无调试器；Debug 构建或调试器附加下会慢数倍。
6. **`EncodeFrame` 不可重入/非线程安全**（内部有工作缓冲与跨帧状态如 mixRes 历史）；
   约定由单一音频泵线程调用，符合该约定即安全。需要多线程时每线程一个实例。
7. 编码器不做重采样、不做 RTP/RTSP 封装、不处理声道布局协商——这些在 AirPlay 主机侧
   （`AirPlayStreamer` / `StereoResampler`）完成。
8. `MaxFrameBytes = 1424` 是"承诺的 dest 容量"；实际 16-bit 立体声最坏帧 1412 B，
   留有余量。若未来支持 24/32-bit，需要重新计算（Apple 的上限公式是
   `frameLength * channels * 5 + 1`）。

---

## 9. 从 research 复制到产品代码时

只复制 `AlacEncoder.cs`（可选连带 `AlacDecoder.cs`，仅当产品里也要做解码自检）：

```text
research/airplay/alac/AlacEncoder.cs  ->  src/Zilux2/AirPlay/Alac/AlacEncoder.cs
research/airplay/alac/AlacDecoder.cs  ->  src/Zilux2/AirPlay/Alac/AlacDecoder.cs   （可选，单文件自包含）
```

- 文件里的 `namespace Zilux2.AirPlay.Alac;` **不需要改**（复制到 `src/Zilux2/AirPlay/Alac/`
  后与命名空间一致）。
- 使用方在 `src/Zilux2/AirPlay/Audio/AlacAudioEncoder.cs` 一类适配器里写：
  `using Zilux2.AirPlay.Alac;` 即可，无其它依赖。
- `AlacEncoder.cs` 只用到 `System`、`System.Numerics`（`BitOperations`），
  .NET 10 自带；无 `unsafe`、无 `DllImport`、无 NuGet、无文件/网络 IO。
- `AlacDecoder.cs` 同样自包含（`AlacBitReader` 定义在文件末尾），**不需要**额外复制
  `AlacBitReader.cs`（该文件已并入并删除）。若产品只需要编码器，**完全不用复制解码器**。
- `AlacVerify.csproj` / `Program.cs` / `_ref/` 是研究目录的验证资产，不要复制进产品。
- 线程安全：`AlacEncoder` 按"单线程、每实例一个"设计；`Init` 之后在音频泵线程里循环
  `EncodeFrame` 即可（前端侧的 `AlacAudioEncoder` 适配器就是这样用）。
