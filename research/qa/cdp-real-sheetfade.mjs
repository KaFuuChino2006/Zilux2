const CDP_PORT = Number(process.argv[2] ?? 9223);
async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
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
  const res = await send('Runtime.evaluate', {
    expression: `(async () => {
      const info = {
        url: location.href,
        cls: document.documentElement.className,
        reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
        reduceClass: document.documentElement.classList.contains('reduce-motion'),
        snapClass: document.documentElement.classList.contains('snap'),
      };
      const sheet = document.querySelector('.settings-sheet');
      const backdrop = document.querySelector('.settings-sheet-backdrop');
      const card = document.querySelector('.settings-sheet-card');
      if (!sheet) return { ...info, error: 'no settings-sheet' };
      document.querySelector('[data-rail="settings"]').click();
      const samples = [];
      const t0 = performance.now();
      for (let i = 0; i < 8; i += 1) {
        await new Promise(r => setTimeout(r, 55));
        samples.push({
          t: Math.round(performance.now() - t0),
          sheet: getComputedStyle(sheet).opacity,
          backdrop: getComputedStyle(backdrop).opacity,
          card: getComputedStyle(card).opacity,
        });
      }
      return { ...info, samples };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  console.log(JSON.stringify(res?.result?.value, null, 1));
  ws.close();
}
main().catch((err) => { console.error('ERR', err); process.exit(1); });
