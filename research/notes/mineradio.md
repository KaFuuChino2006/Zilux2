# Mineradio 深度拆解

> 调研对象：XxHuberrr/Mineradio（远程仓库已改名 `Mineradio-paused`），**v2.2.0**
> 快照：`E:\Zilux2开发\research\repos\mineradio`（只读）；调研日期：**2026-10-18**
> 方法：纯静态阅读，未安装依赖、未运行、未联网；本文所有 `file:line` 均为该快照中的真实行号，抽查见文末。
> 阅读约定：**代码**＝可执行语义（以此为准）；**文档**＝README/docs 的声称；两者冲突单列；无法证实的一律标「待确认」，不做推断性补齐。

---

## 0. TL;DR（先看这 12 条）

1. **它不是一个"用 Electron 套壳的网页"**：渲染进程确实跑 `http://127.0.0.1:PORT`，但 HTTP 服务（`server.js`，6717 行）是**主进程内 `require()` 同进程加载**的，不是独立子进程（`desktop/main.js:5236-5267`）。整个仓库**没有 `native/` 目录、没有 `.node` 原生模块、没有 ffi/koffi**，所有 Windows 原生互操作都是「PowerShell + `Add-Type` 内联 C# P/Invoke」子进程。
2. **"帧预算"不是单一实现**，而是四套机制叠加：①像素预算（DPR cap + 5.2M 像素 budget，`01-scene/00-renderer-quality.js:5-7`）；②逐帧成本 EMA→pressure→level 的延迟反馈（同文件 `:62-81`）；③按子系统切分的 **frameGate 限帧**（`00-state/10-frame-scheduler.js:1-74`，主循环 `11-main-loop.js:165-173`）；④深后台整体降档（rAF 换 `setTimeout(1000ms)`、renderer 缩到 4×4、DPR 0.3）。代码中**没有**名为 `frameBudget` 的单一对象。
3. **自适应 cadence 实际是死代码**：`RENDER_VISIBLE_VSYNC = true`（`01-scene/00-renderer-quality.js:9`）让 `resolveAdaptiveRenderCadence()` 直接返回 `null`（`11-main-loop.js:77-83`）。前台可见运动恒为 VSync 全速，这与 `docs/LOW_SPEC_OPTIMIZATION_DOCTRINE.md:83-92` 的「默认 VSync，45/60/75/90/120 只是用户主动上限」一致——文档说的是真话，但意味着 `selectAdaptiveRenderCadence()`（`:97-125`）目前是预留能力而不是生效策略。
4. **降档的真实手段是"少算"而不是"少画"**：主循环每帧照常 `renderer.render()`，但频谱分析、3D 歌单架、歌词粒子、舞台歌词、桌面 overlay 各自被 frameGate 按目标帧率跳过；深后台再叠加像素/缓存/内存三层压缩。
5. **GSMTC 在 v2.2.0 完全不存在**（重点更正 Lead 简报）：全仓 `gsmtc|smtc|systemmediatransport|navigator.mediaSession|MediaSession|SystemMediaTransport` 命中 **0**，`MediaPlayPause|MediaTrackNext|hardwareMediaKey` 也无命中。本仓库**没有** Windows 系统媒体面板/硬件媒体键集成，第 4 节给出证据与"最接近的替代机制"。
6. **WorkerW 桌面模式是双模式**：passive（主窗口 `SetParent` 到 WorkerW 壁纸层）+ interactive（`SetParent` 到 `SHELLDLL_DefView` 下、与桌面图标共存并可交互）。用 PowerShell 内联 C# 完成窗口发现、样式切换、`SetWindowPos`、JSON ack 校验；失败 fail-closed 回退顶层窗口；`Escape` 全局热键退出；提供"恢复托盘"兜底（`desktop/main.js:1346-1372,2109-2165`）。
7. **桌面图标层**是另一个独立 native helper：`WS_EX_LAYERED + LWA_COLORKEY` 的 layered window 盖在图标下方/上方做色键抠像，避免全屏桌面窗口挡住宿主桌面图标（`desktop/desktop-native-icon-layer-runtime.js`，1305 行）。
8. **视频壁纸（Wallpaper Engine）走 DWM thumbnail helper 子进程**：C# WinForms 宿主窗 `DwmRegisterThumbnail` 把 WE 进程窗口合成进来，主进程按环境变量下发源/目标 HWND；失败回退 `desktopCapturer` 抓帧（`desktop/wallpaper-engine-runtime.js:9-23,990-1020`；`desktop/main.js:915-1308`）。**不是** Web/Application 项目执行器（`NOTICE.md:14-19` 明确只索引 `project.json`）。
9. **渲染进程没有打包器、没有 ESM**：`index-loader.js` 用**同步 XHR** 逐个读 70+ 个模块文件，拼成一个 `<script>` 内联注入（`public/js/index-loader.js:5-127`）。首屏被同步 IO 阻塞、调试栈被 `//# sourceURL` 合并、模块间靠全局 `var/function` 共享作用域。
10. **粒子/星河是 Three.js r128 + 手写 GLSL**（CanvasTexture 做遮罩/辉光，`ShaderMaterial` + `Points`），音频驱动来自 **Web Audio `AnalyserNode`**（`05-playback/08-audio-graph-controls.js:113-206`），**没有 WASAPI/loopback**；离线节拍分析用 `OfflineAudioContext` + music-tempo Worker（`03-beat/01-audio-beat-analysis.js:18-34`、`03-beat/00-tempo-worker-cache-prefetch.js:92-124`）。
11. **3D 歌单架是"窗口化渲染 + 懒加载 + 显式 dispose"**：可见半径 ±5 张、最多渲染 11 张（`04-shelf/01-manager-core.js:6-7`），列表 48 条一批（`00-state/01-perf-render-state.js:27`），卡片纹理 `CanvasTexture` 用后 `dispose()` 并复用（`:285-309`）。文档声称实现位置在 `public/index.html`，实际已模块化到 `04-shelf/*`（文档漂移）。
12. **发布链是"最保守"的**：`asar:false`、`signAndEditExecutable:false`（不签名）、**无 electron-updater**；更新只查 GitHub Releases 的 `latest.yml` + 镜像加速排序，弹外链下载页，绝不自更新（`server.js:4742`、`public/js/modules/08-account/00-update-preview.js:2-3`）。许可为 **GPL-3.0-only**（`package.json:7`，`LICENSE` 561 行原文）。

---

## 1. 项目速览

### 1.1 基本盘

| 项 | 值 | 证据 |
|---|---|---|
| 仓库/产品名 | `mineradio` / `Mineradio`（GitHub 已改名 Mineradio-paused） | `package.json:2`、`README.md:3-7` |
| 版本 | 2.2.0（README 称"长期停更的稳定历史版本"） | `package.json:4`、`README.md:45-51` |
| 许可 | GPL-3.0-only（LICENSE 为 GPLv3 全文 561 行） | `package.json:7`、`LICENSE:1-3` |
| 入口 | `desktop/main.js`（Electron 主进程，6058 行） | `package.json:8` |
| 私有标记 | `"private": true`（不发 npm） | `package.json:9` |
| 运行时依赖 | gsap ^3.15.0、mpg123-decoder ^1.0.3、music-metadata 11.14.0、NeteaseCloudMusicApi ^4.32.0、qrcode ^1.5.4 | `package.json` 依赖段 |
| 开发依赖 | electron ^42.4.1、electron-builder ^26.15.3、rcedit ^5.0.2 | `package.json` devDependencies |
| scripts | `start = electron .`、`build:win = electron-builder --win nsis`、`build:win:dir`、`build:win:internal-beta`（另有 `electron-builder.internal-beta.json`） | `package.json` scripts |
| 原生模块 | **无**（无 `native/`、无 `.node`、无 ffi/koffi；原生能力=PowerShell 子进程） | 目录清单 + 全仓检索 |
| 运行形态 | Electron 壳 + 本机 HTTP 应用 + 可选 Wallpaper Engine 本地库 + 多个 PowerShell helper | 第 2 节 |

> 依赖里 `mpg123-decoder` 在仓库代码中**未被引用**（grep 无 `mpg123` 使用点），属历史遗留/死依赖，`待确认` 是否在动态分支使用。

### 1.2 代码规模（实测）

| 范围 | 规模 |
|---|---|
| js/html/css 文件总数 | **236** 个 |
| `public/js/modules/` 渲染进程业务代码 | **58001 行** |
| `desktop/main.js` | 6058 行 |
| `server.js` | 6717 行（269,992 字节） |
| `public/index.html` | 1932 行 |
| `public/css/index.css` | 18576 行 |
| `public/desktop-lyrics.html` | 1237 行 |
| `desktop/wallpaper-engine-runtime.js` | 4149 行 |
| `desktop/full-desktop-mode-runtime.js` | 2067 行 |
| `desktop/desktop-native-icon-layer-runtime.js` | 1305 行 |
| `desktop/wallpaper-mode-runtime.js` | 739 行 |
| `cuefield/`（AutoMix planner） | 19 模块，6683 行 |
| 文档 | README 119、CHANGELOG 189、NOTICE 33、docs/ 共 10 篇 1021 行 |

### 1.3 目录地图

```
mineradio/
├─ package.json              # Electron + electron-builder，asar:false，files 白名单
├─ server.js                 # 本机 HTTP 服务（同进程 require），6717 行、105 个 /api 分支
├─ *-api.js                  # 各音源适配：qq-vip-api / kugou-api / qishui-api / spotify-api / dj-analyzer
├─ qishui-*/                 # 汽水音乐 QR 登录与音频解密（THIRD_PARTY_PORTS 声明字节级保留）
├─ desktop/                  # 主进程（Electron 侧）
│  ├─ main.js                # 6058 行，窗口/生命周期/IPC/WE/全桌面模式/登录/更新
│  ├─ preload.js             # 151 行，contextBridge 暴露 desktopWindow API
│  ├─ overlay-preload.js     # 19 行，桌面歌词 overlay 专用 API
│  ├─ wallpaper-mode-runtime.js        # WorkerW 附着（passive）脚本 + 状态
│  ├─ full-desktop-mode-runtime.js     # 全桌面模式（passive/interactive）状态机
│  ├─ wallpaper-engine-runtime.js      # WE 检测 + DWM thumbnail helper 子进程
│  ├─ wallpaper-engine-library.js      # Steam 库发现 / project.json 索引
│  ├─ desktop-icon-shape-runtime.js    # 桌面图标布局探测（PowerShell）
│  ├─ desktop-native-icon-layer-runtime.js # 图标层 layered window
│  ├─ local-music-library.js / built-in-playlist-library.js / system-memory.js
│  └─ app-memory.js / login-easter-egg-gate.js
├─ public/                   # 渲染进程（无构建、无 ESM）
│  ├─ index.html             # 1932 行，所有 DOM 层
│  ├─ desktop-lyrics.html    # 1237 行，桌面歌词 overlay 页面
│  ├─ vendor/                # three.r128.min.js / gsap.min.js / music-tempo.min.js
│  ├─ css/index.css          # 18576 行
│  └─ js/index-loader.js     # 同步 XHR 拼模块（128 行）
│     └─ modules/            # 00-state/01-scene/02-visual/03-beat/04-shelf/05-playback/06-lyrics/07-fx/08-account/10-shell + 11-main-loop.js
├─ cuefield/                 # AutoMix 过渡规划（cache-only，opt-in）
├─ build/                    # icon.ico、installer.nsh、after-pack.js、安装器位图
├─ docs/                     # LOW_SPEC_OPTIMIZATION_DOCTRINE / DESKTOP_LYRICS_VISUAL / 3D_PLAYLIST_SHELF_MEMORY / THIRD_PARTY_PORTS / UPDATE_DELIVERY / INSTALLER_STYLE / GLASS_SVG_TEXTURE
├─ scripts/                  # 大量 check-wallpaper-engine-*.js/.ps1、quick-check.js
└─ tests/                    # 53 个测试文件（全桌面/图标层/播放/更新页等）
```

---

## 2. 架构总览

### 2.1 一句话

主进程先启动**同进程 HTTP 服务**，再创建 **frameless/transparent 的 BrowserWindow** 去加载 `http://127.0.0.1:PORT/`；渲染进程是"无构建的全局脚本大杂烩"，通过 preload 暴露的 IPC 调用主进程能力；需要 Windows 原生能力时，主进程**临时生成 PowerShell 脚本（内联 C#）跑子进程**，用 stdout JSON ack 回传结果。

### 2.2 ASCII 架构图

