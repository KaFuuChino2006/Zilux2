# 系统音频 / 音量 / 切歌 OSD

> 1.1.102

屏幕**上方居中**的一条胶囊，和播放条同高同宽上限，用来显示三类瞬时状态：切换系统输出设备、软件音量变化、后台切歌。

```text
        ╭──────────────────────────────────────────────╮
        │ 🔊 系统音频   上一台            正在使用     已切换 │
        │             扬声器    →   Realtek HD Audio 2nd output │
        │──────────────────────────────────────────────│
        ╰──────────────────────────────────────────────╯
```

## 形态

| 形态 | 触发 | 宽度 | 收起 |
| --- | --- | --- | --- |
| 设备切换 | 快捷键 / 设置页 / 页面 `setDefault` / 外部切换轮询 | 内容宽 + 40（300～900） | 2.8s |
| 应用内音量 | 页面 `appVolume` 消息（音量键、滑杆、静音） | 固定 188 | 1.3s |
| 后台切歌 | 页面 `media` 消息且窗口不在前台 | 内容宽 + 40（240～900） | 1.8s |
| 过渡中 | `media.transitioning === true` | 同上 | 1.8s |

- 「过渡中」是切歌形态的一个变体：状态词换成 `过渡中`，底部跑一条 3.2s 的过渡进度线。
- 切歌形态会显示真实封面（`coverUrl` → `SmtcArtwork.LoadImageAsync`），取不到时退回首字方块。
- 音量形态连续变化时只更新数字与底部细线，不重播动画、不重新计时之外的动作。

## 几何

- 窗口 1040×66 DIP，`Grid Margin=10` → `Stage`（初始 452×46，运行时按形态设宽）→ `Border Shell`（奶油 `#F7F4EC`，`CornerRadius=23`）→ `ContentLayer` → `ContentRoot Margin=18,0,18,0`。
- 位置：主窗口所在显示器工作区水平居中，`Top = WorkArea.Top + 26`，坐标取整。
- 高度恒 46；宽度随内容自适应。`FitExpandedWidth()` 用 `Detail.Measure(infinity)` 量内容，`clamp(desired + 40, 300, min(900, WorkArea.Width - 40))`。

## 动画

- **入场（从无到有）**：`PopIn(to)`，宽度从 104 弹到目标，620ms，`KeySpline(0.22,1.28,0.36,1)`；期间 `ContentLayer.Opacity = 0`，到 `PopMs * 0.42` 才开始 150ms 淡入 —— 看见文字时形状已完整，不会有半截字。
- **已在屏上换形态**：`StretchWidth(from,to,ms)` **宽度直接到位**（一帧），只做内容交叉淡入。宽度补间会让「按最终宽度排版」的内容超出当前胶囊被裁，这是历史 bug 的根因，已彻底去掉。
- **收起**：`Dismiss()` 先把文字 150ms 渐隐，宽度用 `DoubleAnimationUsingKeyFrames` 收成 **46×46 的正圆**（72% 处挤到 37 再弹回 46，380ms），随后整体淡出 170ms + 上移 8px。
- 裁剪用 `OnShellSizeChanged` 里的 `RectangleGeometry(rect, r, r)`（`r = min(23, min(w,h)/2)`），保证收回中途两端也是圆弧，不是直角切口。
- 文字不抖的三条保证：`PillStatus`/`StatusText`/`FromCaption`/`ToCaption` 都是固定宽度；换字只换文本不改列宽；宽度变化不做补间。

## 交互与生命周期

- 独立 Topmost 窗口，`WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE`，不抢焦点、不进任务栏；主窗口最小化时仍显示。
- 同一条胶囊上连续换形态：`PrepareMode()` 统一收口（停旧计时、清旧动画、冻结当前宽度、重置透明度），不会留下上一形态的残影或空壳。
- 主窗口在前台时**不显示切歌胶囊**（只看播放条）；判定用 Win32 `GetForegroundWindow()` 而不是 WPF `IsActive`。最小化后若当前曲目还没弹过，`OnStateChanged` 会补弹一次。

## 数据链路

- 页面 → 宿主：`{ v:1, type, payload }`，`type` ∈ `audioOutput` / `appVolume` / `media`。**消息体必须包在 `payload` 里**，扁平字段会被静默丢弃。
- `media` 的 `coverUrl` 由页面用 `onlineArtwork(track, 300)` 生成（带 `?token=` 的回环地址），宿主 `SmtcArtwork.LoadImageAsync` 解码。
- 页面侧换曲上报收口在 `player.ts` 的 `setState()`：`track` 变化时强制 `maybeReport(true)`，不依赖播放 tick 的 200ms 节流。

## 文件

- `src/Zilux2/SystemAudioOsdWindow.xaml` / `.xaml.cs`
- `src/Zilux2/MainWindow.xaml.cs`：`ShowSystemAudioOsd`、`ShowAppVolume`、`NotifyMediaTrack`、`IsForegroundWindow`、`MonitorWorkAreaDip`
- `src/Zilux2/WebViewHost.cs`：`HandleAudioOutputMessage`、`HandleAppVolumeMessage`、`HandleMediaMessage`
- `src/Zilux2/Media/SmtcArtwork.cs`：`LoadImageAsync`
- `src/Zilux2/Audio/SystemAudioOutputService.cs`
- 页面：`web/src/ui/player.ts`（`maybeReport` / `setState`）、`web/src/core/bridge.ts`（`reportAppVolume` / `reportMedia`）

## 验证

```text
dotnet build src/Zilux2/Zilux2.csproj -c Debug    0 warning / 0 error
node --test web/tests/*.test.cjs                  60 pass / 0 fail
```

实机截帧（`.scratch/`）：

- `v-device.png` 设备切换已切换态
- `v-volume.png` 音量 57%
- `v-cover.png` 后台切歌 + 真实封面
- `v-transition.png` 过渡中
- `osd-f3.png` 弹出中途（只有胶囊、没有半截字）
- `osd-f27.png` 收回成球

## 已知限制

- 外部（Windows 设置/音量合成器）切换默认设备依赖 2.5s 轮询，最多约 2.5s 延迟；应用内切换是即时的。
- 切歌胶囊不显示当前进度/时长，只显示曲目信息；进度留给播放条。
- 安装目录里的 `Zilux2.exe` 是单文件发布产物，宿主改动需要重新 publish/打包才生效；`web/` 可直接 robocopy。
