# AirPlay / RAOP 投送 UI（任务 / 任务 / 任务）

Zilux2 Web 前端（`web/`）的 AirPlay/RAOP 投送界面：设置面板「投送」区块 + 左侧栏投送入口弹层，覆盖
扫描 → 设备列表 → 连接 → 密码 / Mac 配对码 → 音量 → 断开 的完整流程，并按宿主契约 `docs/zilux2-host-contract.md` §12 与 C# 宿主通信。

- 任务（多设备同时投送）：同一面板可同时向多台 AirPlay 设备投送，支持逐台「停止」与「全部停止」；
  状态机新增 `actives`（全部正在投送的设备），并兼容只回传单个 `active` 的旧宿主。
- 任务（macOS 接收器 HAP PIN 配对）：连接 Mac「隔空播放接收器」时宿主推
  `state:'connecting' + code:'pinRequired'`，面板显示内联 4 位配对码输入框，回发 `action:'pin'`；
  首次配对成功后宿主凭据落盘，再连不再要 PIN。

- 作者：teammate `ui-dev`
- 范围：只改 `web/src/**` 与 `research/airplay/ui/**`；未改 `src/`（C#）、`docs/`、`web/vite.config.*`、依赖列表
- 生产依赖：零新增（无 React、无 UI 框架；只用既有 CSS 变量与 `web/src/ui/icons.ts`）

---

## 1. 改动文件清单

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `web/src/airplay.ts` | 新增（468 行） | 投送状态机 + 宿主桥封装（唯一状态源），含多设备 `actives`、逐台断开、Mac HAP PIN 配对 |
| `web/src/ui/airplayPanel.ts` | 新增（558 行） | 共用投送视图组件：`settings`（设置区块）/ `popover`（浮层）两种变体，支持多设备同时投送与 PIN 配对码输入 |
| `web/src/styles/airplay.css` | 新增（759 行） | 投送 UI 样式，含多设备列表/已连接清单、PIN 输入框、`.space-shell.theme-gold` 黑金主题覆盖 |
| `web/src/bridge.ts` | 增量 | 新增 `export function postMessage(payload): boolean`（复用内部 `post`，无宿主静默丢弃并返回 `false`）；未改动既有 API |
| `web/src/ui/icons.ts` | 增量 | `IconName` 增加 `'airplay'`，`STROKE` 增加对应 path（lucide 屏幕+下方三角） |
| `web/src/ui/spaceShell.ts` | 接线 | 唯一实际界面：左侧栏投送按钮、弹层容器、面板创建/生命周期、设置面板内嵌区块、Esc/外部点击关闭、多设备 Toast、destroy 清理 |
| `web/src/main.ts` | 接线 | `import './styles/airplay.css'`（在 `space.css` 之后）；`?airplayMock=1` 时在 `import.meta.env.DEV` 下动态加载 dev mock |
| `web/src/dev/airplayMock.ts` | 新增（539 行，仅 dev） | 浏览器预览用的假宿主（多设备 `actives`、逐台 disconnect、`?airplayLegacy=1` 旧宿主模拟、`mock-mac` 的 HAP PIN 配对）+ 9 阶段自动化冒烟驱动；生产构建被完全摇掉 |

> 注意：`web/src/ui/home.ts`、`web/src/ui/settingsPanel.ts`、`web/src/ui/player.ts` 是**死代码**（无任何入口 import，settingsPanel 只被 home import）。
> 真实界面由 `web/src/main.ts` → `mountSpaceShell()`（`web/src/ui/spaceShell.ts`）挂载，因此「投送」区块落在 spaceShell 的 `.settings-sheet` 内，
> 而不是 settingsPanel 的 `.st-*` 面板。这是本任务最小合理实现，**未改**这三个旧文件。

## 2. 架构与数据流

```
C# 宿主  ──event:"airplay" (§12.2)──▶  bridge.host.onMessage ──▶ web/src/airplay.ts（解析+状态机）
   ▲                                                                   │ snapshot 订阅
   └── Page→Host type:"airplay" (§12.1) ── bridge.postMessage ◀─────────┤
                                                                       ▼
                                              web/src/ui/airplayPanel.ts（两个实例：设置区块 / 左侧栏弹层）
                                                         ▲
                                        web/src/ui/spaceShell.ts（布局、激活/关闭、Toast）
```

`airplay.ts` 是唯一状态源，UI 只订阅快照；`airplayPanel` 两个实例共享同一状态，互不重复扫描（模块内 visiblePanels 引用计数）。

## 3. `web/src/airplay.ts` API

