# Zilux2 系统设计

> 版本：1.2.11 · 编制日期：2026-11-24

## 1. 设计目标

1. **播放优先**：任何分析、分轨、壁纸任务都不得阻塞音频线程或造成可感知卡顿。
2. **本地优先**：曲库、缓存、分轨结果、设置全部落在本机；在线能力是可降级的增强项。
3. **算法可解释**：过渡、分轨、分析都必须能回答「为什么这样做」，而不是黑盒。
4. **可被脚本驱动**：关键能力通过本地 HTTP API 暴露，便于测试与二次开发。

## 2. 总体架构

```
┌──────────────────────────────────────────────────────────────┐
│                        Zilux2.exe (WPF)                       │
│                                                              │
│  MainWindow ── WebViewHost ── WebView2 ──► web/dist (SPA)     │
│      │             │                                         │
│      │             └─ bridge: postMessage / 本地 HTTP         │
│      ├─ Tray / Hotkeys / MediaSession / Updates               │
│      ├─ DesktopBackgroundWindow（壁纸层）                     │
│      ├─ DesktopLyricsWindow / FanWindow（桌面歌词）           │
│      ├─ SystemAudioOsdWindow（音量/切歌 OSD）                 │
│      └─ LocalMusicServer（回环 HTTP，令牌鉴权）               │
│              ├─ /api/library     本地曲库                     │
│              ├─ /api/online/*    多平台聚合                   │
│              ├─ /api/analysis/*  分析特征                     │
│              ├─ /api/stems/*     分轨（含模型下载）           │
│              ├─ /api/wallpaper/* 壁纸媒资                     │
│              └─ /api/settings    设置读写                     │
│                                                              │
│  Analysis/  Stems/  Wallpaper/  Local/  Online/  Storage/     │
└──────────────────────────────────────────────────────────────┘
                              ▲
                              │ HTTP + 令牌（仅回环）
                              │
                  web/src（TypeScript SPA）
                  ├─ core/    状态、桥、音频图、混音规划
                  ├─ audio/   Web Audio 节点图、分轨播放、进阶混音
                  ├─ ui/      页面、歌词、壁纸、进度卡、设置
                  └─ styles/  设计令牌与主题
```

**分层职责**

| 层 | 位置 | 职责 | 不做什么 |
| --- | --- | --- | --- |
| 外壳层 | `MainWindow`、`Tray`、`Hotkeys`、`MediaSession` | 窗口生命周期、托盘、全局热键、系统媒体会话 | 不渲染业务 UI |
| 宿主服务层 | `LocalMusicServer`、`Analysis`、`Stems`、`Local`、`Online`、`Wallpaper`、`Storage`、`Updates` | 数据、算法、IO、平台适配 | 不做视觉与交互 |
| 桥接层 | `WebViewHost`、`web/src/core/bridge.ts` | 双向消息、脚本执行、事件转发 | 不含业务规则 |
| 表现层 | `web/src/ui/*`、`web/src/styles/*` | 页面、动画、歌词、壁纸视图 | 不直接读文件系统 |
| 音频层 | `web/src/core/audio.ts`、`web/src/audio/*` | Web Audio 图、混音、分轨播放 | 不决定 UI 结构 |

## 3. 进程与线程模型

- **单进程**：`Zilux2.exe` 承载 WPF、WebView2 与所有后台服务，避免跨进程拷贝音频缓冲。
- **UI 线程**：WPF 主线程，负责窗口、托盘、OSD；所有跨线程回调通过 `Dispatcher` 回到此线程。
- **WebView2 渲染线程**：页面 JS 与合成；`ExecuteScriptAsync` 由宿主投递。
- **音频线程**：Web Audio 渲染线程（页面内），实时性最高，禁止同步 IO。
- **分析线程池**：`TrackAnalysisService` 用 `Task` + 有界并发（默认 2）跑拍格/能量/结构分析。
- **分轨线程池**：`StemSeparationService` 串行化 ONNX 会话（单会话复用），避免显存/内存峰值叠加。
- **壁纸渲染**：`WallpaperHost` 独立窗口 + 独立合成器；全屏检测由 `FullscreenWatcher` 负责。

## 4. 关键数据流

### 4.1 音乐流（播放）

```
用户点播 → OnlineMusicService 解析直链（多源降级）
        → LocalMusicServer /api/stream 提供 Range 流
        → 页面 <audio>/Web Audio 取流
        → audio.ts 建图：source → EQ → 音量 → 夜间压缩 → 输出
        → 播放状态回传宿主（SMTC / OSD / 托盘）
```

### 4.2 分析流

```
TrackAnalysisService 解码 → BeatAnalyzer（拍格/能量/活动度）
        → LoudnessMeter / TailSilenceDetector / StructureSsm
        → AnalysisEnrichmentService（风格画像、分轨活动度）
        → 结果落盘（按 trackKey + 分析器版本）
        → GET /api/analysis/features?enrich=1 供页面取用
```

### 4.3 混音规划流

```
下一首入队 → 取两侧分析（拍格/调性/人声活动度/结构）
          → styleKit 选型（16 种手法）→ stylePolicy 窗口缩放
          → V2 规划：换手点、低频交接、人声让位、变速、A 尾自延长
          → crossfadeDeck 按时间轴调度自动化（gain / filter / EQ）
          → 过渡结束回写统计与手法卡
```

### 4.4 分轨流

```
用户切「人声/伴奏」→ stemsClient.ensureStemModel()
   ├─ 已就绪 → 直接进入窗口计算
   └─ 未就绪 → GET /api/stems/model → POST 触发下载
              → 下载（镜像降级 + .part + SHA-256 校验）
              → 落盘 %LOCALAPPDATA%\Zilux2\models\
→ StemSeparationService 按 30 s 窗口推理 → 缓存 wNNN.vocals/inst.wav
→ stemPlayer 双缓冲交叉切换，播完窗口预取下一个
```

