# Zilux2 里程碑 1 · 启动界面与首页

> 交付日期：2026-10-18 · 宿主 `v0.1.0` · 前端里程碑 `0.1`
> 本文档记录「启动界面 + 首页」这一里程碑的实现范围、运行方式、验收证据与下一步计划。

## 1. 目标与范围

按用户指令（2026-10-18）：**先把 Zilux2 沉浸式音乐 app 的启动界面和首页做出来，其他功能先不需要做**。

本里程碑交付：

| 交付物 | 说明 |
| --- | --- |
| 启动动画（Splash） | WebGL2（Three.js）粒子星河 + 品牌字标逐字浮现 + 加载进度 + 点击/按键跳过，2.6 s 自动进入首页 |
| 首页（Home） | 自定义标题栏、左侧导航栏、搜索框、本周精选 3D 封面环、继续聆听、为你推荐、最近播放、底部播放条（演示数据） |
| 3D 封面环（Hero） | Three.js 场景：10 张封面组成弧形环 + 镜面倒影 + 自动缓转 + 拖拽旋停 + 左右翻页 + 程序化封面 |
| WPF 宿主 | 无边框窗口 + WebView2 + 消息桥（ready / window 动作 / drag / log / windowState 回推） |
| 工程化 | web 端 Vite + TypeScript 构建；宿主 `tools/build.ps1`、`run.ps1`、`selftest.ps1`（42 项自动验收） |

不在本里程碑内：真实音频播放、媒体库扫描、逐字歌词、3D 歌词舞台、3D 歌单架、设置/托盘/安装包。

## 2. 运行方式

前端（浏览器调试）：

```bash
cd web
pnpm install        # 首次
pnpm dev            # http://127.0.0.1:5173
pnpm build          # 产物进 web/dist
```

桌面（真实宿主 + WebView2）：

```powershell
# 构建宿主并把 web/dist 复制进输出目录
powershell -NoProfile -ExecutionPolicy Bypass -File tools\build.ps1

# 启动（默认加载 exe 旁 web/）
.\src\Zilux2\bin\Debug\net10.0-windows10.0.19041.0\Zilux2.exe

# 或走脚本（支持 -DevUrl / -WebDir / -Dev / -SkipBuild）
pwsh -File tools\run.ps1

# 宿主自动验收（42 项）
pwsh -File tools\selftest.ps1
```

环境要求：.NET SDK 10.0.401（`E:\dotnet\dotnet.exe`）、WebView2 Evergreen Runtime（本机 155.0.4283.60）、Node ≥ 22（本仓库用 v24.21.0 + pnpm 11）。

## 3. 架构

### 3.1 分层

```
Zilux2.exe (WPF, net10.0-windows10.0.19041.0)
└─ MainWindow（WindowChrome 无边框，PerMonitorV2）
   └─ WebView2（UDF=%LOCALAPPDATA%\Zilux2\WebView2）
      └─ https://zilux2.local/index.html（虚拟主机映射到 web 目录）
         └─ 前端（Vite + TypeScript + Three.js + 原生 DOM/CSS）
```

- 内容源优先级（契约 §3.3）：`ZILUX2_DEV_URL` → `ZILUX2_WEB_DIR` → `<exe>\web` → 弹框退出（退出码 2）。
- 页面 → 宿主消息：`{v:1,type:'window',action:'minimize'|'toggleMaximize'|'close'}`、`{type:'drag'}`、`{type:'log',level,message}`、`{type:'ready'}`。
- 宿主 → 页面：`{type:'host',event:'ready'|'windowState',maximized,...}`。
- 日志：`%LOCALAPPDATA%\Zilux2\logs\host.log`。

### 3.2 前端结构（web/src）

| 文件 | 职责 |
| --- | --- |
| `main.ts` | 启动序列：创建 Splash（粒子画布）→ 预置首页 DOM → 播放开场 → 淡出后销毁画布 |
| `bridge.ts` | 宿主桥：`ready/minimize/toggleMaximize/close/drag/log`，非宿主环境可用 |
| `data/catalog.ts` | 演示曲库：10 张专辑、继续聆听/推荐/歌单/曲目数据 |
| `ui/covers.ts` | 程序化封面绘制（Canvas2D，无外部图片资源） |
| `ui/icons.ts` | 内联 SVG 图标集 + 品牌 Z 标识 |
| `ui/splash.ts` | Splash 时间轴（阶段文案、进度、跳过） |
| `ui/home.ts` | 首页装配、事件绑定、宿主消息、快捷键（Ctrl+K / Space / Esc） |
| `ui/player.ts` | 演示播放条（进度模拟、播放/暂停/切歌/循环） |
| `three/splashScene.ts` | 启动粒子场景（1700 点 shader + 3 层光环 + 径向流动） |
| `three/heroScene.ts` | 3D 封面环（弧形排布、拖拽惯性、吸附、镜像倒影、像素预算） |
| `three/quality.ts` | 像素预算 → DPR 选值（上限 2、下限 0.65、预算 ≈4.2 MP） |
| `styles/*.css` | tokens/base/splash/home 四层样式 |

