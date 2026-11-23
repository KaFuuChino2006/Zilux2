# 风格识别、跨风格策略与自延长（v1）

本文记录「按风格做过渡」这一层实际落地了什么、边界在哪、怎么验证。目标不是替代
`zilux2-automix-v2.md` 的过渡数学，而是在它上面加三件事：

1. **风格画像**：给每首歌一个可解释的标签、mood、置信度与证据。
2. **跨风格策略**：两首歌风格差得远时，收紧/放宽换手、duck 与 EQ 补偿，但不做整轨变调。
3. **自延长**：A 的尾奏、B 的前奏不够长时，用可重复单元平铺补足；有生成模型时优先用模型产物。

## 1. 数据流

```
宿主基础分析（同步，约 1 s）
  └─ /api/analysis            → BeatAnalysisPayload（拍/小节/段落/调性/activity/keyTimeline…）
宿主增强队列（异步，单 worker）
  ├─ structure（SSM）         → sections / boundaries（已有）
  ├─ stems（htdemucs）        → activity.vocal/drum/bass/other，250 ms 桶（已有）
  ├─ style（DSP，零依赖）     → style.json（新增）
  └─ extend（生成模型，可选） → extend/<start>-<len>.wav + JSON（新增，权重缺失时 unavailable）
前端
  /api/analysis/features       → 轮询合并进同一个 BeatAnalysis 对象
  resolveStyleProfile()        → styleProfile（标签/mood/置信度/证据）
  resolveStylePolicy(a, b)     → 过渡参数偏置（windowScale / swapShareBias / duckScale / eq / lowTrim）
  planExtension()              → 循环平铺或模型产物，交给 extensionPlayer
```

基础分析路径**没有**被改动：`AnalyzerVersion` 仍是 `p1-3-keyviterbi`，旧的 73 首缓存继续有效。
风格与延长各有独立 stage 版本（`style/dsp-v1`、`extend/model-v1`），单独失效。

## 2. 风格画像

`StyleProfilePayload`（C#，namespace `Zilux2.Analysis`）：

```
V, Primary, Secondary, Mood, Language, Vocal, Confidence,
CentroidHz[], Flatness[], HighRatio[], Percussivity[], Tonalness[],
DynamicRangeLu, SilenceRatio, LowRatio, MidRatio, HighRatioAvg,
Bpm, Key, Mode, Evidence[], Reasons[]
```

- 500 ms 网格、30 s 窗口、50% 重叠；五条曲线按整曲等间隔重采样（不是按帧数硬拼）。
- 标签集合固定 10 类：`pop / rock / metal / punk / hiphop / electronic / ballad / acoustic / ambient / instrumental`。
- 每个标签按「软隶属度相乘」打分，阈值与软边宽度写在 `STYLE_THRESHOLDS`，改一处即可复现实验。
- 语言判定顺序：曲目元数据 → 歌词文本 → 假名/汉字/拉丁字符比例 → `other`。
- `confidence = .45×coverage + .35×separation + .2×top`；`< .05` 时回退 `pop / .12`，不硬猜。
- 纯器乐优先走 `instrumental`（人声三态判定的 `instrumental` 分支），不会被流行/摇滚抢走。

前端 `resolveStyleProfile` 是纯函数，不碰浏览器 API；没有 `style.json` 时用基础分析里的
BPM/调性/能量/activity 现算，结果缓存在 `analysis.styleProfile` 上。

## 3. 跨风格策略

`resolveStylePolicy(a, b, ctx)` 输出：

```
windowScale  .8–1.4     换手窗口缩放（bpm 差 > .12 时上限 1.15）
swapShareBias ±.15      紧凑换手占比偏移
duckScale    .4–1.2     人声让位深度倍数
presenceFromDb / sendDb 补偿量
eq: [{ lowHz, highHz, gainDb }]  最多 3 段
lowTrimDb    −2.5–0     只压不抬的预偏置
maxExtensionBars / maxExtensionMs
techniqueBias / notes
```

