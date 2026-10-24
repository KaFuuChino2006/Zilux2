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
| `token` | 必填，与其他 `/api/*` 相同的 loopback token |

语义：
- 同步接口。宿主解析/下载（在线曲目）+ 解码 + 分析；P0 单曲上限约 12 分钟音频。
- 结果缓存：`%LOCALAPPDATA%\Zilux2\analysis\`（音频缓存 + JSON），键为 `source:id:analyzerVersion`；
  命中缓存时 `cached=true` 且 `elapsedMs` 很小。缓存上限 300 MB，超限按 mtime 淘汰。
- 同曲并发请求合并（单飞），不重复下载/分析。
- 失败返回 `ok:false` + `code`（`not-found`/`not-playable`/`upstream-failed`/`decode-failed`/`timeout`/`internal-error`）。

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
  "cached": false,
  "elapsedMs": 1834,
  "analyzer": "p0-1",
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
    "sections": [
      { "startMs": 0, "endMs": 30000, "label": "intro", "confidence": 0.6 },
      { "startMs": 30000, "endMs": 180000, "label": "", "confidence": 0.3 }
    ],
    "warnings": []
  }
}
```

| 字段 | 含义 |
|---|---|
| `beatIntervalMs` | 平均拍间隔（毫秒，浮点）；P0 假设全曲恒定速度 |
| `firstBeatMs` | 第一拍的时间（相对音频文件起点） |
| `firstDownbeatMs` | 第一小节强拍时间，`(firstDownbeatMs-firstBeatMs)/beatIntervalMs` 是整数相位 |
| `downbeats` | 强拍时间列表（毫秒，升序，最多返回 ~400 个，超出截断） |
| `phraseStartsMs` | 检测到的乐句/段落边界时间（每 8/16 小节级别） |
| `barCount` | 估计小节数 |
| `meter` | 拍号估计：4 或 3（P0 仅这两类） |
| `warnings` | 例如 `["tempo-drift"]`、`["low-confidence"]`、`["mono-mix"]`，无则空数组 |

时间基准：**相对音频文件起点**。本地 CUE 分轨（`track.startAt > 0`）时，页面用
`positionMs + startAt` 对齐到文件时间轴后使用。

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
  动态规划拍点跟踪 → 强拍相位选择 → 小节级 novelty 求乐句。C# 实现，复用/参考
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
