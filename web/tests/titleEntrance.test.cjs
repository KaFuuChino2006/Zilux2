const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const title = fs.readFileSync(path.join(root, 'src/ui/titleEntrance.ts'), 'utf8');
const entrance = fs.readFileSync(path.join(root, 'src/ui/blockEntrance.ts'), 'utf8');
const home = fs.readFileSync(path.join(root, 'src/ui/home.ts'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/ui/app.ts'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src/styles/app.css'), 'utf8');

// 页面顶部的大字标题：维护者 2026-11-22 先要「像今日推荐那几个字」，看过第一版
// （从屏幕外飞进来）之后否掉：「这个飞进来太丑了，而且其他页面还不生效，重新优化」。
// 现在的口径是「字一个个浮上来」：只有小位移，逐字错帧，画面里所有页面的标题都要有。
// 不带模糊 —— filter 会让文字进离屏表面，静态之后字会糊（2026-11-22 第四轮反馈）。
test('入场是「浮上来」不是「飞进来」', () => {
  assert.match(title, /export class TitleEntrance/);
  assert.match(title, /const ENTER_STEP = \d+;/, '逐字步长');
  assert.match(title, /const ENTER_JITTER = \d+;/, '逐字再抖一点，别读成打字机');
  assert.match(title, /const ENTER_MAX_DELAY = \d+;/, '长标题不拖尾');
  assert.doesNotMatch(title, /measureTravel|MIN_TRAVEL|GLYPH_POOL|FX_DAILY_FONTS/, '不许再量「从窗外」的距离、不换随机字形');
  assert.match(css, /\.title-char\.is-char-in\s*\{[^}]*animation:\s*title-char-in/);
  const charIn = css.slice(css.indexOf('@keyframes title-char-in'), css.indexOf('@keyframes title-char-out'));
  assert.match(charIn, /translate3d\(0, 12px, 0\)/);
  assert.doesNotMatch(charIn, /filter:/, '逐字不许挂滤镜');
});

test('出场：同一条轨迹反过来，越靠后的字先走', () => {
  assert.match(title, /leave\(\): Promise<void>/);
  assert.match(title, /\(count - 1 - index\) \* LEAVE_STEP/, '反向错帧');
  const charOut = css.slice(css.indexOf('@keyframes title-char-out'), css.indexOf('@keyframes block-in-fade'));
  assert.match(charOut, /translate3d\(0, -8px, 0\)/);
  assert.doesNotMatch(charOut, /filter:/, '逐字不许挂滤镜');
});

