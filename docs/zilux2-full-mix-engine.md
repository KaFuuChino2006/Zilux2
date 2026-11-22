# Zilux2 完整混音系统设计 v1（Full Mix Engine）

> 目标不是"复刻 AutoMix"，而是**在本地曲库上做一个能力域比 AutoMix 更完整的混音系统**：苹果做不到的（任意本地文件、可编辑、可解释、可学习、更激进的重编）全部纳入范围。
> 前置阅读：[zilux2-automix-vs-apple.md](zilux2-automix-vs-apple.md)（苹果原理拆解 + 现有差距）。
> 基线代码：`v1.1.103`。本文只写设计与契约，不含实现。

---

## 0. "完整"的定义

六个能力域必须全部在线，缺一不算完整：

| 域 | 职责 | 现状 |
|---|---|---|
| **理解** | 把音频变成结构化特征（拍、段落、活动度、响度、调性、可重复单元） | 有一半，缺活动度/瞬态响度/loop/时间线 |
| **决策** | 能不能混 → 值不值得混 → 用哪种形态 → 参数多少 | 只有一条路（等功率），门控只有 key+BPM |
| **重编** | 改音频内容本身：重复尾奏、裁前奏、拼桥、换段 | 完全没有 |
| **拉伸** | 变速不变调、速率斜坡、相位锁 | 单侧 `playbackRate`，±12% |
| **混合** | 分频、换手、duck、扫频、空间、限幅 | 整轨等功率 |
| **自愈** | 质量门、降级、遥测、回退 | 无 |

外加两个"完整系统"才有的域：

| 域 | 职责 |
|---|---|
| **交互** | 可解释、可手动覆盖、"为什么这样混" |
| **学习** | 从用户行为（跳过/重播/手动改）学习偏好，本地化，不联网 |

---

## 1. 总体架构