```ts
type AirplayState = 'idle' | 'scanning' | 'connecting' | 'streaming' | 'error';
type AirplayErrorCode =
  | 'passwordRequired' | 'pinRequired' | 'unsupported' | 'busy' | 'network'
  | 'capture' | 'internal';   // pinRequired 也会随 state:'connecting' 出现（Mac 配对码）

interface AirplayDevice {
  id: string; name: string; host: string; model: string;
  requiresPassword: boolean; airPlay2: boolean;
}
interface AirplayActive { id: string; name: string; volume: number }

interface AirplaySnapshot {
  state: AirplayState;
  devices: readonly AirplayDevice[];   // 上限 32、按 id 去重，宿主未给时沿用上次
  active: AirplayActive | null;        // 第一台正在投送的设备（= actives[0]，兼容旧宿主/单设备）
  actives: readonly AirplayActive[];   // 全部正在投送的设备（多设备；空数组表示未投送）
  code: AirplayErrorCode | null;       // 仅 state==='error'
  error: string | null;                // 人类可读，截断 ≤200 字
  targetDeviceId: string | null;       // 最近一次 connect 的 deviceId（密码重试/PIN 定位用）
  passwordDeviceId: string | null;     // code==='passwordRequired' 时为 targetDeviceId
  /** 任务：Mac HAP 配对码（宿主 state:'connecting' + code:'pinRequired'） */
  pinRequired: boolean;                // 正在等用户输入 4 位配对码
  pinDeviceId: string | null;          // 要输入配对码的设备（取 targetDeviceId）
  pinMessage: string | null;           // 宿主给的提示（通常「请在 Mac 屏幕上查看配对码并输入」）
  pinSubmitted: boolean;               // 已回发 pin，等待宿主完成配对
}

const AIRPLAY_STATE_LABEL: Record<AirplayState, string>;   // 中文状态文案
const AIRPLAY_ERROR_LABEL: Record<AirplayErrorCode, string>; // 错误兜底文案（含 pinRequired）

function getAirplaySnapshot(): AirplaySnapshot;
function subscribeAirplay(listener: (s: AirplaySnapshot) => void): () => void; // 立即回调一次
function scanAirplay(): boolean;          // 发 scan；乐观进入 scanning
function stopAirplayScan(): boolean;      // 发 stopScan；scanning 时乐观回 idle
function connectAirplay(deviceId: string, password?: string): boolean; // 已在投送则幂等返回 true
function disconnectAirplay(): boolean;    // 断开全部
function disconnectAirplayDevice(deviceId?: string): boolean; // 有 id 只断该台，无 id = 全部
function setAirplayVolume(percent: number): boolean; // 有投送时发送，钳 0–100 整数，作用于全部设备
function submitAirplayPin(deviceId: string, value: string): boolean; // 回发 4 位配对码
function resetAirplayState(): void;

// 便捷单例
const airplay = {
  hostAvailable, subscribe, getSnapshot,
  scan, stopScan, connect, disconnect, disconnectDevice, setVolume, submitPin, reset,
};
```

多设备语义：

- `actives` 按宿主推送顺序保存；`active` 恒等于 `actives[0]`（因此 任务 的 UI 代码无需改判空逻辑）。
- `connect(id)` 对「已在 `actives` 中」的设备幂等：直接返回 `true`，不重复发消息；`connecting` 中对同一 `id` 重复点击也会被吸收。
- 音量是**全局**的（契约 §12.1 volume 无 deviceId）：`setVolume(p)` 一次性作用于全部 `actives`，宿主回推后以宿主为准。
- `disconnectDevice(id)` 发 `{ action:'disconnect', deviceId }`；不带参数 = 关闭全部投送。前端不做乐观删除，等宿主回推 `actives`。
- 兼容旧宿主：payload 只有 `active` 没有 `actives` 时，用 `active` 构造单元素数组；两者都没有时——`idle` 清空，其它状态沿用上一次列表（避免多设备投送途中第二台出错/连接时把正在播的设备列表清空）。
- **Mac HAP 配对（任务）**：宿主推 `state:'connecting' + code:'pinRequired'` 时，快照 `pinRequired=true`、`pinDeviceId=targetDeviceId`、`pinMessage=payload.error`（缺省用「请在 Mac 屏幕上查看配对码并输入」）；`submitPin(id, '1234')` 发 `action:'pin'` 并乐观置 `pinSubmitted=true`（UI 显示「正在配对，请在 Mac 上确认…」并禁用输入）。宿主任意后续推送都会复位 `pinSubmitted=false`，配对结果由后续事件表达：成功 → `state:'streaming'`；失败/超时 → `state:'error'`（`code:'pinRequired'`）。首次配对成功后凭据由宿主落盘，再连同一台 Mac 不再出现 `pinRequired`。前端不缓存配对码、不计数重试次数，120 s 等待超时由宿主控制（§12.3）；契约没有「取消配对」动作，面板「取消」用 `disconnectDevice(id)` 表达（只中止这台，不影响其它已投送设备）。

无宿主（浏览器直开）行为：`airplay.hostAvailable() === false`；`scan/connect/disconnect/setVolume` 全部返回 `false`、不发消息、不改状态，UI 显示
「投送需要 Zilux2 桌面应用（WebView2 宿主）。当前是浏览器预览，投送功能已自动关闭。」且刷新按钮隐藏，页面其余功能不受影响。

