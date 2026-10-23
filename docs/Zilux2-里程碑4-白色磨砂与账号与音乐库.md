# Zilux2 里程碑 4 — 白色磨砂 · 扫码登录 · 个人音乐库 · 3D 歌单详情

> 2026-10-18 / 交付范围：设计体系切换、账号登录、个人库首页、3D 歌曲墙；用户自测验收。

## 1. 交付内容

### 白色磨砂设计体系（v2）
- `docs/zilux2-design-system.md`：全站从深色极光切换为白色磨砂（light frosted glass）：`--bg #f6f7fb`、`--glass rgba(255,255,255,.62)`、blur(22px) saturate(150%)、深墨文字 `#171a21`、主色 `#6a5cff / #2fa8e8 / #e263a1`。
- 覆盖：标题栏 / 左侧导航 / 顶栏 / 首页 Hero / 卡片 / 播放条 / 搜索面板 / 歌词面板 / 设置面板 / 账号弹层 / 启动页 / 3D 封面环。
- 设置「外观 → 界面主题」只保留「白色磨砂」；旧深色/极夜数据归一化回落。

### 扫码登录（Account v1）
- 宿主新增 `src/Zilux2/Online/Account/`：`AccountService`、`NeteaseLoginProvider`（unikey 二维码 + 轮询 800/801/802/803）、`QqLoginProvider`（ptqrshow/ptqrlogin + y.qq.com 换 keyst + musicu vkey）、`AccountStore`（DPAPI 加密存 `%LOCALAPPDATA%\Zilux2\account.json`）。
- 路由：`GET /api/account`、`POST /api/account/login/qr`、`GET /api/account/login/status`、`POST /api/account/logout`、`POST /api/account/import`（Cookie 粘贴兜底）。
- 前端：设置 →「账号」分类，双平台卡片（二维码 / 已登录头像昵称会员徽标 / 退出）；扫码失败时可粘贴浏览器 Cookie 导入。
- 登录后 VIP 曲目是否可播取决于账号权益；宿主以平台实际返回的播放地址为准（无权限仍 403）。

### 个人音乐库（Library v1）
- 宿主新增 `src/Zilux2/Online/Library/`：网易云（`/api/user/playlist`、`playlist/detail`、`song/detail`）与 QQ（PlaylistBaseRead / SongFavRead / DissInfo）双源聚合，5 分钟缓存，登录/退出失效。
- 路由：`GET /api/library/overview`、`GET /api/library/playlist?source=&id=&offset=&limit=`
- 首页第一屏改为「我的音乐」：两平台分组（「我喜欢的音乐」大卡 + 自建歌单卡片），未登录显示登录引导；原 3D 封面环 Hero 下移为「发现」区。

### 3D 歌单详情（歌曲墙）
- 引擎 `web/src/three/songGrid.ts`：每首歌一张封面立方体（网格/竖排两种布局、悬停凸显其余淡出、点击放大聚焦、LRU 纹理池 + 图集 + 像素预算）。
- 页面 `web/src/ui/songGridPage.ts`：2D 卡片 → 全屏 3D 页面过渡（`enterFrom` / `leaveTo`）、右侧白磨砂歌词面板、分页加载、键盘与播放器联动。
- 入口：首页任意歌单/「我喜欢的音乐」卡片；QA `?panel=grid&mock=1`。

## 2. 验证

- `pnpm build`（tsc strict + vite）通过；宿主 `dotnet build` 0 警告 0 错误。
- 宿主登录冒烟 27/27、Cookie 导入冒烟 17/17、音乐库冒烟 22/22、在线音乐 57/57（均为开发期自测；按用户要求最终验收由用户自测）。
- 真实账号扫码/Cookie 导入未端到端验证（需人工浏览器操作）。

## 3. 已知限制

- 扫码登录受平台风控影响，失败时使用 Cookie 粘贴导入兜底。
- 导入的 Cookie 有平台有效期，失效后需重新导入。
- 3D 歌曲页中「再次点击同一立方体退出聚焦」依赖引擎事件语义，点空白由页面补同步。
- VIP 播放能力取决于账号权益，非登录即送会员。

## 4. 下一步

沉浸播放页（3D 歌词舞台）、PV 播放画面、桌面歌词/壁纸模式。
