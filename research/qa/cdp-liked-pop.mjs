const CDP_PORT = 9333;
const URL = process.argv[2];
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
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(8500);
  const evalJs = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return res?.result?.value;
  };
  const clickSel = async (selector) => {
    const pos = await evalJs(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    if (!pos) return false;
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y });
    await sleep(100);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
    await sleep(70);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
    return true;
  };
  const shot = async (path) => {
    const res = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path, Buffer.from(res.data, 'base64'));
  };

  console.log('rail liked exists:', await evalJs(`!!document.querySelector('[data-rail="liked"]')`));
  await clickSel('[data-rail="liked"]');
  await sleep(900);
  const pop = await evalJs(`(() => { const el = document.querySelector('[data-liked-pop]'); if (!el) return null; const r = el.getBoundingClientRect(); return { hidden: el.hidden, w: Math.round(r.width), h: Math.round(r.height), counts: Array.from(el.querySelectorAll('[data-liked-pop-count]')).map((n) => n.textContent) }; })()`);
  console.log('pop:', JSON.stringify(pop));
  await shot('E:\\Zilux2开发\\research\\shots\\liked-pop.png');
  await clickSel('[data-liked-source="qq"]');
  await sleep(3000);
  console.log('status:', await evalJs(`document.querySelector('[data-space-status]')?.textContent ?? ''`));
  console.log('pop hidden after:', await evalJs(`document.querySelector('[data-liked-pop]')?.hidden`));
  await shot('E:\\Zilux2开发\\research\\shots\\liked-pop-qq.png');
  console.log('errors:', errors.length ? errors.slice(0, 6) : 'none');
  ws.close();
}
main().catch((err) => { console.error('ERR', err); process.exit(1); });
