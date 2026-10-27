# Rhine Music Windows 深度拆解

- **调研对象**：Bong712/Rhine-Music-Windows，`v0.6.0-dev.57`
- **仓库 commit**：本地为 tarball 快照，**无 `.git` 元数据**，无法给出 commit；以 `version.json:6` 的 `"version": "0.6.0-dev.57"` 与 `DesktopProgram.cs:21-23` 的 `AssemblyVersion("0.6.0.57")` 为准
- **调研时间**：2026-10-18
- **调研方式**：纯静态阅读（未执行构建、未运行程序、未联网）；行号均以 grep/read 核对过
- **证据约定**：`文件:行号` 均相对仓库根 `E:\Zilux2开发\research\repos\rhine\`；凡属推测/未能验证的结论一律标「待确认」

**一句话结论**：Rhine 是一个非常克制、值得抄结构的「C# 薄启动器 + 本地 Node 服务 + 单页 Three.js 应用」三层组合：C# 只负责单文件解压、进程托管、窗口/DPI/全屏与 WebView2 壳；业务与数据全部在 `127.0.0.1` 本地 HTTP 服务与页面内；宿主与前端之间**没有** JS↔C# 桥，只有 HTTP。它对 Zilux2 的最大价值不在业务代码，而在「包装形态 + WebView2 参数 + 本地服务安全边界 + 3D 画质/诊断纪律」这四个可迁移的工程模式。

---

## 1. 项目速览

### 1.1 版本 / 许可 / 来源（关键：许可是分层的）

| 项 | 事实 | 证据 |
| --- | --- | --- |
| 版本 | `0.6.0-dev.57`；程序集 `0.6.0.57`；数据 schema `music-data-v3` | `version.json:1-7`、`DesktopProgram.cs:21-23`、`DesktopProgram.cs:45` |
| 代码许可 | MIT（可商用/可改/需保留版权） | `LICENSE`、`NOTICE.md:8` |
| 素材许可 | **非代码资产不随 MIT 授权**：`art/*.blend`、`public/assets/*.glb`、图标、截图、PV 采样、字体（MiSans 单独协议）均有独立权利声明；`typing-preview.wav` 等采样「不在 MIT 授权范围」 | `NOTICE.md:18-31` |
| 上游谱系 | 本仓库是 `RonaldDeng/Rhine-Music-Demo` 的 Windows 移植；3D 档案界面源自 `LBEILC/RhineLabUI`；两者署名保留 | `NOTICE.md:5-9`、`README.md:1` |
| 发行包内容 | **不包含**真实歌曲/商业封面/私人曲库索引；音乐始终从原路径读取 | `RELEASE_NOTES_0.6.0-dev.57.md:18`、`README.md:12` |

> 对 Zilux2 的含义：Rhine 的**代码**可借鉴乃至直接用（MIT），但**不能**把它的 `.glb` 模型、图标、MiSans 字体、PV 采样搬进 Zilux2；这些是明日方舟同人素材，许可证不覆盖。Zilux2 如需 3D 封面墙，应使用自产资源或开源素材。

### 1.2 技术栈（逐层）

| 层 | 技术 | 证据 |
| --- | --- | --- |
| 宿主 | C# / .NET Framework 4.6.2+ / x64 WinForms，**单文件 `DesktopProgram.cs`，仓库里没有 `.csproj`/`.sln`** | `BUILD-WINDOWS.md:3`、`README.md:46`、`scripts/build-windows.ps1:39-40` |
| 编译器 | 系统自带 `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`（.NET Framework 4.x 编译器） | `scripts/build-windows.ps1:39-40` |
| WebView2 | WebView2 SDK 托管 DLL + x64 `WebView2Loader.dll`（随包分发）；渲染用系统 **Evergreen Runtime**（不固定版本） | `sdk/lib/`、`DesktopProgram.cs:156-157`、`BUILD-WINDOWS.md:6` |
| 前端 | TypeScript 5.9 + Three.js 0.183 + Vite 7；`tsc && vite build` 产出 `dist/` | `package.json:20-25`、`package.json:38-44` |
| 本地服务 | Node.js ≥ 22.12，**零 Web 框架**，`node:http` 手写路由；`music-metadata` 解析标签、`opencc-js` 做繁简转换 | `package.json:31-36`、`scripts/music-server.mjs:1-9` |
| 打包 | 前端 `dist` + `scripts` + `node.exe` + WebView2 DLL 打成 `payload.zip`，用 `csc /resource:` 嵌入单文件 EXE | `scripts/build-windows.ps1:139-157`、`DesktopProgram.cs:163` |
| 状态存储 | 前端 `localStorage`（键 `rhine-music-preferences`）；后端 `%LOCALAPPDATA%\Rhine Music\music-data-v3\*.json` | `src/music-app.ts:81-122`、`DesktopProgram.cs:45`、`scripts/music-library.mjs:259-282` |

### 1.3 运行形态（单文件 exe 的「第一次运行」到底做了什么）

1. 用户双击 `Rhine Music.exe`（单文件，内含 `RhineMusicPayload.zip` 资源）。
2. 进程启动 → 取产品根 `%LOCALAPPDATA%\Rhine Music`（可用环境变量 `RHINE_HOME` 覆盖）`DesktopProgram.cs:47-53`。
3. 程序版本目录 `app-v0.6.0-dev.57`（`DesktopProgram.cs:44`）；若 marker 与关键文件齐全则跳过解压，否则把内嵌 zip 解到该目录并写 `.payload-ready`（`DesktopProgram.cs:149-205`）。
4. 拉起同目录下的 `node.exe` 运行 `scripts/music-server.mjs --port <port>`（`DesktopProgram.cs:296-356`）。
5. 轮询 `http://127.0.0.1:<port>/api/health` 直到服务就绪（最多 30 s），再创建 WinForms 窗口，WebView2 导航到 `http://127.0.0.1:<port>/?desktop=1`（`DesktopProgram.cs:128-136, 390-409`）。
6. 退出窗口时杀死自己拉起的 node 子进程（`DesktopProgram.cs:411-419`）。

### 1.4 代码规模（`wc -l` 实测，非估算）

统计命令：`wc -l src/*.ts scripts/music-library.mjs scripts/playlists.mjs scripts/build-windows.ps1 index.html`，合计 **16,135 行**。重点文件：

| 文件 | 行数 | 角色 |
| --- | --- | --- |
| `src/music-app.ts` | 2,276 | 前端总控（UI/状态/歌词/偏好/键盘/主循环） |
| `src/scene.ts` | 2,110 | Three.js 档案架场景 + 后处理 + 实例化 + 图集集成 |
| `DesktopProgram.cs` | 1,079 | WinForms 宿主全部逻辑（单文件） |
| `src/archive-main.ts` | 992 | 档案（非音乐）界面 |
| `src/cover-atlas.ts` | 862 | 封面纹理图集 |
| `scripts/music-library.mjs` | 825 | 曲库索引/扫描/封面/在线资料 |
| `src/music-player.ts` | 712 | 双 Audio 播放器 + 淡入淡出 |
| `src/model-viewer.ts` | 687 | 模型查看器（专辑详情用） |
| `src/audio.ts` | 625 | WebAudio 合成音效（`TerminalAudio`） |
| `scripts/music-server.mjs` | 257 | 本地 HTTP 服务（路由/静态/Range） |
| `scripts/build-windows.ps1` | 244 | 单文件 exe 打包脚本 |
| `src/lyrics.ts` | 62 | LRC 解析 + 二分定位（小而关键） |
| `src/render-quality.ts` | 175 | 画质参数模型与像素上限 |
| `src/gpu-capability.ts` | 27 | 厂商中立的 WebGL2 能力探针 |
| `src/frame-profiler.ts` | 268 | 帧/GPU/长任务的诊断采样 |

### 1.5 目录地图（只列与本报告相关的）

```
rhine/
├─ DesktopProgram.cs          # 唯一 C# 源码（宿主 + 打包入口假设 + 诊断）
├─ app.manifest               # DPI/OS 兼容/执行级别
├─ BUILD-WINDOWS.md           # 构建与 4K 验收纪律（含交付品质要求）
├─ NOTICE.md / THIRD-PARTY-NOTICES.md / LICENSE
├─ version.json               # 版本与数据 schema 单一来源
├─ package.json / tsconfig.json / index.html / vite 配置（内联在 scripts 里）
├─ sdk/lib/                   # WebView2 SDK DLL：Core / WinForms / Loader + LICENSE
├─ scripts/
│  ├─ music-server.mjs        # 本地 HTTP 服务（后端入口）
│  ├─ music-library.mjs       # 曲库 store（扫描/索引/封面/在线资料）
│  ├─ playlists.mjs           # 歌单 store（JSON 原子写）
│  ├─ build-windows.ps1       # 单文件 exe 打包
│  ├─ version.mjs             # 版本号分配/同步/校验
│  └─ check-*.mjs             # 20+ 个静态/回归检查脚本
├─ src/                       # 前端 TypeScript（60+ 文件）
│  ├─ music-app.ts            # 音乐应用总控
│  ├─ scene.ts                # Three.js 场景
│  ├─ cover-atlas.ts          # 封面图集
│  ├─ lyrics.ts               # LRC 解析
│  ├─ music-player.ts         # 播放器
│  ├─ render-quality.ts / quality-renderer.ts / gpu-capability.ts / frame-profiler.ts
│  └─ *.css                   # 每模块配套样式
├─ content/                   # 档案内容 JSON（非音乐）
└─ public/                    # 静态资源（assets/glb、fonts、licenses、demo-covers）
```

### 1.6 README 声称 vs 代码实际（先立规矩）

| README/注释声称 | 代码实际 | 差异/备注 |
| --- | --- | --- |
| 「单文件 x64 WinForms EXE 内嵌 dist、Node.js、WebView2 SDK DLL 和服务包」`BUILD-WINDOWS.md:33` | 属实：`/resource:$payloadZip,RhineMusicPayload.zip`（`scripts/build-windows.ps1:153`）+ 解压清单校验（`DesktopProgram.cs:151-157`） | 无差异 |
| 「硬件加速由 WebView2/ANGLE、Windows 图形栈和显卡驱动选择」`BUILD-WINDOWS.md:35` | 宿主**没有**设置任何 GPU 相关 `AdditionalBrowserArguments`；仅 WebGL 侧 `powerPreference: "high-performance"`（`src/scene.ts:185`、`src/gpu-capability.ts:15`） | README 的口径是准确的（不敢保证选中独显），代码也确实是「不干预」 |
| 「F11 无边框全屏及 Per-Monitor V2 DPI」`README.md:16` | 属实：manifest + `SetProcessDpiAwarenessContext(-4)` 兜底；F11 在 `Form.KeyDown` 拦截 | 但页面里另有一套 HTML Fullscreen API 按钮（`src/music-app.ts:1853-1858`），两套全屏并存，见 §3.4 |
| 「帧率由具体设备决定，不以开发原型数据代替承诺」`README.md:18`，`BUILD-WINDOWS.md:40` 要求 PresentMon 验收 | `FrameProfiler` 只做诊断，明确写 `rAF intervals describe main-thread scheduling only; use DXGI/ETW for actual presented frames.`（`src/frame-profiler.ts:199`） | 工程纪律值得抄：**不拿 rAF 当帧率** |
| 设置页「画质预设」暗示自适应 | 实际是**手动选预设 + 固定像素上限**，无自动降画质/动态分辨率逻辑 | 见 §3.5 的「画质自适应真相」 |

---

## 2. 架构总览

### 2.1 进程与模块边界

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  进程 P1：RhineMusic.exe（WinForms 宿主，单文件，x64，.NET Framework 4.6.2+）  │
│  DesktopProgram.cs 全部逻辑：                                                 │
│   ┌───────────────┐   ┌──────────────────────┐   ┌──────────────────────────┐  │
│   │ 启动编排       │   │ DesktopWindow : Form │   │ 诊断（仅 RHINE_PROFILE=1）│  │
│   │ 端口探测/健康  │──▶│ WebView2 Dock=Fill    │──▶│ ExecuteScriptAsync 取数   │  │
│   │ 拉起/回收 node │   │ F11 全屏 / DPI        │   │ CapturePreviewAsync 截图  │  │
│   └───────┬───────┘   └──────────┬───────────┘   └──────────────────────────┘  │
└───────────┼──────────────────────┼────────────────────────────────────────────┘
            │ CreateProcessW       │ 导航 http://127.0.0.1:<port>/?desktop=1
            ▼                      ▼
┌───────────────────────────┐  ┌──────────────────────────────────────────────┐
│ 进程 P2：node.exe          │  │ 进程 P3：msedgewebview2.exe（WebView2 多进程）  │
│ scripts/music-server.mjs   │  │  Chromium 渲染进程 + GPU 进程（由 Runtime 管理） │
│ 只监听 127.0.0.1:<port>    │  │  页面 = dist/ 打包产物（单页 Three.js 应用）     │
│ 路由/静态/Range/曲库索引    │  │  fetch('/api/*') ──┐                            │
└───────────┬───────────────┘  │  <audio src='/api/audio/...'>                    │
            │ HTTP (loopback)  │  WebGL2（ANGLE/D3D11）                           │
            ▼                  └───────────────────────┬──────────────────────────┘
┌───────────────────────────┐                          │ fetch /api/*（同源）
│ 本地文件系统                │◀─────────────────────────┘
│ %LOCALAPPDATA%\Rhine Music\ │   ← Node 进程读写：music-data-v3 / webview-profile
│  ├ app-v<ver>\（payload）   │      （浏览器侧 localStorage 落在 webview-profile）
│  ├ music-data-v3\（索引）    │
│  └ webview-profile\（UDF）  │
│ 用户音乐目录（只读）          │
└───────────────────────────┘
```

**要点（都是可迁移的架构决策）**：

1. **宿主不做业务**：C# 只做「解压 + 拉起服务 + 开窗口 + 端口/健康 + 全屏 + DPI」，没有曲库、播放、歌词的任何代码。播放与歌词都在页面内（`<audio>` + `src/lyrics.ts`）。
2. **前端与宿主零耦合**：页面用相对 URL `fetch("/api/...")`（`src/music-app.ts:507-524`），只要求「被某个同源 HTTP 服务托管」。因此同一份前端可以跑在 Vite dev server（`npm run dev`）、Node 独立服务（`npm run music`）或桌面壳里——这是它调试体验好的根本原因。
3. **宿主 ↔ 页面没有 JS 桥**：全仓库没有 `WebMessageReceived` / `AddHostObjectToScript` / `PostWebMessageAsJson`（grep 无命中）。C# → JS 仅在诊断模式用 `ExecuteScriptAsync`（`DesktopProgram.cs:819`）。这是一把双刃剑，见 §3.2 结尾。
4. **单实例是「互斥量 + 端口健康探测」两段式**：`Local\RhineMusicDesktop-v0.6.0` 互斥量只覆盖「启动窗口期」（`DesktopProgram.cs:83-98`）；真正的实例复用靠探测端口上的 `/api/health` 是否属于自己（`DesktopProgram.cs:214-262`）。第二个实例发现服务已存在时只开窗，**不会**杀 node（`startedProcessId == 0`，`DesktopProgram.cs:413-418`）。

### 2.2 启动时序（精确到行）

```text
Main() [STAThread]                                    DesktopProgram.cs:55-70
 ├─ AppDomain.AssemblyResolve += ResolveWebViewAssembly         L58,72-78
 ├─ ConfigureDpiAwareness()                                     L59,422-433
 └─ Run()                                                       L80-147
     ├─ Directory.CreateDirectory(ProductRoot)                  L82
     ├─ Mutex("Local\\RhineMusicDesktop-v0.6.0").WaitOne(0)      L83-98
     │   └─ 失败 → 抛「播放器正在启动，请等几秒后再试。」          L95-98
     ├─ EnsurePayloadExtracted()                                L102,149-205
     ├─ Directory.CreateDirectory(DataRoot)                     L103
     ├─ SetDllDirectoryW(AppRoot)   ← 让 WebView2Loader.dll 可被原生加载 L104
     ├─ ports = [5175..5184, 5173]                              L106
     ├─ Probe(port) for each → Free / Busy / Own                 L107-111,214-262
     ├─ 若任意 Own → OpenDesktop(port) 然后 return（复用已有服务）L113-118
     ├─ 若没有 Free → 抛「没有可用的本机端口（5175–5184、5173）…」L120-124
     ├─ StartMusicService(port)                                 L127,296-356
     ├─ for attempt in 0..120: sleep 250ms; 若 Probe==Own → OpenDesktop L128-136
     └─ 30s 超时 → 抛错并附 player-service.log 末尾                 L138-140,435-447
```

窗口侧：

```text
OpenDesktop(port)                                              DesktopProgram.cs:390-420
 ├─ Application.EnableVisualStyles / SetCompatibleTextRenderingDefault
 ├─ 地址 = "http://127.0.0.1:" + port + "/?desktop=1"           L398
 ├─ 若 RHINE_PROFILE=1 或 RHINE_PROFILE_CAPTURE=1 → 追加 &profile=1&scene=archive
 │                                                    （可选 &stress=3..500）L396-407
 ├─ Application.Run(new DesktopWindow(address, DataRoot\webview-profile))  L409
 └─ finally: 若 startedProcessId>0 → Process.Kill()             L411-419
```

`DesktopWindow` 构造（窗口出现前完成）：

```text
DesktopWindow(address, profile)                                DesktopProgram.cs:544-667
 ├─ 标题/居中；默认 Maximized + 1440×900 + 最小 960×640         L550-565
 ├─ KeyPreview=true；KeyDown: F11 → ToggleFullscreen()（Handled） L566-572
 ├─ WebView2 { Dock=Fill, DefaultBackgroundColor=#EAE5E1 }       L574-575
 └─ Shown 事件（异步）：
     ├─ 若 RHINE_FULLSCREEN=1 → ToggleFullscreen()              L578
     ├─ CoreWebView2Environment.CreateAsync(null, profile, options) L582-587
     ├─ AreDefaultContextMenusEnabled=false / AreDevToolsEnabled=false L588-589
     ├─ （诊断模式才挂事件与截图流水线）                          L590-644
     ├─ NewWindowRequested → 统一处理（见 §3.2）                 L645-657
     └─ browser.Source = new Uri(address)                       L658
```

### 2.3 端口 / 健康检查 / 进程生命周期

**端口选择**（`DesktopProgram.cs:106`）：`5175, 5176, …, 5184, 5173`，共 11 个。注释没有解释顺序，但语义很清楚：`5173` 是 Vite 默认端口，放在最后是**为了不和前端侧正在跑的 dev server 抢端口**；主段从 5175 开始避开常见冲突。

**Probe 三态**（`DesktopProgram.cs:214-262`）：

```csharp
private static ProbeState Probe(int port)
{
    if (IsPortFree(port)) return ProbeState.Free;          // TcpListener 真绑定测试 L264-280
    try {
        var request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:"+port+"/api/health");
        request.Proxy = null; request.Timeout = 800; request.ReadWriteTimeout = 800;   // L223-226
        ...
        var health = new JavaScriptSerializer().DeserializeObject(body) as Dictionary<string,object>;
        if (health == null || !health.ContainsKey("service") || !health.ContainsKey("projectDir")
            || !health.ContainsKey("pid")) return ProbeState.Busy;                     // L240-245
        var service = Convert.ToString(health["service"]);
        var project = Convert.ToString(health["projectDir"]);
        var pid = Convert.ToInt64(health["pid"]);
        return service == "rhine-local-music" && PathsEqual(project, AppRoot) && pid > 0
            ? ProbeState.Own : ProbeState.Busy;                                        // L247-251
    } catch (WebException) { return ProbeState.Busy; } catch { return ProbeState.Busy; }
}
```

**服务端契约**（`scripts/music-server.mjs:129`）：`/api/health` 返回 `{ service: 'rhine-local-music', projectDir: PROJECT_DIR, pid: process.pid }`。`PROJECT_DIR` 是 `scripts/../`（`scripts/music-server.mjs:8`），即解压后的 `app-v<ver>` 根目录 —— 与 `AppRoot` 相等，所以「同一个 app 目录」被当作「自己的服务」。这意味着：**升级到新版本目录后，旧版本目录的 node 服务不会被误认**（projectDir 不同 → Busy），但旧端口的旧服务也不会被主动回收；升级后的首次启动会因「端口都不是 Free 且都不是 Own」而报「没有可用端口」，除非用户结束旧进程。这是一个值得在 Zilux2 修正的真实边界（见 §7）。

**node 启动**（`DesktopProgram.cs:296-356`）细节：

- 可执行文件固定 `AppRoot\node.exe`（`L298`），脚本 `AppRoot\scripts\music-server.mjs`（`L299`），工作目录 `AppRoot`（`L340`）。
- **不用 `Process.Start`，而是 P/Invoke `CreateProcessW`**（`L339-341`），原因：要精确控制 STARTUPINFO 的标准句柄（stdout/stderr 同时重定向到日志文件、stdin 指向 `NUL`、`SW_HIDE`、`CREATE_NO_WINDOW`），见 `L325-333` 与常量 `L31-35`。
- 日志文件：`DataRoot\player-service.log`，`CreateFileW(..., FILE_APPEND_DATA, FILE_SHARE_READ|FILE_SHARE_WRITE, ..., OPEN_ALWAYS, ...)`（`L307-312`）；stdout 与 stderr **共用同一个可继承句柄**，所以 Node 的 `console.log` 与未捕获异常都会进同一份日志（`L331-332`）。
- 环境变量传参：`MUSIC_DATA_DIR=DataRoot`，在 `CreateProcessW` 前后设置/还原（`L322,337,352`）—— 注意 `SetEnvironmentVariable` 是**进程级**的，这里靠 try/finally 还原，天然不可重入；若将来并发启动会踩。
- 命令行转义：`QuoteArgument` 是标准 MSVC 规则实现（`L358-388`），处理空格/引号/反斜杠，避免中文用户名路径被拆参（`%LOCALAPPDATA%` 常含中文）。
- 只关句柄不等待退出：`CloseHandle(processInformation.Process)`（`L348`），靠 `finally` 里 `Process.GetProcessById(pid).Kill()` 收尾（`L413-418`）。

**崩溃/退出恢复的真相**：

- 宿主正常关窗 → `Application.Run` 返回 → finally Kill node（`L411-419`）。
- 宿主被强杀/崩溃 → node **成为孤儿继续监听**。下次启动：Probe 命中 Own → 直接复用（`L113-118`），所以「看起来能恢复」，但代价是**旧代码/旧版本服务可能继续活着**（见上）。
- node 自己崩溃 → 180 次探测全失败 → 抛错，弹 MessageBox 显示「播放器服务未能在 30 秒内就绪」+ 日志尾部（`L138-140`、`L435-447`、`L453-457`）。
- **没有**：Job Object 绑定、`node` 退出监控、自动重启、崩溃上报、单实例管道。对 Zilux2 应补齐（见 §4 P0）。

---

## 3. 分主题深挖

### 3.1 （a）轻宿主：DesktopProgram.cs 单文件拆解

#### 3.1.1 为什么是「单文件 + csc.exe」而不是工程

仓库没有 `.csproj`/`.sln`，`DesktopProgram.cs` 顶部直接写 `[assembly: ...]` 特性（`DesktopProgram.cs:18-24`），构建脚本用 `csc.exe` 一次性编译（`scripts/build-windows.ps1:39-40,149-157`）。引用列表为：

```text
System.dll, System.Core.dll, System.Drawing.dll, System.Windows.Forms.dll,
System.Web.Extensions.dll（JavaScriptSerializer）, System.IO.Compression.dll,
System.IO.Compression.FileSystem.dll
```
（`scripts/build-windows.ps1:149`）

这个做法的收益是**零 SDK/零 NuGet、CI 机只需 .NET Framework 自带的 csc**；代价是：没有增量编译、没有 `dotnet` 工具链的现代化能力（single-file publish、trim、ReadyToRun）、且 `csc` 目标固定 `.NET Framework 4.x`。Zilux2 既然已确定 .NET 10，应改用 `dotnet publish -p:PublishSingleFile=true`（见 §4），但**「把宿主代码压成一个文件、只依赖框架自带 API」的取舍**仍然值得学：宿主越小，越不容易成为升级/兼容性负担。

#### 3.1.2 资源解压：版本目录 + marker + zip-slip 防护

```csharp
private static void EnsurePayloadExtracted()                          // DesktopProgram.cs:149-205
{
    var markerPath = Path.Combine(AppRoot, ".payload-ready");
    if (File.Exists(markerPath)
        && File.Exists(Path.Combine(AppRoot, "node.exe"))
        && File.Exists(Path.Combine(AppRoot, "scripts", "music-server.mjs"))
        && File.Exists(Path.Combine(AppRoot, "dist", "index.html"))
        && File.Exists(Path.Combine(AppRoot, "Microsoft.Web.WebView2.WinForms.dll"))
        && File.Exists(Path.Combine(AppRoot, "WebView2Loader.dll")))
        return;                                                        // L151-160
    Directory.CreateDirectory(AppRoot);
    using (var resource = typeof(Program).Assembly
        .GetManifestResourceStream("RhineMusicPayload.zip")) { ... }
    // 逐条解压：
    //   destination = Path.GetFullPath(Path.Combine(AppRoot, entry.FullName.Replace('/', sep)));
    //   if (!destination.StartsWith(root)) throw new InvalidDataException("播放器资源包含无效路径。");  // L176-185
    //   entry 以 "/" 结尾 → Directory.CreateDirectory；否则 CopyTo(FileMode.Create)      // L187-198
    File.WriteAllText(markerPath, AppVersion, Encoding.UTF8);          // L204
}
```

要点：

1. **关键文件白名单校验**，不是只看 marker —— 用户可以清理 `%LOCALAPPDATA%` 部分文件，或杀软删了 `node.exe`，此时会重新解压（`L151-158`）。
2. marker 里写的是版本号（`.payload-ready` 内容 = `0.6.0-dev.57`，`L204`），但**读取时并不比较内容**，只判断存在 —— 版本隔离靠目录名 `app-v<version>`（`L44`），所以 marker 内容其实只是给人看的。这是可以改进的小点。
3. **zip-slip 防护到位**：`Path.GetFullPath` + `StartsWith(root)`（`L176-185`），Windows 下用 `OrdinalIgnoreCase`。注意这里**没做**「目标已存在则跳过/覆盖」判断，而是直接 `FileMode.Create` 覆盖 —— 磁盘上已被占用的 DLL（例如正在被旧进程加载）会导致解压失败，这是单文件 exe 常见坑，Rhine 没有显式处理（异常会冒到 `Main` 的 catch → MessageBox）。
4. 解压是**同步、阻塞**的（`Main` 里直接调用），首次启动大包会白屏几秒；没有 splash/进度条。

#### 3.1.3 单文件打包流水线（`scripts/build-windows.ps1`）

| 步骤 | 行为 | 证据 |
| --- | --- | --- |
| 版本号预留 | 在构建锁内扫描现有工件，分配下一个未用的 `0.6.0-dev.N`，同步 `version.json`、`package.json`/lock、UI 常量、PE 版本、manifest、解压目录、PWA 缓存键 | `BUILD-WINDOWS.md:20-22` |
| 前端 | `tsc && vite build && node scripts/build-pwa.mjs` | `package.json:23` |
| 服务端 bundle | esbuild 把 `scripts/music-server.mjs` 打成单 ESM 文件（`--platform=node --target=node22 --external:debug`） | `scripts/build-windows.ps1:139` |
| payload | `payloadRoot`（dist + scripts + node.exe + WebView2 DLL…）→ `payload.zip`（Optimal，不含顶层目录） | `scripts/build-windows.ps1:144-146` |
| 编译 | `csc /target:winexe /platform:x64 /optimize+ /out:... /resource:<payload.zip>,RhineMusicPayload.zip` + 清单/图标 | `scripts/build-windows.ps1:149-157` |
| 产物校验 | 对 exe 与 payload 分别 SHA-256；发布后重新计算比对；写 `SHA256SUMS.txt` | `scripts/build-windows.ps1:170-171,197,208-214` |
| 不覆盖旧版本 | `if (Test-Path $target) { throw "Refusing to overwrite an existing versioned artifact" }` | `scripts/build-windows.ps1:77-78` |
| 输出位置 | 默认 `<workspace>/outputs/`，可 `-OutputDirectory` 覆盖 | `scripts/build-windows.ps1:12` |

**可迁移的打包纪律**：①「失败也保留已预留的版本号，后续继续递增，绝不复用」；②「已有版本文件一律拒绝覆盖」；③「发布前对最终文件重算哈希并与构建时比对」。这三点在 Zilux2 的发布脚本里是纯收益。

#### 3.1.4 宿主侧的「工程化克制」

- `ResolveWebViewAssembly` 在 `AssemblyResolve` 里从 `AppRoot` 加载以 `Microsoft.Web.WebView2.` 开头的程序集（`DesktopProgram.cs:72-78`）—— 因为 DLL 不在 exe 同目录（解压目录），必须手动解析；`SetDllDirectoryW(AppRoot)`（`L104`）解决原生 `WebView2Loader.dll` 的搜索路径。
- 错误呈现的统一出口是 `ShowMessage`（`MessageBoxW`，`L453-457`），`Main` 里 catch-all（`L60-69`）→ `"Rhine Music 启动失败"` + 原始异常消息。没有日志文件（除了 node 的 `player-service.log`），宿主自己的异常不留痕 —— 对远程排障不友好。
- `KeyPreview = true` 让 Form 先拿到 F11（`L566-572`），这是 WinForms 实现全局快捷键的标准手法；WPF 里对应 `PreviewKeyDown` + `KeyBinding`。

### 3.2 （b）WebView2 参数与宿主-页面边界

#### 3.2.1 环境创建：极简、几乎不配置

```csharp
Directory.CreateDirectory(profile);                                     // DesktopProgram.cs:581
var environmentOptions = new CoreWebView2EnvironmentOptions();          // L582
var diagnosticArguments = Environment.GetEnvironmentVariable("RHINE_WEBVIEW2_DIAGNOSTIC_ARGUMENTS");
if (profileCapture && !string.IsNullOrWhiteSpace(diagnosticArguments))
    environmentOptions.AdditionalBrowserArguments = diagnosticArguments; // L583-585（仅诊断）
var environment = await CoreWebView2Environment.CreateAsync(null, profile, environmentOptions); // L586
await browser.EnsureCoreWebView2Async(environment);                     // L587
```

逐项拆：

| 参数 | 值 | 含义 |
| --- | --- | --- |
| `browserExecutableFolder` | `null` | 用系统 **Evergreen Runtime**，不固定版本（`L586` 第一个参数） |
| `userDataFolder` | `%LOCALAPPDATA%\Rhine Music\music-data-v3\webview-profile` | `DataRoot\webview-profile`（`L409` 传入，`L586` 使用）。与程序版本目录分离，升级不丢缓存 |
| `AdditionalBrowserArguments` | 默认 **null**；仅当 `RHINE_PROFILE_CAPTURE=1` 且设置了 env `RHINE_WEBVIEW2_DIAGNOSTIC_ARGUMENTS` 时透传 | 意味着**默认没有任何 GPU flag**：没有 `--disable-gpu`、没有 `--use-angle=d3d11`、没有 `--force_high_performance_gpu`、没有 `--enable-gpu-rasterization`。GPU 选择完全交给 WebView2/Chromium 默认策略 + 页面内 `powerPreference` 提示 |
| `AreDefaultContextMenusEnabled` | `false` | 禁右键菜单（`L588`） |
| `AreDevToolsEnabled` | `false` | 禁 F12/DevTools（`L589`）。副作用：现场排障只能靠 profile capture 或页面内自绘诊断 |
| 其余 Settings | 全部默认 | 未设置 `IsStatusBarEnabled`、`AreHostObjectsAllowed`、`IsZoomControlEnabled`、`IsGeneralAutofillEnabled`、`AreBrowserAcceleratorKeysEnabled` 等 |

**对 Zilux2 的启发（也是坑）**：

- 「不传 GPU flag」是**正确但被动**的策略。若 Zilux2 需要强制独显（例如 4K 封面墙），`--force_high_performance_gpu` 并不是 WebView2 官方稳定开关，更可靠的是页面内 `powerPreference:"high-performance"` + 把 WebGL2 实际 renderer 上报给用户（Rhine 的 `probeGpuCapability` 就是干这个的，见 §3.5）。
- `AreDevToolsEnabled=false` 发布版合理，但**必须留一条诊断通道**：Rhine 的做法是环境变量 + `profile-capture.jsonl`（见 3.2.4），Zilux2 建议保留 `ZILUX_WEBVIEW_DEVTOOLS=1` 之类的显式开关（仅调试构建）。
- `AreBrowserAcceleratorKeysEnabled` 默认 `true`：Ctrl+F、Ctrl+P、F5 等浏览器快捷键在页面内可用；Rhine 只拦了 F11（宿主级）。Zilux2 若做「无边框播放器」，需要显式决定这些键是否禁用，否则用户按 F5 会刷新整个应用（丢播放状态）。

#### 3.2.2 页面加载方式：真实 loopback HTTP，不用虚拟主机

`browser.Source = new Uri("http://127.0.0.1:"+port+"/?desktop=1")`（`DesktopProgram.cs:658`）。**没有** `SetVirtualHostNameToFolderMapping`（grep 无命中）、**没有** `file://`、**没有** `WebResourceRequested` 拦截自定义协议。

这样做的收益：

1. 前端所有请求都是**同源相对路径**（`fetch("/api/library")` 等，`src/music-app.ts:507-524`），不需要处理 `file://` 下的 CORS/绝对路径问题；
2. 音频 `<audio src="/api/audio/...">`（`src/music-player.ts:479`）走标准 HTTP Range（206），Chromium 原生支持 seek 流式；
3. 同一份 dist 既能在 Vite dev server、独立 Node 服务里跑，也能被桌面壳加载 —— 前端零改动。

代价：**本地 HTTP 服务成为唯一入口**，必须自己做安全边界（见 §3.3），且端口冲突/防火墙弹窗（绑定 loopback 一般不至于）是新增失败面。

#### 3.2.3 新窗口 / 下载 / 权限 / 通信

| 能力 | 代码行为 | 证据 |
| --- | --- | --- |
| 新窗口 | `NewWindowRequested` 一律 `request.Handled = true`；同 authority 的 URL 直接当前窗口导航，其它 `http/https` 交给系统默认浏览器 `Process.Start(UseShellExecute=true)` | `DesktopProgram.cs:645-657` |
| 下载 | **未处理 `DownloadStarting`** → 走 WebView2 默认行为（默认下载到用户 Downloads 或弹默认 UI，取决于 Runtime 版本） | 无对应代码（grep 无命中）→ 待确认 |
| 权限请求 | **未处理 `PermissionRequested`**（未使用摄像头/麦克风/通知，正常不会触发） | 无对应代码 |
| JS→C# | **无通道**。页面若要「通知宿主」，只能靠 HTTP 请求；宿主无法主动调用页面逻辑（除诊断模式 `ExecuteScriptAsync`） | `DesktopProgram.cs:819`；grep `WebMessage`/`AddHostObjectToScript` 均无命中 |
| C#→JS | 仅诊断：`ExecuteScriptAsync` 读取 `window.rhineMusic.*`（`L816-822`）；`CapturePreviewAsync` 截图（`L823-844`） | 诊断专用，生产模式不执行 |
| DevTools | 关闭（`L589`） | 同上 |
| 键盘 | F11 在 WinForms 侧拦（`L566-572`）；页面内全屏按钮走 HTML Fullscreen API（`src/music-app.ts:1853-1858`） | 两套全屏并存 |

> **这是 Rhine 与 Zilux2 差异最大的地方**：Zilux2 是「WPF 原生表面 + WorkerW 桌面层 + GSMTC + LibVLC」，天然需要宿主与页面双向通信（例如：GSMTC 切歌 → 推给 WebView 页面；页面点击桌面歌词 → 让宿主打开播放页）。Rhine 的「纯 HTTP 单向拉取」模型不够用，Zilux2 必须补：
> - 方案 A（推荐）：**`CoreWebView2.WebMessageReceived` + `PostWebMessageAsJson` 双向通道**（结构化、可 await、无需另起端口）；
> - 方案 B：**本地 HTTP + WebSocket/SSE**（页面主动订阅宿主事件，宿主推流）；
> - 方案 C：`AddHostObjectToScript`（同步对象桥，WPF/WinForms 均可用，但 API 暴露面大、调试难）。
> 若沿用 Rhine 的 HTTP 数据面，写操作（播放/暂停/切歌）建议从「页面 fetch 到 Node/C# 服务」改成「页面 WebMessage 到宿主」——避免页面成为唯一逻辑中枢，否则 GSMTC / 媒体键 / 托盘与页面状态会双写不一致。

#### 3.2.4 诊断流水线（可迁移的「无 DevTools 观测量」）

当 `RHINE_PROFILE_CAPTURE=1` 时（`DesktopProgram.cs:548`），窗口在 `Shown` 里挂一串事件并把 JSONL 追加到 `<webview-profile>/profile-capture.jsonl`（`L549,1045-1056`）：

- `NavigationStarting` / `NavigationCompleted`（含 `WebErrorStatus`、`HttpStatusCode`）`L598-606,630-643`
- `WebResourceResponseReceived`（最多 40 条，且过滤为同 authority）`L607-618`
- `ProcessFailed`（`ProcessFailedKind`/`Reason`/`ExitCode`/`FailureSourceModulePath`）`L619-629` —— **只在诊断模式记录，生产模式不处理渲染进程崩溃**
- `CaptureProfileAsync`：导航成功后依次 `ExecuteScriptAsync` 拉 viewport/dpr/screen、`app.gpuCapability`、`window.rhineMusic.profile()`（scene 的 `FrameProfiler.snapshot()` + `getStats()`）、歌词/播放状态，并 `CapturePreviewAsync` 存 PNG（`L669-1010`，其中 viewport 表达式 `L732-741`、歌词状态 `L870-1010`）。
- 每条记录都带 `capturedAtUtc`、`qpcMilliseconds`、`monitorBoundsPx`、`windowClientPx` 以及一句免责声明：`"This log contains WebView2 and WebGL metrics; measure genuinely displayed frames externally with PresentMon or ETW."`（`L1045-1055`）。

**价值**：在禁用 DevTools 的发布形态里，仍然能拿到「WebView2 版本 / 导航错误 / 资源状态码 / 渲染进程崩溃原因 / 实际 canvas 缓冲 / GPU timer / 帧分布」的完整证据链，这是给 QA/性能验收用的「黑匣子」。Zilux2 完全可以照搬这套「环境变量开关 + JSONL + 截图」的组合。

### 3.3 （c）本地 HTTP：music-server.mjs + music-library.mjs

#### 3.3.1 服务骨架与安全边界（先看这 20 行）

```js
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])            // music-server.mjs:10
const server = http.createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff')                // L119
  response.setHeader('Referrer-Policy', 'same-origin')                   // L120
  try {
    const host = new URL(`http://${request.headers.host ?? ''}`)         // L122
    if (!LOOPBACK.has(host.hostname)) return json(response, 403, { error: '本服务仅接受 localhost 请求' })
    const url = new URL(request.url, host)                               // L124
    if (request.headers.origin && request.headers.origin !== host.origin)
      return json(response, 403, { error: '不接受跨站点访问本地曲库' })    // L125
    const route = decodeURIComponent(url.pathname)                       // L126
    if (route.includes('\0') || route.includes('\\'))
      return json(response, 400, { error: '无效路径' })                   // L127
    ...
```

安全设计逐条：

1. **只绑定 `127.0.0.1`**：`server.listen(port, '127.0.0.1', ...)`（`music-server.mjs:249`）——不是 `0.0.0.0`，局域网不可达。这也是 Zilux2 本地服务应有的默认。
2. **Host 白名单**（`L122-123`）：防 DNS rebinding —— 恶意网页把域名解析到 127.0.0.1 时，浏览器发出的 `Host: evil.com` 会被 403。
3. **Origin 校验**（`L125`）：存在跨站 `Origin` 且不等于自身 origin 即拒绝 —— 防 `<script>`/`fetch` 跨站读取本地曲库（CSRF/数据外泄双保险）。
4. **URL 解码后就拒绝 `\0` 与反斜杠**（`L127`）：Windows 路径语义 + 空字节截断两类问题的低成本拦截。
5. **所有响应 `no-store`**（`json()` `L39-42`），非 API 的静态资源另外给缓存策略（`L233`）。
6. **请求体限制**：`bodyJson` 要求 `Content-Type: application/json`（否则 415，`L45`），流式累加上限 **128 KiB**（`L50`），必须是对象（`L54`）。
7. **超时**：`server.requestTimeout = 30_000`（`L239`）；在线请求各自带 `AbortSignal.timeout`（MusicBrainz 15 s，`music-library.mjs:635`；Beefweb 代理 5 s，`music-server.mjs:225`）。

> 缺口（可改进，Zilux2 别复制）：没有 **CSRF token / 本机端口随机化**，没有 **CSP 响应头**，没有 **HTTP 认证**。因为只监听 loopback + Host/Origin 校验，威胁模型基本够用；但如果 Zilux2 的本地服务要接受「局域网投屏/手机遥控」，必须另加 token（一次性随机串写进启动参数）。

#### 3.3.2 路由表（完整，便于复用协议）

| 方法 + 路径 | 行为 | 证据 |
| --- | --- | --- |
| `GET /api/health` | `{service:'rhine-local-music', projectDir, pid}`；宿主的存活探针 | `music-server.mjs:129` |
| `GET /api/library` | 每次先 `reloadRules()`（支持运行中手改 `genre-rules.json`），返回 `snapshot()` | `L130-134` |
| `POST /api/library/scan` | 202 + 当前快照；`scanPromise` 已存在则直接 202；`roots` 经 `safeRootList` 校验；扫描 fire-and-forget | `L135-141` |
| `GET/POST /api/genre-rules` | 读取/更新流派规则（更新后重新归并索引，不改音频标签） | `L142-146` |
| `GET/POST /api/config`、`/api/library/config` | 根目录/在线开关/foobar 地址；扫描中改 roots → 409 | `L147-154` |
| `POST /api/library/enrich` | MusicBrainz 在线补全；未配置联系邮箱 → 400；202 + 快照 | `L155-161` |
| `POST /api/library/introductions` | Wikipedia 专辑介绍抓取；`albumIds` 数量上限 10000；202 | `L162-168` |
| `GET/POST /api/playlists` | 列表 / 新建（201） | `L169-175` |
| `POST/PUT/DELETE /api/playlists/{uuid}/tracks[/{itemId}]` | 加曲 / 重排（PUT 全量 itemIds）/ 删曲 | `L176-194` |
| `PATCH/DELETE /api/playlists/{uuid}` | 重命名 / 删除 | `L195-207` |
| `GET /api/audio/{trackId}` | 音频流（Range；`private, no-cache`） | `L208-213` |
| `GET /api/artwork/{albumId}` | 封面（Range；`private, max-age=3600`） | `L208-213` |
| `GET /api/lyrics/{trackId}` | `{found,text}`；同名 LRC 读取（见 3.3.4） | `L215-216` |
| `GET /api/foobar/status`、`/api/foobar/*` | 本机 foobar2000/Beefweb 反向代理；未配置 503；路径白名单正则；只允许 GET/POST；5 s 超时；`redirect:'error'` | `L217-229` |
| `GET/HEAD 其它` | `dist/` 静态文件；`/assets/*` 强缓存 1 年 immutable，其它 `no-cache` | `L231-233` |

路由用「**顺序 if + 正则**」手写，没有路由表/框架。好处是没有依赖、行为一眼看完；坏处是路由顺序敏感（`/api/*` 兜底在最后，`L230`），新增路由必须插在兜底之前。

#### 3.3.3 Range 流式音频（Chromium 里 `<audio>` 能 seek 的关键）

```js
export function parseRange(header, size) {                       // music-server.mjs:59-77
  if (header === undefined) return null                            // 无 Range
  const match = /^bytes=(\d*)-(\d*)$/.exec(header)                 // 只支持单段
  if (!match || (!match[1] && !match[2]) || size === 0) return false
  let start, end
  if (!match[1]) {                                                 // bytes=-N（尾部 N 字节）
    const suffix = Number(match[2])
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false
    start = Math.max(0, size - suffix); end = size - 1
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return false
    end = Math.min(end, size - 1)
  }
  return { start, end }
}

async function serveFile(request, response, descriptor, { cache = 'no-cache' } = {}) {
  const [actualPath, actualRoot] = await Promise.all([fs.realpath(descriptor.path), fs.realpath(descriptor.allowedRoot)])
  const relative = path.relative(actualRoot, actualPath)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw Object.assign(new Error('文件已移出配置的音乐目录'), { status: 403 })   // L80-82
  const stat = await fs.stat(actualPath)
  if (!stat.isFile()) throw Object.assign(new Error('文件不存在'), { status: 404 })
  const range = parseRange(request.headers.range, stat.size)
  ...
  if (range === false) {                                            // 416
    response.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}`, 'Content-Length': 0 }); return
  }
  response.writeHead(range ? 206 : 200, headers)
  if (request.method === 'HEAD' || stat.size === 0) return response.end()
  const stream = createReadStream(actualPath, range ?? {})
  stream.on('error', () => response.destroy())
  response.on('close', () => stream.destroy())
  stream.pipe(response)                                             // L102-105
}
```

要点：

- 返回头包含 `Accept-Ranges: bytes`、`Content-Length`、`Content-Type`、`Last-Modified`、`X-Content-Type-Options: nosniff`（`L86-90`）。
- **`realpath` 双重校验**：先把「文件路径」和「允许根」都解析成真实路径，再判断相对关系（`L80-82`）。这同时防了「符号链接/junction 逃出音乐目录」——比单纯 `startsWith` 前缀判断更稳。
- 只支持**单段 Range**；`multipart/byteranges` 不实现（Chromium 的 `<audio>`/`<video>` 只用单段，够用）。
- **没有 `If-None-Match`/`If-Modified-Since` 处理**：`Last-Modified` 发了但不做 304（`L79-106` 全程无 304 分支）。API 层 `no-store`，封面靠 `max-age=3600` 客户端缓存。所以重复打开同一专辑时会重新拉封面字节（图集有内存缓存，影响有限）。
- 流式背压与取消：`response.on('close')` 销毁读流（`L104`），避免用户切歌后继续读盘。

#### 3.3.4 音频 / 歌词 / 封面的安全读取

**音频**：`/api/audio/{trackId}` → `store.trackFile(id)` 返回 `{ path, mime, allowedRoot }`（`music-library.mjs:609-612`），`allowedRoot` 是命中的配置根目录（`L599-607` 的 `trackPath` 用 `pathIsWithin` 校验）；然后走 `serveFile`。路径从不直接来自 URL —— URL 只含 trackId，真实路径来自内存索引，这是**防目录穿越的最强形态**。

**歌词**（`music-server.mjs:18-37`，值得整段借鉴）：

```js
async function readTrackLyrics(store, trackId) {
  const track = store.trackPath(trackId)
  if (!track) return { found: false, text: '' }
  const [audioPath, rootPath] = await Promise.all([fs.realpath(track.path), fs.realpath(track.root)])
  if (!pathIsWithin(rootPath, audioPath)) throw ...403
  const directory = path.dirname(audioPath)
  const stem = path.parse(audioPath).name.normalize('NFKC').toLocaleLowerCase('en-US')
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const candidate = entries
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLocaleLowerCase('en-US') === '.lrc'
      && path.parse(entry.name).name.normalize('NFKC').toLocaleLowerCase('en-US') === stem)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))[0]
  if (!candidate) return { found: false, text: '' }
  const lyricPath = path.join(directory, candidate.name)
  const actualLyricPath = await fs.realpath(lyricPath)
  if (!pathIsWithin(rootPath, actualLyricPath) || path.dirname(actualLyricPath) !== directory) return { found: false, text: '' }
  const stat = await fs.stat(actualLyricPath)
  if (!stat.isFile()) return { found: false, text: '' }
  if (stat.size > LYRIC_LIMIT) throw ...413     // LYRIC_LIMIT = 1 MiB（L11）
  return { found: true, text: await fs.readFile(actualLyricPath, 'utf8') }
}
```

设计点：只认**与音频同名的 `.lrc`**、同目录、大小写与 NFKC 归一后匹配、按 zh-CN 数字序取第一个；解析前再做一次 realpath + 同目录校验（防 LRC 是符号链接指向目录外）。**不支持**内嵌 USLT 歌词、不解析 ID3 内歌词、不联网搜词 —— 与 Zilux2「本地缓存 + QQ/网易云/酷狗」的歌词服务是互补关系而非竞争（Zilux2 可把这段作为「本地同名 LRC」的兜底源）。

**封面**（`music-library.mjs:471-563`）：

1. 优先用专辑文件夹里的图片：`walkAlbums` 扫描 `.png/.jpg/.jpeg/.webp`，按 `cover` > `folder` > `front` > 字典序（`L129-134`）；根目录下的音频是「单曲」，同名图片配给它（`L135-140`）。
2. 没有图片文件则从音频标签**抽内嵌封面**：取 `type` 含 `front` 的 picture，否则第一张；>30 MiB 跳过；MIME 仅允许 jpeg/png/webp；写入 `music-data-v3/artwork/<sha256>.<ext>`，`mode 0o600`，已存在则不重复写（`L495-510`）。
3. `version` = 文件封面 `hash(path:size:mtime)`（`L476`）或内嵌图字节 hash（`L502`）→ 前端 `coverUrl = /api/artwork/<albumId>?v=<version>`（`snapshot()` `L372`）。**改图/换标签即换 URL，绕过缓存**，这是最简单可靠的缓存失效方案（比 ETag 省事）。
4. `artworkFile(id)` 返回的 `allowedRoot`：内嵌封面是 `dataDir`，文件封面是音乐根（`L614-620`）—— 同样走 `serveFile` 的 realpath 校验。

#### 3.3.5 曲库索引与扫描（数据面）

- **文件布局**（`dataDir` 默认 `MUSIC_DATA_DIR` 或 `<repo>/../music-data-v3`，`music-server.mjs:109`；桌面下环境变量指向 `%LOCALAPPDATA%\Rhine Music\music-data-v3`）：
  - `config.json`：`{version:1, roots:[], onlineEnabled:false, foobarBaseUrl:null, musicBrainzContact?}`（`music-library.mjs:246,259-260`）
  - `library-index.json`：`{version, albumIdentityVersion, albums:[…], roots, scannedAt}`（`L247,262,455`）
  - `genre-rules.json`：可手改的流派规则（`L282,314-326`）
  - `playlists.json`：`{version:1, playlists:[…]}`（`playlists.mjs:51,57-58`）
  - `artwork/`：内嵌封面缓存
- **原子写**：`writeJsonAtomic`（`music-library.mjs:46-56`）先写临时文件再 rename；`saveIndex` 用 `saveChain = saveChain.catch(()=>{}).then(...)` 串行化（`L306-312`），避免并发写坏 JSON。歌单同理（`playlists.mjs:73-75`）。
- **扫描**（`music-library.mjs:387-470`）：
  - 并发保护：`if (this.scanPromise) return this.scanPromise`（`L388`）；路由层也有 `if (store.scanPromise) return 202`（`music-server.mjs:137`）双保险。
  - **先枚举后替换**：注释明确「partial permission failures must never masquerade as deletions」（`L410-412`），每个根目录先 `walkAlbums` 完再 `readAlbum`，异常时把该根标记 `offline` 并保留旧条目（`L419-424`），最后整体替换 `this.index`（`L455`）。
  - **增量元数据**：track 级缓存指纹 `${size}:${mtimeMs}` + `METADATA_VERSION=3`（`L28,483-489`），命中则复用旧解析结果；`skipCovers: !!cover` 避免重复解析内嵌图（`L492`）。
  - **多碟/单曲启发式**：文件名 `01-02 xxx` 前缀、目录名 `CD1/disc 2/盘3` 推断碟号（`L513-516`），条目录入后按 disc/track/相对路径排序（`L543`）。
  - **可播性白名单**：`BROWSER_EXTENSIONS = flac/wav/m4a/mp4/mp3/aac/ogg/opus`（`L8`），`browserPlayable` 写进 track（`L526`）；`AUDIO_EXTENSIONS` 更宽（含 `.dsf/.dff/.alac/.aiff`，`L7`）只是索引。也就是说：**能被索引 ≠ 能在 WebView2 里播**——DSD/ALAC 会被列出但点播会失败（前端有 `browserPlayable` 可用于禁用，见 `L526`）。这是纯 Web 播放器的诚实边界，Zilux2 用 LibVLC/NAudio 反而不受此限。
- **在线资料**：`MusicBrainz` 必须配置 `musicBrainzContact`（否则 400，`music-server.mjs:157`），UA 形如 `RhineLocalMusic/0.1 (<contact>)`，请求间隔 ≥1100 ms（`music-library.mjs:628-639`）；`enrichAlbum` 用「标题 + artist-credit + track-count」三重匹配（`L760-770`）；专辑介绍走 Wikidata sitelinks → zh/en Wikipedia extracts（`L641-676`）。**这一套的工程价值是「礼貌爬取」而不是功能本身**：Zilux2 若接 QQ/网易云/酷狗，同样应做节流 + 明确 UA + 失败保留本地数据。

#### 3.3.6 前端如何消费后端（以及轮询策略）

- 单入口 `request<T>(url, body?, method?)`：默认 GET，带 body 自动 POST + `Content-Type: application/json`；非 2xx 或非 JSON → `throw new Error(data?.error || 本地服务请求失败)`（`src/music-app.ts:507-524`）。
- 轮询：`loadLibrary()` 结束后自调度下一次 —— 扫描/补全/介绍进行中 **1.4 s**，空闲 **12 s**（`src/music-app.ts:553-561`）；开场动画（`boot.active`）期间推迟 1 s（`L526-531`），避免动画卡顿。
- 失败降级：`apiAvailable=false`，若已有专辑则继续用内存数据，无专辑时显示空态并提示 `npm run music`（`L539-549`）。
- 歌词请求带 **版本号防串台**：`lyricRequestVersion` 自增，回来时代不匹配就丢弃（`L1443-1475`）。
- `MusicLibrary` 形状在前端只看 `{version, albums, genres, roots, scan, onlineEnabled}`（`L154-161`），其余字段（enrich/introductions）按需扩展 —— 后端的 `snapshot()` 才是权威形状（`music-library.mjs:355-385`）。

### 3.4 （d）全屏与 DPI

#### 3.4.1 Per-Monitor V2：manifest + API 双保险

`app.manifest`：

```xml
<dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true/pm</dpiAware>
<dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2</dpiAwareness>
<longPathAware xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">true</longPathAware>
...
<requestedExecutionLevel level="asInvoker" uiAccess="false" />
```
（`app.manifest:15-22`，另含 Win10 `supportedOS` GUID `L11-13`）

代码再兜底一次（`DesktopProgram.cs:422-433`）：

```csharp
private static void ConfigureDpiAwareness()
{
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; }   // -4 = PER_MONITOR_AWARE_V2
    catch (EntryPointNotFoundException) { } catch (DllNotFoundException) { }
    try { SetProcessDPIAware(); }                                        // 老系统退化为 System DPI Aware
    catch (EntryPointNotFoundException) { } catch (DllNotFoundException) { }
}
```

- `-4` 对应 `DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2`；`SetProcessDPIAware` 是 Vista+ 的 System-DPI-Aware 回退（`L523-527` 的 P/Invoke）。
- 调用点在 `Main()` 第一行之后、任何窗口创建之前（`L59`）—— 这是正确的时序（`SetProcessDpiAwarenessContext` 必须在窗口创建前调用）。
- 双保险的意义：manifest 在「以 exe 启动」时生效；若被宿主进程以其他方式拉起/或被某些兼容层忽略，API 调用仍能保证；反之老系统（无 `SetProcessDpiAwarenessContext`）靠 manifest + 回退。

#### 3.4.2 WinForms 窗口与 DPI 的实际行为

- 窗口默认 `WindowState=Maximized`、`Size=1440×900`、`MinimumSize=960×640`（`DesktopProgram.cs:560-565`）；诊断窗口模式可自定义 480–3840 × 360–2160（`L552-559`，`ReadProfileDimension` `L1028-1033`）。
- 窗口**没有**处理 `DpiChanged`/`DpiChangedAfterParent`，也没有手动缩放任何子控件 —— 全部依赖 WinForms 的 PerMonitorV2 自动缩放和 WebView2 `Dock=Fill`（`L574`）。WebView2 在宿主窗口 DPI 变化时会自动调整浏览器缩放/尺寸（Runtime 行为，非本仓库代码）。
- **页面侧的 DPI 感知在浏览器的 devicePixelRatio**：`src/music-app.ts` 的 `fit()` 只监听 `window.resize`（`L495-505`），真正的像素比来自 `devicePixelRatio`（在 `quality-renderer.ts:40-77` 与 `render-quality.ts:152-175` 中使用）。因此「跨显示器拖动窗口」时，WebView2 触发 resize + DPR 变化 → 页面重新计算 canvas 缓冲。这条链路是隐式的，没有显式 DPI 消息。

#### 3.4.3 F11 无边框全屏的状态机

```csharp
private void ToggleFullscreen()                                        // DesktopProgram.cs:1058-1077
{
    if (!fullscreen)
    {
        windowedBorderStyle = FormBorderStyle;   // 保存
        windowedBounds = Bounds;
        windowedState = WindowState;
        FormBorderStyle = FormBorderStyle.None;  // 去边框
        WindowState = FormWindowState.Normal;    // 必须先 Normal，否则 Maximized 下改 Bounds 无效
        Bounds = Screen.FromControl(this).Bounds;// 覆盖当前显示器（含任务栏区域）
        fullscreen = true;
        return;
    }
    FormBorderStyle = windowedBorderStyle;       // 恢复
    WindowState = FormWindowState.Normal;
    Bounds = windowedBounds;
    WindowState = windowedState;
    fullscreen = false;
}
```

关键设计（也是坑）：

1. **先 `Normal` 再改 `Bounds`**：WinForms 里 `Maximized` 状态下设置 `Bounds` 不会生效，必须先还原。这是 WinForms 全屏的经典顺序。
2. **取当前显示器**：`Screen.FromControl(this)` 而不是 `PrimaryScreen`，多显示器下在哪个屏就全屏在哪屏。
3. **覆盖任务栏**：`Screen.Bounds` 是整块屏（不是 `WorkingArea`），所以是真全屏；代价是无边框窗口没有标题栏，退出只能靠 F11/Alt+F4（页面内没有退出全屏按钮的桌面语义）。
4. **恢复顺序**：先恢复 `BorderStyle`，再 `WindowState=Normal`、`Bounds`，最后恢复原 `WindowState` —— 若原状态是 Maximized，最终回到最大化而不是全屏。
5. **DPI/多屏边界（待确认的坑）**：`windowedBounds` 保存的是**物理像素**且属于当时那块屏；先把窗口拖到另一块不同 DPI 的屏再 F11 两次，恢复时会用旧屏的 Bounds，可能落到错误位置/尺寸。Rhine 没有做 `DpiChanged` 重算，生产环境大概率可接受，但 Zilux2 若做多屏桌面歌词（WorkerW 挂桌面层）必须严格按 monitor 处理。

**页面内的第二套全屏**：设置面板的「切换全屏 ↗」按钮执行 `document.documentElement.requestFullscreen()` / `exitFullscreen()`（`src/music-app.ts:1853-1858`），失败提示「当前浏览器无法进入全屏」。在 WebView2 桌面壳里这两套会叠加：F11 是 WinForms 级（窗口边框消失），HTML Fullscreen 是 Chromium 级（元素进入全屏层）。用户可能按 F11 再点按钮，出现「全屏套全屏」的观感问题；且 HTML Fullscreen 的 Esc 退出由 Chromium 处理，会与宿主 F11 的状态机脱节（宿主 `fullscreen` 字段仍是 true）。**待确认**实际交互（未运行），但可以确定：**没有同步机制**（宿主不知道页面进了全屏，页面不知道 F11 状态）。Zilux2 应统一为一条路径（推荐宿主级全屏，页面只发请求）。

#### 3.4.4 4K 验收纪律（工程流程可复用）

`BUILD-WINDOWS.md:38-40` 写得很硬：

> 前端显示的 rAF 诊断值不作为验收结果。性能报告必须记录 3840×2160 的实际 canvas 缓冲区，并用 PresentMon 的显示帧/显示间隔数据检查冷切换、热切换、快速切换、专辑详情、主题切换和大曲库。目标显示帧率至少 60 FPS，且测试期间不降低原始画质、不把低分辨率画面放大到 4K，也不使用帧率上限伪造结果。

配套代码提供「实际 canvas 缓冲区」的证据：`FrameProfiler.snapshot().viewport` 记录 `cssWidth/cssHeight/dpr/backBufferWidth/backBufferHeight`（`src/frame-profiler.ts:200`），`resizeQuality` 把真实渲染尺寸写进 `host.dataset.renderQuality`（`src/quality-renderer.ts:66-75`）。这套「**画质不许偷偷降级、帧率不许伪造**」的验收口径，比任何自适应算法都更值得抄进 Zilux2 的发布流程。

### 3.5 （e）宿主-前端边界与 Three.js 关键机制

#### 3.5.1 边界契约：`window.rhineMusic`（只读诊断对象）

页面启动最后把一组 getter 挂到 `window`（`src/music-app.ts:2245-2276`）：

```ts
Object.assign(window, {
  rhineMusic: {
    get library() { return library; },                    // 当前曲库快照
    get selectedAlbum() { return currentAlbum(); },
    get player() { return player.state; },                 // MusicPlayerState
    get playbackTime() { return player.playbackTime; },     // 平滑播放时间
    stats: () => scene?.getStats(),                        // drawCalls/triangles/selectionLight
    profile: () => ({ version: BUILD_VERSION, gpuCapability,
      renderer: scene?.getPerformanceProfile(),            // FrameProfiler.snapshot()
      scene: scene?.getStats() }),
    coverDiagnostics: () => scene?.getCoverDiagnostics(),  // 图集页/tile/错误统计
    coverPreviewDataUrl: () => scene?.getCoverPreviewDataUrl(),
    get presentation() { return { phase: presentation.phase, cameraPhase: scene?.musicPresentationPhase,
      pendingIndex: presentation.pendingSelection?.index, menuVisible: !$("#music-detail").hidden,
      cameraReady: scene?.musicPresentationReady, archiveReady: scene?.musicArchiveReady }; },
  },
});
```

这个对象**只被 C# 诊断模式消费**（`DesktopProgram.cs:732-741, 881-883` 的 `ExecuteScriptAsync` 表达式里读 `app.gpuCapability / app.playbackTime / app.presentation / window.innerWidth / devicePixelRatio`），业务逻辑从不依赖它。它相当于「无 DevTools 时的 Web 侧可观测面」，Zilux2 可以照做（哪怕只用 `?debug=1` 开关）。

**`?desktop=1` 是一个空参数**：全仓库 grep `desktop` 只命中 `src/viewport-layout.ts:20` 的布局枚举 `"desktop"`，前端从未读取该 query。也就是说桌面壳传的 `?desktop=1` 目前无行为差异（历史遗留或预留给未来），**待确认**设计意图。真正有行为的是：`?profile=1`（开启 FrameProfiler，`src/scene.ts:189`）、`?scene=archive`（跳过开场动画，`src/music-app.ts:2223`）、`?lighting`（`L2203`）、`?stress`（压测曲库，`DesktopProgram.cs:403-407` 注入，前端消费点未逐一核实）。

#### 3.5.2 GPU 能力探测：厂商中立的「报告实际适配器」

```ts
/** Vendor-neutral GPU capability probe. WebView2 and ordinary browsers use the
 * same WebGL 2 API. `powerPreference` is a selection hint, not a guarantee that
 * a runtime will choose a particular adapter; report the actual GL renderer. */
