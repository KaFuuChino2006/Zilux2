# Folia 可视化器与性能护栏深度拆解

> 调研对象：`E:\Zilux2开发\research\repos\folia`（chthollyphile/folia-major，`package.json` 版本 v0.7.21）
> 许可证：AGPL-3.0（**本文只记录思路与结构，不复制代码**；任何借鉴必须重写实现）
> 调研日期：2026-10-18
> 负责范围：可视化器体系、性能护栏、GPU/Electron 渲染层（歌词解析由另一位 teammate 负责，本文只在必要处引用其产物）
> 行号约定：`path:line` 均以工作树中的真实行号为准；文件明写“文档声称”与“代码实际”之别，无法从代码确认的标 **待确认**。

---

## 0. 结论速览（TL;DR）

### 0.1 可视化器：14 个内置模式，代码实测与文档一致

- 权威清单在 `src/types/visualizerModes.ts` 的 `BUILTIN_VISUALIZER_MODES`；注册表 `src/components/visualizer/registry.tsx:15` 用 `import.meta.glob('./*/entry.tsx', { eager: true })` 从目录自动发现，启动时 `assertBuiltinModeList(...)`（`registry.tsx:48`）核对两边，不一致直接抛错。
- 实测 `src/components/visualizer/` 下恰好 **14** 个 `entry.tsx`，`order` 字段从 10 到 130 连续无空洞（逐个文件行号见 §2）。**注意**：仓库内文档并未写出数字（根 `README.md` 只有一张 `img/visualizer.png` 截图，`:52`；`src/components/visualizer/README.md` 267 行也只讲机制不列数量）——14 是**代码事实**，不是文档转述；若上游发行说明/官网另有“14 种”的说法，属仓库外信息（**待确认**）。
- 渲染技术分四档：Pixi.js 8（3 个：商籁 sonnet / 凝彩 tempera / 绘光 lumiere）、three.js + @react-three/fiber（1 个：镜台 diorama）、手写 WebGL2（1 个：时计 pendolo）、原生 Canvas2D（2 个：烟雾 fume、莫奈 monet 的局部与 worker 底图）、纯 DOM/CSS + framer-motion（6 个：classic / partita / tilt / claddagh / cadenza / cappella）、完全静态 DOM（1 个：still）。合计 3+1+1+2+6+1=14。

### 0.2 性能护栏：五层，各自独立，默认全部“温和”

| 层 | 机制 | 关键常量 / 默认值 | 位置 |
|---|---|---|---|
| 帧率 | 全局劫持 `window.requestAnimationFrame` | 档位 60/90/120/off，默认 **off**；间隔容差 1 ms；localStorage 键 `visualizer_frame_rate` | `src/utils/frameRateLimiter.ts:22-24` |
| 像素 | 渲染分辨率向上吸附到 2 的幂纹理桶（Pixi TexturePool） | 单轴最多降 0.25；781×850@1.5 从 2048² 降到 1024²（显存 ÷4） | `src/components/visualizer/pixi/pixiTextureBudget.ts:64,86-113` |
| DPR | 各模式各自 clamp | Pixi 场景 `snapResolutionToTexturePool`；绘光/镜台 dpr ≤ 2；lattice 歌词 `ceil(dpr)` 且 ≤ 2 | `lumiereRuntimeTuning.ts:39-44`、`VisualizerDiorama.tsx:458` |
| 动效 | reduced-motion 六分区 + 系统偏好 + 静态模式 | 6 个 surface：lattice / transitionOverlay / collectionMorph / monetBackground / uiMicroMotion / settingsScroll，默认全 false | `src/stores/useMotionSettingsStore.ts:28,37,109` |
| 生命周期 | mount-once 运行时 + 显式 destroy + 场景缓存逐帧释放 | 换歌不重建 WebGL；换下的场景“一帧销毁一个” | `pixi/pixiRuntimeHost.ts:106-151`、`pixiSceneCache.ts:19-38` |

**重要负面事实**：代码里**没有**按性能自动降档（auto-quality）的机制，也没有 FPS 自适应；隐藏窗口时 Chromium 的 rAF 因 `backgroundThrottling: false`（`electron/main.cjs:5085`、`:5262`）而**不会**降频，所以“最小化后不再烧 GPU”这一点**不成立**——这是壁纸模式能在桌面层持续出画的原因，也是隐藏时仍耗电的根因（`electron/main.cjs:5085`）。

### 0.3 六到十个高价值发现（详见正文）

1. **全局 rAF 限帧门**：`src/index.tsx:23` 在应用启动时调用 `installGlobalVisualizerFrameRateLimiter()`，把 `window.requestAnimationFrame/cancelAnimationFrame` 换成受 `visualizer_frame_rate` 控制的批处理门（`frameRateLimiter.ts:187-217`），并保留原生函数在 `window.__foliaNativeRequestAnimationFrame`（`:215-216`）供 `requestUncappedAnimationFrame`（`:161-170`）逃生。
2. **纹理桶吸附**：默认 `textureResolution=1.5` 时 781×850 视口需要 1172×1275，Pixi 的 TexturePool 每轴取 2 的幂 → 2048×2048（16 MiB）只装 5.7 MiB 画面（71% 浪费）；吸附到 1.2047 后 1024×1024、画面填充 92%（`pixiTextureBudget.ts:1-26` 注释 + `:86-113`）。Intel iGPU 实测：窗口 640→700（面积 +18%）使凝彩常驻显存 628→822 MiB（+31%），因为 1.5×700 跨过 1024 触发两轴同时翻倍（`:12-15` 注释）。
3. **像素预算用“显存桶”而不是“像素数”思考**：只放弃能换来更小 bucket 的分辨率（单轴最多 0.25，两轴都试，按 bucket 面积排序，`pixiTextureBudget.ts:86-113`）。
4. **换歌零重建**：`useVisualizerPixiHost` 只把“真正需要新上下文”的输入放进 `rebuildKey`，歌曲通过 `swap` 就地交接（`pixi/pixiRuntimeHost.ts:5-10,20-26`）；换歌是两帧状态机（第一帧建新场景、第二帧 commit，`pixiSongSwap.ts:1-15`）。
5. **首帧闸门**：样式切换会等目标样式“画出第一帧”才继续（`styleTransition/firstFrame.ts`，由 `pixiRuntimeHost.ts:66-72` 上报），否则过渡会盖住 60–90 ms 的编译/首帧抖动；绘光在四慢核上首帧曾达 850 ms（`pixiProgramLinks.ts:5-14` 注释）。
6. **着色器链接预热**：用 `KHR_parallel_shader_compile` + 每 10 ms 看一次、每次最多交接 4 ms（`pixiProgramLinks.ts:19-23`），把首次绘制的主线程阻塞从数百 ms 摊平。
7. **音频信号只有一条 rAF 链**：`usePlaybackVisualizerBridge` 每帧从 AnalyserNode 取 2048 bin 频谱，算 5 个频段、用 `(value/255)^boost*255` 归一后写入模块级 MotionValue（`motionSignals.ts:31-64`），不经过 React state（`usePlaybackVisualizerBridge.ts:143-195`）。
8. **节拍特效按需加载模型**：`beatClockTargets.ts:37-49` 只在“有读 beats/drums 的效果开着”时才让对应模型跑；鼓点走 htdemucs、拍点走 Beat This final0，两者共用同一个 WebGPU device（`src/services/analysis/README.md` 对应表格段）。
9. **Electron 侧 GPU 开关是“排障型”而非“调优型”**：Linux 强制 `disable-vulkan`、可选软件渲染/ANGLE SwiftShader；macOS x64 强制 `ignore-gpu-blocklist` + `use-angle gl`（`electron/main.cjs:167-219`）。
10. **换样式过渡有动画预算**：静态模式、`uiMicroMotion` 减少动效、或宿主不要求动画时直接硬切（`VisualizerRenderer.tsx:42-45`），一层柔焦 `softFocus` 只作用于样式层（`styleTransition/softFocus.ts`）。

### 0.4 与 Zilux2（C# + WebView2）的关系（一句话）

可迁移的是**契约与护栏**（注册表/生命周期/像素预算/限帧门/信号桥），不可直接迁移的是 Electron 主进程开关与 Pixi/three 运行时；WebView2 下 WebGL2 可用性、GPU 进程行为、DPI 与可见性都需要宿主侧补齐（详见 §7.4）。

---

## 1. 架构总览

### 1.1 目录结构（`src/components/visualizer/`）

根目录集中放“与样式无关”的基础设施（文件/字节数是实测）：

| 文件 | 字节 | 作用 |
|---|---|---|
| `README.md` | 36663 | 267 行的权威代码地图（运行时流程、注册、设置、过渡、宿主面） |
| `definition.ts` | 11305 | 共享契约：`VisualizerSharedProps` / `VisualizerRegistryEntry` / 设置面板/快捷控件 props |
| `registry.tsx` | 4647 | 目录自动发现、排序、内置清单自检、mod 运行时注入/移除 |
| `VisualizerRenderer.tsx` | 6878 | 唯一入口组件：延迟切模式、tuning 解析、背景/过渡/字幕层的装配 |
| `VisualizerBackdrop.tsx` | 6759 | 背景 + 视频层 + mod stage layers + 整体透明度（跨样式保留） |
| `VisualizerShell.tsx` | 12946 | 透明容器、字体栈/字重、返回按钮与玩家面板热区 |
| `settingsPanels.tsx` | 39844 | 设置面板聚合（各模式 `renderSettingsPanel`） |
| `tuning.ts` / `tuningRegistry.ts` | 6297 / 5981 | tuning 定义与 `defineVisualizerTuning` 注册 |
| `runtime.ts` | 4693 | 共享运行时助手：`useVisualizerRuntime`、当前/下一行、预热（preheat）判定 |
| `pixiSceneCache.ts` / `pixiSongSwap.ts` | 3996 / 3843 | 段落场景缓存（含换歌退役队列）、两帧换歌状态机 |
| `pixiRuntimeHost.ts`（在 `pixi/`） | — | mount-once 运行时宿主（详见 §3.1） |
| `wordGlow.ts` / `wordColoring.ts` / `GlowWord.tsx` | 7637 / 7691 / 6141 | 逐字发光、着色、字级动画（DOM 系模式共用） |
| `pixiTextureBudget.ts`（在 `pixi/`） | 113 行 | 纹理桶吸附（性能核心之一） |
| `backgrounds/` | 10 文件 | 背景注册表与背景实现 |
| `styleTransition/` | 5 文件 | 换样式过渡（`softFocus.ts`、`layerTransition.ts`、`firstFrame.ts`） |
| `videoLayer/` | 1 文件 | 视频背景层 |

子目录（按文件数）：`sonnet` 60、`tempera` 42、`diorama` 32、`lumiere` 31、`monet` 21、`pendolo` 21、`cappella` 18、`fume` 18、`preview` 11、`backgrounds` 10、`cadenza` 9、`window` 9、`claddagh` 7、`pixi` 7、`partita` 6、`styleTransition` 5、`classic` 3、`tilt` 3、`still` 2、`videoLayer` 1。

### 1.2 统一契约（`src/components/visualizer/definition.ts`）

一个可视化器 = 一个 `entry.tsx` 默认导出的 `VisualizerRegistryEntry`（`definition.ts:172-239`），渲染函数签名是 `render: (props: VisualizerSharedProps) => React.ReactElement`（`definition.ts:203`）。所有样式共用的输入都在 `VisualizerSharedProps`（`definition.ts:64-131`），核心字段：

```ts
// src/components/visualizer/definition.ts:64-131（摘）
export interface VisualizerSharedProps {
    currentTime: MotionValue<number>;      // :65 帧级时间（MotionValue，不进 React state）
    duration?: number;
    currentLineIndex: number;              // 离散，允许 React state
    lines: Line[];
    theme: Theme;
    subtitleTheme?: SubtitleTheme;
    audioPower: MotionValue<number>;       // :73 综合能量
    audioBands: AudioBands;                // :74 { bass, lowMid, mid, vocal, treble, spectrum }
    seed?: number;
    songHandoff?: VisualizerSongHandoff | null; // :88 混音换歌交接
    staticMode?: boolean;                        // 静态模式（总开关）
    backgroundStaticMode?: boolean;
    paused?: boolean;
    visualizerTunings?: VisualizerTunings;
    // …各模式 tuning（classicTuning…lumiereTuning）、monetPortraitImage、cappellaCustomEmojiImages 等
}
```

配套契约：
- `VisualizerSettingsPanelProps`（`definition.ts:139-155`）：设置面板收到 `t / isDaylight / theme / controlCardBg / rangeInputClass / tuning / onTuningChange`。
- `VisualizerQuickControlsProps`（`definition.ts:163-170`）。
- `VisualizerSongHandoff`（`definition.ts:46-62`）：换歌交接的 `progress` MotionValue、目标歌的 seed/封面/主题/歌词/`currentTime`。
- `VisualizerEntryModule`（`definition.ts:247`）：`default` 导出形状。
- `FoliumTunable`（`definition.ts:241`）：mod 层可调的声明。

`entry` 里 `render` 必须用 `React.lazy` 包起来：`definition.ts:197-202` 的注释给出理由——14 个 renderer 若静态引入会有“183 个模块（含 three.js）”，因此每个 entry 的 `render` 只 `import()` 自己那一个。

### 1.3 注册表与发现（`registry.tsx`）

```ts
// src/components/visualizer/registry.tsx:15-42（摘）
const visualizerEntryModules = import.meta.glob<VisualizerEntryModule>('./*/entry.tsx', { eager: true });
// …缺 default 抛错（:20）；重复 mode 抛错（:29）
return { entries: [...entries].sort((l, r) => l.order - r.order), byMode };  // :36
```

- 启动自检：`assertBuiltinModeList('VisualizerRegistry', …, BUILTIN_VISUALIZER_MODES)`（`registry.tsx:48`）；`types.ts` 里旧的 5 元素 `BuiltinVisualizerMode` 不是清单（`visualizer/README.md:41`）。
- 查询回退：`getVisualizerRegistryEntry` 找不到时回退到 `DEFAULT_VISUALIZER_MODE`（`classic`），见 `registry.tsx:57-58`、`types/visualizerModes.ts`。
- 预览相关：`getVisualizerPreviewStartOffset`（`:66`）、`getVisualizerScopedSeed`（`:74`）。
- mod 运行时注入：`appendVisualizerEntry`（`:85-93`，按 order 重排）、`removeVisualizerEntry`（`:102-112`）；mod 的 mode id 前缀 `mod:<modId>:<id>`，不能覆盖内置模式（`:81` 注释）。
- 背景另有一套注册表：`backgrounds/registry.tsx:12` 同样 `import.meta.glob('./*/entry.tsx')`，`:45` 自检；渲染器 `backgrounds/VisualizerBackgroundRenderer.tsx:11-13` 在 `config.transparent` 时直接 `return null`。

### 1.4 渲染入口与生命周期（`VisualizerRenderer.tsx` + `VisualizerBackdrop.tsx`）

`VisualizerRenderer.tsx` 是唯一装配点（全文 107 行）：

```tsx
// src/components/visualizer/VisualizerRenderer.tsx:32-45（摘）
const shownMode = useDeferredValue(mode);          // :32 新样式的代码到了才换（旧样式继续画）
const entry = getVisualizerRegistryEntry(shownMode);// :33
const resolvedProps = applyVisualizerTuning(shownMode, sharedProps, props.visualizerTunings); // :41
const reducedMotion = useReducedMotionFor('uiMicroMotion');                                   // :44
const transition = animateStyleSwitch && !resolvedProps.staticMode && !reducedMotion ? softFocus : null; // :45
```

- 渲染树：`<Suspense fallback={null}>` → `<VisualizerBackdrop entry props transition waits>` → `<VisualizerStyleTransition renderStyle>`（`:84-88`），字幕/和声层在 Backdrop 外（`:89-102`）。`fallback={null}` 是刻意的（`:76-83` 注释）：visualizer 是整块背景，任何占位图都会闪一下。
- 背景、视频层、mod stage layers、整体透明度由 `VisualizerBackdrop` 画一次并在**样式切换时保留**（`VisualizerBackdrop.tsx:12-20` 注释、`:75` “The layers under a style's lyrics, bottom first.”）；单样式宿主（样式图片、mod 导出窗口）由 `VisualizerShell` 自己画（`VisualizerShell.tsx:20-24`）。
- 离开的样式也要用“它自己的 tuning”渲染：`renderStyle` 对非当前模式重新 `applyVisualizerTuning`（`:70-72`）。
- 生命周期（以 Pixi 三模式为准，DOM 系模式由 React 自身 mount/unmount 承担）：

```
mount   ─┬─ VisualizerRenderer 计算 props（tuning/背景/handoff）
         ├─ entry.render → React.lazy 加载 <mode>/Visualizer*.tsx
         └─ 模式内：useVisualizerPixiHost({hostRef, rebuildKey, song, create, swap, destroy})
activate ─ create(host, song, signal) → runtime（Pixi Application / three Canvas / 手写 GL）
         ├─ 首帧：requestAnimationFrame(() => firstFrameDrawn())   // pixiRuntimeHost.ts:127-128
         └─ song 变化 → drainSong()（只朝最新歌交接，不排队）      // :74-104,153-155
deactivate ─ setPaused(...)（App.ticker.stop / 停止自建 rAF），保留上下文
dispose  ─ abort signal → destroy(runtime)（App.destroy / dispose 链）→ host.replaceChildren()  // :139-149
```

`pixiRuntimeHost.ts` 的关键设计（直接影响性能与显存）：

