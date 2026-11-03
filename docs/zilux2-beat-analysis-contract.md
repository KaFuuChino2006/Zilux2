# 节拍分析契约（P0 / B 版预留）

> 状态：P0 设计定稿（2026-10-25）。宿主 `LocalMusicServer` 提供离线节拍分析接口，
> 页面在「设置 → 播放 → 节拍分析（实验）」里试听验证。后续 B 版（鼓点对齐自动衔接）
> 只在此契约上扩展字段，不改已有字段含义。

## 1. 范围

P0 只做「分析并验证」：拿到一首歌的 BPM、拍号、拍点/强拍网格、乐句边界，
页面用节拍器试听核对准确率。**不改播放/切歌逻辑**。

B 版后续阶段（不在本契约实现，但字段预留在 §5）：
- 宿主：下一首预取 + 分析缓存 → 播放器双源混音 → downbeat/乐句对齐交叉淡化 → WSOLA 变速。

## 2. 接口

```
GET http://127.0.0.1:<port>/api/analysis?source=<src>&id=<id>&token=<token>
GET http://127.0.0.1:<port>/api/analysis?source=local&rel=<rel>&token=<token>
```

| 参数 | 说明 |
|---|---|
| `source` | `local` 或在线源 id（`netease`/`qq`/`kugou`/`mvmp3`），必填 |
| `id` | 在线曲目 id；`source=local` 时忽略 |
| `rel` | 本地曲库相对路径（`@downloads/...` 或普通 rel），`source=local` 时必填 |
| `quality` | 可选，在线曲目拉取音质（standard/high/lossless，缺省用下载设置） |
| `force` | 可选，`1` 表示忽略缓存重新分析 |
| `cacheOnly` | 可选，`1`/`true`：只读缓存，未分析过时立即返回 `ok:false, code:"not-cached"`（不下载、不解码），供页面批量查询已有分析结果（`p0-9` 起） |
| `token` | 必填，与其他 `/api/*` 相同的 loopback token |

