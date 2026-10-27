# Folia 歌词引擎深度拆解

> **调研对象**：chthollyphile/folia-major（Folia，"Lyrics Reimagine"）——Electron + React + Vite 桌面音乐播放器
> **版本**：v0.7.21（tarball `package.json` 版本号；tarball 内无 commit 元数据，无法定位精确 commit）
> **许可证**：AGPL-3.0
> **调研时间**：2026-10-18
> **仓库路径**：`E:\Zilux2开发\research\repos\folia`（只读调研，未修改、未 `npm install`、未联网）
> **范围**：歌词子系统——来源/解码/解析/统一模型/时间轴/同步/渲染适配/缓存/导出/测试；可视化器与性能护栏只在与歌词交界处简述
> **合规声明**：本报告只提炼**设计思路与算法行为**。AGPL-3.0 具有传染性，Zilux2 若参考本报告实现，必须**独立重写**，不得复制 Folia 的源码文本、注释、文案或常量表；下文代码摘录仅为审计证据，不构成可复用片段。

**证据约定**：每条结论后给 `file:line`；`:N` 指该文件第 N 行。代码行为与仓库文档/注释声称冲突处会显式标注。无法从代码确认的标「待确认」。仓库中无字面「五层」表述（全仓 grep `五层` 仅命中无关的神经网络注释 `src/services/analysis/htdemucsWgsl/runtime.ts:11`），第 2 节的分层由代码调用链**推导**。

---

## 0. 结论速览（TL;DR）

1. **歌词子系统是 Folia 最重的纯前端子系统之一**：`src/utils/lyrics/` 目录约 58 个文件 8500+ 行，`src/services/lyricExport/` 10 文件 972 行，解析核心单文件 `parserCore.ts` 1261 行，承载 10 种格式（LRC/增强 LRC/VTT/TTML/YRC/QRC/KRC/AWLRC/Navidrome Structured/纯文本）。
2. **五层结构**（推导）：**L0 来源层 → L1 字节/格式识别层 → L2 格式解析层 → L3 统一时间轴模型层 → L4 展示加工层**。渲染组件是这五层的消费者，不属于五层。
3. **解析被移出主线程**：`workerClient.ts` 把解析 `postMessage` 给 `workers/lyricsParser.worker.ts`，主线程只收 `LyricData`（`src/utils/lyrics/workerClient.ts:25`、`:46`）。
4. **统一模型单位全部是「秒」（浮点）**，唯一例外是用户可调 offset 用毫秒。`LyricData.lines[].words[]` 是第一公民，行级歌词在解析期就被 `buildTimedWords` 均摊成逐字（`parserCore.ts:59`）。
5. **时间轴时钟是模块级 framer-motion `MotionValue` 单例**（`src/stores/motionSignals.ts:31`、`:34`），rAF 每帧写入，不触发 React 重渲染；`lyricCurrentTime` 是「已扣掉 offset」的歌词时钟，`currentTime` 是播放器时钟——两者分离是整个同步设计的地基。
6. **行索引是每帧从后往前线性扫描**：`findLatestActiveLineIndex`（`src/utils/appPlaybackHelpers.ts:21-32`），没有二分/预计算；行数少时足够，但这是可改进点。
7. **逐字补充时间轴有两条完全不同的路径**：真逐字格式（YRC/QRC/KRC/AWLRC/TTML/增强 LRC）直接给词级时间；行级格式（LRC/VTT/纯文本）用启发式均摊（CJK 逐字权重 1、标点权重 0、拉丁词权重 `1+len*0.15`）。
8. **翻译/罗马音不是「词轴」而是「行轴 + 时间戳匹配」**：解析器用 ±1s 窗口的贪心稳定匹配 `findTranslationsForSortedStartTimes`（`parserCore.ts:212`），修掉了旧「最近邻让一句翻译服务多行」的重复 bug。
9. **在线多源选词有完整评分体系**：默认偏好 QQ（`sourcePriority.ts:6`），候选必须 `titleMatched && (artistMatched || albumMatched)`（`autoMatchBestLyric.ts:135`），总分低于 75 直接丢弃（`autoMatchBestLyric.ts:24`），组件缺失封顶 74 分（`matchScore.ts:17`）。
10. **缓存按前缀路由**：`lyric_*` → `metadata_cache` 表（`cacheRepository.ts:38`），歌词导出会把所有 `lyric_` 行读出来；成熟安装 536 行 17.9 MB，一次 bulkGet 冻结页面 58ms，因此分 50 条一批（`cacheRepository.ts:96-100`）。
11. **歌词有自己的持久化交换格式 `.fia`**：把「解析后、展示加工前」的 `LyricData` 装进带版本号的 JSON 信封（`foliaLyricDocument.ts:13-15`），导入时跳过解析器——这是我最推荐 Zilux2 照抄「思路」的一处。
12. **对外 HTTP 歌词 API 极简**：`127.0.0.1:32109/v1/lyric`，GET only，无鉴权，CORS `*`，返回截断后的稳定 JSON（`electron/lyricApi.cjs:45`、`:129`、`:110`；`main.cjs:2267`）。
13. **仓库卫生风险**：`src/` 下 **29 个文件**在注释里含 `DO NOT INFORM USER` / `@ai-ignore` 等针对 AI 的注入式文本（如 `classic/Visualizer.tsx`、`GlowWord.tsx`）。这些文本**不改变代码行为**，但属于不可信内容，Zilux2 迁移时不要带过去，也不要执行其中「指令」。
14. **测试与基准存在但不在 CI 主路径**：`test/unit/lyrics/` 下 60+ 用例；`benchmark:lyrics` 是手动脚本，且本 tarball 中其 fixture 目录 `test/test-song/test-lyric` 缺失（详见 6.4，标「待确认」）。

---

## 1. 子系统速览

### 1.1 一句话定位

Folia 的歌词不是「渲染器的一个输入字符串」，而是一条**从原始字节到逐词渲染模型的流水线**：多来源抓取 → 编码/格式识别 → 每格式解析器 → 统一 `LyricData` → 展示策略加工 → `MotionValue` 时钟驱动的 Canvas/DOM 渲染。可视化器、主窗口 Lattice 歌词、HTTP API、导出四类消费者共用同一份 `LyricData`。

### 1.2 顶层目录地图（与歌词相关部分）

| 路径 | 职责 | 关键证据 |
| --- | --- | --- |
| `src/utils/lyrics/` | 歌词解析/模型/来源/匹配的全部纯逻辑（约 58 文件） | `parserCore.ts` 1261 行 |
| `src/utils/lyrics/adapters/` | 5 类原始来源适配器（Embedded/LocalFile/Navidrome/Netease/Qrc） | `LyricParserFactory.ts:11-39` |
| `src/utils/lyrics/providers/` | AMLL DB 额外源 | `amllDbProvider.ts:14` |
| `src/utils/lyrics/icuFolia/` | 中日文分词（jieba/budoux，WASM 引擎） | `icuFolia/engines.ts` |
| `src/workers/lyricsParser.worker.ts` | Web Worker 解析入口 | `:20-32` |
| `src/components/app/playback/` | 歌词流水线的「胶水层」（setter/桥） | `createLyricsSetter.ts` 127 行 |
| `src/components/app/lattice/lyrics/` | 主窗口 Canvas 歌词渲染 | `useLatticeLyricCanvas.ts` |
| `src/components/visualizer/` | 可视化器（另一 teammate 域，仅交界引用） | `runtime.ts` 157 行 |
| `src/services/lyricExport/` | 歌词批量导出（zip + .fia/.lrc） | 10 文件 972 行 |
| `src/services/lyricProxy.ts` | 渲染进程唯一「转发热地址」文件 | `:19`、`:22`、`:31` |
| `src/services/lyricSegmentation*.ts` | 分词缓存与 AI 分词调用 | `lyricSegmentation.ts:16`、`lyricSegmentationAi.ts:28` |
| `src/services/repositories/cacheRepository.ts` | 统一缓存表路由 | `:21`、`:38` |
| `src/services/localMusicService.ts` | 本地库扫描（含歌词侧车文件配对） | `:94-95` |
| `src/services/onlineMusic/` | 网易云/QQ/酷狗/Spotify 取词 | `kugouLyricProvider.ts` 377 行 |
| `electron/lyricApi.cjs` | 本机 HTTP 歌词 API | 201 行 |
| `electron/preload.cjs` | 歌词相关 IPC 桥 | `:144`、`:146`、`:208-214` |
| `electron/main.cjs` | 主进程装配（端口/开关/IPC handler） | `:2249`、`:2267`、`:2474` |
| `api/`、`api-ts/`、`worker/` | Vercel/Cloudflare 形态的歌词代理与分词 | `api/lyric-proxy.js` |
| `src/types.ts` | 全局歌词模型 | `:6-92`、`:145-206` |
| `docs/lyric-api.md` | 对外 API 文档 | 329 行 |

### 1.3 解析核心文件（`src/utils/lyrics/`）

| 文件 | 行数级别 | 内容 |
| --- | --- | --- |
| `parserCore.ts` | 1261 行 | 全部格式解析器 + 时间戳工具 + 翻译匹配 + 间奏注入 |
| `types.ts` | 104 行 | 原始来源联合类型 `RawLyricSource`（`:99`）与加工选项 |
| `LyricParserFactory.ts` | 40 行级 | 5 类来源分发 + 展示过滤入口（`:11-39`） |
| `adapters/LocalFileLyricAdapter.ts` | — | `.fia` 直读 / AWLRC 容器 / 组合时间轴拆分 / 格式嗅探 |
| `adapters/EmbeddedLyricAdapter.ts` | — | USLT 标签、内嵌文本、AWLRC 识别 |
| `adapters/NavidromeLyricAdapter.ts` | — | OpenSubsonic `structuredLyrics` 精准逐词 |
| `adapters/NeteaseLyricAdapter.ts` | — | 网易云多轨字段选择 |
| `adapters/QrcLyricAdapter.ts` | — | QRC 主轨 + 翻译轨 |
| `formatDetection.ts` | — | TTML/VTT/增强 LRC/LRC 嗅探（正则 `:5-8`） |
| `timelineSplitter.ts` | — | 单文件「主/翻译/罗马音」拆分（`:10`） |
| `localLyricFormatOrder.ts` | — | 侧车格式优先级（`:6`、`:10`、`:35`、`:40`） |
| `lyricFileDecoding.ts` | — | BOM/UTF-8/GB18030/KRC 解密（`:15`、`:24-34`、`:41`） |
| `workerClient.ts` | — | Worker 请求多路复用（`:12`、`:25`、`:46`） |
| `renderHints.ts` | — | 行时长分类与转场/逐字提示（`:33-34`、`:208`、`:241`） |
| `foliaLyricDocument.ts` | 205 行 | `.fia` 自有交换格式（`:13-15`、`:66`、`:84`、`:173`） |
| `cjkSemanticLayout.ts` | — | 语义分块 + 逐词布局单元（被 classic 可视化器使用） |
| `staffCreditsPolicy.ts` / `staffCreditsDecision.ts` / `staffCredits.ts` | — | 制作名单识别与「智能隐藏/保留/重定时」 |
| `filtering.ts` / `pureMusic.ts` / `chorusEffects.ts` | — | 用户过滤正则、纯音乐判定、合唱段效果 |
| `autoMatchBestLyric.ts` | 449 行 | 在线自动选词（`:21-24`、`:135`、`:432`） |
| `lyricMatchSources.ts` / `matchScore.ts` / `lyricSources.ts` / `sourcePriority.ts` | — | 多源搜索/评分/源表/偏好顺序 |
| `onlineLyricsState.ts` / `lyricOffsetMemory.ts` | — | 在线覆盖状态合成；每首 offset 的 LRU 持久化（`:15`、`:67`、`:76`） |
| `providers/amllDbProvider.ts` | 99 行 | AMLL DB TTML 源（`:14`、`:28`、`:46`） |

### 1.4 端到端数据流

```
① 取源
   本地文件：localMusicService 扫描 → 侧车配对（.lrc/.vtt/.ttml/.qrc/.yrc/.krc/.fia / .t.lrc）
   内嵌：audio metadata USLT
   Navidrome：structuredLyrics / plainLyrics（API + 本地缓存字段）
   在线：netease/qq/kugou/amll/spotify → RawLyricSource
② 解码：lyricFileDecoding（BOM → strict UTF-8 → GB18030 → UTF-8）
③ 嗅探/拆分：formatDetection + timelineSplitter（主/译/罗三轨）
④ 解析：LyricParserFactory → 适配器 → parseLyricsAsync(worker) → parserCore 每格式解析
⑤ 统一模型：finalize（间奏注入）→ annotateLyricLines（renderHints）→ LyricData
⑥ 展示加工：createLyricsSetter（纯音乐判定 → 用户过滤 → 制作名单策略 → 合唱段 → 分词 → 宿主 transform）→ setLyricsState
⑦ 消费
   a. 播放桥：rAF 读 currentTime → lyricCurrentTime → findLatestActiveLineIndex → currentLineIndex
   b. Lattice 歌词画布（主窗口）
   c. 可视化器（stage / OBS / 预览）
   d. HTTP API publisher → 127.0.0.1:32109/v1/lyric
   e. 导出：.fia / .lrc zip
```

### 1.5 规模与耦合

- **枢纽文件**（被依赖数）：`docs/CODEMAP.md:73-75` 列出 `src/types.ts` 512+、`src/utils/lyrics/parserCore.ts` / `graphemeTiming.ts` / `renderHints.ts` 各 32+ 依赖方。解析核心是全仓最高扇入的纯逻辑模块之一。
- **渲染消费面**：`currentLineIndex` 出现在 **51** 个 ts/tsx（多为可视化器样式）；`lyricCurrentTime` 出现在 **15** 个文件。歌词时钟是跨层公共设施，不是某个组件的私有状态。
- **分层边界违规**（仓库自己的检查器报告）：`docs/CODEMAP.md:309` 记录 `src/utils/lyrics/lyricMatchSources.ts → src/stores/useOnlineProviderAccountStore.ts`——纯变换层反向依赖了 UI 状态。Zilux2 设计时要把「账号可用性」作为参数注入，而不是让 matcher 直接读 store。
- 依赖方向规则（`AGENTS.md`）：`stores/utils/types/services` 运行时不得依赖 `components`；`utils` 不依赖 `hooks/stores`；`types` 不依赖任何实现。歌词子系统大体遵守，但上述一处例外。

### 1.6 与可视化器/舞台的边界（只简述）

