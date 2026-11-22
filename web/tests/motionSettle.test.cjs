'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
const block = read('src', 'ui', 'blockEntrance.ts');
const title = read('src', 'ui', 'titleEntrance.ts');
const motion = read('src', 'ui', 'motion.ts');
const css = read('src', 'styles', 'app.css');
const docs = read('..', 'docs', 'zilux2-ui-templates.md');

// 维护者 2026-11-22 连着报了两个症状：
//   ①「动画结束后那些变化的字体之类的会微动一次，像是挤压变化一样的」/「感觉位移了一下」
//   ②「文字是有点模糊的，这个模糊是概率性的」
// 两个坑来自同一条链：3D（perspective/rotateY）让文字进 3D 渲染表面、filter（哪怕 blur(0)）
// 让文字进离屏滤镜表面 —— 一撤就整块重栅格化（位移）；一直留着又按动画期间的栅格比例定格（糊）。
// 现在的规矩：变体只许 2D、不许 filter，最后一帧就是恒等变换；落定即 transform: none，
// 两帧后把类也摘掉，文字回主线程按设备像素重画。几何两边一致，所以既不糊也不跳。

test('入场结束后切到落定态，而不是摘回裸元素', () => {
  assert.match(block, /const SETTLE_CLASS = 'is-block-settled';/);
  assert.match(
    block,
    /el\.classList\.remove\(IN_CLASS\);\s*el\.classList\.add\(SETTLE_CLASS\);/,
    '收尾要换类，不能只 remove',
  );
  assert.match(block, /\.querySelectorAll<HTMLElement>\(`\.\$\{IN_CLASS\}, \.\$\{OUT_CLASS\}, \.\$\{SETTLE_CLASS\}`\)/);
  assert.match(block, /el\.classList\.remove\(IN_CLASS, OUT_CLASS, SETTLE_CLASS\);/);
});

test('收尾不再抄动画最后一帧的矩阵与滤镜（抄 3D 矩阵再撤 = 像素级位移）', () => {
  assert.doesNotMatch(block, /SETTLE_TRANSFORM_VAR/);
  assert.doesNotMatch(block, /SETTLE_FILTER_VAR/);
  assert.doesNotMatch(block, /getComputedStyle\(el\)/);
  assert.doesNotMatch(motion, /SETTLE_TRANSFORM_VAR/);
  assert.doesNotMatch(motion, /SETTLE_FILTER_VAR/);
});

test('落定类就是自然态：transform: none，不留 will-change', () => {
  const rule = css.slice(css.indexOf('.is-block-settled {'));
  const body = rule.slice(0, rule.indexOf('}') + 1);
  assert.match(body, /transform: none;/);
  assert.doesNotMatch(body, /will-change/, '留层会让文字按动画期间的栅格比例定格 → 发糊');
  assert.doesNotMatch(body, /filter:/);

  const motionRule = css.slice(css.indexOf('.is-motion-settled {'));
  const motionBody = motionRule.slice(0, motionRule.indexOf('}') + 1);
  assert.match(motionBody, /transform: none;/);
  assert.doesNotMatch(motionBody, /will-change/);
});