export function probeGpuCapability(): GpuCapability {                    // src/gpu-capability.ts:11-27
  const canvas = document.createElement("canvas");
  let gl: WebGL2RenderingContext | null = null;
  try {
    gl = canvas.getContext("webgl2", { powerPreference: "high-performance", failIfMajorPerformanceCaveat: false });
    if (!gl) return { api: "unavailable", renderer: "", mode: "unknown", maxTextureSize: 0 };
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : "";
    const mode = /swiftshader|llvmpipe|softpipe|software|microsoft basic render|\bwarp\b/i.test(renderer)
      ? "software" : renderer ? "hardware" : "unknown";
    return { api: "WebGL 2", renderer, mode, maxTextureSize: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) };
  } catch { return { api: "unavailable", renderer: "", mode: "unknown", maxTextureSize: 0 }; }
  finally { gl?.getExtension("WEBGL_lose_context")?.loseContext(); }   // 立刻释放探针上下文
}
```

设计亮点（可直接抄）：

1. **探测用独立 canvas，用完 `loseContext()` 释放**，避免探针本身占一个 GPU 上下文（Chromium 有上下文数量上限）。
2. **不假设 ANGLE/独显**，用 `WEBGL_debug_renderer_info` 拿真实 renderer 字符串，再正则识别软件渲染（SwiftShader/llvmpipe/WARP/MS Basic Render）→ `mode: "software"`。
3. 结果写入 DOM 供诊断：`$("#three-scene").dataset.gpuCapability = JSON.stringify(gpuCapability)`（`src/music-app.ts:2192`），并显示在 HUD：`rAF诊断 … / ${gpuCapability.api}${软件渲染/显卡加速}`（`L2146-2147`）。
4. **但探测结果没有驱动任何降级决策**：即使是软件渲染，初始画质仍是 `original` 预设（`L123-131`）。这是比探测本身更值得补的缺口——Zilux2 应在 `mode === "software"` 时自动切到低预设并提示用户。

#### 3.5.3 画质模型：9 个正交参数 + 4 个预设 + 三重像素上限

`src/render-quality.ts:2-61`：

```ts
export type RenderQuality = {
  scale: number;          // 渲染分辨率百分比 50–200（步进 5）
  pixelRatio: number;     // 1 / 1.5 / 2 / 3（再乘 devicePixelRatio 的封顶）
  antialias: "off" | "smaa";
  shadows: number;        // 0 / 1024 / 2048 / 4096（阴影贴图尺寸，0=关）
  aoSamples: number;      // 0 / 16 / 32 / 64（SSAO kernel，0=关）
  aoResolution: number;   // 0.5 / 0.75 / 1
  depthOfField: number;   // 0–150（0=关）
  transmission: number;   // 0.25 / 0.5 / 0.75 / 1（透射/玻璃材质分辨率比例）
  anisotropy: number;     // 1 / 2 / 4 / 8 / 16
};
export const qualityPresets = {
  performance: { scale: 80,  pixelRatio: 1, antialias: "off",  shadows: 1024, aoSamples: 0,  aoResolution: 0.5, depthOfField: 0,   transmission: 0.5, anisotropy: 4  },
  original:    { scale: 100, pixelRatio: 3, antialias: "off",  shadows: 2048, aoSamples: 32, aoResolution: 1,   depthOfField: 100, transmission: 1,   anisotropy: 16 },
  high:        { scale: 125, pixelRatio: 2, antialias: "smaa", shadows: 4096, aoSamples: 32, aoResolution: 1,   depthOfField: 100, transmission: 1,   anisotropy: 16 },
  ultra:       { scale: 150, pixelRatio: 2, antialias: "smaa", shadows: 4096, aoSamples: 64, aoResolution: 1,   depthOfField: 100, transmission: 1,   anisotropy: 16 },
} as const satisfies Record<string, RenderQuality>;
export const MAX_AUXILIARY_BUFFER_PIXELS = 1920 * 1080;                  // L65（后处理缓冲上限 2 MP）
```

三个「不许画质偷偷爆内存」的上限（`L67-76, 152-175`）：

1. **后处理/透射缓冲**：`auxiliaryResolutionScale(requested, w, h) = min(requested, sqrt(MAX_AUXILIARY_BUFFER_PIXELS/(w*h)))`（`L67-76`）——4K 下 `sqrt(2073600/8294400)=0.5`，后处理按半分辨率跑。
2. **主渲染目标**：`renderDimensions` 里 `ratio = min(requested, sqrt(8_294_400/(w*h)), maxTextureSize/max(w,h))`（`L163-168`）——8.3 MP 大约就是 3840×2160，即 4K 封顶；超出自动降采样。
3. **纹理上限**：`applyTextureQuality` 用 `min(quality.anisotropy, renderer.capabilities.getMaxAnisotropy())`（`src/quality-renderer.ts:17-20`）；`CoverAtlas` 用 `maxTextureSize` 决定图集分页（`src/scene.ts:454-456`）。

`normalizeQuality` 是**白名单防注入**实现：每个字段走 `member(value, [枚举], fallback)` 或 `range(value, min, max, step, fallback)`（`src/render-quality.ts:93-138`）。因为画质对象存在 `localStorage`（可被用户/旧版本写坏），这一步校验是必要的；`matchingPreset()` 再反推当前是哪个预设或 `custom`（`L140-150`）。

#### 3.5.4 画质应用：`setQuality` / `resize` / 纹理各向异性

`ArchiveScene.setQuality(value)`（`src/scene.ts:798-836`）做四件事：

1. 归一化并比较 `JSON.stringify(quality)` 键，未变则跳过（`L799-806`）——避免 UI 拖动滑杆时反复重建。
2. `aoSamples` 变化 → **重建 `SSAOPass`**（`L807-817`），这是唯一的重对象重建。
3. 开关后处理/阴影/SMAA，并设置 `shadow.mapSize`（`L821-835`）。
4. `applyTextureQuality(this.scene, this.renderer, quality)` 后 `this.resize()`（`L835-836`）。

`applyTextureQuality`（`src/quality-renderer.ts:12-38`）遍历场景内所有 Mesh 材质的纹理（排除 render target 纹理），把 `anisotropy` 设成 `min(quality.anisotropy, maxAnisotropy)`，**变化时才置 `needsUpdate = true`**（`L33-37`）。注意：`needsUpdate` 会让纹理重新上传——在大场景里切换各向异性会有一次卡顿，所以代码只在值真的变化时做。

`resizeQuality`（`src/quality-renderer.ts:40-77`）：

```ts
const dimensions = renderDimensions(quality, width, height,
  host.getBoundingClientRect().width / width,   // 布局比例（考虑 transform/zoom）
  devicePixelRatio,
  renderer.capabilities.maxTextureSize);       // L48-55
