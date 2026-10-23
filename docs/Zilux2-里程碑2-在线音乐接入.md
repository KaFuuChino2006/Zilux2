# Zilux2 里程碑 2 · 在线音乐接入（网易云 / QQ 音乐）

> 交付日期：2026-10-18 · 宿主 `v0.2.0-online` · 前端里程碑 `0.2`
> 本文档记录「接入 QQ 音乐与网易云」这一里程碑的实现范围、接口契约、验收证据、已知限制与下一步计划。
> 接口契约唯一标准见 [`docs/zilux2-online-music.md`](zilux2-online-music.md)。

## 1. 目标与范围

按用户指令（2026-10-18）：**执行第二目标，接入 QQ 音乐和网易云**。

本里程碑交付：

| 交付物 | 说明 |
| --- | --- |
| 宿主在线服务 | 内嵌回环 HTTP（`HttpListener`，仅 `127.0.0.1`，动态端口 + 一次性 token），转发网易云 / QQ 音乐搜索、歌词、播放地址、封面 |
| 前端在线模块 | 搜索面板（Ctrl+K / 顶栏点击，网易云 / QQ 双源切换）、播放条在线播放（流式音频 + 进度 + 音量）、同步歌词面板、封面异步加载、错误 Toast |
| 播放能力 | 在线曲目 206 Range 流式播放；VIP / 无版权曲目明确提示不可播放 |
| 歌词 | LRC 解析、翻译行合并、当前行高亮、点击行 seek |
| 验证 | `tools/online-selftest.ps1` 九组 53 项断言；真实宿主实机截图与日志 |

不在本里程碑内：账号登录 / VIP 解锁、逐字歌词（QRC/KRC/YRC）、试听 30 秒、歌单与收藏、3D 歌词舞台、3D 歌单架。

## 2. 运行方式

```powershell
# 构建前端 + 宿主（自动复制 web/dist 进输出目录）
pwsh -File tools\build.ps1

# 启动
.\src\Zilux2\bin\Debug\net10.0-windows10.0.19041.0\Zilux2.exe

# 在线服务自动验收（需 PowerShell 7）
pwsh -File tools\online-selftest.ps1
```

浏览器调试（无宿主时自动降级为演示数据，可用 `?mock=1` 显式演示）：

```bash
cd web
pnpm dev     # 打开 http://127.0.0.1:5173
# 直连宿主在线服务（跨端口调试）：?onlinePort=<port>&onlineToken=<token>
```

环境要求不变：.NET SDK 10.0.401、WebView2 Evergreen Runtime（本机 155.0.4283.60）、Node ≥ 22。

## 3. 架构

### 3.1 进程内在线服务

```
WPF 宿主（Zilux2.exe）
├─ OnlineMusicService         生命周期：生成 token → 启动 LocalMusicServer → page ready 后推 online 事件
│  ├─ NeteaseProvider         搜索（+ detail 补封面）/ 歌词 / 播放地址（320k 优先）
│  └─ QqProvider              搜索 / 歌词 / vkey（付费曲判定不可播放）
├─ LocalMusicServer           HttpListener 127.0.0.1:<随机端口>，路由 5 条，Range/206 透传
└─ WebView2
   └─ 前端  src/online/client.ts   fetch /api/*?token=…
```

- 端口与 token：宿主动态取端口；token 为 32 位十六进制一次性随机值，页面通过 `online` 事件获得。
- 安全边界：只绑定 `127.0.0.1`；除 `/api/health` 外必须带正确 `?token=`（否则 401）；日志不落 token；CORS 仅放行页面来源。
- 上游请求：默认 `UseProxy=false` 直连（本机系统代理会让 QQ 搜索返回空 body 的 500），可用 `ZILUX2_ONLINE_PROXY` 覆盖。
- 关键文件：`src/Zilux2/Online/`（6 文件，约 1,700 行）。

### 3.2 页面 ↔ 宿主契约

宿主 → 页面（扩展 `{type:'host'}` 事件）：

```json
{"v":1,"type":"host","event":"online",
 "apiBase":"http://127.0.0.1:65369","token":"<32hex>","sources":["netease","qq"]}
```

页面 → HTTP（全部同源 `fetch`，见契约 §4）：

| 路由 | 说明 |
| --- | --- |
| `GET /api/health` | 唯一免 token；返回 `{ok,version,sources}` |
| `GET /api/search?source=&q=&limit=` | 搜索；返回 `tracks[]`（含 `playable`、封面地址） |
| `GET /api/lyric?source=&id=` | LRC / 翻译；返回 `{lrc,translatedLrc}` |
| `GET /api/player-url?source=&id=` | 播放地址；VIP/无版权返回 403 `not-playable` |
| `GET /api/stream?source=&id=` | 音频流，支持 `Range` → 206；主播放路径 |
| `GET /api/cover?key=` | 封面代理（内存缓存，避免跨域与防盗链） |

