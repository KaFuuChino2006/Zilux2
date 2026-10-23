const CDP_PORT = 9223;
const fs = await import('node:fs');
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
  // 关闭可能已打开的面板
  await send('Runtime.evaluate', { expression: `document.querySelector('[data-settings-close]')?.click()` });
  await new Promise((r) => setTimeout(r, 500));
  // 重新打开，抓早期与完成两帧
  await send('Runtime.evaluate', { expression: `document.querySelector('[data-rail="settings"]').click()` });
  await new Promise((r) => setTimeout(r, 70));
  const a = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('E:/Zilux2开发/research/shots/realfade-70ms.png', Buffer.from(a.data, 'base64'));
  await new Promise((r) => setTimeout(r, 500));
  const b = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('E:/Zilux2开发/research/shots/realfade-570ms.png', Buffer.from(b.data, 'base64'));
  console.log('real fade shots written');
  ws.close();
}
main().catch((err) => { console.error('ERR', err); process.exit(1); });
