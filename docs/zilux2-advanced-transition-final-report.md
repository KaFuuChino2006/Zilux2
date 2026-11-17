# Zilux2 进阶智能过渡 · 验收报告（终稿）

> 目标：在**冻结标准等功率过渡**的前提下，新增可选的「进阶模式」，把整轨 `cos/sin` 交叉换成
> **按分轨（drums / bass / other / vocals）逐轨换手 + 拍级同步 + 人声避开**，并对齐 DJUCED 的
> 听感形态（不是换引擎，而是换链路形态）。
>
> 判据口径以 `docs/zilux2-advanced-transition-wbs-v2.md` §8 为准。
> 复现：`pwsh .scratch/transition-accept/run-all.ps1`（加 `-SkipStems` 可跳过分离质量段）。

---

## 1. 结论

| 维度 | 状态 | 一句话 |
|---|---|---|
| 分轨换手（4 轨） | ✅ | 后端出 4 轨、前端 4 源同步起播、逐轨换手有曲线与侧链 |
| 拍级同步 | ✅ | PLL 用相位目标（非速率累加），7 拍内收敛到 ±5 ms |
| 互斥/回退 | ✅ | 进阶期原元素静音；失败 20 ms 斜坡回退，无咔哒 |
| 门控降级 | ✅ | 三档 `full / bassDrumsOnly / standard`，standard 档不请求 4 轨 |
| UI | ✅ | 三档开关 + 试放台「分轨换手预案」四泳道时间线 |
| 离线指标 | ✅ | C1/C2/C3/C4/G1~G5 全部达标（见 §3） |
| 真机 E2E | ⏸ 待条件 | 需先停掉正在运行的 Zilux2 实例 |
| 盲听非劣性（E1/E2） | ⏸ 需本人 | 24 组 A/B 要你亲自听，脚本已就绪 |

一句话：**代码侧全部落地并有可复现判据；剩两项依赖你的机器状态与耳朵。**

---

## 2. 逐条 WBS 对照

### T2 · 后端 4 轨 API

| 工单 | 落地 | 证据 |
|---|---|---|
| T2-1 落盘 4 轨 | `HtdemucsSession.StemCount=4`（0=drums/1=bass/2=other/3=vocals）+ `StemSeparationService.WriteFourStem` | 探针 74 PASS；`inst` 与三轨和残差 **−90.31 dBFS** |
| T2-2 状态体带轨数 | `StemsModels.Stems` + JSON 键 `"stems"` | 探针矩阵覆盖 `stems=2/4` 键集 |
| T2-3 白名单扩展 | `LocalMusicServer.cs:1037` 五值 `vocals|instrumental|drums|bass|other` | 10 组 409/200 矩阵 |
| T2-4 缓存 schema | `StemsMeta.Stems`；旧 meta 不命中；`flightKey` 带 `|s{N}` | meta 三态复用用例 |
| T2-5 上限与淘汰 | `StemCacheLru`（目录级 LRU + `Pin/PinLease`） | 钉住/淘汰/上限用例 |
| T2-6（追加）配置面 | `CachePolicy.MaxStemCacheMb` + `GET /api/storage/cache` 四键 + `POST .../limit {maxStemCacheMb}` + web 设置行「分离缓存上限 (MB)」 | `verify-t2-6.log` 15 条新增判据 |

### T3 · 前端音频层

| 工单 | 落地 | 证据 |
|---|---|---|
| T3-1 单入口 → 每轨入口 | `StemGraph.inputOf(stem)` / `connectSource(stem,node)`；`STEM_ORDER` | `stemGraphLifecycle.test.cjs`（38 节点/48 连接） |
| T3-2 StemPlayer | 四源同一 `when`/同一偏移；缺轨整体失败 | `stemPlayerAudio.test.cjs` 6 条 |
| T3-3 无跳变调度 | `hold()` 优先 `cancelAndHoldAtTime`；`scheduleStemDuck` 逐轨侧链 | 生命周期测试 + 侧链用例 |
| T3-4 delay 定参 | `ECHO.divisionBeats=0.25` + `echoDelaySec(bpm)`（越界回落 120） | `transitionPlan`/`transitionPerformer` 用例 |
| T3-5 时间基准统一 | `applyAll(events, startSec)` 容差门禁（NaN/过期整批丢弃）；`nowSec()` 时钟兜底 | `applyAll` 边界 5 例 |
| T3-6 PLL 接入 | `trackRate()` 相位目标控制；`beatPhaseError()`；分轨路 `setRate` 相对修正 | 双积分器回归 + `bRate` 用例 |

### T4 · 接入 crossfadeDeck

| 工单 | 落地 | 证据 |
|---|---|---|
| T4-1 模式读取 | `mixTransitionMode`（避开壁纸占用的 `transitionMode`）+ `CrossfadeSettings` 投影 | `mixTransitionMode.test.cjs` |
| T4-2 决策插入点 | `installAdvancedHandoff()` 装工厂；`beginTimeline` 同一 `clock` 起 `start()` | 接线用例（分析/曲目/元素/位置/key） |
| T4-3 互斥静音 | `muteDeckElementsForAdvanced` + `restoreDeckGains`（图 gain 压制，`element.volume` 对 tap 无效） | G5 用例 |
| T4-4 回退不跳变 | `fallbackFromAdvanced` 先按 `progress` 写 `naturalGains` 再重排；20 ms `rampDeckVolume` | G2 用例（200 段步长 <0.02） |
| T4-5 生命周期 | `finishFade`/`cancelCrossfade`/`hardCutToStandby` 三处 `disposeAdvanced`（幂等） | G3（38/38、二次 dispose 不重复断） |