### 3.3 前端在线模块（web/src）

| 文件 | 职责 |
| --- | --- |
| `online/types.ts` | `OnlineSource` / `OnlineTrack` / `OnlineSearchResult` / `SOURCE_LABEL` |
| `online/client.ts` | `searchOnline` / `fetchLyric` / `fetchPlayUrl` / `streamUrl` / `coverUrl` / `onlineReady`；统一 `OnlineError` |
| `online/lrc.ts` | LRC 解析（`[mm:ss.xx]`）、翻译合并（同时间戳配对）、`findActiveLine` 二分 |
| `online/artwork.ts` | 在线封面加载（失败回退程序化封面，缓存） |
| `ui/searchPanel.ts` | 搜索浮层：双源 Tab、防抖 280ms、方向键/Enter/双击、可播放徽标、加载/空/错误态、关闭还原焦点 |
| `ui/lyricsPanel.ts` | 歌词面板：拉 LRC、当前行高亮 + 已播行变暗、自动滚到中央、点击行 seek、翻译行 |
| `ui/player.ts` | 播放器双模式：本地演示（计时器）/ 在线（`<audio>` + `?token` 流地址）；进度、音量、上一首/下一首、循环、错误上报 |
| `ui/home.ts` | 接线：Ctrl+K 搜索、在线源徽标（演示数据 / 在线源已就绪）、播放时自动展开歌词、Toast |
| `styles/online.css` | 搜索面板 / 歌词面板 / Toast / 在线徽标样式 |

## 4. 验收证据

### 4.1 自动验收（宿主侧，`tools/online-selftest.ps1`）

```
53 passed / 0 failed
```

覆盖：health 免 token、错误 / 缺失 token 401、网易云搜索 200 且字段完整、QQ 搜索 200、歌词 200（含翻译字段）、免费曲 player-url 200、VIP 曲 403 `not-playable`、`/api/stream` Range 206 + `Content-Range`、封面 200、仅监听 127.0.0.1（`Get-NetTCPConnection`）、关窗后端口释放且无残留进程、日志不含 token。

### 4.2 实机联调（真实宿主 + WebView2）

| 证据 | 结果 |
| --- | --- |
| `[online] listening on 127.0.0.1:65369 sources=netease,qq` | 服务随宿主启动 |
| `[online] req GET /api/search status=200 441ms` | 搜索链路通（网易云「晴天」） |
| `[online] GET netease/lyric id=2652820720 ok lrcChars=970 44ms` | 歌词拉取并解析 |
| `[online] GET netease/player-url id=2652820720 ok 59ms` | 播放地址获取 |
| `[online] req GET /api/stream status=206 9137ms`（约 6.1 MB 后随关窗中止） | 音频流真实播放 |
| 截图 `research/shots/m2-host-*.png` | 首页在线徽标、搜索面板、搜索结果、播放中（自动展开歌词）、歌词面板、3440×1392 最大化 |

## 5. 已知限制与风险

- **VIP / 无版权曲目**：返回 403 `not-playable`，界面提示「该曲目需要 VIP / 无版权，暂不可播放」；无登录解锁、无试听片段（契约 §6 非目标）。
- **匿名上游接口**：依赖网易云 / QQ 公开接口，可能限流、变更或需 UA/Referer；已封装在 Provider 层，失败有统一错误与 Toast。
- **系统代理**：本机若配置系统代理且未设 `ZILUX2_ONLINE_PROXY`，上游可能走代理失败；宿主默认直连。
- **歌词精度**：仅 LRC 行级（含翻译），无逐字时间轴；QRC/KRC/YRC 逐字在后续里程碑。
- **QQ 音质**：免费曲通常为标准 MP4/AAC；VIP 与部分版权曲不可播。
- **无账号体系**：不保存登录态、不做云歌单。

## 6. 下一步计划

1. **播放页 + 3D 歌词舞台**：全屏播放页、逐字歌词（QRC/KRC/YRC 解析 + 假名/翻译）、Canvas2D 光栅 + Three.js 曲面贴图。
2. **3D 歌单架**：InstancedMesh + 图集 + 窗口化渲染；歌单/收藏数据本地化。
3. **媒体接入**：媒体库扫描、封面取色、SMTC / 系统媒体键、WASAPI 回环频谱。
4. **视觉与体验**：首页在线内容化（推荐/歌单）、加载骨架、错误重试、性能护栏（帧闸门 / 像素预算 / 深后台）。
