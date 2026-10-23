# 播放效果 · 房间（薄荷绿纵深隧道）

歌词页「播放效果」第三档 `room` 的实现说明。旧版是 three.js 暗灰房间 + 一条长条地毯 + 整句
CanvasTexture，观感与参照图差距大，已在 2026-10-21 整体重做。

## 观感

- 薄荷绿对角渐变背景 + 手绘感白色同心环带隧道（有纵深感，环带随镜头推进外扩、从脚下掠过）；
- 每句歌词按逐词拆开，随机散落在前方一个竖直平面上（词有前后纵深，近大远小）；
- 镜头水平正视（无俯仰、无滚转，与歌词平面严格 90°），跟着当前句在 z 方向推进；
- 底部一条磨砂玻璃长条：NOW PLAYING + 歌名 + 歌手 + 时间 + 进度。

## 文件

| 文件 | 职责 |
| --- | --- |
| `web/src/ui/roomScene.ts` | 场景引擎：Canvas2D 背景 + DOM 逐词条 + 歌名长条。不自带 CSS 文件，样式由模块注入 `<style id="zlr-room-style">`。导出 `createRoomScene()` / `RoomScene` / `RoomSceneSong` 等。 |
| `web/src/ui/room.ts` | 包装层：播放器锚点时钟、`playbackAnalyser` 低频能量、`.lyrics-stage` 样式契约（`is-on` / `is-ready` / `is-content` / `is-painted`）、`setSong` 签名去重。 |
| `web/src/styles/app.css` | 房间档的落底色与亮场控件配色（`.lyrics-stage.is-room`、`.lyrics-view.is-room ...`）、`is-covered` 时停渲染 DOM 歌词。 |
| `web/src/ui/lumiere.ts` | `LUMIERE_MODES` 里 `room` 的 label「房间」与 hint 文案。 |
| `web/preview-room.html` + `web/src/dev/roomPreview.ts` | 独立预览页（假歌 40 行），只用于调视觉，不进生产构建。 |
| `research/qa/room-preview-shot.mjs` | headless Edge 跑预览页截图（`--times 12,40 --out research/shots/room-preview`）。 |
| `research/qa/room-app-qa.ps1` / `.mjs` | 真实 app 端到端验收：构建→部署→带 CDP 启动→切 room→播歌→开歌词页→截图/DOM/FPS/console。 |

## 关键参数（roomScene.ts 顶部常量）

- 镜头：`FOV_Y=50°`、`CAM_HEIGHT=0.9`、水平正视；每句在 z 方向间隔 `LINE_GAP=5.6`，当前句焦点深度
  `FOCUS_DEPTH=7.6`，行内随进度再前推 `CREEP_DISTANCE=0.5`，阻尼 `3.4`（暂停时 `8`，seek 超过 1.5s 直接吸附）。
- 环带：环心固定在镜头前方 `RING_CENTER_DEPTH=12.6`；每条环带按「最近点离镜头多远」等比排开
  （`RING_SLOTS=6`、`RING_CYCLE=6.5`、`RING_LIFE=1.18`），屏幕上是近疏远密、近粗远细；
  带宽 `RING_BAND=0.085`（相对深度），半径带 ±1% 正弦扰动避免「靶心」感。
- 逐词：确定性伪随机（按 `trackKey#lineIndex` 播种）散在安全区 (`WORD_AREA_X=0.335`，
  `WORD_AREA_TOP=-0.275`，`WORD_AREA_BOTTOM=-0.01`)，词间做矩形避碰，放不下就缩字号重排；
  字号按词数 `clamp(0.42/n^0.6, 0.046, 0.18)`；纵深偏移 `[-0.7, +0.9]`；三态透明度
  未唱 0.86 / 唱过 0.97 / 正唱 1.0（加辉光）+ 逐词浮动。
- 文字：`font-weight:900` + `-webkit-text-stroke:.055em`（应用只打包了 400 字重的 Zilux2 Sans SC，
  靠描边补足参照图的超粗字）；颜色为暖白 `#fff9f2`，不是纯白。
- 雾化：`FOG_NEAR=6` / `FOG_FAR=34`；非当前句整行加最多 2.4px 的 `filter: blur()`。
- 歌名条：`.zlr-title` 位于 `calc(var(--player-h,106px) - 14px)` 上方，磨砂白底 + `backdrop-filter: blur(18px)`。

## 性能坑（已修）

`lyrics.ts` 的 `onPlayer` 回调是高频的（进度更新），原来每次都 `syncLumiereSong()` → 新 `song` 对象 →
`roomStage.setSong()` 里引用比较失效 → 场景重排全部 77 行歌词的逐词布局 → 每次几百次
`ctx.measureText()`（自定义字体、CJK），实测单次约 300ms，整机帧率掉到 10–20fps 并周期性 315ms 长帧。

修法：
1. `room.ts` / `roomScene.ts` 的 `setSong` 用歌曲签名（trackKey/title/artist/duration/offset/行数/首尾时间）
   挡掉重复 setSong，不再重排布局；
