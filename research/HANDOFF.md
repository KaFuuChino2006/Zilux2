# Zilux2 上下文交接（HANDOFF）

> 更新时间：2026-10-23（更新通道 v1.0.0 完成）
> 当前版本：**1.0.0**（唯一来源：根目录 `Directory.Build.props`；安装包 `dist/Zilux2-Setup-1.0.0.exe`）
> 本文件给下一个接手的 AI / 开发者：读完即可继续开发。

## 1. 项目是什么

Zilux2 是一个 Windows 桌面音乐播放器：

- **宿主**：`src/Zilux2`（.NET 10 WPF + WebView2），负责窗口、WebView2 容器、本地音乐库扫描/标签读取/封面提取、在线 API 代理（本地 HttpListener）、下载、设置持久化、窗口动画、mac 壳的遗留代码。
- **前端**：`web/`（Vite 7 + TypeScript 5.9 + 原生 DOM 渲染，播放器页面、歌词/房间效果、发现页、设置面板）。
- **资源**：播放音频直接在 Chromium `<audio>` 中播放；在线音频由宿主代理 `/api/stream` 转发并支持 Range。

## 2. 目录结构（要点）

```
E:\Zilux2开发\
├─ src/Zilux2/                  # WPF 宿主
│  ├─ WebViewHost.cs            # WebView2 消息桥 / 虚拟主机 / 页面加载
│  ├─ MainWindow.xaml.cs        # 窗口、动画（应用内/系统原生）
│  ├─ Online/
│  │  ├─ LocalMusicServer.cs    # ★ 本地 HTTP API（/api/*），所有在线能力路由
│  │  ├─ OnlineMusicService.cs  # provider 注册、DownloadService 组装
│  │  ├─ DownloadService.cs     # 统一下载（网易云/QQ/酷狗/无名音乐）
│  │  ├─ Mvmp3Provider.cs       # 无名音乐（实验源）provider
│  │  ├─ Mvmp3Cache.cs          # 实验源后台缓存（下载目录下 mvmp3-cache）
│  │  └─ Discover/              # 发现页后端（10 个 /api/discover/*）
│  ├─ Local/
│  │  ├─ LocalMusicService.cs   # 本地曲库扫描、下载合并、删除/显示/打开目录
│  │  └─ LocalTagReader.cs      # 本地音频标签读取（ID3/FLAC/MP4/OGG/WAV）
│  ├─ Settings/                 # settings.json 持久化（SettingsModel/Service/Bridge）
│  └─ Updates/                  # GitHub Releases 更新通道（UpdateService）
├─ web/                         # 前端
│  ├─ src/ui/                   # 页面与组件（含 updates.ts 更新 UI）
│  ├─ src/online/               # 在线 API client / discover / download
│  └─ dist/                     # 前端构建产物（vite build）
├─ tools/
│  ├─ publish.ps1               # 发布宿主到 dist/Zilux2（-SkipWebBuild -Version -UpdateRepo）
│  ├─ make-installer.ps1        # 打安装包 dist/Zilux2-Setup-<版本>.exe（-Version 缺省读 props）
│  └─ release.ps1               # 一键发版：构建 + 安装包 + tag + push（-DryRun 演练）
├─ .github/workflows/release.yml # CI：tag v* 触发，构建并发布 GitHub Release
├─ Directory.Build.props        # ★ 版本号与默认更新源的唯一来源
└─ research/                    # QA 脚本、截图、专项文档（不要当源码）
```

## 3. 构建 / 发布 / 安装（固定流程）

```powershell
# 1) 前端构建（含 tsc 类型检查）
cd web
node ./node_modules/vite/bin/vite.js build        # 或 npx tsc --noEmit && vite build

# 2) 宿主构建
E:/dotnet/dotnet.exe build src/Zilux2/Zilux2.csproj -v q --nologo

# 3) 发布宿主（先关掉正在运行的程序）
taskkill /IM Zilux2.exe /F
powershell -File tools/publish.ps1 -SkipWebBuild

# 4) 打安装包（版本号来自 Directory.Build.props，可用 -Version 覆盖）
powershell -File tools/make-installer.ps1 -Version 1.0.0
# 产物：dist/Zilux2-Setup-1.0.0.exe

# 5) 静默安装并启动（安装目录 %LOCALAPPDATA%\Programs\Zilux2）
dist/Zilux2-Setup-1.0.0.exe --silent --no-shortcuts

# 6) 发版（先改 Directory.Build.props 的 <Version>；构建 + 安装包 + 打 tag v<ver> + push）
powershell -File tools/release.ps1 -DryRun   # 演练；去掉 -DryRun 真发版
```

> 注意：
> - 只改了前端时可不动宿主：构建 web 后把 `web/dist/assets`、`web/dist/index.html` 复制到 `dist/Zilux2/web/` 和 `%LOCALAPPDATA%\Programs\Zilux2\web/`，重启程序即可。
> - bash 里写环境变量 `$LOCALAPPDATA`（`%LOCALAPPDATA%` 不会展开）；写路径含中文/空格时用引号。
> - 改 C# 后必须 `publish.ps1` 再重启；不要只重启旧 exe。

