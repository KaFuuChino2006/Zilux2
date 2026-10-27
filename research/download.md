# 统一下载功能（网易云 / QQ / 酷狗 / 无名音乐）

## 用户视角

- 横条列表（搜索、歌单、榜单、最近播放、我喜欢的音乐…）每一行右侧都有「⤓ 下载」按钮；发现页的榜单 / 歌单 / 歌手 / 专辑曲目行同样有。
- 下载默认保存到 **Windows 音乐目录**（`%USERPROFILE%\Music`），可在「设置 → 下载」里：
  - 查看当前目录（默认时显示「系统音乐目录（默认）」）
  - 「更改」选择任意文件夹
  - 「打开」在资源管理器打开
  - 「恢复默认」
- 下载完成的文件会**立即出现在左侧「本地曲库」**，无需重启或手动导入，并可直接播放、看歌曲信息。
- 实验来源「无名音乐」的自动缓存目录也跟随这个下载目录（`<下载目录>/mvmp3-cache`）。

## 实现

- 后端 `src/Zilux2/Online/DownloadService.cs`：统一下载器。对任意 `IOnlineMusicProvider` 调 `ResolveStreamAsync` 拿到真实音频地址与所需请求头，下载到 `.part` 再原子改名；文件名 `歌手 - 歌名.ext`（按实际格式给 mp3/flac/m4a/wav/ogg），清洗非法字符、截断 120 字；最小 32KB；最多保留 40 个任务记录（UI 显示最近 30 条）。
- `src/Zilux2/Online/LocalMusicServer.cs`：
  - `POST /api/download?token=` body `{source,trackId,title,artist}` → `{directory,job}`
  - `GET  /api/downloads?token=` → `{directory,jobs}`
  - `POST /api/download/reveal?token=` body `{jobId}` → 在资源管理器中选中文件
- 设置模型 `src/Zilux2/Settings/SettingsModel.cs` 新增 `downloads.directory`（空 = 系统音乐目录）。
- 本地曲库 `src/Zilux2/Local/LocalMusicService.cs`：扫描「用户文件夹 + 下载目录」并合并（按绝对路径去重），下载目录文件通过虚拟主机 `https://localmusic.local/__dl/…` 提供（支持 Range）；下载完成时用 `NotifyFileAdded` 即时刷新曲库。
- 前端：`web/src/online/download.ts`（`startDownload / fetchDownloads / revealDownload`）、`web/src/ui/app.ts`（行内按钮 + 下载轮询 toast + 设置页「下载」区）、`web/src/styles/app.css`（`.track-download`，`.track-row` 由 7 列扩为 8 列）。

## 已验证

- 网易云《晴天(深情版)》→ `C:\Users\13329\Music\Lucky小爱 - 晴天(深情版).mp3`（11.16MB），本地曲库即时出现。
- QQ《晴天》（songmid `0039MnYb0qxYhV`）→ `C:\Users\13329\Music\周杰伦 - 晴天.mp3`（10.79MB）。
- 无名音乐：只对「当前可播」的曲目能下（失效 hash 上游 403/502，属站点数据问题，失败会在 toast 里说明原因）。
- 本地曲库合并去重：同一文件不会重复出现。

## 已知限制

- 会员 / 版权受限、或上游解析不出播放地址的曲目会下载失败，并在 toast + 日志里给出原因（不会留下残缺文件）。
- 下载目录是全局设置（所有平台共用一个目录）。
- 无名音乐（实验来源）不参与收藏 / 歌单，下载的文件只进「本地曲库」。

## 排错

- 引擎日志：`%LOCALAPPDATA%\Zilux2\logs\host.log`，搜 `[download]`。
- 排查顺序：`/api/downloads` 看 `state / error` → host.log 里对应 source 的 `ResolveStreamAsync` 是否拿到 url。

## 2.6.9 · 下载 / 缓存在「本地曲库」可见 + 手动刷新

**问题（反馈）**：在「本地曲库」里看不到已下载和已缓存的歌，也没有刷新入口。

