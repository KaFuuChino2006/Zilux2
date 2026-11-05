# Zilux2 设置契约（Settings v1）

> 状态：v1 冻结 · 2026-10-18（v1.6 增量协议，最近更新 2026-11-04）
> 关联：`docs/zilux2-host-contract.md`（消息通道）、`docs/zilux2-online-music.md`（在线服务）
> 本文档是在宿主契约 v1 之上的**增量协议**，不修改既有消息语义。

## 1. 概述

设置由**宿主持久化**（JSON 文件），前端负责呈现与即时应用；浏览器调试（无宿主）时前端用 `localStorage` 镜像，行为一致。

- 持久化路径：`%LOCALAPPDATA%\Zilux2\settings.json`（UTF-8 无 BOM，缩进 2）
- 版本：`version: 1`
- 合并策略：**深度合并**。加载时缺失字段取默认值、非法值回落默认值；`patch` 时缺失字段保持不变、非法值保留**当前值**（不是硬编码默认值）；不报错、不阻断启动。
- 未知键：加载时忽略，但**保留写回**（宿主不主动删除不能识别的顶层/内层键），以兼容未来版本；只含未知键的 `patch` 不触发保存。`reset` 同样保留未知键。
- 写入策略：宿主侧 300 ms 去抖；原子写（临时文件 + `File.Replace`/`File.Move`）；进程退出前 flush。保存失败最多自动重试 3 次（2 s / 4 s / 6 s），并清理 `.tmp`；重试仍失败只记日志，不阻断应用。
- 损坏处理：JSON 解析失败、根不是对象或 `version` 不识别 → 使用默认值，把原文件备份为 `settings.json.corrupt-<yyyyMMdd-HHmmss>[-N]`，日志 `[settings] load failed ...`。
- 读文件失败（权限/占用/杀软）≠ 文件损坏：宿主会尽量复制为 `settings.json.unreadable-<yyyyMMdd-HHmmss>[-N]`；如果连副本都做不了，本次会话**拒绝覆盖原文件**（日志 `[settings] save skipped: settings file was unreadable and no backup could be made`）。
- 日志：`[settings] load path=... version=1` / `[settings] patch keys=...` / `[settings] save ok` / `[settings] save retry scheduled attempt=N` / `[settings] reset` / `[settings] disposed`。

## 2. 设置模型（v1）

> v1.1 变更：界面主题固定为**白色磨砂（Frost）**。`theme` 字段仅保留以兼容旧数据，前端不再提供主题选择，旧值 `dark` / `midnight` / 未知值一律按 `frost` 呈现；宿主只持久化/回传该值，不再驱动主题切换。

```json
{
  "version": 1,
  "general": {
    "splash": true,
    "startMaximized": false,
    "autoLaunch": false,
    "autoStartHidden": true,
    "watchLocalFolder": true,
    "mediaSession": true,
    "desktopLyrics": false,
    "desktopLyricsLocked": false,
    "desktopLyricsFontSize": 40,
    "desktopLyricsTopmost": true,
    "desktopLyricsWeight": "normal",
    "desktopLyricsBackdropOpacity": 40,
    "backgroundLyrics": false,
    "desktopLyricsLeft": null,
    "desktopLyricsTop": null
  },
  "appearance": {
    "theme": "dark",
    "reduceMotion": false,
    "glow": true,
    "lyricsSize": "medium",
    "windowAnimation": "custom",
    "playerBarExpanded": false,
    "miniSize": "standard",
    "miniAlwaysOnTop": true
  },
  "playback": {
    "defaultSource": "netease",
    "searchLimit": 20,
    "volume": 0.72,
    "audioReactive": true,
    "quality": "high",
    "eqEnabled": false,
    "eqPreset": "flat",
    "eqGains": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    "fadeEnabled": false,
    "fadeMs": 450,
    "fadeOutMs": 450,
    "fadeInMs": 450,
    "fadeCurve": "smooth",
    "fadeVocal": false,
    "fadeVocalTailMs": 600,
    "sleepFadeSeconds": 15,
    "sleepAction": "pause"
  },
  "downloads": {
    "directory": "",
    "quality": "high",
    "maxConcurrent": 2,
    "fileNameTemplate": "{artist} - {title}",
    "openFolderWhenDone": false
  },
  "updates": {
    "autoCheck": true,
    "mode": "auto",
    "repo": "",
    "directConnection": false
  },
  "shortcuts": {
    "enabled": true,
    "alwaysHandleMediaKeys": true,
    "playPause": "Ctrl+Alt+Space",
    "prev": "Ctrl+Alt+Left",
    "next": "Ctrl+Alt+Right",
    "toggleWindow": "Ctrl+Alt+Z",
    "volumeUp": "",
    "volumeDown": "",
    "mute": "",
    "like": "",
    "mode": "",
    "mini": "",
    "desktopLyrics": "",
    "crossfade": ""
  }
}
```