### T6 · 门控与拍族

| 工单 | 落地 | 证据 |
|---|---|---|
| T6-1 候选打分 | `scoreCandidates`：`0.55·exp(−2.5|log2 r|)+0.30·downbeat+0.15·phrase` | `tempoGate.test.cjs` 10 条 |
| T6-2 三档阈值 | `decideTempoGate`（conf 0.65/0.45、stability 0.6/0.4、dev 0.06） | 同上 + wiring 两条 |
| T6-3 与速率合流 | 门控结果喂 `hint`，速率仍走 `plan.rate`；PLL 以 `matchedRate` 为中心 | 分轨 PLL 用例 |
| T6-4 吸附真实拍点 | `snapToBar()` 优先 `downbeats`，缺失才按 `barMs` 等距 | C1 = **0.000 ms** |
| T6-5 成本控制 | standard 档不建图、不预热（`preview.barMs<=0` 直接跳过） | 本轮新增 2 条用例 |

### T5 · UI

| 工单 | 落地 | 证据 |
|---|---|---|
| T5-1 设置项 | 三档 seg（标准/进阶/进阶·稳妥）+ 中文 hint | `mixTransitionMode` 往返用例 |
| T5-2 时间线数据源 | `buildTimeline()` + 试放台四泳道渲染（swap 实心 / echo 斜纹 / duck 窄条 + 小节刻度） | preview 用例（标准档给原因、进阶档给块） |
| T5-3 拖动换手点 | `PlanInput.handoffOverrideMs` + `snapToBar` | `transitionHandoffPoint.test.cjs` 6 条 |
| T5-4 reason 一致 | `describePlan` 每动作一行「小节 N：…」 | 一致性用例（`/^小节 \d+：/`） |

---

## 3. §8 指标实测

| 指标 | 口径 | 判据 | 实测 |
|---|---|---|---|
| C1 换手点误差 | 每个 `SwapAction.startBar` 到最近 `downbeats` | < 5 ms | **0.000 ms** / 9 场景 × 4 动作 |
| C2 低频波动 | 30–120 Hz 带通 → 500 ms RMS → max−min | < 2 dB | **0.000 dB**（同相）/ **1.013 dB**（去相关）；旧整轨等功率同材料 **1.857 dB** |
| C3 人声重叠 | 两侧 vocals 50 ms RMS 同时超阈的累计时长 | < 1 拍 | **0.872 拍** |
| C4 拍点漂移 | 起播超前 30 ms 的收敛过程 | < 5 ms | **第 7 拍（3.5 s）进 ±5 ms**，稳态 **0.0005 ms** |
| G1 无双声 | 结束 +500 ms：A<0.01 且 B>0.99 | 全 True | ✅ |
| G2 回退无咔哒 | 8 步 × 2 ms 斜坡 | 单步 |Δ|<0.05 | ✅（实测 0.125/8 步，单调） |
| G3 节点不泄漏 | 构造 38 / dispose 38 | 相等 | ✅ 幂等 |
| G4 分离自洽 | `mix − Σstems` ≤ −30 dB；短窗一致性 ≥0.95 | 达标 | **−35.55 dB**；2 s drums 0.990 / vocals 0.994 |
| G5 互斥静音 | 进阶期原元素写入 0 + 20 ms 斜坡 | 必须 | ✅（回退按 `cos/sin(progress)` 还原） |
| E1 盲听 24 组 | 点估计 ≥50%，95% CI 下界 ≥40% | 待你听 | ⏸ **夹具已就绪**（`.scratch/listen/`，见 §4.1） |
| E2 MUSDB SDR | 真数据集（非合成） | 参考 | ⏸ 需下载数据集 |

### 本轮修掉的真缺陷（都由判据抓出，不是猜的）

1. **出场曲线用 `1−sin` 代替 `cos`** → 中点总增益 1.207（+1.6 dB），50% 交点偏到 p=1/3（C1 报 156 ms）。改用等功率补并加 `a²+b²=1` 断言。
2. **降级模板漏轨**：只点 bass+drums 时 `other`/`vocals` 永远挂 A（G1=False、C3=8 拍）。补「未覆盖分轨自动交叉」，人声窗口收缩到 1 拍 → C3 0.872。
3. **人声侧链压整条 deck**：B 的低频跟着 −6 dB。改逐轨 `stemDuck`。
4. **PLL 双积分器**：`rate += -kp·err` 让速率自身也被积分，过零后以 ~20 拍为周期**反向发散**（64 拍还剩 18.4 ms）。改相位目标 `center*(1−0.3·err)` + 步长/幅度夹取。
5. **基准自身读错交错流**：`BlockCopy` 把 `L0,R0,L1,R1…` 当左声道，重构残差 −0.18 dB（假结论「模型全是垃圾」）。逐帧分离后 −35.55 dB。
6. **NaN 写进 `AudioParam`**：`Math.max(1, NaN)=NaN`，`start(NaN)` 被部分浏览器当「立即播放」→ 爆音。四入参全净化 + `applyAll` 拒绝非有限起点。

---

## 4. 盲听夹具（E1 执行方法）

已经做好，你只需要听：

```powershell
cd E:\Zilux2开发\.scratch\listen
python render_pairs.py --a <A歌分轨> --b <B歌分轨> --seconds 16 --pairs 24
cd out; python -m http.server 8899      # 打开 http://127.0.0.1:8899/listen.html
# 听完导出 answers.json → python score.py answers.json
```

- 每组 = 同一段过渡的两个版本（整轨等功率 vs 分轨换手），顺序随机、响度对齐 ±0.5 dB
- `1`/`2` 切 A/B，`←`/`→` 选边，`↓` 分不出；答案自动存 localStorage
- `score.py` 输出「胜+平占比」与 95% Wilson 区间，末行 `VERDICT: PASS/FAIL`
- `key.json` 是答案，听完之前别开

