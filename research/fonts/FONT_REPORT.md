# Zilux2 中文字体子集（troika-three-text 用）交付报告

生成时间：2026-10-20 · 执行者：font-forge（团队 subagent）· 工作区：`E:\Zilux2开发`

> 一句话结论：**troika-three-text 0.52.5 不用 opentype.js，用的是内置 Typr 解析器**（`.ttf`/`.otf`/`.woff` 均可，**`.woff2` 明确抛错**）。已产出基于系统 Noto Sans SC 可变字体实例化 + 子集的静态字体：TTF 7.32 MB / WOFF1 4.40 MB，CJK 基本区覆盖 **99.924%**，GB2312 一二级 **100%**，并用 troika 真实的 Typr 代码逐字节验证通过。

---

## 1. 交付物（随 app 打包）

| 文件（绝对路径） | 字节数 | 大小 | 格式 | sha256 |
|---|---|---|---|---|
| `E:\Zilux2开发\web\public\fonts\zilux2-sans-sc-regular.ttf` | 7,673,692 | 7.32 MB | 静态 TTF（glyf 轮廓） | `2400d7a71a5961fa5594d2478200a83cd8434f196a6302ce4aaddf36b6052a0b` |
| `E:\Zilux2开发\web\public\fonts\zilux2-sans-sc-regular.woff` | 4,616,180 | 4.40 MB（TTF 的 60.2%） | WOFF1（zlib per table） | `36da661fdeea8f4323a820db546ead5205f0549a7582beae9ce6a5c17133d359` |
| `E:\Zilux2开发\web\public\fonts\OFL.txt` | 4,377 | 4.3 KB | SIL OFL 1.1 许可证正文 | —（OFL 要求随字体分发） |

两个字体文件**内容等价**（同一份 sfnt，WOFF 只是容器压缩；表结构、字形、cmap 完全一致），运行时二选一即可。

**关键指标（两个文件相同）**

- glyph 数：**22,886**；cmap 映射码位：**22,399**
- font family：`Zilux2 Sans SC`，subfamily `Regular`，full name `Zilux2 Sans SC Regular`，PostScript name `Zilux2SansSC-Regular`，typographic family/subfamily 同为 `Zilux2 Sans SC` / `Regular`
- 字重：`OS/2.usWeightClass = 400`（Regular），`head.macStyle = 0`，`fsSelection = 0x0040`（REGULAR），`fsType = 0`（可自由嵌入）
- 度量：unitsPerEm 1000；hhea ascender/descender/lineGap = 1000 / -200 / 0；OS/2 typo = 880 / -120 / 0；winAscent/winDescent = 1160 / 288
- 表：`GPOS, GSUB, OS/2, cmap, glyf, head, hhea, hmtx, loca, maxp, name, post`（无 fvar/gvar/avar/STAT/HVAR — 已彻底实例化为静态；无 CFF/CFF2/VORG/SVG/COLR）
- head bbox：xMin/yMin/xMax/yMax = -1002 / -1048 / 2928 / 1808；post format 3.0（无字形名）；无 hinting 指令字节（源码字体本身就没有）
- 无 cmap 条目指向 `.notdef`；空轮廓字形只有 3 个空隔符 `space`、`uni2003`、`uni2002`

---

## 2. 覆盖统计（fontTools 实测，最终 TTF）

| 目标区段 | 覆盖 |
|---|---|
| ASCII U+0020–007E | **95 / 95 = 100%** |
| 必需中文标点（，。！？、；：「」『』（）《》—…·～％＋－） | **22 / 22 = 100%**（missing = []） |
| **CJK 基本区 U+4E00–U+9FFF** | **20,976 / 20,992 = 99.924%** |
| GB2312 一级常用字 | **3,755 / 3,755 = 100%** |
| GB2312 二级次常用字 | **3,008 / 3,008 = 100%** |
| 常用 3500 字 | 100%（GB2312 一级 3755 字为其超集，故全覆盖） |
| CJK 标点 U+3000–303F | 64 / 64 = 100% |
| 全角形式 U+FF01–FF60 | 96 / 96 = 100% |
| U+FFE0–FFE6（￠￡￥￦…） | 7 / 7 = 100% |
| 平假名 / 片假名 | 93 / 96 · 96 / 96 |
| 注音符号 U+3100–312F | 43 / 48 |
| CJK 兼容表意字 U+3300–33FF | 255 / 256 |
| Latin-1 补充 U+00A0–00FF | 96 / 96 |
| 带圈数字 U+2460–24FF | 160 / 160 |
| 制表符 U+2500–257F | 128 / 128 |
| 全部目标码位合计（23,334 个） | **22,399 / 23,334 = 95.993%**（其余码位源字体本身就没有） |
| U+3007「〇」 | 有 |

