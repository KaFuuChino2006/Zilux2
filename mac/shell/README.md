# Zilux2 macOS 测试版 · Electron 壳（mac/shell）

Zilux2 的 macOS（Apple Silicon）测试版宿主。壳本身只做四件事：

1. 用 Electron 承载与 Windows 版**完全相同**的 web 前端（`web/dist`，源码零改动）；
2. 模拟 Windows WebView2 的 `window.chrome.webview` 宿主桥，让页面以为自己在 WPF 里跑；
3. 用子进程拉起 .NET 引擎（同源 HTTP：在线音乐 API + 静态页面），拿到随机端口后加载页面；
4. 提供 Windows 版宿主的窗口控制 / 设置持久化 / 字体列表 / AirPlay 空实现等宿主能力。

mac 版按产品要求**删除 AirPlay（投送）**：入口隐藏、`airplay` 消息统一回 `idle`。

> 当前状态：Windows + Electron 33.2.1 + 真引擎端到端验收 10/10 通过（见「Windows 联调证据」）。
> macOS 真机尚待验证的部分见「已知限制」。

---

## 1. 目录

```
mac/shell/
├── package.json              Electron 应用清单（main: main.js；无第三方依赖）
├── main.js                   主进程：引擎 spawn、桥协议、设置/窗口持久化、页面注入补丁
├── preload.js                注入 window.chrome.webview（postMessage / addEventListener）
├── README.md                 本文档
├── dev/                      联调工具（不随包发布）
│   ├── cdp-run.mjs           CDP 验收驱动：启动 Electron、执行 steps、截图 + report.json
│   ├── steps/smoke.mjs       端到端验收步骤（首页→播放→歌词→房间→窗口）
│   ├── steps/protocol.mjs    宿主桥协议专项（settings/fonts/airplay/window/local/未知消息）
│   ├── steps/settings-write.mjs / settings-read.mjs   设置跨重启持久化
│   ├── steps/discover.mjs    DOM/桥快速探测
│   ├── static-server.mjs     极简静态服务器（无依赖，服务 web/dist）
│   ├── stub-engine.mjs       桩引擎：实现同款 READY 契约 + 假 API/假 WAV，无引擎时联调壳
│   └── probe-engine.mjs      不经过 Electron，直接按契约校验引擎
└── scripts/
    ├── assemble-win-test.sh  组装 mac/build/win-test/resources/app（Windows 联调用）
    ├── test-mac-layout.sh    验证「mac 打包布局」路径解析（Resources/{app,web,engine}）
    └── test-mock-url.sh      验证 ZILUX2_URL + ZILUX2_MOCK 逃生通道（不启引擎）
```

---

## 2. 架构

```
┌──────────────────────────── Electron 主进程 (main.js) ────────────────────────────┐
│  1. 解析路径：engine / webRoot / userData                                         │
│  2. spawn 引擎：Zilux2MacEngine --web-root <webRoot>（stdio: pipe/pipe/pipe）     │
│  3. 读 stdout 的 ZILUX2_READY 行 → 得到 {port, token, sources}                     │
│  4. BrowserWindow.loadURL('http://127.0.0.1:<port>/index.html')                   │
│  5. 页面 ready 后回：ready → online → settings → fonts → airplay(idle)            │
│  6. 处理页面消息：window / settings / fonts / media / log / local / audio / drag  │
└───────────────┬───────────────────────────────────────────────┬───────────────────┘
                │ IPC (webview:post / webview:message)           │ child_process
        ┌───────▼────────┐                              ┌────────▼──────────────────┐
        │ preload.js     │                              │ .NET 引擎（同源 HTTP）     │
        │ 模拟            │                              │  /api/*  +  /index.html   │
        │ chrome.webview │                              │  /assets/*（web/dist）    │
        └───────┬────────┘                              └────────┬──────────────────┘
                │ window.chrome.webview                          │ HTTP（同源，无 CORS）
        ┌───────▼────────────────────────────────────────────────▼──────────────────┐
        │ 页面（web/dist 原样）：向 127.0.0.1:<port> 请求 API，<audio> 由 Chromium 播 │
        └────────────────────────────────────────────────────────────────────────────┘
```