```
┌─────────────────────────── Electron 主进程 desktop/main.js (6058 行) ───────────────────────────┐
│ app.whenReady → createWindowOnce() → ensureLocalServerStarted() → loadMainWindowWithRetry()      │
│   ├─ require('../server.js')  ← 同进程 HTTP 服务（server.js:5249-5251）                          │
│   ├─ BrowserWindow: frameless / transparent / contextIsolation / preload.js（main.js:5599-5621）  │
│   ├─ 单实例锁(501) / 启动看门狗 / render-process-gone 恢复 / 启动状态文件                         │
│   ├─ Tray(2109) / globalShortcut(1782,1346) / 关闭行为(2068) / 无开机自启                        │
│   ├─ FullDesktopModeRuntime(173) ── PowerShell + Add-Type C# ──► SetParent(HWND, WorkerW/DefView) │
│   ├─ WallpaperEngineRuntime ── helper 子进程（C# WinForms + DwmRegisterThumbnail）                │
│   ├─ DesktopLyrics overlay BrowserWindow(3724) ── overlay-preload.js                             │
│   └─ system-memory / local-music-library / wallpaper-engine-library / login-easter-egg-gate      │
└───────────────┬───────────────────────────────────────────────────────┬─────────────────────────┘
                │ IPC（contextBridge，nodeIntegration:false）            │ execFile/stdio + JSON ack
      ┌─────────▼──────────────────────────────────┐        ┌──────────▼──────────────────────────┐
      │ 渲染进程：http://127.0.0.1:PORT/            │        │ PowerShell / helper 子进程           │
      │  index.html + index-loader 拼 70+ 模块      │        │  · WorkerW/DefView 附着脚本          │
      │  Three.js r128 + 手写 GLSL + GSAP           │        │  · DWM thumbnail 宿主（C# WinForms） │
      │  帧闸门 / 画质档位 / 深后台 / 性能探针      │        │  · 桌面图标布局探测 / 图标层         │
      │  desktop-lyrics.html（第二个窗口）          │        │  · 中键 GetAsyncKeyState 轮询(3638)  │
      └─────────────────────────────────────────────┘        └──────────────────────────────────────┘
```

### 2.3 启动时序（代码路径）

1. `app.requestSingleInstanceLock()`（`desktop/main.js:501`）失败即退出。
2. `app.whenReady()`（`:5927,5933`）后安装本地协议、初始化本地库、注册显示布局监听。
3. `createWindowOnce()`（`:5585`）先 `loadFile(desktop/startup.html)` 显示启动壳，再创建真实窗口（`:5599-5621`，`show:false` 等 ready-to-show）。
4. `ensureLocalServerStarted()`（`:5236-5267`）：`findOpenPort(3000)`（`:548-570`）→ 配置权限/环境 → 清 `require.cache` → **`require('../server.js')`** → `waitForServer`（10s）→ `waitForLocalHttpReady`（8s）→ 写 `startup-state.json`。
5. `loadMainWindowWithRetry()`（`:5524`）加载 `http://127.0.0.1:PORT/?startupAttempt=…`，与 renderer 的 ready 信号 race，15s 超时重试一次（错误码 `MINERADIO_NAVIGATION_FAILED`）。
6. `did-finish-load` / `ready-to-show` → `showMainWindowSafely()`（`:5268`）；启动成功写 `startup-state.json`。
7. 退出：`before-quit`（`:5975-6058`）串行清理——先关全桌面模式（`fullDesktopModeRuntime.dispose`，带 7000ms 超时兜底）、再 WE runtime、再 localServer/tray，总超时 15s 强制 `app.quit()`。

### 2.4 渲染进程加载器：无 ESM、无打包

`public/index.html:1929` 只有一行 `<script src="js/index-loader.js"></script>`；loader 内部：

```js
// public/js/index-loader.js:5-127（节选）
const modulePaths = [ 'js/modules/00-state/00-core-stores.js', /* … 70+ 个 … */ 'js/modules/11-main-loop.js' ];
function readModule(path) {
  const request = new XMLHttpRequest();
  request.open('GET', path + '?v=' + moduleCacheBust, false);   // ← 同步 XHR
  request.send(null);
  return request.responseText;
}
const script = document.createElement('script');
script.text = modulePaths.map(readModule).join('') + '\n//# sourceURL=mineradio-index-modules.js\n';
document.currentScript.parentNode.insertBefore(script, document.currentScript.nextSibling);
```

后果（结合代码判断）：
- 首屏解析被 70+ 次同步 HTTP 请求串行阻塞，`moduleCacheBust=Date.now()` 每次禁用浏览器缓存（`index-loader.js:4`），冷启动磁盘 IO 压力大；`startup.html` + splash 是必要的遮羞布。
- 所有模块共享全局作用域，`var` 泄漏、加载顺序即依赖顺序；模块间以全局函数名互调（`index-loader.js:5-110` 的顺序就是依赖拓扑）。
- CSP 无法收紧到 nonce 级（内联 `<script>`），与 `public/index.html:7` 的 `referrer=no-referrer` 一起看，作者对安全有一定意识但止步于"能跑"。

### 2.5 原生边界清单（没有 native 模块，只有脚本）

| 能力 | 实现 | 证据 |
|---|---|---|
| WorkerW 壁纸层附着 | PowerShell `Add-Type` C#（`FindWindow/FindWindowEx/EnumWindows/SetParent/SetWindowPos`） | `desktop/wallpaper-mode-runtime.js:95-187` |
| 与桌面图标共存（DefView child） | 同上 + style get/set + JSON ack | `desktop/full-desktop-mode-runtime.js:128-246` |
| 桌面图标布局探测 | PowerShell C# 枚举 `SysListView32` rect | `desktop/desktop-icon-shape-runtime.js` |
| 图标层色键窗口 | C# layered window（`WS_EX_LAYERED/LWA_COLORKEY`） | `desktop/desktop-native-icon-layer-runtime.js:63-68` |
| Wallpaper Engine 视频合成 | C# WinForms + `DwmRegisterThumbnail` helper 子进程 | `desktop/wallpaper-engine-runtime.js:990-1116` |
| 桌面歌词"中键锁定/穿透"热键 | PowerShell `GetAsyncKeyState(4)` 24ms 轮询 stdout | `desktop/main.js:3638-3685` |
| 系统内存清理 | 系统命令 + 提权探测（`system-memory.js`，495 行） | `desktop/system-memory.js`、`desktop/main.js:1942-2066` |

> 这种"脚本当 native"的路线优点：无编译链、asar:false 下可直接改；缺点：每次操作 100~600ms 启动 PowerShell、杀软误报面大、错误只能靠字符串码（`FULL_DESKTOP_*`/`WALLPAPER_*`，`full-desktop-mode-runtime.js:280-286`）。Zilux v1 用 C#/WPF 已天然跨过这一层。

### 2.6 安全/信任边界（重要，与"音乐播放器"直觉相反）

- 主窗口 `webPreferences`：`contextIsolation:true`、`nodeIntegration:false`、**`sandbox:false`**、`backgroundThrottling` 默认 true（`desktop/main.js:5610-5621`）。
- 主进程对所有 IPC 做发送方校验：`isLocalAppUrl`/`isTrustedMainDocumentUrl`/`isTrustedMainWindowIpc`（`:738-768`）、`isTrustedWallpaperEngineIpc`（`:809-830`）、WE capture 授权（`:832-1064`）。
- **但 HTTP 服务默认监听 `0.0.0.0`**：`server.js:121-122`（`HOST = process.env.HOST || '0.0.0.0'`），`server.listen(PORT, HOST)` 在 `server.js:6708`。主窗口只访问 `127.0.0.1`，但同一局域网可直连其 `/api/*`；`server.js` 只有"登录彩蛋门"这层对少数登录路由的 423 保护（`server.js:124-140`），其余 API 无鉴权。**这是本仓库最需要警惕的设计，Zilux2 不应复刻**（详见 §11-Q6）。
- 无 CSP `<meta>`；`index.html:9-11` 外链 Google Fonts（离线首屏可用性/隐私问题）。
- `asar:false` + `signAndEditExecutable:false`：安装目录是明文 JS，可被随意篡改，也没有代码签名（SmartScreen 会拦）。

---

## 3. 帧预算系统（重点）

### 3.1 先厘清概念：预算在哪里

代码里**没有**名为 `frameBudget` 的对象/函数。按"谁花钱、谁限速、谁降档"拆成四层：

| 层 | 作用 | 核心文件 |
|---|---|---|
| L1 像素预算 | 限制"每帧要画多少像素"，决定 DPR 与画质档位 | `01-scene/00-renderer-quality.js` |
| L2 帧成本反馈 | 用"帧耗时 EMA"估计压力，产生 level 0/1/2 | 同上 `:62-81` + `11-main-loop.js:695-696` |
| L3 帧闸门 | 各子系统按目标 FPS 跳过，不拖累整帧 | `00-state/10-frame-scheduler.js`、`11-main-loop.js` |
| L4 深后台/内存 | 窗口不可见时整体停摆 + 缓存/内存压缩 | `00-state/08-desktop-render-power.js` |

另有 L5 **离线节拍分析**的采样步长（`runtimeAnalysisStride`）与音频分析缩放，属于"降 CPU"而非降帧。

### 3.2 L1：像素预算与自动画质档位

关键常量（`public/js/modules/01-scene/00-renderer-quality.js:5-19`）：

```js
var RENDER_DPR_CAP = 1.35;        // 默认档 DPR 上限
var RENDER_PIXEL_BUDGET = 5200000; // 默认档每帧像素预算 ≈ 5.2M（2560×1440@1.35 量级）
var RENDER_MIN_DPR = 0.72;        // 默认档 DPR 下限
var RENDER_VISIBLE_VSYNC = true;  // 前台可见运动恒 VSync（关闭自适应跳帧）
var RENDER_IDLE_FPS = 72;  var RENDER_IDLE_LARGE_FPS = 60;  var RENDER_IDLE_HUGE_FPS = 48;
var RENDER_ACTIVE_FPS = 90; var RENDER_LARGE_FPS = 75;     var RENDER_HUGE_FPS = 60;
var RENDER_INTERACTION_FPS = 0;   // 0 = 不限
var RENDER_INTERACTION_LARGE_FPS = 90; var RENDER_INTERACTION_HUGE_FPS = 75;
var RENDER_INTERACTION_HOLD_MS = 900;
```

画质档位（`renderQualityProfile()`，`:126-134`）：

| 档位 | DPR cap（普通/低配） | DPR min | 像素 budget（普通/低配） |
|---|---|---|---|
| eco | 0.95 / 0.88 | 0.52 | 2.4M / 1.9M |
| balanced | 1.12 / 0.98 | 0.62 | 3.8M / 2.8M |
| high（默认） | 1.35 / 1.12 | 0.72 / 0.66 | 5.2M / 3.6M |
| ultra | 1.75 | 0.85 | 7.8M |

实际 `devicePixelRatio`（`getRenderPixelRatio()`，`:135-143`）：

```js
if (isDeepBackgroundMode()) return Math.min(device, 0.30);
var cssPixels = Math.max(1, innerWidth * innerHeight);
var quality = renderQualityProfile();
var budgetCap = Math.sqrt(quality.budget / cssPixels);   // ← 预算直接换算成 DPR
var cap = Math.min(quality.cap, budgetCap);
return Math.max(quality.min, Math.min(device, cap));
```

要点：
- **预算是"每帧总像素"而不是"DPR 上限"**：窗口越大，允许的 DPR 越低（`sqrt(budget/cssPixels)`），这是比"固定 DPR"更合理的抽象。
- 渲染器创建即按预算：`new THREE.WebGLRenderer({antialias:false, alpha:true, powerPreference:'high-performance'})`、`setPixelRatio(getRenderPixelRatio())`（`:177-186`）——**AA 关闭**，靠 CSS/后处理补观感。
- 画质档位来自 `fx.performanceQuality`（用户设置），硬件画像另行判断低配（见 3.3 的 `runtimeHardwareProfile`）；两者交叉决定 `lowSpec` 分支。

### 3.3 硬件画像与"运行时预算级别"

`public/js/modules/00-state/08-desktop-render-power.js:41-67`：

- 输入：`navigator.hardwareConcurrency`（cores）、`navigator.deviceMemory`（GB）、`devicePixelRatio`、`innerWidth*innerHeight`。
- 判定：`lowCore = cores<=4`；`lowMemory = memory<=4`；`largeSurface = renderPixels>=4.2M`；`veryLargeSurface >= 7.2M`；`lowSpec = lowCore || lowMemory || (cores<=6 && veryLargeSurface)`；`balancedSpec = lowSpec || cores<=8 || largeSurface`。
- 这是**启发式**，不是真实 GPU 性能；真实 GPU 信息只用于诊断（`app.getGPUFeatureStatus()/getGPUInfo('basic')`，`desktop/main.js:1919-1925`），不参与降档决策。

`performanceQualityRank`/`runtimePerfBudgetLevel`（`:79-96`）：把画质档位映射到 0~3，再与硬件画像交叉：

| 条件 | budgetLevel |
|---|---|
| eco | 0 |
| lowSpec 且 rank<=2 | 0 |
| rank<=1 或 balancedSpec 且 rank<=2 | 1 |
| ultra 且非 lowSpec | 3 |
| 其余 | 2 |

派生出两个"全局缩放"（`:97-109`）：
- `runtimePerfScale`：0.72 / 0.84 / 1.0 / 1.08 → **乘在几乎所有子系统的目标 FPS 上**（`11-main-loop.js:295-304` 的 `capMainLoopFpsToDisplay/capMainLoopFpsForBudget`）。
- `runtimeAudioAnalysisScale`：深后台 0.18，否则 0.62/0.68/0.78/0.90/1.0 → 乘在频谱分析目标帧率上；再用 `runtimeAnalysisStride` 对时域/宽频带做跨帧采样（`:110-124`）。

### 3.4 L2：逐帧成本采样与压力反馈

`sampleAdaptiveFrameCost(costMs, targetFps)`（`01-scene/00-renderer-quality.js:62-81`）：