详见 `.scratch/listen/README.md`。

## 5. 已知边界（诚实清单）

- **无 WSOLA**：分轨路只改 `playbackRate`，±1% 听不出，>2% 会有音高变化；元素路本来就有。
- **进阶只在图模式生效**：`requestHandoff()` 只在 `plan.graphMode` 分支被调用，元素模式接不进去。
- **4 轨缓存体积翻倍**：单轨单窗 ~5.29 MB，默认上限 2048 MB，可在设置里改（0 = 不清理）。
- **`other` 不含人声残留保证**：htdemucs 的 `other` 会带一点人声尾巴，模板里只把它当「旋律/铺底」用。
- **合成 SDR 非 MUSDB**：负值属 OOD，只能横向比较窗口长度的影响，不能当质量分。
- **预热是「一次机会」**：没预热到就本次降级，不在过渡中途等解码（宁可降级也不卡拍）。

---

## 6. 复现

```powershell
cd E:\Zilux2开发
pwsh .scratch\transition-accept\run-all.ps1            # 全量（含 G4 分离质量）
pwsh .scratch\transition-accept\run-all.ps1 -SkipStems  # 只跑过渡链路
node --test web/tests/                                  # 单测
cd web; npx --no-install tsc --noEmit                   # 类型
```

脚本末行为 `VERDICT: PASS/FAIL`，退出码 0/1（可直接接 CI）。

## 7. 相关文档

- 工单与口径：`docs/zilux2-advanced-transition-wbs-v2.md`
- 指标明细：`docs/zilux2-advanced-transition-acceptance.md`
- 逐轮记录：`docs/zilux2-advanced-transition-progress.md`
- 与 DJUCED 的对比与路线：`docs/zilux2-vs-djuced-roadmap.md`

## E2 补充（第 17 轮）：MUSDB18-HQ 真数据集 SDR

| 曲目 | 片段 | drums | bass | other | vocals | 均值 |
|---|---|---|---|---|---|---|
| BKS - Bulldozer | 40–70 s | 14.12 | 11.66 | 2.53 | 12.81 | 10.28 |
| Angels In Amplifiers - I'm Alright | 30–60 s | 7.00 | 10.51 | 7.85 | 11.55 | 9.23 |
| Girls Under Glass - We Feel Alright | 30–60 s | 9.65 | 6.60 | 7.77 | 9.21 | 8.31 |
| 三曲均值 | — | 10.26 | 9.59 | 6.05 | 11.19 | **9.27** |

数据自洽性：`mixture − Σstems` = −66.67 / −68.02 / −70.96 dB。方法、口径与边界见 `docs/zilux2-advanced-transition-acceptance.md` §7。

## E1 状态（第 17 轮）

盲听夹具已用**真实素材**备好：`.scratch/listen/out-real/`（24 组 × 16 s，BKS - Bulldozer × Girls Under Glass - We Feel Alright，44.1 kHz，RMS 对齐）。统计链路冒烟通过（假答案 100% / CI [86.2%,100%]）。
剩余唯一动作：用户本人听完导出 `answers.json` → `python .scratch/listen/score.py answers.json`。

## 长跑场景重放（第 18 轮）

`web/tests/transitionScenarioReplay.test.cjs`：120 s / 4 窗 / 6 次变速的同一条时间轴上，验证「每次变速后待起播窗口的起播时刻 = now + (边界 − 位置)/rate 且该时刻恰好 4 条 source」（重复排程即 G1 双声、漏排即空档）、变速落在边界时不重排已播窗、`remainingSec` 单调下降并在 0.4 s 阈值稳定跨界、长跑后 `dispose()` 全清且幂等。4/4 通过；全量 194 pass。

### E3 真机 HTTP E2E

| 项 | 结果 |
|---|---|
| 覆盖方式 | 独立进程起真 `LocalMusicServer`（绕过 GUI 单实例互斥体），真 socket + Bearer 鉴权 |
| 断言 | 12 项全 PASS：2 轨/4 轨 ready、四条 4 轨 RIFF 5,292,044 B、`stems=3`→400、`stem=foo`→400、无 token→401、2 轨取 drums→409 |
| 耗时 | 2 轨 7389 ms、4 轨 6906 ms（30 s，首次未命中缓存） |
| 交叉校验 | 与离线 bench 四轨 corr 1.00000；`inst −(drums+bass+other)` −74.26 dB |
| 证据 | `artifacts/stems-e2e-rt/verify-e2e.log`、`.scratch/stems-e2e/README.md` |

### E4 真实素材复测（MUSDB 分离结果）

| 项 | 结果 |
|---|---|
| 材料 | A = `BKS - Bulldozer` 40–70 s，B = `Girls Under Glass - We Feel Alright` 30–60 s（四轨分离结果，44.1k→48k） |
| 口径 | C1/C3/G1 不变；C2 改为 **C2p**（对不相干功率和的偏差，200 ms 窗）——真实音乐的自然起伏会淹没原口径 |
| 最差值 | C1 0.000 ms、C3 0.872 拍、G1 全 True、C2p **1.760 dB**（旧整轨等功率同材料 4.106 dB） |
| 判定 | `VERDICT: PASS`；证据 `.scratch/transition-accept/metrics-real.json` |
| 边界 | 低频相关时 linear 正确、不相关时 equal-power 正确；当前按分轨固定 linear，自适应曲线列为下一步 |

### E5 低频互相关自适应曲线

