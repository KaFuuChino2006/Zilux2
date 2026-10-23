# Zilux2

沉浸式桌面音乐应用（Windows）。C# / .NET 10 WPF 宿主 + WebView2 + Three.js 前端，目标能力：整个播放器就是一个 3D 空间（3D 歌词舞台、3D 歌单、PV 播放画面）。

当前进度（2026-10-18 已完成，用户自测）：

1. **里程碑 1**：启动界面 + 首页
2. **里程碑 2**：在线音乐（网易云 + QQ 音乐）
3. **里程碑 3**：设置界面
4. **里程碑 4**：白色磨砂设计体系 + 扫码登录 / Cookie 导入 + 个人音乐库 + 3D 歌单详情
5. **里程碑 5**：沉浸播放页（3D 歌词舞台）+ 音频驱动 + Windows 媒体会话（SMTC）
6. **里程碑 6（当前形态）**：全屏 3D 登录空间 —— 移除导航栏 / 底部播放条 / 歌词等所有旧页面，第一屏即 3D 空间；重写网易云 + QQ 音乐扫码登录（网易云风控码修复、QQ Connect 完整凭据交换）
7. **里程碑 6.1**：3D 磨砂玻璃空间 —— 登录/游客进入后默认俯视地面；任意位置按住拖动旋转视角、滚轮缩放；磨砂玻璃地面下方为可替换的自定义背景（当前为程序生成的浅色极光）
8. **里程碑 7（当前迭代）**：投送到 AirPlay 音响 —— 局域网 mDNS 发现、HomePod 瞬态 HAP 配对、PTP 主时钟、未压缩 ALAC over 加密 RTP、125 包/秒定速发送；已在 HomePod mini 上实测出声。**里程碑 7.1：多台同时投送** —— 共享 PTP 主时钟、单份采集/编码多路分发，面板可连续追加设备/单台停止/全部停止（两台 HomePod 同时出声已实测）。**里程碑 7.2：macOS 接收器** —— macOS「隔空播放接收器」拒绝瞬态配对，改走 HAP PIN 配对（Mac 屏幕 4 位码 → 面板输入），凭据落盘后免重复配对；MacBook Pro 已实测出声，可与 HomePod 同时投送（详见 `docs/Zilux2-里程碑7-AirPlay投送.md`）
9. **里程碑 8（当前迭代）**：GitHub 自动更新通道 —— 版本号统一、应用内检查/下载/静默安装/自动重启、GitHub Actions 自动发版（详见 `docs/zilux2-update-channel.md`）

## 目录

```
docs/          设计文档与调研报告
  zilux2-host-contract.md           宿主 ⇄ 前端契约（v1，含 §10 音频、§11 媒体会话）
  zilux2-online-music.md            在线音乐接口契约（搜索 / 歌词 / 音频流 / 封面）
  zilux2-settings-contract.md       设置契约（Settings v1）
  zilux2-update-channel.md          GitHub 更新通道契约（版本/协议/发版）
  zilux2-github-setup.md            建仓与首发步骤（GitHub 网页 + git 命令）
  zilux2-account-login.md           账号登录契约（扫码 + Cookie 导入）
  zilux2-library.md                 个人音乐库契约
  zilux2-design-system.md           白色磨砂设计体系（v2）
  zilux2-songgrid.md                3D 歌单详情契约
  zilux2-nowplaying.md              沉浸播放页契约
  Zilux2-里程碑1-启动界面与首页.md    里程碑 1 交付说明
  Zilux2-里程碑2-在线音乐接入.md      里程碑 2 交付说明
  Zilux2-里程碑3-设置界面.md          里程碑 3 交付说明
  Zilux2-里程碑4-白色磨砂与账号与音乐库.md  里程碑 4 交付说明
  Zilux2-里程碑5-沉浸播放页与媒体会话.md    里程碑 5 交付说明
  Zilux2-里程碑7-AirPlay投送.md       里程碑 7 交付说明（AirPlay / HomePod 投送）
  Zilux2-三项目深度调研报告.md         Rhine / Folia / Mineradio 三项目技术调研
research/
  repos/       三个参考项目源码快照（rhine / folia / mineradio）
  notes/       四份深度拆解报告（rhine / folia-lyrics / folia-visual / mineradio）
  shots/       验收截图
src/Zilux2/    WPF 宿主（窗口、WebView2、消息桥、日志、在线音乐、设置持久化、更新通道）
web/           前端（Vite + TypeScript + Three.js）
.github/       CI：tag v* 时自动构建并发布 GitHub Release（release.yml）
Directory.Build.props  ★ 版本号与默认更新源的唯一来源
tools/         build.ps1 / run.ps1 / selftest.ps1 / settings-selftest.ps1 / online-selftest.ps1 / publish.ps1 / install-shortcut.ps1 / make-installer.ps1 / release.ps1
dist/Zilux2/   便携版（Zilux2.exe + web/，tools\publish.ps1 生成）
run-zilux2.cmd 双击启动（首次自动发布）
```

## 一键启动（推荐）