renderer.setPixelRatio(dimensions.ratio);
renderer.setSize(width, height);
composer.setPixelRatio(dimensions.ratio);      // 后处理一并
composer.setSize(width, height);
renderer.transmissionResolutionScale = transmissionResolutionScale(quality, dimensions.width, dimensions.height); // L60-65
host.dataset.renderQuality = JSON.stringify({ ...dimensions, antialias, transmission, transmissionScale, anisotropy }); // L66-75
```

两个细节值得注意：

- **`getBoundingClientRect().width / width` 作为 stage 比例**：若容器被 CSS transform 缩放，这里能拿到真实视觉比例（`clientWidth` 是布局宽度，不含 transform）。
- **`renderer.transmissionResolutionScale` 是项目对 Three.js 的扩展属性/开关**（传 `transmission` 给玻璃材质做半分辨率透射）。Three.js r183 是否有稳定同名 API **待确认**；至少在这份代码里它被当作「渲染器上的一个数值」使用，材质侧如何消费没有在质量模块中体现（应在 `music-model.ts`/材质定义里）。

**「画质自适应」的真相**：`updateQuality()`（`src/music-app.ts:1607-1617`）在用户改设置时调用 `scene.setQuality(renderQuality)`；全仓库**没有基于帧时间自动降档/自动升档的控制器**。所谓「自适应」实际是三层兜底：①`renderDimensions` 的像素上限（防止 4K 爆显存）；②用户手动预设；③`devicePixelRatio` 随窗口/显示器变化在 resize 时重算。`performance` 预设是给低端机手动选的，不是自动降级。

#### 3.5.5 FrameProfiler：GPU timer query + 长任务 + p95/p99 的「证据型」诊断

`src/frame-profiler.ts` 是本仓库最值得学的工程件之一：

- **只在 `?profile=1` 时启用**：`new FrameProfiler(gl, searchParams.get("profile") === "1")`（`src/scene.ts:187-190`）；`enabled=false` 时所有方法近乎空操作（`L48-50, 65-66`），零生产开销。
- **GPU 计时**：`EXT_disjoint_timer_query_webgl2`（`L47-50`），`beginQuery/endQuery` + `QUERY_RESULT_AVAILABLE` 轮询（`L104-124, 233-263`），并检查 `GPU_DISJOINT_EXT` 丢弃异常采样（`L240`）；待处理查询上限 32（`L105`）。
- **pass 级计时**：场景包装了 composer 每个 pass 的 `render()`（`src/scene.ts:1189-1201`），pass 名单 `["RenderPass","SSAOPass","BokehPass","SMAAPass","OutputPass"]`（`L1191`）；并且**每 6 帧才测一次**（`this.frameCount % 6 !== 0`，`frame-profiler.ts:85`），避免查询本身拖慢。
- **长任务**：`PerformanceObserver({type:"longtask"})`（`L51-61`），保留最近 512 条。
- **专辑切换采样**：`beginAlbumSwitch` 记录 15 s 窗口内的 rAF gap、scene CPU、GPU、pass GPU（`L19, 151-176`），供「冷/热切换」性能分析。
- **输出**：`snapshot()` 返回 `viewport`（css/dpr/backBuffer 尺寸）、`gpuTimer`、`gpuPasses`、`scenePhases`、`mainThread`（rAF p95/p99、sceneCpu p95/p99、长任务总数）、`albumSwitches`、`library`、`webgl`（`L191-231`）。
- **诚实性标注**：`note: "rAF intervals describe main-thread scheduling only; use DXGI/ETW for actual presented frames."`（`L199`）——与 `BUILD-WINDOWS.md:40` 的验收纪律互相印证。
- 消费侧：HUD 显示 rAF 诊断 FPS / canvas buffer / 主题 / GPU 模式（`src/music-app.ts:2144-2147`）；`?profile=1` 时把完整 JSON 写进 `dataset.performanceProfile`，并把最新切歌的关键指标拼成 `aria-description`（`L2159-2178`）；`scene.recordProfileFrame(ms, cpuMs)` 每帧喂数据（`L2184`）。

这套东西的定位是「**性能测试仪**」而不是「自适应控制器」：它让「4K 60 FPS、不降画质、不伪造」这类验收要求可以被验证，而不是靠体感。

#### 3.5.6 Three.js 场景骨架（给 Zilux2 的 WebGL 可视化参考）

`ArchiveScene` 构造（`src/scene.ts:174-270`）：

```ts
this.renderer = new THREE.WebGLRenderer({
  // The quality pipeline provides SMAA when requested. Avoid a second
  // multisampled framebuffer at the default performance setting.
  antialias: false,            // 关键：关 MSAA，抗锯齿交给 SMAA pass
  alpha: false,
  powerPreference: "high-performance",
});                                               // L180-186
this.renderer.setPixelRatio(Math.min(devicePixelRatio, 3) * Math.min(innerWidth/1920, innerHeight/1080)); // L191-194
this.renderer.shadowMap.enabled = true;
this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
this.renderer.toneMappingExposure = 1.05;         // L197-200
...
this.composer = new EffectComposer(this.renderer);
this.composer.addPass(new RenderPass(this.scene, this.camera));
this.ao = new SSAOPass(...); this.composer.addPass(this.ao);
this.bokeh = new ScaledBokehPass(...); this.composer.addPass(this.bokeh);
this.smaa.enabled = false; this.composer.addPass(this.smaa);
this.composer.addPass(new OutputPass());          // L247-267
```

其它关键机制：

- **实例化封面墙**：`new THREE.InstancedMesh(geom, arrayMat, count)`（`L426`），另有只投影的 `shadowOnlyInstances`（`L442`）和「离屏投影层 1」技巧（`L210-212`：`light.shadow.camera.layers.enable(1)`，把不参与主相机颜色的物体只留在阴影 pass）。
- **静态阴影优化**：有曲库时 `shadowMap.autoUpdate = false`，只在需要时 `needsUpdate`（`L1923-1939`）——封面墙本身不动，阴影贴图不必每帧重算。
- **动态性能编译期开关**：`renderer.info.autoReset = false`（`L196`）自己控制统计粒度。
- **色彩管线**：ACES Filmic + OutputPass（sRGB 输出），`toneMappingExposure` 随主题在 1.05/1.08 间过渡（`L564`）。
- **确定性视觉**：星空/随机元素用固定种子 LCG（`seed=417`，`L233-236`），保证截图对比可复现。
- **相机**：`fov = 6.15`（长焦、近似正交的档案架观感），初始位置 `(-62.26, 35.98, 43.28)` 看向 `(-0.5, 1.1, 0.4)`（`L243-246`）。

#### 3.5.7 封面图集 `cover-atlas.ts`：一张 DataTexture + 每实例 tile UV + 增量 `copyTextureToTexture`

这是「上万张封面也要固定显存」的核心，README 也专门吹了一段（`README.md:14`）。机制拆解：

1. **固定 tile 网格**：`tileWidth = min(256, maxTextureSize)`（`cover-atlas.ts:152`），`pageColumns = min(16, floor(maxTextureSize/tileWidth))`（`L157`），`pageRows = min(8, floor(maxTextureSize/tileHeight))`（`L158`）→ 每页最多 **128 个 tile（16×8）**。最大纹理 16384 的 GPU 上仍是 256px tile，页数按可见池增长。
2. **每页一张 `THREE.DataTexture`**（RGBA/UnsignedByte，`L280-288`），`generateMipmaps=false`、`magFilter=minFilter=Linear`、`anisotropy = min(4)`（页面）/`min(8)`（选中封面）（`L221, 280-299`）。
3. **CPU 侧两块画布**：`selectedCanvas` 固定 1024×1024（`COVER_PAINT_SIZE=1024`，`L32,162-163`），`tileCanvas` 为 tile 尺寸；两者都用 **2D context 且带 `{willReadFrequently:true}`**（`L164-168`，注释解释：不挂 WebGL 依赖，保证 canvas→texture 上传路径在软件栈上也快）。
4. **UV 内缩 `COVER_INSET = 1/128`**（`L35`）：同一 UV 边距在 256 与 1024 分辨率下都成立，避免「抬起的选中封面」与图集小图视觉错位（注释 `L33-34` 记录了这个 bug）。
5. **上传策略**：初始 `CanvasTexture`（选中封面路径，`L173-183`）走正常上传；图集更新走 **`renderer.copyTextureToTexture(tileCanvasTexture, page.texture, region, position)`**（`L334-346`）——只拷贝一个 tile 区域，**不重传整页**。若环境不支持 `copyTextureToTexture`（或为了 CPU 一致性），回退到手动 `getImageData` → 写 `page.texture.image.data` → `needsUpdate = true`（`L302-317, 348-360`）。
6. **逐实例 UV**：把 tile 在页内的像素坐标换算成 UV，写入 `InstancedBufferAttribute`（`writeTileUv` `L317-331`、`writePageTile` 同步页内 tile 数据）；材质用 `onBeforeCompile` 注入 `map` 采样（`mapAtlasTiles` `L203-218`），并设置 `customProgramCacheKey` 防止不同变体共享错程序（`L213`）。
7. **槽位分配**：`assignPageSlot` 维护 `slotKeys`/`slotTiles`，相同 key 直接复用，换封面时找未引用 tile，找不到就抛 `"Cover atlas page has no unreferenced tile for a new cover."`（`L364-400`，错误信息 `L381`）。
8. **诊断埋点**：`profilePhase("atlas-canvas-readback" | "atlas-texture-upload")`（`L310, 346`），在 `?profile=1` 下能看到「读回/上传」各花多少 ms；`scene.getCoverDiagnostics()`（`src/scene.ts:2084`）对外给出页/tile 使用情况。
9. **纹理翻转**：`CanvasTexture.flipY = true`（`L224`），而 `copyTextureToTexture` 路径要求目标 `flipY = false` 并手动翻转行序（`L350-356`）——这是整份代码里最容易踩的坑之一（WebGL 的纹理原点与 canvas 行序不一致）。

**复用建议**：如果 Zilux2 的封面墙也走 WebView2 + Three.js，这套「固定 tile 页 + 每实例 UV + 增量 copy」是成熟方案，可直接抄（MIT，注意保留版权声明）；若 Zilux2 用 WPF 原生 3D 或 Direct2D，思路仍然适用（纹理图集 + 引用/替换位）。

#### 3.5.8 歌词同步：解析器 + rAF 时钟 + 二分定位

解析器 `src/lyrics.ts`（62 行，可直接复用）：

- 去 BOM、按 `\r\n?|\n` 分行（`L17`）。
- `[offset:±ms]` 全局偏移：**扫描全部行、最后出现的生效**（`L18-25`），适用于文件头/文件尾都写 offset 的情况。
- 一行多个时间戳（`[00:12.00][00:30.00]歌词`）展开成多条（`L30-45`）。
- 小数位按长度换算：`fractionalSeconds = Number(v)/10**v.length`（`L10-13`），所以 `.5`、`.50`、`.500` 都正确。
- 去掉时间戳后再去掉其它 `[...]`（如 `[ar:...]`）标签，空行跳过（`L39-40`）。
- 行数上限 `MAX_LYRIC_LINES = 20_000`（`L6`），排序稳定：`time` 相同按原序（`L47-48`）。
- `activeLyricIndex(lines, t)` 二分找「最后一个 time ≤ t」的行，`-1` 表示尚未开始（`L52-62`）——O(log n)，每帧调用也不贵。

`syncLyricsPosition(currentTime)`（`src/music-app.ts:1519-1520`）用 `activeLyricIndex` 更新面板/歌词条高亮。

**时钟驱动**（`src/music-app.ts:1589-1605`）：

```ts
function syncLyricClock() {
  if (!playerState?.playing || !lyricLines.length || document.hidden) {   // L1590
    if (lyricClockFrame) cancelAnimationFrame(lyricClockFrame);
    lyricClockFrame = 0; return;
  }
  if (lyricClockFrame) return;
  const tick = () => {
    lyricClockFrame = 0;
    if (!playerState?.playing || !lyricLines.length || document.hidden) return;
    syncLyricsPosition(player.playbackTime);          // 用播放器平滑时间，而非 Date.now()
    lyricClockFrame = requestAnimationFrame(tick);
  };
  lyricClockFrame = requestAnimationFrame(tick);
}
document.addEventListener("visibilitychange", syncLyricClock);   // L1605
```

要点：①只在「播放中 + 有歌词 + 页面可见」时跑 rAF，暂停/隐藏即停（省电）；②时间基准是 `player.playbackTime`（内部取 `<audio>.currentTime`，`src/music-player.ts:105-110`），不是 `performance.now()`，避免暂停/seek 后漂移；③歌词行是真实 `<button>`（`data-action="seek-lyric"`，`src/music-app.ts:1487-1494`），可点击跳转、可键盘聚焦（无障碍）。

**边界**：Rhine 的歌词来源**只有「与音频同名的 .lrc」**（`music-server.mjs:18-37`），不支持内嵌 ID3 歌词、不支持 QRC/KRC/YRC、不联网搜词（grep `qrc|krc|yrc` 在 `src/` 与 `scripts/` 均 0 命中）。Zilux2 已有 QQ/网易云/酷狗歌词服务，Rhine 的解析器可作为「本地 LRC 兜底」与统一数据模型参考。

#### 3.5.9 播放器：双 `<audio>` + 定时器音量斜坡

`src/music-player.ts`（712 行）核心：

- 环境音 `bgm = new Audio("/audio/atmosphere.ogg")`，`preload="none"`、初始音量 0（`L86-90`）。
- 每首歌 `new Audio()`，`preload="metadata"`，`src = /api/audio/<id>`（`L390-395, 479`）。
- 播放/暂停用 `audio.play()`/`pause()` + promise 竞态保护（`L245-247`：play 失败/已切歌则 pause）。
- **淡入淡出不是 WebAudio，而是 `volume` 的 `setTimeout` 斜坡**：歌曲 16 ms 步进（`L518-542`），BGM 24 ms 步进、时长 650/220 ms（`L663-685`）。好处是简单、兼容性最好；坏处是主线程被占用时音阶不平滑（桌面壳里 rAF 忙时会出现）。
- `timeupdate` → `state.currentTime`（`L411-414`），`seek()` 有 clamp 与「元数据未到时暂存 pendingSeek」（`L484-499`）。
- **明确不做「后台暂停」**：注释 `// Intentionally no visibilitychange handler: music must continue in the background.`（`L93`）——桌面播放器该有的行为，WebView2 后台时音频不会被节流（Chromium 对后台 `<audio>` 仍播放）。
- 播放错误映射为可读错误（`L475-477`、`playbackError`）。

