# Zilux2 在线音乐接入契约（网易云 + QQ 音乐）

> 里程碑 2 ・ 状态：草案 v1（2026-10-18）・ 负责人：host-dev（宿主/服务端）＋ Lead（前端）
>
> 本文件是**唯一的接口契约**。任何一方改动接口都必须先改本文件。

## 0. 目标与范围

在 Zilux2 里接入两个在线音乐源，让用户能**搜索并真实播放**歌曲，供后续 3D 歌词 / 3D 歌单复用。

本里程碑做：

1. 双源搜索（网易云、QQ 音乐），返回统一曲目模型。
2. 真实音频播放：宿主做流媒体代理（支持 Range、拖动进度条）、封面代理、歌词拉取。
3. 前端搜索面板 + 播放器接管（播放/暂停/上一首/下一首/进度/音量/时长）。
4. 歌词 LRC 拉取 + 时间轴同步（先做 2D 滚动歌词面板，3D 歌词舞台留到下一里程碑）。

本里程碑**不做**：账号登录/扫码、VIP/付费曲目解锁、个人歌单、下载、逐字歌词（QRC/YRC）、每日推荐、我的收藏。

## 1. 技术决定

| 决定 | 内容 |
| --- | --- |
| 服务形态 | 宿主内嵌**本机回环 HTTP 服务**（只绑 `127.0.0.1`，动态端口），前端用 `fetch` / `<audio>` 消费 |
| 为什么不用 WebMessage | 音频需要 Range 流式读取与 `currentTime` 拖动，走 HTTP 才能让 WebView2 的媒体栈接管（不整段塞内存） |
| 鉴权 | 启动时生成 32 hex `token`，所有业务接口必须带 `?token=`；`/api/health` 例外 |
| 端口 | `TcpListener` 探测空闲端口后由 `HttpListener` 监听（或等价的 Kestrel 方案），端口 `0` 不可用时用 20000–45000 随机 |
| 上游协议 | 网易云、QQ 音乐**匿名 web 接口**（不登录）。免费曲目可完整播放；VIP/付费曲目返回不可播错误，前端展示"需要会员"提示 |
| 上游请求头 | 统一浏览器 UA + 各自 Referer（见 §4）。QQ 接口对缺少 `Accept: */*` 的客户端可能返回 500，必须带全 |
| 超时 | 搜索 10s；vkey/播放地址 8s；歌词 10s；流代理不设整体超时（按块转发），连接建立 15s |
| 日志 | 每条上游请求写宿主日志一行：`[online] GET netease/search q=晴天 ok 20 tracks 312ms` |

## 2. 宿主模块布局（host-dev 负责）

```
src/Zilux2/Online/
  OnlineMusicModels.cs     # 统一模型 + JSON 序列化上下文
  IOnlineMusicProvider.cs  # 源接口
  NeteaseProvider.cs
  QqProvider.cs
  OnlineMusicService.cs    # 源注册表 + 搜索/歌词/流解析路由
  LocalMusicServer.cs      # HttpListener/回环服务 + 路由 + Range 代理 + token 校验
```

接线：

- `App.xaml.cs` 启动时创建 `LocalMusicServer`（生成 token、监听端口），失败要**记录日志并继续启动**（页面显示"在线源不可用"，不能影响启动）。
- `WebViewHost.cs` 在页面 `ready` 之后、`welcome` 之后推送在线源信息（见 §5）。
- 退出时 `Stop()`/`Dispose()` 优雅关闭监听（不等长连接）。

## 3. 统一模型

```jsonc
// 曲目
{
  "source": "netease",        // netease | qq
  "id": "3391116218",         // 网易云数字 id；QQ 为 songmid
  "title": "晴天",
  "artist": "Lucky小爱",      // 多歌手用 " / " 连接
  "album": "晴天(深情版)",
  "durationMs": 228545,
  "cover": "http://127.0.0.1:PORT/api/cover?source=netease&key=...&token=...", // 可为空串（前端程序化兜底封面）
  "playable": true            // 匿名可播的乐观判断（最终以 /api/stream 为准）
}
```

- 网易云：`playable = fee ∈ {0, 8}`（0 免费 / 8 免费低音质；1=VIP，4=购买专辑）。
- QQ：`playable = pay.pay_play == 0`。
- `cover` 必须是**宿主代理绝对 URL**（含 token），不能直接给上游 URL（防盗链 + 前端不想处理）。
- 时长统一毫秒；未知填 `0`。

