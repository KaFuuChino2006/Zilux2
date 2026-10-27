# Zilux2

<p>
  <img alt="version" src="https://img.shields.io/badge/version-1.1.93-2f6f4f?style=flat-square">
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows%2010%20%2F%2011%20x64-0067c0?style=flat-square">
  <img alt=".NET" src="https://img.shields.io/badge/.NET-10-512bd4?style=flat-square">
  <img alt="Vite" src="https://img.shields.io/badge/Vite-7-646cff?style=flat-square">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.9-3178c6?style=flat-square">
  <img alt="developed with AI" src="https://img.shields.io/badge/%E5%BC%80%E5%8F%91%E6%96%B9%E5%BC%8F-AI%20Agent-7c5cff?style=flat-square">
</p>

> **Zilux2** — 一款面向 Windows 的沉浸式桌面音乐播放器。
> 双平台在线音乐（网易云音乐 / QQ 音乐）、本地曲库、3D 歌词舞台（四种播放效果）、AirPlay 投送、随鼓点对齐的无缝衔接、可配置全局快捷键与内置 GitHub Releases 更新通道。

Zilux2 使用 **.NET 10 / WPF** 承载 **WebView2**，界面、动画与音频处理由 **TypeScript + Vite** 前端实现；在保留桌面应用系统集成能力的同时，获得现代 Web 的渲染表现与迭代效率。

