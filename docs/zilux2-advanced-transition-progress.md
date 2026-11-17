# 进阶过渡 · 进度记录

> 每次落地都追加一条，格式：日期 / 工单号 / 改了什么 / 判据结果。
> 目标与验收口径见 `docs/zilux2-advanced-transition-wbs-v2.md`。

## 2026-11-16 · T3-1 修 stemGraph 分轨入口

- `web/src/audio/stemGraph.ts` 重写：
  - 每轨独立入口 `inputOf(stem)` / `connectSource(stem, node)`；`input` 降级为「整轨混合」兼容口（四路同源，仅供老代码）。
  - `STEM_ORDER = ['drums','bass','other','vocals']` 导出，便于上层按固定顺序建图。
  - `setEchoTime(sec)` + `echo.delayTimeSec` 选项：delay 时间可随 BPM 调整。
  - `hold(param, atTime)`：优先 `cancelAndHoldAtTime`，不支持时退化为「读当前值 → setValueAtTime」，避免 `cancelScheduledValues` 造成的阶跃咔哒。
  - `scheduleDuck` 起点改为 hold 当前值（不再硬写 1），避免连续 duck 时阶跃。
  - `applyAll` 返回 boolean：起点早于 `currentTime - pastToleranceSec(默认 0.05)` 时整批丢弃并 warn，防止曲线立即生效＝瞬间切歌。
- 判据：`npx tsc --noEmit` 0 error；`node --test tests/` 全绿。

## 2026-11-16 · T3-4 回声时间二选一定为「1/4 拍」

- `web/src/core/djMoves.ts`：`ECHO.divisionBeats` 由 `1` 改为 `0.25`（与注释、UI 文案「1/4 拍」一致），新增 `echoDelaySec(bpm)`（非法 BPM 回落 120）。
- 测试：`tests/transitionPlan.test.cjs` 断言改为 0.25，并新增 `echoDelaySec` 三条断言（120→0.125s、60→0.25s、非法→0.125s）。

## 2026-11-16 · T6-1..T6-4 速度门控

- 新文件 `web/src/core/tempoGate.ts`：
  - `TEMPO_CANDIDATES = [1, 1/2, 2, 2/3, 3/2, 3/4, 4/3]`
  - `scoreCandidates()`：`score = 0.55*exp(-2.5*|log2(等效BPM/A BPM)|) + 0.30*downbeatAlign + 0.15*phraseMatch`
  - `decideTempoGate()`：三档 `full / bassDrumsOnly / standard`，阈值 conf 0.65 / 0.45、stability 0.6 / 0.4、完整换手最大速率偏差 6%
  - `allowsVocals()`：仅 full 且下拍相位吻合 ≥0.5 才允许人声交换
- `web/src/core/advancedTransition.ts`：`resolveTransition` 先过门控；`standard` 直接返回 `plan:null`；`bassDrumsOnly` 强制 `hint='bassOnly'`；`ResolvedTransition.gate` 暴露判定明细。
- 测试：`web/tests/tempoGate.test.cjs` 10 条（候选排序、双速、2/3 族、三档、相位错半小节、缺字段回落、非法输入）+ `tests/transitionWiring.test.cjs` 两条改写为门控语义。
- 判据：`node --test tests/` **103 pass / 0 fail**；`npx tsc --noEmit` 0 error。

## 2026-11-16 · T3-2 4 轨播放器 + stemsClient 4 轨声明

- 新文件 `web/src/audio/stemPlayer.ts`：
  - `FOUR_STEMS = ['drums','bass','other','vocals']`；`windowStartSec` / `offsetInWindowSec` / `remainingInWindowSec` 为纯函数。
  - `StemPlayer.load(ctx, track, window, bus, {fourStem})`：并发取四轨 WAV → 解码 → 每轨 `GainNode → bus.inputOf(stem)`。
  - `start({positionSec, when, rate, gain})`：四个 `AudioBufferSource` **共用同一个 `when` 与同一偏移**，轨间对齐误差 0；`setRate()` 供 PLL 用；`stop()` 保留 buffer 便于重播；`dispose()` 断连。
  - 4 轨不可用（老宿主 400/409）→ 抛 `StemUnavailableError`，调用方按 T4 回退标准过渡。
- `web/src/core/stemsClient.ts`：`StemPart` 扩到 `vocals|instrumental|drums|bass|other`；`loadStemWindow(..., {stems})` 与 `prepareStemsWindow(..., {stems})` 在 4 轨模式下显式带 `stems=4`（否则宿主只算 2 轨，取 drums/bass/other 会 409）。
- 测试：新增 `web/tests/transitionPlayer.test.cjs` 4 条（窗口换算/偏移/剩余/轨序）。
- 判据：`node --test tests/` **107 pass / 0 fail**；`npx tsc --noEmit` 0 error。

## 2026-11-16 · T4-0/T4-1 会话内核 + 模式设置键

- 新文件 `web/src/audio/advancedSession.ts`（T4 的可测内核）：
  - `AdvancedSession.begin({ctx, destination, resolved, a, b, when, releaseMs})`：标准模式直接返回 `active=false`（一行不碰元素音量）；进阶模式按「元素静音（不 pause，保住 currentTime）→ 建 StemGraph → 并发加载两条 deck 的四轨 → 设 1/4 拍回声时间 → **同一 `when`** 启动两台播放器 → `applyAll(events, when)`」执行。
  - 任一步失败：拆图、20 ms 斜坡还原元素音量、返回 `active=false`，**不抛**（过渡链路不允许把声音搞没）。
  - `cancel()`：停播放器 + 拆图 + 斜坡还原；幂等。
