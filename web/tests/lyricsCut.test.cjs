'use strict';
/**
 * 歌词页「右侧切割」的回归契约。
 *
 * 两处曾经把文字切掉一半：
 * 1. `.lyrics-right .lyrics-lines` 用 `align-items:flex-start`，列方向的交叉轴收缩成 fit-content，
 *    长句于是永远不换行，直接冲出歌词列被 `.lyrics-right{overflow:hidden}` 切在右缘；
 * 2. 起句放大读 `--line-emph` 的兜底值 0.207，但 `applyLineEmphasisCap` 之前只在切换动效档位时算，
 *    正常播放从不写入 → 长句按 1.32 倍放大，右侧同样被切。
 * 另外封面下方的「歌曲信息」把同一平台的逐字标签拼了两遍，再被 nowrap 的省略号切掉。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'src', 'styles', 'app.css'), 'utf8');
const lyrics = fs.readFileSync(path.join(root, 'src', 'ui', 'lyrics.ts'), 'utf8');

test('歌词列不许用 flex-start 收缩行盒（否则长句不换行、右缘被切）', () => {
  assert.doesNotMatch(css, /\.lyrics-right \.lyrics-lines\{[^}]*align-items:flex-start/);
  assert.match(css, /\.lyrics-right \.lyrics-lines\{[^}]*align-items:stretch/);
  // 桌面背景歌词（封面在左）是同一套排版，必须一起改。
  assert.doesNotMatch(css, /is-bg-cover-left[^{]*\.lyrics-lines\{[^}]*align-items:flex-start/);
});

test('放大余量的兜底值必须是 0：没量过就不放大', () => {
  assert.doesNotMatch(css, /var\(--line-emph, 0\.207\)/);
  assert.match(css, /var\(--line-emph, 0\)/);
});

test('每次换行都重算放大余量，不只是切动效档位时', () => {
  const body = lyrics.slice(lyrics.indexOf('private syncProgress'));
  const changed = body.slice(0, Math.max(0, body.indexOf('const activeLine = this.doc.lines')));
  assert.match(changed, /this\.applyLineEmphasisCap\(nextIndex\)/);
  // 版面变化（窗口尺寸 / 歌词列 ResizeObserver / 字号 / 字体就绪）后也要重算。
  assert.match(lyrics, /private recapEmphasis\(\): void/);
  assert.match(lyrics, /this\.syncProgress\(true\);\s*\n\s*this\.recapEmphasis\(\);/);
  assert.match(lyrics, /document\.fonts\?\.ready\.then\(\(\) => this\.recapEmphasis\(\)\)/);
});

test('歌曲信息的来源行不重复拼同一平台标签，也不再一行 nowrap 切掉', () => {
  assert.doesNotMatch(lyrics, /return `\$\{base\} · 逐字 \$\{info\.label\}`;/);
  assert.match(lyrics, /platform && base\.startsWith\(`\$\{platform\} ·`\) \? base : `\$\{base\} · 逐字 \$\{label\}`/);
  assert.doesNotMatch(css, /\.lyrics-source\{[^}]*white-space:nowrap[^}]*text-overflow:ellipsis/);
  assert.match(css, /\.lyrics-source\{[^}]*overflow-wrap:anywhere/);
});

/**
 * 第三处切割（第 N 轮）：歌名 / 歌手 / 来源行用 `-webkit-line-clamp` + 隐含的 overflow:hidden，
 * 12px 的 text-shadow 白晕被盒子边缘齐着切掉；同时当前行用 transform: scale() 放大，
 * 文字先画进缩放表面再合成 → 起句过程中与静止之后都发虚（和「动画收尾发糊」同一个病根）。
 */
test('歌曲信息不再被行夹盒裁掉：overflow 必须放开', () => {
  const block = css.slice(css.indexOf('.lyrics-view .lyrics-meta .lyrics-title'));
  assert.match(block, /overflow: visible !important/);
  assert.match(block, /-webkit-line-clamp: unset !important/);
  assert.match(block, /text-overflow: clip !important/);
});

test('当前行放大只许改字号，不许 transform 缩放文字', () => {
  // 行、唱到的字都不许留缩放/位移：那会把文字画进缩放表面，声音一响就糊。
  assert.match(css, /\.lyrics-right \.lyric-line\.is-active \{[^}]*transform: none !important/);
  assert.doesNotMatch(
    css,
    /\.lyric-line\.is-active\{[^}]*transform: translate[XY]?\(?[^}]*scale\(1\.1[0-9]/,
    '当前行的 scale 放大是发虚的根源',
  );
  assert.match(
    css,
    /\.lyrics-view \.lyric-line\.is-active \.lyric-char\.is-hot,[\s\S]{0,400}?scale: 1 !important/,
    '唱到的字也要收回 scale',
  );
  // 放大驱动改到 font-size：行高钉死在基准值，字号变大才不顶下一行。
  assert.match(lyrics, /private applyGrowFrame\(el: HTMLElement \| undefined, grow: number\): void/);
  assert.match(lyrics, /el\.style\.setProperty\('font-size', `\$\{\(size \* factor\)\.toFixed\(2\)\}px`, 'important'\)/);
  assert.doesNotMatch(lyrics, /style\.setProperty\('--grow'/, '放大不再走 CSS 变量缩放');
  assert.match(lyrics, /private resetGrowStyle\(el: HTMLElement \| undefined\): void/);
  // 逐帧写字号必须先把这一行钉成独立布局根，否则整列（几十行）每帧重排，起句就是「卡」。
  assert.match(lyrics, /private pinGrowBox\(el: HTMLElement \| undefined\): void/);
  assert.match(lyrics, /el\.style\.setProperty\('contain', 'layout', 'important'\)/);
  assert.match(lyrics, /el\.style\.setProperty\('line-height', `\$\{lineHeight\.toFixed\(2\)\}px`, 'important'\)/);
  assert.match(lyrics, /this\.pinGrowBox\(activeEl\);/);
});

test('全屏/换档后重算基准字号，但不许拆布局根', () => {
  // 窗口最大化 / 切字号档位 / 字体加载完成都会改基准字号；缓存不清就会一直按 29px 放大，
  // 而 CSS 已经把普通行提到 76px —— 当前行反而缩成小字。
  assert.match(lyrics, /private lastGrowApplied = 1;/, '要记住最近一次的曲线值');
  assert.match(lyrics, /this\.lastGrowApplied = grow;/, 'applyGrowFrame 要记录曲线值');
  const recap = lyrics.slice(lyrics.indexOf('private recapEmphasis()'), lyrics.indexOf('private recapEmphasis()') + 1400);
  assert.match(recap, /this\.lineBaseMetrics\.delete\(el\);/, 'recap 要清基准缓存');
  assert.match(recap, /this\.applyLineEmphasisCap\(this\.activeIndex\);/, 'recap 要重算余量');
  assert.match(recap, /this\.pinGrowBox\(el\);/, 'recap 要重钉布局根');
  assert.match(recap, /this\.applyGrowFrame\(el, this\.lastGrowApplied\);/, '基准变了要按原曲线重放');
  assert.doesNotMatch(recap, /this\.resetGrowStyle\(el\);/, 'recap 不许拆布局根：一拆一钉会抖，ResizeObserver 还会被再叫一次');
  // 重钉时行数要用「现有钉死高度 ÷ 新行高」换算，否则换版面会把行数算成 1（折行被裁）。
  assert.match(lyrics, /const pinned = Number\.parseFloat\(el\.style\.getPropertyValue\('height'\)\);/, 'pinGrowBox 要读现有钉死高度');
});