- 下载与更新日志：[Releases](https://github.com/KaFuuChino2006/Zilux2/releases)
- 当前版本：**1.1.93**
- 问题反馈：[Issues](https://github.com/KaFuuChino2006/Zilux2/issues)

---

## 关于本项目的开发方式

> **本项目的宿主、前端、安装器、文档、自动化测试与发布流水线，均由 AI Agent（DeepSeek Harness）全程完成。**
> 人类负责提出需求与试听验收，AI 负责设计、编码、真机验证、排障、文档与发版。

这意味着：

- 项目迭代速度快，但**难免存在动效异常、偶发 bug 或细节不完善之处，敬请谅解**；欢迎通过 [Issues](https://github.com/KaFuuChino2006/Zilux2/issues) 反馈，我们会持续修复。
- 请勿将其视为商业级软件；在重要场景使用前请自行做好数据与系统备份。

## 功能特性

| 模块 | 能力 |
| --- | --- |
| 在线音乐 | 网易云音乐 / QQ 音乐双源融合搜索、歌单、歌词（原文 / 翻译 / 逐字 YRC）；扫码登录与 Cookie 导入兜底；个人库同步、我喜欢的音乐、私人雷达 |
| 本地音乐 | 本地目录扫描、音频标签与封面提取、目录实时监控（增量刷新）、与下载目录合并展示；本地歌单与「添加歌曲」 |
| 播放体验 | 自定义播放条、滚动歌词、沉浸播放页 3D 歌词舞台（**四种播放效果：关闭 / 纯字 / 房间 / 唱片**）、Windows 媒体会话（SMTC）与系统媒体键接管 |
| 播放效果 · 关闭 | 白色磨砂歌词页，6 种播放动画（经典 / 上浮 / 波浪 / 摇曳 / 打字机 / 旋入），未播放歌词颜色可自定义，歌词样式随切换即时生效 |
| 播放效果 · 纯字 | 自研 Canvas 渲染的文字舞台：光柱 / 光斑 / 烟雾 / 尘埃氛围、逐字散落与归位、行间过渡、关键词染色、混响与光晕，带独立「文字设置」面板 |
| 播放效果 · 房间 | 3D 房间氛围特效：粒子 / 流星、多入射角光柱（斜光 / 交叉 / 仰光 / 彩虹）与自动轮换、烟雾无缝循环、40+ 项可调与实时预览 |
| 播放效果 · 唱片 | 黑胶唱片整页场景：中心封面贴纸、不规则环纹、整盘旋转（转速 1–78 RPM、方向可切）、唱臂与暂停抬臂、唱片大小 / 位置、歌词位置、背景 / 尘埃 / 反光等 40+ 项可调，带独立实时预览页 |
| 启动自动播放 | 设置「打开软件直接播放」：可选今日推荐 / 我喜欢的音乐 / 指定歌单（多平台自动合并），打开软件即进入播放 |
| 音效 | 10 段图形均衡器（7 预设 + 频响曲线拖拽）、播放 / 暂停渐变、人声保留淡出、实时频谱 |
| 无缝衔接 | 双 deck 播放、BPM / 强拍对齐、WSOLA 变速不变调（±12%）、淡化终点对齐下一首开始唱词、自动跳过曲尾静音、人声 / 伴奏分离、过渡时长自动计算、「正在无缝过渡到 X」提示（列表循环模式） |
| 节拍分析（实验） | 宿主离线分析 BPM / 拍号 / 拍点 / 乐句 / downbeat / 可听结尾；设置页内置节拍器辅助核对 |
| 下载 | 多平台下载、下载音质选择（标准 / 高品质 / 无损）、下载队列面板、目录配置、完成提示与重试 |
| AirPlay 投送 | 局域网 AirPlay 2 / RAOP 设备发现与投送、多设备同时投送、音量控制、macOS 配对码支持 |
| 全局快捷键 | 播放暂停 / 上一首 / 下一首 / 显示隐藏窗口：录制、开关、恢复默认；组合被占用时自动回退；系统媒体键与键盘媒体键均可接管 |
| 后台常驻 | 关闭窗口隐藏到托盘、托盘菜单、迷你播放器、单实例运行 |
| 界面 | 白色磨砂设计体系、快捷设置面板（封面 / 歌词 / 设置 / 投送 / 下载）、设置居中弹窗、完整交互动画 |
| 自动更新 | 应用内检查、后台下载、SHA-256 校验、静默安装并自动重启；自动安装 / 仅提示两种策略与自动检查开关 |
| 分发 | GitHub Actions 在 tag 推送后自动构建安装包与便携版并发布 Release |

## 技术栈

| 层 | 技术 |
| --- | --- |
| 宿主 | .NET 10、WPF（`net10.0-windows10.0.19041.0`）、WindowChrome、PerMonitorV2 DPI、WinForms 托盘图标、RegisterHotKey 全局热键 |
| 容器 | Microsoft.Web.WebView2，本机虚拟主机映射（`https://zilux2.local`）+ v1 消息协议 |
| 前端 | Vite 7、TypeScript 5.9、原生 DOM / CSS；房间效果使用 Three.js（WebGL2），纯字 / 唱片为自研 Canvas 2D 渲染 |
| 音频 | Web Audio（10 段 Biquad 均衡器、淡入淡出、高低架滤波混音）、WASAPI loopback 采集与频谱分析 |
| 节拍 / 音频分析 | 宿主侧 MediaFoundation 解码 + FFT / 自相关 / 梳状 BPM 估计、尾端静音检测；前端 WSOLA 变速不变调 |
| 在线服务 | 宿主内嵌回环 HTTP 服务（仅绑定 `127.0.0.1`、动态端口、随机 token） |
| 投送 | AirPlay 2（HAP 配对、PTP 主时钟、加密 RTP / ALAC）与经典 RAOP，mDNS 设备发现 |
| 构建分发 | PowerShell 构建脚本、WinForms 安装器（payload 内嵌 zip）、GitHub Actions |

## 架构概览

```
┌──────────────────────────────────────────────────────┐
│                      Zilux2.exe                      │
│  WPF 宿主（窗口 / WebView2 / 本地 HTTP API / 更新）    │
│    ├─ 消息桥 v1  ⇄  WebView2 (https://zilux2.local)   │
│    ├─ 在线音乐 API      (127.0.0.1:<动态端口> + token) │
│    ├─ 本地曲库 / 下载 / 设置 / 节拍分析 / 更新服务      │
│    ├─ 托盘图标 + 全局热键 + 系统媒体会话               │
│    └─ AirPlay 发送端（mDNS / RTP / ALAC）              │
└──────────────────────────────────────────────────────┘
```

- **宿主**：窗口与动画、WebView2 生命周期、本机 HTTP API、文件 / 托盘 / 热键、系统媒体会话、节拍分析、自动更新与 AirPlay 投送。
- **前端**：单页应用，通过 `postMessage`（v1 协议）与宿主通信；在线数据经本地 HTTP API 获取，音频以 `<audio>` 双 deck 播放（无缝衔接时启用 Web Audio 混音图）。
- **更新**：宿主读取 `releases/latest`，下载 `Zilux2-Setup-<version>.exe` 并做 SHA-256 校验，随后以静默参数调用安装器完成升级。

## 目录结构

```
src/Zilux2/                WPF 宿主（窗口、WebView2、消息桥、在线/本地/设置/分析/更新/AirPlay/托盘/热键）
src/Zilux2.Installer/      WinForms 安装器（单文件，payload 内嵌）
web/                       前端（Vite + TypeScript）
web/src/ui/                播放器、歌词、播放效果（纯字 / 房间 / 唱片）、快捷设置、无缝衔接引擎等
web/src/core/              消息桥、设置、音频处理（EQ / 淡入淡出 / 混音图）
docs/                      契约与设计文档（宿主协议、在线音乐、更新通道、节拍分析等）
tools/                     构建、发布、自测与发版脚本
.github/workflows/         发布流水线（tag v* → 构建 → GitHub Release）
Directory.Build.props      ★ 版本号与默认更新源唯一来源
dist/Zilux2/               便携版输出（tools/publish.ps1 生成）
run-zilux2.cmd             双击启动（首次自动构建便携版）
```

## 环境要求

- Windows 10 1809 及以上 / Windows 11（x64）
- .NET SDK 10
- Node.js ≥ 22 与 pnpm
- WebView2 Evergreen Runtime（Windows 11 通常已内置）

## 构建

```powershell
# 前端
cd web
pnpm install
pnpm build

# 宿主 Debug 版（自动复制前端产物）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\build.ps1

# 便携版到 dist\Zilux2
powershell -NoProfile -ExecutionPolicy Bypass -File tools\publish.ps1

# 安装包（Version 缺省时读取 Directory.Build.props）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\make-installer.ps1
```

版本号唯一来源为根目录 `Directory.Build.props` 的 `<Version>`；宿主、安装器、Release 与更新检查均读取该值。

## 运行与自测

```powershell
# 运行 Debug 版
.\src\Zilux2\bin\Debug\net10.0-windows10.0.19041.0\Zilux2.exe

# 自动化自测（宿主 / 在线服务 / 设置 / 投送）
pwsh -File tools\selftest.ps1
pwsh -File tools\online-selftest.ps1
pwsh -File tools\settings-selftest.ps1
pwsh -File tools\airplay-selftest.ps1
```

前端独立调试：

```bash
cd web
pnpm dev        # http://127.0.0.1:5173
# 无宿主演示模式：http://127.0.0.1:5173/?mock=1
```

真机 UI 调试 / 自动化验收可通过 WebView2 远程调试：

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9223'
Start-Process "$env:LOCALAPPDATA\Programs\Zilux2\Zilux2.exe"
# http://127.0.0.1:9223/json/list → 目标页面 https://zilux2.local/
```

## 发布与自动更新

```powershell
# 1) 修改 Directory.Build.props 中的 <Version>
# 2) 提交后执行发版脚本（本地构建 + 可选打 tag + 推送）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\release.ps1 -Version 1.1.93 -Tag -Push
# 或手动：git tag v1.1.93 && git push origin v1.1.93
```

推送 `v*` tag 后，`.github/workflows/release.yml` 会在 `windows-latest` 上构建并发布 Release，产物包括：

- `Zilux2-Setup-<version>.exe`（安装包）
- `Zilux2-Setup-<version>.exe.sha256`（校验文件）
- `Zilux2-Portable-<version>.zip`（便携版）

客户端「设置 → 更新」可配置自动检查、更新策略（自动安装 / 仅提示）与更新源（默认 `KaFuuChino2006/Zilux2`）。

## 配置与数据目录

| 路径（`%LOCALAPPDATA%\Zilux2\`） | 内容 |
| --- | --- |
| `settings.json` | 应用设置（外观 / 播放 / 音效 / 下载 / 快捷键 / 更新等），删除即恢复默认 |
| `account.json` | 网易云 / QQ 音乐登录凭据（DPAPI 加密） |
| `logs/host.log` | 宿主运行日志（在线服务端口、热键、托盘、节拍分析、更新等） |
| `updates/` | 已下载的更新安装包 |
| `analysis/` | 节拍分析缓存（音频切片 + JSON，按 mtime 自动淘汰） |
| `airplay/pairing` | AirPlay 配对凭据（删除后需重新配对） |

## 文档

| 文档 | 说明 |
| --- | --- |
| `docs/zilux2-host-contract.md` | 宿主 ⇄ 前端消息协议 v1（含音频、媒体会话、AirPlay、更新） |
| `docs/zilux2-online-music.md` | 在线音乐 API 契约 |
| `docs/zilux2-settings-contract.md` | 设置模型契约（含 shortcuts 段） |
| `docs/zilux2-update-channel.md` | 自动更新通道（版本、协议、发版流程） |
| `docs/zilux2-beat-analysis-contract.md` | 节拍分析接口 `/api/analysis` 契约 |
| `docs/zilux2-github-setup.md` | 仓库初始化与首次发布说明 |
| `docs/zilux2-account-login.md` / `docs/zilux2-library.md` | 账号登录 / 个人音乐库契约 |
| `docs/zilux2-design-system.md` | 白色磨砂设计体系 |
| `docs/zilux2-songgrid.md` / `docs/zilux2-nowplaying.md` | 3D 歌单详情 / 沉浸播放页契约 |
| `docs/release-notes/` | 各版本更新日志 |
| `research/qa/` | 真机 CDP 自动化回归套件（播放器 / 下载 / 更新 / 无缝衔接 / 播放效果等） |

## 已知限制

- 仅支持 Windows x64，依赖 WebView2 Runtime；暂无移动端与跨平台计划。
- 安装包未做代码签名，首次运行可能出现 SmartScreen 提示。
- **项目由 AI 全程开发，难免存在动效异常或偶发 bug，敬请谅解；问题欢迎提交 Issues。**
- 在线曲目受平台版权与账号权益限制，无权限时返回 403 并在界面明确提示；QQ 音乐搜索主接口偶发 500，会自动回退备用接口。
- 无缝衔接为 B 版 Phase 1：仅在「列表循环」模式生效；WSOLA 变速范围 ±12%，超出范围不做变速对齐；开启均衡器 / 人声保留淡出 / 歌词页频谱等 Web Audio 音效时使用图内混音路径，否则回退元素音量；自动过渡依赖宿主节拍分析，首次分析约需 1–5 秒。
- 节拍分析为实验特性，BPM / 拍号置信度对稀疏素材可能偏低；节拍器为辅助核对工具，不作专业节拍器使用。
- AirPlay 部分设备型号与固件存在差异，首次连接需配对。

## 许可与致谢

本项目开源，代码可自由使用、修改、分发（含商用），保留原作者版权声明即可。

> **说明**：「纯字」播放效果的歌词渲染部分曾参考 / 改编自 Folia（[chthollyphile/folia-major](https://github.com/chthollyphile/folia-major)，AGPL-3.0）。该部分及相关文件版权归原作者所有，遵循 AGPL-3.0 许可；后续版本已推进自研渲染替换，历史版本与包含该部分代码的构建仍按 AGPL-3.0 约束使用。

架构与工程方法参考了以下开源项目（未复制其界面资源）：

- Rhine Music Windows（MIT）
- Folia（AGPL-3.0，歌词渲染代码来源，见上方说明）
- Mineradio（GPL-3.0，参考设计思路）

开发工具：

- **DeepSeek Harness** —— 本项目全程使用的 AI Agent 编程环境。