## 5. 接口设计（本地 HTTP）

| 方法 | 路径 | 说明 | 鉴权 |
| --- | --- | --- | --- |
| GET | `/api/health` | 存活探测 | 令牌 |
| GET | `/api/search` | 多平台聚合搜索 | 令牌 |
| GET | `/api/stream` | 音频流（支持 Range） | 令牌 |
| GET | `/api/stream/info` | 当前流信息（时长/码率/来源） | 令牌 |
| GET | `/api/lyric` | 歌词（LRC / AMLL） | 令牌 |
| GET | `/api/cover`、`/api/cover/colors` | 封面与主色提取 | 令牌 |
| GET | `/api/library/{overview,recent,liked,playlist,feed}` | 收藏、最近、歌单 | 令牌 |
| GET | `/api/discover/*` | 发现页（榜单/推荐/电台等） | 令牌 |
| GET | `/api/analysis`、`/api/analysis/features` | 基础分析与增强特征（`enrich=1` 内联就绪部分） | 令牌 |
| GET | `/api/stems`、`/api/stems/audio` | 分轨窗口状态与音频 | 令牌 |
| GET | `/api/stems/model` | 分轨模型状态 | 令牌 |
| POST | `/api/stems/model` | 触发模型下载 | 令牌 |
| GET | `/api/wallpaper/v2/media/{id}` | 壁纸媒资（支持 206） | 令牌 |
| GET/POST | `/api/download*`、`/api/downloads` | 下载队列控制 | 令牌 |
| GET/POST | `/api/storage/cache*` | 缓存用量与清理 | 令牌 |
| GET/POST | `/api/account/*` | 登录、二维码、导入 | 令牌 |

设置不走 HTTP：页面通过 `bridge.ts` 的 `settings.get` / `settings.patch` 消息与宿主 `SettingsService` 交互，避免设置被外部脚本改写。

鉴权：启动时生成 32 字节随机令牌，注入页面 `window.__ziluxBoot.token`；服务只绑定 `127.0.0.1`，外部主机不可达。

## 6. 数据与存储

| 数据 | 位置 | 策略 |
| --- | --- | --- |
| 设置 | `%LOCALAPPDATA%\Zilux2\settings.json` | 原子写（`AtomicFile`），版本化字段，未知字段保留 |
| 日志 | `%LOCALAPPDATA%\Zilux2\logs\host.log` | 按天滚动，结构化键值 |
| 分析缓存 | `%LOCALAPPDATA%\Zilux2\analysis\` | 按 `trackKey + analyzerVersion` 失效 |
| 分轨缓存 | `%LOCALAPPDATA%\Zilux2\stems\` | LRU（`StemCacheLru`），窗口级 `.wav` |
| 模型 | `%LOCALAPPDATA%\Zilux2\models\` | 按需下载 + SHA-256 校验 |
| 歌词缓存 | `%LOCALAPPDATA%\Zilux2\lyrics\` | TTL + 大小上限 |
| 壁纸媒资 | `%LOCALAPPDATA%\Zilux2\wallpaper\` | 分片缓存，支持 206 |

## 7. 技术选型

| 关注点 | 选型 | 理由 |
| --- | --- | --- |
| 桌面外壳 | WPF (.NET 10, Windows 10 19041+) | 原生窗口/托盘/多显示器/DPI 支持成熟 |
| 界面 | WebView2 + TypeScript + Vite | 复杂动效与排版用 Web 技术迭代快；构建产物本地加载 |
| 音频 | Web Audio API | 低延迟、可编程节点图，能实现 EQ/压缩/分轨混音 |
| 分轨 | ONNX Runtime 1.31.1（CPU）+ HTDemucs fp16 | 兼容性最好；DirectML 1.24.x 会触发 DFT 属性冲突 |
| 分析 | 自研 BeatAnalyzer + SSM 结构分析 | 不依赖云服务，离线可跑 |
| 存储 | JSON + 文件缓存 | 无需数据库，便于用户备份与排查 |
| 发布 | GitHub Actions + Inno Setup | tag 触发构建，安装包与便携包同时产出 |

## 8. 构建与发布流水线

```
tag vX.Y.Z
  → 校验 tag 与 Directory.Build.props 的 <Version> 一致
  → tools/publish.ps1 -SkipWebBuild -Version
  → tools/make-installer.ps1（Inno Setup）
  → 上传 Zilux2-Setup / Zilux2-Portable / 模型 onnx / sha256
  → 更新日志取自 docs/release-notes/vX.Y.Z.md（缺省按提交生成）
```

本机开发流程：`publish.ps1` → `deploy-installed.ps1` → 重启 `Zilux2.exe`；两脚本会自动备份 `web.bak-*` / `Zilux2.exe.bak-*`。

## 9. 关键设计决策

| 决策 | 取舍 |
| --- | --- |
| 单进程而非多进程 | 避免音频缓冲跨进程拷贝；代价是某个服务崩溃会影响整体，用异常隔离兜底 |
| 页面承载 UI 而非 XAML | 动效与响应式布局成本低；代价是 WebView2 合成行为需要额外处理（如窗口动画走系统原生补间） |
| 模型按需下载 | 安装包 225 MB → 93 MB；代价是首次分轨需联网或用 `-WithModel` 出全量包 |
| 分轨按窗口而非整曲 | 内存可控、首响快；代价是跨窗口切换需双缓冲交叉 |
| 过渡算法本地规划 | 离线可用、可解释；代价是首次分析需等待数秒 |