要点：

- **页面与 API 同源**：都由引擎在 `127.0.0.1:<port>` 提供，不存在 CORS / 混合内容 / 证书问题；
- **音频输出**：页面用 `new Audio()`（`web/src/ui/player.ts`）播放引擎的 `/api/stream`，Chromium 自带解码与输出，宿主**不需要**做音频输出；
- **宿主 `audio` 消息**（Windows 版用于抓 PCM 做投送）：mac 版收到直接 no-op（投送已删）；
- **单实例**：默认单实例锁；测试时可用 `ZILUX2_ALLOW_MULTI_INSTANCE=1` 关闭。

---

## 3. 引擎契约（与 mac-engine 约定，勿改）

- 可执行文件：
  - macOS：`Zilux2MacEngine`（arm64）
  - Windows 联调：`Zilux2MacEngine.exe`（win-x64，`mac/engine/publish/win-x64/`）
- 启动参数：`--web-root <webRoot>`（必需；引擎用该目录同时服务静态页面）
- 启动成功后 stdout 打印**一行**：

  ```
  ZILUX2_READY {"port":12345,"token":"<hex>","sources":["netease","qq","kugou"]}
  ```

- **stdin 必须保持打开**：引擎读到 stdin EOF 或 `quit`/`exit` 会优雅退出，所以 spawn 用
  `stdio: ['pipe','pipe','pipe']` 且**不主动 end**（壳退出时才写 `quit\n` + `end()`）。
- 启动失败：stderr 打印 `ZILUX2_ERROR {json}` 并以非 0 退出；壳会把该行带进错误提示。
- 优雅退出：SIGTERM / SIGINT / SIGHUP / stdin quit 均可；壳先 `quit`，3 秒未退再强杀（Windows 用 `taskkill /T /F` 杀整棵进程树）。
- 就绪超时：20 秒（`startEngine` 内 `ZILUX2_READY` 等待）。

---

## 4. 页面桥协议（`preload.js` + `main.js`）

页面侧只用两个通道（与 Windows WebView2 习惯一致）：

```js
window.chrome.webview.postMessage({ v: 1, type: '...' });           // 页面 → 宿主
window.chrome.webview.addEventListener('message', (e) => { ... }); // 宿主 → 页面，e.data 是对象
window.chrome.webview.removeEventListener('message', fn);
```

### 4.1 页面 → 宿主

| type | 载荷 | 壳的处理 |
| --- | --- | --- |
| `ready` | `{v:1,type:'ready'}` | 依次回发 ready → online → settings → fonts → airplay（顺序与 Windows `WebViewHost.cs` 一致） |
| `settings` | `action:'request'/'patch'/'reset'`，patch 带 `patch:{general?,appearance?,playback?}` | 读写 `userData/settings.json` 后回 settings 快照 |
| `fonts` | `{v:1,type:'fonts'}` | 回 `{v:1,type:'host',event:'fonts',payload:{families:[...]}}`（mac 字体优先，25 个） |
| `window` | `action:'minimize'/'toggleMaximize'/'close'/'chromeColor'` | 窗口操作；`chromeColor` 校验 `#rrggbb` 后 `setBackgroundColor` |
| `drag` | `{v:1,type:'drag'}` | **no-op**（mac 用注入 CSS `-webkit-app-region: drag` 实现拖拽） |
| `resize` | `{v:1,type:'resize',edge}` | no-op（Electron 原生可拖边，mac 用 `hiddenInset`） |
| `media` | `{v:1,type:'media',payload:{durationMs,positionMs,playing,...}}` | 限流写 `shell.log`（`[media] ...`，≤1 条/秒，QA 证据用） |
| `audio` | `{v:1,type:'audio',...}` | **no-op**（mac 无投送，不需要 PCM） |
| `airplay` | `action:'scan'/'stopScan'/'connect'/'disconnect'/'volume'/'pin'` | 一律回 `{v:1,type:'host',event:'airplay',payload:{state:'idle',...}}` |
| `local` | `action:'pick'/'restore'` | 测试版不接本地曲库，回 `{v:1,type:'host',event:'localCancel'}` |
| `log` | `{v:1,type:'log',level,message}` | 转发到 `shell.log` |

