# Zilux2

> 沉浸式 Windows 桌面音乐播放器

Zilux2 是一款面向 Windows 的桌面音乐播放器。宿主采用 .NET 10 / WPF 承载 WebView2，界面与交互由 TypeScript 前端实现（Vite + Three.js），在保留桌面应用系统集成能力的同时获得现代 Web 的渲染与动画表现。

播放能力覆盖在线双源（网易云音乐 / QQ 音乐）、本地曲库、个性化音效与 AirPlay 多设备投送；分发侧内置基于 GitHub Releases 的自动更新通道。

---

## 功能特性

| 模块 | 能力 |
| --- | --- |
| 在线音乐 | 网易云音乐 / QQ 音乐搜索、播放、歌词（原文与翻译）、歌单；扫码登录与 Cookie 导入兜底 |
| 本地音乐 | 本地目录扫描、音频标签读取、封面提取、与下载曲目合并展示 |
| 播放体验 | 自定义播放条、滚动歌词面板、沉浸播放页（3D 歌词舞台）、Windows 媒体会话（SMTC）与媒体键 |
| 音效 | 10 段图形均衡器（7 个预设 + 频响曲线拖拽）；播放/暂停渐变可分别设置淡出/淡入时长、曲线（平滑/线性/指数）与「人声保留淡出」（暂停时先压低伴奏、人声多留一会儿）；实时频谱响应 |
| 投送 | AirPlay 2 与经典 RAOP；支持 HomePod、Mac 接收器；多设备同步投送与独立音量控制 |
| 界面 | 白色磨砂设计体系、设置居中弹窗与左侧导航、快捷设置面板、分段控件弹簧动画 |
| 下载 | 统一多平台下载、音质选择（标准 / 高品质 / 无损）、下载目录配置 |
| 更新 | 应用内检查、后台下载、SHA-256 校验、静默安装与自动重启；支持「自动安装 / 仅提示」两种策略 |
| 分发 | GitHub Actions 自动构建安装包并发布 Release；版本号统一注入宿主与安装器 |

## 技术栈

| 层 | 技术 |
| --- | --- |
| 宿主 | .NET 10、WPF（`net10.0-windows10.0.19041.0`）、WindowChrome、PerMonitorV2 DPI |
| 容器 | Microsoft.Web.WebView2 1.0.4191.47，本机虚拟主机映射（`https://zilux2.local`）+ v1 消息协议 |
| 前端 | Vite 7、TypeScript 5.9、Three.js r180（WebGL2）、原生 DOM/CSS |
| 音频 | Web Audio（10 段 Biquad 均衡器、淡入淡出）、WASAPI loopback 采集与频谱分析 |
| 在线服务 | 宿主内嵌回环 HTTP 服务（仅绑定 `127.0.0.1`、动态端口、随机 token） |
| 投送 | AirPlay 2（HAP 配对、PTP 主时钟、加密 RTP / ALAC）与经典 RAOP，mDNS 设备发现 |
| 构建分发 | PowerShell 构建脚本、WinForms 安装器（payload 内嵌 zip）、GitHub Actions |

## 架构概览

```
┌───────────────────────────────────────────────┐
│                   Zilux2.exe                  │
│  WPF 宿主（窗口 / WebView2 / 本地 HTTP API）   │
│    ├─ 消息桥 v1  ⇄  WebView2 (https://zilux2.local)
│    ├─ 在线音乐 API  (127.0.0.1:<随机端口> + token)
│    ├─ 本地曲库 / 下载 / 设置 / 更新服务
│    └─ AirPlay 发送端（mDNS / RTP / ALAC）
└───────────────────────────────────────────────┘
```

- **宿主**：负责窗口与动画、WebView2 生命周期、本机 HTTP API、文件与注册表访问、系统媒体会话及 AirPlay 发送。
- **前端**：单页应用，通过 `postMessage`（v1 协议）与宿主通信；在线数据经本地 HTTP API 获取，音频以 `<audio>` 播放。
- **更新**：宿主读取 `releases/latest`，下载 `Zilux2-Setup-<version>.exe` 并校验摘要，随后以静默参数调用安装器完成升级。

## 目录结构

```
src/Zilux2/                WPF 宿主（窗口、WebView2、消息桥、在线/本地/设置/更新/AirPlay）
src/Zilux2.Installer/      WinForms 安装器（单文件，payload 内嵌）
web/                       前端（Vite + TypeScript + Three.js）
docs/                      契约与设计文档（宿主协议、设置、在线音乐、更新通道等）
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
powershell -NoProfile -ExecutionPolicy Bypass -File tools\make-installer.ps1 -Version 1.1.1
```

