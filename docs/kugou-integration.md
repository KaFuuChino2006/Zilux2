# 酷狗音乐接入调研（KuGouMusicApi）

参考仓库：<https://github.com/MakcRe/KuGouMusicApi>（MIT，Node 侧对酷狗 Web/Android 接口的封装）。
目标：在宿主内用 C# 复刻核心接口，接入 Zilux2 的账号、搜索、歌单、喜欢、取流、歌词，保持与网易云 / QQ 音乐一致的交互。

## 1. 关键接口（上游直连）

| 能力 | KuGouMusicApi 路由 | 上游 | 关键参数 |
| --- | --- | --- | --- |
| 二维码 key | `/login/qr/key` | `https://login-user.kugou.com/v2/qrcode` | `appid=1001`（web 1014）、`type=1`、`plat=4`、`qrcode_txt`、`srcappid` |
| 二维码内容 | `/login/qr/create` | 本地生成 | `https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=<key>` |
| 扫码状态 | `/login/qr/check` | `https://login-user.kugou.com/v2/get_userinfo_qrcode` | `plat=4`、`appid`、`srcappid`、`qrcode=<key>`、`dev` |
| 用户歌单 | `/user/playlist` | `/v7/get_all_list` | `userid`、`token`、`total_ver=979`、`type=2`、分页 |
| 搜索 | `/search` | `/v2/search/song`（song）等 | `keyword`、`page`、`pagesize`、`platform=AndroidFilter`、`iscorrection`、`privilegefilter`、`area_code` |
| 歌曲 URL | `/song/url` | 需先 `/register/dev` 取 `dfid` | `hash`、`album_id`、`album_audio_id`、`quality`、`free_part` |
| 歌词搜索 | `/search/lyric` | — | 关键词，返回 `id` / `accesskey` |
| 歌词 | `/lyric` | `https://lyrics.kugou.com/download` | `id`、`accesskey`、`fmt=lrc|krc`、`decode` |
| 歌单详情/歌曲 | `/playlist/detail`、`/playlist/track/all` | — | `id` / `specialid` |

扫码状态：`0` 过期、`1` 等待扫码、`2` 待确认、`4` 授权成功（返回 `token`、`userid`）。

## 2. 签名与设备身份

- 所有请求带 `signature`，算法见 `util/helper.js`：
  `md5( salt + 排序后的参数拼接 + data + salt )`，Web 与 Android 两套盐 / 参数集；
- 还有 `signKey` / `signParamsKey` / `signCloudKey` 等变体；
- 设备身份：`mid`、`dfid`、`uuid`、`clienttime`，`/register/dev` 申请 `dfid`；取流接口不带 `dfid` 会返回「本次请求需要验证」；
- Android 与 Web 的 `appid` / `clientver` 不同，token 不通用（概念版 lite 再一套）。

## 3. C# 侧实现拆分

1. `KugouSignature`：移植 `helper.js` + `crypto.js`（MD5、排序、盐），单测固定向量；
2. `KugouDevice`：生成/持久化 `mid`、`uuid`、`dfid`，走 `/register/dev`；
3. `KugouLoginProvider`：`/v2/qrcode` 取 key → 生成二维码内容 → 轮询 `/v2/get_userinfo_qrcode`（0/1/2/4）→ 取 `token`/`userid` → 拉用户信息校验 → 加密保存；
4. `KugouProvider`：搜索、歌单详情、用户歌单、喜欢（酷狗「我喜欢」是用户歌单里的一类，需确认接口）、取流、歌词（`krc` 解码可复用现有 KRC 解码或移植 `decodeLyrics`）；
5. 账号面板加入 kugou，登录方式二维码 + Cookie 导入兜底；来源混合、分组、歌单页复用现有聚合逻辑。

## 4. 风险 / 待确认

- 取流依赖 `dfid` 与登录态，匿名可能返回空或 128kbps；
- 「喜欢歌曲」没有独立 like 接口，需要确认是「我喜欢」歌单追加（`/playlist/tracks/add`）还是收藏接口；
- KRC 歌词解码需要移植，或先返回 `lrc` 保证可用；
- 概念版 / 标准版 token 不通用，默认标准版。