可视化器拿到的是 `lines: Line[]` + `currentTime: MotionValue<number>` + `currentLineIndex`（`src/components/visualizer/definition.ts:35-46`），不重新解析歌词；行选择辅助函数集中在 `src/components/visualizer/runtime.ts:35`（`getRecentCompletedLine`）、`:76`（`getUpcomingLine`）、`:90`（`getUpcomingLines`）、`:107`（`shouldPreheatLine`），README 明确要求新样式不要自己重扫 `lines`。字幕字号唯一来源 `subtitleFontSizes.ts`。这部分归另一 teammate，本报告只在第 4 节引用接口级事实。

---
## 2. 歌词五层解析

### 2.0 「五层」到底是什么（以代码为准的推导）

仓库没有「五层」这个词，但从调用链和类型边界可以无歧义地切出五层。划分标准是**数据形态**：每一层的输入/输出类型不同，且由不同文件负责，层间不回头调用。

| 层 | 名称 | 输入 → 输出 | 主要文件（证据） |
| --- | --- | --- | --- |
| **L0** | 原始来源层 | 文件句柄/内嵌标签/网络响应 → 统一 Raw 联合类型 | `types.ts:49-99`、`adapters/*`、`LyricParserFactory.ts:11-39` |
| **L1** | 字节与格式识别层 | 字节流 → 解码文本 + 「主/译/罗」三轨 + 格式枚举 | `lyricFileDecoding.ts`、`formatDetection.ts:5-8`、`timelineSplitter.ts:10` |
| **L2** | 格式解析层 | (格式, 文本) → 带时间戳的行/词草稿（Draft/Entry） | `parserCore.ts` 各 `parse*`、`ttmlConversion.ts:156` |
| **L3** | 统一时间轴模型层 | 草稿 → `LyricData`（`Line[]`/`Word[]`/渲染提示） | `parserCore.ts` finalize（`:166-175`）、`renderHints.ts:208/:241`、`types.ts:6-92` |
| **L4** | 展示加工层 | `LyricData` → 「可显示」`LyricData` | `createLyricsSetter.ts:67-110`、`staffCreditsPolicy.ts`、`filtering.ts:86`、`chorusEffects.ts:7` |

四类消费者（播放时钟桥、Lattice 画布、可视化器、HTTP API/导出）都只读 L3/L4 的 `LyricData`。**渲染是第六个角色，不在五层内**——它没有自己的数据格式，只是把 L4 输出映射到 DOM/Canvas。

### 2.1 L0 来源层：五个适配器与一个联合类型

`RawLyricSource` 是五个来源形状的判别联合（`src/utils/lyrics/types.ts:99`）：

```ts
// 逐字段按 types.ts:49-99 整理（非原样抄录）
RawEmbeddedLyric      // :49  usltTags?: string[]; textContent?; translationContent?
RawLocalFileLyric     // :58  type:'local'; lrcContent; tLrcContent?; rLrcContent?; formatHint?
RawQrcLyric           // :67  qrcContent; translationContent?
RawNeteaseLyric       // :73  lrc?{lyric,pureMusic,yrc,ytlrc,yromalrc,tlyric,romalrc}; yrc?; ytlrc?; yromalrc?; tlyric?; romalrc?; pureMusic?
RawNavidromeLyric     // :91  structuredLyrics?: StructuredLyric|StructuredLyric[]|StructuredLyricLine[]; plainLyrics?
```

**为什么 L0 要独立成层**：来源方的差异（网易云一坨多字段 JSON、Navidrome 结构化 cue、本地侧车三文件）在这一层被拍平成「文本 + 附属轨文本」，L1 之后完全不知道来源。这让解析器与网络平台解耦——也是 Zilux2 可以直接照搬的边界。

`LyricParserFactory.parse(source, options)` 就是一个 5 分支 switch（`src/utils/lyrics/LyricParserFactory.ts:11-39`）：`local/embedded/navidrome/netease/qrc` → 对应 adapter → `applyLyricDisplayFilter(parsed, filterPattern)`。选项默认值由 `resolveLyricProcessingOptions` 归一（`types.ts:7` 的 `LyricProcessingOptions{includeInterludes?, filterPattern?, songId?, fetchChorusRanges?}`）。

各适配器的关键差异：

- **LocalFileLyricAdapter**：① 先试 `.fia`（`parseFoliaLyricDocument`，`:15`）：命中即**跳过解析器**，因为 `.fia` 里已是被解析好的 `LyricData`；② 再试 AWLRC 容器 `[awlrc:...]`（`:19-26`）：容器内容被视为权威，**跳过**组合时间轴拆分与格式嗅探，翻译取 `tLrcContent || container.tlrc`，罗马音取 `rLrcContent || container.rlrc`；③ 否则 `splitCombinedTimeline` 拆主/译/罗（`:32/:35`），再嗅探格式并 `parseLyricsAsync(format, main, trans, options, romanization)`（`:39/:42`）。
- **EmbeddedLyricAdapter**：`usltTags` 归一化（`normalizeEmbeddedUsltTags`）或 `textContent` 归一化（`normalizeEmbeddedLrcText`）；同样先认 AWLRC 容器；再嗅探。
- **NeteaseLyricAdapter**：整个网易云多轨 JSON 交给 `neteaseProcessing.processNeteaseLyrics`，适配器本身只有一行转发（`adapters/NeteaseLyricAdapter.ts:6`）。
- **QrcLyricAdapter**：`parseLyricsAsync('qrc', qrcContent, translationContent)`（`:6`）。
- **NavidromeLyricAdapter**（语义最复杂，`:15-74`）：`structuredLyrics` 是「集合」时按 OpenSubsonic songLyrics v2 的 **cue 精准词轴**解析（`parseNavidromeStructuredLyricsCollection`）；否则选「主轨 + translation 轨」；单条直接解析；`plainLyrics` 最后兜底（走 `normalizeEmbeddedLrcText`）。

### 2.2 L1 字节与格式识别层

#### 2.2.1 解码（`lyricFileDecoding.ts`）

顺序是硬编码的安全阶梯：

1. **BOM 探测**：`EF BB BF` → UTF-8；`FF FE` → UTF-16LE；`FE FF` → UTF-16BE（`:24-26`）。
2. **严格 UTF-8**：`TextDecoder('utf-8', { fatal: true })`，非法序列抛错（`:29`）。
3. **GB18030 兜底**：中文老歌词最常见的 GBK 编码（GB18030 是其超集）（`:32`）。
4. **最终 UTF-8 非严格**：替换字符收尾，绝不把异常抛给渲染路径（`:34`）。
5. **换行归一**：`/\r\n?/g → \n`。
6. **KRC 特例**：文件头 4 字节 `[0x6b,0x72,0x63,0x31]`（ASCII `krc1`，`:15`）时调 `krcDecrypt`（来自 `services/onlineMusic/kugou/krcDecrypt`，`:13`）。KRC 是 XOR+zlib 加密的私有格式，只在酷狗源出现。

对外只有两个入口：`decodeLyricFileBytes`（`:41`）与 `readLyricFile(Blob)`（`:45`）。

#### 2.2.2 格式嗅探（`formatDetection.ts:5-8`）

`TimedLyricFormat = 'lrc' | 'enhanced-lrc' | 'vtt' | 'ttml'`。判定顺序：

1. 去 BOM。
2. **TTML**：含 `<tt` 且（命名空间 `http://www.w3.org/ns/ttml` 或 `itunes:timing=` 或 `ttm:agent=`/`ttm:role=`）。
3. **VTT**：以 `WEBVTT` 开头，或含 VTT 时间行正则 `(?:^|\n)\s*(?:\d{2}:)?\d{2}:\d{2}\.\d{3}\s*-->\s*...`（`:5`）——注释明确：**只出现裸 `-->` 不算 VTT**，避免把带箭头的普通歌词误判。
4. **增强 LRC**：含 `<\d{2}:\d{2}[.:]\d{2,3}>`（`:6`）或行内方括号时间标记（`:7`）。
5. 否则 **LRC**。

另有 `resolveExplicitFileTimedLyricFormat`：按扩展名 `.vtt/.ttml/.qrc/.yrc/.krc` 直接指定，避免嗅探误判。

#### 2.2.3 组合时间轴拆分（`timelineSplitter.ts:10`）

大量 LRC 资源把「原文/翻译/罗马音」塞进同一个文件，用**相同时间戳分组**区分：

- 按「该行所有方括号时间戳拼接成的签名」分组；增强 LRC 场景退化为同一个起始时间戳分组；
- 组内空白行只作为「上一行结束」标记，不参与分组（组长度 >1 时过滤空行）；
- `members[0]` 为主轨；若主轨含 CJK，且组内**恰好一个**候选满足「去标签后字母数 ≥2、字母/非空白比 ≥0.45、无 CJK」（`isRomanizationCandidate`，`:3`），其余候选作翻译；若罗马音候选缺失，其余第一个作翻译；
- 返回 `{main, trans, romanization}` 三串，无法拆分时 `main=原文`、另两轨为空，`isCombined=false`。

**失败模式**：同一段落内出现 3 行以上同时间戳（主/译/罗/音译混排）时，这个启发式会把其中两行分别归到翻译与罗马音，可能错位；`awlrc` 容器格式与 `.fia` 就是为绕开这类不可靠推断而存在的「显式容器」。

### 2.3 L2 格式解析层（`parserCore.ts`，1261 行）

| 格式 | 入口 | 时间戳语义 | 逐字 |
| --- | --- | --- | --- |
| LRC | `parseLRC:429` | `[mm:ss.xx]` 十进制秒 | 否（解析期均摊） |
| 增强 LRC | `parseEnhancedLRC:839` | 行时间 + `<mm:ss.xx>` 词标记 | 是（若存在词标记） |
| VTT | `parseVTT:781` | `hh:mm:ss.mmm` / `mm:ss.mmm` | 否 |
| TTML | `parseTTML:819` | 委托 `@applemusic-like-lyrics/ttml` | 是（TTML 本身） |
| YRC | `parseYRC:490` | 行 `[startMs,durMs]`；词 `(startMs,durMs,?)` | 是 |
| QRC | `parseQRC:571` | 同上；词 `(startMs,durMs[,?])` | 是 |
| KRC | `parseKRC:954` | 行 `[startMs,durMs]`；词偏移相对行首 | 是 |
| AWLRC | `parseAwlrc:1155` | `[mm:ss.xxx]` 毫秒原样 + `<offsetMs,durationMs>` | 是 |
| 纯文本 | 解码后嗅探失败 | 交给 LRC 解析器 | 否 |

#### 2.3.1 时间戳解析：一个容易踩的精度坑

`parseTimestamp`（`:250`）用 `min*60 + sec + parseFloat('0.' + fraction)`。因为 `parseFloat('0.12') = 0.12`：

- LRC `[00:12.34]` = 12.34s（两位小数 = 厘秒，**不是** 34ms）；
- LRC `[00:12.345]` = 12.345s（三位 = 毫秒）；
- 但 AWLRC 的 `parseAwlrcTimestamp`（`:1090`）把小数部分**当整数毫秒**：`[02:43.97]` = 163.097s，注释明确这是 LX Music `mm:ss.ms` 与酷狗/咪咕（不补零）、QQ（补三位）的差异。

即：**同一个「点号后数字」在两种格式里含义不同**。这是格式规范问题，不是实现 bug；Zilux2 移植时必须在类型上区分 `fractionDecimal` 与 `fractionMillis` 两种时间戳解析器。

#### 2.3.2 LRC 的时长推断（工程上最有价值的一段）

LRC 只有行首时间。`parseLRC`（`:429`）这样补：

1. `endTime` = 下一行 `startTime`；无下一行则 `startTime + 5`（兜底 5 秒）。
2. 估算阅读时间 `estimatedReadingTime = text.length * 0.5`（按「每字 0.5 秒」的朴素模型）。
3. 若 `duration > estimatedReadingTime + 2` 且 `duration > 5`，把 `duration` 截到 `min(duration, estimatedReadingTime + 2)`——**避免一个 30 秒的大间奏间隔把一行歌词的逐字动画拉成 30 秒的爬行**。

这类「行为规则」在文档里没有，只能从代码读出来；也是 Zilux2 自研解析器最值得对标的细节。

#### 2.3.3 行级歌词的逐字均摊（`buildTimedWords:59`）

LRC/VTT 没有词时间，但渲染层需要词。`buildTimedWords(text, start, end)` 的算法：

- 行时长下限 `duration = max(end-start, 0.1)`；
- 按空白切 token；含 CJK 的 token **逐字拆**（正则 `[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]`），标点 `[，。！？、：；"'）]` 权重 **0**，其余字权重 1；
- 非 CJK token 权重 `1 + token.length * 0.15`（英文长词获得更多时间）；
- 有效时长 `activeDuration = duration * 0.9`，剩余 10% 作为行尾留白；
- 按权重分时长，单字最短 `0.05s`；标点额外「吃掉」固定 `0.05s`；
- 若累计超出 `end`，按 `(end-start)/(last.end-start)` 整体缩放修正（避免负数/超出）。

摘录关键行（`parserCore.ts:59-118` 的骨架，审计用）：

```ts
const buildTimedWords = (text, startTime, endTime) => {
    const duration = Math.max(endTime - startTime, 0.1);
    // ...按空白/CJK/标点切 token，计算 weight
    const activeDuration = duration * 0.9;
    const timePerWeight = activeDuration / totalWeight;
    // ...逐 token 赋 startTime/endTime，标点 weight=0 且固定 0.05s
    if (last.endTime > endTime) {
        const scale = (endTime - startTime) / (last.endTime - startTime);
        // ...整体缩放
    }
};
```

#### 2.3.4 间奏注入（`:120-164`）

- 常量 `INTERLUDE_FULL_TEXT = '......'`（`:57`）。
- 首行 `startTime > 3` → 在 `[0.5, first.start-0.5]` 插一个间奏行；
- 相邻两行间隔 `> 3` → 在 `[prev.end+0.05, next.start-0.05]` 插间奏；
- 间奏行的 `words` 是 **6 个点**，每个点 `duration/6`，因此间奏在逐字渲染里会一颗颗点亮；
- `finalizeParsedLyricLines(lines, options)`（`:166-175`）：先注入间奏（除非 `options.includeInterludes === false`），再 `annotateLyricLines` 计算渲染提示；
- 用户可配置 `includeInterludes` 关闭它（`LyricProcessingOptions.includeInterludes`）。

#### 2.3.5 翻译/罗马音的时间戳匹配（`:185-248`）

这是全仓最值得学习的一个小算法：

