# Apple Music AutoMix 原理拆解 & Zilux2 进阶过渡方案 v2

> 调研基线：2026-11-19。代码基线：`v1.1.103`（`web/src/ui/crossfadeDeck.ts` 3914 行版）。
> 本文分两半：**上半**回答"苹果到底怎么做到的"（证据分级，不猜当结论）；**下半**回答"Zilux2 现在差在哪、新进阶效果怎么做"。
> 阅读建议：只想要结论看 §0 与 §5；要动手实现看 §7。

---

## 0. 三条结论先说

1. **Apple Music AutoMix 不是"更好的 crossfade"，而是"按曲目结构选型 + 强制对拍 + 结构级重编"三件事的组合。**
   官方只承诺三样：AI 分析音频特征、time stretching、beat matching（[Newsroom 2025-06-10](https://www.apple.com/newsroom/2025/06/apple-services-deliver-powerful-features-and-intelligent-updates-to-users-this-fall/)）。但产品行为暴露了更多：它**没有过渡时长档位**（Support 105067 明确只有 Crossfade 有秒数滑杆），说明过渡长度是由两首歌的段落边界算出来的，不是用户给的；它**只在订阅曲库上生效**、**只在 Apple silicon / A 系列上生效**，说明特征分析是预先算好、端侧只做推理与渲染。

2. **苹果的可听签名是"滤波扫频 + 大幅变速 + 用 intro/outro 拼桥"，不是分轨 EQ。**
   iOS 26 的默认过渡被 9to5Mac 形容为 "underwater"（水下感），iOS 27 才"largely replaced by more natural transitions"，并新增 "will even remix the outro and intro of songs to perfectly align the tempo… also repeat parts of the outros and intros to bridge the transition"。听感侧证据一致指向：**整轨低通扫频 + 明显的 tempo 拉伸（0.75×–1.5×）+ 段落重复/重排**；没有任何公开听感提到 bass/kick 交接、stem 分离、调性移调、人声叠唱。苹果 2009 年那份"分轨智能交叉淡化"专利（US20110015767A1 族）确实写了分轨 + 主导乐器 + 句尾切人声，但**公开可听特征不支持它被用在 AutoMix 里**——照抄专利会做错方向。

3. **Zilux2 现在的问题不是"曲线不好看"，是"决策空间太小"。**
   线上只走一条路：整轨等功率 cos/sin 交叉（`naturalGains`，[transitionMath.ts:13-17](../web/src/ui/transitionMath.ts#L13-L17)），变速上限 ±12%（`TEMPO_RATE_MIN/MAX = 0.88/1.12`，[crossfadeDeck.ts:185-186](../web/src/ui/crossfadeDeck.ts#L185-L186)），结构只用来"选 B 的入点和 A 的淡出终点"，**从不改动音频内容本身**。所以 Zilux2 的过渡天然"礼貌但平淡"：时间是聪明的，声音是两首歌整轨互相让路。苹果的过渡"像 DJ"是因为它在**频段**上做换手、在**段落**上做拼接——这两件事 Zilux2 目前一件都没在线启用。

---

## 1. 调研方法与证据分级

| 级别 | 含义 | 本文用法 |
|---|---|---|
| **A 确证** | 苹果官方原文（Newsroom / 功能页 / 支持文章 / 开发者文档）可逐字引用 | 直接当事实写 |
| **B 高可信推断** | 官方事实 + 产品限制 + 一手听感三者能闭合，且无矛盾证据 | 写明"推断"，给出推理链 |
| **C 猜测** | 只有间接线索或第三方转述，无法交叉验证 | 明确标注"猜"，不作为设计依据 |

采集渠道：Apple Newsroom / apple.com/apple-music / support.apple.com（105067、iPhone 手册 iphadf2fe1f4）/ developer.apple.com（Music Understanding、WWDC26-253）/ 专利检索（Google Patents、Justia 摘要片段）/ 一手听感（9to5Mac、Lifehacker、少数派、MacRumors 论坛）/ 竞品（Spotify playlist mixing、djay Automix）。

**取证失败记录（避免后来者重复踩）**：Google Patents 直连 `fetch` 在本机被拒（`fetch failed`）；Justia / freepatentsonline 返回 403；`patentimages.storage.googleapis.com` 是 PDF，`web_fetch` 不支持 `application/pdf`。结论：**专利全文只能靠检索片段拼**，凡引用处均标"检索片段"。

---

## 2. Apple AutoMix 是什么（产品层事实）

### 2.1 时间线与可用性

- 2025-06-10 随 iOS 26 / iPadOS 26 / macOS Tahoe 26 公布，2025 年秋上线。
- 入口：`设置 → App → 音乐 → 歌曲过渡 → AutoMix`；播放中 `Up Next → AutoMix` 开关。
- 默认开启（iPhone 手册："AutoMix is on by default"）。

### 2.2 官方原文（A 级）

| 来源 | 原文 |
|---|---|
| Newsroom 2025-06-10 | "Using AI to analyze audio features, it crafts unique transitions between songs with **time stretching and beat matching**…" |
| Apple Music 功能页 | "…crafting unique transitions with **beat matching and time stretching**." |
| iPhone 手册 iphadf2fe1f4 | "AutoMix **automatically selects the best transition**, depending on the music. For example, AutoMix might **remove silence** at the beginning and end of a track, or perform a **simple crossfade**, rather than a more complex transition, when appropriate." / "Albums and some genres play without transitions." |
| Support 105067（2026-11-12 版） | 仅对 "Apple Music subscription content" 生效；非订阅 "AutoMix will be grayed out"；"AutoMix and Crossfade are **not available with hi-res lossless**"；**只有 Crossfade 有秒数滑杆，AutoMix 无时长/强度档**；四种不做动态过渡的情形："Your album is played in sequential order." / "The genres or tempos are incompatible." / "Your content is uploaded from your music library." / "Your songs are purchased and downloaded from the iTunes Store." |

### 2.3 限制条件里藏着的技术信息（B 级推断）

| 限制 | 能推出什么 |
|---|---|
| 支持面：Apple silicon Mac / A 系 iPhone·iPad / Vision Pro / Apple TV 4K(2nd gen+) / HomePod；**Intel Mac、Android、Windows 版无** | 过渡**渲染与推理在端侧**跑（神经引擎/GPU），不是云端出流 |
| 只对订阅曲库生效；上传曲、iTunes 购买曲不做动态过渡 | 依赖**服务端预分析好的曲目特征**；本地任意文件没有这套特征 |
| 与 hi-res lossless 互斥 | 过渡管线必须在 **PCM 域做重采样/时间伸缩/滤波**，与 bit-perfect 直通路径冲突 |
| AutoMix 无时长/强度档（Crossfade 才有） | 过渡长度**由内容决定**（段落/乐句边界），产品上不给用户旋钮 |
| 顺序播放整张专辑不做过渡 | 有"**该不该混**"的门控，且尊重专辑意图（不是能力不足，是策略） |
| 结尾/开头静音会被裁掉 | 有 **silence trim** 这一档独立动作，且它比"混音"优先级更低、风险更小 |

> 这五条合起来指向一个很"产品经理"的设计：**先判断能不能混，再判断值不值得混，最后才选手法**。苹果的失败形态（不混、留白、普通淡出）不是 bug，是设计里的兜底档。

---

## 3. 拆解：Apple AutoMix 的四层结构

我把它拆成 L0–L3 四层。**A 级证据只覆盖到"有这四类动作"；每层的具体算法是 B/C 级推断**，下文逐层标注。

```
L0 曲库预分析（离线，一次）
    每首：BPM / 拍点 / 小节 / 段落(intro..outro) / 乐句 / 能量曲线 / 响度 / 调性
        ↓  特征随曲目下发（订阅曲库统一分析，所以上传曲没有）
L1 配对决策（播放期，毫秒级）
    这对歌能不能混？混多长？用哪种手法？→ 选型 + 锚点 + 时长
        ↓
L2 时间对齐
    折叠拍族 → 求 tempo ratio → 把两首拉到共同 BPM（可闻） → 拍/小节/乐句相位对齐
        ↓
L3 混合与重编
    淡入淡出 / 低通扫频 / 裁静音 / 重复 intro·outro 拼桥（iOS 27） → 输出
```

### 3.1 L0：它需要什么样的特征

苹果在 WWDC26-253 公开了 **Music Understanding** 框架（`import MusicUnderstanding`，OS 27，端侧离线），六个分析域恰好覆盖上表：

| 域 | 输出 | 对过渡的用途 |
|---|---|---|
| `rhythm` | `beats: [CMTime]`、`bars: [CMTime]`、`beatsPerMinute: Float?` | 拍/小节网格，对齐与贴拍 |
| `structure` | `sections` / `segments` / `phrases`（`CMTimeRange` 数组，三级） | 选段、找可循环单元、定过渡长度 |
| `pace` | `[RangedValue<Double>]` 能量/快感曲线 | 判断哪段"该让位"、哪段"该进" |
| `instrumentActivity` | `ranges[.drum]`、`activity[.vocal]`（0…1 时间曲线）、`.bass`、`.other` | 人声/鼓/贝斯的逐时活动度（**不是分离音频，是曲线**） |
| `loudness` | integrated LUFS、momentary（400 ms 窗/100 ms 步）、shortTerm、peak | 响度匹配、防削顶 |
| `key` | `[RangedValue<KeySignature>]` 调性时间线 | 调性筛选（是否混） |

来源：[developer.apple.com/documentation/musicunderstanding](https://developer.apple.com/documentation/musicunderstanding)、WWDC26-253；API 细节整理见 [axiom/music-understanding.md](https://github.com/charleswiltgen/axiom/blob/beff15fd7d86f610157706bdd1f56537ea77c837/.claude-plugin/plugins/axiom/skills/axiom-media/skills/music-understanding.md)。

**关键判断（B 级）**：Music Understanding 是 OS 27 才公开的，AutoMix 是 OS 26 就有的；官方从未把两者关联。但这个框架的输出**逐项对得上** AutoMix 需要的输入（拍网格、段落、活动度、响度、调性），且都是"端侧、离线、可 Codable 缓存"的形态。最合理的解释是：**AutoMix 用的是同一套内部能力的早期版本，Music Understanding 是它两年后的对外产品化**。这句话在报告里只能当推断用——**别拿它当"苹果官方说 AutoMix 用了 Music Understanding"**。

### 3.2 L1：配对决策——苹果真正"聪明"的地方

这是 AutoMix 和"所有 crossfade 实现"拉开差距的地方，也是最难从外部验证的地方。三条硬证据把它的形状框住了：

1. **无时长档** → 过渡长度是算出来的。
2. **有不混的情形**（专辑顺序、genre/tempo 不兼容、上传曲）→ 有前置门控。
3. **失败形态分三级**（不混 → 裁静音 → 普通淡出 → 复杂过渡）→ 是一个**代价递增的候选序列**，不是单一算法。

据此可还原出决策形状（B 级）：

```
输入：A 的尾段特征、B 的首段特征、二者 tempo/key/energy
1) 硬门控：B 没有可混入点（前奏太长/无拍/纯人声/古典） → 不混，只裁静音
2) 兼容性打分：tempo 折叠后比例 r、调性距离 d、能量差 e
3) 若无可行对齐（r 超出可接受变速范围，且无法用段落桥接） → 退普通 crossfade
4) 否则选手法：
   - 有可循环尾奏 + 有可切入前奏 → 结构桥接（repeat + 重排）
   - 仅 tempo 可对 → 变速对拍 + 滤波淡出
5) 定锚点：以 B 的第一个"可混入强拍/乐句头"为终点，反推 A 的让位起点
6) 定时长：让 A 的最后一个乐句边界与 B 的第一个乐句边界重合（而不是固定 8 秒）
```

> 第 6 条是"为什么苹果的过渡听起来总在音乐上说得出话"的核心：**它对齐的是乐句，不是秒**。这也是 Zilux2 已经在做的那部分（见 §4.2），所以这部分不是差距所在。

### 3.3 L2：时间对齐——苹果允许"难听"，Zilux2 不允许

一手听感里最硬的一条来自 Lifehacker（2025-07-01）："AutoMix will **slow down the end of the fast song**… also **speeds up slow songs**… **comically bad at times**"，作者抱怨不想听 "0.75x or 1.5x"。MacRumors 论坛一位自称 40 年 DJ 的用户同样描述 "slows down or speeds up the songs to **match perfectly**"。

这句"0.75x / 1.5x"信息量极大：

- 说明苹果的变速范围**至少到 ±25%~50%**，远超 DJ 软件常用的 ±8%~±16%；
- 说明它**优先保证"对拍"而不是"保真"**——宁可让一首歌明显变慢，也不允许两首歌各走各的拍；
- 也解释了 iOS 26 为什么被骂"水下感"：**大幅变速 + 低通扫频**叠加，音色会明显失真。

对照 Zilux2：`TEMPO_RATE_MIN = 0.88`、`TEMPO_RATE_MAX = 1.12`（[crossfadeDeck.ts:185-186](../web/src/ui/crossfadeDeck.ts#L185-L186)），超出就**放弃对拍**，退回等功率整轨交叉。这是一个产品取向差异，不是 bug：

| | Apple | Zilux2 现状 |
|---|---|---|
| 变速上限 | ≥ ±25%（实测到 0.75×/1.5×） | ±12%（`0.88–1.12`） |
| 超出上限怎么办 | 继续变速，接受音色代价 | 放弃对拍，整轨等功率 |
| 变速质量 | 未公开（推测 phase vocoder / 端侧专用算法） | 元素路径用 `preservesPitch = true`（浏览器内建，质量够用）；分轨路径用 `playbackRate`（**会变调**，旧进阶的硬伤） |
| 变速何时恢复 | 过渡结束（B 继续时回正） | `MATCHED_OVERLAP_END = 0.82`：A 在 82% 处静音后才回正 |

### 3.4 L3：混合——苹果做的是"频段换手 + 段落拼接"，不是分轨

#### （a）iOS 26：被骂"水下"的那一版

9to5Mac（2026-07-16）原句："The **'underwater' sound effect** that AutoMix defaulted to in iOS 26 has **largely been replaced by more natural transitions**…"。少数派（2025-07-08）的听感是：AutoMix ≈ **Beat Sync + Smart Fader**，"没有调整频段那么精细"，"第二首歌的人声切入非常快"。

把这几条拼起来，iOS 26 的混合形状基本可以确定（B 级）：

```
A（出曲）：低通从全开扫到 1–2 kHz 附近 + 整体淡出      ← "水下感"的来源
B（进曲）：从较低电平淡入（可能带高通，去掉低频打架）
不做：bass 交接、分轨、调性移调、人声避让
```

"没有调整频段那么精细"这句反向印证了：**苹果没做多段 EQ 的分频换手**，就是一个整轨低通扫下去。这和 Zilux2 里手选 `style='am'` 的曲线（A 低通 20k→2.3k、B 高通 10k→20Hz、bass −15dB，见 §4.4）在**形态上几乎一样**——差别在于苹果是**默认对所有歌都这么做**，Zilux2 是**藏在一个手选项里**。

#### （b）iOS 27：结构级重编（这是真差距）

同一篇 9to5Mac 还写了两句关键的话：

> "will even **remix the outro and intro** of songs to **perfectly align the tempo**"
> "It will also **repeat parts of the outros and intros** to **bridge the transition**."

这是 AutoMix 从"过渡效果"变成"自动编排"的分水岭：

- **repeat**：把 A 的尾奏（或 B 的前奏）里一个可循环单元重复 1–N 次，用来**延长**这一侧，直到另一侧的乐句边界刚好接上；
- **remix the outro and intro**：不只是重复，而是**重排**——例如跳过 B 前奏里的一段、或把 A 尾奏的最后两小节接到更早的位置，让"落点"落在对的拍上。

用 DJ 的话说：这不是 crossfade，这是 **loop + hot cue + 段落剪辑**。用工程的话说：**它改了播放时间轴，但没改音频文件**——所有操作都可以用"循环点 + 起播偏移 + 播放速率"三个参数表达。

> **这条是本次调研最重要的发现**：苹果的"高级感"有相当一部分不来自 DSP，而来自**时间轴重排**。Zilux2 完全具备做这件事的基础设施（双 deck + `currentTime` 精确控制 + 拍网格），但一行都没做。

#### （c）没有证据支持的东西（别做错方向）

| 传闻/直觉 | 证据状态 |
|---|---|
| bass/kick 频段交接 | **无任何公开听感提到**；少数派反而说"不如 DJ 软件调频段精细" |
| stem 分离（人声/鼓/贝斯分轨处理） | 官方从未提；2022 的 Sing 是另一功能；听感无迹 |
| 调性移调（key shift） | 只有媒体转述"matching key"，Apple 原文只有 beat matching + time stretching；**存疑** |
| 人声叠唱 / mashup | 无；"第二首人声切入非常快"更像是**避开**叠唱 |
| downbeat 对齐（而非任意拍） | 合理但无直接证据，标 C |

### 3.5 专利层：苹果 2009 年就写好了"分轨智能交叉淡化"

检索到的同族（**优先权 2009-07-20，Apple Inc.**）：`US20110015767A1` → `US20180005614A1` → `US10235981B2`，标题统一为 **"Intelligent crossfade with separated instrument tracks"**。

从检索片段能确认的权利要求要素（片段原文，非全文）：

- 把当前曲 `s1` 与下一曲 `s2` **各自分解成多条 instrument tracks**（不是整轨）；
- 比较 `s1` 与 `s2` 的差异，**判定主导乐器（dominant instrument）**及其对应轨；
- 对**人声轨**的交叉淡化按"**句子结尾 / 无辅音的位置**"进行（"finding the ends of sentences or places where there are no c…"）；
- 阈值（threshold）**基于 `s1` 与 `s2` 的差异**——即"两首歌越不像，让位越保守"。

这套东西听起来正是"高级过渡"的标准答案，但要注意两点：

1. **专利 ≠ 产品**。这份申请 2009 年就递了，AutoMix 2025 年才出；中间十几年苹果完全没在 Music/iTunes 里做过分轨过渡。专利更可能是"防御性储备"。
2. **公开听感与分轨假设矛盾**：如果真做了逐轨让位，人声不会"切入非常快"，低频不会"没有频段调整"。

> 结论：**专利可以用来理解"这件事理论上怎么做才最优"，但不能用来解释"AutoMix 现在怎么做的"**。新方案里我会把分轨/活动度作为**可选增强层**（§7.7），而不是主路径——这既符合苹果的公开行为，也避开旧进阶踩过的成本坑。

另外两个非 Apple 的自动混音专利族值得记一笔（检索片段）：

- `US9883284` / `US11347475`（"Systems and methods for automatic mixing of media"）：把过渡抽象成**具名 transition function 库**，每个函数可拆成多段、可赋值/重赋值；其中 "Classic beat mix" = 两轨 tempo 匹配 + 线性音量交叉 + **在交叉的中段三分之一对低频做快速衰减**。
- `EP3196782A1`：mix-in / mix-out 段 + downbeat 对齐 + "可混合区间"判定。

这两条给新方案提供了两个可直接用的结构：**"过渡 = 具名函数 + 分段参数"** 和 **"低频在交叉中段快速让位"**。

### 3.6 听感证据汇总（一手，按可信度排序）

| 来源 | 观察 | 支撑的机制 |
|---|---|---|
| 9to5Mac 2026-07-16 | iOS 26 "underwater"；iOS 27 更自然；remix outro/intro 对齐 tempo；repeat parts 拼桥 | 低通扫频；**结构重编** |
| Lifehacker 2025-07-01 | 快歌结尾被放慢、慢歌被加快；0.75×/1.5×；"comically bad" | 大幅变速，优先对拍 |
| 少数派 2025-07-08 | ≈ Beat Sync + Smart Fader；频段不精细；第二首人声切入很快 | 无分轨；整轨滤波；人声不叠 |
| MacRumors 论坛 2025-08-14 | "slows down or speeds up the songs to match perfectly" | 同上 |
| BGR / ResetEra | 失败时硬切、突兀、不该混的地方混 | 门控不是万能的；有硬切兜底 |

### 3.7 置信度表（一句话版）

| 结论 | 级别 |
|---|---|
| 用 time stretching + beat matching 造过渡 | **A** |
| 会裁首尾静音；会退化成普通 crossfade；有不混的情形 | **A** |
| 只在订阅曲库 + Apple silicon/A 系上生效 | **A** |
| 无时长/强度档，过渡长度由内容决定 | **A**（由"只有 Crossfade 有滑杆"直接推出） |
| 变速幅度可达 ±25%~50% | **B**（一手听感 0.75×/1.5×） |
| 出曲做低通扫频（"水下感"） | **B**（听感 + iOS 27 才"变自然"） |
| iOS 27 会重复/重排 intro·outro 来拼桥 | **B**（一手评测原句） |
| 用 Music Understanding 同源能力做分析 | **B**（能力逐项吻合，但无官方关联） |
| 分轨 / bass 交接 / 调性移调 | **C 或否**（无证据；听感反证） |
| 对齐粒度是 downbeat 而非任意拍 | **C** |

### 3.8 用伪代码把"苹果怎么做到的"写死

```ts
// 苹果 AutoMix 的可观测行为模型（B 级还原，不是源码）
function autoMix(prev, next, ctx) {
  const a = prev.features;              // 预分析：拍/小节/段落/乐句/能量/响度/调性
  const b = next.features;
  if (ctx.albumSequential || !ctx.subscription) return NO_TRANSITION;

  const r = foldTempoFamily(b.bpm / a.bpm);          // 半/倍速折叠到 1 附近
  const compatible = keyOk(a, b) && energyGap(a, b) < E_MAX;
  if (!compatible) return TRIM_SILENCE_OR_CROSSFADE; // 官方明说的退化档

  const anchors = pickAnchors(a, b);   // A 的最后一个乐句边界 / B 的第一个可混入强拍
  const needMs  = anchors.endB - anchors.startA;

  // ① 若段落不够长 → 用重复/重排把短的一侧"补长"（iOS 27 行为）
  let plan = null;
  if (needMs > a.tailRoomMs) plan = repeatUnit(a, pickLoopUnit(a.tail), ceil(needMs / unitMs));
  if (needMs > b.headRoomMs) plan = plan ?? trimOrReorderIntro(b, needMs);

  // ② 对拍：把两首拉到共同 BPM（允许大幅变速，接受音色代价）
  const warp = tempoWarp(a, b, r);     // 出曲渐慢/进曲渐快，过渡结束回正

  // ③ 混合：整轨低通扫频 + 等功率淡出（iOS 26 的"水下感"来源）
  const blend = lowpassSweep(a) + fadeOut(a) + fadeIn(b) /* + 可选高通 on b */;

  return { plan, warp, blend, lengthMs: needMs };
}
```

---

## 4. Zilux2 现状解剖

### 4.1 先分清两个东西：`automix.ts` 不是过渡

| 模块 | 干什么 | 与"过渡"的关系 |
|---|---|---|
| [`web/src/ui/automix.ts`](../web/src/ui/automix.ts) 的 `orderUpcomingByMix()` | **队列重排**：按 Camelot 距离 + BPM 距离贪心排序（最多分析 40 首） | 只决定"下一首是谁"，不决定"怎么混" |
| [`web/src/ui/crossfadeDeck.ts`](../web/src/ui/crossfadeDeck.ts) | 真正的声音过渡 | 本文讨论对象 |

> 所以"我现在 zilux2 的自动混音过渡"= `crossfadeDeck` 的**标准路径**。名字叫 AutoMix 的那个文件其实在做选曲——这本身是个命名债，报告最后会建议改名。

### 4.2 标准路径的"时间智能"（其实不弱）

[crossfadeDeck.ts](../web/src/ui/crossfadeDeck.ts) 在**时间轴**上做了 9 件事，这部分已经接近苹果的 L1/L2：

1. `tempoAtMs()`（:1453）：跟拍覆盖 > 速度曲线最近 5 点中位 > 整曲 BPM —— 处理变速歌。
2. `coordinatedBarMs()`（:1506）：能变速对齐时用 A 的小节长，否则用两首的调和平均。
3. `buildAutoFadePlan()`（:1557）：默认 1 个乐句（`AUTO_BARS = 4`），小节短或尾奏宽裕时放宽到 6/8 小节；结果夹在 `MIN_FADE_MS = 1200` ~ `MAX_FADE_MS = 32000`（:171/:176）。
4. `buildStructureCue()`（:1726）：结构混音——B 入点 auto=曲首，可选 intro/drop/chorus；过渡长度按 preset（full 8 / fast 2 / balanced 4 小节）。
5. `buildSchedule()`（:1815）：A 的淡化终点对齐**可听结尾** `audibleEndMs`；尾部静音按 `min(20s, 0.2×duration)` 修正。
6. `snapToGrid` + `phraseCue`：贴拍、贴乐句。
7. B 的相位微调：`shift = toNextB − toNextA×tempoRate`，仅当 `|shift| ≤ 220ms` 才应用（:1815 附近）。
8. 歌词 handoff：A 末句唱完 = 淡化起点，B 首句 = 淡化终点，尾奏按整小节先留给 A 独听。
9. 响度匹配 `transitionMatchDb()` + 低频交接参数 `bassHandoffP`（默认 0.75）。

**结论：Zilux2 的"什么时候混、混多长、从哪进"已经做得不错，甚至比苹果更讲究（歌词级 handoff）。差距全在"混的时候声音怎么变"。**

### 4.3 混合只有一条曲线：整轨等功率

```ts
// web/src/ui/transitionMath.ts:13-17
export function naturalGains(progress: number, overlapEnd = 1): [number, number] {
  const p = Math.max(0, Math.min(1, progress / overlapEnd));
  return [p >= 1 ? 0 : Math.cos(p * Math.PI / 2), Math.sin(p * Math.PI / 2)];
}
```

- 200 个采样点排进 AudioParam（`scheduleNaturalFade()`，:1125）；元素模式每帧写 `volume`（`applyEqualPowerGains()`，:1078）。
- 变速时 `overlapEnd = 0.82`（`MATCHED_OVERLAP_END`）：A 在 82% 处就静音，剩下 18% 只留给 B 回速。
- `resolveTransitionStyle()`（:1676）：`style='auto'` 时只有"拍速差 > 0.25 且 Camelot gap > 5"才返回 `'cut'`，**其余永远 `'equal'`**。
- 所以默认路径下：`plan.am = false`，`plan.styleResolved = 'equal'`（:2320-2321）—— **交融曲线、低频交接、滤波扫频全部不执行**。

### 4.4 手选 `style='am'` 时其实有一套不错的曲线（但被藏起来了）

`AM_A_POINTS`（:1162）与 `AM_B_POINTS`（:1179）的控制点：

| p | A 侧 | B 侧 |
|---|---|---|
| 0 | 低通 20 kHz | −30 dB，高通 10 kHz，bass −15 dB |
| 0.10 | 低通 10 kHz | 同上 |
| 0.15 | 低通 6.5 kHz | 同上 |
| 0.25 | 低通 6 kHz | −30 dB，高通 10 kHz |
| 0.35 | 低通 4.8 kHz | 同上 |
| 0.40 | 低通 3 kHz | 高通 3 kHz |
| 0.45 | — | −10 dB，高通 1 kHz |
| 0.55 | −8 dB，低通 2.3 kHz | −5 dB，高通 300 Hz |
| 0.90 | — | 0 dB，高通 300 Hz |
| 1.00 | −25 dB | 0 dB，高通 20 Hz |

外加 `AM_A_TAIL_P = 0.96 → −60 dB`（防爆音）、`AM_BASS_HANDOFF_P = 0.75`（低频在 75% 处交接，`halfWindow = min(120ms, dur×0.08)` 的短斜坡，A 0→−15 dB、B −15→0 dB）。

**这套曲线的问题不是不好，是"时间比例驱动"**：所有控制点都挂在 `p = 进度/总时长` 上，与**小节线、乐句、结构**无关。同一套曲线配 3 秒过渡和 30 秒过渡，听感完全不同；而且在 p=0.25 之前 B 一直是 −30 dB，等于白白浪费 1/4 的过渡时长。苹果的做法是"锚在小节/乐句上"——这是新方案要改的第一件事。

### 4.5 旧进阶为什么被废弃（证据 + 归因）

`docs/zilux2-advanced-transition-final-report.md`（534 行）记录的成绩其实很好：

| 指标 | 旧进阶 | 整轨等功率 |
|---|---|---|
| 换手点误差 | 0.000 ms | — |
| 低频波动 | **1.425 dB** | 4.106 dB |
| 人声重叠 | 0.872 拍 | — |
| PLL 收敛 | 第 7 拍进 ±5 ms | — |
| 分轨残差 | −35.55 dB | — |
| SDR（MUSDB18-HQ 三曲均值） | 9.27 dB | — |

但仍然被废弃。归因（结合代码与文档，B 级）：

1. **成本**：4 轨 × 30 s 单窗 = 5.29 MB/轨，体积翻倍；`stemCacheLru` 容量压力大。
2. **质量硬伤**：分轨路径只改 `playbackRate`，**没有 WSOLA/phase vocoder**，>2% 变速就变调——而变速恰恰是过渡的核心动作。
3. **适用面窄**：只在 `graphMode` 生效；元素路径（`preservesPitch`）反而音质更好但拿不到分轨。
4. **可靠性**：预热只有一次机会，没预热到就降级；`other` 轨含人声残留；三档门控（`advanced | advancedSafe | standard`）组合爆炸。
5. **收益不对称**：低频波动从 4.1 dB 降到 1.4 dB 是"专业监听能听出、普通耳机听不出"的量级，却付出了 4 倍算力。
6. **缺结构级能力**：即使分轨完美，它仍然只是"在同一个时间窗里换手"，没有 loop/重排——而这才是苹果"像 DJ"的主因。

> 一句话：**旧进阶把工程复杂度全押在"分轨"上，押错了方向**。新方案要把复杂度押在"结构重排 + 频段换手"上，分轨降级为可选。

---

## 5. 逐项对比表

| 维度 | Apple Music AutoMix | Zilux2 标准路径（线上） | Zilux2 旧进阶（已废弃） |
|---|---|---|---|
| 分析输入 | 订阅曲库预分析：拍/小节/段落/乐句/能量/响度/调性/活动度（Music Understanding 同源，B 级） | 本地按需分析：拍/强拍/乐句/段落/速度曲线/Camelot/LUFS/能量/高潮/入出点/可听结尾 | 同上 + 4 轨分离（htdemucs） |
| 决策自由度 | 按曲目自动选型 + 前置门控 + 代价递增的候选序列 | `style` 四选一但默认永远 `equal`；`preset` 只改小节数 | 5 种模板 + 三档门控 |
| 过渡时长 | **无档位，由段落边界算出** | 1 个乐句起，按空间放宽到 6/8 小节，夹在 1.2–32 s | 按模板固定小节数（如 club32） |
| 时间对齐 | 折叠拍族 + 大幅变速（≥±25%） | 折叠拍族 + ±12% 上限 + PLL 微调 + 82% 处回速 | 同标准 + 拍级 PLL |
| 对齐粒度 | 乐句/小节（B 级） | **乐句 + 拍 + 歌词句**（这块 Zilux2 更强） | 小节 + 拍 |
| 混合 DSP | 整轨低通扫频 + 淡出（iOS 26）；更自然的过渡（iOS 27） | **只有整轨等功率 cos/sin** | 4 轨逐轨换手 + 滤波 + 回声 |
| 频段分工 | 无（听感反证） | 无（除非手选 `am`） | 有（bass/drums/other/vocals） |
| 结构重编（loop/重排） | **有（iOS 27：repeat intro/outro、remix）** | **无** | **无** |
| 人声处理 | 不叠唱（现象级）；无证据做避让 | 歌词 handoff（选点避让） | 人声避开 + 0.872 拍重叠 |
| 响度 | 未公开（推测用 loudness 域） | LUFS 补偿 `transitionMatchDb()` | 同标准 |
| 失败退化 | 不混 → 裁静音 → 普通淡出 → 复杂过渡 | cut / equal / `fallbackFromAdvanced` | 三档门控降级 |
| 覆盖范围 | 仅订阅曲库，仅 Apple 芯片 | **任意本地/在线曲**（优势） | 任意曲，但需预热分轨 |
| 用户可调 | 几乎为零（只有开/关） | 参数面板一大堆（style/preset/bars/handoff/bassSwap/loudness/tempoRange） | 更多 |

**一句话总结差距**：
> Zilux2 在"**什么时候混**"上不输苹果，在"**混多长/从哪进**"上甚至更细（歌词级）；但在"**混的时候声音怎么变**"上只有一条等功率曲线，在"**用段落拼桥**"上是零。苹果的"高级感"= 频段换手（听感层）+ 结构重编（编排层），Zilux2 两层都缺。

---
## 6. 听感差异的物理解释（为什么"等功率"听起来就是不如"换碟"）

这一节解释"参数差不多，听感差很多"的物理原因——新方案的设计依据全在这里。

### 6.1 低频：等功率假设在舞曲上是错的

等功率交叉的数学前提是**两路信号不相关**：总功率 `a² + b² = 1`，所以听起来"响度恒定"。但两首 4/4 舞曲的低频**高度相关**——都是每拍一个 kick，频率都在 50–100 Hz，只是相位不同。相关信号叠加时：

- 同相 → 幅度相加，等功率曲线在中段给出 **+3 dB 隆起**；
- 反相 → 抵消，出现**梳状凹陷**。

旧进阶报告里那个数字正好印证：**整轨等功率的低频波动 4.106 dB，逐轨换手后 1.425 dB**。也就是说，用户听到的"糊"和"一下胖一下瘦"，主要来自低频，而不是中高频。

DJ 的解法是 **bass swap**：任何时刻只让一首歌拥有低频。数学上就是低频段用 `a + b = 1`（线性），而不是 `√(a²+b²) = 1`。旧报告里 `Curve = 'linear'` 的注释写得很清楚："完全相关的低频用 linear 才是 a+b=1，shelfDip 反而引入 3 dB 凹陷"（[transitionPlan.ts:19-27](../web/src/core/transitionPlan.ts#L19-L27)）。

苹果没做 bass swap（听感反证），它用了一个更粗暴但有效的替代：**给出曲加低通，把低频整个扫掉**。副作用就是"水下感"——不只是低频没了，2 kHz 以上也一起闷掉。iOS 27 说"更自然"，最可能的改动是**把扫频范围收窄/换成更平缓的滤波器**，而不是改成分轨。

> 对 Zilux2 的启示：**不需要分轨也能做低频交接**。在每路 deck 上加一个 Linkwitz-Riley 分频（120 Hz），低频走 linear、中高频走 equal-power，成本是两个 BiquadFilter，收益是 4.1 dB → ~1.5 dB 的低频稳定性。

### 6.2 变速：8% 和 25% 是两种产品

人耳对**速度**的容忍度远高于对**音高**的容忍度。`preservesPitch` 把音高锁住之后：

- ±8% 以内：绝大多数人听不出"这首歌变快了"，只觉得"节奏更紧"；
- ±15%：能听出"赶"，但仍在 DJ 常用范围内（house/techno 的 ±6%~±8%，pop 的 ±15% 也常见）；
- ±25% 以上：律动感明显改变，鼓组的 swing 会变形，人声的咬字会"拖"——Lifehacker 说的 "comically bad" 就是这个区间。

但**对拍带来的收益是非线性的**：一旦两首歌的 kick 完全重合，听觉系统会把它们融合成"一个鼓组"（auditory stream fusion），这时候两首歌的旋律/人声叠在一起也不会觉得"两首歌在打架"。这就是 DJ 混音听起来"专业"的心理学基础。

苹果的选择很明确：**宁可牺牲音色，也要拿到融合**（所以敢用 0.75×/1.5×）。Zilux2 的选择相反：**宁可不对拍，也要保音色**（±12% 上限，超出就整轨淡出）。

新方案的建议是中间路线：**默认 ±15%，允许配置到 ±22%，但超过 ±18% 时必须走"结构桥接优先"**——先用 loop 把长度差吸收掉，让变速需求变小。这是苹果 iOS 27 做的事，也是 Zilux2 可以直接超车的地方（因为 Zilux2 的分析器已经有 `phraseStartsMs` 和 `sections`）。

### 6.3 乐句：人耳数的是 8 小节，不是 1 拍

4/4 舞曲的段落感以 **8 小节（约 15 秒 @128 BPM）** 为单位。如果 B 的 drop 落在 A 的第 3 小节而不是第 1 小节，听感就是"进早了/进晚了"，即使拍是对齐的。

这就是为什么"拍对齐"不够，要"乐句对齐"。而乐句对齐的难点在于：**两首歌的乐句长度往往不整除**（A 的尾奏剩 6 小节，B 的前奏要 8 小节才到 drop）。固定窗口的 crossfade 对此无解，只能硬凑；结构重编的解法是：

```
把 A 的尾奏循环单元重复 k 次，使 6 + 4k ≥ 8   → k = 1，实际延长到 10 小节
或把 B 的前奏裁掉 2 小节（从第 3 小节起播）  → 让 drop 正好落在 A 的第 7 小节
```

两个操作都只改"播放位置"，不改音频文件——**这就是"用时间换对齐"**。苹果 iOS 27 的 "repeat parts of the outros and intros"，本质就是前者。

### 6.4 为什么结构重编是"降维打击"

| 手段 | 音色代价 | 对齐能力 | 实现成本 |
|---|---|---|---|
| 等功率淡出 | 无 | 只能对齐"时长" | 极低（已有） |
| 低通扫频 | 中（闷） | 同上 | 低（已有 `am` 曲线） |
| 大幅变速 | 高（律动变形） | 拍级对齐 | 中（已有 PLL） |
| **loop/裁剪重排** | **零** | **乐句级对齐** | 中（需要 loop 检测 + 时间轴控制） |
| 分轨换手 | 低 | 频段级分离 | 高（旧进阶，已废） |

结构重编是唯一"零音色代价 + 乐句级对齐"的手段。苹果在 iOS 27 才加上它，说明它也需要先把 structure 分析做准——而这恰好是 Zilux2 分析器已经有的东西（`sections`、`phraseStartsMs`、`downbeats`）。

---

## 7. 新进阶方案 v2（替代已废弃的旧进阶）

> 前提：旧进阶（4 轨分轨 + 逐轨换手 + 三档门控）**废弃，不在此基础上改**。新方案从"苹果的可听签名"出发重新设计，分轨只作为可选增强。

### 7.1 目标与非目标

**目标**

| 编号 | 目标 | 可验收的形式 |
|---|---|---|
| G1 | 默认路径就有"频段换手" | 任意能混的 pair，出曲在中段被低通收束，进曲低频延迟进入；低频波动 ≤ 2 dB |
| G2 | 新增结构桥接 | 乐句对齐误差 ≤ 1 拍；能对"尾奏 6 小节 vs 前奏 8 小节"这类不整除情况给出 loop 或裁剪方案 |
| G3 | 变速能力扩到 ±15%（可配 ±22%），且不变调 | 换手点误差 < 5 ms；spectral centroid 偏移 < 3% |
| G4 | 决策可解释、可单测、播放中不随机降级 | 每次过渡 dump 一份 `MixScript`；决策树单测覆盖 100% |
| G5 | 不依赖分轨也能工作；分轨只在必要时启用 | 关闭分轨时功能完整；开启时只多一条 vocals 轨 |

**非目标（明确不做）**

- 不做 mashup / 人声叠唱（苹果也没有，且版权与听感风险都高）；
- 不做实时 stem 分离（预分析阶段解决）；
- 不做 key shift（保留接口，v3 再说）；
- 不做"每对歌都可调参数"的 UI（苹果的克制是优点，Zilux2 现在参数已经太多）。

### 7.2 架构：五层，每层可独立测试

```
S0 预分析（host，C#，离线一次）
   beat/downbeat/phrase/section（已有）
 + activity{vocal,drum,bass} 100ms 曲线        ← 新增
 + momentaryLufs 100ms 曲线                    ← 新增
 + loopUnits[{startMs,endMs,bars,kind}]        ← 新增
 + phrases[{startMs,endMs,label}]              ← 由 phraseStartsMs 升级
        ↓  随 analysis JSON 下发（契约升 v2）
S1 配对规划（web，纯函数）  automixPlan.ts
   硬门控 → 兼容性打分 → 选型（bridge|beatmix|fade|cut|none）→ 锚点 → 时长
        ↓  MixScript（纯数据，可 dump）
S2 编排求解（web，纯函数）  arrangement.ts
   loop 单元重复次数 k、B 起播偏移、A 让位点，解"乐句同余"方程
        ↓
S3 时间伸缩（web，执行）  crossfadeDeck 的 rate ramp + PLL
   B 预变速（无声）→ A 渐变（≤1.5%/拍）→ 结束后 1 小节回正
        ↓
S4 混合 DSP（web，执行）  stemGraph / 新增分频节点
   分段等功率（低频 linear） + 频段换手 + 可选 duck + 可选 echo out
        ↓
S5 质量门（web，纯函数）  qualityGate.ts
   离线预演：低频隆起、人声重叠、响度漂移、速率跳变 → 不通过则降级
```

**与旧架构的关键差别**：旧方案是"决策层 → 分轨执行层"两层；新方案把**编排（S2）**独立出来，因为它是苹果差异化的来源，而且它是纯数学，最容易测试。

### 7.3 S0：分析契约 v2（新增字段与算法）

在现有 `docs/zilux2-beat-analysis-contract.md` §2.1 上**只增不改**：

```jsonc
{
  "activity": {
    "hopMs": 100,
    "vocal": [0.02, 0.05, ...],   // 0..1，与 hopMs 对齐
    "drum":  [...],
    "bass":  [...]
  },
  "momentaryLufs": [-18.2, -17.9, ...],   // 100ms 步，400ms 窗
  "phrases": [{"startMs": 125, "endMs": 15125, "label": "intro"}],
  "loopUnits": [
    {"startMs": 168000, "endMs": 175500, "bars": 4, "kind": "outro", "confidence": 0.82}
  ]
}
```

**不需要分轨就能算的三条曲线**（都在现有 FFT pass 里加，边际成本 < 5% 分析耗时）：

| 曲线 | 算法（可行版） | 备注 |
|---|---|---|
| `bass` | `< 150 Hz` 的 RMS / 总 RMS，100 ms 窗，除以曲目 95 分位归一 | 最可靠，直接反映 kick/bass 存在 |
| `drum` | `< 150 Hz` 的 spectral flux 峰值密度（每 100 ms 内的峰数 / 4），再平滑 | 与 bass 区分：鼓是"瞬态"，bass 是"持续" |
| `vocal` | 300–3.5 kHz 的谐波能量占比 × 中频谱平坦度倒数 × 4–8 kHz 齿音能量；三者加权后过 sigmoid | 会有误判（失真吉他、弦乐），所以只用于"避让门控"，不用于精确切分 |

**`loopUnits` 检测**（结构桥接的前提）：

```
候选：所有 phrase 边界对 (i, j)，长度 ∈ {2,4,8} 小节
打分：能量方差（越小越好）
    × 无 vocal 活动（activity.vocal 均值 < 0.15）
    × 谐波内容稳定（chroma 方差小）
    × 边界在 downbeat 上（必须）
取 top-3，confidence 归一化
```

这套东西的精度不需要"完美分轨"，只需要"知道这段能不能重复"——容错空间大得多。

> 如果后续想更准：host 端已有 `HtdemucsSession`，可以对**候选 loop 单元**（4–8 小节，约 8–15 秒）单独跑一次分离，只取 vocals 轨做 activity 校正。成本是"每首 1–2 个短窗"，而不是旧的"整首 4 轨"。

### 7.4 S1：配对决策树（含阈值）

输入：

```ts
interface PairInput {
  a: { bpm: number; tailRoomMs: number; loopUnits: LoopUnit[]; sections: Section[]; vocalTail: number };
  b: { bpm: number; headRoomMs: number; firstDropMs: number; firstVocalMs: number; sections: Section[] };
  keyDistance: number;      // Camelot 距离
  energyGap: number;        // |energyA - energyB|
  loudnessGap: number;      // |lufsA - lufsB|
}
```

决策（按顺序，命中即返回）：

```
1. 硬门控
   a 无 downbeats 或 b 无 downbeats        → type='none'（留原样）
   b.headRoomMs < 2 * barMs                → type='cut'（没地方进，直接切）
   energyGap > 0.45 且 keyDistance >= 3    → type='fade'（差太多，别硬混）

2. 变速可行性
   r = foldTempo(b.bpm / a.bpm)            // 半/倍速折叠到 1 附近
   |r - 1| <= 0.15                         → beatmix 可行
   |r - 1| <= 0.22                         → beatmix 可行（标记 "audible"）
   否则                                     → 只能 fade/cut

3. 结构桥接可行性（优先于 beatmix）
   needMs = 目标乐句对齐所需时长
   若 a.loopUnits 非空 且 (needMs - a.tailRoomMs) 可由 k<=2 次重复吸收
       且 总时长 <= 32s                     → type='bridge'
   若 b.firstDropMs > a.tailRoomMs + 8*barMs 且 b 前奏可裁     → type='bridge'（裁 B 前奏）

4. 人声风险
   vocalOverlap = overlap(a.vocalTail, b.vocalHead)  // 拍为单位
   > 1 拍 → 选 B 的非人声入点（若存在）；否则开 duck

5. 兜底
   type='fade'
```

**阈值表**（全部可配置，集中在 `transitionTuning.ts`）：

| 参数 | 默认 | 含义 | 依据 |
|---|---|---|---|
| `tempoSoftLimit` | 0.15 | 听不出的变速上限 | §6.2 |
| `tempoHardLimit` | 0.22 | 允许但标记"可闻" | Lifehacker 的 0.75/1.5 是苹果的上限参考 |
| `maxLoopRepeats` | 2 | 最多重复 2 次 | 再多会"卡带" |
| `maxMixMs` | 32000 | 与现有 `MAX_FADE_MS` 一致 | 现有产品约束 |
| `minMixMs` | 1200 | 与现有 `MIN_FADE_MS` 一致 | 同上 |
| `vocalOverlapBeats` | 1.0 | 人声最多叠 1 拍 | 旧进阶实测 0.872 拍可接受 |
| `bassBumpDb` | 2.0 | 低频隆起上限 | 旧进阶 1.425，整轨 4.106 |
| `energyGapMax` | 0.45 | 超过就别混 | 经验值，需标定 |

### 7.5 S2：编排求解（"乐句同余"）

**问题形式化**：

```
给定：
  A 的乐句边界集合 PA = [p1, p2, ...]（升序，末尾是 audibleEnd）
  A 的循环单元 U = [uStart, uEnd]（长度 L，小节数 n）
  B 的乐句边界集合 PB（相对 B 文件起点）
目标：
  选 aEnd ∈ PA（A 让位点）、bStart ∈ PB（B 入点）、k ∈ {0,1,2}
  使 |(aEnd + k*L) - bStart*rate| < 1 拍
  且 aEnd + k*L <= audibleEnd + 允许溢出（0，不超出可听结尾）
  且 过渡时长 ∈ [minMixMs, maxMixMs]
打分（越大越好）：
  s = 1.0 * 乐句匹配（两端都在乐句头）
    + 0.4 * 段落类型匹配（outro→intro / drop→drop / chorus→chorus）
    + 0.3 * 能量连续性（1 - |eA(aEnd) - eB(bStart)|）
    + 0.2 * 时长偏好（接近 8/16 小节）
    - 0.5 * 人声重叠（拍）
    - 0.3 * 变速需求
```

**实现要点**：

- `rate` 参与同余方程，所以"变速"和"对齐"是**联合求解**，不是先变速再对齐（现有 `buildSchedule` 是后者，容易在最后差半拍）。
- `k` 只在 A 侧重复（B 侧裁剪用 `bStart` 偏移，不需要循环）——这比"两边都 loop"简单一个量级。
- 循环实现不需要重编码：在 deck 上设 `loopStart/loopEnd`，`currentTime` 到 `loopEnd` 时跳回 `loopStart`；Web Audio 元素源用 `AudioBufferSourceNode.loop`，`<audio>` 元素用 `timeupdate` + 手动 seek（精度差，建议走 graph 的 buffer source）。
- 溢出保护：`aEnd + k*L` 不得超过 `audibleEndMs`，否则 k 减一。

### 7.6 S3：时间伸缩执行

**现状（这部分 Zilux2 已经做对了，别改坏）**：标准路径是**单侧变速**——只变速 B，A 保持原速。B 的速率在起播前就设好（[crossfadeDeck.ts:2841](../web/src/ui/crossfadeDeck.ts#L2841) `setDeckPlaybackRate(standby, baseRate * tempoRate)`），所以听不到"启动变速"；A 在 82% 处静音后，B 再用剩下 18% 的时间回正（[crossfadeDeck.ts:3028-3037](../web/src/ui/crossfadeDeck.ts#L3028-L3037) 的 `restore` 斜坡）。这个设计的优点是**正在播放的歌永远不变速**，听感最稳。

**新方案要改两点**：

1. **对半分摊（bisect）**：现在差值全压在 B 上，`|r-1| = 0.12` 时 B 要独自承担 12%。扩到 ±22% 后单侧变速会明显（音色、咬字都变）。改成 A 与 B 各承担一半（相对速率），并且**A 的变速只允许发生在"已被低通扫到 3 kHz 以下"的阶段**（即频段换手的第 2 小节之后），此时 A 只剩中低频，变速的可闻度大幅下降。
2. **回正改为小节量化**：现在 `restore` 是"剩余 18% 的时间"（`MATCHED_OVERLAP_END = 0.82`），长过渡里这段可能有 5 秒，B 的速率在这 5 秒里一直漂。改成"过渡结束前整 1 小节内回正"，斜率 ≤1.5%/拍。

```
阶段 0（B 起播前）  ：B 直接 rate = 1 + (r-1)/2      —— 无声，任意幅度都听不到
阶段 1（第 1–2 小节）：A rate 1 → 1 - (r-1)/2，线性，斜率 ≤1.5%/拍，同时 A 已被低通
阶段 2（第 3 小节–末）：B rate 由 PLL 微调（±3 ms 相位误差）
阶段 3（最后 1 小节）：B rate → 1.0；A 已静音（82% 之后）
```

- 速率来源：`tempoAtMs()` 的局部 BPM（[crossfadeDeck.ts:1453](../web/src/ui/crossfadeDeck.ts#L1453)），不是整曲 BPM。
- **不变调**：元素路径 `preservesPitch = true`（[crossfadeDeck.ts:1056](../web/src/ui/crossfadeDeck.ts#L1056)）；graph 路径若走 `AudioBufferSourceNode`，`playbackRate` 会变调，必须改用宿主端 WSOLA 或预渲染变速片段。**这是旧进阶的致命伤，新方案必须绕开。**

### 7.7 S4：混合 DSP（四层，逐层可关）

#### 层 A：分段等功率（基线，必开）

```
每路 deck：
  input → LR4 分频（120 Hz）
        ├─ low  → lowGain  → sum
        └─ high → highGain → sum

曲线：
  low:  a = 1-p, b = p            （linear：相关信号，a+b=1）
  high: a = cos(pπ/2), b = sin(pπ/2)  （equal-power：不相关）
```

- 成本：每路 2 个 BiquadFilter + 2 个 GainNode（`stemGraph` 已有 hpf/lpf，可直接复用）。
- 收益：低频波动 4.1 dB → ~1.5 dB，**不需要分轨**。
- 交叉频率 120 Hz 可配；男声基频在 100–150 Hz，所以 120 Hz 是"低频"与"人声"的分界，需实测微调。

#### 层 B：频段换手（默认开，锚在小节线）

```
锚点：p 不再是"进度比例"，而是"第几小节"（barIndex / totalBars）

A（出曲）：
  bar 0        : LPF 20k, HPF 20, gain 0 dB
  bar 1        : LPF 8k,  HPF 40
  bar 2        : LPF 3k,  HPF 80
  最后 1 小节   : LPF 1.2k, HPF 200, gain -12 dB → 0

B（进曲）：
  bar 0        : HPF 8k, LPF 20k, gain -24 dB（只露高频"嘶"）
  bar 1        : HPF 2k, gain -12 dB
  bar 2        : HPF 300, gain -6 dB
  最后 1 小节   : HPF 20, gain 0 dB
```

与现有 `AM_*_POINTS` 的差别：**控制点数量不变，但横轴从 `p` 改成 `barIndex`**。这样 3 秒过渡和 30 秒过渡的"听感阶段"一致，不会出现"短过渡还没打开就结束"。

#### 层 C：人声 duck（可选，风险高时开）

```
触发：activity.vocal(A) > 0.5 且 activity.vocal(B) > 0.5 同时成立
动作：A 的 1.5–4 kHz 带阻，深度 -6 dB，attack 20 ms，release 80 ms
驱动：B 的 vocal 包络（不是固定时间表）
```

- 只用一个 BiquadFilter（peaking，Q=1.2），不需要分轨。
- 为什么不用分轨：旧进阶的 `vocals` 轨分离残差 −35 dB，但 `other` 轨仍含人声残留，实际"人声避让"效果被高估；用频段 duck 更稳、更便宜。

#### 层 D：echo out（可选，只在 `cut` 前用）

```
A → delay(1/4 拍, feedback 0.35, damp 3 kHz) → 主输出
在切点前 1 拍打开 send，切点后 1 拍关闭，干声同时静音
```

复用 `DeckStemBus` 的 `echoSend/delay/damp/feedback`（[stemGraph.ts:90-99](../web/src/audio/stemGraph.ts#L90-L99)），`setEchoTime()` 已有。

### 7.8 S5：质量门（离线预演，事前的，不是事后的）

每个候选 `MixScript` 在执行前跑一遍 100 ms 网格模拟：

```ts
function gate(script, aFeat, bFeat): GateResult {
  const bassBump = maxOverGrid(dB(sumLowPower(a, b)));       // 目标 ≤ 2.0 dB
  const vocalOverlap = overlapBeats(aFeat.activity.vocal, bFeat.activity.vocal);
  const loudnessDrift = maxOverGrid(|lufsMix(t) - targetLufs|); // 目标 ≤ 1.5 LU
  const rateJump = maxOverGrid(|d(rate)/dt|);                // 目标 ≤ 1.5%/拍
  return { pass: bassBump <= 2 && vocalOverlap <= 1 && loudnessDrift <= 1.5 && rateJump <= 1.5, ... };
}
```

不通过 → 按 §7.9 降级，**在决策阶段就降**，不在播放中临时改（旧进阶"播放中降级"是听感事故的主要来源）。

### 7.9 退化阶梯（决策时选）

| 档 | 条件 | 听感 |
|---|---|---|
| 1. `bridge + beatmix` | 有 loop 单元 / 可裁前奏，且 `|r-1| ≤ 0.15` | 最像 DJ |
| 2. `beatmix + filter` | 无 loop 单元，但 tempo 可对 | 像 DJ 的简单混音 |
| 3. `equal + filter` | tempo 不可对，但调性/能量可接受 | 比现在的等功率"有形状" |
| 4. `equal` | 一切分析缺失 | 现状 |
| 5. `cut` | 能量/调性差太多 | 硬切（留白比乱混好） |
| 6. `none` | 无拍/纯人声/古典 | 原样播放 |

### 7.10 与旧进阶的差异（保留/丢弃清单）

| 旧组件 | 处置 | 理由 |
|---|---|---|
| `transitionPlan.ts` 的纯函数架构 + `Compat` 打分 | **保留** | 架构是对的，只是决策空间小 |
| `downbeats` 锚定 + PLL | **保留** | 换手点精度是硬指标 |
| `stemGraph.ts` 的节点图 | **保留并扩展** | 分频、duck、echo 都能挂在上面 |
| `djMoves.ts` 的参数命名（gain/eqLow/hpf/lpf/delaySend） | **保留** | 新 DSP 层复用同一套参数语义 |
| 4 轨分离主路径 | **丢弃** | 成本高、playbackRate 变调、收益不对称 |
| 三档 `mixTransitionMode`（standard/advanced/advancedSafe） | **丢弃** | 改为 `automix | standard | off` 三档，语义是"策略"不是"引擎" |
| 固定小节模板（club32 等） | **降级为调试预设** | 产品默认走自动决策 |
| `other` 轨 | **丢弃** | 含人声残留，且无明确用途 |
| `playbackRate` 变速（变调） | **丢弃** | 新方案只用 `preservesPitch` 或预渲染 |

### 7.11 文件级改动清单

**宿主（C#）**

| 文件 | 改动 |
|---|---|
| [`src/Zilux2/Online/LocalMusicServer.cs`](../src/Zilux2/Online/LocalMusicServer.cs) | `/api/analysis` 响应加 `activity` / `momentaryLufs` / `phrases` / `loopUnits`；`analyzerVersion` 升 v2（缓存自动失效） |
| 分析器实现（`LocalMusicServer.cs` 内的分析段） | 在现有 FFT pass 里加三条曲线 + loop 单元打分；< 5% 耗时增量 |
| [`src/Zilux2/Stems/HtdemucsSession.cs`](../src/Zilux2/Stems/HtdemucsSession.cs) | 不再整首跑；只对 `loopUnits` 候选窗（8–15 s）按需跑，取 vocals 校正 |
| [`docs/zilux2-beat-analysis-contract.md`](zilux2-beat-analysis-contract.md) | 升 v2，新增字段表与算法说明 |

**前端（TS）**

| 文件 | 改动 |
|---|---|
| `web/src/core/automixPlan.ts` | **新增**：决策树 + `MixScript` 类型 + 阈值 |
| `web/src/core/arrangement.ts` | **新增**：乐句同余求解、loop 次数、B 偏移 |
| `web/src/core/qualityGate.ts` | **新增**：离线预演四项指标 |
| [`web/src/ui/transitionMath.ts`](../web/src/ui/transitionMath.ts) | 新增 `linearGains()`、`splitBands()`、`rateRamp()`；`naturalGains` 保留 |
| [`web/src/ui/crossfadeDeck.ts`](../web/src/ui/crossfadeDeck.ts) | `beginTimeline()` 接入 `MixScript`；`fadeStep()` 加 A 侧 bisect ramp、回正改小节量化；`buildAmTracks()` 改为"按小节锚定"；`resolveTransitionStyle()` 改为调用 `automixPlan` |
| [`web/src/audio/stemGraph.ts`](../web/src/audio/stemGraph.ts) | 每 deck 加 LR4 分频（low/high 两条 gain）；复用 `duck` 做层 C |
| `web/src/core/mixTransitionMode.ts` | 三档改两档（`automix` / `standard`），删 `advancedSafe` |
| `web/src/ui/automix.ts` | 更名（如 `queueOrder.ts`），避免与"过渡"混淆 |
| `web/src/core/__tests__/automixPlan.test.ts` | **新增**：fixture 覆盖 90/110/128/150 BPM、长短尾奏、无人声 intro、纯人声尾 |

### 7.12 WBS 与验收指标

**排期建议（这是旧进阶最大的教训）**：先做 **M1 + M2 的"离线验尸"**——只做分析与规划，不碰 DSP，拿 20–30 组真实曲目把 `MixScript` dump 出来，人工核对"选型 / 锚点 / loop 次数"是否合理，确认决策对了再进 M3/M4。旧进阶是"先做分轨 DSP，最后才发现决策空间是错的"，整条路径作废。

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **M1** S0 分析 v2 | activity / momentaryLufs / phrases / loopUnits | 人工标注 20 首：`bass` 曲线相关 > 0.8；`loopUnits` 召回 > 80%，误报 < 20% |
| **M2** S1+S2 规划 | 决策树 + 同余求解 + `MixScript` | 单测覆盖决策树全分支；20 对手工标注 pair 选型一致率 > 75% |
| **M3** S3 变速 | rate ramp + PLL + 不变调 | 换手点误差 < 5 ms；rate 二阶差分无跳变；spectral centroid 偏移 < 3% |
| **M4** S4 DSP | 分频等功率 + 频段换手 + duck + echo | 低频波动 ≤ 2 dB；人声重叠 ≤ 1 拍；无爆音（峰值 ≤ -0.3 dBFS） |
| **M5** S5 质量门 | 预演 + 降级 + 遥测 | 降级率 < 10%；播放中零临时降级；零静音/零崩溃 |
| **M6** UI/可解释 | "本次为什么这样混"面板 | 显示选型、锚点、loop 次数、变速幅度、门控结果 |

**回归基线（必须建立）**：选 30 首覆盖 90/100/128/140/150 BPM、有/无尾奏、有/无前奏、男声/女声/纯器乐，跑 A/B 盲听（至少 3 人），记录"像 DJ / 像淡出 / 听不出"三档。

### 7.13 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| `activity.vocal` 误判（失真吉他当成 vocal） | duck 误触发，声音变薄 | 只在高风险 pair 启用；阈值保守（0.5）；可一键关 |
| loop 单元检测错 | 重复出不自然的片段 | `maxLoopRepeats = 2`；要求能量方差低 + 无 vocal；失败降级 |
| ±15% 变速仍不够 | 部分 pair 混不了 | 超出即走 `bridge` 或 `fade`，不硬撑；配置项可开到 0.22 |
| 浏览器 `preservesPitch` 在 0.85× 以下音质差 | "水下感" | 变速下限 0.85；更低走预渲染或 fade |
| `barIndex` 锚定与 `tempoCurve` 冲突（变速歌） | 锚点漂移 | 用 `tempoCurveBpm` 的局部值算小节长；每小节重算 |
| 参数面板继续膨胀 | 用户不知道选什么 | 默认全自动；高级参数折叠；只暴露"自动/标准/关闭" |

### 7.14 三个可以今天下午就上的"快赢"

如果不想等 M1–M6，这三件事独立、低风险、立刻能听出差别：

1. **把 `style='am'` 的滤波曲线接进默认 `equal` 路径**（只改 `resolveTransitionStyle()` 的返回值 + `plan.am` 判定），时长比例换成小节比例。─ 半天。
2. **低频走 linear**：在 `scheduleNaturalFade` 旁加一条 120 Hz 分频，低频 gain 用 `1-p / p`。─ 一天，需要 `stemGraph` 加两个节点。
3. **`tempoRange` 默认从 0.08 提到 0.15**，并把超限时的 `cut` 改回 `equal + filter`（现在是直接放弃对拍）。─ 两小时，纯参数。

---

## 8. 附录

### 8.1 关键参数速查

| 参数 | 现值 | 位置 | 建议 |
|---|---|---|---|
| `TEMPO_RATE_MIN/MAX` | 0.88 / 1.12 | [crossfadeDeck.ts:185-186](../web/src/ui/crossfadeDeck.ts#L185-L186) | 0.85 / 1.15（可配到 0.78/1.22） |
| `MIN_FADE_MS / MAX_FADE_MS` | 1200 / 32000 | [crossfadeDeck.ts:171-176](../web/src/ui/crossfadeDeck.ts#L171-L176) | 保留 |
| `AUTO_BARS / MID / LONG` | 4 / 6 / 8 | [crossfadeDeck.ts:163-165](../web/src/ui/crossfadeDeck.ts#L163-L165) | 保留（结构桥接会覆盖） |
| `MATCHED_OVERLAP_END` | 0.82 | [transitionMath.ts:20](../web/src/ui/transitionMath.ts#L20) | 保留 |
| `AM_BASS_HANDOFF_P` | 0.75 | [crossfadeDeck.ts:1190](../web/src/ui/crossfadeDeck.ts#L1190) | 改为"第 2 小节线" |
| 低频分频点 | 无 | — | 120 Hz（LR4） |
| 人声 duck 频段 | 无 | — | 1.5–4 kHz，−6 dB，Q=1.2 |

### 8.2 参考链接

**Apple 官方**
- [Newsroom 2025-06-10：Apple services 秋季更新（AutoMix 首次公布）](https://www.apple.com/newsroom/2025/06/apple-services-deliver-powerful-features-and-intelligent-updates-to-users-this-fall/)
- [Apple Music 功能页](https://www.apple.com/apple-music/)
- [Support 105067：如何在 Apple Music 中使用 AutoMix 与 Crossfade](https://support.apple.com/en-us/105067)
- [iPhone 手册：过渡歌曲（iphadf2fe1f4）](https://support.apple.com/guide/iphone/transition-songs-iphadf2fe1f4/26/ios/26)
- [Music Understanding 框架文档](https://developer.apple.com/documentation/musicunderstanding)

**一手听感/评测**
- [9to5Mac 2026-07-16：iOS 27 让 AutoMix 更好（underwater / repeat intro·outro）](https://9to5mac.com/2026/07/16/ios-27-makes-one-of-my-favorite-apple-music-features-even-better/)
- [Lifehacker 2025-07-01：AutoMix 混合感受（0.75×/1.5×）](https://au.lifehacker.com/apple/114750/opinion/i-tried-apple-musics-new-dj-feature-and-i-have-mixed-feelings)
- [少数派 2025-07-08：AutoMix ≈ Beat Sync + Smart Fader](https://ios.sspai.com/post/100790)
- [BGR：AutoMix 是最该关掉的功能](https://www.bgr.com/2059450/how-to-turn-off-automix-apple-music-worst-feature/)
- [MusicTech：Apple 用 AI 做 time-stretch + beat-match](https://musictech.com/news/gear/apple-music-automix-ai/)

**专利（检索片段）**
- [US20110015767A1 / US20180005614A1 / US10235981B2：Intelligent crossfade with separated instrument tracks](https://patents.google.com/patent/US10235981B2/en)
- [US10002596B2（同族被引）](https://patents.google.com/patent/US10002596)
- [EP3196782A1：media content transitions（mix-in/mix-out、downbeat 对齐）](https://patents.google.com/patent/EP3196782A1/en)

**竞品**
- Spotify playlist mixing（用户可选 transition 预设与时长）
- djay Pro Automix（beat-match + Neural Mix 分轨）

### 8.3 术语

| 术语 | 含义 |
|---|---|
| beat matching | 把两首歌的拍点对齐（相位 + 速度） |
| time stretching | 变速不变调（WSOLA / phase vocoder） |
| bass swap | 低频交接：任何时刻只让一首歌拥有低频 |
| loop unit | 可循环的短段落（通常 4/8 小节，能量稳定、无新歌词） |
| 乐句同余 | 让 A 的让位点与 B 的入点落在同一乐句相位上 |
| `MixScript` | 本方案的可序列化过渡脚本（选型 + 锚点 + loop 次数 + 变速 + DSP 参数） |

---

*报告完。§7 的 M1–M6 是建议排期，不是承诺；§7.14 的三条快赢可以独立先做。*
