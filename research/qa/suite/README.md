# Zilux2 真机 QA 套件（research/qa/suite）

把 `research/tmp/` 里一次性 CDP 脚本固化成可重复回归：连真实的安装版应用（WebView2 + CDP 9223），
用页面内 JS 触发交互、读 DOM / localStorage / `host.log` 做断言，失败自动留截图 + DOM 快照 + 证据 JSON。

- 无 npm 依赖，只用 Node 24 自带的 `WebSocket` / `fetch` / `node:http`。
- 脚本与 cwd 无关：仓库根由 `import.meta.url` 反推（`research/qa/suite/lib` 上溯 4 级）。
- 所有套件都是独立进程，`run-all.mjs` 顺序执行并汇总；退出码 0 = 全绿，1 = 有失败。

---

## 1. 前置条件

1. Windows 10/11，已安装 Zilux2（安装版，默认 `%LOCALAPPDATA%\Programs\Zilux2\Zilux2.exe`）。
2. 启动应用时带 CDP 端口（**不要**用普通方式启动，否则没有 9223）：

   ```bat
   set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223
   start "" "%LOCALAPPDATA%\Programs\Zilux2\Zilux2.exe"
   ```

   或者一行版：

   ```bat
   cmd /c start "" cmd /c "set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223&& \"%LOCALAPPDATA%\Programs\Zilux2\Zilux2.exe\""
   ```

3. 校验端口：`curl http://127.0.0.1:9223/json/list`，应有 `url` 以 `https://zilux2.local` 开头的 `page`。
4. Node：`C:\Users\13329\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`（v24+）。
   下文 `node` 指该可执行文件。

> 本环境禁止用管道捕获 GUI 相关子进程输出：套件/`run-all` 对 Node 子进程一律用 `stdio:'inherit'`，
> 不要改成 `pipe`。

## 2. 运行

```bash
# 全部套件（推荐）
node research/qa/suite/run-all.mjs

# 只跑部分（位置参数或环境变量二选一）
node research/qa/suite/run-all.mjs smoke room-effects
ZILUX2_ONLY=smoke,local-watch node research/qa/suite/run-all.mjs

# 单个套件（排障时最常用）
node research/qa/suite/smoke.mjs
node research/qa/suite/room-effects.mjs
node research/qa/suite/downloads.mjs
node research/qa/suite/local-watch.mjs
node research/qa/suite/update-channel.mjs
```

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ZILUX2_CDP_HTTP` | `http://127.0.0.1:9223` | CDP HTTP 端点 |
| `ZILUX2_CDP_TIMEOUT_MS` | `15000` | 单次 CDP 调用超时 |
| `ZILUX2_SHOTS_DIR` | `<仓库根>/research/shots/suite-YYYYMMDD` | 截图 / 证据 / 结果目录（`run-all` 统一注入） |
| `ZILUX2_HOST_LOG` | `%LOCALAPPDATA%\Zilux2\logs\host.log` | 宿主日志路径 |
| `ZILUX2_LOCAL_FIXTURE_DIR` | `<仓库根>/research/tmp/qa-fixture` | 本地曲库测试夹具（2 个 mp3） |
| `ZILUX2_WATCH_DIR` | `<仓库根>/research/qa/suite/tmp-local-watch` | local-watch 测试目录（结束后自动删除） |
| `ZILUX2_LOCAL_WATCH_TIMEOUT_MS` | `8000` | local-watch 验收上限（产品要求 ≤8s） |
| `ZILUX2_SEARCH_KEYWORD` | `晴天` | downloads 套件搜索关键词 |
| `ZILUX2_DOWNLOAD_TIMEOUT_MS` | `90000` | 等下载任务落到 done 的上限 |
| `ZILUX2_QA_CLICK_REVEAL` | 未设置 | 设为 `1` 才真的点 `.dlq-reveal`（会弹资源管理器） |
| `ZILUX2_EXPECT_HOST_VERSION` | `1.1.6` | tray-and-downloads 断言的宿主版本（`host.start version=`）；换构建时改这一处（或临时用环境变量覆盖） |

## 3. 输出与产物

所有产物都在一个日期目录里（位置由脚本自身路径计算，**与 cwd 无关**）：