### 4.2 宿主 → 页面

| 消息 | 说明 |
| --- | --- |
| `{v:1,type:'ready',version,maximized}` | 页面初始化完成握手 |
| `{v:1,type:'host',event:'online',payload:{port,token,sources}}` | 在线源端点；页面会打印 `[online] host ready port=<port>` 并开始请求 `/api/sources` |
| `{v:1,type:'host',event:'settings',version:1,state:{...}}` | 设置快照。**顶层 `state` 是页面真正读取的字段**；壳同时冗余带 `payload.settings` 兼容旧读取方式 |
| `{v:1,type:'host',event:'fonts',payload:{families:[...]}}` | 字体列表（默认 PingFang SC / Hiragino Sans GB / Heiti SC / Songti SC / Kaiti SC / Noto Sans CJK SC …） |
| `{v:1,type:'host',event:'airplay',payload:{state:'idle',devices:[],active:null,actives:[],...}}` | 投送空状态（页面收到 idle 会清空设备列表） |
| `{v:1,type:'host',event:'window',action:'maximized',maximized:bool}` | 窗口最大化状态变化（resize/move 也会记 window.json） |
| `{v:1,type:'host',event:'localCancel'}` | 取消本地曲库选择 |

> 协议细节以 `web/src/core/bridge.ts`、`web/src/online/client.ts`、`web/src/core/settings.ts`、
> `web/src/ui/textSettingsPanel.ts`、`src/Zilux2/WebViewHost.cs` 为准，本文档是实现端备忘。

---

## 5. 设置与窗口状态持久化

- 目录：`app.getPath('userData')`，mac 上是 `~/Library/Application Support/Zilux2/`（Windows 联调默认 `%APPDATA%\Zilux2`，可用 `ZILUX2_USER_DATA` 覆盖）。
- `settings.json`：字段与 `web/src/core/settings.ts` 的 `Settings`/`DEFAULT_SETTINGS` **完全一致**：

  ```jsonc
  {
    "version": 1,
    "general": { "splash": true, "startMaximized": false },
    "appearance": { "theme": "frost", "reduceMotion": false, "glow": true, "heroAutoRotate": true, "lyricsSize": "medium" },
    "playback": { "defaultSource": "netease", "searchLimit": 20, "lyricsAutoOpen": true, "idleLyrics": true, "audioReactive": true, "volume": 0.72, "quality": "high" }
  }
  ```

  读取时白名单归一（非法枚举回落默认、volume 夹 0~1、searchLimit 只认 10/20/30、bool 严格），写盘 300ms 防抖 + 临时文件 rename 原子替换。
- `window.json`：`{width,height,x,y,maximized}`，400ms 防抖；启动时校验坐标是否落在可见屏幕内，防止外接屏拔掉后窗口跑出屏幕。
- 启动最大化：`settings.general.startMaximized === true`（或上次是最大化）时窗口以最大化启动。
- `shell.log`：宿主日志（stdout 同步一份），超过 2MB 自动轮转到 `shell.log.1`；页面 console 也转发进来（`[page:console:warn] ...`，便于无 DevTools 排查）。

---

## 6. 页面注入补丁（不改 web/ 源码）

`main.js` 在 `dom-ready` 后用 `executeJavaScript` 注入一段自包含脚本：

1. **拖拽**：给 `.topbar` / `header` / `.titlebar` 设 `-webkit-app-region: drag`；按钮/输入框/rail/播放条/`.win-btns` 等设 `no-drag`，避免「拖窗口时点不到按钮」。
2. **删除 AirPlay 入口**：用 `MutationObserver` 监听 DOM，凡文本/`aria-label` 为「投送」或 `AirPlay` 的元素、以及 `.airplay-view` 一律 `display:none !important` + `aria-hidden`。这是动态生效的（快捷设置里的 tab、设置页的 `投送` 区块都会被隐藏），已用 CDP 验证三处入口可见数均为 0。
3. 幂等：脚本带 `__zilux2Patch` 标记，重复注入不会重复挂 observer。