- 新文件 `web/src/core/mixTransitionMode.ts`（T4-1）：键 `mixTransitionMode`（**不能**用壁纸已有的 `transitionMode`，v2 P4），默认 `standard`、非法值回落、`toggle`、localStorage 抛错不崩。
- 测试：`tests/advancedSession.test.cjs` 6 条（标准不接管 / 同 when 启动 / 回声 0.125 s / 加载失败回退 / cancel 斜坡 / 幂等）、`tests/mixTransitionMode.test.cjs` 6 条。
- 判据：`node --test tests/` **113 pass / 0 fail**；`npx tsc --noEmit` 0 error。
- 后端 T2-2..T2-5 已复核（我自己跑 `dotnet build … -p:OutputPath=artifacts\lead-verify\` → 0 警告 0 错误），并派了 T2-6（`maxStemCacheMb` 进设置 + `CachePolicy` 保留未知键）。

## 2026-11-16 · T2-6 web 侧设置行（分离缓存上限）

- `web/src/online/storage.ts`：`DiskCacheUsage` 增可选 `maxStemCacheMb/minStemMb/maxStemMb/defaultStemMb`；`DiskCacheLimitResult` 增 `maxStemCacheMb/removedStemDirs/stemBytesRemaining`；新增 `setStemCacheLimit(mb)` → `POST /api/storage/cache/limit {maxStemCacheMb}`（只交分离预算，不动整体 `limitMb`）。
- `web/src/ui/app.ts` `buildCacheFields()`：在「缓存上限」下加一行「分离缓存上限」，数字输入（0–16384，0 = 不自动清理）、说明「一个窗口约 5 MB」；`change` 时 260 ms 去抖后提交，`removedStemDirs>0` 提示清理了几个分轨窗口；`refresh()` 用 `host.maxStemCacheMb` 回填。
- 判据：`npx tsc --noEmit` 0 error；`node --test web/tests/` 119 pass / 0 fail（未动既有用例）。

## 2026-11-16 · T4-2 交接点接入 crossfadeDeck（四个关注点）

- 新文件 `web/src/core/advancedHandoff.ts`：`HandoffRequest{mode,kind,fadeMs,tempoRate}`、`Handoff{start(clockSec),cancel(),dispose()}`、`HandoffFactory`、`setHandoffFactory`/`hasHandoffFactory`/`requestHandoff`。
  - **标准模式连工厂都不调用**（`mode !== 'advanced'` 立即 null）⇒ 老路径零变化；
  - 工厂抛错 / 返回 null / 返回对象缺 `start|cancel|dispose` 一律 null + 告警，绝不冒泡。
- `web/src/ui/crossfadeDeck.ts`：
  - `ActivePlan` 新增 `advanced?: Handoff | null`；
  - `beginTimeline`：`scheduleDeckMatch` 之后调 `requestHandoff`，成功则 `handoff.start(clock)`（与 `scheduleDeckMatch` 同一 `clock` ⇒ 与 deck 同一条音频时间轴），**跳过** `scheduleNaturalFade`/`scheduleAmFade`；`start` 抛错则 `cancel()` 并回落标准曲线；
  - `fadeStep`：`if (!plan.graphMode && !plan.advanced) applyEqualPowerGains(...)` —— 进阶模式下增益全在四轨混音器里，deck 侧一次都不写；
  - `finishFade` / `cancelCrossfade` / `hardCutToStandby` 三处收尾都先 `disposeAdvanced(plan)`（幂等、吞异常）；
  - 新增 `logEvent('advanced-handoff', …)` 便于用现成的调试面板看是否真的接管。
- 测试：新增 `web/tests/advancedHandoff.test.cjs`(7)；`web/tests/crossfade.test.cjs` 的 `load()` 改为 ui/core 双目录查找并把 `../core/advancedHandoff`、`../core/mixTransitionMode` 注入 `require` 白名单（否则 vm 沙箱拿到 `{}`，异步阶段报 `readMixTransitionMode is not a function`）。
- 判据：`node --test web/tests/` **126 pass / 0 fail**；`npx tsc --noEmit` 0 error。

## 2026-11-16 · T5-1 / T5-2 / T5-3 / T5-4

- **T5-1 三档模式**：`mixTransitionMode` 扩为 `standard | advanced | advancedSafe`；新增 `MIX_TRANSITION_HINTS`、`MIX_TRANSITION_ORDER`、`wantsStemSwap()`、`allowsDegradedSwap()`（稳妥档不允许降级到「只换低音+鼓」）；`toggle` 变成 标准→进阶→稳妥→标准 循环。`CrossfadeSettings` 增 `mixTransitionMode` 字段（`readCrossfadeSettings()` 投影自独立键、`writeCrossfadeSettings({mixTransitionMode})` 写独立键），默认 `standard`。
- **T5-2 时间线**：新文件 `web/src/ui/transitionTimeline.ts` —— `buildTimeline(events, barMs, totalMs)` 输出四条泳道（drums/bass/other/vocals）+ `overhead`（duck/delaySend），块用 0–1 归一化 `x/width` + `bar` + `atMs/durationMs`；同一分轨的 A/B 两条曲线合并成一格；空事件/坏小节长度给 `emptyReason` 而不是画错。
- **T5-3 拖动换手点**：`PlanInput.handoffOverrideMs?`；新增 `snapToBar()` —— 优先吸附实测 `downbeats`，没有则按 `barMs` 等距吸附；不传参时行为与之前完全一致。
- **T5-4 一致性**：`describePlan` 的行以 `小节 N：` 开头、每条 action 恰好一行；测试锁定 5 模板 × 3 档置信度。
- 测试：新增 `web/tests/transitionTimeline.test.cjs`(7)、`web/tests/transitionHandoffPoint.test.cjs`(6)；`advancedHandoff` 改为复用 `MixTransitionMode`（两档进阶都走工厂）。
- 判据：`node --test web/tests/` **135 pass / 0 fail**；`npx tsc --noEmit` 0 error。
- 踩坑：`planTransition(input, planHint)` 的模板是**第二个参数**，input 里没有 `template` 字段；`downbeats` 为空会直接退化 `fixedEqualPower`（bassOnly/9 小节），写测试夹具必须给 downbeats。

## 2026-11-16 · T5-1 UI 接线

- `web/src/ui/app.ts` 快速面板「过渡」页新增一行 `过渡模式`：三档分段控件（标准 / 进阶 / 进阶·稳妥），标签取自 `MIX_TRANSITION_LABELS`（去掉括号备注），点击写 `writeCrossfadeSettings({ mixTransitionMode })`，并用 `MIX_TRANSITION_HINTS` 弹一句说明。
- `groupOfTitle` 增加 `['过渡模式','transition']`，保证它落在「过渡」页而不是别处。
- 判据：`npx tsc --noEmit` 0 error；`node --test web/tests/` **141 pass / 0 fail**（UI 改动不进入单测，逻辑层由 `mixTransitionMode.test.cjs` 覆盖）。

## §8 离线验收夹具（本轮新增）

- 新文件：`.scratch/transition-accept/emit.cjs`（加载 TS 纯函数层，产出 9 个场景的 plan/events/timeline）、
  `.scratch/transition-accept/measure.py`（合成音频 + 四项指标）。
- 产物：`events.json`、`metrics.json`；报告：`docs/zilux2-advanced-transition-acceptance.md`。
- 实测（PASS）：C1 换手点误差 **0.000 ms**、C2 低频波动 **0.000 dB**（同相）/ **1.013 dB**（去相关）、
  C3 人声重叠 **0.872 拍**、G1 全场景无双重人声、G2 8 步×2 ms 单调斜坡、G3 由 advancedSession 单测覆盖。
- 验收抓出并修掉的三个真 bug：
  1. `schedulePlan` 用 `1 - curve` 当出场曲线 → 等功率被破坏（中点 +1.6 dB、交点偏到 p=1/3）。改为 `buildSourceCurve()` = `gainAt().a`，并断言 `a²+b²=1`。
  2. 降级模板（bassOnly/bassDrumsOnly）漏覆盖 `other`/`vocals` → B 的人声永远进不来。`schedulePlan` 补覆盖，人声压到最后一拍（C3 8 拍 → 0.8 拍）。
  3. 人声侧链躲避压了整条 deck → 低频跟着塌 6 dB。`DuckEvent.stem` + `stemGraph.stemDuck` 每轨独立躲避。
- 附带修复：`releaseElements` 4 步 → 8 步，且每步独立绝对定时（链式回调会被推迟）。
- 判据：`node .scratch/transition-accept/emit.cjs` + `python .scratch/transition-accept/measure.py` → `VERDICT: PASS`；
  `node --test web/tests/` 141 pass；`npx tsc --noEmit` 0 error。

## 第 2 轮（goal round 2）：T4-3 把进阶路径真正接上

### 问题
`grep -rn "setHandoffFactory" web/src` 只有定义处 → `requestHandoff()` 恒返回 null，
`crossfadeDeck` 的进阶分支永远走不到，`AdvancedSession` / `StemGraph` / `StemPlayer` 全是死代码。

### 改动
- `web/src/core/advancedHandoff.ts`：`HandoffRequest` 增 `analysisA/analysisB/trackA/trackB/positionMsA/positionMsB/currentDurationMs/nextDurationMs/elementA/elementB/stemKeyA/stemKeyB/hint`；`Handoff` 增可选 `whenReady(): Promise<boolean>`（缺省视为同步成功，兼容旧实现）。
- 新 `web/src/audio/advancedReadiness.ts`：预热登记表。`stemWindowOf` / `stemKeyOf`（`source:id#window`）/ `markStemReady` / `isStemReady`（默认 TTL 10 min）/ `forgetStem` / `resetStemReadiness` / `readyStemKeys` / `prefetchStemsForTransition(a, b, {prepare, ttlMs, now})`（并发预热两侧，失败只标该侧、不抛）。
- 新 `web/src/audio/installAdvancedHandoff.ts`：真正的工厂。只接受「auto + 字段齐全 + 两侧窗口已预热」的请求；解析出 plan/events 后返回 `Handoff`，`start(clock)` 异步起 `AdvancedSession`，结果通过 `whenReady()` 交回；`cancel/dispose` 幂等。所有依赖可注入（`begin`/`loadPlayer`/`createGraph`/`ensureContext`/`destination`/`isReady`/`log`）。
- `web/src/ui/crossfadeDeck.ts`：
  - `beginTimeline` 里填全新字段（`stemKeyFor()` 容错版，模块被桩成空对象时返回 `''`）；
  - `scheduleNaturalFade(plan, clock, fromP, spanMs)` 支持「从当前进度接着走」；
  - 新增 `fallbackFromAdvanced(plan)`：四轨没接管时取消交接、从 `plan.progress` 接回等功率，元素/图两条路径都还原；
  - `whenReady()` 为 false/抛错 → `fallbackFromAdvanced`；
  - `prepareCrossfade` 末尾 `prefetchAdvancedWindows()`：用与交接点**完全相同**的两个位置（`fadeStartPosMs`、`bStartFileMs`）预热，键必然一致。
- `web/src/ui/app.ts`：构造函数末尾 `installAdvancedHandoff()`（幂等）。

### 判据
- `npx --no-install tsc --noEmit` → 0 error。
- `node --test web/tests/` → **150 pass / 0 fail**（新增 `advancedReadiness.test.cjs` 8 条；`crossfade.test.cjs` 新增「进阶交接请求带上分析/曲目/元素与预热键」1 条）。

### 设计取舍（写下来防止以后又走回头路）
- **只接已预热的窗口**：宁可这次降级成等功率，也不要在过渡中途等解码（那会静音几百毫秒）。
- 预热位置用 `plan.fadeStartPosMs` 而不是「当前播放位置」：auto 过渡起点在曲尾，按当前位置预热会预热错窗口。
- 回退从 `plan.progress` 续，不从头再来：否则一次失败会让整段过渡变成 1.5 倍速的错觉。

## 第 3 轮（goal round 3）：T5-2 试放台时间线 + G3 节点不泄漏自动检查

### T5-2：把「分轨换手预案」画进过渡试放台

- `web/src/ui/crossfadeDeck.ts`
  - 新类型 `CrossfadePreviewBlock { kind: 'swap'|'echo'|'duck'; deck: 'A'|'B'; stem; x; width; label }` 与
    `CrossfadeAdvancedPreview { mode; template; barMs; totalMs; summary[]; blocks[]; emptyReason }`；
  - `CrossfadeDebugState` 增 `advancedPreview: CrossfadeAdvancedPreview | null`（默认 null），
    这样试放台不需要自己去算门控，也不用碰 `resolveTransition`；
  - 新 `buildAdvancedPreview(options, plan)`：`resolveTransition({ mode: standard|advanced, analysisA/B, positionMsA })`
    → `barMs = beatMs * 4` → `buildTimeline(events, barMs, totalMs)` → 把 `lanes[].blocks[]` 拍平成 `blocks[]`；
    没有 plan 时把 `summary[0]` 当作 `emptyReason`；整段 try/catch，算不出来只是预览空白，绝不影响过渡；
  - `prepareCrossfade()` 末尾写入 `debug.advancedPreview`（在 `prefetchAdvancedWindows` 之前）。