## 5. 下一步

1. 抓取 `util/config.json`、`util/helper.js`、`util/crypto.js`、`util/util.js`，把盐值、appid、clientver 固化到 C#；
2. 先做 `KugouSignature` + `KugouDevice` + 搜索（最小闭环），用真机请求验证签名；
3. 再做二维码登录与用户歌单，最后接取流与歌词。

## 6. 真机验证记录（2026-11-08）

已跑通：

- **搜索**：`GET https://gateway.kugou.com/v2/search/song`，Android 签名 + 默认参数 + `x-router: complexsearch.kugou.com`，匿名返回真实结果。
- **二维码 key**：`GET https://login-user.kugou.com/v2/qrcode`，参数 `appid=1001&type=1&plat=4&qrcode_txt=...&srcappid=2919`，并且**必须**附上默认参数（`dfid/mid/uuid/clientver/clienttime`）与请求头（`mid/dfid/clienttime/kg-rc/kg-thash`），web 签名；返回 `qrcode` 与 `qrcode_img`（base64）。
- **扫码状态**：`GET https://login-user.kugou.com/v2/get_userinfo_qrcode`，参数 `plat=4&appid=1005&srcappid=2919&qrcode=<key>` + 默认参数 + 同款请求头；返回 `{"data":{"status":1}}`（1 等待、2 待确认、4 成功带 token）。

未跑通：

- 取流：`/v5/url` 返回 `err signature`；web `play/getdata` 返回 `30020` + SSA 风控；移动端 `getSongInfo` 无 `url`。需要 `register_dev`（AES+RSA）与 SSA 模拟，或改用本地 Node 侧车。
- npm 侧车：本机 npm 损坏（`Cannot find module ./selectors/root`），`npm install` 失败，暂无法用 Node 方案。

## 7. 应用内验证（2026-11-08 08:22）

- `GET /api/search?source=kugou&q=周杰伦&limit=5` → HTTP 200，5 条真实结果（首条《晴天》/周杰伦，id 为 hash 编码），耗时 114ms，日志 `GET kugou/search q=周杰伦 ok 5 tracks 114ms`；
- 结果 `playable=false`：取流仍被风控拦截；
- Web `wwwapi.kugou.com/yy/index.php?r=play/getdata` 带 `kg_mid`/`kg_dfid`/`kg_mid_temp` cookie 仍返回 `err_code=30020`（SSA），确认需要行为指纹或 register_dev 的 dfid；
- 结论：搜索/歌词/登录可用，**播放链路需要 SSA 模拟或本地 Node 侧车**。

## 8. 收藏同步（2026-11-09 落地）

酷狗没有独立的「收藏单曲」接口，「我喜欢」就是账号里的一张默认云歌单：

1. `POST /v7/get_all_list`（Android 签名 + `x-router: cloudlist.service.kugou.com`）列出全部云歌单；
   `data.info[]` 里 `name == "我喜欢"` 的那一项就是目标，`listid` 即歌单 id（本机实测为 3，
   但不同账号会不同，不能写死）。同一响应还包含「默认收藏」和用户自建/收藏歌单。
2. 歌单歌曲：`POST /v4/get_list_all_file`，body `{ listid, userid, token, type: 0, page, pagesize, ... }`。
   v3 端点（`/v4/get_list_all_file_v3`）现在会返回 `20028` 风控，必须用 v4。
3. 收藏：`POST /cloudlist.service/v6/add_song`，`data[]` 里带 `hash / timelen / album_id / mixsongid`
   和展示名；取消：`POST /v4/delete_songs`，`fileid` 来自歌单详情。
4. 设备身份：`mid` 仍是 GUID→MD5 十进制；`dfid` 必须带登录 token 调
   `POST https://userservice.kugou.com/risk/v3/r_register_dev`
   （AES-128-CBC 包设备 JSON，外层 RSAES-PKCS1-v1_5 包 `{aes, uid, token}`）。
   **匿名注册只会返回 `data: []`，拿不到 dfid**；因此扫码登录的正确顺序是
   「出码 → 扫码拿 token → 带 token 注册 dfid → 保存」。
