# 「发现」页（Discover）——能力补全实现说明

> 目标：把网易云 / QQ 音乐登录后能拿到、但此前没做进软件的内容全部补齐，沿用现有浅色 UI 风格，
> 双平台（网易云 / QQ）在同一页面按来源融合展示，能力差异用占位/提示处理。
>
> 完成时间：2026-10-22。入口：左侧 rail 第 5 项「发现」（compass 图标，位于「推荐」之后）。

## 1. 界面结构

```
发现
├─ 顶部 tab：排行榜 · 歌单广场 · 私人漫游 · 播客 · 收藏
├─ 右上来源分段：全部 / 网易云 / QQ（漫游/播客/收藏只有网易云，QQ 段置灰并提示）
├─ 排行榜：网易云「云音乐特色榜」「全球媒体榜」+ QQ「巅峰榜 / 地区榜 / 特色榜 / 全球榜」（共 30 个）→ 点卡片进榜单详情
│   └─ 榜单详情：hero（封面/榜单名/曲目数/播放全部）+ 曲目行（100 首/页，加载更多翻页）
├─ 歌单广场：分类 chips（71 个）+ 最热/最新 + 卡片网格 → 点卡片复用原生歌单详情
├─ 私人漫游：每次换一批（上游一次 3 首）+ 播放全部
├─ 播客：推荐节目卡片 → 点击按节目名跳原生搜索（节目暂不支持直接播放）
└─ 收藏：歌手 / 专辑 / MV / 歌单 四类（我创建 + 我收藏）
```

页面内还有两类二级页（带「返回发现」面包屑与返回栈）：

- **歌手页**：圆形头像、简介（点击展开）、热门歌曲（默认 50 首）、专辑网格 → 点专辑进专辑页
- **专辑页**：封面、歌手（网易云可点进歌手页，QQ 无 artistId 不可点）、年份、曲目列表、播放全部
- **评论 Sheet**：曲目行右侧评论按钮 → 右侧抽屉，总评论数、热评标签、点赞数、分页加载更多（QQ 返回 501 时 toast 提示）

## 2. 双平台能力矩阵

| 能力 | 网易云 | QQ 音乐 |
| --- | --- | --- |
| 排行榜目录 / 榜单详情 | ✅ 64 个榜、分页 | ✅ 30 个榜（4 分组，含封面/曲目数/更新频率）、详情分页 |
| 歌单广场（分类 + 热度/最新） | ✅ 71 分类 | ✅ 分类只有「全部」，支持最热/最新 |
| 私人漫游 | ✅（一次 3 首） | ❌ |
| 播客推荐 | ✅ | ❌ |
| 歌手页 / 热门歌曲 / 专辑网格 | ✅ | ❌ |
| 专辑页 | ✅ | ✅（无 artistId，歌手名不加链接） |
| 评论 | ✅（热评 + 分页） | ❌ 501 |
| 我的收藏（歌手/专辑/MV/歌单） | ✅ | ❌ 501 |

## 3. 后端（C#）

新增 `src/Zilux2/Online/Discover/`：

- `DiscoverModels.cs`：全部响应模型 + `DiscoverJsonContext`（源生成 JSON）
- `DiscoverService.cs`：10 个方法，封装网易云 / QQ 上游解析（含歌曲解析、封面代理、分页）
- `LocalMusicServer.cs`：新增 10 条路由（`/api/discover/charts|chart|cats|playlists|radio|artist|album|comments|podcasts|collections`），
  复用现有 token 校验与 `{error,message}` 错误约定；QQ 不支持的能力返回 `501 {error:"unsupported"}`，
  未登录时相关接口返回 `401 {error:"login-required"}`。
- `OnlineMusicModels.cs`：`OnlineTrack` 增加可选 `artistId` / `albumId`（用于点歌手/专辑跳转）。

实现期修掉的三个上游坑：

