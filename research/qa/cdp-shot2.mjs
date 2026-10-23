const CDP_PORT = 9333;
const URL = process.argv[2] ?? 'http://127.0.0.1:4174/index.html?snap=1&mock=1&lyricstest=1';
const OUT = process.argv[3] ?? 'E:\\Zilux2开发\\research\\shots\\dof-qa.png';
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
  await new Promise((resolve) => setTimeout(resolve, 9000));
  const status = await send('Runtime.evaluate', { expression: `document.querySelector('[data-space-status]')?.textContent ?? ''`, returnByValue: true });
  console.log('status:', status?.result?.value);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('shot:', OUT);
  console.log('errors:', errors.length ? errors.slice(0, 8) : 'none');
  ws.close();
}
main().catch((err) => { console.error('ERR', err); process.exit(1); });