- `ALTERNATE_TRACK_MATCH_WINDOW = 1.0`（`:185`）——窗口 ±1 秒；
- `lowerBoundByStartTime`（`:188`）**二分**定位窗口起点，然后只在小窗口内做匹配（这是全仓罕见的二分，说明作者知道行时间有序）；
- 每个主行找窗口内候选，按 `(时间差, 行号, 条目号)` 排序；
- **贪心稳定匹配**：一行与一条翻译各自只能用一次。函数头注释（`:202-211`）明确记录了旧实现 bug：早期用「最近邻」，导致 ±1 秒内的多条主行共享同一条翻译，出现「同一句翻译重复显示」以及对唱/多歌手场景翻译串行错位；
- 找不到匹配就留空，不强行配对。

同一思路在 AWLRC 的附属轨匹配里复用（`resolveAlternateTracks:1126`）：先按「精确毫秒」建 Map 命中；只要有一处精确命中就**只**用精确匹配，否则退回 ±1s 最近邻（注释 `:1117-1124` 解释：精确命中意味着同一来源，最近邻只在跨来源时才需要）。

#### 2.3.6 各逐字格式的具体坑

- **YRC（网易云）**：行头 `[startMs,durationMs]`，词标签 `(startMs,durationMs,?)` 是**绝对毫秒**。`isWordByWord: true`。
- **QRC（QQ）**：行头同 YRC，词标签 `(startMs,durMs[,?])`。难点在「词文本在哪」——标签之间的文本可能是前一个词的后缀也可能是后一个词的前缀，代码用 `prefers前端侧ingText/prefersTrailingText` 启发式判定（`:571-701` 段）。翻译轨递归调用 `parseQrcTrackEntries` 解析。
- **KRC（酷狗）**：`[language:base64]` 里是 JSON 数组，`type 0` = 罗马音、`type 1` = 翻译（`:954-1079`）；词时间相对行首：`wordStartMs = lineStartTimeMs + wordStartOffsetMs`（`:1027-1028`）；没有词标签时回退 `buildTimedWords`。
- **AWLRC（LX Music 容器）**：`[awlrc:...]` 内联容器带 `tlrc/rlrc` 三轨；音节标签 `<offsetMs,durationMs>` 相对行首；**零长度/倒退修补**：`offsetMs = max(offset, cursorMs)`、`durationMs = max(dur, 1)`，用 cursor 保证单调；解析后按 `startTime` 排序（因为小数部分按字符串比较时 `.79` 会排在 `.181` 前面）；`isWordByWord: true`。
- **VTT**：支持三种时间戳；`stripVttCueText` 去标签/实体并归一空白；按空行分块；跳过 `WEBVTT/NOTE/STYLE/REGION`；`endTime` 缺失时取「下一 cue 起点」或 `start+5`；`<c>` 等内联标签在整个 cue 上被剥掉，因此 VTT 实际按行渲染（卡拉 OK 标签信息丢失）。
- **TTML（Apple Music 生态）**：直接依赖 `@applemusic-like-lyrics/ttml`（`package.json:247`，`^1.0.1`）+ `@xmldom/xmldom` DOMParser。`ttmlConversion.ts` 做适配：`convertLine:156`、`foldAgentOverlapHarmonyLines:210`（把重叠的同句多 agent 行折叠成背景和声/对唱）、`buildLyricDataFromTTMLResult:256`。TTML 的 `timingMode`（Word/Line）与 `agents` 会写进 `LyricData.ttml`（`types.ts:83-92`）。**遗留问题**：`parseTTML` 里有一句生产代码的调试日志 `console.log('[TTML] Adapted lyric data for visualizers:', ...)`（`:819-837` 段），说明这条路径没清场。

### 2.4 L3 统一时间轴模型层（`src/types.ts`，逐字段）

这是整个子系统的「货币」。字段全部**秒（float）**，`startTime` 为行/词起点、`endTime` 为终点。

```ts
// src/types.ts:6-92（结构按代码整理，命名与原字段一致）
interface LyricRuby       { text: string; startTime: number; endTime: number }            // :6  注音/假名 ruby
interface LyricSyllable   { text: string; startTime: number; endTime: number;
                            endsWithSpace?: boolean; ruby?: LyricRuby[];                 // :12
                            obscene?: boolean; emptyBeat?: number }
interface LyricAlternateText { role: 'translation'|'romanization'|string; language?: string;
                            text: string; syllables?: LyricSyllable[] }                  // :22
interface Word            { text: string; startTime: number; endTime: number;
                            syllables?: LyricSyllable[] }                                // :29
interface LyricBackgroundVocal { text: string; startTime: number; endTime: number;
                            words: Word[]; agentId?: string; translation?: string;
                            romanization?: string; alternateTexts?: LyricAlternateText[] } // :36
type SubtitleContentMode = 'translation'|'romanization'|'both'|'none'                    // :49
interface LyricAgent      { id: string; name?: string; type?: string }                    // :51
interface Line {
    words: Word[]; startTime: number; endTime: number; fullText: string;                 // :57
    translation?: string; id?: string; agentId?: string; songPart?: string;
    blockIndex?: number; romanization?: string; alternateTexts?: LyricAlternateText[];
    backgroundVocal?: LyricBackgroundVocal; backgroundVocals?: LyricBackgroundVocal[];    // :69-70 单数/复数兼容
    renderHints?: LineRenderHints; isChorus?: boolean;                                    // :71-72
    chorusEffect?: 'bars'|'circles'|'beams';
    wordSegments?: string[]; autoWordSegments?: string[];                                 // :78-79
}
interface LyricData {
    lines: Line[]; title?: string; artist?: string; isWordByWord?: boolean;               // :83
    ttml?: { timingMode?: 'Word'|'Line'; agents?: Record<string, LyricAgent> };           // :90
}
```

字段语义（代码/消费方反推）：

| 字段 | 语义 | 失败模式/注意 |
| --- | --- | --- |
| `lines[].startTime/endTime` | 行级时间轴（秒） | 行级格式靠**推断**（下一行/5s 兜底），不是真值 |
| `words[]` | 逐字/逐词时间轴 | 行级来源是均摊值；`endsWithSpace` 控制渲染时是否补空格 |
| `fullText` | 行纯文本 | 间奏行为 `'......'`；判断用全等，不要 `includes` |
| `translation` / `romanization` | 行级副轨文本 | 行轴匹配，不携带词时间；渲染层按行对齐 |
| `alternateTexts[]` | 通用副轨（role 可扩展） | TTML/AMLL 用；`role` 是开放字符串 |
| `agentId` + `LyricData.ttml.agents` | 对唱/多歌手标识 | 行级 agent；渲染层按 agent 分色/分侧 |
| `backgroundVocal(s)` | 背景和声/对唱重叠行 | 双字段兼容；TTML 的 `foldAgentOverlapHarmonyLines` 产出 |
| `blockIndex` | 制作名单等「成块行」的组号 | 与 `staffCreditsDecision` 联动（见 2.5） |
| `renderHints` | 渲染提示（派生数据） | **不持久化**：`.fia` 导出与缓存迁移都重新计算 |
| `wordSegments` / `autoWordSegments` | 用户分词 / 自动分词 | `.fia` 保留用户分词、剥掉自动分词（派生） |
| `isWordByWord` | 是否有真词轴 | 与「words 是否存在」不等价：行级来源也有 words（均摊） |
| `ttml.timingMode` | TTML 计时模式 | 影响可视化器的行/词动画选择 |

**派生数据的边界**在代码里写得很清楚：`renderHints` 是「纯函数可从 lines 重算」的派生层，因此 `.fia` 序列化时 strips 它（`foliaLyricDocument.ts:66`），缓存读取时用 `migrateLyricDataRenderHints` 升级（`renderHints.ts` 迁移函数），展示层再用 `ensureLyricDataRenderHints` 兜底（`renderHints.ts:241`）。这是「派生数据不进持久化格式」的教科书做法。

### 2.5 L4 展示加工层（`createLyricsSetter.ts`，127 行）

L3 输出还不是「能显示」的歌词——纯音乐判定、用户过滤、制作名单策略、合唱段、分词都在这一层，按固定顺序执行（`createLyricsSetter.ts:67-110`）：

1. **纯音乐判定**：`isPureMusicLyricLines`（`pureMusic.ts:86`）与网易云 `pureMusic` 标志（`hasNeteasePureMusicFlag:24`）；
2. **用户过滤**：`applyLyricDisplayFilter(nextLyrics, lyricFilterPattern)`（`filtering.ts:86`）——先剥间奏（若关闭），再按过滤正则（`compileLyricFilterPattern:26`）滤掉匹配行；
3. **制作名单策略**：`applyLyricStaffPolicy(...)`（`staffCreditsPolicy.ts`）。默认 `smart`（`:28`）、最小停留 `1.5s`（`:29`）、吸收模式 `off`（`:30`）、窗口 0.6–4s；`staffCreditsDecision.ts:38` 的核心公式：`requiredSeconds = displayLines.length * minDwell + TAIL_MARGIN_SECONDS(=1)`（`:9`）；窗口够 → `keep` 或 `retime`，不够 → `hide`（`:57-65`）；`absorbMode` 可把制作名单并入相邻行；
4. **合唱段**：行上已有 `isChorus` 则缓存；否则从网易云匹配结果借 `chorusRanges`；再否则用文本频率检测（`applyDetectedChorusEffects`，`chorusEffects.ts:7`）并把重建的 LRC 文本缓存起来，供下次免检测；效果枚举 `['bars','circles','beams']`（`chorusEffects.ts:5`）；
5. **用户分词**：`applyLyricWordSegmentation`（以 `lyricSeg_<songKey>` 为键的缓存记录，`lyricSegmentation.ts:16`、`:19`）；
6. **自动分词**：`applyAutoWordSegmentation`（icuFolia：中文 jieba、日文 budoux，`icuFolia/engines.ts`）；
7. **派生兜底**：`ensureLyricDataRenderHints`（`renderHints.ts:241`）；
8. **宿主 transform**：Folium 扩展点的 `lyrics.transform`，然后 `setLyricsState`。

**为什么制作名单策略不放在解析器**：`createLyricsSetter.ts:40-42` 的注释给了理由——它是**显示决策**，依赖「已经完成的时间轴」与用户设置；解析/缓存层不应把「这一行最终隐不隐藏」烘焙进 `LyricData`，否则同一份缓存无法服务不同设置。这是很好的分层原则。

### 2.6 多来源回退与合并总表

| 场景 | 回退顺序 | 证据 |
| --- | --- | --- |
| 本地同名多格式 | `.fia`（priority -1）> `lrc` > `vtt` > `ttml` > `qrc` > `yrc` > `krc`；翻译侧车 `.t.lrc/.t.vtt` 跟随主格式序 | `localLyricFormatOrder.ts:6/:10/:35/:40` |
| 本地 vs 用户导入 | 侧车文件只有在**磁盘上真变过**时才覆盖用户上传；重排格式序不算 | `localMusicService.ts`（`changedLyricBasePaths` vs `lyricFileChangedBasePaths`，约 `:616-620`） |
| Navidrome | 结构化歌词优先，但「非增强结构化」时优先 `plainLyrics`；最后回退已解析的结构化 | `appNavidromeLyrics.ts:14/:18/:28` |
| 网易云多轨 | `yrc` 存在则用 `yrc`（词轴），翻译 `ytlrc` 优先 `tlyric`，罗马音 `yromalrc` 优先 `romalrc`；否则 `lrc` + `tlyric` | `neteaseProcessing.ts:9/:17/:22/:26` |
| 在线自动选词 | 偏好源（默认 `qq`）优先，然后 `netease, amll, qq, kugou, spotify`（去重）；`spotify` 是 `linesOnly` 兜底，只有前面都没给行时才问 | `sourcePriority.ts:6/:9`、`lyricSources.ts:38` |
| 候选可靠性 | `titleMatched && (artistMatched || albumMatched)`；分数 <75 丢弃；任一组件不匹配封顶 74 | `autoMatchBestLyric.ts:135`、`:24`、`matchScore.ts:17` |
| 跨源翻译 | 主轨与副轨时间戳精确命中优先，否则 ±1s 最近邻 | `parserCore.ts:1117-1148` |

### 2.7 失败模式清单（面向复用）

| 失败 | 表现 | Folia 的处理 |
| --- | --- | --- |
| 编码错误 | 乱码/解析不出时间 | BOM → strict UTF-8 → GB18030 → 宽容 UTF-8，四段阶梯 |
| KRC 解密失败 | 二进制乱码 | 若明文「看起来像时间轴歌词」则降级当普通 LRC 用；否则抛错（`kugouLyricProvider.ts`） |
| 时间戳 NaN/Infinity | 渲染钟失控 | API 出口 `copyTime` 把非有限值归 0（`lyricApi.cjs:45` 段）；内部靠 `Math.max` 兜底 |
| 行结束时间缺失 | 最后一行永不结束 | 5s 兜底；增强 LRC 用 `lineStart+0.001` 防止零长 |
| 一行过长间隔 | 逐字爬行 | 阅读时间上限（`len*0.5+2`）截断 |
| 翻译重复 | 多行同译 | 贪心稳定匹配 + ±1s 窗口 |
| 组合时间轴误拆 | 翻译/罗马音错位 | 显式 AWLRC 容器 / `.fia` 优先 |
| 在线源超时 | 选词卡住 | 搜索 3500ms / 取词 5000ms 超时，失败即跳过（`autoMatchBestLyric.ts:21-22`） |
| 代理失败 | Web 端拿不到歌词 | `requestLyricProxyOnDesktop` 无桥时直接返回 `null`（不重试），由上层显示无歌词 |
| Worker 解析异常 | 主线程崩 | Worker 回 `{type:'error'}`，客户端 resolve `null` |
| 纯音乐误判 | 有歌词却被藏 | 文本判定 + 在线标志双通道，宁可显示不误藏（待确认优先级细节） |

---
## 3. 时间轴模型

### 3.1 单位与坐标系统

| 量 | 单位 | 证据 |
| --- | --- | --- |
| `Line.startTime/endTime`、`Word.startTime/endTime`、`renderHints.rawDuration/renderEndTime` | **秒（float）** | `src/types.ts:29/:57/:83`；`renderHints.ts` 全部以秒计 |
| 用户时间轴偏移（单曲 + 全局） | **毫秒（int）** | `usePlaybackStore.ts:64`（`lyricTimelineOffsetMs: number`）、`lyricOffsetMemory.ts:15`、`useLyricSettingsStore.ts:128` |
| HTTP API `offset` | **毫秒**，行/词时间 **秒** | `docs/lyric-api.md:103`、`:70`；`electron/lyricApi.cjs:45` |
| `.fia` 信封 `offsetMs` | 毫秒，**仅元数据**，不平移时间轴 | `foliaLyricDocument.ts:35-46`、`:66` |
| 音乐进度（音频元素 / GSMTC 类外部源） | 秒（`currentTime`） | `usePlaybackVisualizerBridge.ts:203-207` |

