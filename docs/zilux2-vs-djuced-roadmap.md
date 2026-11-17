# Zilux2 × DJUCED：分析 / 分离 / 真人式过渡 总路线

> 汇总 2026-11-16 当天全部逆向、实测与设计结论。**现有过渡方式保持不变**，
> 新增能力一律做成「进阶版」，默认关闭、可随时回退。

---

## 0. 结论先行

| 问题 | 结论 |
|---|---|
| DJUCED 的 STEMS 要破解吗 | **不要**。分轨在免费版就能用，四个垫是「切除/恢复」开关 |
| DJUCED 的分析曲目要破解吗 | **不要**。未激活状态下 45 首全部分析完毕 |
| 要不要换掉 Zilux2 的 BPM 算法 | **不要**。22 首可比曲目里 14 首完全一致、91% 同拍族 |
| 差距在哪 | **链路形态**：常驻流式引擎 vs 请求式离线；整轨等功率 vs 分轨换手 |
| 过渡怎么改 | **不动现有等功率过渡**，新增「进阶模式」：分轨换手 + 手法库 |

---

## 1. 逆向档案（DJUCED 6.8.1，`C:\Program Files\DJUCED\DJUCED.exe`）

- 分离引擎：`NNPredictionDispatcher_fd.dll`（1,664,000 B）+ `NNPredictionDispatcher_on.dll`，
  zplane Stems Pro（`StemsProAlgorithm.cpp`），**模型在本地、常驻内存流式推理**。
- 运行开销实测：≈0.81 核 CPU、68 线程、WorkingSet ≈2.8 GB；`Documents\DJUCED\cache` 无新增
  stem 缓存 → 分离结果只在内存，切歌重算。
- 播放侧：`dj::AudioStem`、`StemsManager`、`setIsProOnly` 只作用于音频 FX（`CAudioEffectZPEffect`），
  **STEMS 与授权无关**。
- 曲目分析：单曲队列 `get_next_track_to_analyze()` → `analyze()` → `analyze_track_finished` +
  `bpm_results` / `key_results` 异步回传；本地自研 DSP（aubio/essentia/keyfinder/qm-dsp/vamp/
  madmom/bpmdetect/soundtouch/fftw/rubberband **全 0 命中**），符号已剥离。
- 分析产物落三处：`DJUCED.db` 的 `tracks`（bpm/key/max_val_gain/danceability/waveform）+
  `trackBeats`（拍网格）+ 文件自定义标签 `DJUCED_DANCEABILITY` + `cache/data8`。
- 授权：Azure APIM（`https://djuced-pro.azure-api.net/v1/token`）+ 本地签名 `license.dat`，
  客户端只做「读状态」。**结论：不伪造授权，只做行为对齐。**

## 2. BPM 基准实测（可复现）

- Harness：`.scratch/bpmbench/`（反射 `TrackAudioDecoder.TryDecode` + `BeatAnalyzer.Analyze`）。
- 样本：`DJUCED.db` 45 行 → 44 可解码，剔除 18 个 `bpm=90` 占位与 <30 s 素材，**22 首可比**。

| 指标 | 结果 |
|---|---|
| 完全一致（≤0.5%，零校正） | **14 首** |
| 八度归一后 ≤2% | **17 首（77%）** |
| 加 ×1.5/÷1.5 族后 ≤2% | **20 首（91%）** |
| 需 ×2 才对齐 | 3 首（84→169.73 / 89→177.23 / 80→160.08） |
| 系统性偏差 0.667 | 2 首（133 vs 88.9，flac 与 mp3 一致 ⇒ 三连音族） |
| 置信度门控 | 判对中位 0.59 / 判错中位 0.32；`conf<0.45` 抓 5/6 |
| 速度 | 中位 **468 ms/首**（≈277× 实时） |
| 未解 | DJUCED `key` 为自定义整数码，4 种编码假设最高一致率仅 17% |

**判断**：Zilux2 的 `BeatAnalyzer` 与 DJUCED 属同族参数差异，换引擎只会继承对方的假标签。
要做的是**置信度门控 + 候选拍族**，不是换算法。

## 3. 两种过渡模式（本次最重要的架构决定）

```
TransitionMode = 'standard' | 'advanced'

standard  →  transitionMath.naturalGains()  整轨等功率 cos/sin
             （crossfadeDeck.ts:957 / :972，一行不改，行为冻结）
advanced  →  transitionPlan.planTransition() 分轨换手 + 手法库
             （新模块，默认不进主链路）
```