## 4. 上游 API 事实（已实测，2026-10-18）

### 4.1 网易云（匿名可用，含 320kbps 音频流）

| 用途 | 方法/URL | 关键参数 | 备注 |
| --- | --- | --- | --- |
| 搜索 | `GET https://music.163.com/api/search/get/web` | `s=<关键词>&type=1&limit=<1..50>&offset=0` | 返回 `result.songs[]`；字段：`id,name,artists[].name,album.name,duration(ms),fee` |
| 详情/封面 | `GET https://music.163.com/api/song/detail` | `ids=[<id>,<id>]`（URL 编码） | 返回 `songs[].album.picUrl`（`https://p1.music.126.net/....jpg`） |
| 播放地址 | `GET https://music.163.com/api/song/enhance/player/url` | `ids=[<id>]&br=320000` | `data[0].url` 为 mp3 直链（带 `expi=1200`，**每次播放前现取，不要缓存**） |
| 歌词 | `GET https://music.163.com/api/song/lyric` | `id=<id>&lv=-1&kv=-1&tv=-1` | `lrc.lyric` 原文；`tlyric.lyric` 翻译，可空 |

- 请求头：`User-Agent: <Chrome UA>`、`Referer: https://music.163.com/`。
- 实测：搜索"晴天"5 首全部拿到 320kbps mp3 直链，`Range: bytes=0-2047` 返回 `206 / audio/mpeg`。

### 4.2 QQ 音乐（匿名可播免费曲目；付费曲目 `purl` 为空）

| 用途 | 方法/URL | 关键参数 | 备注 |
| --- | --- | --- | --- |
| 搜索 | `GET https://c.y.qq.com/soso/fcgi-bin/client_search_cp` | `p=1&n=<1..50>&w=<词>&format=json&aggr=1&cr=1&new_json=1` | `data.song.list[]`：`mid,name,interval(秒),singer[].name,album.name,album.mid,file.media_mid,pay.pay_play` |
| 封面 | `GET https://y.gtimg.cn/music/photo_new/T002R300x300M000<album.mid>.jpg` | — | `album.mid` 为空时无封面 |
| 播放地址 | `POST https://u.y.qq.com/cgi-bin/musicu.fcg` | body 见下 | `req_0.data.midurlinfo[0].purl`；`result==104003` 表示无权限/需付费 |
| 歌词 | `GET https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg` | `songmid=<mid>&format=json&nobase64=1` | `lyric` 为 LRC 原文；`trans` 为翻译（可空）；HTML 实体需反转义 |

vkey 请求体（`guid` 用固定随机数字串即可，例如启动时生成 10 位数字）：

```json
{
  "req":   {"module":"CDN.SrfCdnDispatchServer","method":"GetCdnDispatch","param":{"guid":"3982823384","calltype":0,"userip":""}},
  "req_0": {"module":"vkey.GetVkeyServer","method":"CgiGetVkey","param":{"guid":"3982823384","songmid":["<mid>"],"songtype":[0],"uin":"0","loginflag":1,"platform":"20"}},
  "comm":  {"uin":"0","format":"json","ct":24,"cv":0}
}
```

- 完整音频 URL = `req_0.data.sip[0] + purl`（`sip` 可能是 `http://aqqmusic.tc.qq.com/` 等）。请求上游音频时必须带 `Referer: https://y.qq.com/`，否则可能 403。
- 请求头：`User-Agent: <Chrome UA>`、`Referer: https://y.qq.com/`、`Accept: */*`、`Content-Type: application/json`（POST vkey）。
- 实测：`pay_play=0` 的歌曲拿到 `purl` 并可 `206` 流式播放；`pay_play=1`（如周杰伦《晴天》）`purl` 为空且 `result=104003` → 返回不可播错误。

### 4.3 通用注意事项

- 上游都可能限流/抽风：搜索最多重试 1 次（间隔 300ms）；失败返回 502，前端展示"搜索失败，请重试"。
- 歌词与封面失败不影响播放。
- 音频流必须边读边写（`HttpWebResponse.GetResponseStream()` → `response.OutputStream`，32KB 缓冲），禁止 `ReadToEnd` 整段缓存。
- 用户拖动进度条会带 `Range: bytes=...`，必须透传给上游并把 206 状态码与 `Content-Range`/`Content-Length`/`Content-Type` 原样带回。