### 2.1 general

| 键 | 类型 | 默认 | 允许值 / 约束 | 作用 / 宿主消费 |
| --- | --- | --- | --- | --- |
| `general.splash` | bool | `true` | — | 启动动画（前端消费） |
| `general.startMaximized` | bool | `false` | — | 宿主下次创建主窗口后最大化，并回推 `windowState` |
| `general.autoLaunch` | bool | `false` | — | 开机自启：写/删 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 的值 `Zilux2`；启动和 `general` patch/reset 后幂等 apply |
| `general.autoStartHidden` | bool | `true` | — | 自启命令行追加 ` --hidden`；宿主启动后驻留托盘（托盘不可用时回退显示） |
| `general.watchLocalFolder` | bool | `true` | — | 本地曲库目录监控；`false` 停 watcher，`true` 按当前目录恢复；手动扫描不受影响 |
| `general.mediaSession` | bool | `true` | — | Windows SMTC 媒体控制；宿主即时 Enable/Disable |
| `general.desktopLyrics` | bool | `false` | — | 旧版独立桌面歌词浮窗；与 `backgroundLyrics` 互斥 |
| `general.desktopLyricsLocked` | bool | `false` | — | 锁定后鼠标穿透；解锁入口见设置页 |
| `general.desktopLyricsFontSize` | int | `40` | `28 ~ 64` | 桌面歌词主行字号（副行 0.45 倍） |
| `general.desktopLyricsTopmost` | bool | `true` | — | 桌面歌词置顶 |
| `general.desktopLyricsWeight` | enum | `"normal"` | `normal` / `semibold` / `bold` | 桌面歌词字重 |
| `general.desktopLyricsBackdropOpacity` | int | `40` | `30 ~ 90` | 桌面歌词底色不透明度（百分比） |
| `general.backgroundLyrics` | bool | `false` | — | 桌面背景歌词层（第二个 WebView2，挂到桌面 WorkerW）；开启时软件内歌词页不显示歌词；与 `desktopLyrics` 互斥 |
| `general.desktopLyricsLeft` | number\|null | `null` | `-200000 ~ 200000`，有限数 | 桌面歌词上次关闭位置 X；`null`=未记录。MainWindow 关闭时 patch，启动优先恢复 |
| `general.desktopLyricsTop` | number\|null | `null` | `-200000 ~ 200000`，有限数 | 同上，Y 坐标 |

> 歌词互斥（v1.6）：`patch` 同时把两个歌词开关设为 `true` 时，`backgroundLyrics` 优先，宿主把 `desktopLyrics` 改回 `false` 并在同一次 ACK 中回推；加载时若文件里两者都为 `true`，同样保留 `backgroundLyrics`、关闭 `desktopLyrics`，日志 `[settings] load: desktopLyrics disabled because backgroundLyrics was enabled`。

### 2.2 appearance

