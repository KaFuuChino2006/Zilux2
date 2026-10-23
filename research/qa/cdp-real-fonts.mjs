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
  const result = await send('Runtime.evaluate', {
    expression: `(() => {
      const select = document.querySelector('[data-lyric-font]');
      const options = select ? [...select.options].map((o) => o.value).filter(Boolean) : [];
      return {
        optionsCount: options.length,
        sample: options.slice(0, 8),
        hasYahei: options.some((n) => /YaHei|雅黑/i.test(n)),
        hasSimSun: options.some((n) => /SimSun|宋体/i.test(n)),
        hasSegoe: options.some((n) => /Segoe/i.test(n)),
      };
    })()`,
    returnByValue: true,
  });
  console.log('fonts:', JSON.stringify(result?.result?.value));
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('E:\\Zilux2开发\\research\\shots\\font-options.png', Buffer.from(shot.data, 'base64'));
  console.log('shot saved');
  ws.close();
}
main().catch((err) => { console.error('ERR', err); process.exit(1); });
