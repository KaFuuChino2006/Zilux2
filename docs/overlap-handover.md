# 「重合」歌词模式交接说明

最后更新：2026-11-26 19:20（1.2.12 已发布；装机版运行中，PID 34636）

> 项目级状态（版本、发布产物、仓库清理、测试与工具）见 [`handover.md`](handover.md)；本文只讲重合模式本身。

## 0. 一句话现状

「重合」是歌词页的独立 Lumiere 模式（`LumiereMode = 'overlap'`）：整行歌词逐字出现，唱完的旧句留在画面里，镜头按播放头逐字跟随并把当前句拉到画面中心，旧句在两句后才散开。全部画面参数走「重合设置」面板，默认值就是维护者当前调好的那套；落位可在「随机散点 / 阶梯格」之间切，背景可在「跟随主题 / 纯黑 / 纯白」之间切。

## 1. 构建 / 部署 / 重启（唯一标准动作）

```powershell
cd E:\Zilux2开发\web
npx tsc --noEmit            # 必须 0 错误
cd E:\Zilux2开发
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\publish.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\deploy-installed.ps1"
Stop-Process -Name Zilux2 -Force
Start-Process "$env:LOCALAPPDATA\Programs\Zilux2\Zilux2.exe"
```

- 装机目录：`C:\Users\13329\AppData\Local\Programs\Zilux2`；部署脚本自动备份 `web.bak-<时间戳>` / `Zilux2.exe.bak-<时间戳>`。
- 当前构建（1.2.12）：web payload 11,118,302 bytes，exe 52,753,211 bytes；部署备份 `web.bak-20261126-185831`。
- bash 调 publish 时路径要加引号（反斜杠会被吞）。

## 2. 调用链（从入口到像素）

```
web/src/ui/lyrics.ts  applyLumiereMode()
  └─ flowOn = mode==='flow' || mode==='overlap'
     flow.setMode(mode) → flow.activate()
        └─ web/src/ui/flow.ts  createFlowStage()   // overlap 布尔决定建哪种场景
           └─ web/src/ui/overlapScene.ts            // 固定皮肤 + 透明底
              └─ web/src/ui/flowScene.ts            // fixedStyle 分支：无倒计时/无监听/lyricsOnly
                 └─ tempera/createTemperaPixiRuntime.ts
                    ├─ buildScene() → buildTemperaScene()  // 每段一次性同步构建
                    ├─ printLayer      // 拼合印刷链（畸变/色版/颗粒/对比/暗角），filterArea 钉视口
                    ├─ sceneContainer  // 相机：pan(zoom, roll) + 撞击 + 跟随缩放
                    │   ├─ scene.container / shot / glyph
                    │   ├─ decor   (轨迹线、书写弧、括号、横线)
                    │   ├─ debris  (墨尘/墨溅/字屑)
                    │   └─ ambient (电路/星座/刻度盘/11 种图形)
                    ├─ hud     (四边刻度尺 + 四向游标)
                    ├─ sheet   (远景剪影 + 折痕)
                    ├─ wave    (底部声纹)
                    └─ grid    (纸面网格 + 视差 + 底部突起)
```

关键文件（均在 `web/src/ui/lumiere-folia/components/visualizer/tempera/`）：

| 文件 | 职责 |
| --- | --- |
| `createTemperaPixiRuntime.ts` | 段落缓存、相机、跟随、撞击数组、图层装配与销毁 |
| `temperaSceneBuilder.ts` | 段落/镜头构建、随机落点、旋转、括号、横线、遮罩、字模、印章、墨点 |
| `temperaShotFrame.ts` | 每帧：逐字运动、退场六式、唱后模糊、重点词辉光、风线、横线、括号、遮罩 |
| `temperaCamera.ts` | 播放头锚点、跟随缩放、smoothDamp 输入 |
| `temperaProgram.ts` | 分行/分段/分镜与 `holdUntil` 时间 |
| `temperaTextView.ts` | 字形 Text、阴影、残影、惰性 BlurFilter、关键词色 |
| `temperaOverlapDecor.ts` | 引导线（正交折线/刻度/端点/支线/两端取色/扫光）+ 书写弧（流星头/熄光） |
| `temperaOverlapHud.ts` | 刻度尺与游标 |
| `temperaOverlapDebris.ts` | 墨尘/墨溅/字屑三种粒子 |
| `temperaOverlapAmbient.ts` | 自由线稿（电路/星座/刻度盘/11 种几何图形），挂在 sceneContainer 内 |
| `temperaOverlapSheet.ts` | 远景剪影与折痕 |
| `temperaOverlapWave.ts` | 声纹波带 |
| `temperaOverlapGrid.ts` | 纸面网格（视差 + 透镜鼓包） |
| `temperaOverlapPrint.ts` | 印刷链工厂（复用 sonnet 后处理） |

