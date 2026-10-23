const CDP_PORT = 9333;
const fs = await import('node:fs');
const OUT_ERRORS = 'E:/Zilux2开发/research/shots/dof-errors.txt';
const OUT_SHOT = 'E:/Zilux2开发/research/shots/dof-qa.png';
const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const logs = [];
const send = (method, params = {}) => new Promise((resolve) => {
  const i = ++id;
  pending.set(i, resolve);
  ws.send(JSON.stringify({ id: i, method, params }));
});
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
  if (msg.method === 'Runtime.consoleAPICalled') logs.push(msg.params.type + ': ' + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  if (msg.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + JSON.stringify(msg.params.exceptionDetails));
});
await new Promise((resolve) => ws.addEventListener('open', resolve));
await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 960, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'http://127.0.0.1:4174/index.html?snap=1&mock=1&lyricstest=1&cb=' + Date.now() });
await new Promise((resolve) => setTimeout(resolve, 9000));
fs.writeFileSync(OUT_ERRORS, logs.join('\n\n---\n\n'));
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(OUT_SHOT, Buffer.from(shot.data, 'base64'));
console.log('logs:', logs.length);
ws.close();