- `web/src/ui/app.ts` `openCrossfadeLab()`
  - 「分轨换手预案」区块：标题（标准 / 进阶 / 进阶·稳妥 + 模板名）、`summary` 逐行、四条泳道（鼓/低音/旋律/人声）、
    每个动作按 `x/width`（0–1 归一化）绝对定位：`swap` 实心（A 蓝 / B 橙）、`echo` 紫色半透明、`duck` 顶部 6px 窄条；
  - 底部小节刻度行：`bars <= 8` 每小节标、`<= 16` 每 2 小节、其余每 4 小节，末位补总小节数；
  - 没有块时显示 `emptyReason`；`advancedPreview` 为 null 时显示「还没准备过过渡」。
  - 全部用内联样式，不依赖 lab-* 之外的 CSS，避免样式表改动。

### G3：节点不泄漏（自动检查）

- 新 `web/tests/stemGraphLifecycle.test.cjs`（3 条）：
  - 计数替身 ctx：`StemGraph` 建图 **38 个节点**（每台 19 = 7 总线 + 4 轨 × 3）、**48 次 connect**；
    `dispose()` 后 `disconnected === 38`，第二次 `dispose()` 不重复断（幂等）；
  - `applyAll(events, startTimeSec)` 起点早于 `currentTime - 0.05` 时返回 `false` 且不排事件；
  - `setEchoTime()` 夹到 `[0.01, 4]`，按 0.0001 / 99 / 0.42 得到 0.01 / 4 / 0.42。
- 结论：G3 从「人工听/看」升级为可回归的自动断言。

### 判据

- `node --test web/tests/` → **154 pass / 0 fail**（原 150，新增 1 条 crossfade 预案断言 + 3 条 G3）。
- `cd web && npx --no-install tsc --noEmit` → **0 error**。
- `crossfade.test.cjs` 新增「试放台预案：进阶模式给出泳道块，标准模式给出原因（T5-2）」，
  断言块的 `kind/deck/x/width` 合法且 `x + width <= 1`。

### 顺手修掉的测试基础设施问题

- `crossfade.test.cjs` 的 vm `require` 白名单补了 `./transitionTimeline`、`../core/advancedTransition`、
  `../core/transitionPlan`、`../core/tempoGate`、`../core/djMoves`、`../core/stemSwap` 以及它们内部的
  `./tempoGate` 等相对名 —— 少一个就会出现 `(0, tempoGate_1.decideTempoGate) is not a function`，
  而 crossfadeDeck 里那层 try/catch 会把它吞成「预览为空」，很难查；
- 因此 `buildAdvancedPreview` 的 catch 里保留了一行 `console.warn('[preview] failed', err)`：
  预览算错不影响播放，但必须有痕迹。

## 第 4 轮（goal round 4）：T3-6 PLL 接入（拍点锁相）

### 控制律：`beatPll.trackRate`

`nextRate()` 是给「deck 同步、目标速率 = 1」写的：它把速率夹在 `1 ± maxDeviation`，
可过渡时 B 的中心速率可能是 1.053（128↔135 的换算），拿 1 当中心会把它一路拽回原速。

新增纯函数：

```ts
export function trackRate(state: PllState, errorBeats: number, options: TrackOptions = {}): PllState
// center 默认 1；err > 0 表示 B 超前 → delta = -kp·err → 减速
// rate 夹在 center × (1 ± maxDeviation)，单步 ≤ maxStep
```

### 接线：`web/src/ui/crossfadeDeck.ts`

- `ActivePlan` 增 `pll?: { rate: number; errBeats: number } | null`；`CrossfadeDebugState` 增
  `pllActive / pllRate / pllErrBeats`（prepare 与收尾各重置一次，避免读到上一次过渡的残留值）。
- 新 `beatPhaseError(plan, elapsedMs, liveRate)`：
  - 仅 `kind === 'auto'`（手动切歌 / 单曲循环没有对齐语义，强行拉拍只会拖拍）；
  - 位置优先取元素真实 `currentTime`（那是 WSOLA 唯一诚实的时钟），取不到才退回
    `起点 + 已过时间 × 速率`；
  - `err = wrapBeatError(phaseB - phaseA)`，单位「拍」，正数 = B 超前。
- 新 `pllLiveRate(plan, center, elapsedMs)`：把 `err` 喂给 `trackRate`，写回 `plan.pll` 与 debug。
- `fadeStep()` 的变速分支改成两段：
  - `restore > 0`（已过 `MATCHED_OVERLAP_END`，A 已静音）→ 只走回正斜坡，不再修正；
  - `restore === 0`（A 还听得见）→ 走 `pllLiveRate()`，贴着 A 的拍微调。

### 已知边界（写在这里，别当成做完）

- **进阶（分轨）模式目前不吃 PLL**：stem 走的是 `AudioBufferSource` 的 `playbackRate`，
  在 `begin()` 时按 `resolved.plan.rate` 一次性定死；要让它也贴着走，得把 `StemPlayer.setRate`
  经 `AdvancedSession` 暴露给 `Handoff`，属于 T4 的下一步。
- 相位误差用元素时钟估算，元素被浏览器暂停 / 缓冲时会读到一个冻结的时间，
  这种情况 PLL 会保持上一步的速率（不会乱跳），但也不会纠偏。

### 判据

- 新增 `transitionPerformer.test.cjs` 三条 `trackRate` 用例（超前减速 / 落后加速 / 尊重 center、
  单步限幅、±0.5 拍回绕等价、NaN 兜底）。
- 新增 `crossfade.test.cjs`「PLL 接入：变速过渡时按拍相位微调 B 的速率（T3-6）」：
  A=120 / B=126 → `tempoRate≈0.952`，断言 `pllActive===true`、`pllRate` 落在 `tempoRate × (1 ± 1%)`。
- 改写原「matched playback rate stays fixed while A is audible」为
  「hugs A while audible」：现在对齐段的速率是 PLL 微调过的，不再等于常数，
  断言改为「落在中心速率的 ±1% 内」，回正段仍要求向 1 收敛。
- `node --test web/tests/` → **158 pass / 0 fail**；`npx --no-install tsc --noEmit` → **0 error**。

### 测试基础设施补丁

`crossfade.test.cjs` 的 vm `require` 白名单再补 `../core/beatPll` 与 `./beatPll`
（漏了就是 `wrapBeatError is not a function`，而且会被 `beatPhaseError` 外层吞成「PLL 没接管」）。

## 第 5 轮（goal round 5）：把 PLL 打通到分轨路（T3-6 延伸）

之前进阶分轨模式的速率是「起播时按 `plan.rate` 一次定死」，PLL 只作用于元素。本轮把
`setRate` 从会话一路接到 `fadeStep`。

### 改动

| 文件 | 改动 |
| --- | --- |
| `web/src/audio/advancedSession.ts` | `StemPlayerLike` 增可选 `setRate?`；类增 `bRateValue` 与 `setRate(rate)`（**只动 B**，A 永远是基准）、`get bRate()`；`begin()` 起播后记下 `plan.rate`；`disposeGraphAndPlayers()` 清零 |
| `web/src/core/advancedHandoff.ts` | `Handoff` 增可选 `setRate?(rate)`；未实现 = 该路径不支持微调 |
| `web/src/audio/installAdvancedHandoff.ts` | 会话类型加 `setRate?`；`handoff.setRate()` 仅在 `session.active === true` 时透传，异常吞掉 |
| `web/src/ui/crossfadeDeck.ts` | `fadeStep()` 变速分支：`plan.advanced?.setRate(plan.tempoRate * (liveRate / matchedRate))` |

### 为什么传「相对修正」而不是绝对速率

元素路径的 `liveRate` 含用户倍速（`baseRate`）与 PLL 微调，分轨播放器的速率只表达
「B 相对 A 的音乐速率」。直接把 `liveRate` 塞给分轨会把用户倍速乘两次。所以传
`liveRate / matchedRate`（≈1±1%），由会话乘到自己的 `plan.rate` 上。

### 判据

- `node --test web/tests/` → **160 pass / 0 fail**（新增 wiring 用例 1 条、`advancedSession` 用例 1 条）
- `cd web && npx --no-install tsc --noEmit` → **0 error**
- `advancedSession.test.cjs` 7 pass：`setRate(1.031)` 只产生一条 `B.setRate`；`NaN`/`0` 被忽略；`cancel()` 之后再调不触发

### 已知边界

- 分轨速率受 `AudioBufferSource.playbackRate` 精度限制（无 WSOLA），±1% 内听不出，超过 2% 会有轻微音高变化；`trackRate` 的 `maxDeviation=0.01` 正是为此。
- 分轨路 PLL 用的是元素 `currentTime` 时钟做相位参考（元素虽静音但仍在走时间线），真机上二者可能因缓冲略有偏差，属 §8 真机 E2E 的观测项。

## 第 6 轮（goal round 6）：PLL 稳定性修正 + §8 两项指标自动化

### 发现并修掉一个会「越抖越大」的控制律缺陷

用离线模拟（`.scratch/transition-accept/metrics-round6.cjs`）把「B 起播超前 30 ms」跑 64 拍，
发现残差轨迹是 `29 → 27 → 24 → 20 → 15 → 10 → 5 → 0 → 5 → 9.6 → 13.4 → 16.3 …`：
**过零后反向发散**，到 64 拍仍剩 18.4 ms。

根因：`trackRate()` 原先把速率当状态**累加**（`rate += -kp*err`），而速率本身是相位的一阶积分，
闭环成了双积分器，特征根 `|1 + i√kp| > 1`，必然以约 20 拍为周期越摆越大。

改法（`web/src/core/beatPll.ts`）：按误差**直接算目标速率**，再用单步限幅过渡：

```ts
const target = center * (1 - gain * err);            // gain 默认 0.3
const stepped = clamp(target, state.rate - maxStep, state.rate + maxStep);
const rate = clamp(stepped, center * (1 - maxDev), center * (1 + maxDev));
```

