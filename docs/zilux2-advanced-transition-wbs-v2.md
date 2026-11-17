# 进阶智能过渡 · WBS v2（工单级细化）

> v1（`docs/zilux2-advanced-transition-wbs.md`）是「验收表 + 7 个粗任务」。
> v2 把每条粗任务拆到**可以直接开工、可以直接断言**的粒度：签名、常量、写作用域、自动化判据、夹具、回退路径。
> 配套关系：v1 保留为验收总表，v2 是执行依据。冲突时以 v2 的验收口径为准（见 §8）。

---

## 0. 结论

能细化，而且**必须细化**。v1 的 6 项需求里，有 3 项的描述掩盖了真实工作量：

| v1 的说法 | 真实工作量 | 原因 |
|---|---|---|
| 「前端 stemGraph 音频层」 | 不是加节点，是**新建一条 deck 播放链路** | `<audio>` 元素只能 `createMediaElementSource` 一次（`web/src/core/audioTap.ts:341`），现有 deck 图已占用；4 轨必须走独立的 4 源播放器 |
| 「4 轨路由」 | 现有 `stemGraph` **路由是错的** | `web/src/audio/stemGraph.ts:36` 只有一个 `input`，65–74 行把四路 gain 全并联到同一入口 → 四条支路同源同信号，`scheduleCurve('bass')` 与 `scheduleCurve('drums')` 实际调的是同一个声音的不同音量 |
| 「接入 crossfadeDeck，标准等功率保持冻结」 | 要处理相位/增益接管与回退不跳变 | 回退时若直接 `dispose()`，正在跑的 `naturalGains` 曲线会从「当前值」跳到「按 progress 重算的值」，产生可闻咔哒 |

另外发现 2 个必须前置解决的问题：

- **P4 命名冲突**：`web/src/ui/wallpaperSettings.ts:201` 已占用 localStorage 键 `transitionMode`，语义是**壁纸转场**（`random`/`fixed`）。DJ 过渡模式必须另起键名，否则互踩。
- **P5 缓存体积**：`StemsContract.WindowMs = 30000`、44.1 kHz、16 bit 立体声 → 单轨单窗口 5.29 MB，4 轨是 2 轨的 2 倍。一首 5 分钟曲子从 ~106 MB 涨到 ~212 MB。预取与淘汰策略必须一起改。

---

## 1. 现状审计（带行号）

### 1.1 已落地，可直接复用

| 能力 | 位置 | 状态 |
|---|---|---|
| 4 轨内存结果 | `src/Zilux2/Stems/HtdemucsSession.cs:28-31` `StemLeft/StemRight: float[][]`（0=drums,1=bass,2=other,3=vocals） | ✅ 有，未被写盘消费 |
| `StemCount = 4` | `src/Zilux2/Stems/HtdemucsSession.cs:13` | ✅ |
| 请求侧 `stems=2\|4` 字段 | `src/Zilux2/Stems/StemsModels.cs:52-60` `Stems` / `FourStem` | ✅ 有，未被 service 消费 |
| 计划纯函数 | `web/src/core/transitionPlan.ts`（381 行） | ✅ `planTransition` / `gainAt` / `actionWindows` / `planForMode` / `scoreCompat` / `camelotDistance` / `foldTempoRatio` / `chooseRate` |
| 手法库 | `web/src/core/djMoves.ts`（199 行） | ✅ 6 手法 + 3 模板 + `humanize` + `ECHO` |
| 事件展开 | `web/src/core/stemSwap.ts:90-118` `schedulePlan` | ✅ 产出 `CurveEvent/DelayEvent/DuckEvent` |
| 决策接线层 | `web/src/core/advancedTransition.ts` | ✅ `resolveTransition` / `describePlan` / `fallbackToStandard` |
| 图骨架 | `web/src/audio/stemGraph.ts` | ⚠️ 结构对，接口错（见 P1） |
| 锁相 | `web/src/core/beatPll.ts` | ✅ `nextRate` / `initialRate` / `subBeatOffsetMs` |
| 分析字段 | `web/src/online/analysis.ts:20-60` | ✅ `bpmConfidence` / `tempoStability` / `beatsMs` / `downbeats` / `phraseStartsMs` / `tempoCurveBpm` |
| 测试 | `web/tests/{transitionPlan,transitionWiring,transitionPerformer,crossfade}.test.cjs` | ✅ 4 个文件 |

