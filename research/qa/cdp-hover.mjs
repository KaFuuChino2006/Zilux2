const CDP_PORT = 9333;
const URL = process.argv[2] ?? 'http://127.0.0.1:4174/index.html?snap=1&mock=1';
const OUT = process.argv[3] ?? 'E:\\Zilux2开发\\research\\shots\\discover-open.png';
const HOVER_X = Number(process.argv[4] ?? 877);
const HOVER_Y = Number(process.argv[5] ?? 42);
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
    if (msg.method === 'Runtime.exceptionThrown') errors.push('EXC ' + JSON.stringify(msg.params.exceptionDetails).slice(0, 400));
    if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
      errors.push(msg.params.type + ' ' + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 400));
    }
  });
  await new Promise((resolve) => ws.addEventListener('open', resolve));
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 960, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL });
  await new Promise((resolve) => setTimeout(resolve, 8000));
  // 悬停到「发现」胶囊上，触发横向展开
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: HOVER_X, y: HOVER_Y });
  await new Promise((resolve) => setTimeout(resolve, 900));
  const rect = await send('Runtime.evaluate', {
    expression: `(() => { const d = document.querySelector('[data-discover]'); if (!d) return null; const r = d.getBoundingClientRect(); return {w: Math.round(r.width), h: Math.round(r.height), open: d.classList.contains('is-open')}; })()`,
    returnByValue: true,
  });
  console.log('discover:', JSON.stringify(rect?.result?.value));
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('shot:', OUT);
  console.log('errors:', errors.length ? errors.slice(0, 6) : 'none');
  ws.close();
}
main().catch((err) => { console.error('ERR', err); process.exit(1); });
