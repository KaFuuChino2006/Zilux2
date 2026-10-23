# Zilux2 Mac 引擎（在线音乐回环 HTTP 服务）

把 Windows 宿主（WPF + WebView2）里的「在线音乐回环 HTTP 服务」`src/Zilux2/Online/**` 移植成一个可独立运行的
跨平台 .NET 控制台程序：在 `127.0.0.1` 上监听一个动态端口，对外提供 `/api/*` 在线音乐接口 + `web/dist` 前端静态文件。

- **Windows 版代码一行不改**：本项目通过 `<Compile Include="../../src/Zilux2/Online/**/*.cs" ...>` 只读复用源码；
  `src/`、`web/`、`dist/` 全部保持原样。
- 同一份代码产出两个平台的产物：`win-x64`（Windows 联调/冒烟用）与 `osx-arm64`（Apple Silicon 测试版）。
- 本引擎只负责「后端 HTTP 服务」；Electron 外壳由 `mac/shell/`（另一任务）负责，打包由 `mac/packaging/` 负责。

## 目录内容

```
mac/engine/
├── Zilux2MacEngine.csproj   # net10.0 Exe，无 WPF/WebView2/NAudio/Windows TFM
├── Program.cs               # 入口：参数解析、READY 握手、stdin/信号优雅退出
├── MacLocalMusicServer.cs   # ← 由 LocalMusicServer.cs 生成：去掉 WPF 取色，加静态文件服务
├── MacAccountStore.cs       # ← 由 AccountStore.cs 生成：Windows 用 DPAPI，其它平台用 AES-GCM
├── tools/
│   ├── port_sources.py      # 从 src/ 只读源码确定性生成上面两个 Mac*.cs（可重复执行）
│   └── smoke_win.sh         # win-x64 冒烟脚本（curl）
├── publish/
│   ├── win-x64/             # self-contained 产物（Zilux2MacEngine.exe）
│   └── osx-arm64/           # self-contained 产物（Zilux2MacEngine）
└── README.md
```

两个 `Mac*.cs` 是生成的：需要同步上游改动时执行

```bash
python mac/engine/tools/port_sources.py
```

脚本对每个改写点都有断言（marker 必须恰好命中一次），上游 `LocalMusicServer.cs` / `AccountStore.cs` 改动导致
marker 失配时会直接报错而不是悄悄产出错误文件。

## 前置

- .NET SDK 10.0.4xx（本仓库实测 `E:\dotnet\dotnet.exe`，SDK `10.0.401`）。目标平台机器不需要装 .NET 运行时（self-contained）。

## 构建

```bash
# 普通构建（本机平台）
E:/dotnet/dotnet.exe build mac/engine/Zilux2MacEngine.csproj -c Release

# Windows 联调版
E:/dotnet/dotnet.exe publish mac/engine/Zilux2MacEngine.csproj \
    -c Release -r win-x64 --self-contained true -o mac/engine/publish/win-x64

# Apple Silicon 测试版
E:/dotnet/dotnet.exe publish mac/engine/Zilux2MacEngine.csproj \
    -c Release -r osx-arm64 --self-contained true -o mac/engine/publish/osx-arm64
```

实测产物（2026-10，SDK 10.0.401）：

| 平台 | 文件数 | 体积 | 入口 |
| --- | --- | --- | --- |
| win-x64 | 193 | 78 MB | `mac/engine/publish/win-x64/Zilux2MacEngine.exe` |
| osx-arm64 | 192 | 84 MB | `mac/engine/publish/osx-arm64/Zilux2MacEngine` |

> `osx-arm64` 产物里会出现 `System.Security.Cryptography.ProtectedData.dll`（NuGet 包随包分发），
> 但 macOS 运行时的 DPAPI 调用路径被 `OperatingSystem.IsWindows()` + `[SupportedOSPlatform("windows")]` 隔离，
> 正常启动不会执行到，不会抛 `PlatformNotSupportedException`。

## 运行

```bash
# Windows
mac/engine/publish/win-x64/Zilux2MacEngine.exe --web-root web/dist

# macOS（Apple Silicon）
mac/engine/publish/osx-arm64/Zilux2MacEngine --web-root web/dist
```

- `--web-root <dir>` / `--web-root=<dir>`：**必填**，web 前端产物目录（`web/dist`）。目录不存在 → 退出码 2。
  缺 `index.html` 不算致命错误（只写日志，静态首页 404）。
- 启动成功后 **stdout 只有一行**：

  ```
  ZILUX2_READY {"port":54787,"token":"<32位hex>","sources":["netease","qq","kugou"]}
  ```

- 失败时 **stderr 一行**，退出码非 0：

  ```
  ZILUX2_ERROR {"error":"bad-arguments","message":"缺少 --web-root <dir> 参数（web 前端产物目录）"}
  ```

  `error` 取值：`bad-arguments`（退出码 2）、`bad-web-root`（2）、`start-failed`（1）、`engine-failed`（1）。
- 退出方式（均优雅退出、退出码 0）：stdin 读到 **EOF**、stdin 收到 `quit` / `exit` 行、`SIGTERM` / `SIGINT` / `SIGHUP`、Ctrl+C。
  Electron 侧直接关闭子进程 stdin 管道即可让引擎退出。
- 日志写在 `%LOCALAPPDATA%/Zilux2/logs/host.log`（macOS 为 `~/Library/Application Support/Zilux2/logs/host.log`），
  **不污染 stdout/stderr**。

环境变量（沿用原宿主行为）：

