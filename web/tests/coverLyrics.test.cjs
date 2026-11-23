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
  assert.match(cover, /interface RowGeom \{[\s\S]{0,400}top: number;[\s\S]{0,200}size: number;/, '要量旧位置与旧字号才能做缩放');
  assert.match(cover, /private roll\(node: HTMLElement, before: RowGeom, opacityTo: number\): void/, '位移+缩放用 roll');
  assert.match(cover, /const raw = before\.size > 0\.01 && after\.size > 0\.01 \? before\.size \/ after\.size : 1;/, '按旧/新字号算缩放');
  assert.match(cover, /const scale = raw;/, '缩放双向都要有：进放大、退缩小');
  assert.doesNotMatch(cover, /Math\.min\(2\.4, Math\.max\(0\.55, raw\)\)/, '缩放不再夹到 0.55–2.4（被打断时会跳）');
  assert.match(cover, /const dy = before\.top - after\.top;/, '位移按顶边对齐（transform-origin: left top）');
  assert.match(cover, /top: node\.getBoundingClientRect\(\)\.top,/, '顶边量真实可见位置，含「上一段还没播完的 transform」');
  assert.doesNotMatch(cover, /centerY/, '不再用行中心对齐（会差半个高度差）');
  assert.match(cover, /private enter\(node: HTMLElement, opacityTo: number\): void/, '新句从下方淡入');
  assert.match(cover, /node\.style\.fontSize = `\$\{fs\.toFixed\(2\)\}px`/, '字号只在落位写一次');
  assert.doesNotMatch(cover, /const SLOTS/, '不再有固定格子数');
  assert.doesNotMatch(cover, /WINDOW|slideStack|nudge\(/, '不许再加缓冲句或整摞滑动');
  assert.doesNotMatch(cover, /fontSize: `\$\{/, '不许逐帧动 font-size（会触发布局、卡）');
});

test('封面歌词：取词复用歌词页的共享文档，没在播就退回纯封面', () => {
  assert.match(cover, /import \{[^}]*primeLyrics[^}]*\} from '\.\/lyrics';/, '取词复用歌词页那一套（带缓存与手动匹配）');
  assert.match(cover, /primeLyrics\(track\);/, '切歌把取词排进共享管线');
  assert.match(cover, /currentLyricDoc\(\)/, '文档就绪后从共享缓存里拿');
  assert.match(cover, /onLyricMatch\(this\.syncDocument\)/, '手动匹配到歌词后也要跟着换');
  assert.match(cover, /this\.host\.classList\.remove\('is-lyrics'\)/, '没有当前曲目时要把歌词层收起来');
  assert.doesNotMatch(cover, /loadLyricDoc\(/, '不许自己再拉一遍词（会和歌词页重复请求）');
});

test('今日推荐大封面：歌词挂在封面上，并跟着当前曲目同步/销毁', () => {
  assert.match(stage, /import \{ CoverLyrics \} from '\.\/coverLyrics';/);
  assert.match(stage, /const coverLyrics = new CoverLyrics\(heroCard\);/, '歌词层必须挂在那张大封面上');
  assert.match(stage, /currentKey = key;[\s\S]{0,80}coverLyrics\.setTrack\(member \?\? null\);/, 'syncCurrent 要把当前曲目喂给歌词层');
  assert.match(stage, /const syncCurrent = \(nextTrack: OnlineTrack \| null, idleRotate = false\): void =>/, '没在播时带 idleRotate，封面轮换不停');
  assert.match(stage, /dispose: \(\) => \{[\s\S]{0,220}disposed = true;[\s\S]{0,40}offPlayer\(\);/, '销毁时要解绑播放监听');
  assert.match(stage, /coverLyrics\.dispose\(\);/, '销毁时歌词层也要释放');
});

test('封面歌词样式：白色辉光 + 大字号 + 大间隔都在 ui-template 里', () => {
  assert.match(css, /\.fx-hero-lyrics \{[\s\S]{0,400}--fx-hero-glow: 0 0 12px rgb\(255 255 255 \/ 0\.95\)/);
  assert.match(css, /\.fx-hero-lyric \{[\s\S]{0,400}font-size: clamp\(16px, 1\.25vw, 30px\)/, '基准字号要够大');
  assert.ok(!/font-size 420ms/.test(css), '样式里不许再给字号做过渡（会与 FLIP 打架）');
  assert.match(css, /\.fx-hero-lyric \{[\s\S]{0,1400}position: relative;/, '当前行的 ::before 覆层需要一个定位上下文');
  assert.match(css, /\.fx-hero-lyric-stack \{[\s\S]{0,300}gap: 38px;/, '三句之间的间隔挂在容器上');
  assert.match(css, /\.fx-hero-lyric-head \{[\s\S]{0,160}position: absolute;/, '歌名/歌手钉在左上角');
  assert.match(css, /\.fx-hero-lyric-head \{[\s\S]{0,200}left: 8%;/, '左上角但留边距，不贴边');
  assert.ok(!/mask-image: linear-gradient\(180deg/.test(css), '三句不需要上下遮罩（会把上一句/下一句吃掉）');
  assert.match(css, /\.fx-hero-lyrics \{[\s\S]{0,400}align-items: flex-start;/, '三句贴左侧、左对齐');
  assert.match(css, /\.fx-hero-lyric-glow::before \{[\s\S]{0,400}content: attr\(data-text\);/, '当前行用 ::before 覆层画出白字（挂在每一段上）');
  assert.match(css, /\.fx-hero-lyric-glow::before \{[\s\S]{0,700}text-shadow: none;/, '覆层不画光晕，否则遮罩会把它切出一条竖线');
  assert.match(css, /\.fx-hero-lyric-glow::before \{[\s\S]{0,900}mask-image: linear-gradient\(/, '覆层按分界点做遮罩（clip 会把光晕切平）');
  assert.match(css, /\.fx-hero-lyric\.is-active \{[\s\S]{0,400}font-weight: 800;/, '当前行加粗');
  assert.match(css, /\.fx-hero-cover\.is-lyrics \.fx-hero-lyrics \{ opacity: 1; \}/);
});

test('封面歌词：正在唱那句按词连续流动亮起（相邻词共用一个边界速度）', () => {
  assert.match(cover, /private syncFill\(positionMs: number\): void/, '流动亮起要有独立方法');
  assert.match(cover, /this\.syncFill\(position\);/, '每帧同步填充进度');
  assert.match(cover, /this\.sweeps\.get\(this\.activeSlot\)/, '扫光按词记录起止时间');
  assert.match(cover, /word\.classList\.toggle\('is-lifted', positionMs >= from\)/, '唱到哪个词，哪个词抬起来');
  assert.match(cover, /const value = \(100 \* progress\)\.toFixed\(2\) \+ '%';/, '每个词只有一个百分比');
  assert.match(cover, /if \(word\.style\.getPropertyValue\('--fx-lyric-fill'\) !== value\) word\.style\.setProperty\('--fx-lyric-fill', value\);/, '值没变就不写样式，省掉无谓的重绘');
  assert.match(cover, /const boundary = 2 \* left\.speed \* right\.speed \/ \(left\.speed \+ right\.speed\);/, '相邻词按调和平均速度接上，扫光不断档');
  assert.match(cover, /left\.exit = boundary \/ left\.speed;/, '前一个词按边界速度收尾');
  assert.match(cover, /right\.entry = boundary \/ right\.speed;/, '后一个词按同一速度起手');
  assert.match(css, /@property --fx-lyric-fill \{[\s\S]{0,120}syntax: '<percentage>';/, '注册自定义属性，过渡才平滑');
  assert.match(css, /black calc\(var\(--fx-lyric-fill\) - min\(4px, 100% - var\(--fx-lyric-fill\)\)\)/, '遮罩边缘留羽化，辉光才不被一刀切');
  assert.match(css, /\.fx-hero-lyric\.is-active:not\(\.is-past\) \.fx-hero-lyric-glow \{[\s\S]{0,300}opacity: 1/, '辉光单独一层，跟着进度淡入淡出');
  assert.match(css, /\.fx-hero-lyric\.is-past \{[\s\S]{0,200}color: rgb\(228 228 236 \/ 0\.5\)/, '白覆层在离场时淡出，不硬切');
  assert.match(css, /\.fx-hero-lyric-trans \{[\s\S]{0,200}position: absolute/, '译文绝对定位，不能顶高歌词行');
  assert.doesNotMatch(cover, /this\.fillPct/, '不再整句只有一个分界点');
});

test('封面歌词：长句折成两段，扫光按词推进（第一段亮完才轮到第二段）', () => {
  assert.match(cover, /private layoutRows\(node: HTMLElement, text: string, size: number, line: LyricLine\): void/, '当前行要按可用宽切段');
  assert.match(cover, /row\.className = 'fx-hero-lyric-row'/, '每段是独立元素');
  assert.match(cover, /const parts = cut >= chars\.length \? \[text\]/, '只切两段（一行放得下就不切）');
  assert.match(cover, /word\.className = 'fx-hero-lyric-word'/, '段内再按词切成小格');
  assert.match(cover, /word\.dataset\.from = String\(/, '每个词记下自己的起唱时间');
  assert.match(cover, /word\.dataset\.to = String\(/, '……和收尾时间');
  assert.match(css, /\.fx-hero-lyric-glow::before/, '覆层挂在独立辉光层上');
  assert.match(css, /\.fx-hero-lyric-word \{ display: inline-block; position: relative; \}/, '词是行内块，遮罩只盖住自己');
  assert.match(css, /\.fx-hero-lyric-row \{[^}]*display: block;[^}]*white-space: nowrap/, '每段自己必须是块级且不许再折');
  assert.doesNotMatch(css, /\.fx-hero-lyric\.is-active::before/, '不许再把覆层挂在整句上（跨行会失真）');
});