test('打断：同一块标题上只留一段，先落到最终态再开新的', () => {
  assert.match(title, /play\(delayMs = 0\): void \{\s*\n\s*\/\/[^\n]*\n\s*this\.stop\(\);/, 'play 先 stop');
  assert.match(title, /leave\(\): Promise<void> \{\s*\n\s*this\.stop\(\);/, 'leave 先 stop');
  assert.match(title, /private resolveLeave\(\)/, '等待方被打断也要放行');
});

test('尊重系统「减少动效」', () => {
  assert.match(title, /prefersReducedMotion/);
  assert.match(css, /prefers-reduced-motion: reduce\)[\s\S]{0,400}\.title-char\.is-char-in/);
});

test('拆开的字要能承载 transform', () => {
  assert.match(css, /\.title-char\s*\{[^}]*display:\s*inline-block/);
  // will-change 只在动画期间挂，收完必须放手（常驻会让字一直留在合成层里发糊）。
  assert.doesNotMatch(css, /\.title-char\s*\{[^}]*will-change/);
  assert.match(css, /\.title-char\.is-char-in[^{]*\{[^}]*will-change:\s*transform, opacity/);
});

test('容器让位：带标题的那块只做纯淡入，不跟字的轨迹抢', () => {
  assert.match(entrance, /titles\?: string/, 'BlockEntrance 支持 titles');
  assert.match(entrance, /const titled = this\.titleBlock\(el\)/, '只有顶栏才降级');
  assert.match(entrance, /private titleBlock\(el: HTMLElement\): boolean/, '判定单独收在一处');
  assert.match(entrance, /const variant = titled\s*\n\s*\? 'fade'/, '带标题的容器只淡入');
  const fadeIn = css.slice(css.indexOf('@keyframes block-in-fade'), css.indexOf('@keyframes block-out-fade'));
  assert.match(fadeIn, /opacity:\s*0/);
  assert.match(fadeIn, /opacity:\s*1/);
  const fadeOut = css.slice(css.indexOf('@keyframes block-out-fade'), css.indexOf('@keyframes block-in-leaf-left'));
  assert.match(fadeOut, /opacity:\s*1/);
  assert.match(fadeOut, /opacity:\s*0/);
  assert.match(entrance, /if \(el\.matches\(this\.options\.titles\)\) return el;/, '标题自己也是目标时要认出来');
});

test('所有页面的顶部大字都接上，不只是海报墙', () => {
  assert.match(app, /const WALL_TITLES = '\.wall-title, \.disc-sub-title'/);
  assert.match(app, /titles: WALL_TITLES/);
  assert.match(home, /const HOME_TITLES = '\.ui-section-title, \.daily-title'/);
  assert.match(home, /titles: HOME_TITLES/);
});

test('重开与销毁都不能留半截', () => {
  assert.match(entrance, /private titledTargets = new WeakSet<HTMLElement>/, '只查记过有标题的块');
  assert.match(entrance, /if \(this\.titledTargets\.has\(el\)\)/, '清场前先让标题落定');
  assert.match(entrance, /if \(!this\.titledTargets\.has\(el\)\) continue;/, '出场时标题一起退');
  assert.match(entrance, /for \(const motion of this\.titleInstances\) motion\.dispose\(\)/, '销毁时收干净');
});

// 2026-11-22 维护者：「我喜欢啊，最近播放啊什么的这些页面的左上角的大字还没做吗」
// 根因：`.wall-head` 是墙宿主的直接子节点，querySelectorAll 不含自身，标题从来没进过目标表。
test('宿主直接子节点自己命中也算目标', () => {
  assert.match(entrance, /if \(block\.matches\(selector\)\) found\.push\(block\)/, '自己命中要收进来');
  assert.match(entrance, /found\.push\(\.\.\.Array\.from\(block\.querySelectorAll<HTMLElement>\(selector\)\)\)/);
});

// 2026-11-22 维护者：「首页这几个大方块的动画没有，里面的内容有」
// 根因：`titleOf()` 只要块里**嵌着**标题就返回标题 → 整张 `.daily-card` 被判成「带标题的容器」降级成 fade，
// 于是只有里面的 `.daily-title` 在逐字动，卡片本体一动不动。
test('卡片里嵌着标题不算「标题容器」，卡片本体照常翻', () => {
  assert.match(entrance, /if \(el\.matches\(this\.options\.titles\)\) return true;/, '标题自己就是这块才算');
  assert.match(
    entrance,
    /return this\.options\.heads \? el\.matches\(this\.options\.heads\) : false;/,
    '顶栏（.wall-head / .ui-section-head）也算，卡片不算',
  );
});

// 2026-11-22 维护者：「我的歌单页面的歌单动效有问题」
// 根因：整页区块装在 `.playlists-page` 这一层 wrapper 里，只按宿主直接子节点分组 → 整页一次偏置、糊成一团。
test('多区块 wrapper 拆层分组 + 异步补进来的歌单自己补入场', () => {
  assert.match(entrance, /const GROUP_WRAPPERS = '\.playlists-page'/, '记下要拆层的容器');
  assert.match(entrance, /section\.matches\(GROUP_WRAPPERS\) && section\.children\.length > 1/, 'wrapper 要再拆一层');
  assert.match(app, /const fresh = Array\.from\(host\.querySelectorAll<HTMLElement>\('\.section-title, \.ui-tile'\)\)/, '在线歌单到位后取新块');
  assert.match(app, /if \(fresh\.length > 0 && motion\.isVisible\(\)\) motion\.playOn\(fresh\)/, '新块自己补一次入场');
});

// 2026-11-22 维护者：「为什么推荐歌单进入的时候还会二次加载动画的」
// 空壳（只有顶栏、没有卡片/行）不许演入场，否则数据回来还要再演一次。
test('「加载中」空壳不加入场，等真实内容回来只演一次', () => {
  assert.match(entrance, /if \(!this\.hasTargets\(\)\) return;/, '没有内容块就不播');
  assert.match(entrance, /hasTargets\(\): boolean[\s\S]{0,80}querySelector\(this\.options\.items\) !== null/, '只认内容块，标题不算');
});

// 2026-11-22 维护者：「现在的界面切换又变成内容全展示过了零点几秒后又重新出动画了」
// 根因：静默重铺（续页 / 合并本地收藏 / 后台刷新）也会走 appendPosters，它无条件逐张入场；
// 另外「我喜欢的音乐」是先 switchStageLayer 再 await 网络，旧一屏会原样挂着等数据。
test('静默重铺不许把整页再演一遍，只有新并进来的才落地', () => {
  assert.match(app, /const revealFrom = animateFrom \?\? \(skipEnter \? Number\.POSITIVE_INFINITY : 0\);/, '静默重铺默认一张都不入场');
  assert.match(app, /private appendPosters\([\s\S]{0,240}animateFrom = 0,/, 'appendPosters 要能指定起点');
  assert.match(app, /if \(cursor >= animateFrom\) fresh\.push\(node\);/, '只有下标之后的才收进入场批次');
  assert.match(app, /this\.paintWall\(true, true, before\);/, '合并本地收藏只让新增那批落地');
  assert.match(app, /this\.appendPosters\(grid, tracks, 0, tracks, revealFrom\);/, '首屏渲染把起点传下去');
});

test('切页先铺这一页的空壳，不让旧一屏挂在台上等网络', () => {
  const liked = app.slice(app.indexOf('private async showLiked('), app.indexOf('private async loadLikedMerged('));
  assert.doesNotMatch(liked, /void this\.switchStageLayer\(this\.wallHost\);/, '点击时就要换页，不能等 load 完');
  assert.match(liked, /this\.renderWall\(\);\s*\n\s*if \(!anyOnline\) return;/, '先铺壳再等数据');
});

// 2026-11-22 维护者：「用鼠标侧键前进后退的时候这个动画和我直接点击触发的是不一样的」
// 根因：applyNavSnapshot 自己 toggle is-hidden，旧一屏当场消失、动画只在新页上播。
// 规矩：侧键返回/前进一律交给 switchStageLayer 接层，函数里不许再手改舞台层显隐。
test('侧键返回/前进与点击导航共用一套换层动画', () => {
  const body = app.slice(app.indexOf('private applyNavSnapshot('), app.indexOf('private navigateBack('));
  assert.doesNotMatch(body, /classList\.toggle\('is-hidden'/, '不许自己改舞台层显隐');
  assert.match(body, /void this\.switchStageLayer\(this\.homeHost\);/, '回首页也走换层');
  assert.match(body, /this\.renderWall\(\);/, '回墙体页由 renderWall 铺内容并接层');
});

// 先铺空壳、再等接口的页面会被两次铺场叠在一起：空壳那一次排在 leave 之后，
// 等接口把内容铺完它才落地，看起来就是「内容全出来后过零点几秒又重新入场」。
test('真正铺内容就作废还在等出场的那一次', () => {
  const paint = app.slice(app.indexOf('private paintWall('), app.indexOf('private paintWall(') + 400);
  assert.match(paint, /this\.wallSwapToken \+= 1;/, '每次铺场都要作废挂起的换页');
});

// 2026-11-22 维护者：「这个推荐歌单连动画都没有了」
// 根因：推荐歌单先铺空壳、旧一屏的出场还在排队，接口就把真内容送来了；
// play() 里「正在退场就 return」直接把这一次入场吃掉，整页从此静止。
test('还在退场时也要能开新的，不能整页没动画', () => {
  const body = entrance.slice(entrance.indexOf('play(): void {'), entrance.indexOf('reveal(): void {'));
  assert.doesNotMatch(body, /if \(this\.leaveDone\) return;/, '不许因为出场未收完就跳过入场');
  assert.match(body, /this\.finishLeave\(\);/, '先收尾再开新的');
});
