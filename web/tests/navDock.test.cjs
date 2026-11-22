'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'app.ts'), 'utf8');
const docs = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'zilux2-ui-templates.md'), 'utf8');

// 2026-11-22 维护者：「有时候右键并不能跟随我的鼠标去显示导航栏，而是固定死中间然后动画在抽，
// 有时候又不显示，有时候又显示了又消失了，bug太多了，你重写这个逻辑」
// 根因：首页「右键只退场 + 指针一动又恢复常驻」和召唤流程互相抢；收场用 setTimeout 猜时长；
// 尾部的 restPlace() 会把刚召到光标的条又搬回中间。现在收敛成一个三态状态机。

test('导航条只有 pinned / summoned / idle 三个状态', () => {
  assert.match(app, /type DockMode = 'pinned' \| 'summoned' \| 'idle';/);
  assert.match(app, /let mode: DockMode = 'pinned';/);
});

test('召唤先等收场动画真的结束，再从光标处落点展开', () => {
  assert.match(app, /const summon = async \(centerX: number, centerY: number\): Promise<void> => \{/);
  assert.match(app, /const token = \+\+this\.dockSummonSeq;/, '每次召唤领序号');
  assert.match(app, /await hideDock\(\);[\s\S]{0,120}if \(token !== this\.dockSummonSeq\) return;/, '过期的召唤作废');
  assert.match(app, /placeAt\(centerX, centerY\);[\s\S]{0,200}showDock\(\);/);
  assert.doesNotMatch(app, /setTimeout\(summon, MOTION\.fast\)/, '不许再用 setTimeout 猜收场时长');
});

test('位置只在收着的状态改：收场回调里不再 restPlace', () => {
  assert.match(app, /const placeAt = \(centerX: number, centerY: number\): void => \{/);
  assert.match(app, /const hideDock = \(animate = true\): Promise<void> => \{[\s\S]{0,900}anim\.finished/, '收场等 finished');
  // 维护者 m01487：「点击其他地方使其消失后应该回到中间的原位」——收干净（已不可见）之后再归位。
  assert.match(app, /dock\.classList\.add\('is-dock-muted'\);[\s\S]{0,260}if \(mode !== 'pinned'\) restPlace\(\);/, '收完归位到窗口正中');
});

test('召唤态不跟指针，点别处 / Esc 才收；首页右键也是召唤', () => {
  assert.match(app, /if \(mode !== 'idle' \|\| isHidden\(\) \|\| this\.dockHideTimer\) return;/, '只有 idle 才按远离收');
  assert.match(app, /if \(mode !== 'summoned'\) return;[\s\S]{0,120}void hideDock\(\);/, '点别处收掉召唤');
  assert.match(app, /if \(event\.key !== 'Escape'\) return;[\s\S]{0,160}void hideDock\(\);/, 'Esc 收掉召唤');
  assert.match(app, /event\.preventDefault\(\);\s*void summon\(event\.clientX, event\.clientY\);/, '任意位置右键都召唤到光标');
  assert.doesNotMatch(app, /if \(this\.dockPinned\) \{[\s\S]{0,160}dockSetPinned\?\.\(false\);/, '首页右键不再只退场');
  assert.doesNotMatch(app, /else if \(this\.homeView\) \{/, '指针一动不再把条恢复成常驻');
});

test('常驻才居中，且每帧校正只在校正态里跑', () => {
  assert.match(app, /if \(mode !== 'pinned'\) return;\s*restPlace\(\);/, '离开常驻就停校正');
  assert.match(app, /if \(this\.dockPinned\) restPlace\(\);/, '观察器统一走 restPlace');
});

test('文档口径同步', () => {
  assert.match(docs, /### 10\.2 三个状态：pinned \/ summoned \/ idle/);
  assert.match(docs, /首页右键不再只退场/);
});
