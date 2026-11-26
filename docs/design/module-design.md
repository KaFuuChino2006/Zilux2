# Zilux2 模块设计

> 版本：1.2.11 · 编制日期：2026-11-24
>
> 约定：`宿主` = `src/Zilux2/`（C#/.NET），`页面` = `web/src/`（TypeScript）。「关键接口」只列对外可依赖的入口，不列私有实现。

## 1. 模块总览

| 编号 | 模块 | 侧 | 职责一句话 | 关键接口 |
| --- | --- | --- | --- | --- |
| M-01 | `MainWindow` | 宿主 | 窗口生命周期、自绘标题栏、停车到屏幕外、关闭策略 | `ShowFromTray()` / `HideToTray()` / `ToggleMaximize()` / `CloseFromPage()` |
| M-02 | `WebViewHost` | 宿主 | 宿主与页面的唯一边界：消息、脚本、事件 | `Send(event)` / `RunScriptAsync(script)` / `NavigationCompleted` |
| M-03 | `Online` | 宿主 | 多平台账号、搜索、直链解析、下载、歌词 | `IOnlineMusicProvider`（`Search` / `ResolveUrl` / `Lyrics`） |
| M-04 | `LocalMusicServer` | 宿主 | 回环 HTTP API、流式音频、媒资 Range | 路由表 + `SerializeStemModel` 等序列化器 |
| M-05 | `Analysis` | 宿主 | 拍格、能量、响度、尾部静音、结构分析 | `TrackAnalysisService.AnalyzeAsync(track)` |
| M-06 | `Analysis.Enrichment` | 宿主 | 增强分析：风格画像、分轨活动度、ONNX 阶段 | `AnalysisEnrichmentService.Enqueue(track)` |
| M-07 | `Stems` | 宿主 | 人声分离：模型安装、会话复用、窗口推理、缓存 | `StemSeparationService.EnsureWindowAsync()` / `StemModelInstaller.Ensure()` |
| M-08 | `Local` | 宿主 | 本地曲库扫描、标签读写、CUE、转码、目录监听 | `LocalMusicService.Scan()` / `LocalFolderWatcher` |
| M-09 | `Wallpaper` | 宿主 | 动态壁纸：监控、渲染宿主、规则、全屏检测 | `WallpaperHost.Start()` / `FullscreenWatcher.Paused` |
| M-10 | `DesktopLyrics*` | 宿主 | 桌面歌词窗口（含粉丝向样式） | `Show/Hide` / 解锁穿透切换 |
| M-11 | `Tray` | 宿主 | 托盘图标与自绘菜单 | `TrayIconService.EnsureMenu()` / `TrayMenuWindow` |
| M-12 | `Hotkeys` | 宿主 | 全局热键与鼠标侧键导航 | `GlobalHotkeyHookService` / `HotkeyCatalog` |
| M-13 | `Media` | 宿主 | SMTC 媒体会话、媒体键、封面 | `MediaSessionService` / `MediaKeyHookService` |
| M-14 | `Remote` | 宿主 | 局域网遥控页面与 HTTP 服务 | `RemoteService.Start()` / `RemotePages` |
| M-15 | `AirPlay` | 宿主 | AirPlay 设备发现与投放 | 发现列表 + 会话控制 |
| M-16 | `Settings` | 宿主 | 设置模型、读写、字段白名单、版本迁移 | `SettingsService.Load/Save` / `GeneralSettings` |
| M-17 | `Storage` | 宿主 | 原子写、缓存策略、LRU | `AtomicFile.Write` / `CacheService` |
| M-18 | `Updates` | 宿主 | 版本检查、下载、提示重启 | `UpdateService.CheckAsync()` |

