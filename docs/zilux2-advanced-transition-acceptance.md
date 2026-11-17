# Zilux2 进阶智能过渡 · §8 验收报告

生成时间：2026-11-16
验收对象：`docs/zilux2-advanced-transition-wbs-v2.md` §8
夹具：`.scratch/transition-accept/emit.cjs` + `.scratch/transition-accept/measure.py`
产物：`.scratch/transition-accept/events.json`、`.scratch/transition-accept/metrics.json`

---

## 1. 结论

| 指标 | 目标 | 实测 | 判定 |
|---|---|---|---|
| C1 换手点误差 | < 5 ms | **0.000 ms**（8 个场景、全部动作） | PASS |
| C2 低频（30–120 Hz）波动 | < 2 dB | **0.000 dB**（同相低频）/ **1.013 dB**（去相关低频） | PASS |
| C3 人声重叠 | < 1 拍 | **0.872 拍**（最差场景 filterBuild / standard） | PASS |
| G1 过渡后无双声 | A 人声=0 且 B 人声=1 | 全部场景 True | PASS |
| G2 回退无咔哒 | 单调、无台阶跳变、≤20 ms | 8 步 × 2 ms、最大绝对台阶 0.125、单调 | PASS |
| G3 节点不泄漏 | 拆图后无残留连接 | `stemGraphLifecycle.test.cjs`：建 38 节点 / 48 连接 → dispose 断 38、第二次不重复断；`advancedSession.test.cjs` 5 条（含 cancel 幂等） | PASS |
| G4 四轨重构一致 | Σstems 与混音残差 ≤ −30 dB；短窗 drums/vocals 一致性 ≥ 0.95 | 真曲 7.8 s **−35.55 dB**、2 s −33.66 dB；一致性 drums 0.990 / vocals 0.994（2 s） | PASS |
| G5 进阶期互斥静音 | 接管后两条 deck 图增益=0（20 ms 斜坡），交还按当前进度还原 | `crossfade.test.cjs`「T4-3 互斥静音」：静音 2 条写入、回退还原值 = cos/sin(progress) ±0.02、斜坡 20 ms | PASS |
| 对照：旧整轨等功率（同材料） | — | **1.857 dB** 波动 | 参考 |

`VERDICT: PASS`（脚本退出码 0）。

> G3 说明：节点泄漏是生命周期问题，离线音频夹具量不出连接数。第 3 轮把它变成了可回归的自动断言：
> `web/tests/stemGraphLifecycle.test.cjs` 用计数替身 AudioContext 建图并清点 —— 每台 19 个节点
> （7 总线 + 4 轨 × 3）、双 deck 共 38 节点 / 48 次 connect；`dispose()` 必须断满 38 次且第二次调用
> 不再重复断（幂等）。同一文件还锁住了 `applyAll` 的过去时间门禁与 `setEchoTime` 的 [0.01, 4] 夹取。

---

## 2. 夹具覆盖的场景

`emit.cjs` 用与单测相同的 `typescript.transpileModule + vm.runInNewContext` 方式加载 TS 纯函数层，
跑出 `TransitionPlan → ScheduledEvent[] → TimelineModel`，再交给 `measure.py` 渲染合成音频。

| 场景 | 模板 | 小节 | 说明 |
|---|---|---|---|
| `std-8A-8A-128` | standard | 32 | 同调、同速、基准 |
| `std-8A-9A-128` | standard | 32 | 相邻调（Camelot 8A→9A） |
| `vocal-first` | vocalFirst | 16 | 人声先换手 |
| `double-drop` | doubleDrop | 8 | 低频+鼓同时进 |
| `bass-only` | bassOnly | 8 | 降级：只换低频与鼓 |
| `filter-build` | filterBuild | 16 | 长时间其他轨交接 |
| `tempo-126-vs-128` | standard | 32 | 126 vs 128 BPM 变速 |
| `low-conf` | bassOnly | 8 | 置信度 0.3 → 门控降级 |
| `std-8A-8A-128|decorr` | standard | 32 | 低频去相关（55.4 Hz / 90° 相位）对照 |

合成材料：drums = 每拍 62 Hz kick + 反拍 hat；bass = 稳态 55 Hz；other = 440/660 Hz 和弦（按小节门控）；
vocals = 300/1200 Hz（4 小节乐句、50% 占空）。两 deck 同频同相 → 低频相关性最坏情况。

---

## 3. 指标口径（脚本可复现）

- **C1**：对每条 `gainCurve` 的 A/B 曲线求「B 追上 A」的第一个采样点，
  换算成时间与该动作窗口中心（`atMs + durationMs/2`）比较，取绝对值最大值。
  等功率曲线的交点在 `p=0.5`（`cos=sin`），线性/shelfDip 同样在 `p=0.5`，所以正确实现必然为 0。
- **C2**：把 **bass 分轨**（不含 kick 瞬态）合成后做 30–120 Hz 带通（FFT 置零法），
  500 ms 短时 RMS（窗口覆盖 27 个 55 Hz 周期，避免窗口相位造成假波动），
  在过渡区间取 `max−min`（dB）。
- **C3**：A、B 人声增益同时 > 0.1 的总时长 ÷ 一拍。
- **G1**：过渡结束后 500 ms 处 `gainA(vocals) < 0.01 && gainB(vocals) > 0.99`。
- **G2**：`advancedSession.releaseElements()` 的 8 步斜坡：单调、总时长 ≤ 25 ms、
  单步绝对幅度 ≤ 1/steps（首步 dB 台阶天然无穷大，因此用绝对幅度判咔哒）。

---

## 4. 本轮验收抓出的三个真问题（已修）

1. **出场曲线用错了补函数**：`schedulePlan` 原来给 A 侧发 `1 - curve`。
   等功率曲线的补是 `cos`，不是 `1 - sin` —— 中点总增益变成 `0.5 + 0.707 = 1.207`（+1.6 dB），
   50% 交点偏到 `p=1/3`，C1 直接报 156 ms。
   新增 `buildSourceCurve()` 走 `gainAt().a`，并加断言 `a² + b² = 1`。
2. **降级模板漏覆盖**：`bassOnly/bassDrumsOnly` 只点 bass+drums，
   `other/vocals` 会一直挂在 A 上，B 的人声永远进不来（G1 报 False）。
   现在 `schedulePlan` 给未覆盖分轨补交叉，且**人声压到最后一拍内完成**（C3 从 8 拍降到 0.8 拍）。
3. **躲避把整条 deck 压了**：人声换手时的 −3 dB 侧链原来作用于 deck 总增益，
   连 B 的低频一起压低，C2 报 6.0 dB。
   `DuckEvent` 新增可选 `stem`，`stemGraph` 增加每轨 `stemDuck` 节点，
   人声/回声躲避只压 `vocals`。
4. 附带：`releaseElements` 由 4 步改 8 步、并改成**每步独立绝对定时**
   （链式回调在窗口繁忙时会被推迟，单测里表现为只跑到 5/8 步）。

---

## 5b. 第 6 轮补充指标（PLL 稳定性 / 下拍锚定 / 曲线中点）

| 指标 | 口径 | 实测 | 判据 |
| --- | --- | --- | --- |
| 拍点漂移（E1） | B 起播超前 30 ms，逐拍跑 `trackRate` | 第 **7 拍（3.5 s）**进入 ±5 ms；稳态 **0.0005 ms**；末态速率回到中心 | <5 ms ✅ |
| 换手点误差（C1 补充） | 4 个 `SwapAction.startBar` 到最近下拍的绝对距离 | 4/4 **0.000 ms** | <5 ms ✅ |
| 曲线中点 | `gainAt({curve}, 0.5)` | linear 0.5+0.5=1.0；equalPower 0.7071+0.7071=1.4142（功率 1.0）；shelfDip 0.35+0.35 | 相关低频必须走 linear ✅ |

**过程中发现并修掉的真 bug**：`trackRate()` 原先累加式 P 控制（`rate += -kp*err`）在
「速率是相位积分」的闭环里构成双积分器，模拟轨迹过零后反向发散（64 拍仍剩 18.4 ms）。
改为「按误差直接算目标速率 + 单步限幅」，同一条轨迹单调收敛、无过冲。

复现：`node .scratch/transition-accept/metrics-round6.cjs`（PASS，结果 `metrics-round6.json`）；
回归用例：`web/tests/transitionPerformer.test.cjs` 的「双积分器回归」一条。

---

## 5. 已知边界（未验）

- 夹具是**合成信号**，不是 MUSDB 真实曲目；SDR/主观听感仍需真机盲听（WBS §8 的 24 组非劣性检验）。
- 未跑真机 HTTP E2E（需要先停掉用户正在运行的 Zilux2 实例，会中断播放）。
- 4 轨残差已在后端探针中量到 −90.31 dBFS（16-bit 往返），但那是占位信号；真实 htdemucs 输出未测。
- `C2=0.000 dB` 是「同频同相」这一数学最坏情形的结果（`a+b=1` 恒等），
  真实曲目更接近 `decorr` 那行的 1.013 dB。

---

## 5c. G2 回退无咔哒（第 7 轮自动化）

| 检查 | 口径 | 结果 |
| --- | --- | --- |
| 取消幂等 | 四轨接管失败时 `handoff.cancel()` 调用次数 | 恰好 1 次 ✅ |
| 曲线连续 | 回退重排的 A 曲线首点 vs `naturalGains(当前进度)` | 完全相等（1e-6 内）✅ |
| 无阶跃 | 200 段相邻增益差 | 最大 <0.02 ✅ |
| 收尾 | A 曲线末点 | 0 ✅ |