**缺口说明（重要）**

- CJK 基本区缺 16 个：`U+9FF0–U+9FFF`。这 16 个字在 Unicode 15 中已分配，但**系统 `NotoSansSC-VF.ttf` 这个版本里本来就没有**（不是子集砍掉的）。全字体所有来源都缺这 16 个。
- 源字体覆盖但本子集**故意未包含**的：**CJK Ext-A（U+3400–U+4DBF）**、CJK 兼容表意字（U+2F00–2FDF）等 → 若歌词出现「㐀 㐁 㭴 …」这类罕用字会缺字（有可选 Ext-A 版本，见 §7）。
- 不含 emoji / 彩色字形：`❤`（U+2764）等大量 Misc Symbols/Emoji 码位源字体本身没有。**在线时 troika 会用 CDN 回退字体，离线时会卡住渲染（见 §6 坑 3，务必处理）**。

---

## 3. 接入方式（troika-three-text 0.52.5）

### 3.1 加载（推荐 WOFF1，4.40 MB）

```js
import { Text, preloadFont } from 'troika-three-text'

const fontUrl = new URL('./fonts/zilux2-sans-sc-regular.woff', document.baseURI).href
// 也可直接写相对路径字符串：'./fonts/zilux2-sans-sc-regular.woff'
//   → 在 https://zilux2.local/index.html 下解析为 https://zilux2.local/fonts/...

const text = new Text()
text.font = fontUrl
text.fontSize = 0.5
text.maxWidth = 8
text.overflowWrap = 'break-word'   // ★ 中文换行必须，否则整行不折行
text.sdfGlyphSize = 96             // 默认 64；大字号 CJK 建议 96/128（必须 2 的幂）
text.text = '歌词……'
scene.add(text)
```

- 字体 URL 由 **主线程 `XMLHttpRequest` 加载**（`responseType='arraybuffer'`），解析在 Web Worker 里；同一 URL 只加载/解析一次（按 URL 字符串缓存）。因此 `https://zilux2.local/fonts/...` 与页面同源，**不涉及 CORS，也不依赖 MIME type**，`SetVirtualHostNameToFolderMapping` 映射即可直接用。
- **不要**用 `import fontUrl from '../public/fonts/x.woff?url'` —— `web/public/` 是 vite 静态目录，原样复制，不走模块打包；用运行时相对 URL/`new URL(..., document.baseURI)`。
- 打包后路径：`web/public/fonts/*` → `dist/fonts/*` → 发布复制到 `dist/Zilux2/web/fonts/*`，宿主映射后 URL 为 `https://zilux2.local/fonts/...`。

### 3.2 预生成 SDF（歌词场景强烈建议）

```js
preloadFont({ font: fontUrl, characters: [...new Set(lyricChars)], sdfGlyphSize: 96 }, () => {})
```

`preloadFont` 的 `characters` 接受 string 或 string[]；提前生成可避免切换歌词时主线程/worker 卡顿。

### 3.3 字重

- **`text.fontWeight` 对自定义字体单文件无效**。troika README 明确：`fontWeight` "Currently only used to select the preferred weight for the fallback Unicode fonts"；`FontResolver` 按 `weight` 只在回退字体里选粗体。**要粗体必须另做一个字体文件、再用另一个 `font` URL**（或自定义 `fontResolver`）。
- 本报告只交付 wght=400 一份。需要 600 粗体时的构建方式见 §7.1。