1. 网易云榜单歌曲旧接口 `/api/playlist/track/all` 已下线（404）→ 改用 `/api/v2/playlist/detail?id=&n=&s=` 读 `playlist.tracks`。
2. 网易云专辑曲目在 `album.songs`（不在根 `songs`）。
3. QQ 歌单广场响应头声明 `charset=gb2312` 但 body 是 GB18030 → `OnlineHttp.FetchTextAsync` 会因非法 charset 抛错，
   改为取字节 + `GB18030` 解码；同时把 QQ 歌单封面 `imgurl` 转 https 并走 `/api/cover` 代理（避免 http 混合内容）。
4. QQ 榜单目录改走 musicu `musicToplist.ToplistInfoServer/GetAll`（4 分组 30 个榜，含 `frontPicUrl`/`totalNum`/`updateType`），不再用内置 9 榜；详情封面优先 `topinfo.pic_v12`/`picDetail`/`headPic_v12`；`total_song_num` 作为总曲目数。
5. QQ 的 `imgcache.qq.com/music/photo_new/...` 已返回 400，统一改写为 `y.gtimg.cn/music/photo_new/...` 再走封面代理。
   （`CodePagesEncodingProvider` 由 .NET 共享运行时提供，未引入新 NuGet 依赖。）

其他修正：QQ 专辑歌手/年份解析（`singername` / `aDate`）、播客节目字段（`program` 子对象）、
评论头像代理成回环地址、收藏支持歌单（`kind=playlist`）。

## 4. 前端（TypeScript）

- 新增 `web/src/online/discover.ts`（595 行）：10 个接口类型与 fetch 封装（token、超时、`OnlineError`、60s 缓存、封面补 token）
- 新增 `web/src/ui/discover.ts`（约 1020 行）：`DiscoverView`，5 个 tab + 来源分段 + 榜单详情/歌手页/专辑页/评论 Sheet
  + 加载态/空态/错误 toast；无封面时用 `gradientCover()` 生成渐变占位（缺图时兜底，正常情况网易云/QQ 榜单都有真封面）
- 修改 `web/src/ui/app.ts`：rail 增加「发现」；`showDiscover()` 接管 wallHost（懒创建 DiscoverView）、
  `runDiscoverSearch()` 复用原生搜索墙；播放复用 `playQueue`、歌单复用 `showPlaylist`、Sheet 复用 `openSheet`
- 修改 `web/src/ui/dom.ts`：新增 `compass` / `comment` 两个图标
- 修改 `web/src/styles/app.css`：末尾追加 `.disc-*` 样式（约 450 行），沿用现有主题令牌与动效

## 5. 已知限制

- 私人漫游上游一次只返回 3 首（接口上限），UI 支持「换一批」。
- QQ 榜单封面已接入（30 个榜全部有图）；仅当上游个别字段缺失时才退回渐变占位。
- QQ 不支持歌手页、评论、收藏；QQ 专辑的歌手名不可点击。
- 播客节目暂时不直接播放（需要另一套播放地址解析），点击按节目名搜索相关歌曲。
- 发现页曲目行不随播放器高亮当前曲（与现有搜索/歌单墙行为一致）。
- 评论里的部分 emoji 在 Windows 字体缺失时显示为方框（系统字体限制，非数据问题）。

## 6. 验证

- `tsc --noEmit` 0 error；`vite build` 通过（main 655 kB / gzip 230.5 kB）
- 真机 CDP QA（`research/qa/discover-app-qa.mjs`、`discover-app-qa2.mjs`）：5 tab、来源切换、榜单 100→200 翻页、
  歌手/专辑/评论/播放、QQ 榜单与歌单广场、收藏四类均可用；`console error = 0`、`exception = 0`
- 截图：`research/shots/app-disc-*.png`、`app-disc2-*.png`、`app-disc-final-*.png`

## 7. 入口速记

左侧导航「发现」→ 顶部 tab 切换板块；右上角「全部 / 网易云 / QQ」切来源；
榜单/歌单/专辑卡片点进详情；曲目行右侧图标分别是「播放」「评论」。

## 2026-10-22 追加：QQ 榜单全目录 + 真封面

用户问「QQ 音乐那些排行榜封面获取不到吗」→ 实测可以拿到，已补齐：

