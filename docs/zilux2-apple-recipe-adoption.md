# Apple AutoMix 配方 → Zilux2 进阶过渡：照搬与改进对照

> 依据：`REPORT.md`（macOS 27.2.1 Music.app 静态符号 + AMP 缓存 + `com.apple.Sonic` 运行日志）、
> `TransitionStyles.json`（24 种风格完整配方，293 KB）、`automix-runtime.log`（14 次真实过渡）。
> 代码落地：`web/src/core/automix/appleRecipes.ts`（烘焙配方 + `applePlanFor()`）、`web/src/ui/crossfadeDeck.ts`（接线）。

---

## 1. 苹果的七层与我们的对应层

| Apple 层 | 具体实现（实证） | Zilux2 对应 | 差异处理 |
|---|---|---|---|
| 应用层 | `MusicPlayerController.AutoMix` / `PBSettings.transitionsEnabled` | 设置 →「过渡」→「混音过渡」 | 已等价 |
| 播放编排 | MediaPlaybackCore 双 `AVPlayerItem` 重叠 | 两条 `<audio>` + WebAudio 图 | 已等价（我们用 buffer 补充） |
| 规划层 | `TransitionPlanner`：8 候选策略 + 8 风格策略 + `DJB2` 种子随机 | `styleKit.rankStyles()` + 硬门控 | **部分照搬**（见 §3） |
| 时间对齐 | `TimeAlignmentCalculator` + `speedRamp [CMTimeMapping]`（39/77 段） | `tempoRate` + PLL + 拍点吸附换手 | **改进点**（见 §4） |
| 数据层 | AMP `audio-analysis` + `flexml-analysis`（服务端） | 本机 DSP（`BeatAnalyzer` p1-1） | 我们全本地，字段对齐见 §2 |
| 风格素材 | `TransitionStyles.json` 24 风格 / 48 参数 | `styleKit` 16 手法 + **新增 Apple 配方表** | **照搬核心 11 条** |
| 渲染层 | DSP 图 `AURemixFX + AUFilter + HP/LP + Delay + Reverb2` | 自建 `automixV2Graph`（LR4 分频 / duck / sweep / echo / reverb） | 原语等价，AURemixFX 专有项用自研原语替代 |

---

## 2. 服务端字段 → 本机字段

| Apple 字段 | 含义 | 我们已有的 | 缺口与做法 |
|---|---|---|---|
| `beats.beatsInMilliseconds` / `barsInMilliseconds` | 拍/小节网格 | `beatsMs` / `downbeats` | ✅ |
| `bpm.{beginning,ending,main}` | 分段 BPM | `bpm` / `tempoCurveBpm` | ✅ |
| `key.{beginning,ending,main}` | 调性 | `key`/`camelot`/`keyTimeline` | ✅ |
| `loudness.{peak,range,value}` + `loudnessCurve`（399 点） | 响度曲线 | `loudnessLufs` + `momentaryLufs` | ✅ |
| `fades.{fadeIn,fadeOut}` | Dead-Air Removal | `audibleEndMs` / `tailSilenceMs` / `detectTailFade` | ✅（我们做的是母带渐隐**补回**，更激进） |
| `vocalActivity` 29 段 + strength | 人声区间 | `activity.vocal`（250 ms 曲线）+ `vocalPresence` | ✅（我们更细：曲线而非 4 档） |
| `acousticness/danceability/energy/melodicness/valence` | 主观属性 | `energy` + `activity` 派生 | ⚠️ 缺 `danceability`/`melodicness`/`valence`；用 `inferGenre()` 近似 |
| `flexml-analysis.entryPoints/exitPoints` | 候选进出点 | `phraseStartsMs` / `sections` / `loopUnits` | ⚠️ 我们用结构+乐句+循环单元替代 ML 候选 |
| `spatialOffsets` | 空间音频对齐 | 不适用 | 不做 |

---

## 3. 已照搬：11 条风格配方（`appleRecipes.ts`）

从 24 条里挑出「我们引擎有对应原语」的 11 条，连参数带时间窗一起烘进代码（`APPLE_RECIPES`）：

| id | 名称 | 小节 | 关键自动化（实证原值） |
|---:|---|---:|---|
| 0 | Gapless | — | 只有 `out_gain` |
| 1/2 | constant-power / long out short in | — | `out_gain` 线性 |
| 5 | BM - Short filter high to low | 2 | A `lp 20000→200`（0→1，ease-out-2）；B `hp 20000→10`、`lp 1200→20000`（ease-in-4） |
| 8 | BM - Filter high to low | 8 | 同 5，但窗口 8 小节 |
| 9 | BM - Filter expansion | 8 | A `lp 20000→20`（0.5→1）、`hp 20→200`（0.5→0.75）；B `lp 1000→20000`（0→0.75） |
| 13 | BM - Filter soft + Reverb | 10 | A `lp 20000→760`（0.4→0.8）、`send 0→1`（0→0.8）、`wet 0→1`；B `lp 500→20000`（0.6→0.8） |
| 15 | Hiphop - Delay out | 4 | A `dry_wet 0→100`、`feedback 35`、`delay_lp 3000`、`delay_time @dynamic_beat_length`、`out_gain 1→0` |
| 16 | Pop - Delay out | 4 | A `lp 20000→3500`（0.125→0.25）、`dry_wet 0→100`、`feedback 60`、`delay_lp 3500`、`out_gain` **0.375→0.5**、`player_gain 1→0`@0.25；B `hp 5200→20`（0.1875→0.4375） |
| 20 | Pop - Reverb | 4 | A `filter_a 20000→20`、`reverb_send 0→1`（0.3125→0.525）、`out_gain 1→0.4217→0`；B `filter_b 20→20000`、`out_gain 0.25→0.75` |
| 22 | splice | — | 无参数（纯拼接） |

