# Zilux2 设置契约（Settings v1）

> 状态：v1 冻结 · 2026-10-18（v1.2 ~ v1.4 为增量协议，最近更新 2026-10-25）
> 关联：`docs/zilux2-host-contract.md`（消息通道）、`docs/zilux2-online-music.md`（在线服务）
> 本文档是在宿主契约 v1 之上的**增量协议**，不修改既有消息语义。

## 1. 概述

设置由**宿主持久化**（JSON 文件），前端负责呈现与即时应用；浏览器调试（无宿主）时前端用 `localStorage` 镜像，行为一致。

- 持久化路径：`%LOCALAPPDATA%\Zilux2\settings.json`（UTF-8 无 BOM，缩进 2）
- 版本：`version: 1`
- 合并策略：**深度合并**，未知字段忽略，缺失字段取默认值，非法值回落默认值（不报错、不阻断启动）
- 写入策略：宿主侧 300 ms 去抖；原子写（临时文件 + `File.Replace`）；进程退出前 flush
- 损坏处理：JSON 解析失败或 `version` 不识别 → 使用默认值，把原文件备份为 `settings.json.corrupt-<yyyyMMdd-HHmmss>`，日志 `[settings] load failed ...`
- 日志：`[settings] load path=... version=1` / `[settings] patch keys=...` / `[settings] save ok` / `[settings] reset`

## 2. 设置模型（v1）

> v1.1 变更（2026-10-18）：界面主题固定为**白色磨砂（Frost）**。`theme` 字段保留以兼容旧数据，但前端不再提供主题选择，旧值 `dark` / `midnight` / 未知值一律按 `frost` 呈现；宿主持久化值可暂时保持 `"dark"` 默认，下一版本再改为 `"frost"`。

```json
{
  "version": 1,
  "general": {
    "splash": true,
    "startMaximized": false,
    "autoLaunch": false,
    "watchLocalFolder": true
  },
  "appearance": {
    "theme": "dark",
    "reduceMotion": false,
    "glow": true,
    "heroAutoRotate": true,
    "lyricsSize": "medium",
    "windowAnimation": "custom",
    "playerBarExpanded": false
  },
  "playback": {
    "defaultSource": "netease",
    "searchLimit": 20,
    "lyricsAutoOpen": true,
    "volume": 0.72,
    "eqEnabled": false,
    "eqPreset": "flat",
    "eqGains": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    "fadeEnabled": false,
    "fadeMs": 450,
    "fadeOutMs": 450,
    "fadeInMs": 450,
    "fadeCurve": "smooth",
    "fadeVocal": false,
    "fadeVocalTailMs": 600
  },
  "updates": {
    "autoCheck": true,
    "mode": "auto",
    "repo": ""
  },
  "shortcuts": {
    "enabled": true,
    "playPause": "Ctrl+Alt+Space",
    "prev": "Ctrl+Alt+Left",
    "next": "Ctrl+Alt+Right",
    "toggleWindow": "Ctrl+Alt+Z"
  }
}
```