---

## 4. 运行时验证（用 troika 0.52.5 真实的 Typr 代码，Node 中跑）

验证脚本：`E:\Zilux2开发\research\fonts\verify\verify_troika.mjs`（拷入 troika 的 `libs/typr.factory.js` + `libs/woff2otf.factory.js` 原样运行）
日志：`E:\Zilux2开发\research\qa\font_verify.log`

| 项目 | TTF | WOFF1 |
|---|---|---|
| 首次解析耗时 | `Typr.parse` **7.2 ms** | 解压 `woff2otf` **45.0 ms** → `Typr.parse` 3.2 ms = **合计 48.2 ms** |
| 必需码位覆盖（Typr 路径逐码位 `codeToGlyph`） | 21,093 / 21,109（缺的就是那 16 个 U+9FF0–9FFF） | 同左 |
| CJK 基本区 `glyphToPath` 全量 20,976 字形 | **169 ms（8.0 µs/字形）**，空路径 0、格式错误 0 | 140 ms，空路径 0、格式错误 0 |
| CJK 轮廓包围盒 | x[9,1009] y[-98,863]（正常） | 同左 |
| WOFF1 → sfnt 还原后大小 | — | 7,673,692 B（与 TTF 完全一致） |

抽样：`中` gid 1337 / advance 1000 / 22 cmds；`国` gid 3576 / 48 cmds；`歌` gid 8751 / 119 cmds；`A` gid 34 / advance 608；`。` gid 724；`★` gid 656；`♪` gid 681；`爱` 路径字符串 1,112 字符 —— 全部正常。

> WOFF1 的 48 ms 解压+解析发生在 **worker 内**，不阻塞 UI，可接受。

**fontTools 层面（`research/fonts/verify_font.py`、`check_shipped.py`、`report_stats.py`）**：结构/度量/name/覆盖如上；两个文件均通过；composite 字形全部可解析。

---

## 5. 体积方案对照（实测，`research/fonts/measure_options.py`）

| 方案 | 内容 | TTF | WOFF1 |
|---|---|---|---|
| **full（当前交付）** | ASCII+标点+符号块+假名+CJK 基本区 | 7,673,644 B (7.32 MB) | **4,616,160 B (4.40 MB)** |
| lean | 只留 ASCII+必需标点+U+4E00–U+9FFF | 7,398,592 B (7.06 MB) | 4,475,252 B (4.27 MB) |
| tier1 | GB2312 6763 字 + ASCII + 标点 | 2,209,808 B (2.11 MB) | 1,401,356 B (1.34 MB) |
| tier2 | CJK 基本区 − GB2312（罕用字） | 5,324,948 B (5.08 MB) | 3,184,300 B (3.04 MB) |
| extA（可选） | full + CJK Ext-A + 兼容表意字 | 10,122,780 B (9.65 MB) | 6,116,788 B (5.83 MB) |

其他参考：同一 TTF 的 gzip/zlib = 4.39 MB，**WOFF2 = 2.99 MB**（但 troika 明确拒绝，见坑 1）。去掉 GPOS+GSUB 只省约 26 KB；字形 hinting 指令为 0 字节，`--no-hinting` 省不了体积。

**结论**：在「CJK 基本区全覆盖」前提下，**单个文件 ≤ 4 MB 做不到**（glyf 表就 7.09 MB，WOFF1 已到 4.40 MB）。
- 可接受 ~4.4 MB（+10%）→ 直接用当前 WOFF1，推荐。
- 必须 ≤4 MB → 只能砍掉约 2.6k–6k 罕用字（或用 tier1+tier2 分层懒加载：首屏 1.34 MB + 后台 3.04 MB，总量 4.58 MB 不变）、或 app 端自己塞一个 WOFF2 解码器（超出本次范围）。

---

## 6. 坑 / 注意事项（按重要性排序）