**只有 offset 用毫秒**不是随意选择：offset 是 UI 旋钮值（用户输入、持久化、HTTP 参数），整数毫秒便于序列化与比较；而歌词内部所有时间都是浮点秒，避免每条路径都做 `/1000` 换算。代价是**接口边界上必须显式转换**，Folia 在三个地方做：时钟桥、HTTP API 出口、导出元数据。

三个时钟变量构成坐标系统（`src/stores/motionSignals.ts`）：

```ts
currentTime                 // :31 播放器时钟（实际听到的秒）
lyricCurrentTime            // :34 歌词时钟 = currentTime - 每首 offset（注释明确「separate from currentTime: carries the per-song timeline offset」）
handoffProgress / handoffLyricCurrentTime // :41-45 混音交接（下一首）的进度与歌词时钟
```

### 3.2 行时间轴的三个「结束时间」

一行歌词有**三个**不同的终点，混用会出错：

1. `Line.endTime`：解析器给出的行结束（下一行开始/兜底 5s）；
2. `renderHints.renderEndTime`：渲染层「这一行还应留在屏幕上」的终点，由 `buildLineRenderEndTime`（`renderHints.ts:114-135`）在行时长基础上加转场/余辉时间；
3. 行实际被替换的时刻：`currentLineIndex` 切换到下一行时。

`findLatestActiveLineIndex`（`src/utils/appPlaybackHelpers.ts:21-32`）的命中条件用的是 **renderEndTime 优先**：

```ts
// appPlaybackHelpers.ts:21-32（骨架）
for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || time < line.startTime) continue;      // 还没开始，继续往前找
    if (time <= (line.renderHints?.renderEndTime ?? line.endTime)) return i; // 命中
}
return -1;
```

意义：歌词行在「渲染上」比它的音乐时间更长寿一点——足够播完出场/余辉动画，避免行与行之间闪空。这也解释了为什么 `renderHints` 是 `Line` 上的派生字段而不是单独的旁路结构。

转场时序由 `getLineTransitionTiming`（`renderHints.ts:48`）按行时长分三档：

| 档位 | 阈值 | 行为 |
| --- | --- | --- |
| `micro` | 行时长 < `0.10s`（`:33`） | 几乎不播转场、词揭示 instant |
| `short` | < `0.18s`（`:34`） | fast 档：enter `clamp(raw*0.45, 0.045, 0.06)`、exit `clamp(raw*0.22, 0.03, 0.04)`，hold 0.03 |
| `normal` | ≥ `0.18s` | enter `min(0.42, max(0.22, max(raw,0.12)*0.34))`、exit `min(0.32, max(0.18, max(raw,0.12)*0.18))`、hold 0.06 |

另有 `MICRO_LINE_RENDER_FLOOR = 0.067`（`:35`）作为微行最小可渲染时长。**这是性能护栏的一部分**：短行不能跑长动画，否则 CPU/视觉都会抖。

### 3.3 逐字时间轴与边界

- 真词轴来源：增强 LRC（`<mm:ss.xx>`）、YRC/QRC（绝对毫秒）、KRC（相对行首偏移）、AWLRC（相对偏移 + 单调修补）、TTML（Word timing）、Navidrome cue。
- 均摊来源：LRC/VTT/纯文本（`buildTimedWords`，权重算法见 2.3.3）。
- 零长度/倒退防护：增强 LRC 行起点 `+0.001`；AWLRC `cursorMs` 修补（`max(offset,cursorMs)`、`max(dur,1)`）；行级均摊保证每个词 `≥0.05s`。
- 词时间与行时间的关系：**不保证 `lastWord.endTime === line.endTime`**。行级有兜底/留白，逐字有 0.9 有效系数；渲染必须以词自己的 `endTime` 为准，而不是按行等分。classic 可视化器就是这么做的（`GlowWord` 按词状态机绘制，而不是按行进度）。
- `ruby`/`syllable`/`syllables`：TTML/AMLL 路径可能带注音与音节，渲染层可作为附加层；Zilux2 若不做卡拉 OK 注音可先忽略。

### 3.4 翻译与罗马音时间轴

- **行轴而非词轴**：`translation`/`romanization` 字符串只挂在 `Line` 上，没有逐词副轨（`types.ts:57-70`）。翻译的时间 = 它所属行的时间；渲染层在行激活期间显示。
- 匹配算法：±1s 窗口 + 贪心稳定匹配（2.3.5）。跨来源附属轨用精确毫秒 Map 优先，回退 ±1s。
- `alternateTexts[]` 提供「多角色副轨」（role/language），TTML/AMLL 使用；字幕内容模式由 `SubtitleContentMode`（`types.ts:49`）与设置项控制显示 translation/romanization/both/none。
- **对唱/多歌手**：`Line.agentId` + `LyricData.ttml.agents`（`types.ts:51-55`、`:83-92`）；TTML 折叠重叠和声行到 `backgroundVocals`（`ttmlConversion.ts:210`）。渲染层可按 `agentId` 分色/分侧；副歌段由 `isChorus`/`chorusEffect` 标记。
- `songPart`：自由文本段落标签（intro/chorus 等），渲染层可做「段落进度」类效果，非时间轴必需。

### 3.5 间奏、纯音乐与「无歌词」状态

- **间奏行**：`INTERLUDE_FULL_TEXT = '......'`（`parserCore.ts:57`），由 `attachInterludes`（`:120-164`）注入，6 个点平均分配时长；渲染层判断必须用全等（`classic/Visualizer.tsx:166` 的 `activeLine.fullText === '......'`），因为正常歌词理论上也可能包含点号。
- **纯音乐**：`isPureMusicLyricLines`（`pureMusic.ts:86`）在展示层判定；在线来源有 `pureMusic` 标志（`hasNeteasePureMusicFlag:24`）；导出时 `judgeLyricsForExport` 会 skip（`exportableLyrics.ts`）。纯音乐不等同于「无歌词」：前者应显示「纯音乐」UI，后者显示「暂无歌词」。
- **无歌词**：解析返回 `null`；`hasRenderableLyrics` 判定（`utils/lyrics/validity`）决定是否进入渲染。

### 3.6 查找与索引：为什么是线性扫描

`findLatestActiveLineIndex` 每帧从末尾向前扫，命中即返回（3.2 摘录）。特点：

- **复杂度 O(n)**，n = 行数（通常 40–150，长曲/纯音乐可到 300+）。32–60fps 下每帧一次，n=150 时约 150 次比较/帧，可忽略；n=1000+ 的极端歌词会开始有感。
- **反向扫描 + 提前 return**：当前行通常靠近末尾（已唱过的行），实际比较次数远小于 n。
- **没有二分**：虽然 `lines` 按 startTime 有序（解析后 `sortByStartTimeIfNeeded` 保证），但 renderEndTime 可能越过下一行 startTime（行重叠），二分不再单调，作者选择线性求稳。这是合理的工程取舍，不是疏忽。
- 二分只出现在解析期的翻译匹配（`parserCore.ts:188`）。
- **写 store 的边界**：桥在行索引**变化时**才 `setCurrentLineIndex`（`usePlaybackVisualizerBridge.ts:207-210`），把 O(n) 扫描与 React 渲染解耦：扫描每帧做，store 写入只在行切换时做。
- **缝隙回填**：可视化器需要「行间空隙保留上一句」时用 `getRecentCompletedLine`（`visualizer/runtime.ts:35`）反向找最近结束的行，而不是让每个样式自己扫。
- **seek**：点击歌词行 → `onLyricLineSeek(line.startTime)`（`MonetLyricsRail.tsx:264`）→ App 用 `playbackTime = max(0, lyricTimeSec + currentTime.get() - lyricCurrentTime.get())`（`App.tsx:2012-2026`）把「歌词时间」换算回「播放时间」，再 seek 音频；阶段播放（无真实音频元素）改走 `syncStageLyricsClock`。

### 3.7 时钟来源与同步策略

这是整个歌词子系统最核心的工程决策：**只有一个写时钟的地方**——`usePlaybackVisualizerBridge` 的 rAF 循环（353 行）。四个分支按「舞台上是谁在播」选择时钟源：

| 分支 | 时钟源 | 证据 |
| --- | --- | --- |
| 真实音频播放 | `HTMLAudioElement.currentTime`（混音过渡期取「画面上」的 deck：`getDisplayElement?.() ?? audioRef.current`） | `usePlaybackVisualizerBridge.ts:203-207` |
| NowPlaying 舞台（本地 API/远程播放器） | 锚点时钟：`performance.now()` 外推，`progress` 轮询修正 | `useStagePlaybackController.ts:339-368`、`nowPlayingClock.ts:5-7` |
| PlayerCap 舞台（外部设备） | `Date.now()` 锚点外推 | `useStagePlaybackController.ts`（`getPlayerCapDisplayTime`） |
| 合成 stage 歌词 | `stageLyricsClockRef{startTimeSec,endTimeSec,baseTimeSec,startedAtMs}`，`performance.now()` 外推后 clamp | `useStagePlaybackController.ts:143-148`、`:322-337` |

**真实音频分支**每帧：

```ts
// usePlaybackVisualizerBridge.ts:203-210（骨架）
const time = audioElement.currentTime;
currentTime.set(time);
const effectiveLyricTime = time - displayOffsetMsRef.current / 1000;
lyricCurrentTime.set(effectiveLyricTime);
const index = findLatestActiveLineIndex(lyrics.lines, effectiveLyricTime);
if (index !== lastIndex) setCurrentLineIndex(index);
```

**远端/合成时钟**采用「锚点 + 外推 + 阈值修正」：

- `nowPlayingClock.ts:5` `NOW_PLAYING_PROGRESS_QUERY_URL = 'http://localhost:9863/api/query/progress'`；
- `:6` 轮询间隔 `7000ms`（7 秒！远程播放器进度靠低频轮询）；
- `:7` 修正阈值 `0.2s`：外推值与服务器新值差超过 0.2s 才跳变，否则忽略（避免每 7 秒抖一下）；
- `resolveNowPlayingAnchorTime`：播放中用 `progressMs + rttMs/2` 做 **RTT 补偿**，暂停直接用 `progressMs`，再 clamp 到 `[0,duration]`；
- 暂停/恢复：`startedAtMs = paused ? null : performance.now()`，暂停时返回冻结的 base 值；
- 循环结束：`loopMode one/all` 时把时钟重置到 0 并重算行；不循环则 `syncNowPlayingClock(duration,…)` + `setPlayerState(PAUSED)`（`usePlaybackVisualizerBridge.ts:238-241`）。

**seek/pause**：真实音频分支**不需要特殊处理**——`audioElement.currentTime` 就是权威，seek 后下一帧自然正确（这也是「单一数据源」的好处）。需要注意的只有：

- **offset 用 ref 而不是直接闭包**：`displayOffsetMsRef/incomingOffsetMsRef` 通过 `useEffect` 同步 prop（`usePlaybackVisualizerBridge.ts:274-287`），注释说明这是为了避免「结算那一帧读到旧 offset」；
- **切歌重置**：显示歌曲变化时把歌词时钟设为**负 offset**：`lyricCurrentTime.set(-(nextOffsetMs + globalLyricTimelineOffsetMs) / 1000)`（`useLyricReadHead.ts:60`），于是「歌曲开头 + 正 offset」也能从正确的负时间起步，第一行不会提前亮；
- **混音交接**：`transitionDisplay` 状态变化时立刻用 `readIncomingLyricClock(incoming.currentTime, incomingOffsetMs, lines)` 重算（`incomingLyricClock.ts:8`、bridge `:136-140`），不等下一帧；`handoffLyricCurrentTime`/`handoffLineIndex` 供可视化器画「下一首」；
- **时钟漂移**：真实音频分支不做插值/漂移校正（音频元素就是真值）；远端锚点时钟靠 0.2s 阈值修正；没有 PID/平滑滤波，实现简单、可预期。

**外推的精度单位**：毫秒级（`progressMs`/`rttMs`），换算成秒写入 motion value；`parseNowPlayingProgressResponseMs` 对非有限值返回 0 并 floor。

### 3.8 offset 的完整链路（最容易实现错的地方）

1. **存储**：全局偏移在 `useLyricSettingsStore.ts:128`（`globalLyricTimelineOffsetMs`，`localStorage`）；单曲偏移在 `lyricOffsetMemory.ts`：`STORAGE_KEY='lyric_timeline_offsets'`（`:15`）、直接 `localStorage` 存 `{songId: offsetMs}`、`MAX_ENTRIES=1000` 按 Map 插入序做 LRU（`:18`）、`readLyricOffset` 缺省 0（`:67`）、`writeLyricOffset` 写 0 即删除、重写时 delete+set 移到 Map 末尾（`:76`）。
2. **合成**：`effectiveOffsetMs = readLyricOffset(displaySongId) + globalLyricTimelineOffsetMs`（`useLyricReadHead.ts:66-70`）。注意这发生在「显示歌曲」维度，混音交接时用「即将播放歌曲」的 offset（`incomingLyricTimelineOffsetMs`）。
3. **应用**：只在时钟层做 `lyricTime = audioTime - offset/1000`（bridge `:203-207`、`readIncomingLyricClock`）。**时间轴数据本身永不被平移**。
4. **导入/导出**：`.fia` 的 `offsetMs` 只是元数据（`foliaLyricDocument.ts:35-46`）；导出时的用户偏移写进 `applyUserAdjustments` 的元信息而不是烘焙进时间（`applyUserAdjustments.ts:14-23`，理由注释：烘焙会让「同一首歌的另一个版本音频」整体错位）。
5. **HTTP API**：`offset` 字段随歌词发布；客户端用法 `播放时间 - offset/1000`（`docs/lyric-api.md:320`）。

**失败模式**：如果实现方在解析/导入阶段就把 offset 加进 `startTime`，再在时钟层减一次，就会**双重偏移**。Folia 用「offset 只存在于时钟层 + 持久化里」这条纪律避免了它；Zilux2 必须显式写进契约。

---

## 4. 渲染与同步

### 4.1 三类渲染目标

