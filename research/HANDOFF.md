# Zilux2 上下文交接（HANDOFF）

> 更新时间：2026-10-25（v1.1.6 发版：后台常驻 / 托盘图标交互 / 全局快捷键 / 下载入口迁移 / 快捷设置下载页 / 下载音质选择）
> 当前版本：**1.1.6**（唯一来源：根目录 `Directory.Build.props`；最近构建 `1.1.6`（tag `v1.1.6`），发布资产由 push tag 后 Actions 构建 `Zilux2-Setup-1.1.6.exe`）
> 代码仓库：`KaFuuChino2006/Zilux2`（**private**，`main` 已同步；Releases 已有 v1.1.0 / v1.1.1 / v1.1.2 / v1.1.3 / v1.1.4 / v1.1.5 / **v1.1.6（本轮）**）
> 本文件给下一个接手的 AI / 开发者：读完即可继续开发。

## 0. 交接速览（先读这里）

- **在做什么**：Windows 桌面音乐播放器 Zilux2（WPF + WebView2 宿主 + Vite/TS 前端），已具备完整播放器、在线音乐、发现页、房间/歌词效果、本地曲库、GitHub 自动更新。
- **当前状态（2026-10-25 交接时）**：`main` 已推送至 `v1.1.6` 之后（见 `git log`：v1.1.6 发布提交 → 快捷设置过渡修复 → 快捷键可配置 → P0 节拍分析实验）；版本 1.1.6；本机已安装并运行最新构建（含 P0 节拍分析实验）；Releases 最新为 v1.1.6（后台常驻/托盘交互/全局快捷键/下载入口迁移/快捷设置下载页/下载音质选择）。
- **最近 5 个提交（由新到旧）**：`e1f80f0` \[v1.1.6\] 后台常驻/托盘/全局热键/下载入口迁移/音质选择 → `7c75209` v1.1.5 发布提交：纯字光柱 8 套样式/多角度/彩虹/自动轮换 → `0121e74` 光柱多角度/彩虹/自动轮换 → `5ec1b7f` 四套光柱风格/无缝循环 → `b1bc181` 纯字光柱重做。
- **本轮已完成（2026-10-25）**：①后台常驻（`ShutdownMode=OnExplicitShutdown`，关窗隐藏到托盘、进程继续播放/下载/热键）；②托盘图标与交互（左键显示/隐藏、右键 显示/播放或暂停/上一首/下一首/退出、首次隐藏气泡提示）；③全局快捷键（Ctrl+Alt+Space 播放暂停、Ctrl+Alt+←/→ 上下首带候选回退、Ctrl+Alt+Z 显示隐藏）；④左侧 rail 下载入口迁移到快捷设置第 5 个「下载」页（复用下载队列可嵌入视图）；⑤所有下载入口先选音质（标准/高品质/无损，默认取设置、仅本次生效）。详见 `research/UPDATES-2026-10-25.md`。
- **下一步候选**（按优先级）：①仓库切 **public** 才能真正启用应用内自动更新（当前 private，匿名 API 404）；②歌词页更多效果；③更多平台能力（见 §11）。
- **改代码前必看**：§3 构建流程、§9 版本/发版节奏（**不要擅自跳版本号**）、§4 真机 QA、§10 更新通道。私有仓 + 未签名安装包会触发 SmartScreen，属预期。
- **本机环境**：`E:/dotnet/dotnet.exe`；Node 用 `C:/Users/13329/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe`；`github.com:443` 不通，git 走 SSH over 443（§10）；bash 里 `$LOCALAPPDATA` 不展开。

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
   - 关键界面触发路径（2026-10 交接时实测）：
     - 设置：`.rail-btn[title="设置"]` → `.sheet.is-center`（两栏：`.settings-nav-btn` 切换 `.settings-pane`）。
     - 房间/文字效果设置：`.pb-quick` → 快捷设置「歌词」tab → `.quick-text-settings-btn` → `.sheet.text-sheet`（全屏遮罩 + 底部居中面板）。
     - 歌曲信息：首页 `.ui-tile`（歌单卡）→ 歌单页 `.track-row` → 行内 `.track-info` → `.sd-modal`（居中浮窗，Esc/关闭按钮均可关）。
     - 快捷设置：`.pb-quick`；播放条主按钮 `.pb-btn.is-main`（CDP 真实鼠标点击不可靠，优先页面内 JS `.click()`）。
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
| `src/ui/songInfo.ts` | 歌曲信息：page=居中浮窗（`.sd-modal`，不再占满 stage）、inline=列表内展开；设置可选 |
| `src/ui/eqCurve.ts` | ★ 均衡器频响曲线：Canvas2D + PCHIP 平滑插值 + 节点拖拽（设置页与快捷设置共用） |
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