> 对 Zilux2 的启示：Rhine 证明了「页面内 `<audio>` + 本地 HTTP Range」足以支撑桌面播放器（含 seek/淡入淡出），但这套**没有**系统媒体控制/媒体键/任务栏缩略图 —— 这些正是 Zilux2 用 GSMTC + NAudio/LibVLC 要做的。两边可以互补：页面负责可视化与歌词，宿主负责播放与系统集成。

#### 3.5.10 主循环与启动编排（前端生命周期）

- 主循环 `frame(ms)`（`src/music-app.ts:2110-2190`）：`document.hidden` 时整帧跳过（`L2111, 2185-2188`）；否则 `boot.update` → `scene.update` → `viewer.update` → `presentation.update` → 文档解密动画 → 1.5 s 一次 HUD 刷新（`L2144`）→ `scene.recordProfileFrame`。
- `requestAnimationFrame(frame)` 恒定续帧（`L2189`），**没有自己的帧率上限**（BUILD-WINDOWS 也明令禁止用帧率上限伪造结果）。
- 启动 `start()`（`L2191-2243`）：先**注销所有 service worker**（`L2193-2197`，注释：本地应用拥有实时索引，旧 PWA 缓存不能服务过期 UI）→ `loadLibrary(true)` → `fit()` → `new ArchiveScene($("#three-scene"))` → 并发加载场景资源 + MiSans 字体（`document.fonts.load`，`L2205-2209`）→ `refreshLibrary` / `setTheme` / `setQuality` / `setReduced` → 绑定导航 → 移除 loading → 播开场或直接显示档案架（`L2223-2232`）→ 首帧 `requestAnimationFrame(frame)`。
- 启动失败：loading 区显示错误 + 「检查音乐库」按钮（`L2238-2242`）。