### 发送的消息（§12.1 逐字对齐）

| 调用 | 实际 postMessage |
| --- | --- |
| `scan()` | `{ v:1, type:'airplay', action:'scan' }` |
| `stopScan()` | `{ v:1, type:'airplay', action:'stopScan' }` |
| `connect(id)` | `{ v:1, type:'airplay', action:'connect', deviceId }` |
| `connect(id, pw)` | 同上 + `password: pw`（仅在 `pw` 非空时携带） |
| `submitPin(id, '1234')` | `{ v:1, type:'airplay', action:'pin', deviceId:id, value:'1234' }`（仅 4 位数字；非 4 位不发） |
| `disconnect()` | `{ v:1, type:'airplay', action:'disconnect' }` |
| `disconnectDevice(id)` | 同上 + `deviceId: id`（契约未定义该字段，属最小合理扩展，见 §7 歧义 9） |
| `setVolume(p)` | `{ v:1, type:'airplay', action:'volume', percent: p }`（p 为 0–100 整数） |

### 接收的消息（§12.2）解析规则

- 只处理 `type === 'host' && event === 'airplay'`，其余消息忽略。
- `payload` 必须为对象；`state` 必须为五个合法值之一，否则**整条丢弃**（不产生半更新）。
- **不校验 `v`**（宽松：缺失或未来版本号照常解析），见 §7 歧义 1。
- `devices`：仅当 `Array.isArray` 时覆盖；缺失则沿用上次（契约允许非扫描态省略）。逐项校验 `id` 为非空字符串，`name/host/model` 缺失时回退；最多 32 台、按 id 去重。
- `active` / `actives`：优先解析 `actives` 数组；只有 `active` 时用它构造单元素数组（旧宿主兼容）；两者都缺失时——`idle` 清空 `actives`，其它状态沿用上次（多设备投送途中第二台连接/密码失败不清空已投送列表）。每项要求 `id` 非空字符串；`volume` 缺省依次沿用「同 id 上次值 → 上次首台值 → 0」；最多 32 台、按 id 去重。`active` 恒为 `actives[0] ?? null`。
- `code`：仅 `state === 'error'` 且命中枚举时保留，未知 code → `null`（UI 用 `error` 文本展示）。
- `error`：字符串，trim 后截断 200 字。
- `passwordDeviceId`：当 `state === 'error' && code === 'passwordRequired'` 时取 `targetDeviceId`（契约未回传 deviceId，见 §7 歧义 2）。
- `pinRequired` / `pinDeviceId` / `pinMessage`：仅当 `state === 'connecting' && code === 'pinRequired'` 时置真（`pinDeviceId = targetDeviceId`，`pinMessage = payload.error` 截断 200 字），其它状态一律复位为 `false/null`。注意 §12.2 正文写「code 只在 state:'error' 时出现」，与 §12.1 的 `connecting + pinRequired` 配对流程矛盾——实现以 §12.1 为准，`connecting` 与 `error` 两种状态都识别 code，仅 `connecting` 进入「等用户输入」形态（`error + pinRequired` = 配对失败/超时，走错误条展示）。

## 4. `web/src/ui/airplayPanel.ts` API

```ts
type AirplayPanelVariant = 'settings' | 'popover';

interface AirplayPanelOptions {
  variant?: AirplayPanelVariant;   // 默认 'settings'
  onRequestClose?(): void;         // popover 头部关闭按钮触发
}

interface AirplayPanelHandle {
  element: HTMLElement;
  activate(): void;    // 可见：host 可用则 scan()，本地 8.5s 扫描窗口计时
  deactivate(): void;  // 不可见：清本地计时 + 引用计数归零时 stopScan()
  destroy(): void;     // 退订 + 移除 DOM
}

function createAirplayPanel(options?: AirplayPanelOptions): AirplayPanelHandle;
```

行为要点：