## 4. 真机 QA（CDP）

- 启动带远程调试：
  ```powershell
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9223'
  Start-Process "$env:LOCALAPPDATA\Programs\Zilux2\Zilux2.exe"
  ```
- 脚本模式：`http://127.0.0.1:9223/json/list` → 找 `url` 以 `https://zilux2.local` 开头的 page → WebSocket → `Runtime.evaluate` / `Page.captureScreenshot`。
- 脚本集合：`research/tmp/qa-*.mjs`（每个功能一份，可直接改目标断言复用）。
- 经验：
  - 快捷设置按钮（`.pb-quick`、房间设置按钮等）用**页面内 JS `.click()`**；CDP 真实鼠标点击经常打不开/点错。
  - 播放条进度条 `.pb-progress .track` 需要**先 hover 播放条展开**再量 rect/发 pointer 事件。
  - 原生 `window.confirm` 会卡死渲染进程 → 一律使用应用内 `confirmDialog`。
  - `Page.reload` 偶发卡死（旧页面残留模态）→ 直接 taskkill 重启安装版更稳。
   - 抓「正在播放/即将播放」类过渡要 80–90ms 采样一次。
   - 更新通道 QA：本地起 mock GitHub API（`research/tmp/mock-updater.mjs`，默认 8765），启动应用时设 `ZILUX2_UPDATE_API=http://127.0.0.1:8765`、`ZILUX2_UPDATE_INSTALL_DIR=<QA 安装目录>`、`ZILUX2_SETTINGS_PATH=<临时 settings>`，即可走完整「检查→下载→安装→重启」；详见 `docs/zilux2-update-channel.md` §8。

## 5. 关键前端文件职责

| 文件 | 职责 |
| --- | --- |
| `src/ui/app.ts` | 主壳：页面切换（首页/搜索/发现/本地/我喜欢的/歌单/歌词）、快捷设置、播放条、事件绑定。（很大，改动集中看 buildXxx + syncXxx） |
| `src/ui/lyrics.ts` | 歌词页与效果模式（off/text/room）、歌词颜色 provider、is-covered 机制 |
| `src/ui/roomScene.ts` | ★ 房间场景（Canvas2D）：3D 投影、逐词 DOM、流星、粒子、地毯、背景渐变、相机 |
| `src/ui/roomSettings.ts` | 房间设置数据模型（RoomStyleSettings + 默认值 + localStorage `zilux2.roomStyle`） |
| `src/ui/roomSettingsPanel.ts` | 房间设置面板（九组：预设/文字/布局/背景/流星/粒子/地毯/镜头/动效） |
| `src/ui/upNextToast.ts` | 顶部「即将播放/正在播放」单框预告条（连续过渡、渐变倒计时） |
| `src/ui/songInfo.ts` | 歌曲信息两种形态（整页详情 / 列表内展开，设置可选） |
| `src/ui/keywords.ts` | 重点词（关键分词）提取，纯字/房间共用 |
| `src/ui/localArtists.ts` / `src/ui/local.ts` | 本地歌手聚合（歌手页）/ 本地曲库数据 |
| `src/ui/confirmDialog.ts` | 应用内确认弹窗（替代 `window.confirm`） |
| `src/ui/updates.ts` | 更新状态 store 与手动操作（设置页「更新」分区渲染） |
| `src/online/discover.ts` / `client.ts` / `download.ts` | 发现页 / 在线 API / 下载 API |
| `src/core/settings.ts`、`src/core/bridge.ts` | 设置模型与宿主消息桥 |

## 6. 关键宿主文件职责

| 文件 | 职责 |
| --- | --- |
| `Online/LocalMusicServer.cs` | ★ 所有 `/api/*` 路由（search/lyric/stream/cover/discover/downloads/account/library/artist/image…） |
| `Online/DownloadService.cs` | 下载任务（ResolveStreamAsync → .mp3/.flac 落盘，质量透传） |
| `Online/Mvmp3Provider.cs` / `Mvmp3Cache.cs` | 实验源搜索/取流 / 后台预取缓存 |
| `Online/Discover/DiscoverService.cs` | 发现页数据（网易云 + QQ，含评论/歌手图/歌曲信息） |
| `Local/LocalMusicService.cs` | 扫描本地目录、下载合并、删除（回收站）/在文件夹中显示/打开目录/刷新 |
| `Local/LocalTagReader.cs` | 标签读取（歌名/歌手/专辑） |
| `Settings/SettingsModel.cs` / `SettingsService.cs` | settings.json 字段（含 downloads/quality、windowAnimation 等）与校验 |
| `WebViewHost.cs` | 消息类型：ready/settings/window/drag/resize/log/media/audio/airplay/fonts/local/download/update |
| `Updates/UpdateService.cs` | 更新通道：GitHub Release 检查/下载/digest 校验/静默安装（设置 updates 段） |
| `MainWindow.xaml.cs` | 窗口动画（应用内快照 / 系统原生） |

## 7. 运行时数据目录