#### 3.5.11 这一层的失败模式与坑（给 Zilux2 的避坑清单）

| 坑 | 现象 | 证据 |
| --- | --- | --- |
| WebGL 上下文丢失未处理 | 驱动重置/休眠后画面黑屏，无重试/重建 | 全仓库无 `webglcontextlost` 监听（grep 无命中）→ 待确认是否在别处 |
| 软件渲染不降级 | SwiftShader/WARP 下仍跑 `original` 预设，可能个位数 FPS | `src/gpu-capability.ts:19-20` 只报告不决策；`src/music-app.ts:2192` 只写 dataset |
| 两套全屏状态不同步 | F11 与 HTML Fullscreen 叠加，Esc 退出后宿主状态仍是全屏 | `DesktopProgram.cs:1058-1077` vs `src/music-app.ts:1853-1858` |
| 纹理各向异性热切换卡顿 | `needsUpdate=true` 会重传纹理 | `src/quality-renderer.ts:33-37` |
| `copyTextureToTexture` 的 flipY | 图集局部更新后封面上下颠倒 | `src/cover-atlas.ts:224, 350-356` |
| 首帧前 `setPixelRatio` 与 `resizeQuality` 口径不同 | 场景构造用 `min(dpr,3)*min(w/1920,h/1080)`，正式 resize 用 `renderDimensions`，二者在启动瞬间可能不一致（随后被 setQuality→resize 纠正） | `src/scene.ts:191-194` vs `src/quality-renderer.ts:48-56` |