- **扫描**：`activate()` 自动 `scan()`（仅 `hostAvailable()`），并启动本地 8.5s 窗口（对应契约「scan 持续 8s」）；窗口结束后若仍无设备，文案由「正在搜索同一局域网内的 AirPlay 设备…」变为「没有发现设备」。手动「刷新」按钮 `startScan()` 会重新 `scan()` + 重计时。
- **连接（多设备）**：设备行按钮为「投送」→ `connect(id)`；可连续点不同设备逐台追加投送，已投送设备行显示 `.is-active` + 「正在投送」+「停止」；`state==='connecting'` 时目标设备显示「连接中…」并禁用，其它设备仍可操作。
- **已连接清单**：`actives.length === 0` 时显示 `.airplay-now` 卡片；1 台显示「正在投送到 <名称>」，>1 台显示「已连接 <N> 台设备」+ `.airplay-now-list`（每台一个 `.airplay-now-chip`，带独立「停止」）；卡片底部为 0–100 音量滑杆与「全部停止」按钮。
- **密码**：仅当 `state==='error' && code==='passwordRequired'` 且 `passwordDeviceId` 对应设备仍在列表时显示内联密码表单；回车/「连接」提交 `connect(id, pw)`，「取消」隐藏表单；密码不回显、不持久化。多设备投送途中第二台要密码时，错误态与已投送清单**并存**（now 卡片继续显示正在投送的设备）。
- **Mac 配对码（任务）**：仅当 `snapshot.pinRequired` 时显示内联 4 位配对码表单（青色调，与琥珀色密码框区分）：标题「「客厅 MacBook」需要配对码。…（4 位数字，2 分钟内有效）」，输入框只保留数字、最多 4 位、凑满 4 位才可提交；提交 `submitPin(deviceId, '1234')`，随后输入框禁用、按钮变「配对中…」、状态文案变「正在配对，请在 Mac 上确认…」。配对成功宿主推 `streaming` 后表单自动隐藏；失败推 `error`（`pinRequired`）时错误条显示兜底文案，可重新点「投送」重试。「取消」= `disconnectDevice(deviceId)` 中止这台设备的配对（已投送的其它设备不受影响）。
- **音量**：有投送设备时显示 0–100 滑杆，全局作用于全部设备；`input` 立即更新数值标签，150 ms 防抖后 `setVolume`，`change` 立即 flush（拖动结束必发）。
- **逐台断开 / 全部断开**：设备行或清单 chip 的「停止」→ `disconnectDevice(id)`（只断该台）；「全部停止」→ `disconnect()`；面板不做乐观删除，等宿主回推 `actives`。
- **状态文案**：1 台「正在投送到 X」；多台「已连接 N 台设备」；错误态仍显示 `AIRPLAY_ERROR_LABEL[code]`，密码错误时覆盖为「这台设备需要密码」。
- **错误**：`error` 态显示 `.airplay-notice.is-error`，文案 = `AIRPLAY_ERROR_LABEL[code]`；若宿主 `error` 文本与 label 不同则追加「：{error}」。
- **空态**：扫描中 → 「正在搜索同一局域网内的 AirPlay 设备…」；非扫描且无设备 → 提示确认同一 Wi-Fi、路由器 AP 隔离、防火墙放行。
- **无宿主**：警告 notice + 隐藏刷新按钮，其余交互不可用。
- 设备列表按 signature 增量重建，避免音量输入/滚动时丢失焦点。

### DOM 契约（供 e2e 与宿主侧调试）

| 选择器 | 含义 |
| --- | --- |
| `.airplay-view` / `.airplay-view.is-popover` | 视图根 |
| `[data-airplay-dot]` | 状态圆点（`.is-idle/-scanning/-connecting/-streaming/-error`） |
| `[data-airplay-status-text]` | 状态文案 |
| `[data-airplay-refresh]` | 扫描/刷新按钮（无宿主时 `hidden`） |
| `[data-airplay-notice]` | 提示/错误条 |
| `[data-airplay-now]` | 已投送卡片（`actives.length > 0` 时显示） |
| `[data-airplay-now-prefix]` `[data-airplay-now-name]` | 卡片前缀（1 台「正在投送到」/多台「已连接」）与名称（1 台设备名 / `N 台设备`） |
| `[data-airplay-now-list]` `.airplay-now-chip` | 多台时的逐台清单（>`1` 台才显示，每项含 `.airplay-now-chip-name`） |
| `[data-airplay-stop="<id>"]` | 停止单台投送（now 清单 chip 与设备行均会出现） |
| `[data-airplay-disconnect]` | 「全部停止」按钮 |
| `[data-airplay-volume]` `[data-airplay-volume-value]` | 音量滑杆 / 数值标签 |
| `[data-airplay-password]` `[data-airplay-password-input]` `[data-airplay-password-ok]` `[data-airplay-password-cancel]` | 密码表单 |
| `[data-airplay-pin]` `[data-airplay-pin-text]` `[data-airplay-pin-input]` `[data-airplay-pin-ok]` `[data-airplay-pin-cancel]` | Mac 配对码表单（4 位数字，`.airplay-input.is-pin`） |
| `[data-airplay-devices]` `[data-airplay-connect="<id>"]` | 设备列表 / 单台连接按钮 |
| `[data-airplay-empty]` `[data-airplay-note]` | 空态 / 底部说明 |
| `[data-airplay-close]` | 浮层关闭按钮 |
| `.space-rail-btn[data-rail="airplay"]` | 左侧栏投送入口（`.is-on` 弹层开启，`.is-streaming` 投送中高亮） |
| `[data-airplay-pop]` | 浮层定位容器（`hidden` 控制显隐） |

## 5. 界面接入点（`spaceShell.ts`）

