# Zilux2 全链路原生接口覆盖（2026-11-06）

目标：把网易云音乐 / QQ 音乐从「网页接口为主」迁到「客户端原生接口优先」，
网页接口只保留登录、验证码、DRM 等原生链路拿不到的部分。

本文记录当前实现状态、每条能力对应的原生端点与兜底路径，以及仍然存在的边界。
所有探针均为匿名实测（`research/probe-full-link*.cjs`），未带账号 cookie。

## 约定

- **原生**：请求直接打到客户端 API（网易 `interface.music.163.com/eapi/*`，QQ
  `u6.y.qq.com/cgi-bin/musics.fcg` / `u.y.qq.com/cgi-bin/musicu.fcg`）。
- **原生优先**：先走原生，超时 / 失败 / 熔断 / 登录态不足时回退 web，接口形状保持一致。
- **web**：仍走 `music.163.com` / `c.y.qq.com` 的网页接口。
- 保护：单次原生 5 s 超时；同 provider 连续 2 次失败熔断 60 s；
  日志不含 token / cookie / 完整 URL（`NativeFirstPolicy`）。

## 网易云

| 能力 | 状态 | 原生端点 | 兜底 |
| --- | --- | --- | --- |
| 搜索 | 原生 | eapi `/api/search/get` | web `/api/search/get` |
| 搜索热词 | 原生 | eapi `/api/search/defaultkeyword/get` | — |
| 歌曲详情 | 原生 | eapi `/api/v3/song/detail`（`c=[{id}]`） | web 同路径 |
| 播放地址 | 原生 | eapi `/api/song/enhance/player/url/v1` | web `/api/song/enhance/player/url` |
| 歌词（lrc/tlyric/yrc） | 原生 | eapi `/api/song/lyric/v1` | web `/api/song/lyric` |
| 歌单详情 | 原生 | eapi `/api/v6/playlist/detail` + `/api/v6/playlist/track/all` | web `/api/v6/playlist/detail` |
| 榜单目录 | 原生 | eapi `/api/toplist` | web `/api/toplist` |
| 榜单详情 | 原生优先 | eapi `/api/v6/playlist/detail`（榜单即歌单） | web `/api/playlist/detail` |
| 热门歌单 | 原生 | eapi `/api/top/playlist` | web 同路径 |
| 推荐新歌 | 原生 | eapi `/api/personalized/newsong` | web 同路径 |
| 推荐歌单 | 原生 | eapi `/api/personalized/playlist` | web 同路径 |
| 歌手页 | 原生 | eapi `/api/v1/artist/{id}` + `/api/artist/albums/{id}`（limit/offset 放 body） | web 同路径 |
| 专辑页 | 原生 | eapi `/api/v1/album/{id}`（album + songs 一次返回） | web `/api/album/{id}` |
| 歌曲评论 | 原生 | eapi `/api/v1/resource/comments/R_SO_4_{id}`（limit/offset 放 body） | web 同路径 |
| 播客推荐 | 原生 | eapi `/api/personalized/djprogram` | web 同路径 |
| 私人漫游 | 原生 | eapi `/api/v1/radio/get` | web `/api/v1/radio/get` |
| 心动模式 | 原生 | eapi `/api/playmode/intelligence/list` | web `/api/playmode/intelligence/list` |
| 每日推荐 | 原生优先（需登录） | eapi `/api/v3/discovery/recommend/songs` | web `/api/v3/discovery/recommend/songs` |
| 最近播放 | 原生优先（需登录） | eapi `/api/v1/play/record` | web `/api/v1/play/record` |
| 「我喜欢的音乐」读 | 原生 | eapi `/api/v6/playlist/detail`（liked trackIds，5 分钟缓存） | web `/api/playlist/detail` |
| 收藏 / 取消收藏 | 原生优先 | eapi `/api/playlist/manipulate/tracks`（`op=add|del`、`pid`、`trackIds`、`immutable`） | web 同端点（query 传参） |
| 用户歌单列表 | 原生 | eapi `/api/user/playlist`（uid/limit/offset 放 body） | web 同路径 |
| 收藏的歌手 / 专辑 / MV | 原生 | eapi `/api/artist/sublist`、`/api/album/sublist`、`/api/mv/sublist`（limit/offset 放 body） | web 同路径 |
| 云盘 | 原生（需登录） | eapi `/api/v1/cloud/get`（limit/offset 放 body） | web 同路径 |
| 播客节目详情 | 原生 | eapi `/api/dj/program/detail`（body `{id}`） | web 同路径 |
| 二维码登录 / 验证码 | web | — | web |

## QQ 音乐