---

## 4. 可借鉴清单（面向 Zilux2：C# / .NET 10 / WPF + WebView2）

> 说明：Zilux2 是 WPF 原生应用（StripWindow 歌词条带、FanWindow 扇形浮层、PlayerWindow 播放页、WebView2 桌面歌词壁纸挂 WorkerW、LibVLC/WIC 动态壁纸、GSMTC、NAudio WASAPI 频谱、`%APPDATA%\Aurora\settings.json`）。Rhine 是 WinForms 宿主，**同为 C# 侧**，下列条目区分「可直接照搬进 WPF 宿主」「WinForms 专属需改写」「Web 侧可复用」，并标注与「WPF 原生表面 + WorkerW 桌面层」共存的注意点。

### P0（先做，收益最大/风险最高）

#### P0-1 本地 HTTP 数据面（WebView ↔ 宿主/曲库）—— **照思路重写（Node→C#）**
- **Rhine 机制**：`node:http` 单服务，只绑 `127.0.0.1`；Host/Origin 白名单；路由顺序 if；`realpath` 双重校验 + 曲库索引反查路径（URL 只暴露 id，不暴露路径）；Range 206 单段流式；`no-store` + `nosniff`；请求体 128 KiB 上限、30 s 超时。
- **Zilux2 落地**：不要引入 Node。用 **Kestrel 最小 API**（`WebApplication.CreateSlimBuilder`，`UseUrls("http://127.0.0.1:0")` 取随机端口后写进 WebView2 启动 URL）或 `HttpListener`（注意 http.sys 的 URL ACL 通常要管理员，故推荐 Kestrel）。把 `music-server.mjs` 的路由表（§3.3.2）逐条翻译成 Minimal API endpoint；`serveFile` 的 realpath 校验、`parseRange`、416 行为原样实现。
- **安全加强**（Rhine 的缺口）：启动时生成 **一次性 session token**，注入页面 URL（`?token=`）或 `Set-Cookie`（SameSite=Strict），所有 `/api/*` 校验；顺带加 CSP（`default-src 'self'`）。Zilux2 若有手机遥控/局域网投屏需求，token 是必需项。
- **复杂度**：M。**模块**：`Zilux2.Core/LocalApi`（Kestrel host + 路由 + 静态资源）+ `Zilux2.Core/Library`（索引/扫描/封面）。
- **WPF 注意**：Kestrel 与 WPF 生命周期解耦（`IHostedService`/`CancellationToken`），窗口关闭时优雅 `StopAsync`；不要用 `Application.Current.Dispatcher` 从请求线程碰 UI。

