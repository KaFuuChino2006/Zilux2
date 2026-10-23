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
| `smoke.mjs` | 应用基座 + 主要页面 | URL `https://zilux2.local`、侧栏 `.rail-btn` 齐全、首页 `.ui-page.home`、搜索 `.search-dock` → `.wall-title` `搜索「…」`、发现页 `.wall .disc`、我的歌单（弹层或登录引导）、设置页分区、歌词页 `.lyrics-view` 开/关、全程 console 零错误 |
| `room-effects.mjs` | 房间设置：粒子/流星预设 chips | `.room-preset-row button.room-preset-chip[data-preset-kind][data-preset-id]`；8 个预设点击后 `.ts-value` 数值变化、`aria-pressed`/`is-active` 高亮、点 `.ts-btn.is-primary` 保存后 `localStorage.zilux2.roomStyle` 字段等于验收数值表（见 `lib/fixtures.mjs` 的 `ROOM_PRESET_FIXTURES`）；「取消」不落盘；结束还原原始 `roomStyle`/`lumiere` |
| `downloads.mjs` | 下载队列面板 + 真实下载 | 入口 `[data-qa="download-entry"]`、`.dlq-panel.is-open`、`.dlq-row[data-state]`、`.dlq-bar>.dlq-fill`（宽度随进度变化）、`.dlq-pct/.dlq-status`、done/error 行按钮显隐、`.dlq-summary .dlq-sum-item[data-kind]` 计数、筛选 tab、刷新、关闭重开状态保持、落盘文件存在且非空；真值同时读页面调试入口 `window.__zilux2DownloadQueue.state()` |
| `local-watch.mjs` | 本地目录监控 | bridge `restore` 注入测试目录 → 本地页「本地 · N 首」；放 mp3 后 ≤8s 自动 +1、删 mp3 后 ≤8s 回到基线（不刷新/不重进页面）；`host.log` 出现 `[local] watch incremental` / `watch rescan applied` 作为根因证据；结束还原 `zilux2.localFolder` 并删测试目录 |
| `update-channel.mjs` | 更新通道 | 设置页「更新」分区：`.updates-version`、`.updates-status`（文案与 `web/src/ui/updates.ts` 的 `UPDATE_STATE_TEXT` 对齐）、`.updates-input`、`.updates-actions` 按钮；点「检查更新」→ 状态流转到已知终态 + `host.log` `[update] check repo=…`；进程内 mock 更新服务（`/__ping`、`/repos/*/releases/latest`、`/download/*`）可达且协议形状正确。**不下载、不安装** |

## 5. 设计约束（真机 QA 经验，来自 `research/HANDOFF.md` §4）

- 交互一律用页面内 JS（`el.click()` / `dispatchEvent`），不依赖真实鼠标坐标；只监听 `pointerdown`
  的元素用 `pointerdown` 派发（如 `.pb-btn-lyrics`）。
- **不做 `Page.reload`**（偶发卡死）、**不弹 `window.confirm` / `window.prompt`**（会卡死页面）、
  **脚本不自行 `taskkill`**；若 CDP 超时，按错误提示重启安装版再跑。
- 采样过渡态（进度条/pct）间隔 `~85ms`；等待类断言都带超时并在失败时落证据。
- 不点更新安装（会重启应用）、默认不点 `.dlq-reveal`（会弹资源管理器）。

## 6. 清理与副作用（重要）

- `downloads.mjs` 会**真实下载一首歌**到宿主下载目录（默认 `%USERPROFILE%\Music`，即 `C:\Users\13329\Music`）。
  QA 不删用户目录里已有文件；测试产生的任务在结果 JSON / 终端 note 里能看到文件名与路径，
  确认是测试新增后再手动删。想直接打开目录可临时设 `ZILUX2_QA_CLICK_REVEAL=1` 点一次 reveal。
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
| 终端提示 `research/research` 残留 | 旧截图路径 bug 的产物，`rm -rf research/research`（`.gitignore` 未忽略它，会污染提交） |
| 结果 JSON 缺失 | 套件进程异常退出（连接级 fatal 或崩溃），终端日志 + `node --check <file>` 自查 |

## 9. 目录结构 / 维护

```
research/qa/suite/
├── lib/cdp.mjs        # CDP 连接、Runtime.evaluate、截图、host.log 读取、Suite 步骤框架
├── lib/ui.mjs         # 公共导航/展开/读取 localStorage/关闭弹层
├── lib/fixtures.mjs   # 夹具有路径、验收数值表、DLQ/房间预设选择器、超时阈值
├── smoke.mjs / room-effects.mjs / downloads.mjs / local-watch.mjs / update-channel.mjs
├── run-all.mjs        # 顺序执行 + 汇总表 + 失败明细
└── README.md
```

- 新增套件：在 `run-all.mjs` 的 `SUITES` 里注册（顺序有意义），脚本名 = 套件名。
- 选择器来源：`web/src` 对应实现（roomSettingsPanel.ts / downloadQueue.ts / app.ts / updates.ts）；
  产品改名时先改这里的选择器再跑。
- 验收数值表（房间预设、下载超时、watch 时限）集中在 `lib/fixtures.mjs`，改动只动一处。