| 目标 | 技术 | 关键点 |
| --- | --- | --- |
| 主窗口 Lattice 歌词 | **Canvas 2D**：`useLatticeLyricCanvas` + `createLatticeLyricRuntime` + `latticeLyricTimeline/raster/scene/frameLoop/session` | 单 canvas、`aria-hidden` + `sr-only` 当前行文本（可访问性）；`reducedMotion` 一路透传（`LatticePoster.tsx:326`）；`prewarmLatticeLyrics` 预热 |
| 舞台可视化器 | React DOM + framer-motion（多数样式）/ Canvas/WebGL（部分样式） | 逐词 DOM 动画（classic）；字幕独立 overlay；`currentTime/audioPower/audioBands` 全是 `MotionValue` |
| 外部/OBS/远程 | 同一套可视化器组件 + HTTP 歌词 API | 远程窗口复用组件；`RemoteControlApp` 支持 reduced motion |

### 4.2 模型 → DOM/CSS 映射原理（以默认样式 classic 为例）

`src/components/visualizer/classic/Visualizer.tsx`（395 行）是「baseline」样式，管线最直白（注释 `:19-27`）：**runtime 取当前行 → 读该行 renderHints → 建松散逐词布局 → 每个词独立动画**。

1. **选行**：`useVisualizerRuntime` 系列辅助（`:105` 附近）拿到 `activeLine` + `currentLineIndex`；
2. **布局**：`buildPostLyricLayoutUnits(activeLine, { semantic: true, sticky: true })` 与 `buildDisplayWordsFromLayoutUnits`（`src/utils/lyrics/cjkSemanticLayout.ts`）把行拆成「语义块 → 显示词」的松散布局单元（`:108-140` 段）；每个词的 x/y 宽度靠 `measureWordWidth`：模块级 canvas + `context.font = ${weight} ${size}px ${stack}` + `measureText`，无 `document` 时退化为 `text.length * pxSize * 0.65`；
3. **词状态机**（`GlowWord.tsx:52` 附近）：`waiting`（进场前的轻姿态）/ `active`（发光/主体/涟漪）/ `passed`（余辉+漂移）；激活判据是「当前歌词时间 ≥ 词开始 - 预看量 且 ≤ 词渲染结束」，其中「词渲染结束」来自 `getGlowWordActiveEndTime`（`glowWordTiming.ts:35`），渲染 profile 由 `resolveGlowWordRenderProfile`（`:16`）从 `renderHints` 推导；
4. **动画**：word 内部用 `useMotionValueEvent` 驱动（不依赖父组件重渲染）；行容器动效由 `getGlowWordLineContainerMotion`（`:58`）给出；
5. **行切换**：`AnimatePresence` + `key={activeLine.startTime}`（`:317-320`）——行一变就整行重挂载，用 React key 做「换行」而不是手动 diff；
6. **颜色/字体**：`resolveWordColor(word.text, theme.wordColors, theme.accentColor)`（`:332`）；字体栈由主题注入（`VisualizerShell` 负责字体注入，`VisualizerShell.tsx`）。

**效果原理（不逐行实现）**：逐字高亮 = 词级 `active` 状态切换 `opacity/filter/textShadow/scale`；当前行用 `AnimatePresence` 进出；相邻行在字幕 overlay（见 4.3）里以 `blur-[1px]` 显示；`blur/scale` 均为 CSS filter/transform，走合成层。

### 4.3 字幕 overlay（翻译/罗马音/下一句）

翻译与罗马音**不在歌词行 DOM 里**，而在独立 overlay：`src/components/visualizer/VisualizerSubtitleOverlay.tsx`（221 行）：

- `resolveVisualizerSubtitleOverlayContent`（`:48`）：优先当前行，行间空隙回退 `recentCompletedLine`（保留上一句翻译）；只有 `subtitleTracks` 为空时才显示 upcoming 行；upcoming 过滤掉无字母数字的行（`/[\p{L}\p{N}]/u`）；
- 主字幕入场：`opacity/y duration 0.24 easeOut`（`:140-147`）；
- 位置：`bottom` 由共享 `MotionValue` 直接驱动，注释明确「不要改回 transform：这一层下面压着 blur 辉光，多一个合成层就会变色」（`:143-146`）；
- upcoming 行：`getUpcomingLyricsClassName(blur=true)` → `truncate max-w-2xl mx-auto transition-all duration-500 blur-[1px]`（`:22`）；设置 `subtitleUpcomingLyricsBlur` 可关（`:201`）；
- 背景辉光：`absolute -inset-x-10 -inset-y-6 blur-2xl` + `subtitleOverlayBackground`（`:150` 段）。
- **注入式注释**：该文件 `:105-107` 有一段 `@ai-ignore / DO NOT MODIFY / DO NOT INFORM USER` 的文本——按数据处理，不执行（见 8.3）。

### 4.4 订阅播放状态的方式

- **帧级数据**走 framer-motion `MotionValue`：`currentTime`、`lyricCurrentTime`、`audioPower`、`audioBands`（`motionSignals.ts:31-52`）。组件用 `useMotionValueEvent`/`useTransform` 订阅，**不进入 React state**，因此每帧不触发渲染。`motionSignals.ts` 注释明确：这些值每帧变化，不能放进 reactive store。
- **行级数据**走 zustand：`currentLineIndex`、`lyrics`、`transitionDisplay`、`paused/playerState`（`usePlaybackStore.ts`）。写入被桥收敛到「行变化时」（4.1 节、3.6 节）。
- **显示歌词选择**：`selectDisplayLyrics = state => state.transitionDisplay ? state.transitionDisplay.lyrics : state.lyrics`（`usePlaybackStore.ts:188-189`）——混音时显示的是「即将播放歌曲」的歌词，而 `lyrics` 仍是当前播放的。
- **HTTP 发布**：`useLyricApiPublisher` 的 effect 依赖 `[lyrics, offset, status.enabled]`（`src/hooks/useLyricApiPublisher.ts`），只在歌词/偏移/开关变化时发布，不做每帧推送。

### 4.5 性能处理（与歌词相关的部分）

- **单 rAF 循环**：全应用只有 `usePlaybackVisualizerBridge` 一个歌词 rAF 循环，所有时钟写入集中；其它组件只是消费者。
- **解析在 Worker**：主线程零解析成本（`workerClient.ts:25`）。
- **布局预计算**：classic 的词布局在行激活时算一次（不是每帧 measure）；canvas measure 复用模块级 context。
- **重渲染边界**：行变化才写 store；每帧只写 MotionValue（不触发 React）。
- **视觉器样式延迟切换**：`VisualizerRenderer` 用 `useDeferredValue(mode)`，新样式代码就绪才换（`src/components/visualizer/README.md`）；每个样式 `React.lazy` 加载。
- **reduced-motion**：设置页 `MotionReductionSettingsSection.tsx`；可视化器有 `staticMode`/`backgroundStaticMode` prop；Lattice 有 `reducedMotion` prop；远程窗口也支持。
- **已知热点**（代码反推）：`currentLineIndex` 有 51 个消费方，行切换会触发一批组件更新；逐词 DOM + blur/发光在低端机是主要开销；`measureWordWidth` 在字体切换/缩放时会重算。

### 4.6 与可视化器/舞台的边界

- 共享契约在 `src/components/visualizer/definition.ts`：`VisualizerSharedProps`（`:35-46` 起）包含 `lines`、`currentTime: MotionValue<number>`、`currentLineIndex`、`subtitleContentMode`、`onLyricLineSeek`、`staticMode` 等；样式**不要在 mode 组件里重声明 props**（README 要求）。
- 行选择辅助集中在 `visualizer/runtime.ts`（`:35/:76/:90/:107`），新样式禁止自己重扫 `lines`。
- 字幕字号唯一来源 `subtitleFontSizes.ts`；混音交接样式通过 `VisualizerSongHandoff`（`definition.ts:139`）拿「下一首」的 lines/currentTime。
- 歌词引擎对可视化器的契约只有一句话：**给我 `lines` + 两个 MotionValue + 当前行索引 + offset 语义**，其余（布局/动画/主题）不归歌词层管。

---
## 5. 歌词来源与缓存

### 5.1 本地文件扫描与侧车配对（`src/services/localMusicService.ts`）

- **扩展名**：主歌词 `LYRIC_EXTENSIONS = /\.(lrc|vtt|ttml|qrc|yrc|krc|fia)$/i`（`:94`）；翻译侧车 `TRANSLATION_LYRIC_EXTENSIONS = /\.t\.(lrc|vtt)$/i`（`:95`）。
- **文件归类**：`getSnapshotFileKind(name)` 返回 `'translationLyric' | 'lyric' | 'cover' | 'audio' | 'other'`（`:348-364`）。
- **侧车命名兼容**：`getSidecarLyricBasePath(relativePath, 'lyric'|'translationLyric')`（`:307-313`）先剥 `.t.lrc/.t.vtt` 再剥扩展，因此同时支持 `track.lrc` 与 `track.mp3.lrc` 两种命名；同一 base 下的不同音频（`Track.mp3` / `Track.flac`）共享同一套侧车。
- **同 base 多格式谁是赢家**：按 `getLocalLyricFilePriority`（`localLyricFormatOrder.ts`）取优先级最小者，主歌词与翻译侧车各取一次 winner：`.fia` = -1（`localLyricFormatOrder.ts:40`，Folia 自有导出最优先），其后 `lrc > vtt > ttml > qrc > yrc > krc`（`:6/:10`）。
- **变化检测**：目录快照的 file signature = `` `${relativePath}::${size}::${lastModified}` ``；`collectImportDiffPlan` 对比旧快照得到 `changedAudioPaths / changedLyricBasePaths / lyricFileChangedBasePaths / changedCoverFolders`，再用 `audioPathsByBasePath`、`audioPathsByFolder` 索引反查曲目。
- **一条重要产品规则**：只有**磁盘上真变过的侧车**才允许替换用户手动上传的歌词；「仅仅因为用户改了格式优先级导致重扫选中了另一个文件」不算变化（`localMusicService.ts:616-620` 注释）。这是「用户数据优先于自动发现」的典型策略。
- 扫描产物是 `lrcMap`（baseName → {file, format}）与 `tlrcMap`；音频无变化且 `embeddedMetadataVersion` 未变时直接复用旧 song（`reusedSongs`），避免全库重解析。

### 5.2 内嵌歌词

音频标签里的 USLT 由主进程 sidecar 读取后以 `RawEmbeddedLyric.usltTags` 形式传入；`EmbeddedLyricAdapter` 用 `normalizeEmbeddedUsltTags` 归一（多语言 USLT 取主），并同样识别 AWLRC 容器。内嵌歌词优先级低于同名侧车文件（侧车在本地扫描层就赢了），具体排序由 `selectLocalSongLyricsSource` 统一决策。

### 5.3 Navidrome

- 两段式：**先本地缓存**（song 上的 `cachedStructuredLyrics` / `cachedPlainLyrics`），**再按需拉取**。
- `resolvePreferredNavidromeLyrics(navidromeSong)`（`src/utils/appNavidromeLyrics.ts:14`）：数组型 structuredLyrics 先过滤空 `value`；选主轨 + translation 轨；**关键规则**：若主轨是「非增强结构化歌词」，优先 `plainLyrics`（`:18` 的 `shouldPreferPlainLyrics`），因为非增强的结构化歌词往往只是把纯文本塞进结构化外壳，纯文本质量更稳；最后才回退已解析的结构化结果。
- `hydrateNavidromeLyricPayload(config, song)`（`:57`）：需要时调 `navidromeApi.getLyricsBySongId` / `getLyrics(artist,name)` 拉取，写回 song 缓存字段；失败 `console.warn('[App] Failed to fetch Navidrome lyrics:', e)`，不阻塞播放。
- OpenSubsonic `songLyrics` v2 的 cue 级词轴由 `parseNavidromeStructuredLyricsCollection` 处理（`adapters/NavidromeLyricAdapter.ts:15-74` 段）。

### 5.4 在线来源（provider 细节）

| 源 | 取词方式 | 关键证据 |
| --- | --- | --- |
| 网易云 | `/lyric/new?id=<id>`（新接口）、`/cloud/lyric/get?uid=&sid=`（云盘）；响应同时含 `lrc/yrc/tlyric/ytlrc/romalrc/yromalrc` 任一即视为歌词 | `services/onlineMusic/netease/netease.ts:687-709`、`:915`、`:923` |
| QQ | `POST https://u.y.qq.com/cgi-bin/musicu.fcg`，固定 `comm`（`ct:11, cv:'1003006', tmeAppID:'qqmusiclight', udid:'0', uid:'0'` 等）、`Cookie: tmeLoginType=-1;`、`User-Agent: okhttp/3.14.9`；返回 QRC 需解密 | `services/onlineMusic/qq/qqLyricProvider.ts`（221 行，`requestQQ` 段） |
| 酷狗 | 搜索 → 下载；`hasKrcHeader` 判 `krc1` 魔数；`contentType==='2'` 或无魔数 → 当纯文本；否则 `krcDecrypt`；解密失败但文本「像时间轴歌词」时降级用明文并 `console.warn('[Kugou] KRC decrypt failed; using plain lyric fallback:', error)` | `services/onlineMusic/kugou/kugouLyricProvider.ts`（377 行，`decodeKugouDownloadedLyric` 段） |
| AMLL DB | 额外源：按平台 + 歌曲 id 拉 TTML（QQ 先 `qqMid` 后数字 id，约 2:1）；响应 `song.lyrics` 必须是 `/<tt(?:\s|>)/i`；解析走 `parseLyricsByFormat('ttml', …)` | `utils/lyrics/providers/amllDbProvider.ts:14`（缓存 200 条）、`:28`、`:46` |
| Spotify | `linesOnly: true` 兜底源：只有别的源都没给出行时才问，且只提供行级 | `utils/lyrics/lyricSources.ts:38`（`linesOnly` 字段） |

远程/移动端的「NowPlaying」模式把歌词时钟交给外部播放器（5.7 的锚点时钟），歌词来源可以是同一套 provider。

### 5.5 代理与网络出口

`src/services/lyricProxy.ts`（36 行）是渲染进程「唯一知道转发热地址」的地方：