| 行为 | 代码 | 原因 |
|---|---|---|
| runtime 只创建一次 | `useEffect(..., [drainSong, hostRef, label, ...rebuildKey])`，`:151` | 旧实现在依赖里塞 song，换歌会销毁 WebGL 上下文、纹理池、整个场景缓存（`:5-10` 注释） |
| 换歌就地交接 | `swap(runtime, song, signal)`（`:25`） | 出歌继续画，直到新歌 ready |
| 跳过靠 drain | `drainSong` 循环只保留最新 song（`:80-104`） | 连按下一首不会排队成一串交接动画 |
| 取消安全 | `AbortController`（`:112-113`）+ `isAbort`（`:31`） | 卸载/重建时不会继续创建 |
| 卸载彻底 | `abort()`→`destroy()`→`host.replaceChildren()`（`:139-149`） | 清掉残留 canvas 节点 |
| 首帧上报 | `firstFrameDrawn`（`:70,127-128`） | 换样式过渡的闸门 |

### 1.5 与音频分析数据的连接

**(a) 每帧信号层（`src/stores/motionSignals.ts`，77 行）**：模块级创建、进程生命周期身份稳定的 MotionValue 集合——`currentTime`（`:31`）、`lyricCurrentTime`（`:34`）、`handoffProgress`（`:41`）、`handoffLyricCurrentTime`（`:42`）、`audioPower`（`:45`）、`bass/lowMid/mid/vocal/treble`（`:47-51`）、`spectrum`（`:52`，`Uint8Array`）、`beatImpact`/`downbeatImpact`（`:60-61`）、`audioBands` 汇总对象（`:64`）、`playerBottomBarLiveOffset`（`:67`）、`ponderPointerX/Y`（`:76-77`）。注释明确“绝不进 React state，否则整树按帧重渲染”。

**(b) 全局唯一的音频 rAF 循环（`src/components/app/playback/bridges/usePlaybackVisualizerBridge.ts`，353 行）**：

```ts
// usePlaybackVisualizerBridge.ts:143-195（摘）
const updateLoop = useCallback(() => {
    // :151 hasAudibleSignal = isActuallyPlaying || isTransitionAudible()
    // :156 getByteFrequencyData(dataArray)（每帧一个 Uint8Array）
    const getEnergy = (minHz, maxHz) => {                 // :159-168
        const start = Math.floor(minHz / 21.5);           // :160  21.5 Hz/bin = 44100/2048
        const end   = Math.floor(maxHz / 21.5);           // :161
        // …取平均并做 0..255 归一
    };
    const bass   = getEnergy(20, 150);                    // :170
    const lowMid = getEnergy(150, 400);                   // :171
    const mid    = getEnergy(400, 1200);                  // :172
    const vocal  = getEnergy(1000, 3500);                 // :173
    const treble = getEnergy(3500, 12000);                // :174
    const process = (value: number, boost = 2) => (value / 255) ** boost * 255; // :176-179
    audioPower.set(process((bass + lowMid) / 2, 3));      // :181
    audioBands.bass.set(process(bass, 1.8));              // :182
    // lowMid/mid/treble boost 2（:183-186）、vocal 1.5
    // 无信号时“呼吸”兜底：breath = (sin(time)+1)*20（:189-192）
    // 末尾：audioloop 自调度 requestAnimationFrame(updateLoop)（:314）
}, [...]);
```

同文件还负责：`findLatestActiveLineIndex` 找当前行、只在行号变化时 `setCurrentLineIndex`（`:199-212`，注释强调“别每帧 set state”）、beatFx 开启时 `tickBeatFx`（`:296-298`）、换歌交接期间写 `handoffProgress/handoffLyricCurrentTime`（`:300-312`）。循环启动/清理在 `:345-352`。

**(c) AnalyserNode 配置（`usePlaybackAudioBridge.ts:138-140`）**：`createAnalyser()`、`fftSize = 2048`、`smoothingTimeConstant = 0.6` → 频率分辨率约 21.5 Hz/bin，是上面所有频段换算的依据。

**(d) 离线分析（`src/services/analysis/`，2610 行，README 详述）**：`beatThis.ts` + `beatThisWgsl/`（Beat This! final0，WebGPU 推理）、`beatThisGpu.ts`（渲染进程 Worker 内 WebGPU，与 htdemucs 共用一个 device）、`htdemucsWgsl/`（自写 WGSL 的 htdemucs，鼓轨分离；M4 单段 f32 141.7 ms / f16 128.0 ms，自动切片后 186/170 ms，单个 dispatch 最长 4.7 ms“不挤掉渲染帧”）、`beatGrid.ts`（整曲拍点，存盘复用）、`beatAccents.ts`（每拍强度/低中高占比/整曲动感系数 0.45–1）、`drumHits.ts`/`drumHitStream.ts`（鼓点流式产出）。**结论：分析在 Worker/WebGPU，可视化渲染在 rAF 主线程，桥是 MotionValue**。

**(e) 智能动感（beat effects）按需模型**：效果登记在各模式 `entry.tsx` 的 `beatEffects`（id 形如 `<模式>.<名字>`，类型见 `src/services/beatFx/beatEffects.ts:19-36`）；`src/components/visualizer/beatClockTargets.ts:37-49` 的 `visualizerWantsBeats` / `visualizerWantsDrumHits` / `visualizerWantsBeatClock` 决定是否让 Beat This / htdemucs 跑起来——没有效果读它，就不跑模型。

### 1.6 数据流图（端到端）

```
┌──────────────────────────── 主进程 (Electron) ────────────────────────────┐
│ electron/main.cjs                                                        │
│  · GPU/平台开关 :167-219   · 窗口 webPreferences(backgroundThrottling:false)│
│  · 壁纸模式窗口 :5195-5270 · 透明/acrylic/vibrancy                        │
└───────────────▲──────────────────────────────────────────────────────────┘
                │ preload.cjs（contextIsolation: true, nodeIntegration: false）
┌───────────────┴──────────────── 渲染进程 ────────────────────────────────┐
│ 音频元素 ──► MediaElementSource ──► AnalyserNode(2048, 0.6)              │
│                                     usePlaybackAudioBridge.ts:138-140    │
│                                             │                            │
│        ┌────────────────────────────────────┘                            │
│        ▼                                                                 │
│  usePlaybackVisualizerBridge（唯一 rAF 链）                              │
│   getByteFrequencyData → 5 段能量 → process(^boost) → motionSignals      │
│   + currentLineIndex（离散 setState）+ handoffProgress + tickBeatFx      │
│        │                                                                 │
│        ▼   MotionValue（不进 React state）                               │
│  VisualizerRenderer.tsx :32-45                                           │
│   useDeferredValue(mode) → applyVisualizerTuning → transition/reducedMotion│
│        │                                                                 │
│        ├──► VisualizerBackdrop.tsx（背景 registry + videoLayer + mod 层）│
│        └──► VisualizerStyleTransition → entry.render → <mode> renderer   │
│                 │                                                        │
│     ┌───────────┼──────────────┬───────────────┬──────────────┐          │
│     ▼           ▼              ▼               ▼              ▼          │
│  Pixi 8(x3)  three/R3F(x1)  手写 WebGL2(x1)  Canvas2D(x2)  DOM/CSS(x7)    │
│  每帧 ticker   useFrame     自建 rAF          2D ctx 每帧   framer-motion  │
│                                                                          │
│  Worker：monet 背景底图(OffscreenCanvas→JPEG)、beatThis/htdemucs(WebGPU)  │
└──────────────────────────────────────────────────────────────────────────┘
```

### 1.7 生命周期与“谁负责暂停”

- **DOM 系模式**（classic/partita/tilt/claddagh/cadenza/cappella/still）：暂停时 `paused` 传入，动画停；组件卸载即释放。
- **Pixi 三模式**：`useVisualizerPixiHost` 持有 runtime，`setPaused` 走运行时方法（`app.ticker.stop()` / 停止自建循环），**不销毁**上下文；销毁只发生在卸载或 `rebuildKey` 变化（`pixiRuntimeHost.ts:106-151`）。
- **镜台**：R3F `<Canvas>` 自己管理渲染循环；`frameloop` 需要时手动“按需渲染”（`VisualizerDiorama.tsx:102-108` 注释说明场景在程序链接完成后才首绘）。
- **时计**：`PendoloClockworkCanvas` 管理 WebGL2 + Canvas2D 两个画布（`PendoloClockworkCanvas.tsx:28`）。
- **不存在**“页面不可见就暂停”的统一逻辑：`document.visibilityState` 全 `src` 仅 15 处命中，可视化核心目录里没有；lattice 歌词画布自己做了 `visible = intersecting && !document.hidden`（`src/components/app/lattice/lyrics/useLatticeLyricCanvas.ts:59`，监听在 `:97`），这是个案而不是框架能力（**待确认**：是否有 Electron 侧 `browser-window-blur` 暂停路径，本文未找到）。

---

## 2. 14 个可视化器逐个清单

> 每个模式给出：注册信息（`entry.tsx` 行号）、渲染技术、原理要点、音频驱动、性能特征。`order` 即 UI 中的排列序（升序）。
> 数量核实见 §2.15：`entry.tsx` 目录数 = `BUILTIN_VISUALIZER_MODES` = **14**，与 README/文档声称一致，`order` 10–130 连续。

### 2.1 商籁 / sonnet — order 10

- 注册：`src/components/visualizer/sonnet/entry.tsx:25`（`order: 10`）、`:27`（`labelFallback: '商籁'`）；`usesWordSegmentation: true`；`beatEffects` 含“推镜裂光”（`sonnetBeatFx.ts`）。
- 技术：**Pixi.js 8 / WebGL2**。外壳 `VisualizerSonnet.tsx`（262 行）是 React shell，`useVisualizerPixiHost`（`VisualizerSonnet.tsx:9`）挂载命令式运行时 `createSonnetPixiRuntime.ts`。
- 原理：模式导航见 `src/components/visualizer/README.md:144-229`（本文以下按代码补充）。它是全部模式里文件最多（60 个）的一个，按段落（shot）组织：镜头流（`sonnetShotFlowLayouts.ts`、`sonnetShotFrame.ts`）、图形/装饰变体（`sonnetBackgroundDecor.ts`、`sonnetFrameDecor.ts`、`sonnetFixedGeoVariants.ts`）、歌词字形布局（`sonnetGlyphLayout.ts`）与语义（`sonnetSemantic.ts`）、片尾 credits（`sonnetCredits.ts`）。
- 音频驱动：`audioPower` 推后处理强度——`sonnetPostProcess.ts:31-54` 的 `resolveSonnetPostProcessProfile` 在非静态模式下 `glowStrength = 2.8 + motion * 1.8`（`:51`），对比度是 Pixi 的加性值 `* 0.5`（`:54`）；`staticMode` 时返回全 0（`:36-41`）。节拍特效走 `sonnetBeatFx.ts`。
- 性能特征：`antialias: !options.tuning.postProcessEnabled`（`createSonnetPixiRuntime.ts:151`，有后处理就关 MSAA，避免两次全屏采样）、`powerPreference: 'high-performance'`（`:152`）、`autoStart: false` + `sharedTicker: false`（`:165-166`，自管 ticker，`:207` add、`:716` remove）；首帧 + 下一 tick 在四慢核上 60–90 ms（`pixiRuntimeHost.ts:66-69` 注释）。

### 2.2 凝彩 / tempera — order 20

- 注册：`src/components/visualizer/tempera/entry.tsx:21`（`order: 20`）、`:23`（`labelFallback: 'Tempera'`）；`usesWordSegmentation: true`。
- 技术：**Pixi.js 8 / WebGL2**，`VisualizerTempera.tsx`（294 行）+ `createTemperaPixiRuntime.ts`。
- 原理：块状构图的歌词 PV（`temperaBlocks.ts`、`compositions/`、`temperaCompositions.ts`、`temperaShotProfiles.ts`）+ 用户可导入图片层（`temperaImageLayer.ts`、`temperaImageTextures.ts`、`TemperaImageLayerDialog.tsx`）；字形用图文纹理（`temperaTextView.ts`），滤镜含差值/场景滤镜（`temperaDifferenceFilter.ts`、`temperaSceneFilters.ts`）、入场与转场（`temperaTransitions.ts`、`temperaEnterStyles.ts`）。
- 音频驱动：同 sonnet 走 `audioPower`；节拍效果由 `beatEffects` 声明（无独立 beatFx 文件）。
- 性能特征：**本文档性能护栏的最佳案例**——渲染分辨率不是直接用 `tuning.textureResolution`，而是 `snapResolutionToTexturePool(width, height, options.tuning.textureResolution)`（`createTemperaPixiRuntime.ts:165`），并写回 `runtime.renderResolution`（`:178`）；`antialias: !postProcessEnabled`（`:155`）、`powerPreference: 'high-performance'`（`:156`）、`autoDensity: true`（`:171`）、`autoStart: false` / `sharedTicker: false`（`:173-174`）。

### 2.3 绘光 / lumiere — order 25

- 注册：`src/components/visualizer/lumiere/entry.tsx:15`（`order: 25`）、`:17`（`labelFallback: '绘光'`）；`usesWordSegmentation: true`。
- 技术：**Pixi.js 8 / WebGL2**，`VisualizerLumiere.tsx`（217 行）+ `createLumierePixiRuntime.ts`；目录内 `light/`（光场）、`lineart/`（线稿）、`rigs/`（灯架）、`text/` 四个子模块。
- 原理：舞台灯照光场——`light/lightFieldShader.ts` 是自写片元着色器；`lumiereSeamless.ts`（无缝转场）、`lumiereGroupFilters.ts`（分组滤镜）、`lumiereDarkField.ts`、`lumiereKernel.ts`、`lumiereUnit.ts`/`lumiereUnitLayout.ts`。运行时 `createLumierePixiRuntime.ts:131`（`antialias: false`）、`:132`（`powerPreference: 'high-performance'`）、`:144`（`autoDensity`）、`:146-147`（`autoStart: false`、`sharedTicker: false`）、`:192`（ticker.add）、`:483`（ticker.remove）。
- 音频驱动：`lumiereAudio.ts` + `audioPower/audioBands`。
- 性能特征：三档画质 + 两级分辨率（见 §4.2/§4.4）：`LUMIERE_QUALITY_PROFILES`（`lumiereRuntimeTuning.ts:32-36`，full/balanced/low = graphicsScale 1/0.7/0.5、maxFogOctaves 6/4/3、moteScale 1/1/0.6）、`LUMIERE_MAX_RENDER_RESOLUTION = 2`（`:39`）、`resolveLumiereRenderResolution` 把 dpr 钳在 1..2（`:42-44`）、`resolveLumiereGraphicsResolution` 对“图形组”再按纹理池吸附（`:52-58`）、`resolveLumiereBloomLevelDrop` 按 log2 就近减一级 bloom（`:67`）。首帧在四慢核上曾达 850 ms（`pixiProgramLinks.ts:10-11` 注释），这也是程序预热机制诞生的原因。

### 2.4 classic / Luminous — order 30

- 注册：`src/components/visualizer/classic/entry.tsx:14`（`order: 30`）、`:16`（`labelFallback: 'Luminous'`）；`usesWordSegmentation: true`。
- 技术：**纯 DOM/CSS + framer-motion**（`Visualizer.tsx` 395 行），无 WebGL。
- 原理：`Visualizer.tsx:20-33` 注释自述为“最直白的歌词管线”：先问 runtime 哪一行在唱（`useVisualizerRuntime`），再读该行 renderHints（`utils/lyrics/renderHints`），再建宽松的逐字布局（`cjkSemanticLayout` 的 `buildPostLyricLayoutUnits`），每个字独立动画、不依赖父级重渲染。字级状态机 waiting → active → passed（`:29-32` 注释）。
- 音频驱动：`GlowWord` + `glowWordTiming.ts`/`glowWordVariants.ts` 用 `audioPower` 推发光/体量。
- 性能特征：2D 测量用一个共享离屏 canvas（`Visualizer.tsx:76` `classicMeasureCanvas.getContext('2d')`）；高频动画全部走 MotionValue/CSS，不 setState（README `:251-257` 的 runtime guardrails）。
- 备注：它是默认模式（`DEFAULT_VISUALIZER_MODE`，`registry.tsx:57-58` 的回退目标）。

### 2.5 Mindscape / cadenza — order 40

- 注册：`src/components/visualizer/cadenza/entry.tsx:26`（`order: 40`）、`:28`（`labelFallback: 'Mindscape'`）；注意 `labelKey` 是 `ui.visualizerCadenze`（拼写如此，`entry.tsx:27`），改 i18n 键要同步。
- 技术：**DOM 碎片 + Canvas2D 文字纹理 + 自建 rAF 绘制**（`VisualizerCadenza.tsx` 565 行）。
- 原理：把歌词拆成放置好的“碎片”（`cadenzaFragments`/`cadenzaPlacements`/`cadenzaEnvelopes`/`cadenzaPreparedState` 同目录文件），按时间包络驱动位移/透明度；`VisualizerCadenza.tsx:220` 用 `textCanvas.getContext('2d')` 生成文字纹理。使用 `prepareActiveAndUpcoming`（`runtime.ts`）做行级预热。
- 音频驱动：`audioPower`/`audioBands` 推包络与碎片的加速度。
- 性能特征：自建 rAF 而不是 framer 的 `useAnimationFrame`（同文件 `isGlowBlurQuantized` 参与发光量化，见 Linux FD 泄漏修复项 `glowBlurQuantize`，§4.4）。

### 2.6 云阶 / partita — order 50

> 注意：cadenza 的 fallback 是 `Mindscape`、partita 的是 `云阶`；中文界面下显示“云阶”的是 **partita**（i18n 键 `ui.visualizerPartita` / `ui.visualizerCadenze` 分别见两个 `entry.tsx`）。

