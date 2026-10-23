# Zilux2 里程碑 5 — 沉浸播放页 · 音频驱动 · Windows 媒体会话

> 2026-10-18 / 交付范围：Now Playing 整页、3D 歌词舞台增强、宿主音频特征流、SMTC 媒体会话；用户自测验收。

## 1. 沉浸播放页（Now Playing v1）

- 入口：点击播放条左侧「封面 + 曲名」区域，或按 `Ctrl+P`；`Esc` / 返回按钮 / 再次点击标题关闭。
- 布局（`web/src/ui/nowPlayingPage.ts` + `styles/nowPlaying.css`）：
  - 页面层 `fixed top:38px left:84px right:0 bottom:0`（顶栏与播放条保留，不重复造控制条），白磨砂 + 浅色极光，超宽屏内容 `max-width:1720px` 居中；
  - 左区：3D 歌词舞台（唯一 WebGL canvas），当前行扫光 + 上下各 2 行 + 微弧面；
  - 右区：CSS 3D 封面卡（悬停 tilt / 倒影）、曲名 / 歌手 / 专辑、收藏 / 加入歌单 / 更多；
  - 支持「3D / 列表」歌词视图切换（列表模式点击行 seek）。
- 数据：`fetchLyric → parseLrc → applyTranslation → stage.setLines`，`player.onTime → stage.setTime`；切歌只 `setLines` + 淡入，不重建 WebGL 上下文；加载骨架 / 纯音乐 / 错误重试三态。
- 规格见 `docs/zilux2-nowplaying.md`。

## 2. 3D 歌词舞台引擎增强（`web/src/three/lyricsStage.ts`）

- Canvas2D 行级光栅 → 微弧面贴图，片元 shader 左→右柔边扫光（行级时间比例）。
- 新增氛围层：淡紫→淡青柔和光场 + 缓慢极光带（峰值 alpha 0.2，不压文字）；可选尘埃粒子（默认 90，上限 120，reduce-motion 关闭）。
- 当前行微弧面 + 机位微视差；`setAudioSource(getFrame)` 支持音频驱动。
- 性能：同一 WebGL 上下文、仅 2 个低多边形对象、零新纹理、每帧零分配；纹理/几何复用；`dispose()` 全量释放。

## 3. 宿主音频特征流（`src/Zilux2/Audio/`）

- `LoopbackCapture.cs`：WASAPI loopback（默认输出设备，本机 48kHz/2ch/float32），COM interop 自实现，无第三方依赖。
- `AudioFeatures.cs`：自写 radix-2 FFT（2048 点 + Hann 窗）→ `bins[64]`、`bands[8]`、`level`、`peak`、`beat`（320ms 冷却）。
- `AudioFeatureService.cs`：30Hz 推送 `{"v":1,"type":"host","event":"audio","payload":{bins,bands,level,peak,beat}}`（约 244B/帧）；最小化暂停；无设备优雅降级；`settings.playback.audioReactive` 开关（默认开）。
- 前端 `web/src/audio.ts`：`AudioFrame` 总线（校验 / attack .5 / release .12 平滑 / beat 300ms 去重 / ≤8 订阅者 / 1.2s 超时归零），驱动 hero 封面环呼吸与歌词舞台光场。
- 实测：30Hz 下 CPU 0.065%（24 核）；真实音频 level 0.80；100Hz 脉冲 6s 检出 13 beats。

## 4. Windows 媒体会话（SMTC/GSMTC，`src/Zilux2/Media/`）

- `MediaSessionService.cs`：WinRT `SystemMediaTransportControls`（窗口级），启用 Play/Pause/Next/Previous/Stop + 进度条 seek；元数据 / 封面 / 播放状态 / 时间轴；更新 100ms 合并（≤10 次/秒）；退出 `ClearAll()` + `IsEnabled=false` 防幽灵会话。
- `SmtcArtwork.cs`：dataURL / 绝对 URL / 回环 `/api/cover` 相对路径 → `RandomAccessStreamReference`（3s / 5MB 上限，失败忽略）。
- 消息：页面 → 宿主 `{"type":"media","payload":{title,artist,album,coverUrl?,durationMs,positionMs,playing}}`；宿主 → 页面 `host event=mediaControl {action,positionMs?}`。契约见 `docs/zilux2-host-contract.md` §11。
- 系统「正在播放」浮层、媒体键、锁屏控制均可操作 Zilux2。

## 5. 验证

- `pnpm build`（tsc strict）通过；宿主 `dotnet build` 0 警告 0 错误。
- 开发期冒烟：SMTC 25/25（GSMTC 可见会话、命令回推、退出无残留）、音频 20/20（服务启动、loopback、降级、释放）。
- 最终体验由用户自测。

## 6. 已知限制

- 3D 舞台歌词暂不支持点击行 seek（引擎未暴露命中接口；列表模式可 seek）；逐字高亮为行级。
- 音频采集的是系统默认输出设备的全部声音；静音/未播放时推全 0 帧，页面自动回落。
- 演示曲库（mock）也会上报 SMTC，便于未登录验证。
