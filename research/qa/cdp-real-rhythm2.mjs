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

  // 打开节奏模式并重载（用 localStorage 持久化）
  await evalv(`(() => { const raw = localStorage.getItem('zilux2.space.custom'); const o = raw ? JSON.parse(raw) : {}; o.bgColor = 'rhythm'; o.lyricColor = 'rhythm'; localStorage.setItem('zilux2.space.custom', JSON.stringify(o)); return 1; })()`);
  await send('Page.reload', {});
  await new Promise((resolve) => setTimeout(resolve, 9000));
  console.log('debug0:', JSON.stringify(await evalv('window.__colorDebug?.()')));

  // 双击磁贴播放：模拟真实播放
  const rect = await evalv(`(() => { const r = document.querySelector('canvas')?.getBoundingClientRect(); return r ? { x: r.width, y: r.height } : null; })()`);
  console.log('canvas:', JSON.stringify(rect));
  const cx = 0.44 * (rect?.x ?? 1600);
  const cy = 0.34 * (rect?.y ?? 960);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: cx, y: cy, button: 'left', clickCount: 1 });
    await new Promise((resolve) => setTimeout(resolve, 90));
  }
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: cx, y: cy, button: 'left', clickCount: 2 });
    await new Promise((resolve) => setTimeout(resolve, 90));
  }
  await new Promise((resolve) => setTimeout(resolve, 2500));

  for (let i = 0; i < 6; i += 1) {
    const d = await evalv('window.__colorDebug?.()');
    console.log(`sample${i}:`, JSON.stringify({ playing: d?.playing, bgColor: d?.bgColor, level: d?.level, lockLeft: d?.lockLeft, front: (d?.frontBg ?? '').slice(0, 80) }));
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`E:\\Zilux2开发\\research\\shots\\real-rhythm-s${i}.png`, Buffer.from(shot.data, 'base64'));
    await new Promise((resolve) => setTimeout(resolve, 900));
  }
  ws.close();
}
main().catch((err) => { console.error('ERR', err); process.exit(1); });
