const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const cover = read('src/ui/coverLyrics.ts');
const stage = read('src/ui/fxDailyStage.ts');
const css = read('src/styles/ui-template.css');

test('封面歌词：只三句，换行时「下一句放大上移、上一句缩小让位」', () => {
  // 节点跟着「句子」走：同一句从下一格移到中间，才会看到它放大上升，
  // 而不是三格里原地换字。
  assert.match(cover, /private readonly nodes = new Map<number, HTMLElement>\(\)/, '节点按行号持句');
  assert.match(cover, /const wanted = active < 0 \? \[\] : \[active - 1, active, active \+ 1\]/, '只有上一句 / 正在唱 / 下一句');
  assert.match(cover, /interface RowGeom \{[\s\S]{0,120}size: number;/, '要量旧字号才能做缩放');
  assert.match(cover, /private roll\(node: HTMLElement, before: RowGeom, opacityTo: number\): void/, '位移+缩放用 roll');
  assert.match(cover, /const raw = before\.size > 0\.01 && after\.size > 0\.01 \? before\.size \/ after\.size : 1;/, '按旧/新字号算缩放');
  assert.match(cover, /const scale = Math\.min\(2\.4, Math\.max\(0\.55, raw\)\)/, '缩放双向都要有：进放大、退缩小');
  assert.match(cover, /const dy = Math\.min\(limit, Math\.max\(-limit, before\.centerY - after\.centerY\)\)/, '位移按行中心对齐，夹取值按整摞高度');
  assert.match(cover, /centerY: node\.offsetTop \+ node\.offsetHeight \/ 2/, '几何要用布局坐标量中心（getBoundingClientRect 会带上未播完的 transform）');
  assert.doesNotMatch(cover, /getBoundingClientRect\(/, 'FLIP 的前一帧不许调用 getBoundingClientRect');
  assert.match(cover, /private enter\(node: HTMLElement, opacityTo: number\): void/, '新句从下方淡入');
  assert.match(cover, /node\.style\.fontSize = `\$\{size\.toFixed\(2\)\}px`/, '字号只在落位写一次');
  assert.doesNotMatch(cover, /const SLOTS/, '不再有固定格子数');
  assert.doesNotMatch(cover, /WINDOW|slideStack|nudge\(/, '不许再加缓冲句或整摞滑动');
  assert.doesNotMatch(cover, /fontSize: `\$\{/, '不许逐帧动 font-size（会触发布局、卡）');
});

test('封面歌词：换歌取词带代次守卫，没在播就退回纯封面', () => {
  assert.match(cover, /const tag = \+\+this\.request;/, '取词要带代次号，连续切歌不许旧结果覆盖新歌');
  assert.match(cover, /this\.host\.classList\.remove\('is-lyrics'\)/, '没有当前曲目时要把歌词层收起来');
  assert.match(cover, /loadLyricDoc\(track\)/, '歌词复用歌词页那一套加载（带缓存与手动匹配）');
});

test('今日推荐大封面：歌词挂在封面上，并跟着当前曲目同步/销毁', () => {
  assert.match(stage, /import \{ CoverLyrics \} from '\.\/coverLyrics';/);
  assert.match(stage, /const coverLyrics = new CoverLyrics\(heroCard\);/, '歌词层必须挂在那张大封面上');
  assert.match(stage, /currentKey = key;\n\s+coverLyrics\.setTrack\(nextTrack\);/, 'syncCurrent 要把当前曲目喂给歌词层');
  assert.match(stage, /dispose: \(\) => \{\n\s+disposed = true;\n\s+offPlayer\(\);/, '销毁时要解绑播放监听');
  assert.match(stage, /coverLyrics\.dispose\(\);/, '销毁时歌词层也要释放');
});

test('封面歌词样式：白色辉光 + 大字号 + 大间隔都在 ui-template 里', () => {
  assert.match(css, /\.fx-hero-lyrics \{[\s\S]{0,400}--fx-hero-glow: 0 0 12px rgb\(255 255 255 \/ 0\.95\)/);
  assert.match(css, /\.fx-hero-lyric \{[\s\S]{0,400}font-size: clamp\(16px, 1\.25vw, 30px\)/, '基准字号要够大');
  assert.ok(!/font-size 420ms/.test(css), '样式里不许再给字号做过渡（会与 FLIP 打架）');
  assert.match(css, /\.fx-hero-lyric \{[\s\S]{0,1400}position: relative;/, '当前行的 ::before 覆层需要一个定位上下文');
  assert.match(css, /\.fx-hero-lyric-stack \{[\s\S]{0,300}gap: 30px;/, '三句之间的间隔挂在容器上');
  assert.match(css, /\.fx-hero-lyric-head \{[\s\S]{0,160}position: absolute;/, '歌名/歌手钉在左上角');
  assert.match(css, /\.fx-hero-lyric-head \{[\s\S]{0,200}left: 8%;/, '左上角但留边距，不贴边');
  assert.ok(!/mask-image: linear-gradient\(180deg/.test(css), '三句不需要上下遮罩（会把上一句/下一句吃掉）');
  assert.match(css, /\.fx-hero-lyrics \{[\s\S]{0,400}align-items: flex-start;/, '三句贴左侧、左对齐');
  assert.match(css, /\.fx-hero-lyric\.is-active \.fx-hero-lyric-row::before \{[\s\S]{0,400}content: attr\(data-text\);/, '当前行用 ::before 覆层画出白字（挂在每一段上）');
  assert.match(css, /\.fx-hero-lyric\.is-active \.fx-hero-lyric-row::before \{[\s\S]{0,700}text-shadow: none;/, '覆层不画光晕，否则遮罩会把它切出一条竖线');
  assert.match(css, /\.fx-hero-lyric\.is-active \.fx-hero-lyric-row::before \{[\s\S]{0,900}-webkit-mask-image: linear-gradient\(/, '覆层按分界点做遮罩（clip 会把光晕切平）');
  assert.match(css, /\.fx-hero-lyric\.is-active \{[\s\S]{0,400}font-weight: 800;/, '当前行加粗');
  assert.match(css, /\.fx-hero-cover\.is-lyrics \.fx-hero-lyrics \{ opacity: 1; \}/);
});

test('封面歌词：正在唱那句从左到右连续流动亮起（渐变分界点）', () => {
  assert.match(cover, /private syncFill\(positionMs: number\): void/, '流动亮起要有独立方法');
  assert.match(cover, /this\.syncFill\(state\.positionMs\);/, '每帧同步填充进度');
  assert.match(cover, /row\.style\.setProperty\('--fx-lyric-fill', `\$\{local\.toFixed\(1\)\}%`\)/, '每段只改一个自定义属性（百分比）');
  assert.match(cover, /if \(Math\.abs\(pct - this\.fillPct\) < 0\.25\) return;/, '变化太小就不写样式，省掉无谓的重绘');
  assert.match(cover, /const pct = Math\.max\(0, Math\.min\(100, \(\(positionMs - line\.timeMs\) \/ total\) \* 100\)\);/, '分界点按整句时间线性推进，不按字/词切段（按词会看起来逐字点亮）');
  assert.doesNotMatch(cover, /lineWords\(/, '按词切段的实现要彻底去掉');
  assert.match(css, /@property --fx-lyric-fill \{[\s\S]{0,120}syntax: '<percentage>';/, '注册自定义属性，过渡才平滑');
  assert.match(css, /#000 calc\(var\(--fx-lyric-fill, 0%\) - 3%\)/, '遮罩边缘留羽化，辉光才不被一刀切');
  assert.match(css, /\.fx-hero-lyric\.is-active \.fx-hero-lyric-row::after \{[\s\S]{0,300}text-shadow: var\(--fx-hero-glow\)/, '辉光单独一层，跟着进度淡入淡出');
  assert.match(css, /\.fx-hero-lyric\.is-past \.fx-hero-lyric-row::before \{[\s\S]{0,120}opacity: 0/, '白覆层在离场时淡出，不硬切');
  assert.match(css, /\.fx-hero-lyric-trans \{[\s\S]{0,200}position: absolute/, '译文绝对定位，不能顶高歌词行');
});

test('封面歌词：长句折成两段，扫光按段推进（第一段亮完才轮到第二段）', () => {
  assert.match(cover, /private layoutRows\(node: HTMLElement, text: string, size: number\): void/, '当前行要按可用宽切段');
  assert.match(cover, /row\.className = 'fx-hero-lyric-row'/, '每段是独立元素');
  assert.match(cover, /const parts = cut >= chars\.length \? \[text\]/, '只切两段（一行放得下就不切）');
  assert.match(cover, /const local = Math\.max\(0, Math\.min\(100, \(\(pct \/ 100 - passed\) \/ share\) \* 100\)\)/, '扫光按字符占比分摊到各段');
  assert.match(cover, /row\.style\.setProperty\('--fx-lyric-fill'/, '每段各有自己的分界点');
  assert.match(css, /\.fx-hero-lyric\.is-active \.fx-hero-lyric-row::before/, '覆层挂在段上');
  assert.match(css, /\.fx-hero-lyric-row \{[^}]*display: block;[^}]*white-space: nowrap/, '每段自己必须是块级且不许再折');
  assert.doesNotMatch(css, /\.fx-hero-lyric\.is-active::before/, '不许再把覆层挂在整句上（跨行会失真）');
});