```js
var fps = Math.max(1, Number(targetFps) || estimatedDisplayRefreshHz());
var budget = (1000 / fps) * 0.78;                 // ← 预算 = 帧间隔的 78%
adaptiveFrameLoadState.avgMs = avgMs ? avgMs*0.92 + cost*0.08 : cost;  // EMA α=0.08
if (avgMs > budget)          pressure = min(8, pressure + 0.70);       // 超预算猛加
else if (avgMs < budget*0.62) pressure = max(0, pressure - 0.30);      // 远低于预算回落
else                          pressure = max(0, pressure - 0.10);      // 擦边缓降
level = pressure >= 4 ? 2 : (pressure >= 2 ? 1 : 0);
```

- 预算留 22% 余量（`*0.78`），是"给浏览器合成/GC 留头"的经验值。
- 加压快（+0.70/帧）、减压慢（-0.30 或 -0.10），本质是**带滞回的 bang-bang 控制器**：约 6 帧超标就到 level 2，掉到低负载也要十几帧才回落。
- 采样点：主循环 `animate()` 末尾用 `performance.now()-framePerfStart` 计时（`11-main-loop.js:694-696`）；splash 覆盖期每 520ms 只渲染一次也纳入采样（`:329-337`）。
- `level` 目前只被两处消费：`getRenderLoadTier()` 的 tier 计算（`00-renderer-quality.js:170-176`）和（理论上的）自适应 cadence；像素预算/画质档位**不**随 level 变化——即"压力反馈"尚未真正驱动降画质（见 §11-Q2）。

### 3.5 L3：frameGate 帧闸门（真正生效的限帧器）

`public/js/modules/00-state/10-frame-scheduler.js`（全文 74 行）：

- `createFrameGate(name, defaultFps)`（`:1-14`）：字段 `{name, defaultFps, targetFps, lastRunAt, pendingDt, runs, skips, lastDt, lastReason}`。
- `consumeFrameGate(gate, now, dt, fps, force, reason)`（`:15-37`）：`minGap = 1000/max(1,targetFps)`；未到间隔则 `skips+1`、计数器 `__mineradioPerf.count('frameGate.'+name+'.skipped')`、返回 0；到点则返回累积 dt。
- `runFrameGate(gate, now, fallbackDt)`（`:38-49`）：把 `pendingDt` 累积成 `stepDt`，但**单步上限 0.18s**（`:42`）——防止"后台 1s 醒一次 → 动画瞬移"。
- `resetFrameGate`/`collectFrameGateSnapshot`（`:50-74`）：快照进性能面板。

主循环里注册的闸门（`11-main-loop.js:165-173`）：

```js
var mainFrameGates = {
  audio: createFrameGate('main.audio', 60),
  shelf: createFrameGate('main.shelf', 30),
  lyricsParticles: createFrameGate('main.lyricsParticles', 45),
  stageLyrics: createFrameGate('main.stageLyrics', 45),
  skullParticles: createFrameGate('main.skullParticles', 45),
  homeAudio: createFrameGate('main.homeAudio', 15),
  desktopOverlay: createFrameGate('main.desktopOverlay', 12)
};
window.__mineradioMainFrameGates = mainFrameGates;
```

目标帧率的动态算法（`11-main-loop.js:244-294`，全部乘 `runtimePerfScale`）：

| 闸门 | 规则（代码） |
|---|---|
| audio 频谱分析 | 播放 54 / 交互 72（×audioScale）；空闲 24/30 |
| shelf 3D 歌单架 | off→12；交互/展开/常驻→0（满帧）；否则 `38*scale` 下限 18 |
| lyricsParticles / stageLyrics | `RENDER_VISIBLE_VSYNC` 可见运动→0（满帧）；交互 120→下限 72；播放 60→48；空闲 24 |
| skullParticles | 同歌词粒子 |
| homeAudio 首页频谱 | 非 emptyHome 6、交互 30、否则 15 |
| desktopOverlay 桌面歌词 overlay 同步 | `fx.desktopLyricsFps`（24~120）；未启用 6 |

语义很关键：**闸门是"子系统更新频率"，不是整帧频率**。整帧仍由 rAF 驱动；被跳过的子系统保留 `pendingDt`，下次按累积 dt 更新，所以视觉上是"低频抖动"而非停更。

### 3.6 主循环结构（`11-main-loop.js:296-704`）

1. `framePerfStart = performance.now()`。
2. 深后台 → `tickDeepBackgroundFrame(now, dt)` 后 `return`（`:53-...`）。
3. `shouldSkipAdaptiveRenderFrame(now)` → 若跳过则直接 `scheduleNextMainLoopFrame()`。
4. `dt = min((now-prevTime)/1000, 0.05)`；splash 覆盖期 520ms 节流渲染并采样帧成本（`:329-337`）。
5. 依次 `consumeFrameGate(...)` 驱动：audio 频谱/beat → shelf → lyricsParticles → homeAudio → skullParticles → stageLyrics → desktopOverlay（`:357,603,607,611,648,676,680`）。
6. `perfProbe.markSince(...)` 分段埋点（`audio.analysis`/`visual.*`/`camera.update`/`renderer.render`）。
7. `renderer.render(scene,camera)`（`:692`）→ `frameCostMs`（`:694`）→ `sampleAdaptiveFrameCost(...)`（`:695-696`）→ `mark('frame.total')`。
8. `scheduleNextMainLoopFrame()` 提交下一次 rAF（`:704`）。

### 3.7 L4：深后台与恢复（`11-main-loop.js:182-199`、`08-desktop-render-power.js:406-423`）

- 判定（`08-desktop-render-power.js:125-134`）：`isDeepBackgroundMode()` = 非 `liveBackgroundKeep` 且（桌面态用 `desktopRuntimeState.minimized || visible===false`，浏览器态用 `document.hidden`）。注释里特意强调**以 native BrowserWindow 状态为准**，避免 tray 恢复后 `document.hidden` 陈旧——这是踩过坑的痕迹。
- 主循环：深后台不走 rAF，改 `setTimeout`（`:188-203`）：
  - 桌面歌词 / 壁纸模式开着 → 250ms；
  - `backgroundRelease` 策略 → 1500ms；
  - 默认 1000ms。
  返回前台由 `visibilitychange/focus` 唤醒（`wakeMainLoopFromBackground`）。
- 深后台额外（`08-desktop-render-power.js:406-423`）：renderer 尺寸压到 `4×4`、`setPixelRatio(min(device,0.30))`、`renderer.renderLists.dispose()`、触发缓存与内存压缩；恢复时按窗口尺寸重建。
- body class：`render-deep-sleep` / `render-background-eco`（`:150-153`），CSS 侧降低动画/滤镜成本。

### 3.8 缓存裁剪与内存压缩（`:334-405`）

| 项 | 常规保留 | aggressive | 触发间隔 |
|---|---|---|---|
| `playlistCoverCache` | 180 | 72 | 前台 45s / 深后台 7s / release 3.6s |
| `coverDepthCache` | 10 | 4 | 同上 |
| `beatMapCache` | 36 | 12 | 同上 |
| `djBeatMapCache` | 12 | 4 | 同上 |

- `requestBackgroundAppMemoryTrim`（`:334-361`）：仅深后台发 `window.desktopWindow.trimAppMemory({reason})`，间隔 ≥30s，延迟 1800ms（release 900ms）——防抖+防抖二次。
- `maybeTrimRuntimeCaches`（`:363-405`）：aggressive 时额外清 `stageLyricTrackCache` 并 `renderer.renderLists.dispose()`。
- 主进程侧 `trimAppMemoryNow/collectAppTrimPids`（`desktop/main.js:1942-2066`）按进程树 trim，配合 `system-memory.js` 的系统级清理（默认阈值 78%、间隔 30 分钟、默认关闭自动提升权限）。

### 3.9 性能探针（怎么测）

- `public/js/modules/00-state/09-performance-probe.js`（223 行）：`PERF_PROBE_VERSION='foreground-cpu-phase-a'`、每指标最多 90 样本、TOP 24 指标；暴露 `window.__mineradioPerf = {mark, markSince, begin, measure, count, summary, snapshot, reset, registerRenderState}`。
- `window.__mineradioRenderPerf`（`11-main-loop.js:2-18`）记录 mode/fps/frames/skipped/longFrames/targetFps/displayHz/adaptive*。
- `window.__mineradioPerfSnapshot`（`08-desktop-render-power.js:265-332`）：合并 render/runtime/gpu/hardware/budget/renderer.info（geometries/textures/calls/triangles）/viewport/frameGates/deepSleep/probe，并每 12s 采集一次 `performance.memory.usedJSHeapSize`（浏览器安全限制下可能为 0）。
- 验收指标写法见 `docs/LOW_SPEC_OPTIMIZATION_DOCTRINE.md:94-105`（前台空闲 CPU、播放 CPU、3D 歌单架 CPU、全屏 CPU、后台 CPU，均以 `__mineradioPerf` 快照为准）。

### 3.10 与 LOW_SPEC 文档的对照（文档 vs 代码）

| 文档条目 | 文档行号 | 代码现实 | 判定 |
|---|---|---|---|
| 默认 VSync，45/60/75/90/120 只是用户上限 | `LOW_SPEC:83-92` | `RENDER_VISIBLE_VSYNC=true` 恒 VSync；固定 FPS 模式由 `foregroundFpsMode` 用户选择（`00-state/04-fx-defaults.js:203-213`） | ✅ 一致 |
| 歌词纹理上传每帧最多 1 层、正文未齐统一透明、滑窗预热相邻 1 行 | `LOW_SPEC:3-20` | 行层分组构建有 `stepLyricRowLayerGroupBuild(state,maxPhases,budgetMs)` 分批（`02-visual/12-lyrics-row-layers.js:628`），同步兜底路径 `:710` | ✅ 基本落地（预算参数调用处待确认） |
| 禁止 `renderer.initTexture()` 同步上传 | `LOW_SPEC:9-14` | 歌词侧未见；但 3D 歌单架**主动** `warmTextureUpload()`→`renderer.initTexture()`（`04-shelf/01-manager-core.js:295-297`） | ⚠️ 语境不同：后者是空闲预热，文档禁令针对歌词逐帧路径 |
| 低配优先降音频分析/不可见图层/离屏纹理/缓存/后台任务 | `LOW_SPEC:83-92` | 已实现（audioScale/analysisStride/deepSleep/cacheTrim） | ✅ |
| 前台丝滑 vs 后台压缩；仅持续高压+高刷+高像素才允许按刷新率整除 cadence 回退 | `LOW_SPEC:148-154` | 有 cadence 选择器，但被 `RENDER_VISIBLE_VSYNC` 关闭；深后台直接 setTimeout | ⚠️ 后者实现，前者保留未启用 |
| 大歌单全量/分页 + UI 懒渲染 48 条一批 | `LOW_SPEC:156-162` | `PLAYLIST_LAZY_BATCH_SIZE=48`（`00-state/01-perf-render-state.js:27`），歌单架/列表按批拉取 | ✅ |
| 万首队列有界流动、左栏单滚动轴、真窗口虚拟化 | `LOW_SPEC:164-177` | 歌单架窗口化 ±5/11；列表虚拟化代码存在（待逐行核对） | ✅/待确认 |
| 歌词 CanvasTexture mipmap、WebGL1 非 POT 回退 LinearFilter、各向异性 4/8/16 | `LOW_SPEC:178-182` | `11-lyrics-shaders.js:5` 1024×512（POT）CanvasTexture；过滤参数在 mask/texture 工具模块 | 大体一致，细节待确认 |
| 实时视觉可停算独立开关必须绕过 shader 分支 | `LOW_SPEC:184-188` | 视觉开关在 `02-visual/04-visual-settings-persistence.js` 与 fx 默认值 | 待确认 |

### 3.11 帧预算关键常量总表

| 常量/参数 | 值 | 位置 |
|---|---|---|
| 默认 DPR cap / min | 1.35 / 0.72 | `01-scene/00-renderer-quality.js:5,7` |
| 默认像素 budget | 5,200,000 | `:6` |
| ultra / eco budget | 7.8M / 2.4M（低配 1.9M） | `:126-134` |
| 帧成本预算系数 | 0.78×帧间隔 | `:67` |
| EMA α | 0.08 | `:69` |
| pressure 步长 | +0.70 / −0.30 / −0.10，上限 8 | `:72-78` |
| level 阈值 | ≥2→1，≥4→2 | `:79` |
| 交互保持 | 900ms | `:19` |
| 刷新率采样 | 36 样本中位数，clamp 48~240，稳定切换阈值 18Hz | `:39-55` |
| 深后台 DPR | min(device, 0.30) | `:139` |
| 深后台 renderer 尺寸 | 4×4 | `08-desktop-render-power.js:406-423` |
| 深后台轮询间隔 | 1000ms（release 1500，歌词/壁纸 250） | `11-main-loop.js:182-187` |
| 单步 dt 上限 | 0.18s | `00-state/10-frame-scheduler.js:42` |
| 主循环 dt 上限 | 0.05s | `11-main-loop.js`（animate 内） |
| 列表批大小 | 48 | `00-state/01-perf-render-state.js:27` |
| 歌单架可见 ±N / 最大卡 | 5 / 11 | `04-shelf/01-manager-core.js:6-7` |

### 3.12 设计评价（可迁移的"规则"）