- 注册：`src/components/visualizer/partita/entry.tsx:14`（`order: 50`）、`:16`（`labelFallback: '云阶'`）；`usesWordSegmentation: true`。
- 技术：**DOM/CSS + framer-motion**（`VisualizerPartita.tsx` 242 行）。
- 原理：分层排版（`partitaLayout.ts`）把歌词排成多段，逐字用 `useMotionValueEvent` 跟随 `currentTime`（不重渲染），`GlowWord` 做发光。
- 音频驱动：`audioPower` 推整体亮度/缩放。
- 性能特征：`useMotionValueEvent` 是 README `:251-257` 点名的“必须带相等保护 + cleanup”的高频路径之一。

### 2.7 烟雾 / fume — order 60

- 注册：`src/components/visualizer/fume/entry.tsx:21`（`order: 60`）、`:23`（`labelFallback: 'Fume'`）；`background: fumeBackgroundConfig`；`previewStartOffset: 18.4`。
- 技术：**Canvas2D 主画布**（`useFumeCanvasStage.ts`）+ CSS/Canvas 背景（`FumeBackground.ts`）+ 相机步进（`fumeCameraStep.ts`），`VisualizerFume.tsx` 421 行。
- 原理：纸面/印刷感（`showPrintStamp`）、文本以 canvas 位图绘制（`fumeCanvasText.ts`）并被相机“拍摄”，`fumeLiveRaster.ts` 把文字预先栅格化成 live raster，`FumeBackground.ts:386` 用 `WeakMap<CanvasRenderingContext2D, Map<string, CanvasGradient>>` 缓存渐变。
- 音频驱动：`audioPower`/`audioBands` 推相机的推拉与发光。
- 性能特征：**DPR 处理在这里分叉**——舞台画布直接用 `window.devicePixelRatio` 不设上限（`useFumeCanvasStage.ts:75-80`，`canvas.width = floor(width*dpr)`、`setTransform(dpr,…)`），但文字栅格化钳在 1..2（`fumeCanvasText.ts:77` `clamp(dpr,1,2)`；`fumeLiveRaster.ts` 同样）。`dt` 被钳在 1/240..0.05 s（`:95`），防切后台回来弹跳。`staticMode` 直接冻结相机（`:118,163`）。

### 2.8 tilt — order 70

- 注册：`src/components/visualizer/tilt/entry.tsx:21`（`order: 70`）、`:23`（`labelFallback: 'Tilt'`）。
- 技术：**DOM/CSS 3D 变换 + framer-motion**，`VisualizerTilt.tsx` 702 行（单文件最大的 DOM 模式）。
- 原理：文字测量用 `pretext` 的 `prepareWithSegments` / `layoutWithLines`（同文件 import；`tilt` 只有 3 个文件，测量逻辑全在主组件里），字形时间用 `graphemeTiming`。
- 音频驱动：`audioPower` 驱动倾斜/位移。
- 性能特征：宽屏下 DOM 节点多，测量结果必须按“歌词内容 + 主题 + 最终字重 + 窗口尺寸”做缓存（README `:257`）。

### 2.9 claddagh — order 80

- 注册：`src/components/visualizer/claddagh/entry.tsx:14`（`order: 80`）、`:16`（`labelFallback: 'Claddagh'`）。
- 技术：**DOM/SVG + framer-motion**（`VisualizerCladdagh.tsx` 330 行；`RingLine.tsx` 环形线、`claddaghTimeline.ts`/`claddaghLayout.ts`/`claddaghGlow.ts`）。
- 原理：克拉达戒指式的环形歌词轨道，`useMotionValue` + `animate` + `useSpring` 驱动环的转动与光。
- 音频驱动：`audioPower` 推弹簧目标值。
- 性能特征：纯 CSS/transform，无每帧 React 重渲染；字符串/环的分段在布局阶段算好。

### 2.10 monet — order 90

- 注册：`src/components/visualizer/monet/entry.tsx:14`（`order: 90`）、`:16`（`labelFallback: 'Monet'`）；`seeksOnLineClick: true`、`followsSongHandoff: true`（14 个里唯一两个都开的模式之一，另一个是 pendolo 的 `seeksOnLineClick`）。
- 技术：**Canvas2D + Worker 离屏底图 + DOM 歌词轨**（`VisualizerMonet.tsx` 578 行）。
- 原理：静态“海报”底图由 Worker 在 `OffscreenCanvas` 上画好（`monetBackground.worker.ts:27-33`），编码成 JPEG（`convertToBlob({ type:'image/jpeg', quality: 0.92 })`，`:33`），主线程只创建 object URL（`monetBackgroundPipeline.ts:230`）并在卸载时 `revokeObjectURL`（`:238`）；画布尺寸固定 `MONET_BACKGROUND_WIDTH = 1920` / `HEIGHT = 1080`（`monetBackgroundPaint.ts:8-9`）。结果按 cacheKey 缓存并引用计数（`monetBackgroundPipeline.ts:248-249` 的 `wantMonetBackgroundUrl` 返回 `{url, release}`；`:9-11` 有 `url`/`holders` 字段），换歌只换 key。歌词轨是 DOM（`MonetLyricsRail.tsx`/`monetRailLayout.ts`），另有 `AudioOverlay.tsx:171` 的第二块 2D canvas。
- 音频驱动：`audioPower` 推漂浮装饰（`MonetFloatingDecor.tsx`）与轨道的漂移；`MonetBackgroundLayer.tsx:160` 的 `driftEnabled = backgroundDriftEnabled && !staticMode && driftStrength > 0`。
- 性能特征：worker 化 + 固定尺寸 + JPEG 压缩是“把昂贵的一次性绘制挪出主线程”的样板；主线程只在歌/封面/主题变化时重建。

### 2.11 时计 / pendolo — order 100

- 注册：`src/components/visualizer/pendolo/entry.tsx:22`（`order: 100`）、`:24`（`labelFallback: 'Pendolo'`）；`seeksOnLineClick: true`；`beatEffects` 含“仿真鼓面”（读鼓点，`usePendoloBeatFx.ts`）；render 带 `key={props.seed}`。
- 技术：**手写 WebGL2 渲染器 + Canvas2D 叠加层 + DOM**（`VisualizerPendolo.tsx` 728 行）。
- 原理：`pendoloClockworkWebGL.ts:232` 的 `class PendoloClockworkRenderer` 自己建 context：`:320-324` `canvas.getContext('webgl2', { premultipliedAlpha: true, antialias: true, powerPreference: 'high-performance' })`；场景/网格/运动在 `pendoloClockworkScene.ts`/`pendoloClockworkMeshes.ts`/`pendoloClockworkMotion.ts`；2D 叠加层 `pendoloClockworkDraw2d.ts`（扫过的歌词高亮 `PendoloActiveLyricSweep.tsx`）；文本布局 `pendoloTextLayout.ts`。
- 音频驱动：`audioPower` 推表盘指针；**鼓点**驱动“仿真鼓面”（`pendoloBeatFx.ts` + `pendoloBeatFxDraw.ts` + `usePendoloBeatFx.ts`），鼓点来自 htdemucs 鼓轨（§1.5d）。
- 性能特征：不使用 Pixi，context 参数自控；`premultipliedAlpha: true` + `antialias: true` 是自觉的取舍（叠加层在 Canvas2D 上，WebGL 层要能透出文字）。封面走 CORS 检查后才能上传纹理（`PendoloClockworkCanvas.tsx:165`、`:325` 注释）。

### 2.12 cappella — order 110

- 注册：`src/components/visualizer/cappella/entry.tsx:23`（`order: 110`）、`:25`（`labelFallback: 'Cappella'`）。
- 技术：**DOM/CSS 气泡 + 图片（头像/自定义 emoji）**，`VisualizerCappella.tsx` 238 行，无 canvas。
- 原理：把歌词做成消息气泡（发送者 `cappellaMessageSenders.ts`，头像与 emoji 资源由 `cappellaCustomEmojiImages` 注入），按行入队/出队动画。
- 音频驱动：`audioPower` 推气泡的脉动/入场。
- 性能特征：几乎零 GPU 负担（14 个里最轻的两个之一）；图片资源要按“歌/设置”缓存，否则每行都重新解码。

### 2.13 镜台 / diorama — order 120

- 注册：`src/components/visualizer/diorama/entry.tsx:16`（`order: 120`）、`:18`（`labelFallback: '镜台'`）；`beatEffects` 含“水镜涟漪”（`dioramaBeatRipples.ts`）。
- 技术：**three.js + @react-three/fiber（R3F）**，`VisualizerDiorama.tsx` 554 行；`<Canvas dpr={[1, 2]}>`（`:458`）、`gl={{ alpha: true, antialias: true }}`（`:459`）。
- 原理：把歌词排成走廊/立面的“字块”（`dioramaSceneUnits.ts`、`dioramaSceneLayout.ts`、`dioramaSequencer.ts`、`dioramaSceneFrame.ts`、`cameraPath.ts`/`CameraRig.tsx`）；文字是**栅格化成纹理**（`dioramaTextRaster.ts`、`dioramaLineRasterCache.ts`），不是 SDF；粒子由自定义着色器（`dioramaParticleShaders.ts`）驱动位移，水镜涟漪按 beat 生成高斯包络的环形扰动（`dioramaBeatRipples.ts`）。
- 音频驱动：`audioPower` 推粒子/相机；节拍（`beatImpact`）触发涟漪。`VisualizerDiorama.tsx:102-108` 注释说明：Canvas 首次绘制在场景程序链接完成之后才发生，`compileAsync` 不能在 Canvas 卸载后继续询问（`:122`）。
- 性能特征：R3F 的 `dpr={[1,2]}` 是**引擎级 DPR 上限**；`antialias: true`（默认 MSAA）与粒子 shader 的片元成本叠加，是 14 个里最重的前二（`dev/perf/README.md` 把 diorama 列为重点测量场景，见 §4.7）；`gl` 属性只设 `alpha/antialias`，没有关 `preserveDrawingBuffer` 之类的显式优化（three 默认）。

### 2.14 still — order 130

- 注册：`src/components/visualizer/still/entry.tsx:10`（`order: 130`）、`:12`（`labelFallback: 'Still'`）；`background: false`；**没有** `renderSettingsPanel`。
- 技术：**纯静态 DOM**，`VisualizerStill.tsx` 98 行（14 个里最小）。
- 原理：只排版当前行歌词，无动画/无 canvas；仍然遵守统一契约（接收 `currentTime` 等，但不用）。
- 音频驱动：无（唯一一个完全不读音频的模式）。
- 性能特征：作为“零成本兜底样式”存在；也是在不支持 WebGL 的机器上唯一安全的模式（**待确认**：没有找到自动 fallback 到 Still 的代码路径，只有用户手动切）。

### 2.15 数量核实与“文档声称 vs 代码实际”

| 项 | 声称 | 代码实际 | 判定 |
|---|---|---|---|
| 可视化器数量 | **仓库内无数字声明**（交办信息称“README/文档说 14 个”，但 `README.md` 与 `docs/`、`visualizer/README.md` 均未写数量；可能来自上游站点/发行说明，**待确认**） | `entry.tsx` 14 个；`order` 10,20,25,30,40,50,60,70,80,90,100,110,120,130 连续 | ✅ 代码=14（独立核实） |
| 清单权威 | — | `types/visualizerModes.ts` `BUILTIN_VISUALIZER_MODES`，启动自检 `registry.tsx:48` | ✅ |
| mod 样式 | — | 运行时注入，id `mod:<modId>:<id>`，不进内置清单（`registry.tsx:77-93`） | ✅ 计入“可扩展”而非 14 |
| 旧类型 | `types.ts` 的 `BuiltinVisualizerMode` | 只列 5 个名字，是旧类型（`visualizer/README.md:41` 明说） | ⚠️ 别拿它当清单 |
| 背景 | 另一组 `backgrounds/*/entry.tsx` | `backgrounds/registry.tsx:12` 自动发现 | 独立计数（目录 10 文件） |
| 预览/导出等窗口 | — | `preview/LyricStylePicture.tsx`、`mods/export/modExportPage.tsx`、`dev/probes/*.probe.tsx` 不走 `VisualizerRenderer`（`README.md:231-247`） | ⚠️ 统计宿主时要排除 |

### 2.16 渲染技术分类表

| 技术 | 模式 | 数量 | 典型每帧成本来源 |
|---|---|---|---|
| Pixi 8（WebGL2 全屏 filter/bloom/draw call） | sonnet、tempera、lumiere | 3 | render target 尺寸（纹理池桶）× 后处理 pass 数 |
| three.js + R3F | diorama | 1 | 逐帧 draw call + MSAA + 粒子 shader |
| 手写 WebGL2 | pendolo | 1 | 单 program + 实例化网格 |
| Canvas2D（离屏/worker 辅助） | fume（主）、monet（局部+worker） | 2 | 像素填充率与文字栅格化 |
| DOM/CSS + framer-motion | classic、cadenza、partita、tilt、claddagh、cappella | 6 | 合成层数量与测量/布局 |
| 静态 DOM | still | 1 | 一次布局 |

---

## 3. 五个最佳案例的完整数据流

> 选取标准：覆盖三条渲染栈（Pixi / three-R3F / 手写 WebGL2）+ 一条 Canvas2D；且每个案例都能讲清“音频特征 → uniform/纹理 → 渲染循环 → 清理”四段。行号均来自源码。

### 3.1 案例一：sonnet（Pixi 8 + 后处理 + 场景缓存 + 换歌交接）

```
audioPower(MotionValue) ─┐
audioBands{bass…} ───────┤
currentTime ─────────────┤   每帧由 usePlaybackVisualizerBridge 写入（§1.5b）
currentLineIndex ────────┘
        │
        ▼  createSonnetPixiRuntime.ts（命令式运行时）
  Pixi Application（autoStart:false、sharedTicker:false、resolution 走纹理池）
        │ ticker.add(renderFrame)（:207）
        ▼
  renderFrame：读 MotionValue → 更新场景/字形/后处理 uniform → renderer.render(scene)
        │
        ├─ PostProcess 链：sonnetPostProcess.ts 的 profile（glowStrength=2.8+motion*1.8, contrast*0.5）
        ├─ 自定义 Filter：sonnetGlitchFilter / sonnetPrintFilters / sonnetLensFilter
        └─ 场景来自 PixiSceneCache（当前段 ±1，pixiSceneCache.ts）
        │
        ▼  换歌：pixiSongSwap 两帧状态机（stage → commit，pixiSongSwap.ts:1-15）
        ▼  卸载：runtime.destroy → ticker.remove(:716) → app.destroy({removeView:true})
```

**四段拆解**

1. **音频特征**：`audioPower` 是综合能量（`usePlaybackVisualizerBridge.ts:181`，`(bass+lowMid)/2` 的 3 次幂归一），在 sonnet 里主要进入后处理强度（`sonnetPostProcess.ts:51`）与镜头运动的“motion”项；`audioBands` 的 5 个频段用于次要装饰。
2. **uniform / 纹理**：Pixi 层的 uniform 由自定义 Filter 的 `uniforms` 承载；顶点着色器三模式共用 `pixiFilterVertex.ts`（把单位方块铺到 filter 输出区域，按输入纹理尺寸换算 `vTextureCoord`），片元各模式自写。纹理来自文字/图标渲染（`sonnetIconTextures.ts`、`sonnetPixiResources.ts`）与场景缓存。
3. **渲染循环**：`ticker.add(this.renderFrame)`（`createSonnetPixiRuntime.ts:207`）。`autoStart:false` + `sharedTicker:false` 意味着渲染完全由该运行时控制，不受全局共享 ticker 的其他消费者影响（也让全局 rAF 限帧门能统一管辖，因为 Pixi 的 ticker 最终也走 `requestAnimationFrame`）。
4. **清理**：`ticker.remove`（`:716`）→ `app.destroy`；宿主再 `host.replaceChildren()` 清 DOM（`pixiRuntimeHost.ts:148`）。换歌**不**销毁上下文（`pixiRuntimeHost.ts:5-10` 的设计目标）。

**为什么它值得借鉴**：它把“导演逻辑（shot/frame）”和“渲染运行时”分层——场景是可缓存的数据结构，渲染器只负责把当前帧的 uniform 填上。这让“换歌交接”和“场景缓存”成为两个独立可测的模块。

### 3.2 案例二：tempera（纹理预算 + 画质开关的最完整实现）

```
窗口尺寸 ──► snapResolutionToTexturePool(w, h, tuning.textureResolution)   // createTemperaPixiRuntime.ts:165
                     │
                     ▼  返回 resolution（例如 1.2047 而非 1.5）
        Pixi Application({ resolution, autoDensity: true, antialias: !postProcessEnabled,
                           powerPreference: 'high-performance', autoStart: false, sharedTicker: false })
                     │  runtime.renderResolution = resolution（:178）
                     ▼
        ticker.add(renderFrame)  ──► 每帧：文字纹理 + 图片层 + 滤镜链 → renderer.render
                     │
                     ▼
        卸载：ticker.remove → sceneCache.destroyAll（逐项）→ app.destroy({removeView:true})
```

