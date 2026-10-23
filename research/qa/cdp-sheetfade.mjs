const CDP_PORT = 9333;
const URL = process.argv[2] ?? 'http://127.0.0.1:4174/index.html?snap=1&mock=1';
const fs = await import('node:fs');

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
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
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 960, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL });
  await new Promise((resolve) => setTimeout(resolve, 8000));
  await send('Runtime.evaluate', { expression: `document.querySelector('[data-rail="settings"]').click()` });
  await new Promise((resolve) => setTimeout(resolve, 130));
  const shotA = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('E:\\Zilux2开发\\research\\shots\\sheet-fade-130ms.png', Buffer.from(shotA.data, 'base64'));
  await new Promise((resolve) => setTimeout(resolve, 700));
  const shotB = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('E:\\Zilux2开发\\research\\shots\\sheet-fade-830ms.png', Buffer.from(shotB.data, 'base64'));
  console.log('fade shots written');
  ws.close();
}
main().catch((err) => { console.error('ERR', err); process.exit(1); });