2. `lyrics.ts` 在画布接管后跳过整棵 DOM 歌词的逐帧更新（`lumiereCoversLyrics`），只维护全局当前歌词文本；
3. 淡出结束后给 `.lyrics-view` 加 `is-covered`，CSS 用 `content-visibility: hidden` 把 `.lyrics-frame`
   整棵退出渲染；房间模式下 `.lyrics-bg`（带 blur(110px) 的封面图）`visibility: hidden`。

修后真机验收：FPS early 173.6 / late 196.5（本机 rAF 不锁 60Hz），无长帧；此前为 8.8–18.5 且有 315ms 长帧。

## 验收

```powershell
# 一键：构建 → 部署到 dist/Zilux2/web → 启动（CDP 9223）→ 跑 QA → 截图
powershell.exe -NoProfile -ExecutionPolicy Bypass -File research/qa/room-app-qa.ps1
# 可选参数：-NoBuild -NoDeploy -KeepApp -TypeCheck -Times '0,4,8,15,25'

# 只跑视觉预览（自动起 vite dev + headless Edge，跑完清理）
node research/qa/room-preview-shot.mjs --times 8.6,40.4,41,75 --out research/shots/room-preview --sheet
```

最新真机截图：`research/shots/app-room-{0-home,1-0s,2-4s,3-8s,4-15s,5-25s}.png`；
独立预览：`research/shots/room-preview-*.png`；参照图分析：`research/room-art-spec.md`、`research/shots/room-target.png`。

## 2026-10-21 追加：逐词「从无到有」/ 系统重字 / 无歌词提示

1. **逐词凭空浮现**：`roomScene.ts` 的 `renderWords` 里每个词带 `entMs / entDelayMs / entDx / entDy / entRot`，
   `entrance = clamp((timeMs - word.startMs - word.entDelayMs) / word.entMs, 0, 1)`；
   `entrance <= 0` 时该词完全不画（opacity 0），所以歌词不会提前摆在画面上，而是唱到哪个词才从随机方向
   淡入 + 从 1.22 倍收到原位。前/后句残影也遵循同一规则，不再有「整句幽灵字」。
2. **字体**：打包字体只有 400，大字下「假粗 + 描边」会糊。改用系统重字栈
   `'Noto Sans CJK SC','Noto Sans SC','Microsoft YaHei UI','Zilux2 Sans SC',system-ui,sans-serif` + `font-weight:900`，
   去掉 `-webkit-text-stroke`；`measureText` 也改成同一字体栈，避碰量宽才准。
3. **制作名单过滤 / 无歌词提示**：`looksLikeMetadata` 增加 `looksLikeCredit`（前 7 行内、冒号前是
   「作词/作曲/编曲/Composed by/Produced by…」这类制作项即过滤）。整首歌没有歌词（或全被过滤）时，
   `setSong` 会延迟 0.9s 在画面中间显示「暂无歌词 / 纯音乐，慢慢听」，环境照旧，底部歌名条仍在。

## 2026-10-21 追加：镜头前后推拉 / 地面长条地毯

1. **镜头不再只往前推**：`buildLayout` 用 `mulberry32(hashSeed(songKey + '::camera'))` 给每句生成一条
   镜头轨迹 `cameraPath`：默认往前一句 `-LINE_GAP(5.6)`，有 `PULL_CHANCE(0.34)` 的概率改成往后拉
   `+PULL_DISTANCE(9.4)`。新句的行坐标取 `z = cameraPath[index] - FOCUS_DEPTH`，
   于是拉远时新句在镜头的**身后**（depth = 7.6 - 9.4 = -1.8，不可见），
   镜头阻尼退到位后才把它拉到焦点深度 7.6 —— 视觉上就是「句子在后头，镜头往回拉把它带进画面」。
   前进/后退共用同一个阻尼（playing 时 k=3.4，暂停 8），seek 超过 1.5s 直接吸附。
2. **地面环带 → 长条地毯**：删掉 `drawRings` / 所有 `RING_*` 常量，换成 `drawRug`：
   一条透视梯形长条（`RUG_HALF_WIDTH 0.95`、近 1.3 → 远 30 世界单位），暖白近实远淡，
   毯面有世界坐标等距的横向织纹（`RUG_BAND_GAP 1.1`，每 4 条加宽加深一道）、两侧缝线，
   远端用薄荷色径向雾化掉，避免出现硬切口；镜头推/拉时织纹朝对应方向滚动，方向感直观。
3. **逐词布局的兜底修复**：原先 7~10 词的长句在 254px 高的安全区里按 126px 字号随机撒点必然叠字，
   最后退化成「一行排开」。现在先按 `rowsNeeded`（≤4 词 1 行、≤8 词 2 行、其余 3 行）把字号封顶，
   再走原来的随机撒点 + 6 轮缩字号，既保留随机散落的观感，又不会塌成一行。

## 2026-10-21 追加：换句时的镜头滚转（roll）

需求（按用户澄清后的意思）：镜头本身不做横移/偏航/俯仰那些机位变化，**只在切换到下一句歌词时**，
画面 roll 转到一个新的角度；方向随机、角度大小也随机。

