const CDP_PORT = 9223;
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
    if (msg.method === 'Runtime.exceptionThrown') errors.push('EXC ' + JSON.stringify(msg.params.exceptionDetails).slice(0, 200));
  });
  await new Promise((resolve) => ws.addEventListener('open', resolve));
  await send('Runtime.enable');
  await send('Page.enable');

  // 双击磁贴播放（真实窗口坐标 1600x960 内的磁贴中心）
  for (let i = 0; i < 2; i += 1) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: 430, y: 170, button: 'left', clickCount: i + 1 });
      await new Promise((resolve) => setTimeout(resolve, 70));
    }
    await new Promise((resolve) => setTimeout(resolve, 110));
  }
  await new Promise((resolve) => setTimeout(resolve, 3500));

  const info = await send('Runtime.evaluate', {
    expression: `(() => {
      const island = document.querySelector('.island-dock');
      const like = document.querySelector('[data-island-like]');
      const title = document.querySelector('[data-island-title]')?.textContent ?? '';
      return { hidden: island?.hidden ?? null, title, liked: like?.classList.contains('is-liked') ?? null, pressed: like?.getAttribute('aria-pressed') ?? null };
    })()`,
    returnByValue: true,
  });
  console.log('state:', JSON.stringify(info?.result?.value));
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('E:\\Zilux2开发\\research\\shots\\liked-state2.png', Buffer.from(shot.data, 'base64'));
  console.log('errors:', errors.length ? errors : 'none');
  ws.close();
}
main().catch((err) => { console.error('ERR', err); process.exit(1); });