**原因**
1. mvmp3 的缓存目录默认落在 `%LOCALAPPDATA%\Zilux2\mvmp3-cache`，不在「下载目录」（默认 Windows 音乐目录）之下，所以不参与本地曲库扫描。
2. 缓存文件名是 mvmp3 的 32 位 hash，没有歌名/歌手元数据；旧缓存迁移过来后只能显示 hash。
3. 本地曲库没有手动刷新按钮，只有切页/重开才会重新扫描。

**改动**
- `src/Zilux2/App.xaml.cs`：把 `Mvmp3Cache.DirectoryProvider` 接到「下载目录」（空则系统音乐目录），并在启动时调用 `Mvmp3Cache.MigrateLegacy()` 把旧缓存挪进新目录。
- `src/Zilux2/Online/Mvmp3Cache.cs`：`Dir` 在未配置时回退到系统音乐目录；新增 `WriteMeta/ReadMetaForFile`：歌曲开始播放时通过 `GET /api/stream?...&title=&artist=` 把 `歌手 - 歌名` 写入同目录 `<hash>.json`，缓存落盘后重命名为可读文件名，旧文件在下次刷新时自动改名。
- `src/Zilux2/Local/LocalMusicService.cs`：新增 `rescan` 动作（重新扫描下载目录并推送合并结果），合并时读取缓存元数据命名。
- Web：`web/src/core/bridge.ts` 增加 `rescanLocalMusic()`；`web/src/ui/app.ts` 本地曲库标题栏增加「刷新」按钮。

**验证（真机 2.6.9）**
- 启动日志：`[mvmp3] migrated legacy cache to C:\Users\13329\Music\mvmp3-cache`，旧目录已移除。
- 本地曲库：`Music · 本地 · 12 首`，含 3 首已缓存的歌；点「刷新」后 host.log 出现 `[local] download folder C:\Users\13329\Music (12 tracks)`。
- 新缓存的歌会以「歌手 - 歌名.ext」出现在本地曲库。

## 2.6.10 · 本地曲库管理（删除 / 在文件夹中显示 / 打开文件夹）

反馈「本地曲库缺少删除之类的功能」。

- 后端 `LocalMusicService` 新增动作 `delete`（rels[]）/ `reveal`（rel）/ `openFolder`：`SHFileOperationW` 把文件连同同名 `.lrc`/`.json` 元数据一起移入回收站（可还原）；路径严格限制在本地根目录/下载目录内。
- 前端：本地曲库行尾按钮换成「在文件夹中显示」「删除到回收站」，网格视图海报右上角悬停出现同款按钮；删除前 `window.confirm` 二次确认并 toast 结果；标题栏新增「打开文件夹」。
- 本地曲库变化（下载完成/删除/刷新/扫描完成）现在会重建曲目列表再渲染，不再残留旧条目。

## 2.6.11 · 统一应用内确认弹窗

- 问题：删除确认用的是浏览器原生 `window.confirm`（窗口标题 `zilux2.local 显示`、蓝色「确定/取消」按钮），与应用的奶油玻璃风格完全不一致。
- 改动：新增 `web/src/ui/confirmDialog.ts`（`confirmDialog({title,message,detail,confirmText,cancelText,tone,iconName})`，Promise<boolean>，支持 ESC/Enter/点遮罩关闭，危险操作用红色主按钮 + 图标底色）；`web/src/ui/app.ts` 三处原生确认全部替换：本地曲库删除、实验来源开启、清空实验来源缓存；`web/src/styles/app.css` 追加 `.ui-confirm-*` 样式（模糊遮罩 + 居中卡片 + 入场动画）。
- 验证：本地曲库删除弹窗标题「移到回收站」、正文与详情说明、按钮「取消 / 移到回收站」；取消与 ESC 均不删除，确认后 10 → 9 首并 toast「已移到回收站」；清空缓存弹窗同样为应用内样式。
- 安装包：`dist/Zilux2-Setup-2.6.11.exe`（13,024,961 B，SHA256 `27258c2a7a46ca2e6925e14693757fbd427949f3e523d50c8c6b08ae6d66af55`），已静默安装到 `%LOCALAPPDATA%\Programs\Zilux2` 并验证。