```
research/shots/suite-YYYYMMDD/
├── <suite>-*.png              # 正常步骤截图
├── <suite>-fail-*.png         # 失败步骤截图
├── evidence/<suite>-<step>.json  # 失败证据：DOM 快照 + console 错误 + host.log 尾部
└── results/<suite>.json       # 每个套件的 PASS/FAIL/SKIP 明细（run-all 汇总的数据源）
```

失败时终端会打印：断言消息、页面/磁盘状态、截图与证据路径；证据 JSON 里含 `host.log` 尾部（可直接看宿主侧报错）。

## 4. 套件清单

| 套件 | 覆盖 | 关键断言 / 选择器 |
| --- | --- | --- |
| `smoke.mjs` | 应用基座 + 主要页面 | URL `https://zilux2.local`、侧栏 `.rail-btn` 齐全、首页 `.ui-page.home`、搜索 `.search-dock` → `.wall-title` `搜索「…」`（**竞态回归**：input 后 <50ms 派发 Enter，12s 内出结果墙；见 §4.2）、发现页 `.wall .disc`、我的歌单（弹层或登录引导）、设置页分区、歌词页 `.lyrics-view` 开/关、全程 console 零错误 |
| `room-effects.mjs` | 房间设置：粒子/流星预设 chips | `.room-preset-row button.room-preset-chip[data-preset-kind][data-preset-id]`；8 个预设点击后 `.ts-value` 数值变化、`aria-pressed`/`is-active` 高亮、点 `.ts-btn.is-primary` 保存后 `localStorage.zilux2.roomStyle` 字段等于验收数值表（见 `lib/fixtures.mjs` 的 `ROOM_PRESET_FIXTURES`）；「取消」不落盘；结束还原原始 `roomStyle`/`lumiere` |
| `tray-and-downloads.mjs` | 托盘 / 全局热键 / 宿主命令通道（task-12） | `host.log`：`host.start version=<ZILUX2_EXPECT_HOST_VERSION>`（默认 1.1.6）、`hotkey.register id=1..4 ok`（动作 `togglePlay/prev/next/toggleWindow`；id=2/3 允许 `Ctrl+Alt+Left/Right` 被占用后回落 `Ctrl+Alt+Shift+Left/Right`）、`tray.start icon=process` 且无 `tray.error`；`chrome.webview` 有 `addEventListener/postMessage/dispatchEvent`；页面派发 `{v:1,type:'command',action}`（togglePlay/prev/next）→ 宿主日志新增 `web:info command <action>`；未知 action / 非 command 类型 / `null` 数据被忽略；播放状态可观测时断言 `playing` 切换，不可观测记 SKIP；托盘交互/关窗后台/WM_HOTKEY 模拟记 SKIP + 手测清单（§4.4） |
| `downloads.mjs` | 下载队列入口迁移 + 音质浮层 + 真实下载 | 入口 `[data-qa="download-entry"]`、**rail 不再有下载入口**（`.rail .rail-btn[aria-label="下载队列"]` 不存在）、播放条入口 toggle/点外/Esc、`.dlq-panel.is-open`、`.dlq-row[data-state]`、`.dlq-bar>.dlq-fill`（宽度随进度变化）、`.dlq-pct/.dlq-status`、done/error 行按钮显隐、`.dlq-summary .dlq-sum-item[data-kind]` 计数、筛选 tab、刷新、关闭重开状态保持、落盘文件存在且非空；**分段控件** `.dlq-tabs.seg` + `.seg-btn.dlq-tab`、激活双类 `is-active`/`is-on`、`.seg-thumb` 白色滑块定位；**切换动画** `.is-switch`（30ms 内）/ `dlq-switch-in`（空态与真实行）/ 24ms stagger / 700ms 移除 / 滑块位移；**音质浮层** `.dlqp-overlay`/`.dlqp-panel[data-qa="download-picker"]`（默认项=设置音质、取消/Esc/点外关闭、不产生任务）；**快捷设置第 5 页** `[data-qa="quick-downloads-page"]`（4 筛选可切、状态/目录/行数与真值一致、切走再切回不重复渲染）；选「高品质」→ `job.quality=high` 且 `.dlq-meta` 显示高品质、不回写全局设置；无损下载 done 时断言 `.flac` 落盘（源站不提供则 SKIP）；真值同时读 `window.__zilux2DownloadQueue.state()` |
| `local-watch.mjs` | 本地目录监控 | bridge `restore` 注入测试目录 → 本地页「本地 · N 首」；放 mp3 后 ≤8s 自动 +1、删 mp3 后 ≤8s 回到基线（不刷新/不重进页面）；`host.log` 出现 `[local] watch incremental` / `watch rescan applied` 作为根因证据；结束还原 `zilux2.localFolder` 并删测试目录 |
| `update-channel.mjs` | 更新通道 | 设置页「更新」分区：`.updates-version`、`.updates-status`（文案与 `web/src/ui/updates.ts` 的 `UPDATE_STATE_TEXT` 对齐）、`.updates-input`、`.updates-actions` 按钮；点「检查更新」→ 状态流转到已知终态 + `host.log` `[update] check repo=…`；进程内 mock 更新服务（`/__ping`、`/repos/*/releases/latest`、`/download/*`）可达且协议形状正确。**不下载、不安装** |