设置与面板：

- `web/src/ui/overlapSettings.ts`：全部字段、`OVERLAP_DEFAULTS`（= 维护者当前调好的值）、`OVERLAP_RANGES`（分类：文字 / 运镜 / 镜头 / 旋转 / 落点 / 旧句 / 装饰 / 印刷与画质 / 高级）、`OVERLAP_SWITCHES`、`overlapFx()/setOverlapFx()/saveOverlapSettings()`、`overlapStyleOf()`。
- `web/src/ui/overlapSettingsPanel.ts`：面板（独立预览 + 撞击曲线 + 分组）。
- `web/src/ui/app.ts`：`EFFECT_SETTINGS_META.overlap` 与 `openOverlapSettingsSheet` 分派。

## 3. 关键机制与不变量（改代码前必读）

1. **holdUntil**：`flowScene.ts` 里 `shot.holdUntil = lines[lineIndex + 2]?.startTime ?? Infinity`（拆句时按镜头序列数「后两句」）。旧句可见性、退场时间、保留段落窗口都以它为准。
2. **相机变换顺序**：`position = C + R(roll)·(pan·zoom)`、`scale = zoom`、`pivot = C`。新增任何跟着镜头的层，必须挂进 `sceneContainer`（或复刻同一变换），否则会与文字错位/反向。
3. **平移量纲**：`follow.x/y` 是「把当前句中心送到画面中心」的位移（未缩放、未旋转），应用时才乘 zoom、绕 roll 旋转。撞击是叠加在最终变换上的加法/乘法，不回写 follow。
4. **段落纸底**：每个段落场景自带一张不透明纸底；任何 `zIndex < 段落场景` 的层都会被整张盖住。所有全屏装饰必须挂在 `app.stage` 且索引高于 `printLayer`（debris/ambient 用 index 2，overlay 之上另算），或挂进 `sceneContainer`。
5. **`flowScene.resize()` 是空操作**（`start()` 被 memoized），不要指望它改画布尺寸；面板预览用 letterbox 手动装框。
6. **滤镜惰性**：字形的 `sungBlur`/`glow` 首次需要才 `create()`；销毁时用 `filter?.destroy()`。
7. **性能**：段落建场已改分帧（`temperaSceneSteps()` 逐镜头 `yield`，运行时每帧 4ms 预算），预建邻段不再单帧尖峰；「切歌当下必须立刻出画」那一次仍是同步首段（100~280ms，维护者已接受）。另有惰性滤镜、整行每段最多 6 行 / 拆句 3 行、每行分块 `ceil(words/6)`。埋点：`localStorage.zilux2.perf='1'` → `window.__zilux2Perf` 与 `window.__temperaSceneMs`（§8.1）。

## 4. 当前默认值（维护者调好的）

`placement 'grid'`（落位方式，另一档 `scatter`）、`backdrop 'theme'`（背景，另两档 `black`/`white`）；`paper #05080f`、`ink #e8f1f6`、`accent #5fd6c9`、跟随封面 true；`sizeScale 1.12`、`fontWeight 700`、`glyphMotion .82`、`glyphSettleStretch 1.32`、`lyricTint .3`、`keywordGlow .7`；`intensity 1.82`、`followGain 1.6`、`zoomRest 1.35`、`zoomSwell .095`、`zoomRelax .15`、`panSoft .6`、`zoomSoft .56`、`rollSoft 1`；`turnChance .13`、角度 30–360°、`scatter .165`；`ghostDrift .18`、`holdFade .45`、`ghostBlur .38`、`exitSeconds 2.6`；撞击 `chance .35 / px 47 / X .65 / Y .95 / Z 70 / depth 0 / damping 1.75 / roll 7.6° / elastic 5 / attack .34 / swing .4`；装饰各概率见文件；`stagger .55`；镜头 `rackFocus 1.15 / dollySplit .5 / handheld .5 / panStreak .75 / settle 1.15`；印刷 `lensDistortion .15`，其余 0。

