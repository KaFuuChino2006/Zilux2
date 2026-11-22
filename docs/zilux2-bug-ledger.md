# Zilux2 Bug 台账（2026-11-20 起）

体检目标：`goal-6b2dc71a-96ac-4af2-86cb-fb36c8cddeaf`。每轮改动都要求
`npx tsc --noEmit` 干净 + `node --test web/tests/` 全绿 + `mix-audit --baseline --fail-on=2` 无劣化。

## 可复跑的体检台

| 工具 | 用法 | 作用 |
| --- | --- | --- |
| `web/tools/bug-scan.cjs` | `node web/tools/bug-scan.cjs --top=20 --json=.scratch/bug-scan.json` | 7 条静态规则（监听器泄漏、定时器泄漏、空 catch、`as any`、数字解析无 NaN 校验、形近 localStorage 键、裸 async） |
| `node --test web/tests/` | 直接跑 | 453 条单测（曾长期挂 2 条，已修） |
| `web/tools/mix-audit.cjs` | `--pairs=6 --baseline=.scratch/mix-audit-baseline.json --fail-on=2` | 全库 418 对决策回归闸门 |
| `web/tools/blind-baseline.cjs` | `--compare=... --max-drift=0.2` | 盲听抽查表与漂移闸门 |

## 第一轮已修（round 1）

| 级别 | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| P0 安全 | `src/Zilux2/Remote/RemoteService.cs` | 把带 `token=` 的宿主 API 地址透给遥控对端，同网段可借道改标签/落盘/删壁纸 | `ProxyUrl()` 先 `StripToken` 再拼代理地址；`ProxyAsync()` 服务端补令牌；`RewriteCovers()` 改正则整段替换 |
| P1 功能 | `src/Zilux2/WebViewHost.cs` | 订阅 `ScriptDialogOpening` 并 `Accept()`，自家 `window.prompt` 永远拿到空串 | 删掉整个订阅，只保留注入的空实现 |
| P1 静音 | `web/src/core/audioTap.ts` | `teardownTapNodes` 重建 `deckMix` 但不清 `deckTaps`，旧 tap 出口指向死节点 → 过渡整段静音 | tap 复用前校验 `context` 与 `output === deckMix`，不匹配则 `restore()` 后重建 |
| P1 无声 | `web/src/audio/automixV2Bridge.ts` | bridge/backspin/loopRoll 共用 `tap.gate`，谁先停谁放开 → 与 A 原声叠加；异常路径漏放 → A 永久没声 | 引用计数 `gateHolders` + `acquireGate/releaseGate`，catch 与 `stop()` 都走放行 |
| P1 静音 | `web/src/ui/mixHud.ts`、`web/src/ui/app.ts` | 关掉浮层后 `stop()` 不收回分轨：`masterGate` 停在 0、`stemLive` 33 ms 轮询还在跑 → **整个应用永久静音且无法恢复** | `stop()`/`dispose()` 先 `stopStems('浮层关闭（听原音）')`；`syncMixHud` 关闭分支 `dispose()` + 置 null |
| P1 冻结 | `web/src/ui/mixHud.ts` | `failed` 一次性标志无人复位，`start()` 首帧不在 try 内 → 一次异常后浮层永久冻住 | `start()` 复位 `failed/lastPaint` 并 try/catch；`reportError()` 抽成函数 |
| P1 泄漏 | `web/src/ui/crossfadeDeck.ts` | `segmentedControl` 的 `ResizeObserver` 无 dispose，设置页每重推整页重建 → 每页泄漏 15~16 个 | 返回 `dispose()`，`rebuildLengthValues` 换掉旧 seg 前先 dispose |
| P1 无声 | `web/src/ui/crossfadeDeck.ts:3660` | `applySchedule` 在 `plan.doubling` 赋值前读它 → `doubling` 选中即静默失效 | 改读 `schedule.doubling`，异步回调也比 `schedule` |
| P1 假阴性 | `web/src/core/automix/v2Quality.ts` | `estimateBassBumpDb` 用凸组合算叠加，恒等于 0 dB → 低频项永久不报警 | 低频按幅度相加比单侧最大值 |
| P1 过度桥接 | `web/src/core/automix/bridgePlan.ts` | 拿「buffer 总长」比「整段过渡目标」，缺口 4 s 硬补到 16 s，缺口 12 s 反而判死 | 只保留 `unitMs*(passes-1) >= shortfall`，循环点另有守卫 |
| P2 假阴性 | `web/src/core/automix/v2Quality.ts` | `rateJumpPctPerBeat` 多除 2 → 8 s 窗口要 `|rate-1|>0.48` 才可能报警 | 删掉 `/2`（实际只有单侧变速） |
| P2 契约 | `src/Zilux2/Analysis/TrackAudioDecoder.cs` | 截断时 `DurationMs` 硬写 720000，12 分钟以上 DJ mix 时间轴全错 | 时长始终取真实总长（`reader.TotalTime`），只截分析样本 |
| P2 契约 | `src/Zilux2/Analysis/BeatAnalyzer.Activity.cs` | 输出 `HopMs=250`，实际桶宽 255.4 ms；前端 `phraseMix`/`introBridge` 真按它换算 → 12 分钟偏 15 s | 输出 `framesPerBucket*1000/fps` |
| P2 缓存 | `src/Zilux2/Stems/StemSeparationService.cs` | 临时文件名固定 `path+".tmp"`，多写入方冲突 → 异常被吞、缓存静默丢失 | 临时名加 GUID；`finally` 只删自己的 |
| P2 缓存 | `src/Zilux2/Stems/StemSeparationService.cs:339` | `meta.Stems` 写请求值，2/4 轨来回切会重复推理几十秒 | 写「已产出集合」= `max(prior, 本次)` |
| P2 测试 | `web/tests/quickSettingsGroups.test.cjs` | 按行匹配 `cell('歌词衔接'`，该行改成多行形态后解析不到边界 → 长期 2 条红 | 改成按字符位置切片；`node --test` 现在 453/453 |


## 第二轮已修（round 2）

| 级别 | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| P2 契约 | `web/src/ui/crossfadeDeck.ts` 的 `pickV2StyleFor` 入参 | `bHasIntro` 用**文件毫秒**判前奏，带 `startAt` 的入场（续播/片段起播）被当成「有长前奏」，入口类手法全被放行 | 新增 `bFirstVocalOffsetMs`（文件毫秒 − `nextStartMs`），`bHasIntro` 优先用它 |
| P2 假接线 | `web/src/ui/crossfadeDeck.ts` 的 `planBackspin` | `keyGap: schedule.styleParams ? undefined : undefined` 两条分支同值，回旋刹车永远不显示调性提示 | 直接传 `camelotGap(a.camelot, b.camelot)` |
| P2 乱序 | `web/src/online/analysis.ts` + `web/src/core/automix/bridgePlan.ts` | `downbeats` 只过滤有限数，不排序；`pickBridgeUnit` 用 `value > start + barMs` 提前 `break` → 乱序时桥接单元静默丢失 | 新增 `normalizeTimes()`（过滤负数、升序、合并 <1 ms 重合）；`pickBridgeUnit` 去掉 `break` |
| P2 日志 | `src/Zilux2/Online/LocalMusicServer.cs:133` | token 明文进日志（等于把 `/api/` 全部权限交给任何能读日志的进程） | 只记 `fp=` 前 8 位与长度 |
| P2 契约 | `src/Zilux2/Online/LocalMusicServer.cs:1905-1929` | Range 越界被 clamp 到 `length-1` 且永不 416、`bytes=-0` 直接 500 | 起点越界或 `first>last` 返回 **416 + `Content-Range: bytes */len`**；`bytes=-N` 要求 `N>0 && N<=len` |
| P2 崩溃 | `src/Zilux2/Online/LocalMusicServer.Wallpaper.cs:826` | `/scan` 对 JSON 布尔调 `GetValue<string>()` → 500 | 改用能处理任意节点的 `IsTruthy(body["full"])` |
| P2 质量 | `src/Zilux2/Stems/StemSeparationService.cs` 的 `StereoAdapter` | 只取前两声道，5.1 素材丢掉中置（人声主体）→ 人声分离近乎空白 | ≥3 声道时中置与环绕各按 −3 dB（0.7071）混入，LFE 丢弃 |

## 第一轮已确认、尚未修（下一轮）

- **分轨超时语义**（P1）：`StemSeparationService.cs:290-293` 用 `Task.Run(func, timeout.Token)` 表达超时，token 只能阻止开始、不能中断 `OnnxRuntime.Run`；超时后 `finally` 提前释放 `_computeGate`，后续请求阻塞在 `lock(_runGate)` 上再超时，越点越卡。修法：`Task.Run(func)` + `await task.WaitAsync(budget)`，gate 由真正干活的 task 持有。
- **调性 Viterbi 量纲**（P2）：首窗发射权重 1.0、后续 0.1，换调罚 3.0 → 换调曲基本只用首窗的调。
- **流式播放读停滞**（P1）：`LocalMusicServer.cs:2081` 之后无读超时，上游黑洞会永久占线程。
- **非原子写盘**（P2）：`Mvmp3Cache` meta、`download-roots.txt`。
- **`vocalPresence` 器乐判据**（P2）：`voiced > 0.85` 直接判器乐，连贯说唱/长 hook 会被判死，唱词锚点静默关闭。
- **`vocalOverlapBeats` 阈值**（P2）：先乘 duck 系数再判 0.5，等效阈值变成 0.706~0.998，0 与整窗之间跳变。
- **UI 状态**（P1）：本地搜索时当前曲高亮/心形按下标回查未过滤列表 → 高亮错行；行比较 `id+source`、海报只比 `id`。
- **死设置**（P2）：`theme.ts` 的 `readTheme()` 硬编码 `light`，但每次启动仍写盘；`zilux2.miniMode` 只写不读。
- **全局订阅未释放**（P2）：`app.ts` 的 `zilux:stem-trim`、6 s 预热 `setTimeout`、`onLocalResult` 的 unsubscribe 等未进 `disposers`。

## 规则修正

- `mix-audit` 的 `B_SEEK` 对 `dropSwap`/`doubleDrop` 豁免：这两个手法的语义就是「把 B 的 drop 当落点」，`bStart > 0` 是设计不是缺陷。

## 回归基线（本轮结束）

```
node --test web/tests/           453 / 453 通过
npx tsc --noEmit                 干净
mix-audit --fail-on=2            ✔ 没有规则命中率劣化超过 2pp
  QUALITY_FAIL 3.1% → 2.6%    TOO_SHORT 0.0% → 0.5%
  VOCAL_OVERLAP 0.5% → 0.9%   NO_HANDOFF 0.0% → 0.2%（1 对，ENTRY 类）
```

## 第三轮（同一 round 2 内顺手收掉）

- `web/src/ui/backgroundLyrics.ts`：33 ms 时钟与 3 s 设置轮询现在存句柄，`pagehide` 时
  `clearInterval` 并把 `sceneBooted` 复位。`bug-scan.cjs` 从「1 个文件命中」变成 **0 命中**。

## 回归基线（round 2 结束）

```
node --test web/tests/           453 / 453 通过
npx tsc --noEmit                 干净
web/tools/bug-scan.cjs           0 命中（317 个前端文件）
mix-audit --fail-on=2            ✔ 没有规则命中率劣化超过 2pp
  QUALITY_FAIL 3.1% → 2.6%   VOCAL_OVERLAP 0.5% → 0.9%   TOO_SHORT 0.0% → 0.5%
部署                              exe 52,470,589 · web payload 10,761,819 · PID 95844
实测                              host.log 只写 `online token fp=xxxxxxxx`（无明文）
AnalyzerVersion                   p1-1-barchroma → p1-2-hopms（hopMs 语义变了，旧缓存必须失效）
```

## 第四轮（round 3）

