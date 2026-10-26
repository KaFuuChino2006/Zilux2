# Zilux2 上下文交接（HANDOFF）

> 更新时间：2026-10-26（v1.1.9 待发：迷你播放器 v2 + 六轮用户报障修复 + 首页「私人雷达」+ 歌词海报移除 + 无缝过渡倒计时提示 + 本地歌单渲染与「添加歌曲」入口 + 歌词页可读性/遮罩/尾部可见度 + 歌词播放样式（经典/发光/渐变/频谱）；已推 main：第三十轮（歌词播放样式）、第三十一轮（渐变叠字重影修复）、第三十二轮（歌词播放样式改版：只留经典 + 5 种播放动画）、第三十三轮（系统媒体键接管）、第三十四轮（上浮样式下方歌词统一最低可见度）、第三十五轮（歌词样式二轮微调：弹跳重做 / 打字机隐藏未唱行 / 漂浮改旋入）、第三十六轮（旋入改为文字随机飘入组成句子）、第三十七轮（旋入未播放歌词统一最低可见度）、第三十八轮（旋入未播放歌词按距离打乱、越靠近越整齐）、第三十九轮（旋入换行不再重新组装、靠近播放的歌词保持半散逐步收拢）、第四十轮（旋入等新样式恢复唱过字的缩小落回动画）、第四十一轮（歌词样式弹跳换成摇曳）；**未打 tag**，等用户测试确认后发 Release）
> 当前版本：**1.1.9**（唯一来源：根目录 `Directory.Build.props`；已构建并装到本机供用户测试，含第二十二轮修复与私人雷达；tag `v1.1.9` 待用户测试确认后推送，届时 Actions 构建 `Zilux2-Setup-1.1.9.exe`）
> 代码仓库：`KaFuuChino2006/Zilux2`（**private**；Releases 已有 v1.1.0 / v1.1.1 / v1.1.2 / v1.1.3 / v1.1.4 / v1.1.5 / v1.1.6 / v1.1.7 / v1.1.8；**v1.1.9 未发**）
> 最新一轮快照：`research/HANDOFF-2026-10-26.md`（2026-10-26：宣传片交付 + 歌词播放样式改版 + 系统媒体键接管 + 上浮样式下方歌词统一可见度 + 旋入未播放行打乱与连续收拢 + 唱过字缩小落回 + 弹跳换摇曳 + v1.1.9 待发状态）。
> 本文件给下一个接手的 AI / 开发者：读完即可继续开发。

## 0. 交接速览（先读这里）

- **在做什么**：Windows 桌面音乐播放器 Zilux2（WPF + WebView2 宿主 + Vite/TS 前端），已具备完整播放器、在线音乐、发现页、房间/歌词效果、本地曲库、GitHub 自动更新。
- **当前状态（2026-10-26 交接时）**：`main` 已推送至第四十一轮（歌词样式「弹跳」换成「摇曳」：唱完的字左右摆两下再停稳，构建 `main-DLE0ARgU.js` / `main-DFtEvpq1.css`，宿主仍是第三十三轮构建）；版本 **1.1.9**（已 bump、已构建并安装到本机供用户测试，**tag `v1.1.9` 未推、Release 未发**）。第二十二~三十八轮的修复与功能均已推 `main`，与 1.1.9 合并交付；第三十轮为歌词播放样式（`lyricStyle.ts` + `lyrics.ts` / `app.ts` / `app.css`），第三十一轮为渐变样式重影修复（逐字 `--lyric-grad` 取代 `background-clip: text`）；第三十二轮按用户要求把样式行收敛为「经典 + 上浮 / 波浪 / 弹跳 / 打字机 / 漂浮」，删除发光 / 渐变 / 频谱；第三十三轮解决用户报障「系统原生切换在其他页面不生效」——QQ 音乐等程序用 RegisterHotKey 抢注键盘媒体键，改用 WH_KEYBOARD_LL 钩子在 Zilux2 是当前媒体会话时接管（详见 §8 与 `research/UPDATES-2026-10-25.md` §39）；第三十四轮把「上浮」样式当前行下方的歌词统一压到最低可见度（`app.css` 上浮段兄弟选择器 `opacity: 0.2`），不再按距离逐行渐隐，当前行与上方已唱行不变（详见 §40）；第三十五轮按用户反馈重做「弹跳」（改为一次性 `@keyframes lyric-style-bounce`：唱到弹起、0.46s 落回，不再整行慢慢回落）、「打字机」下当前行下方未唱行完全不可见（`opacity: 0`）、「漂浮」改成「旋入」（`float` → `spin`，逐字带 -16deg 旋转落位，`charTiming: true`）（详见 §41）；第三十六轮把「旋入」改成文字随机飘入组成句子——每个字从随机方向 / 距离 / 角度飘回原位（`--drift-x / --drift-y / --drift-rot / --drift-dur` 稳定伪随机，散落字 opacity .12，唱到才归位），详见 §42；第三十七轮把「旋入」样式下当前行下方未播放的整行歌词也统一到最低可见度（`opacity: 0.2`，与上浮一致），不再按距离逐行渐隐（详见 §43）；第三十八轮让「旋入」样式下当前行下方未播放的整行歌词本身按距离打乱（`--scatter`：越远散得越开、越近越整齐，播放推进时逐行收拢），轮到该行播放再切回逐字飘入（详见 §44）；第三十九轮把 `--scatter` 改为整列共用的连续系数（当前行 0.6 半散、往后每行 +0.15 到 1.0、已唱行 0），当前行承接上一行的半散状态逐字归位、换行不再整行重新组装（详见 §45）；第四十轮修复新样式（上浮 / 打字机 / 旋入）覆盖 `transition` 时漏掉 `transform`、唱过的字缩小落回动画消失的问题，补回 `transform 0.18s / 0.34s` 过渡并在样式段头写明该约定（详见 §46）。第四十一轮把「弹跳」换成「摇曳」——删掉向上弹跳的 keyframes，改为唱完瞬间由 `.is-sung` 触发的左右摆动（`rotate` -7° → 6° → -3° → 0，0.52s），老存档 `bounce` 通过 `LEGACY_STYLES` 自动迁移到 `swing`（详见 §47）。
- **最近提交（由新到旧）**：第四十一轮（歌词样式弹跳换成摇曳，本轮，`2da0d2b`）、第四十轮（恢复唱过字缩小落回动画，`3d6e757`）、第三十九轮（旋入换行不再重新组装，`0a7e070`）、第三十八轮（旋入未播放歌词按距离打乱，`a44a55a`）、第三十七轮（旋入未播放歌词统一最低可见度，`2ff8dee`）、第三十六轮（旋入改为随机飘入组成句子，`16228c0`）、第三十五轮（歌词样式二轮微调，`ca911ef`）、第三十四轮（上浮样式下方歌词统一可见度，`80d7b55`）、第三十三轮（系统媒体键接管，`187b5d3`）、第三十二轮（歌词播放样式改版，`95aa96a`）、第三十一轮（渐变歌词叠字重影修复）、第三十轮（歌词播放样式：经典/发光/渐变/频谱）、`206c3e3`（第二十九轮：歌词接近尾部可见度修复）、`254fa16`（第二十八轮：歌词页可读性 + 大窗口左侧发虚）、`94852ad`（第二十七轮：本地歌单「添加歌曲」入口）、`b2b28d1`（第二十六轮：本地歌单行渲染修复）、`d746f63`（第二十五轮：常驻展开悬停位移修复）。
- **本轮已完成（2026-10-25 v1.1.9）**：①迷你播放器排版/画面 bug：卡片化布局（400×100 悬浮卡片、44px 封面、单行标题、进度条贴底不再裁切、hover 不再改变尺寸、隐藏所有非迷你控件、doc 无溢出）；②进出动画：宿主 `BeginWindowMotion` 窗口补间（320ms 进 / 380ms 出、EaseInOutCubic）+ 页面幕布与卡片关键帧过渡；③用户报障：迷你窗口「正方形框」（宿主 `SetWindowRgn` 16 DIP 圆角裁剪 + 页面满窗铺 `--panel-solid` + `Browser.Margin` 清零）、「hover 播放键/歌名位移」（迷你态逐条 `!important` 压死普通窗口 hover/expanded 规则）、顶部预告条倒计时「秒后切换」在过渡/收回时闪现（`is-preview` class + `transition: none`）；④首页「私人雷达」卡片（网易云个人化歌单 id `3136952023`，宿主 `GetPrivateRadarAsync` + `kind=radar`，与今日推荐并排两列 + 雷达墙 + 播放全部）；⑤按要求删除「歌词海报」功能；⑥无缝过渡准备完成后播放条上方弹出「将在 X 后过渡至 xxx（过渡约 Y 秒）」倒计时提示（`readCrossfadeDebug` + `syncSeamlessHint` + `.pb-seamless-hint`，约 4.2s 自动消失、同一轮只弹一次，迷你态自动隐藏、淡化中隐藏）；⑦用户报障：开启「播放条常驻展开」时悬停播放条内容位移 2px（`html.is-pb-expanded .playerbar .pb-meta` 补 `margin-left: 6px`，与 hover 同值）；⑨本地歌单加歌入口（用户 m03889 提问）：「我的歌单」行内新增「+」按钮、歌单墙新增「添加歌曲」按钮，打开「添加歌曲到『歌单名』」面板——搜索/点击本地曲目即加入（只列未加入的曲目，可连续添加），空歌单打开时自动弹出该面板；复用 `localTracks/trackKeyOfTrack/addTracksToPlaylist`，`dom.ts` 新增 `plus` 图标。⑧用户报障：本地歌单新建后在「我的歌单」弹层显示为整行空卡片——`.local-playlist-cover` 未限定作用域（`width:100%; aspect-ratio:1`）把行封面撑满整行、把歌单名与操作按钮挤出，改为 `.local-playlist-card .local-playlist-cover` 并新增 `.local-playlist-host .row-cover` 居中占位（构建 `main-BaoS7TO4.js` / `main-BeBJAJgp.css` 已部署）。⑩歌词播放样式改版（2026-10-26，用户要求只留经典并新增播放动画）：`lyricStyle.ts` 重写为 classic / rise / wave / bounce / typewriter / float 并写死「歌词效果制作模板」；`lyrics.ts` 删除频谱 / 渐变代码，普通 LRC 行也切 `.lyric-char`（`splitPlainTokens` + 内联 `--ci`）并按句内进度合成 is-sung / is-hot（`syncPlainCharStates`）；`app.css` 用独立 translate / scale + `@media(prefers-reduced-motion:no-preference)` 实现上浮 / 波浪 / 弹跳 / 打字机 / 漂浮 5 种播放动画，快捷设置样式行 6 按钮。⑪系统媒体键接管（2026-10-26，用户报障「系统原生切换在其他页面不生效」）：根因是 QQ 音乐等程序用 RegisterHotKey 抢注键盘媒体键（探测程序注册 VK 0xB0/0xB1/0xB3 全部 `error=1408`），SMTC 的 ButtonPressed 收不到；新增 `src/Zilux2/Media/MediaKeyHookService.cs` 用 WH_KEYBOARD_LL 钩子接管——仅当「快捷键总开关开启 + Zilux2 是当前媒体会话」时吞下媒体键并走同一条 `SendCommand` 命令链（0xB0→next / 0xB1→prev / 0xB3→togglePlay，0xB2 不接管；自动重复只触发一次、keyup 一并吞掉，注入按键放行），`MediaSessionService` 增加 `GlobalSystemMediaTransportControlsSessionManager` 当前会话跟踪与 `IsCurrentSession`，`MainWindow` 在 `OnSourceInitialized` 装钩子 / `OnClosed` 卸载，`app.ts` 快捷键设置页补媒体键说明；实测钩子安装成功、媒体键触发 `mediakey.fire` → 页面暂停，QQMusic 未收到（绕过抢占）。⑫上浮样式下方歌词统一最低可见度（2026-10-26，用户要求「这个上浮的时候下面的歌词能不能全部统一最低可见度」）：`web/src/styles/app.css` 上浮段新增 `.lyrics-view.lyric-style-rise .lyrics-right .lyric-line.is-active ~ .lyric-line { opacity: 0.2 !important; }`——当前行下方歌词统一最低可见度、不再按 `--fade` 逐行渐隐，当前行与上方已唱行不变，其它样式不受影响；构建 `main-5TOZNsub.js` / `main-ZK-kF4OV.css` 已部署（详见 §40）。⑬歌词样式二轮微调（2026-10-26，用户要求「弹跳效果有问题重做一个、打字机未播放歌词应完全不可见、漂浮换一个别的效果」）：弹跳改用一次性 `@keyframes lyric-style-bounce`（0.46s：上抬 -0.55em/放大 1.1 → 轻压 0.04em → 复位），由 `.lyric-char.is-hot` 触发、`.is-sung` 显式 `animation: none`，不再整行慢速回落叠加；打字机新增 `.lyrics-view.lyric-style-typewriter .lyrics-right .lyric-line.is-active ~ .lyric-line { opacity: 0 !important; }`（下方未唱行完全不可见）；`lyricStyle.ts` 把 `float` 改为 `spin`（旋入，`charTiming: true`，旧存档 float 自动回落 classic），CSS 用独立 `rotate`（未唱 -16deg/translate 0.42em/opacity .14，唱到与已唱归位），移除旧 float keyframes；构建 `main-Zkj4Iu2x.js` / `main-D-ygekPb.css` 已部署（详见 §41）。⑭旋入改为文字随机飘入组成句子（2026-10-26，用户要求「旋入能不能改成文字随机从各个地方飘进来组成句子」）：`lyrics.ts` 新增稳定伪随机 `scatterHash`/`scatterRandom`，render() 给每个 `.lyric-char` 写 `--drift-x`（±1.6em）/ `--drift-y`（±1.1em）/ `--drift-rot`（±30deg）/ `--drift-dur`（0.5–0.85s）；`app.css` 旋入段改为未唱字散落句子周围（`translate: var(--drift-x) var(--drift-y)`、`rotate: var(--drift-rot)`、`opacity: .12`），唱到（is-hot）从随机方向飘回原位并带旋转、每字速度略差，is-sung 直接归位；`lyricStyle.ts` 更新 hint 与模板注释（新增 `--drift-*` 钩子说明）；构建 `main-DUSTF3Pi.js` / `main-BFwSCgH6.css` 已部署（详见 §42）。⑮旋入未播放歌词统一最低可见度（2026-10-26，用户要求「未播放的歌词也要像刚才那个一样最低可见度」）：`app.css` 旋入段新增 `.lyrics-view.lyric-style-spin .lyrics-right .lyric-line.is-active ~ .lyric-line { opacity: 0.2 !important; }`，旋入样式下当前行下方还没轮到的整行歌词统一最低可见度（与上浮一致）、不再按 `--fade` 逐行渐隐，当前行与上方已唱行不变；构建 `main-BtCpGnD8.js` / `main-p-2Y3xQ2.css` 已部署（详见 §43）。⑯旋入未播放歌词按距离打乱、越靠近播放行越整齐（2026-10-26，用户要求「未播放的歌词本身就是打乱的，越靠近播放的歌词越来越整齐，直到正在播放就是现在这样拼起来」）：`applyFade()` 给每行写内联 `--scatter`（当前行 / 上方已唱行 / 手动浏览 = 0，下方 `Math.min(1, (index - activeIndex - 1) * 0.3)`），`app.css` 旋入段新增 `:not(.is-active)` 规则按 `--scatter` 缩放该字的 `--drift-x / --drift-y / --drift-rot` 并 0.9s 过渡——下方未播放的整行歌词本身是打乱的，越靠近当前行越整齐，轮到播放时切回逐字飘入；构建 `main-B-BUYCSW.js` / `main-DoYaa4cv.css` 已部署，并按约定自动重启应用（PID 23428，19:02:43）（详见 §44）。⑰旋入换行不再重新组装、靠近播放的歌词保持半散逐步收拢（2026-10-26，用户反馈「现在是正在播放的会重新组装一次，在靠近正在播放的第一句未播放的歌词就已经是组好的了」）：`applyFade()` 的 `--scatter` 改为整列共用连续系数——当前行 0.6 半散、往后每远一行 `Math.min(1, 0.6 + (index - base - 1) * 0.15)`（0.75 / 0.9 / 1.0）、已唱行与手动浏览 0；`app.css` 旋入段当前行规则按 `--scatter` 缩放 `translate / rotate`，当前行承接 0.6 半散状态逐字归位、换行时位置连续不再整行重新组装；构建 `main-BVmDXMbL.js` / `main-CGnngTMG.css` 已部署并按约定自动重启应用（PID 28068，19:05:36）（详见 §45）。⑱新样式恢复唱过字的缩小落回动画（2026-10-26，用户反馈「现在是在播放过的字在回到正常状态的缩小动画没有」）：新样式（上浮 / 打字机 / 旋入）覆盖 `.lyric-char` 的 `transition` 时补上 `transform 0.34s`（基态）/ `transform 0.18s`（is-hot），恢复经典「唱到放大、唱完缩小落回」的过渡，并在新样式段头注释写明该约定；构建 `main-DhUgh5yP.js` / `main-DN4dS8dL.css` 已部署并按约定自动重启应用（PID 15432，19:08:02）（详见 §46）。⑲把「弹跳」换成「摇曳」（2026-10-26，用户反馈「这个弹跳的动画效果换一个」）：`lyricStyle.ts` 的 `bounce` 改为 `swing`（label「摇曳」，唱完的字左右摆两下再停稳），`app.css` 删 `@keyframes lyric-style-bounce`、新增 `@keyframes lyric-style-swing`（`rotate` 0 → -7deg → 6deg → -3deg → 1.2deg → 0，叠加轻微 `scale` 1.04，0.52s，`.is-sung` 触发，`.is-hot` 不播）；老存档 `bounce` 通过 `LEGACY_STYLES` 自动迁移到 `swing`；构建 `main-DLE0ARgU.js` / `main-DFtEvpq1.css` 已部署并按约定自动重启应用（PID 33488，19:17:01）（详见 §47）。verification：一~九由 Lead 真机 CDP + 宿主日志自测；第三十二轮按用户 m03815 约定未自测，界面效果交用户验证；第三十三轮做了媒体键链路针对性冒烟（未跑完整 QA）；第三十四轮按用户 m03815 约定未自测，界面效果交用户验证；第三十五轮同约定未自测，前端改动需重启应用后加载；第三十六轮同约定未自测，前端改动需重启应用后加载；第三十七轮同约定未自测，前端改动需重启应用后加载；第三十八轮同约定未自测，已按约定构建部署后自动重启应用（PID 23428）；第三十九轮同约定未自测，已自动重启应用（PID 28068）；第四十轮同约定未自测，已自动重启应用（PID 15432）；第四十一轮同约定未自测，已自动重启应用（PID 33488）。详见 `research/UPDATES-2026-10-25.md` §25 / §26 / §27 / §28 / §29 / §30 / §31 / §32 / §38 / §39 / §40 / §41 / §42 / §43 / §44 / §45 / §46 / §47。
- **非代码交付物（2026-10-26）**：Zilux2 宣传片已交付——`E:\Zilux2开发\Zilux2-promo.mp4`（1 分 04 秒 / 1920×1080@30 / H.264+AAC / 8.9MB，9 段：片头·首页·无缝衔接·歌词空间·歌词样式·私人雷达·本地曲库·桌面常驻·片尾），配乐取 `MISTERK - 猜疑.mp3` 的 32–96 秒、按 79 BPM 吸附拍点切镜；工程与素材（渲染脚本/截图/真帧）在 `research/promo/`（157MB，未入库，`render.py` 约 2 分钟可重渲染）。
- **下一步候选**（按优先级）：①仓库切 **public** 才能真正启用应用内自动更新（当前 private，匿名 API 404）；②歌词页更多效果（第三十二轮已交付 5 种播放动画样式，可继续扩展）；③更多平台能力（见 §11）。
- **改代码前必看**：§3 构建流程、§9 版本/发版节奏（**不要擅自跳版本号**）、§4 真机 QA、§10 更新通道。私有仓 + 未签名安装包会触发 SmartScreen，属预期。
- **测试约定（2026-10-25 用户明确）**：不要自行测试（CDP / QA / 真机操作都算）；只有用户明确说「去测」时才测试。改完代码到构建/部署为止，把运行结果交给用户自己验证。
- **本机环境**：`E:/dotnet/dotnet.exe`；Node 用 `C:/Users/13329/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe`；`github.com:443` 不通，git 走 SSH over 443（§10）；bash 里 `$LOCALAPPDATA` 不展开。

