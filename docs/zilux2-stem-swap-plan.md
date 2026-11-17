# Zilux2 stems 改造调研与方向（先调研，后动手）

> 目的：回答三件事——
> 1. DJUCED 的分离/流式为什么"感觉更好"？
> 2. Zilux2 现在差在哪（有代码证据）？
> 3. 要做"抽掉一轨换一轨"的智能过渡，改哪里、分几期、风险是什么？
>
> 本文只做调研与方案，不含已落地代码；反向工程证据见 `djuced_re/DJUCED_6.8.1_STEMS_逆向报告.md`。

---

## 1. 结论先行

| 维度 | DJUCED 6.8.1（zplane Stems Pro） | Zilux2 现状（HTDemucs ONNX） |
|---|---|---|
| 分离质量 | 中上（实时模型的典型水平） | **不差，甚至更好**（离线大模型） |
| 轨数 | 4：人声/旋律/低音/鼓乐 | 模型出 4 轨，**只用了 2 轨**（vocals/inst） |
| 延迟 | 加载即出垫，播放中开关无等待 | 首次 30 s 窗约 **6.9–7.3 s**，期间只能 EQ 兜底 |
| 资源 | ≈0.81 核 CPU、无磁盘缓存、整机 2.8 GB | 峰值工作集 **2877 MB**、4.07× 实时 |
| 过渡 | 每轨可单独 kill（鼓/贝斯/旋律/人声互换） | 整轨等功率交叉（`naturalGains`）→ 低频叠加 |

**关键判断：你感觉"他的模型更优秀"，主因不是模型，而是链路**——
他把 4 轨做成**流式常驻音源**，所以能"抽一轨换一轨"；你把 htdemucs 做成**整窗离线**，所以只能整轨渐变。
模型质量上 htdemucs 反而更强，问题在**颗粒度（2 轨 vs 4 轨）**与**时序（离线窗 vs 流式）**。

---

## 2. 证据

### 2.1 DJUCED 侧（已逆向确认）

- 分离算法本地跑，非云端：`NNPredictionDispatcher_fd.dll` / `_on.dll`，源码路径串 `StemsProAlgorithm.cpp`、`OverlapAddStep.h`、`Hopping.h`、`Resample\...\Resampler.cpp`、`Fft.cpp`。
- 4 轨语义由 UI 直接给出：`人声 / 旋律 / 低音 / 鼓乐`（截图 `djuced_re/shot_stems.png`）。
- 控制面：`StemsManager`、`createStemManager`、`sendStemReady/Position`、`stems_intraop_threads`（默认 2）、`instant_stems`、`use_control_to_stems`。
- 运行实测（本机，未激活）：载入即出四垫；播放中点垫立即生效（红→亮）；进程内已加载两个 NNPrediction DLL；`Documents\DJUCED\cache` **无新增文件** ⇒ 分离结果只在内存、边播边算。
- 资源实测：播放+分离 ≈0.81 核、68 线程、WorkingSet ≈2844 MB（整机含 411 MB 内嵌资源）。
- 四垫语义实测（环回录音，探针为平稳多频信号）：点垫 = 把该轨从混音里**切除/恢复**，不是 solo；四轨频带响应互不重叠（人声 → 低频段消失、低音 → low 段升 18.8% 等）。

> 推论：DJUCED 是"小模型 + 小 hop + 重叠相加"的**真流式**，权重极小（`NNPredictionDispatcher_fd.dll` 仅 1.6 MB），所以能在 0.8 核里跑住，并允许随时 kill 任一轨。

### 2.2 Zilux2 侧（代码证据）