| 变量 | 作用 |
| --- | --- |
| `ZILUX2_ONLINE_TOKEN` | 固定本机 API token（32 位 hex）；不设则随机生成 |
| `ZILUX2_ACCOUNT_PATH` | 账号文件路径；默认 `HostFolders.Root/account.json` |
| `ZILUX2_ONLINE_PROXY` | 上游请求走系统代理；默认直连 |

## HTTP 接口

`/api/*` 全部要求 `?token=<token>`（`FixedTimeEquals` 比较），缺失/错误 → `401 {"error":"unauthorized",...}`；
非 GET/POST（HEAD 仅用于静态文件）→ 405；未知接口 → `404 {"error":"not-found"}`。

可用接口（与 Windows 宿主完全一致）：`/api/health`、`/api/sources`、`/api/search`、`/api/lyric`、`/api/stream`、
`/api/stream/info`、`/api/cover`、`/api/cover/colors`、`/api/playlists/hot`、`/api/account*`、
`/api/library/*`（overview / playlist / feed / recent / refresh / liked / like / unlike）。

- 搜索参数沿用原契约，是 **`q`** 而不是 `keyword`（`web/src/online/client.ts` 的 `api('/api/search', { source, q: keyword, limit })`）。
  `?keyword=...` 会返回 `400 {"error":"bad-request","message":"q 参数长度必须在 1..100"}`。
- `/api/cover/colors` 在 Mac 引擎里**固定返回空结果** `{"dominant":null,"palette":[]}`（原实现用 WPF 位图解码取色；
  前端已有 fallback，不影响使用）。
- `/api/stream` / `/api/cover` 是本地回环代理：上游 URL 由 API 返回、客户端再带 token 回来取流，不是公网代理。

## 静态文件服务

同一个端口顺带提供 `--web-root` 目录（web 前端产物），无需 token：

- `/` → `index.html`；目录路径回落 `index.html`；
- MIME：html/htm、js/mjs、css、json、map、ttf/otf/woff/woff2、png/jpg/jpeg/webp、svg、ico、txt；
- `index.html` / `*.js` / `*.mjs` 响应 `Cache-Control: no-store`（避免升级后拿到旧前端），其余 `public, max-age=3600`；
- 支持 `HEAD`（200 且无 body）；
- 防路径穿越：`Uri.UnescapeDataString` 解码后 `Path.GetFullPath`，结果必须仍在 web-root 前缀内，
  越界返回 `404 not found`；读取失败同理。

## 冒烟

```bash
bash mac/engine/tools/smoke_win.sh
```

脚本会启动 `publish/win-x64` 的引擎（用 `sleep` 撑住 stdin，结束后自然 EOF 退出），逐项 curl 校验，
最后打印 `SMOKE RESULT: PASS`。实测（win-x64）：

| 检查 | 结果 |
| --- | --- |
| `/api/health` | 200 `{"ok":true,"version":1,"sources":["netease","qq","kugou"]}`（58 B） |
| `/api/sources` | 200，netease/qq/kugou 完整元数据（1377 B） |
| `/api/search?source=netease&limit=5&q=周杰伦` | 200，真实上游结果（2249 B），命中「想你 就写信 (Live)」周杰伦 |
| `/api/search?keyword=周杰伦` | 400（契约参数是 `q`） |
| 静态 `/` | 200 `text/html`，index.html 正常（460 B） |
| `/assets/*.js`、`/fonts/*.ttf` | 200 `text/javascript` / `font/ttf` |
| 路径穿越 `/%2e%2e/%2e%2e/package.json` | 404 `not found` |
| `HEAD /` | 200，`size_download=0` |
| `/api/nope` / 无 token `/api/search` | 404 JSON / 401 JSON |
| stdin EOF、stdin `quit` | 退出码 0，stdout 仍只有 1 行 READY |
| 缺 `--web-root` | 退出码 2 + `ZILUX2_ERROR {"error":"bad-arguments",...}` |

## 已知限制 / 与 Windows 版的差异

1. **无封面取色**：`/api/cover/colors` 返回 `{"dominant":null,"palette":[]}`（原实现依赖 WPF `BitmapDecoder`）；
   前端有 fallback 配色。若要恢复，需要在 mac 侧用 `SkiaSharp`/`ImageSharp` 重写 `ComputeCoverColors`。
2. **无本地音乐库**：Windows 宿主里本地曲库/扫描/播放是 WPF 侧的服务，不在 `src/Zilux2/Online/**`；本引擎只含在线音乐部分，
   `/api/library/*` 是「在线账号的收藏/歌单/最近播放」，不涉及本地文件库。
3. **无 AirPlay**：Windows 版也没有（原宿主无此能力），不作为移植缺口。
4. **osx-arm64 产物尚未在真实 Apple Silicon 机器上启动验证**（当前构建环境是 Windows x64）：已确认 publish 成功、
   产物结构与 win-x64 一致、平台相关代码分支（DPAPI）被隔离；首次在 mac 上运行时如遇问题请回传 `ZILUX2_ERROR` 行与 `host.log`。
5. **账号 cookie 加密方式不同**：Windows 沿用 DPAPI（与原宿主 `account.json` 兼容）；macOS 用 AES-GCM（`aesgcm:` 前缀），
   密钥 32 B 存 `HostFolders.Root/account.key`（chmod 0600）。mac 上读到 Windows 的 DPAPI 格式会按「未登录」降级，
   需要重新扫码登录。
6. **仅监听 127.0.0.1**（沿用原实现），不做公网暴露；token 每次启动随机（除非显式设置 `ZILUX2_ONLINE_TOKEN`）。
7. 需要真实外网才能搜索/取流；上游接口可用性不受本项目控制。
