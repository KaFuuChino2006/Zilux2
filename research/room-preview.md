# 房间效果独立预览（room preview）

歌词页「房间」新场景引擎 `web/src/ui/roomScene.ts` 的快速迭代基建：**改代码 → 一条命令截图 → 看效果**。
预览页与 app 完全解耦，只依赖 `createRoomScene` 契约，不 import 应用其它模块。

| 文件 | 作用 |
| --- | --- |
| `web/preview-room.html` | 独立预览页外壳（`vite dev` 下访问 `/preview-room.html`） |
| `web/src/dev/roomPreview.ts` | 预览入口：内置假歌 `roomPreviewSong`、播放时钟、`window.__roomPreview`、调试角标 |
| `research/qa/room-preview-shot.mjs` | 一条命令完成截图（启动 vite + headless Edge + CDP 截图 + contact sheet） |
| `research/shots/room-preview-*.png` | 截图产物 |

> 不修改任何业务源码（`web/src/ui/`、`web/src/styles/`、`app.ts`、`web/dist` 等），也不新增依赖；
> headless 截图只用 Edge 自带 CDP + Node 内置 `WebSocket`/`fetch`，不需要 puppeteer。

## 一条命令截图

```bash
# 在仓库根目录 E:\Zilux2开发 执行
C:/Users/13329/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe \
  research/qa/room-preview-shot.mjs
```

默认行为：

1. 检查 `127.0.0.1:5173`，没在跑就启动 `vite dev`（`web/` 下、日志 `research/tmp/vite-dev.log`）；已在跑则直接复用。
2. 启动 headless Edge（`--remote-debugging-port=9333`，独立 `user-data-dir=research/tmp/edge-preview`，不会碰你正在用的 Edge）。
3. 依次对时间点 `10,22,40,65,90,130`（秒）导航到 `/preview-room.html?t=<秒>&play=0&debug=0`，
   等 `window.__roomPreview.ready`（画布首次出像后 resolve）→ `document.fonts.ready` → 额外等 500ms →
   用 CDP `Page.captureScreenshot` 存 `research/shots/room-preview-<秒>.png`。
4. stdout 打一份 JSON 摘要；结束杀掉自己启动的 headless Edge，**保留 vite dev** 供下次复用。

### 参数

```bash
node research/qa/room-preview-shot.mjs \
  --times 12,30,55.5 \      # 要截的时间点（秒，逗号分隔，默认 10,22,40,65,90,130）
  --out research/shots/room-preview \  # 输出前缀；相对路径相对仓库根目录，产物 <out>-<秒>.png
  --w 1600 --h 960 \        # 视口尺寸（同时作为 Edge window-size 和 CDP 视口，默认 1600×960）
  --extra-wait 500 \        # ready 之后额外等待毫秒（字体/首帧稳定，默认 500）
  --ready-timeout 30000 \   # 等 ready 的超时毫秒（默认 30000）
  --sheet \                 # 额外拼 2 列缩略图 contact sheet 到 <out>-sheet.png（需要 python + Pillow）
  --stop-dev                # 跑完把 vite dev 也杀掉（默认保留）
  --help
```

示例（ 验收换行过渡帧）：

```bash
node research/qa/room-preview-shot.mjs \
  --times 8.6,40.4,40.7,41.0,41.3,75,120,200 \
  --out research/shots/room-final --sheet
```

产物：`research/shots/room-final-8.6.png` … `room-final-41.png`（41.0 秒会写成 `41`）、
`room-final-200.png` 与 `room-final-sheet.png`（2 列缩略图，每格带 `t=<秒>s <文件名>` 标签）。

截图脚本示例输出（`shots[].painted` 会给出画布采样情况）：

```json
{
  "ok": true,
  "shots": [
    { "timeSec": 10, "ready": true, "ok": true,
      "path": "E:\\Zilux2开发\\research\\shots\\room-preview-10.png",
      "positionMs": 10000, "consoleErrorCount": 0, "exceptionCount": 0,
      "painted": { "canvasCount": 1, "nonBlackRatio": 1, "textChars": 201 },
      "perf": { "frames": 300, "fps": 199.9, "avgUpdateMs": 0.45, "p95UpdateMs": 0.6, "maxUpdateMs": 1.0 } }
  ],
  "edge": { "stopped": true, "portFreed": true },
  "devServer": { "started": true, "stopped": false }
}
```

每张图截完后会再用真实播放路径（逐帧 `scene.update`）采样 1.5s，得到 `shots[].perf`：
`fps` 是 headless 下 rAF 实际帧率（不锁 60Hz，通常 ~190-210），`avgUpdateMs/p95UpdateMs` 是单帧 JS+绘制耗时，
看有没有掉帧趋势用后者更可靠。`positionMs`/`consoleErrorCount` 用于确认 `?t=` 定位生效、页面无 console error。

- `ok=false` 或 `shots[].ready=false` 时**也会截图**（方便看是否黑屏/报错页），并带上 `readyDetail` 与页面文本。
- `diagnostics.exceptions / consoleErrors / logEntries` 收集页面异常与 vite 报错浮层信息。
- `--sheet` 拼图需要带 Pillow 的 python：脚本会依次探测 `PYTHON` 环境变量、`python`、`python3`、`py -3`、
  以及 DSH 运行时自带的 `~/.dsh/dsh-runtimes/*/dependencies/python/python.exe`。系统 `python` 是 Microsoft Store
  占位时会自动跳过。

## 手动看效果

```bash
cd web && node ./node_modules/vite/bin/vite.js --port 5173
# 浏览器打开：http://127.0.0.1:5173/preview-room.html
#   ?t=120      定位到 120s（默认 10s；第一行歌词在 8s）
#   ?play=0     暂停在该位置（默认 1，自动播放）
#   ?debug=1    左上角极简角标：当前时间 / 行号 / 词数
```