- **左侧栏**：在 `.space-rail` 的「喜欢」与「设置」之间新增投送按钮（`title="投送 · AirPlay"`）。点击 → `toggleAirplayPop()`：按 rail 按钮 rect 定位浮层（宽 280–336，贴边收拢，`resize` 重新定位）、`activate()` 面板、按钮加 `.is-on`；再次点击 / 点浮层外 / Esc / 浮层右上角 ✕ 关闭并 `deactivate()`。点击外部用 `pointerdown` 捕获阶段监听，避免与内部点击冲突。
- **设置面板**：`.settings-sheet` 的 `.settings-body` 末尾追加第 4 个 `.settings-section`（通用/外观/播放/投送）。`openSettingsSheet()` → `activate()`（自动扫描），`closeSettingsSheet()` → `deactivate()`；因两个面板共享状态，引用计数保证任一面板仍可见时不发 `stopScan`。
- **全局反馈**：订阅 `airplay.subscribe`，用「上一次 `actives` 的 id 集合 − 本次」求新增设备：新增一台→`showToast("已投送到「<设备名>」", 'ok')`，新增且总数 >1→`showToast("已投送到「<设备名>」（共 N 台）", 'ok')`；仅当状态**跃迁**到 `error` 时 `showToast(error, 'warn')`（避免重复弹）。rail 按钮 `.is-streaming` 常亮表示正在投送（`actives.length > 0`）。
- **销毁**：`destroy()` 中退订、移除 `pointerdown`/`resize` 监听、`destroy()` 两个面板。

样式：`web/src/styles/airplay.css` 全部使用既有 token（`--glass`、`--text`、`--accent`、`--r-*`、`--ease`、`--shadow-*`），并补齐
`.space-shell.theme-gold` 覆盖（暗金玻璃卡、`rgba(212,175,55,*)` 边、金色 accent `#d8b74a`），默认主题与白磨砂主题均验证过。

## 6. 构建与验证结果

环境：Windows，node v24.21.0。**本机 `npm` 不在 PATH**，故直接执行本地二进制：

```bash
cd web
node node_modules/typescript/bin/tsc --noEmit     # TS 严格模式（strict + noUnusedLocals/Parameters）→ exit 0
node node_modules/vite/bin/vite.js build          # 生产构建 → 成功
```

构建产物（任务 本次）：`dist/assets/main-*.css` 132.68 kB（gzip 23.82 kB）、`dist/assets/main-*.js` 481.99 kB（gzip 160.06 kB）。

验证项：

1. `tsc --noEmit` 通过（exit 0），无 TS6133/TS2532/TS2345 等。
2. `vite build` 成功（1.21 s）；`dist` 中 grep `airplay-mock|mock-mac|mock-homapod|installAirplayMockHost|airplaySmoke|airplayLegacy|LEGACY_MODE` **无命中** → mock/legacy/PIN 模拟均未进生产路径。
3. `dist` CSS 含 `.airplay-device`/`.airplay-view`/`.space-rail-btn.is-streaming`/`.airplay-pin`；主 JS 含 `"airplay"`、`pinRequired`、`passwordRequired`、`投送` 文案、`data-airplay-now-list`、5 个 `data-airplay-pin*` 选择器 → 多设备与 PIN UI 均已打包。
4. vite dev（`--port 5299`）下 `index.html`、`/src/main.ts`、`/src/airplay.ts`、`/src/ui/airplayPanel.ts`、`/src/dev/airplayMock.ts`、`/src/styles/airplay.css` 全部 HTTP 200。
5. **无头 Edge 端到端（9 阶段：多设备 + PIN）**：`?snap=1&airplayMock=1&airplaySmoke=1`，`--virtual-time-budget=24000`，DOM 内嵌 9 份 `<pre id="airplay-smoke-report-1..9">` 报告全部符合预期：
   - r1 连接 + 音量：`railStreaming:true, status:"正在投送到 书房 Sonos One", volumeValue:"62%", sliderValue:"62", stopTargets:["mock-sonos"]`
   - r2 需密码设备：`railStreaming:false, status:"这台设备需要密码", passwordVisible:true, nowVisible:false`
   - r3 输入密码后：`railStreaming:true, status:"正在投送到 客厅 HomePod", passwordVisible:false, nowVisible:true`
   - r4 **同时投送两台**：`status:"已连接 2 台设备", nowName:"2 台设备", nowListVisible:true, nowChips:["客厅 HomePod","卧室电视"]`
   - r5 **单台停止**：`status:"正在投送到 卧室电视", nowListVisible:false, nowChips:[], stopTargets:["mock-tv"]`
   - r6 **全部停止**：`railStreaming:false, nowVisible:false, stopTargets:[], status:"已发现 4 台可投送设备"`
   - r7 **Mac 接收器要配对码**：`railStreaming:false, status:"「客厅 MacBook」等待 Mac 配对码", pinVisible:true, pinText:"「客厅 MacBook」需要配对码。请在 Mac 屏幕上查看配对码并输入（4 位数字，2 分钟内有效）", pinValue:""`
   - r8 **输入 1234 后开始投送**：`railStreaming:true, status:"正在投送到 客厅 MacBook", nowVisible:true, pinVisible:false, stopTargets:["mock-mac"]`
   - r9 **凭据已落盘，再次连接不再要 PIN**：停止后重连同一台 Mac → `railStreaming:true, status:"正在投送到 客厅 MacBook", pinVisible:false, notice:null`
