// 验证打包后的真实 App（WebView2, CDP 9333）里 3D 设置面板的三项功能
import { writeFileSync } from 'node:fs';

const CDP = `http://127.0.0.1:${process.env.CDP_PORT ?? '9333'}`;
const OUT = 'E:/Zilux2开发/research/shots/';
const targets = await (await fetch(`${CDP}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
if (!page) throw new Error('no page target');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
await new Promise((r) => ws.addEventListener('open', r));
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.text };
  return r.result?.result?.value;
};
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(OUT + name, Buffer.from(r.result.data, 'base64'));
  console.log('shot', name);
};
const mouse = (type, x, y, extra = {}) =>
  send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
const click = async (x, y) => {
  await mouse('mouseMoved', x, y, { button: 'none', clickCount: 0 });
  await wait(120);
  await mouse('mousePressed', x, y, { buttons: 1 });
  await wait(90);
  await mouse('mouseReleased', x, y, { buttons: 0 });
  await wait(500);
};
const dbg = () => evalJs('window.__boardDebug ? window.__boardDebug() : null');

await send('Page.enable');
await send('Runtime.enable');
await wait(600);

const info = await evalJs(`({ href: location.href, cls: document.querySelector('.space-shell')?.className ?? null })`);
console.log('page:', JSON.stringify(info));

// 未进入空间则先进入
const entered = await evalJs(`document.querySelector('.space-shell')?.classList.contains('is-entered') ?? false`);
if (!entered) {
  const ok = await evalJs(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => /进入|直接进入/.test(b.textContent || ''));
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  console.log('enter clicked:', ok);
  await wait(2500);
}
const cls1 = await evalJs(`document.querySelector('.space-shell')?.className ?? null`);
console.log('class entered:', cls1);

// 打开设置面板（rail 按钮 idle 时不可见，但 JS click 有效）
await evalJs(`document.querySelector('[data-rail="settings"]')?.click()`);
await wait(1600);
const cls2 = await evalJs(`document.querySelector('.space-shell')?.className ?? null`);
console.log('class board-open:', cls2);
const d0 = await dbg();
console.log('debug open:', JSON.stringify(d0 && { openAmount: d0.openAmount, offsetX: d0.offsetX, offsetY: d0.offsetY }));
await shot('app-1-open.png');

// 读取面板在屏幕上的位置，算出屏幕坐标（供滚轮/点击）
const geom = await evalJs(`(() => {
  const d = window.__boardDebug && window.__boardDebug();
  if (!d) return null;
  const { PLANE_W, PLANE_H } = d;
  return { panelH: d.panelH, planeW: PLANE_W, planeH: PLANE_H };
})()`);
console.log('geom:', JSON.stringify(geom));

// ① 面板内滚轮：鼠标停在面板中部
const view = await evalJs('({ w: innerWidth, h: innerHeight })');
console.log('view:', JSON.stringify(view));
const cx = Math.round(view.w / 2);
const cy = Math.round(view.h / 2);
await mouse('mouseMoved', cx, cy, { button: 'none', clickCount: 0 });
await wait(200);
await mouse('mouseWheel', cx, cy, { deltaY: 260, deltaX: 0 });
await wait(800);
const d1 = await dbg();
console.log('after inside-wheel scroll=', d1.scroll, 'offset=', d1.offsetX, d1.offsetY);
await shot('app-2-scrolled.png');

// 滚动后点第 6 行分段（默认音源 QQ 音乐）验证滚动命中：先滚到底再点
await mouse('mouseWheel', cx, cy, { deltaY: 600, deltaX: 0 });
await wait(900);
const d2 = await dbg();
console.log('scroll to bottom=', d2.scroll, '/', d2.scrollTarget);
await shot('app-3-bottom.png');

// ② 拖动：面板高度占视口 0.74，标题栏在面板顶部约 9% 高度处
const panelScreenH = Math.round(view.h * 0.74);
const panelTop = Math.round((view.h - panelScreenH) / 2);
const titleY = panelTop + Math.round(panelScreenH * 0.09);
console.log('drag title point:', cx, titleY);
await mouse('mouseMoved', cx, titleY, { button: 'none', clickCount: 0 });
await mouse('mousePressed', cx, titleY, { buttons: 1 });
for (let i = 1; i <= 8; i++) {
  await mouse('mouseMoved', cx - i * 40, titleY - i * 14, { buttons: 1 });
  await wait(40);
}
await mouse('mouseReleased', cx - 320, titleY - 112, { buttons: 0 });
await wait(500);
const d3 = await dbg();
console.log('after drag offset=', d3.offsetX, d3.offsetY, 'open=', d3.openAmount);
await shot('app-4-dragged.png');

// ③ 板外滚轮：面板已移到左上，右侧空白处滚轮应缩放场景、面板不动
await mouse('mouseMoved', Math.round(view.w * 0.82), Math.round(view.h * 0.62), { button: 'none', clickCount: 0 });
await mouse('mouseWheel', Math.round(view.w * 0.82), Math.round(view.h * 0.62), { deltaY: 320, deltaX: 0 });
await wait(700);
const d4 = await dbg();
console.log('after outside-wheel scroll=', d4.scroll, 'offset=', d4.offsetX, d4.offsetY);
await shot('app-5-outside-wheel.png');

// 点板外关闭
await click(Math.round(view.w * 0.86), Math.round(view.h * 0.7));
await wait(700);
const d5 = await dbg();
const cls3 = await evalJs(`document.querySelector('.space-shell')?.className ?? null`);
console.log('after outside click openAmount=', d5.openAmount, 'class=', cls3);
await shot('app-6-closed.png');

console.log('logs: done');
ws.close();
process.exit(0);