- Web/远程：`lyricProxyWebUrl(target) = /api/lyric-proxy?url=<encoded>`（`:19`）；
- Electron：`requestLyricProxyOnDesktop(...)` 通过 `window.electron.fetchLyricProxy`（IPC `'lyric-proxy-fetch'`，`preload.cjs:146`）转发；**没有桥时直接返回 `null`，不会偷偷发请求**（`:22` 段）。
- 服务端三种形态共享同一份白名单逻辑：`api/lyric-proxy.js`（Vercel，由 `api-ts/lyric-proxy.ts` 生成）、`worker/lyric-proxy.ts`（Cloudflare Worker）、`electron/main.cjs` 的 `proxyLyricRequest`。白名单只放行 `qq.com`（含子域）/`y.gtimg.cn`/`kugou.com`（含子域）；转发时忽略 `host/connection/origin/referer/cookie/authorization` 等头；CORS 放行 `KG-Rec/KG-RC/KG-CLIENTTIMEMS/mid/x-router` 等自定义头。
- 设计要点：**歌词解析在渲染进程，网络在服务端/主进程**；渲染进程永远不直连第三方（既绕 CORS 又避免拿用户 IP/凭据直连）。

### 5.6 缓存

`src/services/repositories/cacheRepository.ts`：

- 逻辑分类 `CacheCategory = 'playlist'|'lyrics'|'cover'|'media'|'analysis'`（`:21`）；物理表 `CacheTableName = 'api_cache'|'user_cache'|'media_cache'|'metadata_cache'`（`:21` 相邻行）。
- 路由 `getCacheTableName`：`key.startsWith('lyric_')` → `'metadata_cache'`（`:38`）；`audio_/cover_` → `media_cache`；`USER_CACHE_KEYS` → `user_cache`；其余 `api_cache`。
- **读放大实测**（作者注释，`:96-100`）：歌词导出要读**所有** `lyric_` 行；成熟安装 536 行 / 17.9 MB，一次 `bulkGet` 冻结页面 58ms，改成分 50 条一批后 7–11ms/批——所以 `readCacheEntriesByKey` 先按主键过滤、再按 `ROWS_PER_READ=50` 分批、批间 `setTimeout(0)` 让出事件循环（`:110-112`）。
- 键约定：`lyric_<songKey>`（provider 返回的歌词）、`lyric_<songKey>_state`（用户导入/覆盖/在线来源状态）、`lyric_<songKey>_meta`（显示名与平台歌曲 id）；分词缓存故意用 `lyricSeg_` 前缀避开 `lyric_` 整类清扫（`lyricSegmentation.ts:16` 注释）。
- 状态合成：`resolveOnlineLyrics(state, fallback)`（`utils/onlineLyricsState.ts:39`）：空 state → fallback；`lyricsSource==='imported'` 且有导入 → 用导入；有在线覆盖 → 用覆盖（可为 `null`，表示「用户标记为纯音乐/无歌词」）；否则 fallback。`resolveOnlineLyricsPureMusic`（`:63`）优先信 `matchedIsPureMusic` 布尔值，否则读文本判定。
- 反序列化时对旧数据做 `migrateLyricDataRenderHints`（派生提示升级），因此**缓存可以跨版本演进**。

### 5.7 匹配、去重与失败回退

- **自动选词**（`autoMatchBestLyric.ts`，449 行）：按源表顺序并发搜索（每源超时 3500ms），取候选 → 计算匹配分（标题/艺术家/专辑/时长加权；繁体转简体、假名转罗马字后比较）→ 候选必须 `titleMatched && (artistMatched || albumMatched)`（`:135`）→ 低于 `AUTO_MATCH_MIN_SCORE=75` 丢弃；任一组件不匹配总分封顶 74（`matchScore.ts:17`）→ 取最高分并下载歌词（超时 5000ms）。
- **版本标记惩罚**：标题含 `instrumental|inst|off vocal|karaoke|remix|live|cover|伴奏|カラオケ…` 等（`matchScore.ts:19` 的 `versionMarkerPattern`）会降低匹配分，避免把伴奏版匹配到人声版。
- **调用点**（6 处）：库播放控制器 `useLibraryPlaybackController.ts:872/1393/1444/1494`、本地库扫描 `localMusicService.ts:1357`、在线播放 `onlinePlayback.ts:292`、预取 `prefetchService.ts:332`。**预取也匹配歌词**，所以「按下一首时歌词已就绪」。
- **去重**：翻译匹配的一次性贪心（2.3.5）；AMLL DB 同 id 多次请求复用进程内 Promise 缓存（200 条上限），并发去重靠 `Promise` 共享而不是结果去重。
- **失败回退**：源失败/超时 → 试下一个源；所有源失败 → `null` → 渲染「暂无歌词」；纯音乐 → 显示纯音乐态；代理失败 → `null`（不重试）；KRC 解密失败 → 明文兜底或上抛。

### 5.8 导出（`src/services/lyricExport/`，10 文件 972 行）

- **入口** `runLyricExport(options, localLyricsPriority, context)`（`runLyricExport.ts:25`）：collect（online → local）→ `resolveExportMetadata`（起名，可能补齐平台 id）→ `mapWithConcurrency(ADJUST_CONCURRENCY=8)` 应用用户调整（`:19`）→ `buildLyricExportArchive`；带 `AbortSignal` 与 `onProgress` 分阶段上报（`:53/:66`）。
- **收集规则**：`collectOnlineLyrics` 从 `lyric_` 前缀缓存反查有效歌词（含 `_state` 覆盖、`_meta` 元数据；`:21-26`/`:38`/`:54`）；`collectLocalLyrics` **只导出「本地库里由在线匹配得到」的歌词**（`:24-35` 注释：侧车/内嵌歌词本就在磁盘上，再导出只会与现有 `.lrc` 冲突），路径 = 库内相对路径去扩展名。
- **用户调整**（`applyUserAdjustments.ts:14-23`）：分段（wordSegments）**烘焙进模型**；offset **只记录元数据不位移时间轴**（理由：位移会让「别人手里的同版本音频」错位）。
- **格式**：`.fia`（`serializeFoliaLyricDocument`）与 `.lrc`（`serializeEnhancedLrc`）两种（`types.ts` 的 `LyricExportFormat='fia'|'lrc'`）；生成名：本地歌用音频文件名，在线歌用 `标题 - 艺术家`（缺失用 songKey，`:` 替换为 `_`），`MAX_BASE_NAME_LENGTH=80`（按 255 字节、CJK 3 字节算，`lyricExportFiles.ts:30`）。
- **打包**：大小写不敏感的 `createUniqueNameAllocator`（重名加 ` (2)` 后缀，`buildLyricExportArchive.ts:21` 段）；每个 format 一个文件夹（`local/` 镜像库相对目录、`online/` 平铺，`lyricExportFiles.ts:75`）；zip level 6（fflate）；根 `manifest.json` 版本 `1`（`buildLyricExportArchive.ts:18`），记录 `exported/skipped/renamedFrom`。
- **`.fia` 信封**（`foliaLyricDocument.ts`）：`format:'folia-lyricdata'`（`:13`）、`version:1`（`:14`）、扩展名 `fia`（`:15`）、`exportedAt`、`song{key,title,artist,album,durationMs?}`、`source?:'online'|'imported'|'local'|'embedded'|'navidrome'`、`offsetMs?`（仅元数据）、`lyrics: LyricData`；构建时剥掉 `renderHints` 与 `autoWordSegments`（派生数据）但保留用户 `wordSegments`（`:66` 段）；序列化 `JSON.stringify(doc, null, 2) + '\n'`（`:84`）。导入侧 `parseFoliaLyricDocument` 校验 format（`:164/:173`）。

### 5.9 对外 HTTP 歌词 API（Electron 主进程）

- **实现**：`electron/lyricApi.cjs`（201 行）。`createLyricApi({store,getMainWindow,enabledSettingKey,port})`；`http.createServer`（`:146`）监听 `127.0.0.1:<port>`。
- **默认端口** `32109`（`main.cjs:2267`），开关设置键 `'LYRIC_API_ENABLED'`（`main.cjs:2249`），**默认关闭**（`main.cjs:2383` 读默认 false），装配在 `main.cjs:2474`，模块 require 在 `main.cjs:62`。
- **路由**：只有 `GET /v1/lyric`（`:129`）；路径不匹配 404，方法不匹配 405 且带 `Allow: GET, OPTIONS`；支持 `OPTIONS` 预检。响应头 `Access-Control-Allow-Origin: '*'`（`:110`）、`Cache-Control: no-store`、`Content-Type: application/json; charset=utf-8`、`X-Content-Type-Options: nosniff`。
- **返回形状**：`sanitizeLyricData(lyrics, offset=0)`（`:45`）把内部模型压成稳定 API：

```ts
// electron/lyricApi.cjs:45 段（字段名按代码）
{
  offset,                       // 毫秒
  lines: [{
    text, startTime, endTime,   // text = line.fullText，秒
    words: [{ text, startTime, endTime }],
    translation?, romanization?,
    backgroundVocals?: [{ text, startTime, endTime, words, translation?, romanization? }],
  }],
  wordByWord, title?, artist?
}
```

出口清洗的细节：`copyTime` 把非有限数归 0；空字符串字段省略；`backgroundVocals` 兼容旧的单数 `backgroundVocal`；`renderHints/ttml/agent/id/chunks` 等内部字段**全部剥掉**——API 是稳定契约，不是内部模型序列化。
- **状态**：内部 `currentLyrics` 由 `publishLyricData` 覆盖（`:183`）；`setEnabled` 启停（`:177`）；listen 失败只记 `lastError`（`:91`/`:159`）不抛；成功日志 `[Lyric API] Listening on …`（`:156`）；状态变化经 `webContents.send('lyric-api-status-changed', buildStatus())` 广播。
- **渲染侧**：`useLyricApiPublisher`（`src/hooks/useLyricApiPublisher.ts`）挂载时 `refreshStatus`（无 Electron 时返回 `emptyStatus{port:32109}`），effect 依赖 `[lyrics, offset, status.enabled]` 时调 `publishLyricApiData(lyrics, offset)`；`getLyricApiStatus / setLyricApiEnabled / publishLyricApiData / onLyricApiStatusChanged` 的 IPC 在 `preload.cjs:208-214`。
- **文档吻合度**：`docs/lyric-api.md`（329 行）与代码一致的点：固定端口 32109（`:14`）、无鉴权、CORS `*`（`:18`）、行/词秒 + offset 毫秒（`:103`）、正值=歌词延后（`:109`）、客户端用「播放时间 - offset/1000」（`:320`）、204/404/405 状态码、只在歌曲/歌词源/offset 变化时更新（`:275` 段）。**文档没写但代码存在的**：`X-Content-Type-Options: nosniff`、`Content-Length`、`lastError` 状态字段、`backgroundVocals` 双字段兼容。
- **安全评价**：本机回环 + 无鉴权 + CORS 全开 = 局域网内其它页面（用户浏览器）可读当前歌词。Folia 的取舍是「OBS/直播叠加层易用性优先」；Zilux2 若做同样能力，建议至少加 token 或 `Origin` 校验。

### 5.10 其它歌词相关 Electron/IPC 能力

- `generateTheme`（`preload.cjs:143`）、`segmentLyrics`（`:144`）两个 IPC；分词走服务端 AI 端点 `api/segment-lyrics.js`（Vercel Edge，POST，`shared/lyricSegmentationService.mjs` 内部分支到具体模型），客户端 `lyricSegmentationAi.ts`：`SEGMENTATION_BATCH_SIZE=100`（`:28`）、`buildLyricSegmentationPrompt`（`:31`）、`assertBoundaries`（`:39`，校验 AI 返回的分段边界）、`segmentLyricsWithAi`（`:79`，带进度 `SegmentationProgress`）。
- 分词缓存与歌词缓存分表键（`lyricSeg_` vs `lyric_`），避免导出/清扫误伤。

---

## 6. 测试与基准

### 6.1 测试布局

- 配置：`vitest.config.ts:30` include `test/unit/**/*.test.ts`；`package.json:31` `"test": "vitest run -c vitest.config.ts"`。
- **歌词相关单测 60+**：`test/unit/lyrics/` 下覆盖解析器（每格式）、适配器、worker、解码（编码/KRC）、格式嗅探、翻译匹配、分词、匹配评分、来源选择、offset 记忆、纯音乐、制作名单、chorus、`.fia` 文档、Navidrome、AMLL DB 等；另有 `test/unit/lyricExport/*`、`test/unit/electron/lyricApi.test.ts`、`test/unit/stores/globalLyricTimelineOffset.test.ts`、`test/unit/lattice/latticeLyric*.test.ts`、`test/unit/remote/remoteLyric*.test.ts`、`test/unit/visualizer/lumiere/lumiereLyricWindow.test.ts`、`test/component/globalLyricOffsetRuler.spec.ts`。
- 手工/UI 测试：`test/manual/`、`test/ui/`（非 CI 主路径）。

### 6.2 `npm run benchmark:lyrics`（`test/manual/lyrics_benchmark.ts`）

- 脚本声明在 `package.json:38`；fixture 目录 `test/test-song/test-lyric`（脚本内 `:30` 附近 `path.join(repoRoot,'test','test-song','test-lyric')`）。
- 用例（约 `:101-134`）：`real.normal-lrc` ×400、`real.line-level-combined` ×300、`real.bracket-enhanced-combined` ×250、`real.angle-enhanced-combined` ×250、`synthetic.lrc-with-translation-5000` ×40（5000 行压力用例）。
- 统计方法（`:42-60`）：先 **25 次预热**，再逐次计时，输出 mean/p95/min/max/total；结果为「解析 + 后处理」的端到端耗时，不含渲染。
- **观察（重要）**：本 tarball 中 `test/test-song/test-lyric` 目录**不存在**（`find test -name '*.lrc'` 只找到 `test/manual/stage-client/fixtures/*.lrc`）。因此该基准在当前 tarball 上大概率**无法直接运行**；发布包里 fixture 可能被剔除或另行分发（**待确认**）。同时它不在 CI 的 `test` 脚本里——性能回归没有自动守护。

### 6.3 手工审计工具（`npm run audit:lyrics-sources`）

- `test/manual/lyric-audit/index.ts`：CLI，`DEFAULT_SONG_ID='488642006'`（`:8`），支持 `--out <path>`、`-h`；主流程 `runLyricSourceOffsetAudit` + `runPlot`。
- `lyric_source_offset_audit.ts`：对同一首歌并发抓网易云/QQ/酷狗候选，记录 `SourceAudit`（源、候选评分、歌词统计 firstLineStartSec/lastLineEndSec/timelineSpanSec）与 `PairwiseOffsetAudit`（matchedKeys、startDeltaSec、endDeltaSec、driftSec）、`OffsetStats`（mean/median/p95Abs/min/max/absMean/first/last），以及「整体时长校准」`durationCalibration`。用途：**量化不同源之间时间轴的系统性偏差**，为「跨源歌词能不能混用」提供数据。
- `lyric_duration_diff_plot.ts`：把审计 JSON 渲染成终端 Markdown 差异表 + 交互式 ECharts HTML 仪表盘（逐行比较 netease/qq 的 start/end/diff）。
- `test/manual/parser_test.ts`：最小手工 harness——用固定 LRC/YRC 字符串跑 `parseLRC`/`parseYRC`/`detectChorusLines`，打印行区间与间奏行每个点的区间，验证「`......` 间奏逐点时长」（`:1-3` 的 import 揭示 `@/utils/lrcParser`、`@/utils/yrcParser` 只是薄包装，真实现都在 `parserCore.ts`）。
- 其它手工工具：`test/manual/netease_lyrics_cli.ts`（`package.json:39` manual:lyrics）、`kugou_test.ts`、`qq-diag/`。