七条硬规则按「先否后肯」选择原型，规则 4 叠加；**同调时 EQ 全 0**，只保留 `lowTrim`：
同调不需要再修音色，任何 EQ 都只会让 A 的尾奏变味。低置信（`< .45`）直接短路到默认策略。

实现约定：

- 策略只输出**偏置**，最终参数仍由 `v2Plan.ts` 与 `scheduleAutomixV2Style` 夹取。
- 补偿节点（`aStyleHigh 6500 / aStylePresence / bStyleHigh / bStylePresence / bStyleLow 120`）
  默认 0 dB；排程在过渡 30% 到目标，**最后 15% 回 0**——过渡结束不能给下一首留音染。
- 过渡期间 A 侧仍遵守「原曲不变」原则：补偿只作用在 B 侧声部与 A 的高频收尾上，
  不做整轨变调、不改 A 的低频换手。
- `lowTrimDb` 用 `energyGap × 3` 的启发式预偏置；真正的低频电平仍由 v2 链在换手前
  用 `lowAnalyser` 实测并 `setLowTrimDb` 校准（两层不冲突：前者是规划期预判，后者是运行期实测）。

## 4. 自延长

`planExtension()` 输出 `ExtensionPlan`：

```
source: 'loop' | 'model' | 'none'
aUnit / bUnit: { startMs, endMs, bars, score, kind }
aPasses / bPasses, seamMs = 2, totalMs, reason
```

- A 侧：取尾段 `loopUnits`（8/4 小节，`kind` 为 `repeat` 优先），最多 2 遍，上限 32 s / 8 小节。
- B 侧：前奏的重复段优先，否则前奏开头 4/2 小节；只做规划与测试，**暂未接播放**
  （避免与 `introBridge` 双播；接线需要 gate + 延迟元素方案，见「未做」）。
- 质量门三判据：接缝能量差、段内响度差、与整曲响度差；不合格回落到 `loop` 或 `none`。
- 模型产物（`source: 'model'`）优先于循环，但要求 `preferModel && modelReady`；权重缺失时
  永远走 loop，不会因为「没模型」而拒绝过渡。

`extensionPlayer.startExtensionPlayback` 把 buffer 接到 `tap.input`，绕过元素 gate、经过 v2 链，
因此补偿与低频换手对它同样生效；`stop/dispose` 幂等，素材 LRU 4 首。

## 5. 接口

```
GET /api/analysis/features?source=&rel=&id=&stages=stems,structure,style,extend
→ { ok, trackKey, features: { v, version, stems, structure, style, extension, … },
    pending: [...], status: { stems: ready|running|pending|failed|unavailable, … } }

GET /api/models
→ { ok, models: [{ id, display, license, bytes, sha256, url, status: { present, state, progress, error } }] }
```

`/api/analysis?enrich=1` 会在基础结果里内联已就绪的 `features`；`extendStartMs/extendMs/prompt`
用于请求某一段生成式延长（缺模型返回 `unavailable`，不报错）。

## 6. 边界与未做

- **不做整轨变调**。跨调只做「同调优先 + EQ 让位 + 低音仲裁」，移调仍只在 B 前奏桥的
  短片段里出现（`introBridge` 既有逻辑）。
- **B 前奏延长只规划不播放**：`planExtension` 会算出 `bPasses`，但 `extensionPlayer` 目前只起
  A 尾；接 B 需要与 `introBridge` 的 gate 统一，否则会双播。
- **生成段默认关闭，开关在过渡设置里**：`高级过渡 → 全局 → 生成过渡`（键
  `mixGenerativeTransition`，`off|on`）。打开且模型就绪、这首歌已生成好过渡段时，
  混音器把生成段当作「整段过渡垫底」：从 `fadeStart` 起播、压到 A 尾以下 8 dB、
  两端 0.6 s / ≤1.2 s 淡入淡出、随换手收尾；没生成好或没模型时静默回落 `loopUnits`。
  生成段只有文本条件、没有音色/旋律续接，所以它负责填空档与频谱断层，不接旋律；
  默认关闭也是这个原因。开发者仍可用 `localStorage['zilux2.dev.extendmodel']='1'`
  强制打开（与产品开关任一为真即生效）。
