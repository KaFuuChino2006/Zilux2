# Zilux2 动态壁纸 v2 规格书

> **状态**：v0.1 待批注 · 2026-11-15 · 依据 1–104 轮需求访谈
> **作用**：这是「删掉旧壁纸模块 + 从零重写」的唯一施工依据。你在这份文档上批注完，我才动第一行代码。
> **范围**：只覆盖动态壁纸。音乐播放、下载、远程、歌词等既有模块不在本次改动范围内（除必需的接线点）。

---

## 0. 阅读约定

| 标记 | 含义 |
| --- | --- |
| `[已定]` | 访谈中你已经明确选择的，我照此实现，不再问 |
| `[待批注]` | 我拿不准、或者需要你给具体值的地方，见第 10 章汇总 |
| `✍️ 批注：` | 留给你直接写修改意见的空行 |

---

## 1. 定位与边界

`[已定]` 按**专业动态壁纸软件**做（Wallpaper Engine / Lively 同级），而不是「播放器附带的一个小背景」。

### 1.1 双画布

| 画布 | 落点 | 说明 |
| --- | --- | --- |
| **软件内背景层** | 主窗口最底层视频表面 | 只在本程序窗口内，不碰桌面图标 |
| **桌面层** | WorkerW 子窗口（挂在桌面图标**下方**） | 一等公民：桌面图标、框选、右键菜单、拖放全部照常工作 |

两者**共用**同一套解码 / 渲染 / 转场 / 滤镜 / 调度代码，只在「落地目标」处分叉（`IRenderTarget` 两个实现）。

### 1.2 两画布的关系

`[已定]` **共用同一个素材库，但各选各的**：桌面层与软件内各自维护「当前壁纸 / 轮换计时 / 滤镜 / 转场」，互不干扰。同一个素材可以同时铺在两边。

### 1.3 支持与不支持

| 能力 | 状态 |
| --- | --- |
| 视频壁纸（mp4 / webm / mkv / mov / avi） | ✅ 内置 FFmpeg，硬解优先、软解兜底 |
| 图片壁纸（jpg / png / webp） | ✅ |
| GIF 壁纸 | ✅ |
| Wallpaper Engine **视频**工坊内容 | ✅ 自动发现 + 引用原路径 |
| Wallpaper Engine **scene.pkg** 场景壁纸 | ❌ 明确不支持（旧代码整个 `Scene/` 目录删除） |
| Web 壁纸（HTML/JS） | ❌ 不支持 |
| 多窗口各自独立壁纸 / 壁纸浮窗 | ❌ 不做 |
| 歌词联动微动效 | ❌ 不做（律动事件总线保留，供可视化与节拍驱动用） |
| 跟歌换壁纸 / 歌曲钉壁纸 | ❌ 不做 |
| 每日推荐 / 定时任务 | ❌ 不做 |
| 内置示例视频 | ❌ 不塞（避免安装包变大 + 版权问题） |
| 底栏快捷切换栏 | ❌ 不做（第 71 轮撤销） |

### 1.4 素材来源（三路合一）

`[已定]`

| 来源 | 行为 | 存储方式 |
| --- | --- | --- |
| **手动添加** | 文件选择器 / 拖进窗口 | **复制**进库目录 |
| **目录监控** | `FileSystemWatcher` 监听你指定的文件夹（含子目录），新增即入队导入 | **复制**进库目录 |
| **WE 工坊自动发现** | 读 Steam `libraryfolders.vdf` + 注册表 `Software\Valve\Steam\SteamPath`，扫 `steamapps\workshop\content\431960\*` | **引用原路径**，不复制（省磁盘） |

库目录：`%LOCALAPPDATA%\Zilux2\wallpaper\library\{hash前2位}\{hash}.{ext}`

哈希去重：SHA-256 全文哈希，同一内容多次导入只留一份。

✍️ 批注：

---

## 2. 删除清单（一次性全删）

`[已定]` 第 99 轮：**一次性全删**，不保留半套代码、不做灰度、不留兼容开关。

### 2.1 C# 端

| 路径 | 规模 | 处理 |
| --- | --- | --- |
| `src/Zilux2/Wallpaper/WallpaperLibrary.cs` | 29KB | 删除（重写为 `Library/LibraryStore.cs` + `Library/Scanner.cs`） |
| `src/Zilux2/Wallpaper/MonitorCatalog.cs` | — | **重写**（桌面层要做，多屏分配需要它，第 24 轮 C） |
| `src/Zilux2/Wallpaper/WallpaperRuntime.cs` | 23KB | **重写**（双画布运行时要重新设计） |
| `src/Zilux2/Wallpaper/Rendering/DesktopSurface.cs` | 64KB | **重写**（WorkerW 渲染要重做） |
| `src/Zilux2/Wallpaper/Rendering/WorkerWLocator.cs` | — | **重写**（注入逻辑重做，要自愈） |
| `src/Zilux2/Wallpaper/Rendering/SceneGpuRenderer.cs` | 28KB | 删除（scene 专用） |
| `src/Zilux2/Wallpaper/Rendering/VideoFrameSource.cs` | — | 删除（换 FFmpeg 解码） |
| `src/Zilux2/Wallpaper/Scene/`（全部 10 个文件：ScenePackage / TextureFile / SceneComposer / SceneEffects / SceneParticles / SceneScript / SceneScriptText / SceneText / Lz4Raw / SceneProbe） | ≈300KB | 删除（不再支持 scene.pkg） |
| `src/Zilux2/Wallpaper/WallpaperAudioMeter.cs` | — | 删除（改走律动引擎的音频帧） |
| `src/Zilux2/Wallpaper/WallpaperBackdropHost.cs` | 40KB | 删除（重写为 `Host/BackdropHost.cs`） |
| `src/Zilux2/Wallpaper/WallpaperSelfCheck.cs` | 26KB | 删除（并入诊断面板 + 自检按钮） |
| `src/Zilux2/Wallpaper/WallpaperLog.cs` | — | 删除（并入统一日志 + 导出 zip） |
| `src/Zilux2/DesktopBackgroundWindow.xaml` / `.xaml.cs` | — | 删除 |

`**重写**` 的四个文件 = 旧的注入/渲染思路不合用，但「壁纸要贴到桌面上」这件事仍然要做，所以按新架构重写而不是简单删掉不写。

### 2.2 接线点

| 文件 | 要删的部分 |
| --- | --- |
| `src/Zilux2/App.xaml.cs` | 壁纸初始化、`--wp-selftest` / `--sweep` 分支 |
| `src/Zilux2/MainWindow.xaml` / `.cs` | 背景宿主挂载、壁纸相关事件 |
| `src/Zilux2/Settings/SettingsModel.cs` | 整个 `Wallpaper` 块（25+ 键） |
| `src/Zilux2/Settings/SettingsService.cs` | wallpaper 读写、迁移逻辑 |
| `src/Zilux2/Hotkeys/HotkeyCatalog.cs` | `wallpaperToggle`、`wallpaperNext` 两条 |
| `src/Zilux2/Online/LocalMusicServer.cs` | 全部 `/api/wallpaper/*` 端点（library / rescan / preview / favorite / backdrop / desktop / monitors / options / pause / system / cache / scene-probe / gpu-probe / surface-test） |
| `src/Zilux2/Remote/RemoteAgent.cs` | 壁纸动作 |
| `src/Zilux2/WebViewHost.cs` | 壁纸相关桥接 |

### 2.3 Web 端

| 文件 | 处理 |
| --- | --- |
| `web/src/core/wallpaper.ts`（438 行） | 删除 |
| `web/src/core/wallpaperRotation.ts`（182 行） | 删除 |
| `web/src/ui/wallpaperView.ts`（813 行） | 删除 |
| `web/src/styles/wallpaper.css`（512 行） | 删除 |
| `web/src/ui/flow*.ts` 中的壁纸分支 | 摘除分支（文件本身保留） |

### 2.4 工具与文档

| 路径 | 处理 |
| --- | --- |
| `_tools/wp-accept.ps1`、`_tools/wp-*.js` | 删除 |
| `docs/wallpaper-architecture.md`（277 行） | **移入** `archive/wallpaper-2026-11-15/`，不 `rm` |
| `docs/wallpaper-scene-format.md`（882 行） | **移入** `archive/wallpaper-2026-11-15/` |

### 2.5 数据

`[已定]` 第 14 轮：旧 wallpaper 设置键、收藏列表、素材索引**直接删除，不迁移、不留旧键**。

### 2.6 不做的事

- 不做 `git filter-branch` 洗历史（旧代码留在提交历史里，不影响使用）
- 不建 git commit / push（除非你明确要求）

✍️ 批注：

---

## 3. 总体架构

### 3.1 分层

```
┌─ 素材层 ────────────────────────────────────────────┐
│ LibraryStore(SQLite)  Scanner  Thumbnailer  Probe   │
└──────────────────────────┬──────────────────────────┘
┌─ 解码层 ─────────────────┴──────────────────────────┐
│ IWallpaperSource                                    │
│   ├ VideoSource  (FFmpeg: 硬解优先 → 软解兜底)      │
│   ├ ImageSource  (WIC)                              │
│   └ GifSource    (逐帧预解)                         │
└──────────────────────────┬──────────────────────────┘
┌─ 渲染层 ─────────────────┴──────────────────────────┐
│ SceneRenderer  (D3D11 共享)                         │
│   ├ InAppSurface   (主窗口最底层)                   │
│   └ WorkerWSurface (桌面层，自愈重建)               │
└──────────────────────────┬──────────────────────────┘
┌─ 合成层 ─────────────────┴──────────────────────────┐
│ TransitionCompositor(表驱动 shader)                 │
│ FilterChain(暗化/模糊/亮度/对比/饱和)               │
│ OverlayLayer(视差 / 时钟文字 / 音频可视化)          │
└──────────────────────────┬──────────────────────────┘
┌─ 调度层 ─────────────────┴──────────────────────────┐
│ RotationScheduler  RuleEngine  SequencePlayer  Prewarmer │
└──────────────────────────┬──────────────────────────┘
┌─ 律动层 ─────────────────┴──────────────────────────┐
│ OnsetDetector → BeatClock → RhythmEventBus          │
└──────────────────────────┬──────────────────────────┘
┌─ 控制层 ─────────────────┴──────────────────────────┐
│ WallpaperHost(C#) ←→ /api/wallpaper/v2/* ←→ Web UI  │
└─────────────────────────────────────────────────────┘
```