修正后同一条轨迹：`29 → 27 → 24 → 20 → 15 → 10.5 → 7 → 4.5 → 3 → 2.1 → 1.47 → 1.03`，
**第 7 拍（3.5 s）进入 ±5 ms，稳态残差 0.0005 ms，末态速率回到中心**。

### §8 指标补充

| 指标 | 口径 | 实测 | 判据 |
| --- | --- | --- | --- |
| 拍点漂移 | 30 ms 初始偏移经 PLL 收敛 | 7 拍后 <5 ms，稳态 0.0005 ms | <5 ms ✅ |
| 换手点误差 | 4 个 `SwapAction.startBar` 落到最近下拍的距离（`planTransition` + 128 BPM 1875 ms 小节） | 4/4 全为 **0.000 ms** | <5 ms ✅ |
| 曲线中点 | `gainAt({curve}, 0.5)` | linear 0.5/0.5（和 1.0）、equalPower 0.7071/0.7071（功率 1.0）、shelfDip 0.35/0.35 | 相关低频走 linear ✅ |

脚本：`node .scratch/transition-accept/metrics-round6.cjs` → `VERDICT: PASS`，结果落 `metrics-round6.json`。

### 回归测试

`web/tests/transitionPerformer.test.cjs` 新增「相位误差单调收敛，不会越抖越大（双积分器回归）」：
断言 32 拍内峰值不超过初值、8 拍内进入 ±5 ms、稳态残差 <0.5 ms、末态速率回到中心 ±0.0005。

### 判据

- `node --test web/tests/` → **161 pass / 0 fail**
- `cd web && npx --no-install tsc --noEmit` → **0 error**
- `npx vite build` → 构建通过（上一轮 1073 modules）

## 第 7 轮（goal round 7）：G2「回退无咔哒」自动化 + 回退路径的两条边界

### 落地

| 文件 | 改动 |
| --- | --- |
| `web/src/ui/crossfadeDeck.ts` | 新增 `rampDeckVolume(element, target, durationMs = 20)`：8 步**绝对定时**（约 2.5 ms 一步），单步不超过总量 1/8；`fallbackFromAdvanced()` 的元素分支由「一次性写目标音量」改为斜坡 |
| `web/tests/crossfade.test.cjs` | 新增「G2 回退无咔哒」：工厂返回 `whenReady → false`，断言 `cancel()` 恰好一次、回退重排的 A 曲线**起点等于当前进度的等功率值**（不跳回 0）、200 段相邻步长 <0.02、末点收到 0 |
| `web/tests/crossfade.test.cjs` | harness 增 `harness({ graph = true })` 开关，可强制走元素路径 |

### 顺带查清的两条边界（写进验收文档）

1. **进阶交接只在图模式生效**：`requestHandoff()` 调用点在 `beginTimeline()` 的 `if (plan.graphMode && clock !== null)` 分支内。元素模式下元素本身没有分轨能力，接不进去——所以「进阶未接管 + 元素路径」这一支实际不可达，`rampDeckVolume` 属防御性代码（真走到也不会咔哒）。
2. **回退的连续性由「从当前进度重排曲线」保证**，不是靠淡入淡出：`scheduleNaturalFade(plan, clock, progress, remaining)` 的起点就是 `naturalGains(progress)`，与回退前的目标值连续；测试用 `points[0].gain` 与 `naturalGains(0)[0]` 对齐来钉死这一点。

### 判据

- `node --test web/tests/` → **162 pass / 0 fail**
- `cd web && npx --no-install tsc --noEmit` → **0 error**
- §8 的 G 系列至此全部自动化：G1（无双声，离线合成测量）、G2（回退无咔哒，本轮）、G3（节点不泄漏，第 3 轮 38 节点/48 连接全断开）

## 第 8 轮（goal round 8）：离线四轨质量基准

- 工具链 `.scratch/stems-bench/`：`gen_synth.py`（合成四轨）/ `stemsbench`（反射调 `HtdemucsSession` 落 4 轨 raw f32）/ `sdr.py`（合成 SDR）/ `real_metrics.py`（真曲重构残差 + 跨窗一致性）。
- **修掉 harness 的左右声道读取 bug**（整块 BlockCopy 把交错流当左声道）：修前真曲重构残差 −0.18 dB（完全对不上），修后 **−35.55 dB**。这条现在是「分离基准的 0 号前置检查」：先验 `Σstems ≈ mix`，再谈 SDR。
- 结果：真曲（《晴天(DJ版)》45 s 起 24 s）7.8 s 窗残差 −35.55 dB、2 s 窗 −33.66 dB；跨窗一致性 drums 0.990 / vocals 0.994 / other 0.959 / bass 0.674（该段 bass 电平 −71 dB，低频周期估不出来，退化在预期内）。合成信号 SDR：drums 15.64 dB、bass 21.81 dB（7.8 s），`other`/`vocals` 为负且不可用（纯正弦 OOD）。
- 判据：新增 **G4 重构残差 ≤ −30 dB 且短窗 drums/vocals 一致性 ≥ 0.95**，全部满足。
- 仍未做：MUSDB18 真 SDR、真机 HTTP E2E、盲听 24 组。

## 第 9 轮（goal round 9）：T4-3 互斥静音 + 一键验收脚本

- **T4-3 落地**（`web/src/ui/crossfadeDeck.ts`）：
  - 新增 `ADVANCED_RAMP_MS = 20`、`muteDeckElementsForAdvanced(plan)`、`restoreDeckGains(plan, progress)`。
  - `beginTimeline()` 在 `plan.advanced.start(clock)` 成功后立刻互斥静音：图模式把**两条 deck 的 graph gain 都压到 0**（20 ms 斜坡），元素模式走 `rampDeckVolume`。
  - 为什么不能只把 `element.volume` 设 0：`createMediaElementSource` 抓的是元素解码输出，部分浏览器里 volume 不作用于该 tap——图模式必须压 gain，否则同一首歌两条时间轴叠加。
  - `fallbackFromAdvanced()` 改为「先 `restoreDeckGains(plan, progress)`（按当前进度等功率值、20 ms 斜坡）→ 再 `scheduleNaturalFade` 排剩余窗口」，顺序反了会从 0 一步跳上去（咔哒）。
- 新测试 `web/tests/crossfade.test.cjs`「T4-3 互斥静音」：断言接管后 2 条 `setDeckGraphGain(deck, 0, 20)`（active/standby 各一），推进 0.4 s 后回退时还原值 = `cos/sin(progress·π/2)` ±0.02 且斜坡 20 ms。
- 新增 **一键验收脚本** `.scratch/transition-accept/run-all.ps1`：测试 → tsc → 过渡指标 → 四轨质量，末行 `VERDICT: PASS/FAIL`，退出码 0/1；`-SkipStems` 可跳过依赖模型输出的那步。实测：`pass=163 / fail=0`、`0 error`、`C1max=0 ms`、`C3max=0.872 拍`、`G4 残差 −35.55 dB`。
- 验收表新增 **G5 进阶期互斥静音** 行（PASS）。

## 第 10 轮（goal round 10）：四轨播放器冷启动加固

- `web/src/audio/stemPlayer.ts`：
  - `start()` 改返回 `boolean`：**少一轨就整体失败**（先 `stop()` 再 `return false`）——只出声部乐器比回退标准过渡更难听、也难排查；顺带把 `createBufferSource()` 的异常吞掉并按失败处理（ctx 已关闭时会抛）。
  - 新增私有 `nowSec()`：`ctx.currentTime` 读不到（输出设备被拔掉 / ctx 被 close）时退化成最后已知时刻，避免 `positionSec` / `stop()` / `setRate()` 在异常路径上炸。
  - `dispose()` 加 `disposed` 标记，**幂等**；关闭后再 `start()` 直接返回 false，不再造 source。
  - `load()` 改 `Promise.allSettled`，错误信息点名**哪些轨失败 + 窗口号**（原来只说「4 轨音频不可用（drums/bass/other/vocals）」）。
- `web/src/audio/advancedSession.ts`：`StemPlayerLike.start` 返回类型改 `void | boolean`；起播后检查两侧，任一为 `false` 就 `throw new Error('四轨起播失败（窗口内没有音频）')`，走已有的「拆图 + 20 ms 斜坡还原 + 返回 inactive」路径。
- 新测试 `web/tests/stemPlayerAudio.test.cjs`（6 条，假 AudioContext）：四轨共用同一 `when`/同一偏移、缺轨整体失败且不留仍在播的 source、位置超出窗口内容返回 false、`load` 失败点名轨与窗口、ctx 关闭后 dispose 幂等且不再造 source、`setRate` 只改现有 source 且保住当前位置。
- `web/tests/advancedSession.test.cjs` 追加 1 条：`player.start` 返回 false ⇒ `session.active === false`、图被拆、元素音量斜坡还原。
- 判据：`node --test web/tests/` **170 pass / 0 fail**；`tsc --noEmit` 0 error；`run-all.ps1` **VERDICT: PASS**（C1max=0 ms、C3max=0.872 拍、G4 残差 −35.55 dB）。

## 第 11 轮（goal round 11）：排程边界硬化（NaN / 容差临界）