| 事实 | 位置 |
|---|---|
| 段长 343,980 样本（7.8 s）、30 s 窗、44.1 kHz | `src/Zilux2/Stems/StemsModels.cs:15-24` |
| 模型输出本就是 `(1,4,2,segment)`，vocals 在槽位 3 | `src/Zilux2/Stems/HtdemucsSession.cs:53-54`、`:245` |
| 只写 `wNNN.vocals.wav` + `wNNN.inst.wav`（inst = mix − vocals） | `src/Zilux2/Stems/StemSeparationService.cs:302-305` |
| 25% 重叠三角窗 OLA、stride = segment − segment/4 | `HtdemucsSession.cs`（`OverlapRatio = 0.25f`） |
| 前端整窗取 WAV → decodeAudioData → 排 30 s | `web/src/core/stemsClient.ts:112-146` |
| 分离支路接管时元素支路静音 | `web/src/core/stemsDeck.ts:1-16` |
| 过渡 = 整轨等功率 `cos/sin` | `web/src/ui/transitionMath.ts:13-17` |
| 实测：278.96 s 音频 48 段 68.51 s（4.07× 实时）、峰值 2877 MB、单窗 6.9–7.3 s | `research/folia-stems-plan.md` |
| 3 轨（drums/bass/vocals，丢 other），segment 由 `inputShape(0)[2]` 取 | `research/qa/folia-asar/electron/analysis/htdemucs.cjs:16-18` |

### 2.3 为什么"等功率渐入"听起来不对

等功率交叉 `A=cos θ, B=sin θ` 假设两路**不相关**：功率和恒为 1。
但低频（kick/bass）在舞曲里高度**相关**（同拍、同调），两轨同时存在时幅度相加：

```
p = 0.5 时  A = B = 0.707  →  相关低频 ≈ 0.707 + 0.707 = 1.414  (+3 dB)
```

听感就是：过渡中段低频突然变厚、变糊，人声也叠成两个人。
DJ 的做法不是"整轨等功率"，而是**分轨换手**：同一时刻只让一轨的低频存在（bass swap），
其余轨按小节错开，所以功率恒定、频带不打架。

---

## 3. 目标形态（你要的"抽掉别的换成别的"）

一次 16 小节过渡的理想时间线（可配置）：

```
bar:      0    2    4    6    8   10   12   14   16
bass   A ████████▓▒░░│                                (0–2 小节换手，窄，避免低频叠加)
drums  A ██████████████▓▒░░│                          (4–6 小节，落在 drop/break)
other  A ████████████████████▓▒░░│                    (6–10 小节，宽，掩盖拼接)
vocals A ██████████████████████████▓▒░░│              (10–14 小节，最后交接)
       B ░░▒▓████...（对应各轨 complementary）
```

规则（每条都可单独开关）：

1. **同轨互补**：同一 stem 上 A 用 `cos`、B 用 `sin`，窗口外一端恒 0 一端恒 1 → 任一时刻每轨功率 ≈ 1。
2. **bass 最窄最先**：两首调性不同，低频同时存在必然浑浊；2 小节内换完，必要时直接 cut（在 downbeat 硬切）。
3. **drums 对齐到小节线**：鼓换手放在 break 或 drop 前一拍，避免 double-kick。
4. **other（旋律/和声）次之**，最宽，用来遮住音色差异。
5. **vocals 最后**：A 的人声先淡出到 0，B 的人声再进（避免二重唱）；或按"副歌接副歌"对齐。
6. **降级**：B 的某轨没算好 → 该轨继续用 A 的（保持音乐完整），一旦就绪在下一个小节线补换。
7. **整体兜底**：4 轨都不可用 → 回落到现有 `naturalGains` 整轨等功率（今天的路径，不变）。

---

## 4. 改造方向（三期，按"先能听出差别"排序）

### P0 · 把 4 轨拿出来（不动模型，1–2 天）

- 服务端：`/api/stems` 增加 `stems=4`；`HtdemucsSession` 已能拿到 4 轨（只需多累加 3 条），写 `wNNN.{drums,bass,other}.wav`，并把 `inst` 改写为 `drums+bass+other` 保证可加。
- 缓存：4 轨请求要求三条子轨齐全才命中；`stem=` 允许 `drums|bass|other|melody`。
- 前端：`loadStemWindowSet()` 一次取 4 轨；`stemSwap` 读取。
- 验收：同一窗口 4 轨相加与 inst 的残差 < −90 dBFS；UI 能单独播每条轨。

### P1 · stem swap 过渡引擎（3–5 天，**这一步就能解决你不满的点**）