控制台可直接操作：

```js
window.__roomPreview.seek(65_000);   // 跳到 65s
window.__roomPreview.play();          // 继续播放
window.__roomPreview.pause();         // 暂停（会补渲染几帧让镜头/淡入收敛）
window.__roomPreview.positionMs;      // 当前播放位置（毫秒）
await window.__roomPreview.ready;     // 首次出像后才 resolve
window.__roomPreview.scene.resize();  // 手动 resize
```

`ready` 在 `createRoomScene({ onPainted })` 的 `onPainted` 回调（画布首次出像）后 resolve，
截图脚本就是靠它判断「页面真的画出来了」，而不是简单 sleep。

预览页 `<head>` 已声明真实字体，和 app 一致：

```html
@font-face {
  font-family: 'Zilux2 Sans SC';
  src: url('/fonts/zilux2-sans-sc-regular.ttf') format('truetype');
  font-weight: 400;
}
```

字体文件由 vite 从 `web/public/fonts/` 提供（7.6MB，`/fonts/zilux2-sans-sc-regular.ttf`），
截图脚本会等 `document.fonts.ready` 后再截，所以截图里的字形就是 app 的字形。

## 假歌 roomPreviewSong

- `web/src/dev/roomPreview.ts` 内置，40 行、中英混合、逐词 `startMs/endMs`，总时长 240s；
- 第一行 `timeMs = 8000`；为方便截到不同歌词状态，前 9 行压缩在 27s 内（首行 8s，随后行间隔 2.2~2.6s），
  之后行间隔 6.9~7.0s，最后一行 235.2s 起、4.8s 收尾；
- 每行 `durationMs` 按 前端侧要求 clamp 到 4000~6000ms（与行间隔解耦，行尾轻微重叠属预期）；
- 部分行带 `translation`，方便检查翻译行排版；
- 数据是 QRC 风格（`RoomSceneSong`），改完 `roomScene.ts` 直接刷新预览页即可，不必开 app / 载入真歌。

## 排错

| 症状 | 处理 |
| --- | --- |
| `127.0.0.1:5173 已被别的项目占用` | 脚本只在 5173 的页面像 Zulix2 时复用。查占用：`netstat -ano \| findstr :5173`，再 `taskkill /PID <pid> /T /F`。 |
| 端口 5173 起不来 | 看 `research/tmp/vite-dev.log` 尾部；确认 `web/node_modules/vite/bin/vite.js` 存在（不要 npm/pnpm 安装）。 |
| 9333 上有残留 Edge | 脚本启动前会自动清掉占用 9333 的旧 headless 进程和自己的 `SingletonLock`；若仍失败，`netstat -ano \| findstr :9333` 后按 PID 杀，**不要** `taskkill /IM msedge.exe`（会误杀你的正常 Edge）。 |
| 截图黑屏 / 空白 | 看 JSON 里 `shots[].readyDetail`、`painted.nonBlackRatio`、`diagnostics.exceptions`。`ready=false` 通常是 `roomScene.ts` 语法/运行时报错（vite 会盖错误浮层，`readyDetail` 里含页面文本）。`ready=true` 但黑屏多为 root 尺寸为 0，检查是否在 `document.body` 下、`#stage` 是否 `fixed inset:0`，或加 `--extra-wait 800`。 |
| 中文/译文没渲染出来 | `document.fonts.ready` 已经等过；若字体尚未加载完，加大 `--extra-wait`。字体本身缺失时浏览器会回退，不影响判断布局。 |
| 截图时间点画面一样 | 用 `?play=0` 时位置是静止的，不同 `--times` 应该看到不同歌词行；若一样，检查 `scene.update(positionMs, false)` 是否在暂停时也重绘。 |
| contact sheet 失败 | 需要 Pillow：设置 `PYTHON` 指向带 Pillow 的 python.exe（DSH 运行时自带 `...\dependencies\python\python.exe` 已有 Pillow 12.x）。 |
| 想清掉后台进程 | 默认 vite dev 会保留复用；`--stop-dev` 杀掉它。headless Edge 每次跑完都会被脚本杀掉。 |
| TS 类型检查 | `C:/Users/13329/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe web/node_modules/typescript/bin/tsc -p web/tsconfig.json --noEmit`；`roomPreview.ts` 只依赖 `web/src/ui/roomScene.ts` 的契约，接口不一致会直接编译报错。 |

## 契约速查（roomScene.ts 导出）

```ts
export interface RoomSceneWord { text: string; startMs: number; endMs: number; spaceBefore?: boolean }
export interface RoomSceneLine { timeMs: number; durationMs: number; text: string; translation?: string; words: RoomSceneWord[] }
export interface RoomSceneSong { title: string; artist: string; album?: string; durationMs: number; lyricOffsetMs?: number; lines: RoomSceneLine[] }
export interface RoomSceneOptions { onPainted?: () => void }
export interface RoomScene {
  root: HTMLElement;                                  // 自带 scoped css，absolute inset:0
  setSong(song: RoomSceneSong | null): void;
  update(positionMs: number, playing: boolean): void;  // 每 rAF 调用，毫秒
  resize(): void;                                      // 容器尺寸变化时调用
  dispose(): void;
}
export function createRoomScene(options?: RoomSceneOptions): RoomScene;
```

预览页启动顺序与 app 一致：`createRoomScene` → `append(root)` → `resize()` → `setSong(song)` →
`update(初始位置, false)`；播放时每 `requestAnimationFrame` 用 `performance.now()` 推进 `positionMs` 并 `update(positionMs, true)`；
暂停时位置不动，但会补渲染 36 帧（`SETTLE_FRAMES`）让镜头阻尼/淡入收敛，保证截图稳定。
