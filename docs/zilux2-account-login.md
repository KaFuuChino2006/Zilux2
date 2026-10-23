# Zilux2 账号登录契约（Account v1）

> 状态：v1 草案（2026-10-18）· 关联：`docs/zilux2-online-music.md`（在线服务）、`docs/zilux2-host-contract.md`（消息桥）
> 目标：网易云音乐 / QQ 音乐**扫码登录**，登录态持久化；登录后按账号权益播放 VIP 曲目。

## 0. 先明确的事实（避免误解）

- 扫码登录只能让宿主以「你的账号」身份向平台请求；**VIP 曲目能否播放取决于该账号是否拥有对应会员权益**（网易云黑胶 VIP / QQ 音乐绿钻等）。没有会员权益的账号登录后，VIP 曲仍会返回不可播（前端给出明确提示）。
- 登录凭据（Cookie）只保存在本机 `%LOCALAPPDATA%\Zilux2\`，不上传任何服务器；日志里不打印 Cookie 值。
- 平台接口为公开 Web 接口，存在风控与变更风险；失败时前端要给出可读提示和「重新获取二维码」。

## 1. 宿主新增 HTTP 路由（全部要求 `?token=`，除 `/api/health`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/account` | 返回各源登录态：`{"sources":[{"source":"netease","loggedIn":true,"nickname":"…","avatarDataUrl":"data:image/png;base64,…","vip":true,"userId":"…"}]}`；未登录 `loggedIn:false` |
| POST | `/api/account/login/qr?source=netease\|qq` | 创建一次登录会话。网易云：`{"source":"netease","mode":"code","key":"<unikey>","content":"https://music.163.com/login?codekey=<unikey>","expiresIn":300}`；QQ：`{"source":"qq","mode":"image","key":"<sessionKey>","imageDataUrl":"data:image/png;base64,…","expiresIn":180}` |
| GET | `/api/account/login/status?source=&key=` | `{"state":"waiting\|scanned\|authorized\|expired\|refused\|error","message":"…","account":{…授权后同 /api/account 单项…}}`；前端每 1.5–2 s 轮询，`authorized/expired/refused/error` 为终态 |
| POST | `/api/account/logout?source=` | `{"ok":true}`，清除该源 Cookie 与账号态 |

错误 JSON 统一 `{"error":"code","message":"中文可读信息"}`。

## 2. 数据模型

```ts
type AccountSource = 'netease' | 'qq';
interface AccountInfo {
  source: AccountSource;
  loggedIn: boolean;
  nickname?: string;
  avatarDataUrl?: string;   // 已转 data URL，前端可直接 <img>
  vip?: boolean | null;     // null = 未知/平台未提供
  userId?: string;          // 网易云 userId / QQ uin
}
```

## 3. 持久化

- 路径：`%LOCALAPPDATA%\Zilux2\account.json`，UTF-8 无 BOM。
- Cookie 值使用 Windows DPAPI（`ProtectedData.Protect(CurrentUser)`）加密后 base64 存储；其余字段明文。
- 启动时加载并校验；损坏/无法解密 → 删除并视为未登录（日志 `[account] load failed`）。
- 退出登录立即删除该源条目并写盘；`[account] login|logout|save|load` 日志（不打印凭据）。

## 4. 网易云扫码流程（参考已知公开 Web 接口）

1. `GET https://music.163.com/api/login/qrcode/unikey?type=1` → `unikey`；
2. 二维码内容：`https://music.163.com/login?codekey=<unikey>`（前端用 QR 库渲染成图）；
3. `GET https://music.163.com/api/login/qrcode/client/login?key=<unikey>&type=1` 轮询：
   - `code=800` 过期；`801` 等待扫码；`802` 已扫码待确认；`803` 授权成功（响应 `Set-Cookie` 含 `MUSIC_U` 等）；
4. 授权后带 Cookie 请求 `https://music.163.com/api/nuser/account/get` 取昵称/头像/`userId`/VIP 信息；
5. 后续搜索、歌词、`/api/song/enhance/player/url` 一律带该 Cookie；`fee=1`（VIP）曲目是否可播以 player-url 返回的 `url` 是否为空为准，并回填 `playable`。

## 5. QQ 音乐扫码流程

1. `GET https://ssl.ptlogin2.qq.com/ptqrshow?appid=716027609&e=2&l=M&s=3&d=72&v=4&t=<rand>&daid=383&pt_3rd_aid=100497308` → PNG 图片 + `qrsig` Cookie；
2. 轮询 `GET https://ssl.ptlogin2.qq.com/ptqrlogin?...&ptqrtoken=<hash33(qrsig)>&...`（参数随当前 Web 端实现），返回 `ptuiCB('0','0','<跳转URL>','0','登录成功',...)` 即授权成功，同时写入 `uin`、`skey` 等 Cookie；
3. 用授权跳转 URL 走 `graph.qq.com` OAuth → `y.qq.com` 登录，换取 `qm_keyst` / `qqmusic_key` / `qqmusic_uin`；
4. 带上述 Cookie 请求 `https://u.y.qq.com/cgi-bin/musicu.fcg` 获取用户信息与 `vkey`；`vkey` 能取到 URL 即视为可播；
5. 登录态失效（vkey 获取失败/返回未登录）→ 标记未登录并提示重新扫码。