做法（web/src/ui/roomScene.ts）：
- 相机保持正对 -Z（`camView.x=0`、`camView.y=CAM_HEIGHT`），只有 `camRoll` 一个姿态变量。
- `buildLayout` 里用 `mulberry32(hashSeed(songKey + '::roll'))` 给每句生成一个目标滚转角：
  `direction = ±1`（方向随机）、大小 `CAM_ROLL_MIN(6°) ~ CAM_ROLL_MAX(13°)` 随机；第 0 句为 0（保持水平）。
- 播放到某句时 `camRoll = damp(camRoll, rolls[index], CAM_ROLL_DAMP=3.6, dt)`，
  换句后约 0.5~0.7s 转到位，是一次看得出来的镜头转动；seek（|ΔpositionMs|>1500）直接吸附。
- 投影 `projectWorld(wx,wy,wz)` 只做「正对透视 + 画面 roll 旋转」：先算 `rx/ry`，再
  `x = 半宽 + rx*cosR - ry*sinR`、`y = 半高 + rx*sinR + ry*cosR`。地毯和逐词共用同一投影，
  所以 roll 时地毯、词、织纹会整体一起转，不会出现字转了、地面没转的穿帮。
- 词的 `angle` 里也叠加 `camRollEff`，所以逐词自身的随机倾斜之外还有整帧的滚转。
- 早期试过的「横向机位 + 偏航/俯仰 + 手持呼吸」已全部删除（用户要的是 roll，不是机位乱动）。

## 2026-10-22 追加：手持镜头晃动（shake）

需求：在「前后推拉 + 换句 roll」之上再加一点点镜头晃动，且晃动**不参与**歌词运动。

实现（`web/src/ui/roomScene.ts`）：

- 常量：`SHAKE_YAW=0.013`、`SHAKE_PITCH=0.0095`、`SHAKE_ROLL=0.0075`、`SHAKE_X=0.055`、`SHAKE_Y=0.038`（都在文件顶部）。
- `render()` 里用三个不同频率的正弦叠加（慢频为主 + 细频打散）算出 `shakeX/shakeY/shakeRoll/shakeYaw/shakePitch`，时间基准是 `performance.now()`，与歌词进度无关；暂停时幅度乘 0.62。
- 只写**渲染相机**：`camView.x=shakeX`、`camView.y=CAM_HEIGHT+shakeY`、`camView.z=camZ`、`camRollEff=camRoll+shakeRoll`，并缓存 `camCosYaw/SinYaw/CosPitch/SinPitch`。
- `projectWorld()` 在原有透视 + roll 之外，恢复了一层极小的 pitch→yaw 旋转（只有晃动量级），所以地毯与逐词会**一起**轻微晃，但 `camZ`（前推/后拉）和 `rolls[]`（换句滚转）的阻尼目标完全不动——晃动不参与歌词运动。
- 想调强弱只改这 5 个常量即可；设成 0 就完全静止。

## 2026-10-22 追加：移除底部歌名玻璃长条

用户要求删掉 `.zlr-title`（NOW PLAYING 磨砂胶囊）。已从 `web/src/ui/roomScene.ts` 删除：

- 样式段（`.zlr-title/.zlr-eq/.zlr-now/.zlr-song/.zlr-artist/.zlr-spacer/.zlr-time/.zlr-track` 及 eq 动画）；
- DOM 创建与挂载、`updateTitle()` 每帧更新及其调用、`formatTime()` 辅助函数；
- `setSong()` 里对歌名/歌手/空态 class 的三处引用。

现在房间页只剩：程序化薄荷绿背景 + 长条地毯 + 逐词歌词 + 「暂无歌词」提示；播放信息看应用自带播放条即可。

## 2026-10-22 追加：房间设置面板（完整可调 + 实时预览）

用户要求：房间档要像「纯字」一样有设置界面，可调歌词风格、背景颜色、文字离散度、颜色等，做到尽量大的自定义。

**入口**：快捷设置（播放条右下的齿轮）→「歌词」tab →「播放效果」选「房间」→「房间设置 → 打开调节…」。

**实现文件**

- `web/src/ui/roomSettings.ts`：`RoomStyleSettings`（47 个字段）+ `DEFAULT_ROOM_SETTINGS` + `ROOM_SETTINGS_KEY='zilux2.roomStyle'` + `normalizeRoomSettings()` / `roomStyleSettings()` / `saveRoomStyleSettings()` + `ROOM_STYLE_PRESETS`（薄荷/奶油/午夜/樱花）+ `applyRoomPreset()`。
- `web/src/ui/roomScene.ts`：全部硬编码几何/配色改成 `cfg` 驱动；`createRoomScene({ style })` 传初始样式；`RoomScene.setStyle(settings)` 局部更新并自动重排；顶部保留的常量只做默认兜底与物理常量（滚转阻尼、晃动幅度、FOV、字号上下限、雾化距离）。
- `web/src/ui/roomSettingsPanel.ts`：设置弹窗（7 组 / 51 个控件），左侧独立房间实时预览（自驱 1x 时钟、循环播放），拖动即预览；保存写 localStorage，取消/×/遮罩还原，恢复默认只改草稿；预设一键换配色。
- `web/src/ui/room.ts`：`applyRoomStyleSettings(settings?)` 广播给所有存活的房间舞台（预览即时生效、保存后歌词页同步）。
- `web/src/ui/app.ts`：快捷设置里新增「房间设置」cell，只在「房间」档显示；「文字设置」仍然只在「纯字」档显示。
- `web/src/styles/app.css`：`.ts-color`（颜色行）/`.ts-color-value`/`.ts-preview-stage .zl-room-scene` 三条补充样式，其余复用文字设置面板的 `.ts-*`。
- `web/src/dev/roomPreview.ts`：预览页支持 `?style=<预设名|URL 编码 JSON>`，方便截图脚本批量出观感图。

