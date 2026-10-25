# Zilux2 首个里程碑（启动界面 + 首页）工程契约 v1

日期：2026-10-18　｜　状态：开发中

## 1. 仓库布局

```
E:\Zilux2开发\
  web\                     前端（Vite + TypeScript + three.js）—— Lead 负责
    index.html
    src\...
    package.json
  src\Zilux2\              WPF 宿主（.NET 10）—— host-dev 负责
    Zilux2.csproj
    App.xaml / App.xaml.cs
    MainWindow.xaml / MainWindow.xaml.cs
    app.manifest
  tools\                   构建/运行脚本 —— host-dev 负责
    build.ps1
    run.ps1
  docs\                    报告与契约（本文件）
  research\                三项目调研资料
```

**写入边界**：host-dev 只写 `src/Zilux2/**` 与 `tools/**`；Lead 只写 `web/**` 与 `docs/**`。双方都不改对方目录。

## 2. 本机构建环境（已实测）

| 项 | 值 |
| --- | --- |
| .NET SDK | `E:\dotnet\dotnet.exe`，SDK 10.0.401（`global.json` 已固定） |
| 必设环境变量 | `DOTNET_CLI_HOME=E:\aurora-toolchain\clihome`；`NUGET_PACKAGES=E:\aurora-toolchain\nuget` |
| WebView2 NuGet | `Microsoft.Web.WebView2 1.0.4191.47`（已在 NuGet 缓存） |
| WebView2 Runtime | 已安装 `155.0.4283.60` |
| Node / pnpm | `C:\Users\13329\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`（v24.21.0）；pnpm 用 `node <...>\pnpm\bin\pnpm.mjs`（11.28.5） |
| 屏幕 | 3440×1440（首页按超宽屏设计，最小窗口 1100×700） |

**离线构建**：NuGet 缓存里已有 WebView2 包，正常 restore 不应访问网络；若 restore 想联网，用 `--source "E:\aurora-toolchain\nuget" --ignore-failed-sources` 或 `--no-restore`（先成功过一次后用）。

## 3. 宿主行为规格

### 3.1 窗口

- 无边框沉浸式：`WindowStyle="None"` + `WindowChrome`（`CaptionHeight=0`、`GlassFrameThickness=0`、`ResizeBorderThickness=6`、`CornerRadius=0`），可拖拽边缘缩放（最小 1100×700）。
- 启动尺寸 1600×960，居中；背景 `#07080B`。
- 不做系统标题栏；窗口最小化/最大化/关闭由页面按钮通过消息触发（拖拽见 3.4）。
- 最大化状态变化要推给页面；DPI 用 Per-Monitor V2（`app.manifest`）。

### 3.2 WebView2

- 用户数据目录：`%LOCALAPPDATA%\Zilux2\WebView2`（不要放程序目录）。
- 环境参数（与 Zilux v1 一致，避免窗口不可见时被 Chromium 节流）：
  `--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling --disable-backgrounding-occluded-windows --disable-background-timer-throttling --disable-renderer-backgrounding --autoplay-policy=no-user-gesture-required`
- Settings：默认右键菜单关闭、状态栏关闭；**开发模式**（`ZILUX2_DEV=1`）打开 DevTools 与浏览器加速键（F12 / F5），发布默认关闭。
- `CoreWebView2InitializationCompleted` 后注册 `WebMessageReceived`、`ProcessFailed`。
- `ProcessFailed`：记日志，并尝试重新初始化一次 WebView2（重载页面）；失败则显示错误提示，不崩溃。

### 3.3 加载策略（按优先级）

1. 环境变量 `ZILUX2_DEV_URL` 有值（如 `http://localhost:5173`）→ 直接导航该 URL（开发用）。
2. 环境变量 `ZILUX2_WEB_DIR` 有值 → 把该目录映射为虚拟主机并导航。
3. 否则 `<exe 所在目录>\web`（`web/dist` 的拷贝，由 csproj/tools 脚本处理）→ 映射。
4. 都不存在 → 弹 MessageBox 提示缺前端产物并退出（不要白屏）。

映射方式：`SetVirtualHostNameToFolderMapping("zilux2.local", dir, CoreWebView2HostResourceAccessKind.Allow)`，导航 `https://zilux2.local/index.html`。

### 3.4 消息协议 v1（页内 `window.chrome.webview.postMessage(obj)`，C# 收到 JSON 字符串）