#### P0-2 WebView2 环境与数据目录策略 —— **可直接照搬（C# API 相同）**
- **Rhine 机制**：`CoreWebView2Environment.CreateAsync(null, userDataFolder, options)`；UDF 独立于程序版本目录（升级不丢缓存/localStorage）；默认不传 GPU flags；禁右键菜单；发布禁用 DevTools；`NewWindowRequested` 外链系统浏览器；`ProcessFailed` 仅诊断记录。
- **Zilux2 落地**：`%LOCALAPPDATA%\Aurora\WebView2`（或 `%APPDATA%\Aurora\webview-profile`）作为 UDF；**必须补**：`ProcessFailed` 生产也能恢复（重新创建 WebView2 或提示重启）、`DownloadStarting` 决策、`PermissionRequested` 默认拒绝、`AreBrowserAcceleratorKeysEnabled` 明确取舍（建议关，避免 F5/Ctrl+P 干扰）、`CoreWebView2InitializationCompleted` 里做版本/能力检测。
- **复杂度**：S。**模块**：`Zilux2.Desktop/WebViewHost`。
- **WPF 注意**：WPF 的 `Microsoft.Web.WebView2.Wpf.WebView2` 是 **HwndHost**，存在 **airspace（空域）问题**：任何 WPF 元素无法覆盖在其上；如需在 WebView 上方叠 WPF 浮层（FanWindow 扇形菜单），必须用**独立顶层窗口 + `AllowsTransparency`/`WindowChrome`**，或把浮层也做成 Web 内容，或改用 WebView2 的 `CoreWebView2Controller` + `SetParent` 自绘宿主。这是 Zilux2 设计「播放页（WebView）＋ WPF 原生控件」时必须先定的架构问题。

#### P0-3 单文件打包与版本化资源解压 —— **参考（改 .NET 10 发布方式）**
- **Rhine 机制**：`csc /resource:payload.zip` 单文件；`%LOCALAPPDATA%\Rhine Music\app-v<ver>` 版本目录 + `.payload-ready` 标记 + 关键文件校验 + zip-slip 防护；失败保留版本号、拒绝覆盖已有工件、发布后重算 SHA-256。
- **Zilux2 落地**：用 `dotnet publish -r win-x64 -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:EnableCompressionInSingleFile=true`；若仍需内嵌 Web 前端/额外资源，用 `Microsoft.Extensions.FileProviders.Embedded` 或自定义 `<EmbeddedResource>` + 首次解压到 `%LOCALAPPDATA%\Aurora\app-v<ver>`（沿用 marker + 关键文件校验 + zip-slip 校验的写法）；若继续带 Node 服务（不推荐），沿用 `CreateProcessW` 的句柄重定向/无窗口启动方案。
- **必须补**（Rhine 的坑）：版本升级时**检测并结束旧版本残留进程**（旧 `node`/旧服务），否则端口被占；解压前处理「文件被占用」；解压/启动期间显示 splash（WPF 可用独立启动窗口）。
- **复杂度**：M。**模块**：`Zilux2.Packaging`/`Zilux2.Desktop/Bootstrap`。

#### P0-4 进程/服务生命周期 —— **照思路重写（Node→C#，或自托管）**
- **Rhine 机制**：互斥量只覆盖启动期；端口健康探测三态（Free/Busy/Own）；`/api/health` 返回 `service+projectDir+pid` 做身份校验；子进程用 `CreateProcessW` 精确控制句柄；正常退出 `Kill`。
- **Zilux2 落地**（假定不再有独立 Node 进程）：用 **Job Object + 命名管道**做单实例与优雅关闭（`NamedPipeServerStream` 或 `MemoryMappedFile` + EventWaitHandle）；WebView 调试端口/本地 API 端口用**动态端口**写回；健康检查改为宿主内部状态，不需要 HTTP 探测。若 Zilux2 确实要拉 Node/LibVLC 子进程：`JobObject`（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`）保证宿主崩溃时子进程一起死；退出前 `CloseMainWindow`/`Terminate` 分级；日志重定向到 `%LOCALAPPDATA%\Aurora\logs`。
- **复杂度**：M。**模块**：`Zilux2.Desktop/SingleInstance`、`Zilux2.Desktop/ProcessSupervisor`。

#### P0-5 DPI 与全屏（WPF 版）—— **参考 + 改写**
- **Rhine 机制**：manifest `PerMonitorV2` + `SetProcessDpiAwarenessContext(-4)` 兜底；F11 状态机保存 `BorderStyle/Bounds/State`，`Screen.FromControl(this)` 取当前屏；先 `Normal` 再改 Bounds。
- **Zilux2 落地（WPF）**：
  - DPI：`.NET 10` 的 WPF 已支持 PerMonitorV2，manifest 里设 `dpiAwareness=PerMonitorV2` 即可；**不要**再调 WinForms 的 `SetProcessDPIAware`（会破坏 WPF 的 DPI 感知），改用 `SetProcessDpiAwarenessContext` 仅在需要时兜底（且必须在任何窗口创建前）。
  - 全屏：WPF 用 `WindowStyle=None` + `ResizeMode=NoResize` + `WindowState=Maximized`；若要覆盖任务栏，用 `WindowChrome` 或 P/Invoke `SetWindowPos` 到 `MonitorFromWindow` + `GetMonitorInfo` 的 **monitor rect（不是 work area）**；还原时保存 `WindowState`/`Left/Top/Width/Height`（DIP 单位）以及所在 monitor id；处理 `DpiChanged` 事件重算。
  - 多屏：Zilux2 有桌面歌词/壁纸，必须按 **monitor** 而不是 primary 处理；`WM_DPICHANGED` 时要重排 WorkerW/StripWindow。
- **复杂度**：S（单屏）/ M（多屏 + WorkerW）。**模块**：`Zilux2.Desktop/WindowState`。

#### P0-6 WebView2 与「WPF 原生表面 + WorkerW 桌面层」共存的注意点 —— **仅参考（Rhine 没有此场景，是 Zilux2 独有风险）
- Rhine 给不了直接代码，但它的「宿主只做壳」思路可以借鉴：把桌面歌词壁纸的 WebView2 做成**独立、无边框、不激活、点击穿透**的窗口，再 `SetParent` 到 WorkerW（`FindWindow("Progman", null)` → `SHELLDLL_DefView` → `WorkerW`），避免与 PlayerWindow 的 WebView2 混在一起。
- 关键约束（工程经验 + Rhine 间接印证）：

  1. **WebView2 无 per-pixel alpha**：桌面歌词壁纸若要透明/异形，需要在宿主窗口上做 `SetWindowRgn`/layered window，或让页面自己画不透明背景（Rhine 用 `DefaultBackgroundColor=#EAE5E1`，`DesktopProgram.cs:574`，没有透明需求）。
  2. **airspace**：WorkerW 上的 WebView2 是 HWND 子窗口，WPF 元素无法覆盖；桌面层与 PlayerWindow 必须是两个独立的视觉树/两个 WebView2 实例（Zilux2 若要「歌词从桌面层飞到播放页」，需要动画层单独实现，不能跨 HWND 合成）。
  3. **输入穿透**：桌面层窗口用 `WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW`，但 WebView2 子 HWND 自己会捕获鼠标——需要对子窗口也设置 `WS_EX_TRANSPARENT` 或使用 `SetWindowLong` + 消息钩子；否则点桌面会被 WebView2 吃掉。
  4. **DPI**：WorkerW 所在 monitor 的 DPI 与 PlayerWindow 可能不同；WebView2 的 DPR 由它所在 HWND 的 DPI 决定，`SetParent` 到 WorkerW 后要确认 DPI 上下文一致（否则页面 `devicePixelRatio` 与宿主布局对不上）。
  5. **GPU/合成**：同一个 `CoreWebView2Environment` 可被多个 WebView2 共享（进程复用）；但「桌面层 WebView2 + 播放页 WebView2」会各自占 GPU 上下文，低端机上要注意总显存（Rhine 只有一个 WebView2 + 一个 3D 场景）。
- **复杂度**：L。**模块**：`Zilux2.Desktop/DesktopLayer`、`Zilux2.Desktop/PlayerWindow`。

### P1（值得做，收益中高）

#### P1-1 LRC 解析与高亮时钟 —— **可直接用 MIT 代码（保留版权声明）**
- `src/lyrics.ts` 62 行：BOM、`[offset:]`（全文件扫描、最后生效）、多时间戳、小数按长度换算、20k 上限、稳定排序、二分定位。Zilux2 已有 QQ/网易云/酷狗歌词，可把它作为**本地同名 `.lrc` 兜底 + 统一 LyricLine 模型 + 二分定位**；`syncLyricClock` 的「只在播放+可见时跑 rAF、时间基准用播放器 currentTime、visibilitychange 停表」三个细节可直接搬（`src/music-app.ts:1589-1605`）。
- **复杂度**：S。**模块**：`Zilux2.Lyrics/LrcParser` + `LyricClock`。

#### P1-2 画质预设模型与像素上限 —— **照思路重写（TypeScript → C# 生成/或直接留在 Web 侧）**
- 9 个正交参数 + 4 预设 + `normalize` 白名单 + 三重像素上限（DPR/8.3MP/maxTextureSize）+ 后处理 2MP 上限（`src/render-quality.ts`）。
- Zilux2 若可视化页面也走 WebGL（Three.js/其他），可直接把 `render-quality.ts`（175 行，纯函数）搬进 Web 资产；若是 WPF 原生渲染（D3DImage/SharpDX），把「像素上限」思路用于 RT 尺寸决策。
- **复杂度**：S。**模块**：`Zilux2.Visualization/RenderQuality`。