- **目录**：`musicu.fcg` 的 `musicToplist.ToplistInfoServer/GetAll` 返回 4 组 30 个榜：
  巅峰榜 6（飙升/热歌/新歌/流行指数/听歌识曲/MV）、地区榜 9（内地/香港/台湾/欧美/韩国/日本/JOOX/香港TVB/台湾KKBOX）、
  特色榜 11（说唱/电音/游戏/影视/古风…）、全球榜 4（Billboard/Melon/UK 等）。
  每个榜带 `frontPicUrl`（300×300 封面）、`totalNum`（曲目数）、`updateType`（日/周更）。
- **详情**：`fcg_v8_toplist_cp.fcg?topid=&page=detail&song_begin=&song_num=`，封面取 `topinfo.pic_v12`/`picDetail`/`headPic_v12`，
  总曲目数取根节点 `total_song_num`（热歌榜 300 首），翻页 `hasMore` 按 offset 计算。
- **封面代理**：统一转 https 后走 `/api/cover?source=qq&key=<url>`；`imgcache.qq.com/music/photo_new/...` 上游 400，
  自动改写成 `y.gtimg.cn/music/photo_new/...`（同一资源可用）。
- 前端无需改动（`coverBox` 走渐变兜底，现在拿到真 URL 就直接显示）。

截图：`research/shots/app-qq-charts-final.png`（30 个榜带封面）、`app-qq-chart-detail-final.png`（巅峰榜·热歌 hero 封面 + 300 首）。

## 2026-10-22 追加：QQ 评论接入

此前 QQ 评论返回 501，实测**可以拿到**，已接入：

- **接口**：`https://c.y.qq.com/base/fcgi-bin/fcg_global_comment_h5.fcg`
  （`cid=205360772&reqtype=2&biztype=1&cmd=8&pagenum=&pagesize=&uin=&g_tk=5381`，带登录 cookie）。
  关键点：`topid` 必须是**数字歌曲 id**，不是 songmid —— 所以先走 musicu
  `music.pf_song_detail_svr/get_song_detail_yqq`（`song_mid`）换到 `track_info.id`。
- **字段**：`nick` / `avatarurl` / `rootcommentcontent`（或 `content`）/ `praisenum` / `time`（秒）/ `is_hot_cmt`；
  首屏先热评（最多一页）再拼普通评论；`commenttotal` 作为总数（晴天 230665 条）。
- **清理**：QQ 评论里的表情占位 `[em]e400851[/em]` 会剔除，`[图片]` 显示成「（图片）」。
- **头像**：`pic6.y.qq.com` / `wx.qlogo.cn` / `thirdqq.qlogo.cn` 都通过 `/api/cover?source=qq` 代理
  （封面白名单追加 `*.qlogo.cn`）。
- 前端去掉「QQ 暂不支持评论」的拦截，评论 Sheet 按曲目来源请求。

截图：`research/shots/app-qq-comments.png`（QQ 热评 + 头像 + 点赞数）。

## 2026-10-22 追加：QQ 歌手页 + 双端「歌曲信息」

### QQ 歌手页（之前 501，现在可用）
QQ 官方歌手接口全部下线（musicu `music.musichallSinger.*` 返回 104400、`fcg_v8_singer_info/track/album` 404），
改为抓 `https://y.qq.com/n/ryqq/singer/{singerMid}` 页面 SSR 里内联的 `window.__INITIAL_DATA__`：

- `singerDetail.basic_info`（名字）、`singerDetail.pic.pic`（头像，`y.gtimg.cn` 300×300）、`shortdesc` / `ex_info.desc`（简介）；
- `songList`：热门前 10 首（字段是 `mid` / `name` / `singer[]` / `album{mid,name,time_public}` / `interval` / `pay`）；
- `albumList`：5 张专辑（`mid` / `name` / `release_time` → 年份）。

实现要点：花括号扫描取 JSON（内联的是 JS 字面量，含 `title_hilight: undefined`，解析前替换成 `null`）；
`src/Zilux2/Online/Discover/DiscoverService.cs` 的 `GetQqArtistAsync`。QQ 曲目现在都带 `artistId/albumId`，
列表里的歌手名 / 专辑名可直接点进对应页面（两端一致）。

