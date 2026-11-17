# Zilux2 动态壁纸 v2 —— 成品交付说明

> 写完时间：2026-11-16 凌晨。规格与验收判据见 `docs/wallpaper-v2-spec.md`（§8 分期、§9 验收）。
> 这一版是**从零重写**的：旧的 `src/Zilux2/Wallpaper/` 21 个文件、WorkerW 那套 WPF 位图渲染、
> 那批 WE scene 壁纸支持全部删掉了，不是改，是删干净重来。

---

## 1. 怎么进去

左侧导航栏里那颗**星形图标**（悬停会展开文字「动态壁纸」）。点进去就是库页。

进不去的话看三件事：① 左侧 rail 上有没有这颗星；② 点它之后主区域是不是从首页切走了（壁纸页会占满 `main`）；
③ 右上角有没有一排按钮（排序、密度、添加、扫描、清理、设置）。

**设置在哪**：全软件只有一个设置按钮（左侧 rail 底部那颗齿轮）。壁纸设置是这个弹窗里的一个分类
「动态壁纸」，和「通用 / 外观 / 播放」并列。在壁纸页点右上角那颗齿轮，会直接打开它并选中「动态壁纸」。
分类内部再分 9 组：基础 / 库与素材 / 转场 / 声音 / 轮换与规则 / 桌面层 / 性能与暂停 / 视觉效果 / 诊断与日志
（内容区顶部那条横向子标签，带滑动高亮块）。关掉设置会回到你原来那一页，不会被留在首页。

**音频可视化不在这里**：它属于歌词效果，在「外观 → 歌词 → 音频可视化」里选（关闭 / 频谱 / 波形 / 圆环 / 粒子），
五种歌词样式各配一份。壁纸这边只留「节拍强度」（设置 → 动态壁纸 → 声音 → 节拍）。

---

## 2. 两条画布

规格里最核心的概念：**同一个素材库，两条互不干扰的画布**。

| | 软件内壁纸 | 桌面层壁纸 |
| --- | --- | --- |
| 铺在哪 | Zilux2 主窗口最底层，UI 半透明浮在上面 | 桌面图标下面、真壁纸上面 |
| 怎么开 | 壁纸页 → 点任意卡片「应用」，或设置 → 基础 → 软件内背景层 | 壁纸页右侧「接管」按钮，或 `POST /api/wallpaper/v2/desktop/attach` |
| 渲染 | 页面里的 `<video>`（Chromium 硬解） | Progman 下的第二个 WebView2，同一份页面代码 |
| 开销 | CPU 3%~7%，内存 ~235MB | 两条同时跑实测 CPU 4.7%、内存 275MB |
| 选择 | 各选各的，互不影响 | 各选各的 |

桌面层挂上之后，桌面图标照常可点、可框选、可右键、可拖放 —— 壁纸窗口是图标宿主的**兄弟**且被压到最底，
鼠标事件到不了它；`ShowInTaskbar=false` 且是 `Progman` 的子窗口，所以不进 Alt-Tab、也不出现在窗口预览里。

---

## 3. 素材从哪来

三路，都在设置 → 「库与素材」里：

1. **手动添加**：壁纸页右上角「添加」→ 选本地视频/图片 → 复制进库目录（`%LOCALAPPDATA%\Zilux2\wallpaper\library`）。
2. **目录监控**：填一个或多个监视目录，启动时静默扫描（不阻塞 UI），文件变了下次扫描自动更新。
3. **Wallpaper Engine 工坊**：自动读 Steam 的 `libraryfolders.vdf`，扫 `steamapps/workshop/content/431960/*`。
   有自带 `preview.gif` 就用它当封面，没有就抽帧（自动跳过黑场）。标题读 `project.json` 的 `title`。

支持格式：视频 `mp4/webm/mkv/mov/avi/m4v/wmv/flv/ts/mpg/mpeg`，图片 `jpg/jpeg/png/webp/bmp/tif/tiff`，GIF。
**不支持 WE 的 scene（.pkg）和 web 壁纸** —— 那是旧版的能力，这一版明确砍掉（见 spec §1.3）。