| 键 | 类型 | 默认 | 允许值 / 约束 | 作用 / 宿主消费 |
| --- | --- | --- | --- | --- |
| `appearance.theme` | enum | `"dark"`（旧值） | `dark` / `midnight`；前端固定按 `frost` 呈现 | 仅兼容旧数据，宿主只持久化/回传 |
| `appearance.reduceMotion` | bool | `false` | — | 减少动效（前端消费） |
| `appearance.glow` | bool | `true` | — | 背景氛围光晕（前端消费） |
| `appearance.lyricsSize` | enum | `"medium"` | `small` / `medium` / `large` | 歌词面板字号（前端消费） |
| `appearance.windowAnimation` | enum | `"custom"` | `custom` / `native` | 窗口过渡；宿主每次创建/切换窗口时读取 |
| `appearance.playerBarExpanded` | bool | `false` | — | 底部播放条常驻展开（前端消费） |
| `appearance.miniSize` | enum | `"standard"` | `compact` / `standard` / `wide` | 迷你播放器尺寸；宿主在进入迷你模式时读取 |
| `appearance.miniAlwaysOnTop` | bool | `true` | — | 迷你播放器置顶；宿主在进入迷你模式时读取 |

### 2.3 playback

| 键 | 类型 | 默认 | 允许值 / 约束 | 作用 / 宿主消费 |
| --- | --- | --- | --- | --- |
| `playback.defaultSource` | enum | `"netease"` | `netease` / `qq` / `mvmp3` | 搜索面板默认来源（`mvmp3` 为实验源，仅用户开启实验功能后出现） |
| `playback.searchLimit` | int | `20` | `10` / `20` / `30` | 每次搜索返回条数 |
| `playback.volume` | number | `0.72` | `0.0 ~ 1.0`（保留两位） | 播放器默认音量 |
| `playback.audioReactive` | bool | `true` | — | 可视化的宿主 WASAPI 特征源；宿主音频服务读取 |
| `playback.quality` | enum | `"high"` | `standard` / `high` / `lossless` | 在线播放音质偏好；宿主只持久化/回传，页面请求 `/api/stream` 时协商 |
| `playback.eqEnabled` | bool | `false` | — | 10 段均衡器总开关（前端 Web Audio 消费） |
| `playback.eqPreset` | enum | `"flat"` | `flat` / `pop` / `rock` / `jazz` / `classical` / `vocal` / `bass` | 均衡器预设 |
| `playback.eqGains` | int[10] | 全 `0` | 每段 `-12 ~ 12` dB；数组长度必须为 10 | 各频段增益（31Hz…16kHz）；单个元素非法只回退该元素，整体结构不合法保留旧数组 |
| `playback.fadeEnabled` | bool | `false` | — | 播放/暂停音量渐变总开关（前端消费） |
| `playback.fadeMs` | int | `450` | `50 ~ 3000` | 旧版单一渐变时长；仅作为 fadeOutMs/fadeInMs 的迁移缺省值 |
| `playback.fadeOutMs` | int | `450` | `100 ~ 3000` 毫秒 | 暂停淡出时长 |
| `playback.fadeInMs` | int | `450` | `100 ~ 3000` 毫秒 | 开始播放淡入时长 |
| `playback.fadeCurve` | enum | `"smooth"` | `smooth` / `linear` / `exponential` | 渐变曲线 |
| `playback.fadeVocal` | bool | `false` | — | 人声保留淡出 |
| `playback.fadeVocalTailMs` | int | `600` | `0 ~ 3000` 毫秒 | 人声保留尾音 |
| `playback.sleepFadeSeconds` | int | `15` | `0 ~ 60` 秒；`0`=不渐弱 | 睡眠定时到点前渐弱时长 |
| `playback.sleepAction` | enum | `"pause"` | `pause` / `minimize` / `exit` | 睡眠定时到点动作 |

### 2.4 downloads

| 键 | 类型 | 默认 | 允许值 / 约束 | 作用 / 宿主消费 |
| --- | --- | --- | --- | --- |
| `downloads.directory` | string | `""` | 空串=系统「音乐」目录；非空必须是绝对路径（`Path.IsPathFullyQualified`） | 下载目录；宿主 provider 读取 |
| `downloads.quality` | enum | `"high"` | `standard` / `high` / `lossless` | 下载音质；不支持时平台自动降级 |
| `downloads.maxConcurrent` | int | `2` | `1 ~ 4` | 同时下载任务数 |
| `downloads.fileNameTemplate` | string | `"{artist} - {title}"` | 非空，≤120 字符，至少含 `{artist}` / `{title}` / `{id}` / `{quality}` 之一 | 文件名模板；非法字符由下载服务替换 |
| `downloads.openFolderWhenDone` | bool | `false` | — | 下载完成后自动打开目录 |

