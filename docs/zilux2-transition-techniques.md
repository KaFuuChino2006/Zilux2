# Zilux2 过渡手法技术目录（进阶混音 v2 · 多风格过渡库）

本文是 `web/src/core/automix/styleKit.ts` 的设计依据与人工复核手册。目标只有一个：把「世界级 DJ 在做什么」翻译成**可参数化、可判定、可退化**的决策，让自动混音不再只有一次 bass 换手。

阅读方式：

- 每个手法一节，固定八段：听感 → DSP 需要什么 → 参数区间 → 触发条件 → 禁用条件 → 失败退化 → 可叠加性 → 参考来源。
- 「DSP 需要什么」一栏只列**仓库里已经存在**的原语，不引入新节点；
- 参数区间的数字分两类：**文献值**（有出处的，标注来源编号）与**工程建议值**（我按采样率/节拍换算的，标注「建议」）。两者不混。
- 与代码的对应关系见 §19；按曲目类型的选型矩阵见 §20。

> 事实基准：本文写作时的曲速/小节换算是 `小节 = 4 × 60000 / BPM`，128 BPM 下 1 拍 = 468.75 ms、1 小节 = 1875 ms、16 小节 = 30 s。

---

## 0. 通用基准（所有手法共享的约束）

### 0.1 时间与乐句换算表

| BPM | 1 拍 | 1 小节 | 8 小节 | 16 小节 | 32 小节 |
| --- | --- | --- | --- | --- | --- |
| 85（hip-hop） | 705.9 ms | 2823.5 ms | 22.6 s | 45.2 s | 90.4 s |
| 100 | 600 ms | 2400 ms | 19.2 s | 38.4 s | 76.8 s |
| 120 | 500 ms | 2000 ms | 16.0 s | 32.0 s | 64.0 s |
| 128（house） | 468.8 ms | 1875 ms | 15.0 s | 30.0 s | 60.0 s |
| 140（trance） | 428.6 ms | 1714 ms | 13.7 s | 27.4 s | 54.9 s |
| 174（DnB） | 344.8 ms | 1379 ms | 11.0 s | 22.1 s | 44.1 s |

乐句（phrase）在流行/电子里几乎总是 8 或 16 小节的倍数，32 小节是「大段」[23]。**所有依赖乐句的手法，换手点必须落在 8 或 16 小节的顶部**，否则听众会觉得「提前了半句」却说不出为什么。

### 0.2 频段分工

| 段 | 频带 | 内容 | 备注 |
| --- | --- | --- | --- |
| low | < 250 Hz（能量主体 < 120 Hz） | kick、sub bass、bassline 基频 | Pioneer DJM 的 low 接近全 kill；不少控制器只到 −20…−26 dB [10] |
| mid | 250 Hz – 2.5 kHz | 人声、军鼓、和弦主体 | 两首可重叠 1–8 小节 |
| high | > 2.5 kHz | hats、air、齿音 | 最不值钱，也最容易掩盖冲突 |

唯一铁律：**任何时刻只有一条 bassline 在响**。两条同时响不是「更响」，而是相位抵消 + 糊 + 丢 headroom [10]。

### 0.3 调性距离（Camelot / Open Key）

编号 1–12 × A（minor，暗）/ B（major，亮），共 24 格 [5]。

| 距离 | 关系 | 可用性 |
| --- | --- | --- |
| 0 | 同码 | 最高分，任意长度重叠 |
| ±1 同字母 | 相邻调 | 干净，只微调色彩；职业 DJ 约 80% 时间在这一档 [5] |
| 同数字 A↔B | 关系大小调（共享 7 个音） | 完全不冲，只换重心，可用来提/降情绪；注意这不是同主音平行调 |
| 2 步 | 可听 | 只在 breakdown 里混，或把重叠压到 8 小节以内 |
| ≥3 步 | 视为 key clash | 只能靠快切 / breakdown / 效果 / 过渡曲桥接 |

调性只是一维：能量、质感（bright/airy vs dark/bass-heavy）、人声也参与判断。同调但质感差异大 → 长 blend「和谐但糊」，必须靠 EQ 切开 [5]。

### 0.4 过渡窗口的三重夹取（来自开源实现）

Mixxx AutoDJ 的时长逻辑值得直接抄，因为它把「过渡能吃多长」写成了显式约束 [18]：

```
fadeTime = min(fadeTime, A 剩余秒数)
fadeTime = min(fadeTime, B 剩余秒数 / 2)   // 淡入和淡出各占一半
```

加上「B 下一段 outro 起点不得早于过渡结束」，一共三重夹取。另外它的五种模式语义也很清晰：整前奏/尾奏对齐（`FullIntroOutro`，取 min(intro, outro)）、从尾奏起点开始淡（`FadeAtOutroStart`）、跳静音、整曲。默认过渡时长 `kTransitionPreferenceDefault = 10.0` 秒 [18]。

### 0.5 各家自动过渡的「时长怎么定」

| 软件 | 手段 | 选择的依据 | 时长怎么定 |
| --- | --- | --- | --- |
| djay Pro Automix | Fade / Filter / EQ / Echo / Dissolve / Neural Mix 等 | Transition 类型 × Duration × Tempo 模式三维矩阵 | 自动，或用户指定 **小节数或秒数** [16] |
| VirtualDJ Automix | Smart（结构感知）/ 各类 Fade / Fade out+Cut in / None | A 的 outro 与 B 的 intro 位置 | Smart 约 **4–8 s**；Fade 类用 `fadeLength` 秒数，负值 = 曲间加延迟 [17] |
| Mixxx AutoDJ | 纯音量淡入淡出 + 前奏尾奏对齐 | 五种 TransitionMode | 默认 10 s，受 §0.4 三重夹取 [18] |
| Traktor Cruise | 交叉淡化 | Preferences 里的 crossfade time | 固定值 [14] |
| rekordbox Auto Mix | 内置自动混音 | — | 预设 [14] |
| Serato Autoplay | **只加载并播放下一首，不自动混音** | — | 不适用 [14] |
| DJ.Studio Harmonize | 每对轨放一个过渡窗口 + 预设（crossfade / filter sweep / bass swap 等） | BPM + key 排序，Mood（大胆换调）或 Fuzzy（只走近关系调） | 窗口贴 beat grid，可手动拖 [14][15] |