- 版本号统一由 `Directory.Build.props` 控制（当前 **1.1.6**）；`%LOCALAPPDATA%\Programs\Zilux2` 装的是最近一次构建（自动更新会改装到更新版本）。
- 1.1.6（本轮发版）：后台常驻 + 托盘 + 全局热键 + 下载入口迁移/下载页/音质选择。宿主：`ShutdownMode=OnExplicitShutdown`，关窗（页面按钮/Alt+F4/WM_CLOSE）隐藏到托盘、进程继续跑；新增 `Tray/TrayIconService.cs`（NotifyIcon，左键显示/隐藏，右键 显示/播放或暂停/上一首/下一首/退出，首次隐藏气泡提示一次）；`MainWindow` 注册全局热键（Ctrl+Alt+Space 播放暂停、Ctrl+Alt+←/→ 上/下一首带候选回退 Ctrl+Alt+Shift+←/→ 与 Ctrl+Alt+J/K、Ctrl+Alt+Z 显示/隐藏），托盘菜单/热键统一经 `WebViewHost.PostCommand` 下发 `{type:'command',action:...}` 到页面；真正退出只有托盘「退出」与更新安装。前端：rail 移除下载入口（9 项）；快捷设置增加第 5 个「下载」页（`.quick.is-download`，复用下载队列可嵌入视图 `createDownloadQueueView`）；新增 `downloadPicker.ts` 音质浮层（标准/高品质默认/无损，仅本次生效不回写设置，锚定按钮、键盘可达）；列表行下载按钮改为「先选音质再入队」，播放条下载按钮仍打开队列浮层。详见 `research/UPDATES-2026-10-25.md`。
- 2026-10-25 第二轮微调（已推 main、**未发版**，未达 §9 门槛：3 处修复/优化、无新增功能）：快捷设置切 tab 时面板**宽度/高度都做弹簧过渡**——`app.css` 的 `.quick .quick-panel` 补 `transition: width .32s cubic-bezier(.22,1.28,.36,1)`（`prefers-reduced-motion` 下关闭）；高度目标改为按「目标宽度」预量（`measureQuickBodyHeightAtTargetWidth`：临时加 `is-resizing` 关宽度过渡、按 tab 目标宽度落布局量内容高，再退回旧宽度交给 CSS 过渡），并用 `ResizeObserver` 观察 `quickBodyInner`，在宽度落定/异步内容加载后补一段高度动画（`scheduleQuickBodySync` / `syncQuickBodyHeight`），修掉「宽度过渡结束时高度再跳一截」；分页栏白色胶囊 `.quick-thumb` 与内容里的分段滑块 `.quick-seg-thumb` 在宽度过渡期间由 `ResizeObserver` 每帧贴合（`paintQuickTabThumb` / `repaintQuickSegThumbs` + `.is-width-animating` 期间 `transition: none`），修掉用户反馈的「切换时开关的显示背景错位/变形」。改动文件：`web/src/ui/app.ts`、`web/src/styles/app.css`。验证：宽度 348↔384↔508 平滑（中间帧 442 / 496 / 510）、过渡期间滑块漂移 ≤1px、落定后漂移 0、console 0 error；截图 `research/shots/lead-quick-anim-mid1.png`、`research/shots/lead-quick-cover-after-download.png`、`research/shots/lead-quick-final-cover.png`。
- 2026-10-25 第三轮（已推 main、**未发版**，未达 §9 门槛：1 个新增功能 + 2 处修复/优化）：**全局快捷键改为设置驱动、可配置**——完整设置弹窗新增「快捷键」页（4 行：播放/暂停、上一首、下一首、显示/隐藏窗口；展示当前组合与状态、录制换键、启用开关、恢复默认）。宿主：`SettingsModel` 新增 `shortcuts{enabled,playPause,prev,next,toggleWindow}`，新增 `Hotkeys/{HotkeyBinding,HotkeyCatalog,HotkeyState}.cs` 组合键解析/校验，`MainWindow` 删除静态 `HotkeySpecs` 改为 `ApplyShortcutSettings(reason)` 幂等注册（默认组合保留候选回退 prev/next→`Ctrl+Alt+Shift+←/→`→`Ctrl+Alt+J/K`；被占用时回落并在 UI 提示、无法回落提示可换键），`WebViewHost.PublishShortcuts` 回推 `{type:'host',event:'shortcuts'}`；前端 `core/settings.ts`/`core/bridge.ts`/`ui/app.ts` 新增设置段与面板、`styles/shortcut-settings.css`；契约文档 `docs/zilux2-settings-contract.md` 同步 §2/§3.3/§5/§7。验证：UI 4 行状态正确、录制 prev=Ctrl+Alt+U 后宿主重注册且 `WM_HOTKEY id=2` 实测切歌、关闭开关后 `hotkey.register ... skipped reason=disabled`/`apply enabled=false count=0`、恢复默认后 `apply enabled=true count=4`，settings.json 持久化。截图 `research/shots/lead-shortcuts-{panel,recorded,disabled,reset}.png`。详见 `research/UPDATES-2026-10-25.md` §4。
- 2026-10-25 第四轮（P0 节拍分析，已推 main、**未发版**，按用户「先做 P0 让我听听」暂不发版）：为「鼓点对齐自动衔接」的目标先做实验性 P0——宿主新增 `src/Zilux2/Analysis/`（`AnalysisModels.cs` 契约 DTO、`TrackAudioDecoder.cs` MediaFoundation 解码 + 22050Hz 单声道重采样、`BeatAnalyzer.cs` 谱通量 onset→自相关+梳状 BPM→相位拟合→4/3 拍强拍→拍网格/downbeats→小节 novelty 乐句，analyzer `p0-1`、`TrackAnalysisService.cs` 缓存/单飞/超时/错误码），`LocalMusicServer` 加 `GET /api/analysis`，`OnlineMusicService` 持有服务并暴露 `LocalPathResolver`，`WebViewHost` 接本地 rel→路径回调，`LocalMusicService.ResolveTrackPath` 改 internal；前端新增 `online/analysis.ts`（接口封装+内存缓存+单飞）、`core/metronome.ts`（AudioContext click 节拍器：强拍 1760Hz/普通 1046Hz、120ms tick、250ms lookahead、暂停/拖动/切歌清空、localStorage 持久化）、`ui/analysisSection.ts`（设置 → 播放「节拍分析（实验）」：分析当前/下一首 + BPM/拍号/拍点/小节/乐句/段落 + 节拍器开关/音量/强拍加重）、`styles/analysis-section.css`；契约文档 `docs/zilux2-beat-analysis-contract.md`。验证：合成 120/128/75 BPM 点击轨 BPM 119.8/128.6/75.2、拍号 4/4、相位误差 ≤85ms；真实 mp3 4:39 → 133.4 BPM（87%）、155 小节、594ms；节拍器开关与 localStorage 持久化；QA 回归 67 PASS / 0 FAIL / 3 SKIP。详见 `research/UPDATES-2026-10-25.md` §5。
- 2026-10-25 第五轮（BPM 倍速修复 p0-3，已推 main、**未发版**，1 处修复）：修「快歌节拍器慢半速」——`BeatAnalyzer.EstimateTempo` 在梳状自相关折叠后增加半拍 onset 校验（`bpm < 120` 且 `2×bpm` 在范围内时比较 `ac[beatLag/2]` 与 `ac[beatLag]`，阈值 `bpm<100` 用 0.55、`100–120` 用 0.78，满足则 `bpm *= 2`），`AnalyzerVersion` p0-1→p0-3（缓存键必须 bump 才重算）；合成 12 轨（75.2–220.2 BPM）全对，真实 32 首 corpus 无回归（霽れを待つ 167.4、新宝島 157.7）。详见 `research/UPDATES-2026-10-25.md` §6。
- 2026-10-25 第六轮（B 版 Phase 1：无缝衔接 MVP，已推 main、**未发版**，1 个新增功能）：用户选定「B 版」目标后实现鼓点对齐的自动衔接——新增 `web/src/ui/crossfadeDeck.ts`（双 deck 淡化引擎：B 按下一首 `firstDownbeatMs` 定入点、A 淡化起点对齐 A 的 downbeat、auto 4 小节 5–10s（2026-10-25 按用户反馈调整；固定档 5/7/10s）、等功率 A=cos/B=sin、`window.__ziluxCrossfade` 调试接口）；`player.ts` 改双 `<audio>` deck（`prepareSeamlessNext` 异步分析+预加载、`commitSeamless` 交换 deck 并迁移全部状态、取消矩阵）；`audioTap.ts` 新增 `deckMix` 混音入口与 `attachDeckToGraph`/`detachDeckFromGraph`/`deckGraphConnected`/`setDeckGraphGain`，**Web Audio 图开启时走图内增益淡化**（修掉「默认人声保留淡出导致永不生效」）；`app.ts` 播放页新增「无缝衔接（实验）」设置区（localStorage `zilux2.crossfade`，默认开/auto，可选 5/7/10s）。真机验证：本地曲库「霽れを待つ」→「スペア」`prepared`(3232ms/`bStartFileMs`1277)→`fading`→`fade-done` 约 3.2s，播放器自动切歌且继续为下一首预排；脚本 `research/tmp/lead-crossfade-verify3.mjs`。已知限制：仅列表循环、下一首需分析成功、后台 rAF 节流、位级 gapless 留待 Phase 2+。详见 `research/UPDATES-2026-10-25.md` §7。
- 2026-10-25 第九轮（过渡对齐下一首「开始唱词」，已推 main、**未发版**，1 处体验优化）：用户要求过渡跳过下一首无唱词前奏、让淡化结束瞬间正好开始唱词。新增 `web/src/ui/vocalStart.ts`（`fetchVocalStartMs`：本地同名 .lrc / 在线宿主 /api/lyric LRC·YRC，1.8s 超时、按曲目缓存、失败返回 null）；`web/src/ui/crossfadeDeck.ts` 的 `buildSchedule` 按下一首首句唱词反推 B——前奏够长时 B 从 `唱词-期望淡化` 处起播（跳过前奏）、前奏较短时整段前奏作过渡并缩短淡化使终点=唱词起点，均写 `vocalAligned`，失败回退原逻辑；`web/src/ui/player.ts` 的 `prepareSeamlessNext` 异步取唱词位置后传入；设置区说明同步。真机验证三种路径：短前奏(290ms)→回退普通淡化；中前奏(5310ms)→淡化 4409ms 终点=唱词；长前奏(13200ms)→B 跳过 3.2s 前奏、10s 淡化终点=唱词，三种均 `fadeStart+fadeMs=可听结尾`。详见 `research/UPDATES-2026-10-25.md` §10。
- 2026-10-25 第七轮（尾端静音自动排除 + 收藏歌单实测，已推 main、**未发版**，1 处体验优化）：用户要求「用收藏歌单测试 + 自动排除尾端静音」。宿主：新增 `src/Zilux2/Analysis/TailSilenceDetector.cs`（-50 dBFS / 20ms RMS / 连续静音 ≥300ms / 至少保留 10% 时长），`/api/analysis` 响应顶层新增 `audibleEndMs`（可听结尾 ms）与 `tailSilenceMs`，`AnalyzerVersion` p0-4；前端：`online/analysis.ts` 兼容顶层字段（缺失回退 duration），`ui/crossfadeDeck.ts` 把 A 的淡化终点改为 `clamp(audibleEndMs ?? durationMs, 0, durationMs)`，保证 `fadeStartPosMs + fadeMs = audibleEndPosMs`，不占用尾部静音；debug 快照/事件带「可听结尾/尾部静音」。真机验证：本地 スペア（duration 297000/audibleEnd 290841/tail 6159）与收藏歌单 なでなで（259120/255179/3941）公式偏差 0ms；收藏歌单「なでなで→人是猫」prepared→fading→done 约 3.3s 自动切歌并 `playing=true`。QA：76 PASS / 0 FAIL / 3 SKIP（90.2s，crossfade 新增 9 步）详见 `research/UPDATES-2026-10-25.md` §8。
- 1.1.5：纯字档背景光柱完成体验升级并正式发版——光柱从 4 套扩到 **8 套**（新增 斜光/交叉/仰光/虹光 四种入射角/扇形构图），虹光用每束 `tint/hueTint` 着色 + shader 截面色散；新增 **自动轮换**（`beamAuto` 默认开：每 16s 换一套，2.4s smoothstep 插值过渡，顺序 静光→缓息→流幕→聚光→斜光→交叉→仰光→虹光）；所有样式统一走 32s 无缝循环时钟，烟雾 42s 无缝循环；面板 `.ts-seg.is-wrap` 两行 8 chip + 「自动轮换」行。详见 `research/UPDATES-2026-10-24.md` §10/§11。
- 1.1.4（本轮）：房间设置新增粒子/流星快捷预设（8 组，`.room-preset-chip`）；宿主新增 `FileSystemWatcher` 本地音乐目录自动监控（`LocalFolderWatcher.cs` + `LocalMusicService.Watch.cs`，1.3s 去抖、增量重扫、自写入抑制）；下载队列浮层（`downloadQueue.ts`：汇总/筛选/进度/速度/定位/重试，入口 `.pb-actions [data-qa=download-entry]`）；QA 回归套件固化到 `research/qa/suite/`；修复 `NotifyFileAdded` 跨线程、`WebViewHost` 未释放 `LocalMusicService`、`DeleteTracks` 自身写入未抑制。详见 `research/UPDATES-2026-10-24.md`。
- 1.1.4 第二轮微调（同日、已推 main、**未发版**，未达 §9 门槛：4 处修复/优化、无新增功能）：下载入口 rail 常驻（`.rail-btn[aria-label=下载队列]`，`toggleDownloadPanel`）；下载队列 tab 统一全局 `.seg` 分段控件（白色滑块 `.seg-thumb`）并加切换动画（`.is-switch` / `dlq-switch-in`，行 24ms stagger）；修复搜索「input 后立即 Enter 永久卡加载中」竞态（`commitSearch` 清 `searchTimer`）。QA 套件扩到 **46 项**（新增下载队列 UI 断言 + 竞态回归，`run-all` 46.5s 全绿）。详见 `research/UPDATES-2026-10-24.md` §7。
- 1.1.4 第三轮（同日、已推 main、**未发版**，未达 §9 门槛：累计 5 处修复/优化、无新增功能）：纯字档背景光柱重做——移除此前的 folia 迁移光位光束，新增自研 `light/textBeams.ts`（固定构图 6 道＝`TEXT_BEAM_COUNT`；围绕文字区、垂直光柱、独立慢摆 + 长度呼吸 + 低频抬升亮度；设置面板「背景光柱 / 光柱大小 / 左右位置 / 上下位置」继续生效）；`scene.ts` 的纯字分支改用 `resolveTextBeams`，非纯字档位保持原 folia 光位链路不变。详见 `research/UPDATES-2026-10-24.md` §8。
- 1.1.4 第四轮（同日、已推 main、**未发版**）：纯字档光柱支持**四套风格**（文字设置 → 文字 → 光柱效果：静光/缓息/流幕/聚光），并让光柱与烟雾**全部无缝循环**——`textBeams.ts` 新增 `textClock()`（LOOP=32s，每束摆动/呼吸/漂流相位取 32 的整数谐波，32s 首尾完全重合；`streakPhase` 按整圈取余避免循环点跳变）、四套 `COMPOSITION` 与固定 `TEXT_FOG_RIG`/`TEXT_FOG_LOOP`；`lightFieldShader.ts` 增加 `uFogC` 循环雾模式（周期 42s，sin/cos 漂移、流动纹理整圈取余），修掉「雾循环点跳一下」。改动文件：`light/textBeams.ts`、`light/lightFieldShader.ts`、`scene.ts`、`lumiereSettings.ts`、`textSettingsPanel.ts`、`lumiere-folia/types.ts`、`lumiereRuntimeTuning.ts`。详见 `research/UPDATES-2026-10-24.md` §9。按用户「先自测」要求暂不发版（累计已超 §9 阈值，待确认后再定 1.1.5）。
- 1.1.4 第五轮（同日、已推 main、**未发版**）：纯字档光柱扩到 **8 套样式**（新增 `斜光/交叉/仰光/虹光` 四套不同入射角/扇形彩虹构图）并新增**自动轮换**（`beamAuto` 默认开：每 16s 换一套，顺序 静光→缓息→流幕→聚光→斜光→交叉→仰光→虹光，2.4s smoothstep 插值过渡）；虹光用 `BeamSpec.tint/hueTint` + shader 截面色散；面板 `.ts-seg.is-wrap` 两行 8 chip + 「自动轮换」行。详见 `research/UPDATES-2026-10-24.md` §10。按用户「先自测」要求暂不发版（累计已超 §9 阈值）。
- 1.1.1：播放/暂停渐变增强——淡出/淡入时长分开（`playback.fadeOutMs` / `playback.fadeInMs`）、曲线可选（`playback.fadeCurve`: smooth/linear/exponential）、新增「人声保留淡出」（`playback.fadeVocal` / `playback.fadeVocalTailMs`，暂停时压低低频/高频让人声多留一会儿）；快捷设置新增人声保留开关；设置契约与 README 同步。
- 上一窗口（1.1.0）：设置改为居中大弹窗（效果设置同款）；新增 10 段均衡器（7 预设 + 手动增益，Web Audio BiquadFilter 链）；播放/暂停渐变（`playback.fadeEnabled/fadeMs`，默认关）；快捷设置新增「均衡器 / 播放暂停渐变」；修复宿主 settings patch 会重置同 section 其它字段的 bug（`SettingsService.ApplyKnownValues` 的 fallback 改为保留当前值）。
- 近期 patch：1.1.2 把 EQ 频响曲线从折线改为 PCHIP 平滑曲线，并修复「暂停后再播放首帧满音量」；1.1.3 把房间设置/文字设置弹层的遮罩改为铺满整个窗口（此前只暗底部一块），并补上设置滑块右侧数值、播放条滑杆风格图标；1.1.3 已按 `463995e` **重发覆盖** Release，额外包含「房间地毯远端椭圆色斑」修复（原实现用径向渐变椭圆做远端渐隐，粉色/深色房间会看出椭圆边界；改为裁切在地毯形状内的线性渐隐）。
- 注意：**同一版本号替换 Release 后，已安装该版本的客户端不会收到更新提示**（更新逻辑比版本号）；只有新下载安装包/新装用户拿到新构建。要让老用户自动升级必须递增版本发新 Release。
- 更新通道（本窗口完成）：GitHub Releases 自动检查 → 后台下载 → 提示安装 → 静默安装并重启；设置页「更新」分区；GitHub Actions 自动发版。已用本地 mock Release 真机实测 1.0.0 → 1.0.1 全链路。
- 代码已推到私有仓库 `KaFuuChino2006/Zilux2`（`main` 含完整历史；Releases 已发布 v1.1.0–v1.1.3，私有可见；`v1.0.0` tag 未推送、已被 1.1.x 取代）。`origin` 为 SSH over 443，见 §10。
- 本窗口已完成：房间效果系列（歌词颜色跟随/流星/粒子 3D/自定义）、发现页全量能力、歌曲信息、本地标签歌手 + 歌手页、本地曲库管理、统一下载 + 音质、顶部预期条、首页双收藏卡、应用内确认框、窗口动画设置。
- 详细更新清单：`research/UPDATES-2026-10-23.md`。