| 键 | 类型 | 默认 | 允许值 / 约束 | 作用 |
| --- | --- | --- | --- | --- |
| `general.splash` | bool | `true` | — | 启动动画（关闭则直接进首页） |
| `general.startMaximized` | bool | `false` | — | 宿主下次启动时最大化窗口 |
| `general.autoLaunch` | bool | `false` | — | 开机自启：宿主写/删 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 下的 `Zilux2` 值（命令为当前 exe 全路径加引号）；设置变更即时生效（v1.4 新增） |
| `general.watchLocalFolder` | bool | `true` | — | 本地曲库目录监控开关；`false` 时宿停止 `FileSystemWatcher`（新增/删除/改名不再自动刷新，手动「重新扫描」仍可用），改回 `true` 立即恢复监控（v1.4 新增） |
| `appearance.theme` | enum | `"dark"`（旧值） | 前端固定按 `frost`（白色磨砂）呈现；`dark` / `midnight` 仅为历史值兼容 | 主题（v1.1 起仅白色磨砂，不再暴露选择项） |
| `appearance.reduceMotion` | bool | `false` | — | 减少动效（关闭入场/过渡/粒子与 3D 自动旋转） |
| `appearance.glow` | bool | `true` | — | 背景氛围光晕 |
| `appearance.heroAutoRotate` | bool | `true` | — | 首页 3D 封面环缓慢自转 |
| `appearance.lyricsSize` | enum | `"medium"` | `small` / `medium` / `large` | 歌词面板字号 |
| `appearance.windowAnimation` | enum | `"custom"` | `custom` / `native` | 窗口过渡：应用内自绘 / Windows 原生 |
| `appearance.playerBarExpanded` | bool | `false` | — | 底部播放条常驻展开（不依赖鼠标悬停，始终显示进度/控制/封面） |
| `playback.defaultSource` | enum | `"netease"` | `netease` / `qq` | 搜索面板默认来源 |
| `playback.searchLimit` | int | `20` | `10` / `20` / `30` | 每次搜索返回条数 |
| `playback.lyricsAutoOpen` | bool | `true` | — | 在线播放时自动展开歌词面板 |
| `playback.volume` | number | `0.72` | `0.0 ~ 1.0`（保留两位） | 播放器默认音量 |
| `playback.eqEnabled` | bool | `false` | — | 10 段均衡器总开关；关闭时全部频段 0dB 直通 |
| `playback.eqPreset` | enum | `"flat"` | `flat` / `pop` / `rock` / `jazz` / `classical` / `vocal` / `bass` | 均衡器预设 |
| `playback.eqGains` | int[10] | 全 `0` | 每段 `-12 ~ 12` dB | 各频段增益（31Hz…16kHz） |
| `playback.fadeEnabled` | bool | `false` | — | 播放/暂停音量渐变总开关；关闭时瞬时暂停/播放 |
| `playback.fadeMs` | int | `450` | `50 ~ 3000`（旧版单一渐变时长，作为 fadeOutMs/fadeInMs 的迁移缺省值） | 兼容字段 |
| `playback.fadeOutMs` | int | `450` | `100 ~ 3000` 毫秒 | 暂停淡出时长 |
| `playback.fadeInMs` | int | `450` | `100 ~ 3000` 毫秒 | 开始播放淡入时长 |
| `playback.fadeCurve` | enum | `"smooth"` | `smooth` / `linear` / `exponential` | 渐变曲线；指数在尾段下降更快 |
| `playback.fadeVocal` | bool | `false` | — | 人声保留淡出：暂停时压低低频/高频，让人声频段多留一会儿 |
| `playback.fadeVocalTailMs` | int | `600` | `0 ~ 3000` 毫秒 | 人声保留尾音时长（淡出总时长 = fadeOutMs + 该值） |
| `updates.autoCheck` | bool | `true` | — | 启动后自动检查更新，并每 4 小时轮询 |
| `updates.mode` | enum | `"auto"` | `auto` / `notify` | `auto`=自动下载并提示安装；`notify`=只提示新版本 |
| `updates.repo` | string | `""` | `owner/repo` 或空 | 覆盖编译期默认更新源；空=用内置默认值 |
| `shortcuts.enabled` | bool | `true` | — | 全局快捷键总开关；`false` 时宿主注销全部热键 |
| `shortcuts.playPause` | string | `"Ctrl+Alt+Space"` | 组合键字符串或 `""` | 播放/暂停；空串=关闭该条 |
| `shortcuts.prev` | string | `"Ctrl+Alt+Left"` | 组合键字符串或 `""` | 上一首；空串=关闭该条；默认值保留候选回落 |
| `shortcuts.next` | string | `"Ctrl+Alt+Right"` | 组合键字符串或 `""` | 下一首；空串=关闭该条；默认值保留候选回落 |
| `shortcuts.toggleWindow` | string | `"Ctrl+Alt+Z"` | 组合键字符串或 `""` | 显示/隐藏主窗口；空串=关闭该条 |