语义：
- 同步接口。宿主解析/下载（在线曲目）+ 解码 + 分析；P0 单曲上限约 12 分钟音频。
- 结果缓存：`%LOCALAPPDATA%\Zilux2\analysis\`（音频缓存 + JSON），键为 `source:id:analyzerVersion`；
  命中缓存时 `cached=true` 且 `elapsedMs` 很小。缓存上限 300 MB，超限按 mtime 淘汰。
- 同曲并发请求合并（单飞），不重复下载/分析。
- 失败返回 `ok:false` + `code`（`not-found`/`not-cached`/`not-playable`/`upstream-failed`/`decode-failed`/`timeout`/`internal-error`）；`not-cached` 表示 cacheOnly=1 且该曲尚未分析（HTTP 404）。

### 2.1 成功响应（camelCase JSON）

```json
{
  "v": 1,
  "ok": true,
  "source": "netease",
  "trackId": "1234567",
  "rel": "",
  "title": "歌名",
  "artist": "歌手",
  "durationMs": 214500,
  "audibleEndMs": 208400,
  "tailSilenceMs": 6100,
  "cached": false,
  "elapsedMs": 1834,
  "analyzer": "p0-11",
  "analysis": {
    "bpm": 128.0,
    "bpmConfidence": 0.87,
    "meter": 4,
    "meterConfidence": 0.74,
    "beatIntervalMs": 468.75,
    "firstBeatMs": 125,
    "firstDownbeatMs": 125,
    "downbeats": [125, 2000, 3875],
    "phraseStartsMs": [125, 15125, 30125],
    "barCount": 112,
    "key": 9,
    "keyMode": "minor",
    "camelot": "8A",
    "energy": 0.676,
    "loudnessLufs": -10.6,
    "peakDb": -0.2,
    "climaxStartMs": 186000,
    "climaxEndMs": 201000,
    "cueInMs": 186000,
    "cueOutMs": 240000,
    "sections": [
      { "startMs": 0, "endMs": 30000, "label": "intro", "confidence": 0.6 },
      { "startMs": 30000, "endMs": 90000, "label": "verse", "confidence": 0.4 },
      { "startMs": 90000, "endMs": 180000, "label": "chorus", "confidence": 0.5 },
      { "startMs": 180000, "endMs": 240000, "label": "drop", "confidence": 0.55 },
      { "startMs": 240000, "endMs": 261000, "label": "outro", "confidence": 0.5 }
    ],
    "warnings": []
  }
}
```

| 字段 | 含义 |
|---|---|
| `audibleEndMs` | **响应顶层字段**。「可听结尾」位置（ms，相对音频文件起点，`0..durationMs`）：排除尾部静音/渐弱收尾后最后一个可听样本的结束位置（向上取整到 ms）。没有有效尾部静音且没有可判定的渐弱收尾时等于 `durationMs`。供无缝衔接把交叉淡化终点对齐到音乐结束。 |
| `tailSilenceMs` | **响应顶层字段**。尾端静音/渐弱收尾长度 = `durationMs - audibleEndMs`；两者都不足阈值（300 ms）时为 `0`。 |
| `beatIntervalMs` | 平均拍间隔（毫秒，浮点）；P0 假设全曲恒定速度 |
| `firstBeatMs` | 第一拍的时间（相对音频文件起点） |
| `firstDownbeatMs` | 第一小节强拍时间，`(firstDownbeatMs-firstBeatMs)/beatIntervalMs` 是整数相位 |
| `downbeats` | 强拍时间列表（毫秒，升序，最多返回 ~400 个，超出截断） |
| `phraseStartsMs` | 检测到的乐句/段落边界时间（每 8/16 小节级别） |
| `sections` | 段落列表（按 `phraseStartsMs` 切分）。`label` 取值（`p0-11` 起）：`intro`、`build`、`verse`、`chorus`、`drop`、`breakdown`、`outro` 或空串（算法见 §2.1.3），`confidence` 0.3–0.55 |
| `barCount` | 估计小节数 |
| `key` | **p0-9 起**。调性主音音级：`0`=C … `11`=B，识别不出为 `-1` |
| `keyMode` | **p0-9 起**。`major` / `minor`，识别不出为空串 |
| `camelot` | **p0-9 起**。Camelot 编码（如 `8A` / `7B`），供 AutoMix 选调性相邻的下一首；识别不出为空串 |
| `energy` | **p0-9 起**。0~1 听感能量：`p0-10` 起以整体响度为主（`(lufs+22)/16`），叠加高频占比（65–2000 Hz 段），供场景歌单分桶与 AutoMix 排序 |
| `loudnessLufs` | **p0-9 起**。整曲响度近似（LUFS 口径，`-0.691 + 10·log10(meanSquare)`），供响度均衡补偿 |
| `peakDb` | **p0-9 起**。样本峰值电平（dBFS） |
| `climaxStartMs` | **p0-7 起**。进度条高潮标记窗口起点（ms）：`p0-8` 起为重复副歌第一次出现的起点（无重复副歌时为能量最高段落内 8 小节窗口的起点）；未命中为 `0` |
| `climaxEndMs` | **p0-7 起**。高潮标记窗口终点（ms）：`p0-8` 起最多延伸 16 小节（首次副歌）；未命中为 `0` |
| `cueInMs` | **p0-11 起**。推荐混音入点（ms）：首个 `drop` 起点，没有 drop 时取首个 `chorus` 起点，并对齐 8 小节乐句；未识别为 `0` |
| `cueOutMs` | **p0-11 起**。推荐混音让位点（ms）：最后一个 `outro` 段落起点，对齐乐句；没有 outro 时取「可听结尾前 8 小节」附近并向下对齐；未识别为 `0` |
| `meter` | 拍号估计：4 或 3（P0 仅这两类） |
| `warnings` | 例如 `["tempo-drift"]`、`["low-confidence"]`、`["mono-mix"]`，无则空数组 |

时间基准：**相对音频文件起点**。本地 CUE 分轨（`track.startAt > 0`）时，页面用
`positionMs + startAt` 对齐到文件时间轴后使用。

尾端静音/渐弱收尾检测（analyzer `p0-5` 起，宿主在解码重采样后的单声道 PCM 上计算）：

- 真静音：阈值 `-50 dBFS`（RMS）；按 20 ms 窗口从尾部向前扫描，连续静音 ≥300 ms 才视为有效尾部静音；
- 渐弱收尾（`p0-5` 起）：真静音不足 300 ms 时再尝试——按 250 ms 能量块求 dB，曲身电平取 80 分位、尾块电平取末 4 块中位数；尾块须低于曲身 ≥8 dB，从尾部向前用 2 s 滑窗最小二乘拟合斜率，斜率持续 ≤ -0.7 dB/s 的起点即渐弱开始处；
- 渐弱段需满足：时长 2–20 s、不超过全曲 40%、整体衰减 ≥8 dB、起点电平不低于曲身电平 6 dB（否则不算渐弱收尾）；
- 两种收尾都至少保留 10% 时长（防止把整首/近乎整首误判成静音）；结果钳制在 `0..durationMs`；
- 无有效尾部静音/渐弱收尾时 `audibleEndMs = durationMs`、`tailSilenceMs = 0`；
- 全静音音频按「至少保留 10%」返回 `audibleEndMs ≈ durationMs*10%`；
- 字段放在响应顶层（与 `durationMs` 同级），不改动 `analysis` 子对象已有字段语义。

### 2.1.1 高潮段（`climax`，analyzer `p0-6` 起；重复副歌检测 `p0-8` 起）

`sections` 里会把命中的内部段落标成 `label: "climax"`，并在 `analysis` 顶层给出
`climaxStartMs` / `climaxEndMs`，供播放进度条画高潮位置；`p0-8` 起优先标「重复副歌」的
**第一次出现**，而不是全曲最响的那一段：

- 小节能量：归一化后的 low/mid/high 三档能量加权 `0.45 / 0.30 / 0.45`，再按 3 小节滑动平均压掉鼓点抖动；
- 音级能量（chroma）：对 1024 点 Hann STFT 的幅度谱，把 65–2000 Hz 的 bin 按 12 平均律映射到 12 个音级，按小节取均值后做 L2 归一化；
- 只在**内部段落**里找（跳过首段、末段，以及已有 `intro`/`outro` 标签的段落）；段落须 ≥8 小节；
- 每个候选段落按长度归一重采样成 12 个点，每点 = 12 维 chroma + `0.7 ×` 平滑能量（13 维），得到段落轮廓；
- 两两计算轮廓的余弦相似度：`≥0.88` 且两段平均能量都 `≥ 全曲均值 × 0.95` 视为同一段副歌（副歌通常重复 2–3 次）；取「两段中较低能量更高」的一对；
- 命中时标**先出现**的那一段：`climaxStartMs` 取该段首小节强拍，`climaxEndMs` 最多延伸 `16` 小节（副歌常见长度；超出截断，避免占掉半条进度条），`label = "climax"`、`confidence = 0.5`；
- 找不到重复副歌时回退到旧规则：能量最高内部段落（平均能量 ≥ 全曲均值 ×1.08）内能量最高的 8 小节窗口，`confidence = 0.45`；
- 没有明显峰值（平坦 / 安静 / 纯音乐）时**不标**，`climaxStartMs = climaxEndMs = 0`；
- 它仍是结构近似（chroma 相似度 ≠ 人工标注副歌），只用于进度条位置提示，不参与无缝衔接调度；
- `p0-8` 起 `analyzer` 变化会让旧缓存失效并重算（缓存键含 analyzer 版本）；旧缓存 / 旧宿主没有这两个字段时，页面回退到 `sections` 里 `label = "climax"` 的整段。

### 2.1.2 调性 / 能量 / 响度（analyzer `p0-9` 起，`energy` 口径 `p0-10` 起）

`p0-9` 起页面侧新增三个用途：场景歌单分桶、AutoMix 选歌、响度均衡。对应字段：

- `key` / `keyMode` / `camelot`：把全曲 chroma（12 音级能量，65–2000 Hz）与 Krumhansl
  major/minor 轮廓做 12 个主音的皮尔逊相关，取最高的一组得到主音与调式；`camelot` 按
  Camelot 轮盘映射（major → `xB`，minor → `xA`），主音为 C major = `8B`、A minor = `8A`。
  识别不出（全静音/无音高内容）时 `key = -1`、`keyMode`/`camelot` 为空串。
- `loudnessLufs`：全曲均方能量的 LUFS 近似 `-0.691 + 10·log10(meanSquare)`（未做 K 加权/
  gating，用于响度均衡的粗补偿）；`peakDb` 为样本峰值 dBFS。
- `energy`（0~1）：`p0-10` 起改为「听感能量」——`0.72 × clamp((lufs+22)/16) + 0.28 ×
  clamp((brightness-0.10)/0.30)`，其中 `brightness` 是 65–2000 Hz 以上的高频能量占全频段比例。
  早先 `p0-9` 用的「小节三档能量均值」因 `barFeatures` 已按频段归一化会恒等于 1，不可用于分桶。
- 这些字段只在成功响应里出现；`cacheOnly` 查询（§2 参数表）不会触发下载/解码，页面用
  `peekAnalysis` 批量取缓存结果做场景分桶与 AutoMix 排序。
- `analyzer` 版本变化（如 `p0-10`）会让旧 JSON 缓存失效并重算，音频缓存保留。

### 2.1.3 结构分段与混音 cue（analyzer `p0-11` 起）

`p0-11` 把 `sections` 从「只标首尾 + climax」升级为结构分段，并新增 `cueInMs` / `cueOutMs`，
给无缝衔接做「cue 对 cue」的 DJ 式过渡：

- 小节特征：每小节归一化 low/mid/high 能量加权 `(low×0.45 + mid×0.30 + high×0.45) / 1.2`，
  段的平均能量记为 `mean`；全曲均值记 `avg`；
- 标签规则（按段落顺序，命中即停）：首段且（`mean ≤ avg×0.95` 或时长 <25%）→ `intro`；
  末段且（`mean ≤ avg×0.95` 或时长 <30%）→ `outro`；`mean < avg×0.55` 且 ≥8 小节 → `breakdown`；
  `mean ≥ avg×1.18` 且低频均值 ≥1.12 且 ≥4 小节 → `drop`；`mean ≥ avg×1.04` → `chorus`；
  段内能量涨幅 ≥0.12 且 `mean ≥ avg×0.7` → `build`；其余 `verse`；
- `cueInMs`：首个 `drop` 起点（没有则首个 `chorus` 起点），再用 `PhraseAtOrAfter` 向上对齐到
  8 小节乐句边界；没有 drop/chorus 时取首个非 intro 段落起点对齐；
- `cueOutMs`：最后一个 `outro` 段落的起点，用 `PhraseAtOrBefore` 向下对齐；没有 outro 时取
  「可听结尾前 8 小节」附近向下对齐；`cueInMs ≥ cueOutMs` 时 `cueOutMs = 0`；
- 页面侧（`web/src/ui/crossfadeDeck.ts`）：A 在 `cueOutMs` 开始让位、B 从 `cueInMs` 进场，
  过渡长度 = 设置里的乐句数（默认按场景预设 4 / 8 小节）；低频交接按 B 的小节线换算进度；
  两首按 `loudnessLufs` 预调 B 的增益（±6 dB）；BPM 差在设置范围内用 WSOLA 变速对齐；
  调性/BPM 冲突（`camelot` 相隔 >2 或 BPM 差 >12%）时改用 1–2 小节快速切入；
- 分析数据缺失（旧缓存 / 未分析 / 手动切歌 / 单曲循环）时页面回退旧淡化逻辑；
- `p0-11` 升版会让旧 JSON 缓存失效并重算，音频缓存保留。

### 2.2 失败响应

```json
{ "v": 1, "ok": false, "code": "upstream-failed", "message": "音频源连接失败，请稍后重试" }
```

## 3. 页面使用（P0）

- 设置 → 播放 页新增「节拍分析（实验）」区块：
  - 「分析当前歌曲」：对 `playerState().track` 调接口，显示 BPM / 拍号 / 置信度 / 拍点偏移 / 小节数 / 乐句数 / 缓存或耗时；
  - 「分析下一首」：对队列下一首调接口并缓存结果（为 B 版对齐做准备）；
  - 节拍器开关 + 音量 + 强拍加重（localStorage 持久化，后续迁入设置契约）；
  - 节拍器只在播放中生效；按分析出的拍点（强拍用更高音）在音频上打 click。
- 分析请求必须显示 loading（同步接口，预计 0.5~5 s；在线曲目含下载会更久）。

## 4. 性能与约束

- 解码：宿主 `MediaFoundationReader`（mp3/flac/wav/m4a，Windows 内置解码器）；不支持格式返回 `decode-failed`。
- 分析：单声道 22050 Hz 重采样 → 谱通量 onset → 自相关/tempogram 求 BPM →
  动态规划拍点跟踪 → 强拍相位选择 → 小节级 novelty 求乐句；解码后的 PCM 上另做尾端静音
  检测（§2.1 的 `audibleEndMs`/`tailSilenceMs`）。C# 实现，复用/参考
  `src/Zilux2/Audio/AudioFeatures.cs` 的 radix-2 FFT。
- 目标耗时：4 分钟曲目 < 2 s（不含在线下载）；在线下载取决于网络。
- 线程：分析在后台线程池执行，禁止阻塞 UI 线程；HTTP 处理器里 await。

## 5. B 版预留（后续迭代扩字段，不改现有语义）

```json
"future": {
  "transitionPlan": {
    "fromSource": "netease", "fromId": "1", "toSource": "netease", "toId": "2",
    "startAtMs": 120000, "bars": 4, "tempoRatio": 1.024, "method": "wsola",
    "confidence": 0.8
  },
  "normalized": { "bpm": 128.0, "firstDownbeatMs": 0 },
  "beatGrid": { "offsetMs": 125, "intervalMs": 468.75, "downbeatEvery": 4 }
}
```

- `normalized`/`beatGrid` 是「已对齐到目标 BPM/拍网」的播放参数；
- `transitionPlan` 由宿主在分析两端后生成；P0 不返回。

## 6. 验收（P0）

1. 合成 WAV（120 BPM、128 BPM、75 BPM 强拍加重）分析：`bpm` 误差 ≤ 1，`firstDownbeatMs` 误差 ≤ 60 ms，`meter` 正确。
2. 本地真实 mp3 至少 3 首：人工用节拍器试听，click 落在拍点上（可接受个别弱拍漏检）。
3. 在线曲目（代理可用时）走完整链路：分析成功、缓存命中第二次 `cached=true` 且 `elapsedMs` < 300 ms。
4. 失败路径：不存在曲目返回 `not-found`；不可播返回 `not-playable`；页面展示错误文案不崩。
5. 关闭窗口到托盘/后台时分析仍可完成（不依赖前台定时器）。