对 Zilux2 的意义：**「时长」不该是一个全局常数，而应是「风格窗口 ∩ 结构窗口 ∩ 用户期望」的交集**。这也是 `styleKit` 里每种风格都带 `minFadeMs / maxFadeMs` 的原因。

### 0.6 变速容差

- 数字唱机/软件普遍把 ±10% 当作「听不出跑调」的边界（VirtualDJ 的「保持 BPM」模式就限定在 ±10% pitch 内 [17]）。
- Pioneer DDJ-FLX4/FLX2 的 Smart Fader 演示里，118 ↔ 125 BPM（≈5.9%）是推子全程渐变、无跳变的典型案例 [12]。
- 建议：**软限 6%**（渐进变速，听众接受度高）、**硬限 12%**（超过就只能靠 echo out / 硬切 / half-time 处理）。这两个值直接对应 `StyleContext.tempoSoftLimit / tempoHardLimit` 的默认值。

---

## 1. bass swap（低频换手）

**听感**：中高频先叠在一起，然后在一个 downbeat 上「鼓组换人」——低频瞬间由 A 变成 B，像落地。听众感知到的是一次干脆的重心转移，而不是一段渐变。

**DSP 需要什么**：`split`（`buildV2Plan` 的 `a.low` / `b.low` 两条互补曲线）+ `duck`（`buildDuckEvents` 在 B 的攻击点压 A 的人声）+ `tempo`（`tempoRate`/`tempoInverted` 让 A 贴 B）。

**参数区间**

| 参数 | 文献值 | 建议值（Zilux2） |
| --- | --- | --- |
| 重叠长度 | Tech House/Techno 16–32 小节；House 8–16 小节；Open Format/Hip-Hop/Pop 几小节或直接切 [10] | `bars` 8，窗口 6–24 s |
| 换手占比 `swapShare` | 「一把交换」= 瞬时 [10] | 0.25（把真换手压到最后 25%） |
| 换手曲线 | 求和恒为 1 的互补增益 | 沿用 `lowHandoffGain`（a=1−p, b=p） |
| 中高频重叠 | 1–8 小节 [10] | 与 `bars` 同步 |
| B 低频回到 | unity（12 点），**绝不推到 3 点** [10] | 1.0，不允许 > 0 |
| duck 深度 | — | −4 dB（`DUCK_MAX_DB = −6` 是上限） |

**触发条件**：BPM 差 ≤ 8%；有可用 downbeat；A 有尾奏或至少 8 小节可用尾巴；两首调性距离 ≤ 2（bass 音高会互相打架）。

**禁用条件**：BPM 差 > 8%（`tempoRange` 门控）；无 downbeat；keyGap ≥ 5 且能量差 ≥ 0.3（两条不同调的 bassline 轮转 = 持续走音）；A 的尾奏只剩不到 4 小节。

**失败退化**：换手点落不到 downbeat → 退化为 `longBlend`（把 `swapShare` 拉长到 0.5，让换手变成一段短渐变）；仍不对 → 退化为 `echoOut`（用尾巴盖住换手痕迹）。

**可叠加性**：可与 `duck`（人声让位）、`tailHold`（A 尾巴当垫）、`echo`（换手瞬间的补尾）叠加；**不可**与 `filterSweep` 同时主导（两套频谱塑形会互相抵消）。

**参考**：[10] greenhitz EQ swap 长文、[1] mixgraph 七种手法。

---

## 2. eqSwap（三段 EQ 分工交接）

**听感**：比 bass swap 细腻。B 的高频（hats）先探头，A 的中频（人声/和弦）最后退场，中间有一段「两首歌各让一半」的暧昧期。适合人声对唱、R&B、流行。

**DSP 需要什么**：`split`（low）+ `sweep`（mid/high 的交接用 `a.sweepLp` / `b.sweepHp` 表达）+ `duck` + `tempo`。

**参数区间**

| 参数 | 文献值 | 建议值 |
| --- | --- | --- |
| 重叠长度 | 8–16 小节（house 档）[10] | `bars` 12，窗口 8–32 s |
| 中频交接 | 一次乐句内完成 | `sweepShare` 0.4 |
| 低频交接点 | 仍在 downbeat | `swapShare` 0.15 |
| 高通起点 | 12 kHz（`V2_B_SWEEP_HP_MAX_HZ`） | 由 `buildV2Plan` 的 `sweep` 决定 |
| 低通终点 | 700 Hz（`V2_A_SWEEP_LP_MIN_HZ`） | 同上 |

**触发条件**：BPM 差 ≤ 8%；两首都有清晰的中频内容（人声或和弦）；调性距离 ≤ 2；A 有 ≥ 12 小节可用尾段。

**禁用条件**：两首都是密集人声（`DUAL_VOCAL_PENALTY` 直接 −10）；keyGap ≥ 5 且能量差大；拍号不同。

**失败退化**：中频交接撞车（两把人声咬在一起）→ 退化为 `bassSwap`（缩短中频重叠）或 `filterSweep`（用滤波把中频让开）。

**可叠加性**：与 `duck` 强绑定；可与 `reverb`（在 A 退场时补一点空间感）；不建议再叠 `echo`（尾巴会糊中频）。

**参考**：[10]、[1]。

---

## 3. filterSweep（双扫：A 低通收 / B 高通开）

**听感**：两首在交叉点各自「变薄」，共享同一段频谱，像雾散开又聚拢。A 先失去高频、再失去中频，最后只剩 kick 与 sub；B 反过来，低频最后才进来 [1]。

**DSP 需要什么**：`sweep`（`a.sweepLp` / `b.sweepHp` 两条对数扫描，`logSweep`）+ `tempo`。不需要 split（低频自然被低通带走）。

**参数区间**

| 参数 | 文献值 | 建议值 |
| --- | --- | --- |
| 时长 | 「4–8 小节就够」[1] | `bars` 4，窗口 4–16 s |
| A 低通 | 12 kHz → 700 Hz（`V2_A_SWEEP_LP_MIN_HZ`） | 对数扫描 |
| B 高通 | 20 Hz → 12 kHz（`V2_B_SWEEP_HP_MAX_HZ`） | 对数扫描 |
| 交叉点 | 两首等功率（`highEqualPowerGain` 的 cos/sin） | 中段 |
| BPM 容差 | 中等即可（两首都变薄，轻微漂移不显） | `tempoRange` 15 |

