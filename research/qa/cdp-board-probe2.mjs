// 探针：面板打开后点空白处是否关闭 + 元素命中
const CDP = 'http://127.0.0.1:9333';
const URL = 'http://127.0.0.1:4174/index.html?enter=1&instant=1&snap=1&mock=1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`${CDP}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evalJs = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r.result?.result?.value; };
const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, ...extra });
const dbg = async () => JSON.parse(await evalJs('JSON.stringify(window.__boardDebug ? window.__boardDebug() : null)'));
await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 960, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: URL });
await sleep(4500);
await evalJs(`document.querySelector('[data-rail="settings"]').click()`);
await sleep(1500);
console.log('opened open=', (await dbg()).openAmount);
console.log('elementFromPoint(200,620)=', await evalJs(`(()=>{const el=document.elementFromPoint(200,620);return el?el.tagName+'.'+el.className:null})()`));
await mouse('mouseMoved', 200, 620); await sleep(150);
await mouse('mousePressed', 200, 620, { button: 'left', buttons: 1, clickCount: 1 }); await sleep(120);
console.log('after mousedown open=', (await dbg()).openAmount);
await mouse('mouseReleased', 200, 620, { button: 'left', buttons: 0, clickCount: 1 }); await sleep(900);
const s = await dbg();
const cls = await evalJs(`document.querySelector('.space-shell')?.className ?? ''`);
console.log('after click open=', s.openAmount, 'target=', s.openTarget, 'isBoardOpen=', String(cls).includes('is-board-open'));
// 合成事件兜底测试
await evalJs(`window.__boardDebug && document.querySelector('.space-canvas').dispatchEvent(new PointerEvent('pointerdown',{clientX:240,clientY:640,button:0,bubbles:true}))`);
await sleep(600);
console.log('after synthetic pointerdown open=', (await dbg()).openAmount);

// 重新打开 → 拖动面板 → 再点空白处
await evalJs(`document.querySelector('[data-rail="settings"]').click()`);
await sleep(1400);
await mouse('mousePressed', 800, 180, { button: 'left', buttons: 1, clickCount: 1 });
for (let i = 1; i <= 8; i += 1) { await mouse('mouseMoved', 800 + i * 25, 180 + i * 15, { button: 'left', buttons: 1 }); await sleep(30); }
await mouse('mouseReleased', 1000, 300, { button: 'left', buttons: 0, clickCount: 1 });
await sleep(600);
const d1 = await dbg();
console.log('after drag offset=', d1.offsetX.toFixed(2), d1.offsetY.toFixed(2), 'open=', d1.openAmount);
await mouse('mouseMoved', 200, 620); await sleep(150);
await mouse('mousePressed', 200, 620, { button: 'left', buttons: 1, clickCount: 1 });
await sleep(120);
console.log('after outside mousedown open=', (await dbg()).openAmount);
await mouse('mouseReleased', 200, 620, { button: 'left', buttons: 0, clickCount: 1 });
await sleep(900);
const d2 = await dbg();
console.log('after outside click open=', d2.openAmount, 'isBoardOpen=', String(await evalJs(`document.querySelector('.space-shell')?.className ?? ''`)).includes('is-board-open'));
ws.close();
