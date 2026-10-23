# Zilux2 三项目深度调研报告

> 调研对象：**Rhine Music Windows**（MIT，代码部分）/ **Folia**（AGPL-3.0）/ **Mineradio**（GPL-3.0-only）
> 目标：为 **Zilux2**（C# / .NET 10 / WPF + WebView2 的桌面歌词与音乐可视化应用）提炼可落地的架构、工程纪律与性能治理经验。
> 日期：2026-10-18　｜　代码基线：Rhine `v0.6.0-dev.57`、Folia `v0.7.21`、Mineradio `v2.2.0`
> 证据约定：正文 `file:line` 均相对本地仓库 `research/repos/<project>/`；四份逐项目深挖报告在 `research/notes/`。

---

## 目录

- [0. 执行摘要](#0-执行摘要)
- [1. 三项目总览](#1-三项目总览)
- [2. Rhine：C# 轻宿主 + WebView2 + 本地 HTTP + 全屏/DPI](#2-rhine)
- [3. Folia：歌词五层解析与逐字时间轴](#3-folia-歌词)
- [4. Folia：14 个可视化器与性能护栏](#4-folia-可视化)
- [5. Mineradio：帧预算、桌面层与视觉](#5-mineradio)
- [6. 跨项目横向对比](#6-跨项目横向对比)
- [7. 许可与合规边界](#7-许可与合规边界)
- [8. Zilux2 采纳路线图](#8-zilux2-采纳路线图)
- [9. 反模式与风险清单](#9-反模式与风险清单)
- [10. 附录：深挖报告索引与证据核对](#10-附录深挖报告索引与证据核对)

---

## 0. 执行摘要

**一句话：三个项目各自解决 Zilux2 的一块问题——Rhine 给“宿主怎么把 Web 前端装进 Windows 应用”，Folia 给“歌词与可视化怎么组织成可维护的产品级系统”，Mineradio 给“低配 Windows 上怎么把 3D/粒子跑到可用且不烧机”。Zilux2 的底座已由 v1 确立（WPF + WebView2 + WorkerW + GSMTC + LibVLC + NAudio），因此三项目全部只取“设计、工程纪律与常量方法论”，不搬架构、不搬代码。**

1. **Rhine（MIT，代码可复用）** 最值得抄三件事：①WebView2 环境策略（Evergreen、独立 UserDataFolder、默认不传 GPU flag、发布禁 DevTools）；②本地 HTTP 数据面（Node 服务 → Zilux2 用 Kestrel 重写，补 session token/CSP）；③“4K 验收纪律 + 黑匣子诊断”（环境变量开关 → JSONL + 截图 + 真实 backbuffer 证据，rAF 不算帧率）。Rhine 与 Zilux2 最大差异：它没有 JS↔C# 桥，页面纯 HTTP 单向拉取；Zilux2 必须用 WebMessage 双向桥。

2. **Folia（AGPL-3.0）** 的歌词子系统价值不在“某个解析器”，而在**分层数据契约**：原始源 → 格式探测/解码 → 统一解析器 → 行/词时间轴模型 → 渲染提示（renderHints/翻译/间奏）→ 渲染器只消费 `LyricData/Line/Word`，永不碰 `.lrc/.qrc/.yrc` 原始格式。它的 14 个可视化器用“注册表 + `defineVisualizer` 契约 + 独立 entry.tsx”做成工厂，并用一套硬规则约束性能：**离散 UI 状态与逐帧运动数据分离、禁止把 currentTime/rAF 时间戳写进 React state、限帧/像素预算/reduced-motion 三层护栏**。Zilux2 只能学思路重写（AGPL 传染）。

3. **Mineradio（GPL-3.0-only）** 最有价值的是“低配 Windows 性能方法论”：**像素预算（5.2M 默认，DPR cap 1.35）+ 子系统级 frameGate 限帧（音频 60 / 歌单架 30 / 歌词 45 / overlay 12）+ 深后台三件套（rAF→1s 定时器、画布 4×4、清缓存）**，以及 WorkerW 桌面层的**工程化兜底**（fail-closed 发现、ack 回读校验、恢复阶梯、退出恢复 Shell）。它的自适应降帧路径实际被 `RENDER_VISIBLE_VSYNC=true` 冻结成死代码——这是“反馈没接线”的反面教材。

4. **两处需要纠正的预期**：①**Mineradio 并未实现 GSMTC**（全仓 `gsmtc/smtc/mediasession/navigator.mediaSession/MediaPlayPause` 零命中），它只有应用内热键；GSMTC 的正确参考是 Zilux v1 自己的 `MediaSessionWatcher`，本报告在 §5.2 给出升级点。②**“Folia 歌词五层解析”不是仓库原词**（全库检索仅一处无关命中），实际是其解析流水线的五个关注点：来源/格式探测、编码与容器解码、平台解析器、行/词时间轴归并、渲染提示与修正——§3 按代码归纳。

5. **Zilux2 落地总原则**：以 v1 为底座（318 个 .cs、五套时钟、WEB-CONTRACT 已冻结），**先补 P0**：歌词数据契约统一、WebView2 宿主策略（ProcessFailed 恢复/加速键/WebMessage 桥/诊断开关）、性能预算接线（FrameClock + WebView2 像素预算 + 深后台广播）、WorkerW 恢复阶梯；**再做 P1**：可视化器工厂（把 27 套 kinetic 风格升级为 registry 契约）、3D 歌单架、本地 HTTP 数据面、诊断黑匣子；P2 为锦上添花。

6. **许可红线**：Rhine 的**代码** MIT 可复制（保留版权），但素材（`.blend/.glb`/字体/PV 采样/图标）**不是 MIT**；Folia 是 AGPL——任何复制/修改都会把 Zilux2 拉进 AGPL 传染，**只能读思路重写**；Mineradio 是 GPL-3.0-only，整仓传染且含 GPL 上游移植，**只学设计、不复制代码/命名/结构**。

7. **三项目共有风险：文档与代码漂移**。Rhine 的 README 口径已逐条核对（基本属实）；Mineradio 存在死代码（自适应降帧）、死依赖（mpg123-decoder）、文档提到的文件实际不存在（wallpaper.html/wallpaper-preload.js）；Folia 的工程规范文档较新但也要以代码为准。Zilux2 引用任何“结论”前都应回到 `file:line`。

---

## 1. 三项目总览

| 维度 | Rhine Music Windows | Folia | Mineradio |
| --- | --- | --- | --- |
| 定位 | Windows 桌面音乐播放器（WebView2 + Three.js 档案架，单文件 exe） | “Lyrics Reimagine”歌词体验应用（Electron 桌面 + Web + 可视化器） | “沉浸式音乐播放器”（Electron + 桌面模式/粒子/3D 歌单架） |
| 版本 / 许可 | `v0.6.0-dev.57`；**代码 MIT**，素材另有条款（NOTICE.md） | `v0.7.21`；**AGPL-3.0** | `v2.2.0`；**GPL-3.0-only**（含 GPL 上游移植声明） |
| 技术栈 | C# WinForms 宿主（`DesktopProgram.cs` 1,079 行）+ Node HTTP 服务 + TypeScript + Three.js | Electron + React + Vite + TypeScript（2,116 个 ts/tsx）+ Node 后端内嵌 | Electron + 原生 JS（无构建）+ Three.js r128 + PowerShell 内联 C# |
| 统计规模 | 核心 16,135 行（`src/` + scripts + 宿主）；`music-app.ts` 2,276、`scene.ts` 2,110 | 全仓 2,116 个 ts/tsx；歌词工具 60 文件、可视化器 14 个 | 236 个 js/html/css；`public/js/modules/` 58,001 行、`main.js` 6,058、`server.js` 6,717 |
| 运行形态 | 单文件 x64 WinForms exe，内嵌 dist + Node + WebView2 DLL + 服务；资源解压到 `%LOCALAPPDATA%` | 桌面端内嵌 Node 后端（本地 HTTP 32109）+ Vercel serverless + Node Web 版 | Electron 壳 + 同进程 `server.js` 本机 HTTP + PowerShell helper |
| 最适合 Zilux2 学 | 宿主工程学（打包/WebView2/本地 HTTP/DPI/全屏/验收纪律） | 歌词数据契约与解析分层；可视化器工厂；性能护栏硬规则 | 帧预算与降档方法论；WorkerW 桌面层工程化；3D/粒子资源治理 |
| 与 Zilux2 的关系 | 同为“C# 宿主 + Web 前端”，宿主侧可直接对照 | 同赛道（歌词+可视化）但与 Zilux2 栈不同，学设计不搬代码 | 同赛道（Windows 沉浸播放器），其“Electron 架构”不可搬，方法论可搬 |

**阅读顺序建议**：Rhine → 宿主与渲染进程边界怎么设计；Folia → 歌词/可视化子系统怎么组织；Mineradio → 每帧该花多少、不可见时怎么停、桌面层失败怎么恢复。

---

## 2. Rhine

> 深挖报告：`research/notes/rhine.md`（1,076 行）。本章只提炼与 Zilux2 直接相关的四点：轻宿主、WebView2 参数、本地 HTTP、全屏与 DPI。

### 2.1 架构：三进程 + 纯 HTTP 数据面

Rhine 的桌面形态是三个角色：

```
WinForms 宿主 (DesktopProgram.cs, 1,079 行)
  ├─ 解压 payload → %LOCALAPPDATA%\Rhine Music\app-v<ver>
  ├─ 启动内嵌 node.exe + scripts/music-server.mjs（127.0.0.1:动态端口）
  ├─ 创建 WebView2 窗口，导航到 http://127.0.0.1:<port>/?desktop=1
  └─ 只做壳：窗口/全屏/DPI/生命周期/诊断

Node 本地服务 (music-server.mjs 257 行 + music-library.mjs 825 行)
  └─ /api/*：曲库、播放音频（HTTP Range 206）、封面、播放列表

WebView2 renderer（React 无、纯 TS + Three.js）
  └─ fetch("/api/...") 同源相对路径；无 JS↔C# 通道
```

关键判断：**宿主“几乎不做业务”**。播放、曲库、歌词都在页面/Node 里，宿主只负责窗口与进程。好处是边界干净、前端在浏览器里也能跑；代价是**没有双向通道**——页面要通知宿主只能再发 HTTP 请求，宿主无法主动调用页面逻辑（除诊断模式的 `ExecuteScriptAsync`）。

对 Zilux2 的启示：v1 已经是“WPF 原生表面 + WebView2 页面”的双向结构（WEB-CONTRACT.md 已冻结 `welcome/theme/track/lyricsDoc/clock/geometry/...` 消息），**不应退回 Rhine 的单向模型**。Rhine 值得抄的是“宿主只管壳、业务各归其位”的边界意识，以及把这条边界写进诊断与验收。

### 2.2 单文件 exe 与版本化资源解压

- 打包：`csc /resource:$payloadZip,RhineMusicPayload.zip`（`scripts/build-windows.ps1:153`）把前端 dist、Node 运行时、WebView2 SDK DLL、音乐服务全部塞进一个 exe；首次运行解压到 `%LOCALAPPDATA%\Rhine Music\app-v<版本>`，写完 `.payload-ready` 标记 + 关键文件校验 + zip-slip 防护（`DesktopProgram.cs:151-157`）。
- 版本目录与数据目录分离：程序在 `app-v<ver>`，曲库/缓存/WebView2 profile 在 `music-data-v3`——**升级不丢用户数据与 localStorage**。
- 构建脚本：构建锁内自动分配 `0.6.0-dev.N`；拒绝覆盖已有版本目录；发布后重算 SHA-256；输出 EXE + 说明 + 清单（`BUILD-WINDOWS.md`）。

对 Zilux2 的启示：v1 用 `tools/pack.ps1` 自包含发布 + 内嵌安装器，已接近；可补“版本目录/数据目录分离 + 标记文件 + 校验 + 拒绝覆盖 + 哈希复核”这套发布纪律。**不要**沿用 Rhine 的“固定端口段 5175–5184 + 5173”与“无 Job Object 的子进程管理”（崩溃留孤儿、升级残留占端口）。

### 2.3 WebView2 参数与宿主-页面边界

Rhine 的环境创建极简（`DesktopProgram.cs:581-589`）：

| 参数 | 值 | 说明 |
| --- | --- | --- |
| `browserExecutableFolder` | `null` | 用系统 Evergreen Runtime，不锁版本 |
| `userDataFolder` | `%LOCALAPPDATA%\Rhine Music\music-data-v3\webview-profile` | 与程序版本目录分离，升级不丢缓存 |
| `AdditionalBrowserArguments` | **默认 null**；仅诊断模式（`RHINE_WEBVIEW2_DIAGNOSTIC_ARGUMENTS`）透传 | 默认不传任何 GPU flag，GPU 选择交给 Chromium 默认策略 + 页面 `powerPreference:"high-performance"`（`src/scene.ts:185`） |
| `AreDefaultContextMenusEnabled` | `false` | 禁右键菜单 |
| `AreDevToolsEnabled` | `false` | 发布禁 DevTools；副作用是现场排障只能靠黑匣子 |

其它边界行为：`NewWindowRequested` 一律 `Handled=true`，同 authority 当前窗口导航、其它 http/https 交系统浏览器（`DesktopProgram.cs:645-657`）；**未处理** `DownloadStarting`、`PermissionRequested`；**没有** `WebMessage`/`AddHostObjectToScript`；页面加载方式是真实 loopback HTTP（`browser.Source = http://127.0.0.1:<port>/?desktop=1`，`DesktopProgram.cs:658`），**不用** `SetVirtualHostNameToFolderMapping`。

对 Zilux2 的对照与待补项（v1 现状见 `Zilux-build` 源码）：

| 项 | Rhine | Zilux v1 现状 | Zilux2 建议 |
| --- | --- | --- | --- |
| UserDataFolder | 独立于程序目录 | 已用固定目录（`FloatingMenu-data` 等） | 统一到 `%LOCALAPPDATA%\Aurora\WebView2`，并保证升级不丢 |
| GPU 策略 | 不传 flag，页面探测 | 环境参数为禁用遮挡/节流的 Chromium flags（见 v1 `LyricWallpaper.cs`） | 保留现有 flags；页面内 `probeGpuCapability` 探测 + WebMessage 上报宿主，软件渲染时降预设 |
| 双向桥 | 无 | **有**（WEB-CONTRACT v1 已冻结） | 保持并扩展；Rhine 的纯 HTTP 只适合数据面 |
| ProcessFailed | 仅诊断记录 | 需确认 | **生产必须有恢复路径**（重建 WebView2 / 提示重启） |
| 下载/权限 | 未处理 | 需确认 | `DownloadStarting` 拒绝或落盘策略；`PermissionRequested` 默认拒绝 |
| 加速键 | 未关（Ctrl+F/F5 可触发） | 需确认 | 建议关 `AreBrowserAcceleratorKeysEnabled`，避免 F5 刷新丢播放态 |
| 诊断 | `RHINE_PROFILE_CAPTURE=1` → JSONL + 截图 | 有日志但无同类黑匣子 | 加 `ZILUX_WEBVIEW_PROFILE=1` 诊断开关（JSONL + 截图 + backbuffer 证据） |

### 2.4 本地 HTTP 数据面（music-server.mjs）

- 只绑 `127.0.0.1`；Host/Origin 白名单；路由顺序 if；`realpath` 双重校验 + 曲库索引反查（URL 只暴露 id，不暴露文件路径）；音频 `Range: bytes=` 单段 206 流式；`no-store`/`nosniff`；请求体 128 KiB 上限、30 s 超时。
- 端口策略：固定段 5175–5184 + 5173 逐个探测（`/api/health` 返回 `service+projectDir+pid` 做身份校验）——**这一条不建议学**（多实例/升级残留会互抢）。
- 收益：前端所有请求同源相对路径，`<audio src="/api/audio/...">` 走标准 Range，同一份 dist 能在 Vite dev、独立 Node、桌面壳三种形态跑。

对 Zilux2 的落地建议：**不要引入 Node**。用 **Kestrel 最小 API**（`WebApplication.CreateSlimBuilder` + `http://127.0.0.1:0` 取随机端口后注入 WebView2 启动 URL），把路由表逐条翻译；补 Rhine 的缺口：**启动生成一次性 session token（URL 或 SameSite=Strict Cookie）+ 所有 `/api/*` 校验 + CSP `default-src 'self'`**。若 Zilux2 不需要“网页可独立打开”，可只做 WebMessage 数据面、不启 HTTP，成本更低。

### 2.5 全屏与 DPI

- **Per-Monitor V2 双保险**：`app.manifest` 声明 `dpiAwareness=PerMonitorV2`（`app.manifest:15-22`），代码在 `Main()` 第一行后、创建任何窗口前再调 `SetProcessDpiAwarenessContext(-4)`，失败回退 `SetProcessDPIAware()`（`DesktopProgram.cs:422-433`）。时序正确。
- **F11 无边框全屏状态机**（`DesktopProgram.cs:1058-1077`）：保存 `BorderStyle/Bounds/WindowState` → `FormBorderStyle=None` → **先 `WindowState=Normal` 再改 `Bounds`**（Maximized 下改 Bounds 不生效）→ `Bounds = Screen.FromControl(this).Bounds`（当前屏整块，覆盖任务栏）；恢复按“BorderStyle → Normal → Bounds → 原 WindowState”顺序。
- **已知坑**：`windowedBounds` 是物理像素且绑定当时屏幕，跨不同 DPI 屏拖两次 F11 后恢复可能错位；页面里另有 HTML Fullscreen API 按钮（`src/music-app.ts:1853-1858`），**两套全屏无同步机制**（宿主不知道页面进了全屏，Esc 退出后宿主状态仍为 true）。Zilux2 应统一为宿主级全屏，页面只发请求。
- **4K 验收纪律**（`BUILD-WINDOWS.md:38-40`，工程流程可复用）：rAF 诊断值不算验收；性能报告必须记录 3840×2160 实际 canvas 缓冲区，用 PresentMon 显示帧/显示间隔检查冷/热/快速切换、专辑详情、主题切换、大曲库；目标 ≥60FPS，测试期间**不降画质、不放大低分辨率、不限帧伪造**。配套代码把真实渲染尺寸写进 `host.dataset.renderQuality`、`FrameProfiler.snapshot().viewport` 记录 `backBufferWidth/Height`。

对 Zilux2 的 WPF 版落地：.NET 10 WPF 已原生 PerMonitorV2，manifest 声明即可，**不要**再调 WinForms 的 `SetProcessDPIAware`；全屏用 `WindowStyle=None + ResizeMode=NoResize + WindowState=Maximized`，覆盖任务栏需 P/Invoke 到 `MonitorFromWindow + GetMonitorInfo` 的 **monitor rect（不是 work area）**，保存 DIP 坐标 + monitor id，处理 `DpiChanged`；桌面歌词/WorkerW 场景**必须按 monitor 而不是 primary** 处理。

### 2.6 黑匣子诊断（建议原样借鉴）

当 `RHINE_PROFILE_CAPTURE=1` 时，宿主在 `Shown` 挂事件并把 JSONL 追加到 `<webview-profile>/profile-capture.jsonl`（`DesktopProgram.cs:548`、`L1045-1056`）：

- `NavigationStarting/Completed`（`WebErrorStatus`、`HttpStatusCode`）、`WebResourceResponseReceived`（同 authority 限 40 条）、`ProcessFailed`（Kind/Reason/ExitCode/FailureSourceModulePath）。
- 导航成功后 `ExecuteScriptAsync` 拉 viewport/dpr/screen、`app.gpuCapability`、`window.rhineMusic.profile()`（FrameProfiler + stats）、歌词/播放状态，再 `CapturePreviewAsync` 存 PNG。
- 每条记录带 `capturedAtUtc`、`qpcMilliseconds`、`monitorBoundsPx`、`windowClientPx`，并附免责声明：“rAF 指标不能代表真实显示帧，需外部 PresentMon/ETW 验证”。

价值：**发布禁用 DevTools 后仍有一条完整证据链**（WebView2 版本/导航错误/资源状态/渲染进程崩溃原因/实际 canvas 缓冲/GPU timer/帧分布）。Zilux2 可照搬“环境变量开关 + JSONL + 截图 + dataset 证据”的组合。

---

## 3. Folia 歌词

> 深挖报告：`research/notes/folia-lyrics.md`（964 行）。结论先行：Folia 歌词引擎的价值在**五层数据契约 + 时钟纪律**，不在某个解析器；AGPL 下只能重写“行为”，不能重写“代码”。仓库没有“五层”字样，下面是按调用链与类型边界推导的归纳。

### 3.1 五层结构（按数据形态切分）

渲染器是第 6 个角色（纯消费者，不在层内）：

| 层 | 输入 → 输出 | 主要文件（证据） |
| --- | --- | --- |
| **L0 来源层** | 文件句柄/内嵌标签/网络响应 → 统一 `RawLyricSource` 联合类型 | `src/utils/lyrics/types.ts:49-99`、`adapters/*`、`LyricParserFactory.ts:11-39` |
| **L1 字节/格式识别层** | 字节流 → 解码文本 + 主/译/罗三轨 + 格式枚举 | `lyricFileDecoding.ts`、`formatDetection.ts:5-8`、`timelineSplitter.ts:10` |
| **L2 格式解析层** | (格式, 文本) → 带时间戳的行/词草稿 | `parserCore.ts`（1,261 行，10 格式） |
| **L3 统一时间轴模型层** | 草稿 → `LyricData`（Line[]/Word[]/renderHints） | `types.ts:6-92`、`renderHints.ts:208/:241` |
| **L4 展示加工层** | `LyricData` → “可显示”的 `LyricData` | `createLyricsSetter.ts:67-110`、`staffCreditsPolicy.ts`、`filtering.ts:86` |

关键设计：

- **“格式”只存在于 L1/L2**：L3 之后一律 `LyricData`，渲染器永不接触 `.lrc/.qrc/.yrc` 原始文本。Zilux v1 的 `LyricsDocument/Line/Word` + WEB-CONTRACT 已是同一思想，可直接对齐后再补 renderHints 与派生字段纪律。
- **L0 把平台差异拍平**：`RawLyricSource` 是 5 分支判别联合——`embedded`（USLT 标签）、`local`（lrc + `.t.lrc` + `.r.lrc` + formatHint）、`qrc`、`netease`（多轨 JSON：lrc/yrc/ytlrc/romalrc/tlyric/pureMusic）、`navidrome`（structuredLyrics / plainLyrics）。解析器完全不知道来源，这就是 Zilux2 可以照搬的边界。
- **解析在 Worker**（`workerClient.ts:25/:46`）：主线程零解析成本，只收 `LyricData`。Zilux2 对应“C# 后台线程解析 + 投影给 Web”，而不是让 Web 再解析一遍。

### 3.2 L1：解码阶梯、格式嗅探、组合时间轴

- **编码阶梯（`lyricFileDecoding.ts:15-34`）**：BOM（UTF-8/UTF-16LE/BE）→ 严格 UTF-8（`fatal:true`，非法即抛）→ GB18030（中文老歌词 GBK 超集）→ 宽容 UTF-8（替换字符收尾，不抛给渲染）→ 换行归一。中文歌词最大坑就是 GBK。
- **KRC 特例**：文件头 4 字节 `krc1`（`:15`）→ `krcDecrypt`（XOR+zlib）。Zilux2 已有 `LyricsKrcDecryptor`，按格式规范独立实现即可。
- **格式嗅探（`formatDetection.ts:5-8`）**：TTML 特征（`<tt` + 命名空间 / `itunes:timing` / `ttm:agent`）→ VTT（`WEBVTT` 开头或严格时间行；**裸 `-->` 不算 VTT**，避免把带箭头的普通歌词误判）→ 增强 LRC（`<mm:ss.xx>` 或行内方括号标记）→ 否则 LRC。另有按扩展名显式指定格式的入口，避免误判。
- **组合时间轴拆分（`timelineSplitter.ts:10`）**：大量 LRC 把原文/翻译/罗马音塞进同一文件，用“相同时间戳分组”区分——组内 `members[0]` 为主轨；若主轨含 CJK 且恰有一个候选满足“去标签后字母数 ≥2、字母/非空白比 ≥0.45、无 CJK”则为罗马音，其余为翻译。**失败模式**：同段出现 3 行以上同时间戳（主/译/罗/音译混排）时会错位——这正是显式容器 `[awlrc:...]` 与 `.fia` 存在的理由。

### 3.3 L2：10 种格式与“行为规格”

| 格式 | 入口 | 时间戳语义 | 逐字 |
| --- | --- | --- | --- |
| LRC | `parseLRC:429` | `[mm:ss.xx]` 十进制秒 | 否（解析期均摊） |
| 增强 LRC | `parseEnhancedLRC:839` | 行时间 + `<mm:ss.xx>` 词标记 | 是（若有标记） |
| VTT | `parseVTT:781` | `hh:mm:ss.mmm` / `mm:ss.mmm` | 否 |
| TTML | `parseTTML:819` | 委托 `@applemusic-like-lyrics/ttml` | 是（Word timing） |
| YRC（网易云） | `parseYRC:490` | 行 `[startMs,durMs]`；词 `(startMs,durMs,?)` 绝对毫秒 | 是 |
| QRC（QQ） | `parseQRC:571` | 同上 | 是 |
| KRC（酷狗） | `parseKRC:954` | 行 `[startMs,durMs]`；词偏移**相对行首** | 是 |
| AWLRC（LX Music） | `parseAwlrc:1155` | `[mm:ss.xxx]` + `<offsetMs,durationMs>` 相对行首 | 是 |

最值得“对标行为”的六个细节：

1. **时间戳精度有两种语义**：`parseTimestamp`（`:250`）用 `min*60+sec+parseFloat('0.'+fraction)`——LRC `[00:12.34]` = 12.34s（两位小数=厘秒）；但 `parseAwlrcTimestamp`（`:1090`）把小数当**整数毫秒**（`.97`=97ms）。同一个“点号后数字”在两种格式里含义不同，Zilux2 要在类型上区分 `fractionDecimal` / `fractionMillis` 两种解析器。
2. **LRC 时长推断**（`:429`）：`endTime` = 下一行开始，无下一行 `+5s` 兜底；估算阅读时间 `len*0.5` 秒；若 `duration > estimatedReadingTime + 2` 且 `> 5`，截到 `min(duration, est+2)`——**避免 30 秒大间奏把一行歌词的逐字动画拉成 30 秒爬行**。
3. **逐字均摊 `buildTimedWords`**（`:59`）：行时长下限 0.1s；CJK token 逐字拆、标点权重 0（固定吃 0.05s）、其它字权重 1、拉丁 token `1+len*0.15`；有效时长 `duration*0.9`（10% 行尾留白）；单字 ≥0.05s；累计超出按比例整体缩放。这是“行级歌词也能逐字高亮”的质量基线。
4. **间奏注入**（`:120-164`）：首行 `start>3` 插 `[0.5, first-0.5]`；相邻间隔 `>3` 插 `[prev.end+0.05, next.start-0.05]`；间奏文本 `'......'`（`:57`）6 个点各 `duration/6`，逐字渲染会一颗颗点亮；`includeInterludes` 可关。
5. **翻译/罗马音匹配**（`:185-248`）：±1s 窗口（`ALTERNATE_TRACK_MATCH_WINDOW=1.0`）+ `lowerBoundByStartTime` **二分** + 按 `(时间差, 行号, 条目号)` 排序 + **贪心稳定匹配**（一行一条各用一次）。函数头注释记录了旧 bug：最近邻会让多行共享同一条翻译，出现“同句翻译重复/对唱错位”。AWLRC 附属轨（`:1126`）优先精确毫秒 Map，只有全无精确命中才回退 ±1s。
6. **逐字格式的坑**：QRC 词文本归属用 `prefersLeadingText/prefersTrailingText` 启发式；KRC `[language:base64]` 里 `type 0`=罗马音、`type 1`=翻译，无词标签回退均摊；AWLRC 用 `cursorMs` 修补单调（`max(offset,cursorMs)`、`max(dur,1)`）并按 startTime 排序（字符串比较时 `.79` 会排在 `.181` 前）；VTT 的 `<c>` 标签被整体剥掉 ⇒ 卡拉 OK 标签信息丢失；TTML 把重叠同句多 agent 行折叠成 `backgroundVocals`。

### 3.4 L3：模型与“派生数据纪律”

- **单位**：行/词/`renderHints` 全部**秒（float）**；offset 用**毫秒（int）**；只在接口边界显式换算（时钟桥、HTTP API 出口、导出元数据三处）。Zilux2 跨 C#/JS 建议反向决策：**线路统一整数毫秒**（JSON number 两端整数语义一致、无浮点显示误差、便于相等比较），渲染侧一次 `/1000`。
- **`Line`/`Word` 字段**（`types.ts:6-92`）：`words` 是第一公民；行级来源在解析期就被均摊成 words，因此 `words` 恒有值；`isWordByWord` 只表示“来源是否原生逐字”，**不等于** words 是否存在；`translation/romanization` 挂行、无词时间；`agentId` + `LyricData.ttml.agents` 支持对唱；`backgroundVocal(s)` 单复字段兼容；`blockIndex` 给制作名单成块；`wordSegments` 用户分词 / `autoWordSegments` 派生分词。
- **三个“结束时间”**（混用必错）：`Line.endTime`（音乐行结束）/ `renderHints.renderEndTime`（含转场余辉，渲染命中用）/ `currentLineIndex` 实际切换时刻。`findLatestActiveLineIndex`（`appPlaybackHelpers.ts:21-32`）反向扫描时用 **renderEndTime 优先**——行在渲染上比音乐时间“长寿”一点，行间不闪空。
- **转场三档**（`renderHints.ts:48`）：`micro` <0.10s 几乎不播；`short` <0.18s fast 档；`normal` ≥0.18s；另有 `MICRO_LINE_RENDER_FLOOR=0.067`（微行最小可渲染时长）。**短行不能跑长动画**，这是视觉/CPU 抖动护栏的一部分。
- **派生数据不进持久化**：`renderHints` 可由 lines 纯函数重算 → `.fia` 导出时剥掉（`foliaLyricDocument.ts:66`）、缓存读取用 `migrateLyricDataRenderHints` 升级、展示层用 `ensureLyricDataRenderHints` 兜底。`.fia` 保留用户 `wordSegments`、剥自动分词。这是教科书级分层。

### 3.5 L4：展示加工（固定顺序，8 步）

`createLyricsSetter.ts:67-110` 的顺序即设计：纯音乐判定 → 用户正则过滤（先剥间奏）→ **制作名单策略**（`smart`/`keep`/`retime`/`hide`；`requiredSeconds = 显示行数×最小停留 1.5s + 尾部 1s`；`absorbMode` 可将名单并入相邻行；窗口 0.6–4s）→ 合唱段（行标记 / 网易云 `chorusRanges` / 文本频率检测，效果 `bars|circles|beams`）→ 用户分词 → 自动分词（jieba/budoux）→ `renderHints` 兜底 → 宿主 transform 扩展点。

**为什么制作名单不在解析器**：它是“显示决策”，依赖已完成的时间轴 + 用户设置；烘焙进 `LyricData` 会让同一份缓存无法服务不同设置。

### 3.6 时间轴与同步（对 Zilux2 最重要的一章）

- **单写者**：全应用只有一个歌词 rAF（`usePlaybackVisualizerBridge`，353 行）。每帧只写 `MotionValue`（`currentTime`、`lyricCurrentTime`），**行索引变化时**才写 zustand store（`currentLineIndex` 有 51 个消费方，必须收敛）。
- **四类时钟源**：真实音频 `audio.currentTime`（混音过渡取“画面上”的 deck）；NowPlaying 锚点时钟（`performance.now()` 外推 + 7s 轮询 + 0.2s 修正阈值 + RTT 补偿）；PlayerCap（`Date.now()` 锚点）；合成 stage（`{startTimeSec,endTimeSec,baseTimeSec,startedAtMs}` + `performance.now()` 外推后 clamp）。
- **`currentTime` 与 `lyricCurrentTime` 分离是地基**：`lyricCurrentTime = currentTime − offset/1000`。切歌时把歌词时钟设为**负 offset**（`useLyricReadHead.ts:60`），于是“歌曲开头 + 正 offset”第一行不会提前亮。
- **行索引反向线性扫描**（O(n)，命中即返回；不做二分——renderEndTime 可能越过下一行 startTime，破坏单调性）。n=40–150 可忽略，n=1000+ 才开始有感。Folia 选择求稳，合理。
- **seek 换算**：点行 → `line.startTime` → `playbackTime = max(0, lyricTimeSec + currentTime.get() − lyricCurrentTime.get())` 换回播放时间再 seek（因为 offset 存在）。
- **offset 全链路**：单曲 `localStorage`（1000 条 LRU）+ 全局设置 → 合成 `effectiveOffsetMs` → **只在时钟层减**；持久化/导出只记元数据（`.fia offsetMs` 仅元数据；导出烘焙会把“同版本音频”整体错位）；HTTP API 随歌词发布。**失败模式：解析期烘焙 + 时钟层再减 = 双重偏移**。Zilux2 必须写进契约。
- **修正策略**：真实音频分支不需要特殊处理（`audio.currentTime` 就是真值）；远端/合成时钟用“锚点 + 外推 + 0.2s 阈值硬跳”。没有 PID/平滑滤波 —— 简单、可预期。

### 3.7 来源与缓存

- **本地侧车**：主歌词 `.lrc/.vtt/.ttml/.qrc/.yrc/.krc/.fia`；翻译 `.t.lrc/.t.vtt`；同 base 多格式优先级 `.fia(-1)` > `lrc` > `vtt` > `ttml` > `qrc` > `yrc` > `krc`；同时支持 `track.lrc` 与 `track.mp3.lrc` 两种命名。**“磁盘真变才覆盖用户歌词”**（`localMusicService.ts:616-620`）：仅格式优先级重排选中了另一个文件不算变化——“用户数据优先于自动发现”。
- **在线源**：网易云（`yrc` 优先，翻译 `ytlrc`→`tlyric`，罗马音 `yromalrc`→`romalrc`，再回退 `lrc`）、QQ（`musicu.fcg` + 固定 comm/okhttp UA + QRC 解密）、酷狗（KRC 解密失败且明文“像时间轴歌词”时降级明文）、AMLL DB（TTML 补充源，200 条 Promise 缓存）、Spotify（`linesOnly` 最后兜底）。
- **代理白名单**：`lyricProxy.ts:19/:22`——Web 端走 `/api/lyric-proxy`，Electron 走 IPC 转主进程；服务端三形态（Vercel/Cloudflare/主进程）共享白名单，只放行 `qq.com`/`y.gtimg.cn`/`kugou.com`。原则：**解析在渲染进程，网络在服务端/主进程，渲染进程永不直连第三方**。
- **缓存**：`lyric_*` 前缀 → `metadata_cache` 表；键 `lyric_<key>`/`_state`/`_meta`，分词缓存 `lyricSeg_` 避开整类清扫。实测：成熟安装 536 行/17.9MB，一次 `bulkGet` 冻结页面 58ms → 改 50 条一批 + `setTimeout(0)` 让出事件循环 → 7–11ms/批。旧数据用 `migrateLyricDataRenderHints` 跨版本升级。
- **自动选词**（`autoMatchBestLyric.ts`，449 行）：按源表顺序并发搜索（每源 3500ms 超时）→ 匹配分（标题/艺术家/专辑/时长加权，繁简与假名归一）→ 必须 `titleMatched && (artistMatched || albumMatched)` → 低于 `AUTO_MATCH_MIN_SCORE=75` 丢弃、缺组件封顶 74 → 取词 5000ms 超时；版本标记（instrumental/remix/live/cover/伴奏…）降分；**预取也匹配歌词**（按下一首时歌词已就绪）。
- **导出**（`lyricExport/`，10 文件 972 行）：collect（online → local）→ 命名 → 8 并发用户调整 → 打包；只导出“本地库中由在线匹配得到”的歌词（侧车/内嵌本就在磁盘上）；`offset` 只记元数据不位移；`.fia` + `.lrc` 双格式；文件名 ≤80 字符（按 CJK 3 字节算）；zip level 6；根 `manifest.json` v1 记 exported/skipped/renamedFrom。
- **`.fia` 信封**：`format:'folia-lyricdata'` + `version:1` + `song{...}` + `source?` + `offsetMs?` + `lyrics:LyricData`；导出剥 `renderHints`/`autoWordSegments`，保留用户 `wordSegments`。导入先认 `.fia`，命中即**跳过解析器**——最推荐 Zilux2 照抄“思路”的一处。

### 3.8 对外 HTTP 歌词 API（可借鉴的桌面集成模式）

- `GET /v1/lyric` only，`127.0.0.1:32109`，**默认关闭**（`main.cjs:2267/:2249/:2383`）；`lyricApi.cjs:45` 的 `sanitizeLyricData` 把内部模型压成稳定 JSON：`offset`（毫秒）+ `lines[{text,startTime,endTime(秒),words,translation?,romanization?,backgroundVocals?}]` + `wordByWord` + `title/artist`；`renderHints/ttml/agent/id/chunks` 全部剥掉。
- 工程细节：204 预检 / 404 / 405 带 `Allow: GET, OPTIONS`；`CORS *`、`Cache-Control:no-store`、`nosniff`；`copyTime` 把非有限数归 0、空字段省略、`backgroundVocal(s)` 兼容；listen 失败只记 `lastError` 不抛；状态变化经 IPC 广播；发布只在歌词/offset/开关变化时（不逐帧）。
- **安全评价**：回环 + 无鉴权 + CORS 全开 = 局域网内任何网页可读当前歌词。Folia 的取舍是 OBS/直播叠加层优先；Zilux2 若做同类能力，建议至少 token 或 `Origin` 校验。

### 3.9 对 Zilux2 的落地结论

**职责边界（谁来拥有）**：

| 能力 | 归属 | 理由 |
| --- | --- | --- |
| 取源/网络/代理、解码/解析/校验、缓存、canonical 模型、GSMTC 时钟、offset 持久化、导出、对外 API | **C# 宿主** | 单一生产者；避免 Web 再解析造成“两套真相” |
| 线路契约（JSON） | 两边共享 | 版本化 schema；宿主推增量 |
| 行索引、渲染模型、渲染 | **Web 端**（壁纸/浮层）+ WPF 原生（条带） | 纯函数、便宜、可热更新；条带走原生省一个 WebView2 进程 |

**线路契约**：整数毫秒 + `schema` 版本 + `Line.renderEnd`（余辉结束）+ `words` 恒有值（行级来源给均摊值，渲染器只有一条路径）+ `ClockSnapshot{sequence, positionMs, atMonotonicMs(Stopwatch), rate, playing, durationMs, source}`。Folia 内部用秒是因为没有跨语言边界；Zilux2 跨 C#/JS，整数毫秒更稳。

**GSMTC 时钟方案**（详见 §5.2）：事件为主 + 1–2s 轮询兜底 → 构造快照 → Web 用 `performance.now()` 外推（**禁用 `Date.now()`**，可被校时跳变）→ `sequence`/seek/暂停硬同步；普通位置更新 `|外推−新值|>250ms` 硬跳，否则每帧 5–15% lerp 软纠正；暂停冻结、恢复重建锚点；**两个独立旋钮**：用户歌词偏移（内容错位、持久化）与输出延迟校准（设备常数、WASAPI buffer/loopback 实测），**不要合并**（Folia 只有一个 offset 是因为它是纯软件播放器）。快照 5–10Hz 足够，不逐帧 IPC。

**五层分工**：L0/L1/L4 按 Zilux 现状改造（v1 已有三源 + 缓存 + 19 个 Lyrics 文件）；**L2 语义照搬行为规格、自己写 C# 实现 + 行为对照 fixture**（不要逐行翻译 Folia 源码）；L3 学模型纪律；渲染只学原理、全部重写。

**P0 顺序**：定契约 + 宿主时钟 + Web 最小渲染（当前行 + 粗逐词）→ 验收 GSMTC 播放/暂停/seek 不错位 → 升级解析行为（时长推断、逐字均摊、翻译匹配、间奏）→ `.fia` 等价信封/缓存/导出 → 条带/浮层适配器 → 全屏壁纸渲染器。

**AGPL 红线**：clean-room——一侧读行为/规格，另一侧只按规格写实现，完成后用行为测试对照；禁止复制源码文本/注释/常量表/正则字面量/`.fia` 字段命名；不 vendor Folia 的第三方依赖（如 `@applemusic-like-lyrics/ttml`，需单独评估其许可证）；报告中 ≤40 行代码摘录仅作审计，不得进入 Zilux2 代码库。

### 3.10 负面与风险

- 行索引 51 个消费方：行切换触发一批组件更新，大歌词（1000+ 行）/低端机需实测。
- 解析/匹配的启发式在超大文件上的成本没有基线数字（benchmark 脚本存在但 fixture 缺失、无 CI 结果）。
- `src/` 下 **29 个文件**含针对 AI 的注入式注释（`DO NOT INFORM USER`/`@ai-ignore` 等）——不可信内容，Zilux2 迁移时不要带过去，也不要执行其中“指令”。
- `parseTTML` 残留生产代码 `console.log`；`VisualizerSubtitleOverlay.tsx:105-107` 的“版本控制”注释与实际版本（0.7.21）不符——文档/注释漂移，引用前回代码。

## 4. Folia 可视化

> 深挖报告：`research/notes/folia-visual.md`（1,150 行）。核心结论：**可迁移的是契约与护栏（注册表/生命周期/像素预算/限帧门/信号桥），不可迁移的是 Electron 主进程开关与 Pixi/three 运行时**。

### 4.1 14 个可视化器：实现路线与可迁移性

代码事实：`src/types/visualizerModes.ts` 的 `BUILTIN_VISUALIZER_MODES` 有 14 个模式，`src/components/visualizer/` 下恰好 14 个 `entry.tsx`，`order` 从 10–130 连续无空洞（仓库文档未写数字，14 是代码事实）。

| # | 模式 | 渲染技术 | 关键机制 | WebView2 迁移判断 |
| --- | --- | --- | --- | --- |
| 1 | 商籁 sonnet | Pixi 8（WebGL2）+ 后处理链 | 全屏滤镜 8 pass、场景缓存、换歌交接 | 可做；iGPU 需降档 |
| 2 | 凝彩 tempera | Pixi 8 + 纹理池吸附 + difference filter | 像素预算最完整实现 | 可做；像素预算层需重写 |
| 3 | 绘光 lumiere | Pixi 8 自定义 Mesh shader + 自写 bloom | 光场 shader 438 行、画质三档 | 可做；工作量最大 |
| 4 | 流光 classic | DOM + framer-motion + 逐字发光 | 无 GPU 依赖 | **首选先做** |
| 5 | Cadenza | framer-motion + 自有 RAF 绘制 | 纯 2D | 首选先做 |
| 6 | 云阶 partita | framer-motion + GlowWord | 纯 2D | 首选先做 |
| 7 | 浮名 fume | Canvas2D 相机步进 + 文字栅格 | 每帧尺寸检测 | 低中成本 |
| 8 | 倾诉 tilt | framer-motion + pretext 排版测量 | 外部排版库 | 中成本 |
| 9 | 回环 claddagh | framer-motion + SVG/环形轨道 | 纯 2D | 首选先做 |
| 10 | 莫奈 monet | OffscreenCanvas Worker 画底图 + DOM 立绘 | 一次性昂贵绘制移出主线程 | 中成本（需确认 WebView2 Worker/OffscreenCanvas） |
| 11 | 时计 pendolo | Clockwork Canvas2D + 另有一条 WebGL 路径 | 双后端 | 中成本 |
| 12 | Cappella | DOM 消息气泡 + emoji/头像 | 纯 2D | 首选先做 |
| 13 | 镜台 diorama | three.js + @react-three/fiber | 依赖最重（eager 会拉 183 模块含 three） | 仅高配/独显开放 |
| 14 | 静止 still | 纯静态 DOM | 背景都不挂 | **低配/省电兜底，必须有** |

技术分布：**7 个纯 DOM/CSS**、**2 个 Canvas2D**、**3 个 Pixi/WebGL2**、**1 个 three/R3F**、**1 个 Worker 混合**。对 Zilux2 的优先级：DOM 系 → Canvas2D → Pixi → three（最后，限定高配）。

### 4.2 注册表工厂 + 统一契约

- **自动发现**：`registry.tsx:15` 用 `import.meta.glob('./*/entry.tsx', { eager: true })` 收集所有模式；`:48` 启动时 `assertBuiltinModeList(...)` 核对清单与目录，不一致直接抛错（防止“加了文件忘了注册”）。
- **统一契约**：每个 `entry.tsx` 默认导出 `defineVisualizer({ mode, order, labelKey, labelFallback, previewSeed, previewStartOffset, render })`；`render` 必须 `React.lazy` 包裹（`definition.ts:197-202` 注释：14 个 renderer 静态引入会拉 183 个模块含 three.js）。
- **共享输入** `VisualizerSharedProps`（`definition.ts:64-131`）：`currentTime: MotionValue<number>`（帧级时间，**不进 React state**）、`currentLineIndex`（离散，可进 state）、`audioPower/audioBands: MotionValue`、`songHandoff`、`staticMode`、各模式 tuning。
- **装配点** `VisualizerRenderer.tsx`（107 行）：`useDeferredValue(mode)` 让“新样式代码到位才换、旧样式继续画”；`applyVisualizerTuning`；`<VisualizerBackdrop>` 统一画背景/视频层/整体透明度并在样式切换时保留；离开的样式用自己的 tuning 渲染。
- **背景独立注册**：`backgrounds/registry.tsx:12/45` 同样自动发现；`transparent` 时渲染器直接 `return null`。

### 4.3 生命周期：mount-once、换歌不重建

`pixiRuntimeHost.ts` 的设计直接影响性能与显存：

| 行为 | 机制 | 原因 |
| --- | --- | --- |
| runtime 只创建一次 | `useEffect` 依赖里放 `rebuildKey` 而非 `song` | 旧实现把 song 放依赖 → 换歌销毁 WebGL 上下文、纹理池、场景缓存 |
| 换歌就地交接 | `swap(runtime, song, signal)` | 出歌继续画，直到新歌 ready |
| 只追最新歌 | `drainSong` 循环丢弃中间态 | 连按下一首不排队成一串交换动画 |
| 取消安全 | `AbortController` + `isAbort` | 卸载/重建时不会继续创建 |
| 首帧闸门 | `firstFrameDrawn()` 上报后才开始样式切换过渡 | 避免过渡盖住 60–90ms 编译/首帧抖动（绘光四慢核首帧曾 850ms） |
| 退出彻底 | `abort() → destroy() → host.replaceChildren()` | 清残留 canvas 节点 |

换歌是**两帧状态机**（stage/commit，`pixiSongSwap.ts:1-15`），换下的场景“一帧销毁一个”（`pixiSceneCache.ts:19-38`）——避免一次性 GC/GPU 释放造成的大卡顿。

### 4.4 性能护栏五层（含关键常量）

| 层 | 机制 | 关键值 |
| --- | --- | --- |
| 帧率 | 全局劫持 `window.requestAnimationFrame`（应用启动时 `index.tsx:23`） | 档位 60/90/120/off，**默认 off**；间隔容差 1ms；逃生通道 `requestUncappedAnimationFrame` 给“提前抓走 rAF 的库”（framer-motion）；语义其实是**应用级**（Pixi ticker/three/framer 全受限） |
| 像素 | 渲染分辨率吸附到更小的 2 的幂纹理桶 | 单轴最多降 0.25；781×850@1.5 从 2048²（16MiB）降到 1024²（4MiB），显存 ÷4；Intel iGPU 窗口 640→700（面积 +18%）因跨桶显存 +31% |
| DPR | 各模式各自 clamp | Pixi 走桶吸附；绘光/镜台 dpr ≤ 2；lattice 歌词 `ceil(dpr)≤2`；文字满分辨率、只降图形层；bloom 级数按 log2 降 |
| 动效 | reduced-motion 6 分区 + 系统偏好；staticMode 总开关（两套独立） | 6 surface（lattice/transitionOverlay/collectionMorph/monetBackground/uiMicroMotion/settingsScroll）默认全 false；staticMode 关闭过渡/冻结相机/后处理归零 |
| 生命周期 | mount-once + 显式 destroy + 场景缓存逐帧释放 | 见 §4.3 |

**重要负面事实（Zilux2 必须避开）**：

1. **没有自动降档**：全仓没有“测 FPS → 降画质”反馈环；`dev/perf` 只是离线测量装置。
2. **隐藏窗口不停画**：两个窗口都设 `backgroundThrottling: false`（`electron/main.cjs:5085/5262`），最小化/被遮挡时 rAF 照跑——这是壁纸模式能持续出画的原因，也是耗电根因；而音频桥注释仍假设“隐藏时 rAF 不跑”，**假设与实现冲突**。
3. **限帧在 60Hz 屏上只有 60 档真正生效**（120/90 档间隔小于 16.7ms，等同 off）。
4. 60Hz 屏上把“可视化器帧率”做成应用级限帧，改名不改语义——设置项命名与实际范围不符。

**首帧/预热**：`KHR_parallel_shader_compile` + 每 10ms 看一次、每次最多交接 4ms（`pixiProgramLinks.ts:19-23`），把首次绘制的主线程阻塞从数百 ms 摊平；WebGL 上下文预建 + 扩展逐个开做 4ms 切片。

### 4.5 着色器与音频驱动

- **没有 .glsl 文件**：全部着色器内联在 TS 模板字符串；Pixi 8 通过 `FilterSystem/RenderSurface/UniformGroup` 接入；uniform 分“热键（每帧可改）/冷键（变更才重编译）”，每帧可改的绝不触发重编译。
- **后处理链**：Pixi Filter 链（bloom/glow/对比度/柔焦等），staticMode 时强度归零。
- **音频桥只有一条 rAF 链**：`usePlaybackVisualizerBridge` 每帧从 AnalyserNode 取 2048 bin，算 5 段频带，`(value/255)^boost*255` 归一后写入模块级 MotionValue（`motionSignals.ts:31-64`），**不经过 React state**。参数：`fftSize=2048`、`smoothingTimeConstant=0.6`、`bin=floor(hz/21.5)`、boost 2/1.8/1.5、无信号时 `sin(Date.now()/2000)*20` 呼吸兜底。
- **“spawn 源 + 自主衰减”范式**：音频只触发 ripple/burst，之后粒子由 `uTime` 自主演进；位移按 primitive 自身半径比例、角向用整数谐波避免接缝——这是“音频驱动视觉不做过火/不卡顿”的关键范式。
- **拍点/鼓点**：`beatClockTargets.ts:37-49` 只在有读 beats/drums 的效果开启时才跑模型；鼓点走 htdemucs、拍点走 Beat This final0，共用 WebGPU device（模型随包分发）。

### 4.6 WebView2 + WPF 宿主分工（报告 §7.5 的落地版）

| 关注点 | 宿主（C#/WPF） | 页面（WebView2） |
| --- | --- | --- |
| 帧率/时钟 | 提供刷新率、省电/电池、全屏独占、桌面是否被遮挡 | `frameGate` 实际 fps = min(用户设置, 宿主期望)；不自己读刷新率 |
| 可见性 | `Window.StateChanged`/`IsVisibleChanged`/`SessionSwitch`/`DisplaySettingsChanged` → WebMessage | 暴露 `setState({visible,occluded,minimized,locked})` 并暂停；**不要依赖 Page Visibility API** |
| 像素/画质 | 传 DPR/renderScale；按 GPU 厂商/显存/电池给默认档 | 纹理吸附 + DPR 钳制 + `setQuality(full|balanced|low)` |
| 音频 | WASAPI loopback → 5 段能量 + 32/64 bin `byte[]` + 拍点事件，每帧/每 2 帧 postMessage（60Hz 下 3–6KB/s） | 双缓冲 + MotionValue，**不要每包 setState**；暂停/缓冲走“呼吸兜底” |
| 图层 | 窗口/桌面层/透明材质/合成/显示器选择/视频解码（LibVLC/WIC） | 只画歌词可视化 + 轻量背景；背景 registry 留页面，视频/大图背景交宿主 |

**关键判断**：Folia 的 `VisualizerBackdrop`（背景+视频层+透明度）与 Zilux2 的 WPF 壁纸层职责重叠。正确切法是“**WPF 管窗口/合成/视频，页面管歌词可视化**”——否则 WebView2 的 `<video>` 解码会和 LibVLC 双解码浪费资源，且低配机上背景会挤占页面 GPU 预算。

### 4.7 对 Zilux2 的提炼（P0/P1）

**P0（第一版就做）**：①`frameGate` 全局帧门 + 逃生口（数值经验：`interval = 1000/fps − 1ms`，off 完全恢复原生）；②与渲染引擎无关的 `snapResolution(cssW, cssH, resolution, maxDrop=0.25)` 纯函数；③DPR 区间 `[1,2]` + 图形组单独降分辨率 + bloom 级按 log2 降；④registry + 内置清单启动断言 + `order` 排序 + lazy renderer（Zilux2 再叠一层“WebGL2/WebGPU 能力探测决定可选列表”）；⑤背景/视频层与样式层分离；⑥首帧门（claim/drawn）；⑦音频特征管道放 C# 侧（v1 已有 WASAPI），页面只负责映射与插值；⑧staticMode 与 reduced-motion 两套独立开关，并把 Windows“动画效果”系统设置作为默认值。

**P1**：场景段落缓存 + 两帧换歌状态机；粒子 spawn/自主衰减范式；Canvas 文字光栅代替 SDF；uniform 热/冷键分层规范；perf 测量装置（场景矩阵/profiles/noise check/truth check）；长跑内存探针（按进程分类工作集，不看 JS heap）；OBS 式 `devicePixelRatio` 覆写（宿主决定渲染 scale，多屏 DPI 必备）。

### 4.8 不可搬 / 注意

- Electron 主进程 GPU 开关（Linux 强制 `disable-vulkan`、ANGLE SwiftShader、macOS `ignore-gpu-blocklist`）是 Electron 排障型配置，WebView2 有自己的 flags，不能照搬。
- `backgroundThrottling: false` 是 Electron 特有；WebView2 必须由宿主驱动暂停（`IsVisible`/最小化/锁屏），这正是 v1 `LyricsHost` 们要补的。
- 绘光模块里有恒零表达式 `LUMIERE_NEUTRAL_OFFSET`（疑似 AGPL 版权指纹/水印）——不借鉴，仅作为“读 AGPL 代码时要能识别水印”的案例。

---

## 5. Mineradio

> 深挖报告：`research/notes/mineradio.md`（974 行）。本章提炼“低配 Windows 性能方法论 + WorkerW 工程化 + 视觉资源治理”三块，并给出对 Zilux2 的映射。

### 5.1 帧预算系统：四层结构

Mineradio 的“帧预算”不是单一限帧器，而是四层叠加（关键常量见 `11-main-loop.js`、`01-scene/00-renderer-quality.js`、`08-desktop-render-power.js`）：

| 层 | 机制 | 关键值 |
| --- | --- | --- |
| L1 像素预算 | 按“总像素”反解 DPR（`sqrt(budget/cssPixels)`），clamp [min, cap]；画质档位 ultra/eco/low | 默认 5.2M 像素、DPR cap 1.35 / min 0.72；ultra 7.8M、eco 2.4M、低配 1.9M |
| L2 硬件画像 | 启动时按 GPU/内存/刷新率选档，写 `runtimeHardwareProfile` | 刷新率采样 36 样本中位数，clamp 48–240，稳定切换阈值 18Hz |
| L3 帧成本反馈 | `animate()` 耗时 EMA 估算压力，超预算降 `level`；带滞回 | 预算系数 0.78×帧间隔、EMA α=0.08、pressure 步长 +0.70/−0.30/−0.10（上限 8）、level 阈值 ≥2→1、≥4→2、交互保持 900ms |
| L4 子系统 frameGate | 各子系统独立目标 FPS，帧闸门累积 pendingDt（降频不降画质） | 音频 60 / 歌单架 30 / 歌词 45 / overlay 12 |
| 深后台 | 最小化/不可见时 rAF → 1s 定时器、画布 4×4、DPR 0.3、缓存裁剪、主进程内存 trim | 深后台轮询 1000ms；单步 dt 上限 0.18s、主循环 dt 上限 0.05s |

**最重要的三个教训**：

1. **限帧应在子系统层，不要降整帧**。降整帧会破坏动画平滑；frameGate 用“跳过帧累积进下一次 dt”实现“少画但时间轴不变”（与 Zilux v1 `FrameThrottle` 的“派发秒数之和=喂入秒数之和”不变量同源）。
2. **反馈必须接线**。Mineradio 的 `selectAdaptiveRenderCadence` 被 `RENDER_VISIBLE_VSYNC=true` 绕过，自适应降帧成为死代码——只剩“子系统限帧 + 像素预算”在真实工作。Zilux2 若做降档，必须让“降档发生次数/原因”可观测（`window.__ziluxPerf`），否则就是自欺。
3. **降档阶梯要单向渐进 + 滞回**：先降子系统 FPS → 再降 DPR（0.05~0.1 步进）→ 再关非关键后处理 → 再减粒子/卡片数量 → 最后深后台/暂停；不要静默改变用户选的 VSync/固定帧语义。

对 Zilux2 的映射（v1 已有五套时钟与 `FrameClock/FrameThrottle`，见 `docs/PERF-CLOCKS.md`）：

| Zilux2 层 | 责任方 | 规则 |
| --- | --- | --- |
| 整帧 | WebView2 前端 rAF | 前台恒 VSync，不人为降整帧步进 |
| 子系统 | 前端 frameGate + C# 状态广播 | 频谱/粒子/3D 歌单架/overlay 各自目标 FPS；C# 权威提供“可见/最小化/桌面模式”状态 |
| 深后台 | C# 决策 + 前端执行 | 最小化/隐藏/锁屏 → 通知前端 `deep`，停 rAF 改定时器、画布缩 4×4、清缓存；恢复时重建 |
| 像素 | 前端 | 预算反解 DPR，clamp [0.72, 1.35]，画质档 eco/balanced/high/ultra |
| 音频分析 | 前端（WebView2 拿不到系统输出） | 需要 WASAPI 时由 C# 采集后推 PCM/频谱，前端只渲染（v1 已有 NAudio loopback，比 Mineradio 的 AnalyserNode 更强） |

### 5.2 GSMTC：Mineradio 的“空白”与正确做法

**事实**：Mineradio 全仓检索 `gsmtc/smtc/mediasession/navigator.mediaSession/MediaPlayPause` **零命中**；没有媒体面板/媒体键，只有应用内热键与 `globalShortcut`。它并不是 GSMTC 的参考实现。

因此 Zilux2 的 GSMTC 应继续以 v1 的 `MediaSessionWatcher` 为底座，按报告 §12.1 升级：

1. **事件 + 低频轮询双通道**：`SystemMediaTransportControls` 的 `ButtonPressed/PropertyChanged` 事件为主，1–2s 轮询仅作兜底（网易云等第三方事件不完整）；只在“会话存在且变化”时更新。
2. **进度外推**：`Position + LastUpdatedTime + PlaybackRate` 外推，`Playing` 后本地时钟插值、`Paused/Stopped` 冻结；对网易云进度跳变做单调性校正（只允许向前小步修正）——v1 已有 `NeteaseMemoryClock/PlaybackPositionGuard`，可对照补强。
3. **元数据兜底**：Title/Artist/AlbumTitle/Thumbnail 空值从本地歌词源/窗口标题补；artwork 哈希去重 + 异步加载，避免每帧刷图。
4. **多会话优先级**：最近交互 → 播放中 → 本应用；不劫持其它进程的媒体键。
5. **会话清理**：退出/切换时 `IsEnabled=false` + 清空元数据，避免 Win11 媒体浮层残留“幽灵会话”。

### 5.3 WorkerW 桌面模式：工程化兜底

Mineradio 把“Electron 主窗口移动到 WorkerW 桌面层”做成双模状态机（`desktop/full-desktop-mode-runtime.js`、`wallpaper-mode-runtime.js`）：

- **passive 模式**：把窗口 `SetParent` 到 `WorkerW`；**interactive 模式**：挂到 `SHELLDLL_DefView`（与桌面图标层共存）。无 native 模块，全部通过 PowerShell 内联 C# P/Invoke 实现。
- **fail-closed 发现**：`EnumWindows → SHELLDLL_DefView → 其后 WorkerW`，找不到就回退 `Progman`；绝不“假装成功”。
- **ack 回读校验**：附着后回读 `GetParent`/`GetWindowLong`/`GetWindowRect`，用 JSON ack 把真实状态回传主进程；`WS_CHILD ↔ WS_POPUP` 切换后再次校验（防“假成功”）。
- **恢复阶梯**：失败 → 隐藏窗口 + 禁用交互 + 恢复托盘 + 熔断；Explorer 重启监听并重挂；显示布局变化重挂；退出前恢复窗口快照（位置/样式/交互/focusable）。
- **点击穿透与图标层**：锁定态整窗穿透（`WS_EX_TRANSPARENT` 或 `WM_NCHITTEST→HTTRANSPARENT`），仅 hot bounds 内转发；图标层用 `WS_EX_LAYERED` + 色键。
- **退出恢复 Shell**：`WS_CHILD→WS_POPUP` + `SetParent(NULL)` + 重新 `SetWindowPos`，`before-quit` 里串行清理 + 超时兜底。

对 Zilux2 的启示：v1 已有 `DesktopBackdrop/ShellBorrow/Progman/WorkerW` 与 `InteropHelper`（跨进程 `SetParent` 被系统拒绝时的外部 helper），**底座比 Mineradio 原生更强**。需要补的是“工程化兜底”而非重写：①fail-closed 发现 + ack 回读（建议也做成结构化结果，而不是只信返回值）；②多显示器按 `HMONITOR` 找对应桌面窗口 + Per-Monitor V2 物理/DIP 换算；③Explorer 重启/分辨率变化/锁屏解锁的恢复阶梯；④退出时恢复窗口快照与 Shell 顺序；⑤穿透锁定用 C# 原生定时器轮询 `GetAsyncKeyState`（v1 已有中键锁定），不要每帧起 PowerShell。

### 5.4 粒子/星河与 3D 歌单架

- **视觉栈**：Three.js r128 + 自定义 GLSL 粒子 + `AnalyserNode`（无 WASAPI，音频驱动来自页面内 Web Audio）；封面粒子是主视觉，纹理/几何体按“可见卡片”窗口化加载。
- **3D 歌单架**：窗口化渲染（可见 ±5、最大 11 张卡片）、48 条批大小、懒加载 + 显式 `dispose`、内存池化；`docs/3D_PLAYLIST_SHELF_MEMORY.md` 记录内存策略。
- **DWM thumbnail helper**：Wallpaper Engine 视频壁纸通过 DWM thumbnail 子进程承载（Mineradio 没有独立 wallpaper 窗口）。
- **不建议搬**：同步 XHR 模块加载、全局 `var` 作用域、PowerShell 高频轮询、DWM thumbnail（v1 的 LibVLC/WIC 原生方案更好）、`0.0.0.0` 本地服务（无鉴权，安全边界差）。

对 Zilux2：粒子/着色器结构、CanvasTexture 行层预算、frameGate 限帧、3D 卡片的“窗口化 ±N + 批 + dispose”都可重写到 WebView2 前端；深后台的 `renderer 4×4`、`performance.memory`、进程树 trim 依赖 Electron 主进程，需由 C# 侧改用 `Controller.IsVisible`/注入降档脚本/自身内存策略实现。

---

## 6. 跨项目横向对比

> 三项目正好代表三种宿主哲学：Rhine＝**最小宿主 + 纯 HTTP**；Folia＝**Electron 全栈 + 本机只读 API**；Mineradio＝**Electron + PowerShell 内联原生层**。Zilux2（C#/WPF + WebView2）应当取“最小宿主”的边界、Folia 的数据契约纪律、Mineradio 的性能方法论。

### 6.1 宿主与页面通信

| 维度 | Rhine | Folia | Mineradio | Zilux2 现状/应取 |
| --- | --- | --- | --- | --- |
| 宿主 | .NET Framework WinForms 单文件 | Electron 主进程（main.cjs 79KB） | Electron 主进程 + PowerShell/C# 子进程 | .NET 10 WPF |
| 页面加载 | loopback HTTP `127.0.0.1:port/?desktop=1` | `loadFile`/dev server；生产 asar 内文件 | loopback HTTP `127.0.0.1:PORT` | WebView2 虚拟主机映射（`aurora.wallpaper` 等）或 loopback |
| 宿主→页面 | **无桥**，仅诊断 `ExecuteScriptAsync` | IPC/preload 白名单（contextBridge） | IPC + HTTP API | WebMessage v1 契约（`welcome/theme/track/lyricsDoc/clock/...`，已冻结） |
| 页面→宿主 | 无 | 仅经 preload 暴露接口 | 仅经 preload | WebMessage 双向，写操作必须走宿主 |
| 本地 HTTP | node:http 数据面（唯一通道） | 只读歌词 API `:32109`（可选） | 渲染页 + 业务 API 同源 | **不需要**；若做第二屏/网页集成再上 Kestrel 只读 API |
| 结论 | 适合“演示页 + 静态资源”型；不适合需要宿主推送状态的应用 | 只读 API 是 OBS/直播叠加的好范式 | HTTP 面过大（绑 0.0.0.0 无鉴权）是反例 | 保留 WebMessage 为主；本地 HTTP 仅按需、loopback + token |

### 6.2 性能治理（“限帧”的真实差异）

| 维度 | Rhine | Folia | Mineradio | Zilux2 目标 |
| --- | --- | --- | --- | --- |
| 整帧节奏 | 前端 rAF 跟刷新率；宿主不管 | `frameRateLimiter` 全局劫持 rAF（60/90/120/off，默认 off） | 主循环 VSync（自适应降帧是死代码） | `FrameClock` 节流通道 + `FrameThrottle`（已实测 200Hz 屏 0.42 核） |
| 子系统限帧 | 无 | 无独立 frameGate | **frameGate**：音频 60/歌单架 30/歌词 45/overlay 12 | 把 frameGate 语义移入前端（粒子 45/歌单架 30/overlay 12） |
| 像素预算 | 9 参数画质预设 + 三重上限（DPR/8.3MP/maxTexture/后处理 2MP） | Pixi 纹理桶、DPR clamp≤2、bloom 按 log2 降 | **sqrt(5.2M/cssPixels) 反解 DPR**、四档画质+硬件画像 | DPR clamp + 像素预算 + 图形层独立降分辨率（文字保满分辨率） |
| 深后台 | 无 | Electron `backgroundThrottling:false` → 隐藏仍画（缺陷） | **深后台 1s 定时器 + 画布 4×4 + DPR 0.3 + 缓存裁剪** | C# 权威广播可见性；前端 deep-sleep 兜底 |
| 降档反馈 | 无（只测量） | 无自动降档（仅离线 perf 装置） | 帧成本 EMA → pressure → level（**未接线到画质**） | 降档阶梯必须可观测、可回退、有滞回 |
| 验收口径 | 4K canvas + PresentMon ≥60FPS（文档纪律） | 离线 benchmark 场景 + 长跑内存探针 | `window.__mineradioPerf` 探针 + CPU 五项记录 | 前端 `__ziluxPerf` + 主进程 ETW/PerformanceCounter；不拿 rAF 当帧率 |

**共性教训**：三个项目都在“测量”上投入远多于“自动调节”，且自动调节一旦没接线就变成死代码。Zilux2 应先把 **frameGate + 像素预算 + 可见性权威** 三件事做成“可观测的显式机制”，再谈自适应。

### 6.3 歌词管线

| 维度 | Rhine | Folia | Mineradio | Zilux2 v1 |
| --- | --- | --- | --- | --- |
| 格式 | 仅 LRC（`src/lyrics.ts` 62 行） | **10 种**（LRC/增强LRC/VTT/TTML/YRC/QRC/KRC/AWLRC + 派生） | 舞台歌词/自定义歌词（行级为主） | LRC/QRC/KRC/YRC 四格式（19 个 Lyrics 文件） |
| 层数 | 解析→高亮 | **L0 来源→L1 解码/嗅探→L2 格式解析→L3 LyricData→L4 展示加工** | 抓取→渲染 | 抓取→解析→模型→渲染（缺显式 L4） |
| 逐字 | 无（行级） | 原生逐字 + 行级均摊两路统一为 Word[] | 行级 + 粒子 | 原生 QRC/KRC/YRC 逐字 |
| 翻译/罗马音 | 无 | ±1s 贪心稳定匹配 + 三轨分离 | 有限 | 有（行级） |
| 时钟 | `audio.currentTime` + rAF，仅播放且可见 | 单 rAF + MotionValue；四类时钟源；`currentTime`/`lyricCurrentTime` 分离；offset 只在时钟层减 | Web Audio 时钟 | GSMTC 位置 + 网易云记忆时钟补偿 |
| offset | 无（LRC `[offset:]`） | 单曲+全局合成，切歌负 offset，防双重偏移 | 无 | 有歌词偏移 |
| 结论 | 够用但太薄 | **数据契约与时钟纪律的主要借鉴对象** | 不具借鉴价值 | 底座已接近，补 L4 与契约字段纪律 |

### 6.4 桌面层 / 全屏 / DPI

| 维度 | Rhine | Folia | Mineradio | Zilux2 v1 |
| --- | --- | --- | --- | --- |
| DPI | manifest PerMonitorV2 + API 兜底；多屏恢复有错位坑 | Electron 自动缩放 | 物理/工作区 rect 显式换算 | DpiChanged 处理 + DIP 保存（较成熟） |
| 全屏 | WinForms F11（保存/恢复样式与 Bounds）+ 页面 HTML Fullscreen 两套无同步 | BrowserWindow fullscreen + 壁纸模式 | 全桌面模式（WorkerW）无“全屏”概念 | 无边框全屏未做（v1 无全屏壁纸全屏态） |
| 桌面层 | 无 | wallpaper-mode（窗口置底） | **WorkerW/DefView dual SetParent + ack 回读 + fail-closed + Explorer 重启重挂 + Shell 恢复** | 已实现 WorkerW/ShellBorrow/DesktopWatch（比 Mineradio 更早更深） |
| 图标层 | 无 | 无 | WS_EX_LAYERED + LWA_COLORKEY 色键抠像 | 有 DesktopIcons 扫描 |
| 视频壁纸 | 无 | `<video>`/canvas | DWM thumbnail helper 合成 WE 视频 | LibVLCSharp 原生 HWND 解码（更优） |
| 结论 | 全屏最小实现 | 桌面层弱 | **WorkerW 工程化兜底是最大价值** | 底座最好；吸收 Mineradio 的 ack/熔断/恢复阶梯纪律 |

### 6.5 依赖与复杂度

| 项目 | 运行时依赖 | 打包 | 安全面 | 对 Zilux2 的含义 |
| --- | --- | --- | --- | --- |
| Rhine | 内嵌 node.exe + WebView2 Runtime | 单文件 exe（自解压） | 本地 HTTP 仅 loopback；无鉴权 | 单文件体验可学；不要引 Node |
| Folia | Electron + Node（主进程内嵌后端） | electron-builder/asar | 只读 API 无鉴权、CORS 全开 | API 模式可学；体量与 AGPL 不可取 |
| Mineradio | Electron + PowerShell 子进程 | asar:false、未签名、无自更新 | server 绑 0.0.0.0 无鉴权 | 性能方法论可学；分发纪律不可学 |
| Zilux2 | .NET 10 + WebView2 + LibVLC + NAudio（自包含） | 单文件 + 安装器 | WebMessage 归属宿主 | 最干净的底座 |

### 6.6 一句话取舍

- **Rhine**：只学“宿主尽量小、边界尽量硬、诊断尽量全”；它的 HTTP-only 数据面在 Zilux2 里应当由 WebMessage 取代。
- **Folia**：只学“五层数据契约 + 时钟单写者 + offset 一处生效”；代码与常量一律重写（AGPL）。
- **Mineradio**：只学“像素预算 + frameGate + 深后台 + WorkerW ack/fail-closed”；GSMTC 它没有，不要误引；分发与安全面是反面教材。

---

## 7. 许可与合规边界

| 项目 | 许可 | Zilux2 能做什么 | 不能做什么 |
| --- | --- | --- | --- |
| Rhine | 代码 MIT；素材另有条款（NOTICE.md） | 复制/修改代码（保留版权与许可声明）；学习架构与工程纪律 | 复制 `art/*.blend`、`public/assets/*.glb`、图标/截图、PV 采样（`typing-preview.wav`/`typing-samples.ts`）、MiSans 字体（字体协议，非 MIT） |
| Folia | AGPL-3.0 | 阅读、理解、用**完全重写**的代码实现同样思路；可参考公开文档/协议 | 复制/修改其代码（含 utils/components/electron）——AGPL 会传染整个 Zilux2；把其服务端代码部署为网络服务也触发 AGPL |
| Mineradio | GPL-3.0-only（含 GPL 上游移植：Cuefield AutoMix、Wallpaper Engine 全桌面模式、汽水 QR 登录） | 学习设计思想、参数方法论、工程流程；独立重写 | 复制代码/常量命名/文件结构；其移植部分还带额外上游 GPL 声明 |

**实操规则（建议写进 Zilux2 仓库 AGENTS/CONTRIBUTING）**：

1. 对 AGPL/GPL 项目：**只允许在 `research/` 读代码写笔记，不允许把代码/片段/patch 拷进 `src/`**；实现时用自己的命名与结构，review 时确认无“结构级复制”。
2. 对 MIT 项目：复制代码时在文件头保留原版权 + MIT 声明；资产文件一律不用。
3. 参数/常量（如 5.2M 像素预算、0.78 系数）属于“思想/数据”，可独立重写实现，但不要连注释/命名一起抄。
4. 所有外部设计来源记入 `THIRD-PARTY-NOTICES`（即使只是思路，也便于审计与澄清）。

---

## 8. Zilux2 采纳路线图

> 以 v1 现状为底座（318 个 .cs、五套时钟、WEB-CONTRACT v1、`DesktopBackdrop`/`ShellBorrow`、`MediaSessionWatcher`、`LyricsService` 19 文件、27 套 kinetic 风格）。下列 P0/P1/P2 按“收益/风险”排序。

### P0（先做，收益最大）

| # | 事项 | 来源 | 落地要点 |
| --- | --- | --- | --- |
| P0-1 | **歌词数据契约统一**：解析层与渲染层彻底分离（原始源→格式探测/解码→平台解析器→行/词时间轴→渲染提示→渲染器） | Folia 五层解析（§3.1/§3.4） | 统一 `LyricDocument/Line/Word`（v1 已有 Models）；**线路统一整数毫秒**（schema 版本化）；`Line.renderEnd`（余辉结束）与 `Line.endTime`（音乐结束）分开；`words` 恒有值（行级来源给均摊值，渲染器只有一条路径）；offset **只在时钟层减**（防双重偏移，切歌设负 offset）；渲染器禁止收到空行占位内容 |
| P0-2 | **WebView2 宿主策略**：UDF 统一、`ProcessFailed` 恢复、加速键取舍、`DownloadStarting/PermissionRequested` 决策、WebMessage 双向桥、诊断开关 | Rhine + 自身 WEB-CONTRACT | 发布禁 DevTools 但保留 `ZILUX_WEBVIEW_PROFILE=1` 黑匣子（JSONL+截图）；页面 → 宿主所有写操作走 WebMessage，不再让页面直连服务 |
| P0-3 | **性能预算接线**：把 Mineradio 的“像素预算 + 子系统 frameGate + 深后台 + 降档阶梯”映射到 v1 `FrameClock/FrameThrottle` + `bridge.js` 的 WebView2 页内节流 | Mineradio §5.1 | C# 权威广播可见性/桌面模式；前端 `frameGate` 子系统限帧（粒子 45/歌单架 30/overlay 12）；`window.__ziluxPerf` 暴露指标；降档必须可观测 |
| P0-4 | **WorkerW 恢复阶梯与 ack 校验**：fail-closed 发现、附着后回读校验、Explorer 重启/分辨率变化重挂、退出恢复 Shell 顺序 | Mineradio §5.3 + v1 现状 | 把现有 `DesktopBackdrop` 的失败路径补成“隐藏+禁用交互+恢复托盘+熔断”；多屏按 HMONITOR；退出快照恢复 |
| P0-5 | **本地 HTTP 数据面（可选，按需）**：若 Zilux2 需要“网页/手机可访问的本地 API”，用 Kestrel 最小 API + 一次性 token + CSP，替换/补齐现有数据通道 | Rhine §2.4 | 不引入 Node；随机端口；Host/Origin 白名单；Range 206；健康检查身份校验 |

### P1（值得做，收益中高）

| # | 事项 | 来源 | 落地要点 |
| --- | --- | --- | --- |
| P1-1 | **可视化器工厂**：把 27 套 kinetic 风格升级为“registry + `defineVisualizer` 契约 + 独立 entry”结构 | Folia 可视化架构（§4.2/§4.3） | 统一 mode 注册（`import.meta.glob` 或构建期清单）+ 启动断言（数量/顺序/唯一性）；`render` 必须懒加载（否则 14 个模式全进首包）；lifecycle `mount/activate/deactivate/dispose`；**mount-once：换歌不销毁 WebGL 上下文**（只换数据）；新增风格只动自己目录 + 注册点 |
| P1-2 | **GPU 能力探测与降级**：页面内探测 renderer/maxTextureSize/软件渲染，WebMessage 上报宿主 | Rhine `gpu-capability.ts` | 软件渲染/WARP/SwiftShader 自动降预设并提示；GPU 能力进诊断 JSONL |
| P1-3 | **3D 歌单架**：窗口化 ±N + 批大小 + 显式 dispose + 懒加载 | Mineradio §5.4 | 与 FanWindow/PlayerWindow 的装饰层整合；不要在渲染帧里做布局测量 |
| P1-4 | **诊断黑匣子**：环境变量开关 + JSONL + 截图 + `dataset` 证据链 | Rhine §2.6 | 每次发布附 profile 快照；4K 验收用 PresentMon/ETW，不拿 rAF 当帧率 |
| P1-5 | **歌词来源与缓存纪律**：多源回退、去重、失败兜底、版本号缓存失效 | Folia 来源/缓存 + Rhine 曲库 | 与 v1 的 `LyricsService/LyricsCacheStore` 对齐；缓存 key 含 provider/format/offset |

### P2（可选/长期）

- 发布纪律升级：版本目录/数据目录分离 + 标记文件 + 校验 + 拒绝覆盖 + SHA-256（Rhine §2.2）。
- 无障碍：歌词行真实 button、tab 焦点循环、性能摘要（Rhine P2-6 思路）。
- 设置持久化分层：业务设置走宿主 `settings.json`，WebView `localStorage` 只存 UI 临时态（避免清缓存丢设置）。
- 在线资料限速/UA/失败保留本地数据（Rhine P2-2）。

---

## 9. 反模式与风险清单

| # | 反模式 | 来源 | 后果与修正 |
| --- | --- | --- | --- |
| 1 | 纯单向 HTTP、无 WebMessage 桥 | Rhine | 宿主无法主动推状态，双写不一致；Zilux2 已有桥，别退回去 |
| 2 | 无 Job Object 的子进程 | Rhine | 宿主崩溃留孤儿、升级端口被占；用 Job Object + 命名管道 |
| 3 | 固定端口段 | Rhine / Mineradio | 多实例/残留互抢；动态端口 |
| 4 | 两套全屏无同步 | Rhine | 状态脱节；统一宿主级全屏 |
| 5 | 降帧反馈未接线（死代码） | Mineradio | 以为在自适应，实际没生效；必须可观测 |
| 6 | 深后台只靠定时器不缩画布 | Mineradio 教训 | 后台仍占 GPU/内存；用 4×4/DPR 0.3/清缓存 |
| 7 | 本地服务绑 `0.0.0.0` 无鉴权 | Mineradio | 局域网暴露；绑 loopback + token |
| 8 | 文档与代码漂移 | 三项目 | 引用结论前回 `file:line`；文档改动进 CI/评审 |
| 9 | 复制 AGPL/GPL 代码 | Folia/Mineradio | 许可传染；只学思路重写 |

---

## 10. 附录：深挖报告索引与证据核对

| 报告 | 路径 | 行数 | 覆盖 |
| --- | --- | --- | --- |
| Rhine 拆解 | `research/notes/rhine.md` | 1,076 | 轻宿主/WebView2/本地 HTTP/全屏与 DPI/Three.js 边界/借鉴清单 |
| Folia 歌词 | `research/notes/folia-lyrics.md` | 964 | 五层解析/逐字与翻译时间轴/渲染同步/来源缓存/GSMTC 时钟方案/AGPL 红线 |
| Folia 可视化 | `research/notes/folia-visual.md` | 1,150 | 14 个可视化器/统一接口/性能护栏/GPU 层/WebView2+WPF 分工 |
| Mineradio 拆解 | `research/notes/mineradio.md` | 974 | 帧预算/GSMTC 真相/WorkerW/粒子星河/3D 歌单架/Electron 主进程/GPL 边界 |

**证据核对**：本报告引用的 `file:line` 来自四份深挖报告的抽样回读；四份报告各自记录了 10–18 处 `file:line` 抽查命中（`DesktopProgram.cs:106/819/1058`、`music-server.mjs:59/249`、`parserCore.ts:59/185/212`、`lyricApi.cjs:45`、`renderer-quality.js:5-7`、`frame-scheduler.js:1-74`、`lyric-wallpaper` 等）。引用前建议回原仓库对应行确认。

**证据环境**：三份 tarball 快照（`rhine` v0.6.0-dev.57、`folia` v0.7.21、`mineradio` v2.2.0），目录 `research/repos/<name>` 无 `.git`，全部 `file:line` 以快照行号为准；仓库地址与许可见 §7。

---

> 下一步（可选）：把 §8 的 P0 项拆成 issue 并逐项对照 v1 代码定接口；优先做 P0-1（契约）与 P0-3（性能接线），它们决定后续所有可视化/歌词工作是否返工。