**触发条件**：能量差或质感差大（bright vs dark）；调性中等（2–4 步也能过）；BPM 差 ≤ 15%。

**禁用条件**：无 downbeat；BPM 差 > 15%；**低频本来就很空的曲目**（扫完只剩空气，会像断讯）；peak time 连续使用（听众会听见「技巧」而不是音乐 [1]）。

**失败退化**：扫过头变成「没声音」→ 抬高 A 低通的下限（700 Hz 以下仍有 kick）或缩短到 2 小节；与 B 的高通交叉点错位 → 改用 `bassSwap`。

**可叠加性**：**这是最适合叠加的手法**：可与 `echo`（A 扫尽时补尾）、`reverb`（B 进场前铺空间）、`duck` 同时用。不可与 `eqSwap` 同时主导。

**参考**：[1] mixgraph（filter sweep 段）、`V2_A_SWEEP_LP_MIN_HZ` / `V2_B_SWEEP_HP_MAX_HZ` 常量。

---

## 4. echoOut（回声收尾 / delay throw）

**听感**：A 的干声被抽走，只剩一串与拍同步的延迟尾巴在衰减，B 在尾巴下面进来。制造 1–2 小节的戏剧性留白 [1][9]。

**DSP 需要什么**：`echo`（`planEchoTail`：div/feedback/outDb/damp/tail）+ `tailHold`（`aTailHold` 把 A 尾巴当乐器留住）。

**参数区间**

| 参数 | 文献值 | 建议值 |
| --- | --- | --- |
| 拍值 `div` | 1/1、1/2、1/4 [9] | 0.5（1/2 拍）；hip-hop 用 0.25 |
| feedback | 40–60%（90% 会自激啸叫）[9] | ≤ 0.44（`echoTail` 同调上限） |
| dry/wet | 干声必须杀掉，湿声 ≥ 2/3 [9] | 干声 0 |
| 尾巴长度 | **1–2 小节** [9] | `tailMs` ≤ 1500（同调） |
| 触发点 | 乐句起点 / 强 downbeat [9] | 8/16 小节顶 |
| 尾部阻尼 | 高频先衰减，避免刺耳 | 4600 Hz（keyGap ≤1 档） |
| 曲风表 | House 122–128 → 1/2 或 1/1，fb 40–55%；Techno 128–138 → 1/1，55–70%；Hip-Hop 85–100 → 1/4 或 1/2，30–45%；DnB 170–175 → 1/2，40–55% [9] | 映射到 `div` + `feedback` |

**跨速要点（重要）**：延迟时值是按**当前曲的 BPM** 算的，切到不同 BPM 的 B 之后尾巴会和 B 的拍速漂移。修正办法是「故意把 FX 的 BPM 敲成 B 的 BPM」（Tap tempo），让尾巴锁在 B 的网格上；同时用计数法对齐——让 echo 重复 4 次、第 5 次进 B（正好 1 小节），更快的 echo 则数 8 次第 9 次进 [11]。`planEchoTail` 的 `divBeats` 应当按 **B 的 beatMs** 而不是 A 的来计算。

**触发条件**：A 没有干净尾奏 / 唱词一直唱 / 需要跨 BPM 或跨曲风 / 需要 1–2 小节张力；B 有干净入口（前奏或首句来得晚）。

**禁用条件**：B 无前奏且首句 < 1.5 s（尾巴下面没地方落脚）；peak time（泄气 [1]）；非拍点触发（尾巴离线 [9]）。

**失败退化**：feedback 过高 → 自激，立刻把 `feedback` 降到 0.3 并缩短 `tailMs`；尾巴与 B 不锁拍 → 退化为 `cut` 或 `slam`。

**可叠加性**：可与 `tailHold`、`reverb`（echo + reverb = 更长的尾）叠加；**触发前先把 A 的低频 EQ 降一点**，否则低频回响会糊 [9]。

**参考**：[9] greenhitz、[11] Digital DJ Tips「You're Doing The Echo Out Wrong」、[1]。

---

## 5. reverbOut（混响收尾）

**听感**：A 被推进一个大空间然后干声抽走，留一片弥散的尾音，B 在混响消散前进场。比 echo 更糊、更氛围，适合慢速与 breakdown。

**DSP 需要什么**：`reverb`（`scheduleAutomixV2Reverb`）+ `tailHold`。

**参数区间**

| 参数 | 建议值 | 说明 |
| --- | --- | --- |
| 送出量 | −6 dB（范围 −3…−12） | 超过 −3 dB 会盖住 B 的瞬态 |
| 尾巴 | 1–2 小节（2–8 s 窗口） | 与 echo 的差别是「没有拍点」 |
| 干声退场 | 在 1 拍内完成 | 拖长会像「音量坏了」 |
| 预延迟 | 20–40 ms | 保住 A 的最后一个字/鼓点 |

**触发条件**：曲速偏慢（≤ 120 BPM 效果最好）；A 的尾段是长音/和弦/pad；B 有干净入口；能量差中等。

**禁用条件**：快歌 + 密集鼓组（混响会把 kick 拖成一片）；B 无干净入口；A 的尾段本身已经在大量混响里（叠加 = 糊死）。

**失败退化**：混响尾巴盖住 B 的瞬态 → 把 `reverbSendDb` 降到 −10 dB 或改用 `echoOut`（有拍点更好躲）。

**可叠加性**：与 `echo` 可叠（先 echo 后 reverb，或用 reverb 只做尾巴的尾巴）；与 `sweep` 可叠。

**参考**：[1]、`scheduleAutomixV2Reverb` 的既有实现。

---

## 6. loopRoll（连滚 loop：1/2 → 1/4 → 1/8 拍）

**听感**：A 被切成越来越碎的节奏，机械张力逐级上升，然后在目标 downbeat 一次性释放。126 BPM 下 1 拍 = 0.48 s、1/2 拍 = 0.24 s、1/4 拍 = 0.12 s [2]。

**DSP 需要什么**：`bridge`（`buildBridgePlan` / `pickBridgeUnit` 提供 loop 单元）+ `tailHold`。

**参数区间**