### 4.1 下载队列 UI 微调断言（seg 滑块 / 切换动画 / rail 入口迁移）

对应 task-7 的 3 条 UI 需求；其中 **① rail 常驻入口在 task-12 已被移除**（入口统一改为快捷设置第 5 页 + 播放条按钮），
① 类断言已改写为「入口迁移」，②③ 的 seg 滑块与切换动画断言仍然有效。

| 需求 | 断言要点 | 关键选择器 / 类名 |
| --- | --- | --- |
| ① 入口迁移（task-12 修订） | rail 里**不再**有下载入口（`.rail .rail-btn[aria-label="下载队列"]` 不存在、rail 标题列表不含「下载」）；播放条入口存在且 `aria-haspopup=dialog`/`hidden=false`；点一次开（`aria-hidden=false`、`aria-expanded=true`）、再点收（toggle）；点面板外 / `Esc` 关闭 | `[data-qa="download-entry"]`、`.rail .rail-btn[aria-label="下载队列"]`、`.dlq-panel.is-open` |
| ② 分段控件统一 `.seg` | `.dlq-tabs` 同时有 `seg` + `dlq-tabs`；4 个 tab 同时有 `seg-btn` + `dlq-tab`；激活唯一且 `is-active` 与 `is-on` 同一 tab、`aria-selected=true`；`.seg-thumb` 为 `.dlq-tabs` 直接子元素、`width>0`、`opacity=1`、与激活 tab 的 `offsetLeft/offsetWidth` 对齐（±2px）；非激活 tab 不带 `is-on` | `.dlq-panel .dlq-tabs.seg`、`.dlq-panel .dlq-tabs > .seg-thumb`、`.dlq-tab.is-active.is-on` |
| ③ 切换动画 | 点 tab 后页面内 20ms 取样：`.dlq-list` 与 `.dlq-empty` 临时带 `is-switch`；空态 `animationName` 含 `dlq-switch-in`；带真实行时行动画含 `dlq-switch-in`、第 2 行 `animationDelay` 含 `0.024s`（stagger）；700ms 后 `is-switch` 移除；`.seg-thumb` 的 `left` 相对切换前发生位移 | `.dlq-list.is-switch`、`.dlq-empty.is-switch`、`animation-name: dlq-switch-in` |

采样在页面内用 `setTimeout` 完成（CDP 往返在点击前/后各一次），保证「30ms 内」不被调试通道延迟污染。
空态动画在宿主会话 **0 任务**时可直接验证；带行动画由同套件真实下载用例覆盖（`window.__zilux2DownloadQueue` 有任务时空态隐藏、行动画生效）。
套件结束会把筛选复位「全部」→ 关面板 → 回首页，应用保持在干净状态。

### 4.2 搜索竞态回归用例（input 后立即 Enter）

`lib/ui.mjs` 的 `openSearch(cdp, keyword)` 现在是**真实竞态路径**的回归用例：

- 在同一个页面内 `eval` 里连续派发 `input` 事件和 `Enter` keydown，两次事件间隔 ≈0ms（<50ms），
  故意让「边打边搜」的 220ms 防抖定时器落在 `commitSearch` 之后；
- 断言 12s 内墙面完成：`.wall-title` = `搜索「kw」`、`.wall-sub` 含「首」且**不含**「加载中」/「搜索中」、
  `.wall .track-row` 行数 > 0；返回 `{ title, sub, rows, elapsedMs }`。