## 5. 最近做过什么（时间倒序）

- 1.2.12 发布（2026-11-26 19:00）：重合子系统、切歌性能、混音默认「自动」、粉色主题等一起进版本；仓库清理后提交 `b57bfac`、tag `v1.2.12`、CI 产 Setup/Portable。见 `handover.md`。
- 落位方式做成一档设置（随机散点 / 阶梯格），第三档「单一方向」试了两版不达标后按维护者要求删除（§9.1）。
- 背景三档、书写弧随机补笔 + 换句补 1~2 根、四边箭头放大、闪烁固定 50ms、高级设置独立还原按钮（§9.2~§9.5）。
- 切歌卡顿专项（2026-11-26）：主题去重、rAF 合并失效、预建主题、运行时池化、段落分帧构建、歌词预匹配写回缓存、DOM 重绘去抖。详见 §8。
- 文字「爆炸散架」做过又按维护者要求**整段撤回**（设置、图层、绘制均删除）。
- 分档镜头撞击（纯字/房间/拼合各自参数）做过，维护者要求**全部删除并还原**；`cameraShake.ts`、`shakeSettings.ts` 已不存在。
- 切歌卡顿：惰性滤镜 + 段落行数上限 + 每行分块上限（`buildShotChunks` 不再随机 2–4 词）。
- 修复有前奏的歌（首句不在 0s）导致整页退回播放器：`paragraphIndex < 0` 时隐藏舞台并 return。
- 引导线六项（正交折线/端点/刻度/重点词支线/两端取色/扫光）、书写弧流星头与熄光、括号十字框两拍、横线、遮罩五种形状与文字层反色、字模、印章、断句竖线、风线、自由线稿、剪影/折痕/声纹、纸面网格。
- 重合设置全量进面板，独立预览 + 实时撞击曲线；`OVERLAP_DEFAULTS` 已写成维护者的实调值（`zoomRest 1.35`）。

## 6. 已知问题 / 下一步候选

1. **切歌瞬间的长段落构建**：已改为分帧（§8）；仍存在「未预建 + 立即切」路径上的一次同步首段构建（实测 100~280ms，维护者已确认「立刻切但偶尔顿一下可以」）。若要再降，只能延迟首帧出画（会看到空场），暂不做。
2. **拆句 + 退场**：拆句后每个 chunk 各自数「后两句」；若维护者希望整句一起退，需要在 `flowScene.ts` 重新聚合 `lineEnds`。
3. **ambient 与遮挡**：自由线稿挂在 `sceneContainer` 内、与文字同变换；后层靠「跳过落在文字包围盒内的 item」让位，没有真正的「纸下」层。
4. **文档**：本文是重合模式的主文档；项目级交接看 `handover.md`。新增设置项时记得同步 §4 的默认值清单。