**可调项分组**：预设（4 个）｜文字（字体/字重/字号/字距/4 个颜色/辉光/三态不透明度）｜布局（横向离散、上下边界、纵深离散、随机旋转、前后句数）｜背景（上下颜色、渐变角度、中心柔光、暗角、光痕强度/条数、颗粒）｜地毯（显示、颜色、宽度、远近深度、织纹间距、不透明度）｜镜头（相机高度、焦点深度、句距、前蹭、后拉概率/距离、滚转上下限、晃动倍率）｜动效（逐词浮现、浮现时长、残影、音乐呼吸、渲染像素比）。

**默认值对齐**：`areaBottom=0.01`（对应原 -0.01 下边界）、`bgAngle=53°`（对应原左上亮→右下暗的渐变方向），保证不调任何参数时观感与改造前一致。

**已知**：颜色行取色器用的是浏览器原生 `<input type="color">`（WebView2 里是可用的系统取色器）；设置保存在 localStorage，换歌/重开继续生效。

## 2026-10-22 追加：统一「效果设置」入口 + 切换动画

**统一入口**：快捷设置 →「歌词」tab 里原来「文字设置」「房间设置」两个 cell 合并成一行**「效果设置」**（`web/src/ui/app.ts`）：

- 一行、一套按钮，按钮与提示文案跟着「播放效果」变：纯字 →「文字设置…」（纯字：字号观感/亮度/辉光/崩解/残影/光感/画质），房间 →「房间设置…」（房间：歌词字体/颜色/离散度/背景渐变/地毯/镜头/动效）；
- 关闭档没有可调项，整行收起（`is-hidden`），按钮回落成「打开调节…」占位；
- 布局：标题在左、胶囊按钮在右（`.quick-cell-head` + `.quick-text-settings-btn`），下方一行灰色提示（`.quick-cell-hint`）。

**动效行只在关闭档显示**：`动效`（逐字生长 关闭/柔和/弹跳/强烈）只作用于 DOM 歌词，画布效果（纯字/房间）下没有意义 → `syncGrowCell()` 在 `lyricsLumiereMode() !== 'off'` 时隐藏该行。

**切换动画**：抽了公共方法 `private animateQuickBodyHeight(from, to)`（`.quick-panel .quick-body` 本身有 `height .32s cubic-bezier(.22,1.28,.36,1)` 过渡），切 tab 与切「播放效果」共用：

- 展开方向：`is-hidden` 移除 → `is-reveal` 重放入场动画（`quick-cell-in`：淡入 + 上浮 6px）→ 高度补间；
- 收起方向：先加 `is-collapsing`（`.13s` 淡出 + 上浮 4px），130ms 后再 `is-hidden` 并把高度补间到新值（与展开对称）；
- 动效行出现/消失同样走高度补间，连续切档不会硬跳。

**已知取舍**：收起是两段式（先淡出后收高），总时长约 0.45s；要更快可把 `is-collapsing` 的 130ms 与 `animateQuickBodyHeight` 的 340ms 一起调小（`web/src/ui/app.ts` 内）。

## 2026-10-22 追加：房间歌词颜色跟随「歌词颜色」+ 制作名单过滤增强

### 歌词颜色接入（纯色 / 封面色 / 自动渐变）
- 数据流：`web/src/ui/lyrics.ts` 模块初始化时调用 `setRoomLyricTintProvider(() => ({ mode: lyricsBgMode, palette }))`；`web/src/ui/room.ts` 每帧把 provider 结果推给场景（`scene.setLyricTint`，内部按 `mode|palette` key 去重，不产生额外开销）。
- 纯色档固定暖白三态 `['#fff9f2', '#fffdfa', '#ffffff']`（和默认观感一致）；封面色用封面取色板按三态取色；自动渐变按词在句中的位置沿色板渐变。取到的颜色再按状态提亮（唱过 .62、正在唱 .8），正在唱的词用该色叠双层辉光。
- 房间设置面板删掉「未唱颜色 / 唱过颜色 / 正在唱颜色 / 辉光颜色」4 行（改为一段说明），`ROOM_STYLE_PRESETS` 也不再改歌词颜色，只换背景与地毯——避免和上方「歌词颜色」冲突。`RoomStyleSettings` 里这些颜色字段保留（兼容已存设置），但不再参与逐词渲染。

### 制作名单过滤增强（QRC 常见格式）
- 新增 `CREDIT_PREFIXES` + `looksLikeCreditPrefix()`：过滤「作曲Composer罗凯元」「编曲Arrangementsoulway/TINY7」「制作人ProducerTINY7」这类无冒号、标签与英文直接拼接的名单行（只看前 14 行，标签至少两字，避免误杀正文）。
- `buildLayout` 里加了「连续名单块」处理：名单行之后紧跟的短行（≤18 字、无句读）也一起跳过。