- **`web/src/core/stemSwap.ts` `scheduleEchoThrow`**：原来直接吃 `lengthBeats * beatMs`，分析结果缺字段时 `Math.max(1, NaN) === NaN`，`atMs/durationMs` 会变成 NaN 写进 `AudioParam`（部分浏览器把 `start(NaN)` 当「立即播放」，听感就是莫名爆音）。现在四个入参先净化：`safeStart`（有限且 >0，否则 0）、`safeBeat`（否则 500 ms）、`safeBar`（否则 `safeBeat*4`）、`safeLen`（否则 2 拍）。`eventsEndMs` 也跳过非有限值，不会把整条事件表算成 NaN。
- **`web/src/audio/stemGraph.ts` `applyAll`**：`startTimeSec` 非有限值直接 `false` + `console.warn`（原来 `NaN < x` 为假会一路排下去）。
- 新测试：
  - `web/tests/transitionPerformer.test.cjs`：「回声甩尾：BPM/小节长度缺失时排程仍是有限值」（4 组坏输入：全 NaN / BPM=0 / 全负 / 只有 barMs 缺失，断言 3 条事件的 `atMs` 有限非负、`durationMs ≥ 1`、`eventsEndMs` 有限）+「echoDelaySec 在 BPM 越界时回落到 120」。
  - `web/tests/stemGraphLifecycle.test.cjs`：「applyAll 时间门禁：容差边界与 NaN 起点」——`10`（正好现在）✅、`10.5`（未来）✅、`9.96`（早 40 ms，容差 50 ms 内）✅、`9.94`（早 60 ms）❌、`NaN` ❌。
- 判据：`node --test web/tests/` **173 pass / 0 fail**；`tsc --noEmit` 0 error；`run-all.ps1 -SkipStems` **VERDICT: PASS**。

## 第 12 轮（goal round 12）：T6-5 成本控制 + 验收报告终稿

- **补齐 T6-5**（低置信度时的成本控制）：`web/src/ui/crossfadeDeck.ts` 的 `prefetchAdvancedWindows()` 原来只判 `readMixTransitionMode() === 'standard'`，门控判成 standard（低置信度）时仍会去打 `stems=4` 预热——白烧 CPU/磁盘也白占缓存。现在加一道门：
  ```ts
  const preview = debug.advancedPreview;
  if (!preview || !(preview.barMs > 0)) return;
  ```
  `barMs` 只有真算出 plan 时才 > 0，所以「门控判 dead」与「模式是标准」共用同一个出口。
- 测试（`web/tests/crossfade.test.cjs`，harness 增加 `readiness` 间谍）：
  - 「门控判成 standard 时不预热四轨窗口」：`bpmConfidence = 0.3` ⇒ `prefetchCalls.length === 0`；
  - 「进阶档正常预热，且用的位置与交接点一致」：`prefetchCalls.length === 1`，`positionSec` 与 `fadeStartPosMs/1000`、`bStartFileMs/1000` 一致（原来这条一致性只是口头保证）；
  - 原 T4-3 用例的 `stemKeyA/B === ''` 断言改为 `'stub'`（间谍模块现在真的返回键，语义从「桩成空对象」变成「键算不出来才回落 ''」）。
- **验收报告终稿**：新增 `docs/zilux2-advanced-transition-final-report.md`（139 行）——结论表 / T2·T3·T4·T5·T6 逐条对照（每条给证据文件）/ §8 指标实测表 / 本轮抓出的 6 个真缺陷 / 已知边界 6 条 / 复现命令 / 相关文档索引。
- **README**：`## 运行与自测` 增加「进阶过渡（分轨换手）的离线验收」段——`run-all.ps1` 全量与 `-SkipStems` 两种用法、pwsh 7 要求、`VERDICT`/退出码说明、报告与口径文档链接。
- 判据：`node --test web/tests/` **175 pass / 0 fail**；`tsc --noEmit` 0 error；`run-all.ps1` 全量 **VERDICT: PASS**。

### 第 12 轮补充：盲听夹具（E1 落地工具）

- 新目录 `.scratch/listen/`：
  - `render_pairs.py`：任意两条歌的 4 轨素材渲染 24 组 A/B（同一段过渡 × 两种算法），
    `standard` = 整轨等功率 `cos/sin`，`advanced` = 读 `transition-accept/events.json` 的事件逐轨换手；
    每组装顺序随机、位置 ±1 小节抖动、RMS 对齐 ±0.5 dB；输出 `pairs/*.wav` + `index.json` + `key.json`；
    分轨支持 `<stem>.wav` 或 `<stem>_l/_r.f32`（后者可直接吃 `stems-bench` 的产物，需 `--a-prefix`）；
  - `listen.html`：本地 A/B 播放页（`1`/`2` 切边、`←`/`→`/`↓` 投票、localStorage 自动存档、导出 `answers.json`）；
  - `score.py`：按 WBS §8 E2 口径算「胜+平」占比与 95% Wilson 区间，输出 `VERDICT: PASS/FAIL`；
  - `README.md`：准备素材 → 渲染 → 起 `python -m http.server 8899` → 盲听 → 统计的全流程，含「别提前开 key.json」提醒。
- 冒烟：用 `stems-bench/out` 的 `d7_8_*` 合成四轨渲染 3 组成功（7.5 s/组，RMS ≈ 0.21，两版一致），
  `score.py` 用「全选正确边」的假答案得到 `胜+平 100% / CI [43.8%, 100%] / PASS`，链路自洽。
- 终稿报告已在 §4 写明执行命令与注意事项；E1 现在只差「你戴上耳机听完 24 组」。

## 第 13 轮（goal round 13）：过渡跨度跨窗续播

**问题**：32 小节模板在 128 BPM 是 60 s，而 `StemPlayer` 原来只装 `floor(position/30)` 那一个 30 s 窗口，`remainingInWindowSec()` 全仓库无人调用 —— 分轨音频放完就静音，进阶过渡在中途「掉声」。这是 §8 里 G1（无双声）之外的另一个「听起来像 bug」的真缺陷。

**改动**
- `web/src/audio/stemPlayer.ts`：`MAX_SPAN_WINDOWS = 4`、`spanWindowsSec(startSec, spanSec, windowSec)`；内部改 `windows: Map<window, Map<stem, buffer>>` + `sources: Map<'w:s', source>`；新增 `loadSpan(ctx, track, startSec, spanSec, bus, options)`（按窗串行加载，任一窗任一轨失败整体失败），`load()` 保留为单窗兼容入口；`start()` 逐窗 `source.start(when + lead, offset)`；`windowCount` getter；0 时长轨跳过并由计数校验判失败。
- `web/src/audio/advancedReadiness.ts`：`stemSpanWindows` / `stemSpanKeys` / `isStemSpanReady` / `prefetchStemSpan`（两条 deck 各自整段预热，单侧失败只标该侧）。
- `web/src/audio/installAdvancedHandoff.ts`：工厂顺序改为「字段齐全 → ctx/destination → resolveTransition → 算 span（`totalBars × beatMs × 4`）→ 超 4 窗直接 null → 查整段预热 → 建 `DeckSource`」，`loadPlayer` 签名加 `spanSec`，默认走 `StemPlayer.loadSpan`。
- `web/src/ui/crossfadeDeck.ts`：`prefetchAdvancedWindows` 用 `preview.totalMs/1000` 整段预热（`prefetchStemSpan` 优先，回落到单窗版）。

**判据**
- `node --test web/tests/` **183 pass / 0 fail**（新增 `stemPlayerAudio` 跨窗 3 条、`advancedReadiness` 跨窗 2 条、`installAdvancedHandoff` 门禁 3 条）。
- `npx --no-install tsc --noEmit` **0 error**。
- 跨窗用例：`loadSpan(0, 60)` → 8 条 source，第一窗 4 条在 `when`、第二窗 4 条在 `when + 25`（起播点 5 s + 窗边界 30 s），偏移集合 `[0, 5]`；`spanWindowsSec(0, 30) = [0]`、`(0, 30.001) = [0,1]`、`(30, 1) = [1]`。

**边界**：仍没有 WSOLA —— 单窗内 `playbackRate` 变化会带轻微音高偏移（±1% 听不出）；超过 4 窗（>2 分钟）的过渡仍回落标准等功率。

## 第 14 轮（goal round 14）：变速跨窗重排（PLL 与跨窗的交叉缺陷）

**问题**：第 13 轮把分轨改成跨窗播放，第 5 轮又把 PLL 接到了 `setRate`。两者相乘产生一个新缺陷：每个窗口的起播时刻是**按旧速率算好的绝对时间**（`when + (windowStart - position)/rate`），`setRate` 只改 `playbackRate` 不重排 → 速率变快时第二窗按原时刻起播，而播放头还没走完第一窗 ⇒ 两窗叠着放 200 ms+（正是 G1「双声」）；速率变慢时则中间空一段。

**改动**（`web/src/audio/stemPlayer.ts` `setRate`）
- 先取「旧速率下的当前位置」，再落新速率与锚点；
- 逐窗判断：`windowStart <= position` 的窗（已在播）只改 `playbackRate`，不动 `start()`，避免咔哒；
- `windowStart > position` 的窗（尚未起播）**撤掉旧 source 并按新速率重排**：`start(now + (windowStart - position)/next, 0)`；
- 非法速率（`NaN` / `0` / 负数 / `Infinity`）**整段忽略**，不重排、不打断正在播的排程。

**判据**
- 新增 2 条用例（`web/tests/stemPlayerAudio.test.cjs`）：`loadSpan(0,60)` 起播于 `when=100, position=5`；在 `ctx.currentTime=110` 调 `setRate(1.02)` 后第二窗从 125 改为 **124.7059**（=110+(30−15)/1.02），旧排程无残留、首窗 4 条 source 的 `start` 仍为 100、`playbackRate` 变 1.02；位置换算 20 秒后 = 25.2。
- 非法值用例：`setRate(NaN)`、`setRate(0)` 后 8 条 source 全部存活且起播时刻一字不变。
- 全量 **185 pass / 0 fail**、`tsc --noEmit` 0 error。