桌面快捷方式 **Zilux2**（开始菜单也有一份）已指向便携版 `dist\Zilux2\Zilux2.exe`，双击即可启动。

需要更新前端或重新打包时：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\publish.ps1   # 构建前端 + 发布便携版
powershell -NoProfile -ExecutionPolicy Bypass -File tools\install-shortcut.ps1 -StartMenu  # 重建快捷方式
```

也可以直接双击仓库根目录的 `run-zilux2.cmd`（首次会自动发布，之后直接启动）。

## 安装包（推荐分发给别人）

`dist\Zilux2-Setup-1.0.0.exe`（约 12.5 MB）是自包含安装程序：

- 双击打开图形安装界面，默认装到 `%LOCALAPPDATA%\Programs\Zilux2`（当前用户，无需管理员权限），可改路径；
- 自动创建桌面 + 开始菜单快捷方式，写入「应用和功能」卸载项；
- 安装完成后可直接勾选启动；卸载通过 设置 → 应用，或安装目录里的 `Uninstall.exe`；
- 静默安装：`Zilux2-Setup-1.0.0.exe --silent [--no-shortcuts] [--launch] [--dir <路径>]`。

重新生成安装包（需先 `tools\publish.ps1` 发布便携版）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\make-installer.ps1 -Version 1.0.0
```

安装程序源码在 `src/Zilux2.Installer/`（WinForms，payload 以 zip 资源内嵌，单文件发布）。

## 自动更新（里程碑 8）

- 应用内更新：宿主检查 GitHub Releases 最新版 → 自动后台下载 → 提示「立即安装并重启」→ 静默安装并重启；设置 → 更新 可切「仅提示」或改更新源。
- 版本号唯一来源：根目录 `Directory.Build.props` 的 `<Version>`；发版只改这里，然后 `tools\release.ps1` 或 push tag `v1.0.0` 触发 Actions 自动构建发布。
- 更新源默认 `KaFuuChino2006/Zilux2`（见根 `Directory.Build.props`），CI 会用 `github.repository` 注入真实 `owner/repo`；也可在 设置 → 更新源 覆盖。
- 建仓/首发步骤见 `docs/zilux2-github-setup.md`，协议见 `docs/zilux2-update-channel.md`。仓库需为 public。
- **私有仓库模式**：可以先把代码 push 到 private 仓库（先不推 tag）；等要正式发布更新时，把仓库切成 public 再推 tag 触发 Release。匿名 GitHub API 查不到私有仓库的 Release，应用内更新会提示「未找到可用版本」。

## 开发模式

```powershell
# 1) 构建宿主（自动把 web/dist 复制到输出目录）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\build.ps1

# 2) 运行 Debug 版
.\src\Zilux2\bin\Debug\net10.0-windows10.0.19041.0\Zilux2.exe

# 3) 自动验收（宿主 42 项 + 在线服务 57 项 + 设置 63 项）
pwsh -File tools\selftest.ps1
pwsh -File tools\online-selftest.ps1
pwsh -File tools\settings-selftest.ps1
```

前端开发：

```bash
cd web
pnpm install
pnpm dev     # http://127.0.0.1:5173
pnpm build   # 产物 web/dist
```

环境：.NET SDK 10.0.401、WebView2 Evergreen Runtime、Node ≥ 22 + pnpm。

## 技术栈

- 宿主：WPF（net10.0-windows10.0.19041.0）、WindowChrome 无边框、PerMonitorV2 DPI、WebView2（Microsoft.Web.WebView2 1.0.4191.47）、本机虚拟主机映射 + v1 消息协议。
- 前端：Vite 7 + TypeScript 5.9 + Three.js r180（WebGL2）；无 React，原生 DOM/CSS + 独立 3D 场景（启动粒子 / 首页封面环 / 3D 歌曲墙 / 3D 歌词舞台 / 3D 歌单架）。
- 资源：封面全部由 Canvas2D 程序化生成；在线曲目封面由宿主代理并缓存，缺失时前端程序化兜底。
- 音频：宿主 WASAPI loopback 采集 → 64 bin 频谱特征 30Hz 推送；Windows 媒体会话（SMTC）双向桥接。

## 在线音乐（里程碑 2）

宿主内嵌回环 HTTP 服务（只绑 `127.0.0.1`、动态端口、每次启动生成随机 token），前端通过 `fetch` / `<audio>` 访问：

- `GET /api/search?source=netease|qq&q=关键词` —— 双源搜索（歌名 / 歌手 / 专辑 元数据）
- `GET /api/lyric?source=&id=` —— LRC 原文 + 翻译（可选）
- `GET /api/stream?source=&id=` —— 音频流，透传 Range 支持拖动与续播
- `GET /api/cover?key=` —— 封面代理（内存缓存）
- `GET /api/health` —— 健康检查

前端入口：顶栏搜索框 / `Ctrl+K` 打开搜索面板（双源切换，↑↓ 选择，Enter 播放）；播放条右侧「歌词」打开滚动歌词面板。VIP / 无版权曲目由宿主返回 403，前端明确提示而不是静默失败。