## 9. 版本与发版节奏（约定）

- 版本号只递增第三位（patch）：`1.1.x`；小修小补也**不要**跳到 `1.2.0`。
- **发版门槛**（满足其一才递增版本并发 Release）：
  1. 累计修复 / 优化类改动 **超过 5 处**；
  2. 累计新增功能 **3 个以上**。
- 未达门槛：正常提交并推送 `main`，但**不改** `Directory.Build.props` 版本、不打 tag、不发 Release（1.1.4 第二~五轮微调按此处理：推 `main`，版本仍 1.1.4；第三轮起累计已超阈值，但按用户「先自测」要求，直到用户确认效果后才于 2026-10-24 发 **1.1.5**；1.1.6 之后的 2026-10-25 第二轮（3 处修复/优化）与第三轮（1 个新增功能 + 2 处修复/优化）同样未达门槛 → 推 `main`、版本仍 1.1.6）。 2026-10-25 第四轮（P0 节拍分析）为 1 个实验性新增功能，累计仍不足「新增功能 ≥3」，且用户明确「先做 P0 让我听听」→ 推 `main`、版本仍 1.1.6，等试听确认后再定 1.1.7 或进入 B 版 Phase 1。第五轮（BPM 倍速修复 p0-3，1 处修复）与第六轮（B 版 Phase 1 无缝衔接 MVP，1 个新增功能）继续推 `main`、版本仍 **1.1.6**、无 tag（累计新增功能仍 2 个 < 3；若 Phase 2+ 落地后再评估是否发 1.1.7）。第七轮（尾端静音自动排除 + 收藏歌单实测，1 处体验优化）同样只推 `main`、版本仍 **1.1.6**、无 tag。第八轮（把过渡时长调到保守 5–10s：auto=4 小节夹 5–10s、固定档 5/7/10s，1 处体验优化）同样只推 `main`、版本仍 **1.1.6**、无 tag。 第九轮（过渡对齐下一首开始唱词：前奏较长跳过、前奏较短整段作过渡，1 处体验优化）同样只推 `main`、版本仍 **1.1.6**、无 tag。
- 达到门槛：改 `Directory.Build.props` → 提交 → `git tag -a v<version> -m "Zilux2 <version>"` → `git push origin v<version>`（Actions 自动构建发布）。
- **同版本替换已发布构建**（用户要求「替换最新版但版本号不换」时）：不改版本号；先删远端/本地旧 tag，再把 `v<version>` 重新指到新提交并 push：
  ```bash
  git tag -d v1.1.3
  git push origin :refs/tags/v1.1.3
  git tag -a v1.1.3 -m "Zilux2 v1.1.3（重发）" <new-commit>
  git push origin v1.1.3
  ```
  Actions 会重新跑并覆盖同一 Release 的资产；本地再 `make-installer` + 静默安装同步。已安装同版本的客户端不会提示更新（见 §8）。