**边界**：进阶交接只在**图模式**生效（`requestHandoff` 在 `if (plan.graphMode && clock !== null)` 内），
元素模式没有分轨能力；`rampDeckVolume()` 是防御性路径（元素分支实际不可达）。

---

## 6. 复现命令

```bash
node .scratch/transition-accept/emit.cjs
python .scratch/transition-accept/measure.py   # 退出码 0 即 PASS
node --test web/tests/                         # 162 pass
cd web && npx --no-install tsc --noEmit        # 0 error
```

## 5d. 第 8 轮：离线四轨质量基准（真曲 + 合成）

工具链：`.scratch/stems-bench/`（`gen_synth.py` 合成四轨混音；`stemsbench.exe` 反射调 `Zilux2.Stems.HtdemucsSession.Open/Separate` 落 4 轨 raw f32；`sdr.py` 算合成信号 SDR；`real_metrics.py` 算真曲的重构残差与跨窗一致性）。运行目录 `artifacts/stems-bench-rt/`（隔离 ONNX 原生库，见下「坑」）。

### 1) 真曲：重构残差与跨窗一致性

素材：`C:/Users/13329/Music/DJ阿罗 - 晴天(DJ版).mp3` 第 45 s 起 24 s，44.1 kHz 立体声。

| 窗口 | 重构残差 dB（mix − Σstems，相对 mix） | drums | bass | other | vocals | 人声能量占比 |
|---|---|---|---|---|---|---|
| 2.0 s | **−33.66** | −17.79 | −71.00 | −25.06 | −17.71 | 46.2% |
| 3.0 s | −35.08 | −17.55 | −71.68 | −26.04 | −16.81 | 50.9% |
| 4.0 s | −35.29 | −17.61 | −71.75 | −26.30 | −16.72 | 52.0% |
| 7.8 s | **−35.55** | −17.74 | −71.59 | −26.03 | −16.32 | 54.7% |

跨窗一致性（各窗输出 vs 7.8 s 整段输出，同一段音频、左声道）：

| 窗口 | drums r | bass r | other r | vocals r | 电平差（vocals） |
|---|---|---|---|---|---|
| 2.0 s | 0.990 | 0.674 | 0.959 | **0.994** | −0.01 dB |
| 3.0 s | 0.998 | 0.831 | 0.988 | 0.997 | −0.03 dB |
| 4.0 s | 0.999 | 0.901 | 0.992 | 0.999 | −0.03 dB |

判据口径：G4（新增）= **四轨和与混音的重构残差 ≤ −30 dB**，且短窗一致性 drums/vocals ≥ 0.95。
结论：7.8 s 与 2–4 s 全部满足；唯一明显退化是 **bass 在 2 s 窗（r=0.674、−4.5 dB）**——该素材本身几乎没有低频（bass 分轨电平 −71 dB），2 s 窗对低频周期估计不足，退化在预期内。

### 2) 合成信号：基准 SDR（**只能作相对比较，不是 MUSDB SDR**）

合成四轨（62 Hz kick / 55 Hz bass / 小节门控和弦 / 880 Hz 带颤音人声），24 s：

| 窗口 | drums | bass | other | vocals | 均值 |
|---|---|---|---|---|---|
| 2.0 s | 13.60 | 21.39 | −4.84 | −30.03 | 0.03 |
| 3.0 s | 9.28 | 22.50 | −4.04 | −24.30 | 0.86 |
| 4.0 s | 9.84 | 20.84 | −4.00 | −19.15 | 1.88 |
| 7.8 s | **15.64** | **21.81** | −1.42 | −21.45 | 3.64 |

- drums/bass 落在 15–22 dB，符合 htdemucs 在打击/低频上的常态。
- `other`/`vocals` 为负：纯正弦与颤音音调完全在训练分布之外，模型把它们判给别的轨——**这两个数不能当作分离质量**，只说明「合成素材不能替代 MUSDB」。
- 短窗退化（相对 7.8 s）：2.0 s drums −2.04 dB、bass −0.42 dB；3.0 s drums −6.35 dB、bass +0.69 dB；4.0 s drums −5.79 dB、bass −0.97 dB。

### 3) 本轮修掉的两个坑

1. **harness 的左右声道读取错误（会得出「模型分离全是垃圾」的假结论）**：原来 `Buffer.BlockCopy(raw, 0, left, 0, frames*4)` 把整段交错流当成左声道，于是喂给模型的是 `L0,R0,L1,R1,…`。修正为逐帧 `left[i]=raw[2i]`、`right[i]=raw[2i+1]` 后，真曲重构残差从 −0.18 dB（≈完全对不上）变成 −35.55 dB（≈完全对得上）。教训：**任何分离基准第一步都要先验 `Σstems ≈ mix`**，这一步不通过就别谈 SDR。
2. **ONNX 原生库 API 版本不匹配**：在 app bin 里跑 harness 报 `The native ONNX Runtime library does not support API version 31.`——harness 的 `deps.json` 不认识 `runtimes/win-x64/native`，运行时退回 PATH 上的旧库。解法：把 `stemsbench.*` + `Zilux2.dll` + `Microsoft.ML.OnnxRuntime.dll` + `System.Numerics.Tensors.dll` + `runtimes/win-x64/native/onnxruntime*.dll` 全部拍平拷到 `artifacts/stems-bench-rt/` 再运行。

### 4) 复现命令

```powershell
# 合成素材 + 真曲素材
python .scratch/stems-bench/gen_synth.py
ffmpeg -ss 45 -t 24 -i "C:/Users/13329/Music/DJ阿罗 - 晴天(DJ版).mp3" -ac 2 -ar 44100 -f f32le .scratch/stems-bench/real/mix_lr.f32

# 跑模型（隔离目录，避免 ONNX 原生库打架）
cd artifacts/stems-bench-rt
./stemsbench.exe "$env:LOCALAPPDATA/Zilux2/models/htdemucs-dft-fp16-transparent.onnx" <mix_lr.f32> <outDir> "7.8,4,3,2"

# 指标
python .scratch/stems-bench/sdr.py            # 合成 → sdr.json
python .scratch/stems-bench/real_metrics.py   # 真曲 → real_metrics.json
```

### 5) 仍然欠的

- **MUSDB18 真数据集 SDR**：**已在第 17 轮打通并测出真值**（走 hf-mirror 的 `danjacobellis/musdb18HQ` validation 分片 = MUSDB test 50 首，取 30 s 片段）；见 §7。上面的真曲指标是「无参考」指标（重构残差 + 跨窗一致性），与 §7 互补。
- 真机 HTTP E2E（需停掉用户正在跑的 Zilux2 实例）。
- 盲听 24 组非劣性检验（需用户本人参与）。

| G1b | 变速跨窗无双声/空档 | `stemPlayerAudio.test.cjs`「变速重排」2 条 | PASS（第二窗重排到 124.7059 s，旧排程无残留） |

| G1c | 进阶期 A/B 速率同源（元素与分轨同速） | `advancedSession.test.cjs`「A/B 速率来自各自元素」+ `crossfade.test.cjs`「绝对速率」 | PASS（1.5× 倍速下推 1.428 而非 0.952） |

| G6 | 分轨先放完 → 提前接回等功率（不静场） | `stemPlayerAudio`/`advancedSession`/`crossfade` 各一条 | PASS（剩 0.2 s 触发一次回退，10 s 时不触发） |

## 6. 一键验收

```powershell
pwsh -File .scratch/transition-accept/run-all.ps1            # 全量（含四轨质量）
pwsh -File .scratch/transition-accept/run-all.ps1 -SkipStems # 跳过需要模型输出的那步
```

依次跑：`node --test web/tests/` → `tsc --noEmit` → `emit.cjs + measure.py`（C1/C2/C3/G1/G2）→ `real_metrics.py`（G4），
最后打印汇总表并以 `VERDICT: PASS/FAIL` 结束（退出码 0/1）。

最近一次结果：`pass=163 / fail=0`、`0 error`、`C1max=0ms`、`C3max=0.872 拍`、`G4 残差 −35.55 dB`。

## 7. E2：MUSDB18-HQ 真数据集 SDR（第 17 轮）

数据：`https://hf-mirror.com/datasets/danjacobellis/musdb18HQ`（本机 `huggingface.co`、`zenodo.org` 均 DNS 不可达，hf-mirror 可达，约 20 MB/s）。
`validation-*-of-00022.parquet` 就是 MUSDB **test** 50 首；分片 schema `audio: struct<bytes, path>` + `instrument`，44.1 kHz 立体声，每片约 2.4 首曲（跨片的曲目需读相邻两片）。

抽取：`.scratch/musdb/musdb_extract.py <parquet> <曲名子串> <起始秒> <时长秒> <outdir>`
→ `mix_lr.f32`（交错 f32）+ `truth_<stem>.npy`（2×N）+ `meta.json`，并打印 `mixture−Σstems` 峰值。
**第 0 号前置检查**：`mixture ≈ Σstems` 成立才说明抽取对齐 —— 实测三首 `_datasetResidualDb` 为 **−66.67 / −68.02 / −70.96 dB**，通过。

推理：`artifacts/stems-bench-rt/stemsbench.exe <model> <mix_lr.f32> <out> "30.0"`（4 线程 fp16，30 s 用 8.9–9.2 s）。
SDR：`.scratch/musdb/musdb_sdr.py <truthdir> <estdir> <tag>`（投影口径，BSSEval v4 形式：`α=Σ(ref·est)/Σ(est²)`、`target=α·est`、`10log10(P_t/P_n)`）。