| # | 位置 | 问题 | 修法 |
|---|---|---|---|
| 1 | `src/Zilux2/Analysis/BeatAnalyzer.Activity.cs` | 调性 Viterbi 量纲错：首窗发射权重 1.0、后续 0.1，而转移罚写 3.0。发射分是皮尔逊 r（−1~1），罚 3.0 等于要求 3.0 的相关差 → **换调曲永远只报首窗的调** | 统一 `KeyEmissionWeight = 1.0`（新增常量），转移罚改 `KeySwitchPenalty = 0.12`（与 r 同量纲）；探针 `.scratch/viterbi-probe.cjs` 复刻算法验证：旧配置 8 窗全 0 状态、新配置在第 5 窗正确换调 |
| 2 | `src/Zilux2/Storage/AtomicFile.cs`（新增） | 三处落盘非原子，且临时文件名固定 `path + ".tmp"`（并发互踩 → `Move` 抛 IOException 被吞 → 静默丢写） | 新共享工具：同目录 GUID 临时文件 + `File.Move(overwrite:true)`，失败清理临时文件后重抛；接入 `Mvmp3Cache.WriteMeta`、`LocalMusicService.SaveDownloadRoots`、`StemsMetaJson.Write`、`TrackAnalysisService` 的 JSON 缓存 |
| 3 | `src/Zilux2/Online/LocalMusicServer.cs` | 流式播放循环里 `ReadAsync(_shutdown.Token)` 没有读停滞超时，上游挂住就永久占一条处理线程 | 新增 `StreamStallTimeout = 20s`，每次读 `.AsTask().WaitAsync(StreamStallTimeout, _shutdown.Token)`；`TimeoutException` 记 `stream stalled` 并断开让播放器重试（`ValueTask` 上没有 `WaitAsync` 扩展，必须先 `AsTask()`） |
| 4 | `web/src/core/automix/v2Quality.ts` | `estimateVocalOverlapBeats` 的判据 `vocalA > 0.5` 在 duck 之后等于恒不命中（A=1.0 × 0.501 = 0.501，只有曲线恰好到 1.0 才算），指标长期报 0 | 新增 `audible = 0.35`（压完仍明显可听：A 原始需 >0.70，器乐 A >0.49） |
| 5 | `web/src/core/automix/v2Quality.ts` | `estimateLoudnessDriftLu` 只采 `swapShare` 尾段（B 中段掉 14 LU 时报 0.00），把最该抓的塌洞排除在测量外 | `fromP = 0`、`steps = levelsA.length - 1`，等功率权重按整段 0→1 归一 |
| 6 | `web/src/core/automix/vocalAnchor.ts` | `voiced > 0.85 → instrumental` 会把**连贯说唱/整段人声**判成器乐，且下游静默关掉锚点，用户只看到「不生效」 | 新增 `vocalPresenceDetail()` 返回 `{kind, voiced, contrast, reason}`；`crossfadeDeck.ts` 用 `anchorPresenceOk()` 统一判定，被挡时写 `automix-v2-anchor-blocked`（带理由），并提供 `localStorage['zilux2.dev.anchorforce']='1'` 强制启用（写 `automix-v2-anchor-forced`） |
| 7 | `web/src/ui/app.ts`（原 :11754-11769） | 墙面高亮/心形用「节点下标 → `this.wall.tracks` 下标」回查；搜索筛选激活时渲染的是子集 → 高亮与收藏状态落到别的歌上 | 改用节点自带的 `data-track-key`（`source:id`）与当前曲的 key 比对；心形直接传当前 `track` |

**质量门基线的语义变更（必须记录）**
第 4、5 项修的是**度量本身**，所以体检台数字会「变差」——这不是回归，是原来测错了。
- 旧基线：`QUALITY_FAIL 3.1%`、`VOCAL_OVERLAP ~0.5%`（阈值形同虚设 + 只量尾段）。
- 新基线：`QUALITY_FAIL 15.4%`（`loudness-drift 8.1%`、`vocal-overlap 7.7%`、`rate-jump 0.2%`），`drift LU p50 0.62 / p75 0.97 / p90 1.42 / max 4.92`（571 对）。
- 旧基线文件留档：`.scratch/mix-audit-baseline-pre-qualityfix.json`；新基线：`.scratch/mix-audit-baseline.json`。
- 这两个数字现在是**真实待办**（下一步要么降重叠、要么把 drift 的 46 对逐对看曲线），闸门本身仍绿（`✔ 没有规则命中率劣化超过 2pp`）。

**被推翻的审计结论（不改代码，记录理由）**
- 「分轨超时后 `finally` 提前释放 `_computeGate`，下一次请求阻塞在 `HtdemucsSession` 的 `lock(_runGate)` 上越点越卡」：不成立。`_computeGate.WaitAsync(0)` 是非阻塞的，忙时直接回 `Busy`（契约 §3.1，前端用 EQ 兜底）；`Separate` 每段开头 `ThrowIfCancellationRequested()`，超时抛出后由外层 `finally` 正常 `Release()`，没有提前释放也没有排队阻塞。真正的粒度问题是「超时以模型段为粒度、单段内不可中断」，属可接受的已知边界。

## 回归基线（round 3 结束）

```
node --test web/tests/     453 / 453 通过
npx tsc --noEmit           干净
bug-scan.cjs               0 命中
dotnet build               0 错误 0 警告
mix-audit --fail-on=2      ✔ 无规则命中率劣化超过 2pp（基线已按新度量重写）
AnalyzerVersion             p1-2-hopms → p1-3-keyviterbi（调性时间线数值变了，旧缓存必须失效）
部署                        main-BAKny5Uk.js 1,761.53 kB · payload 10,762,507 · PID 75816
```

## 第五轮已修（round 4：度量层，不是产品层）

这一轮没有改任何「听得到的东西」，改的是**体检指标本身在骗人**。起因：`QUALITY_FAIL 15.4%` 里有 46 对是 drift，而逐对把曲线画出来（`mix-audit --curves=N`）后发现最高那类的形状是「窗口开头一个 8–10 dB 的坑，随后爬升」——那不是混音塌洞，是度量模型假设了等功率交叉，而 v2 链在换手段之前一直把 A 按满电平保持。

| # | 位置 | 问题 | 修法 |
| --- | --- | --- | --- |
| 1 | `web/src/core/automix/v2Quality.ts` `loudnessRampCurve` | 用等功率权重（`cos²/sin²`）合成响度曲线，与 v2 链「A 保持满电平 → 换手段快速让位、B 同时 −60 dB 幽灵」不符 → 假坑 | `QualityInput.weights` 增加 `'compact'` / `'plan'`；`plan` 直接吃 v2 计划曲线的能量包络 `(low²+high²)/2` |
| 2 | 同上 | 编曲安静段（B 前奏比 A 副歌轻 10 dB）被计入判定 | 只保留「A、B 各自都在窗内 10 dB 以内」的采样点（`ACTIVE_MARGIN_DB=10`） |
| 3 | 同上 `estimateVocalOverlapBeats` | 只折算 A 的让位，没折算 B 的入场让位（`buildBEntryDuck` 压 B 的 1.5–4 kHz 6 dB）→ 入场让位的对全被判「两条人声重叠」 | 新增 `QualityInput.bEntryDucked`，B 侧乘 0.501 |
| 4 | `web/tools/mix-audit.cjs` | 没有曲线可视化的手段，只能盯着一个数字猜 | 新增 `--curves=N`（火花线 + 区间 + 曲对）；`auditOne` 保留 `_schedule` 供诊断，落盘前剥掉（否则基线 20 MB） |

**指标变化（571 对，同一批缓存）**

| 指标 | round 3 | round 4 |
| --- | --- | --- |
| `QUALITY_FAIL` | 15.4%（88 对） | **9.1%（52 对）** |
| `loudness-drift` | 8.1%（46 对） | 7.2%（41 对） |
| `vocal-overlap` | 7.7%（44 对） | **1.9%（11 对）** |
| `drift LU` p50 / p90 / max | 0.62 / 1.42 / 4.92 | 0.60 / 1.34 / 8.19 |

max 反而变大了：换成真实包络后，那对 `echoOut`（17.55 s 窗口）确实有 8.19 LU 的中途下坠（A 的尾奏衰减 + B 的尾段收尾叠加），以前被等功率模型抹平。**这是修好度量后暴露出来的真问题**，留到下一轮按「手法 × 是否 echoOut」单独处理。

基线另存：`.scratch/mix-audit-baseline.json`（新的）、`.scratch/mix-audit-baseline-pre-metricfix.json`、`.scratch/mix-audit-baseline-pre-qualityfix.json`。闸门仍 `✔ 没有规则命中率劣化超过 2pp`（round 4 与 round 3 比）。

回归：`node --test web/tests/` 453/453、`tsc --noEmit` 干净、`bug-scan` 0 命中、`mix-audit --fail-on=2` ✔。部署 `main-CnwEjxzl.js` 1,762.22 kB（只换 web，宿主没改），PID 81016。

## 第六轮已修（round 5：真实缺陷 + 死代码清理）

### A. 高频支路功率不互补（真实听得出的缺陷）

`web/src/core/automix/v2Plan.ts` 的紧凑段里，A 的高频按 `cos(vπ/2)` 退出，B 的高频按 `smoothStep01(v)` 进来 —— 两条曲线各自都「看起来」对，但**平方和不是 1**：

| v | aHigh² | bHigh² | 和 | 损失 |
| --- | --- | --- | --- | --- |
| 0.5 | 0.500 | 0.250 | 0.750 | −1.25 dB |
| 0.6 | 0.345 | 0.648 | 0.993 | −0.03 dB |

峰值偏差在 v≈0.45，`aHigh²+bHigh² = 0.5`，即 **−3 dB**：过渡中段中高频突然空一下，听感是「中间薄了一层」。这跟最早那版「单级分频在分频点凹 −6 dB」是同一类错误（一个在频域、一个在时域）。

修法：B 的高频改成对 A 的**功率互补** —— `bHigh = max(ghost, sqrt(1 − aHigh²))`，`ghost` 只在 A 还很满的前段兜底（不让 B 高于幽灵电平）。修完实测：

```
高频功率和最大偏差 0.0012 @p=0.04 → 0.01 dB 损失
p 0.2/0.4/0.5/0.6/0.7/0.8  →  aHi²+bHi² 全为 1.000
```

顺手删掉因此不再被引用的 `smoothStep01()`（`tsc` 的 `TS6133` 抓到的）。

### B. 三个「只写不读 / 只读不写」的死设置

| 位置 | 症状 | 修法 |
| --- | --- | --- |
| `web/src/ui/theme.ts` `readTheme()` | 硬编码 `return 'light'`，但 `applyTheme()` 每次都写 `localStorage['zilux2.theme']` → 写了永远没人读 | 读回并校验（`'dark' \| 'light'`），非法/不可用回落 `light` |
| `web/src/ui/app.ts` `MINI_MODE_KEY` | 每次切换都写 `zilux2.miniMode`，启动从不读 → 重启时先按完整模式画一帧、宿主再推事件，迷你窗里看到明显布局跳变 | 新增 `restoreMiniModeSeed()`，`onMiniMode` 订阅后立即按上次状态预置布局；宿主事件到达仍以宿主为准 |
| `web/package.json` | 没有 `test` 脚本，只能记 `node --test web/tests/` | 加 `"test": "node --test tests/"` |

### C. 三个没进 disposers 的全局监听

| 位置 | 监听 | 原来 |
| --- | --- | --- |
| `web/src/ui/app.ts` `installAdvancedHandoff()` 之后 | `zilux:stem-trim` | 匿名箭头，无移除路径 |
| `buildTopbar()` | `document pointerdown`（搜索面板外点关闭） | 同上 |
| `buildTopbar()` | `document pointerdown`（账号面板外点关闭） | 同上 |

三处都改成具名 handler + `this.disposers.add(() => removeEventListener(...))`。

### 度量层的已知边界（本轮记录，未改代码）

`mix-audit` 汇总里的 `q.drift` 用的是**宽带保守模型**（`weights: 'compact'`），不读真实计划曲线；`--curves=N` 才用 `weights: 'plan'`（直接采 `a.low/high`、`b.low/high`）。所以上面的高频修正**不会**让汇总数字变小——数字看不见它，但耳朵能。下一轮把 `evaluateQualityReport` 的调用点挪到 `applySchedule`（那里 `v2Plan` 已存在），让汇总也用真实包络。

另外 `echoOut` / `reverbOut` 的最差两对（8.19 / 8.18 LU，窗口都只有 3.2 s）量的是**干声**电平，而这两个手法的设计就是「用湿声（延迟/混响尾巴）填这一段」——湿声不在指标里，属于指标的结构性盲区，不是混音缺陷。

回归：`node --test web/tests/` 453/453、`tsc --noEmit` 干净、`bug-scan` 0 命中、`mix-audit --fail-on=2` ✔（`QUALITY_FAIL 9.1%`，与基线条目 0.0pp 差）。部署 `main-DnjuW0ti.js` 1,762.67 kB（只换 web），PID 88816。

## 第七轮（round 6）：质量门搬到规划期

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `web/src/ui/crossfadeDeck.ts` `buildSchedule` | `v2Plan` 只在 `startSplitMix` 生成，体检台（node vm）永远拿不到曲线，三轮指标修正全部空转；通用路径无质量门（`q = null` 占相当比例） | 规划期算 `plannedV2` + `plannedQuality`（`qualityWithCurves`），返回 `v2Plan`/`quality`；`ActivePlan.scheduleRef` 回写运行时重算结果 |
| 2 | `web/src/core/automix/v2Quality.ts` | `halfTime`/`backspin` 的故意变速被 1.5%/拍 判成 `rate-jump`（14 对） | 新增 `QualityInput.rateJumpLimit`，这两种手法传 12 |

覆盖率：有质量门的对 **0（通用路径）→ 571/571**。基线重设，旧档 `.scratch/mix-audit-baseline-round5.json`。
回归：453/453、tsc 干净、`mix-audit --fail-on=2` → ✔。
部署：`main-D1ZyQBR8.js` 1,764.60 kB（PID 89664）。

### 待办（round 7 起点）
- `echoOut`/`reverbOut` 湿声盲区：指标是否计入 send/return，或按手法分区统计。
- 42 对 drift 按「湿声 / 编曲 / 真塌」三分类。
- `app.ts` 其余未进 `disposers` 的监听（`buildUpNext` `:8939/:8973/:8981/:8985`、`ensureAirplayPop`）。