## 1. 项目是什么

Zilux2 是一个 Windows 桌面音乐播放器：

- **宿主**：`src/Zilux2`（.NET 10 WPF + WebView2），负责窗口、WebView2 容器、本地音乐库扫描/标签读取/封面提取、在线 API 代理（本地 HttpListener）、下载、设置持久化、窗口动画、mac 壳的遗留代码。
- **前端**：`web/`（Vite 7 + TypeScript 5.9 + 原生 DOM 渲染，播放器页面、歌词/房间效果、发现页、设置面板）。
- **资源**：播放音频直接在 Chromium `<audio>` 中播放；在线音频由宿主代理 `/api/stream` 转发并支持 Range。

## 2. 目录结构（要点）

```
E:\Zilux2开发\
├─ src/Zilux2/                  # WPF 宿主
│  ├─ WebViewHost.cs            # WebView2 消息桥 / 虚拟主机 / 页面加载
│  ├─ MainWindow.xaml.cs        # 窗口、动画（应用内/系统原生）
│  ├─ Online/
│  │  ├─ LocalMusicServer.cs    # ★ 本地 HTTP API（/api/*），所有在线能力路由
│  │  ├─ OnlineMusicService.cs  # provider 注册、DownloadService 组装
│  │  ├─ DownloadService.cs     # 统一下载（网易云/QQ/酷狗/无名音乐）
│  │  ├─ Mvmp3Provider.cs       # 无名音乐（实验源）provider
│  │  ├─ Mvmp3Cache.cs          # 实验源后台缓存（下载目录下 mvmp3-cache）
│  │  └─ Discover/              # 发现页后端（10 个 /api/discover/*）
│  ├─ Local/
│  │  ├─ LocalMusicService.cs   # 本地曲库扫描、下载合并、删除/显示/打开目录
│  │  └─ LocalTagReader.cs      # 本地音频标签读取（ID3/FLAC/MP4/OGG/WAV）
│  ├─ Settings/                 # settings.json 持久化（SettingsModel/Service/Bridge）
│  └─ Updates/                  # GitHub Releases 更新通道（UpdateService）
├─ web/                         # 前端
│  ├─ src/ui/                   # 页面与组件（含 updates.ts 更新 UI）
│  ├─ src/online/               # 在线 API client / discover / download
│  └─ dist/                     # 前端构建产物（vite build）
├─ tools/
│  ├─ publish.ps1               # 发布宿主到 dist/Zilux2（-SkipWebBuild -Version -UpdateRepo）
│  ├─ make-installer.ps1        # 打安装包 dist/Zilux2-Setup-<版本>.exe（-Version 缺省读 props）
│  └─ release.ps1               # 一键发版：构建 + 安装包 + tag + push（-DryRun 演练）
├─ .github/workflows/release.yml # CI：tag v* 触发，构建并发布 GitHub Release
├─ Directory.Build.props        # ★ 版本号与默认更新源的唯一来源
└─ research/                    # QA 脚本、截图、专项文档（不要当源码）
```

## 3. 构建 / 发布 / 安装（固定流程）

```powershell
# 1) 前端构建（含 tsc 类型检查）
cd web
node ./node_modules/vite/bin/vite.js build        # 或 npx tsc --noEmit && vite build

# 2) 宿主构建
E:/dotnet/dotnet.exe build src/Zilux2/Zilux2.csproj -v q --nologo

# 3) 发布宿主（先关掉正在运行的程序）
taskkill /IM Zilux2.exe /F
powershell -File tools/publish.ps1 -SkipWebBuild

# 4) 打安装包（版本号来自 Directory.Build.props，可用 -Version 覆盖）
powershell -File tools/make-installer.ps1 -Version 1.0.0
# 产物：dist/Zilux2-Setup-1.0.0.exe

# 5) 静默安装并启动（安装目录 %LOCALAPPDATA%\Programs\Zilux2）
dist/Zilux2-Setup-1.0.0.exe --silent --no-shortcuts

# 6) 发版（先改 Directory.Build.props 的 <Version>；构建 + 安装包 + 打 tag v<ver> + push）
powershell -File tools/release.ps1 -DryRun   # 演练；去掉 -DryRun 真发版
```

> 注意：
> - 只改了前端时可不动宿主：构建 web 后把 `web/dist/assets`、`web/dist/index.html` 复制到 `dist/Zilux2/web/` 和 `%LOCALAPPDATA%\Programs\Zilux2\web/`，重启程序即可。
> - bash 里写环境变量 `$LOCALAPPDATA`（`%LOCALAPPDATA%` 不会展开）；写路径含中文/空格时用引号。
> - 改 C# 后必须 `publish.ps1` 再重启；不要只重启旧 exe。