## 第 15 轮（goal round 15）：A/B 速率语义修正（两条时间轴分叉）

**问题**：`advancedSession.begin()` 把 `plan.rate`（= `bpmB/bpmA` 的折返比，专为 B 设计）**同时**塞给了 A 和 B 两个分轨播放器。

- A 是「正在放的那首」，不该参与 tempo 匹配，应为它自己的速率（用户倍速 `baseRate`）；
- 两条都乘 `plan.rate` 后，A 的实际 tempo 变成 `bpmA × rate = bpmB`，B 变成 `bpmB × rate` —— 两者之间又差一个 `rate`，等于「对齐了又不齐」，128 vs 126 时约 3.8% 的持续错拍；
- 更隐蔽的连带：PLL 用**元素** `currentTime` 算相位去纠正**分轨**，两条时间轴速率不同时，纠偏对象根本不是同一个相位，`whenReady` 之后的 `setRate` 越调越偏。

**改动**
- `web/src/audio/advancedSession.ts`：`DeckSource` 增可选 `rate?: number`（该 deck 元素当前 `playbackRate`，含用户倍速与 tempoRate）；`begin()` 改为 `rateA = a.rate ?? 1`、`rateB = b.rate ?? plan.rate`，`bRateValue` 记 `rateB`；`setRate()` 的注释明确为**绝对值**（不再乘 center）。
- `web/src/audio/installAdvancedHandoff.ts`：构造 `DeckSource` 时从 `request.elementA/B.playbackRate` 取真实速率（非有限值回落 1）。
- `web/src/ui/crossfadeDeck.ts` `fadeStep()`：进阶路径由 `setRate(plan.tempoRate * (liveRate/matchedRate))` 改为 `setRate(liveRate)` —— 元素与分轨拿同一个绝对速率。

**判据**
- `advancedSession.test.cjs` 新用例：`a.rate=1.5`、`b.rate=1.47` ⇒ 起播分别 `1.5` / `1.47`；随后 `session.setRate(1.48)` 只产生一条 `B.setRate(1.48)`（不再二次缩放）。
- `crossfade.test.cjs` 重写为「用户倍速 1.5 + BPM 126 vs 120」：分轨收到的是 `1.5 × 0.952 ≈ 1.428`，而旧实现会推 `0.952`（差 50%，足以证明语义已修）。
- 全量 **187 pass / 0 fail**、`tsc --noEmit` 0 error。

## 第 16 轮（goal round 16）：分轨「先放完」的静场兜底

**问题**：进阶过渡的跨度是按**小节数**算出来的（`totalBars × beatMs × 4`），而实际能放的音频取决于宿主窗口与文件余量。一旦文件/模型比预期短（尾部淡出、文件本身只剩 40 s、或 PLL 把速率拉到 1% 以上），分轨会先放完，而过渡还没走完 —— 听感是「最后半秒突然静音」，比任何曲线问题都刺耳。之前没有任何代码检查这一点。

**改动**
- `web/src/audio/stemPlayer.ts`：新增 `get remainingSec` —— 用「最后一个已装载窗口的末端 − 当前位置」折算成**真实秒**（除以 `rate`，变速后剩余时间随之变化）。
- `web/src/audio/advancedSession.ts`：`StemPlayerLike` 增可选 `remainingSec?: number`；会话新增 `get remainingSec(): number | null`，取两条 deck 的**最小值**；任一实现没提供则返回 `null`（= 算不出来，不做兜底，绝不因此误回退）。
- `web/src/core/advancedHandoff.ts` + `web/src/audio/installAdvancedHandoff.ts`：`Handoff` 增可选 `remainingSec?(): number | null`，安装器把它转发到会话，异常一律 `null`。
- `web/src/ui/crossfadeDeck.ts` `fadeStep()`：`progress < 1` 且 `remainingSec() < 0.4` 时 `logEvent('advanced-handoff', '分轨只剩 X s，提前接回等功率')` 并 `fallbackFromAdvanced(plan)`（该函数本身幂等：清 `plan.advanced`、`cancel()`、按当前进度 20 ms 斜坡还原元素、再把剩余窗口排成等功率）。

**判据**
- `stemPlayerAudio.test.cjs`：两窗装到 60 s、从 50 s 起播 ⇒ `remainingSec = 10`；`setRate(2)` 后 ⇒ ≈5 s。
- `advancedSession.test.cjs`：「两侧取最小（12 / 3.5 ⇒ 3.5）」+「实现不提供时为 `null`」。
- `crossfade.test.cjs`：「剩 10 s 不回退；掉到 0.2 s 立刻回退一次且不重复」。
- 全量 **190 pass / 0 fail**、`tsc --noEmit` 0 error。

### 第 17 轮（goal round 17）：MUSDB18-HQ 真数据集 SDR

**动机**：E2 一直是「未做」，验收表里只有无参考指标。本轮把数据集通路打通并测出真值。

**过程**
- 网络探测：`hf-mirror.com` 200；`huggingface.co` / `github.com` / `zenodo.org` 全部不可达（DNS）。
- `danjacobellis/musdb18HQ` 的 `validation` 分片 = MUSDB test；`validation-00000-of-00022.parquet` 504 MB，22.5 s 下完。
- 装 `pyarrow 26.0.1`；新增 `.scratch/musdb/musdb_extract.py`（parquet → 30 s 片段 → `mix_lr.f32` + `truth_<stem>.npy`）。
- 新增 `.scratch/musdb/musdb_sdr.py`（投影式 SDR + `_datasetResidualDb` 前置校验 + `_meanSdr`）。
- 两首曲跑通：`BKS - Bulldozer` 均值 10.28 dB、`Angels In Amplifiers - I'm Alright` 均值 9.23 dB，两曲均值 ≈ 9.75 dB。
- 数据集自洽性：`mixture − Σstems` 相对能量 −66.67 / −68.02 dB。

**判据**
- 抽取对齐：`_datasetResidualDb ≤ −60 dB`（实测 −66.7 / −68.0）。
- 推理速度：30 s 用 8.87–9.09 s（0.30× 实时）。
- 结果写进 `docs/zilux2-advanced-transition-acceptance.md` §7；口径边界（30 s 片段、fp16、4 线程 CPU）同处声明。

**仍未做**：盲听 24 组（需用户本人）、真机 HTTP E2E（需停实例）。

**第 17 轮补充（第三首曲）**：再抽 `Girls Under Glass - We Feel Alright`（30–60 s）→ drums 9.65 / bass 6.60 / other 7.77 / vocals 9.21，均值 8.31 dB，`_datasetResidualDb = −70.96 dB`。
三曲均值：drums **10.26**、bass **9.59**、other **6.05**、vocals **11.19**，总均值 **9.27 dB**。
注：`Secretariat - Borderline` 跨两个分片（mixture+other 在 00000、drums+bass+vocals 在 00001），本轮未拼接，改选同片完整的 `Girls Under Glass`。

**第 17 轮补充（E1 真实素材就绪）**：`.scratch/listen/out-real/` 生成 24 组真实素材（BKS - Bulldozer × Girls Under Glass - We Feel Alright，16 s/组，44.1 kHz，RMS 对齐 −18/−17 dB）；`score.py` 冒烟用假答案得 `胜+平 100% / CI [86.2%,100%] / PASS`，统计链路已通。等用户本人听。

### 第 18 轮（goal round 18）：长跑场景重放

**动机**：G1b/G1c/G6 都是单点用例；真实过渡是「4 窗 + 多次变速 + 兜底」叠加，需要一条把三者放在同一条时间轴上跑的重放测试。

**新增** `web/tests/transitionScenarioReplay.test.cjs`（4 条）：
- 四窗（120 s）从 2 s 起播、六次变速（1.02/0.98/1.0/1.03/0.99/1.01）：逐次校验 `start == now + (边界 − 位置)/rate`，并要求该时刻上恰好 4 条 source（重复排程 = 8 条即 G1 双声，漏排 = 0 条即空档）。
- 变速正落在边界（位置 30.000）：已过边界只改速率，后一窗只排一次。
- `remainingSec` 从 10 单调降到 0；0.5 s 不触发兜底、0.2 s 触发、其后不反复跨界。
- 长跑 120 s 后 `dispose()`：全部 source `stopped && disconnected`、`isPlaying=false`、`remainingSec=0`、重复 dispose 安全、再 start 返回 false。

**判据**：4/4 通过；全量 194 pass / 0 fail、`tsc --noEmit` 0 error、`run-all.ps1 -SkipStems` VERDICT: PASS。

**第 18 轮补充（A 侧速率同步）**：`AdvancedSession` 新增 `setRates({a,b})`（`setRate` 变成只改 B 的薄包装），`Handoff.setRates?` 逐层转发，`crossfadeDeck.fadeStep()` 传 `{ a: active.playbackRate, b: liveRate }`。
动机：过渡中推 tempo 推子时 A 的元素速率变了而分轨不跟 ⇒ 几十秒后鼓点与波形错开。
判据：`advancedSession.test.cjs`「setRates：A/B 各自跟住元素、非法值只影响该侧」、`crossfade.test.cjs`「A 侧速率一起推」；全量 195 pass / 0 fail、`tsc` 0、`run-all -SkipStems` PASS。

## 第 19 轮（goal round 19）：真机 HTTP E2E 12/12