## 第八轮（round 7）：湿声盲区 + drift 分类

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `web/src/core/automix/v2Quality.ts` `loudnessRampCurve` | `echoOut`/`reverbOut` 的湿声尾不进指标 → A 干声一撤就记成 8.19 LU 塌洞 | `QualityInput.wetTail`（sendDb/decayMs/fromP），湿声按指数衰减折进 A 侧能量 |
| 2 | `web/src/ui/crossfadeDeck.ts` 乐句路径 `:2814` | 只给通用路径加了 `wetTail`，最差几对走乐句路径 → 数字不变 | 两条路径都按 `stylePick` 传湿声参数 |
| 3 | `web/src/core/automix/v2Quality.ts` `QualityReport` | 只有一个 drift 数字，无法判断是编曲还是真塌 | 新增 `curve?: {ps, lufs}` 诊断字段（`mix-audit` 落盘时带上） |
| 4 | 新增 `web/tools/drift-classify.cjs` | — | 复刻 drift 定义（单调反转最大幅度），按头/中/尾分类 + 手法交叉表 |

结果：`loudness-drift 42 → 38 对`、`max 8.19 → 6.12 LU`、`QUALITY_FAIL 9.8% → 9.1%`。
分类：开头 12 / 中段 12 / 尾段 14（中段才是真该改链路的）。
回归：453/453、tsc 干净、bug-scan 0、mix-audit ✔；部署 `main-B0nwj0YL.js` 1,765.19 kB（PID 87820）。

### 待办（round 8 起点）
- 最差对 `81c7afc3…→afc44aab…`（6.12 LU / mid p=0.62 / filterSweep / 12 s）逐点核对中带空档。
- 14 对尾段：收尾阈值（A 撤得太早）可调，或把 B 的入场提前半小节。
- `app.ts` 其余未进 `disposers` 的监听（`buildUpNext` `:8939/:8973/:8981/:8985`、`ensureAirplayPop`）。

## 第九轮（round 8）：分频段能量占比 + 缓存 BOM

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `web/src/ui/crossfadeDeck.ts` `planEnvOf` | `(low²+high²)/2` 假设低频占一半能量，流行歌实际 0.2–0.5 → 中段凭空算出塌洞 | 按 `lowShare`（`activity.bass` 窗口均值，夹 0.15–0.85）加权：`low²×s + high²×(1−s)`；A/B 各自算 |
| 2 | `web/src/ui/crossfadeDeck.ts` `tailFadeHandoffP` | A 的母带渐隐落在窗口内时，低频换手仍压到 0.78 才动，A 已虚弱 | 换手起点跟着渐隐起点走（`fadeStartMs` 前 0.05，夹 0.05–0.7），规划期与运行时两处都传 |
| 3 | `src/Zilux2/Analysis/TrackAnalysisService.cs:401` | 分析缓存用 `Encoding.UTF8` 写盘 → 带 EF BB BF；node/第三方 `JSON.parse` 直接抛 `Unexpected token '﻿'` | 改 `new UTF8Encoding(encoderShouldEmitUTF8Identifier: false)` |

回归：453/453、tsc 干净、mix-audit ✔（9.1%）、宿主 0 警告 0 错误；
publish exe 52,470,589 / payload 10,766,160；部署 `web.bak-20261120-084921`，PID 74336。

### 待办（round 9 起点）
- 12 对中段 drift 仍未归零：最差 `81c7afc3…→afc44aab…` 的 A 末 1.2 s 有 −15→−40 dB 的急收，B 前 8 s 是弱前奏 —— 需要判断是「窗口末端对齐」还是「B 起播点」问题。
- 14 对尾段：收尾阈值 / B 入场提前半小节。
- `app.ts` 其余未进 `disposers` 的监听（`buildUpNext` `:8939/:8973/:8981/:8985`、`ensureAirplayPop`）。

## 第十轮（round 9）：同一对歌两套口径

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `web/src/ui/crossfadeDeck.ts` `phraseQuality` | 乐句路径用 `weights:'compact'`、通用路径用 `weights:'plan'`，同一对歌换入口得出不同 drift（6.12 LU 的塌洞只存在于模型里） | 乐句路径也 `buildV2Plan(...)` 后用 `qualityWithCurves`，并按 `lowShareOf` 传两侧低频占比 |
| 2 | 同上 | `wetTail` 只传给通用路径，`echoOut`/`reverbOut` 的湿声尾巴在乐句路径上没计入 | 两条路径都传 `wetTail` |
| 3 | `web/src/ui/app.ts` `buildUpNext()` | 待播面板外点关闭用匿名 `document.addEventListener('pointerdown')`，永不解除 | 具名 `onUpNextOutside` + `disposers.add(removeEventListener)` |
| 4 | `web/src/ui/app.ts` `ensureAirplayPop()` | AirPlay 浮层的外点关闭与 Esc 关闭同上 | 具名 `onAirplayOutside` / `onAirplayEscape`，一次 `disposers.add` 里同时移除 |
| 5 | `web/probe_pair.cjs` | require 白名单漏 `genreProfile` → `budgetForAnalysis is not a function` 被 catch 吞成 `{}` | 改成「src 下真实存在就加载，失败兜底 `{}`」 |

回归：453/453、tsc 干净、mix-audit ✔（7.5%，比上轮 9.1% 更好）、bug-scan 0；
bundle `main-RkPZIEKc.js` 1,765.96 kB；部署备份 `web.bak-20261120-085*`，PID 91068。

### 待办（round 10 起点）
- 尾段 13 对：`A 撤太早`（A 在换手前 0.5 小节就开始掉）与 `B 入场提前半小节`（B 在 A 末句尾音上就进）。
- 头段 11 对：多为 `echoOut` 在 p=0.1–0.2 的第一拍还没起，A 已经在让——可以给 echoOut 加「A 保持到第一拍之后」。
- `HANDOFF_UNALIGNED` 仍有 1 对 `69b62d78->8621596f`（longBlend）。

## 第十一轮（round 10）：运行时包络与规划期不同源

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `web/src/ui/crossfadeDeck.ts` `startSplitMix` 的质量门重算 | `envOf` 写死 `(lo²+hi²)/2`，与规划期 `planEnvOf` 的 `lowShare` 加权不同源 → 同一对歌体检台一个数、App 里另一个数 | `envOf(c, lowShare)` 按 `lowShareOf(...)` 加权（夹 0.15–0.85），A/B 各算各的 |

回归：453/453、tsc 干净、`mix-audit --baseline --fail-on=2` → ✔（`QUALITY_FAIL 7.5% → 7.5%`，0.0pp）；
bundle `main-BW-fugiT.js` 1,766.08 kB；部署后重启 PID 79432。

说明：体检台在 node vm 里没有 AudioContext，只走 `buildSchedule`，**进不到 `startSplitMix`**，
所以这轮的修复不会让体检数字变化——它修的是 App 运行时显示/记录的那份质量门。

### drift 剩余项的性质（本轮已定性，不做「修复」）

- 头段 11 对几乎全是 `echoOut`：Apple 配方 16 的 `lp_cutoff_freq` 在 `t=0.125–0.25` 就压到 3500 Hz，
  而 `out_gain` 到 0.375 才掉。A「先变暗再被切走」是配方设计，能量包络把变暗记成掉电平 → 2.6–2.9 LU 假信号。
- 尾段 13 对是 A 在 `handoffP` 退净后 B 独自在场，B 开头比 A 副歌轻——编曲事实，不是缺陷。

### 待办（round 11 起点）
- `HANDOFF_UNALIGNED` 剩 1 对：`69b62d78->8621596f`（longBlend，fade=17550）。
- 若要让 drift 指标不再把「变暗」算成「变轻」，得在包络里对每个采样点应用当前 `sweepLp` 的
  频响权重（把 A 的频谱按 LP 传递函数积分），而不是只看增益曲线。

## 第十二轮（round 11）：常规路径缺 B 入场让位

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `web/src/ui/crossfadeDeck.ts` `buildSchedule` 返回对象 | `handoff=true` 且 `vocalAligned=false` 的对没有任何人声处理，两边同时唱（`HANDOFF_UNALIGNED` + `VOCAL_OVERLAP`） | 补 `bDuck`：`handoff && !vocalAligned` 时调 `buildBEntryDuck(...)`，A 唱完放开；空数组则不排 |
| 2 | `web/tools/mix-audit.cjs` `auditOne` | `HANDOFF_UNALIGNED` 不区分 B 有无唱词，器乐 B 也被判缺陷 | 加 `r.bPresence !== 'instrumental'` 前置 |

回归：453/453、tsc 干净、`mix-audit --baseline --fail-on=2` → ✔；`ENTRY_DUCKED 0 → 77`、`VOCAL_OVERLAP 5`、
`QUALITY_FAIL 7.5%`；bundle `main-DaiguGO7.js` 1,766.24 kB；部署后重启 PID 88872。

### 待办（round 12 起点）
- 频响加权版包络：把 `sweepLp` 的传递函数积分进每个采样点，让「变暗」不再被记成「变轻」——做完头段 11 对该归零。
- `NO_HANDOFF` 1 对、`HANDOFF_UNALIGNED` 4 对逐对看（都是 B 无人声或器乐的情况，需确认是否该直接允许）。

## 第十三轮（round 12）：两条通路抢同一个 `duck.gain`

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `web/src/ui/crossfadeDeck.ts` `startSplitMix` | `plan.bDuck`（B 入场让位）与 `plan.vocalOverlay`（acapella presence）都写 `b.duck.gain`，后写覆盖先写 → 让位深度/时机都不对 | `plan.bDuck` 仅在 `!plan.vocalOverlay?.enabled` 时排程 |

回归：453/453、tsc 干净、`mix-audit --baseline --fail-on=2` → ✔（7.5%，0.0pp）；
bundle `main-DVMDl1-o.js` 1,766.26 kB；部署后重启 PID 81956。

### 结论：头段 drift 是编曲弱段，不是链路缺陷
`echoOut` 的曲线在 `p<0.875` 上 `aHigh≡1 / bHigh≡ghost`，包络理论上是直线；凹陷来自 A 自身 LUFS 弱段。
因此**不做频响加权包络**（要解决的现象不存在），只把措辞从「塌洞」改成「弱段」。

### 待办（round 13 起点）
- `NO_HANDOFF` 1 对、`HANDOFF_UNALIGNED` 4 对逐对确认（B 无人声 / 器乐）。
- `ENTRY_DUCKED` 77 对抽 3 对人工听：确认 −6 dB 中频让位不显得 B 发闷。

## 第十四轮（round 13）：`groove` 路径漏人声让位

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `web/src/ui/crossfadeDeck.ts` 乐句路径 `phraseBDuck` | 条件写成 `entryUsable ? [] : …`，而 `groove`（按鼓点摆窗口）命中时 `entryUsable` 仍为 true → 鼓点对齐了、人声没人管（4 对 `HANDOFF_UNALIGNED`） | 改 `entryUsable && !groove ? [] : …` |
| 2 | 同文件质量门调用 | `bEntryDucked` 只看「有没有对齐」，不看「有没有排让位」→ 实际压了却报人声重叠 | `!entryUsable \|\| phraseBDuck.length > 0`；常规路径 `!plan.handoff \|\| (plan.bDuck?.length ?? 0) > 0` |
| 3 | 同文件声明顺序 | `phraseBDuck` 在 `phraseQuality` 之后声明 → `TS2448`；转译后抛异常被 catch 吞掉 → `QUALITY_FAIL` 假降到 10 对 | 把 `phraseBDuck` 整块移到 `phraseQuality` 之前 |

回归：453/453、tsc 干净、`mix-audit --baseline --fail-on=2` → ✔（7.4%）；
`HANDOFF_UNALIGNED 4 → 0`、`VOCAL_OVERLAP 5 → 4`、`ENTRY_DUCKED 77 → 81`；
bundle `main-CG-kM-VZ.js` 1,766.30 kB；部署后重启 PID 89144。

### 待办（round 14 起点）
- `NO_HANDOFF` 1 对（`99e95099->ef54e4e5`，phrase-match，双方都有唱词）：为什么没排让位也没对齐。
- `ENTRY_DUCKED` 81 对抽听 3 对，确认 −6 dB 中频让位不让 B 发闷。
- `A_OUTRO` 仍是 `QUALITY_FAIL` 的主要来源（多见于 filterSweep / bassSwap，A 尾段本来就在渐隐）。

## 第十五轮（round 14）：区分「没人声可交接」与「交接失败」

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `web/tools/mix-audit.cjs` `auditOne` | A 的尾段本来就没唱词时也报 `NO_HANDOFF`（没有可交接的对象） | 新增 `aTailGapBars`（A 最后一个 ≥0.45 的 vocal 桶到 `audibleEndMs` 的小节数）；`> 8` 时把 `NO_HANDOFF` 改记 `INSTRUMENTAL_TAIL` |

回归：453/453、tsc 干净、`mix-audit --baseline --fail-on=2` → ✔（7.4%）；
bundle `main-CG-kM-VZ.js` 1,766.30 kB；部署后重启 PID 81296。