> 组合键字符串格式（宿主解析，见 `src/Zilux2/Hotkeys/HotkeyBinding.cs`）：
> 修饰键 `Ctrl`/`Control`、`Alt`、`Shift`、`Win`/`Meta`（大小写不限、顺序任意）+ 一个键名；
> 键名支持 `A-Z`、`0-9`、`F1-F24`、`Space`、`Tab`、`Enter`、`Esc`、`Backspace`、`Delete`、
> `Insert`、`Home`、`End`、`PageUp`、`PageDown`、`Up`、`Down`、`Left`、`Right`。
> 至少要有 1 个修饰键，或键名是 `F1-F24`（单独 `F5` 合法；单独 `A`、`Space` 非法）。
> 宿主保存时只校验类型（必须为字符串）与长度（≤64），语法非法由注册阶段处理：
> **保留该动作上一次注册成功的组合**，不把一次手误变成热键失效。

> v1.2 变更（2026-10-23）：新增 `updates` 段（GitHub 自动更新通道），宿主与前端都已实现；旧版 setting.json 缺该段时按默认值补齐，不影响兼容。

> v1.3 变更（2026-10-25）：新增 `shortcuts` 段（全局快捷键）。与其余设置不同，该段**由宿主解析并注册**
> （见 §5），页面只负责编辑字符串；旧版 setting.json 缺该段时按默认值补齐，不影响兼容。

> v1.4 变更（2026-10-25）：`general` 段新增 `autoLaunch`（开机自启）与 `watchLocalFolder`（本地目录监控）。
> 两者都由宿主解释并即时应用（见 §5），页面只需读写设置值；旧版 setting.json 缺这两个键时按默认值补齐。

未知键：忽略并保留写回（宿主不主动删除不能识别的键，以兼容未来版本）。

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
- `reset`：恢复默认值（保留 `version`），同样回推快照。

### 3.2 宿主 → 页面

```json
{ "v": 1, "type": "host", "event": "settings", "version": 1,
  "state": { "version": 1, "general": {...}, "appearance": {...}, "playback": {...} } }
```

- 收到 `request` / 成功 `patch` / `reset` 后各回推一次完整快照。
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
- `action`：设置键名（`playPause` / `prev` / `next` / `toggleWindow`），与前端 `ShortcutAction` 一致；
- `configured`：设置里的原始字符串（`""` 表示该条被关闭）；`applied`：实际注册成功的组合键
  （规范显示名，未注册为 `""`）；`ok`：是否已生效；`fallback`：实际组合与配置值不同
  （默认值候选回落，或非法配置保留了上一次可用注册）；`error`：未生效原因，取值
  `disabled` / `empty` / `invalid` / `error=<win32 错误码>`，成功时为空串。
- 页面可用它显示「已生效 / 已回落到 X / 被占用 / 未启用」。该事件与 `settings` 快照相互独立：
  快照给配置值，本事件给宿主的实际注册结果。
- 日志：`hotkey.apply enabled=.. count=.. reason=..`、`hotkey.configured action=.. value=..`、
  `hotkey.register id=.. ok|failed ...`。

## 4. 前端应用规则

启动顺序（`web/src/main.ts`）：

1. `settings.load()`：有宿主则发 `request`，900 ms 超时回落默认值；无宿主读 `localStorage['zilux2.settings']`。
2. 应用外观（`applySettings`）：`html[data-theme]`、`reduce-motion`、`no-glow`、`lyrics-size-*` 类。
3. 依 `general.splash` 决定是否播放启动动画。
4. `mountHome()` 内部：Hero 自转 / 音量 / 歌词字号 / 歌词自动展开 / 默认来源 / 搜索条数 均从设置读取。
5. 设置面板修改 → `settings.patch()` → 立即应用 + 持久化（宿主或 localStorage）。

浏览器（无宿主）持久化：`localStorage` key `zilux2.settings`，写入去抖 200 ms。

## 5. 宿主应用规则