### 3.3 视觉与交互要点

- 深色沉浸底（#05060b）+ 紫/青/粉三色光斑，玻璃拟态面板；
- 启动页：粒子星河由中心向外爆散，品牌字标逐字出现，进度条 + 阶段文案（"绘制星河" → "准备你的舞台"），任意点击/按键跳过；
- 首页：Hero 左侧文案 + 右侧 3D 环；环自动缓慢旋转，鼠标拖拽带惯性并在卡片位置吸附；左右箭头与底部指示点同步；
- 卡片：程序化封面（渐变 + 几何纹理 + 噪点 + 标题文字），无任何外部图片依赖；
- 播放条：演示曲目 4:14，播放时封面叠加“音律”竖条动画，进度实时推进；
- 截图验收模式：URL 追加 `?snap=1` 跳过启动动画并冻结过渡，便于稳定截图。

## 4. 验收证据

### 4.1 宿主自测 42/42 全绿

`tools/selftest.ps1`（PowerShell 7）覆盖：窗口出现/可见、WebView2 初始化、导航完成、页面 ready、宿主消息回推、拖拽、左边缘缩放、最大化 clamp 到工作区 3440×1392、最小化/恢复、页面 close 退出码 0、缺失前端弹框退出码 2、日志时间戳/UDF 路径等。

### 4.2 实机运行日志（摘录）

```
[INFO] content.resolve source=bundled folder=...\bin\Debug\net10.0-windows10.0.19041.0\web
[INFO] webview2 runtime: 155.0.4283.60
[INFO] navigation completed: success=True status=Unknown uri=https://zilux2.local/index.html
[INFO] web:info web boot
[INFO] web:info splash finished
[INFO] web:info home mounted
[INFO] window.state maximized=True
```

### 4.3 截图

| 截图 | 说明 |
| --- | --- |
| `research/shots/z2-splash.png` | 启动界面（1600×960 实际窗口） |
| `research/shots/z2-home.png` | 首页（1600×960） |
| `research/shots/z2-home-playing.png` | 演示播放中（暂停图标、进度 0:03、封面音律动画） |
| `research/shots/z2-max.png` | 最大化（3440×1392，PrintWindow 截取，无桌面叠加层） |

## 5. 已知限制与风险

1. **音频为演示态**：播放条进度为计时器模拟，尚未接入真实音频/媒体会话。
2. **曲库为内置数据**：搜索、卡片点击、收藏等尚未接后端；3D 环只翻页，未跳到播放页。
3. **歌词/3D 歌词舞台未开始**（下一里程碑）。
4. **WebView2 ProcessFailed 恢复分支**已实现但未做真机注入验证；多显示器/150% DPI 未实测。
5. **打包**：暂只 Debug 输出，未配置单文件发布与安装器。
6. 3D 环在极低端 GPU 上未做降级回退（已内置像素预算与 DPR 上限，但没有 2D 兜底）。

## 6. 下一步计划（建议）

- **里程碑 2 · 播放页 + 3D 歌词舞台**：C# 侧 WASAPI 音频特征 → 消息桥推给前端；Three.js 歌词舞台原型（整行 Canvas2D 光栅贴图 + 逐词 shader 高亮）。
- **里程碑 3 · 3D 歌单架**：图集 + InstancedMesh + 窗口化渲染（借鉴 Mineradio 的 ±5 可见半径与显存预算）。
- **里程碑 4 · 媒体与歌词接入**：GSMTC 会话监听 + SMTC 时钟锚定；本地歌词引擎与在线歌词源。
- **里程碑 5 · 设置/托盘/单文件安装包**：沿用 v1 的经验但界面完全重做。

## 7. 便携版与一键启动

```powershell
# 构建前端 + 发布便携版（单文件 exe + 旁边 web 目录）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\publish.ps1

# 桌面/开始菜单快捷方式（指向 dist\Zilux2\Zilux2.exe）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\install-shortcut.ps1 -StartMenu
```

- 产物：`dist\Zilux2\Zilux2.exe`（单文件，含 WPF/WebView2 托管程序集）+ `dist\Zilux2\web\`（前端）；双击 exe 或快捷方式即可。
- 依赖：.NET 10 Desktop Runtime（本机已装）；如需完全免运行时依赖，用 `tools\publish.ps1 -SelfContained`（体积更大）。
- 仓库根目录 `run-zilux2.cmd` 可在没有 dist 时自动发布再启动。
- 应用图标由 `research/make_icon.py` 生成（`src/Zilux2/app.ico`，深色圆角 + 紫青渐变 Z）。