### 未解决：`99e95099 -> ef54e4e5` 仍是 `NO_HANDOFF`

实测数据（BOM 已剥）：

- A `audibleEndMs 214613`、最后一拍唱词在 **200750 ms**、小节 2070 ms、`aTailGapBars 6.7`（不是器乐尾巴）；
- 窗口 `192057..206000`，**末句落在窗口内**；
- 但 `handoff=false`，`bDuck=0`、`vocalAligned=false`。

按 `phraseBDuck` 的构造（`vocal > DUCK_TRIGGER` 就出事件），A 在窗口内唱到 200.75 s 不可能得到空数组，
所以这条不是「让位算不出来」，而是**计划根本没走到乐句路径的让位分支**（`cueMode` 标着 `phrase-match`，
但 `handoff` 全 false 说明走的是另一条返回）。下一步要在 `buildSchedule` 出口打点，记录哪条 return 生效。

### 顺带记一条工具教训

分析缓存有 **BOM**（旧缓存是 round 8 之前写的），`JSON.parse` 直接抛
`Unexpected token '﻿'`；我更早的临时脚本读缓存必须先 `replace(/^﻿/, '')`。
新写盘已修为不带 BOM，但**旧缓存不会自动重写**。

## 第十六轮（round 15）：弱唱词兜底让位

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `web/src/core/automix/v2Quality.ts` `buildBEntryDuck` | `DUCK_TRIGGER = 0.45` 是严格大于；末段低吟/和声垫的歌（活动度 0.30–0.45）整段只产出 0 dB 事件 → `handoff=false` → B 一开播就唱、两边糊住（`99e95099 -> ef54e4e5`） | 新增 `DUCK_TRIGGER_SOFT = 0.3`，0.30–0.45 给 1.5–3.0 dB 浅让位；`target` 判据由 `vocal > DUCK_TRIGGER` 改为 `aDepth > 0` |

回归：453/453、tsc 干净、`mix-audit` 重设基线后 → ✔；`NO_HANDOFF 1 → 0`、`ENTRY_DUCKED 81 → 89（15.6%）`、
`QUALITY_FAIL 42（7.4%）`、`VOCAL_OVERLAP 4（0.7%）` 不变；bundle `main-Kpd532ed.js` 1,766.35 kB；
部署后重启 PID 86260。

## 第十七轮（round 16）：响度补平链路 + 两遍质量评估

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `web/src/audio/automixV2Graph.ts` | 窗口内 1.5–2.9 LU 的响度塌陷只有诊断、没有处置 | 新增 `loudnessTrim` 增益（`duck` 之后、`sweepLp` 之前）+ `scheduleLoudnessTrim()`（线性斜坡，只抬不降，上限 +3 dB） |
| 2 | `web/src/core/automix/v2Quality.ts` | 指标不知道链路有补偿，修了也看不出来 | `QualityInput.trimCurve` + 合成时加 `trimDb`；导出 `loudnessTrimCurve(curve, capDb=3)` |
| 3 | `web/src/ui/crossfadeDeck.ts` `qualityWithCurves` | 单遍评估 | 两遍：先量原始曲线 → 推补偿量 → 按补过之后重算；`startSplitMix` 用同一份 `loudnessTrimCurve` 排自动化 |

回归：453/453、tsc 干净、`mix-audit` 重设基线 → ✔；`QUALITY_FAIL 42 → 41`、`drift max 2.87 → 2.68 LU`、
`p90 1.18`、`VOCAL_OVERLAP 4`；bundle `main-BNYFlsK3.js` 1,767.40 kB；部署后重启 PID 83384。

## 第十八轮（round 17）：补平上限分档 + 机制锁定测试

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `web/src/ui/crossfadeDeck.ts` | A 有明显母带渐隐（`dropDb >= 8`）时，3 dB 补平上限只能补一半，留 3 LU 假失败 | `loudTrimCapDb`（渐隐对 6 dB / 其余 3 dB）随 `FadeSchedule` 传到运行时，规划与调度同口径 |
| 2 | 同上 `qualityWithCurves` | cap 硬编码 3 | 增加 `trimCapDb` 形参 |
| 3 | `web/tests/loudnessTrim.test.cjs` | 补平机制没有断言，改坏了没人知道 | 三条：只抬不降且受 cap、补平后漂移不变大、cap 越大漂移越小或不变 |

回归：456/456（新增 3 条）、tsc 干净、bug-scan 0 命中、`mix-audit` 重设基线 → ✔；
`QUALITY_FAIL 41（7.2%）`、`drift max 2.68 LU`；bundle `main-DKuh5rVy.js` 1,767.50 kB；部署后重启 PID 79760。

### 结论：drift 已到「可接受基线」

剩余 27 对 `loudness-drift` 全部落在 1.5–2.68 LU，且形状集中在窗口开头（A 已进尾奏、B 还没进）。
把阈值 1.5 继续往下压只会把编曲差异当缺陷；再往上抬就是改判据讨好报表。所以这一项**停在当前基线**，
后续只做回归监控（`--baseline --fail-on=2`）。

## 第十九轮（round 18）：三处全局监听进 disposers + 尾巴自动化抢占

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `web/src/ui/app.ts` 播放条 | `window.addEventListener('blur', () => …)` 匿名，重建播放条就多一条 | 具名 `onBarWindowBlur` + `disposers.add` |
| 2 | `web/src/ui/app.ts` 快捷面板 | `document.addEventListener('pointerdown', (event) => …)` 匿名，每开一次面板多一条 | 具名 `onQuickOutside` + `disposers.add` |
| 3 | `web/src/ui/app.ts` `ensureAirplayPop` | `window.addEventListener('resize', () => …)` 匿名 | 具名 `onAirplayResize` + `disposers.add` |
| 4 | `web/src/audio/automixV2Graph.ts` `scheduleAutomixV2TailBleed` | 旧的长尾自动化排在本窗口之后；再开一次过渡时旧的 `exponentialRampToValueAtTime` 与新曲线抢同一个参数 → 从旧目标值直接跳过来（听感「咔」） | 先 `cancelAndHoldAtTime(at)`（无该 API 时退 `cancelScheduledValues`）；指数斜坡不能从 0 起，`held <= 0.0002` 时先垫到 0.0002 |

回归：456/456、tsc 干净、bug-scan 0 命中、`mix-audit --baseline --fail-on=2` → ✔；
bundle `main-DxZsL9LI.js` 1,767.84 kB；部署后重启 PID 86072。

## 第二十轮（round 19）

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `web/src/audio/stemLive.ts` | 预取失败后游标已前进，下一个窗口被跳过 → 分轨试听静音 30 s | `scheduleWindow` 返回 `Promise<boolean>`，失败时 `nextWindow` / `scheduledUntilMs` 回滚到本窗口 |
| 2 | `web/src/audio/pitchShift.ts` | 逐声道独立求 SOLA 互相关 → 声像漂移 + 中频梳状（注释与实现不符） | 拆 `planPitch` / `renderPitchPlan`，多声道用单声道混合算一份计划后共用读点 |

回归：`tsc` 干净；`node --test web/tests/` 456/456；`bug-scan` 0 命中；`mix-audit` 闸门 ✔；部署 `main--Fsrq_Ux.js`（1,768.58 kB），PID 82492。

## 第二十一轮（round 20）

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `web/src/ui/crossfadeDeck.ts` | `A_OUTRO` 把「末句刚过」与「长器乐尾奏」混为一类，前者窗口前移可修、后者前移只是摊薄能量 | 新增 `meanVocalInWindow()`；窗口平均唱词 < 0.3 且**末句在窗口前 4 小节内**才前移，否则记 `automix-v2-outro-keep` 不动 |

结论：33 对 `A_OUTRO` 里绝大多数是长器乐尾奏（`aTailGapBars > 8`），属编曲而非链路缺陷，不再压指标。

回归：`tsc` 干净；456/456；`bug-scan` 0；`mix-audit` 闸门 ✔（`QUALITY_FAIL 7.2%`、`drift max 2.68 LU`）；部署 `main-BIaSdF72.js`（1,769.32 kB），PID 77876。

## 第二十二轮（round 21）：安装目录与缓存体检

**结论：stem 缓存策略是对的，安装目录里堆的是我自己的部署留痕。**

| 目录 | 大小 | 判定 |
| --- | --- | --- |
| `%LOCALAPPDATA%\Programs\Zilux2` | 2.6 GB → **379 MB** | 102 个 `web.bak-*`（我每次部署都备份）+ 9 个 11-07/11-08 的旧 `Zilux2-*.exe`（86 MB 一个），全部是我造成的留痕，已清理（保留最近 2 个 web 备份、主 exe 未动） |
| `%LOCALAPPDATA%\Zilux2\stems` | 2.5 GB / 53 首 | **不是缺陷**：`cache-policy.json` 写的是 `LimitMb: 5000`，`StemCacheLru.ResolveMaxMb()` 优先读它 → 上限 5 GB，当前在预算内所以从不触发 `stems.prune`（日志里确实一条 `prune` 都没有，与代码一致） |
| `%LOCALAPPDATA%\Zilux2\WebView2` | 648 MB | Edge 运行时缓存，正常 |
| `%LOCALAPPDATA%\Zilux2\models` | 124 MB | htdemucs 权重 |
| `%LOCALAPPDATA%\Zilux2\logs` | 21 MB | `host.log` 按 10 MB 轮转（`.1`/`.2`），正常 |

**顺带确认的两条实现细节**

- `StemSeparationService` 对在线曲目用 `temporary=True` 的临时音频文件（`:250/:286`），在成功（`:302`）与异常（`:400`）两条路径都 `TryDelete`，不残留。
- `StemCacheLru.Prune` 只枚举 `CacheRoot` 的**直接子目录**、整目录删除、按 `LastWriteTimeUtc` 从旧到新、`Pin` 住的目录跳过（漏传谓词时默认按 `IsPinned` 保护）——没有「删一半」的窗口。

**流程改进（我自己）**：以后部署不再新建 `web.bak-*`（`web/dist` 可重建，git 里也有历史），只在确实要回滚时手工留一个。

## 第二十三轮（round 22）

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `web/src/audio/stemLive.ts` | 切歌瞬间在飞的那次窗口加载完成后，会把自己 push 进 `nodes` 并按**旧曲**的 context 时间起播 → 新歌开头叠一层上一首的分轨 | 新增 `generation` 计数，`stopAll()` 自增；`scheduleWindow` 起手记 `gen`，每个 `await` 之后 `if (disposed \|\| gen !== generation) return false` |
| 2 | `web/src/ui/app.ts` | 6 s 分轨预热 `setTimeout` 无句柄，卸载后仍会叫醒模型 | 句柄入 `this.disposers` |
| 3 | `web/src/ui/crossfadeDeck.ts` | 手法选完窗口又被收尾规则压短（`halfTime` 4000 ms 门槛却排出 1600 ms 窗口），听感是硬切，体检台还把它记成该手法 | 规划期按 `STYLE_CATALOG[].minFadeMs` 校验，低于门槛就把 `autoStylePick` 置空并记 `automix-v2-style-drop`，退回中性过渡 |
| 4 | 同上 | 收尾规则「只留半小节」「结构计划」会把窗口压到 1–2 s | 若窗口 < `MIN_AUTO_BLEND_MS`(3200) 且起点还有余地，向前补足（向前补不盖 A 的末句），记 `automix-v2-floor-window` |

指标：`TOO_SHORT 3 → 0`、`LAST_BAR 3 → 2`，`QUALITY_FAIL` 保持 41（7.2%）、`drift` 不变；闸门 ✔。

回归：`tsc` 干净；456/456；`bug-scan` 0；部署 `main-BymcfDgy.js`（1,769.85 kB），PID 96980。

## 第二十四轮（round 23）

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | **部署流程（我）** | 我用 `rm -rf web && cp -r web/dist web` 部署，把发布时由 csproj 拷入的 `web/remote/index.html`（手机遥控页）一起删了 → 日志 6 条「未找到 web/remote/index.html，手机页将使用内置极简版本」 | 改成从**发布产物** `dist/Zilux2/web` 整体复制（csproj 会把 `web/dist` 与 `web/remote` 一起放进去），并校验 `web/remote/index.html` 存在 |
| 2 | `src/Zilux2/Online/LocalMusicServer.cs:2866` | 页面切歌/关窗断开时写 `WARN GET cover client gone`，每首歌一条，淹没真故障 | 降为 `INFO` |
| 3 | `src/Zilux2/Media/SmtcArtwork.cs` | 启动/退出阶段本地封面代理未监听，`127.0.0.1:58123 connection refused` 每首歌刷一条 WARN | 命中「本机 loopback 的 HttpRequestException」时降为 `INFO` |
| 4 | `web/tests/crossfade.test.cjs` | round 22 的两个新规则（窗口下限、手法门槛自洽）没有锁定测试 | 新增回归用例：66.5 BPM/109 s → 136 BPM 的那对，断言 `fadeMs >= 3200` 且 `fadeMs >= STYLE_CATALOG[styleId].minFadeMs` |

回归：`tsc` 干净；`node --test web/tests/` **457/457**；`bug-scan` 0；宿主 `0 警告 0 错误`；发布 `exe 52,470,589 / web payload 10,770,827`；部署 PID 93576（`web/remote/index.html` 已恢复）。

