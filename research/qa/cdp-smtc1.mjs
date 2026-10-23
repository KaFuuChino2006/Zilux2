const CDP_PORT = Number(process.argv[2] ?? 9223);
const fs = await import('node:fs');

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
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
  const evalv = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true }))?.result?.value;

  console.log('page:', await evalv('location.href'));
  // 双击磁贴播放
  const rect = await evalv(`(() => { const r = document.querySelector('canvas')?.getBoundingClientRect(); return r ? { w: r.width, h: r.height } : null; })()`);
  const cx = 0.44 * (rect?.w ?? 1600);
  const cy = 0.34 * (rect?.h ?? 960);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: cx, y: cy, button: 'left', clickCount: 2 });
    await new Promise((resolve) => setTimeout(resolve, 90));
  }
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const state = async () => await evalv(`(() => ({
    play: document.querySelector('[data-island-playpause]')?.getAttribute('aria-label') ?? '',
    title: document.querySelector('[data-island-title]')?.textContent ?? '',
    clock: document.querySelector('[data-island-clock]')?.textContent ?? '',
    status: document.querySelector('[data-space-status]')?.textContent ?? '',
  }))()`);
  console.log('after play:', JSON.stringify(await state()));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  console.log('after 1.5s:', JSON.stringify(await state()));
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('E:\\Zilux2开发\\research\\shots\\smtc-play.png', Buffer.from(shot.data, 'base64'));
  console.log('shot saved');
  ws.close();
}
main().catch((err) => { console.error('ERR', err); process.exit(1); });