- 已按此节奏发布：`v1.1.0`（设置居中/EQ/渐变）、`v1.1.1`（渐变细分 + 歌曲信息浮窗）、`v1.1.2`（EQ 平滑 + 首帧爆音）、`v1.1.3`（效果弹层遮罩；后按 `06ef14e` 重发含滑块数值/图标，再按 `463995e` 重发含地毯椭圆修复）、`v1.1.4`（房间预设/本地目录监控/下载队列/QA 套件）、`v1.1.5`（纯字光柱 8 套样式 + 多入射角/彩虹/自动轮换）、`v1.1.6`（后台常驻/托盘/全局热键/下载入口迁移/快捷下载页/音质选择）。

## 10. 更新通道（GitHub Releases）

- 设计/协议/发版说明：`docs/zilux2-update-channel.md`；建仓与首发步骤：`docs/zilux2-github-setup.md`。
- 版本唯一来源：根目录 `Directory.Build.props` 的 `<Version>`（宿主/安装器继承；改它即改版本号）。
- 默认更新源：编译期注入 `ZiluxUpdateRepo`（`Directory.Build.props` 默认 `KaFuuChino2006/Zilux2`，CI 用 `github.repository` 覆盖）；运行时设置 `updates.repo` 可覆盖。
- 资产：`Zilux2-Setup-<version>.exe`；宿主下载到 `%LOCALAPPDATA%\Zilux2\updates\`，校验 GitHub `digest`（sha256）后以 `--silent --no-shortcuts --launch --dir <安装目录>` 静默安装并重启。
- 默认 `updates.mode="auto"`（自动下载+提示安装），可切 `"notify"`（只提示）；`updates.autoCheck` 控制启动检查 + 每 4 小时轮询。
- 发版：改 props 版本 → 提交 → `tools\release.ps1`（或 push tag `v<version>`，Actions 自动构建发布）。
- 当前 Release：`v1.1.6`，tag 指向 v1.1.6 发布提交（2026-10-25 推送）；Actions 自动构建资产 `Zilux2-Setup-1.1.6.exe` / `Zilux2-Portable-1.1.6.zip` / `.exe.sha256`。上一版 `v1.1.5`（2026-10-24 发布），更早 `v1.1.3` 曾按 `463995e` 重发覆盖。
- 仓库可见性：应用内更新走未认证 GitHub API，**只有公开仓库的 Release 可见**；开发期可先建私有仓库存代码（先不推 tag），要发布更新时把仓库切 public 再推 tag。客户端对 404 的提示为「仓库不存在、未公开，或还没发布 Release」。当前仓库仍是 private：Releases 已发布但匿名 API 查不到，**应用内自动更新暂不可用**；要启用自动更新需把仓库切成 public（或后续给客户端加 token 支持）。
- 本机网络：`github.com:443`（HTTPS）被重置/超时，`origin` 走 **SSH over 443**：`ssh://git@ssh.github.com:443/KaFuuChino2006/Zilux2.git`，deploy key 在 `C:\Users\13329\.ssh\zilux2_deploy`，仓库本地已配 `core.sshCommand`；细节见 `docs/zilux2-github-setup.md` §4.3。
- 注意：更新包未做代码签名（SmartScreen 会提示，属预期）。