## 7. 自测方法（CDP）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "web\.scratch\launch-cdp.ps1"   # 9333 端口
```

```python
from playwright.sync_api import sync_playwright
b = p.chromium.connect_over_cdp('http://127.0.0.1:9333')
pg = [x for x in b.contexts[0].pages if 'zilux2.local' in x.url][0]
pg.evaluate("localStorage.setItem('zilux2.lumiere','overlap')")
pg.reload(); pg.wait_for_timeout(4000)
pg.click('.pb-btn-lyrics', force=True)   # backgroundLyrics 开启时可能需点两次
```

- 播放器页的歌词按钮监听 `pointerdown`，`el.click()` 无效。
- 性能探针：`localStorage.zilux2.perf='1'`，清空 `window.__zilux2Perf.marks` / `window.__temperaSceneMs` 后切歌，读回聚合。
- 1.2.12 清理时删掉了大部分 `.mjs` 探针（`perf-cut` / `ov-burst` / `spots*` / `nextn` / `click-seg`），只剩 `web/.scratch/launch-cdp.ps1` 与 `web/.scratch/eval.mjs`（`node eval.mjs "<表达式>" [端口]`）；要复现测量需按 §8.1 的描述重写。

## 8. 切歌性能调度（2026-11-26 落地）

### 8.1 探针

- `web/src/ui/perfProbe.ts`：模块加载时读一次 `localStorage.zilux2.perf === '1'`；开启后写 `window.__zilux2Perf = { marks, longtasks, gaps }`，mark 形状 `{n, ms, t, d?}`（注意明细字段叫 `d`），另有 `PerformanceObserver('longtask')` 与自建 rAF 间隔（>32ms）记录。`perfMark(name, startedAt, detail?)`、`perfEvent`、`perfMarkSlow`。
- 现有埋点名：`flow.compile / flow.swapSong / flow.renderOnce / flow.update.render / flow.createSlot / flow.reuseSlot / flow.retire / flow.release / flow.promote / flow.accept / flow.handoff.done / flow.setTheme / flow.song.upgrade`、`rt.commitSong / rt.clearScenes / rt.destroy / rt.install.firstFrame / rt.install.linkPrograms / rt.frame.scenes / rt.frame.shots / rt.frame.total / rt.drawOverlay / rt.drawCredits`、`scene.build / scene.build.chunked`、`lyrics.render / lyrics.onPlayer / lyrics.theme.flow / lyrics.song.flow / lyrics.palette.flow`。
- 测量脚本：`.scratch/perf-cut.mjs`（真点 `.pb-next` 并在切歌后采样）、`.scratch/leak-check.mjs`（连点 N 首看是否新建/泄漏运行时）、`.scratch/dump-upgrade.mjs`、`.scratch/cdp-shot-now.mjs`（截图）。

### 8.2 结构性改动

1. **主题去重**：`flowScene.ts` 用 `themeSignature()`（背景/三色/字体/字重/强度/wordColors）比较，相同直接 return，不再 `compile + swapSong + clearScenes`。切歌时歌词页会连续推 8 次主题，这是原先 265ms 卡顿的主因。
2. **失效合并到 rAF**：`flowScene.ts` 的 `setStyle/setPalette/setTheme/setSong` 只置 `dirty` 并 `requestAnimationFrame(flush)`，同一帧多次改动合成一次 `compile + applySong`；`tuning()` 带缓存（原先每次 `flowTuning(style)` 都返回新对象，`setTuning` 的相等短路永不命中）。
3. **运行时池化**：`flow.ts` 新增 `spare` 槽位。`mix.done` / `accept` / `prepareUpcoming` 的释放改成 `retire()`（隐藏 + `setUsageRecording(false)`，不销毁）；`createSlot` 优先复用 spare，复用后一帧内标 `ready` 并 promote。实测新建一只 Pixi 运行时 ≈430ms，同一只运行时内换歌重建 ≈17ms。`deactivate()/dispose()` 仍真销毁。
4. **段落分帧构建**：`temperaSceneBuilder.ts` 的 `buildTemperaScene` 变成生成器 `temperaSceneSteps()`（按镜头 `yield`），同步包装保留给 `buildScene`；运行时新增 `pendingScene/startPendingScene/advancePendingScene(4ms)/cancelPendingScene()`，`clearScenes/retireScenes/destroy` 都会先取消在建段落并释放半成品容器。预建邻段从单帧 200ms+ 变成每帧 ≤4ms。
5. **歌词文本预热**：`lyrics.ts` 的 `prefetchUpcomingLyric()` 把 `matchWordLyrics` 的结果写回 `upcomingLyrics` 缓存，切歌时不再出现「同曲精匹配换文本 → 整场重建」。另加 `contentKey` 内容比较，文本没变就不重绘 DOM，`render()` 用 90ms 去抖 / 200ms 上限合并多份 doc。

### 8.3 实测对照（切歌窗口长任务）

| 阶段 | 切歌瞬间长任务 |
| --- | --- |
| 改造前 | 265ms（单帧 173ms） |
| 主题去重后 | 249ms |
| 加合并/预建主题后 | 96ms / 75ms |
| 池化 + 分帧后（预建路径） | 0~55ms |
| 未预建路径（立即切） | 100~280ms（渲染新歌首段，维护者接受） |

连点 6 首的回归（`leak-check.mjs`）：`flow.createSlot` / `rt.install.firstFrame` / `rt.destroy` 均为 0，`flowScenes` 恒 2、canvas 恒 2，`flow.reuseSlot 3 / flow.retire 3 / scene.build.chunked 4`，最长长任务 121ms。

### 8.4 注意

- `backgroundLyrics` 被重置回 true 后，第一次点 `.pb-btn.lyrics` 只弹 toast，2.5 秒内再点才真正打开；用脚本验证时只看 `.lyrics-view` 数量判断开关，不要连点。
- `flowScene.resize()` 仍是空操作；模式切换（flow ↔ overlap）走 `deactivate()`，会顺带清空 spare，避免场景类型混用。

## 9. 重合落位：阶梯格（2026-11-26 落地）

维护者要求：「歌词随机出现的时候不要叠在上一句前面」，补一句「就算是同一句开了拆分的也不能」。

落位改在 `temperaSceneBuilder.ts resolveOverlapPlacement()` 里，规则是**帧上的 2×3 格**，块自己的包围盒被搬到格心：

- 行：`row = (|index| + rowPhase) % 2`，行心 `±(height/4 - margin/2)`，两行相距半个画面 —— 只有两行，因为一行歌词块可能占掉近半屏，两行是「无论块多大都不会压住上一句」的上限。
- 列：`column = (⌊|index|/2⌋ + colPhase) % 3`，每两个 shot 换一列，于是「隔一句又回到同一行」的那句必定换列。
- `rowPhase` / `colPhase` 由 `hashTemperaSeed(programSeed)` 取，避免永远从左上角开始。
- 之前试过并被否掉的：给锚点加环状候选（宽块被边距夹到同一侧墙）、镜像到上一句另一侧（每块可用矩形不同，格点不重合）、以「上一句落点」为基准链式避让（参考点与实际落点不一致）。离线模拟脚本 `.scratch/anchors*.mjs` 与在跑的探针 `.scratch/spots*.mjs`（读 `window.__overlapSpots`，`perfOn()` 时才写）保留了这些结论。

关键前提：**落位键是 `placementIndex = paragraphIndex * 32 + shotIndex`**，不是 `lineIndex`。拆句（`wholeLineLyrics=false`）会把一行切成 2~4 个 chunk，同一行所有 chunk 共用同一个 `lineIndex`；此前正是拿 `lineIndex` 做键，同句各块拿到同一个锚点，于是完全叠死。旋转仍按 `lineIndex` 取值（`resolveOverlapOrientation`），保证同一句的各块倾角一致。

`clampShift()` 已删除；`resolveOverlapAnchor()` 还留着，只给 `showLyricMarks` 的 here/there 用。

### 9.1 落位方式可切换（2026-11-26 追加，同日收口为两种）

维护者要「改成切换」：原随机要能切回去，现在的阶梯格留着。第三档「单一方向」实测下来不达标，已按维护者要求删掉，只留两种。

- 设置项：`overlapSettings.ts` 的 `placement: 'scatter' | 'grid'`（默认 `grid`），在 `normalizeOverlapSettings` 里白名单兜底；老存档里如果是已删掉的 `stack`，会自动落回 `grid`，不用手动迁移。
- 面板：「重合设置 → 落点 → 落位方式」两个按钮（随机散点 / 阶梯格），下面一行说明当前选项的规则。
- `resolveOverlapPlacement()` 两条分支：`scatter` 走 `resolveOverlapAnchor()` 的老锚点并按块外框夹进画面；`grid` 走 §9 的 2×3 阶梯格。
- 这两个键不在 `FlowSettings` 里，改完样式键不变，所以 `overlapScene` 保存时会额外调 `type.refresh()`（`flowScene` 的公开方法，等价于 `invalidate()`），面板里切换落位方式也直接 `scene?.refresh()`，保证当场重排。

被删掉的第三档留档说明（避免以后重走）：`stack` 试过「游标贴边累加」和「一屏五行等距槽」两版。前者因为拆句关掉时一段只有一句、游标每次建场重置而失效；后者虽然稳定，但重合模式的相机每帧都把正在唱的字拉回画面中心（`temperaCamera.ts resolveLyricAnchor` 的 `followGain`），绝对槽位在屏幕上根本显示不出来——关掉跟随又会破坏原有的镜头语言，所以整档删除。

### 9.2 高级设置有独立的还原按钮

`overlapSettingsPanel.ts` 的「高级设置」折叠组末尾多了一行「还原高级默认」（`.ts-advanced-reset`）：只把 `OVERLAP_RANGES` 里归到「高级」分类（镜头撞击那一组 `shake*`）还原成 `OVERLAP_DEFAULTS`，其它分类的草稿值原样保留；点完会重画面板，并把折叠组重新展开。面板底部原来的「恢复默认」仍是整体还原。

### 9.3 闪烁退场：0.3 秒内四次

`temperaShotFrame.ts` 里旧句退场有六种手势，其中 `style === 4` 是「闪烁」。四次闪烁固定压在 **0.3 秒**里（绝对时间，不随「退场时长」拉伸），闪完立即变黑，剩下的退场时间保持不可见：

```ts
const window = 0.3;
const elapsed = clamp01(exit) * exitDuration;
if (elapsed >= window) return 0;
const phase = (elapsed / window) * 4;
return phase % 1 < 0.55 ? 1 : 0.05;   // 亮 55% / 暗 45%
```

每次约 75ms（亮 41ms / 暗 34ms）。相位取整句退场进度，整行一起闪；不要再做每字随机相位或 25ms 细步，那样会读成信号噪声。`exitDuration` 小于 0.3s 时四次会等比压缩。

### 9.4 重合背景：跟随主题 / 纯黑 / 纯白

「重合设置 → 配色 → 背景」三选一，存在 `OverlapSettings.backdrop`（`theme | black | white`，默认 `theme`）。`theme` 时舞台根节点透明，露出歌词页自己的封面底；`black` / `white` 直接把根节点刷成 `#000000` / `#ffffff`，纸面与字浮在上面。实现在 `ui/overlapScene.ts` 的 `paintBackdrop()`：`setTheme` 之后要再刷一次，否则会被 `flowScene.setTheme` 写回主题底色。面板里的预览窗把 `theme` 也画成黑色（面板底不适合当舞台）。纯白配浅色纸/字会偏糊，这是配色本身的取舍，hint 里已写。