- `%LOCALAPPDATA%\Zilux2\settings.json` — 用户设置（含下载目录/音质/窗口动画/实验源开关等）
- `%LOCALAPPDATA%\Zilux2\account.json` — 网易云/QQ/酷狗 登录 cookie（DPAPI 加密）
- `%LOCALAPPDATA%\Zilux2\logs\host.log` — 宿主日志（含 `[online] listening on 127.0.0.1:<port>`、下载/扫描、`[update]` 更新日志）
- `%LOCALAPPDATA%\Zilux2\updates\` — 更新包下载缓存（digest 校验通过后用于安装）
- `%LOCALAPPDATA%\Zilux2\mvmp3-cache\` — 实验源缓存（如果下载目录为空则在此；默认已迁到下载目录 `mvmp3-cache`）
- 下载默认目录：`C:\Users\<user>\Music`（可在设置 → 下载 修改）
- 本地曲库扫描目录：设置 → 数据 → 本地歌曲文件夹

## 8. 当前状态

- 版本号统一由 `Directory.Build.props` 控制（当前 **1.0.0**）；`%LOCALAPPDATA%\Programs\Zilux2` 装的是最近一次构建（自动更新会改装到更新版本）。
- 更新通道（本窗口完成）：GitHub Releases 自动检查 → 后台下载 → 提示安装 → 静默安装并重启；设置页「更新」分区；GitHub Actions 自动发版。已用本地 mock Release 真机实测 1.0.0 → 1.0.1 全链路。
- 本窗口已完成：房间效果系列（歌词颜色跟随/流星/粒子 3D/自定义）、发现页全量能力、歌曲信息、本地标签歌手 + 歌手页、本地曲库管理、统一下载 + 音质、顶部预期条、首页双收藏卡、应用内确认框、窗口动画设置。
- 详细更新清单：`research/UPDATES-2026-10-23.md`。

## 9. 更新通道（GitHub Releases）

- 设计/协议/发版说明：`docs/zilux2-update-channel.md`；建仓与首发步骤：`docs/zilux2-github-setup.md`。
- 版本唯一来源：根目录 `Directory.Build.props` 的 `<Version>`（宿主/安装器继承；改它即改版本号）。
- 默认更新源：编译期注入 `ZiluxUpdateRepo`（默认占位 `zilux2/Zilux2`，CI 用 `github.repository` 覆盖）；运行时设置 `updates.repo` 可覆盖。
- 资产：`Zilux2-Setup-<version>.exe`；宿主下载到 `%LOCALAPPDATA%\Zilux2\updates\`，校验 GitHub `digest`（sha256）后以 `--silent --no-shortcuts --launch --dir <安装目录>` 静默安装并重启。
- 默认 `updates.mode="auto"`（自动下载+提示安装），可切 `"notify"`（只提示）；`updates.autoCheck` 控制启动检查 + 每 4 小时轮询。
- 发版：改 props 版本 → 提交 → `tools\release.ps1`（或 push tag `v<version>`，Actions 自动构建发布）。
- 仓库可见性：应用内更新走未认证 GitHub API，**只有公开仓库的 Release 可见**；开发期可先建私有仓库存代码（先不推 tag），要发布更新时把仓库切 public 再推 tag。客户端对 404 的提示为「仓库不存在、未公开，或还没发布 Release」。
- 注意：更新包未做代码签名（SmartScreen 会提示，属预期）。

## 10. 已知限制 / TODO

- QQ 搜索主接口偶发 500，回退备用接口会增加首次搜索耗时（约 10s）。
- QQ 会员曲目下载/播放受限（提示需要会员）。
- 匿名/失效 mvmp3 曲目 403（上游下架）。
- 房间效果为 Canvas2D + DOM，低配机可调低「渲染像素比」。
- 没有单元测试，回归依赖 CDP QA 脚本 + 截图；建议后续把关键 QA 固化成 `research/qa/` 下脚本。
- 后续可做：房间粒子/流星更多预设、歌词页多效果、本地音乐目录监控、下载队列 UI、更多平台能力。

## 11. 常用命令速查

```powershell
# 当前版本号（唯一来源）
Select-String '<Version>' Directory.Build.props

# 看宿主日志
Get-Content "$env:LOCALAPPDATA\Zilux2\logs\host.log" -Tail 40 -Wait

# 关掉程序
taskkill /IM Zilux2.exe /F

# 启动带调试
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9223'; Start-Process "$env:LOCALAPPDATA\Programs\Zilux2\Zilux2.exe"

# 只部署前端
Copy-Item -Recurse -Force web/dist/assets dist/Zilux2/web/; Copy-Item -Force web/dist/index.html dist/Zilux2/web/
Copy-Item -Recurse -Force web/dist/assets "$env:LOCALAPPDATA\Programs\Zilux2\web/"; Copy-Item -Force web/dist/index.html "$env:LOCALAPPDATA\Programs\Zilux2\web/"
```

> Node / Python 用 DSH 运行时自带路径：`C:/Users/13329/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/{node/bin/node.exe,python/python.exe}`。