当前版本：**1.1.1**，唯一来源为根目录 `Directory.Build.props` 的 `<Version>`；宿主、安装器、Release 与更新检查均读取该值（CI 通过 `-p:Version=<tag>` 覆盖）。

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

真机 UI 验收可通过 WebView2 远程调试：

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9223'
$env:ZILUX2_SETTINGS_PATH = 'E:\Zilux2开发\dist\qa-settings.json'   # 可选：隔离设置文件
Start-Process 'E:\Zilux2开发\dist\Zilux2\Zilux2.exe'
# http://127.0.0.1:9223/json/list → 目标页面 https://zilux2.local/
```

## 发布与自动更新

```powershell
# 1) 修改 Directory.Build.props 中的 <Version>
# 2) 提交后执行发版脚本（本地构建 + 打 tag + 推送）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\release.ps1 -Version 1.1.1
# 或手动：git tag v1.1.1 && git push origin v1.1.1
```

推送 `v*` tag 后，`.github/workflows/release.yml` 将在 `windows-latest` 上构建并发布 Release，产物包括：

- `Zilux2-Setup-<version>.exe`（安装包）
- `Zilux2-Setup-<version>.exe.sha256`（校验文件）
- `Zilux2-Portable-<version>.zip`（便携版）

客户端「设置 → 更新」可配置自动检查、更新策略（自动安装 / 仅提示）与更新源（默认 `KaFuuChino2006/Zilux2`）。

> 注意：应用内更新通过 GitHub 匿名 API 查询 Release，**仓库需为公开仓库**才能生效；私有仓库仅用于代码托管，升级请手动安装。详见 `docs/zilux2-update-channel.md`、`docs/zilux2-github-setup.md`。

## 配置与数据目录

| 路径（`%LOCALAPPDATA%\Zilux2\`） | 内容 |
| --- | --- |
| `settings.json` | 用户设置（外观 / 播放 / 音效 / 下载 / 更新等），删除即恢复默认 |
| `account.json` | 网易云 / QQ 音乐登录凭据（DPAPI 加密） |
| `logs/host.log` | 宿主运行日志（在线服务端口、更新、投送等） |
| `updates/` | 已下载的更新安装包 |
| `airplay/pairing` | AirPlay 配对凭据（删除后需重新配对） |

## 文档

| 文档 | 说明 |
| --- | --- |
| `docs/zilux2-host-contract.md` | 宿主 ⇄ 前端消息协议 v1（含音频、媒体会话、AirPlay、更新） |
| `docs/zilux2-online-music.md` | 在线音乐 API 契约 |
| `docs/zilux2-settings-contract.md` | 设置模型契约 |
| `docs/zilux2-update-channel.md` | 自动更新通道（版本、协议、发版流程） |
| `docs/zilux2-github-setup.md` | 仓库初始化、首次发布与 SSH over 443 说明 |
| `docs/zilux2-account-login.md` / `docs/zilux2-library.md` | 账号登录 / 个人音乐库契约 |
| `docs/zilux2-design-system.md` | 白色磨砂设计体系 |
| `docs/zilux2-songgrid.md` / `docs/zilux2-nowplaying.md` | 3D 歌单详情 / 沉浸播放页契约 |
| `docs/Zilux2-里程碑*.md` | 各阶段交付说明与 AirPlay 投送协议细节 |
| `docs/Zilux2-三项目深度调研报告.md` | 参考项目技术调研（Rhine / Folia / Mineradio） |

## 已知限制

- 仅支持 Windows x64，依赖 WebView2 Runtime；暂无移动端与跨平台计划。
- 安装包未做代码签名，首次运行可能出现 SmartScreen 提示。
- 在线曲目受平台版权与账号权益限制，无权限时返回 403 并在界面明确提示；QQ 音乐搜索主接口偶发 500，会自动回退备用接口（首次耗时增加）。
- 私有仓库模式下自动更新不可用（匿名 API 无法读取私有 Release）；需要正式分发时请切换为公开仓库。
- AirPlay 部分设备型号与固件存在差异，首次连接需配对；详见里程碑 7 文档。

## 许可与致谢

本项目为私有项目，暂未附加开源许可证，保留所有权利。

界面与代码均为原创实现。架构与工程方法参考了以下开源项目，未复制其界面资源或源代码：

- Rhine Music Windows（MIT）
- Folia（AGPL-3.0，仅学习规格与思路，clean-room 实现）
- Mineradio（GPL-3.0，仅学习设计思路）