窗口形态：
- macOS：`titleBarStyle: 'hiddenInset'` + `trafficLightPosition: {x:16, y:16}`（页面顶部自带留白，红绿灯落在左上角品牌旁边）；
- Windows 联调：`frame: false`（页面自带 minimize/maximize/close 按钮，与 Windows 版一致）。

---

## 7. 路径解析顺序

| 资源 | 顺序（命中即用） |
| --- | --- |
| 引擎 | `ZILUX2_ENGINE` → `<resources>/engine/Zilux2MacEngine` → `<app>/engine/…` → `<app>/../engine/…` → 仓库 `mac/engine/publish/{osx-arm64|win-x64}/…` |
| web 根目录 | `ZILUX2_WEB_ROOT` → `<resources>/web` → `<app>/web` → `<app>/../web` → 仓库 `web/dist`（目录需有 `index.html`） |
| userData | `ZILUX2_USER_DATA` → `app.getPath('userData')` |

其中 `<resources>` = `process.resourcesPath`（mac 打包后是 `Zilux2.app/Contents/Resources`），
`<app>` = 应用代码目录（`main.js` 所在目录），仓库根由 `<app>/../..` 推断。

### 打包布局（与 `mac/packaging/assemble.py` 一致）

```
Zilux2.app/Contents/Resources/
├── app/
│   ├── package.json
│   ├── main.js
│   └── preload.js
├── web/                     # web/dist 的全部内容（index.html、assets/、fonts/）
└── engine/
    ├── Zilux2MacEngine      # chmod +x
    └── …（其余 .NET 发布文件）
```

`resources/app` 不需要 `node_modules`（壳零依赖）；Electron 会自动把 `Resources/app` 当应用入口。

---

## 8. 运行方式

### 8.1 macOS（打包后）

```bash
# 假设已按上面的布局组装好 Zilux2.app
chmod +x "Zilux2.app/Contents/Resources/engine/Zilux2MacEngine"
xattr -dr com.apple.quarantine "Zilux2.app"     # 未签名/未公证的测试包首次运行需要
open "Zilux2.app"
```

开发时也可直接跑：`/path/to/Electron.app/Contents/MacOS/Electron mac/shell`（仓库里的 `web/dist` 与 `mac/engine/publish/osx-arm64` 会被自动找到）。

### 8.2 Windows 联调（本仓库已连过）

```bash
# 1) 组装 resources/app（shell 三件套 + web/dist + win-x64 引擎）
bash mac/shell/scripts/assemble-win-test.sh

# 2) 端到端验收（启动 Electron + CDP 跑 steps，截图/报告写到 mac/build/win-test-shots/）
node mac/shell/dev/cdp-run.mjs

# 3) 只看窗口（不跑 steps）
mac/build/win-test/electron.exe "mac/build/win-test/resources/app"
```

> 环境提示：本机 bash 里 Node 需用绝对路径
> `C:/Users/13329/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe`（≥ v22，自带 WebSocket）；
> 另外本机全局设置了 `ELECTRON_RUN_AS_NODE=1`，直接跑 `electron.exe` 前要删掉该变量（`cdp-run.mjs` 已处理）。

### 8.3 不启引擎的联调（逃生通道）

```bash
# 静态服务器直接服务 web/dist，页面用 mock 数据，验证壳/桥/窗口
node mac/shell/dev/static-server.mjs --root web/dist --port 9347 &
ZILUX2_URL=http://127.0.0.1:9347/index.html ZILUX2_MOCK=1 node mac/shell/dev/cdp-run.mjs
# 或：ZILUX2_ENGINE=mac/shell/dev/stub-engine.mjs（桩引擎，实现同款 READY 契约）
```