```
┌──────────────────────────── 离线（分析期，可批量可懒加载）────────────────────────────┐
│  S0 摄取解码 ──► S1 音频理解（6+3 域）──► S2 特征库（SQLite，版本化）                    │
│                        │                                                                │
│                        └──► 教师模型（htdemucs）离线蒸馏 → activity 回归器（ONNX, 1–2MB）│
└────────────────────────────────────────────────────────────────────────────────────────┘
                                     │  features(trackId, analyzerVersion)
                                     ▼
┌──────────────────────────── 规划期（纯函数，可单测，可离线 dump）──────────────────────┐
│  S3 配对与规划 ──► S4 结构编辑 ──► S5 拉伸方案 ──► S6 DSP 参数表                        │
│   （gating/选型）    （loop/裁切/拼桥）  （rate 曲线）    （每 5ms 断点）                 │
│                                                                                         │
│  产出：MixPlan（可 JSON 序列化、可回放、可比较）                                          │
└────────────────────────────────────────────────────────────────────────────────────────┘
                                     │  MixPlan
                                     ▼
┌──────────────────────────── 渲染期（实时，只执行，不决策）──────────────────────────────┐
│  S7 调度器：预取 buffer → 预拉伸 → sample-accurate 排程 → AudioWorklet DSP 链            │
│  S8 质量门：离线预演 + 运行时低频监控 + 自愈降级                                          │
│  S9 交互：解释面板 / 手动覆盖 / 偏好学习                                                  │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

**三条铁律**：

1. **决策全在离线/规划期**。渲染期不允许出现"现在算一下要不要降级"——降级必须在 `MixPlan` 里预先写好。
2. **MixPlan 是唯一真相**。播放、调试、回归测试、遥测都用同一个对象。
3. **实时层零分配、零决策、零 await**。主线程只做 UI。

---

## 2. 模块分解

### S0 摄取与解码

**职责**：任何输入 → 规范 PCM（48kHz / float32 / 立体声）+ 精确时长与静音边界。

| 项 | 设计 |
|---|---|
| 解码 | 复用 [`TrackAudioDecoder.cs`](../src/Zilux2/Analysis/TrackAudioDecoder.cs)，输出**规范 48k float32**；上游一律按 48k 处理，避免混音期重采样 |
| 裁剪 | `cueInMs` / `cueOutMs` / `audibleEndMs` / `tailSilenceMs` 由 S1 产出，播放期不再重算 |
| 无缝 | 单曲内不拼接；跨曲拼接全部走 buffer 级 sample-accurate，禁用 `<audio>` 元素的 gap |
| 校验 | 文件哈希（xxHash64）作为缓存键；同文件不同标签/封面不重新分析 |

**产出**：`PreparedTrack { trackId, fileHash, sampleRate=48000, channels, durationMs, pcmRef }`

### S1 音频理解

九个分析域。前六个对齐 Apple `MusicUnderstanding`，后三个是"完整系统"的增量。

| 域 | 字段 | 算法（首选 → 兜底） | 备注 |
|---|---|---|---|
| 拍网格 | `beatsMs[]`, `bpm`, `bpmConfidence`, `tempoCurveMs/Bpm` | **Beat This!**（ONNX）→ 现有 ACF+comb+DP（[`BeatAnalyzer.cs:602`](../src/Zilux2/Analysis/BeatAnalyzer.cs#L602)、[`:1524`](../src/Zilux2/Analysis/BeatAnalyzer.cs#L1524)） | 双跑一致率 ≥90% 才采信模型 |
| 小节 | `downbeats[]`, `meter`, `barCount` | 模型 downbeat → 低音重音相位（[`:1459`](../src/Zilux2/Analysis/BeatAnalyzer.cs#L1459)） | 4/3 拍都支持 |
| 结构 | `sections[]`（intro/build/verse/chorus/drop/breakdown/outro） | **SSM + checkerboard novelty** → 现有分带 novelty（[`:1752`](../src/Zilux2/Analysis/BeatAnalyzer.cs#L1752)） | SSM 是本次唯一必做的结构升级 |
| 乐句 | `phrases[]`（区间，不是起点数组） | 段落边界 + 4/8 小节网格对齐 | 契约从 `phraseStartsMs` 升级 |
| 调性 | `keyTimeline[]`（区间调性）+ `key`/`camelot` | 局部 chroma + Viterbi → 现有整曲 Krumhansl（[`:233`](../src/Zilux2/Analysis/BeatAnalyzer.cs#L233)） | 支持转调曲 |
| 响度 | `loudnessLufs`, `momentaryLufs[]`（400ms/100ms）, `peakDb`, `shortTermLufs[]` | 现有 [`LoudnessMeter.cs`](../src/Zilux2/Analysis/LoudnessMeter.cs) 铺窗 → EBU R128 | 增益对齐与 duck 判断都用 |
| 活动度 | `activity{vocal[], drum[], bass[], other[]}`（hop 50ms，0…1） | **htdemucs 蒸馏的三头回归器**（ONNX）→ 免分轨 DSP 代理（HPSS + 频带占比） | 蒸馏脚本离线跑，播放期只跑小模型 |
| 可重复单元 | `loopUnits[]{startMs,endMs,bars,kind,confidence}` | SSM 对角线段 + 能量方差 + 无 vocal + downbeat 边界 | 结构桥接的原料 |
| 能量曲线 | `energyCurve[]`, `climaxStartMs/EndMs` | 现有 `ComputeEnergy`（[`:314`](../src/Zilux2/Analysis/BeatAnalyzer.cs#L314)） | 用于 set 级排布 |

**并行策略**：S1 是 CPU 密集型，用 `Parallel.For` 按域并行（Beat This! 与 SSM 无依赖），目标单曲 4 分钟 ≤ 8 秒（模型 RTF ≤0.15，DSP ≤1.0）。

### S2 特征库

**从 JSON 文件改为 SQLite**（单文件、WAL、索引、事务）：

```sql
CREATE TABLE track (
  track_id TEXT PRIMARY KEY,
  file_hash TEXT NOT NULL,
  duration_ms INTEGER,
  analyzer_version TEXT NOT NULL,
  features_json TEXT NOT NULL,   -- AnalysisFeatures v2
  created_at INTEGER
);
CREATE INDEX idx_track_hash ON track(file_hash, analyzer_version);

CREATE TABLE loop_unit (          -- 便于按条件查询候选
  track_id TEXT, start_ms INTEGER, end_ms INTEGER,
  bars INTEGER, kind TEXT, confidence REAL,
  PRIMARY KEY (track_id, start_ms)
);

