const CDP_PORT = Number(process.argv[2] ?? 9223);
const OUT = process.argv[3] ?? 'E:\\Zilux2开发\\research\\shots\\real-rhythm.png';
const fs = await import('node:fs');

async function targets() {
  return (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json());
}

async function main() {
  const list = await targets();
  const page = list.find((t) => t.type === 'page');
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

  // 打开「节奏」背景换色并重新加载页面
  await send('Runtime.evaluate', {
    expression: `(() => { try { const raw = localStorage.getItem('zilux2.space.custom'); const obj = raw ? JSON.parse(raw) : {}; obj.bgColor = 'rhythm'; obj.lyricColor = 'rhythm'; localStorage.setItem('zilux2.space.custom', JSON.stringify(obj)); return 'set'; } catch (e) { return 'err ' + e.message; } })()`,
    returnByValue: true,
  });
  await send('Page.reload', { ignoreCache: false });
  await new Promise((resolve) => setTimeout(resolve, 9000));

  const probe = await send('Runtime.evaluate', {
    expression: `(() => { const a = document.querySelector('[data-space-tint-a]'); const b = document.querySelector('[data-space-tint-b]'); const cs = (el) => el ? { op: getComputedStyle(el).opacity, bg: (getComputedStyle(el).backgroundImage || '').slice(0, 160), filter: getComputedStyle(el).filter } : null; return { a: cs(a), b: cs(b), status: document.querySelector('[data-space-status]')?.textContent ?? '', url: location.href }; })()`,
    returnByValue: true,
  });
  console.log('probe1:', JSON.stringify(probe?.result?.value));
  const shot1 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(OUT.replace('.png', '-1.png'), Buffer.from(shot1.data, 'base64'));
  await new Promise((resolve) => setTimeout(resolve, 2600));
  const probe2 = await send('Runtime.evaluate', {
    expression: `(() => { const a = document.querySelector('[data-space-tint-a]'); const b = document.querySelector('[data-space-tint-b]'); const cs = (el) => el ? { op: getComputedStyle(el).opacity, bg: (getComputedStyle(el).backgroundImage || '').slice(0, 160) } : null; return { a: cs(a), b: cs(b) }; })()`,
    returnByValue: true,
  });
  console.log('probe2:', JSON.stringify(probe2?.result?.value));
  const shot2 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(OUT.replace('.png', '-2.png'), Buffer.from(shot2.data, 'base64'));
  console.log('shots saved');
  ws.close();
}
main().catch((err) => { console.error('ERR', err); process.exit(1); });