| 曲目（MUSDB test） | 片段 | drums | bass | other | vocals | 均值 |
|---|---|---|---|---|---|---|
| BKS - Bulldozer | 40–70 s | 14.12 | 11.66 | 2.53 | 12.81 | **10.28** |
| Angels In Amplifiers - I'm Alright | 30–60 s | 7.00 | 10.51 | 7.85 | 11.55 | **9.23** |
| Girls Under Glass - We Feel Alright | 30–60 s | 9.65 | 6.60 | 7.77 | 9.21 | **8.31** |
| **三曲均值** | — | **10.26** | **9.59** | **6.05** | **11.19** | **9.27** |

与 htdemucs 公开量级（4 轨均值 ≈9 dB）一致；`other` 偏弱是这套模型的已知短板（它把吉他/键盘大量判给 vocals/bass）。

口径与边界：
- 每曲只测 **30 s 片段**（不是整曲加权），片段取自各曲中段，不保证覆盖最难的段。
- 模型是 `htdemucs-dft-fp16-transparent`（fp16 量化，相对 fp32 约掉 0.1–0.3 dB），4 线程 CPU。
- 走的是 Zilux2 的 30 s 窗口路径（`HtdemucsSession.Separate` 内部按 7.8 s 分段 + OLA），与产品实际链路一致。
- 该表回答「分离质量是否支撑分轨换手过渡」，**不作为 SOTA 排名**。

## 8. E1 盲听夹具（已备好**真实素材**，等听）

`.scratch/listen/out-real/` 是用 MUSDB test 真曲分轨比出来的一整套：

- A 歌 = `BKS - Bulldozer`（40–70 s 的模型输出），B 歌 = `Girls Under Glass - We Feel Alright`（30–60 s）
- 24 组 × 16 s、44.1 kHz 立体声，RMS 对齐到 −18 / −17 dB，A/B 顺序随机、起点 ±1 小节
- `standard` = 整轨 `cos/sin` 等功率；`advanced` = 按 `transition-accept/events.json` 逐轨换手
- 冒烟：用「全选进阶侧」的假答案跑 `score.py` → `胜+平 100% / CI [86.2%,100%] / PASS`（证明统计链路通）

听法：

```powershell
cd .scratch/listen
python -m http.server 8899        # 浏览器打开 http://127.0.0.1:8899/out-real/listen.html
# 1/2 切边，← → 投票，↓ 平局；听完点「导出 answers.json」
python score.py answers.json      # 先别开 out-real/key.json
```

判据沿用 WBS §8：胜+平 ≥ 50%，Wilson 95% 下界 ≥ 40%。**这一步必须你本人听**，我不能代替主观判断。

## 9. 长跑场景重放（第 18 轮）

单条窗口的行为早就有用例，但真实过渡是「4 个窗口 + 中途多次变速」叠加出来的。新增
`web/tests/transitionScenarioReplay.test.cjs`（4 条，假 AudioContext，纯调度层验证）：

1. **四窗 × 六次变速**：120 s 跨度从 2 s 起播，在 t=20/35/50/70/90/110 依次把速率改成 1.02/0.98/1.0/1.03/0.99/1.01。每次变速后逐个待起播窗口断言
   `start == now + (边界 − 位置)/rate`（1e-6 容差），且该起播时刻上**恰好 4 条 source**（= 1 窗 4 轨）。
   —— 任一处重复排程都会让这个计数变成 8，即 G1「双声」；任一处漏排会变成 0，即空档。
2. **变速正落在窗口边界**（位置正好 30.000）：已过边界的窗只改 `playbackRate` 不重排，后一窗只排一次。
3. **remainingSec 单调性与阈值跨界**：从 50 s 起播两窗（到 60 s），剩余按真实秒 `10→8→6→4→2→0` 下降；在 0.5 s 时不触发兜底、0.2 s 时触发、之后持续低于阈值不反复跨界。
4. **长跑后 dispose**：跑到 120 s 再拆，全部 source `stopped` 且 `disconnected`，`isPlaying === false`、`remainingSec === 0`，重复 `dispose()` 不抛、再 `start()` 返回 false。

判据：4/4 通过；与既有 G1b（变速重排）、G6（分轨先放完兜底）互补——那两条测单点，这一条测叠加。

## 10. A 侧速率同步（第 18 轮）

之前 `AdvancedSession.setRate` 只动 B（PLL 只该动 B，这没错），但**用户推 tempo 推子**时 A 的元素速率也会变，分轨 A 却仍按起播速率播 —— 两条时间轴慢慢错开，几十秒后鼓点与波形不同步。

- `web/src/audio/advancedSession.ts` 新增 `setRates({a?, b?})`：两侧各自校验（非有限/≤0 各自忽略，互不影响），`setRate(rate)` 保留为 `setRates({ b: rate })` 的薄包装；新增 `get aRate()`。
- `web/src/core/advancedHandoff.ts` + `web/src/audio/installAdvancedHandoff.ts`：`Handoff.setRates?` 转发到会话；会话没实现时退回 `setRate(rates.b)`（兼容旧实现/测试替身）。
- `web/src/ui/crossfadeDeck.ts` `fadeStep()`：优先 `setRates({ a: active.playbackRate, b: liveRate })`，否则退回 `setRate(liveRate)`。

| G1d | 过渡中推 tempo：两侧分轨跟住各自元素 | `advancedSession.test.cjs`「setRates」+ `crossfade.test.cjs`「A 侧速率一起推」 | PASS（A=1.5 时给 A 的也是 1.5，B 取 PLL 值；非法值只忽略该侧） |

## §11 E3：真机 HTTP E2E（独立进程起真 LocalMusicServer）

GUI 有单实例互斥体（`src/Zilux2/App.xaml.cs:37` `Local\Zilux2.SingleInstance`），所以第二份 GUI 会自行退出。
E2E 改为在独立控制台进程里反射构造 `LocalMusicServer` + `TrackAnalysisService` + `StemSeparationService`，
自己监听空闲 loopback 端口，用 `HttpClient` 打真 HTTP —— 覆盖的是**真实路由、真实鉴权、真实落盘**，不是桩。

- 工程：`.scratch/stems-e2e/StemsE2E.csproj` + `Program.cs`；素材：`.scratch/stems-e2e/make-probe.py` → `media/probe.wav`（30 s 44.1 kHz 立体声 PCM16）
- 运行目录：`artifacts/stems-e2e-rt/`（宿主要拍平 27 个 dll，缺 `NAudio.Wasapi` 会 500）
- 日志：`artifacts/stems-e2e-rt/verify-e2e.log`
- 结果：**TOTAL 12/12 PASS**

| 断言 | 实测 |
|---|---|
| 2 轨 `/api/stems` | 200，`{"state":"ready","stems":2,"window":0,"windowSec":30,"frames":1323000,"cached":false,"ms":7260}`（总 7389 ms） |
| 2 轨 vocals / instrumental | RIFF，各 5,292,044 B |
| 2 轨模式取 `stem=drums` | 409 Conflict（不假装有） |
| 4 轨 `/api/stems` | 200，`{"stems":4,…,"ms":6905}`（总 6906 ms） |
| 4 轨 drums / bass / other / vocals | 各 5,292,044 B |
| `stems=3` | 400 `{"state":"error","stems":2,"message":"stems 只允许 2 或 4"}` |
| `stem=foo` | 400 |
| 无 token | 401 Unauthorized |

**与离线 bench 的交叉校验**（同一模型、同一窗口）：

| 项 | 结果 |
|---|---|
| HTTP 落盘 `w000.<stem>.wav` vs `stems-bench/out/d30_0_<stem>_{l,r}.f32` | 四轨 corrL = corrR = **1.00000** |
| `inst − (drums + bass + other)` 相对残差 | **−74.26 dB**（16-bit 量化） |
| `meta.json` | `"stems": 4`，`modelSha256` 与 `StemSeparationService.ModelSha256` 一致 |

