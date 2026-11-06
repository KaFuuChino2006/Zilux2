# 原生接口覆盖与验证（2026-11-06）

> 目的：把 P1–P3 的「原生优先、web 兜底」覆盖情况与可复核证据集中在一处，便于发布说明与回归。
> 结论以宿主日志（`%LOCALAPPDATA%\Zilux2\logs\host.log`）与 headless harness 的 HTTP 结果为准。

## P1 取流 + 歌词

| 能力 | 原生路径 | 兜底 | 证据 |
| --- | --- | --- | --- |
| 网易取流 | eapi `/api/song/enhance/player/url/v1`，带 br / 试听 | web `/api/song/enhance/player/url` | harness：3/3（41–58 ms）；VIP 曲 30 s 试听 |
| QQ 取流 | musicu `CDN.SrfCdnDispatchServer/GetCdnDispatch` + `vkey.GetVkeyServer/CgiGetVkey` | web CgiGetVkey | harness：3/3（185–312 ms）；匿名 128 kbps |
| 网易歌词 | eapi 三轨（lrc / tlyric / yrc） | web | harness：6/6，带翻译 |
| QQ 歌词 | musicu `music.musichallSong.PlayLyricInfo/GetPlayLyricInfo`（lrc + trans） | web fcg | harness：6/6；QRC 由 `QrcDecoder` 原生解，响应带 `qrcText` |

## P2 搜索 / 歌单 / 收藏 / 榜单 / 推荐列表

| 能力 | 原生路径 | 兜底 | 证据 |
| --- | --- | --- | --- |
| 搜索 | QQ musicu 搜索；网易 eapi 搜索 | web | harness：10 条 / 190–250 ms |
| 热门歌单 | QQ `fcg_get_diss_by_tag`；网易 `/api/top/playlist` | web | harness 68–139 ms |
| 歌单广场 | QQ `music.playlist.PlaylistSquare/GetRecommendFeed` | web | DiscoverService 原生 |
| 榜单目录 | QQ `musicToplist.ToplistInfoServer/GetAll`；网易 `/api/toplist` | web | 原生日志 `qq.native hotlists` |
| **榜单详情（QQ）** | `musicToplist.ToplistInfoServer/GetDetail`（`param{topid,offset,num}`，返回 `songInfoList[]` 含 `mid`） | `c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg` | `id=4` → 200、100 首、127 ms；`offset=2` 分页正确；`id=26` → 200、299 首、首曲 `Hong Kong (feat. 王菲季候风)` 216 s、`playable=true`；非数字 id 走 fallback 返回 200「排行榜」，无异常 |
| 网易榜单详情 | eapi `/api/v6/playlist/detail` + `/api/v6/playlist/track/all` | web | 原生日志 `netease.native chart detail` |
| QQ 账号库读 | `PlaylistBaseRead/GetPlaylistByUin`、`SongFavRead/GetSongFav`、`Dissinfo(dirid=202)` | web | `GET /api/library/feed?source=qq` → 30 首；日志 `POST qq/library feed daily ok 162ms` |
| 收藏写 | —（web） | web | 明确保留：写操作走 web |

## P3 个性化推荐 + 心动模式

| 能力 | 原生路径 | 兜底 | 证据 |
| --- | --- | --- | --- |
| 网易私人漫游 | eapi `/api/v1/radio/get` 等 | web | harness：52 ms；匿名 1 首 |
| QQ 每日推荐 | `Dissinfo(dirid=202)` | web | 30 首（见上） |
| 网易心动模式 | eapi `/api/playmode/intelligence/list`（`fromPlayOne`） | 无（需登录） | `GET /api/netease/intelligence?...count=30` → 200、30 首；首页按钮 headless 验证 queue=30 |

## 构建与产物

- `dotnet build src/Zilux2/Zilux2.csproj -c Release`：0 警告 / 0 错误（含 `-t:Rebuild`）。
- `npx tsc --noEmit` + `npm run build`（web）：通过（`main-BRIHe7JT.js`）。
- 发布：`dist\Zilux2\Zilux2.exe` 47,676,693 B + `web/` 10,262,044 B；已 robocopy 到安装目录。
- 保护：单次 5 s 超时；同 provider 连续 2 次失败熔断 60 s；日志不含 token / cookie / 完整 URL。

## 明确未做 / 限制

1. **QQ 加密音质档**：`.mflac / .mgg / .mmp4` 已原生支持 —— `GetEVkey` 取 ekey，QMC2（Map / RC4）流式解密，
   首包 `OggS`/`fLaC` 可播；仍要求登录，且单曲是否有加密缓存由上游 `104005` / `result=0` 决定。
   QRC 已由宿主 `QrcDecoder` 原生解密（响应 `qrcText`），前端仅作兜底。
2. **QQ 登录态高清 / 无损**：已原生接入（登录 comm + `GetVkey/UrlGetVkey`，F000/M800 明文可播），
   加密档作为无明文档时的兜底。
3. **QQ 收藏的歌手**：`ArtistFavRead` 等模块上游统一 500003，按空列表处理；专辑收藏已原生。
4. **QQ 热评**：`GetHotCommentList` 匿名与登录都只回总数；首屏热评由 web 补齐后与原生新评论合并。
5. **网易收藏的歌手 / 专辑 / MV**：已切 eapi sublist（需登录）；云盘与节目详情也已原生。
6. **心动模式自动续排**：已实现（`web/src/ui/heartRadio.ts`，队尾 ≤2 首自动补齐、60 s 空批冷却）。
7. **尾小节循环 / 多屏真实交互**：逻辑已实现，但端到端需 WPF 环境；见 `docs/agents/crash-d3d9-2026-11-06.md` 与 `tools/post-reboot-verify.ps1`。

全链路覆盖矩阵与本次原生化清单见 `docs/zilux2-native-full-link.md`。