### 1.2 结构性缺口（必须先修，否则后续全是空转）

**P1 · stemGraph 单入口 → 分轨路由失效**
- `web/src/audio/stemGraph.ts:36` `readonly input: GainNode`；`:65-74` 循环里 `this.input.connect(gain)`。
- 后果：四条支路共享同一信号源，`scheduleCurve` 只能改变「同一混合声里该节点权重的错觉」，听感上等于总音量变化。
- 修法：`inputOf(stem: Stem): GainNode`（每轨独立入口），或构造时接受 `sources: Partial<Record<Stem, AudioNode>>` 并直接 connect。

**P2 · MediaElementSource 唯一性 → 4 轨必须另起链路**
- `web/src/core/audioTap.ts:341` `ctx.createMediaElementSource(element)`，同一元素二次调用抛 `InvalidStateError`。
- 后果：进阶模式不能复用 `attachDeckToGraph`，需要独立的 `StemPlayer`（4 个 `AudioBufferSourceNode` 或 4 个独立 `<audio>`），并且**只能有一路被听到**（进阶模式期间原 deck 元素必须静音，否则双声）。
- 影响 T4 的估算：这不是分支，是并行链路 + 互斥开关。

**P3 · A/B 语义没有轮次**
- `web/src/core/stemSwap.ts:92-94` 硬编码 `targetDeck='B'`、`source='A'`。
- 后果：第二次过渡时出场/进场方向反转，事件全部排错侧。
- 修法：`schedulePlan(plan, { targetDeck })` 已支持，但调用方（`advancedTransition.resolveTransition`）没有传；`ResolveInput` 需增加 `targetDeck` 并在每轮过渡翻转。

**P4 · `transitionMode` 键名冲突**
- `web/src/ui/wallpaperSettings.ts:201` / `:733` 已用 `transitionMode`（壁纸转场 `random|fixed`）。
- 修法：DJ 侧键名用 `mixTransitionMode`，值 `standard|advanced`。

**P5 · 4 轨缓存体积翻倍**
- `StemsContract.WindowFrames = 30000*44100/1000`，16 bit 立体声 → 单轨窗口 5.29 MB。
- 需要：4 轨仅在 `stems=4` 请求时落盘、LRU 上限、以及「2 轨请求命中 4 轨缓存」的复用规则。

---

## 2. 细化规则（每张工单必须写满 6 栏）

```
ID / 依赖 / 写作用域（精确到文件）/ 契约（签名+类型）/ 数值参数 / 自动化判据 / 夹具 / 回退
```

判据必须能被脚本判定；写「听感自然」的一律退回。

---

## 3. T2 · 后端 4 轨 API（5 张工单）

### T2-1 分离结果落盘 4 轨
- **依赖**：无。**写作用域**：`src/Zilux2/Stems/StemSeparationService.cs`。
- **契约**：
  - 新增 `DrumsPath/BassPath/OtherPath(string dir, int window)`，命名 `w{window:D3}.drums.wav` / `.bass.wav` / `.other.wav`（与既有 `wNNN.vocals.wav`、`wNNN.inst.wav` 同构，`:617-620`）。
  - `EnsureWindowAsync` 内 `request.FourStem` 为真时：`StemsWav.Write16(path, separation.StemLeft[i], separation.StemRight[i], separation.Frames)`，i=0/1/2。
  - **原子写**：先写 `*.wav.tmp` 再 `File.Move(tmp, final, overwrite:true)`；任一路失败则删除本轮全部 tmp，返回 `StemsState.Error`。
