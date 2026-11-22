# Zilux2 音频理解与拆层设计 v2

> 基准：**"无感过渡"不是形容词，是九条可测条件。** 本文先把"无感"拆成客观指标，再倒推理解层必须提供什么特征、什么精度；最后定义"拆层"到底该拆到什么粒度。
> 上游：[zilux2-full-mix-engine.md](zilux2-full-mix-engine.md)（整体架构）、[zilux2-automix-vs-apple.md](zilux2-automix-vs-apple.md)（苹果原理）。
> 代码基线：`BeatAnalyzer.cs` 2537 行（`v1.1.103`），分析采样率 **22050 Hz 单声道**（[`TrackAudioDecoder.cs:28`](../src/Zilux2/Analysis/TrackAudioDecoder.cs#L28)），STFT 1024/512（[`BeatAnalyzer.cs:20-21`](../src/Zilux2/Analysis/BeatAnalyzer.cs#L20-L21)）。

---

## 0. "无感"的九条可测条件

人耳判定"这段过渡没痕迹"，实际是九个物理条件同时成立。任何一条破了，听感就会掉到"淡出"或"DJ 在混"。

| # | 条件 | 客观指标 | 门限 |
|---|---|---|---|
| 1 | **电平不断崖** | 过渡窗 200ms 步进的 LUFS 曲线，最大凹陷 | ≤ 1.5 LU，且无 >2 dB 的瞬时跌落 |
| 2 | **低频不叠** | 80–160 Hz 两路包络的相关系数；叠加峰值 | 相关 < 0.3；叠加 ≤ +2 dB |
| 3 | **人声不撞** | 两路 `activity.vocal > 0.5` 的重叠时长 | ≤ 1 拍 |
| 4 | **相位不抵消** | 交叉区两路互相关的最小值 | > −0.2，否则必须走分频规避 |
| 5 | **变速不可闻** | 速率曲线一阶差分 | ≤ 1.5 %/拍；无 8 度以上跳变 |
| 6 | **音色不突变** | 谱质心逐小节变化率 | ≤ 15 %/小节 |
| 7 | **无咔哒/爆音** | 样本间差分峰值；真峰值 | 无 >0.3 的阶跃；真峰值 ≤ −0.3 dBFS |
| 8 | **网格对齐** | 所有事件相对拍点误差 | ≤ 15 ms（1/16 拍 @120BPM） |
| 9 | **乐句完整** | 过渡起止相对乐句边界误差 | ≤ 1 拍；且不出现"半句" |

加一条**语义门控**（不算物理指标，但不满足就永远"有感"）：不该混的内容不混——纯 spoken word、古典/爵士现场、专辑顺序播放、只有 intro 的氛围曲。

**这套指标的价值**：它把"像不像苹果"变成 CI 里能跑的数字。任何改动，跑一遍离线预演就知道是变好还是变坏。

---

## 1. 从"无感"倒推理解层需求

| 无感条件 | 必须有的特征 | 精度要求 | 现状 |
|---|---|---|---|
| 1 电平 | 瞬时响度曲线（400ms/100ms） | ±0.5 LU | ❌ 只有整曲 LUFS |
| 2 低频 | 低频活动度曲线 + 分频能力 | 50 ms 分辨率 | ❌ 无 activity |
| 3 人声 | 人声活动度曲线 | 50 ms 分辨率，误报 <8% | ❌ 无 |
| 4 相位 | 两路互相关（离线可算） | 只需相对比较 | ⚠️ 有 `correlation.ts` 未接线 |
| 5 变速 | 局部 BPM 曲线 | ±0.3 BPM / 2 秒窗 | ✅ `tempoCurveMs` 已有 |
| 6 音色 | 谱质心 / rolloff / 平坦度 | 逐小节 | ❌ 无 |
| 7 咔哒 | 真峰值 + 样本级差分 | 4× 过采样 | ⚠️ 只有 peak |
| 8 对齐 | 拍网格 | 中位 ≤10 ms | ⚠️ DP 网格，复杂曲会漂 |
| 9 乐句 | `phrases[]` 区间 + downbeats | 边界 ≤1 拍 | ⚠️ 只有 `phraseStartsMs` |
| 语义 | sections + 内容类型判定 | 段落级 | ⚠️ 有 sections，无内容类型 |

**结论：九条里现在只有 2 条能满足（5、部分 8）。** 这不是"调参能解决"的问题，是缺三类信号：**活动度曲线、瞬时响度、区间化结构**。

---

## 2. 前端：一次 STFT，多路派生

现在的 `ComputeOnsets` 一次算完 flux + 三带能量 + chroma（[`BeatAnalyzer.cs:377`](../src/Zilux2/Analysis/BeatAnalyzer.cs#L377)），但每个新需求都在往这个函数里塞参数。**必须先重构成"特征前端 + 域分析器"两层**，否则加到第十个域就彻底不可维护。

### 2.1 采样率策略

| 用途 | 采样率 | 理由 |
|---|---|---|
| 音乐特征（拍/结构/调性/活动度/能量） | **22050 单声道**（沿用） | Nyquist 11 kHz 覆盖全部节奏与和声信息；4 分钟仅 21 MB |
| 真峰值 / 咔哒检测 | **原始 44.1/48 kHz** | 需要 4× 过采样，22050 会漏掉采样间峰值 |
| 响度（LUFS） | 22050 可算，但**建议 48k** | K-weighting 在 38 Hz 高通，22050 下低频精度下降 |

**结论**：解码时同时产出一路 22050 mono（分析）和一份 48k 立体声的峰值/响度统计（一遍扫描，不额外解码）。内存代价可控。

### 2.2 STFT 参数（保持与现有一致，避免缓存全废）

```
n_fft = 1024, hop = 512, Hann, @22050
→ 帧率 fps = 43.066，帧间隔 23.22 ms
→ 4 分钟 = 10330 帧
```

### 2.3 派生特征清单（一次遍历全部产出）

| 特征 | 维度 | 用途 |
|---|---|---|
| magnitude（分块，不常驻） | 513 bins × frame | 所有频域派生的中间量 |
| log-mel | 128 × frame | activity 模型输入 |
| chroma | 12 × frame | 调性、SSM、和声变化 |
| 三带能量（低/中/高） | 3 × frame | 现状已有 |
| SuperFlux onset（全带 + 三带） | 4 × frame | 拍跟踪（现状已有） |
| HPSS 谐波/打击分量能量比 | 2 × frame | drum/bass 代理 |
| 谱质心 / rolloff / 平坦度 | 3 × frame | 音色连续性（条件 6） |
| 子带包络（20–80/80–160/160–400/400–1500/1500–4000/4000–12000） | 6 × frame | 分频换手与 bass 监控 |

**内存纪律**：magnitude 用完即弃（分块 2048 帧）；常驻只有 log-mel(128×N float = 5.3 MB/4min)、chroma(0.5 MB) 与标量曲线。这是能不能在 8 秒内分析完 4 分钟曲的决定因素。

---

## 3. 九个域的规格

### 3.1 拍与强拍（条件 8 的地基）

**输入**：超通量 onset（三带加权）、低带重音包络。

**主算法（升级）**：可选 DBN（HMM + Viterbi），状态空间 `(bpm bucket × phase)`：

```
BPM 桶：60–190，步长 0.5 BPM（260 桶）
相位：每桶 24 个相位槽
转移：同桶 +1 帧概率 0.95；相邻桶 ±1 → 0.02；其余 0.001
观测：onset 强度在该相位的累积（log 域）
```

Viterbi 回溯得到逐帧"拍相位"，比 Ellis DP 稳定（DP 每帧独立选点，DBN 有全局平滑）。**成本**：260×24 状态 × 10330 帧 ≈ 6.4×10⁷ 次转移，C# 约 0.4 秒，可接受。

**若接 Beat This!**：模型输出 beat/downbeat 时间戳，与 DBN 的网格做一致性校验（相位一致率 ≥90%、BPM 差 <0.5），一致则采信模型，否则用 DBN。**两者都保留**，因为模型有极端曲目失败的可能。

**输出**：`beatsMs[]`、`downbeatsMs[]`、`bpm`、`bpmConfidence`、`tempoCurveMs/Bpm`（2 秒窗、中位 + 折叠）。

**验收**：人工标注 30 首，beat F1（±70ms）≥0.95，downbeat F1 ≥0.85。

### 3.2 小节与拍号

现有 `DetectMeter`（[`:1268`](../src/Zilux2/Analysis/BeatAnalyzer.cs#L1268)）用低音重音对比选 3/4 相位，对电子乐够用。**改进点**：把"每 4 拍强拍"的假设换成"候选相位 × 候选拍号"的联合打分，并把 `downbeats` 与 `phrases` 的边界做一致性约束（乐句起点必须是 downbeat）。

### 3.3 结构（SSM，本次必做）

**这是当前最大的短板**：`DetectPhrases`（[`:1752`](../src/Zilux2/Analysis/BeatAnalyzer.cs#L1752)）只有一维分带 novelty，看不出"A 段和 B 段是同一个副歌"。

**算法**：

```
1. 小节级特征：每小节对 chroma 取均值（12 维）+ 三带能量（3 维）+ 谱质心（1 维）
   → 16 维向量，按小节做 z-score
2. 相似矩阵：S[i][j] = cos(v_i, v_j)，尺寸 barCount × barCount
3. novelty：checkerboard 核（高斯窗，size=8 小节）沿对角线卷积
   novelty[k] = Σ_{i,j} K[i][j] · S[k+i][k+j]，K 为 ±1 的棋盘（左上/右下 +1，右上/左下 −1）
4. 峰值：局部极大 + 最小间隔 8 小节 + 自适应阈值 mean + 1.2·std
5. 边界细化：峰值附近 ±2 小节内找能量跃变最大处，再吸附到最近 downbeat
6. 段落标签：用 novelty 峰值切段后，按段内特征聚类（k=4~6），再按规则映射
   intro(首段且能量低) / verse(能量中、chroma 稳定) / chorus(能量高、重复出现)
   / drop(高能 + 低频占比高) / breakdown(能量骤降) / outro(末段且能量降)
   其中"重复出现"用段间 S 均值判定（>0.85 视为同一段）
```

**为什么不用模型**：SSM 的每个输出都能手算验证（"这两段相似度 0.91，所以是同一个副歌"），模型给不了这个；且 SSM 在 4 分钟曲目上只需 O(barCount²) ≈ 100² 次余弦，毫秒级。

**输出**：`sections[]{startMs,endMs,label,confidence}`、`phrases[]{startMs,endMs,bars}`。

**验收**：人工标注 30 首，边界误差 ≤1 小节的比例 ≥85%；段落标签与人工一致率 ≥70%。

### 3.4 乐句（区间语义）

契约从 `phraseStartsMs: number[]` 升级为 `phrases: {startMs,endMs,bars}[]`。

规则：段落边界 ∪ 4/8 小节网格 → 合并成 ≥4 小节的乐句；不足 4 小节的碎片并入相邻段。**乐句长度必须是 2 的幂小节**（4/8/16），否则乐句同余求解会退化成"随便找个点"。

### 3.5 调性时间线（条件：和声不打架）

现有 `DetectKey`（[`:233`](../src/Zilux2/Analysis/BeatAnalyzer.cs#L233)）全曲一个值，转调曲会错。

```
1. 每 2 小节计算一次 chroma 均值（12 维），L2 归一
2. 与 24 个调性轮廓（Krumhansl major/minor，12 个移调）算相关 → 24 维得分
3. Viterbi 平滑：状态 = 24 个调性，转移罚 = 3.0（换调），自环 = 0
4. 输出区间：连续同调性的 2 小节窗合并，长度 <8 小节的区间并入邻段
```

**输出**：`keyTimeline[]{startMs,endMs,key,mode}` + 全曲 `key`/`camelot`（取最长区间）。

**验收**：人工标注 20 首（含 5 首转调），主调正确率 ≥85%，转调点误差 ≤4 小节。

### 3.6 响度（条件 1）

按 EBU R128：

```
K-weighting：高通 38 Hz（2 阶）+ 高架 +4 dB @ 1.5 kHz
momentary：400 ms 窗 / 100 ms 步
short-term：3 s 窗 / 100 ms 步
integrated：门限 −70 LUFS 绝对、−10 LU 相对，对 400ms 块做门控平均
true peak：4× 过采样后取最大绝对值
```

现有 [`LoudnessMeter.cs`](../src/Zilux2/Analysis/LoudnessMeter.cs)（95 行）已实现 integrated + peak，**扩成三档即可**，不重写。

**输出**：`loudnessLufs`、`momentaryLufs[]`、`shortTermLufs[]`、`peakDb`、`truePeakDb`。

### 3.7 分乐器活动度（条件 2、3）

**默认走 A。** 路线 A 是一天的活、零模型依赖、可解释；它对 `bass`/`drum` 已经足够准（子带包络与通量是物理量），只有 `vocal` 在失真吉他/密集合成器上会误判。用两条保守策略兜住：

- VAD 交叉校验：`activity.vocal>0.5` 但 VAD 判无人声 → 按 0.2 处理（保守压低才安全，误压会变薄）。
- duck 只在"B 的 vocal 明确 >0.6 且持续 ≥120 ms"时触发，宁可少 duck 也不误 duck。

**路线 B（可选，不是必需）**：htdemucs 离线蒸馏一个 0.8 MB 的学生模型。注意它**只产曲线、不产波形**，也不进播放路径——教师的角色是"标注员"，不是"运行时组件"。如果你连离线跑 demucs 都不想要，跳过 B，整套系统仍然成立。

**路线 A 的做法（默认，1 天，免分轨）：**

| 曲线 | 算法 |
|---|---|
| `bass` | 20–150 Hz RMS 包络，除以全带 RMS（相对低频占比），再做 0.5 s 平滑 |
| `drum` | 打击分量（HPSS 的 percussive）在 40–200 Hz 的谱通量峰密度，200 ms 滑窗计数 |
| `vocal` | 300–3500 Hz 谐波能量占比 × (1 − 谱平坦度) × 4–8 kHz 齿音能量比，再用 VAD 校正 |
| `other` | 1 − max(bass, drum, vocal)，夹到 0…1 |

**路线 B 的做法（若做，8 人日，离线）：**

```
教师：htdemucs 4 轨（已有，src/Zilux2/Stems/HtdemucsSession.cs）
目标曲线：bass=低音轨 RMS 包络；drum=鼓轨通量峰密度；vocal=人声轨 300–3500Hz 能量包络
        （全部 50ms hop，0…1 归一，log 压缩后线性化）
学生：log-mel(128) → 3 层 Conv（64/128/128，kernel 3，dilated 1/2/4）→ 1×1 Conv → 4 通道 sigmoid
      参数量 ~180k，ONNX 约 0.8 MB
损失：MSE + 0.3·(1 − 相关系数)（相关系数项防止模型学成常数输出）
数据：300–500 首，按流派分层（电子/流行/摇滚/嘻哈/爵士/古典各 50+）
增广：随机增益 ±6 dB、倾斜 EQ ±3 dB、码率压缩（32/64/128 kbps）、加噪 SNR 20–40 dB
```

**为什么蒸馏而不是直接用 demucs**：播放期跑 demucs 是旧进阶的死因（5.29 MB/轨、变调、预热一次就降级）。蒸馏后 0.8 MB、CPU 单核实时、零变调。

**验收**：与 demucs 真值的逐帧相关系数 —— bass >0.90、drum >0.85、vocal >0.85；人声误报（真值<0.1 而预测>0.5）<8%。VAD 交叉校验：`activity.vocal>0.5` 但 VAD 判无人声的帧占比 <10%。

### 3.8 可重复单元（结构桥接的原料）

```
候选：SSM 对角线段（|i−j| ≥ 4 小节，段长 ≥4 小节，S 均值 >0.9）
打分（各项 0…1）：
  +0.30 长度（4–16 小节最佳）
  +0.25 能量方差低（段内 RMS 标准差 < 1.5 dB）
  +0.20 无 vocal（段内 activity.vocal 均值 <0.15）
  +0.15 chroma 稳定（段内 chroma 方差低）
  +0.10 边界在 downbeat 上
去重：同一区域只留最高分（IoU >0.5 视为重复）
分类：outro（末段）/ intro（首段）/ drop（高能 + 低频高）/ chorus（重复出现）
```

**输出**：`loopUnits[]{startMs,endMs,bars,kind,confidence}`（confidence <0.5 不进规划）。

**验收**：人工听 30 首，召回 ≥80%（人耳认为"可以循环"的段落被找到），误报（循环会有明显接缝）<20%。

### 3.9 音色曲线（条件 6）

`spectralCentroid[]`、`spectralRolloff[]`、`spectralFlatness[]`（逐帧），加 1 秒平滑。用途：过渡期若谱质心突变 >15%/小节，说明两首歌音色差太大，规划期就该改用更长的 fade 或加一层滤波过渡。

### 3.10 内容类型判定（语义门控）

用上面全部特征做一次轻量分类（不用模型，规则即可）：

```
spoken/audiobook：activity.vocal 高但 drum/bass 极低，且有长静音段
classical/jazz：bpmConfidence 低、tempoStability 低、drum 曲线稀疏
ambient：energy 方差低、无 drop、bass 持续但无脉冲
→ 命中任一 → gating 返回 none（不混）
```

---

## 4. "拆层"到底拆到什么粒度

**核心论点：拆层 ≠ 跑 demucs。** 你需要的是"可独立控制的层"，而不是"四轨波形"。三层足够覆盖 95% 的控制需求：

| 层 | 内容 | 实现 | 实时成本 |
|---|---|---|---|
| **L1 频段层** | 20–80 / 80–160 / 160–400 / 400–1.5k / 1.5–4k / 4–12k / 12k+ | LR4 分频（AudioWorklet） | 极低（几个双二阶） |
| **L2 语义层** | vocal / drum / bass / other | **曲线驱动**（duck、EQ、mute 由 activity 控制），不真分离 | 零（查表） |
| **L3 结构层** | loopUnits / sections / phrases | 区间语义 + 预渲染片段 | 零（离线） |

### 4.1 为什么 4 分轨路线必然失败

旧进阶的失败不是"实现不够好"，是**把不确定性放进了播放路径**。六个结构性原因，任何一个都足以致命：

| 原因 | 后果 | 能否靠工程修 |
|---|---|---|
| 分离不是无损分解（SDR ≈9 dB） | 4 轨相加 ≠ 原曲，混回去有残留与相位差 | 否，这是分离模型的物理上限 |
| 分离残差在低频最明显 | 换手后低频变薄/发虚——正是最该稳的地方 | 否 |
| 播放期 `playbackRate` 变速 | 变调，且与原轨相位不同步 | 能，但要上 WSOLA，成本翻倍 |
| 4 轨缓存 | 30 s 单窗 5.29 MB/轨，长过渡 4 倍膨胀 | 能，但内存换不回收益 |
| 预热只有一次机会 | 没热到就降级，听感不一致 | 能，但要预取调度，复杂度陡增 |
| `other` 含人声残留 | "人声避开"做不到干净 | 否，htdemucs 的已知局限 |

**结论：不修，弃用。播放路径里不出现任何分轨波形。**

### 4.2 零分轨的替代方案（能力不降级）

| 原本要分轨做的事 | 零分轨做法 | 代价 |
|---|---|---|
| 低频独占（bass swap） | **120 Hz 分频 + 线性交叉**（`a+b=1`），物理可逆、无残差 | 无 |
| 人声避让 | `activity.vocal` 曲线驱动 A 的 1.5–4 kHz duck | 曲线精度，不是波形精度 |
| bridge 拼桥 | **loopUnit 拼接**（同曲原始 PCM 首尾相接，不分离） | 只能用同曲素材 |
| doubleDrop 低频独占 | 两路低频互斥（A 的 low 在 B 进入时归零），加"低频归属"仲裁 | 需一条仲裁规则 |
| 手动"只留鼓" | 频段层 + 瞬态增强近似 | 效果打折，可接受 |

**关键**：上表五件事里，前四件（覆盖 95% 场景）**零分轨就能做，而且质量更好**——分频是无损的，分离是有损的。

### 4.3 真分离只保留两个离线场景

1. **生成 activity 训练标签**（离线、一次性，产出是曲线不是波形）；
2. **`bridge` 的极端兜底**（两首都找不到可用 loopUnit 时，才允许离线分离一段做桥）。

两者都不在播放路径上，失败也不影响播放——最坏情况是"这次不做 bridge"，而不是"过渡崩掉"。若完全不想碰分离，**只做 §3.7 路线 A 也能上线**，精度略低但链路更短。

---

## 5. 从理解到无感：参数映射

| 无感条件 | 用哪个特征 | 阈值 | 触发动作 |
|---|---|---|---|
| 1 电平 | `momentaryLufs` | 差 >1.5 LU | 规划期设 `gainTrimDb` |
| 2 低频 | `activity.bass` + 子带包络 | 两路同时 >0.4 | 强制低频换手（`handoffBars` 提前） |
| 3 人声 | `activity.vocal` | 重叠 >1 拍 | 移动 `bStart` 到下一乐句 |
| 4 相位 | 离线互相关 | < −0.2 | 改用分频交叉，不做整轨叠加 |
| 5 变速 | `tempoCurveBpm` | 需求 >0.15 | 降级到 `bridge`/`fade` |
| 6 音色 | `spectralCentroid` | 突变 >15%/小节 | 加长过渡或加滤波层 |
| 7 咔哒 | `truePeakDb` | > −0.3 dBFS | 规划期限幅 + 段间 5ms 淡化 |
| 8 对齐 | `beatsMs` | 误差 >15 ms | 拒绝该锚点，换下一个 |
| 9 乐句 | `phrases` | 边界 >1 拍 | 重解同余 |
| 语义 | 内容类型 | 命中 | `none`（不混） |

---

## 6. 性能预算

| 阶段 | 预算（4 分钟曲，4 核） |
|---|---|
| 解码 22050 mono + 48k 峰值扫描 | 1.2 s |
| STFT + 派生特征（一次遍历） | 2.0 s |
| DBN 拍跟踪 | 0.4 s |
| SSM + novelty | 0.1 s |
| 调性时间线 | 0.05 s |
| 响度三档 | 0.1 s |
| activity 模型（0.8 MB） | 0.8 s |
| loopUnits 打分 | 0.05 s |
| **合计** | **≈4.7 s**（目标 ≤8 s，含调度开销） |

**缓存**：SQLite 单库，键 `(fileHash, analyzerVersion)`；曲线统一降采样到 50 ms，单曲特征约 30–60 KB。

---

## 7. 落地顺序

| 步 | 内容 | 人日 | 出口 |
|---|---|---|---|
| **A** | 前端重构：`AudioFrontEnd.cs`（一次 STFT、多路派生、log-mel/HPSS/谱质心/子带），`BeatAnalyzer` 改为消费它 | 3 | 现有 231 个单测全绿；分析结果与旧版逐字段差异 <1% |
| **B** | SSM 结构 + `phrases` 区间 + 段落标签 | 3 | 30 首边界误差 ≤1 小节 ≥85% |
| **C** | 响度三档 + 真峰值（扩展现有 `LoudnessMeter`） | 1 | integrated 与 ffmpeg ebur128 差 <0.5 LU |
| **D** | 调性时间线（Viterbi） | 1.5 | 转调点误差 ≤4 小节 |
| **E** | activity 路线 A（DSP 代理） | 1 | 曲线平滑、可用于 duck 触发 |
| **F** | loopUnits（SSM 对角线段 + 打分） | 2 | 召回 ≥80%、误报 <20% |
| **G** | （可选）Beat This! ONNX + 双跑门控 | 2 | downbeat 中位误差 ≤10 ms |
| **H** | （可选）activity 蒸馏（Python 离线 + ONNX 学生） | 6 | 相关系数达 §3.7 指标 |
| **合计** | A–F 主干 | **11.5 人日** | 九条"无感"条件的输入全部就位 |

**A 必须先做**：它是所有后续域的地基，且能立刻验证"重构没有改变现有行为"（逐字段比对）。

---

## 8. 验收：每域一个数字

| 域 | 指标 | 门限 |
|---|---|---|
| 拍 | beat F1（±70ms） | ≥0.95 |
| 强拍 | downbeat F1 | ≥0.85 |
| 结构 | 边界 ≤1 小节比例 | ≥85% |
| 段落标签 | 与人工一致率 | ≥70% |
| 调性 | 主调正确率 / 转调点误差 | ≥85% / ≤4 小节 |
| 响度 | 与 ffmpeg ebur128 差 | <0.5 LU |
| activity | 与 demucs 逐帧相关 | bass >0.90，drum/vocal >0.85 |
| loopUnits | 召回 / 误报 | ≥80% / <20% |
| 语义门控 | 不该混的曲目拦截率 | ≥90% |

---

## 9. 文件结构（拆分 2537 行）

```
src/Zilux2/Analysis/
  AudioFrontEnd.cs        // 解码 → STFT → log-mel/chroma/HPSS/谱质心/子带（唯一 FFT 入口）
  BeatGrid.cs             // DBN + DP 双实现 + 一致性校验 + tempoCurve
  MeterDetector.cs        // 拍号 + downbeat 相位
  StructureSsm.cs         // SSM + novelty + 段落标签 + phrases
  KeyTimeline.cs          // chroma → 24 轮廓 → Viterbi
  ActivityCurves.cs       // 路线 A；路线 B 的学生模型推理
  LoopUnits.cs            // 候选 + 打分 + 去重
  LoudnessMeter.cs        // 扩展：integrated + momentary + shortTerm + truePeak
  ContentType.cs          // 语义门控
  BeatAnalyzer.cs         // 保留为编排器（调用上述模块，组装 payload）
```

`BeatAnalyzer` 从 2537 行降到约 300 行编排逻辑。这样每个域都能独立单测，也能独立替换成模型。

### 9.1 旧分轨资产退役清单

播放路径里凡是"拆轨"的代码，全部下线，不再接线：

| 文件 | 处置 |
|---|---|
| `web/src/core/stemsDeck.ts`（658） | 归档，不删除（读代码能看出当年为什么失败） |
| `web/src/core/stemSwap.ts`（271） | 归档 |
| `web/src/core/advancedTransition.ts`（150） | 归档 |
| `web/src/audio/stemPlayer.ts`（401）、`advancedSession.ts`（369）、`installAdvancedHandoff.ts`（339） | 归档 |
| `web/src/audio/stemGraph.ts`（458） | **部分保留**：`duck` / `echoSend` / `damp` / `feedback` 的节点接法搬到 `mixGraph.ts`，轨分离部分丢弃 |
| `web/src/core/djMoves.ts`（219） | **保留**：参数词汇表（gain/eqLow/eqMid/eqHigh/hpf/lpf/delaySend）直接复用 |
| `/api/stems*`（`LocalMusicServer.cs:295`、`StemSeparationService.cs`） | 保留为实验接口，`gating` 里标记为"不进过渡路径" |

**判断标准**：这个文件是否在**播放期**处理波形？是 → 下线；只是参数/曲线/节点设计 → 保留。

---

## 10. 风险

| 风险 | 影响 | 对策 |
|---|---|---|
| 重构 A 改变现有数值 | 缓存全废 + 回归失败 | 逐字段比对脚本，容差 1%，先跑 30 首 |
| SSM 在短曲（<90s）上退化成一段 | 结构无输出 | barCount <32 时跳过 SSM，用能量分段兜底 |
| activity 路线 A 在失真吉他上误判 vocal | duck 误触发 | VAD 交叉校验 + 阈值 0.5 |
| 蒸馏模型过拟合电子乐 | 摇滚/古典曲线失真 | 按流派分层采样，报告每流派的相关 |
| 22050 下真峰值不准 | 爆音漏检 | 真峰值走 48k 原始流 |
| DBN 状态数过大导致慢 | 分析超预算 | 先粗后细：1 BPM 桶 → 0.25 BPM 精化 |

---

## 附：一句话

**"无感" = 九条可测条件；九条条件里有七条卡在同一个地方——你缺的是"时间曲线"，不是"更好的算法"。** 先把前端做成一次 STFT 多路派生，再把 activity / momentary / phrases 三样曲线补齐，剩下的才是模型该解决的问题。
