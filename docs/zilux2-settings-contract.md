# Zilux2 设置契约（Settings v1）

> 状态：v1 冻结 · 2026-10-18
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
    "startMaximized": false
  },
  "appearance": {
    "theme": "dark",
    "reduceMotion": false,
    "glow": true,
    "heroAutoRotate": true,
    "lyricsSize": "medium"
  },
  "playback": {
    "defaultSource": "netease",
    "searchLimit": 20,
    "lyricsAutoOpen": true,
    "volume": 0.72
  },
  "updates": {
    "autoCheck": true,
    "mode": "auto",
    "repo": ""
  }
}
```

| 键 | 类型 | 默认 | 允许值 / 约束 | 作用 |
| --- | --- | --- | --- | --- |
| `general.splash` | bool | `true` | — | 启动动画（关闭则直接进首页） |
| `general.startMaximized` | bool | `false` | — | 宿主下次启动时最大化窗口 |
| `appearance.theme` | enum | `"dark"`（旧值） | 前端固定按 `frost`（白色磨砂）呈现；`dark` / `midnight` 仅为历史值兼容 | 主题（v1.1 起仅白色磨砂，不再暴露选择项） |
| `appearance.reduceMotion` | bool | `false` | — | 减少动效（关闭入场/过渡/粒子与 3D 自动旋转） |
| `appearance.glow` | bool | `true` | — | 背景氛围光晕 |
| `appearance.heroAutoRotate` | bool | `true` | — | 首页 3D 封面环缓慢自转 |
| `appearance.lyricsSize` | enum | `"medium"` | `small` / `medium` / `large` | 歌词面板字号 |
| `playback.defaultSource` | enum | `"netease"` | `netease` / `qq` | 搜索面板默认来源 |
| `playback.searchLimit` | int | `20` | `10` / `20` / `30` | 每次搜索返回条数 |
| `playback.lyricsAutoOpen` | bool | `true` | — | 在线播放时自动展开歌词面板 |
| `playback.volume` | number | `0.72` | `0.0 ~ 1.0`（保留两位） | 播放器默认音量 |
| `updates.autoCheck` | bool | `true` | — | 启动后自动检查更新，并每 4 小时轮询 |
| `updates.mode` | enum | `"auto"` | `auto` / `notify` | `auto`=自动下载并提示安装；`notify`=只提示新版本 |
| `updates.repo` | string | `""` | `owner/repo` 或空 | 覆盖编译期默认更新源；空=用内置默认值 |

> v1.2 变更（2026-10-23）：新增 `updates` 段（GitHub 自动更新通道），宿主与前端都已实现；旧版 setting.json 缺该段时按默认值补齐，不影响兼容。

未知键：忽略并保留写回（宿主不主动删除不能识别的键，以兼容未来版本）。

## 3. 消息协议（复用 host 通道 `{v:1,type,...}`）

### 3.1 页面 → 宿主

```json
{ "v": 1, "type": "settings", "action": "request" }
{ "v": 1, "type": "settings", "action": "patch", "patch": { "appearance": { "reduceMotion": true } } }
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
- 其余设置只存不解释（前端应用），宿主不做二次校验、不改写用户值。
- 设置服务随宿主启动创建，早于 WebView2 初始化；不因设置文件损坏而失败退出。

## 6. 非目标（本版不做）

- 账号 / 云同步、i18n、开机自启、代理配置 UI、快捷键自定义、窗口尺寸记忆（仅 `startMaximized`）。
- 主题包 / 自定义配色（v1.1 起界面固定白色磨砂，无主题选择）。

## 7. 验收

宿主侧 `tools/settings-selftest.ps1`（新增，随宿主 selftest 一起跑）：

1. 首次启动无文件 → 返回默认快照，文件不存在不报错。
2. `patch` 后回推快照包含新值，文件落盘可读且为合法 JSON。
3. 重启宿主后 `request` 返回上次 patch 的值（持久化）。
4. `patch` 非法类型（如 `volume: "loud"`）→ 回落默认值且不崩溃。
5. `reset` → 文件与快照均为默认值。
6. 写入损坏 JSON → 启动成功、使用默认值、生成 `.corrupt-*` 备份、日志含 `load failed`。
7. 设置消息不影响既有 `ready` / `windowState` / 在线服务流程。

前端侧（手工/截图验收）：

- 设置面板 5 个分类可切换，改动即时生效（减少动效、主题、歌词字号、音量、默认源）。
- 重启应用后设置保持（宿主持久化）。
- 关闭 `general.splash` 后下一次启动直接进入首页。
- 3440×1392 与 1600×960 两档截图无溢出、无遮挡。