## 第二十五轮（round 24）

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `web/src/core/library.ts` `withLoopbackToken` | 宿主每次启动随机挑回环端口，而队列/歌单里的封面 URL 会存进 localStorage 跨重启。该函数见到「已有 token」就原样返回 → 旧端口 + 旧 token 一直活着：页面缩略图全空、SMTC 拿不到封面，日志是 `127.0.0.1:58123 connection refused` | 解析回环 URL，端口不同就换成 `onlineInfo().port`，并把 `token=` 一律替换成当前 token（没有就补）；非回环与 data URL 不动 |
| 2 | `src/Zilux2/Media/SmtcArtwork.cs` `TryResolveHttpSource` | 页面侧已会重绑，但加载的是旧缓存页面时仍会把旧回环地址送进来 | 宿主再兜一层：回环 `*/api/cover` 且端口与当前 endpoint 不同 → 按当前端口重建，查询串里 token 换成当前值（`WithCurrentToken`），其余参数原样保留 |
| 3 | `src/Zilux2/Media/MediaSessionService.cs` | 页面每 ~220 ms 推一次状态就全量打一行 `[smtc] state`，30 分钟 6000+ 行，真故障被埋 | 只在「标题 / 播放态 / 时长」变化时写，另加 10 s 心跳（`_lastStateSignature` / `_lastStateLoggedTicks`）——实测从 5 行/秒降到 1 行/10 秒 |
| 4 | `web/tests/coverUrl.test.cjs`（新增） | 上面第 1 条没有回归锁 | 3 条：旧端口+旧 token 被换掉、端口相同时不动 URL 且缺 token 才补、非回环/data URL 原样返回 |

验证：`tsc` 干净；`node --test web/tests/` **460/460**；`bug-scan` 0；宿主 `0 警告 0 错误`；发布 `exe 52,474,685 / web payload 10,771,052`；部署 PID 82676。实机日志（重启后端口 54569）：`cover skipped` / `cover read failed` 各 **0** 条，`[smtc] state` 只余 10 s 心跳。

## 第二十六轮（round 25）

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `web/src/ui/crossfadeDeck.ts` `halfTime` 折叠块 | 2:1 折叠把 `tempoRate` 设成 0.5/2，但**手法可能随后被丢弃**（round 22 的「窗口 < 手法最短」校验会把 `autoStylePick` 置空）。丢弃后速率没还原 → B 在 3.2 s 窗口里以 ×0.5 慢放，听感是拖长的糊音，体检台那行还是 `tech=-` | 新增 `halfTimeFolded` 标记；手法被丢弃时 `tempoRate = 1; tempoInverted = false` 并记 `automix-v2-halftime-cancel`。实测那对（`99e95099->69b62d78`）从 `rate=0.5` 变回 `0.881`（正常 ±12% 对齐） |
| 2 | `web/tools/mix-audit.cjs` | 「没有手法补偿的极端速率」没有规则，这类缺陷只能靠眼睛发现 | 新增 `RATE_UNSTYLED`：`|rate-1| >= 0.4` 且 `technique !== 'halfTime'` |
| 3 | 同上 | 闸门只比「命中率劣化超 2pp」，单条致命规则（B 被 seek 到歌中间、窗口 < 2.5 s…）出现 1 次也能通过 | 新增 `MUST_BE_ZERO = ['RATE_UNSTYLED','NO_HANDOFF','TOO_SHORT','B_SEEK']`：命中即回归，不受百分点容忍 |
| 4 | 同上 `LAST_BAR` | 规则只判「起点落进最后一小节」，把「歌在末句上收尾、窗口物理上只有 3.2 s」也算成缺陷（2 对，长期 0.5%） | 规则收紧为「起点在最后一小节 **且** 窗口短于一整小节」；并从 must-be-zero 列表移除（那是 A 的物理长度，可修的是别把窗口压得比它还短） |

指标（387 对）：`QUALITY_FAIL 7.2% → 5.7%`、`loudness-drift 4.9%`、`vocal-overlap 1.0%`、`drift p50 0.57 / p90 1.13 / max 2.4`、`RATE_UNSTYLED 0`、`TOO_SHORT 0`、`B_SEEK 0`；手法分布 `filterSweep 197 / echoOut 114 / bassSwap 43 / longBlend 15 / reverbOut 8 / halfTime 6`（6 条 halfTime 都是窗口够长的合法折叠）。

回归：`tsc` 干净；`node --test web/tests/` **460/460**；`bug-scan` 0；闸门 ✔（exit 0）；发布 `exe 52,474,685 / web payload 10,771,165`；部署 PID 83368。

## 第二十七轮（round 26）

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `src/Zilux2/WebViewHost.cs` `PostJson` | 每次启动都有 4 条 `webview2.post skipped: core not initialized`：CoreWebView2 建好前推送的状态 **直接丢弃**（在线源的端口/token、本地曲库、设置快照都在这一类里），页面表现为「一直没在线源 / 设置是默认值」 | 新增 `_pendingPosts` 队列（上限 64）+ `_lastPostByEvent`（按 `event` 记最近一份）；核心就绪时 `FlushPendingPosts()` 按原顺序补发，实测 `flushed 4 pending message(s)` |
| 2 | 同上 `OnNavigationCompleted` | 页面刷新 / 渲染进程崩溃恢复后，宿主不会重发状态；WebView2 对「脚本还没订阅」时的 Post 是静默丢弃 | `ReplayStatePostsAfterDelayAsync(700)` 与 `(2_000)` 各重放一次最近状态（只延迟重放：立刻发那一次页面基本还没订阅，等于白发一遍几百条曲库 JSON） |
| 3 | `web/src/online/client.ts` | 重放会让页面把同一份 `online` 状态反复应用：重跑 `onOnlineChange` 监听器（重拉曲库）、日志刷 3 条 `host ready` | 端口与 token 都没变时直接 return；实测重启后 `host ready` 只出现 1 次 |
| 4 | `src/Zilux2/Online/LocalMusicServer.cs:2528` | QQ 没有「最近播放」接口，每次启动都写一条 `WARN recent merged skipped source=qq` | 降为 `INFO`（平台能力缺口不是故障；真故障在 `/api/recent` 的 status 里） |

实机验证（重启后）：`webview2.post flushed 4 pending message(s)` → `[online] host ready port=56592 …` → 两次 `replayed 10 state message(s)` 且没有重复 `host ready`；`core not initialized` 0 条。

回归：`tsc` 干净；`node --test web/tests/` **460/460**；`bug-scan` 0；闸门 ✔；宿主 `0 警告 0 错误`；发布 `exe 52,474,685 / web payload 10,771,165`；部署 PID 86652。

## 第二十八轮（round 27）

| # | 位置 | 缺口 | 补法 |
| --- | --- | --- | --- |
| 1 | `web/tests/automixV2Schedule.test.cjs`（新增） | 体检台跑在 node vm 里没有 `AudioContext`，只走 `buildSchedule`；`scheduleAutomixV2` / `Duck` / `Presence` / `TailBleed` / `Release` / `scheduleLoudnessTrim` 这些**真正排自动化**的函数一直零覆盖（round 25 的「半速慢放」就是这一层的问题，靠肉眼看体检台行才发现） | 用「记录调用的假 AudioParam」代替真节点：`setValueAtTime/linearRamp/exponentialRamp/setTargetAtTime/cancel*` 全部入账，直接断言排了什么 |
| 2 | 同上 | 六条断言 | ①主曲线只用线性斜坡、增益非负、首点从 0 起（防「过渡前满音量漏出来」）；②让位夹 −9..0 dB；③人声叠加允许 +4 dB 但结尾必须回 0；④长尾收干必须**先**取消旧自动化再排气、且指数斜坡不从 0 起；⑤收尾用 `setTargetAtTime` 释放而非一刀砍；⑥补平只抬不降 |

测试写法要点（复用）：`ts.transpileModule` → `new Function('exports','require','module', js)`，`require` 传桩函数（`audioTap` 返回 `{attachDeckAutomixTap:()=>null}`、`v2Plan` 返回 `{V2_CROSSOVER_HZ:120}`）；假 deck 必须带齐 `lowGain/highGain/sweepLp/sweepHp/lowTrim/loudnessTrim/unfade/duck/reverbSend/reverbGain/reverbDamp/echoSend/echoDelay/echoFeedback/echoDamp/echoOut`。取值时**必须滤掉 `cancel*` 调用**（它们第二个参数是时间，混进值里会得出「越界」的假失败）。

回归：`node --test web/tests/` **466/466**（新增 6 条）；`tsc` 干净；`bug-scan` 0；闸门 ✔；发布 `exe 52,474,685 / web payload 10,771,165`；部署 PID 87384。

## 第二十九轮（round 28）

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `web/src/ui/crossfadeDeck.ts` 手法最短窗口校验（`:3587`） | 窗口被收尾规则/曲风预算压到手法门槛以下时，代码 `autoStylePick = null` —— 注释写的是「退回打分第二名」，实际是**什么都没退**：这条过渡还在，但没有扫频、没有让位、没有回声，就是一条裸等功率交叠。体检台表现是 `tech=-` 的 1–7 条（0.3–1.5%） | 不再置空：退回苹果系 `filterSweep`（无最短窗口门槛，短窗口下也是合理的处理），reasons 写明「窗口 X s 不足 Y 的 Z s」 |
| 2 | 手法选择的 `catch { return null }` | 任何一步抛异常都会静默退化成「没有手法」，日志与体检台都只表现为 `tech=-`，无法追 | 新增模块级 `lastStyleErrorText` + `export function lastStyleError()`；`catch (error)` 记录 `name: message`；体检台行里加 `styleErr` 字段 |
| 3 | `web/tools/mix-audit.cjs` | 体检只报 `fadeMs`，但 `tempoInverted` 时实际墙钟是 `fadeMs × tempoRate`（`crossfadeDeck.ts:5382` 的 `wallMs`），会出现「报表 12 s、耳朵 9 s」 | 行里新增 `wallMs` 与 `tempoInverted`；规则新增 `WALL_TOO_SHORT`（墙钟 < 2.5 s）并进 `MUST_BE_ZERO` |

指标（480 对）：`no-technique 7 → 0`、`QUALITY_FAIL 7.2% → 5.8%`、`TOO_SHORT 0.5% → 0.0%`；墙钟 `p10 5000 / p50 12000 / p90 23750 / min 2784`；`wallMs` 与 `fadeMs` 相差 >10% 的 6 对（都是 ±9–17% 的变速匹配）；`WALL_TOO_SHORT 0`。
手法分布：`filterSweep 246 / echoOut 137 / bassSwap 54 / longBlend 15 / reverbOut 13 / halfTime 9`。

回归：`tsc` 干净；`node --test web/tests/` **466/466**；`bug-scan` 0；闸门 ✔（exit 0）；发布 `exe 52,474,685 / web payload 10,771,165`；部署 PID 85220。

## 第三十轮（round 24）

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `web/src/ui/crossfadeDeck.ts` | `buildSchedule()` 从不产出 `form`，HUD/试放台「形态」永远 `—`（`selectForm` 是死代码） | 抽 `formOf()` 按实际路径写，两处返回都补 `form`；全库分布 `warp 56 / fade 514 / doubleDrop 1` |
| 2 | `web/src/core/automix/v2Quality.ts` + `crossfadeDeck.ts` | A 纯器乐时 `handoff` 恒假 → `bDuck` 恒 null → B 早唱直接盖在 A 上 | `buildBEntryDuck` 加 `aInstrumental`（按 B 侧响度压 −4.5 dB，A 收干净放开），常规路径接线；体检台新增 `INSTRUMENTAL_DUCK`（命中 3） |
| 3 | `web/tools/probe_pair.cjs` | 探针不打印让位事件，无法核对 | 输出 `bDuck / bDuckMin / v2Duck` |

回归：`tsc` 干净、466/466、`bug-scan` 0、`mix-audit --fail-on=2` ✔（`QUALITY_FAIL 6.7%`、`drift p90 1.18 / max 2.68`）、构建 `main-B-Vwk-Ez.js` 1,770.97 kB、部署 PID 90604。

## 第三十一轮（round 25）

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `web/src/ui/crossfadeDeck.ts`（乐句块 `end` 计算） | 「A 的最后一句必须唱完」只认 LRC；无歌词曲目等于没有守卫 → 48 对（8.4%）把人声切在窗口外，最大 10.5 s | 加活动度兜底：`currentStartMs + lastVocalEnd(analysis, audibleEndPosMs)`，同样 6 小节 / 32 s 上限 |
| 2 | `web/tools/mix-audit.cjs` | 这类缺陷没有规则守着，只能靠临时脚本 | 新增 `A_VOCAL_CUT`（用引擎 `lastVocalEnd` 口径，不再自己扫 activity 下标）；本轮 0 命中 |
（`probe_pair.cjs` 的 `bDuck / bDuckMin / v2Duck` 输出是上一轮加的，这里不重复记。）

