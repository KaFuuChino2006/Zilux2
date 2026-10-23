# mvmp3.com（无名音乐网）接入调研

调研时间：2026-10-22 · 目标：判断能否把 https://www.mvmp3.com/ 作为音乐源接入 Zilux2

## 一、结论

**技术上可行，而且门槛很低。** 它的「人机验证」不是 Cloudflare/极验那类真验证，而是自研的
「勾选我不是人机」表单 + CSRF token（服务端按 PHPSESSID 记 1 小时），发一个 POST 就能通过；
搜索、播放地址、封面、歌词都有现成的服务端接口，音频是 kuwo CDN 的直链（320kbps MP3 / Range 可用）。

真有成本的是**法律与稳定性**：音频源是 `kuwo ... ?from=vip` 这类盗链/VIP 绕过直链，站点本身是聚合站。
自己测试用没问题，**对外分发风险高**（详见第五节）。

## 二、验证机制（关键，决定可行性）

- 未验证时任何 HTML 页面（首页 / 搜索 / 歌曲页）都返回 `安全验证` 页（2.6KB 表单）。
- 表单结构：
  - `POST /`，字段 `csrf_token=<页面里的 token>` + `human_check=on`；
  - 服务端 302 回 `/`，验证状态记在 **PHPSESSID 会话**里，约 1 小时（与 `server_name_session` cookie 配合）。
- **可完全自动化**：`GET /` → 正则取 `csrf_token` → `POST /` → 复用 CookieContainer 即可。
  用户不需要看到勾选框，引擎每 1 小时静默续一次。
- 实测：验证后 首页/搜索/歌曲页 200；**未验证时 `POST /style/js/play.php` 依然返回 JSON**
  （即取播放地址本身就不过验证，只有 HTML 页面被拦）。

## 三、可用的数据接口

| 用途 | 接口 | 说明 |
| --- | --- | --- |
| 搜索 | `GET /so/<URL编码关键词>.html` | 服务端渲染，每页 30 条；条目含 `/mp3/<hash>.html`、歌手 - 歌名、时长 `04:29`、大小 `4.12 MB`、封面（kugou http 图） |
| 播放地址/歌词 | `POST /style/js/play.php`，`id=<hash>&type=mp3` | 返回 JSON：`title`、`name`、`singer`、`pic`、`url`、`lrc`（LRC 文本） |
| 歌曲页 | `GET /mp3/<hash>.html` | 页面里同样调用 `player("dance", hash)`，可直接用上面的 API 代替 |

- `type` 取值：普通歌曲用 `mp3`（`song` 会返回空；`music` 是电台/DJ；`mp4`/`video` 返回加密 list）。
- 音频：`https://car-bj.kuwo.cn/...mp3?from=vip`，实测 `Range` 返回 `206 Partial Content`、
  `Content-Type: audio/mpeg`、**320kbps/44.1kHz MP3**，不需要 Referer，https 可直接给 WebView2 的 `<audio>` 播。
- 封面：`imge.kugou.com` 同路径 https 可用（http→https 改写即可）。
- 歌词：`lrc` 字段是标准 LRC（中文正常），可直接进现有歌词管线（无 QRC/逐词时间）。

## 四、接入方案（三种）

### 方案 A：作为原生音乐源接进引擎（推荐）
实现一个 `Mvmp3Provider : IOnlineMusicProvider`（复用现有 NetEase/QQ/Kugou 的接入方式）：
1. `SearchAsync`：带会话 GET `/so/<kw>.html`，正则/HTML 解析 30 条 → `OnlineTrack`
   （source=`mvmp3`、id=`/mp3/` 的 hash、title=name、artist=singer、album 空、durationMs 从 `stime`、cover 改 https）。
2. `ResolveStreamAsync`：POST `play.php {id,type:mp3}` → `url`，返回 `StreamResolution.Playable`。
3. `GetLyricAsync`：同一响应里的 `lrc` → `LyricData.Lrc`。
4. 会话：一个进程级 `HttpClient` + `CookieContainer`，检测到「安全验证」页自动重新 POST 勾选。
5. 前端只需在来源名/图标映射里加 `mvmp3`（其他 UI 全部复用：搜索、播放、歌词页、房间效果、最近播放）。

成本：引擎 300~400 行 + UI 少量映射，**约 1~1.5 天**（含真机 QA、安装包）。

### 方案 B：内嵌一个网页窗口（最省事）
在 app 里加一个「网页」入口，用第二个 WebView2 直接加载 mvmp3：
验证让用户勾一次（或注入脚本自动勾），网页自带播放器。
成本 0.5 天，但**没有集成**：不能进播放列表/歌词页/房间效果，有广告，双播放器、音量/暂停不同步。

### 方案 C：网页 + 自己的播放器（混合，不推荐）
内嵌站点只用来过验证拿 Cookie，再把请求转给宿主解析——本质等于 A，还多一层 WebView，不如直接 A。

## 五、风险与限制（务必先看）

1. **法律风险（最大）**：音频 URL 是 kuwo 的 `from=vip` 直链，属于绕过正版/VIP 的盗链；
   站点自身也是聚合站。自己本机测试问题不大，**一旦分发（尤其公开/商用）有侵权风险**，
   和现有「网易云/QQ 非官方接口」不是一个量级。