背景（2026-10 真机复现、已报 Lead 并修复）：`web/src/ui/app.ts` 的 preview 防抖在 `commitSearch`
（`++searchSeq`）之后才执行 `runSearchPreview`（又 `++searchSeq`），会把手动提交的流式 onUpdate /
最终墙面赋值全部判为过期丢弃，墙面永久停在「已找到 N 首 · 加载中…」。修复是 `commitSearch` 开头
`window.clearTimeout(this.searchTimer); this.searchTimer = 0;`。若本用例超时/仍含「加载中」→ 竞态回归，
按产品 bug 处理（附截图 + `host.log`，不要靠多点一次 Enter 掩盖）。`smoke.mjs` 与 `downloads.mjs`
的搜索步骤都走这个 `openSearch`。

### 4.3 task-12 新断言：快捷设置下载页 / 音质浮层 / 托盘与热键

对应用户第 2 轮下载队列 UI 需求（下载入口迁到快捷设置、下载前选音质）与宿主托盘/热键需求。

| 需求 | 断言要点 | 关键选择器 / 类名 |
| --- | --- | --- |
| 快捷设置第 5 个「下载」页 | `.quick-tab` 共 5 个且含「下载」；点开 `.quick.is-download.is-open`；页面容器存在；4 个筛选（全部/下载中/已完成/失败）可点、`is-active`+`is-on` 唯一；`.seg-thumb` 可见且对齐激活 tab；`.dlq-embed-status` 文案形如 `下载中 N · 已完成 M` 且与 `__zilux2DownloadQueue.state()` 计数一致；`.dlq-dir-path` 等于真值目录；`.dlq-open-dir` 存在；行数与任务数一致、切「已完成」后行均 done；切其它 tab 再切回不报错、不重复渲染；`Esc` 关 quick | `[data-qa="quick-downloads-page"]`、`.quick.is-download.is-open`、`.dlq-embed-status`、`.dlq-dir-path`、`.dlq-open-dir` |
| 音质浮层（本次下载专用） | 点 `.track-download` 后出现 `.dlqp-overlay`/`.dlqp-panel[data-qa="download-picker"]`；默认项 = 设置里的 `downloads.quality`（默认 high：`high` 带 `aria-checked=true`/`data-default="true"`/`.dlqp-option-default`）；三档文案 标准/高品质/无损、`.dlqp-hint` 有「仅对本次下载生效」；「取消」/`Esc`/点 overlay 都关闭且**不产生任务**；选「高品质」→ 新任务 `quality=high`、`.dlq-meta` 含「高品质」、localStorage `zilux2.settings.downloads.quality` **未被回写**；无损下载 done 时 fileName 以 `.flac` 结尾（源站不提供则 SKIP） | `.dlqp-overlay`、`.dlqp-option[data-quality]`、`.dlqp-cancel`、`.dlq-meta`、`zilux2.settings` |
| 托盘 / 热键 / 命令通道 | `host.log` 本次会话：`host.start version=<ZILUX2_EXPECT_HOST_VERSION>`、`hotkey.register id=1..4 ok`（togglePlay / prev / next / toggleWindow；id=2/3 允许回落 `Ctrl+Alt+Shift+Left/Right`）、`tray.start icon=process` 且无 `tray.error`；`chrome.webview` 具备 `addEventListener/postMessage/dispatchEvent`；页面派发 `{v:1,type:'command',action}` 后宿主日志新增 `web:info command <action>`；未知 action / 非 command / `null` 被忽略；`togglePlay` 后 `__ziluxPlayer().playing` 能观测到切换才断言，否则 SKIP | `host.log`、`hotkey.register`、`tray.start`、`web:info command` |

### 4.4 托盘 / 全局热键人工手测清单（无法自动化，发布前人工确认）

`tray-and-downloads.mjs` 只能断言宿主日志与命令通道；托盘交互与真实按键必须手测。逐项确认并记录结果：