回归：`tsc` 干净、466/466、`bug-scan` 0、`mix-audit --fail-on=2` ✔、构建 `main-f1deVWg3.js` 1,771.09 kB、部署 PID 81820。

## 第三十二轮（round 26）

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `web/src/ui/crossfadeDeck.ts`（`crossfadeLiveSnapshot`） | 让位只读 A 侧 `duck.gain`，「B 一开播就唱」那 88 对排在 B 上 → 浮层永远显示 `—` | 两侧取 `Math.min(duckA, duckB)`；`duckEvents` 累加 `v2Duck + bDuck` |
| 2 | `src/Zilux2/Online/LocalMusicServer.Wallpaper.cs`（Range 解析） | 起点越界 clamp 到最后一字节 → 永远 1 字节 206，循环播放卡最后一帧；`bytes=-0` 被当整段 | 不可满足一律 416 + `Content-Range: bytes */{length}`（对齐音乐流） |
| 3 | 同上（读循环） | `await ReadAsync` 无超时，客户端半挂会永久占线程与文件句柄 | `AsTask().WaitAsync(StreamStallTimeout, …)`，超时记 `wallpaper media stalled` 并断开 |

规划器不变量本轮全量验证：`v2Plan` 720 组网格 + 全库 9702 份 schedule，0 problems（无需改代码）。

回归：`tsc` 干净、466/466、`bug-scan` 0、`mix-audit --fail-on=2` ✔、宿主 0 警告 0 错误、
发布 `exe 52,474,685 / web payload 10,772,165`、部署 PID 89240。

## 第三十三轮（round 27）

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `web/src/core/automix/v2Quality.ts` | 「人声重叠」把同调合唱和远调打架算成一个数，无法判断要不要加深让位 | 新增 `estimateVocalClashBeats`（两边 ≥0.7 且 Camelot ≥4）+ `QualityInput.keyGap` + `QualityReport.vocalClashBeats`（只诊断，不改门控） |
| 2 | `web/tools/mix-audit.cjs` | 体检台看不出冲突性质 | 行里加 `q.clash`，新增 `VOCAL_CLASH` 规则（>2 拍才记） |

结论：剩余 4 对 `VOCAL_OVERLAP` 的 Camelot 距离全在 0–3（10B↔8A、7B↔7B、7B↔8A、7A↔7B），
且没有「两边同时满嗓子」的拍 —— 属合唱，不是让位不足，不再调链路。