去重用「大小 + 头 1MB + 尾 64KB 的 SHA-256」，所以同一段视频换个文件名也不会重复入库。

---

## 4. 库页能干什么

- 搜索（名称/文件名）、排序（最近导入 / 标题 / 大小 / 时长 / 分辨率）、三组筛选（清晰度 / 时长 / 大小）
- 标签 chips 过滤；左侧三分组可折叠列（合辑 / 标签 / 来源）
- 卡片：封面 + 底部渐变条（标题 · 时长 · 来源角标）、缺失/收藏角标、悬停静音播 2 秒
- 单击开右侧抽屉（预览 → 元信息 → 画面变换 → 片段裁剪 → 操作 → 标签）
- **多选**：Ctrl/Shift 点卡片，或点卡片右上角圆框；底部浮动条给「收藏 / 取消收藏 / 移出库 / 清空」
- 双击全屏预览（左右箭头翻页）
- 网格密度三档（紧凑 / 标准 / 大图）

抽屉里的**画面变换**：镜像 H/V、旋转 0/90/180/270、四边裁剪 0–45%；**片段裁剪**：入点/出点（带时间轴缩略条 + 可拖把手）、速度 0.5×–2×。改完立刻生效，不用重扫。

---

## 5. 设置页 9 组

壁纸页右上角齿轮进，或库页顶部最后一颗按钮。左侧分组，右侧字段，改一个键立刻 PUT（没有「保存」按钮）。

1. **基础**：总开关、软件内/桌面层开关、音轨、遮挡静音阈值、关窗到托盘、开机自启（含「仅壁纸」轻量模式）、页面类型开关（常规/沉浸/房间）、配置预设
2. **库与素材**：库目录、监视目录、缩略图并发、缓存保留天数
3. **转场**：模式（随机/固定）、14 个预设的多选、时长 0–2000ms、**卡在节拍上切**
4. **轮换与规则**：定时轮换（15/30/60/120 分钟）、顺序、优先收藏、预热下一张、序列播放
5. **桌面层**：接管/释放、是否出声、边缘条
6. **性能与解码**：帧率（仅桌面层）、渲染比例、硬解、降采样阈值、空闲降帧、电池/全屏暂停
7. **视觉效果**：视差、叠层模板（`{time} {date} {weekday} {year} {month} {day}`）、暗化模式/基准/上限、亮度/对比度/饱和度/模糊、从帧取强调色
8. **音频联动**：可视化开关 + 4 样式（频谱/波形/圆环/粒子）、节拍强度 0–100
9. **诊断与日志**：素材数/收藏/占用/FFmpeg/两条画布状态、自检、导出诊断包（zip）、清理缓存

---

## 6. 快捷键

默认都不绑（避免和别的东西冲突），在「设置 → 快捷键」里自己录：

| 动作 | 说明 |
| --- | --- |
| `wallpaperNext` | 下一张壁纸 |
| `wallpaperPause` | 暂停/继续当前画布 |

托盘菜单还有四项：壁纸状态（只读）/ 暂停壁纸 / 下一张壁纸 / 桌面层。

---

## 7. 轻量自启

设置 → 基础 → 开机自启选「仅壁纸」，注册的命令行是：

```
Zilux2.exe --hidden --wallpaper-host
```

这个模式**不加载 WebView2 主窗口里的音乐模块、不连在线源、不拉起音频采集**，只跑桌面层的那个 WebView2 + 托盘。
适合「开机就想有动态桌面，但不想让播放器占资源」。

正常启动（全功能）时桌面层**不会自动接管**，要手动点一次「接管」；接管状态会被记住，下次启动自动恢复。

---

## 8. 出问题了先看这几处

| 现象 | 先看什么 |
| --- | --- |
| 壁纸页空空如也 | 设置 → 诊断里看「素材库」是不是 0；是的话点「扫描」，或检查 WE 工坊路径是否被识别 |
| 卡片在但是黑的 | 抽屉里看「来源」是否为缺失（文件被删/移动）；诊断里 FFmpeg 是否可用 |
| 视频不动 | 是否在沉浸播放页（歌词页）——那一页故意关壁纸；或画布被暂停 |
| 桌面没变化 | 是否点过「接管」；日志搜 `[wallpaper] desktop web surface attached`，没有的话看 `desktop host not found` |
| CPU 突然很高 | 检查是不是同时开着 CDP 调试端口（`ZILUX2_WEBVIEW_ARGS`），那份开销是调试用的，正常使用没有 |
| 声音不对 | 壁纸音轨默认关；开了之后音乐播放时会自动淡出（优先级：音乐 > 壁纸） |

