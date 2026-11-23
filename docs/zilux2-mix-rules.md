# zilux2 混音规则总表（2026-11-23，r37）

> 这份文件是「无缝衔接」重构的规则索引：每条规则写清触发条件、参数、依据与体检证据。
> 细则与逐轮数字在 `docs/zilux2-mix-audit.md`；实现集中在 `web/src/ui/crossfadeDeck.ts`、
> `web/src/core/automix/v2Plan.ts`、`v2Quality.ts`、`web/src/audio/automixV2Graph.ts`。

## 0. 可测指标（体检口径）

| 指标 | 定义 | 当前 |
|---|---|---|
| `QUALITY_FAIL` | 规划期质量门任一失败 | 267 / 5665（4.7%） |
| `loudness-drift` | 换手段内混合响度偏离首尾直线的最大深度（只在两边都在响时计） | 260（4.6%），p50 0.50 / p90 1.16 / max 3.52 LU |
| `vocal-overlap` | 两边人声同拍；A 为器乐时 0.6 折权 | 5（0.1%） |
| `A_VOCAL_CUT` | A 末句之后才收尾 | 0（`A_VOCAL_YIELD` 44 单列） |
| `rate-jump` | 变速斜率 >1.5%/拍 | 7（0.1%，全在乐句路径） |
| `ENTRY_DUCKED` | B 开唱时仍被压 >2 dB | 8（0.1%） |
| `LOW_PHASE_CLASH` | 低频反相且两边同时活跃（信息项） | 467（8.3%） |
| must-zero | `TOO_SHORT/WALL_TOO_SHORT/B_SEEK/NO_HANDOFF/RATE_UNSTYLED` | 全 0（exit 0） |

复验：`cd web && node --test tests/ && node tools/mix-audit.cjs --pairs=8`（5641–5665 对，依库）。

## 1. 结构层（窗口从哪来）

- **乐句优先**：`phrase-match` 用 A 末句/鼓点 + B 首句反推窗口；反推会让 A 唱着被切走时 `return null` 交回通用路径（r20）。
- **末句硬保护**：窗口末端早于 `lastVocalEnd+600ms` 时延长，上限受 `MAX_FADE_MS`、可听结尾 +400 ms、B 可用长度 −400 ms 约束（r1/r2）。
- **A 收尾尾巴**：缺口 ≤3 s 时用 `aTailHold + tailBleed`，>3 s 视为编曲（不铺）——这是 `A_VOCAL_CUT` 从 128 降到 84 再归零的路径（r2/r15/r20）。
- **出点吸附**：`fadeStart` 吸到最近 downbeat，上限 `min(500ms, 0.25 小节)`，只移动起点；≤0.1 拍占比 6.3%→10.4%（r9/r26）。
- **最短窗**：`MIN_FADE_MS 3200`、`MAX 30000`；`mixFloor` 6/12/20/30 s 跟随场景。

## 2. 曲线层（怎么换）

- **LR4 分频**，分频点自适应 `planSplitHz`：低频相关性 `corr=1→120Hz`、`0→150`、`−1→180`，夹 90–200；77% 的对抬到 125–180（r6）。
- **紧凑换手**：mid 0–0.28、high 0.34–0.62、low 0.66–0.96 三段严格排开；高频功率互补（`sqrt(1−a²)`，r7 修掉 −3 dB 中间薄），低频幅度互补。
- **A 侧**：`aHp` 恒 20 Hz，低通 20k→700（随扫频），高频 `cos` 收；A 在换手前保持原样（`hold`）。
- **B 侧**：高通 12k→20 Hz 在换手前开完；幽灵电平 −60 dB 起，`preLevel` 从 −40 爬到 −12。
- **低频反相**：`lowCorr < −0.6` 时 B 低频翻 180°（`setLowPolarity`），避免线性换手相消（r35）。
- **变速**：A 拉向 B，`clampTempoRateForWindow(1.0%/拍)`，整八度折叠豁免；`planSpeedRamp` 四段 ease-in-out（r14）。

## 3. 电平与频谱补偿

- **B 电平包络 `planBTrimCurve`**：参考 A 峰值，`trim = 0.75×(aPeak−b) − 3 dB`，A 消失段补满（系数 1.0），夹 −6…+9 dB；逐点、不平滑（250 ms 分辨率）（r21–r27、r31）。
- **过渡总电平**：`transitionMatchDb` 取 A 末 6 s 与 B 首 6 s 的 LUFS 差，夹 ±3 dB，向 B 的抬升要求 peakDb 证据；与 `bTrim` 共用 6 dB 余量。
- **谱质心补偿**：`planTimbreCompDb`，|gap|≥4 dB 才动，亮侧 presence 减、暗侧加、另一侧补 60%，单侧 ±3 dB；只在两边都有 style 时成立（r16/r37）。
- **低频校准**：`lowTrim` 在换手前采 3 帧 RMS 中位，夹 −6…0 dB（只降不升）（r15）。

## 4. 让位与空间

- **A 人声让位**：2.5 kHz Q1.2，按 B 的 `activity.vocal` 触发；近调 −6、远调（Camelot ≥4）−8、乐句路径 −12；B 自己开唱时让位归 0 并提前 400 ms 收（r10/r29）。
- **B 入场让位**：A 在唱时压 B，深度 3–6 dB 自适应。
- **湿声**：`echoOut/reverbOut` 只在 A 尾鼓密度 ≤0.55 时用，否则退回 `filterSweep`；短窗（≤4.2 s）才送 echo（r32/r43）。
- **尾段混响**：A 侧 IR 1.6 s、RMS 0.35，从窗口 25% 起送；B 侧 55% 起、−15 dB，双边不对称（r32/r35）。

## 5. 生成式垫底（Stable Audio Open）

- 开关：`mixGenerativeTransition`（高级过渡→全局），或开发者 `zilux2.dev.extendmodel=1`；默认关。
- 长度：`estimateTransitionBedMs = clamp(12% 曲长, 8–16 s)`；窗口更长时垫底**贴住窗口末尾**（r22）。
- 播放：从 `fadeStart` 起、`aLufs−eLufs−8 dB`、0.6 s 淡入、≤1.2 s 淡出、随换手收尾；失败/无模型回落 `loopUnits`。
- 服务：`/api/analysis/feature-audio`（路径必须落在 analysis 根、只允许 `.wav`，逃逸 403）。
- 证据：开关开 → 体检 bed 8 对、关 → 0（r36）；14 s 生成 2,469,644 B 实测（r23）。

## 6. 已知上限（不是 bug）

1. **drift 4.6%**：集中在「B 前奏轻 10–15 LU 且带唱、A 已走完」，补电平到 9 dB 上限后属编曲事实。
2. **LOW_PHASE_CLASH 8.3%**：极性翻转后仍反相，需要逐段延时对齐，当前不做。
3. **谱质心覆盖**：只有跑过 style stage 的曲目（现 19 首）才有；随播放/预取增长。
4. **生成垫底**：文本条件不续接旋律，默认关闭；开启后需人耳确认与曲目调性相容。
5. **乐句路径变速**：仍未按 1%/拍夹取（7 对 rate-jump），因为夹取会破坏 `x+span` 与 `y` 的对齐。