| 项 | 结果 |
|---|---|
| 动机 | §12 `vocalFirst` 1.760 dB 暴露「按分轨写死曲线」的假设不成立 |
| 实现 | `web/src/core/correlation.ts`（去均值 Pearson + 120 Hz 一阶低通）+ `PlanInput.correlation` + `chooseCurve`（阈值 0.35） |
| 真曲 ρ | drums 0.0185、bass 0.0133、other 0.0103、vocals −0.0020（两首不同的歌应走 equalPower） |
| 收益 | 最差 C2p **1.760 → 1.425 dB**（vocal-first 1.760 → 1.088），旧整轨等功率 4.106 dB |
| 判据 | 201 pass / 0 fail、tsc 0、`VERDICT: PASS`；证据 `metrics-real-corr.json` |
| 遗留 | 运行时 ρ 尚未接线（服务端解码时顺带算 / begin() 加载后重排），API 已就绪且默认行为不变 |

### E6（第 22 轮）：ρ 进入运行时决策

| 环节 | 文件 | 说明 |
|---|---|---|
| 采样 | `web/src/audio/stemPlayer.ts` `monoSamples()` | 首窗前 192k 采样、左右平均、只读 |
| 测量 | `web/src/audio/advancedSession.ts` `measureCorrelation()` | 四轨 120 Hz 低通互相关；缺数据返回 `{}` |
| 重排 | `web/src/audio/installAdvancedHandoff.ts` `replan` | 用实测 ρ 再跑 `resolveTransition`，替换事件 |
| 决策 | `web/src/core/transitionPlan.ts` `chooseCurve()` | `|ρ| ≥ 0.35` → `linear`，否则 `equalPower` |

效果：两首不同的歌（ρ≈0.01–0.02）自动走 `equalPower`，把真实素材的最差低频偏差从 1.760 dB 压到 1.425 dB（旧整轨等功率 4.106 dB）。判据 204 pass / tsc 0。

### E7（第 23 轮）：模板自动选择

| 信号 | 规则 | 结果 |
|---|---|---|
| 速度差 > 6% | 不做 sync | `bassOnly` |
| 能量差 > 0.35 | A 热 B 冷 | `filterBuild`（先堆气氛） |
| 两首 energy ≥ 0.62 且 Camelot ≤ 1 | 双歌齐响 8 小节 | `doubleDrop` |
| A 在 outro / B 在 intro | 留铺垫 | `standard`（32 小节） |
| 其余 | 调性允许人声 | `standard`，否则 `bassOnly` |

判据：209 pass / tsc 0 / `emit+measure` PASS。

### E8（第 24 轮）：回声甩尾接通

| 环节 | 文件 | 说明 |
|---|---|---|
| cue | `web/src/core/transitionPlan.ts` `TransitionPlan.echo` | `vocalFirst` 生成，挂人声换手起点、甩 1 拍 |
| 事件 | `web/src/core/stemSwap.ts` `schedulePlan()` | 追加 `delaySend`×2 + 对向 `duck`（−3 dB / 5 ms） |
| 设置 | `web/src/core/mixTransitionMode.ts` `mixTransitionTemplate` | `auto / vocalFirst / doubleDrop`，与模式键分存 |
| UI | `web/src/ui/app.ts`「换手手法」 | 快捷设置 → 过渡页 |
| 透传 | `web/src/ui/crossfadeDeck.ts` `templateHint()` | `auto` 不带 hint，其余透传到 `resolveTransition` |

判据：214 pass / tsc 0 / `emit+measure` PASS。

### E9（第 25 轮）：回声甩尾实测

| 指标 | 数值 | 判据 |
|---|---|---|
| 峰值增量 | +0.294 dB | ≤ +0.5 dB |
| 尾巴（切断后 0.4 s） | −14.35 dB | −35…−6 dB |
| 高频抑制 | −32.64 dB | ≤ −6 dB |

素材：MUSDB `BKS - Bulldozer` vocals 分轨 30 s；参数：delay 125 ms / send 0.6 / feedback 0.35 / damp 3 kHz。脚本 `.scratch/transition-accept/echo_probe.py`，`run-all.ps1` 已纳入。

## E10 WBS v2 覆盖检查

`python .scratch/transition-accept/coverage.py` 把 WBS v2 的 49 条逐条对到「文件 + 关键符号/实测数字」：

| 项 | 结果 |
|---|---|
| 有证据 | 48 / 49 |
| 待人工（E1 盲听） | 1 |
| 缺失 | 0 |
| VERDICT | PASS |

已纳入 `run-all.ps1` 作为 E10，与测试、tsc、过渡指标、E9、G4 一起跑；任一条目失去证据即整体 FAIL。

## C0 / E1b（第 27 轮）

| 项 | 内容 | 判据 |
|---|---|---|
| C0 标准路径冻结 | `web/tests/transitionStandardGolden.test.cjs` 把 `naturalGains` 五个进度点钉成字面量 + 功率守恒 1e-12 + 单调 | 5/5 PASS |
| E1b DJUCED 对照臂 | `render_pairs.py --style kill` 按打垫行为逐轨硬切（0/2/4/8 小节，5 ms ramp），生成 `out-real-kill` 24 对 | 已生成，24 对 RMS 差 max 0.493 dB |
| 盲听夹具修正 | 同组两个文件共用归一化系数（原逐文件归一化会造 0.96 dB 响度偏差） | 修后 max 0.493 / mean 0.209 dB |

## E11 / E12（第 28 轮）