| 能力 | 状态 | 原生端点 | 兜底 |
| --- | --- | --- | --- |
| 搜索 | 原生 | `u6` 签名 `music.search.SearchCgiService/DoSearchForQQMusicDesktop` | web `c.y.qq.com/soso/fcgi-bin/client_search_cp` |
| 歌曲详情 | 原生 | `get_song_detail_yqq`（`song_mid` 小写参数） | web musicu GET |
| 播放地址 | 原生 | `GetCdnDispatch` + `CgiGetVkey`：匿名 M500/C400（128k）；登录态按 F000→M800→M500 逐档（320k / 无损明文） | web `GetVkey` |
| 歌词 | 原生 | `GetPlayLyricInfo`（lrc + trans，base64） | web 同模块 |
| QRC 逐字歌词 | 原生解密 | `QrcDecoder.TryDecrypt`（自定义 DES + zlib）→ 响应 `qrcText`；前端优先用 `qrcText`，缺失才回 `qrc-decoder` | 前端 `qrc-decoder` |
| 歌单详情 | 原生 | `CgiGetDiss` / `fcg_get_diss_by_tag` | web |
| 榜单目录 / 详情 | 原生 | `ToplistInfoServer/GetAll` + `GetDetail` | web `fcg_v8_toplist_cp` |
| 推荐歌单广场 | 原生 | `PlaylistSquare/GetRecommendFeed` | web |
| 推荐流 | 原生 | `RecommendFeed/get_recommend_feed`（`Page/Size`） | web |
| 每日推荐 | 原生 | `Dissinfo(dirid=202)` | web |
| 歌手页 | 原生 | `GetHomepageHeader` + `musichall.song_list_server/GetSingerSongList` + `AlbumListServer/GetAlbumList`（一次多请求） | web SSR `window.__INITIAL_DATA__` |
| 专辑页 | 原生 | `AlbumInfoServer/GetAlbumDetail`（`albumMid` 或数字 `albumID`，含 desc/publishDate）+ `GetAlbumSongList` 取曲目 | web `fcg_v8_album_info_cp` |
| 歌曲评论 | 原生优先 | `CommentRead/GetNewCommentList`；首屏不足时用 web 热评补齐并去重 | web `fcg_global_comment_h5` |
| 电台 | 原生 | `MbTrackRadioSvr/get_radio_track` | web |
| 相似歌曲 | 原生 | `TrackRelationServer/GetSimilarSongs` | web |
| 用户歌单 | 原生 | `GetPlaylistByUin` | web |
| 喜欢读 | 原生 | `SongFavRead/GetSongFav` + `IsSongFanByMid` | web |
| 喜欢写 / 取消 | 原生 | `PlaylistDetailWrite/AddSonglist` / `DelSonglist`（`dirId=201`，写 comm 不带 platform/needNewCode） | web |
| 最近播放 | 原生优先（需登录） | `PlayRecentlyRead/GetPlayRecentlyInfo` | web |
| 收藏的专辑 | 原生（需登录） | `AlbumFavRead/GetAlbumFavList`（android comm + authst）→ `GetAlbumDetail` 取标题 | — |
| 收藏的歌手 | 上游无模块 | `ArtistFavRead/GetArtistFavList` 等全部 500003，按空列表返回 | — |
| 登录态高音质 / 无损 | 原生（需登录） | 登录 comm（`authst=qqmusic_key`）+ `GetVkey/UrlGetVkey`，F000/M800 直出明文 flac/mp3 | web `GetVkey` |
| 登录扫码 | web | — | web |

## QQ 原生模块参数速查

- 传输：`POST https://u6.y.qq.com/cgi-bin/musics.fcg?sign=<zzc>&_=<ms>`（签名对象必须是实际发送字节）；
  浏览类走 `GET https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&data=<urlencoded JSON>`（免签，降级可用）。
- 匿名浏览 comm：`{"ct":24,"cv":0,"uin":"0"}`；桌面搜索 comm：`{"ct":11,"cv":"1003006","v":"1003006","uin":"0"}`。
- 多请求体：`{"comm":{...},"req":{...},"req_0":{...},"req_1":{...}}`，逐个子响应看 `code`
  （`0` 与 `10000` 都算成功，`10000` 是 GetHomepageHeader 的正常返回码）。

## 网易 eapi 参数速查

- 加密：`md5("nobody"+uri+"use"+json+"md5forencrypt")` →
  `uri-36cd479b6b5-json-36cd479b6b5-digest` → AES-128-ECB-PKCS7(eapiKey) → 大写 hex →
  `POST https://interface.music.163.com/eapi/<uri 去掉 /api>`，body `params=<hex>`。