值得学的：
1. **把"预算"做成显式常量并换算成 DPR**（sqrt 反解），比"低/中/高"三档更可解释。
2. **帧闸门 = 子系统级限频 + pendingDt 累积**，是"降帧不降画质"的低成本方案，尤其适合"歌词粒子 45、歌单架 30、频谱 60"这类独立子系统。
3. **压力反馈带滞回**，避免档位抖动；注意它只改 `level` 不改像素，说明作者刻意把"反馈"与"画质"解耦（保守）。
4. 深后台三件套（rAF→setTimeout、4×4、缓存裁剪）+ 主进程内存 trim，形成"后台 = 近乎停算"的闭环。
5. 用 `__mineradioPerf` 暴露结构化指标给验收，而不是靠感觉调参。

要避免的：
- 死代码路径留在生产里（`selectAdaptiveRenderCadence`）；要么接线，要么删。
- 帧成本只统计 `animate()` 内耗时，**不含 GPU 实际渲染时间**（无 `EXT_disjoint_timer_query`/`GPU timer`），高估/低估都可能；Electron 里可加 `requestAnimationFrame` 间隔与 `renderer.info` 交叉验证（代码里已有 interval 采样，可扩展）。
- `sampleDisplayRefreshHz` 用 rAF 间隔估算刷新率，浏览器节流后会失真，代码用 `stableHz` 平滑兜底，但深后台醒来首帧仍可能误判。
- `RENDER_*` 常量是全局 `var`，无法按窗口/场景覆盖（桌面歌词 overlay 窗口只能另写一套）。

---

## 4. GSMTC 跟随（重点：本仓库**未实现**）

### 4.1 结论

v2.2.0 快照中**不存在** Windows GSMTC / System Media Transport Controls 集成，也不存在 Web Media Session API 集成。Lead 简报中的这条假设不成立，需按下述证据修正。

### 4.2 证据（可复现）

```text
$ grep -rniE "gsmtc|smtc|systemmediatransport|nowplaying|navigator\.mediaSession|MediaSession|SystemMediaTransport" \
    --include=*.js --include=*.html --include=*.md --include=*.json . | grep -v node_modules | wc -l
0
```

- 无 `navigator.mediaSession` 调用；无 `MediaMetadata`；无 `setActionHandler`。
- 无 `MediaPlayPause`/`MediaTrackNext`/`MediaPrevious`/`hardwareMediaKey` 等媒体键注册。
- 无 native 模块/`node-ffi`/`koffi` 可间接调用 SMTC（§2.5 已证）。
- `package.json` 无 `electron-media-service`、`node-smtc`、`@nodert-win10-*` 等依赖。
- README/CHANGELOG/docs 也未提到系统媒体面板（`docs` 检索 0 命中）。

### 4.3 与"系统媒体"最接近的三个替代机制

1. **应用内全局热键**：`globalShortcut.register()` 由渲染进程设置驱动，主进程转发 action（`desktop/main.js:1770-1815`）；内置 8 个动作（`public/js/modules/00-state/00-core-stores.js:159-168`）：播放暂停、上/下一首、音量±、全屏、桌面交互、桌面歌词。**只在本应用有焦点/已注册时有效，且只对 Mineradio 自身生效**——不具备"控制网易云/QQ 音乐/浏览器"的能力。
2. **窗口状态广播**：`getWindowState()/sendWindowState`（`desktop/main.js:1869-1903,1765-1772`）把播放/窗口状态发给渲染进程，桌面歌词窗口通过 `overlay-preload` 的 `onLyricsState` 接收（`desktop/overlay-preload.js`）。这是"应用内状态同步"，不是系统媒体会话。
3. **媒体键兜底**：代码里连媒体键（VK_MEDIA_*）都没有；桌面歌词的"中键锁定"用 `GetAsyncKeyState(4)` 轮询（`desktop/main.js:3638-3685`），是唯一和"系统级输入"相关的实现，但它是鼠标中键，不是媒体键。

### 4.4 对 Zilux2 的含义

- 这条能力**无法从 Mineradio 提取实现**，只能把本报告 §12.1 当作"设计参考"（对标 Zilux v1 已有实现做升级建议），而不是"移植来源"。
- 反过来看，Mineradio 的缺失也说明：Electron 应用若不做 native/SMTC 适配，媒体面板/媒体键就完全缺席——这恰好是 **C#/WPF 的 Zilux v1 的原生优势**，Zilux2 应保持"原生主进程持有媒体会话、WebView2 只做 UI"的分工。

---

## 5. WorkerW 桌面模式（重点）

### 5.1 两种模式（同一个 runtime 状态机）

| 模式 | 目标层级 | 目的 | 代码 |
|---|---|---|---|
| passive（壁纸层） | `SetParent(hostHWND, WorkerW)` | 把主窗口变成"壁纸"：在所有窗口之下、桌面图标之上（取决于壁纸层） | `wallpaper-mode-runtime.js:95-187` |
| interactive（全桌面可交互） | `SetParent(hostHWND, SHELLDLL_DefView)` | 与桌面图标共存并可点击/键盘交互，用于"整个桌面就是播放器" | `full-desktop-mode-runtime.js:128-246` |

主进程通过 `FullDesktopModeRuntime` 统一编排（`desktop/main.js:173-185`），对外暴露 `enable/setInteractive/toggleInteractive/disable/reconcile/getStatus/dispose`。注意：**没有独立的 wallpaper BrowserWindow**——`createWallpaperWindow` 的实现就是 `enableFullDesktopMode(mainWindow,{interactive:true})`（`desktop/main.js:3900-3917`），`closeWallpaperWindow` 即 disable。

### 5.2 附着管道（passive：找 WorkerW）

`desktop/wallpaper-mode-runtime.js:95-187` 动态生成 PowerShell 脚本，内联 C# 类 `MineradioDesktopWallpaperNative`：

1. `EnumWindows` 遍历顶层窗口；
2. 对每个候选 `FindWindowEx(candidate, 0, "SHELLDLL_DefView", null)`，非 0 说明该窗口是"桌面图标宿主"；
3. `FindWindowEx(0, candidate, "WorkerW", null)` 找**紧随其后的兄弟 WorkerW**（壁纸层）；
4. `SetParent(target, workerw)`；`GetWindowLong` 加 `WS_CHILD`；`SetWindowPos` 定位；
5. 输出 JSON ack：`parentClassName: "WorkerW"`、`child: true`、`popup: false`、窗口句柄等。

C# 核心（节选）：

```csharp
// desktop/full-desktop-mode-runtime.js:143-168,207（interactive 版脚本，结构同源）
[DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string className, string title);
[DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
[DllImport("user32.dll", SetLastError=true)] static extern IntPtr SetParent(IntPtr child, IntPtr parent);

EnumWindows(delegate(IntPtr candidate, IntPtr unused) {
  IntPtr view = FindWindowEx(candidate, IntPtr.Zero, "SHELLDLL_DefView", null);
  if (view != IntPtr.Zero) { /* 找到图标宿主，再找其后的 WorkerW / 直接挂 DefView */ }
  return true;
}, IntPtr.Zero);
SetParent($target, $defView);   // interactive：挂到 DefView 下
```

关键细节：脚本里 `SetThreadDpiAwarenessContext(-4)`（Per-Monitor V2）后再做坐标换算，`finally` 恢复原 context；坐标用 `ScreenToClient` 转为父窗口客户区坐标，避免 DPI 缩放错位（`wallpaper-mode-runtime.js:95-187`、`full-desktop-mode-runtime.js:128-246`）。

### 5.3 interactive 模式的 ack 校验（防"假成功"）

`full-desktop-mode-runtime.js:248-278`：

- `parseDesktopCoexistAck`：必须 `coexist===true`、`child===true`、`popup===false`、`parentClassName==='SHELLDLL_DefView'`、句柄非 0——**任一不满足即失败**。
- `parseDesktopNativeAck`（detach）：`parentWindowId==='0'`、`child===false`、`popup===true`。
- 失败返回结构化错误码（`:280-286` 提取 `FULL_DESKTOP_*`/`WALLPAPER_*`），主进程走 fail-closed 回退。

这是整个实现里最值得学的工程点：**native 操作必须回读校验，不能信"调用没抛错"**。

### 5.4 状态机与恢复

- 操作串行化：`enqueue()`（`:639-655`）保证 attach/detach/interactive 切换不并发；`generation` 计数丢弃过期结果。
- `enable`：先隐藏宿主窗口 → 附着 → 等"形状落地"（interactive 时还要等图标层/renderer 首帧）→ 再显示；期间 `fullDesktopEnablePending/Operation` 双计数防竞态（`desktop/main.js:1433-1461`）。
- 失败：`markIconLayerRestoreUnconfirmed`（`:767-779`）把窗口隐藏、`ignoreMouseEvents=true`、`setFocusable(false)`、phase 置 `error-unknown-native-state`——**宁可不可用，也不留一个"看不见却吃点击"的幽灵窗口**。
- 恢复：`reconcile(reason)`（`:1931-1952`）按当前显示器/全屏状态重算；显示布局变化、Explorer 重启（`hookExplorerRestartForFullDesktop`，`desktop/main.js:3810`）都会触发。
- 退出兜底：`ensureFullDesktopModeRecoveryTray`（`desktop/main.js:2145-2165`）在模式激活期间提供托盘菜单"退出完整桌面模式"；`Escape` 全局热键（`:1346-1372`）→ `requestFullDesktopEscapeExit`（`:1323-1345`），并且注册失败会恢复之前被挂起的绑定。
- 图标层熔断：`ICON_HOST_RECOVERY_CIRCUIT_WINDOW_MS=12000`、`LIMIT=2`、`STABLE_MS=10000`（`full-desktop-mode-runtime.js:16-18`）——10s 内崩两次进入"不再自动恢复"的熔断态。

### 5.5 点击穿透与"图标层"

- 全桌面模式下需要"桌面图标显示在播放器之上"→ 用 `desktop-native-icon-layer-runtime.js` 创建 layered window：`WS_EX_LAYERED 0x00080000` + `SetLayeredWindowAttributes(..., LWA_COLORKEY, 0x00000000)`（`:63-68,149,258-319`），把图标区域的背景色键透明化，再叠到宿主之上；图标布局由 `desktop-icon-shape-runtime.js` 探测（超时 5000ms、最多 1024 rect、硬上限 4096）。
- 交互锁定：`setSoftwareInteractionLocked`/`setDesktopIconsVisible`/`updatePointerRoute`（`desktop/main.js:3990-4060`）把"哪块区域可点、哪块穿透"下发给 runtime；`ignoreMouseEvents` 状态在 status 中回读（`getStatus` 字段含 `ignoreMouseEvents/pointerRoute`）。
- 桌面歌词窗口的穿透是另一套：`applyDesktopLyricsMouseBehavior`（`desktop/main.js:3594-3600`）锁定态 `setIgnoreMouseEvents(true,{forward:true})` + hot bounds（`:3602`）+ 中键轮询切换（`:3623-3633`）。`docs/DESKTOP_LYRICS_VISUAL.md:17-20` 明确"锁定态鼠标穿透、仅主进程 GetAsyncKeyState(4) 可解除"。

### 5.6 退出与恢复 Shell

- 关闭主窗口时若全桌面模式开启：先 `disableFullDesktopMode` 再走关闭（close 分支在 `desktop/main.js:5758-5810`，tray 行为判定在 `:5788`）。
- `disable`：`restoreWindow(snapshot)`（bounds/style/focusable/hasShadow 等，`:422-455` 快照 + `:1954-2036` 恢复），再把 `WS_CHILD` 改回 `WS_POPUP`、`SetParent(NULL)`、`SetWindowPos`，并校验 `GetWindowRect` 误差 ≤±16px（`wallpaper-mode-runtime.js:51-126`）。
- `before-quit` 里全桌面 dispose 有 7000ms 超时兜底（`desktop/main.js:5975-6030`），避免"SetParent 卡住导致应用退不掉"。

### 5.7 多显示器 / DPI

- 状态里保存 `displayId/bounds/physicalBounds/workArea/safeInsets`（`full-desktop-mode-runtime.js:583-629`），物理像素用 `screen.dipToScreenRect` 换算（`wallpaper-mode-runtime.js:323-351`）。
- 显示布局变化 → `reconcile` + 重新 `SetWindowPos`；WE 宿主另有一套 bounds 跟随（`desktop/main.js:1168-1308`，`scheduleWallpaperEngineHostBoundsRestart`）。
- 已知约束（代码注释推断，`待确认`）：WorkerW/DefView 是**每个显示器/每个 Explorer 桌面一个**，代码只取"找到的第一个"，多显示器下应把窗口放到目标显示器的 WorkerW；目前实现是否支持跨屏选择需实测。

### 5.8 已知坑（代码/文档里写明或可推断）

