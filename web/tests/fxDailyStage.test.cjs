/**
 * FX 第一个内容视图「今日推荐」的进场参数与接线。
 *
 * 这条链路上的失配同样是静默的：帧数写错 = 闪的时长不对但没有报错；
 * 落字比例写错 = 一直乱跳或根本不跳；宫格/边距写错 = 字顶出画面或压到播放条。
 * 所以把维护者指定的数字钉成断言，改手感时先让测试说话。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const stage = read('web', 'src', 'ui', 'fxDailyStage.ts');
const appTs = read('web', 'src', 'ui', 'app.ts');
const css = read('web', 'src', 'styles', 'ui-template.css');

const num = (name) => {
  const match = new RegExp(`export const ${name} = ([0-9.]+)`).exec(stage);
  assert.ok(match, `${name} 不见了（结构变了？）`);
  return Number(match[1]);
};

test('内容就是「今日推荐」四个字，一宫一字', () => {
  assert.match(stage, /export const FX_DAILY_TEXT = '今日推荐'/);
  const dirs = /export const FX_DAILY_DIRS[^=]*=\s*\[([^\]]*)\]/.exec(stage);
  assert.ok(dirs, '找不到 FX_DAILY_DIRS');
  const list = Array.from(dirs[1].matchAll(/'(top|right)'/g)).map((m) => m[1]);
  assert.strictEqual(list.length, 4, '四个方向对应四个字');
  assert.ok(list.includes('top') && list.includes('right'), '维护者要求「从上、从右」两种滑入都要有');
});

test('闪烁只发生在划入前段：4 次、每个状态 1 帧（比上一版快 0.5x）', () => {
  assert.strictEqual(num('FX_DAILY_FPS'), 60);
  assert.strictEqual(num('FX_DAILY_BLINK_FLASHES'), 4, '维护者：闪烁次数为 4 次');
  assert.strictEqual(num('FX_DAILY_BLINK_STEP'), 1, '每个状态 1 帧 = 比上一版快 0.5x');
  assert.strictEqual(num('FX_DAILY_BLINK_FRAMES'), 8, '4 次闪 = 亮灭各 4 帧 = 8 帧');
  assert.ok(num('FX_DAILY_BLINK_FRAMES') < num('FX_DAILY_ENTER_FRAMES'), '闪烁必须在滑入之内就结束');
  assert.match(stage, /Math\.floor\(local \/ FX_DAILY_BLINK_STEP\) % 2 === 0/, '闪烁的占空比实现不见了');
  assert.match(stage, /local < FX_DAILY_BLINK_FRAMES/, '闪烁窗口没有按帧收手');
});

test('划入很快（20 帧），落字在滑入结束之前', () => {
  assert.strictEqual(num('FX_DAILY_ENTER_FRAMES'), 20);
  assert.match(
    stage,
    /export const FX_DAILY_TOTAL_FRAMES = FX_DAILY_ENTER_FRAMES \+ FX_DAILY_STAGGER_MAX_FRAMES/,
    '总长 = 滑入 + 最大单字延迟（最晚起跑的字也要滑完）',
  );
  const resolve = num('FX_DAILY_RESOLVE_FRAME');
  assert.ok(resolve < num('FX_DAILY_ENTER_FRAMES'), '落字必须早于滑入结束（维护者：结束前已停止闪烁与随机字体）');
  assert.ok(resolve > num('FX_DAILY_BLINK_FRAMES'), '落字必须晚于闪烁窗口');
  // 标题现在可切（今日推荐 / 私人雷达），落字要回到「当前标题」而不是写死常量。
  assert.match(stage, /cell\.textContent = wordText\[index\]/, '落字没回到本身的字');
  assert.match(stage, /let wordText: string = FX_DAILY_TEXT/, '标题默认值必须还是今日推荐');
  assert.match(stage, /FX_DAILY_FINAL_FONT/, '落字没有定字体');
});

test('闪烁时的字形与字体是随机的，而且闪烁结束后就不再换', () => {
  // 每闪一次换一套：闪烁窗口内按「第几次闪」计数，变了才 scatter。 
  assert.match(stage, /if \(blinking && !settled\)/, '随机换字必须限定在闪烁窗口内');
  assert.match(stage, /const flash = Math\.floor\(local \/ \(2 \* FX_DAILY_BLINK_STEP\)\)/, '没有按「第几次闪」计步');
  assert.match(stage, /flash !== \(scrambleSteps\[index\] \?\? -1\)/, '没有「同一闪内不重复换」的判断');
  assert.match(stage, /SCRAMBLE_GLYPHS\[Math\.floor/, '闪烁时没有换字形');
  assert.match(stage, /randomOf\(FX_DAILY_FONTS\)/, '闪烁时没有换随机字体');
});

test('进场是从窗口外划进来，不是在画面里挪一小段', () => {
  assert.match(stage, /window\.innerWidth/, '没有按窗口宽度算起始位移');
  assert.match(stage, /vw - rect\.left \+ 40/, '右侧进来的字没有排到窗口右缘之外');
  assert.match(stage, /-\(rect\.bottom \+ 40\)/, '上方进来的字没有排到窗口顶端之上');
});

test('版式：紧凑 2×2 贴着右上区域，粗笔画、无 will-change', () => {
  const block = /\.fx-daily \{[\s\S]*?\n\}/.exec(css);
  assert.ok(block, '样式里找不到 .fx-daily');
  assert.match(block[0], /right: clamp/, '应锚在右侧（维护者圈的是右上区域）');
  assert.match(block[0], /top: clamp/, '应锚在顶部');
  assert.match(block[0], /grid-template-columns: auto auto/, '不是两列宫格');
  assert.match(block[0], /pointer-events: none/, '内容层不能吃掉窗口拖动');

  const cell = /\.fx-daily-cell \{[\s\S]*?\n\}/.exec(css);
  assert.ok(cell, '样式里找不到 .fx-daily-cell');
  assert.match(cell[0], /font-size: clamp/, '大字没有跟窗口缩放');
  assert.match(block[0], /gap: 0/, '四字要贴在一起，宫格不能留缝');
  assert.match(cell[0], /line-height: 1;/, '行高收在 1：再收就会笔画互压');
  assert.match(cell[0], /letter-spacing: 0;/, '字距 0 就够了，收负会叠字');
  assert.match(cell[0], /font-weight: [789]00/, '维护者要粗笔硬朗');
  assert.match(cell[0], /-webkit-text-stroke: 0\.0\d+em/, '艺术字效果靠同色描边把笔画加粗');
  assert.doesNotMatch(cell[0], /will-change/, 'will-change 会让整层在 WebView2 上拍不到，别加回来');
});

test('减弱动效时直接落字，不闪不滑', () => {
  assert.match(stage, /prefers-reduced-motion: reduce/, '没有处理 reduce motion');
  assert.match(stage, /if \(reduce\) \{\s*settle\(\);/, 'reduce motion 下应直接落字');
});

test('顶部封面渐变：白色起头往下露出封面，没在播时自动轮换', () => {
  const cover = /\.fx-cover \{[\s\S]*?\n\}/.exec(css);
  assert.ok(cover, '样式里找不到 .fx-cover');
  assert.match(cover[0], /height: calc\(var\(--fx-cover-h\) \+ var\(--topbar-total\)\)/, '封面高度要跟网格分界共用同一个变量（并额外加上顶栏总高度顶到窗口沿）');
  assert.match(cover[0], /top: calc\(-1 \* var\(--topbar-total\)\)/, '封面带要向上探过顶栏，顶到窗口最上沿');
  const wash = /\.fx-cover-wash \{[\s\S]*?\n\}/.exec(css);
  assert.ok(wash, '缺少盖住封面的白色渐变层');
  assert.match(wash[0], /linear-gradient\(\s*to bottom/, '封面渐变必须是从上往下的线性渐变');
  assert.match(wash[0], /--fx-wash, #fff/, '顶部必须是白色（维护者：顶部是白色渐变）');
  assert.ok(num('FX_COVER_ROTATE_MS') >= 3000 && num('FX_COVER_ROTATE_MS') <= 12000, '轮换间隔应在 3–12 秒');
  assert.match(stage, /window\.setInterval\(rotateStep, FX_COVER_ROTATE_MS\)/, '没有自动轮换');
  assert.match(stage, /const stopRotate = /, '选中歌曲后要能停下来');
});

test('下方歌曲网格：每张卡都是独立内容物（不共享节点）', () => {
  const grid = /\.fx-cards \{[\s\S]*?\n\}/.exec(css);
  assert.ok(grid, '样式里找不到 .fx-cards');
  assert.match(grid[0], /grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/, '要自适应网格');
  assert.match(grid[0], /bottom: 96px/, '网格要往上让开播放条');
  const card = /\.fx-card \{[\s\S]*?\n\}/.exec(css);
  assert.ok(card, '样式里找不到 .fx-card');
  assert.match(card[0], /aspect-ratio: 1/, '卡片必须是正方形');
  // 独立性：每张卡在工厂里现造自己的 img / meta 节点，而不是克隆一份模板或复用同一个节点。
  assert.match(stage, /const buildCard = \(track: OnlineTrack, index: number\)/, '没有逐卡构造');
  assert.match(stage, /card\.dataset\.key = trackKey\(track\)/, '每张卡要带自己的 key，后续排布动画才认得');
  assert.match(stage, /grid\.append\(card\)/, '卡片要逐张独立入格');
  assert.match(stage, /cards: \(\) => cardNodes\.slice\(\)/, '要能把独立卡片交出去给排布动画用');
});
