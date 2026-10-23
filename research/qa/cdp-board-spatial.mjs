// 验证设置面板是否真的“在 3D 空间里”：平移/缩放视角时面板留在空间原位、出现视差与透视
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
  send('Input.dispatchMouseEvent', { type, x, y, clickCount: 1, ...extra });
const dbg = () => evalJs('window.__boardDebug ? window.__boardDebug() : null');
const brief = (d) =>
  d && {
    open: d.openAmount,
    pos: d.panelPos,
    cam: d.camPos,
    scr: d.panelScreen && { x: +d.panelScreen.x.toFixed(3), y: +d.panelScreen.y.toFixed(3) },
    scrH: d.panelScreenH && +d.panelScreenH.toFixed(3),
  };

await send('Page.enable');
await send('Runtime.enable');
await wait(600);
const info = await evalJs(`({ href: location.href, cls: document.querySelector('.space-shell')?.className ?? null })`);
console.log('page:', JSON.stringify(info));

const entered = await evalJs(`document.querySelector('.space-shell')?.classList.contains('is-entered') ?? false`);
if (!entered) {
  await evalJs(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => /进入|直接进入/.test(b.textContent || ''));
    if (btn) btn.click();
    return true;
  })()`);
  await wait(2500);
}
const view = await evalJs('({ w: innerWidth, h: innerHeight })');
const cx = Math.round(view.w / 2);
const cy = Math.round(view.h / 2);
const wheelAt = async (fx, fy, deltaY) => {
  const x = Math.round(view.w * fx);
  const y = Math.round(view.h * fy);
  await mouse('mouseMoved', x, y, { button: 'none', buttons: 0 });
  await wait(100);
  await mouse('mouseWheel', x, y, { deltaY, deltaX: 0 });
  await wait(750);
};
console.log('view:', JSON.stringify(view));

// 1) 打开面板：应出现在视野正中、约 74% 屏高
await evalJs(`document.querySelector('[data-rail="settings"]')?.click()`);
await wait(1600);
const d0 = await dbg();
console.log('opened:', JSON.stringify(brief(d0)));
await shot('spatial-1-open.png');

// 2) 面板内滚轮：滚动内容、面板本身不动
await wheelAt(d0.panelScreen.x, d0.panelScreen.y, 240);
const d1 = await dbg();
console.log('inside wheel: scroll=', d1.scroll, JSON.stringify(brief(d1)));
await shot('spatial-2-scrolled.png');

// 3) 点 × 关闭（面板还是正常大小，坐标可靠）
const cl = await evalJs('window.__boardDebug().panelToScreen(918, 60)');
console.log('close btn screen:', JSON.stringify(cl));
const cxp = Math.round(cl.x * view.w);
const cyp = Math.round(cl.y * view.h);
await mouse('mouseMoved', cxp, cyp, { button: 'none', buttons: 0 });
await wait(150);
await mouse('mousePressed', cxp, cyp, { buttons: 1 });
await wait(90);
await mouse('mouseReleased', cxp, cyp, { buttons: 0 });
await wait(1000);
const d2 = await dbg();
console.log('after close click:', JSON.stringify({ open: d2 && d2.openAmount }));
await shot('spatial-3-closed.png');

// 4) 重新打开：回到当前视野正前方
await evalJs(`document.querySelector('[data-rail="settings"]')?.click()`);
await wait(1500);
const d3 = await dbg();
console.log('reopened:', JSON.stringify(brief(d3)));
await shot('spatial-4-reopened.png');

// 5) 中键平移相机：面板留在世界原位，屏幕上发生视差位移
await mouse('mouseMoved', cx, cy, { button: 'none', buttons: 0 });
await wait(80);
await mouse('mousePressed', cx, cy, { button: 'middle', buttons: 4 });
for (let i = 1; i <= 8; i++) {
  await mouse('mouseMoved', cx + i * 34, cy + i * 8, { button: 'middle', buttons: 4 });
  await wait(40);
}
await mouse('mouseReleased', cx + 272, cy + 64, { button: 'middle', buttons: 0 });
await wait(800);
const d4 = await dbg();
console.log('after pan:', JSON.stringify(brief(d4)));
await shot('spatial-5-pan.png');

// 6) 板外滚轮缩放：面板在世界里不动，屏幕尺寸按透视放大
await wheelAt(0.06, 0.5, -260);
const d5 = await dbg();
console.log('after zoom-in:', JSON.stringify(brief(d5)));
await shot('spatial-6-zoom.png');

// 7) Esc 关闭面板（空间里的面板可能被转出视野，留键盘出口）
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await wait(1000);
const d6 = await dbg();
console.log('after Esc:', JSON.stringify({ open: d6 && d6.openAmount }));
console.log('class after Esc:', await evalJs(`document.querySelector('.space-shell')?.className`));
await shot('spatial-7-esc.png');

console.log('done');
ws.close();
process.exit(0);
