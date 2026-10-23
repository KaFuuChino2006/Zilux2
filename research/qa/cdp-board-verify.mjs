// 3D 设置面板三项验收：①滚轮滚内容不缩放场景 ②拖动范围 ③MSDF 文字 + 控件交互
import { writeFileSync } from 'node:fs';

const CDP = 'http://127.0.0.1:9333';
const URL = 'http://127.0.0.1:4174/index.html?enter=1&instant=1&snap=1&mock=1';
const OUT = 'E:/Zilux2开发/research/shots/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`${CDP}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
if (!page) throw new Error('no page target');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0;
const pending = new Map();
const logs = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
  if (msg.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + JSON.stringify(msg.params.exceptionDetails).slice(0, 300));
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') logs.push('ERR: ' + JSON.stringify(msg.params.args).slice(0, 200));
};
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result?.result?.value;
};
const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, ...extra });
const wheel = (x, y, deltaY) => send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(OUT + name, Buffer.from(r.result.data, 'base64'));
  console.log('shot', name);
};
const dbg = async () => JSON.parse(await evalJs('JSON.stringify(window.__boardDebug ? window.__boardDebug() : null)'));
const click = async (x, y) => {
  await mouse('mouseMoved', x, y);
  await sleep(150);
  await mouse('mousePressed', x, y, { button: 'left', buttons: 1, clickCount: 1 });
  await sleep(80);
  await mouse('mouseReleased', x, y, { button: 'left', buttons: 0, clickCount: 1 });
  await sleep(420);
};
// 面板打开且居中时：面板左上角屏幕坐标 + 缩放（面板高 = 0.74 * 960 = 710px）
const PANEL_LEFT = 452;
const PANEL_TOP = 125;
const PX = 710 / 1000;
const toScreen = (px, py) => [PANEL_LEFT + px * PX, PANEL_TOP + py * PX];

await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 960, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: URL });
await sleep(4500);
await evalJs(`document.querySelector('[data-rail="settings"]').click()`);
await sleep(1600);
const s0 = await dbg();
console.log('opened openAmount=', s0.openAmount, 'offset=', s0.offsetX, s0.offsetY, 'state=', JSON.stringify(s0.state));
await shot('verify-1-open.png');

// ---- 控件：点开关（启动动画）----
const toggleRow = s0.rows.find((r) => r.kind === 'toggle');
const togglePt = toScreen(toggleRow.rect.x + toggleRow.rect.w / 2, 190 + toggleRow.rect.y + toggleRow.rect.h / 2 - s0.scroll);
await click(togglePt[0], togglePt[1]);
const s2 = await dbg();
console.log('after toggle splash=', s2.state.general.splash);

// ---- 控件：点分段（3D 歌词字号 → 大）----
const segRow = s0.rows.filter((r) => r.kind === 'segment')[0];
const segPt = toScreen(segRow.rect.x + segRow.rect.w - segRow.rect.w * 0.15, 190 + segRow.rect.y + segRow.rect.h / 2 - s0.scroll);
await click(segPt[0], segPt[1]);
const s3 = await dbg();
console.log('after segment lyricsSize=', s3.state.appearance.lyricsSize);
await shot('verify-3-controls.png');

// ---- ① 面板内滚轮：内容滚动（鼠标在面板左半区，避开控件）----
await wheel(700, 450, 360);
await sleep(800);
const s1 = await dbg();
console.log('after inside-wheel scroll=', s1.scroll.toFixed(1), 'target=', s1.scrollTarget.toFixed(1), 'offset=', s1.offsetX, s1.offsetY);
await shot('verify-2-scrolled.png');

// ---- 板外滚轮：不滚面板（滚场景）----
const beforeOut = await dbg();
await wheel(240, 760, 400);
await sleep(900);
const afterOut = await dbg();
console.log('outside wheel scroll before/after=', beforeOut.scroll.toFixed(1), afterOut.scroll.toFixed(1));
await shot('verify-7-outside-wheel.png');

// ---- 点面板以外收面板 ----
await click(200, 620);
await sleep(700);
const s8 = await dbg();
const shellClass = await evalJs(`document.querySelector('.space-shell')?.className ?? ''`);
console.log('after outside click openAmount=', s8.openAmount, 'isBoardOpen=', String(shellClass).includes('is-board-open'));
await shot('verify-8-closed.png');

// ---- 重新打开，拖滑条 ----
await evalJs(`document.querySelector('[data-rail="settings"]').click()`);
await sleep(1400);
const r0 = await dbg();
await wheel(700, 450, 2000);
await sleep(900);
const rb = await dbg();
const sliderRow = rb.rows.find((r) => r.kind === 'slider');
const sliderCy = 190 + sliderRow.rect.y + sliderRow.rect.h / 2 - rb.scroll;
const knobFrom = toScreen(sliderRow.rect.x + sliderRow.rect.w * rb.state.playback.volume, sliderCy);
const knobTo = toScreen(sliderRow.rect.x + sliderRow.rect.w * 0.15, sliderCy);
await mouse('mouseMoved', knobFrom[0], knobFrom[1]); await sleep(120);
await mouse('mousePressed', knobFrom[0], knobFrom[1], { button: 'left', buttons: 1, clickCount: 1 });
for (let i = 1; i <= 6; i += 1) {
  await mouse('mouseMoved', knobFrom[0] + ((knobTo[0] - knobFrom[0]) * i) / 6, knobFrom[1], { button: 'left', buttons: 1 });
  await sleep(30);
}
await mouse('mouseReleased', knobTo[0], knobTo[1], { button: 'left', buttons: 0, clickCount: 1 });
await sleep(500);
const sSlider = await dbg();
console.log('after slider drag volume=', sSlider.state.playback.volume, 'scroll=', sSlider.scroll.toFixed(1));
await shot('verify-5-slider.png');

// ---- ② 拖动面板：右上、左下各拖一次，验证可拖到屏幕大部分区域 ----
await mouse('mousePressed', 800, 190, { button: 'left', buttons: 1, clickCount: 1 });
for (let i = 1; i <= 8; i += 1) { await mouse('mouseMoved', 800 - i * 60, 190 - i * 20, { button: 'left', buttons: 1 }); await sleep(25); }
await mouse('mouseReleased', 320, 30, { button: 'left', buttons: 0, clickCount: 1 });
await sleep(700);
const d1 = await dbg();
console.log('after drag up-left offset=', d1.offsetX.toFixed(3), d1.offsetY.toFixed(3));
await shot('verify-6a-drag-upleft.png');

// 重新打开后测右下拖动 clamp
await click(200, 620);
await sleep(800);
await evalJs(`document.querySelector('[data-rail="settings"]').click()`);
await sleep(1400);
await mouse('mousePressed', 800, 190, { button: 'left', buttons: 1, clickCount: 1 });
for (let i = 1; i <= 10; i += 1) { await mouse('mouseMoved', 800 + i * 80, 190 + i * 20, { button: 'left', buttons: 1 }); await sleep(25); }
await mouse('mouseReleased', 1590, 390, { button: 'left', buttons: 0, clickCount: 1 });
await sleep(700);
const d2 = await dbg();
console.log('after drag down-right offset=', d2.offsetX.toFixed(3), d2.offsetY.toFixed(3), 'open=', d2.openAmount);
await shot('verify-6b-drag-downright.png');

console.log('logs:', JSON.stringify(logs));
ws.close();