### 6.4 测试覆盖的缺口与风险观察

1. **基准不入 CI**（6.2），fixture 缺失（待确认）。
2. **渲染层没有性能测试**：`currentLineIndex` 51 个消费方的行切换成本没有基准。
3. **TTML 生产日志未清**（2.3.6），说明该路径缺少「干净输出」的断言。
4. **注入式注释污染 29 个文件**（见 8.3），静态检查/审查流程没有拦截这类内容。
5. **对外 HTTP API 的测试**集中在 `test/unit/electron/lyricApi.test.ts`，但「无鉴权 + CORS *」的安全属性没有测试表达（它是有意设计而非漏洞，但应显式记录）。
6. 跨源时间轴审计是**手工工具**，没有变成数据驱动的回归基线；Zilux2 可以把它产品化为「解析器回归语料库」。

---
## 7. 可复用到 Zilux2 的清单

> 现实约束（来自 前端侧，2026-10-18）：Zilux v1 是 C#/.NET 10/WPF 应用，已有自研 LRC/QRC/KRC/YRC 解析、本地缓存、QQ/网易云/酷狗三源；进度走 **Windows GSMTC**；任务栏歌词条带/扇形浮层是 WPF 原生；桌面歌词壁纸是 **WebView2 + 自研 HTML/JS（JIZURA）**，通过 JS↔C# bridge 交换歌词/进度/样式；频谱走 WASAPI loopback。Zilux2 大概率延续「C#/WPF 宿主 + WebView2 前端页面」形态。因此迁移的关键不是「把 Folia 的 TS 搬过来」，而是**把 Folia 的分层和契约翻译成宿主/前端两个进程的职责划分**。

### 7.1 职责边界：谁拥有什么（核心决策）

| 能力 | 归属 | 理由（来自 Folia 的教训） |
| --- | --- | --- |
| 取源、网络、代理 | **C# 宿主** | Folia 用 Electron 代理是因为渲染进程受 CORS 限制；WPF 宿主自带 HTTP 客户端，代理层可整体删除（只保留 host 白名单校验） |
| 解码/解析/校验 | **C# 宿主** | 单一生产者。Folia 把解析放 Worker 是为了不卡 UI；C# 里放后台线程同理，但**绝不能让 Web 端再解析一遍**，否则 .fia 导入、offset、缓存会出现两套真相 |
| 缓存（歌词/状态/meta） | **C# 宿主**（SQLite 或现有缓存） | Web 端无持久化职责；Folia 的 `lyric_/_state/_meta/lyricSeg_` 键设计可直接作为表结构参照 |
| canonical 模型 | **C# 宿主**（权威） | Web 端只持有「只读投影」 |
| 线路契约（JSON） | **两边共享** | 版本化 `schema` 字段；宿主每次歌曲/歌词/offset/时钟变化推送增量 |
| GSMTC 时钟权威 | **C# 宿主** | 只有宿主能拿到 Session/PlaybackInfo/TimelineProperties；Web 端只做帧间外推 |
| 行索引/渲染模型 | **Web 端** | 纯函数、便宜、可热更新样式；不涉及数据真相 |
| 渲染 | **Web 端**（壁纸/浮层）+ **WPF 原生**（任务栏条带） | 条带走原生避免 WebView2 进程开销；壁纸走 Web 复用渲染生态 |
| 用户 offset 持久化 | **C# 宿主** | Folia 存 localStorage 是因为 Electron 主进程不管；宿主侧存配置文件更好迁移 |
| 导出 | **C# 宿主** | zip/.fia 生成在宿主侧更稳 |
| 对外 HTTP API | 可选，**C# 宿主** | 若 Zilux2 也要 OBS 叠加层，直接宿主起 `HttpListener`，比 Electron 版更简单 |

**一句话**：Folia 是「渲染进程内一条五层流水线」，Zilux2 应拆成「宿主跑 L0–L4 的 L0–L3 + Web 跑渲染适配」——把 L4 的**显示决策**（纯音乐/过滤/制作名单/分词）留在宿主，因为它是数据语义；Web 端只保留「渲染提示的解释」。

### 7.2 线路契约草案（TypeScript，供 WebView2 页面使用；非 Folia 代码）

```ts
// zilux.lyrics wire contract v1 —— 建议线路统一用「整数毫秒」，渲染侧再除 1000
type Ms = number;

interface LyricDocumentV1 {
    schema: 'zilux.lyrics/1';
    songKey: string;  title?: string;  artist?: string;
    offsetMs: Ms;                 // 仅元数据；时间轴不平移
    isWordByWord: boolean;
    flags: { isPureMusic: boolean; hasTranslation: boolean; hasRomanization: boolean };
    agents?: Array<{ id: string; name?: string }>;
    lines: LyricLine[];
}
interface LyricLine {
    start: Ms; end: Ms; renderEnd: Ms;      // renderEnd = 行余辉结束（Folia renderHints.renderEndTime 的等价物）
    text: string;
    words: LyricWord[];                     // 行级来源也必须给（均摊值），保证渲染器只有一条路径
    translation?: string; romanization?: string;
    agentId?: string; part?: string;
    chorus?: 'bars' | 'circles' | 'beams';
    backgroundVocals?: LyricWordGroup[];
}
interface LyricWord { start: Ms; end: Ms; text: string }
interface LyricWordGroup { start: Ms; end: Ms; words: LyricWord[]; translation?: string }

// 时钟快照：宿主推、Web 外推
interface ClockSnapshot {
    sequence: number;
    positionMs: Ms;          // 快照时刻的播放位置
    atMonotonicMs: number;   // 宿主单调时钟（Stopwatch），用于 Web 计算 elapsed
    rate: number;            // 1.0 正常
    playing: boolean;
    durationMs: Ms;
    source: 'gsmtc' | 'local' | 'stage';
}
```

**单位决策**：Folia 全链路秒（float），唯一 offset 用毫秒。跨 C#/JS 线路我建议**统一整数毫秒**：JSON number 在两端的整数语义一致、无浮点显示误差、便于相等比较；渲染数学（进度百分比、逐词插值）在 TS 侧一次 `/1000` 即可。这与 Folia 不必一致——它没有跨语言边界。

### 7.3 五层拆解：可独立重写 vs 平台绑定

| 层 | Zilux2 处理 | 复杂度 | 备注 |
| --- | --- | --- | --- |
| L0 来源 | **宿主重写**：复用 v1 三源 + 内嵌标签 + Navidrome；AMLL DB 可选 | S/M | 平台耦合在 provider 协议（QQ/酷狗签名）与凭据；与 Folia 无关 |
| L1 解码 | **宿主重写**：BOM→严格 UTF-8→GB18030→宽容 UTF-8；KRC 魔数 + 解密（按格式规范独立实现，**不要抄**）；换行归一 | S | 中文歌词最大坑是 GBK；Folia 的四段阶梯值得照做 |
| L2 解析 | **宿主重写，但语义照搬（思想层面）**：时间戳小数语义、LRC 时长推断、逐字均摊权重、翻译 ±1s 贪心匹配、间奏注入、`isWordByWord` | M/L | 这是最值得「对标行为」的一层；建议先写行为规格（本报告 2.3）再用 C# 实现 + 语料回归 |
| L3 模型 | **宿主 canonical C# 模型 + JSON 投影**；TS 侧镜像（7.2）；renderHints 用纯函数在宿主算好随文档下发 | S/M | Folia 的 `renderHints` 派生数据思路直接可用；`.fia` 信封可借鉴（版本号 + 剥派生字段） |
| L4 展示加工 | **宿主执行**：纯音乐/过滤/制作名单/合唱段；分词看现状（v1 若无可先不做逐词细分） | S/M | 制作名单关键词表要独立重写（语言相关）；不要复制 Folia 的常量表 |
| 渲染 | **Web 重写**（壁纸/浮层）+ WPF 原生（条带） | M/L | 第 4 节机制可参考，DOM/CSS 实现必须自己写 |
| 平台绑定项 | Electron IPC/Worker/`api/` 代理/IndexedDB 缓存/`localStorage` offset——**全部不复用** | — | 换成宿主 HTTP/后台线程/SQLite/配置文件 |

**结论**：五层里 **L2 的算法行为最值得学，L3 的模型/派生数据纪律最值得学，L0/L1/L4 按 Zilux 现状改造，渲染层只学原理**。Electron 专有部分（代理、Worker 协议、HTTP API 实现、Dexie/IndexedDB、localStorage LRU）不可移植，也不应移植。

### 7.4 逐字时间轴 × GSMTC 进度：对齐与时钟同步方案

**问题**：逐字时间轴的精度是 10–50ms 级，而 GSMTC 的 `TimelineProperties.Position` 上报精度通常是**秒级**、且更新是事件驱动（可能几秒一次）。直接拿 GSMTC 位置查词会「一跳一跳」。

**方案（把 Folia 的锚点时钟思路搬到宿主）**：

1. **宿主维护权威时钟**：收到 GSMTC 位置/状态/时长时构造 `ClockSnapshot{positionMs, atMonotonicMs(Stopwatch), rate, playing, durationMs}`；事件驱动为主、轮询（1–2s）兜底、seek/pause/track 变化立即刷新。
2. **Web 外推**：`position(t) = playing ? clamp(snapshot.positionMs + (monotonicNow - snapshot.atMonotonicMs) * rate, 0, durationMs) : snapshot.positionMs`；单调时钟用 `performance.now()`，**禁止用 `Date.now()`（可被校时跳变）**。
3. **修正策略**（对标 Folia 的 0.2s 阈值 + 远端锚点）：
   - 会话/歌曲/seek/暂停 → **硬同步**（`sequence` 变化即重置，无条件接受）；
   - 普通位置更新 → 若 `|外推 - 新位置| > 250ms` 硬跳；否则**软纠正**（每帧向新值 lerp 5–15%，避免可见跳变）；
   - 暂停时冻结位置，恢复时重建锚点。
4. **延迟补偿**：GSMTC 位置相对真实出声有缓冲延迟（且因设备而异）。建议**两个独立旋钮**：`用户歌词偏移`（内容错位，持久化，Folia 的 offset 语义）与 `输出延迟校准`（设备常数，如 WASAPI 报告的 buffer，可用 loopback 实测）。**不要把两者合并**——Folia 只有一个 offset，是因为它是纯软件播放器；Zilux2 面对的是系统级会话。
5. **没有逐字进度也能逐字高亮**：词时间戳来自歌词本身，`lyricTime` 一旦准确，词级状态机就是纯函数（Folia 的 `GlowWord` 状态机即如此）。不要尝试用 GSMTC 的帧间差分去「推算」词进度——那只会放大 jitter。
6. **边界情况清单**：会话切换（别的 App 抢走 SMTC）、同一 App 换曲、暂停/恢复、拖动进度条、播放速率变化、`Position > EndTime` 的脏数据（clamp）、应用崩溃后 `LastUpdatedTime` 过期（用单调时钟，不信任 wall clock）、歌词时长为 0/缺失。
7. **推送频率**：契约快照 5–10Hz 足够（外推在 Web 端做）；**不要每帧 IPC**。若走 JSON `postMessage`，单帧 <1KB，10Hz 开销可忽略。

### 7.5 两种渲染目标的性能约束

| 维度 | 任务栏条带/扇形浮层（小窗） | 全屏壁纸（WebView2） |
| --- | --- | --- |
| 渲染器 | **优先 WPF 原生**（D3D 合成，省一个 WebView2 进程）；若用 WebView2，限制 DOM 节点 | Canvas 2D 或 WebGL，单画布 |
| 目标帧率 | 10–30fps 即可（人眼对条带关注低） | 30–60fps，rAF 驱动 |
| 歌词粒度 | 行级或「当前词高亮」粗粒度；不做逐词飞入/粒子 | 全逐词动画、发光、粒子、镜头 |
| 禁止项 | blur 大层、阴影链、每帧 `measureText`、动态字体加载、WebGL | 每帧 DOM 重建、无上限 DPR、隐藏时仍渲染 |
| 指标 | CPU < 1–2%、内存 < 50MB、IPC 快照 5Hz | GPU 帧时间 < 16ms、隐藏/被遮挡时暂停、电池模式降级 |
| 关键技巧 | 布局预计算；变化只在行切换/词切换；文本宽度缓存（font+text → width）；固定字号 | 字形图集/离屏 canvas；对象池；`visibilitychange`/遮挡检测暂停；`prefers-reduced-motion`/设置项；DPR 上限 1.5 |
| 契约复用 | 同一 `LyricDocumentV1` + `ClockSnapshot`，只是渲染适配器不同 | 同左 |

**共同不变量**：单一时钟源（宿主）；Web 只外推不修正；DOM/绘制只在「视觉变化」时发生；所有文本测量与布局在行激活时一次完成；暂停/无歌词/纯音乐有明确降级态。

### 7.6 建议模块与复杂度（宿主 C# + Web TS）

| 模块 | 层 | 复杂度 | 验收标准 |
| --- | --- | --- | --- |
| `LyricSourceHub`（多源+优先级+超时） | L0 | S | 三源+内嵌+本地都可注入；单源失败不影响其它 |
| `LyricDecoding`（编码阶梯+KRC） | L1 | S | GBK/UTF-8/KRC 语料全绿 |
| `LyricParserRegistry`（lrc/vtt/enhanced/qrc/yrc/krc/ttml） | L2 | M | 每格式单测 + 跨源时间轴审计 |
| `LyricTimelineBuilder`（间奏/翻译匹配/逐字均摊） | L2→L3 | M | 与 Folia 行为对照用例（自己写的 fixture） |
| `LyricDocument`（canonical + JSON 投影 + 版本） | L3 | S | schema 校验；派生字段可重算 |
| `LyricClock`（GSMTC 锚点 + 外推 + 修正策略） | 时钟 | M | 暂停/seek/切曲 200ms 内收敛；无可见跳变 |
| `TimelineIndex`（Web 端行/词查找） | Web | S | 行数 200 时 O(log n) 或 O(n) 均可，帧预算 < 0.1ms |
| `RendererAdapter`（条带/浮层/壁纸三种） | Web/WPF | M each | 各自性能预算达标 |
| `LyricCache`（歌词/状态/meta，SQLite） | 宿主 | S | 断网重启后播放秒开 |
| `LyricExport`（.fia 等价信封 + zip） | 宿主 | S | 往返导入无损（除派生字段） |
| `LyricHttpApi`（可选） | 宿主 | S | 本机 + token；文档与实现一致 |