1. **child-to-child 直接 `SetParent` 会被回退**：注释原文 `"a direct child-to-child SetParent can be reverted by later"`（`full-desktop-mode-runtime.js:1908`）→ 代码改为"先 detach 到顶层再 attach 到目标层"。
2. **`SetParent` 后样式不自动改**：必须手动加/去 `WS_CHILD`、`SetWindowPos`，否则窗口不显示或尺寸错乱。
3. **Explorer 重启**：WorkerW 消失，必须监听并重挂（`hookExplorerRestartForFullDesktop`）。
4. **Electron 自身缓存父窗口**：主进程 1059 行注释提到 `prepareWindow() clears the legacy BrowserWindow shape before SetParent`，即先清掉 Electron 记的窗口形态再挂。
5. **托盘恢复入口不可省**：模式失败后用户可能"看不到窗口"，恢复托盘是最后逃生门。
6. **`Escape` 注册冲突**：全局 Escape 可能被其他软件占用，注册失败要降级到 `before-input-event`（`:5688` 有 Escape 输入分支）。
7. **任务栏/Alt+Tab**：`skipTaskbar` 与全桌面模式组合会让窗口"消失"，代码用恢复托盘 + 窗口可见性守护（`:5313-5363`）兜底。
8. **Win 版本兼容**：`DwmRegisterThumbnail` 需 Win8+；WorkerW 结构在 Win7/Win10/Win11 有差异。代码未见显式版本分支（`待确认`）。

### 5.9 对 Zilux2 的升级点（相对 Zilux v1）

Zilux v1 已用 WebView2 页面挂 WorkerW 做桌面歌词壁纸。可升级的：
1. **发现与校验**：`SHELLDLL_DefView` → 兄弟 `WorkerW` 的查找顺序 + ack 回读校验（`child/popup/parentClassName`），避免"SetParent 成功但实际挂到错误层"。
2. **双层级**：passive（壁纸层）与 interactive（DefView child，可交互）分离；桌面歌词/视频壁纸走 passive，需要点击的"桌面播放器"走 interactive。
3. **恢复阶梯**：失败 → 隐藏窗口 + 禁用交互 + 恢复托盘 + 熔断，而不是抛异常后留白屏。
4. **退出恢复 Shell**：`WS_CHILD→WS_POPUP` + `SetParent(NULL)` + `GetWindowRect` 容差校验，退出前恢复快照（位置/样式/focusable）。
5. **多显示器**：按目标 display 的 WorkerW 挂载 + 物理像素换算；v1 若只支持主屏，这是明确增量。
6. **点击穿透 + hot bounds**：锁定态整窗穿透，仅 hot bounds 内转发；解锁态可拖动/关闭。中键轮询是低成本方案（但 24ms PowerShell 轮询耗电，C# 侧可直接 `GetAsyncKeyState` 定时器替代）。
7. **叠放顺序**：视频壁纸（DWM thumbnail 宿主）在最底层 → WebView2 歌词层在其上 → 图标层再上（若需保留桌面图标）→ 任务栏始终最上。Mineradio 用"图标层 color-key"解决图标遮挡，Zilux2 可用更简单的"不隐藏图标/仅覆盖图标间隙"策略评估。

---

## 6. 粒子 / 星河视觉

### 6.1 视觉栈总览

| 模块 | 职责 | 行数/关键点 |
|---|---|---|
| `public/js/modules/02-visual/00-pointer-cover-particles.js` | 封面粒子主体（GPU 粒子 + bloom + 星河背景） | `:221-222` 网格与数量；`:1010-1160` shader/几何体 |
| `02-visual/01-float-skull-backcover.js` | 漂浮尘埃骷髅 + 封面背面粒子 | `:2` FLOAT_COUNT=1300；`:691` BACK_COVER_COUNT=3000 |
| `02-visual/03-lyrics-star-river.js` | 歌词星河（源位置→组成文字） | `:22` count=420；`:50-75` vertex shader |
| `02-visual/11-lyrics-shaders.js` | 太阳辉光/遮罩 CanvasTexture | `:5` 1024×512；`:57` CanvasTexture |
| `02-visual/12-lyrics-row-layers.js` | 歌词行层纹理分组/预算构建 | `:628` stepLyricRowLayerGroupBuild；`:710` 同步兜底 |
| `02-visual/13-lyrics-mesh-build.js` | 歌词 Mesh/行布局（fontSize=128） | `:21-23` |
| `02-visual/14-stage-lyrics-rendering.js` | 舞台歌词渲染（3207 行） | `:1063` 行层构建入口 |
| `public/sonic-topography-preset.js` / `sonic-workshop-preset.js` | 预设 shader/参数存档 | 1081 / 818 行 |
| `01-scene/01-orbit-free-camera.js` | 自由轨道相机 | `:5-7` radius 6.6、min 2.4/max 14；`:26` baseline 8.4；`:29` FOV 45 |
| `01-scene/02-beat-camera-runtime.js` | 节拍驱动镜头 | `:366-403` 频段→镜头脉冲 |
| `01-scene/03-focus-cinema-camera.js` | "电影镜头"焦点相机 | 近景/远景切换、缓动 |

### 6.2 封面粒子（主视觉）

- 网格数由"封面分辨率"参数换算：`GRID_X = coverParticleGridForResolution(fx.coverResolution)`、`PCOUNT = GRID_X*GRID_Y`（`00-pointer-cover-particles.js:221-222`）；分辨率默认 `coverResolution=1.55`（`00-state/04-fx-defaults.js:14`），`coverParticleGridForResolution(v)=Math.round(118*v)` 量级（`02-visual/04-visual-settings-persistence.js:72-73`）。
- 几何体是 `THREE.BufferGeometry` + 自定义 attribute（`aRand/aUv/aPos` 等），材质 `THREE.ShaderMaterial`（`:1010-1015`）；`bloom` 通道有独立 vs/fs（`:1015-1048`），最终两个 `THREE.Points` 叠加（`:1052`、`:1155`）。
- 粒子形态不是"点云"，而是**花瓣/涟漪式程序化分布**：`bloomR=pow(aUv.y,0.72)`、`bloomTheta=aUv.x*2π+bloomR*0.72+t*0.018`，用 `uBass/uMid/uTreble/uBeat` 驱动半径/透明度/涟漪幅度（`:824-847`）。
- 星河背景独立层：`BACKGROUND_STAR_RIVER_COUNT=1400`（`:1057`），`THREE.Points`（`:1155`）。
- 性能护栏：`antialias:false`；粒子上限由网格参数控制（用户可调）；无逐帧 attribute 重建（除分辨率变化时重建几何，`:258-271`）；shader 内做程序化动画，CPU 只更新 uniforms。

### 6.3 音频驱动链（无 WASAPI）

```
HTMLAudioElement (audio)
  → AudioContext.createMediaElementSource(audio)（失败则重建 Audio 元素并重连，05-playback/08-audio-graph-controls.js:113-138）
  → analyser.fftSize = FFT_SIZE（默认 2048，13-playback-start-audio.js:190）
  → beatAnalyser.fftSize = BEAT_FFT_SIZE，smoothingTimeConstant 0.10（频谱 0.58）
  → getByteFrequencyData / getByteTimeDomainData（:206、:199）
  → 频段 RMS：38-74 / 52-165 / 165-420 / 420-2600 / 2600-6200 / 6200+（01-scene/02-beat-camera-runtime.js:366-403）
  → beat engine（bassPeak*0.994 衰减）+ 相机/粒子/歌词 uniforms
```

- 离线节拍：`OfflineAudioContext` 分离"低频重鼓/中频鼓身/高频敲击感"（`03-beat/01-audio-beat-analysis.js:18-34`）；`music-tempo` 以 **Blob Worker** 运行（`03-beat/00-tempo-worker-cache-prefetch.js:92-124`），渲染进程唯一的 Web Worker（`03-beat/00-tempo-worker-cache-prefetch.js:153` 附近）。
- 无 WASAPI/loopback：不能对"其他播放器"做频谱，只能对自身 `<audio>` 元素分析——这是与 Zilux v1（WASAPI loopback）的本质差异。

### 6.4 GPU 资源管理与护栏

- 纹理：CanvasTexture（1024×512、字模/遮罩）→ 行层重建时 `needsUpdate=true` 并复用 canvas（`12-lyrics-row-layers.js`、`11-lyrics-shaders.js:5-57`）。
- 几何体/材质：3D 歌单架卡片在 `disposeShelfCard` 里 `geometry.dispose()/material.map.dispose()`（`04-shelf/01-manager-core.js:285-309`），歌词 Mesh 有对应 dispose 路径（`13-lyrics-mesh-build.js`）。
- 观测：`renderer.info`（geometries/textures/calls/triangles）进 `__mineradioPerfSnapshot`；`renderer.renderLists.dispose()` 用于深后台/aggressive 清理。
- 限制：源码里未见显式的"最大纹理数/显存预算"逻辑（`待确认`），全靠分辨率参数 + 状态机控制。

### 6.5 可移植性

- **可移植到 WebView2**：Three.js + GLSL（WebGL2 可用）、CanvasTexture、AnalyserNode、OfflineAudioContext、rAF + frameGate 逻辑——都是标准 Web 能力。
- **不可直接移植**：Electron 主进程侧的窗口/内存/进程能力（深后台 renderer 4×4、tray 状态权威、trim IPC）；以及"自动画质档位"依赖的 `performance.memory`（WebView2 无此 API，需 C# 侧提供进程内存）。
- 若 Zilux2 把视觉放 WebView2：把"限帧/降档/深后台"的**决策权留在 C# 主进程**（例如 C# 判断窗口可见性后通过 `postMessage`/JS 互操作下发 `setRenderPowerMode(deep/eco/normal)`），WebView2 侧只执行——比 Mineradio 的"渲染进程自己猜 document.hidden"更可靠（Mineradio 已经踩过 `document.hidden` 陈旧的坑，见 `public/js/modules/00-state/08-desktop-render-power.js:125-134` 的注释）。

---

## 7. 3D 歌单架

### 7.1 结构

模块（`public/js/modules/04-shelf/`）：
- `01-manager-core.js`：卡片生命周期、窗口化、布局、raycast、dispose。
- `02-rebuild-panel-sync.js`：面板与卡片同步。
- `03-content-list-manager.js`：曲目列表/分页（懒加载）。
- `04-cover-api-helpers.js`：封面获取。
- `05-card-interactions.js`：指针交互/wheel/点击。
- `06-keyboard-camera-events.js`：键盘/相机事件。

数据模型：`playlists → panes（splitPlaylists）→ shelfCards[]`；每张卡 = `{mesh, texture, canvas, ctx, playlistId, ...}`（`01-manager-core.js`）。

### 7.2 窗口化渲染（核心内存策略）

```js
// public/js/modules/04-shelf/01-manager-core.js:6-7,346-378（语义等价节选）
var SHELF_VISIBLE_RADIUS = 5;
var SHELF_MAX_RENDER = SHELF_VISIBLE_RADIUS * 2 + 1;   // 11

var start = Math.max(0, center - SHELF_VISIBLE_RADIUS);
var end = Math.min(total - 1, start + SHELF_MAX_RENDER - 1);
start = Math.max(0, end - SHELF_MAX_RENDER + 1);
// 只为 [start,end] 建卡；范围外卡片 mesh.visible=false；被淘汰的卡 dispose
```

- 相机移动时按"中心索引"滚动窗口，**只保留 11 张卡**（`renderOrder=60+…` 控制遮挡顺序，`:419-421`）。
- 卡片纹理：`new THREE.CanvasTexture(cv)`（`:248`），状态变化时 `texture.needsUpdate=true`（`:241`）——用 2D canvas 绘制封面+文字，避免 DOM 层叠。
- `disposeShelfCard`（`:285-309`）释放 geometry/material/texture；`reusable` 池（`:378`）优先复用。
- `warmTextureUpload`（`:295-297`）在空闲时主动 `renderer.initTexture(tex)`，把上传成本从"可见瞬间"提前到"空闲时"——这是**有意为之的取舍**（与 LOW_SPEC 对歌词路径的禁令不冲突，见 §3.10）。

### 7.3 懒加载

- 列表批大小 48（`00-state/01-perf-render-state.js:27`），`CONTENT_PREFETCH_AHEAD = max(24, 0.75*48)`（`04-shelf/03-content-list-manager.js:10`）——滑动时提前半屏预取。
- 分页请求按 provider 走不同 API（`:276,719-730`：内置/播客/QQ/酷狗/汽水/Spotify/网易云），统一 `limit=PLAYLIST_LAZY_BATCH_SIZE`。
- 面板/行纹理同样用 CanvasTexture 增量更新（`:85,153,402,487`）。

### 7.4 交互

- raycast 命中：`raycasterFromPointerEvent`（`05-card-interactions.js:2`）、`pointerCardHit(...,18/24)` 的像素容差（`:17-20`）；常驻模式命中范围 18px，preview 模式 24px。
- wheel 滚动切换卡片（`:179-184`）；点击/双击/右键菜单动作在 `05-card-interactions.js` + `06-keyboard-camera-events.js`。
- 相机：侧向角度/展示模式（off/side/stage）、动态/静态镜头（文档 `docs/3D_PLAYLIST_SHELF_MEMORY.md:40-54`）；实现走 `01-scene/*` 相机状态机。

### 7.5 内存策略（文档声称 vs 代码）

- 文档：详情页歌词 opacity 普通 0.38/骷髅 0.30，靠 renderOrder + 削弱 glow/sun/spark 减少过度绘制（`docs/3D_PLAYLIST_SHELF_MEMORY.md:5-7`）；常驻实卡质感、`shelfBgOpacity`、`selected/floatMix`（`:11-16`）；`fx.shelfShowPodcasts` 默认 true、`fx.shelfMergeCollections` 默认 false（`:25-27`）。
- 代码对应：`disposeShelfCard`/`reusable`/窗口化（§7.2）成立；`renderOrder` 在 `01-manager-core.js:421` 有实现。
- **文档漂移**：`docs/3D_PLAYLIST_SHELF_MEMORY.md:49-54` 称"关键实现位置 public/index.html（makeShelfManager/placeCard、#shelf-seg 等控件）"，实际实现已迁到 `04-shelf/*` 模块，`public/index.html` 只剩 DOM 容器；文档仍是旧版路径（`待确认` 控件 id 是否还存在于 index.html）。

