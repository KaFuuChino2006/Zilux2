# Zilux2 v1.2.0（本地构建）发布说明

> 构建时间：2026-11-06 22:26（Asia/Shanghai）
> 产物：`dist\Zilux2\Zilux2.exe`（47,676,693 B，框架依赖单文件）+ `web/` 载荷（10,262,738 B，`main-CelmNPVa.js`；新增顶部双击最大化，并修复 appBackground.ts 损坏导致构建失败）
> 已同步安装目录：`C:\Users\13329\AppData\Local\Programs\Zilux2`

## 一、本版亮点

### 1. 真·人声分离（HTDemucs v4 / ONNX Runtime）
- 用 HTDemucs 真分离替换原先的 220 Hz / 4.2 kHz 搁架 EQ「假分离」。
- 播放条新增文字按钮：**原声 / 伴奏 / 人声**，三态循环、记忆选择；未缓存时才提示「首次分离约需 7 秒」。
- 自动过渡使用分离轨做**分层混音**：B 入场前 38% 只叠伴奏，随后 35% 过渡时长把人声交叉进来。
- 「尾小节循环」开关（快捷设置 → 过渡，默认关闭）：计划阶段预取 A 的尾窗（不再要求计划生成时就已缓存），到过渡触发点再按缓存是否就绪决定是否延长一个小节；循环本身播 2 个小节，覆盖 A 原本尾小节 + 延长的这一小节，避免 A 提前静音。失败静默回退原路径。已用事件日志验证过 `tail-loop-plan` → `fade-start` → `stems-on` → `tail-loop` 链路；修复后的版本因当前有一个无 DevTools 的高权限实例在跑，未能再次自动化复验，需人工听感确认。
- 修复：曲尾不足一个 30 s 窗口时（例如只剩 3 s / 17 s / 22 s）分离会报 `Index was outside the bounds of the array.` 的问题——现在把短窗口补静音到模型段长再推理、只保留真实帧数；同时把末窗帧数校验容差放宽到 0.2 s（原先 64 帧太严，会让尾窗缓存永远 miss、`/api/stems/audio` 404 并触发重复重算）。实测 3 s 尾窗 2.9 s 算完（frames=133,030）、17.6 s 尾窗 4.1 s（frames=776,866）。
- 缓存：`%LOCALAPPDATA%\Zilux2\stems\`，上限 512 MB，最旧淘汰；模型：`%LOCALAPPDATA%\Zilux2\models\htdemucs-dft-fp16-transparent.onnx`（可用 `ZILUX2_STEMS_MODEL` 覆盖）。
- 实测：30 s 窗口首算 ~6.5–8.5 s（12 线程）、缓存命中 <100 ms；`instrumental = mix − vocals` 统一 headroom 后无削波。

### 2. 过渡增强
- 自动过渡时长**量化为整小节**（去掉半小节切换的拖沓）。
- 对速方向修正：过渡中由正在播放的 A 缓变到 B 的 BPM（B 保持原速）。
- 界面/歌词切歌延迟到 B 真正开口，不再出现「A 还在唱、歌词已切下一首」。

### 3. 原生接口优先（QQ 音乐 / 网易云）
- 取流：原生优先、web 兜底；原生档位不足时探测同档 web，更高才替换。
- 歌词：QQ musicu（lrc+trans，QRC 仍由 web 补齐）、网易 eapi（lrc/tlyric/yrc）原生优先。
- 搜索 / 热门歌单 / 发现页榜单 / **QQ 榜单详情** / 歌单广场 / 推荐歌单 / 私人漫游 / 网易账号库（我的歌单、每日推荐、最近播放、喜欢列表）均原生优先、web 兜底。
- QQ 榜单详情改走原生 `musicToplist.ToplistInfoServer/GetDetail`（匿名可用；`songInfoList[]` 含 `mid`，可驱动取流），失败才回退 `c.y.qq.com` fcg 详情；实测 `id=4` → 100 首、127 ms，日志 `qq.native chart detail ...`。
- 保护：单次 5 s 超时；同一 provider 连续 2 次失败停 60 s；日志统一 `qq.native ...` / `netease.native ...`，不含 token/cookie/完整 URL。
- 实测（匿名 harness + 运行中应用日志）：取流网易 3/3、QQ 3/3；歌词网易 6/6、QQ 6/6；搜索 190–250 ms/10 条；发现页榜单/歌单/推荐均 70–160 ms；应用启动后日志确认 `netease.native library ...`、`qq.native hotlists ...` 已生效。
- QQ 账号库 headless：`/api/library/overview` 两平台 `loggedIn=true`（qq 小智之乃 vip）；`/api/library/feed?source=qq` 返回每日推荐 30 首（`POST qq/library feed daily ok 162ms`）。喜欢/取消喜欢写操作仍走 web。
- **网易云「心动模式」接入**：宿主新路由 `GET /api/netease/intelligence?playlist=&songId=&count=`，走登录态 eapi `/api/playmode/intelligence/list`（`fromPlayOne`）；首页「网易云收藏」卡片新增「心动模式」按钮——以「我喜欢的音乐 + 当前歌曲」为种子，取 30 首智能续播队列直接入队。未登录返回 `409 login-required`。headless 实测：HTTP 200 / 30 首（首曲《真心话大冒险》158.7 s），`title/artist/durationMs` 映射正确。

### 4. 歌词
- 逐字歌词（QRC/YRC）丢失同平台译文轨的问题修复（±1 s 一对一贪心配对，过滤占位/重复）。
- 歌词选择页不再截断 14 行（完整渲染）。
- 「关闭模式」歌词：已播放/未播放统一半透明白、当前行辉光白；歌曲信息按封面明暗自动反差色。
- 长句放大按剩余宽度自动收窄，避免右侧被裁切。

### 5. 界面 / 窗口
- 快捷设置顶部常驻「封面 + 歌名 + 收藏」，切页等比缩成一行小卡；切 tab 的二次弹高与封面瞬跳修复。
- 设置重构为主/子两级；新增缓存三项（占用/上限/位置）、开发者页（DevTools、日志目录、缓存目录、FPS、布局描边）。
- 窗口：无边框 + Win11 DWM 圆角（Win10 SetWindowRgn 回退）、启动首帧后淡入、任务栏恢复不再白框、多屏 DPI 拖动修复。
- 首页响应式：带鱼屏内容宽度上限放宽到 78vw / 2560 px；2040 宽收藏卡重叠修复。
- 「纯字」播放效果修复灰雾：浅色主题的歌词遮罩不再把黑底舞台抬灰。

### 6. 其他修复
- 网易云「别人添加的喜欢歌单」不再被识别成「我的喜欢」。
- 网易云 VIP 曲兜底 eapi 30 s 试听。
- 快捷设置切 tab 高度抽搐、歌词来源需点两次（隐形取色框遮挡）修复。

## 二、需人工验证（听感 / 交互）
1. **自动过渡听感**：整小节量化、A→B 对速、B 分层人声交叉、尾小节循环（需在快捷设置 → 过渡打开，且该曲尾奏已分离缓存）。
2. **人声分离听感**：播放条三态切换；首次 7 s 计算期间是否可接受（当前先放原声）。
3. **多屏交互**：双屏 100%↔125%/150% 拖动、四边/四角缩放、贴边按钮点击（程序化移动已验证，真实鼠标拖动未自动化）。
4. **Win10**：SetWindowRgn 圆角是否有锯齿（本机为 Win11）。
5. **登录态账号接口**：网易账号库已在运行日志中走原生（`netease.native library ...`），但 QQ 登录态、喜欢/取消喜欢写操作仍走 web。

## 三、未打通 / 已知限制
- 心动模式需要网易云登录态（匿名 301）；队列约 30 首，暂不自动在播完后续排。
- QQ 匿名取流封顶 128 kbps、网易匿名 ≤320 kbps；高清/无损需登录 Cookie。
- QQ 原生歌词只取 LRC+翻译，逐字 QRC 仍由 web 补齐。
- 私人漫游匿名只回 1 首（登录后约 3 首/批），登录态未实测。
- 分离模型需手动放置（或 `ZILUX2_STEMS_MODEL` 指定）；缺失时自动回退 EQ 并置灰。

## 四、验证记录（摘要）
- `dotnet build src/Zilux2/Zilux2.csproj -c Release` → 0 警告 0 错误。
- `dotnet build ... -t:Rebuild` → 0 警告 0 错误。
- harness（%TEMP%）：取流/歌词/搜索/发现/榜单/私人漫游全绿；熔断 2 次失败后 60 s skip；5 s 超时生效。
- 心动模式 headless harness（`.scratch/heartbeat-harness`）：启动 OnlineMusicService（固定 token）→ `GET /api/netease/intelligence` → HTTP 200、30 首、首曲映射正确；provider 直连 eapi 亦返回 30 首。
- QQ 榜单详情 headless harness：`GET /api/discover/chart?source=qq&id=4&offset=0&limit=5` → HTTP 200、`流行指数榜`、count=100、5 首、`qq.native chart detail id=4 ... total=100`、127 ms；`offset=2` 分页返回第 3–5 名，确认分页正确。
- QQ 榜单矩阵补充：`id=26` → HTTP 200、`热歌榜`、count=299、首曲 `Hong Kong (feat. 王菲季候风)` 216 s、`playable=true`（`qq.native chart detail id=26 ... total=299`）；非数字 id 走 web 兜底，HTTP 200「排行榜」且无异常。
- 应用实跑（安装目录、CDP 9223）：启动日志出现 `netease.native library playlists ok 162ms`、`qq.native hotlists ok count=14 185ms` 等。

## 五、2026-11-06 21:03 之后：启动崩溃（环境问题，非本版本代码）

现象：本版本（以及同一台机器上任意 WPF 程序）启动即崩：

```
出错模块名称： d3d9.dll
异常代码： 0xc0000005
错误偏移： 0x00000000000607e8
```

最小复现：一个新开的 PowerShell 5.1 STA 会话里 `New-Object System.Windows.Window; $w.Show()`
同样崩溃。已排除 stems 容差、WebView2 用户数据目录、单文件解包缓存、WebView2 控件本身
（去掉 XAML/控件仍崩）、强制软件渲染。判断为反复强杀运行中实例后显示/驱动栈进入坏状态。

**处理：重启电脑（或注销重登）后即可恢复。** 详细证据与验证步骤见
`docs/agents/crash-d3d9-2026-11-06.md`。

诊断增强：设置环境变量 `ZILUX2_SYNC_LOG=1` 时 `HostLog` 改为同步写盘，崩溃前的最后
一行不会因异步队列丢失。

重启后一键验证：`pwsh -File tools\post-reboot-verify.ps1`（WPF 探针 → 启动应用 →
尾小节循环事件验证 → 三屏移动 → 写 `docs/verification-post-reboot-*.md`）。
原生覆盖与证据汇总见 `docs/native-coverage-2026-11-06.md`。

## 六、2026-11-06 22:00 重启后：尾小节循环闭环 + 多屏程序化验证

- 环境恢复：22:00:43 重启后 D3D9 正常，应用可启动；带 `ZILUX2_DEV=1` +
  `--remote-debugging-port=9223` 启动用于自动化。
- **短尾窗 404 修复**：`StemSeparationService.FramesMatchRequest` 的末窗容差统一为
  `max(64, SampleRate / 5)`（0.2 s）。此前 `stems.done window=6 frames=223391` 之后
  `/api/stems/audio` 必 404，前端便判定「未缓存」、尾小节循环永不启动。
- **尾小节「提前收尾」修复**：`crossfadeDeck.buildSchedule()` 校验分析时长与当前元素时长
  （相差 >1.5 s 记 `analysis-mismatch` 并回退到元素实际时长）；循环点如果晚于 fade 终点，
  过渡时长顺延到循环放完（`loopUntil - positionMs`），不再出现「循环还没开始 fade 就结束」。
- **端到端 PASS**（CDP 9223、真实播放/seek）：
  `tail-loop-plan|A 尾小节循环 2242 ms ×2，过渡延长到 9794 ms（循环点 147492 ms）` →
  `fade-start` → `tail-loop|A 尾小节开始循环 2242 ms ×2` →
  `tail-loop-hold|A 元素播完，交给尾小节循环继续过渡`；脚本输出 `"ok": true`。
  说明：循环点离 fade 起点较远时过渡会明显变长（本例 9.8 s），这是「延长过渡」的预期行为，
  该开关默认关闭。
- **失败回退验证**：尾窗尚未缓存时记 `tail-loop-skip` 并保持原过渡时长（实测复跑即走此路径）。
- **多屏程序化验证 PASS**：三屏 3440×1440@0,0（主）/ 2560×1440@418,-1440 /
  1080×1920@-1080,-487；窗口 1600×960@920,216、dpi 96；逐屏落点
  `-1080,-31 / 898,-1224 / 920,216` 全部 OK，结束恢复原位。
- 诊断事件：`tail-loop-arm` 已移除；`analysis-mismatch` 保留（仅在分析/播放文件时长不一致时记录）。
- **顶部双击最大化**：顶部空白带（clientY ≤ 84，避开按钮/搜索/播放条/面板/窗口按钮/缩放热区）
  双击调用 `host.toggleMaximize()`；CDP 实测 1600×960 → 3440×1392（工作区）→ 1600×960。
- **最大化后拖动还原**：拖动已最大化窗口时先按指针相对位置还原到最大化前的矩形
  （优先用 `ToggleMaximize` 记录的 `_restoreRect`，而不是 `RestoreBounds`——自定义最大化后
  `RestoreBounds` 会等于最大化矩形），再交给系统 move loop。真实鼠标实测：
  3440×1392@0,0 → 拖动后 1600×960@342,162，宿主日志 `window.drag restore from maximized ... 1600x960`。
- **构建修复**：`web/src/ui/appBackground.ts` 第 40 行出现损坏字节（非法字符导致 `tsc`
  报 TS1127/TS1434），已从 `HEAD` blob 恢复该文件后重新构建通过。

仍需人工确认（无法自动验证）：过渡/分离听感（整小节量化、A→B 对速、B 分层人声交叉、
真实分离、尾小节循环）、真实鼠标跨屏拖动与四边四角缩放/贴边按钮。