| 参数 | 文献值 | 建议值 |
| --- | --- | --- |
| 单次总长 | **不超过 1 小节**，否则像唱片卡住 [2] | `bars` 1 |
| 递减序列 | 1 拍 → 1/2 → 1/4 [2] | 每级停留 1 拍或半拍 |
| 释放点 | 目标 downbeat [2] | 必须 |
| 使用频率 | 每场 ≤ 2 次 [2] | 建议在 session 内限流 |
| 依赖 | slip mode（底下继续走）[2] | `tileLoopChannels` 的无缝拼接（`BRIDGE_SEAM_MS = 2`） |

**触发条件**：A 有可用 loop 单元；有 downbeat；B 有干净入口；BPM 差 ≤ 25%。

**禁用条件**：A 无 loop 单元；无 downbeat；拍号不一致；B 无前奏且首句 < 1.5 s；**抒情/氛围段落**（会把气氛撕碎）。

**失败退化**：释放点错拍 → 立刻退回 1 小节 loop 再等下一个 downbeat；loop 拼接有爆音 → 增大 seam 或用 `cut`。

**可叠加性**：可与 `filterSweep`（一边滚一边关低通，最经典的 build）、`echo`（释放瞬间补尾）、`tailHold` 叠加。

**参考**：[2] mixgraph loop-roll 词条、[1] 的「loop and build」段。

---

## 7. backspin（回旋刹车 / brake）

**听感**：唱片被反向猛拉或受控减速，音高随速度下落——这个「下落」本身就是效果，是一次音乐性的休止 [8]。

**DSP 需要什么**：`cut`（`styleResolved === 'cut'` 的瞬断）+ `tailHold`（把减速尾巴留住）。**注意：真正的反向播放不是现有原语，这里只能做「减速 + 瞬断」的近似。**

**参数区间**

| 参数 | 文献值 | 建议值 |
| --- | --- | --- |
| 动作次数 | **一次果断动作**，不要多次小幅 [8] | 1 |
| 时长 | 1–2 拍（128 BPM 下 0.47–0.94 s） | 窗口 1.0–2.4 s |
| 结束点 | 必须落在 downbeat，且 B 已经在跑 [8] | 硬约束 |
| 减速曲线 | 线性或指数减速到 0 | 建议指数，尾段更自然 |
| BPM 容差 | 极大（本来就是「结束」） | `tempoRange` 60 |

**触发条件**：两曲 BPM 差太远、blend 无望；A 的尾段有明确的最后一拍；需要「响亮的一次收尾」。

**禁用条件**：无 downbeat；A 的尾段还在唱（减速会把唱词拖成怪声）；连续使用（第二首之后听众就知道你在偷懒）。

**失败退化**：减速听不出「下落」→ 退化为 `slam`（干脆一刀）；结束点错拍 → 用 `echoOut` 盖掉。

**可叠加性**：几乎不与其它手法叠加（它本身就是「结束」）。可以与 B 的 `introBridge` 配合：A 刹车的同时 B 的前奏已经在 loop。

**参考**：[8] mixgraph backspin 词条。

---

## 8. slam（砸切）

**听感**：强拍上一刀，A 瞬断、B 满编进入。没有重叠所以没有调性风险，代价是律动断裂 [1]。

**DSP 需要什么**：`cut`。

**参数区间**

| 参数 | 建议值 | 说明 |
| --- | --- | --- |
| 交叉窗口 | 1.0–1.5 s | 比真·0 ms 略长，避免爆音 |
| 落点 | downbeat（强拍） | 必须 |
| B 进入电平 | unity | 不允许淡入，淡入就不叫 slam 了 |

**触发条件**：BPM 差任意；调性冲突；B 有强辨识度的第一拍（riff / vocal shot）；需要「换场」。

**禁用条件**：无 downbeat；A 正在 breakdown 的悬停段（切断会像断电）；B 的第一拍是弱起（会听成「漏了一拍」）。

**失败退化**：爆音 → 加 20 ms 的等功率斜坡（仍在 1.5 s 窗口内）；听感太生硬 → 换成 `dropSwap`。

**可叠加性**：可与 `echo` 叠（切走 A 的同时让尾巴留 1 小节，柔化断层）；**这是所有系统的兜底**。

**参考**：[1] 的 cut 段（「干净的一刀永远好过混乱的拖长」）。

---

## 9. dropSwap（交换 drop）

**听感**：全场只听到一个 drop——A 的 drop 被 B 的 drop 顶替，能量不中断但素材换了 [6]。

**DSP 需要什么**：`cut`（在 drop 那一拍切）+ `bridge`（把 A 的乐句对齐到「两个 drop 本应重合」的位置）。

**参数区间**

| 参数 | 文献值 | 建议值 |
| --- | --- | --- |
| 误差 | 错一拍全场都听得出 [6] | 0 拍 |
| 前置对齐 | 两曲 phrase 对齐 | 8/16 小节 |
| 交叉窗口 | 瞬时 | 1.2–3.2 s（含切点前后各半小节） |
| BPM 容差 | 必须同速 | `tempoRange` 2 |
| 调性风险 | **为零**（无重叠）[6] | keyGap 不参与门控 |

**触发条件**：drop 是结构事件的曲风（bass music / big-room / trance）；两曲 phrase 可对齐；B 的 drop 有 hot cue 或可检测的段落边界；B 有可用的 drop 前奏（掉落前的 build）。

**禁用条件**：B 无前奏/无 drop 落点；渐变型音乐（没有可瞄准的单点）；BPM 差 > 2%。

**失败退化**：错拍 → 立刻回退到 A 的下一个 8 小节继续等；无 drop 结构 → 退化为 `cut`。

**可叠加性**：与 `slam` 是同一族（差别只是「瞄准 drop」）；可与 `echoOut` 叠（切走时留尾巴）。

**参考**：[6] mixgraph drop-swap 词条。

---

## 10. doubleDrop（双 drop）

**听感**：两个 drop 在同一小节同时落地，能量翻倍，低频加倍 [7]。

**DSP 需要什么**：`split`（低频必须在 drop **之前**换掉）+ `duck` + `tempo`。

**参数区间**

| 参数 | 文献值 | 建议值 |
| --- | --- | --- |
| 乐句误差 | 0 小节（可接受误差为 0）[7] | 0 |
| BPM | 必须同速 | `tempoRange` 0.5 |
| 调性 | 同调或至少能共存（手工编排的 7243 个过渡里 70.5% 调性合法）[7] | keyGap ≤ 1 |
| 编排密度 | 至少一首在 drop 处稀疏（两个密集编排相加 = 噪声）[7] | 需要能量/密度分析 |
| 低频换手 | **在 drop 之前**完成，不要在 drop 当中换 [7] | `swapShare` 0.3，早段完成 |
| 典型长度 | 32 小节 @174 BPM = 44.1 s [7] | 窗口 12–32 s（超出 32 s 则退化为「对齐前 32 小节」） |