无宿主时可用演示模式验收界面：`http://127.0.0.1:5173/?mock=1`（内置演示数据 + 一段 32 秒合成音频）；截图用 `?snap=1&mock=1&panel=search` 或 `?panel=lyrics`。

## 设置（里程碑 3）

入口：左侧导航最下方的「设置」按钮，或快捷键 `Ctrl+,`。

- 常规：启动动画、启动时最大化、快捷键一览
- 外观：界面主题（白色磨砂）、减少动效、氛围光晕、封面环自转、歌词字号
- 播放：默认在线源、每次搜索结果条数、自动展开歌词、音频响应、默认音量
- 更新：自动检查、更新方式（自动安装 / 仅提示）、更新源
- 账号：网易云 / QQ 音乐扫码登录、Cookie 导入兜底、会员状态、退出登录
- 关于：版本、宿主与前端技术栈、存储位置、致谢与许可

设置由宿主持久化到 `%LOCALAPPDATA%\Zilux2\settings.json`（无 BOM），修改即时生效并自动保存；无宿主浏览器预览时用 `localStorage` 镜像。删除该文件即恢复默认。契约见 `docs/zilux2-settings-contract.md`。

## 账号与个人音乐库（里程碑 4）

- 设置 →「账号」：网易云、QQ 音乐扫码登录（二维码在弹层内渲染）；扫码受平台风控影响时可粘贴浏览器 Cookie 导入。
- 登录状态加密保存在 `%LOCALAPPDATA%\Zilux2\account.json`（DPAPI），重启恢复；退出登录即清除。
- 首页第一屏「我的音乐」：两平台「我喜欢的音乐」+ 自建/收藏歌单（数据由宿主 `/api/library/*` 聚合，5 分钟缓存）。
- 点击歌单卡片 → 3D 歌曲墙页面：封面立方体网格/竖排、悬停凸显、点击放大聚焦、右侧歌词面板、分页加载。
- VIP 曲目能否播放取决于账号权益；无权限时宿主返回 403，前端明确提示。

## 沉浸播放页（里程碑 5）

- 入口：点击播放条左侧封面/曲名，或 `Ctrl+P`；`Esc` 关闭。
- 3D 歌词舞台（Canvas2D 行级光栅 → 微弧面 + 扫光 shader），支持「3D / 列表」切换。
- 音频驱动：宿主 WASAPI loopback → 30Hz 频谱特征（`host event=audio`），驱动歌词舞台光场与首页封面环呼吸；可在设置关闭「音频响应」。
- Windows 媒体会话（SMTC）：系统「正在播放」浮层、媒体键、锁屏控制会显示并控制 Zilux2。
- 契约：`docs/zilux2-nowplaying.md`、`docs/zilux2-host-contract.md` §10/§11。

## 投送到 AirPlay 音响（里程碑 7）

- 入口：左侧栏「投送」图标（或设置 →「投送」区块）。
- 自动发现局域网里的 AirPlay 设备（mDNS，无 Bonjour 依赖）；选设备 →「连接」→ 应用里播放的声音即投到音响。
- 传输自动选路：HomePod / 新 Apple TV 等走 **AirPlay 2**（HAP 瞬态配对 + 加密 RTSP + PTP 主时钟 + 未压缩 ALAC over ChaCha20-Poly1305 RTP）；老设备走**经典 RAOP**；AP2 失败自动回退。
- 面板内可调接收端音量、随时断开；断开/最小化/退出时自动 TEARDOWN。
- **多台同时投送**：一台播放中可继续点其它设备的「投送」追加（共享同一份采集/编码与 PTP 主时钟）；已投送清单可单台暂停或「全部停止」，面板会显示「已连接 N 台设备」。
- **投到 Mac**：点击 macOS 设备的「投送」后，Mac 屏幕弹出 4 位配对码，面板出现「Mac 配对码」输入框，填入即开始播放；首次配对成功后本机记住凭据，之后连接不再要码（可在 `%LOCALAPPDATA%\Zilux2\airplay\pairing` 删除）。
- 已实测：HomePod mini（AirTunes 980.77.2）单台干净出声；**两台 HomePod mini 同时出声、声音同步**。详细协议与踩坑见 `docs/Zilux2-里程碑7-AirPlay投送.md`，消息契约见 `docs/zilux2-host-contract.md` §12。
- 自测：`ZILUX2_AIRPLAY_SELFTEST=1` 运进程内 mock RAOP 断言（32 项）；`tools/airplay-selftest.ps1` 为 PowerShell 版封装。

## 参考项目

三个开源项目仅用于学习架构与工程方法（详见 `docs/Zilux2-三项目深度调研报告.md`）：

- Rhine Music Windows（MIT 代码部分）
- Folia（AGPL-3.0，只学规格与思路，clean-room 重写）
- Mineradio（GPL-3.0，只学思路，不移植代码）

Zilux2 界面与代码均为全新实现，不复制上述项目的界面资源与源码。