- **像素预算**：`snapResolutionToTexturePool` 的核心思路在 `pixiTextureBudget.ts:1-26` 的注释里被量化：Pixi 的 `TexturePool.getOptimalTexture` 会把每个轴 `nextPow2(ceil(size*resolution))`；781×850 视口 × 1.5 = 1172×1275 → 2048×2048（16 MiB）只装 5.7 MiB 画面（71% 浪费）。吸附到 1.2047 后 1024×1024（1/4 显存），画面填充 92%。
- **实测代价**：注释 `pixiTextureBudget.ts:12-15` 记录 Intel iGPU 上窗口 640×640→700×700（面积 +18%）使 tempera 常驻 GEM 从 628 MiB 涨到 822 MiB（+31%），根因是 `1.5×700` 跨过 1024 让两轴同时翻倍。这段“面积小涨、显存大涨”的记录是整份调研里最有说服力的显存账。
- **限制**：只放弃“能换来更小 bucket”的分辨率，单轴最多 0.25（`TEXTURE_POOL_MAX_RESOLUTION_DROP`，`:64`）；两个轴都试、按 bucket 面积排序（`:86-113`）——即“宁可降分辨率也要命中更小的 2 的幂桶”。
- **画质开关**：`antialias: !postProcessEnabled`（`:155`）——开了后处理就关 MSAA，避免两次全屏采样；`powerPreference: 'high-performance'`（`:156`）在双显卡笔记本上要独显。

### 3.3 案例三：diorama（three + R3F：事件驱动的音频，而不是每帧音频）

```
beatImpact(MotionValue) ──► dioramaBeatRipples：生成“水镜涟漪”参数（中心/半径/幅度/时间）
audioPower ──────────────► 相机 rig（CameraRig.tsx useFrame）与粒子场
                                  │
        <Canvas dpr={[1,2]} gl={{alpha:true, antialias:true}}>   // VisualizerDiorama.tsx:458-459
                                  │ R3F 自己的 rAF 循环（useFrame）
                                  ▼
        粒子 shader（dioramaParticleShaders.ts）：位移 = 基础流 + 涟漪高斯包络 + 整数谐波接缝
        文字层 = 预先栅格化的 canvas 纹理（dioramaTextRaster.ts / dioramaLineRasterCache.ts）
                                  │
                                  ▼ 卸载：React 卸载 Canvas → three 释放 program/texture（R3F 默认 dispose）
```

- **音频驱动方式与 Pixi 模式不同**：diorama 不把音频当“每帧连续信号”直接塞进 shader，而是**事件驱动**——拍点触发涟漪包络（`dioramaBeatRipples.ts`），然后由 shader 按时间演化。好处：即使音频桥某帧抖动，视觉上也看不出；坏处：需要可靠拍点（Beat This，§1.5d）。
- **渲染循环**：R3F 的 `useFrame` + `<Canvas>` 自带循环；`dpr={[1,2]}` 是引擎级的像素上限（`VisualizerDiorama.tsx:458`），比各模式手动钳 dpr 更稳。
- **首帧**：`VisualizerDiorama.tsx:102-108` 注释说明场景在 shader 程序链接完成后才首绘，`compileAsync` 不能在 Canvas 已卸载时继续询问（`:122`）——与 §3.5 的“首帧闸门”是同一类问题的两种解法。
- **待确认**：粒子 shader 的具体 uniform 名称（`uTime`/`uRipple*` 之类）未在调研中逐行核对，报告中不列名。

### 3.4 案例四：pendolo（手写 WebGL2：最接近“自己写渲染器”的样本）

```
canvas.getContext('webgl2', { premultipliedAlpha:true, antialias:true,
                              powerPreference:'high-performance' })  // pendoloClockworkWebGL.ts:320-324
        │  class PendoloClockworkRenderer（:232）
        ▼
  每帧：更新钟表机构几何（pendoloClockworkMeshes/Motion/Scene）
        ├─ 上传/复用 VBO、设置 uniform（时间、能量、鼓点脉冲）
        └─ drawArrays/drawElements（单 program 为主，实例化网格）
        │
        ▼  Canvas2D 叠加层（pendoloClockworkDraw2d.ts）+ DOM 扫词（PendoloActiveLyricSweep）
        ▼ 鼓点：usePendoloBeatFx → pendoloBeatFxDraw（仿真鼓面）
        ▼ 卸载：取消 rAF → 删除 program/buffer → 丢失上下文由浏览器回收
```

- **为什么值得看**：它证明“不依赖 Pixi/three 也能做可视化器”——一个 program + 一组网格 + 每帧 uniform，代价是自己处理 resize/上下文丢失/资源释放。
- **音频驱动**：`audioPower` 推指针/钟摆，**鼓点**（htdemucs 鼓轨，§1.5d）推“仿真鼓面”的形变（`pendoloBeatFx.ts`）。
- **上下文参数**：`premultipliedAlpha: true` 与 `antialias: true` 都是为叠加层服务的（DOM/2D 层要透出 WebGL 层、要能叠抗锯齿文字），这是“自写渲染器必须自己做的兼容决定”。

### 3.5 案例五：monet（Canvas2D + Worker：把一次性昂贵绘制挪出主线程）

```
歌/封面/主题变化 ──► getMonetBackgroundCacheKey(options)          // monetBackgroundPipeline.ts:60
                       │ cache miss
                       ▼
        new Worker(new URL('./monetBackground.worker.ts', …))     // :181
                       │ postMessage（封面像素/调色参数）
                       ▼
        worker：new OffscreenCanvas(1920, 1080)                   // worker.ts:27
                ctx2d 画“莫奈海报” → convertToBlob({jpeg, 0.92})  // :33
                       │ postMessage(blob)
                       ▼
        主线程：URL.createObjectURL(blob)                        // :230
               缓存 {url, holders}（:9-11）→ 引用计数
                       │
                       ▼  组件拿 {url, release}（wantMonetBackgroundUrl，:248-249）
        歌词轨用 DOM（MonetLyricsRail），AudioOverlay 用第二块 2D canvas（AudioOverlay.tsx:171）
                       ▼
        卸载/换 key：release() → 计数归零 → revokeObjectURL + 从缓存删除
```

- **音频驱动**：`audioPower` 推装饰漂移与歌词轨，底图本身**不随音频重绘**——这是关键取舍：把“昂贵的静态层”和“廉价的动态层”分开。
- **清理**：引用计数（`holders`）保证同一底图被多个宿主（播放页/OBS/预览）同时用时不会提前 revoke；`release` 在组件卸载时调用。
- **代价**：worker 与主线程之间要传封面像素/参数，`convertToBlob` 的 JPEG 0.92 是有损压缩；**待确认**：`MonetBackgroundLayer` 上还叠了一层 CSS `filter`（`checkCanvasFilterSupport`，`monetBackgroundPipeline.ts:94`）用于色调，这部分开销未测量。

---

## 4. 性能护栏（重点）

> 先给结论：Folia 的护栏是**“用户可选的保守档位 + 局部像素预算 + 生命周期回收”**，不是自动自适应系统。
> 没有基于实测 FPS 的自动降档，也没有统一的“页面不可见就停”。下面逐层拆。

### 4.1 限帧机制：全局劫持 rAF 的可选门（`src/utils/frameRateLimiter.ts`，217 行）

**暴露面**（`frameRateLimiter.ts`）：

| 项 | 值/位置 |
|---|---|
| 档位 | `VISUALIZER_FRAME_RATE_OPTIONS = [60, 90, 120]`（`:22`） |
| 存储键 | `VISUALIZER_FRAME_RATE_STORAGE_KEY = 'visualizer_frame_rate'`（`:23`） |
| 默认 | `'off'`（`parseVisualizerFrameRate`：`'off' | 'auto' | null` 都归 `'off'`，`:33-40`） |
| 容差 | `FRAME_INTERVAL_TOLERANCE_MS = 1`（`:24`） |
| 判定 | `shouldProcessFrameAtRate(ts, last, rate)`：`interval = 1000/rate - 1`，`last===0` 或 `ts-last >= interval`（`:43-54`） |
| 创建 | `createFrameRateLimitedRaf(nativeRaf, nativeCaf, initial=60)`（`:64-136`） |
| 全局安装 | `installGlobalVisualizerFrameRateLimiter(override?)`（`:187-217`） |
| 运行期改档 | `setGlobalVisualizerFrameRate(rate)`（`:140-156`），`'off'` 时 `restoreGlobalVisualizerFrameRateLimiter()`（`:172-185`） |
| 逃生通道 | `requestUncappedAnimationFrame` / `cancelUncappedAnimationFrame`（`:161-170`） |
| 安装点 | `src/index.tsx:2` import、`:23` 在应用启动时调用 |

**实现要点**（这是整个性能护栏里唯一“侵入全局”的机制）：

```ts
// src/utils/frameRateLimiter.ts:83-104（摘，语义复述）
processNativeFrame = (ts) => {
    requestId = null;
    if (!shouldProcessFrameAtRate(ts, lastProcessedTimestamp, frameRate)) {
        scheduleNext();              // 未到点：直接再排一帧原生 rAF，不执行任何回调
        return;
    }
    lastProcessedTimestamp = ts;
    const batch = callbacks; callbacks = new Map();
    batch.forEach(cb => { try { cb(ts) } catch (e) { reportAnimationFrameCallbackError(e) } });
    if (callbacks.size > 0) scheduleNext();
};
```
（实际代码在 `:64-136`；错误会被 `console.error('Error in requestAnimationFrame callback:', error)` 后 `setTimeout(() => { throw error }, 0)` 重抛，避免一个回调抛错影响同帧其他回调——`:105-112` 附近。）

安装逻辑（`:187-217`）：
1. 读 `overrideFrameRate ?? localStorage.getItem('visualizer_frame_rate')`；解析为 `'off'` 就直接恢复原生（`:193-196`）。
2. 已安装则只 `setFrameRate`（`:198-201`）。
3. 把原生 `requestAnimationFrame/cancelAnimationFrame` 存进 `window.__foliaNativeRequestAnimationFrame/__foliaNativeCancelAnimationFrame`（`:211-212`，再包一层 `nativeRaf/nativeCaf` 保证 `this` 正确，`:213-217`）。
4. 用 limiter 替换 `window.requestAnimationFrame = installedLimiter.requestAnimationFrame`（`:215-216`）。

**为什么需要 `requestUncappedAnimationFrame`**：有些库（framer-motion 在模块加载时就抓走 `requestAnimationFrame` 引用）不会经过被替换后的 `window.rAF`，或者在 cap 生效前就抓了原生函数；这个出口强制走原生（`:161-170`）。**代价**：一旦启用限帧，所有走 `window.rAF` 的消费者（Pixi ticker、three/R3F、framer-motion 的帧循环、歌词轮询）全被同一档位限制——设置项名字叫“可视化器帧率”，实际是**应用级**。

**设置 UI 与文案**（`src/components/modal/settings/pages/GraphicsPage.tsx`）：
- 开关默认开启值：`FRAME_RATE_WHEN_SWITCHED_ON = 120`（`:21`）。
- 选项：`FRAME_RATE_CHOICES = VISUALIZER_FRAME_RATE_OPTIONS.map(rate => ({ value: String(rate), label: `${rate} FPS` }))`（`:54`）。
- 结构：Toggle（`:98-103`，`frameRateLimited = visualizer.frameRate !== 'off'` 在 `:82`）→ `Reveal` 展开 Segmented（`:104-115`）。
- store：`useVisualizerSettingsStore.ts:18`（import）、`:31`（字段类型）、`:44`（方法）、`:107`（初始化读 localStorage）、`:158-163`（`handleSetVisualizerFrameRate`：写 localStorage + `setGlobalVisualizerFrameRate` + set state）。
- 文案（zh-CN）：`"visualizerFrameRate": "实验性动画帧率限制"`、`"visualizerFrameRateDesc": "限制动画帧率，可能导致意外问题"`、`"visualizerFrameRateValue": "限制档位"`（`src/i18n/locales/zh-CN.ts:2639-2644`；en 同位置同义）。
- **实测语义（本文分析）**：
  - 60 Hz 屏幕：原生帧间隔 16.7 ms；120 档间隔 `1000/120-1 = 7.33` ms、90 档 `10.11` ms、60 档 `15.67` ms。**只有 60 档在 60 Hz 屏上真正生效**，120/90 档在 60 Hz 屏上等于 off。
  - 120/144 Hz 屏：60 档会把帧率压到 ~60；120 档在 144 Hz 屏上压到 ~120。
  - 该实现按“时间戳差”而不是“跳帧计数”判定，所以掉帧后不会追赶式连刷，行为稳定。
  - `'auto'` 是历史值，现在等价 `'off'`（`:33-40`）。

### 4.2 像素预算：纹理桶吸附（`src/components/visualizer/pixi/pixiTextureBudget.ts`，113 行）

**问题陈述**（文件头注释 `:1-26` 的量化）：Pixi `TexturePool.getOptimalTexture` 对每个轴做 `nextPow2(ceil(size * resolution - 1e-6))`。默认 `textureResolution = 1.5`：

| 视口 | ×1.5 | 落到桶 | 桶面积 | 有效像素占比 |
|---|---|---|---|---|
| 781×850 | 1172×1275 | 2048×2048 = 16 MiB | 4.19 Mpx | 5.7 MiB / 16 MiB ≈ **29%** |
| 781×850 吸附到 1.2047 | 941×1024 | 1024×1024 = 4 MiB | 1.05 Mpx | ≈ **92%** |

**实测代价**（`:12-15` 注释，Intel iGPU）：窗口从 640×640 到 700×700（面积仅 +18%），凝彩常驻 GEM 628 → 822 MiB（**+31%**），因为 `1.5 × 700 = 1050` 越过了 1024，两个轴同时从 1024² 桶跳到 2048²。

**API**：
- `texturePoolAxis(cssSize, resolution)`（`:52-54`）：单轴向上取 2 的幂。
- `TEXTURE_POOL_MAX_RESOLUTION_DROP = 0.25`（`:64`）：最多允许把分辨率降 25%（即 1.5 → 1.125 为止）。
- `snapResolutionToTexturePool(cssWidth, cssHeight, resolution, maxDrop = 0.25)`（`:86-113`）：分别尝试“按宽吸附”“按高吸附”，只接受能让 bucket 面积变小的候选，两个都小时取更小者。
- 例（注释/实现）：`1030×520 @ 1.0` 按宽 `0.994`（→1024×1024）、按高 `0.985`（→1024×512），后者更小 → 选 0.985；`2000×1200 @ 1.5` 需要降到 1.024（32%，超过 maxDrop）→ **放弃吸附**，保持 1.5。

**边界与风险（本文分析）**：
- 吸附只降分辨率、不降 CSS 尺寸；`autoDensity: true`（`createTemperaPixiRuntime.ts:171`）保证 canvas 的 CSS 尺寸与 backing store 解耦，画面不会变小。
- 吸附会让采样网格与设备像素不再一一对应，**文字/细线条**可能有轻微模糊；绘光只在“图形组（柔光）”上吸附（`lumiereRuntimeTuning.ts:52-58` 注释“文字不吸附，保证清晰”），凝彩则对整块纹理吸附（待确认：凝彩是否对文字层单独处理）。
- 桶边界是**连续函数里的台阶**：分辨率从 1.5 调到 1.49 可能让某尺寸跨桶，显存瞬间翻倍/减半——这解释了为什么注释里对“窗口 640→700”这么敏感。

### 4.3 DPR 上限与 canvas 分辨率策略（逐处汇总）

| 位置 | 策略 | 行号 |
|---|---|---|
| Pixi 三模式 | `resolution` 走 `snapResolutionToTexturePool`（凝彩）；绘光再乘 `graphicsScale` 后吸附 | `createTemperaPixiRuntime.ts:165`、`lumiereRuntimeTuning.ts:52-58` |
| 绘光 | `resolveLumiereRenderResolution`：dpr 钳 [1,2]；`LUMIERE_MAX_RENDER_RESOLUTION = 2` | `lumiereRuntimeTuning.ts:39-44` |
| 镜台 | R3F `<Canvas dpr={[1,2]}>`（引擎级上限） | `VisualizerDiorama.tsx:458` |
| lattice 歌词画布 | `latticeLyricResolution = Math.min(2, Math.max(1, Math.ceil(dpr)))` | `src/components/app/lattice/lyrics/createLatticeLyricRuntime.ts:30-31` |
| 烟雾舞台 | 直接用 `window.devicePixelRatio`，**未钳**；逐帧检测尺寸变化后重设 canvas 尺寸 | `useFumeCanvasStage.ts:75-84, 98-105` |
| 烟雾文字栅格 | `clamp(dpr, 1, 2)` | `fumeCanvasText.ts:77`；`fumeLiveRaster.ts` 注释 `:38` |
| 莫奈底图 | 固定 1920×1080，不随 dpr 变 | `monetBackgroundPaint.ts:8-9` |
| OBS 浏览器源 | 覆写 `window.devicePixelRatio` 的 getter 为配置的 scale | `src/components/obs/ObsBrowserSourceApp.tsx:90-94` |
| 全局 | `useDevicePixelRatio()` 钩子（仅订阅，不强制） | `src/hooks/useMediaQuery.ts:36` |

**resize/重建策略**：
- Pixi：`autoDensity` + `resolution` 在创建时确定；窗口尺寸变化需要 `app.renderer.resize` 并重算 resolution（凝彩在 resize 时会用新尺寸重新 `snapResolutionToTexturePool`，**待确认**具体调用点是否用 `ResizeObserver` 还是每帧检查）。
- 烟雾：**每帧比较** canvas 尺寸与期望值，不一致就重设（`useFumeCanvasStage.ts:77-84`、`:98-105`）——简单但对齐到 rAF，不会在 resize 事件里抖动。
- lattice：resize 有 120 ms settle（`RESIZE_SETTLE_MS`），且运行时按 2 s 复用（`RUNTIME_REUSE_MS`）；这两项来自 lattice 歌词模块（`useLatticeLyricCanvas.ts` 系列），**待确认**：本次调研未逐行核对常量行号。
- 共同原则：**先改 canvas 尺寸、再改 CSS 尺寸、最后重设 transform/投影矩阵**；任何一步顺序错都会出现一帧拉伸。

### 4.4 reduced-motion / 静态模式 / 低画质 / 自动降档

