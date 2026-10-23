const CDP_PORT = Number(process.argv[2] ?? 9333);
const URL = process.argv[3];
const fs = await import('node:fs');

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
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
  await new Promise((resolve) => setTimeout(resolve, 9000));
  await send('Runtime.evaluate', { expression: 'window.__flashTest?.()' });
  for (let i = 0; i < 6; i += 1) {
    const value = (await send('Runtime.evaluate', {
      expression: `Number(getComputedStyle(document.querySelector('[data-space-flash]')).opacity)`,
      returnByValue: true,
    }))?.result?.value;
    console.log(`flash@${i}: ${value}`);
    if (i === 1) {
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync('E:\\Zilux2开发\\research\\shots\\flash-frame.png', Buffer.from(shot.data, 'base64'));
    }
    await new Promise((resolve) => setTimeout(resolve, 170));
  }
  ws.close();
}
main().catch((err) => { console.error('ERR', err); process.exit(1); });
