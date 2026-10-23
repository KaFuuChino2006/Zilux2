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
  const logs = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); return; }
    if (msg.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION ' + JSON.stringify(msg.params.exceptionDetails).slice(0, 300));
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') logs.push('CONSOLE ' + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300));
  });
  await new Promise((resolve) => ws.addEventListener('open', resolve));
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 960, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL });
  await new Promise((resolve) => setTimeout(resolve, 4500));
  await send('Runtime.evaluate', { expression: `document.querySelector('[data-enter]')?.click()` });
  await new Promise((resolve) => setTimeout(resolve, 9000));
  const dbg = await send('Runtime.evaluate', { expression: 'JSON.stringify(window.__ziluxDebug ? window.__ziluxDebug() : null)', returnByValue: true });
  console.log('DEBUG:', dbg?.result?.value);
  const state = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      entered: document.querySelector('.space-shell')?.classList.contains('is-entered') ?? false,
      status: document.querySelector('[data-space-status]')?.textContent ?? '',
      tileHint: document.querySelector('[data-space-status]')?.textContent?.includes('首') ?? false
    })`,
    returnByValue: true,
  });
  console.log('STATE:', state?.result?.value);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('E:\\Zilux2开发\\research\\shots\\repro-enter-liked.png', Buffer.from(shot.data, 'base64'));
  for (const l of logs.slice(0, 8)) console.log(' -', l);
  ws.close();
}
main().catch((err) => { console.error('ERR', err); process.exit(1); });
