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
  });
  await new Promise((resolve) => ws.addEventListener('open', resolve));
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 960, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL });
  await new Promise((resolve) => setTimeout(resolve, 6500));

  // 双击一块磁贴（中心附近）触发播放
  for (let i = 0; i < 2; i += 1) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: 500, y: 300, button: 'left', clickCount: i + 1 });
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    await new Promise((resolve) => setTimeout(resolve, 90));
  }
  await new Promise((resolve) => setTimeout(resolve, 2200));

  const info = await send('Runtime.evaluate', {
    expression: `(() => {
      const island = document.querySelector('[data-island]');
      const like = document.querySelector('[data-island-like]');
      const title = document.querySelector('[data-island-title]')?.textContent ?? '';
      return { islandHidden: island?.hidden ?? null, hasLike: !!like, title, likeVisible: !!like && like.offsetParent !== null };
    })()`,
    returnByValue: true,
  });
  console.log('island:', JSON.stringify(info?.result?.value));

  // 点击喜欢按钮，再读 toast
  await send('Runtime.evaluate', { expression: `document.querySelector('[data-island-like]')?.click()` });
  await new Promise((resolve) => setTimeout(resolve, 900));
  const toast = await send('Runtime.evaluate', {
    expression: `Array.from(document.querySelectorAll('.toast')).map((t) => t.textContent).join(' | ')`,
    returnByValue: true,
  });
  console.log('toast:', toast?.result?.value);
  console.log('errors:', errors.length ? errors : 'none');
  ws.close();
}
main().catch((err) => { console.error('ERR', err); process.exit(1); });