6. **无宿主降级**（仅 `?snap=1`，不装 mock）：两处视图均显示「投送需要 Zilux2 桌面应用（WebView2 宿主）…」，`[data-airplay-refresh]` 与 `[data-airplay-pin]` 均带 `hidden`，rail 四按钮齐全，页面无「启动失败」→ 浏览器直开正常。
7. **旧宿主兼容**：payload 只有 `active` 时归一为单元素 `actives`，UI 与 任务 单设备表现一致。mock 用 `?airplayLegacy=1`（`web/src/dev/airplayMock.ts` 里的 `LEGACY_MODE`）只回 `active`、connect 成功替换单台、disconnect 忽略 `deviceId` 全断，无头 Edge 实测（`&airplayLegacy=1`，budget 20000）：r1「正在投送到 书房 Sonos One」/ r4 点第二台后**替换**为「正在投送到 卧室电视」（`nowListVisible:false`、`nowChips:[]`，未出现「已连接 2 台设备」）/ r6 全部停止正常，无 notice、无报错。
8. **PIN 空/非法输入防护**：输入框 `input` 时剥离非数字、截断 4 位，不足 4 位时「配对」按钮 `disabled`；`submitPin` 内部也校验 `/^\d{4}$/`，非 4 位不发消息。宿主若对错误 PIN 推 `error + code:'pinRequired'`，UI 显示「需要在 Mac 屏幕上输入配对码」并允许重新点「投送」。
9. 未接真实 C# 宿主（并行开发中）；宿主联调时无需改前端，只需宿主按 §12 发 `event:"airplay"`（含 `actives`，Mac 连接按 §12.1 推 `connecting + pinRequired`）。

## 7. 已知限制

1. **未与真实 C# 宿主联调**：全部行为基于 §12 契约 + dev mock 验证；宿主若字段/时序不同，需调整 `airplay.ts` 解析（集中在一处，改动面小）。
2. **扫描结束无显式事件**：契约只规定 `scan → scanning`，未定义扫描结束后的终态。前端用本地 8.5s 窗口推断「已扫描完」，状态仍为 `scanning`（宿主可继续推送更多设备）。
3. **`airplay.ts` 不校验 `v`**：为向前兼容按宽松解析；若将来 v2 语义不兼容，需要重新评估。
4. **密码错误无专用 code**：宿主若对错误密码回 `code:"internal"`/`"network"`，UI 只能显示宿主 `error` 文本；密码表单是否重新弹出取决于 `code==='passwordRequired'`。
5. **音量滑杆为单向乐观更新**：拖动时本地即时回显，随后以宿主回推为准；宿主不回推时数值仍显示本地值（发送是幂等的 volume 消息）。
6. **多设备切换不保留历史**：设备列表以宿主推送为准，断开后不缓存上次设备。
7. **页面隐藏/关闭时停止投送**依赖宿主（§12.3 规定宿主侧 TEARDOWN）；前端在 `spaceShell.destroy()` 时只 `stopScan`，未主动 `disconnect`，避免误断用户投送。
8. 自动冒烟驱动（`?airplaySmoke=1`）只在 dev 生效，生产被 `import.meta.env.DEV` 摇掉，不构成生产路径。
9. **多设备 `actives` 依赖宿主**：`docs/zilux2-host-contract.md` §12 尚未正式写入 `actives` / `disconnect.deviceId`（前端侧正在补）。当前按 任务 描述实现，宿主只回单个 `active` 时自动降级为单设备，UI 不会报错。
10. **第二台需要密码时状态是 `error`**：已投送设备继续播放，但状态机只有单一 `state`，UI 用「now 卡片 + 密码表单并存」表达；宿主若希望保持 `streaming`，需自行在 payload 里保留 `actives` 并置 `state:'streaming'`。
11. **逐台断开不做乐观删除**：点「停止」后等宿主回推 `actives`；若宿主忽略 `deviceId`（旧宿主），表现为全部断开。
12. **全局音量**：多设备共用一个 0–100 滑杆（契约 volume 无 deviceId），不能单台调音量。
13. **PIN 配对未与真实 Mac 联调**：`pair-setup`/`pair-verify` 的真实时序由宿主实现；前端只按契约识别 `connecting + code:'pinRequired'` 并回发 `action:'pin'`。契约写明等待 >120 s 超时失败并回 `code:"network"`，此时 UI 走通用错误条（「网络错误…」+ 宿主 error 文本），不自动重试配对。
14. **契约没有「取消配对」动作**：面板「取消」用 `disconnectDevice(deviceId)` 表达；若宿主不响应 `disconnect`，这台设备会在宿主的 120 s 超时后自行失败（前端只把 PIN 表单收起，不影响其它设备）。
15. **配对码不缓存在前端**：`pinSubmitted` 只是本地乐观标记；宿主任意后续推送都会复位它，配对成功与否以宿主 `streaming`/`error` 为准。前端不保存、不回显配对码，也不做重试次数限制。
16. **PIN 错误没有独立 code**：契约只定义了 `pinRequired`（索要配对码）与超时 `network`，未定义「码错误」的 code。宿主若对错误配对码回 `error + pinRequired`，UI 显示兜底文案「需要在 Mac 屏幕上输入配对码」；回 `network`/`internal` 则显示对应兜底 + 宿主 error 文本。重试需用户重新点「投送」。
17. **多设备「第二台失败但仍 streaming」的 error 字段未展示**（任务 契约补充）：§12.2 写明多设备投送时第二台失败走 `error` 字段但 `state` 保持 `streaming`，而当前解析只在 `state==='error'` 时读取 `code`/`error`（沿用 任务/15 语义），因此这类错误会被静默忽略、只在设备行状态上体现。若要提示，需在不改状态机的前提下派生「最近一次 streaming 错误」notice（后续可选，未擅自扩字段）。

