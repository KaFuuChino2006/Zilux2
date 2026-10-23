# 发现（Discover）API 契约 v1

> 目标：把网易云 / QQ 音乐「登录后能拿到、但还没做进软件」的内容补全。全部是回环 HTTP 接口，与现有 `/api/*` 同一端口与 token，`GET`，必须带 `?token=`。
> 错误响应沿用现有约定：HTTP 4xx/5xx + `{ "error": "<code>", "message": "<中文可读>" }`。

## 通用约定

- `source`：`netease` | `qq`（`kugou` 暂不参与发现页）。
- 曲目对象 `Track` 与现有 `OnlineTrack` 完全一致：
  ```json
  { "source": "netease", "id": "1901371647", "title": "晴天", "artist": "周杰伦",
    "album": "叶惠美", "durationMs": 269000, "cover": "http://127.0.0.1:<port>/api/cover?token=...",
    "playable": true, "vip": false,
    "artistId": "6452", "albumId": "32311" }
  ```
  `artistId` / `albumId` 为新增可选字段（用于点歌手名/专辑名跳转），缺失时前端不显示跳转。
- 歌单卡片 `PlaylistCard` 与现有 `LibraryPlaylist` 一致：`{ source, id, title, cover?, count, creator? }`。
- 需要登录的接口在未登录时返回 `401 { "error": "login-required", "message": "登录…后才能查看" }`。

## 接口

### 1. 排行榜目录 `GET /api/discover/charts[?source=]`

不传 `source` 时返回两个平台合并的分组。

```json
{ "groups": [
  { "source": "netease", "label": "网易云音乐", "categories": [
    { "title": "特色榜", "charts": [ { "id": "19723756", "title": "飙升榜", "cover": "...", "count": 100, "updateFrequency": "每天更新" } ] }
  ] },
  { "source": "qq", "label": "QQ 音乐", "categories": [ { "title": "排行榜", "charts": [ ... ] } ] }
] }
```

### 2. 榜单详情 `GET /api/discover/chart?source=&id=&offset=0&limit=100`

```json
{ "source": "netease", "id": "19723756", "title": "飙升榜", "cover": "...", "count": 100,
  "tracks": [ Track ], "hasMore": false }
```

### 3. 歌单分类 `GET /api/discover/cats?source=`

```json
{ "source": "netease", "categories": [ { "id": "全部", "name": "全部" }, { "id": "华语", "name": "华语" } ] }
```

### 4. 歌单广场 `GET /api/discover/playlists?source=&cat=全部&order=hot&offset=0&limit=30`

```json
{ "source": "netease", "cat": "全部", "playlists": [ PlaylistCard ], "hasMore": true }
```

`order`：`hot` | `new`（QQ 侧可忽略）。

### 5. 私人漫游 `GET /api/discover/radio?source=netease&count=12`

```json
{ "source": "netease", "tracks": [ Track ] }
```

### 6. 歌手页 `GET /api/discover/artist?source=netease&id=&limit=50`

```json
{ "source": "netease", "id": "6452", "name": "周杰伦", "cover": "...", "avatar": "...",
  "description": "…", "followed": false,
  "hotSongs": [ Track ],
  "albums": [ { "id": "32311", "title": "叶惠美", "cover": "...", "year": 2003, "count": 11 } ] }
```

### 7. 专辑页 `GET /api/discover/album?source=&id=`

```json
{ "source": "netease", "id": "32311", "title": "叶惠美", "cover": "...", "artist": "周杰伦",
  "artistId": "6452", "year": 2003, "description": "…", "tracks": [ Track ] }
```

QQ 的专辑 id 用 `albummid`（前端从 `Track.albumId` 拿）。

### 8. 评论 `GET /api/discover/comments?source=netease&id=<trackId>&offset=0&limit=30`

```json
{ "source": "netease", "id": "1901371647", "total": 311876,
  "comments": [ { "user": "香风智乃耶", "avatar": "...", "content": "…", "liked": 1234, "time": "2024-05-01", "hot": true } ],
  "hasMore": true }
```

QQ 暂返回 501 `{ "error": "unsupported", "message": "QQ 评论暂未接入" }`。