**触发条件**：同速、同调、有 drop 结构、至少一首稀疏。

**禁用条件**：BPM 差 > 0.5%；keyGap ≥ 2；B 无前奏；两首都密集。

**失败退化**：低频叠成糊 → 退化为 `dropSwap`（只留一个 drop）；相位抵消导致整体变小声 → 加 `bassSwap` 的互补曲线。

**可叠加性**：本身就是「叠加」的极致；可与 `duck`（人声让位）叠，不宜再叠效果。

**参考**：[7] mixgraph double-drop 词条。

---

## 11. doubling（叠播加厚）

**听感**：同一首（或同源 loop）在两条 deck 上错开几拍叠放，鼓组变宽变狠；也可以半速叠全速做加厚。听感是「同一首歌突然变大」。

**DSP 需要什么**：`split` + `duck` + `bridge`（loop 单元）+ `tempo`。

**参数区间**

| 参数 | 建议值 | 说明 |
| --- | --- | --- |
| 错位量 | 0 拍（完全对齐 = 加厚）或 1/8–1/4 拍（轻微 phasing） | 0 拍时注意梳状滤波 |
| BPM 容差 | ≤ 1% | 两 deck 同曲，速率必须一致 |
| duck | −3 dB | 只压一点点，保住加厚的攻击 |
| 窗口 | 4–16 s | 太长会听出「同一首在重复」 |

**触发条件**：两 deck 同一首或同源；两边都有 loop 单元；BPM 完全一致。

**禁用条件**：loop 单元缺失；BPM 差 > 1%（会打架成「两个鼓手」）。

**失败退化**：梳状滤波导致低频忽大忽小 → 把其中一条的低频切掉（只叠中高频），或改用 `acapellaOverlay`。

**可叠加性**：可与 `halfTime`（半速叠全速）叠；与 `doubleDrop` 是天然组合。

**参考**：[1]、[7] 的加厚实践；DJ.Studio 的 stem 分层思路 [14]。

---

## 12. acapellaOverlay（清唱叠加）

**听感**：一首的清唱浮在另一首的器乐上，人声始终在最前。出片最像「编排过」。

**DSP 需要什么**：`duck`（人声让位，且这里的 duck 反向使用：压器乐）+ `bridge` / `introBridge`（补时）+ `tempo`。

**参数区间**

| 参数 | 文献值 | 建议值 |
| --- | --- | --- |
| 素材 | 30 s acapella 或副歌，放进采样槽当「第三 deck」[13] | 需要 beatgrid |
| 前提 | acapella 必须能锁拍（有正确 beatgrid）[13] | 硬约束 |
| 重叠长度 | 一整段（8/16 小节） | `bars` 16，窗口 8–32 s |
| duck 深度 | — | −6 dB（`DUCK_MAX_DB` 上限） |
| 调性 | 必须相容 | keyGap ≤ 2（长重叠最吃调性） |

> 注意：仓库是**零分轨**设计，没有 stem 分离。因此 `acapellaOverlay` 在这里只能表达为「已知某首是清唱/器乐版本，或用户显式指定人声素材」；不能凭空从混音里抠人声。

**触发条件**：A 是清唱/人声素材，或 B 是器乐版；有 beatgrid；调性相容；两边都有前奏/loop 可补时。

**禁用条件**：A 本身是器乐（无素材）；无 beatgrid；keyGap ≥ 5 且能量差大；两边都有强唱词（会变成两个人在唱）。

**失败退化**：锁不住拍 → 退化为 `cut`；调性冲突 → 把重叠压到 4 小节以内，或改用 `echoOut`。

**可叠加性**：与 `duck` 强绑定；可与 `halfTime`（半速器乐 + 全速清唱）、`keyLift` 叠。

**参考**：[13] Digital DJ Tips acapella 实践、[1]。

---

## 13. halfTime（半速 / 双速切换）

**听感**：同一首曲换一层速度呼吸，鼓组密度自然减半。常用于 set 中段换气，或 hip-hop ↔ drum & bass 的桥接。

**DSP 需要什么**：`tempo`（`tempoRate`/`tempoInverted`）+ `split`。

**参数区间**

| 参数 | 建议值 | 说明 |
| --- | --- | --- |
| BPM 比 | 必须是 2:1 或 1:2（±3%） | 否则不是 half-time，是跑调 |
| 变速曲线 | 在 1–2 小节内渐变 | 直接跳变会「咔」 |
| 移调补偿 | `planIntroBridge` 的 `semitones = base − 12·log2(rate)` | 变速不改音高时用 |
| 窗口 | 4–16 s | 太长会像卡带 |
| 落点 | downbeat | 必须 |

**触发条件**：两曲确实是 2:1 / 1:2 关系（如 87 ↔ 174、70 ↔ 140）；有 downbeat。

**禁用条件**：BPM 比不是 2:1；无 downbeat；A 的人声在变速区间内（音高会跟着变，除非做移调补偿）。

**失败退化**：变速听出「跑调」→ 加移调补偿，或改用 `bassSwap`（不变速，只换低频）。

**可叠加性**：与 `doubling`（半速叠全速）、`filterSweep` 叠。

**参考**：[4] mixgraph half-time vs double-time 词条、`introBridge` 的移调补偿实现。

---

## 14. keyLift（升调推进）

**听感**：过渡时把 B 抬 +1 半音（Camelot +1 步），落地即完成一次能量抬升——老派 harmonic set 的招牌动作。

**DSP 需要什么**：`bridge` / `introBridge`（在前奏 loop 里完成移调，避免在正拍上移）+ `tempo`。

**参数区间**

| 参数 | 建议值 | 说明 |
| --- | --- | --- |
| 移调量 | +1 半音（最多 +2） | +2 以上会明显「变声」 |
| 完成时机 | 在 B 的前奏/loop 内完成 | 正拍上移调会被听出来 |
| 窗口 | 3–12 s | 需要 `planIntroBridge` 的 2 小节最小 loop |
| BPM 容差 | ≤ 3% | 移调 + 变速同时做，误差会叠加 |

