const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'src/ui/motion.ts'), 'utf8');

// 统一运动系统的契约：三档时长、统一缓动、入场/出场/打断三件套。
test('统一档位与缓动（和今日推荐页一致）', () => {
  assert.match(src, /fast:\s*260/, 'fast 260ms');
  assert.match(src, /base:\s*420/, 'base 420ms');
  assert.match(src, /slow:\s*620/, 'slow 620ms');
  assert.match(src, /ease:\s*'cubic-bezier\(\.16, \.84, \.24, 1\)'/, '统一缓动');
  assert.match(src, /riseIn:\s*14/);
  assert.match(src, /riseOut:\s*10/);
  assert.match(src, /blur:\s*6/);
});

test('入场：从下方位移 + 模糊里出来', () => {
  assert.match(src, /const KEYFRAMES_IN[\s\S]*?opacity:\s*0[\s\S]*?translate3d\(0, \$\{riseIn\}px, 0\)[\s\S]*?filter:\s*`blur\(\$\{blur\}px\)`/);
  assert.match(src, /const KEYFRAMES_IN[\s\S]*?opacity:\s*1[\s\S]*?translate3d\(0, 0, 0\)/);
});

test('出场：往上一同幅度走掉，和入场同一套位移语言', () => {
  assert.match(src, /const KEYFRAMES_OUT[\s\S]*?opacity:\s*1[\s\S]*?opacity:\s*0/);
  assert.match(src, /const KEYFRAMES_OUT[\s\S]*?translate3d\(0, \$\{-riseOut\}px, 0\)/);
});

test('打断：每个元素只留一条动画，重复调用先 cancel', () => {
  assert.match(src, /const running = new WeakMap/, '每元素一条动画');
  assert.match(src, /const cancelOne = \(el: Element\): void => \{[\s\S]*?current\.cancel\(\)/, 'cancelOne 要真正 cancel');
  assert.match(src, /export function enter[\s\S]*?cancelOne\(el\)/, 'enter 先 cancel 旧的');
  assert.match(src, /export function leave[\s\S]*?cancelOne\(el\)/, 'leave 先 cancel 旧的');
  assert.match(src, /export function cancel\(el: Element\): void \{\s*cancelOne\(el\);\s*\}/, '对外 cancel');
});

test('尊重系统「减少动效」', () => {
  assert.match(src, /prefers-reduced-motion: reduce/);
  assert.match(src, /export const prefersReducedMotion/);
});
