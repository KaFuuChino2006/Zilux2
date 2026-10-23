const PORT = 9223;

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
  await send('Input.setIgnoreInputEvents', { ignore: false });
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

  if (process.argv[2] === 'pv' || process.argv[2] === '3d') {
    await evaluate("(() => { const raw = JSON.parse(localStorage.getItem('zilux2.space.custom') || '{}'); raw.lyricMode = process.argv[2] === 'pv' ? 'pv' : '3d'; localStorage.setItem('zilux2.space.custom', JSON.stringify(raw)); return true; })()");
    await send('Page.reload');
  }
  await sleep(9000);
  console.log('state0:', JSON.stringify(await evaluate('({ hasDebug: typeof window.__lyricDebug, tiles: document.querySelectorAll("canvas").length, title: document.querySelector("[data-island-title]")?.textContent ?? "" })')));

  // 双击磁贴墙里的第一张封面（打开岛播放器）
  await click(430, 330, 1);
  await sleep(120);
  await click(430, 330, 2);
  await sleep(2500);
  console.log('afterPlay:', JSON.stringify(await evaluate('window.__lyricDebug?.()')));

  // 确保歌词打开（如果已打开则不再点击，避免点成关闭）
  const lyricRect = await evaluate('(() => { const el = document.querySelector("[data-lyrics-btn]"); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, hidden: el.hidden }; })()');
  const openNow = await evaluate('window.__lyricDebug?.()?.open ?? false');
  console.log('lyricBtn:', JSON.stringify(lyricRect), 'openNow:', openNow);
  if (lyricRect && !lyricRect.hidden && !openNow) {
    await click(Math.round(lyricRect.x), Math.round(lyricRect.y));
    await sleep(1500);
  }
  console.log('lyricsOpen:', JSON.stringify(await evaluate('window.__lyricDebug?.()')));

  // 点下一首
  const nextRect = await evaluate('(() => { const el = document.querySelector("[data-island-next]"); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()');
  console.log('nextBtn:', JSON.stringify(nextRect));
  if (nextRect) {
    await click(Math.round(nextRect.x), Math.round(nextRect.y));
  }

  for (let i = 0; i < 26; i += 1) {
    await sleep(500);
    const state = await evaluate('window.__lyricDebug?.()');
    console.log(`t=${(i * 0.5 + 0.5).toFixed(1)}s`, JSON.stringify(state));
  }
  ws.close();
}
main().catch((err) => { console.error('ERR', err); process.exit(1); });