1. **`.woff2` 不能用**。`troika-three-text` 0.52.5 的 `FontParser.js` 里 `if (tag === 'wOF2') throw new Error('woff2 fonts not supported')`（`web/node_modules/troika-three-text/src/FontParser.js:414`，`dist/troika-three-text.esm.js:431` 同）。`.woff` **可以**（内部 `woff2otf` 先 inflate 成 sfnt 再 Typr 解析），已在 Node 用真实代码验证。若体积是硬指标，唯一出路是 app 端自做 woff2 解码/换 loader，不要指望 troika。
2. **不是 opentype.js**。troika 内置 Typr（`typr.factory.js`），支持 TTF/OTF/WOFF1；理论上也支持 CFF OTF（Typr 有 `CFF ` 解析分支与 `_drawCFF`），我们这条链路用 glyf 最稳。
3. **缺字会走 CDN 回退，离线/被墙时整段文字可能永不渲染**。`FontResolver` 发现用户字体没有的码位时，调用内置 `unicode-font-resolver`（数据源 `https://cdn.jsdelivr.net/gh/lojjic/unicode-font-resolver@v1.0.1/packages/data`，回退字体是 `.woff` 直链），**没有 catch/超时**；请求失败则回调永远不来 → `text.sync()` 不完成、文字不出现（只在 console 有未处理 Promise）。国内 jsdelivr 常被墙，风险高。→ **建议 app 侧对歌词做一次字符过滤**（去掉 emoji/Ext-A/CJK 扩展区等本字体不含的字符，或把 `type: 'exta'` 字体也带上），确保传给 troika 的字符串能被本字体覆盖。这也是 §7 提供 Ext-A 版本的原因。
4. **字体 URL 写错是静默失败**。`doLoadFont` 的 `onError` 只 `console.error('Failure loading font ...')`，不触发回调。上线前务必确认 `dist/Zilux2/web/fonts/` 里文件存在、URL 大小写一致。
5. **中文换行必须设 `overflowWrap: 'break-word'`**（或 `whiteSpace: 'nowrap'` 自行切行）。troika `Typesetter` 的断行字符集只含空格与 `- | — …` 等，**不含中日韩字符**；`maxWidth` 下未加此设置时会整行溢出（默认 `whiteSpace:'normal'` + `overflowWrap:'normal'`）。
6. **`fontWeight` 对单文件字体无效**（见 §3.3），粗体要独立文件 + 独立 URL。
7. Typr 解析时会打印 11 条 `unsupported GPOS table LookupType 1 format 2`（console.debug）。这些 GPOS 子表变成 no-op，不影响字形/advance；`halt/kern/palt/vert/vhal/vkrn/vpal` 特性保留，kern 对拉丁有效。
8. OFL / 保留字体名：源字体是 Source Han Sans / Noto 系（Adobe 版权，OFL 1.1，保留字体名 `Source`）。已把 family 改为 `Zilux2 Sans SC`（不占用保留名），`nameID 0/13/14` 原始版权与 OFL 声明全部保留，`web/public/fonts/OFL.txt` 随包分发 **必须保留**。
9. 不要无参再跑 `research/fonts/finalize_font.py`（会重写已交付文件、改变 sha256）。该脚本现已可传参（`finalize_font.py <in.ttf> <out.ttf> <out.woff> <PSName>`）。
10. 体积决策：`web/public/fonts/` 里 TTF+WOFF 两份共 12.3 MB，**都会被打进发布包**。若只想随包一份，建议留 `.woff`（4.40 MB），把 `.ttf` 移到 `research/fonts/` 备查（或删掉）；若坚持用 TTF，就删 `.woff`。**未擅自删除，等 lead 决定。**

---

## 7. 可选扩展方案（脚本已就绪，未进随包目录）

### 7.1 生成 wght=600 粗体一份

```bash
PY=C:/Users/13329/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe
cd E:/Zilux2开发
"$PY" research/fonts/build_font.py 600 research/fonts/work/static-600.ttf
# 再改 finalize_font.py 的 TTF/WOFF/FAMILY/STYLE/PS/WEIGHT 常量（或传参 + 改常量）后运行
```
产物体积与 400 相同（TTF 7.32 MB / WOFF 4.40 MB），需另一个 font URL（`zilux2-sans-sc-bold.woff`），且要在 app 里按需切换 `text.font`。

