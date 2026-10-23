# 网易云 / QQ 音乐「登录后能拿到什么」能力盘点

> 实测日期：2026-10-22；实测账号：本机已登录的网易云（userId 4872652023，vipType 110）、QQ 音乐（userId 1332977057）。
> 探测方式：读 `%LOCALAPPDATA%\Zilux2\account.json`（DPAPI 当前用户解密）拿 cookie，直接带登录态请求候选接口。
> 结论分级：✅ 实测可用 / ⚠️ 需换参数或逆向 / ❌ 已下线或不可用。

## 0. 现状（软件里已经能用的）

后端 22 条 HTTP 路由已覆盖：搜索、歌词、播放地址、封面、封面取色、热门歌单、账号（二维码登录 / 导入 / 退出）、音乐库（总览 / 歌单详情 / 每日推荐 feed / 最近播放 / 刷新 / 我喜欢 / 收藏与取消收藏）。

UI 已有：首页推荐与热门歌单、最近播放、歌词页三种播放效果、快捷设置、房间设置。

也就是说「我的歌单 / 我喜欢 / 每日推荐 / 最近播放 / 收藏」这五件事底层已经具备，缺的是入口页面与更丰富的栏目。

## 1. 网易云音乐（登录后）

| 能力 | 接口 | 实测 | 备注 |
| --- | --- | --- | --- |
| 账号信息 | `/api/nuser/account/get`、`/api/v1/user/detail/{uid}` | ✅ | 昵称/头像/等级/累计听歌数 |
| 我的歌单（自建+收藏） | `/api/user/playlist?uid=&limit=1000` | ✅ | 实测 8 个：自建 4（含「我喜欢」1061 首）+ 收藏 4 |
| 歌单详情/歌曲列表 | `/api/v6/playlist/detail?id=` | ✅ | 单次约 10 首，需分页/多次拉取 |
| 我喜欢的音乐 | 同上（特殊歌单 6715113218，1061 首） | ✅ | 已有 `liked` 通道 |
| 每日推荐 | `/api/v3/discovery/recommend/songs` | ✅ | 30 首/天 |
| 推荐歌单 | `/api/v1/discovery/recommend/resource`、`/api/personalized/playlist` | ✅ | 19 / 6 个 |
| 精品歌单 / 歌单广场 | `/api/playlist/highquality/list`、`/api/playlist/list?cat=&order=` | ✅ | 精品 402 总量；分类广场可取 |
| 排行榜 | `/api/toplist` | ✅ | 64 个榜单（飙升/新歌/原创/热歌…） |
| 最近播放 | `/api/v1/play/record?type=1&uid=` | ✅ | 100 条/周 |
| 听歌排行 | `/api/v1/play/record?type=0&uid=` | ✅ | 所有时间 100 条 |
| 私人漫游（电台式听歌） | `/api/v1/radio/get` | ✅ | 每次返回 3 首，可连续请求 |
| 播客（声音节目推荐） | `/api/personalized/djprogram` | ✅ | 推荐节目可用；分类列表 `/api/djradio/category/get` 可用，`/api/djradio/recommend|hot` 参数错误 |
| 歌手页 | `/api/v1/artist/{id}`、`/api/artist/top/song?id=` | ✅ | 歌手信息 + 热门 50 首 |
| 专辑页 | `/api/album/{id}`、`/api/album/sublist` | ✅ | 收藏专辑接口可用（当前 0 条） |
| 收藏歌手 | `/api/artist/sublist` | ✅ | 实测 3 个 |
| 收藏 MV | `/api/mv/sublist` | ✅ | 接口可用（当前 0 条） |
| 评论 | `/api/v1/resource/comments/R_SO_4_{songId}` | ✅ | 总数 + 精彩评论 15 条/页 |
| 云盘 | `/api/v1/cloud`、`/api/cloud` | ❌ | 404，接口已下线 |
| 关注/粉丝 | `/api/user/get/follows|followeds` | ❌ | 404，旧接口下线 |
| MV 详情/地址 | `/api/mv/detail`、`/api/mv/url` | ⚠️ | 需要客户端加密参数，暂未打通 |
| 签到 | `/api/point/dailyTask` | ❌ | 参数错误 |

## 2. QQ 音乐（登录后）