- 排队入口是 `primeModelExtension(track)`（AutoMix 队列分析完即排，窗口默认 8 s，
  `stages=extend&extendStartMs&extendMs`），生成完把 `analysis.extension` 合并回缓存对象；
  宿主按「起始-长度」分窗口缓存，先要 4 s 再要 8 s 不会命中旧结果。
- **响度门在补偿前判定**：尾奏比整曲轻 > 1 LU 时拒绝延长，宁可短一点也不靠增益硬顶。
- **风格标签是启发式**：10 类之外（city pop、shoegaze、trance…）会落到最接近的原型；
  `evidence` 与 `reasons` 会写清是哪几个特征把它推到这一类，方便人工复核。

### 6.1 生成段播放与 HUD

- 宿主 `GET /api/analysis/feature-audio?file=features/<hash>/extend/<start>-<len>.wav` 把生成段
  以 `audio/wav` 吐给前端；路径必须落在 analysis 根内且以 `.wav` 结尾，越界返回 403。
- `extensionPlayer.loadExtensionAudio()` 解码后交给 `crossfadeDeck`：`mode='bed'` 时从
  `fadeStart` 起播整段垫底，`mode='tail'` 时沿用旧的 A 尾补段；两条都接 `tap.input`、
  绕过元素 gate、播完自动释放。
- 默认走 loop；产品开关 `mixGenerativeTransition=on` 或开发者开关
  `localStorage['zilux2.dev.extendmodel']='1'` 任一打开即启用生成段。
- 混音浮层的 A/B 两侧各多一行「风格 primary · mood · confidence」，数据来自
  `analysis.styleProfile`（分析增强合并时写入，`crossfadeLiveSnapshot().a/b.styleProfile`）。
- `/api/models` 返回模型清单与本地状态；`Descriptor.Bytes` 已按 FileSpec 合计修正为
  4,984,899,938，实际落盘 4,984,904,651（tokenizer 略大），进度按 1 封顶。

## 7. 验证

- `node --test web/tests/` → 642 项全过（含 `styleProfile` 36 项、`stylePolicy` 17 组快照、
  `extensionPlan` 13 项、生成过渡开关 3 项与床垫排程 1 项）。
- `cd web && node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` → 0。
- 宿主 `E:\dotnet\dotnet.exe build src/Zilux2/Zilux2.csproj -c Debug` → 0 警告 0 错误。
- 端到端：`/api/analysis/features?stages=style` 对本地曲目返回 `style.state=ready` 与五条曲线；
  `styleProfile` 在分析面板显示「风格 xxx · mood xx%」芯片。
- 过渡体检：`node web/tools/mix-audit.cjs --pairs=6` → 702 首 / 4202 对 / 44.7 s，
  过渡时长 min 3039 ms、p50 12000 ms、max 30000 ms，`TOO_SHORT / B_SEEK / LAST_BAR` 无命中；
  体检台的 vm 白名单已补 `styleProfile / stylePolicy / extensionPlan`，否则会在
  `resolveStyleProfile` 处整批报 `not a function`。
- 风格策略只改窗口与偏置，不改变「A 在换手前原样」这一条硬规则。

## 8. 相关文件

- 契约与所有权：`.scratch/style-extend-contract.md`
- 宿主：`src/Zilux2/Analysis/Enrichment/{StyleStage,StyleModels,ExtensionStage,ExtensionModels,ModelLibrary,EnrichmentPayloads,AnalysisEnrichmentService}.cs`
- 前端：`web/src/core/automix/{styleProfile,stylePolicy,extensionPlan}.ts`、`web/src/audio/extensionPlayer.ts`、
  `web/src/audio/automixV2Graph.ts`（`scheduleAutomixV2Style`）、`web/src/ui/crossfadeDeck.ts`
- 生成模型：`tools/model-download/`、`tools/model-export/`、`docs/zilux2-generative-extension.md`