页面 → 宿主：

```jsonc
{"v":1,"type":"ready"}
{"v":1,"type":"window","action":"minimize" | "toggleMaximize" | "close"}
{"v":1,"type":"window","action":"miniMode","enabled":true|false,"width":420,"height":120}  // 迷你播放器（§15）
{"v":1,"type":"drag"}                       // 页面在无边框标题区 pointerdown 时发；宿主用 ReleaseCapture+WM_NCLBUTTONDOWN(HTCAPTION) 进入系统拖拽
{"v":1,"type":"log","level":"info"|"warn"|"error","message":"..."}
```

宿主 → 页面（`PostWebMessageAsJson`）：

```jsonc
{"v":1,"type":"host","event":"ready","version":"0.1.0","maximized":false}
{"v":1,"type":"host","event":"windowState","maximized":false}
{"v":1,"type":"window","event":"miniMode","enabled":false}   // 迷你播放器状态（§15）
```

约定：未知 `type` 忽略；单条消息 ≤ 64KB；不使用 `AddHostObjectToScript`；页面在非 WebView2 环境（浏览器直开）必须也能工作（`bridge.ts` 自动降级）。

### 3.5 日志

- 位置 `%LOCALAPPDATA%\Zilux2\logs\host.log`（追加，带时间戳）。
- 记录：启动、WebView2 环境创建、导航开始/完成、消息异常、ProcessFailed、窗口状态变化。
- 页面 `log` 消息也落盘（`web:` 前缀）。

## 4. 构建与运行

```powershell
# 构建（tools\build.ps1 内部做这件事）
$env:DOTNET_CLI_HOME='E:\aurora-toolchain\clihome'
$env:NUGET_PACKAGES='E:\aurora-toolchain\nuget'
& E:\dotnet\dotnet.exe build src\Zilux2\Zilux2.csproj -c Debug

# 运行
& E:\dotnet\dotnet.exe run --project src\Zilux2\Zilux2.csproj --no-build
# 或直接跑 bin\Debug\net10.0-windows10.0.19041.0\Zilux2.exe
```

`tools/build.ps1` 参数：`-Configuration Debug|Release`、`-WebDir <路径>`（可选，把前端 dist 拷到输出目录）、`-SkipRestore`。
`tools/run.ps1`：构建后启动并注入 `ZILUX2_DEV_URL`（若参数给了 `-DevUrl`）。

## 5. 验收（host-dev 自测）

1. `dotnet build` 成功（0 error；warning 可有）。
2. 进程能启动并存活 ≥5 秒；日志出现 `navigation starting/completed`。
3. 无前端产物时：`ZILUX2_WEB_DIR=src\Zilux2\_devtest`（自建一个带按钮的占位 html）能显示页面。
4. 页面发 `window/close` 能退出；`window/toggleMaximize` 生效并回推 `windowState`。
5. 无边框窗口：拖动标题区能移动窗口（用页面发 `drag` 消息验证）。
6. 不修改 `web/`；不改 `docs/` 其他文件。

## 6. 非目标（本里程碑不做）

音频播放、媒体库、GSMTC、桌面歌词条带、WorkerW、设置持久化、托盘、安装器、单文件发布。

## 10. 附加：宿主音频特征流（audio event v1）

为 3D 歌词舞台 / PV 画面 / 歌单架提供音频驱动：宿主用 WASAPI loopback 采集当前默认输出设备的系统播放声音，本地计算特征后推给页面。纯本地，不上传任何数据，页面不依赖 WebAudio（避免交叉源限制）。

### 10.1 消息格式（host → page）

```json
{"v":1,"type":"host","event":"audio","payload":{"bins":[0.000,...],"bands":[0.000,...],"level":0.123,"peak":0.456,"beat":false}}
```

- `bins`: `number[64]`，0..1，对数频段（40 Hz – 16 kHz），3 位小数。
- `bands`: `number[8]`，0..1，近似频段能量，边界 60 / 120 / 250 / 500 / 1k / 2k / 4k / 8k+ Hz。
- `level`: 整体 RMS 0..1；`peak`: 峰值保持（缓慢衰减）0..1。
- `beat`: `boolean`，低频能量突增检测，冷却约 320 ms。
- 固定 30 Hz（实现可配 20–60 Hz）；单条消息实测 < 600 B。页面负载高时帧会被丢弃而不是排队（宁少勿延迟）。
- 页面收到的新鲜度：宿主在 `ready` 之后才开始推；页面导航/关闭时停止。