#### P1-3 封面图集（固定 tile 页 + 每实例 UV + 增量上传）—— **可直接用 MIT 代码（Three.js 依赖）**
- 见 §3.5.7。若 Zilux2 的封面墙走 WebView2 + Three.js，这是成熟方案；若走 WPF 原生，可借鉴「图集 + 引用计数槽位 + 增量 update」的数据结构。
- **复杂度**：L（Web 侧直接复用则 M）。**模块**：`Zilux2.Visualization/CoverAtlas`。

#### P1-4 帧/GPU 诊断与验收纪律 —— **照思路重写**
- `FrameProfiler`（GPU timer query、每 6 帧采样、p95/p99、长任务、切歌 15s 窗口）+ `dataset` 证据 + 「rAF 不是帧率」的诚实标注。Zilux2 的性能验收建议：WPF 侧用 `PresentMon`/ETW + WebView2 的 `profile-capture.jsonl`，**把「实际 back buffer 尺寸 + 实际显示帧间隔」作为发布门槛**（可照抄 `BUILD-WINDOWS.md:38-40` 的验收条款）。
- **复杂度**：M。**模块**：`Zilux2.Diagnostics`。

#### P1-5 GPU 能力探测与软件渲染降级 —— **照思路重写（Web 侧探测 → WebMessage 回报宿主）**
- `probeGpuCapability()`（独立 canvas + `WEBGL_debug_renderer_info` + `loseContext` + SwiftShader/WARP 识别）。Zilux2 的 WebView2 页面内探测后，用 **WebMessage** 把 `{api, renderer, mode, maxTextureSize}` 报给宿主，宿主据此决定是否降画质/提示；软件渲染时自动切低预设（Rhine 缺这一步）。
- **复杂度**：S。**模块**：`Zilux2.Visualization/GpuProbe` + `Zilux2.Desktop/WebBridge`。

#### P1-6 曲库扫描/索引的工程纪律 —— **参考**
- 指纹增量（size+mtime）、`METADATA_VERSION`、**先枚举后替换**（避免权限失败被当成删除）、根目录离线标记、原子写 + 串行 `saveChain`、封面提取缓存（sha256 文件 + 版本号 URL）、`browserPlayable` 白名单。Zilux2 的曲库来源不同（本地文件/GSMTC/歌词缓存），但「增量 + 原子 + 离线容错 + 版本号缓存失效」四条通用。
- **复杂度**：L。**模块**：`Zilux2.Library/IndexStore`。

### P2（可选/长期）

| # | 模式 | 复杂度 | 借鉴方式 | 说明 |
| --- | --- | --- | --- | --- |
| P2-1 | 设置持久化分层：前端 `localStorage`（`rhine-music-preferences`）+ 后端 `config.json` | S | 仅参考 | Zilux2 统一到 `%APPDATA%\Aurora\settings.json` 更合适；但要意识到 WebView2 的 `localStorage` 存在 UDF 里，清缓存会丢 —— 建议只存 UI 临时态，业务设置走宿主 |
| P2-2 | 在线资料「礼貌爬取」：UA 带联系方式、≥1100 ms 限速、15 s 超时、失败保留本地数据 | S | 仅参考 | Zilux2 接歌词 API 时同样应节流 + 明确 UA + 失败兜底 |
| P2-3 | 打包脚本的版本号预留/拒绝覆盖/哈希复核三道闸 | S | 可直接用（PowerShell 改写） | 与语言无关的发布纪律 |
| P2-4 | 诊断模式：环境变量开关 + JSONL + 截图 + `dataset` 证据 | M | 照思路重写 | 与 P1-4 配套 |
| P2-5 | 启动期 splash/加载态（Rhine 只有 Web 侧 loading，无原生 splash） | S | 仅参考 | Zilux2 解压/启动可能更慢（.NET 10 自包含），值得做原生 splash |
| P2-6 | 无障碍：歌词行是真实 button、tab 焦点循环、`aria-description` 性能摘要 | S | 照思路重写 | WPF 侧对应 AutomationProperties + 焦点管理 |

### 不建议照抄的部分

| 项 | 原因 |
| --- | --- |
| `.NET Framework 4.6.2 + csc.exe` 构建 | Zilux2 已定 .NET 10；收益（无 SDK）远小于代价（无 single-file publish/trim/现代 API） |
| 固定端口段 5175–5184 + 5173 | 多实例/升级残留会互抢；改用动态端口 + 单实例管道 |
| 「不传任何 WebView2 GPU flag」 | 安全默认可以，但 Zilux2 4K 场景需要显式策略（探测 + 降级 + 上报），不能只靠 `powerPreference` |
| 无 Job Object 的子进程管理 | 崩溃留孤儿；Zilux2 必须补 |
| 无 WebMessage 桥、纯 HTTP | Zilux2 需要 GSMTC/媒体键/托盘/WPF 原生联动，必须双向桥 |
| 素材（`public/assets/*.glb`、字体、图标、PV 采样） | 非 MIT，见 §1.1；只能用作观感参考 |

---

## 5. 与 Folia / Mineradio 的差异观察（范围说明）

> **本节范围声明**：我（Rhine 分析师）只静态阅读了 Rhine 这一份仓库（`research/repos/rhine`），**没有**读 Folia / Mineradio 的源码，因此不做具体代码级对比；以下仅给「基于 Rhine 结构、等队友报告出来后用于交叉核对」的观察点，避免编造：
>
> 1. **宿主形态**：Rhine 是「WinForms 薄壳 + 本地 Node + Web 前端」三层；若 Folia/Mineradio 是 Electron/Tauri 或纯原生，则「单文件 Exe + 解压 payload」这套只有 Rhine 需要（Electron 自带 runtime 打包，Tauri 依赖 WebView2）。
> 2. **WebView2 用法**：Rhine 用 Evergreen + 真实 loopback HTTP，不用虚拟主机；Electron 系项目通常是 `file://` + 自定义协议，安全模型不同（CSP/导航限制更严格）。
> 3. **播放与系统集成**：Rhine 播放全在页面 `<audio>`，无 SMTC/媒体键/托盘；Zilux2 的 GSMTC + NAudio WASAPI 是另一个层级，可以和 Rhine 的「Web 可视化」互补。
> 4. **3D 与性能**：Rhine 的「实例化 + 封面图集 + 像素上限 + GPU timer 诊断」是它最有辨识度的部分；若另两个项目是 2D 可视化，这部分不可横向比较。
> 5. **歌词**：Rhine 只支持同名 LRC（无联网、无 QRC/KRC/YRC）；Zilux2 已有多源歌词服务，正好补足。
>
> 待 汇总三份报告后，建议按「宿主形态 / WebView 安全模型 / 播放与系统集成 / 渲染与诊断 / 歌词来源」五个维度做一张对比表（本报告 §3 的事实足以填 Rhine 一列）。

---

## 6. 关键文件索引

| 主题 | 文件:行号 | 说明 |
| --- | --- | --- |
| 宿主启动 | `DesktopProgram.cs:55-70` | `Main [STAThread]`、DPI、异常兜底 |
| 版本/目录 | `DesktopProgram.cs:43-53` | `ProductRoot/AppRoot/DataRoot`、`RHINE_HOME` |
| 资源解压 | `DesktopProgram.cs:149-205` | marker、关键文件校验、zip-slip |
| 端口探测 | `DesktopProgram.cs:214-280` | Probe 三态 / `/api/health` / TcpListener |
| 服务启动 | `DesktopProgram.cs:296-356` | `CreateProcessW`、日志句柄、`MUSIC_DATA_DIR` |
| 服务退出 | `DesktopProgram.cs:411-419` | `Process.Kill()`（仅自己拉起的） |
| 窗口/WebView2 | `DesktopProgram.cs:544-667` | 默认尺寸、F11、环境/设置、NewWindow、诊断 |
| 全屏 | `DesktopProgram.cs:1058-1077` | 保存/恢复状态机 |
| DPI | `app.manifest:15-22`、`DesktopProgram.cs:422-433` | manifest + API 兜底 |
| `WebView2` UDF | `DesktopProgram.cs:409` | `music-data-v3\webview-profile` |
| 打包 | `scripts/build-windows.ps1:139-157,170-214` | esbuild/payload/csc/SHA256 |
| 本地服务 | `scripts/music-server.mjs:108-242` | 路由表/安全/静态 |
| Range/文件 | `scripts/music-server.mjs:59-106` | `parseRange`/`serveFile` |
| 歌词读取 | `scripts/music-server.mjs:18-37` | 同名 LRC + realpath/1MiB |
| 曲库索引 | `scripts/music-library.mjs:355-563` | snapshot/scan/readAlbum/封面 |
| 扫描遍历 | `scripts/music-library.mjs:121-149` | walkAlbums（单曲/专辑/封面偏好） |
| 歌单 | `scripts/playlists.mjs:54-181` | UUID/原子写/重排 |
| 前端请求 | `src/music-app.ts:507-524` | `request()` 唯一入口 |
| 偏好 | `src/music-app.ts:81-150` | localStorage + 画质归一化 |
| 歌词 UI | `src/music-app.ts:1443-1605` | loadLyrics/renderLyricRows/时钟 |
| 画质切换 | `src/music-app.ts:1607-1617` | `updateQuality` → `scene.setQuality` |
| 主循环 | `src/music-app.ts:2110-2190` | rAF / HUD / profile |
| 启动 | `src/music-app.ts:2191-2243` | SW 注销/场景/字体/首帧 |
| 诊断导出 | `src/music-app.ts:2245-2276` | `window.rhineMusic` |
| 画质模型 | `src/render-quality.ts:2-175` | 9 参数/4 预设/像素上限/normalize |
| 画质应用 | `src/quality-renderer.ts:12-90` | 纹理各向异性/尺寸/合成器 |
| GPU 探测 | `src/gpu-capability.ts:1-27` | 独立 context + loseContext |
| 帧诊断 | `src/frame-profiler.ts:19-231` | GPU query/longtask/p95/p99 |
| 场景骨架 | `src/scene.ts:174-270` | renderer/阴影/合成器/相机 |
| 画质接入 | `src/scene.ts:798-836` | setQuality |
| 图集接入 | `src/scene.ts:426-465` | InstancedMesh + CoverAtlas |
| 封面图集 | `src/cover-atlas.ts:32-400` | tile 页/UV/增量上传 |
| LRC 解析 | `src/lyrics.ts:6-62` | 解析 + 二分定位 |
| 播放器 | `src/music-player.ts:86-542` | 双 `<audio>` + 音量斜坡 |
| 构建纪律 | `BUILD-WINDOWS.md:38-40` | 4K/PresentMon 验收条款 |

---

## 7. 未解问题 / 待确认

1. **无 git commit**：本地为 tarball，无法核对本报告行号对应哪个提交；版本以 `0.6.0-dev.57` 标识（`version.json:6`）。
2. **`?desktop=1` 无消费点**：`DesktopProgram.cs:398` 传入，但 `src/` 内 grep `desktop` 只命中 `viewport-layout.ts:20` 的布局类型；是遗留参数还是预留行为，**待确认**。
3. **`renderer.transmissionResolutionScale`**：`src/quality-renderer.ts:60-65` 在 Three.js r183 的 `WebGLRenderer` 上写这个属性，但材质侧如何消费未在质量模块中体现（应在 `music-model.ts`/材质定义里）；它是否为 Three 原生 API 还是项目补丁，**待确认**。
4. **WebGL 上下文丢失**：全仓库未见 `webglcontextlost/webglcontextrestored` 处理（grep 无命中），驱动重置/休眠恢复后的表现**待确认**（可能黑屏且无恢复）。
5. **WebView2 渲染进程崩溃**：`ProcessFailed` 只在 `RHINE_PROFILE_CAPTURE=1` 时记录（`DesktopProgram.cs:619-629`），生产环境无恢复逻辑（页面可能白屏）——实际表现**待确认**。
6. **HTML Fullscreen 与 F11 叠加**：两者无状态同步（见 §3.4.3），实际交互**待运行验证**。
7. **下载/权限请求默认行为**：未处理 `DownloadStarting`/`PermissionRequested`，WebView2 默认行为随 Runtime 版本可能不同，**待确认**（页面本身没有下载入口，风险低）。
8. **node 子进程无 Job Object**：宿主崩溃后 node 存活；升级到新版本目录后旧版本服务仍占用端口 → 新版本首次启动会报「没有可用端口」（`DesktopProgram.cs:120-124`）。这是**代码可推断的真实失败模式**，未运行验证。
9. **大曲库扫描性能**：`walkAlbums` 串行递归 + `music-metadata` 解析（可缓存），未见并发/限流；上千专辑的实际耗时**未测**。
10. **`?stress=N` 的消费点**：`DesktopProgram.cs:403-407` 注入，前端 `?stress` 消费逻辑未逐一核实（可能在 `src/data.ts`/`demo-library.ts`），**待确认**。
11. **UNMASKED_RENDERER 在 WebView2 中是否始终可用**：`WEBGL_debug_renderer_info` 在部分环境被禁用，`probeGpuCapability` 会返回空 renderer/`unknown`（`gpu-capability.ts:18-20`）——实际 WebView2 表现**待确认**。
12. **`app.manifest` 的 `supportedOS` GUID**：`8e0f7a12-…a15a9a` 是 Win10/11 通用 GUID，但 manifest 未声明 Win8.1 等；对最低系统版本的实际要求以 README「Win10/11」为准（`README.md:9`）。
13. **字体渲染**：MiSans 以 `public/fonts` 随包分发（`NOTICE.md:38`），页面用 `document.fonts.load` 等待（`src/music-app.ts:2205-2209`）；字体许可限制「不得作为独立字体包发布」——Zilux2 不要直接复用该字体文件，除非同样接受 MiSans 协议。
14. **本报告未覆盖**：档案（非音乐）界面 `archive-main.ts`/`boot.ts`/`model-viewer.ts` 的动效与相机系统、`audio.ts` 的 WebAudio 合成细节、`public/assets` 体积与加载策略、`scripts/check-*.mjs` 的回归测试设计。这些与 Zilux2 直接相关性较低，如需可另开专题。

---

*报告完。所有 `file:line` 均基于本地快照静态阅读；标注「待确认」的条目建议在真机运行后复核。*