> QQ 侧参数与端点可能随官方 Web 端变化；实现时先以「扫码 → 登录成功 → 取到 vkey」端到端跑通为准，参数集中在 `QqLoginProvider` 一处便于后续调整。

## 6. 前端

- 入口：顶栏右侧头像按钮（未登录显示默认渐变头像 + 小圆点）。
- 弹层：`AccountModal`，两个 tab：网易云 / QQ 音乐。
  - 未登录：标题 + 二维码（网易云由 `qrcode` npm 库把 `content` 渲染到 canvas；QQ 直接展示 `imageDataUrl`）+ 状态文案（等待扫码 / 已扫码，请在手机上确认 / 登录成功 / 二维码已过期）+ 「刷新二维码」+ 倒计时。
  - 已登录：头像 + 昵称 + 会员标识（`vip`）+ 「退出登录」。
  - 网络/接口错误：可读提示 + 重试按钮。
- 登录成功后：刷新 `/api/account`，在线搜索/播放立即使用新凭据；VIP 曲目可播性以宿主返回的 `playable` 为准；对仍不可播的曲目 toast「该曲需要对应平台会员或已下架」。
- 浏览器预览（无宿主）：`?mock=1` 提供假登录流程（3 秒后成功），便于界面验收。

## 7. 验收清单（人工）

1. 未登录：VIP 曲目点击 → toast 提示，不播放；
2. 网易云扫码 → 手机确认 → 弹层显示昵称/头像 → 搜索并播放一首黑胶 VIP 曲（账号有会员时成功，无会员时仍明确提示）；
3. QQ 扫码 → 登录成功 → 播放 QQ 免费曲正常；绿钻账号播 VIP 曲成功；
4. 重启应用 → 账号仍为登录态（`account.json` 生效）；
5. 退出登录 → 立即回到未登录态，VIP 曲不可播；
6. 关闭账号弹层再打开、切换 tab、二维码过期后刷新均无卡死/无重复轮询。

## 8. 非目标

- 手机号 / 密码登录、短信验证码登录；
- 多账号同时在线 / 账号切换（先单账号每源）；
- 第三方账号绑定、歌单同步、下载、无损音质选择。

## 9. 实测补充：Cookie 粘贴导入（v1 实现记录）

> 本节只记录落地实现与实测事实，不改变 §1–§8 的契约。

- 端点：`POST /api/account/import?token=...`，body `{"source":"netease"|"qq","cookie":"<浏览器请求头里的 Cookie 值>"}`（≤16KB）；返回与 `GET /api/account` 相同的 `{"sources":[...]}`。错误统一 `{"error","message"}`：`invalid-cookie`（cookie 缺失/格式错/校验不通过，400）、`bad-request`（source/JSON 非法，400）、`account-unavailable`（503）。
- 校验策略：
  - 网易云：直接带 `Cookie` 请求 `https://music.163.com/api/nuser/account/get`，要求 `code=200` 且存在 `profile`/`account`，取 `userId`、`nickname`、`isVip`/`vipType`、`avatarUrl`（头像转 data URL，失败可空）。
  - QQ：cookie 必须含 `qm_keyst`/`qqmusic_key`（或 `skey`+`uin`），并至少能从 `qqmusic_uin`/`uin`/`p_uin`/`luin` 解析出 uin；随后用 **鉴权型** 接口验证：先 `music.UserInfo.userInfoServer/GetLoginUserInfo`，失败再 `music.musicasset.SongFavRead/GetSongFav`；任一 `req_1.code=0` 才视为有效。
  - 实测坑：`music.musicasset.PlaylistBaseRead/GetPlaylistByUin` **不是鉴权接口**——伪造 cookie 也能返回该 uin 的公开歌单（`req_1.code=0`），不能用于校验；伪造 cookie 时 `GetLoginUserInfo`/`GetSongFav` 均返回 `req_1.code=1000`，因此最终选用后两者。
  - 校验失败绝不影响已有登录态；只有校验通过才写入 `account.json`（DPAPI 加密，复用 §3）。
- Cookie 解析：按 `;` 拆分 `k=v`，跳过 `Path/Domain/Expires/Max-Age/Secure/HttpOnly/SameSite/Version/Priority` 等属性与空值；同名后者覆盖。导入后统一挂到平台域（网易云 `music.163.com`，QQ `qq.com`）以便 `music.163.com` / `c.y.qq.com` / `u.y.qq.com` 复用。
- 登录态生效：导入成功即刷新 `/api/account` 与搜索 playable；同时失效 `/api/library` 该源缓存；退出登录仍用 `POST /api/account/logout`，会一并删除导入的 cookie。
- 日志：成功 `[account] import source=... ok nickname=... userId=...`；失败 `[online] api account import failed source=... code=...`；请求行 `req POST /api/account/import status=...`；**任何日志都不包含 cookie 值与 token**。
- 冒烟（伪造 cookie）：17/17 通过——无 token 401、source/JSON 非法 400、缺 cookie 400、网易云伪造 400 `invalid-cookie`、QQ 缺会话键 400、QQ 伪造 400、GET 405、失败后不生成 `account.json`、日志无 cookie。真实账号的端到端导入仍待人工用浏览器 Cookie 验证（QQ 侧尤其，扫码链路只验到轮询）。
