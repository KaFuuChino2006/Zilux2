# 声压 · 歌词文字 PV

入口：快捷设置 → 歌词 → 播放效果 → 声压。模式存储值为 `pressure`，与软件歌词页、桌面背景歌词共用。

「声压」不是滚动歌词，而是把每一句拆成一次舞台演出：版式、镜头、转场、图形和文字共用同一条时间线。

## 视觉语言

- 黑、暖白、电光橙三色为主；`cold` 段落换成冷灰蓝，`accent` 段落整屏橙。
- 一句歌词可以拆成多个词组，也可以只保留一个巨字；版式在 18 种构图之间切换。
- 每次重音推动一次镜头冲击（punch / shake / whip），安静段落只保留缓慢呼吸。
- 转场不是叠化：上一幕的切线、色条、字洞或运动方向成为下一幕的入口。
- 舞台图形只做遮挡、切割、透视和节奏，不堆装饰。

## 模块

| 文件 | 职责 |
| --- | --- |
| `web/src/ui/pressure.ts` | 与播放器时钟、音频能量、Lumiere 模式的生命周期集成 |
| `web/src/ui/pressureProgram.ts` | 歌词分句、18 种构图、5 种主题、12 种转场、6 种段落弧线 |
| `web/src/ui/pressureCompositions.ts` | 18 种海报版式，负责文字的实际排布 |
| `web/src/ui/pressureType.ts` | Canvas 字体引擎：逐字变换、竖排、字阵、伪 3D 平面、半调/描边 |
| `web/src/ui/pressureChoreography.ts` | 18 种入场、cue、重音、节拍、锚点、逐字运动 |
| `web/src/ui/pressureCamera.ts` | 镜头：dolly、truck、orbit、handheld、whip、fit 安全框 |
| `web/src/ui/pressureArt.ts` | 19 种舞台图形、主题色、间奏图形 |
| `web/src/ui/pressureScene.ts` | 三层画布、绘制循环、12 种转场、元数据、尺寸与降级 |

## 构图

`monolith`、`split`、`banner`、`tunnel`、`echo`、`stack`、`orbit`、`grid`、`column`、`cut`、`typewall`、`frame`、`sweep`、`stamp`、`perspective`、`collage`、`ripple`、`void`。

## 转场

`whip`、`punch`、`slit`、`shutter`、`fold`、`iris`、`glitch`、`panels`、`carry`、`wipe`、`flood`、`cut`。

## 演出结构

`compilePressure()` 会按歌词时间、标点和语义把歌拆成段落：

1. `intro`：建立主题和留白。
2. `verse`：克制、短促、以排版为主。
3. `build`：字距收紧、镜头开始推进。
4. `drop`：大字、整屏色块、重音冲击。
5. `break`：突然收住，只留一个词。
6. `outro`：镜头拉远，留下完整海报。

## 编排细节

- `PressureProgram` 用 `Intl.Segmenter` 把歌词切成字/词，按关键词选择构图：`打破`→split/cut、`心跳`→typewall/ripple、`向前`→tunnel/perspective、`光`→banner。
- 每个 shot 有 `sectionName`、`theme`、`motif`、`energy`、`accent`、`transitionIn`、`seed`、`focus`、`kicker`、`lineIndex`；同段歌词共享主题，镜头之间由转场接力。
- `pressureCue()` 以 92 BPM 推进节拍，输出 `impact/pulse/accent/cut/energy`，镜头、文字、图形共用同一组值。
- 长句会拆成多个词组，密集短句会合并；普通 LRC 在行内估算进度，逐字歌词使用原始时间。
- 暂停冻结画面；拖动进度后按目标时间恢复镜头；减少动态效果时关闭运镜/转场，保留排版与演唱进度。

## 性能

- 三层 Canvas 2D，主画布 + 两张转场画布；设备像素比上限 1.5。
- 字体 layout 按字号/字重/文本缓存，不在每帧重建。
- 转场只在切换窗口内绘制第二层。
- 关闭或切换效果时释放场景、播放订阅和 RAF；绘制失败回退默认歌词。

## 验证

```powershell
npx tsc --noEmit
npm run build
node --test web/tests/*.test.cjs
```

压力相关测试覆盖：镜头有限性/安全框、cue 边界与 seek 复现、18 种入场确定性、分句与构图多样性、播放时钟暂停/恢复、模式切换清理。当前 60 项 web tests 全部通过，Release 构建 0 warning/0 error。

开发预览：运行 web 开发服务器，打开 `/pressure-preview.html`；该预览不进入发布包。

本机发布需要同步到实际运行进程的安装目录（本机为 `C:\Users\13329\AppData\Local\Programs\Zilux2\web`），不能只更新仓库中的 `dist\Zilux2\web`。前端资源先复制，`index.html` 最后替换；保留旧哈希资源供正在运行的页面使用。退出托盘进程并重新打开软件后生效。