**(a) 设置模型（`src/stores/useMotionSettingsStore.ts`）**
- 6 个可独立关闭的 surface：`MOTION_SURFACE_IDS`（`:28`）= lattice、transitionOverlay、collectionMorph、monetBackground、uiMicroMotion、settingsScroll（UI 行见 `GraphicsPage.tsx:41-47`）。
- 系统偏好查询：`SYSTEM_REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'`（`:37`）。
- 默认：所有 surface false（`:66`），`followSystemReducedMotion` 默认 false（`:85`），`systemPrefersReducedMotion` 由 `readSystemPreference()` 初始化（`:86`）。
- 解析：`resolveReducedMotion(state)` = 任一 surface 开 **或**（跟随系统 **且** 系统偏好 reduce）（`:109`）；导出成 CSS 属性/类名（`:114-120`，把命中的 surface 用空格拼成字符串）。
- **重要边界**：这些 surface **不包含可视化器本身**（除 `uiMicroMotion` 影响换样式过渡、`monetBackground` 影响莫奈背景漂移外）。`prefers-reduced-motion` 全 `src` 的 41 处命中几乎都在 `src/components/app/lattice/`（封面墙/歌词墙），可视化器 renderer 内部没有直接查询系统偏好——**待确认**是否有别的降级路径（本次未找到）。

**(b) 静态模式（`staticMode`）**：总开关在 `src/stores/useThemeSettingsStore.ts`——字段 `:52`、默认 `:66`（`static_mode`，默认 false）、切换 `:80`、跨 store 选择 `:142`。消费点（部分）：
- 换样式过渡直接取消：`VisualizerRenderer.tsx:45`；
- 烟雾相机冻结：`useFumeCanvasStage.ts:118,163`、`fumeCameraStep.ts:211`；
- 莫奈背景漂移关闭：`backgrounds/monet/MonetBackgroundLayer.tsx:160`；
- latent 背景 mesh/dithering 速度归零：`backgrounds/latent/LatentBackground.tsx:204,361,389`；
- 商籁后处理 profile 归零：`sonnetPostProcess.ts:36-41`（`staticMode` 时 `glowStrength: 0`、`contrast: 0`）；
- `backgroundStaticMode` 是**背景单独**的静态标志（与 `staticMode` 分开，见 `definition.ts` 字段与 `VisualizerBackdrop` 透传）。

**(c) 低画质**：没有全局“画质档”，只有各模式的 tuning：
- 绘光：`LUMIERE_QUALITY_PROFILES`（`lumiereRuntimeTuning.ts:32-36`）三档 full/balanced/low，`resolveLumiereGraphicsResolution`（`:52-58`）与 `resolveLumiereBloomLevelDrop`（`:67`）按档位减 bloom 级；
- 凝彩：`tuning.textureResolution`（用户可设）+ 桶吸附；
- 镜台：dpr 上限由 R3F 配置，另有粒子/雾等 tuning；
- 烟雾：文字栅格 dpr≤2。
- **没有一个“整体低配模式”** 统一拉低所有模式——这是可改进点。

**(d) 自动降档：不存在。** 全仓库没有“测 FPS → 降画质”的反馈环；`dev/perf` 是离线测量装置（§4.7），不参与运行时。隐藏窗口也不会自动降档（见 §4.5）。设置页的“实验性”标签与“可能导致意外问题”的描述，本质是承认“全局劫持 rAF”是危险开关（`zh-CN.ts:2639-2644`）。

**(e) Linux 专属兜底：`glowBlurQuantize`**。设置项 `options.glowBlurQuantize`（`GraphicsPage.tsx:35,116-126`），文档页指向 `https://folia-site.cielaniska.top/guide/chromium-fd-exhaustion`（`:18`）——这是“Chromium 在 Linux 上 blur 滤镜耗尽文件描述符导致歌词动画卡死”的修复开关，属于“排障型护栏”的典型：不是省性能，而是避免整页卡死。

### 4.5 后台 / 失焦 / 最小化：能暂停，但**默认没暂停**

**Electron 侧事实**：两个窗口都关掉了后台节流：
- 远程控制窗：`electron/main.cjs:5085` `backgroundThrottling: false`（webPreferences 块 `:5080-5086`）；
- 主窗口：`electron/main.cjs:5262` `backgroundThrottling: false`（webPreferences 块 `:5257-5263`，窗口创建从 `:5195` 起）。

**后果（本文分析，重要）**：Electron 的 `backgroundThrottling: false` 不仅让定时器不降频，还会影响 Page Visibility 语义——页面在被遮挡/最小化时仍可能被当作可见、rAF 继续全速跑。这正是**壁纸模式**（窗口挂在 WorkerW 桌面层，永远“被遮挡”但仍需出画）与 OBS 源能持续工作的前提；同时也意味着“最小化就省电”不成立。**待确认**：不同 Electron/Chromium 版本下 `document.hidden` 的确切取值（本仓库没有针对此的测试），但代码注释与设置组合指向上述行为。

**代码里的可见性处理（分散、非框架级）**：
- 音频桥循环本身**假设**窗口隐藏时 rAF 不跑：`usePlaybackVisualizerBridge.ts:129` 与 `:149` 附近的注释明说“that loop does not run while the window is hidden”，并因此把 `hasAudibleSignal` 与“呼吸兜底”分开写（`:149-152`、`:188-192`）。在 `backgroundThrottling: false` 下这个假设**可能不成立**（见上），会造成隐藏时仍每帧读频谱、写 MotionValue——**待确认**实际耗电影响。
- lattice 歌词画布是唯一显式处理可见性的核心视觉模块：`visible = intersecting && !document.hidden`（`src/components/app/lattice/lyrics/useLatticeLyricCanvas.ts:59`），`visibilitychange` 监听在 `:97`，再配合 `IntersectionObserver`。
- `document.visibilityState`/`visibilitychange` 全 `src` 仅 15 处命中，均不在可视化器 renderer 内；`paramStore.ts:81-82` 在 hidden 时 flush 保存。
- **暂停的唯一正路是 `paused` prop**：播放器暂停 → 各模式自己停 ticker/循环（Pixi 模式 `setPaused`；DOM 模式停 framer 动画）。窗口可见性没有接到这个开关上。

**给 Zilux2 的启示**：WebView2 的 `CoreWebView2Controller.IsVisible` / `WindowState` / 锁屏事件是宿主可控的，**宿主应主动调用页面暂停**，而不是依赖 `backgroundThrottling` 这种 Electron 特有开关。

### 4.6 显存 / 纹理 / 对象池 / 可视化器切换的释放链

| 机制 | 作用 | 位置 |
|---|---|---|
| mount-once 运行时 | 换歌不重建 WebGL 上下文/纹理池/场景缓存 | `pixi/pixiRuntimeHost.ts:5-10,106-151` |
| 段落场景缓存 | 只保留当前段 ±1；换歌时旧场景进 retired 队列，**一帧销毁一个** | `pixiSceneCache.ts:19-38` |
| 两帧换歌状态机 | 第一帧 stage（离屏建新场景），第二帧 commit；abort 时 `discard` | `pixiSongSwap.ts:1-15` |
| Pixi 显示树工具 | `unloadPixiDisplayTree`（:12）、`setPixiDisplayTreeVisibility`（:25）、`destroyPixiDisplayTree`（:38）、`destroyPixiContainerChildren`（:51） | `pixi/pixiDisplayResources.ts` |
| 上下文预创建 | 自建 canvas + `getContext('webgl2')`，16 个 extension 按 4 ms/任务切片；abort 时 `loseContext()` | `pixi/pixiWebGLContext.ts:15-35,47-80` |
| Filter 池兼容 | `installPixiFilterPoolCompat` 修 Pixi 8 filter 池行为 | `pixi/pixiFilterPoolCompat.ts:30` |
| 程序链接预热 | `KHR_parallel_shader_compile` + 每 10 ms 检查、每次最多交接 4 ms | `pixi/pixiProgramLinks.ts:19-23` |
| 莫奈底图缓存 | `{url, holders}` 引用计数，`release()` 归零才 `revokeObjectURL` | `monetBackgroundPipeline.ts:9-11,230-249` |
| 镜台 | React 卸载 `<Canvas>` → R3F 释放 program/texture（默认 dispose） | `VisualizerDiorama.tsx` |
| 换样式过渡 | 最多同时挂两个 layer；背景与 stage layers 跨样式保留 | `README.md:249`、`VisualizerRenderer.tsx:64-72` |

**未被证实的部分（标待确认）**：
- 没有发现通用“对象池”（粒子/文字纹理复用池）；文字纹理是否有 LRU 未逐行核对。
- WebGL 上下文丢失（`webglcontextlost`）的恢复路径：只在 lattice 模块见到处理；Pixi 三模式依赖 Pixi 内部重建（Pixi 8 有 context restore 逻辑），**待确认**其在本项目配置下的实际表现。
- 换歌时“旧场景销毁”是否真的每帧一个、还是只在空闲帧：`pixiSceneCache.ts:19-38` 注释说“一帧销毁一个”，实现上由调用方在 renderFrame 里驱动（**待确认**具体驱动点）。

### 4.7 调试与测量工具链

**(a) 运行时可观测**
- `src/services/debug/`：`installDebugModule()`（`src/index.tsx:4` 调用）、`installMemorySampleFeed()`（`:5` 调用）；`memorySamples.ts` 以 2 s 间隔采样、保留 `HISTORY = 600` 点（约 20 分钟），字段含 `totalWorkingSetMB / totalPrivateMB / rendererPrivateMB / rendererHeapUsedMB / cpuPercent / rendererFdCount / gpuFdCount`；数据源是主进程 `electron/debug/memoryMonitor.cjs`，界面在 `src/components/debug/MemoryMonitorWindow.tsx` 与设置页 `DeveloperPage.tsx`。
- 主进程内存监控：`electron/debug/memoryMonitor.cjs`（Windows 才有 `privateBytes`，其他平台为 null）。
- 控制台日志约定：行首 `[模块名]`（`AGENTS.md`），例如 `[Tempera] song handover failed`（`pixiRuntimeHost.ts:99`）、`[BeatMeter]`（`analysis/README.md` 提到的拍点诊断行）。

**(b) 帧级测量装置（`dev/perf/`，README 616 行，Windows only）**
- 目标：“每个歌词样式/背景每帧花多少”，只测量、不改视觉代码（`dev/perf/README.md:1-5`）。
- 一次全量 baseline 约 **83 分钟**：`laptop` 与 `old` 两套 profile 全场景 + `host` 核心集 + 最重的十个场景在显卡上再跑 2560×1440@1.5 + noise check + truth check（`README.md:29-40`）。
- 输出：`claude-notes/perf/data/baseline/` 与 `claude-notes/perf/画面底数.md`（`README.md:38-40`）；中途结果在 `data/baseline.partial/`。
- 场景命名：`style-<id>`、`songchange-<id>`，由 `dev/perf/scenarios.mjs` 的 `STYLES` 列表生成（`visualizer/README.md:49-55` 的新增样式第 5 步）。
- 单次运行锁：`dev/perf/lock.mjs`（系统临时目录一个文件，跨 worktree 生效），避免两个测量抢 CPU/GPU（`README.md:50-56`）。
- noise/truth check：`--noise`（两个场景各 5 次，测 run-to-run 方差）、`--truth`（同一场景加 4 ms/帧，验证装置能测出已知差异）（`README.md:45-47`）。
- 整应用工具：`dev/perf/app/`（启动耗时、换歌、切页、内存），有自己的 README（`README.md:7-13`）。

**(c) 长跑内存探针（`test/manual/visualizer-memory-probe.mjs`，116 行）**
- 用 Playwright 起 Chromium，**按进程采工作集**并按 `--type=` 分类为 browser / gpu-process / renderer（依赖 `chromiumProcessMemory.mjs`）。
- 理由（文件头注释 `:8-14`）：JS 堆看不到 canvas backing store、合成层与 GPU 资源；按进程分只能缩小范围，不能单独证明分配源。
- 默认参数：`vis=pendolo`、`seconds=150`、`interval=15`、`port=4173`、`dpr=2`、`1920x1080`、**headed 默认 true**；注释明确“无头模式没有真正的 GPU 合成，gpu-process 一栏基本没意义”。
- 用法：先另开终端 `npm run dev -- --port 4173`，再 `npm run manual:visualizer-memory -- --vis pendolo --seconds 150`；支持 `--query "&heavy=1&switch=5"` 注入宿主参数。
- 同族脚本：`test/manual/lattice-cover-memory.mjs`、`test/manual/bravais-perf-probe.mjs`（对应 `npm run manual:*`，见 `package.json` 的 `manual:visualizer-memory` / `manual:lattice-cover-memory` / `manual:bravais-perf`）。

**(d) Playwright 渲染探针（`playwright.probe.config.ts`，22 行）**
- 只跑 `**/*.probe.ts`（`test/ui` 下），**刻意排除在 `npm run test:ui` 之外**；`workers: 1` + `fullyParallel: false`，因为“渲染次数只有在机器空闲时才可归因”（`:1-16` 注释）。
- 必须自定义 project：base config 拆成 e2e/components 后，顶层 `testMatch` 对 project 不生效（`:10-14` 注释）——这是个真实的配置陷阱。
- 命令：`npm run test:render`（`playwright.probe.config.ts` 注释与 package.json）。

**(e) 运行时性能守护 skill**：项目 `AGENTS.md` 要求高频动画路径遵守 `frontend-runtime-guardrails` skill：连续时间用 MotionValue/ref/CSS/canvas/Pixi draw loop，**不要每帧写 React state/store**；React state 只装离散变化（当前行、播放状态、可见段落）；高频 rAF/`useMotionValueEvent`/`ResizeObserver` 必须有相等保护与 cleanup；cache key 必须含歌词内容、主题、最终字重、窗口尺寸、mode tuning（`visualizer/README.md:251-257`）。这相当于把“性能约定”写成了文档规范，而不是只靠工具。

---

## 5. Electron / GPU / 窗口层

### 5.1 运行时栈

| 项 | 值 | 位置 |
|---|---|---|
| 版本 | `0.7.21` | `package.json:11` |
| Electron | `^43.7.5`（Chromium 版本随 Electron 43 线，具体小版本由 lockfile 决定，**待确认**） | `package.json:275` |
| 主进程入口 | `electron/main.cjs`（约 6000 行单文件是历史包袱，模块化在 `electron/modSystem/`、`electron/wallpaper/`、`electron/debug/`） | `package.json` 的 `main` 字段（**待确认**行号） |
| 渲染进程入口 | `src/index.tsx`（`:4` 装 debug 模块、`:5` 装内存采样、`:23` 装全局限帧） | `src/index.tsx:2-23` |

### 5.2 窗口矩阵（性能相关字段全表）

| 字段 | 主窗口 / 壁纸窗口 | 遥控窗口（remote control） |
|---|---|---|
| 创建位置 | `electron/main.cjs:5195` 起 | `electron/main.cjs:5055` 起 |
| `frame` | `false`（`main.cjs:5233`） | `false`（`main.cjs:5067`） |
| `transparent` | `useTransparentWindow`（`:5234`，由设置/主题决定） | `true`（`:5068`） |
| `backgroundColor` | — | `'#00000000'` |
| 平台材质 | macOS `vibrancy: 'fullscreen-ui'`；Windows `backgroundMaterial: 'acrylic'`（**仅 nativeBlur 且非透明时**，`main.cjs:5235-5238`） | — |
| `thickFrame` | Windows 且 **非透明且非壁纸** 才有 | — |
| `resizable/movable` | 壁纸模式下 `false`（`:5251`、`:5255`） | — |
| `alwaysOnTop` | 壁纸模式 `false`（`:5247`） | — |
| `skipTaskbar`/`type` | Linux X11 下 `type:'desktop'`（**待确认**行号） | — |
| **`backgroundThrottling`** | **`false`（`:5262`）** | **`false`（`:5085`）** |
| preload / 安全 | `contextIsolation: true`、`nodeIntegration: false`、`electron/preload.cjs`（`AGENTS.md` 约束） | 同 |

**`backgroundThrottling: false` 的代价与收益（本文分析）**
- 收益：壁纸窗口被 WorkerW 压在桌面最底层（永远不是前台窗口）、OBS 浏览器源在无用户交互时，页面仍要稳定出画；Chromium 默认会对“不可见/被遮挡”页面降频 rAF 甚至暂停，这在壁纸/OBS 场景是致命的。
- 代价：① 最小化到任务栏后页面仍全速渲染；② **Page Visibility API 语义被改变**，任何“hidden 就暂停”的代码路径都不能被信任（§4.5 的 `usePlaybackVisualizerBridge.ts:129` 注释就建立在默认节流语义上，属于潜在错误假设，**待确认**实际影响）；③ 每个窗口一个合成器 + 一条渲染管线，主窗 + 遥控窗同时开就是两份。
- 另一个必要设置是 `movable:false` 等窗口能力收敛（`docs/wallpaper-mode.md` 第 3 节“渲染端与命令门控”），壁纸模式下渲染端不显示自定义标题栏、命令面板隐藏 fullscreen/always-on-top 等命令，主进程拒绝 minimize/maximize/fullscreen/close/always-on-top 的 IPC。

### 5.3 GPU / ANGLE / 软件渲染策略（`electron/main.cjs`）

