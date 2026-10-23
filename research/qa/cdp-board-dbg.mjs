// Probe: open settings board on the (pre-enter) login stage to compare orientation.
import fs from 'node:fs';
import path from 'node:path';

const HOST = '127.0.0.1';
const PORT = 9333;
const SHOTS = 'E:/Zilux2开发/research/shots';

const list = await (await fetch(`http://${HOST}:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
if (!page) throw new Error('no page target');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
const logs = [];
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    logs.push('EXCEPTION: ' + JSON.stringify(msg.params.exceptionDetails).slice(0, 400));
  } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    logs.push('CONSOLE: ' + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300));
  }
});
await new Promise((res) => ws.addEventListener('open', res));
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.result.data, 'base64'));
  console.log('shot', name);
};
const mouse = (type, x, y, extra = {}) =>
  send('Input.dispatchMouseEvent', { type, x, y, button: 'none', ...extra });

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 960, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'http://127.0.0.1:4174/index.html?snap=1&mock=1' });
await wait(4200);
console.log('class:', await evalJs('document.querySelector(".space-shell")?.className'));
await shot('probe-dbg-0.png');
await evalJs('document.querySelector(\'[data-rail="settings"]\').click()');
await wait(1500);
console.log('class after open:', await evalJs('document.querySelector(".space-shell")?.className'));
await shot('probe-dbg-1-open.png');
await mouse('mouseMoved', 834, 640);
await wait(200);
await shot('probe-dbg-2-hover.png');
const dbg = await evalJs('window.__boardDebug ? window.__boardDebug() : null'); console.log('DBG:', JSON.stringify(dbg).slice(0,4000)); console.log('logs:', JSON.stringify(logs));
ws.close();