---

## 8. Electron 主进程与打包

### 8.1 `desktop/main.js` 分区（6058 行）

| 区块 | 行号 | 内容 |
|---|---|---|
| 顶部 require/常量 | 1-130 | electron API、runtime 模块、`WINDOWED_*`、`STARTUP_*`、`RENDERER_RECOVERY_*` |
| 缓存设置 | 280-467 | `cacheSettings`、歌词缓存 96MB 上限（`:125`）、目录清理 |
| Chromium switches | 478-500 | `CHROMIUM_SAFE_PERFORMANCE_SWITCHES`（gpu-raster/oop/zero-copy/accelerated-2d-canvas、`use-angle=d3d11`）+ 环境变量开关（force_high_performance_gpu、keep_background_rendering） |
| 单实例/超时工具 | 501-671 | `findOpenPort`、`waitForServer`、`waitForLocalHttpReady` |
| fx 自动保存 | 672-737 | 12MB 上限、before-quit flush |
| 信任校验 | 738-830 | `isLocalAppUrl`、`isTrustedMainWindowIpc`、WE IPC 信任 |
| WE 采集/预览 | 832-1167 | `prepareWallpaperEngineRendererCapture` 等 |
| WE 宿主生命周期 | 1168-1308 | suspend/resume/stop/bounds restart |
| 全桌面模式 | 1310-1530 | enable/interactive/disable/reconcile + Escape 快捷键 |
| 权限 | 1654-1764 | 本地应用权限、摄像头授权 |
| 热键/窗口状态 | 1765-1903 | `configureMineradioGlobalHotkeys`、`getDisplayState/getWindowState` |
| GPU/内存 | 1919-2066 | `getGpuDiagnostics`、`trimAppMemoryNow`、自动内存 tick |
| 托盘/工具 | 2068-2330 | closeBehavior、`createOrUpdateTray`、启动错误上报、`ensureDesktopShortcut` |
| 登录窗口 | 2360-3300 | 网易云/QQ/酷狗登录窗口、cookie 解析、Spotify PKCE |
| 桌面歌词 | 3527-3800 | `overlayUrl`、创建/定位/鼠标行为/中键轮询 |
| 主窗口生命周期 | 3810-3916 | Explorer 重启 hook、最小化意图 hook、wallpaper window 别名 |
| IPC 大表 | 3900-5200 | 窗口/全桌面/WE/歌词/壁纸/登录/更新/内存/缓存… |
| 启动链 | 5236-5913 | server → window → load → show |
| app 事件 | 5915-6058 | 单实例、whenReady、before-quit 清理 |

### 8.2 本机 HTTP 服务（`server.js`，同进程）

- 创建：`const server = http.createServer(...)`（`server.js:4635`），`server.listen(PORT, HOST)`（`:6708`）。
- 静态：`/` → `index.html`，其余路径 `path.join(__dirname,'public',filePath)`（`:6697-6705`）；`/favicon.ico` 特判（`:6698`）。
- API：约 **105 个** `/api/*` 分支（音源搜索/播放/歌词/歌单/登录/推荐/天气/播客/DJ/更新/性能/beats）；例：`/api/app/version`（`:4655`）、`/api/update/latest`（`:4742`）、`/api/cuefield/transition`（`:4783` 附近）、`/api/platform/capabilities`、`/api/listen/report`。
- 音频代理支持 Range（`:6639-6661`），`Accept-Ranges/Content-Range` 透传，解决 `<audio>` seek 与跨域。
- 有大量音源聚合/降级逻辑：QQ/Kugou/Qishui/网易云/Spotify(部分以 404 `PROVIDER_REMOVED` 关闭)，`qishui-audio-decryptor` 解密汽水音频；`dj-analyzer` 做播客 DJ 分析。
- 风险：默认 `0.0.0.0` 监听 + 无统一鉴权（§2.6），且 `server.js` 直接 `require` 各 provider 模块，存在 SSRF/凭据泄露面（`待确认` 是否有内网访问校验）。

### 8.3 preload 与 IPC

- `desktop/preload.js`（151 行）：`contextBridge.exposeInMainWorld('desktopWindow', {...})`，覆盖：
  - 窗口控制、`getGpuDiagnostics`、`getMemorySnapshot/configureMemoryAuto/trimAppMemory/purgeSystemMemory`；
  - 缓存设置、本地音乐库、内置歌单、歌词缓存；
  - Wallpaper Engine：列表/详情/选择目录/启动场景/采集授权/DWM surface；
  - 登录：网易云/QQ/酷狗/汽水/Spotify、cookie 导出导入；
  - 桌面歌词：set-enabled/update/set-dragging/pointer-capture/hot-bounds/lock-state/move/close；
  - 壁纸模式、全桌面图标层、指针路由、键盘焦点；
  - 更新：`openUpdatePage`（`:86`）、`restartApp`（`:87`）。
- `desktop/overlay-preload.js`（19 行）：`desktopOverlay` 命名空间，供 `desktop-lyrics.html` 使用（onLyricsState/onWallpaperState/setLyricsDrag/…）。
- 主进程 IPC 注册集中在 `desktop/main.js:3900-5200`；高价值 handler 有发送方校验（`isTrustedMainWindowIpc`），WE/歌词窗口各有独立信任函数。

### 8.4 窗口 / 托盘 / 快捷键 / 自启动

- 主窗口：frameless、transparent、`backgroundColor:'#00000000'`、`hasShadow:true`、`contextIsolation:true`、`sandbox:false`（`desktop/main.js:5599-5621`）；自绘标题栏在 `public/index.html`（`#desktop-titlebar`）。
- 关闭行为：`exit`/`tray`/`minimize` 三态（`normalizeCloseBehavior`，`:2068`），tray 模式下关窗即隐藏并 trim 内存。
- 托盘：`createOrUpdateTray`（`:2109-2144`），菜单"显示/退出完整桌面模式/退出"。
- 全局热键：渲染进程设置 → `ipc` → `configureMineradioGlobalHotkeys(bindings)`（`:1782-1815`），注册失败返回 `conflict` 结构给 UI；Esc 全桌面退出单独注册（`:1346-1372`）。
- **开机自启：没有实现**（全仓无 `setLoginItemSettings`/`openAtLogin`/注册表 Run 写入），仅在桌面/开始菜单建快捷方式（`ensureDesktopShortcut`，`:2327`）。`待确认` 是否是刻意取舍。

### 8.5 桌面歌词窗口（`desktop/main.js:3527-3800`）

- `overlayUrl()`（`:3527`）→ `desktop-lyrics.html`；窗口参数：920×190、`frame:false`、`transparent:true`、`focusable:false`、`skipTaskbar:true`、`preload:overlay-preload.js`、`backgroundThrottling:false`（`:3745-3760`）。
- 置顶：`setAlwaysOnTop(true,'screen-saver')` + `setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true})`（`:3768-3770`）。
- 定位/状态：y 比例 clamp 0.08~0.92（`desktop/main.js:3543`）、opacity clamp 0.28~1 默认 0.92（`:3715`）；拖拽在解锁态。
- 穿透：锁定态 `setIgnoreMouseEvents(true,{forward:true})` + hot bounds，中键切换由 PowerShell 轮询（`:3594-3685`）。
- 渲染：`public/desktop-lyrics.html`（1237 行）纯 DOM/CSS 歌词条 + 动画（`filter/blur/opacity`），不是 WebGL——**与主窗口视觉栈完全独立**。

### 8.6 更新机制（`docs/UPDATE_DELIVERY.md` + 代码）

- 前端：`08-account/00-update-preview.js:2-3` 注释明确 "Update preview: external download page only. Mineradio no longer downloads installers or applies resource patches."；`:82` 请求 `/api/update/latest?t=…`；下载页 URL 只允许 https（`:5-13`）、最多 6 个（`:15-31`）。
- 服务端：`/api/update/latest`（`server.js:4742`），GitHub `releases/latest/download/latest.yml`（`:933`）+ 可选 `MINERADIO_UPDATE_MANIFEST`（本地文件/URL，`:473-475`，用于测试/内测）；镜像候选排序（国内加速线路 → GitHub 直连，`:504-540` 附近）。
- 文档约束（`docs/UPDATE_DELIVERY.md:3-16`）：每次发布必须有完整安装包 + `latest.yml`；`docs/update/latest.yml` 只放版本号+发布时间（不填 files/path/url/sha512）；启动约 9 秒查一次、失败不重试；全屏/沉浸/壁纸模式隐藏标题栏入口。
- **没有** electron-updater / 差分更新 / 静默安装——这是刻意的安全取舍（避免自更新供应链风险），代价是用户手动下载。

### 8.7 Wallpaper Engine 集成（DWM thumbnail）

- `desktop/wallpaper-engine-library.js`：Steam 库发现（`registry`/`libraryfolders.vdf`）+ 只索引 `project.json` 的 WE 项目，**不执行** Web/Application 类型项目（`NOTICE.md:14-19`）。
- `desktop/wallpaper-engine-runtime.js`（4149 行）：
  - 常量：`MIN/MAX_WIDTH/HEIGHT`、`MIN_FPS 15/MAX_FPS 240`、`DEFAULT_FPS 60`、源超时 15s（`:9-23`）；
  - 子进程脚本按环境变量下发：`MINERADIO_WE_DWM_SOURCE_ID/TITLE/EXECUTABLE`、`HOST_WINDOW_ID`、`HOST_CORNER_RADIUS`、`VISUAL_OPACITY/POSITION_X/Y/SCALE`（`:990-1010`；指针/控制脚本见 `:771-776,546-552,266-315`）；
  - C# 宿主：`DwmRegisterThumbnail/Update/Unregister`（`:1109-1116`），WinForms 无边框窗、`HTTRANSPARENT`、follow timer、stdin 命令（`Q` 退出、`D` 激活、`I|0/1` 图标层开关）。
  - 回退：helper 启动失败/超时 → `desktopCapturer` 抓 WE 窗口帧（`desktop/main.js:832-1064` 的 capture grant/prepare；`:1066-1167` helper 退出等待）。
- 主进程负责：嵌入式宿主窗口 bounds 跟随、全屏/最小化时 suspend/resume（`:1206-1308`）、桌面模式下暂停/恢复、图标层联动（`:1396-1461`）。

### 8.8 打包与安装器

- `package.json:13-95`（electron-builder 段）：
  - `appId: com.mineradio.desktop`、`afterPack: build/after-pack.js`（rcedit 注入图标/版本信息，未签名）、`asar:false`；
  - `files` 白名单：`desktop/**`、`public/**`、`build/**`、`cuefield/**`、`server.js`、`*-api.js`、`qishui-*`、`dj-analyzer.js`、LICENSE、NOTICE.md、`docs/THIRD_PARTY_PORTS.md`、package.json；**排除** `!desktop/wallpaper-preload.js`、`!public/wallpaper.html`、`!public/index.*.html`；
  - `win`: `executableName: Mineradio`、`icon: build/icon.ico`、`signAndEditExecutable:false`、target `nsis x64`；
  - `nsis`: `oneClick:false`、`perMachine:false`、不允许改安装目录、桌面/开始菜单快捷方式、`include: build/installer.nsh`、`artifactName: Mineradio-${version}-Setup.${ext}`；
  - `publish`: GitHub `XxHuberrr/Mineradio`；`mineradio.update`：GitHub + `preferMirrors:true` + 3 个镜像前缀（`gh.llkk.cc`/`ghfast.top`/`gh-proxy.com`）。
- **坑（真实存在）**：`files` 排除项引用的 `desktop/wallpaper-preload.js`、`public/wallpaper.html` 在仓库中**不存在**（实际是 `desktop/overlay-preload.js` 与 `public/desktop-lyrics.html`）。这是历史遗留的排除规则，不影响构建但说明清单已漂移；`待确认` 是否 v2.2.0 之前存在过。
- 安装器风格见 `docs/INSTALLER_STYLE.md`（63 行）与 `build/installer.nsh`（自定义 MUI 位图/颜色）。
- 风险：`asar:false` + 未签名 + 明文 JS，任何本地用户可改；对"桌面美化类软件"可接受，但不适合安全敏感场景。

### 8.9 崩溃/启动恢复（值得学的兜底）

- 启动看门狗：`STARTUP_SHOW_WATCHDOG_MS=3500`，超时强制 `showMainWindowSafely('watchdog')`（`desktop/main.js:5627-5629`）。
- 渲染进程崩溃：`render-process-gone` → 关闭 WE/歌词窗口、写 `MR-RUNTIME-RENDERER-GONE` 启动错误日志、必要时 `recoverMainWindowAfterRendererGone`（最多 3 次，2 分钟窗口，`RENDERER_RECOVERY_*`）。
- 不可见恢复：`minimize`/`hide` 非预期发生时 900~1200ms 后自动恢复（`MAIN_WINDOW_HIDE_RECOVERY_DELAY_MS`/`MAIN_WINDOW_MINIMIZE_RECOVERY_DELAY_MS`）。
- 单实例：第二次启动 `second-instance` → `focusMainWindow()`。
- 启动状态/错误文件：`startup-state.json`、`startup-error.log`（`writeStartupState/writeStartupErrorLog`，`:2195-2250`）。