### 3.2 关键设计决策

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 桌面层进程模型 | 同进程 + WorkerW 子窗口，崩溃自愈重建 | 省一个进程、省 IPC；自愈保证不拖垮主程序 |
| 解码 | 内置 FFmpeg（硬解优先） | mp4/webm/mkv/mov/avi 全覆盖，不依赖系统解码器 |
| 转场 | 双解码实例 + 首帧就绪再切 | 交叉淡化必须两个实例同时在跑，否则会闪黑 |
| 索引 | SQLite | 几千条素材 + 标签多对多 + 合辑，JSON 扛不住 |
| 设置 | 仍存 `SettingsModel`（JSON） | 与现有设置体系一致，不引入第二套配置源 |
| 素材去重 | SHA-256 全文哈希 | 同一视频从不同路径导入只留一份 |
| 并发解码 | 按 GPU 自动探测上限，可设「不限」 | 多屏多壁纸时硬解实例有限，超了会掉帧 |

✍️ 批注：

---

## 4. 数据模型（SQLite）

位置：`%LOCALAPPDATA%\Zilux2\wallpaper\wallpaper.db`

```sql
-- 素材
CREATE TABLE assets (
  id            INTEGER PRIMARY KEY,
  hash          TEXT UNIQUE NOT NULL,      -- SHA-256
  path          TEXT NOT NULL,             -- 绝对路径（复制入库 / WE 原路径）
  source        TEXT NOT NULL,             -- 'import' | 'watch' | 'workshop'
  kind          TEXT NOT NULL,             -- 'video' | 'image' | 'gif'
  width         INTEGER, height INTEGER,
  duration_ms   INTEGER,                   -- 静图为 NULL
  fps           REAL,
  size_bytes    INTEGER,
  cover_path    TEXT,                      -- 缩略图；WE 用自带 preview.gif
  cover_time_ms INTEGER,                   -- 抽帧时间点（自动跳黑场后的结果）
  trim_in_ms    INTEGER, trim_out_ms INTEGER,  -- 片段裁剪（第 80 轮）
  speed         REAL DEFAULT 1.0,          -- 0.5–2.0
  transform_json TEXT,                     -- 镜像/旋转/裁剪（第 86 轮）
  fit_override  TEXT,                      -- 单张覆盖适配方式
  missing       INTEGER DEFAULT 0,         -- 1 = 文件已失联
  added_at      INTEGER NOT NULL,
  last_seen_at  INTEGER
);

-- 标签（多对多 + 自动补全）
CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);
CREATE TABLE asset_tags (
  asset_id INTEGER NOT NULL, tag_id INTEGER NOT NULL,
  PRIMARY KEY (asset_id, tag_id)
);

-- 合辑（扁平多对多）
CREATE TABLE collections (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL,
  builtin TEXT,          -- 'all' | 'favorites' | 'recent' | 'unsorted' | NULL
  sort INTEGER DEFAULT 0
);
CREATE TABLE collection_assets (
  collection_id INTEGER NOT NULL, asset_id INTEGER NOT NULL, sort INTEGER DEFAULT 0,
  PRIMARY KEY (collection_id, asset_id)
);

-- 序列（第 85 轮：有序 + 单条时长 + 单条转场 + 可绑画布）
CREATE TABLE sequences (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL,
  canvas TEXT,           -- 'inapp' | 'desktop' | NULL(两者通用)
  loop INTEGER DEFAULT 1
);
CREATE TABLE sequence_items (
  id INTEGER PRIMARY KEY, sequence_id INTEGER NOT NULL,
  asset_id INTEGER NOT NULL, sort INTEGER NOT NULL,
  duration_ms INTEGER, transition_id TEXT
);

-- 画布当前状态（两个画布各一行，桌面层每屏一行）
CREATE TABLE canvases (
  id            INTEGER PRIMARY KEY,
  kind          TEXT NOT NULL,     -- 'inapp' | 'desktop'
  monitor_id    TEXT,              -- 桌面层用，软件内为 NULL
  asset_id      INTEGER, sequence_id INTEGER,
  fit_mode      TEXT,
  filter_json   TEXT,
  transition_id TEXT,
  paused        INTEGER DEFAULT 0,
  updated_at    INTEGER
);

-- 预设（第 83 轮：滤镜+转场+轮换间隔+可视化开关）
CREATE TABLE presets (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL,
  kind TEXT,             -- 'manual' | 'appearance'
  payload_json TEXT NOT NULL
);

-- 条件规则（第 58 轮：时段/前台应用/电量，可排序）
CREATE TABLE rules (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL,
  enabled INTEGER DEFAULT 1, priority INTEGER DEFAULT 0,
  cond_json TEXT NOT NULL, action_json TEXT NOT NULL
);

-- 收藏
CREATE TABLE favorites (asset_id INTEGER PRIMARY KEY);
```

**设置不进 SQLite**：所有开关、滑杆、路径、热键仍写在 `SettingsModel.Wallpaper`（JSON），与软件其他设置同源。

✍️ 批注：

---

## 5. 功能规格（9 组）

### 5.0 入口与结构

`[已定]`

- **壁纸是左侧主导航的一级入口**（第 9 轮），不是埋在设置里。图标 + 文案，插在现有 rail 的合适位置。
- 进入壁纸页 → 库 + 两张「当前壁纸」卡（软件内 / 桌面层）。
- 页内右上「设置」→ **模块内全屏设置页**（第 48 轮 C）：左侧分组列表，右侧内容。
- **高级设置也在壁纸模块内**，不进全局设置页；全局设置页本次不动（第 47 轮）。
- 9 组：基础 / 库与素材 / 转场 / 轮换与规则 / 桌面层 / 性能与解码 / 诊断与日志 / 视觉效果 / 音频联动（第 49 轮 7 组 + 第 75 轮 2 组）。

### 5.1 基础

| 项 | 规格 | 默认 |
| --- | --- | --- |
| 三级开关 | 总开关 → 软件内/桌面层 → 页面开关（第 90 轮 A） | 有素材时总开关开 |
| 页面生效表 | 常规页 开 / 沉浸播放页 关 / 房间页 关 / 登录空间 关（第 16 轮 C），可逐页改 | 按此 |
| 壁纸音轨 | 独立音量滑杆；可跟随系统音量 | 关，音量 40% |
| 音乐优先 | 音乐起播 → 壁纸音轨 **300ms 淡出**；音乐暂停/停止 → **800ms 淡入**（第 18 轮 A） | 开 |
| 遮挡降音 | 桌面层被窗口覆盖 **≥80%** → 静音；恢复 800ms 淡入（第 55 轮 E） | 开 |
| 关闭窗口 | 缩到托盘（壁纸继续跑）／直接退出，二选一（第 67 轮 AD） | 缩托盘 |
| 开机自启 | 关 / 仅壁纸（轻量 `--wallpaper-host`）／全部功能（第 68 轮 DE） | 关 |

> 轻量自启用同一个 exe 加 `--wallpaper-host`：跳过 WebView2 与音乐模块，只跑桌面层 + 托盘（第 69 轮 A）。

✍️ 批注：

### 5.2 库与素材

| 项 | 规格 |
| --- | --- |
| 手动添加 | 文件选择（多选）+ 文件夹递归导入 |
| 目录监控 | 多路径列表，可加/删/启用；含子目录开关；`FileSystemWatcher` 防抖 2s |
| WE 工坊发现 | 自动定位 Steam 库 → `steamapps\workshop\content\431960\*`；可手动指定额外目录 |
| 转本地副本 | 每条 WE 素材一个按钮：复制进库目录，之后不再依赖 Steam |
| 去重 | SHA-256 全文哈希；重复时提示「已存在，跳到该条」 |
| 封面 | WE 自带 `preview.gif` 优先；无自带 → 抽帧并**自动跳过黑场**（第 62 轮）；本地视频一律抽帧 |
| 取帧 | 详情内时间轴拖到任意秒 → 重新取封面（第 41 轮 C） |
| 批量 | 批量打标签 / 加合辑 / 收藏 / 移出库（第 41 轮 A） |
| 排序 | 导入时间 / 名称 / 大小 / 时长 / 随机（第 41 轮 D） |
| 筛选 | 类型、标签、收藏 + 分辨率（4K/1080p/720p）、时长（<10s / 10–30s / >30s）、大小（第 103 轮 ABC） |
| 网格密度 | 紧凑 / 标准 / 大图（第 98 轮 D） |
| 扫描 | 启动静默扫描不阻塞 UI；缩略图队列并发 2，优先当前可见（第 61 轮 A） |
| 导入队列 | 底部进度条显示当前队列（第 102 轮 A） |
| 坏文件 | 损坏/编码异常 → 标灰 + 原因 + 一键移除（第 102 轮 B） |
| 磁盘 | 存储页：每张大小、总占用、缩略图/缓存/副本分类统计、一键清理、自动清理策略（第 87 轮 D） |

`[已实现 2026-11-15]`：

- 手动添加：`host.pickWallpaperFiles()` → `MainWindow.PickWallpaperFiles()` 弹 `OpenFileDialog` → `host.Import(paths, copy: true)` → 推 `wallpaperImported` 事件让库页 toast + 刷新。
- **片段裁剪（第 80 轮）**：`PUT /library/items/{id}` 的 `trimInMs` / `trimOutMs` / `speed`，抽屉里三根滑杆（入点 / 出点 / 速度 0.5–2×）。前端把入点设成 `<video>.currentTime`、出点用 `timeupdate` 回绕；有出点时关掉原生 `loop`，否则浏览器从头循环会跳过区间。出入点变化会重建 `<video>`（起播点绑在元素上），速度只是改 `playbackRate`。
- **画面变换（第 86 轮）**：`PUT /library/items/{id}` 的 `transform{mirrorH,mirrorV,rotation,cropLeft,cropTop,cropRight,cropBottom}`，抽屉里镜像两键 + 旋转 0/90/180/270 + 四边裁剪滑杆（0–45%）。
- **两层 DOM 是必须的**：转场写外层 `.wp-layer-frame` 的 `opacity/transform/filter`，画面变换写内层 `.wp-layer-media` 的 `transform/clip-path`。放同一元素上会互相覆盖——转场一写 `transform`，镜像就没了。
- 旋转 90/270 时宽高比翻过来、`object-fit: cover` 会留边，按容器比例补一个 `scale()`；裁剪用 `clip-path: inset()` 切四周，再按裁掉最多的那条边放大补满，否则画面会比容器小一圈。
- 改素材元数据后必须让宿主重推 payload：`WallpaperHost.NotifyAssetChanged(assetId)` 把内存里那份 `WallpaperAsset` 换成新记录再 `RaiseStateChanged()`。不做这一步，PUT 只写库、页面拿到的还是旧指令，改了半天看不到反应（这个坑踩过）。

