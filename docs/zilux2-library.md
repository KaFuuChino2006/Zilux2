# Zilux2 个人音乐库契约（Library v1）

> 状态：v1 草案（2026-10-18）· 依赖：`docs/zilux2-account-login.md`（扫码登录，未登录时本库为空）
> 目标：打开应用第一屏直接看到「我自己的音乐」——网易云 / QQ 音乐各自的**我喜欢**与**自建歌单**，点开可看歌单曲目并播放。

## 1. 宿主新增 HTTP 路由（需 `?token=`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/library/overview` | 两源汇总：登录态 + 我喜欢 + 歌单列表（每源最多 60 个） |
| GET | `/api/library/playlist?source=&id=&offset=0&limit=200` | 歌单详情（曲目分页；`id=liked` 表示我喜欢） |
| GET | `/api/library/refresh?source=` | 使该源缓存失效并重新拉取（前端下拉/重试时用） |

未登录或未实现的源返回 `{"source":"netease","loggedIn":false,"playlists":[],"liked":null}`，不报错。

## 2. 数据模型

```ts
type MusicSource = 'netease' | 'qq';

interface LibraryPlaylist {
  source: MusicSource;
  id: string;              // 平台歌单 id（netease 数字 id / QQ disstid）
  title: string;
  cover?: string;          // 走 /api/cover 代理的 URL，可空
  count: number;           // 曲目数
  special?: 'liked' | null;// 我喜欢标为 'liked'
  creator?: string;
}

interface LibraryOverview {
  sources: Array<{
    source: MusicSource;
    loggedIn: boolean;
    nickname?: string;
    avatarDataUrl?: string;
    liked: LibraryPlaylist | null;
    playlists: LibraryPlaylist[];   // 排除「我喜欢」，最多 60
    error?: string;                 // 单源失败时的可读提示，不影响另一源
  }>;
}

interface PlaylistDetail {
  source: MusicSource;
  id: string;
  title: string;
  cover?: string;
  count: number;
  tracks: OnlineTrack[];   // 复用在线音乐统一模型
  hasMore: boolean;
}
```

`OnlineTrack` 沿用 `docs/zilux2-online-music.md`：`{source,id,title,artist,album,durationMs,cover,playable}`。

## 3. 缓存

- 宿主内存缓存：overview 与 playlist 各 5 分钟；`/api/library/refresh` 或登录/退出后立即失效。
- 封面统一走 `/api/cover` 代理（宿主已有缓存），不直接暴露平台图片域名。
- 单源失败只影响该源（`error` 字段），不阻断另一源与首页渲染。

## 4. 可播标记（playable）

- 网易云：`fee∈{0,8}` → true；`fee=1` 且已登录 → true（播放时再校验，失败由前端 toast）；未登录 → false；`status<0` 或版权下架 → false。
- QQ 音乐：`pay_play=0` → true；`pay_play>0` 且已登录 → true（同样播放时校验）；未登录 → false。
- 歌单详情里每首曲目都要带 `playable`，前端仅据此展示为可点/灰色。

## 5. 网易云实现要点

1. `GET /api/user/playlist?uid=<userId>&limit=1000&offset=0`（带登录 Cookie）→ `playlist[]`，其中 `specialType=5` 的是「我喜欢的音乐」（其 `id` 作为 liked 歌单 id）；
2. `GET /api/playlist/detail?id=<id>` → 歌单元数据 + `trackIds`；
3. 曲目详情 `GET /api/song/detail?ids=[...]`（分批 ≤500）→ 名称/歌手/专辑/时长/封面；
4. 我喜欢曲目：`/api/playlist/detail?id=<likedId>` 取 trackIds，再 song/detail 补全；
5. 封面：`album.picUrl` 走 `/api/cover?source=netease&key=<hash>`。

## 6. QQ 音乐实现要点

1. 用户歌单：`musicu.fcg` 的 `music.musicasset.PlaylistBaseRead / GetPlaylistByUin`（`uin` 登录态）；返回自建歌单与「我喜欢」目录；
2. 我喜欢：`music.musicasset.SongFavRead / GetSongFav`（`uin`、`offset`、`limit`）取歌曲 mid 列表；
3. 歌单详情：`music.srfDissInfo.DissInfo / CgiGetDiss`（`disstid`、`dirid=0`、`song_begin`、`song_num`）；
4. 曲目 mid → 名称/歌手/专辑/时长/封面 mid；可播性用 vkey（登录 Cookie）；
5. 所有请求带登录 Cookie；失效时返回未登录态。

## 7. 前端（首页第一屏）

- 启动进入首页后，**第一屏为主区块「我的音乐」**：
  - 顶部问候 + 两平台账号状态（昵称/未登录）；
  - 分组「网易云音乐」「QQ 音乐」：每组第一张为「我喜欢的音乐」大卡（特殊样式），后面是自建歌单卡片网格/横滑；
  - 卡片显示封面、标题、曲目数、平台徽标；封面缺失用程序化渐变兜底。
- 点击歌单卡片 → 打开歌单详情视图（全屏/抽屉均可，需有返回）：封面 + 标题 + 曲目数 + 「播放全部」+ 曲目列表；点击曲目调用 `player.playOnline(track, queue)`；VIP/不可播曲目灰显并 toast。
- 未登录：主区块显示登录引导（说明 + 「去设置 → 账号」按钮），下方可保留原「本周精选/继续聆听/为你推荐」演示区。
- 加载态：骨架屏；失败：单源错误文案 + 重试；空库：提示「还没有歌单，去平台上创建吧」。
- 原有 3D 封面环 Hero 区下移为「发现」区（登录后主区块优先展示个人库）。

## 8. 人工验收清单

1. 网易云扫码登录后打开首页：第一屏出现「我喜欢的音乐」+ 自建歌单，封面/标题/曲目数正确；
2. QQ 音乐登录后同样出现其我喜欢与歌单；
3. 点开歌单 → 曲目列表正确，点「播放全部」开始播放，切歌正常；
4. VIP 曲目：账号有会员时可播、无会员时灰显或播放失败 toast；
5. 退出登录后首页回到登录引导态；
6. 单平台未登录/接口失败时，另一平台仍正常显示。

## 9. 非目标

- 收藏/取消收藏、创建/编辑歌单、歌单排序；
- 云盘、电台、播客、每日推荐、听歌排行；
- 分页无限滚动（先 offset/limit 手动"加载更多"）。