### 7.2 Ext-A 罕用字版本（已构建并验证）

- `research/fonts/work/zilux2-sans-sc-regular-exta.ttf` — **10,122,780 B (9.65 MB)**，sha256 `264d3d311bf49a97bcaba1815e2db9912380cbc173476a16b3bfe6587df3a42c`
- `research/fonts/work/zilux2-sans-sc-regular-exta.woff` — **6,116,788 B (5.83 MB)**，sha256 `582c9c4790abe58eb48fbb433e4c831dfc09a966119a1604074065141524d614`
- glyph 29,467 / cmap 29,195；CJK 基本区 20,976/20,992 + **Ext-A 6,582/6,592 (99.85%)** + 兼容表意字 214/224；Typr 实测解析 7.8 ms、Ext-A 字形 `glyphToPath` 全部非空、㐀/㐁/龘 均正常。
- 用途：网络歌词出现罕用字时兜底。代价：+1.5 MB WOFF。若采用，可作「第二字体」按需加载（`text.font = [主字体, exta字体]` 或用自定义 fontResolver），或直接替换主文件（5.83 MB）。
- 注意：Ext-B 及以后（如 `𠀀` U+20000）源字体也没有，无法覆盖。

---

## 8. 复现脚本清单（均在 `E:\Zilux2开发\research\fonts\`）

| 脚本 | 用途 |
|---|---|
| `build_font.py` | 从 `C:\Windows\Fonts\NotoSansSC-VF.ttf` 子集化 → `varLib.instancer` 实例化到指定 wght（默认 400）→ 删可变表 → 输出静态 TTF；`python build_font.py <weight> <out.ttf>` |
| `finalize_font.py` | 重写 name 表家族名/PS 名、设 OS/2+head 度量与 fsSelection、断言 OFL 记录保留、输出 TTF 并转 WOFF1；可传参 `<in.ttf> <out.ttf> <out.woff> <PSName>` |
| `build_ext_a.py` | 在 build_font 的 RANGES 上追加 Ext-A + 兼容表意字，产 Ext-A 版 |
| `verify_font.py` | 逐 glyph 检查 glyf 非空 / 无 .notdef 引用 / composite 可解析 / 精确覆盖统计 |
| `check_shipped.py` | 终验交付文件：magic、表、name、度量、fsSelection、sha256 |
| `report_stats.py` | 分区段覆盖统计 |
| `measure_options.py` | full/lean/tier1/tier2 体积方案实测 |
| `woff_sizes.py` | TTF/gzip/zlib/WOFF1/WOFF2 大小对照 |
| `inspect_font.py` / `table_sizes.py` / `compare_fonts.py` | 源字体结构/表大小/字体对比 |
| `verify/verify_troika.mjs` | 用真实 troika Typr 代码在 Node 里离线验证解析/覆盖/glyphToPath |
| `verify/verify_extA.mjs` | Ext-A 版本同上验证 |

产物原始文件在 `research/fonts/work/`（subset-vf.ttf、variant-*.{ttf,woff}、exta-*、static-600 候选等），可随时复现/替换，不影响随包目录。

---

## 9. 建议（给 lead）

1. **随包只放一份字体**：`web/public/fonts/zilux2-sans-sc-regular.woff`（4.40 MB）+ `OFL.txt`；`troika` 用相对 URL `'./fonts/zilux2-sans-sc-regular.woff'`（或 `new URL(..., document.baseURI).href`）。TTF 留作源码/调试备份。
2. 接入时务必：`overflowWrap='break-word'`、`preloadFont` 预热歌词字符、`sdfGlyphSize` 96（大字号）、**传给 troika 的歌词先过滤掉本字体不含的字符**（尤其 emoji、CJK 扩展区），否则离线会挂。
3. 若歌词罕用字是硬需求，直接上 Ext-A 版（5.83 MB WOFF），或把 Ext-A 作为第二字体懒加载。
4. 体积若必须 ≤4 MB：改用 tier1(1.34 MB)+tier2(3.04 MB) 分层加载；或接受 4.40 MB。