| 项 | 内容 | 判据 |
|---|---|---|
| E12 分离确定性 | `determinism.py`：threads=4/4/1 三次，8 个 f32 逐文件 SHA-256 全等 | PASS（合并哈希 `5fce922c43c257f0`） |
| E11 缓存身份校验 | meta 记 `sourceBytes`/`sourceModifiedUtc`，读缓存比对源文件；旧 meta 一律 miss | 探针 81 PASS、E2E 16/16 |
| 旧 2 轨不变 | 2 轨与 4 轨的 vocals **逐字节相同**（5,292,044 B）；`inst ≈ Σ3` −28.96 dBFS（= Σ4−mix 底噪） | PASS |
| 契约确定性 | `stems<4` 取 drums/bass/other 恒 409，不再随缓存历史变化 | PASS |

## E13（第 29 轮）：跨层接线集成

| 检查 | 结果 |
|---|---|
| install→session→player/graph 全链路 | 2 pass（`web/tests/advancedIntegration.test.cjs`） |
| 两条 deck 共用同一 `when`、`applyAll` 起点一致 | PASS |
| `setRates({a,b})` 分侧下发 | PASS |
| `remainingSec()` 真实现（原为未实现的类型声明，G6 因此从不触发） | 已修，PASS |
| `cancel()` 幂等 | PASS |

## E14（第 30 轮）：预热预算

| 检查 | 结果 |
|---|---|
| 每侧串行（全局并发 ≤2） | PASS（3 窗 × 2 deck，峰值 2） |
| 同窗在途去重 | PASS（重复调用只发一轮请求） |
| 单窗失败只影响该侧、已成功窗口仍登记 | PASS |
| 异常原因可诊断（不再吞成 false） | PASS |

## E15（第 31 轮）：报告完整性门禁 + 补记 T4-0 / G1b / G1c / G1d

`.scratch/transition-accept/report_check.py` 拿 `coverage.json` 的条目 id 逐个对到本报告，缺失即 FAIL。首跑抓出 4 条「代码有判据、报告没结论」的缺口，补记如下：

| 条目 | 内容 | 判据 / 证据 |
|---|---|---|
| **T4-0** | `web/src/audio/advancedSession.ts` 会话内核：元素 volume=0 不 pause（保住 currentTime）→ 建图 → 并发加载两条 deck 四轨 → 同一 `when` 起播 → `applyAll(events, when)`；失败拆图 + 20 ms 斜坡还原 + 返回 inactive（不抛）；`cancel()` 幂等 | `web/tests/advancedSession.test.cjs`、`web/tests/advancedIntegration.test.cjs` |
| **G1b** | 变速后**窗口重排**：已过边界只改 `playbackRate`，未到的窗按新速率重排（`110 + (30-15)/1.02 = 124.7059`），非法速率整段忽略 | `web/tests/stemPlayerAudio.test.cjs:195/199` |
| **G1c** | A/B 速率语义：`rateA = a.rate ?? 1`、`rateB = b.rate ?? plan.rate`；`setRate` 为**绝对值**；`baseRate=1.5` + BPM 126/120 ⇒ 分轨收到 1.428（旧实现错给 0.952） | `web/tests/advancedSession.test.cjs`、`web/tests/crossfade.test.cjs` |
| **G1d** | A 侧也跟 tempo：`setRates({a,b})` 分侧下发，用户推 tempo 推子时 A 的分轨不会与波形错开 | `web/tests/advancedSession.test.cjs`、`web/tests/crossfade.test.cjs` |

判据：`report_check.py` → 55/55 已在报告写明、`VERDICT: PASS`（已接进 `run-all.ps1` 作为 E15 步）。

## E16（第 32 轮）：打包产物可达性 + 一次诚实的失败尝试

### 16.1 门禁：产物里必须看得到进阶接线

单测和源码级覆盖都看不到**产物**：tree-shaking、入口漏挂、构建条件，都会让正确的源码在 `dist` 里消失（第 2 轮那次「整条进阶路径是死代码」就是同类问题的静态版本）。

`.scratch/transition-accept/bundle_check.cjs` 会自己跑一次 `vite build`，然后检查 `dist/assets/main-*.js` 里的关键接线（全是 ASCII 字面量——vite 默认 `charset=ascii`，中文会被转义成 `\uXXXX`，匹配不到；函数名会被压缩，所以只用字符串字面量与**属性名**）：

| 标记 | 含义 | 结果 |
|---|---|---|
| `mixTransitionMode` | 过渡模式设置键 | ✅ |
| `advanced-handoff` | 进阶交接日志标签 | ✅ |
| `advanced-prefetch` | 四轨预热日志标签 | ✅ |
| `remainingSec` | G6 静场兜底的消费字段 | ✅ |
| `setRates` | A/B 分侧速率 | ✅ |
| `setEchoTime` | 回声时间跟拍 | ✅ |
| `applyAll` | 事件表整批交给音频时钟 | ✅ |

产物：`main-B88cO44y.js` 1543 kB，缺失 0，`VERDICT: PASS`（已接进 `run-all.ps1`）。

### 16.2 失败的尝试：真 WebAudio 离线渲染探针（未交付）

动机：所有单测的 `AudioContext` 都是假件——`setValueCurveAtTime` 只记账、delay 回路是空壳，真浏览器的 AudioParam 语义（曲线插值、`cancelAndHoldAtTime`、反馈延迟）从没被验证过。

做法：`.scratch/webaudio-probe/` 下用 vite 打成 IIFE，页面里跑 `OfflineAudioContext` 渲染两路同相 55 Hz，用「相关信号 `a+b≈1`」校验 linear 曲线平坦、equalPower 中点应有 +3 dB 隆起。

结果：**没跑通，已放弃**。`OfflineAudioContext` 本身可用（CDP 里 smoke 测试 `ok:4800`），但 `--headless --dump-dom` 在 load 就快照 DOM，拿不到异步渲染结果；改用自写的最小 CDP/WebSocket 客户端后又卡在事件流与等待逻辑上，成本远超收益。