- **数值参数**：44.1 kHz / 16 bit / 立体声 / 帧数 == `separation.Frames`；headroom 增益与 vocals 同一 `separation.Gain`（`:314-315` 注释已保证可加性）。
- **判据**：`drums+bass+other+vocals` 与原始 mix 逐样本残差 RMS < −60 dBFS（对应 v1 B2）。
- **夹具**：`djuced_re/A_full.wav`（3 秒，768 KB）+ 现有 `w000.vocals.wav` 对拍。
- **回退**：`FourStem=false` 时一行新代码都不执行，磁盘产物与现在逐字节相同。

### T2-2 `/api/stems` 状态体携带轨数
- **依赖**：T2-1。**写作用域**：`src/Zilux2/Stems/StemsModels.cs`、`src/Zilux2/Online/LocalMusicServer.cs`（`WriteStemsJson`）。
- **契约**：`StemsOutcome` 增加 `int Stems { get; init; } = 2;`；JSON 增加键 `"stems": 2|4`。旧客户端不读该键，忽略即可。
- **判据**：`stems=2` 时响应字节与改动前 diff 仅多一个键；`stems=4` 时 `state=ready` 后 4 个文件均存在且帧数一致。
- **回退**：字段有默认值 2，删除即恢复。

### T2-3 `/api/stems/audio` 白名单扩展
- **依赖**：T2-1。**写作用域**：`src/Zilux2/Online/LocalMusicServer.cs:1027-1030`、`StemSeparationService.ResolveAudio`（`:504-524`）。
- **契约**：
  - 白名单：`vocals | instrumental | drums | bass | other`。
  - 4 轨 stem 只在**该窗口已存在 4 轨文件**时返回 200；否则 `409 busy`（不是 404，避免前端误判为「重新分析」）。
  - `stem=instrumental` 在 4 轨模式下仍返回 `wNNN.inst.wav`（保留 2 轨兼容面）。
- **判据**：5 个 stem × {2 轨缓存, 4 轨缓存} = 10 组矩阵测试；错误码逐条断言。
- **回退**：白名单是常量数组，收窄即回滚。

### T2-4 缓存 schema 升级与复用
- **依赖**：T2-1/2-2。**写作用域**：`src/Zilux2/Stems/StemsModels.cs`（`StemsMeta`）、`StemSeparationService`（`TryReadCache`）。
- **契约**：meta 增加 `"stems": 2|4`。
  - 旧 meta（无该键）→ 视为 2；4 轨请求命中旧缓存时**重算**，不报错。
  - 4 轨缓存可服务 2 轨请求（vocals/inst 已在其中），反向不行。
- **判据**：手写 3 份 meta（缺键 / 2 / 4）各跑一次，断言 `state` 与重算次数。
- **回退**：读侧容错，删掉分支即恢复旧行为。

### T2-5 磁盘上限与淘汰
- **依赖**：T2-1。**写作用域**：`StemSeparationService`（新 LRU 模块）+ `SettingsModel`（上限项）。
- **契约**：`maxStemCacheMb`（默认 2048）；超限按「最久未访问整曲目录」整目录淘汰；正在计算的窗口加锁不淘汰。
- **判据**：注入 3 首 × 4 轨 × 全窗口，断言总量 ≤ 上限且未删活跃目录。
- **回退**：上限设 0 = 不淘汰。

---

## 4. T3 · 前端音频层（6 张工单）

### T3-1 修 `stemGraph` 单入口（P1）
- **写作用域**：`web/src/audio/stemGraph.ts`。
- **契约**：
  ```ts
  inputOf(stem: Stem): GainNode            // 每轨独立入口
  connectSource(stem: Stem, node: AudioNode): void
  stemOrder: readonly Stem[]               // ['drums','bass','other','vocals']
  ```
  构造不再创建单一 `input`；`inputOf` 返回的节点各自 `connect(stemGain[stem])`。