日志：`%LOCALAPPDATA%\Zilux2\logs\host.log`。诊断页可以一键导出 zip（含状态快照、素材清单、日志尾部）。

---

## 9. 已知限制

1. **多屏按「每屏独立 cover」处理**，不是跨屏连续裁切。本机 1 竖 2 横，连续裁切会把竖屏毁掉，所以选了每屏各自完整构图。代价是接缝两侧不是同一张连续画面（见 spec §8.7）。
2. **桌面层只认一个窗口**（铺满虚拟屏、页面里按屏切 cell），没有做「每块屏各挂一个窗口 + 各自一份素材」。规格第 25 轮写的是「每屏独立指定」，当前实现是「每屏独立裁切 + 共用一份素材」。
3. **条件规则的「前台应用」和「电量」条件只解析不判定** —— 时间窗是实的，另外两种写进去不会命中（也不会误判成永久命中，`Matches` 对未实现类型返回 true 是刻意的：避免写了一条没支持的条件就把整条规则废掉）。
4. **8 小时长跑没跑完**：2026-11-16 02:48 起跑、03:59 被叫停，实采 **72 分钟**（两画布同跑，379.9→408.1MB）。30–60 分钟那段内存净降 4.4MB、句柄与线程同步下降，说明不是线性泄漏；60 分钟后有一次 18MB 的阶跃（同刻 CPU 从 8% 跳到 10.6%），形态像一次性资源占用而非持续增长。数据与分段斜率见 spec §8.9。要坐实得在空闲机器上重跑 `_tools/wallpaper-v2-soak.ps1 -Minutes 480`。
5. **旧的壁纸数据没有迁移**：老版本的 wallpaper 设置块、收藏、索引在删除时一起清掉了（第 14 轮「删除」）。首次进来是空库 + 自动扫描。

---

## 10. 文件在哪

| 内容 | 路径 |
| --- | --- |
| 规格书（唯一判据） | `docs/wallpaper-v2-spec.md` |
| 本文 | `docs/wallpaper-v2-handover.md` |
| 旧版架构/格式文档（归档，未删） | `archive/wallpaper-2026-11-15/` |
| C# 模块 | `src/Zilux2/Wallpaper/`（Model / Data / Library / Media / Render / Rules / 门面 `WallpaperHost.cs`） |
| 端点 | `src/Zilux2/Online/LocalMusicServer.Wallpaper.cs`（`partial`，前缀 `/api/wallpaper/v2/`） |
| 前端 | `web/src/wallpaper/client.ts`、`web/src/ui/wallpaperView.ts`、`wallpaperSettings.ts`、`wallpaperLayer.ts`、`wallpaperVisualizer.ts`、`wallpaperScene.ts` |
| 验收 | `_tools/wallpaper-v2-accept.ps1`（退出码 = 失败项数） |
| 压测 / 长跑 | `_tools/wallpaper-v2-stress.ps1`、`_tools/wallpaper-v2-soak.ps1`（写 `_soak.csv`） |
| 长跑报告 | `_tools/soak_report.py`（把 `_soak.csv` 折成表格 + 稳态斜率，填进 spec §8.9；样本不足 60 条只打预览不动文档） |
| 构建 | `_tools/build.ps1 [-Web]`（先杀进程再编） |

**做长跑测量前记得 `Remove-Item Env:\ZILUX2_WEBVIEW_ARGS`。** 带 `--remote-debugging-port` 启动时，CDP 要维持完整调试会话，34 分钟就会飘到 480MB / 1300 句柄；不带端口同样时长只到 230MB / 966 句柄。这个差值不是代码问题，是调试端口的固有开销。

---

## 11. 这次改了什么（变更清单）