**触发条件**：B 有 ≥ 2 小节前奏可 loop；BPM 差 ≤ 3%；调性本来就 +1 时**不要再用**（会变 +2）。

**禁用条件**：无前奏可 loop；BPM 差 > 3%；B 一进来就是人声（移调会被人声暴露）。

**失败退化**：移调痕迹明显 → 退回 `longBlend`（同调长混）；无前奏 → 用 `echoOut` 争取时间。

**可叠加性**：与 `introBridge` 强绑定；可与 `filterSweep`（移调时把高频让开）叠。

**参考**：[22] Mixed In Key 的能量提升思路（原页 403，仅作概念引用）、[16] djay 的 key lock / 半音控制。

---

## 15. longBlend（长混音，16–32 小节）

**听感**：整段过渡只有一个 bass swap 交接点，其余时间两首在中高频共存，像一首曲自然长出了下一首 [1]。

**DSP 需要什么**：`split` + `sweep` + `duck` + `tempo`（四路全开）。

**参数区间**

| 参数 | 文献值 | 建议值 |
| --- | --- | --- |
| 长度 | 16–32 小节 [1] | 窗口 16–32 s（128 BPM 下 16 小节 = 30 s） |
| 低频 | B 先切掉，唯一交接点在 downbeat [1] | `swapShare` 0.5 |
| 中高频 | 两首共存 | `sweepShare` 0.35 |
| 调性 | 同码或 ±1 [1][5] | keyGap ≤ 1 |
| 能量 | 相近 | energyGap ≤ 0.2 |
| BPM 容差 | 同速或极小差 | `tempoRange` 6 |

**触发条件**：调性相容、能量接近、BPM 差 ≤ 6%、A 有完整尾奏。

**禁用条件**：两首都有强唱词；keyGap ≥ 5 且能量差大；32 小节的和声错位会「很痛」[1]；拍号不同。

**失败退化**：和声错位 → 缩短到 8 小节并加 `duck`；能量差大 → 改用 `filterSweep`。

**可叠加性**：可与 `duck`、`reverb`（尾段）、`echo`（最后 1 小节）叠。

**参考**：[1]、[5]。

---

## 16. cut（硬切）

**听感**：零重叠。A 音量瞬杀、B 从第一拍起。干净的一刀永远好过混乱的拖长 [1]。

**DSP 需要什么**：`cut`（`styleResolved === 'cut'`）。

**参数区间**

| 参数 | 建议值 | 说明 |
| --- | --- | --- |
| 交叉窗口 | 1.0 s（风格下限即上限） | 只是为了避免爆音 |
| BPM 容差 | 任意 | 无重叠 |
| 调性容差 | 任意 | 无重叠 |
| 落点 | downbeat 或强起句 | 不必严格 |

**触发条件**：BPM 差超硬限；调性冲突；拍号不同；能量断层；**所有门控都失败时的兜底**。

**禁用条件**：几乎没有。唯一的软禁忌是「催眠式律动段落」——切断会把听众从状态里拽出来 [1]。

**失败退化**：听众觉得「断了」→ 加 20 ms 等功率斜坡；仍不够 → 换成 `slam` 或 `echoOut`。

**可叠加性**：可与 `echo` / `reverb`（切走后留尾）叠。

**参考**：[1]。

---

## 17. 专业软件对照：它们各自在自动化什么

| 软件 | 自动化到什么程度 | 值得抄的地方 |
| --- | --- | --- |
| **djay Pro** | Transition 类型（Fade/Filter/EQ/Echo/Dissolve/Neural Mix…）× Duration（小节或秒）× Tempo 模式（Off/Sync/Sync+Tempo blend/Automatic） | **tempo blend 是渐变的**，不是跳变 [16] |
| **VirtualDJ** | Smart（结构感知，4–8 s）/ 各类 Fade / Fade out+Cut in / None；`autoMixBeatMatchOnFade` 只在 tempo 接近时才 beatmatch | 「跨速默认不 beatmatch」这个保守默认 [17] |
| **Mixxx** | 五种 TransitionMode，纯音量淡入淡出 | §0.4 的三重夹取公式 [18] |
| **Serato** | Flip（预录段落重排）、Autoplay（只播放不混音） | Flip 的「把段落变成可重排单元」思路 [19] |
| **Traktor** | Cruise mode（固定 crossfade time）、Remix Deck、Auto Grid | Remix Deck 的「把 loop 当素材」思路 [20] |
| **rekordbox** | Auto Mix、Traffic Light（浏览时的调性提示，不发重排） | Traffic Light 只提示、不决策 [21] |
| **Ableton Live** | clip 的 launch quantize + follow action（本质是「乐句对齐 + 自动推进」） | 量化到 1/16…1 bar 的显式参数 |
| **DJ.Studio** | 每对轨一个过渡窗口，volume/EQ/HPF/LPF/loop/FX 全可自动化；Harmonize 按 BPM+key 排序，Mood/Fuzzy 两种调性策略 | **把过渡拆成一组可复用预设** + 可锁定 [14][15] |

共同结论：

1. **没有一家用「一种过渡」打天下**。djay 有 7+ 种、VDJ 有 6 种、DJ.Studio 有 4 个预设 + 全自动化。
2. **时长都是「窗口 + 夹取」，不是常数**。
3. **调性只在长重叠时才真正介入**：短切类手法一律把 keyGap 权重压低（这也是 `KEY_WEIGHT` 表的原因）。
4. **退化路径必须是显式的**：干净的一刀 > 混乱的 blend [1]。

---

## 18. 哪些「人类名场面」不可自动化

James Hype 的多 deck 剪切、A-Trak 的 scratch 段、Jazzy Jeff 的 transformer、DJ Craze 的 DMC 三连冠套路，共同点是**手臂动作本身是内容**：scratch 的 fader 节奏、backspin 的手感、cue 点的即兴重排。这些无法用「参数曲线」表达，只能做近似：

| 名场面 | 可自动化的部分 | 不可自动化的部分 |
| --- | --- | --- |
| 快速剪切（James Hype 式） | 在 1/4 拍网格上的 `cut` 序列 | 手感、呼吸、与观众的互动 |
| scratch / transformer | 无（需要 fader 级时间分辨率） | 全部 |
| backspin | 减速曲线 + downbeat 落点 | 手上的力度与松手时机 |
| cue 点重排 | 用 loop 单元做 `bridge` | 即兴选段 |
| 双 drop | 对齐 + 低频换手 | 现场判断「这两首能不能叠」 |