## 8. 契约歧义与缺口记录（按最小合理实现，未擅自扩字段）

| # | 缺口/歧义 | 处理方式 |
| --- | --- | --- |
| 1 | §12.2 未说明 `v` 不匹配时页面应如何处理；也未给 payload 版本兼容规则 | 不校验 `v`，按字段存在性宽松解析；未知 state 丢弃整条、未知 code → null（不新增字段） |
| 2 | `passwordRequired` 错误事件**不回传 deviceId**，页面无法知道是哪台设备要密码 | 前端记录最近一次 `connect` 的 `targetDeviceId`，仅当该设备仍在列表时弹密码框；若列表已刷新则退回手动重连（宿主若愿回传 deviceId 可无缝增强，属可选扩展） |
| 3 | 扫描结束（8s 后）应推送什么事件未定义：无 `idle` 或 `scanComplete` | 前端不改 state，仅把本地空态文案切为「没有发现设备」，允许宿主随时继续推 scanning |
| 4 | `devices` 在非扫描态「可省略」，未说明是否应保留上一轮列表 | 前端沿用上次列表（避免连接弹密码时列表闪空），devices 缺失不会清空 |
| 5 | `active` 未说明 `volume` 变化时是否总带 `id`/`name` | 只按字段存在覆盖，缺字段沿用上次；`active` 仅在 streaming 时解析 |
| 6 | 契约未定义宿主对重复 `scan`、`connect` 进行中再次 `connect` 的行为 | 前端做最小防护：connecting/streaming 时设备按钮禁用；`scan` 可重复（契约允许刷新），UI 侧多面板用引用计数避免重复 stopScan |
| 7 | 派单文案称「深色玻璃/霓虹风格」，但仓库设计基线是**黑金暗色主题（默认）+ 白磨砂（可切）**（`base.css` 注明设计基线 v2 白色磨砂，`space.css` 默认 `.theme-gold` 黑金） | 以仓库真实设计系统为准，同时适配两套主题；未引入新视觉语言。此为文档措辞歧义，已上报 lead |
| 8 | 任务要求「设置面板 `web/src/ui/settingsPanel.ts` 加投送区块」，但该文件在真实应用中**未被任何入口 import**（死代码） | 投送区块改接在真实设置面板 `spaceShell.ts` 的 `.settings-sheet` 中；未改动死代码文件，避免维护两套设置 UI |
| 9 | 契约 §12.2 只定义了单数 `active`，**未定义多设备字段 `actives`**，也未定义 `disconnect` 可带 `deviceId` | 按 任务 描述做最小扩展：`actives` 为可选新增字段，缺失时用 `active` 降级单设备；`disconnect` 带 `deviceId` = 停单台、不带 = 全部。前端对两种宿主都能工作，未新增其它字段 |
| 10 | 多设备时音量仍是全局（§12.1 `volume` 无 `deviceId`） | UI 只提供一个音量滑杆并作用于全部投送设备；将来契约若加 `deviceId`，可扩展为 `setVolume(percent, deviceId?)` 且不破坏现有调用 |
| 11 | 多设备下 `state:'error'` 与「其它设备仍在投送」并存的语义未定义 | 前端视为「错误提示 + 继续投送」：`actives` 非空就显示 now 卡片，同时显示错误/密码表单；宿主若想区分可后续加字段，前端解析层已集中在 `onHostMessage` 一处 |
| 12 | §12.2 正文写「`code` 只在 `state:"error"` 时出现」，但 §12.1 的 Mac PIN 配对要求 `state:"connecting"` 阶段就推 `code:"pinRequired"`，两处自相矛盾 | 以 §12.1 为准：`connecting` 与 `error` 两种状态都识别 `code`；仅 `connecting + pinRequired` 视为「等待输入配对码」，`error + pinRequired` 视为配对失败/超时（错误条展示）。未新增字段 |
| 13 | PIN 错误事件同样**不回传 deviceId**（与 `passwordRequired` 相同问题），页面靠最近一次 `connect` 的 `targetDeviceId` 定位 | 与密码框一致：仅在 `state:'connecting'` 且 `targetDeviceId` 存在时显示配对码表单；若期间用户改了目标设备，表单会跟随最新目标 |
| 14 | 契约未定义 pin 动作的值格式/长度校验与「取消配对」动作 | 前端只接受 `/^\d{4}$/`（4 位数字，输入框自动剥离非数字并截断），非 4 位不发消息；取消用 `disconnect(deviceId)`，未新增 `cancelPin` 等字段 |
| 15 | 宿主「首次配对后凭据落盘、再连不再要 PIN」属于宿主侧行为，契约未说明重启/VPN 变化后是否重新要求配对 | 前端不做任何缓存假设：每次连接都等宿主事件；若宿主再次推 `pinRequired`，表单会重新出现（`lastPinDeviceId` 变化时自动清空输入并复位取消状态） |
| 16 | §12.2 新增「多设备投送时第二台失败也走 `error` 字段但 `state` 保持 `streaming`」，与「`code` 只在 `state:"error"` 时出现」仍冲突 | 当前解析只在 `error` 态读取 `code`/`error`，多设备 streaming 下的 error 文本被忽略（按设备行 `actives` 变化体现）；已在 §7 限制 17 记录。若 前端侧需要提示，最小改法是解析层派生 `streamingError` 字段（不改 state），需契约先明确该场景的 `code` 取值 |
| 17 | §12.2 的 `actives` 已正式写入契约（`streaming` 时非空、最多 32 台、`active` 为第一个元素），但 `disconnect` 带 `deviceId` 仍只在 §12.1 文字里描述 | 前端按 §12.1 实现（带 `deviceId` 停单台、不带 = 全部），与契约文字一致；旧宿主忽略 `deviceId` 时降级为全断（已在 §6/§7 记录） |