### 11.1 新增

| 路径 | 内容 |
| --- | --- |
| `src/Zilux2/Wallpaper/`（26 文件） | Model（AssetEnums / WallpaperAsset / CanvasState）、Data（WallpaperDb / LibraryStore〔+2 个 partial〕）、Library（WorkshopLocator / Thumbnailer / LibraryScanner）、Media（FfmpegLocator / MediaProbe / FfmpegVideoSource / WallpaperPlayer / FileHasher）、Render（WallpaperCanvasSurface / WallpaperTransitions / WorkerWLocator / DesktopSurface〔WPF 回退〕/ DesktopWebSurface）、Rules（RuleEngine）、`WallpaperHost.cs`（门面）、`WallpaperStateJson.cs`、`WallpaperOptionsPatch.cs`、`WallpaperFolders.cs` |
| `src/Zilux2/Settings/WallpaperSettings.cs` | 9 组设置模型 + 白名单常量 + `Clone()` |
| `src/Zilux2/Online/LocalMusicServer.Wallpaper.cs` | `/api/wallpaper/v2/*` 全部端点（partial 类） |
| `web/src/wallpaper/client.ts` | 端点封装 + 类型 + 格式化 |
| `web/src/ui/wallpaperView.ts` | 库页（工具栏/两张当前卡/网格/抽屉/多选浮动条） |
| `web/src/ui/wallpaperSettings.ts` | 设置页 9 组（含序列、规则、预设、诊断、监视目录） |
| `web/src/ui/wallpaperLayer.ts` | 壁纸层（`<video>`/`<img>`、14 转场、滤镜、多屏 cell、叠层、节拍脉冲） |
| `web/src/ui/wallpaperVisualizer.ts` | 可视化 4 样式（spectrum / wave / ring / particles），**现在的入口在歌词那边**，见 §11.5 |
| `web/src/ui/lyricsVisualizer.ts` | 歌词页的音频可视化（5 档样式，localStorage 记忆，不进宿主设置） |
| `web/src/ui/wallpaperScene.ts` | 桌面层专用场景（`?scene=wallpaper`） |
| `web/src/ui/wallpaperAutoPreset.ts` | 明暗主题 → 预设联动 |
| `web/src/core/beatClock.ts` | 节拍事件总线（onBeat/onDownbeat/相位/延迟补偿） |
| `web/src/styles/wallpaper.css` | 壁纸页 + 壁纸层 + 多屏 + 设置页 + 叠层全部样式 |
| `docs/wallpaper-v2-spec.md`、`docs/wallpaper-v2-handover.md` | 规格书与本文 |
| `_tools/build.ps1`、`wallpaper-v2-accept.ps1`、`wallpaper-v2-stress.ps1`、`wallpaper-v2-soak.ps1`、`_cdp_*.mjs` | 构建与验收工具链 |

### 11.2 修改