✍️ 批注：

### 5.3 转场

`[已定]` 表驱动：每次切换 = 两个纹理 + 进度 t + 一个 shader + 参数表 + 时长（第 12 轮 E）。

| 组 | 预设 |
| --- | --- |
| 基础 | 淡化、黑场、白闪 |
| 位移 | 左推、右推、上滑、下滑、缩放推近 |
| 光学 | 模糊叠化、径向模糊、曝光 |
| 风格化 | glitch、胶片颗粒、斑点溶解、水波纹 |

- 时长 0–2000ms，**默认 800ms**（第 56 轮 B，覆盖第 51 轮的 500ms）
- 默认**随机预设**；可指定固定预设，也可指定「排除列表」
- 双解码实例；**首帧就绪才切**，否则保持旧帧（第 11 轮）
- 节拍驱动：可让转场卡 downbeat（强度 0–100%，第 78 轮 C）

✍️ 批注：

### 5.4 轮换与规则

| 项 | 规格 | 默认 |
| --- | --- | --- |
| 定时轮换 | 15 / 30 / 60 / 120 分钟，或关 | 关 |
| 顺序 | 随机 / 顺序（第 57 轮 A） | 随机 |
| 优先收藏 | 开/关 | 关 |
| 手动切换 | 重置计时器 | 是 |
| 两画布 | 各自独立计时（第 57 轮 A） | — |
| 预热 | 切前 2s 预解码下一张首帧（第 91 轮 A） | 开 |
| 条件规则 | 任意多时段 + 前台应用匹配 + 电量规则；优先级拖拽排序（第 58 轮 B） | 空 |
| 序列 | 有序列表、拖拽排序、单条时长、单条转场、可命名、可绑画布（第 85 轮 A） | 空 |
| 配置预设 | 滤镜 + 转场 + 轮换间隔 + 可视化开关，一键切换（第 83 轮 A） | 日用/夜用 |
| 外观联动 | 软件明暗主题 + 时段 → 触发预设切换，主色 **800ms** 平滑（第 84 轮 A） | 开 |

✍️ 批注：

### 5.5 桌面层

| 项 | 规格 |
| --- | --- |
| 接管 | 手动开启；记住状态，下次启动自动接管（第 66 轮） |
| 落点 | WorkerW 子窗口，挂在桌面图标**下方**：图标、框选、右键、拖放全部照常 |
| 多屏 | 每屏独立壁纸/转场/滤镜（第 25 轮 C）；并发解码受 5.6 上限约束 |
| 全屏应用 | 任何全屏应用 → 自动停播；退出全屏 → 续播（第 28 轮 C） |
| 声音 | 可出声，**默认关**（第 28 轮 D） |
| 右键菜单 | 插入三项：下一张 / 暂停 / 壁纸设置（第 26 轮 D） |
| 边缘控制条 | 屏幕顶部细条；鼠标贴边停留 **400ms** 才出现（第 94 轮 E） |
| 显示变化 | 插拔显示器/改分辨率/HDR 切换 → 暂停 → 重建表面 → 恢复，**800ms 黑场**（第 89 轮 A） |
| 自愈 | 渲染子窗口崩溃 → 自动重建，不影响主程序（第 35 轮 C） |
| 退出兜底 | 关闭桌面层 / 退出程序 / 崩溃 → 恢复原系统壁纸 |

✍️ 批注：

### 5.6 性能与解码

| 项 | 规格 | 默认 |
| --- | --- | --- |
| 帧率上限 | 30 / 60 / 144 / 不限（第 5 轮） | 60 |
| 渲染分辨率 | 100% / 75% / 50%（超采样降级） | 100% |
| 解码 | 硬解优先，失败自动回落软解（第 10 轮 C） | 硬解优先 |
| 大文件降采样 | ≥1440p 自动降采样（第 59 轮 A）；可关 | 开 |
| 并发解码 | 按 GPU 探测上限，或设「不限」（第 70 轮 C+D） | 自动 |
| 最小化 | 最小化 → 暂停 | 开 |
| 空闲降帧 | 无操作 N 秒 → 15fps（N 默认 60s） | 开 |
| 电池 | 电池供电 → 暂停 | 开 |
| 游戏/全屏 | 全屏独占或高负载 → 暂停 | 开 |
| 自适应 | 实测帧耗时动态升降帧率/渲染比例（第 5 轮） | 开 |
| 减少动画 | 跟随系统「减少动画」→ 降动效 / 减闪烁 / 静态占位（第 88 轮 A，接现有 `Appearance.ReduceMotion`） | 跟随系统 |

✍️ 批注：

### 5.7 诊断与日志

`[已定]` 第 60 轮 D：

- **面板字段**：当前解码器（硬解/软解 + 名称）、实时 FPS、丢帧计数、进程内存、当前转场与进度、并发解码路数、GPU 名称与驱动版本、当前画布（软件内/桌面层/哪块屏）。
- **日志**：滚动显示最近若干条，可暂停滚动、可搜索。
- **导出**：一键打包 zip（日志 + 环境信息 + 当前配置快照）。
- **自检按钮**：跑一套内置检查（解码器可用性、WorkerW 注入、音频设备、库可读写、封面生成），逐项给通过/失败 + 原因。

✍️ 批注：

### 5.8 视觉效果

| 项 | 规格 | 默认 |
| --- | --- | --- |
| 鼠标视差 | 窗口内鼠标移动 → 壁纸轻微位移；幅度 0–100%，可关（第 23 轮 A） | 30% |
| 叠层 | 时钟 / 文字 / 日期；支持自定义模板串，不只时钟（第 76 轮 E） | 关 |
| 暗化 | 自动模式：按帧亮度在 0–40% 间调整，保证文字可读，EMA 平滑 800ms（第 53 轮 B）；也可手动固定 | 自动，基线 20% |
| 亮度 / 对比度 / 饱和度 / 模糊 | 手动滑杆 | 0 / 0 / 0 / 0 |
| 主题强调色 | 从壁纸当前帧取主色驱动 UI 强调色；无壁纸时回退专辑封面；切换 800ms 平滑（第 82 轮 D） | 开 |
| 画面变换 | 逐张：镜像 H/V、旋转 90/180/270、裁剪百分比（第 86 轮 A） | 无 |
| 适配 | 智能自动：按素材与目标宽高比选 cover/contain，可单张覆盖（第 52 轮 D）；竖屏/超宽默认模糊填充（铺满 + 背景模糊，第 92 轮） | 智能自动 |

✍️ 批注：

### 5.9 音频联动

`[已定]` 第 77/78 轮：

- **可视化叠加**：叠在壁纸上，4 种样式 —— 频谱条 / 波形 / 圆环 / 粒子；默认开，样式可选，位置与大小可调。
- **节拍驱动**：转场卡 downbeat、画面缩放脉冲、UI 动效，统一强度 0–100%。
- 消费 5.12 律动事件总线的 `beat` / `downbeat` / `section` 事件，不做自建节拍器。
- 音乐未播放时自动隐藏（不留静态装饰）。

`[已实现 2026-11-15]` 落地要点与实测：

- 渲染在 `web/src/ui/wallpaperVisualizer.ts`（`WallpaperVisualizer`），一块 `<canvas class="wp-visualizer">` 叠在 `#wallpaper-root` 里，`z-index: 2`（在压暗层之上、闪层之下），`pointer-events: none`。
- 4 种样式：`spectrum` 底部 64 根柱、`wave` 96 点折线、`ring` 中心圆 + 64 根径向条、`particles` 最多 160 粒（低音补粒 + `onBeat` 爆发）。
- **画布只铺需要的区域**：`spectrum` / `wave` 只占底部 32%（最少 120px）并贴底，`ring` / `particles` 才全屏；`dpr` 上限 1.5（不是 2）；目标帧率 30（不是 52）。实测全屏 52fps、dpr 2 的版本要多吃 3.9% CPU（4.8% → 8.7%），条带化 + 降帧后回落到 7.0%。
- 节拍脉冲不写在 `<video>` 的 `transform` 上（会和转场抢同一个属性），改成写 CSS 变量 `--wp-beat` 到 `#wallpaper-root`，由容器做 `scale()`，幅度 `1 + pulse * 0.010`。
- 代价实测（20s 采样）：可视化关 4.8% CPU / 254MB；开（spectrum，条带）7.0% CPU / 249MB；整个验收脚本 43 项跑完 `cpu=8.12%`、`ws=267.8MB`，仍在 §9.2 的 10% / 300MB 门槛内。
- 四种样式都验证过画布确有非空像素输出：`spectrum 23166` / `wave 484` / `ring 2748` / `particles 226`（`getImageData` 采样 alpha）。

✍️ 批注：

### 5.10 库页面 UI

`[已定]`

**布局**（第 95 轮 A）

```
┌─ 左列(可折叠) ─┬─ 主区 ────────────────────────────────┐
│ 合辑           │ [搜索框]        [视图][排序]          │
│  全部/收藏     │ [标签 chips 行]                       │
│  最近导入/未分类│ ┌当前：软件内┐ ┌当前：桌面层┐        │
│ 自定义合辑     │ └────────────┘ └────────────┘        │
│ 标签           │ ┌────┐ ┌────┐ ┌────┐ ┌────┐          │
│  自动补全列表  │ │卡片│ │卡片│ │卡片│ │卡片│  3–4 列   │
│ 来源           │ └────┘ └────┘ └────┘ └────┘          │
│  导入/监控/工坊│                                      │
└────────────────┴──────────────────────────────────────┘
```