- 单实例互斥体挡路 ⇒ 独立控制台进程反射起 `LocalMusicServer`，真 socket、真鉴权、真落盘。
- 4 轨与 2 轨都在 6.9–7.5 s/窗（30 s 音频，≈0.23× 实时），WAV 各 5,292,044 B。
- 契约边界实测：`stems=3`→400、`stem=foo`→400、无 token→401、2 轨取 drums→409。
- 交叉校验：HTTP 落盘与离线 bench 四轨 corr 1.00000；`inst − (drums+bass+other)` = −74.26 dB。
- 新增 `.scratch/stems-e2e/{StemsE2E.csproj,Program.cs,make-probe.py,README.md}`，日志 `artifacts/stems-e2e-rt/verify-e2e.log`。
- 本轮没做：GUI 内实跑进阶过渡（需要用户同意停掉他正在跑的实例）。

## 第 20 轮（goal round 20）：真实素材复测 + 口径修正

- 新增 `.scratch/transition-accept/measure_real.py`：把 §8 的 9 个场景改用 MUSDB 真曲四轨渲染（A = BKS - Bulldozer，B = Girls Under Glass）。
- 发现并修正口径问题：C2「RMS max−min」在真实音乐上量的是歌不是过渡（单轨低频自然起伏 >10 dB）。真实素材改用 **C2p**（对不相干功率和的偏差），窗口 200 ms（100 ms 周期太少、500 ms 抹平滑）。
- 结果：最差 C1 0.000 ms、C3 0.872 拍、G1 全 True、C2p 1.760 dB（旧整轨等功率同材料 4.106 dB）⇒ PASS。
- `measure.py` 同时加了 `load_real()` 与 `real=` 参数（合成口径保持默认不变，避免影响既有判据）。
- 待办：按两窗低频互相关自适应选 linear / equalPower（vocalFirst 场景暴露的边界）。

## 第 21 轮（goal round 21）：低频互相关自适应曲线

- 新增 `web/src/core/correlation.ts`（`normalizedCorrelation` / `lowBandCorrelation`）与 `PlanInput.correlation` + `chooseCurve` + `CORRELATION_THRESHOLD=0.35`。
- 真曲 ρ 实测 drums 0.0185 / bass 0.0133 / other 0.0103 / vocals −0.0020 ⇒ 两首不同的歌应当走 equalPower，模板写死 linear 是错的。
- 真实素材 C2p：最差 1.760 → **1.425 dB**（vocal-first 1.760 → 1.088），旧整轨等功率同材料 4.106 dB。
- 判据：201 pass / 0 fail、tsc 0、`VERDICT: PASS`；新增 `web/tests/transitionCurve.test.cjs` 6 条。
- 待接线：运行时需要 ρ（服务端在解码时顺带算，或在 `AdvancedSession.begin()` 加载后重排）。

## 第 22 轮：把 ρ 接到运行时（E6）

- 问题：第 21 轮做完了「按相关度选曲线」，但 `resolveTransition` 在计划阶段还看不到音频，ρ 永远是 undefined ⇒ 实际跑起来还是模板默认的 `linear`。
- 做法：`stemPlayer.monoSamples()` → `advancedSession.measureCorrelation()` → `input.replan(correlation)` → `resolveTransition({... correlation})` → 替换 events → `applyAll`。
- 守卫：`monoSamples`/`lowBandCorrelation` 任一不可用返回 `{}`；`replan` 返回 null 或抛错都沿用原事件。
- 测试：3 条新用例（重排生效 / 返回 null / 抛错），`samplingPlayer` 提供同源波形；跨 realm 用 `JSON.stringify` 比较空对象。
- 判据：204 pass / 0 fail、tsc 0。

## 第 23 轮：模板自动选择纳入段落与能量（E7）

- `doubleDrop` 从「只能手动」变成「两首都够热且调性不冲突时自动」，`sectionLabelAt()` 让 outro/intro 走 32 小节 standard。
- 阈值：hot ≥ 0.62、energyGap > 0.35 走 filterBuild、tempoDeviation > 6% 只换鼓+低音。
- 5 条新用例；全量 209 pass / tsc 0 / 验收 PASS。
- 记录一处夹具坑：`downbeats` 不足 2 个未来下拍时 fallback 先把模板压成 bassOnly，测模板必须把位置放曲中。

## 第 24 轮：回声甩尾真正接进运行时（E8）

- 洞：`scheduleEchoThrow` 全仓库无人调用 ⇒ 手法库的 `delaySend` 永远到不了 `stemGraph`，`vocalFirst` 只是「少换几轨」。
- 补：`TransitionPlan.echo` cue（vocalFirst 才有）→ `schedulePlan` 追加 `delaySend`×2 + `duck`；`mixTransitionTemplate` 三档（auto/vocalFirst/doubleDrop）+ UI「换手手法」分段；`crossfadeDeck` 把 hint 透传到 `resolveTransition`。
- 判据：214 pass / 0 fail、tsc 0、`emit+measure` PASS。
- 坑：`localStorage` 在小测试沙箱里是**裸全局**（不是 `window.localStorage`），模块里写成 `window.localStorage` 会被 try/catch 吞成默认值；跨 realm 数组要用 `JSON.stringify` 比。

## 第 25 轮：回声甩尾真实素材实测（E9）

- 新脚本 `.scratch/transition-accept/echo_probe.py`：按运行时的 delay/feedback/damp/send 参数，在 MUSDB 真曲 vocals 分轨上渲染甩尾；`--sweep` 出参数表。
- 实测（BPM 120、delay 125 ms、send 0.6、fb 0.35、damp 3 kHz）：峰值增量 +0.294 dB、尾巴 −14.35 dB、高频 −32.64 dB。
- 扫描结论：0.35/3 kHz 在「可闻 + 不吃余量」拐点；0.55 会到 +1.07 dB。
- `run-all.ps1` 增加 E9 一项；`-SkipStems` 亦跑。判据：VERDICT PASS。
- 坑：把 send 包络乘在 delay **输出**上会把尾巴整条抹掉（衰减到 0 就没声了）——包络必须乘在**送入 delay 之前**；测尾巴要用「切断后 0.4 s」窗口，而不是「切断后一拍」。

## 第 26 轮：WBS v2 覆盖检查（E10）

- 新脚本 `.scratch/transition-accept/coverage.py`：49 条 WBS 条目 → 「文件 + 必须出现的片段」，输出 ✅/👤/❌ 表与 `coverage.json`；E1（盲听）归为待人工，不计失败。
- 接进 `run-all.ps1` 作为 E10；当前 `有证据 48/49，待人工 1，缺失 0`，整体 `VERDICT: PASS`。
- 坑：①GBK 控制台打 ✅ 抛 `UnicodeEncodeError` ⇒ `sys.stdout.reconfigure(encoding='utf-8')`；②证据片段要抄文件里的真实字面量（`−35.55` 是 U+2212；`恰好一组 source` 不是「恰好 4 条」），否则会出假缺失。
- 判据：214 pass / 0 fail、tsc 0、`run-all.ps1 -SkipStems` PASS。

### 第 26 轮补充：构建级验证