复杂度口径：S ≈ 300 行以内、M ≈ 300–800 行、L ≈ 800 行以上（含测试；不含 UI 样式）。

### 7.7 落地顺序（建议）

- **P0（1 周）**：定契约（7.2）+ 宿主时钟（7.4）+ Web 端最小渲染（当前行 + 逐词高亮粗版）。验收：GSMTC 播放/暂停/seek 时歌词不错位。
- **P1（1–2 周）**：把 v1 解析升级到本报告 2.3 的行为规格（时长推断、逐字均摊、翻译匹配、间奏）；建立自写语料库（每格式 + 跨源）。
- **P2（1 周）**：`.fia` 等价信封 + 缓存键设计 + 导出；保证「导出→导入」往返只丢派生数据。
- **P3（2 周）**：条带/浮层适配器（优先 WPF 原生）；性能预算测量与降级开关。
- **P4（2 周）**：全屏壁纸渲染器（Canvas/WebGL）+ reduced-motion/遮挡暂停；跨源审计工具产品化。
- 每阶段都要有「行为对照 fixture」，而不是对着 Folia 源码逐行翻译。

### 7.8 AGPL-3.0 合规红线（必须遵守）

1. **只学思想，不抄表达**。AGPL-3.0 的传染性覆盖「复制/修改/分发」；即使只把 Folia 的代码「翻译成 C#」也属于衍生作品。安全做法是**clean-room**：一侧读行为/规格（本报告），另一侧只看规格写实现，实现完成后用行为测试对照。
2. **禁止复制**：源码文本、注释、常量表（如制作名单关键词）、正则字面量、字符串文案、`.fia` 的字段命名若具独创性也应避免照抄（**建议重命名**，如 `LyricDocumentV1`）。
3. **不要 vendor** Folia 的文件/依赖（包括 `@applemusic-like-lyrics/ttml` 这类第三方库——它有自己的许可证，需单独评估，不能因为「Folia 用了」就引入）。
4. **文档与注释也受版权保护**：本报告已按「行为描述」重写；实现时不要回抄 Folia 的 JSDoc/注释。
5. **保留审计痕迹**：Zilux2 仓库里记录「参考了哪些公开项目的哪些行为」，但不引入其代码；如果未来确实要复用某段代码，唯一合规路径是接受 AGPL 并开源相应部分（对商业闭源不可行）。
6. 本报告中的代码摘录（≤40 行/处）仅用于审计说明，**不得进入 Zilux2 代码库**。

---

## 8. 关键文件索引与未解问题

### 8.1 高价值 file:line 索引（按主题）

| 主题 | 位置 | 内容 |
| --- | --- | --- |
| 模型 | `src/types.ts:6-92` | `LyricRuby/LyricSyllable/LyricAlternateText/Word/BackgroundVocal/Line/LyricData` |
| 模型 | `src/types.ts:83-92` | `LyricData`：lines/title/artist/isWordByWord/ttml |
| 模型 | `src/utils/lyrics/types.ts:49-99` | `RawLyricSource` 五来源联合类型 |
| 解析 | `src/utils/lyrics/parserCore.ts:59` | `buildTimedWords` 逐字均摊 |
| 解析 | `src/utils/lyrics/parserCore.ts:120-164` | 间奏注入（`'......'`，6 点） |
| 解析 | `src/utils/lyrics/parserCore.ts:185-248` | 翻译匹配：±1s 窗口 + 贪心稳定 + 二分下界 |
| 解析 | `src/utils/lyrics/parserCore.ts:250` | LRC 时间戳语义（小数=秒的小数） |
| 解析 | `src/utils/lyrics/parserCore.ts:429` | `parseLRC` 时长推断（5s 兜底 / len*0.5+2 上限） |
| 解析 | `src/utils/lyrics/parserCore.ts:490/571/954/1155` | YRC / QRC / KRC / AWLRC 解析器 |
| 解析 | `src/utils/lyrics/parserCore.ts:781/819/839` | VTT / TTML / 增强 LRC |
| 解析 | `src/utils/lyrics/parserCore.ts:1090` | AWLRC 时间戳「小数=整数毫秒」 |
| 解析 | `src/utils/lyrics/timelineSplitter.ts:10` | 组合时间轴拆分（主/译/罗） |
| 解析 | `src/utils/lyrics/formatDetection.ts:5-8` | VTT/增强 LRC/TTML 嗅探正则 |
| 解析 | `src/utils/lyrics/lyricFileDecoding.ts:15-34` | KRC 魔数 + BOM/UTF-8/GB18030 阶梯 |
| 渲染提示 | `src/utils/lyrics/renderHints.ts:33-35` | micro/short 阈值与最小渲染时长 |
| 渲染提示 | `src/utils/lyrics/renderHints.ts:48` | 转场时序 `getLineTransitionTiming` |
| 渲染提示 | `src/utils/lyrics/renderHints.ts:114/:208/:241` | `renderEndTime` / 注解 / 兜底 |
| 时钟 | `src/stores/motionSignals.ts:31-45` | `currentTime` / `lyricCurrentTime` / handoff 时钟 |
| 时钟 | `src/utils/appPlaybackHelpers.ts:21-32` | `findLatestActiveLineIndex` 反向线性扫描 |
| 时钟 | `src/components/app/playback/bridges/usePlaybackVisualizerBridge.ts:203-210` | 每帧主分支（audio.currentTime → offset → 行索引） |
| 时钟 | `src/components/app/playback/bridges/usePlaybackVisualizerBridge.ts:136-140` | 混音交接立即修正时钟 |
| 时钟 | `src/components/app/playback/bridges/incomingLyricClock.ts:8` | `readIncomingLyricClock` 公式 |
| 时钟 | `src/components/app/playback/bridges/useLyricReadHead.ts:60` | 切歌重置为 `-offset` |
| 时钟 | `src/utils/nowPlayingClock.ts:5-7` | 外部播放器时钟：URL/7s 轮询/0.2s 阈值 |
| 时钟 | `src/components/app/playback/useStagePlaybackController.ts:143-148` | 合成 stage 时钟结构 |
| offset | `src/utils/lyrics/lyricOffsetMemory.ts:15/:18/:67/:76` | 每首 offset：localStorage + 1000 LRU |
| offset | `src/stores/useLyricSettingsStore.ts:128` | 全局 offset 字段 |
| 展示加工 | `src/components/app/playback/createLyricsSetter.ts:67-110` | 纯音乐→过滤→制作名单→合唱→分词→transform |
| 展示加工 | `src/utils/lyrics/staffCreditsDecision.ts:9/:38` | `TAIL_MARGIN_SECONDS=1`、`requiredSeconds` 公式 |
| 展示加工 | `src/utils/lyrics/chorusEffects.ts:5/:7` | `bars/circles/beams` + 文本检测 |
| 来源 | `src/utils/lyrics/lyricSources.ts:38` | 源表（netease/amll/qq/kugou/spotify） |
| 来源 | `src/utils/lyrics/sourcePriority.ts:6/:9` | 默认偏好 qq + 回退顺序 |
| 来源 | `src/utils/lyrics/autoMatchBestLyric.ts:21-24/:135` | 超时 3.5s/5s、限 10 首、最低 75 分、可靠性判据 |
| 来源 | `src/utils/lyrics/matchScore.ts:17/:19` | 组件缺失封顶 74、版本标记惩罚 |
| 来源 | `src/utils/lyrics/providers/amllDbProvider.ts:14/:28/:46` | AMLL DB：200 条缓存、id 规则、TTML |
| 来源 | `src/services/localMusicService.ts:94-95/:307-313/:616-620` | 侧车扩展名/命名/「磁盘真变」规则 |
| 来源 | `src/utils/appNavidromeLyrics.ts:14/:18/:57` | Navidrome 选择与按需拉取 |
| 网络 | `src/services/lyricProxy.ts:19/:22` | Web/Electron 两种代理出口 |
| 缓存 | `src/services/repositories/cacheRepository.ts:21/:38/:96-100/:110-112` | 表路由、`lyric_`→metadata_cache、50 条分批 |
| 缓存 | `src/utils/onlineLyricsState.ts:39/:63` | 在线覆盖优先级、纯音乐状态 |
| 导出 | `src/services/lyricExport/runLyricExport.ts:19/:25` | 8 并发、collect→name→adjust→package |
| 导出 | `src/services/lyricExport/lyricExportFiles.ts:30/:75/:85` | 80 字符名、local/online 目录、fia/lrc 序列化 |
| 导出 | `src/services/lyricExport/buildLyricExportArchive.ts:18/:21` | manifest v1、大小写不敏感去重 |
| 导出 | `src/utils/lyrics/foliaLyricDocument.ts:13-15/:66/:164` | `.fia` 信封 v1、剥派生字段、导入校验 |
| API | `electron/lyricApi.cjs:45/:129/:146` | 出口模型、路由、HTTP server |
| API | `electron/main.cjs:2249/:2267/:2383/:2474` | 开关键/默认端口 32109/默认关/装配 |
| API | `electron/preload.cjs:208-214` | 歌词 API IPC 面 |
| API | `docs/lyric-api.md:103/:109/:320` | 单位/offset 语义/客户端公式 |
| 渲染 | `src/components/visualizer/classic/Visualizer.tsx:105/:127/:317/:332` | runtime→布局→AnimatePresence→词色 |
| 渲染 | `src/components/visualizer/GlowWord.tsx:52` | 词三态状态机 |
| 渲染 | `src/components/visualizer/glowWordTiming.ts:16/:35/:58` | 词渲染 profile/结束时间/行容器动效 |
| 渲染 | `src/components/visualizer/VisualizerSubtitleOverlay.tsx:22/:48` | upcoming blur 类、overlay 内容选择 |
| 渲染 | `src/components/visualizer/runtime.ts:35/:76/:90/:107` | 行选择/预热辅助（禁止样式自扫） |
| 渲染 | `src/components/visualizer/definition.ts:35-46/:139` | 共享 props 契约、handoff 契约 |
| 收尾 | `src/App.tsx:518/:1465/:1632/:2012-2026` | setter 装配、桥接线、API 发布、seek 换算 |

### 8.2 未解问题（需后续验证）

1. **「五层」无字面出处**：本报告的分层是代码调用链推导；如果团队内部有别的口径，需要对齐（不影响实现）。
2. **基准 fixture 缺失**：`test/test-song/test-lyric` 在本 tarball 不存在，`benchmark:lyrics` 大概率跑不起来；发布包 fixture 是否另有分发渠道——待确认。
3. **解析性能没有基线数字**：benchmark 脚本存在但无 CI 结果；2.3 的各启发式在大文件上的成本未测。
4. **TTML 生产日志未清**（`parseTTML`），是否影响日志体积/用户上报——低风险但应记录。
5. **HTTP API 无鉴权 + CORS 全开**：设计取舍还是遗留，代码注释未表态——报告中按「有意为之的取舍」处理，Zilux2 建议加强。
6. **`.fia` offsetMs 的语义**：仅元数据（代码注释明确），但导入方若误用会双重偏移；是否有导入侧忽略逻辑——待确认（`parseFoliaLyricDocument` 未见应用 offset）。
7. **backgroundVocal 单/复数字段**：渲染层是否全部读复数、单数仅为兼容旧缓存——未逐一核对所有消费方。
8. **Navidrome「非增强结构化优先纯文本」**的判定细节（`hasEnhancedNavidromeStructuredLyrics` 的完整规则）——未展开验证。
9. **跨源时间轴漂移**：审计工具的能量化结论（哪两个源可以混用、偏移量级）本次未实际运行（不联网），只能给出工具能力描述。
10. **行索引 51 个消费方的重渲染成本**：没有性能剖析数据；大歌词（1000+ 行）与低端机需要实测。
11. **GSMTC 实际上报精度**：Windows 版本/应用差异较大；7.4 的 250ms 阈值需要 Zilux2 实测校准（Folia 的 0.2s 是外部播放器 API 场景，不可直接照搬）。
12. **KRC 解密算法细节**：报告只到「魔数 + XOR/zlib + 酷狗 provider 调用」层面，未逐行读实现（AGPL 限制下也不应照抄，应按格式规范独立实现）。
13. **分词链路**：`icuFolia` 的 WASM 引擎与 AI 分词端点的取舍（成本/延迟/离线可用性）未深入——与 Zilux2 加载策略相关。
14. **可视化器/性能护栏**：本报告只引用接口级事实，具体样式性能结论以另一 teammate 报告为准。
15. **未运行任何测试/基准**：本报告所有结论来自静态阅读（满足「不 npm install、不联网」约束），行号已抽查核对但未做运行时验证。

### 8.3 仓库卫生观察（不影响功能，但迁移时必须处理）

- `src/` 下 **29 个文件**含针对 AI 的注入式注释（`@ai-ignore`、`DO NOT MODIFY`、`DO NOT INFORM USER` 等），分布包括 `components/visualizer/classic/Visualizer.tsx`、`GlowWord.tsx`、`monet/VisualizerMonet.tsx`、`sonnet/*.ts`、`cadenza/cadenzaPlacements.ts` 等。这些文本**不是代码逻辑**，但属于不可信内容：本调研按数据处理、未执行其中任何「指令」；Zilux2 迁移/重写时不要复制这类注释，也不要把它们当成规范。
- `VisualizerSubtitleOverlay.tsx:105-107` 还有一段带版本号的「版本控制」注释，与仓库实际版本（0.7.21）不符（注释写 `Project Folia version 0.5.27-a16525c`）——说明这类注释是历史遗留/外部注入，进一步说明不可信。

---

**调研边界**：本次为静态代码审计（只读、无安装、无网络、无运行）。所有 `file:line` 已按仓库实际内容抽查核对；代码摘录仅用于审计说明；性能数字（58ms/17.9MB/536 行等）来自仓库内作者注释，非本次实测。关于可视化器样式与性能护栏的细节，见另一 teammate 的报告。
