# Zilux2 for macOS（Apple Silicon 测试版）

一套**不改动 Windows 版任何代码**的 macOS 移植：用一个 Electron 壳承载现有 `web/dist` 前端，
用一个跨平台 .NET 控制台引擎托管原本由 WPF 宿主提供的在线音乐 HTTP 服务。

```
mac/
├─ engine/      .NET 10 控制台引擎（只读复用 src/Zilux2/Online/**，去掉 WPF/WebView2/NAudio）
├─ shell/       Electron 主进程 + preload（手写，无 npm 依赖；polyfill window.chrome.webview）
├─ packaging/   zip 级组装 Zilux2.app 的脚本（保留符号链接/可执行位），应用图标生成
├─ cache/       下载的官方 Electron 二进制（darwin-arm64 / win32-x64）
├─ build/       Windows 联调用的解压目录与截图（临时产物，可删）
└─ README.md    本文件
```

## 为什么这样做

Windows 版的页面通过 `window.chrome.webview` 与 WPF/WebView2 宿主通信，在线音乐数据则由
`src/Zilux2/Online/**` 里的 `HttpListener` 在 `127.0.0.1` 上提供。macOS 上没有 WebView2/WPF，
所以：

1. **引擎**：把 `Online/**` 原样编译进一个 `net10.0` 控制台程序（排除 WPF 的 `LocalMusicServer.cs`
   和 DPAPI 的 `AccountStore.cs`，用生成的等价实现替换），对外仍然是同一套 `/api/*`；
   同时顺带托管 `web/dist` 静态文件，页面与 API 同源（`http://127.0.0.1:<port>`）。
2. **壳**：Electron 主进程 spawn 引擎、等 `ZILUX2_READY` 拿到端口，然后加载同源页面；
   preload 里定义 `window.chrome.webview`（postMessage / addEventListener），
   主进程按 `web/src/core/bridge.ts` 的协议回 `ready / online / settings / fonts / airplay / window` 等消息。
3. **打包**：在 Windows 上直接读官方 darwin-arm64 的 Electron zip，做 zip 级重组（`Electron.app/`
   → `Zilux2.app/`、改写 Info.plist、追加 `Resources/{app,web,engine}`），这样 mac 包里的
   符号链接与可执行位不会丢，不需要 macOS 工具链。

## 构建步骤（Windows 上即可完成）

```bash
# 0) 准备：.NET SDK 10、Python 3（Pillow）、官方 Electron zip（见 mac/cache/）

# 1) 引擎：交叉发布 Apple Silicon 自包含产物
E:/dotnet/dotnet.exe publish mac/engine/Zilux2MacEngine.csproj \
    -c Release -r osx-arm64 --self-contained true -o mac/engine/publish/osx-arm64

# 2) 前端：构建（与 Windows 版同一份产物）
cd web && node ./node_modules/vite/bin/vite.js build

# 3) 图标（可选，已生成 zilux2.icns）
python mac/packaging/make_icon.py

# 4) 组装 .app 并打 zip
python mac/packaging/assemble.py \
    --electron-zip mac/cache/electron-v33.2.1-darwin-arm64.zip \
    --shell-dir mac/shell \
    --web-dir web/dist \
    --engine-dir mac/engine/publish/osx-arm64 \
    --out-zip research/mac-dist/Zilux2-1.0.0-arm64.zip \
    --version 1.0.0 \
    --readme mac/packaging/README-mac.txt \
    --icon-icns mac/packaging/zilux2.icns
```

## 在 Windows 上怎么验证壳

用官方 win32-x64 Electron 解压出 `electron.exe`，把 `mac/shell/{main.js,preload.js,package.json}`
放进 `resources/app/`，同目录带 `engine/`（win-x64 发布）与 `web/`（`web/dist`），
然后 `electron.exe --remote-debugging-port=9335`，用 CDP 脚本走「首页 → 播放 → 歌词 → 房间」。
参考 `mac/shell/dev/` 与 `mac/shell/scripts/`。

## 已知限制

- 未签名/未公证：首次打开需要 `xattr -dr com.apple.quarantine` 或右键「打开」。
- 无 AirPlay（前端入口由壳注入 CSS/脚本隐藏）、无本地音乐库、无封面取色、无 SMTC。
- 引擎是 Windows 上交叉编译的 osx-arm64 产物，尚未在真实 Apple Silicon 上启动验证。
- 账号需在 mac 上重新登录（Windows 的 DPAPI 凭据无法复用）。

## 交付物

`research/mac-dist/Zilux2-1.0.0-arm64.zip` + `research/mac-dist/README.txt`（安装说明与 SHA256）。