### 8.4 环境变量

| 变量 | 作用 |
| --- | --- |
| `ZILUX2_ENGINE` | 覆盖引擎路径；指向 `.mjs`/`.js` 时用 `ELECTRON_RUN_AS_NODE` 以脚本方式跑 |
| `ZILUX2_WEB_ROOT` | 覆盖 `--web-root` 传给引擎的静态目录 |
| `ZILUX2_USER_DATA` | 覆盖 userData（settings.json / window.json / shell.log 都在这） |
| `ZILUX2_URL` | 直接加载 URL，跳过引擎（联调用） |
| `ZILUX2_MOCK=1` | 页面 URL 追加 `?mock=1`（配合内置演示数据） |
| `ZILUX2_ALLOW_MULTI_INSTANCE=1` | 关闭单实例锁 |
| `ZILUX2_EXIT_ON_ERROR=1` | 启动失败时不弹错误框，直接退出（便于 CI/脚本） |

CDP 驱动（`dev/cdp-run.mjs`）另有：`ELECTRON_EXE`、`APP_DIR`、`OUT_DIR`、`USER_DATA`、`CDP_PORT`（默认 9335）、`STEPS`、`KEEP_OPEN=1`。

---

## 9. Windows 联调证据（真引擎 + Electron 33.2.1）

命令：`bash mac/shell/scripts/assemble-win-test.sh && node mac/shell/dev/cdp-run.mjs`
结果：**10/10 steps PASS，0 console error，0 exception，0 warning**；截图与逐步返回值在
`mac/build/win-test-shots/`（`report.json` 含每步 value、console 明细、宿主 shellOutput）。

| 步骤 | 结论 |
| --- | --- |
| 01-boot | 页面 origin=`http://127.0.0.1:<随机端口>`、`window.chrome.webview` 存在、10 个 `/api/*` 请求全部同源、最近播放 10 条、title=Zilux2 |
| 02-home-rendered | 首页真实数据（今日推荐/我的红心收藏 5221 首/最近播放/热门歌单），rail 含 8 个入口，`.win-btn` 3 个；投送入口可见数 0 |
| 03-airplay-hidden-dynamic | 快捷设置 tabs=[封面,歌词,设置,投送]、设置页 2 处「投送」：**可见数均为 0**（MutationObserver 隐藏生效），关面板后无残留 |
| 04-window-controls-peek | 顶部 peeking 后窗口按钮可见（最小化/最大化/关闭，34×34），页面顶部按钮可用 |
| 05-play-recent | 点最近播放 → `<audio>` 真播放：标题/歌手/来源显示，`0:03` 前进、进度条 1.53%、封面走 `/api/cover?...` |
| 06-playback-advanced | 时间继续前进（0:03→…），`/api/stream/info` 请求出现，媒体位置持续上报（`[media] playing=true positionMs=…` 15 条） |
| 07-open-lyrics | 歌词页打开：53 行日文歌词+翻译、封面模糊背景、进度 0:09 |
| 08-room-effect | 播放效果=房间：`.lyrics-stage.is-room.is-painted`，2D canvas 1440×900 **出图**（薄荷绿隧道+飘浮歌词） |
| 09-window-controls-messages | 页面发出 `{type:'window',action:'minimize'}`；toggleMaximize 两次真实生效 1440×900 ↔ 3440×1392 |
| 10-console-check | bridge 三方法齐全，UA 含 `Zilux2/1.0.0 Chrome/130 Electron/33.2.1` |

宿主 shell.log 关键证据：`[online] host ready port=<port> sources=netease+qq+kugou`、
`[settings] request/patch/reset`、`[fonts] sent 25 families`、`[window] chromeColor #f3f1ea`、
`[media] playing=true state=- positionMs=… title=…`。

另外验证过：

