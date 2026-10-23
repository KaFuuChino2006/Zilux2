# Zilux2 里程碑 3 · 设置界面

> 版本：v0.3.0 · 2026-10-18
> 关联：`docs/zilux2-settings-contract.md`（Settings v1 契约）、`docs/zilux2-host-contract.md`（消息通道）

## 1. 目标与范围

里程碑 1（启动界面 + 首页）、里程碑 2（在线音乐）之后，应用缺少统一设置入口。本里程碑目标：

1. 宿主侧持久化设置（Settings v1）：JSON 文件、深度合并、非法值回落、去抖 + 原子写、损坏备份；
2. 前端设置面板：四个分类（常规 / 外观 / 播放 / 关于），修改即时生效并自动保存；
3. 设置真正驱动行为：启动动画开关、启动时最大化、主题（深色 / 极夜）、减少动效、氛围光晕、封面环自转、歌词字号、默认在线源、搜索条数、播放后自动展开歌词、默认音量；
4. `Ctrl+,` 与左侧导航「设置」两个入口；`?panel=settings` 用于截图与浏览器预览。

不在本里程碑：账号登录、音质选择、快捷键自定义、多语言、开机自启、主题自定义。

## 2. 运行方式

```powershell
# Debug 版（自动复制 web/dist）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\build.ps1
.\src\Zilux2\bin\Debug\net10.0-windows10.0.19041.0\Zilux2.exe

# 打开设置：左侧导航最下方「设置」按钮 / Ctrl+,
```

设置文件：`%LOCALAPPDATA%\Zilux2\settings.json`（UTF-8 无 BOM，缩进 2）。删除该文件即恢复出厂默认。

## 3. 架构

### 3.1 宿主侧（`src/Zilux2/Settings/`）

| 文件 | 职责 |
|---|---|
| `SettingsModel.cs` | `version:1` + `general/appearance/playback` 三组模型与默认值，严格对齐契约 §2 |
| `SettingsService.cs` | 加载 / 深度合并 / 校验回落 / 300 ms 去抖 / 原子写（临时文件 + `File.Replace`）/ 损坏备份 `settings.json.corrupt-<yyyyMMdd-HHmmss>` / 退出 flush；日志 `[settings] load|patch|save|reset` |
| `SettingsBridge.cs` | 处理页面消息 `{v:1,type:'settings',action:'request'|'patch'|'reset',patch?}`，回推 `{v:1,type:'host',event:'settings',version:1,state:{...}}` 完整快照；`request` 不要求页面先发 `ready`，页面 ready 后宿主再主动推一次（幂等） |

`App.xaml.cs` 启动时创建 `SettingsService`；`MainWindow` 创建窗口后按 `general.startMaximized` 应用最大化并回推 `windowState`；`WebViewHost` 注册消息处理与退出 flush。

### 3.2 前端（`web/src/`）

| 文件 | 职责 |
|---|---|
| `settings.ts` | 类型 + `DEFAULT_SETTINGS` + `normalizeSettings()`（白名单校验）+ `loadSettings()`（宿主 request，900 ms 超时回落 localStorage）+ `patchSettings()`（宿主 patch；无宿主时 200 ms 去抖写 localStorage）+ `resetSettings()` + `applySettings()`（写入 `html` 的 `data-theme` / `data-lyrics-size` / `.reduce-motion` / `.no-glow`）+ `onSettingsChange()` |
| `ui/settingsPanel.ts` | `createSettingsPanel()` → `{element, open(category?), close, toggle, isOpen, destroy}`；导航 + 内容分区 + 开关 / 分段 / 滑块 / 快捷键表 / 关于信息；`恢复默认`；`Esc` 关闭 |
| `styles/settings.css` | 浮层 + 玻璃面板（1000×680，窄屏自适应）、导航、行、开关、分段、滑块、快捷键、关于信息；`html[data-theme="midnight"]`、`html.reduce-motion`、`html.no-glow`、`html[data-lyrics-size]` 的全局钩子 |
| `bridge.ts` | 新增 `host.requestSettings()/patchSettings()/resetSettings()` 与 `HostMessage.state` |
| `ui/home.ts` | 挂载面板；左侧导航「设置」与顶栏设置按钮 → `openSettings()`；`Ctrl+,`；`Space` 在设置打开时不触发播放；设置变化时同步封面环自转 / 音量 / 歌词字号；`?panel=settings&cat=` QA 参数 |
| `main.ts` | `import './styles/settings.css'`；`loadSettings()` 先于 UI 启动；按 `general.splash` 与 `appearance.reduceMotion` 决定是否播放启动动画（`?splash=1/0` 可覆盖） |
| `three/heroScene.ts` | `setAutoRotate(enabled)`；开启时缓慢旋转，拖拽时暂停 |
| `ui/player.ts` | `Player.setVolume()` + 初始音量 |
| `ui/lyricsPanel.ts` | 自动展开受 `playback.lyricsAutoOpen` 控制 |
| `ui/searchPanel.ts` | 默认源、搜索条数由设置驱动 |

