const PORT = 9333;
const URL = process.argv[2];
const PREFIX = process.argv[3] ?? 'E:/Zilux2开发/research/shots/burst';
const COUNT = Number(process.argv[4] ?? 16);
const INTERVAL = Number(process.argv[5] ?? 120);
const fs = await import('node:fs');

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve) => {
    const msgId = ++id;
    pending.set(msgId, resolve);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
  });
  await new Promise((resolve) => ws.addEventListener('open', resolve));
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 960, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL });
  await new Promise((resolve) => setTimeout(resolve, 4550));
  for (let i = 0; i < COUNT; i += 1) {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`${PREFIX}-${String(i).padStart(2, '0')}.png`, Buffer.from(shot.data, 'base64'));
    await new Promise((resolve) => setTimeout(resolve, INTERVAL));
  }
  console.log('done', COUNT);
  ws.close();
}
main().catch((err) => { console.error('ERR', err); process.exit(1); });