## 2026-10-22 追加：修掉进入歌词页时闪过「关闭档默认歌词页」

**现象**：播放效果选「纯字」或「房间」后再进歌词页，开头零点几秒会看到关闭档的默认歌词页（封面/歌名/进度条/无歌词提示）叠在画布上。

**根因**：`web/src/ui/lyrics.ts` 的 `watchStagePaint()` 一看到画布 `is-painted` 就撤掉 `is-lumiere-fresh`（遮住 DOM 歌词的临时类）；
但 CSS 里真正隐藏 `.lyrics-frame` 的规则要等 `:has(.is-on.is-ready.is-content.is-painted)`，`is-covered` 还要再等淡出计时。
两者之间有约 0.4~0.5s 空档，`.lyrics-frame` 的 opacity 被过渡动画从 0 拉回 1 再淡出，于是露出默认歌词页。

**修法**：
1. `watchStagePaint()` 只在 `is-covered`（或画布失败）后才撤 `is-lumiere-fresh`，并同时观察 `.lyrics-view` 的 class（`is-covered` 加在 view 上）；
2. `is-covered` 的延迟从 520ms 缩到 200ms（遮挡时间更短）；
3. `app.css` 给房间档的等待提示：`.lyrics-view.is-room.is-lumiere-fresh::after { content: '房间 · 准备中'; }`。

**验证**：CDP `Page.startScreencast` 抓开页全过程（189 帧）：从点击到画布接管只有应用界面/房间画面，`.lyrics-frame` 的 opacity 全程为 0，不再出现默认歌词页；探针 `window.__openProbe` 时间线 `frame` 最大值 0。

## 2026-10-22 追加：行间间奏不再「整屏无字」 + 逐帧异常保护

**现象**：用户反馈「房间的文字不见了」。CDP 取样：80 个 `.zlr-word` 全部 `opacity:0`，但 canvas/地毯正常、播放位置在走，`window.__roomFrameError` 无。

**根因**：歌词行之间常有几秒间奏。旧逻辑里镜头直接对准「当前行」（`indexAt` 返回的那句），而当前行的词要等该行**第一个词的 startMs** 才逐个入场（用户要求的「从无到有」）；这段时间里：
- 当前行所有词 `entrance=0` → opacity 0；
- 上一句在镜头背后（depth 为负）被 `wordDepth <= 1.2` 剔除；
- 下一句还没到 `entrance` 窗口。
→ 只要打开歌词页时正好落在间奏，就会整屏空字，直到下一句第一个词开口。

**修法**（`web/src/ui/roomScene.ts`）：
- 新增 `displayFocus`；每帧算 `focus = indexAt(timeMs)`，若 `timeMs < 第一句第一个词的 startMs - 60ms` 就往前退到上一条已唱过的句子（`while (focus > 0 && timeMs < firstWordStart(focus) - 60) focus -= 1`）。
- 镜头目标（`targetZ`/`targetRoll`）和 `renderWords` 的「当前句/前后句」判定都改用 `displayFocus`：间奏期间镜头停在上一条句子上，那句保持正常亮度；下一句的词等开口后从远处淡入，镜头再推过去。
- 实测（打开房间后连采 8×2s）：可见词数 2–6，不再出现 0；截图 `research/shots/app-room-gap-verify.png`。

**顺带加固**：
- `web/src/ui/room.ts` 的 `renderFrame` 用 `try/catch` 包住 `scene.update` + `setLyricTint`，异常只记一次（`console.error('[room] 帧更新失败', error)` + `window.__roomFrameError`），rAF 照常排下一帧——之前任何一帧抛错会让整个房间永远停在上一帧。
- 位置与 `lyricOffsetMs` 加 `Number.isFinite` 兜底，`camZ` 非有限值时按 snap 处理，`camView.z` 回退 0。
- 排查提示：若以后又出现「文字不动/不刷新」，先在控制台看 `window.__roomFrameError`。

## 2026-10-22 追加：窗口控制动画（最大化 / 最小化 / 关闭）

三个按钮原来直接改 `WindowState`，没有任何过渡。现在由宿主 `src/Zilux2/MainWindow.xaml.cs` 驱动：

- **实现方式**：`BeginWindowMotion(from, to, duration, ease, completed)` 用 `DispatcherTimer`（15ms 一帧）逐帧 `SetWindowPos` 修改窗口矩形。不能用 WPF `RenderTransform`/`Opacity`——WebView2 是子 HWND，不跟随 WPF 渲染变换，只有窗口矩形变化时才会跟着走。
- **最大化 / 还原**：200ms `EaseOutCubic`。最大化时先在 Normal 状态把矩形动画到工作区，动画结束后才切 `WindowState.Maximized`（先切状态会先闪一帧全屏）；还原时保存的 `_restoreRect` 作为目标，`OnStateChanged` 里记录用户手动调整后的 normal rect。
- **最小化**：180ms `EaseInCubic`，向下方任务栏滑动同时缩到约最小尺寸（`SetWindowPos` 会被 MinTrackSize 夹住，所以尺寸只缩到最小尺寸附近，主要靠位移表达动画）；结束前先把矩形恢复成原值再 `WindowState.Minimized`，否则从任务栏还原会变成动画后的小窗口。
- **关闭**：140ms 缩小到 0.86 后 `Close()`。
- `ClampWindowToWorkArea` 在动画期间跳过（`_suppressClamp`），避免和窗口矩形动画互相抢位置。
- 动画期间再次点击按钮会 `StopWindowMotion()`（generation 计数）重新开始，不会叠加。