| 文件 | 改了什么 |
| --- | --- |
| `src/Zilux2/App.xaml.cs` | `--wallpaper-host` 轻量自启分支（跳过在线源/音频/媒体会话，只跑桌面层 + 托盘） |
| `src/Zilux2/MainWindow.xaml` / `.xaml.cs` | 壁纸宿主接线（创建/Attach/状态推送/释放）、热键分发、托盘状态、文件选择器、`PublishWallpaperState` |
| `src/Zilux2/Settings/SettingsModel.cs` / `SettingsService.cs` | `SettingsModel.Wallpaper` + 键白名单 + `WallpaperChanged` 事件 + 一批读值 helper |
| `src/Zilux2/Settings/AutoLaunchService.cs` | 两个新参数（`startHidden` / `wallpaperOnly`） |
| `src/Zilux2/Hotkeys/HotkeyCatalog.cs` | 加 `wallpaperNext` / `wallpaperPause` 两项 |
| `src/Zilux2/Tray/TrayIconService.cs` | 菜单加 4 项壁纸项 + `UpdateWallpaperState` |
| `src/Zilux2/WebViewHost.cs` | 透明底开关、`wallpaper` 消息分支、`PublishWallpaperState`、`SharedEnvironment/NavigationUrl/FolderPath/VirtualHost`、`ready` 补推 |
| `src/Zilux2/Online/LocalMusicServer.cs` | 改成 `partial`；壁纸属性；PUT/DELETE 放行；CORS 补 `PUT,DELETE` |
| `src/Zilux2/Online/OnlineMusicService.cs` | 转发 `Wallpaper` / `Settings` 给 server |
| `src/Zilux2/Audio/AudioFeatures.cs` | 真实 onset（谱通量 + 自适应阈值）替换低频阈值法；新增 `Strength` / `Bpm` |
| `src/Zilux2/Audio/AudioFeatureService.cs` | 新增 `Frame` 事件（供壁纸「卡拍切」旁路消费） |
| `web/src/core/audio.ts` | `AudioFrame` 加 `strength` / `bpm` |
| `web/src/core/bridge.ts` | `WallpaperLayerState`、`onWallpaperLayer`、`onWallpaperState`、`pickWallpaperFiles`、`is-wallpaper-layer` 类切换 |
| `web/src/core/settings.ts` | 删掉旧的 `wallpaperToggle/wallpaperNext` 快捷键项（改由 `wallpaperNext/wallpaperPause` 接管） |
| `web/src/main.ts` | `initAudio()`（**之前从未调用，所有可视化拿不到帧**）、`startWallpaperLayer()`、`?scene=wallpaper` 分支 |
| `web/src/ui/app.ts` | rail 加「动态壁纸」一级入口、`wallpaperHost` 容器、`openWallpaperPage`、导航快照 |
| `web/src/online/client.ts` | `onlineEndpoint()` 遇绝对 URL 原样返回（桌面层用） |
| `web/src/styles/app.css` | 顶部 `@import './wallpaper.css'` |

### 11.3 删除

旧的 21 个壁纸文件 + `DesktopBackgroundWindow` 曾经被误删又恢复（它是桌面背景歌词窗口，保留）+ web 侧 4 个文件 + `_tools` 里约 50 个 `wp-*` 脚本 + `--wp-selftest` / `--sweep` 入口。

⚠️ **注意 git 状态**：这些旧文件**从来没有被 git 跟踪过**（整个仓库有大量未提交的二创内容），所以 `git status` 看不到 `D` 记录，只有新增。删除是文件系统层面的，历史里也没有可回滚的版本 —— 想找回只能看 `archive/wallpaper-2026-11-15/` 里归档的两份文档。

### 11.4 验证过的东西

| 项 | 结果 |
| --- | --- |
| `dotnet build` | 0 警告 0 错误 |
| `tsc --noEmit` | 干净 |
| `vite build` | 通过（`main-*.js` ~1.5MB） |
| `_tools/wallpaper-v2-accept.ps1` | **failures=0 / total=43**（含多屏、闪黑、对比度、性能三项） |
| 500 次切换 | 0 失败，句柄/线程首轮后不再增长 |
| 72 分钟长跑（两画布）| 句柄 1146→1147、线程 48→44 持平；工作集 390±10MB 锯齿波动（见 spec §8.9） |
| 桌面层 | 三块屏都有壁纸，图标在壁纸之上（截图确认） |

### 11.5 界面收口（2026-11-16 下午）

这一轮全是你上手点出来之后改的，记在这里免得下次又改回去。