### 10.2 开关与降级

- 设置项 `playback.audioReactive`（boolean，默认 `true`）加入 settings 快照与 patch 白名单；关闭后宿主不采集、不推送。
- 窗口最小化时暂停采集与推送（恢复后自动继续）。
- 当前实现不感知“是否正在播放”（播放器在页面内），页面按需忽略静音帧即可；无声音时推送的是衰减到 0 的静音帧。
- 无默认输出设备 / WASAPI 初始化失败 / 设备被拔出：`[audio] loopback unavailable: ...` 警告并每 5 s 重试，应用不受影响；此时无 audio 帧。
- 关闭进程/窗口时释放采集客户端（日志 `[audio] loopback stopped`、`[audio] disposed`）。

### 10.3 页面侧建议

收到 `audio` 消息后用 `requestAnimationFrame` 消费“最新一帧 + 平滑插值”，不要在消息回调里做重计算；`bins` 适合频段柱/表面位移，`bands` 适合整体氛围，`beat` 用于脉冲/镜头切换。前端接入由 web-dev/visual-dev 负责。


## 11. 附加：Windows Now Playing / SMTC（media event v1）

宿主通过 WinRT `Windows.Media.SystemMediaTransportControls`（`SystemMediaTransportControlsInterop.GetForWindow`）把页面播放状态上报给 Windows「正在播放」浮层与锁屏，并把系统媒体键/浮层按钮转发给页面。不新增 NuGet，不依赖前端改动即可工作；页面只负责「告诉我放什么」。

### 11.1 页面 → 宿主：`media`

```json
{"v":1,"type":"media","payload":{"title":"晴天","artist":"周杰伦","album":"叶惠美","coverUrl":"data:image/png;base64,...","durationMs":269000,"positionMs":42000,"playing":true}}
```

- `title` / `artist` / `album`：字符串，可缺失，宿主截断到 256 字符。
- `coverUrl`：可选。支持 `data:image/...;base64,`、绝对 `http(s)` URL，或本机回环相对路径 `/api/cover?...`（宿主自动补 `token=`）。宿主 3 s 超时、5 MB 上限，任何失败只丢封面。
- `durationMs` / `positionMs`：整数毫秒；非法/非有限值按 0 处理，`positionMs` 会被钳到 `[0, durationMs]`。
- `playing`：布尔；缺失视为 `false`。
- 频率：建议 ≤10 次/秒（宿主内部按 100 ms 合并，以最后一次为准）。页面应在播放/暂停/切歌时发送，播放中可每 1–2 s 补一次进度。
- 未知字段忽略；`payload` 不是对象时忽略并记警告。

### 11.2 宿主 → 页面：`mediaControl`

```json
{"v":1,"type":"host","event":"mediaControl","payload":{"action":"play"}}
{"v":1,"type":"host","event":"mediaControl","payload":{"action":"seek","positionMs":61000}}
```

- `action`：`play` | `pause` | `next` | `prev` | `stop` | `seek`。
- `seek` 带 `positionMs`（整数毫秒，取自系统浮层进度条拖动）。
- 页面未 ready 时宿主丢弃该消息并记 `[smtc] mediaControl dropped`，不会排队补发。

### 11.3 宿主行为

- 页面首次 `ready` 后初始化 SMTC（`[smtc] enabled`）；最小化/失焦不关闭会话。
- 元数据映射到 `DisplayUpdater.MusicProperties`；`PlaybackStatus` 随 `playing` 在 `Playing` / `Paused` 间切换；`TimelineProperties` 使用 `StartTime=0`、`EndTime=duration`。
- 覆盖应用退出：`PlaybackStatus=Closed`、`DisplayUpdater.ClearAll()`、`IsEnabled=false`，避免在系统浮层留下指向已退出进程的幽灵条目。
- 日志前缀 `[smtc]`：`enabled` / `state` / `cover updated` / `control pressed` / `seek requested` / `disabled`。

### 11.4 降级

WinRT 不可用或初始化失败时记一次 `[smtc] unavailable: <类型>: <消息>`；此时没有「正在播放」集成，但页面照常运行、media 消息被安全忽略、媒体键不转发，退出不受影响。封面加载失败只记 `[smtc] cover failed` / `[smtc] cover skipped`。


## 12. 附加：AirPlay / RAOP 投送（airplay 命令 & airplay event v1）