已知的验证缺口（诚实记录）：**真浏览器 AudioParam 语义仍未验证**。现有替代证据是 Python 侧的曲线模型（`measure.py`/`measure_real.py`，与 TS 用的是同一套 `gainAt` 公式）+ `run-all` 的 C1/C2p 判据；如果以后要补，最省事的路径是给 Playwright 装一次 Chromium，而不是手写 CDP。

## E17（第 33 轮）：真浏览器 AudioParam 语义，终于测到了

第 32 轮手写 CDP 失败后改用 Playwright（`pip install playwright`，不下载浏览器，直接 `channel="msedge"` 驱动本机 Edge）。探针在真 `OfflineAudioContext` 里跑真 `StemGraph`，两路 55 Hz 同相正弦，只改曲线形状。

以「单条 deck 满增益」为 0 dB 参考（同一探针空闲跑一条 deck 测得 −3.01 dBFS）：

| 场景 | 理论 | 实测 | 结论 |
|---|---|---|---|
| 两条 deck 同相满增益 | +6.02 dB | **+6.02 dB** | 相干叠加物理正确 |
| `linear`（A=1−p、B=p）中点 | 0.00 dB（平坦） | **0.00 dB** | 曲线真的按采样点插值 |
| `equalPower`（A=cos、B=sin）中点 | +3.01 dB | **+3.00 dB** | **相关素材上 +3 dB 隆起被真浏览器复现** |
| 双向淡出（两路都 1→0）终点 | 数字静音 | **−180 dBFS** | `setValueCurveAtTime` 确实驱动了 gain |

这张表的第三行是整条链路的关键证据：`equalPower` 在**相关**信号上必然多出 +3 dB，这正是当初听感问题（低频变厚、人声二重唱）的物理来源，也是第 21 轮 `chooseCurve(ρ)` 之后 C2p 从 4.106 dB 降到 1.313–1.425 dB 的原因。以前只有 Python 侧模型与 TS 公式「两边自证」，现在有真浏览器的第三方裁决。

复现：`python .scratch/webaudio-probe/run-probe.py`（自己构建 IIFE 产物 → 拷到 ASCII 临时目录 → Playwright 读 `#out` → 写 `probe.json`）。

两个现场坑记一下：ES module 在 `file://` 下被 CORS 拦（改用 IIFE）；`.scratch` 目录不在 `web/node_modules` 解析链上，`vite.config.ts` 里 `import { defineConfig } from 'vite'` 会失败（改导出纯对象）。

边界：只验证了 `setValueCurveAtTime` 与单节点 gain 曲线；`cancelAndHoldAtTime` 的无跳变行为仍只有单测级证据（真机上它属于「不会抛错」就够用的 API，风险低但不等于已验证）。

## E18（第 34 轮）：`hold()` 兜底路径是错的，用真浏览器量出来并换掉实现

`stemGraph` 的增益曲线原先走 `setValueCurveAtTime`。E17 只验证了「曲线不被打断」的情形，本轮专门量「曲线跑到一半被打断」——因为 `hold()` 里有一条兜底路径（老浏览器没有 `cancelAndHoldAtTime` 时用 `param.value + cancelScheduledValues`），而单测里 `param.value` 是假件，永远返回合理值。

真 Chromium 实测（55 Hz 正弦，曲线 1→0 从 0.2 s 起、在 0.7 s 打断）：

| 做法 | 打断前电平 | 打断后电平 | 相邻采样最大跳变 |
|---|---|---|---|
| `cancelAndHoldAtTime(0.7)` | −8.00 dBFS | −8.84 dBFS | 0.004（无咔哒） |
| 旧兜底：`param.value` + `cancelScheduledValues` | **−2.82 dBFS** | −2.82 dBFS | 0.007 |
| 新兜底：ramp 实现 + 自算值 | −8.00 dBFS | −8.85 dBFS | 0.004 |

第二行是缺陷：`param.value` 在自动化运行期间返回的是**内在值 1.0**，而且 `cancelScheduledValues(0.7)` 会把这条**从 0.2 s 开始**的曲线事件整条移除，于是连打断点**之前**的包络都被撤销，电平直接跳回满增益（−2.82 vs 应有的 −8.00，约 +5.2 dB 阶跃）。

修法（`web/src/audio/stemGraph.ts`）：
1. `scheduleCurve` 不再用 `setValueCurveAtTime`，改为 **33 段 `linearRampToValueAtTime`**。`setValueCurveAtTime` 本来就是逐点线性插值，所以输出逐点一致；区别是 `cancelScheduledValues(t)` 对 ramp 只摘掉 t 之后的目标点，**已过去的包络不受影响**。
2. `hold()` 兜底不再读 `param.value`，改用自己的记账 `recordPoints/valueAt`（WeakMap 存最近 128 个目标点，按时间线性插值）算出该时刻真实值，再 `cancelScheduledValues + setValueAtTime`。
3. `scheduleEchoSend` / `scheduleDuck` / `scheduleStemDuck` 同样把端点记进 `points`，保证后续打断能算对。

判据（同一探针）：新兜底与 `cancelAndHoldAtTime` 的打断前后电平差只相差 0.02 dB（−0.851 vs −0.833），最大采样跳变 0.004（与不打断时同量级），且打断点之前的包络仍是曲线本身（−8.00 dBFS，不是 −2.82）。`node --test` 224 pass、`tsc` 0 error 不受影响。