### 照搬进我们引擎的三件事

1. **换手宽度 = `out_gain` 下降窗**
   `applePlanFor()` 把 `out_gain` 的 `t0/t1` 读成 `swapStartP / aGoneP`，换手比例取 `aGoneP − swapStartP`（风格 16 = **0.125**，即只占窗口 12.5%），并与我们自己的 `styleSwap` 取小值。
   → 效果：A 在窗口前 37.5% 完全原样，中间 12.5% 让完，后 50% 只剩 B。这正是「接近尾端才换」的官方比例。

2. **扫频窗 = `lp_cutoff_freq` 的时间窗**
   直接把 `apple.aLp.t0/t1` 传给 `buildV2Plan({sweepStartP, sweepEndP})`。
   → 风格 16 的 A 低通只在 **12.5%–25%** 动（我们之前是 55%–100%），B 高通在 **18.75%–43.75%** 开完。

3. **延迟/混响参数用官方数值**
   - echo：`feedback 0.60`、`dampHz 3500`、`delayMs = 1 拍`（Apple `@beat_length`）；我们原来是 0.28–0.44 / 3.6–4.6 kHz / 0.5–1 拍。
   - reverb：`tailMs = decay × 1000`（Apple `decay 4 s` → 我们夹到 3 s 上限）、`fromP = reverb_send.t0`（风格 20 = 31.25%）。
   → 尾巴更长、更亮，与「Delay out / Reverb out」的听感一致。

---

## 4. 已改进（不照搬的地方）

| 议题 | Apple 做法 | 我们的做法 | 理由 |
|---|---|---|---|
| 变速曲线 | `speedRamp` 39/77 段 `CMTimeMapping`，逐段线性逼近 | 单速率 + PLL 微调 + 小节量化回正 | 39 段映射需要逐帧重采样；WebAudio `playbackRate` 只有单一值，靠 PLL ±1.5%/拍已能把相位锁在 ±5 ms |
| 变速方向 | `ts_rate 1→2`（以 A 为基准把 B 拉到 2 倍相对速率） | **A 贴 B**（默认 `tempoAnchor='next'`），A 速率 = 1/rate | 用户听感要求「上一首向下一首靠」，且我们把 rate 定义成「每秒墙钟对应多少 B 文件毫秒」 |
| 时长 | 风格固定 2/4/8/10/16 小节，无用户参数 | 同样按小节，但叠了**曲风预算**（hiphop 2 / house 4 / techno 8 / dnb 8 / pop 4 / ambient 8）与用户三档 | 我们的曲库比 Apple Music 主流流行更杂（含 dnb/techno） |
| 候选生成 | 8 种策略 + FlexML ML 进出点 | 乐句同余求解 + 旋律相似度（chroma 余弦）+ drop/副歌落点 | 我们没有服务端 ML，但 chroma 与结构在本机都有 |
| 风格随机 | `DJB2(曲目标识) + 种子随机` → 同对歌稳定、不同对歌变化 | 硬门控 + 打分（可解释 `reasons`）+ 兜底 bassSwap | 用户要「可解释、可单测」；随机在我们这里会被当成 bug |
| 人声处理 | `vocalActivity` 29 段 + `No vocal clash` 风格 | 曲线级 duck（A 让 2.5 kHz、B 让 −6 dB）+ 唱句锚点 | 我们比 4 档强度细；且我们做「B 首句落在接缝」的精确对齐 |
| A 静音方式 | `player_gain 1→0`（入图前直接掐） | LR4 分频 + 高频支路 fade + 可选 tail bleed | 直接掐会让 A 的尾巴断得生硬；我们让低频先走、高频后走 |
| AURemixFX | `repeater / gater / flanger / phaser / tape stop / filter A/B` 39 个参数 | `loopRoll` / `doubling` / `backspin` 三个自研 buffer 原语 | WebAudio 没有 AURemixFX；用离线预渲染做等价听感 |

---

## 5. 未照搬（明确放弃）