### 9.5 弧线：引导弧 + 随机补笔

`temperaOverlapDecor.ts` 里除了「上一句末尾 → 这一句开头」的引导弧（`arcChance` 控制），还会按 `AMBIENT_ARC_GAP = [0.9, 2.4]` 秒的随机间隔自己补一笔：锚点取当前句中心，方向/长度/弯度由 `ambient-N` 哈希决定（同一首歌重播走势一致），长度压在 140–380，不会变成贯穿画面的划痕。换句那一笔也不止一根：掷中之后还会按哈希再补 1–2 根并排的同向弧（`extra`，0.62 概率补一根、其中 0.35 补两根），后一笔晚 0.12–0.35s 落笔、横向挪 5–6px、bow 缩到 0.62 并反向偏 9px，读起来像手写描了第二遍而不是画了两根平行线。同屏上限 `ARC_MAX = 9`，超了先让最老的一笔收干。补笔的 `key` 不是句 key，所以「引导弧跟随首字」那段要从后往前找本句自己的那根。

### 9.6 旧句退场：两段式（散开 → 消散）

退场分两段，两个时间点都写在镜头数据里：`TemperaShot.scatterAt`（下一句起点，编译期由 `flowScene.ts` 的 `lyrics[index + 1]?.startTime` 写入）与 `TemperaShot.holdUntil`（下下句起点，原来就有）。