## 2026-10-22 追加：窗口控制动画（快照过渡版，替代几何动画）

用户反馈「全屏/缩小/关闭都没有动画」，随后又指出「缩小的动画和关闭的动画有 bug」。最终方案：

- **最大化 / 还原**：保留几何动画（`BeginWindowMotion` 逐帧 `SetWindowPos`，200ms；还原时先记 `_restoreRect`，动画结束再切 `WindowState`）。这类「窗口真的变大」有实际意义。
- **最小化 / 关闭**：改成**整窗快照过渡**（`PlaySnapshotTransition`）——
  1. `Graphics.CopyFromScreen` 抓窗口当前像素 → PNG 内存流 → `BitmapImage`；
  2. 显示一个无边框、透明、置顶的 WPF `Window`（`_snapWindow`，`ShowInTaskbar=false`），里面 `Image` 填满快照；
  3. 用 `ScaleTransform`（最小化 1→0.38、关闭 1→0.92）+ `TranslateTransform.Y`（最小化下移 55% 高度）+ `Window.Opacity`（最小化 1→0.25、关闭 1→0）做 180~220ms 的 `CubicEase` 动画；
  4. 快照出现的同一帧把真实窗口最小化（`WindowState.Minimized`）或 `ShowWindow(hwnd, 0)` 隐藏；动画 `Completed` 后隐藏快照层，关闭则真正 `Close()`。
- 为什么不用窗口矩形动画：`SetWindowPos` 逐帧改窗口尺寸会被 `MinTrackSize`(1100×700) 夹住、WebView2 每帧重排导致内容跳变、动画结束恢复原矩形再最小化会闪一帧。快照过渡只动 WPF 一个 bitmap，内容完全不重排。
- 为什么抓帧验证很容易失败：动画只有 ~200ms，而全桌面 `CopyFromScreen` + PNG 保存一帧要 100~150ms，抓不到中间帧；要抓只能**固定抓窗口区域**（`research/tmp/anim-capture5.ps1`）或用 25~30ms 间隔的桌面抓帧。
- 抓帧证据：`research/tmp/snap3-shot-minimize-08.png`（快照缩小淡出中）、`research/tmp/snapc-shot-close-08.png`（关闭时快照缩小淡出），host.log 有 `window.snapshot shown 1600x960 at ...`。
- 还原验证：最小化后用 `ShowWindow(SW_RESTORE)` 恢复，窗口仍为 1600×960，页面布局与播放条正常。

### 窗口动画可选「应用内 / 系统原生」

设置 → 外观 → 窗口动画（`appearance.windowAnimation`，默认 `custom`）：

- `custom`（应用内）：最大化/还原走几何补间，最小化/关闭走整窗快照缩放淡出——不依赖系统设置，WebView2 内容不会被逐帧重排。
- `native`（系统原生）：最小化/最大化直接 `WindowState = ...` 交给 Windows DWM 过渡；**关闭没有系统动画**，点关闭窗口会直接消失。
- 宿主导航：`SettingsModel.AppearanceSettings.WindowAnimation`（`custom` | `native`，追加在字段末尾保证旧 settings.json 顺序）→ `SettingsService.WindowAnimation` → `MainWindow.NativeWindowAnim` 每次动作时读取，切换立即生效。
- 实测（Windows 11，DWM 组合开启、MinAnimate=1）：原生模式点最小化日志只有 `window.native minimize`，抓屏帧里窗口「出现→消失」之间没有中间帧；因此默认仍用应用内过渡，需要原生手感可在设置里切换。

## 2026-10-22 追加：房间歌词「重点词」

纯字档的「关键字染色」已复用到房间档：

- 共用模块 `web/src/ui/keywords.ts`（纯字档也改成用它）：
  - `extractLyricKeywords(lines, palette)`：从整首歌词里按出现次数挑 2–3 个 2–4 字短语（英文按整词），
    去掉常见虚词/语气词与制作名单行，颜色取「纯字 → 文字设置 → 关键字染色」里的词色板
    （无配置时回落 `#e6b877` 香槟 / `#8fd3c0` 薄荷 / `#e59a9a` 玫瑰）。
  - `keywordForWord(token, keywords)`：中文按片段包含、英文按整词匹配。
- 房间场景 `web/src/ui/roomScene.ts`：`WordLayout.keyword`；`refreshKeywords()` 在 `setSong` /
  `setLyricTint` / `setStyle` 时重算，跟随「快捷设置 → 歌词颜色」的色板（纯色档用默认香槟色板）。
  渲染时重点词的基准色换成 keyword 色，再按未唱/唱过/正在唱做同样的提亮，字号乘 `keywordScale`。