- **判据**：`offlineCtx` 下给 drums 送 1 kHz、bass 送 200 Hz，断言 `gainOf('drums')` 路径上只有 1 kHz（`AnalyserNode` FFT 峰值差 > 40 dB）。
- **回退**：保留旧 `input` 作为 `mixInput`，旧调用点零改动。

### T3-2 `StemPlayer`：4 源播放与时钟
- **依赖**：T3-1、T2-3。**写作用域**：新文件 `web/src/audio/stemPlayer.ts`。
- **契约**：
  ```ts
  class StemPlayer {
    constructor(ctx: AudioContext, graph: DeckStemBus, urls: Record<Stem, string>);
    async load(): Promise<void>;                 // 4 × decodeAudioData，并行，全成功才 resolve
    start(atCtxTime: number, offsetSec: number, rate: number): void;
    setRate(rate: number): void;                 // 4 源同步，误差 ≤ 1 采样
    stop(fadeOutSec = 0.01): void;
    get positionSec(): number;                   // 以 ctx.currentTime 推算，不读 currentTime 属性
  }
  ```
- **实现约束**：4 个 `AudioBufferSourceNode` 共用同一 `atCtxTime` 启动（同一 `ctx.currentTime` 取值），避免相位漂移；`playbackRate` 四路同一时刻设置。
- **判据**：合成 click 4 轨各放 120 s，互相关峰值漂移 < 5 ms（v1 C4）。
- **回退**：类不被实例化即无副作用。

### T3-3 曲线调度改用无跳变写法
- **写作用域**：`web/src/audio/stemGraph.ts:93-120`。
- **问题**：`:97` 与 `:113` 用 `cancelScheduledValues(atTime)`；若该参数正在执行 `setValueCurveAtTime`，取消会把值**立即拉回**，产生咔哒。且 Chrome 对「curve 执行中再 `setValueCurveAtTime` 重叠区间」抛 `NotSupportedError`。
- **契约**：
  - 统一 `cancelAndHoldAtTime(atTime)`（Chrome/Edge 支持）；不支持时降级为「读取 `param.value` → `setValueAtTime` → 再排程」。
  - 同一参数上新曲线起点 = 上一条曲线终点（由 `buildSwapCurve` 保证），重叠区间 ≤ 1 ms。
  - `scheduleDuck` 不再写死 `setValueAtTime(1, at)`，改为「从当前值 ramp 到目标」。
- **判据**：离线渲染 6 s，断言 `getChannelData` 在调度点前后 1 个采样窗口内无 |Δ| > 0.02 的阶跃。
- **回退**：`cancelAndHoldAtTime` 探测失败走旧路径，功能不变只损失平滑度。

### T3-4 delay 总线定参
- **写作用域**：`web/src/audio/stemGraph.ts:58-84`、`web/src/core/djMoves.ts:45-51`。
- **契约**：`delayTime = beatMs/1000 * ECHO.divisionBeats`（当前 `ECHO.divisionBeats = 1`，即 1 拍；v1 注释写「1/4 拍」，**注释与常量不一致，需定一个**）；`feedback = 0.35`；`dampHz = 3000`；`echoSend` 峰值 0.6（`scheduleEchoThrow` 的 `to:0.6`）。
- **判据**：v1 C5 —— 尾巴在下一小节线 ≤ −18 dBFS，且不掩 B 的 downbeat（B downbeat 处 1 kHz 能量不降 > 1 dB）。
- **回退**：`echoSend` 恒 0 即完全旁路。

### T3-5 事件应用的时间基准统一
- **写作用域**：`web/src/audio/stemGraph.ts:123-137`。
- **问题**：`apply()` 收 `startTimeSec`（绝对 ctx 时间），但 `ScheduledEvent.atMs` 是相对过渡起点；调用方必须换算。当前无断言保护。
- **契约**：`applyAll(events, startTimeSec)` 断言 `startTimeSec >= ctx.currentTime - 0.05`，否则整批丢弃并 `console.warn`（避免把事件排到过去导致立即全量生效）。
- **判据**：故意传过去时间，断言 0 个事件生效且日志 1 条。
- **回退**：断言可开关。