宿主把**当前默认输出设备的系统声音**（WASAPI loopback）实时编码为 ALAC，经 AirPlay/RAOP 投送到局域网里的 Apple 设备（HomePod、Apple TV、AirPort Express、Mac「隔空播放接收器」等）。本机播放不受影响（声音同时从本机与远端设备出来）；纯局域网直连，不经过云端，不上传任何内容。

### 12.1 页面 → 宿主：`airplay`

```jsonc
{"v":1,"type":"airplay","action":"scan"}                  // 开始/刷新发现（持续 8 s，可重复调用刷新）
{"v":1,"type":"airplay","action":"stopScan"}              // 停止发现
{"v":1,"type":"airplay","action":"connect","deviceId":"<id>"}
{"v":1,"type":"airplay","action":"connect","deviceId":"<id>","password":"<密码>"}
{"v":1,"type":"airplay","action":"disconnect"}
{"v":1,"type":"airplay","action":"disconnect","deviceId":"<id>"}
{"v":1,"type":"airplay","action":"pin","deviceId":"<id>","value":"1234"}
{"v":1,"type":"airplay","action":"volume","percent":0-100}
```

- `deviceId`：设备发现返回的 `id` 原样回传；未知 id 忽略并记 `[airplay] connect ignored: unknown device`。
- `connect` 可重复调用：已 `streaming` 时对另一台设备 `connect` 会把该设备**追加**到同一采集管线与包时间线（共享音频与时钟），`actives` 长度随之增加；对已在投送的设备重复 `connect` 是幂等的。
- `disconnect` 不带 `deviceId` 断开全部；带 `deviceId` 只断开那一台，其余继续播放。
- `password`：可选。设备需要密码但未提供时，宿主以 `state:"error"` + `code:"passwordRequired"` 回报，页面弹密码输入后带 `password` 重发 `connect`。
- `pin`：可选。macOS「隔空播放接收器」要求 HAP PIN 配对（拒绝瞬态配对）：宿主连接时以 `state:"connecting"` + `code:"pinRequired"` 回报，Mac 屏幕同时显示 4 位数字；页面收集后发 `pin`，宿主用它完成配对并继续连接。等待超过 120 秒自动失败（`code:"network"`）。首次配对成功后凭据落盘，后续连接走 pair-verify，不再弹 PIN。
- `volume`：0–100 的整数，超出范围钳制，作用于所有正在投送的设备；未连接时忽略并记日志。
- 未知 action 忽略；`payload` 缺失按空对象处理。

### 12.2 宿主 → 页面：`airplay`

```jsonc
{"v":1,"type":"host","event":"airplay","payload":{
  "state":"idle|scanning|connecting|streaming|error",
  "devices":[{"id":"...","name":"客厅 HomePod","host":"192.168.1.23","model":"AudioAccessory5,1","requiresPassword":true,"airPlay2":true}],
  "actives":[{"id":"...","name":"客厅 HomePod","volume":70}],
  "active":{"id":"...","name":"客厅 HomePod","volume":70},
  "code":"passwordRequired|pinRequired|unsupported|busy|network|capture|internal",
  "error":"人类可读的错误描述"
}}
```

- `devices`：仅在 `scanning` 状态或扫描结束时出现，最多 32 台，按名称排序；`state` 非 scanning 时可省略。
- `actives`：当前所有正在投送的设备（`streaming` 时非空，多设备同时投送时长度 > 1），最多 32 台。`volume` 为全局音量的 0–100。
- `active`：`actives` 的第一个元素，保留给只理解单设备字段的旧页面；`streaming` 时为对象，`idle`/`error` 时为 `null`。
- `code`：在 `state:"error"` 时出现（`passwordRequired`/`unsupported`/`network`/`capture`/`internal`），也在 `state:"connecting"` + `code:"pinRequired"` 时出现（macOS 接收器等待 4 位配对码）；页面据此决定提示文案/是否显示密码框或配对码输入框；`error` 为中文可读文本（≤200 字），可直接展示。多设备投送时第二台失败也走 `error` 字段但 `state` 保持 `streaming`，页面据 `devices`/`actives` 差异提示即可。
- 推送时机：`scan` 后进入 `scanning`（设备变化时推送，最多 5 次/秒）；`connect` 成功 → `streaming`（同一会话再次 `connect` 另一台设备只追加 `actives`）；断开/失败 → `idle`/`error`；`volume` 改变后回推一次。
- 单条消息 ≤ 8 KB。

