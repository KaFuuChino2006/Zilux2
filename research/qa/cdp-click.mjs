const CDP_PORT = 9333;
const URL = process.argv[2];
const OUT = process.argv[3];
const X = Number(process.argv[4] ?? 1430);
const Y = Number(process.argv[5] ?? 746);
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
  });
  await new Promise((resolve) => ws.addEventListener('open', resolve));
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 960, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL });
  await new Promise((resolve) => setTimeout(resolve, 7000));
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: X, y: Y, button: 'left', clickCount: 1 });
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  await new Promise((resolve) => setTimeout(resolve, 700));
  const state = await send('Runtime.evaluate', {
    expression: `(() => { const b = document.querySelector('[data-lyrics-anim-body]'); const t = document.querySelector('[data-lyrics-anim-toggle]'); return { hidden: b?.hidden, label: t?.textContent, expanded: t?.getAttribute('aria-expanded') }; })()`,
    returnByValue: true,
  });
  console.log('state:', JSON.stringify(state?.result?.value));
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('shot:', OUT, 'errors:', errors.length ? errors : 'none');
  ws.close();
}
main().catch((err) => { console.error('ERR', err); process.exit(1); });