因此 `styleKit` 的定位是：**把「能参数化的 80%」做成可靠的默认值，把「不能参数化的 20%」留给手动覆盖**。

---

## 19. 与 `styleKit.ts` 的对应关系

### 19.1 打分公式

```
score = BASE[id]
      + BPM 项      （齐平 +14；软限内线性 0…+14；超软限 −18；超硬限 −30；halfTime 命中 2:1 则 +24）
      + 调性项      （同调 +10·w；相邻 +7·w；2 步 +2·w；3–4 步 −8·w；≥5 步 −18·w）
      + 能量项      （差 ≤0.15 +8；0.15–0.35 +3；≥0.35 则加该风格的 ENERGY_GAP_REWARD，长混类记 0）
      + 唱词项      （双唱词按 DUAL_VOCAL_PENALTY 扣分；acapellaOverlay 遇器乐 A 再 −12）
      + 结构项      （bridge+loop 单元 +8；loopRoll 的 B loop +4；ENTRY 类遇 B 前奏 +8；
                     longBlend/bassSwap/eqSwap 遇 A 尾奏 +6；乐句类遇 downbeat +6；器乐 A +4）
      + 时长项      （落在窗口 +6；短于下限 −6；超出上限 −10）
```

- `w = KEY_WEIGHT[id]`：长重叠 1.0、bass 类 0.8、滤波类 0.5、硬切/尾巴类 0.2。
- 分数四舍五入到 0.1；排序稳定：同分按 `STYLE_CATALOG` 顺序。
- 每条加减分都会写进 `reasons`，例如「BPM 差 12.4% 超过软限 6%，−18」。

### 19.2 硬门控清单（按优先级）

| # | 条件 | 被挡的风格 | 理由模板 |
| --- | --- | --- | --- |
| 1 | BPM 差 > `tempoHardLimit` | 除 cut/slam/backspin/echoOut/reverbOut/halfTime 外全部 | `BPM 差 x% 超过硬限 y%` |
| 2 | BPM 差 > 该风格 `tempoRange` | 按风格细分（longBlend 6%、bassSwap 8%、doubleDrop 0.5%…） | `BPM 差 x% 超过该风格的 tempoRange y%` |
| 3 | 无 downbeat | 除 cut/slam 外全部 | `未检测到 downbeat 网格` |
| 4 | 拍号不一致 | 乐句类（longBlend/bassSwap/eqSwap/loopRoll/dropSwap/doubleDrop/doubling/acapellaOverlay/halfTime/keyLift） | `拍号不一致（4/4 对 3/4）` |
| 5 | B 无前奏 且 首句 < 1500 ms | echoOut/reverbOut/loopRoll/doubleDrop/dropSwap | `B 无前奏且首句人声 xms < 1500ms` |
| 6 | B 无前奏 | dropSwap/doubleDrop | `找不到可瞄准的 drop 落点` |
| 7 | keyGap ≥ 5 且 energyGap ≥ 0.3 | longBlend/acapellaOverlay/doubling/eqSwap/bassSwap | `长重叠会和声撞车` |
| 8 | A 无 loop 单元 | loopRoll | `A 没有可用 loop 单元` |
| 9 | 任一 deck 无 loop 单元 | doubling | `叠播需要两条 deck 都有 loop 单元` |
| 10 | BPM 比不是 2:1 / 1:2 | halfTime | `不是 2:1 / 1:2 关系` |
| 11 | A 是器乐 | acapellaOverlay | `没有可叠加的清唱素材` |

### 19.3 风格 → 原语映射表（Lead 接线用）

| 风格 | 原语 | 具体入口 |
| --- | --- | --- |
| longBlend | split + sweep + duck + tempo | `buildV2Plan`（swapShare 0.5 / sweep 0.35）+ `buildDuckEvents` + `tempoRate` |
| bassSwap | split + duck + tempo | `buildV2Plan`（swapShare 0.25，`aTailHold` 可选）+ `buildDuckEvents` |
| eqSwap | split + sweep + duck + tempo | `buildV2Plan`（sweep 0.4 / swap 0.15）+ `buildDuckEvents` |
| filterSweep | sweep + tempo | `buildV2Plan`（`sweep: true`，`sweepStartP/sweepEndP`） |
| echoOut | echo + tailHold | `planEchoTail`（div 0.5）+ `aTailHold`/`aTailBleedMs` |
| reverbOut | reverb + tailHold | `scheduleAutomixV2Reverb`（−6 dB）+ `aTailHold` |
| loopRoll | bridge + tailHold | `pickBridgeUnit` → `buildBridgePlan`（1 小节单元）+ `tileLoopChannels` |
| backspin | cut + tailHold | 减速曲线（引擎侧）+ `styleResolved === 'cut'` |
| slam | cut | `styleResolved === 'cut'`（1.0–1.5 s 斜坡） |
| dropSwap | cut + bridge | `buildBridgePlan` 对齐乐句 + `cut` |
| doubleDrop | split + duck + tempo | `buildV2Plan`（低频在 drop 前换完）+ `buildDuckEvents` |
| doubling | split + duck + bridge + tempo | `buildV2Plan` + `buildDuckEvents` + `tileLoopChannels` |
| acapellaOverlay | duck + bridge + introBridge + tempo | `buildDuckEvents`（器乐反向让位）+ `planIntroBridge` |
| halfTime | tempo + split | `tempoRate`/`tempoInverted` + `planIntroBridge` 的 `semitones` 补偿 |
| keyLift | bridge + introBridge + tempo | `planIntroBridge`（`keyFrom/keyTo` → `semitones`） |
| cut | cut | `styleResolved === 'cut'` |

---

## 20. 按曲目类型选型矩阵

「首选」= 默认应当排第一的；「可用」= 条件合适时可用；「避」= 该曲风下大概率翻车。

