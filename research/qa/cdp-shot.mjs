const CDP_PORT = 9333;
const URL = 'http://127.0.0.1:4174/index.html?snap=1&mock=1&panel=liked';
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
  const events = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); return; }
    if (msg.method === 'Runtime.exceptionThrown') events.push('EXCEPTION: ' + JSON.stringify(msg.params.exceptionDetails).slice(0, 500));
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') events.push('CONSOLE: ' + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300));
  });
  await new Promise((resolve) => ws.addEventListener('open', resolve));
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 960, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL });
  await new Promise((resolve) => setTimeout(resolve, 9000));
  const expr = `(() => {
    const canvas = document.querySelector('.space-canvas');
    const gl = canvas?.getContext('webgl2') ?? canvas?.getContext('webgl');
    return JSON.stringify({
      canvasSize: canvas ? [canvas.width, canvas.height, canvas.clientWidth, canvas.clientHeight] : null,
      contextLost: gl ? gl.isContextLost() : 'no-gl',
      canvasZ: canvas ? getComputedStyle(canvas).zIndex : null,
      canvasOpacity: canvas ? getComputedStyle(canvas).opacity : null,
      shellBg: getComputedStyle(document.querySelector('.space-shell')).backgroundColor,
      loginCardCount: document.querySelectorAll('.space-card').length,
      status: document.querySelector('[data-space-status]')?.textContent ?? '',
      revealed: document.querySelector('.space-shell')?.classList.contains('is-revealed'),
      entered: document.querySelector('.space-shell')?.classList.contains('is-entered')
    });
  })()`;
  const state = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  console.log('STATE:', state?.result?.value);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('E:\\Zilux2开发\\research\\shots\\cdp-liked.png', Buffer.from(shot.data, 'base64'));
  console.log('screenshot saved');
  for (const e of events.slice(0, 10)) console.log(' -', e);
  ws.close();
}
main().catch((err) => { console.error('ERR', err); process.exit(1); });