### 12.3 宿主行为与降级

- 发现使用 BCL 自带 UDP 组播（`_raop._tcp.local` 与 `_airplay._tcp.local`，5353 端口），不依赖 Bonjour/iTunes 安装；无网卡或防火墙拦截时只是扫不到设备，应用不受影响。
- 传输按设备二选一：设备在 TXT 里声明支持 AirPlay 2（`vv=1` 或 `srcvers≥130`）且 AP2 传输可用时，先走 AirPlay 2 加密会话；失败则自动回退经典 RAOP，不向页面报告错误。
  - **AirPlay 2**：HAP 瞬态配对（SRP-3072/SHA-512，设备侧固定 PIN `3939`，无需用户输入）→ 整条 TCP 字节流切 HAP 帧加密 → `GET /info` → 两段式 `SETUP`（会话级 / 流级，binary plist，含 `shk`）→ 事件通道 → `RECORD`；时间基准为 **PTP 主时钟**（本机在 UDP 319/320 扮演 master，接收端为 slave，`timingProtocol:"PTP"` + `timingPeerInfo`，每 100 ms 发一次 sync `0xD7`）；音频为 **未压缩 ALAC 帧**（`ct=2`、`audioFormat=1<<18`，接收端无视 ct 按 ALAC 解码）经 ChaCha20-Poly1305 加密后走 UDP，12 B RTP 头（首包 marker）+ 16 B tag + 8 B nonce，固定 125 包/秒；接收端缓冲 `latencyMin=latencyMax=300 ms`（120 ms 在 Wi-Fi 抖动下仍有偶发杂音）；支持 `0x55`/`0xD6` 音频重传（保留最近 1024 包）。
  - **macOS「隔空播放接收器」**：同样走 AirPlay 2，但拒绝瞬态配对（HTTP 470），必须用 HAP PIN 配对：`pair-pin-start` → Mac 屏幕显示 4 位 PIN → `pair-setup`（SRP-3072）→ `pair-verify`；宿主把长期凭据写入 `%LOCALAPPDATA%\Zilux2\airplay\pairing\<host>.hap`，之后连接先用凭据 pair-verify（无提示），失败或被设备撤销时再回退 PIN。配对与音频链路与上面几台 HomePod 相同。
  - **经典 RAOP**：TCP/7000 RTSP（OPTIONS → ANNOUNCE → SETUP → RECORD）→ UDP 音频包 + Sync/Timing/Resend。
  - 两条传输都伪装 User-Agent `iTunes/12.12.10 (Windows; Microsoft Windows 10 x64)`（部分接收端按 UA 白名单拒绝）。
- 两条传输都失败时：`403`/需要配对 → `code:"unsupported"` 并提示该设备需要 AirPlay 2 配对；连接/超时 → `code:"network"`。页面无需区分传输类型。
- 采集失败（无默认输出设备 / WASAPI 错误）→ `code:"capture"`，每 5 s 重试一次，应用不退出。
- 窗口最小化/页面关闭时停止投送并 TEARDOWN，避免设备端残留会话；退出应用前 `AirPlay` 服务先于 `Settings` 释放。
- 日志前缀 `[airplay]`：`scan start` / `scan stop` / `found N` / `connect <host>` / `streaming started` / `volume <dB>` / `teardown` / `error: <...>`。
## 13. 附加：更新通道（update 命令 & update event v1）

页面 → 宿主：

```json
{ "v": 1, "type": "update", "action": "check", "force": true }
{ "v": 1, "type": "update", "action": "download" }
{ "v": 1, "type": "update", "action": "install" }
{ "v": 1, "type": "update", "action": "cancel" }
{ "v": 1, "type": "update", "action": "openReleasePage" }
```

- `action`：`check`（检查，`force:true` 跳过 60s 节流）/ `download` / `install` / `cancel` / `openReleasePage`。

宿主 → 页面（快照推送）：

```json
{ "v": 1, "type": "host", "event": "update", "state": "available",
  "currentVersion": "1.0.0", "latestVersion": "1.0.1", "releaseName": "...",
  "notes": "...", "pageUrl": "...", "assetName": "Zilux2-Setup-1.0.1.exe",
  "assetSize": 13055679, "downloaded": 0, "total": 13055679, "error": null,
  "notice": null, "mode": "auto", "autoCheck": true, "repo": "owner/repo",
  "canAutoInstall": true, "checkedAt": "2026-10-23T10:00:00Z" }
```