边界：`hold()` 兜底路径在 Chromium/Edge 上根本不会被触发（它们都有 `cancelAndHoldAtTime`），这条兜底是给老 Safari 一类实现准备的；本轮的价值是证明「如果哪天真走到兜底，不会再炸出 +5 dB」。

## E19（第 35 轮）：回声总线在真浏览器里只吃人声

「人声回声甩尾」是手法库里唯一依赖**总线拓扑**（而不只是增益曲线）的手法：vocals → `echoSend` → `delay` → `damp` → 反馈环 → destination。此前只有两类证据——Python 侧的参数模型（E9：峰值 +0.294 dB、尾巴 −14.35 dB、高频 −32.64 dB）和单测里的节点计数/事件断言。拓扑本身没在真浏览器里响过。

本轮在同一个离线渲染探针里加了 `renderEcho(stem)`：1 kHz 门控信号 0.10–0.35 s，`delaySend` 0→0.6（0.1 s 起、250 ms），delay = 0.125 s（120 BPM 的 1/4 拍），分别灌给 vocals 与 drums：

| 灌入轨 | 干声段（0.14–0.32 s） | 干声停止后（0.42–0.62 s） | 1 s 之后 |
|---|---|---|---|
| vocals | −8.5 dBFS | **−12.74 dBFS** | −180 dBFS |
| drums | −8.5 dBFS | **−180 dBFS** | −180 dBFS |

隔离度 **167 dB**：同一段信号灌到 drums 时回声总线完全没有输出，证明 `echoSend` 的接入点确实只在 vocals 分轨上（`gain.connect(this.echoSend)` 只对 `stem === 'vocals'` 执行），而不是「四轨都接了、只是量小」。

同时第二列给出尾巴的量级：干声停了之后仍有 −12.7 dBFS 的延迟声（约 0.23 × 干声电平），与 E9 的参数扫描（feedback 0.35 ⇒ tail ≈ −14 dB）在同一量级；1 s 之后归零，说明反馈环没有自激。

复现：`python .scratch/webaudio-probe/run-probe.py`，看 `derived.echoVocalsTail` / `echoDrumsTail` / `echoTailIsolationDb`。

## 收尾：唯一未完成项的实施路径

E1（盲听）在客观判据里是唯一「代码无法自证」的条目，工具已就位：

```
python .scratch/listen/listen.py                 # 24 组：进阶 vs 整轨等功率
python .scratch/listen/listen.py out-real-kill   # 24 组：进阶 vs DJUCED 式硬切
# 页面里 1/2 切边、←/→/↓ 投票，听完导出 answers.json
python .scratch/listen/score.py answers.json     # 胜+平 ≥ 50%（95% Wilson 区间）
```

判定口径与 objective 一致（20 次里至少 10 次不劣于对手）；两轮都做，等于同时回答「比现在的等功率好多少」和「和 DJUCED 的硬切比是否至少不输」。

全量验收（`run-all.ps1` 不带 `-SkipStems`）当前 8 行全 PASS，其中 G4 用真曲四轨复核：重构残差 −35.55 dB、2 s 短窗与 7.8 s 长窗的 drums/vocals 一致性 0.990 / 0.994。

## E20（第 37 轮）：漏登记一行设置项

「换手手法」在 UI 上建了 cell 却漏进 `groupOfTitle`，分页逻辑对它不起作用 ⇒ 播放/音效/试听/过渡四页都能看到这一行。已补 `['换手手法', 'transition']`，并加 `web/tests/quickSettingsGroups.test.cjs` 把「cell 列表 ↔ 分组表」变成可执行的一致性断言（临时删除映射可复现失败）。

这类缺陷一共出现过三次（`setHandoffFactory` 无调用方、`remainingSec` 声明未实现、分组漏登记），都属于「声明了但没接上」，现在分别由 E13、E13、E20 兜住。

## E21 死导出审计与稳妥档语义

| 项 | 结果 |
|---|---|
| 审计范围 | 15 个相关模块的全部 `export`（值导出，不含 type/interface） |
| 判定规则 | 标识符在全仓 `web/src` 出现次数 `<= 1`（含定义行）即「只有定义」 |
| 首轮命中 | 6 条 → 2 条真缺口（`wantsStemSwap`/`allowsDegradedSwap`）、1 条未接线兜底（`fallbackToStandard`）、1 条重复常量、2 条设计预留（`djMoves.humanize`/`filterSweepMove`） |
| 修复 | 稳妥档门禁（`tier !== 'full'` ⇒ 回落标准）+ 模式映射改 `wantsStemSwap` + catch 走 `fallbackToStandard` + 删除 `TRANSITION_MODE_LABELS` |
| 新用例 | `bpmConfidence=0.5`：`advancedSafe` → null 且日志含「稳妥档」；`advanced` → 正常 handoff |
| 判据 | 228 单测 / tsc 0 / 死导出 0 条 / 覆盖 60/61（E1 待人工） |
| 已知边界 | `djMoves` 手法库（8 move、`MOVE_TEMPLATES`、`expandMoves`、`humanize`）仍为设计预留，等 `stemGraph` 支持 hpf/lpf 自动化后再接 |

## E22 滤波扫频（`filterBuild` 名副其实）

| 项 | 结果 |
|---|---|
| 决策层 | `filterBuild` 产出 `filter {320 Hz → 18 kHz, lengthBeats ≥ 8}` |
| 排程层 | 新 `FilterEvent`，`schedulePlan` 排 1 条，`durationMs = lengthBeats × beatMs` |
| 音频层 | 每台 deck `bus → hpf → duck`（highpass，Q 0.707），`exponentialRampToValueAtTime` 扫频 |
| 单测 | 4 条（plan 带/不带、schedulePlan 排程、apply 的 set+exp 时间点）⇒ 231 pass |
| 真浏览器 | 过零率 0.5013 / 0.5201 / 0.6849（起点/中段/终点），末端 1.37× ⇒ PASS |
| 节点预算 | 38 → 40 节点、48 → 50 连接（每台 +1 hpf），G3 计数断言同步 |
| 边界 | 只做 B 侧高通开门；A 侧低通关门仍是设计预留 |