### T3-6 PLL 接入点
- **依赖**：T3-2。**写作用域**：`web/src/core/beatPll.ts`（已存在）、`stemPlayer.ts`。
- **契约**：过渡期间每 4 拍调用 `nextRate(state, expectedMs, performance.now(), beatMs)`，输出 `rate` 交给 `setRate`；`maxRateDelta` 默认 0.002（约 3.4 ¢），超出即 clamp。
- **判据**：A 120 BPM、B 121.5 BPM，30 s 后 beat 误差 < 5 ms。
- **回退**：`nextRate` 返回 `rate=1` 即等价不变速。

---

## 5. T4 · 接入 crossfadeDeck（5 张工单）

### T4-1 模式读取与默认值
- **写作用域**：`web/src/ui/crossfadeDeck.ts`（`readCrossfadeSettings` 246 附近）、`web/src/core/settings.ts`。
- **契约**：`CrossfadeSettings.mixTransitionMode: 'standard' | 'advanced'`，键名 `mixTransitionMode`（**不得用 `transitionMode`**，见 P4）；默认 `'standard'`；非法值回落 `'standard'`。
- **判据**：localStorage 写入 5 种值（含 `null`、`""`、`"ADVANCED"`），断言解析结果。
- **回退**：删除键即默认标准。

### T4-2 决策插入点
- **写作用域**：`web/src/ui/crossfadeDeck.ts:2145`（`plan.styleResolved = ...` 之后）、`ActivePlan`（`:861-900`）。
- **契约**：
  ```ts
  interface ActivePlan {
    // ...既有
    advanced?: {
      plan: TransitionPlan;
      events: ScheduledEvent[];
      graph: StemGraph;
      playerA: StemPlayer;
      playerB: StemPlayer;
      startedAtCtx: number;
      targetDeck: 'A' | 'B';
    };
  }
  ```
  分支条件：`mode === 'advanced' && resolveTransition(...).plan !== null`。
- **判据**：`mode='standard'` 时 `plan.advanced === undefined` 且**未 new 任何 StemGraph/StemPlayer**（断言构造计数器为 0）。
- **回退**：`advanced` 可选字段，不填即旧路径。

### T4-3 互斥：进阶期间原 deck 元素必须静音
- **依赖**：T4-2。**写作用域**：`crossfadeDeck.ts`（`setDeckVolume` / `setDeckGraphGain` 调用点）。
- **问题**：P2 —— 4 轨播放器与原 `<audio>` 同时出声会双声。
- **契约**：进入进阶分支后 `setDeckGraphGain(active, 0)` 且 `element.volume = 0`；退出（正常结束/取消/异常）时按当前 progress 恢复 `naturalGains(progress)` 值，**带 20 ms ramp**。
- **判据**：离线/环回录制全程，频谱中不存在「同一旋律两条时间轴错位」的重影（互相关次峰 < 主峰 −20 dB）。
- **回退**：取消 `advanced` 即恢复。

### T4-4 回退不跳变
- **依赖**：T4-3。**写作用域**：`crossfadeDeck.ts` catch 分支 + `advancedTransition.fallbackToStandard`。
- **契约**：catch 里必须先读当前 `progress`，按 `naturalGains(progress)` 算出目标增益，`linearRampToValueAtTime(target, now + 0.02)`，再 `dispose()` 图与播放器；顺序反了就会咔哒。
- **判据**：注入异常（`urls` 缺一路 / `decodeAudioData` reject），断言 20 ms 内增益连续、无 |Δ| > 0.05 阶跃，且 `logEvent('advanced-fallback', ...)` 恰好 1 条。
- **回退**：`fallbackToStandard` 已存在，补 ramp 即可。