**Linux（`:167-219`）**，按 `linuxGraphicsMode` 三档 + 独立 Vulkan 关闭：
- 公共：`disable-vulkan`（`:170`）、`disable-features=Vulkan`（`:171`）、`ozone-platform-hint=auto`（`:172`）、`log-level=3`（`:173`）。
- `software`：`app.disableHardwareAcceleration()`（`:177`，注释：最安全的硬回退，但通常更慢）。
- `swiftshader`：`use-gl=angle`（`:182`）+ `use-angle=swiftshader`（`:183`）+ `enable-unsafe-swiftshader`（`:184`）；注释说明“AppImage 是唯一观察到 blur/opacity 破损 + GPU 崩溃的运行时”。
- 其余：`enable-features=WaylandWindowDecorations`（`:186`）。
- 档位来源：环境变量 `FOLIA_LINUX_GRAPHICS_MODE`，dev 脚本 `dev:electron:dist:swiftshader` / `:dist:software`（`package.json:53-54`）+ `ELECTRON_LINUX_PACKAGED_GRAPHICS=true`（`:51`）。

**macOS**：仅 x64 加 `ignore-gpu-blocklist`（`:217`）、`use-angle=gl`（`:218`）、`enable-gpu-rasterization`（`:219`），理由注释是 Intel Mac + AMD Retina 的卡顿；arm64 不动（Metal 默认路径已好）。

**Windows**：主进程**没有**设置 ANGLE/GPU 开关；Windows 的优化点在窗口层：
- 透明窗口用 `transparent: true` + `backgroundColor: '#00000000'`，有原生 blur 时改用 `backgroundMaterial: 'acrylic'`（`:5235-5238`）——acrylic 由 DWM 合成，等于把“模糊”从 WebGL/CSS 挪到系统合成器；
- 壁纸模式经 Rust helper `SetParent` 到 WorkerW（见 §5.6）。

**共享 feature 修复**：`appendChromiumFeature('ReleaseVideoSourceProviderIfNotInUse')`（`main.cjs:205-212`，仅 win32/darwin）——修 crbug 377749384：`enumerateDevices` 后视频采集 utility 进程与隐私指示器不释放；注释点名 renderer 侧触发点是 `src/hooks/useAudioOutputDevices.ts` 的 `devicechange` 订阅 + 空闲计时器。**这条对 Zilux2 有直接参考价值**：WebView2 里枚举音频输出设备后不释放，会留下一个隐藏的采集进程。

### 5.4 电源与帧率相关主进程能力

| 能力 | 实现 | 位置 |
|---|---|---|
| 阻止显示器休眠 | `createDisplaySleepBlocker(powerSaveBlocker)`：`setActive(true)` → `powerSaveBlocker.start('prevent-display-sleep')`；`stop()` 幂等；`isStarted` 校验后再 stop | `electron/displaySleepBlocker.cjs:2-22` |
| 接入点 | 实例化 `main.cjs:2496`；播放状态变化时 `setActive(Boolean(active))`（`main.cjs:5984`）；退出/清理时 `stop()`（`:5433`、`:5902`） | 同上 |
| 视频导出帧率 | `electron/modSystem/exportService.cjs:21` `maxFps: 60`；`:69` clamp；注释 `:290`：**“No setFrameRate here: capping the compositor also caps RAF”**——即“限制合成器帧率会连带限制页面 rAF”，所以导出只限采集帧率 | `electron/modSystem/exportService.cjs` |
| 壁纸鼠标注入 | 主进程用 `webContents.sendInputEvent` 注入（不走窗口消息，避免 TrackMouseEvent 回发 WM_MOUSELEAVE）；helper 侧 move 两条至少隔 4 ms、Win11 后台 Raw Input 实测上限 **125 Hz**（`docs/wallpaper-mode.md:86`） | 见 §5.6 |

**没有**“主进程通知渲染进程限帧”的 IPC：帧率上限完全由渲染进程的 `frameRateLimiter` 本地读取 localStorage 决定（`src/utils/frameRateLimiter.ts:187-217`），主进程不参与。导出服务是唯一在采集侧限帧的模块。

### 5.5 透明窗口 / 壁纸模式的合成代价

- **透明窗口**：`transparent: true` 时 Chromium 走逐窗口 alpha 合成，WebGL 上下文必须带 alpha（见 §6.6：Pixi 的 `backgroundAlpha < 1` 会推 alpha 上下文）；Windows 上 `transparent` 与 `thickFrame` 互斥（`main.cjs:5239`），`transparent:false` 时才有原生边框。
- **壁纸模式**：窗口被 `SetParent` 到 WorkerW 之后：
  - 逐帧渲染由页面的 rAF 驱动，**没有**“桌面被完全遮挡就跳过绘制”的优化（Explorer 不知道内容没变）；
  - 透明只活过 Win11 24H2+ raised 桌面；classic 桌面（Win10/早期 Win11）一律按不透明构建，并直接拒绝开透明（`wallpaper-transparent-refused` 事件 + 渲染端 toast，`docs/wallpaper-mode.md:109`）；
  - 每屏一个 WorkerW（24H2），单窗口只铺一块屏；换屏/换显示器要**重建窗口**而不是 `setBounds`（`docs/wallpaper-mode.md:104-105`）。
- **OBS 浏览器源**：`ObsBrowserSourceApp.tsx:90-94` 直接覆写 `window.devicePixelRatio` 的 getter 为配置的 scale，等于把“像素预算”交给 OBS 场景配置；同文件还有 OBS 专用的“无界面 chrome”路径（详见 `visualizer/README.md:231-247` 的 host surfaces 列表）。

### 5.6 壁纸模式关键数字（`docs/wallpaper-mode.md`，文档声称 + 代码印证）

| 参数 | 值 | 出处 |
|---|---|---|
| helper 心跳 | 5 s；看门狗 5 s/15 s 超时 | `docs/wallpaper-mode.md:86,100` |
| 重挂退避 | 2 s | `:100` |
| 降级阈值 | 连续 3 次失败 → 清 `wallpaper_mode`、还原普通窗口（不重启进程） | `:100` |
| 健康清零 | 连续健康 60 s 清失败计数（持久键 `wallpaper_windows_failure_count`） | `:100` |
| 目标屏匹配 | 宿主 WorkerW 与目标屏覆盖率 ≥80% | `:104` |
| 鼠标 move 节流 | 两条至少隔 4 ms；被压下的末位置由 16 ms 定时器补发；后台上限 125 Hz | `:86` |
| 透明可行性 | `WS_EX_LAYERED` 只在 raised（24H2+）桌面上活过 `SetParent`；classic 下重挂即黑屏 | `:109` |
| 退出清理 | helper `detach()` 而非 kill（否则桌面残留最后一帧）；最后 `refresh_desktop_wallpaper` 重刷 | `:110` |
| 换屏 | 不是挪窗口，是整窗重建后重新 attach | `:105` |
| 多屏 | 只建一块壁纸窗口，其他屏保持系统壁纸 | `:119-127` 已知局限 |
| 构建约束 | 前端必须在 `ELECTRON=true` 下构建（`base: './'`），否则 `file://` 404 | `:113-118` |

**已知缺陷（文档自述，`docs/wallpaper-mode.md:119-127`）**：键盘/输入法不转发；z 序只能“最后调整者在上”；只铺一块屏；异缩放多屏可能落错屏（可接受偏差）。

### 5.7 打包与平台差异（`package.json` 的 `build` 段，`:65` 起）

- **win**：`target: ['nsis']`（`:206-208` 附近），`extraResources` 把 `build/folia-wallpaper-helper.exe` 放到资源根（`filter` 只留这一个文件，`:180-190`）；`oneClick:false`、可改安装目录、安装器语言 en_US/zh_CN/id。
- **linux**：`target: tar.gz/deb/rpm`，`executableName: folia-major`，`desktop.entry.StartupWMClass`（`:206-224` 附近）；`extraResources` 放 `windowtolayer` + `windowtolayer-COPYING`（`:144-151`）。
- **mac**：`dmg` + `zip`（x64/arm64），`extraResources` 放 koffi FFI 的 darwin 二进制（`:153-170`）。
- **通用 `extraResources`**（`:99-146`）：`build/ffmpeg/${os}-${arch}` → `ffmpeg-audio`；`build/mnn/${os}-${arch}` → `mnn`（只筛 `*folia_mnn.*`）；`models/` → `models`，只带 `beat_this-wgsl.bin` 与 `htdemucs-wgsl.bin`（**这就是 §1.5 WebGPU 分析的模型文件，随包分发**）。
- **`asarUnpack`**（`:95-98`）：`@koromix/koffi-*/**/*.node`、`@lox-audioserver/node-librespot/prebuilds/**/*.node`（原生模块必须解包）。
- **`electronLanguages`**：`en-US/zh-CN/id`（`:68-72`）——少带语言包是安装体积优化。
- **构建链**：`vite build` 必须在 `ELECTRON=true` 下（`package.json:55-56` 的 `build:electron`），然后 `npm run build:windowtolayer`（`packaging/linux/build-windowtolayer.mjs`，`:57`）与 `npm run build:wallpaper-helper`（`packaging/windows/build-wallpaper-helper.mjs`，`:58`）。

### 5.8 Electron → WebView2 / WPF 宿主的对应关系（给 Zilux2 的迁移表）

| Folia（Electron） | Zilux2（WPF + WebView2）应如何做 |
|---|---|
| `backgroundThrottling:false` 保持壁纸/OBS 出画 | WebView2 无同义开关；用 `CoreWebView2Controller.IsVisible` + `WindowState` + `SessionEnding` 主动控制渲染；桌面层挂在 WorkerW 时窗口始终“可见”，宿主应保证不触发 `IsVisible=false` |
| `frameRateLimiter` 劫持 rAF | 可以保留同款前端方案；更稳的是宿主提供目标帧率（VSync/显示器刷新率、省电模式），前端只做“上限 = min(用户值, 宿主值)”（见 §7） |
| GPU 开关（`use-gl`/`use-angle`/`disableHardwareAcceleration`） | WebView2 可用 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 传同类 flag（`--use-angle=d3d11` / `--disable-gpu`），但**必须**在失败时降级到软件合成并提示；Folia 的 Linux 三档（auto/swiftshader/software）就是模板 |
| 透明窗口 + acrylic | WPF 窗口 `AllowsTransparency`/`WindowChrome` 或 Win11 Acrylic（`SystemBackdrop`）；注意 WebView2 在透明 WPF 窗口上的 DPI/合成坑（**待验证**） |
| 壁纸模式 helper（Rust SetParent WorkerW） | 宿主本身就是原生进程，直接 P/Invoke `SetParent` + `FindWindow("Progman")` + 0x052C 探测，比 Electron 简单一个数量级——但 24H2 raised / classic 双路径、透明限制、Explorer 重启重挂这些坑**照旧存在** |
| `displaySleepBlocker` | WPF 宿主直接用 `SetThreadExecutionState(ES_DISPLAY_REQUIRED)` 或 `PowerCreateRequest` |
| 导出 60fps 采集 | 宿主用 Media Foundation / VLC 解码链，帧率在采集端限，不碰合成本身 |

---

## 6. 着色器与渲染管线

### 6.1 着色器组织：**没有 .glsl 文件，全部内联在 TS 模板字符串里**

这是本项目最显著的工程取舍：**全仓库没有 `.glsl/.vert/.frag` 文件**（`find` 结果为空）；着色器以 `` const fragment = `...` `` 的形式和 TypeScript 逻辑同文件，共 4 类：

| 类别 | 代表文件 | 形态 |
|---|---|---|
| Pixi 8 自定义 Filter 的片元着色器 | `src/components/visualizer/sonnet/sonnetPrintFilters.ts`（128 行，RGB shift / halftone / ordered dither / vignette 四段）、`sonnetLensFilter.ts`（92 行）、`sonnetPostProcess.ts`（154 行）、`lumiere/light/bloomFilter.ts`（243 行） | 顶点着色器**全部复用** `src/components/visualizer/pixiFilterVertex.ts`（21 行，`PIXI_FILTER_VERTEX`）；片元各自内联 |
| Pixi 8 Mesh 的自定义 program | `lumiere/light/lightFieldShader.ts`（438 行，vertex + fragment 都在文件里） | 自带 `in vec2 aPosition`、`uniform mat3 uProjectionMatrix` 等 Pixi Mesh 契约（`:22-30`） |
| 手写 WebGL（twgl） | `backgrounds/sora/SoraBackground.tsx`（`gl_PointSize`、`u_resolution`、`u_time`，`:26-27,64-65`；`` twgl.getContext(canvas, { alpha:false, depth:false, antialias:false }) `` `:135`） | GLSL ES 100 风格，`PARTICLE_COUNT = 150`（`:22`） |
| three.js 的 ShaderMaterial | `diorama/dioramaParticleShaders.ts`（`uGlowPass`、`uRippleSource[RIPPLE_COUNT]`、`uRippleShape` 等，`:66-82`） | GLSL ES 300 风格（three 注入 `#version`/precision） |

**判断**：这不是“没有着色器组织”，而是**统一约定为“TS 即着色器宿主”**——
- 每个 filter/shader 与它的 uniform 更新、生命周期、`dispose` 放在一起，改一处不用跨目录；
- 共享顶点着色器集中在 `pixiFilterVertex.ts`，避免 4 份顶点代码漂移；
- 代价：没有语法高亮/预处理/`#include`，重复的 GLSL 片段（噪声、模糊核）靠人工复制；且**版本升级时无法整体迁移**。

### 6.2 Pixi 8 管线接入（`FilterSystem` / `RenderSurface` / `UniformGroup`）

**自定义 Filter 的标准骨架**（以 `bloomFilter.ts` 为例）：
```ts
// 关键行号来自 lumiere/light/bloomFilter.ts
const downUniforms = new UniformGroup({ uParams: { value: new Float32Array(4), type: 'vec4<f32>' } });  // :130
// 每帧在 run() 里写 uniform（不重建对象）：
const params = downUniforms.uniforms.uParams as Float32Array;   // :194
params[0] = threshold;                                           // :195
```
- `uParams = (threshold, knee, prefilter, 0)`，片元里做“软膝”亮部提取（`:40-46`）：`soft = clamp(br - threshold + knee, 0, 2knee)`，`contrib = max(soft, br-threshold)/max(br,1e-4)`。
- 降采样链：每级半分辨率 `applyFilter`（Pixi 按逻辑尺寸铺满输出，天然缩放）；上采样时用同级纹理做 dual filter 叠加（`:211` `mapFor(...)` 换算 UV）；最后与原图相加。
- 层级数由 `Math.max(1, Math.min(8 + LUMIERE_NEUTRAL_OFFSET, Math.round(levels)))`（`:188`）——**注意 `LUMIERE_NEUTRAL_OFFSET` 恒等于 0**（见 §6.5 的“恒零指纹”）。

**着色器预热**（`pixi/pixiProgramLinks.ts:19-23`）：`KHR_parallel_shader_compile` 扩展 + `LOOK_EVERY_MS = 10`（每 10 ms 检查一次链接状态）、`HAND_OVER_MS = 4`（每次检查最多占用 4 ms 就交还主线程）。目的是把“首帧编译卡顿”摊平到加载期，避免切换瞬间掉帧。

**上下文预创建**（`pixi/pixiWebGLContext.ts:47-80`）：自己 `new canvas` + `getContext('webgl2', {...})`，预开 16 个扩展（`:15-33`），同样按 4 ms/任务切片。注释给出的动机是“四慢核上一次性开扩展会卡主线程 60–80 ms”。

### 6.3 uniform / 纹理管理：**“热键/冷键”分层**

绘光的 tuning 把 uniform 明确分成两组（`lumiereRuntimeTuning.ts`）：
- `LUMIERE_LIVE_SCENE_KEYS`（每帧现读，不触发重建）：`lightIntensity`、`audioResponse`、`fogDensity`、`darkField`、`unlitOpacity`、`fogOctaves`、`hideTrails`；
- `LUMIERE_COMPILE_KEYS = ['seamlessTransitions']`（改它要重新编译 program，但不重建 WebGL 上下文）。
这套“每帧 uniform vs 重编译”的边界，是 WebGL 前端最容易被忽略的性能点：**凡是能写成 uniform 的，就绝不改 shader 源码**。

其它 uniform 模式：
- 镜台粒子（`dioramaParticleShaders.ts:66-82`）：`uTime`、`uCorridor`(0=编队云，1=走廊隧道)、`uAmplitude`（位移是“该 primitive 自身半径的分数”）、`uMaxSwell`（归一化用）、`uWaveNumberMax`（该 buffer 点阵在不产生 aliasing 前提下的最细波数）、`uDetail`（0..1 持续高频能量 → 只在已有波峰上加细节）、`uRippleSource[RIPPLE_COUNT]`（xyz=原点, w=出生时间）、`uRippleShape[RIPPLE_COUNT]`（x=强度, y=速度, z=包络宽度, w=波数）、`uOffsetGain`（整体摇摆，mid 能量驱动）、`uFlow`、`uFormation`（1=成形, 0=散开，换歌溶解）、`uScatter`。
- 手写 WebGL 背景（`SoraBackground.tsx:26-27`）：只有 `u_resolution`、`u_time` 两个 uniform，粒子位置在顶点着色器里用 `fract(x_rand + u_time * speed)` 解析式计算，**没有任何逐帧 CPU 上传**（`:53-67`）——150 个点的 `gl_PointSize` 也全在 GPU 算（`:64-65`）。这是“最小 CPU 参与”的范式。

### 6.4 后处理链