| 能力 | 接口 | 实测 | 备注 |
| --- | --- | --- | --- |
| 我的歌单 | `musicu.fcg` → `music.musicasset.PlaylistBaseRead/GetPlaylistByUin` | ✅ | 实测 27 个 |
| 收藏歌单 | `musicu.fcg` → `music.musicasset.PlaylistFavRead/GetPlaylistFavList` | ✅ | 实测 36 个 |
| 我喜欢 | `musicu.fcg` → `music.srfDissInfo.DissInfo/CgiGetDiss`（dirid=201） | ✅ | 已实现（QqLibraryProvider.GetFavoritesAsync） |
| 歌单详情 | 同上 `CgiGetDiss`（disstid） | ✅ | 已实现 |
| 搜索 | `music.search.SearchCgiService/DoSearchForQQMusicDesktop` | ✅ | 已实现 |
| 歌曲详情 | `music.pf_song_detail_svr/get_song_detail_yqq` | ✅ | 已实现 |
| 排行榜 | `c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg?topid=` | ✅ | 榜单歌曲列表可取 |
| 歌单广场/分类 | `c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg` | ✅ | 按分类取歌单 |
| 每日推荐 | `music.recommend.*` | ⚠️ | 模块名/参数需逆向客户端 |
| 最近播放 | — | ⚠️ | 未找到稳定模块 |
| 电台/播客 | `music.longaudio.*` | ⚠️ | 未验证，需要客户端模块名 |
| 歌手/专辑/收藏夹 | `music.singer.*`、`AlbumFavRead` 等 | ⚠️ | 返回 500003/40000，需逆向 |
| 旧版 web 资料接口 | `c.y.qq.com/fav/fcgi-bin/...` | ❌ | code 4000（需要签名） |

QQ 侧的现实情况：**「账号自己的收藏关系」（歌单/收藏歌单/我喜欢/搜索/详情/排行榜/歌单广场）都能稳定拿到；「推荐类/电台类/歌手页」需要继续逆向客户端模块，成本明显更高。**

## 3. 建议做进软件的功能（按优先级）

**第一梯队（数据现成、UI 工作量小，建议先做）**
1. **我的音乐库页**：我的歌单 + 收藏歌单 + 我喜欢（两平台都有，现有 `/api/library/*` 基本够用，主要是新页面与歌单详情播放队列）。
2. **每日推荐入口**：网易云 30 首/天直接出列表卡片（QQ 暂缓）。
3. **最近播放 / 听歌排行**：网易云现成，替代首页「最近播放」的本地记录。
4. **排行榜页**：网易云 64 榜 + QQ 榜单，榜单详情→播放队列。
5. **搜索增强**：已有搜索，加「歌曲/歌单/歌手」分类与歌单结果跳转。

**第二梯队（有数据，需要新交互）**
6. **私人漫游**：点一下随机推歌，极适合当「不知道听什么」入口；网易云 radio/get 稳定。
7. **歌手页 + 专辑页**：歌手热门 50 首、专辑曲目。
8. **歌单广场**：按分类/热度浏览（网易云 playlist/list、QQ diss_by_tag）。
9. **播客推荐**：网易云 personalized/djprogram 先做「推荐节目」列表。

**第三梯队（工作量大或数据不稳）**
10. **评论**：每首歌详情页看精彩评论（网易云稳，QQ 未验证）。
11. **MV**：需要打通客户端加密参数，性价比低。
12. **云盘/关注粉丝**：两侧接口已下线，做不了。

## 4. 风险与注意

- **cookie 会过期**：所有能力都依赖登录态，过期后要重新扫码/导入；需要统一的「登录已失效」提示与重登入口。
- **版权/VIP 限制**：能列出歌单不代表能播放（VIP/版权/地区限制仍需逐首解析播放地址，现有 `ResolveStreamAsync` 已有降级提示）。
- **接口易变**：网易云这批还是公开 web 接口，相对稳；QQ 的 musicu 模块名/参数一旦变动就会 400/500003，需要留降级与日志。
- **频率**：歌单详情分页要控制并发，避免触发风控。
- **探测脚本**已留在 `research/tmp/probe-*.mjs`、`probe-accounts.ps1`，后续确认新接口可复用。

## 5. 需要你拍板

先做哪些？推荐第一批：**我的音乐库（歌单）+ 每日推荐 + 排行榜 + 私人漫游**（四个都是入口级，数据和后端几乎现成，主要是前端页面）。
如果要连 QQ，建议先只做「我的歌单 / 收藏歌单 / 排行榜 / 歌单广场」，推荐类先缓。