| # | 步骤 | 预期 | 预期 host.log 关键字 |
| --- | --- | --- | --- |
| 1 | 启动应用，看任务栏通知区 | 出现 Zilux2 托盘图标（非系统默认图标） | `tray.start icon=process` |
| 2 | 左键点托盘图标 / 双击 | 窗口在显示↔隐藏间切换（不退出应用） | `tray.show` / `tray.hide`、`tray.command` |
| 3 | 右键托盘图标 | 菜单 5 项：显示主界面 / 播放·暂停 / 上一首 / 下一首 / 退出（文案以实际为准） | `tray.command action=…` |
| 4 | 点窗口关闭按钮（×） | 窗口隐藏到托盘、音乐继续播放，**进程不退出** | `tray.hide` |
| 5 | 托盘菜单点「退出」 | 应用真正退出（进程结束） | `tray.exit`（或等价行） |
| 6 | `Ctrl+Alt+Space` | 播放/暂停切换 | `hotkey.fire action=togglePlay`、`web:info command togglePlay` |
| 7 | `Ctrl+Alt+Shift+Left` | 上一首（`Ctrl+Alt+Left` 未被占用时应直接生效） | `hotkey.fire action=prev`、`web:info command prev` |
| 8 | `Ctrl+Alt+Shift+Right` | 下一首 | `hotkey.fire action=next` |
| 9 | `Ctrl+Alt+Z` | 窗口显示↔隐藏切换 | `hotkey.fire action=toggleWindow` |

> 备注：`WM_HOTKEY` 的模拟投递在沙箱/远程会话里不稳定，套件里记为 SKIP；`tray-and-downloads.mjs` 会读取
> `%LOCALAPPDATA%\Zilux2\logs\host.log` 里**最后一次 `host.start` 之后**的日志行做断言，换构建后记得同步
> `ZILUX2_EXPECT_HOST_VERSION`。

## 5. 设计约束（真机 QA 经验，来自 `research/HANDOFF.md` §4）

- 交互一律用页面内 JS（`el.click()` / `dispatchEvent`），不依赖真实鼠标坐标；只监听 `pointerdown`
  的元素用 `pointerdown` 派发（如 `.pb-btn-lyrics`）。
- **不做 `Page.reload`**（偶发卡死）、**不弹 `window.confirm` / `window.prompt`**（会卡死页面）、
  **脚本不自行 `taskkill`**；若 CDP 超时，按错误提示重启安装版再跑。
- 采样过渡态（进度条/pct）间隔 `~85ms`；等待类断言都带超时并在失败时落证据。
- 不点更新安装（会重启应用）、默认不点 `.dlq-reveal`（会弹资源管理器）。

## 6. 清理与副作用（重要）

- `downloads.mjs` 会**真实下载**到宿主下载目录（默认 `%USERPROFILE%\Music`，即 `C:\Users\13329\Music`）。
  task-12 起每次全量运行通常新增 **1 个高品质（320k .mp3）文件**；「无损下载」步骤若源站提供无损，还会再新增
  **1 个 .flac**（源站不提供则该步 SKIP、不产生文件）。QA 不删用户目录里已有文件；测试产生的任务在结果 JSON /
  终端 note / 本轮报告里会列出文件名、大小与完整路径，确认是测试新增后再手动删。想直接打开目录可临时设
  `ZILUX2_QA_CLICK_REVEAL=1` 点一次 reveal。
- `tray-and-downloads.mjs` 只读 `host.log`，不写文件；命令通道步骤会临时静音 `<audio>` 并在收尾恢复。
- `local-watch.mjs` 在 `research/qa/suite/tmp-local-watch/` 建临时目录，结束自动删除并还原
  `localStorage.zilux2.localFolder`；中断（Ctrl+C）时可能残留，手动 `rm -rf` 该目录即可。
- `room-effects.mjs` 会备份并还原 `zilux2.roomStyle` / `zilux2.lumiere`。
- 全部套件不会修改 `src/`、`web/`、`tools/` 与 `research/tmp`。

## 7. 更新通道全链路（手动，套件不自动做）

套件只验证「设置页更新分区 + mock 服务可达」。要验证 app ↔ mock 的完整链路（需要重启应用）：

1. 起 mock 更新服务（另一终端）：
   ```bash
   node research/tmp/mock-updater.mjs          # 默认 8765 端口，返回 1.0.1 版本
   ```
2. 用环境变量重启安装版（CDP 端口别丢）：
   ```bat
   set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223
   set ZILUX2_UPDATE_API=http://127.0.0.1:8765
   start "" "%LOCALAPPDATA%\Programs\Zilux2\Zilux2.exe"
   ```
3. 打开设置 →「更新」→ 点「检查更新」，预期出现「发现新版本 v1.0.1」和「下载更新」按钮；
   `host.log` 有 `[update] check repo=… url=http://127.0.0.1:8765/...`。