## 4. 真机 QA（CDP）

- 启动带远程调试：
  ```powershell
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9223'
  Start-Process "$env:LOCALAPPDATA\Programs\Zilux2\Zilux2.exe"
  ```
- 脚本模式：`http://127.0.0.1:9223/json/list` → 找 `url` 以 `https://zilux2.local` 开头的 page → WebSocket → `Runtime.evaluate` / `Page.captureScreenshot`。
- 脚本集合：`research/tmp/qa-*.mjs`（每个功能一份，可直接改目标断言复用）。
- 经验：
  - 快捷设置按钮（`.pb-quick`、房间设置按钮等）用**页面内 JS `.click()`**；CDP 真实鼠标点击经常打不开/点错。
  - 播放条进度条 `.pb-progress .track` 需要**先 hover 播放条展开**再量 rect/发 pointer 事件。
  - 原生 `window.confirm` 会卡死渲染进程 → 一律使用应用内 `confirmDialog`。
  - `Page.reload` 偶发卡死（旧页面残留模态）→ 直接 taskkill 重启安装版更稳。
   - 抓「正在播放/即将播放」类过渡要 80–90ms 采样一次。
   - 关键界面触发路径（2026-10 交接时实测）：
     - 设置：`.rail-btn[title="设置"]` → `.sheet.is-center`（两栏：`.settings-nav-btn` 切换 `.settings-pane`）。
     - 房间/文字效果设置：`.pb-quick` → 快捷设置「歌词」tab → `.quick-text-settings-btn` → `.sheet.text-sheet`（全屏遮罩 + 底部居中面板）。
     - 歌曲信息：首页 `.ui-tile`（歌单卡）→ 歌单页 `.track-row` → 行内 `.track-info` → `.sd-modal`（居中浮窗，Esc/关闭按钮均可关）。
     - 快捷设置：`.pb-quick`；播放条主按钮 `.pb-btn.is-main`（CDP 真实鼠标点击不可靠，优先页面内 JS `.click()`）。
   - 更新通道 QA：本地起 mock GitHub API（`research/tmp/mock-updater.mjs`，默认 8765），启动应用时设 `ZILUX2_UPDATE_API=http://127.0.0.1:8765`、`ZILUX2_UPDATE_INSTALL_DIR=<QA 安装目录>`、`ZILUX2_SETTINGS_PATH=<临时 settings>`，即可走完整「检查→下载→安装→重启」；详见 `docs/zilux2-update-channel.md` §8。

## 5. 关键前端文件职责

| 文件 | 职责 |
| --- | --- |
| `src/ui/app.ts` | 主壳：页面切换（首页/搜索/发现/本地/我喜欢的/歌单/歌词）、快捷设置、播放条、事件绑定。（很大，改动集中看 buildXxx + syncXxx） |
| `src/ui/lyrics.ts` | 歌词页与效果模式（off/text/room）、歌词颜色 provider、is-covered 机制 |
| `src/ui/roomScene.ts` | ★ 房间场景（Canvas2D）：3D 投影、逐词 DOM、流星、粒子、地毯、背景渐变、相机 |
| `src/ui/roomSettings.ts` | 房间设置数据模型（RoomStyleSettings + 默认值 + localStorage `zilux2.roomStyle`） |
| `src/ui/roomSettingsPanel.ts` | 房间设置面板（九组：预设/文字/布局/背景/流星/粒子/地毯/镜头/动效） |
| `src/ui/upNextToast.ts` | 顶部「即将播放/正在播放」单框预告条（连续过渡、渐变倒计时） |
| `src/ui/songInfo.ts` | 歌曲信息：page=居中浮窗（`.sd-modal`，不再占满 stage）、inline=列表内展开；设置可选 |
| `src/ui/eqCurve.ts` | ★ 均衡器频响曲线：Canvas2D + PCHIP 平滑插值 + 节点拖拽（设置页与快捷设置共用） |
| `src/ui/keywords.ts` | 重点词（关键分词）提取，纯字/房间共用 |
| `src/ui/localArtists.ts` / `src/ui/local.ts` | 本地歌手聚合（歌手页）/ 本地曲库数据 |
| `src/ui/confirmDialog.ts` | 应用内确认弹窗（替代 `window.confirm`） |
| `src/ui/updates.ts` | 更新状态 store 与手动操作（设置页「更新」分区渲染） |
| `src/online/discover.ts` / `client.ts` / `download.ts` | 发现页 / 在线 API / 下载 API |
| `src/core/settings.ts`、`src/core/bridge.ts` | 设置模型与宿主消息桥 |

## 6. 关键宿主文件职责

| 文件 | 职责 |
| --- | --- |
| `Online/LocalMusicServer.cs` | ★ 所有 `/api/*` 路由（search/lyric/stream/cover/discover/downloads/account/library/artist/image…） |
| `Online/DownloadService.cs` | 下载任务（ResolveStreamAsync → .mp3/.flac 落盘，质量透传） |
| `Online/Mvmp3Provider.cs` / `Mvmp3Cache.cs` | 实验源搜索/取流 / 后台预取缓存 |
| `Online/Discover/DiscoverService.cs` | 发现页数据（网易云 + QQ，含评论/歌手图/歌曲信息） |
| `Local/LocalMusicService.cs` | 扫描本地目录、下载合并、删除（回收站）/在文件夹中显示/打开目录/刷新 |
| `Local/LocalTagReader.cs` | 标签读取（歌名/歌手/专辑） |
| `Settings/SettingsModel.cs` / `SettingsService.cs` | settings.json 字段（含 downloads/quality、windowAnimation 等）与校验 |
| `WebViewHost.cs` | 消息类型：ready/settings/window/drag/resize/log/media/audio/airplay/fonts/local/download/update |
| `Updates/UpdateService.cs` | 更新通道：GitHub Release 检查/下载/digest 校验/静默安装（设置 updates 段） |
| `MainWindow.xaml.cs` | 窗口动画（应用内快照 / 系统原生） |

## 7. 运行时数据目录