- 设备 header（`osver/deviceId/os/appver/versioncode/buildver/resolution/__csrf/channel`）
  与 `MUSIC_U / MUSIC_A / NMTID` 一起进加密 JSON。
- 分页参数（`limit/offset`）必须放 JSON body，放 query 会 `code=400`（albums / comments 已实测）。
- 音质 level：`standard / higher / exhigh / lossless / hires / jyeffect / vivid / jymaster / sky`；
  匿名封顶 `exhigh`（320k），VIP 曲目返回 `freeTrialInfo`（30 s 试听）。

## 仍然存在的边界

1. **QQ 加密音质档**：`.mgg / .mflac / .mmp4` 已原生支持（QMC2：`GetEVkey` 取 ekey → Map/RC4 解密 → 宿主边下边解）。
   仍受两点约束：必须登录（匿名拿不到 ekey），且具体歌曲是否有加密档由上游 `GetEVkey` 的 `result` 决定
   （`104005` 表示该曲没有这个前缀的加密缓存，自动尝试下一档）。加密档不可用时仍降级到明文档。
2. **QQ 热评**：`GetHotCommentList` 匿名与登录态都只回总数、列表为空；首屏热评仍取 web 后与原生新评论合并。
3. **QQ 收藏的歌手**：`ArtistFavRead / SingerFavRead / FollowSingerRead` 等模块上游统一 500003，原生按空列表返回；专辑收藏已原生。
4. **QQ 歌手简介**：`GetHomepageHeader` 匿名时 `Info.Singer` 为空；原生为空时回退 SSR `window.__INITIAL_DATA__` 抓简介。
5. **网易云盘 / 节目详情**：已切 eapi，均需登录；未登录返回 401 `login-required`。
6. **尾小节循环 / 多屏真实交互**：逻辑已实现，端到端需 WPF 环境验证。

## 改动清单（本次）

- `src/Zilux2/Online/Qq/QqNativeClient.cs`
  - 新增 `BrowseTag`、`GetArtistJsonAsync`、`GetAlbumSongsJsonAsync`、`GetSongDetailJsonAsync`、
    `GetCommentsJsonAsync`、`CallMusicuAsync`、`WebComm`、`Module`。
  - 新增登录态：构造接收 `AccountService`，`HasLogin/Uin/AuthKey`、`Comm()`（android comm + authst）；
    取流按 `F000 → M800 → M500 → C400` 逐档；新增 `GetEkeyAsync`（`GetEVkey`）、
    `GetEncryptedVkeyAsync`（`.mgg/.mflac`，`songtype=1`，文件名用 `media_mid`）与 `ReadVkey`。
  - 新增 `GetAlbumDetailJsonAsync`（`albumMid` / 数字 `albumID` 二选一）、
    `GetAlbumFavoritesJsonAsync`（登录 comm）、`GetArtistFavoritesJsonAsync`（上游 500003，按空处理）。
- `src/Zilux2/Online/Qq/QrcDecoder.cs`（新增）
  - QRC 自定义 DES + zlib 的 C# 移植：`TryDecrypt(hex)`；52 条向量与 npm `decryptQrc` 逐字节一致，
    异常输入返回 null，8 MB 解压上限。
- `src/Zilux2/Online/Qq/QmcDecoder.cs`（新增）
  - QMC2 三种流密码：`MapScramble`（API ekey 主路径）、`MapCompressed`（旧客户端 keyCompress）、
    `Rc4`（key > 300，5120 字节分段 + 段号丢弃）；`Detect(ekey, probe)` 按解密后 `fLaC/OggS/ID3/ftyp` 自动选模式。
  - ekey 解析：base64 → `QQMusic EncV2,Key:` 两段 TC-TEA → EncV1（8 字节 header + TEA body）；
    TEA 为 16 轮 CBC 变体（`DELTA=0x9e3779b9`），已修正「少扣 2 字节 salt」导致零尾校验错位的 bug。
  - `TrimTail` 去除 `musicex`（192 B footer）与 `QTag` 尾部；`Apply(offset, span)` 支持任意偏移（seek / Range）。
- `src/Zilux2/Online/QqProvider.cs`
  - 新增 `TryEncryptedStreamAsync`：`GetSongDetail` 取 `file.media_mid` → `GetEncryptedVkeyAsync`
    （`F000.mflac` / `O8M0` 320k / `O6M0` 192k / `O4M0` 96k，均为 `.mgg`）→ `GetEkeyAsync` →
    Range 0-63 探测 → `QmcDecoder.Detect` → 带 `EncryptionKey/Mode` 返回。
  - 新增 `ResolveEncryptedStreamAsync`（诊断入口）与 `ProbeEncryptedHeaderAsync`。