### 9. 播客推荐 `GET /api/discover/podcasts?source=netease&limit=12`

```json
{ "source": "netease", "programs": [
  { "id": "1367665103", "name": "…", "cover": "...", "radioName": "…", "djName": "…",
    "durationMs": 2400000, "description": "…" }
] }
```

播客暂不做播放（需要另一套播放地址解析），前端点击用节目名去搜索。

### 10. 我的收藏 `GET /api/discover/collections?source=netease&kind=artist|album|mv&offset=0&limit=50`

```json
{ "source": "netease", "kind": "artist", "hasMore": false,
  "items": [ { "id": "6452", "title": "周杰伦", "cover": "...", "subtitle": "歌手" } ] }
```

QQ 侧：`kind=playlist` 返回收藏歌单卡片（`PlaylistCard`）。

## 探测依据（2026-10-22 实测，详见 research/online-capabilities.md）

- 网易云可用：`/api/toplist`、`/api/v6/playlist/detail`、`/api/playlist/catalogue`、`/api/playlist/list`、`/api/v1/radio/get`、`/api/v1/artist/{id}`、`/api/artist/top/song`、`/api/artist/albums/{id}`、`/api/album/{id}`、`/api/v1/resource/comments/R_SO_4_{id}`、`/api/personalized/djprogram`、`/api/artist/sublist`、`/api/album/sublist`、`/api/mv/sublist`。
- QQ 可用：`musicu.fcg`（歌单/收藏歌单/我喜欢/搜索/歌曲详情）、`c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg?topid=`（榜单歌曲）、`c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg`（歌单广场）、`c.y.qq.com/v8/fcg-bin/fcg_v8_album_info_cp.fcg?albummid=`（专辑）。
- QQ 排行榜目录用内置 topid 表（26 热歌榜 / 4 新歌榜 / 62 飙升榜 / 27 经典老歌 / 5 内地 / 6 港台 / 3 欧美 / 16 韩国 / 17 日语），请求时逐个取榜单详情。
- QQ 歌手页 / 评论 / 播客暂不实现。

## 实测补充（2026-10-22 第二轮，接口已按此实现并 curl 验证）

- **QQ 榜单卡片没有封面和曲目数**：`charts?source=qq` 的 `cover` 为 `""`、`count` 为 `0`（旧 cgi 不提供），前端必须用占位封面；网易云榜单 `cover/count/updateFrequency` 齐全。
- **QQ 歌单广场中文是 GBK**：`fcg_get_diss_by_tag.fcg` 的 body 是 GB18030 编码（Content-Type 声明 `gb2312`），后端已按 GB18030 解码；歌单封面 `imgurl` 是 `http://qpic.y.qq.com/...`，后端已改成 https 并走 `/api/cover` 代理（白名单包含 qq.com/qpic.cn 等）。
- **QQ 专辑**：`title/artist/year` 有值；`artistId` 为空（QQ 歌手页不支持），前端不要把 QQ 歌手名做成链接。
- **评论头像**：网易云返回的头像是外链 http 地址，后端已统一代理成 `127.0.0.1:<port>/api/cover?...`，前端可直接当 img src。
- **评论分页**：`offset=0` 时返回热评在前（可能 ≥ limit），`offset>0` 返回普通评论；`hasMore` 可用。
- **收藏 kind**：网易云支持 `artist|album|mv|playlist`（playlist = 我创建 + 我收藏的歌单，`PlaylistCard` 风格）；QQ 全部 501。
- **播客**：`/api/personalized/djprogram` 的节目字段嵌在 `program` 下，现已正确返回 `cover/radioName/djName/durationMs/description`（节目时长可达 40 分钟以上）。
- **私人漫游/播客/收藏**需要网易云登录；未登录时相关接口 401 `login-required`。
- **榜单分页**：网易云榜单歌曲用 `/api/v2/playlist/detail?id=&n=&s=`（`/api/playlist/track/all` 已下线 404）；`offset/limit` 即 `s/n`。
- 网易云专辑曲目在 `album.songs`（不是根 `songs`）；歌曲时长/歌手/封面貌全部走 `OnlineTrack` 既有字段，另带 `artistId/albumId`。