唯一入口 `planForMode(mode, input, hint)`：**标准模式返回 `null`**，调用方据此回落。
两条链路物理隔离 —— 进阶版崩了也影响不到现有过渡。

## 4. 进阶版架构（三层）

```
Decider（选）→ Scheduler（排）→ Performer（演）
```

- **Decider**：Camelot 距离（≤1 才允许换 vocals）、拍族折叠后的速度偏差
  （≤3% sync / 3–6% 提示 / >6% 不 sync）、能量差、`reason` 文案。
- **Scheduler**：输出纯数据 `TransitionPlan`，所有换手点锚在 `downbeats`（误差 <5 ms）。
- **Performer**：`gainAt()` 三条曲线 —— `linear`（相关信号）、`equalPower`（不相关）、
  `shelfDip`（低频交接中点 −3 dB）。**根因**：两轨同源低频相关，一律等功率在 p=0.5 得 1.414，
  即 +3 dB —— 这就是「伴奏渐入发闷/变厚」的数学原因。
- 手法库（`djMoves.ts`）：低频交接 / EQ 三段互换 / 人声叠鼓 / 人声回声甩尾 /
  滤波扫频 / 回声硬切；回声固定 1/4 拍、反馈 0.35、阻尼 3 kHz、新歌侧链 −3 dB/5 ms。
- 人味：`humanize()` **只抖时间（±12 ms）与曲线（±10% 长度），不抖结构**（小节号一律整数）。

三个成品模板：`club32`（标准 32 小节）、`vocalOverBeat16`（人声叠鼓 16 小节）、
`echoCut8`（回声硬切 8 小节）。

## 5. 本次已落地

| 文件 | 内容 | 状态 |
|---|---|---|
| `web/src/core/transitionPlan.ts` | `Compat` / `Template` / `planTransition` / `gainAt` / `actionWindows` / `planForMode` / `TransitionMode` | ✅ |
| `web/src/core/djMoves.ts` | `Move` / `Automation` / 6 个手法 / 3 个模板 / `expandMoves` / `humanize` / `ECHO` 常量 | ✅ |
| `web/tests/transitionPlan.test.cjs` | 11 个纯函数用例（Camelot、拍族、模板排布、降级、曲线、窗口、手法、回声、人味） | ✅ 11/11 |
| 全量前端测试 | `node --test web/tests/*.test.cjs` | ✅ 71/71 |
| 类型检查 | `npx tsc --noEmit` | ✅ 0 error |

## 6. 里程碑

| 阶段 | 内容 | 预估 |
|---|---|---|
| **M1（已完成）** | 纯函数决策层 + 手法库 + 测试，不接音频 | ✅ |
| **M2** | `web/src/audio/stemGraph.ts`：4 轨路由 + `AudioParam` 采样级调度 + delay/ducking | 2 d |
| **M3** | `crossfadeDeck.ts` 接进阶分支（`mode==='advanced'` 才走，标准路径零改动） | 1 d |
| **M4** | UI：模式开关 + 时间线可视化（可拖换手点）+ `reason` 展示 | 2 d |
| **M5** | 实测验收：低频波动、人声重叠、拍点漂移、盲听对比 | 1 d |

## 7. 验收指标（可量化）

| 指标 | 目标 | 方法 |
|---|---|---|
| 低频 30–120 Hz 波动 | <2 dB | 环回录音做频带能量对比 |
| 人声重叠 | <1 拍 | 两轨 vocals 同时 >−30 dBFS 的时长 |
| 拍点漂移 | <5 ms | 合成 click 跑 2 分钟测偏差 |
| 换手点对齐 | <5 ms | 自动化时间戳 vs `downbeats` |
| 兜底触发 | 0 次崩溃 | 断网 / 删缓存 / 中途 seek 各测一遍 |
| 盲听 | 与 DJUCED 各 20 次，选优 ≥50% | 人耳，双盲 |

## 8. 风险与回滚

- 进阶模式**默认不启用**，`planForMode('standard')` 恒返回 `null`，现有链路 0 影响。
- 新增文件全部是独立模块，不 import 任何播放链路；删掉三个文件即完全回滚。
- 音频层（M2）落地前，`Plan` 只用于离线测试与 UI 预览，不会碰到正在播放的声音。
- DJUCED 侧全程只做**只读逆向**：内存补丁仅在进程内、不落盘（`launch_patch.py` 可选），
  `config.xml` 一字未改，数据库改动均有备份（`DJUCED.db.bak_20261116_051705`）并已还原。