顺手记一条部署坑：web 根目录是 `%LOCALAPPDATA%\Programs\Zilux2\web\`，
`index.html` 必须覆盖到 `web/index.html`，拷到上一级 App 根目录会让 App 继续跑旧 bundle。

回归：`tsc` 干净、472/472、`bug-scan` 0、`mix-audit --fail-on=2` ✔、构建 `main-W_V77-pU.js`、部署 PID 94896。

## 第三十四轮（round 28）

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `web/src/ui/mixHud.ts`（`restorePos`） | 位置存的是绝对像素，恢复时不夹视口：双屏拖到 x=2400 后拔副屏/换小屏 → 浮层整个在屏幕外，标题栏点不到，只能清 localStorage | 抽 `clampHudPosition()`（`web/src/ui/hudGeometry.ts`），恢复前夹到「至少留 120×60」 |
| 2 | 同上（resize 监听） | `window.addEventListener('resize', saveHudSize)` 匿名注册、`dispose()` 不摘 → 浮层关掉后仍在跑并拽着已移除节点 | 与位置夹取合并成 `onViewportResize`，dispose 里 `removeEventListener` |

回归：`tsc` 干净、477/477、`bug-scan` 0、`mix-audit --fail-on=2` ✔、构建 `main-BS0cHyoq.js`、部署 PID 72780。

## 第三十五轮（round 29–30）：器乐接缝被曲风预算覆盖

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `web/src/ui/crossfadeDeck.ts`（`instSeam` 落点） | 接缝只写在 `!structure && !handoff` 分支内，后面 `fadeEndFile - cap`（曲风预算）从终点倒推起点 → 起点被推后 2 小节，`INST_SEAM_SHIFTED` 3 对 | 在算 `fadeMs` 前统一再落一次接缝，并同步回写 structure |
| 2 | 同上（曲风预算块） | 预算是经验值，却会覆盖真实乐句边界 | `instSeam !== null` 时预算让位，记 `automix-v2-budget-skip` |

回归：`tsc` 干净、477/477、`bug-scan` 0、`mix-audit` ✔、构建 `main-DIbQFWOh.js` 1,772.43 kB、部署 PID 76856。

## 第三十六轮（round 30）：试听期间接入的 deck 恢复不了音量

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `web/src/core/audioTap.ts`（`setStemMonitor(false)`） | 试听期间才 `attachDeckToGraph()` 的 deck 被压成 `volume=0` 但没登记进 `stemMuteVolumes`，退出试听时空表命中失败 → 永久静音（过渡里一边没声） | 恢复分支对 `deckNodes` 里的元素兜底写回 `volume=1, muted=false` |

回归：`tsc` 干净、477/477、`bug-scan` 0、`mix-audit` ✔、构建 `main-yPfK3RVI.js`、部署 PID 83872。

## 第三十七轮（round 31）：壁纸子系统七项（只读审计 → 落地修复）

审计范围约 6100 行（`Wallpaper/` + `MainWindow` 的显示变更分支 + `wallpaperView.ts`）。P0 两条、P1 五条已修，P2 修两条、留两条。

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `src/Zilux2/Wallpaper/WallpaperHost.cs:580`（同 `:587`、`:1057`） | 暂停/继续壁纸时该屏 `filter_json` 整段被清空——`Pause` 只 new 带 `Kind/AssetId/Paused` 的 `CanvasState`，而 `SaveCanvas` 是整行 UPSERT（`LibraryStore.Canvas.cs:45-69`）。每屏 fps 只存在 `filter_json` 里 → 暂停一次帧率/裁剪/转场全丢 | 新增 `SaveCanvasPreserving(kind, monitorId, mutate)`：先 `GetCanvas` 取整行、只改 `mutate` 指定字段再写回；`Pause`/`ClearSequence`/`ApplySequence` 全部改用它 |
| 2 | `WallpaperHost.cs:360` | `ClearSequence(kind)` 收 kind 却不区分，写的是 `_inAppAsset?.Id` / `_inAppPaused` → 退出桌面序列会把桌面壁纸换成「软件内那张」 | 按 kind 取 `_desktopAsset`/`_inAppAsset` 与对应 `Paused` |
| 3 | `WallpaperHost.cs:334` | `ApplySequence` 调 `_rules.Dispose()`（= Stop + `Tick -=`），全仓无第二次 `Start()` → 用过一次序列后所有自动换壁纸规则静默失效，只能重启 | 改 `_rules.Stop()`（保留订阅），`ClearSequence` 里补 `_rules.Start()` |
| 4 | `WallpaperHost.cs:480` | `OnSequenceTick` 硬编码 `ShowSequenceItem(CanvasKind.InApp)` → 桌面序列只播第一张，还接管软件内壁纸 | 新增 `_sequenceKind`，`ApplySequence` 赋值、`ClearSequence` 置空，Tick 用 `_sequenceKind ?? CanvasKind.InApp` |
| 5 | `WallpaperHost.cs:976` + `src/Zilux2/MainWindow.xaml.cs:2949` | `RepositionDesktop()` 零调用点；`WM_DISPLAYCHANGE`/`WM_DPICHANGED` 只重铺歌词窗 → 改分辨率/插屏/改 DPI 后桌面壁纸停在旧尺寸（黑边/拉伸/新屏没壁纸） | 显示变更分支里补 `_wallpaperHost?.RepositionDesktop();` |
| 6 | `src/Zilux2/Wallpaper/Render/DesktopWebSurface.cs:304`/`:319-325`/`:363` | `AttachToDesktop` 先清 `_pendingAttach`/`_attachFallback` 再找宿主，失败即 return，`_health.Start()` 只在成功路径；`EnsureAttached:275` 又 `if (!_attached) return` → 开机自启抢跑时该屏整场没壁纸 | 失败时保留待挂状态并 `EnsureAttachFallback()`（2.5 s `DispatcherTimer` 重试）；`EnsureAttached` 在未挂载时主动调 `AttachToDesktop()` |
| 7（P2） | `web/src/ui/wallpaperView.ts:549`/`:562` | `fps` 初值 0，`paint()` 早于 `await load()`，`flush()` 无条件下发 → 服务端 `MonitorCatalog.Normalize` 把 0 夹成 30 并落库（144Hz 屏静默降帧） | `flush()` 只在 `fps > 0` 时带 fps 字段 |
| 8（P2） | `WallpaperHost.cs:1918-1942` | `Dispose` 只停两个定时器，漏 `_beatTimer`(12 ms)/`_sequenceTimer`/`_audioGainTimer`、`App.Audio.Frame +=`、`_scanner.Progress +=`、`_rules` → 退出时回调进已 Dispose 的 `_inApp`/`_db` | 统一 `StopTimer(ref timer, handler)` 停 5 个定时器并退订，`App.Audio.Frame -=`（`_audioHooked` 标志），`_rules.Dispose()` |

**日志降噪**：`src/Zilux2/Online/LocalMusicServer.cs` 的 aborted 请求块，判据扩为 `HttpListenerException` / `/api/wallpaper/v2/media/` / `/api/cover` → INFO（这三类是客户端主动断开：视频缓冲够了就断、刷新丢弃旧封面请求），其余仍 WARN。

**未修（留档，已在下一轮修掉）**
- P2-2 `src/Zilux2/Wallpaper/WallpaperRuntime.cs:296-299`/`:337-345`：某屏表面创建失败后 `_slots` 索引错位，`if (slot.Index != i + 1) continue;` 会跳过其余所有屏；`NeedsRebuild` 用 `_slots.Count != targets.Count` → 此后每次 Apply 重建全部表面（每屏 700ms 错峰，肉眼是全屏闪黑）。
- P2-3 同文件 `:358-365`/`:398-412`：`Push` 里 `_payloadFactory(target)` 对每块屏各调一次，`IsFirstAudibleTarget` 里再对每个 target 各调一次 → N 块屏 N(N+1) 次 SQLite 读，全在 UI 线程。

**核对后判定「不是缺陷」（避免重复排查）**
- `WallpaperStateJson.Build` 的 `screensJson` 恒 null（三个调用点全传 null）→ `layer.screens` 分支是死代码，每屏一个独立 WebView 表面，无可见症状。
- `fps = 0 = 不限帧` 的契约读不回来（`MonitorCatalog.cs:98` 把 `<=30` 夹 30），但 UI 的 `FPS_STEPS` 无 0 档，用户设不出 0。
- `BuildPayload` 连调两次 `ResolveTransition`，random 模式下返回值可不同——但序列化只用 `TransitionKey` 字符串，无影响。
- `filter_json` 被写坏时 `CanvasSettings.Parse`/`ReadFps` 都 catch `JsonException` 回默认，不会带坏数据进渲染。
- SQLite 并发：`WallpaperDb` 单连接 + `lock(_gate)` 覆盖整个 Read/Write lambda，HTTP 与 UI 线程不交错。

回归：`dotnet build` 0 警告 0 错误、`tsc` 干净、477/477、`bug-scan` 0、`mix-audit` ✔、publish `exe 52,478,781 / web payload 10,773,445`、部署 PID 92936。

## 第三十八轮（round 31 续）：`WallpaperRuntime` 索引错位 + payload 重复计算

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `src/Zilux2/Wallpaper/WallpaperRuntime.cs:141`（`NeedsRebuild`）、`:290`/`:340`（`UpdateDesktopVideos`/`PushAll`） | 用「计数 + 下标」对齐槽位：某块屏表面创建失败后 `_slots.Count != targets.Count` 恒真 → 此后每次 `Apply` 都 `StopSurfaces()` 重建全部表面（每屏 700 ms 错峰，肉眼全屏闪黑）；`if (slot.Index != i + 1) continue` 从那一项起一路跳过，后面的屏收不到状态 | 改为按屏键配对：新增 `_failedKeys`；`NeedsRebuild` 判「有无没试过的新键 / 有没有已消失的键」；`UpdateDesktopVideos`/`PushAll` 用新增的 `FindTarget(targets, slot.Key)`；失败分支记 `_failedKeys`、建槽成功时移除 |
| 2 | 同文件 `:358`（`Push`）、`:398`（`IsFirstAudibleTarget`） | `_payloadFactory` 每块屏各算一次，`IsFirstAudibleTarget` 再对每个 target 各算一次 → N 块屏 N(N+1) 次 SQLite 读，全在 UI 线程（多屏拖滑块卡） | 新增 `_payloadCache` + `BuildPayloadCache(targets)` + `PayloadOf(target)`，`Apply`/`PushAll` 起手建缓存、`finally` 清空；`Push`/`IsFirstAudibleTarget` 全走缓存 |

回归：`dotnet build` 0 警告 0 错误、477/477、`bug-scan` 0、`mix-audit` ✔、publish `exe 52,478,781 / web payload 10,773,445`、部署 PID **74224**；启动后 30 s 内 `[WARN]/[ERROR]` **0 条**（壁纸媒体流只剩 `request aborted … /api/wallpaper/v2/media/8` 的 INFO 与 206 记录）。

**教训**：`WallpaperRuntime` 里 `_slots` 与 `targets` 是「稀疏对齐」关系（失败会缺项），任何 `Count`/`Index` 的比较都会在第一次失败后永久失真。槽位必须按 `Key` 配对，重建判定只比 key 集合。

## 第三十九轮（round 32）：歌词请求没有缓存、两个窗口各打一遍上游

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `src/Zilux2/Online/LocalMusicServer.cs:1812`（`HandleLyricAsync`） | `/api/lyric` 平均 1366 ms、最慢 4949 ms（`host.log` 统计）；主页面歌词面板与背景歌词窗口各请求一次 → 同一首歌一个切歌周期打两遍上游，平台无逐字轨时还要串一次 AMLL 抓取。用户侧表现是「歌词迟迟不出来」+ 切歌空窗 | 新增 `src/Zilux2/Online/LyricCache.cs`：30 分钟 / 240 条缓存 + `GetOrAdd` 单飞；`Forget` 用于失败不缓存；缓存键含 `amll` 标志。`HandleLyricAsync` 改为 `await task.WaitAsync(LyricTimeout + 5s, _shutdown.Token)`；`ResolveLyricAsync` 的 token 只联 `_shutdown`（不联单个请求，避免首个请求断开把等待者一起取消） |
| 2 | 同文件（错误映射） | 上游超时被当成「没歌词」返回 502，前端会记住失败 | 超时单独 `504 upstream-timeout` 并 `Forget`；AMLL 强制且查无此歌抛 `LyricUnavailableException` → `404 lyric-missing`（确定结论，保留缓存） |
| 3 | `src/Zilux2/Wallpaper/WallpaperRuntime.cs:384` | `--no-incremental` 全量重建暴露 `CS8601`：`_payloadFactory` 返回可空，却存进非空的 `Dictionary<string, WallpaperLayerPayload>` | 字典与 `BuildPayloadCache`/`PayloadCache` 字段改 `WallpaperLayerPayload?` |

回归：`dotnet build --no-incremental` 0 警告 0 错误；477/477；`bug-scan` 0；`mix-audit` ✔；publish `exe 52,482,877`；部署 PID 91048；启动后 `[WARN]/[ERROR]` 0 条。

## 第四十轮（round 32 续）：壁纸视频流 one-shot 请求平均 5 s

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `src/Zilux2/Online/LocalMusicServer.Wallpaper.cs:1430`（`WriteWallpaperMediaAsync`） | 播放器请求 `bytes=N-` 时 `end = length-1`，一次把剩余几十 MB 全写过去；客户端缓冲够了就断开，写循环等 backpressure 才退出 → `host.log` 里 `media/22` 平均 4957 ms、最慢 7075 ms，并伴随 `request aborted` | 单次响应按 `MaxChunkBytes` 截断（`end = start + chunk - 1`、`partial = true`），`Content-Range` 如实报告；块大小实测 8 MiB 仍有 2.2 s 请求，最终取 **2 MiB** → 全部 0–3 ms |

回归：`dotnet build` 0 警告 0 错误；部署 PID 88112；启动后 12 s 内所有 `media/*` 请求 0–3 ms，`[WARN]/[ERROR]` 0 条。

## 第四十一轮（round 32 审计落地）：四条 P0

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `src/Zilux2/Online/LocalMusicServer.cs`（`_coverCache` / `StoreCover` / `PruneCoverCache`） | 只有 200 条上限、无字节预算、按字典顺序随机淘汰；实测单张 5.2 MB，长会话最坏 1 GB 常驻 | 加 64 MB 预算 + 单图 8 MB 上限 + `LastAccessUtc` LRU（两个读点都刷新） |
| 2 | `src/Zilux2/Settings/SettingsService.cs`（版本判定） | `version != 1` 即整份备份并回落默认值 —— 版本升到 2 会把所有老用户设置清空 | 三路：缺/非法→v1；`<=` 正常读；`>` 备份 |
| 3 | 同上（写盘 `tempPath`） | 固定 `settings.json.tmp`，并发写互踩 → `File.Replace` 抛异常被吞，设置静默不保存 | 改 `AtomicFile.WriteAllText`（GUID 临时名） |
| 4 | `src/Zilux2/Online/Mvmp3Cache.cs` `Clear()` | 只移到 `mvmp3-cache-trash`，无清理路径 → 每清一次多一份全量 | 新增 `PurgeTrash(keep)`，保留 7 天 |
| 5 | `web/src/online/analysis.ts` `peekAnalysis` | 负结果不缓存，日志 `api/analysis status=404` ×238 | `missing` 集合记负结果；`force`/成功清除；网络错误不记 |

回归：`dotnet build` 0 警告 0 错误；`tsc` 干净；477/477；`bug-scan` 0；`mix-audit` ✔；publish `exe 52,482,877 / web payload 10,773,541`；部署 PID 82732；启动后 `[WARN]/[ERROR]` 0 条、`api/analysis 404` 0 次、`[settings] load … version=1` 正常。

## 第四十二轮（round 32 续）：下载链路与缓存淘汰

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `src/Zilux2/Online/DownloadService.cs` `partPath` | 默认模板无 `{quality}`，同曲不同音质共用 `{target}.part` + `FileShare.None` → 第二个任务必抛 IOException（英文冒到 UI），且两任务写同一成品 | `.part` 名字带音质标记（`PartTag`），分辨率不变时仍可续传 |
| 2 | 同文件 `ResolveTargetPath` | 只判成品文件存在 → 并发下载互相覆盖 | 加 `HasPendingPart`（目录枚举 + 前缀/后缀比较，不用 glob） |
| 3 | 同文件 `Snapshot()` | `Take(30)` 按开始时间截断 → 第 31 条起，最早那条 running 任务消失、无法取消 | 先放 `running/paused/queued`，再补最近完成 |
| 4 | `src/Zilux2/Settings/SettingsService.cs` `ReadAbsolutePath` | 只校验绝对路径，`Z:\Music` 也能存 → 下载时才抛英文异常 | 校验 `Path.GetPathRoot` 存在，失败回落默认值并记 `reason=root-missing` |
| 5 | `src/Zilux2/Online/Mvmp3Cache.cs` `TryGet` | LRU 用 `LastWriteTimeUtc`，命中从不更新 → 热文件先被删、冷文件常驻 | 命中 touch（10 分钟节流），失败不影响播放 |

回归：`dotnet build` 0 警告 0 错误；477/477；`bug-scan` 0；`mix-audit` ✔；publish `exe 52,482,877 / web payload 10,773,541`；部署 PID 92348；启动后 `[WARN]/[ERROR]` 0 条。

## 第四十二轮补充：缓存统计漏掉 .part

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 6 | `src/Zilux2/Online/Mvmp3Cache.cs` `Stat()` | 只枚举 `*.mp3`，正在下载的 `.part` 不计入 → 设置页显示 0 B 但磁盘有几百 MB | 枚举目录后按 `.mp3`/`.part` 后缀过滤 |

回归：`dotnet build` 0 警告 0 错误；publish `exe 52,482,877 / web payload 10,773,541`；部署 PID 92548。

## 第四十三轮（round 32 第三批）

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `src/Zilux2/Settings/SettingsService.cs`（补丁入口 + `ApplyKnownValues`） | `Read*` 见到键就 `keys.Add`，非法值/同值补丁也触发保存与 `GeneralChanged` 广播 → 前端重拉设置、控件静默回弹，日志无提示 | 补丁前后各拍 `SerializeToNode` 快照，`KeepChangedKeys` 只留「值真的变了」的键；解析失败一律保留（保守）；日志改 `patch no-op` |
| 2 | `web/src/ui/downloadQueue.ts` `applyList` | 「重试」在宿主是新建 job，旧 error 记录仍在快照 → 列表两条同名歌 | 新增 `dedupeJobs`：按 `(source, trackId, quality)` 去重，优先 `running/paused`，非活时 `done` 优先 |

回归：`dotnet build` 0 警告 0 错误；`tsc` 干净；477/477；`bug-scan` 0；publish `exe 52,486,973 / web payload 10,773,871`；部署 PID 72048；启动后 `[WARN]/[ERROR]` 0 条。

## 第四十四轮（round 35：写盘原子性收口）

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `src/Zilux2/Online/Account/AccountStore.cs` | 固定 `_path + ".tmp"`，两处保存并发时互踩 | 改 `AtomicFile.WriteAllText` |
| 2 | `src/Zilux2/Online/Library/RecentPlayStore.cs` | 同上；`finally` 里删的是固定名临时文件 | 改 `AtomicFile.WriteAllText`，`finally` → `TryDeleteLegacyTemp()` |
| 3 | `src/Zilux2/Online/Kugou/KugouDevice.cs` | 同上 | 改 `AtomicFile.WriteAllText` |
| 4 | `src/Zilux2/Storage/CachePolicy.cs` `Update` | 设置页改预算与后台剪枝并发写同一临时名 | 改 `AtomicFile.WriteAllText` |
| 5 | `src/Zilux2/Local/AlacTranscoder.cs` | 固定 `.tmp` + 先删成品再移动 → 并发下缓存留下残缺 WAV | GUID 临时名 + 先落地者胜 + 失败自清 |
| 6 | `src/Zilux2/Local/DsfTranscoder.cs` | 同上（DSD 单曲上百 MB，失败残留更贵） | 同上 |

回归：`dotnet build` 0 警告 0 错误；`tsc` 干净；477/477；`bug-scan` 0；`mix-audit` ✔（`QUALITY_FAIL 6.7%`）；publish `exe 52,486,973 / web payload 10,773,871`；部署 PID 67776；启动后 `[WARN]/[ERROR]` 0 条，`%LOCALAPPDATA%\Zilux2` 无遗留 `*.tmp`。

## 第四十五轮（round 36：分轨监听残留 + 封面超时降噪）

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `web/src/core/audioTap.ts` `setStemMonitor` | 试听期间被压低并登记、之后又被移出 DOM 的元素，恢复时扫不到 → 登记永久占着强引用，音量永久 0 | 恢复分支末尾补一遍孤儿登记：还音量、`delete` |
| 2 | `src/Zilux2/Online/LocalMusicServer.cs`（`/api/cover`） | 上游 CDN 偶发 10 s 超时也走 `OnlineHttp.Error`，每首歌刷一条 `[ERROR]`；实测超时后 273 ms 即成功 | 拆 `catch`：非 shutdown 的 `OperationCanceledException` → `Info`（超时秒数），其余仍 `Error`；状态码保持 502 |

回归：`tsc` 干净；477/477；`bug-scan` 0；`dotnet build` 0 警告 0 错误；`mix-audit` ✔（`QUALITY_FAIL 6.7%`）；publish `exe 52,486,973 / web payload 10,773,957`；部署 PID 94496；启动后 `[WARN]` 0 条。

## 第四十六轮（round 37：本地文件服务 / 歌词链路 / ALAC 探测）

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `src/Zilux2/Local/LocalMusicService.cs` `ServeLocalFile` | `WebResourceRequested` 跑在 UI 线程，首次播放 DSF/ALAC 同步转完整首（30 分钟 DSD 几十秒～分钟）→ 整窗「未响应」，切歌/暂停全部排队 | 入口拿 `e.GetDeferral()`，`Task.Run` 里做解析/转码/读盘，回 UI 线程 `Respond` + `Complete()`（`Post` 失败直接送达，保证 deferral 必完成） |
| 2 | 同文件 Range 读取 | 256 MB 一档 → `new byte[跨度]` + `Respond` 再复制（峰值 ~512 MB）；无 Range 的大文件直接 416 | `MaxServeBytes = 8 MB`，超出一律 206 + `Content-Range` 分片；无 Range 的超大文件也走 206；`FileOptions.SequentialScan` |
| 3 | 同文件 `[local] serve` 日志 | 每请求一条，分片后一首歌几十条，挤掉排队的 WARN/ERROR | 新增 `HostLog.Debug`（默认关闭，`ZILUX2_DEBUG_LOG=1` 打开），该行改 Debug |
| 4 | `src/Zilux2/Online/LocalMusicServer.cs` `ResolveLyricAsync` | AMLL 兜底与平台共用 10 s CTS，AMLL 挂住 → 504 且丢弃已拿到的平台 LRC | `AmllTimeout = 3 s` 子预算 + `TryFetchAmllAsync`，超时返回空串走平台歌词 |
| 5 | `src/Zilux2/Online/LyricCache.cs` | `LyricUnavailableException` 使 Task faulted → 命中条件不成立 → 404 永不缓存，每次重打 GitHub | 独立负缓存（10 min TTL / 上限 500）：`MarkMissing` / `IsMissing`，命中日志 `negative-hit` |
| 6 | `src/Zilux2/Online/KugouProvider.cs` | break 条件化简后等于「有 KRC 就 break」；`lrc = wordLyric` 把逐字文本冒充 Lrc（正文混入 `(0,200)`） | 两者都有才 break；删掉冒充，Lrc 留空（前端优先 `yrc`） |
| 7 | `src/Zilux2/Local/AlacTranscoder.cs` `IsAlac` | 只读前 4 MB，`moov` 在末尾的 ALAC 被判非 ALAC → 原样 `audio/mp4` → 静音无提示 | 头 4 MB 无结论时再读尾 4 MB 判一次 |

回归：`dotnet build` 0 警告 0 错误；`tsc` 干净；477/477；`bug-scan` 0；`mix-audit` ✔；publish `exe 52,491,069 / web payload 10,773,957`；部署 PID 82608；启动 `host ready port=51244`，无 `[WARN]/[ERROR]`。

## 第四十七轮（round 38：歌词代际/缓存/时间轴 + 宿主三处）

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `web/src/ui/lyrics.ts` `startLyricMatch` / `applyManualLyric` / `clearManualLyric` | 回调只比 `trackKey`，匹配途中手动选源会被后台结果覆盖（界面回自动匹配，标签仍显示手动） | 模块级 `lyricGeneration`：匹配起手取 `gen`，手动/清空时 `+1`，所有回调比对 `gen` |
| 2 | `web/src/ui/lyricMatch.ts` `runMatch` | 缓存键不含阈值；`searchOnline` 抛异常被当「没找到」，`null` 固化整会话 | 键加 `@minScore`；新增 `searchFailed`，全失败且无结果时不写缓存 |
| 3 | `web/src/ui/lyrics.ts` `toDocLines` | 重复时间戳使前一行 `durationMs = 0`，`activeIndexOf` 只停在后一行 | 新增 `normalizeLineTimes`：时间戳单调 +1 ms、时长按下一行重算（下限 200 ms） |
| 4 | `web/src/ui/backgroundLyrics.ts` | 空歌词补发 `setTimeout` 句柄未存，切歌后旧定时器再打一次 `/api/lyric` | `emptyRetryTimer`：切歌/关开关/重排时 clear，回调里归零 |
| 5 | `web/src/online/lyricRange.ts` `rangeFromLrc` | `timeMs > 0` 把 `[00:00.00]` 首句删掉，人声区间从第二句起 | 改 `timeMs >= 0`，并新增 `web/tests/lyricRange.test.cjs` |
| 6 | `src/Zilux2/Local/TranscodeCache.cs` `Prune` | 只统计 `*.wav`，崩溃留下的 `*.tmp` 永不删也不计预算 | Prune 起手清 1 天以上的 `*.tmp` |
| 7 | `src/Zilux2/Audio/AudioFeatureService.cs` `Dispose` | `Join(2000)` 超时后仍 `StopCapture` + `_sink = null` → 采集线程 `ObjectDisposedException` 刷日志 | 仅 Join 成功才收尾；否则留给线程按 `_stopRequested` 退出并记 WARN |
| 8 | `src/Zilux2/Online/KugouProvider.cs` `ConvertKrcToCharLyric` | `words.Length == 0` 整行丢弃，间奏/空行的行时长消失，滚动与逐字区间错位 | 保留行头（正文为空），时间轴完整 |

回归：`dotnet build` 0 警告 0 错误；`tsc` 干净；478/478；`bug-scan` 0；`mix-audit` ✔；`main-BtjiAN71.js` 1,773.55 kB；publish `exe 52,491,069 / web payload 10,774,524`；部署 PID 78444；`host ready port=62478`，此后无 `[WARN]/[ERROR]`。

## 第四十八轮（round 39：观察器范围 / 快照签名 / 本地路径解析）

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `web/src/ui/lyricsVisualizer.ts` | `MutationObserver` 观察 `document.body` 的 `subtree + class`，全应用任何 class 变化都触发 `syncRunning()` | 先短观察 body 等 `.app` 挂载，找到后改观察 `.app` 自己的 class |
| 2 | `web/src/ui/backgroundLyrics.ts` `docSignature` | 只把 `words.length` 拼进签名，词数不变而切点变化时背景窗口不更新 | 拼 `word.startMs:word.text`（字段是 `startMs`，写成 `timeMs` 会 `TS2339`） |
| 3 | `web/src/ui/local.ts` `stripExt` | `lastIndexOf('.')` 会命中目录名，`/music/Vol.2/song.flac` → `/music/Vol`，`.lrc` 配对与同名判定全错 | 只在最后一段内找点（`dot > slash + 1`），并加 `web/tests/localPath.test.cjs` |

回归：`tsc` 干净；481/481；`bug-scan` 0；`mix-audit` ✔；`main-CA2eea_G.js` 1,773.97 kB；publish `exe 52,491,069 / web payload 10,774,947`；部署 PID 92284；`host ready port=63044`，此后无 `[WARN]/[ERROR]`。

## 第四十九轮（round 40：歌词缓存锁范围 + 逐字指纹开销）

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `src/Zilux2/Online/LyricCache.cs` `GetOrAdd` | factory（平台判定、AMLL 地址拼装、读凭据）在静态锁内执行，任意一首的准备阶段阻塞全部取缓存 | 锁内建 `TaskCompletionSource` 占位、锁外跑 factory 并回填，单飞语义不变；异常经 `ContinueWith` 转到 TCS |
| 2 | `web/src/ui/app.ts` `pushDesktopLyrics` | 每 250 ms `JSON.stringify(words.map(...))`，临时数组+字符串造成 GC 抖动 | 改单次遍历拼串（含 `startMs/endMs/spaceBefore/text`），比较语义不变 |

验证：`.scratch/lyriccache-test/` 的 `dotnet run` 输出 `calls=1 hit1=False hit2=True hit3=True` + `faultPropagated=True` → PASS；`dotnet build` 0/0；`tsc` 干净；481/481；`bug-scan` 0；`mix-audit` ✔；`main-BHumGLtb.js` 1,774.00 kB；部署 PID 92712。

## 第五十轮（round 41：DSF 位序核对 + 末块补齐）

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `src/Zilux2/Local/DsfTranscoder.cs` `ConvertToWav` 读块循环 | `while (remaining >= block.Length)`：`data` 长度不是 `blockSize × channels` 整数倍（截断文件、异常封装）时末块被整块丢弃，时长短几十毫秒、结尾断在音频中间 | 改 `while (remaining > 0)` 按剩余字节读；不足一块时用 DSD 静音位型 `0x69`（均值 0，不会留直流台阶）补齐并记一条 WARN |

**位序核对结论（不改代码）**：1-bit 低位在前（`>> (bitIndex & 7)`）、8-bit 高位在前（`>> (7 - (bitIndex & 7))`）与 DSF 规范一致；`factor = round(sourceRate / 88200)` 对 DSD64/128/256 都能整除。库里无 `.dsf` 样本（`~/Music` 扫描 0 个），实听验证留待有 DSD 文件的场景。

回归：`dotnet build` 0/0；481/481；`bug-scan` 0；`mix-audit` ✔；publish exe 52,491,069 / web payload 10,775,061；部署 PID 88576；`host ready port=54160`，此后无 `[WARN]/[ERROR]`。

## 第五十一轮（过渡瞬间断点 + 尾段渐隐剔除）

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `web/src/ui/crossfadeDeck.ts` `setDeckPlaybackRate` | 每次过渡起点都重写 `preservesPitch` + 赋 `playbackRate`，Chromium 重建 WSOLA → 几十毫秒断点 | 值未变（<5e-4）直接 return；`preservesPitch` 用 WeakSet 每元素只设一次 |
| 2 | 同文件 `startFade` / `startSplitMix` | v2 链（LR4 + Convolver IR + Delay）在可听瞬间才创建 | 新增 `ensureAutomixV2Deck` 复用；`startFade` 里对 B 侧预建并置 0 增益；日志 `automix-v2-prewarm` |
| 3 | 同文件 `:3116` 尾段剔除 | 前置 `!handoff` 被 round 15 的 `DUCK_TRIGGER_SOFT` 改宽后大量为 false → 剔除整段失效 | 换成 `cutMs >= max(earliestCut, 末句+300)`；器乐 A 退回 `earliestCut`；记 `automix-v2-tailcut` / `-skip` |

回归：tsc 干净、481/481、bug-scan 0、`mix-audit` ✔（QUALITY_FAIL 8.1%、LAST_BAR 0.8%、TOO_SHORT 0.0%）、`main-DEyF38Ya.js` 1,774.64 kB、已部署。

## 第五十二轮（尾段渐隐起点认错）

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `web/src/core/automix/tailFade.ts` `detectTailFade` | 按「非递增后缀」定位渐隐起点：Skydive 第 164 s 的音乐性缓降被判成淡出起点（实际淡出在 184.7 s），剔除点因此早于末句、被末句守卫挡住 → 渐隐段仍进过渡 | 改「500 ms 前瞻局部斜率」：阈值 `max(0.2, peakDrop×0.25)` dB/500 ms，从最后一个可算斜率的格往回走，停在斜率不够陡处 |
| 2 | 同文件 | `MIN_FADE_MS = 4000` 把 3.7 s 的真淡出漏掉 | 降到 2500 |
| 3 | `web/src/ui/crossfadeDeck.ts:3116` | 探测点只看 `schedAudibleEndMs`，Skydive 之后还垫 1.9 s 尾巴 | 改 `max(schedAudibleEndMs, durationMs)`；剔除门槛「渐隐 ≥ 6 s」→「≥ 2.5 s」 |

实测：Skydive 识别为 `184200..188400 / drop 21.3 dB`（老实现 `164000..188400 / 22.0`）；窗口终点落到 184.2 s。`A_OUTRO 5.8% → 4.5%`、`LAST_BAR 0.5% → 0.1%`、`tailFade.test.cjs` 14/14、全量 481/481。

## 第五十三轮（乐句路径绕过渐隐剔除）

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `web/src/ui/crossfadeDeck.ts` 乐句路径（`let end = …` 之后） | `cueMode=phrase-match` 的过渡在更早处 return，`:3116` 的渐隐剔除一次都不执行；`skipDecay` 又要求 `!sustained`，而 Skydive「边淡出边打鼓」让 `outgoing≥0.35` 成立 → 窗口盖到 188.4 s | 在乐句路径内补同口径剔除：`tailFade.dropDb≥8` 且淡出起点晚于末句 → `end = fadeStart+300` |
| 2 | 同文件 `aTailBleedMs` | 窗口压到淡出起点后，`restMs−holdMs` 仍会铺 4.5 s 尾巴 —— 正是被剔掉的淡出 | 新增 `tailCutApplied`；剔除成功时 `aTailBleedMs`/`aTailHold` 返回 0 |

实测：Skydive→春めく 窗口终点 188433 → **184203.9**；`A_OUTRO 5.8%→4.6%`、`LAST_BAR 0.5%→0.1%`、`TOO_SHORT 0.5%→0.0%`；`main-D17aJyro.js` 1,774.94 kB 已部署。

## 第五十四轮（队列 BPM/调性 + AutoMix 真实数据）

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `web/src/ui/app.ts` `fillTempoLabel` | 加占位后 `if (el.textContent) return;` 让补标签永不执行 | 重写为「查缓存 → 占位 → 后台队列」三段式 |
| 2 | 同文件 `runAutoMix` | AutoMix 只用已分析的数据贪心排序，未分析的歌按原顺序沉底 = 假排序 | 点击后先串行补分析（按钮显示 `分析 k/n`），补完再排序；失败数写进 toast |
| 3 | `src/Zilux2/Online/LocalMusicServer.cs:2317` | 分析器取够样本就断开流，`stream aborted` 每次都记 WARN，批量分析时刷屏 | `bytesCopied > 0` 降 `Info`，只有 0 字节才 `Warn`（那才可能是上游故障） |

## 第五十五轮（分析期间切歌/改队列导致卡住）

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `web/src/ui/app.ts` `runAutoMix` | 40 首串行分析期间换歌/拖动队列，分析继续跑完并覆盖用户的新顺序；按钮 disabled 期间像卡死 | 队列签名比对，变了立刻取消并提示；按钮恢复放进 `finally` |
| 2 | 同文件 `fillTempoLabel`/`pumpTempoQueue` | `analyzeTrack` 无超时，一次卡住就让占位永久停在「分析中…」 | `withTimeout(analyzeTrack, 25s)`，超时按失败计 |
| 3 | 同文件 | 过渡进行中开分析：宿主解码/取流与两路播放抢资源，听感「卡一下」 | `waitCrossfadeIdle()`，`phase='fading'` 时最多等 10 s 再开工 |

## 第五十六轮（手法有效性）

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `web/src/core/automix/v2Plan.ts` `V2PlanInput` | `sweepShare` 数值从未进音频，三种扫频手法听感相同 | 新增字段 + `aSweepFrom = 1 - 0.55*sweepShare`，实测 1.0/0.4/0 三档扫频起点 0.80/0.93/不扫 |
| 2 | `web/tools/mix-audit.cjs` `flagsFor` | `halfTime/backspin/cut/slam` 被误判 `NO_HANDOFF`(4) 与 `B_SEEK`(2) | 合并 `gestureStyle` 判定，改记 `GESTURE_STYLE` |
| 3 | `.scratch/mix-audit-baseline.json` | 基线仍是 571 对的旧库，当前 4608 对，2pp 闸门失去意义 | 旧基线存 `-pre-layering.json`，按当前全库重建 |