## 11. 已知限制 / TODO

- **应用内自动更新目前不可用**：仓库是 private，未认证 GitHub API 查不到 Release（404）。要启用：仓库 Settings → 底部 Danger Zone → Change visibility → Public（或后续给客户端做 token 支持）。切 public 后，还需发一个**比已装版本更高**的 Release 才会触发更新提示。
- QQ 搜索主接口偶发 500，回退备用接口会增加首次搜索耗时（约 10s）。
- QQ 会员曲目下载/播放受限（提示需要会员）。
- 匿名/失效 mvmp3 曲目 403（上游下架）。
- 房间效果为 Canvas2D + DOM，低配机可调低「渲染像素比」。
- 回归靠 `research/qa/suite/`（CDP 套件 + 截图 + results JSON），`node research/qa/suite/run-all.mjs` 一键跑；前提是应用带 `--remote-debugging-port=9223` 运行，且依赖真实在线网络（搜索/下载用例）。
- 后续可做：歌词页多效果、更多平台能力；下载队列暂无「取消/清空」宿主接口（面板如实提示）；本地目录监控无设置开关（默认开启）。
- 后台常驻/托盘/热键的已知限制：全局热键每动作有候选回退（全部被占用时该动作无热键，只记 WARN）；托盘依赖资源管理器通知区域，初始化失败时关窗即退出（日志 `tray.unavailable`）；托盘气泡只弹一次；播放条下载按钮打开下载队列浮层而不是直接下载当前曲目；真正退出只有托盘菜单「退出」与更新安装两条路径。

## 12. 常用命令速查

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

# QA 回归套件（应用需带 --remote-debugging-port=9223 运行；node 用 DSH 自带路径）
node research/qa/suite/run-all.mjs        # 全部套件（约 100s，退出码 0/1）
node research/qa/suite/smoke.mjs          # 单跑某个套件
```

> Node / Python 用 DSH 运行时自带路径：`C:/Users/13329/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/{node/bin/node.exe,python/python.exe}`。