| 元素 | 规格 |
| --- | --- |
| 卡片 | 封面 + 底部渐变条（标题 / 时长 / 来源角标）（第 43 轮 B） |
| 卡片交互 | 单击 → 选中并开详情抽屉；悬停 → 静音播 2 秒；双击 → 全屏预览；右键 → 应用(软件内)/应用(桌面层)/收藏/标签/加合辑/打开路径/删除（第 97 轮 A） |
| 详情抽屉 | 右侧 380px：大预览 → 元信息（来源/分辨率/时长/大小/路径）→ 操作按钮组 → 标签编辑（第 44/96 轮） |
| 全屏预览 | 左右箭头翻页 + 右上信息浮层（第 72 轮 B） |
| 拖拽 | 拖起素材 → 弹出两个投放区（软件内 / 桌面层）（第 73 轮 B） |
| 空态 | 三步引导卡：1 添加素材 → 2 选壁纸 → 3 开启桌面（第 74 轮 B） |
| 页内引导条 | 首次进入显示，可关闭（第 38 轮 D） |
| 快捷键说明 | 一个面板列出全部壁纸相关快捷键（第 40 轮 D） |
| 样式 | **沿用现状**：现有 CSS 变量（`--panel: rgba(18,19,24,.72)`、`--panel-solid:#121318`、`--rail-bg`）+ 毛玻璃 `backdrop-filter`，壁纸作为最底层透出（第 46 轮） |

✍️ 批注：

### 5.11 托盘与热键

**托盘菜单**（第 93 轮 B，六项 + 信息）

```
● 正在播放：<当前壁纸名>   ☆
────────────────────────────
显示主窗口
暂停 / 继续
下一张
桌面层：开 / 关
设置…
────────────────────────────
退出
```

**热键**（第 39 轮 C，均可自定义，支持录音键位）

| 动作 | 默认 |
| --- | --- |
| 上一张 | `Ctrl+Alt+←` |
| 下一张 | `Ctrl+Alt+→` |
| 暂停/继续 | `Ctrl+Alt+Space` |

✍️ 批注：

### 5.12 律动引擎

这是你要我补的「节拍与音频律动」能力。现状：离线分析（`/api/analysis`，含 BPM / 拍点 / downbeat 网格）已有；实时 `AudioFrame` 的 `beat` 字段是**占位假脉冲**（约固定 2Hz），没有真实 onset，也没有任何视觉消费端。

| 层 | 内容 |
| --- | --- |
| **onset 检测** | 对 `AudioWorklet` 送来的 64 bins 做谱通量（spectral flux）+ 自适应阈值（局部均值 + k×标准差），输出真实脉冲；替换 `web/src/core/audio.ts` 里的假 `beat` |
| **时间轴对齐** | 歌曲有离线分析缓存时，用 BPM + 拍点网格把实时 onset 对齐到网格，减少漂移；无缓存时纯实时 |
| **事件总线** | 统一派发 `beat` / `downbeat` / `section`（乐句边界），带延迟补偿（渲染管线延迟 + 音频输出延迟），壁纸可视化 / 节拍转场 / UI 动效共用一套 |
| **消费端** | 5.9 可视化、5.3 转场的 downbeat 卡点、UI 动效 |
| **缓存** | 沿用现有 `%LOCALAPPDATA%\Zilux2\analysis\`（键 `source:id:analyzerVersion`，上限 300MB 按 mtime 淘汰） |

`[待批注]` 整库后台预分析（把所有歌提前跑一遍缓存）暂列**二期可选**，默认关。

✍️ 批注：

**实现备注（2026-11-15）**：这张表的前三行已经落地，但落点与原文不同 —— onset 检测放在了**宿主侧**（C#），不是页面里的 AudioWorklet：

- `src/Zilux2/Audio/AudioFeatures.cs`：`AudioAnalyzer.Analyze()` 里把原来的「低频能量突增 + 固定阈值 0.12 + 320ms 冷却」换成谱通量 `flux = Σ max(0, mag[i] - prevMag[i])`，阈值取最近 43 帧（约 1.4 秒 @30Hz）的 `均值 + 1.6×标准差`，冷却压到 95ms，静音段（最大幅度 < 1e-4）直接压零。输出新增两个字段：`strength`（`flux / threshold`，归一化 0–1）与 `bpm`（最近 12 次 onset 间隔的中位数取倒数，收敛到 70–180，指数平滑 0.3）。
- 为什么放宿主：页面拿不到原始 PCM（`AudioWorklet` 那条链路只在 `audioTap` 的自娱自乐路径上用），宿主 WASAPI 环回已经有 2048 点 FFT，加谱通量是几十行的增量，而且 30Hz 的判定精度对 100–180 BPM 够用（相邻 beat 间隔 333–600ms）。
- **踩到一个老 bug**：`web/src/main.ts` 从来没有调用 `initAudio()`，也就是说页面侧的 `audioFrame()` / `audioBeatAgo()` / 所有可视化订阅拿到的永远是空帧 —— 之前「律动没做」有一半是这个原因。已补在 `main()` 开头。
- `web/src/core/beatClock.ts`（新建）：把离散的 `beat` 布尔变成可持续查询的时钟 —— `onBeat` / `onDownbeat`（每 4 拍）事件、`beatPhase()`（0..1 相位）、`currentBpm()`、`tickPrediction()`（BPM 已知但 beat 稀疏时补拍，最多补 2 拍）。延迟补偿固定 45ms（30Hz 推送 + WASAPI 环回的经验值）。
- 消费端：`web/src/ui/wallpaperLayer.ts` 订阅 `onBeat`，把峰拍写成 `#wallpaper-root` 上的 CSS 变量 `--wp-beat`（`scale 1 + pulse × 1%`，`transition 80ms`），强度取设置里的 `beatStrength`（默认 50）。**不作用在 `<video>` 的 transform 上**，那是转场用的，两者会互相覆盖。
- 实测（`_tools/_cdp_beat2.mjs` 监听宿主推送，`_tools/_cdp_pulse.mjs` 读 CSS 变量）：24 秒 338 帧 / 30 拍（`beatRatio 0.089` ≈ 135 BPM，与 `bpm` 字段的 136.6 一致），`strengthMax 1.0`，`--wp-beat` 在 1.0000–1.0038 之间跳动。加上脉冲后 CPU 5.6%（无脉冲时 3.4%），仍在 §9.2 的 10% 门槛内。

---

## 6. 默认值总表（开箱即用）

`[已定]` 第 51 轮「开箱即用」，冲突处按后轮覆盖。

| 键 | 默认 | 范围 / 选项 | 组 |
| --- | --- | --- | --- |
| `enabled` | true（有素材时） | bool | 基础 |
| `inAppEnabled` | true | bool | 基础 |
| `desktopEnabled` | false | bool | 桌面层 |
| `pagePolicy` | 常规开 / 沉浸关 / 房间关 / 登录关 | 逐页 | 基础 |
| `audioEnabled` | false | bool | 基础 |
| `audioVolume` | 40 | 0–100 | 基础 |
| `audioFollowSystem` | false | bool | 基础 |
| `musicDuckMs` / `musicRestoreMs` | 300 / 800 | 0–2000 | 基础 |
| `occludeThreshold` | 0.80 | 0.5–1.0 | 基础 |
| `closeToTray` | true | bool | 基础 |
| `autoLaunch` | off | off / wallpaper-only / full | 基础 |
| `transitionMode` | random | random / fixed | 转场 |
| `transitionId` | — | 见 5.3 | 转场 |
| `transitionMs` | **800** | 0–2000 | 转场 |
| `rotationEnabled` | false | bool | 轮换 |
| `rotationMinutes` | 30 | 15/30/60/120 | 轮换 |
| `rotationOrder` | random | random / sequential | 轮换 |
| `rotationFavoriteFirst` | false | bool | 轮换 |
| `prewarm` | true | bool | 轮换 |
| `frameRateLimit` | 60 | 30/60/144/0(不限) | 性能 |
| `renderScale` | 100 | 100/75/50 | 性能 |
| `hardwareDecode` | true | bool | 性能 |
| `downsampleAbove` | 1440 | 1080/1440/2160/off | 性能 |
| `concurrentDecode` | auto | auto / 1-8 / unlimited | 性能 |
| `pauseOnMinimize` | true | bool | 性能 |
| `idleFpsAfterSec` | 60 | 10–600 | 性能 |
| `idleFps` | 15 | 10/15/24 | 性能 |
| `pauseOnBattery` | true | bool | 性能 |
| `pauseOnFullscreen` | true | bool | 性能 |
| `adaptiveQuality` | true | bool | 性能 |
| `reduceMotion` | 跟随系统 | 跟随/始终降/不降 | 性能 |
| `parallax` | 0.30 | 0–1 | 视觉 |
| `overlayEnabled` | false | bool | 视觉 |
| `dimMode` | auto | auto / fixed / off | 视觉 |
| `dimBase` / `dimMax` | 0.20 / 0.40 | 0–1 | 视觉 |
| `dimEmaMs` | 800 | 200–2000 | 视觉 |
| `brightness` / `contrast` / `saturation` / `blur` | 0 / 0 / 0 / 0 | -100–100 / 0–50 | 视觉 |
| `accentFromFrame` | true | bool | 视觉 |
| `fitMode` | smart | smart/cover/contain/fill/stretch | 视觉 |
| `desktopSound` | false | bool | 桌面层 |
| `edgeBarEnabled` | true | bool | 桌面层 |
| `edgeBarDelayMs` | 400 | 100–1000 | 桌面层 |
| `visualizerEnabled` | true | bool | 音频联动 |
| `visualizerStyle` | spectrum | spectrum/wave/ring/particles | 音频联动 |
| `beatStrength` | 50 | 0–100 | 音频联动 |
| `gridDensity` | standard | compact/normal/large | 库 |
| `thumbConcurrency` | 2 | 1–4 | 库 |
| `hotkeyPrev` / `hotkeyNext` / `hotkeyPause` | Ctrl+Alt+← / → / Space | 可自定义 | 托盘/热键 |
| `cacheKeepDays` | 30 | 7/30/90/forever | 诊断 |