### 2.5 updates

| 键 | 类型 | 默认 | 允许值 / 约束 | 作用 / 宿主消费 |
| --- | --- | --- | --- | --- |
| `updates.autoCheck` | bool | `true` | — | 启动后自动检查更新，并每 4 小时轮询 |
| `updates.mode` | enum | `"auto"` | `auto` / `notify` | `auto`=自动下载并提示安装；`notify`=只提示 |
| `updates.repo` | string | `""` | `owner/repo`（3~140 字符，恰一个 `/`，字符 `A-Za-z0-9-_.`，两侧不得为 `.`/`..`）或空 | 覆盖编译期默认更新源 |
| `updates.directConnection` | bool | `false` | — | 直连 GitHub，绕过系统代理（代理出口被限流时使用） |

### 2.6 shortcuts

| 键 | 类型 | 默认 | 允许值 / 约束 | 作用 / 宿主消费 |
| --- | --- | --- | --- | --- |
| `shortcuts.enabled` | bool | `true` | — | 总开关；`false` 时宿主注销全部热键 |
| `shortcuts.alwaysHandleMediaKeys` | bool | `true` | — | 系统媒体键是否始终由 Zilux2 接管；`false` 时跟随系统当前播放器 |
| `shortcuts.playPause` | string | `"Ctrl+Alt+Space"` | 组合键字符串或 `""`，≤64 | 播放/暂停 |
| `shortcuts.prev` | string | `"Ctrl+Alt+Left"` | 同上；默认值保留候选回落 | 上一首 |
| `shortcuts.next` | string | `"Ctrl+Alt+Right"` | 同上；默认值保留候选回落 | 下一首 |
| `shortcuts.toggleWindow` | string | `"Ctrl+Alt+Z"` | 同上 | 显示/隐藏主窗口 |
| `shortcuts.volumeUp` | string | `""` | 同上 | 音量 + |
| `shortcuts.volumeDown` | string | `""` | 同上 | 音量 − |
| `shortcuts.mute` | string | `""` | 同上 | 静音切换 |
| `shortcuts.like` | string | `""` | 同上 | 喜欢当前歌曲 |
| `shortcuts.mode` | string | `""` | 同上 | 切换播放模式 |
| `shortcuts.mini` | string | `""` | 同上 | 进入/退出迷你播放器 |
| `shortcuts.desktopLyrics` | string | `""` | 同上 | 开关桌面歌词 |
| `shortcuts.crossfade` | string | `""` | 同上 | 交叉淡入淡出 |

> 组合键字符串格式（宿主解析，见 `src/Zilux2/Hotkeys/HotkeyBinding.cs`）：
> 修饰键 `Ctrl`/`Control`、`Alt`、`Shift`、`Win`/`Meta`（大小写不限、顺序任意）+ 一个键名；
> 键名支持 `A-Z`、`0-9`、`F1-F24`、`Space`、`Tab`、`Enter`、`Esc`、`Backspace`、`Delete`、
> `Insert`、`Home`、`End`、`PageUp`、`PageDown`、`Up`、`Down`、`Left`、`Right`。
> 至少要有 1 个修饰键，或键名是 `F1-F24`（单独 `F5` 合法；单独 `A`、`Space` 非法）。
> 宿主保存时只校验类型（必须为字符串）与长度（≤64），语法非法由注册阶段处理：
> **保留该动作上一次注册成功的组合**，不把一次手误变成热键失效。

> 版本变更：v1.2 新增 `updates`；v1.3 新增 `shortcuts`；v1.4 新增 `autoLaunch` / `watchLocalFolder`；
> v1.5 新增 `autoStartHidden` / `alwaysHandleMediaKeys`；v1.6 补齐 `mediaSession`、桌面/背景歌词、
> 迷你播放器、`audioReactive`、睡眠定时、下载段、`quality`、`directConnection`、八个扩展快捷键，
> 并明确加载/patch 的校验语义。

## 3. 消息协议（复用 host 通道 `{v:1,type,...}`）

### 3.1 页面 → 宿主