| 编号 | 模块 | 侧 | 职责一句话 | 关键接口 |
| --- | --- | --- | --- | --- |
| W-01 | `app.ts` | 页面 | 应用外壳：路由、页面装配、播放控制、状态机 | `App` 实例方法（`showHome` / `openLyrics` / `refreshStemPlayback`） |
| W-02 | `crossfadeDeck.ts` | 页面 | 过渡调度器：时间轴、自动化、V2/AM 分支、手法卡数据 | `beginTimeline(plan)` / `MixLiveSnapshot` |
| W-03 | `core/automix/*` | 页面 | 混音算法：选型、质量评分、V2 规划、风格画像 | `chooseStyle()` / `buildV2Plan()` / `buildDuckEvents()` |
| W-04 | `audio/*` | 页面 | Web Audio 节点图、进阶混音、分轨播放、变速 | `automixV2Graph` / `stemPlayer` / `advancedSession` |
| W-05 | `stemsClient.ts` / `stemsDeck.ts` | 页面 | 分轨协议：模型状态、窗口预取、进度事件 | `ensureStemModel()` / `onStemWindowProgress()` |
| W-06 | `lyrics.ts` / `coverLyrics.ts` | 页面 | 歌词渲染：逐行、逐词扫光、封面歌词 | `LyricsView` / `CoverLyrics` |
| W-07 | `wallpaperView.ts` / `wallpaper/*` | 页面 | 壁纸页与桌面层视图 | 页面路由与媒资加载 |
| W-08 | `progressDock.ts` | 页面 | 左下角通用进度卡（下载/分离/手法） | `setTask()` / `finish()` / `fail()` |
| W-09 | `settings`（core/ui） | 页面 | 设置读写、字段归一化、设置页渲染 | `readSettings()` / `patchSettings()` |
| W-10 | `bridge.ts` | 页面 | 与宿主的消息协议 | `host.minimize()` / `host.toggleMaximize()` / 事件订阅 |

## 2. 宿主侧模块细节

### M-03 Online（多平台聚合）

- **子模块**：`Netease/`、`Qq/`、`Kugou/`、`Mvmp3*`、`Discover/`、`Library/`、`Account/`。
- **统一模型**：`OnlineTrack`（id、source、title、artists、durationMs、coverUrl、qualities）。
- **降级策略**：`NativeFirstPolicy` 决定优先直链还是走本地代理；某源失败自动切下一个源。
- **依赖**：`Storage`（缓存）、`LocalMusicServer`（把直链转成带令牌的本地 URL）。

### M-05 / M-06 分析与增强

- `BeatAnalyzer` 产出 `BeatAnalysis`：BPM、拍点、downbeat、能量包络、人声活动度。
- `StructureSsm` 做自相似矩阵，输出段落边界（前奏/主歌/副歌/桥段/尾奏）。
- `AnalysisEnrichmentService` 在基础分析成功后排队；`BuildFeatureKey` 不含算法版本，模型升级只失效对应 stage。
- **依赖**：`TrackAudioDecoder`（解码）、`Storage`（落盘）。

### M-07 Stems（人声分离）

- `StemModelInstaller`：镜像降级（`ZILUX2_STEMS_MODEL_URL` → hf-mirror → huggingface）、`.part` 落盘、SHA-256 校验、单飞。
- `StemSeparationService`：`EnsureWindowAsync` 按 30 s 窗口推理；模型缺失时返回 `model-downloading`（含 `progress`/`bytes`/`total`）。
- `StemCacheLru`：窗口级缓存，超限淘汰最久未用。
- **依赖**：ONNX Runtime 1.31.1（CPU）、`Storage`。

### M-09 Wallpaper（壁纸）

- `MonitorCatalog` 枚举显示器；`WallpaperHost` 为每个显示器建宿主窗口。
- `Render/` 承载视频/网页/着色器三种渲染后端；`Rules/` 做按时间/前台程序切换。
- `FullscreenWatcher` 检测全屏独占并暂停，避免抢 GPU。
- **依赖**：WebView2（网页壁纸）、`Storage`（媒资缓存）。

### M-16 Settings（设置）

- `GeneralSettings` / `AppearanceSettings` 等分节模型，字段顺序即文件布局；新字段只追加在末尾。
- `SettingsService.IsKnownField` 做写入白名单；未知字段在保存时原样保留。
- **依赖**：`Storage.AtomicFile`。