### 歌曲信息（两端）
新增 `GET /api/discover/song?source=&id=`：

- 网易云：`/api/v3/song/detail?ids=[id]&c=[{"id":id}]`（v3 必须带 `c`，否则 400）；发行时间 v3 不返回，回查 `/api/album/{albumId}` 的 `publishTime` 补上。
- QQ：musicu `music.pf_song_detail_svr/get_song_detail_yqq` 的 `track_info`；额外带 `file.size_*` → 音质体积（无损 FLAC / 320k / 128k / AAC）。
- 返回：标题 / 歌手列表（带 id）/ 专辑（带 id）/ 封面 / 时长 / 发行日期 / VIP / 曲目号 / 音质体积 / 歌曲 ID / 官方链接。

前端：`web/src/ui/songInfo.ts`（Sheet 内容，歌手 / 专辑可点则变成链接、网易云有回调时跳发现页），
入口在「发现」曲目行与所有墙面（最近播放 / 我喜欢的音乐 / 搜索 / 歌单 / 日推）的曲目行新增的 ⓘ 按钮；
样式 `.sinfo*` 追加在 `app.css`。截图：`research/shots/app-songinfo-9-qq-artist-final.png`、`app-songinfo-10-qq-song-sheet-final.png`。

已知限制：网易云无音质体积（上游不提供）；QQ 多歌手曲目只把第一位歌手当可跳转目标（其余按名字展示）。

## 2026-10-22 追加：歌曲信息两种形态（整页详情 / 列表内展开）

用户要求「不要侧边抽屉，改成封面放大 + 名字位移 + 歌手/歌曲信息下拉」，并可选择形态。现两种都实现，**设置 → 外观 → 歌曲信息样式** 切换（localStorage `zilux2.songInfoView`，默认「整页详情」）。

- **整页详情**（page）：在内容区铺一层 `.sd-layer`，188px 大封面 + 标题/歌手/专辑+发行日期（封面 scale-in、标题位移入场），下方三个可折叠组：歌手信息（每位歌手可跳转歌手页）、歌曲信息（来源/时长/发行日期/曲目/歌曲 ID/官方链接）、音质（QQ 才有）。左上「返回」回上一页；点歌手/专辑链接会跳到对应页面。
- **列表内展开**（inline）：点曲目行 ⓘ 在行下插入 `.si-panel`（`grid-template-rows: 0fr → 1fr` 展开动画），130px 封面 + 同一套折叠组 + 右上角收起按钮；再点同一行 ⓘ 收起，点另一行会替换旧面板。
- 入口：发现页/榜单/歌手页/专辑页的曲目行 ⓘ；最近播放、搜索结果、歌单等墙面行在「横条列表」布局下的 ⓘ。
- 文件：`web/src/ui/songInfo.ts`（两形态渲染 + 导出 `openSongInfo` / `songInfoView` / `setSongInfoView`）、`web/src/ui/discover.ts`、`web/src/ui/app.ts`（设置项 + 墙面入口）、`web/src/styles/app.css`（`.sd-*` / `.si-*`）。
- 截图：`research/shots/app-songview-1-page.png`（整页详情）、`app-songview-2-inline.png`（列表内展开）、`app-songview-3-discover-page.png`（发现页整页详情）、`app-songview-4-artist-nav.png`（歌手跳转）。
### 布局补丁（2026-10-22 晚）
用户反馈「单页展开右侧好空荡」。改为：
- 头部右侧增加速览 chips（来源 / 时长 / 发行日期），整页 hero 与列表内展开头部都显示；
- 折叠组改为双列网格：左列「歌手信息 + 音质」，右列「歌曲信息」（`grid-template-areas: 'artists meta' 'quality meta'`），窄窗口（≤980px）回退单列；
- 截图：`research/shots/app-songview-6-inline-wide.png`（列表内展开）、`app-songview-7-page-mode.png`（整页详情）。

