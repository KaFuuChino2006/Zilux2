const CDP_PORT = 9333;
const URL = 'http://127.0.0.1:4174/index.html?snap=1&mock=1';
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
  await send('Runtime.evaluate', {
    expression: `localStorage.setItem('zilux2.space.custom', JSON.stringify({ image: null, tileCols: 13, tileRows: 7, tileBend: 0.35 }))`,
  });
  await send('Page.navigate', { url: URL });
  await new Promise((resolve) => setTimeout(resolve, 4500));
  await send('Runtime.evaluate', { expression: `document.querySelector('[data-enter]')?.click()` });
  await new Promise((resolve) => setTimeout(resolve, 9000));
  const clickAt = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await new Promise((r) => setTimeout(r, 70));
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const status = async () => (await send('Runtime.evaluate', { expression: `document.querySelector('[data-space-status]')?.textContent ?? ''`, returnByValue: true }))?.result?.value;
  console.log('before:', await status());
  await clickAt(700, 330);
  await new Promise((resolve) => setTimeout(resolve, 2600));
  console.log('after1:', await status());
  let shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('E:\\Zilux2开发\\research\\shots\\focus-click-a.png', Buffer.from(shot.data, 'base64'));
  // 再点另一块（左侧一列），观察相机是否飘到别处
  await clickAt(300, 330);
  await new Promise((resolve) => setTimeout(resolve, 2600));
  console.log('after2:', await status());
  shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('E:\\Zilux2开发\\research\\shots\\focus-click-b.png', Buffer.from(shot.data, 'base64'));
  ws.close();
}
main().catch((err) => { console.error('ERR', err); process.exit(1); });
