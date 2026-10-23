const CDP_PORT = 9223;

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
  const status = () => send('Runtime.evaluate', {
    expression: `({ status: document.querySelector('[data-space-status]')?.textContent ?? '', island: document.querySelector('.island-dock')?.hidden ?? null, title: document.querySelector('[data-island-title]')?.textContent ?? '', liked: document.querySelector('[data-island-like]')?.classList.contains('is-liked') ?? null })`,
    returnByValue: true,
  });

  for (const [x, y] of [[704, 326], [500, 320], [860, 300]]) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await new Promise((r) => setTimeout(r, 120));
    for (let i = 0; i < 2; i += 1) {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: i + 1 });
        await new Promise((r) => setTimeout(r, 60));
      }
      await new Promise((r) => setTimeout(r, 160));
    }
    await new Promise((r) => setTimeout(r, 1800));
    const st = await status();
    console.log(`at ${x},${y}:`, JSON.stringify(st?.result?.value));
    const islandHidden = st?.result?.value?.island;
    if (islandHidden === false) break;
  }
  // 若已播放，读取喜欢状态并截图
  await new Promise((r) => setTimeout(r, 2200));
  const st2 = await status();
  console.log('final:', JSON.stringify(st2?.result?.value));
  ws.close();
}
main().catch((err) => { console.error('ERR', err); process.exit(1); });