---

## 9. GPL-3.0 边界与可借鉴清单

### 9.1 许可事实

- `LICENSE` 是 GPLv3 全文（561 行），`package.json:7` 写 `"license": "GPL-3.0-only"`；`README.md:113-119` 声明 GPL-3.0、Copyright (C) 2026 XxHuberrr，名称/Logo/视觉归作者。
- GitHub API 显示 `NOASSERTION` 的原因：仓库 LICENSE 元数据未标准识别/仓库改名暂停等，**以 LICENSE 文件原文为准**判定为 GPL-3.0-only。
- `NOTICE.md:5-12` 列出第三方：Electron、Three.js、GSAP、music-tempo、NeteaseCloudMusicApi、mpg123-decoder；`:14-19` 列出社区移植（Cuefield AutoMix、WE 本地库检测、全桌面主窗口模式、汽水 QR 登录），均声明 GPL-3.0 且注明 commit hash。
- `docs/THIRD_PARTY_PORTS.md:3-22/24-54/56-78` 进一步给出每个移植的"边界"：cache-only planner、fail-closed WorkerW discovery、隔离 hidden Electron host、`qishui-auth-v6/` 字节级保留等。

### 9.2 传染性结论（对 Zilux2）

- **不能复制代码**到闭源项目：GPL-3.0 的传染性覆盖"衍生作品"，Mineradio 的 JS/Shader/CSS/HTML 都受 GPL 约束；把其代码粘贴进 Zilux2（无论 C# 还是 WebView2 前端）都会让 Zilux2 整体落入 GPL 义务（源码公开、允许再分发）。
- **可以学思路**：算法/架构/常量/性能策略/"踩坑经验"不受版权保护（属于思想/方法），但在文档与代码注释里也应避免逐字复制大段文字；重写实现、独立命名。
- **Shader/纹理/预设存档风险最高**：`public/sonic-*.js`、`NOTICE.md:27-31` 的"原创视觉/粒子/电影镜头"是作者保留的视觉资产，即使 GPL 允许复制，署名/名称/Logo 条款和道德边界都不适合照搬；Zilux2 应自研。
- 第三方边界：`qishui-auth-v6/` 是 QQ 音乐登录协议实现的"字节级保留"移植（`docs/THIRD_PARTY_PORTS.md:56-78`），这部分**再上游**也有自己的许可/服务条款风险，不建议接触。
- 合规做法（建议写进 Zilux2 的 NOTICE）：只参考"问题—方案"，在 Zilux2 里用 C#/WebView2 原生能力重写；保留本报告作为设计出处记录，不复制源码片段。

### 9.3 可借鉴清单（P0/P1/P2）

| 优先级 | 借鉴点 | 复杂度 | 借鉴方式 | 依赖 Electron？ |
|---|---|---|---|---|
| **P0** | 像素预算 + DPR 反解 + 画质档位（eco/balanced/high/ultra） | 低 | WebView2 前端 JS 复刻规则；`devicePixelRatio` 可用；预算常量自定 | 否 |
| **P0** | 子系统 frameGate 限帧（音频/歌单架/歌词/overlay 分开限速） | 低 | C# 侧定时器或 JS 侧封装，pendingDt 累积/单步上限 | 否 |
| **P0** | 深后台"近停算"策略（rAF→定时器、极小画布、缓存裁剪） | 中 | C# 判定窗口可见性后下发降档命令；JS 执行 | 否（决策移到 C#） |
| **P0** | 帧成本 EMA + pressure 滞回（仅观测/告警，不直接改画质） | 低 | 采集 `performance.now` + 渲染计数，输出指标 | 否 |
| **P0** | WorkerW 发现/校验/恢复/退出（passive + interactive 双模） | 中 | C# 原生实现（Zilux v1 已有基础，补 ack 校验/恢复托盘/幂等） | 否（正是 C# 强项） |
| **P0** | 桌面歌词 overlay：锁定穿透 + hot bounds + 中键切换 | 低 | WPF/Win32 直接 `WM_NCHITTEST`/`SetWindowLong`，无需 24ms 轮询 | 否 |
| **P1** | 3D 歌单架窗口化渲染 + 对象池 + 懒加载 48 | 中 | Three.js 可移植；内存策略照抄"思想" | 前端可移植 |
| **P1** | 歌词纹理预算（每帧 1 层、CanvasTexture 复用、mipmap/anisotropy 策略） | 中 | WebView2 前端；预算参数自定 | 否 |
| **P1** | 性能探针（结构化 `__perf` 快照 + 验收指标） | 低 | C# + JS 双向采集；输出 JSON 落盘 | 否 |
| **P1** | 更新交付（latest.yml + 镜像排序 + 外链下载页，不做静默更新） | 低 | 思路可借鉴；Zilux2 可用自建 manifest | 否 |
| **P1** | 视频壁纸合成（DWM thumbnail helper / 或 LibVLC+WIC 原生渲染） | 高 | Zilux v1 已有 LibVLC/WIC，**不需要** Mineradio 的 DWM 方案 | 否 |
| **P2** | Wallpaper Engine 本地库索引（只读 project.json） | 中 | 若 Zilux2 想兼容 WE 项目可参考格式思路 | 否 |
| **P2** | Cuefield AutoMix（cache-only 过渡规划） | 高 | 算法思想可参考；实现独立 | 部分（bridge 协议） |
| **P2** | 安装器风格（自定义 NSIS MUI） | 低 | 只学"视觉规范"，实现换 WiX/Inno | 否 |
| **P2** | 登录彩蛋门/多音源会话隔离 | 中 | 安全设计可参考；qishui 协议不要碰 | 部分 |

**明确不建议借鉴**：`server.js` 的 `0.0.0.0` 无鉴权本机服务、`asar:false` + 未签名分发、同步 XHR 模块加载、GPL 代码/Shader 资产直接复用、PowerShell 轮询做高频输入（耗电/杀软误报）。

---

## 10. 关键文件索引（file:line）

| 文件 | 行 | 内容 |
|---|---|---|
| `package.json` | 2-9 | name/version/license/main/private |
| `package.json` | 13-95 | electron-builder：appId/afterPack/files/asar:false/nsis/publish/update mirrors |
| `desktop/main.js` | 501 | 单实例锁 |
| `desktop/main.js` | 5599-5621 | 主窗口 BrowserWindow 参数（frameless/transparent/contextIsolation/sandbox:false） |
| `desktop/main.js` | 5236-5267 | 同进程启动 server.js + 超时等待 |
| `desktop/main.js` | 5524-5583 | loadMainWindowWithRetry（导航超时/重试/ready race） |
| `desktop/main.js` | 5927-6058 | app ready/before-quit 清理链 |
| `desktop/main.js` | 173-185 | FullDesktopModeRuntime 实例化 |
| `desktop/main.js` | 1346-1372 | 全桌面 Escape 全局热键 |
| `desktop/main.js` | 1433-1530 | 全桌面 enable/interactive/disable/reconcile |
| `desktop/main.js` | 1782-1815 | 全局热键注册（含冲突信息） |
| `desktop/main.js` | 2109-2165 | 托盘 + 全桌面恢复托盘 |
| `desktop/main.js` | 3638-3685 | 桌面歌词中键 PowerShell 轮询 |
| `desktop/main.js` | 3724-3786 | 桌面歌词窗口创建/定位/加载 |
| `desktop/main.js` | 1942-2066 | 内存 trim 调度 |
| `desktop/main.js` | 1919-1925 | GPU 诊断 |
| `desktop/main.js` | 915-1308 | WE 采集/预览/宿主 suspend-resume |
| `server.js` | 121-122 | PORT/HOST 默认值（0.0.0.0） |
| `server.js` | 4635 / 6708 | http.createServer / listen |
| `server.js` | 4742 | /api/update/latest |
| `server.js` | 6697-6705 | 静态文件服务 |
| `server.js` | 6639-6661 | 音频代理（Range） |
| `desktop/wallpaper-mode-runtime.js` | 95-187 | WorkerW 附着脚本（C# EnumWindows/FindWindowEx/SetParent） |
| `desktop/wallpaper-mode-runtime.js` | 206-275 | attachWallpaperWindowToDesktop（execFile） |
| `desktop/full-desktop-mode-runtime.js` | 128-278 | interactive DefView 附着脚本 + ack 解析 |
| `desktop/full-desktop-mode-runtime.js` | 288-420 | attach/detach 顶层封装 |
| `desktop/full-desktop-mode-runtime.js` | 583-655 | getStatus/串行队列 |
| `desktop/full-desktop-mode-runtime.js` | 1908 | child-to-child SetParent 被回退的注释 |
| `desktop/desktop-native-icon-layer-runtime.js` | 63-68,149,258-319 | WS_EX_LAYERED/color key 图标层 |
| `desktop/desktop-icon-shape-runtime.js` | 5-7 | 图标探测超时/最大 rect 数 |
| `desktop/wallpaper-engine-runtime.js` | 9-23 | WE 尺寸/FPS/超时常量 |
| `desktop/wallpaper-engine-runtime.js` | 990-1116 | DWM thumbnail 宿主脚本 |
| `desktop/preload.js` | 1-146 | contextBridge desktopWindow API |
| `desktop/overlay-preload.js` | 1-19 | 桌面歌词 overlay API |
| `public/index.html` | 1929 | index-loader 引入 |
| `public/index.html` | 66,76,80 | WE layer / canvas container / splash |
| `public/js/index-loader.js` | 5-127 | 同步 XHR 拼模块 |
| `public/js/modules/01-scene/00-renderer-quality.js` | 5-19 | DPR/像素预算/固定 FPS 常量 |
| `public/js/modules/01-scene/00-renderer-quality.js` | 62-81 | 帧成本 EMA/pressure/level |
| `public/js/modules/01-scene/00-renderer-quality.js` | 126-143 | 画质档位 + getRenderPixelRatio |
| `public/js/modules/00-state/10-frame-scheduler.js` | 1-74 | frameGate 全实现 |
| `public/js/modules/11-main-loop.js` | 165-173 | 主循环 7 个 frameGate |
| `public/js/modules/11-main-loop.js` | 182-203 | 深后台 setTimeout / rAF 提交 |
| `public/js/modules/11-main-loop.js` | 244-294 | 各子系统目标 FPS |
| `public/js/modules/11-main-loop.js` | 296-704 | animate 主循环 + 帧成本采样 |
| `public/js/modules/00-state/08-desktop-render-power.js` | 41-67 | 硬件画像 |
| `public/js/modules/00-state/08-desktop-render-power.js` | 79-109 | 预算级别/缩放 |
| `public/js/modules/00-state/08-desktop-render-power.js` | 265-405 | 性能快照/缓存裁剪/内存 trim |
| `public/js/modules/00-state/08-desktop-render-power.js` | 406-423 | 深后台 renderer 4×4 |
| `public/js/modules/00-state/09-performance-probe.js` | 1-223 | 性能探针 |
| `public/js/modules/02-visual/00-pointer-cover-particles.js` | 221-222,1010-1160 | 封面粒子网格/shader/星河 |
| `public/js/modules/02-visual/03-lyrics-star-river.js` | 22,50-75 | 歌词星河 420 粒子 + vertex shader |
| `public/js/modules/02-visual/01-float-skull-backcover.js` | 2,691 | FLOAT_COUNT 1300 / BACK_COVER 3000 |
| `public/js/modules/02-visual/12-lyrics-row-layers.js` | 628,710 | 歌词行层预算构建 |
| `public/js/modules/05-playback/08-audio-graph-controls.js` | 113-206 | AudioContext/Analyser 链路 |
| `public/js/modules/03-beat/01-audio-beat-analysis.js` | 18-34 | OfflineAudioContext 分频段 |
| `public/js/modules/04-shelf/01-manager-core.js` | 6-7,285-309,346-378 | 歌单架窗口化/dispose/复用 |
| `public/js/modules/04-shelf/03-content-list-manager.js` | 10,248 | 预取/懒加载批 |
| `public/js/modules/00-state/01-perf-render-state.js` | 27 | PLAYLIST_LAZY_BATCH_SIZE=48 |
| `public/js/modules/08-account/00-update-preview.js` | 2-3,82 | 更新仅外链 |
| `docs/LOW_SPEC_OPTIMIZATION_DOCTRINE.md` | 83-92,94-105,148-154 | VSync 默认/验收指标/后台策略 |
| `docs/3D_PLAYLIST_SHELF_MEMORY.md` | 40-62 | 歌单架边界/音效 |
| `docs/THIRD_PARTY_PORTS.md` | 24-54 | WorkerW 移植边界声明 |
| `docs/UPDATE_DELIVERY.md` | 3-16 | 更新交付约束 |
| `LICENSE` | 1-561 | GPLv3 全文 |

---

## 11. 未解问题 / 待确认