CREATE TABLE mix_history (        -- 偏好学习与回归
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  a_track TEXT, b_track TEXT, plan_json TEXT,
  metrics_json TEXT, user_action TEXT,   -- skip/replay/override/none
  created_at INTEGER
);
```

- 缓存键：`(fileHash, analyzerVersion)`。**`analyzerVersion` 一改，全库自动失效**——沿用现有 `BeatAnalyzer.AnalyzerVersion`（当前 `"p0-15-tail-anchor"`）的做法，但升到文件级常量。
- 迁移：老 JSON sidecar 首次读到时导入，不丢历史。

### S3 配对与规划

四步流水，全部纯函数：

```
gating()  →  shape()  →  params()  →  plan()
```

**3.1 硬门控（能不能混）**

| 条件 | 结果 |
|---|---|
| 无 downbeats 或 `bpmConfidence < 0.3` | `none`（不混，直接切） |
| B 可播前奏 `headRoomMs < 2 * barMs` | `cut` 或 `fade`，禁止变速对齐 |
| `energyGap > 0.45` 且 `keyDistance >= 3` | `fade`（短淡出，不硬拼） |
| 任一首是"顺序专辑模式"（用户设置） | `none` |
| 变速需求 `|r-1| > 0.22` | 降级到 `bridge` 或 `fade` |

**3.2 形态选择**

| 形态 | 何时用 | 关键动作 |
|---|---|---|
| `cut` | 拍速差 >0.25 且 key 不合 | 在 downbeat 上硬切，前面加 1 拍短淡出防爆音 |
| `fade` | 不兼容、或用户偏好 | 8–16 小节等功率 + 低频换手 |
| `warp` | 拍速差 ≤0.15、key 兼容 | 变速对齐 + 频段换手 + duck |
| `loopBridge` | A 有干净尾奏/loop 单元，B 前奏弱 | A 尾奏重复 k 次补足到 B 的乐句边界 |
| `bridge` | 两首都不适合直接对拍 | 用 A 或 B 的 loop 单元预渲染一段"桥"（1–2 小节），作为第三路 voice |
| `doubleDrop` | 同 key、能量接近、都是 drop | 双 drop 叠加，必须限幅（峰值 ≤ −0.3 dBFS） |

**3.3 Set 级排布（Apple 没有）**

不只算一对，而是算接下来 N 首（默认 5）的**能量弧线**：

```
目标：energy[i+1] - energy[i] ∈ [-0.15, +0.25]，整体单调不塌
约束：key 相邻 ≤1 步（Camelot），BPM 相邻 ≤8%
求解：动态规划（N ≤ 8，状态 = 上一首的 key/BPM 桶），O(N * buckets²)
```

产出：每对的 `targetEnergy`，作为 S3.2 形态选择的输入（能量要升 → 用 `warp`/`doubleDrop`；要降 → 用 `fade`/`bridge`）。

**3.4 参数求解（乐句同余）**

```
已知：A 的可混出点集合 PA（每个 phrase 结束 + 段落结束），B 的可混入点集合 PB
求：aEnd ∈ PA, bStart ∈ PB, k ∈ {0,1,2}, rate ∈ [0.85, 1.18]
使：|(aEnd + k·L) − bStart·rate| < 1 拍      （L = A 的乐句长度）
打分：乐句匹配1.0 + 段落类型0.4 + 能量连续0.3 + 时长偏好0.2 − 人声重叠0.5 − 变速需求0.3
约束：aEnd + k·L ≤ audibleEndMs；过渡总长 ∈ [1.2s, 32s]
```

`rate` 与 `k` 联合求解（先枚举 k，再对每个 k 求最优 rate）。k 只重复 **A 侧**（B 侧重复会破坏"新歌从哪开始"的预期）。

### S4 结构编辑

**这是"完整系统"和 Apple 同级、也是唯一零音色代价的手段。**

| 动作 | 实现 | 精度 |
|---|---|---|
| A 尾奏重复 k 次 | 取 `loopUnit` 的 PCM，离线拼成 k+1 段的连续 buffer（段间 5ms 交叠淡化） | sample-accurate |
| B 前奏裁剪 | `source.start(when, offsetSec)` 直接跳到最近乐句 | sample-accurate |
| B intro 重复 | 同 A 尾奏，但只允许 1 次，且必须无 vocal | sample-accurate |
| 拼桥（bridge voice） | 从 A/B 的 loopUnit 预渲染 1–2 小节，作为独立第三路，带自己的滤波/增益包络 | sample-accurate |
| 段落跳接 | 仅在同调性同拍速时允许，且必须 drop→drop | 需人工确认（默认关） |

**关键实现约束**：所有拼接**离线预渲染**成一个 buffer，播放期不做实时 loop。理由：Web Audio 的 `loop` 在 buffer 边界会有 1–2 个 sample 的 gap 或重复，人耳在低频上听得出来。

### S5 时间伸缩

**核心决策：离线预拉伸 + 在线微调。**

| 阶段 | 做什么 | 为什么 |
|---|---|---|
| 规划期 | 知道需要 `rate`（比如 0.93） | 过渡前 8–32 秒就有结论 |
| 预渲染期 | 用高质量 phase vocoder 把 B 的前 N 小节渲染成"已按 rate 拉伸"的 buffer | 零实时 CPU、无音质妥协、无变调 |
| 播放期 | `playbackRate = 1.0`，只用 worklet 做 ±2% 的 PLL 微调 | PLL 只需修相位，不需要大范围变速 |
| 回正 | 小节量化：最后一小节内线性回 1.0 | 听不出"速度在变" |

**PLL**：复用 [`beatPll.ts`](../web/src/core/beatPll.ts) 的思路，误差目标 ≤3ms，只在变速段启用。

### S6 混音 DSP

六层，逐层可关（配置位图），全部离线生成参数断点：

| 层 | 内容 | 参数 |
|---|---|---|
| **A 分段等功率** | 120Hz LR4 分频；低频 `a=1-p, b=p`（linear），高频 `cos/sin` | 分频 120Hz，斜率 24dB/oct |
| **B 频段换手** | 横轴 = `barIndex/totalBars`；A：LPF 20k→8k→3k→1.2k、HPF 20→40→80→200；B：HPF 8k→2k→300→20 | 每小节一个断点 |
| **C 人声 duck** | A 的 1.5–4kHz peaking，由 B 的 `activity.vocal` 包络驱动 | −6dB, Q=1.2, attack 20ms, release 80ms |
| **D 滤波扫频** | 苹果签名：A 低通下沉 + B 高通开窗 | 与 B 层合并计算，避免双滤波叠加过陡 |
| **E 空间** | A 在尾部加短 reverb（0.8s, 20% wet），B 干声进 | 只在 `fade`/`bridge` 启用 |
| **F 母线** | 3 段 EQ 微调 + 真峰值限幅 | 峰值 ≤ −0.3 dBFS，lookahead 5ms |

**禁止**：在 A 侧做"高通 + 低通同时收窄"（会变成电话音，这是旧实现最容易翻车的地方）。

### S7 渲染调度

| 项 | 设计 |
|---|---|
| 图 | `deckA` / `deckB` / `bridge` 三路 → `sumBus` → `masterEQ` → `limiter` → `analyser` → `destination` |
| 时钟 | 全部用 `AudioContext.currentTime` 绝对时间排程；`lookahead = 120ms` |
| 参数 | 规划期生成断点表（5ms 间隔，单参数 ≤2400 点），用 `setValueAtTime` + `linearRampToValueAtTime` 批量写入；**禁止每帧写 AudioParam** |
| 预取 | 过渡前 30s 开始准备 B 的 PCM 与预拉伸 buffer；失败则规划期已写好的降级路径接管 |
| 三路混音 | `bridge` 与 `deckA` 共用同一 A 素材，但走独立增益/滤波，便于"桥"独立淡出 |
| 无锁 | worklet 参数用 `SharedArrayBuffer` ring，主线程写索引，音频线程读 |

### S8 质量门与自愈

**两级：规划期预演 + 运行期监控。**

**8.1 离线预演（OfflineAudioContext）**

把 `MixPlan` 在离线上下文完整渲染一遍（10–30s，通常 <500ms），测四项：

| 指标 | 门限 | 超标处理 |
|---|---|---|
| `bassBumpDb`（80–160Hz 包络最大值 − 两曲均值） | ≤ 2.0 dB | 降级到 `fade`，或把换手点提前一小节 |
| `vocalOverlapBeats` | ≤ 1.0 拍 | 移动 `bStart` 到下一乐句 |
| `loudnessDriftLu` | ≤ 1.5 LU | 调 `gainTrimDb` |
| `rateJumpPctPerBeat` | ≤ 1.5% | 拉长 ramp |

**8.2 运行期监控**

`AnalyserNode` 每 50ms 采低频能量；若连续 3 次超过预期 +3dB → 触发**已预置**的自愈脚本（不是临时算）：A 低频额外 −6dB，200ms 内完成。

**8.3 遥测**

本地 JSONL：`{planId, metrics, degraded, userAction}`。不联网，可用于回归与偏好学习。

### S9 交互、可解释与偏好学习

| 功能 | 设计 |
|---|---|
| 解释面板 | "本次为什么这样混"：门控结论、形态、锚点小节号、loop 次数、rate、四项质量分 |
| 手动覆盖 | 拖过渡起点、选形态、强制"8 小节"、禁用重编；覆盖结果写入 `mix_history` |
| 偏好学习 | 每次 skip/replay/override 作为反馈；本地 Thompson sampling 调 6 个权重（段落匹配/能量连续/人声惩罚/变速惩罚/重编偏好/时长偏好） |
| 预设 | 三档：`auto`（默认）/`club`（长过渡、爱重编）/`radio`（短、少变速） |

---

## 3. 数据契约

### 3.1 AnalysisFeatures v2（S1 产出，S2 存储）

```ts
interface AnalysisFeatures {
  v: 2; analyzerVersion: string; fileHash: string;
  durationMs: number;
  bpm: number; bpmConfidence: number; meter: 3 | 4;
  beatMs: number;
  beatsMs: number[]; downbeatsMs: number[]; barCount: number;
  tempoCurveMs: number[]; tempoCurveBpm: number[];
  tempoStability: number;
  key: number; keyMode: 'major' | 'minor'; camelot: string;
  keyTimeline: { startMs: number; endMs: number; key: number; mode: 'major'|'minor' }[];
  sections: { startMs: number; endMs: number; label: SectionLabel; confidence: number }[];
  phrases: { startMs: number; endMs: number; bars: number }[];
  activity: { hopMs: number; vocal: number[]; drum: number[]; bass: number[]; other: number[] };
  loudnessLufs: number; peakDb: number;
  momentaryLufs: number[]; shortTermLufs: number[];
  energyCurve: number[]; climaxStartMs: number; climaxEndMs: number;
  cueInMs: number; cueOutMs: number; audibleEndMs: number; tailSilenceMs: number;
  loopUnits: { startMs: number; endMs: number; bars: number; kind: 'outro'|'intro'|'drop'|'chorus'; confidence: number }[];
}
```

### 3.2 MixPlan（S3/S4/S5/S6 产出，S7 执行）

```ts
interface MixPlan {
  id: string; aTrack: string; bTrack: string; analyzerVersion: string;
  gating: { allowed: boolean; reason: string; score: number };
  shape: 'cut' | 'fade' | 'warp' | 'loopBridge' | 'bridge' | 'doubleDrop';
  timeline: {
    aStartMs: number; aEndMs: number; bStartMs: number; bEndMs: number;
    totalMs: number; bars: number; beatMs: number; barMs: number;
  };
  warp: {
    rate: number; bRate: number; aRateStart: number; aRateEnd: number;
    rampBars: number; restoreBars: number; pllEnabled: boolean;
  } | null;
  arrangement: {
    aLoop: { startMs: number; endMs: number; repeats: number } | null;
    bTrimMs: number;
    bIntroRepeat: { startMs: number; endMs: number; repeats: number } | null;
    bridgeVoice: { source: 'a' | 'b'; startMs: number; endMs: number; repeats: number } | null;
  };
  dsp: {
    splitHz: number;
    handoffBars: number;
    duck: { enabled: boolean; freq: number; gainDb: number; q: number } | null;
    sweep: { aLpf: [number, number][]; bHpf: [number, number][] } | null;
    echo: { enabled: boolean; divisionBeats: number; feedback: number; dampHz: number } | null;
    limiterCeilingDb: number;
  };
  qc: { bassBumpDb: number; vocalOverlapBeats: number; loudnessDriftLu: number; rateJumpPct: number; pass: boolean };
  explain: string[];
}
```

### 3.3 运行时边界

- `MixPlan` 大小上限 64KB（断点表另存，走 `SharedArrayBuffer`）。
- 任何字段缺失 → 规划期报错，不进渲染期。

---

## 4. 模型清单

| 任务 | 模型 | 体积 | 许可 | 部署 | 失败模式 | 兜底 |
|---|---|---|---|---|---|---|
| 拍/强拍 | **Beat This!** | ~17MB | MIT | 宿主 ONNX，分析期 | 极端自由速度 | 现有 DSP 双跑 + 一致性门控 |
| 拍/强拍/结构/调性（对照） | All-in-One | 中 | MIT | 仅 A/B 实验 | 标签体系不一致 | 不进主路径 |
| 分乐器活动度 | **htdemucs 蒸馏回归器（自训）** | 1–2MB | 自有 | 宿主 ONNX | 电吉他误判 vocal | Silero VAD 交叉校验 |
| 人声有无 | Silero VAD | ~2MB | MIT | 宿主 ONNX | 说唱/念白 | 阈值保守 + 可关 |
| 教师模型 | htdemucs（已有） | 已有 | MIT | 仅离线蒸馏 | — | — |

**不引入**：生成式音频模型（相位/伪影/延迟）、云端 API（离线产品）、MERT/CLAP（当前瓶颈不在选曲）。

---

## 5. DSP 拓扑

```
deckA: srcA ─► gainTrimA ─► LR4split
                             ├─ lowA ─► lowGainA ─┐
                             └─ highA ─► hpfA ─► lpfA ─► eqA ─► duckA ─► panA ─┤
                                                                                  ├─► sumBus