- 房间设置面板「文字」组新增两个控件：`重点词染色`（开/关）、`重点词字号`（1×–1.35×，默认 1.12×），
  存进 `zilux2.roomStyle` 的 `keywordColors` / `keywordScale`。

截图：`research/shots/app-room-keywords-preview6.png`（预览里「房间」薄荷色、其它词暖白）。

## 2026-10-22 追加：歌曲开头「歌词空窗」修复

现象：房间效果在部分歌曲开头十几秒~几十秒没有词，之后才出现（各平台都有）。

原因：`web/src/ui/roomScene.ts` 的 `buildLayout` 里有「制作名单块」过滤：遇到制作名单后，
会继续跳过「短且无标点」的行。中文歌词本身大多没有标点，开场短句（如「那是一座座山连着
山的小村庄」）因此被误当成名单吞掉，房间要等到第一句**超过 18 字**的歌词才开始显示。

修复：
- 过滤名单行从三条规则收敛为「角色关键词 + 冒号」（`looksLikeCreditLabeled`，覆盖
  「词Lyricist：」「视觉设计VisualDesign：」「母带后期混音师…」这类 QRC 格式）；
- 名单后续短行的跳过条件加「歌词虚词检测」（的/了/是/在/我/你/他…），且长度上限 12 字、
  最多扫描前 20 行；真正歌词不再被吞。

验证：QQ《茶花开了》房间效果现在从 0:35 起显示「夜夜开到凌晨两点」，开头名单行不再出现；
真实前奏（无人声）仍按设计保持空画布，直到第一句歌词开口。

## 2026-10-22 追加：前奏显示歌名卡

背景：房间档「逐词从无到有」意味着没人声的前奏是空画布，用户要求前奏改成显示歌曲名称。

实现：
- `web/src/ui/roomScene.ts`：根节点新增 `.zlr-titlecard`（`NOW PLAYING` 小标 + `.zlr-titlecard-name` 歌名 +
  `.zlr-titlecard-artist` 歌手）。`render()` 里 `timeMs < 第一句第一个词 startMs - 200` 时加 `.is-on`
  （淡入 + 上移入场），歌词开口即淡出；拖回前奏会重新出现。字号 = 画面高 × 0.062 × `introTitleScale`，
  颜色/字体跟随房间文字设置。
- `web/src/ui/roomSettings.ts`：新增 `introTitle`（默认 true）、`introTitleScale`（默认 1）。
- `web/src/ui/roomSettingsPanel.ts`：文字组新增「前奏显示歌名」开关 + 「歌名字号」滑杆；预览示例歌加了
  3.2s 前奏并改成「薄荷房间 / Zilux2 Preview」，面板里能直接看到效果。

行为：纯前奏显示歌名 → 第一句歌词开口后歌名淡出、逐词浮现；无歌词歌曲仍走「暂无歌词」提示。


## 2.6.20 · 房间背景与地毯跟随「歌词颜色」

- 需求：快捷设置「歌词颜色」（纯色/封面色/自动渐变）不仅要给词上色，也要驱动房间背景渐变和地面长条地毯。
- 实现（纯前端）：
  - `web/src/ui/roomSettings.ts` 新增 `bgFollowLyrics`、`rugFollowLyrics`（默认都开），设置面板「背景」「地毯」组各多一个开关，可随时回退到自定义颜色。
  - `web/src/ui/roomScene.ts` 新增派生色：从歌词色板取 `light=palette[0]`、`deep=palette[min(len-1,2)]`，背景上端 `mix(light, #ffffff, .34)`、下端 `mix(deep, #0f3a31, .46)`，地毯 `mix(mix(light, #ffffff, .55), #faf6f0, .34)`；背景渐变、CSS `--zlr-bg`、地毯主体/织纹/缝线/远端雾化统一走这套派生色。
  - 切歌或换「歌词颜色」档位时 `setLyricTint()` 会重算派生色并让背景渐变缓存失效，实时预览同步。
- 验证（CDP 采样画布像素）：纯色档 bg=(204,210,206)/rug=(232,233,229)，封面色档 bg=(153,149,127)/rug=(215,207,188) —— 背景与地毯都会跟随变化；自动渐变与封面色共用同一色板（差异只体现在逐词渐变）。
- 安装包：`dist/Zilux2-Setup-2.6.20.exe`（13,034,177 B，SHA256 `89086646a8f1bdfbed7d605f6f52dd2fdfc2a0c7360ab0e4f75279069918b9eb`），已静默安装到 `%LOCALAPPDATA%\Programs\Zilux2` 并重开（web index 引用 `assets/main-BYM2-7lQ.js`）。

## 2.6.21 · 光痕改为「流星」：径向朝镜头飞来 / 往远处飞走

- 需求：原来那些斜向光痕改成流星一样划过的线条，屏幕上要读成前后飞行的纵深（不是斜着横穿画面），对应自定义项也要可调。
- 实现（`web/src/ui/roomScene.ts`）：删除 `drawStreaks`，新增 `drawMeteors`：
  - 以镜头前方 120 单位的投影点为灭点，每条流星沿一条屏幕径向线运动：72% 从灭点朝镜头飞来（半径由小变大、近处更粗更亮），其余往远处飞走（反向收向灭点），配合透视成长感读作前后飞行。
  - 拖尾 = 头部亮芯 + 外层柔光 + 头部小光斑；透明度、粗细随半径（近处）增强，尾部渐变到透明。