```json
{ "v": 1, "type": "settings", "action": "request" }
{ "v": 1, "type": "settings", "action": "patch", "patch": { "appearance": { "reduceMotion": true } } }
{ "v": 1, "type": "settings", "action": "patch", "patch": { "shortcuts": { "prev": "Ctrl+Alt+Shift+Left" } } }
{ "v": 1, "type": "settings", "action": "reset" }
```

- `request`：请求当前快照（页面启动时即发送，不要求先 `ready`）。
- `patch`：局部更新；`patch` 为任意深度的部分对象；宿主校验后合并、持久化，并以 `settings` 事件回推完整快照（作为 ACK）。
- `reset`：恢复默认值（保留 `version` 与未知键），同样回推快照。

### 3.2 宿主 → 页面

```json
{ "v": 1, "type": "host", "event": "settings", "version": 1,
  "state": { "version": 1, "general": {...}, "appearance": {...}, "playback": {...},
             "downloads": {...}, "updates": {...}, "shortcuts": {...} } }
```

- 收到 `request` / 成功 `patch` / `reset` 后各回推一次完整快照；宿主主动修改设置（如桌面歌词窗关闭、歌词互斥）后也会补推。
- 页面 `ready` 后宿主可再主动推一次（确保首帧前到达；页面需幂等处理）。
- 页面在 900 ms 内未收到快照 → 使用默认值继续启动（不阻塞、不报错）。

### 3.3 宿主 → 页面：快捷键生效状态（v1.3 新增）

```json
{ "v": 1, "type": "host", "event": "shortcuts",
  "state": { "enabled": true, "items": [
    { "id": 1, "action": "playPause", "configured": "Ctrl+Alt+Space",
      "applied": "Ctrl+Alt+Space", "ok": true, "fallback": false, "error": "" },
    { "id": 2, "action": "prev", "configured": "Ctrl+Alt+Left",
      "applied": "Ctrl+Alt+Shift+Left", "ok": true, "fallback": true, "error": "" }
  ] } }
```

- 宿主每次应用 `shortcuts`（启动、`patch`/`reset` 命中该段、页面 `ready` 后补推）都会推送一次；
  页面可能收到重复状态，需幂等处理。
- `action`：设置键名（`playPause` / `prev` / `next` / `toggleWindow` / `volumeUp` / `volumeDown` /
  `mute` / `like` / `mode` / `mini` / `desktopLyrics` / `crossfade`），与前端 `ShortcutAction` 一致；
- `configured`：设置里的原始字符串（`""` 表示该条被关闭）；`applied`：实际注册成功的组合键
  （规范显示名，未注册为 `""`）；`ok`：是否已生效；`fallback`：实际组合与配置值不同
  （默认值候选回落，或非法配置保留了上一次可用注册）；`error`：未生效原因，取值
  `disabled` / `empty` / `invalid` / `error=<win32 错误码>` / `unavailable`，成功时为空串。
- 页面可用它显示「已生效 / 已回落到 X / 被占用 / 未启用」。该事件与 `settings` 快照相互独立：
  快照给配置值，本事件给宿主的实际注册结果。
- 日志：`hotkey.apply enabled=.. count=.. reason=..`、`hotkey.configured action=.. value=..`、
  `hotkey.register id=.. ok|failed ...`、`hotkey.hook fallback ...`。

## 4. 前端应用规则

启动顺序（`web/src/main.ts`）：

1. `settings.load()`：有宿主则发 `request`，900 ms 超时回落默认值；无宿主读 `localStorage['zilux2.settings']`。
2. 应用外观（`applySettings`）：`html[data-theme]`（固定 frost）、`reduce-motion`、`no-glow`、`lyrics-size-*` 类。
3. 依 `general.splash` 决定是否播放启动动画。
4. `mountHome()` 内部：Hero 自转 / 音量 / 歌词字号 / 歌词自动展开 / 默认来源 / 搜索条数 均从设置读取。
5. 设置面板修改 → `settings.patch()` → 立即应用 + 持久化（宿主或 localStorage）。

浏览器（无宿主）持久化：`localStorage` key `zilux2.settings`，写入去抖 200 ms。

## 5. 宿主应用规则