1. **`AURemixFX` 的 39 个参数**（`remixfx_*`）：没有对应节点，等价功能用自研原语；因此 style 17/18/19/20 的 `remixfx_*` 自动化只取「意图」（filter 扫频 / reverb 送出 / repeater 速率），不复制参数。
2. **`spatialOffsets` / 空间音频对齐**：我们不做 Atmos。
3. **`DJB2` 种子随机**：与「可解释 + 可单测」冲突，已弃。
4. **`AVPlayerItem.speedRamp` 39 段映射**：WebAudio 无等价能力，用 PLL + 小节量化替代。
5. **服务端 `flexml-analysis`**：不联网，用本机结构/乐句/循环单元替代。
6. **复杂度四档（fallback / crossFade / crossFadeWithEffects / timeStretchedCrossFadeWithEffects）**：我们用自己的退化阶梯（乐句→通用→等功率→cut），语义等价但不暴露「complexity」概念。

---

## 6. 苹果的真实数字（对听感最有用的七条）

1. **风格 16 / 8 / 20 的窗口分别是 4 / 8 / 4 小节**；8 小节在 124 BPM 下 = 15.49 s（日志实测），对应我们 `barMs` 换算完全一致。
2. **A 的 `out_gain` 只占窗口最后 12.5%（风格 16）**，不是全程等功率 —— 这是「听不出来在混」的核心。
3. **A 的低通只到 3500 Hz（风格 16）/ 760 Hz（风格 13）/ 200 Hz（风格 8）**，不是一刀切到 700 Hz。
4. **B 的高通从 5200 Hz 降到 20 Hz（风格 16）**，比我们从 12 kHz 开更「暗中进场」。
5. **`player_gain 1→0` 在 25% 处就执行**（风格 16）：苹果用输入增益直接掐 A，而不是靠输出淡出。
6. **delay 用 `@beat_length`**（1 拍）、`feedback 60%`、阻尼 3.5 kHz：这就是「Delay out」听感的配方。
7. **reverb decay 4 s、min delay 8→52 ms、max 106 ms、randomize 333**：苹果的混响是参数化 IR，不是固定采样。

---

## 7. 代码索引

| 文件 | 内容 |
|---|---|
| `web/src/core/automix/appleRecipes.ts` | `APPLE_RECIPES`（11 条烘焙配方）、`applePlanFor()`（→ 换手窗 / 扫频窗 / echo / reverb / tsRate） |
| `web/src/ui/crossfadeDeck.ts` | `APPLE_RECIPE_BY_STYLE` 映射表；`startSplitMix` 里套配方（换手、扫频窗、echo、reverb） |
| `web/src/core/automix/styleKit.ts` | 16 手法目录与打分（决定「用哪一类」） |
| `web/src/core/automix/genreProfile.ts` | 曲风预算（决定「最长多少小节」） |
| `web/tests/appleRecipes.test.cjs` | 6 条：配方骨架、风格 16/8 的原值、delay 参数、reverb 存在、未映射返回 null |
| `docs/zilux2-automix-v2.md` §7.60 | 本轮接线与验证记录 |

---

## 8. 下一步（按收益排序）

1. **按配方补齐目标频率**：把 `buildV2Plan` 的硬编码 `lpMin=700 / hpMax=12000 / hpFloor=20` 换成配方给的 `aLp.toHz / bHp.fromHz / bHp.toHz`（风格 8 的 A 要压到 200 Hz）。
2. **`player_gain` 语义**：在窗口 25% 处给 A 加一级「入图前衰减」，比现在的支路 fade 更接近苹果。
3. **`speedRamp` 分段**：至少做 4 段（起/中/合/回正），逼近 39 段的效果。
4. **`melodicness / danceability / valence`**：用 chroma 稳定度 + 鼓密度 + 大/小调比例做本机代理，补上 `inferGenre` 的判别力。

## 十一、DSP 图层面对齐（round 8）

`artifacts/DSPGraph.dspg` 的干/湿结构与我们之前的接法有一处实质差异，已落地：

| 维度 | Apple | 我们（改前） | 我们（改后） |
| --- | --- | --- | --- |
| 送出点 | `HP1/LP1` 之后（`Gain2`） | `duck` 之后（全带宽、扫频前） | 可切：滤波类手法走 `sweepHp`（= Apple），换手类仍走 `duck` |
| 尾巴的音色 | 跟着扫频一起变暗 | 一直亮 → 闷声上盖一层亮混响 | 与主声道同步变暗 |
| 湿声带限 | `HP2f 10 / LP2f 22000`（默认全开） | 无 | 不引入（post 取点已带主声道扫频） |
| 干湿比 | `Gain3`(dry) / `Gain4`(return) | `reverbGain` + 直通 | 等价 |

代码：`web/src/audio/automixV2Graph.ts` 的 `wetSendTap` / `setWetTap()`；`web/src/ui/crossfadeDeck.ts` 的 `startSplitMix`（`filterSweep/echoOut/reverbOut → post`）与 `releaseSplitMix`（复位 `pre`）；日志 `automix-v2-wet-tap`。

为什么不是全局 post：`bassSwap`/`eqSwap` 这类纯换手不应该把 0–120 Hz 送进回声/混响（低频进 delay 会糊成一片），而 `filterSweep`/`echoOut`/`reverbOut` 的尾巴本来就该跟着扫频一起变暗 —— 苹果做的是后者，我们按手法取。