- `npx --no-install vite build` → ✓ built in 4.39s，`dist/assets/main-FOJME4bs.js` 1,579.21 kB（gzip 532.43 kB）、`main-hUVIn8Ua.css` 354.18 kB（gzip 59.51 kB）⇒ T5 的「过渡模式 / 换手手法」分段与试放台预案都进了产物。
- `dotnet build src/Zilux2/Zilux2.csproj -c Debug -p:OutputPath=artifacts\lead-verify\` → 0 警告 0 错误（不占用用户正在运行的 exe）。

## 第 27 轮：标准路径黄金值冻结（C0）+ DJUCED 对照臂（E1b）

- `web/tests/transitionStandardGolden.test.cjs`（5 条）：`naturalGains` 五个进度点的字面量、`MATCHED_OVERLAP_END=0.82` 归一化、200 点功率守恒 1e-12、单调性、`smoothProgress`/`nearestTempoRatio` 黄金值 ⇒ 标准等功率路径不再可能被「等价重写」悄悄改掉。
- `render_pairs.py` 新增 `--style kill`：按 DJUCED 打垫行为逐轨小节线硬切（bass 0 / drums 2 / other 4 / vocals 8，5 ms ramp），生成第二组 24 对盲听素材 `out-real-kill`。
- 修掉响度偏差：`write_wav` 逐文件峰值归一化会把已对齐的 RMS 拉歪（实测差 0.96 dB）⇒ 新增 `write_pair()` 用**同一组共享系数**；修后两轮 max|dB| 均 0.493、mean 0.209。
- `coverage.py` 增 `C0` / `E1b` 两条 ⇒ 覆盖 50/51 有证据、1 待人工、0 缺失。
- 判据：219 pass / 0 fail、tsc 0、`run-all.ps1 -SkipStems` PASS。

## 第 28 轮：分离确定性（E12）+ 缓存身份校验（E11）

- `.scratch/stems-bench/determinism.py`：同混音跑 threads=4 / 4 / 1，8 个 `*.f32` 逐文件 SHA-256 全等（合并哈希 `5fce922c43c257f0`）⇒ 确定性 YES、线程无关 YES、PASS。这是「旧 2 轨逐字节不变」的底座。
- E2E 加两条断言：**2轨/4轨 vocals 逐字节相同**（5,292,044 B 一致）、`inst ≈ drums+bass+other`。
- 由此抓到真 bug：stems 缓存按路径做键、不校验源文件 ⇒ 同名文件换内容后仍返回旧分轨（实测 77 ms `cached:true`）。第一次 −28.96 dB 的异常就是它造成的。
- 后端 T2-7 修复（`StemsModels` 增 `sourceBytes`/`sourceModifiedUtc`、`StemSeparationService.SourceMatches` 门禁、`TrackAnalysisService.ResolveLocalPath` +6 行）：探针 81 PASS / 0 FAIL，E2E 16/16 PASS，改写后 `cached:false` 且 vocals 变。
- 顺手修「状态码随缓存历史变化」：`stems<4` 请求 4 轨 stem 时显式 409（原来取决于磁盘上是否有别人算过的 4 轨文件）。
- 覆盖条目 51 → 53（`E11`、`E12`），52/53 有证据、1 待人工、0 缺失。
- 判据：tests 0 fail、tsc 0、后端 build 0 警告 0 错误、探针 81 PASS、E2E 16/16。

## 第 29 轮：跨层接线集成（E13）

- 新 `web/tests/advancedIntegration.test.cjs`：真安装器 + 真会话 + 假播放器/图，跑完整一次进阶交接。
- 抓到缺陷：`Handoff.remainingSec?()` 只声明未实现 ⇒ 生产里 G6（分轨快放完时提前接回等功率）永远不触发。已补实现并纳入用例。
- 这条用例同时钉住「一条 deck 一个 StemPlayer」「两条 deck 同一个 when」「applyAll 起点 = when」「setRates 分侧」「cancel 幂等」。
- 判据：221 pass / 0 fail、tsc 0、覆盖 53/54（0 缺失）。

## 第 30 轮：预热预算（E14）

- `prefetchStemSpan` 改为「每侧串行 + 同键在途去重」，全局并发上限 2；异常不再被吞成布尔，`result.error` 保留原因。
- 修 unhandledRejection：`void task.finally(...)` 会派生一个跟着 reject 的 Promise，改成 `task.then(cleanup, cleanup)`。
- 用例 13 条（含峰值并发、去重、部分失败仍登记已成功窗口）；全量 224 pass / tsc 0 / 覆盖 54/55。

## 第 31 轮：验收报告完整性（E15）

- 新 `.scratch/transition-accept/report_check.py`：拿 `coverage.json` 的条目 id 逐个对到 `docs/zilux2-advanced-transition-final-report.md`（词边界匹配，避免 C1 命中 C1x），缺失即 FAIL。
- 首跑抓出 4 条「代码有判据、报告没结论」：`T4-0`（会话内核）、`G1b`（变速重排 124.7059）、`G1c`（A/B 速率语义 1.428）、`G1d`（A 侧跟 tempo）。已在报告补记表格。
- `run-all.ps1` 增 E15 步；当前输出 `55/55 条已写明`、总 `VERDICT: PASS`。

## 第 32 轮：产物可达性（E16）

- 新 `.scratch/transition-accept/bundle_check.cjs`：自跑 `vite build` → 检查 `dist/assets/main-*.js` 里 7 个 ASCII 标记（设置键、日志标签、`remainingSec`/`setRates`/`setEchoTime`/`applyAll`），缺失即 FAIL。
- 踩坑：`spawnSync('npx.cmd')` 在 Node 26 直接 EINVAL，改调 `node_modules/vite/bin/vite.js`；`stemSpanKeys` 这类函数名会被压缩，只能匹配字符串字面量与属性名；中文标记会被转义成 `\uXXXX`。
- 尝试过用 Edge headless + `OfflineAudioContext` 做真 AudioParam 探针，未跑通（dump-dom 在 load 快照、自写 CDP 客户端成本过高），已放弃并记录为已知缺口。
- 判据：`run-all.ps1 -SkipStems` → 7 行全 PASS，覆盖 55/56（1 待人工）。

## 第 33 轮：真浏览器 AudioParam 语义（E17）

- 用 Playwright + 本机 Edge（`channel="msedge"`）驱动真 `OfflineAudioContext`，在真 `StemGraph` 上量曲线：两路同相满增益 +6.02 dB、linear 中点 0.00 dB、equalPower 中点 +3.00 dB、双向淡出终点 −180 dBFS ⇒ PASS。
- 新文件：`.scratch/webaudio-probe/{probe.ts,vite.config.ts,index.html,run-probe.py,probe.json}`；`run-probe.py` 负责构建 + 舞台拷贝 + 驱动浏览器。
- 坑：`file://` 下 ES module 被 CORS 拦（改 IIFE）；`.scratch` 不在 `web/node_modules` 解析链，`vite.config.ts` 不能 `import { defineConfig } from 'vite'`（改纯对象导出）。
- 覆盖：新增 E17 ⇒ 56/57 有证据、1 待人工、0 缺失。

## 第 34 轮：`hold()` 兜底缺陷修正（E18）

- 真浏览器量出：`param.value` 在自动化期间返回内在值 1.0，且 `cancelScheduledValues(0.7)` 会把 0.2 s 起的 `setValueCurveAtTime` 整条撤销 ⇒ 旧兜底在打断点之前就跳回满增益（+5.2 dB）。
- 改法：`scheduleCurve` 换成 33 段 `linearRampToValueAtTime`（插值等价、可安全取消）；`hold()` 兜底改用 `recordPoints/valueAt` 自算值；echo/duck 端点一并记账。
- 判据：新兜底与 `cancelAndHoldAtTime` 的打断电平差相差 0.02 dB、最大跳变 0.004；探针 `rampFallback.before === -8.00 dBFS` 证明未撤销历史包络。
- 224 pass / tsc 0；探针 10 项 PASS。

## 第 35 轮：回声总线真机验证（E19）

- 探针新增 `renderEcho(stem)`：1 kHz 门控 0.10–0.35 s + `delaySend 0→0.6`（250 ms）+ delay 0.125 s。
- 实测：vocals 尾巴 **−12.74 dBFS**、drums **−180 dBFS**、隔离度 **167 dB**；1 s 后归零（反馈环无自激）。
- 意义：证明 `echoSend` 只接 vocals 这一条拓扑是真的（此前只有节点计数与 Python 模型）。
- 覆盖：新增 E19 ⇒ 58/59 有证据、1 待人工、0 缺失；`report_check` 59/59；`run-all -SkipStems` PASS。

## 第 36 轮：盲听入口一键化 + 全量验收

- 新增 `.scratch/listen/listen.py`：空闲端口起 `http.server` + 自动开浏览器 + 打印听音要点；修 `listen.html` 的 `index.json` 前缀（原来从仓库根起服务会 404，页面直接不可用）。
- Playwright 自检：`/out-real/index.json` 200、计数 `0 / 24`、无（除 favicon）控制台错误。
- 全量 `run-all.ps1`（不带 `-SkipStems`）：8 行全 PASS —— 224 单测、tsc 0、过渡指标 C1max=0ms / C3max=0.872 拍、E9 peak 0.294 dB / tail −14.35 dB、E10 58/59（1 待人工）、E15 59/59、E16 产物 1543 kB、G4 四轨残差 −35.55 dB 且 2 s 窗一致性 drums 0.990 / vocals 0.994。

## 第 37 轮：界面分组漏登记（E20）

- 现象：「换手手法」这一行没进 `groupOfTitle`，于是四个分页都会显示它（不报错、不抛异常）。
- 修复：`web/src/ui/app.ts` 补 `['换手手法', 'transition']`。
- 门禁：新增 `web/tests/quickSettingsGroups.test.cjs` 3 条（cell→分组全覆盖、四页非空、分组表不少于行数）；临时删掉映射可复现失败，恢复后通过。
- 判据：`node --test web/tests/` **227 pass / 0 fail**；`tsc --noEmit` 0 error。

## 第 38 轮：死导出审计（E21）

- 新增 `.scratch/transition-accept/dead-exports.cjs`：只审 15 个相关模块，`uses <= 1`（含定义行）即判「只有定义」。
- 首轮 6 条 → 修掉误判后：`wantsStemSwap`/`allowsDegradedSwap` 未接线（**advancedSafe 与 advanced 行为相同**）、
  `fallbackToStandard` 未接线、`TRANSITION_MODE_LABELS` 重复、`djMoves` 手法库为设计预留。
- 修复：`installAdvancedHandoff` 改用 `wantsStemSwap` 映射模式 + 稳妥档门禁（`tier !== 'full'` ⇒ 回落标准）、
  catch 改走 `fallbackToStandard`；删除 `TRANSITION_MODE_LABELS`；`djMoves` 加「设计预留 API」横幅并整体放行审计。
- 新增用例：`bpmConfidence=0.5` 时 `advancedSafe` 返回 null、`advanced` 正常换手。
- 判据：228 pass / tsc 0 / 死导出 0 条 / 覆盖 60/61（E1 待人工）。

## 第 39 轮：滤波扫频接线（E22）

- `transitionPlan` 为 `filterBuild` 生成 `filter {320 Hz → 18 kHz, ≥8 拍}`；`stemSwap` 新增 `FilterEvent` 并排程；
  `stemGraph` 每台 deck 加 `bus → hpf → duck` 的高通节点，`apply('filter')` 用指数斜坡扫频，`dispose` 一并断开。
- 踩坑：起点不能取「当前值」（高通默认 20 Hz = 全开）⇒ 直接写 `fromHz`。
- 判据：单测 231 pass / tsc 0；真浏览器过零率 0.5013 → 0.5201 → 0.6849（1.37×）⇒ probe VERDICT PASS。

## 第 40 轮：出场侧关门（E23）

- `transitionPlan` 的 `filterBuild` 补 `filterOut { 20000 → 700 Hz }`；`FilterEvent` 增 `band`；
  `stemGraph` 每台 deck 再 +1 个 lowpass（`bus → hpf → lpf → duck`），按 `band` 选节点。
- 判据：231 pass / tsc 0；真浏览器「开门」过零率 0.4679→0.4906→0.6562（1.4×）、
  「关门」0.3681→0.1394→0.0372（9.9× 下降），probe VERDICT PASS。
- 节点预算 42 / 连接 52（每台 21 / 26），G3 断言同步。