## 9. 自测方法（dev mock，无需 C# 宿主）

```bash
cd web
# npm 不在 PATH 时用：node node_modules/vite/bin/vite.js dev --port 5299
npm run dev -- --port 5299
```

- 浏览器打开 `http://127.0.0.1:5299/?airplayMock=1`：自动安装假宿主（4 台设备：客厅 HomePod（需密码 `zilux`）、书房 Sonos One、卧室电视、客厅 MacBook（macOS 接收器，首次连接要 4 位配对码 `1234`））。
  - 左侧栏投送图标 → 扫到 4 台 → 连「书房 Sonos One」→ 投送中、音量可调 → 再连「卧室电视」→ 状态变「已连接 2 台设备」、now 卡片出现 2 个 chip → 点某台「停止」只停该台 → 「全部停止」清空。
  - 连「客厅 HomePod」（需密码）→ 密码提示 → 输入 `zilux` → 成功；多设备投送中第二台要密码时，密码框与已投送清单并存。
  - 连「客厅 MacBook」→ 状态「「客厅 MacBook」等待 Mac 配对码」+ 青色配对码表单 → 输入 `1234` → 「正在配对…」→ 开始投送；「停止」后再连同一台 → 不再要配对码（模拟凭据已落盘）。输入框故意输错（如 `0000`）→ 宿主推 `error + code:'pinRequired'`，错误条提示后重新点「投送」重试。
  - 「取消」配对码表单 = 中止这台设备的配对（已投送的其它设备继续）。
- `http://127.0.0.1:5299/?airplayMock=1&airplaySmoke=1`：自动跑 9 阶段（连接+音量 → 密码 → 密码成功 → 同时投送两台 → 单台停止 → 全部停止 → Mac 要配对码 → 输入配对码成功 → 再连不再要 PIN），把每阶段状态写入 `<pre id="airplay-smoke-report-1…9">`，便于无头回归。
- `http://127.0.0.1:5299/?airplayMock=1&airplayLegacy=1`：模拟旧宿主（payload 只有 `active`，不支持多设备），验证前端兼容降级（单设备行为与 任务 一致，不报错）。
- 无参数直接打开：验证无宿主降级（不应出现任何报错）。

无头回归命令（Edge，9 阶段虚拟时间 24s）：

```bash
"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
  --headless=new --disable-gpu --no-sandbox \
  --user-data-dir=/tmp/edge-airplay-smoke --virtual-time-budget=24000 \
  --dump-dom "http://127.0.0.1:5299/?snap=1&airplayMock=1&airplaySmoke=1"
```

mock 仅由 `main.ts` 中 `if (import.meta.env.DEV && params.get('airplayMock') === '1') { await import('./dev/airplayMock') }`
动态加载，生产构建该分支与 chunk 均被消除（已在 `dist` 验证）。