复现：`python .scratch/stems-e2e/make-probe.py` → 构建并拍平 dll（见 `.scratch/stems-e2e/README.md`）→
`artifacts/stems-e2e-rt/StemsE2E.exe <probe.wav>` → 期望末行 `TOTAL 12/12`。
清理：结果落 `%LOCALAPPDATA%\Zilux2\stems\<sha1>\`，按 `meta.json` 的 `trackKey`（`local:probe*.wav`）删干净。

## §12 真实素材复测（MUSDB18-HQ 四轨分离结果）

材料不再是合成正弦，而是真曲分离出来的四轨：A = `BKS - Bulldozer`（40–70 s），B = `Girls Under Glass - We Feel Alright`（30–60 s），
即 `.scratch/musdb/*/out/d30_0_<stem>_{l,r}.f32`（44.1 kHz → 48 kHz 线性重采样、单声道）。脚本 `.scratch/transition-accept/measure_real.py`。

**口径调整（重要）**：C2 原口径「30–120 Hz 短时 RMS 的 max−min」是**受控材料**口径——合成信号的低音是持续 55 Hz 正弦，包络只随交叉曲线变化。
真实音乐里低音有换音、休止、鼓点，30 s 内单轨自然起伏就有 10 dB 以上，直接量等于在量歌。真实素材改用 **C2p**：
把实际混合低频 RMS 与「不相干功率和」`10log10(gA²·P_A + gB²·P_B)` 比，取窗口内最大偏差。
- 两轨低频不相关时这是物理正确值（equal-power 得 0 dB、linear 掉 −3 dB）；两轨相关时 linear 得 0 dB、equal-power 顶 +3 dB。
- 窗口取 **200 ms**：60 Hz 约 12 个周期、40 Hz 约 8 个周期。100 ms 只有 4–6 个周期，窄带相位会带出 7 dB 假波动；500 ms 会把 234 ms 的换手斜坡抹平。

| 场景 | 模板 | 小节 | C1 ms | C3 拍 | G1 | C2p（本轮） | C2p（旧整轨等功率） |
|---|---|---|---|---|---|---|---|
| std-8A-8A-128 | standard | 32 | 0.000 | 0.872 | ✅ | **1.404** | 4.106 |
| std-8A-9A-128 | standard | 32 | 0.000 | 0.872 | ✅ | **1.404** | 4.106 |
| vocal-first | vocalFirst | 16 | 0.000 | 0.846 | ✅ | **1.760** | 1.976 |
| double-drop | doubleDrop | 8 | 0.000 | 0.846 | ✅ | **1.618** | 1.632 |
| bass-only | bassOnly | 8 | 0.000 | 0.800 | ✅ | **1.618** | 1.632 |
| filter-build | filterBuild | 16 | 0.000 | 0.872 | ✅ | **1.404** | 1.976 |
| tempo-126-vs-128 | standard | 32 | 0.000 | 0.872 | ✅ | **1.404** | 4.106 |
| low-conf | bassOnly | 8 | 0.000 | 0.800 | ✅ | **1.618** | 1.632 |

- 最差 C1 **0.000 ms**、最差 C3 **0.872 拍**、G1 全 True、最差 C2p **1.760 dB < 2 dB** ⇒ `VERDICT: PASS`。
- 旧行为在同一材料上最差 **4.106 dB**（长 32 小节等功率在真实低频上顶到 +4 dB），本轮策略把最坏情形压到 1.76 dB。
- 结果文件：`.scratch/transition-accept/metrics-real.json`；复现：`python .scratch/transition-accept/measure_real.py`。
- 已知边界：`vocalFirst`（人声先换、低频后换）在 32 小节等功率上的对照值低于本轮，说明「曲线选择」不是万能——低频相关时才该用 linear，
  两轨低频不相关时 equal-power 才正确。当前实现按分轨固定 linear；**下一步可做「按两窗低频互相关选曲线」**（已记入 §13 待办）。

## §13 低频互相关自适应曲线（第 21 轮）

**问题**：模板里按分轨写死曲线（bass/drums = linear、other/vocals = equalPower）。§12 的 `vocalFirst` 1.760 dB 就是这条假设的反例：
两首真曲的低频**并不相关**，硬用 linear 会在换手中点掉 −3 dB；反过来两轨同源（同曲错位、同 loop、同低频持续音）时 equalPower 会顶 +3 dB。

**做法**：
- 新增 `web/src/core/correlation.ts`：`normalizedCorrelation(a,b)`（去均值 Pearson，短/NaN 一律 0）与 `lowBandCorrelation(a,b,sampleRate,cutoffHz=120)`（一阶低通后再相关）。
- `web/src/core/transitionPlan.ts`：`PlanInput.correlation?: Partial<Record<Stem, number>>`、`CORRELATION_THRESHOLD = 0.35`、`chooseCurve(rho, fallback)`——|ρ| ≥ 0.35 用 `linear`，否则 `equalPower`；ρ 缺失/非有限值保留模板默认（**不改变旧行为**）。

**真曲实测 ρ**（BKS `d30_0_*` vs Girls Under Glass `d30_0_*`，200 ms 窗外的整段统计）：drums 0.0185、bass 0.0133、other 0.0103、vocals −0.0020 ⇒ 全部远低于阈值，应走 equalPower。

**效果（同一批真实素材，C2p 越小越好）**：

| 场景 | 模板默认曲线 | 按 ρ 自适应 | 旧整轨等功率 |
|---|---|---|---|
| std-8A-8A-128 / std-8A-9A-128 / tempo-126-vs-128 | 1.404 dB | **1.313 dB** | 4.106 dB |
| vocal-first | 1.760 dB | **1.088 dB** | 1.976 dB |
| filter-build | 1.404 dB | **1.313 dB** | 1.976 dB |
| double-drop / bass-only / low-conf | 1.618 dB | **1.425 dB** | 1.632 dB |
| **最差** | 1.760 dB | **1.425 dB** | 4.106 dB |

- C1 仍全 0.000 ms、C3 仍 0.800–0.872 拍、G1 全 True ⇒ `VERDICT: PASS`。
- 证据：`corr-real.json`、`events-corr.json`、`metrics-real-corr.json`；复现：
  `CORR_JSON=corr-real.json EVENTS_OUT=events-corr.json node emit.cjs` →
  `EVENTS_IN=events-corr.json METRICS_OUT=metrics-real-corr.json python measure_real.py`。
- 单测：`web/tests/transitionCurve.test.cjs` 6 条（同相 1 / 反相 −1 / NaN 不传染 / 低通不伪造相关 / 阈值选曲线 / 给了 ρ 才覆盖且不影响旧行为）。

**尚未接线**：运行时 `resolveTransition` 目前拿不到 ρ——它需要两条 30 s 窗口的解码音频，而音频要到 `StemPlayer.load()` 之后才有。
下一步要么在 `/api/stems` 服务端顺手返回 `correlation`（解码已在服务端发生），要么让 `AdvancedSession.begin()` 在加载后重排事件。
今天交付的是「可测且已证明有效」的纯函数层 + 一份真实素材上的收益数据。

## 14. 第 22 轮：ρ 接到运行时（E6）

第 21 轮只让 `chooseCurve` **支持** 相关度，但 `resolveTransition` 在计划阶段拿不到 ρ —— 那时音频还没解码。第 22 轮把这条链接上：**先按模板规划并起播，解码后立刻按实测 ρ 重排一次事件**。

链路：

1. `web/src/audio/stemPlayer.ts` 新增 `monoSamples(stem, maxSamples = 192000)`：取首个窗口前 192k 采样（≈4 s @48k）左右平均，只读、不复制整窗。
2. `web/src/audio/advancedSession.ts` 在「回声时间跟拍」之前插入测量步：
   - `measureCorrelation(a, b)` 对 `['drums','bass','other','vocals']` 逐轨调用 `lowBandCorrelation(x, y, ctx.sampleRate || 48000, 120)`；
   - 任一侧没有 `monoSamples`（或 `correlation` 模块不可用）时返回 `{}`，不抛；
   - 测得后若调用方给了 `replan`，用新 ρ 重排事件，成功则**替换** `session.events` 并送进 `graph.applyAll`，失败/返回 null 一律沿用原事件。
3. `web/src/audio/installAdvancedHandoff.ts` 提供 `replan`：用 `resolveTransition({ mode:'advanced', analysisA, analysisB, positionMsA: startA*1000, correlation })` 重新规划；成功时日志打出每题曲线 `bass:equalPower drums:equalPower …`，失败只记日志。
4. `web/src/core/advancedTransition.ts` 的 `ResolveInput` 增 `correlation`，透传到 `planForMode`。

判据（`web/tests/advancedSession.test.cjs`）：

| 用例 | 断言 |
|---|---|
| replan 生效 | 同源 55 Hz 正弦 ⇒ `ρ_bass > 0.9`；`applyAll` 收到重排后的 2 条事件；`session.eventCount === 2` |
| replan 返回 null | 沿用原事件（`applyAll` 1 条），`session.correlation` 为空对象 |
| replan 抛错 | 异常被吞，仍用原事件，过渡照常起播 |

全量：`node --test web/tests/` → **204 pass / 0 fail**；`npx --no-install tsc --noEmit` → 0 error。

边界：测量只用首窗前 4 s，若那 4 s 恰好是纯鼓（无低频旋律）则 bass 的 ρ 不可靠——此时 `chooseCurve` 拿到的是「接近 0」，会选 `equalPower`，与「两首不同的歌」的默认假设一致，属安全侧。

## 15. 第 23 轮：模板自动选择纳入段落与能量（E7）

第 22 轮之前，`doubleDrop` / `vocalFirst` 只能由 UI 显式传 hint，自动档永远只出 `standard` / `bassOnly` / `filterBuild`。第 23 轮把**客观信号**接进来：

`web/src/core/transitionPlan.ts`：

- 新增 `sectionLabelAt(analysis, positionMs)`：段区间左闭右开，缺 `sections` 返回空串。
- `templateFor(compat, planHint, context)` 六条规则（按顺序）：
  1. 显式 hint 优先；
  2. `tempoDeviation > 6%` → `bassOnly`；
  3. `energyGap > 0.35` → `filterBuild`；
  4. `energyA ≥ 0.62 && energyB ≥ 0.62 && keyDistance ≤ 1` → **`doubleDrop`**（8 小节，四轨同时换手）；
  5. A 在 `outro` 或 B 在 `intro` → `standard`（32 小节，留铺垫）；
  6. 其余：调性允许人声 → `standard`，否则 `bassOnly`。
- `planTransition` 调用处传入 `{ energyA: a.energy, energyB: b.energy, labelA: sectionLabelAt(a, positionMsA), labelB: sectionLabelAt(b, 0) }`。

判据（`web/tests/transitionPlan.test.cjs`，5 条新用例）：

| 场景 | 期望 |
|---|---|
| 两首 energy 0.78 / 0.74，同调 | `doubleDrop`、`totalBars === 8`、动作里含 `vocals` |
| 0.80 / 0.30 | `filterBuild`（不会被「两首都热」误判） |
| A 段落标 `outro` | `standard`、`totalBars === 32` |
| 120 vs 132 BPM（差 10%） | `bassOnly`，动作只剩 `bass`/`drums` |
| `sectionLabelAt` 边界 | 0→intro、999→intro、**1000→climax**、5000→空串、缺 sections→空串 |

全量：`node --test web/tests/` → **209 pass / 0 fail**；`tsc --noEmit` → 0 error；`emit.cjs + measure.py` → `VERDICT: PASS`。

坑：夹具的 `downbeats` 只铺到 62 s，`positionMsA: 60_000` 会让「剩余下拍 < 2」分支先把模板压成 `bassOnly`（`fallback='fixedEqualPower'`），看起来像新规则没生效。测模板选择一律把位置放在曲中（30 s）。

## 16. 第 24 轮：回声甩尾真正接进运行时（E8）

发现：`web/src/core/djMoves.ts` 里 `vocalEchoThrowMove()` 会产生 `param:'delaySend'` 的自动化，`stemSwap.scheduleEchoThrow()` 也能把它翻成 `delaySend` + `duck` 事件，`stemGraph` 更是早就实现了 `case 'delaySend'`（送进 echo 总线）。但 **`schedulePlan()` 从来没有调用过 `scheduleEchoThrow()`** —— 手法库里的「人声回声甩尾」在运行时是死代码，`vocalFirst` 只是少换几轨而已。

改动：

1. `web/src/core/transitionPlan.ts`
   - `TransitionPlan` 增可选 `echo?: { startMs: number; lengthBeats: number }`；
   - `planTransition` 在 `template === 'vocalFirst'` 时生成 cue（挂在人声换手窗口起点，`lengthBeats = 1`；没有人声动作则挂 0）；
   - 新增内部 `actionWindowsOf(actions, barMs, beatMs)`，避免主入口依赖导出的 `actionWindows`。
2. `web/src/core/stemSwap.ts` `schedulePlan()`：`plan.echo` 存在时追加 `scheduleEchoThrow(...)` 的所有事件（`delaySend` ×2 + 对向 `duck`）。
3. `web/src/core/mixTransitionMode.ts`：新增手法键 `mixTransitionTemplate`（`auto | vocalFirst | doubleDrop`）、`MIX_TEMPLATE_ORDER/LABELS/HINTS`、`read/writeMixTransitionTemplate()`。刻意与模式键分开存——切回标准模式不该丢掉手法选择。
4. `web/src/ui/crossfadeDeck.ts`：`beginTimeline` 的交接请求带 `hint`（`templateHint()` 只在 `vocalFirst`/`doubleDrop` 时返回，`auto` 不带），这样用户选的「人声先行」会一路传到 `resolveTransition`。
5. `web/src/ui/app.ts`：快捷设置 → 过渡页新增「换手手法」分段控件（自动 / 人声先行 / 双歌齐响），写入 `mixTransitionTemplate` 并 toast 说明。

判据（`web/tests/`，本轮 +6 条）：

| 用例 | 断言 |
|---|---|
| `vocalFirst` 带 cue | `plan.echo.lengthBeats === 1`；`schedulePlan(plan)` 产出 **≥2 条 `delaySend`**，首条 `from=0 → to=0.6`，且存在 `duck` |
| 其他模板不带 cue | `standard/bassOnly/doubleDrop/filterBuild` 的 `plan.echo === undefined` |
| 手法键 | 默认 `auto`；`vocalFirst`/`doubleDrop` 往返；非法值回 `auto`；`MIX_TEMPLATE_ORDER` 顺序固定 |
| 请求透传 | `mixTransitionTemplate='vocalFirst'` ⇒ `requestHandoff` 收到 `hint:'vocalFirst'`；`auto` ⇒ `hint` 为 undefined |

全量：**214 pass / 0 fail**；`tsc --noEmit` 0 error；`emit.cjs + measure.py` → `VERDICT: PASS`。

边界：回声音量固定 0.6、甩 1 拍（`ECHO.divisionBeats=0.25` 决定 delay 时间另有其值），干声在下一小节线切断；`echoCut8` 模板（8 小节硬切 + 甩尾）仍未自动启用，需要时用 `vocalFirst` 或后续加模板。

## 17. 第 25 轮：回声甩尾的真实素材实测（E9）

上一轮把 `vocalFirst` 的回声接进了运行时，但只做了事件级断言（发了几条 `delaySend`）。这轮用 **MUSDB 真曲的 vocals 分轨**（`BKS - Bulldozer` 40–70 s，30 s、44.1k→48k）按运行时的真实参数渲染一遍：

- `delay = 60/BPM × 0.25 = 125 ms`（BPM 120）、`feedback 0.35`、`damp 3 kHz`、`send 0→0.6`（1 拍）→ 下一小节起 `0.6→0`（2 拍）；
- 干声在小节线 **5 ms** 内切断（与 `djMoves`/文档一致）；
- 甩尾起点取该曲人声最响的 2 s 窗口（不是前奏静音里）。

脚本：`.scratch/transition-accept/echo_probe.py`（`--sweep` 出参数扫描）。

| 指标 | 实测 | 判据 |
|---|---|---|
| 峰值增量（湿 vs 干） | **+0.294 dB** | ≤ +0.5 dB |
| 切断后 0.4 s 尾巴（相对送出段干声 RMS） | **−14.35 dB** | −35…−6 dB（可闻但不盖干声） |
| 回声高频（>6 kHz）相对干声 | **−32.64 dB** | ≤ −6 dB（阻尼生效） |

参数扫描（同一素材，尾巴/峰值增量）：

| feedback | damp 3 kHz | damp 4 kHz |
|---|---|---|
| 0.25 | −17.86 / −0.10 dB | −17.83 / −0.07 dB |
| **0.35** | **−14.35 / +0.29 dB** | −14.32 / +0.34 dB |
| 0.45 | −11.41 / +0.69 dB | −11.38 / +0.75 dB |
| 0.55 | −8.77 / +1.07 dB | −8.74 / +1.15 dB |

结论：现在的 0.35/3 kHz 处在「尾巴可闻（−14 dB）+ 峰值几乎不涨（+0.3 dB）」的拐点上；再往上调尾巴更响但开始吃余量（0.55 已 +1.1 dB）。**之所以选 0.35 不是拍脑袋**，是这张表。

`run-all.ps1` 已把这条纳入（`E9 回声甩尾（峰值/尾巴/阻尼）`），`-SkipStems` 也会跑。

判据：`run-all.ps1 -SkipStems` → `VERDICT: PASS`，其中
`node --test web/tests/` 214 pass / 0 fail、`tsc` 0 error、`E9 peak 0.294dB tail -14.35dB hf -32.637dB`。

## 18. 第 26 轮：WBS v2 覆盖检查（E10）

前 25 轮的判据都散在单测、指标 JSON 和本文里，靠人眼核对「WBS 每条到底有没有证据」容易漏。这轮把它做成可执行的门：

`.scratch/transition-accept/coverage.py` 把 `docs/zilux2-advanced-transition-wbs-v2.md` 的 49 条（T2-1…T6-5、C1/C2/C2p/C3、G1/G1b/G1c/G1d/G2/G3/G4/G5/G6、E1…E9）逐条对到**具体文件里的具体符号/数字**：

| 类别 | 证据形态 | 例 |
|---|---|---|
| 实现类（T*） | 代码里的关键符号 | `T3-2` → `web/src/audio/stemPlayer.ts` 含 `loadSpan` |
| 指标类（C*/G*/E*） | 验收文档里的实测值或测试用例名 | `G1b` → `web/tests/stemPlayerAudio.test.cjs` 含 `124.7059` |
| 人工类（E1） | 只标记「待人工」，不算失败 | 盲听 24 组 |

