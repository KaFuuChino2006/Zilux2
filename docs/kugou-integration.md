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