## 5. HTTP 接口（宿主暴露给页面）

Base：`http://127.0.0.1:<port>/api/...`，除 `/api/health` 外都必须带 `&token=<token>`。

### GET /api/health（无需 token）

```json
{"ok":true,"version":1,"sources":["netease","qq"]}
```

### GET /api/search

`?source=netease|qq&q=<urlencoded>&limit=<1..50,默认20>&token=...`

```json
{"source":"netease","query":"晴天","tracks":[<曲目>],"tookMs":312}
```

错误：`400`（参数非法）、`502`（上游失败）、`401`（token 错）。

### GET /api/lyric

`?source=&id=&token=`

```json
{"source":"netease","id":"3391116218","lrc":"[00:00.000] ...\n[00:30.542]...","translation":null,"hasTranslation":false}
```

无歌词（仍 200）：`{"source":"qq","id":"...","lrc":"","translation":null,"hasTranslation":false}`

### GET /api/stream

`?source=&id=&token=`

- 成功：`200` 或 `206`，`Content-Type`（audio/mpeg、audio/mp4…）、`Accept-Ranges: bytes`、`Content-Length`、`Content-Range`（若有）按上游透传；body 为音频字节流。
- 不可播：`403 {"error":"not-playable","message":"该歌曲需要 QQ 音乐会员或已下架"}`
- 上游失败：`502 {"error":"upstream-failed","message":"..."}`

### GET /api/cover

`?source=&key=&token=`

- `source=netease`：`key` = 完整 `https://p1.music.126.net/...jpg`（必须校验 host 以 `.music.126.net` 结尾）。
- `source=qq`：`key` = `album.mid`（32 位字母数字）→ 服务端拼 `https://y.gtimg.cn/music/photo_new/T002R300x300M000<key>.jpg`。
- 成功 `200` + `Content-Type: image/*`，body 图片字节；失败 `404`/`502`。内存缓存 1 小时（最多 200 张）。

### 通用

- 所有响应带 `Access-Control-Allow-Origin: *`；`OPTIONS` 返回 `204` + `Access-Control-Allow-Methods: GET,OPTIONS` + `Access-Control-Allow-Headers: *`。
- 业务错误统一 JSON：`{"error":"code","message":"用户可读文本"}`。
- 搜索 `q` 长度 ≤ 100、`limit` ≤ 50，否则 400。

## 6. 页面接入（Lead 负责）

宿主在页面 `ready` 后发送一条消息（沿用 `{v:1,type:'host',event,payload}`）：

```json
{"v":1,"type":"host","event":"online","payload":{"port":23456,"token":"9f2c...","sources":["netease","qq"]}}
```

页面：

- `searchOnline(source, keyword)` → `GET /api/search`，渲染结果列表；
- 点击曲目 → `<audio src="http://127.0.0.1:<port>/api/stream?source=..&id=..&token=..">`，用 `timeupdate`/`loadedmetadata` 驱动进度条与时长；
- 歌词 → `GET /api/lyric`，前端解析 LRC（`[mm:ss.xx]`），按 `currentTime` 高亮当前行；
- 封面 → 直接用返回的 `cover`（代理 URL）；
- 宿主未就绪时（本地预览/无宿主）显示"在线源未连接"，搜索按钮禁用。

## 7. 验收标准（host-dev 自测 + Lead 联调）

host-dev 交付前必须用 `curl` 实测并记录：

1. `GET /api/health` → 200。
2. `GET /api/search?source=netease&q=晴天&limit=5` → 200，JSON 含 5 条曲目，`cover` 为 `127.0.0.1` 代理 URL。
3. `GET /api/search?source=qq&q=晴天&limit=5` → 200，含 `mid` 与 `playable` 字段。
4. 对网易云第一条曲目：`curl -H 'Range: bytes=0-2047' .../api/stream` → `206`、`Content-Range: bytes 0-2047/<size>`、body 前 4 字节为 `ID3` 或 `ftyp`。
5. 对 QQ `pay_play=0` 曲目（如 `0042rlGx2WHBrG`）→ `206` 可播；对 `pay_play=1` 曲目（如 `0039MnYb0qxYhV`）→ `403 not-playable`。
6. `GET /api/lyric?source=netease&id=3391116218` → 200 且 `lrc` 含 `[00:`；QQ 同理。
7. `GET /api/cover?source=qq&key=<album.mid>` → 200 且 `Content-Type: image/jpeg`。
8. 无 token → 401；端口只监听 127.0.0.1（`netstat -ano | findstr <port>` 验证无 0.0.0.0）。
9. 宿主日志每个请求一行；关闭窗口后端口释放、无残留进程。