输出：

```
✅ T2-1 … ✅ E9
👤 E1    盲听 24 组非劣性
覆盖：48/49 有证据，1 待人工，0 缺失
VERDICT: PASS
```

已接进 `run-all.ps1` 作为 **E10**：

```
E10 WBS v2 覆盖检查  PASS 有证据 48/49，待人工 1，缺失 0
```

价值：以后改代码若把某个符号改掉（例如 `setRates` 改名），这条会立刻 FAIL，而不是等到某天发现进阶路径又变回死代码——第 2 轮那次「`setHandoffFactory` 无人调用」正是这类漂移。

本轮还修了脚本自身两个坑：①Windows 控制台 GBK 编码打 ✅ 会抛 `UnicodeEncodeError` ⇒ `sys.stdout.reconfigure(encoding='utf-8')`；②证据片段必须用**文件里真实存在的字面量**（`−35.55` 用的是 U+2212 减号、`恰好一组 source` 而不是「恰好 4 条」），第一次跑出 4 个假缺失就是这么来的。

判据：`run-all.ps1 -SkipStems` → `VERDICT: PASS`，`node --test web/tests/` 214 pass / 0 fail、`tsc` 0 error。

## 19. 第 27 轮：标准路径黄金值冻结（C0）+ DJUCED 式对照臂（E1b）

### 19.1 冻结标准等功率过渡（C0）

objective 的硬约束是「标准等功率过渡冻结不动」。之前只有端点（0/1）与 `a²+b²=1` 的断言——**换个写法只要满足功率守恒就能通过**，挡不住「等价重写」。

新增 `web/tests/transitionStandardGolden.test.cjs`（5 条），把 `web/src/ui/transitionMath.ts` 的输出钉成字面量：