**商籁（sonnet）的三层后处理**（`sonnetPostProcess.ts`）：
1. **profile 生成**（`resolveSonnetPostProcessProfile`）：`staticMode` 时全 0（`:36-41`）；否则 `glowStrength = 2.8 + motion * 1.8`、`glowAlpha = min(0.62, 0.28 + motion * 0.12)`、`noise = grain * 0.35`（注释：压低噪声保证文字清晰）、`contrast = postProcessContrast * 0.5`（Pixi 的 contrast 是加法量，0.5 才是 1.5× 矩阵）、`lensDistortion/lensDispersion` 由开关控制、`printEffects` 四个 0..1 滑杆（rgbShift/halftone/vignette/dither）。
2. **glow 层**（`:71-87`）：单独一个 `Container` 先 `blur` 再设 `alpha = glowAlpha`，`filters.push(blur)`；**发光是“复制一层模糊再叠”而不是多 pass 累加**。
3. **主滤镜组**（`:105-141`）：lens → noise → ColorMatrix contrast（默认关，`:125-131` 注释“contrast 默认 0”）→ printFilters（纯静态参数，无 uniform，见 `sonnetPrintFilters.ts:7-10`）。
- `filters.length > 0` 才挂 `container.filters`（`:149-150`），空数组时彻底不建 filter 链。

**绘光（lumiere）的 bloom**：挂在场景自己的子容器上（图形组、文字组），**不作用于共享背景层与素材层**（`bloomFilter.ts:10-14`）；亮部提取 → 逐级半分辨率降采样 → 逐级上采样叠加 → 与原图相加；画质档降低 `maxFogOctaves`/`graphicsScale`/bloom 级数（`lumiereRuntimeTuning.ts:32-36`、`:67`）。

**凝彩（tempera）**：`useBackBuffer:true` 让歌词层的 difference filter 有底图可混（`createTemperaPixiRuntime.ts` 注释：filter 声明 `blendRequired` 时没有 back buffer 整个 filter 栈会被跳过）；带后处理时 `antialias` 自动关（`antialias: !postProcessEnabled`），因为 4× MSAA 的 back buffer 在这个尺寸下要多 ~70 MB 显存。

### 6.5 频谱驱动的三种典型模式

| 模式 | 做法 | 例子 |
|---|---|---|
| ① 每帧 uniform 直读 band | 音频桥把 `bass/lowMid/mid/vocal/treble` 写进 MotionValue，渲染循环取当前值写 uniform/几何 | 镜台 `uDetail`（treble）、`uOffsetGain`（mid）（`dioramaParticleShaders.ts:73,79`）；`usePlaybackVisualizerBridge.ts:170-186` 的 `process(value, boost)` 归一化 |
| ② 事件触发 + 自主衰减（“spawn source”） | 音频只**触发**一次脉冲源，之后动画由 `uTime` 自行演进，不依赖当帧 band 值 | 镜台 ripple packet：`uRippleSource`（出生时间）+ `uRippleShape`（强度/速度/包络宽度/波数），Gaussian 包络内 `sin`（`dioramaParticleShaders.ts:22-31` 注释明确“音频从不直接形变几何”） |
| ③ 离散事件 | 拍点/鼓点 → 一次性视觉动作（推镜、涟漪、鼓面振动） | `services/beatFx/` + `beatClockTargets.ts` 的 `visualizerWantsBeats`/`visualizerWantsDrumHits` 按需启动 beat_this / htdemucs（README:110-128） |

**数据流闭环**（像素级）：
```
<video>/<audio> → AnalyserNode(fftSize 2048, smoothing 0.6)
  → getByteFrequencyData(Uint8Array)
  → getEnergy(minHz,maxHz)（bin = floor(hz/21.5)）
  → process(v, boost) = (v/255)^boost * 255
  → motionSignals.audioBands.{bass,lowMid,mid,vocal,treble,spectrum} + audioPower
  → 各模式 RAF / Pixi ticker / R3F useFrame 读 MotionValue.get()
  → uniform 写入 → GPU
```
**关键细节**：`spectrum` 是 `motionValue(new Uint8Array(0))`（`motionSignals.ts:52`）——每帧**复用同一个数组**还是新建需看桥实现（`usePlaybackVisualizerBridge.ts:156` 每帧 `new Uint8Array`，是可见的 GC 压力点，**待优化项**）。无音频时桥用“呼吸”兜底：`breath = (sin(Date.now()/2000)+1)*20`（`:188-192`），让视觉不至于死掉——这是很值得抄的“空信号处理”。

### 6.6 着色器/管线侧的显存与像素成本清单

| 成本源 | 量化（代码里能找到的） | 位置 |
|---|---|---|
| Pixi 纹理池幂次对齐 | 视口×resolution 向上取 2 的幂，785×850@1.5 白扔 71% | `pixiTextureBudget.ts:1-26` |
| MSAA back buffer | 该尺寸下 4× sample ≈ **70 MB** | `createTemperaPixiRuntime.ts` 注释 |
| bloom mip 链 | 每级半分辨率，级数 1..8（默认由 tuning 给） | `bloomFilter.ts:188` |
| 透明合成 | 全屏 alpha 混合 + 系统合成器一次拷贝 | `main.cjs:5234` + Pixi `backgroundAlpha` |
| 背景视频层 | `<video>` 解码 → 纹理上传（每帧一次 `texImage2D` 等价） | `VisualizerBackdrop.tsx`、`videoLayer/` |
| 后处理全屏 pass | 商籁最多 blur + lens + noise + cm + 4 个 print ≈ 8 个全屏 pass | `sonnetPostProcess.ts:71-141` |

### 6.7 移植到 WebView2 / WebGL2 的判断

- **可直接用（Chromium 同源）**：WebGL2、Pixi 8、three/R3F、`KHR_parallel_shader_compile`、`requestVideoFrameCallback`（WebView2 支持，Folia 用来做视频层取帧，**具体文件/行号待确认**）。
- **要留意的差异**：① WebView2 的 GPU 进程由 Edge runtime 托管，`--use-angle` 等 flag 要通过 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 在**创建环境时**传入；② 集成显卡/低配笔记本上 bloom + 8 个全屏 pass 是主要瓶颈，Folia 的“画质档 + 桶吸附 + dpr≤2”三件套应照搬；③ WebGPU（`beat_this-wgsl.bin`/`htdemucs-wgsl.bin`）在旧 Windows 10 机器上可能不可用，必须有 WASM/JS 回退路径（Folia 有 `modelAvailability.ts`，**待确认**回退实现）。
- **AGPL 边界**：§6.1–§6.5 的所有实现细节只能作为设计参考**重写**，不可复制着色器源码（连 `PIXI_FILTER_VERTEX` 这种 21 行也要重写，因为它是表达式而非思想）。

### 6.8 着色器/管线待确认项

1. `LUMIERE_NEUTRAL_OFFSET` 恒零表达式的真实用途（版权指纹？混淆？见下）。
2. `pixiFilterVertex.ts` 之外是否还有未发现的内联 shader（本次 grep 只覆盖 `visualizer/` 与 4 个文件，`backgrounds/` 下还有 latent/nomand 等可能内联但未逐一确认）。
3. Pixi context lost 的恢复路径是否被配置（`preserveDrawingBuffer:false` 时默认无恢复）。
4. `requestVideoFrameCallback` 的实际使用点（视频层是否用它替代 rAF 取帧）。
5. 商籁 `noise` filter 的 seed 是否每帧变（影响缓存/稳定性）。

> **关于 `LUMIERE_NEUTRAL_OFFSET`（客观描述，不揣测动机）**：绘光模块里至少 5 个文件各定义了一个同名常量，形如
> ```ts
> const lumiereScaleMask = globalThis.devicePixelRatio | 0;
> const LUMIERE_NEUTRAL_OFFSET = ((102 ^ lumiereScaleMask) + Math.imul(111 ^ lumiereScaleMask, 108 ^ lumiereScaleMask))
>     - ((102 ^ lumiereScaleMask) + Math.imul(111 ^ lumiereScaleMask, 108 ^ lumiereScaleMask));  // bloomFilter.ts:6-7
> ```
> 数学上恒等于 0，但每处使用的异或/乘数不同（`catalog.ts:16`、`color.ts:6`、`credits.ts:21`、`bloomFilter.ts:7`、`lightFieldShader.ts:7` 等），并与 `devicePixelRatio` 绑定。用途**待确认**；从工程角度它不改变行为，属于“零成本水印/防抄袭指纹”的常见手法（若被复制走且改动了掩码，常量不再为 0，画面/动画参数会偏移）。

---

## 7. 可借鉴清单（P0/P1/P2）+ WebView2 迁移方案

> **AGPL-3.0 边界（先声明）**：Folia 是 AGPL-3.0（`package.json` 许可证字段、仓库 LICENSE）。可以学**架构、算法思路、参数经验、测量方法、文档里写明的坑**；**不能**复制源码、着色器字符串、注释、常量表到 Zilux2（包括“只有 21 行”的公共顶点着色器、`snapResolutionToTexturePool` 的函数体）。建议做法：读 Folia → 写成“行为规格”（输入/输出/边界/参数）→ 由 Zilux2 侧按规格独立实现 → 在提交信息或设计文档里记录“规格来源 Folia v0.7.21，clean-room 重写”。下表的“借鉴方式”一律指这种重写，不再逐条重复。

### 7.1 14 个可视化器的技术路线 × WebView2 友好度（Zilux2 选型依据）

| # | 模式 | 渲染技术 | WebView2 友好度 | 迁移成本 | 判断 |
|---|---|---|---|---|---|
| 1 | 商籁 sonnet | Pixi 8（WebGL2）+ 后处理滤镜链 | ★★★★ | 中 | WebGL2 可用；8 个全屏 pass 在 iGPU 上要降档 |
| 2 | 凝彩 tempera | Pixi 8 + 纹理池吸附 + difference filter | ★★★★ | 中 | 依赖 `TexturePool` 桶行为，需按规格重写像素预算层 |
| 3 | 绘光 lumiere | Pixi 8 自定义 Mesh shader + 自写 bloom | ★★★☆ | 中高 | 光场 shader 438 行是重写工作量最大的一块 |
| 4 | 流光 classic | DOM + framer-motion + 逐字发光 | ★★★★★ | 低 | 无 GPU 依赖，最适合先做 |
| 5 | Cadenza | framer-motion + 自有 RAF 绘制 | ★★★★★ | 低 | 纯 2D |
| 6 | 云阶 partita | framer-motion + GlowWord | ★★★★★ | 低 | 纯 2D |
| 7 | 浮名 fume | Canvas2D 相机步进 + 文字栅格 | ★★★★☆ | 低中 | 每帧尺寸检测逻辑可直接沿用思路 |
| 8 | 倾诉 tilt | framer-motion + pretext 排版测量 | ★★★★☆ | 中 | pretext 是外部库，替换成本取决于 Zilux2 排版栈 |
| 9 | 回环 claddagh | framer-motion + SVG/环形轨道 | ★★★★★ | 低 | 纯 2D |
| 10 | 莫奈 monet | OffscreenCanvas Worker 画底图 + DOM 立绘 | ★★★★☆ | 中 | Worker + OffscreenCanvas WebView2 支持（需确认 Edge 版本） |
| 11 | Pendolo | Clockwork Canvas2D + 另有一条 WebGL 路径 | ★★★★ | 中 | 双后端是复杂点；WebGL2 可用 |
| 12 | Cappella | DOM 消息气泡 + emoji/头像 | ★★★★★ | 低 | 纯 2D |
| 13 | 镜台 diorama | three.js + @react-three/fiber | ★★★☆ | 高 | 依赖重（README 称 eager 会拉 183 个模块含 three.js）；低配笔记本风险最高 |
| 14 | 静止 still | 纯静态 DOM（背景都不挂） | ★★★★★ | 极低 | 低配/省电档的兜底，建议 Zilux2 第一版必须有 |

**结论**：14 个里 **7 个纯 DOM/CSS**（classic、cadenza、partita、tilt、claddagh、cappella、still）、**2 个 Canvas2D**（fume、pendolo-C2D）、**3 个 Pixi/WebGL**（sonnet、tempera、lumiere）、**1 个 three/R3F**（diorama）、**1 个混合 worker**（monet）。对 Zilux2 的优先级建议：先做 DOM 系（0 GPU 依赖、WPF/WebView2 最稳）→ 再 Pixi 系（WebGL2）→ three 系（最后，且只在独显/高配档开放）。

### 7.2 P0（必须借鉴，做进 Zilux2 第一版）

| # | 借鉴项 | 复杂度 | 借鉴方式 |
|---|---|---|---|
| P0-1 | **全局 rAF 门 + 逃生口**（`frameRateLimiter.ts` 思路：共享回调批、1 ms 容差、`'off'` 完全恢复原生、给 framer-motion 这类“提前抓走 rAF”的库留 uncapped 通道） | 中 | 独立写 `frameGate.ts`：`installFrameCap(fps)`、`requestUncappedFrame()`、`onHostFpsChange(fps)`；数值经验沿用（interval = 1000/fps − 1 ms） |
| P0-2 | **纹理池幂次吸附**（把分辨率往“更小 2 的幂桶”方向微调，单轴最多降 25%，只接受桶面积真变小） | 中 | 写与渲染引擎无关的 `snapResolution(cssW, cssH, resolution, maxDrop)`；参数 0.25/单轴/按桶面积排序照搬“经验值”，实现独立 |
| P0-3 | **DPR 钳制 + 图形组单独降分辨率**（文字满分辨率、只降最贵的图形层；bloom 级数按 log2 降） | 低 | 三个档位 full/balanced/low + `dpr ∈ [1,2]` + `graphicsScale`；直接写进 Zilux2 的“画质档” |
| P0-4 | **可视化器注册表 + 内置清单断言**（`import.meta.glob('./*/entry.tsx')` + `BUILTIN_VISUALIZER_MODES` + 启动断言 + `order` 排序 + lazy renderer） | 低 | 设计模式照搬；Zilux2 因为 C# 宿主，建议再叠一层“宿主能力探测”（WebGL2/WebGPU 可用性 → 可选列表） |
| P0-5 | **背景/图层分离**（背景 registry、视频层、整体透明度由容器画一次，14 个样式共享；样式切换背景不重挂） | 中 | 这一层与 Zilux2 的 WPF 壁纸层天然重叠，详见 §7.5 |
| P0-6 | **首帧门（claim/drawn）**（慢启动样式自己宣布“首帧好了”，切换过渡才开始） | 中 | 用于避免“切换动画卡在半路 + 双份 GPU 开销” |
| P0-7 | **音频特征管道**（fftSize 2048、smoothing 0.6、`bin = floor(hz/21.5)`、5 段频带、`(v/255)^boost*255`、boost=2/1.8/1.5、空信号“呼吸”兜底 `sin(Date.now()/2000)*20`） | 低 | **Zilux2 应把分析放在 C# 侧（WASAPI loopback 已有）**，通过 `postMessage` 每帧/每 2 帧传 5–8 个 float + 拍点事件；页面只做映射与插值。Folia 的参数是调好的经验，直接照搬数值 |
| P0-8 | **静态模式 + reduced-motion 两套独立开关**（staticMode 总开关；reduced-motion 按 surface 分 6 个部位 + 跟随系统） | 低 | UI/存储结构照搬；Zilux2 宿主还要叠加系统“动画效果”设置（`SystemParameters.ClientAreaAnimation`）作为默认值 |

### 7.3 P1（第二批，明显收益但工作量可控）

| # | 借鉴项 | 复杂度 | 借鉴方式 |
|---|---|---|---|
| P1-1 | **场景段落缓存 + 两帧换歌状态机**（只留当前段 ±1；stage/commit 两帧；retired 队列一帧销毁一个） | 中高 | 需要 Zilux2 的歌词模型有“段落”概念；实现独立，关键是“切歌期间新旧场景共存两帧后再拆”的时序 |
| P1-2 | **粒子“spawn source + 自主衰减”模型**（音频只触发 ripple，之后由 uTime 演进；位移按 primitive 自身半径的比例；角向用整数谐波避免接缝） | 中 | 这是“音频驱动视觉”里最不容易做的过头/卡顿的范式，建议作为 Zilux2 粒子/波纹效果的标准模型 |
| P1-3 | **Canvas 文字光栅代替 SDF**（浏览器文字引擎保证笔画连续 + 全字幕字体栈；ACTIVE 行按 CJK 字/拉丁词拆平面） | 中高 | 适用于任意 3D 文字方案；工作量在缓存与 UV 对齐 |
| P1-4 | **着色器预热 + 上下文预创建切片**（KHR_parallel_shader_compile；每任务 4 ms；扩展逐个开） | 高 | Electron/Pixi 特定。Zilux2 可简化为“隐藏页面预热 + 首帧门”，不必做 4 ms 切片 |
| P1-5 | **画质档分层**（live keys vs compile keys 的 uniform 边界；每帧可改的绝不重编译） | 低 | 写进 Zilux2 的 shader/材质规范 |
| P1-6 | **perf 测量装置方法论**（场景矩阵、laptop/old/host 三套 profile、noise check、truth check=人为加 4 ms 验证装置灵敏度、单次运行锁） | 中 | 方法论照搬，工具用 Zilux2 自己的（WPF 侧 ETW/GPU View；页面侧 Playwright/WebView2 DevTools） |
| P1-7 | **长跑内存探针**（Playwright + 按进程分类工作集；不用 JS heap 因为看不到 canvas backing store/合成层/GPU） | 中 | 直接借鉴度量口径：totalPrivate + rendererHeap + GPU process + FD 计数；Zilux2 还该加 WPF 侧 `Process.WorkingSet64` 与 D3D 显存 |
| P1-8 | **OBS 式 DPR 覆写**（`Object.defineProperty(window,'devicePixelRatio')`，把像素预算交给宿主配置） | 低 | WebView2 里用同样的注入方式，让 WPF 侧决定渲染 scale（多显示器 DPI 场景必备） |

### 7.4 P2（可选/观望）