| 曲目类型 | 首选 | 可用 | 避 | 说明 |
| --- | --- | --- | --- | --- |
| **流行 / Pop** | bassSwap、eqSwap | longBlend（调性近时）、echoOut、cut | loopRoll（会毁掉副歌）、doubleDrop | 人声主导，8 小节副歌结构；双唱词必须 duck；重叠别超过 8 小节 |
| **电子 / House / Techno** | longBlend、bassSwap | filterSweep、loopRoll、doubling、doubleDrop（DnB/dubstep） | backspin（太「表演」） | 16–32 小节长混是常态；低频唯一铁律最严格；loop+build 冲高峰 |
| **嘻哈 / Hip-Hop** | echoOut（1/4 拍）、slam | cut、dropSwap、backspin | longBlend（调性通常不合）、filterSweep | 85–100 BPM，人声密集，快速切换；echo 用短拍值 [9] |
| **R&B / Soul** | eqSwap、reverbOut | bassSwap、longBlend（同调时） | slam、loopRoll | 人声与和声是主体；混响收尾比硬切体面；调性距离尽量 ≤1 |
| **摇滚 / Rock** | cut、slam | bassSwap（鼓组相近时）、echoOut | longBlend、doubling | 真鼓组的微时序差异会让长混听起来「两个鼓手」；结构以段落切换为主 |
| **器乐 / Instrumental** | filterSweep、longBlend | doubling、halfTime、keyLift | acapellaOverlay（无素材） | 调性与质感的权重最高；没有人声兜底，任何冲突都听得见 |
| **古典 / Classical** | cut（分段处） | longBlend（极短、4 小节以内）、reverbOut | bassSwap、loopRoll、doubleDrop、backspin | 无鼓组、无 downbeat、速度自由；只能用极短交叉或干脆切断；混响收尾最自然 |
| **Spoken / 播客 / 电台** | cut（或 VDJ 式 Fade out+Cut in） | reverbOut（短尾） | 所有节奏类 | 无人声对齐需求，B 从全音量直入最清楚 [17]；不要 loop、不要 filter |

补充规则：

- **有唱词 × 有唱词** → 一律压缩重叠（≤ 8 小节）并开 duck；两首都唱时 `longBlend` 扣 16 分是有意的。
- **无前奏的 B** → 优先 `cut` / `slam` / `echoOut`（若首句够晚），不要硬拖。
- **拍号不同（4/4 vs 3/4）** → 直接 `cut`，所有乐句类门控自动生效。
- **能量断层（energyGap ≥ 0.35）** → `filterSweep` / `echoOut` / `loopRoll` 是「把断层变成设计」的手法；`longBlend` 会被拉平。

---

## 21. 参考来源

1. mixgraph — *DJ Transition Techniques: 7 Ways to Mix Between Tracks* — https://www.mixgraph.io/mixing-guide/transitions
2. mixgraph — *Loop Roll*（126 BPM 下的实时长度、1 小节上限、每场 ≤2 次）— https://www.mixgraph.io/glossary/loop-roll
3. mixgraph — *Phrase Match* — https://www.mixgraph.io/glossary/phrase-match
4. mixgraph — *Half Time vs Double Time* — https://www.mixgraph.io/glossary/half-time-vs-double-time
5. mixgraph — *Camelot Wheel Guide* — https://www.mixgraph.io/learn/camelot-wheel-guide
6. mixgraph — *Drop Swap* — https://www.mixgraph.io/glossary/drop-swap
7. mixgraph — *Double Drop*（0 小节误差、低频须在 drop 前换、70.5% 调性合法）— https://www.mixgraph.io/glossary/double-drop
8. mixgraph — *Backspin* — https://www.mixgraph.io/glossary/backspin
9. greenhitz — *Echo Out Transition*（拍值/feedback/干湿比/曲风表）— https://greenhitz.com/blog/echo-out-transition-end-track-cleanly
10. greenhitz — *EQ Swap*（频段定义、唯一铁律、重叠时长分档、unity 回归）— https://greenhitz.com/blog/eq-swap-basslines-cleanly-mixing
11. Digital DJ Tips — *You're Doing The Echo Out Wrong*（跨速锁拍修正、4 次/8 次计数法）— https://www.digitaldjtips.com/echo-out-any-bpm/
12. Digital DJ Tips — *What the FLX4/FLX2's Smart Fader button does*（118↔125 BPM 渐变、bass+echo 联动）— https://www.digitaldjtips.com/what-the-flx4-flx2s-smart-fader-button-does/
13. Digital DJ Tips — *Mix acapellas on a two-deck controller*（beatgrid 前提、采样槽第三 deck）— https://www.digitaldjtips.com/mix-acapellas-two-deck-controller/
14. DJ.Studio — *DJ Transitions*（预设种类、Harmonize、Mood/Fuzzy、竞品对照）— https://dj.studio/transitions
15. DJ.Studio Help — *Automation Editor and Effect blocks*（volume/low/mid/high/HPF/LPF/loop 五类曲线、effect blocks ≤5）— https://help.dj.studio/en/articles/8213331-automation-editor-and-effect-blocks
16. Algoriddim djay Pro — Automix 设置（Transition 类型 / Duration 小节或秒 / Tempo 四档）— https://www.algoriddim.com/djay-pro
17. VirtualDJ 手册 — Automix（Smart 4–8 s、fadeLength、autoMixBeatMatchOnFade、±10% pitch 限制）— https://www.virtualdj.com/manuals/virtualdj/automix/index.html
18. Mixxx 源码 — `src/library/autodj/autodjprocessor.cpp`（五种 TransitionMode、默认 10 s、三重夹取）— https://github.com/mixxxdj/mixxx/blob/main/src/library/autodj/autodjprocessor.cpp
19. Serato — *Pro tips on Flips* — https://serato.com/latest/blog/17521/pro-tips-on-flips
20. Native Instruments — *Traktor Pro Manual: Advanced operation*（Cruise mode / Remix Deck）— https://www.native-instruments.com/ni-tech-manuals/traktor-pro-manual/en/advanced-operation-of-traktor
21. Pioneer DJ Support — *Traffic Light 的 key 范围设置* — https://support.pioneerdj.com/hc/en-us/articles/8113187558553
22. Mixed In Key — *Energy Boost DJ mixing tutorial*（+1 半音 = Camelot +1 步；原页 403，仅作概念引用）— https://mixedinkey.com/harmonic-mixing-guide/energy-boost-dj-mixing-tutorial/
23. mixgraph — *Phrase*（8/16/32 小节结构）— https://www.mixgraph.io/glossary/phrase