- **Q1**：`RENDER_VISIBLE_VSYNC=true` 是刻意"冻结"自适应 cadence，还是临时开关？如果是前者，`selectAdaptiveRenderCadence`（`00-renderer-quality.js:97-125`）应删除；如果是后者，需要接线到 `resolveAdaptiveRenderCadence`（`11-main-loop.js:77-83`）才生效。
- **Q2**：`sampleAdaptiveFrameCost` 产生的 `level` 除了影响 `getRenderLoadTier`，是否还有消费方？目前未见"level→降画质"的路径，说明"压力反馈"只是观测。
- **Q3**：GSMTC 是否在其它分支/后续版本实现过？在本快照 0 命中；README/docs 也未提。若 Lead 需要，只能参考 Zilux v1。
- **Q4**：`desktop/wallpaper-preload.js`、`public/wallpaper.html` 在 `package.json` files 排除项中被引用但仓库不存在；是重构后残留，还是 v2.2.0 删除了壁纸窗口功能？`待确认`。
- **Q5**：3D 歌单架文档称实现于 `public/index.html`，实际在 `04-shelf/*`；index.html 中 `#shelf-*` 控件 id 是否还承担作用需核对（文档漂移）。
- **Q6**：`server.js` 绑定 `0.0.0.0` 是否为刻意（局域网投屏/手机控制）还是疏忽？代码中没有局域网访问的提示/鉴权；Zilux2 必须改 127.0.0.1 或加鉴权。`待确认`。
- **Q7**：桌面歌词中键轮询用 `Start-Sleep -Milliseconds 24`（约 41 次/秒的 PowerShell 进程常驻），CPU/耗电实测值未测；在 C# 侧用 `GetAsyncKeyState` 定时器可零进程开销替代。
- **Q8**：多显示器下 WorkerW 选择逻辑是否支持"目标显示器"？（代码只取第一个匹配）；WE 宿主 bounds 跟随是否覆盖混合 DPI？需实机验证。
- **Q9**：`server.js` 的 `/api/spotify*` 在部分分支返回 404 `PROVIDER_REMOVED`，但 `desktop/main.js` 仍保留 Spotify OAuth 登录窗口与 `spotify-api.js`；功能是"部分下架"还是"按配置启用"？`待确认`。
- **Q10**：`docs/LOW_SPEC` 的"万首队列/真窗口虚拟化/左栏单滚动轴"是否有完整实现？代码里看到 48 条批与窗口化卡片，列表虚拟化的完整度未逐行核对。
- **Q11**：`mpg123-decoder` 未被引用（死依赖）；是否有 WebAudio 解码失败时的回退路径使用它？`待确认`。
- **Q12**：`electron ^42.4.1` 与 `electron-builder ^26` 属于较新版本，`asar:false` + 自定义 `afterPack` 的兼容性未实测（本报告未运行构建）。
- **Q13**：`server.js` 的 105 个 API 中多数无参数白名单/大小限制，是否存在超长字符串/文件路径注入面（如 lyrics 缓存 key、本地库导入）？未做安全审计，`待确认`。

---

## 12. 对齐 Zilux v1 / Zilux2 的落地建议

> 背景（Lead 提供）：Zilux v1 = C#/.NET 10/WPF，已实现任务栏逐字歌词、扇形浮层、桌面歌词壁纸（WebView2 挂 WorkerW）、动态视频/GIF 壁纸（LibVLC/WIC）、GSMTC 媒体会话（含网易云进度补偿）、QQ/网易云/酷狗歌词源、播放页频谱（WASAPI loopback）、托盘/热键/自启/主题、单文件安装器。Zilux2 是下一步新开发。**Mineradio 只能提供"思路"，不能提供代码（GPL-3.0）**。

### 12.1 GSMTC：v1 已有，Zilux2 的升级点（Mineradio 无参考代码）

Mineradio 的缺失反而凸显 v1 的路是对的。可升级：
1. **事件 + 轮询双通道**：`SystemMediaTransportControls` 的 `ButtonPressed`/`PropertyChanged` 事件为主，另设低频（1~2s）轮询兜底，防止第三方播放器（网易云）事件不完整/不触发；只在"会话存在且变化"时更新，避免空轮询耗电。
2. **进度补偿**：以 SMTC `Position` + `LastUpdatedTime` + `PlaybackRate` 外推当前进度；收到 `PlaybackStatus=Playing` 后按本地时钟插值，`Paused/Stopped` 冻结；对网易云这类"进度跳变"做单调性校正（只允许向前小步修正）。
3. **元数据映射**：`Title/Artist/AlbumTitle/Thumbnail` 空值兜底（从本地歌词源/播放器窗口标题补）， artwork 做哈希去重与异步加载（避免每帧刷图）。
4. **多会话优先级**：同时存在浏览器/网易云/QQ 音乐等多个 SMTC 会话时，按"用户最近交互"→"播放中"→"本应用"排序，避免抢会话；本应用不劫持其它进程的媒体键。
5. **媒体键冲突**：SMTC 按键与本地 `RegisterHotKey` 可能双触发；本应用只处理"发往自己会话"的按键，全局热键仍走用户绑定。
6. **会话清理**：应用退出/切换时 `IsEnabled=false` + 清空元数据，避免 Windows 媒体浮层残留"幽灵会话"。
7. **Win11 媒体浮层**：缩略图尺寸有限，缩略图裁切/圆角交给系统；不要塞长文本。

### 12.2 WorkerW：v1 已有，Zilux2 的升级点

1. **发现策略与校验**：`EnumWindows → SHELLDLL_DefView → 其后 WorkerW`；find 失败回退 `Progman`；挂载后回读 `GetParent/GetWindowLong/GetWindowRect` 校验（Mineradio 的 ack 模式值得复用）。
2. **恢复阶梯**：失败→隐藏窗口+禁用交互+恢复托盘+熔断；Explorer 重启监听并重挂；显示布局变化重挂；退出前恢复窗口快照（位置/样式/交互/focusable）。
3. **多显示器**：按目标 `HMONITOR` 找对应桌面窗口，物理像素/DIP 换算（Per-Monitor V2），混合 DPI 场景单独处理。
4. **点击穿透**：锁定态整窗穿透（`WS_EX_TRANSPARENT`/`WM_NCHITTEST` 返回 `HTTRANSPARENT`），仅 hot bounds 内转发；解锁态可拖动/关闭；中键/热键切换由 C# 原生定时器（`GetAsyncKeyState`）实现，不用每 24ms 起 PowerShell。
5. **叠放顺序**：视频壁纸（LibVLC/WIC 原生渲染窗口）→ WebView2 歌词层 → 可选图标层；确保任务栏在最上；退出时按逆序恢复。
6. **与视频壁纸的同步**：主进程统一时钟（播放位置基于 WASAPI/GSMTC 时间轴），通过 `postMessage`/`WebMessageReceived` 每 100~200ms 推给歌词层，歌词层本地插值渲染；不要两个进程各自读时间。
7. **恢复 Shell**：`WS_CHILD→WS_POPUP` + `SetParent(NULL)` + 重新 `SetWindowPos`，并在 `WM_DESTROY`/进程退出时兜底（Mineradio 在 `before-quit` 里串行清理 + 超时兜底，值得抄思路）。

### 12.3 帧预算：提炼成 C# + WebView2 可执行规则

**谁限帧（职责划分）**：

| 层 | 负责方 | 规则 |
|---|---|---|
| 整帧 | WebView2 前端 rAF | 前台恒 VSync；不要人为降整帧步进（Mineradio 的教训：降整帧会破坏动画平滑） |
| 子系统 | 前端 frameGate + C# 状态 | 音频分析/歌单架/歌词粒子/overlay 各自目标 FPS；C# 提供"窗口可见性/最小化/桌面模式"状态，前端不猜 |
| 深后台 | C# 决策 | 最小化/隐藏/锁屏 → 通知前端 `deep`；前端停 rAF 改定时器、画布缩到 4×4、清缓存；恢复时重建 |
| 像素 | 前端 | 预算 `sqrt(budget/cssPixels)` 反解 DPR，clamp 到 [min, cap]；画质档位 eco/balanced/high/ultra |
| 音频分析 | 前端（WebView2 的 Web Audio 拿不到系统输出） | 需要 WASAPI loopback 时由 **C# 采集后推 PCM/频谱**给前端；前端只渲染 |

**预算怎么分**（建议起始值，参考 Mineradio 量级）：
- 前台 3D 场景：像素预算 4.5~5.5M；DPR cap 1.25~1.35 / min 0.7；ultra 7.5M。
- 子系统目标 FPS：频谱分析 45~60（重采样可降）、3D 歌单架 30、歌词粒子 45、舞台歌词 45、overlay 同步 12~30、首页频谱 15。
- 后台：轮询 1s；画布 4×4；缓存裁剪间隔 5~30s。

**如何降档（阶梯，从轻到重）**：
1. 降低子系统目标 FPS（frameGate 步长）→ 最轻，观感几乎无感；
2. 降低像素比（DPR 向下取整 0.05~0.1 步进）→ 画面略糊；
3. 关闭非关键后处理（bloom/glow/景深）→ 视觉明显但可控；
4. 降低粒子/歌单架数量（帧率优先）；
5. 深后台/暂停渲染（不可见时）；
6. 用户显式选择 eco/balanced 档。
原则：**降档要单向渐进 + 滞回**（Mineradio 的 pressure 滞回模型），并且**不要静默改变用户选的 VSync/固定 FPS 语义**（LOW_SPEC 的教训）。

**如何测**：
- 前端：`performance.now()` 包住 animate、统计 skipped/longFrames、采样 rAF 间隔估刷新率；暴露 `window.__ziluxPerf`。
- 主进程：`Process.TotalProcessorTime`/GPU 计数器（`PerformanceCounter` 或 ETW）、WebView2 `ProcessFailed`/`WebResourceResponseReceived` 事件；窗口可见性/最小化由 C# 权威广播。
- 验收指标（照搬 LOW_SPEC 思路）：前台空闲 CPU、播放 CPU、3D 歌单架 CPU、全屏 CPU、后台 CPU，均对比基线（例如 <5% / <15% / <20% / <25% / <2%）。
- 记录"降档发生次数/原因"，避免出现 Mineradio 那种"反馈有、但没接线"的死路径。

### 12.4 粒子/星河与 3D 歌单架：哪些能搬、哪些不能

- **可直接移植到 WebView2 前端（重写）**：Three.js 粒子/Shader 结构、CanvasTexture 行层预算、AnalyserNode 频谱、frameGate 限帧、3D 歌单架窗口化/dispose/懒加载 48 条。
- **依赖 Electron 主进程、不能照搬**：深后台 renderer 4×4（WebView2 侧需 C# 控制 `Controller.IsVisible`/暂停 JS 定时器或注入降档脚本）、`performance.memory`、`trimAppMemory` 进程树 trim、托盘/tray 状态权威。
- **不建议搬**：同步 XHR 模块加载、全局 var 作用域、PowerShell 高频轮询、DWM thumbnail（v1 的 LibVLC/WIC 原生方案更好）、`0.0.0.0` 本地服务。

### 12.5 一句话总结给 Lead

Mineradio 最有价值的不是它的业务功能，而是**"在低配 Windows 上把 3D 音乐播放器跑到可用的性能方法论"**（像素预算/帧闸门/深后台/三态降档）和**"用 PowerShell 内联 C# 把 Electron 窗口塞进桌面层的工程化兜底"**（发现/校验/恢复/熔断/退出恢复 Shell）——这两块可以完全用 C#/WPF 重新实现，且 Zilux v1 已经具备更好的原生基础（GSMTC、WASAPI、LibVLC），Zilux2 应当"以 v1 为底座，吸收 Mineradio 的性能与 WorkerW 工程经验，而不是移植 Electron 架构"。

---

## 附：抽查校验记录（file:line 真实行号）

本报告写作时对以下位置做了行号抽查（命令：`sed -n` / `grep -n` 于仓库根目录）：

1. `public/js/modules/01-scene/00-renderer-quality.js:5-19` → DPR/像素预算/固定 FPS 常量与 `RENDER_VISIBLE_VSYNC=true`（实测一致）。
2. `public/js/modules/01-scene/00-renderer-quality.js:62-81` → `sampleAdaptiveFrameCost` 的 0.78/EMA 0.92/0.08/+0.70/-0.30/-0.10/level 阈值（实测一致）。
3. `public/js/modules/11-main-loop.js:165-173` → 7 个 `mainFrameGates` 及默认值（实测一致）。
4. `public/js/modules/00-state/10-frame-scheduler.js` → 1/15/38/50/58 行分别对应 create/consume/run/reset/collect（实测一致）。
5. `desktop/main.js:5599-5621` → 主窗口 BrowserWindow 参数（实测一致）。
6. `desktop/main.js:5236-5267` → 同进程启动 server.js（实测一致）。
7. `server.js:121-122` → `PORT/HOST` 默认值（实测 `HOST='0.0.0.0'`）。
8. `public/js/index-loader.js:113-127` → 同步 XHR 与内联 `<script>` 拼接（实测一致）。
9. `desktop/wallpaper-mode-runtime.js:95-187` → WorkerW 附着脚本（实测 grep 命中 SetParent/FindWindowEx/EnumWindows）。
10. `docs/LOW_SPEC_OPTIMIZATION_DOCTRINE.md` 共 194 行、`docs/3D_PLAYLIST_SHELF_MEMORY.md` 共 91 行（实测 `wc -l`）。

> 校验边界：未运行应用，未在 Windows 上实机验证 WorkerW/多显示器/媒体键行为；文中「待确认」项均未做动态验证。行号以本快照为准，若后续拉取新版本可能偏移。