- `state` ∈ `idle` / `checking` / `up-to-date` / `available` / `downloading` / `downloaded` / `installing` / `error` / `unavailable`。
- 页面 `ready` 后宿主立即推送一次当前快照，此后任何状态变化都推送完整快照。
- 详细字段、宿主行为（下载目录 / digest 校验 / 安装参数）、设置字段与发版流程见 `docs/zilux2-update-channel.md`；设置字段见 `docs/zilux2-settings-contract.md` §2。


## 14. 附加：在线下载队列控制（download control v1）

> 2026-10-25 新增；前端调用方 `web/src/ui/downloadQueue.ts`。队列只存在宿主内存里，不跨进程持久化。

### 14.1 端点总览

所有端点都在在线服务回环地址（`http://127.0.0.1:<port>`）上，与既有 `/api/download` 同一鉴权：query 必须带 `token=<Endpoint.Token>`（由 `online` host 消息下发）。

| 方法 | 路径 | body | 成功响应 | 说明 |
| --- | --- | --- | --- | --- |
| GET | `/api/downloads` | — | `{"directory":"D:\\Music","jobs":[DownloadJob...]}` | 队列快照（按 startedAt 倒序，最多 30 条） |
| POST | `/api/download` | `{"source","trackId","title","artist","quality"}` | `{"directory":"...","job":{...}}` | 新建下载（已有） |
| POST | `/api/download/pause` | `{"id":"<jobId>"}` | `{"ok":true}` | 暂停（保留 received/total） |
| POST | `/api/download/resume` | `{"id":"<jobId>"}` | `{"ok":true}` | 继续 |
| POST | `/api/download/cancel` | `{"id":"<jobId>"}` | `{"ok":true}` | 取消单任务（列表项保留，state=error、error="已取消"） |
| POST | `/api/download/clear` | — | `{"ok":true,"cleared":<n>}` | 把 done/error 任务移出内存列表，**不删磁盘文件** |
| POST | `/api/download/reveal` | `{"id":"<jobId>"}` | `{"ok":true}` | 资源管理器选中已完成文件（已有） |

`DownloadJob` 字段：`id` / `source` / `trackId` / `title` / `artist` / `quality` / `state` / `received` / `total` / `fileName` / `path?` / `error?` / `startedAt`。
其中 `state` ∈ `running` / `paused` / `done` / `error`；`paused` 时 `received`/`total` 保留，前端据此显示进度与「继续 / 取消」按钮。

### 14.2 错误

- token 缺失/错误：`401 {"error":"unauthorized","message":"缺少或无效的 token"}`
- 宿主未启用下载服务：`501 {"error":"unsupported","message":"当前宿主没有启用下载"}`
- 请求体缺失 / 非法 JSON / `id` 为空：`400 {"error":"bad-request","message":"..."}`
- 找不到任务或任务已结束（pause / resume / cancel）：`404 {"error":"not-found","message":"找不到该下载任务或任务已结束"}`
- 前端按「HTTP 4xx/5xx + `error` 字段」统一 toast。

### 14.3 行为与限制

- 暂停：下载循环在每个读/写块之间等待恢复信号，暂停期间不继续写盘；磁盘上保留 `.part`，恢复后继续写同一文件。
- 取消：任务从 running/paused 变为 error（`error:"已取消"`），`.part` 被删除；已完成的文件不会被删。
- 清空已完成：只清内存列表（最多保留 40 条，超出时按 startedAt 淘汰最旧的已完成项）；磁盘文件始终保留。
- 宿主重启后列表为空，未完成的 `.part` 不会自动续传（降级：v1 不支持断点续传）。
- 日志前缀 `[download]`：`paused` / `resumed` / `canceled` / `cleared N finished jobs`。


## 15. 附加：迷你播放器模式（window.miniMode v1）

页面 → 宿主（复用 §3.4 的 `window` 消息通道）：

```jsonc
{"v":1,"type":"window","action":"miniMode","enabled":true,"width":420,"height":120}
{"v":1,"type":"window","action":"miniMode","enabled":false}
```

