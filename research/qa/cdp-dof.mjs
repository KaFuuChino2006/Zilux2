const CDP_PORT = 9333;
const URL = 'http://127.0.0.1:4174/index.html?snap=1&mock=1&play=1';
const fs = await import('node:fs');

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const errors = [];
  const send = (method, params = {}) => new Promise((resolve) => {
    const msgId = ++id;
    pending.set(msgId, resolve);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
    if (msg.method === 'Runtime.exceptionThrown') errors.push('EXC ' + JSON.stringify(msg.params.exceptionDetails).slice(0, 300));
    if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
      errors.push(msg.params.type + ' ' + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300));
    }
  });
  await new Promise((resolve) => ws.addEventListener('open', resolve));
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 960, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL });
  await new Promise((resolve) => setTimeout(resolve, 4500));
  await send('Runtime.evaluate', { expression: `document.querySelector('[data-enter]')?.click()` });
  await new Promise((resolve) => setTimeout(resolve, 7000));
  // 双击一块磁贴 → 播放
  const clickAt = async (x, y, count = 1) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: count });
    await new Promise((r) => setTimeout(r, 60));
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: count });
  };
  await clickAt(700, 330);
  await new Promise((resolve) => setTimeout(resolve, 900));
  await clickAt(700, 330);
  await new Promise((resolve) => setTimeout(resolve, 1800));
  const btn = await send('Runtime.evaluate', { expression: `!!document.querySelector('[data-lyrics-btn]') && !document.querySelector('[data-lyrics-btn]').hidden`, returnByValue: true });
  console.log('lyrics button visible:', btn?.result?.value);
  await send('Runtime.evaluate', { expression: `document.querySelector('[data-lyrics-btn]')?.click()` });
  await new Promise((resolve) => setTimeout(resolve, 2600));
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('E:\\Zilux2开发\\research\\shots\\dof-lyrics.png', Buffer.from(shot.data, 'base64'));
  const status = await send('Runtime.evaluate', { expression: `document.querySelector('[data-space-status]')?.textContent ?? ''`, returnByValue: true });
  console.log('status:', status?.result?.value);
  console.log('errors:', errors.length ? errors.slice(0, 6) : 'none');
  ws.close();
}
main().catch((err) => { console.error('ERR', err); process.exit(1); });