## 2.6.12 · 本地标签歌手识别 + 下载音质选择

- 本地歌手缺失修复：新增 `src/Zilux2/Local/LocalTagReader.cs`（MP3 ID3v2/ID3v1、FLAC VorbisComment、M4A/MP4 ilst、OGG/Opus、WAV LIST INFO；mtime+size 缓存，失败只记日志）。`LocalMusicService` 扫描音频与 `RescanDownloads` 时写 `Title/Artist/Album`，标签缺失时回退「歌手 - 歌名」文件名拆分 → 本地曲库不再整列显示「未知歌手」（如 霽れを待つ — Orangestar、新宝島 — サカナクション）。
- 下载音质：provider 接口本就支持 `quality: standard | high | lossless`（平台不支持时自动降级），本次接到下载链路：
  - 设置 `downloads.quality`（默认 high），设置→下载 增加「下载音质」三档（无损/高品质/标准）。
  - `DownloadService` 透传 quality 到 `ResolveStreamAsync`，任务记录 `quality` 字段，host.log 输出 `quality=…`。
  - 实测：QQ 晴天 无损 → `周杰伦 - 晴天.flac`（55,397,039B，host.log `[download] file ready`）；网易云 宝船 标准 → `DOUDOU 燕云十六声 - 宝船.mp3`；QQ 的会员曲目在标准档返回「该歌曲需要 QQ 音乐会员或已下架」（上游限制，与音质无关）。
- 安装包：`dist/Zilux2-Setup-2.6.12.exe`（13,027,009 B，SHA256 `f2e25e6ebfa7a5573289e4472c0ed21f6a68cf224502e9eecc95afd85276a08c`），已静默安装到 `%LOCALAPPDATA%\Programs\Zilux2` 并验证。

## 2.6.13–2.6.15 · 本地歌手头像 + 艺术家页面

- 艺术家页面（纯前端）：`web/src/ui/localArtists.ts` 按 `track.artist` 聚合本地曲库（`localArtists(): {name, tracks, cover}[]`）；本地墙新增「歌曲 / 歌手」切换（`.seg.local-modes`），歌手卡点进详情（大头像 + 名字 + 「N 首歌曲 · 来自本地曲库」+ 播放全部 + 返回）；播放条歌手名与歌曲行歌手名可点，直接进对应本地歌手页（`openLocalArtist`）。
- 头像来源（三级兜底）：① 歌曲内嵌封面（`LocalCover`，2.6.13 起支持 m4a/mp4 的 `moov.udta.meta.ilst`，`@downloads/` 前缀也能取）→ ② 在线网易云歌手图（新接口 `GET /api/artist/image?name=`，宿主 `DiscoverService.GetNeteaseArtistImageAsync` 用 `https://music.163.com/api/cloudsearch/pc?type=100` 搜歌手取 `picUrl` 并由宿主代理，6 小时内存缓存，「未知歌手」不走在线兜底）→ ③ 首字母渐变占位。
- 宿主改动：`LocalMusicService` 扫描 + `RescanDownloads` 写 `Title/Artist`（`LocalTagReader`）；`LocalCover` 补 m4a/mp4 封面解析与 `@downloads/` 支持；`DiscoverService` 新增歌手图接口（`cloudsearch` 参数，避开旧 `search/get/web` 的 405 风控）；`LocalMusicServer` 新增 `/api/artist/image` 路由。
- 验证（安装版 2.6.15）：本地歌手 8 位、7 位显示真实头像（周杰伦/Orangestar/サカナクション 等），1 位无标签且名称为「未知歌手」→ 首字母占位；进入「周杰伦」详情显示 3 首（晴天 ×2、花海）。截图 `research/shots/app-2.6.15-artists-final.png`、`app-2.6.15-artist-detail.png`。
- 安装包：`dist/Zilux2-Setup-2.6.15.exe`（13,032,129 B，SHA256 `39347fab9a7fe69e584050058bcfd3bd8a42c75801e9d696d9e41545fa36206d`），已静默安装到 `%LOCALAPPDATA%\Programs\Zilux2`。
