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
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }))?.result?.value;

const grid = process.argv[2] ?? '13x7';
const tiles = (process.argv[3] ?? '0,12,45,90').split(',').map(Number);
const [cols, rows] = grid.split('x').map(Number);
await send('Page.navigate', { url: 'http://127.0.0.1:4174/index.html?snap=1&cb=' + Date.now() });
await new Promise((r) => setTimeout(r, 2500));
await evaluate(`(() => { localStorage.setItem('zilux2.space.custom', JSON.stringify({ image: null, tileCols: ${cols}, tileRows: ${rows}, tileBend: 0.35 })); return true; })()`);
const out = [];
for (const tile of tiles) {
  await send('Page.navigate', { url: `http://127.0.0.1:4174/index.html?snap=1&mock=1&panel=liked&tile=${tile}&cb=` + Date.now() });
  await new Promise((r) => setTimeout(r, 9500));
  const info = await evaluate(`window.__ziluxFocus ? window.__ziluxFocus() : 'no-hook'`);
  out.push({ grid, tile, info });
  console.log(grid, 'tile', tile, JSON.stringify(info));
}
fs.writeFileSync('E:/Zilux2开发/research/shots/focus-metrics.json', JSON.stringify(out, null, 2));
ws.close();