## 8. 已知风险 / 后续

- 匿名接口随时可能变更或限流：Provider 层已隔离，坏了只改单个 provider。
- VIP 曲目：本里程碑明确不支持；后续里程碑做扫码登录（QQ/网易云）后解锁。
- 网易云 mp3 URL 有 `expi=1200`：**不要缓存 stream URL**，每次 `/api/stream` 现取。
- QQ 试听（30s）未接入。
- 逐字歌词（QRC/KRC）留到 3D 歌词里程碑。

## 9. 实测补充（host-dev，2026-10-18）

- 网易云 `api/search/get/web` 结果的 `album` 只有 `picId`，没有 `picUrl`；封面必须再调一次 `api/song/detail?ids=[...]` 取 `album.picUrl`。实现里搜索后批量补一次 detail，失败只丢封面不报错。
- QQ `fcg_query_lyric_new.fcg?...format=json&nobase64=1` 实测返回裸 JSON（无 JSONP 包裹），`lyric` 内是 HTML 实体编码的 LRC；实现仍保留 JSONP 剥离兜底。
- QQ 音频直链实测 `Content-Type: audio/mp4`、body 偏移 4 起为 `ftyp`；网易云为 `audio/mpeg`、body 首 3 字节 `ID3`。验收按"`ID3` 或 `ftyp`"判断。
- `album.mid` 长度不固定（实测 11–14 位），`/api/cover` 的 qq key 校验放宽为 1–64 位 `[A-Za-z0-9]`。
- **系统代理坑**：本机 Windows 系统代理（`ProxyEnable=1`、`127.0.0.1:7896`）会被 .NET `SocketsHttpHandler` 默认采用；走该代理时 QQ `client_search_cp` 返回**空 body 的 HTTP 500**（同一 URL curl 直连 200）。宿主对上游默认 `UseProxy=false` 直连，避免音乐服务行为随系统代理漂移；需要代理的用户可设 `ZILUX2_ONLINE_PROXY=http://host:port`（`direct` 强制直连）。
- `HttpListener` 在**非管理员**账户下绑定 `http://127.0.0.1:<port>/` 实测可行（无需 netsh urlacl）；端口先由 `TcpListener(IPAddress.Loopback, 0)` 取空闲端口再绑定，失败重试 5 次。
- 自测钩子：环境变量 `ZILUX2_ONLINE_TOKEN` 为 32 位 hex 时复用它（仅自测；生产不设则每次启动随机生成）。`tools/online-selftest.ps1` 用它跑 §7 的 9 条验收，共 53 项断言全绿。
- **QQ 搜索备用端点**（Lead 批准，2026-10-18 20:13 追加）：主端点 `https://c.y.qq.com/soso/fcgi-bin/client_search_cp` 即使已直连，对匿名客户端仍会**间歇返回空 body 的 HTTP 500**（2026-10-18 19:5x 与 20:09 复现 500，同刻 vkey/歌词接口 200；20:12 复测主端点恢复 200）。回退条件：主端点两次尝试（间隔 300ms）后仍是 5xx / 空 body / 解析不到 `data.song.list` 时，改用 `https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp?p=1&n=<limit>&w=<query>&format=json` 重试一次；正常路径不会多发请求。
- 备选端点字段差异：`mid`→`songmid`、`name`→`songname`、`album.mid`→`albummid`、`album.name`→`albumname`、`pay.pay_play`→`pay.playplay`；`interval`（秒）与 `singer[].name` 相同。字段适配在 QqProvider 内部完成，统一曲目模型与前端协议不变，§5 接口无变化。
- 回退日志：`[online] qq search fallback=search_for_qq_cp ok n=<n> <ms>ms primary=<status>`；主备都失败时记 `qq search failed: primary=... fallback=...`（含两路状态）并返回 `/api/search` 502（`upstream-failed`）。
- 2026-10-18 20:12 复测：`tools/online-selftest.ps1` 57 项断言全绿，本轮 QQ 搜索走主端点（5 条，1066ms）；备选端点用 curl 实测 200，字段形状如上（含 `pay.playplay`）。