### T4-5 生命周期清理
- **写作用域**：`crossfadeDeck.ts`（`cancelCrossfade:2712`、`crossfadeTick:2426` 结束分支）。
- **契约**：`cancelCrossfade` / 过渡完成 / `seek` / `pause` 四个入口都必须：`playerA.stop(); playerB.stop(); graph.dispose();` 并从 `plan.advanced` 删除引用（防重复 dispose）。
- **判据**：连续 5 次「开始→中途取消」，断言 `ctx` 节点数回到基线（用 `OfflineAudioContext` 无法计数，改用构造/析构计数器）。
- **回退**：无。

---

## 6. T6 · BPM 置信度门控与候选拍族（5 张工单）

### T6-1 候选拍族打分
- **写作用域**：新文件 `web/src/core/tempoGate.ts`。
- **契约**：
  ```ts
  type TempoCandidate = { ratio: number; score: number; reason: string };
  function rankTempoCandidates(a: BeatAnalysis, b: BeatAnalysis): TempoCandidate[];
  ```
  - 候选集（B 相对 A 的速率）：`{1, 1/2, 2, 2/3, 3/2, 3/4, 4/3}`，再乘 `bpmB/bpmA` 的原始比。
  - 打分：`score = 0.55*exp(-2.5*|log2(r)|) + 0.30*downbeatAlign + 0.15*phraseMatch`，三项均归一到 0..1。
  - `downbeatAlign`：把 B 的 `downbeats[0]` 按 r 映射到 A 时间轴后，与 A 最近 downbeat 的距离 d（ms）→ `exp(-(d/12)²)`。
  - `phraseMatch`：`|phraseLenA - phraseLenB/r| / phraseLenA` → `1 - clamp(x,0,1)`。
- **判据**：合成用例集（88/124/174 BPM ± 半速混淆 + 变速歌 3 首），top-1 命中率 ≥ 90%，top-2 ≥ 98%。
- **回退**：`rankTempoCandidates` 首项恒为 `foldTempoRatio` 的结果，调用方可只用首项。

### T6-2 门控阈值与三档降级
- **依赖**：T6-1。**写作用域**：`tempoGate.ts`、`web/src/core/transitionPlan.ts:277-287`。
- **契约**：
  ```ts
  type ConfidenceTier = 'full' | 'bassDrumsOnly' | 'standard';
  function confidenceTier(a: BeatAnalysis, b: BeatAnalysis): { tier: ConfidenceTier; why: string };
  ```
  - `min(confA, confB) >= 0.65 && min(stabA, stabB) >= 0.6` → `full`
  - `0.45 <= min(conf) < 0.65` → `bassDrumsOnly`（禁 vocals/other 换手）
  - `< 0.45` 或 `stability < 0.4` → `standard`（返回 `null` 计划）
- **判据**：9 组 (conf, stab) 边界值断言；`standard` 档断言 `planForMode` 返回 `null`。
- **回退**：阈值提为参数，配置可覆盖。

### T6-3 与 `chooseRate` 合流
- **依赖**：T6-1。**写作用域**：`transitionPlan.ts:122-133`、`planTransition:267`。
- **契约**：`chooseRate(bpmA, bpmB, candidates?)` 从 top-k（k=3）里选：满足 `0.92 <= ratio <= 1.08` 且 `|ratio-1|` 最小者；全不满足则取 `|log2 r|` 最小者并置 `fallback='bassDrumsOnly'`。
- **判据**：半速误判用例（实际 87 BPM 被判 174）不再产生 2× 变速。
- **回退**：不传 `candidates` 时行为与现在一致。

### T6-4 换手点吸附到真实拍点
- **依赖**：无。**写作用域**：`transitionPlan.ts:134-165`（`nextDownbeat`/`nextPhraseAnchor`/`alignEntry`）。
- **契约**：优先用 `beatsMs`/`downbeats` 实测数组；缺失时才用 `firstDownbeatMs + n*barMs`。吸附容差 ±6 ms 内取实测点。
- **判据**：v1 C1 —— 自动化时间戳与 `downbeats` 偏差 < 5 ms（dump 断言）。
- **回退**：数组缺失自动回退恒定间隔。