- 协议专项 `STEPS=mac/shell/dev/steps/protocol.mjs`：10/10（settings 快照/patch/非法值归一/reset、fonts、airplay idle、chromeColor、drag/resize/media/audio no-op、localCancel、未知消息不崩）。
- 设置跨重启持久化：`settings-write.mjs` → 重启 → `settings-read.mjs` 3/3（含 `startMaximized=true` 时窗口真最大化）。
- macOS 打包布局：`bash mac/shell/scripts/test-mac-layout.sh` → 7/7 PASS，日志 enginePath=`…/resources/engine/Zilux2MacEngine.exe`、webRoot=`…/resources/web`。
- mock 逃生通道：`bash mac/shell/scripts/test-mock-url.sh` → 7/7 PASS（不启引擎）。

---

## 10. 已知限制 / 待验证

1. **平台验证范围**：全部端到端是在 Windows + Electron 33.2.1 + win-x64 引擎上完成的；macOS arm64 真机未跑（引擎 arm64 构建、`hiddenInset` 红绿灯位置、`-webkit-app-region` 在 mac 上的手感、Gatekeeper/公证均待真机确认）。
2. **AirPlay 已删**：入口隐藏 + 消息回 idle；页面自身 `audioTap` 的 PCM 取流链路不会真的送流（宿主 `audio` no-op）。房间/文字效果的频谱分析走页面内 Web Audio `AnalyserNode`（`web/src/core/audioTap.ts`），不依赖宿主，已验证房间能出图。
3. **启动竞态 warning（web 端固有）**：页面 `mount()` 里先 `bootData()/showHome()`、后 `host ready`，所以首屏偶发 3 条 `[app] … 在线源尚未就绪` 的 `console.warn`（Windows 版同样存在，非 mac 壳引入）；随后 `afterOnlineReady()` 会重新加载成功。**不是 error，不影响功能。**
4. **CSP 安全 warning**：`web/dist` 无 CSP meta，Electron 未打包运行时会打一条 `Electron Security Warning (Insecure Content-Security-Policy)`；打包后不出现。壳不能改 `web/`，未注入 CSP（会破坏页面内联/动态资源）。
5. **签名/公证**：测试包未签名、未公证；分发到其他 Mac 需要 `xattr -dr com.apple.quarantine`，正式发布需 Developer ID 签名 + notarization。
6. **引擎启动失败的用户体验**：弹 `dialog.showErrorBox` + 简单错误页（含引擎路径/ZILUX2_ERROR/stderr 尾部），测试版可用，未做重试/重启按钮。
7. **窗口/设置只写 userData**：与 Windows 版各自的配置文件不互通（mac 独立一套，字段格式一致）。
8. **媒体键/系统 Now Playing**：未接 macOS Now Playing（`MPNowPlayingInfoCenter`）；页面自身 media 消息只记日志。
9. **单实例**：默认单实例锁；`ZILUX2_ALLOW_MULTI_INSTANCE=1` 可关（CDP 联调在用）。

---

## 11. 排查

- 先看 `~/Library/Application Support/Zilux2/shell.log`（Windows 联调：`%APPDATA%\Zilux2\shell.log` 或 `ZILUX2_USER_DATA` 指定目录）：
  - `[boot] enginePath=… webRoot=…`：路径解析结果，最常用来定位「找不到引擎/页面白屏」；
  - `[engine] spawn …` / `[engine] ready port=…`：引擎是否起来；
  - `[page] load http://127.0.0.1:<port>/index.html`：页面地址；
  - `[online] endpoint sent to page port=…`：宿主→页面 online 消息已发；
  - `[page:console:error]` / `[page:console:warn]`：页面 console 转发。
- 页面白屏：确认 `[page] load` 的 URL 能访问（浏览器打开 `http://127.0.0.1:<port>/index.html`），以及 `webRoot` 里有 `index.html`。
- 「引擎提前退出 code=0」：spawn 时 stdin 被关（EOF），检查是否误用 `stdio:'ignore'`。
- Electron 起不来但报 `bad option: --remote-debugging-port`：环境里残留 `ELECTRON_RUN_AS_NODE=1`，删掉再启动。
- 端口随机：每次启动引擎端口不同，别硬编码；一律从 `ZILUX2_READY` 行取。