2. **稳定性**：无官方 API，人机验证/反爬随时可能升级（换真 captcha 就失效）；站点若关停则源消失。
3. **数据质量**：只有 歌曲名/歌手/时长/大小/音质/封面/LRC；没有专辑、发行日期、歌手页、歌单、排行榜；
   搜索结果重复多（同一首歌多个版本），个别 hash 可能失效（`type=mp3` 返回空）。
4. **内容**：站点多是热门歌曲翻录/聚合，音质标注可能与实际不符（页面写 128kbps、接口给 320kbps）。
5. 音频直链有时效性（每次 play.php 重新签发），必须**播放时实时解析**，不能缓存 URL。

## 六、建议

- 如果只是**自己用/内部测试**：走方案 A，做成一个和其他源并列的「无名音乐」来源，最小闭环
  「搜索 → 播放 → 歌词（房间效果可用）」，**不做**缓存/下载/分享。
- 如果要**对外发布**：不建议接入；或者只保留为默认关闭、需用户自行开启的实验源，并在说明里标注来源与风险。
- 验证自动化这件事本身也算绕过站点反爬，建议只在个人使用范围内做，不要高频请求（搜索加 300~500ms 间隔、结果缓存）。

## 七、待确认

1. 是否要做？选哪个方案（A/B）？
2. 用途是自用还是分发？（决定是否值得承担法律风险）
3. 若做 A：是否要顺带支持「搜索结果的音质/大小显示」和「失败自动重试下一个同名结果」？

## 十、实现状态（2026-10-22 晚，已接入）

- 后端：`src/Zilux2/Online/Mvmp3Provider.cs`（会话验证 + 搜索 + play.php 取流/歌词）；
  `OnlineMusicService` 注册为 `mvmp3`；`MusicSourceCatalog` 标记 `experimental: true`；
  `/api/sources` 下发 `experimental` 字段。
- 关键坑：`POST /style/js/play.php` 的 `type` 必须传 **`dance`**（站点歌曲页调的是
  `player("dance", hash)`）；传 `type=mp3` 返回 `url: null`。
- 前端：`web/src/online/experimental.ts`（默认关闭、风险条款、二次确认、
  localStorage `zilux2.experimental.mvmp3`）；`sources.ts` 过滤实验来源；
  设置 →「实验功能」里开启后，搜索来源分段 / 默认平台才会出现「无名音乐」。
- 已实测：搜索（30 条/页）→ 播放（kuwo CDN，206 audio/mpeg）→ 封面 → LRC 歌词均正常；
  关闭开关后来源立即从搜索分段消失。
- 已知限制：跨平台歌词匹配（QQ 匹配 90%）的时间轴对第三方源不一定准确，
  个别歌在房间效果下会出现歌词空窗；默认歌词页显示正常，可在「歌词来源」里手动调整。

## 2026-10-22 追加：播过的歌自动缓存到本地

### 目标
实验来源「无名音乐」没有收藏/歌单，但希望「搜索播放过的歌自动存到本机」，
之后再次播放（甚至外站临时失效）直接读本地文件。

### 实现
- **落盘位置**：`%LOCALAPPDATA%\Zilux2\mvmp3-cache\<hash>.mp3`（`src/Zilux2/Online/Mvmp3Cache.cs`）。
- **后台预取**（与播放解耦）：`HandleStreamAsync` 解析出播放地址后调用
  `Mvmp3Cache.Prefetch(id, url, headers)`；后台用独立 `HttpClient` 整首下载到 `.part`，
  下载完成再原子改名成 `.mp3`。播放本身仍走 `/api/stream` 代理流，不受下载影响；
  连接中断保留 `.part`，下次播放用 `Range: bytes=<已有长度>-` 续传。
- **优先读缓存**：`/api/stream` 命中 `Mvmp3Cache.TryGet` 时走
  `ServeCachedAudioAsync`——返回 `200` 整首 + `X-Zilux2-Cache: hit`，
  并且**完整支持 Range**（`206` + `Content-Range`），拖进度条/断点都正常。
- **管理接口**：`GET /api/mvmp3/cache` 返回 `{count,bytes,dir}`，`POST` 清空；
  设置页「实验功能 → 本地缓存」显示「已缓存 N 首（X MB）」+「清空」按钮。
- **限制**：单文件上限 200MB；`.part` 未下完不参与统计；清空缓存会连同 `.part` 一起删除；
  该来源数据仍不参与「最近播放 / 我喜欢的音乐 / 每日推荐 / 听歌排行」。

### 验证（2026-10-22）
- 首次播放《茶花开了》：`host.log` → `[mvmp3] prefetched … 10802282B` / `[mvmp3] cached …`，
  缓存目录出现 10.3MB 文件；播放器继续正常计时。
- 缓存命中：`GET /api/stream?source=mvmp3&id=…` → `200` + `X-Zilux2-Cache: hit`（10,802,282B）；
  带 `Range: bytes=1000-1999` → `206 Partial Content` + `Content-Range: bytes 1000-1999/10802282` + `hit`。
- 设置页：显示「已缓存 1 首（10.3 MB）」，清空后变回「还没有缓存」。

