const PORT = 9223;
const fs = await import('node:fs');

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
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
  await send('Page.enable');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return res?.result?.value;
  };
  const click = async (x, y, count = 1) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: count });
    await sleep(40);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: count });
  };
  const shot = async (name) => {
    const data = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`E:\\Zilux2开发\\research\\shots\\${name}.png`, Buffer.from(data.data, 'base64'));
  };

  await sleep(8000);
  await click(430, 330, 1);
  await sleep(120);
  await click(430, 330, 2);
  await sleep(2600);
  const openNow = await evaluate('window.__lyricDebug?.()?.open ?? false');
  if (!openNow) {
    const lyricRect = await evaluate('(() => { const el = document.querySelector("[data-lyrics-btn]"); if (!el || el.hidden) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()');
    if (lyricRect) {
      await click(Math.round(lyricRect.x), Math.round(lyricRect.y));
      await sleep(2200);
    }
  }
  const before = await evaluate('window.__lyricDebug?.()');
  console.log('before:', JSON.stringify(before));
  await shot('lyric-visual-before');

  const nextRect = await evaluate('(() => { const el = document.querySelector("[data-island-next]"); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()');
  if (nextRect) await click(Math.round(nextRect.x), Math.round(nextRect.y));
  await sleep(500);
  console.log('after0.5s:', JSON.stringify(await evaluate('window.__lyricDebug?.()')));
  await shot('lyric-visual-after-05');
  await sleep(3000);
  console.log('after3.5s:', JSON.stringify(await evaluate('window.__lyricDebug?.()')));
  await shot('lyric-visual-after-35');
  await sleep(4000);
  console.log('after7.5s:', JSON.stringify(await evaluate('window.__lyricDebug?.()')));
  await shot('lyric-visual-after-75');
  ws.close();
}
main().catch((err) => { console.error('ERR', err); process.exit(1); });
