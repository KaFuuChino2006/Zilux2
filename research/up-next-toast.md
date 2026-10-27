# 顶部「即将播放 / 正在播放」预告条（2.6.16–2.6.17）

## 行为
- **预告阶段**：列表播放中，当当前歌曲剩余 ≤ 8 秒且队列里还有下一首时，窗口顶部居中弹出预告条（任意页面可见）。
  - 内容：下一首封面、`即将播放` 标签、歌名、`歌手 · 专辑`；
  - 右侧大号倒计时数字（每秒跳动一次，带 `unt-tick` 弹跳动画）+「秒后切换」+ 底部剩余进度条；
  - 出现动效：从上方滑下 + 淡入；离开阈值（切歌/暂停/进度拉回）自动滑回隐藏。
  - 整条可点击，点击立即切到下一首。
- **正在播放阶段**：切歌后预告条不立刻消失，而是切换为 `正在播放` 状态（`is-current`）：隐藏倒计时数字与进度条，保留封面/歌名/歌手，约 2.6 秒后自动收回。
- 单曲循环（`mode === 'single'`）不出现预告；随机播放仍按队列顺序给出「下一首」，与 `next()` 一致。

## 实现
- 新组件 `web/src/ui/upNextToast.ts`：`createUpNextToast(onSkip)` → `{ element, update(state), dispose() }`；
  - 状态机 `phase: 'hidden' | 'preview' | 'current'`，`lastTrackKey` 检测换歌、`lingerUntil` 控制「正在播放」驻留时间（`LINGER_MS = 2600`）；
  - 条件：`track && playing && !loading && mode === 'list' && queue[index+1]`，`remaining ∈ (250, LEAD_MS=8000]`；
  - 200ms 轮询刷新倒计时/进度；数字变化时重放 `unt-tick` 动画。
- `web/src/ui/app.ts`：`buildPlayerBar()` 后创建并挂到 app root；`syncPlayer()` 每帧 `update(state)`；`destroy()` 里 dispose。
- `web/src/styles/app.css`：`.upnext-toast`（`position:fixed; top:72px; left:50%; z-index:260`，否则会压住首页搜索框）、`.is-visible` 滑入/淡入、`.is-current` 隐藏倒计时、`@keyframes unt-tick`。

## 验证（CDP 真机，2.6.17）
- 播放队列 → 点进度条 98.5% → 顶部出现预告条（`is-visible`，`即将播放`，倒计时数字带 `is-tick`）；
- 点击预告条 → 曲目切换成功，预告条转为 `is-current`、标签变 `正在播放`、倒计时隐藏；
- 2.6 秒后自动收起（`is-visible`/`is-current` 均移除，`aria-hidden=true`）。
- 截图：`research/shots/app-upnext-4-preview.png`、`app-upnext-5-now-playing.png`。

## 安装包
`dist/Zilux2-Setup-2.6.17.exe`（13,033,153 B，SHA256 `89fbcd78e105c2bf07843e7285a7e0a606692837473477171bd0af028e46c788`），已静默安装到 `%LOCALAPPDATA%\Programs\Zilux2`。

## v3 · 单框形态（2.6.18）

反馈后（「你怎么做成两个框了，他们必须在一个框变换」「数字不要弹跳的，要渐变过渡」）重做为单框：
- 一个胶囊内切换「即将播放 / 正在播放」，不再并排两框；切换时内容用 130ms 淡出 + 170ms 淡入过渡。
- 倒计时数字改为透明度渐变（`transition: opacity .24s`），去掉此前 `unt-tick` 弹跳动画。
- 任意方式切歌（点预告条、播完自动切、播放条「下一首」）都会在同一框里显示「正在播放 · 新歌」约 2.6s 后自动收起；预告阶段显示下一首 + 剩余秒数 + 底部进度条。
- 顶部位置 72px（避免压首页搜索栏），宽 `min(420px, 82vw)`，z-index 260。
- 真机 QA（CDP）：remaining≈5.7s 时单框 `is-visible`、kicker「即将播放」、title「Candy Man」、sec 6；点击后同框 `is-current`「正在播放 Candy Man」且曲目切到 idx 2；2.5s 后自动隐藏。手动「下一首」同样出现当前曲目提示。
- 截图：`research/shots/app-upnext-6-preview.png`、`app-upnext-7-current.png`、`app-upnext-8-manual-next.png`。
- 安装包 `dist/Zilux2-Setup-2.6.18.exe`（13,033,665 B，SHA256 `0c3caa0cc8c50abe8df75ecc7a362b9790fb2b39b114166d15963187684e9f08`），已静默安装到 `%LOCALAPPDATA%\Programs\Zilux2`。

## v4 · 连续过渡（2.6.19）

反馈：「即将播放和正在播放不能直接过渡吗，倒计时结束后正在播放是又弹出一次显示的，不是一个动画的」。

- 根因：倒计时归零后先走到「隐藏」分支（`remaining <= MIN_REMAIN_MS` / 切歌瞬间），框先收起；下一帧检测到换歌又走 `enterCurrent()` 重新显示，于是看起来像两次独立动画。
- 修复（`web/src/ui/upNextToast.ts`）：
  - 临近切歌（`remaining <= 250ms`）且当前可见时**保持可见**，不隐藏，等换歌那一帧原地过渡；
  - 换歌时若当前曲目就是预告中的下一首（`lastPreviewKey` 命中），**只把 kicker 文案「即将播放」淡出/淡入换成「正在播放」**，封面/标题/歌手不重绘、不重放整体动画；
  - 倒计时与底部进度条改为透明度 + 宽度过渡（`opacity .2s` / `max-width .24s`），随 `is-current` 平滑收起；
  - 非预告来源的切歌（随机点播、手动下一首）仍走整体淡入淡出。
- 真机验证（CDP 逐 90ms 采样）：从预告到换歌共采样 58 帧，框始终 `is-visible`（`gapCount=0`、`minOpacity=1`），倒计时宽度 58→45→0、图标透明度 1→0、进度条 1→0.98→0，kicker 在切换后 ~300ms 淡变为「正在播放」，全程没有隐藏再弹出。
- 截图：`research/shots/app-upnext-9-continuity-preview.png`（即将播放 Static Body）、`app-upnext-10-continuity-current.png`（同框正在播放 Static Body）。
- 安装包：`dist/Zilux2-Setup-2.6.19.exe`（13,033,665 B，SHA256 `0259a0cfdcd2f0838d98441e5622818566cc744a0a8d381e5efc33589f891e40`），已静默安装到 `%LOCALAPPDATA%\Programs\Zilux2`。