### T6-5 低置信度时的成本控制
- **依赖**：T6-2。**写作用域**：`crossfadeDeck.ts`（T4-2 分支条件）。
- **问题**：现在 `minConfidence` 只降级 template，仍会构建 4 轨图（4 次解码 + 4 个节点组），代价没降。
- **契约**：`tier==='standard'` 时**不请求 4 轨**（`stems` 参数保持 2），不构建图。
- **判据**：断言该路径下 `/api/stems` 请求不带 `stems=4`。
- **回退**：配置可强制 4 轨。

---

## 7. T5 · UI（4 张工单）

### T5-1 设置项
- **写作用域**：`web/src/core/settings.ts`、UI 设置面板。
- **契约**：`mixTransitionMode` 三选项：标准 / 进阶 / 进阶（仅低置信度降级）。文案需说明「进阶模式首次切歌需要等待分轨计算」。
- **判据**：切换后 `readCrossfadeSettings().mixTransitionMode` 即时生效，不重启播放。
- **回退**：默认标准。

### T5-2 时间线数据源
- **依赖**：T4-2。**写作用域**：新文件 `web/src/ui/transitionTimeline.ts`。
- **契约**：输入 `ScheduledEvent[]` + `barMs` + `totalMs`；输出三条泳道（drums/bass/other/vocals）上的动作块，块位置 = `atMs`，宽度 = `durationMs`；`duck` 画在目标 deck 顶部的窄条。
- **判据**：快照测试（JSON 结构），6 种模板各一份。
- **回退**：组件不被挂载即无影响。

### T5-3 拖动换手点 → 重算
- **依赖**：T5-2。**写作用域**：`transitionTimeline.ts`、`transitionPlan.ts`（新增参数）。
- **契约**：`PlanInput.handoffOverrideMs?: number`；命中时 `startMsA/startMsB` 直接用该值，且强制吸附到最近小节线（v1 约束 3「不抖结构」）。
- **判据**：拖动 3 个位置后重放，断言 `events` 的 `atMs` 整体平移量与拖动量一致（±1 拍内）。
- **回退**：不传参即原逻辑。

### T5-4 `reason` 与动作一致性
- **依赖**：无。**写作用域**：`advancedTransition.describePlan`。
- **契约**：`actions.length === describePlan(plan).filter(l => l.includes('换手')).length`；每条 action 恰好一行。
- **判据**：6 模板 × 3 档置信度 = 18 组断言。
- **回退**：无。

---

## 8. 验收口径修订（v1 表中有 4 条不可判定，必须改写）

| v1 | 问题 | v2 口径 |
|---|---|---|
| C2「30–120 Hz 能量波动 <2 dB」 | 没说窗长、统计口径、是否含首尾 | 30–120 Hz 带通（4 阶 Butterworth）→ 100 ms 窗、50 ms hop → 帧 RMS dB → **排除过渡首尾各 200 ms** → `max−min < 2 dB` |
| C3「同时 >−30 dBFS 时长 <1 拍」 | 与上一条同源，且未定义短时 RMS | 两轨 vocals 各自 50 ms 窗 RMS；「同时超阈」判为重叠帧；**连续重叠段累计** < 1 拍 |
| C4「漂移 <5 ms」 | 未说对齐方法 | 与参考 click 做互相关，取主峰偏移；跑 120 s，每 10 s 取一次 |
| E2「选优 ≥50%」 | 50% 无法证明「不劣」，20 次样本量也不足 | 改**非劣性检验**：24 组随机 A/B（位置随机、音量对齐 ±0.5 dB），统计「胜 + 平」比例，要求点估计 ≥50% 且 95% CI 下界 ≥40%；同时记录「明确选错」次数作为次要指标 |
| C1「换手点 <5 ms」 | 没说对谁 | 对 `downbeats` 实测数组，逐动作 dump `atMs`，取最大绝对差 |

补充一条 v1 缺失的判据：