✍️ 批注：

---

## 7. API 端点

全部挂 `LocalMusicServer`，前缀 `/api/wallpaper/v2/`，沿用现有 token 鉴权。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/state` | 两画布状态、当前壁纸、开关、运行指标快照 |
| POST | `/library/scan` | 触发扫描（body: `{full:bool}`） |
| GET | `/library/items` | 分页查询：`query, tags, kind, resolution, duration, size, sort, offset, limit` |
| GET | `/library/items/{id}` | 单条详情 |
| POST | `/library/import` | `{paths:[], copy:bool, collectionId?}` |
| DELETE | `/library/items/{id}` | 移出库（可选同时删文件） |
| POST | `/library/items/{id}/cover` | `{timeMs}` 重新取帧 |
| PUT | `/library/items/{id}` | 改标签/合辑/裁剪/速度/变换/适配覆盖 |
| GET/POST | `/collections` | 合辑列表 / 新建 |
| GET/POST/PUT/DELETE | `/sequences` | 序列 CRUD |
| POST | `/canvas/{kind}/apply` | `{assetId}` 或 `{sequenceId}`，kind=`inapp`\|`desktop` |
| POST | `/canvas/{kind}/pause` | `{paused}` |
| POST | `/canvas/{kind}/next` | 下一张 |
| GET/PUT | `/options` | 读/写全部壁纸设置 |
| GET | `/monitors` | 显示器清单 + 每屏分配 |
| POST | `/desktop/attach` / `/desktop/detach` | 接管/释放桌面层 |
| GET | `/diagnostics` | 面板数据 |
| POST | `/diagnostics/export` | 导出 zip |
| POST | `/selfcheck` | 自检 |
| GET | `/storage` | 占用统计 |
| POST | `/storage/clean` | 清理 |
| GET/POST/PUT/DELETE | `/presets` | 配置预设 CRUD |
| GET/POST/PUT/DELETE | `/rules` | 条件规则 CRUD |

✍️ 批注：

---

## 8. 分期计划

`[已定]` 第 37 轮 B。

### 一期 —— 双画布核心（可日常使用）

1. 删除旧模块（第 2 章全清单）
2. 素材库：扫描 / 导入 / SQLite 索引 / 封面抽帧 / 筛选排序 / 去重
3. 解码：FFmpeg 接入（硬解优先、软解兜底、GIF/图片）
4. 渲染：软件内背景层 + WorkerW 桌面层（含自愈、多屏）
5. 转场：全部 13 个预设 + 双实例预热切换
6. 设置页 9 组骨架（律动相关组先留占位）
7. 托盘 / 热键 / 自启（含 `--wallpaper-host`）
8. 诊断面板 + 存储管理
9. 自动化回归脚本（第 9 章）

### 二期 —— 增强

1. 律动引擎（真实 onset + 事件总线）— ✅ 已实现（2026-11-15，见 §5.12 实现备注）
2. 音频可视化（4 样式）— ✅ 已实现（2026-11-15，见 §5.9 实现备注）
3. 节拍驱动转场 / 缩放脉冲 / UI 动效 — ✅ 已实现（2026-11-16）：缩放脉冲（`--wp-beat` CSS 变量，实测对帧率与 CPU 无可测影响）、「卡在节拍上切」（设置项 `beatLock`：音乐在播时把 `next` 推迟到下一个 onset，最长等 1.5 秒兜底）、界面微动效（同一脉冲写到 `--wp-beat-ui`，库页「当前壁纸」封面按 1.000→1.022 呼吸；`prefers-reduced-motion` 下自动静止）
4. 序列编排 — ✅ 已实现（2026-11-15）：`/sequences` CRUD + `/canvas/{kind}/sequence` 播放；设置页可直接「生成 10/30 秒轮播」并按列表播放/停止/删除
5. 条件规则 — ✅ 已实现（2026-11-15）：`RuleEngine` 每 60 秒评估一次，支持时间窗条件（含跨午夜）与切素材/起序列两种动作；前台应用与电量条件已解析但暂不参与判定
6. 配置预设 + 外观联动 — ✅ 已实现（2026-11-16）：预设 CRUD + 设置页「保存当前为预设 / 应用 / 删除」；外观联动切 dark 会自动应用名字带「暗/夜间/dark/night」的 appearance 预设、切 light 应用「亮/白天/light/day」。之前「切主题没反应」的真因是 CORS 预检没放行 PUT（见 §8.6），不是联动代码
7. 片段裁剪（入点/出点/速度）+ 画面变换（镜像/旋转/裁剪）— ✅ 已实现（2026-11-15，见 §5.2 实现备注）
8. 叠层（时钟/文字模板）— ✅ 已实现并两处可用（2026-11-16）：页面侧 `.wp-overlay` 跟随 `{time}/{date}/{weekday}/{year}/{month}/{day}` 占位符，软件内与桌面层共用同一份页面代码；之前 WPF `TextBlock` 画不出字的问题随桌面层改 WebView2 一并消失
9. 批量操作 / 取帧时间轴 / 多排序 — ✅ 已实现（2026-11-16）：库页 Ctrl/Shift 点卡片或点卡片右上角圆框可多选，底部浮动条给「收藏 / 取消收藏 / 移出库 / 清空」；抽屉裁剪区加了时间轴缩略条 + 两枚可拖把手（拖动改入点/出点）；多排序在一期已落地
10. （可选）整库后台预分析

✍️ 批注：

### 8.3 实现备注（2026-11-15 落地时的一次架构调整）

`[实现事实]` 这里记的是一期施工中实测出来的偏离，原文规格未变，但实现按实测结果改了。

**软件内壁纸不再走 WPF 渲染，改由页面里的 `<video>` 播放。**
一期最初按 §3.1 的「渲染层 → 软件内表面」用 `WallpaperCanvasSurface` + ffmpeg 输出 BGRA 帧 + `WriteableBitmap` 写屏。实测同一段 1080p 视频：WPF 位图路径 60fps 时 app 129.5% + ffmpeg 146.2%（合计 275%），30fps 也有 181%，暂停画布立刻掉到 6.1% —— 开销全在每帧 `WritePixels`（约 3.2ms CPU/帧，与像素量线性）。改用 WPF `MediaPlayer` + `VideoDrawing` 更差（164.9%、内存 506MB）。最后把画面交给页面：`<video src="/api/wallpaper/v2/media/{id}">` 由 Chromium 硬解，**app CPU 6.6%、内存 240MB、ffmpeg 子进程 0 个**，差 24 倍。

因此现在的分工是：
- **软件内**：宿主只推指令（`WallpaperLayerPayload`），页面 `web/src/ui/wallpaperLayer.ts` 负责建 `<video>`、切转场（CSS 属性动画，14 种）、滤镜（CSS filter）、压暗（独立半透明层）、按页面类型显隐。`WallpaperCanvasSurface` 仍保留但只服务桌面层。
- **桌面层（WorkerW）**：WorkerW 里没有 WebView，只能走 WPF 位图管线，所以额外降载：解码尺寸按桌面像素**再减半**、帧率上限 **30fps**。实测运行桌面层约 app 107% + ffmpeg 31%（可选功能，默认不接管）。
  > 这条后来被推翻了 —— 桌面背景歌词窗口那条路（Progman 下的 WebView2）不需要 WorkerW，桌面层也能吃 Chromium 硬解，实测两条画布同时跑 CPU 4.7%。见 §8.5。WPF 位图管线现在只作为回退保留。
- **转场**：14 种预设从「WPF 双 Image 层 + BlurEffect/TranslateTransform」改为「两层 `<video>` + CSS transition」。旧层先 `pause()` 冻结最后一帧再淡出（保留画面，不再解码），淡出结束才清 `src` 释放解码器 —— 否则连续切换会堆解码实例，30 次就能把 CPU 顶到 80% 以上。

**性能门槛的口径**：§9.2 的 CPU < 10% / 内存 < 300MB 按「软件内壁纸运行」量（`_tools/wallpaper-v2-accept.ps1` 在采样前会先释放桌面层）。当前实测：**CPU 5.4%、内存 251MB、20 秒无增长**，30 次切换 + 暂停往返 `fails=0`。

**验收脚本**已按 §9.5 命名为 `_tools/wallpaper-v2-accept.ps1`，退出码 = 失败项数，可无窗口运行（`-SkipPerf` 跳过性能段，`-KeepRunning` 留进程）。当前 **failures=0 / total=43**。

### 8.4 二期落地与长跑实测（2026-11-16 补）

`[实测]` 二期已完成/部分完成的项见 §8 二期列表的勾选标记。这里只记数字。

**500 次连续切换压测**（`_tools/wallpaper-v2-stress.ps1`，三段各 200/200/100 次 `POST /canvas/inapp/next`）：

| 阶段 | 失败 | 工作集 | 句柄 | 线程 |
| --- | --- | --- | --- | --- |
| 起点 | — | 212.5 MB | 1086 | 49 |
| 第一轮 200 次后 | 0 | 242.3 MB | 1171 | 55 |
| 第二轮 200 次后 | 0 | 254.3 MB | 1172 | 55 |
| 累计 500 次后 | 0 | 248.6 MB | 1168 | 54 |

读法：**句柄与线程在第一轮就稳定下来，后 300 次几乎没有增长**（1171 → 1168）；内存两轮分别 +29.8 MB、+12.6 MB，增速递减且最终回落到 248.6 MB —— 符合「Chromium 解码器回收 + GC 滞后」，不是线性泄漏。会话结束后画布仍在正常播放（`/state` 返回 `inApp.running=true`）。

**静置长跑**：`_tools/wallpaper-v2-soak.ps1 -Minutes 34 -IntervalSec 60`，**不带 `ZILUX2_WEBVIEW_ARGS`**（调试端口会影响读数，见下），软件内壁纸播放中、什么都不做：

| 分钟 | 工作集 | 句柄 | 线程 | CPU |
| --- | --- | --- | --- | --- |
| 0 | 222.3 MB | 1128 | 50 | 0% |
| 2 | 225.0 MB | 975 | 31 | 6.95% |
| 10 | 227.6 MB | 1007 | 37 | 5.18% |
| 20 | 226.6 MB | 985 | 35 | 5.78% |
| 34 | 230.3 MB | 966 | 29 | 5.13% |

读法：34 分钟内存 222.3 → 230.3 MB（**+8 MB，0.24 MB/分钟，且中段回落过两次**），句柄从 1128 降到 966、线程 50 降到 29 —— 平台期稳定在 225~230 MB，远低于 §9.2 的 300 MB 门槛，不是泄漏。

**一个会影响读数的坑**：带 `--remote-debugging-port=9333` 启动时，同样 34 分钟会飘到 480±45 MB / 1300±65 句柄。CDP 调试端口本身要维持一份完整的调试目标会话（DOM、脚本、网络日志），这份开销在 Release 下不存在。**做长跑测量前务必 `Remove-Item Env:\ZILUX2_WEBVIEW_ARGS`**。

本文档的 8 小时版本仍留给发布前最后一次跑。

### 8.5 桌面层二次调整：Progman 里的第二个 WebView2（2026-11-16 晚）

§8.3 里「桌面层只能走 WPF 位图管线」是被 WorkerW 路径限制住才成立的说法。桌面背景歌词窗口（`src/Zilux2/DesktopBackgroundWindow.xaml.cs`）早就给出了另一条路，实测在 Win11 26H2 上可用：

```
WPF Window + WebView2
  → SetWindowLong 加 WS_CHILD（去掉 WS_POPUP/WS_CAPTION/WS_THICKFRAME）
  → SetParent(Progman)
  → SetWindowPos 插到 SHELLDLL_DefView（图标层）的正下方