- `general.startMaximized`：宿主在**下一次**创建主窗口后应用（`WindowState=Maximized` 或等价 `ShowWindow`），并回推 `windowState`；与 `--hidden` 同时为真时窗口仍会先最大化再隐藏到托盘。
- `general.autoLaunch`（v1.4）：宿主启动时按当前值幂等 apply 一次；`patch`/`reset` 命中 `general` 段后立即重新 apply。
  - 实现：`HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 下值名 `Zilux2`，数据为 `"<当前 exe 全路径>"`（带引号）；
    `true`=写入/覆盖，`false`=删除该值；重复 apply 不产生重复项；关闭时只打开已有键，不凭空创建空键；
    日志 `[autolaunch] registered|unregistered|apply failed`。
  - `general.autoStartHidden`（v1.5）为 `true` 时命令追加 ` --hidden`；宿主启动看到该参数会照常初始化窗口与页面，
    但不透明、不占任务栏地 Show 后立刻 `HideToTray()`，日志 `[startup] hidden=true`；托盘不可用时回退为显示窗口。
  - 失败不阻断启动（例如注册表被策略限制），页面仍以快照里的值为准。
  - 自测可通过环境变量 `ZILUX2_AUTOLAUNCH_RUN_KEY` 指向隔离子键，避免写用户真实 Run 项。
- `general.watchLocalFolder`（v1.4）：`false` 时宿主停止本地曲库目录监控（先 `StopFolderWatch`），`true` 时按当前曲库目录重新开始；
  切换即时生效，不需要重启；手动扫描/刷新不受影响。日志 `[local] watch disabled by settings` / `watch enabled by settings`。
- `general.mediaSession`：宿主按值即时 `Enable`/`Disable` Windows SMTC；关闭后不影响 `alwaysHandleMediaKeys=true` 的媒体键接管。
- `general.desktopLyrics` / `general.backgroundLyrics`：宿主分别懒创建旧桌面歌词浮窗和桌面背景歌词层；
  两者**互斥**：`patch` 打开一个会把另一个置 `false` 并在同一 ACK 中回推；加载时两个都为 `true` 则背景歌词优先并记日志。
  桌面歌词的 `desktopLyricsFontSize`（28~64）、`desktopLyricsBackdropOpacity`（30~90）、
  `desktopLyricsWeight`、`desktopLyricsTopmost`、`desktopLyricsLocked` 由窗口应用；
  `desktopLyricsLeft/Top` 由主窗口在关闭桌面歌词时 patch，启动时优先恢复，未记录则用默认位置。
- `shortcuts` 段：由宿主解析并注册全局热键：
  - `enabled=false` → 注销全部热键；某条为 `""` → 只关闭该条；
  - 组合键语法见 §2；用户改过的组合只注册配置值；
  - 仍是默认值的 `prev`/`next`（`Ctrl+Alt+Left`/`Ctrl+Alt+Right`）保留候选回落链
    （`Ctrl+Alt+Shift+Left`/`Right` → `Ctrl+Alt+J`/`K`），避免被输入法/显卡驱动占用后彻底失效；
  - 重注册幂等（先注销再注册）；非法字符串保留该动作上一次可用注册；
  - 八个扩展动作同样由宿主注册并回推状态；每次应用后按 §3.3 回推状态。
- `shortcuts.alwaysHandleMediaKeys`（v1.5）：系统媒体键（VK_MEDIA_PLAY_PAUSE / PREV / NEXT，含键盘驱动
  映射成这些媒体键的自定义键）由 `MediaKeyHookService` 的全局底层键盘钩子接管：
  - `true`（默认）→ 不看「本机是不是 Windows 当前媒体会话」，一律吞键并走自家命令链（日志 `mediakey.fire`）；
  - `false` → 仅当本机是当前媒体会话时接管，其余放行给系统当前播放器（原生行为）；
  - 快捷键总开关 `shortcuts.enabled=false` 时同样不接管；部分驱动投递的 `WM_APPCOMMAND` 兜接按同一判据
    （日志 `[appcommand] ... ours=.. always=..`）。切换即时生效，不需要重启。
- `updates.autoCheck` / `mode` / `repo` / `directConnection`：更新服务启动后每 4 小时轮询；`autoCheck=false` 只停止自动检查，
  手动检查仍可用；`mode=auto` 自动下载，`notify` 只提示；`directConnection=true` 时 HTTP 客户端绕过系统代理。
- `downloads.directory`：非空必须是绝对路径，宿主原样保存（不要求目录此刻存在）；下载 provider 读取该值。
- 其余字段（`playback.*` 前端 Web Audio、`appearance` 呈现类、`general.splash` 等）由前端解释；
  宿主对它们只做持久化与快照回传，不改写用户值。
- 设置服务随宿主启动创建，早于 WebView2 初始化；不因设置文件损坏而失败退出。
- 读取/保存失败保护：加载读失败先尝试 `.unreadable-*` 备份；备份失败时会话内拒绝覆盖原文件；
  保存失败按 §1 重试，仍失败只记日志。

## 6. 非目标（本版不做）

- 账号 / 云同步、i18n、代理配置 UI、窗口尺寸记忆（仅 `startMaximized`）。
- 主题包 / 自定义配色（v1.1 起界面固定白色磨砂，无主题选择）。
- 快捷键的多套方案/按场景切换（v1.3 只做一组全局快捷键）。

## 7. 验收

宿主侧 `tools/settings-selftest.ps1`（Windows PowerShell 5.1 与 PowerShell 7+ 均可运行，随宿主 selftest 一起跑）：

1. 首次启动无文件 → 返回默认快照，文件不存在不报错。
2. `patch` 后回推快照包含新值，文件落盘可读且为合法 JSON。
3. 重启宿主后 `request` 返回上次 patch 的值（持久化）。
4. `patch` 非法类型（如 `volume: "loud"`）→ 不崩溃，保留当前值（全新配置下即默认值）。
5. `reset` → 文件与快照均为默认值，未知顶层/内层键保留写回。
6. 写入损坏 JSON → 启动成功、使用默认值、生成 `.corrupt-*` 备份、日志含 `load failed`。
7. 设置消息不影响既有 `ready` / `windowState` / 在线服务流程。
8. `shortcuts`：`patch` 后宿主重新注册热键并回推 `shortcuts` 状态事件；`enabled=false` 后热键全部失效；
   非法组合保留上一次可用注册且状态 `fallback=true`；`reset` 后恢复默认热键（默认值可回落候选链）。
9. `general.autoLaunch`（v1.4）：`patch {general:{autoLaunch:true}}` 后注册表出现 `Run\Zilux2` 且值为带引号的 exe 全路径
   （`general.autoStartHidden` 为 `true` 时末尾追加 ` --hidden`）；置 `false` 后该值被删除；重复 patch 不报错。启动宿主时按设置幂等 apply。
10. `general.watchLocalFolder`（v1.4）：`patch {general:{watchLocalFolder:false}}` 后日志出现 `watch disabled by settings`；
    置回 `true` 后日志出现 `watch enabled by settings`。
11. `shortcuts.alwaysHandleMediaKeys`（v1.5）：`patch` 后快照与 `hotkey.apply ... reason=settings` 反映新值，不需要重启；
    置 `false` 时媒体键交给系统当前播放器，置 `true` 时在任何前台窗口都走 `mediakey.fire`（后两条为人工验证）。
12. 加载时 `desktopLyrics` 与 `backgroundLyrics` 同时为 `true` → 只保留 `backgroundLyrics`，日志含
    `load: desktopLyrics disabled because backgroundLyrics was enabled`。
13. 设置文件被占用/不可读 → 不覆盖原文件；能备份时生成 `.unreadable-*`，不能备份时日志
    `save skipped: settings file was unreadable and no backup could be made`。

> 第 9、10、11 条已由脚本覆盖注册表/日志/快照部分；第 11 条「实际按键路由」仍需人工在媒体键场景验证。
> 前端侧（手工/截图验收）：
>
> - 设置面板 5 个分类可切换，改动即时生效（减少动效、主题、歌词字号、音量、默认源）。
> - 重启应用后设置保持（宿主持久化）。
> - 关闭 `general.splash` 后下一次启动直接进入首页。
> - 3440×1392 与 1600×960 两档截图无溢出、无遮挡。