| 新增 | 判据 |
|---|---|
| G1 无双声 | 进阶模式全程，原 deck 元素贡献 ≤ −60 dBFS（静音断言） |
| G2 回退无咔哒 | 人为注入异常，回退点 20 ms 内 |Δ增益| < 0.05 |
| G3 节点不泄漏 | 5 轮开始/取消后，构造与 dispose 计数相等 |

---

## 9. 依赖图与并行轨道

```
轨道 A（后端）  T2-1 → T2-2 → T2-3 → T2-4 ─┐
                T2-5 ──────────────────────┤
轨道 B（音频）  T3-1 → T3-2 → T3-3 ─────────┼→ T4-2 → T4-3 → T4-4 → T4-5 → T5-2 → T5-3
                T3-4 / T3-5 / T3-6 可并行  │
轨道 C（决策）  T6-1 → T6-2 → T6-3 ────────┘   T6-4 / T6-5 可并行
轨道 D（验收）  §8 口径定稿 → 夹具脚本 → 指标脚本 → 盲听流程（可与 A/B/C 并行，先写脚本）
```

- 轨道 A 与 B 可完全并行（B 用假数据：4 个本地 wav 直接喂 `StemPlayer`）。
- T4 是唯一的合流点，必须等 A/B 的接口定型。
- T5-1 可以最先做（纯设置项，无依赖），用来提前打通 UI 联调。

## 10. 里程碑建议

| 里程碑 | 内容 | 出口判据 |
|---|---|---|
| M1（1–2 天） | P1–P5 修复 + T2-1/2-2 | 4 轨文件落盘正确；残差 < −60 dBFS |
| M2（2–3 天） | T3-1…T3-6 + 假数据播放 | 4 轨可分别调增益，无跳变，漂移 < 5 ms |
| M3（2 天） | T4-1…T4-5 | 标准模式回归全绿；进阶可开关；回退无咔哒 |
| M4（1–2 天） | T6-1…T6-5 | 候选拍族 top-1 ≥ 90%；边界值全过 |
| M5（1–2 天） | T5-1…T5-4 | 时间线可拖、reason 一致 |
| M6（2 天） | §8 全部指标 + 报告 | 报告含原始 csv 与复现命令 |

## 11. 风险登记册

| 风险 | 触发条件 | 缓解 |
|---|---|---|
| R1 `createMediaElementSource` 冲突 | 进阶模式复用现有 deck 元素 | 独立 `StemPlayer`；元素强制静音（G1 断言） |
| R2 `setValueCurveAtTime` 重叠抛错 | 同一参数两条曲线时间重叠 | 曲线首尾相接 + `cancelAndHoldAtTime`；T3-3 离线断言 |
| R3 4 轨解码内存峰值 | 5 分钟曲 × 4 轨 × 双声道 float32 = 4×50 MB ≈ 200 MB | 分窗解码（30 s 窗口，与后端 `WindowMs` 对齐），流式喂 buffer |
| R4 分轨计算耗时阻塞 | 首次切歌需等 ~7 s/窗口 × N | 预取：进入播放列表时后台算前 2 个窗口；`busy` 时自动降级标准 |
| R5 残差超标（> −60 dBFS） | headroom 或 OLA 边界问题 | 复用 `separation.Gain` 统一增益；窗口边界 25% 重叠区单独验证 |
| R6 盲听样本量不足 | 20 组无法给出显著性 | 改 24 组 + 非劣性口径（§8） |

## 12. 与原 WBS 的差异摘要

1. 新增 P1–P5 五个前置缺口，其中 P1（单入口）会让「分轨换手」名存实亡。
2. T3 从 3 个文件变成 6 张工单，新增 `StemPlayer` 与「无跳变调度」。
3. T4 从「加分支」变成 5 张工单，含互斥静音、回退不跳变、生命周期。
4. T6 从 2 条变成 5 张工单，给出候选集、打分权重、三档阈值。
5. T7 的 5 条判据改写为可测量口径，并新增 G1–G3。
6. 明确 `transitionMode` 键名冲突，DJ 侧改用 `mixTransitionMode`。