- `%LOCALAPPDATA%\Zilux2\settings.json` — 用户设置（含下载目录/音质/窗口动画/实验源开关等）
- `%LOCALAPPDATA%\Zilux2\account.json` — 网易云/QQ/酷狗 登录 cookie（DPAPI 加密）
- `%LOCALAPPDATA%\Zilux2\logs\host.log` — 宿主日志（含 `[online] listening on 127.0.0.1:<port>`、下载/扫描、`[update]` 更新日志）
- `%LOCALAPPDATA%\Zilux2\updates\` — 更新包下载缓存（digest 校验通过后用于安装）
- `%LOCALAPPDATA%\Zilux2\mvmp3-cache\` — 实验源缓存（如果下载目录为空则在此；默认已迁到下载目录 `mvmp3-cache`）
- 下载默认目录：`C:\Users\<user>\Music`（可在设置 → 下载 修改）
- 本地曲库扫描目录：设置 → 数据 → 本地歌曲文件夹

## 8. 当前状态

【1.1.7（本轮发版）】无缝衔接系列：B 版 Phase 1 双 deck 交叉淡化 + WSOLA 变速不变调节拍对齐 + 尾端静音自动排除 + 对齐下一首「开始唱词」+ 过渡中顶部「正在无缝过渡到 X」提示。宿主：`src/Zilux2/Analysis/` 新增 `TailSilenceDetector.cs`、`AnalysisSuccessResponse` 增加 `audibleEndMs/tailSilenceMs`、`AnalyzerVersion` p0-4；前端：`crossfadeDeck.ts`（双 deck 引擎、auto 4 小节 5–10s/手动 3–30s、WSOLA ±12%、唱词反推、可听结尾终点）、`audioTap.ts`（deck 混音图 + low/high shelf 人声优先）、`player.ts`（双 `<audio>`、`@preservesPitch` 时间拉伸、状态迁移）、`vocalStart.ts`、`upNextToast.ts`（transition 阶段）、`app.ts`（播放页「无缝衔接（实验）」设置区，localStorage `zilux2.crossfade`）。验证：收藏歌单 なでなで→人は猫 全链路 `prepared→fading→done`、公式 `fadeStart+fadeMs=audibleEnd`（偏差 0ms）、WSOLA `tempoRate=0.976/ tempoMatched=true`、QA 76 PASS / 0 FAIL / 3 SKIP（90.2s，crossfade 9 步）；顶部提示截图 `research/shots/lead-toast-transition.png`。详见 `research/UPDATES-2026-10-25.md` §7–§13。
- 版本号统一由 `Directory.Build.props` 控制（当前 **1.1.7**）；`%LOCALAPPDATA%\Programs\Zilux2` 装的是最近一次构建（自动更新会改装到更新版本）。
- 1.1.6（上一轮发版）：后台常驻 + 托盘 + 全局热键 + 下载入口迁移/下载页/音质选择。宿主：`ShutdownMode=OnExplicitShutdown`，关窗（页面按钮/Alt+F4/WM_CLOSE）隐藏到托盘、进程继续跑；新增 `Tray/TrayIconService.cs`（NotifyIcon，左键显示/隐藏，右键 显示/播放或暂停/上一首/下一首/退出，首次隐藏气泡提示一次）；`MainWindow` 注册全局热键（Ctrl+Alt+Space 播放暂停、Ctrl+Alt+←/→ 上/下一首带候选回退 Ctrl+Alt+Shift+←/→ 与 Ctrl+Alt+J/K、Ctrl+Alt+Z 显示/隐藏），托盘菜单/热键统一经 `WebViewHost.PostCommand` 下发 `{type:'command',action:...}` 到页面；真正退出只有托盘「退出」与更新安装。前端：rail 移除下载入口（9 项）；快捷设置增加第 5 个「下载」页（`.quick.is-download`，复用下载队列可嵌入视图 `createDownloadQueueView`）；新增 `downloadPicker.ts` 音质浮层（标准/高品质默认/无损，仅本次生效不回写设置，锚定按钮、键盘可达）；列表行下载按钮改为「先选音质再入队」，播放条下载按钮仍打开队列浮层。详见 `research/UPDATES-2026-10-25.md`。
- 2026-10-25 第二轮微调（已推 main、**未发版**，未达 §9 门槛：3 处修复/优化、无新增功能）：快捷设置切 tab 时面板**宽度/高度都做弹簧过渡**——`app.css` 的 `.quick .quick-panel` 补 `transition: width .32s cubic-bezier(.22,1.28,.36,1)`（`prefers-reduced-motion` 下关闭）；高度目标改为按「目标宽度」预量（`measureQuickBodyHeightAtTargetWidth`：临时加 `is-resizing` 关宽度过渡、按 tab 目标宽度落布局量内容高，再退回旧宽度交给 CSS 过渡），并用 `ResizeObserver` 观察 `quickBodyInner`，在宽度落定/异步内容加载后补一段高度动画（`scheduleQuickBodySync` / `syncQuickBodyHeight`），修掉「宽度过渡结束时高度再跳一截」；分页栏白色胶囊 `.quick-thumb` 与内容里的分段滑块 `.quick-seg-thumb` 在宽度过渡期间由 `ResizeObserver` 每帧贴合（`paintQuickTabThumb` / `repaintQuickSegThumbs` + `.is-width-animating` 期间 `transition: none`），修掉用户反馈的「切换时开关的显示背景错位/变形」。改动文件：`web/src/ui/app.ts`、`web/src/styles/app.css`。验证：宽度 348↔384↔508 平滑（中间帧 442 / 496 / 510）、过渡期间滑块漂移 ≤1px、落定后漂移 0、console 0 error；截图 `research/shots/lead-quick-anim-mid1.png`、`research/shots/lead-quick-cover-after-download.png`、`research/shots/lead-quick-final-cover.png`。
- 2026-10-25 第三轮（已推 main、**未发版**，未达 §9 门槛：1 个新增功能 + 2 处修复/优化）：**全局快捷键改为设置驱动、可配置**——完整设置弹窗新增「快捷键」页（4 行：播放/暂停、上一首、下一首、显示/隐藏窗口；展示当前组合与状态、录制换键、启用开关、恢复默认）。宿主：`SettingsModel` 新增 `shortcuts{enabled,playPause,prev,next,toggleWindow}`，新增 `Hotkeys/{HotkeyBinding,HotkeyCatalog,HotkeyState}.cs` 组合键解析/校验，`MainWindow` 删除静态 `HotkeySpecs` 改为 `ApplyShortcutSettings(reason)` 幂等注册（默认组合保留候选回退 prev/next→`Ctrl+Alt+Shift+←/→`→`Ctrl+Alt+J/K`；被占用时回落并在 UI 提示、无法回落提示可换键），`WebViewHost.PublishShortcuts` 回推 `{type:'host',event:'shortcuts'}`；前端 `core/settings.ts`/`core/bridge.ts`/`ui/app.ts` 新增设置段与面板、`styles/shortcut-settings.css`；契约文档 `docs/zilux2-settings-contract.md` 同步 §2/§3.3/§5/§7。验证：UI 4 行状态正确、录制 prev=Ctrl+Alt+U 后宿主重注册且 `WM_HOTKEY id=2` 实测切歌、关闭开关后 `hotkey.register ... skipped reason=disabled`/`apply enabled=false count=0`、恢复默认后 `apply enabled=true count=4`，settings.json 持久化。截图 `research/shots/lead-shortcuts-{panel,recorded,disabled,reset}.png`。详见 `research/UPDATES-2026-10-25.md` §4。
- 2026-10-25 第四轮（P0 节拍分析，已推 main、**未发版**，按用户「先做 P0 让我听听」暂不发版）：为「鼓点对齐自动衔接」的目标先做实验性 P0——宿主新增 `src/Zilux2/Analysis/`（`AnalysisModels.cs` 契约 DTO、`TrackAudioDecoder.cs` MediaFoundation 解码 + 22050Hz 单声道重采样、`BeatAnalyzer.cs` 谱通量 onset→自相关+梳状 BPM→相位拟合→4/3 拍强拍→拍网格/downbeats→小节 novelty 乐句，analyzer `p0-1`、`TrackAnalysisService.cs` 缓存/单飞/超时/错误码），`LocalMusicServer` 加 `GET /api/analysis`，`OnlineMusicService` 持有服务并暴露 `LocalPathResolver`，`WebViewHost` 接本地 rel→路径回调，`LocalMusicService.ResolveTrackPath` 改 internal；前端新增 `online/analysis.ts`（接口封装+内存缓存+单飞）、`core/metronome.ts`（AudioContext click 节拍器：强拍 1760Hz/普通 1046Hz、120ms tick、250ms lookahead、暂停/拖动/切歌清空、localStorage 持久化）、`ui/analysisSection.ts`（设置 → 播放「节拍分析（实验）」：分析当前/下一首 + BPM/拍号/拍点/小节/乐句/段落 + 节拍器开关/音量/强拍加重）、`styles/analysis-section.css`；契约文档 `docs/zilux2-beat-analysis-contract.md`。验证：合成 120/128/75 BPM 点击轨 BPM 119.8/128.6/75.2、拍号 4/4、相位误差 ≤85ms；真实 mp3 4:39 → 133.4 BPM（87%）、155 小节、594ms；节拍器开关与 localStorage 持久化；QA 回归 67 PASS / 0 FAIL / 3 SKIP。详见 `research/UPDATES-2026-10-25.md` §5。
- 2026-10-25 第五轮（BPM 倍速修复 p0-3，已推 main、**未发版**，1 处修复）：修「快歌节拍器慢半速」——`BeatAnalyzer.EstimateTempo` 在梳状自相关折叠后增加半拍 onset 校验（`bpm < 120` 且 `2×bpm` 在范围内时比较 `ac[beatLag/2]` 与 `ac[beatLag]`，阈值 `bpm<100` 用 0.55、`100–120` 用 0.78，满足则 `bpm *= 2`），`AnalyzerVersion` p0-1→p0-3（缓存键必须 bump 才重算）；合成 12 轨（75.2–220.2 BPM）全对，真实 32 首 corpus 无回归（霽れを待つ 167.4、新宝島 157.7）。详见 `research/UPDATES-2026-10-25.md` §6。
- 2026-10-25 第六轮（B 版 Phase 1：无缝衔接 MVP，已推 main、**未发版**，1 个新增功能）：用户选定「B 版」目标后实现鼓点对齐的自动衔接——新增 `web/src/ui/crossfadeDeck.ts`（双 deck 淡化引擎：B 按下一首 `firstDownbeatMs` 定入点、A 淡化起点对齐 A 的 downbeat、auto 4 小节 5–10s（2026-10-25 按用户反馈调整；固定档 5/7/10s）、等功率 A=cos/B=sin、`window.__ziluxCrossfade` 调试接口）；`player.ts` 改双 `<audio>` deck（`prepareSeamlessNext` 异步分析+预加载、`commitSeamless` 交换 deck 并迁移全部状态、取消矩阵）；`audioTap.ts` 新增 `deckMix` 混音入口与 `attachDeckToGraph`/`detachDeckFromGraph`/`deckGraphConnected`/`setDeckGraphGain`，**Web Audio 图开启时走图内增益淡化**（修掉「默认人声保留淡出导致永不生效」）；`app.ts` 播放页新增「无缝衔接（实验）」设置区（localStorage `zilux2.crossfade`，默认开/auto，可选 5/7/10s）。真机验证：本地曲库「霽れを待つ」→「スペア」`prepared`(3232ms/`bStartFileMs`1277)→`fading`→`fade-done` 约 3.2s，播放器自动切歌且继续为下一首预排；脚本 `research/tmp/lead-crossfade-verify3.mjs`。已知限制：仅列表循环、下一首需分析成功、后台 rAF 节流、位级 gapless 留待 Phase 2+。详见 `research/UPDATES-2026-10-25.md` §7。
- 2026-10-25 第十轮（过渡时长放宽到 3–30 秒，已推 main、**未发版**，1 处体验优化）：`CrossfadeLength` 改为 `auto | number`，手动档 `[3,5,8,10,15,20,30]` 秒 + 自动（默认），`normalizeLength` 兼容旧值并夹 3–30，`MAX_FADE_MS` 提到 32s，说明文案同步；QA fixtures/labels 同步。真机验证：档位渲染正确、20 秒档 prepared `fadeMs=20207`、自动档 `fadeMs=6910`。详见 `research/UPDATES-2026-10-25.md` §11。
- 2026-10-25 第十一轮（WSOLA 变速对齐 + 更慢/人声优先的融合，已推 main、**未发版**，1 处体验优化 + 1 个算法特性）：`crossfadeDeck.buildSchedule` 增加 WSOLA 节拍对齐——`tempoRate=round(bpmA/bpmB,3)` 仅在 0.88–1.12 内启用，按 A/B 下一拍做 ±220ms 相位微调，B 用 `preservesPitch=true` 时间拉伸（Chromium 原生 WSOLA），过渡后 650ms 平滑回 1；B 淡入曲线改为 `sin(π/2·p^1.9)`、A 退出 `cos(π/2·p^1.15)`；`audioTap` 每 deck 图链增加 low/high shelf（180Hz/4200Hz）与 `setDeckGraphTilt`，过渡期间 A 伴奏先退、B 伴奏慢慢回正，实现「人声先出现、伴奏后融合」；player `load()` 复位 playbackRate。验证：收藏歌单 なでなで→人は猫 prepared `tempoRate=0.976/tempoMatched=true/fadeMs=6910`，seek 触发后正常切歌、console 0 error。详见 `research/UPDATES-2026-10-25.md` §12。
- 2026-10-25 第十二轮（无缝过渡顶部提示，已推 main、**未发版**，1 处体验优化）：`upNextToast` 新增 `transition` 阶段，交叉淡化进行中把顶部预告条改为「正在无缝过渡到 <下一首>」+ 淡化进度条（隐藏倒计时），过渡完成后同框换回「正在播放」；`app.css` 增加 `.upnext-toast.is-transition` 样式。验证：收藏歌单 なでなで→人は猫 淡化中 kicker/标题/进度条/aria 全部正确，console 0 error。详见 `research/UPDATES-2026-10-25.md` §13。
- 2026-10-25 第九轮（过渡对齐下一首「开始唱词」，已推 main、**未发版**，1 处体验优化）：用户要求过渡跳过下一首无唱词前奏、让淡化结束瞬间正好开始唱词。新增 `web/src/ui/vocalStart.ts`（`fetchVocalStartMs`：本地同名 .lrc / 在线宿主 /api/lyric LRC·YRC，1.8s 超时、按曲目缓存、失败返回 null）；`web/src/ui/crossfadeDeck.ts` 的 `buildSchedule` 按下一首首句唱词反推 B——前奏够长时 B 从 `唱词-期望淡化` 处起播（跳过前奏）、前奏较短时整段前奏作过渡并缩短淡化使终点=唱词起点，均写 `vocalAligned`，失败回退原逻辑；`web/src/ui/player.ts` 的 `prepareSeamlessNext` 异步取唱词位置后传入；设置区说明同步。真机验证三种路径：短前奏(290ms)→回退普通淡化；中前奏(5310ms)→淡化 4409ms 终点=唱词；长前奏(13200ms)→B 跳过 3.2s 前奏、10s 淡化终点=唱词，三种均 `fadeStart+fadeMs=可听结尾`。详见 `research/UPDATES-2026-10-25.md` §10。
- 2026-10-25 第七轮（尾端静音自动排除 + 收藏歌单实测，已推 main、**未发版**，1 处体验优化）：用户要求「用收藏歌单测试 + 自动排除尾端静音」。宿主：新增 `src/Zilux2/Analysis/TailSilenceDetector.cs`（-50 dBFS / 20ms RMS / 连续静音 ≥300ms / 至少保留 10% 时长），`/api/analysis` 响应顶层新增 `audibleEndMs`（可听结尾 ms）与 `tailSilenceMs`，`AnalyzerVersion` p0-4；前端：`online/analysis.ts` 兼容顶层字段（缺失回退 duration），`ui/crossfadeDeck.ts` 把 A 的淡化终点改为 `clamp(audibleEndMs ?? durationMs, 0, durationMs)`，保证 `fadeStartPosMs + fadeMs = audibleEndPosMs`，不占用尾部静音；debug 快照/事件带「可听结尾/尾部静音」。真机验证：本地 スペア（duration 297000/audibleEnd 290841/tail 6159）与收藏歌单 なでなで（259120/255179/3941）公式偏差 0ms；收藏歌单「なでなで→人是猫」prepared→fading→done 约 3.3s 自动切歌并 `playing=true`。QA：76 PASS / 0 FAIL / 3 SKIP（90.2s，crossfade 新增 9 步）详见 `research/UPDATES-2026-10-25.md` §8。
- 1.1.5：纯字档背景光柱完成体验升级并正式发版——光柱从 4 套扩到 **8 套**（新增 斜光/交叉/仰光/虹光 四种入射角/扇形构图），虹光用每束 `tint/hueTint` 着色 + shader 截面色散；新增 **自动轮换**（`beamAuto` 默认开：每 16s 换一套，2.4s smoothstep 插值过渡，顺序 静光→缓息→流幕→聚光→斜光→交叉→仰光→虹光）；所有样式统一走 32s 无缝循环时钟，烟雾 42s 无缝循环；面板 `.ts-seg.is-wrap` 两行 8 chip + 「自动轮换」行。详见 `research/UPDATES-2026-10-24.md` §10/§11。
- 1.1.4（本轮）：房间设置新增粒子/流星快捷预设（8 组，`.room-preset-chip`）；宿主新增 `FileSystemWatcher` 本地音乐目录自动监控（`LocalFolderWatcher.cs` + `LocalMusicService.Watch.cs`，1.3s 去抖、增量重扫、自写入抑制）；下载队列浮层（`downloadQueue.ts`：汇总/筛选/进度/速度/定位/重试，入口 `.pb-actions [data-qa=download-entry]`）；QA 回归套件固化到 `research/qa/suite/`；修复 `NotifyFileAdded` 跨线程、`WebViewHost` 未释放 `LocalMusicService`、`DeleteTracks` 自身写入未抑制。详见 `research/UPDATES-2026-10-24.md`。
- 1.1.4 第二轮微调（同日、已推 main、**未发版**，未达 §9 门槛：4 处修复/优化、无新增功能）：下载入口 rail 常驻（`.rail-btn[aria-label=下载队列]`，`toggleDownloadPanel`）；下载队列 tab 统一全局 `.seg` 分段控件（白色滑块 `.seg-thumb`）并加切换动画（`.is-switch` / `dlq-switch-in`，行 24ms stagger）；修复搜索「input 后立即 Enter 永久卡加载中」竞态（`commitSearch` 清 `searchTimer`）。QA 套件扩到 **46 项**（新增下载队列 UI 断言 + 竞态回归，`run-all` 46.5s 全绿）。详见 `research/UPDATES-2026-10-24.md` §7。
- 1.1.4 第三轮（同日、已推 main、**未发版**，未达 §9 门槛：累计 5 处修复/优化、无新增功能）：纯字档背景光柱重做——移除此前的 folia 迁移光位光束，新增自研 `light/textBeams.ts`（固定构图 6 道＝`TEXT_BEAM_COUNT`；围绕文字区、垂直光柱、独立慢摆 + 长度呼吸 + 低频抬升亮度；设置面板「背景光柱 / 光柱大小 / 左右位置 / 上下位置」继续生效）；`scene.ts` 的纯字分支改用 `resolveTextBeams`，非纯字档位保持原 folia 光位链路不变。详见 `research/UPDATES-2026-10-24.md` §8。
- 1.1.4 第四轮（同日、已推 main、**未发版**）：纯字档光柱支持**四套风格**（文字设置 → 文字 → 光柱效果：静光/缓息/流幕/聚光），并让光柱与烟雾**全部无缝循环**——`textBeams.ts` 新增 `textClock()`（LOOP=32s，每束摆动/呼吸/漂流相位取 32 的整数谐波，32s 首尾完全重合；`streakPhase` 按整圈取余避免循环点跳变）、四套 `COMPOSITION` 与固定 `TEXT_FOG_RIG`/`TEXT_FOG_LOOP`；`lightFieldShader.ts` 增加 `uFogC` 循环雾模式（周期 42s，sin/cos 漂移、流动纹理整圈取余），修掉「雾循环点跳一下」。改动文件：`light/textBeams.ts`、`light/lightFieldShader.ts`、`scene.ts`、`lumiereSettings.ts`、`textSettingsPanel.ts`、`lumiere-folia/types.ts`、`lumiereRuntimeTuning.ts`。详见 `research/UPDATES-2026-10-24.md` §9。按用户「先自测」要求暂不发版（累计已超 §9 阈值，待确认后再定 1.1.5）。
- 1.1.4 第五轮（同日、已推 main、**未发版**）：纯字档光柱扩到 **8 套样式**（新增 `斜光/交叉/仰光/虹光` 四套不同入射角/扇形彩虹构图）并新增**自动轮换**（`beamAuto` 默认开：每 16s 换一套，顺序 静光→缓息→流幕→聚光→斜光→交叉→仰光→虹光，2.4s smoothstep 插值过渡）；虹光用 `BeamSpec.tint/hueTint` + shader 截面色散；面板 `.ts-seg.is-wrap` 两行 8 chip + 「自动轮换」行。详见 `research/UPDATES-2026-10-24.md` §10。按用户「先自测」要求暂不发版（累计已超 §9 阈值）。
- 1.1.1：播放/暂停渐变增强——淡出/淡入时长分开（`playback.fadeOutMs` / `playback.fadeInMs`）、曲线可选（`playback.fadeCurve`: smooth/linear/exponential）、新增「人声保留淡出」（`playback.fadeVocal` / `playback.fadeVocalTailMs`，暂停时压低低频/高频让人声多留一会儿）；快捷设置新增人声保留开关；设置契约与 README 同步。
- 上一窗口（1.1.0）：设置改为居中大弹窗（效果设置同款）；新增 10 段均衡器（7 预设 + 手动增益，Web Audio BiquadFilter 链）；播放/暂停渐变（`playback.fadeEnabled/fadeMs`，默认关）；快捷设置新增「均衡器 / 播放暂停渐变」；修复宿主 settings patch 会重置同 section 其它字段的 bug（`SettingsService.ApplyKnownValues` 的 fallback 改为保留当前值）。
- 近期 patch：1.1.2 把 EQ 频响曲线从折线改为 PCHIP 平滑曲线，并修复「暂停后再播放首帧满音量」；1.1.3 把房间设置/文字设置弹层的遮罩改为铺满整个窗口（此前只暗底部一块），并补上设置滑块右侧数值、播放条滑杆风格图标；1.1.3 已按 `463995e` **重发覆盖** Release，额外包含「房间地毯远端椭圆色斑」修复（原实现用径向渐变椭圆做远端渐隐，粉色/深色房间会看出椭圆边界；改为裁切在地毯形状内的线性渐隐）。
- 注意：**同一版本号替换 Release 后，已安装该版本的客户端不会收到更新提示**（更新逻辑比版本号）；只有新下载安装包/新装用户拿到新构建。要让老用户自动升级必须递增版本发新 Release。
- 更新通道（本窗口完成）：GitHub Releases 自动检查 → 后台下载 → 提示安装 → 静默安装并重启；设置页「更新」分区；GitHub Actions 自动发版。已用本地 mock Release 真机实测 1.0.0 → 1.0.1 全链路。
- 代码已推到私有仓库 `KaFuuChino2006/Zilux2`（`main` 含完整历史；Releases 已发布 v1.1.0–v1.1.3，私有可见；`v1.0.0` tag 未推送、已被 1.1.x 取代）。`origin` 为 SSH over 443，见 §10。
- 本窗口已完成：房间效果系列（歌词颜色跟随/流星/粒子 3D/自定义）、发现页全量能力、歌曲信息、本地标签歌手 + 歌手页、本地曲库管理、统一下载 + 音质、顶部预期条、首页双收藏卡、应用内确认框、窗口动画设置。
- 详细更新清单：`research/UPDATES-2026-10-23.md`。

- 2026-10-25 第十三轮（横条视图封面异步回填修复，已推 main、**未发版**，1 处修复）：`web/src/ui/app.ts` 的 `buildSearchList` 行封面改为与海报网格同一套补图逻辑——先 `onlineArtwork(track)` 占位，若 `!track.cover` 则 `lookupCover(track)` 异步查找并回填 `track.cover` + 更新 `img.src`。原先网格 `posterNode` 有异步补图、横条没有，导致同一批曲目网格能刷新封面而横条停在程序化渐变占位。验证：横条（本地曲库 19 首）进入 0.7s 时 17 张占位/2 张真实 → 6s 后 17 张真实/2 张占位，与网格一致；剩余 2 首（霽れを待つ、スペア）为原封面 URL 加载失败回退渐变（网格同样），console 0 error。详见 `research/UPDATES-2026-10-25.md` §15。

- 2026-10-25 第十四轮（尾部渐弱收尾也计入不可听结尾，analyzer p0-5，已推 main、**未发版**，1 处增强）：`src/Zilux2/Analysis/TailSilenceDetector.cs` 在真静音不足 300 ms 时增加渐弱检测——250 ms 能量块 RMS dB（曲身 80 分位、末 4 块中位数），尾块须低于曲身 ≥8 dB；2 s 滑窗最小二乘斜率持续 ≤ -0.7 dB/s 的起点即渐弱开始；校验渐弱段 2–20 s、≤40% 时长、整体衰减 ≥8 dB、起点不低于曲身 6 dB，通过则 `audibleEndMs` 前移到渐弱开始、剩余段计入 `tailSilenceMs`。`AnalyzerVersion` p0-4 → p0-5（缓存键必须 bump）；`docs/zilux2-beat-analysis-contract.md` §2.1 同步字段语义与检测规则；前端 `crossfadeDeck.ts` 设置文案改为「跳过曲尾静音与明显渐弱收尾」。验证（合成夹具）：fade26 → 34000/27000/tail 7000；fade40 → 36000/28500/tail 7500；silence3s → 23000/20000/tail 3000 不变；真实曲目无回归（晴天(深情版).mp3 279028/275268/3760）。详见 `research/UPDATES-2026-10-25.md` §16。

- 2026-10-25 第十五轮（设置项：底部播放条「常驻展开」，已推 main、**未发版**，1 处新增设置）：`appearance` 新增 `playerBarExpanded`（默认 false；宿主 `SettingsModel`/`SettingsService` 白名单 + `docs/zilux2-settings-contract.md` §2；前端 `settings.ts` 默认值与 normalize + 设置→外观「播放条常驻展开」开关）。开启后 `<html>` 带 `is-pb-expanded`，`app.css` 末尾覆盖块（压过各断点折叠态）让播放条不依赖悬停保持展开：宽度 `min(1020px,88vw)`、圆角 20px、封面/歌手/进度条/音量/完整控制常显。验证（CDP）：开 → 鼠标不在播放条上仍 width 1020px / radius 20px、`settings.json` 落盘 `playerBarExpanded: true`；关 → 恢复折叠 452px。详见 `research/UPDATES-2026-10-25.md` §17。

- 2026-10-25 第十六轮（播放条下载按钮改为下载菜单，已推 main、**未发版**，1 处体验增强）：`downloadPicker.ts` 抽出共用浮层骨架 `openPopover()` 并新增 `openDownloadMenu()`（下载当前歌曲 / 打开下载队列；无歌曲或本地曲时下载项置灰）；`downloadQueue.createDownloadEntryButton(onActivate?)` 支持回调，app 播放条按钮改弹菜单（`aria-haspopup="menu"`），「下载当前歌曲」继续走 `beginDownload()` 音质选择（标准/高品质/无损，仅本次生效）。QA `downloads.mjs` 入口步骤同步为「入口 → 菜单 → 打开下载队列」并通过（15 PASS / 0 FAIL，25.4s）。详见 `research/UPDATES-2026-10-25.md` §18。

- 2026-10-25 第十七轮（**本地记录、未推送**，按用户要求「先不同步 hub」）：①rail「我喜欢的音乐」「最近播放」支持双击直接播放（单击仍只进页面，title 提示「双击直接播放」，`playRailList()` 进页后整列表播放）；②歌词页右上角关闭按钮在顶部窗口栏展开（`.app.is-topbar-peek`）时下移 58px 避让，不再被窗口按钮遮挡；③播放条「下一首」胶囊收窄（标题/歌手限 120px）；④待播队列面板新增每行「上移 / 下移 / 移出队列（跳过）」按钮与提示，`player.ts` 新增 `moveQueueItem()/removeQueueItem()`（移动/移除后自动重新准备无缝衔接）。详见 `research/UPDATES-2026-10-25.md` §19、§20。远端 main 仍停在 `5e596ef`。

- 2026-10-25 第十八轮（**本地记录、未推送**，按用户要求「先不同步 hub」）：整站主题自定义——①控制色：设置→外观新增「主题配色」色板（默认金 + 7 个预设 + 自定义取色器），一个颜色统一驱动按钮/高亮/进度条/选中态，并给页面底色混入约 3% 同色相（`web/src/ui/theme.ts` 新增 `ACCENT_PRESETS`/`readAccentColor`/`writeAccentColor`/`applyAccentColor`，键 `zilux2.accentColor`）；②页面背景：设置→外观新增「页面背景」三档（关闭/跟随封面/自定义图片）+ 选择图片…，自定义图片自动压缩到最长边 1600px、JPEG 0.82 存 `zilux2.appBgImage`（`web/src/ui/appBackground.ts`，旧开关 `zilux2.appCoverBg` 自动迁移；image 模式无播放也显示）。详见 `research/UPDATES-2026-10-25.md` §21。远端 main 仍停在 `5e596ef`。
- 2026-10-25 第十九轮（**本地记录、未推送**，按用户要求「先不同步 hub」）：页面背景模糊度与取景位置可调——设置→外观→页面背景新增「背景模糊度」滑块（0–140px，默认 34，保持旧观感）与「壁纸位置」五档（居中/顶部/底部/左侧/右侧）；`web/src/ui/appBackground.ts` 新增 `APP_BG_BLUR`/`APP_BG_POSITIONS`/`readAppBgBlur`/`writeAppBgBlur`/`readAppBgPosition`/`writeAppBgPosition`/`applyAppBgStyle`（写 `--app-bg-blur`/`--app-bg-scale`/`--app-bg-pos` 到 `:root`，键 `zilux2.appBgBlur`/`zilux2.appBgPosition`），`app.ts` 在构造函数与设置面板接入，`app.css` 的 `.app-bg-layer` 改为读变量；缩放固定 1.08（模糊度调大时背景不再放大）。验证：默认 34px / scale 1.08，拖到 110/140 图层 filter 正确且 transform 恒为 `matrix(1.08,0,0,1.08,0,0)`，取景 top → `background-position: 50% 0%`，重载持久化。详见 `research/UPDATES-2026-10-25.md` §22。远端 main 仍停在 `5e596ef`。

- 2026-10-25 第二十轮（**v1.1.8 发版**，全部已推送 `main` + tag `v1.1.8`）：功能缺口集中落地。①无缝衔接 Phase 2（手动切歌 1.2–2.0s 等功率短过渡 + 连续点击保最后一次；shuffle 自然播完无缝；单曲循环双 deck 淡出淡入；载入后后台预分析/预加载下一首，模式感知；`setPlaybackSpeed(0.5–2.0)` 播放速度档，`preservesPitch` 与 WSOLA 变速相乘）。②后台常驻闭环（`general.autoLaunch` 开机自启、`general.watchLocalFolder` 本地文件夹监控开关；下载队列 `POST /api/download/pause|resume|cancel|clear` + 前端行内控制 + 清空已完成；迷你播放器 `window.miniMode` 420×120 置顶贴底、Bounds/Topmost 保存还原、事件回推、`mini-player.css`；`POST /api/local/tag` 属性写入 + 前端标签编辑器）。③曲库管理（`localPlaylists.ts` 本地自建歌单 `zilux2.localPlaylists`、`localLikes.ts` 本地收藏 `zilux2.localLiked` 合并进「我喜欢的音乐」、`tagEditor.ts`；本地行更多操作：收藏/编辑标签/添加到歌单/文件夹中显示/移到回收站）。④桌面小功能（`searchHistory.ts`、`eqPresets.ts`、`sleepTimer.ts`（含「播完当前曲」）、`settingsIO.ts` 设置导出导入清缓存、`lyricPoster.ts` 1080×1440 歌词海报）。⑤两处真机 bug：本地歌曲播放 Format error（`LocalMusicService` 移除 `SetVirtualHostNameToFolderMapping`，所有请求统一走 `WebResourceRequested`，`ContentTypeOf` 补 lrc/json/图片 MIME）；标签写入 `0x80070057`（`GPS_READWRITE|GPS_BESTEFFORT` 非法 → `GPS_NO_OPLOCK 0x82`，失败补 `path/flags/hr` 日志）。⑥QA 套件现代化（tray 版本号读 `Directory.Build.props`、crossfade 准备阶段自动切「横条」布局并还原、长度档位字符串归一、无损缺失记 SKIP）。验证：真机自测全通过（截图 `research/shots/v118-*.png`）；QA 全量 **75 PASS / 0 FAIL / 4 SKIP（111.9s）**。详见 `research/UPDATES-2026-10-25.md` §24。

- 2026-10-25 第二十一轮（迷你播放器 v2，已推 main、**未发 tag**，等用户测试确认后发 1.1.9）：用户反馈「这个迷你播放器有排版还有画面bug，同时动画也很生硬，不像我软件的东西」。①排版 / 画面修复（`web/src/styles/mini-player.css` 整体重写，+378/-72）：窗口 420×120 内改为 400×100 悬浮卡片（圆角 16 / 1px 边框 / `--panel` 半透明 + blur 28px + 阴影），44px 封面 + 单行标题（省略号）+ 歌手 + 30~34px 控制键 + 28px 退出键，进度条绝对定位底部 3px（不带时间标签）不再被裁切，`.pb-actions` / 歌词 / 海报 / 音量 / 时间 / upnext / 快捷设置迷你态全部 `display:none`、hover 不再改变尺寸，doc 无溢出。②过渡动画：`src/Zilux2/MainWindow.xaml.cs` 复用 `BeginWindowMotion` 做窗口补间（`MiniEnterAnimationMs=320` / `MiniExitAnimationMs=380` / `EaseInOutCubic`，动画落位后才回推 `window.miniMode` 事件），`web/src/ui/app.ts` 增加 `miniTransition` 状态与 `is-mini-entering/exiting` 过渡态（900ms 兜底、过渡中忽略切换 / Esc / 双击），CSS 卡片关键帧 `mini-card-in/out` + `::before` 旧界面幕布，消除「整窗空白 → 小卡」硬切。③`docs/zilux2-host-contract.md` §15 补充补间动画语义与 `window.animate mini entering/exiting` 日志。按用户「不需要自己测试，交给我测试」要求，本轮由用户真机验证。详见 `research/UPDATES-2026-10-25.md` §25。

- 2026-10-25 第二十二轮（迷你播放器两 bug 修复 + 首页「私人雷达」，**已推 main（138f710）**，等用户测试确认后与 1.1.9 一起发）：①迷你窗口「有一个正方形框」：宿主新增 `SetWindowRgn` / `CreateRoundRectRgn` P/Invoke 与 `ApplyMiniWindowRegion`（16 DIP 圆角、进入落位后裁剪、退出先清区域、`SizeChanged` 重做），迷你态 `Browser.Margin` 清零；页面侧整窗铺 `--panel-solid`、`.playerbar-wrap` padding 归零、`.playerbar` 满窗去圆角/边框/阴影，窗口圆角完全交给宿主。②「鼠标放上去后播放按钮和歌曲名字等会位移」：根因是用户开启的「播放条常驻展开」+ 普通窗口 hover 规则压过迷你态规则，迷你态逐条 `!important` 固定 meta / cover / artist / controls / progress 几何，hover 零位移；同时移除 mount 时抢先恢复迷你态的逻辑（App 重启回普通窗口，页内刷新仍保持迷你）。③首页「私人雷达」卡片：网易云个人化歌单 id `3136952023`（`NeteaseLibraryProvider.GetPrivateRadarAsync` 复用 `GetPlaylistAsync` + 标题校验，`GetFeedAsync kind=radar`，`LibraryService` kind 白名单扩至 recent/daily/radar 且 radar 仅网易云，`MusicSourceCatalog` FeedKinds 加 radar）；前端 `home.ts` 今日推荐与私人雷达并列 `.home-daily-row` 两列（复用 daily-card 结构、compass 图标、两列栅格 ≤1120px 回退单列），`app.ts` 新增 `showRadarWall()` / `onRadar` / `playFromHome('radar')`，`client.ts` 新增 `FeedKind`，`sources.ts` feedKinds 补 radar。验证：迷你态几何 `[0,0,420,120]`、hover 零位移、桌面截图圆角无灰框、进出动画与刷新/重启行为通过（`research/tmp/lead-mini-v4/v5/v6.mjs`）；私人雷达首页 12 首 + 墙 35 首、播放全部队列 35、1600/1280/1100 响应式截图 `radar-home*.png`；宿主日志 `GET netease/library radar ok 12/35 total`；QA 全量 74 PASS / 0 FAIL / 4 SKIP（crossfade 收尾 QQ 搜索 502 网络抖动，单项重跑 9 PASS 全绿）。详见 `research/UPDATES-2026-10-25.md` §26 / §27。

- 2026-10-25 第二十三轮（预告条倒计时闪现修复 + 歌词海报移除，**已推 main（92bed17）**，与 1.1.9 合并交付）：①用户报障「顶部预告条在渐变过渡 / 正在播放收回时『秒后切换』四个字短暂出现」（m03369）——`web/src/ui/upNextToast.ts` 的 `setPhase` 把「预告阶段」显式 toggle 成 `is-preview` class（读秒结束分支移除）；`web/src/styles/app.css` 把 `.unt-count` 默认收起、仅 `.upnext-toast.is-preview .unt-count` 展开，并对 `:not(.is-preview)` 关闭过渡（`transition: none`），消除「类名移除时过渡把单位文案重新展开」的闪现。②用户要求删除「歌词海报」（m03419）——删除 `web/src/ui/lyricPoster.ts`、播放条「享」按钮与 `openLyricPosterSheet` 引用、`polish-tools.css` 的 `.lyp-*` 整段与关键帧、`mini-player.css` 的 `.pb-btn-poster` 规则（`research/tmp/patch-remove-poster2.py`，14 处精确替换）。验证：CDP 采样 31 帧 transition + 56 帧 current + 收回，全程泄漏帧 0、`COUNT_TEXT_OUTSIDE_PREVIEW 0`；`POSTER_REMOVED {"btn":0,"glyph":"词","lypSheetCss":false}`；tsc 0、vite 产物已部署。详见 `research/UPDATES-2026-10-25.md` §28。


- - 2026-10-25 第二十五轮（1 处用户报障修复：播放条常驻展开时悬停内容位移，**已推 main（d746f63）**，与 1.1.9 合并交付）：用户报障「在开启播放条常驻展开的时候，鼠标放上去的时候内容会位移一点点，移开又会复位」（m03767）。根因：基础规则 `.playerbar .pb-meta { margin-left: 8px }` 与 hover 规则 `.playerbar:hover .pb-meta { margin-left: 6px }` 冲突，「常驻展开」块只覆盖了尺寸/显隐、未覆盖 margin-left，导致悬停时 `pb-meta` 及其右侧整排元素左移 2px。修复：`html.is-pb-expanded .playerbar .pb-meta` 增加 `margin-left: 6px`（与 hover 同值，选择器特异性更高无需 `!important`）。验证：CDP 悬停前后 `margin-left` 均 6px、`width` 均 190px，全部播放条元素几何 `DIFF {}`（移入/移出零位移）；`vite build` 产物 `main-8HoC5BgP.js` / `main-BA6r7d7h.css` 已部署；QA smoke 12 PASS / 0 FAIL。截图 `research/shots/pb-expanded-hover-fixed.png`。详见 `research/UPDATES-2026-10-25.md` §30。

- 2026-10-25 第二十六轮（本地歌单新建后行渲染异常，**本轮**，仅前端 CSS 2 处）：用户报障（m03825）「这个本地歌单新建出来怎么是这样的」——「我的歌单」弹层里新建的本地歌单渲染成一张占满整行的浅色空卡片，只有居中的列表图标，歌单名 /「N 首 · 本地」/ 右侧播放·重命名·删除按钮都不可见。根因：`renderLocalPlaylists()` 的行封面复用了为「歌单卡片网格」设计的 `local-playlist-cover` class，而 `local-library.css` 里的 `.local-playlist-cover` 未限定作用域、带 `width:100%; aspect-ratio:1`，覆盖 `.row-cover` 的 44px 固定宽高 → 封面撑满整行、`.row-meta` 被挤成 0 宽。修复：限定 `.local-playlist-card .local-playlist-cover`，并新增 `.local-playlist-host .row-cover{display:grid;place-items:center;color:var(--muted)}` 让空歌单图标居中。构建：`tsc --noEmit` EXIT 0、`vite build` → `main-BaoS7TO4.js` / `main-BeBJAJgp.css` 已部署；按用户 m03815「以后无需自行测试」，本轮未跑 CDP/QA，交用户验证。详见 `research/UPDATES-2026-10-25.md` §31。

- 2026-10-25 第二十七轮（本地歌单「添加歌曲」入口，**本轮**，前端 2 文件）：用户提问（m03889）「本地歌单有了，那怎么添加歌曲进去呢」——此前唯一入口在「本地曲库 → 歌曲更多操作 → 添加到歌单」，空歌单没有引导。①`web/src/ui/dom.ts` 的 `ICONS` 新增 `plus`；②`web/src/ui/app.ts`：`WallData` 增加可选 `playlistId`、`openLocalPlaylistWall()` 写入且**空歌单自动弹出加歌面板**；歌单墙工具栏新增「添加歌曲」按钮 + 新方法 `openPlaylistAddSheet(playlistId)`（面板含搜索框、提示「点击歌曲即可加入，可连续添加」、只列未在该歌单的本地曲目，点击即 `addTracksToPlaylist` 并刷新候选列表）与 `refreshLocalPlaylistWall(playlistId)`（加入后就地刷新墙的标题/首数/曲目）；③「我的歌单」弹层里每个本地歌单行的操作区新增「+」按钮（title「添加歌曲」）。构建：`tsc --noEmit` EXIT 0、`vite build` → `main-DugPrRix.js`（879.37 kB）已部署；按 m03815 约定未跑 CDP/QA，交用户验证。详见 `research/UPDATES-2026-10-25.md` §32。
- 2026-10-25 第二十八轮（歌词页浅色主题可读性，**本轮**，前端 2 文件）：用户（m03971）反馈「我感觉这个默认的歌词页面这些歌词看不太清楚」——根因是歌词页配色按深色主题写（白字 + 低透明度深墨），而当前固定浅色主题，白字叠浅底几乎不可见。①`web/src/ui/theme.ts` 两套主题新增歌词语义令牌 `--lyric-dim/near/active/char/char-active/sung/hot`，浅色主题取深字；②`web/src/styles/app.css` 末尾追加可读性块，歌词各行/逐字/翻译全部改用令牌，浅色主题下收背景（`.lyrics-bg` opacity .42、`.lyrics-scrim` 提高不透明度、未唱行取消 `filter: blur()`），右侧布局透明度提高到 .8/.92。构建：`tsc --noEmit` EXIT 0、`vite build` → `main-Dh6wjHgU.js`（879.85 kB）/ `main-BsI_ydkf.css`（230.51 kB）已部署；按 m03815 约定未跑 CDP/QA，交用户验证。详见 `research/UPDATES-2026-10-25.md` §33。
- 2026-10-25 第二十八轮补充（歌词页左侧发虚）：用户（m04058）反馈「在屏幕画面变大的时候歌词左侧会虚掉一点」——`.lyrics-right` 与其歌词层沿用了 `linear-gradient(90deg, transparent 0%, #000 6%, #000 100%)` 横向遮罩，按容器宽度 6% 淡出、父层与歌词层各遮一次，窗口越大淡出区越宽，左对齐歌词首字被吃掉。修复：`web/src/styles/app.css` 删除横向遮罩与 `mask-composite`，仅保留上下 12% 纵向淡出；构建 `main-OHOp6aIf.js`（879.85 kB）/ `main-BUcO2X20.css`（230.34 kB）已部署；按约定未自测。详见 `research/UPDATES-2026-10-25.md` §34。
- 2026-10-25 第二十九轮（歌词接近尾部时可见度变差，**本轮**，前端 1 文件）：用户（m04080）反馈「同时，歌词在播放到接近尾部的那几段的时候歌词的可见度完全不如前面播放的」。根因：`web/src/styles/app.css` 的上下淡出遮罩同时挂在 `.lyrics-right` 与会被 `translateY` 平移的 `.lyrics-lines` 上，遮罩按内容高度 12% 计算 → 歌曲首尾各 12% 的歌词行永远处在淡出带里，越接近结尾越淡。修复：遮罩只保留在 `.lyrics-right`（视口层），`.lyrics-right .lyrics-lines` 显式 `mask-image: none`；补注释。构建：`main-CIbu5rjT.js`（879.85 kB）/ `main-B_zi6NN3.css`（230.38 kB）已部署；按 m03815 未自测。详见 `research/UPDATES-2026-10-25.md` §35。
- 2026-10-25 第三十轮（歌词播放样式：经典 / 发光 / 渐变 / 频谱律动，**本轮**，前端 4 文件）：用户（m04167）提出「关闭的这个歌词播放效果是否可以做几种不同的来自由切换」，补充「是现在关闭的这个默认歌词的效果，可以有几种不同的歌词播放样式，比如发光或者其他什么的」。新增 `web/src/ui/lyricStyle.ts`（localStorage `zilux2.lyricStyle`，`LYRIC_STYLES` / `lyricStyle` / `setLyricStyle` / `onLyricStyle`）；`lyrics.ts` 按样式挂 `lyric-style-*` class、频谱样式下用 `playbackAnalyser()` 在底部 canvas 画 64 根镜像条（rAF，离开样式/关闭页面即停）；`app.ts` 快捷设置新增「歌词样式」白色滑块分段（仅播放效果=关闭时显示）；`app.css` 追加发光（双层主题色 text-shadow）、渐变（background-clip: text）、频谱（贴底 canvas）样式。构建：`main-BMv57LEj.js`（883.82 kB）/ `main-DJvoUqrY.css`（232.09 kB）已部署；按 m03815 未自测。详见 `research/UPDATES-2026-10-25.md` §36。
- 2026-10-25 第三十一轮（「渐变」歌词样式叠字重影修复，**本轮**，前端 2 文件）：用户（m04252 截图 + m04253）「渐变为什么会这样叠文字」——上一版渐变用 `background-image + background-clip: text` 画在整行上、行与逐字 span 文字填充透明，和逐字 `is-sung/is-hot` 的颜色/阴影 !important 规则、行级 text-shadow、逐帧 `--grow` 字号动画叠在一起，出现两层字形半透明重叠。修复：放弃 `background-clip`，`lyrics.ts` 新增 `paintGradientTones()` 给每个字写 `--lyric-grad`（有封面色板按色板、无则主题色→暖白），在 `syncProgress` / `paintGradientFlow` / `applyLyricStyle` 调用并清理；`app.css` 渐变规则改为 `color/-webkit-text-fill-color: var(--lyric-grad)` + `text-shadow: none !important`。构建：`main-Bk0F_pSp.js`（884.61 kB）/ `main-D3reKDLU.css` 已部署；按 m03815 未自测。详见 `research/UPDATES-2026-10-25.md` §37。
2026-10-25 第二十四轮（无缝过渡准备完成后的倒计时提示，**已推 main（34b39a8）**，与 1.1.9 合并交付）：用户要求「无缝过渡准备完毕后可以在下方弹出一行文字写着将在几分几秒后过渡至xxx」（m03570），初版为播放条下方常驻小字；用户随后要求改为弹出式、显示在播放条上方且几秒自动消失（m03694），并注明本次过渡时长（m03716）。实现：`web/src/ui/crossfadeDeck.ts` 新增导出 `readCrossfadeDebug()`（只读快照）；`web/src/ui/app.ts` 新增 `formatCountdownSpan()` / `formatFadeSeconds()`、`SEAMLESS_HINT_VISIBLE_MS = 4200`、字段 `seamlessHint/seamlessHintTimer/seamlessHintKey`、播放条 `playerbar-wrap` 内 `.pb-seamless-hint` 元素与 `syncSeamlessHint(state)`（显示条件：有曲目 + playing + enabled + phase==='prepared' + nextPrepared + 剩余 >1000ms + 非迷你态；按轮次 key 只弹一次、4.2s 后自动隐藏、可见期间每秒刷新，文案「将在 X 后过渡至「下一首」（过渡约 Y 秒）」；`syncPlayer` 各路径均同步）；`web/src/styles/app.css` 新增 `.pb-seamless-hint` 胶囊样式（播放条上方 `bottom: calc(100% + 10px)`、居中、12px、border `--line`、`--panel` 背景 + blur、◈ accent 前缀、弹性弹入；放在 `playerbar-wrap` 内，迷你态被既有 wrap 规则自动隐藏）。验证（`research/tmp/lead-seamhint-popup.mjs`）：弹窗在播放条上方（底部 945 < 播放条顶 955）、文案「将在 2 分 2 秒 后过渡至「After the Fever」（过渡约 6.4 秒）」（`debug.fadeMs = 6447`）、约 4231ms 后自动隐藏且不重弹；seek 到曲末 fading 全程隐藏、切歌后进入下一轮 prepared 再弹出；迷你态 `display:none`；截图 `research/shots/seam-hint-popup.png`。详见 `research/UPDATES-2026-10-25.md` §29。

2026-10-26 第三十二轮（歌词播放样式改版：只留经典，删除发光 / 渐变 / 频谱，新增上浮 / 波浪 / 弹跳 / 打字机 / 漂浮 5 种「播放动画」；**已推 main（95aa96a）**，版本保持 1.1.9、不打 tag）：用户要求「歌词样式除了经典其他全部删除，然后新增几个样式……要做的是改歌词的播放动画，颜色受上面的歌词颜色控制」。①`web/src/ui/lyricStyle.ts` 整文件重写：`LyricStyle = 'classic' | 'rise' | 'wave' | 'bounce' | 'typewriter' | 'float'`，`LYRIC_STYLES` 6 条（带 `charTiming`），文件头写死「歌词效果制作模板」7 条，旧值 glow / gradient / spectrum 自动回落 classic；②`web/src/ui/lyrics.ts`：删频谱 canvas / rAF 与渐变 `paintGradientTones / --lyric-grad`，`applyLyricStyle()` 只切 class + `syncProgress()`，新增 `splitPlainTokens()`（普通 LRC 行也切 `.lyric-char` + 内联 `--ci`）与 `syncPlainCharStates()`（charTiming 样式按句内进度合成 is-sung / is-hot）；③`web/src/styles/app.css`：整段删旧样式，新段为「播放动画模板」注释 + 5 种动画（上浮 / 波浪 / 弹跳 / 打字机 / 漂浮），全部用独立 `translate / scale`（历史规则 !important 锁死 transform）、animation 用高特异性 !important 反压、整段包 `prefers-reduced-motion: no-preference`；快捷样式行 6 按钮 11px；④`web/src/ui/app.ts` 注释与 `quick-lyric-style-seg` 类。构建：`tsc --noEmit` EXIT 0、`vite build` → `main-CI1lynmo.js`（882.90 kB）/ `main-DccpaaFn.css`（232.45 kB）已部署；按 m03815 未自测。详见 `research/UPDATES-2026-10-25.md` §38。

## 9. 版本与发版节奏（约定）

- 版本号只递增第三位（patch）：`1.1.x`；小修小补也**不要**跳到 `1.2.0`。
- **发版门槛**（满足其一才递增版本并发 Release）：
  1. 累计修复 / 优化类改动 **超过 5 处**；
  2. 累计新增功能 **3 个以上**。
- 未达门槛：正常提交并推送 `main`，但**不改** `Directory.Build.props` 版本、不打 tag、不发 Release（1.1.4 第二~五轮微调按此处理：推 `main`，版本仍 1.1.4；第三轮起累计已超阈值，但按用户「先自测」要求，直到用户确认效果后才于 2026-10-24 发 **1.1.5**；1.1.6 之后的 2026-10-25 第二轮（3 处修复/优化）与第三轮（1 个新增功能 + 2 处修复/优化）同样未达门槛 → 推 `main`、版本仍 1.1.6）。 2026-10-25 第四轮（P0 节拍分析）为 1 个实验性新增功能，累计仍不足「新增功能 ≥3」，且用户明确「先做 P0 让我听听」→ 推 `main`、版本仍 1.1.6，等试听确认后再定 1.1.7 或进入 B 版 Phase 1。第五轮（BPM 倍速修复 p0-3，1 处修复）与第六轮（B 版 Phase 1 无缝衔接 MVP，1 个新增功能）继续推 `main`、版本仍 **1.1.6**、无 tag（累计新增功能仍 2 个 < 3；若 Phase 2+ 落地后再评估是否发 1.1.7）。第七轮（尾端静音自动排除 + 收藏歌单实测，1 处体验优化）同样只推 `main`、版本仍 **1.1.6**、无 tag。第八轮（把过渡时长调到保守 5–10s：auto=4 小节夹 5–10s、固定档 5/7/10s，1 处体验优化）同样只推 `main`、版本仍 **1.1.6**、无 tag。 第九轮（过渡对齐下一首开始唱词：前奏较长跳过、前奏较短整段作过渡，1 处体验优化）同样只推 `main`、版本仍 **1.1.6**、无 tag。 第十轮（过渡时长放宽到 3–30 秒 + 自动，1 处体验优化）同样只推 `main`、版本仍 **1.1.6**、无 tag。第十一轮（WSOLA 节拍对齐 + 更慢/人声优先融合）、第十二轮（过渡时顶部提示改为「正在无缝过渡到下一首」）、第十三~十六轮（横条封面回填、尾部渐弱收尾 p0-5、播放条常驻展开设置、播放条下载菜单）均只推 `main`、版本仍 **1.1.7**、无 tag（1.1.7 之后的累计修复/优化与新增设置尚未达「>5 处修复」或「≥3 个新增功能」，待用户确认后再评估 1.1.8）。2026-10-25 第二十轮（功能缺口集中落地：新增功能 ≥6 个、修复 ≥5 处，且用户明确要求「版本号+0.0.1」）满足门槛 → 发 **1.1.8**（tag `v1.1.8` 推 GitHub，Actions 自动构建 Release 资产）。2026-10-25 第二十一轮（迷你播放器 v2：2 处修复 + 1 处动画增强）：用户明确「不需要自己测试，交给我测试就行」→ 版本 bump 到 **1.1.9** 并构建、装到本机供用户测试；代码推 `main`，**暂不打 tag、不发 Release**，等用户测试确认后再 `git tag -a v1.1.9 && git push origin v1.1.9`。2026-10-25 第二十二轮（迷你播放器 2 处用户报障修复 + 1 个新增功能「私人雷达」）：未达「>5 处修复 / ≥3 个新增功能」门槛，但 1.1.9 本身尚未发版、且用户要求「做完给我测试」→ 版本保持 **1.1.9**（不重复 bump），本轮改动提交并推 `main`，与第二十一轮合并进同一次 1.1.9 Release；用户测试确认后先 `git tag -a v1.1.9` 推送发版。2026-10-25 第二十三轮（1 处用户报障修复 + 1 处功能移除：预告条倒计时「秒后切换」闪现、歌词海报删除）：未达「>5 处修复 / ≥3 个新增功能」门槛，版本保持 **1.1.9**，推 `main`、不打 tag，与 1.1.9 合并交付，用户确认后统一发 Release。2026-10-25 第二十四轮（1 个新增体验：无缝过渡倒计时提示，后按用户要求改为播放条上方弹窗 + 过渡时长）：版本保持 **1.1.9**，推 `main`、不打 tag，与 1.1.9 合并交付，用户确认后统一发 Release。2026-10-25 第二十五轮（1 处用户报障修复：常驻展开悬停位移）：版本保持 **1.1.9**，推 `main`、不打 tag，与 1.1.9 合并交付。2026-10-25 第二十六~二十八轮（本地歌单行渲染修复 / 本地歌单「添加歌曲」入口 / 歌词页可读性）：均未达发版门槛，版本保持 **1.1.9**，推 `main`、不打 tag，与 1.1.9 合并交付。2026-10-25 第二十九轮（1 处用户报障修复：歌词接近尾部时可见度变差）：版本保持 **1.1.9**，推 `main`、不打 tag，与 1.1.9 合并交付。2026-10-25 第三十轮（1 个新增体验：歌词播放样式 4 种可自由切换）：版本保持 **1.1.9**，推 `main`、不打 tag，与 1.1.9 合并交付。2026-10-25 第三十一轮（1 处新功能缺陷修复：渐变歌词叠字重影）：版本保持 **1.1.9**，推 `main`、不打 tag，与 1.1.9 合并交付。2026-10-26 第三十二轮（歌词播放样式改版：删除发光 / 渐变 / 频谱，新增 5 种播放动画）：版本保持 **1.1.9**，推 `main`、不打 tag，与 1.1.9 合并交付。
- 2026-10-26 第三十三轮（系统媒体键接管：用户报障「系统的原生切换在其他页面不生效」，根因是 QQ 音乐等程序用 RegisterHotKey 抢注键盘媒体键、SMTC 收不到 ButtonPressed；改用 WH_KEYBOARD_LL 钩子在 Zilux2 是当前会话时接管——1 处用户报障修复 + 1 处功能增强）：未达「>5 处修复 / >=3 个新增功能」门槛，版本保持 **1.1.9**，推 `main`、不打 tag，与 1.1.9 合并交付。详见 `research/UPDATES-2026-10-25.md` §39。
- 2026-10-26 第三十四轮（上浮样式下方歌词统一最低可见度：1 处用户观感调整，纯前端 CSS）：未达门槛，版本保持 **1.1.9**，推 `main`、不打 tag，与 1.1.9 合并交付。详见 `research/UPDATES-2026-10-25.md` §40。
- 2026-10-26 第三十五轮（歌词样式二轮微调：弹跳重做 / 打字机隐藏未唱行 / 漂浮改旋入，1 处重做 + 2 处调整，纯前端 CSS）：未达门槛，版本保持 **1.1.9**，推 `main`、不打 tag，与 1.1.9 合并交付。详见 `research/UPDATES-2026-10-25.md` §41。
- 2026-10-26 第三十六轮（旋入改为文字随机飘入组成句子：1 处用户效果调整，纯前端 JS + CSS）：未达门槛，版本保持 **1.1.9**，推 `main`、不打 tag，与 1.1.9 合并交付。详见 `research/UPDATES-2026-10-25.md` §42。
- 2026-10-26 第三十七轮（旋入未播放歌词统一最低可见度：1 处用户观感调整，纯前端 CSS）：未达门槛，版本保持 **1.1.9**，推 `main`、不打 tag，与 1.1.9 合并交付。详见 `research/UPDATES-2026-10-25.md` §43。
- 2026-10-26 第三十八轮（旋入未播放歌词按距离打乱、越靠近越整齐：1 处用户效果调整，纯前端 JS + CSS）：未达门槛，版本保持 **1.1.9**，推 `main`、不打 tag，与 1.1.9 合并交付。详见 `research/UPDATES-2026-10-25.md` §44。
- 2026-10-26 第三十九轮（旋入换行不再重新组装、靠近播放的歌词保持半散逐步收拢：1 处用户效果调整，纯前端 JS + CSS）：未达门槛，版本保持 **1.1.9**，推 `main`、不打 tag，与 1.1.9 合并交付。详见 `research/UPDATES-2026-10-25.md` §45。
- 2026-10-26 第四十轮（新样式恢复唱过字的缩小落回动画：1 处用户观感修复，纯前端 CSS）：未达门槛，版本保持 **1.1.9**，推 `main`、不打 tag，与 1.1.9 合并交付。详见 `research/UPDATES-2026-10-25.md` §46。
- 2026-10-26 第四十一轮（歌词样式「弹跳」换成「摇曳」：1 处用户效果调整，纯前端 JS + CSS）：未达门槛，版本保持 **1.1.9**，推 `main`、不打 tag，与 1.1.9 合并交付。详见 `research/UPDATES-2026-10-25.md` §47。
- 达到门槛：改 `Directory.Build.props` → 提交 → `git tag -a v<version> -m "Zilux2 <version>"` → `git push origin v<version>`（Actions 自动构建发布）。
- **同版本替换已发布构建**（用户要求「替换最新版但版本号不换」时）：不改版本号；先删远端/本地旧 tag，再把 `v<version>` 重新指到新提交并 push：
  ```bash
  git tag -d v1.1.3
  git push origin :refs/tags/v1.1.3
  git tag -a v1.1.3 -m "Zilux2 v1.1.3（重发）" <new-commit>
  git push origin v1.1.3
  ```
  Actions 会重新跑并覆盖同一 Release 的资产；本地再 `make-installer` + 静默安装同步。已安装同版本的客户端不会提示更新（见 §8）。
- 已按此节奏发布：`v1.1.0`（设置居中/EQ/渐变）、`v1.1.1`（渐变细分 + 歌曲信息浮窗）、`v1.1.2`（EQ 平滑 + 首帧爆音）、`v1.1.3`（效果弹层遮罩；后按 `06ef14e` 重发含滑块数值/图标，再按 `463995e` 重发含地毯椭圆修复）、`v1.1.4`（房间预设/本地目录监控/下载队列/QA 套件）、`v1.1.5`（纯字光柱 8 套样式 + 多入射角/彩虹/自动轮换）、`v1.1.6`（后台常驻/托盘/全局热键/下载入口迁移/快捷下载页/音质选择）、`v1.1.7`（无缝衔接：鼓点对齐自动过渡 / WSOLA / 尾端静音 / 唱词对齐 / 过渡提示）。

## 10. 更新通道（GitHub Releases）

- 设计/协议/发版说明：`docs/zilux2-update-channel.md`；建仓与首发步骤：`docs/zilux2-github-setup.md`。
- 版本唯一来源：根目录 `Directory.Build.props` 的 `<Version>`（宿主/安装器继承；改它即改版本号）。
- 默认更新源：编译期注入 `ZiluxUpdateRepo`（`Directory.Build.props` 默认 `KaFuuChino2006/Zilux2`，CI 用 `github.repository` 覆盖）；运行时设置 `updates.repo` 可覆盖。
- 资产：`Zilux2-Setup-<version>.exe`；宿主下载到 `%LOCALAPPDATA%\Zilux2\updates\`，校验 GitHub `digest`（sha256）后以 `--silent --no-shortcuts --launch --dir <安装目录>` 静默安装并重启。
- 默认 `updates.mode="auto"`（自动下载+提示安装），可切 `"notify"`（只提示）；`updates.autoCheck` 控制启动检查 + 每 4 小时轮询。
- 发版：改 props 版本 → 提交 → `tools\release.ps1`（或 push tag `v<version>`，Actions 自动构建发布）。
- 当前 Release：`v1.1.7`，tag 指向 v1.1.7 发布提交（2026-10-25 推送）；Actions 自动构建资产 `Zilux2-Setup-1.1.7.exe` / `Zilux2-Portable-1.1.7.zip` / `.exe.sha256`。上一版 `v1.1.6`（2026-10-25 发布），更早 `v1.1.5` / `v1.1.4` 等见上。
- 仓库可见性：应用内更新走未认证 GitHub API，**只有公开仓库的 Release 可见**；开发期可先建私有仓库存代码（先不推 tag），要发布更新时把仓库切 public 再推 tag。客户端对 404 的提示为「仓库不存在、未公开，或还没发布 Release」。当前仓库仍是 private：Releases 已发布但匿名 API 查不到，**应用内自动更新暂不可用**；要启用自动更新需把仓库切成 public（或后续给客户端加 token 支持）。
- 本机网络：`github.com:443`（HTTPS）被重置/超时，`origin` 走 **SSH over 443**：`ssh://git@ssh.github.com:443/KaFuuChino2006/Zilux2.git`，deploy key 在 `C:\Users\13329\.ssh\zilux2_deploy`，仓库本地已配 `core.sshCommand`；细节见 `docs/zilux2-github-setup.md` §4.3。
- 注意：更新包未做代码签名（SmartScreen 会提示，属预期）。

## 11. 已知限制 / TODO

- **应用内自动更新目前不可用**：仓库是 private，未认证 GitHub API 查不到 Release（404）。要启用：仓库 Settings → 底部 Danger Zone → Change visibility → Public（或后续给客户端做 token 支持）。切 public 后，还需发一个**比已装版本更高**的 Release 才会触发更新提示。
- QQ 搜索主接口偶发 500，回退备用接口会增加首次搜索耗时（约 10s）。
- QQ 会员曲目下载/播放受限（提示需要会员）。
- 匿名/失效 mvmp3 曲目 403（上游下架）。
- 房间效果为 Canvas2D + DOM，低配机可调低「渲染像素比」。
- 回归靠 `research/qa/suite/`（CDP 套件 + 截图 + results JSON），`node research/qa/suite/run-all.mjs` 一键跑；前提是应用带 `--remote-debugging-port=9223` 运行，且依赖真实在线网络（搜索/下载用例）。
- 歌词播放动画是纯前端实现：样式注册表在 `web/src/ui/lyricStyle.ts`，动画在 `web/src/styles/app.css` 末尾「播放动画模板」段（上浮 / 旋入把当前行下方未播放行压到 `opacity: 0.2`，打字机为 `0`；旋入还按距离把下方未播放行打乱，`--scatter` 为整列连续散开系数：当前行 0.6 半散、往后每行 +0.15 到 1.0、已唱行 0，当前行承接半散状态逐字归位、换行不再重新组装），逐字的随机「飘入」偏移（`--drift-x / --drift-y / --drift-rot / --drift-dur`）由 `web/src/ui/lyrics.ts` 的 `render()` 用稳定伪随机写入（同一字每次渲染一致）；旧存档里的 `float` 会因校验失败自动回落 `classic`。修改后需重建并覆盖安装目录 `web/`，**部署后自动重启应用**（用户约定）加载；新样式覆盖 `transition` 时必须带上 `transform`，否则经典「唱到放大、唱完缩小落回」的逐字缩放会被瞬切（第四十轮已补）；第四十一轮把「弹跳」换成「摇曳」——唱完的字由 `.is-sung` 触发左右摆动（`rotate` -7° → 6° → -3° → 0，0.52s），老存档 `bounce` 自动迁移到 `swing`。
- 后续可做：歌词页多效果、更多平台能力；下载队列暂无「取消/清空」宿主接口（面板如实提示）；本地目录监控无设置开关（默认开启）。
- 后台常驻/托盘/热键的已知限制：全局热键每动作有候选回退（全部被占用时该动作无热键，只记 WARN）；托盘依赖资源管理器通知区域，初始化失败时关窗即退出（日志 `tray.unavailable`）；托盘气泡只弹一次；播放条下载按钮打开下载队列浮层而不是直接下载当前曲目；真正退出只有托盘菜单「退出」与更新安装两条路径。
- 系统媒体键接管的已知限制（第三十三轮）：仅当 Zilux2 是当前媒体会话且快捷键总开关开启时吞键；接管期间其它播放器收不到媒体键（这是接管目标，若希望其它程序优先可关总开关或让其它程序成为当前会话）；`VK_MEDIA_STOP` 不接管；底层键盘钩子对全屏独占游戏等场景不保证生效。

## 12. 常用命令速查

```powershell
# 当前版本号（唯一来源）
Select-String '<Version>' Directory.Build.props

# 看宿主日志
Get-Content "$env:LOCALAPPDATA\Zilux2\logs\host.log" -Tail 40 -Wait

# 关掉程序
taskkill /IM Zilux2.exe /F

# 启动带调试
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9223'; Start-Process "$env:LOCALAPPDATA\Programs\Zilux2\Zilux2.exe"

# 只部署前端（部署后必须重启应用：用户约定「记得自动重启软件」）
Copy-Item -Recurse -Force web/dist/assets dist/Zilux2/web/; Copy-Item -Force web/dist/index.html dist/Zilux2/web/
Copy-Item -Recurse -Force web/dist/assets "$env:LOCALAPPDATA\Programs\Zilux2\web/"; Copy-Item -Force web/dist/index.html "$env:LOCALAPPDATA\Programs\Zilux2\web/"
taskkill /IM Zilux2.exe /F
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9223'; Start-Process "$env:LOCALAPPDATA\Programs\Zilux2\Zilux2.exe"

# QA 回归套件（应用需带 --remote-debugging-port=9223 运行；node 用 DSH 自带路径）
node research/qa/suite/run-all.mjs        # 全部套件（约 100s，退出码 0/1）
node research/qa/suite/smoke.mjs          # 单跑某个套件
```

> Node / Python 用 DSH 运行时自带路径：`C:/Users/13329/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/{node/bin/node.exe,python/python.exe}`。