| progress | gainA | gainB |
|---|---|---|
| 0 | 1 | 0 |
| 0.25 | 0.9238795325112867 | 0.3826834323650898 |
| 0.5 | 0.7071067811865476 | 0.7071067811865476 |
| 0.75 | 0.38268343236508984 | 0.9238795325112867 |
| 1（及 >1） | 0 | 1 |

另外锁三件事：①`MATCHED_OVERLAP_END === 0.82` 且 `naturalGains(0.41, 0.82)` 恰在中点；②200 个采样点上 `a²+b²-1 < 1e-12`；③A 不增、B 不减（单调）；④`smoothProgress(0.25)=0.15625`、`nearestTempoRatio(1.5)=0.75`、`(0.667)=1.334`、`(0)=1`、`(NaN)=1`。

任何对公式的改动（含「看起来等价」的重写）都会在第一个断言上失败。

### 19.2 DJUCED 式对照臂（E1b）

objective 写的是「盲听对比 **DJUCED** 20 次选优≥50%」，但此前的夹具只对比「标准 vs 进阶」，没有 DJUCED 这一臂。这轮补上：

`render_pairs.py` 增加 `--style kill`，按 DJUCED 打垫的真实行为渲染对照组——**每轨在小节线上 5 ms 硬切，错开进入**（bass 第 0 小节、drums 第 2、other 第 4、vocals 第 8），没有曲线、没有等功率交叉：

```
def render_kill(a, b, seconds, beat_ms=BEAT_MS, ramp_ms=5.0):
    at_bar = {"bass": 0, "drums": 2, "other": 4, "vocals": 8}
```

于是盲听变成两轮、各 24 组：

| 轮次 | 目录 | 对照组 |
|---|---|---|
| 1 | `.scratch/listen/out-real` | 整轨等功率（我们原有的过渡） |
| 2 | `.scratch/listen/out-real-kill` | DJUCED 式逐轨硬切 |

复现：

```powershell
cd E:\Zilux2开发\.scratch\listen
python render_pairs.py --a ../musdb/bks/out --b ../musdb/gug/out `
  --a-prefix d30_0_ --b-prefix d30_0_ --seconds 16 --pairs 24 --style standard --out out-real
python render_pairs.py --a ../musdb/bks/out --b ../musdb/gug/out `
  --a-prefix d30_0_ --b-prefix d30_0_ --seconds 16 --pairs 24 --style kill     --out out-real-kill
```

### 19.3 顺手修掉的响度偏差（会影响盲听结论）

原 `write_wav` 对每个文件**各自**按峰值归一化到 −1 dBFS。两个文件峰值不同 ⇒ 缩放系数不同 ⇒ 之前对齐好的 RMS 被重新拉歪。实测某组差到 **0.96 dB**——「更响的赢」是盲听里最脏的偏差，足以把非劣性结论翻掉。

改为 `write_pair()`：**同一组的两个文件共用一个缩放系数**（取两者峰值），RMS 关系原样保留。

修完实测（24 组，左声道）：

| 目录 | max \|dB\| | mean \|dB\| |
|---|---|---|
| `out-real`（standard） | 0.493 | 0.209 |
| `out-real-kill`（kill） | 0.493 | 0.209 |

两轮都落在设计目标「±0.5 dB 内」且均值 0.21 dB（随机项均值）。

### 19.4 判据

```
node --test web/tests/        PASS pass=219 fail=0     （+5 条黄金值）
tsc --noEmit                  PASS 0 error
过渡指标 (emit+measure)       PASS C1max=0ms C3max=0.872拍
E9 回声甩尾（峰值/尾巴/阻尼）  PASS peak 0.294dB tail -14.35dB hf -32.637dB
E10 WBS v2 覆盖检查           PASS 有证据 50/51，待人工 1，缺失 0
VERDICT: PASS
```

覆盖条目从 49 增到 51（新增 `C0` 标准冻结、`E1b` DJUCED 对照臂），仍只有 `E1` 待人工。

## 20. 第 28 轮：分离确定性（E12）+ 一个真 bug：缓存不认源文件变更（E11）

### 20.1 E12 确定性 / 线程无关（PASS）

`.scratch/stems-bench/determinism.py`：同一混音（`BKS - Bulldozer` 40–70 s，7.8 s 窗）、同一模型，跑三次——threads=4、threads=4、threads=1，逐文件比 SHA-256：

| 运行 | 合并哈希（前 16 位） | 文件数 |
|---|---|---|
| run1 threads=4 | `5fce922c43c257f0` | 8 |
| run2 threads=4 | `5fce922c43c257f0` | 8 |
| run3 threads=1 | `5fce922c43c257f0` | 8 |

`run1==run2`（确定性）YES、`run1==run3`（线程无关）YES、差异文件：无 ⇒ **VERDICT: PASS**。

这条是 objective 里「旧 2 轨逐字节不变」的底座：分离本身对输入与线程数确定，四轨改造才可能不扰动旧路径。配合 20.3 的字节比对，构成闭环。

### 20.2 E11：缓存不认源文件变更（真 bug）

给 E2E 加两条断言时抓到的：

- **2 轨/4 轨 vocals 逐字节相同** —— 通过（`5,292,044 B 完全一致`）；
- **`inst ≈ drums+bass+other`** —— 第一次跑报 **−28.96 dBFS**，远超重构底噪（应 ≈ −35 dB 量级），第二次跑又变成 **−74.26 dBFS**。

同样的代码、同样的输入，两次差 45 dB ⇒ 不是算法问题，是**数据来源不同**。查缓存目录发现：`%LOCALAPPDATA%\Zilux2\stems\<sha1>\meta.json` 的 `trackKey` 是 `local:probe.wav`（**路径**），`TryReadCache` 只校验 `modelSha256`/`stems`/窗口，**不看源文件是否变过**。

复现（可重放）：

1. 请求一次 `GET /api/stems?source=local&rel=media/probe.wav&window=0`，正常算、落盘；
2. 把同名 `probe.wav` 的内容换成**反向音频**（时长/采样率/位深不变）；
3. 再请求同一 URL → `117 ms` 返回 `{"state":"ready","cached":true}`，**给的是旧文件的分离结果**。

这正是第一次 −28.96 dB 的来源：`inst` 来自旧缓存、`drums/bass/other` 来自新一次计算。对用户的后果不是"多算一次"，而是**分轨与音频对不上**——在进阶过渡里就表现为鼓点位置漂移、人声残留。

修复方向（已派给后端）：meta 记 `sourceBytes` + `sourceModifiedUtc`，读缓存时 stat 源文件比对，不一致即 miss 重算；旧 meta 缺字段一律 miss；**不把 size/mtime 塞进 trackKey**（那会让每次 touch 都换目录、LRU 碎裂）。

### 20.3 E2E 断言扩到 14 项

`StemsE2E` 新增两条：

| 断言 | 结果 |
|---|---|
| 2轨/4轨 vocals 逐字节相同 | PASS（5,292,044 B 一致） |
| `inst ≈ drums+bass+other`（≤ −25 dBFS，受 Σ4−mix 重构底噪限制） | PASS（−74.26 dBFS） |

阈值说明：不是 0 也不是 −60。`inst = mix − vocals` 与 `drums+bass+other` 的差正好等于四轨重构残差（G4 实测 −35 dB 量级）；定 −25 dB 既抓得住「两轨路径被改坏」（会掉到 −5…0 dB），也不会被模型自身底噪误判。

### 20.4 E11 修复与端到端复验（PASS）

后端（`stems-backend`，T2-7）实现 + 我独立复验：

| 改动 | 位置 |
|---|---|
| meta 增 `sourceBytes` / `sourceModifiedUtc` | `src/Zilux2/Stems/StemsModels.cs:252/254`（读写 `:300-306`/`:342-348`） |
| 落 meta 前取源文件身份 | `src/Zilux2/Stems/StemSeparationService.cs:323-335`（`ReadSourceIdentity :567`） |
| 读缓存加身份门禁 | `:514 TryReadCache`、`:706 TryFindCachedAudio`（`SourceMatches :593`） |
| 解析回调暴露给分离服务 | `src/Zilux2/Analysis/TrackAnalysisService.cs:62 ResolveLocalPath`（+6 行，最小改法） |

判据（我这边亲自跑，不是转述）：

```
dotnet build src/Zilux2/Zilux2.csproj -c Debug -p:OutputPath=artifacts\lead-verify\   → 0 警告 0 错误
dotnet StemsVerify.dll（探针）                                                        → 81 PASS / 0 FAIL（含 T2-7 七条）
StemsE2E.exe（真 socket + HttpClient）                                                → 16/16 PASS
```

E2E 新增的三条端到端断言（含缓存预热、改写、重算）：

| 断言 | 结果 |
|---|---|
| 源文件改写后不命中缓存 | PASS（`cached:false`，6.8 s 真重算） |
| 改写后 vocals 与改写前不同 | PASS |
| 2轨/4轨 vocals 逐字节相同 | PASS（5,292,044 B 一致） |

### 20.5 顺手修掉一个「状态码随缓存历史变化」的契约问题

E2E 第一次跑出 `2轨模式下取 drums = OK`：因为窗口此前被别的请求以 `stems=4` 算过，磁盘上已存在 `w000.drums.wav`，于是 `stems=2` + `stem=drums` 也能取到。**同一请求因历史不同返回 200 或 409**，不可复现。

在 `HandleStemsAudioAsync`（`src/Zilux2/Online/LocalMusicServer.cs`，stem 白名单之后）加显式门禁：

```csharp
if (request.Stems < 4 && stem is "drums" or "bass" or "other")
    return WriteStemsError(context, 409, request.Window, "busy",
        $"stems={request.Stems} 只提供 vocals/instrumental；要 {stem} 请带 stems=4");
```