- 自定义（`web/src/ui/roomSettings.ts` + `roomSettingsPanel.ts`）：保留 `streakCount`/`streakStrength` 但改名为「流星数量」「流星亮度」，新增 `streakSpeed`（飞行速度 0.2–3x）与 `streakLength`（拖尾长度 2%–90%）。
- 验证：把参数调到 12 条 / 速度 1.6x / 拖尾 55% 抓帧（`research/shots/app-meteors-1.png` 等），可见从灭点放射的流星线条与头部光点；随后恢复用户原始房间设置。
- 安装包：见本轮交付信息。

## 2.6.21–2.6.22 · 流星光线 + 粒子真 3D

- 光痕 → 流星（2.6.21）：删除静态斜线 `drawStreaks`，改为 `drawMeteors`——从 `projectWorld` 求出的灭点出发，沿屏幕径向朝镜头飞（72% 迎面、其余反向收向灭点），头部亮芯 + 外柔光 + 光斑，越近越粗越亮；设置项改名「流星数量/流星亮度」，新增「飞行速度」「拖尾长度」（`streakSpeed` 0.2–3、`streakLength` 0.02–0.9）。
- 粒子真 3D（2.6.22）：`Particle` 由屏幕归一化坐标改为世界坐标 `{x,y,depth,speed,size,alpha,drift}`；`drawParticles` 每帧按相机位置循环深度 `d = ((camZ+depth+time*speed - near) % range + range) % range + near`，用 `projectWorld` 投影（含 roll/pitch/yaw），半径 `size*focal/d`（focal 修正为 `tan(FOV_Y/2)`）、近远淡出 + 径向渐变柔光；粒子随镜头推进掠过身边、远近大小不同、并与地毯/歌词共用同一透视。
- 验证：CDP 采样 `window.__roomParticles()` 26 颗、深度 1.8–27.8、半径分布 0.35–4.2 逐帧变化（1.3s 内 26/26 屏坐标移动）；截图 `research/shots/app-particles3d-room.png`。安装包 `dist/Zilux2-Setup-2.6.22.exe`（13,034,689 B，SHA256 `540e3be295421391507384ee4ef4592b67d3d7e0c5ccbfbffd8915b5390b04a7`）。

## 2.6.23 · 粒子 3D 观感补强（focal 单位修正 + 尺寸/亮度加大）

- 用户反馈「改一半的时候跟随 3D 了，现在又恢复原样」：中间版本因 focal 单位错误（FOV_Y 已是弧度，却又乘 π/360），所有粒子半径被 clamp 到 4.2，看起来「大而明显」；修成正确透视后粒子变得小而淡，观感像退回旧版。
- 最终参数：36 颗粒子；世界尺寸 0.014–0.064（米）；半径 `clamp(size*focal/depth, 0.4, 7)`；alpha 0.10–0.30；速度 0.5–2.0 m/s；横向 ±2.4、高度 ±0.95；深度 0–30 循环。
- 验证：`window.__roomParticles()` 返回 36 颗，半径分布 1.02–7、深度 1.32–29.33，屏坐标逐帧移动（透视/视差成立）；截图 `research/shots/app-particles3d-room.png`。
- 安装包：`dist/Zilux2-Setup-2.6.23.exe`（13,034,689 B，SHA256 `984a12e2f97ea18d0c27ed68f124327acd28a8a6240b0868772926e807e25327`），已静默安装到 `%LOCALAPPDATA%\Programs\Zilux2` 并重开。

## 2.6.24 · 流星真 3D + 粒子自定义

- 流星（光痕）：`web/src/ui/roomScene.ts` 的 `drawMeteors` 从屏幕空间改为**世界空间**——每条流星有固定世界基准点、微漂移、周期 2.1–5.9s、72% 朝镜头/28% 远去；头部深度在 1.4–30 间循环，尾部深度 = 头 ± 拖尾（2–15），头尾两个端点都用 `projectWorld` 投影后再连线 → 镜头前进/推拉/偏航/滚转/晃动时整条轨迹跟着透视变化。
- 粒子自定义：`web/src/ui/roomSettings.ts` 新增 `particleCount`（0–90，默认 36）、`particleSize`（0.3–3）、`particleBrightness`（0.15–2.5）、`particleSpeed`（0.2–3）、`particleDrift`（0.2–3）；`roomScene.ts` 的 `particles` 改为 let 并支持按数量重建（`rebuildParticles()`），半径/透明度/速度/漂移按设置缩放；房间设置面板新增「粒子」分组 5 个滑杆。
- 验证：CDP 采样 `window.__roomParticles()` 返回 36 个世界→屏幕投影后的粒子（radius 0.6–9、depth 1.6–30.5，随镜头推进变化）；房间舞台 `is-room is-on is-ready is-painted is-content`、无帧异常；截图 `research/shots/app-room-3d-clean.png`。
- 安装包：`dist/Zilux2-Setup-2.6.24.exe`，已静默安装到 `%LOCALAPPDATA%\Programs\Zilux2`。