- **第一段散开**：`scatterAt` 到 `holdUntil` 之间，位移按 `scatterSpan = max(0.5, (holdUntil - scatterAt) * 1.25)` 走完八成左右；每字先按唱序错开 32% 行程出发，再套 `easeTemperaInOut`（两端速度为 0）。这段时间 alpha 保持 1，所以旧句是「散开并停在那儿」。
- **第二段消散**：`holdUntil` 之后由 `blow`（`easeTemperaInOut(clamp01((exit - order * 0.45) / 0.55))`）把 alpha 带到 0，位移仍由 `drive = max(blow, scatter)` 继续缓慢增长，所以不会出现「先弹一下 → 冻住 → 过会儿才淡掉」。
- **幅度**：`distance = height * (drift * 1.05 + rand(53) * drift * 0.75) * drive`，`drift = overlapFx().ghostDrift`（默认 0.18）；每个字的距离差压在 1.05–1.8 倍，整行一起散，不会几个字各飞各的。
- **诊断**：`zilux2.perf=1` 时 `createTemperaPixiRuntime` 每帧把每个场景的 `{vis, alpha, z, shots, hold, exit, shotVis, disp, g}` 写进 `window.__overlapScenes`，`web/.scratch/` 下的 `sample.mjs`（200ms 采样）、`watch.mjs`（定时截帧 + 状态）、`track.mjs`（60ms 采样首字落点，用来判断速度曲线有没有跳变）都读它。**采样前先确认 `#overlap-settings` 没开着**，面板打开时舞台不 `update()`，会读到冻结的预览运行时。