复验：缓存**已含 4 轨**的状态下再跑 E2E（同一份缓存、同一进程外），该条仍稳定 `Conflict`，16/16 PASS；后端探针 81 PASS 无回归。

### 20.6 一处数字更正

`inst ≈ drums+bass+other` 的实测值在不同素材上差很多：合成探针时代是 **−74.26 dBFS**，换成 MUSDB 真曲后是 **−28.96 dBFS**。后者才是真曲的常态——它等于四轨重构残差（Σ4−mix，G4 实测 −35 dB 量级）加上三次 16-bit 量化的合成误差。判据因此定 **≤ −25 dBFS**，而不是 −60。文档里旧的 −74.26 保留但注明是合成素材。

### 20.7 E13 跨层接线集成（又抓到一个「声明了没实现」）

单测里 `crossfadeDeck` 拿到的实例一直是**替身 handoff**，所以「安装器 → 会话 → 播放器/图」这条链的契约从没被真跑过。新增 `web/tests/advancedIntegration.test.cjs`：加载**真** `installAdvancedHandoff.ts` + 真 `advancedSession.ts` + 真 `advancedTransition/transitionPlan/tempoGate/stemSwap/djMoves`，只把播放器、图、AudioContext 换成记账假件。

首跑就抓到第二个同类缺陷：

| 现象 | 根因 | 修复 |
|---|---|---|
| `handoff.remainingSec is not a function` | `Handoff` 接口声明了 `remainingSec?()`，`installAdvancedHandoff` 的返回对象**没实现**；`crossfadeDeck:3001` 写的是 `plan.advanced.remainingSec ? plan.advanced.remainingSec() : null` ⇒ 生产里恒为 `null`，**G6 静场兜底从不触发**（G6 单测用的是替身 handoff，所以一直绿） | 补实现：`remainingSec(): number | null` 读 `session.remainingSec`，非 active/非有限值返回 null |

现在这条集成用例断言的东西（都是跨层契约，单层单测覆盖不到）：

- 一条 deck 一个 `StemPlayer`（内部四轨），两条 deck **共用同一个 `when`**；
- `applyAll` 收到非空事件表且起点等于 `when`；
- 两条 deck 都设了回声时间；
- `whenReady()` 在链路走完后为 `true`；
- `setRates({a,b})` 各走各的播放器（A 跟 A、B 跟 B）；
- `remainingSec()` 返回真实值；`cancel()` 两次只拆一次（幂等）。

判据：该文件 2 pass；全量 `node --test web/tests/` **221 pass / 0 fail**；`tsc --noEmit` 0 error；覆盖 53/54（0 缺失）。

### 21. E14 预热预算：每侧串行 + 同窗去重（第 30 轮）

**问题**：`prefetchStemSpan` 原来把整段窗口 `Promise.all` 一股脑打出去——32 小节模板在 128 BPM 是 60 s，即 2 窗；`MAX_SPAN_WINDOWS=4` 时是 **4 窗 × 2 deck = 8 条 `/api/stems?stems=4` 并发**。宿主每窗都要建一次分离会话（真曲峰值工作集约 2.8 GB），并发只会让内存翻倍，而且真正要用的第一窗被排到队尾。

**改法**（`web/src/audio/advancedReadiness.ts`）：

| 项 | 之前 | 现在 |
|---|---|---|
| 窗口调度 | `Promise.all(所有窗)` | **每条 deck 内部串行**，两条 deck 之间并行 ⇒ 全局面向上限 2 |
| 重复预热 | 每次 `prepareCrossfade` 都重新请求 | 模块级 `inflight: Map<键, Promise>`，同键复用同一个在途请求 |
| 失败原因 | 异常被吞成 `false` | `prepareOnce` 把异常抛给调用方，`result.error` 里保留原始 message（如「模型缺失」） |
| 清理 | — | `resetStemReadiness()` 同时清 `inflight`；`task.then(cleanup, cleanup)` 两边都接，避免 unhandledRejection |

**判据**（`web/tests/advancedReadiness.test.cjs`，13 条）：

- 3 窗 × 2 deck：`prepare` 调用 6 次、**峰值并发 2**、顺序 `a#0 b#0 a#1 b#1 a#2 b#2`；
- 同键并发两次 `prefetchStemSpan`：只发 4 次请求（2 窗 × 2 deck），第二次复用第一次的在途 Promise；
- 同曲同位置的 A/B 两侧：窗口键相同 ⇒ 三窗各算一次（`computed=2`，窗 1 命中缓存）；
- 单窗失败 ⇒ 该侧 false、另一侧 true、`error` 指出「A 侧」，**已成功的窗口仍然登记**。

判据：`node --test web/tests/` **224 pass / 0 fail**；`tsc --noEmit` 0 error；覆盖 54/55（0 缺失）。

## 25. 一键盲听入口（E1 的实施工具）

E1 是唯一需要人耳的验收项，之前要用户自己 `python -m http.server` 再拼 URL。现在一条命令：

```
python .scratch/listen/listen.py            # 进阶 vs 整轨等功率（out-real）
python .scratch/listen/listen.py out-real-kill   # 进阶 vs DJUCED 式硬切
```

`listen.py` 做三件事：挑一个空闲端口起标准库 `http.server`（`file://` 下 `fetch('index.json')` 会被 CORS 拦，必须走 http）、把带 `?set=` 的地址打到控制台、1 s 后自动打开浏览器。听完在页面底部导出 `answers.json`，丢进 `.scratch/listen/` 后 `python .scratch/listen/score.py answers.json` 出结论（胜+平占比 + 95% Wilson 区间，判据 ≥ 50%）。

**本轮同时修掉一个会让盲听直接开不了的 bug**：`listen.html` 之前写死 `fetch('index.json')`，而 `index.json` 实际在 `out-real/` 子目录里 —— 从仓库根的 `.scratch/listen` 起服务时请求到 `/index.json`（404），页面只显示「index.json 读不到」。改为按 `?set=` 拼前缀（`base = set + '/'`），音频 `src` 同样走前缀；兼容老用法（直接把 `out-real/` 当根起服务时 `base` 为空）。

自检（Playwright + 本机 Edge，脚本用完即删）：打开 `listen.html?set=out-real` → 服务端日志出现 `GET /out-real/index.json 200`，计数显示 `0 / 24`，控制台除 `favicon.ico` 404 外无错误 ⇒ 页面可用。

## 26. 界面分组一致性（E20）：一个不会抛错的漏登记

快捷设置按「播放 / 音效 / 试听 / 过渡」四页分栏，靠的是给每行打 `data-group` 再切 `is-group-hidden`。第 24 轮新增的「换手手法」只写了 `cell('换手手法', …)`，**忘了在 `groupOfTitle` 里登记** —— 这类漏登记不会报错、不会抛异常、tsc 也查不出来，后果是那一行永远显示在四个分页上（用户只看到「怎么多了个换手手法」）。

修法：`web/src/ui/app.ts` 的分组表补 `['换手手法', 'transition']`。

防回归：新增 `web/tests/quickSettingsGroups.test.cjs`（3 条，把 `app.ts` 当数据源做集合比较）：①每个 `cell('标题', …)` 都有分组（缺了就报出标题列表）②四个分页都至少有一行 ③分组表项数不少于界面行数（反向不加断言，因为「均衡器」是独立 section 标题、不是 cell）。

有效性自证：临时删掉 `['换手手法', 'transition']` 这一行，测试立刻报「这些行没有分组，会出现在所有页面上：换手手法」；恢复后 3 pass。

## 22. E21：死导出审计与「稳妥档」语义

### 22.1 为什么要做

前 20 多轮的判据都是「某功能算得对」，但没有一条判据问过：**这段代码在运行时到底有没有被调用**。
历史上已经发生过三次同类事故，都是靠人眼/偶然 grep 发现的：

| 事故 | 症状 | 发现的轮次 |
|---|---|---|
| `setHandoffFactory` 全仓库无调用方 | 整条进阶路径是死代码 | 第 2 轮（grep 偶然） |
| `remainingSec` 接口声明了没实现 | G6 静场兜底从不触发 | 第 29 轮（E13 集成用例） |
| 「换手手法」未登记分组 | 该行出现在所有设置页 | 第 37 轮（E20 人工发现） |

E21 把这件事变成可执行的门：扫描本次涉及的 15 个模块里所有 `export function/const/class/let`，
统计标识符在全仓 `web/src`（含定义行）的出现次数，`<= 1` 即「只有定义、没人用」。

### 22.2 审计结果与处置

首轮报 6 条，逐条核对后**两条真缺口**、两条「声明未接线」、两条重复/冗余：

| 导出 | 判定 | 处置 |
|---|---|---|
| `mixTransitionMode.wantsStemSwap` / `allowsDegradedSwap` | **真缺口**：`installAdvancedHandoff` 把 mode 简化成 `standard / advanced`，`advancedSafe` 与 `advanced` 行为完全相同 | 接线：模式映射改用 `wantsStemSwap`，并新增稳妥档门禁（见 22.3） |
| `advancedTransition.fallbackToStandard` | 兜底文案有实现没调用（catch 里自己拼字符串） | 接线：catch 分支改用 `fallbackToStandard(error)` 取统一 summary |
| `djMoves.filterSweepMove` / `humanize` / `MOVE_TEMPLATES` / `expandMoves` | **设计预留**：运行时换手走 `transitionPlan.actionsFor`，这套「按手法编排 + 手感抖动」从未接线 | 保留 + 在文件里加横幅注释说明「设计预留 API」，审计脚本按 `djMoves.` 前缀放行，并写进已知边界 |
| `transitionPlan.TRANSITION_MODE_LABELS` | 与 UI 在用的 `MIX_TRANSITION_LABELS` 重复，且无人引用 | 删除 |