5. 快捷登录换票：网页拿到的 token 是 Web 作用域，`get_all_list` 会返回 `20017`。
   用 `ThirdData` cookie 里的 `openid/access_token` 调
   `POST https://gateway.kugou.com/v6/login_by_openplat`（`partnerid=1`，
   `params` 为 AES-256-CBC 的 `{access_token}`，`pk` 为无填充 RSA 的
   `{clienttime_ms, key}`），响应 `secu_params` 解密后即为标准版 App token。

宿主侧实现：`KugouDevice`（设备持久化 + 注册）、`KugouOpenLogin`（快捷登录换票）、
`KugouLibraryProvider`（歌单/喜欢读写）、`KugouProvider`（搜索/歌词/取流）。播放、每日推荐、
最近播放、热门歌单与评论见 §9。

## 9. 播放与完整入口（2026-11-09 续）

旧结论「酷狗只能搜索/歌词」已过时：**注册 dfid + App token 后可以取流**。

- 取流：`GET /v5/url`，`key = md5(hash + '57ae12eb6890223e355ccfcb74edf70d' + appid + mid + userid)`，
  再带完整 `signature`。免费歌曲 `free_part=0` 返回整首；付费歌曲先返回 `status=2`，
  用 `IsFreePart=1` 重试可拿 60 秒试听（URL 路径 `/yp/p_0_...`）。
- 搜索/每日推荐/最近播放/公开歌单的封面都直接用上游完整图床地址
  （`Image` / `cover` / `sizable_cover` / `union_cover`，替换 `{size}`），不能再拿 AlbumID 拼
  `stdmusic/240/{albumid}.jpg`，否则大量歌曲会落到酷狗默认黑胶图。
- 每日推荐：`POST /everyday_song_recommend`（`x-router: everydayrec.service.kugou.com`）。
- 最近播放：`POST /playhistory/v1/get_songs`。
- 热门歌单：`POST /v2/special_recommend`；详情用 `GET /pubsongs/v2/get_other_list_file_nofilt`
  （`global_collection_id`）。
- 评论：`POST /mcomment/v1/cmtlist`（`mixsongid` 来自曲目 id 第 4 段）。
- 下载：复用取流；试听片段（`StreamResolution.IsTrial`）会被下载服务拒绝，避免存下 60 秒文件。

## 10. 登录态与歌单修复（2026-11-10）

实测 `get_all_list` 的 `data.info[]` 里 `listid` 是**数字**，`name` 是字符串，`pic` 是带 `{size}`
的图床 URL；`KugouLibraryProvider` 已兼容数字/字符串并归一化封面。

登录后空白的三层原因：

1. **dfid 与 token 绑定**：`KugouDevice` 以前只要本机有 dfid 就直接复用；换账号/重新扫码后
   新 token 配旧 dfid，`get_all_list` 返回 401/20017。现在扫码/网页登录都会 `force` 重新注册
   当前 token 的 dfid。
2. **登录成功但云歌单不可用**：`KugouLoginProvider.AuthorizeAsync` 在保存账号前直接拉一次
   `get_all_list`；状态不是 1 就把本次登录判为失败并提示重新扫码，避免 UI 显示「已登录」却空白。
3. **会话检测曾经硬编码有效**：`AccountVerifier` 以前对酷狗直接返回 valid；现在用
   `get_all_list` 真校验，20017/20018/401 会标记 expired 并清掉本地账号，网络异常则保持 unknown。

头像：`/v1/get_my_userinfo` 对部分 App token 返回 20006 时，会改用 GET query 重试，并从
`get_all_list` 的 `create_user_pic` 兜底，账号面板不再只剩单字占位。

本机 QQ 快捷登录：WebView2 是 Chromium，QQ 网页快捷登录依赖的本地插件无法加载，所以
`#qlogin_list` 不会出现。现在 `/api/account/quick-account` 额外返回 `localQq`，页面提示
「检测到本机 QQ，但内嵌浏览器不支持快捷登录，请扫码」，不再误报成「未登录 QQ」。