- `general.startMaximized`：宿主在**下一次**创建主窗口后应用（`WindowState=Maximized` 或等价 `ShowWindow`），并回推 `windowState`。
- `general.autoLaunch`（v1.4）：宿主启动时按当前值幂等 apply 一次；`patch`/`reset` 命中 `general` 段后立即重新 apply。
  - 实现：`HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 下值名 `Zilux2`，数据为 `"<当前 exe 全路径>"`（带引号）；
    `true`=写入/覆盖，`false`=删除该值；重复 apply 不产生重复项；日志 `[autolaunch] registered|unregistered|apply failed`。
  - 失败不阻断启动（例如注册表被策略限制），页面仍以快照里的值为准。
- `general.watchLocalFolder`（v1.4）：`false` 时宿主停止本地曲库目录监控（先 `StopFolderWatch`），`true` 时按当前曲库目录重新开始；
  切换即时生效，不需要重启；手动扫描/刷新不受影响。日志 `[local] watch disabled by settings` / `watch enabled by settings`。
- `shortcuts` 段：由宿主解析并注册全局热键（唯一由宿主解释的业务设置，v1.3 新增）：
  - `enabled=false` → 注销全部热键；某条为 `""` → 只关闭该条；
  - 组合键语法见 §2；用户改过的组合只注册配置值；
  - 仍是默认值的 `prev`/`next`（`Ctrl+Alt+Left`/`Ctrl+Alt+Right`）保留候选回落链
    （`Ctrl+Alt+Shift+Left`/`Right` → `Ctrl+Alt+J`/`K`），避免被输入法/显卡驱动占用后彻底失效；
  - 重注册幂等（先注销再注册）；非法字符串保留该动作上一次可用注册；
  - 每次应用后按 §3.3 回推状态。
- 其余设置只存不解释（前端应用），宿主不做二次校验、不改写用户值。
- 设置服务随宿主启动创建，早于 WebView2 初始化；不因设置文件损坏而失败退出。

## 6. 非目标（本版不做）

- 账号 / 云同步、i18n、代理配置 UI、窗口尺寸记忆（仅 `startMaximized`）。
- 主题包 / 自定义配色（v1.1 起界面固定白色磨砂，无主题选择）。
- 快捷键的多套方案/按场景切换（v1.3 只做一组全局快捷键）。

## 7. 验收

宿主侧 `tools/settings-selftest.ps1`（新增，随宿主 selftest 一起跑）：

1. 首次启动无文件 → 返回默认快照，文件不存在不报错。
2. `patch` 后回推快照包含新值，文件落盘可读且为合法 JSON。
3. 重启宿主后 `request` 返回上次 patch 的值（持久化）。
4. `patch` 非法类型（如 `volume: "loud"`）→ 回落默认值且不崩溃。
5. `reset` → 文件与快照均为默认值。
6. 写入损坏 JSON → 启动成功、使用默认值、生成 `.corrupt-*` 备份、日志含 `load failed`。
7. 设置消息不影响既有 `ready` / `windowState` / 在线服务流程。
8. `shortcuts`：`patch` 后宿主重新注册热键并回推 `shortcuts` 状态事件；`enabled=false` 后热键全部失效；
   非法组合保留上一次可用注册且状态 `fallback=true`；`reset` 后恢复默认热键（默认值可回落候选链）。
9. `general.autoLaunch`（v1.4）：`patch {general:{autoLaunch:true}}` 后注册表出现 `Run\Zilux2` 且值为带引号的 exe 全路径；
   置 `false` 后该值被删除；重复 patch 不报错。启动宿主时按设置幂等 apply。
10. `general.watchLocalFolder`（v1.4）：`patch {general:{watchLocalFolder:false}}` 后日志出现 `watch disabled by settings`，
    在曲库目录新增音频文件不再自动出现在列表（手动 rescan 仍可）；置回 `true` 后日志出现 `watch enabled by settings`，
    新增文件重新自动刷新。

> 第 9、10 条为 v1.4 手工验证项（`tools/settings-selftest.ps1` 本轮仍只覆盖第 1–8 条，未扩展脚本）。

前端侧（手工/截图验收）：

- 设置面板 5 个分类可切换，改动即时生效（减少动效、主题、歌词字号、音量、默认源）。
- 重启应用后设置保持（宿主持久化）。
- 关闭 `general.splash` 后下一次启动直接进入首页。
- 3440×1392 与 1600×960 两档截图无溢出、无遮挡。