### 22.3 稳妥档语义（本轮唯一行为变更）

```ts
// web/src/audio/installAdvancedHandoff.ts
resolved = resolveTransition({
  mode: wantsStemSwap(request.mode) ? 'advanced' : 'standard',
  ...
});

// 「进阶·稳妥」档：置信度没到 full 就当场回落标准，
// 不允许像 advanced 那样降级成「只换低音+鼓」。
if (!allowsDegradedSwap(request.mode) && resolved.gate && resolved.gate.tier !== 'full') {
  log(`稳妥档要求置信度 full，本次判定 ${resolved.gate.tier}，回落标准过渡`);
  return null;
}
```

用例（`web/tests/advancedIntegration.test.cjs`，真模块链路）：
`bpmConfidence = 0.5`（tempoGate 判 `bassDrumsOnly`）时——
`mode='advancedSafe'` ⇒ `requestHandoff` 返回 `null` 且日志含「稳妥档」；`mode='advanced'` ⇒ 正常产出 handoff。

### 22.4 判据

```
node --test web/tests/                228 pass / 0 fail
npx tsc --noEmit                      0 error
node .scratch/transition-accept/dead-exports.cjs
  死导出审计：0 条（未被白名单豁免的运行时代码导出都有引用）
coverage.py                           60/61 有证据，1 待人工，0 缺失
```

### 22.5 已知边界（明确不做的部分）

- `djMoves` 的 8 个 move、`MOVE_TEMPLATES`、`expandMoves`、`humanize` 仍是**设计预留**：接线的正确时机是
  `stemGraph` 支持 `hpf/lpf` 自动化之后（当前 `Automation.param` 里的 `hpf|lpf` 没有对应的音频节点）。
- 因此「滤波扫频」「手感抖动（±12 ms）」目前**只有设计，没有运行时效果**；运行时的人是靠
  `schedulePlan` 的逐轨换手 + 回声甩尾 + 侧链躲避体现的。

## 23. E22：滤波扫频接线（`filterBuild` 从「只是换手」变成真的有扫频）

### 23.1 为什么做

第 38 轮的死导出审计列出：`djMoves.filterSweepMove` 与 `MOVE_TEMPLATES` 全是设计预留，
运行时没有任何滤波自动化；而 `filterBuild` 这个模板名承诺的是「A 热 B 冷，先把 B 压成窄带再放出来」，
实际动作只是把换手排得更靠后——**名不副实**。

### 23.2 改动

| 层 | 改动 |
|---|---|
| `core/transitionPlan.ts` | `TransitionPlan` 增 `filter?: { startMs; lengthBeats; fromHz; toHz }`；`template === 'filterBuild'` 时生成，`fromHz: 320`、`toHz: 18000`、`lengthBeats = max(8, 最后一个动作结束时的小节数 × 4)` |
| `core/stemSwap.ts` | 新事件类型 `FilterEvent { kind:'filter'; deck; atMs; durationMs; fromHz; toHz }`；`schedulePlan()` 在 `plan.filter` 存在时排一条 |
| `audio/stemGraph.ts` | 每台 deck 的总线由 `bus → duck` 改为 `bus → hpf → duck`（新增 1 个 `highpass` BiquadFilter，默认 20 Hz、Q 0.707）；`apply()` 支持 `case 'filter'`，用 `exponentialRampToValueAtTime` 扫频（等比的听感）；`dispose()` 一并断开 |

### 23.3 一个必须记下来的坑

扫频起点**不能**取「当前值」：高端滤波器的默认 `frequency = 20 Hz`（等于全开），
按当前值起扫的话 B 从第一拍就是全开，扫频等于没发生（单测第一版就踩了这个，`set` 到 20 Hz）。
正确做法是直接把起点写成 `fromHz`（320 Hz），先 `hold()` 取消旧自动化再 set + ramp。

### 23.4 判据

单测（纯函数/记账层）：

```
plan.filter.fromHz === 320 && toHz === 18000 && lengthBeats >= 8   （filterBuild）
std.filter === undefined                                            （standard 不带）
schedulePlan → 恰好 1 条 kind==='filter'，deck='B'，durationMs = lengthBeats × beatMs
DeckStemBus.apply(filter, start=10s) → set(320, 11.0s) + exp(18000, 15.0s)
```

真浏览器（Playwright + `OfflineAudioContext`，白噪声过 `other`，4 s 扫频，用过零率当亮度代理）：

| 窗口 | 过零率 |
|---|---|
| 0.3–0.7 s（起点，320 Hz） | 0.5013 |
| 1.8–2.2 s（中段） | 0.5201 |
| 3.5–3.9 s（终点，18 kHz） | 0.6849 |

单调上升、末端/起点 = **1.37×** ⇒ `VERDICT: PASS`（probe.json `derived.filterZcr` / `filterZcrRise`）。

### 23.5 边界

- 扫频只作用于**进场 deck 的高通**，没有做 A 侧的低通关门（那属于另一种手法，`djMoves` 里仍为设计预留）。
- 节点数从 38 变 40（每台 +1 hpf、+1 连接），`stemGraphLifecycle.test.cjs` 的计数断言已同步更新。

## 24. E23：出场侧关门（低通）——`filterBuild` 的对称另一半

### 24.1 为什么做

E22 只做了「B 从闷到亮」（高通开门）。真 DJ 的滤波过渡是**双向**的：一手把 B 从窄带放出来，
另一手把 A 推进低通里变闷——否则 A 在全频段上继续响，扫频的对比感就弱一半。
`djMoves.filterSweepMove` 的设计里本来就有这层，本轮补上。

### 24.2 改动

| 层 | 改动 |
|---|---|
| `core/transitionPlan.ts` | `filterBuild` 同时产出 `filterOut { 20000 → 700 Hz, 与 filter 同长度 }` |
| `core/stemSwap.ts` | `FilterEvent` 增 `band?: 'highpass' \| 'lowpass'`；`schedulePlan` 排两条：B 高通开门、A 低通关门（`deck: source`） |
| `audio/stemGraph.ts` | 每台 deck 再 +1 个 `lowpass`（默认 20 kHz、Q 0.707），链路变成 `bus → hpf → lpf → duck`；`apply('filter')` 按 `band` 选节点 |

### 24.3 判据

单测：`filterBuild` 排 2 条 filter（`B/highpass/320→18000`、`A/lowpass/20000→700`，各自 `durationMs = lengthBeats × beatMs`）；
`standard` 一条都没有；节点数 42（每台 21）、连接数 52。

真浏览器（白噪声走 A 的 `other`，低通 20 kHz→700 Hz，4 s）：

| 窗口 | 过零率 |
|---|---|
| 0.3–0.7 s（起点，全开） | 0.3681 |
| 1.8–2.2 s（中段） | 0.1394 |
| 3.5–3.9 s（终点 700 Hz） | 0.0372 |

单调下降、起点/末端 = **9.9×** ⇒ PASS（`probe.json` 的 `derived.filterOutZcr` / `filterOutZcrDrop`）。
同时 B 侧开门仍为 0.4679 → 0.4906 → 0.6562（1.4×），两侧方向相反、互不干扰。

### 24.4 边界

- 两条扫频共用同一时长（都在 `filterBuild` 的整段过渡里），没有做「A 先关完再开 B」的错位编排——
  错位属于 `MOVE_TEMPLATES` 的设计预留范围。
- 20 kHz 低通的默认状态在 48 kHz 采样率下略有空气感衰减（可忽略，−0.05 dB @ 16 kHz）。

## §25 E24：听测暴露的两个真缺陷（B 起播满增益、人声同框）

用户盲听反馈「进阶完全是两首歌一直在播放」「人声很压抑、像变调」。查证后是两个真缺陷，都在**运行时**，不是素材凑巧：

### 25.1 进场 deck 起播就是满增益

`AdvancedSession.begin()` 起播时两条 `StemPlayer` 都用默认增益 1.0，而第一条 `gainCurve` 要等到该分轨的换手窗口（标准模板 32 小节时，人声要到第 8 小节）。
后果：B 从 0 秒起就整轨出声，A 也在响 —— 正是「两首歌一起播」。

修法：`DeckStemBus.resetGains(value)` + `StemGraph.resetDeckGains(deck, value)`，`begin()` 在起播前设 `A=1.0 / B=0.0`。

### 25.2 人声是交叉淡入，两把人声同框 → 颤音打架（听感「压抑 / 变调」）

原实现在 1 拍内做等功率交叉，两把不同歌的人声重叠约 0.87 拍。
修法（`schedulePlan.pushVocalCut`）：人声改成**顺序交接**——出场先 45% 时长落到 0，留 8%（10–40 ms）空隙，进场再起。C3 从 **0.872 拍 → 0.000 拍**；其他三轨保持交叉。

### 25.3 判据

| 项 | 修前 | 修后 |
|---|---|---|
| 进场 deck 起播增益 | 1.00（全轨出声） | 0.00 |
| C3 人声重叠 | 0.872 拍 | **0.000 拍** |
| 单测 | 231 pass | 231 pass（快照与顺序断言同步更新） |

复现：`node .scratch/transition-accept/emit.cjs && python .scratch/transition-accept/measure.py` → `worst C3=0.000 beat`。