| # | 借鉴项 | 复杂度 | 借鉴方式 |
|---|---|---|---|
| P2-1 | 壁纸层（WorkerW）工程细节：24H2 raised / classic 双探测、透明拒绝策略、helper 心跳 5 s、连续 3 次失败降级、detach 保留最后一帧不残留 | 高 | Zilux2 宿主是原生，P/Invoke 更简单，但**坑完全一样**；只学文档里的坑与状态机 |
| P2-2 | WebGPU 拍点/分轨（`beat_this-wgsl.bin` / `htdemucs-wgsl.bin`，模型随包分发） | 高 | 可行但 WebView2 + 低配 iGPU 风险高；建议 Zilux2 先 WASM/CPU，WebGPU 作为高配加速（`modelAvailability` 式能力探测） |
| P2-3 | Linux blur FD 修复（`glowBlurQuantize`：把 blur 半径量化以减少 FD 申请） | 低 | Windows 基本用不到；但“把连续参数量化成有限档”是低端设备通用的省资源技巧 |
| P2-4 | 恒零常量指纹（`LUMIERE_NEUTRAL_OFFSET`） | — | 不借鉴，仅作为“读 AGPL 代码时要识别水印”的案例 |
| P2-5 | 导出采集 60 fps + “限合成器会连带限 rAF”的结论 | 低 | 结论可直接用：限帧不要打在合成器上，要打在页面/采集侧 |

### 7.5 WebView2 + WPF 宿主的分工（给 Zilux2 的具体方案）

**① 帧率与时钟**
- 宿主提供：显示器刷新率（`MonitorFromWindow` + `GetDpiForMonitor`/`DisplayConfigGetDeviceInfo`）、当前是否省电/电池、是否游戏模式/全屏独占前台；
- 页面提供：`frameGate`（P0-1），实际 fps = `min(用户设置, 宿主期望)`；页面不再自己读“显示器刷新率”，避免多显示器下算错；
- 歌词时钟：宿主用 GSMTC（`GlobalSystemMediaTransportControlsSessionManager`）的 playback position + 平滑插值，按 `postMessage` 推给页面（Folia 用 `<audio>` 的 `currentTime` MotionValue，Zilux2 没有 audio 元素，必须宿主供给，注意暂停/seek/缓冲三种状态）。

**② 可见性与暂停**
- 宿主监听：`Window.StateChanged`（最小化）、`IsVisibleChanged`、`SystemEvents.SessionSwitch`（锁屏/切换用户）、`SystemEvents.DisplaySettingsChanged`、前台窗口变化（用于判断“桌面是否被全屏应用盖住”，参照 Lively 的 `IsDesktop()` 思路，`docs/wallpaper-mode.md:90`）；
- 页面暴露 `window.zilux.host.setState({visible, occluded, minimized, locked})`，页面据此 `pause()`；**不要依赖 Page Visibility API**（WebView2 的 `document.hidden` 在 WorkerW 桌面层同样不可靠）；
- 恢复时要处理“时间跳变”：暂停时冻结 clock 与音频包络，恢复时一次性对齐（Folia 的 `handoffProgress` 两套时钟就是同类问题的解法，`motionSignals.ts:41-42`）。

**③ 像素与画质**
- 宿主传 `devicePixelRatio`（P1-8）与 `renderScale`；页面按 `P0-2/P0-3` 计算纹理尺寸；
- 多显示器跨 DPI 拖动（WebView2 的 DPI 感知边界）：宿主在 `DpiChanged` 时推新值，页面重建 render target（Folia 的 `lattice` 歌词画布在 DPR 变化时“只 resize 不重启”是可抄的策略）；
- 画质档：页面暴露 `setQuality(full|balanced|low)`，宿主根据电池/GPU 厂商/显存给默认值（Folia 只有模式内 tuning，没有全局档——Zilux2 应补上）。

**④ 音频特征供给**（替代 Folia 的 `usePlaybackAudioBridge`）
- C# 侧 WASAPI loopback → 5 段能量 + 频谱摘要（建议直接传 32/64 bin 的 `byte[]`，比完整 1024 bin 省 90% 带宽）+ 拍点/鼓点事件；
- 传输：`CoreWebView2.PostWebMessageAsJson` 每帧一次或每 2 帧一次（60 Hz 下 3–6 KB/s，可忽略）；页面侧用 MotionValue/普通数组双缓冲，**不要每包触发 React setState**；
- 页面只做映射（boost/归一化/平滑）与插值；暂停/缓冲时宿主发 `silence`，页面走“呼吸兜底”。

**⑤ 图层复用边界**
- Folia 的 `VisualizerBackdrop`（背景 registry + 视频层 + 整体透明度）与 Zilux2 的 WPF 壁纸层**职责重叠**。建议切分：
  - **WPF 层**：窗口/桌面层、DPR、透明与材质（Acrylic/Mica）、合成、显示器选择、壁纸视频解码（LibVLC）；
  - **页面层**：只画“歌词可视化 + 可选背景（样式自带）”，**不自己解视频**；需要视频时由宿主把帧以 `WriteableBitmap`/共享纹理或 `MediaElement` 叠在 WebView2 下面，页面用透明背景让出；
  - 背景 registry 保留在页面侧（轻量、纯 JS/着色器背景），视频/静态大图背景交给宿主——这样低配机上“背景”不占页面 GPU 预算，也避免 WebView2 里 `<video>` 解码与 WPF VLC 双解码浪费。

**⑥ 宿主能力清单（Zilux2 需要实现的接口）**
```
IHostBridge {
  getDisplayInfo(): { refreshRate, dpiScale, bounds, isPrimary }
  getPowerState(): { onBattery, saverMode, gpuTier }
  subscribeVisibility(cb: (s: {visible,occluded,minimized,locked}) => void)
  subscribeClock(cb: (t: {positionMs, durationMs, playing, paused, buffering}) => void)
  subscribeAudio(cb: (a: {bands: number[], spectrum?: Uint8Array, beat?: number, downbeat?: boolean}) => void)
  setRenderScale(scale: number)        // 页面回调宿主（§7.3 P1-8）
  setQuality(preset: 'full'|'balanced'|'low')
  requestPause() / requestResume()
}
```

### 7.6 不建议借鉴的部分（避免踩坑）

1. **6000 行单文件主进程**：`electron/main.cjs` 是反例，Zilux2 宿主应按窗口/壁纸/GPU/调试拆模块（Folia 的 `electron/modSystem/`、`electron/wallpaper/` 已经是拆分方向）。
2. **`backgroundThrottling:false` 作为节能手段**：它是“必须一直出画”的补偿，不是优化；Zilux2 不要为了壁纸常驻而关掉所有窗口的节流。
3. **全局劫持 rAF 默认开启**：Folia 默认 `'off'` + 标注“实验性”是对的；Zilux2 应默认开一个温和上限（如 60），并且只劫持可视化页面，不动整个 app。
4. **把 `document.hidden` 当暂停条件**：在 WorkerW/WebView2 场景下不可靠（§4.5）。
5. **复制恒零水印常量**：无功能意义，复制只会让“看起来像抄”更明显。

---

## 8. 文档 / 测试索引 与 未解问题

### 8.1 文档地图（本次调研实际读过/定位过的）

| 文档 | 行数 | 内容与价值 |
|---|---|---|
| `src/components/visualizer/README.md` | 267 | **可视化器唯一权威入口**：Runtime flow（`:7-17`）、注册机制（`:37-43`）、加样式 5 步（`:49-55`）、settings/i18n（`:70-86`）、背景 registry（`:92-100`）、共享契约（`:104-108`）、智能动感 beat FX（`:110-128`）、14 模式逐个导航（`:144-229`）、host surfaces（`:231-247`）、换样式过渡（`:249`）、runtime guardrails（`:251-257`） |
| `docs/wallpaper-mode.md` | 193 | 三平台壁纸模式全实现 + 已知局限（详见 §5.6） |
| `docs/technical.md` | 294 | 面向用户/开发的总说明：桌面端、发布通道、Linux 获取、Quickshell 歌词插件、Hyprland/KDE 遥控窗、后端/歌词接口、本地开发、常用脚本、代码速查地图、技术栈 |
| `docs/CODEMAP.md` | 324 | `npm run codemap` 生成的分层代码地图 + 边界违规清单（`AGENTS.md` 要求先查它）；visualizer 相关条目在 `:50-52,68,232-239` |
| `AGENTS.md` | — | 目录按功能划分、依赖方向、渲染进程只经 preload、日志前缀 `[模块名]`、设置键不可改名（`test/unit/stores/storeContract.test.ts` 快照）、性能 skill `frontend-runtime-guardrails` |
| `dev/perf/README.md` | 616 | 帧级测量装置（§4.7）：profiles/scenarios/noise/truth/lock/输出目录 |
| `dev/perf/app/README.md` | — | 整应用测量：启动、换歌、切页、内存 |
| `test/manual/visualizer-memory-probe.mjs` | 116 | 长跑内存探针（§4.7c） |
| `electron/` 模块注释 | — | `displaySleepBlocker.cjs:1`、`debug/memoryMonitor.cjs`、`wallpaper/windowsWallpaperController.cjs`（状态机/重挂/降级）、`modSystem/exportService.cjs:290`（限帧结论） |
| `docs/linux-glyph-cache-fd-leak.md` 等 | — | Linux 专属排障文档（`glowBlurQuantize` 的来龙去脉，§4.4e）；另有 `automix-memory-optimization.md`（内存优化方法论）、`analysis-service-plan.md`（分析服务规划） |

**文档与代码不一致的地方（重要，写报告时区分了“文档声称”与代码实证）**：
1. 任务交办时说“README/文档说 14 个”——实际**文档里没有数字**（根 `README.md` 只有一张 `img/visualizer.png`，`:52`；`docs/` 也未列数量）。**14 是代码事实**：`src/components/visualizer/*/entry.tsx` 目录数 = `BUILTIN_VISUALIZER_MODES` 长度 = 14，`order` 10–130 连续无空洞，registry 启动时 `assertBuiltinModeList` 强校验。
2. 文档说“背景与样式解耦、背景跨样式保留”——代码证实（`VisualizerBackdrop` 在 `VisualizerRenderer.tsx` 里于样式外渲染，`:57-72`）。
3. 文档说“降低界面微动效”——代码里它只覆盖 6 个 surface，**不覆盖可视化器主体帧率/画质**（§4.4a），REDUCED-MOTION 与 `staticMode` 是两套独立开关。
4. `docs/wallpaper-mode.md` 引用 `lumisynth docs/LUMIERE.md`（绘光设计文档的“第七节”）——该文档**不在本仓库**（外部目录），属于待确认的外部依赖。
5. `README.md` 说 `import.meta.glob` 自动发现 entry（`:37`）——代码 `registry.tsx:15` 证实；但 `src/types.ts` 里的 `BuiltinVisualizerMode` 只列 5 个旧名字（`visualizer/README.md:41` 明确警告“别拿它当清单”），这是文档主动指出的坑。

### 8.2 测试索引（与可视化器/性能相关）

| 位置 | 内容 |
|---|---|
| `test/unit/visualizer/`（**100 个文件**） | `builtinModeLists.test.ts`（14 个清单/背景清单一致性）、`backgroundRegistry.test.ts`、`backgroundSongChange.test.ts`、`dioramaGeometry.test.ts`、`dioramaSequencer.test.ts`、`focusJitterRepro.test.ts`、`beatEffectsGroup.test.ts`、`cameraPath.test.ts`、`fontPickerRows.test.ts`、`claddaghPlaybackReset.test.ts` 等——**测试密度是本项目最值得学的一点**：注册表、背景切换、相机路径、几何都有单测 |
| `test/unit/stores/storeContract.test.ts` | 设置键名快照（发布后不可改名） |
| `test/unit/visualizer/storedSettingsPins.test.ts` | 新增 tuning 必须登记（README:84-86） |
| `test/component/` | 组件级（含可视化器 shell 类测试，具体清单**待确认**） |
| `test/ui/`（Playwright） | 视觉/交互；`*.probe.ts` 渲染探针**刻意排除**在 `npm run test:ui` 之外 |
| `playwright.config.ts` | 主配置（e2e + components 两个 project） |
| `playwright.probe.config.ts`（22 行） | 渲染探针专用：`testMatch: **/*.probe.ts`、`workers:1`、`fullyParallel:false`；注释解释“顶层 testMatch 对 project 不生效”的陷阱；跑法 `npm run test:render` |
| `test/manual/` | `visualizer-memory-probe.mjs`（§4.7c）、`lattice-cover-memory.mjs`、`bravais-perf-probe.mjs`；`npm run manual:*` |
| `dev/probes/` | `visualizerMemory.probe.tsx`（CODEMAP:137 提到）、`bravais-perf/fpsCap` 探针（fpsCap 探针用于验证限帧） |
| 命令 | `npm run test:unit`（Vitest）、`npm run test:ui`、`npm run test:render`、`npm run codemap`、`npm run lint:style`、`npm run manual:visualizer-memory` |

### 8.3 未解问题 / 待确认清单（按优先级）

**P0**
1. **没有自适应降档**：全仓库没有“测 FPS → 降画质”的闭环；`dev/perf` 只离线测。Zilux2 应自己做（宿主侧 ETW/帧时间 + 页面侧画质档）。
2. **隐藏时不停**：`backgroundThrottling:false` + 无平台级可见性暂停，最小化/被遮挡仍全速渲染（§4.5）。影响功耗/发热，尤其壁纸模式。
3. **`document.hidden` 语义与代码假设冲突**：`usePlaybackVisualizerBridge.ts:129` 注释“窗口隐藏时这个循环不跑”在 Electron 设置下可能不成立（**待确认**实际表现；需在 Windows 上实测 `backgroundThrottling` 对 rAF 的影响）。
4. **Pixi 上下文丢失恢复**：`preserveDrawingBuffer:false`，未发现 `webglcontextlost` 统一处理；GPU 驱动崩溃/TDR 后的行为**待确认**。

**P1**
5. **`spectrum` 每帧 `new Uint8Array`**（`usePlaybackVisualizerBridge.ts:156`）：60 Hz 下每秒 60 个 1 KB 数组，是可见的 GC 压力（**待优化项**）；`motionSignals.ts:52` 的初值是空数组。
6. **纹理/对象池缺失**：除纹理池吸附与场景缓存外，没有通用的粒子/文字纹理复用池；文字纹理是否有 LRU 未逐行核对（**待确认**）。
7. **`LUMIERE_NEUTRAL_OFFSET` 恒零表达式用途不明**（§6.8）。
8. **`requestVideoFrameCallback` 的实际使用点未定位**（视频层是否用它取帧以省一次 rAF）。
9. **限帧是应用级而非可视化器级**：设置项命名与实现范围不一致（`frameRateLimiter.ts` 劫持全局 `window.rAF`）；关掉可视化器后 UI 也受限帧影响（**待确认**用户是否感知）。
10. **商籁 8 个全屏 pass 的实测量化**：`dev/perf` 结果未入库（`claude-notes/` 是本地产物），无法给出“sonnet vs tempera vs lumiere”的客观每帧耗时对比——报告里只能给装置方法，不能给数字（**待确认**）。

**P2**
11. **`dev/perf` 数据集不在仓库**：`claude-notes/perf/data/baseline/` 属本地/忽略目录（`README.md:29-40` 提到），团队外部无法复现基线。
12. **OBS/遥控窗双开时的总 GPU 开销**未测（两窗口都是 `backgroundThrottling:false`）。
13. **Linux `glowBlurQuantize` 的量化档位值**未在代码里找到常量表（**待确认**具体实现）。
14. **WebGPU 分析在低配 Windows 的失败率**未知（`modelAvailability.ts` 有探测，但无统计）。
15. **i18n 三份语言文件**里可视化器设置的键必须同步（README:70-77），新增样式时的漏项只有单测能兜住（`storedSettingsPins.test.ts`）。

### 8.4 复现路径（本次调研怎么验证的）

```bash
# 1) 14 个可视化器 = entry 目录数 = 内置清单
ls src/components/visualizer/*/entry.tsx | wc -l          # 14
grep -n "BUILTIN_VISUALIZER_MODES = \[" -A 20 src/types/visualizerModes.ts

# 2) 限帧机制
read src/utils/frameRateLimiter.ts          # 217 行
grep -n "installGlobalVisualizerFrameRateLimiter" src/index.tsx
grep -rn "visualizer_frame_rate" src/stores src/components/modal/settings

# 3) 像素预算
read src/components/visualizer/pixi/pixiTextureBudget.ts   # 113 行，注释里有实测数字
grep -rn "devicePixelRatio" src/components/visualizer src/components/app/lattice

# 4) 可见性/后台
grep -n "backgroundThrottling" electron/main.cjs            # 5085 / 5262
grep -rn "visibilitychange" src                             # 15 处，均不在 renderer

# 5) 测量装置
read dev/perf/README.md
read test/manual/visualizer-memory-probe.mjs
read playwright.probe.config.ts
```

---

## 附：本文的核查边界与免责

- 行号以 2026-10-18 的本地工作副本 `E:\Zilux2开发\research\repos\folia`（v0.7.21，未修改）为准；上游主干若有更新，行号会漂移，函数名/常量名可作稳定锚点。
- 所有“代码事实”都来自实际读取或 `grep` 命中；“文档声称”单独标注；“**待确认**”表示本次未逐行验证或仓库内无充分证据，**不是**“大概如此”的委婉说法。
- 未做运行时实测（不 `npm install`、不联网、不跑应用）：所有耗时/显存数字均引自代码注释或文档，属“项目自述数字”，非本人测量。Zilux2 若要引用这些数字做技术决策，建议在自己的目标机上用 §4.7 的方法复测。
- AGPL-3.0：本文所有实现细节（含公式、常量、行号）仅用于设计参考与重写规格，不构成对 Folia 源码的复制许可。

*报告完成于 2026-10-18。*