| 问题 | 改法 |
| --- | --- |
| 壁纸页顶部一条渐变色块 | `.wp-toolbar` 底色去掉（`background: none`），壁纸直接从工具栏区域透出来 |
| 两条画布的应用方式不一样 | 抽屉里并排两颗等权按钮「应用到软件内 / 应用到桌面层」；桌面卡上的「接管/释放」只是画布开关，不是应用动作 |
| 壁纸页的按钮、开关和全局设置两套长相 | 全部换成全局设置那套类：`pill-switch`（关/开胶囊）、`set-row`、`set-row-label`、`set-row-hint`、`set-row-control`、`set-select`、`settings-nav` |
| 设置面板跟全局设置不是一回事 | **壁纸设置不再单独开面板**，直接成为全局设置里的一个分类。壁纸页齿轮 = 打开全局设置并落到「动态壁纸」 |
| 内层 9 组导航和外层 9 项并排看晕 | 嵌进去之后不要二级导航，改成一条长表单：9 组按顺序往下排，组名当分节标题 |
| 设置滚动会滚出到壁纸外 | 面板容器 `position: absolute` → `fixed` |
| 歌词页被壁纸盖住 | `.app.is-lyrics-open .wallpaper-host { display: none }` |
| 片段裁剪「用不了」 | 功能本身好的（实测入点/出点/速度全部生效），是藏在抽屉下半截：已挪到画面变换之前，并且改当前素材时提示「已生效」、改别的素材时提示「已保存，应用到画布后生效」 |
| 底部音频条不该算壁纸的选项 | 整块搬到「快捷设置 → 歌词 → 音频可视化」，5 档（关闭/频谱/波形/圆环/粒子），六种歌词样式各配一份；壁纸这边只留「节拍驱动强度」 |
| 设置项排得反人类 | 按「人怎么用」重排：基础组只留「开关 / 在哪显示 / 启动与退出 / 配置预设」；音频单独成「声音」组；「性能与解码」里帧率、渲染比例、硬解、降采样、并发五项**已删**（两条画布都走页面 `<video>`，这些参数调了不会有任何变化） |

---

## 12. 这一轮自检修掉的六个真 bug（2026-11-16）

六次都是「看起来正常、实际错了」，靠读中间量（computed style / 几何 / 真实载荷）才发现：

| # | 现象 | 根因 | 影响 |
| --- | --- | --- | --- |
| 1 | 滤镜滑杆拖了没反应 | `applyFilters()` 里有 `if (!media.style.transition) ...` 守卫，`media` 上残留过 transition 后滤镜就永不落地 | 亮度/对比度/饱和度/模糊四个滑杆全部失效 |
| 2 | 音轨开关开了还是没声 | `muted`/`volume` 只在 `createVideo()` 里设，而改设置不会重建 `<video>` | 壁纸音轨永远静音 |
| 3 | 多屏画面被压扁成一条 | `.wp-layer-frame` 与 `.wp-screen` 两条 CSS 规则**从来没写**，`position: static` 让高度由内容撑开，三块屏都变成 545px 高 | 三屏用户的壁纸全部变形（验收一直显示通过，因为它只数 cell 数量） |
| 4 | 图片壁纸只占左上角一小块 | `.wp-layer-media` 没有 `width/height: 100%`，`<img>` 按原始分辨率显示（640×360 的图实测只占 641×360） | 所有图片/GIF 壁纸都不铺满，`object-fit: cover` 等于没生效 |
| 5 | 导入素材报「宿主内部错误」 | `POST /library/import` 用 `body["copy"].GetValue<string>()` 读 JSON 布尔 | 通过 API 导入一律 500（设置页选文件走的另一条路，所以平时没暴露） |
| 6 | GIF 壁纸不会动（只有静态首帧） | `createImage()` 里 `layer.kind === 'image' ? mediaUrl : coverUrl` —— `gif` 落进了 else，取的是封面缩略图 | 所有 GIF 壁纸被当成静态图显示 |

另外 `fitMode`（cover/contain/fill/stretch）之前前端根本没读，`object-fit` 在 CSS 里写死 `cover` —— 现在四种都通了。

**验证方式**：`_tools/_wp_settings_check.mjs` 逐项「改前采样 → 改后采样 → 复原」，只有真的变了才算通过 → `failures=0 / total=12`；`_tools/_cdp_multi.mjs` + `_tools/_geo.mjs` 读每块屏的 `getBoundingClientRect` 与 `getComputedStyle` → 三块屏矩形 `1080x1920 / 2560x1440 / 3440x1440` 与各自分辨率完全一致。

**自己动手复验的命令**：

```powershell
# 设置项逐条改一遍，看有没有真的生效（需要程序带 CDP 端口启动）
$env:ZILUX2_WEBVIEW_ARGS='--remote-debugging-port=9333'
node _tools\_wp_settings_check.mjs 9333 <apiPort> <token>

# 多屏每块 cell 的几何（矩形 + position）
node _tools\_geo.mjs 9333
```