- 新增 `web/src/core/stemSwap.ts`：
  - `planStemSwap({ bars, bpm, style })` → 每轨 `{from,to,curve}`；
  - `gainAt(plan, stem, progress)` / 互补增益，纯函数、可单测（`web/tests/stem-swap.test.cjs` 现有 node:test + ts 转译链路可直接跑）；
  - 播放器：两条 deck 各 4 个 `AudioBufferSourceNode` + 每轨 `GainNode`，`setValueCurveAtTime` 按曲线排程；元素支路 `setDeckMixGain(0)`。
- 接入 `crossfadeDeck`：过渡开始时若两端 4 轨就绪 → 走 swap；否则走旧路径（无感降级）。
- 需要同时具备：A/B 两首曲目的**同一时间窗**（过渡只跨 1–2 个 30 s 窗，P0 已能按窗取）。
- 验收：环回录音测 16 小节过渡，逐 0.5 s 计算各频带能量 → 低频不应出现 +3 dB 凸起；人声段不应同时出现两个基频。

### P2 · 流式化（1–2 周，解决"要等 7 秒"）

三条路线，建议**先做 ①**（不改模型即可见效），②③ 作为质量/速度分支保留：

1. **滑动窗流水线（保持 htdemucs）**
   - 播放头前维护 8–15 s 的 stems 环形缓冲；按 2–3 s 片段滚动推理，50% 重叠 + 三角窗 OLA；
   - 未就绪区间继续播原声，就绪后 200 ms 内交叉切入（听感上"秒开"）；
   - 需要：模型支持短输入（当前 ONNX 段长固定 343,980；要么导出动态轴，要么 padding 到整段——后者浪费算力）；
   - 风险：htdemucs 短段质量下降，必须实测 SDR 退化曲线。
2. **换/加流式模型**：Open-Unmix（LSTM 可带状态逐帧推）或 Spleeter 4stems 做"秒开档"，htdemucs 做"高质量档"。
3. **混合**：首播用轻模型秒开，后台跑 htdemucs，算完热替换（crossfade 到高质量轨）。

配套测量（必须先做，否则不知道改得对不对）：
- MUSDB 子集 SDR（vocals/drums/bass/other）——现有 `research/folia-stems-plan.md` 只做过"4 轨和 SDR 31.25 dB"，**不能代替**；
- 短段退化曲线（7.8 s / 4 s / 3 s / 2 s vs SDR）；
- 端到端延迟预算：解码 + 推理 + 传输 + decodeAudioData，逐段计时。

---

## 5. 风险与约束

| 风险 | 说明 | 缓解 |
|---|---|---|
| 30 s 窗对齐 | 过渡跨窗时两份 stems 需要无缝拼接 | 窗口边界做 50 ms 交叉；或 P2 环形缓冲后自然消失 |
| 内存 | 4 轨 × 30 s × stereo × float ≈ 42 MB/窗，浏览器侧 decode 后 ~21 MB/轨 | 只保当前窗 + 下一窗；LRU 4 窗 |
| 磁盘 | 4 轨 WAV 使缓存膨胀 2.5×（30 s ≈ 26 MB） | 仅 `stems=4` 请求才写；保留 512 MB LRU |
| 相位/时间对齐 | 4 轨必须样本级同相，否则 swap 时有咔哒 | 同一 OLA、同一增益；换手点放在过零点/小节线 |
| 质量回归 | 短段推理质量下降 | 先测 SDR，再决定是否走 P2 ① |
| 兼容 | 现有 2 轨路径与 `/api/stems` 契约 | 新参数可选，默认 2 轨不变 |

---

## 6. 建议的下一步（等你点头再动代码）

1. 跑一遍 **MUSDB 子集 SDR + 短段退化**（半天），拿到"能不能短段"的数据；
2. 按 P0 落 4 轨 API（1–2 天，可独立回滚）；
3. 按 P1 落 stem swap 引擎 + 单测 + 环回录音验收（3–5 天）；
4. 数据支持再决定 P2 走 ①/②/③。

> 我已把动过的 4 个后端文件还原（`src/Zilux2/Stems/*`、`src/Zilux2/Online/LocalMusicServer.cs`），
> 中间版本留在 `djuced_re/wip_4stem/` 供参考，仓库当前是干净状态。