## 3. 页面侧模块细节

### W-02 crossfadeDeck（过渡调度器）

- 输入 `TransitionPlan`（`kind`、`fadeMs`、`fadeStartFileMs`、`am`、`advanced`、`v2Duck`、`styleId`…）。
- 输出：对两条 deck 的 gain / filter / EQ 自动化；`MixLiveSnapshot` 供界面显示「本次切歌」。
- 三条分支：`am`（交融）→ `v2`（进阶混音，四轨）→ 兜底（`scheduleBandSwap` + `scheduleNaturalFade`）。
- 约束：自动档不做逐句人声让位（`kind === 'auto'` 跳过 `v2Duck`），避免长窗里 A 被反复压低。

### W-03 automix（混音算法）

| 文件 | 职责 |
| --- | --- |
| `styleKit.ts` | 16 种手法目录（`STYLE_CATALOG`）、`styleLabel()` |
| `stylePolicy.ts` | 窗口缩放、BPM 差与调性约束 |
| `styleProfile.ts` | 多标签风格画像（punk/rock/metal/electronic/hiphop/pop/ballad/acoustic/ambient/instrumental） |
| `tempoPolicy.ts` | A/B 变速上限与对齐策略 |
| `v2Plan.ts` / `v2Quality.ts` | V2 规划与质量评分（`buildDuckEvents` 等人声让位曲线） |
| `extensionPlan.ts` | A 尾自延长（接缝 ≤1.5 dB、最长 32 s） |

### W-05 分轨协议

- `ensureStemModel(onProgress)`：先 `GET /api/stems/model`，未就绪且非下载中则 `POST` 触发；每 600 ms 轮询，15 分钟封顶。
- `onStemWindowProgress(listener)`：`start` / `done` / `fail` 三态，驱动左下角进度卡。
- `prefetchStemWindow()`：窗口级预取，命中缓存直接返回。

### W-08 progressDock（进度卡）

- 优先级：`model` > `stem` > `transition`，同一时刻只显示一张卡。
- 状态：`is-shown`（入场）、`is-collapsed`（收起为左侧窄条）、`is-leaving`（出场）、`is-done`、`is-failed`、`is-indeterminate`、`is-plain`（手法信息卡）。
- 动效：左滑入 + 淡入；收起后窄条带进度环（仅模型下载）；出场反向滑回。

## 4. 模块依赖关系

```
ui/*  ──► core/*  ──► bridge ──► WebViewHost ──► 宿主服务
  │         │
  │         └─► audio/*（Web Audio 图）
  └─► styles/*（仅样式）

宿主服务之间：
LocalMusicServer ──► Online / Analysis / Stems / Wallpaper / Settings / Storage
Stems ──► Storage
Analysis.Enrichment ──► Analysis / Storage
Wallpaper ──► Storage / WebView2
Tray / Hotkeys / Media / Updates ──► MainWindow
```

**禁止的依赖**（保证可维护性）：
- `ui/*` 不得直接 `fetch('/api/...')`，统一走 `core/*` 封装。
- `core/automix/*` 不得引用 DOM 或 Web Audio，只做纯计算。
- 宿主服务不得直接操作页面 DOM，只能通过 `WebViewHost` 发事件。

## 5. 扩展点

| 扩展需求 | 落点 |
| --- | --- |
| 新增音乐平台 | 实现 `IOnlineMusicProvider` + 在 `MusicSourceCatalog` 注册 |
| 新增过渡手法 | 在 `styleKit.ts` 的 `STYLE_CATALOG` 增加 `StyleSpec`，并在 `stylePolicy` 给约束 |
| 新增分析维度 | 在 `Analysis/Enrichment` 增加 stage，`BuildFeatureKey` 自动隔离失效 |
| 新增壁纸类型 | `Wallpaper/Render` 增加后端，`Rules` 增加匹配规则 |
| 新增进度类任务 | 复用 `ProgressDock`，在 `TASK_ORDER` 里加优先级 |