- `src/Zilux2/Online/LocalMusicServer.cs`
  - `/api/stream` 支持 `encrypted=1` 强制走加密档（诊断用）；流式解密按 `Content-Range` 起点偏移逐块解密，
    `Content-Type` 按解密后格式覆盖（flac/ogg/m4a/mp3）。
- `src/Zilux2/Online/DownloadService.cs`
  - 下载写盘前按偏移解密；完成后 `QmcDecoder.TrimTail` 剥尾，再修正 `written` / `job.Received`。
- `src/Zilux2/Online/Discover/DiscoverService.cs`
  - 新增 `TryFetchQqNativeAsync`（熔断 + 5 s 超时 + 失败回退）。
  - 网易：歌手、歌手专辑、专辑、评论、歌曲详情、专辑发行日回查、播客、收藏（歌单 / 歌手 / 专辑 / MV）
    全部改为 eapi 原生优先。
  - QQ：歌手页（三模块合并）、专辑页（`GetAlbumDetail` 元数据 + 曲目）、歌曲详情、评论（web 热评合并）、
    歌曲 id 解析改为原生优先，失败回退原有 web / SSR 路径；歌手简介原生空时回退 SSR 抓取。
  - 新增 `GetQqCollectionsAsync`（收藏专辑原生，歌手按空）、`GetProgramAsync`、`GetCloudAsync`；
    `GetCollectionsAsync` 的 QQ 分支由 501 改为真实查询。
  - `TryBuildQqArtistNative` 兼容 `songList[]` 的两种形状（`{songInfo:{...}}` 与扁平 song），
    歌手名空时用首曲歌手名兜底。
- `src/Zilux2/Online/NeteaseProvider.cs`
  - 原生搜索空结果时补 `code/msg/chars` 诊断日志，用来区分限流、参数错误与形状变化。
- `tools/online-selftest.ps1`
  - 新增 `6b` 段：网易 / QQ 的 artist、album、song、comments、播客、节目详情、云盘、收藏原生链路断言。
  - 新增 QRC `qrcText` 断言、QQ 登录态 lossless `stream/info` 断言、QQ 专辑 desc 断言、
    **QQ 加密档解密断言**（`/api/stream?...&quality=lossless&encrypted=1`，首包 `OggS`/`fLaC`）。
  - health sources 改为包含关系；付费曲 fixture 允许「可播」或「403 not-playable」两种结果。
  - 日志断言兼容原生命中（`netease.native search` / `qq/native search` / `qq/vkey batch`）；
    关闭窗口按「隐藏到托盘」的新行为断言，再强制结束进程验证端口释放。
- `src/Zilux2/Online/Library/NeteaseLibraryProvider.cs`
  - 新增 `ManipulateLikedAsync`：收藏 / 取消收藏先走 eapi，非 200 回退 web；
    `AddLikedAsync` / `RemoveLikedAsync` 改为调用它，缓存维护逻辑不变。
- `docs/native-coverage-2026-11-06.md`：更新「明确未做 / 限制」。

## 验证

```powershell
dotnet build src/Zilux2/Zilux2.csproj -v m     # 0 warning / 0 error
pwsh tools/online-selftest.ps1                 # 在线链路自测：91 项全绿
cd web; ./node_modules/.bin/tsc --noEmit       # 前端类型检查（tsc 5.x 本地 bin，避免 npx 拉包）
```

运行时抽查（宿主起来后）：

```powershell
curl "http://127.0.0.1:PORT/api/discover/artist?source=qq&id=0025NhlN2yWrP4"
curl "http://127.0.0.1:PORT/api/discover/album?source=qq&id=000MkMni19ClKG"
curl "http://127.0.0.1:PORT/api/discover/comments?source=qq&id=0039MnYb0qxYhV&offset=0&limit=20"
curl "http://127.0.0.1:PORT/api/discover/song?source=netease&id=347230"
curl "http://127.0.0.1:PORT/api/discover/program?id=3731998321"
curl "http://127.0.0.1:PORT/api/discover/cloud?limit=10"
curl "http://127.0.0.1:PORT/api/discover/collections?source=qq&kind=album&limit=10"
curl "http://127.0.0.1:PORT/api/lyric?source=qq&id=0039MnYb0qxYhV"   # 关注 qrcText
curl -r 0-4095 "http://127.0.0.1:PORT/api/stream?source=qq&id=0039MnYb0qxYhV&quality=lossless&encrypted=1"  # QMC2 解密，首包 OggS/fLaC
```
