const CDP_PORT = 9333;
const fs = await import('node:fs');
const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve) => {
  const i = ++id;
  pending.set(i, resolve);
  ws.send(JSON.stringify({ id: i, method, params }));
});
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
});
await new Promise((resolve) => ws.addEventListener('open', resolve));
await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 960, deviceScaleFactor: 1, mobile: false });

for (const tile of [0, 12, 45, 90]) {
  await send('Page.navigate', { url: `http://127.0.0.1:4174/index.html?snap=1&mock=1&panel=liked&tile=${tile}&cb=` + Date.now() });
  await new Promise((r) => setTimeout(r, 9000));
  const status = await send('Runtime.evaluate', { expression: `document.querySelector('[data-space-status]')?.textContent ?? ''`, returnByValue: true });
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`E:/Zilux2开发/research/shots/focus-tile-${tile}.png`, Buffer.from(shot.data, 'base64'));
  console.log(tile, '→', status?.result?.value);
}
ws.close();