```

壁纸因此渲染在「桌面图标之下、静态壁纸之上」，不需要 WorkerW，桌面右键菜单、框选、拖放全部照常。新增 `src/Zilux2/Wallpaper/Render/DesktopWebSurface.cs` 承载这条路径，两个 WebView（主页面 + 桌面层）共用 `WallpaperStateJson.Build(...)` 推的同一份 `wallpaperState`，页面侧 `?scene=wallpaper` 走 `web/src/ui/wallpaperScene.ts` 只演壁纸、不启动整套 App。

| | WPF 位图桌面层 | Progman 里的 WebView2 |
| --- | --- | --- |
| CPU（软件内 + 桌面层同时跑） | app 107% + ffmpeg 31% | **4.7%** |
| 画质 | 半分辨率 + 30fps 上限 | 全分辨率 60fps |
| 转场/滤镜 | WPF 双 Image + BlurEffect | 与软件内同一套 CSS |
| 叠层（时钟/文字） | `TextBlock` 画不出（遗留 bug） | 与软件内同一份 `.wp-overlay` |

`WallpaperHost.AttachDesktop()` 现在优先建 WebView，失败（拿不到共享 `CoreWebView2Environment`）才回退 WPF 位图。5 秒自愈逻辑保留：父窗口不再是 Progman 就整条重挂。

### 8.6 一个跨源细节（2026-11-16）

页面里对 `/api/wallpaper/v2/*` 的 PUT/DELETE 会触发 CORS 预检。`LocalMusicServer.ApplyCors` 原本只声明 `GET,POST,OPTIONS`，于是「应用预设」「批量收藏」「移出库」这些前端动作全部被浏览器拦成 `无法连接在线源` —— 而用 PowerShell 直接打接口却是通的，很容易误判成前端 bug。已把 `Access-Control-Allow-Methods` 补成 `GET,POST,PUT,DELETE,OPTIONS`。

### 8.7 多屏：一个窗口铺满虚拟屏，页面里按屏切 cell（2026-11-16）

`[实现事实]` 第 25 轮 C 要求「每屏独立指定」，落地时按下面这套做：

- **宿主**：`DesktopWebSurface` 的窗口尺寸取 `SystemInformation.VirtualScreen`（不再是 `GetSystemMetrics(SmCxScreen/SmCyScreen)` 的主屏尺寸），位置 = `virtualScreen.Left - origin.X`（副屏在主屏左边/上边时虚拟屏原点是负数，写死 0 会让那一侧整条空着）。
- **布局下发**：`WallpaperHost.BuildScreenLayoutJson()` 把每块屏换算成**相对虚拟屏的百分比矩形**（`{"l","t","w","h"}`），随 `wallpaperState` 的 `layer.screens` 一起推给页面。用百分比而不是像素，是为了绕开 DPI —— 本机是 100% 主屏 + 150% 副屏混插，用像素得在页面里再算一遍缩放，直接用百分比就没有这个问题。
- **页面**：`wallpaperLayer.ts` 的 `swap()` 看到 `screens.length > 1` 就为每块屏建一个 `.wp-screen`（`left/top/width/height` 用百分比），里面各放一份自己的 `<video>`／`<img>`，各自 `object-fit: cover`。
- **为什么不是「跨屏连续裁切」**：本机是 1 竖 2 横（1080×1920 + 2560×1440 + 3440×1440），如果把整个虚拟屏当一张大画布连续铺，竖屏会被横图裁掉一大半。每屏独立 cover 的代价是接缝两侧不是同一张连续画面，但每块屏都是完整构图 —— 按用户实际屏型选了后者。

实测（`_tools/_cdp_multi.mjs`）：`cells=3 medias=3 ready=4 viewport=4520x2880`，三块 cell 的矩形与 `Screen.AllScreens` 一一对应；截图确认三块屏都有壁纸、桌面图标仍在壁纸之上，虚拟屏里没有被显示器覆盖的空白是黑的（正常）。这项已接进 `_tools/wallpaper-v2-accept.ps1`，不再是人工 SKIP。

**这一段踩了四个坑，都记一下**：

1. `screens` 不能直接塞 JSON 字符串。`JsonSerializer.Serialize` 会把 `string` 写成带引号的字面量（`"screens":"[{...}]"`），前端 `Array.isArray` 判 false 就悄悄退回单屏。必须先 `JsonSerializer.Deserialize<JsonElement>(json)` 再放进去；三元表达式里要写 `(object?)null` 否则 `null` 与 `JsonElement` 没有共同类型（CS0173）。
2. 桌面层那块页面**没有主窗口的 boot 数据**，`onlineEndpoint()` 返回空串，`<video src="">` 会被浏览器当成「当前文档 URL」，加载失败 → 回退封面 → 封面也取不到 → 整块黑屏。所以推送时把 `mediaUrl`/`coverUrl` 直接换成带 token 的绝对地址，并且 `onlineEndpoint()` 遇到已经以 `http(s)://` 开头的路径要原样返回（否则会拼成 `http://...http://...`）。
3. `swap()` 的重建 key 必须包含 `mediaUrl`。桌面层比主页面晚就绪，第一次推过来的地址可能是空的，如果 key 只看 `assetId:kind:trim` 就永远不会重建，页面会一直卡在失败状态。
4. 桌面层是**独立的 CoreWebView2 实例**，`SetVirtualHostNameToFolderMapping` 不会从主窗口继承，必须在它自己的 `EnsureCoreWebView2Async` 之后重新注册一次；另外宿主的第一次 `PostWebMessageAsJson` 几乎必然早于页面就绪被丢掉，页面脚本跑起来后要 `postMessage({type:'wallpaperReady'})` 主动要一次状态。

### 8.8 界面微动效（2026-11-16）

`[实现事实]` 二期第 3 项最后一块。做法是把节拍脉冲同时写到 `document.documentElement` 上的 `--wp-beat-ui`（幅度 1.0000–1.0220，比壁纸层的 `--wp-beat` 大一点才看得出），库页「当前壁纸」卡的封面用它做 90ms 的 `transform: scale()` 呼吸。没有音乐/壁纸关闭时变量不存在、CSS 回落到 `1`，等于完全静止；`@media (prefers-reduced-motion: reduce)` 下直接 `transform: none`。

没有做成「所有界面元素都跟着跳」——试过的范围越大越容易干扰现有动画（页面里的 `ui-fade-in`、抽屉入场、播放条位移都是自己的一套时序），最后只保留这一处，强度还能用既有的「节拍驱动强度 0–100」统一收放。

---

### 8.9 长跑观测（72 分钟实测，8 小时完整曲线未做）

2026-11-16 02:48 启动，**两画布同时运行**（软件内 + 桌面层），不带 CDP 调试端口。
采样脚本 `_tools/wallpaper-v2-soak.ps1 -Minutes 480 -IntervalSec 60`，每 60 秒一行写 `_soak.csv`；
折叠脚本 `_tools/soak_report.py`（只取 30 分钟之后的稳态段算斜率，避免把启动暖机当成泄漏）。

| 分钟 | 工作集 | 句柄 | 线程 | CPU |
| --- | --- | --- | --- | --- |
| 0 | 379.9 MB | 1146 | 48 | 0.00% |
| 10 | 392.9 MB | 1080 | 36 | 5.9% |
| 30 | 393.2 MB | 1011 | 36 | 6.8% |
| 45 | 389.6 MB | 1017 | 35 | 6.5% |
| 60 | 389.9 MB | 1017 | 36 | 8.1% |
| 72 | 408.1 MB | 1147 | 44 | 10.6% |

采样 73 次（02:48:05 → 04:00:06，共 72 分钟）。CPU 中位 6.30%、峰值 14.09%。

**结论（按数据说，不按期望说）：**

- **句柄与线程没有增长**：1146 → 1147（+1）、48 → 44（−4）。第一轮 30 次切换之后就稳定在 1010~1150 / 35~44 之间来回，这是无泄漏的直接证据。
- **工作集不是单调上升**：10 分 392.9 → 30 分 393.2 → 45 分 389.6 → 60 分 389.9，一直在 390 MB 上下小幅波动；只有最后一个点（72 分）跳到 408.1 MB，而同一时刻 CPU 也从 8% 跳到 10.6%，是那一瞬间在切壁纸 + WebView2 分配新解码缓冲区。
- 按稳态段算的线性斜率是 +0.219 MB/分钟，**但这个斜率不能外推成「8 小时会涨到 500 MB」**——锯齿状波动说明它受事件驱动，不是持续单调增长。
- **成本对照**：这个 390 MB 是「软件内 + 桌面层两个 WebView2 实例同时在跑」的占用；只开软件内时短窗验收是 **236~267 MB**（§9.2 的 300 MB 门槛按这个口径量）。多出来的 ~130 MB 就是第二个 Chromium 渲染进程 + 它自己的解码器的固定开销。

**未做的部分**：原计划的 8 小时完整曲线没有跑完 —— 跑到 72 分钟时用户叫停（要立刻拿成品）。所以 §9.3 那条「8 小时无单调增长」现在只有 72 分钟的证据支撑：句柄与线程已经明确持平，工作集呈锯齿波动而非单调上升。要彻底坐实，需要在空闲的机器上重跑一次 `_tools/wallpaper-v2-soak.ps1 -Minutes 480`，跑完执行 `python _tools/soak_report.py` 会自动填进本节。

---

## 9. 验收标准

`[已定]` 第 17 轮 E。

### 9.1 功能

第 5 章每一条都能在 UI 上走通，清单逐项打勾。

### 9.2 性能门槛

| 指标 | 门槛 | 测法 |
| --- | --- | --- |
| 帧率 | 1080p60 素材在 1080p 屏稳定 60fps | 诊断面板 30 分钟采样，掉帧率 < 1% |
| CPU | 单画布播放 < 10%（4 核参照） | 任务管理器 / 诊断面板均值 |
| 内存 | 常驻 < 300MB（不含解码器峰值） | 8 小时长跑后读数 |

### 9.3 稳定性

- 8 小时连续播放：内存无单调增长（回归斜率 ≈ 0）
- 500 次切换不崩、不泄漏句柄
- 暂停 → 恢复 → 切歌 → 重开桌面层，画面状态一致

### 9.4 视觉

- 切换**无闪黑**（首帧就绪才切）
- 多屏接缝不可见（每屏独立裁切正确）
- 壁纸上的 UI 文字对比度 ≥ 4.5:1（自动暗化生效）

### 9.5 自动化回归

脚本：启动 → 扫描 → 播放 → 切换 → 暂停 → 设置往返，**退出码 = 失败项数**，可无窗口运行。旧 `_tools/wp-accept.ps1` 删除后重写为 `_tools/wallpaper-v2-accept.ps1`。

### 9.6 验收现状（2026-11-16）

`pwsh -NoProfile -File _tools/wallpaper-v2-accept.ps1` → **`failures=0 / total=43`**。逐项对照：

| 条款 | 状态 | 实测 |
| --- | --- | --- |
| 9.1 功能 | ✅ | 43 项用例覆盖启动/扫描/筛选/详情/封面/媒体 Range/切图/暂停/选项往返/存储/诊断/自检/桌面层 |
| 9.2 CPU | ✅ | 静置 3.4%–5.4%（门槛 10%）；软件内走 Chromium 硬解 |
| 9.2 内存 | ✅ | 250–275MB（门槛 300MB） |
| 9.2 帧率 | ✅ | 页面 `<video>` 由 Chromium 合成；`rAF` 5.0ms/帧、`p95` 5.1ms |
| 9.3 500 次切换 | ✅ | `_tools/wallpaper-v2-stress.ps1`：0 失败，句柄 1086→1168、线程 49→54，**首轮后不再增长** |
| 9.3 8 小时长跑 | 🟡 72 分钟实测 | 句柄 1146→1147、线程 48→44 持平（无资源泄漏）；工作集 390±10MB 锯齿波动、非单调。完整 8 小时未跑（用户叫停），曲线与结论见 §8.9 |
| 9.4 无闪黑 | ✅ 自动 | `_tools/_cdp_flash.mjs`：切图时 16ms 采样两层 `opacity` 之和，`minOpacitySum=1`（任意时刻都有一层完全不透明） |
| 9.4 文字对比度 | ✅ 自动 | `_tools/_cdp_contrast.mjs`：8 个文本元素按 WCAG 算，最低 6.49:1（门槛 4.5:1） |
| 9.4 多屏接缝 | ✅ 自动 | 桌面层铺满虚拟屏，页面按每块屏的百分比矩形各建一个 `.wp-screen`（各自 `object-fit: cover`）；`_tools/_cdp_multi.mjs` 实测 `screens=3 cells=3 medias=3 minReady=4`，已接进验收脚本（不再是 SKIP） |

`_tools/wallpaper-v2-accept.ps1` 已把 9.4 的两项接成真跑（启动时带 `--remote-debugging-port=9333`，用 CDP 采样），不再是 SKIP。

✍️ 批注：

---

## 10. 待批注清单

这些我没把握，集中列出来。你在 2026-11-15 回复「没什么好改的了，直接开始」，所以**全部按建议值执行**；下表最后一列是落地时的实际状态。

| # | 问题 | 我的建议 | 落地状态 |
| --- | --- | --- | --- |
| 1 | 库目录放哪？ | LOCALAPPDATA | ✅ `%LOCALAPPDATA%\Zilux2\wallpaper\`（`WallpaperFolders`） |
| 2 | 桌面层首次手动开要不要弹引导？ | 弹一次，可勾「不再提示」 | ⚠️ 没做弹窗；替代是在桌面卡空态写「点「接管桌面」铺到桌面图标下面」，设置里也有 hint 文案 |
| 3 | 边缘控制条：每块屏都有还是只在主屏？ | 每块屏都有 | ❌ 未做（整条边缘热区功能都没实现） |
| 4 | 无操作降帧的等待时间 | 60 秒 | ⚠️ 设置项 `idleFpsAfterSec` 在、能存能读，但软件内走 `<video>` 后没有「降帧」这条路径了；桌面层固定 30fps。这项对当前架构已无实际作用 |
| 5 | 可视化默认样式与位置 | 频谱条，左下角 | ✅ 频谱条，铺在底部 32% 条带（不是只占左下角，全宽更好看；实测 CPU 7.0%） |
| 6 | 叠层时钟默认位置/字体 | 右下角、系统字体、48px | ✅ 右下角；软件内 40px、桌面层 56px（桌面看着更远），带半透明底衬保对比度 |
| 7 | 序列与条件规则同时命中，谁优先？ | 条件规则优先 | ✅ `OnRuleMatched` 先 `ClearSequence` 再应用 |
| 8 | 转场要不要「排除列表」UI？ | 要 | ✅ 设置页「转场」组 14 个 chip 可逐个排除 |
| 9 | WE 素材「转本地副本」后原条目保留还是替换？ | 替换 | ✅ 抽屉里多一个「转本地副本」按钮（仅工坊条目显示）→ `POST /library/items/{id}/localize` 复制进库目录并原地改 path/source，不留两条 |
| 10 | 多屏时软件内背景层跟主屏走还是独立选？ | 独立选 | ✅ 两条画布各选各的；但「每块屏各挂一个窗口」未做（见 §8.7 与第 9 章限制 2） |
| 11 | 诊断面板默认隐藏？ | 默认隐藏，角落小入口 | ✅ 放在设置页第 9 组，不在库页露出来 |
| 12 | 缩略图/缓存自动清理保留天数 | 30 天 | ✅ 设置项 `cacheKeepDays` 默认 30，`/storage/clean` 按它清理 |
| 13 | 随机轮换要不要「播完一轮再重复」 | 要 | ✅ `_playedThisRound` 集合：随机时排除本轮已播，全播完才清空重来；顺序模式清空集合 |
| 14 | 图片壁纸要不要 Ken Burns 缓慢推拉？ | 要 | ✅ 静态图加 `.is-kenburns`，24 秒 1.00↔1.06 缓慢推拉；用独立的 CSS `scale` 属性避开与转场/镜像的 transform 冲突，`prefers-reduced-motion` 下静止 |
| 15 | GIF 要不要限帧率/限尺寸 | 限 30fps、超 4K 降采样 | ❌ 未做（GIF 走 `<img>`，帧率由浏览器控制，管不到；降采样也没做） |

✍️ 批注：

---

## 下一步

你在 2026-11-15 18:37 回复「我觉得没有什么好改的了，那就直接开始吧」，于是按第 99 轮的决定执行了：**一次性删掉旧壁纸模块 → 从零写一期**。两份旧文档已归档到 `archive/wallpaper-2026-11-15/`（没有 `rm`）。

§10 里标 ❌ 的 4 项（首次引导弹窗、边缘控制条、WE 转本地副本按钮、Ken Burns）与标 ⚠️ 的 2 项（空闲降帧、随机不重复一轮）是现存的已知缺口，不在 §9 的验收条款里。要补的话告诉我编号即可。

不建 git commit / push，除非你明说。

## 11. 自检记录（2026-11-16 06:23–08:00）

用户要求「不追求速度只追求质量，每执行一项都要反思这一项为什么这样做、改变了什么、是否有利」。
下面按检查项记，每项都写清楚：**为什么这样测 / 测出了什么 / 改了什么 / 有利还是有害**。

### 11.1 转场有没有露底（14 种逐个测）

**为什么这样测**：转场露黑边是这类软件最显眼的问题（位移类转场最容易在边缘留缝）。
第一版我截图后做像素判黑，结果 19/56 张报「黑边」——但那些黑边其实是 **左侧 rail 的深色背景**，
以及 CDP 截图在转场瞬间抓到了尚未提交的合成帧（伪影）。**这个测法无效**，弃用。
第二版改成 **DOM 几何检测**：在页面里用 `setInterval(8ms)` 采样两个 `.wp-layer-frame` 的
`opacity / translate / scale`，把视口切成 12×12 网格，判断每个格心是否落在某个「不透明度 > 0.02」
的图层矩形内，取最小覆盖率。位移类转场如果留缝，覆盖率一定掉下来。

**测出了什么**：14 种转场（fade / fade-black / fade-white / slide-left / slide-right / slide-up /
zoom-in / blur-dissolve / radial-blur / exposure / glitch / film-grain / dissolve-noise / ripple）
在 1500ms 转场窗口内，**最小覆盖率全部 100%**，没有任何一帧出现未被覆盖的视口区域。

**改了什么**：没改产品代码。只留下 `_tools/_wp_cover.mjs` 作为可复跑的检查脚本。

**是否有利**：有利。它把「看起来没黑边」变成「几何上不可能有黑边」。同时暴露了一个**误报教训**：
像素判黑在带 UI 的截图里不可靠，后续做视觉验收都应该限定在 `#wallpaper-root` 范围内。

### 11.2 设置项是否真的生效（12 项逐条改 → 采样 → 复原）

**为什么这样测**：设置页有 60 多项，光看 UI 有开关不代表真的落到渲染上。
每一项都做「改前采样 → 改后采样 → 复原」，只有**真的变了**才算通过 —— 否则会把「本来就是默认值」
误判成生效。

**测出了什么（第一轮 6 项失败）**：

| 项 | 结果 | 根因 |
| --- | --- | --- |
| 压暗 `dimBase` | ✅ | — |
| 滤镜 | ❌ 只有 `saturate` | **测试写错**：这几个值是 `int`（−100~100），我传了 `0.4`，`Int()` 直接丢弃 |
| 适配 `fitMode` cover/contain/fill | ❌ 全是 contain | **真 bug**：前端从来没读 `layer.fitMode`，`object-fit` 在 CSS 里写死 `cover` |
| 适配 `fitMode=stretch` | ❌ | 见 11.3 |
| 叠层 | ✅ | — |
| 壁纸音轨 | ❌ muted 恒为 true | 见 11.3 |
| 暂停 / 恢复 | ✅ | — |
| 总开关 `enabled=false` | ❌ 画面不隐藏 | 见 11.3 |

**改了什么**：

1. **滤镜**：前端 `applyFilters()` 里原来有一行守卫 `if (!media.style.transition) media.style.filter = value;`
   ——只要 `media` 上残留过任何 `transition`，滤镜就永远不落地。**改成无条件写入**（转场动画作用在外层
   `.wp-layer-frame` 上，`media` 自己不参与，不存在互相覆盖）。用整数重测后
   `brightness(1.4) contrast(0.7) saturate(1.6)` 全部正确。
2. **适配**：`WallpaperLayerPayload` 新增 `FitMode`，推送 JSON 加 `fitMode`，前端 `applyFilters()` 末尾
   把它写到 `media.style.objectFit`（`smart` 折算成 `cover`）。重测 cover / contain / fill **全部通过**。

**是否有利**：有利，而且是**真 bug 修复**。适配这一项在此之前是完全失效的（用户选 contain 也没用），
滤镜则是一个隐蔽的条件守卫导致的「设置了但看不到」。第 1 项还纠正了我自己的测试方法错误
（整数范围不能用小数去测）。

### 11.3 那三项的真相：不是代码错，是前端没重新打包

上一轮记录的三项（`fitMode=stretch` / `audioEnabled` / `enabled=false`）在补完下面两件事后**全部 PASS**：

| 项 | 真实原因 | 修法 |
| --- | --- | --- |
| 三项一起不生效 | **`web/dist` 是旧的**。改完 TS 只跑了 `_tools/build.ps1`（不带 `-Web`），它只编 C#、不会重新打包前端。宿主推送的 JSON 一直是对的（临时日志抓到 `"audioEnabled":true,"audioVolume":65,"fitMode":"stretch"`）。 | 改前端必须 `build.ps1 -Web` |
| `fitMode=stretch` 判定失败 | `object-fit: stretch` 是 `fill` 的**旧别名**，`getComputedStyle` 会把它规范化成 `fill` | 测试判定放宽：`stretch` 接受 `fill` |
| 滤镜四项只有 saturate 生效 | 测试传的是小数（`brightness: 0.4`），而这四项是整数百分比，`Int()` 直接取整成 0 | 测试改传 `{40, 25, 60, 4}` → `brightness(1.4) contrast(1.25) saturate(1.6) blur(4px)` |

另外两处**代码本身的真 bug**也一并修了：

- `applyFilters()` 里曾有 `if (!media.style.transition) media.style.filter = value;` 守卫 —— 只要 `media` 上残留过任何 transition，滤镜就永不落地。转场动画本来就作用在外层 `.wp-layer-frame` 上，`media` 不参与，所以直接无条件写入。
- 音轨开关/音量原本只在 `createVideo()` 里设，而改设置**不会重建** `<video>` → 改了没反应。改成每次收到 payload 都对当前所有 `.wp-layer-media` 同步 `muted` / `volume`。

**结论**：`[settings] failures=0 / total=12`。

### 11.4 多屏比例：找到并修掉一个真 bug（`.wp-screen` 根本没样式）

`_tools/_cdp_multi.mjs` 只验了 `cells/readyState`，**没验比例**。这轮补了 `_tools/_geo.mjs`（读 `#wallpaper-root` / `.wp-layer-frame` / 每个 `.wp-screen` 的 `getBoundingClientRect` + `getComputedStyle`），一读就露馅：

```
frame : 4520x1635  position: static   ← 应该 4520x2880 absolute
cells : 1080x545 / 2560x545 / 3440x545  position: static
```

三块屏的**高度全都是 545px**（真实应该是 1920/1440/1440），而且 `position: static` 说明
`.wp-layer-frame` 与 `.wp-screen` 这两条 CSS 规则**压根没被定义过** —— 多屏布局一直在靠 `width` 百分比
硬撑，高度由内容撑开，于是每块屏都被压成一条。

补上规则（`web/src/styles/wallpaper.css`）：

```css
.wp-layer-frame { position: absolute; inset: 0; overflow: hidden; will-change: opacity, transform, filter; }
.wp-screen      { position: absolute; overflow: hidden; contain: paint; }
```

复测：

```
frame : 4520x2880  position: absolute
cells : 1080x1920 / 2560x1440 / 3440x1440  position: absolute
rects : [[0,953,1080,1920],[1498,0,2560,1440],[1080,1440,3440,1440]]
```

三块屏的矩形与各自分辨率**完全一致**，跨屏接缝处是同一帧的不同裁切，比例正确、不拉伸。

**为什么之前没人发现**：多屏那条验收只看「每块屏有没有画面」，不看「画面对不对」。
`cells=3 medias=3 ready=4` 全绿，但画面其实被压扁成 545px 高的一条 —— 这类「通过了但错了」
只有把几何读出来才能看见。

### 11.5 这轮自检的复盘

| 检查 | 方法 | 结果 |
| --- | --- | --- |
| 转场露底 | 12×12 网格采样 8ms，判每格心是否被某个不透明度 > 0.02 的图层覆盖 | 14/14 种转场最小覆盖率 **100%** |
| 设置生效 | 改前采样 → 改后采样 → 复原，只有真变了才 PASS | **12/12 PASS** |
| 多屏比例 | `getBoundingClientRect` + `getComputedStyle` 读几何 | 修前 3 块高度都 545px，修后 **1920/1440/1440 全对** |

### 11.6 继续深挖又抓到两个（图片路径 / 导入接口）

上一节收尾后没有停，继续按「视频验过了，图片呢」往下查，又发现两个真 bug：

| 现象 | 根因 | 修法 |
| --- | --- | --- |
| 图片壁纸只占左上角一小块（实测 641×360，窗口 1600×960） | `.wp-layer-media` 只有 kenburns 的动画样式，**没有 `width/height: 100%`** —— `<video>` 那张是 JS 里设了内联尺寸才铺满的，`<img>` 没有 | 加 `.wp-layer-media { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; display:block }`，video 与 img 共用 |
| `POST /library/import` 一律 500「宿主内部错误」 | `body["copy"]!.GetValue<string>()` —— JSON 布尔用 `GetValue<string>()` 会抛「An element of type 'True' cannot be converted to a 'System.String'」 | 改成 `IsTruthy(body["copy"])`（和 `paused` 那次同一类坑） |

修后复测：`{"tag":"IMG","nat":[640,360],"rect":[1673,1004],"fit":"cover","kenburns":true}` —— 铺满、cover、Ken Burns 也在跑。

### 11.7 GIF 拿到的是封面（第 6 个 bug）

`createImage()` 里写的是 `const src = layer.kind === 'image' ? layer.mediaUrl : \`/api/wallpaper/v2/cover/${layer.assetId}\`` ——
`image` 走原始文件、其它一律走封面。`gif` 当然不属于 `image`，于是 **GIF 壁纸加载的是 480×270 的静态缩略图**，
`<img>` 不会动。实测证据：`nat:[480,270]`（封面尺寸，GIF 本体是 320×180）、`src: .../cover/44`。

改成 `layer.kind === 'image' || layer.kind === 'gif' ? layer.mediaUrl : coverUrl` 后：

```
nat: [320, 180]   ← GIF 本体尺寸
src: /api/wallpaper/v2/media/44   ← 不再是 /cover/44
rect: [1600, 960]  fit: cover  kenburns: false   ← 铺满、GIF 不该有 Ken Burns
```

### 11.8 比例与状态一致性（人工核对，非自动）

- **正方形素材不拉伸**：生成 600×600 带正圆 + 十字线的图，`object-fit: cover` 铺到 1600×960 ——
  截图里圆仍是正圆、十字仍正交、四角标记落在四角，说明是**等比例放大后裁切**，没有挤压。
- **状态链路**（`GET /state` 逐步读）：

| 操作 | 结果 |
| --- | --- |
| 初始 | `inApp asset=43 paused=False run=True` |
| 暂停 | `paused=True run=False` |
| 恢复 | `paused=False run=True` |
| 切下一张 | `asset 43 → 5` |
| 接管桌面 | `desktop asset=41 run=True` |
| 释放桌面 | `desktop run=False`，`inApp run=True`（互不影响） |
| 重新接管 | `desktop asset=41 run=True`（记住上次选的素材） |

七步全部符合预期，没有出现「暂停后恢复不了」「重开桌面层丢了素材」这类状态错乱。

三个教训，都写在这份文档里了：

1. **像素判黑在带 UI 的截图里不可靠** —— rail 的深色背景、CDP 截图抓到未提交帧，都会造成假阳性。判「有没有露底」要用几何，不要用像素。
2. **`build.ps1` 不带 `-Web` 不会重新打包前端** —— 这个坑这轮踩了两次，第二次还是靠读几何才发现的。
3. **「通过了但错了」比「失败了」更危险** —— 多屏那条验收一直全绿，实际画面被压扁；只有把中间量（矩形、computed style）读出来，才知道对不对。