deckB: srcB ─► gainTrimB ─► LR4split                                              │
                             ├─ lowB ─► lowGainB ─┐                                │
                             └─ highB ─► hpfB ─► lpfB ─► eqB ─► panB ────────────┤
bridge: bufBridge ─► gainBr ─► lpfBr ─► echoSend ─► panBr ────────────────────────┘
                                                                                  │
sumBus ─► masterEQ(3band) ─► limiter(lookahead 5ms) ─► analyser ─► destination
```

| 节点 | 参数范围 |
|---|---|
| `LR4split` | 80–200Hz，默认 120Hz，斜率 24dB/oct |
| `lowGainA/B` | −∞…0dB，换手期用 linear 曲线 |
| `hpfA` | 20–400Hz；`lpfA` 20k–700Hz |
| `hpfB` | 20–8kHz；`lpfB` 固定 20k |
| `duckA` | 1.5–4kHz peaking，−9…0dB，Q 0.7–2.0 |
| `echoSend` | 1/8–1/2 拍，fb 0.2–0.45，damp 2–5kHz |
| `limiter` | ceiling −1.0…−0.1 dBFS |

---

## 6. 时钟与调度细节

| 场景 | 做法 |
|---|---|
| 过渡启动 | `t0 = ctx.currentTime + 0.12`；所有事件以 `t0` 为原点计算绝对时间 |
| 变速 | 预拉伸 buffer 的 `playbackRate = 1.0`；PLL 微调通过 worklet 的 `timeRatio` 参数（±2%） |
| 回正 | 最后一小节内 `timeRatio: 1.02 → 1.0`，线性 |
| loop 拼接 | 离线拼好的单个 buffer，`loop = false`，避免边界 gap |
| B 起播 | `srcB.start(t0 + bStartOffsetSec, bStartFileSec)` |
| 结束 | A 在 `aEndMs` 前 30ms 已降到 −60dB，之后 `stop()` 并释放 |
| 预取 | 提前 30s 准备；不可用时不改计划，用计划的降级档 |

---

## 7. 性能预算

| 项 | 预算 | 依据 |
|---|---|---|
| 单曲分析（4 分钟） | ≤ 8s（CPU 4 核） | 模型 RTF 0.15 + DSP 1.0 并行 |
| 内存（播放期） | ≤ 120MB | 预拉伸 buffer 2×30s×48k×2ch×4B ≈ 23MB + 预取 |
| 主线程 | 帧内 ≤ 2ms | 无音频计算 |
| 音频线程 | ≤ 25% 单核 | 六层 DSP + 3 路 |
| 过渡启动抖动 | ≤ 5ms | lookahead 120ms |
| 分析缓存 | SQLite ≤ 50MB / 1000 首 | 曲线降采样到 50ms |

---

## 8. 质量体系

**8.1 单测（纯函数）**

- `gating`：全分支真值表。
- `params`：乐句同余对 200 组合成用例，验证 |误差| < 1 拍、k ≤ 2、不越界。
- `MixPlan` 序列化：JSON 往返一致。
- DSP 断点表：单调、无跳变、边界值合法。

**8.2 黄金样本**

30 首覆盖 90/100/128/140/150 BPM、有/无尾奏、有/无前奏、男声/女声/纯器乐、转调曲、自由速度曲。每组：`features` + `MixPlan` + 离线渲染的 WAV 指纹（前 30s 的 MFCC 均值）。

**8.3 盲听协议**

每轮 20 组，A/B 双盲（Zilux2 vs 现有标准路径），至少 3 人，三档打分：像 DJ / 像淡出 / 听不出。目标：像 DJ ≥ 60%，听不出 ≤ 10%。

**8.4 指标回归**

CI 里跑 `qualityGate` 的离线预演，四项指标任一超限即失败。

---

## 9. 实施分期

| 期 | 内容 | 人日 | 出口条件 |
|---|---|---|---|
| **P0 基础** | 标注集 30 首；SQLite 特征库；契约 v2 落地 | 6 | 老 JSON 迁移完成，版本失效可验证 |
| **P1 理解** | Beat This! 接入 + 双跑门控；SSM 段落；momentary LUFS；loopUnits | 10 | downbeat 中位误差 ≤10ms；loop 召回 ≥80% |
| **P2 活动度** | htdemucs 蒸馏脚本 + 三头回归器 + VAD 校验 | 8 | bass 曲线相关 >0.85；vocal 误报 <8% |
| **P3 规划** | `automixPlan.ts`、`arrangement.ts`、set 级 DP、单测 | 8 | 200 组合成用例 100% 通过 |
| **P4 渲染** | 预拉伸管线、三路图、六层 DSP、调度器 | 12 | 四项质量门全绿；无双写爆音 |
| **P5 交互** | 解释面板、手动覆盖、偏好学习、遥测 | 6 | 覆盖后计划可复现；偏好学习有 A/B 提升 |
| **合计** | | **50 人日** | |

缓冲 20%（调试/回归/盲听迭代）→ **60 人日**。全职约 12 周，兼职（每天 3h）约 6 个月。

---

## 10. 风险与回退

| 风险 | 影响 | 对策 |
|---|---|---|
| Beat This! 在用户曲库上不如 DSP | 拍点变差 | 双跑门控，一致率不足自动回退，指标可观测 |
| 蒸馏回归器过拟合到电子乐 | 摇滚/古典 activity 失真 | 训练集按流派分层；退到 DSP 代理曲线 |
| 预拉伸 buffer 内存超标 | 长过渡内存峰值 | 只预拉伸 ≤32s；超出走实时 worklet WSOLA |
| sample-accurate 拼接有咔哒 | 听感崩 | 段间 5ms 交叉淡化 + 离线预演检测峰值 |
| 三路混音相位抵消 | 低频变薄 | bridge 只走中高频；与 deckA 低频互斥 |
| 规划期算太久 | 过渡来不及 | 规划预算 50ms；超时用上一对缓存结果或 `fade` |
| 偏好学习学偏 | 越用越怪 | 权重上限 ±30%；可一键重置 |

---

## 11. 文件级改动清单

**宿主（C#）**

| 文件 | 改动 |
|---|---|
| [`src/Zilux2/Analysis/BeatAnalyzer.cs`](../src/Zilux2/Analysis/BeatAnalyzer.cs) | SSM 段落、momentary LUFS、loopUnits、keyTimeline；`AnalyzerVersion` 升 v2 |
| `src/Zilux2/Analysis/BeatThisSession.cs` | **新增**：ONNX 加载 + 分块推理 + 输出 beat/downbeat |
| `src/Zilux2/Analysis/ActivityModel.cs` | **新增**：三头回归器推理 |
| `src/Zilux2/Analysis/VadSession.cs` | **新增**：Silero VAD |
| [`src/Zilux2/Analysis/TrackAnalysisService.cs`](../src/Zilux2/Analysis/TrackAnalysisService.cs) | 域并行、双跑门控、模型降级 |
| `src/Zilux2/Analysis/AnalysisStore.cs` | **新增**：SQLite 特征库（替代 JSON sidecar） |
| `src/Zilux2/Stems/HtdemucsSession.cs` | 仅用于离线蒸馏，不进播放路径 |
| `_tools/distill_activity.py` | **新增**：批量蒸馏脚本（Python，一次性） |

**前端（TS）**

| 文件 | 改动 |
|---|---|
| `web/src/core/features.ts` | **新增**：AnalysisFeatures v2 类型 + 校验 |
| `web/src/core/automixPlan.ts` | **新增**：gating + shape + params |
| `web/src/core/arrangement.ts` | **新增**：乐句同余 + loop 编排 |
| `web/src/core/setPlanner.ts` | **新增**：set 级 DP 能量弧线 |
| `web/src/core/mixScript.ts` | **新增**：MixPlan → RenderScript（断点表、buffer 清单） |
| `web/src/core/qualityGate.ts` | **新增**：离线预演指标 |
| `web/src/audio/stretch.ts` | **新增**：离线预拉伸（OfflineAudioContext） |
| `web/src/audio/mixGraph.ts` | **新增**：三路六层图（替代 `stemGraph.ts` 的过渡用法） |
| `web/src/audio/mixWorklet.ts` | **新增**：分频/duck/limiter/PLL 微调 |
| [`web/src/ui/crossfadeDeck.ts`](../web/src/ui/crossfadeDeck.ts) | 只保留"取下一首 + 调引擎"，过渡逻辑全部移出 |
| `web/src/core/mixTransitionMode.ts` | 三档 → `auto`/`classic` 两档 |
| `web/src/ui/automix.ts` | 更名 `queueOrder.ts`，只做队列 |
| `web/src/ui/mixExplain.tsx` | **新增**：解释面板 |

**文档**

| 文件 | 改动 |
|---|---|
| [`docs/zilux2-beat-analysis-contract.md`](zilux2-beat-analysis-contract.md) | 升 v2：新增九域字段与算法 |
| `docs/zilux2-mix-plan-contract.md` | **新增**：MixPlan/RenderScript 契约 |
| `docs/zilux2-mix-engine-acceptance.md` | **新增**：验收指标与盲听协议 |

---

## 12. 与旧实现的取舍

| 资产 | 处置 | 理由 |
|---|---|---|
| [`transitionPlan.ts`](../web/src/core/transitionPlan.ts) | **保留思路，重写** | `Compat` 与模板概念可复用，但输出契约要换成 `MixPlan` |
| [`djMoves.ts`](../web/src/core/djMoves.ts) | 复用参数名 | `gain/eqLow/eqMid/eqHigh/hpf/lpf/delaySend` 已经是好的词汇表 |
| [`beatPll.ts`](../web/src/core/beatPll.ts) | 复用 | PLL 逻辑独立且正确 |
| [`stemGraph.ts`](../web/src/audio/stemGraph.ts) | 复用节点设计，不用于过渡 | duck/echo/damp 的接法可借鉴 |
| 4 轨实时分离 | **不做** | 5.29MB/轨、变调、预热一次就降级 —— 收益不对称 |
| `mixTransitionMode` 三档 | **删 `advancedSafe`** | 门控改到规划期，运行期不需要第二档 |
| 固定小节模板（full/fast/balanced） | **删** | 长度由乐句同余算出，模板只作为用户偏好上限 |
| [`transitionMath.ts`](../web/src/ui/transitionMath.ts) | 扩写 | 加 `linearGains`、`splitBands`、`rateRamp`、`barAnchored` |

---

## 附：一句话总结

完整系统 = **九个分析域 + 六种过渡形态 + 三路混音 + 六层 DSP + 两级质量门 + 本地偏好学习**；核心工程决策是"**离线预拉伸 + 在线微调**"和"**所有拼接预渲染**"，这两条决定了它能不能真的达到 sample-accurate，而不是"听起来差不多"。