## E23 出场侧低通关门（与 E22 对称）

| 项 | 结果 |
|---|---|
| 决策层 | `filterBuild` 产出 `filterOut {20000 → 700 Hz, 与 filter 同长度}` |
| 排程层 | `FilterEvent.band`，排 2 条（B highpass / A lowpass） |
| 音频层 | `bus → hpf → lpf → duck`，`apply` 按 band 选节点 |
| 单测 | filterBuild 两条、standard 零条；节点 42 / 连接 52 ⇒ 231 pass |
| 真浏览器 | 开门 ZCR 0.4679→0.4906→0.6562（1.4×）；关门 0.3681→0.1394→0.0372（9.9×）⇒ PASS |
| 边界 | 两侧同时长，无错位编排（错位仍属 `MOVE_TEMPLATES` 设计预留） |

## 终极验收总表（由 `.scratch/transition-accept/coverage.py` 生成）

状态：✅ = 有可复现证据；👤 = 需人工（仅 E1）；❌ = 缺失。

| 条目 | 说明 | 状态 |
|---|---|---|
| T2-1 | 四轨模型 + Stems 字段 | ✅ |
| T2-2 | HtdemucsSession 四轨累加 | ✅ |
| T2-3 | 四轨落盘 drums/bass/other | ✅ |
| T2-4 | 五 stem 白名单 + stems=2|4 | ✅ |
| T2-5 | 4 轨缓存 LRU | ✅ |
| T2-6 | maxStemCacheMb 设置与合并写 | ✅ |
| T3-1 | stemGraph 每轨独立入口 | ✅ |
| T3-2 | stemPlayer 跨窗装载 | ✅ |
| T3-3 | cancelAndHoldAtTime 无跳变 | ✅ |
| T3-4 | echo delay 与 BPM 同步 | ✅ |
| T3-5 | applyAll 时间门禁 | ✅ |
| T3-6 | PLL 接入（trackRate） | ✅ |
| T4-0 | AdvancedSession | ✅ |
| T4-1 | mixTransitionMode 键 | ✅ |
| T4-2 | ActivePlan.advanced + 请求透传 | ✅ |
| T4-3 | 双 deck 互斥静音 | ✅ |
| T4-4 | 失败 20ms ramp 回退 | ✅ |
| T4-5 | 生命周期清理 | ✅ |
| T5-1 | 过渡模式开关（三档） | ✅ |
| T5-2 | 过渡时间线（预案泳道） | ✅ |
| T5-3 | 拖动换手点吸附小节 | ✅ |
| T5-4 | 文案与动作一致（describePlan） | ✅ |
| T6-1 | 候选拍族集合 | ✅ |
| T6-2 | 打分（偏差/下拍/乐句） | ✅ |
| T6-3 | 三档判定 | ✅ |
| T6-4 | 阈值可配 | ✅ |
| T6-5 | 低置信度不预热四轨 | ✅ |
| C0 | 标准等功率路径冻结（黄金值） | ✅ |
| C1 | 换手点误差 <5ms | ✅ |
| C2 | 低频波动（合成）<2dB | ✅ |
| C2p | 低频波动（真实素材）<2dB | ✅ |
| C3 | 人声重叠 <1 拍 | ✅ |
| G1 | 无双声（source 数校验） | ✅ |
| G1b | 变速后窗口重排 | ✅ |
| G1c | A/B 速率各自独立 | ✅ |
| G1d | A 侧速率同步 | ✅ |
| G2 | 回退无咔哒 | ✅ |
| G3 | 节点不泄漏 | ✅ |
| G4 | 四轨重构残差 | ✅ |
| G5 | 进阶期互斥静音 | ✅ |
| G6 | 分轨先放完兜底 | ✅ |
| E2 | MUSDB 真数据集 SDR | ✅ |
| E3 | 真机 HTTP E2E | ✅ |
| E4 | 真实素材口径（C2p） | ✅ |
| E5 | 相关度自适应曲线 | ✅ |
| E6 | ρ 进入运行时 | ✅ |
| E7 | 模板自动选择 | ✅ |
| E8 | 回声甩尾接通 | ✅ |
| E9 | 回声实测（峰值/尾巴/阻尼） | ✅ |
| E13 | 四层接线集成（安装器→会话→播放器/图） | ✅ |
| E20 | 设置行都登记了所属分页 | ✅ |
| E19 | 回声总线只吃人声（真浏览器） | ✅ |
| E18 | hold 兜底不撤销历史包络 | ✅ |
| E17 | 真 Chromium 离线渲染校验曲线语义 | ✅ |
| E16 | 打包产物含进阶接线 | ✅ |
| E22 | filterBuild 的滤波扫频真接线 | ✅ |
| E23 | filterBuild 的 A 侧低通关门 | ✅ |
| E21 | 稳妥档语义 + 死导出审计 | ✅ |
| E14 | 预热预算：每侧串行 + 同窗去重 | ✅ |
| E11 | 缓存校验源文件身份（改写即失效） | ✅ |
| E12 | 分离确定性/线程无关 | ✅ |
| E1b | DJUCED 式对照臂（逐轨硬切） | ✅ |
| E1 | 盲听 24 组非劣性 | 👤 |

合计：62/63 有证据，1 待人工，0 缺失。