- `enabled` 必填（布尔）；`width` / `height` 可选（DIP 浮点，缺省 420×120；宽度钳到 360–1600，高度 100–900）。
- 开启：宿主保存当前窗口 rect / WindowState / Topmost / MinWidth / MinHeight，切到紧凑尺寸（临时把 MinWidth 降到 360）、置顶、吸附到当前显示器工作区右下角（安全边距 12 DIP），保持无边框圆角与 6 px 可缩放边条。
- 关闭：按保存值精确还原尺寸/位置/最大化状态/Topmost，并恢复原 MinWidth/MinHeight。
- 切换成功后宿主 → 页面：

```jsonc
{"v":1,"type":"window","event":"miniMode","enabled":true}
```

- 同一状态重复发指令是幂等的（只补推一次事件）；页面 `ready` 时若宿主正处于 mini 态，宿主会立即补推一次 `enabled:true`（页面导航回来后据此渲染迷你布局）。
- 过渡动画：开启 / 关闭现在带窗口补间动画（开启 320ms、关闭 380ms，EaseInOutCubic，与最大化 / 还原同一套 `BeginWindowMotion` 逐帧 SetWindowPos）；动画**结束落位后**才写 `_miniMode` 并回推 `window.miniMode` 事件，页面可据此在动画期间挂过渡态 class、结束后再切最终迷你布局。动画期间再次切换会先 `StopWindowMotion` 再执行新指令。
- mini 态下 §3.4 的 `drag`（标题栏拖拽）与 `resize`（边缘缩放）仍可用；页面自行渲染迷你布局并留出可拖拽区域（建议顶部整条 `drag` 热区）。
- 日志：`window.animate mini entering from=.. to=..` / `window.animate mini exiting from=.. to=..`（动画开始）、`window.miniMode enabled rect=.. size=.. margin=..` / `window.miniMode disabled restored=.. state=..`（动画结束落位）。
- 降级：窗口尚未创建（hwnd=0）时宿主改用 WPF 的 Left/Top/Width/Height 兜底；没有任何可还原 rect 时退回普通状态。从最大化状态退出迷你态时退化为即时落位（不补间），避免与最大化还原动画抢占。


## 16. 附加：本地曲目标签写入（/api/local/tag v1）

`POST /api/local/tag?token=<token>`（UTF-8 JSON body ≤ 32KB）：

```json
{"rel":"@downloads/晴天.mp3","title":"晴天","artist":"周杰伦","album":"叶惠美","albumArtist":"周杰伦","track":3,"year":2003}
```

- `rel`（必填）：本地曲库相对路径，与 `/api/local/*` 的 `rel` 同源（`LocalMusicService.ResolveTrackPath`：普通曲库相对路径或 `@downloads/` 前缀）。
- `title` / `artist` / `album` / `albumArtist`：字符串，可省略（=不改该字段）；`null` 或 `""` =清空该字段；其他类型忽略（不改）。
- `track` / `year`：数字（也接受数字字符串与 `null`）；其他类型 → 400。
- 至少给一个要写的字段，否则 400。
- 写入使用 Windows Property System（`SHGetPropertyStoreFromParsingName` + `IPropertyStore.SetValue/Commit`），属性：`System.Title`、`System.Music.Artist`、`System.Music.AlbumTitle`、`System.Music.AlbumArtist`、`System.Music.TrackNumber`、`System.Media.Year`。**不写封面**（v1 降级）。
- 成功后回读 6 个字段、`SHChangeNotify` 通知资源管理器，并让宿主刷新曲库缓存/视图：

```json
{"ok":true,"fields":{"title":"晴天","artist":"周杰伦","album":"叶惠美","albumArtist":"周杰伦","track":3,"year":2003}}
```

- 文件存在但属性系统写不了（格式无标签处理器、只读、被占用等）：HTTP 200 + `{"ok":false,"error":"提交标签失败（0x80070021）：文件可能只读、正在被占用或格式不支持写入"}`，页面直接 toast `error`。
- `rel` 解析不到或文件不存在：`404 {"error":"not-found","message":"找不到本地曲目文件"}`；请求非法：`400 {"error":"bad-request",...}`；token 错：`401`；宿主未接入本地曲库：`501`。
- 格式支持取决于系统属性处理器：MP3 / FLAC / M4A(AAC/ALAC) / WAV 一般可写；DSF / APE / OGG / OPUS / WMA / AIFF 可能失败（返回上面的 `ok:false`）。
- 日志前缀 `[tag]`：`wrote <文件名>` / `refreshed track ...` / `resolve failed ...`。