test('逐块变体只许 2D、不许 filter（3D / filter 都会换渲染表面）', () => {
  const start = css.indexOf('@keyframes block-in-leaf-left {');
  // 换行符不敏感：app.css 是 CRLF，按 '\n' 找会永远找不到，end 变成 -1 后整段尾巴都会被当成「变体段」。
  const endMatch = /@media \(prefers-reduced-motion: reduce\) \{\s*\.is-block-in,/.exec(css);
  const end = endMatch ? endMatch.index : -1;
  const pool = css.slice(start, end);
  assert.ok(pool.length > 1000, '关键帧块要能找到');
  assert.doesNotMatch(pool, /perspective\(/, '3D 会让文字进 3D 渲染表面');
  assert.doesNotMatch(pool, /rotate[XY]\(/, '不许用三维旋转');
  assert.doesNotMatch(pool, /filter:/, 'filter 会把文字画进离屏表面');
  // 最后一帧必须是恒等变换，落定才敢直接写 none
  assert.match(pool, /transform: translate3d\(0, 0, 0\) rotate\(0deg\) scale\(1\);/);
  assert.match(pool, /@keyframes block-in-soft \{/);
  assert.match(pool, /@keyframes block-in-haze \{/);
});

test('motion.ts 的换层/面板动画收尾也落定，不再裸 cancel', () => {
  assert.match(motion, /const SETTLE_CLASS = 'is-motion-settled';/);
  assert.match(
    motion,
    /if \(clear\) \{\s*\/\/[^\n]*\n\s*settle\(el\);/,
    'enter() 的 finish 必须先落定再 cancel',
  );
  assert.match(motion, /settle\(el\);\s*if \(el instanceof HTMLElement\) el\.style\.removeProperty\('opacity'\);/);
});

test('滚动容器不再做吸附（吸附会在入场结束后把整排挪几像素）', () => {
  assert.doesNotMatch(css, /scroll-snap-type:x proximity/);
  assert.doesNotMatch(css, /scroll-snap-align:start/);
});

test('标题逐字入场结束后桥接两帧，再放手摘类', () => {
  const enterTimer = title.slice(title.indexOf('this.enterTimer = window.setTimeout('));
  const body = enterTimer.slice(0, enterTimer.indexOf('maxDelay + MOTION.base + 90'));
  assert.match(body, /removeProperty\(ENTER_DELAY_VAR\)/);
  assert.match(body, /this\.scheduleRelease\(\)/, '两帧后才放手，不能当场摘');
  assert.doesNotMatch(body, /classList\.remove\(IN_CLASS\)/, '摘类交给 scheduleRelease 的下一帧');
  const release = title.slice(title.indexOf('private scheduleRelease()'));
  assert.match(release.slice(0, 600), /requestAnimationFrame\([\s\S]*requestAnimationFrame/);
  assert.match(release.slice(0, 600), /classList\.remove\(IN_CLASS\)/);
});

test('标题关键帧同样不带模糊，单字基类不常驻 will-change', () => {
  const keyframes = css.slice(css.indexOf('@keyframes title-char-in {'));
  const pool = keyframes.slice(0, keyframes.indexOf('@keyframes block-in-fade {'));
  assert.doesNotMatch(pool, /filter:/, '逐字模糊会把字画进离屏表面');
  assert.match(pool, /transform: translate3d\(0, 0, 0\);/);

  const base = css.slice(css.indexOf('.title-char {'));
  const body = base.slice(0, base.indexOf('}') + 1);
  assert.doesNotMatch(body, /will-change/);
  assert.doesNotMatch(body, /backface-visibility/);
  assert.match(css, /\.title-char\.is-char-in[^{]*\{[^}]*will-change: transform, opacity/);
});

test('落定态只在桥接期间存在，两帧后必须放手回主线程重画', () => {
  assert.match(block, /private releaseSettleSoon\(el: HTMLElement\)/);
  assert.match(block, /private stopRelease\(\)/);
  assert.match(block, /classList\.remove\(SETTLE_CLASS\)/);
  assert.match(motion, /const scheduleRelease = \(el: Element\): void => \{/);
  assert.match(motion, /const dropSettle = \(el: HTMLElement\): void => \{/);
  assert.match(motion, /el\.classList\.add\(SETTLE_CLASS\);\s*\]?\s*scheduleRelease\(el\);/, '落定后必须排上「放手」');
});

test('标题落定时不改文本节点（换文本会重新排版）', () => {
  assert.match(title, /if \(cell\.textContent !== ch\) cell\.textContent = ch;/);
});

test('文档口径同步：变体只许 2D、落定回自然态', () => {
  assert.match(docs, /is-block-settled/);
  assert.match(docs, /is-motion-settled/);
  assert.match(docs, /2D/);
});