4. **不要点安装**（会拉起安装程序并退出应用）。验证完直接关应用、恢复环境变量。

## 8. 故障排查

| 现象 | 处理 |
| --- | --- |
| `连不上应用（http://127.0.0.1:9223）` | 应用不是带 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 启动的；关掉应用按 §1 重启 |
| CDP 调用超时 / 页面无响应 | 大概率卡在原生 confirm/prompt 或 `Page.reload`。`taskkill /IM Zilux2.exe /F` 后重启（套件不会自动重启） |
| 本地页弹了原生文件夹选择器 | local-watch 通过 bridge 注入目录，正常不会弹；如出现说明 restore 没生效（看 `[local] mapped` 日志） |
| downloads 出现 `403 (Forbidden)` | 在线搜索源（mvmp3）对部分曲目/账号风控，产品侧问题。套件已自动换行重试，仍失败时把行 source/trackId + host.log 一起报给 Lead |
| 搜索结果墙卡在「融合搜索 · 已找到 N 首 · 加载中…」 | **产品竞态 bug 的回归信号**（2026-10 真机复现，Lead 已修 `commitSearch` 开头 `clearTimeout(searchTimer)`）：`lib/ui.mjs` 的 `openSearch()` 现已按真实竞态路径执行（input 后 <50ms 派发 Enter），断言 12s 内完成且不含「加载中」/「搜索中」；失败即修复回归，把截图 + `host.log` 报给 Lead，不要靠点第二次 Enter 掩盖 |
| 终端提示 `research/research` 残留 | 旧截图路径 bug 的产物，`rm -rf research/research`（`.gitignore` 未忽略它，会污染提交） |
| `host.log` 里找不到 `host.start` / `hotkey.register` | 应用是旧构建（task-12 之前）或日志被截断：换装本轮的安装版再跑；`tray-and-downloads.mjs` 只会从最后一次 `host.start` 之后读行 |
| 找不到 `.dlqp-panel` / 快捷设置没有第 5 个「下载」tab | 前端仍是旧构建（未包含 downloadPicker.ts / quick 下载页），让构建产物随安装版一起更新后再跑 |
| 无损下载 SKIP | 在线源对「无损」有版权/账号限制，属产品/源站限制：`job.state=error` 时套件记 SKIP 并附错误与 `host.log`，不算回归 |
| 托盘/热键相关步骤 SKIP | 托盘交互、`WM_HOTKEY` 投递无法在自动回归里稳定模拟，按 §4.4 人工手测清单确认 |
| tray 套件出现 `/api/cover` 的 `ERR_CONNECTION_REFUSED` 日志 | 命令通道会切歌，持久化播放队列里的封面 URL 可能仍绑着上次宿主启动的回环端口；product 的 `artwork.rebindCover` 会在在线服务就绪后重绑并重载。套件把这类「旧端口封面请求」记为 tolerated 噪音（`suite.note`），其余 console 错误/JS 异常照常 FAIL |
| 结果 JSON 缺失 | 套件进程异常退出（连接级 fatal 或崩溃），终端日志 + `node --check <file>` 自查 |

## 9. 目录结构 / 维护

```
research/qa/suite/
├── lib/cdp.mjs        # CDP 连接、Runtime.evaluate、截图、host.log 读取、Suite 步骤框架
├── lib/ui.mjs         # 公共导航/展开/读取 localStorage/关闭弹层
├── lib/fixtures.mjs   # 夹具有路径、验收数值表、DLQ/房间预设选择器、超时阈值
├── smoke.mjs / tray-and-downloads.mjs / room-effects.mjs / downloads.mjs / local-watch.mjs / update-channel.mjs
├── run-all.mjs        # 顺序执行 + 汇总表 + 失败明细
└── README.md
```

- 新增套件：在 `run-all.mjs` 的 `SUITES` 里注册（顺序有意义），脚本名 = 套件名。
- 选择器来源：`web/src` 对应实现（roomSettingsPanel.ts / downloadQueue.ts / downloadPicker.ts /
  app.ts / updates.ts）；产品改名时先改这里的选择器再跑。
- 验收数值表（房间预设、下载超时、watch 时限）集中在 `lib/fixtures.mjs`，改动只动一处。
