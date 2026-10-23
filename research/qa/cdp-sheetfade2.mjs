const CDP_PORT = 9333;
const URL = process.argv[2] ?? 'http://127.0.0.1:4174/index.html?snap=1&mock=1';
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
  await send('Emulation.setEmulatedMedia', { media: 'screen', features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await send('Page.navigate', { url: URL });
  await new Promise((resolve) => setTimeout(resolve, 8000));
  const res = await send('Runtime.evaluate', {
    expression: `(async () => {
      const sheet = document.querySelector('.settings-sheet');
      const backdrop = document.querySelector('.settings-sheet-backdrop');
      const card = document.querySelector('.settings-sheet-card');
      document.querySelector('[data-rail="settings"]').click();
      const samples = [];
      const t0 = performance.now();
      for (let i = 0; i < 8; i += 1) {
        await new Promise(r => setTimeout(r, 55));
        samples.push({
          t: Math.round(performance.now() - t0),
          rm: matchMedia('(prefers-reduced-motion: reduce)').matches,
          cls: document.documentElement.className,
          sheet: getComputedStyle(sheet).opacity,
          backdrop: getComputedStyle(backdrop).opacity,
          card: getComputedStyle(card).opacity,
          bf: getComputedStyle(backdrop).backdropFilter || getComputedStyle(backdrop).webkitBackdropFilter,
        });
      }
      return samples;
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  console.log(JSON.stringify(res?.result?.value, null, 1));
  ws.close();
}
main().catch((err) => { console.error('ERR', err); process.exit(1); });