## 4. 设置条目

| 分类 | 条目 | 类型 | 默认 | 生效方式 |
|---|---|---|---|---|
| 常规 | 启动动画 | 开关 | 开 | 下次启动（关闭时跳过 Splash，直接进首页） |
| 常规 | 启动时最大化 | 开关 | 关 | 下次启动（宿主 `SW_MAXIMIZE`） |
| 常规 | 快捷键一览 | 只读 | — | Ctrl+K / Ctrl+, / Space / Esc |
| 外观 | 界面主题 | 深色 / 极夜 | 深色 | 立即（`html[data-theme]`） |
| 外观 | 减少动效 | 开关 | 关 | 立即（冻结过渡与入场动画，并自动暂停封面环自转） |
| 外观 | 氛围光晕 | 开关 | 开 | 立即（关闭极光/光斑，省电） |
| 外观 | 封面环自转 | 开关 | 开 | 立即（减少动效开启时禁用） |
| 外观 | 歌词字号 | 小 / 中 / 大 | 中 | 立即（歌词面板正文缩放） |
| 播放 | 默认在线源 | 网易云 / QQ 音乐 | 网易云 | 下次打开搜索面板 |
| 播放 | 每次搜索结果条数 | 10 / 20 / 30 | 20 | 下次搜索 |
| 播放 | 自动展开歌词 | 开关 | 开 | 下次在线播放 |
| 播放 | 默认音量 | 0–100% | 72% | 启动时应用，拖动即时生效 |
| 关于 | 版本 / 宿主 / 前端 / 存储位置 / 致谢与许可 | 只读 | — | — |

## 5. 验收证据

### 5.1 自动化

- `dotnet build`：0 警告 0 错误。
- `tools/settings-selftest.ps1`：**63 passed / 0 failed**（S1 request 早于 ready、S2 patch+落盘无 BOM、S3 重启持久化、S4 非法值回落、S5 reset、S6 损坏 JSON + corrupt 备份 + load failed、S7 startMaximized 生效并回推 windowState）。
- `tools/selftest.ps1`：**42 passed / 0 failed**（窗口 / WebView2 / 导航 / 桥 / 拖拽 / 缩放 / 最大化 / 最小化 / 退出码）。
- `tools/online-selftest.ps1`：**57 passed / 0 failed**（在线服务未回归；QQ 搜索增加主备端点兼容）。

### 5.2 真机截图（`research/shots/`）

- `m3-host-settings.png`：常规页（启动动画 / 启动时最大化 / 快捷键表）
- `m3-host-settings-appearance.png`：外观页（主题 / 减少动效 / 氛围光晕 / 封面环自转 / 歌词字号）
- `m3-host-settings-playback.png`：播放页（默认源 / 搜索条数 / 自动展开歌词 / 默认音量）
- `m3-settings-about.png`：关于页（版本 / 存储位置 / 致谢与许可）
- `m3-settings-midnight.png`：极夜 + 减少动效（自转自动禁用态）
- `m3-host-startmaximized.png`：启动时最大化生效（3440×1392）

### 5.3 端到端持久化验证

1. 真机点击「启动时最大化」→ 日志 `[settings] patch keys=general.startMaximized`、`[settings] save ok`，`settings.json` 中变为 `true`；
2. 关闭重启 → 窗口 `rect=(0,0)-(3440,1392)`，即工作区最大化；
3. 再点击关闭 → `patch keys=general.startMaximized`、`save ok`，文件回落为 `false`。

页面侧：启动即发送 `settings/request`，宿主日志记录 `[settings] request` 并回推完整快照（`[settings] load ... defaults (file missing)` 首次启动）。

## 6. 已知限制与风险

- 设置没有即时多窗口同步：目前只有一个窗口，未来多窗口需广播快照。
- 「减少动效」是全局 CSS 冻结 + 封面环停转，不改变 WebGL 渲染本身；低配机可叠加关闭「氛围光晕」。
- 启动动画关闭后仍保留约 200 ms 的淡入，避免白屏闪烁。
- 宿主侧 `startMaximized` 在 150% DPI / 多显示器下的行为按主显示器工作区处理，未单独实测多屏。
- 设置面板不拦截 Esc 以外的全局键；搜索面板打开时 Ctrl+, 仍可切到设置（层级为设置在上）。

## 7. 下一步

1. 播放页（大封面 + 频谱 + 逐字歌词）与 3D 歌词舞台（Three.js + Canvas2D 光栅整行贴图 + shader 逐词高亮）；
2. 3D 歌单架（InstancedMesh + 图集/纹理数组 + 窗口化）；
3. 媒体接入（SMTC/GSMTC 跟随、SMTC 播放进度、本机曲库）；
4. 桌面歌词层 / PV 播放画面（LibVLC 原生层）；
5. 设置扩展：快捷键自定义、主题色板、开机自启、高级性能档位。
